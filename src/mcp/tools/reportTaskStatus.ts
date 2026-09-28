// report_task_status：agent 自报任务状态（DESIGN.md §6.3 第五行，§5.3 任务状态机）。
// 写 tasks.json（§2.3.4 全字段：id/title/module_id/status/reporter/updated_at/note?），复用 G1 数据层，不另起存储。
// 任务不存在时按入参补 title 新建（agent 首报即建档）；已存在则只改状态、刷新 updated_at。
// reporter 口径：入参 reporter 显式给优先；缺省取 MCP 客户端 initialize 握手自报的 clientInfo.name，
// 再缺省 "unknown"。note 落盘留痕（2026-09-19 主人拍板，附录 B M2 条收口）：非空即写入任务的
// note 字段；不传/空串保留旧备注——回执里的 note 与落盘值一致。
import {
  addTask,
  listTasks,
  setTaskStatus,
  TASK_STATUSES,
  WsError,
  type TaskStatus,
} from "../../server/workstation";
import { errorResult, textResult, type McpContext, type McpTool } from "./types";

export const reportTaskStatusTool: McpTool = {
  name: "report_task_status",
  description:
    "agent 自报任务状态（todo/doing/done/blocked，DESIGN.md §5.3）；任务不存在时按入参 title 首报即建档。reporter 缺省取 MCP 客户端名",
  inputSchema: {
    type: "object",
    properties: {
      project_id: { type: "string", description: "注册表里的项目 id" },
      task_id: { type: "string", description: "任务 id（已存在改状态，不存在新建）" },
      status: {
        type: "string",
        enum: [...TASK_STATUSES],
        description: "任务状态四值（§5.3）",
      },
      note: { type: "string", description: "可选说明（落盘留痕：写入 tasks.json 的 note 字段，§2.3.4；不传保留旧备注）" },
      title: { type: "string", description: "可选；仅新建任务时用，缺省取 task_id" },
      module_id: { type: "string", description: "可选；仅新建任务时用，缺省空串" },
      reporter: { type: "string", description: "可选；缺省取 MCP 客户端自报名（clientInfo.name）" },
    },
    required: ["project_id", "task_id", "status"],
    additionalProperties: false,
  },
  handler: (args, ctx?: McpContext) => {
    const projectId = typeof args.project_id === "string" ? args.project_id.trim() : "";
    const taskId = typeof args.task_id === "string" ? args.task_id.trim() : "";
    const status = typeof args.status === "string" ? args.status.trim() : "";
    if (projectId === "" || taskId === "" || status === "") {
      return errorResult("report_task_status 缺入参 project_id/task_id/status");
    }
    if (!TASK_STATUSES.includes(status as TaskStatus)) {
      return errorResult(
        `非法任务状态: ${JSON.stringify(status)}，只接受 ${TASK_STATUSES.join("/")}（DESIGN.md §5.3）`,
      );
    }
    const reporter =
      (typeof args.reporter === "string" && args.reporter.trim()) ||
      ctx?.clientName ||
      "unknown";
    const note = typeof args.note === "string" && args.note !== "" ? args.note : undefined;

    try {
      const existing = listTasks(projectId).find((t) => t.id === taskId);
      const record = existing
        ? setTaskStatus(projectId, taskId, status as TaskStatus, undefined, note)
        : addTask(projectId, {
            id: taskId,
            title:
              (typeof args.title === "string" && args.title.trim()) || taskId,
            module_id:
              typeof args.module_id === "string" ? args.module_id : "",
            reporter,
            status: status as TaskStatus,
            ...(note !== undefined ? { note } : {}),
          });
      // V06-03：写成功后台账一定不是投影（是投影就已被闸门拒写），故这里不追加任何字段——
      // 未迁移项目的回执逐字不变。
      return textResult(
        JSON.stringify(
          { created: !existing, task: record, note: note ?? null },
          null,
          2,
        ),
      );
    } catch (e) {
      // V06-03：已迁移项目必须拒写（旧写工具缺版本/认领参数），把"怎么升级"如实回给调用方
      if (e instanceof WsError && e.code === "WRITE_UPGRADE_REQUIRED") {
        return errorResult(e.message);
      }
      throw e;
    }
  },
};
