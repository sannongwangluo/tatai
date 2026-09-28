// 变更批次对象库（I-2，DESIGN.md §2.5「变更批次 change」＋ §2.6 权威数据与派生内容）。
//
// 边界（三件事，各自说清）：
//   ① **变更批次 ≠ 聊天里的变更/问题记录**。`chat-changes.jsonl` 里的 `chg-…` 记录只是"某次讨论里
//      提了一句不满/一个建议"（§3.6），它**不是**变更批次对象。本模块不把聊天记录升格成批次，
//      也不改写那份文件（chatActions 仍是它唯一的写入者）；要用它，只能走
//      `change.adopted_chat_change` **显式采纳**——按记录 id + 内容哈希引用，正文仍在原文件里。
//   ② **目标基线只引用哈希，不复制基线内容**（§2.6）：`target_baseline` 存的是既有基线的
//      `design_revision` / `plan_revision` 内容哈希（＋可选的 baseline_id），蓝图正文与恢复位置在
//      `baselines.jsonl` 那一套里，不在这里存第二份。
//   ③ **每次迭代有独立状态**（§2.5）：状态是 `open` / `iterating` / `closed`，`iteration` 记第几轮迭代；
//      变更批次聚合任务、评审和验收，但不替它们下结论（任务状态仍只看任务事件，§5.4）。
//
// 事件词表：`change.opened` / `change.status_changed` / `change.closed` / `change.adopted_chat_change` /
// `change.blueprint_inheritance_recorded`——与 task/finding/audit/execution 走同一条事件流、同一个唯一写入者，
// 不另造第二事件源（§2.6）。
// 2026-09-21 C016 收口第二包：新增 `change.blueprint_inheritance_recorded`——派生蓝图删除/拆并的
// **合法变更事实**登记（DESIGN §4.1：权威来源 = 已审定图纸基线 + 合法变更事实）。事实绑定 from/to 基线、
// 前任/继任、影响范围与有效任务/证据引用的处置明细；跨基线/源图/引用语义校验在 submit 前的
// `arch/blueprintInheritance.ts#registerBlueprintInheritance` 完成，本层保证结构折叠判据（直连
// WorkService.submit 也过同一份，见 service.ts assertEntityEventFoldable）。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { nowIso } from "../time";
import { SCHEMA_VERSION, WorkError, type WorkErrorCode, type WorkEvent, type WorkReceipt } from "./types";
import { loadEvents, replayEvents } from "./eventStore";
import { CHAT_CHANGES_FILE } from "./chatActions";
import type { WorkSubmitter } from "./tasks";

/** 本模块登记的 v2 变更批次事件词表（登记面见 `types.ts` 的 `REGISTERED_EVENT_TYPES`） */
export const CHANGE_EVENT_TYPES = [
  "change.opened",
  "change.status_changed",
  "change.closed",
  "change.adopted_chat_change",
  "change.blueprint_inheritance_recorded",
] as const;
export type ChangeEventType = (typeof CHANGE_EVENT_TYPES)[number];

/** 批次状态（§2.5「每次迭代有独立状态」）：进行中 / 迭代中 / 已关闭 */
export const CHANGE_STATUSES = ["open", "iterating", "closed"] as const;
export type ChangeStatus = (typeof CHANGE_STATUSES)[number];

export const CHANGE_STATUS_LABELS: Readonly<Record<ChangeStatus, string>> = {
  open: "进行中",
  iterating: "迭代中",
  closed: "已关闭",
};

/** `change.opened` 收的键——§2.5 的五个字段，多一个都不收（防把批次写成又一份设计原文） */
export const CHANGE_PAYLOAD_KEYS = [
  "goal",
  "authorized_scope",
  "target_baseline",
  "affected_subsystems",
  "exit_criteria",
] as const;

/** 批次 id 形态：`change-` + 非空白、不含路径分隔符（允许中文 slug） */
export const CHANGE_ID_RE = /^change-[^\s/\\]{1,80}$/;

/** 内容哈希形态（sha256 十六进制）——目标基线只引用这种哈希，不存正文 */
const SHA256_RE = /^[0-9a-f]{64}$/;

export const changeEntityId = (changeId: string): string => `change:${changeId}`;
export const changeIdOfEntity = (entityId: string): string | null =>
  entityId.startsWith("change:") ? entityId.slice("change:".length) : null;

/** slug 归一成稳定 id（`扫描取消` → `change-扫描取消`） */
export function changeIdFromSlug(slug: string): string {
  const normalized = slug.trim().toLowerCase().replace(/[\s/\\]+/g, "-");
  const id = normalized.startsWith("change-") ? normalized : `change-${normalized}`;
  if (!CHANGE_ID_RE.test(id)) {
    throw new WorkError(
      "INVALID_COMMAND",
      `变更批次 slug 归一不成合法 id（${JSON.stringify(slug)} → ${JSON.stringify(id)}）：id 必须是 ${CHANGE_ID_RE} 形态`,
      { slug, id },
    );
  }
  return id;
}

/** 自动批次号的取材：项目 + §2.5 五个字段（原样收，校验由 readOpenedFields 负责） */
export interface ChangeBatchIdSeed {
  project_id: string;
  goal?: unknown;
  authorized_scope?: unknown;
  target_baseline?: unknown;
  affected_subsystems?: unknown;
  exit_criteria?: unknown;
}

/**
 * 省略批次号时的自动 id（V07-04，DESIGN 附录 C.5-4）：`change-<日期>-<摘要>`。
 *
 * 形态是"日期 + 随机段"，但随机段**不是真随机数**：它由请求内容（项目 + §2.5 五个字段）
 * 算出的 sha256 前 8 位。理由就是本卡要的"稳定 id"：随机数在服务端没有记忆，同一次请求
 * 重试会拿到另一个 id、进而算出另一个幂等键，结果开出两个批次——幂等键那套仲裁形同虚设。
 * 按内容取摘要则重试恒得同一个 id，服务端凭既有幂等键返回原回执（不产生第二次效果）。
 *
 * 边界（如实说清）：① 相同内容的两次**真实**意图会被认成同一批次——那正是"同一请求"的
 * 语义；要各开一批请显式给 change_batch_id；② 日期取本机当天，跨零点的重试会换 id。
 */
export function autoChangeBatchId(seed: ChangeBatchIdSeed): string {
  const canonical = JSON.stringify([
    seed.project_id,
    seed.goal ?? null,
    seed.authorized_scope ?? null,
    seed.target_baseline ?? null,
    seed.affected_subsystems ?? null,
    seed.exit_criteria ?? null,
  ]);
  const digest = crypto.createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 8);
  const date = nowIso().slice(0, 10).replace(/-/g, "");
  const id = `change-${date}-${digest}`;
  if (!CHANGE_ID_RE.test(id)) {
    throw new WorkError("INVALID_COMMAND", `自动生成的批次号过不了 id 形态（${id}）——本模块的生成口径出了问题`, { id });
  }
  return id;
}

// ── 目标基线引用（只存哈希，不存内容） ──

export interface ChangeTargetBaseline {
  /** 既有基线的 id（能取到就给，便于回查是哪一条；不复制基线内容） */
  baseline_id: string | null;
  /** 既有基线里设计书的 `content_sha256` */
  design_revision: string;
  /** 既有基线里施工图的 `content_sha256` */
  plan_revision: string;
}

/** 基线记录里本模块要用到的结构（结构化入参，避免为一个引用把 documents 整条链拉进来） */
export interface BaselineReferenceLike {
  baseline_id?: string;
  design_revision: { content_sha256: string };
  plan_revision: { content_sha256: string };
}

/**
 * 从既有基线取"目标基线引用"（DESIGN.md §2.6：基线只引用原文哈希与恢复位置）。
 * 这是打开变更批次时该用的取法——不要手抄哈希，避免与基线漂移。
 */
export function targetBaselineOf(baseline: BaselineReferenceLike): ChangeTargetBaseline {
  return {
    baseline_id: baseline.baseline_id ?? null,
    design_revision: baseline.design_revision.content_sha256,
    plan_revision: baseline.plan_revision.content_sha256,
  };
}

// ── 聊天变更记录（只读引用源：chat-changes.jsonl） ──

/**
 * `chat-changes.jsonl` 的一行（原样保留未知字段；本模块**只读**，从不写它）。
 * 注意：这条记录的标识字段在这份文件里就叫 `change_id`（值是 `chg-…`），**与批次 id 不是一回事**，
 * 故本模块一律叫它 `chat_record_id`。
 */
export interface ChatChangeRecord {
  chat_record_id: string;
  /** 该行规范化 JSON 的 sha256（采纳时按它核对内容，不搬正文） */
  sha256: string;
  /** 原样记录（含未识别的字段；只是引用，不是批次对象） */
  raw: Record<string, unknown>;
}

/** 一条聊天变更记录的内容哈希（规范化 = `JSON.stringify(解析后的对象)`，同一内容在任何进程算出同一个值） */
export function chatChangeRecordHash(record: Record<string, unknown>): string {
  return crypto.createHash("sha256").update(JSON.stringify(record), "utf8").digest("hex");
}

export const chatChangesPath = (workDir: string): string => path.join(workDir, CHAT_CHANGES_FILE);

export interface ChatChangeLog {
  records: ChatChangeRecord[];
  /** 坏行（只读路径如实报出，不跳过、不当没看见） */
  corrupt: { line: number; reason: string }[];
}

/** 只读聊天变更记录（文件不在 = 空；坏行如实报出，不静默丢弃） */
export function readChatChangeRecords(workDir: string): ChatChangeLog {
  const file = chatChangesPath(workDir);
  if (!fs.existsSync(file)) return { records: [], corrupt: [] };
  const records: ChatChangeRecord[] = [];
  const corrupt: { line: number; reason: string }[] = [];
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i].trim();
    if (text === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      corrupt.push({ line: i + 1, reason: `JSON 解析失败：${(e as Error).message}` });
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      corrupt.push({ line: i + 1, reason: "不是 JSON 对象" });
      continue;
    }
    const raw = parsed as Record<string, unknown>;
    const id = raw.change_id;
    if (typeof id !== "string" || id.trim() === "") {
      corrupt.push({ line: i + 1, reason: "缺 change_id（这份文件里的记录标识）" });
      continue;
    }
    records.push({ chat_record_id: id.trim(), sha256: chatChangeRecordHash(raw), raw });
  }
  return { records, corrupt };
}

// ── 状态投影（纯派生：删掉可全量重放） ──

export interface ChangeAdoptedChatChange {
  chat_record_id: string;
  chat_record_sha256: string;
  note: string | null;
  adopted_by: string;
  at: string;
}

export interface ChangeHistoryEntry {
  at: string;
  type: string;
  actor: string;
  status: ChangeStatus;
  note: string | null;
}

/** 一个变更批次由**已提交事件**推出的状态（§2.5 五字段 + 迭代状态 + 采纳引用） */
export interface ChangeState {
  change_id: string;
  goal: string;
  authorized_scope: string;
  target_baseline: ChangeTargetBaseline;
  affected_subsystems: string[];
  exit_criteria: string;
  status: ChangeStatus;
  status_label: string;
  /** 第几轮迭代（1 起；`change.opened` = 1） */
  iteration: number;
  /** 显式采纳的聊天变更记录引用（只是引用；原记录仍在 chat-changes.jsonl 里） */
  adopted_chat_changes: ChangeAdoptedChatChange[];
  /** 蓝图删除/拆并的合法变更事实（C016：DESIGN §4.1 权威来源的一半；结构经折叠校验，语义经登记命令核验） */
  blueprint_inheritance_records: BlueprintInheritanceFact[];
  history: ChangeHistoryEntry[];
  /** 事件实体版本（1 起） */
  revision: number;
  seq: number;
  last_event_id: string;
  updated_at: string;
  last_actor: string;
}

export interface ChangeProjection {
  changes: Record<string, ChangeState>;
  last_seq: number;
  /** 事件里出现但不算批次实体的实体，如实报出便于排查 */
  ignored_entities: string[];
}

function badEvent(message: string, detail: Record<string, unknown> = {}): never {
  throw new WorkError("EVENT_INVALID", `变更批次事件不合法：${message}`, detail);
}

function badCommand(message: string, detail: Record<string, unknown> = {}): never {
  throw new WorkError("INVALID_COMMAND", `变更批次命令不合法：${message}`, detail);
}

function failWith(
  code: WorkErrorCode,
  where: string,
  message: string,
  detail: Record<string, unknown> = {},
): never {
  if (code === "EVENT_INVALID") return badEvent(`${message}（${where}）`, { where, ...detail });
  return badCommand(`${message}（${where}）`, { where, ...detail });
}

function assertMinimalKeys(
  payload: Record<string, unknown>,
  allowed: readonly string[],
  code: WorkErrorCode,
  where: string,
): void {
  const extra = Object.keys(payload).filter((k) => !allowed.includes(k));
  if (extra.length === 0) return;
  failWith(
    code,
    where,
    `变更批次对象只收 §2.5 的字段（${allowed.join(" / ")}），多出来的键一律拒：${extra.join("、")}。` +
      "设计/施工原文的事实源是两份图纸修订，这里只存批次自身的目标、授权范围、目标基线引用、受影响子系统与出口条件",
    { extra, allowed },
  );
}

/**
 * 入参级闭键守卫：公共写命令的**整个入参对象**只收该命令声明的键，多一个键就拒。
 * 与 `assertMinimalKeys`（payload 级）分工不同：那个管事件 payload 装什么，这个管调用方递进来的命令对象。
 * 入参里混进 `intent_text` / `text` / `chat_text` 这类键，若不在这里拦住，就会被"显式挑键"悄悄丢掉、
 * 却仍返回成功回执——调用方以为存了、其实没存（违反 fail-closed）。
 * §2.6 说设计/施工原文与聊天正文各有各的事实源，这里必须把"只收这些键"讲明白。
 */
function assertCommandKeys(input: object, allowed: readonly string[], where: string): void {
  const extra = Object.keys(input).filter((k) => !allowed.includes(k));
  if (extra.length === 0) return;
  failWith(
    "INVALID_COMMAND",
    where,
    `入参只收这些键（${allowed.join(" / ")}），多出来的键一律拒：${extra.join("、")}。` +
      "设计/施工原文与聊天正文各有各的事实源（DESIGN.md §2.6 单源分工），" +
      "这里只存批次自身的目标、授权范围、目标基线引用、受影响子系统与出口条件",
    { extra, allowed },
  );
}

function readStr(value: unknown, field: string, code: WorkErrorCode, where: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    failWith(code, where, `payload.${field} 必须是非空字符串`, { field, got: value });
  }
  return (value as string).trim();
}

function readStrList(value: unknown, field: string, code: WorkErrorCode, where: string): string[] {
  if (!Array.isArray(value)) {
    failWith(code, where, `payload.${field} 必须是字符串数组（空数组表示已确认没有，不能省略该键）`, {
      field,
      got: value,
    });
  }
  const out: string[] = [];
  for (const item of value as unknown[]) {
    if (typeof item !== "string" || item.trim() === "") {
      failWith(code, where, `payload.${field} 的每一项都必须是非空字符串`, { field, item });
    }
    out.push((item as string).trim());
  }
  return out;
}

function readSha256(value: unknown, field: string, code: WorkErrorCode, where: string): string {
  if (typeof value !== "string" || !SHA256_RE.test(value)) {
    failWith(
      code,
      where,
      `payload.${field} 必须是既有基线里的 sha256 内容哈希（64 位十六进制）——基线只引用哈希，不复制内容（§2.6）`,
      { field, got: value },
    );
  }
  return value as string;
}

function readTargetBaseline(value: unknown, code: WorkErrorCode, where: string): ChangeTargetBaseline {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    failWith(code, where, "payload.target_baseline 必须是 {design_revision, plan_revision, baseline_id?} 的哈希引用", {
      got: value,
    });
  }
  const raw = value as Record<string, unknown>;
  const extra = Object.keys(raw).filter((k) => !["baseline_id", "design_revision", "plan_revision"].includes(k));
  if (extra.length > 0) {
    failWith(
      code,
      where,
      `payload.target_baseline 只收 baseline_id / design_revision / plan_revision，多出来的拒：${extra.join("、")}`,
      { extra },
    );
  }
  const missing = ["design_revision", "plan_revision"].filter((k) => raw[k] === undefined);
  if (missing.length > 0) {
    failWith(code, where, `payload.target_baseline 缺 ${missing.join("、")}（目标基线要指到既有基线的两份修订）`, {
      missing,
    });
  }
  const baselineId = raw.baseline_id;
  if (baselineId !== undefined && baselineId !== null && (typeof baselineId !== "string" || baselineId.trim() === "")) {
    failWith(code, where, "payload.target_baseline.baseline_id 给定就必须是非空字符串", { baseline_id: baselineId });
  }
  return {
    baseline_id: typeof baselineId === "string" ? baselineId.trim() : null,
    design_revision: readSha256(raw.design_revision, "target_baseline.design_revision", code, where),
    plan_revision: readSha256(raw.plan_revision, "target_baseline.plan_revision", code, where),
  };
}

function readChangeStatus(value: unknown, code: WorkErrorCode, where: string): ChangeStatus {
  if (typeof value !== "string" || !CHANGE_STATUSES.includes(value as ChangeStatus)) {
    failWith(code, where, `payload.status 必须是 ${CHANGE_STATUSES.join("/")} 之一（进行中/迭代中/已关闭）`, {
      status: value,
    });
  }
  return value as ChangeStatus;
}

function readIteration(value: unknown, code: WorkErrorCode, where: string): number | null {
  if (value === undefined) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    failWith(code, where, "payload.iteration 给定就必须是 >=1 的整数（第几轮迭代）", { iteration: value });
  }
  return value as number;
}

interface ChangeFields {
  goal: string;
  authorized_scope: string;
  target_baseline: ChangeTargetBaseline;
  affected_subsystems: string[];
  exit_criteria: string;
}

function readOpenedFields(payload: Record<string, unknown>, code: WorkErrorCode, where: string): ChangeFields {
  assertMinimalKeys(payload, CHANGE_PAYLOAD_KEYS, code, where);
  const missing = CHANGE_PAYLOAD_KEYS.filter((k) => payload[k] === undefined);
  if (missing.length > 0) {
    failWith(code, where, `§2.5 的字段没给全，缺：${missing.join("、")}（缺字段按缺字段拒，不用默认值冒充）`, {
      missing,
    });
  }
  return {
    goal: readStr(payload.goal, "goal", code, where),
    authorized_scope: readStr(payload.authorized_scope, "authorized_scope", code, where),
    target_baseline: readTargetBaseline(payload.target_baseline, code, where),
    affected_subsystems: readStrList(payload.affected_subsystems, "affected_subsystems", code, where),
    exit_criteria: readStr(payload.exit_criteria, "exit_criteria", code, where),
  };
}

// ── 蓝图继承事实（change.blueprint_inheritance_recorded，C016 收口第二包） ──

/** 删除/拆并的种类：remove = 删除；split = 拆分；merge = 合并 */
export const BLUEPRINT_INHERITANCE_KINDS = ["remove", "split", "merge"] as const;
export type BlueprintInheritanceKind = (typeof BLUEPRINT_INHERITANCE_KINDS)[number];

/** 处置动作：migrated = 引用迁移到某个继任节点；disposed = 引用随前任退役处置掉（仅留追溯） */
export const BLUEPRINT_REFERENCE_DISPOSITION_ACTIONS = ["migrated", "disposed"] as const;
export type BlueprintReferenceDispositionAction = (typeof BLUEPRINT_REFERENCE_DISPOSITION_ACTIONS)[number];

/**
 * 一条有效任务/证据引用的迁移/处置明细（§4.1：被引用的节点先合法迁移/处置引用，再重派生）。
 * `referenced_by` 形如 `task:<卡号>` / `evidence:<证据 id>`（可审查的逐字点名）。
 */
export interface BlueprintReferenceDisposition {
  /** 被引用的前任节点 id（必须在 predecessor_ids 里） */
  predecessor_id: string;
  /** 哪条有效引用指向它（`task:<id>` / `evidence:<id>`） */
  referenced_by: string;
  action: BlueprintReferenceDispositionAction;
  /** migrated → 必须是非空串且在 successor_ids 里；disposed → 必须是 null */
  to: string | null;
  /** 处置说明（必填：为什么这样处置） */
  note: string;
}

/**
 * `change.blueprint_inheritance_recorded` 的 payload 口径（结构层，fold 与写命令共用同一份判据）：
 * 事实绑定 kind、from/to 基线哈希引用、前任/继任、影响范围节点与全部有效引用的处置明细；
 * 缺键/多键/空白/重复都拒。语义闸（批次真实未关闭、from==批次 target_baseline、to==当前生效基线、
 * 前任在 from 图、to 图已形成预期结果、引用处置覆盖与批次授权范围覆盖）在
 * `arch/blueprintInheritance.ts#registerBlueprintInheritance` 里于 submit 前完成。
 */
export interface BlueprintInheritancePayload {
  kind: BlueprintInheritanceKind;
  from_baseline: ChangeTargetBaseline;
  to_baseline: ChangeTargetBaseline;
  predecessor_ids: string[];
  successor_ids: string[];
  /** 影响范围节点（可空数组，但键必须在） */
  affected_node_ids: string[];
  reference_dispositions: BlueprintReferenceDisposition[];
}

/** 落进 ChangeState 的一条继承事实（payload + 事件元数据，供审查与追溯） */
export interface BlueprintInheritanceFact extends BlueprintInheritancePayload {
  recorded_by: string;
  recorded_at: string;
  event_id: string;
}

export const BLUEPRINT_INHERITANCE_PAYLOAD_KEYS = [
  "kind",
  "from_baseline",
  "to_baseline",
  "predecessor_ids",
  "successor_ids",
  "affected_node_ids",
  "reference_dispositions",
] as const;

function readUniqueStrList(value: unknown, field: string, code: WorkErrorCode, where: string): string[] {
  const out = readStrList(value, field, code, where);
  if (new Set(out).size !== out.length) {
    failWith(code, where, `payload.${field} 有重复项（同一批 id 只许出现一次）`, { field, got: out });
  }
  return out;
}

function readDisposition(value: unknown, index: number, code: WorkErrorCode, where: string): BlueprintReferenceDisposition {
  const field = `reference_dispositions[${index}]`;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    failWith(code, where, `payload.${field} 必须是对象`, { got: value });
  }
  const raw = value as Record<string, unknown>;
  const allowed = ["predecessor_id", "referenced_by", "action", "to", "note"] as const;
  const extra = Object.keys(raw).filter((k) => !(allowed as readonly string[]).includes(k));
  if (extra.length > 0) {
    failWith(code, where, `payload.${field} 只收 ${allowed.join(" / ")}，多出来的键一律拒：${extra.join("、")}`, { extra });
  }
  const missing = allowed.filter((k) => raw[k] === undefined);
  if (missing.length > 0) {
    failWith(code, where, `payload.${field} 缺 ${missing.join("、")}（to 对 disposed 也必须显式给 null）`, { missing });
  }
  const action = raw.action;
  if (typeof action !== "string" || !BLUEPRINT_REFERENCE_DISPOSITION_ACTIONS.includes(action as BlueprintReferenceDispositionAction)) {
    failWith(code, where, `payload.${field}.action 必须是 ${BLUEPRINT_REFERENCE_DISPOSITION_ACTIONS.join("/")} 之一`, { action });
  }
  const to = raw.to;
  if (action === "migrated") {
    if (typeof to !== "string" || to.trim() === "") {
      failWith(code, where, `payload.${field}.to：migrated 必须给出非空的继任节点 id`, { to });
    }
  } else if (to !== null) {
    failWith(code, where, `payload.${field}.to：disposed 必须是 null（迁移才有目标）`, { to });
  }
  return {
    predecessor_id: readStr(raw.predecessor_id, `${field}.predecessor_id`, code, where),
    referenced_by: readStr(raw.referenced_by, `${field}.referenced_by`, code, where),
    action: action as BlueprintReferenceDispositionAction,
    to: action === "migrated" ? (to as string).trim() : null,
    note: readStr(raw.note, `${field}.note`, code, where),
  };
}

/**
 * 继承事实 payload 的**结构**读取器（单一判据来源）：foldChanges 重放与 recordBlueprintInheritance
 * 写命令共用；WorkService.submit 的写侧预检（assertEntityEventFoldable）也因此覆盖直连提交。
 * 只管结构（键闭合/非空/去重/基数/处置形态），跨基线与引用覆盖的语义闸在登记命令里。
 */
export function readBlueprintInheritancePayload(
  payload: Record<string, unknown>,
  code: WorkErrorCode,
  where: string,
): BlueprintInheritancePayload {
  assertMinimalKeys(payload, BLUEPRINT_INHERITANCE_PAYLOAD_KEYS, code, where);
  const missing = BLUEPRINT_INHERITANCE_PAYLOAD_KEYS.filter((k) => payload[k] === undefined);
  if (missing.length > 0) {
    failWith(code, where, `继承事实的字段没给全，缺：${missing.join("、")}（缺字段按缺字段拒，不用默认值冒充）`, { missing });
  }
  const kind = payload.kind;
  if (typeof kind !== "string" || !BLUEPRINT_INHERITANCE_KINDS.includes(kind as BlueprintInheritanceKind)) {
    failWith(code, where, `payload.kind 必须是 ${BLUEPRINT_INHERITANCE_KINDS.join("/")} 之一`, { kind });
  }
  const k = kind as BlueprintInheritanceKind;
  const from_baseline = readTargetBaseline(payload.from_baseline, code, where);
  const to_baseline = readTargetBaseline(payload.to_baseline, code, where);
  const predecessor_ids = readUniqueStrList(payload.predecessor_ids, "predecessor_ids", code, where);
  if (predecessor_ids.length === 0) {
    failWith(code, where, "payload.predecessor_ids 至少要有一个前任节点 id（没有前任的删除/拆并不是事实）", {
      field: "predecessor_ids",
    });
  }
  const successor_ids = readUniqueStrList(payload.successor_ids, "successor_ids", code, where);
  const succRule: Record<BlueprintInheritanceKind, string> = {
    remove: "删除的继任清单必须为空（有继任就不是删除）",
    split: "拆分至少要有一个继任（零后继的实质是删除，不许记成 split）",
    merge: "合并的继任必须恰好一个（多源归一）",
  };
  const badCardinality =
    (k === "remove" && successor_ids.length !== 0) ||
    (k === "split" && successor_ids.length === 0) ||
    (k === "merge" && successor_ids.length !== 1);
  if (badCardinality) {
    failWith(code, where, `payload.successor_ids 与 kind=${k} 的基数不符：${succRule[k]}`, {
      field: "successor_ids",
      kind: k,
      successor_ids,
    });
  }
  const overlap = successor_ids.filter((s) => predecessor_ids.includes(s));
  if (overlap.length > 0) {
    failWith(code, where, `前任与继任不允许重叠：${overlap.join("、")} 同时在两份清单里（自己继任自己不是变更事实）`, {
      overlap,
    });
  }
  const affected_node_ids = readUniqueStrList(payload.affected_node_ids, "affected_node_ids", code, where);
  if (!Array.isArray(payload.reference_dispositions)) {
    failWith(code, where, "payload.reference_dispositions 必须是数组（空数组表示没有需要处置的有效引用，不能省略该键）", {
      field: "reference_dispositions",
      got: payload.reference_dispositions,
    });
  }
  const reference_dispositions = (payload.reference_dispositions as unknown[]).map((d, i) =>
    readDisposition(d, i, code, where),
  );
  const seenPairs = new Set<string>();
  for (const d of reference_dispositions) {
    if (!predecessor_ids.includes(d.predecessor_id)) {
      failWith(code, where, `处置明细指向非前任节点：${d.predecessor_id} 不在 predecessor_ids 里`, {
        predecessor_id: d.predecessor_id,
      });
    }
    if (d.action === "migrated" && !successor_ids.includes(d.to!)) {
      failWith(code, where, `处置明细的迁移目标 ${d.to} 不在 successor_ids 里（migrated 只能迁到已登记的继任）`, {
        to: d.to,
      });
    }
    const pair = `${d.predecessor_id}${d.referenced_by}`;
    if (seenPairs.has(pair)) {
      failWith(code, where, `处置明细重复：${d.predecessor_id} 的 ${d.referenced_by} 出现了两次（一条引用只处置一次）`, {
        predecessor_id: d.predecessor_id,
        referenced_by: d.referenced_by,
      });
    }
    seenPairs.add(pair);
  }
  return { kind: k, from_baseline, to_baseline, predecessor_ids, successor_ids, affected_node_ids, reference_dispositions };
}

function emptyChange(changeId: string): ChangeState {
  return {
    change_id: changeId,
    goal: "",
    authorized_scope: "",
    target_baseline: { baseline_id: null, design_revision: "", plan_revision: "" },
    affected_subsystems: [],
    exit_criteria: "",
    status: "open",
    status_label: CHANGE_STATUS_LABELS.open,
    iteration: 0,
    adopted_chat_changes: [],
    blueprint_inheritance_records: [],
    history: [],
    revision: 0,
    seq: 0,
    last_event_id: "",
    updated_at: "",
    last_actor: "",
  };
}

/**
 * 从事件重放变更批次（纯函数）。
 * 口径：首条必须是 `change.opened`；已关闭的批次不能再被改回非关闭态（要接着干请开新一轮迭代/新批次）；
 * 同一条聊天记录不能重复采纳；采纳只按 id + 哈希引用，**从不回写 chat-changes.jsonl**。
 */
export function foldChanges(events: WorkEvent[]): ChangeProjection {
  const changes: Record<string, ChangeState> = {};
  const ignored = new Set<string>();
  const { last_seq } = replayEvents(events);

  for (const e of events) {
    const changeId = changeIdOfEntity(e.entity_id);
    if (changeId === null) {
      ignored.add(e.entity_id);
      continue;
    }
    if (changeId === "") badEvent(`实体 id 缺 change_id（事件 ${e.event_id}）`, { event_id: e.event_id });
    if (!(CHANGE_EVENT_TYPES as readonly string[]).includes(e.type)) {
      badEvent(`未知变更批次事件类型 ${JSON.stringify(e.type)}（事件 ${e.event_id}）`, {
        event_id: e.event_id,
        type: e.type,
      });
    }
    const type = e.type as ChangeEventType;
    const where = `事件 ${e.event_id}`;
    const prev = changes[changeId];
    if (type === "change.opened") {
      if (prev !== undefined) {
        badEvent(`变更批次 ${changeId} 重复开启（事件 ${e.event_id}）——开一次，之后走 status_changed`, {
          event_id: e.event_id,
          change_id: changeId,
        });
      }
      const fields = readOpenedFields(e.payload, "EVENT_INVALID", where);
      changes[changeId] = {
        ...emptyChange(changeId),
        ...fields,
        status: "open",
        status_label: CHANGE_STATUS_LABELS.open,
        iteration: 1,
        history: [{ at: e.received_at, type, actor: e.actor_id, status: "open", note: null }],
        revision: e.entity_revision,
        seq: e.seq,
        last_event_id: e.event_id,
        updated_at: e.received_at,
        last_actor: e.actor_id,
      };
      continue;
    }
    if (prev === undefined) {
      badEvent(`变更批次 ${changeId} 的首条事件是 ${type}——必须先 change.opened`, {
        event_id: e.event_id,
        change_id: changeId,
      });
    }
    const next: ChangeState = {
      ...prev,
      revision: e.entity_revision,
      seq: e.seq,
      last_event_id: e.event_id,
      updated_at: e.received_at,
      last_actor: e.actor_id,
      adopted_chat_changes: [...prev.adopted_chat_changes],
      blueprint_inheritance_records: [...prev.blueprint_inheritance_records],
      history: [...prev.history],
    };
    let status: ChangeStatus = prev.status;
    let note: string | null = null;
    if (type === "change.status_changed") {
      assertMinimalKeys(e.payload, ["status", "iteration", "reason"], "EVENT_INVALID", where);
      status = readChangeStatus(e.payload.status, "EVENT_INVALID", where);
      const iteration = readIteration(e.payload.iteration, "EVENT_INVALID", where);
      if (iteration !== null) next.iteration = iteration;
      note = typeof e.payload.reason === "string" && e.payload.reason.trim() !== "" ? e.payload.reason.trim() : null;
      if (prev.status === "closed") {
        badEvent(`变更批次 ${changeId} 已关闭，不能再改成 ${status}（事件 ${e.event_id}）：接着干请开新一批次/新迭代`, {
          event_id: e.event_id,
          change_id: changeId,
        });
      }
    } else if (type === "change.closed") {
      assertMinimalKeys(e.payload, ["reason"], "EVENT_INVALID", where);
      status = "closed";
      note = readStr(e.payload.reason, "reason", "EVENT_INVALID", where);
    } else if (type === "change.adopted_chat_change") {
      // 只登记"显式采纳"这条引用，聊天记录本体仍在原文件里
      assertMinimalKeys(e.payload, ["chat_record_id", "chat_record_sha256", "note"], "EVENT_INVALID", where);
      const recordId = readStr(e.payload.chat_record_id, "chat_record_id", "EVENT_INVALID", where);
      const recordSha = readSha256(e.payload.chat_record_sha256, "chat_record_sha256", "EVENT_INVALID", where);
      if (next.adopted_chat_changes.some((a) => a.chat_record_id === recordId)) {
        badEvent(`聊天记录 ${recordId} 已被批次 ${changeId} 采纳过（事件 ${e.event_id}）——重复采纳不产生第二次效果`, {
          event_id: e.event_id,
          change_id: changeId,
          chat_record_id: recordId,
        });
      }
      const noteText = typeof e.payload.note === "string" && e.payload.note.trim() !== "" ? e.payload.note.trim() : null;
      next.adopted_chat_changes.push({
        chat_record_id: recordId,
        chat_record_sha256: recordSha,
        note: noteText,
        adopted_by: e.actor_id,
        at: e.received_at,
      });
      note = recordId;
    } else {
      // change.blueprint_inheritance_recorded（C016）：蓝图删除/拆并的合法变更事实。
      // 结构判据与写命令同一份（readBlueprintInheritancePayload）；已关闭的批次不再接受新事实。
      if (prev.status === "closed") {
        badEvent(
          `变更批次 ${changeId} 已关闭，不能再登记蓝图继承事实（事件 ${e.event_id}）：关闭的批次不再授权新的删除/拆并，接着干请开新批次/新迭代`,
          { event_id: e.event_id, change_id: changeId },
        );
      }
      const fact = readBlueprintInheritancePayload(e.payload, "EVENT_INVALID", where);
      next.blueprint_inheritance_records.push({
        ...fact,
        recorded_by: e.actor_id,
        recorded_at: e.received_at,
        event_id: e.event_id,
      });
      note = `${fact.kind}: ${fact.predecessor_ids.join("、")}`;
    }
    next.status = status;
    next.status_label = CHANGE_STATUS_LABELS[status];
    next.history.push({ at: e.received_at, type, actor: e.actor_id, status, note });
    changes[changeId] = next;
  }
  return { changes, last_seq, ignored_entities: [...ignored].sort() };
}

/** 从磁盘事件文件读并折叠变更批次（读路径；中段损坏会抛，不吞） */
export function readChanges(workDir: string): ChangeProjection {
  const { events } = loadEvents(workDir);
  return foldChanges(events);
}

/** 批次 id 升序（供跨对象引用校验点名用） */
export function changeIdsOf(projection: ChangeProjection): string[] {
  return Object.keys(projection.changes).sort();
}

// ── 写入（唯一写入者：提交事件，不绕开） ──

export interface ChangeEventInput {
  project_id: string;
  change_batch_id: string;
  /** 事件信封的 change_id（本批次自己就是批次，故填本批次 id；上层另有批次上下文时按上层的填） */
  change_id: string;
  actor_id: string;
  role: string;
  occurred_at?: string;
}

/** 公共写命令的入参信封键（与 `ChangeEventInput` 一一对应；`occurred_at` 可选） */
const CHANGE_ENVELOPE_INPUT_KEYS = [
  "project_id",
  "change_batch_id",
  "change_id",
  "actor_id",
  "role",
  "occurred_at",
] as const;

export function changeEventIdempotencyKey(
  input: ChangeEventInput & { type: ChangeEventType; expected_revision: number | null },
): string {
  const rev = input.expected_revision === null ? 0 : input.expected_revision;
  return `${input.change_batch_id}:${input.type}:${rev + 1}:${input.change_id}`;
}

function submitChangeEvent(
  submitter: WorkSubmitter,
  input: ChangeEventInput & { type: ChangeEventType; expected_revision: number | null; payload: Record<string, unknown> },
): WorkReceipt {
  return submitter.submit({
    schema_version: SCHEMA_VERSION,
    project_id: input.project_id,
    change_id: input.change_id,
    entity_id: changeEntityId(input.change_batch_id),
    expected_revision: input.expected_revision,
    type: input.type,
    actor_id: input.actor_id,
    role: input.role,
    idempotency_key: changeEventIdempotencyKey(input),
    ...(input.occurred_at === undefined ? {} : { occurred_at: input.occurred_at }),
    payload: input.payload,
  });
}

/** 读侧闭包（改状态/采纳要先读当前批次与聊天记录；本模块不猜项目路径） */
export interface ChangeReadSource {
  read: () => { changes: Record<string, ChangeState> };
  /** 读聊天变更记录（chat-changes.jsonl）——采纳关联按 id + 内容哈希核对 */
  readChatChanges: () => ChatChangeLog;
}
export type ChangeSubmitter = WorkSubmitter & Partial<ChangeReadSource>;

function requireChangeReader(submitter: WorkSubmitter): () => { changes: Record<string, ChangeState> } {
  const reader = (submitter as ChangeSubmitter).read;
  if (typeof reader !== "function") {
    throw new WorkError(
      "INVALID_COMMAND",
      "提交者没有给出变更批次读侧（submitter.read）：改状态与采纳都要先读当前批次，不能靠「我以为是那个版本」",
      { reason: "missing_change_reader" },
    );
  }
  return reader;
}

export interface OpenChangeInput extends Omit<ChangeEventInput, "change_batch_id" | "change_id">, ChangeFields {
  /** 批次稳定 id；**省略 = 服务端按请求内容自动生成**（`autoChangeBatchId`，重试恒得同一个） */
  change_batch_id?: string;
  /** 事件信封的批次上下文；省略 = 用本次批次 id（批次自己就是批次） */
  change_id?: string;
}

/** `openChange` 的允许入参键：信封 + §2.5 五个字段（与 interface 字段一一对应，多一个都拒） */
const OPEN_CHANGE_INPUT_KEYS = [...CHANGE_ENVELOPE_INPUT_KEYS, ...CHANGE_PAYLOAD_KEYS] as const;

/**
 * 开一个变更批次（首条 `change.opened`）——字段口径就是 §2.5 的五个，多一个键都拒。
 * `change_batch_id` 省略时由服务端自动生成（形态与幂等口径见 `autoChangeBatchId`）；
 * 给了空串/非字符串则明确拒——"给错了"不能悄悄当成"没给"。
 */
export function openChange(submitter: WorkSubmitter, input: OpenChangeInput): WorkReceipt {
  const given = input.change_batch_id;
  if (given !== undefined && (typeof given !== "string" || given.trim() === "")) {
    badCommand(`批次号给定就必须是非空字符串（省略才自动生成）：${JSON.stringify(given)}`, { change_batch_id: given });
  }
  const where = `开启 ${typeof given === "string" ? given.trim() : "(批次号省略，自动生成)"}`;
  assertCommandKeys(input, OPEN_CHANGE_INPUT_KEYS, where);
  const fields = readOpenedFields(
    {
      goal: input.goal,
      authorized_scope: input.authorized_scope,
      target_baseline: input.target_baseline,
      affected_subsystems: input.affected_subsystems,
      exit_criteria: input.exit_criteria,
    },
    "INVALID_COMMAND",
    where,
  );
  const batchId =
    typeof given === "string" && given.trim() !== ""
      ? given
      : autoChangeBatchId({ project_id: input.project_id, ...fields });
  if (!CHANGE_ID_RE.test(batchId)) {
    badCommand(`变更批次 id 形态不合法：${JSON.stringify(batchId)}（必须是 ${CHANGE_ID_RE}）`, { change_batch_id: batchId });
  }
  const changeId = typeof input.change_id === "string" && input.change_id.trim() !== "" ? input.change_id.trim() : batchId;
  return submitChangeEvent(submitter, {
    project_id: input.project_id,
    change_batch_id: batchId,
    change_id: changeId,
    actor_id: input.actor_id,
    role: input.role,
    type: "change.opened",
    expected_revision: null,
    payload: { ...fields },
    ...(input.occurred_at === undefined ? {} : { occurred_at: input.occurred_at }),
  });
}

export interface ChangeStatusChangeInput extends ChangeEventInput {
  status: ChangeStatus;
  /** 第几轮迭代（不给则沿用当前轮次） */
  iteration?: number;
  reason?: string;
}

/** `setChangeStatus` 的允许入参键：信封 + `status` / `iteration` / `reason` */
const SET_CHANGE_STATUS_INPUT_KEYS = [...CHANGE_ENVELOPE_INPUT_KEYS, "status", "iteration", "reason"] as const;

/** 改批次状态（含"进第 N 轮迭代"）——每次迭代有独立状态（§2.5） */
export function setChangeStatus(submitter: WorkSubmitter, input: ChangeStatusChangeInput): WorkReceipt {
  assertCommandKeys(input, SET_CHANGE_STATUS_INPUT_KEYS, `改状态 ${input.change_batch_id}`);
  const state = currentChange(submitter, input.change_batch_id, "改状态");
  const status = readChangeStatus(input.status, "INVALID_COMMAND", `改状态 ${input.change_batch_id}`);
  // 已关闭的批次要接着干，就开新一轮迭代/新批次——写侧先挡住，别让一条注定折不过去的事件落盘
  if (state.status === "closed" && status !== "closed") {
    badCommand(
      `变更批次 ${input.change_batch_id} 已关闭，不能再改成 ${status}：接着干请开新一批次/新迭代（每次迭代有独立状态，§2.5）`,
      { change_batch_id: input.change_batch_id, current_status: state.status, status },
    );
  }
  const payload: Record<string, unknown> = { status };
  const iteration = readIteration(input.iteration, "INVALID_COMMAND", `改状态 ${input.change_batch_id}`);
  if (iteration !== null) payload.iteration = iteration;
  if (input.reason !== undefined && input.reason.trim() !== "") payload.reason = input.reason.trim();
  return submitChangeEvent(submitter, {
    ...input,
    type: "change.status_changed",
    expected_revision: state.revision,
    payload,
  });
}

export interface CloseChangeInput extends ChangeEventInput {
  /** 关闭依据（必填：为什么可以说这批收口了） */
  reason: string;
}

/** `closeChange` 的允许入参键：信封 + `reason` */
const CLOSE_CHANGE_INPUT_KEYS = [...CHANGE_ENVELOPE_INPUT_KEYS, "reason"] as const;

/** 关闭批次（`change.closed`） */
export function closeChange(submitter: WorkSubmitter, input: CloseChangeInput): WorkReceipt {
  assertCommandKeys(input, CLOSE_CHANGE_INPUT_KEYS, `关闭 ${input.change_batch_id}`);
  const state = currentChange(submitter, input.change_batch_id, "关闭");
  const reason = readStr(input.reason, "reason", "INVALID_COMMAND", `关闭 ${input.change_batch_id}`);
  return submitChangeEvent(submitter, {
    ...input,
    type: "change.closed",
    expected_revision: state.revision,
    payload: { reason },
  });
}

export interface AdoptChatChangeInput extends ChangeEventInput {
  /** chat-changes.jsonl 里那条记录的标识（那文件里字段名叫 `change_id`，值是 `chg-…`） */
  chat_record_id: string;
  /** 该记录的内容哈希（用 `chatChangeRecordHash` 或 `readChatChangeRecords` 取，别手算） */
  chat_record_sha256: string;
  note?: string;
}

/** `adoptChatChange` 的允许入参键：信封 + `chat_record_id` / `chat_record_sha256` / `note` */
const ADOPT_CHAT_CHANGE_INPUT_KEYS = [
  ...CHANGE_ENVELOPE_INPUT_KEYS,
  "chat_record_id",
  "chat_record_sha256",
  "note",
] as const;

/**
 * 显式采纳一条聊天变更记录（`change.adopted_chat_change`）。
 *
 * 判据（DESIGN.md §2.5/§2.6 + 判词 §六②）：
 *   · **聊天记录不等于变更批次**，这里只是"显式采纳这条关联"，不把它升格成批次对象；
 *   · 记录必须真在 `chat-changes.jsonl` 里（**悬空 id 拒**，错误点名缺的那条）；
 *   · 内容哈希必须与盘上那条一致（**内容变了拒**，说明引用的是另一份内容）；
 *   · **不回写 chat-changes.jsonl**——那份文件仍只由 chatActions 写；这里只往事件流追加一条引用。
 */
export function adoptChatChange(submitter: WorkSubmitter, input: AdoptChatChangeInput): WorkReceipt {
  assertCommandKeys(input, ADOPT_CHAT_CHANGE_INPUT_KEYS, `采纳 ${input.change_batch_id}`);
  const state = currentChange(submitter, input.change_batch_id, "采纳聊天记录");
  const readChatChanges = (submitter as ChangeSubmitter).readChatChanges;
  if (typeof readChatChanges !== "function") {
    throw new WorkError(
      "INVALID_COMMAND",
      "提交者没有给出聊天记录读侧（submitter.readChatChanges）：采纳关联必须按 id + 内容哈希回查 chat-changes.jsonl",
      { reason: "missing_chat_change_reader" },
    );
  }
  const log = readChatChanges();
  if (log.corrupt.length > 0) {
    throw new WorkError(
      "INVALID_COMMAND",
      `chat-changes.jsonl 有坏行（第 ${log.corrupt.map((c) => c.line).join("、")} 行）：先处理坏行再采纳，不在坏记录上建关联`,
      { corrupt: log.corrupt, reason: "chat_change_log_corrupt" },
    );
  }
  const recordId = readStr(input.chat_record_id, "chat_record_id", "INVALID_COMMAND", `采纳 ${input.change_batch_id}`);
  if (state.adopted_chat_changes.some((a) => a.chat_record_id === recordId)) {
    badCommand(
      `聊天记录 ${recordId} 已被批次 ${input.change_batch_id} 采纳过：重复采纳不产生第二次效果（引用是幂等的）`,
      { chat_record_id: recordId, change_batch_id: input.change_batch_id, reason: "duplicate_chat_change" },
    );
  }
  const matched = log.records.filter((r) => r.chat_record_id === recordId);
  if (matched.length === 0) {
    throw new WorkError(
      "INVALID_COMMAND",
      `采纳的聊天记录在 chat-changes.jsonl 里不存在：${recordId}（悬空引用拒；聊天记录不因被引用就升格成变更批次）`,
      { chat_record_id: recordId, reason: "dangling_chat_change", known: log.records.map((r) => r.chat_record_id) },
    );
  }
  if (matched.length > 1) {
    throw new WorkError(
      "INVALID_COMMAND",
      `chat-changes.jsonl 里 id ${recordId} 出现 ${matched.length} 条：id 不唯一时无法确定采纳哪一条，拒绝采纳`,
      { chat_record_id: recordId, reason: "ambiguous_chat_change" },
    );
  }
  const record = matched[0];
  const sha = readSha256(input.chat_record_sha256, "chat_record_sha256", "INVALID_COMMAND", `采纳 ${input.change_batch_id}`);
  if (sha !== record.sha256) {
    throw new WorkError(
      "INVALID_COMMAND",
      `采纳的聊天记录内容对不上：${recordId} 给的是 ${sha}，盘上那条是 ${record.sha256}` +
        "（引用的是另一份内容，拒绝采纳——采纳只认「这条记录的这一版内容」）",
      {
        chat_record_id: recordId,
        expected_sha256: record.sha256,
        got_sha256: sha,
        reason: "chat_change_hash_mismatch",
      },
    );
  }
  const payload: Record<string, unknown> = {
    chat_record_id: recordId,
    chat_record_sha256: record.sha256,
  };
  if (input.note !== undefined && input.note.trim() !== "") payload.note = input.note.trim();
  return submitChangeEvent(submitter, {
    ...input,
    type: "change.adopted_chat_change",
    expected_revision: state.revision,
    payload,
  });
}

export interface RecordBlueprintInheritanceInput extends ChangeEventInput, BlueprintInheritancePayload {}

/** `recordBlueprintInheritance` 的允许入参键：信封 + 继承事实的七个字段（多一个都拒） */
const RECORD_BLUEPRINT_INHERITANCE_INPUT_KEYS = [
  ...CHANGE_ENVELOPE_INPUT_KEYS,
  ...BLUEPRINT_INHERITANCE_PAYLOAD_KEYS,
] as const;

/**
 * 登记一条蓝图删除/拆并的合法变更事实（`change.blueprint_inheritance_recorded`，C016 收口第二包，
 * DESIGN §4.1：权威来源 = 已审定图纸基线 + 合法变更事实）。
 *
 * 本命令是**结构与批次状态**闸：payload 过与折叠同一份 `readBlueprintInheritancePayload` 判据
 * （缺键/多键/空白/重复/基数不符/处置明细非法都拒），批次必须真实存在且未关闭。
 * 跨基线/源图/引用覆盖的**语义**闸在 `src/arch/blueprintInheritance.ts#registerBlueprintInheritance`
 * （submit 前完成，非法时零字节）；直连 `WorkService.submit` 的同类事件由服务侧折叠预检守住结构。
 */
export function recordBlueprintInheritance(submitter: WorkSubmitter, input: RecordBlueprintInheritanceInput): WorkReceipt {
  assertCommandKeys(input, RECORD_BLUEPRINT_INHERITANCE_INPUT_KEYS, `登记蓝图继承事实 ${input.change_batch_id}`);
  const state = currentChange(submitter, input.change_batch_id, "登记蓝图继承事实");
  if (state.status === "closed") {
    badCommand(
      `变更批次 ${input.change_batch_id} 已关闭，不能再登记蓝图继承事实：关闭的批次不再授权新的删除/拆并（接着干请开新批次/新迭代，§2.5）`,
      { change_batch_id: input.change_batch_id, current_status: state.status },
    );
  }
  const payload = readBlueprintInheritancePayload(
    {
      kind: input.kind,
      from_baseline: input.from_baseline,
      to_baseline: input.to_baseline,
      predecessor_ids: input.predecessor_ids,
      successor_ids: input.successor_ids,
      affected_node_ids: input.affected_node_ids,
      reference_dispositions: input.reference_dispositions,
    },
    "INVALID_COMMAND",
    `登记蓝图继承事实 ${input.change_batch_id}`,
  );
  return submitChangeEvent(submitter, {
    ...input,
    type: "change.blueprint_inheritance_recorded",
    expected_revision: state.revision,
    payload: { ...payload },
  });
}

/** 读当前批次（不存在就拒，点名 id） */
function currentChange(submitter: WorkSubmitter, changeBatchId: string, what: string): ChangeState {  const current = requireChangeReader(submitter)();
  const state = current.changes[changeBatchId];
  if (state === undefined) {
    badCommand(`变更批次不存在：${changeBatchId}（${what}前先开批次）`, { change_batch_id: changeBatchId });
  }
  return state;
}
