// report_task_status：agent 自报任务阶段（DESIGN.md §5.3 任务状态机、§5.4/§6.7，契约 F3）。
//
// 两条路径并存，**v1 行为逐字不变**：
//   · v1（未给 v2 字段）：写 `tasks.json`（§2.3.4 全字段），复用 G1 数据层。已迁移项目照旧被
//     `WRITE_UPGRADE_REQUIRED` 拒写，并把"怎么升级"如实回给调用方（不静默回退到 tasks.json）。
//   · v2（给了 expected_revision/claim_token/request_id/reason/readiness_basis 任一）：经唯一写入服务
//     转接上报阶段——doing→`task.status_changed(executing)`、blocked→`task.blocked`、
//     ready→`task.status_changed(ready)`（**协调器专用 + 可取回依据**）。校验/幂等/版本/认领全部在
//     唯一写入服务（与 `claims.reportTaskPhase` 同一份 `verifyTaskPhaseCommand`），MCP 不自己追加事件。
//
// 硬红线：
//   · `done` **不在这里偷写通过**——完成必须走 `submit_task_result`（带证据/认领/版本五查）。
//   · 阶段上报不接受 user 身份去操作 Gate/人工验收（人工验收只在用户页面 HTTP 面，Agent 不代签）。
import {
  addTask,
  listTasks,
  setTaskStatus,
  TASK_STATUSES,
  WsError,
  type TaskStatus,
} from "../../server/workstation";
import { NO_CHANGE_ID } from "../../server/work/types";
import { reportTaskPhase, type TaskPhaseReport } from "../../server/work/claims";
import { resolveDataDir } from "../../server/registry";
import { errorResult, textResult, type McpContext, type McpTool, type ToolResult } from "./types";

function jsonOk(payload: unknown): ToolResult {
  return textResult(JSON.stringify(payload, null, 2));
}

function jsonError(payload: unknown): ToolResult {
  return errorResult(JSON.stringify(payload, null, 2));
}

/** v1 状态 → v2 阶段（`ready` 是 v1 没有的位，但解阻上报用它；`todo`/`done` 无 v2 映射） */
const V2_PHASE_OF: Readonly<Record<string, TaskPhaseReport>> = {
  doing: "doing",
  blocked: "blocked",
  ready: "ready",
};

const V2_KEYS = ["expected_revision", "claim_token", "request_id", "reason", "readiness_basis", "owner_id", "change_id", "role"] as const;

export const reportTaskStatusTool: McpTool = {
  name: "report_task_status",
  description:
    "agent 自报任务状态（todo/doing/done/blocked/ready）。**v1**（不给 v2 字段）：写 tasks.json，已迁移项目被拒并给升级指南。" +
    "**v2**（给 expected_revision 等字段）：经唯一写入服务上报——doing→执行中、blocked→阻塞（带 reason）、" +
    "ready→解阻（**协调器专用 + readiness_basis 可取回依据**）；都要带 expected_revision 与当前 claim_token/owner。" +
    "**done 请走 submit_task_result**（带证据/认领/版本五查），这里不把完成偷写成通过。",
  inputSchema: {
    type: "object",
    properties: {
      project_id: { type: "string", description: "注册表里的项目 id" },
      task_id: { type: "string", description: "任务 id（已存在改状态，不存在新建——仅 v1 路径）" },
      status: {
        type: "string",
        enum: [...TASK_STATUSES, "ready"],
        description: "任务状态四值（§5.3）或 v2 解阻位 ready",
      },
      note: { type: "string", description: "v1 可选说明（落盘 tasks.json 的 note 字段；不传保留旧备注）" },
      title: { type: "string", description: "v1 可选；仅新建任务时用，缺省取 task_id" },
      module_id: { type: "string", description: "v1 可选；仅新建任务时用，缺省空串" },
      reporter: { type: "string", description: "v1 可选；缺省取 MCP 客户端自报名（clientInfo.name）" },
      // ── v2 上报字段（给任一即走 v2） ──
      expected_revision: { type: "number", description: "v2 必填：上报前读到的实体版本（project_entry 的 task_revision）" },
      claim_token: { type: "string", description: "v2 doing/blocked 必填：本次认领 token（只有持有者能报自己那张卡）" },
      owner_id: { type: "string", description: "v2 可选：持有者标识（缺省取 MCP 客户端名，再缺省取 role）" },
      role: { type: "string", description: "v2 可选：调用方角色（ready 解阻必须 coordinator）" },
      change_id: { type: "string", description: `v2 可选：事件信封的变更批次（缺省 ${NO_CHANGE_ID}）` },
      request_id: { type: "string", description: "v2 可选：稳定幂等键——重复上报返回原回执，不产生第二次效果" },
      reason: { type: "string", description: "v2 必填（blocked）／可选（ready）：阻塞或解阻理由" },
      readiness_basis: {
        type: "array",
        items: { type: "string" },
        description: "v2 ready（解阻）必填：可取回依据（项目根内相对路径 / event:<id> / 64 位证据哈希）；随便一句授权的话不算凭据",
      },
    },
    required: ["project_id", "task_id", "status"],
    additionalProperties: false,
  },
  handler: async (args, ctx?: McpContext): Promise<ToolResult> => {
    const projectId = typeof args.project_id === "string" ? args.project_id.trim() : "";
    const taskId = typeof args.task_id === "string" ? args.task_id.trim() : "";
    const status = typeof args.status === "string" ? args.status.trim() : "";
    if (projectId === "" || taskId === "" || status === "") {
      return errorResult("report_task_status 缺入参 project_id/task_id/status");
    }
    const known: readonly string[] = [...TASK_STATUSES, "ready"];
    if (!known.includes(status)) {
      return errorResult(
        `非法任务状态: ${JSON.stringify(status)}，只接受 ${TASK_STATUSES.join("/")}/ready（DESIGN.md §5.3）`,
      );
    }

    const v2Requested = V2_KEYS.some((k) => args[k] !== undefined);
    if (v2Requested) return v2Report(args, ctx, status as TaskStatus | "ready", projectId, taskId);

    // ── v1 路径（未给任何 v2 字段）：行为逐字不变 ──
    if (status === "ready") {
      return errorResult(
        "report_task_status(status=ready) 是 v2 解阻上报：请带 expected_revision 等 v2 字段（并且解阻是协调器专用、必须给 readiness_basis）",
      );
    }
    const reporter =
      (typeof args.reporter === "string" && args.reporter.trim()) || ctx?.clientName || "unknown";
    const note = typeof args.note === "string" && args.note !== "" ? args.note : undefined;
    try {
      const existing = listTasks(projectId).find((t) => t.id === taskId);
      const record = existing
        ? setTaskStatus(projectId, taskId, status as TaskStatus, undefined, note)
        : addTask(projectId, {
            id: taskId,
            title: (typeof args.title === "string" && args.title.trim()) || taskId,
            module_id: typeof args.module_id === "string" ? args.module_id : "",
            reporter,
            status: status as TaskStatus,
            ...(note !== undefined ? { note } : {}),
          });
      // V06-03：写成功后台账一定不是投影（是投影就已被闸门拒写），故这里不追加任何字段——
      // 未迁移项目的回执逐字不变。
      return textResult(JSON.stringify({ created: !existing, task: record, note: note ?? null }, null, 2));
    } catch (e) {
      // V06-03：已迁移项目必须拒写（旧写工具缺版本/认领参数），把"怎么升级"如实回给调用方
      if (e instanceof WsError && e.code === "WRITE_UPGRADE_REQUIRED") {
        return errorResult(e.message);
      }
      throw e;
    }
  },
};

/** v2 阶段上报（转接唯一写入服务；不自己写事件） */
async function v2Report(
  args: Record<string, unknown>,
  ctx: McpContext | undefined,
  status: TaskStatus | "ready",
  projectId: string,
  taskId: string,
): Promise<ToolResult> {
  // done/todo 无 v2 映射：done 引导到 submit_task_result，禁止偷写通过
  if (status === "done") {
    return jsonError({
      ok: false,
      code: "USE_SUBMIT_TASK_RESULT",
      message:
        "done 不在 report_task_status 的 v2 上报里：完成要经 submit_task_result（带证据/认领/版本五查），" +
        "Agent 不能把“完成”写成“已通过/已验收”（DESIGN.md §5.4/§6.7）。",
      how_to: {
        tool: "submit_task_result",
        inputs: ["project_id", "task_id", "role", "change_id", "claim_token", "expected_revision", "evidence_refs"],
        note: "result_submitted 只表示执行者已交结果，不等于审计通过或人工验收接受",
      },
    });
  }
  if (status === "todo") {
    return jsonError({
      ok: false,
      code: "INVALID_COMMAND",
      message:
        "v2 没有把卡退回 todo 的上报：任务状态由事件推进（认领→执行→提交/阻塞），不往回退；" +
        "要重做已提交的卡请由协调器走 claim_task(op=reopen) 建立新 attempt。",
    });
  }
  const phase = V2_PHASE_OF[status];
  if (phase === undefined) {
    return jsonError({ ok: false, code: "INVALID_COMMAND", message: `report_task_status 的 v2 不接受 status=${JSON.stringify(status)}` });
  }
  if (
    args.expected_revision !== undefined &&
    (typeof args.expected_revision !== "number" || !Number.isFinite(args.expected_revision))
  ) {
    return jsonError({
      ok: false,
      code: "INVALID_COMMAND",
      message: `expected_revision 必须是有限数值（收到 ${JSON.stringify(args.expected_revision)}）`,
    });
  }
  const expected = typeof args.expected_revision === "number" && Number.isFinite(args.expected_revision) ? args.expected_revision : null;
  if (expected === null) {
    return jsonError({
      ok: false,
      code: "INVALID_COMMAND",
      message: "v2 上报必须带 expected_revision（project_entry 的 task_revision）：原子写要声明“我以为它是哪一版”",
    });
  }
  const work = ctx?.work;
  if (work === undefined) {
    return jsonError({ ok: false, code: "SERVICE_UNAVAILABLE", message: "report_task_status(v2) 拿不到转接客户端（ctx.work）：v2 事实只有一个写入者（DESIGN.md §2.6）" });
  }
  const role = (typeof args.role === "string" && args.role.trim()) || "executor";
  const actorId = (typeof args.owner_id === "string" && args.owner_id.trim()) || ctx?.clientName || role;
  const changeId = (typeof args.change_id === "string" && args.change_id.trim()) || NO_CHANGE_ID;
  const claimToken = typeof args.claim_token === "string" ? args.claim_token.trim() : "";
  const requestId = typeof args.request_id === "string" ? args.request_id.trim() : "";
  if (
    args.readiness_basis !== undefined &&
    (!Array.isArray(args.readiness_basis) || args.readiness_basis.some((b) => typeof b !== "string" || b.trim() === ""))
  ) {
    return jsonError({
      ok: false,
      code: "INVALID_COMMAND",
      message: "readiness_basis 必须是「全是非空字符串」的数组（不在上报前静默删掉你给的项）",
    });
  }
  const readinessBasis = Array.isArray(args.readiness_basis) ? (args.readiness_basis as string[]) : [];
  try {
    const outcome = await reportTaskPhase(
      {
        project_id: projectId,
        task_id: taskId,
        change_id: changeId,
        phase,
        role,
        actor_id: actorId,
        expected_revision: expected,
        ...(claimToken === "" ? {} : { claim_token: claimToken }),
        ...(typeof args.reason === "string" && args.reason.trim() !== "" ? { reason: args.reason } : {}),
        ...(readinessBasis.length === 0 ? {} : { readiness_basis: readinessBasis }),
        ...(requestId === "" ? {} : { request_id: requestId }),
      },
      work,
      resolveDataDir(),
    );
    return outcome.ok ? jsonOk(outcome) : jsonError(outcome);
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "SERVICE_UNAVAILABLE") {
      return jsonError({ ok: false, code, message: (e as Error).message, detail: (e as { detail?: unknown }).detail });
    }
    throw e;
  }
}
