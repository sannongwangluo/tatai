// 塔台 v2 事实写入协议：形状与校验（PLAN.md V06-01，DESIGN.md §2.6 / §6.5）。
//
// 本文件只回答"一份命令/事件/回执/快照长什么样、什么算不合法"。
// 落盘与重放在 `eventStore.ts`，单写入仲裁与传输在 `service.ts`；
// 契约的人话版本与每个错误码的恢复办法见 `docs/work-v2-contract.md`。
//
// 设计依据（DESIGN.md §2.6 事件最小信封）：
//   schema_version/event_id/project_id/change_id/entity_id/entity_revision/seq/
//   type/actor_id/role/occurred_at/received_at/idempotency_key/payload
//
// 本卡只固化"信封 + 版本 + 幂等 + 错误格式"，不定义业务事件词表——
// 任务/证据/基线等具体 `type` 由 V06-02/V06-03/V06-09 各自登记，这里只做通用合法性校验。

/** 当前事实格式版本（DESIGN.md §2.6：先发布 v2 规范与兼容读取器，再迁移） */
export const SCHEMA_VERSION = 2 as const;

/** 错误码全集（PLAN.md V06-01 契约要求至少这四个；后三个是本卡实现必需的现场语义） */
export type WorkErrorCode =
  /** 命令本身不合法（缺字段/类型错/越界/未知 schema_version）：一个字节都没写 */
  | "INVALID_COMMAND"
  /** 写入者持有的是旧版本：实体已被别人推进，本次不覆盖（附当前版本与差异入口） */
  | "VERSION_CONFLICT"
  /** 幂等键已存在但内容不同：明确拒绝，不产生第二次效果 */
  | "IDEMPOTENCY_CONFLICT"
  /** 写入服务不可用（未启动/不可达）：写入报不可用，读取退化为最后快照并标陈旧 */
  | "SERVICE_UNAVAILABLE"
  /** 事件已提交、投影（快照）失败：回执仍成立，但必须如实标记、可用重放修复 */
  | "PROJECTION_FAILED"
  /** 事件文件尾部是半截行（上次写到一半被杀）：已隔离并记录，未静默吞掉 */
  | "TAIL_QUARANTINED"
  /** 事件文件中段损坏（不是尾行）：必须暴露，不得跳过继续 */
  | "MIDDLE_CORRUPT"
  /** 事件文件里的信封不符合 §2.6 字段口径 */
  | "EVENT_INVALID"
  /** 证据不可用：引用了不存在的证据/内容与内容地址不符/试图改写不可变证据（V06-09） */
  | "EVIDENCE_INVALID";

export const WORK_ERROR_CODES: readonly WorkErrorCode[] = [
  "INVALID_COMMAND",
  "VERSION_CONFLICT",
  "IDEMPOTENCY_CONFLICT",
  "SERVICE_UNAVAILABLE",
  "PROJECTION_FAILED",
  "TAIL_QUARANTINED",
  "MIDDLE_CORRUPT",
  "EVENT_INVALID",
  "EVIDENCE_INVALID",
];

/** 结构化错误：调用方按 code 分支，不靠解析 message */
export class WorkError extends Error {
  readonly code: WorkErrorCode;
  readonly detail: Record<string, unknown>;

  constructor(code: WorkErrorCode, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = "WorkError";
    this.code = code;
    this.detail = detail;
  }

  /** 传给 HTTP / MCP 的稳定错误体（message 已足够可读，不再拼内部栈） */
  toJSON(): { code: WorkErrorCode; message: string; detail: Record<string, unknown> } {
    return { code: this.code, message: this.message, detail: this.detail };
  }
}

export function isWorkError(e: unknown): e is WorkError {
  return e instanceof WorkError;
}

// ── 业务事件词表登记面（V06-03 / V06-09 / V06-11） ──
//
// 这里只是**登记**：谁家的词、实体 id 前缀、payload 口径一句话。v2 的 `type` 仍是开放词法
// （`TYPE_RE`），未登记的类型照旧按信封校验放行——**不在这里做强制白名单**，
// 否则会改掉 V06-01 已有的写入行为（验证脚本里也在直接提交未登记类型）。
// 各业务模块自己的词表常量（`tasks.TASK_EVENT_TYPES` / `evidence.FINDING_EVENT_TYPES` /
// `audit.AUDIT_EVENT_TYPES` / `executionReceipts.EXECUTION_EVENT_TYPES` /
// `requirements.REQUIREMENT_EVENT_TYPES` / `changes.CHANGE_EVENT_TYPES`）是事实源；
// 本表与它们的一致性由 `verify-v06-09` 断言（漂移会红）。**2026-09-20 父代理裁定**：
// V06-11 的执行词表并入本表（登记面=能力发现，缺一块就是产品层的真实不一致）；
// 同日 T21 的需求/变更批次两套词表同样并入（同一口径：登记面 = 全部模块词表的并集）。

export interface EventTypeRegistration {
  type: string;
  /** 登记方（施工卡） */
  owner: string;
  /** 实体 id 前缀 */
  entity_prefix: string;
  /** payload 口径一句话 */
  payload: string;
}

export const REGISTERED_EVENT_TYPES: readonly EventTypeRegistration[] = [
  { type: "task.definition_imported", owner: "V06-03", entity_prefix: "task:", payload: "definition_sha256/plan_revision/definition_revision（只刷新定义绑定）；C-015 复核返修起携带 requirement_ids/definition_change_id（null=如实声明无引用；两键都不在=旧形态，服务边界不查）" },
  { type: "task.status_changed", owner: "V06-03", entity_prefix: "task:", payload: "status ∈ 七个执行状态" },
  { type: "task.claimed", owner: "V06-03", entity_prefix: "task:", payload: "run_id/attempt_id/owner_id/claim_token/lease_expires_at" },
  { type: "task.result_submitted", owner: "V06-03", entity_prefix: "task:", payload: "——（只表示执行者已交结果）；补修 F3 起可带可选 runtime_entries[]（可体验运行入口，只收 http(s)）" },
  { type: "task.blocked", owner: "V06-03", entity_prefix: "task:", payload: "reason" },
  { type: "task.cancelled", owner: "V06-03", entity_prefix: "task:", payload: "reason" },
  { type: "task.rebound", owner: "V06-03", entity_prefix: "task:", payload: "from/to 定义哈希、to_plan_revision、disposition" },
  { type: "task.reopened", owner: "V09-10", entity_prefix: "task:", payload: "attempt/run_id/attempt_id/workspace/reason/reopen_basis[]/previous_result{seq,event_id,run_id,attempt_id}/definition_sha256/baseline_id（协调器受控重开，附录 F；闭键多键拒）" },
  { type: "finding.opened", owner: "V06-09", entity_prefix: "finding:", payload: "dedupe_key/severity/source/expected/actual/repro/evidence_sha256/affected_revision/object_id/duplicate_of" },
  { type: "finding.reported_again", owner: "V06-09", entity_prefix: "finding:", payload: "source/note（同指纹再次上报，不产生第二条缺陷）" },
  { type: "finding.transition", owner: "V06-09", entity_prefix: "finding:", payload: "to/reviewer/duplicate_of/note/retest_evidence" },
  { type: "finding.fix_submitted", owner: "V06-09", entity_prefix: "finding:", payload: "fix_revision/evidence_sha256（→ 已修复待复测，不自关闭）" },
  { type: "finding.retest_recorded", owner: "V06-09", entity_prefix: "finding:", payload: "retested_by/retest_evidence/result/rerepro_gone/regression_scope" },
  { type: "finding.accepted_risk", owner: "V06-09", entity_prefix: "finding:", payload: "accepted_by/basis/scope_revision/review_condition（role 必须是 user）" },
  { type: "audit.submission_submitted", owner: "V06-09", entity_prefix: "submission:", payload: "goal/baseline/diff/commands/untested/known_issues/evidence_refs/binding（补修 F 可选 runtime_entries：场景/入口/验证时间/结果或不可用原因）" },
  { type: "audit.self_check_recorded", owner: "V06-09", entity_prefix: "check:", payload: "checked_by/checks[]{check_id,method,command,exit_code,output_ref,evidence_sha256,scope,verifies}/coverage[]/method_limits/conclusion/binding（独立性固定 author_self；scope 为补修 C 可选字段；coverage/method_limits 为 V09-01 可选字段；**verifies 对新写入的通过检查必填**（写侧拒收缺失，历史不追溯），见附录 E.3.2／E.3.3）" },
  { type: "audit.independent_audit_recorded", owner: "V06-09", entity_prefix: "audit:", payload: "auditor/independence/checks[]{check_id,result,evidence_sha256,scope}/coverage[]/findings/not_reported_scope/binding（scope 为补修 C 可选字段）" },
  { type: "audit.fix_recorded", owner: "V06-09", entity_prefix: "fix:", payload: "finding_id/fix_revision/fixed_by/regression[]" },
  { type: "audit.retest_recorded", owner: "V06-09", entity_prefix: "retest:", payload: "finding_id/retested_by/retest_evidence/result" },
  { type: "audit.human_acceptance_recorded", owner: "V06-09", entity_prefix: "acceptance:", payload: "decision/scenario_refs/baseline/evidence_refs/accepted_by（role 必须是 user）" },
  { type: "execution.start_requested", owner: "V06-11", entity_prefix: "execution:", payload: "goal/argv_digest/template_source/timeout_ms（现场=启动请求中）" },
  { type: "execution.started", owner: "V06-11", entity_prefix: "execution:", payload: "actual{client_id,client_version,model,effort,workspace,pid}+父执行（现场=运行中）" },
  { type: "execution.heartbeat", owner: "V06-11", entity_prefix: "execution:", payload: "observed_at/awaiting_input/note（心跳缺失或超期≠已停止）" },
  { type: "execution.checkpoint", owner: "V06-11", entity_prefix: "execution:", payload: "note/artifacts/worktree/effects_in_flight（恢复第一步读它）" },
  { type: "execution.stop_requested", owner: "V06-11", entity_prefix: "execution:", payload: "reason/confirm_method（现场=停止请求中）" },
  { type: "execution.stopped", owner: "V06-11", entity_prefix: "execution:", payload: "confirmation（必填）/evidence/exit_code（现场=已停止）" },
  { type: "execution.failed", owner: "V06-11", entity_prefix: "execution:", payload: "phase(launch/run)/scene{message,exit_code,stderr_tail,argv_digest}/log_ref" },
  { type: "execution.effect_declared", owner: "V06-11", entity_prefix: "execution:", payload: "effect_id/target/authorization/verify_method/外部幂等键（动作前）" },
  { type: "execution.effect_confirmed", owner: "V06-11", entity_prefix: "execution:", payload: "result_ref（实际结果标识，必填）（动作后）" },
  { type: "execution.effect_unverified", owner: "V06-11", entity_prefix: "execution:", payload: "check_evidence/retry_blocked（效果待核实→暂停自动重试）" },
  { type: "execution.delivered", owner: "V06-11", entity_prefix: "execution:", payload: "deliverables/evidence_refs/verification/untested/known_issues/diff_ref/exit_code（现场=已结束）" },
  // I-1 需求对象库（T21，C-015 纠正版）：**意图正文仍在 intent.json / 聊天记录 / 设计原文**（§2.6），
  // 这里只存结构化注册与来源引用 `source{kind,ref}`——payload 多一个键都拒，不造第二份可独立修改的意图事实。
  { type: "requirement.registered", owner: "T21", entity_prefix: "requirement:", payload: "source{kind,ref}/problem/users[]/success_scenarios[]/exclusions[]/priority/status（§2.5 最小字段，多键拒）" },
  { type: "requirement.updated", owner: "T21", entity_prefix: "requirement:", payload: "同上的字段子集，至少给一个（稳定 ID 不变）" },
  { type: "requirement.status_changed", owner: "T21", entity_prefix: "requirement:", payload: "status ∈ 明确/推断/待确认；reason?" },
  // I-2 变更批次对象库（T21，C-015 纠正版）：目标基线只引用哈希（§2.6），聊天记录只能显式采纳、不升格。
  { type: "change.opened", owner: "T21", entity_prefix: "change:", payload: "goal/authorized_scope/target_baseline{baseline_id?,design_revision,plan_revision}/affected_subsystems[]/exit_criteria（§2.5，多键拒）" },
  { type: "change.status_changed", owner: "T21", entity_prefix: "change:", payload: "status ∈ 进行中/迭代中/已关闭；iteration?/reason?" },
  { type: "change.closed", owner: "T21", entity_prefix: "change:", payload: "reason（关闭依据必填）" },
  { type: "change.adopted_chat_change", owner: "T21", entity_prefix: "change:", payload: "chat_record_id/chat_record_sha256/note?（显式采纳 chat-changes.jsonl 记录；不回写原文件、不升格）" },
  // C016 收口第二包（2026-09-21）：派生蓝图删除/拆并的**合法变更事实**（DESIGN §4.1 权威来源的一半）。
  // 结构判据与折叠/写命令同一份（changes.ts readBlueprintInheritancePayload）；跨基线/源图/引用语义闸
  // 在 arch/blueprintInheritance.ts#registerBlueprintInheritance（submit 前完成，非法零字节）。
  { type: "change.blueprint_inheritance_recorded", owner: "C016", entity_prefix: "change:", payload: "kind(remove/split/merge)/from_baseline/to_baseline/predecessor_ids[]/successor_ids[]/affected_node_ids[]/reference_dispositions[]（remove 继任 0、split ≥1、merge 恰 1；缺键/多键/空白/重复拒）" },
  // T23 / C-017：项目预算约束到顶导致认领被拒的**留证**（§5.7：达到约束不是省略验证的理由）。
  // 项目级单实体 `budget:<project_id>`（约束是项目可配置约束，不是某张卡的属性）。
  { type: "budget.blocked", owner: "T23", entity_prefix: "budget:", payload: "usage/max/task_id/reason（下次认领因达到项目预算约束上限被拒的留证）" },
];

/** 未挂变更批次的实体（需求注册、批次自身）在事件信封里用的批次占位值（信封的 change_id 必须非空） */
export const NO_CHANGE_ID = "change-none";

/** 已登记的事件类型名（`service.info()` 与验证脚本据此对账） */
export function registeredEventTypes(): string[] {
  return REGISTERED_EVENT_TYPES.map((r) => r.type);
}

/** 某类型是不是已登记（未登记的类型不在这里被拒——v2 词法是开放的） */
export function isRegisteredEventType(type: string): boolean {
  return REGISTERED_EVENT_TYPES.some((r) => r.type === type);
}

// ── 字段口径 ──

/** 标识类字段（project_id / change_id / entity_id / event_id / idempotency_key）长度上限 */
export const MAX_ID_LEN = 200;
/** type 词法：小写字母开头，允许小写字母/数字/下划线/点/短横线（如 task.status_changed） */
export const TYPE_RE = /^[a-z][a-z0-9_.-]{2,63}$/;
/** 单条 payload 序列化后的字节上限（防一条命令把事件文件撑爆） */
export const MAX_PAYLOAD_BYTES = 64 * 1024;
/** 单个实体的 revision 上限（防无限增长：到顶就是设计该换成新实体了） */
export const MAX_ENTITY_REVISION = 1_000_000;

/** 一份事件（落盘后的唯一形态，DESIGN.md §2.6 最小信封） */
export interface WorkEvent {
  schema_version: 2;
  event_id: string;
  project_id: string;
  change_id: string;
  entity_id: string;
  /** 本事件生效后的实体版本（1 起；0 表示"事件不存在"这个语义不落盘） */
  entity_revision: number;
  /** 本项目内单调递增提交序号（1 起，无洞） */
  seq: number;
  type: string;
  actor_id: string;
  role: string;
  /** 事件实际发生时间（调用方给的业务时间，缺省等于 received_at） */
  occurred_at: string;
  /** 写入服务收到并提交的时间 */
  received_at: string;
  idempotency_key: string;
  payload: Record<string, unknown>;
}

/** 一份写入命令（尚未落盘；与事件信封的差集 = 服务端自己产出的字段） */
export interface WorkCommand {
  schema_version: 2;
  project_id: string;
  change_id: string;
  entity_id: string;
  /** 期望的当前实体版本：null = 期望实体尚不存在（新建）；数字 = 期望恰好是这个版本 */
  expected_revision: number | null;
  type: string;
  actor_id: string;
  role: string;
  idempotency_key: string;
  occurred_at?: string;
  payload?: Record<string, unknown>;
}

/** 幂等命中标记（重复请求返回同一提交时带上，调用方可据此区分"新提交"与"重放"） */
export interface WorkProjectionStatus {
  /** applied = 快照已跟上；failed = 事件已提交但投影失败（回执仍成立，可重放修复） */
  state: "applied" | "failed";
  error?: string;
}

/** 成功回执（DESIGN.md §2.6：成功回执含 event_id/seq/entity_revision） */
export interface WorkReceipt {
  ok: true;
  event_id: string;
  seq: number;
  entity_revision: number;
  received_at: string;
  /** 本次是否命中幂等（true = 原样返回上一次的回执，没有第二次效果） */
  duplicate: boolean;
  projection: WorkProjectionStatus;
}

/** 单个实体在快照里的投影形态（由事件重放派生，可全量重建） */
export interface WorkEntityState {
  revision: number;
  type: string;
  last_event_id: string;
  updated_at: string;
  payload: Record<string, unknown>;
}

/** 可重建的项目快照（`.工作台/work/state.json`；DESIGN.md §2.6：带 last_seq 的投影） */
export interface WorkSnapshot {
  schema_version: 2;
  project_id: string;
  /** 快照覆盖到的提交序号；重放 events.jsonl 到该序号应得到相同 entities */
  last_seq: number;
  generated_at: string;
  entities: Record<string, WorkEntityState>;
  /** 投影失败原因：非空表示快照落后于事件，界面/调用方必须按"陈旧"处理 */
  projection_error: string | null;
  /** 读取时数据源的状态（读服务不可达时由客户端补上，磁盘上的快照本身不写这个字段） */
  stale?: boolean;
  stale_reason?: string;
}

/** 读快照的结果：既有"有新快照"，也有"服务离线/项目还没有任何事件"两种未知态 */
export interface WorkSnapshotRead {
  snapshot: WorkSnapshot | null;
  /** true = 这份数据不是当前确认的最新事实（离线、投影失败、或压根没有快照） */
  stale: boolean;
  stale_reason: string | null;
}

// ── 校验 ──

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function bad(message: string, detail: Record<string, unknown> = {}): never {
  throw new WorkError("INVALID_COMMAND", message, detail);
}

function assertId(v: unknown, field: string): string {
  if (typeof v !== "string" || v.trim() === "") {
    bad(`${field} 必须是非空字符串`, { field });
  }
  const s = v.trim();
  if (s.length > MAX_ID_LEN) {
    bad(`${field} 超过 ${MAX_ID_LEN} 字符上限`, { field, length: s.length });
  }
  return s;
}

/**
 * 严格校验一份写入命令（DESIGN.md §2.6 + V06-01 契约）。
 * 任何不合法一律 `INVALID_COMMAND`，且**在动磁盘之前**抛出——非法命令不留痕。
 */
export function validateWorkCommand(raw: unknown): WorkCommand {
  if (!isPlainObject(raw)) bad("命令必须是 JSON 对象");
  const c = raw as Record<string, unknown>;

  if (c.schema_version !== SCHEMA_VERSION) {
    bad(`不支持的 schema_version: ${JSON.stringify(c.schema_version)}（当前只接受 ${SCHEMA_VERSION}）`, {
      expected: SCHEMA_VERSION,
      got: c.schema_version,
    });
  }
  const project_id = assertId(c.project_id, "project_id");
  const change_id = assertId(c.change_id, "change_id");
  const entity_id = assertId(c.entity_id, "entity_id");
  const actor_id = assertId(c.actor_id, "actor_id");
  const role = assertId(c.role, "role");
  const idempotency_key = assertId(c.idempotency_key, "idempotency_key");

  if (typeof c.type !== "string" || !TYPE_RE.test(c.type)) {
    bad(`type 必须是 ${TYPE_RE} 形态的事件名（小写字母开头）: ${JSON.stringify(c.type)}`, {
      field: "type",
    });
  }

  const expected_revision = c.expected_revision;
  if (expected_revision !== null && expected_revision !== undefined) {
    if (
      typeof expected_revision !== "number" ||
      !Number.isInteger(expected_revision) ||
      expected_revision < 0 ||
      expected_revision > MAX_ENTITY_REVISION
    ) {
      bad(
        `expected_revision 必须是 0..${MAX_ENTITY_REVISION} 的整数或 null（null = 期望实体尚不存在）: ${JSON.stringify(
          expected_revision,
        )}`,
        { field: "expected_revision" },
      );
    }
  }

  if (c.occurred_at !== undefined && typeof c.occurred_at !== "string") {
    bad("occurred_at 给定时必须是字符串（本地带偏移 ISO，如 2026-09-20T01:00:00+08:00）", {
      field: "occurred_at",
    });
  }

  const payload = c.payload === undefined ? {} : c.payload;
  if (!isPlainObject(payload)) bad("payload 必须是 JSON 对象", { field: "payload" });
  const payloadBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
  if (payloadBytes > MAX_PAYLOAD_BYTES) {
    bad(`payload 超过 ${MAX_PAYLOAD_BYTES} 字节上限（本命令 ${payloadBytes} 字节）`, {
      field: "payload",
      bytes: payloadBytes,
    });
  }

  return {
    schema_version: SCHEMA_VERSION,
    project_id,
    change_id,
    entity_id,
    expected_revision: expected_revision === undefined ? null : (expected_revision as number | null),
    type: c.type,
    actor_id,
    role,
    idempotency_key,
    ...(c.occurred_at === undefined ? {} : { occurred_at: c.occurred_at as string }),
    payload: payload as Record<string, unknown>,
  };
}

/**
 * 幂等内容指纹：**同键必须同内容**才返回原回执。
 *
 * 只覆盖"调用方声明的意图"，不含服务端自己产出的 seq/时间戳——否则重放自己的回执会被判成异内容。
 * 键序固定（手写字段序），故同样的命令在任何进程里算出同一个指纹。
 */
export function commandFingerprint(c: WorkCommand): string {
  return JSON.stringify([
    c.schema_version,
    c.project_id,
    c.change_id,
    c.entity_id,
    c.expected_revision,
    c.type,
    c.actor_id,
    c.role,
    c.occurred_at ?? null,
    c.payload ?? {},
  ]);
}

/**
 * 校验一条已落盘事件的信封（读侧口径，DESIGN.md §2.6）。
 * 与命令校验分开：事件里有服务端产出的 seq/时间戳/event_id，缺一即视为事件不合法。
 */
export function validateWorkEvent(raw: unknown): WorkEvent {
  if (!isPlainObject(raw)) {
    throw new WorkError("EVENT_INVALID", "事件必须是 JSON 对象");
  }
  const e = raw as Record<string, unknown>;
  const need = (field: string): string => {
    const v = e[field];
    if (typeof v !== "string" || v === "") {
      throw new WorkError("EVENT_INVALID", `事件缺字段或类型不对: ${field}`, { field });
    }
    return v;
  };
  if (e.schema_version !== SCHEMA_VERSION) {
    throw new WorkError(
      "EVENT_INVALID",
      `事件 schema_version 不是 ${SCHEMA_VERSION}: ${JSON.stringify(e.schema_version)}`,
      { field: "schema_version" },
    );
  }
  const event_id = need("event_id");
  const project_id = need("project_id");
  const change_id = need("change_id");
  const entity_id = need("entity_id");
  const type = need("type");
  const actor_id = need("actor_id");
  const role = need("role");
  const occurred_at = need("occurred_at");
  const received_at = need("received_at");
  const idempotency_key = need("idempotency_key");
  if (!TYPE_RE.test(type)) {
    throw new WorkError("EVENT_INVALID", `事件 type 形态不合法: ${JSON.stringify(type)}`, {
      field: "type",
    });
  }
  const rev = e.entity_revision;
  if (typeof rev !== "number" || !Number.isInteger(rev) || rev < 1) {
    throw new WorkError("EVENT_INVALID", `事件 entity_revision 必须是 >=1 的整数: ${JSON.stringify(rev)}`, {
      field: "entity_revision",
    });
  }
  const seq = e.seq;
  if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 1) {
    throw new WorkError("EVENT_INVALID", `事件 seq 必须是 >=1 的整数: ${JSON.stringify(seq)}`, {
      field: "seq",
    });
  }
  if (!isPlainObject(e.payload)) {
    throw new WorkError("EVENT_INVALID", "事件 payload 必须是 JSON 对象", { field: "payload" });
  }
  return {
    schema_version: SCHEMA_VERSION,
    event_id,
    project_id,
    change_id,
    entity_id,
    entity_revision: rev,
    seq,
    type,
    actor_id,
    role,
    occurred_at,
    received_at,
    idempotency_key,
    payload: e.payload,
  };
}
