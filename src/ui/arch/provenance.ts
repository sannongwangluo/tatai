// V09-13：图节点与关系的**来源、证据标注与交付阻断**——全仓唯一判据（零 React / 零 IO）。
//
// 设计依据：DESIGN.md §3.2（来源与证据、同组关系可见性、模型产出待审）、§4.2（颜色由事实派生、
// 交付阻断与人工待验）、§4.5（规划与实现对账）、附录 D（模块/能力「验证通过」的判据）、
// 附录 E.3（绿态的必需证据集与检查记录采信）、附录 E.9（任务绿 / 独立复审 / 用户 Gate 分层）、
// 附录 G-2、G-4；施工定义见 PLAN V09-13。
//
// **为什么单独一层、而且只此一份**：卡面点名「分类与证据状态不得在两个 UI 文件各写一套」。
// 于是本模块是**唯一判据**，四处读同一份：
//   · 服务端派生（`src/arch/blueprint.ts#archProvenanceModelOf`）：把蓝图 + 需求登记 + 任务定义 +
//     证据记录摊成输入，交给本模块判来源种类、映射、证据状态与交付阻断；
//   · MCP 读口（`src/mcp/tools/getArch.ts` 的 v2 返回体）：把同一份模型（含交付读数）交出去；
//   · 界面（`ArchCanvas.tsx` / `ProjectGraphView.tsx` / `MindMapView.tsx`，渲染件在
//     `ProvenancePanel.tsx`）：徽标、来源种类、证据状态、交付阻断读数、同组关系逐条可点；
//   · 验证脚本（`scripts/verify-v09-13.ts`）：机械判据 `validateProvenanceModel` 正反两跑。
//
// **五条红线**（每条都在 `validateProvenanceModel` 里有一条违规码）：
//   ① 不得给未映射/未验证对象涂绿或省略标注；
//   ② 不得用节点数算虚假完成率；
//   ③ 不得把「用户待验」自动置成已接受（也不得显示成「已验证」）；
//   ④ 不得绕过 §4.2 优先级序与附录 D 的必需证据集；
//   ⑤ 不改 §4.1 派生口径（本模块只**读**投影给的字段，不重算状态，不写任何源）。

import type { DisplayStatus, QualityDimension } from "../../server/work/statusProjection";
import { capabilityDeclaredMembersOf } from "../../arch/featureScope";

// ══════════════════ ① 来源种类（§3.2「每个模块与每条关系都要有需求、设计或代码来源」） ══════════════════

export type ProvenanceSourceKind = "requirement" | "design" | "code";

/** 词表顺序（图上/读口里的展示顺序；也是"三档缺一即未映射"的判定集合） */
export const PROVENANCE_SOURCE_ORDER: readonly ProvenanceSourceKind[] = ["requirement", "design", "code"];

export const PROVENANCE_SOURCE_LABELS: Readonly<Record<ProvenanceSourceKind, string>> = {
  requirement: "需求来源",
  design: "设计来源",
  code: "代码来源",
};

/** 一条来源都没有时的**必填**标注（不许省略，也不许拿"未知"糊过去） */
export const UNMAPPED_LABEL = "未映射（没有需求／设计／代码来源）";

/** 来源种类的**上屏短标**（唯一实现：三个 UI 文件与读口都用它，不各写一套拼接） */
export function sourceKindLabelOf(kinds: readonly ProvenanceSourceKind[]): string {
  if (kinds.length === 0) return "未映射";
  return kinds.map((k) => PROVENANCE_SOURCE_LABELS[k]).join("+");
}

/** 证据状态的上屏短标与徽标样式（唯一实现：节点/列表面板都取它，不在 UI 里各写一套色） */
export function evidenceShortOf(state: EvidenceState): string {
  return EVIDENCE_STATE_PALETTE[state].short;
}

export function evidenceBadgeClassOf(state: EvidenceState): string {
  return EVIDENCE_STATE_PALETTE[state].badge;
}

export const UNMAPPED_BADGE_CLASS = "border-neutral-600 bg-neutral-800 text-neutral-300";

/** 施工卡来源计入设计档的口径句（施工图由设计派生，§1.5／§2.9） */
export const PLAN_TASK_AS_DESIGN_NOTE =
  "施工卡来源（`plan_task`）计入**设计来源**：施工图由审定的设计书派生（§1.5／§2.9），" +
  "卡面「设计依据」段指向设计章节，卡本身不是第二份可独立修改的设计事实";

/** 蓝图来源引用里，哪一类 kind 归入哪个来源档（唯一出处） */
export function sourceKindOfRefKind(kind: string): ProvenanceSourceKind | null {
  if (kind === "design_section" || kind === "plan_task") return "design";
  if (kind === "code_module") return "code";
  return null;
}

export interface SourceRefLike {
  kind: string;
  path: string;
  locator: string;
  sha256: string | null;
}

// ══════════════════ ② 证据状态（五档；卡面「输入/输出契约」逐字对应） ══════════════════

export type EvidenceState = "verified" | "unverified" | "missing" | "invalidated" | "user_pending";

/** 展示与"取最差"的顺序：失效 → 缺证 → 未验证 → 用户待验 → 已验证（§4.2 优先级序的读法） */
export const EVIDENCE_STATE_ORDER: readonly EvidenceState[] = [
  "invalidated",
  "missing",
  "unverified",
  "user_pending",
  "verified",
];

export interface EvidenceStateStyle {
  short: string;
  full: string;
  /** 徽标 tailwind 类（图形之外的文字通道；颜色同时配中文词） */
  badge: string;
  hint: string;
}

export const EVIDENCE_STATE_PALETTE: Readonly<Record<EvidenceState, EvidenceStateStyle>> = {
  verified: {
    short: "已验证",
    full: "绿：要求的验证已通过",
    badge: "bg-emerald-900/70 text-emerald-300 border-emerald-700",
    hint: "该对象当前全部必需验证证据有效（§4.2／附录 D）；**不等于**用户已接受（人工接受另显示）",
  },
  user_pending: {
    short: "用户待验",
    full: "要求的验证已通过，等用户本人确认/验收",
    badge: "bg-cyan-900/70 text-cyan-300 border-cyan-700",
    hint: "需用户动手确认或验收的项：由用户本人记录，**Agent 不代签**（§4.2／§5.8）；不得显示成「已验证」，更不得写成已接受",
  },
  unverified: {
    short: "未验证",
    full: "有证据但必需的验证还没齐",
    badge: "bg-amber-900/70 text-amber-300 border-amber-700",
    hint: "必需项有缺口（或质量没到必需档）：不给绿，且阻断「项目可交付」结论（§4.2）",
  },
  missing: {
    short: "缺证",
    full: "一条有效证据都没有",
    badge: "bg-neutral-800 text-neutral-300 border-neutral-600",
    hint: "没有证据记录 ≠ 未验证通过：不空集判绿，也不拿「还没开始」冒充（§4.2／附录 D）",
  },
  invalidated: {
    short: "证据失效",
    full: "证据已失效或源已变，旧绿不作数",
    badge: "bg-rose-900/70 text-rose-300 border-rose-700",
    hint: "旧绿转未知/待验证并保留历史：源变了就要重验，不能拿过期结论当通过（§4.2／§5.6）",
  },
};

/** 取最差（§4.2 优先级序的读法；`EVIDENCE_STATE_ORDER` 就是优先级） */
export function worseEvidenceState(a: EvidenceState, b: EvidenceState): EvidenceState {
  return EVIDENCE_STATE_ORDER.indexOf(a) <= EVIDENCE_STATE_ORDER.indexOf(b) ? a : b;
}

/** 五档里哪几档**阻断**「项目可交付」结论（②：存在 unmapped／unverified／invalidated 时明确不给） */
export const BLOCKING_EVIDENCE_STATES: readonly EvidenceState[] = ["invalidated", "missing", "unverified"];

export const isBlockingEvidenceState = (s: EvidenceState): boolean => BLOCKING_EVIDENCE_STATES.includes(s);

/** 「用户待验」的唯一文案（界面与读口同词） */
export const USER_PENDING_LABEL = "用户待验";
export const USER_PENDING_NOTE =
  "需用户动手确认/验收的项由用户本人记录，**Agent 不代签**（DESIGN.md §4.2／§5.8）——" +
  "本系统只把它标成待验，不会自动置成已接受";

// ══════════════════ ③ 证据判据（唯一实现；`PROVENANCE_POLICY` 是它的成文） ══════════════════

/**
 * 一个对象（节点或关系）的证据事实摘要——**只装事实，不装判据**。
 * 事实来自状态投影（`src/server/work/statusProjection.ts` 的 `provenanceFactsOf`）与蓝图来源复算
 * （`src/arch/blueprint.ts`）：判据本身在下面的 `evidenceStateOf`，一处实现。
 */
export interface EvidenceFacts {
  object_id: string;
  label: string;
  /** 投影里有没有这个对象（false ⇒ 没有任何证据记录可判） */
  has_projection: boolean;
  /** 投影的映射口径（`unmapped` ⇒ 显示未映射、不空集判绿，§4.2） */
  mapping: "mapped" | "unmapped" | null;
  required_count: number;
  passed_count: number;
  missing_count: number;
  /** 投影四维（本判据只读它们，**不重算** §4.1 的派生） */
  quality: QualityDimension | string | null;
  display_status: DisplayStatus | string | null;
  freshness: string | null;
  acceptance: string | null;
  /** 被源变更取代的旧结论条数（>0 ⇒ 旧绿不作数，历史保留） */
  history_count: number;
  /**
   * **三类静态边的自身复算读数**（V09-17；§4.2 第三段／附录 E.15；GPT-6 裁定 1/2）。
   * 只对 `task_design_ref`／`implementation_map`／`design_interface` 三类边装配（蓝图侧
   * `archProvenanceModelOf` 的边循环），其余对象恒为 undefined/null。
   * 有了它，判据走「按边自身来源/映射复算分档」的分支（与两端点状态无关），
   * 不再落入「没有投影对象 ⇒ unverified」的通用分支。
   */
  static_relation?: StaticRelationFacts | null;
  open_findings: number;
  evidence_refs: readonly string[];
  /** 来源引用复算：总数 / 有效数 / 失效逐条点名（来自蓝图侧 `sourceRefLocateOf`，本模块只消费） */
  sources_total: number;
  sources_valid: number;
  /** 引用对不上原处（哈希变了）：来源已变 ⇒ 证据失效 */
  sources_stale: readonly string[];
  /** 引用**定位不到**（章节/卡号/模块 id 在源里已不存在）：来源不复存在 ⇒ 同样按证据失效处理 */
  sources_unlocatable: readonly string[];
  /** 需用户动手的步骤（逐条点名；空 = 无人工步骤） */
  user_actions: readonly string[];
  /** 是否属于"交付时要用户本人拍板"的对象（任务/能力/批次交付对象；模块/关系不算） */
  delivery_relevant: boolean;
  /**
   * **成员账目**（模块/能力这类父级对象；`null` = 它不是父级，按自己的证据记录判）。
   * 附录 D 明令模块/能力不另设验证对象、由成员派生——所以父级不看自己的证据记录，只看：
   * 成员全部"要求的验证已通过"且成员都有状态记录 ⇒ 通过；成员里有没状态记录的 ⇒ 不给绿。
   * 账目只装**计数**，不给父级单造一个质量档（不编造事实）。
   */
  member_aggregate?: MemberAggregate | null;
  /**
   * **画布真实缺口**（2026-09-26 安装版复核；P11）：蓝图侧装配用 `canvasMembershipGapsOf`
   * （`projectGraph.ts`，走真实 buildViewModel 复算）逐能力核「证据链说有成员 ⇔ 画布分组真画得出」。
   * 每条是一句人话事实（哪个能力、哪个视图、差什么）；非空 ⇒ 交付阻断并逐条点名——
   * 修图面归属数据，不靠人工验收绕。
   */
  canvas_gaps?: readonly string[];
}

/** 三类静态边的边类（V09-17；§4.2 第三段点名的三类） */
export type StaticRelationKind = "task_design_ref" | "implementation_map" | "design_interface";

/** 三类静态边的自身复算读数（字段语义见 `EvidenceFacts.static_relation`） */
export interface StaticRelationFacts {
  kind: StaticRelationKind;
  /**
   * `implementation_map` 的映射复算结果（只这一类有；另两类的验证只看来源复算）：
   *   `hit`                = 声明路径**真实存在**且落在**该具体模块**（pathIntersectsPath 命中非根模块），
   *                          或目标是根模块且声明的**根级文件真实存在于仓库根**（根模块是根目录散文件的
   *                          真实归属，2026-09-25 判据细化）⇒ 映射成立；
   *   `path_missing`       = 声明路径在仓库中不存在（规划路径）/ 与当前模块不再相交 / 定义或模块已消失 ⇒ 映射未经核实；
   *   `root_fallback_only` = 这条边只靠**根模块兜底**产生（没有根级真实文件声明）⇒ 映射未经核实（GPT-6 裁定 2：根兜底命中不算）。
   */
  mapping?: { verdict: "hit" | "path_missing" | "root_fallback_only"; detail: string };
}

/** 父级（模块/能力）的成员账目（附录 D：成员非空且全部通过才算过；空集不算过） */
export interface MemberAggregate {
  members_total: number;
  /** 成员里"要求的验证已通过"的个数（含用户待验：已验证过、只等用户确认） */
  members_verified: number;
  /** 成员里没有状态记录/未映射的个数（无证据链，不算通过） */
  members_without_status: number;
  /** 成员里"用户待验"的个数（父级随之待用户确认，不代签） */
  members_user_pending: number;
  /** 这个账目是怎么算的（附录 D 的判据句，原样上屏） */
  basis: string;
}

export interface EvidenceVerdict {
  state: EvidenceState;
  /** 为什么是这个状态（上屏；逐条点名，不写"整体看起来还行"） */
  basis: string;
  /** 要求的验证是否已通过（与"是否还要用户确认"分开表达：user_pending 时它也是 true） */
  verification_passed: boolean;
}

const whyList = (xs: readonly string[]): string => xs.join("；");

/**
 * 证据状态判据（唯一实现）。判据就是 `PROVENANCE_POLICY` 的 P1–P7 与 P10，逐条对应：
 *   P5 失效 → **P10 三类静态边按自身来源/映射复算分档**（V09-17）→ P3 缺证 → P4 未验证 → P6 用户待验 / P1 已验证。
 *   顺序即优先级（§4.2：先判失效；静态边分支只认边自身的来源/映射事实，与两端点状态无关）。
 */
export function evidenceStateOf(facts: EvidenceFacts): EvidenceVerdict {
  const who = `${facts.label}（${facts.object_id}）`;

  // ── P5 证据失效：旧绿不能亮着（最高优先级） ──
  const invalidated: string[] = [];
  if (facts.sources_stale.length > 0) {
    invalidated.push(`来源已变、引用哈希对不上（${facts.sources_stale.slice(0, 3).join("、")}）`);
  }
  if (facts.sources_unlocatable.length > 0) {
    invalidated.push(`来源定位不到（${facts.sources_unlocatable.slice(0, 3).join("、")}）——源里已找不到它`);
  }
  if (facts.quality === "evidence_invalid") invalidated.push("质量维＝证据无效（evidence_invalid）");
  if (facts.freshness !== null && facts.freshness !== "fresh") {
    invalidated.push(`新鲜度＝${facts.freshness}（源变了，原结论要重验）`);
  }
  if (facts.history_count > 0) {
    invalidated.push(`有 ${facts.history_count} 条旧结论已被源变更取代（历史保留但不作数）`);
  }
  if (invalidated.length > 0) {
    return {
      state: "invalidated",
      verification_passed: false,
      basis: `${who}：证据已失效——${whyList(invalidated)}（§4.2／§5.6；旧绿转未知或待验证并保留历史）`,
    };
  }

  // ── V09-17（§4.2 第三段／附录 E.15，GPT-6 裁定 1/2）：三类静态边按**自身**来源/映射复算分档 ──
  // 走到这里 ⇒ P5 已过：这条边的来源全部可定位且未失效（stale/unlocatable 上面已判 invalidated）。
  // 与两端点状态无关：端点红/绿一个字都不读。verified 的语义只到「来源/映射有效」，
  // **不表示功能已完成、不表示集成已联通**；读数里这类 verified 进「来源核实」档，不进功能验证档。
  const staticRel = facts.static_relation ?? null;
  if (staticRel !== null) {
    if (facts.sources_total === 0) {
      // 无出处 ⇒ 维持现行口径（缺证；不空集判绿，也不拿"边在图上"冒充来源）
      return {
        state: "missing",
        verification_passed: false,
        basis:
          `${who}：这条静态关系没有任何可定位的出处 ⇒ 缺证（来源/映射核实无从谈起）——` +
          "没有证据不等于「未验证通过」，更不等于通过；不空集判绿（§4.2／附录 D）",
      };
    }
    if (staticRel.kind === "task_design_ref") {
      return {
        state: "verified",
        verification_passed: true,
        basis:
          `${who}：来源有效——所引设计章节在当前 DESIGN 可定位且引用哈希与当前章节相符` +
          `（${facts.sources_valid}/${facts.sources_total} 条来源复算通过）⇒ **来源核实通过**。` +
          "来源有效**不表示功能已完成、不表示集成已联通**（§4.2／附录 E.15；读数分两档，这条进来源核实档）",
      };
    }
    if (staticRel.kind === "design_interface") {
      return {
        state: "verified",
        verification_passed: true,
        basis:
          `${who}：来源有效——§11.1 模块清单章节可定位且未失效` +
          `（${facts.sources_valid}/${facts.sources_total} 条来源复算通过）⇒ 归属来源核实通过。` +
          "这是**设计声明的归属关系，非运行接口**：不表示功能已完成、不表示集成已联通（§4.2／附录 E.15）",
      };
    }
    // implementation_map：除来源有效外，还要求**映射复算命中**（声明路径真实存在且落在该具体模块）
    const mapping = staticRel.mapping;
    if (mapping === undefined) {
      return {
        state: "unverified",
        verification_passed: false,
        basis: `${who}：映射复算读数缺失（装配侧没给出这条映射的复算结果）——无法核实 ⇒ 不判通过（§4.2／附录 E.15）`,
      };
    }
    if (mapping.verdict === "hit") {
      return {
        state: "verified",
        verification_passed: true,
        basis:
          `${who}：映射成立且复算一致——${mapping.detail}。` +
          "映射成立**不表示功能已完成、不表示集成已联通**（§4.2／附录 E.15；读数分两档，这条进来源核实档）",
      };
    }
    return {
      state: "unverified",
      verification_passed: false,
      basis:
        `${who}：映射未经核实——${mapping.detail}。` +
        "声明路径不存在（规划路径）或仅根模块兜底命中 ⇒ 不算映射成立，不给 verified（§4.2／附录 E.15，GPT-6 裁定 2）",
    };
  }

  // ── P3 缺证：没有证据记录 / 没有必需项 / 一条证据都没有 ──
  // 父级（模块/能力）先按**成员账目**判（附录 D：父级不另设验证对象、由成员派生）
  const agg = facts.member_aggregate ?? null;
  if (agg !== null) {
    if (agg.members_total === 0) {
      return {
        state: "missing",
        verification_passed: false,
        basis: `${who}：没有任何成员（空集不算过，附录 D）——${agg.basis}`,
      };
    }
    if (agg.members_without_status > 0) {
      return {
        state: "unverified",
        verification_passed: false,
        basis:
          `${who}：成员账目 ${agg.members_verified}/${agg.members_total} 通过，但另有 ${agg.members_without_status} 个成员**没有状态记录**` +
          `（无证据链，不能算通过）⇒ 父级不给绿（附录 D）。${agg.basis}`,
      };
    }
    if (agg.members_verified < agg.members_total) {
      return {
        state: "unverified",
        verification_passed: false,
        basis:
          `${who}：成员账目 ${agg.members_verified}/${agg.members_total} 通过——**不是全部通过 ⇒ 父级不给绿**（附录 D）。${agg.basis}`,
      };
    }
    if (agg.members_user_pending > 0) {
      return {
        state: "user_pending",
        verification_passed: true,
        basis:
          `${who}：${agg.members_total} 个成员的验证都已通过，但其中 ${agg.members_user_pending} 个是**用户待验**` +
          `（父级随之待用户确认，不代签）——${agg.basis}。${USER_PENDING_NOTE}`,
      };
    }
    return {
      state: "verified",
      verification_passed: true,
      basis:
        `${who}：成员 ${agg.members_total} 个全部「要求的验证已通过」，且成员都有状态记录 ⇒ 父级验证通过（附录 D：` +
        "父级不另设验证对象，由成员派生；**人工接受另显示**）。" +
        agg.basis,
    };
  }
  if (!facts.has_projection) {
    if (facts.sources_valid > 0) {
      return {
        state: "unverified",
        verification_passed: false,
        basis:
          `${who}：来源可定位（${facts.sources_valid}/${facts.sources_total} 条复算通过），但**没有这个对象的必需验证证据**` +
          "（状态投影里没有它）——只有声明出处 ⇒ 未验证（§4.2：跨模块依赖也要关系/集成证据，" +
          "两个端点绿不代表连线绿）",
      };
    }
    return {
      state: "missing",
      verification_passed: false,
      basis:
        `${who}：状态投影里没有这个对象、也没有可定位的来源 ⇒ 没有任何证据记录可判（缺证）——` +
        "没有证据不等于「未验证通过」，更不等于通过；不空集判绿（§4.2／附录 D）",
    };
  }
  if (facts.mapping === "unmapped" || facts.required_count === 0) {
    return {
      state: "missing",
      verification_passed: false,
      basis:
        `${who}：` +
        (facts.mapping === "unmapped"
          ? "没有任务或验收映射（未映射）"
          : "当前没有任何必需验收项（required=0）") +
        "——空集不算过：不据此判「已验证」（§4.2／附录 D）",
    };
  }
  if (facts.missing_count >= facts.required_count && facts.passed_count === 0 && facts.evidence_refs.length === 0) {
    const stateNote =
      facts.display_status === "planned"
        ? "；状态＝**已规划未开始**（来源可追，但**不算已交付**）"
        : facts.display_status === "in_progress"
          ? "；状态＝正在实现（还没有可验的结果）"
          : "";
    return {
      state: "missing",
      verification_passed: false,
      basis:
        `${who}：必需 ${facts.required_count} 项一条证据都没有（缺证）${stateNote}——` +
        "缺证与「未验证」分开标注：先补证据，再谈通过（附录 D／§4.2）",
    };
  }

  // ── P4 未验证：必需项有缺口，或质量没到必需档 ──
  const gaps: string[] = [];
  if (facts.missing_count > 0) {
    gaps.push(`必需项还缺 ${facts.missing_count} 项（通过 ${facts.passed_count}/${facts.required_count}）`);
  }
  if (facts.open_findings > 0) gaps.push(`未收口缺陷 ${facts.open_findings} 条`);
  if (facts.quality === "unverified" && facts.missing_count === 0) {
    gaps.push("质量维＝未验证（只有作者自报，没有可采信的检查记录）");
  }
  if (facts.quality === "auditing") gaps.push("质量维＝审计进行中（独立复核还没出结论）");
  if (facts.display_status === "blocked") gaps.push("状态＝有已确认问题或明确阻塞");
  if (facts.display_status === "in_progress") gaps.push("状态＝正在实现（还没有可验的结果）");
  if (facts.display_status === "planned") gaps.push("状态＝已规划未开始（来源可追，但**不算已交付**）");
  if (facts.display_status === "unknown") gaps.push("状态＝未知/陈旧（事实读取失败或图版本落后，不默认通过）");
  if (gaps.length > 0) {
    return {
      state: "unverified",
      verification_passed: false,
      basis: `${who}：必需的验证还没齐——${whyList(gaps)}（§4.2；缺一项就不是绿）`,
    };
  }
  // 质量维必须在"机械自检通过"或"非作者复核通过"档：别的值走上面几条，漏到这里的如实判未验证
  if (facts.quality !== "mechanical_passed" && facts.quality !== "audit_passed") {
    return {
      state: "unverified",
      verification_passed: false,
      basis:
        `${who}：必需项计数看着齐，但质量维是 ${String(facts.quality)}（不是 mechanical_passed / audit_passed）——` +
        "不拿计数冒充采信档（附录 E.3.2）",
    };
  }

  // ── P6 用户待验：证据齐备、球在用户手上 ──
  if (facts.delivery_relevant && facts.acceptance === "pending" && facts.user_actions.length > 0) {
    return {
      state: "user_pending",
      verification_passed: true,
      basis:
        `${who}：要求的验证已通过（必需 ${facts.required_count} 项全过，质量档 ${String(facts.quality)}）——` +
        `但还有 ${facts.user_actions.length} 项要用户本人动手/确认：${facts.user_actions.slice(0, 3).join("；")}。` +
        USER_PENDING_NOTE,
    };
  }

  // ── P1 已验证：该对象当前全部必需证据有效（不等于用户接受） ──
  return {
    state: "verified",
    verification_passed: true,
    basis:
      `${who}：要求的验证已通过——必需 ${facts.required_count} 项全过、质量档 ${String(facts.quality)}、` +
      `证据 ${facts.evidence_refs.length} 条有效（§4.2／附录 D）。**人工接受另显示**：绿 ≠ 用户已接受`,
  };
}

// ══════════════════ ④ 判据成文（P1–P10；读口/界面/脚本都引用它，不各写一套） ══════════════════

export const PROVENANCE_POLICY: readonly { rule: string; text: string }[] = [
  {
    rule: "P1",
    text:
      "来源在场：每个模块/关系都要有需求、设计或代码来源（三档）；一条来源都没有 ⇒ 标「未映射」，" +
      "显式标注、不涂绿、不算已交付（§3.2／§4.2）",
  },
  {
    rule: "P2",
    text:
      "来源有效：来源引用按 kind 复算定位（设计按章节正文 sha256、施工卡按施工定义 sha256、代码模块按模块 id）；" +
      "复算不过的引用逐条点名并按失效处理（§4.1「来源可定位」是发布前提）",
  },
  {
    rule: "P3",
    text:
      "证据在档：没有状态投影对象 = 没有证据记录 ⇒ missing（缺证）；没有必需项（required=0）同样不判通过——" +
      "空集不算过（§4.2／附录 D）",
  },
  {
    rule: "P4",
    text:
      "证据相符：必需项有缺口、有未收口缺陷、或还没交结果 ⇒ unverified；" +
      "verified ⇔ 必需项全过且质量维是 mechanical_passed / audit_passed（§4.2：缺一项就不是绿）",
  },
  {
    rule: "P5",
    text:
      "证据失效：质量维 evidence_invalid、新鲜度非 fresh（源变更影响待查 / 陈旧 / 读不出）、或已有被取代的旧结论 ⇒ " +
      "invalidated，旧绿不许亮着，历史保留（§4.2／§5.6）",
  },
  {
    rule: "P6",
    text:
      "人工待验：证据齐备、但验收维度仍是 pending（需用户动手确认或验收）⇒ user_pending；" +
      "不得显示成 verified、不得自动置成已接受——由用户本人记录，Agent 不代签（§4.2／§5.8）",
  },
  {
    rule: "P7",
    text:
      "交付阻断：存在 unmapped／unverified／missing／invalidated ⇒ 只给「不可判定项目可交付」并逐条点名原因；" +
      "全部满足且只剩用户待验时，最多给「可请求验收」——**仍不等于用户接受**（§4.2／附录 E.9）",
  },
  {
    rule: "P8",
    text:
      "同组关系可见：同一分组内的设计接口等关系必须在图上可见、可点开追来源（逐条带稳定 ID、来源种类与出处）；" +
      "只在文字里解释 ⇒ 不合格（§3.2 同组关系可见性）",
  },
  {
    rule: "P9",
    text:
      "不用节点数算完成率：读数只给逐条点名与必要计数，**不给百分比**，也不拿节点数冒充项目完成度（§4.2）",
  },
  {
    rule: "P10",
    text:
      "三类静态边按自身复算分档：task_design_ref／implementation_map／design_interface 以**该边自身**的来源/映射复算为验证，" +
      "与两端点状态无关；通过档 verified 只读作「来源/映射有效」——**不表示功能已完成、不表示集成已联通**，" +
      "读数把「来源核实」与「功能验证」分两档计数、来源核实不计入功能验证完成数；" +
      "implementation_map 还要求声明路径真实存在且落在该具体模块——根模块是根目录散文件的真实归属：" +
      "声明的根级文件真实存在于仓库根 ⇒ 映射成立，仅根模块兜底命中（无根级真实文件声明）或路径不存在 ⇒ unverified；" +
      "非代码路径（.工作台/、.git/、node_modules/、dist/、target/）与根下不存在的裸文件名不产生映射边；" +
      "design_interface 是设计声明的归属关系、非运行接口；关系在重新派生后消失 ⇒ 报缺并继续阻断，" +
      "经批准移除并留痕的除外（§4.2 第三段／附录 E.15／附录 E.16，2026-09-25 终审返工判据细化）",
  },
  {
    rule: "P11",
    text:
      "画布真实缺口对账（2026-09-26 复核；2026-09-26 GPT-6 裁定 8 修订）：交付判定用真实 buildViewModel 复算分组视图——" +
      "功能全景（只含功能能力分组，§3.2 能力分类）：能力有 task_design_ref 指向 ⇒ 分组必须含这些任务；" +
      "系统架构：能力的**每个应有模块靶点**（任务带 observed implementation_map → plan:code:*）逐一核对——" +
      "应有 2 个只丢 1 个也报缺（不是「有 1 个即过」的存在性判据）；超过 15 个分组按 §3.3 聚合时，" +
      "成员必须能从聚合入口**展开到达**，聚合后不可达 ⇒ 报缺；有归属账目却不在任何分组/聚合成员的**未归属端点** ⇒ 逐条点名。" +
      "**P11 只验证来源账与画布可达性一致，不证明设计语义正确**；断裂逐条点名并阻断交付结论，修图面归属数据，" +
      "不靠人工验收绕（§3.2／§3.3／§4.2：两套口径必须对齐）",
  },
];

// ══════════════════ ⑤ 逐对象标注（来源种类 + 映射 + 证据状态 + 阻断点名） ══════════════════

export interface RequirementRef {
  requirement_id: string;
  status: string;
  status_label: string;
  source_kind: string;
  source_ref: string;
}

export interface ProvenanceObjectInput {
  /** 稳定 ID（蓝图节点 id / 关系键 `source>target:kind`） */
  object_id: string;
  object_kind: "node" | "edge";
  label: string;
  /** 业务种类（capability/module/task/concept，或关系 kind）——上屏用 */
  kind: string;
  /** 能力分类（仅 capability 对象带：functional=功能能力；governance=设计/治理章节；§3.2 能力分类声明） */
  capability_class?: "functional" | "governance" | "unknown" | null;
  /** 蓝图的来源引用（原始事实：本模块按 `sourceKindOfRefKind` 归类） */
  source_refs: readonly SourceRefLike[];
  /** 该对象承接的需求 id（施工定义的 `requirement_ids`；空 = 没有需求承接） */
  requirement_ids: readonly string[];
  /** 该对象绑定的任务卡号（`plan:task:*` 才有） */
  task_id: string | null;
  evidence: EvidenceFacts;
}

/** 模型提案待审线索（结构同 `BlueprintModelLead`，本模块不反向依赖 arch 层）：**不参与**任何验证读数（§4.1／附录 E.17） */
export interface ModelLeadInfo {
  source: string;
  target: string;
  kind: string;
  model_certainty: string;
  disposition: "confirmed_by_derivation" | "lead_pending_review";
  source_refs: readonly SourceRefLike[];
}

/** 模型提案**节点侧**待审线索（R-2/B 类返工 2026-09-26；结构同 `BlueprintNodeLead`）：
 * 提案节点与给既有节点补的出处同样**不参与**任何验证读数与交付判定（§4.1／附录 E.17）。 */
export interface ModelNodeLeadInfo {
  id: string;
  kind: string;
  name: string;
  target: "existing_node" | "new_node";
  disposition: "confirmed_by_derivation" | "lead_pending_review";
  proposed_source_refs: readonly SourceRefLike[];
  proposed_related_ids: readonly string[];
}

/** 能力分类读数（结构同 `BlueprintCapabilityClasses`）：分类唯一来源是设计书「能力分类声明」表（§3.2）；
 *  R-1 返工后另带 `table_state`（declared/undeclared/broken）与逐项 `issues`——表损坏时读口必须如实带出，
 *  **不得**把未解析出分类的章节当作功能能力。 */
export interface CapabilityClassesInfo {
  declared: boolean;
  by_capability: Readonly<Record<string, "functional" | "governance">>;
  note: string;
  table_state?: "declared" | "undeclared" | "broken";
  issues?: readonly { kind: string; chapter: number | null; detail: string; blocking: boolean }[];
}

export interface ProvenanceAnnotation {
  object_id: string;
  object_kind: "node" | "edge";
  label: string;
  kind: string;
  /** 能力分类（仅 capability 对象带：functional=功能能力；governance=设计/治理章节；
   *  unknown=声明表损坏、该章分类未定（R-1 返工）；§3.2 能力分类声明） */
  capability_class?: "functional" | "governance" | "unknown" | null;
  /** 来源种类（三档，可多；空 = 未映射） */
  source_kinds: ProvenanceSourceKind[];
  /** 上屏的来源种类短标（三档拼接 / 未映射） */
  source_kind_label: string;
  /** 未映射（一条来源都没有）：**必须显式标注**，且不许涂绿、不许算已交付 */
  unmapped: boolean;
  /** 映射关系（逐条可追：需求 id / 设计章节 / 代码模块） */
  mapping: {
    requirement_ids: string[];
    /** 承接了但登记表里查不到的（悬空）：逐条点名 */
    dangling_requirement_ids: string[];
    design_refs: { path: string; locator: string; sha256: string | null }[];
    code_refs: { path: string; locator: string; sha256: string | null }[];
  };
  evidence_state: EvidenceState;
  evidence_state_label: string;
  /**
   * 验证口径分档（V09-17，§4.2 第三段／附录 E.15）：
   *   `source_mapping` = 三类静态边——verified 只读作「来源/映射有效」，**不计入功能验证完成数**；
   *   `functional`     = 其余对象——verified 读作「必需的功能验证证据全过」。
   */
  verification_scope: "functional" | "source_mapping";
  /** 要求的验证已通过（user_pending 时为 true；verified 时也为 true） */
  verification_passed: boolean;
  evidence_refs: string[];
  /** 判据句（上屏；唯一出处见 `evidenceStateOf`） */
  basis: string;
  /** 该对象造成的交付阻断（逐条点名；空 = 不阻断） */
  blockers: string[];
  /** 人工待验（需用户动手/确认）：本标注只把它标出来，不代签 */
  user_pending: boolean;
  user_actions: string[];
  /** **恒 false**：本标注不是用户接受（人工验收另记，§5.8） */
  user_accepted: false;
}

/** 交付阻断读数的两个结论（§4.2：不是「项目可交付」就是「还不行」，没有第三种口气） */
export const DELIVERY_BLOCKED_CONCLUSION = "不可判定项目可交付";
export const DELIVERY_REQUESTABLE_CONCLUSION = "可请求验收";
export const DELIVERY_NONE_CONCLUSION = "没有可判定的交付对象";

export interface DeliveryReadout {
  /** `blocked` = 逐条点名后不给可交付结论；`requestable` = 全部满足，可请求验收；`none` = 没有可判定对象 */
  verdict: "blocked" | "requestable" | "none";
  /** 结论句（逐字取自上面三个常量；界面与读口同词） */
  conclusion: string;
  /** 是否允许据此得出「项目可交付」：**只有 requestable 才 true** */
  deliverable_allowed: boolean;
  /** 逐条点名（未映射 / 未验证 / 缺证 / 证据失效，每条都带对象 ID） */
  reasons: string[];
  /** 逐条点名的人工待验项（不阻断「可请求验收」，但阻断"已交付/已接受"结论） */
  user_pending: string[];
  counts: {
    objects: number;
    unmapped: number;
    verified: number;
    /** verified 里属于「来源核实」档的个数（三类静态边；**不计入功能验证完成数**） */
    verified_source_mapping: number;
    /** verified 里属于「功能验证」档的个数（必需证据全过的对象） */
    verified_functional: number;
    user_pending: number;
    unverified: number;
    missing: number;
    invalidated: number;
    /** 能力对象按 §3.2 能力分类的分档计数（功能能力 = 产品能力；设计/治理 = 非产品功能能力，不计入产品能力计数） */
    capability_functional: number;
    capability_governance: number;
    /** R-1 返工：声明表损坏 ⇒ 分类未定的能力数（不计入功能能力，也不计入治理） */
    capability_unclassified: number;
  };
  /** 口径句（含"可请求验收 ≠ 用户接受"与 P9「不给百分比」） */
  note: string;
  /** **恒 false**：交付读数不是用户接受（Agent 不代签） */
  user_accepted: false;
}

export interface ProvenanceModel {
  project_id: string;
  generated_at: string;
  /** 有没有可用的已发布规划图（false ⇒ 逐对象标注为空，读数给「没有可判定的交付对象」） */
  blueprint_available: boolean;
  baseline_id: string | null;
  generator_version: string | null;
  annotations: ProvenanceAnnotation[];
  /** 稳定 ID → 标注（界面与读口的查表口） */
  by_object: Record<string, ProvenanceAnnotation>;
  /** 需求登记的映射口径（承接需求必须能解析到登记条目，悬空即点名） */
  requirements: { registered: number; used: number; dangling: string[]; note: string };
  delivery: DeliveryReadout;
  /** 模型提案**待审线索**（§4.1／附录 E.17）：只列出供追溯，**不参与**任何验证读数与交付判定 */
  model_leads: ModelLeadInfo[];
  /** 模型提案**节点侧**待审线索（R-2）：同样只列出供追溯，**不参与**任何验证读数与交付判定 */
  model_node_leads: ModelNodeLeadInfo[];
  /** 能力分类（§3.2 能力分类声明表；null = 旧图/无表 ⇒ 全部按功能能力并注明未声明） */
  capability_classes: CapabilityClassesInfo | null;
  /** 判据成文本（P1–P11）：机器与人都能读同一份 */
  policy: readonly { rule: string; text: string }[];
}

const emptyCounts = (): DeliveryReadout["counts"] => ({
  objects: 0,
  unmapped: 0,
  verified: 0,
  verified_source_mapping: 0,
  verified_functional: 0,
  user_pending: 0,
  unverified: 0,
  missing: 0,
  invalidated: 0,
  capability_functional: 0,
  capability_governance: 0,
  /** R-1 返工：声明表损坏导致分类未定的能力数（不计入功能能力计数，也不计入治理） */
  capability_unclassified: 0,
});

/**
 * 交付读数（**唯一实现**）：逐条点名 + 结论句。
 * 判据：只要存在未映射 / 未验证 / 缺证 / 证据失效，就**不给**「项目可交付」；
 * 全部满足且只剩用户待验 ⇒ 最多「可请求验收」（**仍不等于用户接受**）。
 */
export function deliveryReadoutOf(annotations: readonly ProvenanceAnnotation[]): DeliveryReadout {
  const counts = emptyCounts();
  counts.objects = annotations.length;
  const reasons: string[] = [];
  const userPending: string[] = [];
  for (const a of annotations) {
    if (a.unmapped) counts.unmapped += 1;
    if (a.evidence_state === "verified") {
      counts.verified += 1;
      // V09-17 读数分档（§4.2 第三段／附录 E.15）：来源核实 ≠ 功能验证，分两档计数
      if (a.verification_scope === "source_mapping") counts.verified_source_mapping += 1;
      else counts.verified_functional += 1;
    }
    // §3.2 能力分类（2026-09-26 GPT-6 裁定 7）：设计/治理章节单独计数，**不计入产品能力计数**；
    // R-1 返工：表损坏时分类未定的能力**不并入功能能力计数**（另计 `capability_unclassified`），
    // 免得「解析不出来」被读成「7 个功能能力照旧」。
    if (a.kind === "capability") {
      if (a.capability_class === "governance") counts.capability_governance += 1;
      else if (a.capability_class === "unknown") counts.capability_unclassified += 1;
      else counts.capability_functional += 1;
    }
    if (a.evidence_state === "user_pending") counts.user_pending += 1;
    if (a.evidence_state === "unverified") counts.unverified += 1;
    if (a.evidence_state === "missing") counts.missing += 1;
    if (a.evidence_state === "invalidated") counts.invalidated += 1;
    for (const b of a.blockers) reasons.push(b);
    if (a.user_pending) userPending.push(`${USER_PENDING_LABEL}：${a.label}（${a.object_id}）——${a.user_actions.join("；")}`);
  }
  if (annotations.length === 0) {
    return {
      verdict: "none",
      conclusion: DELIVERY_NONE_CONCLUSION,
      deliverable_allowed: false,
      reasons: ["六图里没有可判定的节点/关系：没有对象就没有可交付结论可下（不空集判绿）"],
      user_pending: userPending,
      counts,
      note:
        "没有可判定对象时**不得**得出「项目可交付」结论（§4.2：不空集判绿）；" +
        "先让图纸派生出台规划图，再谈来源与证据（§3.2）",
      user_accepted: false,
    };
  }
  if (reasons.length > 0) {
    return {
      verdict: "blocked",
      conclusion: DELIVERY_BLOCKED_CONCLUSION,
      deliverable_allowed: false,
      reasons,
      user_pending: userPending,
      counts,
      note:
        `存在未映射／未验证／缺证／证据失效的对象 ${reasons.length} 条（逐条点名见上），` +
        "因此**不给**「项目可交付」结论（DESIGN.md §4.2／附录 E.9）；" +
        "绿＝该对象当前全部必需验证证据有效，缺一项就不是绿；灰色 planned 可以如实存在，但不算已交付。" +
        `读数分档：verified ${counts.verified} 条里，来源核实（三类静态边的来源/映射有效）${counts.verified_source_mapping} 条、` +
        `功能验证（必需证据全过）${counts.verified_functional} 条——**来源核实 ≠ 功能验证，来源核实不计入功能验证完成数**（§4.2／附录 E.15）。` +
        "本读数**不用节点数算完成率**（P9）——只看逐条点名。",
      user_accepted: false,
    };
  }
  return {
    verdict: "requestable",
    conclusion: DELIVERY_REQUESTABLE_CONCLUSION,
    deliverable_allowed: true,
    reasons: [],
    user_pending: userPending,
    counts,
    note:
      `全部 ${counts.objects} 个对象的来源、映射与必需证据都在场且有效 ⇒ 最多给「${DELIVERY_REQUESTABLE_CONCLUSION}」。` +
      `读数分档：verified ${counts.verified} 条里，来源核实 ${counts.verified_source_mapping} 条、功能验证 ${counts.verified_functional} 条——` +
      "**来源核实 ≠ 功能验证，来源核实不计入功能验证完成数**（§4.2／附录 E.15）。" +
      "**可请求验收仍不等于用户接受**：" +
      (userPending.length > 0
        ? `仍有 ${userPending.length} 项人工待验要用户本人记录（Agent 不代签，§5.8）；`
        : "本批没有逐对象的人工待验项，但**批次最终交付仍要用户本人做验收记录**（附录 E.9 的批次验收登记位只等用户本人填写，Agent 不代填）；") +
      "§5.8／附录 E.9 还要求另有非作者复核与已知限制经用户接受，才算批次最终交付。" +
      "本读数**不给完成百分比**（P9）。",
    user_accepted: false,
  };
}

/** 一个对象的标注（唯一实现；判据全部来自 `evidenceStateOf` 与来源归类） */
export function annotateObject(
  input: ProvenanceObjectInput,
  requirements: ReadonlyMap<string, RequirementRef>,
): ProvenanceAnnotation {
  const designRefs = input.source_refs.filter((r) => sourceKindOfRefKind(r.kind) === "design");
  const codeRefs = input.source_refs.filter((r) => sourceKindOfRefKind(r.kind) === "code");
  const knownReq = input.requirement_ids.filter((id) => requirements.has(id));
  const danglingReq = input.requirement_ids.filter((id) => !requirements.has(id));
  const sourceKinds: ProvenanceSourceKind[] = [];
  if (knownReq.length > 0) sourceKinds.push("requirement");
  if (designRefs.length > 0) sourceKinds.push("design");
  if (codeRefs.length > 0) sourceKinds.push("code");
  const unmapped = sourceKinds.length === 0;
  const verdict = evidenceStateOf(input.evidence);
  // §3.2 能力分类（2026-09-26 GPT-6 裁定 7）：设计/治理章节的能力对象必须带限定文案——
  // 它**不是**产品功能能力，不得读作「已验证能力」；其成员/来源/证据的可追溯性不受影响。
  // R-1 返工：分类未定（声明表损坏）的对象同样带限定——不得当功能能力读。
  const basis =
    input.kind === "capability" && input.capability_class === "governance"
      ? `${verdict.basis}；本对象是**设计/治理章节，非产品功能能力**（§3.2 能力分类声明）——不计入产品能力计数、不以「已验证能力」显示`
      : input.kind === "capability" && input.capability_class === "unknown"
        ? `${verdict.basis}；本对象的能力分类**未定**（能力分类声明表损坏，§3.2／R-1）——不按功能能力计数，不得据此判绿或得出「可请求验收」结论`
        : verdict.basis;

  const blockers: string[] = [];
  if (unmapped) {
    blockers.push(
      `未映射：${input.label}（${input.object_id}）没有任何需求／设计／代码来源——` +
        (danglingReq.length > 0
          ? `承接的需求 id 在登记表里查不到（${danglingReq.join("、")}）`
          : "来源引用为空") +
        "，不作已交付，也不涂绿（§3.2／§4.2）",
    );
  } else if (danglingReq.length > 0) {
    blockers.push(
      `来源悬空：${input.label}（${input.object_id}）承接的需求 id 在登记表里查不到（${danglingReq.join("、")}）——` +
        "悬空引用按未映射处理，不当作有效需求来源（§2.5／§4.2）",
    );
  }
  if (input.evidence.sources_stale.length > 0 || input.evidence.sources_unlocatable.length > 0) {
    const why = [
      ...input.evidence.sources_stale.map((r) => `${r}（哈希对不上）`),
      ...input.evidence.sources_unlocatable.map((r) => `${r}（定位不到）`),
    ];
    blockers.push(
      `来源失效：${input.label}（${input.object_id}）的 ${why.length} 条来源引用复算不过` +
        `（${why.slice(0, 3).join("、")}）——证据失效，旧绿不作数（§4.1／§4.2）`,
    );
  }
  if (isBlockingEvidenceState(verdict.state)) {
    blockers.push(
      `${EVIDENCE_STATE_PALETTE[verdict.state].full}：${input.label}（${input.object_id}）——${verdict.basis}`,
    );
  }
  // P11 画布真实缺口（2026-09-26 复核）：证据链说有成员、画布分组画不出来 ⇒ 阻断并逐条点名
  for (const g of input.evidence.canvas_gaps ?? []) {
    blockers.push(`画布缺口：${input.label}（${input.object_id}）——${g}（P11：修图面归属数据，不靠人工验收绕）`);
  }

  return {
    object_id: input.object_id,
    object_kind: input.object_kind,
    label: input.label,
    kind: input.kind,
    capability_class: input.capability_class ?? null,
    source_kinds: sourceKinds,
    source_kind_label: unmapped
      ? UNMAPPED_LABEL
      : sourceKinds.map((k) => PROVENANCE_SOURCE_LABELS[k]).join(" + "),
    unmapped,
    mapping: {
      requirement_ids: [...knownReq],
      dangling_requirement_ids: [...danglingReq],
      design_refs: designRefs.map((r) => ({ path: r.path, locator: r.locator, sha256: r.sha256 })),
      code_refs: codeRefs.map((r) => ({ path: r.path, locator: r.locator, sha256: r.sha256 })),
    },
    evidence_state: verdict.state,
    evidence_state_label: EVIDENCE_STATE_PALETTE[verdict.state].short,
    verification_scope: input.evidence.static_relation != null ? "source_mapping" : "functional",
    verification_passed: verdict.verification_passed,
    evidence_refs: [...input.evidence.evidence_refs],
    basis,
    blockers,
    user_pending: verdict.state === "user_pending",
    user_actions: [...input.evidence.user_actions],
    user_accepted: false,
  };
}

/** 装配整份模型（判据同上；本函数只做"逐条标注 + 汇总读数"，不新造规则） */
export function buildProvenanceModel(input: {
  project_id: string;
  generated_at: string;
  blueprint_available: boolean;
  baseline_id?: string | null;
  generator_version?: string | null;
  objects: readonly ProvenanceObjectInput[];
  requirements: readonly RequirementRef[];
  /** 模型提案待审线索（只列出不参与读数；缺省 = 空） */
  model_leads?: readonly ModelLeadInfo[];
  /** 模型提案**节点侧**待审线索（R-2；只列出不参与读数；缺省 = 空） */
  model_node_leads?: readonly ModelNodeLeadInfo[];
  /** 能力分类（缺省 = null ⇒ 全部按功能能力并注明未声明） */
  capability_classes?: CapabilityClassesInfo | null;
}): ProvenanceModel {
  const index = new Map(input.requirements.map((r) => [r.requirement_id, r]));
  const annotations = input.objects.map((o) => annotateObject(o, index));
  const byObject: Record<string, ProvenanceAnnotation> = {};
  for (const a of annotations) byObject[a.object_id] = a;
  const used = new Set<string>();
  const dangling = new Set<string>();
  for (const o of input.objects) {
    for (const id of o.requirement_ids) {
      if (index.has(id)) used.add(id);
      else dangling.add(id);
    }
  }
  return {
    project_id: input.project_id,
    generated_at: input.generated_at,
    blueprint_available: input.blueprint_available,
    baseline_id: input.baseline_id ?? null,
    generator_version: input.generator_version ?? null,
    annotations,
    by_object: byObject,
    requirements: {
      registered: input.requirements.length,
      used: used.size,
      dangling: [...dangling].sort(),
      note:
        input.requirements.length === 0
          ? "需求登记表是空的（本项目还没经正规入口登记需求）：承接需求一栏如实为空，不硬凑一个需求来源（§2.5／附录 G.2）"
          : `需求登记 ${input.requirements.length} 条；被图上的对象承接 ${used.size} 条` +
            (dangling.size === 0 ? "" : `；另有 ${dangling.size} 条承接 id 悬空（已逐条点名）`),
    },
    delivery: deliveryReadoutOf(annotations),
    model_leads: [...(input.model_leads ?? [])],
    model_node_leads: [...(input.model_node_leads ?? [])],
    capability_classes: input.capability_classes ?? null,
    policy: PROVENANCE_POLICY,
  };
}

// ══════════════════ ⑥ 同组关系可见性（§3.2；文件责任里的「同组关系」判据） ══════════════════

/**
 * 一条**同组关系**（同一分组内两端解析到同一个分组节点的关系，典型＝能力与其下属模块之间的
 * 设计接口关系）。§3.2（2026-09-24 用户澄清）：这类关系**必须在图上真实可查看、可点开追到来源**，
 * 不能只用一段文字解释充数。
 */
export interface IntraGroupRelation {
  /** 关系稳定 ID（蓝图关系键 `source>target:kind`） */
  edge_id: string;
  /** 所在分组（能力节点 id / `ungrouped:*`） */
  group_id: string;
  group_label: string;
  /** 关系种类（`design_interface` 等）与线语义 */
  kind: string;
  semantics: string;
  source: string;
  target: string;
  /** 来源引用（**必须有**：没有来源就追不到出处 ⇒ 违规） */
  sources: readonly SourceRefLike[];
  /** 追溯行（点开这条关系后显示的出处，逐条一行） */
  trace_lines: string[];
  /** 这条关系有没有**画在图上**（true = 图上有可点的锚点；false = 只在文字里解释 ⇒ 违规） */
  visible_on_graph: boolean;
}

/** 把一条关系摊成可读的追溯行（唯一实现；界面与脚本读同一份） */
export function traceLinesOf(relation: {
  edge_id: string;
  kind: string;
  semantics: string;
  source: string;
  target: string;
  sources: readonly SourceRefLike[];
}): string[] {
  const lines: string[] = [
    `关系 ${relation.edge_id}：${relation.source} → ${relation.target}（种类 ${relation.kind}，线语义 ${relation.semantics}）`,
  ];
  if (relation.sources.length === 0) {
    lines.push("来源：无（这条关系拿不出出处——按 §4.1 是待核实的模型推断，不当已确认架构）");
    return lines;
  }
  for (const r of relation.sources) {
    const kindLabel = sourceKindOfRefKind(r.kind) === "design" ? "设计来源" : sourceKindOfRefKind(r.kind) === "code" ? "代码来源" : "未归类来源";
    lines.push(
      `${kindLabel}：${r.path} · ${r.locator}` +
        (r.sha256 === null ? "（引用时无哈希：代码模块按 id 定位）" : ` · 引用时哈希 ${r.sha256.slice(0, 12)}…`),
    );
  }
  return lines;
}

/** 同组关系的来源种类（供界面标"这条关系是设计接口"还是"模型推断"） */
export function intraRelationSourceKinds(relation: IntraGroupRelation): ProvenanceSourceKind[] {
  const out: ProvenanceSourceKind[] = [];
  for (const r of relation.sources) {
    const k = sourceKindOfRefKind(r.kind);
    if (k !== null && !out.includes(k)) out.push(k);
  }
  return out;
}

/** 一条同组关系的图面输入（界面从视图模型的 `intra_relations` 摊出来；判据见本文件） */
export interface IntraGroupRelationInput {
  edge_id: string;
  group_id: string;
  group_label: string;
  kind: string;
  semantics: string;
  source: string;
  target: string;
  sources: readonly SourceRefLike[];
  /** 图上有没有可点的锚点（界面把逐条条目画出来时恒 true；反例测试传 false） */
  visible_on_graph: boolean;
}

/**
 * 同组关系判据的装配口（唯一实现）：把视图模型的同组关系摊成带**追溯行**的条目。
 * 追溯行由 `traceLinesOf` 生成——界面点开一条就显示它，**不另写一份出处文案**。
 */
export function intraGroupRelationsOf(
  inputs: readonly IntraGroupRelationInput[],
): IntraGroupRelation[] {
  return inputs.map((i) => ({
    edge_id: i.edge_id,
    group_id: i.group_id,
    group_label: i.group_label,
    kind: i.kind,
    semantics: i.semantics,
    source: i.source,
    target: i.target,
    sources: i.sources,
    trace_lines: traceLinesOf({
      edge_id: i.edge_id,
      kind: i.kind,
      semantics: i.semantics,
      source: i.source,
      target: i.target,
      sources: i.sources,
    }),
    visible_on_graph: i.visible_on_graph,
  }));
}

/**
 * 能力 → 成员（§3.2 分组口径的**唯一实现**，供来源/证据标注按父级汇总用）：
 *   · `design_interface`（能力 → 模块）与其反向、`task_design_ref`（任务 → 能力）都算成员归属；
 *   · 与主视图分组（`projectGraph.buildViewModel` 的 `ownerOfMember`）同一规则——归属只看稳定 ID，
 *     不看名字，也不看模型推断。
 */
export function capabilityMembersOf(
  edges: readonly { source: string; target: string; kind: string }[],
  capabilityIds: ReadonlySet<string>,
): Record<string, string[]> {
  // V09-55：枚举实现移到 `featureScope`（成员账目唯一出处），这里保持**声明成员**语义不变
  // （来源/证据标注与蓝图对账沿用；范围主状态用 `scopeMemberLedgerOf` 的「声明＋实测派生」）。
  return capabilityDeclaredMembersOf(edges, capabilityIds);
}

// ══════════════════ ⑦ 机械判据（验证脚本正反两跑；每条违规码都有反例） ══════════════════

export type ProvenanceIssueCode =
  /** 未映射却涂绿（把"来源都没有"的对象显示成已验证） */
  | "unmapped_marked_verified"
  /** 未映射却省略标注（没有显式写"未映射"） */
  | "unmapped_without_label"
  /** 来源种类不在三档里 */
  | "source_kind_unknown"
  /** 未验证 / 缺证 / 证据失效没有写原因（省略标注） */
  | "state_without_basis"
  /** 已通过却没有必需项或证据引用（拿空集冒充通过） */
  | "verified_without_evidence"
  /** 把「用户待验」显示成「已验证」（③ 的反例） */
  | "user_pending_marked_verified"
  /** 把「用户待验」置成已接受（Agent 代签） */
  | "user_pending_auto_accepted"
  /** 证据状态不在五档里 */
  | "evidence_state_unknown"
  /** 承接的需求 id 悬空却当作有效来源 */
  | "dangling_requirement_ref"
  /** 有阻断却没逐条点名 */
  | "blocker_without_names"
  /** 存在阻断却仍给可交付/可请求验收结论（② 的反例） */
  | "blocked_but_deliverable"
  /** 给了「可请求验收」却读成用户已接受（② 的反例） */
  | "requestable_read_as_accepted"
  /** 交付读数里出现完成百分比（P9 的反例） */
  | "completion_percent_present"
  /** 同组关系只在文字里解释（④ 的反例） */
  | "intra_relation_text_only"
  /** 同组关系拿不出来源（追不到出处） */
  | "intra_relation_without_source";

export interface ProvenanceIssue {
  code: ProvenanceIssueCode;
  subject: string;
  detail: string;
}

const SCOPE_IDS = ["requirement", "design", "code"] as const;

/**
 * 机械判据（口径见 `PROVENANCE_POLICY`）：违规**逐条点名**，不做"整体看起来还行"的模糊判断。
 * 真实项目的模型跑出 0 违规；反例模型必须跑出对应码——验证脚本正反两跑。
 */
export function validateProvenanceModel(model: ProvenanceModel): ProvenanceIssue[] {
  const issues: ProvenanceIssue[] = [];
  for (const a of model.annotations) {
    for (const k of a.source_kinds) {
      if (!(SCOPE_IDS as readonly string[]).includes(k)) {
        issues.push({ code: "source_kind_unknown", subject: a.object_id, detail: `来源种类 ${String(k)} 不在需求/设计/代码三档里` });
      }
    }
    if (a.source_kinds.length === 0 && !a.unmapped) {
      issues.push({
        code: "unmapped_without_label",
        subject: a.object_id,
        detail: "一条来源都没有却没标「未映射」（省略标注 ⇒ 不合格）",
      });
    }
    if (a.unmapped && a.source_kind_label.trim() === "") {
      issues.push({ code: "unmapped_without_label", subject: a.object_id, detail: "标了未映射但没有可读的标注文字" });
    }
    if (a.unmapped && a.evidence_state === "verified") {
      issues.push({
        code: "unmapped_marked_verified",
        subject: a.object_id,
        detail: "未映射（没有需求/设计/代码来源）却标了「已验证」——不得给未映射对象涂绿（§4.2）",
      });
    }
    if (!(EVIDENCE_STATE_ORDER as readonly string[]).includes(a.evidence_state)) {
      issues.push({ code: "evidence_state_unknown", subject: a.object_id, detail: `证据状态 ${String(a.evidence_state)} 不在五档里` });
    }
    if (a.evidence_state !== "verified" && a.evidence_state !== "user_pending" && a.basis.trim() === "") {
      issues.push({
        code: "state_without_basis",
        subject: a.object_id,
        detail: `${EVIDENCE_STATE_PALETTE[a.evidence_state].short} 没有写原因（省略标注 ⇒ 不合格）`,
      });
    }
    if (a.evidence_state === "verified" && (a.evidence_refs.length === 0 && !a.verification_passed)) {
      issues.push({
        code: "verified_without_evidence",
        subject: a.object_id,
        detail: "标了已验证却拿不出证据引用，也没有「必需项已过」的判据",
      });
    }
    if (a.user_pending && a.evidence_state === "verified") {
      issues.push({
        code: "user_pending_marked_verified",
        subject: a.object_id,
        detail: "这一项标了「用户待验」却显示成「已验证」——Agent 不得把待验项读成通过（③ 反例）",
      });
    }
    if (a.user_accepted !== false) {
      issues.push({
        code: "user_pending_auto_accepted",
        subject: a.object_id,
        detail: "标注把人工待验置成了已接受——人工验收只能由用户本人记录（§5.8）",
      });
    }
    if (a.mapping.dangling_requirement_ids.length > 0 && a.source_kinds.includes("requirement")) {
      issues.push({
        code: "dangling_requirement_ref",
        subject: a.object_id,
        detail: `承接的需求 id 悬空（${a.mapping.dangling_requirement_ids.join("、")}）却仍算作有效需求来源`,
      });
    }
    const blocking = a.unmapped || isBlockingEvidenceState(a.evidence_state);
    if (blocking && a.blockers.length === 0) {
      issues.push({
        code: "blocker_without_names",
        subject: a.object_id,
        detail: "这一项阻断交付，却没有逐条点名的阻断原因",
      });
    }
    for (const b of a.blockers) {
      if (!b.includes(a.object_id)) {
        issues.push({ code: "blocker_without_names", subject: a.object_id, detail: `阻断原因没有点名对象 ID：${b.slice(0, 60)}` });
      }
    }
  }

  const d = model.delivery;
  const blockingAnnotations = model.annotations.filter(
    (a) => a.unmapped || isBlockingEvidenceState(a.evidence_state),
  );
  if (blockingAnnotations.length > 0 && d.verdict !== "blocked") {
    issues.push({
      code: "blocked_but_deliverable",
      subject: "delivery",
      detail:
        `有 ${blockingAnnotations.length} 个对象未映射/未验证/缺证/证据失效，却给出「${d.conclusion}」` +
        "（存在阻断时必须给「不可判定项目可交付」）",
    });
  }
  if (blockingAnnotations.length > 0 && d.deliverable_allowed) {
    issues.push({ code: "blocked_but_deliverable", subject: "delivery", detail: "存在阻断却把 deliverable_allowed 置为 true" });
  }
  if (blockingAnnotations.length > 0 && d.conclusion !== DELIVERY_BLOCKED_CONCLUSION) {
    issues.push({
      code: "blocked_but_deliverable",
      subject: "delivery",
      detail: `存在阻断时结论句必须是「${DELIVERY_BLOCKED_CONCLUSION}」，实际是「${d.conclusion}」`,
    });
  }
  if (d.verdict === "blocked" && d.reasons.length === 0) {
    issues.push({ code: "blocker_without_names", subject: "delivery", detail: "给了阻断结论却没有逐条点名原因" });
  }
  for (const r of d.reasons) {
    if (!model.annotations.some((a) => r.includes(a.object_id))) {
      issues.push({ code: "blocker_without_names", subject: "delivery", detail: `阻断原因没有点名对象 ID：${r.slice(0, 60)}` });
    }
  }
  if (d.user_accepted !== false) {
    issues.push({ code: "user_pending_auto_accepted", subject: "delivery", detail: "交付读数把人工待验置成了已接受（Agent 代签）" });
  }
  if (d.verdict === "requestable") {
    const pending = model.annotations.filter((a) => a.user_pending).length;
    if (pending > 0 && (!d.note.includes("不等于用户接受") || !d.conclusion.includes(DELIVERY_REQUESTABLE_CONCLUSION))) {
      issues.push({
        code: "requestable_read_as_accepted",
        subject: "delivery",
        detail: `有 ${pending} 项人工待验却把「可请求验收」写成/读成已接受（必须写明"仍不等于用户接受"）`,
      });
    }
  }
  if (d.deliverable_allowed !== (d.verdict === "requestable")) {
    issues.push({
      code: "blocked_but_deliverable",
      subject: "delivery",
      detail: `deliverable_allowed=${String(d.deliverable_allowed)} 与 verdict=${d.verdict} 不一致（只有可请求验收才允许下可交付结论）`,
    });
  }
  for (const text of [d.conclusion, d.note, ...d.reasons, ...d.user_pending]) {
    // P9：只有"真出现百分比数字"才算违规——判据自己那句"不用节点数算完成率/不给完成百分比"
    // 没有数字，不许被当成违规（判据自伤会造成假阳性）
    if (/[\d.]+\s*%/.test(text) || /百分之\s*[\d.]+/.test(text)) {
      issues.push({
        code: "completion_percent_present",
        subject: "delivery",
        detail: `交付读数里出现百分比/完成率数字：${text.slice(0, 60)}（不得用节点数算虚假完成率，§4.2）`,
      });
    }
  }
  return issues;
}

/** 同组关系的机械判据（④）：一条关系要么**在图上可点开追来源**，要么判违规 */
export function validateIntraGroupRelations(relations: readonly IntraGroupRelation[]): ProvenanceIssue[] {
  const issues: ProvenanceIssue[] = [];
  for (const r of relations) {
    if (r.sources.length === 0) {
      issues.push({
        code: "intra_relation_without_source",
        subject: r.edge_id,
        detail: `同组关系 ${r.edge_id}（${r.source} → ${r.target}）拿不出任何来源：追不到出处（§3.2／§4.1）`,
      });
    }
    if (!r.visible_on_graph) {
      issues.push({
        code: "intra_relation_text_only",
        subject: r.edge_id,
        detail:
          `同组关系 ${r.edge_id}（${r.source} → ${r.target}，分组 ${r.group_id}）只在文字里解释、图上不可点开——` +
          "§3.2 要求这类关系在图上真实可查看、可点开追到来源",
      });
    }
    if (r.trace_lines.length === 0) {
      issues.push({ code: "intra_relation_without_source", subject: r.edge_id, detail: "同组关系没有可读的追溯行（点开也追不到来源）" });
    }
  }
  return issues;
}
