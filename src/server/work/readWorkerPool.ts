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
      job.queued.resolve(m.result);
    } else {
      this.failed += 1;
      const err = m.error as { message?: string; code?: string; detail?: Record<string, unknown> } | undefined;
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
      const job = this.pending.get(slot.busy);
      this.pending.delete(slot.busy);
      slot.busy = null;
      if (job !== undefined) {
        if (job.timer !== null) clearTimeout(job.timer);
        if (job.queued.cleanup !== null) job.queued.cleanup();
        this.failed += 1;
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
          for (const q of this.queue) {
            this.failed += 1;
            if (q.cleanup !== null) q.cleanup();
            q.reject(err);
          }
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
    try {
      slot.worker.postMessage({ id: job.id, kind: job.kind, args: job.args });
    } catch (e) {
      clearTimeout(timer);
      this.pending.delete(job.id);
      slot.busy = null;
      slot.worker.unref();
      if (job.cleanup !== null) job.cleanup();
      this.failed += 1;
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
    // 满则显式拒绝（有界；不无限排队）
    if (this.queue.length >= this.opts.queueLimit) {
      this.rejectedFull += 1;
      return Promise.reject(new ReadQueueFull(`只读作业队列已满（上限 ${this.opts.queueLimit}）——稍后重试`));
    }
    // 单分组上限：一个项目/类别不能把整条队列占满（别的项目仍有位置）——有限资源下的多项目公平。
    const { group, prep } = groupOf(kind, args);
    if (this.queue.filter((q) => q.group === group).length >= this.opts.groupLimit) {
      this.rejectedGroupFull += 1;
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
            reject(new ReadJobAborted("只读作业被调用方取消"));
          }
        };
        opts.signal.addEventListener("abort", onAbort, { once: true });
        job.cleanup = () => opts.signal?.removeEventListener("abort", onAbort);
      }
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
