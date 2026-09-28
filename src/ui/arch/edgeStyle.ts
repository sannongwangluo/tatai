// F3：边视觉（色 / 粗细 / 双向）的唯一出处（DESIGN.md §4.3 第 3 招「边聚合，粗细表示权重」）。
// 口径不在本文件重定：色按 `GRAPH_MODES[mode].edgeColoring`、粗细按 `.weightScale` 判——
// F1 `graph-mode.ts` 只登记"按什么着色/粗细映射出处"，色值这一层是 F3 的事（`graph-mode.ts` 原话）。
// 纯函数零 React：F3 数据流向图与方框图共用同一份边视觉逻辑（不各写一套），verify-f3 直接单测。
import { GRAPH_MODES, type GraphMode } from "../../arch/graph-mode";
import type { SelectedEdge } from "../../arch/shared-graph";
import { weightToStrokeWidth } from "./layout";

/** 依赖边模式的中性色（MODULE_BOX 原样：颜色留给 §4.2 节点四色，边不着色） */
export const NEUTRAL_EDGE_COLOR = "#737373";

/** 数据流向图的边色（F1 `DATA_FLOW_COLOR_RULE` 只给角色名，色值在此落）：源头=天蓝，中继=紫 */
export const FLOW_EDGE_COLORS = {
  flow_source: "#38bdf8",
  flow_relay: "#c084fc",
} as const;

/** 互惠依赖（A↔B 互相 import，归并后标 bidirectional）的样式：虚线 + 双向箭头 */
export const BIDIRECTIONAL_DASH = "7 4";

/** 图例（DataFlowView 与 verify-f3 共用一份：界面说明与断言口径同源） */
export const FLOW_EDGE_LEGEND: {
  role: keyof typeof FLOW_EDGE_COLORS | null;
  label: string;
  hint: string;
  color: string;
}[] = [
  {
    role: "flow_source",
    label: "源头 → 消费者",
    hint: "上游只被依赖（纯数据提供者）",
    color: FLOW_EDGE_COLORS.flow_source,
  },
  {
    role: "flow_relay",
    label: "中继 → 消费者",
    hint: "上游既被依赖又依赖别人（中间层）",
    color: FLOW_EDGE_COLORS.flow_relay,
  },
  {
    role: null,
    label: "未着色边",
    hint: "上游是终点或孤立节点（不参与流向）",
    color: NEUTRAL_EDGE_COLOR,
  },
];

export interface EdgeVisual {
  /** 线色（箭头同色） */
  color: string;
  /** §4.3 第 3 招：粗细表示权重（1–6 档，`weightToStrokeWidth` 唯一实现） */
  strokeWidth: number;
  /** 互惠依赖归并边：虚线 + 双向箭头（不画两条互相矛盾的箭头） */
  bidirectional: boolean;
}

/** 边的视觉输入（`SelectedEdge` 天然满足；A4 子级边按同一份过滤后也是它） */
export type EdgeVisualInput = Pick<SelectedEdge, "weight" | "color_role" | "bidirectional">;

/**
 * 模式 + 一条边 → 视觉。两个依赖边模式（MODULE_BOX / DATA_FLOW）的唯一分叉点：
 * - 色：`edgeColoring === "upstream_flow_role"` 才按角色上色（无角色 = 中性色）；否则一律中性色；
 * - 粗细：`weightScale` 非 null（两个依赖边模式都是）就走 §4.3 第 3 招同一映射；
 * - 双向：只在 `edgeRule === "directional_subset"`（DATA_FLOW）下可能为真——MODULE_BOX 画全量边，
 *   互惠依赖本来就是两条独立边，不存在归并出来的双向边。
 */
export function edgeVisualOf(mode: GraphMode, edge: EdgeVisualInput, maxWeight: number): EdgeVisual {
  const spec = GRAPH_MODES[mode];
  const bidirectional = edge.bidirectional === true && spec.edgeRule === "directional_subset";
  return {
    color:
      spec.edgeColoring === "upstream_flow_role"
        ? (edge.color_role ? FLOW_EDGE_COLORS[edge.color_role] : NEUTRAL_EDGE_COLOR)
        : NEUTRAL_EDGE_COLOR,
    strokeWidth: spec.weightScale === null ? 1 : weightToStrokeWidth(edge.weight, maxWeight),
    bidirectional,
  };
}

/** 本次渲染用到的粗细档集合（DoD② 证据：粗细真的随权重变，不是恒 1），升序去重 */
export function usedStrokeWidths(
  mode: GraphMode,
  edges: EdgeVisualInput[],
  maxWeight: number,
): number[] {
  return [...new Set(edges.map((e) => edgeVisualOf(mode, e, maxWeight).strokeWidth))].sort(
    (a, b) => a - b,
  );
}
