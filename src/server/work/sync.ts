// 同步证据的编排（PLAN V09-23；DESIGN.md §2.10；docs/sync-evidence-contract.md）。
//
// 这一层只做**编排**：折叠同步域事件 → 找证据包 → 调 syncChecks 求值 → 经唯一写口提交 →
// 组装只读返回体 / 接续阻断 / 写边界核实。解析在 syncContract.ts，逐项裁决在 syncChecks.ts。
//
// 硬口径（与 design-review findings A–F 对齐）：
//   · **at_registration 截点 = 登记事件 seq − 1**（服务确定）：历史断言不被未来合法推进阻塞；
//   · **同步指纹不含自己的 sync 事件序号/时间**：连续扫描/重启零重复效果；
//   · **坏领域事实 fail-closed**：不可读/损坏的同步事件当 invalid，不当 not_configured；
//   · **不引 sixGraphs**（只经注册探针）→ 不形成 sync→sixGraphs→entry→sync 环；collectProjectFacts 不读同步态；
//   · 直连写口伪造 `sync.evidence_checked` 在文件锁内按**当前实际目标**重算并逐项比对，假 passed 零字节。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { getProject } from "../registry";
import { projectWorkDir } from "../workstation";
import { nowIso } from "../time";
import { WorkError, type WorkCommand, type WorkEvent, type WorkReceipt } from "./types";
import { eventsPath, loadEvents } from "./eventStore";
import { putEvidence } from "./evidence";
import { readSyncDiscoveryIssues } from "./syncRuntimeHealth";
import {
  contractSourceProblems,
  stableStringify,
  supersedeProblems,
  syncContractSha256,
  validateSyncContract,
} from "./syncContract";
import {
  batchIdOfEvidenceFile,
  businessEventsFingerprint,
  evaluateBatch,
  SYNC_LOCK_REVIEW_MAX_BYTES,
  type BatchEvaluation,
  type EvalContext,
} from "./syncChecks";
import { syncGraphProbe, syncGraphSourceProbe, type SyncGraphProbe, type SyncGraphProbeResult } from "./syncProbe";
import {
  SYNC_BATCH_ID_RE,
  SYNC_EVIDENCE_FILE_SUFFIX,
  SYNC_INBOX_REL,
  SYNC_SCHEMA_VERSION,
  type SyncBatchReport,
  type SyncContract,
  type SyncStatusReport,
  type SyncVerdict,
} from "../../shared/syncEvidence";

export { SYNC_INBOX_REL, SYNC_EVIDENCE_FILE_SUFFIX, SYNC_SCHEMA_VERSION, SYNC_BATCH_ID_RE } from "../../shared/syncEvidence";

/** 同步域事件类型（V09-23）。登记面＝全模块词表并集；与 types.ts `REGISTERED_EVENT_TYPES` 的两条同步。 */
export const SYNC_EVENT_TYPES = ["sync.contract_registered", "sync.evidence_checked"] as const;

/** 后台发现一次最多处理的已注册项目数（有界；达到上限如实报 incomplete，不截断后报通过） */
export const SYNC_MAX_PROJECTS = 64;
/** 一个项目一次最多处理的证据文件数 / 单文件字节上限 / 收件目录总读取预算 */
export const SYNC_MAX_EVIDENCE_FILES = 512;
export const SYNC_MAX_EVIDENCE_BYTES = 8 * 1024 * 1024;
export const SYNC_MAX_EVIDENCE_TOTAL_BYTES = 64 * 1024 * 1024;
/** 写侧门禁拒因（service.submit 的 detail.reason；与 claims/sync 同一判据） */
export const SYNC_BLOCKED_DETAIL_REASON = "sync_blocked";
/** 允许登记/扫描同步契约的职责（设计/协调）。**角色名不是密码学授权**——只作职责边界并记 actor。 */
export const SYNC_REGISTRATION_ROLES: readonly string[] = ["designer", "coordinator"];

export interface SyncSubmitter {
  submit(command: unknown): WorkReceipt | Promise<WorkReceipt>;
}

export interface SyncBlockBatch {
  batch_id: string;
  title: string;
  verdict: SyncVerdict;
  reasons: string[];
}
export interface SyncBlockInfo {
  configured: boolean;
  blocked: boolean;
  overall: SyncVerdict;
  batches: SyncBlockBatch[];
}

export interface SyncScanEntry {
  batch_id: string;
  evidence_path: string;
  submitted: boolean;
  duplicate: boolean;
  verdict: SyncVerdict;
  error: string | null;
  receipt?: WorkReceipt;
}
export interface SyncScanOutcome {
  project_id: string;
  report: SyncStatusReport;
  entries: SyncScanEntry[];
  scan_error: string | null;
}

// ── 六图探针注册（组合根把 sixGraphsOf 注入 syncProbe；sync 不反向 import 上层模块）──

export { registerSyncGraphProbe, syncGraphProbe } from "./syncProbe";
export type { SyncGraphProbe, SyncGraphProbeResult } from "./syncProbe";

// ── 项目路径 ──

interface ProjectCtx {
  projectId: string;
  projectRoot: string;
  workDir: string;
  dataDir: string;
}

function projectCtx(projectId: string, dataDir: string): ProjectCtx {
  const project = getProject(projectId, dataDir);
  if (project === undefined) throw new WorkError("INVALID_COMMAND", `项目不存在: ${projectId}`, { project_id: projectId });
  return { projectId, projectRoot: path.resolve(project.path), workDir: projectWorkDir(projectId, dataDir), dataDir };
}

// ── 后台发现错误（唯一写服务宿主内的只读消费点）──
//
// B 侧 `syncRuntimeHealth` 是**零依赖**模块（只 node:*），直接 import 不会拉回 `sixGraphsOf` 依赖链
// （防 `sixGraphsOf → entry → sync → 探针 → sixGraphsOf` 递归）。A 只读消费：项目错误含全局、不含别的项目——
// 「没有同步配置的旧项目不因其他项目单独故障被阻断」。
/** 读本项目（含全局宿主级）的后台发现错误（去重；读失败＝无，旧无配置项目零影响） */
function discoveryIssuesFor(dataDir: string, projectId: string): string[] {
  try {
    const out = new Set<string>();
    for (const s of readSyncDiscoveryIssues(dataDir, projectId)) if (typeof s === "string" && s.trim() !== "") out.add(s.trim());
    return [...out];
  } catch {
    return [];
  }
}

/**
 * 只读：本项目（含全局宿主级）当前的后台发现错误（去重）。
 * 供唯一宿主把「同一份错误」经只读 HTTP 读口交给 MCP 另一进程复用（Codex 反例12）——
 * MCP 不拿自己进程里的空汇冒充"后台无故障"。
 */
export function readProjectDiscoveryIssues(projectId: string, dataDir: string): string[] {
  return discoveryIssuesFor(dataDir, projectId);
}

function realpathOrNull(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/** p 是否在 root 内（都应是规范化绝对路径/realpath） */
function isInside(root: string, p: string): boolean {
  const rel = path.relative(root, p);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * **单次调用内**六图构建的复用键（V09-23 性能补正）。覆盖 canonical builder 的**实际影响源**：
 * 生效基线身份与设计/施工源修订、有界图输入文件身份（blueprint/modules/supplement/names/
 * graph-update/reconcile-last/semantic-status）、业务事件投影、以及事件账本文件的当前身份。
 * 不含墙钟/检查时间；**不跨请求持久**（每次 `evalContext` 重建）。
 *
 * 返回 null = 真实图输入身份**核不出来**（探针未注册/抛错/有界图输入读取异常）→ 一律不复用，
 * 逐次真建（宁可慢也不把旧图贴到新指纹上）。
 */
function graphProbeKeyOf(c: ProjectCtx, eventsFp: string): string | null {
  const sourceProbe = syncGraphSourceProbe();
  if (sourceProbe === null) return null;
  let source: ReturnType<typeof sourceProbe>;
  try {
    source = sourceProbe(c.projectId, c.dataDir);
  } catch {
    return null;
  }
  if (source.graph_input_problems.length > 0) return null;
  let eventsFile: string;
  try {
    // 内容身份而非 size/mtime：同长度改写或时间戳被保留也必须失效。
    eventsFile = crypto.createHash("sha256").update(fs.readFileSync(eventsPath(c.workDir))).digest("hex");
  } catch {
    return null;
  }
  return stableStringify({
    project_id: c.projectId,
    data_dir: c.dataDir,
    baseline_id: source.baseline_id,
    baseline_valid: source.baseline_valid,
    source_ok: source.ok,
    source_reasons: source.reasons,
    design_revision: source.design_revision,
    plan_revision: source.plan_revision,
    plan_definition_revision: source.plan_definition_revision,
    graph_inputs: source.graph_inputs,
    events_fp: eventsFp,
    events_file: eventsFile,
  });
}

/**
 * 把 canonical builder 探针包成**单次评估内**按真实图输入身份复用的版本。
 *
 * 为什么：`readSyncStatus` 要为**每个历史批次**各裁决一次 `graph_full`，而各批用的是**同一份**
 * 真实图输入——不补正就会把整仓六图重复构建几十次（2026-10-02 诊断：31 次、8–9 秒、超客户端 5 秒预算）。
 * 复用只发生在「键逐字节相同」时；构建**前后**各核一次输入身份，窗口内变过就不入缓存（下一批自然重算），
 * 所以每批仍按**各自**基线与契约裁决，历史批次一个不跳。
 */
function memoizeGraphProbe(raw: SyncGraphProbe, c: ProjectCtx, events: readonly WorkEvent[]): SyncGraphProbe {
  const eventsFp = businessEventsFingerprint(events);
  let cache: { key: string; result: SyncGraphProbeResult } | null = null;
  return (projectId, dataDir) => {
    const pre = graphProbeKeyOf(c, eventsFp);
    if (pre === null) return raw(projectId, dataDir);
    if (cache !== null && cache.key === pre) return cache.result;
    const result = raw(projectId, dataDir);
    if (graphProbeKeyOf(c, eventsFp) === pre) cache = { key: pre, result };
    return result;
  };
}

function evalContext(c: ProjectCtx, events: readonly WorkEvent[], opts: { sourceOnly?: boolean } = {}): EvalContext {
  const rawGraphProbe = syncGraphProbe();
  const ctx: EvalContext = {
    projectId: c.projectId,
    projectRoot: c.projectRoot,
    workDir: c.workDir,
    dataDir: c.dataDir,
    events,
    graphProbe: rawGraphProbe === null ? null : memoizeGraphProbe(rawGraphProbe, c, events),
    graphSourceProbe: syncGraphSourceProbe(),
  };
  if (opts.sourceOnly === true) {
    // 锁内复核：只用有界图源探针（不跑 sixGraphsOf）＋读取字节预算，超出即明确失败。
    ctx.graphSourceOnly = true;
    ctx.byteBudget = { limit: SYNC_LOCK_REVIEW_MAX_BYTES, used: 0 };
  }
  return ctx;
}

// ── 折叠同步域事件 ──

interface FoldedBatch {
  contract: SyncContract;
  contract_sha256: string;
  registeredSeq: number;
  active: boolean;
}
interface SyncFold {
  batches: Map<string, FoldedBatch>;
  problems: string[];
}

function foldSync(events: readonly WorkEvent[]): SyncFold {
  const batches = new Map<string, FoldedBatch>();
  const problems: string[] = [];
  for (const e of events) {
    if (e.type !== "sync.contract_registered") continue;
    let contract: SyncContract;
    try {
      contract = validateSyncContract(e.payload);
    } catch (err) {
      problems.push(`事件 seq ${e.seq} 的 sync.contract_registered payload 不合法（坏领域事实，fail-closed）：${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const sha = syncContractSha256(contract);
    const existing = batches.get(contract.batch_id);
    if (existing !== undefined) {
      if (existing.contract_sha256 !== sha) problems.push(`批次 ${contract.batch_id} 被重复登记且内容不同（坏领域事实，fail-closed）`);
      continue;
    }
    batches.set(contract.batch_id, { contract, contract_sha256: sha, registeredSeq: e.seq, active: true });
  }
  // supersede：被后来契约显式取代的批次 active=false（只作历史，不再阻断）
  const superseded = new Set<string>();
  for (const b of batches.values()) if (b.contract.supersedes !== undefined) superseded.add(b.contract.supersedes);
  for (const [id, b] of batches) b.active = !superseded.has(id);
  // 环检测（防坏事实）
  for (const id of batches.keys()) {
    const seen = new Set<string>();
    let cur: string | null = id;
    while (cur !== null) {
      if (seen.has(cur)) {
        problems.push(`契约 supersedes 成环，涉及 ${id}（坏领域事实，fail-closed）`);
        break;
      }
      seen.add(cur);
      const next: string | null = batches.get(cur)?.contract.supersedes ?? null;
      cur = next !== null && batches.has(next) ? next : null;
    }
  }
  return { batches, problems };
}

// ── 收件目录枚举 ──

interface InboxFile {
  batch_id: string;
  name: string;
  abs: string;
  size: number;
}
function listInboxEvidence(c: ProjectCtx): { files: InboxFile[]; complete: boolean; reasons: string[] } {
  const dir = path.join(c.projectRoot, SYNC_INBOX_REL);
  const reasons: string[] = [];
  if (!fs.existsSync(dir)) return { files: [], complete: true, reasons };
  // 收件目录本身 realpath 守卫：联接/软链逃到项目根外一律不处理（不跟随），明确失败。
  const realRoot = realpathOrNull(c.projectRoot) ?? path.resolve(c.projectRoot);
  const realDir = realpathOrNull(dir);
  if (realDir === null) return { files: [], complete: false, reasons: [`收件目录 realpath 解析失败（不可读）：${SYNC_INBOX_REL}`] };
  if (!isInside(realRoot, realDir)) return { files: [], complete: false, reasons: [`收件目录 realpath 落在项目根外（联接/软链逃逸，不跟随）：${realDir}`] };
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    return { files: [], complete: false, reasons: [`收件目录读不出：${e instanceof Error ? e.message : String(e)}`] };
  }
  const files: InboxFile[] = [];
  let totalBytes = 0;
  for (const name of names.sort()) {
    const id = batchIdOfEvidenceFile(name);
    if (id === null) continue;
    if (files.length >= SYNC_MAX_EVIDENCE_FILES) {
      reasons.push(`收件目录证据文件数超过上限 ${SYNC_MAX_EVIDENCE_FILES}：本次未全部处理（如实报 incomplete，不截断后报通过）`);
      return { files, complete: false, reasons };
    }
    const abs = path.join(dir, name);
    let lst: fs.Stats;
    try {
      lst = fs.lstatSync(abs);
    } catch (e) {
      // 不可读显式失败（不 silent continue 让条目悄悄消失）
      reasons.push(`证据文件 ${name} 读不到：${e instanceof Error ? e.message : String(e)}`);
      return { files, complete: false, reasons };
    }
    if (lst.isSymbolicLink()) {
      reasons.push(`证据文件 ${name} 是软链/联接，不跟随（避免逃逸）：如实报 incomplete`);
      return { files, complete: false, reasons };
    }
    if (!lst.isFile()) {
      reasons.push(`证据文件 ${name} 不是常规文件：如实报 incomplete`);
      return { files, complete: false, reasons };
    }
    const realFile = realpathOrNull(abs);
    if (realFile === null || !isInside(realRoot, realFile)) {
      reasons.push(`证据文件 ${name} realpath 落在项目根外（逃逸）：不处理，如实报 incomplete`);
      return { files, complete: false, reasons };
    }
    if (lst.size > SYNC_MAX_EVIDENCE_BYTES) {
      reasons.push(`证据文件 ${name} 超过 ${SYNC_MAX_EVIDENCE_BYTES} 字节上限：不处理（如实报 incomplete）`);
      return { files, complete: false, reasons };
    }
    totalBytes += lst.size;
    if (totalBytes > SYNC_MAX_EVIDENCE_TOTAL_BYTES) {
      reasons.push(`收件目录证据总字节超过上限 ${SYNC_MAX_EVIDENCE_TOTAL_BYTES}：本次未全部处理（如实报 incomplete，不截断后报通过）`);
      return { files, complete: false, reasons };
    }
    files.push({ batch_id: id, name, abs, size: lst.size });
  }
  return { files, complete: true, reasons };
}

// ── 只读返回体 ──

const VERDICT_PRIORITY: SyncVerdict[] = ["invalid", "incomplete", "stale", "missing", "needs_review", "failed"];
function worstVerdict(verdicts: readonly SyncVerdict[]): SyncVerdict {
  for (const v of VERDICT_PRIORITY) if (verdicts.includes(v)) return v;
  return verdicts.length > 0 && verdicts.every((v) => v === "passed") ? "passed" : "failed";
}

/** 更严重者（用于把 collection 不全/后台错误并入总体；`not_configured` 最轻） */
const VERDICT_ORDER: SyncVerdict[] = ["not_configured", "passed", "failed", "needs_review", "missing", "stale", "incomplete", "invalid"];
function worsenVerdict(a: SyncVerdict, b: SyncVerdict): SyncVerdict {
  return VERDICT_ORDER.indexOf(a) >= VERDICT_ORDER.indexOf(b) ? a : b;
}

function emptyReport(projectId: string, configured: boolean, overall: SyncVerdict, scanError: string | null, collection: { complete: boolean; reasons: string[] }): SyncStatusReport {
  return { project_id: projectId, configured, overall, checked_at: nowIso(), scan_error: scanError, batches: [], unregistered_evidence: [], collection };
}

/** 读口选项：可由**唯一宿主**注入**同一份**后台发现错误（MCP 另一进程跨进程复用宿主健康；见 syncHost helper）。 */
export interface SyncReadOptions {
  /** 显式发现错误（宿主经只读读口给出）；不给＝读本进程汇（宿主自身路径） */
  discoveryIssues?: string[];
  /**
   * **宿主不可达**时按 fail-closed 合成的发现错误：只在项目**已配置同步契约**时**顶替**本进程错误汇
   * 并入（MCP stdio 另一进程的错误汇本就不可信，不能拿它冒充后台健康）；未配置的旧项目**完全忽略**，
   * 保持 `not_configured`（零影响）。给它是为了让调用方**一次同源构造**报告，不必先探测
   * configured 再重算一遍（见 `syncHost.hostSyncView`）。
   */
  unreachableIssues?: string[];
}

/** 读口：每次重读必要文件与实际目标，对比登记；历史 passed ≠ 当前 passed。只读、不写账。 */
export function readSyncStatus(projectId: string, dataDir: string, opts: SyncReadOptions = {}): SyncStatusReport {
  let c: ProjectCtx;
  try {
    c = projectCtx(projectId, dataDir);
  } catch {
    return emptyReport(projectId, false, "not_configured", null, { complete: true, reasons: [] });
  }
  let events: WorkEvent[];
  try {
    events = loadEvents(c.workDir).events;
  } catch (e) {
    return emptyReport(projectId, true, "invalid", `本领域事件读不出/损坏：${e instanceof Error ? e.message : String(e)}`, { complete: false, reasons: ["事件账本不可读"] });
  }
  const fold = foldSync(events);
  const ctx = evalContext(c, events);
  const inbox = listInboxEvidence(c);
  const byBatch = new Map(inbox.files.map((f) => [f.batch_id, f]));

  const batches: SyncBatchReport[] = [];
  for (const [id, b] of fold.batches) {
    const ev = byBatch.get(id) ?? null;
    const evidencePath = ev === null ? null : `${SYNC_INBOX_REL}/${ev.name}`;
    const evaluation = evaluateBatch(b.contract, b.registeredSeq, ev === null ? null : { path: evidencePath as string, abs: ev.abs }, ctx);
    batches.push({
      batch_id: id,
      title: b.contract.title,
      active: b.active,
      blocks_entry: b.contract.blocks_entry,
      verdict: evaluation.verdict,
      contract_sha256: b.contract_sha256,
      evidence_path: evidencePath,
      items: evaluation.items,
    });
  }
  const unregistered = inbox.files
    .filter((f) => !fold.batches.has(f.batch_id))
    .map((f) => ({ path: `${SYNC_INBOX_REL}/${f.name}`, batch_id: f.batch_id, reason: "未登记批次的证据文件（可见但不私自采纳）" }));

  const configured = fold.batches.size > 0;
  const active = batches.filter((b) => b.active);
  const healthIssues =
    opts.discoveryIssues ??
    (configured && opts.unreachableIssues !== undefined ? opts.unreachableIssues : discoveryIssuesFor(dataDir, projectId));
  let overall: SyncVerdict;
  if (fold.problems.length > 0) overall = "invalid";
  else if (active.length > 0) overall = worstVerdict(active.map((b) => b.verdict));
  else overall = "not_configured";
  // collection 未取齐 / 后台发现错误都不能让 overall 停在 passed（read 与 gate 同一fail-closed 方向）。
  if (configured && !inbox.complete) overall = worsenVerdict(overall, "incomplete");
  if (configured && healthIssues.length > 0) overall = worsenVerdict(overall, "invalid");
  const scanErrorItems = [...fold.problems, ...inbox.reasons, ...healthIssues];

  return {
    project_id: projectId,
    configured,
    overall,
    checked_at: nowIso(),
    scan_error: scanErrorItems.length > 0 ? scanErrorItems.join("；") : null,
    batches,
    unregistered_evidence: unregistered,
    collection: { complete: inbox.complete, reasons: inbox.reasons },
  };
}

/** 阻断评估的选项（read / entry / claim 三处同一份判据；claim 锁内只做有界复核） */
export interface SyncBlockOptions {
  events?: readonly WorkEvent[];
  /** 显式发现错误（宿主经只读读口给出的**同一份**；MCP 另一进程用） */
  discoveryIssues?: string[];
  /** true＝锁内复核：图项只用**有界图源探针**（不跑 sixGraphsOf 全量）＋读取字节预算 */
  sourceOnly?: boolean;
}
/** 阻断评估结果（含锁内外可比对的**有界**源/目标指纹） */
export interface SyncBlockEval {
  block: SyncBlockInfo;
  /** 有界指纹：各 active+blocks_entry 批次的 evaluation.source_fingerprint + collection + 发现错误。
   *  锁外算、锁内按当前实际事实重算，逐字节一致才放行；不含自身 sync 事件序号/墙钟。 */
  source_fingerprint: string;
}

function syncBlockFingerprint(rows: { batch_id: string; contract_sha256: string; evaluation: BatchEvaluation }[], collectionComplete: boolean, discoveryIssues: string[]): string {
  return crypto
    .createHash("sha256")
    .update(
      stableStringify({
        batches: rows.map((r) => [r.batch_id, r.contract_sha256, r.evaluation.source_fingerprint]),
        collection_complete: collectionComplete,
        discovery_issues: [...discoveryIssues].sort(),
      }),
    )
    .digest("hex");
}

function evaluateSyncBlock(projectId: string, dataDir: string, opts: SyncBlockOptions = {}): SyncBlockEval {
  let c: ProjectCtx;
  try {
    c = projectCtx(projectId, dataDir);
  } catch {
    return { block: { configured: false, blocked: false, overall: "not_configured", batches: [] }, source_fingerprint: syncBlockFingerprint([], true, []) };
  }
  let events: readonly WorkEvent[];
  try {
    events = opts.events ?? loadEvents(c.workDir).events;
  } catch (e) {
    return {
      block: { configured: true, blocked: true, overall: "invalid", batches: [{ batch_id: "<unreadable>", title: "同步域事实读不出", verdict: "invalid", reasons: [e instanceof Error ? e.message : String(e)] }] },
      source_fingerprint: "unreadable",
    };
  }
  const fold = foldSync(events);
  if (fold.problems.length > 0) {
    return {
      block: { configured: true, blocked: true, overall: "invalid", batches: [{ batch_id: "<corrupt>", title: "同步域事实损坏", verdict: "invalid", reasons: fold.problems }] },
      source_fingerprint: "corrupt",
    };
  }
  const ctx = evalContext(c, events, opts.sourceOnly === true ? { sourceOnly: true } : {});
  const inbox = listInboxEvidence(c);
  const byBatch = new Map(inbox.files.map((f) => [f.batch_id, f]));
  const blocking: SyncBlockBatch[] = [];
  const evalRows: { batch_id: string; contract_sha256: string; evaluation: BatchEvaluation }[] = [];
  for (const [id, b] of fold.batches) {
    if (!b.active || !b.contract.blocks_entry) continue;
    const ev = byBatch.get(id) ?? null;
    const evidence = ev === null ? null : { path: `${SYNC_INBOX_REL}/${ev.name}`, abs: ev.abs };
    const evaluation = evaluateBatch(b.contract, b.registeredSeq, evidence, ctx);
    evalRows.push({ batch_id: id, contract_sha256: b.contract_sha256, evaluation });
    if (evaluation.verdict !== "passed") {
      blocking.push({ batch_id: id, title: b.contract.title, verdict: evaluation.verdict, reasons: [...evaluation.reasons, ...evaluation.items.filter((i) => i.required && i.verdict !== "passed").map((i) => `${i.id}:${i.verdict}`)] });
    }
  }
  const configured = fold.batches.size > 0;
  const hasBlockingContract = [...fold.batches.values()].some((b) => b.active && b.contract.blocks_entry);
  const healthIssues = opts.discoveryIssues ?? discoveryIssuesFor(dataDir, projectId);
  // collection 未取齐 / 后台发现错误：有现行阻断契约时 fail-closed（read 与 claim 同一判据）。
  if (hasBlockingContract && blocking.length === 0 && !inbox.complete) {
    blocking.push({ batch_id: "<collection>", title: "收件目录未全部处理", verdict: "incomplete", reasons: inbox.reasons });
  }
  if (hasBlockingContract && blocking.length === 0 && healthIssues.length > 0) {
    blocking.push({ batch_id: "<discovery>", title: "后台发现错误（受影响现行阻断契约 fail-closed）", verdict: "invalid", reasons: healthIssues });
  }
  return {
    block: { configured, blocked: blocking.length > 0, overall: blocking.length > 0 ? worstVerdict(blocking.map((b) => b.verdict)) : configured ? "passed" : "not_configured", batches: blocking },
    source_fingerprint: syncBlockFingerprint(evalRows, inbox.complete, healthIssues),
  };
}

/** 接续阻断：active 且 blocks_entry 的批次未当前通过时列出差项（entry / claim / 写口同一份判据） */
export function computeSyncBlock(projectId: string, dataDir: string, opts: SyncBlockOptions = {}): SyncBlockInfo {
  return evaluateSyncBlock(projectId, dataDir, opts).block;
}

// ── 认领（非续约 task.claimed）的同步门禁：锁外独立评估 + 锁内有界快照校验（Codex 反例14 后半） ──

export interface SyncClaimGatePrep {
  blocked: boolean;
  source_fingerprint: string;
}

/** **锁外**：唯一服务按当前实际目标独立评估阻断（含六图 canonical builder），返回有界指纹供锁内比对。 */
export function prepareClaimSyncGate(args: { cmd: WorkCommand; dataDir: string; workDir: string }): SyncClaimGatePrep {
  const evaluated = evaluateSyncBlock(args.cmd.project_id, args.dataDir, {});
  return { blocked: evaluated.block.blocked, source_fingerprint: evaluated.source_fingerprint };
}

/** 阻塞批次的拒绝文案（claim 锁外/锁内共用，避免两份口径） */
function claimBlockedError(cmd: WorkCommand, block: SyncBlockInfo): WorkError {
  return new WorkError(
    "INVALID_COMMAND",
    `拒绝提交 ${cmd.type}（${cmd.entity_id}）：同步批次未当前通过（阻断接续与认领）。` +
      block.batches.map((b) => `批次 ${b.batch_id}（${b.title}）verdict=${b.verdict}：${b.reasons.slice(0, 3).join("；")}`).join(" / ") +
      "。本次命令没有写入任何字节；先让该批次所登记范围对账通过，或按契约收口/显式 supersede（DESIGN.md §2.10）",
    { reason: SYNC_BLOCKED_DETAIL_REASON, entity_id: cmd.entity_id, batches: block.batches },
  );
}

/**
 * **锁内**：用**有界**图源探针/文件字节/业务投影重算当前实际事实，与锁外预评估**逐字节一致**才放行；
 * 锁内**不跑 `sixGraphsOf` 全量**（契约「不要跑不受控全仓扫描」）。目标在锁等待期间变过/超预算 → 明确拒（零字节）。
 */
export function assertClaimSyncGate(args: { events: readonly WorkEvent[]; cmd: WorkCommand; dataDir: string; workDir: string; prep: SyncClaimGatePrep }): void {
  const evaluated = evaluateSyncBlock(args.cmd.project_id, args.dataDir, { events: args.events, sourceOnly: true });
  if (evaluated.block.blocked) throw claimBlockedError(args.cmd, evaluated.block);
  if (evaluated.source_fingerprint !== args.prep.source_fingerprint) {
    throw new WorkError(
      "INVALID_COMMAND",
      `拒绝提交 ${args.cmd.type}（${args.cmd.entity_id}）：锁内按当前实际目标重算的有界指纹与锁外独立预评估不一致` +
        "（计算后目标变过，或读取超预算）——零字节拒绝，不用旧结论顶替（DESIGN.md §2.10）",
      { reason: "sync_claim_target_changed", entity_id: args.cmd.entity_id },
    );
  }
}

/** 是否配置过同步契约（或明确有收件目录）：后台发现据此决定处理哪些项目 */
export function projectHasSyncContract(projectId: string, dataDir: string): boolean {
  const project = getProject(projectId, dataDir);
  if (project === undefined) return false;
  const root = path.resolve(project.path);
  try {
    if (fs.existsSync(path.join(root, SYNC_INBOX_REL))) return true;
  } catch {
    /* 收件目录判不出来 → 只看事件 */
  }
  const workDir = projectWorkDir(projectId, dataDir);
  const { events } = loadEvents(workDir);
  return events.some((e) => e.type === "sync.contract_registered");
}

// ── 写边界：锁内按当前实际目标重算并逐项比对 ──

function currentEntityRevision(events: readonly WorkEvent[], entityId: string): number {
  return events.reduce((rev, e) => (e.entity_id === entityId ? Math.max(rev, e.entity_revision) : rev), 0);
}

function contractOfPayload(payload: Record<string, unknown>): SyncContract {
  return validateSyncContract(payload);
}

/**
 * 唯一写入服务文件锁内的**契约登记**核实（`service.submit` ②ⅸ）。
 * 任何伪造/来源漂移/契约不符/非设计协调职责一律抛（**被拒命令零字节**）。
 */
export function assertSyncContractWriteCommand(args: { events: readonly WorkEvent[]; cmd: WorkCommand; dataDir: string; workDir: string }): void {
  const { cmd } = args;
  const c: ProjectCtx = { projectId: cmd.project_id, projectRoot: path.resolve(getProject(cmd.project_id, args.dataDir)?.path ?? args.workDir), workDir: args.workDir, dataDir: args.dataDir };

  // 职责边界**锁内核**：登记工具层已限 designer/coordinator，但直连通用写口必须同样拒（角色名不是密码学授权，
  // 但职责边界不能在直连路径被绕过）。
  if (!SYNC_REGISTRATION_ROLES.includes(cmd.role)) {
    throw new WorkError("INVALID_COMMAND", `同步契约登记限设计/协调职责（role ∈ ${SYNC_REGISTRATION_ROLES.join("/")}），本次 role=${JSON.stringify(cmd.role)}——直连通用写口也不能旁路`, { entity_id: cmd.entity_id, role: cmd.role });
  }
  let contract: SyncContract;
  try {
    contract = contractOfPayload(cmd.payload ?? {});
  } catch (e) {
    throw new WorkError("INVALID_COMMAND", `sync.contract_registered 契约不合法：${e instanceof Error ? e.message : String(e)}`, { entity_id: cmd.entity_id });
  }
  if (contract.project_id !== cmd.project_id) throw new WorkError("INVALID_COMMAND", `契约 project_id=${contract.project_id} 与命令 ${cmd.project_id} 不符`, { entity_id: cmd.entity_id });
  if (`sync:${contract.batch_id}` !== cmd.entity_id) throw new WorkError("INVALID_COMMAND", `契约 batch_id=${contract.batch_id} 必须对应实体 sync:${contract.batch_id}（本次 ${cmd.entity_id}）`, { entity_id: cmd.entity_id });
  const sourceProblems = contractSourceProblems(contract, c.projectRoot);
  if (sourceProblems.length > 0) throw new WorkError("INVALID_COMMAND", `契约来源实核不通过：${sourceProblems.join("；")}`, { entity_id: cmd.entity_id, problems: sourceProblems });

  const fold = foldSync(args.events);
  const existing = fold.batches.get(contract.batch_id);
  if (existing !== undefined && existing.contract_sha256 !== syncContractSha256(contract)) {
    throw new WorkError("INVALID_COMMAND", `批次 ${contract.batch_id} 已登记且内容不同——同 batch 改内容拒（要改范围用新批次并显式 supersedes）`, { entity_id: cmd.entity_id });
  }
  if (contract.supersedes !== undefined) {
    const prev = fold.batches.get(contract.supersedes);
    if (prev === undefined) throw new WorkError("INVALID_COMMAND", `supersedes 指向未登记批次 ${contract.supersedes}`, { entity_id: cmd.entity_id });
    const problems = supersedeProblems(contract, prev.contract);
    if (problems.length > 0) throw new WorkError("INVALID_COMMAND", `supersedes 不兼容：${problems.join("；")}`, { entity_id: cmd.entity_id, problems });
  }
}

/** 锁外预评估的结果（唯一服务独立算出；锁内只做有界复核，不重跑全量图构建） */
export interface SyncEvidencePreparation {
  contract_sha256: string;
  evidence_sha256: string;
  /** 锁外算出的有界源/目标指纹；锁内按当前事实重算必须一致 */
  source_fingerprint: string;
}

interface EvidenceIdentity {
  batch: FoldedBatch;
  evidencePath: string;
  abs: string;
  evidenceSha: string;
}

/** 核实 batch/entity/契约哈希/证据路径/真实字节（读前核常规文件与大小界、realpath 守卫）。抛＝拒。 */
function evidenceIdentity(c: ProjectCtx, cmd: WorkCommand, fold: SyncFold): EvidenceIdentity {
  const batchId = typeof cmd.payload?.batch_id === "string" ? cmd.payload.batch_id : "";
  if (batchId === "" || `sync:${batchId}` !== cmd.entity_id) throw new WorkError("INVALID_COMMAND", `sync.evidence_checked 的 batch_id 必须对应实体 sync:<batch_id>（本次 ${cmd.entity_id}）`, { entity_id: cmd.entity_id });
  const batch = fold.batches.get(batchId);
  if (batch === undefined) throw new WorkError("INVALID_COMMAND", `sync.evidence_checked 引用了未登记批次 ${batchId}`, { entity_id: cmd.entity_id });
  const claimedSha = typeof cmd.payload?.contract_sha256 === "string" ? cmd.payload.contract_sha256 : "";
  if (claimedSha !== batch.contract_sha256) throw new WorkError("INVALID_COMMAND", `sync.evidence_checked 的 contract_sha256 与登记契约不符（旧契约/伪造）`, { entity_id: cmd.entity_id });
  const evidencePath = typeof cmd.payload?.evidence_path === "string" ? cmd.payload.evidence_path : "";
  const expectedRel = `${SYNC_INBOX_REL}/${batchId}${SYNC_EVIDENCE_FILE_SUFFIX}`;
  if (evidencePath !== expectedRel) throw new WorkError("INVALID_COMMAND", `sync.evidence_checked 的 evidence_path 必须是 ${expectedRel}（收到 ${JSON.stringify(evidencePath)}）`, { entity_id: cmd.entity_id });
  const abs = path.join(c.projectRoot, evidencePath);
  if (!fs.existsSync(abs)) throw new WorkError("INVALID_COMMAND", `sync.evidence_checked 引用的证据包不存在：${evidencePath}`, { entity_id: cmd.entity_id });
  const realRoot = realpathOrNull(c.projectRoot) ?? path.resolve(c.projectRoot);
  const realFile = realpathOrNull(abs);
  if (realFile === null || !isInside(realRoot, realFile)) throw new WorkError("INVALID_COMMAND", `证据包 realpath 落在项目根外（联接/软链逃逸）：${evidencePath}`, { entity_id: cmd.entity_id });
  let st: fs.Stats;
  try {
    st = fs.statSync(abs);
  } catch (e) {
    throw new WorkError("INVALID_COMMAND", `证据包读不到：${e instanceof Error ? e.message : String(e)}`, { entity_id: cmd.entity_id });
  }
  if (!st.isFile()) throw new WorkError("INVALID_COMMAND", `证据包不是常规文件：${evidencePath}`, { entity_id: cmd.entity_id });
  if (st.size > SYNC_MAX_EVIDENCE_BYTES) throw new WorkError("INVALID_COMMAND", `证据包超过 ${SYNC_MAX_EVIDENCE_BYTES} 字节上限：${evidencePath}`, { entity_id: cmd.entity_id });
  const text = fs.readFileSync(abs, "utf8");
  const evidenceSha = crypto.createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
  if (cmd.payload?.evidence_sha256 !== evidenceSha) throw new WorkError("INVALID_COMMAND", `sync.evidence_checked 的 evidence_sha256 与证据包实际字节不符`, { entity_id: cmd.entity_id });
  return { batch, evidencePath, abs, evidenceSha };
}

function assertClaimMatches(cmd: WorkCommand, evaluation: BatchEvaluation): void {
  const expectedItems = evaluation.items.map((i) => ({ id: i.id, required: i.required, verdict: i.verdict }));
  const claimedItems = Array.isArray(cmd.payload?.items) ? (cmd.payload.items as { id?: unknown; required?: unknown; verdict?: unknown }[]) : [];
  const mismatch: string[] = [];
  if (cmd.payload?.overall !== evaluation.verdict) mismatch.push(`overall：声称 ${JSON.stringify(cmd.payload?.overall)}，实际 ${evaluation.verdict}`);
  if (cmd.payload?.target_fingerprint !== evaluation.target_fingerprint) mismatch.push("target_fingerprint 与当前实际目标不符（计算后目标变过或伪造）");
  if (claimedItems.length !== expectedItems.length) mismatch.push(`items 条数：声称 ${claimedItems.length}，实际 ${expectedItems.length}`);
  else
    for (let i = 0; i < expectedItems.length; i++) {
      const ci = claimedItems[i];
      if (ci.id !== expectedItems[i].id || ci.required !== expectedItems[i].required || ci.verdict !== expectedItems[i].verdict) {
        mismatch.push(`item ${expectedItems[i].id}：声称 ${JSON.stringify(ci)}，实际 ${JSON.stringify(expectedItems[i])}`);
      }
    }
  if (mismatch.length > 0) {
    throw new WorkError("INVALID_COMMAND", `sync.evidence_checked 与独立按当前实际目标的重算不符（不许直连伪造 passed 绕过检查）：${mismatch.join("；")}`, { entity_id: cmd.entity_id, reason: "sync_evidence_mismatch", mismatch });
  }
}

/**
 * **锁外**：唯一服务按当前实际目标做**独立全量评估**（含六图 canonical builder），与命令声称的
 * overall/逐项 verdict/目标指纹逐项比对——不符即拒（零字节）。返回锁内复核用的有界指纹。
 */
export function prepareSyncEvidenceCheck(args: { cmd: WorkCommand; dataDir: string; workDir: string }): SyncEvidencePreparation {
  const c = projectCtx(args.cmd.project_id, args.dataDir);
  const events = loadEvents(c.workDir).events;
  const fold = foldSync(events);
  const id = evidenceIdentity(c, args.cmd, fold);
  const evaluation = evaluateBatch(id.batch.contract, id.batch.registeredSeq, { path: id.evidencePath, abs: id.abs }, evalContext(c, events));
  assertClaimMatches(args.cmd, evaluation);
  return { contract_sha256: id.batch.contract_sha256, evidence_sha256: id.evidenceSha, source_fingerprint: evaluation.source_fingerprint };
}

/**
 * 唯一写入服务文件锁**内**的 sync.evidence_checked 核实：
 * 重核身份与真实字节（不信任锁外准备），并用**有界图源探针/文件字节/业务投影**重算
 * 源/目标指纹——与锁外预评估**逐字节一致**才放行。**不在锁内跑 `sixGraphsOf` 全量**（违反规范）。
 * 目标在锁等待期间变过、或读取超预算，一律明确失败（零字节），不覆盖活锁，也不只信 caller 摘要。
 */
export function assertSyncEvidenceWriteCommand(args: { events: readonly WorkEvent[]; cmd: WorkCommand; dataDir: string; workDir: string; prep: SyncEvidencePreparation }): void {
  const { cmd, prep } = args;
  const c: ProjectCtx = { projectId: cmd.project_id, projectRoot: path.resolve(getProject(cmd.project_id, args.dataDir)?.path ?? args.workDir), workDir: args.workDir, dataDir: args.dataDir };
  const fold = foldSync(args.events);
  if (fold.problems.length > 0) throw new WorkError("INVALID_COMMAND", `同步域事实损坏（fail-closed）：${fold.problems.join("；")}`, { entity_id: cmd.entity_id });
  const id = evidenceIdentity(c, cmd, fold);
  if (id.batch.contract_sha256 !== prep.contract_sha256) throw new WorkError("INVALID_COMMAND", `锁等待期间契约变化过（batch ${id.batch.contract.batch_id}）：零字节拒绝`, { entity_id: cmd.entity_id });
  if (id.evidenceSha !== prep.evidence_sha256) throw new WorkError("INVALID_COMMAND", `锁等待期间证据包字节变化过：声称 ${prep.evidence_sha256.slice(0, 12)}…，当前 ${id.evidenceSha.slice(0, 12)}…`, { entity_id: cmd.entity_id });
  const evaluation = evaluateBatch(id.batch.contract, id.batch.registeredSeq, { path: id.evidencePath, abs: id.abs }, evalContext(c, args.events, { sourceOnly: true }));
  if (evaluation.source_fingerprint !== prep.source_fingerprint) {
    throw new WorkError(
      "INVALID_COMMAND",
      "sync.evidence_checked：锁内按当前实际目标重算的有界指纹与锁外独立预评估不一致（计算后目标变过，或读取超预算）——零字节拒绝，不用旧结论顶替",
      { entity_id: cmd.entity_id, reason: "sync_evidence_target_changed" },
    );
  }
}

// ── 扫描（后台与显式共用同一逻辑与真正唯一写口） ──

/**
 * 证据包在 `putEvidence` 的版本绑定（Codex 反例13；契约附录第 95 行）：
 *   · 有 `task_definitions` 检查 → `revision_kind="plan"` ＋ 该 check 的**真实** `source_sha256`；
 *   · 没有 → `revision_kind="interface"` ＋ **本同步契约内容哈希**（此处 interface 明确指**同步契约**，
 *     不是业务接口验证）。**禁止**把任意 `source.sha` 假标成 plan 修订。
 */
function evidenceBindingOf(contract: SyncContract): { revision_kind: "plan" | "interface"; revision: string } {
  for (const it of contract.items) {
    if (it.check.type === "task_definitions") return { revision_kind: "plan", revision: it.check.source_sha256 };
  }
  return { revision_kind: "interface", revision: syncContractSha256(contract) };
}

/**
 * 扫描一个项目：发现收件目录里已登记批次的证据包，逐项核对**当前实际目标**，
 * 经唯一写口提交 `sync.evidence_checked`（稳定幂等键——重复扫描/重启零重复效果），返回同一份读口返回体。
 */
export async function scanSyncProject(req: { projectId: string; dataDir: string; submitter: SyncSubmitter; actorId?: string; role?: string }): Promise<SyncScanOutcome> {
  const c = projectCtx(req.projectId, req.dataDir);
  const actorId = req.actorId ?? "sync-scanner";
  const role = req.role ?? "coordinator";
  const entries: SyncScanEntry[] = [];
  let scanError: string | null = null;

  let events: WorkEvent[];
  try {
    events = loadEvents(c.workDir).events;
  } catch (e) {
    return { project_id: req.projectId, report: readSyncStatus(req.projectId, req.dataDir), entries: [], scan_error: `事件读不出：${e instanceof Error ? e.message : String(e)}` };
  }
  const fold = foldSync(events);
  if (fold.problems.length > 0) scanError = fold.problems.join("；");
  const inbox = listInboxEvidence(c);
  const ctx = evalContext(c, events);

  for (const f of inbox.files) {
    const b = fold.batches.get(f.batch_id);
    if (b === undefined) continue; // 未登记批次不采纳（读口会单列）
    const evidencePath = `${SYNC_INBOX_REL}/${f.name}`;
    try {
      const text = fs.readFileSync(f.abs, "utf8");
      // 证据包真实字节经现有 putEvidence 保存（内容寻址、不可变、可核哈希）
      putEvidence(c.workDir, {
        content: text,
        kind: "other",
        summary: `同步证据包 ${f.batch_id}（契约 ${b.contract_sha256.slice(0, 12)}…）`,
        created_by: actorId,
        role,
        binding: evidenceBindingOf(b.contract),
        source_ref: evidencePath,
      });
      const evidenceSha = crypto.createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
      const evaluation = evaluateBatch(b.contract, b.registeredSeq, { path: evidencePath, abs: f.abs }, ctx);
      const payload = {
        batch_id: f.batch_id,
        contract_sha256: b.contract_sha256,
        evidence_sha256: evidenceSha,
        evidence_path: evidencePath,
        overall: evaluation.verdict,
        target_fingerprint: evaluation.target_fingerprint,
        items: evaluation.items.map((i) => ({ id: i.id, required: i.required, verdict: i.verdict })),
      };
      const idem = `sync-evidence:${b.contract_sha256.slice(0, 16)}:${evidenceSha.slice(0, 16)}:${evaluation.target_fingerprint.slice(0, 16)}:${evaluation.verdict}`;
      // 稳定幂等键**已用**（同契约/同证据字节/同目标指纹/同结论）→ 直接回报 duplicate、**零新增**：
      // 幂等键是内容指纹，不含实体 revision；重复扫描/文件重复通知/响应丢失/重启并发都走这一条短路，
      // 不能把命令再送去 submit（实体 revision 已推进，重发会撞 IDEMPOTENCY_CONFLICT 并被后台当扫描错误）。
      if (events.some((e) => e.idempotency_key === idem)) {
        entries.push({ batch_id: f.batch_id, evidence_path: evidencePath, submitted: false, duplicate: true, verdict: evaluation.verdict, error: null });
        continue;
      }
      const cmd: WorkCommand = {
        schema_version: 2,
        project_id: req.projectId,
        change_id: "change-none",
        entity_id: `sync:${f.batch_id}`,
        expected_revision: currentEntityRevision(events, `sync:${f.batch_id}`),
        type: "sync.evidence_checked",
        actor_id: actorId,
        role,
        idempotency_key: idem,
        payload,
      };
      const receipt = await Promise.resolve(req.submitter.submit(cmd));
      if (!receipt.ok) throw new Error("写口未回执 ok");
      if (receipt.projection.state !== "applied") throw new Error(`投影未跟上：${receipt.projection.error ?? "unknown"}`);
      entries.push({ batch_id: f.batch_id, evidence_path: evidencePath, submitted: receipt.duplicate !== true, duplicate: receipt.duplicate === true, verdict: evaluation.verdict, error: null, receipt });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      entries.push({ batch_id: f.batch_id, evidence_path: evidencePath, submitted: false, duplicate: false, verdict: "invalid", error: msg });
      scanError ??= `批次 ${f.batch_id} 扫描失败：${msg}`;
    }
  }
  if (!inbox.complete && scanError === null) scanError = inbox.reasons.join("；");
  return { project_id: req.projectId, report: readSyncStatus(req.projectId, req.dataDir), entries, scan_error: scanError };
}

/** 由 MCP 工具构造登记命令（校验只活在对象命令层；写仍经唯一写口） */
export function buildRegisterContractCommand(input: {
  projectId: string;
  changeId: string;
  actorId: string;
  role: string;
  contract: unknown;
  contractText?: string;
  expectedRevision: number | null;
}): WorkCommand {
  if (!SYNC_REGISTRATION_ROLES.includes(input.role)) {
    throw new WorkError("INVALID_COMMAND", `同步契约登记限设计/协调职责（role ∈ ${SYNC_REGISTRATION_ROLES.join("/")}），本次 role=${JSON.stringify(input.role)}。角色名不是密码学授权，只作职责边界并记 actor。`, { role: input.role });
  }
  const contract = validateSyncContract(input.contract, input.contractText);
  return {
    schema_version: 2,
    project_id: input.projectId,
    change_id: input.changeId,
    entity_id: `sync:${contract.batch_id}`,
    expected_revision: input.expectedRevision,
    type: "sync.contract_registered",
    actor_id: input.actorId,
    role: input.role,
    idempotency_key: `sync-contract:${contract.batch_id}:${syncContractSha256(contract).slice(0, 24)}`,
    payload: contract as unknown as Record<string, unknown>,
  };
}

/** 当前同步实体版本（登记命令的 expected_revision；只读） */
export function syncEntityRevision(projectId: string, dataDir: string, batchId: string): number {
  const c = projectCtx(projectId, dataDir);
  const { events } = loadEvents(c.workDir);
  return currentEntityRevision(events, `sync:${batchId}`);
}

/**
 * 已登记批次的契约哈希（登记前做**幂等短路**：同 batch 同内容 → 不重复提交；同 batch 异内容 → 拒）。
 * 只读，不改账本。返回 null 表示该 batch 尚未登记。
 */
export function existingContractSha(projectId: string, dataDir: string, batchId: string): string | null {
  const c = projectCtx(projectId, dataDir);
  const { events } = loadEvents(c.workDir);
  const fold = foldSync(events);
  return fold.batches.get(batchId)?.contract_sha256 ?? null;
}
