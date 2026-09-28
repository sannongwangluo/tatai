// 任务认领、续约、释放与结果回报（PLAN.md V06-10；DESIGN.md §2.7 任务契约与交接包、§6.7）。
//
// 五条硬口径（每条在代码里都有落点，别混）：
//   ① **原子领取**：领取是"带预期版本的单独一次原子写"——先读当前实体版本，再以 `expected_revision`
//      提交一条 `task.claimed`；版本不符由唯一写入服务拒绝。失败者**重新读状态**，不重复开工（§6.7）。
//      本模块不自己追加事件，一律走 `ClaimSubmitter`（进程内唯一写入服务，或 MCP 侧它的转接客户端）。
//   ② **租约到期 ≠ 旧进程已停止**：租约只表示"当前所有权需核实"（§2.7 逐字）。
//      到期后要重派/继续写，必须先核实旧现场：隔离新工作目录，或确认旧进程已停止且旧认领失效；
//      核实依据（`takeover_basis` / `ownership_basis`）非空才放行，并如实落进事件 payload 供事后追溯。
//   ③ **所有交付检查当前认领 token**：提交结果时重查 任务版本 + 认领 token/持有者 + 租约 + 依赖释放 + 证据（§2.7）。
//   ④ **不承诺 exactly-once**：命令与文件系统不受 token 自动保护，执行器仍要自己落实目录隔离和进程终止（§2.7）。
//   ⑤ **只读入口不认领**：认领写口只有本模块；`entry.ts` 只读现场事实（§6.7）。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getProject, resolveDataDir } from "../registry";
import { nowIso, compareIsoTime } from "../time";
import { projectWorkDir } from "../workstation";
import {
  BUDGET_FILE,
  budgetBlockedIdempotencyKey,
  budgetBlockedPayload,
  budgetEntityId,
  checkProjectBudget,
  countTaskClaims,
  isBudgetExhaustedError,
  isForgedRenewError,
  readProjectBudget,
} from "./budget";
import { loadDocuments, activeBaseline } from "./documents";
import { loadEvents } from "./eventStore";
import { evidenceBlobPath, readEvidence } from "./evidence";
import { importTaskDefinitions, taskDefinitionHash, type TaskDefinition } from "./plan";
import { dependencyRelease, projectFromFacts } from "./statusProjection";
import {
  assertReopenPayload,
  foldTaskStates,
  readTaskStates,
  taskEntityId,
  TASK_STATUS_LABELS,
  type ReopenPayload,
  type TaskState,
} from "./tasks";
import {
  NO_CHANGE_ID,
  SCHEMA_VERSION,
  WorkError,
  isWorkError,
  type WorkCommand,
  type WorkErrorCode,
  type WorkEvent,
  type WorkReceipt,
} from "./types";

// ── 租约与工作目录口径 ──

/** 租约语义的**唯一措辞**（§2.7 原文口径；回执与界面都用它，不许改写成"旧进程已停止"） */
export const LEASE_NOTE = "租约到期只表示「当前所有权需核实」，不证明旧进程已停止（DESIGN.md §2.7）";

/** 缺省租约时长：15 分钟（长任务靠 `renew` 心跳续约，不靠长租约赌进程活着） */
export const DEFAULT_LEASE_MS = 15 * 60 * 1000;

/** 隔离工作目录的缺省落点（项目根内相对路径，POSIX 分隔符）：一次 attempt 一个目录 */
export const WORKSPACE_ROOT_REL = ".工作台/runs";

/** 重派写任务前必须先满足的前置条件（§2.7 逐字口径：隔离目录 或 确认旧进程停止 + 旧认领失效） */
export const RESUME_PRECONDITIONS = [
  "读最后检查点，核对旧 run 的工作目录与未提交改动（确认旧 run 是否仍有写入可能）",
  "隔离新工作目录，或确认旧进程已停止且旧认领失效（**无心跳不等于进程已停止**，DESIGN.md §2.7）",
  "确认可继承的成果与仍有效的证据（旧证据绑在旧代码版本上就要重新验证，§5.6）",
] as const;

/** 一次认领的凭证（§2.7：认领后追加 run_id/attempt_id/owner_id/claim_token/lease_expires_at/workspace） */
export interface TaskClaim {
  task_id: string;
  /** 认领前读到的实体版本（乐观并发；null = 期望该实体尚不存在） */
  expected_revision: number | null;
  /** 认领成功后的实体版本（回执给的；下一次写要拿它当 expected_revision） */
  entity_revision: number;
  owner_id: string;
  /** 认领者角色（写进事件 payload；租约到期后据此判断"是不是本角色该续的任务"） */
  owner_role: string;
  run_id: string;
  attempt_id: string;
  /** 第几次尝试（从 1 起；重派 +1，不覆盖旧 attempt 的记录） */
  attempt: number;
  claim_token: string;
  lease_expires_at: string;
  /** 隔离工作目录（项目根内相对路径或调用方给的实际路径；**隔离由执行器落实**） */
  workspace: string;
  change_id: string;
  acquired_at: string;
  /** 重派/接手时如实记下的核实依据（首次认领为 null） */
  takeover_basis: string | null;
}

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

/** 新的认领令牌（不可猜测；不落仓库、不外发到项目正文） */
export function newClaimToken(): string {
  return `clm-${crypto.randomBytes(18).toString("base64url")}`;
}

/** 缺省隔离工作目录（项目根内相对路径；每个 attempt 一个，避免两个执行者改同一份工作树） */
export function defaultWorkspace(taskId: string, attemptId: string): string {
  const safe = (s: string): string => s.replace(/[^A-Za-z0-9._-]+/g, "-");
  return `${WORKSPACE_ROOT_REL}/${safe(taskId)}/${safe(attemptId)}`;
}

// ── 事件 → 认领记录（读侧；entry.ts 用它核对未结束 run 与现场） ──

/** 从事件还原出的一条认领记录（payload 字段 + 事件本身的 actor/role/时间） */
export interface ClaimRecord {
  task_id: string;
  /** claim/renew/release；V09-10 起 reopen = 协调器重开（**终止旧认领效力**：旧 token 即刻作废） */
  action: "claim" | "renew" | "release" | "reopen";
  owner_id: string | null;
  owner_role: string | null;
  run_id: string | null;
  attempt_id: string | null;
  attempt: number | null;
  claim_token: string | null;
  lease_expires_at: string | null;
  workspace: string | null;
  takeover_basis: string | null;
  change_id: string;
  /** 事件 role（角色名不是安全凭证，这里只作协作记录，§6.5） */
  role: string;
  actor_id: string;
  at: string;
  event_id: string;
}

const strOrNull = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/** 一条事件能不能读成认领记录（`task.claimed`；带 `claim_released: true` 的 `task.status_changed` 读成释放；
 *  V09-10 起 `task.reopened` 读成 reopen——协调器重开**终止旧认领效力**（旧 token 作废，附录 F）） */
export function claimRecordOfEvent(e: WorkEvent): ClaimRecord | null {
  const taskId = e.entity_id.startsWith("task:") ? e.entity_id.slice("task:".length) : null;
  if (taskId === null || taskId === "") return null;
  const p = e.payload;
  if (e.type === "task.claimed") {
    return {
      task_id: taskId,
      action: strOrNull(p.claim_action) === "renew" ? "renew" : "claim",
      owner_id: strOrNull(p.owner_id),
      owner_role: strOrNull(p.owner_role),
      run_id: strOrNull(p.run_id),
      attempt_id: strOrNull(p.attempt_id),
      attempt: typeof p.attempt === "number" ? p.attempt : null,
      claim_token: strOrNull(p.claim_token),
      lease_expires_at: strOrNull(p.lease_expires_at),
      workspace: strOrNull(p.workspace),
      takeover_basis: strOrNull(p.takeover_basis),
      change_id: e.change_id,
      role: e.role,
      actor_id: e.actor_id,
      at: e.received_at,
      event_id: e.event_id,
    };
  }
  if (e.type === "task.reopened") {
    return {
      task_id: taskId,
      action: "reopen",
      owner_id: null, // 重开是协调器动作，任务在那一刻**没有持有者**（旧认领作废）
      owner_role: e.role,
      run_id: strOrNull(p.run_id),
      attempt_id: strOrNull(p.attempt_id),
      attempt: typeof p.attempt === "number" ? p.attempt : null,
      claim_token: null,
      lease_expires_at: null,
      workspace: strOrNull(p.workspace),
      takeover_basis: null,
      change_id: e.change_id,
      role: e.role,
      actor_id: e.actor_id,
      at: e.received_at,
      event_id: e.event_id,
    };
  }
  if (e.type === "task.status_changed" && p.claim_released === true) {
    return {
      task_id: taskId,
      action: "release",
      owner_id: strOrNull(p.owner_id),
      owner_role: strOrNull(p.owner_role),
      run_id: strOrNull(p.run_id),
      attempt_id: strOrNull(p.attempt_id),
      attempt: null,
      claim_token: strOrNull(p.claim_token),
      lease_expires_at: null,
      workspace: null,
      takeover_basis: null,
      change_id: e.change_id,
      role: e.role,
      actor_id: e.actor_id,
      at: e.received_at,
      event_id: e.event_id,
    };
  }
  return null;
}

/** 按任务归集认领记录（时间正序） */
export function claimRecordsOf(events: readonly WorkEvent[]): Record<string, ClaimRecord[]> {
  const out: Record<string, ClaimRecord[]> = {};
  for (const e of events) {
    const rec = claimRecordOfEvent(e);
    if (rec === null) continue;
    (out[rec.task_id] ??= []).push(rec);
  }
  // 认领记录的 `at` 是事件 `received_at`（产品钟），但一律按真实时刻比：口径统一、跨机混写也不出错。
  for (const list of Object.values(out)) list.sort((a, b) => compareIsoTime(a.at, b.at));
  return out;
}

/** 某任务当前的持有记录（最后一条 claim/renew；被 release 或**重开**（附录 F：旧认领作废）打断就返回 null） */
export function liveClaimRecord(records: readonly ClaimRecord[] | undefined): ClaimRecord | null {
  if (records === undefined || records.length === 0) return null;
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const rec = records[i];
    if (rec.action === "release" || rec.action === "reopen") return null;
    if (rec.action === "claim" || rec.action === "renew") return rec;
  }
  return null;
}

// ── 提交接口（进程内唯一写入服务 / MCP 转接客户端都满足；允许异步） ──

export interface ClaimSubmitter {
  submit(command: unknown): WorkReceipt | Promise<WorkReceipt>;
}

/** 回报后要读的下一动作（只读入口的实现是 `entry.evaluateProjectEntry`；注入以免 entry ↔ claims 循环依赖） */
export interface NextActionReader {
  (projectId: string, query: { role: string; client_capabilities?: unknown; known_revision?: string | null }): {
    next_action: string;
    reasons: { code: string; text: string }[];
    required_reads: unknown[];
  };
}

/** 盘上事件（只读；残缺尾行按 V06-01 口径隔离记录，不粘行） */
export function readClaimEvents(workDir: string): WorkEvent[] {
  return loadEvents(workDir).events;
}

function workDirOf(projectId: string, dataDir?: string): string {
  const project = getProject(projectId, dataDir);
  if (!project) {
    throw new WorkError("INVALID_COMMAND", `项目不存在: ${projectId}`, { project_id: projectId });
  }
  return projectWorkDir(projectId, dataDir);
}

function dataDirOr(dataDir?: string): string {
  return dataDir ?? resolveDataDir();
}

function taskCommand(args: {
  project_id: string;
  change_id: string;
  task_id: string;
  type: string;
  actor_id: string;
  role: string;
  expected_revision: number | null;
  occurred_at?: string;
  /**
   * 幂等键。**认领/续约/释放/提交都要带上"这是谁的哪一次意图"**（owner + token）：
   * 不带的话两个客户端抢同一张卡会算出同一个键，第二个拿到的是 IDEMPOTENCY_CONFLICT（"同键异内容"），
   * 而不是"版本已被抢走"的明确拒绝。带上之后：同一次意图重发 = 同键同内容（返回原回执），
   * 两个客户端 = 不同键 + 版本检查 → 只有一个成功（§6.7 的原子领取）。
   */
  idempotency_key: string;
  payload: Record<string, unknown>;
}): WorkCommand {
  return {
    schema_version: SCHEMA_VERSION,
    project_id: args.project_id,
    change_id: args.change_id,
    entity_id: taskEntityId(args.task_id),
    expected_revision: args.expected_revision,
    type: args.type,
    actor_id: args.actor_id,
    role: args.role,
    idempotency_key: args.idempotency_key,
    ...(args.occurred_at === undefined ? {} : { occurred_at: args.occurred_at }),
    payload: args.payload,
  };
}

/** 写失败的统一形状（**明确拒绝**：调用方据此重新读状态，不重复开工） */
export type ClaimFailureCode =
  | WorkErrorCode
  | "CLAIM_HELD"
  | "CLAIM_NOT_YOURS"
  | "LEASE_NEEDS_VERIFICATION"
  | "DEPENDENCY_UNMET"
  | "EVIDENCE_MISSING"
  | "NOT_CLAIMABLE"
  /** 项目预算约束到顶：领取下一任务被拒（§5.7；已落 `budget.blocked` 留证） */
  | "BUDGET_EXHAUSTED";

export interface ClaimFailure {
  ok: false;
  code: ClaimFailureCode;
  message: string;
  /** 明确拒绝时如实给出的现场（重新读状态的入口） */
  current_revision: number | null;
  read_again: string;
  /** 逐条失败项（如实，不合并成一句） */
  failures: string[];
}
export type ClaimOutcome<T> = ({ ok: true } & T) | ClaimFailure;

function failure(
  code: ClaimFailureCode,
  message: string,
  projectId: string,
  taskId: string,
  workDir: string,
  extra: { current_revision?: number | null; failures?: string[] } = {},
): ClaimFailure {
  return {
    ok: false,
    code,
    message,
    current_revision: extra.current_revision ?? null,
    read_again: `重新读状态：project_entry(project_id=${projectId})；事件文件 ${path.join(workDir, "events.jsonl")}（任务 ${taskId}）`,
    failures: extra.failures ?? [message],
  };
}

/** 认领事件的 payload（§2.7 追加字段 + 核实依据；`claim_action` 区分首次认领与续约） */
function claimPayloadOf(claim: TaskClaim, action: "claim" | "renew"): Record<string, unknown> {
  return {
    claim_action: action,
    owner_id: claim.owner_id,
    owner_role: claim.owner_role,
    run_id: claim.run_id,
    attempt_id: claim.attempt_id,
    attempt: claim.attempt,
    claim_token: claim.claim_token,
    lease_expires_at: claim.lease_expires_at,
    workspace: claim.workspace,
    takeover_basis: claim.takeover_basis,
  };
}

/**
 * 落一条 `budget.blocked` 留证事件（项目级实体 `budget:<project_id>`；`change_id` 用 `NO_CHANGE_ID`）。
 * 达到项目预算约束导致认领被拒时，先把"谁在什么时候被谁的预算挡住"记进事件流，再返回 failure——
 * 拒绝不是静默的。幂等键与写入边界代写同一推导（`budget.budgetBlockedIdempotencyKey`）：
 * 同一次意图重发命中幂等，不同任务或不同用量各自留一条（口径同 §6.7 的认领幂等键思路）。
 *
 * 并发兜底（C-017 补修）：budget 实体是项目级单实体，两个并发拒绝（或写入边界代写的留证）
 * 可能在我们读版本之后先推进它——乐观并发**有界重试**：撞 VERSION_CONFLICT 就重新读版本再交；
 * 同键同内容命中幂等会直接返回原回执，不会多落一条。重试耗尽仍撞就如实抛出（不装成功）。
 */
async function submitBudgetBlocked(
  args: {
    projectId: string;
    taskId: string;
    ownerId: string;
    role: string;
    usage: number;
    max: number | null;
    occurredAt?: string;
  },
  submitter: ClaimSubmitter,
  workDir: string,
): Promise<void> {
  const entityId = budgetEntityId(args.projectId);
  const key = budgetBlockedIdempotencyKey(entityId, args.taskId, args.usage, args.max, args.ownerId);
  const payload = budgetBlockedPayload(args.usage, args.max, args.taskId);
  let lastConflict: unknown = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const events = readClaimEvents(workDir);
    // 同键同内容的留证已在流里（例如写入边界门禁刚代写过这次拒绝）：留证意图已满足，直接返回。
    // 不能换个期望版本重交——幂等口径（service.sameIntent）把 expected_revision 也算进"意图"，
    // 同键异期望会被判 IDEMPOTENCY_CONFLICT；留证是"记一笔"，不是"推进实体"，已存在即成功。
    const existing = events.find((e) => e.idempotency_key === key);
    if (existing !== undefined) {
      if (JSON.stringify(existing.payload) === JSON.stringify(payload)) return;
      throw new WorkError("IDEMPOTENCY_CONFLICT",
        `budget.blocked 留证键已用于不同内容：${key}（原事件 ${existing.event_id}，序号 ${existing.seq}）——不覆盖他人留证`,
        { idempotency_key: key, existing_event_id: existing.event_id, existing_seq: existing.seq });
    }
    // 项目级单实体：期望版本＝现有 `budget.blocked` 事件里的最大实体版本（0 = 还没有）
    const current = events.reduce(
      (rev, e) => (e.entity_id === entityId && e.entity_revision > rev ? e.entity_revision : rev),
      0,
    );
    try {
      await submitter.submit({
        schema_version: SCHEMA_VERSION,
        project_id: args.projectId,
        change_id: NO_CHANGE_ID,
        entity_id: entityId,
        expected_revision: current,
        type: "budget.blocked",
        actor_id: args.ownerId,
        role: args.role,
        idempotency_key: key,
        ...(args.occurredAt === undefined ? {} : { occurred_at: args.occurredAt }),
        payload,
      });
      return;
    } catch (e) {
      if (isWorkError(e) && e.code === "VERSION_CONFLICT") {
        lastConflict = e;
        continue;
      }
      throw e;
    }
  }
  throw lastConflict;
}

function versionConflictFailure(
  e: unknown,
  projectId: string,
  taskId: string,
  workDir: string,
  what: string,
): ClaimFailure {
  const detail = e instanceof WorkError ? e.detail : {};
  return failure("VERSION_CONFLICT", `${what}被拒（原子写版本检查）：${(e as Error).message}`, projectId, taskId, workDir, {
    current_revision: typeof detail.current_revision === "number" ? (detail.current_revision as number) : null,
  });
}

// ── 原子领取 ──

export interface ClaimTaskInput {
  project_id: string;
  task_id: string;
  role: string;
  owner_id: string;
  change_id: string;
  /** 领取前读到的实体版本；不给就现读（原子性由唯一写入服务的版本检查保证） */
  expected_revision?: number | null;
  /** 隔离工作目录（缺省给 `.工作台/runs/<task>/<attempt_id>`） */
  workspace?: string;
  lease_ms?: number;
  run_id?: string;
  attempt?: number;
  attempt_id?: string;
  /**
   * 旧认领已到期仍要接手时的核实依据：写清"隔离了新工作目录"或
   * "确认旧进程已停止且旧认领失效"。空 = 拒绝重派。
   */
  takeover_basis?: string;
  occurred_at?: string;
  /** 验证钩子：把"现在"固定下来（产品路径不传） */
  now?: string;
}

export interface ClaimTaskSuccess {
  claim: TaskClaim;
  receipt: WorkReceipt;
  /** 旧认领的现场（首次认领为 null；重派时如实带出，便于事后追溯） */
  previous: ClaimRecord | null;
}

/**
 * 原子领取一张任务卡。
 * 顺序：读状态 → 拒绝已取消/已被有效认领（除非给核实依据）→ 带 `expected_revision` 的一次原子写。
 * 版本冲突、已被持有、租约需核实一律**明确拒绝**并给重新读状态的入口，不静默抢。
 */
export async function claimTask(
  input: ClaimTaskInput,
  submitter: ClaimSubmitter,
  dataDir?: string,
): Promise<ClaimOutcome<ClaimTaskSuccess>> {
  const workDir = workDirOf(input.project_id, dataDir);
  const projectId = input.project_id;
  const taskId = input.task_id;
  const state: TaskState | null = readTaskStates(workDir).states[taskId] ?? null;
  if (state === null) {
    return failure(
      "INVALID_COMMAND",
      `任务 ${taskId} 在当前事件现场里没有运行状态：先导入施工定义（task.definition_imported）再领取`,
      projectId,
      taskId,
      workDir,
    );
  }
  if (state.cancelled) {
    return failure(
      "INVALID_COMMAND",
      `任务 ${taskId} 已取消（${state.cancel_reason ?? "无理由"}）：不能领取已取消的任务`,
      projectId,
      taskId,
      workDir,
      { current_revision: state.revision },
    );
  }
  if (state.status === "result_submitted") {
    return failure(
      "NOT_CLAIMABLE",
      `任务 ${taskId} 当前是「${TASK_STATUS_LABELS[state.status]}」：要重做请由协调器建立新 attempt/新任务，不覆盖已提交的结果`,
      projectId,
      taskId,
      workDir,
      { current_revision: state.revision },
    );
  }

  // ── 项目预算约束（§5.7 / TPL-10 §六③）──
  // 约束的是"领取下一任务"：用量＝本项目已提交的 `task.claimed` 计数（renew/release 不算，见 countTaskClaims）。
  // 读配置失败一律**抛出**（fail-closed）：坏 budget.json 不静默当不限，也不放行认领。
  // 注意（C-017 批3终审补修）：这里只是**劝告性预查**——读到提交之间用量可能被别人推进；
  // 权威门禁在唯一写入服务的文件锁里（service.ts submit ②′），并发越限由它兜底并在锁内落留证，
  // 本函数在提交失败的 catch 里把那份拒绝翻译回 BUDGET_EXHAUSTED（不重复留证）。
  const budget = readProjectBudget(workDir);
  const usage = countTaskClaims(readClaimEvents(workDir));
  const budgetCheck = checkProjectBudget(budget, usage);
  if (budgetCheck.status === "exhausted") {
    // 先落留证事件再拒：拒绝本身也要有证据（谁/何时/被哪条预算挡住），不静默失败。
    await submitBudgetBlocked(
      {
        projectId,
        taskId,
        ownerId: input.owner_id,
        role: input.role,
        usage,
        max: budget.max_task_claims,
        occurredAt: input.occurred_at,
      },
      submitter,
      workDir,
    );
    return failure(
      "BUDGET_EXHAUSTED",
      `领取被拒：项目预算约束已达上限（已认领 ${usage} 次 / 上限 ${budget.max_task_claims} 次），剩余可认领 0 次。` +
        "达到约束不是省略验证的理由（DESIGN.md §5.7）。" +
        `可调整项目预算配置文件 ${path.join(workDir, BUDGET_FILE)}（提高 max_task_claims，或设为 null 表示不限），` +
        "或收口本轮变更后重新开工；本次拒绝已落一条 budget.blocked 留证事件",
      projectId,
      taskId,
      workDir,
      {
        current_revision: state.revision,
        failures: [`项目预算已达上限：已认领 ${usage} 次 / 上限 ${budget.max_task_claims} 次（剩余可认领 0 次）`],
      },
    );
  }

  // 租约算术用**毫秒精度**的 ISO（`nowIso()` 只到秒：秒级以下租约会被算成"还没到期"）；
  // `acquired_at` 仍用本地时间戳给人和日志看。
  const now = input.now ?? new Date().toISOString();
  const acquiredAt = input.now ?? nowIso();
  // 依赖门禁（fail-closed）：领取也要核对依赖释放，否则"只从就绪队列领"这条规则可以被直连调用绕过。
  // 口径与提交时一致：用 V06-09 的 `dependencyRelease`，不看前置自报 done（§5.8）。
  const dependency = dependencyRecheck(projectId, taskId, dataDir);
  if (!dependency.ok) {
    return failure(
      "DEPENDENCY_UNMET",
      `领取被拒：任务的依赖还不满足——${dependency.failures.join("；")}`,
      projectId,
      taskId,
      workDir,
      { current_revision: state.revision, failures: dependency.failures },
    );
  }
  const held = liveClaimRecord(claimRecordsOf(readClaimEvents(workDir))[taskId]);
  const heldLease = leaseStateOf(held?.lease_expires_at ?? null, now);
  const takeover = (input.takeover_basis ?? "").trim();
  if (held !== null && heldLease !== "expired") {
    return failure(
      "CLAIM_HELD",
      `任务 ${taskId} 已被 ${held.owner_id ?? "(未知持有者)"} 认领（role=${held.owner_role ?? held.role}，` +
        `租约 ${held.lease_expires_at ?? "未知"}）：不覆盖他人的有效认领（DESIGN.md §6.5）。` +
        "要接手请等它到期、让持有者释放，或由协调器显式重派",
      projectId,
      taskId,
      workDir,
      { current_revision: state.revision },
    );
  }
  if (held !== null && heldLease === "expired" && takeover === "") {
    return failure(
      "LEASE_NEEDS_VERIFICATION",
      `任务 ${taskId} 的旧认领（${held.owner_id ?? "未知"}）租约已到期：${LEASE_NOTE}。` +
        "重派前必须核实旧现场（隔离新工作目录，或确认旧进程已停止且旧认领失效），把核实依据写进 takeover_basis",
      projectId,
      taskId,
      workDir,
      { current_revision: state.revision },
    );
  }

  const expected = input.expected_revision === undefined ? state.revision : input.expected_revision;
  if (expected !== null && expected !== state.revision) {
    return failure(
      "VERSION_CONFLICT",
      `领取被拒：调用方声明的 expected_revision=${expected}，当前实体版本是 ${state.revision}（有人先你一步改了这张卡）`,
      projectId,
      taskId,
      workDir,
      { current_revision: state.revision },
    );
  }

  // V09-10：重开后的认领沿用重开宣告的 attempt（held 为 null 时优先取状态里重放出的 attempt——
  // 首次认领（state.attempt 为 null）仍是 1，与旧口径逐字一致）
  const attempt = input.attempt ?? (held === null ? state.attempt ?? 1 : (held.attempt ?? 1) + 1);
  const runId = input.run_id ?? `run-${taskId}-${attempt}`;
  const attemptId = input.attempt_id ?? `att-${taskId}-${attempt}-${crypto.randomBytes(4).toString("hex")}`;
  const claim: TaskClaim = {
    task_id: taskId,
    expected_revision: expected,
    entity_revision: 0,
    owner_id: input.owner_id,
    owner_role: input.role,
    run_id: runId,
    attempt_id: attemptId,
    attempt,
    claim_token: newClaimToken(),
    lease_expires_at: new Date(Date.parse(now) + (input.lease_ms ?? DEFAULT_LEASE_MS)).toISOString(),
    workspace: input.workspace ?? defaultWorkspace(taskId, attemptId),
    change_id: input.change_id,
    acquired_at: acquiredAt,
    takeover_basis: takeover === "" ? null : takeover,
  };
  try {
    const receipt = await submitter.submit(
      taskCommand({
        project_id: projectId,
        change_id: input.change_id,
        task_id: taskId,
        type: "task.claimed",
        actor_id: input.owner_id,
        role: input.role,
        expected_revision: expected,
        // 幂等键带上"谁的哪次认领"：两个客户端的键必须不同，才能落到版本检查上（§6.7）
        idempotency_key: `${taskId}:task.claimed:${(expected ?? 0) + 1}:${input.change_id}:${input.owner_id}:${claim.claim_token}`,
        ...(input.occurred_at === undefined ? {} : { occurred_at: input.occurred_at }),
        // near（且非 exhausted）：认领照常，payload 追加可选 `budget` 让回执可见剩余工作（§5.7）；
        // ok / 不限一律**不带**这个键——旧路径产出的 `task.claimed` 逐字节不变。
        payload: {
          ...claimPayloadOf(claim, "claim"),
          ...(budgetCheck.status === "near"
            ? { budget: { usage: budgetCheck.usage, max: budgetCheck.max, remaining: budgetCheck.remaining } }
            : {}),
        },
      }),
    );
    claim.entity_revision = receipt.entity_revision;
    return { ok: true, claim, receipt, previous: held };
  } catch (e) {
    if (isWorkError(e) && e.code === "VERSION_CONFLICT") {
      return versionConflictFailure(e, projectId, taskId, workDir, "领取");
    }
    // 写入边界预算门禁（C-017 批3终审补修）：预查之后、提交之前用量被别人推进到顶——
    // 唯一写入服务已在锁内落 budget.blocked 留证，这里只把拒绝如实翻译给调用方（不重复留证）。
    if (isBudgetExhaustedError(e)) {
      const d = e.detail as Record<string, unknown>;
      const u = typeof d.usage === "number" ? d.usage : usage;
      const m = typeof d.max === "number" ? (d.max as number) : budget.max_task_claims;
      return failure(
        "BUDGET_EXHAUSTED",
        `领取被拒：项目预算约束已达上限（已认领 ${u} 次 / 上限 ${m} 次），剩余可认领 0 次。` +
          "达到约束不是省略验证的理由（DESIGN.md §5.7）。" +
          `可调整项目预算配置文件 ${path.join(workDir, BUDGET_FILE)}（提高 max_task_claims，或设为 null 表示不限），` +
          "或收口本轮变更后重新开工；本次拒绝已由唯一写入服务在写入临界区内落 budget.blocked 留证事件",
        projectId,
        taskId,
        workDir,
        {
          current_revision: state.revision,
          failures: [`项目预算已达上限：已认领 ${u} 次 / 上限 ${m} 次（剩余可认领 0 次；并发越限由写入边界兜底拒绝）`],
        },
      );
    }
    throw e;
  }
}

// ── 续约 / 释放 ──

export interface RenewClaimInput {
  project_id: string;
  task_id: string;
  role: string;
  owner_id: string;
  change_id: string;
  claim_token: string;
  expected_revision: number;
  workspace?: string;
  lease_ms?: number;
  now?: string;
}

/** 续约（心跳）：只允许持有者续自己那一次认领，token 不符明确拒绝 */
export async function renewClaim(
  input: RenewClaimInput,
  submitter: ClaimSubmitter,
  dataDir?: string,
): Promise<ClaimOutcome<{ claim: TaskClaim; receipt: WorkReceipt }>> {
  const workDir = workDirOf(input.project_id, dataDir);
  const state = readTaskStates(workDir).states[input.task_id] ?? null;
  if (state === null) {
    return failure("INVALID_COMMAND", `任务 ${input.task_id} 没有运行状态`, input.project_id, input.task_id, workDir);
  }
  if (state.claim_token !== input.claim_token) {
    return failure(
      "CLAIM_NOT_YOURS",
      `续约被拒：任务 ${input.task_id} 当前认领 token 与调用方给的不一致（只有持有者能续自己那一次认领，DESIGN.md §6.5）`,
      input.project_id,
      input.task_id,
      workDir,
      { current_revision: state.revision },
    );
  }
  if (state.status !== "claimed" && state.status !== "executing") {
    return failure(
      "NOT_CLAIMABLE",
      `续约被拒：任务 ${input.task_id} 当前状态是「${TASK_STATUS_LABELS[state.status]}」，不是认领/执行中`,
      input.project_id,
      input.task_id,
      workDir,
      { current_revision: state.revision },
    );
  }
  const now = input.now ?? new Date().toISOString();
  const renewStamp = input.now ?? nowIso();
  const held = liveClaimRecord(claimRecordsOf(readClaimEvents(workDir))[input.task_id]);
  const claim: TaskClaim = {
    task_id: input.task_id,
    expected_revision: input.expected_revision,
    entity_revision: 0,
    owner_id: input.owner_id,
    owner_role: input.role,
    run_id: held?.run_id ?? `run-${input.task_id}`,
    attempt_id: held?.attempt_id ?? `att-${input.task_id}`,
    attempt: held?.attempt ?? 1,
    claim_token: input.claim_token,
    lease_expires_at: new Date(Date.parse(now) + (input.lease_ms ?? DEFAULT_LEASE_MS)).toISOString(),
    workspace: input.workspace ?? held?.workspace ?? defaultWorkspace(input.task_id, held?.attempt_id ?? `att-${input.task_id}`),
    change_id: input.change_id,
    acquired_at: renewStamp,
    takeover_basis: null,
  };
  try {
    const receipt = await submitter.submit(
      taskCommand({
        project_id: input.project_id,
        change_id: input.change_id,
        task_id: input.task_id,
        type: "task.claimed",
        actor_id: input.owner_id,
        role: input.role,
        expected_revision: input.expected_revision,
        idempotency_key: `${input.task_id}:task.claimed:renew:${input.expected_revision + 1}:${input.change_id}:${claim.claim_token}:${claim.lease_expires_at}`,
        payload: claimPayloadOf(claim, "renew"),
      }),
    );
    claim.entity_revision = receipt.entity_revision;
    return { ok: true, claim, receipt };
  } catch (e) {
    if (isWorkError(e) && e.code === "VERSION_CONFLICT") {
      return versionConflictFailure(e, input.project_id, input.task_id, workDir, "续约");
    }
    // 写入边界续约核实（C017 回炉）：预查之后现场可能被推进（如认领被释放/任务被交付），
    // 唯一写入服务在锁内凭事件现场复核不通过——把拒绝如实翻译给调用方（零字节，不落任何事件）。
    if (isForgedRenewError(e)) {
      const d = e.detail as Record<string, unknown>;
      const boundaryFailures = Array.isArray(d.failures) ? (d.failures as string[]) : [e.message];
      return failure(
        "CLAIM_NOT_YOURS",
        `续约被拒：唯一写入服务核实不通过——${boundaryFailures.join("；")}。` +
          "续约资格以写入临界区里的事件现场为准（当前有效认领 + 持有者 token/身份 + 任务状态 + 新租约），请重新读状态",
        input.project_id,
        input.task_id,
        workDir,
        { current_revision: state.revision, failures: boundaryFailures },
      );
    }
    throw e;
  }
}

export interface ReleaseClaimInput {
  project_id: string;
  task_id: string;
  role: string;
  owner_id: string;
  change_id: string;
  claim_token: string;
  expected_revision: number;
  reason?: string;
}

/** 释放认领（主动交回，任务回到「就绪」）；token 不符明确拒绝 */
export async function releaseClaim(
  input: ReleaseClaimInput,
  submitter: ClaimSubmitter,
  dataDir?: string,
): Promise<ClaimOutcome<{ receipt: WorkReceipt }>> {
  const workDir = workDirOf(input.project_id, dataDir);
  const state = readTaskStates(workDir).states[input.task_id] ?? null;
  if (state === null) {
    return failure("INVALID_COMMAND", `任务 ${input.task_id} 没有运行状态`, input.project_id, input.task_id, workDir);
  }
  if (state.claim_token !== input.claim_token) {
    return failure(
      "CLAIM_NOT_YOURS",
      `释放被拒：任务 ${input.task_id} 当前认领 token 与调用方给的不一致`,
      input.project_id,
      input.task_id,
      workDir,
      { current_revision: state.revision },
    );
  }
  try {
    const receipt = await submitter.submit(
      taskCommand({
        project_id: input.project_id,
        change_id: input.change_id,
        task_id: input.task_id,
        type: "task.status_changed",
        actor_id: input.owner_id,
        role: input.role,
        expected_revision: input.expected_revision,
        idempotency_key: `${input.task_id}:task.released:${input.expected_revision + 1}:${input.change_id}:${input.claim_token}`,
        payload: {
          status: "ready",
          claim_released: true,
          claim_token: input.claim_token,
          owner_id: input.owner_id,
          owner_role: input.role,
          run_id: state.run_id,
          attempt_id: state.attempt_id,
          reason: input.reason ?? "持有者主动释放认领",
        },
      }),
    );
    return { ok: true, receipt };
  } catch (e) {
    if (isWorkError(e) && e.code === "VERSION_CONFLICT") {
      return versionConflictFailure(e, input.project_id, input.task_id, workDir, "释放");
    }
    throw e;
  }
}

// ── 提交结果：版本 / 认领 / 租约 / 依赖 / 证据 五查 ──

export interface SubmitResultInput {
  project_id: string;
  task_id: string;
  role: string;
  owner_id: string;
  change_id: string;
  /** 本次认领的 token（所有交付检查当前认领 token） */
  claim_token: string;
  /** 提交前读到的实体版本（必须与现场一致） */
  expected_revision: number;
  /** 交付物（§2.7 交接包必含项之一） */
  deliverables: string[];
  /** 证据引用（≥1：无证据的"完成"不收，§5.5/§6.7） */
  evidence_refs: string[];
  /** 实际验证命令与退出码（§5.4 交付包） */
  verification?: { command: string; exit_code: number; output_ref?: string | null }[];
  /** 未测项与已知问题（如实；空数组也要显式给） */
  untested?: string[];
  known_issues?: string[];
  /** 结果 diff/内容哈希的取回位置 */
  diff_ref?: string | null;
  /** 结果绑定的代码/内容版本（复核基准，§5.6） */
  result_revision?: string | null;
  /**
   * 补修 **F3**：本次交付声明的**可体验运行入口**（场景 / 入口 / 验证时间 / 结果或不可用原因）。
   *
   * 形状与读侧校验**完全复用** `work/runtimeEntries.ts`（只收 http(s)、`verified_at` 必须解析出真实时刻、
   * 非 `reachable` 必须写原因）；版本绑定复用上面的 `result_revision`，因此不新增存储、不新增字段来源。
   * 缺省＝这次回报没声明入口，**不是错误**，旧调用行为不变。闸门与成果登记同口径：**在读侧**
   * （非法登记读回来是 `EVENT_INVALID`，不静默丢一条入口）。
   */
  runtime_entries?: unknown;
  /** 租约已到期仍要提交时的核实依据（"怎么确认所有权是我"） */
  ownership_basis?: string;
  occurred_at?: string;
  now?: string;
}

export interface SubmitResultSuccess {
  receipt: WorkReceipt;
  claim_token: string;
  /** 五查的实际结论（如实回给调用方） */
  rechecks: {
    revision: string;
    dependencies: string[];
    claim: string;
    lease: string;
    evidence: string;
    external_evidence_refs: string[];
  };
  /** 回报后读取的下一动作（调用方注入 reader 时才有：§6.7 的循环收口） */
  next_action: string | null;
  next_reasons: { code: string; text: string }[];
  next_required_reads: unknown[];
}

/**
 * 提交结果（重查五件事后再写）。任何一条查不过就**明确拒绝**并给重新读状态的入口；
 * 查过之后写 `task.result_submitted`（payload 带认领 token 与交付包字段，便于事后审计追溯）。
 */
export async function submitTaskResult(
  input: SubmitResultInput,
  deps: { submitter: ClaimSubmitter; readNextAction?: NextActionReader },
  dataDir?: string,
): Promise<ClaimOutcome<SubmitResultSuccess>> {
  const workDir = workDirOf(input.project_id, dataDir);
  const projectId = input.project_id;
  const taskId = input.task_id;
  const dir = dataDirOr(dataDir);
  const failures: string[] = [];
  const state = readTaskStates(workDir).states[taskId] ?? null;
  if (state === null) {
    return failure("INVALID_COMMAND", `任务 ${taskId} 没有运行状态`, projectId, taskId, workDir);
  }

  // ① 任务版本
  const versionOk = state.revision === input.expected_revision;
  if (!versionOk) failures.push(`任务版本不符：调用方声明 ${input.expected_revision}，现场是 ${state.revision}`);
  // ② 认领（所有交付检查当前认领 token）
  const claimOk = state.claim_token !== null && state.claim_token === input.claim_token;
  if (state.cancelled) failures.push(`任务已取消（${state.cancel_reason ?? "无理由"}）`);
  if (state.status !== "claimed" && state.status !== "executing") {
    failures.push(`当前状态是「${TASK_STATUS_LABELS[state.status]}」，不是认领/执行中`);
  }
  if (!claimOk) {
    failures.push(
      `认领 token 不是当前那个（现场 ${state.claim_token === null ? "没有有效认领" : `${state.claim_token.slice(0, 12)}…`}）：` +
        "交付只检查当前认领 token（DESIGN.md §2.7）",
    );
  }
  if (state.owner_id !== null && state.owner_id !== input.owner_id) {
    failures.push(`持有者是 ${state.owner_id}，不是 ${input.owner_id}：不能替别人交付`);
  }
  // ③ 租约（到期只表示所有权需核实，不证明旧进程已停止）；毫秒精度比较，秒级以下租约才算得准
  const now = input.now ?? new Date().toISOString();
  const lease = leaseStateOf(state.lease_expires_at, now);
  const ownership = (input.ownership_basis ?? "").trim();
  if (lease === "expired" && ownership === "") {
    failures.push(`租约已到期（${state.lease_expires_at}）：${LEASE_NOTE}；先续约，或给出 ownership_basis 说明怎么核实的所有权`);
  }
  if (lease === "unknown") failures.push(`租约时间戳解析不了（${state.lease_expires_at}）：按未知处理，先续约`);
  // ④ 依赖释放（不看前置自报 done，按定义里的完成证据要求判）
  const definitions = planDefinitions(projectId, dataDir);
  const depCheck = dependencyRecheck(projectId, taskId, dataDir, definitions);
  failures.push(...depCheck.failures);
  // ⑤ 证据引用（无证据的完成不收）
  const evCheck = checkEvidenceRefs(projectId, input.evidence_refs, dataDir);
  failures.push(...evCheck.failures);

  if (failures.length > 0) {
    const code: ClaimFailureCode = !versionOk
      ? "VERSION_CONFLICT"
      : !claimOk
        ? "CLAIM_NOT_YOURS"
        : lease === "expired" && ownership === ""
          ? "LEASE_NEEDS_VERIFICATION"
          : depCheck.failures.length > 0
            ? "DEPENDENCY_UNMET"
            : evCheck.failures.length > 0
              ? "EVIDENCE_MISSING"
              : "INVALID_COMMAND";
    return failure(code, `结果提交被拒（${failures.length} 项查不过）：${failures.join("；")}`, projectId, taskId, workDir, {
      current_revision: state.revision,
      failures,
    });
  }

  const def = definitions.find((d) => d.task_id === taskId) ?? null;
  const receipt = await deps.submitter.submit(
    taskCommand({
      project_id: projectId,
      change_id: input.change_id,
      task_id: taskId,
      type: "task.result_submitted",
      actor_id: input.owner_id,
      role: input.role,
      expected_revision: input.expected_revision,
      idempotency_key: `${taskId}:task.result_submitted:${input.expected_revision + 1}:${input.change_id}:${input.claim_token}`,
      ...(input.occurred_at === undefined ? {} : { occurred_at: input.occurred_at }),
      payload: {
        claim_token: input.claim_token,
        owner_id: input.owner_id,
        owner_role: input.role,
        run_id: state.run_id,
        attempt_id: state.attempt_id,
        deliverables: input.deliverables,
        evidence_refs: input.evidence_refs,
        verification: input.verification ?? [],
        untested: input.untested ?? [],
        known_issues: input.known_issues ?? [],
        diff_ref: input.diff_ref ?? null,
        result_revision: input.result_revision ?? null,
        // 补修 F3：真的声明了运行入口才写这个键——旧调用（不声明）产出的结果回报事件**逐字节不变**
        ...(input.runtime_entries === undefined ? {} : { runtime_entries: input.runtime_entries }),
        ownership_basis: ownership === "" ? null : ownership,
        ...(def === null
          ? {}
          : {
              // 结果回执绑"状态所绑的那份定义"：回放状态里的定义级批次绑定再算哈希
              // （定义哈希含 change_id，现解析不带；不回放会与导入时哈希对不上——同 align 的回放口径）
              definition_sha256: taskDefinitionHash({ ...def, change_id: state.definition_change_id }),
              plan_revision: def.plan_revision ?? "",
            }),
        meaning: "执行者已提交结果；不表示审计通过或人工验收接受（DESIGN.md §5.4）",
      },
    }),
  );

  // 回报后读取下一动作（按新事实重新判，不重复开工）
  const next = deps.readNextAction === undefined ? null : deps.readNextAction(projectId, { role: input.role });

  return {
    ok: true,
    receipt,
    claim_token: input.claim_token,
    rechecks: {
      revision: `任务版本 ${input.expected_revision} 与现场一致`,
      dependencies: depCheck.checked,
      claim: `认领 token 是当前那个（owner=${input.owner_id}）`,
      lease: lease === "expired" ? `租约已到期，按 ownership_basis 核实后放行：${ownership}` : `租约 ${lease}`,
      evidence: `${input.evidence_refs.length} 条证据引用都对得上`,
      external_evidence_refs: evCheck.external,
    },
    next_action: next?.next_action ?? null,
    next_reasons: next?.reasons ?? [],
    next_required_reads: next?.required_reads ?? [],
  };
}

/** 现场施工定义（不校验结构；读不出来就是空表，如实反映"没有定义"） */
export function planDefinitions(projectId: string, dataDir?: string): TaskDefinition[] {
  try {
    const docs = loadDocuments(projectId, dataDir);
    if (docs.plan === null) return [];
    return importTaskDefinitions(docs.plan.text, { plan_revision: docs.plan.revision.content_sha256 }).definitions;
  } catch {
    return [];
  }
}

/** 依赖重查：逐条前置给释放结论（用 V06-09 的 `dependencyRelease`，不看"前卡自报 done"） */
export function dependencyRecheck(
  projectId: string,
  taskId: string,
  dataDir?: string,
  definitions?: TaskDefinition[],
): { ok: boolean; checked: string[]; failures: string[] } {
  const defs = definitions ?? planDefinitions(projectId, dataDir);
  const def = defs.find((d) => d.task_id === taskId);
  if (def === undefined) {
    return { ok: false, checked: [], failures: [`施工定义里找不到任务 ${taskId}：无法核对依赖与交付要求`] };
  }
  if (def.dependency_ids.length === 0) return { ok: true, checked: ["本任务没有依赖"], failures: [] };
  const { projection } = projectFromFacts(projectId, dataDirOr(dataDir));
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

// ── V09-10：协调器受控重开（附录 F；用户裁定原文 `.工作台/handoff/2026-09-24-返工流程裁定.md`）──
//
// 硬口径（每条都有落点）：
//   · **只有协调器**能重开，且只有「已提交结果（result_submitted）」的卡可重开；executor 对已提交卡
//     直领仍 NOT_CLAIMABLE（claimTask 的那行没动，负例保持）；
//   · `role=coordinator` 只是角色声明（§6.5：角色名不是凭证）——重开必须带 `reopen_basis`：
//     **可取回的授权引用**（项目根内相对路径真实存在 / `event:<id>` 在本项目账本 / 64 位十六进制证据在库），
//     一条都取不回即拒（口径同附录 E.4 的 approval_basis）；
//   · 新 attempt 语义：attempt+1、新 run_id/attempt_id、新工作目录 `.工作台/runs/<task>/<attempt>`、
//     绑定当前定义与生效基线、payload 带返工理由与上一提交引用（previous_result）；
//     **重开后旧 claim token 即刻作废**（折叠清空当前认领，提交校验只认当前 attempt 的 token）；
//   · 幂等与并发：expected_revision 原子校验（版本不符拒）；带 `request_id` 的重开按幂等键短路——
//     重复请求返回原事件回执、**不另起 attempt**；旧 run 仍有未过期租约 ⇒ 拒并给 §2.7 指引
//     （无心跳不等于进程已停止）；沿用旧 run 工作目录（目录冲突未核实）⇒ 拒；
//   · **写边界同闸**：`verifyReopenCommand` 同时被本函数与唯一写入服务的 submit 边界调用——
//     直连 `POST /api/work/command` 手写 `task.reopened` 不能旁路（C017「直连旁路」同类的防线）。

/** 一条 reopen_basis 能不能取回（可取回 = null，否则是原因；逐条如实） */
function reopenBasisEntryProblem(
  entry: string,
  events: readonly WorkEvent[],
  ctx: { projectRoot: string | null; workDir: string },
): string | null {
  const v = entry.trim();
  if (v === "") return "空串不是依据";
  if (v.startsWith("event:")) {
    const id = v.slice("event:".length).trim();
    return events.some((e) => e.event_id === id) ? null : `事件 ${id} 不在本项目账本里`;
  }
  if (/^[0-9a-f]{64}$/.test(v)) {
    return fs.existsSync(evidenceBlobPath(ctx.workDir, v)) ? null : `证据库里取不到 ${v.slice(0, 12)}…（引用前必须先落正文）`;
  }
  if (path.isAbsolute(v) || /^[a-zA-Z]:[\\/]/.test(v) || /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(v)) {
    return `依据必须取项目根内相对路径（收到绝对路径/带 scheme 的 ${v.slice(0, 40)}）`;
  }
  const root = ctx.projectRoot;
  if (root === null) return "项目根读不到，无法核实依据路径";
  const abs = path.resolve(root, v);
  if (abs === root || !abs.startsWith(root + path.sep)) return `依据路径 ${v} 越出项目根：路径穿越一律不收`;
  if (!fs.existsSync(abs)) return `依据路径 ${v} 在项目里不存在（取不回即拒）`;
  return null;
}

/**
 * task.reopened 的核实（纯读判据，**reopenTask 与唯一写入服务边界共用同一份**）：
 * 逐条拒因进 `failures`（不合并成一句）；全过才 ok。不碰磁盘写入。
 */
export function verifyReopenCommand(
  events: readonly WorkEvent[],
  cmd: { entity_id: string; role: string; payload: Record<string, unknown> },
  ctx: { projectRoot: string | null; workDir: string; now?: string },
): { ok: boolean; failures: string[]; state: TaskState | null } {
  const failures: string[] = [];
  const taskId = cmd.entity_id.startsWith("task:") ? cmd.entity_id.slice("task:".length) : cmd.entity_id;
  const state = foldTaskStates([...events]).states[taskId] ?? null;
  if (state === null) {
    return { ok: false, failures: [`任务 ${taskId} 在当前事件现场里没有运行状态：没有可重开的提交（未迁移项目没有 v2 语义）`], state: null };
  }
  if (state.cancelled) failures.push(`任务已取消（${state.cancel_reason ?? "无理由"}）：不能重开已取消的任务`);
  if (state.status !== "result_submitted") {
    failures.push(
      `只有「${TASK_STATUS_LABELS.result_submitted}」的卡才能重开返工（当前是「${TASK_STATUS_LABELS[state.status]}」）：` +
        "未提交的卡直接 claim；已提交卡的 executor 直领依旧 NOT_CLAIMABLE（附录 F）",
    );
  }
  if (cmd.role !== "coordinator") {
    failures.push(
      `重开是**协调器专用**动作（附录 F）：本次 role=${JSON.stringify(cmd.role)}，必须 coordinator。` +
        "（角色名不是凭证：本校验还要求 reopen_basis 可取回，见下）",
    );
  }
  let payload: ReopenPayload | null = null;
  try {
    payload = assertReopenPayload(cmd.payload);
  } catch (e) {
    failures.push((e as Error).message);
  }
  if (payload !== null) {
    const wantAttempt = (state.attempt ?? 0) + 1;
    if (payload.attempt !== wantAttempt) {
      failures.push(`attempt 必须是上一 attempt+1（现场=${state.attempt ?? 0}，应为 ${wantAttempt}，收到 ${payload.attempt}）：不跳号不回退`);
    }
    const lastSubmit = [...events]
      .reverse()
      .find((e) => e.type === "task.result_submitted" && e.entity_id === cmd.entity_id);
    if (lastSubmit === undefined) {
      failures.push("现场里找不到上一提交事件（result_submitted）：previous_result 没有可指的提交");
    } else if (payload.previous_result.seq !== lastSubmit.seq || payload.previous_result.event_id !== lastSubmit.event_id) {
      failures.push(
        `previous_result 必须指回真实的上一提交（现场最近一次是 seq ${lastSubmit.seq} / ${lastSubmit.event_id}；` +
          `收到 seq ${payload.previous_result.seq} / ${payload.previous_result.event_id}）：不许编造历史链`,
      );
    }
    const basisProblems = payload.reopen_basis.map((b) => reopenBasisEntryProblem(b, events, ctx));
    if (basisProblems.every((p) => p !== null)) {
      failures.push(
        `reopen_basis 一条都取不回（${payload.reopen_basis.map((b, i) => `${JSON.stringify(b)}：${basisProblems[i]}`).join("；")}）——` +
          "授权依据必须可取回（附录 E.4/F.2：取不回即拒，不允许「调用方说了算」）",
      );
    }
    const held = liveClaimRecord(claimRecordsOf([...events])[taskId]);
    if (held !== null) {
      const now = ctx.now ?? new Date().toISOString();
      if (leaseStateOf(held.lease_expires_at, now) === "active") {
        failures.push(
          `旧 run 的认领租约未过期（${held.lease_expires_at ?? "未知"}，持有者 ${held.owner_id ?? "?"}）：${LEASE_NOTE}——` +
            "先核实旧现场已停止/租约失效，再重开",
        );
      }
      if (held.workspace !== null && payload.workspace === held.workspace) {
        failures.push(
          `目录冲突未核实：新 attempt 的工作目录（${payload.workspace}）与旧 run 相同——` +
            "缺省按 attempt 分目录；确要复用须先核实旧进程已停止（§2.7），否则拒",
        );
      }
    }
  }
  return { ok: failures.length === 0, failures, state };
}

export interface ReopenTaskInput {
  project_id: string;
  task_id: string;
  /** 必须 "coordinator"（角色声明之外还要 reopen_basis 可取回，见附录 F.2） */
  role: string;
  /** 操作者标识（写进事件 actor_id；缺省由调用方给） */
  actor_id: string;
  change_id: string;
  /** 返工理由（非空；改版重交 / 复核重验要分得开，裁定第 1 条） */
  reason: string;
  /** 可取回的授权依据（≥1 条：项目根内相对路径 / event:<id> / 64 位证据哈希） */
  reopen_basis: string[];
  /** 重开前读到的实体版本；不给就现读（原子性由唯一写入服务的版本检查保证） */
  expected_revision?: number | null;
  /** 隔离工作目录（缺省 `.工作台/runs/<task>/<attempt>`——按 attempt 分目录，不撞旧 run） */
  workspace?: string;
  /** 幂等键：带上后重复重开返回原回执、不另起 attempt */
  request_id?: string;
  occurred_at?: string;
  /** 验证钩子：把"现在"固定下来（产品路径不传） */
  now?: string;
}

export interface ReopenTaskSuccess {
  /** 新 attempt 的标识（attempt/run_id/attempt_id/workspace）与上一提交引用 */
  reopen: {
    attempt: number;
    run_id: string;
    attempt_id: string;
    workspace: string;
    previous_result: { seq: number; event_id: string; run_id: string | null; attempt_id: string | null };
  };
  receipt: WorkReceipt;
  /** true = 同一幂等键的重复重开：返回的是原事件的回执，没有另起 attempt */
  duplicate: boolean;
}

/** 重开幂等键（带 request_id 的重开才走幂等短路；键里带任务，跨任务不串） */
export function reopenIdempotencyKey(taskId: string, requestId: string): string {
  return `${taskId}:task.reopened:req:${requestId}`;
}

/**
 * 协调器受控重开一张「已提交结果」的卡（附录 F）：核实全部通过后经唯一写入服务落 `task.reopened`，
 * 任务回到可认领态（新 attempt 可 claim 可交；旧 token 即刻作废）。
 * 任何一条查不过 ⇒ 明确拒绝 + **零写入**；重开本身不产生任何执行事实、不恢复旧绿、不写 Gate。
 */
export async function reopenTask(
  input: ReopenTaskInput,
  submitter: ClaimSubmitter,
  dataDir?: string,
): Promise<ClaimOutcome<ReopenTaskSuccess>> {
  const workDir = workDirOf(input.project_id, dataDir);
  const projectId = input.project_id;
  const taskId = input.task_id;
  const events = readClaimEvents(workDir);

  // 幂等短路（带了 request_id 才有）：同一幂等键的重开已在账本里 ⇒ 返回原事件的信息，不另起 attempt
  if (input.request_id !== undefined && input.request_id.trim() !== "") {
    const key = reopenIdempotencyKey(taskId, input.request_id.trim());
    const existing = events.find((e) => e.idempotency_key === key);
    if (existing !== undefined) {
      if (existing.type !== "task.reopened" || existing.entity_id !== taskEntityId(taskId)) {
        return failure(
          "IDEMPOTENCY_CONFLICT",
          `重开幂等键 ${key} 已被别的事件占用（${existing.type} ${existing.entity_id} seq ${existing.seq}）：换一个 request_id`,
          projectId,
          taskId,
          workDir,
        );
      }
      // 幂等口径与唯一写入服务一致：同键必须同内容——理由/依据/目录任一不同就是另一次意图，拒（不冒充重放）
      const p = existing.payload as unknown as ReopenPayload;
      const sameIntent =
        p.reason === input.reason.trim() &&
        JSON.stringify(p.reopen_basis) === JSON.stringify(input.reopen_basis.map((b) => b.trim()).filter((b) => b !== "")) &&
        p.workspace === (input.workspace ?? p.workspace);
      if (!sameIntent) {
        return failure(
          "IDEMPOTENCY_CONFLICT",
          `重开幂等键 ${key} 已用于另一份内容不同的重开（原事件 ${existing.event_id}，seq ${existing.seq}）：` +
            "幂等键一旦用过就不能换内容重发——换一个新 request_id 表达新意图",
          projectId,
          taskId,
          workDir,
        );
      }
      return {
        ok: true,
        duplicate: true,
        reopen: {
          attempt: p.attempt,
          run_id: p.run_id,
          attempt_id: p.attempt_id,
          workspace: p.workspace,
          previous_result: p.previous_result,
        },
        receipt: {
          ok: true,
          event_id: existing.event_id,
          seq: existing.seq,
          entity_revision: existing.entity_revision,
          received_at: existing.received_at,
          duplicate: true,
          projection: { state: "applied" },
        },
      };
    }
  }

  const project = getProject(projectId, dataDir);
  const state = readTaskStates(workDir).states[taskId] ?? null;
  if (state === null) {
    return failure(
      "INVALID_COMMAND",
      `任务 ${taskId} 在当前事件现场里没有运行状态：没有可重开的提交（未迁移项目没有 v2 语义，v1 行为不变）`,
      projectId,
      taskId,
      workDir,
    );
  }
  const expected = input.expected_revision === undefined || input.expected_revision === null ? state.revision : input.expected_revision;
  if (expected !== state.revision) {
    return failure(
      "VERSION_CONFLICT",
      `重开被拒：调用方声明的 expected_revision=${expected}，当前实体版本是 ${state.revision}（有人先你一步改了这张卡）`,
      projectId,
      taskId,
      workDir,
      { current_revision: state.revision },
    );
  }

  const attempt = (state.attempt ?? 0) + 1;
  const runId = `run-${taskId}-${attempt}`;
  const attemptId =
    input.request_id !== undefined && input.request_id.trim() !== ""
      ? `att-${taskId}-${attempt}-${crypto.createHash("sha256").update(input.request_id.trim(), "utf8").digest("hex").slice(0, 8)}`
      : `att-${taskId}-${attempt}-${crypto.randomBytes(4).toString("hex")}`;
  const safe = (s: string): string => s.replace(/[^A-Za-z0-9._-]+/g, "-");
  const workspace = input.workspace ?? `${WORKSPACE_ROOT_REL}/${safe(taskId)}/${attempt}`;
  const lastSubmit = [...events].reverse().find((e) => e.type === "task.result_submitted" && e.entity_id === taskEntityId(taskId));
  const previousResult =
    lastSubmit === undefined
      ? null
      : {
          seq: lastSubmit.seq,
          event_id: lastSubmit.event_id,
          run_id: strOrNull(lastSubmit.payload.run_id),
          attempt_id: strOrNull(lastSubmit.payload.attempt_id),
        };
  const reason = input.reason.trim();
  const payload: Record<string, unknown> = {
    attempt,
    run_id: runId,
    attempt_id: attemptId,
    workspace,
    reason,
    reopen_basis: input.reopen_basis.map((b) => b.trim()).filter((b) => b !== ""),
    previous_result: previousResult,
    definition_sha256: state.definition_sha256,
    baseline_id: activeBaseline(projectId, dataDir)?.baseline_id ?? null,
  };

  // 与写边界同一份判据（本函数先给出友好拒因；服务边界会再核一次，直连写口绕不过去）
  const verification = verifyReopenCommand(events, { entity_id: taskEntityId(taskId), role: input.role, payload }, {
    projectRoot: project === undefined ? null : path.resolve(project.path),
    workDir,
    ...(input.now === undefined ? {} : { now: input.now }),
  });
  if (!verification.ok) {
    return failure(
      "INVALID_COMMAND",
      `重开被拒（${verification.failures.length} 项查不过）：${verification.failures.join("；")}。本次没有写入任何字节`,
      projectId,
      taskId,
      workDir,
      { current_revision: state.revision, failures: verification.failures },
    );
  }

  try {
    const receipt = await submitter.submit(
      taskCommand({
        project_id: projectId,
        change_id: input.change_id,
        task_id: taskId,
        type: "task.reopened",
        actor_id: input.actor_id,
        role: input.role,
        expected_revision: expected,
        idempotency_key:
          input.request_id !== undefined && input.request_id.trim() !== ""
            ? reopenIdempotencyKey(taskId, input.request_id.trim())
            : `${taskId}:task.reopened:${expected + 1}:${input.change_id}:${input.actor_id}:${attemptId}`,
        ...(input.occurred_at === undefined ? {} : { occurred_at: input.occurred_at }),
        payload,
      }),
    );
    return {
      ok: true,
      duplicate: false,
      reopen: { attempt, run_id: runId, attempt_id: attemptId, workspace, previous_result: previousResult! },
      receipt,
    };
  } catch (e) {
    if (isWorkError(e) && e.code === "VERSION_CONFLICT") {
      return versionConflictFailure(e, projectId, taskId, workDir, "重开");
    }
    throw e;
  }
}
