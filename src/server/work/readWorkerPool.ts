// V09-37：宿主**只读**计算的有界 worker_threads 池（DESIGN §6.8 / 契约 U4；本会话任务目标二）。
//
// 为什么必须有它：桌面宿主/index.ts 与独立 daemon 的主线程要同时服务**健康读口**（`/api/work/health`）与
// **CPU 重的只读派生**（同步状态、六图摘要、接续入口、图构建）。此前这些派生在主线程**同步**跑，占用事件循环
// ——健康口/进度口被纯只读计算占住（2026-10-02 诊断里的健康读超时症状）。本池把重派生挪到 worker 线程：
// 主线程只等 `postMessage`，事件循环保持可响应（软/硬界面都靠这个）。
//
// 硬口径：
//   · **有界**：worker 数有上限（`TATAI_READ_WORKER_POOL`，缺省 1–2）；排队长度有上限（`TATAI_READ_WORKER_QUEUE`），
//     满了**显式拒绝**（不无限排队、不静默丢弃）。
//   · **不静默回退主线程**：worker 起不来是**明确错误**（`READ_WORKERS_UNAVAILABLE`）——调用方如实报错，
//     不偷偷在主线程重算（那会把健康口又占住，等于没修）。显式本地执行只认 `TATAI_READ_WORKERS=local` 或
//     `opts.mode="local"`（测试/oracle 用）。
//   · **只收自己拥有的 worker**：`stop` 只 terminate 本池起的 worker，不动外部 Agent/其它进程。
//   · **超时即取消**：单个作业超过 `TATAI_READ_WORKER_TIMEOUT_MS`（缺省 120s）就把**该 worker 线程**terminate
//     并重起槽位——卡死的作业不会永久占住队列（取消只收回自己拥有的线程）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { Worker } from "node:worker_threads";
import { runReadJobLocal, type ReadJobKind } from "./readJobs";
import { toIso } from "../time";
import {
  RUNTIME_DIAGNOSTICS_INCIDENT_LIMIT,
  isRuntimeJobKind,
  type RuntimeIncident,
  type RuntimeIncidentOutcome,
  type RuntimeJobKind,
  type RuntimeReasonCode,
  type RuntimeTimingStat,
} from "../../shared/runtimeDiagnostics";

// ═══ V09-69（DESIGN §3.18／§6.15）：有界**内存**运行遥测 ═══════════════════════════════
// 为什么收在池里：作业的排队/开始/成功/失败/超时/取消**只有池知道**（生命周期点在此）。
// 硬口径：**只内存**（不落账本/不写事件）、**有界**（incidents ≤ 40、时延样本环 ≤ 256）；只记
// **异常**进 incidents（成功只更新新鲜度）；正常恢复后 incidents **历史保留**、当前告警随状态回正。
const TIMING_SAMPLE_LIMIT = 256;
/** `byProject` 的**容量上限**（R69-04）：超出按最旧淘汰（LRU 触达），不随 distinct project_id 无界增长。 */
export const RUNTIME_TELEMETRY_MAX_PROJECTS = 64;
/** incident reason 是**受控模板**（R69-05）：不含 `err.message`/路径/query/正文原文 */
const INCIDENT_REASON_TEMPLATE: Record<RuntimeIncidentOutcome, string> = {
  failed: "只读作业失败（结构化错误，详见宿主日志）",
  timed_out: "只读作业超时未返回（已取消该 worker，不占住队列）",
  aborted: "只读作业被调用方主动取消（正常收口，不算故障）",
  rejected_full: "只读作业队列已满（有界拒绝，稍后重试）",
  rejected_group_full: "单分组排队已达上限（有界拒绝，单项目不占满队列）",
  unavailable: "只读 worker 池不可用（未回退主线程）",
};
/** 结构化错误码闭集形态：非法一律回退，避免把 query/token/正文塞进 incident.code。 */
const ERROR_CODE_RE = /^[A-Z][A-Z0-9_]{0,79}$/;
function safeErrorCode(code: string | null | undefined, fallback: string): string {
  return typeof code === "string" && ERROR_CODE_RE.test(code) ? code : fallback;
}

interface PendingJobTelemetry {
  /** 稳定作业种类闭集；未知 kind 记 null（R69-07：不默认误标成 `entry`） */
  kind: RuntimeJobKind | null;
  project_id: string | null;
  queued_at: number;
  started_at: number | null;
}
interface AnomalySignal {
  at: number;
  outcome: RuntimeIncidentOutcome;
  code: RuntimeReasonCode;
}
interface ProjectSignal {
  last_success_at: number | null;
  last_anomaly: AnomalySignal | null;
  last_rejection_at: number | null;
}

interface TelemetryState {
  incidents: RuntimeIncident[];
  pending: Map<number, PendingJobTelemetry>;
  queueSamples: number[];
  executionSamples: number[];
  totalSamples: number[];
  lastSuccessAt: number | null;
  lastAnomaly: AnomalySignal | null;
  lastRejectionAt: number | null;
  byProject: Map<string, ProjectSignal>;
}

const ANOMALY_REASON_CODE: Record<RuntimeIncidentOutcome, RuntimeReasonCode> = {
  failed: "READ_FAILED",
  timed_out: "READ_TIMED_OUT",
  aborted: "READ_ABORTED",
  rejected_full: "QUEUE_SATURATED",
  rejected_group_full: "QUEUE_SATURATED",
  unavailable: "READ_WORKERS_UNAVAILABLE",
};

function newTelemetry(): TelemetryState {
  return {
    incidents: [],
    pending: new Map(),
    queueSamples: [],
    executionSamples: [],
    totalSamples: [],
    lastSuccessAt: null,
    lastAnomaly: null,
    lastRejectionAt: null,
    byProject: new Map(),
  };
}

let telemetry: TelemetryState = newTelemetry();

function telemetryProject(projectId: string | null): ProjectSignal | null {
  if (projectId === null) return null;
  let s = telemetry.byProject.get(projectId);
  if (s === undefined) {
    s = { last_success_at: null, last_anomaly: null, last_rejection_at: null };
    telemetry.byProject.set(projectId, s);
    // R69-04：有界——超出上限按**最旧**淘汰（不随项目数无界增长）。
    while (telemetry.byProject.size > RUNTIME_TELEMETRY_MAX_PROJECTS) {
      const oldest = telemetry.byProject.keys().next().value;
      if (oldest === undefined || oldest === projectId) break;
      telemetry.byProject.delete(oldest);
    }
  } else {
    // LRU 触达：把该 scope 移到末尾（最近使用），淘汰时先丢最久未用的。
    telemetry.byProject.delete(projectId);
    telemetry.byProject.set(projectId, s);
  }
  return s;
}

function pushIncident(inc: RuntimeIncident): void {
  telemetry.incidents.push(inc);
  if (telemetry.incidents.length > RUNTIME_DIAGNOSTICS_INCIDENT_LIMIT) {
    telemetry.incidents.splice(0, telemetry.incidents.length - RUNTIME_DIAGNOSTICS_INCIDENT_LIMIT);
  }
}

function pushSample(ring: number[], v: number): void {
  ring.push(v);
  if (ring.length > TIMING_SAMPLE_LIMIT) ring.splice(0, ring.length - TIMING_SAMPLE_LIMIT);
}

function statOf(ring: number[]): RuntimeTimingStat | null {
  if (ring.length === 0) return null;
  let min = ring[0]!;
  let max = ring[0]!;
  let sum = 0;
  for (const v of ring) {
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  return { count: ring.length, min_ms: min, max_ms: max, avg_ms: Math.round(sum / ring.length) };
}

/**
 * 「尚未恢复的故障」：上一条异常**不是取消**，且其后**没有**更新的成功观测（成功即解除对应故障）。
 * 供 `noteAnomaly` 判定普通取消能否覆盖当前异常信号（ND1）——全局/项目 scope 各用各自的信号。
 */
function hasOutstandingFault(lastAnomaly: AnomalySignal | null, lastSuccessAt: number | null): boolean {
  if (lastAnomaly === null || lastAnomaly.outcome === "aborted") return false;
  return lastSuccessAt === null || lastSuccessAt < lastAnomaly.at;
}

function noteAnomaly(outcome: RuntimeIncidentOutcome, at: number, projectId: string | null): void {
  const signal: AnomalySignal = { at, outcome, code: ANOMALY_REASON_CODE[outcome] };
  const p = telemetryProject(projectId);
  if (outcome === "aborted") {
    // ND1（2026-10-13 复审判据）：普通取消**只作历史**（incidents 已记），**不覆盖尚未恢复的故障信号**。
    // 否则「成功 → 真失败/超时 → 普通取消（无新成功）」会用最后一次取消盖掉真故障，而
    // `deriveRuntimeHealth` 忽略 aborted ⇒ 掩盖故障落 healthy。全局/项目 scope 各自独立判定。
    if (!hasOutstandingFault(telemetry.lastAnomaly, telemetry.lastSuccessAt)) telemetry.lastAnomaly = signal;
    if (p !== null && !hasOutstandingFault(p.last_anomaly, p.last_success_at)) p.last_anomaly = signal;
    return;
  }
  telemetry.lastAnomaly = signal;
  if (p !== null) p.last_anomaly = signal;
}

/** settle：把在途作业结算成耗时样本 + 返回入账依据（作业不在册则只给 now） */
function settleTelemetry(id: number): {
  job: PendingJobTelemetry | null;
  now: number;
  queue_ms: number | null;
  execution_ms: number | null;
  total_ms: number | null;
} {
  const job = telemetry.pending.get(id) ?? null;
  const at = Date.now();
  if (job === null) return { job: null, now: at, queue_ms: null, execution_ms: null, total_ms: null };
  const queueMs = job.started_at === null ? null : Math.max(0, job.started_at - job.queued_at);
  const executionMs = job.started_at === null ? null : Math.max(0, at - job.started_at);
  const totalMs = Math.max(0, at - job.queued_at);
  telemetry.pending.delete(id);
  if (queueMs !== null) pushSample(telemetry.queueSamples, queueMs);
  if (executionMs !== null) pushSample(telemetry.executionSamples, executionMs);
  pushSample(telemetry.totalSamples, totalMs);
  return { job, now: at, queue_ms: queueMs, execution_ms: executionMs, total_ms: totalMs };
}

function noteQueued(id: number, kind: ReadJobKind, projectId: string | null): void {
  telemetry.pending.set(id, {
    kind: isRuntimeJobKind(kind) ? kind : null,
    project_id: projectId,
    queued_at: Date.now(),
    started_at: null,
  });
}
function noteStarted(id: number): void {
  const job = telemetry.pending.get(id);
  if (job !== undefined && job.started_at === null) job.started_at = Date.now();
}
function noteSucceeded(id: number): void {
  const s = settleTelemetry(id);
  telemetry.lastSuccessAt = s.now;
  const p = telemetryProject(s.job?.project_id ?? null);
  if (p !== null) p.last_success_at = s.now;
}
function noteAnomalyOutcome(id: number, outcome: RuntimeIncidentOutcome, code: string | null): void {
  const s = settleTelemetry(id);
  const projectId = s.job?.project_id ?? null;
  pushIncident({
    at: toIso(new Date(s.now)),
    outcome,
    job_kind: s.job?.kind ?? null,
    project_id: projectId,
    code: safeErrorCode(code, ANOMALY_REASON_CODE[outcome]),
    reason: INCIDENT_REASON_TEMPLATE[outcome],
    queue_ms: s.queue_ms,
    execution_ms: s.execution_ms,
    total_ms: s.total_ms,
  });
  noteAnomaly(outcome, s.now, projectId);
}
function noteRejected(kind: ReadJobKind, projectId: string | null, outcome: "rejected_full" | "rejected_group_full"): void {
  const at = Date.now();
  pushIncident({
    at: toIso(new Date(at)),
    outcome,
    job_kind: isRuntimeJobKind(kind) ? kind : null,
    project_id: projectId,
    code: "READ_QUEUE_FULL",
    reason: INCIDENT_REASON_TEMPLATE[outcome],
    queue_ms: null,
    execution_ms: null,
    total_ms: null,
  });
  telemetry.lastRejectionAt = at;
  const p = telemetryProject(projectId);
  if (p !== null) p.last_rejection_at = at;
  noteAnomaly(outcome, at, projectId);
}
function noteWorkersUnavailable(count: number, projectId: string | null): void {
  if (count <= 0) return;
  const at = Date.now();
  pushIncident({
    at: toIso(new Date(at)),
    outcome: "unavailable",
    job_kind: null,
    project_id: projectId,
    code: "READ_WORKERS_UNAVAILABLE",
    reason: INCIDENT_REASON_TEMPLATE.unavailable,
    queue_ms: null,
    execution_ms: null,
    total_ms: null,
  });
  noteAnomaly("unavailable", at, projectId);
}

/** 只读遥测快照（供运行诊断 builder 与验证脚本；不泄漏可变引用） */
export interface RuntimeTelemetrySnapshot {
  incidents: RuntimeIncident[];
  last_success_at: number | null;
  last_anomaly: AnomalySignal | null;
  last_rejection_at: number | null;
  by_project: Record<string, { last_success_at: number | null; last_anomaly: AnomalySignal | null; last_rejection_at: number | null }>;
  queue_ms: RuntimeTimingStat | null;
  execution_ms: RuntimeTimingStat | null;
  total_ms: RuntimeTimingStat | null;
  samples: number;
}

export function runtimeTelemetry(): RuntimeTelemetrySnapshot {
  const byProject: RuntimeTelemetrySnapshot["by_project"] = {};
  for (const [k, v] of telemetry.byProject) {
    byProject[k] = {
      last_success_at: v.last_success_at,
      last_anomaly: v.last_anomaly === null ? null : { ...v.last_anomaly },
      last_rejection_at: v.last_rejection_at,
    };
  }
  return {
    incidents: telemetry.incidents.slice(),
    last_success_at: telemetry.lastSuccessAt,
    last_anomaly: telemetry.lastAnomaly === null ? null : { ...telemetry.lastAnomaly },
    last_rejection_at: telemetry.lastRejectionAt,
    by_project: byProject,
    queue_ms: statOf(telemetry.queueSamples),
    execution_ms: statOf(telemetry.executionSamples),
    total_ms: statOf(telemetry.totalSamples),
    samples: telemetry.totalSamples.length,
  };
}

/** 测试用重置（不暴露给产品路径；验证脚本用来隔离遥测） */
export function __resetRuntimeDiagnosticsForTest(): void {
  telemetry = newTelemetry();
}

/** worker 不可用/起不来（明确错误；不在主线程重算） */
export class ReadWorkersUnavailable extends Error {
  readonly code = "READ_WORKERS_UNAVAILABLE";
}
/** 有界队列已满（明确拒绝） */
export class ReadQueueFull extends Error {
  readonly code = "READ_QUEUE_FULL";
}
/** 作业超时（已取消该 worker，不占住队列） */
export class ReadJobTimeout extends Error {
  readonly code = "READ_JOB_TIMEOUT";
}
/** 作业被调用方显式取消（AbortSignal）：队列中的直接出队，在途的按有界取消收口 */
export class ReadJobAborted extends Error {
  readonly code = "READ_JOB_ABORTED";
}
/**
 * worker 侧作业失败（**结构化** code/detail 原样带回）：worker 里抛的 `WorkError` 带 code/detail，
 * 这里保留，调用方据此映射 HTTP 状态与错误体——不把结构化失败压成一句无码的 Error。
 */
export class ReadJobFailed extends Error {
  readonly code: string;
  readonly detail: Record<string, unknown>;
  constructor(code: string, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

interface PoolOptions {
  poolSize: number;
  queueLimit: number;
  /** 单个分组（项目 × 类别）的排队上限：一个项目不能把整条队列占满（契约 U4 多项目公平） */
  groupLimit: number;
  timeoutMs: number;
  /** 明确要求本地执行（测试/oracle）：不建 worker */
  forceLocal: boolean;
}

/**
 * 结构化只读作业错误 → HTTP 口径（复审 M1 / 根因）：结构化 `ReadJobFailed` 的 **code/detail 原样带出**，
 * 不被压成通用 `READ_JOB_FAILED`；`LEDGER_UNSTABLE`/`SOURCE_CHANGED` 是可重试的瞬时态（503）。
 */
export interface ReadJobErrorDescriptor {
  code: string;
  message: string;
  detail: Record<string, unknown>;
  httpStatus: number;
}

const READ_JOB_HTTP_STATUS: Record<string, number> = {
  READ_WORKERS_UNAVAILABLE: 503,
  READ_QUEUE_FULL: 503,
  READ_JOB_TIMEOUT: 503,
  READ_JOB_ABORTED: 503,
  HEALTH_UNSTABLE: 503,
  LEDGER_UNSTABLE: 503,
  SOURCE_CHANGED: 503,
  SERVICE_UNAVAILABLE: 503,
  PROJECT_NOT_FOUND: 404,
  INVALID_COMMAND: 400,
  EVIDENCE_INVALID: 400,
  VERSION_CONFLICT: 409,
  IDEMPOTENCY_CONFLICT: 409,
  PROJECTION_FAILED: 500,
  MIDDLE_CORRUPT: 500,
  TAIL_QUARANTINED: 500,
  EVENT_INVALID: 500,
};

/** 从一个只读作业/池错误里取出 `{code,message,detail,httpStatus}`（不丢结构化 code/detail）。 */
export function describeReadJobError(e: unknown): ReadJobErrorDescriptor {
  const err = e as { code?: unknown; detail?: unknown; message?: unknown } | null;
  const code = typeof err?.code === "string" && err.code !== "" ? err.code : "READ_JOB_FAILED";
  const message = e instanceof Error ? e.message : typeof err?.message === "string" ? err.message : String(e);
  const detail = typeof err?.detail === "object" && err.detail !== null ? (err.detail as Record<string, unknown>) : {};
  return { code, message, detail, httpStatus: READ_JOB_HTTP_STATUS[code] ?? 500 };
}

/** prep（锁外准备）连续优先的上限：超过就强制让一轮给读/别项目（有界优先，不饿死其它） */
const PREP_MAX_STREAK = 2;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (typeof raw !== "string" || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function resolveOptions(): PoolOptions {
  const cpus = typeof os.cpus === "function" ? os.cpus().length : 1;
  const poolSize = envInt("TATAI_READ_WORKER_POOL", Math.max(1, Math.min(2, cpus - 1)));
  const queueLimit = envInt("TATAI_READ_WORKER_QUEUE", 64);
  // 分组上限缺省＝全局队列的一半（至少 1）：单一项目/类别不能把整条队列占满，别的项目仍有位置。
  const groupLimit = envInt("TATAI_READ_WORKER_GROUP_QUEUE", Math.max(1, Math.floor(queueLimit / 2)));
  const timeoutMs = envInt("TATAI_READ_WORKER_TIMEOUT_MS", 120_000);
  const forceLocal = (process.env.TATAI_READ_WORKERS ?? "").trim().toLowerCase() === "local";
  return { poolSize, queueLimit, groupLimit, timeoutMs, forceLocal };
}

/**
 * 定位 worker 入口文件：env 覆盖 > 打包产物 `read-worker.js`（与 index.js 同目录及上两级）> 开发态
 * `readWorker.ts`（由 tsx 起）。与 `service.ts#resolveWriteServiceEntry` 同款多候选解析。
 */
export function resolveReadWorkerEntry(): { file: string; execArgv: string[] } | null {
  const override = process.env.TATAI_READ_WORKER_ENTRY;
  if (typeof override === "string" && override !== "" && fs.existsSync(override)) {
    return { file: override, execArgv: process.execArgv.slice() };
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const bundled = [here, path.join(here, ".."), path.join(here, "..", "..")]
    .map((dir) => path.join(dir, "read-worker.js"))
    .find((f) => fs.existsSync(f));
  if (bundled !== undefined) return { file: bundled, execArgv: [] };
  const dev = [path.join(here, "readWorker.ts"), path.join(here, "..", "work", "readWorker.ts")]
    .map((f) => path.normalize(f))
    .find((f) => fs.existsSync(f));
  if (dev !== undefined) return { file: dev, execArgv: ["--import", "tsx"] };
  return null;
}

interface Queued {
  id: number;
  kind: ReadJobKind;
  args: unknown;
  signal: AbortSignal | null;
  /** 公平调度分组（项目 × 类别）：轮转按它分段，避免一个项目/类别饿死别的（契约 U4） */
  group: string;
  /** 写路径必要核验（锁外准备）：有界优先，但不能饿死读/别项目 */
  prep: boolean;
  /** 取消订阅解绑（作业结算时调用） */
  cleanup: (() => void) | null;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

/** 从作业参数取「项目」维度（各作业 args 带 projectId / project_id；prep 的 id 在 cmd 里）；取不到归同一分组。 */
function projectKeyOf(args: unknown): string {
  const a = args as { projectId?: unknown; project_id?: unknown; cmd?: { project_id?: unknown } } | null;
  if (a !== null && typeof a === "object") {
    if (typeof a.projectId === "string" && a.projectId !== "") return a.projectId;
    if (typeof a.project_id === "string" && a.project_id !== "") return a.project_id;
    const cmd = a.cmd;
    if (cmd !== null && typeof cmd === "object" && typeof cmd.project_id === "string" && cmd.project_id !== "") return cmd.project_id;
  }
  return "";
}

/** 调度分组：项目 + 类别（prep / read 分开），供项目轮转使用。 */
function groupOf(kind: ReadJobKind, args: unknown): { group: string; prep: boolean } {
  const prep = kind === "sync_prep";
  const proj = projectKeyOf(args);
  return { group: `${proj}#${prep ? "prep" : "read"}`, prep };
}

interface Slot {
  worker: Worker;
  busy: number | null;
}

export interface ReadWorkerPoolStatus {
  mode: "worker" | "local" | "unavailable";
  running: number;
  busy: number;
  queued: number;
  pool_size: number;
  queue_limit: number;
  /** 单分组排队上限（项目轮转 + 单项目不能占满队列） */
  group_queue_limit: number;
  /** 当前排队的**不同分组**数（多项目公平的可观测口径） */
  groups_queued: number;
  started: number;
  completed: number;
  failed: number;
  timed_out: number;
  rejected_full: number;
  /** 因**单分组**超限而被拒的次数（与全局满区分） */
  rejected_group_full: number;
  last_error: string | null;
}

class ReadWorkerPool {
  private opts: PoolOptions;
  private slots: Slot[] = [];
  private queue: Queued[] = [];
  private pending = new Map<number, { queued: Queued; timer: NodeJS.Timeout | null; slot: Slot }>();
  private nextId = 1;
  private stopped = false;
  private startError: string | null = null;
  private completed = 0;
  private failed = 0;
  private timedOut = 0;
  private rejectedFull = 0;
  private rejectedGroupFull = 0;
  private startedTotal = 0;
  /**
   * **普通轮次**轮转游标：上一次派出的**非 prep**分组（下一次从它的下一个分组起找）。
   * 关键：prep 的优先插队**不写**这个游标——否则 prep 会把项目轮转位置反复重置回自己，
   * 让轮转永远落在同一个非 prep 分组上（C 长期饿死的根因）。
   */
  private normalGroup: string | null = null;
  /** **prep** 轮转游标：上一次派出的 prep 分组——prep 之间也按项目公平，不让 A 的 prep 把别项目 prep 饿死 */
  private prepGroup: string | null = null;
  /** 连续派出的 prep 作业数（有界优先：超过上限强制让出一轮给读/别项目） */
  private prepStreak = 0;

  /** `resolver` 每次（含测试重置）重新求值：池大小/上限可被 env 与测试调整。 */
  constructor(private readonly resolve: () => PoolOptions) {
    this.opts = resolve();
  }

  status(): ReadWorkerPoolStatus {
    const busy = this.slots.filter((s) => s.busy !== null).length;
    const groups = new Set(this.queue.map((q) => q.group));
    return {
      mode: this.opts.forceLocal ? "local" : this.startError !== null ? "unavailable" : "worker",
      running: this.slots.length,
      busy,
      queued: this.queue.length,
      pool_size: this.opts.poolSize,
      queue_limit: this.opts.queueLimit,
      group_queue_limit: this.opts.groupLimit,
      groups_queued: groups.size,
      started: this.startedTotal,
      completed: this.completed,
      failed: this.failed,
      timed_out: this.timedOut,
      rejected_full: this.rejectedFull,
      rejected_group_full: this.rejectedGroupFull,
      last_error: this.startError,
    };
  }

  private entry(): { file: string; execArgv: string[] } | null {
    const e = resolveReadWorkerEntry();
    if (e === null) {
      this.startError = "找不到 worker 入口（read-worker.js / readWorker.ts 均不在），且未设 TATAI_READ_WORKER_ENTRY";
    }
    return e;
  }

  private spawnSlot(): Slot | null {
    if (this.stopped) return null;
    const entry = this.entry();
    if (entry === null) return null;
    let worker: Worker;
    try {
      worker = new Worker(entry.file, { execArgv: entry.execArgv });
    } catch (e) {
      this.startError = `worker 启动失败：${e instanceof Error ? e.message : String(e)}`;
      return null;
    }
    const slot: Slot = { worker, busy: null };
    worker.on("message", (msg: unknown) => this.onMessage(slot, msg));
    worker.on("error", (err: unknown) => {
      this.startError = `worker 错误：${err instanceof Error ? err.message : String(err)}`;
      this.onSlotDead(slot, new Error(this.startError));
    });
    worker.on("exit", (code: number) => {
      // stop 时我们先把 slots 清空再 terminate，这里的退出无需再处理。
      if (this.stopped) return;
      // **空闲** worker 退出也必须摘槽：否则后续任务会被派到这个死 worker 上、白等一个超时。
      // 在途作业则如实失败（`onSlotDead` 按 slot.busy 结算，绝不牵连别的槽位）。
      this.onSlotDead(slot, slot.busy !== null ? new Error(`worker 异常退出（code=${code}），在途只读作业未完成`) : null);
    });
    // 空闲时 unref（池活着不保活进程）；作业活跃期间由 dispatch 显式 ref（见该处注释）。
    // 退出由宿主的 stopReadWorkers() 显式收口（只收回自己起的线程）——unref 不影响显式 terminate。
    this.slots.push(slot);
    worker.unref();
    this.startedTotal += 1;
    this.startError = null;
    return slot;
  }

  private onMessage(slot: Slot, msg: unknown): void {
    const m = msg as { id?: number; ok?: boolean; result?: unknown; error?: { message?: string } } | null;
    if (m === null || typeof m.id !== "number") return;
    const job = this.pending.get(m.id);
    if (job === undefined) return;
    if (job.timer !== null) clearTimeout(job.timer);
    this.pending.delete(m.id);
    slot.busy = null;
    // 空闲槽位改回 unref：池活着不等于进程要被它保活（否则验证脚本 PASS 后不退出、被 timeout 强杀）。
    // 作业活跃期间由 dispatch 显式 ref，保证"直接 await 一个异步作业必须跑完才允许进程退出"。
    slot.worker.unref();
    if (job.queued.cleanup !== null) job.queued.cleanup();
    if (m.ok === true) {
      this.completed += 1;
      noteSucceeded(m.id);
      job.queued.resolve(m.result);
    } else {
      this.failed += 1;
      const err = m.error as { message?: string; code?: string; detail?: Record<string, unknown> } | undefined;
      noteAnomalyOutcome(m.id, "failed", err?.code ?? "READ_JOB_FAILED");
      job.queued.reject(
        new ReadJobFailed(err?.code ?? "READ_JOB_FAILED", err?.message ?? "worker 只读作业失败", err?.detail ?? {}),
      );
    }
    this.pump();
  }

  /**
   * worker 起/挂了/退出了：**总是**摘掉该槽位（空闲退出也摘，避免派到死 worker 等超时），
   * 只结算**属于这个槽位**的在途作业（`slot.busy`）——一个槽位的 error/exit 不会牵连别的槽位；
   * 重复触发（error 后紧跟 exit）时槽位已被摘、busy 已清，二次调用是安全的空操作。
   */
  private onSlotDead(slot: Slot, err: Error | null): void {
    const idx = this.slots.indexOf(slot);
    if (idx >= 0) this.slots.splice(idx, 1);
    if (slot.busy !== null) {
      const id = slot.busy;
      const job = this.pending.get(id);
      this.pending.delete(id);
      slot.busy = null;
      if (job !== undefined) {
        if (job.timer !== null) clearTimeout(job.timer);
        if (job.queued.cleanup !== null) job.queued.cleanup();
        this.failed += 1;
        // V09-69 遥测：按真实收口原因记异常（超时/取消/worker 故障），不把三者混成一类。
        // R69-05：reason 只出受控模板——`err.message`（可能含路径/正文）不内联进报告。
        if (err instanceof ReadJobTimeout) noteAnomalyOutcome(id, "timed_out", "READ_JOB_TIMEOUT");
        else if (err instanceof ReadJobAborted) noteAnomalyOutcome(id, "aborted", "READ_JOB_ABORTED");
        else noteAnomalyOutcome(id, "failed", "READ_JOB_FAILED");
        job.queued.reject(err ?? new Error("worker 已退出，在途只读作业未完成"));
      }
    }
    try {
      void slot.worker.terminate();
    } catch {
      /* 已死 */
    }
    if (!this.stopped) this.pump();
  }

  private hasCapacity(): boolean {
    return this.slots.length < this.opts.poolSize;
  }

  /**
   * 按轮转取出某个类别（prep=优先准备 / 非 prep=读）的**下一个**作业：
   * 从该类别的游标分组的下一个分组起找，组内 FIFO。游标缺失/已空则从头开始。
   * 只在本类别内部轮转——prep 与普通各自一条游标，互不重置。
   */
  private takeByRotation(prep: boolean): Queued {
    const groups: string[] = [];
    for (const q of this.queue) if (q.prep === prep && !groups.includes(q.group)) groups.push(q.group);
    const cursor = prep ? this.prepGroup : this.normalGroup;
    let start = 0;
    if (cursor !== null) {
      const at = groups.indexOf(cursor);
      if (at >= 0) start = at + 1;
    }
    for (let step = 0; step < groups.length; step++) {
      const g = groups[(start + step) % groups.length]!;
      const idx = this.queue.findIndex((q) => q.group === g);
      if (idx >= 0) return this.queue.splice(idx, 1)[0]!;
    }
    // 调用方保证本类别有排队作业；保底取队首（不返回 undefined，避免空转）
    return this.queue.shift()!;
  }

  /**
   * 选出下一个该派发的作业（**普通轮转 + prep 有界优先 + prep 项目公平**）：
   *   ① prep（锁外准备＝写路径必要核验）优先，但**连续**派出不超过 `PREP_MAX_STREAK` 个；
   *   ② 让出的那一轮**确实**选非 prep（有普通工作待办时），并只推进**普通**游标；
   *   ③ prep 的选择只推进 **prep** 游标——不会重置普通轮转位置，A 的大量 prep 也轮不到
   *      让别项目的 prep 一直等；两类各自按项目轮转，谁都不饿死。
   */
  private pickNext(): Queued | undefined {
    if (this.queue.length === 0) return undefined;
    const hasPrep = this.queue.some((q) => q.prep);
    const hasNormal = this.queue.some((q) => !q.prep);
    // ① 有界优先：prep 未达连续上限时优先取 prep（只推 prep 游标，不碰普通游标）
    if (hasPrep && this.prepStreak < PREP_MAX_STREAK) {
      const job = this.takeByRotation(true);
      this.prepGroup = job.group;
      this.prepStreak += 1;
      return job;
    }
    // ② 普通轮次：有普通工作待办就**必须**选非 prep，并只推进普通游标
    if (hasNormal) {
      const job = this.takeByRotation(false);
      this.normalGroup = job.group;
      this.prepStreak = 0;
      return job;
    }
    // ③ 只剩 prep（单一类别也不空转）：按 prep 游标继续取，继续计入连续数
    const job = this.takeByRotation(true);
    this.prepGroup = job.group;
    this.prepStreak += 1;
    return job;
  }

  private pump(): void {
    if (this.stopped) return;
    while (this.queue.length > 0) {
      let slot = this.slots.find((s) => s.busy === null) ?? null;
      if (slot === null) {
        if (!this.hasCapacity()) return;
        slot = this.spawnSlot();
        if (slot === null) {
          // worker 起不来：把队列里的作业**明确失败**（不静默本地重算），并解除各自的 signal 监听（不泄漏）。
          const err = new ReadWorkersUnavailable(this.startError ?? "只读 worker 不可用");
          let rejectedCount = 0;
          // R69-07：如实带上被拒作业所属项目（只有一个 distinct 项目时归它，否则记全局）——项目过滤时能看到自身失败。
          const scopeProjects = new Set<string>();
          for (const q of this.queue) {
            this.failed += 1;
            rejectedCount += 1;
            const key = projectKeyOf(q.args);
            if (key !== "") scopeProjects.add(key);
            if (q.cleanup !== null) q.cleanup();
            q.reject(err);
          }
          if (rejectedCount > 0) noteWorkersUnavailable(rejectedCount, scopeProjects.size === 1 ? [...scopeProjects][0]! : null);
          this.queue = [];
          return;
        }
      }
      const job = this.pickNext();
      if (job === undefined) return;
      this.dispatch(slot, job);
    }
  }

  private dispatch(slot: Slot, job: Queued): void {
    slot.busy = job.id;
    // 作业活跃期间 ref：保证"直接 await 一个异步只读作业必须跑完才允许进程退出"，
    // 又不因空闲线程保活（空闲在 onMessage/onSlotDead 里 unref 回去）。
    slot.worker.ref();
    const timer = setTimeout(() => {
      this.timedOut += 1;
      // 取消：只 terminate 自己起的这个 worker（不碰外部），并重起槽位。
      this.onSlotDead(slot, new ReadJobTimeout(`只读作业超过 ${this.opts.timeoutMs}ms 未返回（已取消该 worker）`));
    }, this.opts.timeoutMs);
    timer.unref();
    this.pending.set(job.id, { queued: job, timer, slot });
    noteStarted(job.id);
    try {
      slot.worker.postMessage({ id: job.id, kind: job.kind, args: job.args });
    } catch (e) {
      clearTimeout(timer);
      this.pending.delete(job.id);
      slot.busy = null;
      slot.worker.unref();
      if (job.cleanup !== null) job.cleanup();
      this.failed += 1;
      noteAnomalyOutcome(job.id, "failed", "READ_JOB_FAILED");
      job.reject(e);
    }
  }

  /**
   * 提交一个只读作业。`opts.signal` 取消时：仍排队的直接出队拒绝（`ReadJobAborted`）；
   * 已在途的按**有界**取消收口（只 terminate 自己起的那个 worker，不碰外部进程/其它槽位）。
   */
  run(kind: ReadJobKind, args: unknown, opts: { local?: boolean; signal?: AbortSignal } = {}): Promise<unknown> {
    if (this.stopped) return Promise.reject(new ReadWorkersUnavailable("只读 worker 池已停止"));
    if (this.opts.forceLocal) return Promise.resolve().then(() => runReadJobLocal(kind, args));
    if (opts.signal?.aborted === true) return Promise.reject(new ReadJobAborted("只读作业在提交前已被取消"));
    const telemetryProject = projectKeyOf(args) || null;
    // 满则显式拒绝（有界；不无限排队）
    if (this.queue.length >= this.opts.queueLimit) {
      this.rejectedFull += 1;
      noteRejected(kind, telemetryProject, "rejected_full");
      return Promise.reject(new ReadQueueFull(`只读作业队列已满（上限 ${this.opts.queueLimit}）——稍后重试`));
    }
    // 单分组上限：一个项目/类别不能把整条队列占满（别的项目仍有位置）——有限资源下的多项目公平。
    const { group, prep } = groupOf(kind, args);
    if (this.queue.filter((q) => q.group === group).length >= this.opts.groupLimit) {
      this.rejectedGroupFull += 1;
      noteRejected(kind, telemetryProject, "rejected_group_full");
      return Promise.reject(
        new ReadQueueFull(`分组 ${group} 的排队已达上限 ${this.opts.groupLimit}（单项目不占满队列）——稍后重试`),
      );
    }
    return new Promise<unknown>((resolve, reject) => {
      const job: Queued = { id: this.nextId++, kind, args, signal: opts.signal ?? null, group, prep, cleanup: null, resolve, reject };
      if (opts.signal !== undefined) {
        const onAbort = (): void => {
          // 已在途：取消该 worker（terminate 后由 onSlotDead 结算成 ReadJobAborted）。
          const inFlight = this.pending.get(job.id);
          if (inFlight !== undefined) {
            this.onSlotDead(inFlight.slot, new ReadJobAborted("只读作业被调用方取消"));
            return;
          }
          // 仍在队列：直接出队拒绝。
          const idx = this.queue.indexOf(job);
          if (idx >= 0) {
            this.queue.splice(idx, 1);
            noteAnomalyOutcome(job.id, "aborted", "READ_JOB_ABORTED");
            reject(new ReadJobAborted("只读作业被调用方取消"));
          }
        };
        opts.signal.addEventListener("abort", onAbort, { once: true });
        job.cleanup = () => opts.signal?.removeEventListener("abort", onAbort);
      }
      noteQueued(job.id, kind, telemetryProject);
      this.queue.push(job);
      this.pump();
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const err = new ReadWorkersUnavailable("只读 worker 池正在停止");
    // 排队作业：拒绝并**解除各自的 signal 监听**（否则调用方的 AbortController 会一直挂着池的监听器）
    for (const q of this.queue) {
      if (q.cleanup !== null) q.cleanup();
      q.reject(err);
    }
    this.queue = [];
    for (const [id, job] of this.pending) {
      if (job.timer !== null) clearTimeout(job.timer);
      if (job.queued.cleanup !== null) job.queued.cleanup();
      job.queued.reject(err);
      this.pending.delete(id);
    }
    const workers = this.slots.map((s) => s.worker);
    this.slots = [];
    await Promise.all(
      workers.map(
        (w) =>
          new Promise<void>((resolve) => {
            try {
              void w.terminate().finally(() => resolve());
            } catch {
              resolve();
            }
          }),
      ),
    );
  }

  /** 测试用：清空计数与停止标记（不重启 worker） */
  resetForTest(): void {
    this.opts = this.resolve();
    this.slots = [];
    this.queue = [];
    this.pending.clear();
    this.nextId = 1;
    this.stopped = false;
    this.startError = null;
    this.completed = 0;
    this.failed = 0;
    this.timedOut = 0;
    this.rejectedFull = 0;
    this.rejectedGroupFull = 0;
    this.startedTotal = 0;
    this.normalGroup = null;
    this.prepGroup = null;
    this.prepStreak = 0;
  }
}

const readPool = new ReadWorkerPool(resolveOptions);
/**
 * **独立扫描池**（V09-31/37 目标二）：后台 sync scanner 的只读计划在**自己的**槽位里跑，不与
 * 入口/同步判据/锁外准备抢同一个池——长扫描不会把健康读/接续入口的只读作业饿住（契约 U4）。
 * 池大小另设 `TATAI_SCAN_WORKER_POOL`（缺省 1）；队列上限/超时沿用同一套有界口径。
 * scanner **只产计划**；提交（写）仍在唯一主宿主（`commitSyncScan`），所以计划槽不等待 prep 槽，天然无死锁。
 */
function resolveScanOptions(): PoolOptions {
  return { ...resolveOptions(), poolSize: envInt("TATAI_SCAN_WORKER_POOL", 1) };
}
const scanPool = new ReadWorkerPool(resolveScanOptions);

/** 执行一个只读作业：worker 优先（有界）；`TATAI_READ_WORKERS=local` 或 `local:true` 才显式本地执行。 */
export function runReadJob(
  kind: ReadJobKind,
  args: unknown,
  opts: { local?: boolean; signal?: AbortSignal } = {},
): Promise<unknown> {
  if (opts.local === true) return Promise.resolve().then(() => runReadJobLocal(kind, args));
  return readPool.run(kind, args, opts.signal === undefined ? {} : { signal: opts.signal });
}

/** 执行一个**扫描计划**作业（独立扫描池；写仍在唯一主宿主）。 */
export function runScanJob(
  kind: ReadJobKind,
  args: unknown,
  opts: { local?: boolean; signal?: AbortSignal } = {},
): Promise<unknown> {
  if (opts.local === true) return Promise.resolve().then(() => runReadJobLocal(kind, args));
  return scanPool.run(kind, args, opts.signal === undefined ? {} : { signal: opts.signal });
}

/** 池状态（健康读口如实给：worker/local/unavailable + 计数；读池 + 独立扫描池各一份） */
export interface WorkHostWorkerStatus extends ReadWorkerPoolStatus {
  /** 独立扫描池（后台 sync scanner 的只读计划） */
  scan: ReadWorkerPoolStatus;
}

export function readWorkerPoolStatus(): WorkHostWorkerStatus {
  return { ...readPool.status(), scan: scanPool.status() };
}

/** 停机：只收回本池拥有的 worker 线程（读池 + 扫描池；不碰外部 Agent） */
export function stopReadWorkers(): Promise<void> {
  return Promise.all([readPool.stop(), scanPool.stop()]).then(() => undefined);
}

/** 测试用重置（先 stop 再 reset 由调用方保证） */
export function __resetReadWorkerPoolForTest(): void {
  readPool.resetForTest();
  scanPool.resetForTest();
}
