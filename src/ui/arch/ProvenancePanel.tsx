// V09-13／V09-20：来源/证据标注与交付阻断的**共享渲染件**（六个画布调用点共用一份，不各写一套）。
//
// 为什么单独一个组件文件：卡面点名「分类与证据状态不得在两个 UI 文件各写一套」。判据在
// `provenance.ts`（零 React / 零 IO），**上屏形态**在本文件——`ArchCanvas`（技术详情画布：
// 模块方框图＋数据流向图）、`ProjectGraphView`（三个主视图）、`MindMapView`（思维导图）都 import：
//   · `GraphAttentionBar`：六图的「来源与证据」信息栏——交付读数（「不可判定项目可交付」/「可请求验收」
//     ＋逐条点名＋人工待验）与待审线索**合成一条**，健康态不占常驻行、有问题恰好一行（判据
//     `attentionCountsOf`，只此一份；§3.11／§4.2）；
//   · `ObjectProvenanceLines`：单个对象的来源种类、映射与证据状态（逐条不省略）；
//   · `IntraRelationPanel`：同组关系逐条可点开追来源（§3.2；反例＝只在文字里解释 ⇒ 不合格）。
// 三处各写一套的后果是把"用户待验"在一处显示成"已验证"——所以形态只有这一份。
import { useRef } from "react";
import {
  DELIVERY_BLOCKED_CONCLUSION,
  DELIVERY_REQUESTABLE_CONCLUSION,
  EVIDENCE_STATE_ORDER,
  EVIDENCE_STATE_PALETTE,
  UNMAPPED_BADGE_CLASS,
  USER_PENDING_LABEL,
  evidenceBadgeClassOf,
  intraRelationSourceKinds,
  type DeliveryReadout,
  type ModelLeadInfo,
  type ModelNodeLeadInfo,
  type ProvenanceAnnotation,
  type ProvenanceModel,
  type IntraGroupRelation,
} from "./provenance";
import {
  UNRESOLVED_REAL_GAP_REASONS,
  UNRESOLVED_REASON_LABELS,
  type UnresolvedEndpointReason,
  type UnresolvedRelation,
} from "./projectGraph";

/** 待审线索的处置短标（§4.1／附录 E.17 裁定 1–2 的两种处置；**不留第三种口气**） */
const MODEL_LEAD_DISPOSITION_LABEL: Record<ModelLeadInfo["disposition"], string> = {
  confirmed_by_derivation: "与确定性派生独立命中（冗余留痕）",
  lead_pending_review: "待审线索：不进成员/绿态/交付读数",
};

/** 只用于默认界面文案；原始标签与机器读数保持原样。 */
export function readableGraphLabel(label: string): string {
  return ({ "未映射": "尚无对应资料", "缺证": "缺少验证依据", "缺标注": "尚无验证记录", "不可判定项目可交付": "还不能确认已做好" } as Record<string, string>)[label] ?? label;
}

/** 一个对象的完整标注（详情面板用；逐条列出来源、映射与证据，不省略标注） */
export function ObjectProvenanceLines({ annotation }: { annotation: ProvenanceAnnotation }) {
  const st = EVIDENCE_STATE_PALETTE[annotation.evidence_state];
  return (
    <ul className="space-y-0.5" data-provenance-detail={annotation.object_id}>
      <li className="text-[11px] text-neutral-400" data-provenance-source-kinds={annotation.source_kinds.join("+") || "unmapped"}>
        来源种类：{annotation.source_kind_label}
      </li>
      <li className="text-[11px] text-neutral-400">
        映射：需求 {annotation.mapping.requirement_ids.join("、") || "（无）"} ·
        设计 {annotation.mapping.design_refs.map((r) => `${r.path} ${r.locator}`).join("；") || "（无）"} ·
        代码 {annotation.mapping.code_refs.map((r) => `${r.locator}`).join("；") || "（无）"}
        {annotation.mapping.dangling_requirement_ids.length > 0
          ? `（悬空需求引用：${annotation.mapping.dangling_requirement_ids.join("、")}）`
          : ""}
      </li>
      <li
        className="text-[11px] text-neutral-300"
        data-provenance-evidence-state={annotation.evidence_state}
        data-provenance-evidence-label={st.short}
      >
        证据状态：{st.short}（{st.full}）
      </li>
      <li className="text-[11px] text-neutral-500">{annotation.basis}</li>
      {annotation.verification_passed && annotation.user_pending && (
        <li className="text-[11px] text-cyan-300" data-provenance-pending={annotation.object_id}>
          {USER_PENDING_LABEL}：{annotation.user_actions.join("；")}——由用户本人记录，**Agent 不代签**
        </li>
      )}
      {annotation.blockers.length > 0 && (
        <li className="text-[11px] text-rose-300" data-provenance-blockers={annotation.blockers.length}>
          阻断交付：{annotation.blockers.join(" / ")}
        </li>
      )}
    </ul>
  );
}

/**
 * 六图信息栏的**判据**（只此一份）：由交付读数、待审线索与关系缺口算出「这条栏要不要出现、要列哪几类」。
 * 纯函数、零 React、零 IO——六张图共用，不各写一套。
 *
 * **可行动异常**（任一存在 ⇒ 出栏）：
 *   · 交付阻断：未映射／未验证／缺证／证据失效（按档计数，逐条原因在详情里）；
 *   · 能力分类未定（R-1：能力分类声明表损坏 ⇒ 该章不按功能能力计数，§3.2）；
 *   · 待审线索（`lead_pending_review`，关系侧＋节点侧，§4.1／附录 E.17／E.18）；
 *   · 关系未画出（**真实缺口**）：本视图里端点解析不到可见分组、且成因为 `no_ownership`／`missing_node`
 *     的关系条数（§3.3「隐藏≠没有」／§4.5「待归属」）。只按**已有的**分类常量计数——
 *     **合理结果**（`folded_group` 折叠／`governance_excluded` 分类排除）**不计入异常**。
 * **不是异常**（不出栏、不占常驻行）：`可请求验收`／`尚未验收`／人工待验（`user_pending`）——
 * 人工验收待用户本人记录，读数里始终 `user_accepted=false`，不代签（§5.8）。
 */
export interface AttentionCounts {
  /** 交付阻断（按档；`total`＝四档之和） */
  blocking: { unmapped: number; unverified: number; missing: number; invalidated: number; total: number };
  /** 能力分类未定（能力分类声明表损坏导致的「分类未定」能力数） */
  unclassified: number;
  /** 待审线索（关系侧＋节点侧；`total`＝两处之和） */
  pending_leads: { relations: number; nodes: number; total: number };
  /**
   * 关系未画出：本视图里端点解析不到可见分组的**真实缺口**条数（只数 `no_ownership`／`missing_node`）。
   * **机械关系缺口，不是业务失败**——只给计数与逐条名单，不给完成色、不改交付判词（§3.3／§4.5）。
   */
  unresolved_gaps: { total: number; no_ownership: number; missing_node: number };
  /** 有可行动异常 ⇒ 信息栏出现（false = 健康态，整条不占任何常驻行） */
  any: boolean;
}

export function attentionCountsOf(
  delivery: DeliveryReadout,
  leads: readonly ModelLeadInfo[] = [],
  nodeLeads: readonly ModelNodeLeadInfo[] = [],
  unresolved: readonly UnresolvedRelation[] = [],
): AttentionCounts {
  const c = delivery.counts;
  const relations = leads.filter((l) => l.disposition === "lead_pending_review").length;
  const nodes = nodeLeads.filter((l) => l.disposition === "lead_pending_review").length;
  const total = c.unmapped + c.unverified + c.missing + c.invalidated;
  // 关系未画出：只取**真实缺口**两类（机械关系缺口——待归属／缺节点），复用唯一分类常量；
  // 合理结果（折叠／分类排除）**不计入**异常，也不进这条栏（§3.3／§3.2）。
  const gaps = unresolved.filter((r) => UNRESOLVED_REAL_GAP_REASONS.includes(r.reason));
  const unresolved_gaps = {
    total: gaps.length,
    no_ownership: gaps.filter((r) => r.reason === "no_ownership").length,
    missing_node: gaps.filter((r) => r.reason === "missing_node").length,
  };
  return {
    blocking: { unmapped: c.unmapped, unverified: c.unverified, missing: c.missing, invalidated: c.invalidated, total },
    unclassified: c.capability_unclassified,
    pending_leads: { relations, nodes, total: relations + nodes },
    unresolved_gaps,
    any: total > 0 || c.capability_unclassified > 0 || relations + nodes > 0 || unresolved_gaps.total > 0,
  };
}

/**
 * **六图的「来源与证据」信息栏**——交付读数与待审线索**合成一条**（V09-20 回归修复，2026-09-27 用户指令）。
 *
 * 背景（用户实测反例）：三个主视图曾在画布上方**连续**渲染两块常驻信息区
 * （`delivery_readout` ＋ `model_leads`），于是健康态也占一行、有待审线索时占两排——
 * 画布被两排文字挤掉一截；V09-20 只压缩了前者。
 *
 * 现行口径（§3.11／§4.2，判据见 `attentionCountsOf`）：
 *   · **健康态 = 0 行**：交付无阻断、能力分类未定 0、没有待审线索时，整条栏**不占任何常驻行**
 *     （不渲染折叠件——不是"把长条折起来"）；完整机器读数仍在 `data-delivery-*` 上，HTTP/MCP 读口一字不改。
 *   · **有问题 = 恰好一行**：任一可行动异常存在时，图面只出现**一条合并问题栏**——白话摘要逐类给数量
 *     ＋一个查看入口；`可请求验收` 旁边仍写「尚未验收」（防被读成已接受）。
 *   · **详情是浮层**：`absolute right-0 top-full`，限高 ＋ 独立滚动 ＋ 可关闭，展开**不吃画布**；
 *     完整计数、五档图例、逐条阻断、逐条人工待验、逐条待审线索都在里面（收起≠删数据，不抽样、不给百分比）。
 *
 * 六图的六个调用点（功能全景／系统架构／施工依赖／模块方框图／数据流向图／思维导图）都读这一份，
 * 不各写一套；本件不改证据判据、不写颜色、不代签用户 Gate。
 */
export function GraphAttentionBar({
  delivery,
  leads = [],
  nodeLeads = [],
  unresolvedRelations = [],
  resolveUnresolvedTarget,
  onOpenUnresolvedTarget,
  anchor,
  title = "交付结论",
}: {
  delivery: DeliveryReadout;
  /** 关系侧待审线索（§4.1／附录 E.17）；为空即视为没有 */
  leads?: readonly ModelLeadInfo[];
  /** 节点侧待审线索（R-2／附录 E.18）；为空即视为没有 */
  nodeLeads?: readonly ModelNodeLeadInfo[];
  /**
   * 本视图里**端点解析不到可见分组**的关系（`ProjectViewModel.unresolved_relations`，**全量**：
   * 含合理折叠/分类排除与真实缺口）。传入即把它们接进**这一条**信息栏的按需详情；
   * 不传（技术三图 / 思维导图等没有这份账的调用点）行为一字不变。真实缺口（`no_ownership`／
   * `missing_node`）会让这条栏出现并给计数；合理结果不触发（§3.3／§4.5）。
   */
  unresolvedRelations?: readonly UnresolvedRelation[];
  /** 落空端点 → 当前画布上的可见对象显示名（null = 本视图画布上没有它，**如实给原因、不做假跳转**） */
  resolveUnresolvedTarget?: (planId: string) => string | null;
  /** 点开一个可见对象（跳转由调用方按本视图画布实现；没有可见对象时不调用） */
  onOpenUnresolvedTarget?: (planId: string) => void;
  /** 数据锚点（六图各自的稳定标识；`data-delivery-readout` 沿用 V09-13 的读法） */
  anchor: string;
  title?: string;
}) {
  const detailsRef = useRef<HTMLDetailsElement | null>(null);
  const c = delivery.counts;
  const attn = attentionCountsOf(delivery, leads, nodeLeads, unresolvedRelations);
  const blocked = attn.blocking.total > 0 || delivery.verdict === "blocked";
  // 默认行上的「简短原因」：各档阻断的构成（条数按档，逐条原因在浮层里）
  const composition = (
    [["来源未对应", attn.blocking.unmapped], ["未验证", attn.blocking.unverified], ["缺少验证依据", attn.blocking.missing], ["证据失效", attn.blocking.invalidated]] as const
  )
    .filter(([, n]) => n > 0)
    .map(([label, n]) => `${label} ${n}`)
    .join("·");
  const closeDetail = () => {
    if (detailsRef.current !== null) detailsRef.current.open = false;
  };
  // 完整机器读数：**健康态照样读得到**（信息栏不出，数据不删；§3.11／§4.2）
  const readings = {
    "data-delivery-readout": anchor,
    "data-delivery-verdict": delivery.verdict,
    "data-delivery-conclusion": delivery.conclusion,
    "data-delivery-allowed": delivery.deliverable_allowed ? "1" : "0",
    "data-delivery-reasons": delivery.reasons.length,
    "data-delivery-user-pending": delivery.user_pending.length,
    "data-delivery-counts": Object.entries(delivery.counts)
      .map(([k, v]) => `${k}=${v}`)
      .join(","),
    "data-graph-info-bar": anchor,
    "data-graph-info-rows": attn.any ? "1" : "0",
    "data-graph-info-blocking": attn.blocking.total,
    "data-graph-info-unclassified": attn.unclassified,
    "data-graph-info-pending-leads": attn.pending_leads.total,
  };
  if (!attn.any) {
    // 健康态：**不占任何常驻行**——零高、无边框无内边距、无折叠件；机器读数照旧可读（§3.11）
    return <section {...readings} data-graph-info-healthy="1" className="p-0" />;
  }
  return (
    <section className="relative shrink-0 border-b border-neutral-800 px-3 py-1 text-[11px]" {...readings}>
      <details className="group" ref={detailsRef}>
        {/* 有问题：**就这一条合并栏**（§3.11）。结论徽标带色——颜色之外还有文字通道。 */}
        <summary className="flex cursor-pointer flex-wrap items-center gap-2" data-graph-info-summary data-delivery-expand>
          <span className="text-neutral-400">{title}</span>
          <span
            className={`rounded border px-1.5 py-0.5 font-semibold ${
              blocked
                ? "border-rose-700 bg-rose-900/40 text-rose-300"
                : delivery.verdict === "requestable"
                  ? "border-amber-700 bg-amber-900/40 text-amber-200"
                  : "border-neutral-600 bg-neutral-800 text-neutral-300"
            }`}
            data-delivery-conclusion-badge={delivery.conclusion}
          >
            {readableGraphLabel(delivery.conclusion)}
          </span>
          {blocked ? (
            <>
              {/* 有阻断：条数 + 各档构成（简短原因）——异常不因收起而看不见 */}
              <span className="font-semibold text-rose-300" data-delivery-brief-blocked={attn.blocking.total}>
                阻断 {attn.blocking.total} 项{composition === "" ? "" : `（${composition}）`}
              </span>
            </>
          ) : (
            <>
              {/* 无阻断：**必带「尚未验收」限定**——「可请求验收」不得被读成用户已接受（§4.2／§5.8） */}
              <span className="text-neutral-300" data-delivery-brief-not-accepted>
                尚未验收
              </span>
              {delivery.user_pending.length > 0 && (
                <span className="text-cyan-300" data-delivery-brief-pending={delivery.user_pending.length}>
                  {delivery.user_pending.length} 项待你确认
                </span>
              )}
            </>
          )}
          {/* 另两类可行动异常逐类给数量（白话；不与上面重复成两排） */}
          {attn.unclassified > 0 && (
            <span
              className="font-semibold text-amber-300"
              data-delivery-capability-unclassified-brief={attn.unclassified}
              title="能力分类未定：能力分类声明表损坏，该章不按功能能力计数（§3.2／R-1）"
            >
              分类未定 {attn.unclassified} 个
            </span>
          )}
          {attn.pending_leads.total > 0 && (
            <span
              className="text-amber-300"
              data-graph-info-leads-brief={attn.pending_leads.total}
              title="待审线索（模型提案·未审定）：不进成员、绿态与交付读数（§4.1／附录 E.17／E.18；逐条见详情）"
            >
              待审线索 {attn.pending_leads.total} 条
            </span>
          )}
          {/* 关系未画出：**真实缺口**（待归属／缺节点）在默认行给计数与入口——机械关系缺口，
              不涂成业务失败、不改交付判词；合理结果（折叠／分类排除）不触发这枚标（§3.3／§4.5）。 */}
          {attn.unresolved_gaps.total > 0 && (
            <span
              className="text-amber-300"
              data-graph-info-unresolved-gaps-brief={attn.unresolved_gaps.total}
              title="关系未画出：本视图里有关系的端点在蓝图里待归属/缺节点，画不出可见分组——机械关系缺口，不是业务失败（逐条见详情，§3.3／§4.5）"
            >
              关系未画出 {attn.unresolved_gaps.total} 条
            </span>
          )}
          <span className="text-neutral-400">{blocked ? "查看原因" : "查看详情"}</span>
        </summary>
        {/* 详情浮层：不占纵向排版（画布高度不受影响），限高 + 独立滚动 + 可关闭（§3.11）。
            交付读数与待审线索**都在这同一份详情里**——信息区只有这一条栏、一个入口。 */}
        <div
          className="absolute right-0 top-full z-50 max-h-[60vh] w-[620px] max-w-[94vw] space-y-1 overflow-y-auto rounded-b border border-neutral-700 bg-neutral-950/95 p-2 shadow-2xl"
          data-graph-info-detail-body
          data-delivery-detail-body
        >
          <div className="flex items-center gap-2 border-b border-neutral-800 pb-1">
            <span className="font-semibold text-neutral-200">{title}·详情</span>
            <span className="text-neutral-500">完整计数、五档含义、逐条阻断、逐条待验与逐条待审线索（不抽样，§3.11）</span>
            <button
              type="button"
              data-graph-info-detail-close
              data-delivery-detail-close
              onClick={closeDetail}
              className="ml-auto shrink-0 rounded border border-neutral-700 px-1.5 py-0.5 text-neutral-300 hover:bg-neutral-800"
            >
              关闭
            </button>
          </div>
          {/* 完整计数（条数，不是完成率；P9 不给百分比） */}
          <p className="text-neutral-400" data-delivery-counts-full>
            对象 {c.objects} 个 · 未映射 {c.unmapped} · 未验证 {c.unverified} · 缺证 {c.missing} · 证据失效{" "}
            {c.invalidated} · 已验证 {c.verified}（来源核实 {c.verified_source_mapping}／功能验证{" "}
            {c.verified_functional}） · 用户待验 {c.user_pending}
          </p>
          {/* 五档证据状态的**图例**（唯一词表 `EVIDENCE_STATE_PALETTE`＋未映射色）：每一档自带短标与徽标色，
              五档**在同一行上靠词与色两通道可区分**（§4.2：颜色之外还有文字通道）。计数是**条数、不是完成率**（P9）。 */}
          <span className="flex flex-wrap items-center gap-1" data-delivery-counts-text data-delivery-state-legend="1">
            <span className={`rounded border px-1 py-0.5 ${UNMAPPED_BADGE_CLASS}`} data-delivery-state-chip="unmapped">
              未映射 {delivery.counts.unmapped}
            </span>
            {EVIDENCE_STATE_ORDER.map((s) => (
              <span
                key={s}
                className={`rounded border px-1 py-0.5 ${evidenceBadgeClassOf(s)}`}
                data-delivery-state-chip={s}
                data-delivery-state-chip-label={EVIDENCE_STATE_PALETTE[s].short}
                // 提示语取 `full`（一句话说明），**不取 `hint`**：`hint` 是更长的那句规范话，
                // 里面写着「不得写成已接受」——它是**禁止性**措辞，但渲染进属性后会撞上
                // `verify-v09-13.ts` ③ 的关键词扫描（该扫描把渲染出来的面板 HTML 里出现
                // 「已接受」当违规信号，只剥掉「不代签/不得/不把/不会是」）。判据不动，
                // 这里换用同一份词表里不带该词的说明句；规范话仍在逐对象明细里逐条给出。
                title={EVIDENCE_STATE_PALETTE[s].full}
              >
                {EVIDENCE_STATE_PALETTE[s].short} {delivery.counts[s]}
              </span>
            ))}
          </span>
          {/* §3.2 能力分类（2026-09-26 GPT-6 裁定 7）：设计/治理章节**不是产品功能能力**——
              本读数里单独分计，明写它**不计入产品能力计数**；有治理章节时这句才出现（没有就不摆一行零）。 */}
          {delivery.counts.capability_governance > 0 && (
            <span
              className="block text-neutral-400"
              data-delivery-capability-classes="1"
              data-delivery-capability-counts={`functional=${delivery.counts.capability_functional},governance=${delivery.counts.capability_governance}`}
            >
              能力分类：功能能力 {delivery.counts.capability_functional} 个、设计/治理章节{" "}
              {delivery.counts.capability_governance} 个（后者不计入产品能力计数，§3.2）
            </span>
          )}
          {/* R-1 返工：声明表损坏 ⇒ 分类未定的能力单独点名（不许并进功能能力计数冒充「功能 7 个照旧」） */}
          {delivery.counts.capability_unclassified > 0 && (
            <span
              className="block font-semibold text-amber-300"
              data-delivery-capability-unclassified={delivery.counts.capability_unclassified}
            >
              能力分类：{delivery.counts.capability_unclassified} 个能力**分类未定**（能力分类声明表损坏，
              不按功能能力计数，§3.2）
            </span>
          )}
          <p className="text-neutral-500" data-delivery-reason-head>
            {attn.blocking.total > 0 ? `逐条点名 ${delivery.reasons.length} 条` : "没有阻断项"}
          </p>
          {delivery.conclusion === DELIVERY_REQUESTABLE_CONCLUSION && (
            <p className="text-amber-200" data-delivery-not-accepted>
              {DELIVERY_REQUESTABLE_CONCLUSION} 仍不等于用户接受：仍有 {delivery.user_pending.length}{" "}
              项人工待验由用户本人记录（Agent 不代签，§5.8）
            </p>
          )}
          {delivery.reasons.length > 0 && (
            <ul className="space-y-0.5" data-delivery-reason-list>
              {delivery.reasons.map((r, i) => (
                <li key={i} className="leading-relaxed text-rose-300" data-delivery-reason={i}>
                  {r}
                </li>
              ))}
            </ul>
          )}
          {delivery.user_pending.length > 0 && (
            <ul className="space-y-0.5" data-delivery-pending-list>
              {delivery.user_pending.map((u, i) => (
                <li key={i} className="text-cyan-300" data-delivery-pending={i}>
                  {u}
                </li>
              ))}
            </ul>
          )}
          <p className="text-neutral-500" data-delivery-note>
            {delivery.note}
          </p>
          {/* 待审线索（模型提案·未审定）在同一条栏的详情里逐条列出——它是可行动异常之一，
              不再另起一排常驻栏（§4.1／附录 E.17／E.18）。没有线索就不摆空壳。 */}
          {(leads.length > 0 || nodeLeads.length > 0) && (
            <ModelLeadsLines leads={leads} nodeLeads={nodeLeads} anchor={anchor} />
          )}
          {/* 关系未画出：**全量**逐条在场（合理折叠/分类排除 + 真实缺口）——收起≠删数据（§3.3）。 */}
          {unresolvedRelations.length > 0 && (
            <UnresolvedRelationsPanel
              relations={unresolvedRelations}
              anchor={anchor}
              {...(resolveUnresolvedTarget !== undefined ? { resolveTarget: resolveUnresolvedTarget } : {})}
              {...(onOpenUnresolvedTarget !== undefined ? { onOpenTarget: onOpenUnresolvedTarget } : {})}
            />
          )}
        </div>
      </details>
    </section>
  );
}

/**
 * **待审线索（模型提案·未审定）的逐条列表**（§4.1「模型提案的正式性边界」／附录 E.17／E.18）。
 *
 * 语义整理层输出的提案边/提案节点**不是正式关系或正式节点**：模型自报的 `certainty` 不构成
 * DESIGN/PLAN 声明，正式关系只由确定性管线从权威原文与实际路径复算产生；未通过复算的提案
 * **不参加**能力成员、二级派生、绿态与交付读数。这里把它们**逐条列出**供追溯（自报标记／出处／
 * 处置逐条给），界面不得把它展示成已审定关系——所以说明与每条处置都写明「未审定」。
 *
 * **它是 `GraphAttentionBar` 详情体的一部分**（V09-20 回归修复）：不再自成一条常驻栏——
 * 六图信息区只有一条栏，线索逐条在这条栏的详情里查（收起≠删数据）。`leads` 为空时整枝不渲染。
 */
function ModelLeadsLines({
  leads,
  nodeLeads,
  anchor,
}: {
  leads: readonly ModelLeadInfo[];
  /** R-2：节点侧待审线索（模型自报的新节点／给既有节点补的出处）——同一枝里另起一列，语义相同 */
  nodeLeads: readonly ModelNodeLeadInfo[];
  anchor: string;
}) {
  return (
    <div
      className="border-t border-neutral-800 pt-1"
      data-graph-info-leads-detail
      data-model-leads={anchor}
      data-model-leads-count={leads.length}
      data-model-node-leads-count={nodeLeads.length}
      data-model-leads-pending={
        leads.filter((l) => l.disposition === "lead_pending_review").length +
        nodeLeads.filter((l) => l.disposition === "lead_pending_review").length
      }
    >
      <p className="font-semibold text-neutral-300">待审线索（模型提案·未审定）：{leads.length + nodeLeads.length} 条</p>
      <p className="mt-0.5 text-neutral-500" data-model-leads-note>
        这些是**未审定**的模型提案线索，不是已审定关系（§4.1／附录 E.17）：模型自报的 certainty
        不构成 DESIGN 或 PLAN 的声明，正式关系只由确定性管线从权威原文与实际路径复算产生；下列线索一条都不参加能力成员、二级派生、绿态与交付读数。**提案节点与给既有节点补的出处同样只留在这一层**（R-2）：模型自报的新节点不进正式节点集、提案给的出处不并入正式节点账。
      </p>
      {nodeLeads.length > 0 && (
        <ul className="mt-0.5 max-h-40 space-y-0.5 overflow-y-auto" data-model-node-leads="1">
          {nodeLeads.map((l) => (
            <li
              key={`node:${l.id}`}
              className="leading-relaxed text-neutral-300"
              data-model-node-lead={l.id}
              data-model-node-lead-target={l.target}
              data-model-node-lead-disposition={l.disposition}
            >
              [节点] {l.id}（{l.kind}·{l.name}）——{l.target === "new_node" ? "模型自报的新节点（不进正式节点集）" : "给既有节点补出处（不并入正式节点账）"} ·{" "}
              <span
                className={l.disposition === "confirmed_by_derivation" ? "text-neutral-400" : "text-amber-300"}
                data-model-node-lead-disposition-label={l.disposition}
              >
                {MODEL_LEAD_DISPOSITION_LABEL[l.disposition]}
              </span>
              <span className="ml-1 text-neutral-500">
                出处：
                {l.proposed_source_refs.length === 0
                  ? "（本线索自带 0 条来源）"
                  : l.proposed_source_refs.map((r) => `${r.path} · ${r.locator}`).join("；")}
              </span>
            </li>
          ))}
        </ul>
      )}
      {/* 限高可滚：线索多时不让浮层长到视口之外（浮层本身已限高独立滚动，这是第二道） */}
      <ul className="mt-0.5 max-h-40 space-y-0.5 overflow-y-auto">
        {leads.map((l) => (
          <li
            key={`${l.source}>${l.target}:${l.kind}`}
            className="leading-relaxed text-neutral-300"
            data-model-lead={`${l.source}>${l.target}:${l.kind}`}
            data-model-lead-disposition={l.disposition}
          >
            {l.source} → {l.target}（{l.kind}）——模型自报 certainty：{l.model_certainty}（模型自报，不构成声明）·{" "}
            <span
              className={l.disposition === "confirmed_by_derivation" ? "text-neutral-400" : "text-amber-300"}
              data-model-lead-disposition-label={l.disposition}
            >
              {MODEL_LEAD_DISPOSITION_LABEL[l.disposition]}
            </span>
            <span className="ml-1 text-neutral-500">
              出处：
              {l.source_refs.length === 0
                ? "（本线索自带 0 条来源）"
                : l.source_refs.map((r) => `${r.path} · ${r.locator}`).join("；")}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * 同组关系逐条可点开追来源（§3.2）。**这是 ④ 的落点**：每条带稳定 ID 与可点锚点，
 * 展开即显示出处行（`trace_lines`）；只在文字里解释 ⇒ 不合格（判据见 `validateIntraGroupRelations`）。
 */
/** 只翻译展示名称，未知类型保留原值供追溯，不推断关系含义。 */
export function relationKindLabel(kind: string): string {
  return ({ task_design_ref: "设计依据", design_interface: "模块协作", implementation_map: "实现对应", task_dependency: "工作先后", model_inference: "待核实关系", static_import: "代码引用" } as Record<string, string>)[kind] ?? "关联（类型待说明）";
}

export function IntraRelationPanel({
  relations,
  title = "同组关系（同一分组内，图上逐条可点开追来源）",
  anchor = "intra-relations",
  emptyNote = "本视图当前没有同组关系（没有两端落在同一分组的关系）",
}: {
  relations: readonly IntraGroupRelation[];
  title?: string;
  anchor?: string;
  emptyNote?: string;
}) {
  const byGroup = new Map<string, IntraGroupRelation[]>();
  for (const r of relations) {
    const list = byGroup.get(r.group_id) ?? [];
    list.push(r);
    byGroup.set(r.group_id, list);
  }
  return (
    <section
      className="shrink-0 border-b border-neutral-800 px-3 py-1.5 text-[11px]"
      data-intra-relations={anchor}
      data-intra-relations-count={relations.length}
      data-intra-relations-visible={relations.filter((r) => r.visible_on_graph).length}
    >
      {/* 2026-09-27 用户指令：本面板与口径注释区（ProjectGraphView 的 `[data-project-notes]`）是画布上方
          两大块，默认各收起成**一行**。收起≠删内容：逐条 `<details data-intra-relation>` 一条不少
          全在 DOM 里（§3.2「真实可查看、可点开追到来源」红线不破）；点开本 summary 回到下方限高滚动列表。 */}
      <details data-intra-relations-fold="1">
        <summary className="cursor-pointer text-neutral-400" data-intra-relations-summary="1">
          {title}
          <span className="ml-2 text-neutral-500">
            {relations.length} 条{relations.length > 0 ? ` · 分组 ${byGroup.size} 个` : ""} —— 默认收起，点开查看
          </span>
        </summary>
        {relations.length === 0 ? (
          <p className="mt-0.5 text-neutral-500">{emptyNote}</p>
        ) : (
        // 列表**限高可滚**（与数据流向图的实体/关系面板同一手法：`max-h-32 overflow-auto`）。
        // 为什么必须限高（H-4 复测实测）：真实项目塔台的功能全景有 54 条同组关系，平铺时本面板
        // 一路长到视口之外，把下面的画布挤成 **0 px 高**（`[data-project-canvas-host]` h=0，
        // 12 个节点全在 DOM 里却一个都看不见）——节点徽标再全也等于没上屏。
        // V09-21 R3：max-h-40 → max-h-24（160→96px）。同组关系「真实可查看、可点开追到来源」
        // 的红线不破：逐条 `<details data-intra-relation>` 一条不少全在 DOM 里、点开出处行照常，
        // 只是可视窗口变小、滚动看（非作者终审 F-A：本块实测 191.5px，是画布上方最大的一块）。
        <div className="mt-0.5 max-h-24 space-y-1 overflow-y-auto">
          {[...byGroup.entries()].map(([groupId, list]) => (
            <div key={groupId} data-intra-group={groupId}>
              <p className="text-neutral-500">
                分组 {groupId}
                {list[0]?.group_label !== undefined && list[0].group_label !== groupId ? `（${list[0].group_label}）` : ""}：{list.length} 条
              </p>
              <ul className="space-y-0.5">
                {list.map((r) => (
                  <li key={r.edge_id}>
                    <details
                      data-intra-relation={r.edge_id}
                      data-intra-relation-kind={r.kind}
                      data-intra-relation-source-kinds={intraRelationSourceKinds(r).join("+")}
                      data-intra-relation-visible={r.visible_on_graph ? "1" : "0"}
                      className="rounded border border-neutral-800 px-1.5 py-0.5"
                    >
                      <summary className="cursor-pointer text-neutral-300" data-intra-relation-summary={r.edge_id}>
                        {relationKindLabel(r.kind)}：{r.source} → {r.target}
                      </summary>
                      <ul className="mt-0.5 space-y-0.5">
                        {r.trace_lines.map((l, i) => (
                          <li key={i} className="text-neutral-400" data-intra-relation-source={`${r.edge_id}#${i}`}>
                            {l}
                          </li>
                        ))}
                      </ul>
                    </details>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        )}
      </details>
    </section>
  );
}

/** 整份标注模型的一行摘要（思维导图/画布顶部的口径条；逐对象明细走各视图自己的渲染） */
export function ProvenanceSummaryLine({ model }: { model: ProvenanceModel | null }) {
  if (model === null) return null;
  return (
    <p className="text-[11px] text-neutral-500" data-provenance-summary={model.project_id}>
      来源与证据标注：对象 {model.annotations.length} 个（需求来源{" "}
      {model.annotations.filter((a) => a.source_kinds.includes("requirement")).length} · 设计来源{" "}
      {model.annotations.filter((a) => a.source_kinds.includes("design")).length} · 代码来源{" "}
      {model.annotations.filter((a) => a.source_kinds.includes("code")).length} · 未映射 {model.delivery.counts.unmapped}）·
      需求登记 {model.requirements.registered} 条（{model.requirements.note}）
      {model.delivery.verdict === "blocked" ? `——存在未映射/未验证/缺证/证据失效，结论只能是「${DELIVERY_BLOCKED_CONCLUSION}」` : ""}
    </p>
  );
}

/** 节点卡上的同组关系条目（画布内可点：点一下打开该关系的出处） */
export function IntraRelationChips({
  relations,
  onOpen,
  anchor,
}: {
  relations: readonly { id: string; kind: string; sources: readonly { kind: string }[] }[];
  onOpen: (edgeId: string) => void;
  anchor: string;
}) {
  if (relations.length === 0) return null;
  return (
    <span className="tt-intra-chips mt-0.5 flex gap-1" data-intra-chips={anchor} data-intra-chips-count={relations.length}>
      {relations.map((r) => (
        <button
          key={r.id}
          type="button"
          data-intra-chip={r.id}
          data-intra-chip-kind={r.kind}
          title={`${relationKindLabel(r.kind)}：点开查看来源（原始类型 ${r.kind}）`}
          onClick={(e) => {
            e.stopPropagation();
            onOpen(r.id);
          }}
          className="rounded border border-purple-700/60 bg-purple-900/30 px-1 py-0.5 text-[9px] text-purple-200 hover:bg-purple-800/40"
        >
          {relationKindLabel(r.kind)}
        </button>
      ))}
    </span>
  );
}

/**
 * **关系未画出（本视图解析不到可见分组）的完整名单**——按唯一成因词表 `UNRESOLVED_REASON_LABELS`
 * 逐条点名：稳定 ID、两端、落空端与成因、蓝图出处（`sources`）；真实缺口带【真实缺口】标记。
 *
 * 同一份数据／同一个组件挂在两处（不各写一套）：
 *   · `GraphAttentionBar` 的按需详情里（真实缺口会让信息栏出现并给计数）；
 *   · 主视图工具条上的「关系未画出」入口——只有合理折叠/分类排除时信息栏是健康态、不占行，
 *     这条入口保证它们**照样逐条可达**，不被藏掉（§3.3「隐藏≠没有」）。
 *
 * 只读展示：不改状态、不给完成色、不把机械关系缺口涂成业务失败；可跳转到当前画布上的可见对象，
 * 没有可见对象就**如实写原因**，不做假跳转。
 */
export function UnresolvedRelationsPanel({
  relations,
  anchor,
  title = "关系未画出（本视图解析不到可见分组）",
  resolveTarget,
  onOpenTarget,
}: {
  relations: readonly UnresolvedRelation[];
  anchor: string;
  title?: string;
  /** 端点 → 当前画布上的可见对象显示名（null = 本视图画布上没有这个对象） */
  resolveTarget?: (planId: string) => string | null;
  /** 点开一个可见对象（没有可见对象时调用方给 null，不会走到这里） */
  onOpenTarget?: (planId: string) => void;
}) {
  // 展示顺序＝成因的稳定词表顺序（真实缺口在前）；计数与分类都取唯一常量，不另造状态。
  const order: readonly UnresolvedEndpointReason[] = ["no_ownership", "missing_node", "folded_group", "governance_excluded"];
  const gaps = relations.filter((r) => UNRESOLVED_REAL_GAP_REASONS.includes(r.reason));
  return (
    <section
      className="border-t border-neutral-800 pt-1"
      data-unresolved-relations={anchor}
      data-unresolved-relations-count={relations.length}
      data-unresolved-relations-gaps={gaps.length}
    >
      <p className="font-semibold text-neutral-300">
        {title}：{relations.length} 条（其中真实缺口 {gaps.length} 条）
      </p>
      <p className="mt-0.5 text-neutral-500" data-unresolved-relations-note>
        这些关系的端点解析不到本视图的可见分组——**一条都没被丢掉**，只是画不成连线（§3.3「隐藏≠没有」）。
        「待归属（no_ownership）／缺节点（missing_node）」是**真实缺口**（须核对后补登）；
        「折叠（folded_group）／分类排除（governance_excluded）」是视图口径本身的**合理结果**。
        两类都**不表示业务失败**、不着完成色（§3.2／§4.5）。
      </p>
      <ul className="mt-0.5 max-h-40 space-y-0.5 overflow-y-auto" data-unresolved-relations-list>
        {order
          .flatMap((reason) => relations.filter((r) => r.reason === reason))
          .map((r) => {
            const realGap = UNRESOLVED_REAL_GAP_REASONS.includes(r.reason);
            // 两端各自判定能否跳到**本视图画布上的可见对象**：能跳就给按钮，不能跳就如实写原因（不做假跳转）。
            const ends: { id: string; end: "source" | "target" }[] = [
              { id: r.source, end: "source" },
              { id: r.target, end: "target" },
            ];
            return (
              <li
                key={r.id}
                className="leading-relaxed text-neutral-300"
                data-unresolved-relation={r.id}
                data-unresolved-relation-kind={r.kind}
                data-unresolved-relation-reason={r.reason}
                data-unresolved-relation-end={r.unresolved_end}
                data-unresolved-relation-missing={r.missing_id}
                data-unresolved-relation-real-gap={realGap ? "1" : "0"}
              >
                <span
                  className={realGap ? "font-semibold text-amber-300" : "text-neutral-400"}
                  data-unresolved-relation-class={realGap ? "real_gap" : "reasonable"}
                >
                  {realGap ? "【真实缺口】" : "【合理结果】"}
                </span>
                {relationKindLabel(r.kind)}：{r.source} → {r.target}（落空端＝
                {r.unresolved_end === "source" ? "起点" : "终点"} {r.missing_id}）
                <span className="ml-1 text-neutral-500">{UNRESOLVED_REASON_LABELS[r.reason]}</span>
                <span className="ml-1 text-neutral-500" data-unresolved-relation-sources={r.sources.length}>
                  出处：
                  {r.sources.length === 0
                    ? "（这条关系没有可定位出处）"
                    : r.sources.map((s) => `${s.path} · ${s.locator}`).join("；")}
                </span>
                {ends.map(({ id, end }) => {
                  const label = resolveTarget?.(id) ?? null;
                  const isMissing = end === r.unresolved_end;
                  return label !== null && onOpenTarget !== undefined ? (
                    <button
                      key={end}
                      type="button"
                      data-unresolved-relation-open={id}
                      data-unresolved-relation-open-end={end}
                      onClick={() => onOpenTarget(id)}
                      className="ml-1 rounded border border-neutral-700 px-1 text-[10px] text-neutral-300 hover:bg-neutral-800"
                    >
                      查看「{label}」↗
                    </button>
                  ) : (
                    <span
                      key={end}
                      className="ml-1 text-neutral-500"
                      data-unresolved-relation-no-target={id}
                      data-unresolved-relation-no-target-end={end}
                      data-unresolved-relation-no-target-missing={isMissing ? "1" : "0"}
                    >
                      （本视图画布上没有这个对象：{id}，不跳到别处）
                    </span>
                  );
                })}
              </li>
            );
          })}
      </ul>
    </section>
  );
}
