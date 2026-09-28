// V09-07（PLAN.md V09-07 ②，DESIGN.md §3.9 / 附录 E.8-1）：图页「自动失效重取」的判据纯函数。
//
// 前端两个图页（ProjectGraphView / ArchCanvas）各挂一个 4s 轮询，读
// `GET /api/projects/:id/live` 的 `task_last_seq`（v2 事件账本末序号；v1 兼容项目为 null）：
// 序号**前进** = 工作事件账本写入了新事实 → 调各自 `load()` 重取（无需手动刷新/切项目）。
//
// 判据收在这一份纯函数里（不掺 React/计时器），是为了让「什么算前进」可单测、两处不各写一套。

/**
 * 事件序号是否**前进**了。
 *
 * 三态 `known`：
 *   · `undefined` = **从未观察过**——调用方在挂载时立即跑一次 tick 登记基线（只登记不加载），
 *     之后每 4s 轮询；这样"挂载后、首个 4s 间隔前"落进来的事件也能被判定为前进
 *     （若把基线登记推迟到首个间隔 tick，那之前的事件会被当成基线吞掉——实测踩过）；
 *   · `null` = 上次观察到的是 null（v1 兼容项目 / 读不到序号）——现在读出**序号 ≥ 1**
 *     说明 v2 账本起跑（迁移期项目的**第一条** v2 事件也是事实推进，不能吞掉）；
 *   · 数字 = 上次观察到的序号——`current` 严格更大才算前进。
 * `current` 缺值（null/非数）= 这一侧读不到序号：没法判，一律不算前进（不引入误判）。
 */
export function hasAdvancedEvents(
  known: number | null | undefined,
  current: number | null | undefined,
): boolean {
  if (typeof current !== "number" || !Number.isFinite(current)) return false;
  if (known === undefined) return false;
  if (known === null) return current >= 1;
  if (!Number.isFinite(known)) return false;
  return current > known;
}

/** 轮询间隔（毫秒）：两处图页共用同一个数（E.8-1 只要求"无需手动刷新"，4s 是体验与负载的取舍点） */
export const GRAPH_PAGE_POLL_MS = 4000;
