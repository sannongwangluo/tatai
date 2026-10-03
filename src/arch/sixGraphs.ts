// V09-19：**六图完整当前状态**的服务端读口（DESIGN.md §6.4 `get_project_graphs`、§6.7 六图摘要；附录 E.18 四）。
//
// 为什么要有它：Agent 接上塔台后，`project_entry` 只说任务/基线与下一动作，六张图的**当前状态**读不到——
// 它得先读仓库代码、或从截图猜，才知道「这六张图各是什么、算到哪一版、哪里没验证、下一步读什么」。
// 本模块把这件事做成**一次结构化读取**，并守住三条红线：
//
//   ① **同源**：图面与状态**复用既有唯一实现**，不另造第二套——
//      `.工作台/arch/blueprint.json`（规划层）＋`src/ui/arch/projectGraph.ts#buildViewModel`（三主视图视图模型）
//      ＋`src/arch/render.ts`（技术详情共用数据层）＋`src/arch/dataflow.ts#analyzeDataFlow`（数据流向来源分层）
//      ＋`src/arch/mindmap.ts#buildMindTree`（思维导图取数）＋`src/ui/arch/provenance.ts`（来源/映射/证据状态/
//      交付阻断的唯一判据）＋`src/ui/arch/statusColor.ts`（颜色与短标的唯一出处）。界面、HTTP 与 MCP 读同一份。
//   ② **完整**：不许静默截断后仍称「全图」——超过安全上限必须给 `total`／`returned`／同一快照 `cursor`
//      与 `incomplete:true`，并允许续取。
//   ③ **如实**：更新中／失败／过期返回真实状态与原因；预计用时只用有依据的实测值（依据不足就说「无法估计」）；
//      模型提案待审线索**单列**，不混进正式节点/关系；交付读数、工作流 `next_action`、用户 Gate 三件事分开表达。
//
// 只读：不写盘、不调模型、不给纳管项目加运行时埋点。
import { getProject, resolveDataDir } from "../server/registry";
import { projectWithReleases } from "../server/work/entry";
import { projectWorkDir, WsError } from "../server/workstation";
import { eventsSnapshotOf, type EventsSnapshot } from "../server/work/statusProjection";
import { graphUpdateOf } from "../server/work/graphRefresh";
import { semanticStateOf, type SemanticStateView } from "./blueprintAuto";
import {
  archProvenanceModelOf,
  draftBlueprintOf,
  planningLayerInput,
  readBlueprint,
  readBlueprintSources,
  viewGraphWithPlan,
  type Blueprint,
  type BlueprintModelLead,
  type BlueprintNodeLead,
} from "./blueprint";
import { dataFlowLayerOf } from "./render";
import { declaredLinksOf, readLastReconcile } from "./reconcile";
import { buildMindTree, type MindTree } from "./mindmap";
import { mergePlanningLayer, selectGraph, type SharedGraph } from "./shared-graph";
import { ARCH_UNLIMITED_LIMITS, JUNK_DIR_SEGMENTS } from "./config";
import { graphInputSha, sha256Hex, unlimitedGraphOf } from "./items";
import { legacyAggregationOf, readModules, type ArchModulesFile } from "./parse";
import {
  buildViewModel,
  capabilityClassTableStateOf,
  graphUpdateBannerOf,
  GRAPH_UPDATE_ETA_UNKNOWN,
  GRAPH_UPDATE_SCOPES,
  moduleStatusKeysOf,
  planCodeNodeIdOf,
  technicalIdOf,
  taskDerivedModuleStatus,
  type ProjectViewModel,
  type ProjectionIndex,
  type ViewEdge,
  type ViewNode,
  type NodeStatus,
} from "../ui/arch/projectGraph";
import type { ProvenanceAnnotation, ProvenanceModel } from "../ui/arch/provenance";
import { DISPLAY_STATUS_PALETTE, NO_STATUS_RECORD_KEY, statusStyle } from "../ui/arch/statusColor";

// ───────────────────────────────── 口径常量 ─────────────────────────────────

export type SixGraphKey = "functional" | "architecture" | "construction" | "module_map" | "data_flow" | "mind_map";

/** 六图（用户口径，2026-09-24）：三张主视图 ＋ 三张技术详情图（映射见 DESIGN 附录 E.5） */
export const SIX_GRAPH_KEYS: readonly SixGraphKey[] = [
  "functional",
  "architecture",
  "construction",
  "module_map",
  "data_flow",
  "mind_map",
];

export interface SixGraphMeta {
  key: SixGraphKey;
  title: string;
  layer: "main_view" | "tech_detail";
  question: string;
  /** 节点/关系取数口（如实写明本读口走的是哪一份既有实现，便于调用方核对同源） */
  source: string;
  note: string;
}

export const SIX_GRAPH_META: Readonly<Record<SixGraphKey, SixGraphMeta>> = {
  functional: {
    key: "functional",
    title: "功能全景",
    layer: "main_view",
    question: "项目能为人做什么，哪些能力已经验证",
    source: "蓝图（.工作台/arch/blueprint.json）＋ buildViewModel(view=functional)",
    note: "只含**功能能力**分组；设计/治理章节不在本视图作为能力节点（§3.2 能力分类声明）",
  },
  architecture: {
    key: "architecture",
    title: "系统架构",
    layer: "main_view",
    question: "这些能力由哪些模块协作实现",
    source: "蓝图 ＋ buildViewModel(view=architecture)",
    note: "保留全部 level-2 章节分组并逐组标注分类；治理章节分组带「非产品功能能力」限定",
  },
  construction: {
    key: "construction",
    layer: "main_view",
    title: "施工依赖",
    question: "当前变更有哪些工作、哪些先后依赖、哪里受阻",
    source: "蓝图 ＋ buildViewModel(view=construction)",
    note: "任务节点本身不分组；有向依赖图，允许多前置（§3.3）",
  },
  module_map: {
    key: "module_map",
    title: "模块方框图",
    layer: "tech_detail",
    question: "代码顶层模块与依赖长什么样",
    source: "viewGraphWithPlan ＋ selectGraph(MODULE_BOX)",
    note: "**当前实现**＝静态 import 依赖层（tree-sitter 解析 + 聊天补全层），节点状态取 v2 证据派生",
  },
  data_flow: {
    key: "data_flow",
    title: "数据流向图",
    layer: "tech_detail",
    question: "数据从哪来、经过什么、存到哪、流向谁",
    source: "selectGraph(DATA_FLOW) ＋ analyzeDataFlow（来源分层）",
    note:
      "**必须分两层读**：`current_implementation`＝当前实现（三张技术图共用的静态 import 依赖层方向渲染，**不是**业务数据流）；" +
      "`target_semantics`＝目标口径（输入源→处理→存储→输出/外部系统的实际路径，逐条带出处与验证态、含已验证链与缺口）。静态 import 只作线索，不得称为已验证业务数据流（§3.2／§11.2）",
  },
  mind_map: {
    key: "mind_map",
    title: "思维导图",
    layer: "tech_detail",
    question: "层级结构一览，适合快速总览与折叠",
    source: "buildMindTree（内部走 MIND_MAP 选择器）",
    note: "顶层与层级边＝共用数据层同一份；更深层级按需懒加载（A4 expand），本读口给未展开的顶层树",
  },
};

/**
 * **全部六图**一次读取的安全上限（对象条数）——按**整份响应**的返回条数计（六图共用这一份预算）。
 * 依据：塔台当前规模实测 396 个证据对象／321 条关系边／75 个节点（2026-09-26 复算），
 * 一次「全部六图」请求应返回完整数据；上限只拦住**远超当前规模**的项目，
 * 触发时按 `total`/`returned`/`cursor`/`cursors`/`incomplete` 如实给分页并**允许续取到终点**，**不静默截断**。
 * 预算按图顺序消耗：被截断那张图的 `cursors[k]` 指向本图下一位置，其余未取完的图从 0 续取（F-1 返工）。
 */
export const SIX_GRAPH_OBJECT_LIMIT = 4000;

// ───────────────────────────────── 逐对象状态 ─────────────────────────────────

/** 逐对象的**状态与证据**（读口与界面同一份判据：状态键/短标/颜色取自 `statusColor`，证据取自 `provenance`） */
export interface GraphObjectState {
  object_id: string;
  label: string;
  /** 对象种类（node kind / edge kind） */
  kind: string;
  object_kind: "node" | "edge";
  /** 上屏键（六态 / `no_status_record` / 未映射 `unmapped`；**不是** v1 自报四色） */
  status_key: string | null;
  /** 界面短标（与画布/主视图**同词**） */
  status_short: string;
  /** 颜色口径（同一份调色表；给 hex 与 tailwind 类，界面怎么画这里就怎么标） */
  status_color: { hex: string; border: string; text: string } | null;
  /** 状态从哪来的口径句（服务端为该对象算的 / 本视图汇总的） */
  status_basis: string | null;
  /** 着色口径说明（为什么是这个色/为什么不着色） */
  status_note: string;
  capability_class: "functional" | "governance" | "unknown" | null;
  source_kinds: string[];
  source_kind_label: string;
  unmapped: boolean;
  mapping: {
    requirement_ids: string[];
    dangling_requirement_ids: string[];
    design_refs: { path: string; locator: string; sha256: string | null }[];
    code_refs: { path: string; locator: string; sha256: string | null }[];
  } | null;
  evidence_state: string | null;
  evidence_state_label: string | null;
  /** 有效版本（本对象结论所依据的基线/来源修订；从快照取，逐对象如实标注） */
  effective_version: string | null;
  blockers: string[];
  user_pending: boolean;
  user_actions: string[];
  /** 判据句（唯一出处 `provenance.evidenceStateOf`） */
  basis: string | null;
}

/** 状态键 → 界面短标与颜色（**唯一出处** `src/ui/arch/statusColor.ts`，读口不另算） */
export function statusViewOf(key: string | null): {
  short: string;
  color: { hex: string; border: string; text: string } | null;
  note: string;
} {
  if (key === null) {
    return {
      short: "未映射",
      color: null,
      note: "该对象没有可判定的状态（未映射/无投影对象）：不空集判绿、不着完成色（§4.2）",
    };
  }
  const st = statusStyle(key);
  const palette = (DISPLAY_STATUS_PALETTE as Record<string, { short: string; full: string; dashed?: true }>)[key];
  return {
    short: key === "unmapped" ? "未映射" : st.label,
    color: { hex: st.hex, border: st.border, text: st.text },
    note:
      palette !== undefined
        ? palette.full + (palette.dashed === true ? "（虚线画，不用纯色糊过去）" : "")
        : "状态键不在六态/无状态记录表里：按未映射处理（不涂绿）",
  };
}

function objectStateOf(
  objectId: string,
  label: string,
  kind: string,
  objectKind: "node" | "edge",
  statusKey: string | null,
  statusShort: string | undefined,
  statusBasis: string | null,
  annotation: ProvenanceAnnotation | null,
  effectiveVersion: string | null,
  capabilityClass: "functional" | "governance" | "unknown" | null,
): GraphObjectState {
  const view = statusViewOf(statusKey);
  const statusNote =
    statusKey === NO_STATUS_RECORD_KEY
      ? "灰虚线：无状态记录（没有任务通过实现映射指向它，也没有设计模块清单落点）——不冒充「已规划/未开始」"
      : view.note;
  return {
    object_id: objectId,
    label,
    kind,
    object_kind: objectKind,
    status_key: statusKey,
    status_short: statusShort ?? view.short,
    status_color: view.color,
    status_basis: statusBasis,
    status_note: statusNote,
    capability_class: capabilityClass,
    source_kinds: annotation === null ? [] : [...annotation.source_kinds],
    source_kind_label: annotation === null ? "未映射（没有需求／设计／代码来源）" : annotation.source_kind_label,
    unmapped: annotation === null ? true : annotation.unmapped,
    mapping:
      annotation === null
        ? null
        : {
            requirement_ids: [...annotation.mapping.requirement_ids],
            dangling_requirement_ids: [...annotation.mapping.dangling_requirement_ids],
            design_refs: annotation.mapping.design_refs.map((r) => ({ ...r })),
            code_refs: annotation.mapping.code_refs.map((r) => ({ ...r })),
          },
    evidence_state: annotation === null ? "missing" : annotation.evidence_state,
    evidence_state_label: annotation === null ? "缺证（项目里没有该对象的标注）" : annotation.evidence_state_label,
    effective_version: effectiveVersion,
    blockers: annotation === null ? ["项目里查不到该对象的来源/证据标注（不涂绿）"] : [...annotation.blockers],
    user_pending: annotation === null ? false : annotation.user_pending,
    user_actions: annotation === null ? [] : [...annotation.user_actions],
    basis: annotation === null ? null : annotation.basis,
  };
}

// ───────────────────────────────── 六图各自载荷 ─────────────────────────────────

export interface GraphNodeEntry {
  id: string;
  label: string;
  kind: string;
  /** 概览分组键（分组节点＝自己；成员节点＝所属分组；施工依赖＝null） */
  group_key: string | null;
  members: string[];
  hidden_members: number;
  /** 本节点在技术详情里的对应 id（对不上＝null，如实说「无对应」） */
  technical_id: string | null;
  aggregate?: true;
  endpoint?: true;
  /** 关系的语义（端点节点带上它，说明它是"因为哪类线才出现在这里"） */
  via_semantics?: string;
  /** 完整状态与证据（逐对象带稳定 ID、状态键、短标、颜色、来源、映射、证据状态、有效版本、阻断、用户待验） */
  object: GraphObjectState;
  /** 2026-09-29 六图完整读取轮：技术层三图的节点**构建层**标记（code＝静态解析模块、plan＝已发布
   *  蓝图并入的规划层灰节点、chat＝聊天补全层；聚合节点 __more__ 归 code）。与 object.source_kinds
   *  是两回事（那是需求/设计/代码**出处**标注；本字段说的是这个节点从哪一层构建进来）。主视图节点不带。 */
  origin_layer?: "code" | "plan" | "chat";
}

export interface GraphEdgeEntry {
  id: string;
  from: string;
  to: string;
  kind: string;
  certainty: string;
  semantics: string;
  /** 该关系的稳定 ID 与来源（逐条可追） */
  sources: { kind: string; path: string; locator: string; sha256: string | null }[];
  note: string;
  /** 同组关系（两端解析到同一分组节点）所在分组；非空 ⇒ 本条只在 `intra_relations` 里，不画连线 */
  group_key?: string;
  object: GraphObjectState;
}

export interface GraphPayload {
  key: SixGraphKey;
  title: string;
  layer: "main_view" | "tech_detail";
  question: string;
  source: string;
  note: string;
  /** V09-22：本图本次用的模式（overview＝概览默认聚合；full＝全量，同一 builder 换上限参数） */
  mode: "overview" | "full";
  /** 本图的实体计数（**本图实际返回的**，与截断/聚合账目分开） */
  counts: {
    nodes: number;
    edges: number;
    groups: number;
    intra_relations: number;
    aggregate_node: boolean;
    /** 被上限聚合掉、本图不再逐条列出的节点数（>0 时界面上显示数量） */
    hidden_members: number;
    /** 本图被**安全上限**截断而未返回的条数（>0 ⇒ 顶层 `incomplete:true` 并给 cursor） */
    truncated_by_limit: number;
    /** V09-22：**底层候选总数**（区分「本页/本图返回数」）：主视图＝概览分组总数（含被折叠的），
     *  技术层三图＝**未聚合并集真值**（ARCH_UNLIMITED_LIMITS 构建的候选规模，两种模式同一口径） */
    underlying_nodes: number;
    /** V09-22：**底层边候选总数**：主视图＝model.edges + intra_relations；技术层三图＝未聚合并集的
     *  全量边总数（现边 + 被截断边 + 两层扇出过滤丢弃边；无上限口径下即 graph.edges.length） */
    underlying_edges: number;
    /** 2026-09-29 六图完整读取轮：技术层三图的**来源分层计数**（共用数据层整图口径，不随本页分页变）：
     *  code＝静态解析模块（采集层 2026-09-29 起不再有损合并，超 15 个照常落盘）、
     *  plan＝已发布蓝图并入的规划层灰节点（plan_origin:"plan"，并入在 §4.3 上限之后、不被 15 裁）、
     *  chat＝聊天补全层（origin:"chat"，历史/分析来源，不升格审定架构）。
     *  主视图不给这个键（它们的节点都是规划层对象，分层无意义）。 */
    by_origin?: { code: number; plan: number; chat: number };
    /** V09-22 返工 F4：来源分层的**底层未聚合并集**口径（技术层三图，字段集与 by_origin 相同）——
     *  by_origin 只数本图可见真实实体（__more__ 聚合占位不计入），真实代码模块数读这里；
     *  隐藏的真实代码模块数＝by_origin_underlying.code − by_origin.code。主视图不给这个键。 */
    by_origin_underlying?: { code: number; plan: number; chat: number };
  };
  groups: { key: string; label: string; members: string[] }[];
  nodes: GraphNodeEntry[];
  edges: GraphEdgeEntry[];
  /** §3.2 同组关系可见性：两端落在同一分组关系**逐条列出**（不画自环、不伪造跨组边） */
  intra_relations: GraphEdgeEntry[];
  /** 口径说明（视图口径 + 数量口径，逐条上屏；与界面 `buildViewModel(...).notes` 同一份） */
  notes: string[];
  /** 技术详情三图额外带：当前实现/目标口径的区分（数据流向图必带） */
  tech?: unknown;
}

// ───────────────────────────────── 快照 ─────────────────────────────────

export interface SixGraphSnapshot {
  project_id: string;
  /** **同一快照标识**：本次读取的六个图共用的一个标识（基线 + 生成时刻 + 来源修订） */
  snapshot_id: string;
  baseline: {
    baseline_id: string | null;
    design_revision: string | null;
    plan_revision: string | null;
    plan_definition_revision: string | null;
  };
  /** 图的生成时刻（蓝图 `generated_at`；没有图时为 null） */
  generated_at: string | null;
  /** 本次读取时刻 */
  read_at: string;
  graph_state: {
    /** 有图可读 / 没有已发布图（只有草稿）/ 连草稿都没有 */
    availability: "published" | "draft_only" | "none";
    /** 图更新状态（§3.3／§4.4）：updating / ready / stale / failed；没有记录＝null */
    update_state: string | null;
    update_phase: string | null;
    update_scope: string | null;
    update_reason: string | null;
    /** 有依据的预计用时文案（依据不足＝「无法估计」，**不编造 ETA**） */
    update_eta_text: string | null;
    update_started_at: string | null;
    update_updated_at: string | null;
    /** 图新鲜度横幅（与界面同一份 `graphUpdateBannerOf`／`freshnessOf` 判据） */
    banners: string[];
    semantic_state: string | null;
    semantic_note: string | null;
  };
  /** 异常（逐条点名，读口不掩盖）：图不可读、能力分类表损坏、蓝图未发布、解析未就绪等 */
  anomalies: string[];
  /** V09-22 返工（F5）：采集完整性（机器可判读；与分页 completeness 语义独立、可同时成立） */
  collection: {
    status: "not_parsed" | "unknown" | "incomplete" | "complete";
    budget_exhausted: boolean | null;
    legacy_other_bucket: boolean;
    legacy_merged_prefixes: number;
    reasons: string[];
    ignored_dir_segments: string[];
  };
  graphs: Partial<Record<SixGraphKey, GraphPayload>>;
  /** 交付读数（§4.2：可请求验收／不可判定项目可交付；**仍不等于用户接受**） */
  delivery: {
    verdict: string;
    conclusion: string;
    deliverable_allowed: boolean;
    reasons: string[];
    user_pending_items: string[];
    counts: Record<string, number>;
    note: string;
    user_accepted: false;
  } | null;
  /** 模型提案**待审线索**（未审定）：单列，不混进正式节点/关系、不计入任何读数（§4.1） */
  model_leads: BlueprintModelLead[];
  model_node_leads: BlueprintNodeLead[];
  /** 能力分类声明表状态与逐项问题（R-1：损坏时读口必须如实带出） */
  capability_classes: {
    declared: boolean;
    table_state: "declared" | "undeclared" | "broken";
    issues: { kind: string; chapter: number | null; detail: string; blocking: boolean }[];
    note: string;
  } | null;
  /** 完整性：本次请求是否被安全上限截断（**不许静默截断后仍称全图**；F-1 返工按「每张图是否取完」判定） */
  completeness: {
    complete: boolean;
    /** `!complete` 的显式标记（契约里叫 `incomplete`：调用方不必自己取反） */
    incomplete: boolean;
    /** 本次请求涉及的图**总条数**（不随页变化） */
    total: number;
    /** **本页**实际返回的条数（分页时是每页的量，不是累计量） */
    returned: number;
    /**
     * **单图**续取游标：`<snapshot_id>:<mode>:<graphKey>:<下一位置>`（V09-22 契约 4 四段制），与
     * `cursors[graphKey]` **同一口径同一位置**；单图请求（或按游标续的那张图）未取完时给出，
     * `complete:true`／合并视图时为 null（合并视图没有单一游标）。旧三段 `<snapshot_id>:<graphKey>:<offset>` 按 overview 兼容解释。
     */
    cursor: string | null;
    /** **逐图**续取游标（只列本次请求里未取完的那几张；拿着它带 `graph=<key>` 续取该图直到 complete） */
    cursors: Partial<Record<SixGraphKey, string>>;
    limit: number;
    note: string;
  };
  /** 下一读取入口（Agent 读完摘要后该调什么） */
  next_read_entry: {
    tool: string;
    args: Record<string, unknown>;
    note: string;
  };
  /** 三种「到哪一步」**分开表达**（不得混为「已交付」） */
  separate_readouts: {
    delivery_verdict: string | null;
    workflow_next_action: string | null;
    user_gate: string;
    note: string;
  };
}

// ───────────────────────────────── 主入口 ─────────────────────────────────

export interface SixGraphOptions {
  dataDir?: string;
  /**
   * V09-22：读取模式。`overview`（缺省）＝概览（主视图 5–15 分组聚合、技术层 15 节点/40 边上限，
   * 隐藏量进 counts.hidden_members）；`full`＝全量（同一份 builder 换**未聚合并集**上限组
   * `ARCH_UNLIMITED_LIMITS`：主视图分组全列、技术层节点/边不再聚合截断、扇出过滤关闭，
   * 上限外对象逐项可取，配 `cursor`（四段制 `<snapshot_id>:<mode>:<graphKey>:<offset>`）同快照分页）。
   * 两种模式同一快照标识与节点身份；游标**跨模式明确拒绝**（不能拿概览游标续 full）。
   */
  mode?: "overview" | "full";
  /** 指定单图（缺省 = 全部六图） */
  graph?: SixGraphKey;
  /** 指定节点（稳定 ID：规划节点 `plan:...` 或技术模块 id） */
  node_id?: string;
  /** 指定关系（稳定关系 ID：`<from>|<to>|<kind>` 或视图边 id） */
  relation_id?: string;
  /** 分页游标（上一轮 `completeness.cursor`） */
  cursor?: string | null;
  /** 分页上限（缺省 `SIX_GRAPH_OBJECT_LIMIT`） */
  limit?: number;
  /** 只算**摘要与计数**（接续入口用）：不给逐条对象，省掉逐对象标注映射的开销 */
  summary_only?: boolean;
  /**
   * V09-31：**本次请求已经现读的事件快照**（宿主只读入口一次取快照后同时喂入口/图摘要/同步判据，
   * 三者同版）。来源 `work_dir` 与本项目不一致就不复用（回退本函数现读）；缺省＝自己现读，行为逐字不变。
   */
  events?: EventsSnapshot;
}

/** 计划层节点 id → 该节点在证据标注表里的键（与技术详情画布同一套口径 `planCodeNodeIdOf`） */
const annotationOfId = (model: ProvenanceModel | null, id: string): ProvenanceAnnotation | null => {
  if (model === null) return null;
  return model.by_object[planCodeNodeIdOf(id)] ?? model.by_object[id] ?? null;
};

// ───────────────────────────────── V09-22 全量模式的共用口径 ─────────────────────────────────

/**
 * 两种模式**都**如实标注的来源与完整性口径（§4.3／V09-22 任务书 §1.5；不宣称假全量）：
 *   ① 采集侧 `budget_exhausted===true` 时（仅此时）；
 *   ② 常驻：规则忽略目录按规则不入图（不是遗漏）；
 *   ③ 存在 `origin:chat` 节点时：聊天补全层是模型产出/待审线索，不是已验证代码事实。
 * `mode==="full"` 时每条以「全量模式＝未聚合并集的分页遍历（上限外对象逐项可取）：」开头——
 * full 给的是**未聚合并集**（上限全抬到 1e9，builder 不聚合/不截断），但采集残缺仍如实存在，不是"全量"。
 */
function completenessNotesOf(input: {
  mode: "overview" | "full";
  budget_exhausted: boolean | null;
  has_chat_nodes: boolean;
}): string[] {
  const head = input.mode === "full" ? "全量模式＝未聚合并集的分页遍历（上限外对象逐项可取）：" : "";
  const out: string[] = [];
  if (input.budget_exhausted === true) {
    out.push(
      `${head}⚠ 采集侧不完整（budget_exhausted）：本图节点集只含已扫到的部分——` +
        "全量模式解除的是渲染上限聚合，采集残缺仍如实存在，不是全量",
    );
  }
  out.push(
    `${head}规则忽略目录（node_modules/.git/dist/build/target/缓存等，config.ts JUNK_DIR_SEGMENTS）` +
      "按规则不入图：这是规则性排除，不是遗漏",
  );
  if (input.has_chat_nodes) {
    out.push(
      `${head}聊天补全层节点带 origin:chat（模型产出、待审线索），不是已验证代码事实；` +
        "蓝图模型提案见 model_leads/model_node_leads（单列待审）",
    );
  }
  return out;
}

/** V09-22：一份图自身的候选账目（节点＝非聚合节点 + 被聚合节点；边＝现边 + 截断边 + 两层扇出丢弃）。
 *  注意：概览图喂进来时这个账目**偏小**——被节点聚合重定向合并掉的边（隐藏节点之间、隐藏→可见
 *  的多条边并成一条/自环消失）不在任何截断计数里（实测概览 29 边 vs 底层 180）。所以"底层候选
 *  总数"的唯一口径是下面 sixGraphsOf 里的 `underlyingCountsOf`（按全量上限再构建一遍取真值），
 *  本函数只作它的计算核与读不出全量构建时的降级账目。 */
function underlyingCountsOfGraph(graph: SharedGraph): { nodes: number; edges: number } {
  const layers = graph.truncated.layers;
  return {
    nodes: graph.nodes.filter((n) => n.aggregate !== true).length + graph.truncated.nodes,
    edges:
      graph.edges.length +
      graph.truncated.edges +
      (layers?.parse.fanout ?? 0) +
      (layers?.merged.fanout ?? 0),
  };
}

function viewNodeEntries(
  model: ProjectViewModel,
  provenance: ProvenanceModel | null,
  effectiveVersion: string | null,
): GraphNodeEntry[] {
  return model.nodes.map((n: ViewNode) => {
    const key = n.status.display ?? (n.status.kind === "unmapped" ? "unmapped" : NO_STATUS_RECORD_KEY);
    const annotation = annotationOfId(provenance, n.id);
    return {
      id: n.id,
      label: n.label,
      kind: n.kind,
      group_key: n.group_key,
      members: [...n.members],
      hidden_members: n.hidden_members,
      technical_id: n.technical_id,
      ...(n.aggregate === true ? { aggregate: true as const } : {}),
      ...(n.endpoint === true ? { endpoint: true as const } : {}),
      ...(n.via_semantics === undefined ? {} : { via_semantics: n.via_semantics }),
      object: objectStateOf(
        n.id,
        n.label,
        n.kind,
        "node",
        key,
        n.status.short,
        n.status.basis,
        annotation,
        effectiveVersion,
        n.capability_class ?? null,
      ),
    };
  });
}

function viewEdgeEntries(
  edges: readonly ViewEdge[],
  provenance: ProvenanceModel | null,
  effectiveVersion: string | null,
): GraphEdgeEntry[] {
  return edges.map((e) => ({
    id: e.id,
    from: e.from,
    to: e.to,
    kind: e.kind,
    certainty: e.certainty,
    semantics: e.semantics,
    sources: e.sources.map((s) => ({ kind: s.kind, path: s.path, locator: s.locator, sha256: s.sha256 })),
    note: e.note,
    ...(e.group_key === undefined ? {} : { group_key: e.group_key }),
    object: objectStateOf(
      e.id,
      `${e.from} → ${e.to}`,
      e.kind,
      "edge",
      e.status,
      undefined,
      e.status_projection === null ? null : "状态取自依赖释放结论（§4.2：施工依赖线只表示前置交付是否满足）",
      annotationOfId(provenance, e.id),
      effectiveVersion,
      null,
    ),
  }));
}

/** 一张图的分页切片结果（`end`＝下一位置；`complete`＝**本图**已取完） */
interface GraphPage {
  nodes: GraphNodeEntry[];
  edges: GraphEdgeEntry[];
  intra: GraphEdgeEntry[];
  total: number;
  end: number;
  delivered: number;
  truncated: number;
  complete: boolean;
}

/**
 * 一张图的分页切片（F-1 返工，DESIGN §6.4）。规则：
 *  · 把**本图**的节点／关系／同组关系合成**单一有序序列**，再按 `[offset, offset+cap)` 切一刀——
 *    三段列表各自用同一个 offset 切片正是 F-1 的根因（跳段、重复、漏交付）；
 *  · 游标只有一个口径：`下一位置 = offset + 本页实际返回条数`（就是本图已交付到的位置），
 *    顶层 cursor 与逐图 cursors 因此不可能互相矛盾；
 *  · `offset + 本页返回 ≥ 本图总条数` 才算**本图取完**（不是拿本页条数与全局总量比——那样续取态永假）。
 */
function paginateGraph(
  nodes: GraphNodeEntry[],
  edges: GraphEdgeEntry[],
  intra: GraphEdgeEntry[],
  offset: number,
  cap: number,
): GraphPage {
  const ordered: { t: "n" | "e" | "i"; row: GraphNodeEntry | GraphEdgeEntry }[] = [
    ...nodes.map((row) => ({ t: "n" as const, row })),
    ...edges.map((row) => ({ t: "e" as const, row })),
    ...intra.map((row) => ({ t: "i" as const, row })),
  ];
  const total = ordered.length;
  const start = Math.min(Math.max(0, offset), total);
  const end = Math.min(start + Math.max(0, cap), total);
  const page = ordered.slice(start, end);
  return {
    nodes: page.filter((x) => x.t === "n").map((x) => x.row as GraphNodeEntry),
    edges: page.filter((x) => x.t === "e").map((x) => x.row as GraphEdgeEntry),
    intra: page.filter((x) => x.t === "i").map((x) => x.row as GraphEdgeEntry),
    total,
    end,
    delivered: page.length,
    truncated: total - end,
    complete: end >= total,
  };
}

/** 摘要模式（`project_entry`）：只报计数，不给逐条对象 */
function summaryPage(total: number): GraphPage {
  return { nodes: [], edges: [], intra: [], total, end: 0, delivered: 0, truncated: 0, complete: true };
}

/**
 * 续取游标：`<snapshot_id>:<mode>:<graphKey>:<offset>`（V09-22 契约 4 四段制）。
 * 校验顺序 = 格式 → **快照** → **模式** → 图键 → 偏移：
 *   · 旧三段 `<snapshot_id>:<graphKey>:<offset>` 按 `overview` 解释（概览兼容，行为不变）；
 *   · **快照对不上就明确拒绝**（不许拿旧游标续一份新快照的数据）；
 *   · **跨模式就明确拒绝**（同快照概览与全量的序列不同，游标不可互换）——错误文案点名两个模式；
 *   · 先校快照再校模式：伪造快照的旧三段游标在 full 下必须报「另一份快照」而不是「跨模式」。
 */
export function parseSixGraphCursor(
  cursor: string,
  snapshotId: string,
  mode: "overview" | "full" = "overview",
): { graph: SixGraphKey; offset: number } | { error: string } {
  const parts = cursor.split(":");
  if (parts.length !== 3 && parts.length !== 4) {
    return {
      error:
        `游标格式应为 <snapshot_id>:<mode>:<graphKey>:<offset>` +
        `（或旧三段 <snapshot_id>:<graphKey>:<offset>，按 overview 解释）（收到 ${JSON.stringify(cursor)}）`,
    };
  }
  const fourSeg = parts.length === 4;
  const sid = parts[0];
  const cursorMode = fourSeg ? parts[1] : "overview";
  const key = fourSeg ? parts[2] : parts[1];
  const off = fourSeg ? parts[3] : parts[2];
  // 先校快照：伪造快照的游标在 full/overview 下都报「另一份快照」（不跨快照拼数据的红线优先）
  if (sid !== snapshotId) {
    return { error: `游标属于另一份快照（${sid}），当前快照是 ${snapshotId}：请重新取一次再续（不跨快照拼数据）` };
  }
  // 再校模式：跨模式明确拒绝，文案点名「游标所属模式」与「本次模式」并要求从首页重取
  if (cursorMode !== mode) {
    return {
      error:
        `游标属于 ${cursorMode} 模式，本次请求是 ${mode} 模式：不能跨模式续取（同快照不同模式的遍历序列不同），` +
        `请从首页重新取一次 ${mode} 模式再续`,
    };
  }
  if (!(SIX_GRAPH_KEYS as readonly string[]).includes(key)) {
    return { error: `游标里的图键 ${JSON.stringify(key)} 不是六图之一（${SIX_GRAPH_KEYS.join("/")}）` };
  }
  const offset = Number(off);
  if (!Number.isInteger(offset) || offset < 0) return { error: `游标里的偏移 ${JSON.stringify(off)} 不是非负整数` };
  return { graph: key as SixGraphKey, offset };
}

/**
 * 读六图完整当前状态（只读；不写盘、不调模型）。
 * 四种用法：① 全部六图（缺省）；② `graph=<六图之一>`；③ `node_id=<稳定 ID>`；④ `relation_id=<稳定关系 ID>`。
 */
export function sixGraphsOf(projectId: string, opts: SixGraphOptions = {}): SixGraphSnapshot {
  const dataDir = opts.dataDir;
  const project = getProject(projectId, dataDir);
  if (!project) throw new WsError("PROJECT_NOT_FOUND", `项目不存在: ${projectId}`);

  // V09-22：读取模式（缺省概览，行为逐字不变）；full 时同一份 builder 换 ARCH_UNLIMITED_LIMITS
  // （未聚合并集；早期实现曾用 MCP_FULL_LIMITS=20000 档，2026-09-22 返工起不再是生产读口上限）。
  const mode: "overview" | "full" = opts.mode ?? "overview";

  const anomalies: string[] = [];
  const published = readBlueprint(projectId, dataDir);
  let draft: Blueprint | null = null;
  if (published === null) {
    try {
      const d = draftBlueprintOf(projectId, dataDir ? { dataDir } : {});
      draft = d === null ? null : d.blueprint;
      if (draft !== null) {
        anomalies.push(
          "没有已发布的规划图：下面给出的是**未审定草稿**（不可作施工依据，§3.2）；发布被拒的原因见草稿 publish.reason",
        );
      }
    } catch (e) {
      anomalies.push(`草稿派生也失败：${(e as Error).message}（按「没有图可读」如实表达）`);
    }
  }
  const bp: Blueprint | null = published ?? draft;

  // 状态投影（与 project_entry／get_arch 同一份：projectWithReleases）
  //
  // V09-30：本函数一次构建内 `projectWithReleases` 与 `archProvenanceModelOf` 会各自反复读同一份
  // 事件账本（剖析实测 7 次），这里**现读一份快照**沿这两条链传下去共享——只在这一次调用栈里共享，
  // 不是全局/跨请求缓存（每次调用现读，下一次调用立刻见到新事件；读不出来就不传，下游按既有路径
  // 各自现读并如实报错，六图可读性结论不变）。
  const resolvedDataDir = dataDir ?? resolveDataDir();
  // V09-31：宿主只读入口可传入**整次请求现读的同一份快照**（入口/图摘要/同步判据同版）；
  // 来源 workDir 与本项目不一致就不算数，回退本函数现读。缺省行为逐字不变。
  let eventsSnapshot: EventsSnapshot | null = null;
  if (opts.events !== undefined && opts.events.work_dir === projectWorkDir(projectId, resolvedDataDir)) {
    eventsSnapshot = opts.events;
  } else {
    try {
      eventsSnapshot = eventsSnapshotOf(projectId, resolvedDataDir);
    } catch {
      eventsSnapshot = null; // 账本损坏等：不沿用任何旧快照，下游现读时照常失败（不静默吞）
    }
  }
  const projection: Record<string, import("../server/work/statusProjection").StatusProjection> = {};
  let revisions: { design?: string | null; plan?: string | null; plan_definition?: string | null } = {};
  try {
    const proj = projectWithReleases({
      projectId,
      dataDir: resolvedDataDir,
      definitions: [],
      ...(eventsSnapshot === null ? {} : { events: eventsSnapshot }),
    });
    for (const o of proj.objects) projection[o.object_id] = o;
  } catch (e) {
    anomalies.push(`状态投影算不出来：${(e as Error).message}（逐对象状态按「无状态记录」如实表达，不涂色）`);
  }
  const links = declaredLinksOf(readLastReconcile(projectId, dataDir).result ?? null);

  // 来源修订（快照标识用；与 project_entry 的修订同一来源）
  let sources: ReturnType<typeof readBlueprintSources> | null = null;
  try {
    sources = readBlueprintSources(projectId, dataDir);
    revisions = {
      design: sources.design?.content_sha256 ?? null,
      plan: sources.plan?.content_sha256 ?? null,
      plan_definition: sources.plan?.definition_sha256 ?? null,
    };
  } catch (e) {
    anomalies.push(`来源修订读不出来：${(e as Error).message}（快照标识按可得部分给，不伪造）`);
  }

  const baselineId = bp?.baseline_id ?? sources?.baseline_id ?? null;
  const generatedAt = bp?.generated_at ?? null;
  // V09-22 契约 5：快照标识由**实际图输入**决定（内容驱动），不再用 `generated_at`——
  // 草稿态的 `generated_at` 每次现取 `nowIso()` 会逐调用漂移（跨秒续取被拒的根因）。
  // 身份输入 = 项目 + 基线 + 设计/施工修订 + 蓝图内容键（based_on.full_key，缺失回退 generated_at）
  // ＋ modules.json/supplement.json 的文件内容哈希；哈希 sha256 截 16 hex（保持 `gs-` 前缀）。
  // ＋ names.json/progress.json（V09-22 返工 F2：模块人话名/兼容状态也是实际图输入，改名后快照必须换 identity，否则同进程 full 拿旧名、旧游标被误当同快照）。
  // 同输入任意间隔两次调用得同一标识；modules.json/supplement.json 一变标识即变、旧游标拒。
  const { modulesSha, supplementSha, namesSha, progressSha } = graphInputSha(projectId, dataDir);
  const snapshotId = `gs-${sha256Hex(
    [
      projectId,
      baselineId ?? "none",
      revisions.design ?? "",
      revisions.plan ?? "",
      bp?.based_on?.full_key ?? bp?.generated_at ?? "none",
      modulesSha,
      supplementSha,
      namesSha,
      progressSha,
    ].join("|"),
  ).slice(0, 16)}`;
  const effectiveVersion = baselineId ?? (revisions.plan_definition ?? revisions.plan ?? revisions.design ?? null);

  // 图更新状态（§3.3／§4.4；与界面同一份记录与横幅判据）
  const update = graphUpdateOf(projectId, dataDir);
  // 与界面**同一份**横幅判据（`graphUpdateBannerOf`）；no record ⇒ null（读侧不把 null 当"正在更新"）
  const updateBanner =
    update === null
      ? null
      : graphUpdateBannerOf({
          state: update.state,
          scope: update.scope,
          reason: update.reason,
          phase: update.phase,
          phases_done: update.phases_done,
          phases_total: update.phases_total,
          change_token: update.change_token,
          started_at: update.started_at,
          updated_at: update.updated_at,
          finished_at: update.finished_at,
          eta: update.eta,
          result: update.result,
          last_error: update.last_error,
        });
  let semanticState: SemanticStateView | null = null;
  try {
    semanticState = semanticStateOf(projectId, dataDir ? { dataDir } : {});
  } catch (e) {
    anomalies.push(`语义整理层状态读不出来：${(e as Error).message}`);
  }

  const provenance = (() => {
    try {
      return archProvenanceModelOf(projectId, {
        ...(dataDir === undefined ? {} : { dataDir }),
        ...(eventsSnapshot === null ? {} : { events: eventsSnapshot }),
      });
    } catch (e) {
      anomalies.push(`来源/证据标注算不出来：${(e as Error).message}（逐对象标注为空，不涂绿）`);
      return null;
    }
  })();

  const capabilityClasses = (() => {
    const cc = bp?.capability_classes ?? null;
    if (cc === null) return null;
    return {
      declared: cc.declared,
      table_state: bp === null ? ("undeclared" as const) : capabilityClassTableStateOf(bp),
      issues: (cc.issues ?? []).map((i) => ({ kind: i.kind, chapter: i.chapter, detail: i.detail, blocking: i.blocking })),
      note: cc.note,
    };
  })();
  if (capabilityClasses?.table_state === "broken") {
    anomalies.push(
      `能力分类声明表损坏（${capabilityClasses.issues.filter((i) => i.blocking).length} 项阻断）：` +
        capabilityClasses.issues
          .filter((i) => i.blocking)
          .slice(0, 6)
          .map((i) => `§${i.chapter ?? "—"} ${i.kind}`)
          .join("、") +
        "——分类不可信：不在本表里的能力章节分类未定、不按功能能力计数；按「旧有效图/更新失败」规则保留上次有效图并显示原因（§3.2／§3.3／§4.4）",
    );
  }
  if (bp !== null && bp.publish.published === false) {
    anomalies.push(`规划图未发布：${bp.publish.reason ?? "（未给原因）"}——本版图不可作施工依据（§4.1／§4.4）`);
  }
  if (sources !== null && sources.code.available === false) {
    anomalies.push(
      "本项目还没跑过静态解析（代码侧没有输入）：技术详情三图的代码关系层为空，模块映射按「未核实」如实表达，不冒充已核实",
    );
  }

  // ── 续取游标：只续**一张图**（同一快照内按图偏移）；快照对不上已在上面明确拒绝 ──
  let cursorResume: { graph: SixGraphKey; offset: number } | null = null;
  if (opts.cursor !== undefined && opts.cursor !== null && opts.cursor !== "") {
    const parsed = parseSixGraphCursor(opts.cursor, snapshotId, mode);
    if ("error" in parsed) {
      throw new WsError("INVALID_INPUT", parsed.error);
    }
    cursorResume = parsed;
  }
  // 游标与 `graph=` 同时给且指向不同图 ⇒ 两个续取位置互相矛盾：明确拒绝，不替调用方猜一个
  if (cursorResume !== null && opts.graph !== undefined && opts.graph !== cursorResume.graph) {
    throw new WsError(
      "INVALID_INPUT",
      `续取游标指向 ${cursorResume.graph}，而 graph 参数是 ${opts.graph}：两个续取位置矛盾，请只给一个（同一快照内续取）`,
    );
  }

  // ── 六个图各自装配 ──
  const keys: readonly SixGraphKey[] = cursorResume !== null ? [cursorResume.graph] : opts.graph === undefined ? SIX_GRAPH_KEYS : [opts.graph];
  const graphs: Partial<Record<SixGraphKey, GraphPayload>> = {};
  /** 全局安全上限计数：本响应**已返回**的对象条数（按图依次吃预算；见 `paginateGraph`） */
  let used = 0;
  let totalObjects = 0;
  let returned = 0;
  const limit = Math.max(1, opts.limit ?? SIX_GRAPH_OBJECT_LIMIT);
  /** 每张图的续取位置（`end`＝本图**下一位置**；`complete`＝本图取完） */
  const pageOf: Partial<Record<SixGraphKey, { offset: number; end: number; total: number; delivered: number; complete: boolean }>> = {};
  const offsetFor = (key: SixGraphKey): number => (cursorResume !== null && cursorResume.graph === key ? cursorResume.offset : 0);
  const budgetLeft = (): number => Math.max(0, limit - used);

  const buildMainView = (view: "functional" | "architecture" | "construction"): GraphPayload => {
    if (bp === null) {
      return emptyGraphPayload(view, "没有可读的规划图（没有已发布图，也没有可派生的草稿）：先修图纸/基线再看本图", mode);
    }
    // V09-22：full 模式下 technical_id/plan_refs 映射也按全量上限的 merged 图解析——否则被概览
    // 上限聚合掉的静态模块在新露出的分组里解析不到对应技术节点（与 mergedGraphForTech 同一口径）。
    const merged = viewGraphWithPlan(projectId, {
      ...(dataDir ? { dataDir } : {}),
      ...(mode === "full" ? { limits: ARCH_UNLIMITED_LIMITS } : {}),
    });
    const derived = taskDerivedModuleStatus({
      blueprint: bp,
      projection: projection as ProjectionIndex,
      declared_links: links,
    });
    // V09-22：full 模式把主视图的分组概览放开（`overview_full`，消费侧在 `buildViewModel`／任务书 §2.1）。
    const model = buildViewModel({
      view,
      blueprint: bp,
      projection: projection as ProjectionIndex,
      mergedNodes: merged.graph.nodes.map((n) => ({ id: n.id, plan_refs: n.plan_refs })),
      module_status: derived.status,
      overview_full: mode === "full",
    });
    /** V09-22：底层候选总数（分组/任务节点总数，含被概览折叠的）——区分「本图返回数」 */
    const underlyingNodes = model.overview.shown.length + model.overview.hidden_count;
    const summaryOnly = opts.summary_only === true;
    // F-1：本图三条列表**合成单一有序序列**再按 [offset, offset+budget) 切一刀（不再各切各的）
    const page = summaryOnly
      ? summaryPage(model.nodes.length + model.edges.length + model.intra_relations.length)
      : paginateGraph(
          viewNodeEntries(model, provenance, effectiveVersion),
          viewEdgeEntries(model.edges, provenance, effectiveVersion),
          viewEdgeEntries(model.intra_relations, provenance, effectiveVersion),
          offsetFor(view),
          budgetLeft(),
        );
    totalObjects += page.total;
    returned += page.delivered;
    used += page.delivered;
    pageOf[view] = { offset: offsetFor(view), end: page.end, total: page.total, delivered: page.delivered, complete: page.complete };
    const meta = SIX_GRAPH_META[view];
    return {
      key: view,
      title: meta.title,
      layer: meta.layer,
      question: meta.question,
      source: meta.source,
      note: meta.note,
      mode,
      counts: {
        nodes: summaryOnly ? model.nodes.length : page.nodes.length,
        edges: summaryOnly ? model.edges.length : page.edges.length,
        groups: model.groups.length,
        intra_relations: summaryOnly ? model.intra_relations.length : page.intra.length,
        aggregate_node: model.aggregate_node !== null,
        hidden_members: model.nodes.reduce((s, n) => s + n.hidden_members, 0),
        truncated_by_limit: page.truncated,
        underlying_nodes: underlyingNodes,
        underlying_edges: model.edges.length + model.intra_relations.length,
      },
      groups: model.groups.map((g) => ({ key: g.key, label: g.label, members: [...g.members] })),
      nodes: page.nodes,
      edges: page.edges,
      intra_relations: page.intra,
      // 主视图没有共用数据层，采集侧 budget_exhausted 与 origin:chat 此处不可得（如实不标，不硬凑）
      notes: [...model.notes, ...completenessNotesOf({ mode, budget_exhausted: null, has_chat_nodes: false })],
    };
  };

  /** V09-22 契约 3：技术层三图的**未聚合并集**（`ARCH_UNLIMITED_LIMITS` 的静态＋补全层，再并入规划层）。
   *  与 `mergedGraphForTech` 的 full 分支同一份（mode=full 与底层计数都走它）；无上限构建带内容哈希缓存。
   *  规划层只并入**已发布**蓝图（与概览路径 `viewGraphWithPlan` 同一口径：草稿态技术图本就不含规划层）。 */
  const unlimitedTechGraph = (): SharedGraph => {
    const base = unlimitedGraphOf(projectId, dataDir);
    return published === null ? base : mergePlanningLayer(base, planningLayerInput(published));
  };

  /** 2026-09-29 六图完整读取轮：技术层共用数据层的**来源分层计数**（code/plan/chat）。
   *  「80 个节点」必须能读出「8 个代码模块＋72 个规划对象」——不许把两层混称「代码模块数」
   *  （Codex 复核 2026-09-29 的信息偏差点；逐对象来源字段早已有，这里补图级计数）。 */
  const byOriginOf = (graph: SharedGraph): { code: number; plan: number; chat: number } => {
    let code = 0;
    let plan = 0;
    let chat = 0;
    for (const n of graph.nodes) {
      if (n.aggregate === true) continue; // V09-22 返工 F4：__more__ 聚合占位不是真实代码模块，不冒充实体
      if (n.origin === "chat") chat += 1;
      else if (n.plan_origin === "plan") plan += 1;
      else code += 1;
    }
    return { code, plan, chat };
  };

  /** V09-22 返工 F4：来源分层的**底层未聚合并集**口径（走 unlimitedTechGraph 的内容哈希缓存，两种模式同值）。
   *  by_origin 只数本图可见真实实体（聚合占位不计）；「真实代码模块数」读 by_origin_underlying，
   *  「隐藏的真实代码模块数」＝ by_origin_underlying.code − by_origin.code（技术层只有代码层会聚合）。 */
  let byOriginUnderlyingCache: { code: number; plan: number; chat: number } | null = null;
  const byOriginUnderlyingOf = (graph: SharedGraph | null): { code: number; plan: number; chat: number } => {
    if (byOriginUnderlyingCache !== null) return byOriginUnderlyingCache;
    try {
      byOriginUnderlyingCache = byOriginOf(unlimitedTechGraph());
    } catch {
      // 降级账目：按当前图的真实实体数（比底层真值偏小，anomalies 已由相应读取路径给原因）
      byOriginUnderlyingCache = graph === null ? { code: 0, plan: 0, chat: 0 } : byOriginOf(graph);
    }
    return byOriginUnderlyingCache;
  };

  // V09-22 返工 F5：采集完整性的结构化判读材料（modules.json 只读一次，旧桶检测与顶层 collection 共用）。
  // 2026-09-29 定向收尾 R1/R3：读取边界已做结构校验与 budget 标记净化——结构损坏在这里只会以
  // WsError 形态进来（下方 catch 降级），非布尔标记则以 budget_marker_invalid 进来（不回显原值）。
  const modulesRead: { exists: boolean; arch?: ArchModulesFile; budget_marker_invalid?: true } | null = (() => {
    try {
      return readModules(projectId, dataDir);
    } catch (e) {
      anomalies.push(`modules.json 读不出来：${(e as Error).message}（采集完整性按「未知」处理，不阻断六图）`);
      return null;
    }
  })();
  // 2026-09-29 六图完整读取轮：旧版采集有损合并的「其他」桶如实标注（重跑解析可展开）。
  const legacyAgg = legacyAggregationOf(modulesRead?.arch);
  if (legacyAgg.has_legacy_other) {
    anomalies.push(
      `模块集含旧版有损合并的「其他」桶（约 ${legacyAgg.merged_prefixes} 个目录前缀压成 1 个模块，原始对象不可拆回）——` +
        "重跑解析（POST /api/projects/:id/arch/parse）可展开为全部真实候选；不重跑就按现状如实呈现，不许当作模块层全量",
    );
  }

  const mergedGraphForTech = (): SharedGraph | null => {
    try {
      // V09-22 契约 3：full 模式用**未聚合并集**（上限外对象逐项可取）；概览缺省逐字不变。
      if (mode === "full") return unlimitedTechGraph();
      return viewGraphWithPlan(projectId, dataDir ? { dataDir } : {}).graph;
    } catch (e) {
      anomalies.push(`技术详情共用数据层读不出来：${(e as Error).message}`);
      return null;
    }
  };

  // ── V09-22 契约 3：底层候选总数的**唯一口径**＝**未聚合并集**（ARCH_UNLIMITED_LIMITS）构建一遍的规模 ──
  // 概览图的自身账目（underlyingCountsOfGraph）漏了被节点聚合重定向合并掉的边，不能当"底层总数"；
  // 两种模式都换成无上限真值（真实项目都在上限内，数值不变），只算一次；读不出时降级为本图账目
  // 并如实偏小（anomalies 已带原因）。
  let underlyingFullCache: { nodes: number; edges: number } | null = null;
  const underlyingCountsOf = (graph: SharedGraph): { nodes: number; edges: number } => {
    if (underlyingFullCache !== null) return underlyingFullCache;
    try {
      underlyingFullCache = underlyingCountsOfGraph(unlimitedTechGraph());
    } catch {
      underlyingFullCache = underlyingCountsOfGraph(graph); // 降级账目（偏小，不冒充全量）
    }
    return underlyingFullCache;
  };

  const buildModuleMap = (graph: SharedGraph | null): GraphPayload => {
    const meta = SIX_GRAPH_META.module_map;
    if (graph === null) return emptyGraphPayload("module_map", "技术详情共用数据层读不出来（见 anomalies）", mode);
    const sel = selectGraph("MODULE_BOX", graph);
    const derived =
      bp === null ? null : taskDerivedModuleStatus({ blueprint: bp, projection: projection as ProjectionIndex, declared_links: links });
    /** 技术模块 id 口径的 v2 派生上屏键（`moduleStatusKeysOf` 是唯一出处：同时给 plan:code:* 与裸模块 id） */
    const derivedKeys = derived === null ? {} : moduleStatusKeysOf(derived);
    const nodeRows = sel.nodes.map((n) => {
      const key: string = derivedKeys[n.id] ?? NO_STATUS_RECORD_KEY;
      const st = derived === null ? undefined : (derived.status[`plan:code:${n.id}`] as NodeStatus | undefined);
      return {
        id: n.id,
        label: n.name,
        kind: n.kind,
        group_key: null,
        members: [],
        hidden_members: 0,
        technical_id: technicalIdOf(n.id, graph.nodes.map((x) => ({ id: x.id, plan_refs: x.plan_refs }))),
        origin_layer: n.origin === "chat" ? ("chat" as const) : n.plan_origin === "plan" ? ("plan" as const) : ("code" as const),
        ...(n.aggregate === true ? { aggregate: true as const } : {}),
        object: objectStateOf(
          n.id,
          n.name,
          n.kind,
          "node",
          key,
          st?.short,
          st?.basis ?? (derived === null ? null : (derived.by_object[`module:${n.id}`]?.basis ?? null)),
          annotationOfId(provenance, n.id),
          effectiveVersion,
          null,
        ),
      } satisfies GraphNodeEntry;
    });
    const edgeRows = sel.edges.map((e) => ({
      id: `${e.from}->${e.to}`,
      from: e.from,
      to: e.to,
      kind: "static_import",
      certainty: "observed",
      semantics: "static_reference",
      sources: [],
      note:
        "静态 import 聚合边（方向＝依赖方 → 被依赖方）：**当前实现**的代码关系层。" +
        "它不是运行时调用、也不是业务数据流（§3.2／§11.2）",
      object: objectStateOf(
        `${e.from}->${e.to}`,
        `${e.from} → ${e.to}`,
        "static_import",
        "edge",
        null,
        undefined,
        "静态引用线保持中性来源样式、不着完成色（§4.2）",
        annotationOfId(provenance, `${e.from}->${e.to}`),
        effectiveVersion,
        null,
      ),
    }));
    const summaryOnly = opts.summary_only === true;
    const page = summaryOnly ? summaryPage(sel.nodes.length + sel.edges.length) : paginateGraph(nodeRows, edgeRows, [], offsetFor("module_map"), budgetLeft());
    totalObjects += page.total;
    returned += page.delivered;
    used += page.delivered;
    pageOf.module_map = { offset: offsetFor("module_map"), end: page.end, total: page.total, delivered: page.delivered, complete: page.complete };
    const underlying = underlyingCountsOf(graph);
    const byOrigin = byOriginOf(graph);
    const byOriginUnderlying = byOriginUnderlyingOf(graph);
    return {
      key: "module_map",
      title: meta.title,
      layer: meta.layer,
      question: meta.question,
      source: meta.source,
      note: meta.note,
      mode,
      counts: {
        nodes: summaryOnly ? sel.nodes.length : page.nodes.length,
        edges: summaryOnly ? sel.edges.length : page.edges.length,
        groups: 0,
        intra_relations: 0,
        aggregate_node: sel.nodes.some((n) => n.aggregate === true),
        hidden_members: graph.truncated.nodes,
        truncated_by_limit: page.truncated,
        underlying_nodes: underlying.nodes,
        underlying_edges: underlying.edges,
        by_origin: byOrigin,
        by_origin_underlying: byOriginUnderlying,
      },
      groups: [],
      nodes: page.nodes,
      edges: page.edges,
      intra_relations: [],
      notes: [
        `共生数据层：${sel.nodes.length} 个顶层模块节点、${sel.edges.length} 条依赖边（防爆炸已在共用层施加一次：聚合 ${graph.truncated.nodes} 个节点、截断 ${graph.truncated.edges} 条边）`,
        `来源分层（counts.by_origin）：本图可见真实实体＝代码模块 ${byOrigin.code} + 规划层 ${byOrigin.plan} + 聊天补全 ${byOrigin.chat}（__more__ 聚合占位不计入、不冒充代码模块）；底层未聚合并集＝代码 ${byOriginUnderlying.code} + 规划 ${byOriginUnderlying.plan} + 聊天 ${byOriginUnderlying.chat}（counts.by_origin_underlying；隐藏的真实代码模块 ${Math.max(0, byOriginUnderlying.code - byOrigin.code)} 个）——「节点总数」不是「代码模块数」的另一种说法；规划层并入在 §4.3 上限之后、不被 15 裁（逐对象来源见 object.source_kinds）`,
        "节点状态取 v2 证据派生（附录 D；映射不到＝「无状态记录」），**不是** progress.json 的自报四色（附录 E.6 第 2 条）",
        `图完整性：budget_exhausted=${String(graph.budget_exhausted)}（true＝残缺集；null＝旧落盘件，完整性未知——不许当全量）`,
        ...(legacyAgg.has_legacy_other
          ? [
              `模块集含旧版「其他」有损聚合桶（约 ${legacyAgg.merged_prefixes} 个前缀压成 1 个模块）：模块层**不完整**、原始对象不可拆回——重跑解析（POST /api/projects/:id/arch/parse）可展开`,
            ]
          : []),
        ...completenessNotesOf({
          mode,
          budget_exhausted: graph.budget_exhausted,
          has_chat_nodes: graph.nodes.some((n) => n.origin === "chat"),
        }),
      ],
    };
  };

  const buildDataFlow = (graph: SharedGraph | null): GraphPayload => {
    const meta = SIX_GRAPH_META.data_flow;
    const flow = (() => {
      try {
        return dataFlowLayerOf(projectId, dataDir ? { dataDir } : {});
      } catch (e) {
        anomalies.push(`数据流向图的目标语义层算不出来：${(e as Error).message}`);
        return null;
      }
    })();
    const summaryOnly = opts.summary_only === true;
    const derivedKeysFlow =
      bp === null ? {} : moduleStatusKeysOf(taskDerivedModuleStatus({ blueprint: bp, projection: projection as ProjectionIndex, declared_links: links }));
    const sel = graph === null ? null : selectGraph("DATA_FLOW", graph);
    const nodeRows: GraphNodeEntry[] =
      sel === null || summaryOnly
        ? []
        : sel.nodes.map((n) => ({
            id: n.id,
            label: n.name,
            kind: n.kind,
            group_key: null,
            members: [],
            hidden_members: 0,
            origin_layer: n.origin === "chat" ? ("chat" as const) : n.plan_origin === "plan" ? ("plan" as const) : ("code" as const),
            technical_id: technicalIdOf(n.id, graph?.nodes.map((x) => ({ id: x.id, plan_refs: x.plan_refs })) ?? []),
            object: objectStateOf(
              n.id,
              n.name,
              n.kind,
              "node",
              derivedKeysFlow[n.id] ?? NO_STATUS_RECORD_KEY,
              undefined,
              "本图节点状态与方框图同一份（v2 证据派生，`moduleStatusKeysOf`）；流向角色只做属性标记、**不改节点色**（NODE_COLOR_RULE）",
              annotationOfId(provenance, n.id),
              effectiveVersion,
              null,
            ),
          }));
    const edgeRows: GraphEdgeEntry[] =
      sel === null || summaryOnly
        ? []
        : sel.edges.map((e) => ({
            id: `${e.from}->${e.to}`,
            from: e.from,
            to: e.to,
            kind: "static_import_direction",
            certainty: "observed",
            semantics: "static_reference",
            sources: [],
            note:
              "**当前实现**：静态 import 依赖层的方向渲染（提供者 → 消费者），不是业务数据流。" +
              "目标口径见本图 `tech.target_semantics`（§3.2／§11.2）",
            object: objectStateOf(
              `${e.from}->${e.to}`,
              `${e.from} → ${e.to}`,
              "static_import_direction",
              "edge",
              null,
              undefined,
              "静态引用线保持中性来源样式、不着完成色（§4.2）；**静态 import 只作线索，不得据此生成「已验证」的数据边**",
              annotationOfId(provenance, `${e.from}->${e.to}`),
              effectiveVersion,
              null,
            ),
          }));
    const page = summaryOnly
      ? summaryPage((sel?.nodes.length ?? 0) + (sel?.edges.length ?? 0))
      : paginateGraph(nodeRows, edgeRows, [], offsetFor("data_flow"), budgetLeft());
    totalObjects += page.total;
    returned += page.delivered;
    used += page.delivered;
    pageOf.data_flow = { offset: offsetFor("data_flow"), end: page.end, total: page.total, delivered: page.delivered, complete: page.complete };
    // V09-22：底层候选总数与方框图同源（底层边＝全量边集合，视图边只是方向子集）
    const underlying = graph === null ? { nodes: 0, edges: 0 } : underlyingCountsOf(graph);
    const byOrigin = graph === null ? { code: 0, plan: 0, chat: 0 } : byOriginOf(graph);
    const byOriginUnderlying = byOriginUnderlyingOf(graph);
    return {
      key: "data_flow",
      title: meta.title,
      layer: meta.layer,
      question: meta.question,
      source: meta.source,
      note: meta.note,
      mode,
      counts: {
        nodes: summaryOnly ? (sel?.nodes.length ?? 0) : page.nodes.length,
        edges: summaryOnly ? (sel?.edges.length ?? 0) : page.edges.length,
        groups: 0,
        intra_relations: 0,
        // V09-22：与方框图同一份共用层聚合账目（节点集合逐 id 相同，隐藏量不许在这张图静默成 0）
        aggregate_node: sel?.nodes.some((n) => n.aggregate === true) ?? false,
        hidden_members: graph?.truncated.nodes ?? 0,
        truncated_by_limit: page.truncated,
        underlying_nodes: underlying.nodes,
        underlying_edges: underlying.edges,
        by_origin: byOrigin,
        by_origin_underlying: byOriginUnderlying,
      },
      groups: [],
      nodes: page.nodes,
      edges: page.edges,
      intra_relations: [],
      notes: [
        "**当前实现 ≠ 目标**：三张技术图当前共用同一份静态 import 依赖层（只有渲染取向不同）；数据流向图的**目标**是业务/项目数据的实际路径（§3.2）",
        `来源分层（counts.by_origin）：本图可见真实实体＝代码模块 ${byOrigin.code} + 规划层 ${byOrigin.plan} + 聊天补全 ${byOrigin.chat}（__more__ 聚合占位不计入）；底层未聚合并集＝代码 ${byOriginUnderlying.code} + 规划 ${byOriginUnderlying.plan} + 聊天 ${byOriginUnderlying.chat}（counts.by_origin_underlying）——与方框图同一份共用数据层（§3.2「同一份数据」红线）`,
        flow === null
          ? "目标语义层本次算不出来（见 anomalies）"
          : `目标语义层：实体 ${flow.nodes.length} 个、关系 ${flow.edges.length} 条、端到端链 ${flow.chains.length} 条` +
            `（交付结论${flow.deliverable_blocked ? "**被阻断**" : "未被阻断"}；阻断项 ${flow.blockers.length} 条）`,
        ...completenessNotesOf({
          mode,
          budget_exhausted: graph?.budget_exhausted ?? null,
          has_chat_nodes: graph?.nodes.some((n) => n.origin === "chat") ?? false,
        }),
      ],
      tech: flow,
    };
  };

  const buildMindMap = (graph: SharedGraph | null): GraphPayload => {
    const meta = SIX_GRAPH_META.mind_map;
    if (graph === null) return emptyGraphPayload("mind_map", "技术详情共用数据层读不出来（见 anomalies）", mode);
    let tree: MindTree;
    try {
      tree = buildMindTree(graph, { id: projectId, name: project.name }, new Map());
    } catch (e) {
      anomalies.push(`思维导图树算不出来：${(e as Error).message}`);
      return emptyGraphPayload("mind_map", "思维导图树算不出来（见 anomalies）", mode);
    }
    const flatten = (n: typeof tree.root, depth: number): { node: typeof tree.root; depth: number }[] => [
      { node: n, depth },
      ...n.children.flatMap((c) => flatten(c, depth + 1)),
    ];
    const flat = flatten(tree.root, 0);
    const summaryOnly = opts.summary_only === true;
    // 共用层节点的状态与方框图**同一份**（v2 证据派生）；取不到才回落"无状态记录"（不回退 v1 自报四色）
    const derivedKeysForMind =
      bp === null ? {} : moduleStatusKeysOf(taskDerivedModuleStatus({ blueprint: bp, projection: projection as ProjectionIndex, declared_links: links }));
    const rows: GraphNodeEntry[] = (summaryOnly ? [] : flat).map(({ node, depth }) => ({
      id: node.id,
      label: node.label,
      kind: node.kind,
      group_key: depth === 0 ? null : node.id,
      members: node.children.map((c) => c.id),
      hidden_members: 0,
      technical_id: node.id,
      ...(node.aggregate === true ? { aggregate: true as const } : {}),
      object: objectStateOf(
        node.id,
        node.label,
        node.kind,
        "node",
        node.from === "project"
          ? null
          : node.from === "shared"
            ? (derivedKeysForMind[node.id] ?? NO_STATUS_RECORD_KEY)
            : "no_status_record",
        undefined,
        node.from === "shared"
          ? "节点状态与方框图同一份（共用数据层）；v2 派生表由调用方喂入（本读口给共用层原值）"
          : "层级节点（项目根 / A4 下钻子级）：文件层没有模块状态（§4.1 LLM 不碰文件层）",
        annotationOfId(provenance, node.id),
        effectiveVersion,
        null,
      ),
    }));
    // F-1：节点与层级边**合成单一有序序列**再切片（边也进分页，避免每页把边重复交付一次）
    const edgeRows: GraphEdgeEntry[] = tree.selection.edges.map((e) => ({
      id: `${e.from}>${e.to}`,
      from: e.from,
      to: e.to,
      kind: "hierarchy_parent_child",
      certainty: "observed",
      semantics: "hierarchy",
      sources: [],
      note: "层级父子边（路径包含关系推出；§3.2 表格第三行画的是层级，不是依赖边）",
      object: objectStateOf(
        `${e.from}>${e.to}`,
        `${e.from} > ${e.to}`,
        "hierarchy_parent_child",
        "edge",
        null,
        undefined,
        "层级边不着完成色（§4.2：不着色的线不等于已完成）",
        null,
        effectiveVersion,
        null,
      ),
    }));
    const page = summaryOnly ? summaryPage(flat.length + edgeRows.length) : paginateGraph(rows, edgeRows, [], offsetFor("mind_map"), budgetLeft());
    totalObjects += page.total;
    returned += page.delivered;
    used += page.delivered;
    pageOf.mind_map = { offset: offsetFor("mind_map"), end: page.end, total: page.total, delivered: page.delivered, complete: page.complete };
    // V09-22：底层候选总数与方框图同源（顶层树来自同一份 shared）
    const underlying = underlyingCountsOf(graph);
    return {
      key: "mind_map",
      title: meta.title,
      layer: meta.layer,
      question: meta.question,
      source: meta.source,
      note: meta.note,
      mode,
      counts: {
        nodes: summaryOnly ? flat.length : page.nodes.length,
        edges: summaryOnly ? edgeRows.length : page.edges.length,
        groups: 0,
        intra_relations: 0,
        aggregate_node: flat.some(({ node }) => node.aggregate === true),
        // V09-22：顶层树的「还有 N 个」聚合节点代表的正是被共用层上限折叠的顶层模块——如实计数
        hidden_members: graph.truncated.nodes,
        truncated_by_limit: page.truncated,
        underlying_nodes: underlying.nodes,
        underlying_edges: underlying.edges,
      },
      groups: [],
      nodes: page.nodes,
      edges: page.edges,
      intra_relations: [],
      notes: [
        `树：${tree.nodeCount} 个节点、${tree.depth} 层（本次给的是**未展开的顶层树**；更深层级由界面按需懒加载 A4 expand，读口不代扫目录）`,
        "顶层与层级边＝共用数据层同一份（MIND_MAP 选择器），节点集合与方框图逐 id 相同；顶层模块的来源分层（代码/规划/聊天）见方框图 counts.by_origin——本图是层级树（含项目根与文件子级），不给分层计数",
        ...completenessNotesOf({
          mode,
          budget_exhausted: graph.budget_exhausted,
          has_chat_nodes: graph.nodes.some((n) => n.origin === "chat"),
        }),
      ],
      tech: { root: tree.root, nodeCount: tree.nodeCount, depth: tree.depth, expandedBranches: tree.expandedBranches },
    };
  };

  const techGraph = keys.some((k) => k === "module_map" || k === "data_flow" || k === "mind_map")
    ? mergedGraphForTech()
    : null;

  for (const key of keys) {
    if (key === "functional" || key === "architecture" || key === "construction") {
      graphs[key] = buildMainView(key);
    } else if (key === "module_map") {
      graphs[key] = buildModuleMap(techGraph);
    } else if (key === "data_flow") {
      graphs[key] = buildDataFlow(techGraph);
    } else {
      graphs[key] = buildMindMap(techGraph);
    }
    // 空态（没有可读图/技术层读不出来）没有走过分页：按「本图 0 条、已取完」记账
    if (pageOf[key] === undefined) pageOf[key] = { offset: offsetFor(key), end: 0, total: 0, delivered: 0, complete: true };
  }

  // ── 指定节点 / 指定关系：单对象读取（含它出现在哪几张图、分组、同组关系） ──
  let nodeFocus: unknown = null;
  let relationFocus: unknown = null;
  if (opts.node_id !== undefined && opts.node_id.trim() !== "") {
    const want = opts.node_id.trim();
    const hits: { graph: SixGraphKey; entry: GraphNodeEntry; group_label: string | null }[] = [];
    for (const key of Object.keys(graphs) as SixGraphKey[]) {
      const g = graphs[key];
      if (g === undefined) continue;
      for (const n of g.nodes) {
        if (n.id === want || n.technical_id === want) {
          hits.push({ graph: key, entry: n, group_label: g.groups.find((x) => x.key === n.group_key)?.label ?? null });
        }
      }
    }
    const annotations = provenance === null ? [] : Object.values(provenance.by_object).filter((a) => a.object_id === want);
    nodeFocus = {
      node_id: want,
      found: hits.length > 0 || annotations.length > 0,
      appearances: hits.map((h) => ({ graph: h.graph, group_key: h.entry.group_key, group_label: h.group_label, object: h.entry.object })),
      intra_relations: (Object.keys(graphs) as SixGraphKey[]).flatMap((k) =>
        (graphs[k]?.intra_relations ?? []).filter((e) => e.from === want || e.to === want).map((e) => ({ graph: k, ...e })),
      ),
      edges: (Object.keys(graphs) as SixGraphKey[]).flatMap((k) =>
        (graphs[k]?.edges ?? []).filter((e) => e.from === want || e.to === want).map((e) => ({ graph: k, id: e.id, from: e.from, to: e.to, kind: e.kind, note: e.note })),
      ),
      provenance: annotations,
      note:
        hits.length === 0 && annotations.length === 0
          ? "六图里查不到这个稳定 ID（也未在任何模型的正式对象里）：如实报「查不到」，不猜一个近似节点"
          : "逐图给出该节点所在分组、同组关系与相邻关系；来源/映射/证据状态见 appearances[].object 与 provenance",
    };
  }
  if (opts.relation_id !== undefined && opts.relation_id.trim() !== "") {
    const want = opts.relation_id.trim();
    /** 关系稳定 ID 的两种等价写法都认：`<from>>><to>:<kind>`（视图/证据标注口径）与 `<from>|<to>|<kind>` */
    const relKey = (e: GraphEdgeEntry): string[] => [
      e.id,
      `${e.from}>${e.to}:${e.kind}`,
      `${e.from}|${e.to}|${e.kind}`,
    ];
    const hits: { graph: SixGraphKey; entry: GraphEdgeEntry; where: "edges" | "intra_relations" }[] = [];
    for (const key of Object.keys(graphs) as SixGraphKey[]) {
      const g = graphs[key];
      if (g === undefined) continue;
      for (const e of g.edges) if (relKey(e).includes(want)) hits.push({ graph: key, entry: e, where: "edges" });
      for (const e of g.intra_relations) if (relKey(e).includes(want)) hits.push({ graph: key, entry: e, where: "intra_relations" });
    }
    const annotations = provenance === null ? [] : Object.values(provenance.by_object).filter((a) => a.object_id === want);
    relationFocus = {
      relation_id: want,
      found: hits.length > 0 || annotations.length > 0,
      appearances: hits.map((h) => ({ graph: h.graph, where: h.where, ...h.entry })),
      provenance: annotations,
      note:
        hits.length === 0 && annotations.length === 0
          ? "六图里查不到这条关系（也未在任何模型的正式对象里）：如实报「查不到」"
          : "逐图给出该关系的两端、种类、语义、来源与当前状态（object 字段）",
    };
  }

  const summaryOnly = opts.summary_only === true;
  // 完整性（F-1 返工）：按**每张图**是否取完判定，不再拿「本页返回条数」与**全局总量**比——
  // 后者在续取态永假（本页只返回一页的量，永远小于六图总量），这正是终态永远 incomplete 的根因。
  // `pageOf[k].complete` 的真值条件是 `本图 offset + 本页返回 ≥ 本图总条数`，续取到最后一页必为真。
  const requestedIncomplete = keys.filter((k) => pageOf[k] !== undefined && pageOf[k]!.complete === false);
  const complete = summaryOnly || requestedIncomplete.length === 0;
  const resumeGraph = cursorResume !== null ? cursorResume.graph : (opts.graph ?? null);
  // V09-22：把两种模式下的隐藏对象口径如实写进完整性句末尾（概览：隐藏对象不在本响应内，取回走 mode=full；
  // 全量：仍超上限的对象已聚合并计数，逐对象遍历继续用 cursor 分页）。
  const modeCompletenessNote = (() => {
    const list = Object.values(graphs);
    if (mode === "overview") {
      const anyHidden = list.some((g) => g !== undefined && (g.counts.hidden_members > 0 || g.counts.aggregate_node));
      if (!anyHidden) return null;
      return "概览聚合的隐藏对象不在本响应内（complete 只指本次返回对象已取完）：取隐藏节点/关系请用 mode=full（同一快照 cursor 续取）";
    }
    const anyTruncated = list.some((g) => g !== undefined && (g.counts.hidden_members > 0 || g.counts.truncated_by_limit > 0));
    return anyTruncated
      ? "全量模式仍超上限的对象已聚合并计数（见 counts.hidden_members / truncated_by_limit），逐对象遍历可继续用 cursor 分页"
      : null;
  })();
  return {
    project_id: projectId,
    snapshot_id: snapshotId,
    baseline: {
      baseline_id: baselineId,
      design_revision: revisions.design ?? null,
      plan_revision: revisions.plan ?? null,
      plan_definition_revision: revisions.plan_definition ?? null,
    },
    generated_at: generatedAt,
    read_at: new Date().toISOString(),
    graph_state: {
      availability: published !== null ? "published" : draft !== null ? "draft_only" : "none",
      update_state: update?.state ?? null,
      update_phase: update?.phase ?? null,
      update_scope: update?.scope === null || update?.scope === undefined ? null : (GRAPH_UPDATE_SCOPES[update.scope] ?? update.scope),
      update_reason: update?.reason ?? update?.last_error ?? null,
      update_eta_text:
        update === null
          ? null
          : update.eta === null || update.eta.total_ms === null
            ? update.state === "updating"
              ? `${GRAPH_UPDATE_ETA_UNKNOWN}（依据不足，不编造 ETA）`
              : null
            : (updateBanner?.eta_text ??
              `约 ${Math.max(1, Math.round(update.eta.total_ms / 1000))} 秒（依据：${update.eta.note}）`),
      update_started_at: update?.started_at ?? null,
      update_updated_at: update?.updated_at ?? null,
      banners: updateBanner === null ? [] : [updateBanner.text],
      semantic_state: semanticState === null || semanticState.status === null ? null : semanticState.status.outcome,
      semantic_note: semanticState === null || semanticState.status === null ? null : semanticState.status.note,
    },
    anomalies,
    /** V09-22 返工（F5）：**采集完整性**的机器可判读表达——与分页 completeness（图对象取没取完）并列、
     *  语义独立，两者可同时成立（分页 complete:true ＋ 采集 incomplete）。人读解释仍在各图 notes，不删。 */
    collection: (() => {
      const reasons: string[] = [];
      let status: "not_parsed" | "unknown" | "incomplete" | "complete";
      let budgetExhausted: boolean | null = null;
      if (modulesRead === null) {
        status = "unknown";
        reasons.push("modules_json_unreadable:modules.json 读不出来，采集完整性无法判读");
      } else if (!modulesRead.exists || modulesRead.arch === undefined) {
        status = "not_parsed";
        reasons.push("not_parsed:还没跑过模块解析（POST arch/parse 后才有采集事实）");
      } else {
        // 2026-09-29 定向收尾 R3：非布尔 budget_exhausted 标记在读取边界已被剥掉（不回显违反
        // 接口类型的值），这里按「未知」记原因——不许落进 complete 分支；合法布尔语义不变。
        if (modulesRead.budget_marker_invalid === true) {
          budgetExhausted = null;
          reasons.push("budget_marker_invalid:budget_exhausted 标记类型非法（非布尔值），采集完整性按未知处理（不许当全量）");
        } else {
          budgetExhausted = modulesRead.arch.budget_exhausted ?? null;
          if (budgetExhausted === true) {
            reasons.push("budget_exhausted:true＝解析预算到点收工，本模块集是残缺集（不是全量）");
          } else if (budgetExhausted === null) {
            reasons.push("no_budget_marker:旧落盘件没有 budget_exhausted 标记，采集完整性未知（不许当全量）");
          }
        }
        if (legacyAgg.has_legacy_other) {
          reasons.push(
            `legacy_other_bucket:旧版有损「其他」桶在场（约 ${legacyAgg.merged_prefixes} 个前缀压成 1 个模块，原始对象不可拆回；重跑解析可展开）`,
          );
        }
        status =
          budgetExhausted === true || legacyAgg.has_legacy_other
            ? "incomplete"
            : budgetExhausted === null
              ? "unknown"
              : "complete";
      }
      return {
        status,
        budget_exhausted: budgetExhausted,
        legacy_other_bucket: legacyAgg.has_legacy_other,
        legacy_merged_prefixes: legacyAgg.merged_prefixes,
        reasons,
        /** 读取范围：按规则不入图的目录段（规则性排除，不是遗漏；config.ts JUNK_DIR_SEGMENTS） */
        ignored_dir_segments: [...JUNK_DIR_SEGMENTS],
      };
    })(),
    graphs,
    delivery:
      provenance === null
        ? null
        : {
            verdict: provenance.delivery.verdict,
            conclusion: provenance.delivery.conclusion,
            deliverable_allowed: provenance.delivery.deliverable_allowed,
            reasons: [...provenance.delivery.reasons],
            user_pending_items: [...provenance.delivery.user_pending],
            counts: { ...provenance.delivery.counts },
            note: provenance.delivery.note,
            user_accepted: false,
          },
    model_leads: (bp?.model_leads ?? []).map((l) => ({ ...l, source_refs: l.source_refs.map((r) => ({ ...r })) })),
    model_node_leads: (bp?.model_node_leads ?? []).map((l) => ({
      ...l,
      proposed_source_refs: l.proposed_source_refs.map((r) => ({ ...r })),
      proposed_related_ids: [...l.proposed_related_ids],
    })),
    capability_classes: capabilityClasses,
    completeness: {
      complete,
      incomplete: !complete,
      total: totalObjects,
      returned,
      // 顶层游标＝**本图下一位置**（与 `cursors[k]` 同一口径，不可能互相矛盾）；
      // 合并视图没有单一游标（顶层给 null，续取见 `cursors` 的逐图游标，见 note）。
      cursor: (() => {
        if (complete || summaryOnly || resumeGraph === null) return null;
        const p = pageOf[resumeGraph];
        return p === undefined ? null : `${snapshotId}:${mode}:${resumeGraph}:${p.end}`;
      })(),
      cursors: (() => {
        if (complete || summaryOnly) return {};
        const out: Partial<Record<SixGraphKey, string>> = {};
        for (const k of keys) {
          const p = pageOf[k];
          if (p === undefined || p.complete) continue; // 取完的图不给游标（终页无自指游标）
          out[k] = `${snapshotId}:${mode}:${k}:${p.end}`;
        }
        return out;
      })(),
      limit,
      note:
        (summaryOnly
          ? "摘要模式：本响应只给六图的计数与状态（逐条对象走 get_project_graphs 完整读取）"
          : complete
          ? `本次返回完整数据（${returned} 条对象；安全上限 ${limit}）`
          : `**本次不完整**：共 ${totalObjects} 条对象，本次返回 ${returned} 条（安全上限 ${limit}）——` +
            (resumeGraph === null
              ? "本响应是**合并视图**（未指定单图）：没有单一游标（顶层 `cursor`=null），续取见 `completeness.cursors` 的**逐图游标**——带 `graph=<六图之一>` 与对应游标把该图取完；**不得**把不完整结果当作「全图」"
              : `按**同一快照**游标 ${snapshotId}:${mode}:${resumeGraph}:${pageOf[resumeGraph]?.end ?? 0} 续取（与 cursors.${resumeGraph} 同一位置）；**不得**把不完整结果当作「全图」`)) +
        (modeCompletenessNote === null ? "" : `\n${modeCompletenessNote}`),
    },
    next_read_entry: {
      tool: "get_project_graphs",
      args: { project_id: projectId, graph: "all", mode: "full" },
      note:
        "六图完整状态在本工具（架构判断/影响分析请用 **mode=full** 并按同快照游标取齐：合并视图超限带 incomplete:true 时，按 completeness.cursors[<graphKey>] ＋ graph=<该图> ＋ mode=full 逐图续取到 complete:true）。" +
        "**complete:true 只表示该图图对象分页取完，不等于源码全覆盖**——采集残缺（budget_exhausted）、忽略目录、旧「其他」聚合桶见顶层 `collection`（机器可判读采集完整性）与各图 notes／顶层 anomalies；取齐后先核图状态与来源分层（counts.by_origin），再读设计书/施工图/相关源码。" +
        "概览模式（mode=overview）只适合人看概要，被聚合隐藏的对象不在其中；单对象追问用 node_id / relation_id；接续任务与基线用 project_entry（§6.7）",
    },
    separate_readouts: {
      delivery_verdict: provenance === null ? null : provenance.delivery.verdict,
      workflow_next_action: "review_pending / resume_task / claim_task …（由 project_entry 给，不在本读数里混算）",
      user_gate: "用户 Gate 只由用户本人记录（§5.2／§5.8）；本读数与「可请求验收」都不等于已交付",
      note: "三件事分开表达：交付读数 ≠ 工作流下一动作 ≠ 用户 Gate。任一项都不得被读成「已交付」。",
    },
    ...(nodeFocus === null ? {} : { node_focus: nodeFocus }),
    ...(relationFocus === null ? {} : { relation_focus: relationFocus }),
  } as SixGraphSnapshot;
}

function emptyGraphPayload(key: SixGraphKey, reason: string, mode: "overview" | "full"): GraphPayload {
  const meta = SIX_GRAPH_META[key];
  return {
    key,
    title: meta.title,
    layer: meta.layer,
    question: meta.question,
    source: meta.source,
    note: meta.note,
    // V09-22：空态同样带本次请求的模式；底层候选总数按 0（没有可读的图，如实给空，不硬凑）
    mode,
    counts: {
      nodes: 0,
      edges: 0,
      groups: 0,
      intra_relations: 0,
      aggregate_node: false,
      hidden_members: 0,
      truncated_by_limit: 0,
      underlying_nodes: 0,
      underlying_edges: 0,
    },
    groups: [],
    nodes: [],
    edges: [],
    intra_relations: [],
    notes: [reason],
  };
}

/** 六图**摘要**（`project_entry` 用；DESIGN §6.7）：只给指针与状态，不内联整图——
 *  完整状态走 `get_project_graphs`（避免把接续入口包撑大）。与整图**同一份事实与判据**（同一个 `sixGraphsOf`）。 */
export interface SixGraphSummary {
  snapshot_id: string;
  read_at: string;
  baseline_id: string | null;
  generated_at: string | null;
  /** 有图可读 / 只有草稿 / 没有图 */
  availability: "published" | "draft_only" | "none";
  update_state: string | null;
  update_phase: string | null;
  update_reason: string | null;
  update_eta_text: string | null;
  banners: string[];
  semantic_state: string | null;
  graphs: { key: SixGraphKey; title: string; layer: string; nodes: number; edges: number; groups: number; intra_relations: number; truncated: number }[];
  anomalies: string[];
  delivery: { verdict: string; conclusion: string; user_pending: number; blocking_reasons: number } | null;
  capability_table_state: "declared" | "undeclared" | "broken" | null;
  /** 下一读取入口：Agent 读完摘要就该调它取完整六图 */
  next_read_entry: { tool: string; args: Record<string, unknown>; note: string };
}

/**
 * 取六图摘要（只读、不写盘、不调模型）。`project_entry` 用它把「六图现在各是什么、
 * 算到哪一版、哪里没验证、下一步读什么」放进接续入口，而**不内联整图**。
 */
export function graphSummaryOf(projectId: string, opts: { dataDir?: string; events?: EventsSnapshot } = {}): SixGraphSummary {
  const s = sixGraphsOf(projectId, {
    ...(opts.dataDir === undefined ? {} : { dataDir: opts.dataDir }),
    ...(opts.events === undefined ? {} : { events: opts.events }),
    summary_only: true,
  });
  return {
    snapshot_id: s.snapshot_id,
    read_at: s.read_at,
    baseline_id: s.baseline.baseline_id,
    generated_at: s.generated_at,
    availability: s.graph_state.availability,
    update_state: s.graph_state.update_state,
    update_phase: s.graph_state.update_phase,
    update_reason: s.graph_state.update_reason,
    update_eta_text: s.graph_state.update_eta_text,
    banners: s.graph_state.banners,
    semantic_state: s.graph_state.semantic_state,
    graphs: SIX_GRAPH_KEYS.map((k) => {
      const g = s.graphs[k];
      return {
        key: k,
        title: SIX_GRAPH_META[k].title,
        layer: SIX_GRAPH_META[k].layer,
        nodes: g?.counts.nodes ?? 0,
        edges: g?.counts.edges ?? 0,
        groups: g?.counts.groups ?? 0,
        intra_relations: g?.counts.intra_relations ?? 0,
        truncated: g?.counts.truncated_by_limit ?? 0,
      };
    }),
    anomalies: s.anomalies,
    delivery:
      s.delivery === null
        ? null
        : {
            verdict: s.delivery.verdict,
            conclusion: s.delivery.conclusion,
            user_pending: s.delivery.counts.user_pending ?? 0,
            blocking_reasons: s.delivery.reasons.length,
          },
    capability_table_state: s.capability_classes?.table_state ?? null,
    next_read_entry: s.next_read_entry,
  };
}
