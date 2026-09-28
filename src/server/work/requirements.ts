// 需求对象库（I-1，DESIGN.md §2.5「意图/需求 requirement」＋ §2.6 权威数据与派生内容）。
//
// **单源分工（§2.6 硬口径，必须照着读）**：
//   · 意图正文（用户原话、讨论纪要、聊天记录、设计原文）的**唯一写入源仍是它们各自的事实文件**
//     ——`.工作台/intent.json`、`<会话>.jsonl` 聊天记录、design 原文。本模块**不复制**意图正文，
//     不造第二份可独立修改的意图事实。
//   · 本模块只登记 §2.5 要求的最小结构化字段（来源 / 要解决的问题 / 使用者 / 成功场景 / 排除项 /
//     优先级 / 明确·推断·待确认）＋ 一个**来源引用** `source = {kind, ref}`（ref 指回原处，不搬原文）。
//   · 所以 payload 只收 `REQUIREMENT_PAYLOAD_KEYS` 这几个键，**多一个都拒**：想塞 `intent_text` /
//     `text` / `body` 这类正文拷贝的写法在这里 fail-closed 被点名拒收（错误里直接引 §2.6）。
//   · 稳定 ID：`req-<slug>`，只活在 `entity_id` 里；改措辞走 `requirement.updated`，**ID 不变**
//     （改名/搬位置不换身份，§2.5）。
//
// 事件词表：`requirement.registered` / `requirement.updated` / `requirement.status_changed`——
// 与 task/finding/audit/execution 走**同一条事件流、同一个唯一写入者**，不另造第二事件源（§2.6）。
import { SCHEMA_VERSION, WorkError, type WorkErrorCode, type WorkEvent, type WorkReceipt } from "./types";
import { loadEvents, replayEvents } from "./eventStore";
import { resolveIntentRef, type IntentRefLookup } from "./intent";
import type { WorkSubmitter } from "./tasks";

/** 本模块登记的 v2 需求事件词表（登记面见 `types.ts` 的 `REGISTERED_EVENT_TYPES`） */
export const REQUIREMENT_EVENT_TYPES = [
  "requirement.registered",
  "requirement.updated",
  "requirement.status_changed",
] as const;
export type RequirementEventType = (typeof REQUIREMENT_EVENT_TYPES)[number];

/** 明确 / 推断 / 待确认（DESIGN.md §2.5：事实、推断与待确认分开，不把推断写成事实） */
export const REQUIREMENT_STATUSES = ["explicit", "inferred", "unconfirmed"] as const;
export type RequirementStatus = (typeof REQUIREMENT_STATUSES)[number];

export const REQUIREMENT_STATUS_LABELS: Readonly<Record<RequirementStatus, string>> = {
  explicit: "明确",
  inferred: "推断",
  unconfirmed: "待确认",
};

/** 来源引用的种类（ref 指回原处：意图文件条目 / 聊天会话行 / 设计章节 / 决定记录 / 用户口述 / 外部材料） */
export const REQUIREMENT_SOURCE_KINDS = ["intent", "chat", "design", "decision", "user", "external"] as const;
export type RequirementSourceKind = (typeof REQUIREMENT_SOURCE_KINDS)[number];

/**
 * 来源**引用**（不是正文拷贝）：`kind` 说明原处是什么，`ref` 是可回查的位置
 * （如 `intent.json#<条目 id>`、`chat:20260919-152149-ab443cc8#12`、`DESIGN.md §2.5`）。
 */
export interface RequirementSource {
  kind: RequirementSourceKind;
  ref: string;
}

/**
 * `requirement.registered` / `requirement.updated` 收的键——就是 §2.5 的最小字段集，多一个都不收。
 * 这是 §2.6 单源分工在代码里的落点：意图正文没有位置可放。
 */
export const REQUIREMENT_PAYLOAD_KEYS = [
  "source",
  "problem",
  "users",
  "success_scenarios",
  "exclusions",
  "priority",
  "status",
] as const;

/** 稳定 id 形态：`req-` + 非空白、不含路径分隔符（允许中文 slug，改名不换 id） */
export const REQUIREMENT_ID_RE = /^req-[^\s/\\]{1,80}$/;

export const requirementEntityId = (requirementId: string): string => `requirement:${requirementId}`;
export const requirementIdOfEntity = (entityId: string): string | null =>
  entityId.startsWith("requirement:") ? entityId.slice("requirement:".length) : null;

/** 把 slug 归一成稳定 id（`扫描取消` → `req-扫描取消`）；归不出合法 id 直接拒，不悄悄发一个假 id */
export function requirementIdFromSlug(slug: string): string {
  const normalized = slug.trim().toLowerCase().replace(/[\s/\\]+/g, "-");
  const id = normalized.startsWith("req-") ? normalized : `req-${normalized}`;
  if (!REQUIREMENT_ID_RE.test(id)) {
    throw new WorkError(
      "INVALID_COMMAND",
      `需求 slug 归一不成合法 id（${JSON.stringify(slug)} → ${JSON.stringify(id)}）：id 必须是 ${REQUIREMENT_ID_RE} 形态`,
      { slug, id },
    );
  }
  return id;
}

// ── 状态投影（纯派生：删掉可全量重放） ──

export interface RequirementHistoryEntry {
  at: string;
  type: string;
  actor: string;
  status: RequirementStatus;
  note: string | null;
}

/** 一条需求由**已提交事件**推出的状态（DESIGN.md §2.5 最小字段 + 投影元数据） */
export interface RequirementState {
  requirement_id: string;
  /** 来源引用（§2.6：只引用原处，不搬意图正文） */
  source: RequirementSource;
  problem: string;
  users: string[];
  success_scenarios: string[];
  exclusions: string[];
  priority: string;
  status: RequirementStatus;
  status_label: string;
  /** 事件信封上的变更批次（未挂批次时为 null，见 `NO_CHANGE_ID`） */
  change_id: string | null;
  history: RequirementHistoryEntry[];
  /** 事件实体版本（1 起） */
  revision: number;
  seq: number;
  last_event_id: string;
  updated_at: string;
  last_actor: string;
}

export interface RequirementProjection {
  requirements: Record<string, RequirementState>;
  last_seq: number;
  /** 事件里出现但不算需求实体的实体，如实报出便于排查 */
  ignored_entities: string[];
}

function badEvent(message: string, detail: Record<string, unknown> = {}): never {
  throw new WorkError("EVENT_INVALID", `需求事件不合法：${message}`, detail);
}

function badCommand(message: string, detail: Record<string, unknown> = {}): never {
  throw new WorkError("INVALID_COMMAND", `需求命令不合法：${message}`, detail);
}

/** 命令侧 / 事件侧共用的字段读取（同一套口径，两种错误码）：读侧坏数据报 EVENT_INVALID，写侧报 INVALID_COMMAND */
function failWith(
  code: WorkErrorCode,
  where: string,
  message: string,
  detail: Record<string, unknown> = {},
): never {
  if (code === "EVENT_INVALID") return badEvent(`${message}（${where}）`, { where, ...detail });
  return badCommand(`${message}（${where}）`, { where, ...detail });
}

/**
 * 最小字段集守卫：多一个键就拒。
 * 这不是"顺手严格"——`intent_text` / `text` / `body` 这类键正是"第二份可独立修改的意图事实"的入口，
 * §2.6 说意图正文的唯一写入源是 intent.json / 聊天记录 / 设计原文，所以这里必须 fail-closed。
 */
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
    `需求对象只收 §2.5 的最小结构化字段（${allowed.join(" / ")}），多出来的键一律拒：${extra.join("、")}。` +
      "意图正文的唯一写入源仍是 .工作台/intent.json / 聊天记录 / 设计原文（DESIGN.md §2.6），" +
      "这里只存注册与来源引用，不造第二份可独立修改的意图事实",
    { extra, allowed },
  );
}

/**
 * 入参级闭键守卫：公共写命令的**整个入参对象**只收该命令声明的键，多一个键就拒。
 * 与 `assertMinimalKeys`（payload 级）分工不同：那个管事件 payload 装什么，这个管调用方递进来的命令对象。
 * 入参里混进 `intent_text` / `text` / `body` 这类键，若不在这里拦住，就会被"显式挑键"悄悄丢掉、
 * 却仍返回成功回执——调用方以为存了、其实没存（违反 fail-closed）。
 * §2.6 说意图正文的唯一写入源是 intent.json / 聊天记录 / 设计原文，所以这里必须把"只收这些键"讲明白。
 */
function assertCommandKeys(input: object, allowed: readonly string[], where: string): void {
  const extra = Object.keys(input).filter((k) => !allowed.includes(k));
  if (extra.length === 0) return;
  failWith(
    "INVALID_COMMAND",
    where,
    `入参只收这些键（${allowed.join(" / ")}），多出来的键一律拒：${extra.join("、")}。` +
      "意图正文的唯一写入源仍是 .工作台/intent.json / 聊天记录 / 设计原文（DESIGN.md §2.6 单源分工），" +
      "这里只存结构化注册与来源引用，不造第二份可独立修改的意图事实",
    { extra, allowed },
  );
}

function readSource(value: unknown, code: WorkErrorCode, where: string): RequirementSource {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    failWith(code, where, "payload.source 必须是 {kind, ref} 的来源引用（不是意图正文）", { got: value });
  }
  const raw = value as Record<string, unknown>;
  const extra = Object.keys(raw).filter((k) => k !== "kind" && k !== "ref");
  if (extra.length > 0) {
    failWith(code, where, `payload.source 只收 kind / ref 两个键，多出来的拒：${extra.join("、")}`, { extra });
  }
  const kind = raw.kind;
  if (typeof kind !== "string" || !REQUIREMENT_SOURCE_KINDS.includes(kind as RequirementSourceKind)) {
    failWith(code, where, `payload.source.kind 必须是 ${REQUIREMENT_SOURCE_KINDS.join("/")} 之一`, { kind });
  }
  const ref = raw.ref;
  if (typeof ref !== "string" || ref.trim() === "") {
    failWith(code, where, "payload.source.ref 必须是非空位置引用（指回原处，如 intent.json#<条目 id>）", { ref });
  }
  return { kind: kind as RequirementSourceKind, ref: (ref as string).trim() };
}

function readStr(value: unknown, field: string, code: WorkErrorCode, where: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    failWith(code, where, `payload.${field} 必须是非空字符串`, { field, got: value });
  }
  return (value as string).trim();
}

/** 列表字段：键必须在场且是字符串数组（空数组 = 明确"已确认没有"，与"没给"不是一回事） */
function readStrList(value: unknown, field: string, code: WorkErrorCode, where: string): string[] {
  if (!Array.isArray(value)) {
    failWith(code, where, `payload.${field} 必须是字符串数组（空数组表示已确认该项为空，不能省略该键）`, {
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

function readStatus(value: unknown, code: WorkErrorCode, where: string): RequirementStatus {
  if (typeof value !== "string" || !REQUIREMENT_STATUSES.includes(value as RequirementStatus)) {
    failWith(code, where, `payload.status 必须是 ${REQUIREMENT_STATUSES.join("/")} 之一（明确/推断/待确认）`, {
      status: value,
    });
  }
  return value as RequirementStatus;
}

/** 注册时的完整字段（§2.5 七个字段全在场） */
interface RequirementFields {
  source: RequirementSource;
  problem: string;
  users: string[];
  success_scenarios: string[];
  exclusions: string[];
  priority: string;
  status: RequirementStatus;
}

function readRegisteredFields(payload: Record<string, unknown>, code: WorkErrorCode, where: string): RequirementFields {
  assertMinimalKeys(payload, REQUIREMENT_PAYLOAD_KEYS, code, where);
  const missing = REQUIREMENT_PAYLOAD_KEYS.filter((k) => payload[k] === undefined);
  if (missing.length > 0) {
    failWith(code, where, `§2.5 的最小字段没给全，缺：${missing.join("、")}（缺字段按缺字段拒，不用默认值冒充）`, {
      missing,
    });
  }
  return {
    source: readSource(payload.source, code, where),
    problem: readStr(payload.problem, "problem", code, where),
    users: readStrList(payload.users, "users", code, where),
    success_scenarios: readStrList(payload.success_scenarios, "success_scenarios", code, where),
    exclusions: readStrList(payload.exclusions, "exclusions", code, where),
    priority: readStr(payload.priority, "priority", code, where),
    status: readStatus(payload.status, code, where),
  };
}

/** 更新时的部分字段（至少给一个，给的字段逐个按同一口径校验） */
function readUpdatedFields(
  payload: Record<string, unknown>,
  code: WorkErrorCode,
  where: string,
): Partial<RequirementFields> {
  assertMinimalKeys(payload, REQUIREMENT_PAYLOAD_KEYS, code, where);
  const patch: Partial<RequirementFields> = {};
  if (payload.source !== undefined) patch.source = readSource(payload.source, code, where);
  if (payload.problem !== undefined) patch.problem = readStr(payload.problem, "problem", code, where);
  if (payload.users !== undefined) patch.users = readStrList(payload.users, "users", code, where);
  if (payload.success_scenarios !== undefined) {
    patch.success_scenarios = readStrList(payload.success_scenarios, "success_scenarios", code, where);
  }
  if (payload.exclusions !== undefined) patch.exclusions = readStrList(payload.exclusions, "exclusions", code, where);
  if (payload.priority !== undefined) patch.priority = readStr(payload.priority, "priority", code, where);
  if (payload.status !== undefined) patch.status = readStatus(payload.status, code, where);
  if (Object.keys(patch).length === 0) {
    failWith(
      code,
      where,
      `requirement.updated 至少要给一个要改的字段（一列出来：${REQUIREMENT_PAYLOAD_KEYS.join(" / ")}）`,
    );
  }
  return patch;
}

function emptyRequirement(requirementId: string): RequirementState {
  return {
    requirement_id: requirementId,
    source: { kind: "external", ref: "" },
    problem: "",
    users: [],
    success_scenarios: [],
    exclusions: [],
    priority: "",
    status: "unconfirmed",
    status_label: REQUIREMENT_STATUS_LABELS.unconfirmed,
    change_id: null,
    history: [],
    revision: 0,
    seq: 0,
    last_event_id: "",
    updated_at: "",
    last_actor: "",
  };
}

/**
 * 从事件重放需求对象（纯函数）。
 * 口径：首条必须是 `requirement.registered`；`requirement.updated` / `requirement.status_changed`
 * 只能推进已注册的需求；未知的 `requirement.*` 类型**点名报错**，不静默跳过。
 */
export function foldRequirements(events: WorkEvent[]): RequirementProjection {
  const requirements: Record<string, RequirementState> = {};
  const ignored = new Set<string>();
  // 先跑一遍结构性重放（seq 无洞 / revision 连续 / 幂等键唯一），坏现场绝不静默跳过
  const { last_seq } = replayEvents(events);

  for (const e of events) {
    const requirementId = requirementIdOfEntity(e.entity_id);
    if (requirementId === null) {
      ignored.add(e.entity_id);
      continue;
    }
    if (requirementId === "") {
      badEvent(`实体 id 缺 requirement_id（事件 ${e.event_id}）`, { event_id: e.event_id });
    }
    if (!(REQUIREMENT_EVENT_TYPES as readonly string[]).includes(e.type)) {
      badEvent(`未知需求事件类型 ${JSON.stringify(e.type)}（事件 ${e.event_id}）`, {
        event_id: e.event_id,
        type: e.type,
      });
    }
    const type = e.type as RequirementEventType;
    const where = `事件 ${e.event_id}`;
    const prev = requirements[requirementId];
    if (type === "requirement.registered") {
      if (prev !== undefined) {
        badEvent(`需求 ${requirementId} 重复注册（事件 ${e.event_id}）——注册一次，之后走 updated`, {
          event_id: e.event_id,
          requirement_id: requirementId,
        });
      }
      const fields = readRegisteredFields(e.payload, "EVENT_INVALID", where);
      requirements[requirementId] = {
        ...emptyRequirement(requirementId),
        ...fields,
        status_label: REQUIREMENT_STATUS_LABELS[fields.status],
        change_id: e.change_id,
        history: [{ at: e.received_at, type, actor: e.actor_id, status: fields.status, note: null }],
        revision: e.entity_revision,
        seq: e.seq,
        last_event_id: e.event_id,
        updated_at: e.received_at,
        last_actor: e.actor_id,
      };
      continue;
    }
    if (prev === undefined) {
      badEvent(`需求 ${requirementId} 的首条事件是 ${type}——必须先 requirement.registered`, {
        event_id: e.event_id,
        requirement_id: requirementId,
      });
    }
    const next: RequirementState = {
      ...prev,
      change_id: e.change_id,
      revision: e.entity_revision,
      seq: e.seq,
      last_event_id: e.event_id,
      updated_at: e.received_at,
      last_actor: e.actor_id,
    };
    let note: string | null = null;
    if (type === "requirement.updated") {
      const patch = readUpdatedFields(e.payload, "EVENT_INVALID", where);
      Object.assign(next, patch);
      next.status_label = REQUIREMENT_STATUS_LABELS[next.status];
      note = Object.keys(patch).join("、");
    } else {
      // status_changed 与 registered/updated 同一闭键口径（写侧只放 status/reason）：
      // 多余键（intent_text 等）在读侧一样点名拒，不静默容忍（与 changes.ts 三条闭键同款）
      assertMinimalKeys(e.payload, ["status", "reason"], "EVENT_INVALID", where);
      const status = readStatus(e.payload.status, "EVENT_INVALID", where);
      next.status = status;
      next.status_label = REQUIREMENT_STATUS_LABELS[status];
      note = typeof e.payload.reason === "string" && e.payload.reason.trim() !== "" ? e.payload.reason.trim() : null;
    }
    next.history = [...prev.history, { at: e.received_at, type, actor: e.actor_id, status: next.status, note }];
    requirements[requirementId] = next;
  }
  return { requirements, last_seq, ignored_entities: [...ignored].sort() };
}

/** 从磁盘事件文件读并折叠需求对象（读路径；中段损坏会抛，不吞） */
export function readRequirements(workDir: string): RequirementProjection {
  const { events } = loadEvents(workDir);
  return foldRequirements(events);
}

/** 需求 id 升序（供跨对象引用校验点名用） */
export function requirementIdsOf(projection: RequirementProjection): string[] {
  return Object.keys(projection.requirements).sort();
}

// ── 写入（唯一写入者：提交事件，不绕开） ──

export interface RequirementEventInput {
  project_id: string;
  requirement_id: string;
  /** 变更批次上下文（事件信封的 change_id，必填非空；不挂批次用 `NO_CHANGE_ID`） */
  change_id: string;
  actor_id: string;
  role: string;
  occurred_at?: string;
}

/** 公共写命令的入参信封键（与 `RequirementEventInput` 一一对应；`occurred_at` 可选） */
const REQUIREMENT_ENVELOPE_INPUT_KEYS = [
  "project_id",
  "requirement_id",
  "change_id",
  "actor_id",
  "role",
  "occurred_at",
] as const;

/** 幂等键：批次 + 实体 + 事件序号位（同键同内容才返回原回执，见 v2 契约） */
export function requirementEventIdempotencyKey(
  input: RequirementEventInput & { type: RequirementEventType; expected_revision: number | null },
): string {
  const rev = input.expected_revision === null ? 0 : input.expected_revision;
  return `${input.requirement_id}:${input.type}:${rev + 1}:${input.change_id}`;
}

function submitRequirementEvent(
  submitter: WorkSubmitter,
  input: RequirementEventInput & {
    type: RequirementEventType;
    expected_revision: number | null;
    payload: Record<string, unknown>;
  },
): WorkReceipt {
  return submitter.submit({
    schema_version: SCHEMA_VERSION,
    project_id: input.project_id,
    change_id: input.change_id,
    entity_id: requirementEntityId(input.requirement_id),
    expected_revision: input.expected_revision,
    type: input.type,
    actor_id: input.actor_id,
    role: input.role,
    idempotency_key: requirementEventIdempotencyKey(input),
    ...(input.occurred_at === undefined ? {} : { occurred_at: input.occurred_at }),
    payload: input.payload,
  });
}

/** 读侧闭包（`updateRequirement` / `setRequirementStatus` 要先读当前版本；本模块不猜项目路径） */
export interface RequirementReadSource {
  read: () => { requirements: Record<string, RequirementState> };
  /**
   * 项目 `.工作台/` 目录（`intent.json` 就在这一层，§2.6）：核 `source.kind="intent"` 的引用有效性要用它。
   * 路径同样**由调用方给**（本模块不猜项目位置）；给不出＝核不了 ⇒ 按核不了 fail-closed 拒（见 `assertIntentSourceResolvable`）。
   */
  workbenchDir?: string;
}
export type RequirementSubmitter = WorkSubmitter & Partial<RequirementReadSource>;

function currentRequirements(submitter: WorkSubmitter): { requirements: Record<string, RequirementState> } {
  const reader = (submitter as RequirementSubmitter).read;
  if (typeof reader !== "function") {
    throw new WorkError(
      "INVALID_COMMAND",
      "提交者没有给出需求读侧（submitter.read）：更新/改状态都要先读当前版本，不能靠「我以为是那个版本」",
      { reason: "missing_requirement_reader" },
    );
  }
  return reader();
}

/**
 * **意图来源引用有效性判据（单一出处）**：`source.kind === "intent"` 时，对给定的项目 `.工作台/`
 * 用 `resolveIntentRef` 做**实解析**——文件不在／条目不在／ref 形态不对都点名拒，文件在场但不合法由
 * `readIntentFile` 抛（同族 fail-closed）。调用方必须给出**该项目**的 `.工作台/` 目录；给不出（`null`）
 * 就是"核不了"，按核不了拒，不凭"我以为是那条"放行（§2.5 引用有效性、原子拒绝）。
 *
 * **两个调用方共用这一个函数，不各写一套**：
 *   · 对象命令侧 `registerRequirement` / `updateRequirement`（见下面的 `assertIntentSourceResolvable` 适配器，
 *     路径由提交者的 `workbenchDir` 给）；
 *   · 唯一写入服务边界 `service.ts`（直连 `WorkService.submit` 的 `requirement.registered/updated`，
 *     路径由注册表解析⇒绕过对象命令也不能旁路，DESIGN.md §2.5「一致校验面」）。
 *
 * 只管 `kind="intent"`：其他 kind 的原文源（聊天记录／设计原文／决定记录／用户口述／外部材料）各有各的
 * 事实文件与校验归属，本轮不在这里替它们下结论（§2.6 一事一源；不顺手把别人的校验也抄一份进来）。
 * 读侧重放（`foldRequirements`）**不**做这道校验：已提交的事件是事实，回放历史不该因为原文后来被删而崩
 * （§2.5「旧数据与回放」），校验只落在写入前的命令侧与服务边界。
 */
export function assertIntentSourceValid(
  source: RequirementSource,
  workbenchDir: string | null,
  where: string,
): void {
  if (source.kind !== "intent") return;
  function reject(detail: Record<string, unknown>, message: string): never {
    throw new WorkError("INVALID_COMMAND", `意图来源引用核不过（${where}）：${message}`, {
      where,
      ref: source.ref,
      ...detail,
    });
  }
  if (workbenchDir === null || workbenchDir.trim() === "") {
    reject(
      { reason: "missing_intent_workbench_dir" },
      `来源是意图原文（ref=${source.ref}），但调用方没有给出项目 .工作台/ 目录（submitter.workbenchDir）：` +
        "核不了引用有效性就不放行（§2.5：引用必须有效、原子拒绝；不凭「我以为是那条」先写后补）",
    );
  }
  let lookup: IntentRefLookup;
  try {
    lookup = resolveIntentRef(workbenchDir, source.ref);
  } catch (e) {
    // 文件在场但不是合法意图原文：照原样报（不降级成"悬空"，也不当空文件糊过去）
    reject({ reason: "intent_file_invalid" }, `意图原文文件核不过：${(e as Error).message}`);
  }
  if (lookup.status === "found") return;
  reject(
    {
      reason: `intent_ref_${lookup.status}`,
      intent_file: lookup.locator,
      known_ids: lookup.known_ids,
    },
    lookup.status === "not_found"
      ? `来源引用悬空：${lookup.problem}`
      : `来源引用核不过：${lookup.problem}`,
  );
}

/** 对象命令侧的薄适配器：路径取自提交者的 `workbenchDir`（本模块不猜项目位置），判据仍走上面那一个 */
function assertIntentSourceResolvable(submitter: WorkSubmitter, source: RequirementSource, where: string): void {
  if (source.kind !== "intent") return;
  const workbenchDir = (submitter as RequirementSubmitter).workbenchDir;
  assertIntentSourceValid(source, typeof workbenchDir === "string" ? workbenchDir : null, where);
}

export interface RegisterRequirementInput extends RequirementEventInput, RequirementFields {}

/** `registerRequirement` 的允许入参键：信封 + §2.5 七个字段（与 interface 字段一一对应，多一个都拒） */
const REGISTER_REQUIREMENT_INPUT_KEYS = [
  ...REQUIREMENT_ENVELOPE_INPUT_KEYS,
  ...REQUIREMENT_PAYLOAD_KEYS,
] as const;

/**
 * 注册一条需求（首条 `requirement.registered`）。
 * 字段口径就是 §2.5 的最小集，多一个键都拒（见 `assertMinimalKeys` / `assertCommandKeys` 的 §2.6 说明）。
 */
export function registerRequirement(submitter: WorkSubmitter, input: RegisterRequirementInput): WorkReceipt {
  assertCommandKeys(input, REGISTER_REQUIREMENT_INPUT_KEYS, `注册 ${input.requirement_id}`);
  if (!REQUIREMENT_ID_RE.test(input.requirement_id)) {
    badCommand(`需求 id 形态不合法：${JSON.stringify(input.requirement_id)}（必须是 ${REQUIREMENT_ID_RE}）`, {
      requirement_id: input.requirement_id,
    });
  }
  const fields = readRegisteredFields(
    {
      source: input.source,
      problem: input.problem,
      users: input.users,
      success_scenarios: input.success_scenarios,
      exclusions: input.exclusions,
      priority: input.priority,
      status: input.status,
    },
    "INVALID_COMMAND",
    `注册 ${input.requirement_id}`,
  );
  // 字段形态过了再核引用有效性：悬空/核不了的意图引用在动磁盘之前拒（§2.5 引用有效性、原子拒绝）
  assertIntentSourceResolvable(submitter, fields.source, `注册 ${input.requirement_id}`);
  return submitRequirementEvent(submitter, {
    ...input,
    type: "requirement.registered",
    expected_revision: null,
    payload: { ...fields },
  });
}

export interface UpdateRequirementInput extends RequirementEventInput {
  /** 要改的字段（至少一个；键集合同 §2.5 最小字段集） */
  fields: Record<string, unknown>;
}

/** `updateRequirement` 的允许入参键：信封 + `fields`（字段本身再由 `readUpdatedFields` 把关） */
const UPDATE_REQUIREMENT_INPUT_KEYS = [...REQUIREMENT_ENVELOPE_INPUT_KEYS, "fields"] as const;

/** 改需求字段（措辞、来源引用、优先级……）。**稳定 ID 不变**——改的是内容，不是身份（§2.5）。 */
export function updateRequirement(submitter: WorkSubmitter, input: UpdateRequirementInput): WorkReceipt {
  assertCommandKeys(input, UPDATE_REQUIREMENT_INPUT_KEYS, `更新 ${input.requirement_id}`);
  const current = currentRequirements(submitter);
  const state = current.requirements[input.requirement_id];
  if (state === undefined) {
    badCommand(`需求不存在：${input.requirement_id}（先注册，再更新）`, { requirement_id: input.requirement_id });
  }
  const patch = readUpdatedFields(input.fields, "INVALID_COMMAND", `更新 ${input.requirement_id}`);
  // 改来源引用同样要核（改 ref 也要实解析；不核放行等于换条悬空引用再写进去）
  if (patch.source !== undefined) {
    assertIntentSourceResolvable(submitter, patch.source, `更新 ${input.requirement_id}`);
  }
  return submitRequirementEvent(submitter, {
    ...input,
    type: "requirement.updated",
    expected_revision: state.revision,
    payload: { ...patch },
  });
}

export interface RequirementStatusChangeInput extends RequirementEventInput {
  status: RequirementStatus;
  reason?: string;
}

/** `setRequirementStatus` 的允许入参键：信封 + `status` / `reason` */
const SET_REQUIREMENT_STATUS_INPUT_KEYS = [...REQUIREMENT_ENVELOPE_INPUT_KEYS, "status", "reason"] as const;

/** 改「明确/推断/待确认」——把推断写成事实、或把待确认当已确认，都在这里挡住（§2.5） */
export function setRequirementStatus(
  submitter: WorkSubmitter,
  input: RequirementStatusChangeInput,
): WorkReceipt {
  assertCommandKeys(input, SET_REQUIREMENT_STATUS_INPUT_KEYS, `改状态 ${input.requirement_id}`);
  const current = currentRequirements(submitter);
  const state = current.requirements[input.requirement_id];
  if (state === undefined) {
    badCommand(`需求不存在：${input.requirement_id}（先注册，再改状态）`, { requirement_id: input.requirement_id });
  }
  const status = readStatus(input.status, "INVALID_COMMAND", `改状态 ${input.requirement_id}`);
  const payload: Record<string, unknown> = { status };
  if (input.reason !== undefined && input.reason.trim() !== "") payload.reason = input.reason.trim();
  return submitRequirementEvent(submitter, {
    ...input,
    type: "requirement.status_changed",
    expected_revision: state.revision,
    payload,
  });
}
