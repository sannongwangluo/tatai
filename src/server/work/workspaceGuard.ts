// 托管写守卫（PLAN V09-65；DESIGN.md §6.13 第 4 段、§6.14 第 6 段）。
//
// 定位：把"目标工作区/版本不符时拒绝相应写入"的判据集中成**可被其它模块调用**的少数函数。
// 为什么单开一个文件：V09-65 要求守卫**暴露给其他模块调用**（文档写口、讨论追加、项目笔记/进度、
// 认领/提交、证据存证…各写各的就会"两份都像真的"）。这里只做**语义校验**，**不冒充 OS 沙箱**——
// 本机任意 shell 写文件不受塔台天然拦截，cwd 与允许路径边界的**执行侧**责任仍在外部协调者与任务声明。
//
// 两条关键边界（§6.14 第 6 段，逐字照读）：
//   ① 冻结拒绝的是"改写冻结源码、错目标、错版本"，**不是**拒绝往中央账本登记验证证据——
//      对 `frozen` 候选**可以**经唯一写口追加自检/独审/包身份/Git 关联/复测证据（证据只引用候选版本指纹）。
//   ② 缺字段按 §6.6 明确 `unsupported`／未知，不回退写路由、不另算一套判据。
import path from "node:path";
import { WorkError } from "./types";
import { getProject } from "../registry";
import { projectWorkDir } from "../workstation";
import {
  checkWorkspaceForClaim,
  findFrozenWorkspaceForRoot,
  resolveCurrentDevRoot,
  resolveCurrentTrial,
  resolveDevFromProjection,
  readWorkspaces,
  readWorkspacesForProject,
  workspaceIdOfEntity,
  type WorkspaceProjection,
} from "./workspaces";
import type { WorkspaceFailureCode, WorkspacePointer, WorkspaceRecord } from "../../shared/workspaceTypes";

export { resolveCurrentDevRoot, resolveCurrentTrial, readWorkspacesForProject, workspaceIdOfEntity };

/** 守卫拒绝：抛 `WorkError`，稳定码放进 `detail.reason`（与写口锁内一致，零字节） */
function reject(code: WorkspaceFailureCode, message: string, detail: Record<string, unknown> = {}): never {
  throw new WorkError("INVALID_COMMAND", `${message}（本次写入没有落任何字节）`, { reason: code, ...detail });
}

/**
 * 认领/续领校验（§6.14 第 6 段、chk-v09-65-01）：目标 `workspace_id` 未知、不属本项目、
 * 已回收时**拒绝认领**并给稳定错误码。`workspace_id` 为 null 时按 `:main` 派生口径放行（旧项目兼容）。
 */
export function assertWorkspaceClaimTarget(input: {
  projectId: string;
  dataDir?: string;
  workspaceId?: string | null;
}): WorkspaceRecord | null {
  const wid = input.workspaceId ?? null;
  const check = checkWorkspaceForClaim(input.projectId, input.dataDir, wid);
  if (!check.ok) reject(check.code ?? "WORKSPACE_UNKNOWN", check.message ?? `目标工作区不可用：${wid}`, { workspace_id: wid, project_id: input.projectId });
  return check.workspace ?? null;
}

/**
 * 托管写口目标守卫（chk-v09-65-02）：写目标必须与认领的目标工作区一致；落在某个**冻结候选源目录**里的
 * 写入被拒（改写冻结源码／错目标／错版本）。**中央证据写不经这里**（证据落中央工作台，只引用候选内容指纹）。
 *
 * `kind` 说明这次写是什么：`source`＝改源码/工作树；`evidence`＝中央账本/证据；`document`＝托管文档写口。
 * 仅 `source`/`document` 会被冻结拒（document 落在冻结源目录里时）。
 */
export function assertHostedWriteAllowed(input: {
  projectId: string;
  dataDir?: string;
  /** 本次声明的目标工作区 id（认领记录里带；缺省＝不声明，按 :main 口径） */
  workspaceId?: string | null;
  /** 实际要写的绝对路径（源码/文档写口给；中央证据不给） */
  targetRoot?: string | null;
  kind: "source" | "document" | "evidence";
}): void {
  if (input.kind === "evidence") return; // 中央证据写不受冻结影响（§6.14 第 6 段）
  // 目标工作区一致性：声明了 workspace_id 就核它属本项目且未回收
  if (input.workspaceId !== undefined && input.workspaceId !== null && input.workspaceId !== "") {
    assertWorkspaceClaimTarget({ projectId: input.projectId, dataDir: input.dataDir, workspaceId: input.workspaceId });
  }
  if (input.targetRoot === undefined || input.targetRoot === null || input.targetRoot === "") return;
  const frozen = findFrozenWorkspaceForRoot(input.projectId, input.dataDir, input.targetRoot);
  if (frozen !== null) {
    reject(
      "CANDIDATE_FROZEN",
      `拒绝写入冻结候选源码目录（工作区 ${frozen.workspace_id}）：冻结后不得改写源码，请从它派生新准备区再冻结` +
        "（DESIGN.md §6.13 第 3 段／§6.14 第 6 段）。注：对 frozen 候选登记中央验证证据是允许的，不走本守卫",
      { workspace_id: frozen.workspace_id, target_root: path.resolve(input.targetRoot) },
    );
  }
}

/**
 * 只读：某个已登记工作区是否冻结（给文档/讨论写口判断要不要拒）。
 * 找不到该 id 返回 null（调用方按"未知"处理，不猜）。
 */
export function frozenWorkspaceById(projectId: string, dataDir: string | undefined, workspaceId: string): WorkspaceRecord | null {
  const view = readWorkspacesForProject(projectId, dataDir);
  const rec = view.workspaces.find((w) => w.workspace_id === workspaceId);
  if (rec === undefined || rec.status !== "frozen") return null;
  return rec;
}

/**
 * 写口的目标版本守卫（chk-v09-65-02）：若调用方声明了目标 `content_fingerprint`，而冻结记录的候选指纹
 * 与之不符（错版本），拒绝。给不出目标指纹＝不在此拒绝（版本绑定由各自写口判据负责）。
 */
export function assertWorkspaceVersionMatch(input: {
  projectId: string;
  dataDir?: string;
  workspaceId?: string | null;
  expected_content_fingerprint?: string | null;
}): void {
  if (input.workspaceId === undefined || input.workspaceId === null || input.workspaceId === "") return;
  const fp = input.expected_content_fingerprint ?? null;
  if (fp === null) return;
  const view = readWorkspacesForProject(input.projectId, input.dataDir);
  const rec = view.workspaces.find((w) => w.workspace_id === input.workspaceId);
  if (rec === undefined) reject("WORKSPACE_UNKNOWN", `目标工作区不属本项目：${input.workspaceId}`, { workspace_id: input.workspaceId });
  if (rec.freeze !== null && rec.freeze.content_fingerprint !== fp) {
    reject(
      "WORKSPACE_MISMATCH",
      `写入声明的目标内容指纹与工作区 ${input.workspaceId} 的冻结指纹不符（错版本）：拒绝写入`,
      { workspace_id: input.workspaceId, declared: fp, frozen: rec.freeze.content_fingerprint },
    );
  }
}

/** 接续上下文：给入口/工作包/认领用的一小块（目标工作区、实际 cwd、可改范围、候选状态） */
export interface WorkspaceContinuation {
  workspace_id: string;
  /** 实际 cwd；**坏指针时为 null**（不拿 :main 顶替） */
  root: string | null;
  source: "pointer" | "main" | "blocked";
  /** 可改范围：开发工作区＝该工作区根；冻结候选＝只读；坏指针＝不可写 */
  writable: boolean;
  status: "main" | "preparing" | "frozen" | "retired" | "blocked";
  /** 当前试用候选解析结果（none/ok/blocked）；blocked 时点名原因，不静默当未提升 */
  trial: { workspace_id: string; root: string; content_fingerprint: string | null } | null;
  trial_status: "none" | "ok" | "blocked";
  trial_reason: string | null;
  /** 坏指针原因（结构化可读） */
  blocked_reason: string | null;
  /** 托管写口拒绝语义的一句话（给 Agent 看） */
  note: string;
}

const EMPTY_POINTER = (projectId: string): WorkspacePointer => ({
  project_id: projectId,
  current_dev_workspace_id: null,
  current_trial_workspace_id: null,
  revision: 0,
  seq: 0,
  updated_at: "",
  last_actor: "",
});

/** 从**已折叠投影**派生接续上下文（**不读盘**；入口用共享事件快照折叠后调它，避免额外读账本/在坏账本上抛错） */
export function continuationFromProjection(
  projectId: string,
  anchorRoot: string,
  projection: WorkspaceProjection,
): WorkspaceContinuation {
  const pointer = projection.pointer ?? EMPTY_POINTER(projectId);
  const dev = resolveDevFromProjection(projectId, anchorRoot, projection, pointer);
  const rec = projection.workspaces[dev.workspace_id];
  const trialId = pointer.current_trial_workspace_id;
  let trial: WorkspaceContinuation["trial"] = null;
  let trialStatus: WorkspaceContinuation["trial_status"] = "none";
  let trialReason: string | null = null;
  if (trialId !== null && trialId !== "") {
    const tRec = projection.workspaces[trialId];
    if (tRec === undefined) {
      trialStatus = "blocked";
      trialReason = `显式试用指针指向的工作区不存在：${trialId}（不静默当未提升）`;
    } else if (tRec.status === "retired") {
      trialStatus = "blocked";
      trialReason = `显式试用指针指向的工作区已回收：${trialId}（不静默当未提升）`;
    } else if (tRec.status !== "frozen" || tRec.freeze === null) {
      trialStatus = "blocked";
      trialReason = `显式试用指针指向的工作区未冻结/缺冻结记录（${tRec.status}）：${trialId}`;
    } else {
      trialStatus = "ok";
      trial = { workspace_id: tRec.workspace_id, root: tRec.root, content_fingerprint: tRec.freeze.content_fingerprint };
    }
  }
  if (dev.source === "blocked") {
    return {
      workspace_id: dev.workspace_id,
      root: null,
      source: "blocked",
      writable: false,
      status: "blocked",
      trial,
      trial_status: trialStatus,
      trial_reason: trialReason,
      blocked_reason: dev.blocked_reason ?? "显式开发指针不可用",
      note: "当前开发指针坏（目标不存在/已回收）：如实报 unknown，不静默回退 :main。修法：select_dev 切走或修登记后重读入口（§6.14 第 2/10 段）",
    };
  }
  const status: WorkspaceContinuation["status"] = rec?.derived === true ? "main" : (rec?.status ?? "main");
  return {
    workspace_id: dev.workspace_id,
    root: dev.root,
    source: dev.source,
    writable: status !== "frozen" && status !== "retired",
    status,
    trial,
    trial_status: trialStatus,
    trial_reason: trialReason,
    blocked_reason: null,
    note:
      status === "frozen" || status === "retired"
        ? "目标工作区是冻结/已回收候选：源码只读，改源码请派生新准备区；中央验证证据经唯一写口仍可登记（§6.14 第 6/8 段）"
        : "目标工作区可开发；候选冻结与试用提升见 manage_workspace（§6.14 第 8 段）",
  };
}

/** 接续上下文（读盘版）：读注册表 + 事件现折叠后派生（manage_workspace 读口/其它调用方用） */
export function workspaceContinuation(projectId: string, dataDir?: string): WorkspaceContinuation {
  const project = getProject(projectId, dataDir);
  if (!project) reject("WORKSPACE_UNKNOWN", `项目不存在：${projectId}`, { project_id: projectId });
  const projection = readWorkspaces(projectWorkDir(projectId, dataDir));
  return continuationFromProjection(projectId, path.resolve(project.path), projection);
}
