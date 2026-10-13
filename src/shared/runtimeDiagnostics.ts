// 运行诊断的**唯一类型契约**（V09-69；DESIGN §3.18 / §6.15）。
//
// 这个模块是前后端共用的**权威字段形状**：后端 builder（`src/server/work/runtimeDiagnostics.ts`）、
// 双只读读口（本地 `GET /api/runtime/diagnostics` 与 tokened `GET /api/work/diagnostics`）、MCP
// `doctor.runtime` 段、以及前端诊断页/轻量提示/脱敏导出**都只认这一份**——不各写一套字段或判据。
//
// 红线（本模块逐条守）：
//   · **浏览器安全**：零 node import、零 React——前端与服务端共用同一份类型、校验与脱敏判定。
//   · **typed allowlist 脱敏**：报告字段是**闭集**（枚举/计数/时间/身份）；`sanitizeRuntimeDiagnosticsReport`
//     运行时逐字段重建，未知字段一律丢弃；自由文本字段（reason/detail）先过 `redactRuntimeText`
//     去掉绝对路径与 token 样串。**从不**内联请求/响应正文、query、写服务 token、认领 token、聊天、密钥、堆栈。
//   · **未知就是未知**：读不出/旧宿主不支持一律 `unknown` + `unsupported:[...]`，**不猜**成 healthy 也不猜成 unavailable。
//   · **超时≠服务已死；503 按 reason 区分**：`QUEUE_SATURATED` 只是该次读作业排队被拒（记 degraded），
//     只有明确不可达/拒绝（描述符缺失、进程退出、连接被拒）才记 `unavailable`（`classifyRuntimeFailure`）。

/** 报告 schema 名（与 `schema_version` 一并冻结；只增不改既有字段语义） */
export const RUNTIME_DIAGNOSTICS_SCHEMA = "runtime-diagnostics-v1";
export const RUNTIME_DIAGNOSTICS_SCHEMA_VERSION = 1 as const;
/** 运行观测的**短时**新鲜度阈值（30 秒；**不套** §3.7 的 24h 可达性复核阈值） */
export const RUNTIME_DIAGNOSTICS_STALE_AFTER_MS = 30_000;
/** recent incidents 的**有界**条数（内存遥测，不落账本） */
export const RUNTIME_DIAGNOSTICS_INCIDENT_LIMIT = 40;
/** 近期异常（饱和等瞬时态）纳入"当前告警"的窗口 */
export const RUNTIME_DIAGNOSTICS_ALERT_WINDOW_MS = 60_000;

/** 统一状态词表（界面与 Agent 同源；见 §3.18 表） */
export type RuntimeHealthState = "healthy" | "degraded" | "unavailable" | "unknown";
export const RUNTIME_HEALTH_STATES: readonly RuntimeHealthState[] = ["healthy", "degraded", "unavailable", "unknown"];

/** 新鲜度三态：fresh=仍新；stale=该重新看一眼（**不自动判失效**）；unknown=无成功观测 */
export type RuntimeAgeState = "fresh" | "stale" | "unknown";

/** 免责/缺证说明用的自由文本字段名（供 UI 与导出展示；不参与判据） */
export type RuntimeDiagnosticsDetail = "summary" | "full";
export const RUNTIME_DIAGNOSTICS_DETAILS: readonly RuntimeDiagnosticsDetail[] = ["summary", "full"];

/** 稳定作业种类闭集（与 `src/server/work/readJobs.ts#ReadJobKind` 同值；新增须同步两侧） */
export type RuntimeJobKind =
  | "entry"
  | "sync_status"
  | "sync_scan"
  | "sync_prep"
  | "arch_blueprint"
  | "arch_render"
  | "feature_ledger";
export const RUNTIME_JOB_KINDS: readonly RuntimeJobKind[] = [
  "entry",
  "sync_status",
  "sync_scan",
  "sync_prep",
  "arch_blueprint",
  "arch_render",
  "feature_ledger",
];
export function isRuntimeJobKind(v: unknown): v is RuntimeJobKind {
  return typeof v === "string" && (RUNTIME_JOB_KINDS as readonly string[]).includes(v);
}

/** 状态原因码（**分类而非正文**：不夹带路径/token/正文） */
export type RuntimeReasonCode =
  | "OK"
  | "SOURCE_UNAVAILABLE"
  | "PROCESS_EXITED"
  | "READ_WORKERS_UNAVAILABLE"
  | "QUEUE_SATURATED"
  | "READ_TIMED_OUT"
  | "READ_FAILED"
  | "READ_ABORTED"
  | "STALE_OBSERVATION"
  | "NO_EVIDENCE"
  | "UNSUPPORTED"
  | "UNKNOWN";

export interface RuntimeHealthReason {
  code: RuntimeReasonCode;
  /** 人读一句话（已过 `redactRuntimeText`；不含路径/token/正文） */
  detail: string;
  /** 归属维度（service/read/scan/process/…)；无归属为 null */
  subject: string | null;
}

/** 单池只读读数（复用 `readWorkerPoolStatus()`，字段名稳定） */
export interface RuntimeQueueReadout {
  mode: "worker" | "local" | "unavailable" | "unknown";
  busy: number;
  queued: number;
  queue_limit: number;
  pool_size: number;
  group_queue_limit: number;
  groups_queued: number;
  started: number;
  completed: number;
  failed: number;
  timeouts: number;
  rejected_full: number;
  rejected_group_full: number;
}

/** 一条有界 recent incident（只记**异常**：失败/超时/取消/拒绝/worker 不可用；正常成功不进此表） */
export type RuntimeIncidentOutcome = "failed" | "timed_out" | "aborted" | "rejected_full" | "rejected_group_full" | "unavailable";

export interface RuntimeIncident {
  at: string;
  outcome: RuntimeIncidentOutcome;
  /** 稳定作业种类枚举（非 raw URL/路径/正文）；无从得知为 null */
  job_kind: RuntimeJobKind | null;
  /** 项目标识（注册表 id，不是路径/URL）；全局作业为 null */
  project_id: string | null;
  /** 结构化错误码（如 READ_JOB_TIMEOUT / READ_QUEUE_FULL）；无则 null */
  code: string | null;
  /** 已脱敏的一句话原因（不含路径/token/正文） */
  reason: string;
  queue_ms: number | null;
  execution_ms: number | null;
  total_ms: number | null;
}

export interface RuntimeTimingStat {
  count: number;
  min_ms: number;
  max_ms: number;
  avg_ms: number;
}

/** 时延统计：**分 queue 与执行**；没测到就是 null（不编数值） */
export interface RuntimeTiming {
  samples: number;
  queue_ms: RuntimeTimingStat | null;
  execution_ms: RuntimeTimingStat | null;
  total_ms: RuntimeTimingStat | null;
}

/** 脱敏后的构建身份（typed allowlist：不直接透传 `BuildIdentity`，避免臆造字段/夹带路径） */
export interface RuntimeBuildIdentity {
  component: "server" | "ui" | null;
  embedded: boolean;
  release_id: string | null;
  build_id: string | null;
  /** 未内嵌时的原因（已过 `redactRuntimeText`）；已内嵌为 null */
  reason: string | null;
}

/** 偏斜三态（`unknown` 不算一致；判据复用 `src/shared/buildIdentity.ts#compareBuildIdentities`） */
export interface RuntimeBuildIdentitySkew {
  state: "same_release" | "skew" | "unknown";
  detail: string;
}

/** 进程/部件身份（复用 §6.10 的 release_id／构建身份） */
export interface RuntimeProcessIdentity {
  pid: number | null;
  started_at: string | null;
  release_id: string | null;
  build_identity: RuntimeBuildIdentity;
  build_identity_skew: RuntimeBuildIdentitySkew;
}

/** 唯一写服务（宿主）可达性维度 */
export interface RuntimeServiceDimension {
  reachable: boolean;
  descriptor: {
    present: boolean;
    state: "missing" | "valid" | "invalid";
    pid_alive: boolean;
    is_self: boolean;
  };
  reason: string | null;
  last_success_at: string | null;
  age_state: RuntimeAgeState;
}

export interface RuntimeLastSuccess {
  at: string;
  age_ms: number;
}

/** `GET /api/runtime/diagnostics` 与 `GET /api/work/diagnostics` 的 200 响应体（同一 builder） */
export interface RuntimeDiagnosticsReport {
  ok: true;
  schema: typeof RUNTIME_DIAGNOSTICS_SCHEMA;
  schema_version: typeof RUNTIME_DIAGNOSTICS_SCHEMA_VERSION;
  generated_at: string;
  /** 缺省全局（null）；给了则只反映该项目相关读数 */
  project_id: string | null;
  detail: RuntimeDiagnosticsDetail;
  process: RuntimeProcessIdentity;
  service: RuntimeServiceDimension;
  status: RuntimeHealthState;
  reasons: RuntimeHealthReason[];
  last_success: RuntimeLastSuccess | null;
  stale_after_ms: number;
  age_state: RuntimeAgeState;
  degraded_since: string | null;
  incidents: RuntimeIncident[];
  queue: { read: RuntimeQueueReadout; scan: RuntimeQueueReadout };
  timing: RuntimeTiming;
  /** 本读口**不支持**的能力名（旧宿主/旧客户端）——**不猜**成 healthy */
  unsupported: string[];
}

/** 前端自身网络失败只作**客户端观测**（§3.18）：不伪装成后端诊断报告 */
export interface RuntimeClientObservation {
  kind: "client_observation";
  at: string;
  state: "unknown";
  reason: string;
}

// ── 脱敏与运行时 sanitize（typed allowlist；UI 导出与 doctor 读宿主共用同一份）────────────────

/** 绝不被采集/内联的字段类别（导出/展示时如实标注；不参与判据） */
export const RUNTIME_REDACTED_FIELD_CLASSES: readonly string[] = [
  "request_body",
  "response_body",
  "query_string",
  "work_service_token",
  "claim_token",
  "idempotency_key",
  "chat_content",
  "secret",
  "stack_trace",
  "absolute_path",
];

// R69-05 返工口径：**保证性脱敏靠采集端白名单**——`incidents.reason` / `service.reason` / `reasons[].detail`
// 一律是**受控模板 + 枚举**（见 `readWorkerPool.ts` / `server/work/runtimeDiagnostics.ts` 的模板表），
// `err.message` / query / 请求正文 / 路径原文**不进**报告。下面这些正则只是**纵深防御**：即便来的是
// 旧宿主 / 恶意 / 损坏的自由文本，也不放路径 / query / 凭据 token / 正文原文出门。
// 修复前「(≥20 且含数字) 才抹 + Windows 路径在空白处截断」漏掉：含空格路径、相对路径、纯字母长串、
// 短凭据（`token=abc123`）与 query 串——本块逐条补齐。
// Windows 驱动器路径：允许路径段含空格与 CJK（`C:\Program Files\...` / `D:\资料\密钥` 不再截断）
const WINDOWS_PATH_RE = /[A-Za-z]:[\\/](?:[^<>:"|?*\r\n]*[\\/])*[^<>:"|?*\r\n]*/g;
// UNC 路径：同样放宽到空格/CJK
const UNC_PATH_RE = /\\\\[^<>:"|?*\r\n]+/g;
// 前导绝对 / `./` / `../` 的 POSIX 路径
const POSIX_PATH_RE = /(^|[\s"'`(=（【])(?:\/|\.{1,2}\/)[\w.%·\u4e00-\u9fff-]*(?:\/[\w.%·\u4e00-\u9fff-]*)*/g;
// 相对多段路径（末段带扩展名，避免误伤 `read/write` 一类普通词）
const REL_PATH_RE = /(^|[\s"'`(=（【])(?:[\w.%·\u4e00-\u9fff-]+\/)+[\w.%·\u4e00-\u9fff-]*\.[A-Za-z0-9]{1,16}/g;
// key=value / "key":"value" / query 链：抹掉**值**（`token=abc123` / `?project_id=huojia&detail=full` 也抹）
const KV_PAIR_RE = /(^|[\s"'`{(\[（【,&])(["']?[A-Za-z_][\w.-]{0,31}["']?\s*[=:]\s*["']?)[^\s"'`&;,)\]}\[<>\r\n]{2,}/g;
// token 样长串：含小写字母且 ≥16（纯字母/混合大小写 token），或含数字且带分隔符且 ≥12（`ghp_1234…`）
const TOKEN_RUN_RE = /[A-Za-z0-9_+.\/=-]{12,}/g;

function redactTokenRuns(s: string): string {
  return s.replace(TOKEN_RUN_RE, (m) => {
    if (m.length >= 16 && /[a-z]/.test(m)) return "<redacted>";
    if (/\d/.test(m) && /[^\w]/.test(m)) return "<redacted>";
    return m;
  });
}

/**
 * 只做**路径与 query 链**脱敏（标识类字段用：project_id / 错误码 / release_id 等，不误伤纯字母枚举）。
 * 相对路径也抹（R69-05）。
 */
export function redactPaths(input: string, maxLen = 480): string {
  let s = typeof input === "string" ? input : String(input ?? "");
  s = s.replace(WINDOWS_PATH_RE, "<path>");
  s = s.replace(UNC_PATH_RE, "<path>");
  s = s.replace(POSIX_PATH_RE, (_m, pre: string) => `${pre}<path>`);
  s = s.replace(REL_PATH_RE, (_m, pre: string) => `${pre}<path>`);
  if (s.length > maxLen) s = `${s.slice(0, maxLen)}…`;
  return s;
}

/**
 * 自由文本脱敏（**唯一的自由文本净化口径**）：去掉 Windows/UNC/POSIX/相对路径、query/凭据对与 token 样长串；
 * 稳定枚举错误码（如 `READ_WORKERS_UNAVAILABLE`，纯大写+下划线、无数字、无小写）**不误伤**。
 * 报告的类型化字段（release_id/build_id 等）**不走**这里——它们本就是允许暴露的内容身份，不是自由文本。
 */
export function redactRuntimeText(input: string, maxLen = 480): string {
  let s = redactPaths(input, Math.max(maxLen, 480));
  s = s.replace(KV_PAIR_RE, (_m, pre: string) => `${pre}<redacted>`);
  s = redactTokenRuns(s);
  if (s.length > maxLen) s = `${s.slice(0, maxLen)}…`;
  return s;
}

function asString(v: unknown, maxLen = 480): string | null {
  if (typeof v !== "string" || v === "") return null;
  return redactRuntimeText(v, maxLen);
}
/** 标识类字段（release_id / build_id 等）：只去绝对路径，不误伤纯字母枚举。 */
function asIdString(v: unknown, maxLen = 200): string | null {
  if (typeof v !== "string" || v === "") return null;
  return redactPaths(v, maxLen);
}

/** 结构化错误码**闭集形态**（纯大写+下划线+数字）：非法即 null——挡住把 query/token/正文塞进 code 的输入。 */
const ERROR_CODE_RE = /^[A-Z][A-Z0-9_]{0,79}$/;
function asErrorCode(v: unknown): string | null {
  return typeof v === "string" && ERROR_CODE_RE.test(v) ? v : null;
}

/** 项目/身份标识：只接受字母/数字/下划线/点/连字符（含 CJK），挡住路径/query/空白原文。 */
const ID_TOKEN_RE = /^[\p{L}\p{N}_.-]{1,200}$/u;
function asProjectId(v: unknown): string | null {
  return typeof v === "string" && ID_TOKEN_RE.test(v) ? v : null;
}

/** 能力名（`unsupported`）：小写字母开头的能力标识（如 `runtime_diagnostics`）——非法即丢。 */
const CAPABILITY_RE = /^[a-z][a-z0-9_.-]{0,59}$/;
function asInt(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : null;
}
function asNonNegInt(v: unknown): number {
  const n = asInt(v);
  return n !== null && n > 0 ? n : 0;
}
function asIso(v: unknown): string | null {
  if (typeof v !== "string" || v === "") return null;
  return Number.isNaN(Date.parse(v)) ? null : v;
}

function isHealthState(v: unknown): v is RuntimeHealthState {
  return typeof v === "string" && (RUNTIME_HEALTH_STATES as readonly string[]).includes(v);
}
function isAgeState(v: unknown): v is RuntimeAgeState {
  return v === "fresh" || v === "stale" || v === "unknown";
}
function isQueueMode(v: unknown): v is RuntimeQueueReadout["mode"] {
  return v === "worker" || v === "local" || v === "unavailable" || v === "unknown";
}
function isIncidentOutcome(v: unknown): v is RuntimeIncidentOutcome {
  return (
    v === "failed" ||
    v === "timed_out" ||
    v === "aborted" ||
    v === "rejected_full" ||
    v === "rejected_group_full" ||
    v === "unavailable"
  );
}
const REASON_CODES: readonly RuntimeReasonCode[] = [
  "OK",
  "SOURCE_UNAVAILABLE",
  "PROCESS_EXITED",
  "READ_WORKERS_UNAVAILABLE",
  "QUEUE_SATURATED",
  "READ_TIMED_OUT",
  "READ_FAILED",
  "READ_ABORTED",
  "STALE_OBSERVATION",
  "NO_EVIDENCE",
  "UNSUPPORTED",
  "UNKNOWN",
];
function isReasonCode(v: unknown): v is RuntimeReasonCode {
  return typeof v === "string" && (REASON_CODES as readonly string[]).includes(v);
}

/** 从宿主 JSON 里安全地重建一条 incident（未知/畸形字段丢弃） */
function sanitizeIncident(raw: unknown): RuntimeIncident | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const at = asIso(r.at);
  if (at === null) return null;
  return {
    at,
    outcome: isIncidentOutcome(r.outcome) ? r.outcome : "failed",
    job_kind: isRuntimeJobKind(r.job_kind) ? r.job_kind : null,
    project_id: asProjectId(r.project_id),
    code: asErrorCode(r.code),
    reason: asString(r.reason) ?? "未提供原因",
    queue_ms: asInt(r.queue_ms),
    execution_ms: asInt(r.execution_ms),
    total_ms: asInt(r.total_ms),
  };
}

function sanitizeReason(raw: unknown): RuntimeHealthReason | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (!isReasonCode(r.code)) return null;
  return {
    code: r.code,
    detail: asString(r.detail) ?? r.code,
    subject: asString(r.subject, 80),
  };
}

function sanitizeQueue(raw: unknown): RuntimeQueueReadout {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    mode: isQueueMode(r.mode) ? r.mode : "unknown",
    busy: asNonNegInt(r.busy),
    queued: asNonNegInt(r.queued),
    queue_limit: asNonNegInt(r.queue_limit),
    pool_size: asNonNegInt(r.pool_size),
    group_queue_limit: asNonNegInt(r.group_queue_limit),
    groups_queued: asNonNegInt(r.groups_queued),
    started: asNonNegInt(r.started),
    completed: asNonNegInt(r.completed),
    failed: asNonNegInt(r.failed),
    timeouts: asNonNegInt(r.timeouts),
    rejected_full: asNonNegInt(r.rejected_full),
    rejected_group_full: asNonNegInt(r.rejected_group_full),
  };
}

function sanitizeTimingStat(raw: unknown): RuntimeTimingStat | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const count = asNonNegInt(r.count);
  if (count === 0) return null;
  return {
    count,
    min_ms: asNonNegInt(r.min_ms),
    max_ms: asNonNegInt(r.max_ms),
    avg_ms: typeof r.avg_ms === "number" && Number.isFinite(r.avg_ms) ? Math.max(0, Math.round(r.avg_ms)) : 0,
  };
}

function sanitizeBuildIdentity(raw: unknown): RuntimeBuildIdentity {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const component = r.component === "server" || r.component === "ui" ? r.component : null;
  const embedded = r.embedded === true;
  return {
    component,
    embedded,
    release_id: embedded ? asIdString(r.release_id, 200) : null,
    build_id: embedded ? asIdString(r.build_id, 200) : null,
    reason: embedded ? null : (asString(r.reason) ?? null),
  };
}

function sanitizeSkew(raw: unknown): RuntimeBuildIdentitySkew {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const state = r.state === "same_release" || r.state === "skew" || r.state === "unknown" ? r.state : "unknown";
  return { state, detail: asString(r.detail) ?? "无法比较（身份读数缺失）" };
}

/**
 * **typed allowlist 运行时 sanitize**：把任意（可能来自旧宿主/恶意/损坏的）JSON 重建为一份合法报告。
 * 未知字段一律丢弃；自由文本字段过 `redactRuntimeText`。**返回 null** 仅当输入不是对象或 `ok!==true`。
 */
export function sanitizeRuntimeDiagnosticsReport(raw: unknown): RuntimeDiagnosticsReport | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r.ok !== true || r.schema !== RUNTIME_DIAGNOSTICS_SCHEMA) return null;
  const generatedAt = asIso(r.generated_at) ?? new Date().toISOString();
  const processRaw = (typeof r.process === "object" && r.process !== null ? r.process : {}) as Record<string, unknown>;
  const serviceRaw = (typeof r.service === "object" && r.service !== null ? r.service : {}) as Record<string, unknown>;
  const descRaw = (typeof serviceRaw.descriptor === "object" && serviceRaw.descriptor !== null ? serviceRaw.descriptor : {}) as Record<string, unknown>;
  const queueRaw = (typeof r.queue === "object" && r.queue !== null ? r.queue : {}) as Record<string, unknown>;
  const timingRaw = (typeof r.timing === "object" && r.timing !== null ? r.timing : {}) as Record<string, unknown>;
  const lastRaw = (typeof r.last_success === "object" && r.last_success !== null ? r.last_success : null) as Record<string, unknown> | null;
  const incidents = Array.isArray(r.incidents)
    ? (r.incidents.map(sanitizeIncident).filter((x): x is RuntimeIncident => x !== null))
    : [];
  const reasons = Array.isArray(r.reasons)
    ? (r.reasons.map(sanitizeReason).filter((x): x is RuntimeHealthReason => x !== null))
    : [];
  const detail: RuntimeDiagnosticsDetail = r.detail === "full" ? "full" : "summary";
  return {
    ok: true,
    schema: RUNTIME_DIAGNOSTICS_SCHEMA,
    schema_version: RUNTIME_DIAGNOSTICS_SCHEMA_VERSION,
    generated_at: generatedAt,
    project_id: asProjectId(r.project_id),
    detail,
    process: {
      pid: asInt(processRaw.pid),
      started_at: asIso(processRaw.started_at),
      release_id: asIdString(processRaw.release_id, 200),
      build_identity: sanitizeBuildIdentity(processRaw.build_identity),
      build_identity_skew: sanitizeSkew(processRaw.build_identity_skew),
    },
    service: {
      reachable: serviceRaw.reachable === true,
      descriptor: {
        present: descRaw.present === true,
        state: descRaw.state === "valid" || descRaw.state === "invalid" || descRaw.state === "missing" ? descRaw.state : "missing",
        pid_alive: descRaw.pid_alive === true,
        is_self: descRaw.is_self === true,
      },
      reason: asString(serviceRaw.reason),
      last_success_at: asIso(serviceRaw.last_success_at),
      age_state: isAgeState(serviceRaw.age_state) ? serviceRaw.age_state : "unknown",
    },
    status: isHealthState(r.status) ? r.status : "unknown",
    reasons,
    last_success: lastRaw === null ? null : { at: asIso(lastRaw.at) ?? generatedAt, age_ms: asNonNegInt(lastRaw.age_ms) },
    stale_after_ms: asNonNegInt(r.stale_after_ms) || RUNTIME_DIAGNOSTICS_STALE_AFTER_MS,
    age_state: isAgeState(r.age_state) ? r.age_state : "unknown",
    degraded_since: asIso(r.degraded_since),
    incidents: incidents.slice(0, RUNTIME_DIAGNOSTICS_INCIDENT_LIMIT),
    queue: { read: sanitizeQueue(queueRaw.read), scan: sanitizeQueue(queueRaw.scan) },
    timing: {
      samples: asNonNegInt(timingRaw.samples),
      queue_ms: sanitizeTimingStat(timingRaw.queue_ms),
      execution_ms: sanitizeTimingStat(timingRaw.execution_ms),
      total_ms: sanitizeTimingStat(timingRaw.total_ms),
    },
    unsupported: Array.isArray(r.unsupported)
      ? (r.unsupported.filter((s): s is string => typeof s === "string" && CAPABILITY_RE.test(s)))
      : [],
  };
}

/** `runtime-diagnostics-report v1` 导出体（**只读**；附 `redaction.note` 与 `redacted_fields`） */
export interface RuntimeDiagnosticsExport {
  schema: "runtime-diagnostics-report";
  schema_version: 1;
  generated_at: string;
  exported_at: string;
  project_id: string | null;
  report: RuntimeDiagnosticsReport;
  client_observation: RuntimeClientObservation | null;
  redaction: {
    redacted_fields: string[];
    note: string;
  };
}

/**
 * 构造脱敏导出体（UI 导出入口用；**同一份 typed allowlist**，不另写一套序列化）。
 * `report` 须是服务端已脱敏的报告（`sanitizeRuntimeDiagnosticsReport` 的产物）——此处再走一次
 * sanitize 作纵深防御，保证导出**永不**夹带请求/响应/token/聊天/密钥。
 */
export function buildRuntimeDiagnosticsExport(
  report: RuntimeDiagnosticsReport,
  clientObservation: RuntimeClientObservation | null = null,
  opts: { now?: string } = {},
): RuntimeDiagnosticsExport {
  const clean = sanitizeRuntimeDiagnosticsReport(report) ?? report;
  const redacted = [...RUNTIME_REDACTED_FIELD_CLASSES];
  return {
    schema: "runtime-diagnostics-report",
    schema_version: 1,
    generated_at: clean.generated_at,
    exported_at: opts.now ?? new Date().toISOString(),
    project_id: clean.project_id,
    report: clean,
    client_observation: clientObservation,
    redaction: {
      redacted_fields: redacted,
      note:
        "本报告为运行诊断只读读数，已按 typed allowlist 脱敏：只含枚举/计数/时间/身份，" +
        "不含请求/响应正文、query、写服务或认领 token（含前缀与幂等键）、聊天内容、密钥、堆栈、绝对路径。" +
        "该导出**只读**，不触发重算、不写账本、不改变任何状态。运行读数与交付结论分开，stale 只表示该再看一眼。",
    },
  };
}

// ── 失败分类（503 按 reason 区分的唯一判据）────────────────────────────────

export interface RuntimeFailureClassifyInput {
  /** read 作业失败的 HTTP 状态（若来自 HTTP） */
  httpStatus?: number;
  /** 503 必带的 reason（`SOURCE_UNAVAILABLE` | `QUEUE_SATURATED` | 其它/未知） */
  reason?: string | null;
  /** 是否明确不可达/拒绝（描述符缺失、进程退出、连接被拒）——**只有确定证据**才为 true */
  definiteUnreachable?: boolean;
  /** 是否本次读超时未得结果 */
  timedOut?: boolean;
  /** 是否曾有成功观测（`last_success`） */
  hasLastSuccess?: boolean;
}

export interface RuntimeFailureClassifyResult {
  state: RuntimeHealthState;
  code: RuntimeReasonCode;
  timedOut: boolean;
}

/**
 * 把一次只读失败的信号分成统一状态（**503 按 reason 区分**）：
 *   · `QUEUE_SATURATED` → `degraded`（**不得**报 unavailable；只是该次读作业排队被拒）；
 *   · `SOURCE_UNAVAILABLE`/超时 → 有**明确不可达证据**才 `unavailable`；否则曾有成功 ⇒ `degraded`，从未成功 ⇒ `unknown`；
 *   · 其它 → 按超时口径或 `READ_FAILED` 处理（有成功 ⇒ degraded，否则 unknown）。
 */
export function classifyRuntimeFailure(input: RuntimeFailureClassifyInput): RuntimeFailureClassifyResult {
  const reason = typeof input.reason === "string" ? input.reason.toUpperCase() : "";
  const hasLastSuccess = input.hasLastSuccess === true;
  if (reason === "QUEUE_SATURATED") {
    return { state: "degraded", code: "QUEUE_SATURATED", timedOut: input.timedOut === true };
  }
  if (input.definiteUnreachable === true) {
    return { state: "unavailable", code: "SOURCE_UNAVAILABLE", timedOut: input.timedOut === true };
  }
  if (input.timedOut === true || reason === "SOURCE_UNAVAILABLE") {
    return hasLastSuccess
      ? { state: "degraded", code: reason === "SOURCE_UNAVAILABLE" ? "SOURCE_UNAVAILABLE" : "READ_TIMED_OUT", timedOut: true }
      : { state: "unknown", code: reason === "SOURCE_UNAVAILABLE" ? "SOURCE_UNAVAILABLE" : "NO_EVIDENCE", timedOut: true };
  }
  return hasLastSuccess
    ? { state: "degraded", code: "READ_FAILED", timedOut: false }
    : { state: "unknown", code: "NO_EVIDENCE", timedOut: false };
}

/** 状态的中文人话（界面/Agent 共用；不各写一套） */
export function runtimeHealthStateLabel(state: RuntimeHealthState): string {
  switch (state) {
    case "healthy":
      return "正常";
    case "degraded":
      return "降级（服务可达但慢/排队/观测过期——不等于失败）";
    case "unavailable":
      return "不可用（有确定证据的不可达/拒绝）";
    default:
      return "未知（读不到或证据不足，不猜）";
  }
}
