// 状态投影（PLAN.md V06-09，DESIGN.md §4.2 为主契约，另见 §5.4 / §5.6 / §5.8）。
//
// **状态纯由任务/证据及其有效性计算**（§4.2 开头）：本模块不读人写的颜色，也不接受"人工涂色"输入；
// `display_status` 严格按 §4.2 的六态与优先级选主状态，颜色只是果。
//
// §4.2 六态与优先级落在 `mainDisplayStatus`：
//   优先级 未知有效性 → 明确问题/阻塞 → 进行中 → 待验证 → 全部通过 → 未开始
//   （`DISPLAY_STATUS_PRIORITY` 逐字对应，函数里按同一顺序 return，改一处必须同时改另一处）
//
// 父级/连线/未映射规则落在：
//   · `collectRequiredChecks` —— 父级全部通过要求**所有必需子项 + 自身集成检查**通过；
//   · `projectEdge`          —— 依赖线只看前置交付是否释放；集成线必须有**自己的**关系/集成证据
//                              （两个端点绿不自动证明连线绿）；纯静态引用线不着完成色（`display_status: null`）；
//   · `mappingOf`            —— 没有任务/没有验收映射 → `unmapped`，**不空集判绿**（`required_count === 0`
//                              永远进不了 `verified`）。
//
// 证据版本复核（§5.6）落在 `checkEffectiveness`：绑定修订 ≠ 当前修订 → 该项"旧绿转待验证"，
// 且旧结论进 `history` 保留；**影响不确定**（`impact unknown`）时整对象进 `unknown`，不默认通过。
// 源变了只重验影响范围：由 `impactScope` 圈出的 `affected` 才失活，其余对象保持原状态。
//
// **补修包 C（2026-09-20，本卡主责，V06-06 联验）**：父级"自身集成检查通过"这条门槛保留不变，
// 补齐的只是它的**正式持久化链路**：
//   · "需要哪些集成检查"= 施工图里的版本化验收定义（`plan.parseIntegrationRequirements`），
//     绑定对象稳定 ID，随施工图修订进入不可变修订、随有效基线生效（`integrationRequirementsFromPlan`
//     + `withIntegrationRequirementsInForce`）；
//   · 检查结果**复用既有审计/证据事件**（`checksFromAudit`：自检 / 独立审计），不另造存储；
//   · 读路径从**权威事实装配**（`objectsFromFacts` 只认图纸定义或显式覆盖，HTTP 读口与前端不传覆盖），
//     GET 参数与前端声明产生不了绿灯；
//   · 每条已记录必需项的依据随投影带出（`evidence_basis`）：哪条记录 / 哪版定义 / 哪个证据哈希。
// 风险升级落在 `escalateRisk`：按后果、波及面、可逆性、陌生程度与证据缺口判（不看行数/模型品牌）。
// 人工验收只能由真实用户身份给（`assertUserAcceptance`）；agent/技术审定代签一律拒。
//
// **不用节点数算虚假完成百分比**：输出只有 required/passed/missing 计数与缺口清单，
// 没有任何百分比字段（`NO_COMPLETION_PERCENT` 是这条口径的单一出处）。
import fs from "node:fs";
import path from "node:path";
import { WorkError } from "./types";
import {
  readFindings,
  evidenceBlobPath,
  type EvidenceBinding,
  type FindingSeverity,
  type FindingState,
  type RevisionKind,
  findingIsOpen,
} from "./evidence";
import {
  auditEntityId,
  foldAuditRecords,
  gateClaimedPass,
  recordMethodOf,
  type AcceptanceRecord,
  type AuditRecords,
  type FixRecord,
  type IndependentAuditRecord,
  type VerificationSubject,
} from "./audit";
import { readTaskStates, type TaskExecutionStatus, type TaskState } from "./tasks";
import { readLedger } from "./ledgerRead";
import { latestByTime, parseIsoMs, compareIsoTime } from "../time";
import type { LedgerContentFingerprint, WorkEvent } from "./types";
import { projectWorkDir } from "../workstation";
import { tasksFileOf } from "./migrate";
import {
  loadDocuments,
  activeBaseline,
  buildSectionIndex,
  readRevisionSnapshotText,
  revisionSnapshotExists,
  planContentSnapshotIndex,
} from "./documents";
import { withDerivationScope } from "./derivationScope";
import { importTaskDefinitions, parseIntegrationRequirements, type TaskDefinition } from "./plan";
import { taskDefinitionHash } from "../../shared/planCardHash";
import { resolveDesignRef, type DesignSectionLike } from "../../shared/designRef";
import { resultSubmittedSources, type RuntimeEntrySource } from "./runtimeEntries";
import {
  projectRootOfWorkDir,
  readManifestCarrier,
  verifySourceManifest,
  type SourceManifestCarrier,
  type SourceManifestVerdict,
} from "./sourceEvidence";
import type { EvidenceFacts } from "../../ui/arch/provenance";

/**
 * 逐对象「明确阻塞」的缺陷判据（canonical `blockingProblem` 的缺陷项，**原位抽取、语义完全等价**）：
 * 未收口 ∧ 非用户接受风险 ∧（必须拦截 ∨ 未证实/风险未排除）。
 * 纯谓词、无副作用；交付总览的全局阻断缺陷**复用同一判据**，不另造更宽/更窄的口径（§3.16／§5.5）。
 */
export function findingBlocksObject(
  f: Pick<FindingState, "status" | "must_block" | "unverified">,
): boolean {
  return findingIsOpen(f) && f.status !== "accepted_risk" && (f.must_block || f.unverified);
}

// ── 六态与优先级（§4.2 表 + 其后一段的优先级口径） ──

export type DisplayStatus =
  | "planned"
  | "in_progress"
  | "pending_verification"
  | "verified"
  | "blocked"
  | "unknown";

/** 优先级顺序（§4.2 原文：未知有效性→明确问题/阻塞→进行中→待验证→全部通过→未开始） */
export const DISPLAY_STATUS_PRIORITY: readonly DisplayStatus[] = [
  "unknown",
  "blocked",
  "in_progress",
  "pending_verification",
  "verified",
  "planned",
];

export const DISPLAY_STATUS_LABELS: Readonly<Record<DisplayStatus, string>> = {
  planned: "灰：已规划，未开始",
  in_progress: "蓝：正在实现",
  pending_verification: "橙：结果待验证",
  verified: "绿：要求的验证已通过",
  blocked: "红：有已确认问题或明确阻塞",
  unknown: "中性虚线与文字：未知/陈旧",
};

/** §4.2：不用节点数计算整个项目的虚假完成百分比——本模块没有百分比输出 */
export const NO_COMPLETION_PERCENT =
  "只给 required/passed/missing 计数与缺口清单，不用节点数算虚假完成百分比（DESIGN.md §4.2）";

// ── 四维状态（§5.4 四个分开的状态维度；v1 四态只在兼容投影里出现） ──

export type ExecutionDimension =
  | "not_started"
  | "in_progress"
  | "result_submitted"
  | "blocked"
  | "cancelled";

/** v1 四态 → v2 执行状态的兼容读法（§5.4 映射；反向只有 `v1StatusOf` 一处，见 tasks.ts） */
export const V1_TO_EXECUTION: Readonly<Record<"todo" | "doing" | "done" | "blocked", ExecutionDimension>> = {
  todo: "not_started",
  doing: "in_progress",
  done: "result_submitted",
  blocked: "blocked",
};

export type QualityDimension =
  | "unverified"
  | "mechanical_passed"
  | "auditing"
  | "has_findings"
  | "audit_passed"
  | "evidence_invalid";

export type AcceptanceDimension = "pending" | "accepted" | "rejected" | "accepted_known_limit";

export type FreshnessDimension = "fresh" | "verification_stale" | "impact_unknown" | "unreadable";

export interface StatusReason {
  code: string;
  text: string;
}

export interface MissingCheck {
  check_id: string;
  label: string;
  why: string;
}

export interface SupersededEvidence {
  check_id: string;
  result: "passed";
  evidence_sha256: string | null;
  bound_revision: string;
  revision_kind: RevisionKind;
  at: string;
  /** 被谁取代（源修订变化 / 检查被重新执行） */
  superseded_by: string;
}

/**
 * 一条必需项的证据依据（补修 C）：绿灯要能说清"来自哪条事件记录、哪版定义、哪个证据哈希"
 * （DESIGN.md §4.2 可解释性 + §3.2 结论可追溯）。**它是事实的摘录，不是新的事实源。**
 */
export interface EvidenceBasis {
  pending?: import("./auditCorrection").PendingHuman;
  correction_refs?: string[];
  check_id: string;
  label: string;
  /** 记录来自哪条事件实体（`check:<id>` / `audit:<id>`）；测试直接构造的检查为 null */
  record_ref: string | null;
  /** 记录里声明的结果（原始值，未复核） */
  result: "passed" | "failed" | "not_checked";
  /** 复核后的有效性（§5.6 ＋ 附录 E.3.2 分档：绑定不符/退出码矛盾 → stale/unknown） */
  effective: "passed" | "failed" | "stale" | "unknown" | "not_checked";
  /** 被测版本：这条记录绑定的源修订 */
  bound_revision: { revision_kind: RevisionKind; revision: string };
  /** 复核基准：该 kind 的当前源修订（拿不到 → null，按 unknown 处理） */
  current_revision: string | null;
  evidence_sha256: string | null;
  independence: "author_self" | "independent";
  actor_id: string;
  at: string;
  /** 记录里声明的覆盖范围（空 = 没有声明范围） */
  scope: string[];
  /**
   * V09-01（附录 E.3.2）：这条检查是怎么做的——声明的机械命令（null = 第二档：
   * 凭证据 ＋ 方法采信）与它的退出码（投影**保留**它，矛盾才在投影层看得见）。
   */
  command: string | null;
  exit_code: number | null;
  /** 方法说明：per-check `method`，缺省时回落到记录层 `coverage`/`method_limits` */
  method: string | null;
  /** 被验对象的真实来源类别声明（未声明 = null，不判绑定是否相符） */
  verifies: VerificationSubject | null;
  /** 独立性口径要公开的盲点（同会话降级 / 先读作者摘要 / 一记录一哈希；空 = 没有要公开的） */
  independence_notes: string[];
  /**
   * V09-29（契约 F4）：带源清单的检查的**现读复核结论**（没有清单 = null）。
   * 只放结论与计数，不放全量文件清单（清单本体在证据正文里，可经 `record_work_evidence read` 取回）。
   */
  source_manifest: {
    status: "valid" | "invalidated" | "unreadable";
    declared_count: number;
    changed: string[];
    missing: string[];
    unreadable: string[];
    reason: string;
  } | null;
}

export interface StatusProjection {
  /** 对象稳定 ID（跨修订不变；本模块不按名字认对象） */
  object_id: string;
  object_kind: ObjectKind;
  label: string;
  parent_id: string | null;
  execution: ExecutionDimension;
  quality: QualityDimension;
  acceptance: AcceptanceDimension;
  freshness: FreshnessDimension;
  /** 主状态；null = 该对象不着完成色（仅纯静态引用线） */
  display_status: DisplayStatus | null;
  display_status_label: string | null;
  /** 有没有任务/验收映射：`unmapped` = 显示未映射，不空集判绿 */
  mapping: "mapped" | "unmapped";
  reasons: StatusReason[];
  required_count: number;
  passed_count: number;
  missing_count: number;
  missing: MissingCheck[];
  /** 验证范围与未覆盖（绿要能说清"验了什么"） */
  scope: { verified_scope: string[]; uncovered: string[] };
  evidence_refs: string[];
  /** 影响该对象的缺陷（未收口/必须拦截的排前面） */
  open_findings: {
    finding_id: string;
    severity: FindingSeverity;
    status: FindingState["status"];
    must_block: boolean;
    unverified: boolean;
  }[];
  /** 源变了只重验影响范围：本对象要重验的理由（空 = 不受影响） */
  recheck_scope: string[];
  /**
   * 每条已记录必需项的证据依据（补修 C）：说清绿灯来自哪条记录 / 哪版定义 / 哪个证据哈希；
   * 转待验证或被取代的记录也留在这里（`effective: "stale"`），不因状态变化而消失。
   */
  evidence_basis: EvidenceBasis[];
  /** 旧结论保留（不因转待验证而消失） */
  history: SupersededEvidence[];
  /** 叠加标签：陈旧图/用户接受已知限制等，不伪造执行状态 */
  overlays: string[];
  /** 计算时的源修订（对象绑定的那份） */
  source_revision: string;
}

export type ObjectKind = "task" | "module" | "capability" | "edge";

// ── 输入（事实 → 投影；全部是"事件/定义里真有的东西"） ──

export interface SourceRevisions {
  design?: string | null;
  plan?: string | null;
  /**
   * V09-07（附录 E.8-7 口径统一）：当前 PLAN 的**定义哈希**（卡号/交付目标/依赖/完成证据，
   * 不含状态列/勾选位）。图新鲜度的施工图侧改比这个（`projectGraph.freshnessOf`），
   * 只改状态列不再误判「图已过期」。读不到施工图时为 null（缺省不比，不新增假阳性）。
   */
  plan_definition?: string | null;
  interface?: string | null;
  /**
   * **当前可核对**的代码版本（契约 F4）：只有调用方**显式**给 `opts.code_revision` 才有值；
   * 产品读口默认 `null`——账本里上次自报的 code 修订不能反过来当"当前代码版本"
   * （自报值见 `code_declared`，只作展示，不参与"源码是否变了"的复核）。
   */
  code?: string | null;
  /**
   * 账本里**最近一次自报**的代码版本（成果登记 binding 或结果回报 `result_revision`）。
   * **只作展示**（"执行者自报的版本"）；它不证明当前盘上源码是什么，故**不**参与有效性复核
   * （契约 F4：保留历史记录 ≠ 继续采信它是当前验证）。
   */
  code_declared?: string | null;
}

export interface RequirementInput {
  check_id: string;
  label: string;
  /** 缺省 = 必需（DafaultDeny：不明说的都算必需） */
  required?: boolean;
}

export interface CheckInput {
  human_gate?: import("./audit").AcceptanceRecord;
  pending?: import("./auditCorrection").PendingHuman;
  correction_refs?: string[];
  correction_seq?: number;
  check_id: string;
  object_id: string;
  result: "passed" | "failed" | "not_checked";
  actor_id: string;
  role: string;
  /** 记录时声明的独立性；投影会复核，作者自报一律降级（见 `effectiveIndependence`） */
  independence: "author_self" | "independent";
  binding: EvidenceBinding;
  evidence_sha256: string | null;
  at: string;
  /** 方法说明（per-check）；缺省/`null` = 记录层给（`record_method`） */
  method?: string | null;
  scope?: string[];
  /**
   * 这条记录来自哪条事件实体（如 `check:<id>` / `audit:<id>`）。
   * 补修 C：绿灯要能被追问到"依据来自哪条记录"，故把事实来源随投影带出（`evidence_basis`）。
   */
  record_ref?: string;
  /**
   * V09-01（附录 E.3.2 第一档）：声明的机械检查命令。有它 = 通过必须 `exit_code === 0`；
   * 没有它 = 走第二档（凭证据哈希 ＋ 方法说明采信，**不要求**退出码）。
   */
  command?: string | null;
  /** 机械检查的退出码（投影**保留它**——投影层看不见这条，矛盾就永远判不出来，G-02 根因②） */
  exit_code?: number | null;
  /**
   * 记录层方法/覆盖说明（附录 E.3.2 第二档）：per-check `method` 缺省时方法信息在这里
   * （独立审计的 `coverage`/`method_limits`）；两处都没有才算"没有方法说明"。
   */
  record_method?: string | null;
  /** 被验对象的真实来源类别声明（附录 E.3.3）；缺省/不合法 = 未声明，不判绑定是否相符 */
  verifies?: VerificationSubject | null;
  /**
   * 独立审计记录的独立性事实（附录 E.3.4）：盲点必须公开，同会话记录**不得**当交叉审计证据。
   * 作者自检记录与历史外的其他来源没有这一项。
   */
  audit_independence?: AuditIndependenceFacts | null;
  /**
   * 修复后独立复测闭环（显式解除）：本记录声明解除的**失败**独立审计 record_id 列表
   * （来自独立审计 payload 的 `resolves`；缺省/空 = 不声明解除，行为与旧口径一致）。
   * 生效条件见 `pickCheckRecords` 的 resolvedFailed 预计算（fail-closed）。
   */
  resolves?: string[];
  /** 本记录复测所依据的 `audit.fix_recorded` record_id 列表（来自 payload 的 `fix_refs`） */
  fix_refs?: string[];
  /** 本记录经显式复测闭环解除了哪些失败（record_id，供展示追溯；只是标注，不改历史） */
  resolution_note?: string[];
  /**
   * 已验证修复版本（由 `checksFromAudit` 依账本 `audit.fix_recorded` 事实核出）：
   * 仅当 `fix_refs` 全部指向存在、带证据、回归命令全 0、且修复者 ≠ 复测者的修复记录时为非空；
   * 否则 `null`（= 没有可采信的修复事实，不解除任何失败——不得自报"已验证"）。
   */
  fix_revision?: string | null;
  /**
   * 服务端提交序号（账本产出，payload 伪造不了）：显式解除要求「被解除失败 seq < 复测 seq」。
   * 只比可自报的 `occurred_at` 不算数（复测不能事后解除发生在它之后的失败）。
   */
  ledger_seq?: number;
  /**
   * 该独立审计记录**声明**的 findings（`audit.independent_audit_recorded` payload 的
   * `findings`；由 `checksFromAudit` 透传）。复测闭环按**记录级**保守口径配对：一条失败要被
   * 解除，它在记录里声明的**每一个** finding 都必须有引用修复覆盖，且失败 findings 必须非空
   * （历史没记 finding → 无法证明修的就是它 → 保留 failed，不猜）。
   */
  record_findings?: string[];
  /**
   * 已核验的修复事实（`checksFromAudit` 依账本 `audit.fix_recorded` 核出，非 caller 自报）：
   * pick 侧按 finding ∈ 被解除失败的 `record_findings`、`fix_revision === binding.revision`、
   * `失败.seq < fix.seq < 复测.seq` 严格配对；为空 = 没有可采信的修复事实 → 不解除任何失败。
   */
  verified_fixes?: VerifiedFixFact[] | null;
  /**
   * V09-29（契约 F4）：这条检查的**源清单现读复核结论**（由 `checksWithSourceManifests` 装配）。
   * 给了就按它判：清单覆盖范围没变 → passed；变了/删了 → stale；取不到内容 → unknown。
   * 没有这一项 = 这条检查没有可核对的源清单，走既有口径（不认识它的旧调用行为逐字不变）。
   */
  source_manifest?: SourceManifestVerdict | null;
}

/** 一条已核验的修复事实（record 级，由账本折叠 + `checksFromAudit` 核出） */
export interface VerifiedFixFact {
  /** `audit.fix_recorded` record_id */
  record_id: string;
  /** 修复所针对的 finding（须出现在被解除失败的 `record_findings` 里） */
  finding_id: string;
  /** 修复版本（须精确等于复测 `binding.revision`——同一命名空间，不得拿文档版本冒充代码） */
  fix_revision: string;
  /** 修复记录的服务端账本序号（须落在 失败.seq < fix.seq < 复测.seq 之间） */
  seq: number;
}

/** 独立审计记录的独立性事实（E.3.4：一个都不许含糊成"已独立复核"） */
export interface AuditIndependenceFacts {
  record_id: string;
  /** 审计者与被审作者是否同一会话（13 条历史记录声明 true） */
  same_session_as_author: boolean;
  /** 是否先看了作者摘要（227/227 历史记录声明 true；盲点必须带出，不等于整批失效） */
  read_author_summary_first: boolean;
  /** 多项检查共用一个证据哈希（"一记录一哈希"；如实标注，**不当**交叉审计证据） */
  one_hash_per_record: boolean;
}

export interface ExecutionInput {
  task_id: string;
  status: TaskExecutionStatus;
  actor_id: string;
  updated_at: string;
}

export interface EdgeInput {
  edge_kind: "dependency" | "integration" | "static_reference";
  from: string;
  to: string;
  /** 依赖线：前置释放结论（由 `dependencyRelease` 给出；不给 = 未释放） */
  prerequisite_released?: boolean;
  /** 依赖线：前置是否已交结果（已交而未达标 → 待验证；还没交 → 还没开始） */
  prerequisite_result_submitted?: boolean;
  /** 依赖线：释放判据的理由（如实带出） */
  prerequisite_reasons?: string[];
  /** 依赖线：释放时仍要带上的说明（如"前置带着用户已接受的已知限制"） */
  prerequisite_caveats?: string[];
}

export interface StatusObjectInput {
  object_id: string;
  object_kind: ObjectKind;
  label: string;
  parent_id?: string | null;
  /** 该对象自己的执行事实（父级则是必需子项的并集，见 `resolveObject`） */
  executions?: ExecutionInput[];
  /** 该对象的必需验收项（任务来自定义；父级由子项汇总） */
  required_checks?: RequirementInput[];
  /** 必需子项（父级/模块用） */
  children_ids?: string[];
  /**
   * 自身的集成检查（父级全绿的必要条件之一）。
   * 补修 C：**采纳哪些要求由事实决定**（版本化验收定义或显式覆盖），见 `integration_checks_source`。
   */
  integration_checks?: RequirementInput[];
  /**
   * 自身集成检查要求的来源（补修 C，可解释性 + 防"外部声明直接判绿"）：
   *   · `"plan"` = 从施工图的**版本化验收定义**（「集成检查要求」小节 + 有效基线）读来的；
   *   · `"override"` = **显式进程内覆盖**（测试夹具或调用方的显式覆盖；HTTP 读口与前端都传不了它）；
   *   · `"none"` = 没有集成检查要求（父级因此判不了绿，不空集判绿）。
   */
  integration_checks_source?: "plan" | "override" | "none";
  /** 该来源绑定的事实版本（plan = 施工图内容修订）；override/none 为 null */
  integration_checks_revision?: string | null;
  /**
   * 有声明但当前**不能据此判绿**的原因（如"声明未被有效基线批准" / "小节有结构问题"）。
   * 非空时：不把空集合判绿，并把这条原因原样作为缺口理由带出。
   */
  integration_checks_blocked_reason?: string | null;
  edge?: EdgeInput;
  finding_ids?: string[];
  /** 本对象绑定的源修订（复核基准） */
  revisions?: SourceRevisions;
  /** 人工验收结论（只接受用户身份的记录，见 `assertUserAcceptance`） */
  acceptance?: AcceptanceDimension;
  /** 显式声明"没有任务/验收映射"（缺省由 required_count 推） */
  unmapped?: boolean;
}

/** 源变化：只重验影响范围；`affected: "unknown"` = 影响待查（**不默认通过**，§5.6） */
export interface SourceChange {
  change_id: string;
  revision_kind: RevisionKind;
  from: string;
  to: string;
  affected: string[] | "unknown";
  reason?: string;
}

export interface StatusProjectionInput {
  objects: StatusObjectInput[];
  findings: readonly FindingState[];
  checks: readonly CheckInput[];
  /** 源变化清单（设计/接口/代码版本变化触发复核） */
  changes?: readonly SourceChange[];
  /** 全局源修订（对象没给自己的 revisions 时用它兜底） */
  source_revision?: SourceRevisions;
  /** 图版本对照（图落后 → 输出陈旧提示，不伪造执行状态） */
  graph_revision?: { graph: string; current: string } | null;
  /** 事实读不出来（服务离线/文件坏）→ 未知，不能默认通过 */
  facts_unreadable?: string | null;
  /**
   * 分段失效复核现场（2026-09-27）：给了就按**本对象**分段判 plan/design 证据是否 stale；
   * 不给（缺省）＝沿用现行整份比对（宁严不松）。由 `collectProjectFacts` 装配（`facts.binding_segments`）。
   */
  binding_segments?: BindingSegmentFacts | null;
}

export interface StatusProjectionSet {
  objects: StatusProjection[];
  by_id: Record<string, StatusProjection>;
  summary: {
    counts: Record<DisplayStatus, number>;
    unmapped: string[];
    blocking_findings: string[];
    /** 没有任何百分比字段（`NO_COMPLETION_PERCENT`） */
    basis: string;
  };
}

// ── 小工具 ──

const revisionOf = (revs: SourceRevisions | undefined, kind: RevisionKind): string | null => {
  if (revs === undefined) return null;
  const v = revs[kind];
  return typeof v === "string" && v !== "" ? v : null;
};

const EMPTY_REVISIONS: SourceRevisions = {};

/** 修订的短写法（进 reasons/missing 的人话；拿不到就如实写"未知"） */
const shortRev = (rev: string | null | undefined): string =>
  typeof rev === "string" && rev !== "" ? `${rev.slice(0, 12)}…` : "（未知）";

function objectBad(message: string, detail: Record<string, unknown> = {}): never {
  throw new WorkError("INVALID_COMMAND", message, detail);
}

// ── 分段失效复核（2026-09-27）：plan/design 证据只按**本对象**分段判 stale ──
//
// 背景：一轮只改一张卡，整份内容哈希必变，于是全图 plan_task 证据一起转待验证——噪声淹没真信号。
// 口径（读侧，**不改写入结构**：检查记录照旧绑整份内容哈希）：复核时
//   · plan 证据 → 按**本对象涉及的卡**比单卡定义哈希（`shared/planCardHash.ts`）；
//   · design 证据 → 按**本对象的设计引用章节**比节哈希（`shared/designRef.ts` 定位，documents 的章节索引建哈希）。
// 快照取 `*-revisions/<binding.revision>.md`（`documents.revisionObjectRel` 的落点）。
// **读不到快照 / 拿不到当前分段表 / 对象没有可分段的口径 → 一律回退现行整份比对**（宁严不松）。

/**
 * 分段复核需要的现场快照（**纯数据**，由 `collectProjectFacts` 一次性装配）。
 *
 * 为什么**预计算哈希表**而不是把原文塞进来：`bindingStale` 每条检查都要按本对象比一次，
 * 真项目里绑 plan 的检查上千条、`importTaskDefinitions(PLAN.md)` 单次约 17ms——
 * 在复核里现解析会拖垮投影（实测口径）。所以收集侧解析一次、复核侧只查表。
 */
export interface BindingSegmentFacts {
  /** 当前施工图：卡号 → 单卡定义哈希；读不到施工图 = null → 回退整份 */
  current_plan_cards: ReadonlyMap<string, string> | null;
  /** 当前设计书章节表（含 title/level，供按「设计依据」token 定位；含 sha256 供比对）；读不到 = null */
  current_design_sections: readonly DesignSectionRef[] | null;
  /** 键 `${revision_kind}:${binding.revision}` → 该修订的分段基准；没有快照就不放键 */
  snapshots: ReadonlyMap<string, BindingSnapshotSegments>;
  /** 卡号 → 该卡「设计依据」token（`TaskDefinition.design_refs`），kind=design 时按它定位章节 */
  design_refs_of: ReadonlyMap<string, readonly string[]>;
}

/** 一个不可变快照的分段基准（plan 给卡哈希表、design 给章节表；与 kind 对应） */
export interface BindingSnapshotSegments {
  cards?: ReadonlyMap<string, string>;
  sections?: readonly DesignSectionRef[];
}

/** 章节（定位用 title/level/path；比对用 sha256） */
export interface DesignSectionRef extends DesignSectionLike {
  sha256: string;
}

/** `bindingStale` 的上下文（纯数据） */
export interface BindingStaleContext {
  /** 当前源修订（`revisionOf(current, kind)`；null 由调用方先按 unknown 处理，不进本函数） */
  current_revision: string;
  /** 本对象 id（任务卡号 / 依赖边 `A->B` / `module:…`） */
  object_id: string;
  /** 分段复核现场快照；缺省/为 null → 回退整份比对 */
  segments?: BindingSegmentFacts | null;
}

export interface BindingStaleVerdict {
  stale: boolean;
  /** 走的是分段还是整份口径（人话理由里也注明） */
  mode: "segment" | "whole";
  /** 人话理由（通过且无需说明时为空串） */
  why: string;
}

/** 哈希短写法（进人话；拿不到就如实写"（无）"） */
const shortHash = (h: string | null | undefined): string =>
  typeof h === "string" && h !== "" ? `${h.slice(0, 8)}…` : "（无）";

/**
 * 本对象要按哪几张卡分段比对（**只认"卡号"与"依赖边 `A->B`"两种形态**）：
 *   · `A->B`（依赖线对象）→ A、B 两张卡；
 *   · 其余裸卡号 → 就这一张；
 *   · 其他对象（`module:…` 等）→ null = 没有分段口径，回退整份比对。
 */
function planCardIdsOfObject(objectId: string): string[] | null {
  if (objectId === "") return null;
  const edge = /^(.+?)->(.+)$/.exec(objectId);
  if (edge !== null) {
    const ids = [edge[1].trim(), edge[2].trim()].filter((x) => x !== "");
    return ids.length > 0 ? ids : null;
  }
  // 非任务对象（模块/能力）没有"本卡"概念——不按分段判，回退整份（不硬凑一张卡号出来）
  if (objectId.startsWith("module:") || objectId.startsWith("cap:")) return null;
  return [objectId];
}

/** 一份施工图原文 → 卡号 → 单卡定义哈希（解析不动就返回空表，交由调用方回退整份） */
export function planCardHashesOf(text: string): Map<string, string> {
  const out = new Map<string, string>();
  try {
    for (const d of importTaskDefinitions(text).definitions) out.set(d.task_id, taskDefinitionHash(d));
  } catch {
    // 解析不了（坏原文）→ 空表
  }
  return out;
}

/** 一份设计书原文 → 章节表（path/title/level/sha256；与蓝图侧 `buildSectionIndex` 同一份切段口径） */
export function designSectionsOf(text: string): DesignSectionRef[] {
  return buildSectionIndex(text).map((s) => ({ path: s.path, title: s.title, level: s.level, sha256: s.sha256 }));
}

/**
 * 一条检查在当前源修订下还算不算数——**分段口径优先，缺口径回退整份比对**。
 *
 * 判据（§5.6 复核路径，本函数只回答"绑定的源修订还有效吗"）：
 *   · 绑定即当前修订 → 有效（无需分段）；
 *   · plan：快照与当前两份都有卡哈希表 → 比本对象涉及的卡的单卡哈希；卡在一边不在另一边 → stale；
 *   · design：快照与当前两份都有章节表、且本对象有可定位的设计引用章节 → 比那些节的哈希；
 *   · 上述任一前提不满足（没有快照/没有当前表/对象无分段口径）→ **回退整份比对**（`binding.revision !== 当前`）。
 *
 * 纯函数：只吃传进来的哈希表与章节表，不读盘、不写盘、不现解析原文，验证脚本可直接钉住每条分支。
 */
export function bindingStale(binding: EvidenceBinding, ctx: BindingStaleContext): BindingStaleVerdict {
  const whole = (): BindingStaleVerdict => ({
    stale: binding.revision !== ctx.current_revision,
    mode: "whole",
    why:
      `绑的是 ${binding.revision_kind}:${binding.revision.slice(0, 12)}…，` +
      `当前是 ${ctx.current_revision.slice(0, 12)}…：源变了 → 旧绿转待验证（旧结论保留在历史里）`,
  });
  if (binding.revision === ctx.current_revision) return { stale: false, mode: "whole", why: "" };
  const seg = ctx.segments ?? null;
  if (seg === null) return whole();

  if (binding.revision_kind === "plan") {
    const nowCards = seg.current_plan_cards;
    const beforeCards = seg.snapshots.get(`plan:${binding.revision}`)?.cards ?? null;
    if (nowCards === null || beforeCards === null) return whole();
    const cardIds = planCardIdsOfObject(ctx.object_id);
    if (cardIds === null) return whole();
    // 涉及的卡在**两边一张都找不到**（对象名不是本图的卡号，如 `module:a->module:b` 这类非任务连线）
    // → 没有分段口径，回退整份比对（宁严不松；不靠"两边都查不到 = 没变"放行）
    if (cardIds.every((id) => !beforeCards.has(id) && !nowCards.has(id))) return whole();
    const changes: string[] = [];
    for (const id of cardIds) {
      const a = beforeCards.get(id) ?? null;
      const b = nowCards.get(id) ?? null;
      if (a === b) continue; // 含"两边都没有"（卡与对象无关，不算本对象的变动）
      changes.push(`${id}（快照 ${shortHash(a)} ≠ 当前 ${shortHash(b)}）`);
    }
    if (changes.length === 0) return { stale: false, mode: "segment", why: "" };
    return {
      stale: true,
      mode: "segment",
      why:
        `绑的 plan:${binding.revision.slice(0, 12)}…（快照）里本对象涉及卡的单卡哈希对不上：${changes.join("、")}` +
        " ——本对象涉及的卡变了 → 旧绿转待验证（旧结论保留在历史里）（分段口径：只按本对象的卡复核，不整份判）",
    };
  }

  if (binding.revision_kind === "design") {
    const nowSections = seg.current_design_sections;
    const beforeSections = seg.snapshots.get(`design:${binding.revision}`)?.sections ?? null;
    if (nowSections === null || beforeSections === null) return whole();
    const refs = seg.design_refs_of.get(ctx.object_id);
    if (refs === undefined || refs.length === 0) return whole();
    const afterSections = nowSections;
    const paths: string[] = [];  // 用**快照**的章节表定位（首现路径），再到两边各自取哈希比
    for (const token of refs) {
      const idx = resolveDesignRef(token, beforeSections);
      if (idx === -1) continue;
      const p = beforeSections[idx].path;
      if (!paths.includes(p)) paths.push(p);
    }
    if (paths.length === 0) return whole(); // 引用一条都定位不到 → 没有分段口径，回退（宁严不松）
    const changes: string[] = [];
    for (const p of paths) {
      const a = beforeSections.find((s) => s.path === p)?.sha256 ?? null;
      const b = afterSections.find((s) => s.path === p)?.sha256 ?? null;
      if (a === b) continue;
      changes.push(`${p}（快照 ${shortHash(a)} ≠ 当前 ${shortHash(b)}）`);
    }
    if (changes.length === 0) return { stale: false, mode: "segment", why: "" };
    return {
      stale: true,
      mode: "segment",
      why:
        `绑的 design:${binding.revision.slice(0, 12)}…（快照）里本对象引用章节的节哈希对不上：` +
        `${changes.join("、")} ——引用到的设计章节变了 → 旧绿转待验证（旧结论保留在历史里）（分段口径：只按本对象的设计引用章节复核）`,
    };
  }

  return whole();
}

// ── 证据有效性（§5.6：设计/接口/代码版本变化触发复核） ──

export interface CheckEffectiveness {
  check_id: string;
  effective: "passed" | "failed" | "stale" | "unknown" | "not_checked";
  /** 为什么（人话，直接进 reasons/missing） */
  why: string;
  /** 旧结论（转待验证时保留） */
  superseded: SupersededEvidence | null;
  effective_independence: "author_self" | "independent";
  evidence_sha256: string | null;
  /**
   * 独立性口径的如实说明（V09-01／附录 E.3.4）：同会话声明被降级、先读作者摘要的盲点、
   * 一记录一哈希——都在这里点名，不静默处理。为空 = 这条记录的独立性口径没有要公开的盲点。
   */
  independence_notes: string[];
}

/**
 * 一次检查在当前源修订下还算不算数。
 * 判据（§5.6 ＋ 附录 E.3.2 分档 ＋ E.3.3 绑定相符）：
 *   · 带 `command` 的矛盾（退出码非零/缺失）、声明了被验对象类别却绑错种类、
 *     证据与方法两缺的「通过」→ **fail-closed 不采信**（`unknown`，如实点名原因）；
 *   · 绑定修订 = 当前修订 → 有效；不等 → **旧绿转待验证并保留历史**；
 *   · 当前修订未知（拿不到）→ `unknown`（不默认通过）。
 * **不因缺 `exit_code`、也不因缺 per-check `method` 判不带 `command` 的检查失效**
 * （既有 227 条独立审计的方法信息在记录层，一条都不整批作废）。
 */
export function checkEffectiveness(
  check: CheckInput,
  current: SourceRevisions,
  authorIds: ReadonlySet<string>,
  segments: BindingSegmentFacts | null = null,
): CheckEffectiveness {
  const now = revisionOf(current, check.binding.revision_kind);
  const declaredIndependence: "author_self" | "independent" =
    check.actor_id !== "" && authorIds.has(check.actor_id) ? "author_self" : check.independence === "independent" ? "independent" : "author_self";
  // 独立性口径（E.3.4）：同会话声明的"独立"记录**不得**当交叉审计证据 → 如实降级并点名；
  // 「先读作者摘要」与「一记录一哈希」保留采信但把盲点带出（不整批废除）。
  const notes: string[] = [];
  let independence = declaredIndependence;
  const facts = check.audit_independence ?? null;
  if (independence === "independent" && facts !== null && facts.same_session_as_author) {
    independence = "author_self";
    notes.push(
      `记录 ${facts.record_id} 声明与作者**同一会话**（same_session_as_author=true）：按附录 E.3.4-3 如实降级标注，` +
        "不计入「非作者复核」——要么分离会话重做、要么按本条如实降级（不得当交叉审计证据，也不整批作废）",
    );
  }
  if (facts !== null && facts.read_author_summary_first) {
    notes.push(
      `记录 ${facts.record_id} 声明**先读了作者摘要**（read_author_summary_first=true）：该盲点如实带出，` +
        "不得含糊成「已独立复核」（附录 E.3.4-2；作者摘要只是导航，不代替证据）",
    );
  }
  if (facts !== null && facts.one_hash_per_record) {
    notes.push(
      `记录 ${facts.record_id} 的多项检查共用**一个**证据哈希（一记录一哈希）：如实标注，**不当**交叉审计证据` +
        "（附录 E.3.4-4；新写入按检查项分别落哈希）",
    );
  }
  const base = {
    check_id: check.check_id,
    effective_independence: independence,
    evidence_sha256: check.evidence_sha256,
    independence_notes: notes,
  };
  if (check.result === "not_checked") {
    return { ...base, effective: "not_checked", why: check.pending ? `尚未检查：${check.pending.reason}；责任 ${check.pending.role}；依据 ${check.pending.basis}` : "尚未检查：原记录没有合法的明确结果", superseded: null };
  }
  if (check.result === "passed") {
    // V09-01：写侧与读侧同一份分档判据（E.3.2 第一/二档 ＋ E.3.3 绑定相符）
    const verdict = gateClaimedPass({
      check_id: check.check_id,
      command: check.command ?? null,
      exit_code: check.exit_code ?? null,
      evidence_sha256: check.evidence_sha256,
      method: typeof check.method === "string" && check.method.trim() !== "" ? check.method : null,
      record_method:
        typeof check.record_method === "string" && check.record_method.trim() !== "" ? check.record_method : null,
      verifies: check.verifies ?? null,
      binding: { revision_kind: check.binding.revision_kind, revision: check.binding.revision },
    });
    if (!verdict.pass) {
      // 不采信：不计入 `passed`，按 §4.2 降级为「结果待验证」，原因如实点名
      return { ...base, effective: "unknown", why: verdict.why, superseded: null };
    }
  }
  if (check.result === "passed" && check.evidence_sha256 === null) {
    // 既有口径保留（E.3.2-2）：没有证据哈希的「通过」记 `unknown`，不默认通过。
    // 与写侧的差别是**有意的**：写侧只拒「证据与方法两缺」（E.3.2-1 的第二档），
    // 读侧照旧不放行没证据的通过——新写入的方法说明不等于证据。
    return {
      ...base,
      effective: "unknown",
      why: `检查「${check.check_id}」说通过但没给证据哈希：没证据的通过不算通过（结果已提交 ≠ 验证通过）`,
      superseded: null,
    };
  }
  // V09-29（契约 F4）：带源清单的证据**现读复核**——只看它声明的那些路径。
  // 这条**先于**"当前代码版本"判断：不再拿账本里上次自报的 code revision 反过来当当前代码版本；
  // 覆盖的源码变了/删了 → 失效（stale）；取不到内容 → 未知待复核（unknown）；一致 → 沿用结论。
  // **没被清单覆盖的无关文件变化不让它失效**（清单就是"有限覆盖范围"的本义）。
  if (check.result === "passed" && check.source_manifest != null) {
    const v = check.source_manifest;
    if (v.status === "valid") return { ...base, effective: "passed", why: "", superseded: null };
    if (v.status === "invalidated") {
      return {
        ...base,
        effective: "stale",
        why: `检查「${check.check_id}」${v.reason}`,
        superseded: {
          check_id: check.check_id,
          result: "passed",
          evidence_sha256: check.evidence_sha256,
          bound_revision: check.binding.revision,
          revision_kind: check.binding.revision_kind,
          at: check.at,
          superseded_by: `source_manifest:${v.current_fingerprint ?? "changed"}`,
        },
      };
    }
    return { ...base, effective: "unknown", why: `检查「${check.check_id}」${v.reason}`, superseded: null };
  }
  if (now === null) {
    // B3+B4 收口 D2（共享读模型层）：**失败结论不因「当前修订拿不到」被弱化成 unknown**——
    // 失败不随源漂移失效、独立失败永远压住作者通过（§5.6／附录 E.3.4）。这条分支本是为
    // 「通过不得默认通过」写的；`result === "failed"` 照旧算失败，不沿用「拿不到当前值 ⇒ unknown」。
    if (check.result === "failed") {
      return { ...base, effective: "failed", why: "", superseded: null };
    }
    return {
      ...base,
      effective: "unknown",
      why: `检查「${check.check_id}」绑定的 ${check.binding.revision_kind} 修订拿不到当前值，无法复核，不默认通过`,
      superseded: null,
    };
  }
  if (now !== check.binding.revision && check.result === "passed") {
    // 2026-09-27：先过**分段复核**（plan 按本对象卡、design 按本对象引用章节）——本对象没变就不转待验证；
    // 缺快照/缺当前原文/对象无分段口径时 `bindingStale` 回退整份比对（宁严不松）。
    const verdict = bindingStale(check.binding, {
      current_revision: now,
      object_id: check.object_id,
      segments,
    });
    if (!verdict.stale) return { ...base, effective: "passed", why: "", superseded: null };
    return {
      ...base,
      effective: "stale",
      why: `检查「${check.check_id}」${verdict.why}`,
      superseded: {
        check_id: check.check_id,
        result: "passed",
        evidence_sha256: check.evidence_sha256,
        bound_revision: check.binding.revision,
        revision_kind: check.binding.revision_kind,
        at: check.at,
        superseded_by: `${check.binding.revision_kind}:${now}`,
      },
    };
  }
  return { ...base, effective: check.result, why: "", superseded: null };
}

// ── 影响范围（源变了只重验影响范围） ──

export interface ImpactScope {
  /** 要重验的对象（只这些） */
  affected: string[];
  /** 确认不受影响的对象 */
  unaffected: string[];
  /** 影响待查的对象（不可默认通过） */
  unknown: string[];
}

export function impactScope(
  changes: readonly SourceChange[],
  objectIds: readonly string[],
): ImpactScope {
  const affected = new Set<string>();
  const unknown = new Set<string>();
  for (const change of changes) {
    if (change.affected === "unknown") {
      for (const id of objectIds) unknown.add(id);
      continue;
    }
    for (const id of change.affected) affected.add(id);
  }
  for (const id of unknown) affected.delete(id);
  return {
    affected: [...affected].sort(),
    unaffected: objectIds.filter((id) => !affected.has(id) && !unknown.has(id)).sort(),
    unknown: [...unknown].sort(),
  };
}

// ── 依赖释放（§5.8：不能只看前卡自报 done） ──

export interface DependencyReleaseInput {
  prerequisite_id: string;
  prerequisite: StatusProjection;
  /** 依赖卡的「完成证据」要求（依赖方按它判达标；null = 未特别声明） */
  evidence_requirement?: string | null;
  /** 依赖方要求的前置输入版本 */
  required_input_revision?: EvidenceBinding | null;
  /** 前置实际绑定的输入版本 */
  prerequisite_input_revision?: EvidenceBinding | null;
}

export interface DependencyRelease {
  prerequisite_id: string;
  released: boolean;
  /** true = 前置只是"自报交了结果"，必要验证/审计还没过 */
  self_reported_only: boolean;
  reasons: string[];
  /** 不阻塞但要让依赖方知道的（如"前置的通过项全来自作者自检"） */
  caveats: string[];
}

export function dependencyRelease(input: DependencyReleaseInput): DependencyRelease {
  const reasons: string[] = [];
  const caveats: string[] = [];
  const p = input.prerequisite;
  if (p.execution === "cancelled") {
    reasons.push("前置已取消：不释放依赖");
  }
  if (p.display_status === "blocked" || p.open_findings.some((f) => f.must_block && f.status !== "accepted_risk")) {
    reasons.push("前置仍有必须拦截的问题未收口");
  }
  if (p.freshness === "impact_unknown" || p.freshness === "unreadable") {
    reasons.push("前置的证据有效性待查（影响未查清），不释放依赖");
  }
  if (p.quality === "evidence_invalid") {
    reasons.push("前置证据版本已失效（源变了），要先重验");
  }
  const verified = p.mapping === "mapped" && p.required_count > 0 && p.passed_count === p.required_count && p.missing_count === 0;
  if (!verified) {
    reasons.push(
      `前置的必需验收没全过（${p.passed_count}/${p.required_count}）` +
        (input.evidence_requirement != null ? `；依赖方给的要求：「${input.evidence_requirement}」` : "")
    );
  }
  if (
    input.required_input_revision != null &&
    input.prerequisite_input_revision != null &&
    (input.required_input_revision.revision_kind !== input.prerequisite_input_revision.revision_kind ||
      input.required_input_revision.revision !== input.prerequisite_input_revision.revision)
  ) {
    reasons.push(
      `前置的输入版本不是依赖方要的那份（要 ${input.required_input_revision.revision_kind}:` +
        `${input.required_input_revision.revision.slice(0, 12)}…，实际 ${input.prerequisite_input_revision.revision_kind}:` +
        `${input.prerequisite_input_revision.revision.slice(0, 12)}…）`,
    );
  }
  const selfReportedOnly = p.execution === "result_submitted" && !verified;
  if (selfReportedOnly) {
    reasons.push("前置只自报交了结果（done ≠ 验证/审计通过，DESIGN.md §5.8）");
  }
  if (verified && p.quality === "mechanical_passed") {
    caveats.push("前置的通过项全部来自作者自检（无独立审计记录）：依赖方按自身定义判断够不够（DESIGN.md §5.5）");
  }
  if (p.acceptance === "accepted_known_limit" || p.open_findings.some((f) => f.status === "accepted_risk")) {
    caveats.push("前置带着用户已接受的已知限制（独立标签，不算通过，也不是新的阻塞）");
  }
  return {
    prerequisite_id: input.prerequisite_id,
    released: reasons.length === 0,
    self_reported_only: selfReportedOnly,
    reasons,
    caveats,
  };
}

// ── 风险升级（§5.5：按后果/波及面/可逆性/陌生程度/证据缺口判，不看行数或模型品牌） ──

export const RISK_BASIS =
  "按后果、波及面、可逆性、陌生程度与证据缺口判断；不按改动行数或模型品牌（DESIGN.md §5.5）";

export type ChangeNature =
  | "critical_interface"
  | "data_migration"
  | "permission_boundary"
  | "wide_dependency"
  | "ordinary";

export interface RiskInput {
  findings: readonly Pick<FindingState, "finding_id" | "severity" | "status" | "must_block" | "unverified">[];
  /** 证据缺口（未证实项、覆盖矩阵里的未查项） */
  evidence_gaps?: readonly string[];
  change_natures?: readonly ChangeNature[];
  blast_radius_modules?: number;
  reversible?: boolean;
  unfamiliar?: boolean;
  /** 已经用掉的高能力调用次数（实测；未知给 null，不编数字） */
  high_capability_calls?: number | null;
}

export interface RiskAssessment {
  level: "normal" | "elevated" | "high";
  must_block: boolean;
  require_independent_audit: boolean;
  require_high_capability_review: boolean;
  reasons: StatusReason[];
  basis: string;
}

export function escalateRisk(input: RiskInput): RiskAssessment {
  const open = input.findings.filter(
    (f) => f.status !== "closed" && f.status !== "false_positive" && f.status !== "duplicate",
  );
  const mustBlock = open.filter((f) => f.must_block);
  const unverified = open.filter((f) => f.unverified);
  const natures = input.change_natures ?? [];
  const criticalNatures = natures.filter((n) => n !== "ordinary");
  const reasons: StatusReason[] = [];
  for (const f of mustBlock) {
    reasons.push({
      code: "must_block_finding",
      text: `${f.finding_id}：${f.severity} 属必须拦截的后果，不能按"小改"处理`,
    });
  }
  for (const f of unverified) {
    reasons.push({
      code: "unverified_risk",
      text: `${f.finding_id}：没有复现条件——风险未排除，不能当作已证实 bug 之外的"没事"`,
    });
  }
  for (const n of criticalNatures) {
    reasons.push({
      code: `critical_change:${n}`,
      text:
        n === "critical_interface"
          ? "关键接口基线变更：按 §5.5 建议高能力检查节点"
          : n === "data_migration"
            ? "数据迁移/不可逆操作：按 §5.5 建议高能力检查节点"
            : n === "permission_boundary"
              ? "核心权限边界：按 §5.5 建议高能力检查节点"
              : "大范围依赖变更：按 §5.5 建议高能力检查节点",
    });
  }
  if ((input.evidence_gaps ?? []).length > 0) {
    reasons.push({
      code: "evidence_gap",
      text: `证据缺口 ${input.evidence_gaps!.length} 项：${input.evidence_gaps!.slice(0, 5).join("；")}`,
    });
  }
  if ((input.blast_radius_modules ?? 0) > 1) {
    reasons.push({ code: "blast_radius", text: `波及 ${input.blast_radius_modules} 个模块，超出单模块范围` });
  }
  if (input.reversible === false) {
    reasons.push({ code: "irreversible", text: "动作不可逆：抽查与复测要更严" });
  }
  if (input.unfamiliar === true) {
    reasons.push({ code: "unfamiliar", text: "陌生领域/首次做法：风险按高能力节点处理" });
  }
  const high =
    mustBlock.length > 0 ||
    criticalNatures.length > 0 ||
    (input.reversible === false && (input.evidence_gaps ?? []).length > 0);
  const elevated = high || unverified.length > 0 || (input.evidence_gaps ?? []).length > 0 ||
    (input.blast_radius_modules ?? 0) > 1 || input.unfamiliar === true;
  return {
    level: high ? "high" : elevated ? "elevated" : "normal",
    must_block: mustBlock.length > 0,
    require_independent_audit: elevated,
    require_high_capability_review: high,
    reasons,
    basis: RISK_BASIS,
  };
}

// ── 人工验收身份（§5.8：不得由质量状态自动代写，agent/技术审定不得代签） ──

export function assertUserAcceptance(record: Pick<AcceptanceRecord, "role" | "accepted_by" | "record_id">): void {
  if (record.role !== "user") {
    objectBad(
      `人工验收记录 ${record.record_id} 的 role 是 ${record.role}：人工接受只能由真实用户身份给，` +
        "Agent 与技术审定不得代签（DESIGN.md §5.8）",
      { record_id: record.record_id, role: record.role },
    );
  }
}

/** 从人工验收记录推验收维度（**没有用户记录就是 pending**，不接受"质量状态自动代写"） */
export function acceptanceDimensionOf(
  records: readonly AcceptanceRecord[],
  opts: { task_id?: string | null; change_id?: string | null } = {},
): AcceptanceDimension {
  const relevant = records.filter((r) => {
    assertUserAcceptance(r);
    if (opts.task_id != null && r.task_id !== null && r.task_id !== opts.task_id) return false;
    return true;
  });
  if (relevant.length === 0) return "pending";
  // 验收记录的 `at` 来自 `occurred_at`（调用方给的时间，偏移任意）：按**真实时刻**取最新，
  // 不能比字面钟点。全部时间都解析不出来 → 无法判定"最新一次验收"，按 fail-closed 留在 pending
  // （不拿一条时间非法的记录去判"已接受"）。
  const latest = latestByTime(relevant, (r) => r.at);
  if (latest === null) return "pending";
  if (latest.decision === "accept") return "accepted";
  if (latest.decision === "reject") return "rejected";
  return "accepted_known_limit";
}

// ── 投影主流程 ──

interface ResolvedObject {
  input: StatusObjectInput;
  /** 全部必需验收项（父级 = 子项必需项 + 自身集成检查） */
  requirements: RequirementInput[];
  /** 自己的集成检查（父级"还必须自己集成检查通过"的判据） */
  integrationRequirements: RequirementInput[];
  /** 作者集合（自检/作者自报不能被读成独立审计） */
  authorIds: Set<string>;
  executions: ExecutionInput[];
  /** 本对象 + 所有必需子项关联的缺陷（父级不因为"缺陷挂在子任务上"就看不见它） */
  findingIds: Set<string>;
}

function resolveObject(
  input: StatusObjectInput,
  byId: Map<string, StatusObjectInput>,
  stack: string[] = [],
): ResolvedObject {
  if (stack.includes(input.object_id)) {
    objectBad(`父级/子项关系成环：${[...stack, input.object_id].join(" → ")}`, {
      object_id: input.object_id,
    });
  }
  const children = (input.children_ids ?? []).map((id) => {
    const child = byId.get(id);
    if (child === undefined) {
      objectBad(`对象 ${input.object_id} 的必需子项 ${id} 不在对象表里（缺映射就是缺映射，不猜）`, {
        object_id: input.object_id,
        child_id: id,
      });
    }
    return resolveObject(child, byId, [...stack, input.object_id]);
  });
  const own = (input.required_checks ?? []).map((c) => ({ ...c, required: c.required ?? true }));
  const integration = (input.integration_checks ?? []).map((c) => ({
    ...c,
    required: c.required ?? true,
  }));
  const childRequirements = children.flatMap((c) => c.requirements);
  const executions = [...(input.executions ?? []), ...children.flatMap((c) => c.executions)];
  const authorIds = new Set<string>([
    ...executions.map((e) => e.actor_id),
    ...children.flatMap((c) => [...c.authorIds]),
  ]);
  const findingIds = new Set<string>([...(input.finding_ids ?? []), ...children.flatMap((c) => [...c.findingIds])]);
  return {
    input,
    // 父级的"全部通过"= 所有必需子项 + 自身集成检查（§4.2）
    requirements: [...own, ...childRequirements, ...integration],
    integrationRequirements: integration,
    authorIds,
    executions,
    findingIds,
  };
}

function executionDimension(executions: readonly ExecutionInput[]): ExecutionDimension {
  if (executions.length === 0) return "not_started";
  const live = executions.filter((e) => e.status !== "cancelled");
  if (live.length === 0) return "cancelled";
  if (live.some((e) => e.status === "blocked")) return "blocked";
  if (live.some((e) => e.status === "claimed" || e.status === "executing")) return "in_progress";
  if (live.every((e) => e.status === "result_submitted")) return "result_submitted";
  return "not_started";
}

/** 主状态选取：§4.2 的六态与优先级（顺序 = `DISPLAY_STATUS_PRIORITY`） */
export function mainDisplayStatus(facts: {
  no_color: boolean;
  unreadable: boolean;
  impact_unknown: boolean;
  graph_stale: boolean;
  has_blocking_problem: boolean;
  execution: ExecutionDimension;
  missing_count: number;
  evidence_stale: boolean;
  required_count: number;
  passed_count: number;
}): DisplayStatus | null {
  if (facts.no_color) return null;
  if (facts.unreadable || facts.impact_unknown || facts.graph_stale) return "unknown";
  if (facts.has_blocking_problem) return "blocked";
  if (facts.execution === "in_progress") return "in_progress";
  // 橙 = "已交成果，必需检查/审计还不齐或待复核"（§4.2）：没交结果就还停在灰（已规划，未开始）
  if (facts.evidence_stale || (facts.missing_count > 0 && facts.execution === "result_submitted")) {
    return "pending_verification";
  }
  // 绿要求"必需项全过"且缺口为空（父级还可能有"自身集成检查"这类合成缺口，光比 passed/required 会漏）
  if (facts.required_count > 0 && facts.passed_count === facts.required_count && facts.missing_count === 0) {
    return "verified";
  }
  return "planned";
}

function mappingOf(resolved: ResolvedObject): "mapped" | "unmapped" {
  if (resolved.input.unmapped === true) return "unmapped";
  if (resolved.requirements.length === 0) return "unmapped";
  // 连执行记录都没有、也没有验收项的对象（例如只有图纸的模块）就是"未映射"：
  // 不空集判绿——`required_count === 0` 永远进不了 verified。
  return "mapped";
}

function projectOne(
  resolved: ResolvedObject,
  input: StatusProjectionInput,
  findingsById: Map<string, FindingState>,
  checksByObject: Map<string, CheckInput[]>,
  impact: ImpactScope,
): StatusProjection {
  const obj = resolved.input;
  const revisions = obj.revisions ?? input.source_revision ?? EMPTY_REVISIONS;
  const checks = checksByObject.get(obj.object_id) ?? [];
  // 父级也要看到子项检查（"所有必需子项通过"）——检查按 object_id 归属，子项检查在各自对象上，
  // 这里把子项检查并进来，父级的必需项才能被判过。
  const childChecks = (obj.children_ids ?? []).flatMap((id) => checksByObject.get(id) ?? []);
  const ownAndChildChecks = [...checks, ...childChecks];
  const authorIds = resolved.authorIds;
  const segments = input.binding_segments ?? null;
  const byCheckId = pickCheckRecords(ownAndChildChecks, authorIds, revisions, segments);

  const history: SupersededEvidence[] = [];
  const evidenceBasis: EvidenceBasis[] = [];
  const missing: MissingCheck[] = [];
  const verifiedScope: string[] = [];
  const uncovered: string[] = [];
  const evidenceRefs = new Set<string>();
  const reasons: StatusReason[] = [];
  const overlays: string[] = [];
  let passed = 0;
  let staleCount = 0;
  let independentPasses = 0;
  let selfPasses = 0;

  // 依赖线不查"检查记录"，它只看**前置交付是否满足**（§4.2：不代表数据链路已联通）。
  // 它的"证据"是前置自己的证据引用，不是一条检查哈希——这一点显式写清，不当成"没证据的通过"。
  const isDependencyEdge = obj.edge?.edge_kind === "dependency";
  const hasChildren = (obj.children_ids ?? []).length > 0;
  // 父级（模块/能力）必须是"所有必需子项 + 自身集成检查"都过才算过：没有任何自身集成检查记录
  // 就等于"没有集成证据"，不算集成通过（§4.2）。
  //
  // 补修 C：如果有声明（施工图的版本化验收定义 / 显式覆盖）但当前**不能据此判绿**，
  // 用事实里给的原话作缺口理由（不把"读不到要求"说成"没有要求"）；没有任何声明时才用默认话术。
  if (!isDependencyEdge && hasChildren && resolved.integrationRequirements.length === 0) {
    missing.push({
      check_id: `${obj.object_id}::integration`,
      label: "自身集成检查",
      why:
        obj.integration_checks_blocked_reason ??
        "父级没有任何自身集成检查记录：子项全绿不等于集成通过，没有集成证据就不算集成通过（DESIGN.md §4.2）",
    });
  }
  // 集成检查要求的**来源可解释性**：绿灯的依据要能追到哪版定义 / 是不是显式覆盖
  if (hasChildren && !isDependencyEdge) {
    if (obj.integration_checks_source === "plan") {
      reasons.push({
        code: "integration_requirements_definition",
        text:
          `自身集成检查要求来自施工图的版本化验收定义（plan 修订 ${shortRev(obj.integration_checks_revision)}，` +
          "随有效基线生效）：不是调用方临时声明，也不能由 GET 参数或前端声明产生（补修 C）",
      });
    } else if (obj.integration_checks_source === "override") {
      reasons.push({
        code: "integration_requirements_override",
        text:
          "自身集成检查要求来自**显式进程内覆盖**（测试夹具或调用方的显式覆盖）：本进程外的调用方" +
          "（HTTP 读口 / 前端）注入不了这类要求，故外部声明产生不了绿灯（补修 C）",
      });
    }
  }

  for (const req of resolved.requirements) {
    if (req.required === false) continue;
    if (isDependencyEdge && req.check_id === `${obj.object_id}::prerequisite`) {
      if (obj.edge?.prerequisite_released === true) {
        passed++;
        verifiedScope.push(`${req.label}（前置交付已释放）`);
        for (const caveat of obj.edge?.prerequisite_caveats ?? []) {
          reasons.push({ code: "prerequisite_caveat", text: `前置说明：${caveat}` });
        }
      } else {
        missing.push({
          check_id: req.check_id,
          label: req.label,
          why: `前置未释放：${(obj.edge?.prerequisite_reasons ?? ["未给释放判据"]).join("；")}`,
        });
      }
      continue;
    }
    const check = byCheckId.get(req.check_id);
    if (check === undefined) {
      missing.push({
        check_id: req.check_id,
        label: req.label,
        why: "没有任何检查记录：结果提交不等于验证通过（缺哪项说哪项）",
      });
      continue;
    }
    const eff = checkEffectiveness(check, revisions, authorIds, segments);
    if (eff.superseded !== null) history.push(eff.superseded);
    // 证据依据（补修 C）：不管复核结论是 passed/failed/stale/unknown 都留下来源，
    // 这样"绿灯的依据来自哪条事件 / 哪版定义 / 哪个证据哈希"能直接从投影问出来。
    evidenceBasis.push({
      check_id: req.check_id,
      label: req.label,
      record_ref: check.record_ref ?? null,
      result: check.result,
      ...(check.pending ? { pending: check.pending } : {}),
      ...(check.correction_refs?.length ? { correction_refs: check.correction_refs } : {}),
      effective: eff.effective,
      bound_revision: { revision_kind: check.binding.revision_kind, revision: check.binding.revision },
      current_revision: revisionOf(revisions, check.binding.revision_kind),
      evidence_sha256: check.evidence_sha256,
      independence: eff.effective_independence,
      actor_id: check.actor_id,
      at: check.at,
      scope: [...(check.scope ?? [])],
      command: check.command ?? null,
      exit_code: check.exit_code ?? null,
      method:
        typeof check.method === "string" && check.method.trim() !== ""
          ? check.method
          : check.record_method ?? null,
      verifies: check.verifies ?? null,
      independence_notes: eff.independence_notes,
      source_manifest:
        check.source_manifest == null
          ? null
          : {
              status: check.source_manifest.status,
              declared_count: check.source_manifest.declared_count,
              changed: [...check.source_manifest.changed],
              missing: [...check.source_manifest.missing],
              unreadable: [...check.source_manifest.unreadable],
              reason: check.source_manifest.reason,
            },
    });
    if (eff.effective === "passed") {
      passed++;
      if (eff.effective_independence === "independent") independentPasses++;
      else selfPasses++;
      if (eff.evidence_sha256 !== null) evidenceRefs.add(eff.evidence_sha256);
      verifiedScope.push(`${req.label}（${check.binding.revision_kind}:${check.binding.revision.slice(0, 12)}…）`);
    } else if (eff.effective === "failed") {
      missing.push({ check_id: req.check_id, label: req.label, why: "检查未通过（已确认失败，需修复后复测）" });
    } else if (eff.effective === "stale") {
      staleCount++;
      missing.push({ check_id: req.check_id, label: req.label, why: eff.why });
    } else {
      missing.push({ check_id: req.check_id, label: req.label, why: eff.why });
    }
    if (check.scope !== undefined && check.scope.length > 0) {
      uncovered.push(...check.scope.filter((s) => s.startsWith("未覆盖:")).map((s) => s.slice("未覆盖:".length)));
    }
  }

  // 没被任何必需项引用的检查也算"验过什么"（绿要能说清范围）
  for (const check of ownAndChildChecks) {
    if (resolved.requirements.some((r) => r.check_id === check.check_id)) continue;
    if (check.evidence_sha256 !== null) evidenceRefs.add(check.evidence_sha256);
  }

  const findingIds = resolved.findingIds;
  const openFindings = [...findingsById.values()]
    .filter((f) => findingIds.has(f.finding_id))
    .filter((f) => f.status !== "closed" && f.status !== "false_positive" && f.status !== "duplicate")
    .sort((a, b) => Number(b.must_block) - Number(a.must_block) || a.finding_id.localeCompare(b.finding_id))
    .map((f) => ({
      finding_id: f.finding_id,
      severity: f.severity,
      status: f.status,
      must_block: f.must_block,
      unverified: f.unverified,
    }));

  const execution = executionDimension(resolved.executions);
  // 依赖线：前置"已交结果但没达标"要显示成待验证，而不是灰（灰是"还没开始"）
  const executionForDisplay: ExecutionDimension =
    isDependencyEdge && obj.edge?.prerequisite_result_submitted === true ? "result_submitted" : execution;

  const impactUnknown = impact.unknown.includes(obj.object_id) ||
    (input.changes ?? []).some((c) => c.affected === "unknown");
  const affected = impact.affected.includes(obj.object_id);
  const unreadable = input.facts_unreadable != null && input.facts_unreadable !== "";
  const graphStale =
    input.graph_revision != null && input.graph_revision.graph !== input.graph_revision.current;
  // 用户已接受的已知限制：不算"明确阻塞"（所以不再染红），但**仍在下方可见**（独立标签 + 不染绿）
  const acceptedLimitFinding = openFindings.some((f) => f.status === "accepted_risk");
  const blockingProblem =
    execution === "blocked" ||
    openFindings.some((f) => findingBlocksObject(f)) ||
    missing.some((m) => m.why.includes("已确认失败"));

  const mapping = mappingOf(resolved);
  const acceptanceRaw = obj.acceptance ?? "pending";
  const acceptedKnownLimit = acceptanceRaw === "accepted_known_limit" || acceptedLimitFinding;

  if (mapping === "unmapped") {
    reasons.push({
      code: "unmapped",
      text: "未映射：这个对象没有任务或验收映射——不空集判绿（DESIGN.md §4.2）",
    });
  }
  if (unreadable) reasons.push({ code: "facts_unreadable", text: `事实读不出来：${input.facts_unreadable}` });
  if (impactUnknown) {
    reasons.push({
      code: "impact_unknown",
      text: "源变化的影响待查：影响不确定时不默认通过，先复核范围（DESIGN.md §5.6）",
    });
  }
  if (graphStale) {
    overlays.push("stale_overlay");
    reasons.push({
      code: "graph_stale",
      text: `图版本落后（${input.graph_revision!.graph.slice(0, 12)}… ≠ ${input.graph_revision!.current.slice(0, 12)}…）：叠加版本提示，不伪造执行状态`,
    });
  }
  if (affected) {
    reasons.push({
      code: "recheck_scope",
      text: "源变了：本对象在重验影响范围内（只重验受影响范围，未受影响对象保持原状态）",
    });
  }
  for (const f of openFindings) {
    const label = f.must_block ? "必须拦截" : "已确认";
    const inherited = (obj.finding_ids ?? []).includes(f.finding_id) ? "" : "（继承自必需子项）";
    reasons.push({
      // 用户接受风险的不算"明确阻塞"（独立标签另加），但仍列在这里（不抹掉已知问题）
      code:
        f.status === "accepted_risk"
          ? "accepted_risk_finding"
          : f.must_block
            ? "blocking_finding"
            : "open_finding",
      text:
        f.status === "accepted_risk"
          ? `${f.finding_id}（${f.severity}，用户接受风险：不算阻塞，也不染绿）${inherited}`
          : `${f.finding_id}（${f.severity}，${f.status}，${label}${f.unverified ? "，未证实/风险未排除" : ""}）${inherited}`,
    });
  }
  if (execution === "in_progress") {
    const who = resolved.executions.filter((e) => e.status === "claimed" || e.status === "executing");
    reasons.push({
      code: "executing",
      text: `有有效运行/执行任务（${who.map((e) => `${e.task_id}@${e.actor_id}`).join("、") || "执行者未记名"}）`,
    });
  }
  if (missing.length > 0) {
    reasons.push({
      code: "missing_evidence",
      text:
        execution === "not_started"
          ? `还没有执行记录，验收项也未开始（缺 ${missing.length} 项：${missing.slice(0, 3).map((m) => m.check_id).join("、")}${missing.length > 3 ? "…" : ""}）`
          : `必需检查/审计不齐：缺 ${missing.length} 项（${missing.slice(0, 3).map((m) => m.check_id).join("、")}${missing.length > 3 ? "…" : ""}）`,
    });
  }
  if (staleCount > 0) {
    reasons.push({
      code: "evidence_stale",
      text: `${staleCount} 项证据的源版本已变：旧绿转待验证（历史保留）`,
    });
  }
  if (independentPasses === 0 && passed > 0 && !isDependencyEdge) {
    reasons.push({
      code: "self_check_only",
      text: `通过项全部来自作者自检（${selfPasses} 项）：作者自报/自检不是独立审计（DESIGN.md §5.5）`,
    });
  }
  // V09-01（附录 E.3.2-4③）：独立复核不是"有就算过"——混合时如实点名还差多少
  if (independentPasses > 0 && selfPasses > 0 && !isDependencyEdge) {
    reasons.push({
      code: "mixed_independence",
      text:
        `通过项里 ${selfPasses}/${passed} 项来自作者自检、${independentPasses} 项有非作者复核记录：` +
        "`quality` 按最弱的一档如实给（不把自检那部分当独立审计，附录 E.3.2-4③）",
    });
  }
  // V09-01（附录 E.3.4）：独立审计记录的盲点逐条公开——不整批作废，也不含糊成"已独立复核"
  {
    const audits = new Map<string, AuditIndependenceFacts>();
    for (const c of ownAndChildChecks) {
      if (c.audit_independence != null) audits.set(c.audit_independence.record_id, c.audit_independence);
    }
    const sameSession = [...audits.values()].filter((a) => a.same_session_as_author);
    if (sameSession.length > 0) {
      reasons.push({
        code: "audit_same_session_downgraded",
        text:
          `${sameSession.length} 条非作者复核记录声明与作者**同一会话**（${sameSession
            .map((a) => a.record_id)
            .join("、")}）：按附录 E.3.4-3 **逐条点名列明**并如实降级标注——不计入「非作者复核」，` +
          "两条收口路径二选一（分离会话重做／如实降级）；**不整批作废**其余记录",
      });
    }
    const readSummary = [...audits.values()].filter((a) => a.read_author_summary_first);
    if (readSummary.length > 0) {
      reasons.push({
        code: "audit_read_author_summary_first",
        text:
          `${readSummary.length} 条非作者复核记录声明**先读了作者摘要**（${readSummary
            .slice(0, 3)
            .map((a) => a.record_id)
            .join("、")}${readSummary.length > 3 ? "…" : ""}）：` +
          "该盲点如实带出（作者摘要只是导航、不代替证据，附录 E.3.4-2）；跨执行者/跨客户端可保留，但**不得**当交叉审计的充分证据",
      });
    }
    const oneHash = [...audits.values()].filter((a) => a.one_hash_per_record);
    if (oneHash.length > 0) {
      reasons.push({
        code: "audit_one_hash_per_record",
        text:
          `${oneHash.length} 条非作者复核记录的多项检查共用一个证据哈希（一记录一哈希）：如实标注，` +
          "**不当**交叉审计证据（附录 E.3.4-4；新写入按检查项分别落哈希）",
      });
    }
  }
  if (acceptanceRaw === "accepted") {
    reasons.push({
      code: "acceptance_accepted",
      text: "人工验收：用户已接受（用户身份记录）",
    });
  } else if (acceptanceRaw === "rejected") {
    reasons.push({ code: "acceptance_rejected", text: "人工验收：用户已退回" });
  } else if (acceptanceRaw === "accepted_known_limit") {
    reasons.push({ code: "acceptance_accepted_known_limit", text: "人工验收：用户接受已知限制" });
  } else if (acceptedLimitFinding) {
    reasons.push({
      code: "acceptance_accepted_risk",
      text: "有缺陷被用户接受风险（记录在缺陷上，不是 Gate 接受）",
    });
  } else {
    reasons.push({ code: "acceptance_pending", text: "人工验收待用户给（质量状态不能代写验收）" });
  }
  if (acceptedKnownLimit) {
    overlays.push("accepted_known_limit");
    reasons.push({
      code: "accepted_limit_not_green",
      text: "用户接受已知限制显示独立标签：**不把已知问题染绿**（DESIGN.md §4.2）",
    });
  }

  const display = mainDisplayStatus({
    no_color: obj.edge?.edge_kind === "static_reference",
    unreadable,
    impact_unknown: impactUnknown,
    graph_stale: graphStale,
    has_blocking_problem: blockingProblem,
    execution: executionForDisplay,
    missing_count: missing.length,
    evidence_stale: staleCount > 0,
    required_count: mapping === "mapped" ? resolved.requirements.filter((r) => r.required !== false).length : 0,
    passed_count: passed,
  });

  const quality: QualityDimension = (() => {
    if (openFindings.length > 0) return "has_findings";
    if (staleCount > 0) return "evidence_invalid";
    const requiredCount = resolved.requirements.filter((r) => r.required !== false).length;
    if (isDependencyEdge) {
      // 依赖线的质量 = 前置交付是否释放（它不是"作者自检"，别套到自检那一档）
      return requiredCount > 0 && passed === requiredCount ? "audit_passed" : "unverified";
    }
    if (requiredCount > 0 && passed === requiredCount) {
      // V09-01（附录 E.3.2-4③）：**只有全部通过项都有非作者复核记录**才配 `audit_passed`。
      // 只要还有一项靠作者自检撑着，就如实给 `mechanical_passed`（并在 reasons 里点名）——
      // 同会话声明的"独立"记录已在 `checkEffectiveness` 里降级，到不了这一档。
      return passed > 0 && independentPasses === passed ? "audit_passed" : "mechanical_passed";
    }
    if (ownAndChildChecks.length > 0) return "auditing";
    return "unverified";
  })();

  // 接受已知限制不把状态染绿：即便必需项都过，也降为待验证（已知问题仍在）
  const finalDisplay: DisplayStatus | null =
    display === "verified" && acceptedKnownLimit ? "pending_verification" : display;
  if (display === "verified" && acceptedKnownLimit) {
    reasons.push({
      code: "verified_downgraded_by_limit",
      text: "必需项都过了，但存在用户接受的已知限制：状态降为「结果待验证」，不显示成绿",
    });
  }

  return {
    object_id: obj.object_id,
    object_kind: obj.object_kind,
    label: obj.label,
    parent_id: obj.parent_id ?? null,
    execution,
    quality,
    acceptance: acceptanceRaw,
    freshness: unreadable
      ? "unreadable"
      : impactUnknown
        ? "impact_unknown"
        : staleCount > 0 || affected
          ? "verification_stale"
          : "fresh",
    display_status: finalDisplay,
    display_status_label: finalDisplay === null ? null : DISPLAY_STATUS_LABELS[finalDisplay],
    mapping,
    reasons,
    required_count: mapping === "mapped" ? resolved.requirements.filter((r) => r.required !== false).length : 0,
    passed_count: passed,
    missing_count: missing.length,
    missing,
    scope: { verified_scope: verifiedScope, uncovered: [...new Set(uncovered)] },
    evidence_refs: [...evidenceRefs].sort(),
    open_findings: openFindings,
    recheck_scope: affected ? [obj.object_id] : [],
    evidence_basis: evidenceBasis,
    history,
    overlays,
    source_revision: revisionOf(revisions, "code") ?? revisionOf(revisions, "interface") ??
      revisionOf(revisions, "plan") ?? revisionOf(revisions, "design") ?? "",
  };
}

/** 投影整批对象（纯函数；父级按子项汇总，边按各自口径） */
export function projectStatuses(input: StatusProjectionInput): StatusProjectionSet {
  const byId = new Map(input.objects.map((o) => [o.object_id, o]));
  const findingsById = new Map(input.findings.map((f) => [f.finding_id, f]));
  const checksByObject = new Map<string, CheckInput[]>();
  for (const c of input.checks) {
    const list = checksByObject.get(c.object_id) ?? [];
    list.push(c);
    checksByObject.set(c.object_id, list);
  }
  const impact = impactScope(input.changes ?? [], [...byId.keys()]);
  const objects = input.objects.map((o) =>
    projectOne(resolveObject(o, byId), input, findingsById, checksByObject, impact),
  );
  const byIdOut: Record<string, StatusProjection> = {};
  for (const p of objects) byIdOut[p.object_id] = p;
  const counts: Record<DisplayStatus, number> = {
    planned: 0,
    in_progress: 0,
    pending_verification: 0,
    verified: 0,
    blocked: 0,
    unknown: 0,
  };
  for (const p of objects) {
    if (p.display_status !== null) counts[p.display_status]++;
  }
  return {
    objects,
    by_id: byIdOut,
    summary: {
      counts,
      unmapped: objects.filter((p) => p.mapping === "unmapped").map((p) => p.object_id),
      blocking_findings: [
        ...new Set(objects.flatMap((p) => p.open_findings.filter((f) => f.must_block).map((f) => f.finding_id))),
      ].sort(),
      basis: NO_COMPLETION_PERCENT,
    },
  };
}

// ── V09-13：来源与证据标注所需的**证据事实摘要**（判据不在这里，见 ui/arch/provenance.ts） ──

/**
 * 把一条状态投影摊成 `EvidenceFacts`（V09-13 的来源/证据标注输入）。
 *
 * **为什么放在本文件**：投影是"证据有效性、缺口、复核、验收"这些语义的**所有者**
 * （`quality` 分档见附录 E.3.2、`history` 见 §5.6、`acceptance` 见 §5.8），所以"从投影里取出哪些
 * 字段当作证据事实"必须在这里定义一次；而"这些事实该判成五档里的哪一档"是 §3.2／§4.2 的图面口径，
 * 唯一实现在 `src/ui/arch/provenance.ts#evidenceStateOf`（卡面点名"分类与证据状态不得在两个 UI
 * 文件各写一套"）。本函数**不新造判据、不改 §4.1 派生口径**，只做字段摘录。
 *
 * @param p        投影对象（null = 投影里没有这个对象 ⇒ 没有证据记录可判）
 * @param opts     蓝图侧的事实（来源复算结果）与人工步骤；缺省时按"未复算 / 无人工步骤"如实处理
 */
export function provenanceFactsOf(
  p: StatusProjection | null,
  opts: {
    object_id?: string;
    label?: string;
    /** 来源引用复算结果（来自 `src/arch/blueprint.ts`；不给 = 没复算过，按"在场但未复核"处理） */
    sources?: { total: number; valid: number; stale: readonly string[]; unlocatable?: readonly string[] };
    /** 需用户动手/确认的步骤（逐条点名；**不代签**，只如实列出） */
    user_actions?: readonly string[];
    /** 是否属于"交付时要用户本人拍板"的对象（任务＝true；模块/关系＝false，人工验收按卡记） */
    delivery_relevant?: boolean;
  } = {},
): EvidenceFacts {
  const userActions =
    opts.user_actions !== undefined
      ? [...opts.user_actions]
      : p !== null && p.object_kind === "task" && p.acceptance === "pending"
        ? ["人工验收待用户本人记录（质量状态不能代写验收，§5.8／附录 E.9）"]
        : [];
  return {
    object_id: opts.object_id ?? p?.object_id ?? "",
    label: opts.label ?? p?.label ?? "",
    has_projection: p !== null,
    mapping: p === null ? null : p.mapping,
    required_count: p?.required_count ?? 0,
    passed_count: p?.passed_count ?? 0,
    missing_count: p?.missing_count ?? 0,
    quality: p?.quality ?? null,
    display_status: p?.display_status ?? null,
    freshness: p?.freshness ?? null,
    acceptance: p?.acceptance ?? null,
    history_count: p?.history.length ?? 0,
    open_findings: p?.open_findings.length ?? 0,
    evidence_refs: p?.evidence_refs ?? [],
    sources_total: opts.sources?.total ?? 0,
    sources_valid: opts.sources?.valid ?? 0,
    sources_stale: [...(opts.sources?.stale ?? [])],
    sources_unlocatable: [...(opts.sources?.unlocatable ?? [])],
    user_actions: userActions,
    delivery_relevant: opts.delivery_relevant ?? p?.object_kind === "task",
  };
}

// ── 从真实现场收集投影输入（读侧；不写任何文件） ──

/**
 * 「需要哪些集成检查」的现场口径（补修 C）。
 *
 * 来源与生效判据（三者缺一都不据此判绿）：
 *   ① 施工图里声明了「集成检查要求」小节，且**结构可读**（`issues` 为空）；
 *   ② 该声明绑定到**声明它的那版施工图**（`plan_revision` = 施工图内容 sha256；同一版内容里的
 *      任何改动都会换掉它，旧证据随即过期）；
 *   ③ 有**有效基线**且基线批准的正是这一版施工图（`in_force`）。
 *      ——未获批准的定义不据此判绿：否则"改完图纸先刷绿"就成了绕过审定的捷径。
 */
export interface ProjectIntegrationRequirements {
  /** 施工图里有没有「集成检查要求」小节 */
  declared: boolean;
  /** 声明来自哪版施工图（内容 sha256）；读不到施工图时 null */
  plan_revision: string | null;
  /** 声明是否被有效基线批准生效 */
  in_force: boolean;
  /** 未生效的原因（人话）；生效或"根本没有声明"时为 null */
  not_in_force_reason: string | null;
  /** 该小节的结构问题（缺列/空 ID/重复/空表）——非空即视为不可读，不据此判绿 */
  issues: string[];
  /** 声明内容（按对象稳定 ID 归组）。**是否采纳由 `in_force` 决定，不由调用方决定。** */
  by_object: Record<string, { check_id: string; label: string; required: boolean }[]>;
}

export interface ProjectFacts {
  work_dir: string;
  last_seq: number;
  task_states: Record<string, TaskState>;
  findings: FindingState[];
  audit: AuditRecords;
  definitions: TaskDefinition[];
  revisions: SourceRevisions;
  /** 生效基线；`plan_definition` = 基线批准的施工图**定义哈希**（V09-07/E.8-7，与 `revisions.plan_definition` 同口径） */
  baseline: { baseline_id: string; design_revision: string; plan_revision: string; plan_definition?: string | null } | null;
  /** 版本化验收定义里的集成检查要求（补修 C；按对象稳定 ID 归组 + 生效判据） */
  integration_requirements: ProjectIntegrationRequirements;
  /**
   * 补修 F3：**Agent 结果回报**（`task.result_submitted`）里声明的可体验运行入口，折成入口来源清单。
   * 与 `audit.submissions`（成果登记那条路径）**同一套**形状与校验，装配时两条路径合并。
   */
  result_runtime_sources: RuntimeEntrySource[];
  /**
   * V09-29（契约 F4）：`task.result_submitted`（执行者结果回报）折成的**交付包只读摘要**。
   * 验收页据此直接展示交付物/验证命令/未测/已知问题（`runtime_entries` 只是其中一项），
   * **不要求 Agent 为了让页面看到再补一条 `audit.submission`**；执行自报与独立审计分开记。
   */
  result_submissions: ResultSubmissionSummary[];
  /**
   * 分段失效复核现场（2026-09-27）：当前图纸原文 + 检查绑定的不可变快照 + 每卡设计依据。
   * 投影层据此按**本对象**分段判 plan/design 证据是否 stale；读不到的部分留空 → 复核回退整份比对。
   * **纯数据**，只进内存，不写盘、不外发（投影响应只挑字段回）。
   */
  binding_segments: BindingSegmentFacts;
}

/** 没有分段现场（图纸读不到 / 没有绑 plan/design 的检查）时的空值：复核一律回退整份比对 */
const noBindingSegments = (): BindingSegmentFacts => ({
  current_plan_cards: null,
  current_design_sections: null,
  snapshots: new Map(),
  design_refs_of: new Map(),
});

/**
 * 不可变快照的分段基准**进程内缓存**：快照按内容哈希命名、写入后一个字节不改（DESIGN.md §2.6
 * 历史对象不接受编辑），所以同一 `${kind}:${revision}` 的解析结果可以复用——否则每次投影都要
 * 把几份 50 万字符的施工图重解析一遍（实测单份约 19ms × 7 份）。
 * **只缓存读到的**：读不到的不缓（快照可能稍后才落盘，existsSync 本身很便宜）。
 */
const snapshotSegmentsCache = new Map<string, BindingSnapshotSegments>();

/**
 * plan 绑定（内容哈希）→ **实际命中的不可变对象名**（进程内；用于"这份快照还在不在"的廉价复查）。
 *
 * 为什么必须记住对象名而不是只记内容哈希：施工图不可变对象的**主名是定义哈希**（§2.6），
 * 同一定义下的另一份正文才叫内容哈希（§2.9）。`binding.revision` 是内容哈希，拿它当文件名去
 * `existsSync` 只有在"这份正文是该定义下的首份"时才对得上；否则文件名其实是定义哈希。
 * 记下解析出来的对象名，复查才查的是**真正读过的那份**（不是另一个候选名）。
 * 键＝`${projectId}\u0000plan:${内容哈希}`（同一内容的对象名虽是确定的，但"哪个候选名在盘上"
 * 是各项目自己的事实，跨项目复用会把别人的对象当成自己的）。
 */
const planSnapshotObjectKeyCache = new Map<string, string>();

/**
 * 从审计记录里收集 plan/design 绑定，读它们对应的不可变快照并**预解析**成分段基准
 *（plan → 卡哈希表；design → 章节表）。键＝`${kind}:${revision}`；读不到/解析不了的文件
 * **不放键**（复核据此回退整份比对，不静默放行）。每个不同修订只解析一次（进程内命中缓存）。
 *
 * plan 绑定绑的是**内容哈希**，而快照对象主名是**定义哈希**：这里经
 * `documents.planContentSnapshotIndex`（内容哈希 → 对象候选名 + 核内容哈希，口径与
 * `obligations.planSnapshotReader` **同一份**）解析后再读——否则旧修订（盘上只有定义名文件）
 * 直读成 null、回退整份比对，把本可分段救回的「本卡没变」误判 stale（V09-45…50 真机假 stale）。
 * 设计书对象名本就是内容哈希，直读即可（`revisionObjectCandidates`：设计没有第二档）。
 */
function bindingSnapshotsOf(
  projectId: string,
  dataDir: string,
  audit: AuditRecords,
): Map<string, BindingSnapshotSegments> {
  const out = new Map<string, BindingSnapshotSegments>();
  let planIndex: ReturnType<typeof planContentSnapshotIndex> | null = null;
  const planIndexOf = (): ReturnType<typeof planContentSnapshotIndex> =>
    (planIndex ??= planContentSnapshotIndex(projectId, dataDir));
  for (const c of checksFromAudit(audit)) {
    const kind = c.binding.revision_kind;
    if ((kind !== "plan" && kind !== "design") || c.binding.revision === "") continue;
    const key = `${kind}:${c.binding.revision}`;
    if (out.has(key)) continue;

    if (kind === "plan") {
      // 记忆按**项目**分开：对象名虽是内容的确定函数，但"哪个候选名在盘上"是项目各自的事实
      //（同定义哈希下可能另一份正文占着主名），跨项目复用会把别人的对象当成自己的。
      const memoKey = `${projectId}\u0000${key}`;
      // 廉价复查：缓存过的也要每次确认**真正读过的那份**快照还在盘上，否则"快照被删"不会回退整份比对（宁严不松）。
      const knownKey = planSnapshotObjectKeyCache.get(memoKey);
      if (knownKey !== undefined) {
        if (revisionSnapshotExists(projectId, "plan", knownKey, dataDir)) {
          const hit = snapshotSegmentsCache.get(key);
          if (hit !== undefined) {
            out.set(key, hit);
            continue;
          }
        }
        // 盘上没了 / 段缓存丢了：清掉记忆，按下面重新解析
        planSnapshotObjectKeyCache.delete(memoKey);
        snapshotSegmentsCache.delete(key);
      }
      const read = planIndexOf().read(c.binding.revision);
      if (read === null) {
        snapshotSegmentsCache.delete(key);
        continue;
      }
      planSnapshotObjectKeyCache.set(memoKey, read.object_key);
      const parsed: BindingSnapshotSegments = { cards: planCardHashesOf(read.text) };
      snapshotSegmentsCache.set(key, parsed);
      out.set(key, parsed);
      continue;
    }

    // design：对象名就是内容哈希，直读（读不到就回退整份比对）
    if (!revisionSnapshotExists(projectId, "design", c.binding.revision, dataDir)) {
      snapshotSegmentsCache.delete(key);
      continue;
    }
    const hit = snapshotSegmentsCache.get(key);
    if (hit !== undefined) {
      out.set(key, hit);
      continue;
    }
    const text = readRevisionSnapshotText(projectId, "design", c.binding.revision, dataDir);
    if (text === null) continue;
    const parsed: BindingSnapshotSegments = { sections: designSectionsOf(text) };
    snapshotSegmentsCache.set(key, parsed);
    out.set(key, parsed);
  }
  return out;
}

const noIntegrationRequirements = (reason: string | null, issues: string[] = []): ProjectIntegrationRequirements => ({
  declared: false,
  plan_revision: null,
  in_force: false,
  not_in_force_reason: reason,
  issues,
  by_object: {},
});

/**
 * 一次事件账本读取的快照（同一调用链内共享用；事件账本 = 唯一事实源，见 DESIGN.md §2.6）。
 *
 * 存在的理由**只是**「同一次调用里少读几遍同一份账本」，不是全局/跨请求缓存：
 * 快照每次现读、只活在这一次调用栈里，下一次调用立刻能看见新事件。
 *
 * 为什么必须带 `work_dir`：快照是**某个项目某个截点**的读数，跨 workDir／跨项目／跨截点复用
 * 就是把别人的账本当成自己的（`eventsOfSnapshot` 只认来源一致的那一份，不一致就回退现读）。
 * 空数组是**合法快照**（"这个 workDir 现在没有事件"），不得当作"没传"再读一遍。
 *
 * V09-38 复审：读口改为 `readLedger`（有界内容核验解析缓存），并把本次现读的**可验证内容身份**
 * （`content`：文件字节 / 已证实行边界 / 该段 sha256）随快照带下去——同一条调用链里任务的认领、
 * 执行、审计与投影都从**同一份已核验读数**派生，而不是各自再读一遍盘。
 */
export interface EventsSnapshot {
  /** 快照来源的事件目录（`projectWorkDir` 的结果）；与调用点的 workDir 不一致即不复用 */
  work_dir: string;
  events: WorkEvent[];
  /** 本次现读的账本内容身份（可验证；旧调用点手造快照可省略，省略即无内容证明） */
  content?: LedgerContentFingerprint;
}

/** 现读一份当前账本快照（读不出来照常抛，由调用方决定怎么如实表达） */
export function eventsSnapshotOf(projectId: string, dataDir: string): EventsSnapshot {
  const work_dir = projectWorkDir(projectId, dataDir);
  const read = readLedger(work_dir);
  return { work_dir, events: read.events, content: read.content };
}

/**
 * 取快照里的事件：**只有来源 workDir 与本次一致**才复用，否则回退现读（既有调用点的现读行为不变）。
 * `snapshot` 为 undefined/null 也现读；`{work_dir, events: []}` 是合法快照，直接返回 `[]`，不 fallthrough。
 */
export function eventsOfSnapshot(
  snapshot: EventsSnapshot | undefined | null,
  workDir: string,
): WorkEvent[] {
  if (snapshot !== undefined && snapshot !== null && snapshot.work_dir === workDir) {
    return snapshot.events;
  }
  return readLedger(workDir).events;
}

/** 读现场事实（事件 + 图纸定义 + 生效基线）；读不出来如实标 `unreadable`，不假装是空状态 */
export function collectProjectFacts(
  projectId: string,
  dataDir: string,
  opts: { code_revision?: string | null; events?: EventsSnapshot } = {},
): ProjectFacts {
  // 2026-10-07 运行时阻塞修复：整段跑在一次派生的只读复用作用域里——图纸源读取与解析、
  // 不可变修订对象读+核哈希、源清单逐文件复核、git 忽略探针在同一次派生内只算一次（跨请求不缓存）。
  // 证据：E/runtime-profile-only/REPORT.md（独立 CPU profile）、E/runtime-final/COORDINATOR-HYPOTHESES.md。
  return withDerivationScope(() => collectProjectFactsInScope(projectId, dataDir, opts));
}

function collectProjectFactsInScope(
  projectId: string,
  dataDir: string,
  opts: { code_revision?: string | null; events?: EventsSnapshot } = {},
): ProjectFacts {
  const workDir = projectWorkDir(projectId, dataDir);
  const events = eventsOfSnapshot(opts.events, workDir);
  const findings = readFindings(workDir, events);
  const audit = foldAuditRecords(events);
  const tasksProjection = readTaskStates(workDir, events);
  let definitions: TaskDefinition[] = [];
  const revisions: SourceRevisions = {};
  let baseline: ProjectFacts["baseline"] = null;
  let binding_segments: BindingSegmentFacts = noBindingSegments();
  let integration = noIntegrationRequirements(
    "读不到施工图：集成检查要求没有版本化来源，不据此判绿（DESIGN.md §2.9 / §4.2）",
  );
  try {
    const docs = loadDocuments(projectId, dataDir);
    const design = docs.design?.revision ?? null;
    const plan = docs.plan?.revision ?? null;
    revisions.design = design?.content_sha256 ?? null;
    revisions.plan = plan?.content_sha256 ?? null;
    // V09-07（E.8-7）：施工图侧再带**定义哈希**——图新鲜度比它，不再比内容哈希
    revisions.plan_definition = plan?.definition_sha256 ?? null;
    if (docs.plan !== null) {
      definitions = importTaskDefinitions(docs.plan.text).definitions;
      integration = integrationRequirementsFromPlan(docs.plan.text, plan?.content_sha256 ?? null);
    }
    // 分段失效复核现场（2026-09-27）：当前卡哈希表/章节表（各解析一次）+ 检查绑定到的快照基准 + 每卡的「设计依据」。
    binding_segments = {
      current_plan_cards: docs.plan === null ? null : planCardHashesOf(docs.plan.text),
      current_design_sections: docs.design === null ? null : designSectionsOf(docs.design.text),
      snapshots: bindingSnapshotsOf(projectId, dataDir, audit),
      design_refs_of: new Map(definitions.map((d) => [d.task_id, d.design_refs])),
    };
    const active = activeBaseline(projectId, dataDir);
    if (active !== null) {
      baseline = {
        baseline_id: active.baseline_id,
        design_revision: active.design_revision.content_sha256,
        plan_revision: active.plan_revision.content_sha256,
        // 基线记录的 plan_revision（DocumentRevisionRef）本就带定义哈希——直接取，不另算
        plan_definition: active.plan_revision.definition_sha256,
      };
    }
  } catch {
    // 图纸缺失/读不动：revisions 留 null → 依赖复核的检查会进"无法复核"，不默认通过
  }
  integration = withIntegrationRequirementsInForce(integration, baseline);
  // 契约 F4：**当前代码版本**不能来自账本里的自报（`latestCodeBindingRevision` 是自报值）。
  // 产品读口默认 `code = null`（= "当前源码未知，代码检查一律待复核"）；只有调用方显式给
  // `opts.code_revision`（测试／显式覆盖）才把某个值当"当前代码版本"。自报值另放 `code_declared`，
  // 只作展示，绝不参与"源码是否变了"的复核。
  revisions.code = opts.code_revision ?? null;
  revisions.code_declared = latestCodeBindingRevision(audit, events);
  return {
    work_dir: workDir,
    last_seq: tasksProjection.last_seq,
    task_states: tasksProjection.states,
    findings: Object.values(findings.findings).sort((a, b) => a.finding_id.localeCompare(b.finding_id)),
    audit,
    definitions,
    revisions,
    baseline,
    integration_requirements: integration,
    binding_segments,
    // 补修 F3：Agent 结果回报里声明的可体验运行入口（与成果登记同一套形状/校验/状态判定）。
    // 读侧校验就在这里发生：非法登记抛 `EVENT_INVALID`（宁可红，也不静默丢一条入口）。
    result_runtime_sources: resultSubmittedSources(events),
    // V09-29（契约 F4）：结果回报的交付包（交付物/验证/未测/已知问题）——供验收页只读展示
    result_submissions: resultSubmissionSummaries(events),
  };
}

/**
 * 用**指定版本**的施工图快照重建 `ProjectFacts` 里属于施工图的部分（定义 / 集成检查要求 /
 * 修订 / 分段基准的当前卡表）。
 *
 * 为什么必须重建而不是"换一份 text 变量"：读取历史/基线版本时，任务定义与集成检查要求必须来自
 * **那一版**施工图；否则历史读数会拿当前的卡定义与当前集成要求判绿（借当前绿，§2.9 不许混版）。
 * 事实里的**事件侧**（审计/任务状态/缺陷）不在这里换——它们由调用方按所选版本的时间窗**裁事件**
 * 后再取（见 `featureLedger.ts`），两者合起来才是"该版本的完整事实"。
 *
 * `facts.baseline` 不动（生效基线由调用方按所选版本决定后另行传入 `withIntegrationRequirementsInForce`）。
 */
export function withPlanSnapshot(
  facts: ProjectFacts,
  args: { plan_text: string; plan_revision: string | null; plan_definition: string | null },
): ProjectFacts {
  const definitions = importTaskDefinitions(args.plan_text).definitions;
  const integration = integrationRequirementsFromPlan(args.plan_text, args.plan_revision);
  return {
    ...facts,
    definitions,
    revisions: { ...facts.revisions, plan: args.plan_revision, plan_definition: args.plan_definition },
    integration_requirements: withIntegrationRequirementsInForce(integration, facts.baseline),
    binding_segments: {
      ...facts.binding_segments,
      // 当前卡表换成所选版本的：分段失效复核据此按**那一版**的卡哈希判，而不是拿今日图纸冒充
      current_plan_cards: planCardHashesOf(args.plan_text),
      design_refs_of: new Map(definitions.map((d) => [d.task_id, d.design_refs])),
    },
  };
}

/**
 * 施工图 → 集成检查要求（补修 C）。
 * 只做**读取与归组**，生效判据（有效基线）留给调用方——本函数拿不到基线上下文。
 * 结构问题一律进 `issues`（读侧据此"不据此判绿"，绝不静默当"没有要求"）。
 */
export function integrationRequirementsFromPlan(  planText: string,
  planRevision: string | null,
): ProjectIntegrationRequirements {
  const parsed = parseIntegrationRequirements(planText);
  const byObject: ProjectIntegrationRequirements["by_object"] = {};
  for (const row of parsed.rows) {
    const list = byObject[row.object_id] ?? [];
    list.push({ check_id: row.check_id, label: row.label, required: row.required });
    byObject[row.object_id] = list;
  }
  return {
    declared: parsed.declared,
    plan_revision: planRevision,
    in_force: false, // 由调用方在拿到生效基线后再定
    not_in_force_reason: null,
    issues: parsed.issues,
    by_object: byObject,
  };
}

/**
 * 判定这份集成检查要求是否**已被有效基线批准生效**（补修 C ③）。
 *   ① 施工图里没有这一节 → 不是错误：`in_force` 保持 false，但也没有"未生效"的理由（没声明就是没声明）；
 *   ② 小节有结构问题 → 不可读，不据此判绿；
 *   ③ 没有生效基线 → 未获批准的定义不据此判绿；
 *   ④ 生效基线批准的施工图修订 ≠ 当前施工图修订 → 当前这份声明未获批准，不据此判绿。
 * 返回新对象（不改输入）。
 */
export function withIntegrationRequirementsInForce(
  req: ProjectIntegrationRequirements,
  baseline: ProjectFacts["baseline"],
): ProjectIntegrationRequirements {
  if (!req.declared) return { ...req, in_force: false };
  if (req.issues.length > 0) {
    return {
      ...req,
      in_force: false,
      not_in_force_reason: `施工图的「集成检查要求」小节有结构问题（${req.issues.join("；")}）：读不出要求就不据此判绿`,
    };
  }
  if (baseline === null) {
    return {
      ...req,
      in_force: false,
      not_in_force_reason:
        `施工图（plan 修订 ${shortRev(req.plan_revision)}）声明了集成检查要求，但还没有生效基线批准这份修订：` +
        "未获批准的定义不据此判绿（DESIGN.md §2.9 / §4.2）",
    };
  }
  if (baseline.plan_revision !== req.plan_revision) {
    return {
      ...req,
      in_force: false,
      not_in_force_reason:
        `生效基线 ${baseline.baseline_id} 批准的是 plan 修订 ${shortRev(baseline.plan_revision)}，` +
        `当前施工图是 ${shortRev(req.plan_revision)}：当前这份集成检查要求未被有效基线批准，不据此判绿`,
    };
  }
  return { ...req, in_force: true, not_in_force_reason: null };
}

/**
 * 当前代码版本的统一口径（**2026-09-20 第二轮裁定（3）：两种来源同权**）：
 * 取"最近一次**声明了 code 版本**的提交"，两个来源都在候选里——
 *   · 成果登记 `audit.submission_submitted` 的 `binding.revision`（`revision_kind === "code"`）；
 *   · Agent 结果回报 `task.result_submitted` 的 `payload.result_revision`。
 *
 * 排序沿用裁定 B ②/③：**先按实际发生时间**（`occurred_at`，解析成真实时刻再比，不能比字面钟点——
 * `…09:00:00+08:00` 真实早于 `…02:00:00Z`），**同刻用服务端提交序号 `seq` 做次级序**
 * （`occurred_at` 只到秒，同秒多次提交很常见；旧实现同刻落回插入顺序、会把**最新**那一版取成**最早**那条）。
 *
 * 时间解析不出来、版本串为空的候选不参与"最近"的比较；一个候选都没有 → null
 * （复核时如实标"拿不到当前版本、不默认通过"，绝不假装代码没变）。
 *
 * 为什么必须两源同权：只认成果登记时，**纯走 MCP 结果回报**的项目永远取不到当前版本，
 * 运行入口的版本轴会恒为 `unknown`（等价的两条登记路径在"版本基准"上不对等）。
 * 注意这不改变 V06-12 的口径：检查仍须**版本精确匹配 + 证据有效**才生效，结果回报本身不等于检查通过。
 */
function latestCodeBindingRevision(records: AuditRecords, events: readonly WorkEvent[]): string | null {
  interface Cand {
    ms: number;
    seq: number;
    revision: string;
  }
  const cands: Cand[] = [];
  for (const s of Object.values(records.submissions)) {
    if (s.binding === null || s.binding.revision_kind !== "code") continue;
    const ms = parseIsoMs(s.at);
    const revision = s.binding.revision.trim();
    if (ms === null || revision === "") continue;
    cands.push({ ms, seq: s.seq, revision });
  }
  for (const e of events) {
    if (e.type !== "task.result_submitted") continue;
    const rev = e.payload?.result_revision;
    const ms = parseIsoMs(e.occurred_at);
    if (typeof rev !== "string" || rev.trim() === "" || ms === null) continue;
    cands.push({ ms, seq: e.seq, revision: rev.trim() });
  }
  if (cands.length === 0) return null;
  cands.sort((a, b) => b.ms - a.ms || b.seq - a.seq);
  return cands[0].revision;
}

/**
 * `task.result_submitted`（执行者结果回报）的**交付包只读摘要**（V09-29／契约 F4）。
 *
 * 用途：验收页要能看到"执行者自报"的交付物 / 验证命令 / 未测项 / 已知问题——**不是只看
 * `runtime_entries`**；也不能反过来要求 Agent 为了让页面看得见，再手工补一条 `audit.submission`。
 * 本函数**只读**地把结果回报里已有的字段原样带出，**不改判任何验证结论**：
 * 执行自报（这一份）与独立审计 / 用户验收是分开记的（§5.5），谁也不冒充谁。
 *
 * 字段以 `submitTaskResult` 实际写进 payload 的为准（`deliverables/evidence_refs/verification/
 * untested/known_issues/diff_ref/result_revision/runtime_entries`）；`changed_files` 目前不在结果回报
 * payload 里，若将来写进来就照带（此处按"有就带、没有就空数组"处理，不伪造）。
 */
export interface ResultSubmissionSummary {
  source: "result_submitted";
  /** 结果回报事件 id（可追溯回账本） */
  record_ref: string;
  task_id: string | null;
  submitted_by: string;
  at: string;
  result_revision: string | null;
  deliverables: string[];
  changed_files: string[];
  verification: { command: string; exit_code: number; output_ref: string | null }[];
  untested: string[];
  known_issues: string[];
  evidence_refs: string[];
  diff_ref: string | null;
  /** 结果回报的语义（逐字带出；提醒"已提交 ≠ 已验证/已验收"） */
  meaning: string;
}

function strArrayOf(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

export function resultSubmissionSummaries(events: readonly WorkEvent[]): ResultSubmissionSummary[] {
  const out: ResultSubmissionSummary[] = [];
  for (const e of [...events].sort((a, b) => a.seq - b.seq)) {
    if (e.type !== "task.result_submitted") continue;
    const p: Record<string, unknown> = e.payload ?? {};
    const verification: { command: string; exit_code: number; output_ref: string | null }[] = [];
    if (Array.isArray(p.verification)) {
      for (const v of p.verification) {
        if (typeof v !== "object" || v === null) continue;
        const row = v as { command?: unknown; exit_code?: unknown; output_ref?: unknown };
        if (typeof row.command !== "string") continue;
        verification.push({
          command: row.command,
          exit_code: typeof row.exit_code === "number" ? row.exit_code : -1,
          output_ref: typeof row.output_ref === "string" ? row.output_ref : null,
        });
      }
    }
    const rev = p.result_revision;
    out.push({
      source: "result_submitted",
      record_ref: e.event_id,
      task_id: e.entity_id.startsWith("task:") ? e.entity_id.slice("task:".length) : null,
      submitted_by: e.actor_id,
      at: e.received_at,
      result_revision: typeof rev === "string" && rev.trim() !== "" ? rev.trim() : null,
      deliverables: strArrayOf(p.deliverables),
      changed_files: strArrayOf(p.changed_files),
      verification,
      untested: strArrayOf(p.untested),
      known_issues: strArrayOf(p.known_issues),
      evidence_refs: strArrayOf(p.evidence_refs),
      diff_ref: typeof p.diff_ref === "string" && p.diff_ref !== "" ? p.diff_ref : null,
      meaning: typeof p.meaning === "string" ? p.meaning : "执行者已提交结果；不表示审计通过或人工验收接受（DESIGN.md §5.4）",
    });
  }
  return out;
}

/**
 * V09-29（契约 F4）：装配**带源清单现读复核**的检查输入。
 *
 * 只对**绑 code 且证据正文里带 `source_manifest`** 的检查现读复核（有限范围：只读清单声明的那些路径）；
 * 其余检查逐字照旧（不认识清单的历史记录行为不变）。清单载体缺失/坏/不是清单 → 不加这一项
 * （走既有口径；**不**凭"没有清单"把历史一概判失效——它的采信与否由 `checkEffectiveness` 按
 * `revisions.code` 现行值决定：产品读口默认 `code=null`，于是**没有可核对来源的 code 检查 = unknown 待复核**）。
 *
 * **绑定一致**：清单必须**定义**检查所声称的那个 code 修订（`check.binding.revision === manifest.fingerprint`）；
 * 对不上就**不拿这份清单给该检查背书**（按未知待复核）——不允许随便附一份无关清单把旧 check 通行。
 * 现读结论只在本函数**单次投影**内按清单指纹复用，不跨调用缓存（源一变即重算，不跨源保绿）。
 */
export function checksWithSourceManifests(
  records: AuditRecords,
  ctx: { projectRoot: string; workDir: string },
): CheckInput[] {
  const checks = checksFromAudit(records);
  const carriers = new Map<string, SourceManifestCarrier | null>();
  const verdicts = new Map<string, SourceManifestVerdict>();
  const load = (sha: string): SourceManifestCarrier | null => {
    if (!carriers.has(sha)) {
      let carrier: SourceManifestCarrier | null = null;
      try {
        // sha 必须严格 64hex，否则 evidenceBlobPath 直接拒（拒绝路径穿越）
        carrier = readManifestCarrier(evidenceBlobPath(ctx.workDir, sha));
      } catch {
        carrier = null;
      }
      carriers.set(sha, carrier);
    }
    return carriers.get(sha) ?? null;
  };
  return checks.map((c) => {
    if (c.binding.revision_kind !== "code" || c.evidence_sha256 === null) return c;
    const carrier = load(c.evidence_sha256);
    if (carrier === null) return c;
    const manifest = carrier.manifest;
    const unreadable = (declared: number, reason: string): CheckInput => ({
      ...c,
      source_manifest: {
        status: "unreadable",
        declared_count: declared,
        changed: [],
        missing: [],
        unreadable: [],
        current_fingerprint: null,
        reason,
      },
    });
    // 载体完整性：正文被改过/截损（内容地址/bytes/kind 对不上）→ 不采信，按未知待复核
    if (!carrier.intact) {
      return unreadable(
        manifest.files.length,
        `检查「${c.check_id}」引用的源清单载体完整性核验不过（${carrier.defect ?? "未知"}）：` +
          "证据不可变、正文必须可取回，不拿被改过/截损的载体给检查背书，按未知待复核",
      );
    }
    // 绑定一致：清单指纹必须 == 检查绑定的 code 修订，否则这份清单与该检查无关 → 未知待复核
    if (manifest.fingerprint !== c.binding.revision) {
      return unreadable(
        manifest.files.length,
        `检查「${c.check_id}」绑定的 code 修订与证据里源清单的指纹不一致：` +
          "不拿一份无关清单给它背书，按未知待复核（要么用清单指纹重绑检查，要么换对该检查名副其实的清单）",
      );
    }
    // 载体**自己声明的绑定**必须与检查**同类且成形**（读回却不用 = 随便一份声明着别的来源类的
    // 清单也能给旧 check 背书）。判据只比 `revision_kind`（不比 revision 字面值）：清单指纹是
    // **服务端**在 `store` 时才算出并回执的，MCP 调用方在登记那一刻拿不到它，故载体自报 binding 的
    // revision 天然与"检查绑定的指纹"不同（例如自报的是覆盖源的内容修订）——按字面值强等会把这个
    // 正常流程一律判未知（实测会打断 `verify-http-source-freshness` 的 ①-4/②-1/③-1）。
    // 真正防"无关清单背书"的是上面的「清单指纹 == 检查绑定的 code 修订」；这里只拦**来源类不一致**
    // （如 plan 清单给 code 检查背书）与绑定缺失/空修订。
    const cb = carrier.binding;
    if (cb === null || cb.revision.trim() === "" || cb.revision_kind !== c.binding.revision_kind) {
      const declared = cb === null ? "（无）" : `${cb.revision_kind}:${cb.revision.slice(0, 12)}…`;
      return unreadable(
        manifest.files.length,
        `检查「${c.check_id}」的源清单载体自报绑定（${declared}）与检查绑定` +
          `（${c.binding.revision_kind}:${c.binding.revision.slice(0, 12)}…）**不是同一来源类**（或缺/空）：` +
          "不拿来源对不上的清单给检查背书，按未知待复核",
      );
    }
    // 同一份清单只现读复核一次（多个检查引用同一清单时复用结论；作用域 = 本次投影）
    const key = manifest.fingerprint;
    let verdict = verdicts.get(key);
    if (verdict === undefined) {
      verdict = verifySourceManifest(ctx.projectRoot, manifest);
      verdicts.set(key, verdict);
    }
    return { ...c, source_manifest: verdict };
  });
}

/**
 * **统一入口**：现场事实 → 带源清单现读复核的检查输入（契约 F4）。
 *
 * 产品读口（HTTP `/status-projection`、`project_entry`、`get_arch`）与 MCP 消费者**一律用它**，
 * 不要直接 `checksFromAudit(facts.audit)`——后者会绕过「覆盖源一变即失效 / 无可核对来源即待复核」，
 * 给旧检查假绿。项目根由 `facts.work_dir` 推出，调用方不必再传。
 */
export function checksFromFacts(facts: ProjectFacts): CheckInput[] {
  return checksWithSourceManifests(facts.audit, {
    projectRoot: projectRootOfWorkDir(facts.work_dir),
    workDir: facts.work_dir,
  });
}

/** 任务台账里的 module_id 映射（父级/模块归属的唯一现实来源；缺就是缺，不猜） */
export function readTaskModuleMapping(tasksFile: string): Record<string, string> {
  if (!fs.existsSync(tasksFile)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(tasksFile, "utf8")) as {
      tasks?: { id?: unknown; module_id?: unknown }[];
    };
    const out: Record<string, string> = {};
    for (const t of raw.tasks ?? []) {
      if (typeof t.id === "string" && typeof t.module_id === "string" && t.module_id !== "") {
        out[t.id] = t.module_id;
      }
    }
    return out;
  } catch {
    return {};
  }
}

export interface FactsToObjectsOptions {
  /** 额外的连线（集成/静态引用线；依赖线由定义自动生成） */
  extra_edges?: StatusObjectInput[];
  /**
   * **显式覆盖**：模块自身的集成检查（父级全绿的必要条件）。
   *
   * 补修 C 之后，正常取值来自施工图的版本化验收定义（`facts.integration_requirements`）；
   * 这个选项只用于**测试夹具或调用方的显式覆盖**，优先级高于图纸定义，且会在投影里被
   * 如实标注（`integration_checks_source: "override"` + 一条 `integration_requirements_override` 原因）。
   * 产品读口（HTTP `/status-projection`）与前端**都不传它**——外部声明产生不了绿灯。
   */
  module_integration_checks?: Record<string, RequirementInput[]>;
  /** 依赖释放结论（键 = `<前置>-><依赖方>`） */
  dependency_releases?: Record<string, { released: boolean; reasons: string[]; caveats?: string[] }>;
}

/** 把现场事实摊成投影对象：任务（含定义里的验收项）+ 模块（父级）+ 依赖线 */
/**
 * 任务定义 → 必需检查清单（**单一出处**：与 `objectsFromFacts` 拼 `check_id` 的口径逐字相同）。
 * 每个定义都给一条键（列表可能为空）：调用方据此区分"没有这个任务定义"与"定义了但没有检查项"。
 * 补修包 D 复用本函数把「哪些必需检查」摆清楚（V06-12 的 Git 提醒判定）。
 */
export function requiredChecksFromDefinitions(
  defs: readonly TaskDefinition[],
): Record<string, { check_id: string; label: string }[]> {
  const out: Record<string, { check_id: string; label: string }[]> = {};
  for (const def of defs) {
    const list: { check_id: string; label: string }[] = [];
    if (def.acceptance != null) {
      def.acceptance.checks.forEach((c, i) => {
        // B2/V09-52（DESIGN.md §2.5.1）：检查文本起始的稳定键 `chk-*`（允许 `**`/`__` 加粗包装）作 check_id；
        // 无前缀的旧检查保持**位置型** id（既有项目行为逐字不变）。稳定键的定义指纹与显式映射见 obligations.ts。
        const stable = /^\s*(?:\*\*|__)?\s*(chk-[A-Za-z0-9][A-Za-z0-9._-]*)/.exec(c.text)?.[1] ?? null;
        list.push({ check_id: stable ?? `${def.task_id}::check:${i}`, label: c.text });
      });
    }
    if (def.evidence_requirement != null && def.evidence_requirement !== "") {
      list.push({ check_id: `${def.task_id}::evidence`, label: def.evidence_requirement });
    }
    out[def.task_id] = list;
  }
  return out;
}

/** 把现场事实摊成投影对象：任务（含定义里的验收项）+ 模块（父级）+ 依赖线 */
export function objectsFromFacts(
  projectId: string,
  dataDir: string,
  facts: ProjectFacts,
  opts: FactsToObjectsOptions = {},
): StatusObjectInput[] {
  const mapping = readTaskModuleMapping(tasksFileOf(projectId, dataDir));
  const objects: StatusObjectInput[] = [];
  const defsById = new Map(facts.definitions.map((d) => [d.task_id, d]));
  for (const id of Object.keys(facts.task_states).sort()) {
    const state = facts.task_states[id];
    const def = defsById.get(id);
    const required: RequirementInput[] =
      def === undefined ? [] : requiredChecksFromDefinitions([def])[id] ?? [];
    objects.push({
      object_id: id,
      object_kind: "task",
      label: def?.goal ?? id,
      executions: [{ task_id: id, status: state.status, actor_id: state.owner_id ?? state.last_actor, updated_at: state.updated_at }],
      required_checks: required,
      finding_ids: facts.findings.filter((f) => f.object_id === id).map((f) => f.finding_id),
      revisions: facts.revisions,
    });
  }
  // 模块（父级）：只有台账给了 module_id 才是"映射存在"，否则不进对象表（缺映射就是缺映射）
  const byModule = new Map<string, string[]>();
  for (const [taskId, moduleId] of Object.entries(mapping)) {
    if (facts.task_states[taskId] === undefined) continue;
    byModule.set(moduleId, [...(byModule.get(moduleId) ?? []), taskId]);
  }
  for (const moduleId of [...byModule.keys()].sort()) {
    const children = byModule.get(moduleId)!.sort();
    const objectId = `module:${moduleId}`;
    // ── 补修 C：自身集成检查要求从**权威事实**装配 ──
    // 优先级：显式进程内覆盖（测试夹具/显式覆盖，来源如实标注） > 施工图的版本化验收定义（须被有效基线批准）。
    // HTTP 读口与前端都不传覆盖，所以"外部声明直接产生绿"这条路不存在：
    // 要绿就得有 (a) 被基线批准的图纸定义 + (b) 真实检查记录事件，两者都从事实里读。
    const override = opts.module_integration_checks?.[moduleId];
    const declared = facts.integration_requirements;
    const declaredHere = declared.in_force ? declared.by_object[objectId] ?? [] : [];
    const integrationChecks = override ?? declaredHere;
    const source: "plan" | "override" | "none" =
      override !== undefined ? "override" : declaredHere.length > 0 ? "plan" : "none";
    objects.push({
      object_id: objectId,
      object_kind: "module",
      label: moduleId,
      children_ids: children,
      integration_checks: integrationChecks,
      integration_checks_source: source,
      integration_checks_revision: source === "plan" ? declared.plan_revision : null,
      integration_checks_blocked_reason:
        override === undefined && integrationChecks.length === 0 ? declared.not_in_force_reason : null,
      finding_ids: facts.findings.filter((f) => f.object_id === objectId).map((f) => f.finding_id),
      revisions: facts.revisions,
    });
  }
  // 施工依赖线（定义里的依赖）：只表示前置交付是否满足，不代表数据链路联通
  for (const def of facts.definitions) {
    for (const dep of def.dependency_ids) {
      if (facts.task_states[def.task_id] === undefined || facts.task_states[dep] === undefined) continue;
      const edgeId = `${dep}->${def.task_id}`;
      const release = opts.dependency_releases?.[edgeId];
      const prereqState = facts.task_states[dep];
      objects.push({
        object_id: edgeId,
        object_kind: "edge",
        label: `${dep} → ${def.task_id}`,
        edge: {
          edge_kind: "dependency",
          from: dep,
          to: def.task_id,
          prerequisite_released: release?.released ?? false,
          prerequisite_result_submitted:
            prereqState === undefined ? false : prereqState.status === "result_submitted",
          prerequisite_reasons: release?.reasons ?? ["未判依赖释放：先跑 dependencyRelease"],
          prerequisite_caveats: release?.caveats ?? [],
        },
        required_checks: [
          {
            check_id: `${edgeId}::prerequisite`,
            label: `前置 ${dep} 交付满足（依赖要求：${def.dependency_evidence.find((d) => d.dependency_id === dep)?.evidence ?? "未声明"}）`,
          },
        ],
        unmapped: false,
        revisions: facts.revisions,
      });
    }
  }
  objects.push(...(opts.extra_edges ?? []));
  return objects;
}

/** 便捷入口：现场事实 → 投影（任务 + 模块 + 依赖线 + 调用方给的额外连线） */
export function projectFromFacts(
  projectId: string,
  dataDir: string,
  opts: FactsToObjectsOptions & {
    changes?: readonly SourceChange[];
    graph_revision?: { graph: string; current: string } | null;
    facts_unreadable?: string | null;
    code_revision?: string | null;
    /**
     * 事件账本快照（V09-47 写边界）：给定时**只折叠这份快照**（来源 `work_dir` 必须与本次一致，
     * 不一致由 `eventsOfSnapshot` 回退现读）。锁内写边界用它，保证依赖重查与锁内 `loadEvents` 同源。
     */
    events?: EventsSnapshot;
  } = {},
): { facts: ProjectFacts; projection: StatusProjectionSet } {
  const facts = collectProjectFacts(projectId, dataDir, {
    code_revision: opts.code_revision ?? null,
    ...(opts.events === undefined ? {} : { events: opts.events }),
  });
  const objects = objectsFromFacts(projectId, dataDir, facts, opts);
  // V09-29（契约 F4）：带源清单现读复核的检查输入（其余照旧）——真实读路径与 `entry.ts` 同口径
  const checks = checksFromFacts(facts);
  const acceptance = acceptanceDimensionOf(Object.values(facts.audit.acceptances));
  const objectsWithAcceptance = objects.map((o) => ({ ...o, acceptance }));
  const projection = projectStatuses({
    objects: objectsWithAcceptance,
    findings: facts.findings,
    checks,
    changes: opts.changes ?? [],
    source_revision: facts.revisions,
    graph_revision: opts.graph_revision ?? null,
    facts_unreadable: opts.facts_unreadable ?? null,
    binding_segments: facts.binding_segments,
  });
  return { facts, projection };
}

/** 作者/审计者写法归一（与 `pickIndependenceOf` 同一归一：换写法冒充独立等于不设防） */
const normActorId = (s: string): string => s.toLowerCase().replace(/[^0-9a-z\p{Script=Han}]+/gu, "");

/**
 * 「已验证修复事实」核验（修复后独立复测闭环的 ⑤）：本轮复测所依据的 `audit.fix_recorded`
 * 是否真的存在、可核对、且不是自审。全 fail-closed——任一不满足返回 `null`
 * （= 没有可采信的修复事实，不解除任何失败；**不得自报"已验证"而没有修复证据**）。
 *
 * 判据（record 级）：
 *   · `fix_refs` 非空，且每一项都能在**账本**里找到对应的修复记录（引用不存在的修复 → 不认）；
 *   · 修复记录带证据（`evidence_ref` 非空）；
 *   · 修复记录若给了回归命令，退出码必须全 0（非零的"回归"不采信）；
 *   · 修复者（写法归一后）≠ 复测审计者——复测者不能是修复者本人（§5.5 修复环）；
 *   · 修复记录声明了 `finding_id`（说不清修的是哪条 finding → 无法与失败 record 的 findings 配对）；
 *   · 账本顺序：修复 seq 必须早于复测 seq（`seq` 由服务端产出，payload 伪造不了）；
 *   · 所有被引用修复记录的 `fix_revision` 一致且非空；不一致/缺失（说不清是哪一版修的）→ 不认。
 *
 * 返回 record 级元数据（含 finding_id / fix_revision / seq），供 `pickCheckRecords` 对**每一条
 * 被解除失败**做严格配对——不只看复测声明的泛化 `fix_refs`。
 */
function verifiedFixFactsOf(
  au: IndependentAuditRecord,
  fixes: Readonly<Record<string, FixRecord>>,
): VerifiedFixFact[] | null {
  if (au.fix_refs.length === 0) return null;
  const out: VerifiedFixFact[] = [];
  const revisions = new Set<string>();
  for (const ref of au.fix_refs) {
    const fix = fixes[ref];
    if (fix === undefined) return null;
    if (fix.evidence_ref === null || fix.evidence_ref.trim() === "") return null;
    if (fix.regression.some((r) => r.exit_code !== 0)) return null;
    if (normActorId(fix.fixed_by) === normActorId(au.auditor)) return null;
    if (typeof fix.seq !== "number" || !(fix.seq < au.seq)) return null;
    const rev = fix.fix_revision.trim();
    if (rev === "") return null;
    const findingId = fix.finding_id.trim();
    if (findingId === "") return null;
    revisions.add(rev);
    out.push({ record_id: fix.record_id, finding_id: findingId, fix_revision: rev, seq: fix.seq });
  }
  if (revisions.size !== 1) return null;
  return out;
}

/**
 * 审计/自检记录 → 检查输入（自检标 `author_self`，独立审计标 `independent`）。
 *
 * 补修 C：**集成检查结果复用这两类既有事件**（不另造存储）。事件里已经带齐
 * 检查 ID（`checks[].check_id`）、目标对象稳定 ID（记录 `task_id`，父级即 `module:<id>`）、
 * 被测版本（记录 `binding`）、范围（`checks[].scope` 与 `not_reported_scope`）、
 * 证据引用（`checks[].evidence_sha256`）与结果（`result` / `conclusion`）；
 * 这里额外把**记录来源**（`record_ref` = 事件实体 id）带出，供 `evidence_basis` 追溯。
 */
export function checksFromAudit(records: AuditRecords): CheckInput[] {
  const out: CheckInput[] = [];
  for (const sc of Object.values(records.self_checks)) {
    for (const c of sc.checks) {
      out.push({
        check_id: c.check_id,
        object_id: sc.task_id ?? "",
        result: sc.conclusion === "pass" ? "passed" : "failed",
        actor_id: sc.checked_by,
        role: sc.role,
        independence: "author_self",
        binding: sc.binding ?? { revision_kind: "plan", revision: "" },
        evidence_sha256: c.evidence_sha256,
        at: sc.at,
        method: c.method,
        scope: [...c.scope],
        record_ref: auditEntityId("audit.self_check_recorded", sc.record_id),
        // V09-01：投影**保留**"这条检查是怎么做的"——没有这两项，投影层结构上看不见
        // 「conclusion=pass 与 exit_code≠0 并存」这条矛盾（G-02 根因②）
        command: c.command,
        exit_code: c.exit_code,
        record_method: sc.record_method,
        verifies: c.verifies,
        audit_independence: null,
      });
    }
  }
  for (const au of Object.values(records.independent_audits)) {
    // 「一记录一哈希」：多项检查共用一个证据哈希（E.3.4-4 如实标注，不当交叉审计证据）
    const distinctHashes = new Set(au.checks.map((c) => c.evidence_sha256));
    const oneHashPerRecord = au.checks.length > 1 && distinctHashes.size === 1;
    // 记录层方法/覆盖（E.3.2 第二档）：既有 227 条没有 per-check `method`，方法信息在这里
    const recordMethod = recordMethodOf({
      coverage: au.coverage.map((c) => ({ area: c.area, status: c.status, basis: c.basis })),
      method_limits: au.method_limits,
    });
    const auditIndependence: AuditIndependenceFacts = {
      record_id: au.record_id,
      same_session_as_author: au.independence.same_session_as_author,
      read_author_summary_first: au.independence.read_author_summary_first,
      one_hash_per_record: oneHashPerRecord,
    };
    // 修复后独立复测闭环：修复事实由**账本**核（`verifiedFixFactsOf`），记录只带引用；
    // 顺序核的是账本 seq，不是可自报的 `at`。facts 为空 = 没有任何可采信的修复事实。
    const fixFacts = verifiedFixFactsOf(au, records.fixes);
    const fixRevision = fixFacts !== null ? fixFacts[0].fix_revision : null;
    for (const c of au.checks) {
      out.push({
        check_id: c.check_id,
        object_id: au.task_id ?? "",
        result: c.result,
        pending: c.pending,
        correction_seq: c.correction_seq,
        human_gate: Object.values(records.acceptances).filter(a=>a.task_id===au.task_id).sort((a,b)=>(b.seq??0)-(a.seq??0))[0],
        correction_refs: [...(au.correction_refs ?? []), ...(c.correction_refs ?? [])],
        actor_id: au.auditor,
        role: au.human_recorded ? "user" : au.auditor_role === "user" ? "auditor" : au.auditor_role,
        independence: "independent",
        binding: au.binding ?? { revision_kind: "plan", revision: "" },
        evidence_sha256: c.evidence_sha256,
        at: au.at,
        // 独立审计记录没有 `command`/`exit_code`（E.3.1 字段形态）⇒ 走第二档：不要求退出码，
        // 也不因缺 per-check `method` 失效——**方法说明来自记录层** `coverage`/`method_limits`，
        // 这里直接带出记录层原文（记录来源在 `record_ref`，不在 method 里塞一句标签冒充方法）
        method: recordMethod,
        scope: [...c.scope, ...au.not_reported_scope.map((s) => `未覆盖:${s}`)],
        record_ref: auditEntityId("audit.independent_audit_recorded", au.record_id),
        // 独立审计记录没有 `command`/`exit_code`（E.3.1 字段形态）⇒ 走第二档：不要求退出码，
        // 也不因缺 per-check `method` 失效（方法在记录层 `coverage`/`method_limits`）
        command: null,
        exit_code: null,
        record_method: recordMethod,
        verifies: null,
        audit_independence: auditIndependence,
        resolves: [...au.resolves],
        fix_refs: [...au.fix_refs],
        fix_revision: fixRevision,
        ledger_seq: au.seq,
        record_findings: [...au.findings],
        verified_fixes: fixFacts,
      });
    }
    // 审计记录本身也是一条检查（覆盖/结论），供"审计过但没逐项列检查"的场景
    out.push({
      check_id: `${au.record_id}::audit`,
      object_id: au.task_id ?? "",
      result: au.conclusion === "pass" ? "passed" : "failed",
      actor_id: au.auditor,
      role: au.auditor_role,
      independence: "independent",
      binding: au.binding ?? { revision_kind: "plan", revision: "" },
      evidence_sha256: au.checks.length > 0 ? null : `audit:${au.record_id}`,
      at: au.at,
      method: `独立审计结论（覆盖 ${au.coverage.filter((c) => c.status === "checked").length} 个视角）`,
      scope: au.not_reported_scope.map((s) => `未覆盖:${s}`),
      record_ref: auditEntityId("audit.independent_audit_recorded", au.record_id),
      command: null,
      exit_code: null,
      record_method: recordMethod,
      verifies: null,
      audit_independence: auditIndependence,
      resolves: [...au.resolves],
      fix_refs: [...au.fix_refs],
      fix_revision: fixRevision,
      ledger_seq: au.seq,
      record_findings: [...au.findings],
      verified_fixes: fixFacts,
    });
  }
  return out;
}

/** 同一 check_id 可能有多条记录（自检 + 独立审计）：取最有力的一条（独立 > 作者自检；同档取最新） */
/** 挑记录用的**有效独立性**（与 `checkEffectiveness` 的降级口径同源，附录 E.3.4）：
 *  ① actor 命中作者集合 ⇒ author_self（比较**写法归一**——作者换个写法（kimi-code／Kimi Code）
 *     就能让自检冒充独立复核的话，降级等于不设防）；
 *  ② 声明与作者同一会话 ⇒ author_self（E.3.4-3：不计入非作者复核）；
 *  ③ 其余按记录声明。
 *  不传 authorIds 时退回声明档（纯函数测试与旧调用方行为逐字不变）。 */
function pickIndependenceOf(c: CheckInput, authorIds?: ReadonlySet<string>): "author_self" | "independent" {
  if (authorIds !== undefined) {
    // 写法归一：大小写/连字符/空白差异都算同一人（"kimi-code"＝"Kimi Code"），
    // 否则作者换个写法就能让自检冒充独立复核，降级等于不设防。
    const norm = (s: string): string => s.toLowerCase().replace(/[^0-9a-z\p{Script=Han}]+/gu, "");
    const actor = norm(c.actor_id);
    if (actor !== "") {
      for (const a of authorIds) {
        if (norm(a) === actor) return "author_self";
      }
    }
  }
  if (c.independence === "independent" && c.audit_independence?.same_session_as_author === true) return "author_self";
  return c.independence;
}

/** 挑记录优先级（传了 revisions 时按现行语义；不传则退回「独立性→时刻」旧口径，纯函数测试行为不变）。
 *  现行语义（§5.6 复验路径 + 附录 E.3.4，逐级往下 first-wins）：
 *   ① 有效独立的**失败**结论永远压住一切——失败不随源漂移失效，作者不许用后来的自检埋掉独立否决；
 *   ② 当前有效（passed）的结论优先代表当前状态，独立优先、同档取最新——
 *      独立「通过」随源漂移失效后，由新的复验结论（哪怕是作者自检）代表当前状态，质量维如实给 mechanical 档；
 *   ③ 都不是当前有效通过时，独立优先、同档取最新（stale/unknown 的理由如实上屏）。
 *  不修这条，一条陈旧的独立「通过」会永远压住其后全部 fresh 复验记录，§5.6 的复验对这类卡永远走不通
 *  （实测：acceptance-backfill 批独立记录绑旧 plan 转 stale 后，20 张卡的 fresh 自检全部上不了屏）。
 *
 *  **修复后独立复测闭环的收窄（2026-10-02）**：①的「有效独立失败」限定为
 *  **未被显式复测闭环解除的**独立失败——`resolvedFailed` 命中的失败不再享 `cls=0` 否决位，
 *  但记录本身仍留在账本/历史里（不抹除、不覆盖）。 */
function pickRank(
  c: CheckInput,
  authorIds: ReadonlySet<string>,
  revisions: SourceRevisions,
  segments: BindingSegmentFacts | null,
  resolvedFailed: ReadonlySet<string> | null = null,
): { cls: number; indep: "author_self" | "independent"; at: string } {
  const indep = pickIndependenceOf(c, authorIds);
  const eff = checkEffectiveness(c, revisions, authorIds, segments).effective;
  const resolved =
    resolvedFailed !== null &&
    c.record_ref !== undefined &&
    resolvedFailed.has(resolutionKey(c.object_id, c.check_id, c.record_ref));
  const cls = !resolved && indep === "independent" && eff === "failed" ? 0 : eff === "passed" ? 1 : 2;
  return { cls, indep, at: c.at };
}

/**
 * 解除判据的身份键：**object_id + check_id + record_ref** 三者齐备才算同一条检查。
 *
 * 为什么必须带 `object_id`：`projectOne` 把 `ownChecks + childChecks` 混在一起挑（父级要看到
 * 子项检查），`check_id` 于是**不是全局唯一**——两个不同任务用同一个 `check_id`（如都写
 * `T02.1::evidence`）时，只按 `check_id` 配对会让 A 任务的复测解除 B 任务的失败（共同解除）。
 * 父/子混合挑选是生产管线的常态，单任务预分组保护不了整条管线，所以键必须在这里带上 object_id。
 */
const resolutionKey = (objectId: string, checkId: string, recordRef: string): string =>
  `${objectId}\u0000${checkId}\u0000${recordRef}`;

export function pickCheckRecords(
  checks: readonly CheckInput[],
  authorIds?: ReadonlySet<string>,
  revisions?: SourceRevisions,
  segments: BindingSegmentFacts | null = null,
): Map<string, CheckInput> {
  // 修复后独立复测闭环（fail-closed 预计算）：解除一条「有效独立失败」必须**同时**满足
  //   ① 同 object_id + 同 check_id（`check_id` 不是全局唯一，见 `resolutionKey`）；
  //   ② `resolves` 显式点名该失败的 record_ref（引用不存在/引用通过记录 → 不解除）；
  //   ③ 严格服务端事件序（账本 seq，payload 伪造不了、payload.seq 不参与）：
  //      **失败.seq < 每个相关修复.seq < 复测.seq**；**不比较可自报的 `occurred_at`**；
  //   ④ 复测方是「有效独立 + 当前有效通过 + 有证据」（复用 `checkEffectiveness`，无第二套判据）；
  //   ⑤ 修复事实（record 级，由 `checksFromAudit` 依账本核出，不接受 caller 自报 fix_revision）：
  //      修复版本须**精确等于**复测 `binding.revision`（同一命名空间；该 binding 已由 ④ 判为当前有效）；
  //   ⑥ finding 覆盖（记录级保守）：被解除失败的 `record_findings` 必须非空，且**每一个** finding
  //      都要有引用修复覆盖（`finding_id` 命中，且修复 seq 落在 失败.seq 与 复测.seq 之间）——
  //      只按复测声明的泛化 `fix_refs` 不算数。
  // 任一不满足即不解除；无 `resolves` 时行为与旧口径逐字节一致。
  let resolvedFailed: ReadonlySet<string> | null = null;
  if (authorIds !== undefined && revisions !== undefined) {
    const failures = new Map<string, CheckInput>();
    for (const c of checks) {
      if (c.record_ref === undefined || c.ledger_seq === undefined) continue;
      const indep = pickIndependenceOf(c, authorIds);
      const eff = checkEffectiveness(c, revisions, authorIds, segments).effective;
      if (indep === "independent" && eff === "failed") {
        failures.set(resolutionKey(c.object_id, c.check_id, c.record_ref), c);
      }
    }
    if (failures.size > 0) {
      const resolved = new Set<string>();
      for (const r of checks) {
        if (r.record_ref === undefined || r.ledger_seq === undefined) continue;
        if (r.resolves === undefined || r.resolves.length === 0) continue;
        // ⑤ 修复事实：record 级核过的修复元数据；没有就一条失败都不解除（不得自报"已验证"）
        const facts = r.verified_fixes ?? null;
        if (facts === null || facts.length === 0) continue;
        // ⑤ 命名空间一致：修复版本必须精确等于复测 binding 的当前修订（不得拿 plan 文档版本冒充代码验证）
        const rev = r.binding.revision;
        if (facts.some((f) => f.fix_revision !== rev)) continue;
        const rindep = pickIndependenceOf(r, authorIds);
        if (rindep !== "independent") continue;
        const reff = checkEffectiveness(r, revisions, authorIds, segments).effective;
        if (reff !== "passed") continue;
        for (const rid of r.resolves) {
          const key = resolutionKey(r.object_id, r.check_id, `audit:${rid}`);
          const failed = failures.get(key);
          if (failed === undefined) continue;
          // ③ 账本顺序：失败的 seq 必须严格早于复测的 seq
          if (!(typeof failed.ledger_seq === "number" && failed.ledger_seq < r.ledger_seq)) continue;
          // ⑥ 失败 findings 非空（历史没记 finding → 无法证明修的就是它 → 保留 failed，不猜）
          const failedFindings = failed.record_findings ?? [];
          if (failedFindings.length === 0) continue;
          // ②③⑤⑥ 每个失败 finding 都要有「同一失败之后、复测之前、版本一致」的引用修复覆盖
          const failedSeq = failed.ledger_seq;
          const passSeq = r.ledger_seq;
          const covered = failedFindings.every((finding) =>
            facts.some(
              (f) =>
                f.finding_id === finding &&
                f.fix_revision === rev &&
                failedSeq < f.seq &&
                f.seq < passSeq,
            ),
          );
          if (!covered) continue;
          resolved.add(key);
        }
      }
      resolvedFailed = resolved;
    }
  }
  const out = new Map<string, CheckInput>();
  for (const c of checks) {
    const prev = out.get(c.check_id);
    if (prev === undefined) {
      out.set(c.check_id, c);
      continue;
    }
    if (authorIds !== undefined && revisions !== undefined) {
      const rc = pickRank(c, authorIds, revisions, segments, resolvedFailed);
      const rp = pickRank(prev, authorIds, revisions, segments, resolvedFailed);
      const win =
        rc.cls < rp.cls ||
        (rc.cls === rp.cls &&
          ((rp.indep === "author_self" && rc.indep === "independent") ||
            (rp.indep === rc.indep && compareIsoTime(rc.at, rp.at) >= 0)));
      if (win) out.set(c.check_id, c);
      continue;
    }
    const cIndep = pickIndependenceOf(c, authorIds);
    const prevIndep = pickIndependenceOf(prev, authorIds);
    if (
      (prevIndep === "author_self" && cIndep === "independent") ||
      // 同档比 `at` **不能比字面钟点**（检查记录的 `at` 来自 `occurred_at`）：
      // `compareIsoTime` 把非法/缺失时间排在有效值之前，所以解析不出来的那条抢不走已有结论；
      // 两条都解析不出来时返回 0（并列）→ 取后提交的那条，稳定可复现。
      (prevIndep === cIndep && compareIsoTime(c.at, prev.at) >= 0)
    ) {
      out.set(c.check_id, c);
    }
  }
  // 人验未做不能被旧pass或作者新自检覆盖；真实后续非作者检查有出口，仍须当前证据有效。
  for (const pending of checks.filter(c => c.result === "not_checked" && c.pending && (c.correction_seq ?? c.ledger_seq) !== undefined)) {
    const pendingSeq = pending.correction_seq ?? pending.ledger_seq!;
    const selected=out.get(pending.check_id);
    if (!selected || selected.object_id !== pending.object_id || selected.result === "failed") continue;
    const gate=selected.human_gate;
    const gateSatisfied=pending.pending?.role!=="user" || (gate?.decision==="accept" && (gate.seq??0)>pendingSeq &&
      gate.task_id===pending.object_id && gate.baseline.plan_revision!=null && gate.baseline.design_revision!=null &&
      gate.baseline.plan_revision===revisions?.plan && gate.baseline.design_revision===revisions?.design);
    const laterPass=gateSatisfied && selected.result === "passed" && selected.role === "user" && (selected.ledger_seq ?? 0)>pendingSeq &&
      pickIndependenceOf(selected,authorIds)==="independent" && revisions !== undefined && checkEffectiveness(selected,revisions,authorIds??new Set(),segments).effective==="passed";
    if(!laterPass && (selected.correction_seq??0)<=pendingSeq) out.set(pending.check_id,pending);
  }
  // 展示追溯：最终上屏的记录若经显式复测闭环解除了失败，把被解除的 record_id 带出
  // （克隆标注，历史记录与事件一字不改；按 object_id+check_id+record_ref 三重命中，不跨界点名）。
  if (resolvedFailed !== null && resolvedFailed.size > 0) {
    for (const [cid, rec] of out) {
      if (rec.record_ref === undefined || rec.resolves === undefined || rec.resolves.length === 0) continue;
      const lifted = rec.resolves.filter((rid) =>
        resolvedFailed.has(resolutionKey(rec.object_id, cid, `audit:${rid}`)),
      );
      if (lifted.length > 0) {
        out.set(cid, { ...rec, resolution_note: [...new Set(lifted)] });
      }
    }
  }
  return out;
}

// ── v1 兼容投影（不迁移项目一个字节都不动；已迁移项目按事实派生四色） ──

export type V1ModuleStatus = "todo" | "doing" | "done" | "issue";

/** v2 主状态 → v1 四色（**有损派生**：诚实状态看 `v2_display_status`，四色只给旧读口） */
export function v1ModuleStatusOf(display: DisplayStatus | null): V1ModuleStatus {
  switch (display) {
    case "planned":
      return "todo";
    case "in_progress":
      return "doing";
    case "pending_verification":
      // 结果交出来了但还没验过 → 旧读口最接近的是"还在做"；绝不记 done（§5.4：四态不能聚合为"已交付"）
      return "doing";
    case "verified":
      return "done";
    case "blocked":
      return "issue";
    case "unknown":
    case null:
      // 未知/不着色不做完成声明：落 todo（旧读口没有"未知"档），并把真状态放进 v2_display_status
      return "todo";
    default:
      return "todo";
  }
}

export interface CompatProgressModule {
  id: string;
  name: string;
  status: V1ModuleStatus;
  v2_display_status: DisplayStatus | null;
  v2_counts: { required: number; passed: number; missing: number };
}

export interface CompatProgressProjection {
  version: 1;
  /** 本文件是派生投影，不是事实源（与 tasks.json 兼容投影同口径） */
  projection_of: string;
  last_seq: number;
  generated_at: string;
  status_semantics: string;
  /** gate 段原样保留（Gate 时间线是既有历史行为，本卡不动它） */
  gate: unknown;
  modules: CompatProgressModule[];
}

export const PROGRESS_PROJECTION_SEMANTICS =
  "本文件是 work/events.jsonl 的状态投影（只读派生，可重放重建），不是事实源；" +
  "modules[].status 是 v1 四色的有损派生，真状态看 v2_display_status（§4.2 六态）";

export interface BuildCompatProgressInput {
  /** 同一模块下的对象投影（按 object_id 归组） */
  modules: { module_id: string; name?: string; projections: StatusProjection[] }[];
  previous: { gate?: unknown };
  last_seq: number;
  generated_at?: string;
}

/** 模块四色 = 该模块下对象投影的最坏态（issue > doing > todo > done 的保守归约） */
export function moduleStatusFromProjections(projections: readonly StatusProjection[]): V1ModuleStatus {
  if (projections.length === 0) return "todo";
  const displays = projections.map((p) => p.display_status);
  if (displays.some((d) => d === "blocked")) return "issue";
  if (displays.some((d) => d === "in_progress")) return "doing";
  if (displays.some((d) => d === "pending_verification" || d === "unknown")) return "doing";
  if (displays.every((d) => d === "verified")) return "done";
  return "todo";
}

export function buildCompatProgressProjection(input: BuildCompatProgressInput): CompatProgressProjection {
  return {
    version: 1,
    projection_of: "work/events.jsonl",
    last_seq: input.last_seq,
    generated_at: input.generated_at ?? new Date().toISOString(),
    status_semantics: PROGRESS_PROJECTION_SEMANTICS,
    gate: input.previous.gate ?? { current_step: "", history: [] },
    modules: input.modules
      .map((m) => {
        const required = m.projections.reduce((n, p) => n + p.required_count, 0);
        const passed = m.projections.reduce((n, p) => n + p.passed_count, 0);
        const missing = m.projections.reduce((n, p) => n + p.missing_count, 0);
        const display = m.projections.length === 1 ? m.projections[0].display_status : null;
        return {
          id: m.module_id,
          name: m.name ?? m.module_id,
          status: moduleStatusFromProjections(m.projections),
          v2_display_status: m.projections.length === 1 ? display : null,
          v2_counts: { required, passed, missing },
        };
      })
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
}

/**
 * 把兼容四色写回 `<root>/.工作台/progress.json`（**只在已迁移项目上**）：
 * 未迁移项目原样返回 `written: false`（v1 写口与 MCP 工具行为逐字不变——这是红线）。
 */
export function writeCompatProgressProjection(
  workDir: string,
  progressFile: string,
  projection: CompatProgressProjection,
  opts: { migrated: boolean },
): { written: boolean; reason: string } {
  if (!opts.migrated) {
    return { written: false, reason: "not_migrated：未迁移项目继续用 v1 四色，本函数一个字节都不写" };
  }
  const prev = fs.existsSync(progressFile)
    ? (JSON.parse(fs.readFileSync(progressFile, "utf8")) as { gate?: unknown })
    : {};
  const next = { ...projection, gate: prev.gate ?? projection.gate };
  fs.mkdirSync(path.dirname(progressFile), { recursive: true });
  const tmp = `${progressFile}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, progressFile);
  return { written: true, reason: "migrated：四色由事实派生（真状态见 v2_display_status）" };
}
