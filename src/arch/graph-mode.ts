// F1：图模式口径定版（DESIGN.md §3.2 三视图、§12.1 未决项 #6）。
// 裁定一句话：**数据流向图 = 同一份静态依赖数据的「方向取向」渲染，不引入运行时数据流**。
// 依据：塔台现有唯一的数据源是 tree-sitter 静态 import（A1 `parse.ts` / A4 `expand.ts`），
// 运行时数据流要靠执行期插桩，与模块方框图的数据源不是同一份——那样的"并存"就是两套数据，
// 直接违反 §3.2「三视图共享同一份邻居数据，节点集合相同，边集合按方向过滤/着色」。
// 本文件只有口径常量与纯口径函数：**零渲染代码、零 React**（F1 卡红线），
// 供 F2 共用数据层 / F3 数据流向渲染器 / N1 思维导图渲染器消费，三处不各立一套。

// ───────────────────── 三视图共用的硬约束（§3.2「同一份数据」的落点） ─────────────────────

/** 节点集合口径：所有模式共用同一份邻居数据产出的节点集合，任何模式不得自建节点集合。
 *  依据 §3.2「节点集合相同」；F2 DoD③ 的单测断言的就是这条（同一输入下两视图节点集合全等）。 */
export const NODE_SET_RULE = "one_shared_node_set_for_all_modes" as const;

/** 全量边集合的唯一来源：A1 `modules.json` / A4 expand 产出的 `{from, to, weight}` 聚合边。
 *  方向口径 from = 依赖方（import 方）、to = 被依赖方（被 import 方），与 `parse.ts` 的
 *  `moduleOf(rel) → moduleOf(target)` 一致。**依赖边模式**（MODULE_BOX / DATA_FLOW）只能从这份
 *  集合取子集（E_mode ⊆ E_ALL）；MIND_MAP 的 edgeRule 是 `hierarchy_parent_child`（§3.2 表格第三行
 *  画的是层级，不是依赖边），其边由同一份节点集合的路径包含关系推出，不在本集合内。 */
export const EDGE_SET_SOURCE = "arch_modules_json_aggregated_edges" as const;

/** 依赖边的方向口径（A1/A4 既有口径，本卡只登记不自创） */
export const DEP_EDGE_DIRECTION = "consumer_to_provider" as const;

/** 数据流向 = 依赖方向的反向：数据从被依赖的提供者流向依赖它的消费者 */
export const DATA_FLOW_DIRECTION = "provider_to_consumer" as const;

/** V09-21 R3（2026-09-27）：主视图「系统架构」（ArchCanvas 的 override 数据层）的独立布局记忆桶键。
 *  它不是 GRAPH_MODES 里的数据视图（没有自己的 selectGraph 选择集），但 §4.4 布局记忆按视图分键：
 *  若与技术详情共用 MODULE_BOX 桶，技术详情（78 节点）的坐标会套进主视图（29 节点）——正是 F4 分键
 *  要防的「跨视图共用一份坐标必然跳位」。放在本文件（同构常量模块）是因为布局记忆的服务端实现
 *  layoutStore.ts 引 node:fs，UI 不能引它。 */
export const PROJECT_ARCH_LAYOUT_KEY = "PROJECT_ARCH" as const;

/** 防爆炸（§4.3 四招：硬上限 / 分层懒加载 / 边聚合 / 扇出过滤）统一在**共用数据层施加一次**，
 *  早于模式过滤。依据：各模式各自截断的话，同一项目两图看到的边集合口径就不同，等于回到"两套数据"。
 *  附带口径：第 3、4 招按**依赖方向**判（入边 = 被 import 次数，公共工具节点就是这么找出来的），
 *  不随数据流向图的渲染方向翻转。 */
export const EXPLOSION_CONTROL_STAGE = "shared_layer_once_before_mode_filter" as const;

/** 权重 → 边粗细的唯一实现出处（§4.3 第 3 招）：F3 渲染时从该处取值，本文件只登记引用、不复制实现。
 *  不直接 import 的理由：`src/arch` 是被服务端消费的解析侧，把 React 侧的布局模块拖进来是反向依赖。 */
export const WEIGHT_TO_STROKE_SOURCE = "src/ui/arch/layout.ts#weightToStrokeWidth" as const;

/** 节点着色口径：两图都用 §4.2 模块四色（同一份 `progress.json` 状态），不因模式改节点色——
 *  §3.2 只允许"边"按方向过滤/着色。 */
export const NODE_COLOR_RULE = "module_status_four_colors" as const;

// ───────────────────────────────────── 模式定义 ─────────────────────────────────────

/** 图模式（§3.2 三视图）：键即各视图数据的模式名，界面 Tab 与数据层选择器都用它 */
export type GraphMode = "MODULE_BOX" | "DATA_FLOW" | "MIND_MAP";

/** 边集合打法：从共用全量边集合取子集的规则 */
export type EdgeRule = "all_shared_edges" | "directional_subset" | "hierarchy_parent_child";

/** 边箭头指向口径 */
export type EdgeDirection =
  | typeof DEP_EDGE_DIRECTION
  | typeof DATA_FLOW_DIRECTION
  | "parent_to_child";

/** 边着色口径 */
export type EdgeColoring = "neutral" | "upstream_flow_role" | "none";

export interface GraphModeSpec {
  /** 模式名（GRAPH_MODES 的键） */
  key: GraphMode;
  /** 界面显示名（§3.2 表格第一列原词） */
  label: string;
  /** 这个视图回答的问题（§3.2 表格第三列原句） */
  question: string;
  /** 边集合打法 */
  edgeRule: EdgeRule;
  /** 边箭头指向 */
  edgeDirection: EdgeDirection;
  /** 边着色口径 */
  edgeColoring: EdgeColoring;
  /** 权重 → 粗细映射出处；null = 该模式的边不表达权重 */
  weightScale: string | null;
}

/** 三视图口径表（F2 的数据层选择器、F3/N1 的渲染器都读这里，不各写一份） */
export const GRAPH_MODES: Readonly<Record<GraphMode, GraphModeSpec>> = {
  MODULE_BOX: {
    key: "MODULE_BOX",
    label: "模块方框图",
    question: "项目由哪些大模块组成，各是什么状态",
    // 全量依赖边原样画，不按方向过滤；边中性色，颜色留给节点四色状态（§4.2）
    edgeRule: "all_shared_edges",
    edgeDirection: DEP_EDGE_DIRECTION,
    edgeColoring: "neutral",
    weightScale: WEIGHT_TO_STROKE_SOURCE,
  },
  DATA_FLOW: {
    key: "DATA_FLOW",
    label: "数据流向图",
    question: "数据从哪来、到哪去、谁依赖谁",
    // 同一份全量边的方向子集（规则见 DATA_FLOW_EDGE_RULE），箭头翻转为数据流向并按流向角色着色
    edgeRule: "directional_subset",
    edgeDirection: DATA_FLOW_DIRECTION,
    edgeColoring: "upstream_flow_role",
    weightScale: WEIGHT_TO_STROKE_SOURCE,
  },
  MIND_MAP: {
    key: "MIND_MAP",
    label: "思维导图",
    question: "层级结构一览，适合快速总览与折叠",
    // §3.2 表格第三行：markmap 画的是层级，边 = 母子层级边（§3.3 可折叠树），
    // 不画依赖边，因此不参与依赖方向口径与方向着色（无新口径，口径即 §3.2 该行）
    edgeRule: "hierarchy_parent_child",
    edgeDirection: "parent_to_child",
    edgeColoring: "none",
    weightScale: null,
  },
};

// ──────────────────────── DATA_FLOW 的边过滤口径（§3.2 的"过滤"落点） ────────────────────────

/**
 * DATA_FLOW 的方向过滤口径。输入 E_ALL = 共用数据层给出的全量聚合依赖边（已过 §4.3 防爆炸），
 * 输出 E_FLOW ⊆ E_ALL：
 * 1) 自环剔除：`from === to` 不画（A1/A2 既有口径，此处为幂等兜底）；
 * 2) 互惠对归并：A→B 与 B→A 同时存在（两模块互相 import）时归并为一条，权重取两条之和、
 *    标 bidirectional —— 不画两条互相矛盾的箭头；"从哪来、到哪去"要的是单向流，互惠依赖是噪音；
 * 3) 方向翻转：保留边渲染时的方向取依赖方向的反向（提供者 → 消费者，见 DATA_FLOW_DIRECTION）；
 * 4) 结果仍以 E_ALL 的边键为限（F2 DoD③ 单测断言的"子集"就是这个含义），
 *    节点集合与 MODULE_BOX 完全相同（NODE_SET_RULE）。
 */
export const DATA_FLOW_EDGE_RULE = {
  /** 过滤步骤，照此顺序施加，顺序换不得：先归并再翻转，否则互惠对判定要用两次方向口径 */
  steps: ["drop_self_loop", "merge_mutual_pair", "reverse_direction"],
  /** 互惠对（双向 import）的权重口径：求和（仍是 §4.3 第 3 招"粗细表示权重"的同一条口径） */
  mutual_pair_weight: "sum",
  /** 互惠对标记：渲染器可据此画双向箭头，但不因此新增边 */
  mutual_pair_flag: "bidirectional",
  /** 与共用全量边集合的关系（F2/F3 单测断言用） */
  subset_of: EDGE_SET_SOURCE,
} as const;

// ──────────────────────── DATA_FLOW 的着色口径（§3.2 的"着色"落点） ────────────────────────

/** 流向角色：按依赖方向的度数判定（源→汇方向看数据流向图） */
export const FLOW_ROLES = ["source", "relay", "sink", "isolated"] as const;
export type FlowRole = (typeof FLOW_ROLES)[number];

/**
 * 流向角色判定（纯口径函数，非过滤器实现——F2 的数据层选择器调它）。
 * @param inDegree  被 import 次数（依赖方向入边数；多 = 被依赖得多 = 供数据给别人）
 * @param outDegree import 出去次数（依赖方向出边数；多 = 依赖别人多 = 消费数据）
 * 口径：source = 只被依赖（渲染图里只有出边，数据源头）；sink = 只依赖别人（只有入边，数据终点）；
 * relay = 既被依赖又依赖别人（中间层）；isolated = 两度皆 0（两图都保留它，节点集合相同）。
 */
export function flowRoleOf(inDegree: number, outDegree: number): FlowRole {
  if (inDegree > 0 && outDegree === 0) return "source";
  if (outDegree > 0 && inDegree === 0) return "sink";
  if (inDegree > 0 && outDegree > 0) return "relay";
  return "isolated";
}

/**
 * DATA_FLOW 的着色口径。只定"按什么着色"，不定具体色值（色值/类名是 F3 卡的事）。
 * 节点：仍走 §4.2 四色模块状态，与方框图同一份 `progress.json`，不因模式改色。
 */
export const DATA_FLOW_COLOR_RULE = {
  /** 边按上游（数据提供者）节点的流向角色着色 */
  edge_by: "upstream_flow_role",
  /** 上游为 source（纯提供者）的边 → 源头色 */
  source_edge: "flow_source",
  /** 上游为 relay（中间层）的边 → 中继色 */
  relay_edge: "flow_relay",
  /** 节点着色不变（§4.2 四色） */
  node_by: NODE_COLOR_RULE,
} as const;

/** 边着色角色：只认 source / relay 两种上游（sink 没有出边、isolated 不参与流），其余返回 null = 不着色 */
export function edgeColorRoleOf(upstreamRole: FlowRole): "flow_source" | "flow_relay" | null {
  if (upstreamRole === "source") return "flow_source";
  if (upstreamRole === "relay") return "flow_relay";
  return null;
}
