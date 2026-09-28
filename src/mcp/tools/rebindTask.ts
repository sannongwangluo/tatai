// rebind_task：把待重绑的任务重新绑到当前施工定义（§5.6 可追溯修订，不静默换输入）。
//
// 出口补全（PLAN V07-02）：事件类型 task.rebound 此前没有任何工具能触发——2026-09-21 实测
// "定义哈希绑定口径错位"曾把全部任务推入待重绑且无路可出。原则：系统能进的状态必须有出口。
// 本工具只做重绑处置（continue/adjust/pause），不改定义内容——定义来自项目施工图现解析。
import { getProject, resolveDataDir } from "../../server/registry";
import { projectWorkDir } from "../../server/workstation";
import { loadDocument } from "../../server/work/documents";
import { importTaskDefinitions, taskDefinitionHash } from "../../server/work/plan";
import { readTaskStates, submitTaskRebind, type WorkSubmitter } from "../../server/work/tasks";
import { WorkError, type WorkReceipt } from "../../server/work/types";
import { errorResult, textResult, type McpContext, type McpTool } from "./types";

const DISPOSITIONS = ["continue", "adjust", "pause"] as const;
type Disposition = (typeof DISPOSITIONS)[number];

/** 计划占位回执：真实回执一定来自唯一写入服务（与 workObjects.runPlanned 同口径） */
const PLANNED_ONLY_RECEIPT: WorkReceipt = {
  ok: true,
  event_id: "<planned-尚未提交>",
  seq: 0,
  entity_revision: 0,
  received_at: "",
  duplicate: false,
  projection: { state: "failed", error: "计划占位，事件尚未提交" },
};

export const rebindTaskTool: McpTool = {
  name: "rebind_task",
  description:
    "重绑处置（§5.6）：把待重绑的任务重新绑到当前施工图定义，产出 task.rebound 事件留痕（from/to 定义哈希＋处置 disposition）。「系统能进的状态必须有出口」——" +
    "定义内容仍以施工图为准，本工具不定义新卡；disposition＝continue（按新定义继续）/adjust（调整后再继续）/pause（暂停待议）",
  inputSchema: {
    type: "object",
    properties: {
      project_id: { type: "string", description: "注册表里的项目 id" },
      task_id: { type: "string", description: "任务 id（须已有运行状态且待重绑）" },
      disposition: { type: "string", enum: [...DISPOSITIONS], description: "已有 run 的处置：continue/adjust/pause" },
      change_id: { type: "string", description: "事件信封的变更批次（重绑是留痕处置，建议挂批次；缺省 change-none）" },
      role: { type: "string", description: "调用方角色" },
    },
    required: ["project_id", "task_id", "disposition", "role"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const projectId = typeof args.project_id === "string" ? args.project_id.trim() : "";
    const taskId = typeof args.task_id === "string" ? args.task_id.trim() : "";
    const disposition = typeof args.disposition === "string" ? args.disposition.trim() : "";
    const role = typeof args.role === "string" ? args.role.trim() : "";
    const changeId = typeof args.change_id === "string" && args.change_id.trim() !== "" ? args.change_id.trim() : "change-none";
    if (projectId === "" || taskId === "" || role === "") {
      return errorResult("rebind_task 缺入参 project_id/task_id/disposition/role");
    }
    if (!DISPOSITIONS.includes(disposition as Disposition)) {
      return errorResult(`非法 disposition: ${JSON.stringify(disposition)}，只接受 ${DISPOSITIONS.join("/")}`);
    }
    try {
      const dataDir = resolveDataDir();
      if (getProject(projectId, dataDir) === undefined) {
        throw new WorkError("INVALID_COMMAND", `项目不存在: ${projectId}`, { project_id: projectId });
      }
      const plan = loadDocument(projectId, "plan", dataDir);
      if (plan === null) {
        throw new WorkError("INVALID_COMMAND", `项目没有登记的施工图，无从取当前定义（project_id=${projectId}）`, {
          project_id: projectId,
        });
      }
      const defs = importTaskDefinitions(plan.text, { plan_revision: plan.revision.content_sha256 }).definitions;
      const key = taskId.trim().toUpperCase();
      const def = defs.find((d) => d.task_id.trim().toUpperCase() === key);
      if (def === undefined) {
        throw new WorkError(
          "INVALID_COMMAND",
          `当前施工图定义里没有任务 ${taskId}——重绑只能绑到现有定义；卡已删除/改名请走设计修订（§5.6）`,
          { task_id: taskId },
        );
      }
      const workDir = projectWorkDir(projectId, dataDir);
      const state = readTaskStates(workDir).states[key];
      if (state === undefined) {
        throw new WorkError("INVALID_COMMAND", `任务 ${taskId} 还没有运行状态（先经 import_plan_definitions 受检导入）`, {
          task_id: taskId,
        });
      }
      const currentHash = taskDefinitionHash({ ...def, change_id: state.definition_change_id });
      if (state.definition_sha256 === currentHash) {
        return errorResult(
          `任务 ${taskId} 已绑定当前定义（${currentHash.slice(0, 12)}…），无需重绑；若 project_entry 仍报待重绑，先核对基线与图纸修订`,
        );
      }
      const work = ctx?.work;
      if (work === undefined) {
        throw new WorkError(
          "SERVICE_UNAVAILABLE",
          "rebind_task 拿不到转接客户端（ctx.work）：v2 事实只有一个写入者，MCP 不自己追加事件（DESIGN.md §2.6）",
          { tool: "rebind_task" },
        );
      }
      // 校验＋计划（同步，零写入）→ 转接真实提交（异步，唯一写入者仲裁）——与 workObjects 同模式
      const planned: unknown[] = [];
      const planner: WorkSubmitter = {
        submit: (command: unknown): WorkReceipt => {
          planned.push(command);
          return PLANNED_ONLY_RECEIPT;
        },
      };
      submitTaskRebind(planner, {
        project_id: projectId,
        task_id: taskId,
        change_id: changeId,
        actor_id: ctx?.clientName ?? role,
        role,
        expected_revision: state.revision,
        from_definition_sha256: state.definition_sha256,
        definition: def,
        disposition: disposition as Disposition,
      });
      if (planned.length !== 1) {
        throw new WorkError("INVALID_COMMAND", "rebind_task 校验通过但没有计划出命令——工具内部异常，本次零写入", {
          tool: "rebind_task",
        });
      }
      const receipt = await work.submit(planned[0]);
      return textResult(
        JSON.stringify(
          {
            ok: receipt.ok,
            task_id: taskId,
            from_definition_sha256: state.definition_sha256?.slice(0, 12) ?? null,
            to_definition_sha256: currentHash.slice(0, 12),
            disposition,
            receipt,
          },
          null,
          2,
        ),
      );
    } catch (e) {
      if (e instanceof WorkError) return errorResult(`${e.code}: ${e.message}`);
      return errorResult(`rebind_task 失败：${e instanceof Error ? e.message : String(e)}`);
    }
  },
};
