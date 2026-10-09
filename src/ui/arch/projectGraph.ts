// V06-06：三个主视图（功能全景 / 系统架构 / 施工依赖）的**纯口径层**（PLAN.md V06-06，
// DESIGN.md §3.2–§3.3 / §4.2–§4.7）。零 React、零 IO：渲染层（`ProjectGraphView.tsx`）、
// 技术详情画布（`ArchCanvas.tsx` 的可选接线）与验证脚本（`scripts/verify-v06-06.ts`）
// 读同一份口径，不各写一套。
//
// 本文件回答五件事：
//   ① **三视图分工**（§3.2 表格三行）：各自取蓝图里的哪类节点/关系、回答什么问题；
//   ② **关系语义**（§3.2 末段 + §4.2）：设计接口/任务依赖/静态引用/模型推断**分别标识**，
//      依赖线（前置是否满足，可着完成色）与集成线（关系/集成证据，**绝不着完成色**）语义分开；
//   ③ **状态解释**（§4.2）：状态只来自 V06-09 的 `StatusProjection`（此处只读它的字段，
//      不重算规则）；能力这类服务端暂无投影对象的节点按**声明过的口径**汇总，且**永不汇总成绿**；
//   ④ **数量口径**（§3.3）：概览 5–15 个主要分组、不足 5 不补假节点、超量聚合并显示隐藏数量，
//      过滤后显示当前范围且**不许让人以为"全项目已完成"**；
//   ⑤ **四种说明分开**（§3.3 末段）：加载中 / 加载失败 / 无规划 / 无匹配 + 图正在更新 / 图已过期。
//
// 身份口径：一切按**稳定 ID**（`plan:cap:*` / `plan:mod:*` / `plan:task:*` / `plan:code:*`
// 与模块 id / 任务卡号），显示名只用于展示与搜索，**不参与任何查找**（§3.2「选择与关联通过稳定 ID」）。
import type {
  Blueprint,
  BlueprintCertainty,
  BlueprintEdgeKind,
  BlueprintNode,
  BlueprintNodeKind,
  BlueprintSourceRef,
} from "../../arch/blueprint";
import type { StatusProjection } from "../../server/work/statusProjection";
import {
  scopeMemberLedgerOf,
  worseDisplayStatus,
  type ScopeLedger,
  type ScopeReadout,
} from "../../arch/featureScope";
import { DISPLAY_STATUS_PALETTE, type DisplayStatusKey } from "./statusColor";

// V09-55：优先级序比较的唯一实现移入 `featureScope`（范围聚合层），此处转出供既有消费方使用，
// 保证主视图/技术三图/脚本读到的是同一份判据。
export { worseDisplayStatus } from "../../arch/featureScope";

/** 范围读数（上屏）：`ScopeReadout` 的别名，供读口/界面同一份类型 */
export type { ScopeReadout };

// ═══════════════════════════ ① 三视图分工（§3.2 表格三行） ═══════════════════════════

export type ProjectViewKind = "functional" | "architecture" | "construction";

/** `projection_kind`：三视图在各自主视图上的登记名（与视图键同名，避免两套叫法） */
export type ProjectionKind = ProjectViewKind;

export interface ProjectViewSpec {
  key: ProjectViewKind;
  projection_kind: ProjectionKind;
  /** 页签上的名字（§3.2 表第一列） */
  label: string;
  /** 本视图回答的问题（§3.2 表第二列，逐字） */
  question: string;
  /** 取蓝图里的哪些节点 kind（§3.2 表第三列的"节点与关系来源"落到我们的蓝图词汇）——**画布上成节点的 kind** */
  node_kinds: BlueprintNodeKind[];
  /**
   * 分组的**成员**取哪些 kind（`grouping` 那句话的落地）。
   * 与 `node_kinds` 分开：功能全景的画布节点是「能力」，但 `grouping` 写明「成员 = 关联的模块与任务」——
   * 拿 `node_kinds` 当成员过滤器会让成员恒空 ⇒ 每个能力恒判「未映射」（V08-02 B1 修的就是这处）。
   */
  member_kinds: BlueprintNodeKind[];
  /** 取蓝图里的哪些关系 kind */
  edge_kinds: BlueprintEdgeKind[];
  /** 分组口径一句话（概览的"主要分组"是什么） */
  grouping: string;
  /** 与技术详情的关系（此视图下钻时去哪儿看） */
  detail_hint: string;
}

/** 三视图声明（§3.2 表格三行；节点集合**允许不同**，但必须引用同一基线、稳定 ID 与状态事实） */
export const PROJECT_VIEWS: Record<ProjectViewKind, ProjectViewSpec> = {
  functional: {
    key: "functional",
    projection_kind: "functional",
    label: "功能全景",
    question: "项目能为人做什么，哪些能力已经验证",
    node_kinds: ["capability"],
    member_kinds: ["module", "task"],
    edge_kinds: ["design_interface", "task_design_ref"],
    grouping: "主要分组 = 设计书里的能力（level-2 章节），成员 = 关联的模块与任务",
    detail_hint: "成员明细看本视图展开；文件级实现看「技术详情」",
  },
  architecture: {
    key: "architecture",
    projection_kind: "architecture",
    label: "系统架构",
    question: "这些能力由哪些模块协作实现",
    node_kinds: ["module", "capability"],
    member_kinds: ["module"],
    edge_kinds: ["design_interface", "implementation_map"],
    grouping: "主要分组 = 能力；没有能力归属的模块各自成组",
    detail_hint: "实测代码映射由「技术详情」的方框图提供（同一份模块 id）",
  },
  construction: {
    key: "construction",
    projection_kind: "construction",
    label: "施工依赖",
    question: "当前变更有哪些工作，哪些先后依赖，哪里受阻",
    node_kinds: ["task"],
    member_kinds: [],
    // 施工依赖线（前置是否满足）+ 实现映射线（集成/关系证据）：两类线**语义分开着色**（§4.2），
    // 后者需要它的靶点也在画布上，故同时带上 `plan:code:*` 端点（标 endpoint，不算本视图主体）。
    edge_kinds: ["task_dependency", "implementation_map"],
    grouping: "不分组：这是有向依赖图，允许多个前置，**不强制转成母子树**（§3.3）",
    detail_hint: "任务的执行/质量/验收状态来自状态投影（V06-09）；技术详情看代码",
  },
};

/** 页签顺序（功能全景 → 系统架构 → 施工依赖） */
export const PROJECT_VIEW_KEYS: readonly ProjectViewKind[] = ["functional", "architecture", "construction"];

// ═══════════════════════════ ② 关系语义（§3.2 末段 / §4.2） ═══════════════════════════

export type EdgeSemantics = "dependency" | "integration" | "reference" | "inferred" | "static_reference";

export interface EdgeSemanticsSpec {
  semantics: EdgeSemantics;
  /** 图例上的名字 */
  label: string;
  /** 这条线表示什么（口径句，直接上屏） */
  means: string;
  /** 缺投影结论时的兜底色（依赖线有投影结论时取投影的状态色） */
  color: string;
  /** 虚线样式（null = 实线） */
  dash: string | null;
  /** 会不会着"完成色"：依赖线会（前置交付是否满足）；集成/引用/推断/静态引用**一律不会**（§4.2） */
  completion_colored: boolean;
}

/** 五种线语义的唯一出处（§3.2「关系有种类与来源：设计接口、任务依赖、静态引用、模型推断分别标识」） */
export const EDGE_SEMANTICS: Record<EdgeSemantics, EdgeSemanticsSpec> = {
  dependency: {
    semantics: "dependency",
    label: "施工依赖线",
    means: "只表示前置交付是否满足，**不代表数据链路已联通**（§4.2）；多前置允许，不转成母子树",
    // 有连线投影结论时按**状态色**画（前置已释放=绿、未释放=橙/灰…）；没结论时用中性虚线
    // （§4.2 表最后一行：未知/陈旧 = 中性虚线与文字）。这个灰**就是**六态里的"未知"色，
    // 与 statusColor 的 unknown 同值——不再另立一个色号，也不与数据流向图的角色色撞车。
    color: "#737373",
    dash: "4 3",
    completion_colored: true,
  },
  integration: {
    semantics: "integration",
    label: "集成/关系线",
    means: "只表示有关系或有集成证据（设计接口 / 实现映射）；**两个端点绿不代表连线绿**（§4.2）",
    color: "#c084fc",
    dash: "6 3",
    completion_colored: false,
  },
  reference: {
    semantics: "reference",
    label: "出处引用线",
    means: "任务的设计依据出处（施工卡「设计依据」指向章节），是追溯关系，不是执行关系",
    color: "#8b93a3",
    dash: "2 3",
    completion_colored: false,
  },
  inferred: {
    semantics: "inferred",
    label: "模型推断线",
    means: "模型整理推出来的关系：无出处/待核实（§4.1），不当作已确认架构",
    color: "#f472b6",
    dash: "3 3",
    completion_colored: false,
  },
  static_reference: {
    semantics: "static_reference",
    label: "静态引用线",
    means: "静态 import 聚合（代码依赖方向）：保持来源样式，**不着完成色**（§4.2）",
    color: "#737373",
    dash: null,
    completion_colored: false,
  },
};

/** 蓝图关系 kind → 线语义（一对一，登记在这里而不是散在渲染层） */
export const BLUEPRINT_EDGE_SEMANTICS: Readonly<Record<BlueprintEdgeKind, EdgeSemantics>> = {
  task_dependency: "dependency",
  design_interface: "integration",
  implementation_map: "integration",
  task_design_ref: "reference",
  model_inference: "inferred",
};

/** 未登记的关系 kind 一律按"推断"处理（宁可标成待核实，不冒充已确认关系） */
export const edgeSemanticsOf = (kind: string | null | undefined): EdgeSemantics =>
  (kind !== null && kind !== undefined && BLUEPRINT_EDGE_SEMANTICS[kind as BlueprintEdgeKind]) || "inferred";

/** 语义分组（验证脚本与图例都按这个顺序展示） */
export const EDGE_SEMANTICS_ORDER: readonly EdgeSemantics[] = [
  "dependency",
  "integration",
  "reference",
  "inferred",
  "static_reference",
];

// ═══════════════════════════ ③ 数量口径（§3.3 第一段） ═══════════════════════════

export const OVERVIEW_MIN = 5;
export const OVERVIEW_MAX = 15;

export interface OverviewCap<T> {
  /** 概览要展示的那些（≤ max 个） */
  shown: T[];
  /** 被聚合掉的个数（0 = 没超量） */
  hidden_count: number;
  /** 聚合节点（超量时才有；**必须把隐藏数量显示出来**） */
  aggregate: { label: string; count: number } | null;
  /** 口径说明（不足 5 / 在区间内 / 超量聚合，逐种一句） */
  note: string;
  /** **恒为 false**：不足 min 个不补假节点（§3.3「不足 5 个不凑数」） */
  padded: false;
}

/**
 * 概览数量口径（§3.3）：`> max` → 只显示前 max 个 + 一个「还有 N 个」聚合节点（显示数量）；
 * `< min` → 有几个显示几个，**不补假节点**；区间内 → 原样。
 * 顺序由调用方给（本函数只截断，不重排、不挑选语义）。
 *
 * V09-22：`opts.full === true`（「显示全部」）时**不截断**——概览的 5–15 聚合口径放开，一个不漏、
 * 无聚合节点；同一份数据源只换上限口径（§0 红线），采集侧完整性另见 budget 标注。
 * 默认路径（不带 full）逐字不变。
 */
export function capOverview<T>(
  items: readonly T[],
  opts: { unit: string; min?: number; max?: number; aggregateLabel?: (n: number) => string; full?: boolean },
): OverviewCap<T> {
  const min = opts.min ?? OVERVIEW_MIN;
  const max = opts.max ?? OVERVIEW_MAX;
  if (opts.full === true) {
    return {
      shown: [...items],
      hidden_count: 0,
      aggregate: null,
      note: `全量展示：共 ${items.length} 个${opts.unit}（概览 5–15 聚合口径已按「显示全部」放开，一个不漏；采集侧完整性另见 budget 标注）`,
      padded: false,
    };
  }
  if (items.length > max) {
    const hidden = items.length - max;
    return {
      shown: items.slice(0, max),
      hidden_count: hidden,
      aggregate: {
        label: (opts.aggregateLabel ?? ((n: number) => `还有 ${n} 个${opts.unit}未显示（已聚合）`))(hidden),
        count: hidden,
      },
      note: `超量聚合：概览只显示 ${max} 个${opts.unit}，另外 ${hidden} 个已聚合成一个节点并把数量显示出来（§3.3）`,
      padded: false,
    };
  }
  if (items.length < min) {
    return {
      shown: [...items],
      hidden_count: 0,
      aggregate: null,
      note: `只有 ${items.length} 个${opts.unit}：不足 ${min} 个**不补假节点**，有几个显示几个（§3.3）`,
      padded: false,
    };
  }
  return {
    shown: [...items],
    hidden_count: 0,
    aggregate: null,
    note: `共 ${items.length} 个${opts.unit}：落在概览区间 ${min}–${max} 内，不聚合（§3.3）`,
    padded: false,
  };
}

// ═══════════════════════════ ④ 状态解释（§4.2） ═══════════════════════════

/** 投影索引：对象稳定 ID → 投影（HTTP 读口的 `objects[]` 摊平） */
export type ProjectionIndex = Readonly<Record<string, StatusProjection>>;

export type NodeStatusKind = "direct" | "aggregated" | "unmapped";

/**
 * 不着完成色时的**真实原因**（V08-02 C1：原来一律显示「未映射」，三种原因被糊成一句）：
 *   · `no_status_source`      —— 本视图这个对象在服务端没有独立状态来源（能力/模块层）；
 *   · `object_unmapped`       —— 投影里有这个对象，但它自己没有任务/验收映射；
 *   · `no_members`            —— 汇总口径下没有任何关联成员；
 *   · `members_without_status`—— 有成员，但成员都没有状态投影结论；
 *   · `no_task_evidence`      —— 模块层按实现映射派生时，没有任何任务指向它（无状态记录）；
 *   · `endpoint`              —— 它只是别的视图关系的端点，不表示进度（§3.2/§4.2）。
 */
export type UnmappedReason =
  | "no_status_source"
  | "object_unmapped"
  | "no_members"
  | "members_without_status"
  | "no_task_evidence"
  | "endpoint";

export interface NodeStatus {
  kind: NodeStatusKind;
  /** 六态键；null = **不着完成色**（无映射/未知，§4.2「不空集判绿」） */
  display: DisplayStatusKey | null;
  /** 该对象自己的投影（direct 时为它本人；aggregated/unmapped 时可能是 null） */
  projection: StatusProjection | null;
  /** 汇总口径下的成员数（direct = 0，表示"不汇总，这就是它本人"） */
  member_count: number;
  /** 状态从哪来的口径句（**必须上屏**：让人分得清"服务端为该对象算的"与"本视图汇总的"） */
  basis: string;
  /** 不着完成色时的真实原因（`display !== null` 时为 undefined） */
  unmapped_reason?: UnmappedReason;
  /** 展示层短标签覆盖（V08-03 附录 D：模块「验证通过」的短标要点明"已存在"） */
  short?: string;
}

/** 直接把一个投影当作节点状态（模块/任务/连线；`mapping === "unmapped"` → 不着完成色） */
export function directStatusOf(p: StatusProjection | null | undefined): NodeStatus {
  if (p === null || p === undefined) {
    return {
      kind: "unmapped",
      display: null,
      projection: null,
      member_count: 0,
      basis:
        "本视图暂无状态来源：状态投影里没有这个对象——没有事实就不判状态（不空集判绿，§4.2）。" +
        "（能力/模块层由本视图按关联任务汇总；汇总不出结果时如实标「本视图暂无状态来源」，不写成「未开始」）",
      unmapped_reason: "no_status_source",
    };
  }
  if (p.mapping === "unmapped" || p.display_status === null) {
    return {
      kind: "unmapped",
      display: null,
      projection: p,
      member_count: 0,
      basis: `对象未映射：${p.reasons.find((r) => r.code === "unmapped")?.text ?? "没有任务或验收映射，不空集判绿"}（DESIGN.md §4.2）`,
      unmapped_reason: "object_unmapped",
    };
  }
  return {
    kind: "direct",
    display: p.display_status,
    projection: p,
    member_count: 0,
    basis: `状态由 V06-09 状态投影按任务/证据/有效性自动派生（对象 ${p.object_id}）`,
  };
}

/** 派生不出状态时的显式标记（V08-02 B2/B3/B4）：显示成「无状态记录」，**不写成「未开始」** */
export const NO_STATUS_RECORD = "no_status_record";

/**
 * **一个蓝图节点 id 的 v2 派生状态**（V08-06 抽成单源，供视图模型与技术详情画布共用）：
 *   · 模块（`plan:code:*` / `plan:mod:*`）→ 模块层派生（附录 D；没有派生结果就如实「无状态记录」）；
 *   · 其余（任务/概念等）→ 状态投影直取。
 * 技术详情画布拿技术模块 id（`src` 这种）时用 `moduleStatusKeyOf` 换算成蓝图 id。
 */
export function blueprintNodeStatusOf(
  nodeId: string,
  input: { blueprint: Blueprint; projection: ProjectionIndex; module_status?: Readonly<Record<string, NodeStatus>> },
): NodeStatus {
  const n = input.blueprint.nodes.find((x) => x.id === nodeId);
  if (n !== undefined && n.kind === "module") {
    return input.module_status?.[nodeId] ?? noStatusRecordOf(nodeId);
  }
  const objectId = objectIdOf(nodeId, n?.kind);
  return directStatusOf(objectId === null ? null : input.projection[objectId]);
}

/** 技术详情画布的技术模块 id（`src`）→ 蓝图节点 id（`plan:code:src`） */
export const planCodeNodeIdOf = (technicalId: string): string =>
  technicalId.startsWith("plan:") ? technicalId : `plan:code:${technicalId}`;

/**
 * 模块层状态的**两套键**（蓝图节点 id `plan:code:<模块 id>` / `plan:mod:<稳定 ID>` ＋技术模块 id `<模块 id>`）
 * → 上屏键（六态键 / `no_status_record` / `unmapped`）。
 *
 * V08-06 缺陷①的修法：技术详情画布与系统架构画布都从这里取，**plan 层节点不再只查 `by_object`**
 * （`by_object` 的键只有 `module:<代码模块 id>`，声明模块与能力节点在那里永远查不到）。
 * 2026-10-05 六图修复：**任务/能力的规划节点键也并入**（`plan_status`）——技术三图并入规划层后的
 * `plan:task:*` 节点由此拿到自己的投影状态（此前一律「无状态记录」，与主视图自相矛盾）。
 * 任务/能力节点 id 不剥前缀（`plan:task:T01a` 就是技术图上的节点 id 本身，没有第二套键）。
 */
export function moduleStatusKeysOf(
  derived: ReturnType<typeof taskDerivedModuleStatus>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [nodeId, st] of Object.entries(derived.status)) {
    const key = st.display ?? (st.unmapped_reason === "no_task_evidence" ? NO_STATUS_RECORD : "unmapped");
    out[nodeId] = key;
    if (nodeId.startsWith("plan:code:")) out[nodeId.slice("plan:code:".length)] = key;
  }
  for (const [objectId, st] of Object.entries(derived.by_object)) {
    if (out[objectId] === undefined) out[objectId] = st.display ?? NO_STATUS_RECORD;
    const techId = objectId.startsWith("module:") ? objectId.slice("module:".length) : null;
    if (techId !== null && out[techId] === undefined) out[techId] = st.display ?? NO_STATUS_RECORD;
  }
  for (const [nodeId, st] of Object.entries(derived.plan_status)) {
    if (out[nodeId] !== undefined) continue; // 模块键优先：同一 id 不会既是模块又是任务/能力（蓝图 id 空间不相交）
    // 与主视图 viewNodeEntries 同一判据（display ?? kind 判 unmapped），不再用模块键的 no_task_evidence 分支
    const key = st.display ?? (st.kind === "unmapped" ? "unmapped" : NO_STATUS_RECORD);
    out[nodeId] = key;
  }
  return out;
}

/** 模块「验证通过」的展示短标（V08-03 附录 D：让人一眼看懂"这东西存在且验证过了"） */
export const MODULE_VERIFIED_SHORT = "已存在·已验证通过";

// ── 画布节点状态解析顺序（F1 集成修正 2026-10-06；V09-55 统一后同一判据） ──
//
// `moduleStatusKeysOf` 会把 `plan:cap:*` 也并进通用键表，其值来自 `plan_status`（同一 `capabilityStatusOf`）。
// V09-55 之前：通用键表的能力聚合用声明成员、系统架构主画布按本视图成员，两套口径会让同一能力
// 在不同画布判出不同状态（诊断快照 plan:cap:08/09）。统一后成员账目与主状态都由
// `featureScope` 一处给出：**画布的能力分支与通用键表给同一结论**，解析顺序只是"谁来算"，
// 不再是"算哪一套"。故仍固定为：**能力节点先判**（走聚合层的结论），其余才走通用键表。
//
// 纯函数、零 React、零 IO：渲染层与验证脚本读同一份顺序，不各写一套（`ProjectGraphView` 调用它）。

export interface ArchStatusResolvers {
  /** 能力节点（`plan:cap:*`）按**本视图成员**派生的上屏键（在通用键表之前判） */
  capabilityStatusOf: (nodeId: string) => string;
  /** 其余节点的通用键表命中（`moduleStatusKeysOf` 等）；未命中返回 `undefined` */
  keysOf: (nodeId: string) => string | undefined;
  /** 键表都没有时按投影直取 / 如实「无状态记录」 */
  directStatusOf: (nodeId: string) => string;
}

/**
 * 单个视图画布的节点状态解析（**顺序即语义**）：能力节点先于通用键表判，保留本视图成员语义；
 * 其余节点才走通用键表、再退回投影直取。返回 `节点 id → 上屏键`。
 */
export function archStatusRecordOf(nodeIds: readonly string[], r: ArchStatusResolvers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const id of nodeIds) {
    if (id.startsWith("plan:cap:")) {
      out[id] = r.capabilityStatusOf(id);
      continue;
    }
    out[id] = r.keysOf(id) ?? r.directStatusOf(id);
  }
  return out;
}

// ── §3.2 能力分类：声明表状态与逐能力分类（R-1/B 类返工 2026-09-26） ──
//
// 判据**只此一处**（界面、HTTP、MCP 读口共用）：分类唯一来源是设计书「能力分类声明」表。
//   ① `capabilityClassTableStateOf`：declared（表完好）/ undeclared（没有表，§3.2 兼容口径）/
//      broken（**有表但损坏**：缺章/坏行/重复矛盾/章节对不上/多表）；
//   ② `capabilityClassOf`：能查到分类就返回它；表损坏且该章**没解析出分类** ⇒ `unknown`
//      （**不默认 functional**，否则治理章节会静默混进功能全景）；无表 ⇒ functional（兼容口径）。
// 旧蓝图没有 `table_state` 字段：按 `declared` 推断（declared=true ⇒ declared，否则 undeclared）。
export function capabilityClassTableStateOf(bp: Blueprint): "declared" | "undeclared" | "broken" {
  const cc = bp.capability_classes ?? null;
  if (cc === null) return "undeclared";
  if (cc.table_state === "declared" || cc.table_state === "undeclared" || cc.table_state === "broken") return cc.table_state;
  return cc.declared ? "declared" : "undeclared";
}

export function capabilityClassOf(bp: Blueprint, capabilityId: string): "functional" | "governance" | "unknown" {
  const cls = bp.capability_classes?.by_capability[capabilityId];
  if (cls !== undefined) return cls;
  return capabilityClassTableStateOf(bp) === "broken" ? "unknown" : "functional";
}

/** 模块成员账目：模块节点 id（`plan:code:*`）→ 映射到它的任务 id（实现映射边去重） */
function moduleMembersOf(blueprint: Blueprint): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const e of blueprint.edges) {
    if (e.kind !== "implementation_map") continue;
    // 附录 D：只有**已观测**（本卡按「声明真实路径 ∩ 代码模块」确定性派生出来的）边算成员；
    // 模型整理的线索边（declared/inferred/unverified）既不参与「验证通过」，也不进成员账目——
    // 判据只认可复算的路径事实，不给模型推断染绿的机会
    if (e.certainty !== "observed") continue;
    const taskId = objectIdOf(e.source, "task");
    if (taskId === null) continue; // 声明模块 → 代码模块这类边不算任务成员
    if (!e.target.startsWith("plan:code:")) continue;
    const list = map.get(e.target) ?? [];
    if (!list.includes(taskId)) list.push(taskId);
    map.set(e.target, list);
  }
  return map;
}

/** 一群对象里"已通过验证"的严格判据：全部 mapped 且全部 `verified`（空集不算过，附录 D） */
function allVerifiedOf(statuses: readonly (DisplayStatusKey | null)[]): boolean {
  return statuses.length > 0 && statuses.every((s) => s === "verified");
}

/** 代码模块状态：成员卡全部验证通过才算「模块验证通过」（附录 D），否则按 §4.2 取最高、不给绿 */
function moduleStatusFromTasks(
  moduleNodeId: string,
  taskIds: readonly string[],
  projection: ProjectionIndex,
): NodeStatus {
  if (taskIds.length === 0) return noStatusRecordOf(moduleNodeId);
  const list = taskIds.map((t) => projection[t] ?? null);
  const statuses = list.map((p) => (p !== null && p.mapping === "mapped" ? p.display_status : null));
  const shown = taskIds.slice(0, 3).join("、");
  const more = taskIds.length > 3 ? "…" : "";
  if (allVerifiedOf(statuses)) {
    return {
      kind: "aggregated",
      display: "verified",
      projection: null,
      member_count: taskIds.length,
      short: MODULE_VERIFIED_SHORT,
      basis:
        `模块验证通过（DESIGN.md 附录 D）：映射到它的 ${taskIds.length} 张卡（${shown}${more}）` +
        "display_status 全部＝「已验证通过」，且映射非空；模块在代码里存在（静态解析的代码模块）",
    };
  }
  const known = statuses.filter((s): s is DisplayStatusKey => s !== null);
  if (known.length === 0) {
    return {
      kind: "unmapped",
      display: null,
      projection: null,
      member_count: taskIds.length,
      basis: `成员都没有状态结论：映射到它的 ${taskIds.length} 张卡（${shown}${more}）都没有状态投影结论，不空集判绿（附录 D）`,
      unmapped_reason: "members_without_status",
    };
  }
  const worst = known.reduce(worseDisplayStatus);
  const green = known.filter((s) => s === "verified").length;
  return {
    kind: "aggregated",
    display: worst === "verified" ? "pending_verification" : worst,
    projection: null,
    member_count: taskIds.length,
    basis:
      `模块层按**实现映射**从 ${taskIds.length} 张卡汇总（${shown}${more}）：` +
      `§4.2 优先级序取最高（其中 ${green} 张「已验证通过」）——` +
      "**不是全部通过 ⇒ 模块不算验证通过、不给绿**（DESIGN.md 附录 D）",
  };
}

/**
 * 模块层状态派生（DESIGN.md 附录 D，替换 V08-02 的「一律封顶在结果待验证」）：
 *
 *   ① 代码模块（`plan:code:<模块 id>`）：映射到它的卡全部 `verified` 且映射非空 ⇒ **验证通过（绿）**；
 *      不是全部通过 ⇒ §4.2 优先级序取最高（不给绿）；没有任何卡映射 ⇒ 如实「无状态记录」。
 *   ② 声明模块（`plan:mod:<稳定 ID>`）：按**审定材料索引**（§4.5 对账的配对结论）对应到代码模块，
 *      对应模块全部验证通过 ⇒ 验证通过；有对应但没全通过 ⇒ 取最差、不给绿；**没有对应 ⇒ 无状态记录**
 *      （不硬凑：功能名形态的声明模块没有可判定的落点）。
 *   ③ 不发明任何事件类型、不写完成色到源；本派生只读蓝图与状态投影。
 *   ④（2026-10-05 六图修复；V09-55 统一）`plan_status` 补**非模块规划节点**的状态：任务
 *      （`plan:task:*`）按状态投影**直取**（与主视图 `nodeOf` 同一语义）；能力（`plan:cap:*`）按
 *      **唯一成员账目**（`featureScope.scopeMemberLedgerOf`：design_interface／task_design_ref ＋
 *      observed implementation_map 的实测派生）派生，成员状态＝任务直取/模块派生——与三个主视图
 *      逐 id 同一份成员与同一主状态（不再一个用声明成员、另一个再叠加派生）。
 *      动机：技术三图（模块方框图/数据流向图/思维导图）并入规划层后，`plan:task:*` 节点此前查不到
 *      任何模块键、一律落「无状态记录」——同一张卡在施工依赖图是 verified、到技术图变无记录，
 *      同一快照内自相矛盾（2026-10-05 现场核查 46/46 张卡复现）。本表让共用键口径
 *      （`moduleStatusKeysOf`）把任务/能力也覆盖掉；概念（`plan:concept:*`）没有状态对象，仍如实无记录。
 *
 * 出参：`status` 键＝模块**节点 id**（`plan:code:*` / `plan:mod:*`）；`by_object` 键＝模块**对象 id**
 * （`module:<代码模块 id>`，给共用数据层/详情卡用）；`tasks_by_module` 键与 `status` 同域；
 * `plan_status` 键＝任务/能力**节点 id**（`plan:task:*` / `plan:cap:*`，只有键域不同、判据同源）。
 */
export function taskDerivedModuleStatus(input: {
  blueprint: Blueprint;
  projection: ProjectionIndex;
  /** 声明模块稳定 ID → 代码模块 id（审定材料索引的配对；缺省 = 不做声明模块继承） */
  declared_links?: Readonly<Record<string, readonly string[]>>;
  /**
   * V09-55：**范围（能力）的 canonical 义务层投影**（`deriveObligations`/`projectStatuses` 的产物，
   * 键 = `plan:cap:*`）。给了才判能力状态；缺省/某范围缺键 ⇒ 如实「未知」，不退回本地汇总造绿。
   */
  scope_projection?: ProjectionIndex;
}): {
  status: Record<string, NodeStatus>;
  by_object: Record<string, NodeStatus>;
  tasks_by_module: Record<string, string[]>;
  plan_status: Record<string, NodeStatus>;
} {
  const members = moduleMembersOf(input.blueprint);
  const status: Record<string, NodeStatus> = {};
  const by_object: Record<string, NodeStatus> = {};
  const tasks_by_module: Record<string, string[]> = {};
  // ① 代码模块先算（声明模块要读它们的结果）
  for (const n of input.blueprint.nodes) {
    if (n.kind !== "module" || !n.id.startsWith("plan:code:")) continue;
    const taskIds = [...(members.get(n.id) ?? [])].sort();
    tasks_by_module[n.id] = taskIds;
    const st = moduleStatusFromTasks(n.id, taskIds, input.projection);
    status[n.id] = st;
    by_object[`module:${n.id.slice("plan:code:".length)}`] = st;
  }
  // ② 声明模块：按审定材料索引继承对应代码模块的状态
  for (const n of input.blueprint.nodes) {
    if (n.kind !== "module" || !n.id.startsWith("plan:mod:")) continue;
    const stableId = n.id.slice("plan:mod:".length);
    const codeIds = (input.declared_links?.[stableId] ?? []).filter((id) => by_object[`module:${id}`] !== undefined);
    const taskIds = [...new Set(codeIds.flatMap((id) => members.get(`plan:code:${id}`) ?? []))].sort();
    tasks_by_module[n.id] = taskIds;
    if (codeIds.length === 0) {
      status[n.id] = {
        kind: "unmapped",
        display: null,
        projection: null,
        member_count: 0,
        basis:
          "无状态记录：设计书声明的这个模块没有对应到任何代码模块（审定材料索引里没有配对，§4.5），" +
          "也没有任务通过实现映射指向它——**不写成「未开始」**，也不硬凑一个落点（附录 D）",
        unmapped_reason: "no_task_evidence",
      };
      continue;
    }
    const codeStatuses = codeIds.map((id) => by_object[`module:${id}`]);
    const displays = codeStatuses.map((s) => s.display);
    if (allVerifiedOf(displays)) {
      status[n.id] = {
        kind: "aggregated",
        display: "verified",
        projection: null,
        member_count: codeIds.length,
        short: MODULE_VERIFIED_SHORT,
        basis:
          `模块验证通过（附录 D）：审定材料索引对应代码模块 ${codeIds.join("、")} 全部验证通过` +
          `（共 ${taskIds.length} 张卡映射到它们）`,
      };
      continue;
    }
    const known = displays.filter((s): s is DisplayStatusKey => s !== null);
    if (known.length === 0) {
      status[n.id] = {
        kind: "unmapped",
        display: null,
        projection: null,
        member_count: codeIds.length,
        basis: `无状态记录：对应代码模块 ${codeIds.join("、")} 都没有任务映射结论，不空集判绿（附录 D）`,
        unmapped_reason: "no_task_evidence",
      };
      continue;
    }
    const worst = known.reduce(worseDisplayStatus);
    status[n.id] = {
      kind: "aggregated",
      display: worst === "verified" ? "pending_verification" : worst,
      projection: null,
      member_count: codeIds.length,
      basis:
        `声明模块按审定材料索引取对应代码模块 ${codeIds.join("、")} 的状态（§4.2 优先级序取最高）：` +
        `**不是全部验证通过 ⇒ 不给绿**（附录 D）`,
    };
  }
  // ④ 非模块规划节点（2026-10-05 六图修复）：任务直取投影；能力按成员派生。
  //    与主视图 `nodeOf` 的语义逐字对齐——同一稳定任务 id 在主视图与技术三图必须同一事实状态。
  const plan_status: Record<string, NodeStatus> = {};
  for (const n of input.blueprint.nodes) {
    if (n.kind === "task") {
      plan_status[n.id] = directStatusOf(input.projection[objectIdOf(n.id, "task") ?? ""]);
      continue;
    }
  }
  // V09-55 返工：能力状态**只读 canonical 义务层投影**（与三个主视图逐 id 同一判据），
  // 不再本地按成员汇总——失败集成由 canonical 给 blocked、缺输入给 unknown/missing，六图只作适配。
  for (const n of input.blueprint.nodes) {
    if (n.kind !== "capability") continue;
    plan_status[n.id] = canonicalScopeStatusOf(input.scope_projection?.[n.id]);
  }
  return { status, by_object, tasks_by_module, plan_status };
}

/** 没有任何任务指向的模块：如实标「无状态记录」（不是「未开始」，也不是「未映射到任务」的投影口径） */
export function noStatusRecordOf(moduleObjectId: string): NodeStatus {
  return {
    kind: "unmapped",
    display: null,
    projection: null,
    member_count: 0,
    basis:
      `无状态记录：没有任务通过**实现映射**指向这个模块（对象 ${moduleObjectId}），` +
      "设计书的模块清单里也没有与它对应的落点——不写成「未开始」；" +
      "模块级「验证通过」的判据见 DESIGN.md 附录 D",
    unmapped_reason: "no_task_evidence",
  };
}

/**
 * 能力（scope）节点的上屏状态：**只读 canonical 义务层投影**（V09-55 返工）。
 *
 * 判据**只有一处**——唯一义务层 `deriveObligations`／`projectStatuses`（§2.6「一个事实、一次派生」）。
 * 本函数把该范围的 canonical `StatusProjection` 原样读成 `NodeStatus`：**不判绿、不封顶、不合成**。
 * 失败集成 ⇒ canonical 给 `blocked`（不是橙封顶）；缺必需输入 ⇒ canonical 给 `unknown/missing`。
 *
 * `p` 为 `null`/`undefined`（本读口没拿到该范围的 canonical 投影：旧客户端 / 尚未接入）⇒ 如实标
 * **未知**（`no_status_source`），**绝不退回本地按成员汇总造绿**（B5 复审口径：unsupported/unknown）。
 */
export function canonicalScopeStatusOf(p: StatusProjection | null | undefined): NodeStatus {
  if (p === null || p === undefined) {
    return {
      kind: "unmapped",
      display: null,
      projection: null,
      member_count: 0,
      basis:
        "本读口没有该范围的 canonical 义务层投影（deriveObligations/projectStatuses）：按**未知**处理——" +
        "不退回本地按成员汇总造绿（§2.6「一个事实、一次派生」；unsupported/unknown）",
      unmapped_reason: "no_status_source",
    };
  }
  return directStatusOf(p);
}

/** 范围读数（canonical 投影 → 上屏口径）适配：委托 `featureScope.scopeReadoutOf`（唯一适配实现） */
export { scopeReadoutOf } from "../../arch/featureScope";

// ═══════════════════════════ ⑤ 节点/边的视图模型 ═══════════════════════════

export interface ViewNode {
  /** 稳定 ID（蓝图节点 id / 模块 id；同名不换身份的依据） */
  id: string;
  label: string;
  kind: BlueprintNodeKind | "aggregate";
  /** 概览分组键（分组节点即自己的 id；成员节点 = 所属分组） */
  group_key: string | null;
  /** 折叠态节点代表的成员（空 = 叶子/本体节点） */
  members: string[];
  /** 被上限聚合掉、本节点不再逐条列出的成员数（>0 时显示数量） */
  hidden_members: number;
  status: NodeStatus;
  sources: BlueprintSourceRef[];
  /** 技术详情里的对应 id（`plan:code:<模块 id>` → 模块 id；对不上 = null，如实说"无对应"） */
  technical_id: string | null;
  /** 聚合节点标记（"还有 N 个"这类节点不可选、不可展开） */
  aggregate?: true;
  /**
   * 本视图的**关系端点**节点（不是本视图的主体）：它只是为了让某条线的两端都画出来
   * （例如施工依赖视图里的集成线端点 = 实测模块）。计数口径上不算进"主要对象"，
   * 也不会被概览上限截断（截掉端点会让线变成悬空线）。
   */
  endpoint?: true;
  /** 关系的语义（端点节点带上它，说明它是"因为哪类线才出现在这里"） */
  via_semantics?: EdgeSemantics;
  /** 能力分类（能力分组节点带上：functional=功能能力；governance=设计/治理章节；
   *  unknown=声明表损坏、该章分类**未定**（不默认按功能能力，§3.2／R-1 返工）；§3.2 能力分类声明） */
  capability_class?: "functional" | "governance" | "unknown" | null;
  /** 成员 → 它的**全部**归属分组（多值账目；共享模块所属的全部分组都可查，§3.2／2026-09-26 GPT-6 裁定 6） */
  member_groups?: Record<string, string[]>;
}

export interface ViewEdge {
  id: string;
  from: string;
  to: string;
  kind: BlueprintEdgeKind;
  certainty: BlueprintCertainty;
  semantics: EdgeSemantics;
  sources: BlueprintSourceRef[];
  /** 依赖线：投影给出的连线状态（`<前置>-><依赖方>` 对象）；其他语义恒 null（不着完成色） */
  status: DisplayStatusKey | null;
  status_projection: StatusProjection | null;
  /** 边上的一句话（依赖线 = 前置释放结论；集成线 = 语义说明） */
  note: string;
  /**
   * V09-13：**同组关系**（两端解析到同一个分组节点，如能力与其下属模块之间的设计接口关系）
   * 所在的分组节点 id；非空 ⇒ 本条只出现在 `ProjectViewModel.intra_relations` 里
   * （不画连线、不画自环），由分组节点上的关系条目逐条列出并可点开追来源（§3.2 同组关系可见性）。
   */
  group_key?: string;
}

/**
 * 本视图关系里**端点解析不到任何可见分组**的成因（V09-02 的账目恒等式：一条关系要么有归类、要么被
 * 逐条点名，**不许静默消失**）。判「是不是缺陷」由消费方按成因分——**前两类是本视图口径本身的合理结果，
 * 后两类是真实缺口**，不混成一句「落空」：
 *   · `folded_group`        —— 端点所属分组被概览折叠（点「显示全部分组」/展开后可见，§3.3 合理折叠）；
 *   · `governance_excluded` —— 端点是按能力分类排除的设计/治理章节（功能全景不作能力节点，§3.2 声明表）；
 *   · `no_ownership`        —— 端点在蓝图里没有能力归属（无归属边 ⇒ 待归属，§4.5，须核对后补登证据）；
 *   · `missing_node`        —— 端点不在蓝图节点集里（来源账与画布不一致，须核对）。
 */
export type UnresolvedEndpointReason = "folded_group" | "governance_excluded" | "no_ownership" | "missing_node";

/** 一条解析不到可见分组的关系（逐条点名：稳定 ID、落空的那一端、成因与蓝图出处） */
export interface UnresolvedRelation {
  /** 稳定关系 ID（`<source>><target>:<kind>`，与 `edges`／`intra_relations` 同一命名口径） */
  id: string;
  kind: BlueprintEdgeKind;
  certainty: BlueprintCertainty;
  source: string;
  target: string;
  /** 落空的那一端 */
  unresolved_end: "source" | "target";
  /** 落空端点的稳定 ID */
  missing_id: string;
  reason: UnresolvedEndpointReason;
  /** 这条关系在蓝图里的出处（逐条可追，§4.1；**不发明关系、不给无来源的线**） */
  sources: BlueprintSourceRef[];
}

export interface ProjectViewModel {
  view: ProjectViewKind;
  spec: ProjectViewSpec;
  /** 本视图的节点（分组节点 + 未被分组的本体节点；施工依赖视图里就是任务节点本身） */
  nodes: ViewNode[];
  edges: ViewEdge[];
  /**
   * V09-13（§3.2 同组关系可见性）：两端解析到**同一个分组节点**的本视图关系。
   * 它们**不画连线**（画出来只会是自环，§3.3／V09-02 的反例口径不变），而是**逐条列在分组节点上**
   * （`group_key` 指分组节点 id、`id` 是关系稳定 ID），点开即可追到出处——
   * 判据与追溯行见 `provenance.ts#intraGroupRelationsOf`／`traceLinesOf`。
   * 反例（不合格）：只在本视图口径句里写一句"有 N 条"而不给逐条可见可点的条目。
   */
  intra_relations: ViewEdge[];
  /**
   * V09-02 账目恒等式（**一条关系要么有归类、要么被点名，不许静默丢失**）：本视图声明的关系里，
   * 端点解析不到任何可见分组的那些。它们既不在 `edges` 也不在 `intra_relations`——**必须在这里逐条在场**，
   * 并按成因区分「合理折叠／分类排除」与「真实待归属／缺节点」（`UnresolvedEndpointReason`）。
   */
  unresolved_relations: UnresolvedRelation[];
  overview: OverviewCap<ViewNode>;
  /** 概览聚合节点（超量时追加的一个节点；null = 没超量） */
  aggregate_node: ViewNode | null;
  /** 分组的原始账目（展开某个分组时用；不受概览截断影响） */
  groups: { key: string; label: string; members: string[] }[];
  /** 口径说明（视图口径 + 数量口径，逐条上屏） */
  notes: string[];
}

/** 蓝图节点 id → 技术详情（共用层画布）里的 id：对不上就如实返回 null，不猜 */
export function technicalIdOf(
  nodeId: string,
  mergedNodes: readonly { id: string; plan_refs?: string[] }[] = [],
): string | null {
  if (mergedNodes.some((n) => n.id === nodeId)) return nodeId;
  const hit = mergedNodes.find((n) => (n.plan_refs ?? []).includes(nodeId));
  if (hit !== undefined) return hit.id;
  if (nodeId.startsWith("plan:code:")) return nodeId.slice("plan:code:".length);
  return null;
}

/** 蓝图节点 id → 状态投影的对象 id（任务 = 卡号本人；`plan:code:<模块 id>` = `module:<模块 id>`；
 *  声明模块（`plan:mod:*`）没有对象 id——如实返回 null，靠成员汇总，不硬猜一个 id 出来） */
export function objectIdOf(planNodeId: string, kind?: BlueprintNodeKind): string | null {
  if (planNodeId.startsWith("plan:code:")) return `module:${planNodeId.slice("plan:code:".length)}`;
  if (planNodeId.startsWith("plan:mod:")) return null;
  if (planNodeId.startsWith("plan:")) return kind === "task" ? planNodeId.slice("plan:task:".length) : null;
  return planNodeId;
}

/**
 * 按视图选择出模型（纯函数）。
 *
 * 三视图都从**同一份蓝图**取节点/关系（§3.2：同一基线、稳定 ID、同一状态事实），
 * 差别只在取哪类节点、哪类关系。功能全景与系统架构按能力**分组**（概览 5–15 个主要分组），
 * 施工依赖**不分组**（有向依赖图，可多前置，§3.3）。
 */
export function buildViewModel(input: {
  view: ProjectViewKind;
  blueprint: Blueprint;
  projection: ProjectionIndex;
  /** 技术详情画布的节点（用于算 technical_id；不给 = 只有 `plan:code:` 能对上） */
  mergedNodes?: readonly { id: string; plan_refs?: string[] }[];
  /** V08-03（附录 D）：模块层派生结果（`taskDerivedModuleStatus`）。不给 = 模块节点按投影直取（旧行为） */
  module_status?: Readonly<Record<string, NodeStatus>>;
  /**
   * V09-55 返工：**范围（能力）的 canonical 义务层投影**（`deriveObligations`/`projectStatuses` 的产物，
   * 键 = `plan:cap:*`）。能力节点上屏状态**只读它**；缺键 ⇒ 如实「未知」，不退回本地汇总造绿。
   */
  scope_projection?: ProjectionIndex;
  /** V09-22「显示全部」：概览上限放开——分组/任务节点一个不漏、无聚合节点（aggregate_node 恒 null）。
   *  缺省 false = 概览默认口径逐字不变。 */
  overview_full?: boolean;
}): ProjectViewModel {
  const spec = PROJECT_VIEWS[input.view];
  const bp = input.blueprint;
  const projectionOf = (objectId: string): StatusProjection | null => input.projection[objectId] ?? null;
  const byId = new Map(bp.nodes.map((n) => [n.id, n]));
  const capabilityIds = new Set(bp.nodes.filter((n) => n.kind === "capability").map((n) => n.id));
  // §3.2 能力分类（2026-09-26 GPT-6 裁定 7）：分类唯一来源＝设计书「能力分类声明」表（蓝图派生带入）；
  // 未声明 ⇒ 全部按功能能力处理并在口径句注明「能力分类未声明」（代码不硬编码任何项目的章节号）。
  // R-1/B 类返工（2026-09-26 非作者复审）：表**损坏**（缺章/坏行/重复/对不上）时该章分类**未定**，
  // 不默认按功能能力处理（判据与文案都在 `capabilityClassTableStateOf`／`capabilityClassOf`，只此一处）。
  const classState = capabilityClassTableStateOf(bp);
  const classDeclared = classState === "declared";
  const classBroken = classState === "broken";
  const classIssues = (bp.capability_classes?.issues ?? []).map((i) => `§${i.chapter ?? "—"} ${i.kind}`).join("、");
  const capClassOf = (id: string): "functional" | "governance" | "unknown" => capabilityClassOf(bp, id);
  // 成员账目（**视图无关**，V09-55）：旧实现把「能力 ← task_design_ref ← 任务 → implementation_map
  // (observed) → 代码模块」的二级派生**只放在系统架构分支**里，于是同一能力在功能全景/技术三图按
  // 声明成员算、到系统架构按「声明＋派生」算，成员集合不同 ⇒ 同一事实判出不同主状态（诊断快照
  // plan:cap:08/09 功能图全绿 vs 架构图橙、跨项目 cap:11 blocked vs unmapped）。现在成员枚举唯一
  // 来源是 `featureScope.scopeMemberLedgerOf`，三个主视图与三张技术详情图逐 id 读同一份。
  // **主状态不由成员汇总**（V09-55 返工）：只读 canonical `scope_projection`，见 `canonicalScopeStatusOf`。
  // 多值归属（一个成员可同属多个能力）保持不变：真实蓝图有 32 张卡的设计依据指向 ≥2 个能力。
  const scopeLedger: Record<string, ScopeLedger> = scopeMemberLedgerOf(bp);
  const ownersOfMember = new Map<string, string[]>();
  const addOwner = (member: string, cap: string): void => {
    const list = ownersOfMember.get(member) ?? [];
    if (!list.includes(cap)) list.push(cap);
    ownersOfMember.set(member, list);
  };
  let derivedMemberships = 0;
  for (const [cap, l] of Object.entries(scopeLedger)) {
    for (const m of l.members) {
      if (m.via.includes("implementation_map")) derivedMemberships += 1;
      addOwner(m.id, cap);
    }
  }
  /** 成员的全部归属（多值账目：分组/成员资格以它为准） */
  const ownersOf = (id: string): readonly string[] => ownersOfMember.get(id) ?? [];
  /** 还需要单值语义的地方（连线端点解析、节点 group_key）取**确定性的第一归属**（稳定 id 升序） */
  const memberToOwner = (id: string): string | null => {
    const list = ownersOfMember.get(id);
    if (list !== undefined && list.length > 0) return [...list].sort()[0];
    return capabilityIds.has(id) ? id : null;
  };

  const nodeOf = (n: BlueprintNode, members: string[], hidden: number): ViewNode => {
    const objectId = objectIdOf(n.id, n.kind);
    // 能力不另设验证对象（附录 D）：由**本视图的成员**派生——成员全绿才绿，成员里有无状态记录就不给绿
    // 模块：按附录 D 的派生给状态（`module_status`），没有派生结果时如实「无状态记录」
    let status =
      n.kind === "capability"
        ? canonicalScopeStatusOf(input.scope_projection?.[n.id])
        : n.kind === "module"
          ? (input.module_status?.[n.id] ?? noStatusRecordOf(n.id))
          : directStatusOf(objectId === null ? null : projectionOf(objectId));
    // §3.2 能力分类（2026-09-26 GPT-6 裁定 7）：设计/治理章节的能力分组**不是产品功能能力**——
    // 状态文案必须带限定，不得读作「已验证能力」；成员与出处的可追溯性不受影响。
    if (n.kind === "capability" && capClassOf(n.id) === "governance") {
      status = {
        ...status,
        basis: `${status.basis}；本分组是**设计/治理章节，非产品功能能力**（§3.2 能力分类声明）——不计入产品能力计数、不以「已验证能力」显示`,
      };
    }
    return {
      id: n.id,
      label: n.name,
      kind: n.kind,
      group_key: input.view === "construction" ? null : memberToOwner(n.id),
      members,
      hidden_members: hidden,
      status,
      sources: n.source_refs,
      technical_id: technicalIdOf(n.id, input.mergedNodes ?? []),
      capability_class: n.kind === "capability" ? capClassOf(n.id) : null,
    };
  };

  const nodes: ViewNode[] = [];
  const groups: { key: string; label: string; members: string[] }[] = [];
  let edges: ViewEdge[] = [];
  /**
   * V09-02：**成员 id → 本视图上代表它的那个分组节点 id**。
   * 分组节点的 id 与成员 id 不同名（未归属模块是 `ungrouped:plan:code:src` 而成员是 `plan:code:src`；
   * 已归属模块的分组节点 id 是所属能力 id，不是模块 id），所以只拿成员 id 去 `visible` 里找必然落空 ⇒
   * `implementation_map` / `design_interface` 的线一条也解析不出来（附录 E.5 登记的 `edges=0`）。
   * 只登记**概览实际画出的**分组（被折叠的分组不进表）：指向被折叠分组的线照旧画不出来，不假装画得出来（§3.3）。
   */
  const memberGroupNodeId = new Map<string, string>();
  /** 概览口径统计的对象（功能/架构 = 分组；施工依赖 = 任务节点）；截断前的那份 */
  let overview: OverviewCap<ViewNode>;
  /** 功能全景按 §3.2 能力分类排除的设计/治理章节（施工依赖/系统架构不排除；口径句要用） */
  const governanceExcluded: { id: string; name: string }[] = [];

  if (input.view === "construction") {
    // 施工依赖：任务节点本身（不分组、不转成母子树）
    for (const n of bp.nodes.filter((n) => n.kind === "task")) nodes.push(nodeOf(n, [], 0));
    // 集成/关系线的端点：任务「文件责任 ∩ 实测模块」的**实现映射**靶点。
    // 它们不是本视图的主体，只是让集成线两端都画得出来（§3.2：集成线要自己的证据，
    // 不能拿两个端点的完成色冒充）；因此标 endpoint 且不被概览上限截断。
    const taskIds = new Set(bp.nodes.filter((n) => n.kind === "task").map((n) => n.id));
    const endpointIds = new Set<string>();
    for (const e of bp.edges) {
      if (e.kind === "implementation_map" && taskIds.has(e.source)) endpointIds.add(e.target);
    }
    for (const id of [...endpointIds].sort()) {
      const n = byId.get(id);
      if (n === undefined) continue;
      const base = nodeOf(n, [], 0);
      nodes.push({
        ...base,
        endpoint: true,
        // C2：端点节点不着进度色，也不给人"它自己有进度"的错觉——口径句写清"不表示进度"
        status: {
          ...base.status,
          display: null,
          short: undefined,
          basis: `${base.status.basis}；本节点只是集成/关系线在本视图的端点，**不表示进度**（§3.2/§4.2）`,
          unmapped_reason: "endpoint" as const,
        },
        via_semantics: "integration",
        label: `${base.label}（集成端点·不表示进度）`,
      });
    }
    overview = capOverview(nodes.filter((n) => n.endpoint !== true), {
      unit: "任务节点",
      full: input.overview_full === true,
    });
  } else {
    const memberKindSet = new Set(spec.member_kinds);
    const members = bp.nodes.filter((n) => memberKindSet.has(n.kind) && n.kind !== "capability");
    /** 能力的**唯一成员账目**（`scopeLedger`）转成查表集合：成员资格的**来源**只有它一处（V09-55） */
    const ledgerMemberIds = new Map<string, ReadonlySet<string>>();
    for (const [capId, l] of Object.entries(scopeLedger)) ledgerMemberIds.set(capId, new Set(l.member_ids));
    // 「未归属能力」的分组只给**本视图画布上首层可见的非能力 kind**（架构 = 模块）——
    // 功能全景的成员含任务，但没人会因为"任务没挂能力"就多出一个功能分组（那会把功能全景的节点集搅乱）。
    const ungroupedKinds = new Set<BlueprintNodeKind>(spec.node_kinds.filter((k) => k !== "capability"));
    // 组：能力本身 + 没有能力归属的模块各自成组（成员资格按**多值**归属账：一个成员可同属多个能力分组）
    // §3.2 能力分类（2026-09-26 GPT-6 裁定 7）：功能全景只含**功能能力**分组——设计/治理章节不是产品
    // 功能能力，不在本视图作为能力节点、不计入能力计数（其任务与模块关联见系统架构/施工依赖/技术详情）。
    for (const cap of bp.nodes.filter((n) => n.kind === "capability")) {
      if (input.view === "functional" && capClassOf(cap.id) === "governance") {
        governanceExcluded.push({ id: cap.id, name: cap.name });
        continue;
      }
      // V09-55 修的是成员资格的**来源**（唯一成员账目 `scopeLedger`：不再"一个视图只算声明成员、另一个再叠加
      // 二级派生"）；**成员 kind 仍由本视图口径定**（`spec.member_kinds`，§3.2 表格第三列）——
      // 功能全景 = 模块＋任务（"关联验收证据、模块与任务"），系统架构 = 模块（"这些能力由哪些模块协作实现"；
      // 任务归施工依赖视图）。成员还必须是**蓝图节点**：非节点成员画不出来也点不开，按
      // §3.3「聚合不得吃掉可达性」另行逐条点名（`unresolved_relations`／`canvasMembershipGapsOf`），
      // 不当成"已经在分组里"（否则 P11 的存在性判据会被名单本身顶掉）。
      // 顺序＝蓝图节点顺序（既有口径：显示稳定、不随 id 排序漂移）。
      const inLedger = ledgerMemberIds.get(cap.id) ?? new Set<string>();
      const own = members.filter((m) => inLedger.has(m.id)).map((m) => m.id);
      groups.push({ key: cap.id, label: cap.name, members: own });
    }
    for (const m of members) {
      if (!ungroupedKinds.has(m.kind)) continue;
      if (ownersOf(m.id).length > 0) continue;
      groups.push({ key: `ungrouped:${m.id}`, label: `${m.name}（未归属能力）`, members: [m.id] });
    }
    // 概览优先显示 5–15 个主要分组：先按成员数降序（同数按稳定 id 升序，结果确定），再截断
    const ordered = [...groups].sort(
      (a, b) => b.members.length - a.members.length || a.key.localeCompare(b.key),
    );
    const allGroupNodes: ViewNode[] = [];
    for (const g of ordered) {
      const self = byId.get(g.key);
      const base = self ?? bp.nodes.find((n) => n.id === g.members[0]);
      if (base === undefined) continue;
      const node = nodeOf(base, g.members, 0);
      // 共享模块（多归属成员）所属的**全部分组**都可查（§3.2／2026-09-26 GPT-6 裁定 6）
      const memberGroups: Record<string, string[]> = {};
      for (const m of g.members) memberGroups[m] = [...ownersOf(m)].sort();
      allGroupNodes.push({ ...node, id: g.key, label: g.label, group_key: g.key, members: g.members, member_groups: memberGroups });
    }
    overview = capOverview(allGroupNodes, { unit: "分组", full: input.overview_full === true });
    nodes.push(...overview.shown);
    for (const g of overview.shown) {
      memberGroupNodeId.set(g.id, g.id);
      for (const m of g.members) {
        // 多归属成员会出现在多个分组里：连线端点解析取**先登记的**分组节点（分组序确定——
        // 成员数降序＋稳定 id 升序）；这只决定"线落在哪个分组节点上"，不影响成员资格账目
        if (!memberGroupNodeId.has(m)) memberGroupNodeId.set(m, g.id);
      }
    }
    if (overview.aggregate !== null) {
      const hiddenGroups = ordered.slice(overview.shown.length);
      const hiddenMembers = hiddenGroups.reduce((s, g) => s + g.members.length, 0);
      nodes.push({
        id: `plan:aggregate:${input.view}`,
        label: overview.aggregate.label,
        kind: "aggregate",
        group_key: null,
        members: [],
        hidden_members: hiddenMembers,
        status: {
          kind: "aggregated",
          // 只是"被折叠成员里最差的一个"的上屏提示（纯 §4.2 优先级比较，不判业务状态、不冒充完成）
          display: hiddenGroups
            .flatMap((g) => g.members.map((m) => projectionOf(m)))
            .map((p) => (p !== null && p.mapping === "mapped" ? p.display_status : null))
            .filter((d): d is DisplayStatusKey => d !== null)
            .reduce<DisplayStatusKey | null>((a, d) => (a === null ? d : worseDisplayStatus(a, d)), null),
          projection: null,
          member_count: hiddenMembers,
          basis: `聚合节点：包含被折叠的 ${hiddenGroups.length} 个分组 / ${hiddenMembers} 个成员——**隐藏不等于已完成**（§3.3）`,
        },
        sources: [],
        technical_id: null,
        aggregate: true,
      });
    }
  }

  // 关系：只取本视图声明的 kind，且两端都在本视图节点集合里（概览态下 = 分组节点之间）
  const visible = new Set(nodes.map((n) => n.id));
  const resolveEndpoint = (planId: string): string | null => {
    if (visible.has(planId)) return planId;
    if (input.view === "construction") return null;
    // ① V09-02：成员节点被改名/分组后，解析到**本视图上代表它的那个分组节点**（见 `memberGroupNodeId`）
    const grouped = memberGroupNodeId.get(planId);
    if (grouped !== undefined && visible.has(grouped)) return grouped;
    // ② 不是本视图成员的**蓝图节点**（如系统架构视图里的任务、功能全景里的实现模块）：解析到其归属能力；
    //    能力自己就是分组节点（`plan:cap:*`），所以这一步同时也是"归属能力已画出"的判定。
    //    多值归属下按稳定 id 升序**逐个**试：第一归属的分组若被概览折叠，线仍能落到
    //    该节点真实归属的另一个可见分组上，不被静默丢掉（§3.3：不许线悄悄消失）。
    //    **先要求它是蓝图节点**：归属账目是按边枚举的，指向不在蓝图节点集里的端点（来源账与画布不一致）
    //    不该被"归属"悄悄收编成一个正常关系——那一类如实进 `unresolved_relations` 的 `missing_node`。
    if (byId.get(planId) === undefined) return null;
    for (const owner of [...ownersOf(planId)].sort()) {
      if (visible.has(owner)) return owner;
    }
    if (capabilityIds.has(planId) && visible.has(planId)) return planId;
    return null;
  };
  const edgeKinds = new Set(spec.edge_kinds);
  const seen = new Set<string>();
  /**
   * 两端解析到同一分组节点的线 = **同组内关系**：如实计数并写明口径句，不画自环（§3.3）。
   * 计数按**蓝图里的那条关系本身**（`source>target:kind`）去重——不能用解析后的分组端点当键：
   * 同一能力下的 N 个成员都会解析成同一个分组节点，那样会把 N 条关系报成 1 条。
   */
  const seenIntra = new Set<string>();
  /** V09-13：同组关系逐条留档（不画连线，但在分组节点上逐条可见、可点开追来源，§3.2） */
  const intraRelations: ViewEdge[] = [];
  /**
   * 一个蓝图 id 落在哪些分组（能力自己 = 自己的分组；成员 = **全部**归属，不只第一归属）。
   * 2026-09-26 复核口径：多值归属下「同组关系」的判据是**两端有没有共同分组**——共享模块
   * 同时是两个能力的成员时，任务→模块的关系如实是它自己分组内的关系；若按"代表分组"
   * 解析成跨组线，线会随分组大小排序时有时无（任意性），不如实。
   */
  const groupsOfPlanId = (id: string): readonly string[] => (capabilityIds.has(id) ? [id] : ownersOf(id));
  /** V09-02 账目恒等式：解析不到可见分组的关系逐条在场（不静默丢关系；成因分类见 `UnresolvedEndpointReason`） */
  const unresolvedRelations: UnresolvedRelation[] = [];
  /**
   * 端点解析不到任何可见分组的**成因**（不把"合理折叠/分类排除"与"真实缺口"混成一句「落空」）：
   * 与 `resolveEndpoint` 同一份事实（`visible`／`ownersOf`／`capClassOf`），不另算一套。
   *   ① 节点不在蓝图节点集里 ⇒ `missing_node`（来源账与画布不一致）；
   *   ② 端点是本视图按能力分类排除的**设计/治理章节**，或**只归属于**这类章节 ⇒ `governance_excluded`
   *      （功能全景不作治理能力节点、其任务也因此没有可见归属——这是分类口径的结果，不是折叠）；
   *   ③ 有归属但归属分组都没画出来（被概览折叠）⇒ `folded_group`（§3.3 合理折叠，展开即达）；
   *   ④ 归属账目里根本没有它 ⇒ `no_ownership`（§4.5 待归属）。
   */
  const endpointMissReasonOf = (planId: string): UnresolvedEndpointReason => {
    const node = byId.get(planId);
    if (node === undefined) return "missing_node";
    const governanceCapOf = (id: string): boolean =>
      input.view === "functional" && byId.get(id)?.kind === "capability" && capClassOf(id) === "governance";
    if (governanceCapOf(planId)) return "governance_excluded";
    const owners = ownersOf(planId);
    if (owners.length > 0 && !owners.some((o) => visible.has(o))) {
      return owners.every(governanceCapOf) ? "governance_excluded" : "folded_group";
    }
    return "no_ownership";
  };
  /** 成因的展示优先级：真实缺口（缺节点／待归属）优先于合理结果（折叠／分类排除），如实不美化 */
  const REASON_PRECEDENCE: readonly UnresolvedEndpointReason[] = [
    "missing_node",
    "no_ownership",
    "folded_group",
    "governance_excluded",
  ];
  for (const e of bp.edges) {
    if (!edgeKinds.has(e.kind)) continue;
    const from = resolveEndpoint(e.source);
    const to = resolveEndpoint(e.target);
    // 同组判定（施工依赖视图不分组，不适用）：两端解析相同，或两端**共享任一分组**——
    // 共享分组优先取已解析出的可见端点（from/to），都不在共享集里就照旧画跨组线
    // （那时共享分组已被概览折叠、不在画布上，画线才是如实）。
    let intraGroup: string | null = null;
    if (from !== null && to !== null && input.view !== "construction") {
      if (from === to) intraGroup = from;
      else {
        const shared = groupsOfPlanId(e.source).filter((g) => groupsOfPlanId(e.target).includes(g));
        if (shared.includes(from)) intraGroup = from;
        else if (shared.includes(to)) intraGroup = to;
      }
    }
    if (intraGroup !== null && from !== null && to !== null) {
      const intraId = `${e.source}>${e.target}:${e.kind}`;
      seenIntra.add(intraId);
      intraRelations.push({
        id: intraId,
        from: intraGroup,
        to: intraGroup,
        kind: e.kind,
        certainty: e.certainty,
        semantics: edgeSemanticsOf(e.kind),
        sources: e.source_refs,
        status: null,
        status_projection: null,
        group_key: intraGroup,
        note:
          `同组关系：两端都属于分组 ${intraGroup}——本视图不画自环，它列在该分组节点上，` +
          "点开可追到出处（§3.2 同组关系可见性）",
      });
      continue;
    }
    if (from === null || to === null) {
      // V09-02 账目恒等式：不许静默丢关系——解析不到可见分组的逐条记下（含落空端与成因分类）。
      // 两端都落空时按**展示优先级**取更重的那一种成因（真实缺口优先）；`missing_id` 与它同源。
      const missEnds: { end: "source" | "target"; id: string; reason: UnresolvedEndpointReason }[] = [];
      if (from === null) missEnds.push({ end: "source", id: e.source, reason: endpointMissReasonOf(e.source) });
      if (to === null) missEnds.push({ end: "target", id: e.target, reason: endpointMissReasonOf(e.target) });
      const reason = REASON_PRECEDENCE.find((r) => missEnds.some((m) => m.reason === r)) ?? missEnds[0].reason;
      const hit = missEnds.find((m) => m.reason === reason) ?? missEnds[0];
      unresolvedRelations.push({
        id: `${e.source}>${e.target}:${e.kind}`,
        kind: e.kind,
        certainty: e.certainty,
        source: e.source,
        target: e.target,
        unresolved_end: hit.end,
        missing_id: hit.id,
        reason,
        sources: e.source_refs,
      });
      continue;
    }
    const semantics = edgeSemanticsOf(e.kind);
    const id = `${from}>${to}:${e.kind}`;
    if (seen.has(id)) continue;
    seen.add(id);
    // 依赖线的连线对象 id 口径（V06-09）：`<前置任务 id>-><依赖方任务 id>`——
    // 蓝图侧是 `plan:task:<卡号>`，所以要按 `objectIdOf` 换成投影那边的卡号，不能拿蓝图 id 去查。
    const depObjectId =
      semantics === "dependency"
        ? `${objectIdOf(e.source, "task") ?? e.source}->${objectIdOf(e.target, "task") ?? e.target}`
        : null;
    const depProjection = depObjectId === null ? null : projectionOf(depObjectId);
    const depStatus =
      depProjection !== null && depProjection.mapping === "mapped" ? depProjection.display_status : null;
    edges.push({
      id,
      from,
      to,
      kind: e.kind,
      certainty: e.certainty,
      semantics,
      sources: e.source_refs,
      status: depStatus,
      status_projection: depProjection,
      note:
        semantics === "dependency"
          ? depProjection === null
            ? "依赖线：投影里还没有这条连线对象（未判前置是否满足）"
            : depProjection.missing_count > 0
              ? `依赖线：前置未释放（${depProjection.missing[0]?.why ?? "缺释放判据"}）`
              : "依赖线：前置交付已释放（只表示前置满足，不代表数据链路联通）"
          : EDGE_SEMANTICS[semantics].means,
    });
  }
  edges = edges.sort((a, b) => a.id.localeCompare(b.id));

  const notes = [
    `口径：${spec.label} — ${spec.question}（${spec.detail_hint}）`,
    `分组：${spec.grouping}`,
    // §3.2 能力分类（2026-09-26 GPT-6 裁定 7）：分类来源、排除账目与「未声明」都要如实上屏
    // R-1/B 类返工（2026-09-26 非作者复审）：表**损坏**时单列异常句（不得写成「未声明」，也不得判绿）
    ...(input.view === "functional" || input.view === "architecture"
      ? classBroken
        ? [
            `能力分类声明表**损坏**（${classIssues}，逐项明细见蓝图 capability_classes.issues）：` +
              "解析不出分类的章节标「分类未定」，**不当作功能能力**；分类不可信 ⇒ 不据此判绿、不据此给「可请求验收」结论，" +
              "按「旧有效图/更新失败」规则保留上次有效图并显示原因（§3.2／§3.3／§4.4）",
          ]
        : classDeclared
          ? input.view === "functional"
            ? [
                `能力分类：本视图只含**功能能力**分组（${groups.filter((g) => g.key.startsWith("plan:cap:")).length} 个）；` +
                  `${governanceExcluded.length} 个设计/治理章节（${governanceExcluded.map((g) => g.name).join("、")}）` +
                  "不是产品功能能力——不在本视图作为能力节点、不计入能力计数、不以「已验证能力」显示（§3.2 能力分类声明）；其稳定 ID、出处与任务/模块关联在系统架构、施工依赖与技术详情保持可追溯",
              ]
            : [
                `能力分类：分组中含 ${[...capabilityIds].filter((c) => capClassOf(c) === "governance").length} 个**设计/治理章节**分组——` +
                  "它们的成员归属与出处可追溯，但状态文案带「非产品功能能力」限定、不计入产品能力计数（§3.2 能力分类声明）",
              ]
          : [
              "能力分类未声明：设计书里没有「能力分类声明」表，全部 level-2 章节按功能能力处理（§3.2；分类不写死在代码里，以设计声明为准）",
            ]
      : []),
    // 2026-09-26 复核口径：能力的成员归属是**多值**（同一任务/模块可同属多个能力分组，不再后写覆盖）；
    // 系统架构视图另有「能力 ← 任务设计引用 ← 实测实现映射」的二级派生归属（如实标明是派生）
    ...(derivedMemberships > 0
      ? [
          `能力→模块归属含 ${derivedMemberships} 条**二级派生**（能力 ← 任务设计引用 ← 经核实的实测实现映射 observed）：` +
            "证据链真实可追，但这是**派生归属（实际关联模块）**——不是设计书模块清单的声明归属（声明位仍只有 §11.1 一处），" +
            "也不表示运行接口或模块协作已经验证；派生链每一段都可点开看来源、当前版本与证据状态，" +
            "任一段是未经审定的模型提案则不能成为正式成员（§3.2／2026-09-26 GPT-6 裁定 5）",
        ]
      : []),
    input.view === "construction"
      ? "施工依赖是有向依赖图：允许多个前置，不转成母子树（§3.3）"
      : overview.note,
    // V09-02：把"天然两端同组"的关系（能力↔它自己的成员模块、任务↔所属能力）如实交代成一句可核的口径句。
    // V09-13（§3.2 同组关系可见性）：这些关系不再只是"一句解释"——它们**逐条列在分组节点上**并可点开追来源
    // （`intra_relations`，每条带稳定 ID、关系种类与来源种类）；仍然**不画自环、不伪造跨组边**。
    ...(input.view !== "construction" && seenIntra.size > 0
      ? [
          `同组内关系不在本视图画出连线：本次 ${seenIntra.size} 条本视图关系的两端解析到**同一个分组节点**` +
            "（能力与其下属模块之间、任务与所属能力之间）——本视图不画自环、也不改画成别的分组之间的线（§3.3）；" +
            `它们改在**该分组节点上逐条列出**（${intraRelations.length} 条，每条带稳定 ID 与来源种类，` +
            "点开即追到出处；§3.2 同组关系可见性）",
        ]
      : []),
    // V09-02 账目恒等式（§3.2 同组关系可见性 / §3.3 隐藏≠没有 / §4.5 待归属）：解析不到可见分组的关系
    // **逐条点名**、并按成因区分「合理折叠／分类排除」与「真实待归属／缺节点」——不静默丢关系，也不把
    // 两种情况混成一句「落空」（本视图口径句与 `unresolved_relations` 同源）。
    ...(unresolvedRelations.length > 0 ? [unresolvedRelationsNoteOf(unresolvedRelations)] : []),
  ];
  return {
    view: input.view,
    spec,
    nodes,
    edges,
    intra_relations: intraRelations.sort((a, b) => a.id.localeCompare(b.id)),
    unresolved_relations: unresolvedRelations.sort((a, b) => a.id.localeCompare(b.id)),
    overview,
    aggregate_node: nodes.find((n) => n.aggregate === true) ?? null,
    groups,
    notes,
  };
}

/** 落空成因的上屏用语（`UnresolvedEndpointReason` 的唯一词表；口径句与读口共用，不各写一套） */
export const UNRESOLVED_REASON_LABELS: Readonly<Record<UnresolvedEndpointReason, string>> = {
  folded_group: "所属分组被概览折叠（点「显示全部分组」/展开后可见——合理折叠，不是丢失；§3.3）",
  governance_excluded: "端点是（或只归属于）按能力分类排除的**设计/治理章节**（本视图不作能力节点；§3.2 能力分类声明）",
  no_ownership: "端点在蓝图里**没有能力归属**（没有任务设计引用/归属边 ⇒ 待归属，须核对后补登；§4.5）",
  missing_node: "端点**不在蓝图节点集**里（来源账与画布不一致，须核对）",
};

/** 后两类＝**真实缺口**（前两类是视图口径本身的合理结果）；调用方据此决定是否计入阻断/待办 */
export const UNRESOLVED_REAL_GAP_REASONS: readonly UnresolvedEndpointReason[] = ["no_ownership", "missing_node"];

/**
 * 落空关系的口径句（逐类给条数、逐条点名；**成因分类原样上屏**，不把它折算成"已验证/可交付"）。
 * 与 `unresolved_relations` 同一份事实——界面、HTTP 与 MCP 读同一个 `notes`，不各写一套。
 */
export function unresolvedRelationsNoteOf(relations: readonly UnresolvedRelation[]): string {
  const order: readonly UnresolvedEndpointReason[] = ["folded_group", "governance_excluded", "no_ownership", "missing_node"];
  const parts: string[] = [
    `关系未画出：本次 ${relations.length} 条本视图关系的端点解析不到本视图可见分组，**逐条点名下**` +
      "（V09-02 账目恒等式：一条关系要么有归类、要么被点名，不许静默消失）",
  ];
  for (const reason of order) {
    const list = relations.filter((r) => r.reason === reason);
    if (list.length === 0) continue;
    const named = list
      .slice(0, 6)
      .map((r) => `${r.missing_id}（${r.unresolved_end === "source" ? "起点" : "终点"}·${r.kind}）`)
      .join("、");
    const realGap = UNRESOLVED_REAL_GAP_REASONS.includes(reason);
    parts.push(
      `· ${list.length} 条${realGap ? "【真实缺口】" : "【合理结果】"}——${UNRESOLVED_REASON_LABELS[reason]}：` +
        `${named}${list.length > 6 ? `…（另有 ${list.length - 6} 条，完整名单见 unresolved_relations）` : ""}`,
    );
  }
  return parts.join("\n");
}

// ═══════════════════════════ ⑥ 筛选 / 搜索 / 当前范围（§3.3 第二段） ═══════════════════════════

/**
 * 画布真实缺口对账（2026-09-26 安装版复核；2026-09-26 GPT-6 裁定 8 修订；交付判定判据 P11）：
 * 不只看蓝图账目，还要能发现「证据链说有成员、画布分组却一个都画不出来」的断裂。
 * 用**真实的 buildViewModel** 复算两个分组视图（与服务端/界面同一份口径，不另写一套）：
 *   · 功能全景（只含**功能能力**分组，§3.2 能力分类）：凡有 task_design_ref 指向的功能能力，
 *     那些任务必须出现在它的分组成员里；设计/治理章节不在功能全景作能力节点，不对它做本侧核对；
 *   · 系统架构（**逐应有模块靶点**核对，不是「有 1 个即过」的存在性判据）：能力的任务带实测
 *     实现映射（observed implementation_map → plan:code:*）时，**每一个**靶点都必须在该能力的
 *     分组里且**画布可达**——应有 2 个只丢 1 个也报缺；
 *   · 聚合可达性（§3.3：聚合不得吃掉可达性）：分组被概览折叠时，成员必须能从聚合入口**展开
 *     到达**（成员节点真实在场、聚合入口在场）——聚合后不可达 ⇒ 报缺；正常聚合（可展开到达）不报缺；
 *   · 未归属端点：有归属账目（任务有 task_design_ref、靶点有 observed 映射）却不在**任何**
 *     分组（含「未归属能力」组）里的端点 ⇒ 逐条点名。
 * **P11 只验证来源账与画布可达性一致，不证明设计语义正确。**
 * 缺口只装事实（哪个能力、哪个视图、差什么）；判「阻断」在溯源层（provenance.annotateObject）。
 */
export interface CanvasMembershipGap {
  capability_id: string;
  view: ProjectViewKind;
  detail: string;
}

export function canvasMembershipGapsOf(input: {
  blueprint: Blueprint;
  projection: ProjectionIndex;
  module_status?: Readonly<Record<string, NodeStatus>>;
}): CanvasMembershipGap[] {
  const bp = input.blueprint;
  const nodeIds = new Set(bp.nodes.map((n) => n.id));
  const capabilityIds = new Set(bp.nodes.filter((n) => n.kind === "capability").map((n) => n.id));
  const capClassOf = (id: string): "functional" | "governance" | "unknown" => capabilityClassOf(bp, id);
  const tasksByCap = new Map<string, string[]>();
  for (const e of bp.edges) {
    if (e.kind === "task_design_ref" && capabilityIds.has(e.target)) {
      const list = tasksByCap.get(e.target) ?? [];
      if (!list.includes(e.source)) list.push(e.source);
      tasksByCap.set(e.target, list);
    }
  }
  const functional = buildViewModel({ view: "functional", ...input });
  const architecture = buildViewModel({ view: "architecture", ...input });
  const groupMembersOf = (model: ProjectViewModel, cap: string): readonly string[] =>
    model.groups.find((g) => g.key === cap)?.members ?? [];

  /**
   * 画布可达性（§3.3 聚合可达口径）：成员在分组账里**且**能真的画出来——
   * 分组本身在概览画出（shown）；或分组被折叠、但聚合入口在场且成员节点真实在场（可展开到达）。
   * 返回 null = 可达；否则返回不可达原因（用于缺口明细）。
   */
  const reachabilityOf = (model: ProjectViewModel, cap: string, member: string): string | null => {
    const shown = model.overview.shown.some((g) => g.id === cap);
    if (shown) {
      if (!nodeIds.has(member)) return `成员 ${member} 的节点不在蓝图里，展开也画不出来`;
      return null;
    }
    if (model.aggregate_node === null) {
      return `分组 ${cap} 被概览折叠且没有聚合入口——隐藏且不可展开到达＝缺失（§3.3 聚合不得吃掉可达性）`;
    }
    if (!nodeIds.has(member)) {
      return `分组 ${cap} 被折叠进聚合节点，但成员 ${member} 的节点不在蓝图里，从聚合入口展开也画不出来`;
    }
    return null;
  };

  const gaps: CanvasMembershipGap[] = [];
  const pushGap = (cap: string, view: ProjectViewKind, detail: string): void => {
    gaps.push({ capability_id: cap, view, detail });
  };
  /** 全部能力分组（含「未归属能力」组）的成员并集——未归属端点判据用 */
  const allArchGroupMembers = new Set(architecture.groups.flatMap((g) => g.members));

  for (const [cap, tasks] of [...tasksByCap.entries()].sort()) {
    // ── 功能全景侧：对**非治理**分组逐任务核对（治理章节不作功能全景能力节点，§3.2 能力分类）。
    //    R-1 返工：表损坏时「分类未定」的分组**照常**进功能全景 ⇒ 照样要核（不能因分类查不到就跳过检查）
    if (capClassOf(cap) !== "governance") {
      const fMembers = groupMembersOf(functional, cap);
      const missing = tasks.filter((t) => !fMembers.includes(t));
      if (missing.length > 0) {
        pushGap(
          cap,
          "functional",
          `功能全景分组丢了 ${missing.length} 个任务成员（${missing.slice(0, 3).join("、")}${missing.length > 3 ? "…" : ""}）：` +
            "task_design_ref 边在蓝图里，能力的分组里却没有它",
        );
      } else {
        for (const t of tasks) {
          const why = reachabilityOf(functional, cap, t);
          if (why !== null) pushGap(cap, "functional", `功能全景任务成员 ${t} 画布不可达：${why}`);
        }
      }
    }
    // ── 系统架构侧：逐应有模块靶点核对（丢一个也报缺）＋聚合可达性 ──
    const implTargets = [
      ...new Set(
        bp.edges
          .filter(
            (e) =>
              e.kind === "implementation_map" &&
              e.certainty === "observed" &&
              tasks.includes(e.source) &&
              e.target.startsWith("plan:code:"),
          )
          .map((e) => e.target),
      ),
    ].sort();
    const aMembers = groupMembersOf(architecture, cap);
    for (const target of implTargets) {
      if (!aMembers.includes(target)) {
        // 缺失分两种如实写法：靶点在别的分组仍可见（本分组账丢了）／靶点不在**任何**分组（未归属端点）
        pushGap(
          cap,
          "architecture",
          allArchGroupMembers.has(target)
            ? `系统架构分组丢了应有模块靶点 ${target}（能力的任务有 observed 实测实现映射指向它；应有 ${implTargets.length} 个靶点逐一核对、丢一个也报缺）：` +
              "该靶点目前只在其他分组可见，本分组成员账缺失——证据链与画布分组断裂"
            : `未归属端点：应有模块靶点 ${target} 不在系统架构的**任何**分组（含「未归属能力」组）里` +
              `${nodeIds.has(target) ? "" : "（节点不在蓝图里）"}——能力的任务有 observed 实测实现映射指向它，` +
              `应有 ${implTargets.length} 个靶点逐一核对、丢一个也报缺；端点从画布消失，逐条点名`,
        );
        continue;
      }
      const why = reachabilityOf(architecture, cap, target);
      if (why !== null) {
        pushGap(cap, "architecture", `系统架构模块成员 ${target} 画布不可达：${why}`);
      }
    }
  }
  return gaps;
}

export type ViewFilterKind = "all" | "changed" | "problem";

export interface ViewFilter {
  kind: ViewFilterKind;
  query: string;
}

export const EMPTY_FILTER: ViewFilter = { kind: "all", query: "" };

export const VIEW_FILTERS: Record<ViewFilterKind, { label: string; means: string }> = {
  all: { label: "全部", means: "不筛" },
  changed: {
    label: "只看本次变更",
    means: "只留状态投影判为「源变更影响 / 陈旧 / 图版本落后」的对象（freshness ≠ fresh）",
  },
  problem: {
    label: "只看问题",
    means: "只留有已确认问题、明确阻塞或结果待验证的对象（含未收口缺陷）",
  },
};

export const isChangedStatus = (s: NodeStatus): boolean => {
  const p = s.projection;
  if (p === null) return false;
  return p.freshness !== "fresh" || p.overlays.includes("stale_overlay") || p.recheck_scope.length > 0;
};

export const isProblemStatus = (s: NodeStatus): boolean => {
  const p = s.projection;
  if (p === null) return false;
  return p.display_status === "blocked" || p.display_status === "pending_verification" || p.open_findings.length > 0;
};

export const matchesQuery = (node: Pick<ViewNode, "id" | "label">, query: string): boolean => {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  return node.label.toLowerCase().includes(q) || node.id.toLowerCase().includes(q);
};

export interface FilterResult {
  nodes: ViewNode[];
  hidden_by_kind: number;
  hidden_by_query: number;
}

/**
 * 筛选 + 搜索（§3.3「提供搜索、回到全图、返回上次位置、只看本次变更/问题的筛选」）。
 * 关系端点节点（`endpoint`）不参与"问题/变更"判断——它只是因为某条线才在场：
 * 只要它连着任一留下的节点就一起留着，免得线变成悬空线（悬空线会被画布丢掉，用户以为关系没了）。
 */
export function applyViewFilter(
  nodes: readonly ViewNode[],
  filter: ViewFilter,
  edges: readonly ViewEdge[] = [],
): FilterResult {
  const byQuery = nodes.filter((n) => matchesQuery(n, filter.query));
  const main = byQuery.filter((n) => n.endpoint !== true);
  const kept =
    filter.kind === "all"
      ? byQuery
      : main.filter((n) => (filter.kind === "changed" ? isChangedStatus(n.status) : isProblemStatus(n.status)));
  const keptIds = new Set(kept.map((n) => n.id));
  if (filter.kind !== "all") {
    for (const n of byQuery) {
      if (n.endpoint !== true) continue;
      const linked = edges.some(
        (e) => (e.from === n.id && keptIds.has(e.to)) || (e.to === n.id && keptIds.has(e.from)),
      );
      if (linked) keptIds.add(n.id);
    }
  }
  const result = nodes.filter((n) => keptIds.has(n.id));
  return {
    nodes: result,
    hidden_by_kind: byQuery.length - keptIds.size,
    hidden_by_query: nodes.length - byQuery.length,
  };
}

export interface ScopeReport {
  total: number;
  shown: number;
  hidden: number;
  /** 隐藏里"不是验证已通过"的个数——**不许因为隐藏了未完成节点就呈现"全项目已完成"**（§3.3） */
  hidden_unfinished: number;
  note: string;
}

/** 过滤后显示当前范围（§3.3：过滤后显示范围，且不许让人以为"全项目已完成"） */
export function scopeReportOf(
  nodes: readonly ViewNode[],
  filter: ViewFilter,
  kept: readonly ViewNode[],
): ScopeReport {
  const main = nodes.filter((n) => n.endpoint !== true && n.aggregate !== true);
  const keptIds = new Set(kept.map((n) => n.id));
  const hiddenNodes = main.filter((n) => !keptIds.has(n.id));
  const hiddenUnfinished = hiddenNodes.filter((n) => n.status.display !== "verified").length;
  const parts: string[] = [];
  parts.push(
    filter.kind === "all"
      ? `当前范围：显示全部 ${main.length} 个对象（未筛选）`
      : `当前范围：${VIEW_FILTERS[filter.kind].label} → 显示 ${main.filter((n) => keptIds.has(n.id)).length} / 共 ${main.length} 个对象`,
  );
  if (filter.query.trim() !== "") parts.push(`搜索「${filter.query.trim()}」`);
  if (hiddenNodes.length > 0) {
    parts.push(
      `隐藏了 ${hiddenNodes.length} 个，其中 ${hiddenUnfinished} 个**不是**「验证已通过」——` +
        `隐藏不等于已完成，也不是全项目都通过了（§3.3）`,
    );
  }
  return {
    total: main.length,
    shown: main.filter((n) => keptIds.has(n.id)).length,
    hidden: hiddenNodes.length,
    hidden_unfinished: hiddenUnfinished,
    note: parts.join(" · "),
  };
}

// ═══════════════════════════ ⑦ 四种说明分开（§3.3 末段） ═══════════════════════════

export type ViewEmptyState = "loading" | "load_failed" | "no_plan" | "no_match" | "ready";

export interface ViewEmptyInfo {
  state: ViewEmptyState;
  title: string;
  hint: string;
  retryable: boolean;
}

/**
 * 空态判据（§3.3「无匹配、无规划、加载失败使用不同说明」）：
 *   加载失败 ≠ 无规划 ≠ 无匹配 ≠ 空图；四者文案与出口都不一样。
 */
export function emptyStateOf(input: {
  loading: boolean;
  error: string | null;
  blueprint_exists: boolean;
  node_total: number;
  node_shown: number;
}): ViewEmptyInfo {
  if (input.loading) {
    return { state: "loading", title: "正在读取规划图与状态…", hint: "首次读取要等蓝图与投影都回来", retryable: false };
  }
  if (input.error !== null && input.error !== "") {
    return {
      state: "load_failed",
      title: "加载失败（不是「没有规划」）",
      hint: `${input.error}——按「重试」重读一次；仍失败时看后端是否在跑（这是读取故障，不是项目没有图纸）`,
      retryable: true,
    };
  }
  if (!input.blueprint_exists) {
    return {
      state: "no_plan",
      title: "这个项目还没有已发布的规划图（不是加载失败）",
      hint:
        "图纸（设计书 + 施工图）审定并激活基线后会自动派生规划图；" +
        "未审定前可预览**草稿图**（明确标草稿、不能当施工依据，§3.2）。" +
        "这里连草稿都派不出来：图纸源里没有可映射的章节、模块或任务",
      retryable: false,
    };
  }
  if (input.node_total === 0) {
    return {
      state: "no_plan",
      title: "规划图里这个视图还没有对象（不是加载失败）",
      hint: "图纸里没有本视图需要的节点：先补图纸内容，或切到别的视图看现有对象",
      retryable: false,
    };
  }
  if (input.node_shown === 0) {
    return {
      state: "no_match",
      title: "无匹配：当前搜索/筛选下没有对象（不是没有规划）",
      hint: "清空搜索或切回「全部」筛选即可看到本视图的全部对象",
      retryable: false,
    };
  }
  return { state: "ready", title: "", hint: "", retryable: false };
}

// ═══════════════════════════ ⑧ 图正在更新 / 图已过期（§3.3 末段 / §4.4） ═══════════════════════════

/**
 * `attempted_at` 是否不早于 `generated_at`（"最近一次派生尝试晚于本图"判据）。
 *
 * 两个串都可能带不同时区偏移（派生回执由 `nowIso()` 写本地 `+08:00`，蓝图 `generated_at`
 * 允许调用方传入），直接 `>=` 比的是**字面钟点**不是时刻；这里一律 `Date.parse` 成毫秒再比。
 * **前端不 import 服务端模块**（`src/server/time.ts` 会把 node 侧实现拖进前端包，
 * 见 `scripts/verify-v06-06.ts` 开头说明），因此这一处就地解析，与那边的口径逐字一致：
 * 任一边解析不出真实时刻 → 判 `false`（不声称"图正在更新"，宁可少提示一句）。
 */
function attemptedAfterGenerated(attemptedAt: string, generatedAt: string): boolean {
  const attempted = Date.parse(attemptedAt);
  const generated = Date.parse(generatedAt);
  if (Number.isNaN(attempted) || Number.isNaN(generated)) return false;
  return attempted >= generated;
}

export interface FreshnessReport {
  state: "fresh" | "updating" | "stale";
  /** 上屏的提示行（可能同时有"图已过期""图正在更新""语义整理层未生效"几句） */
  banners: string[];
  /** 源已更新但新图未生成 / 有更新中的派生尝试时为 true：调用方**继续显示上次有效图**（§4.4） */
  keep_last_valid: boolean;
}

/** 语义整理层的状态视图（`GET /arch/blueprint` 的 `semantic.status`；缺省 = 不知道，不断言） */
export interface SemanticStatusView {
  phase?: string | null;
  outcome?: string | null;
  semantic_complete?: boolean | null;
  missing?: { scope?: string; reason?: string }[] | null;
  scopes?: { scope: string; state: string; error?: string | null }[] | null;
  note?: string | null;
  finished_at?: string | null;
}

/**
 * 图新鲜度（§3.3「若源已更新但新图尚未生成，继续显示上次有效图并标图正在更新/图已过期」）：
 *   · **图已过期**：当前源修订 ≠ 本图派生时用的那份 —— 源改了，图还没重画。
 *     V09-07（附录 E.8-7 口径统一）：**施工图侧比定义哈希**（`revisions.plan_definition`
 *     vs `bp.based_on.plan_definition_sha256`）——只改 PLAN 状态列/勾选位/非定义区**不**判过期，
 *     改任务定义才判；缺任一侧哈希就不比（不引入新假阳性）。设计书侧仍比内容哈希（§2.9 口径不变）。
 *   · **图正在更新**：最近一次派生尝试（回执）晚于本图生成时间、且结果**不是**这份图
 *     （没发布成功 / 发布的是另一份缓存键）——旧图仍在显示，新图还没就位。
 *   · **V08-05 第三种（如实降级）**：图内容**是当前版**（确定性派生，绑定当前源修订、且本项目已发布），
 *     但**语义整理层**最近一次没通过校验/没生效 —— 这时不许再挂"图正在更新"（那会让人以为整图过期），
 *     如实说清「图是当前版 + 语义层降级原因 + 下次重试入口」。
 * 三者都可能同时成立；都不**自动跳回全局**、不丢用户位置（§3.3）。
 */
export function freshnessOf(input: {
  blueprint: Blueprint | null;
  receipt: { attempted_at: string; cache_key: string; published: boolean; kept_previous: boolean } | null;
  /** 状态投影读到的**当前**源修订（design/plan = 内容哈希；plan_definition = PLAN 定义哈希，V09-07） */
  revisions: { design?: string | null; plan?: string | null; plan_definition?: string | null };
  /** 当前生效基线（保留入参兼容；施工图侧判定已改比定义哈希（E.8-7），不再用这里的内容哈希） */
  baseline?: { baseline_id: string; design_revision: string; plan_revision: string; plan_definition?: string | null } | null;
  /** V08-05：语义整理层状态（缺省 = 不判这一种） */
  semantic?: SemanticStatusView | null;
}): FreshnessReport {
  const bp = input.blueprint;
  const banners: string[] = [];
  if (bp === null) return { state: "fresh", banners, keep_last_valid: false };
  const nonEmpty = (v: string | null | undefined): v is string => typeof v === "string" && v !== "";
  const designChanged =
    nonEmpty(input.revisions.design) &&
    nonEmpty(bp.based_on.design_content_sha256) &&
    input.revisions.design !== bp.based_on.design_content_sha256;
  // V09-07（E.8-7）：施工图侧 = 当前 PLAN 定义哈希 vs 本图派生时绑定的定义哈希；
  // 内容哈希（状态列/勾选位）的变动不再误判过期。缺任一侧 → 不比（宁可少提示，不新增假阳性）。
  const planChanged =
    nonEmpty(input.revisions.plan_definition) &&
    nonEmpty(bp.based_on.plan_definition_sha256) &&
    input.revisions.plan_definition !== bp.based_on.plan_definition_sha256;
  if (designChanged || planChanged) {
    banners.push(
      `图已过期：源已更新（${[designChanged ? "设计书" : null, planChanged ? "施工图" : null].filter(Boolean).join("、")}），` +
        `新图尚未生成——继续显示上次有效图（§3.3 / §4.4）`,
    );
  }
  // V08-05：语义层降级（图本身是当前版）——先判这一种，避免被"图正在更新"顶掉
  const sem = input.semantic ?? null;
  const semScopes = sem?.scopes ?? [];
  const semDegraded =
    sem !== null &&
    (sem.semantic_complete === false || semScopes.some((s) => s.state !== "tidied") || (sem.missing ?? []).length > 0);
  if (!designChanged && !planChanged && semDegraded) {
    const reason =
      (sem.missing ?? []).map((m) => `${m.scope ?? "?"}：${m.reason ?? "未说明原因"}`).join("；") ||
      semScopes.filter((s) => s.state !== "tidied").map((s) => `${s.scope}：${s.error ?? s.state}`).join("；") ||
      sem?.note ||
      "未说明原因";
    const scopeStates = semScopes.map((s) => `${s.scope}=${s.state}`).join(" / ");
    banners.push(
      `图内容是**当前版**（确定性派生，绑定当前源修订${bp.baseline_id !== null && bp.baseline_id !== undefined ? `，基线 ${bp.baseline_id}` : ""}）：` +
        `**语义整理层**最近一次没生效——${reason.slice(0, 160)}` +
        `${scopeStates === "" ? "" : `（分段状态 ${scopeStates}）`}——` +
        "图照常按确定性派生看，语义补全没进图（§4.1 / §4.4）；下次重试：下一次基线激活的自动链，或用「更新图」显式重试",
    );
  }
  const r = input.receipt;
  if (
    r !== null &&
    attemptedAfterGenerated(r.attempted_at, bp.generated_at) &&
    (r.published === false || r.cache_key !== bp.based_on.full_key) &&
    !(!designChanged && !planChanged && semDegraded)
  ) {
    banners.push(
      `图正在更新：最近一次派生尝试 ${r.attempted_at.slice(0, 19).replace("T", " ")} 的结果不是这份图` +
        `（${r.published ? "发布的是另一份缓存键" : "本次未发布"}${r.kept_previous ? "，保留了上次有效图" : ""}）——` +
        `先按上次有效图看，不自动跳回全局（§4.4）`,
    );
  }
  const state = banners.length === 0 ? "fresh" : banners.some((b) => b.startsWith("图已过期")) ? "stale" : "updating";
  return { state, banners, keep_last_valid: banners.length > 0 };
}

// ═════════ ⑧-bis V09-12：图更新状态（正在更新／预计用时／失效；§3.2 触发范围、§3.3 末段、§4.4） ═════════

/**
 * 源变化发现链的更新状态视图（服务端 `GET /arch/blueprint` 的 `update` 字段，形状与
 * `src/server/work/graphUpdate.ts` 的 `GraphUpdateRecord` 一致）。
 * 这里**只镜像形状**（与 `SemanticStatusView` 同一手法）：前端不 import 服务端模块（值 import 会把
 * node:fs 拖进前端包）；**ETA 的算术也不在这里**——看服务端给的 `eta`，界面只做"减去已过时间"的显示。
 */
export interface GraphUpdateView {
  state: "updating" | "ready" | "stale" | "failed";
  scope: string | null;
  reason: string | null;
  phase: string | null;
  phases_done: number;
  phases_total: number;
  change_token: string | null;
  started_at: string | null;
  updated_at: string;
  finished_at: string | null;
  eta: {
    basis: string;
    total_ms: number | null;
    note: string;
    samples?: { history: number; phases_done: number; phases_total: number };
  } | null;
  result?: {
    modules_generated_at?: string | null;
    blueprint_generated_at?: string | null;
    blueprint_published?: boolean;
    publish_reason?: string | null;
    kept_previous?: boolean;
  } | null;
  last_error: string | null;
}

/** 依据不足时的**唯一**合规文案（§3.3：不编造 ETA） */
export const GRAPH_UPDATE_ETA_UNKNOWN = "无法估计";

/** 阶段名（"正在更新"要说清在做什么/等什么） */
const GRAPH_UPDATE_PHASES: Record<string, string> = {
  debounce: "已收到源变化，正在安全防抖合批",
  queued: "在等安全防抖闸门（最小间隔／窗口预算）",
  reparse: "正在确定性重解析（代码结构 → 模块骨架）",
  blueprint: "正在重建蓝图（既有确定性派生链）",
};

/** 触发范围的中文名（"是哪一类变化触发的"也要能看见） */
export const GRAPH_UPDATE_SCOPES: Record<string, string> = {
  doc: "图纸源变化",
  structure_top: "顶层目录变化",
  structure_deep: "深层模块（目录）变化",
  interface: "模块对外接口文件变化",
  dependency: "跨模块依赖变化",
};

/**
 * 预计用时的上屏文案：**只在服务端给了定量依据（`eta.total_ms` 非空且 basis≠none）时给秒数**，
 * 否则一律「无法估计」。剩余时间 = 服务端给的预计本体量 − 已过时间（等待档以记录写入时刻为基准）。
 */
export function graphUpdateEtaText(update: GraphUpdateView, now_ms: number = Date.now()): string {
  const eta = update.eta;
  if (eta === null || eta === undefined) return GRAPH_UPDATE_ETA_UNKNOWN;
  if (eta.basis === "none" || typeof eta.total_ms !== "number" || !Number.isFinite(eta.total_ms)) {
    return GRAPH_UPDATE_ETA_UNKNOWN;
  }
  const ref = eta.basis === "wait_window" ? update.updated_at : update.started_at;
  const refMs = typeof ref === "string" ? Date.parse(ref) : NaN;
  const elapsed = Number.isNaN(refMs) ? 0 : Math.max(0, now_ms - refMs);
  const remain = Math.max(0, eta.total_ms - elapsed);
  return `约 ${Math.max(1, Math.ceil(remain / 1000))} 秒`;
}

/**
 * 图更新横幅（§3.3 末段 / §4.4）：`ready` 不出横幅（图与最近一次已完成变更一致），
 * 其余三态**必须**出横幅并带原因——`stale`/`failed` 时界面继续显示上次有效图但**明确标出来**，
 * 绝不以旧图冒充新图。返回 null = 不显示。
 */
export function graphUpdateBannerOf(
  update: GraphUpdateView | null | undefined,
  now_ms: number = Date.now(),
): { state: "updating" | "stale" | "failed"; text: string; eta_text: string } | null {
  if (update === null || update === undefined) return null;
  const scopeText = update.scope !== null && update.scope !== undefined ? (GRAPH_UPDATE_SCOPES[update.scope] ?? update.scope) : null;
  if (update.state === "updating") {
    const phaseText = update.phase !== null && update.phase !== undefined ? (GRAPH_UPDATE_PHASES[update.phase] ?? update.phase) : "正在更新";
    const progress = `已完成 ${update.phases_done}/${update.phases_total} 阶段`;
    const etaText = graphUpdateEtaText(update, now_ms);
    const etaPart =
      etaText === GRAPH_UPDATE_ETA_UNKNOWN
        ? `预计用时：${GRAPH_UPDATE_ETA_UNKNOWN}（依据不足，不编造 ETA）`
        : `预计用时：${etaText}（依据：${update.eta?.note ?? "有实测量依据"}）`;
    return {
      state: "updating",
      eta_text: etaText,
      text:
        `图正在更新（源变化发现链）：${phaseText}——${progress}` +
        `${scopeText === null ? "" : `；本次触发：${scopeText}`}；${etaPart}——更新期间继续显示上次有效图（§3.3 / §4.4）`,
    };
  }
  if (update.state === "stale") {
    return {
      state: "stale",
      eta_text: GRAPH_UPDATE_ETA_UNKNOWN,
      text:
        `图已过期：${update.last_error ?? update.reason ?? "源已变但新图未就位（原因未记）"}` +
        `${update.change_token === null ? "" : `；本轮变更指纹 ${update.change_token}`}——继续显示上次有效图，**不把旧图当新图**（§3.3）`,
    };
  }
  if (update.state === "failed") {
    return {
      state: "failed",
      eta_text: GRAPH_UPDATE_ETA_UNKNOWN,
      text: `图更新失败：${update.last_error ?? update.reason ?? "原因未记"}——保留上次有效图并如实标出（§4.4）`,
    };
  }
  return null;
}

// ═══════════════════════════ ⑨ 详情五段（§3.2 点击展开顺序） ═══════════════════════════

export type DetailSectionKey = "role" | "situation" | "origin" | "verification" | "tech";

export interface DetailSection {
  key: DetailSectionKey;
  /** 段名（§3.2 原文顺序，一个字不改） */
  title: string;
  lines: string[];
  /** 面向人的摘要；原始字段留在 lines，按需展开，不改变证据判据。 */
  summary?: string[];
}

/** §3.2 的详情顺序，**顺序即契约**（验证脚本按此断言） */
export const DETAIL_SECTION_TITLES: readonly { key: DetailSectionKey; title: string }[] = [
  { key: "role", title: "它的作用" },
  { key: "situation", title: "当前情况与原因" },
  { key: "origin", title: "设计/施工出处" },
  { key: "verification", title: "验证结果" },
  { key: "tech", title: "技术资料" },
];

export const DETAIL_SECTION_ORDER: readonly DetailSectionKey[] = DETAIL_SECTION_TITLES.map((s) => s.key);

const short = (s: string, n = 12): string => (s.length > n ? `${s.slice(0, n)}…` : s);

/** 仅组成可编辑草稿，保留原话；发送仍由现有聊天入口与用户操作负责。 */
export function appendObjectQuestionDraft(draft: string, project: { id: string; name: string }, node: Pick<ViewNode, "id" | "label" | "sources">): string {
  const references = node.sources.map((s) => `- ${s.path} · ${s.locator}${s.sha256 ? `（引用版本 ${s.sha256}）` : ""}`);
  return `${draft}${draft.length > 0 ? "\n\n" : ""}【围绕项目中的这部分讨论】\n项目：${project.name}（${project.id}）\n对象：${node.label}（${node.id}）\n来源：\n${references.length > 0 ? references.join("\n") : "当前没有可定位的来源，请先核对，勿推测。"}\n\n我想了解这部分的作用、关联和设计依据。请以当前有效资料回答，并明确尚未查清的地方。`;
}

/**
 * 点击节点的详情五段（§3.2 顺序：作用 → 当前情况与原因 → 设计/施工出处 → 验证结果 → 技术资料）。
 * 状态与原因全部来自 V06-09 的投影（`display_status` / `reasons` / required/passed/missing 计数与缺口），
 * 并带上**来源时间**（图生成时间 / 最近派生尝试时间 / 读取时间）——没有的东西如实说"没有"，不编。
 */
export function detailSectionsOf(input: {
  node: ViewNode;
  blueprint: Blueprint;
  /** 本视图的口径句 */
  view_notes?: readonly string[];
  /** 状态投影的读取时间（浏览器拿到的这份数据的观测时间，标注清楚是本机读取） */
  received_at?: string;
  /** 证据/缺口引用的文件是否在项目内可读（不给就不说） */
  merged_nodes?: readonly { id: string; plan_refs?: string[]; blurb?: string }[];
}): DetailSection[] {
  const { node, blueprint: bp } = input;
  const st = node.status;
  const p = st.projection;
  const role: string[] = [`节点：${node.label}（稳定 ID ${node.id}，kind=${node.kind}）`];
  role.push(`它在这一视图里的分工：${input.view_notes?.[0] ?? ""}`.trim());
  if (node.members.length > 0) role.push(`本节点代表 ${node.members.length} 个成员：${node.members.slice(0, 6).join("、")}${node.members.length > 6 ? "…" : ""}`);
  if (node.aggregate === true) role.push(`聚合节点：只表示数量，不把被聚合的对象算成已完成（隐藏 ${node.hidden_members} 个成员）`);

  const situation: string[] = [];
  situation.push(
    `当前状态：${st.display === null ? "未映射/不着完成色（不空集判绿，§4.2）" : `${DISPLAY_STATUS_PALETTE[st.display].short}（${DISPLAY_STATUS_PALETTE[st.display].full}）`}`,
  );
  situation.push(`状态口径：${st.basis}`);
  if (p !== null) {
    situation.push(`四维：执行 ${p.execution} · 质量 ${p.quality} · 验收 ${p.acceptance} · 新鲜度 ${p.freshness}`);
    situation.push(`必需/通过/缺口：${p.required_count} / ${p.passed_count} / ${p.missing_count}`);
    for (const r of p.reasons.slice(0, 8)) situation.push(`原因 [${r.code}] ${r.text}`);
    if (p.reasons.length > 8) situation.push(`…另有 ${p.reasons.length - 8} 条原因`);
    if (p.overlays.length > 0) situation.push(`叠加标签：${p.overlays.join("、")}`);
    situation.push(`来源修订：${p.source_revision === "" ? "（未给）" : short(p.source_revision, 16)}`);
  }
  situation.push(
    `来源时间：图生成 ${bp.generated_at.slice(0, 19).replace("T", " ")}` +
      `${bp.publish.validated_at !== null ? ` · 校验 ${bp.publish.validated_at.slice(0, 19).replace("T", " ")}` : ""}` +
      `${input.received_at !== undefined ? ` · 本次读取 ${input.received_at.slice(0, 19).replace("T", " ")}（本机读取时间）` : ""}`,
  );

  const origin: string[] = [];
  if (node.sources.length === 0) origin.push("没有可定位出处（规划节点本来就没给：如实说没有，不编）");
  for (const s of node.sources) {
    origin.push(
      `${s.kind === "design_section" ? "设计书章节" : s.kind === "plan_task" ? "施工卡" : "静态模块"}：` +
        `${s.path} · ${s.locator}${s.sha256 === null ? "" : ` · 引用时哈希 ${short(s.sha256)}`}`,
    );
  }
  origin.push(`基线：${bp.baseline_id ?? "（无生效基线）"}；派生器 ${bp.generator_version}（缓存键 ${short(bp.based_on.full_key, 20)}）`);

  const verification: string[] = [];
  if (p !== null) {
    verification.push(`验证范围（通过项）：${p.scope.verified_scope.length === 0 ? "无" : p.scope.verified_scope.slice(0, 6).join("；")}`);
    if (p.scope.uncovered.length > 0) verification.push(`未覆盖：${p.scope.uncovered.join("、")}`);
    if (p.missing.length > 0) {
      for (const m of p.missing.slice(0, 6)) verification.push(`缺口：${m.check_id}（${m.label}）—— ${m.why}`);
      if (p.missing.length > 6) verification.push(`…另有 ${p.missing.length - 6} 项缺口`);
    } else {
      verification.push("缺口：无（必需项都过了）");
    }
    verification.push(`证据引用：${p.evidence_refs.length === 0 ? "无" : p.evidence_refs.map((e) => short(e)).join("、")}`);
    if (p.history.length > 0) verification.push(`历史（被源变更取代的旧结论，保留不消失）：${p.history.map((h) => `${h.check_id}@${short(h.bound_revision, 8)}（被 ${short(h.superseded_by, 16)} 取代）`).join("；")}`);
    if (p.open_findings.length > 0) verification.push(`未收口缺陷：${p.open_findings.map((f) => `${f.finding_id}(${f.severity}${f.must_block ? "，必须拦截" : ""})`).join("、")}`);
    verification.push(`人工验收：${p.acceptance}（用户验收不由质量状态代写，§4.2）`);
  } else {
    verification.push("没有这个对象的状态投影，因此没有验证结论可展示（不拿空集当通过，§4.2）");
  }

  const tech: string[] = [];
  tech.push(node.technical_id !== null ? `技术详情对应 id：${node.technical_id}（点「在技术详情定位」跳到共用层画布）` : "技术详情里没有对应节点（该规划对象还没有实测代码映射）");
  const merged = input.merged_nodes ?? [];
  const refs = merged.find((n) => n.id === node.technical_id || (n.plan_refs ?? []).includes(node.id));
  if (refs !== undefined) tech.push(`共用层节点：${refs.id}${(refs.plan_refs ?? []).length > 0 ? `（规划引用 ${(refs.plan_refs ?? []).join("、")}）` : ""}`);
  const codeRefs = node.sources.filter((s) => s.kind === "code_module");
  if (codeRefs.length > 0) tech.push(`实测模块出处：${codeRefs.map((s) => `${s.path} · ${s.locator}`).join("；")}（静态解析，不是运行时数据流）`);
  tech.push("技术资料口径：静态 import 是代码依赖，不称为运行时业务流（§3.2）；文件级明细进「技术详情」按需下钻");

  const explanation = refs?.blurb?.trim();
  const roleSummary = [
    explanation ? `现有图资料说明（自动整理，需核对原文）：${explanation}` : "当前图资料未提供可核对的用途说明。可从下方设计出处继续了解。",
    "为什么这样设计：当前图资料未提供独立的设计理由，请查阅原始设计，不能用推测补齐。",
  ];
  if (node.members.length > 0) roleSummary.push(`这里汇集了 ${node.members.length} 个相关部分，展开原始记录可看完整定位。`);
  const executionWords: Record<string, string> = { not_started: "尚未开始", in_progress: "正在处理", result_submitted: "已提交制作结果", blocked: "目前受阻", cancelled: "已取消" };
  const qualityWords: Record<string, string> = { unverified: "尚未检查", mechanical_passed: "自动检查已通过", auditing: "正在复审", has_findings: "检查发现问题", audit_passed: "复审已通过", evidence_invalid: "检查依据已失效" };
  const acceptanceWords: Record<string, string> = { pending: "等待用户验收", accepted: "用户已接受", rejected: "用户已退回", accepted_known_limit: "用户已接受，并保留已知限制" };
  const freshnessWords: Record<string, string> = { fresh: "当前记录适用", verification_stale: "内容改过，原检查需复核", impact_unknown: "改动影响尚未查清", unreadable: "当前材料无法读取" };
  const situationSummary = p === null
    ? [st.basis, "这里没有可用的独立状态记录，不能据此认为已经完成。"]
    : [
        `制作：${executionWords[p.execution] ?? "状态待核对"}；检查：${qualityWords[p.quality] ?? "状态待核对"}。`,
        `验收：${acceptanceWords[p.acceptance] ?? "状态待核对"}。${freshnessWords[p.freshness] ?? "资料适用性待核对"}。`,
        ...p.reasons.map((r) => r.text),
      ];
  const originSummary = node.sources.length === 0 ? ["当前没有可定位的出处。"] : node.sources.map((s) => `${s.kind === "design_section" ? "设计说明" : s.kind === "plan_task" ? "工作安排" : "代码位置"}：${s.locator} · ${s.path}`);
  const verificationSummary = p === null ? ["当前没有足够记录可以给出验证结论。"] : [
    `本对象要求 ${p.required_count} 项检查，通过 ${p.passed_count} 项，仍缺 ${p.missing_count} 项。`,
    `已检查范围：${p.scope.verified_scope.length === 0 ? "尚无通过记录" : p.scope.verified_scope.join("；")}`,
    ...(p.scope.uncovered.length > 0 ? [`未覆盖：${p.scope.uncovered.join("、")}`] : []),
    ...p.missing.map((m) => `还缺：${m.label}。${m.why}`),
    `用户验收：${acceptanceWords[p.acceptance] ?? "状态待核对"}。`,
  ];

  return [
    { key: "role", title: "它的作用", lines: role.filter((l) => l !== ""), summary: roleSummary },
    { key: "situation", title: "当前情况与原因", lines: situation, summary: situationSummary },
    { key: "origin", title: "设计/施工出处", lines: origin, summary: originSummary },
    { key: "verification", title: "验证结果", lines: verification, summary: verificationSummary },
    { key: "tech", title: "技术资料", lines: tech },
  ];
}

// ═══════════════ ⑩ 数据流向图：目标语义口径、来源分层与验证标准（V09-11） ═══════════════
//
// 设计依据：DESIGN.md §3.2（六图／技术详情三图的**当前实现与目标口径的区别**）、§11.2、
// §12.1-6／-18、附录 C.3、附录 G-3、附录 E.9；施工定义见 PLAN V09-11。
//
// 这一节只放**口径与判据**（零 React、零 node、零 IO），三处读同一份、不各写一套：
//   · 渲染层（`DataFlowView.tsx`）：把「当前实现」与「目标语义」两句话同时上屏、互相区分；
//   · 服务端读口（`src/arch/render.ts` 的 `dataFlowLayerOf` → `src/mcp/tools/getArch.ts` 返回体）：
//     MCP 调用方拿到同一份口径与同一份来源分层；
//   · 验证脚本（`scripts/verify-v09-11.ts`）：机械判据（`validateDataFlowModel`）正反两跑。
//
// **两条红线**（§3.2／§11.2「静态 import 只作线索」）：
//   ① 三张技术详情图当前共用的静态 import 依赖层**只是当前实现**，不得被说成／显示成业务数据流；
//   ② 静态 import（含「文件里出现了这个数据文件名的字符串」这类最弱线索）**不得**生成「已验证」的数据边。

/** 实体口径（§3.2：「图的实体口径＝输入源、处理节点、存储、输出/外部系统」） */
export type DataFlowEntityKind = "input_source" | "process" | "store" | "output_external";

export const DATA_FLOW_ENTITY_KINDS: readonly DataFlowEntityKind[] = [
  "input_source",
  "process",
  "store",
  "output_external",
];

export const DATA_FLOW_ENTITY_LABELS: Readonly<Record<DataFlowEntityKind, string>> = {
  input_source: "输入源",
  process: "处理节点",
  store: "存储",
  output_external: "输出/外部系统",
};

/** 关系口径（§3.2：「关系口径＝数据的产生、传递、读写与转换（不是静态 import 的取向）」） */
export type DataFlowRelationKind = "produce" | "transfer" | "read_write" | "transform";

export const DATA_FLOW_RELATION_KINDS: readonly DataFlowRelationKind[] = [
  "produce",
  "transfer",
  "read_write",
  "transform",
];

export const DATA_FLOW_RELATION_LABELS: Readonly<Record<DataFlowRelationKind, string>> = {
  produce: "产生",
  transfer: "传递",
  read_write: "读写",
  transform: "转换",
};

/** 出处三档（§3.2：「设计声明／代码静态分析／可复跑实测」）；归不进这三档的一律标 `unverified` */
export type DataFlowProvenanceTier = "design_declared" | "code_static" | "code_measured";
export type DataFlowProvenance = DataFlowProvenanceTier | "unverified";

export const DATA_FLOW_PROVENANCE_TIERS: readonly DataFlowProvenanceTier[] = [
  "design_declared",
  "code_static",
  "code_measured",
];

export const DATA_FLOW_PROVENANCE_LABELS: Readonly<Record<DataFlowProvenance, string>> = {
  design_declared: "设计声明",
  code_static: "代码静态分析",
  code_measured: "可复跑实测",
  unverified: "未核实（归不进前三档）",
};

/** 验证态（§3.2） */
export type DataFlowVerification = "verified" | "unverified" | "missing";

export const DATA_FLOW_VERIFICATION_STATES: readonly DataFlowVerification[] = ["verified", "unverified", "missing"];

export const DATA_FLOW_VERIFICATION_LABELS: Readonly<Record<DataFlowVerification, string>> = {
  verified: "已验证",
  unverified: "未核实",
  missing: "缺证",
};

/**
 * 「当前实现」的显式标注（§3.2／附录 C.3；**必须**与目标语义同时上屏且互相区分）。
 * 一个字不改地同时出现在：数据流向图画布上、`get_arch` 返回体、README 与 docs/agent-integration.md。
 */
export const DATA_FLOW_CURRENT_IMPLEMENTATION_NOTE =
  "当前实现＝三张技术图（模块方框图／数据流向图／思维导图）共用的静态 import 依赖层方向渲染：它画的是代码依赖方向，**不是**业务数据流。";

/** 「目标语义」的显式标注（§3.2／§11.2） */
export const DATA_FLOW_TARGET_SEMANTICS_NOTE =
  "数据流向图的目标语义＝业务/项目数据从输入源 → 处理节点 → 存储 → 输出/外部系统的实际路径；" +
  "关系＝数据的产生／传递／读写／转换，不是静态 import 的取向；每条关系带稳定 ID、方向与逐条出处（设计声明／代码静态分析／可复跑实测）＋验证态（已验证／未核实／缺证）。";

/**
 * 验证标准成文（可复跑判据；`validateDataFlowModel` 逐条实现，检查项⑤）：
 *
 *   R1 **哪些关系算已核实**：关系 `verification === "verified"` ⇔ 它至少有**一条有效的
 *      `code_measured` 出处**，该出处须有**正式检查记录**（`audit.self_check_recorded`／
 *      `audit.independent_audit_recorded`）引用，且其运行记录绑定**当前**源清单（现读有效、覆盖被测
 *      源码）与**当前**声明定义哈希、退出码 0、且**没有未解除的独立失败**压过它；仅"可复跑脚本存在"
 *      只是线索，不足以判已验证。运行退出码/输出摘要由执行者如实登记、系统不替其复跑（残余信任假设）。
 *      设计声明与代码静态分析**只能**支撑 `unverified`。
 *   R2 **未核实如何标注**：有有效出处但不到实测档 ⇒ `unverified`；一条有效出处都没有 ⇒ `missing`（缺证）。
 *   R3 **无效来源如何剔除**：出处靠「定位片段复算」——`find` 片段必须在 `path` 的
 *      `locator` 处原样出现（设计书按章节区间、代码按行、实测按脚本行）。复算失败、文件不存在、
 *      行号越界、脚本未登记的出处，**一律剔除**；剔除后按 R2 重判验证态，**不保留**已经不作数的出处。
 *   R4 **静态 import 不得生成已验证的数据边**：静态 import 线索只进 `static_clues`（线索字段），
 *      永不计入出处档位；`verification === "verified"` 的关系若拿不出 `code_measured` 出处 ⇒ 判违规。
 *   R5 **链上缺一环而仍标「已验证」⇒ 不合格**：链 `verification === "verified"` ⇔ 逐跳节点的
 *      验证态全部 `verified`、且链上实体覆盖输入源／处理／存储／输出·外部系统四类；
 *      缺任一环（或缺任一实体类别）⇒ 链不得标 `verified`，并写进 `missing_kinds`。
 *   R6 **覆盖对账与交付阻断**：项目所声明的每个数据输入／存储／输出都有一行覆盖；
 *      `path_found === false` 的行必须带 `gap`（缺路径原因），且这些行必须原样进 `coverage.missing_paths`；
 *      `missing_paths` 非空 ⇒ `deliverable_blocked === true`（**不得**只报缺却放行「项目可交付」）。
 */
export const DATA_FLOW_EVIDENCE_POLICY: readonly { rule: string; text: string }[] = [
  { rule: "R1", text: "verified ⇔ 至少一条有效 code_measured 出处：该出处须有**正式检查记录**（self_check／independent_audit）引用，且其运行记录绑定**当前**源清单（现读有效、覆盖被测源码）与**当前**声明定义哈希、退出码 0、且**没有未解除的独立失败**压过它；仅有可复跑脚本（脚本存在／登记在 package.json／正文提到该路径）只是线索，不足以判已验证。运行退出码/输出摘要由执行者如实登记，系统不替其复跑——『真跑过』是残余信任假设。设计声明与代码静态分析只能支撑 unverified" },
  { rule: "R2", text: "有有效出处但不到实测档 ⇒ unverified；一条有效出处都没有 ⇒ missing（缺证）" },
  { rule: "R3", text: "出处靠定位片段复算：find 必须在 path 的 locator 处原样出现；复算失败／文件不存在／行号越界／脚本未登记的出处一律剔除并按 R2 重判，不保留已不作数的出处" },
  { rule: "R4", text: "静态 import 只作线索（static_clues），永不计入出处档位；verified 拿不出 code_measured 出处 ⇒ 违规（静态线索不得生成已验证的数据边）" },
  { rule: "R5", text: "链 verified ⇔ 逐跳全部 verified 且四类实体齐全；缺一环或缺一类 ⇒ 不得标 verified，缺的类别进 missing_kinds" },
  { rule: "R6", text: "覆盖对账：path_found=false 的行必须带 gap 并进 missing_paths；missing_paths 非空 ⇒ deliverable_blocked=true，**阻断**「项目可交付」结论（不许只报缺却放行交付结论）" },
];

/** 一条出处（`find` 是复算用的定位片段，不是装饰——复算失败即按 R3 剔除） */
export interface DataFlowEvidenceRef {
  tier: DataFlowProvenanceTier;
  /** 项目内相对路径（设计文档 / 代码文件 / 可复跑脚本） */
  path: string;
  /** 落地位置：`DESIGN.md §2.6` 这类章节串，或 `src/x.ts:123` 这类 file:line */
  locator: string;
  /** 复算用的定位片段（原样出现在 path 的 locator 处；否则这条出处无效） */
  find: string;
  /** 引用来源文件的内容哈希（拿不到写 null——如实说没有，不编） */
  sha256: string | null;
  /** 这一档出处证明的是哪一段（一句话，逐条写在界面上） */
  note: string;
  /** `code_measured` 档：可复跑命令（如 `pnpm verify:v09-10`）；其他档为 null */
  rerun: string | null;
}

export interface DataFlowNode {
  /** 稳定 ID（`df-node-*`）：显示名可改，身份不随名字变（§3.2「一切按稳定 ID」） */
  id: string;
  kind: DataFlowEntityKind;
  label: string;
  /** 它在这条链里干什么（一句话） */
  role: string;
  provenance: DataFlowProvenance;
  verification: DataFlowVerification;
  evidence: DataFlowEvidenceRef[];
}

export interface DataFlowEdge {
  /** 稳定 ID（`df-edge-*`） */
  id: string;
  from: string;
  to: string;
  relation: DataFlowRelationKind;
  /** 方向显式在场：数据自 `from` 产生/流向 `to`。目前只有一种取向，故恒为 `forward`（不因此省字段） */
  direction: "forward";
  label: string;
  provenance: DataFlowProvenance;
  verification: DataFlowVerification;
  evidence: DataFlowEvidenceRef[];
  /** **只作线索**的静态 import／字符串线索（永不计入出处档位，R4） */
  static_clues: string[];
  note: string;
}

export interface DataFlowHop {
  /** 第几跳（1 基；链的顺序即数据的顺序） */
  index: number;
  node_id: string;
  /** 进入本跳的那条关系（首跳为 null：它是链的输入源，不是被某条边带进来的） */
  edge_id: string | null;
  role: string;
  /** 本跳节点的验证态（逐跳可追：链标「已验证」时每一跳都要到这一步） */
  verification: DataFlowVerification;
  /** 本跳的出处 = 该跳节点的出处 ⊕ 带它进来的那条关系的出处（缺哪一边都看得见） */
  evidence: DataFlowEvidenceRef[];
}

export interface DataFlowChain {
  id: string;
  label: string;
  hops: DataFlowHop[];
  /** 链上实体缺掉的类别（空 = 四类齐全）；非空 ⇒ 这条链不得标 verified（R5） */
  missing_kinds: DataFlowEntityKind[];
  verification: DataFlowVerification;
  note: string;
}

export interface DataFlowCoverageRow {
  /** 声明的数据输入/存储/输出的名字（设计原文里的那个写法） */
  artifact: string;
  kind: DataFlowEntityKind;
  node_id: string | null;
  /** `current` = 设计声明为现行；`declared_not_implemented` = 设计自己写明「尚未实现/未引入」 */
  declaration_status: "current" | "declared_not_implemented";
  /** 设计原文出处（逐条可追） */
  design_locator: string;
  evidence: DataFlowEvidenceRef[];
  path_found: boolean;
  /** 缺路径原因（`path_found === false` 时必填；R6） */
  gap: string | null;
}

export interface DataFlowCoverage {
  declared_total: number;
  covered: number;
  missing: number;
  not_implemented: number;
  rows: DataFlowCoverageRow[];
  /** 缺路径清单：逐条点名（非空 ⇒ 阻断「项目可交付」，R6） */
  missing_paths: string[];
  note: string;
}

export interface DataFlowModel {
  project_id: string;
  generated_at: string;
  /** ① 当前实现：静态依赖层方向渲染（与目标语义**同时可见且互相区分**） */
  current_implementation: {
    /** 恒 false：它不是业务数据流（写出来就是为了让机器也能判） */
    is_business_data_flow: false;
    modes: readonly string[];
    shared_source: string;
    note: string;
  };
  /** 目标语义口径（口径句 + 词表） */
  target_semantics: {
    entity_kinds: readonly DataFlowEntityKind[];
    relation_kinds: readonly DataFlowRelationKind[];
    note: string;
  };
  nodes: DataFlowNode[];
  edges: DataFlowEdge[];
  chains: DataFlowChain[];
  coverage: DataFlowCoverage;
  /** 交付结论是否被阻断（缺路径／缺证／链缺环 ⇒ true） */
  deliverable_blocked: boolean;
  blockers: string[];
  /** 本次复算的口径（如实交代复算了多少条出处、按 R3 剔了几条、为什么） */
  scan: {
    claims_resolved: number;
    claims_dropped: number;
    notes: string[];
  };
}

/** 机械判据的违规码（验证脚本按码断言；每条码都对应一个反例） */
export type DataFlowIssueCode =
  | "edge_missing_id"
  | "edge_missing_direction"
  | "edge_dangling_endpoint"
  | "edge_unknown_relation"
  | "edge_no_evidence"
  | "edge_unknown_provenance"
  | "edge_unknown_verification"
  | "edge_measured_without_measured_ref"
  | "edge_static_clue_marked_verified"
  | "unverified_marked_verified"
  | "node_unknown_kind"
  | "entity_kind_uncovered"
  | "chain_missing_kinds"
  | "chain_verified_with_missing_hop"
  | "coverage_gap_not_declared"
  | "coverage_missing_paths_mismatch"
  | "missing_paths_not_blocking";

export interface DataFlowIssue {
  code: DataFlowIssueCode;
  subject: string;
  detail: string;
}

const isTier = (v: string): v is DataFlowProvenanceTier =>
  (DATA_FLOW_PROVENANCE_TIERS as readonly string[]).includes(v);

/**
 * 机械判据（口径见 `DATA_FLOW_EVIDENCE_POLICY`）：违规**逐条点名**，不做"整体看起来还行"的模糊判断。
 * 真实项目的模型跑出 0 违规，反例模型必须跑出对应码——验证脚本正反两跑。
 */
export function validateDataFlowModel(model: DataFlowModel): DataFlowIssue[] {
  const issues: DataFlowIssue[] = [];
  const nodeById = new Map(model.nodes.map((n) => [n.id, n]));
  const hasMeasured = (refs: readonly DataFlowEvidenceRef[]): boolean => refs.some((r) => r.tier === "code_measured");

  for (const n of model.nodes) {
    if (!(DATA_FLOW_ENTITY_KINDS as readonly string[]).includes(n.kind)) {
      issues.push({ code: "node_unknown_kind", subject: n.id, detail: `实体类别 ${String(n.kind)} 不在四类口径里` });
    }
  }
  // R4／②：实体类别必须四类齐全（缺类别不算"覆盖输入源/处理/存储/输出"）
  for (const k of DATA_FLOW_ENTITY_KINDS) {
    if (!model.nodes.some((n) => n.kind === k)) {
      issues.push({
        code: "entity_kind_uncovered",
        subject: k,
        detail: `实体表里没有任何 ${DATA_FLOW_ENTITY_LABELS[k]} 节点：四类实体口径没落实（§3.2）`,
      });
    }
  }

  for (const e of model.edges) {
    if (e.id.trim() === "") issues.push({ code: "edge_missing_id", subject: `${e.from}->${e.to}`, detail: "关系没有稳定 ID" });
    if (e.direction !== "forward") {
      issues.push({ code: "edge_missing_direction", subject: e.id, detail: `方向字段是 ${String(e.direction)}，不是显式方向` });
    }
    if (!nodeById.has(e.from) || !nodeById.has(e.to)) {
      issues.push({
        code: "edge_dangling_endpoint",
        subject: e.id,
        detail: `端点 ${e.from}->${e.to} 有悬空（实体表里找不到），悬空边不算画得出来的数据边`,
      });
    }
    if (!(DATA_FLOW_RELATION_KINDS as readonly string[]).includes(e.relation)) {
      issues.push({ code: "edge_unknown_relation", subject: e.id, detail: `关系类别 ${String(e.relation)} 不在产生/传递/读写/转换四类里` });
    }
    // R2：出处一条都不能少（"生成无出处的数据边"就是这里拦住）
    if (e.evidence.length === 0) {
      issues.push({ code: "edge_no_evidence", subject: e.id, detail: "这条关系没有任何有效出处（逐条出处是硬要求）" });
    }
    const tiers = e.evidence.map((r) => r.tier);
    for (const t of tiers) {
      if (!isTier(t)) issues.push({ code: "edge_unknown_provenance", subject: e.id, detail: `出处档位 ${String(t)} 归不进前三档` });
    }
    if (e.provenance !== "unverified" && !isTier(e.provenance)) {
      issues.push({ code: "edge_unknown_provenance", subject: e.id, detail: `来源分层 ${String(e.provenance)} 不是三档也不是 unverified` });
    }
    if (!(DATA_FLOW_VERIFICATION_STATES as readonly string[]).includes(e.verification)) {
      issues.push({ code: "edge_unknown_verification", subject: e.id, detail: `验证态 ${String(e.verification)} 不在已验证/未核实/缺证里` });
    }
    // R1：标「已验证」必须拿得出可复跑实测出处
    if (e.verification === "verified" && !hasMeasured(e.evidence)) {
      issues.push({
        code: "edge_static_clue_marked_verified",
        subject: e.id,
        detail:
          "标了「已验证」却拿不出任何 code_measured 出处（只有设计声明／代码静态／静态 import 线索）——" +
          "静态线索不得生成已验证的数据边（§3.2）",
      });
    }
    // R1 反面：声称来源分层是"可复跑实测"却没有实测出处
    if (e.provenance === "code_measured" && !hasMeasured(e.evidence)) {
      issues.push({ code: "edge_measured_without_measured_ref", subject: e.id, detail: "来源分层写「可复跑实测」，但没有一条 code_measured 出处" });
    }
    if (e.provenance === "unverified" && e.verification === "verified") {
      issues.push({ code: "unverified_marked_verified", subject: e.id, detail: "来源标「未核实（归不进前三档）」却标了「已验证」，自相矛盾" });
    }
  }

  // R5：链的完整性判据（缺环／缺类别不得标 verified）
  const edgeById = new Map(model.edges.map((e) => [e.id, e]));
  for (const c of model.chains) {
    const kinds = new Set(c.hops.map((h) => nodeById.get(h.node_id)?.kind).filter((k): k is DataFlowEntityKind => k !== undefined));
    const missing = DATA_FLOW_ENTITY_KINDS.filter((k) => !kinds.has(k));
    if (JSON.stringify([...missing].sort()) !== JSON.stringify([...c.missing_kinds].sort())) {
      issues.push({
        code: "chain_missing_kinds",
        subject: c.id,
        detail: `链上实际缺 ${missing.join("、") || "无"}，但 missing_kinds 写的是 ${c.missing_kinds.join("、") || "无"}（缺环要如实报）`,
      });
    }
    const hopUnverified = c.hops
      .map((h) => ({ h, n: nodeById.get(h.node_id) }))
      .filter(({ n }) => n === undefined || n.verification !== "verified");
    // 环 = 一跳的「节点 + 带它进来的那条关系」：关系没到已验证，这一跳同样不算走通
    const edgeUnverified = c.hops
      .map((h) => h.edge_id)
      .filter((id): id is string => id !== null)
      .filter((id) => (edgeById.get(id)?.verification ?? "missing") !== "verified");
    if (c.verification === "verified" && (missing.length > 0 || hopUnverified.length > 0 || edgeUnverified.length > 0)) {
      issues.push({
        code: "chain_verified_with_missing_hop",
        subject: c.id,
        detail:
          `链标了「已验证」但${missing.length > 0 ? `缺实体类别 ${missing.join("、")}` : ""}` +
          `${missing.length > 0 && (hopUnverified.length > 0 || edgeUnverified.length > 0) ? "、" : ""}` +
          `${hopUnverified.length > 0 ? `有 ${hopUnverified.length} 跳没到已验证（${hopUnverified.map((x) => x.h.node_id).join("、")}）` : ""}` +
          `${(hopUnverified.length > 0 || missing.length > 0) && edgeUnverified.length > 0 ? "、" : ""}` +
          `${edgeUnverified.length > 0 ? `${edgeUnverified.length} 条关系没到已验证（${edgeUnverified.join("、")}）` : ""}` +
          "——链上缺一环而仍标已验证 ⇒ 不合格",
      });
    }
  }

  // R6：覆盖对账与交付阻断
  const gapRows = model.coverage.rows.filter((r) => !r.path_found);
  for (const r of gapRows) {
    if (r.gap === null || r.gap.trim() === "") {
      issues.push({ code: "coverage_gap_not_declared", subject: r.artifact, detail: "没有路径却没有写缺路径原因（缺环必须显式报缺）" });
    }
  }
  const expectedMissing = gapRows
    .filter((r) => r.declaration_status === "current")
    .map((r) => r.artifact)
    .sort();
  if (JSON.stringify(expectedMissing) !== JSON.stringify([...model.coverage.missing_paths].sort())) {
    issues.push({
      code: "coverage_missing_paths_mismatch",
      subject: "coverage",
      detail: `缺路径清单（${model.coverage.missing_paths.join("、") || "空"}）与覆盖表实缺（${expectedMissing.join("、") || "空"}）对不上`,
    });
  }
  if (model.coverage.missing_paths.length > 0 && !model.deliverable_blocked) {
    issues.push({
      code: "missing_paths_not_blocking",
      subject: "coverage",
      detail: `报了 ${model.coverage.missing_paths.length} 条缺路径却仍给「项目可交付」结论（缺路径必须阻断交付结论）`,
    });
  }
  return issues;
}

/** 交付阻断判据（一处实现）：缺路径／缺证关系／缺环链都进 blockers，并置 `deliverable_blocked` */
export function dataFlowBlockersOf(input: {
  missing_paths: readonly string[];
  edges: readonly DataFlowEdge[];
  chains: readonly DataFlowChain[];
}): string[] {
  const out: string[] = [];
  for (const a of input.missing_paths) out.push(`缺路径：声明的数据输入/存储/输出「${a}」没有找到路径与证据`);
  for (const e of input.edges) {
    if (e.verification === "missing") out.push(`缺证：关系 ${e.id}（${e.label}）没有任何有效出处`);
  }
  for (const c of input.chains) {
    if (c.missing_kinds.length > 0) {
      out.push(`链缺环：${c.id} 缺 ${c.missing_kinds.map((k) => DATA_FLOW_ENTITY_LABELS[k]).join("、")}`);
    }
  }
  return out;
}

/** 一条关系／实体该标什么验证态（R1／R2 的唯一实现，供派生层调用） */
export function verificationOf(evidence: readonly DataFlowEvidenceRef[]): DataFlowVerification {
  if (evidence.length === 0) return "missing";
  return evidence.some((r) => r.tier === "code_measured") ? "verified" : "unverified";
}

/** 来源分层（R4：静态线索不算档位；这里只认出处表） */
export function provenanceOf(evidence: readonly DataFlowEvidenceRef[]): DataFlowProvenance {
  for (const t of ["code_measured", "design_declared", "code_static"] as const) {
    if (evidence.some((r) => r.tier === t)) return t;
  }
  return "unverified";
}
