// V09-31/37 宿主**只读**计算作业（主线程与 worker 线程共用同一份实现）。
//
// 为什么单独一个模块：MCP `project_entry` 现路径是「远端 sync status + 本地入口 + 本地图摘要」——同一份请求里
// 同步、入口、六图各读一遍盘、各建一遍图（DESIGN §6.8；本会话任务目标一）。这里把「一次取快照 → 入口 +
// 图摘要 + 同步判据**同一版事实**」的组装收在一处，宿主只读 HTTP 入口（service.ts `/api/work/entry`）与
// worker 线程都调它——**判据只有一份**，不会两处漂移。
//
// 三条红线：
//   · **纯只读**：只调 entry/sixGraphs/sync 的现读函数；不 submit、不写盘、不认领、不调模型。worker 线程因此
//     天然不能写账本（它只 import 本模块；`verify-unified-host.ts` 用真实字节验证 worker 运行期间账本零增长）。
//   · **同一版事实**：`eventsSnapshotOf` 现读**一次**，沿入口/图摘要/同步判据共享；快照读不出（账本损坏等）
//     就都不共享、各按既有路径现读并如实报失败——**不跨请求缓存旧绿**（快照只活在这一次调用栈里）。
//   · **不丢必要核验**：graph_full 必需判据、同步全局阻断、基线有效性等一概照常算；本模块只做"少读几遍盘"，
//     不减任何判据。
import { evaluateProjectEntry, type ProjectEntry, type ProjectEntryInput } from "./entry";
import { eventsSnapshotOf, type EventsSnapshot } from "./statusProjection";
import { graphSummaryOf } from "../../arch/sixGraphs";
import { readSyncStatus, SYNC_INBOX_REL, planSyncScan, prepareSyncEvidenceCheck, prepareClaimSyncGate, type SyncScanPlan, type SyncEvidencePreparation, type SyncClaimGatePrep } from "./sync";
import type { LedgerContentFingerprint, WorkCommand } from "./types";
import { activeBaseline, loadDocument } from "./documents";
import { graphInputsOf } from "./syncGraph";
import type { SyncStatusReport } from "../../shared/syncEvidence";
import { computeArchBlueprintRead, computeArchRenderRead } from "./archReadWorker";

const WORKBENCH = ".工作台";

/**
 * 只读计算期间**必要输入**（账本正文、设计/施工正文与定义、生效基线、有界图输入身份）持续变化，
 * 有界重试后仍无法得出「与当前版一致」的结论：**明确拒绝**这次读取，不返回 `ok:true` + 旧 next_action
 * 只在旁边挂一个 stale 字段（那等于把可执行的旧结论交出去；DESIGN §6.8 / 契约 U1）。
 *
 * 为什么是 `Error` 子类而不是 `WorkError`：这里发生在只读计算层（`readJobs`），错误码经 worker 协议的
 * `code/detail` 原样回宿主、由 HTTP 层映射 503；不把它混进写命令的 `WorkErrorCode` 联合。
 */
export class EntrySourceChanged extends Error {
  readonly code = "SOURCE_CHANGED";
  readonly detail: Record<string, unknown>;
  constructor(message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = "EntrySourceChanged";
    this.detail = detail;
  }
}

/** 一次现读得到的账本内容身份（读不出/无内容证明如实返回原因，不假装同版） */
type LedgerIdentityCheck = { ok: true; content: LedgerContentFingerprint | null } | { ok: false; reason: string };

/** 现读账本内容身份（含尾状态：完整 prefix/file 字节，不看 mtime/seq）。读不出如实给原因。 */
function ledgerIdentityOf(projectId: string, dataDir: string): LedgerIdentityCheck {
  try {
    const s = eventsSnapshotOf(projectId, dataDir);
    return { ok: true, content: s.content ?? null };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/** 账本内容身份的逐字段比对（file_bytes/verified_bytes/prefix_sha256；任一不同即"内容已变"） */
function sameLedgerContent(a: LedgerContentFingerprint | null, b: LedgerContentFingerprint | null): boolean {
  if (a === null || b === null) return a === b;
  return a.file_bytes === b.file_bytes && a.verified_bytes === b.verified_bytes && a.prefix_sha256 === b.prefix_sha256;
}
const EVENTS_REL = `${WORKBENCH}/work/events.jsonl`;

/** 只读作业种类（worker 协议的一部分；新增须同步 `readWorker.ts` 的分派与宿主路由） */
export type ReadJobKind = "entry" | "sync_status" | "sync_scan" | "sync_prep" | "arch_blueprint" | "arch_render";

export interface EntryReadArgs {
  projectId: string;
  dataDir: string;
  /** §6.7 入口输入（project_id/role/client_capabilities/known_revision/resume_hint） */
  input: ProjectEntryInput;
  /** V09-34：是否附前置说明（默认不加，保持九字段契约） */
  preconditions?: boolean;
  /** 宿主进程自己的后台发现错误（产品路径不传＝读本进程汇；仅供测试显式注入） */
  syncDiscoveryIssues?: string[];
}

export interface SyncStatusReadArgs {
  projectId: string;
  dataDir: string;
  /** 显式发现错误（默认读宿主自己的汇） */
  discoveryIssues?: string[];
}

/** 一次宿主只读入口的返回：入口 + 图摘要 + 版本/来源，且标出"是否真的同一版事实"（复审要求：需事实支持）。 */
export interface EntryView {
  ok: true;
  entry: ProjectEntry;
  graph_summary: unknown;
  versions: {
    baseline_id: string | null;
    design_revision: string | null;
    plan_revision: string | null;
    plan_definition_revision: string | null;
    graph_snapshot_id: string | null;
    /**
     * 账本的**可验证内容身份**（V09-31/37 复审 C）：`content_sha256`＝本次现读覆盖字节段的 sha256
     * （不是 mtime/size、不是 seq）。`null`＝本次没取到可验证内容身份（如实标，不假装同版）。
     */
    ledger: {
      content_sha256: string;
      verified_bytes: number;
      file_bytes: number;
      events: number;
    } | null;
  };
  source: {
    ledger: string;
    /** "shared"＝入口/图/同步共用同一份现读快照；"unreadable"＝快照读不出，各判据各自现读并如实报错 */
    events_snapshot: "shared" | "unreadable";
    events_snapshot_unreadable: string | null;
    /**
     * V09-31/37 复审 C：本次计算用的**设计/施工/基线/图输入**与回包前重读的当前值是否一致。
     * `true`＝前后复核通过（结果即当前版）；`false`＝有界重试后仍在变——结果**标 stale**，不冒充同版。
     */
    sources_stable: boolean;
    /** 复核不一致时逐项列出（前后重读逐字节比对，不是靠中文措辞或缓存 TTL） */
    sources_stale_reasons: string[];
    /** 实际重算次数（1＝一次通过；>1＝期间源变过、重算过） */
    attempts: number;
  };
  /** 判据/口径版本（"规则版本"；兼容可选字段）：读侧据此知道这份结果出自哪一条实现口径 */
  contract: { id: "entry-view"; version: "v09-31"; judge: "same-snapshot-entry-graph-sync" };
}

/** 源身份快照（设计/施工正文与定义哈希、生效基线 id、有界图输入身份）——用于**前后复核**，不是跨请求缓存。 */
interface SourceIdentity {
  design: string | null;
  plan: string | null;
  plan_definition: string | null;
  baseline_id: string | null;
  /** 有界图输入身份（含读取异常）：稳定序列化，只与自身比较（不跨请求当缓存键） */
  graph_inputs: string;
}

function sourceIdentityOf(projectId: string, dataDir: string): SourceIdentity {
  let design: string | null = null;
  let plan: string | null = null;
  let planDef: string | null = null;
  try {
    const d = loadDocument(projectId, "design", dataDir);
    design = d?.revision.content_sha256 ?? null;
  } catch {
    design = null;
  }
  try {
    const p = loadDocument(projectId, "plan", dataDir);
    plan = p?.revision.content_sha256 ?? null;
    planDef = p?.revision.definition_sha256 ?? null;
  } catch {
    plan = null;
    planDef = null;
  }
  let baselineId: string | null = null;
  try {
    baselineId = activeBaseline(projectId, dataDir)?.baseline_id ?? null;
  } catch {
    baselineId = null;
  }
  let graph = "";
  try {
    const gi = graphInputsOf(projectId, dataDir);
    graph = JSON.stringify({ inputs: gi.inputs, problems: gi.problems });
  } catch (e) {
    graph = `error:${e instanceof Error ? e.message : String(e)}`;
  }
  return { design, plan, plan_definition: planDef, baseline_id: baselineId, graph_inputs: graph };
}

/** 图的读不出来时的兜底摘要（与 MCP 工具面**逐字同款**：不阻断入口，如实带原因，其余字段照给）。 */
function graphSummaryFallback(projectId: string, message: string): unknown {
  return {
    available: false,
    reason: `六图摘要算不出来：${message}（按「读不到」如实表达，不假装有图）`,
    next_read_entry: {
      tool: "get_project_graphs",
      args: { project_id: projectId, graph: "all", mode: "full" },
      note: "六图完整状态在本工具（架构判断/影响分析用 mode=full 并按同快照游标逐图取齐；complete:true 只表示图对象取完，不等于源码全覆盖）",
    },
  };
}

/**
 * 计算宿主只读入口视图（**纯只读**）：一次现读事件快照 → 入口 + 图摘要 + 同步判据同版。
 * 读不出快照就都不共享（各按既有路径现读），`source.events_snapshot=unreadable` 如实标。
 */
export function computeEntryView(args: EntryReadArgs): EntryView {
  const { projectId, dataDir, input } = args;
  // V09-31/37 复审 C：有界重算（源在计算期间变过 → 重算；持续变 → **明确拒绝**，不冒充同版）。
  const MAX_ATTEMPTS = 3;
  let lastStale: string[] = [];
  let lastLedger: LedgerContentFingerprint | null = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const before = sourceIdentityOf(projectId, dataDir);

    let snapshot: EventsSnapshot | null = null;
    let snapshotUnreadable: string | null = null;
    try {
      snapshot = eventsSnapshotOf(projectId, dataDir);
    } catch (e) {
      snapshot = null;
      snapshotUnreadable = e instanceof Error ? e.message : String(e);
    }
    const sharedOpt = snapshot === null ? {} : { events: snapshot };

    // 入口：喂同一份快照（含同步判据；`sync_summary` 与宿主读口同源）。
    const entry = evaluateProjectEntry(input, {
      dataDir,
      ...sharedOpt,
      ...(args.preconditions === true ? { preconditions: true } : {}),
      ...(args.syncDiscoveryIssues === undefined ? {} : { syncDiscoveryIssues: args.syncDiscoveryIssues }),
    });

    // 图摘要：同一份快照（与整图同一份事实与判据；唯一例外是快照读不出——那时图自己现读，如实算）。
    let graphSummary: unknown;
    try {
      graphSummary = graphSummaryOf(projectId, { dataDir, ...sharedOpt });
    } catch (e) {
      graphSummary = graphSummaryFallback(projectId, e instanceof Error ? e.message : String(e));
    }

    // ── 回包前**必要源复核**：账本正文 + 设计/施工/基线/图输入前后（逐字节）比对 ──
    const after = sourceIdentityOf(projectId, dataDir);
    const stale: string[] = [];
    const usedDesign = entry.project.documents.design?.content_sha256 ?? null;
    const usedPlan = entry.project.documents.plan?.content_sha256 ?? null;
    const usedPlanDef = entry.project.documents.plan?.definition_sha256 ?? null;
    const usedBaseline = entry.baseline.active?.baseline_id ?? null;
    if (after.design !== usedDesign) stale.push(`设计源在本次计算中被重读发现已变（入口用 ${short(usedDesign)}，现在 ${short(after.design)}）`);
    if (after.plan !== usedPlan) stale.push(`施工源正文在本次计算中被重读发现已变（入口用 ${short(usedPlan)}，现在 ${short(after.plan)}）`);
    if (after.plan_definition !== usedPlanDef) stale.push(`施工源定义哈希在本次计算中被重读发现已变（入口用 ${short(usedPlanDef)}，现在 ${short(after.plan_definition)}）`);
    if (after.baseline_id !== usedBaseline) stale.push(`生效基线在本次计算中被重读发现已变（入口用 ${short(usedBaseline)}，现在 ${short(after.baseline_id)}）`);
    if (before.graph_inputs !== after.graph_inputs) stale.push("六图有界输入身份在本次计算前后不一致（图可能由变过的输入构建）");

    // **账本内容身份**回包前核验（V09-31/37 复审根因一）：快照读到的 prefix/file 字节身份必须与回包前现读
    // 逐字段相等（完整前缀 + 尾状态；**不看** mtime/seq）。追加一条事件、中段同长改写都会让 prefix_sha256 变。
    const usedLedger = snapshot?.content ?? null;
    const fresh = ledgerIdentityOf(projectId, dataDir);
    if (!fresh.ok) {
      stale.push(`账本在回包前重读失败（${fresh.reason}）：无法证明本次结论与当前账本同版`);
    } else if (usedLedger === null) {
      stale.push("本次入口用的账本快照没有可验证内容身份（无法证明与当前版一致）");
    } else if (!sameLedgerContent(usedLedger, fresh.content)) {
      stale.push(
        `账本内容在本次计算中被重读发现已变（快照 ${usedLedger.file_bytes}B/${short(usedLedger.prefix_sha256)}，现在 ` +
          `${fresh.content?.file_bytes ?? -1}B/${short(fresh.content?.prefix_sha256 ?? null)}）——不把变过的账本结论当当前版`,
      );
    }
    lastLedger = usedLedger;

    if (stale.length === 0) return entryViewOf(entry, graphSummary, snapshot, snapshotUnreadable, true, [], attempt);
    lastStale = stale;
  }
  // 有界重试后仍在变：**明确拒绝**（不返回 ok:true + 旧 next_action 只在旁边挂 stale 字段）。
  // 调用方（HTTP/MCP）据此报 503「源在变、请稍后重试」，绝不放行可执行的旧结论。
  const ledgerChanged = lastStale.some((r) => r.includes("账本"));
  throw new EntrySourceChanged(
    `入口必要输入在本次计算期间持续变化（有界重试 ${MAX_ATTEMPTS} 轮仍未稳定）：拒绝返回可能混版的可执行结论，请稍后重试。` +
      `原因：${lastStale.join("；")}`,
    {
      attempts: MAX_ATTEMPTS,
      reasons: lastStale,
      ledger: lastLedger === null ? null : { file_bytes: lastLedger.file_bytes, prefix_sha256: lastLedger.prefix_sha256 },
      ledger_changed: ledgerChanged,
      project_id: projectId,
    },
  );
}

function short(v: string | null): string {
  return v === null ? "（无）" : v.slice(0, 12);
}

function entryViewOf(
  entry: ProjectEntry,
  graphSummary: unknown,
  snapshot: EventsSnapshot | null,
  snapshotUnreadable: string | null,
  sourcesStable: boolean,
  staleReasons: string[],
  attempts: number,
): EntryView {
  const gs = graphSummary as { snapshot_id?: unknown } | null;
  const content = snapshot?.content ?? null;
  return {
    ok: true,
    entry,
    graph_summary: graphSummary,
    versions: {
      baseline_id: entry.baseline.active?.baseline_id ?? null,
      design_revision: entry.project.documents.design?.content_sha256 ?? null,
      plan_revision: entry.project.documents.plan?.content_sha256 ?? null,
      plan_definition_revision: entry.project.documents.plan?.definition_sha256 ?? null,
      graph_snapshot_id: typeof gs?.snapshot_id === "string" ? gs.snapshot_id : null,
      ledger:
        content === null || content === undefined
          ? null
          : {
              content_sha256: content.prefix_sha256,
              verified_bytes: content.verified_bytes,
              file_bytes: content.file_bytes,
              events: snapshot?.events.length ?? 0,
            },
    },
    source: {
      ledger: EVENTS_REL,
      events_snapshot: snapshot === null ? "unreadable" : "shared",
      events_snapshot_unreadable: snapshotUnreadable,
      sources_stable: sourcesStable,
      sources_stale_reasons: staleReasons,
      attempts,
    },
    contract: { id: "entry-view", version: "v09-31", judge: "same-snapshot-entry-graph-sync" },
  };
}

/** 扫描计划作业参数（只读；主宿主提交由 `commitSyncScan` 做） */
export interface SyncScanReadArgs {
  projectId: string;
  dataDir: string;
  actorId?: string;
  role?: string;
}

/**
 * 锁外准备作业参数（受信 worker 里跑；**命令对**：`cmd` 与 `dataDir`/`workDir` 由服务侧固定，
 * 客户端**不能**直接提供已备好的 preparation 对象——准备只能由服务派发得到）。
 */
export interface SyncPrepArgs {
  kind: "sync_evidence" | "claim_gate";
  cmd: WorkCommand;
  dataDir: string;
  workDir: string;
}

/** 只读 arch 读路径作业参数（UI 重的蓝图/provenance/render 派生） */
export interface ArchReadArgs {
  projectId: string;
  /** 仅 arch_render 用：全量上限（同一 builder 的另一组参数） */
  full?: boolean;
}

/**
 * 计算同步状态只读报告（与 `sync.readSyncStatus` 同一判据；宿主读口用）。
 *
 * 发布边界（复审根因一）：报告的 `overall`/批次结论来自**本次现读的账本快照**——回包前必须再核一次账本
 * **内容身份**（完整 prefix/file 字节，不看 mtime/seq），与计算时逐字段相等；变过就重算，超出有界重试
 * 明确拒绝（不把「读的是这一版、报的是另一版」的同步结论发出去）。
 */
export function computeSyncStatusView(args: SyncStatusReadArgs): SyncStatusReport {
  const MAX_ATTEMPTS = 3;
  let lastReason = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let snapshot: EventsSnapshot | null = null;
    try {
      snapshot = eventsSnapshotOf(args.projectId, args.dataDir);
    } catch {
      snapshot = null; // 读不出：readSyncStatus 按既有 fail-closed 给 invalid，无内容身份可核
    }
    const report = readSyncStatus(args.projectId, args.dataDir, {
      ...(snapshot === null ? {} : { events: snapshot.events }),
      ...(args.discoveryIssues === undefined ? {} : { discoveryIssues: args.discoveryIssues }),
    });
    // 账本读不出时 `readSyncStatus` 已按既有 fail-closed 给出 invalid（含原因），无内容身份可核——如实返回。
    if (snapshot === null || snapshot.content === undefined) return report;
    const fresh = ledgerIdentityOf(args.projectId, args.dataDir);
    if (fresh.ok && sameLedgerContent(snapshot.content, fresh.content)) return report;
    lastReason = fresh.ok
      ? `账本内容在本次同步判据计算中被重读发现已变（快照 ${snapshot.content.file_bytes}B/${short(snapshot.content.prefix_sha256)}，` +
        `现在 ${fresh.content?.file_bytes ?? -1}B/${short(fresh.content?.prefix_sha256 ?? null)}）`
      : `账本在回包前重读失败（${fresh.reason}）`;
  }
  throw new EntrySourceChanged(
    `同步判据的必要输入（账本）在计算期间持续变化（有界重试 ${MAX_ATTEMPTS} 轮仍未稳定）：拒绝返回可能混版的同步结论，请稍后重试。原因：${lastReason}`,
    { attempts: MAX_ATTEMPTS, reason: lastReason, project_id: args.projectId },
  );
}

/** 作业总数（同步性自检用） */
export const READ_JOB_KINDS: readonly ReadJobKind[] = ["entry", "sync_status", "sync_scan", "sync_prep", "arch_blueprint", "arch_render"];

/** 说明常量：worker/宿主读口引用的收件目录（对本模块之外只读，避免复制字符串） */
export const READ_JOBS_SYNC_INBOX_REL = SYNC_INBOX_REL;

/** 计算扫描计划（只读；主宿主 commitSyncScan 用其产出提交） */
export function computeSyncScanPlan(args: SyncScanReadArgs): SyncScanPlan {
  return planSyncScan(args);
}

/** 计算 arch 蓝图只读派生（UI 重的 blueprint/provenance/view；主宿主按 remote 做路径清洗） */
export function computeArchBlueprintJob(args: ArchReadArgs): unknown {
  return computeArchBlueprintRead(args.projectId);
}

/** 计算 arch render 只读图合成（UI 重；`full` 用同一 builder 的另一组上限） */
export function computeArchRenderJob(args: ArchReadArgs): unknown {
  return computeArchRenderRead(args.projectId, args.full === true);
}

/** 执行锁外准备作业（受信 worker/主线程共用）；抛 WorkError 时由协议带结构回执。 */
export function runSyncPrepJob(args: SyncPrepArgs): SyncEvidencePreparation | SyncClaimGatePrep {
  if (args.kind === "sync_evidence") return prepareSyncEvidenceCheck({ cmd: args.cmd, dataDir: args.dataDir, workDir: args.workDir });
  return prepareClaimSyncGate({ cmd: args.cmd, dataDir: args.dataDir, workDir: args.workDir });
}

/**
 * **同步**执行一个只读作业（worker 分派与"主线程显式本地执行"共用）。抛错＝作业失败，
 * 调用方按各自协议如实表达（worker 回 {ok:false,error}；宿主路由回结构化错误）。
 */
export function runReadJobLocal(kind: ReadJobKind, args: unknown): unknown {
  if (kind === "entry") return computeEntryView(args as EntryReadArgs);
  if (kind === "sync_status") return computeSyncStatusView(args as SyncStatusReadArgs);
  if (kind === "sync_scan") return computeSyncScanPlan(args as SyncScanReadArgs);
  if (kind === "sync_prep") return runSyncPrepJob(args as SyncPrepArgs);
  if (kind === "arch_blueprint") return computeArchBlueprintJob(args as ArchReadArgs);
  if (kind === "arch_render") return computeArchRenderJob(args as ArchReadArgs);
  throw new Error(`未知只读作业种类：${String(kind)}（只认 ${READ_JOB_KINDS.join("/")}）`);
}
