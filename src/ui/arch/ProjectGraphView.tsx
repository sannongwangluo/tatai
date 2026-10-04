// V06-06：三个主视图（功能全景 / 系统架构 / 施工依赖）的界面（PLAN.md V06-06，DESIGN.md §3.2–§3.3 / §4.2–§4.7）。
//
// 本组件只做三件事，其余全在纯口径层（`./projectGraph.ts`）：
//   ① **取数**：两条**已交付**的只读入口——V06-05 的 `GET arch/blueprint`（规划图 + 派生回执 + 合成视图）
//      与 V06-09 的 `GET status-projection`（状态与原因的唯一来源）。本组件**不自己判状态**，
//      更不写任何颜色/进度（§4.2 明令：界面不提供人工涂色入口）。
//   ② **上屏**：三个主视图各自的选择、边语义、概览数量、筛选/搜索/当前范围、
//      加载失败/无规划/无匹配/图正在更新/图已过期这几种说明**分开显示**。
//   ③ **交互**：鼠标与键盘都能选中节点并打开详情（§3.2 五段顺序）、跨视图定位（稳定 ID 对齐）、
//      回到全图（只在用户点它时动视口）、返回上次位置。
//
// 三条本卡专守的红线（每条在代码里都有一处落点）：
//   · **不自动跳回全局**（§3.3）：数据更新后不 fitView、不动视口；视口只在「回到全图」或首次进入时归位。
//   · **布局增量更新不跳动**（§3.3）：坐标走 `layout.mergeIncrementalLayout`——已有节点坐标原样保留。
//   · **不提供涂色入口**：本文件里没有任何写状态/写颜色的调用（只有读口 + 筛选 + 选中）。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTheme } from "../theme";
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { Blueprint, BlueprintNode } from "../../arch/blueprint";
import type { SharedGraph } from "../../arch/shared-graph";
import { declaredLinksFromMatched } from "../../shared/reconcileLinks";
import type { ProjectItem, ArchBlueprintDraft } from "../api";
import { getArchBlueprint, getArchReconcile, getLive, getStatusProjection } from "../api";
import { ArchCanvas } from "./ArchCanvas";
import { GRAPH_PAGE_POLL_MS, hasAdvancedEvents } from "./lastSeq";
import { NODE_HEIGHT, NODE_WIDTH, mergeIncrementalLayout } from "./layout";
import {
  EMPTY_FILTER,
  EDGE_SEMANTICS,
  EDGE_SEMANTICS_ORDER,
  NO_STATUS_RECORD,
  PROJECT_VIEWS,
  VIEW_FILTERS,
  aggregateStatusOf,
  applyViewFilter,
  buildViewModel,
  detailSectionsOf,
  directStatusOf,
  emptyStateOf,
  freshnessOf,
  graphUpdateBannerOf,
  noStatusRecordOf,
  moduleStatusKeysOf,
  planCodeNodeIdOf,
  blueprintNodeStatusOf,
  capabilityStatusOf,
  objectIdOf,
  scopeReportOf,
  taskDerivedModuleStatus,
  type EdgeSemantics,
  type NodeStatus,
  type ProjectViewModel,
  type ProjectViewKind,
  type ViewFilter,
  type ViewFilterKind,
  type ViewNode,
  type ViewEdge,
  type SemanticStatusView,
  type GraphUpdateView,
} from "./projectGraph";
// V09-13：来源与证据标注的**判据**（`provenance.ts`，与 MCP 读口同一份）与**共享渲染件**
//（`ProvenancePanel.tsx`）——三个 UI 文件都读这两份，不各写一套来源种类/证据状态的判断与文案。
import {
  evidenceBadgeClassOf,
  evidenceShortOf,
  intraGroupRelationsOf,
  sourceKindLabelOf,
  UNMAPPED_BADGE_CLASS,
  type EvidenceState,
  type IntraGroupRelation,
  type ProvenanceAnnotation,
  type ProvenanceModel,
} from "./provenance";
import { GraphAttentionBar, IntraRelationChips, IntraRelationPanel, ObjectProvenanceLines, relationKindLabel, readableGraphLabel } from "./ProvenancePanel";
import {
  projectMatchedNote,
  projectUnmatchedNote,
  previousBookmark,
  pushBookmark,
  type ProjectLocateRequest,
  type ViewBookmark,
} from "./locate";
import { DISPLAY_STATUS_PALETTE, displayStatusStyle } from "./statusColor";

// ───────────────────── 节点卡（三个主视图共用一种卡，语义在卡上写清楚） ─────────────────────

/**
 * 画布节点 id → 状态投影对象 id。
 * 静态解析层的模块节点（`src-base` 这类）在投影里叫 `module:<模块 id>`；
 * 规划层节点走 `objectIdOf`（`plan:code:<模块 id>` → `module:<模块 id>`，任务 → 卡号）。
 * 这一处错，状态就会全落成"未映射"——所以口径只此一份。
 */
const moduleObjectIdOf = (nodeId: string): string =>
  nodeId.startsWith("plan:") ? (objectIdOf(nodeId, "module") ?? nodeId) : `module:${nodeId}`;

/**
 * 分组 id 的短形（`plan:cap:07` → `cap:07`）——行内显示用；**完整 id 仍放 `title` 与数据属性**，
 * 截断只是不撑爆布局，不改变"全部分组可查"（§3.2／2026-09-26 GPT-6 裁定 6）。
 */
const shortGroupId = (id: string): string => (id.startsWith("plan:") ? id.slice("plan:".length) : id);

/**
 * 本分组里**同属多个分组**的成员（裁定 6：共享模块所属的全部分组都应可查）。
 * 数据源是 `ViewNode.member_groups`（上游派生好的多值账目），界面不自己算归属。
 */
const multiOwnerMembersOf = (node: ViewNode | null): { member: string; groups: string[] }[] =>
  node?.member_groups === undefined
    ? []
    : Object.entries(node.member_groups)
        .filter(([, groups]) => groups.length > 1)
        .map(([member, groups]) => ({ member, groups: [...groups].sort() }))
        .sort((a, b) => a.member.localeCompare(b.member));

interface ProjectNodeData extends Record<string, unknown> {
  label: string;
  kind: string;
  /** 六态键；null = 未映射/不着完成色 */
  status: string | null;
  status_short: string;
  status_icon: string;
  status_basis: string;
  members: number;
  hidden_members: number;
  aggregate: boolean;
  endpoint: boolean;
  selected: boolean;
  focused: boolean;
  technical: string | null;
  /** V09-13：来源种类短标与证据状态（判据在 `provenance.ts`；这里只是上屏） */
  source_kind: string;
  evidence_state: string;
  evidence_label: string;
  user_pending: boolean;
  /** V09-13：本分组节点上的**同组关系**条目（§3.2：图上逐条可点开追来源，不只写一句解释） */
  intra: { id: string; kind: string; sources: { kind: string }[] }[];
  /** §3.2 能力分类：仅能力分组节点带（governance = 设计/治理章节，**不是产品功能能力**；
   *  unknown = 声明表损坏、分类未定，R-1 返工）；其余/取不到 = null */
  capability_class: "functional" | "governance" | "unknown" | null;
  onOpen?: (id: string) => void;
  onOpenRelation?: (edgeId: string) => void;
}

const NodeCard = ({ id, data }: NodeProps<Node<ProjectNodeData, "projectNode">>) => {
  const st = displayStatusStyle(data.status);
  const dim = data.aggregate;
  return (
    <div
      data-project-node={id}
      data-project-status={data.status ?? "unmapped"}
      data-project-node-kind={data.kind}
      data-project-status-label={data.status === null ? "未映射" : st.short}
      data-project-source-kind={data.source_kind}
      data-project-evidence-state={data.evidence_state}
      data-project-user-pending={data.user_pending ? "1" : "0"}
      {...(data.capability_class === null ? {} : { "data-project-capability-class": data.capability_class })}
      {...(dim ? { "data-project-aggregate": "1" } : {})}
      {...(data.focused ? { "data-project-focused": "1" } : {})}
      role={dim ? undefined : "button"}
      tabIndex={dim ? -1 : 0}
      aria-label={`${data.label}（${data.status === null ? "未映射" : st.short}）`}
      title={data.status_basis}
      onKeyDown={(e) => {
        if (dim) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          data.onOpen?.(id);
        }
      }}
      onClick={(e) => {
        e.stopPropagation();
        if (!dim) data.onOpen?.(id);
      }}
      className={`tt-project-node px-3 py-2 ${
        dim ? "rounded-lg border-2 border-dashed border-neutral-600 bg-neutral-900/70" : "rounded-lg border-2 bg-neutral-900"
      } ${
        data.selected
          ? "border-cyan-400"
          : data.endpoint
            ? "border-neutral-600 border-dashed"
            : data.status === null
              ? "border-neutral-600 border-dashed"
              : st.border
      }`}
      style={{
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        // 选中/定位环走 tailwind 通道（与上面 data.selected 的 border-cyan-400 同一口径）：
        // 技术详情那圈"刚被定位"的青色光环仍归 statusColor 一处，本视图不自立第二处高亮色常量
        ...(data.focused ? { outline: "2px solid rgb(34 211 238)", outlineOffset: 2 } : {}),
      }}
    >
      {/* React Flow 的连线要靠 Handle 定位端点：没有 Handle 的边会被整条丢掉（画不出来） */}
      <Handle type="target" position={Position.Left} className="!bg-neutral-600" />
      <Handle type="source" position={Position.Right} className="!bg-neutral-600" />
      <div className="flex items-center gap-1.5">
        <span className="text-[10px] text-neutral-400" data-project-status-icon>
          {data.status === null ? "—" : st.icon}
        </span>
        <p className="min-w-0 flex-1 truncate text-sm font-semibold text-neutral-100">{data.label}</p>
        {/* §3.2 能力分类：设计/治理章节**不是产品功能能力**——中性灰徽标（不用完成色、不参与状态色），
            状态文案的限定由上游 `projectGraph` 附加在 `status.basis` 里，这里不重复造句。 */}
        {data.capability_class === "governance" && (
          <span
            className="shrink-0 rounded border border-neutral-600 bg-neutral-800 px-1 py-0.5 text-[9px] text-neutral-300"
            data-project-class-badge="governance"
            title="能力分类（§3.2）：本分组是设计/治理章节，非产品功能能力——不作功能全景的能力节点、不以「已验证能力」显示、不计入产品能力计数"
          >
            设计/治理章节
          </span>
        )}
        {data.capability_class === "unknown" && (
          <span
            className="shrink-0 rounded border border-amber-600 bg-amber-950/60 px-1 py-0.5 text-[9px] text-amber-300"
            data-project-class-badge="unknown"
            title="能力分类（§3.2／R-1）：能力分类声明表损坏、本分组的分类未定——不按功能能力计数，不得据此判绿或得出「可请求验收」结论"
          >
            分类未定
          </span>
        )}
        <span className={`shrink-0 rounded border px-1 py-0.5 text-[10px] ${st.text}`}>
          {readableGraphLabel(data.status === null ? "未映射" : st.short)}
        </span>
      </div>
      <p className="mt-1 text-[10px] text-neutral-500">
        {{ capability: "项目能力", module: "组成部分", task: "工作安排", concept: "待核实概念", aggregate: "更多部分" }[data.kind] ?? "项目对象"}
        {data.members > 0 ? ` · 代表 ${data.members} 个成员` : ""}
        {data.hidden_members > 0 ? ` · 另有 ${data.hidden_members} 个未显示（聚合，隐藏≠已完成）` : ""}
        {data.endpoint ? " · 关系的端点（非本视图主体）" : ""}
      </p>
      {/* V09-13：来源种类 + 证据状态（同组关系在下面逐条可点开） */}
      <p className="mt-0.5 flex flex-wrap items-center gap-1 text-[9px]">
        <span className="rounded border border-neutral-700 px-1 text-neutral-400" data-project-source-badge={id}>
          {readableGraphLabel(data.source_kind)}
        </span>
        <span
          className={`rounded border px-1 ${
            (data.evidence_state === "missing" && data.source_kind === "未映射"
              ? UNMAPPED_BADGE_CLASS
              : evidenceBadgeClassOf(data.evidence_state as EvidenceState))
          }`}
          data-project-evidence-badge={id}
          title="证据状态由来源与证据判据给出（provenance.ts）：绿＝该对象当前全部必需验证证据有效；用户待验由用户本人记录，Agent 不代签"
        >
          {readableGraphLabel(data.evidence_label)}
        </span>
      </p>
      {data.intra.length > 0 && data.onOpenRelation !== undefined && (
        <IntraRelationChips relations={data.intra} onOpen={data.onOpenRelation} anchor={id} />
      )}
    </div>
  );
};

const nodeTypes = { projectNode: NodeCard };

// ───────────────────── 组件 ─────────────────────

export interface ProjectGraphViewProps {
  project: ProjectItem;
  /** 当前显示的主视图（页签由 `ArchView` 拥有：切视图的唯一出处） */
  view: ProjectViewKind;
  /** 指向主视图的定位请求（`ArchView` 转交；null = 没有待处理请求） */
  locate?: ProjectLocateRequest | null;
  /** 点节点的「去技术详情定位」/ 跨主视图定位 → 交给 `ArchView` 发起请求 */
  onLocate?: (req: { id: string; label: string; to: ProjectViewKind | "tech"; from: ProjectViewKind | "tech" }) => void;
  /** 选中变化（页签容器用它记"上次位置"） */
  onSelect?: (node: { id: string; label: string } | null) => void;
  /** 只生成对象讨论草稿，发送由现有聊天页负责。 */
  onDiscuss?: (node: ViewNode) => void;
}

export function ProjectGraphView({ project, view, locate, onLocate, onSelect, onDiscuss }: ProjectGraphViewProps) {
  const { theme } = useTheme();
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  useEffect(() => { setSelectedEdgeId(null); }, [project.id, view]);
  const [blueprint, setBlueprint] = useState<Blueprint | null>(null);
  /** §3.2 草稿图预览：没有已发布规划图时，画的是**未审定草稿**（`blueprint` state 装的是它） */
  const [draft, setDraft] = useState<ArchBlueprintDraft | null>(null);
  const [receipt, setReceipt] = useState<{ attempted_at: string; cache_key: string; published: boolean; kept_previous: boolean } | null>(null);
  /** V08-05：语义整理层状态（横幅要如实区分「图内容是当前版」与「语义层未生效」） */
  const [semantic, setSemantic] = useState<SemanticStatusView | null>(null);
  const [exists, setExists] = useState<boolean | null>(null);
  const [merged, setMerged] = useState<SharedGraph | null>(null);
  const [projection, setProjection] = useState<Record<string, import("../../server/work/statusProjection").StatusProjection>>({});
  /** V08-03（附录 D）：声明模块稳定 ID → 代码模块 id（审定材料索引的配对结果；空={} 不做继承） */
  const [moduleLinks, setModuleLinks] = useState<Record<string, string[]>>({});
  const [revisions, setRevisions] = useState<{ design?: string | null; plan?: string | null; plan_definition?: string | null }>({});
  /** 生效基线（V09-07 起施工图侧新鲜度改比定义哈希；此字段保留作展示/兼容） */
  const [baseline, setBaseline] = useState<{ baseline_id: string; design_revision: string; plan_revision: string; plan_definition?: string | null } | null>(null);
  /** V09-12：源变化发现链的图更新状态（正在更新＋预计用时／过期／失败；null = 没跑过） */
  const [update, setUpdate] = useState<GraphUpdateView | null>(null);
  /**
   * V09-13：每个节点/关系的**来源与证据标注** ＋ 交付阻断读数（服务端同一份派生；
   * 判据在 `provenance.ts`，界面只渲染）。null = 服务端这一版还没给（旧响应）或还没读到。
   */
  const [provenance, setProvenance] = useState<ProvenanceModel | null>(null);
  /** V09-13：当前点开的**同组关系**（§3.2：图上可点开追来源；null = 没点开关系） */
  const [openRelation, setOpenRelation] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** 本次读取时间（详情「来源时间」里的"本机读取时间"，如实标注来源） */
  const [receivedAt, setReceivedAt] = useState<string>("");
  const [filter, setFilter] = useState<ViewFilter>(EMPTY_FILTER);
  /** V09-22「显示全部」：概览 5–15 聚合口径放开——全部分组与成员一个不漏、无聚合节点；
   *  换项目在下面的 reset effect 里重置回概览（construction 视图无 aggregate_node，按钮自然不出现）。 */
  const [showAll, setShowAll] = useState(false);
  const [selected, setSelected] = useState<Record<string, string | null>>({});
  const [focused, setFocused] = useState<string | null>(null);
  const [locateNote, setLocateNote] = useState<{ state: "matched" | "unmatched"; text: string } | null>(null);
  const [bookmarks, setBookmarks] = useState<ViewBookmark[]>([]);
  /** 三个主视图各自的坐标（增量合并的产物；**不在数据更新时重算全图**） */
  const [posByView, setPosByView] = useState<Record<string, Record<string, { x: number; y: number }>>>({});
  const [backendVersions, setBackendVersions] = useState(0);
  const flowRef = useRef<ReactFlowInstance<Node<ProjectNodeData, "projectNode">, Edge> | null>(null);
  /** V09-12：最近一次读到的图更新状态（轮询里判"更新中"要重取，用 ref 免得把轮询挂进 load 的依赖） */
  const updateRef = useRef<GraphUpdateView | null>(null);
  /** React Flow 实例是否就绪（state 而非 ref：实例晚于坐标到位时补 fit 要靠它触发一次重跑） */
  const [flowReady, setFlowReady] = useState(false);
  /** 视口归位只由「回到全图」或本视图首次进入触发（§3.3：不在用户查看时自动跳回全局） */
  const fitPendingRef = useRef<Record<string, boolean>>({ functional: true, architecture: true, construction: true });
  const locateHandledRef = useRef(0);
  const draftRef = useRef(0);
  /** V09-22：`load` 的代际——换项目与「显示全部」都会重取，在途应答凭它识别自己是否已作废 */
  const loadGenRef = useRef(0);

  const load = useCallback(() => {
    const gen = ++loadGenRef.current; // V09-22：本次调用的代际（换项目/切模式的旧应答凭它丢弃）
    setLoading(true);
    setError(null);
    setBackendVersions((n) => n + 1);
    Promise.all([
      getArchBlueprint(project.id),
      getStatusProjection(project.id),
      // V08-03（附录 D）：声明模块 → 代码模块的落点用**审定材料索引**（§4.5 对账的配对结论），
      // 不另立一套匹配；对账读不到就如实不做继承（模块显示「无状态记录」，不猜）
      getArchReconcile(project.id).catch(() => ({ exists: false as const })),
    ])
      .then(([bp, proj, rec]) => {
        if (loadGenRef.current !== gen) return; // 换项目/切模式后的旧应答不写新视图
        setExists(bp.blueprint.exists);
        // §3.2：没有已发布的有效图时用**草稿**顶上（草稿恒为未审定、不可施工，界面另挂草稿横幅明示）；
        // 有有效图就只画有效图，不把草稿混进正在施工的图（服务端在那种情况下压根不给草稿）。
        const published = bp.blueprint.exists ? bp.blueprint.blueprint : null;
        const draftBp = !bp.blueprint.exists && bp.draft?.exists === true ? (bp.draft.blueprint ?? null) : null;
        setBlueprint(published ?? draftBp);
        setDraft(!bp.blueprint.exists && bp.draft?.exists === true ? bp.draft : null);
        setReceipt(bp.blueprint.exists ? (bp.blueprint.receipt ?? null) : null);
        setSemantic(bp.semantic?.status ?? null);
        setMerged(bp.view?.graph ?? null);
        const index: Record<string, import("../../server/work/statusProjection").StatusProjection> = {};
        for (const o of proj.objects) index[o.object_id] = o;
        setProjection(index);
        // V09-08 ①②：只有材料点名了实现落点的配对才继承状态色（未证实/名字信号不继承）
        const links = declaredLinksFromMatched(rec.exists ? (rec.result?.matched ?? []) : []);
        setModuleLinks(links);
        setRevisions(proj.revisions ?? {});
        setBaseline(proj.baseline ?? null);
        // V09-12：图更新状态随同一份读口回来（正在更新＋预计用时／过期／失败＋原因）
        setUpdate(bp.update ?? null);
        updateRef.current = bp.update ?? null;
        // V09-13：来源与证据标注（含交付阻断读数）随同一份读口回来，界面不另算一套
        setProvenance(bp.provenance ?? null);
        setReceivedAt(new Date().toISOString());
        setLoading(false);
      })
      .catch((e: Error) => {
        if (loadGenRef.current !== gen) return;
        setError(e.message);
        setLoading(false);
      });
  }, [project.id]);

  useEffect(() => {
    setBlueprint(null);
    setDraft(null);
    setReceipt(null);
    setExists(null);
    setMerged(null);
    setProjection({});
    setRevisions({});
    setBaseline(null);
    setUpdate(null);
    updateRef.current = null;
    setProvenance(null);
    setOpenRelation(null);
    setReceivedAt("");
    setFilter(EMPTY_FILTER);
    setShowAll(false);
    setSelected({});
    setFocused(null);
    setLocateNote(null);
    setBookmarks([]);
    setPosByView({});
    // V09-22：换项目 = 新图，三个主视图的"首次进入归位"重新置位——否则换项目后首个视图
    // 不再自动 fitView（fitPendingRef 在旧项目里已被消费掉），用户看到画布停在视口外。
    fitPendingRef.current = { functional: true, architecture: true, construction: true };
    load();
  }, [load]);

  // ── V09-07（附录 E.8-1）：图页自动失效重取——工作事件账本 `task_last_seq` 前进就自动 `load()`，
  //    无需手动刷新/切项目（手动「刷新」按钮保留）。4s 轮询 `GET live`；只在页面可见时跑
  //   （visibilitychange 暂停，回前台立即补一轮）。首轮只登记基线（挂载时 load() 已拉过），
  //    判据纯函数在 `./lastSeq.ts`（hasAdvancedEvents）。轮询失败（读不到 live）静默跳过本轮。
  //   V09-12：**源变化发现链**那一跳也走同一条轮询——`live.graph_update` 的状态/阶段/指纹变了
  //   就重取（"开始更新／更新完成／失败"都不用手动刷新就能看见），正在更新时每轮都重取
  //   （预计用时与阶段进度跟着走，更新落定后自然停止）。
  const knownSeqRef = useRef<number | null | undefined>(undefined);
  const knownUpdateRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    knownSeqRef.current = undefined; // undefined = 从未观察（首轮只登记基线）；null = 上次读出 null（v1/读不到）
    knownUpdateRef.current = undefined; // 同上：undefined = 从未观察（首轮只登记）
    let stopped = false;
    const tick = (): void => {
      if (document.visibilityState !== "visible") return;
      getLive(project.id)
        .then((live) => {
          if (stopped) return;
          const gu = live.graph_update ?? null;
          const guKey = gu === null ? "none" : `${gu.state}|${gu.phase ?? ""}|${gu.change_token ?? ""}|${gu.updated_at}`;
          const guChanged = knownUpdateRef.current !== undefined && knownUpdateRef.current !== guKey;
          knownUpdateRef.current = guKey;
          const cur = live.task_last_seq;
          const seqChanged = hasAdvancedEvents(knownSeqRef.current, cur);
          knownSeqRef.current = cur;
          if (guChanged || seqChanged || updateRef.current?.state === "updating") load();
        })
        .catch(() => undefined);
    };
    const timer = setInterval(tick, GRAPH_PAGE_POLL_MS);
    // 挂载立即登记基线（只登记、不加载）：否则"挂载后、首个 4s tick 前"落进来的事件会被
    // 首次观察当成基线吞掉，永远触发不了重取（实测复现：UI 脚本 5s 提交、18s 窗内不刷新）
    tick();
    const onVisible = (): void => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [project.id, load]);

  /** V08-03（附录 D）：模块层状态派生（声明路径∩代码模块 × 任务状态；声明模块按审定材料索引继承）——
   *  画布、详情卡、（架构视图的）模块色都共用这一份 */
  const moduleDerived = useMemo(
    () =>
      blueprint === null
        ? { status: {}, by_object: {}, tasks_by_module: {} }
        : taskDerivedModuleStatus({ blueprint, projection, declared_links: moduleLinks }),
    [blueprint, projection, moduleLinks],
  );

  /** 模型（纯函数）：三视图共用同一份蓝图与投影，差别只在选择口径 */
  const model: ProjectViewModel | null = useMemo(() => {
    if (blueprint === null) return null;
    return buildViewModel({
      view,
      blueprint,
      projection,
      mergedNodes: (merged?.nodes ?? []).map((n) => ({ id: n.id, plan_refs: n.plan_refs })),
      module_status: moduleDerived.status,
      // V09-22：显示全部 = 概览上限换 full 口径（同一份蓝图与投影，不另造图事实源）
      overview_full: showAll,
    });
  }, [blueprint, projection, merged, view, moduleDerived, showAll]);

  const filtered = useMemo(
    () => (model === null ? null : applyViewFilter(model.nodes, filter, model.edges)),
    [model, filter],
  );
  const scope = useMemo(
    () => (model === null || filtered === null ? null : scopeReportOf(model.nodes, filter, filtered.nodes)),
    [model, filtered, filter],
  );
  const empty = emptyStateOf({
    loading,
    error,
    // 草稿图不算"已发布"，但**确实有图可看**——空态文案不该在这时说"没有图"（§3.2 可预览）
    blueprint_exists: exists === true || draft !== null,
    node_total: model?.nodes.length ?? 0,
    node_shown: filtered?.nodes.length ?? 0,
  });
  const fresh = freshnessOf({ blueprint, receipt, revisions, baseline, semantic });
  /** V09-12：正在更新（含预计用时或「无法估计」）／已过期／更新失败——ready 时不出横幅 */
  const updateBanner = graphUpdateBannerOf(update);

  const visibleIds = useMemo(() => new Set((filtered?.nodes ?? []).map((n) => n.id)), [filtered]);
  const visibleEdges = useMemo(
    () => (model?.edges ?? []).filter((e) => visibleIds.has(e.from) && visibleIds.has(e.to)),
    [model, visibleIds],
  );

  /**
   * V09-13：节点/关系稳定 ID → 来源与证据标注（判据在 `provenance.ts`；界面不另判一套）。
   *
   * 查表键与 `ArchCanvas` **同一套口径**（`planCodeNodeIdOf`）：系统架构主视图复用共用画布，
   * 它画的是**技术模块 id**（`src`、`audit`），模型里的键却是蓝图节点 id（`plan:code:src`）——
   * 只按原样查会让该屏节点徽标与详情都落空（复核项 H-4）。`planCodeNodeIdOf` 对已是
   * `plan:` 开头的 id 原样返回，故两类 id 走同一个入口。
   */
  const annotationOf = useMemo(() => {
    const table = provenance?.by_object ?? {};
    return (id: string): ProvenanceAnnotation | null => table[planCodeNodeIdOf(id)] ?? table[id] ?? null;
  }, [provenance]);

  /**
   * V09-13（§3.2 同组关系可见性）：本次视图里两端落在同一分组的关系，逐条列在分组节点上并可点开。
   * 判据与追溯行来自 `provenance.ts` 的 `intraGroupRelationsOf`（唯一实现）；
   * `visible_on_graph` 恒 true——因为下面确实把它们逐条画成了分组节点上的条目（不是只写一句解释）。
   */
  const intraRelations: IntraGroupRelation[] = useMemo(() => {
    if (model === null) return [];
    const labelOf = new Map(model.groups.map((g) => [g.key, g.label]));
    return intraGroupRelationsOf(
      model.intra_relations.map((e) => ({
        edge_id: e.id,
        group_id: e.group_key ?? e.from,
        group_label: labelOf.get(e.group_key ?? e.from) ?? e.group_key ?? e.from,
        kind: e.kind,
        semantics: e.semantics,
        source: e.from,
        target: e.to,
        sources: e.sources.map((s) => ({ kind: s.kind, path: s.path, locator: s.locator, sha256: s.sha256 })),
        visible_on_graph: true,
      })),
    );
  }, [model]);

  const intraByGroup = useMemo(() => {
    const map = new Map<string, { id: string; kind: string; sources: { kind: string }[] }[]>();
    for (const r of intraRelations) {
      const list = map.get(r.group_id) ?? [];
      list.push({ id: r.edge_id, kind: r.kind, sources: r.sources.map((s) => ({ kind: s.kind })) });
      map.set(r.group_id, list);
    }
    return map;
  }, [intraRelations]);

  const relationOf = (edgeId: string): IntraGroupRelation | null =>
    intraRelations.find((r) => r.edge_id === edgeId) ?? null;

  /** 键：可见节点集合的稳定指纹——只有它变了才重算布局（数据更新不动已有坐标） */
  const layoutKey = useMemo(() => (filtered?.nodes ?? []).map((n) => n.id).join("|"), [filtered]);

  const drawnNodes = useMemo(() => {
    if (filtered === null) return [];
    return filtered.nodes;
  }, [filtered]);

  useEffect(() => {
    if (drawnNodes.length === 0) return;
    setPosByView((prev) => {
      // 排图与增量合并都在 `layout.mergeIncrementalLayout` 里（dagre 调用点不另立一处）
      const merged = mergeIncrementalLayout({
        prev: prev[view] ?? {},
        nodes: drawnNodes.map((n) => ({ id: n.id })),
        edges: visibleEdges.map((e) => ({ from: e.from, to: e.to })),
      });
      return { ...prev, [view]: merged.positions };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutKey, view]);

  const modelNodeById = useMemo(() => {
    const m = new Map<string, ViewNode>();
    for (const n of model?.nodes ?? []) m.set(n.id, n);
    // 架构视图画布上的静态模块 id（没有规划对象）也要能点开详情：按投影现造一个视图节点
    for (const n of merged?.nodes ?? []) {
      if (m.has(n.id)) continue;
      const objectId = moduleObjectIdOf(n.id);
      m.set(n.id, {
        id: n.id,
        label: n.name,
        kind: "module",
        group_key: null,
        members: [],
        hidden_members: 0,
        // 与画布同一份口径（V08-03 附录 D）：投影对象 → 任务派生（按对象 id 查） → 如实「无状态记录」
        status:
          projection[objectId] !== undefined
            ? directStatusOf(projection[objectId])
            : blueprint === null
              ? noStatusRecordOf(objectId)
              : blueprintNodeStatusOf(planCodeNodeIdOf(n.id), { blueprint, projection, module_status: moduleDerived.status }),
        sources: [],
        technical_id: n.id,
      });
    }
    return m;
  }, [model, merged, projection, blueprint, moduleDerived]);

  const openDetail = useCallback(
    (id: string) => {
      setSelectedEdgeId(null);
      setSelected((prev) => ({ ...prev, [view]: id }));
      setFocused(id);
      const label = modelNodeById.get(id)?.label ?? id;
      onSelect?.({ id, label });
      const entry: ViewBookmark = { view, node_id: id, filter_kind: filter.kind, query: filter.query };
      setBookmarks((prev) => pushBookmark(prev, entry));
    },
    [view, modelNodeById, onSelect, filter],
  );

  // ── 定位（对齐键 = 稳定 ID；不重置本视图的筛选/坐标/选中之外的东西）──
  useEffect(() => {
    if (!locate || locate.nonce === 0 || locateHandledRef.current === locate.nonce) return;
    if (locate.to !== view) return; // 请求不是给这个视图的（目标视图自己处理）
    locateHandledRef.current = locate.nonce;
    const hit = modelNodeById.has(locate.id);
    setFocused(locate.id);
    setLocateNote({
      state: hit ? "matched" : "unmatched",
      text: hit
        ? projectMatchedNote(locate, "本视图的筛选、坐标与选中都不变（§3.3）")
        : projectUnmatchedNote(locate, "本视图的节点集合里没有这个稳定 ID（它可能属于别的视图或还没生成）"),
    });
    if (hit) openDetail(locate.id);
  }, [locate, view, modelNodeById, openDetail]);

  // ── 视口：只在首次进入本视图或点「回到全图」时归位（不自动跳回全局）──
  /** 布局就绪：本视图每个可见节点都有坐标了（否则首帧 fit 会把还没落位的 0,0 当成全图） */
  const layoutReady =
    drawnNodes.length > 0 && drawnNodes.every((n) => posByView[view]?.[n.id] !== undefined);
  useEffect(() => {
    const inst = flowRef.current;
    // flowReady 是 state 而不是只读 ref：实例晚于坐标就绪时也要再跑一次（否则这一轮 fit 永远不发生，
    // 节点就停在视口外的原始坐标上——"进视图什么都没看到"）
    if (inst === null || !flowReady || empty.state === "loading" || !layoutReady) return;
    if (fitPendingRef.current[view] !== true) return;
    // 两次：第一次趁坐标已写进节点，第二次等尺寸测量完（与 F4 补 fit 同一口径）
    let second = 0;
    const t = requestAnimationFrame(() => {
      void inst.fitView({ padding: 0.2, minZoom: 0.85, maxZoom: 1 });
      second = requestAnimationFrame(() => {
        void inst.fitView({ padding: 0.2, minZoom: 0.85, maxZoom: 1 });
        // 只有真正执行过才消费首次定位，避免渲染清理取消 rAF 后永久停在 (0, 0)。
        fitPendingRef.current[view] = false;
      });
    });
    return () => {
      cancelAnimationFrame(t);
      if (second) cancelAnimationFrame(second);
    };
  }, [view, layoutReady, empty.state, posByView, flowReady]);

  const goFull = useCallback(() => {
    const inst = flowRef.current;
    if (inst !== null) void inst.fitView({ padding: 0.2, maxZoom: 1 });
    setLocateNote({ state: "matched", text: "已回到全图（视口归位只在用户点它或首次进入时发生，§3.3）" });
  }, []);

  const returnToLast = useCallback(() => {
    const current: ViewBookmark = { view, node_id: selected[view] ?? null, filter_kind: filter.kind, query: filter.query };
    const prev = previousBookmark(bookmarks, current);
    if (prev === null) {
      setLocateNote({ state: "unmatched", text: "没有可返回的上次位置（位置栈里只有当前位置）" });
      return;
    }
    setFilter({ kind: prev.filter_kind as ViewFilterKind, query: prev.query });
    if (prev.node_id !== null) {
      setFocused(prev.node_id);
      setLocateNote({ state: "matched", text: `已返回上次位置：${prev.view} 的节点 ${prev.node_id}（含当时的筛选与搜索）` });
    } else {
      setLocateNote({ state: "matched", text: `已返回上次位置：${prev.view}（未选中节点）` });
    }
  }, [view, selected, filter, bookmarks]);

  const selectedNode = selected[view] === null || selected[view] === undefined ? null : (modelNodeById.get(selected[view]!) ?? null);
  /** 裁定 6：选中分组里**同属多个分组**的成员（逐行列出它的全部分组；分组本身不是多归属时为空） */
  const multiOwnerMembers = useMemo(() => multiOwnerMembersOf(selectedNode), [selectedNode]);
  const sections =
    selectedNode !== null && blueprint !== null
      ? detailSectionsOf({
          node: selectedNode,
          blueprint,
          view_notes: model?.notes,
          received_at: receivedAt,
          merged_nodes: (merged?.nodes ?? []).map((n) => ({ id: n.id, plan_refs: n.plan_refs, blurb: n.blurb })),
        })
      : null;
  const selectedEdge: ViewEdge | null = model?.edges.find((edge) => edge.id === selectedEdgeId) ?? null;
  const relatedEdges = selectedNode === null ? [] : (model?.edges ?? []).filter((edge) => edge.from === selectedNode.id || edge.to === selectedNode.id);

  // ── 画布数据（三个主视图共用一份构造；架构视图交给 ArchCanvas 画实测模块层）──
  const ownCanvas = useMemo(() => {
    if (model === null || filtered === null) return null;
    const pos = posByView[view] ?? {};
    const nodes: Node<ProjectNodeData, "projectNode">[] = filtered.nodes.map((n) => ({
      id: n.id,
      type: "projectNode",
      position: pos[n.id] ?? { x: 0, y: 0 },
      // 显式宽高：节点首帧就有尺寸，不必等 React Flow 的异步测量。缺这两个字段时切视图会有
      // 一批节点停在 visibility:hidden（用户看到空画布）。取值与 NodeCard 的内联 style 同源。
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
      draggable: n.aggregate !== true,
      data: {
        label: n.label,
        kind: String(n.kind),
        status: n.status.display,
        status_short: n.status.short ?? (n.status.display === null ? "未映射" : DISPLAY_STATUS_PALETTE[n.status.display].short),
        status_icon: n.status.display === null ? "—" : DISPLAY_STATUS_PALETTE[n.status.display].icon,
        status_basis: n.status.basis,
        members: n.members.length,
        hidden_members: n.hidden_members,
        aggregate: n.aggregate === true,
        endpoint: n.endpoint === true,
        selected: selected[view] === n.id,
        focused: focused === n.id,
        technical: n.technical_id,
        // V09-13：来源种类与证据状态（取不到标注时如实写"未映射/缺标注"，**不默认给绿**）
        // 短标与徽标样式都取自 `provenance.ts` 的同一份词表（三个 UI 文件不各写一套）
        source_kind: (() => {
          const a = annotationOf(n.id);
          return a === null ? "未映射" : sourceKindLabelOf(a.source_kinds);
        })(),
        evidence_state: annotationOf(n.id)?.evidence_state ?? "missing",
        evidence_label: (() => {
          const a = annotationOf(n.id);
          return a === null ? "缺标注" : evidenceShortOf(a.evidence_state);
        })(),
        user_pending: annotationOf(n.id)?.user_pending ?? false,
        intra: intraByGroup.get(n.id) ?? [],
        // §3.2 能力分类（判据在 `projectGraph`：分类唯一来源是设计书的「能力分类声明」表，界面不另判一套）
        capability_class: n.capability_class ?? null,
        onOpen: openDetail,
        onOpenRelation: (edgeId: string) => setOpenRelation(edgeId),
      },
    }));
    const edges: Edge[] = visibleEdges.map((e) => {
      const spec = EDGE_SEMANTICS[e.semantics];
      const statusStyle = e.semantics === "dependency" && e.status !== null ? DISPLAY_STATUS_PALETTE[e.status] : null;
      const color = statusStyle?.hex ?? spec.color;
      // 依赖线有结论 → 实线 + 状态色；没结论（未判前置是否释放）→ 语义自带的**中性虚线**
      // （§4.2 表最后一行：未知/陈旧用中性虚线与文字）
      const dash = statusStyle !== null ? null : spec.dash;
      return {
        id: e.id,
        source: e.from,
        target: e.to,
        className: `te-edge te-edge-${e.semantics}`,
        label: e.semantics === "dependency" ? (e.status === null ? "前置未判" : statusStyle!.short) : spec.label,
        labelStyle: { fill: "var(--tt-text)", fontSize: 11 },
        labelBgStyle: { fill: "var(--tt-surface)", fillOpacity: 0.94 },
        style: {
          stroke: color,
          strokeWidth: 2,
          ...(dash !== null ? { strokeDasharray: dash } : {}),
        },
        markerEnd: { type: MarkerType.ArrowClosed, color, width: 14, height: 14 },
      } as Edge;
    });
    return { nodes, edges };
  }, [model, filtered, visibleEdges, posByView, view, selected, focused, openDetail, annotationOf, intraByGroup]);

  /** 架构视图的画布数据：合成后的共用数据层里去掉任务节点（任务归施工依赖视图） */
  const archGraph: SharedGraph | null = useMemo(() => {
    if (merged === null || model === null || filtered === null) return null;
    const keptGroups = new Set(filtered.nodes.map((n) => n.id));
    // 多归属成员会出现在多个分组里（2026-09-26 复核口径）：任一分组被保留，成员就跟着保留
    const owner = new Map<string, string[]>();
    for (const g of model.groups)
      for (const m of g.members) {
        const list = owner.get(m) ?? [];
        list.push(g.key);
        owner.set(m, list);
      }
    const keep = (id: string): boolean => {
      if (id.startsWith("plan:task:") || id.startsWith("plan:concept")) return false;
      if (id.startsWith("plan:")) {
        const gks = owner.get(id) ?? (id.startsWith("plan:cap:") ? [id] : []);
        if (gks.length === 0) return false;
        return gks.some((gk) => keptGroups.has(gk));
      }
      const gks = owner.get(`plan:code:${id}`) ?? [];
      return gks.length === 0 ? true : gks.some((gk) => keptGroups.has(gk));
    };
    const nodes = merged.nodes.filter((n) => keep(n.id));
    const ids = new Set(nodes.map((n) => n.id));
    const edges = merged.edges.filter((e) => ids.has(e.from) && ids.has(e.to));
    const out = [...nodes];
    const agg = model.aggregate_node;
    if (agg !== null) {
      out.push({
        id: agg.id,
        name: agg.label,
        path: "",
        blurb: agg.status.basis,
        kind: "mixed",
        file_count: 0,
        aggregate: true,
        plan_origin: "plan",
      });
    }
    return {
      ...merged,
      nodes: out,
      edges,
      // 这里的"少掉的节点"是**视图选择**（按能力分组截断），不是共用数据层的渲染上限聚合：
      // 不冒充 `truncated`（否则 ArchCanvas 会打出"已达渲染上限"的错误说明），
      // 隐藏数量由上面那个聚合节点自己的 label/basis 如实带出。
      truncated: { nodes: 0, edges: 0 },
    };
  }, [merged, model, filtered]);

  // V08-02 B2/B3/B4 + V08-06 ①：模块层状态 = ① 投影里真有 `module:*` 对象就用它；
  // ② 没有就按**实现映射/对账配对从任务状态派生**（附录 D，`moduleStatusKeysOf` 同时给
  //    `plan:code:<模块 id>`、`plan:mod:<稳定 ID>` 与技术模块 id 三套键）；
  // ③ **能力节点**按成员派生（`capabilityStatusOf`，与三视图同一份口径）；
  // ④ 都取不到才如实标「无状态记录」——不再让声明模块/能力在画布上落「无状态记录」。
  const archStatus = useMemo(() => {
    if (blueprint === null) return {};
    const derived = moduleDerived;
    const keys = moduleStatusKeysOf(derived);
    const capMembers = new Map((model?.groups ?? []).map((g) => [g.key, g.members]));
    const out: Record<string, string> = {};
    for (const n of archGraph?.nodes ?? []) {
      const hit = keys[n.id];
      if (hit !== undefined) {
        out[n.id] = hit;
        continue;
      }
      if (n.id.startsWith("plan:cap:")) {
        const st = capabilityStatusOf(
          (capMembers.get(n.id) ?? []).map((m) => ({
            id: m,
            status: blueprintNodeStatusOf(m, { blueprint, projection, module_status: derived.status }),
          })),
        );
        out[n.id] = st.display ?? (st.unmapped_reason === "no_task_evidence" ? NO_STATUS_RECORD : "unmapped");
        continue;
      }
      const objectId = moduleObjectIdOf(n.id);
      const direct = projection[objectId];
      const st: NodeStatus = direct !== undefined ? directStatusOf(direct) : noStatusRecordOf(objectId);
      out[n.id] = st.display ?? (st.unmapped_reason === "no_task_evidence" ? NO_STATUS_RECORD : "unmapped");
    }
    return out;
  }, [archGraph, projection, moduleDerived, model, blueprint]);

  return (
    <div
      className="tt-project-graph flex min-h-0 flex-1 flex-col"
      data-project-view={view}
      data-project-view-kind={PROJECT_VIEWS[view].projection_kind}
      // V09-22：概览/全量（显示全部）模式状态常驻可读
      data-project-mode-state={showAll ? "full" : "overview"}
      data-project-reads={backendVersions}
      // V09-12：图更新状态常驻可读（ready 时不显示横幅，但状态与"本次变更指纹"仍可被读到）
      data-project-update={update?.state ?? "none"}
      data-project-update-token={update?.change_token ?? ""}
      // V09-13：交付阻断读数常驻可读（结论句 + 阻断条数 + 人工待验条数）
      data-project-delivery={provenance?.delivery.verdict ?? "unknown"}
      data-project-delivery-conclusion={provenance?.delivery.conclusion ?? ""}
      data-project-delivery-blocked={provenance !== null && !provenance.delivery.deliverable_allowed ? "1" : "0"}
    >
      {/* V09-13（§3.2／§4.2／附录 E.9）＋ V09-20 回归修复（§3.11／§4.2，附录 E.20）：**六图的
          「来源与证据」信息栏**——交付阻断读数与模型提案待审线索（§4.1／附录 E.17／E.18）**合成一条**：
          健康态（无阻断、能力分类未定 0、无待审线索）整条不占常驻行；有可行动异常时只出一条合并问题栏，
          白话摘要逐类给数量＋一个查看入口，完整计数/五档图例/逐条阻断/逐条待验/逐条线索都在浮层详情里。
          读数与 MCP 读口是同一份（判据 `provenance.ts`＋`attentionCountsOf`）；不改判据、不代签。 */}
      {provenance !== null && (
        <GraphAttentionBar
          delivery={provenance.delivery}
          leads={provenance.model_leads ?? []}
          nodeLeads={provenance.model_node_leads ?? []}
          anchor={`project-${view}`}
        />
      )}
      {/* §3.2 草稿图：没有已发布的有效图时，画的是未审定草稿——必须一眼看清"这不是有效图" */}
      {draft !== null && (
        <details
          data-project-draft={draft.label ?? "draft_unaudited"}
          className="tt-graph-notice shrink-0 border-b border-sky-500/40 bg-sky-500/10 px-3 py-1 text-[11px] text-sky-300"
        >
          <summary>这是尚未审定的草稿图，不能作为施工依据。查看说明</summary>
          <p>
          {draft.note ?? "草稿图（未审定）：不能当施工依据"}（§3.2）
          {draft.reason != null && draft.reason !== "" ? `；未发布原因：${draft.reason}` : ""}
          </p>
        </details>
      )}

      {/* V09-12（§3.3 末段 / §4.4）：源变化发现链的更新状态——正在更新时显示**有依据的预计用时**
          （依据不足就「无法估计」，不编造数字）；未完成/失败/被中断时明确标出并给原因。
          ready 时不出横幅。 */}
      {updateBanner !== null && (
        <p
          data-project-update-banner={updateBanner.state}
          data-project-update-eta={updateBanner.eta_text}
          className={`shrink-0 border-b px-3 py-1 text-[11px] ${
            updateBanner.state === "updating"
              ? "border-amber-500/40 bg-amber-500/10 text-amber-300"
              : "border-rose-500/40 bg-rose-500/10 text-rose-300"
          }`}
        >
          {updateBanner.text}
        </p>
      )}

      {/* 图正在更新 / 图已过期：源更新了但新图没就位时**继续显示上次有效图**并标出来（§3.3 / §4.4） */}
      {fresh.banners.map((b) => (
        <details
          key={b}
          data-project-freshness={b.startsWith("图已过期") ? "stale" : "updating"}
          className="tt-graph-notice shrink-0 border-b border-amber-500/40 bg-amber-500/10 px-3 py-1 text-[11px] text-amber-300"
        >
          <summary>{b.startsWith("图已过期") ? "图已过期：设计或工作安排改过，新图尚未生成。" : b.startsWith("图内容是") ? "图是当前版本，但自动整理的补充说明尚未生效。" : "新图还未就位，暂时显示上一次有效图。"} 查看原因</summary>
          <p>{b.replace(/\*\*/g, "")}</p>
        </details>
      ))}

      {/* 工具条：搜索 / 筛选 / 回到全图 / 返回上次位置 / 刷新 + 当前范围 */}
      <div className="tt-graph-toolbar flex shrink-0 flex-wrap items-center gap-2 border-b border-neutral-800 px-3 py-1.5">
        <input
          data-project-search
          value={filter.query}
          onChange={(e) => setFilter((f) => ({ ...f, query: e.target.value }))}
          placeholder="查找项目中的部分…"
          aria-label="搜索节点名称或稳定标识"
          className="w-52 rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-[11px] text-neutral-200"
        />
        <nav className="flex gap-1" data-project-filter-switch>
          {(Object.keys(VIEW_FILTERS) as ViewFilterKind[]).map((k) => (
            <button
              key={k}
              data-project-filter={k}
              title={VIEW_FILTERS[k].means}
              onClick={() => setFilter((f) => ({ ...f, kind: k }))}
              className={`rounded px-2 py-0.5 text-[11px] ${
                filter.kind === k
                  ? "border border-neutral-700 bg-neutral-800 text-neutral-100"
                  : "text-neutral-500 hover:text-neutral-300"
              }`}
            >
              {VIEW_FILTERS[k].label}
            </button>
          ))}
        </nav>
        <button
          data-project-fit
          title="首次按可读比例展示，可拖动查看；点此缩放到完整项目图"
          onClick={goFull}
          className="rounded border border-neutral-700 px-2 py-0.5 text-[11px] text-neutral-300 hover:bg-neutral-800"
        >
          回到全图
        </button>
        <button
          data-project-return
          onClick={returnToLast}
          className="rounded border border-neutral-700 px-2 py-0.5 text-[11px] text-neutral-300 hover:bg-neutral-800"
        >
          返回上次位置
        </button>
        <button
          data-project-refresh
          onClick={load}
          className="rounded border border-neutral-700 px-2 py-0.5 text-[11px] text-neutral-300 hover:bg-neutral-800"
        >
          刷新
        </button>
        {scope !== null && (
          <span data-project-scope={scope.note} className="text-[11px] text-neutral-400">
            {scope.note}
          </span>
        )}
        {/* V09-22：显示全部分组 / 返回概览——只有概览超量（有聚合节点）时才给入口；
            construction 视图无 aggregate_node，按钮自然不出现（同一份真实模型判据，不做项目特例）。 */}
        {model?.aggregate_node != null && !showAll && (
          <button
            data-project-show-all
            title="概览只显示 5–15 个主要分组；点开列出全部分组与成员（隐藏≠已完成）"
            onClick={() => setShowAll(true)}
            className="rounded border border-neutral-700 px-2 py-0.5 text-[11px] text-neutral-300 hover:bg-neutral-800"
          >
            显示全部分组
          </button>
        )}
        {showAll && (
          <button
            data-project-show-overview
            onClick={() => setShowAll(false)}
            className="rounded border border-neutral-700 px-2 py-0.5 text-[11px] text-neutral-300 hover:bg-neutral-800"
          >
            返回概览
          </button>
        )}
      </div>

      {/* 本视图的口径（分组口径 + 数量口径）：§3.3 的"5–15 个主要分组 / 不足 5 不凑数 / 超量聚合"都在这儿说清。
          V09-21 R3：限高内滚——长口径平铺实测占 151px 把画布挤到 150px（1280×800），
          文字一条不删、DOM 结构不变（读数锚点 `data-project-notes` 原样），超出部分滚动看。
          2026-09-27 用户指令：与同组关系面板（ProvenancePanel.IntraRelationPanel）一样，默认**收起成一行**，
          点开 summary 才回到上面的限高内滚视图；收起≠删内容，`<p>` 逐段一条不少全在 DOM 里。 */}
      <details className="tt-graph-guide">
        <summary>图中的数量、连线与分组说明</summary>
      {model !== null && (
        <div data-project-notes={model.notes.join(" | ")} className="shrink-0 border-b border-neutral-800 px-3 py-1">
          <details data-project-notes-fold="1">
            <summary className="cursor-pointer text-[11px] text-neutral-500" data-project-notes-summary="1">
              数量与分组说明（{model.notes.length} 段）
            </summary>
            <div className="mt-0.5 max-h-20 space-y-0.5 overflow-y-auto">
              {model.notes.map((n) => (
                <p key={n} className="text-[11px] text-neutral-500">
                  {n}
                </p>
              ))}
            </div>
          </details>
        </div>
      )}

      {/* 边语义图例（§4.2：依赖线与集成线语义分开，颜色之外还有文字通道） */}
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-neutral-800 px-3 py-1 text-[11px]" data-project-edge-legend>
        {EDGE_SEMANTICS_ORDER.map((s: EdgeSemantics) => {
          const spec = EDGE_SEMANTICS[s];
          const count = visibleEdges.filter((e) => e.semantics === s).length;
          return (
            <span key={s} className="flex items-center gap-1" data-edge-legend={s} data-edge-count={count}>
              <span
                className="inline-block h-0 w-5 border-t-2"
                style={{
                  borderColor: spec.color,
                  ...(spec.dash === null ? {} : { borderTopStyle: "dashed" }),
                }}
              />
              <span className="text-neutral-400">
                {spec.label}（{count}）{spec.completion_colored ? "：会按前置是否满足着色" : "：不着完成色"}
              </span>
            </span>
          );
        })}
      </div>

      {/* V09-13（§3.2 同组关系可见性）：**同组关系逐条可点开追来源**——不是只在本视图口径句里写一句
          "有 N 条"。每条带稳定 ID、关系种类与来源种类，展开即显示出处行（`trace_lines`）。 */}
      {model !== null && (
        <IntraRelationPanel
          relations={intraRelations}
          anchor={`project-${view}`}
          emptyNote="本视图当前没有同组关系（没有两端落在同一分组的关系）"
        />
      )}
      </details>

      <div className="tt-graph-and-detail flex min-h-0 flex-1">
        {/* V09-20（§3.11）：画布宿主保有**最小可操作高度**——详情浮层已经不占纵向排版（不会再把画布压成 0），
            这一条是兜底：任何上方面板变高的情形下，画布也不至于被挤到点不着。 */}
        <div className="relative flex min-h-[120px] flex-1 flex-col" data-project-canvas-host>
          {/* 读盘/刷新出错**不报废已经画出来的图**（与 ArchCanvas 的 Q49 同一口径）：
              已经有模型时只挂一条横幅（可重试），空态卡只留给"第一次就读不出来"这一类。 */}
          {model !== null && error !== null && (
            <div
              data-project-error={error}
              className="flex shrink-0 items-center gap-2 border-b border-red-500/40 bg-red-500/10 px-3 py-1.5 text-[11px] text-red-300"
            >
              <span className="min-w-0 flex-1 truncate">读取失败：{error}</span>
              <button
                data-project-retry
                onClick={load}
                className="shrink-0 rounded border border-red-500/40 px-1.5 py-0.5 hover:bg-red-500/20"
              >
                重试
              </button>
            </div>
          )}
          {model !== null && loading && error === null && (
            <p data-project-loading="1" className="shrink-0 border-b border-neutral-800 px-3 py-1 text-[11px] text-neutral-500">
              正在刷新…（图上还是上一份有效结果，视口与坐标不动，§3.3）
            </p>
          )}
          {/* 空态卡的条件：**没有可看的模型**时才整块替换画布——
              已有模型时的刷新/失败只在上面挂一行，免得把用户正看着的图连视口一起清掉 */}
          {empty.state !== "ready" && model === null ? (
            <div className="flex h-full items-center justify-center p-6">
              <div className="w-full max-w-xl space-y-2 rounded border border-neutral-800 bg-neutral-950 p-4">
                <p className="text-sm font-bold text-neutral-200" data-project-empty={empty.state}>
                  {empty.title}
                </p>
                <p className="break-all text-xs text-neutral-400">{empty.hint}</p>
                {empty.retryable && (
                  <button
                    data-project-retry
                    onClick={load}
                    className="rounded border border-neutral-700 px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-800"
                  >
                    重试
                  </button>
                )}
              </div>
            </div>
          ) : empty.state === "no_match" ? (
            <div className="flex h-full items-center justify-center p-6">
              <div className="w-full max-w-xl space-y-2 rounded border border-neutral-800 bg-neutral-950 p-4">
                <p className="text-sm font-bold text-neutral-200" data-project-empty="no_match">
                  {empty.title}
                </p>
                <p className="text-xs text-neutral-400">{empty.hint}</p>
              </div>
            </div>
          ) : view === "architecture" ? (
            <ArchCanvas
              project={project}
              mode="MODULE_BOX"
              graphOverride={archGraph}
              statusOverride={archStatus}
              // V09-13（复核项 H-4）：**同一份来源与证据标注**也要传进本屏画布——
              // 否则系统架构主视图的节点没有来源/证据徽标（另两主视图与技术详情三图都有）。
              // 读数盘的重复上屏由 `showDeliveryReadout={false}` 关掉：本组件上面已有一份同源读数。
              provenance={provenance}
              showDeliveryReadout={false}
              onNodeClick={(n) => openDetail(n.id)}
            />
          ) : (
            <ReactFlow
              nodes={ownCanvas?.nodes ?? []}
              edges={ownCanvas?.edges ?? []}
              nodeTypes={nodeTypes}
              minZoom={0.1}
              nodesConnectable={false}
              onInit={(inst) => {
                flowRef.current = inst;
                setFlowReady(true);
              }}
              onPaneClick={() => undefined}
              colorMode={theme}
              onEdgeClick={(_, edge) => setSelectedEdgeId(edge.id)}
              proOptions={{ hideAttribution: true }}
            >
              <Background gap={24} color="var(--tt-canvas-dot)" />
              <Controls showInteractive={false} />
            </ReactFlow>
          )}
        </div>

        {/* 详情：§3.2 的五段顺序（作用 → 当前情况与原因 → 设计/施工出处 → 验证结果 → 技术资料）
            ＋ V09-13 的「来源与证据」段（来源种类／映射／证据状态／交付阻断与人工待验）。 */}
        <aside className="tt-project-detail shrink-0 overflow-y-auto border-l border-neutral-800 p-3" data-project-detail>
          <div className="tt-detail-heading">
            <span>了解项目中的这部分</span>
            <h2>{selectedNode?.label ?? "从一个方块开始"}</h2>
          </div>
          {selectedEdge !== null && (
            <section className="tt-relation-detail" data-project-edge-detail={selectedEdge.id}>
              <button className="tt-detail-close" onClick={() => setSelectedEdgeId(null)} aria-label="关闭关系说明">×</button>
              <h3>{modelNodeById.get(selectedEdge.from)?.label ?? selectedEdge.from} → {modelNodeById.get(selectedEdge.to)?.label ?? selectedEdge.to}</h3>
              <p>{EDGE_SEMANTICS[selectedEdge.semantics].label}：{selectedEdge.note}</p>
              <p className="tt-detail-muted">{EDGE_SEMANTICS[selectedEdge.semantics].means}</p>
              {selectedEdge.sources.length === 0 ? <p>这条关系尚无可定位出处。</p> : selectedEdge.sources.map((source, index) => <p className="tt-detail-muted" key={index}>{source.path} · {source.locator}</p>)}
              {annotationOf(selectedEdge.id) !== null && <ObjectProvenanceLines annotation={annotationOf(selectedEdge.id)!} />}
            </section>
          )}
          {/* V09-13（§3.2 同组关系可点开追来源）：点开一条同组关系 ⇒ 这里显示它的出处行 */}
          {openRelation !== null && relationOf(openRelation) !== null && (
            <section className="mb-3 rounded border border-purple-800/60 bg-purple-950/30 p-2" data-project-relation={openRelation}>
              <h3 className="text-xs font-bold text-purple-200">
                {relationKindLabel(relationOf(openRelation)!.kind)}
                <button
                  data-project-relation-close
                  onClick={() => setOpenRelation(null)}
                  className="ml-2 rounded border border-neutral-700 px-1 text-[10px] text-neutral-300 hover:bg-neutral-800"
                >
                  关闭
                </button>
              </h3>
              <ul className="mt-1 space-y-0.5">
                {relationOf(openRelation)!.trace_lines.map((l, i) => (
                  <li key={i} className="text-[11px] leading-relaxed text-neutral-300" data-project-relation-line={i}>
                    {l}
                  </li>
                ))}
              </ul>
              <p className="mt-1 text-[11px] text-neutral-500">
                这条关系两端同属分组 {relationOf(openRelation)!.group_id}：图上不画自环，改在各分组节点上逐条列出（§3.2）
              </p>
            </section>
          )}
          {sections === null ? (
            <p className="text-xs text-neutral-500">
              点选方块，了解它的作用、当前情况与依据。你也可以点选连线，查看双方如何关联。
            </p>
          ) : (
            <div className="space-y-3">
              {sections.map((s) => (
                <section key={`${selectedNode?.id}:${s.key}`} data-detail-section={s.key}>
                  {s.key === "tech" ? (
                    <details data-detail-technical>
                      <summary>{s.title}与原始定位</summary>
                      <ul>{s.lines.map((line, index) => <li key={index}>{line}</li>)}</ul>
                    </details>
                  ) : <>
                  <h3 className="text-xs font-bold text-neutral-200">{s.title}</h3>
                  <ul className="mt-1 space-y-0.5">
                    {(s.summary ?? s.lines).map((l, i) => (
                      <li key={i} className="text-[11px] leading-relaxed text-neutral-400">
                        {l}
                      </li>
                    ))}
                  </ul>
                  {s.summary !== undefined && <details data-detail-original={s.key}><summary>查看原始记录与定位</summary><ul>{s.lines.map((line, index) => <li key={index}>{line}</li>)}</ul></details>}
                  </>}
                  {s.key === "role" && selectedNode !== null && (
                    <div className="tt-related-parts" data-project-related>
                      <h3>与哪些部分有关</h3>
                      {relatedEdges.length === 0 ? <p>当前视图没有跨方块的直接关系；组内关系可在方块上的关系标记中查看。</p> : relatedEdges.map((edge) => {
                        const otherId = edge.from === selectedNode.id ? edge.to : edge.from;
                        return <div className="tt-related-row" key={edge.id}>
                          <button onClick={() => openDetail(otherId)}>{modelNodeById.get(otherId)?.label ?? otherId}</button>
                          <button data-project-related-edge={edge.id} onClick={() => setSelectedEdgeId(edge.id)}>{EDGE_SEMANTICS[edge.semantics].label} ↗</button>
                        </div>;
                      })}
                    </div>
                  )}
                </section>
              ))}
              {/* §3.2／裁定 6：共享模块所属的**全部分组**可查——分组节点详情里，把同属多个分组的成员
                  逐行列出（行内用短形 `cap:XX`，完整分组 id 放 `title` 与数据属性；不放卡片上，避免撑爆固定高度）。
                  **不用 `data-detail-section`**：§3.2 的五段＋来源与证据段的顺序/集合是 v06-06-ui 钉住的
                  既有期望，多归属明细是五段之外的补充行，另挂锚点不挤进那串 key。 */}
              {selectedNode !== null && multiOwnerMembers.length > 0 && (
                <section data-project-multi-owner={selectedNode.id} data-project-multi-owner-count={multiOwnerMembers.length}>
                  <h3 className="text-xs font-bold text-neutral-200">多归属成员（同属多个分组）</h3>
                  <ul className="mt-1 space-y-0.5">
                    {multiOwnerMembers.map((m) => (
                      <li
                        key={m.member}
                        className="text-[11px] leading-relaxed text-neutral-400"
                        data-project-member-groups={m.member}
                        title={`${m.member} 的全部归属分组：${m.groups.join("、")}（§3.2／2026-09-26 GPT-6 裁定 6：共享模块所属的全部分组都可查）`}
                      >
                        {shortGroupId(m.member)} · 同属 {m.groups.length} 组：{m.groups.map(shortGroupId).join("、")}
                      </li>
                    ))}
                  </ul>
                  <p className="mt-1 text-[11px] text-neutral-500">
                    本分组里同属多个分组的成员共 {multiOwnerMembers.length} 个（悬停看完整分组 id）；
                    成员在多个分组里各算一次，不合并计数（§3.2／裁定 6）
                  </p>
                </section>
              )}
              {/* V09-13：来源与证据标注段（逐条列出来源种类、映射、证据状态与阻断；取不到标注如实写"没有标注"） */}
              {selectedNode !== null && (
                <section data-detail-section="provenance" data-detail-provenance={selectedNode.id}>
                  <h3 className="text-xs font-bold text-neutral-200">来源与证据</h3>
                  {annotationOf(selectedNode.id) === null ? (
                    <p className="mt-1 text-[11px] text-neutral-500" data-provenance-missing={selectedNode.id}>
                      当前没有这个对象的来源与证据记录，尚不能确认已验证。
                    </p>
                  ) : (
                    <div className="mt-1">
                      <p>{annotationOf(selectedNode.id)!.evidence_state_label}</p>
                      {annotationOf(selectedNode.id)!.blockers.map((reason, index) => <p key={index}>{reason}</p>)}
                      <details><summary>展开来源、检查证据与原始定位</summary><ObjectProvenanceLines annotation={annotationOf(selectedNode.id)!} /></details>
                    </div>
                  )}
                </section>
              )}
              {selectedNode !== null && (
                <div className="flex flex-wrap gap-2">
                  <button
                    data-detail-goto-tech={selectedNode.technical_id ?? ""}
                    disabled={selectedNode.technical_id === null}
                    title={
                      selectedNode.technical_id === null
                        ? "该规划对象还没有实测代码映射：技术详情里没有对应节点"
                        : `按 module_id 对齐到技术详情：${selectedNode.technical_id}`
                    }
                    onClick={() => {
                      // 跨到技术详情要对齐的是**共用层的 module_id**（技术详情的节点 id），
                      // 不是蓝图节点 id——两者不同源，拿蓝图 id 去查必然"无对应"。
                      if (selectedNode.technical_id === null) {
                        setLocateNote({
                          state: "unmatched",
                          text: `该节点在技术详情无对应（稳定 ID 对齐：${selectedNode.label} 的 id 是 ${selectedNode.id}；它还没有实测代码映射）`,
                        });
                        return;
                      }
                      onLocate?.({ id: selectedNode.technical_id, label: selectedNode.label, to: "tech", from: view });
                    }}
                    className="rounded border border-neutral-700 px-2 py-0.5 text-[11px] text-neutral-300 hover:bg-neutral-800 disabled:opacity-40"
                  >
                    在技术详情定位
                  </button>
                  {(Object.keys(PROJECT_VIEWS) as ProjectViewKind[])
                    .filter((v) => v !== view)
                    .map((v) => (
                      <button
                        key={v}
                        data-detail-goto-view={v}
                        onClick={() => onLocate?.({ id: selectedNode.id, label: selectedNode.label, to: v, from: view })}
                        className="rounded border border-neutral-700 px-2 py-0.5 text-[11px] text-neutral-300 hover:bg-neutral-800"
                      >
                        在{PROJECT_VIEWS[v].label}定位
                      </button>
                    ))}
                </div>
              )}
              {selectedNode !== null && onDiscuss !== undefined && (
                <div className="tt-object-discussion">
                  <button data-project-discuss onClick={() => onDiscuss(selectedNode)}>围绕这部分提问 →</button>
                  <p>带上当前对象和来源，追加到已有草稿。进入聊天后可编辑并发送。</p>
                </div>
              )}
            </div>
          )}
          {locateNote !== null && (
            <p
              data-project-locate-note={locateNote.text}
              data-project-locate-state={locateNote.state}
              className={`mt-3 text-[11px] ${locateNote.state === "matched" ? "text-cyan-200" : "text-amber-300"}`}
            >
              {locateNote.text}
            </p>
          )}
        </aside>
      </div>
    </div>
  );
}

/** 供页签容器与验证脚本共用：主视图的显示名（避免两处各写一套字符串） */
export const PROJECT_VIEW_LABELS: Record<ProjectViewKind, string> = {
  functional: PROJECT_VIEWS.functional.label,
  architecture: PROJECT_VIEWS.architecture.label,
  construction: PROJECT_VIEWS.construction.label,
};

/** 汇总一个视图里各状态的计数（验证脚本与页签徽标共用；口径 = 只数不着色以外的六态） */
export function statusCountsOf(nodes: readonly { status: NodeStatus }[]): Record<string, number> {
  const out: Record<string, number> = { unmapped: 0 };
  for (const n of nodes) {
    const key = n.status.display ?? "unmapped";
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

/** 供验证脚本/页签容器构造"未映射"的汇总（占位导出，口径在 `projectGraph.aggregateStatusOf`） */
export const unmappedStatus = (): NodeStatus => aggregateStatusOf([]);

/** 蓝图节点的短名（详情标题用；对外共享一份，免得两处各写） */
export const blueprintNodeLabel = (n: BlueprintNode): string => n.name;
