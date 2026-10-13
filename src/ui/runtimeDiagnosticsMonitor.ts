// V09-70（DESIGN §3.18「轻量监看 / 有界只读重连」、§6.15 读口；PLAN V09-70）。
//
// 单一监看实例：**任一主视图可见时每 5 秒**轻量读一次 `GET /api/runtime/diagnostics`（只读有界运行
// 读数，不重推导），**全部主视图隐藏即暂停**、任一瞬间**至多一笔在途**；失败走**有界只读重连**
// （400ms 起 ×2 封顶 6s、**最多 6 次即停**，成功**即停本轮重试并回到 5 秒监看**，非稳态零请求）。
// 焦点 / `online` / 手动「重试」可再触发一轮并重算预算；切项目**中止在途、丢弃旧回包**，不显示他项目读数。
//
// 失败语义（F01 返工，2026-10-13）：任何一次读失败（不可达/超时/业务错误/退避用尽停止）都把**当前**状态
// 落 `unknown`——不沿用上次 `healthy` 的绿点与"运行正常"标签（也不断言宿主已死）；历史报告保留不动、由
// 界面标为"旧读数"，只有随后一次**真正新鲜的成功**（`onSuccess`）才恢复状态。
// 客户端观测（F02 返工）：失败/慢读按 60 秒窗口**随时间自然过期**（有界到期定时器，无新事件也会清零）；
// 定时器在隐藏/停止/卸载时清理，不产生自激网络请求或订阅。
// 重挂载（F05 返工）：全部消费者卸载即清空"当前项目"——重挂载时不再用旧 `project_id` 先发一笔读。
//
// 为什么是一个**不依赖 React、依赖注入**的普通类：
//   · 界面两处（全局轻量异常提示 / 专用诊断页）必须**共用同一份监看状态**——单一实例是"一个在途"
//     与"5 秒一次"能成立的前提；用一个模块级单例（由 `useRuntimeDiagnostics.ts` 装配）承载，两处只订阅。
//   · 监看行为（周期 / 退避 / 去重 / 暂停 / 切项目作废 / 恢复核验）是**纯状态机**，与 React 渲染无关；
//     把它抽到无 DOM 依赖的类里，就能在 Node 里**隔离真跑**这些行为（`scripts/verify-v09-70.ts`），
//     再用真浏览器（`scripts/verify-v09-70-ui.py`，mock 后端读口）验渲染与接线。
//   · 时间 / 定时器 / 可见性 / 恢复信号经 `MonitorEnv` 注入：Node 测用假时钟推进，浏览器用真时钟。
//
// 红线：只重试**只读**读；**不自动重启后端、不拉起写服务、不改代码/账本、不放松门禁**。诊断读口
// 自身的失败**不进入**客户端观测（避免自我递归）。

import type { SharedReadEvent } from "./sharedRead";
// 统一运行健康状态词表的**唯一出处**是共享契约（`src/shared/runtimeDiagnostics.ts#RuntimeHealthState`）
// ——前端只读引用、不另造一份。
import type { RuntimeHealthState } from "../shared/runtimeDiagnostics";

/** 从一份报告里抽取**恢复核验**与**显示**需要的最小信息（具体字段口径由共享契约决定）。 */
export interface RuntimeDiagnosticsDigest {
  /** 报告给出的统一状态（单一判据） */
  status: RuntimeHealthState;
  /** 本次报告生成时间（`generated_at`）——用于"恢复后比对是不是新报告" */
  generated_at: string;
  /** 宿主/部件身份串（如 `pid:release_id`）——用于"恢复后确认是同一个（或换了包的）宿主" */
  host_id: string;
}

/** 读失败的分类：决定"要不要退避重试"。 */
export type RuntimeReadErrorClass = "unreachable" | "unsupported" | "business";

/** 环境注入：把时间/定时器/可见性/恢复信号从运行时剥离出来，使状态机可在 Node 里真跑。 */
export interface MonitorEnv {
  now(): number;
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(handle: number): void;
  isDocumentVisible(): boolean;
  /** 注册一个恢复信号（visibilitychange / online / focus），返回注销函数。 */
  onSignal(signal: "visibilitychange" | "online" | "focus", handler: () => void): () => void;
}

/** 监看阶段（表达"监看循环"的状态，健康与否由 `status` 表达，二者不混）。 */
export type MonitorPhase = "paused" | "grace" | "monitoring" | "retrying" | "stopped";

/** 客户端观测（DESIGN §3.18「前端自身网络失败只作客户端观测」）：**只统计**，不采集 URL/query/token/正文。 */
export interface ClientObservation {
  window_ms: number;
  reads: number;
  failures: number;
  slow: number;
  last_failure_at: number | null;
  last_failure_status: number | null;
}

/** 恢复核验说明（DESIGN §3.18「恢复后必须重读并比对」）。 */
export interface RecoveryNote {
  at: number;
  previous_generated_at: string | null;
  generated_at: string;
  host_changed: boolean;
  fresh_report: boolean;
  detail: string;
}

/** 对外可订阅的不可变快照（引用稳定：未变化时 `getSnapshot` 返回同一对象）。 */
export interface RuntimeDiagnosticsMonitorState<TReport> {
  phase: MonitorPhase;
  project_id: string | null;
  report: TReport | null;
  digest: RuntimeDiagnosticsDigest | null;
  status: RuntimeHealthState;
  /** 本次报告落地时刻（本地时钟） */
  report_at: number | null;
  error: string | null;
  error_class: RuntimeReadErrorClass | null;
  /** 宿主是否提供该读口（旧宿主 / 未登记路由 ⇒ false，页面明报"未接入"） */
  supported: boolean;
  unsupported_reason: string | null;
  attempts: number;
  next_retry_at: number | null;
  in_flight: boolean;
  /** 冷启动宽限是否已过（过了仍读不到 ⇒ 明确"持续未知"） */
  grace_expired: boolean;
  client_observation: ClientObservation;
  recovery: RecoveryNote | null;
}

export interface RuntimeDiagnosticsMonitorOptions<TReport> {
  fetchReport(ctx: { projectId: string | null; signal: AbortSignal }): Promise<TReport>;
  digest(report: TReport): RuntimeDiagnosticsDigest;
  classifyError(message: string): RuntimeReadErrorClass;
  env: MonitorEnv;
  /** 可见态监看周期（默认 5000，F2 口径） */
  intervalMs?: number;
  /** 失败退避基数（默认 400ms，每次 ×2） */
  retryBaseMs?: number;
  /** 退避封顶（默认 6s） */
  retryMaxMs?: number;
  /** 自动重试次数上限（默认 6，用尽即停） */
  retryMaxAttempts?: number;
  /** 冷启动宽限（默认 8s） */
  graceMs?: number;
  /** 单笔读的客户端超时（默认 12s；超时＝这次没读到，不判服务已死） */
  readTimeoutMs?: number;
  /** 客户端观测窗口（默认 60s） */
  clientWindowMs?: number;
  /** "慢读"阈值（默认 4s） */
  slowReadMs?: number;
}

interface ResolvedOptions<TReport> extends Required<Omit<RuntimeDiagnosticsMonitorOptions<TReport>, "env" | "fetchReport" | "digest" | "classifyError">> {
  fetchReport(ctx: { projectId: string | null; signal: AbortSignal }): Promise<TReport>;
  digest(report: TReport): RuntimeDiagnosticsDigest;
  classifyError(message: string): RuntimeReadErrorClass;
  env: MonitorEnv;
}

function emptyObservation(windowMs: number): ClientObservation {
  return { window_ms: windowMs, reads: 0, failures: 0, slow: 0, last_failure_at: null, last_failure_status: null };
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** 浏览器默认环境（Node 里没有这些全局；测试注入自己的环境）。 */
export function browserMonitorEnv(): MonitorEnv {
  return {
    now: () => Date.now(),
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (handle) => window.clearTimeout(handle),
    isDocumentVisible: () => (typeof document === "undefined" ? true : document.visibilityState === "visible"),
    onSignal: (signal, handler) => {
      const target: EventTarget = signal === "visibilitychange" ? document : window;
      target.addEventListener(signal, handler as EventListener);
      return () => target.removeEventListener(signal, handler as EventListener);
    },
  };
}

/**
 * 单一监看状态机。`getSnapshot()` 引用稳定；`subscribe()` 是外部存储（配 React
 * `useSyncExternalStore`）。行为见文件头注释。
 */
export class RuntimeDiagnosticsMonitor<TReport> {
  private readonly options: ResolvedOptions<TReport>;
  private state: RuntimeDiagnosticsMonitorState<TReport>;
  private listeners = new Set<() => void>();
  private timer: number | null = null;
  private graceTimer: number | null = null;
  /** F02：客户端观测窗口的"到期重算"定时器（有界：至多一个；隐藏/停止/卸载即清）。 */
  private obsTimer: number | null = null;
  private controller: AbortController | null = null;
  private timedOutController: AbortController | null = null;
  private unsubscribers: Array<() => void> = [];
  private started = false;
  private running = false;
  private failedSinceSuccess = false;
  private recentReads: Array<{ at: number; failed: boolean; slow: boolean; status: number | null }> = [];

  constructor(options: RuntimeDiagnosticsMonitorOptions<TReport>) {
    this.options = {
      intervalMs: options.intervalMs ?? 5000,
      retryBaseMs: options.retryBaseMs ?? 400,
      retryMaxMs: options.retryMaxMs ?? 6000,
      retryMaxAttempts: options.retryMaxAttempts ?? 6,
      graceMs: options.graceMs ?? 8000,
      readTimeoutMs: options.readTimeoutMs ?? 12000,
      clientWindowMs: options.clientWindowMs ?? 60000,
      slowReadMs: options.slowReadMs ?? 4000,
      env: options.env,
      fetchReport: options.fetchReport,
      digest: options.digest,
      classifyError: options.classifyError,
    };
    this.state = {
      phase: "paused",
      project_id: null,
      report: null,
      digest: null,
      status: "unknown",
      report_at: null,
      error: null,
      error_class: null,
      supported: true,
      unsupported_reason: null,
      attempts: 0,
      next_retry_at: null,
      in_flight: false,
      grace_expired: false,
      client_observation: emptyObservation(this.options.clientWindowMs),
      recovery: null,
    };
  }

  /** 稳定引用快照（未变化时同一对象）——供 `useSyncExternalStore`。 */
  readonly getSnapshot = (): RuntimeDiagnosticsMonitorState<TReport> => this.state;

  /** 订阅状态变化；首个订阅者会启动监看，最后一个退订会停止（界面常驻一个 provider，通常不触发停止）。 */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    this.ensureStarted();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stop();
    };
  };

  /** 设置"当前主视图所属项目"；非 null 表示主视图可见。切项目中止在途并丢弃旧读数。 */
  setContext(projectId: string | null): void {
    if (this.state.project_id === projectId) return;
    // 切项目/换范围：中止在途、作废旧回包、清旧读数（不显示他项目读数，§6.12/§3.18）
    this.controller?.abort();
    this.controller = null;
    this.timedOutController = null;
    this.clearTimer();
    this.clearGraceTimer();
    this.clearObservationPrune();
    this.failedSinceSuccess = false;
    this.recentReads = [];
    this.patch({
      project_id: projectId,
      report: null,
      digest: null,
      status: "unknown",
      report_at: null,
      error: null,
      error_class: null,
      supported: true,
      unsupported_reason: null,
      attempts: 0,
      next_retry_at: null,
      in_flight: false,
      grace_expired: false,
      recovery: null,
      client_observation: emptyObservation(this.options.clientWindowMs),
    });
    // 换项目后强制重新评估"活跃态"：即使此前就在活跃，也要为新项目立即开读（不沿用旧代计时器）
    this.running = false;
    this.applyRunState();
  }

  /** 手动「重试」（也可作焦点/online 的再触发）：重算退避预算并立即再读一轮。 */
  retryNow(): void {
    if (!this.shouldRun()) return;
    this.patch({ attempts: 0, next_retry_at: null });
    if (this.controller !== null) return; // 已有在途：它回来后会自行续上，不叠加
    this.clearTimer();
    if (this.state.phase === "paused" || this.state.phase === "stopped") {
      this.patch({ phase: this.state.report === null ? "grace" : "monitoring", grace_expired: false });
    }
    this.kick(0);
  }

  /** 只读观测入口：把 `sharedRead` 的脱敏事件并入客户端观测（诊断请求自身**排除**，避免自我递归）。 */
  observeRead(event: SharedReadEvent): void {
    if (event.diagnostics) return;
    const now = this.options.env.now();
    const failed = !event.aborted && (!event.ok || (event.status !== null && event.status >= 500));
    const slow = !event.aborted && event.ok && event.duration_ms >= this.options.slowReadMs;
    this.recentReads.push({ at: now, failed, slow, status: event.status });
    this.pruneRecentReads(now);
    if (this.recentReads.length > 400) this.recentReads.splice(0, this.recentReads.length - 400);
    // 只在"值得让人看见"时刷新快照（失败/慢读）；普通成功读不产生无谓重渲染。
    if (failed || slow) {
      this.patch({ client_observation: this.buildObservation(now) });
      this.scheduleObservationPrune();
    }
  }

  /** F02：按当前时钟裁剪观测窗口（与 `buildObservation` 同一判据 `at >= now - window`）。 */
  private pruneRecentReads(now: number): void {
    const cutoff = now - this.options.clientWindowMs;
    if (this.recentReads.length > 0 && this.recentReads[0]!.at < cutoff) {
      this.recentReads = this.recentReads.filter((r) => r.at >= cutoff);
    }
  }

  /** F02：排一个"最早一条窗口内读数到期"的定时器——**没有新事件**也自然过期清零，且**至多一个**。 */
  private scheduleObservationPrune(): void {
    this.clearObservationPrune();
    if (!this.running) return; // 隐藏/停止时不排定时器（有界）；回活跃时 `refreshObservation` 重算
    const now = this.options.env.now();
    let earliest: number | null = null;
    for (const r of this.recentReads) {
      if (!r.failed && !r.slow) continue; // 只有失败/慢读进入观测读数；普通成功读不占用
      const expiresAt = r.at + this.options.clientWindowMs + 1; // +1 保证到点时判据已算"出窗"
      if (expiresAt <= now) continue;
      if (earliest === null || expiresAt < earliest) earliest = expiresAt;
    }
    if (earliest === null) return;
    this.obsTimer = this.options.env.setTimeout(() => {
      this.obsTimer = null;
      this.refreshObservation();
    }, earliest - now);
  }

  private clearObservationPrune(): void {
    if (this.obsTimer !== null) {
      this.options.env.clearTimeout(this.obsTimer);
      this.obsTimer = null;
    }
  }

  /** F02：按当前时钟重算观测并重排到期定时器；值未变时 `patch` 不通知（不产生无谓重渲染/自激）。 */
  private refreshObservation(): void {
    const now = this.options.env.now();
    this.pruneRecentReads(now);
    this.patch({ client_observation: this.buildObservation(now) });
    this.scheduleObservationPrune();
  }

  private buildObservation(now: number): ClientObservation {
    const cutoff = now - this.options.clientWindowMs;
    const within = this.recentReads.filter((r) => r.at >= cutoff);
    let failures = 0;
    let slow = 0;
    let lastFailureAt: number | null = null;
    let lastFailureStatus: number | null = null;
    for (const r of within) {
      if (r.failed) {
        failures += 1;
        lastFailureAt = r.at;
        lastFailureStatus = r.status;
      }
      if (r.slow) slow += 1;
    }
    return {
      window_ms: this.options.clientWindowMs,
      reads: within.length,
      failures,
      slow,
      last_failure_at: lastFailureAt,
      last_failure_status: lastFailureStatus,
    };
  }

  private ensureStarted(): void {
    if (this.started) return;
    this.started = true;
    this.unsubscribers = [
      this.options.env.onSignal("visibilitychange", () => this.applyRunState()),
      this.options.env.onSignal("online", () => this.retryNow()),
      this.options.env.onSignal("focus", () => this.retryNow()),
    ];
    this.applyRunState();
  }

  private stop(): void {
    if (this.started) {
      for (const unsub of this.unsubscribers) unsub();
      this.unsubscribers = [];
      this.started = false;
    }
    this.controller?.abort();
    this.controller = null;
    this.timedOutController = null;
    this.clearTimer();
    this.clearGraceTimer();
    this.clearObservationPrune();
    this.running = false;
    // F05：全部消费者卸载即**丢弃"当前项目"**——重挂载时不再沿用旧 `project_id` 先发一笔读，
    // 由随后挂载 effect 的 `setContext` 决定读哪个项目（不显示他项目读数，也不猜任何状态）。
    if (this.state.project_id !== null) this.patch({ project_id: null });
  }

  private shouldRun(): boolean {
    return this.started && this.state.project_id !== null && this.options.env.isDocumentVisible();
  }

  /** 可见性/上下文变化后的统一收敛：不活跃即暂停；从"不活跃→活跃"才立即开读（重算预算）。 */
  private applyRunState(): void {
    const run = this.shouldRun();
    if (!run) {
      if (this.running) {
        this.clearTimer();
        this.clearGraceTimer();
      }
      // F02：隐藏/停止即清观测到期定时器（有界），回活跃时按当前时钟重算，不靠"新事件"才过期。
      this.clearObservationPrune();
      this.running = false;
      if (this.state.supported && this.state.phase !== "stopped") this.patch({ phase: "paused" });
      return;
    }
    const activated = !this.running;
    this.running = true;
    if (!activated) return;
    // 恢复可见：重算预算、冷启动宽限、立即读一轮，并按是否已有读数落 phase
    this.patch({
      attempts: 0,
      next_retry_at: null,
      phase: this.state.supported ? (this.state.report === null ? "grace" : "monitoring") : "stopped",
      grace_expired: false,
    });
    this.armGrace();
    this.refreshObservation(); // F02：回活跃即按当前时钟重算观测（隐藏期间过期的读数自然清零）
    if (!this.state.supported) return;
    this.kick(0);
  }

  private armGrace(): void {
    this.clearGraceTimer();
    if (this.state.report !== null) return;
    this.graceTimer = this.options.env.setTimeout(() => {
      this.graceTimer = null;
      this.patch({ grace_expired: true });
    }, this.options.graceMs);
  }

  private clearGraceTimer(): void {
    if (this.graceTimer !== null) {
      this.options.env.clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      this.options.env.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private kick(delayMs: number): void {
    this.clearTimer();
    // 不可见/无主视图时不排下一轮，并把"监看中"如实改回"已暂停"——不假装仍在主动监看
    // （例如：一笔读在文档隐藏后才落地，它会走 onSuccess，但此刻不该再排 5 秒轮）。
    if (!this.shouldRun()) {
      if (this.state.supported && this.state.phase !== "stopped" && this.state.phase !== "paused") {
        this.patch({ phase: "paused" });
      }
      return;
    }
    this.timer = this.options.env.setTimeout(() => {
      this.timer = null;
      this.readNow();
    }, delayMs);
  }

  private readNow(): void {
    if (!this.shouldRun()) return;
    if (this.controller !== null) return; // 任一瞬间至多一笔在途
    const projectId = this.state.project_id;
    const controller = new AbortController();
    this.controller = controller;
    this.timedOutController = null;
    this.patch({ in_flight: true, next_retry_at: null });
    const timeoutHandle = this.options.env.setTimeout(() => {
      this.timedOutController = controller; // 记录"本次超时"（区别于切项目/卸载的 abort）
      controller.abort();
    }, this.options.readTimeoutMs);
    this.options
      .fetchReport({ projectId, signal: controller.signal })
      .then((report) => {
        this.options.env.clearTimeout(timeoutHandle);
        if (this.controller !== controller) return; // 已作废（切项目/停止）
        if (this.state.project_id !== projectId) return; // 切项目：旧回包作废
        this.onSuccess(report);
      })
      .catch((error: unknown) => {
        this.options.env.clearTimeout(timeoutHandle);
        if (this.controller !== controller) return; // 已作废（切项目/停止）
        const timedOut = this.timedOutController === controller;
        this.timedOutController = null;
        if (!timedOut && controller.signal.aborted) return; // 取消：不落地、不算失败
        this.onFailure(error, timedOut);
      })
      .finally(() => {
        // 只有"仍是当前在途"的这笔才清标记——被切项目/停止作废的旧回包不得把新一笔的 in_flight 抹掉
        if (this.controller === controller) {
          this.controller = null;
          this.patch({ in_flight: false });
        }
      });
  }

  private onSuccess(report: TReport): void {
    const digest = this.options.digest(report);
    const previous = this.state.digest;
    let recovery: RecoveryNote | null = null;
    if (this.failedSinceSuccess && previous !== null) {
      const fresh = previous.generated_at !== digest.generated_at;
      const hostChanged = previous.host_id !== digest.host_id;
      recovery = {
        at: this.options.env.now(),
        previous_generated_at: previous.generated_at,
        generated_at: digest.generated_at,
        host_changed: hostChanged,
        fresh_report: fresh,
        detail: fresh
          ? hostChanged
            ? "已恢复：读到新报告，且宿主身份已变（确认换了包/新宿主在应答）"
            : "已恢复：读到新报告，宿主身份不变（同一次运行的宿主）"
          : "又读到报告，但 generated_at 与故障前相同——不据此声称已恢复为当前读数",
      };
    }
    this.failedSinceSuccess = false;
    this.clearGraceTimer();
    this.patch({
      phase: "monitoring",
      report,
      digest,
      status: digest.status,
      report_at: this.options.env.now(),
      error: null,
      error_class: null,
      supported: true,
      unsupported_reason: null,
      attempts: 0,
      next_retry_at: null,
      grace_expired: false,
      recovery,
    });
    this.kick(this.options.intervalMs);
  }

  /**
   * 读失败（**所有失败分支一致**，F01）：当前状态一律落 `unknown`——诊断读不可达/超时/重试停止时，
   * **当前**是否正常是未知的：不得沿用上次 `healthy` 的绿点与"运行正常"标签，也不猜宿主死亡。
   * 历史报告 `report`/`digest` **保留不动**（界面据 `error!==null` 标为"旧读数"）；只有随后一次
   * **真正新鲜的成功**（`onSuccess`）才恢复状态。
   */
  private onFailure(error: unknown, timedOut: boolean): void {
    const message = timedOut ? "读取超时（本次读未在预算内返回）" : messageOf(error);
    const errorClass: RuntimeReadErrorClass = timedOut ? "unreachable" : this.options.classifyError(message);
    this.failedSinceSuccess = true;
    const now = this.options.env.now();
    if (errorClass === "unsupported") {
      this.clearTimer();
      this.clearGraceTimer();
      this.patch({
        phase: "stopped",
        supported: false,
        unsupported_reason: message,
        error: message,
        error_class: errorClass,
        status: "unknown",
        next_retry_at: null,
        grace_expired: true,
      });
      return;
    }
    if (errorClass === "business") {
      // 业务错误不重试：如实报出，仍按 5 秒常规监看继续（不是失败退避）
      this.clearGraceTimer();
      this.patch({
        phase: "monitoring",
        error: message,
        error_class: errorClass,
        status: "unknown",
        grace_expired: this.state.report === null ? true : this.state.grace_expired,
      });
      this.kick(this.options.intervalMs);
      return;
    }
    // 没连上：有界退避重试（400ms ×2 封顶 6s、最多 6 次，用尽即停）
    const attempts = this.state.attempts + 1;
    this.clearGraceTimer();
    if (attempts >= this.options.retryMaxAttempts) {
      this.clearTimer();
      this.patch({
        phase: "stopped",
        error: message,
        error_class: errorClass,
        attempts,
        next_retry_at: null,
        status: "unknown",
        grace_expired: true,
      });
      return;
    }
    const delay = Math.min(this.options.retryBaseMs * 2 ** (attempts - 1), this.options.retryMaxMs);
    this.patch({
      phase: "retrying",
      error: message,
      error_class: errorClass,
      attempts,
      next_retry_at: now + delay,
      status: "unknown",
      grace_expired: true,
    });
    this.kick(delay);
  }

  private patch(partial: Partial<RuntimeDiagnosticsMonitorState<TReport>>): void {
    let changed = false;
    for (const key of Object.keys(partial) as Array<keyof RuntimeDiagnosticsMonitorState<TReport>>) {
      if (this.state[key] !== partial[key]) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    this.state = { ...this.state, ...partial };
    for (const listener of this.listeners) listener();
  }
}
