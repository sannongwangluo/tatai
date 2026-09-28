// A3：dagre 顶层布局 + 边权重 → 粗细映射（DESIGN.md §4.6：顶层布局用 dagre，不自己发明算法；
// §4.3 第 3 招：边为聚合边，粗细表示权重）。纯函数、与 React 解耦，verify-a3 直接单测。
import dagre from "dagre";
// F2：布局只吃共用数据层的节点/边口径（类型走纯模块，前端不引服务端壳 render.ts）
import type { GraphEdge, GraphNode } from "../../arch/shared-graph";
import type { NodePosition } from "../../arch/layoutStore";

/** 自定义方块节点的固定尺寸（ArchNode 渲染口径，dagre 按此排布） */
export const NODE_WIDTH = 240;
export const NODE_HEIGHT = 116;
/** 文件节点尺寸（A4 下钻层：小方块，与模块方块视觉区分） */
export const FILE_NODE_WIDTH = 180;
export const FILE_NODE_HEIGHT = 64;

export interface LayoutedNode {
  id: string;
  x: number;
  y: number;
}

/**
 * dagre 自动分层布局：rankdir=LR（按边方向从左到右分层，§4.6）。
 * 输入渲染 JSON 的节点/边，输出各节点左上角坐标（React Flow position 口径）。
 * 节点可自带 width/height（文件节点用小尺寸），缺省按模块方块尺寸。
 */
export function layoutWithDagre(
  nodes: (Pick<GraphNode, "id"> & { width?: number; height?: number })[],
  edges: Pick<GraphEdge, "from" | "to">[],
): LayoutedNode[] {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "LR", nodesep: 36, ranksep: 120, marginx: 24, marginy: 24 });
  g.setDefaultEdgeLabel(() => ({}));
  const sizeOf = new Map(
    nodes.map((n) => [n.id, { w: n.width ?? NODE_WIDTH, h: n.height ?? NODE_HEIGHT }]),
  );
  for (const n of nodes) {
    const s = sizeOf.get(n.id)!;
    g.setNode(n.id, { width: s.w, height: s.h });
  }
  const ids = new Set(nodes.map((n) => n.id));
  for (const e of edges) {
    if (ids.has(e.from) && ids.has(e.to)) g.setEdge(e.from, e.to);
  }
  dagre.layout(g);
  return nodes.map((n) => {
    const p = g.node(n.id);
    const s = sizeOf.get(n.id)!;
    // dagre 给的是中心点，React Flow 要左上角
    return { id: n.id, x: p.x - s.w / 2, y: p.y - s.h / 2 };
  });
}

/**
 * A4 子树局部重排（DESIGN.md §4.6：展开子树时局部重排，不动全局）。
 * 只对展开的子级集合跑 dagre，再把整棵子树平移到父节点右下方锚点；
 * 全局已有节点坐标一律不碰（调用方只 merge 返回的子节点坐标）。
 * @param anchor 父节点左上角坐标
 * @param parentWidth 父节点宽度（子树排在它右侧，隔一段 ranksep）
 */
export function layoutSubtree(
  children: { id: string; kind: "dir" | "file" | "aggregate" }[],
  edges: Pick<GraphEdge, "from" | "to">[],
  anchor: { x: number; y: number },
  parentWidth: number = NODE_WIDTH,
): LayoutedNode[] {
  if (children.length === 0) return [];
  const sized = children.map((c) => ({
    id: c.id,
    width: c.kind === "file" ? FILE_NODE_WIDTH : NODE_WIDTH,
    height: c.kind === "file" ? FILE_NODE_HEIGHT : NODE_HEIGHT,
  }));
  // V09-21 R4（2026-09-27，非作者终审 F-B）：子级之间**零边**时改走网格——dagre LR 在零边上把
  // 40 个文件子级并成一根竖列（约 4000px 高），任何可读缩放下都收不进视口（展开钮被甩到
  // 视口外 y=-312）。网格（≤5 列、尺寸自适应单元格）把同一批子级压成紧凑块，可读缩放下整树可见。
  const laid =
    edges.length === 0 && children.length > 1
      ? gridLayout(sized, 36)
      : layoutWithDagre(sized, [...edges]);
  // 平移：子树最左边界贴到父节点右侧 +ranksep，子树垂直中心对齐父节点中心
  const minX = Math.min(...laid.map((p) => p.x));
  const minY = Math.min(...laid.map((p) => p.y));
  const maxY = Math.max(
    ...laid.map((p) => p.y + (children.find((c) => c.id === p.id)?.kind === "file" ? FILE_NODE_HEIGHT : NODE_HEIGHT)),
  );
  const targetX = anchor.x + parentWidth + 120;
  const targetCenterY = anchor.y + NODE_HEIGHT / 2;
  const dx = targetX - minX;
  const dy = targetCenterY - (minY + maxY) / 2;
  return laid.map((p) => ({ id: p.id, x: Math.round(p.x + dx), y: Math.round(p.y + dy) }));
}


/** 边权重 → strokeWidth 1–6 梯度（§4.3 第 3 招）：相对全图最大权重线性映射 */
export function weightToStrokeWidth(weight: number, maxWeight: number): number {
  if (maxWeight <= 1) return 1;
  const w = 1 + Math.round(5 * (Math.max(0, weight - 1) / (maxWeight - 1)));
  return Math.min(6, Math.max(1, w));
}

/** V06-06：增量布局合并的产物（验证脚本与渲染层读同一份） */
export interface IncrementalLayout {
  /** 合并后的坐标（已有节点原样保留，新节点局部安放） */
  positions: Record<string, NodePosition>;
  /** 本次沿用的已有坐标（**逐个字节不变**——这就是"布局增量更新不跳动"的证据口径） */
  kept: string[];
  /** 本次新落位的节点（锚在邻居旁边，不压已有节点） */
  placed: string[];
  /** 上一份坐标里有、这一份已消失的节点（不留坐标：免得它回来时"跳回旧位"） */
  dropped: string[];
}

/**
 * 网格排布（V06-06 的兜底）：节点之间**一条关系都没有**时用它——dagre 在零边上会把所有节点并到同一层，
 * 十几张卡叠成一根竖列，fitView 之后缩到看不清。网格是确定性的：列数 = ⌈√n⌉，且不超过 5 列。
 *
 * V09-21 R3（2026-09-27）：导出给 ArchCanvas 的 dagre 兜底坐标用——系统架构主视图（override 数据层）
 * 节点间 0 条边，dagre LR 把 29 个模块并成一行（约 8000px 跨度），fitView 缩到 0.05–0.13，
 * 节点只剩 12–30px 宽、人点不中（非作者终审 F-A 实测）。零边情形一律走网格。
 */
export function gridLayout(
  nodes: readonly (Pick<GraphNode, "id"> & { width?: number; height?: number })[],
  gap: number,
): LayoutedNode[] {
  const cols = Math.min(5, Math.max(1, Math.ceil(Math.sqrt(nodes.length))));
  // V09-21 R4：单元格尺寸随内容自适应（文件节点 180×64 不占用模块 240×116 的格子），
  // 主视图模块节点的读数不变（max 仍是 240×116）。
  const cellW = Math.max(...nodes.map((n) => n.width ?? NODE_WIDTH)) + gap;
  const cellH = Math.max(...nodes.map((n) => n.height ?? NODE_HEIGHT)) + gap;
  return nodes.map((n, i) => ({
    id: n.id,
    x: (i % cols) * cellW,
    y: Math.floor(i / cols) * cellH,
  }));
}

/**
 * V06-06：增量布局合并（DESIGN.md §3.3「增量更新保留已有位置，新节点局部安放」/ §4.4「刷新保留已有布局」）。
 *
 * 为什么需要它：dagre 是**全图重排**，源更新后哪怕只多一个节点，整张图的坐标都会重算——
 * 用户正看着的那一块会整个跳走。本函数把"新算的那份"与"上一份"合并：
 *   · 上一份里还在的节点 → **坐标原样保留**（kept）；
 *   · 这一份新出现的节点 → 落在它的邻居旁边（placed），并且纵向让开已占用的位置；
 *   · 上一份里有、这一份没有的 → 丢掉坐标（dropped），不留"幽灵位置"。
 *
 * **dagre 调用就落在本函数里**（`layoutWithDagre` 是全仓唯一的布局实现，见 `verify-f3` 的调用点
 * 唯一性断言）：三个主视图的概览画布只经这一条口排图，不在别处再包一层 dagre 调用点。
 * 纯函数、零 IO：输入相同必得相同输出。
 */
export function mergeIncrementalLayout(input: {
  prev: Readonly<Record<string, NodePosition>>;
  /** 这一份的节点集合（新出现的会被局部安放；已有节点只用来算"还在不在"） */
  nodes: readonly (Pick<GraphNode, "id"> & { width?: number; height?: number })[];
  /** 新节点找邻居用的边（缺省 = 找不到邻居，直接用 dagre 兜底坐标） */
  edges?: readonly Pick<GraphEdge, "from" | "to">[];
  /** 新节点相对邻居的横向偏移（父节点右侧空地，§4.6 的落位口径） */
  gap?: number;
}): IncrementalLayout {
  const edges = input.edges ?? [];
  // 没有任何关系时排成**网格**：dagre 在零边上会把所有节点并到同一层（一根竖列，十几张卡叠成
  // 一条线，fitView 后缩到看不清）。网格是确定性的（列数 = ⌈√n⌉ 且不超过 5），也便于阅读。
  const laidOut =
    edges.length === 0 && input.nodes.length > 1
      ? gridLayout(input.nodes, input.gap ?? 60)
      : layoutWithDagre([...input.nodes], [...edges]);
  const laid = new Map(laidOut.map((p) => [p.id, p]));
  const positions: Record<string, NodePosition> = {};
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const [id, p] of Object.entries(input.prev)) {
    if (!laid.has(id)) {
      dropped.push(id);
      continue;
    }
    positions[id] = { x: p.x, y: p.y };
    kept.push(id);
  }
  const neighborOf = new Map<string, string>();
  for (const e of edges) {
    if (!neighborOf.has(e.to)) neighborOf.set(e.to, e.from);
    if (!neighborOf.has(e.from)) neighborOf.set(e.from, e.to);
  }
  const gap = input.gap ?? 60;
  const occupied = new Set(Object.values(positions).map((p) => `${p.x},${p.y}`));
  const placed: string[] = [];
  for (const [id, p] of laid) {
    if (positions[id] !== undefined) continue;
    const anchorId = neighborOf.get(id);
    const anchor = anchorId === undefined ? undefined : positions[anchorId];
    let x = anchor === undefined ? p.x : anchor.x + NODE_WIDTH + gap;
    let y = anchor === undefined ? p.y : anchor.y;
    let guard = 0;
    while (occupied.has(`${x},${y}`) && guard < 64) {
      y += NODE_HEIGHT + 24;
      guard += 1;
    }
    positions[id] = { x, y };
    occupied.add(`${x},${y}`);
    placed.push(id);
  }
  return {
    positions,
    kept: kept.sort(),
    placed: placed.sort(),
    dropped: dropped.sort(),
  };
}
