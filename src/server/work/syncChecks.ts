// 同步证据的逐项裁决（PLAN V09-23；docs/sync-evidence-contract.md「检查类型：程序读取真实目标」）。
//
// 单一职责：把一份契约 + 一份证据包 + **当前实际目标** 算成逐项 verdict。这里**不**写事件、不认服务边界。
// 反例口径：
//   · 证据包的 passed 只是**声明**——程序必须再按契约读当前实际目标；
//   · artifact 路径落在同步收件目录内 = **自引用**，不放行（收件目录里的东西不能当独立目标）；
//   · 半写/坏 JSON/重复 item/未知字段 → invalid；缺项 → missing；目标不符 → failed；来源漂移 → stale。
import fs from "node:fs";
import crypto from "node:crypto";
import type { WorkEvent } from "./types";
import { resolveProjectRelative } from "./documents";
import { importTaskDefinitions, taskDefinitionHash, type TaskDefinition } from "./plan";
import { foldTaskStates, readTaskStates } from "./tasks";
import { loadStageReads, type StageReadEntry } from "./stageReads";
import { findDuplicateKey } from "./stageReads";
import { markdownSectionDigest } from "../../shared/materialSection";
import { contractSourceSnapshot, isSyncInboxRelativePath, jsonPointerProblem, stableStringify, syncContractSha256, type SyncSourceSnapshot } from "./syncContract";
import {
  SYNC_EVIDENCE_FILE_SUFFIX,
  SYNC_EVIDENCE_RESULTS,
  SYNC_SCHEMA_VERSION,
  type SyncCheck,
  type SyncContract,
  type SyncContractItem,
  type SyncEvidenceItem,
  type SyncEvidencePackage,
  type SyncItemReport,
  type SyncItemVerdict,
  type SyncVerdict,
} from "../../shared/syncEvidence";

const SHA256_RE = /^[0-9a-f]{64}$/;
const PKG_KEYS = ["schema_version", "batch_id", "project_id", "contract_sha256", "completed", "items"];
const EV_ITEM_KEYS = ["id", "result", "artifacts"];
const ARTIFACT_KEYS = ["path", "sha256"];
/** 单个 artifact / 目标文件的读取上限（防把读口撑爆） */
export const SYNC_TARGET_MAX_BYTES = 8 * 1024 * 1024;

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const sha256Hex = (d: string | Buffer): string => crypto.createHash("sha256").update(d).digest("hex");

// ── 图探针接口（单一出处 syncProbe.ts；本模块只按结构用，不反向 import sync.ts）──

export type { SyncGraphProbe, SyncGraphProbeResult } from "./syncProbe";
import type { SyncGraphProbe, SyncGraphProbeResult, SyncGraphSourceProbe, SyncGraphSourceResult } from "./syncProbe";

// ── 证据包解析 ──

export type EvidenceParse = { ok: true; pkg: SyncEvidencePackage } | { ok: false; reasons: string[] };

/** 证据包文件名 → batch_id（只认 `<batch_id>.evidence.json`） */
export function batchIdOfEvidenceFile(name: string): string | null {
  if (!name.endsWith(SYNC_EVIDENCE_FILE_SUFFIX)) return null;
  const id = name.slice(0, -SYNC_EVIDENCE_FILE_SUFFIX.length);
  return id === "" ? null : id;
}

/**
 * 解析并校验一份证据包（严格闭键 + 重复键 + 类型/值集）。
 * 坏格式/半写/未知字段/重复 item → 返回 `{ok:false, reasons}`（**不抛**，由调用方按 invalid 表达）。
 */
export function parseEvidencePackage(raw: unknown, text?: string): EvidenceParse {
  const problems: string[] = [];
  if (text !== undefined) {
    const dup = findDuplicateKey(text);
    if (dup !== null) return { ok: false, reasons: [`证据包有重复字段「${dup}」（含转义同名写法）`] };
  }
  if (!isPlainObject(raw)) return { ok: false, reasons: ["证据包必须是 JSON 对象"] };
  const extra = Object.keys(raw).filter((k) => !PKG_KEYS.includes(k));
  if (extra.length > 0) return { ok: false, reasons: [`证据包有未知字段：${extra.join("、")}`] };
  if (raw.schema_version !== SYNC_SCHEMA_VERSION) problems.push(`schema_version 必须是 ${SYNC_SCHEMA_VERSION}`);
  if (typeof raw.batch_id !== "string" || raw.batch_id.trim() === "") problems.push("batch_id 必须是非空字符串");
  if (typeof raw.project_id !== "string" || raw.project_id.trim() === "") problems.push("project_id 必须是非空字符串");
  if (typeof raw.contract_sha256 !== "string" || !SHA256_RE.test(raw.contract_sha256)) problems.push("contract_sha256 必须是 64 位小写十六进制");
  if (typeof raw.completed !== "boolean") problems.push("completed 必须是布尔");
  if (!Array.isArray(raw.items)) return { ok: false, reasons: [...problems, "items 必须是数组"] };
  const items: SyncEvidenceItem[] = [];
  const seen = new Set<string>();
  for (const it of raw.items) {
    if (!isPlainObject(it)) return { ok: false, reasons: [...problems, "items 的每一项必须是对象"] };
    const ie = Object.keys(it).filter((k) => !EV_ITEM_KEYS.includes(k));
    if (ie.length > 0) return { ok: false, reasons: [...problems, `item 有未知字段：${ie.join("、")}`] };
    if (typeof it.id !== "string" || it.id.trim() === "") return { ok: false, reasons: [...problems, "item.id 必须是非空字符串"] };
    const id = it.id.trim();
    if (seen.has(id)) return { ok: false, reasons: [...problems, `重复 item_id：${id}`] };
    seen.add(id);
    if (typeof it.result !== "string" || !(SYNC_EVIDENCE_RESULTS as readonly string[]).includes(it.result)) {
      return { ok: false, reasons: [...problems, `item ${id} 的 result 必须是 ${SYNC_EVIDENCE_RESULTS.join("/")}`] };
    }
    if (!Array.isArray(it.artifacts) || it.artifacts.length === 0) return { ok: false, reasons: [...problems, `item ${id} 至少要有一个真实 artifact`] };
    const artifacts: { path: string; sha256: string }[] = [];
    for (const a of it.artifacts) {
      if (!isPlainObject(a)) return { ok: false, reasons: [...problems, `item ${id} 的 artifact 必须是对象`] };
      const ae = Object.keys(a).filter((k) => !ARTIFACT_KEYS.includes(k));
      if (ae.length > 0) return { ok: false, reasons: [...problems, `item ${id} 的 artifact 有未知字段：${ae.join("、")}`] };
      if (typeof a.path !== "string" || a.path.trim() === "") return { ok: false, reasons: [...problems, `item ${id} 的 artifact.path 必须是非空字符串`] };
      if (typeof a.sha256 !== "string" || !SHA256_RE.test(a.sha256)) return { ok: false, reasons: [...problems, `item ${id} 的 artifact.sha256 必须是 64 位小写十六进制`] };
      artifacts.push({ path: a.path.trim(), sha256: a.sha256 });
    }
    items.push({ id, result: it.result as SyncEvidenceItem["result"], artifacts });
  }
  if (problems.length > 0) return { ok: false, reasons: problems };
  return {
    ok: true,
    pkg: {
      schema_version: SYNC_SCHEMA_VERSION,
      batch_id: (raw.batch_id as string).trim(),
      project_id: (raw.project_id as string).trim(),
      contract_sha256: raw.contract_sha256 as string,
      completed: raw.completed as boolean,
      items,
    },
  };
}

// ── 逐项求值 ──

export interface EvalContext {
  projectId: string;
  projectRoot: string;
  workDir: string;
  dataDir: string;
  events: readonly WorkEvent[];
  graphProbe: SyncGraphProbe | null;
  /**
   * **有界**图源探针（只读生效基线身份 + 设计/施工源修订，不跑 `sixGraphsOf`）。
   * 文件锁**内**的目标指纹复核走它——锁内不跑不受控全量图构建（契约「不要跑不受控全仓扫描」）。
   */
  graphSourceProbe?: SyncGraphSourceProbe | null;
  /** true = 图项只用有界图源探针求 actual（锁内复核）；图项 actual 与全量模式**逐字段一致** */
  graphSourceOnly?: boolean;
  /** 目标读取字节预算（锁内复核用）：超预算显式失败，绝不静默截断后当通过 */
  byteBudget?: { limit: number; used: number };
}

/** 文件锁内目标复核的读取字节预算（有界；超出即明确失败）。单一出处：`syncContract.ts`。 */
export { SYNC_LOCK_REVIEW_MAX_BYTES } from "./syncContract";

export interface ItemEvaluation {
  verdict: SyncItemVerdict;
  expected: unknown;
  actual: unknown;
  reasons: string[];
  /**
   * **非 actual 的一部分**（不参与任何指纹/锁内逐字段比对）：只有 `graph_full` 在**全量**模式下带回
   * 当前图更新态（`updating`/`ready`/`stale`/`failed`），供只读修复计划如实标 `waiting_for_derivation`。
   * 锁内有界模式（graphSourceOnly）拿不到它 → undefined（不猜、不编）。
   */
  graph_update_state?: string | null;
  /**
   * `graph_update_state="updating"` 时，updating 是不是**唯一**的未通过原因（图项结构上无其它问题、
   * 且探针只带回这一条原因）。有来源漂移/其它失败时须为 false——修复计划据此**不**把 updating 说成
   * 唯一"直接原因"。非 updating 时为 undefined。
   */
  graph_update_sole?: boolean;
}

const okEval = (expected: unknown, actual: unknown): ItemEvaluation => ({ verdict: "passed", expected, actual, reasons: [] });
const bad = (verdict: SyncItemVerdict, expected: unknown, actual: unknown, reasons: string[]): ItemEvaluation => ({ verdict, expected, actual, reasons });

/**
 * **业务事件投影**指纹（图逐对象状态由 v2 事件折叠得出）：只取业务事件（**排除** `sync.*`），
 * 不含墙钟/检查时间。锁内外同一份口径——锁等待期间只要有业务推进（含认领/状态变更），指纹就变，
 * 图项复核据此明确拒绝，不拿旧全量结论顶替。同步扫描自己追加的 `sync.evidence_checked` 不入指纹
 * （否则连续扫描每次都被判「目标变过」）。
 */
export function businessEventsFingerprint(events: readonly WorkEvent[]): string {
  const rows = events
    .filter((e) => !e.type.startsWith("sync."))
    .map((e) => [e.seq, e.type, e.entity_id, e.entity_revision, e.payload]);
  return crypto.createHash("sha256").update(stableStringify(rows)).digest("hex");
}

function readTargetFile(rel: string, ctx: EvalContext): { ok: true; abs: string; buf: Buffer } | { ok: false; verdict: SyncItemVerdict; reason: string } {
  const guard = resolveProjectRelative(ctx.projectRoot, rel);
  if (!guard.ok) return { ok: false, verdict: "invalid", reason: `目标路径不合法（${guard.reason}）` };
  if (!fs.existsSync(guard.abs)) return { ok: false, verdict: "failed", reason: `目标不存在：${rel}` };
  try {
    const st = fs.statSync(guard.abs);
    if (!st.isFile()) return { ok: false, verdict: "invalid", reason: `目标不是常规文件：${rel}` };
    if (st.size > SYNC_TARGET_MAX_BYTES) return { ok: false, verdict: "invalid", reason: `目标超过读取上限 ${SYNC_TARGET_MAX_BYTES}：${rel}` };
    if (ctx.byteBudget !== undefined) {
      ctx.byteBudget.used += st.size;
      if (ctx.byteBudget.used > ctx.byteBudget.limit) {
        return { ok: false, verdict: "invalid", reason: `锁内目标复核读取超过预算 ${ctx.byteBudget.limit} 字节（本次已累计 ${ctx.byteBudget.used}）：不静默截断，明确失败` };
      }
    }
    return { ok: true, abs: guard.abs, buf: fs.readFileSync(guard.abs) };
  } catch (e) {
    return { ok: false, verdict: "failed", reason: `目标读不到：${rel}（${e instanceof Error ? e.message : String(e)}）` };
  }
}

/** JSON Pointer（拒绝非法转义、原型段 __proto__/constructor/prototype；不执行任何脚本） */
function jsonPointerGet(root: unknown, pointer: string): { found: boolean; value: unknown } {
  if (jsonPointerProblem(pointer) !== null) return { found: false, value: undefined };
  const parts = pointer.split("/").slice(1).map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
  let cur: unknown = root;
  for (const p of parts) {
    if (p === "__proto__" || p === "constructor" || p === "prototype") return { found: false, value: undefined };
    if (Array.isArray(cur)) {
      const idx = Number(p);
      if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) return { found: false, value: undefined };
      cur = cur[idx];
    } else if (isPlainObject(cur)) {
      if (!Object.prototype.hasOwnProperty.call(cur, p)) return { found: false, value: undefined };
      cur = cur[p];
    } else {
      return { found: false, value: undefined };
    }
  }
  return { found: true, value: cur };
}

function deepEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

function evalCheck(check: SyncCheck, registeredSeq: number, ctx: EvalContext): ItemEvaluation {
  switch (check.type) {
    case "file_hash": {
      const expected = { path: check.path, sha256: check.sha256 };
      const r = readTargetFile(check.path, ctx);
      if (!r.ok) return bad(r.verdict, expected, null, [r.reason]);
      const actual = { path: check.path, sha256: sha256Hex(r.buf) };
      return actual.sha256 === check.sha256
        ? okEval(expected, actual)
        : bad("failed", expected, actual, [`目标 ${check.path} 字节不符：登记 ${check.sha256.slice(0, 12)}…，当前 ${actual.sha256.slice(0, 12)}…（登记后内容变过就是 stale/failed，不拿旧通过顶上）`]);
    }
    case "json_value": {
      const expected = { path: check.path, pointer: check.pointer, value: check.expected };
      const r = readTargetFile(check.path, ctx);
      if (!r.ok) return bad(r.verdict, expected, null, [r.reason]);
      let parsed: unknown;
      try {
        parsed = JSON.parse(r.buf.toString("utf8"));
      } catch (e) {
        return bad("invalid", expected, null, [`目标不是合法 JSON：${check.path}（${e instanceof Error ? e.message : String(e)}）`]);
      }
      const got = jsonPointerGet(parsed, check.pointer);
      if (!got.found) return bad("failed", expected, null, [`JSON 指针 ${check.pointer} 在 ${check.path} 上取不到值`]);
      return deepEqual(got.value, check.expected)
        ? okEval(expected, got.value)
        : bad("failed", expected, got.value, [`${check.path}${check.pointer} 实际值与登记期望不等`]);
    }
    case "task_definitions": {
      const expected = { source_plan: check.source_plan, source_sha256: check.source_sha256 };
      const r = readTargetFile(check.source_plan, ctx);
      if (!r.ok) return bad(r.verdict, expected, null, [r.reason]);
      const planSha = sha256Hex(r.buf);
      if (planSha !== check.source_sha256) {
        return bad("stale", expected, { plan_sha256: planSha }, [`审定 plan 原文已漂移：登记 ${check.source_sha256.slice(0, 12)}…，当前 ${planSha.slice(0, 12)}…`]);
      }
      const parsed = importTaskDefinitions(r.buf.toString("utf8"), { plan_revision: planSha }).definitions;
      const states = readTaskStates(ctx.workDir).states;
      const reasons: string[] = [];
      const rows: { task_id: string; definition_sha256: string | null }[] = [];
      const parsedIds = new Set(parsed.map((d: TaskDefinition) => d.task_id));
      const missing: string[] = [];
      for (const d of parsed) {
        const st = states[d.task_id];
        if (st === undefined) {
          missing.push(d.task_id);
          rows.push({ task_id: d.task_id, definition_sha256: null });
          continue;
        }
        const currentHash = taskDefinitionHash({ ...d, change_id: st.definition_change_id });
        rows.push({ task_id: d.task_id, definition_sha256: st.definition_sha256 });
        // 定义哈希**始终**完整核对：compare 字段只决定额外逐字段口径，绝不能把完整性比对关掉。
        if (st.definition_sha256 !== currentHash) {
          reasons.push(`任务 ${d.task_id} 的定义与账本导入不符（定义哈希始终完整核对，不靠 compare 关掉）：账本 ${String(st.definition_sha256).slice(0, 12)}…，现解析 ${currentHash.slice(0, 12)}…`);
        }
      }
      const ledgerOnly = Object.keys(states).filter((k) => !parsedIds.has(k));
      if (missing.length > 0) reasons.push(`账本缺这些定义：${missing.join("、")}`);
      if (ledgerOnly.length > 0) reasons.push(`账本多出这些定义：${ledgerOnly.join("、")}`);
      if (check.expected_task_ids !== undefined) {
        const exp = new Set(check.expected_task_ids);
        const miss = [...exp].filter((x) => !parsedIds.has(x));
        const more = [...parsedIds].filter((x) => !exp.has(x));
        if (miss.length > 0) reasons.push(`期望卡号里这些没解析到：${miss.join("、")}`);
        if (more.length > 0) reasons.push(`解析出这些期望外卡号：${more.join("、")}`);
      }
      const actual = { source_plan: check.source_plan, plan_sha256: planSha, tasks: rows };
      return reasons.length === 0 ? okEval(expected, actual) : bad("failed", expected, actual, reasons);
    }
    case "task_states": {
      const atSeq = check.scope_mode === "at_registration" ? registeredSeq - 1 : null;
      const foldEvents = atSeq === null ? [...ctx.events] : ctx.events.filter((e) => e.seq <= atSeq);
      const expected = { scope_mode: check.scope_mode, at_seq: atSeq, states: check.expected };
      let states: Record<string, string>;
      try {
        const proj = foldTaskStates(foldEvents as WorkEvent[]);
        states = {};
        for (const [k, v] of Object.entries(proj.states)) states[k] = v.status;
      } catch (e) {
        return bad("invalid", expected, null, [`事件折叠失败：${e instanceof Error ? e.message : String(e)}`]);
      }
      const reasons: string[] = [];
      for (const [taskId, want] of Object.entries(check.expected)) {
        const got = states[taskId] ?? null;
        if (got !== want) reasons.push(`任务 ${taskId} 期望 ${want}，实际 ${got ?? "（无记录）"}`);
      }
      const actual = { scope_mode: check.scope_mode, at_seq: atSeq, states };
      return reasons.length === 0 ? okEval(expected, actual) : bad("failed", expected, actual, reasons);
    }
    case "graph_full": {
      const expected = { expected_baseline_id: check.expected_baseline_id };
      // 业务事件投影指纹（锁内外同一份）：图逐对象状态来自 v2 折叠，业务推进即目标变化。
      const eventsFp = businessEventsFingerprint(ctx.events);
      // 锁内复核：只用**有界图源探针**（不跑 sixGraphsOf 全量），actual 与全量模式逐字段一致。
      if (ctx.graphSourceOnly === true) {
        const sp = ctx.graphSourceProbe ?? null;
        if (sp === null) return bad("invalid", expected, null, ["有界图源探针未注册（锁内复核 fail-closed，绝不当通过）"]);
        let sres: SyncGraphSourceResult;
        try {
          sres = sp(ctx.projectId, ctx.dataDir);
        } catch (e) {
          return bad("invalid", expected, null, [`有界图源探针失败：${e instanceof Error ? e.message : String(e)}`]);
        }
        const actual = { baseline_id: sres.baseline_id, baseline_valid: sres.baseline_valid, design_revision: sres.design_revision, plan_revision: sres.plan_revision, plan_definition_revision: sres.plan_definition_revision, graph_inputs: sres.graph_inputs, graph_input_problems: sres.graph_input_problems, events_fp: eventsFp };
        // 实际有界图输入读取异常/超界 → 明确 failed/incomplete（不只带稳定 marker 放行）。
        if (sres.graph_input_verdict !== null) return bad(sres.graph_input_verdict, expected, actual, sres.graph_input_problems);
        if (!sres.ok) return bad("stale", expected, actual, sres.reasons);
        if (sres.baseline_id !== check.expected_baseline_id) {
          return bad("failed", expected, actual, [`有效基线不是登记的 ${check.expected_baseline_id}（实际 ${sres.baseline_id ?? "（无）"}）`]);
        }
        return okEval(expected, actual);
      }
      if (ctx.graphProbe === null) return bad("invalid", expected, null, ["六图 canonical builder 探针未注册（fail-closed，绝不当通过）"]);
      let res: SyncGraphProbeResult;
      try {
        res = ctx.graphProbe(ctx.projectId, ctx.dataDir);
      } catch (e) {
        return bad("invalid", expected, null, [`六图探针失败：${e instanceof Error ? e.message : String(e)}`]);
      }
      // actual **只放有界稳定字段**（基线身份 + 源修订 + 当前是否仍有效 + 图输入身份 + 业务事件投影指纹），
      // 完整图结论在 reasons——这样锁内可用图源探针重算出**逐字段一致**的 actual 做指纹复核。
      const actual = { baseline_id: res.baseline_id, baseline_valid: res.baseline_valid, design_revision: res.design_revision, plan_revision: res.plan_revision, plan_definition_revision: res.plan_definition_revision, graph_inputs: res.graph_inputs, graph_input_problems: res.graph_input_problems, events_fp: eventsFp };
      // graph_update_state 走 ItemEvaluation 的**旁路字段**（不进 actual）：锁内 actual 逐字段一致性不受影响。
      // `graph_update_sole`：图项结构上没别的毛病、且探针只带回这一条原因时，才敢说 updating 是**唯一**原因
      // （探针在 updating 时必push「图正在更新」；只要另有问题就会多一条原因 → reasons.length>1）。
      const structurallyClean =
        res.availability === "published" &&
        res.complete === true &&
        res.collection_status === "complete" &&
        res.anomalies.length === 0 &&
        res.baseline_valid === true &&
        res.baseline_id === check.expected_baseline_id &&
        res.graph_input_problems.length === 0;
      const updateSole = res.update_state === "updating" && structurallyClean && res.reasons.length === 1;
      const withState = (ev: ItemEvaluation): ItemEvaluation => ({ ...ev, graph_update_state: res.update_state ?? null, graph_update_sole: res.update_state === "updating" ? updateSole : undefined });
      if (!res.ok) return withState(bad(res.verdict, expected, actual, res.reasons));
      if (res.baseline_id !== check.expected_baseline_id) {
        return withState(bad("failed", expected, actual, [`有效基线不是登记的 ${check.expected_baseline_id}（实际 ${res.baseline_id ?? "（无）"}）`]));
      }
      return withState(okEval(expected, actual));
    }
    case "required_reads": {
      const expected = { entries: check.expected };
      const load = loadStageReads(ctx.projectRoot);
      if (load.status === "absent") return bad("failed", expected, null, ["项目没有阶段必读指针（.工作台/work/stage-reads.json 不存在）"]);
      if (load.status === "invalid") return bad("invalid", expected, null, load.reasons);
      // v2 允许同一 path 以不同 section 各列一条（登记去重键是 path+section）——按 **(path, section)** 建索引；
      // 只用 path 会让同 path 的多章节互相覆盖，出现假通过/假缺项。
      const index = new Map<string, StageReadEntry[]>();
      for (const e of load.entries) {
        const k = `${e.path}\u0000${e.section ?? ""}`;
        const arr = index.get(k);
        if (arr === undefined) index.set(k, [e]);
        else arr.push(e);
      }
      const label = (path: string, section: string | null): string => (section === null ? path : `${path}（章节 ${JSON.stringify(section)}）`);
      const reasons: string[] = [];
      const rows: { path: string; section: string | null; present: boolean; matched: number; revision: string | null }[] = [];
      for (const want of check.expected) {
        const wantSection = want.section ?? null;
        const hits = index.get(`${want.path}\u0000${wantSection ?? ""}`) ?? [];
        if (hits.length === 0 && wantSection === null) {
          // 未点名 section，但该 path 只有章节绑定条目：明确要求点名 section，不按整文件哈希猜。
          const bound = load.entries.filter((e) => e.path === want.path && e.section !== undefined);
          if (bound.length > 0) {
            rows.push({ path: want.path, section: null, present: false, matched: 0, revision: null });
            reasons.push(
              `阶段必读 ${want.path} 只有章节绑定条目（section=${bound.map((e) => JSON.stringify(e.section)).join("、")}）；登记未点名 section，不按整文件哈希猜——请显式登记 section`,
            );
            continue;
          }
        }
        rows.push({ path: want.path, section: wantSection, present: hits.length > 0, matched: hits.length, revision: hits[0]?.revision ?? null });
        if (hits.length === 0) {
          reasons.push(`阶段必读缺条目：${label(want.path, wantSection)}`);
          continue;
        }
        if (hits.length > 1) {
          reasons.push(`阶段必读 ${label(want.path, wantSection)} 命中 ${hits.length} 条重复条目（登记不唯一）`);
          continue;
        }
        const e = hits[0] as StageReadEntry;
        if (want.sha256 !== undefined && e.revision !== want.sha256) {
          reasons.push(
            `阶段必读 ${label(want.path, e.section ?? null)} 的 revision 与登记不符（该条目是${e.section === undefined ? "整文件" : "章节子树"}哈希）`,
          );
        }
      }
      const actual = { entries: rows };
      return reasons.length === 0 ? okEval(expected, actual) : bad("missing", expected, actual, reasons);
    }
    case "markdown_section": {
      const expected = { path: check.path, section: check.section, sha256: check.sha256 };
      const r = readTargetFile(check.path, ctx);
      if (!r.ok) return bad(r.verdict, expected, null, [r.reason]);
      // 章节子树哈希（标题行 + 全部后代；代码围栏里的 `#` 不算标题）。章节外改动不影响。
      const d = markdownSectionDigest(r.buf, check.section);
      if (!d.ok) {
        // 非文本/非法选择器 = invalid（目标形状不对）；章节缺失/同级同名重复 = failed（目标内容不再满足契约）。
        const verdict: SyncItemVerdict = d.code === "not_text" || d.code === "bad_selector" ? "invalid" : "failed";
        return bad(verdict, expected, null, [`${check.path} 章节 ${JSON.stringify(check.section)} 拒绝：${d.reason}`]);
      }
      const actual = {
        path: check.path,
        section: d.section.path,
        section_sha256: d.sha256,
        section_lines: [d.section.line_start, d.section.line_end],
      };
      return d.sha256 === check.sha256
        ? okEval(expected, actual)
        : bad("failed", expected, actual, [
            `章节 ${JSON.stringify(check.section)} 子树哈希不符：登记 ${check.sha256.slice(0, 12)}…，当前 ${d.sha256.slice(0, 12)}…（章节内改动即失败；章节外改动不影响）`,
          ]);
    }
    default:
      return bad("invalid", null, null, [`未知 check 类型：${(check as { type: string }).type}`]);
  }
}

export interface BatchEvaluation {
  verdict: SyncVerdict;
  items: SyncItemReport[];
  evidence_sha256: string | null;
  /** 目标指纹（逐项 verdict + actual 的确定性哈希；**不含**任何 sync 事件序号/时间） */
  target_fingerprint: string;
  /**
   * **有界**源/目标指纹（逐项 actual ＋ 来源快照；不含 verdict）。锁内可用图源探针/文件字节/业务投影
   * 重算出**同一值**做复核——不跑 sixGraphsOf 全量，也不信调用方摘要。
   */
  source_fingerprint: string;
  reasons: string[];
  /**
   * P3 / V09-48：只读修复计划要用的**同一份**本次核验事实（不另算）——
   * 契约来源快照（逐条 registered/current）、证据包工件逐条可复用/已失效、图更新态（仅全量模式）。
   * 它们**不参与** target/source 指纹，只是同一次求值的旁路输出。
   */
  source_snapshots: SyncSourceSnapshot[];
  artifact_checks: SyncArtifactCheck[];
  graph_update_state: string | null;
  /** graph_update_state="updating" 时 updating 是否为**唯一**未通过原因（见 `ItemEvaluation.graph_update_sole`） */
  graph_update_sole: boolean;
}

/** 证据包单个工件的本次核验事实（可复用 / 已失效分开列；**同一份** artifactChecks 求值产出，不另读一遍） */
export interface SyncArtifactCheck {
  item_id: string;
  path: string;
  declared_sha256: string;
  /** 当前实际哈希；自引用/不可读为 null（不冒充一致） */
  current_sha256: string | null;
  reusable: boolean;
  problem: string | null;
}

function artifactChecks(item: SyncEvidenceItem, ctx: EvalContext): { problems: string[]; checks: SyncArtifactCheck[] } {
  const problems: string[] = [];
  const checks: SyncArtifactCheck[] = [];
  for (const a of item.artifacts) {
    const push = (current: string | null, reusable: boolean, problem: string | null): void => {
      checks.push({ item_id: item.id, path: a.path, declared_sha256: a.sha256, current_sha256: current, reusable, problem });
      if (problem !== null) problems.push(problem);
    };
    if (isSyncInboxRelativePath(a.path)) {
      push(null, false, `artifact ${a.path} 落在同步收件目录内——收件目录里的东西不能当独立目标（自引用），不放行`);
      continue;
    }
    const r = readTargetFile(a.path, ctx);
    if (!r.ok) {
      push(null, false, `artifact ${a.path} 不可作为证据：${r.reason}`);
      continue;
    }
    const actual = sha256Hex(r.buf);
    if (actual !== a.sha256) {
      push(actual, false, `artifact ${a.path} 哈希不符：登记 ${a.sha256.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…`);
      continue;
    }
    push(actual, true, null);
  }
  return { problems, checks };
}

/** 逐项裁决的总体优先级：invalid > incomplete > stale > missing > needs_review > failed > passed */
function overallOf(verdicts: SyncItemVerdict[]): SyncVerdict {
  const pri: SyncItemVerdict[] = ["invalid", "incomplete", "stale", "missing", "needs_review", "failed"];
  for (const v of pri) if (verdicts.includes(v)) return v;
  return verdicts.every((v) => v === "passed") && verdicts.length > 0 ? "passed" : "failed";
}

const VERDICT_ORDER: SyncVerdict[] = ["passed", "failed", "needs_review", "missing", "stale", "incomplete", "invalid"];
/** 取两个 verdict 里更严重的一个（用于把未知项/来源漂移/collection 不全并入总体） */
function worsen(a: SyncVerdict, b: SyncVerdict): SyncVerdict {
  return VERDICT_ORDER.indexOf(a) >= VERDICT_ORDER.indexOf(b) ? a : b;
}

/**
 * 求一个批次：契约（含登记 seq，用于 at_registration 截点）＋ 证据包（可缺）＋ 当前实际目标。
 * 缺证据包 = 全部必需项 missing；证据包坏 = invalid。
 */
export function evaluateBatch(
  contract: SyncContract,
  registeredSeq: number,
  evidence: { path: string; abs: string } | null,
  ctx: EvalContext,
): BatchEvaluation {
  const reportItems: SyncItemReport[] = [];
  const reasonsAll: string[] = [];
  const artifactChecksAll: SyncArtifactCheck[] = [];
  let graphUpdateState: string | null = null;
  let graphUpdateSole = false;
  let evidenceSha: string | null = null;

  let pkg: SyncEvidencePackage | null = null;
  let evidenceBad: string | null = null;
  if (evidence !== null) {
    let text: string;
    try {
      text = fs.readFileSync(evidence.abs, "utf8");
    } catch (e) {
      evidenceBad = `证据包读不到：${e instanceof Error ? e.message : String(e)}`;
      text = "";
    }
    if (evidenceBad === null) {
      evidenceSha = sha256Hex(Buffer.from(text, "utf8"));
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch (e) {
        evidenceBad = `证据包不是合法 JSON：${e instanceof Error ? e.message : String(e)}`;
        raw = null;
      }
      if (evidenceBad === null) {
        const parsed = parseEvidencePackage(raw, text);
        if (!parsed.ok) evidenceBad = `证据包不合法：${parsed.reasons.join("；")}`;
        else if (parsed.pkg.batch_id !== contract.batch_id) evidenceBad = `证据包 batch_id=${parsed.pkg.batch_id} 与契约 ${contract.batch_id} 不符`;
        else if (parsed.pkg.project_id !== contract.project_id) evidenceBad = `证据包 project_id 与契约不符`;
        else if (!parsed.pkg.completed) evidenceBad = "证据包 completed=false（半成品不算通过）";
        else if (parsed.pkg.contract_sha256 !== sha256ContractCached(contract)) evidenceBad = "证据包的 contract_sha256 与登记契约不符（旧契约/错误批次）";
        else pkg = parsed.pkg;
      }
    }
  }

  const evById = new Map<string, SyncEvidenceItem>((pkg?.items ?? []).map((i) => [i.id, i]));
  const pkgIds = new Set(evById.keys());
  const contractIds = new Set(contract.items.map((i) => i.id));
  const unknownItemIds = new Set<string>();
  for (const extra of pkgIds) {
    if (!contractIds.has(extra)) {
      unknownItemIds.add(extra);
      reasonsAll.push(`证据包多出未登记的 item（整包 invalid，不许只列原因仍判通过）：${extra}`);
    }
  }

  // 来源实核**每次都做**（不只在登记写口）：source 不作为 check 目标时变化也必须 stale。
  // 锁内有界复核时，来源与目标文件**共用同一份** `ctx.byteBudget`（读前按 stat 判界，超界不读、明确失败）。
  const sourceCheck = contractSourceSnapshot(contract, ctx.projectRoot, { byteBudget: ctx.byteBudget });
  for (const p of sourceCheck.problems) reasonsAll.push(p);

  for (const item of contract.items) {
    const ev = evById.get(item.id);
    if (item.required && pkg === null) {
      reportItems.push({ id: item.id, label: item.label, required: true, verdict: evidenceBad === null ? "missing" : "invalid", expected: item.check, actual: null, reasons: [evidenceBad ?? "证据包缺失（本批次还没交付证据）"], artifacts: [] });
      continue;
    }
    if (ev === undefined) {
      reportItems.push({ id: item.id, label: item.label, required: item.required, verdict: "missing", expected: item.check, actual: null, reasons: item.required ? ["必需项在本批次证据包里没列出（缺项点名）"] : ["非必需项未列（如实记 missing）"], artifacts: [] });
      continue;
    }
    const art = artifactChecks(ev, ctx);
    artifactChecksAll.push(...art.checks);
    if (art.problems.length > 0) {
      reportItems.push({ id: item.id, label: item.label, required: item.required, verdict: "invalid", expected: item.check, actual: null, reasons: art.problems, artifacts: ev.artifacts });
      continue;
    }
    if (ev.result !== "passed") {
      reportItems.push({ id: item.id, label: item.label, required: item.required, verdict: ev.result === "failed" ? "failed" : "needs_review", expected: item.check, actual: { claimed: ev.result }, reasons: [`证据包声明本项 result=${ev.result}（passed 只是声明；程序再按契约读实际目标）`], artifacts: ev.artifacts });
      continue;
    }
    const evalRes = evalCheck(item.check, registeredSeq, ctx);
    if (evalRes.graph_update_state !== undefined) {
      graphUpdateState = evalRes.graph_update_state;
      graphUpdateSole = evalRes.graph_update_sole === true;
    }
    reportItems.push({ id: item.id, label: item.label, required: item.required, verdict: evalRes.verdict, expected: evalRes.expected, actual: evalRes.actual, reasons: evalRes.reasons, artifacts: ev.artifacts });
  }

  for (const r of reportItems) if (r.required && r.verdict !== "passed") reasonsAll.push(`必需项 ${r.id}：${r.verdict}（${r.reasons[0] ?? ""}）`);
  let verdict: SyncVerdict = reportItems.some((i) => i.required && i.verdict === "invalid")
    ? "invalid"
    : overallOf(reportItems.filter((i) => i.required).map((i) => i.verdict));
  // 未知项 → 整包 invalid；来源漂移 → 至少 stale（都不能只列原因仍判通过）。
  if (unknownItemIds.size > 0) verdict = worsen(verdict, "invalid");
  if (sourceCheck.problems.length > 0) verdict = worsen(verdict, "stale");
  const fingerprint = crypto
    .createHash("sha256")
    .update(stableStringify(reportItems.map((i) => ({ id: i.id, required: i.required, verdict: i.verdict, actual: i.actual }))))
    .digest("hex");
  const sourceFingerprint = crypto
    .createHash("sha256")
    .update(
      stableStringify({
        sources: sourceCheck.snapshots.map((s) => ({ path: s.path, sha256: s.sha256 })),
        items: reportItems.map((i) => ({ id: i.id, required: i.required, actual: i.actual })),
      }),
    )
    .digest("hex");
  return {
    verdict,
    items: reportItems,
    evidence_sha256: evidenceSha,
    target_fingerprint: fingerprint,
    source_fingerprint: sourceFingerprint,
    reasons: reasonsAll,
    source_snapshots: sourceCheck.snapshots,
    artifact_checks: artifactChecksAll,
    graph_update_state: graphUpdateState,
    graph_update_sole: graphUpdateSole,
  };
}

// 契约哈希唯一实现在 syncContract.ts（本文件不另写一份——同一仓库不留两套判据）
const contractShaCache = new Map<string, string>();
function sha256ContractCached(contract: SyncContract): string {
  const key = stableStringify(contract);
  const hit = contractShaCache.get(key);
  if (hit !== undefined) return hit;
  const v = syncContractSha256(contract);
  contractShaCache.set(key, v);
  return v;
}
