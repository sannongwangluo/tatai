// N1：思维导图视图（DESIGN.md §3.2 三视图第三行「层级结构一览，适合快速总览与折叠」）。
// 渲染用 markmap（markmap-lib 的 Transformer 把 markdown 解析成树，markmap-view 画进 SVG），
// **数据不另起炉灶**（PLAN N1 跑偏点）：
//   ① 顶层与层级边 = 共用数据层：`buildMindTree`（`src/arch/mindmap.ts`）就是 MIND_MAP 的唯一取数口，
//      内部只按模式键走 F2 选择器；节点集合与方框图逐 id 相同，硬上限/聚合也随 `graph.limits` 同一份
//      ——本文件不 import config.ts，不写第二套上限，本文件也不自己调选择器（视图层唯一消费点仍在
//      ArchCanvas：verify-f2 的源码级红线扫的就是这条，故此处连字符串都不写出来）；
//   ② 更深的层级（子模块 → 文件）= 点节点懒加载 A4 的 arch/expand 接口（服务端唯一解析入口，
//      本文件不扫目录、不解析源码）——§4.3 第 2 招：展开哪一枝才解析哪一枝。
//      巨枝（超 A4 子级上限）由服务端截断成一个「还有 N 个」聚合节点，本文件当普通叶子画。
//
// N2（本卡）在 N1 基础上加三件事：
//   ① **默认全折叠 + 逐级折叠**（§3.3 规则 4/5）：折叠态由本组件持有（`expanded`，唯一出处），
//      每个 markmap 节点的 `payload.fold` 由它算出来（`foldOf`）——markmap 自己那套点击翻转
//      （`toggleNode`）在捕获阶段被拦掉（`e.stopPropagation()`），否则它翻完的状态在本组件里读不回来，
//      也就没法落盘。未加载的枝点一下就懒加载并展开；已加载的枝点一下只切折叠态（零请求）。
//   ② **展开态刷新后保持**（DoD④）：`expanded` 立刻落盘 `<项目根>/.工作台/arch/mindmap-fold.json`
//      （`src/arch/foldStore.ts`，经 GET/PUT arch/mindmap-fold）。重进/刷新时按落盘的清单**只补拉
//      那几枝**（`data-mindmap-loads` 只涨清单条数）——不是全量，未展开过的枝一个请求都不发。
//   ③ **懒加载与巨型枝的证据**（DoD②③）：每枝展开的耗时/子级数/截断量进 `data-mindmap-load-log`
//      （JSON，验证脚本逐条读），并在控制台留一行；服务端 `[arch/expand]` 一行一请求，
//      "未展开分支零解析"由"没点开的枝一行日志都没有"直接对照。
//
// N3（本卡加在导图上的事）：与方框图 / 数据流向图**双向定位**（PLAN N3 卡，DESIGN.md §3.2/§3.3）——
//   ① 每个可见节点右侧补两个入口（方框图 / 数据流向图，`data-mm-locate`）：点它 = 请求切到目标
//      视图并定位**同一个 module_id**。浮层是原生 SVG（不是 React 子树），且**不带文字节点**——
//      带了会改掉节点 g 的文本，N2 那些"按整行文字定位节点"的脚本会跟着失效；
//   ② 收到 `locate` 请求（从方框图/流向图来的）→ 祖先链就地展开到可见（只动内存里的折叠态）
//      + 居中 + 高亮（内环色 = 该节点的**上屏状态色**，v2 派生键优先、色值出自 `statusColor.ts` 一份）；
//   ③ 对齐键只认 module_id：显示名只进提示文案（会被 Flash 重命名）；未命中 → `data-mindmap-locate-note` 明说；
//   ④ 定位**不写** `mindmap-fold.json`、不动布局记忆（DoD③：定位前后两份文件逐字节不变）。
// 树的 markdown 导出（`toMarkdown`）就是 markmap 的输入本身：本文件把它同时显示在界面上，
// 每行带 `id/path/files/from` 注释 → 可逐行回查 A1 落盘的模块清单与 A4 子级（N1 DoD④ 可追溯）。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Markmap } from "markmap-view";
import { Transformer } from "markmap-lib/no-plugins";
import type { ExpandChild, ExpandResult } from "../../arch/expand";
import type { MindMapExpandEntry } from "../../arch/foldStore";
import {
  buildMindTree,
  isDrillable,
  toMarkdown,
  type MindTree,
  type MindTreeNode,
} from "../../arch/mindmap";
import type { SharedGraph } from "../../arch/shared-graph";
import {
  getArchMindMapFold,
  getArchRender,
  postArchExpand,
  putArchMindMapFold,
  type ProjectItem,
} from "../api";
import { matchedNote, unmatchedNote, type LocateRequest } from "./locate";
import { isDrawableBox, isFiniteRect } from "./mindmapGeometry";
import { ReconcileCats } from "./ReconcileCats";
// V09-13：来源与证据标注（判据 `provenance.ts`；渲染件 `ProvenancePanel.tsx`）——技术详情三图共用一份
import { evidenceShortOf, sourceKindLabelOf, type ProvenanceModel } from "./provenance";
import { GraphAttentionBar, ProvenanceSummaryLine } from "./ProvenancePanel";
import { FOCUS_RING_COLOR, statusStyle } from "./statusColor";

/** markmap 的 markdown 解析器。插件版（katex/prism/highlight）不需要：我们的 markdown 由
 *  `toMarkdown` 生成，只有标题/列表/行内代码，走 no-plugins 少背几百 KB 前端包。 */
const transformer = new Transformer();

type MmRoot = ReturnType<Transformer["transform"]>["root"];

/** markmap 的节点（N3 定位浮层只读这几个字段：payload 里的身份、state.rect 里的位置） */
interface MmNode {
  payload?: { nodeId?: string; status?: string; from?: string; fold?: number };
  state?: { path?: string; rect?: { x: number; y: number; width: number; height: number } };
  children?: MmNode[];
}

// §4.2 状态色：色值与方框图**同一份**（`./statusColor.ts` 的取色入口，四色/六态两张表都在那里）。
// 状态本身**不由本文件算**：复用共用层节点的 v1 `status`，V08-06 起 `ArchView` 还会喂一份 v2 派生表
// （`statusOverride`），`bindPayloads` 以它优先、表里没有的才回落 v1（见那里的注释）。

/** A4 下钻子级节点（目录/文件/聚合）的中性色：文件层没有模块状态（§4.1 LLM 不碰文件层） */
const SUBLEVEL_COLOR = "#94a3b8";

/** V09-22（契约 2）：巨枝「加载全部子级」按 `childrenOffset` 稳定分页续取的**安全上限**——
 *  到顶仍未取完就如实停止并 `console.warn` 留痕（不静默丢页、不冒充全量）。与 ArchCanvas 同值同口径。 */
const MAX_EXPAND_PAGES = 50;

/** 定位入口要去的目标视图（从导图出发只有这两个 React Flow 视图可选） */
type LocateTo = "MODULE_BOX" | "DATA_FLOW";

/** 一次 A4 懒加载的实测记录（DoD②③ 证据：逐枝耗时/子级数/截断量，供界面与验证脚本读同一份） */
interface ExpandLog {
  /** 节点 id（回查树） */
  id: string;
  /** 节点路径（A4 入参） */
  path: string;
  /** 本次 A4 请求的端到端耗时（毫秒，含服务端遍历/解析与网络） */
  ms: number;
  /** 服务端返回的子级数（不含聚合节点） */
  children: number;
  /** 因超硬上限被截断的子级数（0 = 没触发上限，§4.3 第 1 招） */
  dropped: number;
  /** 本次生效的子级上限（服务端口径） */
  limit: number;
  /** V09-22：本次子树遍历/解析是否因预算到点收工（`ExpandResult.stats.budget_exhausted`）——
   *  巨枝降级行据此追加「清单可能不含全部」标注，不宣称假全量。 */
  budget_exhausted: boolean;
}

/** 节点该折叠吗（§3.3 规则 5：默认全部折叠，只显示顶层；根节点恒展开）。
 *  **唯一出处 = 本组件的展开态**：markmap 只负责按 `payload.fold` 画，不持有状态。 */
function foldOf(n: MindTreeNode, isExpanded: (n: MindTreeNode) => boolean): number {
  return n.children.length > 0 && !isExpanded(n) ? 1 : 0;
}

/**
 * 把共用层/A4 的节点身份与**折叠态**写进 markmap 节点的 payload（着色、点击回查、折叠都靠它）。
 * 我们的 markdown 是逐行前序生成的，markmap 的解析也是前序 → 两棵树可以并行遍历一一对应；
 * 节点数对不上（解析意外）时返回 aligned:false，调用方降级为默认配色，不猜、不错配。
 */
function bindPayloads(
  mm: MmRoot,
  mine: MindTreeNode,
  isExpanded: (n: MindTreeNode) => boolean,
  /** V08-06 ②：v2 派生状态表（模块 id → 上屏键）；给了就优先于共用层的 v1 status */
  override: Record<string, string>,
): { aligned: boolean; total: number } {
  let matched = 0;
  const walk = (a: MmRoot, b: MindTreeNode): void => {
    matched++;
    a.payload = {
      ...(a.payload ?? {}),
      nodeId: b.id,
      // V08-06 ②：给了 v2 派生状态就优先用它（表里没有的才回落到共用层的 v1 状态）
      ...(() => {
        const hit = override[b.id];
        if (hit !== undefined) return { status: hit };
        return b.status ? { status: b.status } : {};
      })(),
      from: b.from,
      fold: foldOf(b, isExpanded),
    };
    const kids = a.children ?? [];
    for (let i = 0; i < kids.length && i < b.children.length; i++) walk(kids[i], b.children[i]);
  };
  walk(mm, mine);
  let total = 0;
  const countAll = (n: MmRoot): void => {
    total++;
    for (const c of n.children ?? []) countAll(c);
  };
  countAll(mm);
  return { aligned: matched === total && matched === countNodes(mine), total };
}

function countNodes(n: MindTreeNode): number {
  return 1 + n.children.reduce((s, c) => s + countNodes(c), 0);
}

/** 展开态记录（id → path）：一条记录 = 一次 A4 懒加载，也是落盘的最小单元 */
const entriesOf = (expanded: Readonly<Record<string, string>>): MindMapExpandEntry[] =>
  Object.entries(expanded).map(([id, path]) => ({ id, path }));

/** 一次 A4 结果 → 一条实测记录（客户端耗时由调用方掐表） */
function logOf(id: string, path: string, result: ExpandResult, ms: number): ExpandLog {
  return {
    id,
    path,
    ms,
    children: result.children.filter((c) => c.kind !== "aggregate").length,
    dropped: result.truncated.children,
    limit: result.limit.children,
    budget_exhausted: result.stats.budget_exhausted,
  };
}

/** markmap 节点的说明文字（口径条里的图例） */
const LEGEND = [
  { mark: "**中文名**", hint: "顶层模块：A2 起名缓存（names.json）" },
  { mark: "▸", hint: "还有下一级：点它就地懒加载 A4 子级（不跳页、不换图）" },
  { mark: "○/●", hint: "点带圆点的节点折叠/展开（折叠态落盘，刷新后保持）" },
  { mark: "▣ ⇄", hint: "节点右侧两个小图标：在方框图 / 数据流向图定位同一 module_id（N3）" },
  { mark: "`路径`", hint: "每行尾带 id/path/files/from 注释，可回查 A1 模块清单" },
  { mark: "规划", hint: "规划层节点（审定图纸派生、尚无实测代码对应；§4.2 灰「已规划，未开始」）——与代码模块分层显示，无真实路径不可下钻" },
];

// ── N3：定位浮层（方框图/流向图入口 + "定位到这里"的光环）──────────────────────────────
// markmap 只画节点本体，画不了我们的按钮。浮层是**原生 SVG DOM**（挂在 markmap 的 `<g>` 容器里，
// 不是 React 子树，JSX 用不上），并且**不放文字节点**：节点 g 的文本被 N2 的验证脚本按整行锚定
// （`g[data-path]` 的 textContent），往里塞一个「定位」字就会改掉那行文字——浮层因此独立成
// 兄弟元素（每个节点右侧、树的坐标系里），文字只出现在 `<title>`（原生 tooltip，不在节点文本里）。
const SVG_NS = "http://www.w3.org/2000/svg";

function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

/** 入口图标：方框图 = 两个小方块 + 连线；流向图 = 一支箭头（都不带文字） */
function locateGlyph(to: LocateTo, x: number): SVGElement[] {
  const s = { fill: "none", stroke: "var(--tt-muted)", "stroke-width": 1 } as const;
  const inner =
    to === "MODULE_BOX"
      ? [
          svgEl("rect", { x: x + 3, y: 3, width: 6, height: 5, rx: 1, ...s }),
          svgEl("rect", { x: x + 11, y: 3, width: 6, height: 5, rx: 1, ...s }),
          svgEl("path", { d: `M${x + 6} 8 V10 H${x + 14} V8`, ...s }),
        ]
      : [
          svgEl("path", {
            d: `M${x + 3} 7 H${x + 15} M${x + 12} 4 L${x + 15} 7 L${x + 12} 10`,
            fill: "none",
            stroke: "var(--tt-muted)",
            "stroke-width": 1.4,
            "stroke-linecap": "round",
            "stroke-linejoin": "round",
          }),
        ];
  return inner;
}

/**
 * 一个定位入口（`to` 是目标视图）。返回的 `<g>` 自己带原生 click/mousedown 监听：
 *   - `mousedown` 必须 `stopPropagation`——markmap 的 d3-zoom 挂在 `<svg>` 上，mousedown 冒泡上去
 *     会被当成"开始拖画布"，d3 的 `noclick` 随后会把 click 事件在 window 捕获阶段掐掉（图标就点不动了）；
 *   - `click` 自己处理（不走 React 委托，理由同上：事件到不了 React root 就被掐了）。
 */
function locateEntry(
  to: LocateTo,
  id: string,
  label: string,
  path: string,
  x: number,
  onPick: (id: string, to: LocateTo) => void,
): SVGGElement {
  const title = to === "MODULE_BOX" ? "在方框图定位这个节点" : "在数据流向图定位这个节点";
  const g = svgEl("g", {
    class: "mm-overlay mm-locate",
    transform: `translate(${x}, 0)`,
    "data-mm-locate": id,
    "data-mm-locate-to": to,
    "data-mm-locate-label": label,
    "data-mm-locate-path": path,
    role: "button",
    "aria-label": title,
    cursor: "pointer",
  });
  const tip = svgEl("title");
  tip.textContent = `${title}（按 module_id 对齐：${id}）`;
  g.append(
    tip,
    svgEl("rect", { width: 20, height: 14, rx: 3, fill: "var(--tt-surface)", stroke: "var(--tt-border)", "stroke-width": 1 }),
    ...locateGlyph(to, 0),
  );
  g.addEventListener("mousedown", (ev) => ev.stopPropagation());
  g.addEventListener("dblclick", (ev) => ev.stopPropagation());
  g.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    onPick(id, to);
  });
  return g;
}

/**
 * 规划层节点的「规划」徽标（原生 SVG，挂在节点右侧的定位浮层 wrap 里）。**不带节点文字**——
 * 不碰节点 `<g>` 的 textContent，N1/N2 按整行文字锚定的脚本不受影响（与定位入口同一护栏）。
 */
function planBadgeEl(id: string): SVGGElement {
  const g = svgEl("g", { class: "mm-overlay mm-plan", "data-mm-plan": id });
  const tip = svgEl("title");
  tip.textContent = "规划层节点：来自审定图纸派生、尚无实测代码对应（§4.2 灰「已规划，未开始」；无真实路径不可下钻）";
  g.append(
    tip,
    svgEl("rect", {
      x: 44,
      y: 0,
      width: 26,
      height: 14,
      rx: 3,
      fill: "var(--tt-surface)",
      stroke: "var(--tt-border)",
      "stroke-width": 1,
    }),
  );
  const t = svgEl("text", { x: 47, y: 10, "font-size": 9, fill: "var(--tt-muted)" });
  t.textContent = "规划";
  g.append(t);
  return g;
}

/** 可见节点遍历（与 markmap 自己的口径一致：`payload.fold` 的枝连同子树一起不画） */
function walkVisibleMm(n: MmNode, cb: (node: MmNode) => void): void {
  cb(n);
  if (n.payload?.fold) return;
  for (const c of n.children ?? []) walkVisibleMm(c, cb);
}

/** 按 module_id 找 markmap 的节点对象（`centerNode` 要的就是这个对象本身，不是路径） */
function findMmNode(root: MmNode, id: string): MmNode | null {
  let hit: MmNode | null = null;
  walkVisibleMm(root, (n) => {
    if (n.payload?.nodeId === id) hit = n;
  });
  return hit;
}

export function MindMapView({
  project,
  onNeedParse,
  locate,
  onLocate,
  statusOverride,
  onlyInCode,
  provenance,
}: {
  project: ProjectItem;
  /** 未解析过（exists:false）时切回方框图走"先解析"引导态（引导逻辑全在 ArchCanvas，不在这里重写） */
  onNeedParse: () => void;
  /** V08-06 ②：v2 派生状态表（模块 id → 上屏键）。给了就**不再用 v1 四色的「未开始/已完成」**——
   *  节点色与定位环色都跟着它走（`statusStyle` 认六态键；表里没有的文件/子目录保持中性色）。 */
  statusOverride?: Record<string, string>;
  /** V09-08 ③：对账 `only_in_code` 原始事实（带分类）——技术详情三图里这一支也要**分类分计**
   *  （与方框图/数据流向图共用的那份面板同一个口径，见 `ReconcileCats`）。 */
  onlyInCode?: readonly { id: string; name: string; path?: string; category?: string }[];
  /**
   * V09-13：来源与证据标注模型（服务端同一份派生）。给了就在导图顶部显示交付阻断读数与逐节点
   * 的来源种类／证据状态；不给（旧调用方）行为逐字不变。
   */
  provenance?: ProvenanceModel | null;
  /** N3：要定位到思维导图的请求（`ArchView` 转交；null = 没有待处理请求）。
   *  对齐键是请求里的 `id`（= 共用层 module_id），**与显示名无关**（PLAN N3 跑偏点）。 */
  locate?: LocateRequest | null;
  /** N3：点节点右侧的定位入口 → 请求切到目标视图并定位同一个 module_id（实现在 `ArchView`） */
  onLocate: (id: string, label: string, to: LocateTo) => void;
}) {
  const [graph, setGraph] = useState<SharedGraph | null>(null);
  /** 2026-10-08 五图补齐：规划层节点 id 集合（`plan_origin:"plan"`，同一份共用数据层节点集）。
   *  导图节点据此加「规划」徽标（与方框图 ArchCanvas 同口径；只加标记，不改节点文字与状态色）。 */
  const planIds = useMemo(() => {
    const s = new Set<string>();
    for (const n of graph?.nodes ?? []) if (n.plan_origin === "plan") s.add(n.id);
    return s;
  }, [graph]);
  const planIdsRef = useRef<Set<string>>(planIds);
  planIdsRef.current = planIds;
  /** V09-22「显示全部」：顶层模块按全量上限拉取（`getArchRender full:true`，同一 builder 换上限）；
   *  概览默认逐字不变。换模式 = 重取共用层 + 按落盘展开态补拉枝（逻辑复用现有）。 */
  const [showAll, setShowAll] = useState(false);
  const [exists, setExists] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Q49：重试计数——错误态点「重试」时 +1，把项目 effect 重跑一遍（重取数据层，不动折叠记忆） */
  const [reloadNonce, setReloadNonce] = useState(0);
  /** A4 懒加载缓存：父节点 id → 展开结果（点一次加载一枝，折叠/切视图不丢） */
  const [childrenById, setChildrenById] = useState<Record<string, ExpandChild[]>>({});
  /** 展开态（N2 唯一出处）：节点 id → 路径；也是落盘 `<项目根>/.工作台/arch/mindmap-fold.json` 的内容。
   *  同时用 ref 镜像一份：点击回调用它算下一份状态，避免闭包读到旧值（fold 与落盘必须同步） */
  const [expandedPaths, setExpandedPaths] = useState<Record<string, string>>({});
  const expandedRef = useRef<Record<string, string>>({});
  const [busy, setBusy] = useState<{ id: string; path: string } | null>(null);
  /** DoD②③ 证据：每枝 A4 懒加载的实测记录（次数 = 长度、最近耗时 = 末条，界面与验证脚本读同一份） */
  const [loadLog, setLoadLog] = useState<ExpandLog[]>([]);
  /** markmap 实际渲染出的节点数（读 mm.state.data，与树节点数对照） */
  const [mmNodes, setMmNodes] = useState(0);
  const [copied, setCopied] = useState(false);
  // ── N3 定位 ──────────────────────────────────────────────────────────────────
  /** 本次定位命中的 module_id（高亮环 + 居中都按它找；null = 当前没有定位目标） */
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(null);
  /** 定位结果提示（DoD④）：未命中明说"在哪个视图无对应"；命中留一行痕 */
  const [locateNote, setLocateNote] = useState<{ state: "matched" | "unmatched"; text: string } | null>(null);
  /** 已处理的请求号（数据晚到时补处理一次；同一个请求不重复处理） */
  const locateHandledRef = useRef(0);
  /** markmap 每次重画完成的序号（定位的"居中 + 上环"要等重画完、rect 有值再动视口） */
  const [renderTick, setRenderTick] = useState(0);
  /** 节点 id → 树节点（N3 定位**只按 module_id 查**，显示名不参与——PLAN N3 跑偏点） */
  const indexRef = useRef(new Map<string, MindTreeNode>());
  /** 当前定位目标（浮层重画时读它，避免闭包读到旧值） */
  const focusIdRef = useRef<string | null>(null);
  focusIdRef.current = focusedNodeId;
  /** 浮层里的定位入口被点（原生监听 → 走 React 的回调） */
  const pickRef = useRef<(id: string, to: LocateTo) => void>(() => {});
  pickRef.current = (id, to) => {
    const node = indexRef.current.get(id);
    onLocate(id, node?.label ?? id, to);
  };
  /** 重画后补浮层（渲染串行链里调用；ref 是为了在 callback 里引用保持稳定） */
  const paintRef = useRef<() => void>(() => {});
  /** 容器可画才 `fit()`（判据 `isDrawableBox` 见 `mindmapGeometry.ts` 的根因注释）：用 ref 形式
   *  避免进 useCallback 依赖数组、保持既有渲染链的引用稳定。 */
  const safeFitRef = useRef<(mm: Markmap) => Promise<void>>(async () => {});

  const svgRef = useRef<SVGSVGElement | null>(null);
  const mmRef = useRef<Markmap | null>(null);
  /** V09-22：markmap 实例创建时绑定的 SVG 节点。数据 effect 的 `setExists(null)` 会让组件走
   *  「加载中…」早退、卸载旧 SVG，数据回来后 React 挂上**新的** SVG；实例 effect 若按
   *  `mmRef.current ?? create` 复用旧实例，图就全画进已脱附的旧节点（屏幕上的新 SVG 永远为空）。
   *  以本字段为唯一判据：一旦与当前 `svgRef.current` 不同 ⇒ 旧实例作废，销毁重建。 */
  const mmSvgNodeRef = useRef<SVGSVGElement | null>(null);
  /** V09-22：当前项目 id 的实时 ref——`postArchExpand` 的应答跨 await 回来时项目可能已换，
   *  守卫比较要用这里的当前值（不能拿闭包里发起时的 project.id 比）。 */
  const mmProjectIdRef = useRef(project.id);
  mmProjectIdRef.current = project.id;
  /** markmap 节点 path（markmap 自己的 state.path）→ 我们的树节点：点击回查用 */
  const pathMapRef = useRef(new Map<string, MindTreeNode>());
  /** 容器尺寸观测（每次观测都更新，含隐藏时的 0×0）：`sized` = 现在能画。markmap 的 fit() 在
   *  零尺寸容器上会算出 NaN 缩放，把 `<g transform>` 写成 `translate(NaN,NaN)`（浏览器控制台报
   *  `<g> attribute transform: Expected number`），并且 d3-zoom 还会读不到相对长度直接抛异常——
   *  所以**有尺寸才画**：容器没尺寸（挂载首帧 / 切走 display:none）时既不 setData 也不 fit。 */
  const [viewSize, setViewSize] = useState<{ w: number; h: number } | null>(null);
  /** 最近一次非零尺寸（给 `<svg>` 上那对兜底数值属性；见 svg 旁注释） */
  const lastSizedBox = useRef({ w: 1200, h: 800 });
  const sized = viewSize !== null && viewSize.w > 0 && viewSize.h > 0;
  /** 渲染串行化（见 enqueueRender）：markmap 的 setData / renderData 都会重建 d3 节点并起 200ms
   *  过渡，两路并发会让后一次重画去动前一次正在淡出的节点。本卡把两路收进一条串行链，排队中的
   *  请求只留最后一次（连点折叠/展开时只重画最后那个状态，既不并发也不重复画）。 */
  const renderPendingRef = useRef<(() => Promise<void>) | null>(null);
  const renderRunningRef = useRef(false);
  const enqueueRender = useCallback((job: () => Promise<void>) => {
    renderPendingRef.current = job;
    if (renderRunningRef.current) return; // 已在跑，跑完取最后一次（合并）
    renderRunningRef.current = true;
    void (async () => {
      while (renderPendingRef.current) {
        const next = renderPendingRef.current;
        renderPendingRef.current = null;
        try {
          await next();
        } catch {
          // 渲染失败不打断交互：下一次 markdown 变化/点击会再画一次
        }
      }
      renderRunningRef.current = false;
    })();
  }, []);

  /**
   * N3 浮层重画：给每个**可见**节点补两个定位入口（方框图 / 数据流向图），若有定位目标再套一圈
   * "定位到这里"的光环（内环 = 该模块的**四色状态色**，与 A5 同一份；外环 = 定位强调色）。
   * 每次 markmap 重画后都要重画一遍（折叠/展开会让所有 rect 变），所以它挂在渲染串行链尾部：
   * `enqueueRender` 保证"重画 → 补浮层"是同一件事的后半段，不与其他重画交叉。
   */
  const paintOverlay = useCallback(() => {
    const mm = mmRef.current;
    const svg = svgRef.current;
    const root = mm?.g.node();
    const data = mm?.state.data as unknown as MmNode | undefined;
    if (!mm || !svg || !root || !data) return;
    for (const old of Array.from(svg.querySelectorAll("g.mm-overlay"))) old.remove();
    const pick = (id: string, to: LocateTo) => pickRef.current(id, to);
    walkVisibleMm(data, (n) => {
      const rect = n.state?.rect;
      const id = n.payload?.nodeId;
      if (!rect || rect.width <= 0 || !id) return;
      const tree = indexRef.current.get(id);
      const wrap = svgEl("g", {
        class: "mm-overlay mm-locate-pair",
        transform: `translate(${rect.x + rect.width + 4}, ${Math.round(rect.y + Math.max(0, (rect.height - 14) / 2))})`,
      });
      wrap.append(
        locateEntry("MODULE_BOX", id, tree?.label ?? id, tree?.path ?? "", 0, pick),
        locateEntry("DATA_FLOW", id, tree?.label ?? id, tree?.path ?? "", 22, pick),
      );
      if (planIdsRef.current.has(id)) wrap.append(planBadgeEl(id));
      root.appendChild(wrap);
    });
    const focusId = focusIdRef.current;
    if (!focusId) return;
    const target = indexRef.current.get(focusId);
    const hit = findMmNode(data, focusId);
    const rect = hit?.state?.rect;
    if (!target || !rect || rect.width <= 0) return;
    // V08-06 收尾（2026-09-24）：环色/环上状态词按**该节点上屏的状态**取——`bindPayloads` 给 payload
    // 写的就是"v2 派生键优先、表里没有才回落 v1"的合并结果，这里跟着它走。早先读 `indexRef` 的
    // v1 自报状态，会和方框图同一节点的颜色对不上（实测 audit：方框图绿、导图环灰）。
    const shown = (hit?.payload as { status?: string } | undefined)?.status ?? target.status;
    const hex = statusStyle(shown).hex;
    const ring = svgEl("g", {
      class: "mm-overlay mm-focus",
      "data-mm-focused": focusId,
      "data-mm-focus-status": shown ?? "todo",
      "data-mm-focus-color": hex,
      "data-mm-focus-label": target.label,
    });
    ring.append(
      svgEl("rect", {
        x: rect.x - 4,
        y: rect.y - 3,
        width: rect.width + 8,
        height: rect.height + 6,
        rx: 5,
        fill: "none",
        stroke: hex,
        "stroke-width": 2,
      }),
      svgEl("rect", {
        x: rect.x - 8,
        y: rect.y - 7,
        width: rect.width + 16,
        height: rect.height + 14,
        rx: 7,
        fill: "none",
        stroke: FOCUS_RING_COLOR,
        "stroke-width": 1.5,
        "stroke-dasharray": "5 4",
      }),
    );
    root.appendChild(ring);
  }, []);
  paintRef.current = paintOverlay;
  safeFitRef.current = async (mm) => {
    // 判据要用**这个实例自己的** SVG 节点（不是 svgRef.current）：换项目时旧实例可能还挂在
    // 已脱附的旧节点上（0×0），而 svgRef 已指向新的、有尺寸的节点——用错的节点判就会让旧实例
    // 在 0 尺寸上 fit（0/0 → NaN）。isConnected 再兜一道"已脱附"。
    const el = mm.svg?.node?.() as SVGSVGElement | null | undefined;
    if (!el || !el.isConnected || !isDrawableBox(el.getBoundingClientRect())) return;
    if (!isFiniteRect(mm.state?.rect)) return;
    await mm.fit().catch(() => {
      // 拟合失败不打断交互：下一次重画/尺寸变化会再试
    });
  };

  /** 重画 + 补浮层 + 递增重画序号（`renderTick` 是"这一帧画完了"的信号，定位居中靠它等 rect 就位） */
  const renderAndPaint = useCallback(async (mm: Markmap) => {
    await mm.renderData();
    await safeFitRef.current(mm);
    paintRef.current();
    setRenderTick((t) => t + 1);
  }, []);

  const tree: MindTree | null = useMemo(
    () =>
      graph
        ? buildMindTree(graph, { id: project.id, name: project.name }, new Map(Object.entries(childrenById)))
        : null,
    [graph, childrenById, project.id, project.name],
  );
  const markdown = useMemo(() => (tree ? toMarkdown(tree.root) : ""), [tree]);

  /** N3：树节点索引（id → 树节点 / 父节点）。定位**只按 id 查**——显示名会被 Flash 重命名
   *  （`names.json`），拿名字对齐一跳就断（PLAN N3 跑偏点红线）。 */
  const index = useMemo(() => {
    const byId = new Map<string, MindTreeNode>();
    const parentOf = new Map<string, MindTreeNode>();
    if (tree) {
      const walk = (n: MindTreeNode): void => {
        byId.set(n.id, n);
        for (const c of n.children) {
          parentOf.set(c.id, n);
          walk(c);
        }
      };
      walk(tree.root);
    }
    return { byId, parentOf };
  }, [tree]);
  indexRef.current = index.byId;

  /** 展开态判定（铺进 markmap payload 的唯一入口）：根节点恒展开，其余看落盘/当前展开态 */
  const isExpandedNode = useCallback(
    (n: MindTreeNode) => n.from === "project" || expandedRef.current[n.id] !== undefined,
    [],
  );

  /** 折叠态落盘（立刻写，不 debounce）：一次点击一条，状态小；"刷新后保持"因此不依赖定时器 */
  const persist = useCallback(
    (expanded: Readonly<Record<string, string>>) => {
      void putArchMindMapFold(project.id, entriesOf(expanded)).catch(() => {
        // 写盘失败不打断交互（下次展开/折叠会再带一次）；本会话内折叠态以内存为准
      });
    },
    [project.id],
  );

  /** 把当前展开态铺回 markmap 并重画（纯折叠切换用：数据没变，markdown 不变 → 只重画不重算） */
  const applyFold = useCallback(() => {
    const mm = mmRef.current;
    const data = mm?.state.data as MmRoot | undefined;
    if (!mm || !data) return;
    const walk = (n: MmRoot): void => {
      const p = n.payload as { nodeId?: string } | undefined;
      const expanded = p?.nodeId !== undefined && (p.nodeId === project.id || expandedRef.current[p.nodeId] !== undefined);
      n.payload = { ...(n.payload ?? {}), fold: (n.children?.length ?? 0) > 0 && !expanded ? 1 : 0 };
      for (const c of n.children ?? []) walk(c);
    };
    walk(data);
    enqueueRender(() => renderAndPaint(mm));
  }, [enqueueRender, project.id, renderAndPaint]);

  /** 量容器尺寸：每次观测都记（含 0 = 现在画不了）；非零尺寸另存一份喂 SVG 的兜底属性。
   *  依赖 `exists`：数据到位前本组件渲染的是"加载中…"，那时还没有 svg 可观察——尺寸观测必须
   *  等 svg 真挂上（N2 实测踩到：挂在 [] 上会让 sized 永远 false，导图一片空白）。 */
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      const w = Math.round(r.width);
      const h = Math.round(r.height);
      if (w > 0 && h > 0) lastSizedBox.current = { w, h };
      setViewSize((prev) => (prev && prev.w === w && prev.h === h ? prev : { w, h }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [exists]);

  /** autoFit 恒 false（创建时即关，见 Markmap.create 与 mindmapGeometry.ts）：放掉 markmap 自带的拟合
   *  路径——它的内部 ResizeObserver（观察节点内容 div）在隐藏/零尺寸时仍会重画，autoFit 开着就会在
   *  0 尺寸容器上 fit（0/0 → NaN → translate(NaN,NaN)）；关掉后拟合只经 safeFitRef，受尺寸判据约束。 */
  useEffect(() => {
    const mm = mmRef.current;
    if (!mm) return;
    // autoFit 恒 false：隐藏期间的任何重画都不会触发 fit（拟合只走 safeFitRef 的受控路径）
    if (sized) enqueueRender(() => renderAndPaint(mm));
  }, [sized, enqueueRender, renderAndPaint]);

  // 换项目 = 初次进入：清空后读数（共用数据层 + 落盘的展开态），把上次展开过的枝补回来
  /** V09-22：上次见过的项目 id——`setShowAll(false)` 的换项目重置只许在**项目真变了**时发生。
   *  本 effect 依赖里有 showAll（切「显示全部/返回概览」要重取共用层），重置若不带守卫会把
   *  刚点的 true 立刻打回概览（verify-v09-22-ui ⑥ 实测打回）；ArchCanvas 同类开关同款 ref 守卫。 */
  const lastProjectIdRef = useRef<string | null>(null);
  useEffect(() => {
    const projectChanged = lastProjectIdRef.current !== project.id;
    lastProjectIdRef.current = project.id;
    if (projectChanged) setShowAll(false); // 换项目回概览默认口径（显示全部不跨项目沿用）
    setExists(null);
    setGraph(null);
    setChildrenById({});
    setExpandedPaths({});
    expandedRootReset(expandedRef);
    setLoadLog([]);
    setBusy(null);
    setError(null);
    // markmap 节点数归零：它是"这次渲染完成了"的读数（markmap 节点数只在 setData 完成后写），
    // 换项目不归零会让上一个项目的数留在这里骗人（验证脚本也拿它当就绪信号）
    setMmNodes(0);
    // N3：上一个项目的定位目标与提示一并清掉（节点 id 是项目内 slug，换个项目可能同名——
    // 留着会在新项目上画出一圈没有来由的高亮）
    setFocusedNodeId(null);
    setLocateNote(null);
    let cancelled = false;
    void (async () => {
      const [r, saved] = await Promise.all([
        getArchRender(project.id, { full: showAll }),
        // 折叠态读不出来（文件损坏/权限）不打断导图：按空态 = 默认全折叠（§3.3 规则 5）
        getArchMindMapFold(project.id).catch(() => [] as MindMapExpandEntry[]),
      ]);
      if (cancelled) return;
      setExists(r.exists);
      setGraph(r.graph ?? null);
      if (!r.exists || saved.length === 0) return;
      // 恢复上次展开态：按序（父在子先）**只补拉那些枝**——没展开过的枝这里一个请求都不发，
      // 这正是 DoD② 的对照面：data-mindmap-loads 只涨落盘清单的条数，不是全量解析。
      const children: Record<string, ExpandChild[]> = {};
      const restoredExpanded: Record<string, string> = {};
      const log: ExpandLog[] = [];
      for (const entry of saved) {
        if (cancelled) return;
        const t0 = performance.now();
        try {
          const result = await postArchExpand(project.id, entry.path);
          children[entry.id] = result.children;
          restoredExpanded[entry.id] = entry.path;
          log.push(logOf(entry.id, entry.path, result, Math.round(performance.now() - t0)));
        } catch {
          // 枝没了（目录被删/改名/命中忽略段）→ 丢这一条，其余照常；不写盘（下次展开会覆盖）
        }
      }
      if (cancelled) return;
      setChildrenById(children);
      expandedRef.current = restoredExpanded;
      setExpandedPaths(restoredExpanded);
      setLoadLog(log);
      // V09-22：cancelled 旗标已在，但错误也要走它——换项目/重试后上一轮请求的失败不该写到新场景上
    })().catch((e: Error) => {
      if (!cancelled) setError(e.message);
    });
    return () => {
      cancelled = true;
    };
    // Q49：reloadNonce 在依赖里 —— 错误态点「重试」重跑本 effect（重取渲染数据与折叠记忆）；
    // V09-22：showAll 在依赖里 —— 切「显示全部/返回概览」重取共用层（同一 builder 换上限）
  }, [project.id, reloadNonce, showAll]);

  // markmap 实例只建一次；markdown 变了就 setData（折叠/懒加载/切视图都走这条路）。
  // 容器没尺寸（`!sized`）时不画：挂载首帧与隐藏态都不该在 0 尺寸上 setData/fit（见 sized 的注释）；
  // 等尺寸到位/重新可见时本 effect 会再跑一次（sized 在依赖里），画最近这棵树。
  useEffect(() => {
    if (!sized || !svgRef.current || !tree || markdown === "") return;
    const svgEl = svgRef.current;
    // V09-22：实例只跟**当前这个 SVG 节点**走。数据 effect 的 `setExists(null)` 让 React 换过一次
    // SVG 节点时，旧实例闭死在已脱附的旧节点上（fit() 还会算出 translate(NaN,NaN)）——节点一换
    // 就销毁旧实例、按新节点重建，不复用（复用判据见 mmSvgNodeRef 注释）。
    if (mmRef.current && mmSvgNodeRef.current !== svgEl) {
      mmRef.current.destroy();
      mmRef.current = null;
    }
    const mm =
      mmRef.current ??
      Markmap.create(
        svgEl,
        {
          autoFit: false,
          duration: 200,
          // 折叠态**不由 markmap 的 level 口径决定**（N2 起由本组件的展开态算 payload.fold，见 foldOf）；
          // 这里保持 -1（不按层深自动折），否则它会在 _initializeData 里把我们的 fold 覆盖成 1。
          initialExpandLevel: -1,
          maxWidth: 420,
          color: (node) => {
            const p = node.payload as { status?: string; from?: string } | undefined;
            // 状态色与方框图同一份（statusColor.ts 的取色入口认 v1 四色与 v2 上屏键两套）；
            // 下钻子级（文件层）用中性色
            return p?.status ? statusStyle(p.status).hex : p?.from === "expand" ? SUBLEVEL_COLOR : statusStyle().hex;
          },
        },
        null,
      );
    mmRef.current = mm;
    mmSvgNodeRef.current = svgEl;

    const { root } = transformer.transform(markdown);
    const bound = bindPayloads(root, tree.root, isExpandedNode, statusOverride ?? {});
    const nextPathMap = new Map<string, MindTreeNode>();
    enqueueRender(async () => {
      await mm.setData(root);
      await safeFitRef.current(mm); // 容器可画才 fit（同 safeFit 判据，避免 0 尺寸上的 NaN）
      // 渲染完成后再取 markmap 自己的 state.path（它是内容哈希拼出来的，只能读不能算）
      const walkMm = (n: unknown, mine: MindTreeNode): void => {
        const node = n as { state?: { path?: string }; children?: unknown[] };
        if (node.state?.path) nextPathMap.set(node.state.path, mine);
        const kids = (node.children ?? []) as unknown[];
        for (let i = 0; i < kids.length && i < mine.children.length; i++) walkMm(kids[i], mine.children[i]);
      };
      const data = mm.state.data as unknown;
      if (data) walkMm(data, tree.root);
      pathMapRef.current = nextPathMap;
      setMmNodes(bound.total);
      paintRef.current(); // N3：重画后补定位浮层（入口位置跟着 rect 走）
      setRenderTick((t) => t + 1);
    });
  }, [markdown, tree, isExpandedNode, enqueueRender, sized]);

  // V09-22：卸载清理照旧销毁实例；把实例绑定的 SVG 节点也一并清掉（下次挂载按新节点重建）
  useEffect(
    () => () => {
      mmRef.current?.destroy();
      mmSvgNodeRef.current = null;
    },
    [],
  );

  /**
   * 点节点（§3.3 规则 2/4，N2 口径）：
   *   - 没加载过的枝：就地懒加载 A4 子级（§4.3 第 2 招），加载完展开这一枝；
   *   - 已加载的枝：只切折叠态（零请求，子级缓存留着），落盘；
   *   - 文件/聚合节点：终点，点击不做事。
   * 两种情形都 `stopPropagation()`：markmap 自己的点击会把 fold 翻在它内部（我们读不回来、也就没法落盘）。
   */
  const onClickCapture = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      const g = (e.target as Element).closest?.("g[data-path]");
      const path = g?.getAttribute("data-path");
      const node = path ? pathMapRef.current.get(path) : undefined;
      if (!node || busy) return;
      e.stopPropagation();
      const loaded = childrenById[node.id];
      if (loaded) {
        const next = { ...expandedRef.current };
        if (next[node.id] !== undefined) delete next[node.id];
        else next[node.id] = node.path;
        expandedRef.current = next;
        setExpandedPaths(next);
        applyFold();
        persist(next);
        return;
      }
      if (!isDrillable(node)) return;
      setBusy({ id: node.id, path: node.path });
      setError(null);
      const t0 = performance.now();
      postArchExpand(project.id, node.path)
        .then((result) => {
          if (mmProjectIdRef.current !== project.id) return; // 应答跨 await：项目已换则丢弃
          setChildrenById((prev) => ({ ...prev, [node.id]: result.children }));
          const next = { ...expandedRef.current, [node.id]: node.path };
          expandedRef.current = next;
          setExpandedPaths(next);
          setLoadLog((prev) => [...prev, logOf(node.id, node.path, result, Math.round(performance.now() - t0))]);
          persist(next);
        })
        .catch((err: Error) => setError(err.message))
        .finally(() => setBusy(null));
    },
    [applyFold, busy, childrenById, persist, project.id],
  );

  /** §3.3 规则 4「可收起回概览」：回顶层 = 清空展开态与子级缓存（并落盘），只留顶层 */
  const backToTop = useCallback(() => {
    setChildrenById({});
    setExpandedPaths({});
    expandedRootReset(expandedRef);
    setLoadLog([]);
    persist({});
  }, [persist]);

  /**
   * V09-22：按全量口径重新展开一条巨枝——**稳定分页取全**后覆盖该枝的 `childrenById[父 id]`
   * （该枝已展开；markmap 随 markdown 重渲染）。首拉带 `childrenOffset:0` → 服务端进分页模式
   * （子级全是真实子级、不再为「还有 N 个」聚合节点保留名额）；`children_has_more` 为真就按
   * `offset + returned` 续取到完。合并后 `truncated.children` 取末页值：取完归零则降级行消失，
   * 到安全上限仍未取完则照实显示余量（`capped` 取每枝**最新一次**实测）。
   * 合并后**按一次加载落一条 log**（验证脚本只读该枝末条即合并总量）——若每页各落一条，
   * 末条只剩最后一页，读不准"整枝现在有多少子级"。
   */
  const loadAllChildren = useCallback(
    (entry: ExpandLog) => {
      setBusy({ id: entry.id, path: entry.path });
      setError(null);
      const t0 = performance.now();
      void (async () => {
        try {
          let last = await postArchExpand(project.id, entry.path, { full: true, childrenOffset: 0 });
          if (mmProjectIdRef.current !== project.id) return; // 应答跨 await：项目已换则丢弃
          let merged = [...last.children];
          let pages = 1;
          while (last.children_has_more === true) {
            if (pages >= MAX_EXPAND_PAGES) {
              console.warn(
                `[arch/expand] 思维导图巨枝分页达到安全上限 ${MAX_EXPAND_PAGES} 页仍未取完` +
                  `（path=${entry.path}，已取 ${merged.length}/${last.children_total ?? "?"}）——如实停止，不冒充全量`,
              );
              break;
            }
            const returned = last.children_returned ?? last.children.length;
            if (returned <= 0) break; // 空页：offset 不前进，避免死循环（页数由安全上限兜底）
            const next = await postArchExpand(project.id, entry.path, {
              full: true,
              childrenOffset: (last.children_offset ?? 0) + returned,
            });
            if (mmProjectIdRef.current !== project.id) return; // 应答跨 await：项目已换则丢弃
            merged = merged.concat(next.children);
            last = next;
            pages++;
          }
          const mergedResult: ExpandResult = { ...last, children: merged };
          setChildrenById((prev) => ({ ...prev, [entry.id]: mergedResult.children }));
          setLoadLog((prev) => [
            ...prev,
            logOf(entry.id, entry.path, mergedResult, Math.round(performance.now() - t0)),
          ]);
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(null);
        }
      })();
    },
    [project.id],
  );

  const copyMarkdown = useCallback(() => {
    void navigator.clipboard?.writeText(markdown).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [markdown]);

  /**
   * N3 定位（收到的请求）：对齐键 = `locate.id`（共用层 module_id）。
   *   - 命中且已在树里：把**祖先链就地展开**到可见（§3.3 规则 2 的原地展开，子级数据本就在内存里，
   *     零新解析），重画后居中 + 上环；
   *   - 展开动作**不落盘**：`mindmap-fold.json` 是用户的折叠记忆，定位是"看一眼"的临时动作，
   *     DoD③ 要求定位前后该文件逐字节不变（所以这里只动内存里的展开态，不调 `persist`）；
   *   - 未命中（该 module_id 不在这棵树里，例如只在方框图里展开过的文件级节点、或导图自己的
   *     项目根节点）→ 明说"该节点在思维导图无对应"，不静默失败（DoD④）。
   */
  useEffect(() => {
    if (!locate || locate.nonce === 0 || locateHandledRef.current === locate.nonce) return;
    if (!tree) return; // 树还没建好：等它到位再处理这一次（tree 在依赖里）
    locateHandledRef.current = locate.nonce;
    const node = index.byId.get(locate.id);
    if (!node) {
      setFocusedNodeId(null);
      setLocateNote({
        state: "unmatched",
        text: unmatchedNote(locate, "导图这边只有顶层模块与已展开过的枝，这个 id 还没在导图里展开"),
      });
      return;
    }
    const next = { ...expandedRef.current };
    for (let p = index.parentOf.get(locate.id); p; p = index.parentOf.get(p.id)) {
      if (p.from !== "project") next[p.id] = p.path; // 根节点恒展开，不进折叠态清单
    }
    expandedRef.current = next;
    setExpandedPaths(next);
    setFocusedNodeId(locate.id);
    setLocateNote({
      state: "matched",
      text: matchedNote(locate, "祖先链就地展开到可见（零新解析），折叠记忆不落盘"),
    });
    applyFold(); // fold 变了要重画（markmap 只按 payload.fold 画）
  }, [locate, tree, index, applyFold]);

  /** 目标节点已画出来（rect 有值）→ 居中 + 上环。两个"等"是必要的：
   *  ① 等 `renderTick`：展开/重画是异步的，没画出来之前既找不到 markmap 节点对象也拿不到 rect；
   *  ② 等一轮再居中：markmap 的 `autoFit` 会在 `renderData` 尾部起一个 200ms 的 fit 过渡，
   *     立刻居中会被"后发先至"的 fit 拉回全图（本地实测偏差 200–370px）。 */
  useEffect(() => {
    const mm = mmRef.current;
    const data = mm?.state.data as unknown as MmNode | undefined;
    if (!mm || !data || !focusedNodeId || !sized) return;
    if (!findMmNode(data, focusedNodeId)) return;
    let cancelled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const center = () => {
      const cur = mmRef.current;
      const curData = cur?.state.data as unknown as MmNode | undefined;
      const node = curData ? findMmNode(curData, focusedNodeId) : null;
      const el = cur?.svg?.node?.() as SVGSVGElement | null | undefined;
      // 容器不可画时不做居中：centerNode 会除以当前缩放，0 尺寸下会算出 translate(NaN,NaN)（同 fit 的根因）。
      // 判据用**这个实例自己的** SVG 节点（理由同 safeFitRef）；已脱附的旧实例一律不居中。
      if (!cur || !node || !el || !el.isConnected || !isDrawableBox(el.getBoundingClientRect())) return;
      void cur.centerNode(node as unknown as Parameters<Markmap["centerNode"]>[0]);
      paintRef.current();
    };
    const kick = (delay: number) =>
      timers.push(setTimeout(() => {
        if (!cancelled) center();
      }, delay));
    kick(300); // 等这一轮重画的 autoFit 过渡走完
    kick(700); // 再补一次：渲染链路里可能又排了一次带 autoFit 的重画（居中幂等，重复调用无害）
    return () => {
      cancelled = true;
      for (const t of timers) clearTimeout(t);
    };
  }, [focusedNodeId, renderTick, sized]);

  // Q91（2026-09-18 审计）：这两份由 loadLog 派生的东西都按 loadLog 记忆化。
  // 此前 `data-mindmap-load-log={JSON.stringify(loadLog)}` 与那句「逐枝实测」文案是**每次渲染**重算的
  // ——组件任一 state 变化（busy/mmNodes/sized/折叠态…）都会把整份日志重新序列化一遍写进 DOM 属性。
  // 口径不变：属性仍是整份日志的 JSON（DoD②③ 取数钩子），文案仍是逐条拼接。
  // 位置注意：必须在下面那几个早退（error/exists 分支）**之前**——hook 不许放在条件返回之后。
  const loadLogJson = useMemo(() => JSON.stringify(loadLog), [loadLog]);
  const loadLogText = useMemo(
    () =>
      loadLog
        .map((l) => `${l.path} ${l.ms}ms（子级 ${l.children}${l.dropped > 0 ? ` + 聚合 ${l.dropped}` : ""}）`)
        .join(" · "),
    [loadLog],
  );

  if (error && !tree) {
    // Q49（2026-09-18 审计）：加载失败不再只剩一行红字——给错误卡 + 出口（重试 = 重跑项目 effect）。
    // 树已经建好时（如某一枝展开失败）走下面画布顶部的横幅，导图不报废。
    return (
      <div className="flex flex-1 items-center justify-center overflow-y-auto p-6">
        <div className="w-full max-w-xl space-y-3 rounded border border-neutral-800 bg-neutral-950 p-4">
          <p className="text-sm font-bold text-red-400">思维导图加载失败</p>
          <p data-mindmap-error className="break-all text-xs text-neutral-400">
            {error}
          </p>
          <button
            data-mindmap-error-retry
            onClick={() => {
              setError(null);
              setReloadNonce((n) => n + 1);
            }}
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
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="space-y-3 text-center">
          <p className="text-sm text-neutral-300">这个项目还没有解析过架构</p>
          <p className="text-xs text-neutral-600">
            思维导图的顶层节点来自共用数据层（A1 解析产物），先回方框图跑一次静态解析
          </p>
          <button
            onClick={onNeedParse}
            className="rounded border border-neutral-700 px-4 py-1.5 text-xs text-neutral-200 hover:bg-neutral-800"
          >
            回方框图解析
          </button>
        </div>
      </div>
    );
  }
  if (!tree) return null;

  const limits = graph?.limits;
  const loads = loadLog.length;
  const lastMs = loadLog.length > 0 ? loadLog[loadLog.length - 1].ms : 0;
  const droppedTotal = loadLog.reduce((s, l) => s + l.dropped, 0);
  const expandedCount = Object.keys(expandedPaths).length;
  // V09-22：每枝取**最新一次**实测——「加载全部子级」重拉后该枝 dropped 归零，降级行随之消失；
  // 仍超上限则照实显示余量（droppedTotal 仍是历史累计口径，见上）。
  const latestLogById = new Map<string, ExpandLog>();
  for (const l of loadLog) latestLogById.set(l.id, l);
  const capped = [...latestLogById.values()].filter((l) => l.dropped > 0);
  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      data-mindmap-view
      // V09-22：概览/全量（显示全部）模式状态常驻可读
      data-mindmap-mode-state={showAll ? "full" : "overview"}
      data-mindmap-source="selectGraph:MIND_MAP"
      data-mindmap-plan-nodes={planIds.size}
      data-mindmap-nodes={tree.nodeCount}
      data-mindmap-depth={tree.depth}
      data-mindmap-mm-nodes={mmNodes}
      data-mindmap-loads={loads}
      data-mindmap-last-ms={lastMs}
      data-mindmap-expanded={expandedCount}
      data-mindmap-truncated={droppedTotal}
      data-mindmap-busy={busy?.path ?? ""}
      data-mindmap-load-log={loadLogJson}
      data-mindmap-focused={focusedNodeId ?? ""}
      data-mindmap-focus-state={locateNote?.state ?? ""}
    >
      <div className="shrink-0 space-y-1 border-b border-neutral-800 px-3 py-1.5 text-[11px]">
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-neutral-400">
          <span className="text-neutral-300">思维导图</span>
          <span className="text-neutral-600">层级结构一览，适合快速总览与折叠</span>
          {LEGEND.map((l) => (
            <span key={l.mark} className="text-neutral-500" title={l.hint}>
              <span className="text-neutral-300">{l.mark}</span> {l.hint}
            </span>
          ))}
          <button
            onClick={backToTop}
            data-mindmap-collapse
            className="rounded border border-neutral-700 px-1.5 py-0.5 text-neutral-300 hover:bg-neutral-800"
          >
            回顶层
          </button>
          <button
            onClick={copyMarkdown}
            data-mindmap-export
            className="rounded border border-neutral-700 px-1.5 py-0.5 text-neutral-300 hover:bg-neutral-800"
          >
            {copied ? "已复制" : "复制 markdown"}
          </button>
          {/* V09-22：显示全部 / 返回概览——顶层模块按全量上限重取（同一 builder 换上限）；
              概览超量（有被聚合的顶层模块）时才给「显示全部」入口，不做项目特例。 */}
          {!showAll && (graph?.truncated.nodes ?? 0) > 0 && (
            <button
              onClick={() => setShowAll(true)}
              data-mindmap-show-all
              title="放开渲染上限：顶层模块全部列出（大图布局会变慢）；采集侧 budget_exhausted 时仍如实标注"
              className="rounded border border-neutral-700 px-1.5 py-0.5 text-neutral-300 hover:bg-neutral-800"
            >
              显示全部
            </button>
          )}
          {showAll && (
            <button
              onClick={() => setShowAll(false)}
              data-mindmap-show-overview
              className="rounded border border-neutral-700 px-1.5 py-0.5 text-neutral-300 hover:bg-neutral-800"
            >
              返回概览
            </button>
          )}
        </p>
        {(graph?.budget_exhausted === true || graph?.budget_exhausted === null) && <p className="text-amber-300">{graph?.budget_exhausted === true ? "本次只取得部分模块，未显示的部分不代表不存在。" : "这份旧资料是否完整尚不确定。"}</p>}
        <details className="tt-graph-tech-notes" data-mindmap-technical-details>
          <summary>展开与保存说明、来源和技术记录</summary>
          <div className="tt-graph-tech-content">
        <p
          className="text-neutral-600"
          data-mindmap-budget={
            graph?.budget_exhausted === true
              ? "exhausted"
              : graph?.budget_exhausted === null
                ? "unknown"
                : "ok"
          }
        >
          同一份共用数据层的第三种渲染：顶层节点与层级边 = F2 共用数据层的 MIND_MAP 选择（节点集合与方框图逐
          id 相同，硬上限 {limits?.MAX_NODES ?? "?"} 节点 / 聚合规则同一份 `graph.limits`，本视图零截断、
          零聚合）；点带 ▸ 的节点就地懒加载 A4 下钻子级（本视图不扫目录、不解析源码）。当前树{" "}
          {tree.nodeCount} 节点 · {tree.depth} 层 · 已展开 {expandedCount} 枝 · A4 懒加载 {loads} 次（最近{" "}
          {lastMs}ms）· markmap 渲染 {mmNodes} 节点
          {loads === 0 ? "（还没展开过，只见顶层——§3.3 规则 5 默认全折叠）" : ""}
          {/* Q133：共用层带出的采集侧完整性——残缺集不许在这里被当全量总览 */}
          {graph?.budget_exhausted === true
            ? "；⚠ 这份模块集是到点收工的残缺集（不是全量，缺枝≠项目里没有）"
            : graph?.budget_exhausted === null
              ? "；模块集产自未带完整性标记的旧版解析（有没有扫完未知）"
              : ""}
        </p>
        {/* V09-22：全量态一行说明——顶层节点按全量上限列出（同一份共用层节点身份不变） */}
        {showAll && (
          <p className="text-neutral-500" data-mindmap-full-note>
            全量模式：顶层 {tree.root.children.length} 个节点全部列出（上限 {limits?.MAX_NODES ?? "?"}）
          </p>
        )}
        {/* V09-08 ③：技术详情三图里这一支也要分类分计（与方框图/数据流向图共用的那份面板同口径、同渲染） */}
        <ReconcileCats entries={onlyInCode ?? []} anchor="data-mindmap-reconcile-cats" />
        {/* V09-13：来源与证据——本视图的节点是**代码模块**（代码来源）；未映射/未验证/证据失效
            照实标出并阻断交付结论，逐条可读（判据与三个主视图、MCP 读口同一份）。 */}
        {provenance !== undefined && provenance !== null && (
          <>
            <ProvenanceSummaryLine model={provenance} />
            <p className="flex flex-wrap gap-x-2 text-neutral-500" data-mindmap-provenance-list>
              {tree.root.children.map((c) => {
                const a = provenance.by_object[`plan:code:${c.id}`] ?? provenance.by_object[c.id] ?? null;
                const state = a?.evidence_state ?? "missing";
                const label = a === null ? "缺标注" : evidenceShortOf(a.evidence_state);
                const src = a === null ? "未映射" : sourceKindLabelOf(a.source_kinds);
                return (
                  <span
                    key={c.id}
                    data-mm-provenance={c.id}
                    data-mm-source-kind={a === null || a.source_kinds.length === 0 ? "unmapped" : a.source_kinds.join("+")}
                    data-mm-evidence-state={state}
                    className="whitespace-nowrap"
                  >
                    {c.label}：{src}·{label}
                  </span>
                );
              })}
            </p>
          </>
        )}
        <p className="text-neutral-600" data-mindmap-fold-note>
          折叠态：初次进入默认全折叠（只显示顶层）；点节点展开/折叠，状态
          <span className="text-neutral-300">立刻落盘</span>
          <span className="text-neutral-500">
            {" "}
            `&lt;项目根&gt;/.工作台/arch/mindmap-fold.json`
          </span>
          ，刷新/重进按它补回上次展开的那几枝（只补那几枝，不是全量解析）。
        </p>
          </div>
        </details>
        {/* V09-13＋V09-20 回归修复（§3.11／§4.2，附录 E.20）：六图共用的「来源与证据」信息栏——
            交付阻断读数与待审线索**合成一条**（健康态不占常驻行，有可行动异常时恰一条，详情为浮层）。
            判据与另五图同一份（`attentionCountsOf`＋`provenance.ts`）：存在未映射/未验证/证据失效时
            明确不给「项目可交付」并逐条点名；全部满足才给「可请求验收」（仍不等于用户接受）。 */}
        {provenance !== undefined && provenance !== null && (
          <GraphAttentionBar
            delivery={provenance.delivery}
            leads={provenance.model_leads ?? []}
            nodeLeads={provenance.model_node_leads ?? []}
            anchor="mindmap"
            title="交付结论（思维导图）"
          />
        )}
        {busy && (
          <p className="text-amber-300" data-mindmap-busy-note>
            正在解析 `{busy.path}` 的直接子级（A4 arch/expand，单枝懒加载；界面不阻塞，可继续看别的枝）…
          </p>
        )}
        {/* N3 定位提示（DoD④）：命中留一行痕（显示名与对齐用的 id 摆在一起），未命中明说"无对应" */}
        {locateNote && (
          <p
            className={locateNote.state === "matched" ? "text-cyan-200" : "text-amber-300"}
            data-mindmap-locate-note={locateNote.text}
            data-mindmap-locate-state={locateNote.state}
          >
            {locateNote.text}
          </p>
        )}
        {loadLog.length > 0 && (
          <p className="text-neutral-500" data-mindmap-load-log-note>
            逐枝实测：{loadLogText}
          </p>
        )}
        {capped.map((l) => (
          <p key={l.id} className="text-amber-400" data-mindmap-capped-note={l.path}>
            巨枝降级：`{l.path}` 的子级超过单枝上限 {l.limit}，超出的 {l.dropped} 个
            <span className="text-amber-200">不遍历、不解析、不渲染</span>
            （§4.3 第 1 招），图上只留前 {l.limit - 1} 个 + 一个「还有 {l.dropped} 个」聚合节点。
            {/* V09-22：按全量口径重拉这一枝（覆盖该枝子级缓存）；重拉后 dropped 归零则该行消失 */}
            <button
              data-mindmap-load-all
              data-mindmap-load-all-path={l.path}
              onClick={() => loadAllChildren(l)}
              disabled={busy !== null}
              title="按全量口径重新展开这一枝：列出全部直接子级（postArchExpand full:true，覆盖该枝子级缓存）"
              className="ml-2 rounded border border-amber-600/60 px-1.5 py-0.5 text-amber-200 hover:bg-amber-500/20 disabled:opacity-40"
            >
              加载全部子级
            </button>
            {l.budget_exhausted && (
              <span data-mindmap-budget-note className="ml-2 text-amber-300">
                ⚠ 子树统计受预算限制（budget_exhausted）：清单可能不含全部
              </span>
            )}
          </p>
        ))}
      </div>
      {error && (
        // Q49：树已建好（如某一枝展开失败）时错误不报废导图——横幅说明 + 重试（重取数据层）+ 关闭
        <p
          data-mindmap-error-banner={error}
          className="flex shrink-0 items-center gap-2 border-b border-red-500/40 bg-red-500/10 px-3 py-1.5 text-[11px] text-red-300"
        >
          <span className="min-w-0 flex-1 truncate" title={error}>
            思维导图出错：{error}
          </span>
          <button
            data-mindmap-error-retry
            onClick={() => {
              setError(null);
              setReloadNonce((n) => n + 1);
            }}
            className="shrink-0 rounded border border-red-500/40 px-1.5 py-0.5 hover:bg-red-500/20"
          >
            重试
          </button>
          <button
            data-mindmap-error-dismiss
            onClick={() => setError(null)}
            className="shrink-0 rounded border border-neutral-700 px-1.5 py-0.5 text-neutral-300 hover:bg-neutral-800"
          >
            关闭
          </button>
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-hidden" data-mindmap-canvas>
        {/* width/height 挂**数值属性**（视觉尺寸照样由 CSS 的 h-full/w-full 说了算——表现属性
            优先级低于 CSS，实测 getBoundingClientRect 仍等于容器尺寸）。理由：markmap 每次重画后
            （autoFit 打开时）调 fit() → d3-zoom 的 transform → defaultExtent() 会读 `svg.width.baseVal`；
            容器尺寸解析不出来时（百分比长度 + 无布局）浏览器直接抛「SVGLength: Could not resolve
            relative length」页面异常（N2 加固时抓到栈：defaultExtent ← Gesture ← zoom.transform）。
            第一道防线是上面 `sized`（没尺寸就不画、autoFit 也关掉），这对属性是第二道：万一还有
            别的路径在非常规时刻 fit，baseVal 也读得出数，不会抛。兜底 extent 只影响 d3-zoom 的
            约束数学（markmap 的 fit 自带完整 transform，渲染不受影响）。*/}
        <svg
          ref={svgRef}
          className="markmap h-full w-full"
          width={lastSizedBox.current.w}
          height={lastSizedBox.current.h}
          data-mindmap-svg
          onClickCapture={onClickCapture}
        />
      </div>
      <details className="shrink-0 border-t border-neutral-800 px-3 py-1.5 text-[11px]" data-mindmap-export-panel>
        <summary className="cursor-pointer text-neutral-400">
          导出 markdown（当前树，每行带 id/path/files/from 注释，可逐行回查 A1 模块清单与 A4 子级）
        </summary>
        <pre
          className="mt-1 max-h-40 overflow-auto rounded border border-neutral-800 bg-neutral-950 p-2 text-[10px] leading-4 text-neutral-400"
          data-mindmap-markdown
        >
          {markdown}
        </pre>
      </details>
    </div>
  );
}

/** 清空展开态的 ref 镜像（ref 与 state 必须一起改：一个给渲染用、一个给回调读最新值） */
function expandedRootReset(ref: { current: Record<string, string> }): void {
  ref.current = {};
}
