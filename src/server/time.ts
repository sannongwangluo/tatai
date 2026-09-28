// 公共时间工具：本地时间 ISO 串，带时区偏移（与 DESIGN.md §2.3 示例口径一致，如 +08:00）。
// 从 registry.ts 抽出，供 progress/gate/tasks 等所有落盘时间戳复用，保证全仓口径一致。
export function nowIso(): string {
  return toIso(new Date());
}

/** 任意 Date → 本地时间 ISO 串（带时区偏移），与 nowIso 同一口径；文件 mtime/birthtime 等场景复用 */
export function toIso(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

// ── 时间串比较（V06-01 补修包 B：**带偏移的 ISO 串不能直接按字典序比**） ──
//
// 记录里的时间字段只有两类来源：
//   · **产品钟**——`nowIso()` / 事件 `received_at`，本机同一 `+08:00` 口径；
//   · **调用方给的时间**——事件 `occurred_at`、payload 里的 `observed_at`/`declared_at`/`started_at`，
//     原样落盘、偏移不受产品控制。
// 后者会让"字面钟点序"与"真实时刻序"不一致：`2026-09-20T09:00:00+08:00` 真实时刻**早于**
// `2026-09-20T02:00:00Z`（同一刻的两种写法只差表示），字典序却反过来。
// 因此凡按**发生时间**做的大小比较与排序一律走下面三个函数；按**服务端提交序号**（`seq`）重放
// 事件的地方不在这里，也不得被改成按时间排。

/** 时间串 → 毫秒；空值/缺失/解析不出来一律 `null`（口径同 live.ts / projects-summary.ts） */
export function parseIsoMs(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * 时间总序比较器（**升序**，配 `sort` 用）。
 *
 * · 两边都能解析：按**真实时刻**比——`2026-09-20T10:00:00Z` 与 `2026-09-20T18:00:00+08:00`
 *   是同一刻，比较结果为 0（判等/同刻并列）；
 * · 只有一边能解析：**能解析的排后面**。于是非法/缺失的时间串在升序里永远排在最前，
 *   `.sort(...).at(-1)`、"倒序取 `[0]`"这类"取最新"的写法**永远取不到**非法/缺失值；
 * · 两边都解析不出：一律 0（并列），由调用方的数组顺序（= 事件/提交顺序）决定先后，
 *   稳定且可复现（不声称其中哪条"更新"）。
 */
export function compareIsoTime(a: string | null | undefined, b: string | null | undefined): number {
  const ma = parseIsoMs(a);
  const mb = parseIsoMs(b);
  if (ma === null && mb === null) return 0;
  if (ma === null) return -1;
  if (mb === null) return 1;
  return ma - mb;
}

/**
 * 取"真实时刻最晚"的那一条（返回**原对象**，不改它的任何字段）。
 *
 * · 非法/缺失时间不参与比较（不因为存在坏串就把整组判成"最新"或"未知"）；
 * · 全都解析不出来 → `null`，由调用方按各自的保守分支处理（有的返回 `null` 字段、有的退回事实顺序）；
 * · 同刻并列（含同一瞬时的不同表示）取输入顺序里**更靠后**的那条——即事实/提交顺序里最后提交的一条，
 *   与"取最新"的既有实现（稳定排序取末位）行为一致。
 */
export function latestByTime<T>(
  items: readonly T[],
  atOf: (item: T) => string | null | undefined,
): T | null {
  let best: T | null = null;
  let bestMs: number | null = null;
  for (const item of items) {
    const ms = parseIsoMs(atOf(item));
    if (ms === null) continue;
    if (bestMs === null || ms >= bestMs) {
      best = item;
      bestMs = ms;
    }
  }
  return best;
}
