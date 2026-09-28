// V1 实况 Tab（DESIGN.md §3.10）：一眼回答三件事——谁在干、干到哪、刚干了什么。
// 口径：
// - 数据 = GET /live 快照（5s 轻轮询对账）+ SSE events 通道即时刷新（文件变更实时上屏，
//   全程不需要手动刷新，§3.9）；EventSource 断线自动重连，onopen 重新对账不丢事件。
// - 卡死变色报警：以最近事件 ts 计时，超阈值（可配，默认 10 分钟，界面可改秒数）无新事件
//   → 状态条变黄；黄态再超同一阈值仍无事件 → 变红。真实时间推进，不用转圈动画冒充活着。
// - Q139 刷新失败（已有快照时也明说）：快照留在屏上，但色条转"状态未知" + 顶部红色横幅，
//   不静默展示旧快照——旧快照的 last_event_at 不推进，照旧算 idle 会报出"项目卡死"的假警报
//   （数据源死了被误诊成项目卡了）。横幅自带「重试」，下一次拉成功自己消失。
// - 本组件只读展示；开/关文件监听由 App 随选中态驱动，不在这里挂。
import { useCallback, useEffect, useRef, useState } from "react";
import type { LiveSnapshot } from "../../server/live";
import { getLive, projectEventsUrl, type ProjectItem } from "../api";

/** 秒 → 显示用 mm:ss / hh:mm:ss（"N 秒前"那种粗粒度就够） */
function ago(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} 秒`;
  if (s < 3600) return `${Math.floor(s / 60)} 分钟`;
  return `${Math.floor(s / 3600)} 小时`;
}

/** 事件时间戳显示：HH:MM:SS（ts 是本地 ISO 带偏移，直接切时间部分） */
function hhmmss(ts: string): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const KIND_LABEL = { change: "变更", gate: "Gate", task: "任务" } as const;

export function LiveView({ project }: { project: ProjectItem }) {
  const [snap, setSnap] = useState<LiveSnapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** §3.1：最近一次**成功**观测的时间（失败期间不推进，刷新/重连不清空快照） */
  const [observedAt, setObservedAt] = useState<string | null>(null);
  // 变色阈值（秒）：初值取服务端缺省（10 分钟），用户可在界面改——可配项的落点
  const [thresholdSec, setThresholdSec] = useState<number | null>(null);
  // 变色计时基准：最近事件的毫秒时间（快照 last_event_at；无事件 = 进入本视图的时刻）
  const [nowMs, setNowMs] = useState<number>(Date.now());
  const fallbackBaseMsRef = useRef<number>(Date.now());
  /** 当前项目 id 的镜像：拉快照是**可重入**的（SSE / 轮询 / 手动重试），回包落地前要按它判
   *  "还是不是本视图的项目"——换项目后旧请求的回包必须丢掉，不许写进新项目的界面 */
  const projectIdRef = useRef(project.id);
  projectIdRef.current = project.id;

  /** 拉快照（唯一入口）：SSE 事件、断线重连、5s 轮询、错误横幅的「重试」全走它。
   *  Q139：失败时**只置 loadError、不动作**——快照留在界面上，但下面按"数据源没回话"显示，
   *  不删旧数据、也不把它当成"项目没动静"的证据。 */
  const resync = useCallback(() => {
    const id = projectIdRef.current;
    getLive(id)
      .then((live) => {
        if (projectIdRef.current !== id) return; // 换项目了：这份回包作废
        setSnap(live);
        setLoadError(null);
        // §3.1：自动重连/重试**不清空最后成功数据**，并且要显示**观测时间**——
        // 观测时间 = 最近一次拉成功的时间，失败期间不推进（一眼看出"看到的是什么时候的事实"）
        setObservedAt(new Date().toISOString());
        setThresholdSec((cur) => cur ?? Math.round(live.stall_threshold_ms / 1000));
      })
      .catch((e: Error) => {
        if (projectIdRef.current !== id) return;
        setLoadError(e.message);
      });
  }, []);

  // 拉快照 + SSE 实时刷新 + 5s 轮询对账
  useEffect(() => {
    const projectId = project.id;
    fallbackBaseMsRef.current = Date.now();
    setSnap(null);
    setLoadError(null);
    setThresholdSec(null);
    setObservedAt(null);
    resync();

    const es = new EventSource(projectEventsUrl(projectId));
    es.onopen = resync; // 断线重连后重新对账，断连期间的事件不丢
    es.onmessage = (ev) => {
      const data = JSON.parse(ev.data as string) as { hello?: boolean };
      if (data.hello) return;
      resync(); // 文件变更真推送：立即重新合成，动作流无刷新上屏
    };
    const poll = setInterval(resync, 5000); // Gate/任务变化走轻轮询对账（口径见 live.ts）
    return () => {
      es.close();
      clearInterval(poll);
    };
  }, [project.id, resync]);

  // 变色计时：每秒推进真实时钟（不许转圈冒充——色块本身就是状态）
  useEffect(() => {
    const tick = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);

  const lastEventMs = snap?.last_event_at
    ? Date.parse(snap.last_event_at)
    : fallbackBaseMsRef.current;
  const thresholdMs = (thresholdSec ?? 600) * 1000;
  const idleMs = nowMs - lastEventMs;
  const stall: "ok" | "yellow" | "red" =
    idleMs >= thresholdMs * 2 ? "red" : idleMs >= thresholdMs ? "yellow" : "ok";
  /** Q139：刷新失败 = 手上这份快照可能已经过期（数据源没回话）。旧快照的 last_event_at 不会推进，
   *  照旧按它算 idle 只会得出"项目卡死"的假警报——数据源死了被误诊成项目卡了，所以这时
   *  色条一律走"状态未知"，不报黄红（宁可说不出话，也不许说假话）。 */
  const stale = loadError !== null;
  const displayState: "ok" | "yellow" | "red" | "stale" = stale ? "stale" : stall;
  const stallBarClass =
    displayState === "stale"
      ? "border-neutral-700 bg-neutral-800/70 text-neutral-200"
      : displayState === "red"
        ? "border-red-500/60 bg-red-500/15 text-red-300"
        : displayState === "yellow"
          ? "border-amber-500/60 bg-amber-500/15 text-amber-300"
          : "border-neutral-800 bg-neutral-900 text-neutral-300";

  if (loadError && !snap) {
    return (
      <div className="flex items-center gap-2 p-4 text-xs text-red-400">
        <span className="min-w-0 flex-1 truncate" title={loadError}>
          实况加载失败：{loadError}
        </span>
        <button
          data-live-error-retry
          onClick={resync}
          className="shrink-0 rounded border border-red-500/40 px-2 py-0.5 text-red-300 hover:bg-red-500/20"
        >
          重试
        </button>
      </div>
    );
  }
  if (!snap) {
    return <p className="p-4 text-xs text-neutral-500">实况加载中…</p>;
  }

  return (
    <div
      data-live-view
      data-stall={displayState}
      data-live-stale={stale ? "1" : "0"}
      className="flex min-h-0 flex-1 flex-col"
    >
      {/* §3.1：观测时间（最近一次成功读到数据的时间）——与"项目最后一次动静"分开显示 */}
      <div className="flex shrink-0 items-center gap-2 border-b border-neutral-800 bg-neutral-900/30 px-4 py-1 text-[10px] text-neutral-500">
        <span data-live-observed>
          观测时间：{observedAt ?? "（还没有成功观测）"}
        </span>
        <span data-live-observed-note>
          （重连/刷新不会清空下面这份最后成功快照，只会不推进这个时间）
        </span>
      </div>
      {/* ── 状态条：变色报警覆盖整条（绿/黄/红三态，含阈值配置；刷新失败时是"未知"而不是报警）── */}
      <div
        data-stall-bar
        className={`flex shrink-0 items-center gap-3 border-b px-4 py-2 text-xs ${stallBarClass}`}
      >
        <span data-stall-label className="font-semibold">
          {displayState === "stale"
            ? "刷新失败：状态未知（不是项目没动静）"
            : displayState === "red"
              ? "卡死警报：长时间无任何动静"
              : displayState === "yellow"
                ? "注意：超过阈值没有新事件"
                : "流程有动静"}
        </span>
        <span>
          {stale ? (
            <>
              快照停在{" "}
              <span data-idle-ago>
                {snap.last_event_at ? hhmmss(snap.last_event_at) : "进本视图时"}
              </span>
              （未推进，数据源没回话）
            </>
          ) : (
            <>
              最近事件 <span data-idle-ago>{ago(idleMs)}</span>前
            </>
          )}
        </span>
        <span className="ml-auto flex items-center gap-1">
          变色阈值
          <input
            data-stall-threshold
            type="number"
            min={1}
            value={thresholdSec ?? 600}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isFinite(n) && n >= 1) setThresholdSec(Math.floor(n));
            }}
            className="w-16 rounded border border-neutral-700 bg-neutral-950 px-1 py-0.5 text-neutral-100"
          />
          秒
        </span>
      </div>

      {/* Q139：刷新失败的明说不许吞（有快照时原来一个字都不出）——横幅写清"看到的是旧快照、
          色条按未知处理"，并给一个立刻重拉的出口；下一次拉成功自己消失 */}
      {stale && (
        <div
          data-live-error-banner={loadError}
          className="flex shrink-0 items-center gap-2 border-b border-red-500/40 bg-red-500/10 px-4 py-1.5 text-[11px] text-red-300"
        >
          <span className="min-w-0 flex-1 truncate" title={loadError ?? ""}>
            实况刷新失败：{loadError}——下面是上次成功的快照，不是刚发生的事
          </span>
          <button
            data-live-error-retry
            onClick={resync}
            className="shrink-0 rounded border border-red-500/40 px-1.5 py-0.5 hover:bg-red-500/20"
          >
            重试
          </button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {/* ── 当前阶段（大字常驻）+ 谁在干活 ── */}
        <div className="mb-4 flex flex-wrap items-baseline gap-x-6 gap-y-1">
          <h2 data-live-stage className="text-2xl font-bold text-neutral-100">
            {snap.stage}
          </h2>
          <p data-live-actor className="text-sm text-neutral-300">
            {snap.actor.kind === "agent" ? (
              <>
                正在干活：<span className="font-semibold text-sky-300">{snap.actor.name}</span>
                {snap.actor.last_active_at ? `（最近活跃 ${hhmmss(snap.actor.last_active_at)}）` : ""}
              </>
            ) : (
              <>
                球在<span className="font-semibold text-amber-300">用户</span>这边（无进行中任务）
              </>
            )}
          </p>
        </div>

        {/* ── 状态区：任务四态计数 + 当前卡 + Gate 当前步 ── */}
        <div data-live-status className="mb-4 flex flex-wrap gap-2 text-xs">
          {(["todo", "doing", "done", "blocked"] as const).map((k) => (
            <span
              key={k}
              data-task-count={k}
              className="rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-neutral-300"
            >
              {k} <span className="font-bold text-neutral-100">{snap.task_counts[k]}</span>
            </span>
          ))}
          <span
            data-gate-step
            className="rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-neutral-300"
          >
            Gate 当前步：<span className="font-bold text-neutral-100">{snap.gate.step_name}</span>
            （{snap.gate.result}）
          </span>
          {/* V08-01 状态区 v2 派生：口径与"已交结果≠已验收"必须写在界面上，不能靠颜色或简称糊过去 */}
          <span
            data-task-source={snap.task_source}
            title={
              snap.task_source === "v2_events"
                ? "任务状态来自 v2 事件投影（DESIGN §2.6 单一事实源）"
                : snap.task_source === "v2_events+v1_fallback"
                  ? `v2 事件投影为主；另有 ${snap.task_v1_fallback_ids.length} 行只有 v1 台账有，如实回退显示（不吞掉台账）`
                  : "该项目还没迁到 v2：任务状态读的是迁移期兼容台账 tasks.json"
            }
            className="rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-neutral-400"
          >
            口径：
            {snap.task_source === "v2_events"
              ? "v2 事件投影"
              : snap.task_source === "v2_events+v1_fallback"
                ? `v2 事件投影 + v1 回退 ${snap.task_v1_fallback_ids.length} 行`
                : "v1 兼容台账"}
          </span>
          {snap.result_submitted_ids.length > 0 && (
            <span
              data-awaiting-acceptance
              title="结果已提交只表示执行者交了结果；审计与人工验收另计（DESIGN §5.4）"
              className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-amber-200"
            >
              结果已提交（待验收/复核）：{snap.result_submitted_ids.length} 张
              （{snap.result_submitted_ids.slice(0, 4).join("、")}
              {snap.result_submitted_ids.length > 4 ? "…" : ""}）
            </span>
          )}
          {snap.current_task && (
            <span
              data-current-task
              className="rounded border border-sky-500/40 bg-sky-500/10 px-2 py-1 text-sky-200"
            >
              当前卡：{snap.current_task.id}「{snap.current_task.title}」
              {snap.current_task.v2_status_label ? `（${snap.current_task.v2_status_label}）` : ""}
            </span>
          )}
        </div>

        {/* ── 滚动动作流（带时间戳，最新在上，新事件自动上屏）── */}
        <h3 className="mb-1 text-xs font-semibold text-neutral-400">动作流</h3>
        <ul data-live-events className="space-y-1">
          {snap.events.length === 0 && (
            <li className="text-xs text-neutral-600">还没有任何动作记录</li>
          )}
          {snap.events.map((ev, i) => (
            <li key={`${ev.ts}-${i}`} data-live-event data-kind={ev.kind} className="flex gap-2 text-xs">
              <span className="shrink-0 font-mono text-neutral-500">{hhmmss(ev.ts)}</span>
              <span className="shrink-0 text-neutral-500">[{KIND_LABEL[ev.kind]}]</span>
              <span className="text-neutral-300">{ev.text}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
