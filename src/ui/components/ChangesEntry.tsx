// H2 顶部小入口「最近变更 · N 条新」（DESIGN.md §3.8 变更流水简版 + §3.1 顶部一行左侧）。
// 口径：
// - N = 自用户上次查看（打开流水子页面）后的新变更计数。数据源 = GET changes 对账初始化 +
//   EventSource（GET /api/projects/:id/events，SSE）实时 +1——真推送，全程无手动刷新（§3.9）；
//   EventSource 断线自动重连，每次 open 都重新拉 changes 对账，断连期间的变更不丢。
// - N>0 时琥珀色徽标醒目；N=0 时入口仍在但灰色不喧哗（H2 DoD③）。
// - Q40（2026-09-18 审计）：SSE 是**一行一帧**（watcher 一批最多 500 行逐行推），此前每个事件都
//   触发一次全量重拉 → 成本 O(事件数 × 文件行数)。改为 300ms 尾随防抖 + 在途去重：连续事件合并成
//   一次重拉，代价是至多 300ms 的显示延迟；onopen（首连/断线重连）仍立即对账，不等防抖。
// - Q92（2026-09-18 审计）：对账失败不再静默吞——徽标进错误态（`!` + 红色 + data-changes-count-error
//   带原因），否则"计数失败"与"真的 0 条新"在界面上永远分不开（同项目 LiveView 是 setLoadError 的做法）。
// - H3：点击 = 开出独立变更流水子页面（ChangesPage，全屏覆盖），本次查看即"已读"（N 清零）；
//   子页面是覆盖层，主视图（选中项目/页签）不动，关闭即回原状（H3 DoD④）。
// - 本组件只管展示与订阅；开/关监听（POST/DELETE watch）由 App 随选中态驱动，不在这里挂。
import { useEffect, useRef, useState } from "react";
import type { ChangeLine } from "../../server/watcher";
import { getChanges, projectEventsUrl, type ProjectItem } from "../api";
import { ChangesPage } from "./ChangesPage";

/** Q40：SSE 事件合并窗口（毫秒）——窗口内连续到达的变更只重拉一次 */
const RESYNC_DEBOUNCE_MS = 300;

/** changes 里 ts 晚于基准的条数（基准 = 上次查看时最新一条的 ts；对账计数，不靠裸 +1 防重复/断连丢数）。
 * 一律 Date.parse 成毫秒再比：changes 的 ts 是本地 ISO 带偏移（+08:00），直接跟 new Date().toISOString()
 * （UTC，Z 结尾）做字符串比较会跨时区比错——踩过的坑，不许改回字符串比较。 */
function countSince(changes: ChangeLine[], baselineMs: number): number {
  return changes.filter((c) => Date.parse(c.ts) > baselineMs).length;
}

export function ChangesEntry({ project }: { project: ProjectItem }) {
  const [newCount, setNewCount] = useState(0);
  const [countError, setCountError] = useState<string | null>(null);
  const [pageOpen, setPageOpen] = useState(false);
  // 基准毫秒用 ref：N 的清零/对账不需要触发重渲染，全部以"拉到的 changes + baselineMs"现算
  const baselineMsRef = useRef<number>(Date.now());
  /** V09-26（§3.1）：切项目瞬间在途的 `getChanges(旧项目)` 回包不许落到新项目上
   *  （本组件此前是唯一一处漏了代际守卫的；SSE 重连虽会纠正，但那一瞬的读数是错的）。 */
  const idRef = useRef(project.id);
  idRef.current = project.id;

  // 切项目：重置计数，拉 changes 对账初始化，开 SSE 实时推送；关子页面
  useEffect(() => {
    const projectId = project.id;
    baselineMsRef.current = Date.now();
    setNewCount(0);
    setCountError(null);
    setPageOpen(false);

    // V09-26：在途/待补/定时器**本 effect 私有**——此前它们是与组件同寿的 ref，
    // 换项目时旧请求的 finally 会把"补拉"错跑到旧项目的 resync 闭包上（B 的补拉只补拉了 A）。
    // 再用 AbortController + disposed 让换项目/卸载后的旧回包一律作废（§3.1；A→B→A 也不回退）。
    let disposed = false;
    let inflight = false;
    let pending = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const controller = new AbortController();

    const resync = () => {
      if (disposed) return;
      if (inflight) {
        pending = true; // 在途：不并发重拉，回来后再补一次
        return;
      }
      inflight = true;
      getChanges(projectId, 50, { signal: controller.signal })
        .then((changes) => {
          if (disposed || controller.signal.aborted) return; // 换项目/卸载了：这份回包作废（§3.1）
          setNewCount(countSince(changes, baselineMsRef.current));
          setCountError(null);
        })
        .catch((e: Error) => {
          if (disposed || controller.signal.aborted) return;
          // Q92：计数失败如实进错误态（如项目目录被删 / changes.jsonl 坏行），不静默吞
          setCountError(e.message);
        })
        .finally(() => {
          if (disposed) return;
          inflight = false;
          if (pending) {
            pending = false;
            resync();
          }
        });
    };
    // Q40：事件合并（尾随 300ms）；立即对账的场合（首拉/重连）走 resyncNow
    const scheduleResync = () => {
      if (disposed) return;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(resync, RESYNC_DEBOUNCE_MS);
    };
    const resyncNow = () => {
      if (disposed) return;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      resync();
    };
    resyncNow();

    const es = new EventSource(projectEventsUrl(projectId));
    es.onopen = resyncNow; // 首连 hello 与断线重连都重新对账，断连期间的变更不丢
    es.onmessage = (ev) => {
      const data = JSON.parse(ev.data as string) as Partial<ChangeLine> & { hello?: boolean };
      if (data.hello) return; // hello 只是握手，对账已在 onopen 做过
      // 真变更事件：合并窗口后重新对账即时上屏（不等手动刷新，§3.9）
      scheduleResync();
    };
    return () => {
      disposed = true;
      controller.abort();
      if (timer !== null) clearTimeout(timer);
      timer = null;
      es.close();
    };
  }, [project.id]);

  // 点击入口 = 查看：开流水子页面，本次查看即已读（N 清零，基准提到当前最新一条）
  const openPage = () => {
    const pid = project.id;
    getChanges(pid, 1)
      .then((changes) => {
        if (idRef.current !== pid) return; // 换项目了：这次查看作废，不把旧项目读数写进新项目（§3.1）
        baselineMsRef.current = changes.length > 0 ? Date.parse(changes[0].ts) : Date.now();
        setNewCount(0);
        setCountError(null);
        setPageOpen(true);
      })
      .catch(() => {
        if (idRef.current !== pid) return;
        // 对账失败也照开子页面（页面内有自身错误态），只不清零计数
        setPageOpen(true);
      });
  };

  const hot = newCount > 0;
  const failed = countError !== null;
  return (
    <div className="relative self-center">
      <button
        data-changes-entry
        data-new-count={newCount}
        data-changes-count-error={countError ?? ""}
        onClick={openPage}
        title={
          failed
            ? `最近变更计数失败：${countError}（点开看变更流水子页面）`
            : "最近变更（点击开变更流水子页面；文件监听实时推送，§3.8/§3.9）"
        }
        className={`flex items-center gap-1.5 rounded px-2 py-1 text-xs ${
          failed
            ? "bg-red-500/15 text-red-300 hover:bg-red-500/25"
            : hot
              ? "bg-amber-500/15 text-amber-300 hover:bg-amber-500/25"
              : "text-neutral-500 hover:bg-neutral-900 hover:text-neutral-300"
        }`}
      >
        最近变更
        <span
          data-changes-badge
          className={`rounded-full px-1.5 py-0.5 text-[10px] leading-none ${
            failed
              ? "bg-red-500 text-neutral-950"
              : hot
                ? "bg-amber-500 text-neutral-950"
                : "bg-neutral-800 text-neutral-500"
          }`}
        >
          {failed ? "!" : hot ? `${newCount} 条新` : "0"}
        </span>
      </button>
      {pageOpen && <ChangesPage project={project} onClose={() => setPageOpen(false)} />}
    </div>
  );
}
