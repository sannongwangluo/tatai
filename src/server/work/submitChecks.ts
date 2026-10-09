// 结果提交的**共享只读判据核心**（PLAN V09-47 / P2；DESIGN.md §6.7/§6.11/§5.4；docs/agent-optimization-20261006.md §6）。
//
// 为什么要独立一个模块：结果提交的五查（任务版本 / 认领 token / 租约 / 依赖 / 证据）此前**只**活在
// `claims.submitTaskResult` 的调用层，唯一写入服务的临界区内**没有**结果提交的完整五查。P2 要求
// 「提交前只读预检」与「真实提交」**共用同一份判据**，并把同一份判据接到真实结果写边界（锁内按当前事实重核），
// 所以把判据提取到这里，由三处共同调用：
//   · MCP `preflight_task_result`（经宿主只读路由 `POST /api/work/preflight`）；
//   · `claims.submitTaskResult`（调用层，产出既有的 ClaimFailure 文案与错误码，逐字不变）；
//   · `service.submitWithPrep` 的锁内门禁（直连通用写口手写 `task.result_submitted` 也不能旁路）。
//
// 注意措辞：这里的 `evaluateSubmitResultChecks` **不是数学意义的纯函数**——它按现场现读盘
// （PLAN 定义、证据库、项目根、账本快照），确定性只成立于「同一冻结输入 + 同一现场」这一前提。
// 「纯」只指**无副作用**：不写任何事件/快照/证据、不续租、不产生认领、不留痕。
//
// 账本来源的保证（写边界专用，见 `dependencyRecheck` 的 `events` 参数）：真实结果写边界在
// `service.submitWithPrep` 的**跨进程文件锁**（`withFileLock(events.jsonl)`，O_EXCL 互斥）内执行，
// 锁内 `loadEvents` 与这里依赖重查所走 `projectFromFacts → collectProjectFacts` 都经**同一个**
// `readLedger` 读口（每次现读真实字节做 sha256 核验、摘要对上才复用解析结果）——持锁期间没有第二个
// 写者能追加，故两边读到的是**同一份账本**。锁路径仍显式把锁内事件快照传下去（`ctx.events`），
// 不依赖"读两次碰巧一致"。
//
// 硬口径：
//   · **只读**：本模块只读盘（plan/证据库/项目根），不写任何事件/快照/证据、不续租、不产生认领、不留痕；
//   · **秘密不回显**：`claim_token`（含前缀与内嵌它的幂等键）不进入任何 failure 文案/`expected`/`actual`/`remediation`；
//   · **不假装已核**：引用存在 ≠ 内容真实 ≠ 覆盖完整；未执行/锁内特有的校验只列 `not_checked` 或 `not_applicable`；
//   · **不适用与未检查分开**：对 `task.result_submitted` 不适用的锁内校验逐条 `status="not_applicable"`（在 `checks` 里），
//     锁内未查项进 `not_checked`，两类绝不混用；本批**不新增**结果提交的同步门禁。
import fs from "node:fs";
import path from "node:path";
import { getProject, resolveDataDir } from "../registry";
import { nowIso } from "../time";
import { projectWorkDir } from "../workstation";
import { loadDocuments } from "./documents";
import { evidenceBlobPath, readEvidence } from "./evidence";
import { importTaskDefinitions, taskDefinitionHash, type TaskDefinition } from "./plan";
import { readManifestCarrier, verifySourceManifest } from "./sourceEvidence";
import { dependencyRelease, projectFromFacts, type EventsSnapshot } from "./statusProjection";
import { foldTaskStates, TASK_STATUS_LABELS, taskEntityId, type TaskExecutionStatus } from "./tasks";
import {
  SCHEMA_VERSION,
  WorkError,
  validateWorkCommand,
  type WorkCommand,
  type WorkErrorCode,
  type WorkEvent,
} from "./types";

// ── 租约与工作目录口径（从 claims.ts 下移到本模块：提交判据的唯一共享来源） ──

/** 租约状态：none = 没有认领记录；unknown = 时间戳解析不了（如实标未知，**不**当已过期） */
export type LeaseState = "none" | "active" | "expired" | "unknown";

/** 租约状态判定（纯函数；`now` 由调用方给，便于确定性验证） */
export function leaseStateOf(leaseExpiresAt: string | null | undefined, now: string): LeaseState {
  if (leaseExpiresAt === null || leaseExpiresAt === undefined || leaseExpiresAt === "") return "none";
  const at = Date.parse(leaseExpiresAt);
  const atNow = Date.parse(now);
  if (Number.isNaN(at) || Number.isNaN(atNow)) return "unknown";
  return at > atNow ? "active" : "expired";
}

/** 租约语义的**唯一措辞**（§2.7 原文口径；回执、错误文案与界面都用它，不许改写成"旧进程已停止"） */
export const LEASE_NOTE = "租约到期只表示「当前所有权需核实」，不证明旧进程已停止（DESIGN.md §2.7）";

function workDirOf(projectId: string, dataDir?: string): string {
  const project = getProject(projectId, dataDir);
  if (!project) {
    throw new Error(`项目不存在: ${projectId}`);
  }
  return projectWorkDir(projectId, dataDir);
}

function dataDirOr(dataDir?: string): string {
  return dataDir ?? resolveDataDir();
}

// ── 施工定义 / 依赖重查 / 证据引用（纯读；从 claims.ts 下移，由预检与提交共用） ──

export interface PlanDefinitionsView {
  definitions: TaskDefinition[];
  plan_revision: string | null;
  design_revision: string | null;
}

/**
 * 现读当前施工图算出定义 + 两份图纸的当前修订（一次读取，供 `observed_versions` 与依赖重查共用）。
 * 读不出来一律按"没有定义/没有修订"如实返回（现场施工定义不校验结构）。
 */
export function loadPlanDefinitions(projectId: string, dataDir?: string): PlanDefinitionsView {
  try {
    const docs = loadDocuments(projectId, dataDir);
    const definitions =
      docs.plan === null
        ? []
        : importTaskDefinitions(docs.plan.text, { plan_revision: docs.plan.revision.content_sha256 }).definitions;
    return {
      definitions,
      plan_revision: docs.plan?.revision.content_sha256 ?? null,
      design_revision: docs.design?.revision.content_sha256 ?? null,
    };
  } catch {
    return { definitions: [], plan_revision: null, design_revision: null };
  }
}

/** 现场施工定义（不校验结构；读不出来就是空表，如实反映"没有定义"） */
export function planDefinitions(projectId: string, dataDir?: string): TaskDefinition[] {
  return loadPlanDefinitions(projectId, dataDir).definitions;
}

/**
 * 依赖重查：逐条前置给释放结论（用 V06-09 的 `dependencyRelease`，不看"前卡自报 done"）。
 *
 * `events` 给定时直接折叠这份**锁内**账本快照（写边界专用，避免"锁内读一遍、这里再读一遍"）；
 * 缺省仍现读，行为不变（调用层/预检按现场读数）。来源一致性由调用方保证（快照带 work_dir）。
 */
export function dependencyRecheck(
  projectId: string,
  taskId: string,
  dataDir?: string,
  definitions?: TaskDefinition[],
  events?: EventsSnapshot,
): { ok: boolean; checked: string[]; failures: string[] } {
  const defs = definitions ?? planDefinitions(projectId, dataDir);
  const def = defs.find((d) => d.task_id === taskId);
  if (def === undefined) {
    return { ok: false, checked: [], failures: [`施工定义里找不到任务 ${taskId}：无法核对依赖与交付要求`] };
  }
  if (def.dependency_ids.length === 0) return { ok: true, checked: ["本任务没有依赖"], failures: [] };
  const { projection } = projectFromFacts(projectId, dataDirOr(dataDir), events === undefined ? {} : { events });
  const checked: string[] = [];
  const failures: string[] = [];
  for (const dep of def.dependency_ids) {
    const prerequisite = projection.by_id[dep];
    if (prerequisite === undefined) {
      failures.push(`前置 ${dep} 还没有任何运行状态：依赖未释放（先让它开工并交出可核对的证据）`);
      continue;
    }
    const release = dependencyRelease({
      prerequisite_id: dep,
      prerequisite,
      evidence_requirement: def.dependency_evidence.find((d) => d.dependency_id === dep)?.evidence ?? null,
    });
    checked.push(`${dep} ${release.released ? "已释放" : "未释放"}：${release.reasons.join("；") || "无阻塞理由"}`);
    if (!release.released) failures.push(`前置 ${dep} 未释放：${release.reasons.join("；")}`);
  }
  return { ok: failures.length === 0, checked, failures };
}

/**
 * 证据引用核对：内容寻址 sha256 → 必须在项目证据库里取得到；项目根内相对路径 → 必须真实存在；
 * 带 scheme/绝对路径 → 记进 `external`（如实标注"引用在项目之外，塔台没核"）。
 */
export function checkEvidenceRefs(
  projectId: string,
  refs: readonly string[],
  dataDir?: string,
): { ok: boolean; failures: string[]; external: string[] } {
  const failures: string[] = [];
  const external: string[] = [];
  if (refs.length === 0) {
    failures.push("没有任何证据引用：交付检查要求结果带可追溯的证据（§5.5/§6.7）");
    return { ok: false, failures, external };
  }
  const workDir = workDirOf(projectId, dataDir);
  const project = getProject(projectId, dataDir);
  const root = project === undefined ? null : path.resolve(project.path);
  for (const ref of refs) {
    const value = ref.trim();
    if (value === "") {
      failures.push("证据引用里有空串");
      continue;
    }
    if (/^[0-9a-f]{64}$/.test(value)) {
      try {
        readEvidence(workDir, value);
      } catch (e) {
        failures.push(`证据 ${value.slice(0, 12)}… 对不上：${(e as Error).message}`);
      }
      continue;
    }
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value) || path.isAbsolute(value) || /^[a-zA-Z]:[\\/]/.test(value)) {
      external.push(value);
      continue;
    }
    if (root === null) {
      external.push(value);
      continue;
    }
    const abs = path.resolve(root, value);
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      failures.push(`证据引用 ${value} 越出项目根：路径穿越一律不收`);
      continue;
    }
    if (!fs.existsSync(abs)) failures.push(`证据引用 ${value} 指向的文件不存在`);
  }
  return { ok: failures.length === 0, failures, external };
}

// ── 共享结果判据 ──

/** 共享判据可能给出的失败码（是 `ClaimFailureCode` 的子集，避免 claims ↔ submitChecks 反向依赖） */
export type SubmitCheckFailureCode =
  | WorkErrorCode
  | "CLAIM_NOT_YOURS"
  | "LEASE_NEEDS_VERIFICATION"
  | "DEPENDENCY_UNMET"
  | "EVIDENCE_MISSING";

export type SubmitCheckStatus = "passed" | "failed" | "not_applicable" | "not_checked";

export interface SubmitCheckRow {
  kind: string;
  status: SubmitCheckStatus;
  expected: unknown;
  actual: unknown;
  source_ref: string | null;
  remediation: string | null;
}

export interface SubmitNotCheckedRow {
  kind: string;
  reason: string;
}

/** 共享判据的**输入**（与 `submit_task_result` 同形；`now` 只作进程内测试时钟，不进公开预检输入） */
export interface SubmitResultChecksInput {
  project_id: string;
  task_id: string;
  role: string;
  owner_id: string;
  change_id: string;
  claim_token: string;
  expected_revision: number;
  evidence_refs: readonly string[];
  ownership_basis?: string;
  /** **仅进程内测试注入**；运行时调用方不传＝用真实时刻（不允许回拨时钟延长租约） */
  now?: string;
  // ── 幂等内容比对用的交付包字段（可选；预检与提交判据都带上，与 `submit_task_result` 同形） ──
  deliverables?: readonly string[];
  verification?: readonly unknown[];
  untested?: readonly string[];
  known_issues?: readonly string[];
  diff_ref?: string | null;
  result_revision?: string | null;
  runtime_entries?: unknown;
}

/** 当前任务状态（现读折叠 或 锁内事件折叠；两处同一份字段） */
export interface SubmitResultChecksState {
  revision: number;
  status: TaskExecutionStatus;
  cancelled: boolean;
  cancel_reason: string | null;
  owner_id: string | null;
  claim_token: string | null;
  lease_expires_at: string | null;
  definition_sha256: string | null;
  definition_change_id: string | null;
  definition_requirement_ids?: string[] | null;
}

export interface SubmitResultChecksContext {
  dataDir?: string;
  /** 预解析定义（省一次重解析）；不给则现读 PLAN */
  definitions?: TaskDefinition[];
  /** 是否做「定义绑定漂移」拒旧（缺省 true） */
  recheckDefinition?: boolean;
  /** 是否做「带 source_manifest 的证据源漂移」拒旧（缺省 true） */
  recheckEvidenceSources?: boolean;
  /**
   * 是否要求「至少一条证据引用」（缺省 true）。
   * **P2 返工纠正**：不再有 `false` 这条放宽——旧夹具的"空证据"不是产品语义依据。锁内写边界对
   * 真实的 `task.result_submitted` 与调用层同口径（交付必须带可追溯证据）。保留此开关只为显式测试。
   */
  evidenceRefsRequired?: boolean;
  /**
   * 事件账本快照（**锁内写边界专用**）：给定时依赖重查折叠这份快照而非再读一遍盘，
   * 与锁内 `loadEvents` 同源（`work_dir` 必须一致，见 `EventsSnapshot`）。
   */
  events?: EventsSnapshot;
}

export interface SubmitResultChecksOutcome {
  ok: boolean;
  code: SubmitCheckFailureCode | null;
  failures: string[];
  message: string;
  version_ok: boolean;
  claim_ok: boolean;
  lease: LeaseState;
  dep_checked: string[];
  external_evidence_refs: string[];
  /** 任务绑定的当前定义（找不到为 null） */
  definition: TaskDefinition | null;
  /** 当前定义哈希（definition 非空时给出；供提交回执原样绑定） */
  definition_hash: string | null;
  /** 定义对应的 plan 修订 */
  plan_revision: string | null;
  definitions: TaskDefinition[];
  checks: SubmitCheckRow[];
  not_checked: SubmitNotCheckedRow[];
  observed_versions: Record<string, unknown>;
}

const EVENTS_REF = ".工作台/work/events.jsonl";
const PLAN_REF = "PLAN.md";

/** 锁内**特有**校验：预检无论如何都查不到（要在唯一写入服务临界区内按当前事实重核） */
function notCheckedRows(): SubmitNotCheckedRow[] {
  return [
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
        "预检只能证明「引用的证据材料可解析/在库/路径存在」，不能证明某项验证真的跑过、退出码真实、覆盖完整或独立审查已做（引用存在 ≠ 内容真实 ≠ 覆盖完整）",
    },
    {
      kind: "external_evidence_refs",
      reason: "带 scheme/绝对路径的外部证据引用在项目之外，塔台没有读它，也不为它的内容背书",
    },
  ];
}

/**
 * 对 `task.result_submitted` **不适用**的锁内校验（逐条点名命令与理由；§6.2 表）。
 * 这些是**不适用**，不是"未检查"——两类不得混用；也不得把不适用写成已核。
 */
function notApplicableRows(): SubmitCheckRow[] {
  const row = (kind: string, expected: string, actual: string): SubmitCheckRow => ({
    kind,
    status: "not_applicable",
    expected,
    actual,
    source_ref: null,
    remediation: null,
  });
  return [
    row("assertClaimSyncGate", "仅 task.claimed 且非续约时生效", "不适用于 task.result_submitted：结果提交当前没有该同步门禁（本批不新增）"),
    row("assertEntityEventFoldable", "仅 requirement:/change: 实体事件", "任务事件不作该折叠校验"),
    row("assertRequirementIntentSourceResolvable", "仅 requirement.registered/updated", "结果提交不声明需求意图来源"),
    row("assertDefinitionImportReferences", "仅 task.definition_imported", "结果提交不携带定义导入引用"),
    row("assertDefinitionImportHashConsistent", "仅 task.definition_imported", "结果提交不携带定义导入哈希"),
    row("assertSelfCheckEvidenceConsistent", "仅 audit.self_check_recorded", "结果提交不是自检记录"),
    row("verifyReopenCommand", "仅 task.reopened", "结果提交不是受控重开"),
    row("sync_domain_write_boundary", "仅 sync.contract_registered / sync.evidence_checked", "结果提交不是同步域命令；本批不新增结果提交的同步门禁"),
    row("verifyTaskPhaseCommand", "仅 task.blocked / task.status_changed", "结果提交不是状态上报"),
  ];
}

/**
 * 一次「结果提交」的共享判据求值（预检 / 真实提交 / 锁内门禁三处同一份）。
 *
 * **只读、无副作用**——但**不是数学意义的纯函数**：它会现读盘（PLAN 定义、证据库、项目根、账本快照）。
 * 确定性只成立于「同一冻结输入 + 同一现场 + 同一 `now`」；现场变了（定义/租约/依赖/证据源/账本）结论就变
 * ——这正是「预检不是通行票、提交时锁内按当前事实重核」的由来。任何一条查不过都在 `failures` 里逐条列清，
 * 并按既有口径给出 `code`（`VERSION_CONFLICT`/`CLAIM_NOT_YOURS`/`LEASE_NEEDS_VERIFICATION`/`DEPENDENCY_UNMET`/
 * `EVIDENCE_MISSING`，其余落 `INVALID_COMMAND`）。**不**把 `claim_token` 或其前缀写进任何输出。
 */
export function evaluateSubmitResultChecks(
  input: SubmitResultChecksInput,
  state: SubmitResultChecksState | null,
  ctx: SubmitResultChecksContext = {},
): SubmitResultChecksOutcome {
  const dataDir = ctx.dataDir;
  const failures: string[] = [];
  const checks: SubmitCheckRow[] = [];
  const not_checked = notCheckedRows();

  if (state === null) {
    const message = `任务 ${input.task_id} 没有运行状态`;
    return {
      ok: false,
      code: "INVALID_COMMAND",
      failures: [message],
      message,
      version_ok: false,
      claim_ok: false,
      lease: "none",
      dep_checked: [],
      external_evidence_refs: [],
      definition: null,
      definition_hash: null,
      plan_revision: null,
      definitions: [],
      checks,
      not_checked,
      observed_versions: { task_revision: null },
    };
  }

  // ① 任务版本
  const versionOk = state.revision === input.expected_revision;
  if (!versionOk) failures.push(`任务版本不符：调用方声明 ${input.expected_revision}，现场是 ${state.revision}`);
  checks.push({
    kind: "task_version",
    status: versionOk ? "passed" : "failed",
    expected: input.expected_revision,
    actual: state.revision,
    source_ref: EVENTS_REF,
    remediation: versionOk ? null : "重新读 project_entry 拿当前 task_revision 后再提交（塔台不替你合并）",
  });

  // ② 认领（所有交付检查当前认领 token）
  const claimOk = state.claim_token !== null && state.claim_token === input.claim_token;
  const cancelled = state.cancelled;
  if (cancelled) failures.push(`任务已取消（${state.cancel_reason ?? "无理由"}）`);
  const statusOk = state.status === "claimed" || state.status === "executing";
  if (!statusOk) failures.push(`当前状态是「${TASK_STATUS_LABELS[state.status]}」，不是认领/执行中`);
  if (!claimOk) {
    failures.push(
      `认领 token 不是当前那个（现场 ${state.claim_token === null ? "没有有效认领" : "是另一份认领"}）：` +
        "交付只检查当前认领 token（DESIGN.md §2.7）",
    );
  }
  const ownerInput = input.owner_id;
  const ownerOk = !(state.owner_id !== null && state.owner_id !== ownerInput);
  if (!ownerOk) failures.push(`持有者是 ${state.owner_id}，不是 ${ownerInput}：不能替别人交付`);
  checks.push({
    kind: "claim_token",
    status: claimOk ? "passed" : "failed",
    // **不回显 token**：预期/实际只说"是不是现场那一个"，秘密（含前缀）绝不落进任何输出
    expected: "与现场当前认领一致",
    actual: claimOk ? "一致" : state.claim_token === null ? "现场没有有效认领" : "与现场认领不一致",
    source_ref: EVENTS_REF,
    remediation: claimOk ? null : "用 project_entry 的当前认领重新认领（claim_task）后再交付",
  });
  checks.push({
    kind: "claim_owner",
    status: ownerOk ? "passed" : "failed",
    expected: ownerInput,
    actual: state.owner_id,
    source_ref: EVENTS_REF,
    remediation: ownerOk ? null : "只有当前持有者能交付自己的任务；不要替别人交付",
  });
  checks.push({
    kind: "task_status",
    status: statusOk && !cancelled ? "passed" : "failed",
    expected: ["claimed", "executing"],
    actual: state.status,
    source_ref: EVENTS_REF,
    remediation: statusOk && !cancelled ? null : "任务不在认领/执行中（已取消或已提交/阻塞）：先按 project_entry 的 next_action 处理",
  });

  // ③ 租约（到期只表示所有权需核实，不证明旧进程已停止）；毫秒精度比较
  const now = input.now ?? nowIso();
  const lease = leaseStateOf(state.lease_expires_at, now);
  const ownership = (input.ownership_basis ?? "").trim();
  const leaseOk = !(lease === "expired" && ownership === "") && lease !== "unknown";
  if (lease === "expired" && ownership === "") {
    failures.push(`租约已到期（${state.lease_expires_at}）：${LEASE_NOTE}；先续约，或给出 ownership_basis 说明怎么核实的所有权`);
  }
  if (lease === "unknown") failures.push(`租约时间戳解析不了（${state.lease_expires_at}）：按未知处理，先续约`);
  checks.push({
    kind: "lease",
    status: leaseOk ? "passed" : "failed",
    expected: "active（或到期但给了 ownership_basis）",
    actual: lease === "active" ? "active" : lease === "expired" && ownership !== "" ? "expired（已给 ownership_basis）" : lease,
    source_ref: EVENTS_REF,
    remediation: leaseOk ? null : lease === "unknown" ? "租约时间戳解析不了：先续约再提交" : "先续约，或给出 ownership_basis 说明怎么核实的所有权",
  });

  // ④ 依赖释放 + 定义绑定（现读当前施工图）
  const view = ctx.definitions === undefined ? loadPlanDefinitions(input.project_id, dataDir) : null;
  const definitions = ctx.definitions ?? view!.definitions;
  const planRevisionFromView = view?.plan_revision ?? null;
  const def = definitions.find((d) => d.task_id === input.task_id) ?? null;
  const depCheck = dependencyRecheck(input.project_id, input.task_id, dataDir, definitions, ctx.events);
  failures.push(...depCheck.failures);
  if (def !== null && def.dependency_ids.length > 0) {
    checks.push({
      kind: "dependencies",
      status: depCheck.ok ? "passed" : "failed",
      expected: def.dependency_ids,
      actual: depCheck.checked,
      source_ref: PLAN_REF,
      remediation: depCheck.ok ? null : "先让未释放的前置交出可核对的完成证据（依赖按证据判，不看自报 done）",
    });
  } else {
    checks.push({
      kind: "dependencies",
      status: def === null ? "failed" : "passed",
      expected: def === null ? "施工定义里能找到本任务" : [],
      actual: def === null ? "施工定义里找不到本任务" : "本任务没有依赖",
      source_ref: PLAN_REF,
      remediation: def === null ? "确认本卡在当前施工图 PLAN.md 里，并已导入定义" : null,
    });
  }

  // ⑤ 证据引用（无证据的完成不收；引用存在 ≠ 内容真实）
  //    **P2 返工纠正**：不再有"锁内放宽、空证据放行"的口径——调用层与预检、锁内写边界共用同一条
  //    交付完整性规则（`evidenceRefsRequired` 缺省 true；`false` 不再被产品路径使用）。
  const evidenceRequired = ctx.evidenceRefsRequired !== false;
  const evCheck =
    evidenceRequired || input.evidence_refs.length > 0
      ? checkEvidenceRefs(input.project_id, input.evidence_refs, dataDir)
      : { ok: true, failures: [] as string[], external: [] as string[] };
  failures.push(...evCheck.failures);
  const evidenceSourceFailures: string[] = [];
  const currentDefHash =
    def === null
      ? null
      : taskDefinitionHash({
          ...def,
          change_id: state.definition_change_id,
          requirement_ids: def.requirement_ids ?? state.definition_requirement_ids ?? null,
        });

  // ⑤′ 带 source_manifest 的证据**源漂移**：覆盖源一变即拒旧（复用现有 verifySourceManifest 判据，不只看文件存在）。
  //    四种结论分开如实标（**不冒充已核**）：
  //      · checked_valid  —— 载体完整 + 现读复核 valid（真的核过、覆盖源对得上）；
  //      · stale          —— 覆盖源变了/被删（拒旧，进 failures）；
  //      · unreadable     —— 载体/清单读不了或自洽性不过（拒旧，进 failures）；
  //      · legacy_unbound —— 没有 source_manifest 载体（历史/旧格式证据，**不当 valid**，也不因格式旧就一律禁收，
  //                           如实进 not_checked）。
  const recheckSources = ctx.recheckEvidenceSources !== false;
  type SourceRecheckStatus = "checked_valid" | "stale" | "unreadable" | "legacy_unbound";
  interface SourceRecheckVerdict {
    ref: string;
    status: SourceRecheckStatus;
    detail: string;
    changed: string[];
    missing: string[];
    unreadable: string[];
  }
  const sourceVerdicts: SourceRecheckVerdict[] = [];
  if (recheckSources) {
    let workDir: string;
    let projectRoot: string | null;
    try {
      workDir = workDirOf(input.project_id, dataDir);
      const project = getProject(input.project_id, dataDir);
      projectRoot = project === undefined ? null : path.resolve(project.path);
    } catch {
      workDir = "";
      projectRoot = null;
    }
    const noDiff = { changed: [] as string[], missing: [] as string[], unreadable: [] as string[] };
    const seen = new Map<string, SourceRecheckVerdict>();
    for (const ref of input.evidence_refs) {
      const value = ref.trim();
      if (!/^[0-9a-f]{64}$/.test(value) || projectRoot === null || workDir === "") continue;
      const cached = seen.get(value);
      if (cached !== undefined) {
        if (cached.status === "stale" || cached.status === "unreadable") evidenceSourceFailures.push(cached.detail);
        continue;
      }
      let outcomeForRef: SourceRecheckVerdict = {
        ref: value,
        status: "legacy_unbound",
        detail: `证据 ${value.slice(0, 12)}… 没有 source_manifest 载体：来源绑定未核（历史/旧格式，不当 valid）`,
        ...noDiff,
      };
      try {
        const carrier = readManifestCarrier(evidenceBlobPath(workDir, value));
        if (carrier !== null) {
          if (!carrier.intact) {
            outcomeForRef = {
              ref: value,
              status: "unreadable",
              detail: `证据 ${value.slice(0, 12)}… 的源清单载体完整性核验不过（${carrier.defect ?? "未知"}）：现场被改过/截损，不采信`,
              ...noDiff,
            };
          } else {
            const verdict = verifySourceManifest(projectRoot, carrier.manifest);
            outcomeForRef = {
              ref: value,
              status: verdict.status === "valid" ? "checked_valid" : verdict.status === "invalidated" ? "stale" : "unreadable",
              detail: `证据 ${value.slice(0, 12)}… 的源清单现读复核结论是 ${verdict.status}：${verdict.reason}`,
              changed: verdict.changed,
              missing: verdict.missing,
              unreadable: verdict.unreadable,
            };
          }
        }
      } catch (e) {
        outcomeForRef = {
          ref: value,
          status: "unreadable",
          detail: `证据 ${value.slice(0, 12)}… 的源清单复核失败：${(e as Error).message}`,
          ...noDiff,
        };
      }
      seen.set(value, outcomeForRef);
      sourceVerdicts.push(outcomeForRef);
      // legacy_unbound 只是"未绑定来源、未核"，不是"核不过"——不拒旧格式（进 not_checked）
      if (outcomeForRef.status === "stale" || outcomeForRef.status === "unreadable") {
        evidenceSourceFailures.push(outcomeForRef.detail);
      }
    }
  }
  failures.push(...evidenceSourceFailures);
  const evidenceSourceDrifts = sourceVerdicts.filter((v) => v.status === "stale" || v.status === "unreadable");
  const evidenceSourceUnbound = sourceVerdicts.filter((v) => v.status === "legacy_unbound");
  const evidenceRefsOk = evCheck.ok && evidenceSourceFailures.length === 0;
  checks.push({
    kind: "evidence_refs",
    status: evidenceRefsOk ? "passed" : "failed",
    expected: "≥1 条，内容寻址件在库 / 项目根内相对路径存在",
    actual: {
      refs: input.evidence_refs.length,
      external: evCheck.external,
      source_manifests: sourceVerdicts.map((v) => ({ ref: v.ref, status: v.status })),
    },
    source_ref: ".工作台/work/evidence/",
    remediation: evidenceRefsOk
      ? null
      : "补齐可追溯的证据引用：内容寻址 sha256 必须在库，项目根内相对路径必须真实存在；外部引用塔台没核（引用存在 ≠ 内容真实）",
  });
  // ⑤″ 证据的**源清单现读复核**单列一行：逐项结论 + 具体变化（changed/missing/unreadable）+ 修复位置。
  //     有漂移 ⇒ failed；确有核过且全 valid ⇒ passed；只有未绑定来源的历史证据 ⇒ 不写 passed（进 not_checked）。
  if (recheckSources && sourceVerdicts.length > 0) {
    if (evidenceSourceDrifts.length > 0) {
      checks.push({
        kind: "evidence_source_manifests",
        status: "failed",
        expected: "带 source_manifest 的证据现读复核 valid（覆盖源未变）",
        actual: {
          drifts: evidenceSourceDrifts.map((v) => ({ ref: v.ref, status: v.status, changed: v.changed, missing: v.missing, unreadable: v.unreadable })),
          detail: evidenceSourceDrifts.map((v) => v.detail),
        },
        source_ref: ".工作台/work/evidence/",
        remediation:
          "源清单覆盖的路径变了：先重跑所绑验证、重取证据（新的 source_manifest 载体）再交付；" +
          "逐项变化见 actual.drifts 的 changed/missing/unreadable（修复位置就是这些路径）",
      });
    } else if (sourceVerdicts.some((v) => v.status === "checked_valid")) {
      checks.push({
        kind: "evidence_source_manifests",
        status: "passed",
        expected: "带 source_manifest 的证据现读复核 valid（覆盖源未变）",
        actual: { checked: sourceVerdicts.filter((v) => v.status === "checked_valid").map((v) => v.ref) },
        source_ref: ".工作台/work/evidence/",
        remediation: null,
      });
    }
    if (evidenceSourceUnbound.length > 0) {
      not_checked.push({
        kind: "evidence_source_manifest_unbound",
        reason:
          `这些内容寻址证据没有 source_manifest 载体（历史/旧格式），来源绑定未核（不冒充 valid）：` +
          evidenceSourceUnbound.map((v) => v.ref.slice(0, 12) + "…").join("、"),
      });
    }
  }

  // ⑥ 定义绑定漂移：任务绑的定义与当前 PLAN 现解析不一致 ⇒ 拒旧（结果要绑当前定义，§5.6）
  const recheckDefinition = ctx.recheckDefinition !== false;
  let definitionOk = true;
  if (recheckDefinition && def !== null && state.definition_sha256 !== null && currentDefHash !== null && currentDefHash !== state.definition_sha256) {
    definitionOk = false;
    failures.push(
      `本任务绑定的施工定义与当前 PLAN 现解析不一致（绑定 ${state.definition_sha256.slice(0, 12)}…，` +
        `当前 ${currentDefHash.slice(0, 12)}…）：定义变了，请先重绑到当前定义（rebind_task）再交付（DESIGN.md §5.6）`,
    );
  }
  checks.push({
    kind: "definition_binding",
    status: definitionOk ? "passed" : "failed",
    expected: state.definition_sha256,
    actual: currentDefHash,
    source_ref: PLAN_REF,
    remediation: definitionOk ? null : "先按 §5.6 重绑本任务到当前定义修订，再交付结果",
  });

  const ok = failures.length === 0;
  const code: SubmitCheckFailureCode | null = ok
    ? null
    : !versionOk
      ? "VERSION_CONFLICT"
      : !claimOk
        ? "CLAIM_NOT_YOURS"
        : lease === "expired" && ownership === ""
          ? "LEASE_NEEDS_VERIFICATION"
          : depCheck.failures.length > 0
            ? "DEPENDENCY_UNMET"
            : evCheck.failures.length > 0 || evidenceSourceFailures.length > 0
              ? "EVIDENCE_MISSING"
              : "INVALID_COMMAND";
  const message = ok
    ? "结果提交判据全部通过"
    : `结果提交被拒（${failures.length} 项查不过）：${failures.join("；")}`;

  checks.push(...notApplicableRows());

  return {
    ok,
    code,
    failures,
    message,
    version_ok: versionOk,
    claim_ok: claimOk,
    lease,
    dep_checked: depCheck.checked,
    external_evidence_refs: evCheck.external,
    definition: def,
    definition_hash: currentDefHash,
    plan_revision: def?.plan_revision ?? planRevisionFromView,
    definitions,
    checks,
    not_checked,
    observed_versions: {
      task_revision: state.revision,
      plan_definition_sha256: currentDefHash,
      plan_revision: def?.plan_revision ?? planRevisionFromView,
      design_revision: view?.design_revision ?? null,
    },
  };
}

// ── 结果提交入参的纯校验 + 构造（预检与 submit_task_result 同源） ──

/**
 * `submit_task_result` / 预检入参的**闭键集**（必须与 `projectEntry.SUBMIT_TASK_RESULT_SCHEMA.properties`
 * 的键**逐字一致**；verify-preflight-task-result 有断言守这条同源，漂移即红）。
 */
export const RESULT_SUBMIT_INPUT_KEYS: readonly string[] = [
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
];

/** `submit_task_result` 的必填（与 `projectEntry.SUBMIT_TASK_RESULT_REQUIRED` 同源） */
export const RESULT_SUBMIT_REQUIRED_KEYS: readonly string[] = [
  "project_id",
  "task_id",
  "role",
  "change_id",
  "claim_token",
  "expected_revision",
  "evidence_refs",
];

export interface ParsedResultSubmitInput {
  ok: boolean;
  failures: string[];
  input: SubmitResultChecksInput | null;
}

/**
 * 把一次「结果提交/预检」的原始入参校验并构造成判据输入：**闭键 + 类型 + 必填**，再走**同一份**
 * `validateWorkCommand`（真实的命令信封校验：role / expected_revision / payload / schema_version）。
 * **不调用 submit、不试写**——纯校验，可直接用于只读预检。
 *
 * 口径（对**公开 schema** 同源；P2 最终纠正）：
 *   · 闭键：不认识的字段**明确拒**（schema `additionalProperties:false`），不静默丢弃；
 *   · 公开 `now` **明确拒**（运行时不能回拨时钟延长租约）；
 *   · 负/非整数版本、非字符串数组项、非法 role 一律点名拒，**不静默过滤**（过滤会让预检比真实提交更宽松）；
 *   · `verification` 逐项按 schema 的 items 核：非对象项、缺失/非字符串 `command`、缺失/非数字 `exit_code`、
 *     非字符串 `output_ref` 一律**点名拒**——不再"过滤非对象项 + 把非法值改成默认"后照常报 would_pass；
 *     多余键不设新闭键要求（原 items 无 `additionalProperties:false`）。通过后取同一归一形态
 *     （`command` 字符串 / `exit_code` 数字 / `output_ref` 字符串或 null），保证幂等内容比对一致。
 *
 * 注意「同源」的边界：`submit_task_result` 侧有历史遗留的**宽容归一**（缺 `command`→""、非法 `exit_code`→-1），
 * 本批按复核要求**不动公开 submit schema 与既有归一**；只读预检这里改为按 schema 如实拒，因此预检对**显式
 * 非法入参**比 submit 更严格——这不会放宽任何东西，也不会把"调用方改了意图"洗成 would_pass。
 */
export function parseResultSubmitInput(raw: unknown): ParsedResultSubmitInput {
  const failures: string[] = [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, failures: ["入参必须是 JSON 对象"], input: null };
  }
  const p = raw as Record<string, unknown>;
  const unknownKeys = Object.keys(p).filter((k) => !RESULT_SUBMIT_INPUT_KEYS.includes(k));
  if (unknownKeys.length > 0) {
    failures.push(
      `不认识的入参字段 ${unknownKeys.join("、")}：submit_task_result 的 schema 是闭键（additionalProperties:false）`,
    );
  }
  if (p.now !== undefined) {
    failures.push("now 不是公开入参：运行时调用方不能回拨时钟延长租约（测试时钟只在进程内注入）");
  }
  const reqStr = (k: string): string => {
    const v = p[k];
    if (v === undefined || v === null) {
      failures.push(`缺必填 ${k}`);
      return "";
    }
    if (typeof v !== "string") {
      failures.push(`${k} 必须是字符串（收到 ${Array.isArray(v) ? "array" : typeof v}）`);
      return "";
    }
    const s = v.trim();
    if (s === "") failures.push(`${k} 不能为空`);
    return s;
  };
  const optStr = (k: string): string | null => {
    const v = p[k];
    if (v === undefined || v === null) return null;
    if (typeof v !== "string") {
      failures.push(`${k} 必须是字符串（收到 ${Array.isArray(v) ? "array" : typeof v}）`);
      return null;
    }
    return v.trim() === "" ? null : v.trim();
  };
  const strArrayList = (k: string): string[] => {
    const v = p[k];
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) {
      failures.push(`${k} 必须是字符串数组（收到 ${typeof v}）`);
      return [];
    }
    const bad = v.filter((x) => typeof x !== "string");
    if (bad.length > 0) {
      failures.push(`${k} 里有 ${bad.length} 项不是字符串：不静默丢弃（提交侧 schema 只收字符串）`);
      return [];
    }
    return v as string[];
  };
  const projectId = reqStr("project_id");
  const taskId = reqStr("task_id");
  const role = reqStr("role");
  const changeId = reqStr("change_id");
  const claimToken = reqStr("claim_token");
  const ownerId = optStr("owner_id") ?? role;
  const deliverables = strArrayList("deliverables");
  const evidenceRefs = strArrayList("evidence_refs");
  const untested = strArrayList("untested");
  const knownIssues = strArrayList("known_issues");
  let verification: { command: string; exit_code: number; output_ref: string | null }[] = [];
  if (p.verification !== undefined && p.verification !== null) {
    if (!Array.isArray(p.verification)) failures.push(`verification 必须是数组（收到 ${typeof p.verification}）`);
    else {
      // P2 最终纠正（同根因）：调用方**显式给错**的类型/缺必填项**如实拒**——不再把非对象项静默过滤、
      // 也不把非法 `command`/`exit_code` 悄悄改成默认值后报 would_pass（那样预检比公开 schema 更宽松，
      // 等于替调用方改意图）。缺省只在**真正未提供**时按既有归一补（`output_ref` 缺省 null），与提交侧同形。
      // `verification` 的 items 原本没有 `additionalProperties:false`：这里**不**新增嵌套闭键要求，
      // 多余键原样忽略（不给旧调用方制造新的拒绝理由）。
      const items: { command: string; exit_code: number; output_ref: string | null }[] = [];
      (p.verification as unknown[]).forEach((v, i) => {
        const at = `verification[${i}]`;
        if (typeof v !== "object" || v === null || Array.isArray(v)) {
          failures.push(`${at} 必须是对象（收到 ${Array.isArray(v) ? "array" : v === null ? "null" : typeof v}）：不静默过滤`);
          return;
        }
        const item = v as Record<string, unknown>;
        const command = item.command;
        if (command === undefined) failures.push(`${at}.command 缺失（schema 的 items 要求 command/exit_code）`);
        else if (typeof command !== "string") failures.push(`${at}.command 必须是字符串（收到 ${typeof command}）`);
        const exitCode = item.exit_code;
        if (exitCode === undefined) failures.push(`${at}.exit_code 缺失（schema 的 items 要求 command/exit_code）`);
        else if (typeof exitCode !== "number" || !Number.isFinite(exitCode)) {
          failures.push(`${at}.exit_code 必须是数字（收到 ${typeof exitCode === "number" ? JSON.stringify(exitCode) : typeof exitCode}）`);
        }
        const outputRef = item.output_ref;
        if (outputRef !== undefined && outputRef !== null && typeof outputRef !== "string") {
          failures.push(`${at}.output_ref 必须是字符串（收到 ${typeof outputRef}）`);
        }
        items.push({
          command: typeof command === "string" ? command : "",
          exit_code: typeof exitCode === "number" && Number.isFinite(exitCode) ? exitCode : -1,
          output_ref: typeof outputRef === "string" ? outputRef : null,
        });
      });
      verification = items;
    }
  }
  let expectedRevision: number | null = null;
  const er = p.expected_revision;
  if (er === undefined || er === null) failures.push("缺必填 expected_revision");
  else if (typeof er !== "number" || !Number.isInteger(er) || er < 0) {
    failures.push(`expected_revision 必须是 0 以上的整数（收到 ${JSON.stringify(er)}）`);
  } else expectedRevision = er;
  const runtimeEntries = p.runtime_entries;
  if (runtimeEntries !== undefined && !Array.isArray(runtimeEntries)) {
    failures.push(`runtime_entries 必须是数组或省略（收到 ${runtimeEntries === null ? "null" : typeof runtimeEntries}）`);
  }
  const diffRef = optStr("diff_ref");
  const resultRevision = optStr("result_revision");
  const ownershipBasis = optStr("ownership_basis");

  if (failures.length > 0) return { ok: false, failures, input: null };

  const input: SubmitResultChecksInput = {
    project_id: projectId,
    task_id: taskId,
    role,
    owner_id: ownerId,
    change_id: changeId,
    claim_token: claimToken,
    expected_revision: expectedRevision as number,
    evidence_refs: evidenceRefs,
    deliverables,
    verification,
    untested,
    known_issues: knownIssues,
    diff_ref: diffRef,
    result_revision: resultRevision,
    ...(runtimeEntries === undefined ? {} : { runtime_entries: runtimeEntries }),
    ...(ownershipBasis === null ? {} : { ownership_basis: ownershipBasis }),
  };
  // 同一份**真实命令信封校验**：非法 role（空/超长）、负版本、非对象 payload、schema_version 等
  // 在这里由**同一份** `validateWorkCommand` 拒——预检不再比真实提交宽松。
  try {
    validateWorkCommand({
      schema_version: SCHEMA_VERSION,
      project_id: projectId,
      change_id: changeId,
      entity_id: taskEntityId(taskId),
      expected_revision: input.expected_revision,
      type: "task.result_submitted",
      actor_id: ownerId,
      role,
      idempotency_key: submitResultIdempotencyKey(taskId, input.expected_revision, changeId, claimToken),
      payload: {
        claim_token: claimToken,
        owner_id: ownerId,
        owner_role: role,
        deliverables,
        evidence_refs: evidenceRefs,
        verification,
        untested,
        known_issues: knownIssues,
        diff_ref: diffRef,
        result_revision: resultRevision,
        ...(runtimeEntries === undefined ? {} : { runtime_entries: runtimeEntries }),
      },
    });
  } catch (e) {
    failures.push(`命令信封校验不通过（同一份 validateWorkCommand）：${e instanceof Error ? e.message : String(e)}`);
  }
  return failures.length === 0 ? { ok: true, failures: [], input } : { ok: false, failures, input: null };
}

// ── 真实结果写边界的锁内门禁（P2 写边界进一步核实） ──

/** 写边界拒因（`service.submit` 的 `detail.reason`） */
export const RESULT_SUBMIT_LOCKIN_DETAIL_REASON = "result_submit_lockin_failed";

/**
 * 在**唯一写入服务的临界区**内，对一条 `task.result_submitted` 命令按**锁内事件**重算当前
 * token/owner/lease/依赖/定义绑定/证据源——与调用层（`claims.submitTaskResult`）和只读预检用
 * **同一份** `evaluateSubmitResultChecks` 判据。直连通用写口手写结果事件因此不能旁路。
 *
 * 只读：不写任何事件/快照/证据、不续租；判不过一律抛 `INVALID_COMMAND`（**零字节落盘**）。
 * 注意：这里**不回显** `claim_token`（`evaluateSubmitResultChecks` 的失败文案已做秘密安全纠正）。
 */
export function assertResultSubmittedWriteCommand(
  events: readonly WorkEvent[],
  cmd: WorkCommand,
  ctx: { dataDir: string; workDir: string },
): void {
  const taskId = cmd.entity_id.startsWith("task:") ? cmd.entity_id.slice("task:".length) : cmd.entity_id;
  const payload = (cmd.payload ?? {}) as Record<string, unknown>;
  // **P2 返工纠正**：`task.result_submitted` 一律按"一次结果交付提交"核实——**没有**"删 token 就跳过全部检查"
  // 的早退。缺/空 `claim_token` 时 `evaluateSubmitResultChecks` 的认领判据直接不通过（拒、零字节）。
  // 想把卡**只置状态**（迁移/回填/夹具）一律走**既有**状态边界 `task.status_changed`（payload.status=
  // "result_submitted"，`migrate.ts` 已这样用）——它不是交付提交，不带交付包，也不冒充结果判据通过。
  const claimToken = typeof payload.claim_token === "string" ? payload.claim_token : "";
  const state = foldTaskStates([...events]).states[taskId] ?? null;
  const outcome = evaluateSubmitResultChecks(
    {
      project_id: cmd.project_id,
      task_id: taskId,
      role: cmd.role,
      owner_id: typeof payload.owner_id === "string" && payload.owner_id !== "" ? payload.owner_id : cmd.actor_id,
      change_id: cmd.change_id,
      claim_token: claimToken,
      expected_revision: cmd.expected_revision ?? 0,
      evidence_refs: Array.isArray(payload.evidence_refs)
        ? payload.evidence_refs.filter((x): x is string => typeof x === "string")
        : [],
      ...(Array.isArray(payload.deliverables) ? { deliverables: payload.deliverables.filter((x): x is string => typeof x === "string") } : {}),
      ...(Array.isArray(payload.verification) ? { verification: payload.verification } : {}),
      ...(Array.isArray(payload.untested) ? { untested: payload.untested.filter((x): x is string => typeof x === "string") } : {}),
      ...(Array.isArray(payload.known_issues) ? { known_issues: payload.known_issues.filter((x): x is string => typeof x === "string") } : {}),
      ...(typeof payload.diff_ref === "string" || payload.diff_ref === null ? { diff_ref: payload.diff_ref as string | null } : {}),
      ...(typeof payload.result_revision === "string" || payload.result_revision === null ? { result_revision: payload.result_revision as string | null } : {}),
      ...(payload.runtime_entries === undefined ? {} : { runtime_entries: payload.runtime_entries }),
      ...(typeof payload.ownership_basis === "string" ? { ownership_basis: payload.ownership_basis } : {}),
    },
    state,
    // 锁内依赖重查用**锁内事件快照**（同源，不再重读一遍盘）；交付必须带证据，与调用层/预检同口径。
    { dataDir: ctx.dataDir, events: { work_dir: ctx.workDir, events: [...events] } },
  );
  if (!outcome.ok) {
    throw new WorkError(
      "INVALID_COMMAND",
      `结果提交锁内核实不通过，拒绝写入（本次命令没有写入任何字节）：${outcome.failures.join("；")}`,
      {
        reason: RESULT_SUBMIT_LOCKIN_DETAIL_REASON,
        entity_id: cmd.entity_id,
        check_code: outcome.code,
        failures: outcome.failures,
      },
    );
  }
}

// ── 幂等前置（预检与真实提交共用同一份键推导与内容比对） ──

/** 结果提交的幂等键推导（`claims` 与预检**完全同一推导**：内嵌认领 token，绝不回显） */
export function submitResultIdempotencyKey(
  taskId: string,
  expectedRevision: number,
  changeId: string,
  claimToken: string,
): string {
  return `${taskId}:task.result_submitted:${expectedRevision + 1}:${changeId}:${claimToken}`;
}

/** 数组字段的宽容读取（幂等内容比对用；非数组按空处理） */
function strListOf(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/**
 * 一次"结果提交"的调用方意图是否与已落盘的原提交一致（幂等重试专用）。
 * 只比**调用方能声明**的字段 + 派生但确定的 run/attempt：忽略服务端产出的 seq/时间戳与 `meaning` 之类常量文案。
 * 发布/交付内容任一不同即视为另一次意图（不冒充重放）。
 */
export function submitResultIntentMatches(existing: Record<string, unknown>, input: SubmitResultChecksInput): boolean {
  const normArr = (v: unknown): string[] => strListOf(v);
  const normNull = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
  const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  return (
    normNull(existing.claim_token) === normNull(input.claim_token) &&
    normNull(existing.owner_id) === normNull(input.owner_id) &&
    normNull(existing.owner_role) === input.role &&
    JSON.stringify(normArr(existing.deliverables)) === JSON.stringify(normArr(input.deliverables)) &&
    JSON.stringify(normArr(existing.evidence_refs)) === JSON.stringify(normArr(input.evidence_refs)) &&
    sameJson(existing.verification ?? [], input.verification ?? []) &&
    sameJson(existing.untested ?? [], input.untested ?? []) &&
    sameJson(existing.known_issues ?? [], input.known_issues ?? []) &&
    normNull(existing.diff_ref) === (input.diff_ref ?? null) &&
    normNull(existing.result_revision) === (input.result_revision ?? null) &&
    normNull(existing.ownership_basis) === (input.ownership_basis === undefined ? null : normNull(input.ownership_basis)) &&
    sameJson(existing.runtime_entries ?? null, input.runtime_entries ?? null)
  );
}

export type SubmitIdempotencyVerdict =
  | { kind: "none" }
  | { kind: "duplicate"; event: WorkEvent }
  | { kind: "conflict"; event: WorkEvent };

/**
 * 幂等前置判定（只读）：命中同一幂等键时，同内容 ⇒ `duplicate`（返回原提交回执），异内容 ⇒ `conflict`。
 * 预检与真实提交共用；预检命中 `duplicate` 时**不冒称当前五查通过**（只回原回执）。
 */
export function evaluateSubmitResultIdempotency(
  events: readonly WorkEvent[],
  input: SubmitResultChecksInput,
): SubmitIdempotencyVerdict {
  const key = submitResultIdempotencyKey(input.task_id, input.expected_revision, input.change_id, input.claim_token);
  const taskEntity = taskEntityId(input.task_id);
  const existing = events.find((e) => e.idempotency_key === key);
  if (existing === undefined) return { kind: "none" };
  if (existing.type !== "task.result_submitted" || existing.entity_id !== taskEntity || !submitResultIntentMatches(existing.payload, input)) {
    return { kind: "conflict", event: existing };
  }
  return { kind: "duplicate", event: existing };
}


