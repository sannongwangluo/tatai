// list_tasks：列项目任务（DESIGN.md §6.3 第八行，§2.3.4 原样返回），可按 module_id 过滤。
// V06-03：台账是 v2 兼容投影时额外回一段 `projection`（来源 + last_seq + 语义声明）——
// 调用方据此知道这份 tasks.json 是**派生投影**而不是事实源，v1 四态的 done 只表示"结果已提交"。
// V09-08 ⑤（附录 E.6 第 1 条）：任务行与 `projection.last_seq` **同源**（都来自 v2 事件账本）；
// 旧 compat 文件自己的序号另报 `compat_snapshot_seq` 并标 `stale`，不冒充实时任务行版本。
import { listTasks, tasksProjectionInfo } from "../../server/workstation";
import { errorResult, textResult, type McpTool } from "./types";

export const listTasksTool: McpTool = {
  name: "list_tasks",
  description:
    "列项目任务列表（§2.3.4 全字段原样返回），可选 module_id 过滤（DESIGN.md §6.3）。" +
    "已迁移项目：任务行来自 v2 事件账本（每行带 `ledger_source`/`v2_status`），`projection.last_seq` 与行同源，" +
    "旧 `tasks.json` 快照的序号在 `compat_snapshot_seq`（落后时 `stale=true`）；未迁移项目仍整份读 v1 台账文件。",
  inputSchema: {
    type: "object",
    properties: {
      project_id: { type: "string", description: "注册表里的项目 id" },
      module_id: { type: "string", description: "可选；只返回该模块下的任务" },
    },
    required: ["project_id"],
    additionalProperties: false,
  },
  handler: (args) => {
    const projectId = typeof args.project_id === "string" ? args.project_id.trim() : "";
    if (projectId === "") {
      return errorResult("list_tasks 缺入参 project_id");
    }
    const moduleId = typeof args.module_id === "string" ? args.module_id.trim() : "";
    const tasks = listTasks(projectId).filter((t) => moduleId === "" || t.module_id === moduleId);
    const projection = tasksProjectionInfo(projectId);
    return textResult(
      JSON.stringify(projection === null ? { tasks } : { tasks, projection }, null, 2),
    );
  },
};
