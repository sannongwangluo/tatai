// update_progress：改模块四色状态（todo/doing/done/issue，DESIGN.md §2.3.2/§6.3 第六行）。
// 红线：改的是【模块状态】，不是 Gate 状态——Gate 转移只有人能触发（§5.2），
// §6.3 工具清单里没有任何 gate 写入工具，本工具绝不碰 gate.current_step/history。
import { MODULE_STATUSES, setModuleStatus, WsError, type ModuleStatus } from "../../server/workstation";
import { errorResult, textResult, type McpTool } from "./types";

export const updateProgressTool: McpTool = {
  name: "update_progress",
  description:
    "更新模块四色状态（todo/doing/done/issue，DESIGN.md §2.3.2）；只改模块状态，不动 Gate（§5.2 Gate 只有人能触发）",
  inputSchema: {
    type: "object",
    properties: {
      project_id: { type: "string", description: "注册表里的项目 id" },
      module_id: { type: "string", description: "模块 id（须已存在）" },
      status: {
        type: "string",
        enum: [...MODULE_STATUSES],
        description: "模块状态四值（§2.3.2 四色表）",
      },
    },
    required: ["project_id", "module_id", "status"],
    additionalProperties: false,
  },
  handler: (args) => {
    const projectId = typeof args.project_id === "string" ? args.project_id.trim() : "";
    const moduleId = typeof args.module_id === "string" ? args.module_id.trim() : "";
    const status = typeof args.status === "string" ? args.status.trim() : "";
    if (projectId === "" || moduleId === "" || status === "") {
      return errorResult("update_progress 缺入参 project_id/module_id/status");
    }
    if (!MODULE_STATUSES.includes(status as ModuleStatus)) {
      return errorResult(
        `非法模块状态: ${JSON.stringify(status)}，只接受 ${MODULE_STATUSES.join("/")}（DESIGN.md §2.3.2）`,
      );
    }
    try {
      const progress = setModuleStatus(projectId, moduleId, status as ModuleStatus);
      const m = progress.modules.find((m) => m.id === moduleId);
      return textResult(JSON.stringify({ module: m }, null, 2));
    } catch (e) {
      // V06-03：已迁移项目拒写（模块四色不再是旧工具汇总出来的），把升级要求如实回给调用方；
      // 未迁移项目的回执与异常传播方式保持不变。
      if (e instanceof WsError && e.code === "WRITE_UPGRADE_REQUIRED") {
        return errorResult(e.message);
      }
      throw e;
    }
  },
};
