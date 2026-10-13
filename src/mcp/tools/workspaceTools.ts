// `manage_workspace`：项目工作目录与交付候选的统一入口（PLAN V09-63/V09-65；DESIGN.md §6.13／§6.14 第 2 段）。
//
// 为什么一个工具而不是一堆：§6.14 第 2 段把 op（read/list/register/update/freeze/retire/select_dev/point_trial）
// 与角色、失败口径定成一张表；本工具是它的**唯一可达入口**，写操作经 `ctx.work` 转接唯一写入服务。
// 读操作只读事件投影（与入口/认领同一口径），不需要写者在场。
//
// 硬口径：
//   · 写只经唯一写口（MCP 不自己追加事件，§2.6）；命令计划由 `workspaces.*` 约束，**锁内**再核一遍。
//   · 入参闭键：没声明的键在工具层点名拒（与对象命令 `assertCommandKeys` 同一口径）。
//   · 冻结源指纹由**宿主实测**（`candidateSource.inspectCandidateSource`），不接受调用方自报 measured。
//   · 缺 `ctx.work` 时报 `SERVICE_UNAVAILABLE`（不回退成自己写账本）。
import { resolveDataDir } from "../../server/registry";
import { projectWorkDir } from "../../server/workstation";
import { NO_CHANGE_ID, WorkError, isWorkError } from "../../server/work/types";
import {
  readWorkspaces,
  registerWorkspace,
  updateWorkspace,
  freezeWorkspace,
  retireWorkspace,
  selectDevWorkspace,
  pointTrialWorkspace,
  readWorkspacesForProject,
  type WorkspaceProjection,
} from "../../server/work/workspaces";
import type { WorkReceipt } from "../../server/work/types";
import { WORKSPACE_OPS, type WorkspaceFailure, type WorkspaceOp } from "../../shared/workspaceTypes";
import { errorResult, textResult, type McpContext, type McpTool, type ToolResult } from "./types";

function jsonOk(payload: unknown): ToolResult {
  return textResult(JSON.stringify(payload, null, 2));
}
function jsonError(payload: unknown): ToolResult {
  return errorResult(JSON.stringify(payload, null, 2));
}

function str(args: Record<string, unknown>, key: string): string {
  return typeof args[key] === "string" ? (args[key] as string).trim() : "";
}
function strOrNull(args: Record<string, unknown>, key: string): string | null {
  const v = str(args, key);
  return v === "" ? null : v;
}
function intOrNull(args: Record<string, unknown>, key: string): number | null {
  const v = args[key];
  return typeof v === "number" && Number.isInteger(v) ? v : null;
}

function assertToolArgs(args: Record<string, unknown>, allowed: readonly string[], what: string): void {
  const extra = Object.keys(args).filter((k) => !allowed.includes(k));
  if (extra.length === 0) return;
  throw new WorkError("INVALID_COMMAND", `${what} 的入参只收这些键（${allowed.join(" / ")}），多出来的键一律拒：${extra.join("、")}`, {
    extra,
    allowed,
    tool: what,
  });
}

function failWith(e: unknown, what: string): ToolResult {
  if (isWorkError(e)) return jsonError({ ok: false, code: e.code, message: e.message, detail: e.detail });
  return errorResult(`${what}失败：${e instanceof Error ? e.message : String(e)}`);
}

const PLACEHOLDER_RECEIPT: WorkReceipt = {
  ok: true,
  event_id: "<planned-未提交>",
  seq: 0,
  entity_revision: 0,
  received_at: "",
  duplicate: false,
  projection: { state: "failed", error: "计划占位回执，不出本文件" },
};

/** 计划提交者：捕获命令本体（写经唯一写口，读从盘上投影现读） */
interface WorkspacePlanner {
  planned: unknown[];
  read: () => WorkspaceProjection;
  submit: (command: unknown) => WorkReceipt;
}
function plannerFor(workDir: string): WorkspacePlanner {
  const planned: unknown[] = [];
  return {
    planned,
    read: () => readWorkspaces(workDir),
    submit: (command: unknown): WorkReceipt => {
      planned.push(command);
      return PLACEHOLDER_RECEIPT;
    },
  };
}

const ENVELOPE_KEYS = ["change_id", "actor_id"] as const;const OP_ARG_KEYS: Record<WorkspaceOp, readonly string[]> = {
  read: ["op", "project_id", "workspace_id"],
  list: ["op", "project_id"],
  register: [
    "op", "project_id", "role", "workspace_id", "kind", "purpose", "root", "source_kind",
    "source_commit", "source_ref", "content_fingerprint", "owner_role", "task_ids", ...ENVELOPE_KEYS,
  ],
  update: ["op", "project_id", "role", "workspace_id", "expected_revision", "fields", ...ENVELOPE_KEYS],
  freeze: [
    "op", "project_id", "role", "workspace_id", "expected_revision", "included_uncommitted",
    "declared_paths", "source_commit", "candidate_index_revision", "version_binding", "declared_package", ...ENVELOPE_KEYS,
  ],
  retire: ["op", "project_id", "role", "workspace_id", "expected_revision", "reason", "reachability", ...ENVELOPE_KEYS],
  select_dev: ["op", "project_id", "role", "workspace_id", "expected_revision", "basis", ...ENVELOPE_KEYS],
  point_trial: ["op", "project_id", "role", "workspace_id", "expected_revision", "basis", ...ENVELOPE_KEYS],
};

function writeEnvelope(args: Record<string, unknown>, ctx: McpContext | undefined, what: string): { role: string; actorId: string; changeId: string } {
  const role = str(args, "role");
  if (role === "") throw new WorkError("INVALID_COMMAND", `${what} 缺入参 role（写操作必填）`, { tool: what });
  const actorId = str(args, "actor_id") || ctx?.clientName || role;
  const changeId = str(args, "change_id") || NO_CHANGE_ID;
  return { role, actorId, changeId };
}

/** 只读视图：read/list 的返回体（同一份 `readWorkspacesForProject`） */
function viewOf(projectId: string, dataDir: string): unknown {
  const view = readWorkspacesForProject(projectId, dataDir);
  return { ok: true, ...view };
}

export const manageWorkspaceTool: McpTool = {
  name: "manage_workspace",
  description:
    "项目工作目录与交付候选统一入口（DESIGN.md §6.13/§6.14）。op=read/list 只读；register/update/freeze/retire/" +
    "select_dev/point_trial 经唯一写入服务转接（带 expected_revision 的原子 CAS、payload 闭键、角色、路径边界）。" +
    "主开发目录由 <project_id>:main 派生、不重复登记；项目级指针（当前开发工作区/当前试用候选）记独立实体、不改 ProjectRecord.path。" +
    "freeze 的源指纹由宿主实测（candidate-index-v1），point_trial 也会自行重核、失败保留旧指针",
  inputSchema: {
    type: "object",
    properties: {
      op: { type: "string", enum: [...WORKSPACE_OPS], description: "read/list/register/update/freeze/retire/select_dev/point_trial" },
      project_id: { type: "string", description: "注册表里的项目 id" },
      role: { type: "string", description: "调用方角色（写操作必填；executor/coordinator/designer）" },
      change_id: { type: "string", description: `事件信封的变更批次（写操作用；不挂批次填 ${NO_CHANGE_ID}，缺省即此值）` },
      actor_id: { type: "string", description: "执行者标识（缺省取 MCP 客户端名）" },
      workspace_id: { type: "string", description: "工作区稳定 id（read 不给则列全部）" },
      kind: { type: "string", enum: ["dev", "trial", "candidate"], description: "op=register 必填：工作区用途" },
      purpose: { type: "string", description: "op=register 必填：用途说明" },
      root: { type: "string", description: "op=register 必填：规范绝对路径（不得落在私有 .工作台 里）" },
      source_kind: { type: "string", enum: ["directory", "git_worktree", "git_commit", "content_snapshot"], description: "op=register 必填：来源种类" },
      source_commit: { type: "string", description: "来源提交（Git 项目）" },
      source_ref: { type: "string", description: "来源引用（分支/快照名等）" },
      content_fingerprint: { type: "string", description: "内容指纹（非 Git 快照；Git 项目可省略）" },
      owner_role: { type: "string", description: "负责人角色" },
      task_ids: { type: "array", items: { type: "string" }, description: "关联任务 id（executor 的 register/update 必带）" },
      expected_revision: { type: "number", description: "op=update/freeze/retire/select_dev/point_trial 必填：CAS 期望版本" },
      fields: { type: "object", description: "op=update 必填：要改的字段（purpose/source_*/task_ids/owner_role 至少一个）" },
      included_uncommitted: { type: "boolean", description: "op=freeze 必填：未提交改动是否纳入候选" },
      declared_paths: { type: "array", items: { type: "string" }, description: "op=freeze：声明纳入的路径（included_uncommitted=true 时至少一条）" },
      candidate_index_revision: { type: "string", description: "op=freeze：候选索引版本指针（可选）" },
      version_binding: { type: "object", description: "op=freeze：配套版本绑定（design_sha256/plan_sha256/baseline_id/ledger_last_seq/requirement_cursor）。build_identity 由宿主实测，不接受提供" },
      declared_package: { type: "boolean", description: "op=freeze：显式声明本候选是构建包交付（只增加严格性：根无 §6.10 构建链时明确报 unsupported/未知）" },
      reason: { type: "string", description: "op=retire 必填：回收理由" },
      reachability: { type: "string", description: "op=retire 必填：可达性前提证据（提交可还原/快照库在）" },
      basis: { type: "string", description: "op=select_dev/point_trial：指针切换依据（可选）" },
    },
    required: ["op", "project_id"],
    additionalProperties: false,
  },
  handler: async (args, ctx?: McpContext) => {
    const op = str(args, "op") as WorkspaceOp;
    if (!(WORKSPACE_OPS as readonly string[]).includes(op)) {
      return errorResult(`manage_workspace 的 op 只接受 ${WORKSPACE_OPS.join("/")}（收到 ${JSON.stringify(args.op)}）`);
    }
    const what = `manage_workspace(${op})`;
    try {
      assertToolArgs(args, OP_ARG_KEYS[op], what);
      const dataDir = resolveDataDir();
      const projectId = str(args, "project_id");
      if (projectId === "") return errorResult("manage_workspace 缺入参 project_id");
      const workDir = projectWorkDir(projectId, dataDir);

      if (op === "read" || op === "list") {
        const view = viewOf(projectId, dataDir) as { workspaces: { workspace_id: string }[] };
        const wid = strOrNull(args, "workspace_id");
        if (op === "read" && wid !== null) {
          const hit = view.workspaces.find((w) => w.workspace_id === wid) ?? null;
          return jsonOk({ ok: true, project_id: projectId, workspace: hit, known_ids: view.workspaces.map((w) => w.workspace_id) });
        }
        return jsonOk(view);
      }

      const work = ctx?.work;
      if (work === undefined) {
        return jsonError({
          ok: false,
          code: "SERVICE_UNAVAILABLE",
          message: `${what} 拿不到转接客户端（ctx.work）：v2 事实只有一个写入者，MCP 不自己追加事件（DESIGN.md §2.6）`,
          detail: { tool: what },
        });
      }
      const { role, actorId, changeId } = writeEnvelope(args, ctx, what);
      const wid = strOrNull(args, "workspace_id");

      const planner = plannerFor(workDir);
      let outcome: { ok: boolean; code?: string; message?: string; failures?: string[]; reason?: string; detail?: Record<string, unknown> } | null = null;

      if (op === "register") {
        if (wid === null) return errorResult(`${what} 缺入参 workspace_id`);
        outcome = registerWorkspace(planner, {
          project_id: projectId,
          workspace_id: wid,
          change_id: changeId,
          actor_id: actorId,
          role,
          kind: args.kind as never,
          purpose: str(args, "purpose"),
          root: str(args, "root"),
          source_kind: args.source_kind as never,
          source_commit: strOrNull(args, "source_commit"),
          source_ref: strOrNull(args, "source_ref"),
          content_fingerprint: strOrNull(args, "content_fingerprint"),
          owner_role: strOrNull(args, "owner_role"),
          ...(Array.isArray(args.task_ids) ? { task_ids: (args.task_ids as unknown[]).map((x) => String(x)) } : {}),
        });
      } else if (op === "update") {
        if (wid === null) return errorResult(`${what} 缺入参 workspace_id`);
        const expected = intOrNull(args, "expected_revision");
        if (expected === null) return errorResult(`${what} 缺入参 expected_revision（CAS 必填整数）`);
        if (typeof args.fields !== "object" || args.fields === null || Array.isArray(args.fields)) {
          return errorResult(`${what} 的 fields 必须是对象（要改的字段，至少一个）`);
        }
        outcome = updateWorkspace(planner, {
          project_id: projectId, workspace_id: wid, change_id: changeId, actor_id: actorId, role,
          expected_revision: expected, fields: args.fields as Record<string, unknown>,
        });
      } else if (op === "freeze") {
        if (wid === null) return errorResult(`${what} 缺入参 workspace_id`);
        const expected = intOrNull(args, "expected_revision");
        if (expected === null) return errorResult(`${what} 缺入参 expected_revision（CAS 必填整数）`);
        if (typeof args.included_uncommitted !== "boolean") return errorResult(`${what} 缺入参 included_uncommitted（布尔，必须显式声明未提交内容是否纳入）`);
        const declared = Array.isArray(args.declared_paths) ? (args.declared_paths as unknown[]).map((x) => String(x)) : [];
        outcome = freezeWorkspace(planner, {
          project_id: projectId, workspace_id: wid, change_id: changeId, actor_id: actorId, role, expected_revision: expected,
          included_uncommitted: args.included_uncommitted,
          declared_paths: declared,
          source_commit: strOrNull(args, "source_commit"),
          candidate_index_revision: strOrNull(args, "candidate_index_revision"),
          ...(typeof args.version_binding === "object" && args.version_binding !== null ? { version_binding: args.version_binding as never } : {}),
          ...(typeof args.declared_package === "boolean" ? { declared_package: args.declared_package } : {}),
        });
      } else if (op === "retire") {
        if (wid === null) return errorResult(`${what} 缺入参 workspace_id`);
        const expected = intOrNull(args, "expected_revision");
        if (expected === null) return errorResult(`${what} 缺入参 expected_revision（CAS 必填整数）`);
        outcome = retireWorkspace(planner, {
          project_id: projectId, workspace_id: wid, change_id: changeId, actor_id: actorId, role, expected_revision: expected,
          reason: str(args, "reason"), reachability: str(args, "reachability"),
        });
      } else {
        if (wid === null) return errorResult(`${what} 缺入参 workspace_id`);
        const expected = intOrNull(args, "expected_revision");
        if (expected === null) return errorResult(`${what} 缺入参 expected_revision（CAS 必填整数）`);
        const common = {
          project_id: projectId, workspace_id: wid, change_id: changeId, actor_id: actorId, role, expected_revision: expected,
          ...(strOrNull(args, "basis") === null ? {} : { basis: str(args, "basis") }),
        } as const;
        outcome = op === "select_dev" ? selectDevWorkspace(planner, common) : pointTrialWorkspace(planner, common);
      }

      if (outcome === null || !outcome.ok) {
        const f = outcome as WorkspaceFailure | null;
        return jsonError(f ?? { ok: false, code: "INVALID_COMMAND", message: `${what} 未产生任何命令` });
      }
      if (planner.planned.length === 0) {
        // 幂等命中既有（register 重复）：命令层直接返回既有回执，没有要提交的命令
        const view = viewOf(projectId, dataDir);
        return jsonOk({ ok: true, op, planned: false, view });
      }
      const receipts: WorkReceipt[] = [];
      for (const command of planner.planned) receipts.push(await work.submit(command));
      const view = viewOf(projectId, dataDir);
      return jsonOk({ ok: true, op, receipts, view });
    } catch (e) {
      return failWith(e, what);
    }
  },
};

/**
 * `finalize_local_commit`：本地 Git 自动收尾的唯一入口（PLAN V09-66；DESIGN.md §6.13 第 7 段／§6.14 第 9 段）。
 *
 * 硬口径：
 *   · 入参闭键：**只收** project_id／task_id／workspace_id／role／actor_id／change_id／subject／body／finalize_id。
 *     **不收** grant／allow_local_commit／technical_verified／expected_root／任意 root——授权、目标根、技术/独审状态
 *     一律由**宿主读真实账本**派生（`gitFinalizeHost.createFinalizeFactSource`），请求不能自报通过。
 *   · 写只经唯一宿主（`ctx.work.finalizeLocalCommitRemote` → `POST /api/work/git/finalize`）：MCP 进程**不本地执行 git、
 *     不本地写账本**。宿主不支持该路由 ⇒ `UNSUPPORTED_BY_HOST`，**不回退**到本地写路由。
 *   · 成功但回执写失败：宿主如实返回并允许按 `finalize_id` 重试（复用同一提交、补回执，不造第二个 commit）。
 */
export const finalizeLocalCommitTool: McpTool = {
  name: "finalize_local_commit",
  description:
    "本地 Git 自动收尾（DESIGN.md §6.13 第 7 段／§6.14 第 9 段）：技术验证与独立审查通过且持有有效任务授权时，" +
    "由宿主对冻结候选做本地提交（提交内容===受验输入、不空提交、不 push、不改远端/配置）。授权/目标根/技术/独审" +
    "状态由宿主读真实账本派生，**请求不得自带** grant/通过布尔/root。写只经唯一宿主，MCP 不本地执行 git。",
  inputSchema: {
    type: "object",
    properties: {
      project_id: { type: "string", description: "注册表里的项目 id" },
      task_id: { type: "string", description: "要收尾的任务 id（授权与该任务的有效认领记录挂钩）" },
      workspace_id: { type: "string", description: "目标工作区 id（冻结候选；宿主读其 root 作 cwd）" },
      role: { type: "string", description: "调用方角色（executor/coordinator；不作凭证，仅辅助判据）" },
      actor_id: { type: "string", description: "执行者标识（缺省取 MCP 客户端名）" },
      change_id: { type: "string", description: "变更批次（不挂批次可省略）" },
      subject: { type: "string", description: "提交标题（第一行，必填）" },
      body: { type: "string", description: "提交正文（可选）" },
      finalize_id: { type: "string", description: "幂等键（可选；省略由宿主按稳定输入派生，重试复用同一提交）" },
    },
    required: ["project_id", "task_id", "workspace_id", "subject"],
    additionalProperties: false,
  },
  handler: async (args, ctx?: McpContext) => {
    const what = "finalize_local_commit";
    try {
      assertToolArgs(
        args,
        ["project_id", "task_id", "workspace_id", "role", "actor_id", "change_id", "subject", "body", "finalize_id"],
        what,
      );
      const projectId = str(args, "project_id");
      const taskId = str(args, "task_id");
      const workspaceId = str(args, "workspace_id");
      const subject = str(args, "subject");
      if (projectId === "") return errorResult(`${what} 缺入参 project_id`);
      if (taskId === "") return errorResult(`${what} 缺入参 task_id`);
      if (workspaceId === "") return errorResult(`${what} 缺入参 workspace_id`);
      if (subject === "") return errorResult(`${what} 缺入参 subject（提交标题）`);
      const work = ctx?.work;
      if (work === undefined) {
        return jsonError({
          ok: false,
          code: "SERVICE_UNAVAILABLE",
          message: `${what} 拿不到转接客户端（ctx.work）：收尾只由唯一宿主执行，MCP 不本地跑 git、不本地写账本（DESIGN.md §2.6/§6.14）`,
          detail: { tool: what },
        });
      }
      const fetched = await work.finalizeLocalCommitRemote({
        project_id: projectId,
        task_id: taskId,
        workspace_id: workspaceId,
        role: str(args, "role") || ctx?.clientName || "executor",
        actor_id: str(args, "actor_id") || ctx?.clientName || "unknown",
        ...(str(args, "change_id") === "" ? {} : { change_id: str(args, "change_id") }),
        subject,
        ...(typeof args.body === "string" ? { body: args.body } : {}),
        ...(str(args, "finalize_id") === "" ? {} : { finalize_id: str(args, "finalize_id") }),
      });
      if (fetched.kind === "unsupported") {
        return jsonError({ ok: false, code: "UNSUPPORTED_BY_HOST", message: fetched.reason, detail: { tool: what } });
      }
      if (fetched.kind === "unavailable") {
        return jsonError({ ok: false, code: "SERVICE_UNAVAILABLE", message: fetched.reason, detail: { tool: what } });
      }
      if (fetched.kind === "error") {
        return jsonError({ ok: false, code: fetched.code, message: fetched.message, detail: fetched.detail });
      }
      return jsonOk({ ok: true, result: fetched.result, association_evidence_id: fetched.association_evidence_id });
    } catch (e) {
      return failWith(e, what);
    }
  },
};
