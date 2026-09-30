// F3：架构图画布（**A3/A4 交互的唯一实现**，模块方框图与数据流向图共用同一次）。
// 本文件承担 PLAN F3 DoD③：折叠/展开/下钻/布局记忆复用 A3/A4，不重复写一套交互——
//   A4（§3.3 规则 2–5 + §4.1 下钻层 + §4.4 + §4.6 局部重排）：点展开钮/双击 → POST arch/expand
//     懒加载子级 → 子节点原地长出；逐级下钻到文件级；可收起回概览；初次进入默认全折叠；
//     拖动节点 debounce 写回 arch/layout.json，加载时先复原、新节点 dagre 补位；展开只局部重排子树；
//   A5（§4.2 四色 + §4.5 对账标黄）：模块四色边框 + 文件级变动点 + 对账面板（两视图共用）。
// F2 数据层：节点与边一律 `selectGraph(mode, shared)` 取（节点集合各模式完全相同）；A4 下钻子级的
// 依赖边同样按模式走 `selectDataFlowEdges`（共用过滤/着色实现，不另抄一套）。
// F3 的 mode 只决定两件事：① 取哪份边子集与方向（F1 口径表）；② 边怎么上色（edgeStyle.ts）。
//
// F4（本卡收的三件事，都在本文件）：
//   ① **布局记忆按视图分键**（DoD②）：本地坐标三源全部带 mode 维度——`layoutByMode`（layout.json 的
//      `positions[mode]` 桶）、`userPosByMode`（本会话拖动）、`subtreePos[mode]`（A4 子树重排，A4 起就分键）。
//      两视图各存各的坐标：方框图拖 A 不会覆盖数据流向图里 A 的位置（反之亦然），切回来不跳位。
//   ② **fitView 竞态收掉**（DoD④ 的界面前提）：切视图/加载完成后主动补 fit（`onInit` 拿到实例 →
//      下一帧 + 再下一帧各 fit 一次，见 `fitKey` 那个 effect）。React Flow 的 `fitView` 属性只在挂载时
//      生效，切视图只换边集合与坐标、不重挂画布，视口不会自己回到全图。
//   ②′ **P-1（2026-09-26 返工）展开后的视口补正**：`layoutSubtree` 把子级排在父节点右侧、垂直居中于
//      父节点，子级一多就伸出当前视口 ⇒ 展开钮"看得见 DOM、点不着"，用户得先手动缩放。现在展开落地后
//      核一遍新节点（父 + 子级）的 DOM 矩形：全在画布内 ⇒ 视口一点不动（用户摆好的视口不被抢）；
//      有落在画布外 ⇒ 用同一份 `FIT_VIEW_OPTIONS` 重 fit 一次（含新节点的整图）。折叠/拖动/切视图不触发。
//   ③ **切换不触发全量重解析**（DoD③）：视图切换由 `ArchView` 把 `mode` 交给**同一个画布实例**
//      （见 `ArchView.tsx`），折叠状态、子级缓存、布局记忆全留在本组件的 state 里，只重跑选择器。
//      本文件把"解析入口调用次数"打在 DOM 上（`data-arch-parse-calls`：arch/parse + arch/name +
//      arch/expand 三个入口；`data-arch-data-loads`：数据层拉取次数），verify-f4 的 playwright
//      切换前后对照这两个数——不变即证切换没碰解析。
//
// N3（本卡加在共用画布上的事）：与思维导图双向定位（PLAN N3 卡，DESIGN.md §3.2/§3.3）——
//   ① 节点上的「导图」入口（`data-locate-mindmap`）→ 请求切到思维导图并定位这个 module_id；
//   ② 收到 `locate` 请求（从导图来的）→ 该 module_id 的节点**居中 + 高亮**（四色状态照旧，
//      另加一圈定位光环，见 ArchNode 的 focused 分支）；
//   ③ 对齐键只认 module_id：显示名会被 Flash 重命名（`names.json`），名字只进提示文案；
//   ④ 未命中 → `data-arch-locate-note` 明说「该节点在方框图无对应」，不静默失败；
//   ⑤ 定位**不改落点**：不写 `layout.json`、不改折叠记忆——已加载但折叠着的枝只把祖先链
//      就地展开（§3.3 规则 2），子级数据本就在内存里，零新解析请求。
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
  useStore,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { ExpandChild, ExpandResult } from "../../arch/expand";
import { GRAPH_MODES, type FlowRole, type GraphMode } from "../../arch/graph-mode";
import type { ArchLayoutFile, NodePosition } from "../../arch/layoutStore";
import { PROJECT_ARCH_LAYOUT_KEY } from "../../arch/graph-mode";
import type { ReconcileResult } from "../../arch/reconcile";
import {
  selectDataFlowEdges,
  selectGraph,
  type GraphEdge,
  type SelectedEdge,
  type SelectionStats,
  type SharedGraph,
} from "../../arch/shared-graph";
import type { ProjectItem } from "../api";
import {
  deleteArchParseRun,
  getArchItems,
  getArchLayout,
  getArchParseRun,
  getArchReconcile,
  getArchRender,
  getLive,
  postArchExpand,
  postArchName,
  postArchParse,
  postArchReconcile,
  putArchLayout,
  type ArchParseAck,
} from "../api";
// V09-22：未聚合并集对象（隐藏对象抽屉的行与详情读它；type-only 复用，服务端实现不进前端包）
import type { SharedGraphEdge, SharedModuleNode } from "../../arch/items";
// T19：run 现场类型 type-only 复用（编译期擦除，服务端实现不进前端包——同 ArchParseStats 的 Q133 口径）
import type { ParseRun } from "../../arch/parse";
import { FILE_NODE_HEIGHT, FILE_NODE_WIDTH, NODE_HEIGHT, NODE_WIDTH, gridLayout, layoutSubtree, layoutWithDagre } from "./layout";
import { BIDIRECTIONAL_DASH, edgeVisualOf, usedStrokeWidths } from "./edgeStyle";
import { matchedNote, unmatchedNote, type LocateRequest } from "./locate";
import { GRAPH_PAGE_POLL_MS, hasAdvancedEvents } from "./lastSeq";
import { ReconcileCats } from "./ReconcileCats";
// V09-13：来源与证据标注的判据（`provenance.ts`）与共享渲染件（`ProvenancePanel.tsx`）——
// 与三个主视图、思维导图、MCP 读口同一份，不各写一套。
import {
  evidenceBadgeClassOf,
  evidenceShortOf,
  sourceKindLabelOf,
  UNMAPPED_BADGE_CLASS,
  type EvidenceState,
  type ProvenanceModel,
} from "./provenance";
import { GraphAttentionBar } from "./ProvenancePanel";
import { planCodeNodeIdOf } from "./projectGraph";
import {
  ONLY_IN_CODE_CATEGORY_BADGE,
  ONLY_IN_CODE_CATEGORY_HINT,
  ONLY_IN_CODE_CATEGORY_LABEL,
  ONLY_IN_CODE_CATEGORY_ORDER,
  categoryOfOnlyInCode,
  countMatchedByVia,
  groupOnlyInCode,
  type OnlyInCodeDisplayCategory,
} from "./reconcileClass";
import { FOCUS_RING_COLOR, NO_STATUS_RECORD_KEY, displayStatusStyle, statusStyle } from "./statusColor";

// ── 自定义方块节点：人话名 + path + 文件数 + blurb + kind 淡色徽标 + 展开/折叠钮 ──
// A5（§4.2 状态色 + §4.5 对账标黄）：
//   - 模块级四色：progress.json modules[] 状态 → 边框四色 + 中文状态词（色盲可辨：颜色+文字双通道），
//     progress.json 无记录 → 灰（todo 口径「未开始」）；
//   - 文件级只标「有变动」一个点：近窗口 changes.jsonl 有记录的文件节点挂琥珀小点；
//   - 对账差异：only_in_code 的模块节点黄色标记「对账差」+ 底部对账面板列两组差异清单，
//     文案明示「差异是信号，不是错误」（§4.5）。
const KIND_STYLE: Record<string, { badge: string; label: string }> = {
  code: { badge: "bg-sky-900/60 text-sky-300", label: "code" },
  data: { badge: "bg-amber-900/60 text-amber-300", label: "data" },
  docs: { badge: "bg-emerald-900/60 text-emerald-300", label: "docs" },
  mixed: { badge: "bg-violet-900/60 text-violet-300", label: "mixed" },
};

// A5 模块四色（§4.2）：色值+中文词收在 `./statusColor.ts`（N3 起与思维导图**同一份**，
// 定位高亮的颜色也读它——两边不各写一套四色）

/** 统一节点数据模型：顶层模块（A3 渲染 JSON）与 A4 下钻子级（dir/file）共用一个节点组件 */
export type ArchNodeData = {
  /** 显示名（模块 = 人话名；文件/子目录 = 文件名即名字） */
  label: string;
  /** 相对项目根路径（expand 入参） */
  path: string;
  file_count: number;
  blurb?: string;
  kindBadge?: { badge: string; label: string };
  aggregate?: boolean;
  /** 文件节点（叶子）：小方块样式，不可下钻 */
  isFile?: boolean;
  /** 可下钻（模块 / 子目录）；文件与聚合节点不可 */
  expandable?: boolean;
  /** 当前展开位（§3.3 可折叠树状态） */
  expanded?: boolean;
  /** 展开请求进行中 */
  busy?: boolean;
  /** A5 模块四色状态（§4.2）：progress.json modules[].status；无记录缺省 = todo 灰 */
  status?: string;
  /** A5 对账差异标记（§4.5）：该模块在代码侧有、设计书没有 → 标记（信号不是错误） */
  diff?: boolean;
  /** V09-08 ③：差异的**显示分类**（真差异 / 范围外 / 结构性目录 / 未分类）——只有真差异用黄 */
  diffCategory?: OnlyInCodeDisplayCategory;
  /** V06-06：**六态显示状态**（DESIGN.md §4.2 表；由状态投影派生，界面不提供涂色入口）。
   *  给值时节点按六态上色并显示短标签，同时**不再**写 v1 四色的 `data-arch-status`
   *  （两套状态口径不混在一个属性上）；不给值时行为与 A5 起逐字相同。 */
  displayStatus?: string | null;
  /** V08-03（附录 D）：短标签覆盖（模块「验证通过」点明"已存在"；不给时用六态短标） */
  status_short?: string;
  /** V06-06：聚合节点上的说明文字（规划层的「还有 N 个分组」不是"超单枝上限未展开"，
   *  给值时用这份文案，避免把两种聚合说成同一件事） */
  aggregateNote?: string;
  /** 聊天补全层节点（2026-09-19 试用增强三期）：chat 徽标 + 不可下钻（没有可解析子树） */
  origin?: "chat";
  /** V09-13：**来源种类 + 证据状态**（来源与证据标注，判据在 `provenance.ts`）。
   *  给值时节点上多两个徽标（来源种类 / 证据状态）并挂 `data-arch-source-kind`、
   *  `data-arch-evidence-state`；不给值（旧口径）一个字段都不加。 */
  provenance?: { source_kind: string; evidence_state: string; evidence_label: string; user_pending: boolean; capability_class?: "functional" | "governance" | "unknown" | null };
  /** A5 文件级变动点（§4.2）：近窗口 changes.jsonl 有记录 */
  changed?: boolean;
  /** F3 数据流向图专用：该节点流向角色（flowRoleOf）。只做属性标记，**不改节点色**
   *  （`NODE_COLOR_RULE`：节点色始终走 §4.2 四色，两视图一致） */
  flowRole?: FlowRole;
  /** 点击展开/折叠钮回调（由 ArchCanvas 注入） */
  onToggle?: (id: string) => void;
  /** N3 定位高亮：本节点是本次定位的目标（四色边框照旧 + 外圈"定位"光晕） */
  focused?: boolean;
  /** N3：点节点上的「在思维导图定位」入口 → 请求反向定位（实现在 `ArchView.tsx`） */
  onLocateNode?: (id: string, label: string, path: string) => void;
};
type ArchFlowNode = Node<ArchNodeData, "archNode">;

/** N3：节点上的「在思维导图定位」入口（对齐键 = 节点 id = module_id，**不是显示名**）。
 *  反方向（思维导图 → 方框图/数据流向图）的入口长在导图节点右侧，见 `MindMapView.tsx`。
 *  `nodrag`：别让 React Flow 把这一按当成拖动节点。 */
function LocateMindMapButton({
  id,
  label,
  path,
  onLocateNode,
}: {
  id: string;
  label: string;
  path: string;
  onLocateNode?: (id: string, label: string, path: string) => void;
}) {
  return (
    <button
      type="button"
      data-locate-mindmap={id}
      title="在思维导图定位这个节点（按 module_id 对齐，与显示名无关）"
      className="nodrag shrink-0 rounded border border-neutral-600 px-1 py-0.5 text-[9px] text-neutral-400 hover:border-cyan-400 hover:text-cyan-300"
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onLocateNode?.(id, label, path);
      }}
    >
      导图
    </button>
  );
}

function ArchNode({ id, data }: NodeProps<ArchFlowNode>) {
  const toggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    data.onToggle?.(id);
  };
  // V09-20（§4.6，2026-09-26 用户澄清）：展开/折叠钮的**屏幕命中区**不随缩放缩到亚像素。
  // 实测反例：整图重 fit 后 zoom 落到 0.133，`h-5 w-5`（20 图坐标 px）的钮在屏幕上只剩 2.12 px，
  // 自动化的 `locator.click` 仍能点中、人的鼠标点不着。这里用**反缩放**把屏幕尺寸钉在
  // 基准尺寸（20px）之上：屏幕尺寸 = 图坐标尺寸 × zoom × scale，取 scale = clamp(1/zoom, 1, 上限)
  // ⇒ zoom ≤ 1 时恒为 20px；zoom > 1 时随图自然放大（不反缩、不别扭）。只改视觉与命中区，
  // 不改图坐标尺寸、不动布局（`transform` 不参与 flex 排版），A3/A4 的节点尺寸断言不受影响。
  const zoom = useStore((s) => s.transform[2]);
  const toggleScale = zoom > 0 ? Math.min(MAX_TOGGLE_COUNTER_SCALE, Math.max(1, 1 / zoom)) : 1;
  if (data.aggregate) {
    // 「还有 N 个」聚合节点（A2 内置/顶层 + N2 的 A4 巨枝截断）：虚线特殊样式，不可下钻。
    // 顶层的聚合节点带被合并模块的文件总数；A4 的聚合节点不带（被截断的枝不遍历，算不出来也不该算）
    // V06-06：规划层的概览聚合节点（「还有 N 个分组」）自带说明，用 aggregateNote 原样显示
    return (
      <div
        className="rounded-lg border-2 border-dashed border-neutral-600 bg-neutral-900/70 px-4 py-3"
        style={{
          width: NODE_WIDTH,
          height: NODE_HEIGHT,
          ...(data.focused ? { outline: `2px solid ${FOCUS_RING_COLOR}`, outlineOffset: 2 } : {}),
        }}
        data-arch-aggregate
        data-arch-node={id}
        {...(data.displayStatus !== undefined
          ? { "data-display-status": data.displayStatus ?? "unmapped" }
          : {})}
        {...(data.focused ? { "data-arch-focused": "1", "data-arch-focus-color": statusStyle().hex } : {})}
      >
        <p className="text-sm font-semibold text-neutral-300">{data.label}</p>
        <p className="mt-1 text-xs text-neutral-500">
          {data.aggregateNote !== undefined
            ? data.aggregateNote
            : data.file_count > 0
              ? `聚合展示 · ${data.file_count} 个文件`
              : "超单枝上限未展开（未遍历、未解析）"}
        </p>
        {data.aggregateNote === undefined && (
          <p className="mt-1 line-clamp-2 text-xs text-neutral-500">{data.blurb}</p>
        )}
        {/* 复核项 H-4：聚合节点**没有**来源/证据徽标是**如实**的——它不是蓝图/代码里的对象，
            是图上把未显示的对象并成的一块，没有可对账的出处。这里显式写出来，免得被读成
            「这屏的节点标注又缺了」（§3.2／§3.3；对象节点的徽标见下面的 provenance 分支）。 */}
        <p className="mt-0.5 text-[9px] text-neutral-500" data-arch-aggregate-note={id}>
          聚合节点：不是可对账对象，不进来源/证据标注（§3.3）
        </p>
        <Handle type="target" position={Position.Left} className="!bg-neutral-600" />
        <Handle type="source" position={Position.Right} className="!bg-neutral-600" />
      </div>
    );
  }
  if (data.isFile) {
    // 文件节点（A4 下钻层终点）：小方块 + file 徽标，文件名即名字（§4.1：LLM 不碰）；
    // A5：近窗口 changes.jsonl 有记录 → 琥珀小点「有变动」（§4.2 文件级只标一个点）
    return (
      <div
        className="rounded border border-neutral-700 bg-neutral-900/80 px-3 py-2"
        style={{
          width: FILE_NODE_WIDTH,
          height: FILE_NODE_HEIGHT,
          ...(data.focused ? { outline: `2px solid ${FOCUS_RING_COLOR}`, outlineOffset: 2 } : {}),
        }}
        title={data.changed ? `${data.path}（近 24h 有变动）` : data.path}
        data-file-node={data.path}
        data-arch-node={id}
        {...(data.focused ? { "data-arch-focused": "1", "data-arch-focus-color": statusStyle().hex } : {})}
      >
        <div className="flex items-center gap-1.5">
          <span className="shrink-0 rounded bg-neutral-800 px-1 py-0.5 text-[9px] text-neutral-400">
            file
          </span>
          {data.changed && (
            <span
              className="h-2 w-2 shrink-0 rounded-full bg-amber-400"
              data-changed-dot={data.path}
              title="近 24h 有变动"
            />
          )}
          <p className="min-w-0 flex-1 truncate text-xs text-neutral-200">{data.label}</p>
        </div>
        {/* 第二行放路径 + 定位入口：文件节点只有 180px 宽，入口挤在第一行会把文件名截没 */}
        <p className="mt-1 flex items-center gap-1.5 text-[10px] text-neutral-600">
          <span className="min-w-0 flex-1 truncate">{data.path}</span>
          <LocateMindMapButton id={id} label={data.label} path={data.path} onLocateNode={data.onLocateNode} />
        </p>
        <Handle type="target" position={Position.Left} className="!bg-neutral-600" />
        <Handle type="source" position={Position.Right} className="!bg-neutral-600" />
      </div>
    );
  }
  const badge = data.kindBadge ?? KIND_STYLE.mixed;
  // A5 模块四色：边框按状态上色 + 中文状态词徽标；progress.json 无记录 → 灰（todo 口径）。
  // 对账差异（§4.5）覆盖边框颜色 + 徽标——差异是信号不是错误。
  // V09-08 ③：**只有「真差异」用黄**；口径边界（范围外 / 结构性目录 / 未分类）用中性底色 +
  // 分类自己的词（原始事实仍在 `data-arch-diff`，分类另挂 `data-arch-diff-category`）。
  // V06-06：给了 `displayStatus`（六态，来自状态投影）时按六态上色与显示短标签；
  // 两套状态口径不混在同一个属性上：走六态就不写 `data-arch-status`。
  // V06-06：给了 `displayStatus` 的节点按六态上色与显示短标签；此时不写 v1 四色的
  // `data-arch-status`（旧读口的属性只在旧口径下出现，免得两套口径混在一个属性上）
  const six = data.displayStatus === undefined ? null : displayStatusStyle(data.displayStatus);
  const st = statusStyle(data.status);
  const badgeText =
    six === null
      ? st.label
      : data.displayStatus === NO_STATUS_RECORD_KEY
        ? "无状态记录"
        : // 2026-09-26 复核修复：调用方把「无状态」编码成字符串 "unmapped"（ProjectGraphView 的
          // statusOverride 表），原来这里只认 null ⇒ 落到六态短标、被兜底色错标成「已规划」，
          // 与详情「未映射/不着完成色」自相矛盾（scripts/lib/displayStatus.ts 的期望本就是「未映射」）
          data.displayStatus === null || data.displayStatus === "unmapped"
          ? "未映射"
          : // V08-03（附录 D）：模块「验证通过」用自己的短标（点明"已存在"），其余沿用六态短标
            (data.status_short ?? six.short);
  const badgeClass = six === null ? st.text : six.text;
  const borderClass = six === null ? st.border : six.border;
  const statusHex = six === null ? st.hex : six.hex;
  const diffCat = data.diff ? (data.diffCategory ?? "unclassified") : null;
  return (
    <div
      className={`rounded-lg border-2 bg-neutral-900 px-4 py-3 shadow ${
        diffCat === "actionable_mismatch" ? "border-yellow-400" : diffCat === null ? borderClass : "border-neutral-500"
      }`}
      style={{
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        ...(data.focused
          ? {
              outline: `2px solid ${FOCUS_RING_COLOR}`,
              outlineOffset: 2,
              boxShadow: `0 0 16px ${FOCUS_RING_COLOR}99`,
            }
          : {}),
      }}
      title={data.blurb ?? data.path}
      data-arch-node={id}
      {...(six === null ? { "data-arch-status": data.status ?? "todo" } : {})}
      {...(six !== null ? { "data-display-status": data.displayStatus ?? "unmapped" } : {})}
      {...(data.diff ? { "data-arch-diff": "only_in_code" } : {})}
      {...(diffCat !== null ? { "data-arch-diff-category": diffCat } : {})}
      {...(data.flowRole ? { "data-flow-role": data.flowRole } : {})}
      {...(data.provenance ? { "data-arch-source-kind": data.provenance.source_kind } : {})}
      {...(data.provenance ? { "data-arch-evidence-state": data.provenance.evidence_state } : {})}
      {...(data.provenance ? { "data-arch-user-pending": data.provenance.user_pending ? "1" : "0" } : {})}
      {...(data.focused ? { "data-arch-focused": "1", "data-arch-focus-color": statusHex } : {})}
    >
      <div className="flex items-center gap-2">
        {data.expandable && (
          <button
            onClick={toggle}
            data-expand-toggle={id}
            data-expand-toggle-screen-scale={toggleScale.toFixed(3)}
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded border border-neutral-600 text-[11px] leading-none text-neutral-300 hover:bg-neutral-800"
            // 反缩放（见 ArchNode 顶部注释）：transform-origin 靠左，视觉上向标签一侧长出去，
            // 保证屏幕命中区恒 ≥ 基准尺寸；命中判定用变换后的盒子（浏览器 elementFromPoint 一致）。
            style={{ transform: `scale(${toggleScale})`, transformOrigin: "left center" }}
            title={data.expanded ? "折叠回概览" : "原地展开子级"}
          >
            {data.busy ? "…" : data.expanded ? "−" : "+"}
          </button>
        )}
        <p className="min-w-0 flex-1 truncate text-sm font-semibold text-neutral-100">{data.label}</p>
        <span
          className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] ${badgeClass}`}
          data-status-label={badgeText}
        >
          {six === null ? badgeText : `${six.icon} ${badgeText}`}
        </span>
        {diffCat !== null && (
          <span
            className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${ONLY_IN_CODE_CATEGORY_BADGE[diffCat]}`}
            data-arch-diff-badge={diffCat}
            title={`代码有、设计书没有（§4.5：信号不是错误）· ${ONLY_IN_CODE_CATEGORY_LABEL[diffCat]}：${ONLY_IN_CODE_CATEGORY_HINT[diffCat]}`}
          >
            {diffCat === "actionable_mismatch" ? "对账差" : ONLY_IN_CODE_CATEGORY_LABEL[diffCat]}
          </span>
        )}
        {data.origin === "chat" && (
          <span
            className="shrink-0 rounded bg-sky-900/70 px-1.5 py-0.5 text-[10px] text-sky-300"
            title="聊天补全层节点（2026-09-19 试用增强）：静态解析覆盖不到的概念模块由聊天写入；重新解析不会冲掉，要清空让聊天 replace 空集"
            data-arch-chat-node={id}
          >
            chat
          </span>
        )}
        <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${badge.badge}`}>
          {badge.label}
        </span>
      </div>
      {/* 第二行放路径/文件数 + 定位入口：第一行是状态徽标行（N3 的入口放那儿会把模块名挤没） */}
      <p className="mt-0.5 flex items-center gap-2 text-[11px] text-neutral-500">
        <span className="min-w-0 flex-1 truncate">
          {data.path} · {data.file_count} 个文件
        </span>
        <LocateMindMapButton id={id} label={data.label} path={data.path} onLocateNode={data.onLocateNode} />
      </p>
      <p className="mt-1 line-clamp-2 text-xs text-neutral-400">{data.blurb}</p>
      {/* V09-13：来源种类 + 证据状态（与三个主视图同一份判据与文案；不给值时不显示） */}
      {data.provenance !== undefined && (
        <p className="mt-0.5 flex items-center gap-1 text-[9px]" data-arch-provenance={id}>
          {data.provenance.capability_class === "governance" && (
            <span
              className="rounded border border-neutral-600 bg-neutral-800 px-1 text-neutral-300"
              data-arch-class-badge={id}
              title="设计/治理章节（§3.2 能力分类声明）：非产品功能能力——不以「已验证能力」显示、不计入产品能力计数；其成员与出处保持可追溯"
            >
              设计/治理章节
            </span>
          )}
          {data.provenance.capability_class === "unknown" && (
            <span
              className="rounded border border-amber-600 bg-amber-950/60 px-1 text-amber-300"
              data-arch-class-badge={id}
              title="能力分类未定（§3.2／R-1）：能力分类声明表损坏——不按功能能力计数，不得据此判绿或得出「可请求验收」结论"
            >
              分类未定
            </span>
          )}
          <span className="rounded border border-neutral-700 px-1 text-neutral-400" data-arch-source-badge={id}>
            {data.provenance.source_kind}
          </span>
          <span
            className={`rounded border px-1 ${
              data.provenance.evidence_state === "missing" && data.provenance.source_kind === "未映射"
                ? UNMAPPED_BADGE_CLASS
                : evidenceBadgeClassOf(data.provenance.evidence_state as EvidenceState)
            }`}
            data-arch-evidence-badge={id}
            title="来源与证据标注（§3.2／§4.2）：未映射/未验证/证据失效不给绿，也不省略标注"
          >
            {data.provenance.evidence_label}
          </span>
        </p>
      )}
      <Handle type="target" position={Position.Left} className="!bg-neutral-500" />
      <Handle type="source" position={Position.Right} className="!bg-neutral-500" />
    </div>
  );
}

const nodeTypes = { archNode: ArchNode };

/** 画布给外部的口径快照（DataFlowView 的图例与 verify-f3 的断言读同一份，不各自再算） */
export interface CanvasInfo {
  mode: GraphMode;
  /** 本模式口径表里的显示名（GRAPH_MODES[mode].label） */
  label: string;
  /** 可见节点/边数（含 A4 下钻子级） */
  nodes: number;
  edges: number;
  /** 本模式顶层选择统计：E_ALL → E_view 各步计数（DATA_FLOW_EDGE_RULE.steps 的证据） */
  stats: SelectionStats;
  /** DATA_FLOW：顶层节点流向角色分布（flowRoleOf 四象限） */
  roles: Record<FlowRole, number>;
  /** DATA_FLOW：渲染出来的边按色角色计数（源头/中继/未着色） */
  colors: { flow_source: number; flow_relay: number; uncolored: number };
  /** 互惠对归并出的双向边条数（渲染层） */
  bidirectional: number;
  /** 本次用到的粗细档（§4.3 第 3 招「粗细表示权重」的证据：档数 > 1 才算真表达权重） */
  strokeWidths: number[];
  maxWeight: number;
}

export interface ArchCanvasProps {
  project: ProjectItem;
  /** 视图模式（§3.2）：决定取哪份边子集与边怎么上色；节点组件与全部交互两模式共用 */
  mode: GraphMode;
  /** 画布上方追加一行内容（F3 数据流向图放流向图例与口径说明），吃本次渲染的口径快照 */
  header?: (info: CanvasInfo) => ReactNode;
  /** N3：要定位到本视图的请求（`ArchView` 转交；null = 没有待处理请求）。
   *  对齐键是请求里的 `id`（= 共用层 module_id），**与显示名无关**（PLAN N3 跑偏点）。 */
  locate?: LocateRequest | null;
  /** N3：点节点上的「在思维导图定位」入口 → 交给 `ArchView` 发起反向定位 */
  onLocate?: (node: { id: string; label: string; path: string }) => void;
  /**
   * V06-06：**直接喂一份共用数据层**（V06-05 的规划层与旧图合成结果），不再自己拉 `arch/render`。
   * 用途 = 三个主视图里的「系统架构」（§3.2：审定的模块职责 + 叠加实测代码映射）。
   * 不给（undefined/null）= A3 起的老路径逐字不变：自己拉 `arch/render` + 未解析时走"先解析"引导态。
   */
  graphOverride?: SharedGraph | null;
  /** V06-06：节点 id → 六态显示状态（来自 V06-09 的状态投影）。给值时按六态上色（§4.2），
   *  并**不再**写 v1 四色的 `data-arch-status`；不给值 = 老口径（progress.json 四色）逐字不变。 */
  statusOverride?: Record<string, string>;
  /** V06-06：单击节点（三个主视图用它打开 §3.2 的五段详情）；不给值 = A3 起无单击行为 */
  onNodeClick?: (node: { id: string; label: string; path: string }) => void;
  /**
   * V09-13：**来源与证据标注模型**（服务端同一份派生；判据在 `provenance.ts`）。
   * 给了就在节点上标来源种类与证据状态，并在画布上方显示「来源与证据」信息栏；
   * 不给（undefined/null）= A3 起的行为逐字不变（旧调用方零改动）。
   */
  provenance?: ProvenanceModel | null;
  /**
   * V09-13（复核项 H-4）／V09-20 回归修复：本画布**自己**那份「来源与证据」信息栏要不要显示。
   * 缺省 true（技术详情两张图的既有行为不变）；主视图「系统架构」由 `ProjectGraphView`
   * 复用本画布时传 false——信息栏已由页签容器显示一份，同一屏两块同样内容属重复上屏。
   * 关的只是**信息栏**，节点上的来源/证据徽标不受它影响。
   */
  showDeliveryReadout?: boolean;
}

/** 视图声明（§3.2）：一个视图 = 自己的模式键 + 画布上方那行专属内容。
 *  `ArchView` 按当前模式取一份交给**同一个**共用画布（F4：切视图只换 mode，不重挂画布）。 */
export interface ArchViewDecl {
  mode: GraphMode;
  header?: (info: CanvasInfo) => ReactNode;
}

const EMPTY_POS: NodePosition = { x: 0, y: 0 };
/** Q120：DATA_FLOW 展开子树的落位锚点——本视图全部已知节点（生效坐标 pos 这份）的最右边界。
 *  子树整体摆到模块簇外侧空地，不再压在任何顶层模块上（压住的节点会被子节点 DOM 截走拖动抓取）。 */
function rightEdgeOf(positions: Record<string, NodePosition>): number {
  const xs = Object.values(positions).map((p) => p.x + NODE_WIDTH);
  return xs.length > 0 ? Math.max(...xs) : 0;
}
/** fitView 口径：留 20% 边距、不放大超过 1（与 React Flow 的 fitView 属性同一份参数） */
const FIT_VIEW_OPTIONS = { padding: 0.2, maxZoom: 1 } as const;
/** Q120：fitView 的最小缩放。展开巨枝（单枝 38+ 子级垂直堆叠，全图高 4000+px）后，
 *  0.2 的下限让"全图收进视口"在数学上不成立（渲染高度 > 画布高，fitView 被钳住、节点漏出视口）。
 *  放宽到 0.05：总览态能真收全图；节点太小看不清时用户自己放大，不回弹。 */
const FIT_MIN_ZOOM = 0.05;
/** V09-20（§4.6）：展开/折叠钮的**反缩放上限**。钮的图坐标尺寸是 16px（`h-4 w-4`），
 *  屏幕尺寸 = 16 × zoom × scale；取 scale = clamp(1/zoom, 1, 本值) ⇒ zoom ≥ 0.1 时屏幕恒 16px，
 *  更小的 zoom 下最多放大到 1.6 屏幕 px（比 2.12px 的旧反例还小一档的量级不再出现在常用区间）。 */
const MAX_TOGGLE_COUNTER_SCALE = 10;
/** V09-20（§4.6）：展开后补视口的**可读下限**。旧实现用整图 `fitView` ⇒ 展开 scripts（76 节点）时
 *  缩放掉到 0.133，节点与控件在屏幕上只剩 2 px 级（点不着）。新口径：**只平移、不缩树**——
 *  当前缩放不低于本下限时视口缩放一点不动（用户的缩放与布局记忆不被抢）；低于下限才放大到下限。
 *  下限 0.5 取"初始 fitView 实测常落区间（0.6 左右）"的下一档，避免把用户已摆好的视角反向缩小。 */
const REVEAL_MIN_ZOOM = 0.5;
/** V09-21 R4（2026-09-27，非作者终审 F-B）：展开补视口的**硬下限**。小子树仍走 REVEAL_MIN_ZOOM
 *  口径（缩放到不了 0.5 以下时一点不动）；但 40 个文件的大子树在 0.5 下**数学上收不进视口**
 *  （竖列约 4000px vs 画布 300–500px），钳在 0.5 就等于把新节点的展开钮甩到视口外（实测
 *  scripts-outbox 中心 y=-312）。此时允许缩到本下限把整棵新子树真框进来——展开钮有反缩放
 *  兜底（zoom ≥ 0.1 时屏幕恒 ≥20px），「看得全」不再牺牲「点得着」。 */
const REVEAL_HARD_MIN_ZOOM = 0.1;
/** V09-21 R3（2026-09-27，非作者终审 F-A）：系统架构主视图（override 数据层）初始/补 fit 的
 *  **可读下限**。主视图是给人看图用的（§3.2/§3.11）：fitView 若把 240×116 的对象节点缩到
 *  60×30 屏幕 px 以下，字号不可辨、节点中心被展开钮盖住（实测 zoom 0.128 时点节点中心命中的是
 *  展开钮）。下限 0.26 ⇒ 节点至少 62×30 px；收不下整图时**允许初始平移**（任务书候选口径），
 *  不反向缩小用户视角。只作用于 override（主视图）路径；技术详情三图（78+ 节点）维持 0.05 下限。 */
const OVERRIDE_FIT_MIN_ZOOM = 0.26;

/** V09-22（契约 2）：子级稳定分页续取的**安全上限**——到顶仍未取完就如实停止并 `console.warn` 留痕
 *  （不静默丢页、不冒充全量）。50 页 × 默认页 200 = 1 万级，足够覆盖真实巨枝，异常时不至于挂住请求线程。 */
const MAX_EXPAND_PAGES = 50;

/**
 * V09-22（契约 2）：全量模式下把一条枝的子级**按稳定分页取全**（上限外的子级逐项可取回）。
 *
 * 首拉带 `childrenOffset: 0` → 服务端进分页模式（不再为「还有 N 个」聚合节点保留名额，返回体带
 * `children_total/offset/returned/has_more`）；`children_has_more` 为真就按 `offset + returned` 续取，
 * 直到取完。合并后：`children` 为全量真实子级；`truncated.children` 取**末页**值（取完即 0，
 * 到安全上限未取完则如实保留余量，画布上照旧显示聚合口径）。
 * 不带分页字段的旧返回体不会进这里（调用方只在全量模式调本函数）。
 */
async function postArchExpandAll(projectId: string, modulePath: string): Promise<ExpandResult> {
  let last = await postArchExpand(projectId, modulePath, { full: true, childrenOffset: 0 });
  let merged = [...last.children];
  let pages = 1;
  while (last.children_has_more === true) {
    if (pages >= MAX_EXPAND_PAGES) {
      console.warn(
        `[arch/expand] 子级分页达到安全上限 ${MAX_EXPAND_PAGES} 页仍未取完（path=${modulePath}，` +
          `已取 ${merged.length}/${last.children_total ?? "?"}）——如实停止，不冒充全量`,
      );
      break;
    }
    const returned = last.children_returned ?? last.children.length;
    if (returned <= 0) break; // 空页：offset 不前进，避免死循环（页数由安全上限兜底）
    last = await postArchExpand(projectId, modulePath, {
      full: true,
      childrenOffset: (last.children_offset ?? 0) + returned,
    });
    merged = merged.concat(last.children);
    pages++;
  }
  return { ...last, children: merged };
}

/** V09-22：隐藏对象抽屉的两个 kind tab（值即 `/arch/items` 的 kind 参数，命名随本页既有页签风格） */
const HIDDEN_KINDS: { value: "nodes" | "edges"; label: string }[] = [
  { value: "nodes", label: "节点" },
  { value: "edges", label: "边" },
];

export function ArchCanvas({
  project,
  mode,
  header,
  locate,
  onLocate,
  graphOverride,
  statusOverride,
  onNodeClick,
  provenance,
  showDeliveryReadout = true,
}: ArchCanvasProps) {
  /** V06-06：被喂了共用数据层就走"外部数据"路径（不拉 arch/render、不显示 A5 对账面板） */
  const usingOverride = graphOverride !== null && graphOverride !== undefined;
  /** V09-21 R3：主视图（override）的补 fit 带可读下限（OVERRIDE_FIT_MIN_ZOOM），技术详情维持原口径 */
  const fitOptions = useMemo(
    () => (usingOverride ? { ...FIT_VIEW_OPTIONS, minZoom: OVERRIDE_FIT_MIN_ZOOM } : FIT_VIEW_OPTIONS),
    [usingOverride],
  );
  /** V09-21 R3：布局记忆/拖动/子树坐标的分桶键。override（系统架构主视图）用独立桶 PROJECT_ARCH
   *  ——它的节点集（29 个规划对象）与技术详情方框图（78 个静态模块）不同，共用 MODULE_BOX 桶会把
   *  那张图的坐标套进来（F4「跨视图共用坐标必然跳位」的同类；非作者终审 F-A 连带实测：主视图节点
   *  被甩出画布、真实点击被上方区块拦截）。桶键已登记进服务端 isLayoutMode 放行清单（§4.4 布局记忆
   *  照常落盘/复原，只是各存各的）。 */
  const layoutKey = usingOverride ? PROJECT_ARCH_LAYOUT_KEY : mode;
  const overrideRef = useRef<SharedGraph | null>(graphOverride ?? null);
  overrideRef.current = graphOverride ?? null;
  const statusOverrideRef = useRef<Record<string, string>>(statusOverride ?? {});
  statusOverrideRef.current = statusOverride ?? {};
  /** V09-13：来源与证据标注（判据在 `provenance.ts`；本组件只按它上屏，不另判一套） */
  const provenanceRef = useRef<ProvenanceModel | null>(provenance ?? null);
  provenanceRef.current = provenance ?? null;
  const onNodeClickRef = useRef<ArchCanvasProps["onNodeClick"]>(onNodeClick);
  onNodeClickRef.current = onNodeClick;
  // F2 共用数据层产物（未按视图过滤的 E_ALL）；本视图的边 = selectGraph(mode, graph)
  const [graph, setGraph] = useState<SharedGraph | null>(null);
  const [exists, setExists] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // ── V09-22：全量模式（「显示全部」）与画布内搜索 ──────────────────────────────
  /** 「显示全部」= 同一 builder 换全量上限拉 arch/render（概览默认一个字节不动）；仅 !usingOverride 可用 */
  const [showAll, setShowAll] = useState(false);
  /** showAll 的 ref 镜像：load 只依赖 [project.id]，靠它读到当前模式，不把 load 重建 */
  const showAllRef = useRef(false);
  showAllRef.current = showAll;
  /** 画布内搜索词（大小写不敏感子串，匹配 label/id/path；范围为当前图 + 已缓存子级） */
  const [search, setSearch] = useState("");
  /** 当前命中序号（Enter=下一个、Shift+Enter=上一个；换词归零） */
  const [hitIdx, setHitIdx] = useState(0);
  // ── V09-22：隐藏对象抽屉（全量模式下把「被聚合/扇出过滤丢弃」的对象逐项取回）──────────────
  // 未聚合并集读口（`/arch/items`）在客户端的分页消费：可搜索（防抖 300ms）、可翻页、可点开详情。
  /** 抽屉开合（入口按钮切换；换项目/切模式由重置 effect 关闭并清空） */
  const [hiddenOpen, setHiddenOpen] = useState(false);
  /** 抽屉当前 kind（节点/边两个 tab） */
  const [hiddenKind, setHiddenKind] = useState<"nodes" | "edges">("nodes");
  /** 搜索框里的实时输入（防抖 300ms 后才作为查询词拉取；空串＝清过滤、回第一页全集） */
  const [hiddenQueryInput, setHiddenQueryInput] = useState("");
  /** 生效的查询词（防抖产物） */
  const [hiddenQuery, setHiddenQuery] = useState("");
  /** 当前已取回的行（节点与边同槽位，按 hiddenKind 解释） */
  const [hiddenRows, setHiddenRows] = useState<(SharedModuleNode | SharedGraphEdge)[]>([]);
  /** 分页读数（total=过滤后总数；has_more=false 后「加载更多」隐藏） */
  const [hiddenPage, setHiddenPage] = useState<{ total: number; offset: number; returned: number; has_more: boolean }>({
    total: 0,
    offset: 0,
    returned: 0,
    has_more: false,
  });
  const [hiddenBusy, setHiddenBusy] = useState(false);
  const [hiddenError, setHiddenError] = useState<string | null>(null);
  /** 抽屉取数代际：换项目/换 kind/换查询词/翻页交织时，在途旧应答凭它作废（同 loadGenRef 的思路） */
  const hiddenGenRef = useRef(0);
  /** 搜索防抖定时器 */
  const hiddenDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 抽屉行点击打开的对象详情（对象与 render 节点/边同构；面板根挂 `data-arch-detail`） */
  const [detailObject, setDetailObject] = useState<
    { kind: "node"; node: SharedModuleNode } | { kind: "edge"; edge: SharedGraphEdge } | null
  >(null);
  // §3.3 可折叠树状态：初次进入默认全部折叠；展开位按节点 id 存
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  // A4 懒加载缓存：已展开的父节点 id → 子级数据；折叠不丢，再展开零请求
  const [childrenMap, setChildrenMap] = useState<Record<string, ExpandResult>>({});
  // 节点 id → 父节点 id（下钻链，可见性按祖先展开位逐级判）
  const [parentOf, setParentOf] = useState<Record<string, string>>({});
  // 布局记忆（§4.4）三源分层，坐标 = dagre 兜底 ⊕ layout.json 复原 ⊕ 本会话拖动/子树局部重排。
  // F4：三源全部**按视图分键**（DoD② 红线）——跨视图共用一份坐标必然跳位，切视图也不清空。
  const [layoutByMode, setLayoutByMode] = useState<Record<string, Record<string, NodePosition>>>({});
  const [userPosByMode, setUserPosByMode] = useState<Record<string, Record<string, NodePosition>>>({});
  const [subtreePos, setSubtreePos] = useState<Record<string, Record<string, NodePosition>>>({});
  const [expandBusy, setExpandBusy] = useState<string | null>(null);
  // A5 对账结果（§4.5）：最近一次 reconcile-last.json；null = 还没跑过（空态，不是错误）
  const [reconcile, setReconcile] = useState<ReconcileResult | null>(null);
  const [reconcileBusy, setReconcileBusy] = useState(false);
  // Q133：本次解析应答里的 stats（点「解析」当场就知道这次是不是到点收工——渲染数据回来前
  // 也能提示；null = 本会话还没跑过解析，此时完整性只认落盘件标记 graph.budget_exhausted）
  const [parseStats, setParseStats] = useState<ArchParseAck["stats"] | null>(null);
  // F4 DoD③ 证据：解析入口调用次数 / 数据层拉取次数（切换前后必须不变 → 打点在 DOM 上）
  const [parseCalls, setParseCalls] = useState(0);
  const [dataLoads, setDataLoads] = useState(0);
  // ── T19（DESIGN §11.8）：后台解析 run 的跟踪现场 ─────────────────────────────
  // 进行中显示进度＋显式取消钮（不阻塞页面其它操作）；刷新/重进页面经 GET 自动挂上续看
  // （断连≠取消：轮询只读 GET，卸载/换项目只停轮询，**绝不发 DELETE**——取消只来自「取消解析」按钮）。
  /** 当前挂着的 run（进行中或最近一次终态；null = 没跑过/还没查回来） */
  const [parseRun, setParseRun] = useState<ParseRun | null>(null);
  /** 最近一次取消的如实说明（取消只来自显式动作 ⇒ cancelled ⟺ 用户点了取消；刷新后照常说） */
  const [parseCancelNote, setParseCancelNote] = useState<string | null>(null);
  /** 已应用终态后果的 run key（`${id}:${status}`）——POST 等终态与 GET 轮询可能同时看到终态，只应用一次 */
  const parseTermRef = useRef("");
  /** GET 轮询定时器（只在跟踪进行中 run 时挂着） */
  const parsePollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  /** 轮询代际：stopParsePoll 递增，在途应答凭它识别自己已作废（见 stopParsePoll 注释） */
  const parsePollGenRef = useRef(0);
  /** 本页面发起的 run id（只有它跑完才接 Flash 起名；挂上别人的 run 不替人烧模型请求） */
  const parseInitiatedRef = useRef<string | null>(null);
  /** U-01（2026-09-21 收口审计）：当前项目 id 的实时 ref + 卸载标记——handleParse 的 POST 续跑
   *  跨 await 拿着发起时的闭包，outcome 到达时必须能识别"项目已换/组件已卸"并整体静默丢弃
   *  （不停新项目的轮询、不往新画布写旧项目的图） */
  const projectIdRef = useRef(project.id);
  projectIdRef.current = project.id;
  /** V09-22：`load` 的代际——换项目重置 effect 与「显示全部」切换都会调它，两次请求可能交织；
   *  在途应答凭调用时自增的代际识别自己是否已作废（同 ArchCanvas 里 parsePollGenRef 的思路）。 */
  const loadGenRef = useRef(0);
  const unmountedRef = useRef(false);
  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
    };
  }, []);
  // React Flow 实例（fitView 补 fit 用；`onInit` 拿到，见下面的 effect）
  const [flowInstance, setFlowInstance] = useState<ReactFlowInstance<ArchFlowNode, Edge> | null>(null);
  // 待写回的拖动坐标（debounce 合并 PUT）：按视图分桶——拖完立刻切视图也不会把坐标写错桶
  const dirtyRef = useRef<Record<string, Record<string, NodePosition>>>({});
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // ── N3 定位（对齐键 = module_id）──────────────────────────────────────────────
  /** 本次定位命中的 module_id（高亮用它；null = 当前没有定位目标） */
  const [focusedId, setFocusedId] = useState<string | null>(null);
  /** 定位结果提示（DoD④）：未匹配要说清"在哪个视图无对应"；匹配也留一行痕 */
  const [locateNote, setLocateNote] = useState<{ state: "matched" | "unmatched"; text: string } | null>(null);
  /** 已处理的定位请求号：同一个请求只处理一次（数据晚到时补处理一次，之后不再动视口） */
  const locateHandledRef = useRef(0);
  /** 视口让路标记：定位请求到达时置位 → 让下面那次补 fitView 让位给"居中到目标节点" */
  const suppressFitRef = useRef(false);
  /** P-1：本次展开新长出的节点（父 + 子级 id）。展开后**只在**这些节点有落在视口外的，
   *  才把视口补到能看见它们——用户已经摆好的视口（新节点本来就在视口里）一律不抢。
   *  折叠、拖动、切视图都不置位（视口不动）。 */
  const expandRevealRef = useRef<{ parent: string; ids: string[] } | null>(null);
  /** 本次渲染的节点（定位居中时按 id 现取坐标，不把 flow 塞进 effect 依赖里） */
  const flowRef = useRef<{ nodes: ArchFlowNode[] } | null>(null);
  /** 定位 effect 要**不重跑**地读到最新数据：只认请求号变化，不认展开/拖动（见下） */
  const locateDataRef = useRef<{
    sharedIds: Set<string>;
    loadedChildIds: Set<string>;
    parentOf: Record<string, string>;
  }>({ sharedIds: new Set(), loadedChildIds: new Set(), parentOf: {} });
  /** 节点上的「在思维导图定位」入口（ref 注入：节点组件不因回调重建） */
  const locateNodeRef = useRef<(id: string, label: string, path: string) => void>(() => {});
  locateNodeRef.current = (id, label, path) => onLocate?.({ id, label, path });

  const load = useCallback(() => {
    const gen = ++loadGenRef.current; // V09-22：本次调用的代际（换项目/切模式交织时凭它丢弃旧应答）
    setError(null);
    setDataLoads((n) => n + 1); // F4 DoD③：数据层拉取次数（切视图不得增长）
    const override = overrideRef.current;
    if (override !== null) {
      // V06-06：外部喂了一层共用数据层（规划层 + 旧图合成）——不拉 arch/render，
      // 也就不存在"未解析引导态"（空仓也要能看规划图，§3.2）；布局记忆照旧复用 layout.json
      setExists(true);
      setGraph(override);
      setReconcile(null);
      getArchLayout(project.id)
        .then((layout) => {
          if (loadGenRef.current === gen) setLayoutByMode(layout.positions);
        })
        .catch(() => undefined);
      return;
    }
    Promise.all([
      // V09-22：按当前模式拉取（显示全部时走 ?full=1，同一 builder 换上限；概览默认逐字不变）
      getArchRender(project.id, { full: showAllRef.current }),
      getArchLayout(project.id).catch(() => ({ version: 2 as const, positions: {} })),
      getArchReconcile(project.id).catch(() => ({ exists: false as const })),
    ])
      .then(([r, layout, rec]) => {
        if (loadGenRef.current !== gen) return; // 换项目/切模式后的旧应答不写新画布
        setExists(r.exists);
        setGraph(r.graph ?? null);
        setLayoutByMode(layout.positions);
        setReconcile(rec.exists ? (rec.result ?? null) : null);
      })
      .catch((e: Error) => {
        if (loadGenRef.current === gen) setError(e.message);
      });
  }, [project.id]);

  // V06-06：外部数据换了（筛选/概览截断/源更新）就地换图——**不清折叠、不清子级缓存、不清布局**：
  // 所以只更新 graph，不走上面那个"换项目才跑"的重置 effect（§3.3：定位/更新不重置对方视图的状态）
  useEffect(() => {
    if (graphOverride !== null && graphOverride !== undefined) setGraph(graphOverride);
  }, [graphOverride]);

  // V09-22：切换「显示全部 / 返回概览」就地重拉数据层（同一 builder 换上限参数，不另造图事实源）——
  // 折叠 / 子级缓存 / 布局不清（新节点由 dagre 兜底落位，现有机制）；挂载首轮不重拉（项目 effect 已拉过）。
  const showAllMountedRef = useRef(false);
  useEffect(() => {
    if (!showAllMountedRef.current) {
      showAllMountedRef.current = true; // 挂载首轮：load 已由项目重置 effect 触发
      return;
    }
    if (usingOverride) return; // 主视图（override）没有「显示全部」入口
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showAll]);

  // ── V09-22：隐藏对象抽屉的生命周期 ──────────────────────────────────────────────
  // 换项目/切「显示全部」= 关闭抽屉、清空列表与详情，并作废在途应答（并入既有重置口径）。
  useEffect(() => {
    hiddenGenRef.current += 1;
    setHiddenOpen(false);
    setHiddenKind("nodes");
    setHiddenQueryInput("");
    setHiddenQuery("");
    setHiddenRows([]);
    setHiddenPage({ total: 0, offset: 0, returned: 0, has_more: false });
    setHiddenError(null);
    setDetailObject(null);
    if (hiddenDebounceRef.current) {
      clearTimeout(hiddenDebounceRef.current);
      hiddenDebounceRef.current = null;
    }
  }, [project.id, showAll]);

  /** V09-22：抽屉搜索防抖 300ms——输入停下才把词交给取数 effect（空串＝清过滤、回第一页全集） */
  useEffect(() => {
    if (hiddenDebounceRef.current) clearTimeout(hiddenDebounceRef.current);
    hiddenDebounceRef.current = setTimeout(() => {
      setHiddenQuery(hiddenQueryInput.trim());
    }, 300);
    return () => {
      if (hiddenDebounceRef.current) clearTimeout(hiddenDebounceRef.current);
    };
  }, [hiddenQueryInput]);

  /** V09-22：抽屉第一页取数（打开 / 换 kind / 换查询词时重置回第一页，带 q 拉取） */
  useEffect(() => {
    if (!hiddenOpen) return;
    const gen = ++hiddenGenRef.current;
    setHiddenBusy(true);
    setHiddenError(null);
    getArchItems(project.id, {
      kind: hiddenKind,
      ...(hiddenQuery !== "" ? { q: hiddenQuery } : {}),
      offset: 0,
    })
      .then((page) => {
        if (hiddenGenRef.current !== gen || projectIdRef.current !== project.id) return;
        setHiddenRows(page.nodes ?? page.edges ?? []);
        setHiddenPage({ total: page.total, offset: page.offset, returned: page.returned, has_more: page.has_more });
      })
      .catch((e: Error) => {
        if (hiddenGenRef.current === gen) setHiddenError(e.message);
      })
      .finally(() => {
        if (hiddenGenRef.current === gen) setHiddenBusy(false);
      });
  }, [hiddenOpen, hiddenKind, hiddenQuery, project.id]);

  /** V09-22：抽屉「加载更多」——按 offset + returned 取下一页并追加（has_more=false 后按钮隐藏） */
  const loadMoreHidden = useCallback(() => {
    const gen = ++hiddenGenRef.current;
    setHiddenBusy(true);
    setHiddenError(null);
    getArchItems(project.id, {
      kind: hiddenKind,
      ...(hiddenQuery !== "" ? { q: hiddenQuery } : {}),
      offset: hiddenPage.offset + hiddenPage.returned,
    })
      .then((page) => {
        if (hiddenGenRef.current !== gen || projectIdRef.current !== project.id) return;
        setHiddenRows((prev) => [...prev, ...(page.nodes ?? page.edges ?? [])]);
        setHiddenPage({ total: page.total, offset: page.offset, returned: page.returned, has_more: page.has_more });
      })
      .catch((e: Error) => {
        if (hiddenGenRef.current === gen) setHiddenError(e.message);
      })
      .finally(() => {
        if (hiddenGenRef.current === gen) setHiddenBusy(false);
      });
  }, [hiddenKind, hiddenQuery, hiddenPage.offset, hiddenPage.returned, project.id]);

  /** V09-22：抽屉行点击 → 打开对象详情（对象与 render 节点同构）。复用画布节点详情的打开路径：
   *  外部给了 `onNodeClick`（主视图）时也一并交给它；技术详情两图不传该回调，只开本画布自己的详情面板。
   *  点击后**抽屉保持打开**（面板浮在画布上，两者可并存）。 */
  const openHiddenDetail = useCallback(
    (item: { kind: "node"; node: SharedModuleNode } | { kind: "edge"; edge: SharedGraphEdge }) => {
      setDetailObject(item);
      if (item.kind === "node") {
        onNodeClickRef.current?.({ id: item.node.id, label: item.node.name, path: item.node.path });
      }
    },
    [],
  );

  // ── V09-07（附录 E.8-1）：图页自动失效重取——工作事件账本 `task_last_seq` 前进就自动 `load()`，
  //    无需手动刷新（手动「重新解析/刷新」等既有入口不动）。4s 轮询 `GET live`；只在页面可见时跑
  //   （visibilitychange 暂停，回前台立即补一轮）。首轮只登记基线（判据纯函数见 `./lastSeq.ts`）。
  //    外部喂数据层（override）时 load() 本就不拉 arch/render，这轮自动重取只落到布局/对账读口。
  const knownSeqRef = useRef<number | null | undefined>(undefined);
  useEffect(() => {
    knownSeqRef.current = undefined; // undefined = 从未观察（首轮只登记基线）；null = 上次读出 null（v1/读不到）
    let stopped = false;
    const tick = (): void => {
      if (document.visibilityState !== "visible") return;
      getLive(project.id)
        .then((live) => {
          if (stopped) return;
          const cur = live.task_last_seq;
          if (hasAdvancedEvents(knownSeqRef.current, cur)) load();
          knownSeqRef.current = cur;
        })
        .catch(() => undefined);
    };
    const timer = setInterval(tick, GRAPH_PAGE_POLL_MS);
    // 挂载立即登记基线（只登记、不加载）：否则"挂载后、首个 4s tick 前"落进来的事件会被
    // 首次观察当成基线吞掉，永远触发不了重取（实测复现，与 ProjectGraphView 同一修法）
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

  /** A5：手动跑一次对账（§4.5：差异是信号不是错误，结果只读合成不落 design/progress） */
  const runReconcile = useCallback(() => {
    setReconcileBusy(true);
    postArchReconcile(project.id)
      .then((result) => {
        if (projectIdRef.current === project.id) setReconcile(result); // 应答跨 await：项目已换则丢弃
      })
      .catch((e: Error) => {
        if (projectIdRef.current === project.id) setError(e.message);
      })
      .finally(() => setReconcileBusy(false));
  }, [project.id]);

  // ── T19（§11.8）：解析 run 的轮询/终态收尾/显式取消 ──────────────────────────
  const stopParsePoll = useCallback(() => {
    // 递增代际：在途的轮询应答（比停止晚到）一律作废——否则它会把已推进到终态的 parseRun
    // 回写成 running，取消原因条（以 parseRun.status !== "running" 为门槛）被永久压下去
    parsePollGenRef.current += 1;
    if (parsePollRef.current !== null) {
      clearInterval(parsePollRef.current);
      parsePollRef.current = null;
    }
  }, []);

  /** run 到终态的收尾：done 刷新数据层（本页面发起的才接 Flash 起名）；cancelled 如实标注原因＋
   *  拉回落盘真实现状（旧结果可能仍在）；failed 报错并拉回真实现状。每个 run 只应用一次。 */
  const applyParseTerminal = useCallback(
    async (run: ParseRun) => {
      // V09-22：应答跨 await 回来时项目可能已换/组件已卸——与 handleParse 同一份 stale 口径
      // （就地一行，不引新抽象层）；本函数入口只保证 run 终态去重，不保证项目仍是同一个。
      const stale = (): boolean => unmountedRef.current || projectIdRef.current !== project.id;
      const key = `${run.id}:${run.status}`;
      if (parseTermRef.current === key) return;
      parseTermRef.current = key;
      // 统一把展示中的 run 推进到终态：POST 等终态的路径会先停轮询（handleParse），
      // 若不在这里同步 parseRun，运行态条会以最后一次轮询的 running 冻结在屏上
      setParseRun(run);
      if (run.status === "done") {
        setParseCancelNote(null);
        if (run.result) setParseStats(run.result.stats);
        if (overrideRef.current !== null) {
          // U-02（2026-09-21 收口审计）：主视图（外部喂规划数据层）里解析跑完**不**把静态解析图
          // 盖上画布——规划图才是这里的权威来源；只重走 load() 回到 override 图，起名兜底也不在
          // 主视图替人烧模型请求。运行态/取消横幅保留，「重新解析」走完同样落回本分支受同一守卫
          load();
          return;
        }
        setBusy("正在读取渲染数据…");
        try {
          // V09-22：解析完成后的重取按当前模式拉（全量态不被静默退回概览——load 同一镜像口径）
          let r = await getArchRender(project.id, { full: showAllRef.current });
          if (stale()) return;
          // 引导态同口径（§3.3）：无 names 缓存时起名兜底——但只有本页面发起的 run 才接这步；
          // 起名失败不报废画布：按模块 id 兜底显示，原因进横幅（旧口径是整卡错误页，图都出不来）
          if (
            parseInitiatedRef.current === run.id &&
            r.exists &&
            r.graph &&
            r.graph.nodes.some((n) => !n.aggregate && n.name === n.id)
          ) {
            setBusy("正在给模块起人话名（Flash，首次较慢）…");
            setParseCalls((n) => n + 1); // F4 DoD③ 打点：起名入口（同为"解析侧"一次性开销）
            try {
              await postArchName(project.id);
              if (stale()) return;
              r = await getArchRender(project.id, { full: showAllRef.current });
              if (stale()) return;
            } catch (e) {
              setError(`模块起名失败（结构图不受影响，按模块 id 显示）：${(e as Error).message}`);
            }
          }
          // 结构变化自动重算（§4.4）：已有节点按 layout.json/当前坐标保持原位，新节点 dagre 补位
          const layout: ArchLayoutFile = await getArchLayout(project.id).catch(() => ({
            version: 2,
            positions: {},
          }));
          if (stale()) return;
          setExists(r.exists);
          setGraph(r.graph ?? null);
          setLayoutByMode(layout.positions);
          // 子树缓存失效（结构可能变了），折叠回概览
          setChildrenMap({});
          setParentOf({});
          setSubtreePos({});
          setExpanded({});
        } catch (e) {
          setError((e as Error).message);
          load(); // 渲染拉取失败：重走数据层，让 exists/错误卡回到落盘真实现状
        } finally {
          setBusy(null);
        }
        return;
      }
      if (run.status === "cancelled") {
        // 显式取消不发布半成品（§11.8）：旧结果可能仍在——拉回真实落盘状态，未完成原因如实上屏
        setParseCancelNote(cancelNoteOf(run));
        load();
        return;
      }
      // U-03：fallthrough 只把**确定** failed 送进失败文案——running 不是终态（别的客户端新起的
      // run 可能在此刻被查到），调用方都已按 status 守卫，这里静默不应用（不冒充失败）
      if (run.status === "failed") {
        // failed：错误如实报（失败不落盘，旧结果原样），并拉回数据层真实现状
        setError(run.error ?? "解析失败（无错误明细）");
        load();
      }
    },
    [load, project.id],
  );

  /** GET 轮询跟踪一个进行中 run（续看通道）：每 800ms 拿进度，终态即停并统一走 applyParseTerminal。
   *  轮询只读 GET——它本身不是、也永远不是取消动作（§11.8 断连≠取消）。 */
  const trackParseRun = useCallback(
    (run: ParseRun) => {
      setParseRun(run);
      if (run.status !== "running") {
        void applyParseTerminal(run);
        return;
      }
      if (parsePollRef.current !== null) return; // 已在轮询（同一 run 不叠第二个定时器）
      const gen = parsePollGenRef.current; // 本代轮询：stopParsePoll 递增代际后，本代在途应答作废
      parsePollRef.current = setInterval(() => {
        getArchParseRun(project.id)
          .then((latest) => {
            if (parsePollGenRef.current !== gen) return; // 轮询已停/已换代：在途应答不回写状态
            if (latest === null) return; // 服务端重启丢了进程内现场：保持现状下轮再试，不冒充终态
            setParseRun(latest);
            if (latest.status !== "running") {
              stopParsePoll();
              void applyParseTerminal(latest);
            }
          })
          .catch(() => {
            // 网络/服务抖动：轮询不中断也不冒充终态，下一轮再试
          });
      }, 800);
    },
    [project.id, applyParseTerminal, stopParsePoll],
  );

  // T19：进页面/换项目自动挂上——进行中的 run 续看进度（断连≠取消，§3.13 重连续看）；
  // 最近一次是取消的，原因如实留屏（上次有效结果还在落盘件里，与图上的旧结果口径一致）。
  useEffect(() => {
    let alive = true;
    getArchParseRun(project.id)
      .then((run) => {
        if (!alive || run === null) return;
        if (run.status === "running") {
          trackParseRun(run);
        } else if (run.status === "cancelled") {
          setParseRun(run);
          setParseCancelNote(cancelNoteOf(run));
        }
        // done/failed 的最近一次不铺横幅（落盘件自带 budget 完整性标记；failed 当时已报错留痕）
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      stopParsePoll(); // 卸载/换项目只停轮询——不是取消动作，绝不发 DELETE
    };
  }, [project.id, trackParseRun, stopParsePoll]);

  // F2：本视图那份选择（§3.2 节点集合两图完全相同；边按模式取子集并着色）。
  // 渲染与布局都吃这一份（F3：数据流向图的 dagre 用翻转后的边分层，提供者在左）
  const selection = useMemo(() => (graph ? selectGraph(mode, graph) : null), [graph, mode]);

  /** dagre 兜底坐标（按模式各算一份：数据流向图的边方向翻了，分层也跟着翻）。
   *  V09-21 R3（2026-09-27，非作者终审 F-A）：**零边选择集不走 dagre**——dagre LR 在零边上把所有
   *  节点并到同一层（约 8000px 一行）。零边情形改走 `gridLayout`（与 `mergeIncrementalLayout` 的
   *  V06-06 兜底同一份判据：列数 = ⌈√n⌉ 且不超过 5）——dagre 调用点不新增（verify-f3 唯一性断言）。
   *  同一批实测的另一半：主视图「系统架构」（override）的 29 个对象节点带 346 条互依边，dagre LR
   *  把它们排成 2 列 × 约 3000px 的竖条——画布高度方向 fit 缩放被压到 0.09 以下（节点 21×10px），
   *  这就是 F-A「29 节点全部 29.4×14.2px、点中心命中展开钮」的成因。主视图是给人看图用的
   *  （§3.2/§3.11），override 一律走紧凑网格（边照常画），技术详情三图维持 dagre 不动。 */
  const dagreBase = useMemo(() => {
    if (!selection) return {};
    const laid =
      usingOverride || (selection.edges.length === 0 && selection.nodes.length > 1)
        ? gridLayout(selection.nodes, 60)
        : layoutWithDagre(selection.nodes, selection.edges);
    return Object.fromEntries(laid.map((p) => [p.id, { x: p.x, y: p.y }]));
  }, [selection, usingOverride]);

  /** 生效坐标（§4.4 优先级：本会话拖动 > 子树局部重排 > layout.json 复原 > dagre 补位）。
   *  F4：后三源都只取**本视图**的桶——两视图坐标互不污染（切回方框图，方框图里拖过的 A 还在原处） */
  const pos = useMemo(
    () => ({
      ...dagreBase,
      ...(layoutByMode[layoutKey] ?? {}),
      ...(subtreePos[layoutKey] ?? {}),
      ...(userPosByMode[layoutKey] ?? {}),
    }),
    [dagreBase, layoutByMode, subtreePos, userPosByMode, layoutKey],
  );

  useEffect(() => {
    setExists(null);
    setGraph(null);
    // V09-22：换项目 = 回到概览默认口径（显示全部 / 搜索都不跨项目沿用）
    setShowAll(false);
    setSearch("");
    setHitIdx(0);
    setExpanded({}); // 换项目 = 初次进入，回到默认全折叠（§3.3 规则 5）
    setChildrenMap({});
    setParentOf({});
    setLayoutByMode({});
    setUserPosByMode({});
    setSubtreePos({});
    setReconcile(null);
    // Q133：换项目 = 上一个项目的解析结论作废（完整性标记只能来自本项目这次的解析或它自己的落盘件）
    setParseStats(null);
    // T19：换项目 = 停掉上个项目的 run 跟踪（只停轮询，不发 DELETE——断连/切项目≠取消，§11.8）；
    // 新项目自己的进行中 run 由上面的自动挂上 effect 接管续看
    stopParsePoll();
    setParseRun(null);
    setParseCancelNote(null);
    parseTermRef.current = "";
    parseInitiatedRef.current = null;
    dirtyRef.current = {};
    // V09-22：换项目把待写回的 debounce 定时器也清掉——否则它 600ms 后带着旧项目的坐标
    // 去 PUT 新项目的 layout.json
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    // N3：定位状态跟着项目走——node id 是项目内 slug，换个项目可能同名，
    // 留着旧目标会在新项目上画一圈没有来由的高亮
    setFocusedId(null);
    setLocateNote(null);
    load();
  }, [load, stopParsePoll]);

  /** 拖动坐标 debounce 写回 layout.json（§4.4 布局记忆）：按视图分桶 PUT，只覆盖本视图那一层 */
  const scheduleSave = useCallback(
    (id: string, p: NodePosition) => {
      (dirtyRef.current[layoutKey] ??= {})[id] = p;
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        const payload = dirtyRef.current;
        dirtyRef.current = {};
        for (const [dirtyMode, positions] of Object.entries(payload)) {
          if (Object.keys(positions).length === 0) continue;
          putArchLayout(project.id, dirtyMode as GraphMode | typeof PROJECT_ARCH_LAYOUT_KEY, positions)
            .then((file) => {
              if (projectIdRef.current === project.id) setLayoutByMode(file.positions); // 回包跨 await：项目已换则丢弃
            })
            .catch(() => {
              // 写回失败不打断交互（下次拖动会再带上）；布局记忆以 layout.json 为准
            });
        }
      }, 600);
    },
    [project.id, layoutKey],
  );

  /** 依赖方向的边集合 → 本模式的渲染边：DATA_FLOW 走共用过滤/着色实现（shared-graph 同一份），
   *  其余模式原样画、边中性色（§3.2：节点集合相同，边集合按方向过滤/着色——只 DATA_FLOW 过滤） */
  const renderEdgesOf = useCallback(
    (deps: GraphEdge[], nodeIds: string[]): SelectedEdge[] => {
      if (mode === "DATA_FLOW") return selectDataFlowEdges(deps, nodeIds).edges;
      return deps.map((e) => ({
        id: `${e.from}>${e.to}`,
        from: e.from,
        to: e.to,
        weight: e.weight,
        color_role: null,
      }));
    },
    [mode],
  );

  /** 展开/折叠（§3.3 规则 2/4）：原地长出/收起，不跳页不换图；展开子树只局部重排该子树（§4.6） */
  const handleToggle = useCallback(
    async (id: string) => {
      if (expanded[id]) {
        // 折叠：隐去全部后代，数据与坐标保留（再展开零请求、位置不变）
        setExpanded((prev) => ({ ...prev, [id]: false }));
        return;
      }
      let result = childrenMap[id];
      if (!result) {
        // 懒加载：只有点开这一刻才解析该子树（§4.3 第 2 招）
        const nodePath =
          graph?.nodes.find((n) => n.id === id)?.path ??
          Object.values(childrenMap)
            .flatMap((r) => r.children)
            .find((c) => c.id === id)?.path;
        if (!nodePath) return;
        try {
          setExpandBusy(id);
          setParseCalls((n) => n + 1); // F4 DoD③ 打点：展开 = 走一次解析入口
          // V09-22（契约 2）：全量模式按稳定分页把子级取全（上限外的子级逐项可取回，不再只给「还有 N 个」）；
          // 概览模式维持缺省调用——旧行为逐字节不变（仍走截断＋「还有 N 个」聚合口径，概览契约不动）。
          result = showAllRef.current
            ? await postArchExpandAll(project.id, nodePath)
            : await postArchExpand(project.id, nodePath);
          // V09-22：应答跨 await 回来时项目可能已换——旧子级不往新画布写（busy 由 finally 收尾）
          if (projectIdRef.current !== project.id) return;
        } catch (e) {
          setError((e as Error).message);
          return;
        } finally {
          setExpandBusy(null);
        }
        setChildrenMap((prev) => ({ ...prev, [id]: result! }));
        setParentOf((prev) => {
          const next = { ...prev };
          for (const c of result!.children) next[c.id] = id;
          return next;
        });
        // 局部重排（§4.6）：只排这棵子树；全局已有节点坐标不动。
        // 边取本模式的渲染边（数据流向图的子树也按翻转方向分层）
        // Q120：DATA_FLOW 里子树锚点取本视图全图最右边界（parentWidth=0 → 落到簇外 +120 空地），
        // 不再平移到父节点右侧——父节点右侧与顶层模块簇重叠，子节点盖上去后模块节点拖不动；
        // V09-21 R4（F-B 实测）：MODULE_BOX 同样改用右边界锚点——锚在父节点右侧时，展开的
        // 文件节点卡片会盖住兄弟模块（src/src-tauri）的展开钮（elementFromPoint 命中文件节点）。
        const anchor = pos[id] ?? EMPTY_POS;
        const childIds = result.children.map((c) => c.id);
        const laid = layoutSubtree(
          result.children.map((c) => ({ id: c.id, kind: c.kind })),
          renderEdgesOf(subtreeDeps(result.children), childIds),
          { x: rightEdgeOf(pos), y: anchor.y },
          0,
        );
        setSubtreePos((prev) => ({
          ...prev,
          [layoutKey]: { ...(prev[layoutKey] ?? {}), ...Object.fromEntries(laid.map((p) => [p.id, { x: p.x, y: p.y }])) },
        }));
      }
      setExpanded((prev) => ({ ...prev, [id]: true }));
      // P-1：记下本次新长出的节点（父 + 子级）——下一个 effect 只在它们有落在视口外时才补视口
      expandRevealRef.current = { parent: id, ids: [id, ...(result?.children ?? []).map((c) => c.id)] };
    },
    [expanded, childrenMap, graph, pos, project.id, mode, renderEdgesOf],
  );

  // 引导态（§3.3 空态）/ 取消后重发（§11.8 ⑤）：POST 启动（或挂上）后台 run 并等终态；
  // 等待期间 GET 轮询拿进度（trackParseRun）——页面不阻塞；终态后果统一走 applyParseTerminal（去重）。
  async function handleParse() {
    // U-01（2026-09-21 收口审计）：POST 续跑跨 await 拿着发起时的闭包——项目已换/组件已卸时
    // 旧闭包必须整体静默丢弃（不停新项目的轮询、不应用旧终态、不往新画布写旧项目的图）
    const forProject = project.id;
    const stale = () => unmountedRef.current || projectIdRef.current !== forProject;
    setParseCancelNote(null);
    setError(null);
    setBusy("正在启动解析…");
    setParseCalls((n) => n + 1); // F4 DoD③ 打点：全量解析入口
    try {
      const postP = postArchParse(forProject);
      // stale 早退的路径不再 await 它：先挂空拒绝处理，避免那时产生 unhandled rejection 噪音
      // （无论哪条路径，终态后果都由 stale 守卫保证不误应用）
      void postP.catch(() => undefined);
      // 挂上进度：单发查询是个竞态——GET 可能先于 POST 登记到达（拿到 null），或拿到**上一轮**的
      // 终态记录（seed/旧 run——挂上它会把旧终态当新终态提前应用，运行态条直接不出现）。
      // 口径：进行中 run 必是新 run（或单飞挂上的同一 run）；id 与首查不同的新记录（瞬完的小 run）
      // 也算；同 id 的旧终态不算，重查几拍。还挂不上就降级为只等 POST 终态（终态后果照常应用）。
      const firstSeen = await getArchParseRun(forProject).catch(() => null);
      if (stale()) return;
      const firstId = firstSeen?.id ?? null;
      let run: ParseRun | null = null;
      for (let i = 0; i < 8 && run === null; i += 1) {
        const latest = i === 0 ? firstSeen : await getArchParseRun(forProject).catch(() => null);
        if (stale()) return;
        if (latest !== null && (latest.status === "running" || latest.id !== firstId)) {
          run = latest;
        } else if (i < 7) {
          await new Promise((r) => setTimeout(r, 250));
        }
      }
      if (run !== null) {
        parseInitiatedRef.current = run.id; // 本页面发起的（或单飞挂上的）——跑完接起名兜底
        trackParseRun(run);
      }
      const outcome = await postP;
      if (stale()) return;
      stopParsePoll();
      if (outcome.kind === "done") {
        // 终态以 POST 应答为准（轮询若先看到终态，applyParseTerminal 按 run key 去重）
        await applyParseTerminal({
          id: outcome.run_id,
          project_id: forProject,
          status: "done",
          started_at: "",
          finished_at: null,
          progress: { phase: "parsing", walked_files: 0, parsed_files: 0, source_files: null },
          result: { source: "", ...outcome.result },
          error_code: null,
          error: null,
        });
      } else {
        // 被显式取消（取消钮/别的页面发的 DELETE）：拿真实现场如实显示，旧结果保留可重发
        const latest = await getArchParseRun(forProject).catch(() => null);
        if (stale()) return;
        if (latest !== null) {
          setParseRun(latest);
          if (latest.status !== "running") {
            // U-03：与 handleParseCancel 同款守卫——running（别的客户端刚新起的 run）不是
            // 本 run 的终态，绝不往 fallthrough 的失败文案送；重新挂上跟踪（同进页面续看）
            await applyParseTerminal(latest);
          } else {
            trackParseRun(latest);
          }
        } else {
          setParseCancelNote(outcome.note);
          load();
        }
      }
    } catch (e) {
      if (stale()) return;
      stopParsePoll();
      // POST 报错（解析 failed / 网络）：轮询若已看到 failed 终态会统一处理；这里兜底如实报
      setError((e as Error).message);
      load();
    } finally {
      if (!stale()) setBusy(null);
    }
  }

  // T19：显式取消——UI 里**唯一**的取消来源（§11.8：卸载/切换/断连都不是取消，只有这个按钮是）。
  // 回执落地后立刻查一次状态（不等下一个轮询周期），终态仍统一走 applyParseTerminal。
  async function handleParseCancel() {
    try {
      const receipt = await deleteArchParseRun(project.id);
      const latest = await getArchParseRun(project.id).catch(() => null);
      if (latest !== null) {
        setParseRun(latest);
        if (latest.status !== "running") {
          stopParsePoll();
          await applyParseTerminal(latest);
        }
      } else if (!receipt.cancelled) {
        setParseRun(null); // 没有进行中的 run（可能刚跑完）——清掉运行态显示
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }

  // 节点组件里的回调用 ref 注入，避免 flow useMemo 依赖 handleToggle 造成整树重建
  const handleToggleRef = useRef<(id: string) => void>(() => {});
  handleToggleRef.current = (id) => void handleToggle(id);
  const childNodeData = useCallback(
    (c: ExpandChild, isExpanded: boolean, isBusy: boolean): ArchNodeData => ({
      label: c.name,
      path: c.path,
      file_count: c.file_count,
      isFile: c.kind === "file",
      // N2：超上限的「还有 N 个」聚合节点（§4.3 第 1 招，服务端 A4 截断产物）不可下钻，
      // 与顶层聚合节点同一种块样式（A4 子级与顶层共用同一套聚合口径，不另画一种）
      aggregate: c.kind === "aggregate",
      expandable: c.kind === "dir",
      expanded: isExpanded,
      busy: isBusy,
      changed: c.changed_recently === true,
      onToggle: handleToggleRef.current,
      onLocateNode: locateNodeRef.current,
      kindBadge:
        c.kind === "dir"
          ? { badge: "bg-neutral-800 text-neutral-400", label: "dir" }
          : undefined,
    }),
    [],
  );

  /**
   * A5 对账差异节点集合（§4.5）：代码有、设计书没有的模块 id → 标记。
   * V09-08 ③（附录 E.7 裁定④）：**原始事实照旧**（每条仍进这个集合、节点仍带 `data-arch-diff`），
   * 但每条另带**显示分类**（`reconcileClass.ts` 的同一份词表）：只有「真差异」才用黄，
   * 口径边界（范围外/结构性目录）用中性底色——不再把 4 条口径边界都叫「对账差」。
   */
  const diffById = useMemo(() => {
    const m = new Map<string, ReturnType<typeof categoryOfOnlyInCode>>();
    for (const c of reconcile?.only_in_code ?? []) m.set(c.id, categoryOfOnlyInCode(c));
    return m;
  }, [reconcile]);
  const diffIds = useMemo(() => new Set(diffById.keys()), [diffById]);

  /** V09-08 ③：`only_in_code` 按分类分计（面板与节点徽标读同一份分组，词表在 `reconcileClass.ts`） */
  const groupedOnlyInCode = useMemo(() => groupOnlyInCode(reconcile?.only_in_code ?? []), [reconcile]);
  /** V09-08 ②/③：配对依据计数（实现落点 / 章节落点未证实 / 名字信号） */
  const matchedByVia = useMemo(() => countMatchedByVia(reconcile?.matched ?? []), [reconcile]);

  /** 本模式要渲染的节点与边（React Flow 口径）+ 口径快照（header/图例/断言读同一份） */
  const flow = useMemo(() => {
    if (!graph || !selection) return null;
    // 可见性（§3.3 可折叠树）：顶层恒可见；子级按父链展开位逐级判
    const isVisible = (id: string): boolean => {
      let cur = parentOf[id];
      if (!cur) return true;
      while (cur) {
        if (expanded[cur] !== true) return false;
        cur = parentOf[cur];
      }
      return true;
    };
    // 本次已缓存的全量子级：边按模式过滤（DATA_FLOW 另算一份流向角色给子级节点标记）
    const allChildren = Object.values(childrenMap).flatMap((r) => r.children);
    const allChildDeps = subtreeDeps(allChildren);
    const childIds = allChildren.map((c) => c.id);
    const flowChild = mode === "DATA_FLOW" ? selectDataFlowEdges(allChildDeps, childIds) : null;
    const childEdges = flowChild ? flowChild.edges : renderEdgesOf(allChildDeps, childIds);
    const allEdges = [...selection.edges, ...childEdges];
    const maxWeight = allEdges.reduce((m, e) => Math.max(m, e.weight), 1);

    const nodes: ArchFlowNode[] = [];
    // 顶层模块（F2 共用数据层节点集合，原样复用不过滤）
    for (const n of selection.nodes) {
      nodes.push({
        id: n.id,
        type: "archNode",
        position: pos[n.id] ?? { x: 0, y: 0 },
        draggable: !n.aggregate,
        data: {
          label: n.name,
          path: n.path,
          file_count: n.file_count,
          blurb: n.blurb,
          kindBadge: KIND_STYLE[n.kind] ?? KIND_STYLE.mixed,
          aggregate: n.aggregate,
          origin: n.origin,
          expandable: !n.aggregate && n.origin !== "chat",
          expanded: expanded[n.id] === true,
          busy: expandBusy === n.id,
          status: n.status,
          // V06-06/V08-06：外部喂了派生状态就按六态上色（§4.2）；**表里没有的节点如实标「无状态记录」**
          // （不再回落 v1 四色的「未开始/已完成」旧口径）；整张表为空时保持 A5 的四色口径不变。
          ...(Object.keys(statusOverrideRef.current).length > 0
            ? { displayStatus: statusOverrideRef.current[n.id] ?? NO_STATUS_RECORD_KEY }
            : {}),
          ...(n.aggregate === true && n.plan_origin === "plan" ? { aggregateNote: n.blurb } : {}),
          diff: !n.aggregate && diffIds.has(n.id),
          ...(diffById.has(n.id) ? { diffCategory: diffById.get(n.id)! } : {}),
          // F3：数据流向图给顶层节点标流向角色（属性标记，节点色仍 §4.2 四色）
          flowRole: n.flow_role,
          // N3：本次定位命中的节点 → 高亮（四色边框照旧 + 外侧定位光环）
          focused: focusedId === n.id,
          // V09-13：来源种类与证据状态（本层节点＝代码模块；标注取自同一份模型）。
          // 模型里查不到这个节点（如 A4 下钻的文件/子目录、聊天补全节点）⇒ 如实标"未映射/缺证"，
          // 不默认给绿、也不省略标注（§4.2）。
          provenance: (() => {
            const model = provenanceRef.current;
            if (model === null) return undefined;
            const a = model.by_object[planCodeNodeIdOf(n.id)] ?? model.by_object[n.id] ?? null;
            if (a === null) {
              return { source_kind: "未映射", evidence_state: "missing", evidence_label: "缺标注", user_pending: false };
            }
            return {
              source_kind: sourceKindLabelOf(a.source_kinds),
              evidence_state: a.evidence_state,
              evidence_label: evidenceShortOf(a.evidence_state),
              user_pending: a.user_pending,
              // §3.2 能力分类（2026-09-26 GPT-6 裁定 7）：治理章节分组在画布上带中性分类徽标
              capability_class: a.capability_class ?? null,
            };
          })(),
          onToggle: handleToggleRef.current,
          onLocateNode: locateNodeRef.current,
        },
      });
    }
    // A4 下钻子级（dir/file），按可见性过滤。
    // F4：子级坐标也**按视图分键**——本视图还没有那份局部重排坐标（例如在方框图里展开、刚切到数据流向图）
    // 时，就地按本视图的边方向重排这棵子树（§4.6 只动子树、不碰全局），不写回 state：同一份输入必得
    // 同一份输出，重渲染稳定。两图的边方向相反，各自那份坐标也就各自站得住。
    const storedSubtree = subtreePos[layoutKey] ?? {};
    const subtreeFallback: Record<string, NodePosition> = {};
    // Q120：DATA_FLOW 的兜底重排同样落到全图最右边界外侧；边界取**累计值**——本轮循环里
    // 前一棵已落位的子树坐标计入，两棵新子树不互叠（已存进 subtreePos 的子树经 pos 已在初始边界里）。
    let fallbackRightEdge = rightEdgeOf(pos);
    for (const [parentId, r] of Object.entries(childrenMap)) {
      if (r.children.length === 0 || r.children.every((c) => storedSubtree[c.id])) continue;
      const ids = r.children.map((c) => c.id);
      const anchor = pos[parentId] ?? EMPTY_POS;
      // V09-21 R4：MODULE_BOX 同样锚到全图最右边界外侧（见 handleToggle 注释）——锚在父节点右侧时，
      // 展开的文件节点卡片会盖住兄弟模块（src/src-tauri）的展开钮（F-B 实测 elementFromPoint 命中文件节点）。
      const laid = layoutSubtree(
        r.children.map((c) => ({ id: c.id, kind: c.kind })),
        renderEdgesOf(subtreeDeps(r.children), ids),
        { x: fallbackRightEdge, y: anchor.y },
        0,
      );
      for (const p of laid) {
        subtreeFallback[p.id] = { x: p.x, y: p.y };
        fallbackRightEdge = Math.max(fallbackRightEdge, p.x + NODE_WIDTH);
      }
    }
    const childPos = { ...subtreeFallback, ...storedSubtree, ...(userPosByMode[layoutKey] ?? {}) };
    for (const [, r] of Object.entries(childrenMap)) {
      for (const c of r.children) {
        if (!isVisible(c.id)) continue;
        nodes.push({
          id: c.id,
          type: "archNode",
          position: childPos[c.id] ?? { x: 0, y: 0 },
          draggable: true,
          data: {
            ...childNodeData(c, expanded[c.id] === true, expandBusy === c.id),
            flowRole: flowChild?.roles.get(c.id),
            focused: focusedId === c.id,
          },
        });
      }
    }
    const visibleIds = new Set(nodes.map((n) => n.id));
    const visibleEdges = allEdges.filter((e) => visibleIds.has(e.from) && visibleIds.has(e.to));
    // F3：边视觉唯一出处（色按 edgeColoring、粗细按 weightScale、双向虚线按 bidirectional）
    const edges: Edge[] = visibleEdges.map((e) => {
      const v = edgeVisualOf(mode, e, maxWeight);
      return {
        id: `${e.from}>${e.to}`,
        source: e.from,
        target: e.to,
        label: v.bidirectional ? `↔${e.weight}` : String(e.weight),
        labelStyle: { fill: "#a3a3a3", fontSize: 11 },
        labelBgStyle: { fill: "#171717", fillOpacity: 0.85 },
        style: {
          stroke: v.color,
          strokeWidth: v.strokeWidth,
          ...(v.bidirectional ? { strokeDasharray: BIDIRECTIONAL_DASH } : {}),
        },
        // 方向表达：箭头一律指向渲染方向的下游（MODULE_BOX = 依赖方向；DATA_FLOW = 提供者→消费者）
        markerEnd: { type: MarkerType.ArrowClosed, color: v.color, width: 14, height: 14 },
        ...(v.bidirectional
          ? { markerStart: { type: MarkerType.ArrowClosed, color: v.color, width: 14, height: 14 } }
          : {}),
        data: {
          "data-edge-color-role": e.color_role ?? "none",
          "data-edge-stroke": v.strokeWidth,
          "data-edge-bidirectional": v.bidirectional ? "1" : "0",
        },
      } as Edge;
    });

    const roles: Record<FlowRole, number> = { source: 0, relay: 0, sink: 0, isolated: 0 };
    for (const n of selection.nodes) roles[n.flow_role ?? "isolated"]++;
    const colors = {
      flow_source: visibleEdges.filter((e) => e.color_role === "flow_source").length,
      flow_relay: visibleEdges.filter((e) => e.color_role === "flow_relay").length,
      uncolored: visibleEdges.filter((e) => e.color_role === null).length,
    };
    const info: CanvasInfo = {
      mode,
      label: GRAPH_MODES[mode].label,
      nodes: nodes.length,
      edges: edges.length,
      stats: selection.stats,
      roles,
      colors,
      bidirectional: visibleEdges.filter((e) => e.bidirectional === true).length,
      strokeWidths: usedStrokeWidths(mode, visibleEdges, maxWeight),
      maxWeight,
    };
    return { nodes, edges, info };
  }, [
    graph,
    selection,
    childrenMap,
    expanded,
    parentOf,
    pos,
    subtreePos,
    userPosByMode,
    expandBusy,
    childNodeData,
    diffIds,
    focusedId,
    mode,
    renderEdgesOf,
  ]);
  flowRef.current = flow;

  // ── V09-22：画布内搜索（概览与全量通用）──────────────────────────────────────
  /** 命中项：当前图的节点 + 已缓存子级（childrenMap 展平），大小写不敏感子串匹配 label/id/path。
   *  概览态下被聚合的节点不在本图（`graph.truncated.nodes`），故计数行旁另有提示（见渲染处）。
   *  搜索**不代替「显示全部」**：要搜到被聚合节点需先点「显示全部」换成全量口径。 */
  const searchHits = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (q === "" || graph === null) return [] as { id: string; label: string; path: string }[];
    const seenIds = new Set<string>();
    const out: { id: string; label: string; path: string }[] = [];
    const hit = (id: string, label: string, path: string): boolean =>
      label.toLowerCase().includes(q) || id.toLowerCase().includes(q) || path.toLowerCase().includes(q);
    for (const n of graph.nodes) {
      if (!hit(n.id, n.name, n.path ?? "") || seenIds.has(n.id)) continue;
      seenIds.add(n.id);
      out.push({ id: n.id, label: n.name, path: n.path ?? "" });
    }
    for (const r of Object.values(childrenMap)) {
      for (const c of r.children) {
        if (!hit(c.id, c.name, c.path ?? "") || seenIds.has(c.id)) continue;
        seenIds.add(c.id);
        out.push({ id: c.id, label: c.name, path: c.path ?? "" });
      }
    }
    return out;
  }, [search, graph, childrenMap]);
  const activeIdx = searchHits.length > 0 ? ((hitIdx % searchHits.length) + searchHits.length) % searchHits.length : 0;
  const activeHitId = searchHits.length > 0 ? searchHits[activeIdx].id : null;
  /** 命中即复用 N3 定位机制：命中子级且祖先折叠时就地展开祖先链（零新请求，子级数据已在内存里），
   *  再 `setFocusedId`——既有的「目标节点出现即居中」effect 负责 setCenter 与高亮。 */
  useEffect(() => {
    if (usingOverride || activeHitId === null) return;
    const chain: string[] = [];
    for (let cur = parentOf[activeHitId]; cur; cur = parentOf[cur]) chain.unshift(cur);
    if (chain.length > 0) {
      setExpanded((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const p of chain) {
          if (next[p] !== true) {
            next[p] = true;
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }
    setFocusedId(activeHitId);
  }, [activeHitId, parentOf, usingOverride]);
  /** 下一个 / 上一个命中（Enter / Shift+Enter 与按钮共用） */
  const stepHit = useCallback(
    (delta: number) => {
      if (searchHits.length === 0) return;
      setHitIdx((i) => ((((i % searchHits.length) + delta) % searchHits.length) + searchHits.length) % searchHits.length);
    },
    [searchHits.length],
  );

  const onNodeDragStop = useCallback(
    (_: unknown, node: Node) => {
      const p = { x: node.position.x, y: node.position.y };
      // F4：拖动落进**本视图**的桶（切视图不去动另一视图的记录）
      setUserPosByMode((prev) => ({ ...prev, [layoutKey]: { ...(prev[layoutKey] ?? {}), [node.id]: p } }));
      scheduleSave(node.id, p);
    },
    [scheduleSave, mode],
  );

  // ── N3：定位（对齐键 = 共用层 module_id）────────────────────────────────────
  // 三条口径（PLAN N3 卡 DoD）：
  //  ① 只认 `locate.id`（共用层 module_id）——显示名只进提示文案，不参与任何查找（跑偏点红线）；
  //  ② 命中即"居中 + 高亮"（高亮的颜色同时体现模块四色状态，见 ArchNode 的 focused 分支）；
  //  ③ 定位**不动**任何落点：不写 `layout.json`（只有拖动才写）、不写折叠记忆。已加载但折叠着的枝
  //     只把**祖先链就地展开**（§3.3 规则 2 的原地展开，子级数据本来就在内存里），不发新解析请求。
  //  未命中（该 module_id 不在共用层、也没在方框图里展开过）→ 明确提示，不静默失败（DoD④）。
  const locateNonce = locate?.nonce ?? 0;
  // V09-22：fitKey 加 full 维度——全量模式首次拉取后补一次 fitView，全量图不沿用概览视口
  const fitKey = graph ? `${mode}:${graph.generated_at}${showAll ? ":full" : ""}` : "";
  locateDataRef.current = {
    sharedIds: new Set((graph?.nodes ?? []).map((n) => n.id)),
    loadedChildIds: new Set(Object.values(childrenMap).flatMap((r) => r.children.map((c) => c.id))),
    parentOf,
  };
  useEffect(() => {
    if (!locate || locateNonce === 0 || locateHandledRef.current === locateNonce) return;
    if (!graph) return; // 数据还没到：等 graph 就绪（graph 在依赖里）再处理这一次
    locateHandledRef.current = locateNonce;
    const snap = locateDataRef.current;
    const isShared = snap.sharedIds.has(locate.id);
    const isLoadedChild = !isShared && snap.loadedChildIds.has(locate.id);
    if (!isShared && !isLoadedChild) {
      setFocusedId(null);
      setLocateNote({
        state: "unmatched",
        text: unmatchedNote(locate, "共用层节点集合里没有它，方框图这边也没有展开过带它的枝"),
      });
      return;
    }
    if (isLoadedChild) {
      const chain: string[] = [];
      for (let cur = snap.parentOf[locate.id]; cur; cur = snap.parentOf[cur]) chain.unshift(cur);
      setExpanded((prev) => {
        const next = { ...prev };
        for (const p of chain) next[p] = true;
        return next;
      });
    }
    setFocusedId(locate.id);
    suppressFitRef.current = true; // 本次视口交给"居中"，别被下面的补 fitView 抢走
    setLocateNote({
      state: "matched",
      text: matchedNote(
        locate,
        isLoadedChild ? "已加载的枝：只就地展开祖先，零新解析、不写布局记忆" : "顶层模块（恒可见）",
      ),
    });
  }, [locate, locateNonce, graph]);

  // N3：目标节点一旦出现在本次渲染里就居中（zoom 归一，让"定位到这儿"看得清）。
  // 依赖只用布尔量 `focusedReady`：拖动/展开引起 flow 重算时不会把视口又抢回去。
  const focusedReady = focusedId !== null && (flow?.nodes.some((n) => n.id === focusedId) ?? false);
  useEffect(() => {
    if (!flowInstance || !focusedId || !focusedReady) return;
    let second = 0;
    const act = () => {
      const node = flowRef.current?.nodes.find((n) => n.id === focusedId);
      if (!node) return;
      const d = node.data as ArchNodeData;
      const w = d.isFile ? FILE_NODE_WIDTH : NODE_WIDTH;
      const h = d.isFile ? FILE_NODE_HEIGHT : NODE_HEIGHT;
      void flowInstance.setCenter(node.position.x + w / 2, node.position.y + h / 2, {
        zoom: 1,
        duration: 0,
      });
      suppressFitRef.current = false; // 视口已由定位归位，后面的 fit 照常
    };
    const first = requestAnimationFrame(() => {
      act();
      second = requestAnimationFrame(act);
    });
    return () => {
      cancelAnimationFrame(first);
      if (second) cancelAnimationFrame(second);
    };
  }, [flowInstance, focusedId, focusedReady, locateNonce, fitKey]);

  /** 视口补 fit 的就绪锚点：包 ReactFlow 的容器（`data-arch-view`）；容器被外层显隐（hidden）
   *  时尺寸为 0，此时 fitView 只能算出垃圾视口（V09-08 空白画布的实测根因之一） */
  const viewHostRef = useRef<HTMLDivElement | null>(null);
  /** 按 fitKey 记录「真正 fit 成功过」的那一批渲染数据：同一批数据只主动 fit 一次，
   *  不抢用户摆好的视口；定位接管（suppressFitRef）的键也视为已处置 */
  const fitDoneForKeyRef = useRef("");
  // F4 ②：切视图/加载完成后补一次 fitView。React Flow 的 `fitView` 属性只在画布挂载那一刻生效；
  // 本卡把两个视图收进同一个画布实例后，切视图时画布不重挂，视口会停在上一视图的位置上——
  // 节点落在视口外就是"画布空白"（F3 记为待观察的偶发）。
  // V09-08 收口（实测复现的完整链路）：画布与思维导图在同一宿主里显隐切换（ArchView 的
  // `hidden` 类名），「导图模式 → 切项目（数据在容器 0×0 时到位）→ 切回方框图」这条链上，
  // 双帧 fit 抢在「容器可见 + 节点测量完成」之前执行 ⇒ 算出垃圾边界 ⇒ 节点甩出视口 ⇒ 空白画布。
  // 因此从「固定两帧」改成**有界等待就绪**：每帧核「容器非零尺寸 且 本批节点全部量出尺寸」才 fit；
  // 约 3s 等不出来就挂起，交给下面的 ResizeObserver 在容器恢复可见时补 fit（两条路共用同一份就绪判据）。
  // `fitKey` 只认「视图 + 本次渲染数据」，拖动与折叠都不触发重新 fit（用户视口不被抢走）。
  // 展开是唯一例外，且只在「新节点落在视口外」时补一次（P-1，见下）；已在视口内则一点不动。
  // N3：定位请求与 fit 是**同一次视口动作的两种结果**，故共用本 effect 的依赖（`locateNonce`）——
  // 带着定位切视图时 fit 必须让路，否则刚居中的节点立刻被拉回全图。
  /** 就绪判据（两处共用）：容器非零尺寸 且 节点 DOM 全部量出非零尺寸。
   *  用 DOM 实情是因为用户看见的就是 DOM；不能信 `getNodes().measured`——
   *  公共节点对象不带测量值（V09-08 实测恒为 null），拿它当判据等于永不就绪。 */
  const canvasReady = () => {
    const host = viewHostRef.current;
    if (!host || host.clientWidth === 0 || host.clientHeight === 0) return false;
    const els = host.querySelectorAll(".react-flow__node");
    if (els.length === 0) return false;
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
    }
    return true;
  };
  useEffect(() => {
    if (!flowInstance || fitKey === "") return;
    if (suppressFitRef.current) {
      suppressFitRef.current = false; // 本次视口由上面的定位 effect 接管
      fitDoneForKeyRef.current = fitKey; // 本键视为已处置：容器恢复可见时也不再补 fit
      return;
    }
    let cancelled = false;
    let frames = 0;
    const tick = () => {
      if (cancelled) return;
      if (canvasReady()) {
        void flowInstance.fitView(fitOptions);
        // 沿用旧实现的双帧节奏补第二次：fitView 是异步队列消费（等 nodesInitialized/
        // updateNodeInternals），就绪瞬间个别节点的位置/尺寸可能刚落定，第二帧兜底
        // （f4 实测：只 fit 一次会有节点漏出视口）
        requestAnimationFrame(() => {
          if (!cancelled) void flowInstance.fitView(fitOptions);
        });
        fitDoneForKeyRef.current = fitKey;
        return;
      }
      if (++frames <= 180) requestAnimationFrame(tick); // 有界：≈3s，之后由可见性 observer 接管
    };
    requestAnimationFrame(tick);
    return () => {
      cancelled = true;
    };
  }, [flowInstance, fitKey, locateNonce]);

  // 容器从隐藏恢复可见（尺寸 0→非 0）时补 fit：只补「当前 fitKey 还没真正 fit 成功」的那次；
  // 已 fit 过的键、定位接管过的键都不再动（不抢用户视口）。隐藏期间 React Flow 内部的
  // 视口状态可能已被 0×0 尺寸同步写坏（实测 translate(NaN,NaN)→钳成 minZoom 垃圾），
  // fitView 用绝对值覆写视口，不读旧值，可把视口救回来。
  useEffect(() => {
    const host = viewHostRef.current;
    if (!flowInstance || !host || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (fitKey === "" || fitDoneForKeyRef.current === fitKey) return;
      if (!canvasReady()) return;
      fitDoneForKeyRef.current = fitKey;
      void flowInstance.fitView(fitOptions);
    });
    ro.observe(host);
    return () => ro.disconnect();
  }, [flowInstance, fitKey]);

  // P-1（2026-09-26）→ V09-20（2026-09-26 用户澄清）：展开后把视口补到能看见新节点——只在
  // **真有新节点落在视口外**时才动视口。
  // 背景：`layoutSubtree` 把子级排在父节点右侧、垂直居中于父节点；子级一多（如 scripts 的 40 个子级）
  // 这棵子树会向上/向下伸出当前视口，展开钮落在视口外就「看得见 DOM、点不着」。
  // **V09-20 改口径**：旧实现用整图 `fitView(FIT_VIEW_OPTIONS)` 把新子树连同整棵大树一起收进画布——
  // 实测展开 scripts 后 zoom 掉到 0.133（节点与控件只剩 2 px 级），"看得见"换成了"点不着"，而且
  // 用户的缩放被抢走。新实现按 §4.6：**只平移、不缩树**——
  //   · 只把**新长出来的那些节点**（父 + 子级）交给 `fitView` 的 `nodes` 作用域；
  //   · `minZoom = REVEAL_MIN_ZOOM`：当前缩放已在下限之上时 fitView 不会把它缩小（只重定位）；
  //   · `maxZoom = 当前缩放`：也**不放大**——放大同样等于抢用户视口（他刚摆好）；
  //   · 全在画布内 ⇒ **什么都不做**（原样保留）。
  // 折叠、拖动、切视图不置位，视口不动；有界等待（≈3s）等不出来就丢弃本次请求。
  useEffect(() => {
    if (!flowInstance || expandRevealRef.current === null) return;
    let cancelled = false;
    let frames = 0;
    const tick = () => {
      if (cancelled) return;
      const want = expandRevealRef.current;
      if (want === null) return;
      if (!canvasReady()) {
        // 容器不可见/尺寸为 0（如当前在另一视图）：有界等待；等不出来就**丢弃这次请求**，
        // 免得请求滞留到后面的拖动/重渲染里误动视口（拖动不该触发 fit）
        if (++frames <= 180) requestAnimationFrame(tick);
        else expandRevealRef.current = null;
        return;
      }
      const host = viewHostRef.current;
      if (!host) {
        expandRevealRef.current = null;
        return;
      }
      const present = new Set((flowRef.current?.nodes ?? []).map((n) => n.id));
      if (want.ids.some((id) => !present.has(id))) {
        // 新节点还没进这次渲染：等下一帧（节点数据一到就判）；同样有界，等不出来就丢弃
        if (++frames <= 180) requestAnimationFrame(tick);
        else expandRevealRef.current = null;
        return;
      }
      const rect = host.getBoundingClientRect();
      const outside = want.ids.some((id) => {
        const el = host.querySelector(`.react-flow__node[data-id="${CSS.escape(id)}"]`);
        if (el === null) return true;
        const r = el.getBoundingClientRect();
        return r.left < rect.left || r.top < rect.top || r.right > rect.right || r.bottom > rect.bottom;
      });
      expandRevealRef.current = null;
      if (!outside) return;
      // 视口口径（§4.6，V09-20）：把**本次新长出来的那棵子树**（父 + 子级）框进视口——
      //   · 它本来就在当前缩放下放得下 ⇒ fitView 算出的缩放 > 当前 ⇒ 被 `maxZoom` 钳回当前：
      //     **只平移，缩放一点不动**（用户的缩放与布局记忆不被抢）；
      //   · 放不下 ⇒ 缩到"刚好放下"，但**不低于可读下限** `REVEAL_MIN_ZOOM`（不把节点缩到点不着）；
      //   · **作用域只有这棵子树**，不再像旧实现那样把整棵大树一起重 fit（那会把 76 节点的全图缩到 0.133）。
      // 反缩放让控件在任何缩放下都是 16 屏幕 px，所以"看得见"与"点得着"不再互相牺牲。
      const current = flowInstance.getZoom();
      void flowInstance.fitView({
        ...FIT_VIEW_OPTIONS,
        nodes: want.ids.map((id) => ({ id })),
        // V09-21 R4：下限改硬下限（0.1）——小子树行为不变（maxZoom 钳回当前缩放，只平移）；
        // 大子树允许缩到「真能把整棵新子树框进视口」为止（反缩放保住展开钮命中区，见上常量注释）。
        minZoom: REVEAL_HARD_MIN_ZOOM,
        maxZoom: Math.max(REVEAL_MIN_ZOOM, current),
        duration: 220,
      });
    };
    requestAnimationFrame(tick);
    return () => {
      cancelled = true;
    };
  }, [flowInstance, flow?.nodes]);

  if (error && !graph) {
    // Q49（2026-09-18 审计）：报错不再"一行红字顶掉整张画布"——数据层没有任何可渲染的东西时
    // （首次拉取/解析失败）给一张错误卡，里面必须有出口：重试 = 重跑数据层（load）。
    // 已算出 graph 的情况走下面的**横幅**（画布留着，错误不报废整张图）。
    return (
      <div className="flex flex-1 items-center justify-center overflow-y-auto p-6">
        <div className="w-full max-w-xl space-y-3 rounded border border-neutral-800 bg-neutral-950 p-4">
          <p className="text-sm font-bold text-red-400">架构图加载失败</p>
          <p data-arch-error className="break-all text-xs text-neutral-400">
            {error}
          </p>
          <button
            data-arch-error-retry
            onClick={load}
            className="rounded border border-neutral-700 px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-800"
          >
            重试
          </button>
        </div>
      </div>
    );
  }
  if (exists === null) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-xs text-neutral-500">加载中…</p>
      </div>
    );
  }
  if (exists === false) {
    // 未解析引导态：先解析（arch/parse 后台 run），无 names 再 arch/name，完成后刷新渲染。
    // T19（§11.8）：进行中显示进度＋显式取消钮；取消后如实显示原因、给重发入口（旧结果保留——
    // 这里没有旧结果，exists 仍是 false，所以留在引导态而不是假装有图）。
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="space-y-3 text-center">
          <p className="text-sm text-neutral-300">这个项目还没有解析过架构</p>
          <p className="text-xs text-neutral-600">先做静态解析（tree-sitter），再给模块起人话名</p>
          {parseRun?.status === "running" ? (
            <div className="space-y-2" data-arch-parse-run="running">
              <p className="text-xs text-neutral-400" data-arch-parse-progress>
                {parseRunProgressText(parseRun)}
              </p>
              <p className="text-[11px] text-neutral-600">
                后台解析进行中，不阻塞其它操作；取消只来自显式动作（断连/刷新不取消，重连续看）
              </p>
              <button
                data-arch-parse-cancel
                onClick={handleParseCancel}
                className="rounded border border-neutral-700 px-4 py-1.5 text-xs text-neutral-200 hover:bg-neutral-800"
              >
                取消解析
              </button>
            </div>
          ) : busy ? (
            <p className="text-xs text-neutral-400">{busy}</p>
          ) : (
            <div className="space-y-2">
              {parseCancelNote && (
                <p data-arch-parse-cancel-note className="mx-auto max-w-md text-[11px] text-amber-300">
                  {parseCancelNote}
                </p>
              )}
              <button
                data-arch-parse-start
                onClick={handleParse}
                className="rounded border border-neutral-700 px-4 py-1.5 text-xs text-neutral-200 hover:bg-neutral-800"
              >
                {parseCancelNote ? "重新解析" : "先解析"}
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }
  if (!graph || !flow) return null;

  // V09-22：概览态扇出过滤丢弃数（第 4 招只服务概览防爆炸；全量模式 MAX_FANOUT 放开、该数为 0）
  const fanoutDropped =
    (graph.truncated.layers?.parse.fanout ?? 0) + (graph.truncated.layers?.merged.fanout ?? 0);
  // V09-22：本页仍被聚合/扇出过滤丢弃的对象数（隐藏对象抽屉的入口文案与可见判据）。
  // 入口只在**全量模式**且本数 >0 时出现（概览沿用既有「显示全部」入口，不新增抽屉入口）。
  const hiddenCount = graph.truncated.nodes + graph.truncated.edges + fanoutDropped;

  // Q133：模块集完整性三态——解析应答（本会话刚跑的那次）优先，其次落盘件标记；
  // null = 旧落盘件没标记（完整性未知），不许当成"扫完了"
  const budgetExhausted: boolean | null =
    parseStats?.budget_exhausted === true ? true : graph.budget_exhausted;

  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col"
      data-arch-mode={mode}
      // V09-22：概览/全量（显示全部）模式状态常驻可读
      data-arch-mode-state={showAll ? "full" : "overview"}
      data-arch-parse-calls={parseCalls}
      data-arch-data-loads={dataLoads}
      data-arch-expanded={Object.values(expanded).filter((v) => v === true).length}
      data-arch-focused={focusedId ?? ""}
      data-arch-locate-state={locateNote?.state ?? ""}
      // V09-13：交付阻断读数常驻可读（本层与三个主视图读同一份）
      data-arch-delivery={provenanceRef.current?.delivery.verdict ?? "none"}
      data-arch-delivery-conclusion={provenanceRef.current?.delivery.conclusion ?? ""}
    >
      {header?.(flow.info)}
      {/* V09-13（§3.2／§4.2）＋ V09-20 回归修复（§3.11，附录 E.20）：本层也显示**同一份**
          「来源与证据」信息栏（交付读数＋待审线索合成一条；健康态不占常驻行）——未映射/未验证/
          证据失效时**不给**「项目可交付」并逐条点名；与三个主视图、MCP 读口是同一份判据。
          复核项 H-4：系统架构主视图复用本画布时，页签容器（`ProjectGraphView`）**自己**已显示一份
          同源信息栏 ⇒ 用 `showDeliveryReadout={false}` 关掉这一份，免得同一屏出现两块
          （节点徽标照旧——那才是本屏缺的东西）。 */}
      {showDeliveryReadout && provenanceRef.current !== null && (
        <GraphAttentionBar
          delivery={provenanceRef.current.delivery}
          leads={provenanceRef.current.model_leads ?? []}
          nodeLeads={provenanceRef.current.model_node_leads ?? []}
          anchor={`tech-${mode}`}
          title="交付结论（实现分析层）"
        />
      )}
      {error && (
        // Q49：数据还在（graph 已算出）时错误不报废画布——顶部一条横幅说明"哪一步失败了"，
        // 给重试（重跑数据层）与关闭（只看画布，错误不拦截操作）两个出口。
        <div
          data-arch-error-banner={error}
          className="flex shrink-0 items-center gap-2 border-b border-red-500/40 bg-red-500/10 px-3 py-1.5 text-[11px] text-red-300"
        >
          <span className="min-w-0 flex-1 truncate" title={error}>
            架构图出错：{error}
          </span>
          <button
            data-arch-error-retry
            onClick={load}
            className="shrink-0 rounded border border-red-500/40 px-1.5 py-0.5 hover:bg-red-500/20"
          >
            重试
          </button>
          <button
            data-arch-error-dismiss
            onClick={() => setError(null)}
            className="shrink-0 rounded border border-neutral-700 px-1.5 py-0.5 text-neutral-300 hover:bg-neutral-800"
          >
            关闭
          </button>
        </div>
      )}
      {/* T19（§11.8）：解析 run 运行态条——进度＋显式取消钮（一条横幅，不阻塞画布与页面其它操作） */}
      {parseRun?.status === "running" && (
        <div
          data-arch-parse-run="running"
          className="flex shrink-0 items-center gap-2 border-b border-sky-500/40 bg-sky-500/10 px-3 py-1.5 text-[11px] text-sky-200"
        >
          <span className="min-w-0 flex-1 truncate" data-arch-parse-progress title={parseRunProgressText(parseRun)}>
            {parseRunProgressText(parseRun)}
          </span>
          <button
            data-arch-parse-cancel
            onClick={handleParseCancel}
            className="shrink-0 rounded border border-sky-500/40 px-1.5 py-0.5 hover:bg-sky-500/20"
          >
            取消解析
          </button>
        </div>
      )}
      {/* T19：显式取消的如实说明（未完成原因＋旧结果保留口径），重发入口就在这条上（§11.8 取消后可重试） */}
      {parseRun?.status !== "running" && parseCancelNote && (
        <div
          className="flex shrink-0 items-center gap-2 border-b border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-300"
        >
          <span className="min-w-0 flex-1" data-arch-parse-cancel-note>
            {parseCancelNote}
          </span>
          <button
            data-arch-parse-retry
            onClick={handleParse}
            className="shrink-0 rounded border border-amber-500/40 px-1.5 py-0.5 hover:bg-amber-500/20"
          >
            重新解析
          </button>
        </div>
      )}
      {/* V09-22：画布内搜索（仅技术详情两图；概览与全量通用）——搜索**不代替「显示全部」**：
          概览态下被聚合的节点不在本图，计数行旁如实提示（`data-arch-search-note`）。
          Enter=下一个 / Shift+Enter=上一个（原生 input 键盘）；命中即复用 N3 定位机制（展开祖先链 + setFocusedId）。 */}
      {!usingOverride && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-neutral-800 px-3 py-1 text-[11px]">
          <input
            data-arch-search
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setHitIdx(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                stepHit(e.shiftKey ? -1 : 1);
              }
            }}
            placeholder="搜索节点名 / id / 路径（含全量模式节点）…"
            className="w-64 rounded border border-neutral-700 bg-neutral-950 px-2 py-0.5 text-[11px] text-neutral-200"
          />
          <span
            data-arch-search-count={searchHits.length > 0 ? `${activeIdx + 1}/${searchHits.length}` : "0"}
            className="text-neutral-400"
          >
            {search.trim() === "" ? "" : searchHits.length === 0 ? "无匹配" : `${activeIdx + 1}/${searchHits.length}`}
          </span>
          <button
            data-arch-search-prev
            onClick={() => stepHit(-1)}
            disabled={searchHits.length === 0}
            className="rounded border border-neutral-700 px-1.5 py-0.5 text-neutral-300 hover:bg-neutral-800 disabled:opacity-40"
          >
            上一个
          </button>
          <button
            data-arch-search-next
            onClick={() => stepHit(1)}
            disabled={searchHits.length === 0}
            className="rounded border border-neutral-700 px-1.5 py-0.5 text-neutral-300 hover:bg-neutral-800 disabled:opacity-40"
          >
            下一个
          </button>
          {!showAll && graph.truncated.nodes > 0 && (
            <span data-arch-search-note className="text-neutral-500">
              （被聚合节点不在本图，点「显示全部」后可搜）
            </span>
          )}
        </div>
      )}
      {/* V09-22：渲染上限行——概览态原文案 + 扇出丢弃数 + 「显示全部」；全量态一行说明 + 「返回概览」。
          仅 !usingOverride（技术详情两图）可用这些入口；主视图（override）没有此模式。 */}
      {!usingOverride &&
        (showAll ? (
          <p
            className="shrink-0 border-b border-neutral-800 px-3 py-1 text-[11px] text-neutral-500"
            data-arch-full-note
          >
            全量模式：{graph.nodes.length} 节点 / {graph.edges.length} 边（上限 {graph.limits.MAX_NODES}/
            {graph.limits.MAX_EDGES}，扇出过滤已关闭
            {graph.truncated.nodes > 0 || graph.truncated.edges > 0
              ? `，仍聚合 ${graph.truncated.nodes} 节点/${graph.truncated.edges} 边`
              : ""}
            ）
            <button
              data-arch-show-overview
              onClick={() => setShowAll(false)}
              className="ml-2 rounded border border-neutral-700 px-1.5 py-0.5 text-neutral-300 hover:bg-neutral-800"
            >
              返回概览
            </button>
            {/* V09-22：本页仍有被聚合/扇出过滤丢弃的对象时，给一个逐项取回的入口（原生 button，Tab/Enter 可用）。
                只在全量模式出现——未聚合并集读口（/arch/items）不依赖渲染上限，概览态沿用「显示全部」即可。 */}
            {hiddenCount > 0 && (
              <button
                data-arch-hidden-items
                onClick={() => setHiddenOpen((v) => !v)}
                title="逐项查看本页仍被聚合/扇出过滤丢弃的对象（未聚合并集：可搜索、可翻页、可点开详情）"
                className="ml-2 rounded border border-neutral-700 px-1.5 py-0.5 text-neutral-300 hover:bg-neutral-800"
              >
                查看被聚合对象（{hiddenCount}）
              </button>
            )}
          </p>
        ) : graph.truncated.nodes > 0 || graph.truncated.edges > 0 || fanoutDropped > 0 ? (
          <p className="shrink-0 border-b border-neutral-800 px-3 py-1 text-[11px] text-neutral-500">
            已达渲染上限/扇出阈值（{graph.limits.MAX_NODES} 节点 / {graph.limits.MAX_EDGES} 边 / 扇出入边上限{" "}
            {graph.limits.MAX_FANOUT}）：聚合{" "}
            {graph.truncated.nodes} 节点、截断 {graph.truncated.edges} 边
            {fanoutDropped > 0 ? `、扇出过滤丢弃 ${fanoutDropped} 条` : ""}
            <button
              data-arch-show-all
              title="放开渲染上限：列出全部节点与边（大图布局会变慢）；采集侧 budget_exhausted 时仍如实标注"
              onClick={() => setShowAll(true)}
              className="ml-2 rounded border border-neutral-700 px-1.5 py-0.5 text-neutral-300 hover:bg-neutral-800"
            >
              显示全部
            </button>
          </p>
        ) : null)}
      {/* Q133：采集侧的完整性——与上面那条渲染上限**不是一回事**（那条是节点被聚合，这条是节点本来就少）。
          到点收工的残缺集刷新/重启后照样在这里说，不靠"用户还记得解析慢"。
          V06-06：喂了外部数据层（三个主视图的系统架构）时不显示——那两份说明讲的是**静态解析层**，
          那个视图的权威来源是规划图，画在这儿只会让人以为"规划图残缺"。 */}
      {!usingOverride && budgetExhausted === true && (
        <p
          data-arch-budget-note="exhausted"
          className="shrink-0 border-b border-amber-500/40 bg-amber-500/10 px-3 py-1 text-[11px] text-amber-300"
        >
          ⚠ 上次解析到点收工（遍历/解析预算用尽）：这份模块集只有已扫到的部分，
          <span className="font-semibold">不是全量</span>
          ——看全图请再解析一次（图上的缺枝就是没扫完，不是项目里没有）。
        </p>
      )}
      {!usingOverride && budgetExhausted === null && (
        <p
          data-arch-budget-note="unknown"
          className="shrink-0 border-b border-neutral-800 px-3 py-1 text-[11px] text-neutral-500"
        >
          这份模块集产自未带完整性标记的旧版解析：有没有扫完未知，建议再解析一次。
        </p>
      )}
      {/* A5 对账面板（§4.5）：汇总一行 + 差异单条平铺（未决项 #4 结论：条数在十位数级，
          单条平铺直接可读，不必折叠成纯汇总）；差异是信号不是错误。
          F3：两视图共用同一份面板（对账与视图模式无关）。
          V06-06：被喂了外部数据层（三个主视图的系统架构）时不显示这个面板——
          那份数据可能根本没有静态解析结果，面板在这儿只是噪音，且它与主视图的口径无关。
          V09-08 ③（附录 E.7 裁定④）：`only_in_code` **分类分计、分别命名**——
          真差异才叫「对账差」，口径边界（范围外/结构性目录）各用自己的词；原始事实（逐条名单）照旧列出。
          V09-20（§3.11，2026-09-26 用户澄清）：**汇总两行常显**（计数 + 分类分计 —— 「差异是信号不是错误」
          这句口径句就在这两行里），**长解释与逐条名单进「对账明细」按需展开**（限高、内部滚动）：
          技术详情的长对账说明不再平铺占掉画布。判据不变、数据不删（名单仍在 DOM 里，DOM 计数断言照旧）。 */}
      {!usingOverride && (
      <div className="shrink-0 border-b border-neutral-800 px-3 py-1.5 text-[11px]" data-reconcile-panel>
        {reconcile ? (
          <div className="space-y-1">
            <p className="text-neutral-400">
              对账（{reconcile.generated_at.slice(0, 19).replace("T", " ")} ·{" "}
              {reconcile.trigger}）：设计书有代码没有{" "}
              <span className="text-yellow-300">{reconcile.only_in_design.length}</span> 项 ·
              代码有设计书没有{" "}
              <span className="text-neutral-200">{reconcile.only_in_code.length}</span> 项 · 一致{" "}
              {reconcile.matched.length} 项
              <span className="text-neutral-600">（差异是信号，不是错误 §4.5）</span>
              {/* V08-02 C3：对账的**置信度**要摆出来——"看上号"的两条路不等价：
                  材料点名**实现落点**的才是可定位的实现映射；只点到"落点"的算未证实；
                  名字信号是**文本匹配**，只算待核实。 */}
              <span data-reconcile-confidence className="ml-2 text-neutral-500">
                （配对依据：实现落点{" "}
                {matchedByVia.implementation} 项 ·{" "}
                <span className="text-amber-300/80">
                  章节落点未证实 {matchedByVia.locator_unverified} 项（不继承状态色）
                </span>{" "}
                · 名字信号{" "}
                <span className="text-amber-300/80">
                  {matchedByVia.name_signal} 项（文本匹配，待核实）
                </span>
                {reconcile.design_modules.some((d) => d.confidence === "low") ? " · 含低置信章节提取" : ""}）
              </span>
              <button
                onClick={runReconcile}
                disabled={reconcileBusy}
                className="ml-2 rounded border border-neutral-700 px-1.5 py-0.5 text-neutral-300 hover:bg-neutral-800 disabled:opacity-50"
              >
                {reconcileBusy ? "对账中…" : "重跑对账"}
              </button>
            </p>
            {/* V09-08 ③：分类分计（同一份共享判据的产物 + **同一份渲染**，逐条点名 + 各自给一句话） */}
            <ReconcileCats entries={reconcile.only_in_code} anchor="data-reconcile-only-in-code-cats" />
            {reconcile.only_in_design.length + reconcile.only_in_code.length > 0 && (
              // V09-20（§3.11）：长解释与两个逐条名单进「对账明细」按需展开（限高 + 内部滚动）。
              // 默认可见的是上面两行（计数 + 分类分计），「差异是信号不是错误」的口径句就在里面。
              <details data-reconcile-detail>
                <summary className="cursor-pointer text-neutral-400">
                  对账明细：口径差异说明与两侧逐条名单（
                  {reconcile.only_in_design.length + reconcile.only_in_code.length} 项）
                </summary>
                <div className="mt-0.5 max-h-48 space-y-0.5 overflow-y-auto pl-2">
              <div className="flex flex-wrap gap-x-6 gap-y-0.5">
                <p className="w-full text-neutral-500">
                  两侧口径不同时（声明侧能力/功能名 vs 代码侧目录模块）这些差异里有一部分是**契约缺口**——
                  "材料没点名路径"不等于"设计过时/代码跑偏"，逐条读名单再判（§4.5 差异是信号）。
                </p>
                {reconcile.only_in_design.length > 0 && (
                  <p className="text-yellow-200/90" data-diff-list="only_in_design">
                    设计书有代码没有（设计过时或未实现）：
                    {reconcile.only_in_design.map((d) => d.name).join("、")}
                  </p>
                )}
                {reconcile.only_in_code.length > 0 && (
                  // 原始事实照旧（逐条名单；分类是解释，不改名单）——verify-a5 从这个元素读第 1 条
                  <p className="text-neutral-200" data-diff-list="only_in_code">
                    代码有设计书没有（逐条照录，分类见上一行）：
                    {groupedOnlyInCode.actionable_mismatch.length > 0 && (
                      <span className="text-yellow-200/90">
                        真差异 {groupedOnlyInCode.actionable_mismatch.map((c) => c.name).join("、")}
                        {groupedOnlyInCode.outside_scope.length +
                          groupedOnlyInCode.structural.length +
                          groupedOnlyInCode.unclassified.length >
                        0
                          ? "；"
                          : ""}
                      </span>
                    )}
                    {groupedOnlyInCode.outside_scope.length > 0 && (
                      <span className="text-neutral-400">
                        范围外 {groupedOnlyInCode.outside_scope.map((c) => c.name).join("、")}
                        {groupedOnlyInCode.structural.length + groupedOnlyInCode.unclassified.length > 0 ? "；" : ""}
                      </span>
                    )}
                    {groupedOnlyInCode.structural.length > 0 && (
                      <span className="text-neutral-400">
                        结构性目录 {groupedOnlyInCode.structural.map((c) => c.name).join("、")}
                        {groupedOnlyInCode.unclassified.length > 0 ? "；" : ""}
                      </span>
                    )}
                    {groupedOnlyInCode.unclassified.length > 0 && (
                      <span className="text-amber-300/80">
                        未分类（旧对账结果，请重跑对账）{" "}
                        {groupedOnlyInCode.unclassified.map((c) => c.name).join("、")}
                      </span>
                    )}
                  </p>
                )}
              </div>
                </div>
              </details>
            )}
          </div>
        ) : (
          <p className="text-neutral-600">
            还没跑过对账（设计书模块清单 ↔ 代码模块，§4.5）
            <button
              onClick={runReconcile}
              disabled={reconcileBusy}
              className="ml-2 rounded border border-neutral-700 px-1.5 py-0.5 text-neutral-300 hover:bg-neutral-800 disabled:opacity-50"
            >
              {reconcileBusy ? "对账中…" : "跑一次对账"}
            </button>
          </p>
        )}
      </div>
      )}
      {/* N3 定位提示（DoD④）：命中留一行痕（显示名与对齐用的 id 摆在一起），未命中明说"在哪个视图无对应" */}
      {locateNote && (
        <p
          className={`shrink-0 border-b border-neutral-800 px-3 py-1 text-[11px] ${
            locateNote.state === "matched" ? "text-cyan-200" : "text-amber-300"
          }`}
          data-arch-locate-note={locateNote.text}
          data-arch-locate-state={locateNote.state}
        >
          {locateNote.text}
        </p>
      )}
      <div
        className="min-h-0 flex-1"
        data-arch-view
        ref={viewHostRef}
        onKeyDown={(e) => {
          // V09-22：键盘也能打开节点详情——Enter 且焦点在 `.react-flow__node` 内元素时，触发与
          // `onNodeClick` 相同的回调（按钮/输入框是原生元素，Tab/Enter/Space 天然可用）。
          if (e.key !== "Enter") return;
          const active = document.activeElement;
          if (!(active instanceof Element)) return;
          const id = active.closest(".react-flow__node")?.getAttribute("data-id");
          if (id === null || id === undefined) return;
          const d = flowRef.current?.nodes.find((n) => n.id === id)?.data as ArchNodeData | undefined;
          if (d === undefined) return;
          e.preventDefault();
          onNodeClickRef.current?.({ id, label: d.label, path: d.path });
        }}
      >
        <ReactFlow
          nodes={flow.nodes}
          edges={flow.edges}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={fitOptions}
          minZoom={FIT_MIN_ZOOM}
          nodesConnectable={false}
          onInit={setFlowInstance}
          onNodeDragStop={onNodeDragStop}
          onNodeDoubleClick={(_, node) => {
            const d = node.data as ArchNodeData;
            if (d.expandable) handleToggleRef.current(node.id);
          }}
          // V06-06：单击选中/打开详情（只在外部给了回调时生效；不给 = A3 起无单击行为）
          onNodeClick={(_, node) => {
            const d = node.data as ArchNodeData;
            onNodeClickRef.current?.({ id: node.id, label: d.label, path: d.path });
          }}
          colorMode="dark"
        >
          <Background gap={20} color="#262626" />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
      {/* V09-22（契约 1）：隐藏对象抽屉——全量模式下把被聚合/扇出过滤丢弃的对象逐项取回（未聚合并集读口，
          可搜索、可翻页、可点开详情）。根节点常驻 DOM（关闭时 display:none），入口只在全量模式且本页
          仍有隐藏对象时出现；换项目/切模式由上面的重置 effect 关闭并清空列表与详情。 */}
      {!usingOverride && showAll && hiddenCount > 0 && (
        <div
          data-arch-hidden-drawer
          className={
            hiddenOpen
              ? "absolute right-2 top-10 z-10 flex max-h-[70%] w-[440px] flex-col overflow-hidden rounded-lg border border-neutral-700 bg-neutral-900/95 text-[11px] shadow-xl"
              : "hidden"
          }
        >
          <div className="flex shrink-0 items-center gap-2 border-b border-neutral-800 px-3 py-1.5">
            <span className="font-semibold text-neutral-200" data-arch-hidden-count={`共 ${hiddenPage.total} 个对象`}>
              共 {hiddenPage.total} 个对象
            </span>
            <nav className="flex gap-1" data-arch-hidden-kinds>
              {HIDDEN_KINDS.map((k) => (
                <button
                  key={k.value}
                  data-arch-hidden-kind-tab={k.value}
                  onClick={() => setHiddenKind(k.value)}
                  className={`rounded px-2 py-0.5 ${
                    hiddenKind === k.value
                      ? "border border-neutral-700 bg-neutral-800 text-neutral-100"
                      : "text-neutral-500 hover:text-neutral-300"
                  }`}
                >
                  {k.label}
                </button>
              ))}
            </nav>
            <button
              data-arch-hidden-close
              onClick={() => setHiddenOpen(false)}
              className="ml-auto rounded border border-neutral-700 px-1.5 py-0.5 text-neutral-300 hover:bg-neutral-800"
            >
              关闭
            </button>
          </div>
          <div className="shrink-0 border-b border-neutral-800 px-3 py-1.5">
            <input
              data-arch-hidden-search
              value={hiddenQueryInput}
              onChange={(e) => setHiddenQueryInput(e.target.value)}
              placeholder="搜索 id / 名字 / 路径（大小写不敏感子串）…"
              className="w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-0.5 text-[11px] text-neutral-200"
            />
          </div>
          {hiddenError && (
            <p
              data-arch-hidden-error
              className="shrink-0 border-b border-red-500/40 bg-red-500/10 px-3 py-1 text-red-300"
            >
              读取被聚合对象失败：{hiddenError}
            </p>
          )}
          <ul data-arch-hidden-list className="min-h-0 flex-1 overflow-y-auto px-2 py-1">
            {hiddenRows.map((row, i) =>
              hiddenKind === "nodes" ? (
                <li key={`n:${(row as SharedModuleNode).id}:${i}`}>
                  <button
                    type="button"
                    data-arch-hidden-item={(row as SharedModuleNode).id}
                    onClick={() => openHiddenDetail({ kind: "node", node: row as SharedModuleNode })}
                    className="flex w-full flex-col rounded px-1.5 py-1 text-left hover:bg-neutral-800"
                  >
                    <span className="truncate text-neutral-200">{(row as SharedModuleNode).name}</span>
                    <span className="truncate text-[10px] text-neutral-500">
                      {(row as SharedModuleNode).id}
                      {(row as SharedModuleNode).path ? ` · ${(row as SharedModuleNode).path}` : ""}
                      {(row as SharedModuleNode).aggregate === true ? " · 聚合" : ""}
                    </span>
                  </button>
                </li>
              ) : (
                <li key={`e:${(row as SharedGraphEdge).from}>${(row as SharedGraphEdge).to}:${i}`}>
                  <button
                    type="button"
                    data-arch-hidden-item={`${(row as SharedGraphEdge).from}>${(row as SharedGraphEdge).to}`}
                    onClick={() => openHiddenDetail({ kind: "edge", edge: row as SharedGraphEdge })}
                    className="flex w-full flex-col rounded px-1.5 py-1 text-left hover:bg-neutral-800"
                  >
                    <span className="truncate text-neutral-200">
                      {(row as SharedGraphEdge).from} → {(row as SharedGraphEdge).to}
                    </span>
                    <span className="truncate text-[10px] text-neutral-500">
                      权重 {(row as SharedGraphEdge).weight}
                      {(row as SharedGraphEdge).origin === "plan" ? " · 规划层" : ""}
                    </span>
                  </button>
                </li>
              ),
            )}
          </ul>
          <div className="flex shrink-0 items-center gap-2 border-t border-neutral-800 px-3 py-1.5 text-neutral-500">
            <span data-arch-hidden-shown>
              {hiddenBusy ? "加载中…" : `已显示 ${hiddenRows.length} / ${hiddenPage.total}`}
            </span>
            {hiddenPage.has_more && (
              <button
                data-arch-hidden-more
                onClick={loadMoreHidden}
                disabled={hiddenBusy}
                className="ml-auto rounded border border-neutral-700 px-1.5 py-0.5 text-neutral-300 hover:bg-neutral-800 disabled:opacity-40"
              >
                加载更多
              </button>
            )}
          </div>
        </div>
      )}
      {/* V09-22：抽屉行点开的对象详情（对象与 render 节点/边同构：来源/证据等既有字段照常）。
          抽屉保持打开；面板是浮层、限高可滚，不遮死画布。 */}
      {detailObject !== null && (
        <div
          data-arch-detail
          className="absolute left-2 top-10 z-10 flex max-h-[60%] w-[360px] flex-col overflow-y-auto rounded-lg border border-neutral-700 bg-neutral-900/95 p-3 text-[11px] shadow-xl"
        >
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate font-semibold text-neutral-200">
              {detailObject.kind === "node"
                ? detailObject.node.name
                : `${detailObject.edge.from} → ${detailObject.edge.to}`}
            </span>
            <button
              data-arch-detail-close
              onClick={() => setDetailObject(null)}
              className="shrink-0 rounded border border-neutral-700 px-1.5 py-0.5 text-neutral-300 hover:bg-neutral-800"
            >
              关闭
            </button>
          </div>
          {detailObject.kind === "node" ? (
            <dl className="mt-2 space-y-1 text-neutral-400">
              <div className="flex gap-2">
                <dt className="shrink-0 text-neutral-500">id</dt>
                <dd className="min-w-0 break-all text-neutral-200">{detailObject.node.id}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="shrink-0 text-neutral-500">名字</dt>
                <dd className="min-w-0 break-all text-neutral-200">{detailObject.node.name}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="shrink-0 text-neutral-500">路径</dt>
                <dd className="min-w-0 break-all text-neutral-200">{detailObject.node.path || "（无）"}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="shrink-0 text-neutral-500">类型</dt>
                <dd className="min-w-0 text-neutral-200">{detailObject.node.kind}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="shrink-0 text-neutral-500">文件数</dt>
                <dd className="min-w-0 text-neutral-200">{detailObject.node.file_count}</dd>
              </div>
              {detailObject.node.status && (
                <div className="flex gap-2">
                  <dt className="shrink-0 text-neutral-500">状态</dt>
                  <dd className="min-w-0 text-neutral-200">{detailObject.node.status}</dd>
                </div>
              )}
              {detailObject.node.aggregate === true && (
                <p className="text-neutral-500">聚合节点：不是可对账对象、不进来源/证据标注（§3.3）</p>
              )}
              {(() => {
                // V09-13：来源与证据标注（与画布节点、三个主视图、MCP 读口同一份判据/模型）
                const model = provenanceRef.current;
                const a =
                  model === null
                    ? null
                    : (model.by_object[planCodeNodeIdOf(detailObject.node.id)] ??
                      model.by_object[detailObject.node.id] ??
                      null);
                return a === null ? (
                  <p className="text-neutral-500">来源/证据：未映射（该对象没有来源与证据标注）</p>
                ) : (
                  <>
                    <div className="flex gap-2">
                      <dt className="shrink-0 text-neutral-500">来源</dt>
                      <dd className="min-w-0 text-neutral-200">{sourceKindLabelOf(a.source_kinds)}</dd>
                    </div>
                    <div className="flex gap-2">
                      <dt className="shrink-0 text-neutral-500">证据</dt>
                      <dd
                        data-arch-detail-evidence={a.evidence_state}
                        className="min-w-0 text-neutral-200"
                      >
                        {evidenceShortOf(a.evidence_state)}
                        {a.user_pending ? " · 用户待验" : ""}
                      </dd>
                    </div>
                  </>
                );
              })()}
            </dl>
          ) : (
            <dl className="mt-2 space-y-1 text-neutral-400">
              <div className="flex gap-2">
                <dt className="shrink-0 text-neutral-500">from</dt>
                <dd className="min-w-0 break-all text-neutral-200">{detailObject.edge.from}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="shrink-0 text-neutral-500">to</dt>
                <dd className="min-w-0 break-all text-neutral-200">{detailObject.edge.to}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="shrink-0 text-neutral-500">权重</dt>
                <dd className="min-w-0 text-neutral-200">{detailObject.edge.weight}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="shrink-0 text-neutral-500">来源</dt>
                <dd className="min-w-0 text-neutral-200">
                  {detailObject.edge.origin === "plan" ? "规划层（审定图纸派生）" : "静态 import 聚合边"}
                </dd>
              </div>
            </dl>
          )}
        </div>
      )}
    </div>
  );
}

/** A4 子级的依赖边（依赖方向：子级 import 出去的目标；与 A1 聚合边同一方向口径） */
function subtreeDeps(children: ExpandChild[]): GraphEdge[] {
  return children.flatMap((c) => c.deps.map((d) => ({ from: c.id, to: d.to, weight: d.weight })));
}

/** T19：进行中 run 的一行进度文案（遍历/解析两阶段如实分开；source_files 遍历完才知道） */
function parseRunProgressText(run: ParseRun): string {
  const p = run.progress;
  if (p.phase === "walking") {
    return `正在解析项目结构（后台可取消）：遍历文件中…已遍历 ${p.walked_files} 个`;
  }
  const total = p.source_files !== null ? `/${p.source_files}` : "";
  return `正在解析项目结构（后台可取消）：已解析 ${p.parsed_files}${total} 个源码文件`;
}

/** T19：取消原因的如实文案。§11.8「取消只来自显式取消动作」⇒ status=cancelled 的原因就是
 *  用户点了「取消解析」——由 run 现场（进度 + finished_at）生成，刷新后 GET 回来同样说得清。 */
function cancelNoteOf(run: ParseRun): string {
  const at = run.finished_at ? run.finished_at.slice(11, 19) : "（时间未知）";
  const p = run.progress;
  const done = p.source_files !== null ? `${p.parsed_files}/${p.source_files}` : `${p.parsed_files}`;
  return (
    `上次解析已于 ${at} 被显式取消（取消时已解析 ${done} 个源码文件）：` +
    `未完成的部分结果未写入，当前沿用上次完整落盘状态（可能已过期）。`
  );
}
