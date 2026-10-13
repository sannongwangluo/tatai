// 运行诊断的统一状态模型与**只读**报告装配（V09-69；DESIGN §3.18 / §6.15）。
//
// 为什么单独一个模块：本地读口（`src/server/index.ts` `GET /api/runtime/diagnostics`）与 tokened 读口
// （`src/server/work/service.ts` `GET /api/work/diagnostics`）、MCP `doctor.runtime` 段必须**共用同一个
// builder 与同一份判据**，不各算一套（DESIGN §6.15「宿主装配一次、两读口共用一个 builder」）。
//
// 硬口径：
//   · **只读**：只读有界内存运行遥测（`readWorkerPool.ts#runtimeTelemetry`）+ worker 队列状态（`readWorkerPoolStatus`）
//     —— 不写事件/证据/租约、不自愈、不触发扫描、不拉起写服务、**不进** `runReadJob` 的 CPU 重派生队列
//     （构造报告是主线程 O(有界记录)，不调图/ledger/基线/完整 doctor 重推导）。
//   · **超时≠服务已死；503 按 reason 区分**：状态派生只在 `deriveRuntimeHealth`（本模块）与
//     `classifyRuntimeFailure`（shared，失败分类）两处；`QUEUE_SATURATED` 记 degraded，只有明确不可达/拒绝才 unavailable。
//   · **永不夹带**：进程身份/作业种类/项目标识都是稳定枚举与 id；自由文本过 `redactRuntimeText`；
//     报告再过一次 shared 的 `sanitizeRuntimeDiagnosticsReport`（typed allowlist 纵深防御）。
//   · **正常恢复后当前告警清除、历史保留**：状态随最新证据回正，incidents 只追加、不因恢复而删。
import { readWorkerPoolStatus, runtimeTelemetry, type ReadWorkerPoolStatus, type WorkHostWorkerStatus, type RuntimeTelemetrySnapshot } from "./readWorkerPool";
import { toIso } from "../time";
import { compareBuildIdentities, resolveBuildIdentity, type BuildIdentity } from "../../shared/buildIdentity";
import {
  RUNTIME_DIAGNOSTICS_ALERT_WINDOW_MS,
  RUNTIME_DIAGNOSTICS_DETAILS,
  RUNTIME_DIAGNOSTICS_INCIDENT_LIMIT,
  RUNTIME_DIAGNOSTICS_SCHEMA,
  RUNTIME_DIAGNOSTICS_SCHEMA_VERSION,
  RUNTIME_DIAGNOSTICS_STALE_AFTER_MS,
  redactRuntimeText,
  sanitizeRuntimeDiagnosticsReport,
  type RuntimeAgeState,
  type RuntimeBuildIdentity,
  type RuntimeDiagnosticsDetail,
  type RuntimeDiagnosticsReport,
  type RuntimeHealthReason,
  type RuntimeHealthState,
  type RuntimeIncidentOutcome,
  type RuntimeQueueReadout,
  type RuntimeReasonCode,
  type RuntimeServiceDimension,
  type RuntimeTiming,
} from "../../shared/runtimeDiagnostics";

/** 进程启动时刻（构建身份/进程身份用；进程内一次求值） */
const PROCESS_STARTED_MS = Date.now() - Math.round(process.uptime() * 1000);

/**
 * 降级起点：**按 scope（项目 id / 全局）各记一份**，恢复 healthy 即清该 scope（incidents 历史仍保留）。
 * R69-02 返工：原先是**单个** module 变量，一个项目（或全局）的一次 healthy 读会把别的项目的降级起点清零；
 * 现在①按 scope 独立；②**优先从真实异常时间派生**（scoped `last_anomaly` / `last_rejection_at` 的最小值），
 * 无异常证据时才回退到"首次观测到降级"的时刻。map **有界**（超出淘汰最旧），不随项目数无界增长。
 * 仅内存观测，不落账本。
 */
const DEGRADED_SCOPE_LIMIT = 64;
const degradedSinceByScope = new Map<string, string>();

function scopeKeyOf(projectId: string | null): string {
  return projectId ?? "__global__";
}

function evictDegradedScopeIfNeeded(keep: string): void {
  while (degradedSinceByScope.size > DEGRADED_SCOPE_LIMIT) {
    const oldest = degradedSinceByScope.keys().next().value;
    if (oldest === undefined || oldest === keep) return;
    degradedSinceByScope.delete(oldest);
  }
}

/** 计算某 scope 的降级起点（healthy 清空；有真实异常时间就优先用它） */
function resolveDegradedSince(
  projectId: string | null,
  status: RuntimeHealthState,
  lastAnomalyAt: number | null,
  lastRejectionAt: number | null,
  now: number,
): string | null {
  const scope = scopeKeyOf(projectId);
  if (status === "healthy") {
    degradedSinceByScope.delete(scope);
    return null;
  }
  const candidates = [lastAnomalyAt, lastRejectionAt].filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (candidates.length > 0) {
    const iso = toIso(new Date(Math.min(...candidates)));
    degradedSinceByScope.delete(scope);
    degradedSinceByScope.set(scope, iso);
    evictDegradedScopeIfNeeded(scope);
    return iso;
  }
  const existing = degradedSinceByScope.get(scope);
  if (existing !== undefined) return existing;
  const iso = toIso(new Date(now));
  degradedSinceByScope.set(scope, iso);
  evictDegradedScopeIfNeeded(scope);
  return iso;
}

/** 验证用：隔离降级起点 map（不暴露给产品路径） */
export function __resetDegradedSinceForTest(): void {
  degradedSinceByScope.clear();
}

/** 唯一写服务（宿主）描述符现场探针——由调用方从 `readOwnership` 取得，不在此模块重算所有权 */
export interface RuntimeServiceProbe {
  present: boolean;
  state: "missing" | "valid" | "invalid";
  pid_alive: boolean;
  is_self: boolean;
  /** 所有权未知时的原始原因（可能夹 `err.message`）。**不内联进报告**（R69-05：报告只出受控模板），仅供调用方日志。 */
  reason: string | null;
}

// ── 状态派生（**唯一判据**：界面与 Agent 同源）──────────────────────────────

export interface RuntimeHealthSignals {
  now: number;
  descriptorState: "missing" | "valid" | "invalid";
  descriptorPidAlive: boolean;
  readMode: RuntimeQueueReadout["mode"];
  scanMode: RuntimeQueueReadout["mode"];
  readQueued: number;
  readQueueLimit: number;
  lastRejectionAt: number | null;
  lastSuccessAt: number | null;
  lastAnomaly: { at: number; outcome: RuntimeIncidentOutcome; code: RuntimeReasonCode } | null;
  staleAfterMs: number;
}

export interface RuntimeHealthDerivation {
  status: RuntimeHealthState;
  reasons: RuntimeHealthReason[];
  age_state: RuntimeAgeState;
}

/** 新鲜度三态（**不自动判失效**）：fresh=仍新；stale=该重新看一眼；unknown=无成功观测 */
export function ageStateOf(lastSuccessAt: number | null, now: number, staleAfterMs: number): RuntimeAgeState {
  if (lastSuccessAt === null) return "unknown";
  return now - lastSuccessAt <= staleAfterMs ? "fresh" : "stale";
}

const ANOMALY_DETAIL: Partial<Record<RuntimeReasonCode, string>> = {
  READ_TIMED_OUT: "最近一次读作业超时未返回（超时≠服务已死；该次读取超预算）",
  READ_FAILED: "最近一次读作业失败（结构化错误）",
  READ_ABORTED: "最近一次读作业被调用方取消",
  READ_WORKERS_UNAVAILABLE: "只读 worker 池近期拒绝过作业（明确失败）",
  QUEUE_SATURATED: "只读队列已达上限或近期有读作业被拒（该次读被拒，服务本身可达）",
};

/**
 * 从信号派生统一状态（**只有这一处**判 healthy/degraded/unavailable/unknown）：
 *   ⓪ 描述符**在场但损坏/读不出**＝所有权未知 ⇒ `unknown`（R69-01：既不猜 healthy，也不猜「确定不可达」）；
 *   ① 明确不可达/拒绝（描述符缺失、进程退出、worker 不可用）⇒ `unavailable`；
 *   ② 近期饱和（队列满/近期被拒）⇒ `degraded`（**不得**报 unavailable；只是该次读排队被拒）；
 *   ③ 未恢复的**故障**（失败/超时；取消不算故障）：曾有成功 ⇒ `degraded`，从未成功 ⇒ `unknown`；
 *   ④ 完全无成功观测（从未成功、无故障、无拒绝）＝冷启动 ⇒ `unknown`（R69-03：不凭描述符存活猜 healthy）；
 *   ⑤ 否则 `healthy`（`stale` 只是「该再看一眼」，**不单独降级**）。
 */
export function deriveRuntimeHealth(s: RuntimeHealthSignals): RuntimeHealthDerivation {
  const reasons: RuntimeHealthReason[] = [];
  const age = ageStateOf(s.lastSuccessAt, s.now, s.staleAfterMs);
  let status: RuntimeHealthState = "healthy";

  // ⓪ 所有权未知：描述符在场但损坏/读不出/形状不合法（`serviceOwnership` 明确定性为「既不发布也不删除」）。
  if (s.descriptorState === "invalid") {
    status = "unknown";
    reasons.push({
      code: "UNKNOWN",
      detail: "写入服务描述符在场但损坏/读不出：所有权未知、证据不足，既不猜 healthy 也不猜不可达",
      subject: "service",
    });
  } else if (s.descriptorState === "missing") {
    // ① 明确不可达/拒绝
    status = "unavailable";
    reasons.push({ code: "SOURCE_UNAVAILABLE", detail: "数据目录里没有写入服务描述符：写服务未启动或已退出撤销", subject: "service" });
  } else if (!s.descriptorPidAlive) {
    // 描述符合法（valid）但所指进程已退出：陈旧指针。
    status = "unavailable";
    reasons.push({ code: "PROCESS_EXITED", detail: "写入服务描述符指向的进程已退出（陈旧指针，端口不会有人应答）", subject: "service" });
  } else if (s.readMode === "unavailable" || s.scanMode === "unavailable") {
    status = "unavailable";
    reasons.push({ code: "READ_WORKERS_UNAVAILABLE", detail: "只读 worker 池起不来（明确失败，未回退主线程重算）", subject: "read" });
  }

  if (status === "healthy") {
    // 「取消」不是故障证据（正常用户/调用方主动取消）——只保留 READ_ABORTED 证据，不据此永久降级。
    const faultAnomaly = s.lastAnomaly !== null && s.lastAnomaly.code !== "READ_ABORTED" ? s.lastAnomaly : null;
    // ② 近期饱和（瞬时态，不判死机）
    const saturated =
      (s.readQueueLimit > 0 && s.readQueued >= s.readQueueLimit) ||
      (s.lastRejectionAt !== null && s.now - s.lastRejectionAt <= RUNTIME_DIAGNOSTICS_ALERT_WINDOW_MS);
    if (saturated) {
      status = "degraded";
      reasons.push({ code: "QUEUE_SATURATED", detail: ANOMALY_DETAIL.QUEUE_SATURATED!, subject: "read" });
    } else if (faultAnomaly !== null && (s.lastSuccessAt === null || s.lastSuccessAt < faultAnomaly.at)) {
      // ③ 未恢复的**故障**（失败/超时；取消已在上面排除）
      const code = faultAnomaly.code;
      const base = ANOMALY_DETAIL[code] ?? "最近一次读作业异常";
      if (s.lastSuccessAt !== null) {
        status = "degraded";
        reasons.push({ code, detail: `${base}；曾有成功观测，故按可达但降级（不判死机）`, subject: "read" });
      } else {
        status = "unknown";
        reasons.push({ code, detail: `${base}；**从未成功过**，证据不足，不猜死机（unknown）`, subject: "read" });
      }
    }
    // ④ 冷启动：从未成功、无故障、无拒绝 ⇒ 证据不足，**不**凭描述符存活猜 healthy。
    if (status === "healthy" && s.lastSuccessAt === null && faultAnomaly === null && s.lastRejectionAt === null) {
      status = "unknown";
      reasons.push({
        code: "NO_EVIDENCE",
        detail: "尚无任何成功的只读观测（冷启动/未经过一次读作业）：证据不足，不凭描述符存活猜 healthy",
        subject: "read",
      });
    }
    // 取消证据：如实标注（不算故障、不改状态），保留 READ_ABORTED 必要证据。
    if (s.lastAnomaly !== null && s.lastAnomaly.code === "READ_ABORTED" && (s.lastSuccessAt === null || s.lastSuccessAt < s.lastAnomaly.at)) {
      reasons.push({ code: "READ_ABORTED", detail: "最近一次读作业被调用方主动取消（正常收口，不算故障、不永久降级）", subject: "read" });
    }
    if (status === "healthy" && age === "stale") {
      // stale 只作提示，**不单独降级**（避免空闲宿主误报）：附一条 STALE_OBSERVATION 说明，状态维持 healthy。
      reasons.push({ code: "STALE_OBSERVATION", detail: "最近一次成功观测已超过新鲜度阈值：这份读数该再看一眼（stale 不自动判失效）", subject: "process" });
    }
  }

  if (status === "healthy" && reasons.length === 0) {
    reasons.push({ code: "OK", detail: "全部已测维度正常", subject: null });
  }
  return { status, reasons, age_state: age };
}

// ── 报告装配 ──────────────────────────────────────────────────────────────

function queueReadout(p: ReadWorkerPoolStatus): RuntimeQueueReadout {
  return {
    mode: p.mode,
    busy: p.busy,
    queued: p.queued,
    queue_limit: p.queue_limit,
    pool_size: p.pool_size,
    group_queue_limit: p.group_queue_limit,
    groups_queued: p.groups_queued,
    started: p.started,
    completed: p.completed,
    failed: p.failed,
    timeouts: p.timed_out,
    rejected_full: p.rejected_full,
    rejected_group_full: p.rejected_group_full,
  };
}

export interface RuntimeDiagnosticsBuildInput {
  dataDir: string;
  /** 已由调用方校验（注册表里的 id 或 null） */
  projectId: string | null;
  detail: RuntimeDiagnosticsDetail;
  /** 唯一写服务描述符探针（调用方从 readOwnership 取） */
  service: RuntimeServiceProbe;
  now?: number;
  /** 池状态注入（默认现读）；验证脚本可用它构造"重派生在途"现场 */
  pools?: WorkHostWorkerStatus;
  /** 遥测注入（默认现读内存）；验证脚本用 */
  telemetry?: RuntimeTelemetrySnapshot;
}

/** 装配一份运行诊断报告（宿主只读；O(有界记录)，不做任何重推导） */
export function buildRuntimeDiagnosticsReport(input: RuntimeDiagnosticsBuildInput): RuntimeDiagnosticsReport {
  const now = input.now ?? Date.now();
  const pools = input.pools ?? readWorkerPoolStatus();
  const telemetry = input.telemetry ?? runtimeTelemetry();
  const read = queueReadout(pools);
  const scan = queueReadout(pools.scan);

  const projectId = input.projectId;
  const incidents = telemetry.incidents
    .filter((inc) => projectId === null || inc.project_id === projectId)
    .slice(-RUNTIME_DIAGNOSTICS_INCIDENT_LIMIT);
  const scoped = projectId === null ? null : telemetry.by_project[projectId] ?? null;
  const scopedAnomaly = projectId === null ? telemetry.last_anomaly : scoped?.last_anomaly ?? null;
  const scopedLastSuccess = projectId === null ? telemetry.last_success_at : scoped?.last_success_at ?? null;
  const scopedRejection = projectId === null ? telemetry.last_rejection_at : scoped?.last_rejection_at ?? null;

  const derived = deriveRuntimeHealth({
    now,
    descriptorState: input.service.state,
    descriptorPidAlive: input.service.pid_alive,
    readMode: read.mode,
    scanMode: scan.mode,
    readQueued: read.queued,
    readQueueLimit: read.queue_limit,
    lastRejectionAt: scopedRejection,
    lastSuccessAt: scopedLastSuccess,
    lastAnomaly: scopedAnomaly,
    staleAfterMs: RUNTIME_DIAGNOSTICS_STALE_AFTER_MS,
  });

  const serverIdentity = resolveBuildIdentity("server");
  const uiIdentity = resolveBuildIdentity("ui");
  const skew = compareBuildIdentities(serverIdentity, uiIdentity);

  // degraded_since：按 scope（项目/全局）独立、优先从真实异常时间派生、有界（R69-02 返工）。
  const degradedSince = resolveDegradedSince(
    projectId,
    derived.status,
    scopedAnomaly?.at ?? null,
    scopedRejection,
    now,
  );

  const timing: RuntimeTiming = {
    samples: telemetry.samples,
    queue_ms: telemetry.queue_ms,
    execution_ms: telemetry.execution_ms,
    total_ms: telemetry.total_ms,
  };

  const report: RuntimeDiagnosticsReport = {
    ok: true,
    schema: RUNTIME_DIAGNOSTICS_SCHEMA,
    schema_version: RUNTIME_DIAGNOSTICS_SCHEMA_VERSION,
    generated_at: toIso(new Date(now)),
    project_id: projectId,
    detail: input.detail,
    process: {
      pid: process.pid,
      started_at: toIso(new Date(PROCESS_STARTED_MS)),
      release_id: serverIdentity.embedded ? serverIdentity.release_id : null,
      build_identity: sanitizeIdentity(serverIdentity),
      build_identity_skew: { state: skew.state, detail: redactRuntimeText(skew.detail) },
    },
    service: serviceDimension(input.service, scopedLastSuccess, derived.age_state),
    status: derived.status,
    reasons: derived.reasons.map((r) => ({ ...r, detail: redactRuntimeText(r.detail) })),
    last_success: scopedLastSuccess === null ? null : { at: toIso(new Date(scopedLastSuccess)), age_ms: Math.max(0, now - scopedLastSuccess) },
    stale_after_ms: RUNTIME_DIAGNOSTICS_STALE_AFTER_MS,
    age_state: derived.age_state,
    degraded_since: degradedSince,
    incidents,
    queue: { read, scan },
    timing,
    unsupported: [],
  };
  // 纵深防御：报告再过一次共享 typed allowlist sanitize（未知/意外字段一律丢弃）。
  const clean = sanitizeRuntimeDiagnosticsReport(report);
  if (clean === null) throw new Error("runtime diagnostics: sanitize 失败（内部装配错误）");
  return clean;
}

function sanitizeIdentity(id: BuildIdentity): RuntimeBuildIdentity {
  if (id.embedded) {
    return { component: id.component, embedded: true, release_id: id.release_id, build_id: id.build_id, reason: null };
  }
  return { component: id.component, embedded: false, release_id: null, build_id: null, reason: redactRuntimeText(id.reason) };
}

function serviceDimension(probe: RuntimeServiceProbe, lastSuccessAt: number | null, ageState: RuntimeAgeState): RuntimeServiceDimension {
  const reachable = probe.state === "valid" && probe.pid_alive;
  // R69-05：`service.reason` **只产生受控模板**——`probe.reason`（可能夹 `err.message`/路径原文）**不内联**进报告；
  // 损坏/读不出的具体原因留给宿主日志，这里只按描述符状态给稳定模板（与 `reasons[]` 同一口径）。
  return {
    reachable,
    descriptor: { present: probe.present, state: probe.state, pid_alive: probe.pid_alive, is_self: probe.is_self },
    reason: reachable
      ? null
      : probe.state === "missing"
        ? "数据目录里没有写入服务描述符"
        : probe.state === "invalid"
          ? "写入服务描述符在场但损坏/读不出（所有权未知，既不发布也不删除）"
          : "写入服务描述符指向的进程已退出",
    last_success_at: lastSuccessAt === null ? null : toIso(new Date(lastSuccessAt)),
    age_state: ageState,
  };
}

// ── HTTP 查询解析（两读口**同形**；输入非法一律 400，不静默忽略）─────────────────

export interface RuntimeDiagnosticsQuery {
  projectId: string | null;
  detail: RuntimeDiagnosticsDetail;
}

export type RuntimeDiagnosticsQueryResult =
  | { ok: true; query: RuntimeDiagnosticsQuery }
  | { ok: false; message: string; detail: Record<string, unknown> };

const ALLOWED_QUERY_KEYS = ["project_id", "detail"] as const;

/** 解析并校验两读口的查询串（缺省 project_id=null 全局、detail=summary；其余一律 400） */
export function parseRuntimeDiagnosticsQuery(rawUrl: string): RuntimeDiagnosticsQueryResult {
  let url: URL;
  try {
    url = new URL(rawUrl, "http://127.0.0.1");
  } catch {
    return { ok: false, message: "查询串无法解析", detail: {} };
  }
  const seen = new Set<string>();
  for (const key of url.searchParams.keys()) {
    if (!(ALLOWED_QUERY_KEYS as readonly string[]).includes(key)) {
      return { ok: false, message: `不支持的查询参数: ${redactRuntimeText(key, 60)}（只接受 project_id / detail）`, detail: { rejected_key: key } };
    }
    if (seen.has(key)) {
      return { ok: false, message: `查询参数重复: ${key}`, detail: { duplicate_key: key } };
    }
    seen.add(key);
  }
  const rawProject = url.searchParams.get("project_id");
  const projectId = rawProject === null ? null : rawProject.trim();
  if (projectId !== null && projectId === "") {
    return { ok: false, message: "project_id 不能为空串（省略即全局）", detail: {} };
  }
  const rawDetail = url.searchParams.get("detail");
  let detail: RuntimeDiagnosticsDetail = "summary";
  if (rawDetail !== null) {
    const d = rawDetail.trim();
    if (!(RUNTIME_DIAGNOSTICS_DETAILS as readonly string[]).includes(d)) {
      return { ok: false, message: `detail 必须是 ${RUNTIME_DIAGNOSTICS_DETAILS.join("|")}（收到 ${JSON.stringify(rawDetail)}）`, detail: { received: rawDetail } };
    }
    detail = d as RuntimeDiagnosticsDetail;
  }
  return { ok: true, query: { projectId, detail } };
}

// ── 双读口共用的 HTTP 响应语义（输入 400；异常按 reason 区分；两读口**同形**）──────────

export interface RuntimeDiagnosticsRouteResult {
  status: number;
  body: unknown;
}

/**
 * 两读口共用的响应装配（本地 `/api/runtime/diagnostics` 与 tokened `/api/work/diagnostics` 同形）：
 *   · `remoteLocalOnlyDenied` ⇒ 403 REMOTE_LOCAL_ONLY（**本地维护口**不对远程放行，不暴露本机运行时细节）；
 *   · 查询非法 ⇒ 400 INVALID_INPUT（`detail` 非法 / `project_id` 空串 / 不支持或重复的参数；不静默忽略）；
 *   · `project_id` 给了但未注册 ⇒ 400 INVALID_INPUT（**不**返回空成功）；
 *   · 读失败 ⇒ 503 `{reason:"SOURCE_UNAVAILABLE"}`（`QUEUE_SATURATED` 只在报告 `status/reasons` 里表达——
 *     诊断**不进**读池队列，故读池饱和**不会**让本读口 503；`SOURCE_UNAVAILABLE` 与 `QUEUE_SATURATED` 分清）。
 */
export function runtimeDiagnosticsRouteResult(opts: {
  rawUrl: string;
  /** 本地维护口：远程来源为 true（直接 403）；tokened 读口传 false/省略 */
  remoteLocalOnlyDenied?: boolean;
  projectExists: (id: string) => boolean;
  build: (q: RuntimeDiagnosticsQuery) => RuntimeDiagnosticsReport;
}): RuntimeDiagnosticsRouteResult {
  if (opts.remoteLocalOnlyDenied === true) {
    return {
      status: 403,
      body: {
        ok: false,
        code: "REMOTE_LOCAL_ONLY",
        message: "运行诊断是本地维护读口：远程来源默认禁止（不对外暴露本机运行时细节）；请在主机本机界面查看",
        detail: {},
      },
    };
  }
  const parsed = parseRuntimeDiagnosticsQuery(opts.rawUrl);
  if (!parsed.ok) {
    return { status: 400, body: { ok: false, code: "INVALID_INPUT", message: parsed.message, detail: parsed.detail } };
  }
  const { projectId, detail } = parsed.query;
  if (projectId !== null && !opts.projectExists(projectId)) {
    return { status: 400, body: { ok: false, code: "INVALID_INPUT", message: `项目不存在: ${projectId}`, detail: { project_id: projectId } } };
  }
  try {
    return { status: 200, body: opts.build({ projectId, detail }) };
  } catch {
    return {
      status: 503,
      body: { ok: false, code: "SOURCE_UNAVAILABLE", reason: "SOURCE_UNAVAILABLE", message: "运行诊断读取失败（内部错误，详见宿主日志）", detail: {} },
    };
  }
}

/**
 * 旧宿主/旧客户端/读取失败时的**回退报告**（**不猜**成 healthy/unavailable 之外的结论）：
 *   · `unsupported`（宿主无该读口 / 契约不符）⇒ status `unknown` + `unsupported:[...]`（不回退写路由、不另算判据）；
 *   · `unavailable`（描述符缺失/不可达，**明确证据**）⇒ status `unavailable` + `SOURCE_UNAVAILABLE`；
 *   · `error`（宿主明确结构化错误）⇒ status `unknown` + `UNKNOWN`。
 */
export function runtimeDiagnosticsFallback(
  kind: "unsupported" | "unavailable" | "error",
  reason: string,
  now = Date.now(),
  unsupported: string[] = ["runtime_diagnostics"],
): RuntimeDiagnosticsReport {
  const status: RuntimeHealthState = kind === "unavailable" ? "unavailable" : "unknown";
  const code: RuntimeReasonCode = kind === "unavailable" ? "SOURCE_UNAVAILABLE" : kind === "unsupported" ? "UNSUPPORTED" : "UNKNOWN";
  return {
    ok: true,
    schema: RUNTIME_DIAGNOSTICS_SCHEMA,
    schema_version: RUNTIME_DIAGNOSTICS_SCHEMA_VERSION,
    generated_at: toIso(new Date(now)),
    project_id: null,
    detail: "summary",
    process: {
      pid: null,
      started_at: null,
      release_id: null,
      build_identity: { component: null, embedded: false, release_id: null, build_id: null, reason: "宿主未提供构建身份" },
      build_identity_skew: { state: "unknown", detail: "宿主未提供" },
    },
    service: { reachable: false, descriptor: { present: false, state: "missing", pid_alive: false, is_self: false }, reason: null, last_success_at: null, age_state: "unknown" },
    status,
    reasons: [{ code, detail: redactRuntimeText(reason), subject: null }],
    last_success: null,
    stale_after_ms: RUNTIME_DIAGNOSTICS_STALE_AFTER_MS,
    age_state: "unknown",
    degraded_since: null,
    incidents: [],
    queue: { read: zeroQueueReadout("unknown"), scan: zeroQueueReadout("unknown") },
    timing: { samples: 0, queue_ms: null, execution_ms: null, total_ms: null },
    unsupported: kind === "unsupported" ? [...unsupported] : [],
  };
}

/** 旧宿主/旧客户端不支持时的未知报告（**不猜**成 healthy/unavailable；doctor 回退用） */
export function unsupportedRuntimeDiagnosticsReport(unsupported: string[], now = Date.now()): RuntimeDiagnosticsReport {
  return runtimeDiagnosticsFallback("unsupported", "宿主/客户端未提供运行诊断读口：按未知处理，不猜", now, unsupported);
}

function zeroQueueReadout(mode: RuntimeQueueReadout["mode"]): RuntimeQueueReadout {
  return {
    mode,
    busy: 0,
    queued: 0,
    queue_limit: 0,
    pool_size: 0,
    group_queue_limit: 0,
    groups_queued: 0,
    started: 0,
    completed: 0,
    failed: 0,
    timeouts: 0,
    rejected_full: 0,
    rejected_group_full: 0,
  };
}
