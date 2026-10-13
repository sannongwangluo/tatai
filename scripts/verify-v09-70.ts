// V09-70 隔离验证（PLAN V09-70「交付」：监看/退避/去重/恢复核验反例）。
//
// 只跑**监看状态机**与**只读观测旁路**这两块与渲染无关的行为（无 React、无浏览器、无真实后端）：
//   · 假时钟 + 假可见性 + 假恢复信号 + 可控 fetch：把"5 秒一次 / 全部主视图隐藏即暂停 / 至多一笔在途 /
//     失败退避 400×2 封顶 6s 最多 6 次即停 / 成功即停重试并回 5 秒 / 焦点·online·手动再触发并重算预算 /
//     切项目中止旧回包 / 恢复后比对 generated_at 与宿主身份"逐条真跑。
//   · 只读观测旁路：诊断读口自身被排除（避免自我递归）；旁路事件**不含** URL/query/token/正文。
//
// 这只是**隔离层**证据（证明状态机行为）；真浏览器渲染与 App 接线由 `verify-v09-70-ui.py`（mock 后端读口）覆盖。
// 两者证据分开，缺一不算。
//
// 用法：pnpm exec tsx scripts/verify-v09-70.ts   （退出码 0 全过 / 1 有失败）

import {
  RuntimeDiagnosticsMonitor,
  type MonitorEnv,
  type RuntimeDiagnosticsDigest,
} from "../src/ui/runtimeDiagnosticsMonitor";
import { setSharedReadObserver, sharedReadFetch, type RawFetch, type SharedReadEvent } from "../src/ui/sharedRead";
import type { RuntimeHealthState } from "../src/shared/runtimeDiagnostics";

interface FakeReport {
  generated_at: string;
  status: RuntimeHealthState;
  pid: number;
  release_id: string;
}

const digestOf = (r: FakeReport): RuntimeDiagnosticsDigest => ({
  status: r.status,
  generated_at: r.generated_at,
  host_id: `${r.pid}:${r.release_id}`,
});

function report(at: string, status: RuntimeHealthState = "healthy", pid = 1, release = "relA"): FakeReport {
  return { generated_at: at, status, pid, release_id: release };
}

const classify = (m: string): "unreachable" | "unsupported" | "business" =>
  /unreachable/i.test(m) ? "unreachable" : /unsupported/i.test(m) ? "unsupported" : "business";

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const flushDeep = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await flush();
};

// ── 失败收集 ──────────────────────────────────────────────────────────────
let failures = 0;
let checks = 0;
function check(name: string, cond: boolean, detail = ""): void {
  checks += 1;
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}${detail === "" ? "" : ` — ${detail}`}`);
  }
}

// ── 假环境：可控时钟 / 定时器 / 可见性 / 恢复信号 ─────────────────────────────
class FakeEnv implements MonitorEnv {
  time = 0;
  visible = true;
  private timers = new Map<number, { at: number; fn: () => void }>();
  private nextId = 1;
  private handlers = new Map<string, Array<() => void>>();
  now(): number {
    return this.time;
  }
  setTimeout(fn: () => void, ms: number): number {
    const id = this.nextId++;
    this.timers.set(id, { at: this.time + ms, fn });
    return id;
  }
  clearTimeout(handle: number): void {
    this.timers.delete(handle);
  }
  isDocumentVisible(): boolean {
    return this.visible;
  }
  onSignal(signal: "visibilitychange" | "online" | "focus", handler: () => void): () => void {
    const arr = this.handlers.get(signal) ?? [];
    arr.push(handler);
    this.handlers.set(signal, arr);
    return () => {
      const i = arr.indexOf(handler);
      if (i >= 0) arr.splice(i, 1);
    };
  }
  fire(signal: string): void {
    for (const h of [...(this.handlers.get(signal) ?? [])]) h();
  }
  async advance(ms: number): Promise<void> {
    const target = this.time + ms;
    for (;;) {
      let pick: { id: number; at: number; fn: () => void } | null = null;
      for (const [id, t] of this.timers) {
        if (t.at <= target && (pick === null || t.at < pick.at)) pick = { id, at: t.at, fn: t.fn };
      }
      if (pick === null) break;
      this.time = Math.max(this.time, pick.at);
      this.timers.delete(pick.id);
      pick.fn();
      await flushDeep();
    }
    this.time = Math.max(this.time, target);
    await flushDeep();
  }
}

interface Sink {
  projectId: string | null;
  signal: AbortSignal;
  time: number;
  resolve: (r: FakeReport) => void;
  reject: (e: unknown) => void;
}
class FetchQueue {
  readonly all: Sink[] = [];
  private pending: Sink[] = [];
  readonly fn = (ctx: { projectId: string | null; signal: AbortSignal }): Promise<FakeReport> => {
    return new Promise<FakeReport>((resolve, reject) => {
      const sink: Sink = { projectId: ctx.projectId, signal: ctx.signal, time: 0, resolve, reject };
      this.all.push(sink);
      this.pending.push(sink);
      ctx.signal.addEventListener(
        "abort",
        () => {
          const i = this.pending.indexOf(sink);
          if (i >= 0) this.pending.splice(i, 1);
          const e = new Error("aborted");
          e.name = "AbortError";
          reject(e);
        },
        { once: true },
      );
    });
  };
  take(): Sink {
    const s = this.pending.shift();
    if (s === undefined) throw new Error("no pending fetch");
    return s;
  }
  get pendingCount(): number {
    return this.pending.length;
  }
  get count(): number {
    return this.all.length;
  }
}

function newMonitor(env: FakeEnv, fetchQueue: FetchQueue, opts: { intervalMs?: number; readTimeoutMs?: number } = {}) {
  const monitor = new RuntimeDiagnosticsMonitor<FakeReport>({
    env,
    fetchReport: fetchQueue.fn,
    digest: digestOf,
    classifyError: classify,
    intervalMs: opts.intervalMs ?? 5000,
    readTimeoutMs: opts.readTimeoutMs ?? 12000,
  });
  monitor.subscribe(() => {});
  return monitor;
}

async function main(): Promise<void> {
  console.log("V09-70 监看状态机隔离验证（假时钟 + 可控 fetch）");

  // ── T1 可见态 5 秒监看 ──────────────────────────────────────────────
  {
    const env = new FakeEnv();
    const q = new FetchQueue();
    const m = newMonitor(env, q);
    m.setContext("P");
    await env.advance(0);
    check("T1 首次立即读一轮", q.count === 1 && m.getSnapshot().in_flight, `count=${q.count}`);
    q.take().resolve(report("2026-10-13T00:00:00.000Z"));
    await flushDeep();
    check("T1 成功后进入监看", m.getSnapshot().phase === "monitoring" && !m.getSnapshot().in_flight);
    await env.advance(4900);
    check("T1 未到 5s 不读", q.count === 1, `count=${q.count}`);
    await env.advance(200);
    check("T1 满 5s 再读一轮", q.count === 2, `count=${q.count}`);
  }

  // ── T2 全部主视图隐藏即暂停 ─────────────────────────────────────────
  {
    const env = new FakeEnv();
    const q = new FetchQueue();
    const m = newMonitor(env, q);
    m.setContext("P");
    await env.advance(0);
    q.take().resolve(report("2026-10-13T00:00:01.000Z"));
    await flushDeep();
    env.visible = false;
    env.fire("visibilitychange");
    await flushDeep();
    check("T2 文档隐藏即暂停", m.getSnapshot().phase === "paused");
    const before = q.count;
    await env.advance(60000);
    check("T2 暂停后不再主动读", q.count === before, `count=${q.count}`);
    env.visible = true;
    env.fire("visibilitychange");
    await env.advance(0);
    check("T2 恢复可见立即再读一轮", q.count === before + 1, `count=${q.count}`);
  }

  // ── T2b 无项目（无主视图）即暂停 ────────────────────────────────────
  {
    const env = new FakeEnv();
    const q = new FetchQueue();
    const m = newMonitor(env, q);
    m.setContext(null);
    await env.advance(60000);
    check("T2b 无主视图时不读", q.count === 0 && m.getSnapshot().phase === "paused", `count=${q.count}`);
  }

  // ── T2c 在途回包在隐藏后落地 ⇒ 仍标暂停、不再排下一轮 ───────────────
  {
    const env = new FakeEnv();
    const q = new FetchQueue();
    const m = newMonitor(env, q);
    m.setContext("P");
    await env.advance(0); // 首读在途
    env.visible = false;
    env.fire("visibilitychange"); // 隐藏（此时读还在途）
    q.take().resolve(report("2026-10-13T00:00:03.000Z"));
    await flushDeep();
    check("T2c 在途回包在隐藏后落地仍标暂停", m.getSnapshot().phase === "paused", `phase=${m.getSnapshot().phase}`);
    const before = q.count;
    await env.advance(60000);
    check("T2c 隐藏态不再排下一轮", q.count === before, `count=${q.count}`);
  }

  // ── T3 任一瞬间至多一笔在途（去重） ─────────────────────────────────
  {
    const env = new FakeEnv();
    const q = new FetchQueue();
    const m = newMonitor(env, q);
    m.setContext("P");
    await env.advance(0);
    m.retryNow(); // 在途时再触发
    m.retryNow();
    await env.advance(100); // 时钟小幅前进（未到读超时）：不得叠第二笔
    check("T3 至多一笔在途", q.count === 1, `count=${q.count}`);
    q.take().resolve(report("2026-10-13T00:00:02.000Z"));
    await flushDeep();
    check("T3 在途结算后恢复监看", m.getSnapshot().phase === "monitoring" && q.pendingCount === 0);
  }

  // ── T4 失败退避 400×2 封顶 6s、最多 6 次即停 ─────────────────────────
  {
    const env = new FakeEnv();
    const q = new FetchQueue();
    const m = newMonitor(env, q);
    m.setContext("P");
    await env.advance(0);
    const gaps: number[] = [];
    let last = env.time;
    for (let i = 0; i < 6; i++) {
      const sink = q.take();
      sink.reject(new Error("unreachable: ECONNREFUSED"));
      await flushDeep();
      const st = m.getSnapshot();
      if (i < 5) {
        check(`T4 第 ${i + 1} 次失败进入退避重试`, st.phase === "retrying" && st.attempts === i + 1, `phase=${st.phase} attempts=${st.attempts}`);
        const delay = Math.min(400 * 2 ** i, 6000);
        await env.advance(delay - 1);
        check(`T4 退避未到不读（第 ${i + 1} 次 delay=${delay}）`, q.pendingCount === 0, `pending=${q.pendingCount}`);
        await env.advance(1);
        gaps.push(env.time - last);
        last = env.time;
        check(`T4 退避到点重读（第 ${i + 1} 次）`, q.count === i + 2, `count=${q.count}`);
      } else {
        check("T4 第 6 次失败即停", st.phase === "stopped" && st.attempts === 6, `phase=${st.phase} attempts=${st.attempts}`);
      }
    }
    check("T4 退避序列 400/800/1600/3200/6000（第 5 次封顶 6s）", JSON.stringify(gaps) === JSON.stringify([400, 800, 1600, 3200, 6000]), JSON.stringify(gaps));
    const before = q.count;
    await env.advance(120000);
    check("T4 停止后不再主动读", q.count === before, `count=${q.count}`);
    check("T4 从未成功 ⇒ 状态 unknown（不猜成 healthy/unavailable）", m.getSnapshot().status === "unknown");
  }

  // ── T5 成功即停本轮重试并回 5 秒监看 ────────────────────────────────
  {
    const env = new FakeEnv();
    const q = new FetchQueue();
    const m = newMonitor(env, q);
    m.setContext("P");
    await env.advance(0);
    q.take().reject(new Error("unreachable: boom"));
    await flushDeep();
    check("T5 失败一次后处于重试", m.getSnapshot().phase === "retrying" && m.getSnapshot().attempts === 1);
    await env.advance(400);
    q.take().resolve(report("2026-10-13T00:00:05.000Z"));
    await flushDeep();
    const st = m.getSnapshot();
    check("T5 成功停重试并回监看", st.phase === "monitoring" && st.attempts === 0 && st.error === null);
    await env.advance(4900);
    const c1 = q.count;
    await env.advance(200);
    check("T5 成功后按 5 秒监看（非零请求）", q.count === c1 + 1, `count=${q.count}`);
  }

  // ── T6 焦点 / online / 手动再触发并重算预算 ─────────────────────────
  {
    const env = new FakeEnv();
    const q = new FetchQueue();
    const m = newMonitor(env, q);
    m.setContext("P");
    await env.advance(0);
    q.take().reject(new Error("unreachable: a"));
    await flushDeep();
    await env.advance(400);
    q.take().reject(new Error("unreachable: b"));
    await flushDeep();
    check("T6 连续失败预算递增", m.getSnapshot().attempts === 2, `attempts=${m.getSnapshot().attempts}`);
    const before = q.count;
    env.fire("online");
    await env.advance(0);
    const st = m.getSnapshot();
    check("T6 online 再触发一轮并重算预算", q.count === before + 1 && st.attempts === 0, `count=${q.count} attempts=${st.attempts}`);
    q.take().resolve(report("2026-10-13T00:00:09.000Z"));
    await flushDeep();
    const before2 = q.count;
    m.retryNow();
    await env.advance(0);
    check("T6 手动重试再触发一轮", q.count === before2 + 1, `count=${q.count}`);
  }

  // ── T7 切项目中止在途、丢弃旧回包 ───────────────────────────────────
  {
    const env = new FakeEnv();
    const q = new FetchQueue();
    const m = newMonitor(env, q);
    m.setContext("A");
    await env.advance(0);
    const aSink = q.take();
    m.setContext("B");
    await flushDeep();
    check("T7 切项目中止旧在途", aSink.signal.aborted, "A 的 signal 未被中止");
    await env.advance(0);
    const bSink = q.take();
    check("T7 新项目立即开读", bSink.projectId === "B", `projectId=${bSink.projectId}`);
    aSink.resolve(report("2026-10-13T00:00:07.000Z", "healthy", 7, "relA"));
    await flushDeep();
    check("T7 旧回包不落地（不串数据）", m.getSnapshot().report === null && m.getSnapshot().project_id === "B", `report=${m.getSnapshot().report}`);
    bSink.resolve(report("2026-10-13T00:00:08.000Z", "degraded", 8, "relB"));
    await flushDeep();
    check("T7 新项目回包落地", m.getSnapshot().report?.generated_at === "2026-10-13T00:00:08.000Z");
  }

  // ── T8 恢复后比对 generated_at 与宿主身份 ───────────────────────────
  {
    const env = new FakeEnv();
    const q = new FetchQueue();
    const m = newMonitor(env, q);
    m.setContext("P");
    await env.advance(0);
    q.take().resolve(report("2026-10-13T00:00:10.000Z", "healthy", 1, "relA"));
    await flushDeep();
    check("T8 首次成功无恢复说明", m.getSnapshot().recovery === null);
    // 失败一轮
    await env.advance(5000);
    q.take().reject(new Error("unreachable: x"));
    await flushDeep();
    await env.advance(400);
    q.take().resolve(report("2026-10-13T00:00:20.000Z", "healthy", 9, "relB"));
    await flushDeep();
    const rec = m.getSnapshot().recovery;
    check("T8 恢复读到新报告且换宿主", rec !== null && rec.fresh_report && rec.host_changed, JSON.stringify(rec));
    // 再失败一轮，回包 generated_at 与故障前相同 ⇒ 不据此声称已恢复
    await env.advance(5000);
    q.take().reject(new Error("unreachable: y"));
    await flushDeep();
    await env.advance(400);
    q.take().resolve(report("2026-10-13T00:00:20.000Z", "healthy", 9, "relB"));
    await flushDeep();
    const rec2 = m.getSnapshot().recovery;
    check("T8 同 generated_at 不声称已恢复", rec2 !== null && rec2.fresh_report === false, JSON.stringify(rec2));
  }

  // ── T9 客户端读超时：这次没读到（不判服务已死）＋可恢复 ─────────────
  {
    const env = new FakeEnv();
    const q = new FetchQueue();
    const m = newMonitor(env, q, { readTimeoutMs: 1000 });
    m.setContext("P");
    await env.advance(0);
    await env.advance(1000); // 触发读超时 → abort
    await flushDeep();
    const st = m.getSnapshot();
    check("T9 读超时如实报出（不判服务已死）", st.phase === "retrying" && st.error?.includes("超时") === true, `phase=${st.phase} error=${st.error}`);
    check("T9 从未成功 ⇒ unknown", st.status === "unknown");
    await env.advance(400);
    q.take().resolve(report("2026-10-13T00:00:30.000Z"));
    await flushDeep();
    check("T9 重连成功即恢复监看", m.getSnapshot().phase === "monitoring");
  }

  // ── T10 业务错误不重试、仍按 5 秒监看 ───────────────────────────────
  {
    const env = new FakeEnv();
    const q = new FetchQueue();
    const m = newMonitor(env, q);
    m.setContext("P");
    await env.advance(0);
    q.take().reject(new Error("business: [INVALID_INPUT] bad project"));
    await flushDeep();
    const st = m.getSnapshot();
    check("T10 业务错误不退避", st.phase === "monitoring" && st.error_class === "business", `phase=${st.phase} class=${st.error_class}`);
    await env.advance(4900);
    const c1 = q.count;
    await env.advance(200);
    check("T10 业务错误仍按 5 秒监看", q.count === c1 + 1, `count=${q.count}`);
  }

  // ── T11 旧宿主未接入：明报支持缺位且停止 ────────────────────────────
  {
    const env = new FakeEnv();
    const q = new FetchQueue();
    const m = newMonitor(env, q);
    m.setContext("P");
    await env.advance(0);
    q.take().reject(new Error("[UNSUPPORTED] 后端未提供运行诊断读口"));
    await flushDeep();
    const st = m.getSnapshot();
    check("T11 未接入 ⇒ stopped + supported=false", st.phase === "stopped" && st.supported === false, `phase=${st.phase} supported=${st.supported}`);
    const before = q.count;
    await env.advance(60000);
    check("T11 未接入不再空轮询", q.count === before, `count=${q.count}`);
  }

  // ── T12 冷启动宽限 → 持续未知 ───────────────────────────────────────
  {
    const env = new FakeEnv();
    const q = new FetchQueue();
    const m = newMonitor(env, q, { readTimeoutMs: 100000 });
    m.setContext("P");
    await env.advance(0);
    const st0 = m.getSnapshot();
    check("T12 宽限内 grace 且未过期", st0.phase === "grace" && st0.grace_expired === false, `phase=${st0.phase} expired=${st0.grace_expired}`);
    await env.advance(8000);
    const st1 = m.getSnapshot();
    check("T12 宽限过后标持续未知", st1.grace_expired === true && st1.status === "unknown", `expired=${st1.grace_expired}`);
  }

  // ── T13 客户端观测：排除诊断自身、只统计、不含 URL ──────────────────
  {
    const env = new FakeEnv();
    const q = new FetchQueue();
    const m = newMonitor(env, q);
    m.setContext("P");
    await env.advance(0);
    q.take().resolve(report("2026-10-13T00:00:40.000Z"));
    await flushDeep();
    m.observeRead({ at: env.now(), ok: false, status: null, duration_ms: 5, aborted: false, diagnostics: true }); // 诊断自身：排除
    check("T13 诊断读口自身的失败被排除（不自我递归）", m.getSnapshot().client_observation.failures === 0);
    m.observeRead({ at: env.now(), ok: false, status: 503, duration_ms: 50, aborted: false, diagnostics: false });
    m.observeRead({ at: env.now(), ok: false, status: null, duration_ms: 60, aborted: false, diagnostics: false });
    m.observeRead({ at: env.now(), ok: true, status: 200, duration_ms: 9000, aborted: false, diagnostics: false }); // 慢读
    m.observeRead({ at: env.now(), ok: false, status: null, duration_ms: 10, aborted: true, diagnostics: false }); // 取消：不算失败
    const obs = m.getSnapshot().client_observation;
    check("T13 统计失败/慢读（取消不计）", obs.failures === 2 && obs.slow === 1, JSON.stringify(obs));
    check("T13 记下最近失败状态码", obs.last_failure_status === null, `last=${obs.last_failure_status}`);
  }

  // ── T14 只读观测旁路脱敏（sharedRead 真跑分支） ─────────────────────
  {
    const events: SharedReadEvent[] = [];
    setSharedReadObserver((e) => events.push(e));
    try {
      const secret = "SUPER_SECRET_TOKEN_should_never_appear";
      const okRaw: RawFetch = () => Promise.resolve(new Response("{}", { status: 200 }));
      await sharedReadFetch(`http://127.0.0.1:1/api/runtime/diagnostics?project_id=P&token=${secret}`, undefined, okRaw);
      await flush();
      await sharedReadFetch(`http://127.0.0.1:1/api/projects/P/live?token=${secret}`, undefined, okRaw);
      await flush();
      const diag = events.find((e) => e.diagnostics);
      const other = events.find((e) => !e.diagnostics);
      check("T14 诊断读口被分类标记", diag !== undefined, JSON.stringify(events));
      check("T14 普通读不误标诊断", other !== undefined);
      const serialized = JSON.stringify(events);
      check("T14 观测事件不含 URL/query/token/正文", !/SUPER_SECRET_TOKEN|token=|project_id|127\.0\.0\.1/.test(serialized), serialized);
    } finally {
      setSharedReadObserver(null);
    }
  }

  // ── T15 读失败后**当前**状态=unknown（不沿用上次 healthy；保留历史报告）[F01] ──
  {
    const env = new FakeEnv();
    const q = new FetchQueue();
    const m = newMonitor(env, q);
    m.setContext("P");
    await env.advance(0);
    q.take().resolve(report("2026-10-13T00:00:00.000Z", "healthy", 1, "relA"));
    await flushDeep();
    check("T15 先到 healthy", m.getSnapshot().status === "healthy" && m.getSnapshot().report !== null, `status=${m.getSnapshot().status}`);
    await env.advance(5000);
    q.take().reject(new Error("unreachable: Failed to fetch"));
    await flushDeep();
    const st1 = m.getSnapshot();
    check("T15 失败后当前状态不再 healthy（落 unknown）", st1.status === "unknown", `status=${st1.status}`);
    check("T15 失败时 error 已置（提示行不再显示运行正常）", st1.error !== null, `error=${st1.error}`);
    check("T15 历史报告保留（供标旧读数）", st1.report !== null && st1.report.generated_at === "2026-10-13T00:00:00.000Z");
    for (let i = 1; i < 6; i++) { // 退避重试直到第 6 次用尽即停
      const delay = Math.min(400 * 2 ** (i - 1), 6000);
      await env.advance(delay);
      q.take().reject(new Error("unreachable: still down"));
      await flushDeep();
    }
    const st2 = m.getSnapshot();
    check("T15 重试停止后仍为 unknown（不回到上次 healthy）", st2.status === "unknown" && st2.phase === "stopped", `status=${st2.status} phase=${st2.phase}`);
    check("T15 停止后仍保留历史报告", st2.report !== null);
    m.retryNow();
    await env.advance(0);
    q.take().resolve(report("2026-10-13T00:05:00.000Z", "healthy", 5, "relB"));
    await flushDeep();
    const st3 = m.getSnapshot();
    check("T15 真正新鲜成功才恢复 healthy", st3.status === "healthy" && st3.error === null, `status=${st3.status}`);
  }

  // ── T16 客户端观测随 60 秒窗口**自然过期**（无新事件也清零；通知有界不自激）[F02] ──
  {
    const env = new FakeEnv();
    const q = new FetchQueue();
    // 拉长监看周期：本用例隔离"观测到期定时器"，不让 5 秒轮询本身的请求/通知混进来
    const m = newMonitor(env, q, { intervalMs: 1_000_000 });
    let notifications = 0;
    m.subscribe(() => { notifications += 1; });
    m.setContext("P");
    await env.advance(0);
    q.take().resolve(report("2026-10-13T00:00:00.000Z"));
    await flushDeep();
    m.observeRead({ at: env.now(), ok: false, status: null, duration_ms: 5, aborted: false, diagnostics: false });
    m.observeRead({ at: env.now(), ok: true, status: 200, duration_ms: 9000, aborted: false, diagnostics: false }); // 慢读
    const obs0 = m.getSnapshot().client_observation;
    check("T16 失败/慢读即时计入", obs0.failures === 1 && obs0.slow === 1, JSON.stringify(obs0));
    await env.advance(59000);
    const obs1 = m.getSnapshot().client_observation;
    check("T16 未到窗口不提前清零", obs1.failures === 1 && obs1.slow === 1, JSON.stringify(obs1));
    await env.advance(1600); // 越过 60s 窗口，且**无新失败/慢读事件**
    const obs2 = m.getSnapshot().client_observation;
    check("T16 超窗且无新事件 ⇒ 失败/慢读自然清零", obs2.failures === 0 && obs2.slow === 0, JSON.stringify(obs2));
    const nExpired = notifications;
    await env.advance(180000);
    check("T16 过期后不再自激刷新（通知有界）", notifications === nExpired, `n=${notifications} nExpired=${nExpired}`);
    check("T16 快照引用稳定（useSyncExternalStore 前提）", m.getSnapshot() === m.getSnapshot());
  }

  // ── T17 重挂载：卸载即清"当前项目"，不用旧 project_id 先发一笔读 [F05] ──
  {
    const env = new FakeEnv();
    const q = new FetchQueue();
    const m = new RuntimeDiagnosticsMonitor<FakeReport>({ env, fetchReport: q.fn, digest: digestOf, classifyError: classify });
    const unsub = m.subscribe(() => {});
    m.setContext("A");
    await env.advance(0);
    q.take().resolve(report("2026-10-13T00:00:00.000Z", "healthy", 1, "relA"));
    await flushDeep();
    check("T17 首个消费者读到项目 A", m.getSnapshot().report !== null && m.getSnapshot().project_id === "A");
    unsub(); // 最后一个消费者卸载 ⇒ stop()
    await flushDeep();
    check("T17 卸载后不再保留旧 project_id", m.getSnapshot().project_id === null, `pid=${m.getSnapshot().project_id}`);
    const before = q.count;
    m.subscribe(() => {}); // 重挂载（挂载 effect 尚未执行 setContext）
    await env.advance(0);
    check("T17 重挂载时不先用旧 project 发读", q.count === before, `count=${q.count} before=${before}`);
    m.setContext("A");
    await env.advance(0);
    const sink = q.take();
    check("T17 setContext 后才按正确 project 读", q.count === before + 1 && sink.projectId === "A", `count=${q.count} pid=${sink.projectId}`);
  }

  console.log(`\nV09-70 隔离验证：${checks - failures}/${checks} 通过`);
  if (failures > 0) {
    console.log(`有 ${failures} 项失败`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("V09-70 验证脚本异常：", e);
  process.exit(1);
});
