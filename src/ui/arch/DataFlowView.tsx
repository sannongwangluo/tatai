// F3：数据流向图视图（DESIGN.md §3.2 三视图第二行「数据从哪来、到哪去、谁依赖谁」）。
// 本文件只放**这一种渲染特有的东西**，交互一律复用 A3/A4：画布本体与折叠/展开/下钻/布局记忆
// 全在 `ArchCanvas.tsx`（同一份实现，吃 `mode="DATA_FLOW"`，PLAN F3 DoD③ 的落点）。
// 特有之处两件（即 F1 口径常量在渲染层的落点）：
//   ① 边集合 = 共用全量边的**方向子集**：自环被剔、互惠对归并标 bidirectional、方向翻转为
//      提供者→消费者（`selectGraph("DATA_FLOW", …)` → `selectDataFlowEdges`，本视图不自己过滤）；
//   ② 边视觉：按上游流向角色着色（`edgeStyle.ts` 读 `GRAPH_MODES.DATA_FLOW.edgeColoring`），
//      粗细仍走 §4.3 第 3 招同一映射，互惠边虚线 + 双向箭头。
// 节点色**不因模式改**（`NODE_COLOR_RULE`：仍走 §4.2 四色，与方框图同一份 progress.json）；
// 图例里的数字来自同一份渲染结果（`CanvasInfo`），不是另算一份。
// F4：本文件对外的产物从"一个自渲染的组件"改成**视图声明**（模式键 + 图例），
// 由 `ArchView` 交给唯一的共用画布实例——切视图不重挂画布，是本卡 DoD③（切换不重解析）的实现前提。
//
// V09-11（§3.2／§11.2）：画布画的**仍是**三张技术详情图共用的静态 import 依赖层方向渲染——
// 这是**当前实现**，**不是**业务数据流。这一页在这里**同时**把两句话摆出来、互相区分：
//   · 「当前实现」＝静态依赖层方向渲染（画布本身，`data-flow-current-implementation`）；
//   · 「目标语义」＝输入源 → 处理节点 → 存储 → 输出/外部系统的实际路径（`data-flow-target-semantics`）。
// 目标语义那一层另有一份**来源分层**的数据（实体/关系/端到端数据链/覆盖对账，逐条带出处与验证态），
// 由服务端按项目派生（`GET /arch/dataflow`，与 `get_arch` 返回体同一份），本文件只负责摆出来、可点开。
// **不把画布上的静态依赖边说成/显示成数据流**（红线）；目标语义那层另起区域、明确标注它**不是**画布画的边。
import { useCallback, useEffect, useRef, useState } from "react";
import { useBoundedReloader, useProjectRefresh } from "../useProjectRefresh";
import { type ArchViewDecl, type CanvasInfo } from "../arch/ArchCanvas";
import { BIDIRECTIONAL_DASH, FLOW_EDGE_LEGEND } from "../arch/edgeStyle";
import { DATA_FLOW_EDGE_RULE, DATA_FLOW_DIRECTION, DEP_EDGE_DIRECTION } from "../../arch/graph-mode";
import {
  DATA_FLOW_CURRENT_IMPLEMENTATION_NOTE,
  DATA_FLOW_ENTITY_LABELS,
  DATA_FLOW_PROVENANCE_LABELS,
  DATA_FLOW_RELATION_LABELS,
  DATA_FLOW_TARGET_SEMANTICS_NOTE,
  DATA_FLOW_VERIFICATION_LABELS,
  type DataFlowChain,
  type DataFlowEvidenceRef,
  type DataFlowModel,
} from "./projectGraph";
import { getArchDataFlow } from "../api";

/** 未着色边的色（图例里那条虚线的取色来源） */
const UNCOLORED_EDGE_COLOR = FLOW_EDGE_LEGEND.find((l) => l.role === null)!.color;

/** 验证态的展示色（只在**目标语义那一层**用；画布上的线色仍按 §4.3 的流向角色，不混用） */
const VERIFICATION_TONE: Readonly<Record<string, string>> = {
  verified: "text-emerald-400",
  unverified: "text-amber-400",
  missing: "text-rose-400",
};

export function EvidenceList({ evidence }: { evidence: DataFlowEvidenceRef[] }) {
  if (evidence.length === 0) return <p className="text-neutral-500">没有有效出处（缺证）</p>;
  return (
    <ul className="space-y-0.5">
      {evidence.map((r, i) => (
        <li key={`${r.locator}-${i}`} data-flow-evidence={r.tier}>
          <span className="text-neutral-400">[{DATA_FLOW_PROVENANCE_LABELS[r.tier]}]</span>{" "}
          <span className="font-mono text-neutral-300">{r.locator}</span>
          <span className="text-neutral-500">
            {" "}
            · 定位「{r.find}」{r.rerun === null ? "" : ` · 复跑 ${r.rerun}`}
          </span>
          <div className="text-neutral-500">{r.note}</div>
        </li>
      ))}
    </ul>
  );
}

/** 端到端数据链：逐跳可点开追到出处与验证态（缺环／缺证如实标，不冒充「已验证」） */
function ChainPanel({ chain }: { chain: DataFlowChain }) {
  return (
    <div data-flow-chain={chain.id} data-flow-chain-verification={chain.verification}>
      <p className="text-neutral-400">
        端到端数据链：{chain.label} ·{" "}
        <span className={VERIFICATION_TONE[chain.verification]}>
          {DATA_FLOW_VERIFICATION_LABELS[chain.verification]}
        </span>
        {chain.missing_kinds.length > 0 && (
          <span className="text-rose-400"> · 缺实体类别 {chain.missing_kinds.join("、")}</span>
        )}
        <span className="text-neutral-500">（逐跳点开看出处与验证态）</span>
      </p>
      <ol className="space-y-0.5">
        {chain.hops.map((h) => (
          <li key={`${chain.id}-${h.index}`}>
            <details data-flow-hop={h.node_id} data-flow-hop-index={h.index} data-flow-hop-verification={h.verification}>
              <summary className="cursor-pointer text-neutral-300">
                {h.index}. {h.node_id}
                <span className="text-neutral-500">
                  {" "}
                  · {h.role}
                  {h.edge_id === null ? "（链的输入源）" : ` · 关系 ${h.edge_id}`}
                </span>
              </summary>
              <div className="mt-1 space-y-0.5 pl-4 text-neutral-400">
                <p>
                  节点验证态：<span className={VERIFICATION_TONE[h.verification]}>{DATA_FLOW_VERIFICATION_LABELS[h.verification]}</span>
                </p>
                <EvidenceList evidence={h.evidence} />
              </div>
            </details>
          </li>
        ))}
      </ol>
      <p className="text-neutral-500">{chain.note}</p>
    </div>
  );
}

/**
 * 目标语义层：实体／关系／数据链／覆盖对账（**不是**画布上那些静态依赖边）。
 * 数据来自服务端同一份派生（与 `get_arch` 返回体同一份），读不到就如实说读不到。
 */
export function DataFlowTargetPanel({
  model,
  error,
  loads,
}: {
  model: DataFlowModel | null;
  error: string | null;
  loads?: number;
}) {
  return (
    // 默认只给资料入口；失败与缺声明常显，完整资料在有界滚动区，不让技术说明挤没画布。
    <div
      className="mt-1 space-y-1 border-t border-neutral-800 pt-1"
      data-flow-target-layer
      data-flow-target-stale={error !== null ? "1" : "0"}
      {...(loads === undefined ? {} : { "data-flow-target-loads": loads })}
    >
      {error !== null && (
        <p className="text-rose-400" data-flow-state="load_failed">
          目标语义层读不到（不是「本项目没有数据流」）：{error}
          {model === null ? "" : "（下面显示的是上一次成功读到的数据，不是最新事实）"}
        </p>
      )}
      {/* V09-26：失败**保留最后成功读数**（不清空、不装成"本项目没有数据流"） */}
      {model === null && error === null && (
        <p className="text-neutral-500" data-flow-state="loading">正在读数据链与来源分层…</p>
      )}
      {model !== null && model.coverage.declared_total === 0 && (
        <p className="text-amber-400" data-flow-state="no_declaration">
          {model.coverage.note}
        </p>
      )}
      <details className="tt-graph-tech-notes" data-flow-material-details>
        <summary>业务数据路径与求证资料{model === null ? "" : `（${model.chains.length} 条数据链，需逐条核对）`}</summary>
        <div className="tt-graph-tech-content">
          <p className="text-neutral-400" data-flow-target-semantics>{DATA_FLOW_TARGET_SEMANTICS_NOTE}</p>
          {model !== null && model.coverage.declared_total > 0 && <DataFlowModelView model={model} />}
        </div>
      </details>
    </div>
  );
}

/** 有数据时的正文（与取数分开：验证脚本可以拿真实模型直接渲染这一段，做页面级断言） */
export function DataFlowModelView({ model }: { model: DataFlowModel }) {
  return (
    <>
      <p className="text-neutral-500" data-flow-summary>
        实体 {model.nodes.length} 个（
        {(["input_source", "process", "store", "output_external"] as const)
          .map((k) => `${DATA_FLOW_ENTITY_LABELS[k]} ${model.nodes.filter((n) => n.kind === k).length}`)
          .join(" · ")}
        ） · 关系 {model.edges.length} 条 · 数据链 {model.chains.length} 条 · 本次复算剔除出处 {model.scan.claims_dropped} 条
      </p>
      {model.chains.map((c) => (
        <ChainPanel key={c.id} chain={c} />
      ))}
      <details data-flow-entities>
        <summary className="cursor-pointer text-neutral-300">
          实体（{DATA_FLOW_ENTITY_LABELS.input_source}／{DATA_FLOW_ENTITY_LABELS.process}／{DATA_FLOW_ENTITY_LABELS.store}／
          {DATA_FLOW_ENTITY_LABELS.output_external}）
        </summary>
        <div className="max-h-32 space-y-0.5 overflow-auto pl-4">
          {model.nodes.map((n) => (
            <details
              key={n.id}
              data-flow-node={n.id}
              data-flow-entity-kind={n.kind}
              data-flow-provenance={n.provenance}
              data-flow-verification={n.verification}
            >
              <summary className="cursor-pointer text-neutral-300">
                {n.label}
                <span className="text-neutral-500">
                  {" "}
                  · {DATA_FLOW_ENTITY_LABELS[n.kind]} · 来源 {DATA_FLOW_PROVENANCE_LABELS[n.provenance]} ·{" "}
                  <span className={VERIFICATION_TONE[n.verification]}>{DATA_FLOW_VERIFICATION_LABELS[n.verification]}</span>
                </span>
              </summary>
              <div className="space-y-0.5 pl-4 text-neutral-400">
                <p>{n.role}</p>
                <EvidenceList evidence={n.evidence} />
              </div>
            </details>
          ))}
        </div>
      </details>
      <details data-flow-relations>
        <summary className="cursor-pointer text-neutral-300">
          关系（数据的{DATA_FLOW_RELATION_LABELS.produce}／{DATA_FLOW_RELATION_LABELS.transfer}／
          {DATA_FLOW_RELATION_LABELS.read_write}／{DATA_FLOW_RELATION_LABELS.transform}；每条带稳定 ID、方向、出处与验证态）
        </summary>
        <div className="max-h-32 space-y-0.5 overflow-auto pl-4">
          {model.edges.map((e) => (
            <details
              key={e.id}
              data-flow-edge={e.id}
              data-flow-relation={e.relation}
              data-flow-provenance={e.provenance}
              data-flow-verification={e.verification}
            >
              <summary className="cursor-pointer text-neutral-300">
                {e.label}
                <span className="text-neutral-500">
                  {" "}
                  · {DATA_FLOW_RELATION_LABELS[e.relation]} · {e.from} → {e.to}（方向 {e.direction}） · 来源{" "}
                  {DATA_FLOW_PROVENANCE_LABELS[e.provenance]} ·{" "}
                  <span className={VERIFICATION_TONE[e.verification]}>{DATA_FLOW_VERIFICATION_LABELS[e.verification]}</span>
                </span>
              </summary>
              <div className="space-y-0.5 pl-4 text-neutral-400">
                <p className="font-mono text-neutral-500">{e.id}</p>
                <p>{e.note}</p>
                <EvidenceList evidence={e.evidence} />
                {e.static_clues.length > 0 && (
                  <p className="text-neutral-500" data-flow-static-clue>
                    静态 import／字符串线索（**只作线索**，不算出处档位）：{e.static_clues.join("；")}
                  </p>
                )}
              </div>
            </details>
          ))}
        </div>
      </details>
      <details data-flow-coverage>
        <summary className="cursor-pointer text-neutral-300">
          覆盖对账：所声明的数据输入／存储／输出逐条（{model.coverage.covered}/{model.coverage.declared_total} 有路径，
          缺路径 {model.coverage.missing}，设计明写未实现 {model.coverage.not_implemented}）
        </summary>
        <div className="max-h-32 space-y-0.5 overflow-auto pl-4">
          {model.coverage.rows.map((r) => (
            <div
              key={r.artifact}
              data-flow-coverage-row={r.artifact}
              data-flow-coverage-path-found={r.path_found ? "true" : "false"}
              className={r.path_found ? "text-neutral-400" : r.declaration_status === "current" ? "text-rose-400" : "text-neutral-500"}
            >
              {r.artifact} · {DATA_FLOW_ENTITY_LABELS[r.kind]} · 设计出处 {r.design_locator}
              {r.path_found ? ` · 证据 ${r.evidence.length} 条` : ` · ${r.gap ?? ""}`}
            </div>
          ))}
        </div>
        <p className="text-neutral-500">{model.coverage.note}</p>
      </details>
      <p
        data-flow-blocked={model.deliverable_blocked ? "true" : "false"}
        className={model.deliverable_blocked ? "text-rose-400" : "text-neutral-500"}
      >
        {model.deliverable_blocked
          ? `**不得得出「项目可交付」结论**（${model.blockers.length} 条）：${model.blockers.join("；")}`
          : "覆盖对账未发现缺路径：本项目声明的数据输入/存储/输出逐条有路径与证据"}
      </p>
      <p className="text-neutral-600">{model.scan.notes.join(" ")}</p>
    </>
  );
}

export function useDataFlowModel(projectId: string) {
  const [model, setModel] = useState<DataFlowModel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loads, setLoads] = useState(0);
  const projectRef = useRef(projectId);
  projectRef.current = projectId;
  /** V09-26：换项目才清现场；周期对账失败保留最后一次成功读数 */
  const loadedForRef = useRef<string | null>(null);
  const load = useCallback((signal: AbortSignal): Promise<void> => {
    if (loadedForRef.current !== projectId) {
      loadedForRef.current = projectId;
      setModel(null);
      setError(null);
    }
    return getArchDataFlow(projectId, { signal })
      .then((m) => {
        // 换项目/卸载时 signal 被 abort：旧项目晚到回包一律丢弃（§3.1）
        if (signal.aborted || projectRef.current !== projectId) return;
        setModel(m);
        setError(null);
        setLoads((n) => n + 1);
      })
      .catch((e: unknown) => {
        if (signal.aborted || projectRef.current !== projectId) return;
        setError(e instanceof Error ? e.message : String(e));
      });
  }, [projectId]);
  // V09-26：目标语义层（证据/覆盖对账只有文件变化时账本序号不动）接统一对账 token
  const token = useProjectRefresh(projectId);
  const reload = useBoundedReloader(projectId, load);
  useEffect(() => {
    reload();
  }, [projectId, token, reload]);
  return { model, error, loads };
}

function TargetSemanticsPanel({ projectId }: { projectId: string }) {
  const { model, error, loads } = useDataFlowModel(projectId);
  return <DataFlowTargetPanel model={model} error={error} loads={loads} />;
}

/** 数据流向图的口径条 + 图例：色=上游流向角色、虚线=互惠依赖、粗细=依赖权重（§4.3 第 3 招） */
export function FlowLegend({ info, projectId }: { info: CanvasInfo; projectId: string }) {
  const countOf = (role: string | null) =>
    role === "flow_source"
      ? info.colors.flow_source
      : role === "flow_relay"
        ? info.colors.flow_relay
        : info.colors.uncolored;
  return (
    <div
      className="max-h-48 shrink-0 space-y-1 overflow-auto border-b border-neutral-800 px-3 py-1.5 text-[12px]"
      data-flow-legend
    >
      <p className="text-amber-400" data-flow-current-implementation>当前画布展示代码之间的引用关系，不代表业务数据已经流通。</p>
      <details className="tt-graph-tech-notes" data-flow-display-details>
        <summary>连线含义与技术说明</summary>
        <div className="tt-graph-tech-content">
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-neutral-400">
        <span className="text-neutral-300">数据流向图</span>
        <span className="text-neutral-600">数据从哪来、到哪去、谁依赖谁</span>
        {FLOW_EDGE_LEGEND.map((l) => (
          <span key={l.label} className="flex items-center gap-1" title={l.hint}>
            <span
              className="inline-block h-0.5 w-5 rounded"
              style={{ backgroundColor: l.color }}
              data-legend-color={l.role ?? "none"}
            />
            <span>{l.label}</span>
            <span className="text-neutral-600">{countOf(l.role)} 条</span>
          </span>
        ))}
        <span
          className="flex items-center gap-1"
          title="A↔B 互相 import：归并成一条，不画两条互相矛盾的箭头"
        >
          <span
            className="inline-block h-0.5 w-5 rounded"
            style={{
              backgroundImage: `repeating-linear-gradient(90deg, ${UNCOLORED_EDGE_COLOR} 0 4px, transparent 4px 7px)`,
            }}
            data-legend-dash={BIDIRECTIONAL_DASH}
          />
          <span>虚线双向＝互惠依赖</span>
          <span className="text-neutral-600">{info.bidirectional} 条</span>
        </span>
        <span title="§4.3 第 3 招：聚合边的粗细表示依赖强度">
          粗细＝依赖权重（本次 {info.strokeWidths.join("/") || "1"} 档）
        </span>
        <span className="text-neutral-500" data-flow-node-role>
          节点角色：源头 {info.roles.source} · 中继 {info.roles.relay} · 终点 {info.roles.sink} ·
          孤立 {info.roles.isolated}
        </span>
      </p>
      <p className="text-neutral-600">
        同一份静态依赖数据的方向取向渲染：依赖方向 {DEP_EDGE_DIRECTION}（方框图口径）→ 本视图{" "}
        {DATA_FLOW_DIRECTION}；全量边 {info.stats.all_edges} 条 → 本视图 {info.stats.view_edges} 条（
        {DATA_FLOW_EDGE_RULE.steps.join(" → ")}：剔自环 {info.stats.dropped_self_loop} · 互惠对归并{" "}
        {info.stats.merged_mutual_pairs} 对）；节点 {info.nodes} 个（与方框图同一份节点集合）。 节点色仍是模块四色
        （§4.2），只有边随方向着色。布局记忆**按视图分键**存于 `.工作台/arch/layout.json`
        （`positions.DATA_FLOW`，F4 起与方框图互不覆盖——两图 dagre 分层方向相反，共用一份坐标会切视图跳位）。
      </p>
      {/* V09-11 ①：两句话同时可见、互相区分——上面这段说的是「画布画的是什么」，下面两行分开说清 */}
      <p className="text-amber-400">
        {DATA_FLOW_CURRENT_IMPLEMENTATION_NOTE}
      </p>
      <p className="text-neutral-500" data-flow-not-business-flow>
        本画布上的线与节点不是业务数据流，它画的是代码依赖方向。
      </p>
        </div>
      </details>
      <TargetSemanticsPanel projectId={projectId} />
    </div>
  );
}

/**
 * 数据流向图视图声明（§3.2 表格第二行）：本视图的模式键 + 画布上方那行口径条/图例/来源分层面板。
 * F4 起交给**同一个**共用画布实例（`ArchView` 按当前模式取声明），切视图不重挂画布：
 * 折叠状态、子级缓存、两视图各自的布局记忆都留在画布 state 里，切换只换选择器。
 * V09-11 起声明**按项目取**（目标语义那一层要按项目读数据链与覆盖对账），故这里是工厂函数。
 */
export const DATA_FLOW_VIEW = (projectId: string): ArchViewDecl => ({
  mode: "DATA_FLOW",
  header: (info) => <FlowLegend info={info} projectId={projectId} />,
});
