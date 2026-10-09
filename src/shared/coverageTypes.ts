// 功能清单 / 唯一义务派生的**共享类型**（B2/V09-52；DESIGN.md §2.5.1／§2.6／§4.2／§6.12）。
//
// 为什么单独一层、而且**无 fs 依赖**：`feature_item` 与四维读数要同时被**服务端派生**与**界面渲染**
// 读同一份形态（DESIGN §2.6 单一派生 → 各只读投影）。界面不得 import 带 fs 的服务端模块，
// 所以形态落在这里；服务端与 UI 都只 import 本模块（`import type` 为主）。
//
// 红线（§2.6／§4.2／CONTRACT.derivation.prohibitions）：
//   · 本模块**只有类型**，不含任何判据、不读盘、不写盘；
//   · 四维读数**分开**，不合并进单一枚举；绿色只取 `verification`；
//   · 复用既有枚举（DisplayStatus／ExecutionDimension／AcceptanceDimension／EvidenceState），
//     不新造状态色系（§4.2、§1.4）。

import type {
  AcceptanceDimension,
  DisplayStatus,
  ExecutionDimension,
} from "../server/work/statusProjection";
import type { RevisionKind } from "../server/work/evidence";
import type { EvidenceState } from "../ui/arch/provenance";

/** 复用既有五档证据状态（`src/ui/arch/provenance.ts` 是唯一判据；本处只 re-export 形态） */
export type { EvidenceState };
/** 复用既有执行/验收/主状态枚举（唯一判据在 `statusProjection.ts`） */
export type { AcceptanceDimension, DisplayStatus, ExecutionDimension };

// ── 维度的取值（四维分开，见 §4.2） ──

/**
 * 维度① 设计覆盖：需求对设计的**语义**覆盖（§4.2）。
 * **不得**由引用存在／模型提案／设计被激活自动推断（§2.5.1、§6.12）。
 */
export type DesignCoverageState = "缺失" | "部分" | "待审" | "已核对" | "源变待复核" | "无法判断";

/**
 * 维度② 实现：沿既有事实，**不凭提交宣称已实现**（§4.2、附录 E.9）。
 * `no_run_record` = 图上有定义、账本无运行投影——**不得**读成 ExecutionDimension 的 `not_started`。
 */
export type ImplementationState = ExecutionDimension | "no_run_record";

/** 覆盖结论的 review 四条件（§2.5.1）：reviewer/ref/section_sha256/基线已批准。任一不足 ⇒ 待审 */
export interface DesignCoverageReview {
  reviewer: string | null;
  /** 项目相对路径#锚点 或 证据哈希 */
  ref: string | null;
  section_sha256: string | null;
  /** 派生：reviewer 非空 ∧ ref 可定位 ∧ section_sha256 与被覆盖章节现值一致 ∧ 基线已批准 */
  verified: boolean;
  /**
   * ref 的形态与**实际定位结果**（不是形态像就算数，§6.12／README「不能任意 64hex 蒙混」）：
   *   · `section` = `<项目相对路径>#<章节锚点>`，本文件已核**该路径真实存在**且**该章节在此文件里定位到**；
   *   · `evidence` = 64 位小写十六进制，已核**证据正文在证据库里取得到**；
   *   · `none` = 没有 ref，或形态不认识（一律按不可定位处理）。
   */
  ref_kind: "section" | "evidence" | "none";
  /** 没通过 review 时的**人话原因**（逐条点名缺哪一条；verified=true 时为 null） */
  unmet: string | null;
}

export interface DesignCoverage {
  state: DesignCoverageState;
  review: DesignCoverageReview;
  gap: string | null;
}

/** 维度② 实现读数：state + 账本事实引用（如最近 task.* 事件 seq） */
export interface ImplementationReadout {
  state: ImplementationState;
  basis: string | null;
}

/** 维度③ 验证：**复用** canonical（statusProjection.ts / provenance.ts 的取值），不另算一套 */
export interface VerificationEvidenceEntry {
  check_id: string;
  evidence_ref: string;
  effective: "passed" | "failed" | "stale" | "unknown" | "not_checked";
}

export interface VerificationReadout {
  display_status: DisplayStatus;
  evidence_state: EvidenceState;
  required_count: number;
  passed_count: number;
  /** 缺口逐条（check_id 或人话标签） */
  missing: string[];
  /** 受检源/产物版本（binding.revision；拿不到 = null） */
  effective_version: string | null;
  evidence_entry: VerificationEvidenceEntry[];
}

/** 维度④ 用户接受：**复用**既有 Gate 枚举（保留 accepted_known_limit），与设计审定分开（§5.8） */
export interface UserAcceptanceReadout {
  state: AcceptanceDimension;
  /**
   * 支撑该判词的 Gate 记录 id（多条时以 `、` 连接；`pending` 时为 null）。
   * **与判词对应**：不接受"随便拿第一条 gate"——只带真正支撑这个结论的记录（§5.8／附录 E.9）。
   */
  gate_ref: string | null;
  /** 该功能的成员边界（本范围由哪些任务组成）与哪些成员已有 Gate：单卡 accepted ≠ 多卡功能 accepted */
  scope_tasks: string[];
  accepted_tasks: string[];
  /** 未覆盖成员的人话说明（pending/rejected 时必填） */
  unmet: string | null;
}

/** 待决项**另列**，不与四维混（§4.2） */
export interface PendingDecision {
  decision_id: string;
  question: string;
  impact: string;
  suggestion: string;
  entry: string;
}

/** 可点击回原文的设计章节引用（标题／行号／锚点／章节 hash） */
export interface CoverageDesignSectionRef {
  title: string;
  /** 章节标题的 1 起行号（现读现算） */
  line: number;
  /** 章节号/锚点（如 "3.5"） */
  anchor: string;
  /** 该章节规范化文本的 sha256（与 review.section_sha256 同算法） */
  hash: string;
  status: "located" | "unresolved";
}

export interface RequirementRef {
  requirement_id: string;
  source_ref: string;
  certainty: "明确" | "推断" | "待确认";
}

export interface TaskRef {
  task_id: string;
  definition_fingerprint: string;
}

/** 派生来源与版本（同一 revision 的事实快照） */
export interface ProvenanceDerivation {
  design_revision: string | null;
  plan_revision: string | null;
  plan_definition: string | null;
  ledger_last_seq: number;
}

export interface ProvenanceReadout {
  /**
   * 这条 `item_id` 从哪来（四类，互斥）：
   *   · `declared` = 审定声明行（正式功能）；
   *   · `mapped_requirement_pending` = 已登记需求待映射（`explicit`/`inferred` 且未被正式声明映射）——**阻断交付**；
   *   · `registered_candidate` = 已登记待确认候选（`unconfirmed` 且未被正式声明映射）——单列，**不阻断**；
   *   · `unregistered_candidate` = 未登记候选（用户补充，尚未登记为需求）。
   */
  extraction: "declared" | "mapped_requirement_pending" | "registered_candidate" | "unregistered_candidate";
  /** 身份未定的映射项（人话；空 = 无） */
  unmapped: string[];
  /** 待审线索（模型线索一律待审，不升格，§4.1） */
  pending_leads: string[];
  derivation: ProvenanceDerivation;
}

// ── 交付总览（V09-62；DESIGN.md §3.16／§3.17） ──
//
// 交付总览是人的默认项目入口，也是 Agent 的同源读口：**只读适配**同一份
// `feature_ledger` 事实快照与唯一义务派生结论（`deriveObligations` / `statusProjection`），
// **不新建完成台账**、不另算一套绿色（§3.16）。以下类型只是那条结论的形态落点。

/**
 * 一条**非作者审查**证据：canonical 投影 `evidence_basis` 的只读适配（§3.16）。
 * **不放宽**独立性判据——只有 canonical 判为「有效通过 ∧ 独立」的记录才进 `state=passed` 的计数；
 * 作者自检、同会话降级、旧通过（stale）与未解决失败都不充作独立审查完成。
 */
export interface AgentReviewEvidence {
  check_id: string;
  /** 记录者/审查者（canonical `actor_id`；人可据此展开核对） */
  reviewer: string;
  /** 记录时间（canonical `at`） */
  at: string;
  /** 证据引用（canonical `evidence_sha256`；拿不到时退回 `record_ref`，再拿不到为空串） */
  evidence_ref: string;
  /** 账本记录引用（canonical `record_ref`） */
  record_ref: string | null;
  /** 独立性盲点逐条公开（canonical `independence_notes`；空 = 没有要公开的） */
  notes: string[];
}

/** 每项正式功能的**非作者审查**读数（由 canonical 投影的有效性与独立性派生，§3.16） */
export interface AgentReview {
  state: "passed" | "pending" | "unknown";
  /** 该功能范围声明的必需检查数（canonical `required_count`） */
  required_count: number;
  /** 其中**有效且独立**通过的检查数（作者自检不计，canonical 独立性） */
  passed_count: number;
  /** 缺口逐条点名（未通过/作者自检/开放缺陷/缺投影/未归属） */
  missing: string[];
  /** 有效独立通过的检查的审查记录（reviewer/time/ref 供人展开核对） */
  evidence: AgentReviewEvidence[];
}

/** PLAN「交付核对声明」的固定三类核对项（§3.16） */
export type DeliveryGateId = "coverage" | "review" | "runtime";

/** 一类交付核对（引用 PLAN 的稳定检查键；缺/重复/悬空/空/未批准一律 fail-closed） */
export interface DeliveryGate {
  id: DeliveryGateId;
  label: string;
  state: "passed" | "pending" | "unknown";
  check_ids: string[];
  /** 未通过原因逐条点名（缺声明/重复/悬空/未批准/无记录/有效性或独立性不足） */
  missing: string[];
  evidence: AgentReviewEvidence[];
}

/** 一条阻断原因（把结论压回「不可试用」的具体事项） */
export interface DeliveryBlocker {
  kind: string;
  item_id: string | null;
  message: string;
}

/**
 * 交付范围**集成检查**（`project:delivery` 的组合流程检查）的读数（§3.16）。
 * 与 `resolveDeliveryIntegration` **同源**：成功时也带 `check_ids` 与 `evidence`，
 * 让人能展开核对成功的组合流程依据，而不只在失败时看 blocker。
 * 旧服务缺这个字段 ⇒ 未知（不回退假成功）。
 */
export interface DeliveryIntegrationReadout {
  state: "passed" | "pending" | "unknown";
  check_ids: string[];
  /** 未通过原因逐条点名（缺声明/声明空集/无非必需项/未批准/无投影/无记录/有效性或独立性不足/开放缺陷） */
  missing: string[];
  evidence: AgentReviewEvidence[];
}

/**
 * 交付总览（`FeatureLedger.delivery`；§3.16／§3.17）。
 * 全范围先在服务端算好再分页；历史/局部/未批准/漂移只给有界信息（`scope`/`state=unknown`），
 * **不宣布当前整项目可试用**。人工接受单列，Agent 不代签。
 */
export interface DeliveryOverview {
  state: "ready_for_trial" | "not_ready" | "unknown";
  summary: string;
  scope: "project" | "partial" | "historical";
  counts: {
    features: number;
    design_checked: number;
    verified: number;
    reviewed: number;
    requirements: number;
    mapped_requirements: number;
    /** 正式待映射需求数（`explicit`/`inferred`；不阻断以外的候选不在此列） */
    pending_requirements: number;
    /**
     * 正式需求分母 = `mapped_requirements` + `pending_requirements`（不含候选）。
     * 旧服务缺此字段 ⇒ 未知（界面显式"未知"，**不可当作 0**）。
     */
    formal_requirements?: number;
    /**
     * 已登记待确认候选数（`unconfirmed` 且未被正式声明映射）。旧服务缺此字段 ⇒ 未知。
     */
    registered_candidates?: number;
    /** 未登记候选（用户补充/待议）条数 */
    candidates: number;
  };
  gates: DeliveryGate[];
  /**
   * 交付范围集成检查（`project:delivery`）的读数；成功时也带依据，供人展开。
   * 旧服务缺这个字段 ⇒ 未知（见 `DeliveryIntegrationReadout`）。
   */
  integration?: DeliveryIntegrationReadout;
  blockers: DeliveryBlocker[];
  version: {
    design_revision: string | null;
    plan_revision: string | null;
    baseline_id: string | null;
    ledger_last_seq: number;
    drift: string | null;
  };
  user_acceptance: {
    pending: number;
    accepted: number;
    rejected: number;
    accepted_known_limit: number;
  };
}

/** 功能清单的一项（`item_id` 稳定，见 §2.5.1） */
export interface FeatureItem {
  /** `cap-*` | `pending:<requirement_id>` | `pending:<稳定来源定位符摘要>` */
  item_id: string;
  scope_id: string | null;
  scope_revision: string;
  display_name: string;
  user_description: string;
  scenario: string;
  requirement_refs: RequirementRef[];
  design_section_refs: CoverageDesignSectionRef[];
  design_coverage: DesignCoverage;
  implementation: ImplementationReadout;
  verification: VerificationReadout;
  user_acceptance: UserAcceptanceReadout;
  pending_decisions: PendingDecision[];
  task_refs: TaskRef[];
  provenance: ProvenanceReadout;
  /**
   * 每项功能附的**非作者审查**读数（§3.16）：由 canonical 投影的实际有效检查与独立性派生。
   * 旧服务缺这个字段 ⇒ 未知（不回退假成功）。
   */
  agent_review?: AgentReview;
}

// ── 覆盖摘要（与分页分开，见 §6.12） ──

export interface ExaminedSource {
  ref: string;
  kind: string;
}

export interface UnexaminedSource {
  ref: string;
  kind: string;
  reason: string;
}

export interface LedgerCoverage {
  /** 本次真正读到的来源：事件账本 / 已批准定义 / 章节索引 / 图映射 / 源清单核验 */
  examined_sources: ExaminedSource[];
  /** 声明存在但未读到/定位不到（逐条点名，不得静默） */
  unexamined_sources: UnexaminedSource[];
  registered_requirement_count: number;
  /** 被正式声明功能映射到的已登记需求数（**全局口径**，不受 scope 过滤影响） */
  mapped_count: number;
  /**
   * 已登记且**尚无正式功能映射**的需求里，`status` 为 `explicit`/`inferred` 的那些条数
   * （= 正式待映射，**阻断交付**）。不把 `unconfirmed` 混进来——它走 `registered_candidate_count`。
   */
  pending_count: number;
  /**
   * 已登记但 `status=unconfirmed` 且未被正式声明映射的需求数（**已登记待确认候选**，单列、
   * **不阻断**交付）。缺此字段的旧服务 ⇒ 未知（不可当作 0）。
   */
  registered_candidate_count?: number;
  /**
   * 正式需求分母 = `mapped_count` + `pending_count`（不含已登记候选与未登记候选）。
   * 缺此字段的旧服务 ⇒ 未知（不可当作 0）。守恒：`mapped + pending + registered_candidate = registered`。
   */
  formal_requirement_count?: number;
  /** 未登记候选（用户补充，第三类来源）的条数——**不混进** `pending_count`，否则分母口径会歪 */
  unregistered_candidate_count: number;
  /**
   * 只有全部必需来源读到 ∧ registered>0 ∧ `mapped+pending+registered_candidate=registered` 才 true；
   * **空需求不得 complete**。
   */
  source_complete: boolean;
}

export interface LedgerPaging {
  /** 只表示**本次请求范围**的分页已结束，不表示来源读齐（看 coverage.source_complete） */
  complete: boolean;
  cursor: string | null;
}

export interface FeatureLedgerSourceRevision {
  design: string | null;
  plan: string | null;
  ledger_last_seq: number;
}

/**
 * 产物选择的**解析结果**（§6.12／§2.9）：把引用落到"哪一版（`bound_revision`）、由哪些证据记录支撑"。
 *
 * 之所以必须有这一层：只回显字符串（或只核"名字在证据/产物名里出现过 + hash"）**不是选产物**——
 * 它既不能证明这个产物被验在**哪一版**，也无法区分两个不同绑定的产物。
 */
export interface ArtifactBinding {
  /** 请求里的引用原值 */
  requested: string;
  /** 解析到的**唯一**绑定修订（拿不到唯一绑定 = null ⇒ 本读口不给这个产物背书） */
  bound_revision: string | null;
  revision_kind: RevisionKind | null;
  /** 支撑该绑定的账本记录（事件实体 id / record_ref）；空 = 没有直接证据记录 */
  evidence_records: string[];
  /** 解析到多个不同绑定时，逐条点名歧义来源（人话） */
  candidates: string[];
  /** 歧义/不可绑定的原因（人话；解析成功 = null） */
  unresolved: string | null;
}

/** 本次请求实际读到的是哪一份文档（§2.9「不许混版」；不是只 echo 请求参数） */
export interface FeatureLedgerDocumentSelection {
  /** 请求里的 `document` 原值（缺省 = `active`） */
  requested: string;
  /** 实际读到的来源：`current`（现行编辑源）/ `active`（已批准基线快照）/ `revision`（不可变历史快照） */
  mode: "current" | "active" | "revision";
  /** 实际读到的设计修订（内容哈希）；读不到 = null */
  design_revision: string | null;
  /** 实际读到的施工图修订（内容哈希）；读不到 = null */
  plan_revision: string | null;
  /** 实际读到的施工图**定义哈希**；读不到 = null */
  plan_definition: string | null;
  /** 生效基线 id；没有基线 = null */
  baseline_id: string | null;
  /**
   * 现行源相对所选版本是否**已漂移**的人话说明（null = 没漂移 / 不适用）。
   * 例：`document=active` 时现行 DESIGN 已改 ⇒ 这里点名，读口仍读**已批准快照**，不假装现行=基线。
   */
  drift: string | null;
}

export interface FeatureLedger {
  state: "ok" | "not_derived";
  scope_id: string | null;
  scope_revision: string;
  package_revision: string;  /**
   * `package_revision` 实际绑定了哪些事实读数（可核对的来源清单，逐条点名）。
   * 换任一项 ⇒ 换包版本、旧游标与 `expected_revision` 失效（§2.9）；
   * 只含**派生实际依赖的有限来源**（设计/施工图定义/账本末序号/本范围所验行为的源读数/产物选择），
   * 无关文件变动不连坐。
   */
  package_revision_basis: string[];
  /** 本次实际读到的文档版本（不许混版；见 `FeatureLedgerDocumentSelection`） */
  document_selection: FeatureLedgerDocumentSelection;
  /** 本次请求选定的「已登记产物引用」（可选；DESIGN.md §6.12／§2.9「同一份产物选择」）——进包版本身份，不改判据 */
  artifact_ref: string | null;
  /**
   * `artifact_ref` 的**实际解析结果**：该产物绑定到哪一版来源、由哪些证据记录支撑。
   * **不是 echo 请求参数**：未唯一绑定 ⇒ `bound_revision: null` + `unresolved` 点名原因，
   * 此时本读口**不借当前所有检查/验收**给这个产物背书（§6.12）。
   */
  artifact_selection: ArtifactBinding | null;
  generated_at: string;
  source_revision: FeatureLedgerSourceRevision;
  coverage: LedgerCoverage;
  items: FeatureItem[];
  paging: LedgerPaging;
  /**
   * 交付总览（§3.16）：同源只读结论，全范围先在服务端算好再分页。
   * 旧服务缺这个字段 ⇒ 未知（不回退假成功）。
   */
  delivery?: DeliveryOverview;
  /** state=not_derived 时必带：缺什么 + 补取入口 */
  reason?: string;
  next_read?: string;
}

// ── 工作包（B3/V09-53 的形态落点；B2 只定义类型，不实现投影） ──

export type CheckEffective = "passed" | "failed" | "missing" | "stale" | "unknown" | "not_checked" | "not_applicable";

export interface NextOperation {
  tool: string;
  operation: string;
  known_args: Record<string, unknown>;
  missing_args: string[];
  /**
   * 只读**前置步骤**（有序、可执行）：办这一步之前要先做什么。典型如代码检查先
   * `record_work_evidence(op=store, kind=source_manifest)` 落覆盖源清单、取回指纹与证据哈希再回填。
   * **不是工具参数**——不得并入 `known_args` 发送（`known_args` 只收该 op 真实认识的键）。
   */
  prerequisites?: string[];
  /**
   * 只读**判据/条件说明**：分档与条件组的含义（如"机械检查才要 `command`+`exit_code`、非机械走
   * `method`/证据第二档"）、读侧为什么记 `unknown`、独审五维覆盖与读序的含义。
   * **不替调用方下验证结论**，也不进工具参数。
   */
  guidance?: string[];
}

export interface WorkPackageCheck {
  check_id: string;
  definition_fingerprint: string;
  requirement: string;
  required: boolean;
  independence_required: boolean;
  effective: CheckEffective;
  evidence_refs: string[];
  verified_binding: string | null;
  changed_paths: string[];
  uncovered: string[];
  responsible_role: string;
  next_operation: NextOperation;
}

export interface WorkPackage {
  scope_id: string | null;
  scope_revision: string;
  package_revision: string;
  baseline: { design_revision: string; plan_revision: string; baseline_id: string | null };
  task_id: string;
  task_revision: string;
  ownership: { owner_id: string; run_id: string; attempt_id: string; lease_expires_at: string; workspace: string };
  source_mode: "direct_tatai" | "coordinator_managed";
  status: DisplayStatus | null;
  checks: WorkPackageCheck[];
  completion: { satisfied: boolean; remaining_checks: string[]; blocking_findings: string[] };
  continuation: { action_id: string; role: string; operation: string; reason: string; prerequisite: string };
  paging: LedgerPaging;
}
