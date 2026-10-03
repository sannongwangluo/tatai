// 任务运行状态投影（PLAN.md V06-03，DESIGN.md §2.6 / §5.4 / §5.8）。
//
// 三件事，边界写清以免"看起来都一样"：
//   ① **canonical 状态** = `work/state.json`，由 `WorkService` 从已提交事件重放出来的快照。
//      本模块**不自己写它**：所有状态变化都当事件提交给唯一写入者（`WorkSubmitter`），
//      由它追加 `events.jsonl` 再投影。这就是 DESIGN.md §2.6 的"唯一写入源 = 事件"。
//   ② **兼容投影** = `.工作台/tasks.json`。它是给还未迁移的读侧（§6.6 过渡接法、界面、
//      旧 MCP 工具）看的**派生文件**，文件里显式带 `projection_of: "work/events.jsonl"` 与 `last_seq`，
//      把它自己标成投影；**绝不把它当事实源**——事实在事件里，删掉它可重放重建。
//      旧写工具（v1）看到这个标记必须**拒写**（见 `hasV2ProjectionMarker`），不能静默按 v1 覆盖。
//   ③ **施工图状态区投影**：把状态写回施工图的「状态」列/「施工备注」段。**默认关闭**，
//      必须显式 `allowRealDocuments: true` 才落盘（本卡不允许改塔台自己的 PLAN.md）；
//      渲染函数是纯函数，可以先在内存里比对再决定要不要写。
//
// 定义与状态严格分离（DESIGN.md §2.6）：本模块只碰状态。定义哈希与定义字段都在 `plan.ts`，
// **任何状态变化都不修改定义哈希**；`TaskState` 里只记"我绑在哪份定义上"（definition_sha256 /
// plan_revision），绑定换了要产生 `task.rebound` 事件，不静默换输入（§5.6）。
import fs from "node:fs";
import path from "node:path";
import { nowIso } from "../time";
import { SCHEMA_VERSION, WorkError, type WorkEvent, type WorkReceipt } from "./types";
import { loadEvents, replayEvents } from "./eventStore";
import { classifyPlanRegions, taskDefinitionHash, type TaskDefinition } from "./plan";
import { assertImportSubmissionReferences, DEFINITION_CHANGE_ID_KEY, DEFINITION_REQUIREMENT_IDS_KEY, importPlanChecked } from "./references";

// ── 状态维度（DESIGN.md §5.4「任务执行」一行） ──

export type TaskExecutionStatus =
  | "preparing"
  | "ready"
  | "claimed"
  | "executing"
  | "result_submitted"
  | "blocked"
  | "cancelled";

export const TASK_EXECUTION_STATUSES: readonly TaskExecutionStatus[] = [
  "preparing",
  "ready",
  "claimed",
  "executing",
  "result_submitted",
  "blocked",
  "cancelled",
];

export const TASK_STATUS_LABELS: Readonly<Record<TaskExecutionStatus, string>> = {
  preparing: "待准备",
  ready: "就绪",
  claimed: "已认领",
  executing: "执行中",
  result_submitted: "结果已提交",
  blocked: "阻塞",
  cancelled: "取消",
};

/**
 * `result_submitted` 的最强含义（DESIGN.md §5.4 / §2.6 硬口径）：
 * **只是执行者已交结果**，不等于审计通过，也不等于人工验收接受。
 * 任何把 v1 `done` 或本状态说成"已交付/已验收"的展示都是错的。
 */
export const RESULT_SUBMITTED_MEANING = "执行者已提交结果；不表示审计通过，也不表示人工验收接受";

/** 本卡登记的 v2 任务事件词表（`docs/work-v2-contract.md` §2 说业务词表由 V06-03/V06-09 登记） */
export const TASK_EVENT_TYPES = [
  "task.definition_imported",
  "task.status_changed",
  "task.claimed",
  "task.result_submitted",
  "task.blocked",
  "task.cancelled",
  "task.rebound",
  // V09-10（附录 F）：协调器受控重开同卡新 attempt
  "task.reopened",
] as const;
export type TaskEventType = (typeof TASK_EVENT_TYPES)[number];

/** 实体 id 约定：`task:<task_id>`（与设计/基线实体分开，投影只吃前缀对的实体） */
export const taskEntityId = (taskId: string): string => `task:${taskId}`;
export const taskIdOfEntity = (entityId: string): string | null =>
  entityId.startsWith("task:") ? entityId.slice("task:".length) : null;

// ── 状态投影 ──

/** 一个任务由**已提交事件**推出的运行状态（纯派生，可全量重放） */
export interface TaskState {
  task_id: string;
  status: TaskExecutionStatus;
  status_label: string;
  /** 取消标记（取消是旁路，单独可判，不与"阻塞"混） */
  cancelled: boolean;
  cancel_reason: string | null;
  blocked_reason: string | null;
  change_id: string | null;
  run_id: string | null;
  attempt_id: string | null;
  owner_id: string | null;
  claim_token: string | null;
  lease_expires_at: string | null;
  /** 状态绑定的施工定义哈希（对齐/待重绑判定用；不含状态，状态变化不改它） */
  definition_sha256: string | null;
  /** 状态绑定时的图纸修订 */
  plan_revision: string | null;
  /** 定义修订号（来自 `task.definition_imported` 的 payload） */
  definition_revision: number | null;
  /**
   * 定义级批次绑定（`task.definition_imported` payload 的 definition_change_id；旧形态事件无此键 = null）。
   * 定义哈希把绑定揉进 canonical（plan.ts：definition_change_id 进定义哈希，两个事实各自如实保留），
   * 读侧重解析不带绑定——对齐/回执要复算哈希时必须**回放**这个值，否则带 bind 的导入会被误判待重绑。
   */
  definition_change_id: string | null;
  /**
   * 定义级需求映射（`task.definition_imported` payload 的 requirement_ids；旧形态事件没有这个键 = 未记录）。
   * 需求映射同样进定义哈希 canonical（`shared/planCardHash.ts`：`requirement_ids` 是 canonical 的键），
   * 读侧现解析的定义在**施工图没有需求映射表**时是 null——对齐时若不回放就会把这张刚经工具参数映射
   * 导入的卡误判 `needs_rebind`（V09-29 集成发现 F-2）。回放口径与 `definition_change_id` 一致：
   * 绑定事实随事件携带，读侧按状态回放，两个事实不互相覆盖。
   */
  definition_requirement_ids?: string[] | null;
  /** 事件实体版本（1 起） */
  revision: number;
  /**
   * 当前 attempt 序号（V09-10；`task.claimed`/`task.reopened` 的 payload 带入）。
   * 没有事件给过 attempt 时为 null（= 还没被认领过）。
   */
  attempt: number | null;
  /**
   * 最近一次协调器重开的留痕（V09-10／附录 F；未重开过为 null）：
   * 新 attempt 的标识、返工理由、可取回依据与**上一提交引用**（previous_result 指回旧
   * `task.result_submitted` 事件——历史提交与证据永久保留，这里只存指针链）。
   */
  last_reopen: {
    attempt: number;
    run_id: string;
    attempt_id: string;
    workspace: string;
    reason: string;
    reopen_basis: string[];
    previous_result: { seq: number; event_id: string; run_id: string | null; attempt_id: string | null };
  } | null;
  /** 该实体最后一条事件的提交序号 */
  seq: number;
  last_event_id: string;
  /** 最后一条事件的接收时间（派生，从不进定义哈希） */
  updated_at: string;
  /** 最后一次推进者 */
  last_actor: string;
}

export interface TaskProjection {
  states: Record<string, TaskState>;
  last_seq: number;
  /** 事件里出现但不算任务实体的实体（如设计/基线），如实报出便于排查 */
  ignored_entities: string[];
}

function badEvent(message: string, detail: Record<string, unknown> = {}): never {
  throw new WorkError("EVENT_INVALID", `任务事件不合法：${message}`, detail);
}

function assertStatus(value: unknown, event: WorkEvent): TaskExecutionStatus {
  if (typeof value !== "string" || !TASK_EXECUTION_STATUSES.includes(value as TaskExecutionStatus)) {
    badEvent(
      `payload.status 必须是 ${TASK_EXECUTION_STATUSES.join("/")} 之一，收到 ${JSON.stringify(value)}` +
        `（事件 ${event.event_id}）`,
      { event_id: event.event_id, status: value },
    );
  }
  return value as TaskExecutionStatus;
}

const strOrNull = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/** 事件里的需求映射回放口径：null / 非字符串数组一律归一为 null（写侧已在服务边界校验形态） */
const strListOrNull = (v: unknown): string[] | null =>
  Array.isArray(v) && v.every((x) => typeof x === "string" && x !== "") ? [...(v as string[])] : null;

/** task.reopened 的 payload 闭键（V09-10／附录 F；多一个键少一个键都拒——读侧 fail-closed，写侧同闸） */
export const REOPEN_PAYLOAD_KEYS = [
  "attempt",
  "run_id",
  "attempt_id",
  "workspace",
  "reason",
  "reopen_basis",
  "previous_result",
  "definition_sha256",
  "baseline_id",
] as const;

export interface ReopenPayload {
  attempt: number;
  run_id: string;
  attempt_id: string;
  workspace: string;
  reason: string;
  reopen_basis: string[];
  previous_result: { seq: number; event_id: string; run_id: string | null; attempt_id: string | null };
  definition_sha256: string | null;
  baseline_id: string | null;
}

/**
 * task.reopened 的 payload 结构校验（**闭键**：键集必须恰好是 REOPEN_PAYLOAD_KEYS）。
 * 折叠（读侧重放）与写侧门禁共用这一份——坏事件绝不能进事件流（进了回放会当场抛 EVENT_INVALID）。
 */
export function assertReopenPayload(p: Record<string, unknown>, event?: { event_id: string }): ReopenPayload {
  const where = event === undefined ? "task.reopened 命令" : `事件 ${event.event_id}`;
  const bad = (message: string, detail: Record<string, unknown> = {}): never =>
    badEvent(`task.reopened payload 不合法（${where}）：${message}`, detail);
  const keys = Object.keys(p).sort();
  const want: string[] = [...REOPEN_PAYLOAD_KEYS].sort();
  const extra = keys.filter((k) => !want.includes(k));
  const missing = want.filter((k) => !keys.includes(k));
  if (extra.length > 0 || missing.length > 0) {
    bad(`闭键不符（多 ${extra.join("、") || "无"}／缺 ${missing.join("、") || "无"}）`, { extra, missing });
  }
  if (typeof p.attempt !== "number" || !Number.isInteger(p.attempt) || p.attempt < 1) {
    bad(`attempt 必须是 ≥1 的整数（收到 ${JSON.stringify(p.attempt)}）`);
  }
  for (const k of ["run_id", "attempt_id", "workspace", "reason"] as const) {
    if (typeof p[k] !== "string" || (p[k] as string).trim() === "") bad(`${k} 必须是非空字符串`);
  }
  if (!Array.isArray(p.reopen_basis) || p.reopen_basis.length === 0 || p.reopen_basis.some((b) => typeof b !== "string" || (b as string).trim() === "")) {
    bad("reopen_basis 必须是非空字符串数组（至少一条可取回的授权依据；取不回即拒）");
  }
  const prev = p.previous_result;
  if (typeof prev !== "object" || prev === null || Array.isArray(prev)) bad("previous_result 必须是对象");
  const pr = prev as Record<string, unknown>;
  const prevKeys = Object.keys(pr).sort();
  if (prevKeys.join(",") !== "attempt_id,event_id,run_id,seq") {
    bad(`previous_result 闭键不符（必须是 seq/event_id/run_id/attempt_id，收到 ${prevKeys.join("、")}）`);
  }
  if (typeof pr.seq !== "number" || !Number.isInteger(pr.seq) || pr.seq < 1) bad("previous_result.seq 必须是 ≥1 的整数");
  if (typeof pr.event_id !== "string" || pr.event_id === "") bad("previous_result.event_id 必须是非空字符串");
  if (pr.run_id !== null && typeof pr.run_id !== "string") bad("previous_result.run_id 必须是字符串或 null");
  if (pr.attempt_id !== null && typeof pr.attempt_id !== "string") bad("previous_result.attempt_id 必须是字符串或 null");
  if (p.definition_sha256 !== null && typeof p.definition_sha256 !== "string") bad("definition_sha256 必须是字符串或 null");
  if (p.baseline_id !== null && typeof p.baseline_id !== "string") bad("baseline_id 必须是字符串或 null");
  return {
    attempt: p.attempt as number,
    run_id: (p.run_id as string).trim(),
    attempt_id: (p.attempt_id as string).trim(),
    workspace: (p.workspace as string).trim(),
    reason: (p.reason as string).trim(),
    reopen_basis: (p.reopen_basis as string[]).map((b) => b.trim()),
    previous_result: {
      seq: pr.seq as number,
      event_id: pr.event_id as string,
      run_id: (pr.run_id as string | null) ?? null,
      attempt_id: (pr.attempt_id as string | null) ?? null,
    },
    definition_sha256: (p.definition_sha256 as string | null) ?? null,
    baseline_id: (p.baseline_id as string | null) ?? null,
  };
}

/**
 * 从事件重放任务状态（纯函数）。
 * 口径：`task.definition_imported` / `task.rebound` 只刷新**定义绑定**，不动执行状态
 * （定义导入不是"开始施工"；DESIGN.md §2.6 说"不能把生成任务列表当已获执行许可"）。
 */
export function foldTaskStates(events: WorkEvent[]): TaskProjection {
  const states: Record<string, TaskState> = {};
  const ignored = new Set<string>();
  // 先跑一遍结构性重放（seq 无洞 / revision 连续 / 幂等键唯一），坏现场绝不静默跳过
  const { last_seq } = replayEvents(events);

  for (const e of events) {
    const taskId = taskIdOfEntity(e.entity_id);
    if (taskId === null) {
      ignored.add(e.entity_id);
      continue;
    }
    if (taskId === "") badEvent(`实体 id 缺 task_id（事件 ${e.event_id}）`, { event_id: e.event_id });
    if (!(TASK_EVENT_TYPES as readonly string[]).includes(e.type)) {
      badEvent(`未知任务事件类型 ${JSON.stringify(e.type)}（事件 ${e.event_id}）`, {
        event_id: e.event_id,
        type: e.type,
      });
    }
    const prev: TaskState =
      states[taskId] ??
      {
        task_id: taskId,
        status: "preparing",
        status_label: TASK_STATUS_LABELS.preparing,
        cancelled: false,
        cancel_reason: null,
        blocked_reason: null,
        change_id: null,
        run_id: null,
        attempt_id: null,
        owner_id: null,
        claim_token: null,
        lease_expires_at: null,
        definition_sha256: null,
        plan_revision: null,
        definition_revision: null,
        definition_change_id: null,
        revision: 0,
        attempt: null,
        last_reopen: null,
        seq: 0,
        last_event_id: "",
        updated_at: "",
        last_actor: "",
      };
    const next: TaskState = {
      ...prev,
      change_id: e.change_id,
      revision: e.entity_revision,
      seq: e.seq,
      last_event_id: e.event_id,
      updated_at: e.received_at,
      last_actor: e.actor_id,
    };
    const p = e.payload;
    switch (e.type as TaskEventType) {
      case "task.definition_imported": {
        next.definition_sha256 = strOrNull(p.definition_sha256) ?? next.definition_sha256;
        next.plan_revision = strOrNull(p.plan_revision) ?? next.plan_revision;
        next.definition_revision =
          typeof p.definition_revision === "number" ? p.definition_revision : next.definition_revision;
        // 定义级批次绑定随事件携带（C-015 新形态）：键在就按事件如实刷新——显式 null = 本次导入
        // 声明"无绑定"（重导不带 bind 时不能残留上一版的绑定，否则读侧回放会用错批次算哈希）；
        // 键不在 = 旧形态事件，保持原值（与导入时"不带 bind 算出的裸哈希"口径一致）
        if (DEFINITION_CHANGE_ID_KEY in p) {
          next.definition_change_id = strOrNull(p[DEFINITION_CHANGE_ID_KEY]);
        }
        // 需求映射与 change_id 同一形态：键在就按事件如实刷新（显式 null = 本次导入声明"无映射"，
        // 重导不带映射时不能残留上一版）；键不在 = 旧形态事件，保持原值。回放值供对齐复算哈希。
        if (DEFINITION_REQUIREMENT_IDS_KEY in p) {
          next.definition_requirement_ids = strListOrNull(p[DEFINITION_REQUIREMENT_IDS_KEY]);
        }
        break;
      }
      case "task.rebound": {
        next.definition_sha256 = strOrNull(p.to_definition_sha256) ?? next.definition_sha256;
        next.plan_revision = strOrNull(p.to_plan_revision) ?? next.plan_revision;
        next.definition_revision =
          typeof p.to_definition_revision === "number" ? p.to_definition_revision : next.definition_revision;
        // 重绑绑到的是**当前施工图的定义**（submitTaskRebind 对现解析定义算哈希，不带旧绑定），
        // 旧的定义级批次绑定与需求映射对新定义不再成立——归空，读侧回放才不会拿旧值算错哈希（V07-02）
        next.definition_change_id = null;
        next.definition_requirement_ids = null;
        break;
      }
      case "task.reopened": {
        // V09-10（附录 F）：协调器受控重开——任务回到可认领态（ready）、attempt 取事件值、
        // 旧认领当场作废（token/持有者/租约清空 ⇒ 提交校验只认新 attempt 的 token，旧 token 必拒）、
        // 返工理由与上一提交引用留痕。旧 result_submitted 事件与旧证据**原样在册**（历史只读）。
        const rp = assertReopenPayload(p, e);
        next.status = "ready";
        next.status_label = TASK_STATUS_LABELS.ready;
        next.owner_id = null;
        next.claim_token = null;
        next.lease_expires_at = null;
        next.blocked_reason = null;
        next.run_id = rp.run_id;
        next.attempt_id = rp.attempt_id;
        next.attempt = rp.attempt;
        next.last_reopen = {
          attempt: rp.attempt,
          run_id: rp.run_id,
          attempt_id: rp.attempt_id,
          workspace: rp.workspace,
          reason: rp.reason,
          reopen_basis: rp.reopen_basis,
          previous_result: rp.previous_result,
        };
        break;
      }
      case "task.status_changed": {
        const status = assertStatus(p.status, e);
        next.status = status;
        next.status_label = TASK_STATUS_LABELS[status];
        next.cancelled = status === "cancelled" || next.cancelled;
        if (status === "cancelled") next.cancel_reason = strOrNull(p.reason) ?? next.cancel_reason;
        break;
      }
      case "task.claimed": {
        next.status = "claimed";
        next.status_label = TASK_STATUS_LABELS.claimed;
        next.run_id = strOrNull(p.run_id) ?? next.run_id;
        next.attempt_id = strOrNull(p.attempt_id) ?? next.attempt_id;
        next.owner_id = strOrNull(p.owner_id) ?? next.owner_id;
        next.claim_token = strOrNull(p.claim_token) ?? next.claim_token;
        next.lease_expires_at = strOrNull(p.lease_expires_at) ?? next.lease_expires_at;
        // V09-10：attempt 序号入状态（重开后的认领要能沿用重开宣告的 attempt）
        if (typeof p.attempt === "number" && Number.isInteger(p.attempt) && p.attempt >= 1) next.attempt = p.attempt;
        break;
      }
      case "task.result_submitted": {
        next.status = "result_submitted";
        next.status_label = TASK_STATUS_LABELS.result_submitted;
        break;
      }
      case "task.blocked": {
        next.status = "blocked";
        next.status_label = TASK_STATUS_LABELS.blocked;
        next.blocked_reason = strOrNull(p.reason) ?? next.blocked_reason;
        break;
      }
      case "task.cancelled": {
        next.status = "cancelled";
        next.status_label = TASK_STATUS_LABELS.cancelled;
        next.cancelled = true;
        next.cancel_reason = strOrNull(p.reason) ?? next.cancel_reason;
        break;
      }
      default:
        break;
    }
    // 取消是一条旁路：任何后续事件都不能悄悄把它变回"在做"（要恢复请显式换新任务/新批次）
    if (prev.cancelled && !next.cancelled && e.type !== "task.rebound") {
      badEvent(`已取消的任务 ${taskId} 被 ${e.type} 改回非取消状态（事件 ${e.event_id}）`, {
        event_id: e.event_id,
        task_id: taskId,
      });
    }
    states[taskId] = next;
  }
  return { states, last_seq, ignored_entities: [...ignored].sort() };
}

/**
 * 从磁盘事件文件读并折叠出任务状态（读路径；中段损坏会抛，不吞）。
 * `events` 给定时直接折叠这份**同一 workDir 的**现读快照，不再读盘——来源一致性由调用方保证
 * （见 `statusProjection.EventsSnapshot`／`eventsOfSnapshot`）；缺省仍现读，行为不变。
 */
export function readTaskStates(workDir: string, events?: WorkEvent[]): TaskProjection {
  return foldTaskStates(events ?? loadEvents(workDir).events);
}

/** 写侧门禁拒因（`service.submit` 的 detail.reason；与 `claims.claimTask` 同一判据） */
export const BLOCKED_NOT_CLAIMABLE_DETAIL_REASON = "blocked_not_claimable";

/** 单张卡在事件流里的当前执行状态快照（只读、纯函数） */
export interface TaskStatusSnapshot {
  status: TaskExecutionStatus;
  /** 取消是旁路：一旦被取消就保持取消（与 `foldTaskStates` 的"不许被改回非取消"同口径） */
  cancelled: boolean;
  /** 阻塞理由（`task.blocked` 的 payload.reason；没有就 null，不编造） */
  blocked_reason: string | null;
}

/**
 * 单张卡在**已提交事件流**里的当前执行状态（与 `foldTaskStates` 同一口径；实体不是任务实体、
 * 或该实体一条事件都没有 → null）。抽出来是给**写侧门禁**用：`service.submit` 必须在文件锁里判
 * "这张卡是不是阻塞态"——直连通用写口手写 `task.claimed` 不能绕过 `claims.claimTask` 的阻塞门禁。
 */
export function taskStatusOfEvents(
  events: readonly WorkEvent[],
  entityId: string,
): TaskStatusSnapshot | null {
  let status: TaskExecutionStatus | null = null;
  let cancelled = false;
  let blockedReason: string | null = null;
  for (const e of events) {
    if (e.entity_id !== entityId) continue;
    const p = e.payload ?? {};
    switch (e.type as TaskEventType) {
      case "task.definition_imported":
      case "task.rebound":
        status ??= "preparing";
        break;
      case "task.reopened":
        status = "ready";
        blockedReason = null;
        break;
      case "task.status_changed": {
        const next = strOrNull(p.status);
        if (next !== null && (TASK_EXECUTION_STATUSES as readonly string[]).includes(next)) {
          status = next as TaskExecutionStatus;
        }
        if (next === "cancelled") cancelled = true;
        break;
      }
      case "task.claimed":
        status = "claimed";
        break;
      case "task.result_submitted":
        status = "result_submitted";
        break;
      case "task.blocked":
        status = "blocked";
        blockedReason = strOrNull(p.reason) ?? blockedReason;
        break;
      case "task.cancelled":
        status = "cancelled";
        cancelled = true;
        break;
      default:
        break;
    }
  }
  if (status === null) return null;
  return { status: cancelled ? "cancelled" : status, cancelled, blocked_reason: blockedReason };
}

// ── 定义 ↔ 状态对齐（"PLAN 与运行任务同源"） ──

export interface TaskRebindNeeded {
  task_id: string;
  bound_definition_sha256: string | null;
  current_definition_sha256: string;
  detail: string;
}

export interface TaskAlignment {
  /** 运行状态对不上任何当前定义（不同源，必须处理） */
  orphan_states: { task_id: string; reason: string }[];
  /** 定义内容变了、状态还绑在旧定义上 → **待重绑**（不静默换输入，§5.6） */
  needs_rebind: TaskRebindNeeded[];
  /** 图纸修订变了但该定义内容未变（绑定修订号过期，仅登记） */
  revision_stale: string[];
  /** 有定义但还没有任何运行状态 */
  not_started: string[];
  /** true = 每个运行状态都对得上当前定义且绑定未过期 */
  same_source: boolean;
}

/**
 * 对齐当前施工定义与运行状态（卡内检查项 3 的"PLAN 与运行任务同源"）。
 *
 * 判据：
 *   · 运行状态（事件推出）里的每个 task_id 都能在当前定义里找到 → 否则 `orphan_states`；
 *   · 运行状态绑的 `definition_sha256` 等于当前定义哈希 → 否则 `needs_rebind`；
 *   · 绑定修订（plan_revision）与当前图纸修订一致 → 否则登记 `revision_stale`
 *     （定义内容没变就不算重绑，只是"指向的修订号旧了"）。
 */
export function alignDefinitionsAndStates(
  definitions: TaskDefinition[],
  states: Record<string, TaskState>,
  currentPlanRevision: string,
): TaskAlignment {
  const byKey = new Map(definitions.map((d) => [d.stable_key, d]));
  const orphan_states: { task_id: string; reason: string }[] = [];
  const needs_rebind: TaskRebindNeeded[] = [];
  const revision_stale: string[] = [];
  const seenKeys = new Set<string>();

  for (const state of Object.values(states)) {
    const def = byKey.get(state.task_id.trim().toUpperCase());
    if (def === undefined) {
      orphan_states.push({
        task_id: state.task_id,
        reason: "运行状态存在，但当前施工定义里没有这个卡号（施工任务必须来自施工图，不能凭空开工）",
      });
      continue;
    }
    seenKeys.add(def.stable_key);
    // 回放定义级引用元数据再算哈希：定义哈希把 change_id 与 requirement_ids 都揉进 canonical
    // （`shared/planCardHash.ts`），现解析的定义在施工图**没有**这两张表时不带这些绑定——直接比会把
    // "带 bind_change_id 导入"（2026-09-21 自举实测缺陷）与"经工具参数做施工图外需求映射导入"
    // （V09-29 集成发现 F-2）的任务全部误判 needs_rebind。绑定事实在事件 payload 里，读侧按状态回放。
    //
    // 需求映射再叠一层"文档优先"：施工图**当前**解析出的 `requirement_ids`（需求映射表）非空时以它
    // 为准——文档改稿带来的真实变化仍要判重绑，**不**用"忽略需求映射"把真实改稿掩盖过去；只有文档
    // 给不出映射（null）时才回放事件里记录的工具外映射。
    const currentHash = taskDefinitionHash({
      ...def,
      change_id: state.definition_change_id,
      requirement_ids: def.requirement_ids ?? state.definition_requirement_ids ?? null,
    });
    if (state.definition_sha256 !== currentHash) {
      needs_rebind.push({
        task_id: def.task_id,
        bound_definition_sha256: state.definition_sha256,
        current_definition_sha256: currentHash,
        detail:
          state.definition_sha256 === null
            ? "该任务的状态没有绑定过施工定义修订（缺 task.definition_imported）"
            : "施工定义内容变了：本任务待重绑到新定义修订，并给出继续/调整/暂停处置（§5.6）",
      });
      continue;
    }
    if (state.plan_revision !== currentPlanRevision) {
      revision_stale.push(def.task_id);
    }
  }
  const not_started = definitions
    .filter((d) => !seenKeys.has(d.stable_key))
    .map((d) => d.task_id)
    .sort();
  return {
    orphan_states: orphan_states.sort((a, b) => a.task_id.localeCompare(b.task_id)),
    needs_rebind: needs_rebind.sort((a, b) => a.task_id.localeCompare(b.task_id)),
    revision_stale: revision_stale.sort(),
    not_started,
    same_source: orphan_states.length === 0 && needs_rebind.length === 0,
  };
}

/** 从图纸原文现算一遍定义与对齐（便捷入口：读侧不必自己拼 import + fold） */
export function alignPlanWithWork(
  planText: string,
  workDir: string,
  planRevision?: string,
): { definitions: TaskDefinition[]; projection: TaskProjection; alignment: TaskAlignment } {
  // 走受检导入（C-015 接线）：正式读侧路径与 importPlanChecked 同一入口——
  // 引用悬空在这里就点名拒，不会"导入照常、事后才发现对不上"；
  // 旧图纸（定义全不带引用）校验一条都不查，行为与裸导入逐字节一致
  const imported = importPlanChecked(planText, workDir, { plan_revision: planRevision });
  const projection = readTaskStates(workDir);
  return {
    definitions: imported.definitions,
    projection,
    alignment: alignDefinitionsAndStates(
      imported.definitions,
      projection.states,
      imported.definitions[0]?.plan_revision ?? "",
    ),
  };
}

// ── 状态写入（唯一写入者：提交事件，不绕开） ──

/** 唯一写入者的最小接口（`WorkService.submit` 与转接客户端都满足；本模块不自己写事件文件） */
export interface WorkSubmitter {
  submit(command: unknown): WorkReceipt;
}

export interface TaskEventInput {
  project_id: string;
  task_id: string;
  change_id: string;
  actor_id: string;
  role: string;
  /** 期望的实体版本（乐观并发）：调 `readTaskStates` 拿 `revision`；null = 期望还不存在 */
  expected_revision: number | null;
  type: TaskEventType;
  payload?: Record<string, unknown>;
  occurred_at?: string;
}

/** 幂等键：调用方给的批次 + 实体 + 事件序号位（同键同内容才返回原回执，见 v2 契约） */
export function taskEventIdempotencyKey(input: TaskEventInput): string {
  const rev = input.expected_revision === null ? 0 : input.expected_revision;
  return `${input.task_id}:${input.type}:${rev + 1}:${input.change_id}`;
}

/** 提交一条任务事件给唯一写入者（canonical 状态由它投影到 `work/state.json`） */
export function submitTaskEvent(submitter: WorkSubmitter, input: TaskEventInput): WorkReceipt {
  return submitter.submit({
    schema_version: SCHEMA_VERSION,
    project_id: input.project_id,
    change_id: input.change_id,
    entity_id: taskEntityId(input.task_id),
    expected_revision: input.expected_revision,
    type: input.type,
    actor_id: input.actor_id,
    role: input.role,
    idempotency_key: taskEventIdempotencyKey(input),
    ...(input.occurred_at === undefined ? {} : { occurred_at: input.occurred_at }),
    payload: input.payload ?? {},
  });
}

export interface TaskStatusChangeInput {
  project_id: string;
  task_id: string;
  change_id: string;
  actor_id: string;
  role: string;
  expected_revision: number | null;
  status: TaskExecutionStatus;
  reason?: string;
  /** 状态绑定的定义（提交时把 definition_sha256/plan_revision 一并带上，便于事后对齐） */
  definition?: { definition_sha256: string; plan_revision: string; definition_revision?: number } | null;
}

/** 改任务执行状态（canonical 路径：提交事件 → 唯一写入者投影） */
export function submitTaskStatus(submitter: WorkSubmitter, input: TaskStatusChangeInput): WorkReceipt {
  const type: TaskEventType =
    input.status === "result_submitted"
      ? "task.result_submitted"
      : input.status === "blocked"
        ? "task.blocked"
        : input.status === "cancelled"
          ? "task.cancelled"
          : "task.status_changed";
  const payload: Record<string, unknown> = {};
  if (type === "task.status_changed") payload.status = input.status;
  if (input.reason !== undefined) payload.reason = input.reason;
  if (input.definition) {
    payload.definition_sha256 = input.definition.definition_sha256;
    payload.plan_revision = input.definition.plan_revision;
    if (input.definition.definition_revision !== undefined) {
      payload.definition_revision = input.definition.definition_revision;
    }
  }
  return submitTaskEvent(submitter, { ...input, type, payload });
}

/** 导入施工定义修订：逐条提交 `task.definition_imported`（不改变执行状态） */
export function submitDefinitionImports(
  submitter: WorkSubmitter,
  input: {
    project_id: string;
    change_id: string;
    actor_id: string;
    role: string;
    definitions: TaskDefinition[];
    /** 每个任务的当前实体版本（缺省 = null，表示期望新建） */
    expected_revisions?: Readonly<Record<string, number | null>>;
  },
): WorkReceipt[] {
  // C-015 接线：引用校验挂在**真实写口**上（不是只挂在没人调用的包装上）。
  // 带悬空需求/变更引用的定义在这里就拒——一个事件都不写（在动磁盘之前抛，§2.6）；
  // 定义全不带引用（旧数据路径）时这一步一条都不查，既有调用方行为零改动
  assertImportSubmissionReferences(submitter, input.definitions, "施工定义导入提交");
  const receipts: WorkReceipt[] = [];
  for (const def of input.definitions) {
    const expected = input.expected_revisions?.[def.task_id] ?? null;
    const revision = def.revision;
    if (revision > 1 && expected === null) {
      throw new WorkError(
        "INVALID_COMMAND",
        `任务 ${def.task_id} 的定义修订号是 ${revision}，但调用方说"该实体尚不存在"（expected_revision=null）——` +
          "重导已有任务必须给出当前实体版本，否则会造出第二条定义链",
        { task_id: def.task_id, revision },
      );
    }
    receipts.push(
      submitTaskEvent(submitter, {
        project_id: input.project_id,
        task_id: def.task_id,
        change_id: input.change_id,
        actor_id: input.actor_id,
        role: input.role,
        expected_revision: expected,
        type: "task.definition_imported",
        payload: {
          definition_sha256: taskDefinitionHash(def),
          plan_revision: def.plan_revision ?? "",
          definition_revision: revision,
          // C-015 复核返修（§2.5 一致校验面）：引用元数据随事件携带——唯一写入服务在追加前
          // 据此从同一 events 现场核验，不能只在包装层先验后把事实丢掉。显式 null = 本定义
          // 如实声明"无引用"（新形态可判），与历史事件"没有这两个键"（旧形态，服务不查）区分。
          // 信封 change_id 是本次写入的归因批次，definition_change_id 是定义自身绑定的批次
          // （进定义哈希），两个事实各自如实保留，不互相覆盖。
          [DEFINITION_REQUIREMENT_IDS_KEY]: def.requirement_ids ?? null,
          [DEFINITION_CHANGE_ID_KEY]: def.change_id ?? null,
        },
      }),
    );
  }
  return receipts;
}

/** 重绑（§5.6：可追溯修订，不静默换输入） */
export function submitTaskRebind(
  submitter: WorkSubmitter,
  input: {
    project_id: string;
    task_id: string;
    change_id: string;
    actor_id: string;
    role: string;
    expected_revision: number;
    from_definition_sha256: string | null;
    definition: TaskDefinition;
    /** 已有 run 的处置（继续/调整/暂停），如实记入事件 */
    disposition: "continue" | "adjust" | "pause";
  },
): WorkReceipt {
  return submitTaskEvent(submitter, {
    project_id: input.project_id,
    task_id: input.task_id,
    change_id: input.change_id,
    actor_id: input.actor_id,
    role: input.role,
    expected_revision: input.expected_revision,
    type: "task.rebound",
    payload: {
      from_definition_sha256: input.from_definition_sha256,
      to_definition_sha256: taskDefinitionHash(input.definition),
      to_plan_revision: input.definition.plan_revision ?? "",
      to_definition_revision: input.definition.revision,
      disposition: input.disposition,
    },
  });
}

// ── 兼容投影写回 `.工作台/tasks.json` ──

export type V1TaskStatus = "todo" | "doing" | "done" | "blocked";

/** 兼容投影的标记字段名：文件里带它 = 这是投影，不是事实源 */
export const V2_PROJECTION_MARKER = "projection_of";
/** 投影来源（canonical 事实 = 事件文件） */
export const V2_PROJECTION_OF = "work/events.jsonl";

/** 兼容投影的语义声明（防止有人把 v1 `done` 读成"已交付/已验收"） */
export const COMPAT_STATUS_SEMANTICS =
  "本文件是 work/events.jsonl 的兼容投影（只读派生，可重放重建），不是事实源；" +
  "status 为 v1 四态最弱含义：done = 执行者已提交结果，不代表审计通过或人工验收接受（DESIGN.md §5.4）";

/** v2 执行状态 → v1 四态（§5.4 映射的反向兼容读法） */
export function v1StatusOf(status: TaskExecutionStatus): V1TaskStatus {
  switch (status) {
    case "preparing":
    case "ready":
      return "todo";
    case "claimed":
    case "executing":
      return "doing";
    case "result_submitted":
      return "done";
    case "blocked":
      return "blocked";
    case "cancelled":
      // 取消在 v1 四态里没有位置：按"不再推进的待办"落 todo，并单独带 cancelled 标记
      return "todo";
  }
}

export interface CompatTaskRecord {
  id: string;
  title: string;
  module_id: string;
  status: V1TaskStatus;
  reporter: string;
  updated_at: string;
  note?: string;
  /** v2 派生的真状态（读侧要看细粒度状态读这个，别猜 v1 四态） */
  v2_status: TaskExecutionStatus;
  v2_status_label: string;
  cancelled: boolean;
  /** 状态绑定的定义哈希与图纸修订（对齐/重绑判定用） */
  definition_sha256: string | null;
  plan_revision: string | null;
}

export interface CompatTasksFile {
  version: 1;
  [V2_PROJECTION_MARKER]: string;
  last_seq: number;
  generated_at: string;
  status_semantics: string;
  tasks: CompatTaskRecord[];
}

/** 文件对象是不是 v2 兼容投影（旧写工具据此**拒写**） */
export function hasV2ProjectionMarker(raw: unknown): boolean {
  if (typeof raw !== "object" || raw === null) return false;
  const marker = (raw as Record<string, unknown>)[V2_PROJECTION_MARKER];
  return typeof marker === "string" && marker !== "";
}

/** 兼容投影的字段顺序（稳定：v1 四字段在前，v2 补充在后；重放两次结果逐字节相同） */
function compatRecordOrder(record: CompatTaskRecord): CompatTaskRecord {
  return {
    id: record.id,
    title: record.title,
    module_id: record.module_id,
    status: record.status,
    reporter: record.reporter,
    updated_at: record.updated_at,
    ...(record.note === undefined ? {} : { note: record.note }),
    v2_status: record.v2_status,
    v2_status_label: record.v2_status_label,
    cancelled: record.cancelled,
    definition_sha256: record.definition_sha256,
    plan_revision: record.plan_revision,
  };
}

export interface CompatProjectionInput {
  states: Record<string, TaskState>;
  /** `.工作台/tasks.json` 的**现有**内容（保留 v1 台账里的 title/module_id/note，不丢用户数据） */
  previous?: { tasks?: { id?: unknown; title?: unknown; module_id?: unknown; reporter?: unknown; note?: unknown }[] } | null;
  /** 定义（给出时用 goal 兜底 title、并按稳定键对齐任务 id 大小写） */
  definitions?: TaskDefinition[];
  last_seq: number;
  generated_at?: string;
}

/**
 * 构造兼容投影（纯函数，便于断言"同一份事件重放出逐字节相同的文件"）。
 * 保留口径：`title` / `module_id` / `note` 优先沿用旧台账里的值（用户/施工者填的不丢），
 * 只有旧台账没有时才用定义的目标兜底；`reporter` 取最后一条事件的 actor。
 */
export function buildCompatTasksProjection(input: CompatProjectionInput): CompatTasksFile {
  const defsByKey = new Map((input.definitions ?? []).map((d) => [d.stable_key, d]));
  const prevById = new Map(
    (input.previous?.tasks ?? []).map((t) => [String(t.id ?? ""), t]),
  );
  const tasks: CompatTaskRecord[] = Object.values(input.states)
    .sort((a, b) => a.task_id.localeCompare(b.task_id))
    .map((state) => {
      const prev = prevById.get(state.task_id) ?? prevById.get(state.task_id.toUpperCase()) ?? null;
      const def = defsByKey.get(state.task_id.trim().toUpperCase()) ?? null;
      const title =
        typeof prev?.title === "string" && prev.title !== ""
          ? prev.title
          : (def?.goal ?? state.task_id);
      const moduleId = typeof prev?.module_id === "string" ? prev.module_id : "";
      const note =
        typeof prev?.note === "string" && prev.note !== ""
          ? prev.note
          : state.cancelled
            ? (state.cancel_reason ?? "已取消")
            : state.status === "blocked"
              ? (state.blocked_reason ?? undefined)
              : undefined;
      return compatRecordOrder({
        id: state.task_id,
        title,
        module_id: moduleId,
        status: v1StatusOf(state.status),
        reporter: state.last_actor || "unknown",
        updated_at: state.updated_at,
        ...(note === undefined ? {} : { note }),
        v2_status: state.status,
        v2_status_label: state.status_label,
        cancelled: state.cancelled,
        definition_sha256: state.definition_sha256,
        plan_revision: state.plan_revision,
      });
    });
  return {
    version: 1,
    [V2_PROJECTION_MARKER]: V2_PROJECTION_OF,
    last_seq: input.last_seq,
    generated_at: input.generated_at ?? nowIso(),
    status_semantics: COMPAT_STATUS_SEMANTICS,
    tasks,
  };
}

/** 原子写投影文件（先写临时文件再 rename，防半截；投影是派生数据，可重放重建） */
export function writeCompatTasksProjection(file: string, projection: CompatTasksFile): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(projection, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);
}

/** 读兼容投影（不是投影就返回 null；坏 JSON 抛错不静默） */
export function readCompatTasksProjection(file: string): CompatTasksFile | null {
  if (!fs.existsSync(file)) return null;
  const raw: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!hasV2ProjectionMarker(raw)) return null;
  return raw as CompatTasksFile;
}

// ── 施工图状态区投影（默认关闭；本卡不允许改塔台自己的 PLAN.md） ──

/** 施工图「状态」列的投影值（人话：v1 四态对应的现行执行状态） */
export function planStatusCell(state: TaskState): string {
  if (state.cancelled) return `已取消（${state.cancel_reason ?? "无原因记录"}）`;
  return state.status_label;
}

export interface PlanStatusProjection {
  /** 更新后的原文 */
  text: string;
  /** 改动了哪些卡号（状态列） */
  changed: string[];
  /** 表头里有没有「状态」列（没有则没法投影，如实报 false） */
  state_column_found: boolean;
}

/**
 * 把状态投影渲染进施工图的「状态」列（**纯函数**，不落盘）。
 * 只动那张合格表的「状态」列单元格；历史区、卡片正文、其它列一个字节都不动。
 */
export function renderPlanStatusRegion(planText: string, states: Record<string, TaskState>): PlanStatusProjection {
  const lines = planText.split(/\r?\n/);
  const map = classifyPlanRegions(planText);
  const table = map.table;
  if (table === null) return { text: planText, changed: [], state_column_found: false };
  const headerCells = lines[table.start_line - 1]?.trim().replace(/^\|/, "").replace(/\|$/, "").split("|") ?? [];
  const stateCol = headerCells.findIndex((c) => c.replace(/[`*\s]/g, "").includes("状态"));
  if (stateCol < 0) return { text: planText, changed: [], state_column_found: false };

  const byKey = new Map(Object.values(states).map((s) => [s.task_id.trim().toUpperCase(), s]));
  const changed: string[] = [];
  for (const row of table.rows) {
    const lineIdx = row.row - 1;
    const raw = lines[lineIdx] ?? "";
    if (!raw.trim().startsWith("|")) continue;
    const cells = raw.trim().replace(/^\|/, "").replace(/\|$/, "").split("|");
    if (stateCol >= cells.length) continue;
    const state = byKey.get(row.id.trim().toUpperCase());
    if (state === undefined) continue;
    const next = ` ${planStatusCell(state)} `;
    if (cells[stateCol] === next) continue;
    cells[stateCol] = next;
    lines[lineIdx] = `|${cells.join("|")}|`;
    changed.push(row.id);
  }
  return { text: lines.join("\n"), changed, state_column_found: true };
}

export interface PlanStatusWriteInput {
  /** 目标施工图绝对路径（调用方解析；本函数不认项目 id，避免"顺手写别人项目"） */
  plan_path: string;
  plan_text: string;
  states: Record<string, TaskState>;
  /** **必须显式给 true**：默认拒绝写真实仓库文档（本卡不允许改塔台的 PLAN.md） */
  allow_real_documents?: boolean;
}

/**
 * 把状态投影写进施工图（**默认关闭**）。返回 null = 没有改动（不写盘）。
 *
 * 为什么默认关：PLAN 卡状态由授权流程同步（AGENTS.md §1），施工者不能靠脚本改图纸状态；
 * 而且本卡明确不允许改 `D:/tatai/PLAN.md`。所以这个函数只有调用方**显式声明**
 * `allow_real_documents: true` 才落盘，否则抛错把话说清楚。
 */
export function writePlanStatusProjection(input: PlanStatusWriteInput): { changed: string[] } | null {
  if (input.allow_real_documents !== true) {
    throw new WorkError(
      "INVALID_COMMAND",
      "施工图状态投影默认关闭：只有调用方显式传 `allow_real_documents: true` 才写盘" +
        "（PLAN 卡状态由授权流程同步；本卡不允许改塔台的 PLAN.md）。" +
        "只想比对请用 `renderPlanStatusRegion`（纯函数，不落盘）",
      { reason: "plan_status_projection_disabled", plan_path: path.basename(input.plan_path) },
    );
  }
  const rendered = renderPlanStatusRegion(input.plan_text, input.states);
  if (rendered.changed.length === 0) return null;
  const tmp = `${input.plan_path}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, rendered.text, "utf8");
  fs.renameSync(tmp, input.plan_path);
  return { changed: rendered.changed };
}

// ── v1 旧写工具的升级要求（"缺必要版本/认领参数 → 拒绝绕写"） ──

/** v2 写入必须给的字段（缺任一 = 旧写工具在绕写，必须拒绝并说清怎么升级） */
export const V2_WRITE_REQUIRED_FIELDS = [
  "schema_version",
  "project_id",
  "change_id",
  "entity_id",
  "expected_revision",
  "type",
  "actor_id",
  "role",
  "idempotency_key",
] as const;

/** 认领相关字段（写任务需要认领；缺失即"没有认领就改状态"） */
export const V2_CLAIM_REQUIRED_FIELDS = ["claim_token"] as const;

/** 缺哪些 v2 必要字段（旧写工具的入参一般全缺 → 返回完整清单，含认领参数） */
export function missingV2WriteFields(input: Record<string, unknown> | null): string[] {
  const present = input ?? {};
  const missing: string[] = V2_WRITE_REQUIRED_FIELDS.filter((f) => {
    const v = present[f];
    return !(f === "expected_revision" ? v === null || typeof v === "number" : typeof v === "string" && v !== "");
  });
  // 认领参数与版本字段一起报：写任务状态既要有版本（在改谁的哪一版）也要有认领（谁有权改）
  for (const f of V2_CLAIM_REQUIRED_FIELDS) {
    const v = present[f];
    if (!(typeof v === "string" && v !== "") && !missing.includes(f)) missing.push(f);
  }
  return missing;
}

/**
 * 升级要求文案（旧写工具在**已迁移**项目上被拒时用它，用户看到的是"怎么改"而不是"不行"）。
 * 单一处生成，workstation 的 v1 写口与 MCP 工具共用同一段口径。
 */
export function v2UpgradeRequiredMessage(what: string, input: Record<string, unknown> | null): string {
  const missing = missingV2WriteFields(input);
  return (
    `${what} 拒绝：本项目已迁移到 v2 事实（\`.工作台/tasks.json\` 是 \`${V2_PROJECTION_OF}\` 的兼容投影），` +
    `旧写工具按 v1 覆盖会造出第二个写者。请**升级写口**：改用 v2 写入（\`POST /api/work/command\` 或 MCP 转接），` +
    `并补上必要字段：${missing.join("、") || "（无）"}。` +
    `认领与兼容写入口见 DESIGN.md §6.5 / §6.7（V06-10 交付后才允许真实项目切换，§2.6）`
  );
}

/** 定义哈希的转发入口（读侧只用 `tasks.ts` 时也能算；实现仍在 plan.ts，避免两套口径） */
export { taskDefinitionHash };

/**
 * v1 写口闸门（workstation 的 addTask / setTaskStatus / setModuleStatus 共用）。
 *
 * 判据（纯函数，不改任何文件、不建目录）：
 *   · 台账带 v2 投影标记 → 拒写（旧程序面对新格式不能静默按 v1 覆盖）；
 *   · `work/events.jsonl` 在场（本项目已有 v2 事实）→ 拒写（否则会造出第二个写者）；
 *   · 两者都没有 = 未迁移项目 → 允许，调用方的 v1 行为逐字不变（这是硬红线）。
 *
 * 已迁移项目返回的是**升级要求**：说清缺哪些 v2 必要字段，以及真实项目切换要等 V06-10。
 *
 * `tasks_file_raw` 可以给已解析的对象（调用方已经读过一遍）；不给就按 `tasks_file` 路径
 * **宽容读**一次——读不动（不存在/坏 JSON）一律按"不是投影"处理，这样未迁移项目不会
 * 因为多了一次判据而多出新的失败路径。
 */
export function v1TaskWriteGate(input: {
  /** 项目的 v2 事实目录（`.工作台/work/`） */
  work_dir: string;
  /** `.工作台/tasks.json` 路径（`tasks_file_raw` 不给时用它宽容读） */
  tasks_file?: string | null;
  /** `.工作台/tasks.json` 已解析出的对象 */
  tasks_file_raw?: unknown;
  /** 报错文案里的动作名（如 `report_task_status`） */
  what: string;
}): { allowed: boolean; message: string } {
  const marked =
    input.tasks_file_raw !== undefined
      ? hasV2ProjectionMarker(input.tasks_file_raw)
      : input.tasks_file != null && input.tasks_file !== ""
        ? tasksFileIsProjection(input.tasks_file)
        : false;
  const hasEvents = fs.existsSync(path.join(input.work_dir, "events.jsonl"));
  if (!marked && !hasEvents) return { allowed: true, message: "" };
  const reason = marked
    ? "`.工作台/tasks.json` 是 v2 事件的兼容投影"
    : "本项目已有 v2 事件（`.工作台/work/events.jsonl`）";
  return {
    allowed: false,
    message: `${v2UpgradeRequiredMessage(input.what, null)}（判据：${reason}）`,
  };
}

/** 宽容读：文件不存在/不是 JSON/读不动一律按"不是投影"处理（读路径不制造新的失败） */
export function tasksFileIsProjection(file: string): boolean {
  try {
    if (!fs.existsSync(file)) return false;
    return hasV2ProjectionMarker(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return false;
  }
}
