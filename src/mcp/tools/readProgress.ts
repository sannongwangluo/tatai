// read_progress：读项目 Gate 状态（current_step/history）+ 模块状态（DESIGN.md §6.3 第四行，§2.3.2）。
// 只读；progress.json 不存在时按 G1 口径初始化后再读（幂等）。
// V06-03：项目台账是 v2 兼容投影时，额外回 `tasks_projection`（来源 + last_seq + 语义声明）——
// 只是如实说明"任务台账是派生投影"，不改任何既有字段（未迁移项目的回执逐字不变）。
// V09-08 ⑤（附录 E.6 第 2/3 条）：已迁移项目回 `modules_projection`，**明说 `modules` 是 v1 兼容读数**
// （progress.json 自报四色）而不是 v2 状态；未迁移项目不带这个键，回执逐字不变。
import { progressCompatInfo, readProgress, tasksProjectionInfo } from "../../server/workstation";
import { errorResult, textResult, type McpTool } from "./types";

export const readProgressTool: McpTool = {
  name: "read_progress",
  description:
    "读项目 Gate 状态（current_step/history）+ 模块四色状态（DESIGN.md §6.3）。" +
    "已迁移项目：`modules` 是 `progress.json` 的 **v1 兼容读数**（随附 `modules_projection` 说明），" +
    "模块/能力的现行状态由证据派生（见状态投影 `display_status`），别拿 v1 四色当 v2 状态；" +
    "`tasks_projection` 里的任务行与 `last_seq` 同源（v2 事件账本），旧文件序号在 `compat_snapshot_seq`。",
  inputSchema: {
    type: "object",
    properties: {
      project_id: { type: "string", description: "注册表里的项目 id" },
    },
    required: ["project_id"],
    additionalProperties: false,
  },
  handler: (args) => {
    const projectId = typeof args.project_id === "string" ? args.project_id.trim() : "";
    if (projectId === "") {
      return errorResult("read_progress 缺入参 project_id");
    }
    const progress = readProgress(projectId);
    const projection = tasksProjectionInfo(projectId);
    const modulesCompat = progressCompatInfo(projectId);
    return textResult(
      JSON.stringify(
        {
          gate: progress.gate,
          modules: progress.modules,
          ...(projection === null ? {} : { tasks_projection: projection }),
          ...(modulesCompat === null ? {} : { modules_projection: modulesCompat }),
        },
        null,
        2,
      ),
    );
  },
};
