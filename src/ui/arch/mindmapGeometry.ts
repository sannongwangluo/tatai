// 思维导图的几何护栏（纯函数：零 React、零 DOM 依赖、零 side effect）。
//
// 为什么要有这个文件（2026-10-08 修 translate(NaN,NaN)，§3.2／§3.3）：
//   markmap-view 的 `fit()` 用 `Math.min(boxW / layoutW * ratio, boxH / layoutH * ratio, maxScale)`
//   算缩放比并写进 d3-zoom 的 `zoom.transform`（最终落到主 `<g transform>`）。容器隐藏
//   （`display:none`）时 `getBoundingClientRect()` 是 0×0，而**可见树的布局盒**此时若在某个轴上
//   退化（单节点、链状：宽或高为 0），就出现 `0 / 0` → `Math.min(NaN, ...)` = NaN →
//   主 `<g>` 被写成 `translate(NaN,NaN) scale(NaN)`，浏览器控制台报
//   `<g> attribute transform: Expected number, "translate(NaN,NaN) scale(N…"`。
//   反过来，只要**容器当前可画**（宽高都 > 0 且有限），`boxW / 0` 是 ±Infinity，`Math.min`
//   一定取到有限的 `maxScale`，永不 NaN——所以判据只需"容器现在能不能画"。
//
// 这层判据是 `MindMapView` 调 `fit()` / `centerNode()` 前的**唯一前置条件**，也是验证脚本
// （`scripts/verify-mindmap-geometry.py`）读回真实 DOM 时对齐的口径：本文件是判据的单一出处，
// 视图层与验证脚本不各写一套。

/** 只关心宽高的盒（`DOMRect` / `getBoundingClientRect()` 的结果都结构化匹配它） */
export interface BoxLike {
  width: number;
  height: number;
}

/** 有限数判据：`NaN` / `±Infinity` 一律不算（markmap 的 `fit()` 在 `0/0` 上算出 NaN） */
export function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * 容器现在可画吗——**能否在它上面调 `fit()` / `centerNode()` 的唯一判据**。
 * 宽高都要是有限正数：隐藏态（0）、未布局（0）、异常读数（NaN/Infinity）都返回 false。
 * 返回 false 时调用方必须**跳过**拟合，不写任何 transform（保持上一次有效视图）。
 */
export function isDrawableBox(box: BoxLike | null | undefined): box is BoxLike {
  return !!box && isFiniteNumber(box.width) && isFiniteNumber(box.height) && box.width > 0 && box.height > 0;
}

/** markmap 的布局盒（`state.rect`）：四条边都要有限——任一条是 NaN 都会让 `fit()` 的
 *  `Math.min` 传播成 NaN。容器可画**还不够**：布局盒本身也可能被算成 NaN，故两者都要过。 */
export interface RectBounds {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export function isFiniteRect(rect: RectBounds | null | undefined): rect is RectBounds {
  return (
    !!rect &&
    isFiniteNumber(rect.x1) &&
    isFiniteNumber(rect.x2) &&
    isFiniteNumber(rect.y1) &&
    isFiniteNumber(rect.y2)
  );
}
