// 逐项工作包（B3/V09-53；DESIGN.md §2.7、§6.7、§6.9、§5.4、§5.6）。
//
// 定位（红线，逐条对 §2.7）：
//   · **只读派生**：不写事件、不存证、不认领、不调模型、不反改 DESIGN/PLAN；零副作用、可删除重建。
//   · **同一事实、同一判据**：逐项 `effective` **只**取自唯一义务/状态派生（`deriveObligations` →
//     `statusProjection.projectStatuses` 产出的 `evidence_basis`/`missing`），**不另算一套通过条件**（§2.6）。
//   · **逐项不用 `DisplayStatus`**：`checks[].effective` 用逐项有效口径（`CheckEffective`）；`DisplayStatus`
//     只作**对象级**主状态（`status`）。
//   · **缺口逐条点名**：`uncovered`/`remaining_checks`/`blocking_findings` 逐条列，**不合并成一句**；
//     没有当前任务时**不按空集合全通过**——明确给缺口。
//   · **两种模式同形**：`direct_tatai`（执行者直连 MCP）与 `coordinator_managed`（协调者代转同形包）
//     同一形态、同一判据；工具不可用**按需具名**标 `unsupported`，**不回退写路由**、不让 worker 猜内部协议。
//   · **稳定身份**：`check_id`/`definition_fingerprint` 来自 `obligations`；重排不换身份、**不按序号继承通过**。
//   · **版本绑定**：`package_revision` 由（设计/施工图/定义/账本末序号/范围版本/**本范围所验行为的源读数**）算出；
//     定义/源/证据一变即变，旧包与旧游标**显式失效**（`REVISION_CHANGED` + 重读入口），**不静默返回跨版本数据**
//     （§2.9/§5.6）。游标另绑定**本次请求**（范围/角色档/接续模式）——不同请求的游标不互用。
//
// 具体工具参数**真实取自现工具 schema**：`known_args` 只用现工具 inputSchema 里真实存在的属性名（且落在
// 该 op 的闭键面内），缺什么点在 `missing_args` 里点名（**绝不回显 claim_token 值，只点名它的参数名**）。
// 工具 schema 的逐字对齐由 `scripts/verify-work-package.ts` 对**真实注册表**断言（本模块不 import mcp 层，
// 避免循环依赖）。

import { sha256Hex } from "./plan";
import { requiredChecksOf, scopeVersionOf, type ObligationSet, type StableCheckDefinition } from "./obligations";
import { packageRevisionOf } from "./featureLedger";
import type { ProjectFacts, StatusProjection } from "./statusProjection";
import type {
  CheckEffective,
  LedgerPaging,
  NextOperation,
  WorkPackage,
  WorkPackageCheck,
} from "../../shared/coverageTypes";

// ────────────────────────── 现工具参数（供 known_args / missing_args；由验证脚本对真实 schema 断言） ──

/**
 * 各工具**真实存在的**参数名（取自 `src/mcp/tools/*.ts` 的 inputSchema.properties）。
 *
 * 「不造字段」的落地方式有两条：① 本模块只从这份表里挑键、绝不自造参数名；②
 * `scripts/verify-work-package.ts` 对**真实注册表**的每个工具断言「本表 ⊆ schema.properties 且
 * schema.required ⊆ 本表」，本表与 schema 一漂移就红。
 */
export const TOOL_PARAM_KEYS: Readonly<Record<string, readonly string[]>> = {
  claim_task: [
    "op",
    "project_id",
    "task_id",
    "role",
    "owner_id",
    "change_id",
    "expected_revision",
    "workspace",
    "lease_ms",
    "attempt",
    "takeover_basis",
    "claim_token",
    "reason",
    "reopen_basis",
    "request_id",
  ],
  submit_task_result: [
    "project_id",
    "task_id",
    "role",
    "owner_id",
    "change_id",
    "claim_token",
    "expected_revision",
    "deliverables",
    "evidence_refs",
    "verification",
    "untested",
    "known_issues",
    "diff_ref",
    "result_revision",
    "runtime_entries",
    "ownership_basis",
  ],
  record_work_evidence: [
    "op",
    "sub_op",
    "project_id",
    "role",
    "actor_id",
    "change_id",
    "occurred_at",
    "kind",
    "content",
    "summary",
    "created_by",
    "binding",
    "source_manifest",
    "source_ref",
    "sha256",
    "record_id",
    "goal",
    "submitted_by",
    "task_id",
    "round",
    "diff_sha256",
    "diff_recovery",
    "changed_files",
    "affected_interfaces",
    "commands",
    "untested",
    "known_issues",
    "requirement_refs",
    "evidence_refs",
    "runtime_entries",
    "baseline",
    "checked_by",
    "checks",
    "conclusion",
    "coverage",
    "method_limits",
    "auditor",
    "auditor_role",
    "author_id",
    "same_session_as_author",
    "read_author_summary_first",
    "model_note",
    "findings",
    "not_reported_scope",
    "resolves",
    "fix_refs",
    "finding_id",
    "fix_revision",
    "fixed_by",
    "evidence_ref",
    "regression",
    "retested_by",
    "retest_evidence",
    "result",
    "rerepro_gone",
    "regression_scope",
    "severity",
    "source",
    "expected",
    "actual",
    "repro",
    "evidence_sha256",
    "affected_revision",
    "object_id",
    "duplicate_of",
    "note",
    "to",
    "reviewer",
  ],
  report_task_status: [
    "project_id",
    "task_id",
    "status",
    "note",
    "title",
    "module_id",
    "reporter",
    "expected_revision",
    "claim_token",
    "owner_id",
    "role",
    "change_id",
    "request_id",
    "reason",
    "readiness_basis",
  ],
};

/**
 * `record_work_evidence` 每个 op 的**真实闭键**（逐字取自 `src/mcp/tools/recordWorkEvidence.ts#OP_KEYS`；
 * `assertToolArgs` 会把闭键外的键**整次拒绝**——所以 `known_args` 绝不能塞该 op 不认识的键）。
 * 由验证脚本对真实 handler 断言：把 `known_args` 原样投给工具 handler，不得因「多键」被拒。
 */
export const RECORD_OP_KEYS: Readonly<Record<string, readonly string[]>> = {
  store: ["op", "project_id", "role", "kind", "content", "summary", "created_by", "binding", "source_ref", "source_manifest", "occurred_at"],
  read: ["op", "project_id", "sha256"],
  submission: ["op", "project_id", "role", "actor_id", "change_id", "occurred_at", "record_id", "goal", "submitted_by", "baseline", "task_id", "round", "diff_sha256", "diff_recovery", "changed_files", "affected_interfaces", "commands", "untested", "known_issues", "requirement_refs", "evidence_refs", "binding", "runtime_entries"],
  self_check: ["op", "project_id", "role", "actor_id", "change_id", "occurred_at", "record_id", "task_id", "round", "checked_by", "checks", "conclusion", "binding", "coverage", "method_limits"],
  independent_audit: ["op", "project_id", "role", "actor_id", "change_id", "occurred_at", "record_id", "task_id", "round", "auditor", "auditor_role", "author_id", "same_session_as_author", "read_author_summary_first", "model_note", "checks", "coverage", "findings", "conclusion", "not_reported_scope", "method_limits", "binding", "resolves", "fix_refs"],
  fix: ["op", "project_id", "role", "actor_id", "change_id", "occurred_at", "record_id", "finding_id", "fix_revision", "fixed_by", "evidence_ref", "regression"],
  retest: ["op", "project_id", "role", "actor_id", "change_id", "occurred_at", "record_id", "finding_id", "fix_revision", "retested_by", "retest_evidence", "result", "rerepro_gone", "regression_scope"],
};

/**
 * 与 `preflight_task_result` / `submit_task_result` **同源**的「锁内特有、预检查不到」的校验类别。
 * 逐条点名、标 `not_checked`——**不假装已核**（§6.11；预备与提交共用同一份纯校验核心，见 submitChecks.ts）。
 * 由验证脚本对 `evaluateSubmitResultChecks(...).not_checked` 的真实现场断言一致。
 */
export const LOCK_IN_NOT_CHECKED: readonly { kind: string; reason: string }[] = [
  {
    kind: "lock_in_recheck",
    reason:
      "预检到提交之间任务版本/认领/持有者/租约/依赖可能变化——提交时在唯一写入服务临界区内按当前事实重核（recheck_on_commit=true）",
  },
  {
    kind: "writer_identity_time_boundary",
    reason: "路由已核当前写者身份（描述符 pid + 令牌），但身份在预检到提交之间可能易主（TOCTOU 由提交侧 assertWriteOwner 兜住）",
  },
  {
    kind: "test_execution_and_coverage",
    reason:
      "工作包/预检只能证明「引用的证据材料可解析/在库/路径存在」，不能证明某项验证真的跑过、退出码真实、覆盖完整或独立审查已做（引用存在 ≠ 内容真实 ≠ 覆盖完整）",
  },
  {
    kind: "external_evidence_refs",
    reason: "带 scheme/绝对路径的外部证据引用在项目之外，塔台没有读它，也不为它的内容背书",
  },
];

// ────────────────────────── 输入 / 输出形态 ──────────────────────────

export type SourceMode = "direct_tatai" | "coordinator_managed";
export type CapabilityClass = "read_only" | "continuable" | "coordination";

/** 认领现场（**不含** `claim_token`：工作包不回显、不外传认领秘密）。 */
export interface WorkPackageOwnership {
  owner_id: string;
  run_id: string;
  attempt_id: string;
  lease_expires_at: string;
  workspace: string;
}

/** 调用方**声明**的能力档位（三档布尔；`effective` 只是归一化结论，具名判断要看这三项）。 */
export interface CapabilityFlags {
  read: boolean;
  continue: boolean;
  coordinate: boolean;
}

/** 工作包的**同一份事实快照**（由 `evaluateProjectEntry` 装配，§2.6）。 */
export interface WorkPackageFactsSnapshot {
  project_id: string;
  data_dir: string;
  /** 本次调用角色（角色名不是安全凭证，§6.5） */
  role: string;
  role_class: string;
  capability: CapabilityClass;
  /** 声明的三档能力（具名判断用；缺省＝只读，与 `capabilityOf` 同口径） */
  capability_flags: CapabilityFlags;
  /** 入口时钟（**不进输出**：保证同事实重复读返回同一包，幂等，§5.4） */
  now: string;
  /** 唯一义务/状态派生结论（同一 facts 快照） */
  obligations: ObligationSet;
  /** 同一份 `ProjectFacts`（任务状态/定义/基线/修订） */
  facts: ProjectFacts;
  baseline: { design_revision: string | null; plan_revision: string | null; baseline_id: string | null };
  /** 当前动作指向的任务（null = 没有当前任务） */
  task_id: string | null;
  /** 该任务的变更批次（scope_id 的稳定来源；未定 ⇒ null，不猜） */
  change_id: string | null;
  source_mode: SourceMode;
  /** 入口已定的下一动作（**原样带出，不重算**；`direct_tatai`/`coordinator_managed` 同值） */
  next_action: string;
  /** 该下一动作由哪个角色推进（入口已定；不重算；无从得知 = null） */
  next_action_role: string | null;
  ownership: WorkPackageOwnership | null;
}

/** 范围身份（`scope_revision` 走**唯一算法** `scopeVersionOf`，见 `scopeRevisionForWorkPackage`）。 */
export interface WorkPackageScope {
  scope_id: string | null;
}

export interface WorkPackageBuildOptions {
  /** 分页：每页 check 条数（1..200；缺省 200） */
  limit?: number;
  /** 分页游标（**绑定 package_revision 与本次请求**；跨版本/跨请求 ⇒ 显式 `REVISION_CHANGED`） */
  cursor?: string;
  /** 直接给偏移（测试/内部用；与 cursor 二选一） */
  offset?: number;
  /**
   * 调用方持有的 `package_revision`（可选）：不符 ⇒ 显式 `REVISION_CHANGED`（与功能清单读口的
   * `expected_revision` 同口径，§2.9/§6.11）。这是**与工具入口真实相连**的参数，不是纯函数摆设。
   */
  expected_revision?: string;
}

/** 工作包的**附加（兼容扩展）字段**：契约字段一字不动，这里只作如实标注。 */
export interface WorkPackageExtras {
  schema: "work-package/1";
  /** 本包为哪个角色派生（只作追溯；逐项 `next_operation` 的动作角色另按操作定，两模式同形） */
  caller_role: string;
  /** 调用方/宿主**具名**不具备的工具或工具能力（**显式**标注，绝不回退写路由；§2.7/§6.11） */
  unsupported: { tool: string; operation: string; reason: string }[];
  /** 与预检同源：锁内特有、工作包/预检查不到的校验（逐条点名，不假装已核） */
  lock_in_not_checked: { kind: string; reason: string }[];
  /** 旧客户端提示：不识别 `work_package` 的调用方**不具备完整接续能力**（§2.7） */
  legacy_client_note: string;
}

export type WorkPackageFull = WorkPackage & WorkPackageExtras;

/** 工作包**显式失效/拒收**（旧游标/旧包版本/入参非法）：给重读入口，**不静默返回跨版本数据**。 */
export interface WorkPackageFailure {
  ok: false;
  code: "REVISION_CHANGED" | "INVALID_INPUT";
  message: string;
  current_revision?: string;
  next_read: string;
}

export type WorkPackageBuildResult = { ok: true; work_package: WorkPackageFull } | WorkPackageFailure;

const LEGACY_CLIENT_NOTE =
  "本包是**兼容扩展**：`work_package` 为新增字段，旧调用方拿不到它——" +
  "旧字段（next_action/reasons/required_reads/current_runs/ownership…）逐字保留可用，但**不具备完整接续能力**；" +
  "不识别本字段的客户端应如实提示「接续不完整」，**不**回退旧写路径、也不在本地另算一套判据（DESIGN.md §2.7/§6.6）。";

export const WORK_PACKAGE_LIMIT_MAX = 200;
const DEFAULT_LIMIT = WORK_PACKAGE_LIMIT_MAX;

// ────────────────────────── 范围版本 ──────────────────────────

/**
 * `scope_revision` = **成员与检查定义**的版本。**唯一算法**是义务层的 `scopeVersionOf`
 * （`src/server/work/obligations.ts`；六图 / `feature_ledger` / 工作包共用**同一处**，B5 复审实测：
 * 两处各写一套就会出现"同一 scope 同版本串不同值"，跨接口对不上账）。本模块**不再自带第二套 hash**
 * ——自带一套会在受检源码变、check 定义重排等场景与六图/功能清单分叉。
 *
 * **范围边界（单卡 vs 跨卡）明确**：工作包是**逐任务**的（`snapshot.task_id`），本函数按**单卡范围**派生
 * ——成员恒为该卡自身（`member_task_ids=[task_id]`）、检查用该卡定义；`scope_id` 只是**批次标签**
 * （change/批次归属），**不**把同批次的其他卡并进来。跨卡功能范围的成员＋检查由声明区给出，
 * 走 `feature_ledger`/六图的 `cap-loop-*` 路径（那里的 `member_task_ids` 是多卡）。因此同一批次下
 * 两张卡各自的 `scope_revision` **不同**，不会互相冒充；重排检查、只改派生状态/勾选位/备注都不改版本，
 * 稳定 check 身份或定义指纹一变即变（§2.5.1/§2.9）。
 */
export function scopeRevisionForWorkPackage(
  scope: WorkPackageScope,
  taskId: string | null,
  defs: readonly StableCheckDefinition[],
  taskChecks: Record<string, StableCheckDefinition[]>,
): string {
  return scopeVersionOf({
    scope_id: scope.scope_id ?? taskId ?? "",
    member_task_ids: taskId === null ? [] : [taskId],
    required_check_ids: defs.map((d) => d.check_id),
    integration_check_ids: [],
    task_checks: taskChecks,
  }).scope_revision;
}

// ────────────────────────── 请求游标（绑定包版本 + 本次请求） ──────────────────────────

interface WorkPackageCursorBody {
  v: 1;
  package_revision: string;
  /** 本次请求的身份摘要（范围 + 接续模式 + 调用方角色档）：不同请求**不互用**游标 */
  request_key: string;
  offset: number;
}

const encodeWpCursor = (body: WorkPackageCursorBody): string =>
  Buffer.from(JSON.stringify(body), "utf8").toString("base64url");

const decodeWpCursor = (cursor: string): WorkPackageCursorBody | null => {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as WorkPackageCursorBody;
    if (parsed.v !== 1 || typeof parsed.package_revision !== "string" || typeof parsed.request_key !== "string" || !Number.isInteger(parsed.offset)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
};

const requestKeyOf = (snapshot: WorkPackageFactsSnapshot, scope: WorkPackageScope): string =>
  sha256Hex(
    JSON.stringify({
      scope_id: scope.scope_id,
      source_mode: snapshot.source_mode,
      role_class: snapshot.role_class,
      capability: snapshot.capability,
    }),
  );

// ────────────────────────── 逐项派生 ──────────────────────────

/** 一个任务对象的逐项结果（同一判据：`statusProjection` 的 `evidence_basis` / `missing`）。 */
function projectionOf(snapshot: WorkPackageFactsSnapshot, taskId: string): StatusProjection | null {
  return snapshot.obligations.projection.by_id[taskId] ?? null;
}

interface CheckBasis {
  pending?: import("./auditCorrection").PendingHuman;
  effective: CheckEffective;
  evidence_sha256: string | null;
  bound_revision: string | null;
  independence: "author_self" | "independent";
  /** 记录作者（供独立审计点名 `author_id`；没有记录为 null） */
  author_id: string | null;
  /** 本范围所验行为的源清单**现读**读数（§5.6 命中判定只认 source_manifest；没有清单 = null） */
  manifest: { status: "valid" | "invalidated" | "unreadable"; changed: string[]; missing: string[]; unreadable: string[]; reason: string } | null;
  changed_paths: string[];
  uncovered: string[];
  why: string;
  /**
   * 本对象**在册未收口的缺陷**（`proj.open_findings`，同一份 canonical 事实）。
   * 用于失败项的前置判定（B3-REVIEW-WATCH 11:36 第 3 项）：**未修的失败不该直接要求非作者复测同一缺陷**
   * ——先给修复路径或明确前置（没有在册缺陷就先登记缺陷，再修，再复测）。
   */
  open_findings: { finding_id: string; status: string }[];
  /**
   * 已有修复记录、**等复测**的缺陷 id（`fixed_pending_retest` 或已落 `audit.fix_recorded`）：
   * 非空 ⇒ 复测轮到非作者；null ⇒ 下一步是**修复**（不该要求复测未修的缺陷）。
   */
  retest_finding_id: string | null;
}

/**
 * 一条 check 在当前事实下的逐项结果。**只读 `projection`**（唯一绿公式的产物），不另判通过。
 * 没记录 ⇒ `missing`；有记录按复核后的 `effective`（passed/failed/stale/unknown）。
 */
function checkBasis(proj: StatusProjection | null, def: StableCheckDefinition, facts: ProjectFacts | null = null): CheckBasis {
  const basis = proj?.evidence_basis.find((b) => b.check_id === def.check_id) ?? null;
  const reason = proj?.missing.find((m) => m.check_id === def.check_id)?.why ?? null;
  const objFindings = (proj?.open_findings ?? []).map((f) => ({ finding_id: f.finding_id, status: String(f.status) }));
  // 「修复已落，等复测」的两个真实信号（都只读 canonical 事实，不自报）：
  //   ① 缺陷状态已推进到 `fixed_pending_retest`；② 已有针对该在册缺陷的修复记录（`audit.fix_recorded`）。
  // 只看状态会漏掉「修复记录已落、状态未单独推进」的常态路径 —— 那会退化成重复派修复。
  const fixedFindingIds = new Set(Object.values(facts?.audit.fixes ?? {}).map((f) => f.finding_id));
  const retestFindingId = objFindings.find((f) => f.status === "fixed_pending_retest" || fixedFindingIds.has(f.finding_id))?.finding_id ?? null;
  if (basis === null) {
    return {
      effective: "missing",
      evidence_sha256: null,
      bound_revision: null,
      independence: "author_self",
      author_id: null,
      manifest: null,
      changed_paths: [],
      uncovered: reason !== null ? [reason] : ["没有任何检查记录"],
      why: reason ?? "没有任何检查记录：结果提交不等于验证通过（缺哪项说哪项）",
      open_findings: objFindings,
      retest_finding_id: retestFindingId,
    };
  }
  const manifest = basis.source_manifest;
  // V09-53（B3 复审）：源清单的 **changed/missing/unreadable 都算缺口**，不只 changed——
  // 「声明存在但读不到/读不动」同样是本范围所验行为的不确定项，不能只列 changed 就当无事。
  const manifestGaps =
    manifest === null
      ? []
      : [...manifest.changed, ...manifest.missing, ...manifest.unreadable];
  const uncovered = [
    ...basis.scope.filter((s) => s.startsWith("未覆盖:")).map((s) => s.slice("未覆盖:".length)),
    ...(manifest !== null && manifest.changed.length > 0 ? manifest.changed.map((p) => `源已变待复验：${p}`) : []),
    ...(manifest !== null && manifest.missing.length > 0 ? manifest.missing.map((p) => `源清单缺文件：${p}`) : []),
    ...(manifest !== null && manifest.unreadable.length > 0 ? manifest.unreadable.map((p) => `源清单读不动：${p}`) : []),
    ...(manifest !== null && manifest.status !== "valid" && manifest.reason !== "" ? [`源清单复核：${manifest.reason}`] : []),
  ];
  return {
    effective: basis.effective,
    pending: basis.pending,
    evidence_sha256: basis.evidence_sha256,
    bound_revision: basis.bound_revision.revision === "" ? null : basis.bound_revision.revision,
    independence: basis.independence,
    author_id: basis.actor_id === "" ? null : basis.actor_id,
    manifest,
    changed_paths: [...new Set(manifestGaps)],
    uncovered,
    why: reason ?? "",
    open_findings: objFindings,
    retest_finding_id: retestFindingId,
  };
}

/**
 * `record_work_evidence` 某 op 的已给参数（只挑该 op 真实认识的键），以及还缺哪些必填。
 *
 * `missing_args` 只列**无条件必填**现场参数；**条件项**（机械检查才要 `command`+`exit_code`、第二档
 * 证据或方法二选一）不进这里，写进只读 `prerequisites`/`guidance`——那两项**不是工具参数**，
 * 绝不并入 `known_args`（B3-REVIEW-WATCH 12:40 第 2 项）。
 */
function evidenceOpArgs(
  op: string,
  known: Record<string, unknown>,
  missing: readonly string[],
  readOnly: { prerequisites?: readonly string[]; guidance?: readonly string[] } = {},
): NextOperation {
  const allowed = new Set(RECORD_OP_KEYS[op] ?? []);
  const knownArgs: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(known)) {
    if (v !== undefined && v !== null && allowed.has(k)) knownArgs[k] = v;
  }
  return {
    tool: "record_work_evidence",
    operation: op,
    known_args: knownArgs,
    missing_args: [...missing],
    ...(readOnly.prerequisites === undefined ? {} : { prerequisites: [...readOnly.prerequisites] }),
    ...(readOnly.guidance === undefined ? {} : { guidance: [...readOnly.guidance] }),
  };
}

// ────────────────────────── 只读证据前置/判据（进工作包，不进工具参数） ──────────────────────────
//
// B3-REVIEW-WATCH 12:35/12:40：真实新会话执行者按 code 绑定拿普通运行日志当证据，写侧受理而读侧 unknown，
// 只能读 `statusProjection.ts` 内部实现才知道要 `source_manifest` 载体——**交接摩擦**。修法不是再写注释：
// 把这些**前置与判据**放进返回的工作包（`next_operation.prerequisites/guidance`），新会话只读工作包即可执行。
// 作者自检与独立审计**同一链路**，故两处共用同一份前置；五维/读序是独审特有，另附。

/** 代码检查的**证据前置**（作者自检与独立审计共用；有序、可执行、不预填结论）。 */
const CODE_EVIDENCE_PREREQUISITES: readonly string[] = [
  "若本检查验的是代码：**先真实跑验证**（实跑命令与输出原文自己留档），再调 " +
    "`record_work_evidence(op=\"store\", kind=\"source_manifest\", …)` 落**覆盖源清单**载体——必填 " +
    "`project_id`/`role`/`kind`/`summary`/`binding`（`{revision_kind:\"code\", revision:<源指纹>}`），" +
    "`content` 放本次实跑命令与输出原文、" +
    "`source_manifest` 给本次验证真正依赖的源文件相对路径——**文件范围由你按本卡文件责任决定**，" +
    "不预喂清单、也不要求读完整个仓库。",
  "取回回执后**照它回填**：`evidence.sha256` → 本次 `checks[].evidence_sha256`；" +
    "`evidence.source_manifest.fingerprint` → 记录 `binding.revision`（`revision_kind=\"code\"`）。",
  "然后才落 `op=\"self_check\"`（作者）／`op=\"independent_audit\"`（非作者）：**用上面两项回填**——" +
    "作者与独审**同一链路**，不要把普通运行日志本身当证据哈希（它不带覆盖源清单）。",
];

/** 代码检查的**判据说明**：为什么读侧 unknown、机械/非机械怎么走。 */
const CODE_EVIDENCE_GUIDANCE: readonly string[] = [
  "只把普通运行日志当证据时**不带覆盖源清单**：读侧无法现读复核被验源码，该检查记 `unknown`、**不采信**——" +
    "这不是让你去读产品实现，补一条带上 `source_manifest` 的载体即可（见前置）。",
  "**第二档**（证据或方法至少一项，二选一）：`checks[].evidence_sha256`（本次证据载体 sha256，代码检查就是 " +
    "`store(kind=source_manifest)` 的 `evidence.sha256`）**或** `checks[].method`（本次实跑方法说明）。",
  "**第一档**（只对机械检查）：真给了 `checks[].command` 才必须 `checks[].exit_code`（且须为 0）；" +
    "**非机械检查不给 `command`**，走第二档即可——**不要为凑第一档编造命令**。",
];

/** 独审特有的读序与五维覆盖**含义**（只给含义，不替 Agent 填结论）。 */
const AUDIT_GUIDANCE: readonly string[] = [
  "读序：**先独立实测**（自己读设计/施工图与交付源码、自写脚本实跑），**后**取作者材料；" +
    "`read_author_summary_first`/`same_session_as_author` 如实声明（同会话声明按附录 E.3.4 降级，不当交叉审计证据）。",
  "`coverage` 是**五维覆盖矩阵**：`behavior_boundaries`/`interface_integration`/`data_concurrency`/" +
    "`trust_permission`/`failure_recovery`——逐维给依据或标不适用；`method_limits` 如实写方法限制（§5.5）。" +
    "**维度含义给到这里，结论由审计者下**（本包不预填）。",
];

/**
 * 本 check 现在该由谁、用什么操作推进（缺口逐条点名在 `next_operation.missing_args`）。
 *
 * 依「这条检查现在是什么状态」列**真实可执行**的下一步（§5.4 逐项采信；B3-REVIEW-WATCH 第 1 项）：
 *   · 已通过且独立义务满足 → 无待办；
 *   · 已通过但 `independence_required` 只有作者自检 → **非作者**独立审计（不让作者自检冒充独审）；
 *   · `missing`/`stale`/`unknown` 且需独审 → 非作者独立审计；不需独审 → 作者重跑并存自检；
 *   · `failed`：**先修**——缺陷还没到「等复测」就先给修复路径（没有在册缺陷就连 `finding_id` 一起点名）；
 *     修复已落（缺陷 `fixed_pending_retest`）后：独立审计的失败 → **非作者复测**，自检的失败 → 作者重跑自检；
 * 不再一律推 `submit_task_result`（那是**整卡提交**，不是单条检查的下一步）。
 *
 * `known_args.role` 是**该操作的动作角色**（executor / auditor），**不是调用方角色**——这样
 * `direct_tatai` 与 `coordinator_managed` 两种模式下逐项材料**逐字同形同判据**（§2.7 两模式同形）。
 *
 * 参数面（B3-REVIEW-WATCH 11:36 第 4 项）：**能从快照取到的真给**（本 check 的稳定 `check_id` 组成
 * `checks[]` 骨架、已登记的 `finding_id`、能取到的 `author_id`）；只有**现场才能产**的才点名——用
 * `checks[].xxx` 下标记法，**基键仍是工具真实认识的 `checks`**，不造工具不认识的字段，也不替人做验证结论。
 *
 * `missing_args` 只列**无条件必填**现场参数（接手者不必试错读内部源码就知道要补哪些字段）：
 *   · 作者自检：`record_id`/`conclusion`/`binding` ＋ `checks[].verifies`（写侧彩排闸强制，E.3.3）；
 *   · 独立审计：`record_id`/`auditor`/`conclusion`/`coverage`（五维覆盖矩阵，§5.5）＋ 能取到就给的
 *     `author_id`（取不到才列缺）＋ 独审**读序/独立性现场声明** `read_author_summary_first`/
 *     `same_session_as_author`。
 *
 * **条件项不列进 `missing_args`，进只读 `prerequisites`/`guidance`**（B3-REVIEW-WATCH 12:40）：
 *   · **证据前置**（作者自检与独审共用）：代码检查**先真实跑验证**→ `store(kind=source_manifest)` 落覆盖
 *     源清单（文件范围由 Agent 按本卡文件责任决定）→ 用回执的 `evidence.sha256` 填 `checks[].evidence_sha256`、
 *     `source_manifest.fingerprint` 填 `binding.revision`；并解释「普通运行日志不带源清单 ⇒ 读侧 unknown」；
 *   · **第二档**（`checks[].evidence_sha256` 或 `checks[].method`）是**二选一**；
 *   · **第一档**（`checks[].command`/`checks[].exit_code`=0）**只对机械检查**——非机械走第二档，不逼编命令；
 *   · 独审另附读序（先独立实测、后取作者材料）与五维覆盖**含义**（只给含义，结论由审计者下）。
 * 这些字段与 `known_args` 并列、**不进工具参数**（`evidenceOpArgs` 只从该 op 闭键里挑 `known_args`）。
 * 判据与会话前后端**同一份**：字段名一律取自真实工具参数面（见 `RECORD_OP_KEYS`／schema），
 * 必填来源为 handler 的缺参校验与写侧彩排闸（E.3.2/E.3.3/§5.5）。
 */
function nextOperationOf(input: {
  def: StableCheckDefinition;
  basis: CheckBasis;
  projectId: string;
  taskId: string | null;
  changeId: string | null;
}): { responsible_role: string; next_operation: NextOperation } {
  const { def, basis } = input;
  const env: Record<string, unknown> = { project_id: input.projectId, change_id: input.changeId ?? undefined, task_id: input.taskId ?? undefined };

  const none = (): { responsible_role: string; next_operation: NextOperation } => ({
    responsible_role: "coordinator",
    next_operation: { tool: "", operation: "", known_args: {}, missing_args: [] },
  });

  const needsIndependent = def.independence_required && basis.independence !== "independent";
  if (basis.effective === "not_checked" && basis.pending) {
    return { responsible_role: basis.pending.role, next_operation: {
      tool: "", operation: "await_human", known_args: {}, missing_args: [],
      guidance: [`${basis.pending.reason}；依据：${basis.pending.basis}。必需项保留，Agent不得代验或代签。真人录入见 docs/audit-recovery.md；用户Gate另走现有验收页。`],
    } };
  }

  // B3-REVIEW-WATCH 11:36 第 4 项：能把**这一条检查**的身份与形状从快照取到的就**真给**——`checks[]` 里
  // 直接带上本 check 的稳定 `check_id`（不是留空让接手者猜是哪一条）；只有**现场才能产**的（这次跑的
  // 方法、这次产生的证据哈希）才列进 `missing_args`（用 `checks[]....` 下标记法，基键仍是真实参数名
  // `checks`——不造工具不认识的字段）。不替人做验证结论，也不把 `checks` 整体留空。
  const checkScaffold = [{ check_id: def.check_id }];
  // 独审没有 `command`/`exit_code`（E.3.1 字段形态，走记录层 `coverage`/`method_limits` 第二档）；
  // `checks[].verifies` 在独审形态下写侧彩排闸也不强制（不虚报必填）。条件是：**第二档的
  // "证据或方法"是二选一**——一律写进只读 `guidance`，不列进 `missing_args`。
  //
  // 无条件必填（追到 handler 缺参校验＋写侧彩排闸 E.3.2/E.3.3）：
  //   · 作者自检：`record_id`/`conclusion`/`binding`（通过记录必须绑与被验对象相符的修订）＋
  //     `checks[].verifies`（新写入的通过检查必填，E.3.3）——`checks[].evidence_sha256` 与
  //     `checks[].method` 是**二选一**，`checks[].command`/`checks[].exit_code` 是**只对机械检查**的条件项，
  //     三者都**不**列进 `missing_args`（`command`/`exit_code` 曾被当所有自检必填，违反 B4 无 command 走
  //     method/coverage 的既定合同——B3-REVIEW-WATCH 12:40 第 2 项），改由只读 `guidance` 给条件组；
  //   · 独立审计：`record_id`/`auditor`/`conclusion`/`coverage`＋读序/独立性声明 `read_author_summary_first`/
  //     `same_session_as_author`（能取到的 `author_id` 真给，取不到才列缺）。
  // 证据形态（代码检查的 `binding`＝revision_kind=code 的源码指纹、`checks[].evidence_sha256`＝源清单
  // `evidence.sha256`）由**同一条前置链路**给出（先 `store(kind=source_manifest)` 取回再回填）——见
  // `CODE_EVIDENCE_PREREQUISITES`；作者与独审共用同一份，不再各写一套、也不靠源码注释。
  //
  // 独审下一步（两处共用）：能从快照取到的 `author_id` 真给；取不到才列进 `missing_args`（handler 必填，
  // 漏列会让接手者撞一次 `缺入参 author_id` 才回头读源码）。`coverage` = 五维覆盖矩阵（§5.5，必填）；
  // 独审**读序/独立性现场声明**（审计者本人才能答，快照取不到）逐条点名。
  const independentAudit = (): NextOperation =>
    evidenceOpArgs(
      "independent_audit",
      { op: "independent_audit", role: "auditor", ...env, author_id: basis.author_id ?? undefined, checks: checkScaffold },
      [
        "record_id",
        "auditor",
        ...(basis.author_id === null ? ["author_id"] : []),
        "conclusion",
        "coverage",
        "read_author_summary_first",
        "same_session_as_author",
      ],
      { prerequisites: CODE_EVIDENCE_PREREQUISITES, guidance: [...CODE_EVIDENCE_GUIDANCE, ...AUDIT_GUIDANCE] },
    );

  if (basis.effective === "passed") {
    // 通过项靠作者自检撑着 → 需**非作者**复核（author≠auditor，§5.8）
    if (needsIndependent) {
      return { responsible_role: "auditor", next_operation: independentAudit() };
    }
    return none();
  }

  // 未生效通过（missing/failed/stale/unknown）
  if (basis.effective === "failed") {
    // B3-REVIEW-WATCH 11:36 第 3 项：**未修的失败不直接派复测**——先给修复路径或明确前置。
    // 判据只读 canonical 事实（`proj.open_findings` 的**在册状态**）：缺陷到 `fixed_pending_retest`
    // 才轮到非作者复测；否则下一步是修复（没有在册缺陷就连 `finding_id` 一起点名——先登记缺陷再修）。
    if (basis.retest_finding_id === null) {
      const knownFinding = basis.open_findings[0]?.finding_id;
      return {
        responsible_role: "executor",
        next_operation: evidenceOpArgs(
          "fix",
          { op: "fix", role: "executor", ...env, ...(knownFinding === undefined ? {} : { finding_id: knownFinding }) },
          knownFinding === undefined
            ? ["record_id", "finding_id", "fix_revision", "fixed_by", "evidence_ref"]
            : ["record_id", "fix_revision", "fixed_by", "evidence_ref"],
        ),
      };
    }
    if (basis.independence === "independent") {
      // 非作者审计已判定失败、且修复已落：修复**不自动关闭**，须由非作者**复测**后才恢复（§5.6；附录 E.3.6）。
      // 等复测的缺陷 id 从快照**真给**（缺了才列进 missing_args）。
      return {
        responsible_role: "auditor",
        next_operation: evidenceOpArgs(
          "retest",
          { op: "retest", role: "auditor", ...env, finding_id: basis.retest_finding_id },
          basis.retest_finding_id === null
            ? ["record_id", "finding_id", "retest_evidence", "result"]
            : ["record_id", "retest_evidence", "result"],
        ),
      };
    }
  }
  if (def.independence_required) {
    // 独审必需的检查缺失/失效：**先派非作者独立审计**，不让作者自检冒充（B3-REVIEW-WATCH 第 1 项）
    return { responsible_role: "auditor", next_operation: independentAudit() };
  }
  // 作者自持的检查（missing/stale/unknown/failed）：执行验证 → 记录自检，并把证据/源清单存证。
  // `missing_args` 只列**无条件必填**；机械命令/第二档证据的条件组走只读 `guidance`（见上注释）。
  return {
    responsible_role: "executor",
    next_operation: evidenceOpArgs(
      "self_check",
      { op: "self_check", role: "executor", ...env, checks: checkScaffold },
      ["record_id", "conclusion", "binding", "checks[].verifies"],
      { prerequisites: CODE_EVIDENCE_PREREQUISITES, guidance: CODE_EVIDENCE_GUIDANCE },
    ),
  };
}

// ────────────────────────── 主入口 ──────────────────────────

/**
 * 由**同一份事实快照**派生逐项工作包（`buildWorkPackage(factsSnapshot, scope, role)`，§2.7）。
 * **只读、零写入、可删除重建**；同事实重复读返回同一包（无时间戳字段 ⇒ 字节一致，幂等）。
 */
export function buildWorkPackage(
  snapshot: WorkPackageFactsSnapshot,
  scope: WorkPackageScope,
  role: string,
  options: WorkPackageBuildOptions = {},
): WorkPackageBuildResult {
  const taskId = snapshot.task_id;
  const defs = taskId === null ? [] : requiredChecksOf(snapshot.obligations, taskId);
  const proj = taskId === null ? null : projectionOf(snapshot, taskId);
  const scopeRevision = scopeRevisionForWorkPackage(scope, taskId, defs, snapshot.obligations.task_checks);

  // 包版本绑定**当前读到的**来源修订（设计/施工图内容变 ⇒ 包版本变 ⇒ 旧包/旧游标显式失效，§2.9/§5.6）；
  // 生效基线读数另由顶层 `baseline` 字段如实报告（两者不混）。
  const design = snapshot.facts.revisions.design ?? snapshot.baseline.design_revision ?? null;
  const plan = snapshot.facts.revisions.plan ?? snapshot.baseline.plan_revision ?? null;
  const planDefinition = snapshot.facts.revisions.plan_definition ?? null;
  // 先算逐项依据（包版本要用到「本范围所验行为的源读数」）
  const bases = defs.map((def) => ({ def, basis: checkBasis(proj, def, snapshot.facts) }));
  // V09-53（B3 复审第 5 项）：包版本还要绑定**本范围所验行为的有限源读数**——相关源码改了但**没有新事件**时，
  // 这份读数会变 ⇒ 旧包/旧游标失效；与范围无关的文件变动不进这份摘要（**不连坐**，§5.6）。
  const sourceReadings = sha256Hex(
    JSON.stringify(
      bases
        .map(({ def, basis }) => ({
          check_id: def.check_id,
          status: basis.manifest?.status ?? null,
          changed: [...(basis.manifest?.changed ?? [])].sort(),
          missing: [...(basis.manifest?.missing ?? [])].sort(),
          unreadable: [...(basis.manifest?.unreadable ?? [])].sort(),
        }))
        .sort((a, b) => a.check_id.localeCompare(b.check_id)),
    ),
  );
  const packageRevision = packageRevisionOf({
    design,
    plan,
    plan_definition: planDefinition,
    ledger_last_seq: snapshot.facts.last_seq,
    scope_id: scope.scope_id,
    scope_revision: scopeRevision,
    // 工作包不带「已登记产物选择」：与功能清单读口同口径给 null（切换 artifact_ref 才换包版本身份）
    artifact_ref: null,
    source_readings: sourceReadings,
  });

  // ── 调用方持有的包版本（expected_revision，与工具入口真实相连，§2.9/§6.11） ──
  if (options.expected_revision !== undefined && options.expected_revision !== packageRevision) {
    return {
      ok: false,
      code: "REVISION_CHANGED",
      message:
        "调用方持有的 package_revision 与当前不一致（定义/源/证据已变）：旧包显式失效，" +
        "**不静默返回跨版本数据**（DESIGN.md §2.9/§5.6）",
      current_revision: packageRevision,
      next_read: "不带 expected_revision 重新取整包（package_revision=" + packageRevision.slice(0, 12) + "…）",
    };
  }

  // ── 分页（游标**绑定 package_revision 与本次请求**；跨版本/跨请求 ⇒ 显式失效） ──
  const limit = options.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > WORK_PACKAGE_LIMIT_MAX) {
    return {
      ok: false,
      code: "INVALID_INPUT",
      message: `limit 必须是 1..${WORK_PACKAGE_LIMIT_MAX} 的整数（收到 ${JSON.stringify(options.limit)}）`,
      next_read: "不带 limit 重取整包，或给 1..200",
    };
  }
  const requestKey = requestKeyOf(snapshot, scope);
  let offset = options.offset ?? 0;
  if (options.cursor !== undefined) {
    const body = decodeWpCursor(options.cursor);
    if (body === null) {
      return { ok: false, code: "INVALID_INPUT", message: "cursor 形态非法（不可解析）", next_read: "不带 cursor 重取第一页" };
    }
    if (body.package_revision !== packageRevision) {
      return {
        ok: false,
        code: "REVISION_CHANGED",
        message:
          "旧游标绑定的包版本与当前不一致（定义/源/证据已变）：**不静默返回跨版本数据**，" +
          "旧包与旧游标显式失效（DESIGN.md §2.9/§5.6/§5.4）",
        current_revision: packageRevision,
        next_read: "不带 cursor 重新取整包（package_revision=" + packageRevision.slice(0, 12) + "…）",
      };
    }
    if (body.request_key !== requestKey) {
      return {
        ok: false,
        code: "REVISION_CHANGED",
        message:
          "旧游标是**另一个请求**（范围/接续模式/角色档不同）发的：不同请求的游标不互用（DESIGN.md §2.9）",
        current_revision: packageRevision,
        next_read: "用本次请求自己的游标，或不带 cursor 重取第一页",
      };
    }
    offset = body.offset;
  }
  if (!Number.isInteger(offset) || offset < 0) {
    return { ok: false, code: "INVALID_INPUT", message: `offset 非法：${JSON.stringify(options.offset)}`, next_read: "去掉 offset/cursor 重取" };
  }

  const taskRevision = taskId === null ? null : (snapshot.facts.task_states[taskId]?.revision ?? null);

  const allChecks: WorkPackageCheck[] = bases.map(({ def, basis }) => {
    const { responsible_role, next_operation } = nextOperationOf({
      def,
      basis,
      projectId: snapshot.project_id,
      taskId,
      changeId: snapshot.change_id,
    });
    return {
      check_id: def.check_id,
      definition_fingerprint: def.definition_fingerprint,
      requirement: def.label,
      required: def.required,
      independence_required: def.independence_required,
      effective: basis.effective,
      evidence_refs: basis.evidence_sha256 === null ? [] : [basis.evidence_sha256],
      verified_binding: basis.bound_revision,
      changed_paths: [...basis.changed_paths],
      uncovered: [...new Set([...basis.uncovered, ...(basis.why === "" ? [] : [basis.why])])],
      responsible_role,
      next_operation,
    };
  });

  const page = allChecks.slice(offset, offset + limit);
  const complete = offset + limit >= allChecks.length;
  const paging: LedgerPaging = complete
    ? { complete: true, cursor: null }
    : { complete: false, cursor: encodeWpCursor({ v: 1, package_revision: packageRevision, request_key: requestKey, offset: offset + limit }) };

  // ── 完成度（**只消费 canonical 技术完成口径**；缺口逐条点名；无任务**不按空集全通过**） ──
  const remaining = allChecks.filter((c) => c.effective !== "passed").map((c) => c.check_id);
  // 独审义务未满足（通过但只有作者自检）：canonical 绿不覆盖它，技术完成口径要如实算缺口（§2.7/§5.8）
  const independenceUnmet = allChecks
    .filter((c) => c.independence_required && c.effective === "passed" && c.next_operation.tool === "record_work_evidence")
    .map((c) => c.check_id);
  const blockingFindings =
    proj === null ? [] : proj.open_findings.filter((f) => f.must_block).map((f) => f.finding_id);
  // canonical 技术完成口径（**只消费投影的 canonical 结论**，不另算一套绿公式）：
  //   质量维到 `mechanical_passed`/`audit_passed`（等价于"必需项全过、无未收口缺陷、无陈旧"）
  //   ＋ 有映射 ＋ 源新鲜 ＋ 主状态不是 unknown/blocked，再叠加**逐项独审义务**与必须拦截缺陷。
  // 注意：`display_status === "verified"` 会把"仍在执行中（蓝）"也算成非完成——那是执行维度，
  // 不该否掉"技术验证已完成"；执行/人工验收是两个分开的维度（§5.4/E.9）。
  const canonicalQualityComplete =
    proj !== null &&
    proj.mapping === "mapped" &&
    (proj.quality === "mechanical_passed" || proj.quality === "audit_passed") &&
    proj.freshness === "fresh" &&
    proj.display_status !== "unknown" &&
    proj.display_status !== "blocked";
  const satisfied = canonicalQualityComplete && independenceUnmet.length === 0 && blockingFindings.length === 0;
  // 缺口逐条点名（不合并成一句；**不按空集合全通过**）
  if (taskId === null) {
    blockingFindings.push(`当前动作不指向任何任务（next_action=${snapshot.next_action}）：逐项工作包为空，**不按空集合「全通过」**`);
  } else if (allChecks.length === 0) {
    blockingFindings.push(
      `任务 ${taskId} 在已受检定义里没有必需检查（定义未导入完整或该卡无验收项）：**不按空集合「全通过」**，先核对定义`,
    );
  }
  for (const id of independenceUnmet) blockingFindings.push(`${id}：独审必需的检查只有作者自检——由非作者复核前不算技术完成（§2.7/§5.8）`);
  if (proj !== null && !canonicalQualityComplete && remaining.length === 0 && independenceUnmet.length === 0 && taskId !== null) {
    blockingFindings.push(
      `canonical 质量/新鲜度未到完成档（quality=${proj.quality}；freshness=${proj.freshness}；` +
        `display_status=${proj.display_status ?? "null"}；mapping=${proj.mapping}）：不据此声称技术完成（§4.2）`,
    );
  }

  // ── 续接下一步（对象级）：operation **对齐入口真实动作**（claim/resume/review/await/blocked/complete） ──
  const checkRole = allChecks.some((c) => c.responsible_role === "executor")
    ? "executor"
    : allChecks.some((c) => c.responsible_role === "auditor")
      ? "auditor"
      : null;
  const humanPending = allChecks.filter(c => c.effective === "not_checked" && c.next_operation.operation === "await_human");
  const onlyHumanPending = humanPending.length > 0 && independenceUnmet.length === 0 && allChecks.every(c => c.effective === "passed" || humanPending.includes(c));
  const nextRole = onlyHumanPending ? humanPending[0].responsible_role : snapshot.next_action_role ?? checkRole ?? "coordinator";
  const actionId = sha256Hex(
    JSON.stringify({
      package_revision: packageRevision,
      task_id: taskId,
      scope_id: scope.scope_id,
      next_action: snapshot.next_action,
      next_action_role: nextRole,
      remaining_checks: [...remaining].sort(),
      independence_unmet: [...independenceUnmet].sort(),
    }),
  );
  const reason =
    taskId === null
      ? `当前动作 ${snapshot.next_action} 不指向具体任务：没有逐项工作包可执行（缺口已在 blocking_findings 点名）`
      : satisfied
        ? `任务 ${taskId} 的必需检查在当前定义与源版本下**全部有效通过**、独审义务已满足、无未收口阻断：技术完成（按 §4.2 canonical 主状态 verified）`
        : `任务 ${taskId} 有 ${allChecks.length} 项必需检查：${remaining.length} 项未生效通过${independenceUnmet.length > 0 ? `、${independenceUnmet.length} 项独审未满足` : ""}；下一步按逐项 next_operation 与入口动作（${snapshot.next_action}）推进`;
  const prerequisite =
    satisfied
      ? "无（必需项均生效通过且独审义务满足；人工验收另计，Agent 不代签）"
      : nextRole === "user" || nextRole === "human_tester"
        ? "由真实测试人执行并保存观察证据，按 docs/audit-recovery.md 录入；用户验收另在验收页决定，不要求 Agent 认领"
      : nextRole === "auditor"
        ? "需要**非作者**角色（author ≠ auditor，§5.8）"
        : nextRole === "coordinator"
          ? "由协调者按入口动作推进（收件/重开/影响核实）"
          : "需要合法认领与隔离 workspace（claim_task 带 expected_revision；租约到期只表示所有权需核实）";

  // ── 两模式同形：**具名**标注调用方不具备的工具能力（不回退写路由） ──
  const flags = snapshot.capability_flags;
  const unsupported: { tool: string; operation: string; reason: string }[] = [];
  const writeOps = new Set<string>();
  for (const c of allChecks) if (c.next_operation.tool !== "") writeOps.add(`${c.next_operation.tool}.${c.next_operation.operation}`);
  // 整卡提交也是写操作：技术完成但尚未提交时，执行者仍需 submit_task_result（§5.4 的循环收口）
  const writesNeeded = [...writeOps];
  const markUnsupported = (tool: string, operation: string, why: string): void => {
    unsupported.push({ tool, operation, reason: why });
  };
  const continueBasis = flags.continue
    ? null
    : "调用方声明 client_capabilities 不含「可接续」（can_continue）：不会接到派活，也不该发写工具";
  const coordinateBasis = flags.coordinate
    ? null
    : "调用方声明 client_capabilities 不含「可协调执行」（can_coordinate）：协调者专用动作（如 claim_task.op=reopen 受控重开）不可用";
  for (const w of writesNeeded) {
    if (continueBasis === null) continue;
    const [tool, operation] = w.split(".");
    markUnsupported(tool, operation, `${continueBasis}——**具名**标注该工具/操作不可用，绝不回退写路由、也不在本地代执行（DESIGN.md §2.7/§6.11）`);
  }
  // 入口动作本身需要的工具能力（即使逐项无写操作，claim/review 也要如实标注）
  const entryNeedsWrite = snapshot.next_action === "claim_task" || snapshot.next_action === "resume_task";
  if (entryNeedsWrite && continueBasis !== null && !writesNeeded.some((w) => w.startsWith("claim_task."))) {
    markUnsupported("claim_task", "claim", `${continueBasis}——**具名**标注不可用，绝不回退写路由（DESIGN.md §2.7/§6.11）`);
  }
  // 协调者专用的**受控重开**只在确有返工需要（有 failed 检查）时才算「本包相关但不可用」，
  // 不在每次复审时都挂一条噪声（`unsupported` 只列与当前工作相关的缺失能力）。
  if (allChecks.some((c) => c.effective === "failed") && !flags.coordinate) {
    markUnsupported("claim_task", "reopen", `${coordinateBasis}——受控重开是协调者专用动作（附录 F）`);
  }

  const workPackage: WorkPackageFull = {
    scope_id: scope.scope_id,
    scope_revision: scopeRevision,
    package_revision: packageRevision,
    baseline: {
      design_revision: snapshot.baseline.design_revision ?? "",
      plan_revision: snapshot.baseline.plan_revision ?? "",
      baseline_id: snapshot.baseline.baseline_id,
    },
    task_id: taskId ?? "",
    task_revision: taskRevision === null ? "" : String(taskRevision),
    ownership: {
      owner_id: snapshot.ownership?.owner_id ?? "",
      run_id: snapshot.ownership?.run_id ?? "",
      attempt_id: snapshot.ownership?.attempt_id ?? "",
      lease_expires_at: snapshot.ownership?.lease_expires_at ?? "",
      workspace: snapshot.ownership?.workspace ?? "",
    },
    source_mode: snapshot.source_mode,
    status: proj?.display_status ?? null,
    checks: page,
    completion: { satisfied, remaining_checks: remaining, blocking_findings: blockingFindings },
    continuation: { action_id: actionId, role: nextRole, operation: snapshot.next_action, reason, prerequisite },
    paging,
    schema: "work-package/1",
    caller_role: role,
    unsupported,
    lock_in_not_checked: LOCK_IN_NOT_CHECKED.map((r) => ({ ...r })),
    legacy_client_note: LEGACY_CLIENT_NOTE,
  };
  return { ok: true, work_package: workPackage };
}
