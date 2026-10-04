// 架构图 Tab（DESIGN.md §3.2 三视图）——本文件是**页签容器**：视图切换的唯一出处。
//
// 两级结构（V06-06 起）：
//   ① **三个主视图**（功能全景 / 系统架构 / 施工依赖）：`ProjectGraphView.tsx`，数据来自
//      V06-05 的规划图与 V06-09 的状态投影；
//   ② **技术详情**：A3–N3 交付的模块方框图 / 数据流向图 / 思维导图，即"基于代码关系的
//      实现分析详情"（§3.2 第一段）。旧的解析能力与渲染**一个字都不删**——它们仍在，只是
//      收进"技术详情"这一页里（既有脚本 verify-a3/a4/a5/f3/f4/n1/n2/n3 守着的就是这一层）。
// 为什么默认落在「功能全景」：§3.1 明写「项目图默认展示功能全景」——V06-08 是导航改造的归属卡，
// 默认落点在本卡切过来（V06-06 有意缓办的那件事）。代价是 a5/n2/n3/f3/f4 里"进页签即方框图"的既有
// 断言会红（那些断言守的是 A3–N3 那一层的行为，不是默认落点）——按卡面要求**不改既有断言**，
// 如实登记在交付备注里交裁定。
//
// 切换口径（§3.2 / F4）：技术详情内部三视图**节点集合完全相同**，差别只在边集合与渲染方式；
// 两个 React Flow 视图（方框图 / 数据流向图）**只挂一个画布实例**，切视图改的是交给它的 `mode`。
// N1：第三种渲染「思维导图」由 markmap 画，切到它时共用画布**保持挂载**（隐藏不卸载）。
// N3：三视图**互相定位**的接线都在这里（唯一的视图切换口 + 唯一的定位状态）。
// V06-06：主视图之间的定位与主视图 ↔ 技术详情的定位也在这里接线（对齐键 = 稳定 ID）。
// 一个刻意的取舍：**同一时刻只挂当前页签的画布**。把另一侧的 React Flow 留在 DOM 里（隐藏不卸载）
// 会让 `verify-f3/f4/n2` 断言的 `.react-flow__node` 计数、`verify-n3` 的 elementFromPoint 归属
// 跟着多出一份隐藏节点——那是改既有断言强度，不是本卡该动的。折叠/坐标在本页内的维护照旧。
import { Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";
import "../arch/graph-workspace.css";
import { getScope, useProjectScope } from "../projectScope";
import { useBoundedReloader, useProjectRefresh } from "../useProjectRefresh";
import { GRAPH_MODES, type GraphMode } from "../../arch/graph-mode";
import type { ProjectItem } from "../api";
import { ArchCanvas, type ArchViewDecl } from "../arch/ArchCanvas";
import { DATA_FLOW_VIEW } from "../arch/DataFlowView";
import { ProjectGraphView } from "../arch/ProjectGraphView";
import { PROJECT_VIEWS, appendObjectQuestionDraft, type ViewNode, type ProjectViewKind } from "../arch/projectGraph";
import type { ProjectLocateRequest } from "../arch/locate";
import type { LocateRequest, ViewKey } from "../arch/locate";
import { declaredLinksFromMatched } from "../../shared/reconcileLinks";
import { getArchBlueprint, getArchReconcile, getStatusProjection } from "../api";
import { moduleStatusKeysOf, taskDerivedModuleStatus } from "../arch/projectGraph";
import type { ProvenanceModel } from "../arch/provenance";

/** 思维导图（markmap）**按需加载**：markmap 系 + d3 只在这一个视图里用，
 *  静态 import 会让点开塔台就背上这份包（N1 实测主包 1.6MB / gzip 510KB）；
 *  动态 import 单独切一个 chunk，第一次点「思维导图」才拉——切视图不重挂的语义不变（加载后常驻）。 */
const MindMapView = lazy(() => import("../arch/MindMapView").then((m) => ({ default: m.MindMapView })));

/** 本页签接入的三个技术详情视图（§3.2 表格三行全齐：F3 两行 + N1 思维导图） */
const VIEW_MODES: GraphMode[] = ["MODULE_BOX", "DATA_FLOW", "MIND_MAP"];

/** 视图声明表：方框图没有附加内容（A3 起原样），数据流向图带自己的口径条/图例/目标语义层；
 *  思维导图不是 React Flow 渲染器，声明表里没有它（它直接是一个组件，不走画布 header）。
 *  V09-11 起声明**按项目取**（数据流向图的目标语义层要按项目读数据链与覆盖对账），故这里是工厂表。 */
const VIEW_DECL_FACTORIES: Partial<Record<GraphMode, (projectId: string) => ArchViewDecl>> = {
  DATA_FLOW: DATA_FLOW_VIEW,
};

/** V06-06：页签 = 三个主视图 + 技术详情（后者是 A3–N3 那三张图） */
type ArchTab = ProjectViewKind | "tech";

const MAIN_VIEWS: ProjectViewKind[] = ["functional", "architecture", "construction"];

export function ArchView({ project }: { project: ProjectItem }) {
  const { patch } = useProjectScope(project.id);
  const discussObject = useCallback((node: ViewNode) => {
    // 点击时读取该项目最新草稿，避免用旧渲染快照覆盖用户刚输入的内容。
    patch({ view: "chat", chatDraft: appendObjectQuestionDraft(getScope(project.id).chatDraft, project, node) });
  }, [project, patch]);
  /** 页面级页签：默认停在**三个主视图的第一个（功能全景）**——§3.1「项目图默认展示功能全景」（V06-08 切过来） */
  const [tab, setTab] = useState<ArchTab>("functional");
  /** 上一次看过的主视图（从技术详情切回来时接着看它，不重置到第一个页签） */
  const [projectView, setProjectView] = useState<ProjectViewKind>("functional");
  /** 技术详情内的子切换：默认方框图（A3 起的默认视图不变，回归口径不破） */
  const [mode, setMode] = useState<GraphMode>("MODULE_BOX");
  // 思维导图首次进入才挂载（markmap 要真看时才初始化），之后隐藏但不卸载
  const [mindMounted, setMindMounted] = useState(false);
  useEffect(() => {
    if (mode === "MIND_MAP") setMindMounted(true);
  }, [mode]);
  /**
   * V08-06 ②：**技术详情三视图与主视图同源**——一份 v2 派生状态表（模块 id → 上屏键）。
   *
   * 为什么要有它：A5 起这三张图的状态取自 `progress.json` 的 v1 四色（`未开始/已完成`），
   * 与「系统架构 / 功能全景」的 v2 派生状态各说各话（实测 `audit` 模块在技术详情说「未开始」，
   * 事实是已验证通过）。这里按**同一份派生**（`taskDerivedModuleStatus`，附录 D）算一次，
   * 喂给 `ArchCanvas`（方框图 / 数据流向图）与 `MindMapView`（思维导图）；
   * **表里没有的节点（文件/子目录）不再落 v1 旧口径**，由画布如实标「无状态记录」。
   */
  const [statusMap, setStatusMap] = useState<Record<string, string>>({});
  /** V09-13：来源与证据标注模型（服务端同一份派生）——技术详情三图与主视图读同一份，不各算一套 */
  const [provenance, setProvenance] = useState<ProvenanceModel | null>(null);
  /** V09-08 ③：对账 `only_in_code`（带分类）——思维导图那一支也要分类分计，与画布面板同口径 */
  const [onlyInCode, setOnlyInCode] = useState<
    readonly { id: string; name: string; path?: string; category?: string }[]
  >([]);
  /** V09-26：状态色/证据这一层自己也会读失败——**失败不许把状态清空成"无状态"（看着像健康）**，
   *  保留上一次成功读数 + 如实标陈旧；恢复后自行清除。`statusLoads` 是自动重取的可复核计数。 */
  const [statusError, setStatusError] = useState<string | null>(null);
  const [statusLoads, setStatusLoads] = useState(0);
  const projectIdRef = useRef(project.id);
  projectIdRef.current = project.id;
  const loadedForRef = useRef<string | null>(null);
  // V09-26：状态投影/来源标注接进统一对账 token——技术详情**状态色与证据**随账本/文档/证据变化更新
  // （ArchCanvas 的图数据轮询保持原样，不重构）。加载器走**严格有界在途**外壳：同一项目不 abort 在途
  // 请求（慢响应最终落地显示），换项目/卸载 abort 旧请求并丢弃旧回包。
  const token = useProjectRefresh(project.id);
  const load = useCallback((signal: AbortSignal): Promise<void> => {
    // 这一层只喂技术详情（主视图另有自己的 4s 轮询，不重复取数）：没在技术详情页就不读。
    if (tab !== "tech") return Promise.resolve();
    const id = project.id;
    if (loadedForRef.current !== id) {
      loadedForRef.current = id;
      setStatusMap({});
      setProvenance(null);
      setOnlyInCode([]);
      setStatusError(null);
    }
    return Promise.all([
      getArchBlueprint(id, { signal }),
      getStatusProjection(id, { signal }),
      getArchReconcile(id, { signal }).catch(() => ({ exists: false as const })),
    ])
      .then(([bp, proj, rec]) => {
        // 换项目/卸载时 signal 被 abort：旧项目晚到回包一律丢弃（§3.1，A→B→A 也不回退）
        if (signal.aborted || projectIdRef.current !== id) return;
        // V09-08 ③：对账差异清单也给思维导图那一支（技术详情三图口径一致；没有结果就是空表）
        setOnlyInCode(rec.exists ? (rec.result?.only_in_code ?? []) : []);
        // V09-13：来源与证据标注随同一份读口回来（技术详情三图与主视图读同一份）
        setProvenance(bp.provenance ?? null);
        const blueprint = bp.blueprint.exists ? bp.blueprint.blueprint : null;
        if (blueprint !== null) {
          const projection: Record<string, import("../../server/work/statusProjection").StatusProjection> = {};
          for (const o of proj.objects) projection[o.object_id] = o;
          // V09-08 ①②：配对**只有材料点名了实现落点**的才继承状态色（落点未证实/名字信号一律不继承）
          const links = declaredLinksFromMatched(rec.exists ? (rec.result?.matched ?? []) : []);
          const derived = taskDerivedModuleStatus({ blueprint, projection, declared_links: links });
          setStatusMap(moduleStatusKeysOf(derived));
        }
        setStatusError(null);
        setStatusLoads((n) => n + 1);
      })
      .catch((e: unknown) => {
        if (signal.aborted || projectIdRef.current !== id) return;
        // 保留上一次成功的 statusMap/provenance/onlyInCode（不清空成"无状态记录"）
        setStatusError(e instanceof Error ? e.message : String(e));
      });
  }, [project.id, tab]);
  const reload = useBoundedReloader(project.id, load);
  useEffect(() => {
    reload();
  }, [project.id, tab, token, reload]);
  // N3：三视图互相定位的唯一状态（一条单向请求 + 单调递增的请求号）
  const [locate, setLocate] = useState<LocateRequest | null>(null);
  const locateNonceRef = useRef(0);
  // V06-06：定位请求是**项目内**的事——换项目就作废，免得把上一个项目的节点 id 拿去新项目里找
  useEffect(() => {
    setLocate(null);
    setProjectLocate(null);
  }, [project.id]);
  /** V06-06：主视图侧与「技术详情」之间的定位（同一套 nonce 口径） */
  const [projectLocate, setProjectLocate] = useState<ProjectLocateRequest | null>(null);
  /** 发一次定位：切到目标视图 + 把请求交给它（同一模块连点两次也是两次请求，nonce 不同） */
  const requestLocate = useCallback((id: string, label: string, to: ViewKey, from: ViewKey, path?: string) => {
    setMode(to);
    setTab("tech");
    setLocate({ id, label, to, from, path, nonce: (locateNonceRef.current += 1) });
  }, []);
  /** V06-06：主视图/技术详情之间的定位（`to: "tech"` 时交给技术详情画布，id 已由发起方换成 module_id） */
  const requestProjectLocate = useCallback(
    (req: { id: string; label: string; to: ProjectViewKind | "tech"; from: ProjectViewKind | "tech" }) => {
      const nonce = (locateNonceRef.current += 1);
      if (req.to === "tech") {
        setTab("tech");
        setLocate({ id: req.id, label: req.label, to: "MODULE_BOX", from: "MODULE_BOX", nonce });
        return;
      }
      setProjectView(req.to);
      setTab(req.to);
      setProjectLocate({ id: req.id, label: req.label, to: req.to, from: req.from, nonce });
    },
    [],
  );
  const spec = GRAPH_MODES[mode];
  // 画布始终停在"最后一个 React Flow 视图"上（默认方框图）：思维导图由 markmap 画，
  // 用完切回来时画布不重挂、折叠状态与布局记忆都还在。
  const canvasMode: GraphMode = mode === "MIND_MAP" ? "MODULE_BOX" : mode;
  /** V09-11：视图声明按项目取（数据流向图的目标语义层要按项目读）——方框图没有声明，原样返回 undefined */
  const viewDecl: ArchViewDecl | null = VIEW_DECL_FACTORIES[canvasMode]?.(project.id) ?? null;
  /** V09-26：技术详情**状态色/证据**这一层的自动重取状态（给验证脚本与用户一个可复核的口径） */
  const statusAttrs = {
    "data-arch-status-loads": statusLoads,
    "data-arch-status-stale": statusError === null ? "0" : "1",
    ...(statusError === null ? {} : { "data-arch-status-error": statusError }),
  };

  if (tab !== "tech") {
    return (
      <div className="tt-graph-workspace flex min-h-0 flex-1 flex-col" data-arch-tab={tab} {...statusAttrs}>
        <ViewSwitch tab={tab} onPick={(t) => (t === "tech" ? setTab("tech") : (setProjectView(t), setTab(t)))} />
        <ProjectGraphView
          project={project}
          view={projectView}
          locate={projectLocate}
          onLocate={requestProjectLocate}
          onDiscuss={discussObject}
        />
      </div>
    );
  }

  return (
    <div className="tt-graph-workspace flex min-h-0 flex-1 flex-col" data-arch-tab="tech" {...statusAttrs}>
      {/* §3.2：三个主视图与技术详情并列可切换；技术详情内部再切它的三种渲染（下一行） */}
      <ViewSwitch
        tab={tab}
        onPick={(t) => (t === "tech" ? setTab("tech") : (setProjectView(t), setTab(t)))}
      />
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-neutral-800 px-3 py-1.5">
        <nav className="flex gap-1" data-graph-mode-switch>
          {VIEW_MODES.map((m) => (
            <button
              key={m}
              data-graph-mode={m}
              onClick={() => setMode(m)}
              className={`rounded px-2.5 py-1 text-xs ${
                mode === m
                  ? "border border-neutral-700 bg-neutral-800 text-neutral-100"
                  : "text-neutral-500 hover:text-neutral-300"
              }`}
            >
              {GRAPH_MODES[m].label}
            </button>
          ))}
        </nav>
        <span className="text-[11px] text-neutral-500" data-mode-question>
          {spec.question}
        </span>
        <span className="text-[11px] text-neutral-600">
          深入查看代码结构；项目能力、模块协作和工作安排在上方三个视图中。
        </span>
      </div>
      <div className={mode === "MIND_MAP" ? "hidden" : "flex min-h-[120px] flex-1 flex-col"} data-arch-canvas-host>
        <ArchCanvas
          project={project}
          mode={canvasMode}
          header={viewDecl?.header}
          statusOverride={statusMap}
          provenance={provenance}
          // 请求是给思维导图的就不交给画布（画布只在被定为目标时才动视口）
          locate={locate && locate.to !== "MIND_MAP" ? locate : null}
          onLocate={(node) => requestLocate(node.id, node.label, "MIND_MAP", canvasMode, node.path)}
        />
      </div>
      {(mode === "MIND_MAP" || mindMounted) && (
        <div
          className={mode === "MIND_MAP" ? "flex min-h-[120px] flex-1 flex-col" : "hidden"}
          data-mindmap-host
        >
          {/* 未解析时导图给不出顶层节点（节点来自共用数据层），切回方框图走既有"先解析"引导态 */}
          <Suspense
            fallback={
              <div className="flex flex-1 items-center justify-center">
                <p className="text-xs text-neutral-500">思维导图加载中…</p>
              </div>
            }
          >
            <MindMapView
              project={project}
              statusOverride={statusMap}
              onlyInCode={onlyInCode}
              provenance={provenance}
              onNeedParse={() => setMode("MODULE_BOX")}
              locate={locate && locate.to === "MIND_MAP" ? locate : null}
              onLocate={(id, label, to) => requestLocate(id, label, to, "MIND_MAP")}
            />
          </Suspense>
        </div>
      )}
    </div>
  );
}

/** 三个主视图 + 技术详情的切换条（页签唯一出处；`data-project-view-switch` 是验证脚本的锚点） */
function ViewSwitch({ tab, onPick }: { tab: ArchTab; onPick: (t: ArchTab) => void }) {
  return (
    <div className="tt-graph-view-switch flex shrink-0 flex-wrap items-center gap-2 border-b border-neutral-800 px-3 py-1.5">
      <nav className="flex gap-1" data-project-view-switch>
        {MAIN_VIEWS.map((v) => (
          <button
            key={v}
            data-project-view-tab={v}
            onClick={() => onPick(v)}
            aria-pressed={tab === v}
            title={`${PROJECT_VIEWS[v].question}（${PROJECT_VIEWS[v].projection_kind}）`}
            className={`rounded px-2.5 py-1 text-xs ${
              tab === v
                ? "border border-neutral-700 bg-neutral-800 text-neutral-100"
                : "text-neutral-500 hover:text-neutral-300"
            }`}
          >
            {PROJECT_VIEWS[v].label}
          </button>
        ))}
        <button
          data-project-view-tab="tech"
          onClick={() => onPick("tech")}
          aria-pressed={tab === "tech"}
          title="基于代码关系的实现分析详情（模块方框图 / 数据流向图 / 思维导图）"
          className={`rounded px-2.5 py-1 text-xs ${
            tab === "tech"
              ? "border border-neutral-700 bg-neutral-800 text-neutral-100"
              : "text-neutral-500 hover:text-neutral-300"
          }`}
        >
          技术详情
        </button>
      </nav>
      <span className="text-[11px] text-neutral-600">
        {tab === "tech"
          ? "模块方框图 / 数据流向图 / 思维导图"
          : PROJECT_VIEWS[tab as ProjectViewKind].question}
      </span>
    </div>
  );
}
