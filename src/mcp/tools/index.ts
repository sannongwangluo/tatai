// 工具统一注册表：本目录每加一个工具文件，在这里登记一行。
// M2 已补齐一期 8 个基础工具（DESIGN.md §6.3）；2026-09-19 主人拍板补 get_arch + ask_flash（§6.4）。
// 硬性权限红线（§6.3，DoD②③ 证伪点）：
//   · 不存在 write_design——设计书只有 Flash 落稿 / Max 审改两条笔；
//   · append_discuss 只能追加，改/删已有条目的入参形态一律拒绝；
//   · 没有任何改 Gate 状态的工具——Gate 转移只有人能触发（§5.2）。
import { appendDiscussTool } from "./appendDiscuss";
import { askFlashTool } from "./askFlash";
import { getArchTool } from "./getArch";
import { getProjectGraphsTool } from "./getProjectGraphs";
import { listProjectsTool } from "./listProjects";
import { listTasksTool } from "./listTasks";
import { projectEntryTool, claimTaskTool, submitTaskResultTool } from "./projectEntry";
import { manageRequirementTool, manageChangeTool, importPlanDefinitionsTool } from "./workObjects";
import { rebindTaskTool } from "./rebindTask";
import { doctorTool } from "./doctor";
import { readDesignTool } from "./readDesign";
import { readProgressTool } from "./readProgress";
import { reportTaskStatusTool } from "./reportTaskStatus";
import { selectProjectTool } from "./selectProject";
import { updateProgressTool } from "./updateProgress";
import { registerToolNameSource } from "../../server/work/eventSurface";
import type { McpTool } from "./types";

/** 全部已注册工具（按注册顺序暴露给 listTools） */
export const TOOLS: readonly McpTool[] = [
  listProjectsTool,
  selectProjectTool,
  readDesignTool,
  readProgressTool,
  reportTaskStatusTool,
  updateProgressTool,
  appendDiscussTool,
  listTasksTool,
  getArchTool,
  // V09-19（DESIGN.md §6.4／§6.7、附录 E.18 四）：六图**完整当前状态**读口——四档读取（全六图/单图/节点/关系）、
  // 同一快照标识、不完整时给 total/returned/cursor、逐对象带状态与证据、模型待审线索单列、数据流向图分两层。
  // 只读：不写盘、不调模型；现有 get_arch 的技术详情层含义与兼容返回不变。
  getProjectGraphsTool,
  askFlashTool,
  // V06-10（DESIGN.md §6.7）：项目接续入口 + 认领/回报写口。
  // 入口只读、不认领；认领是带 expected_revision 的单独原子写（§2.7）。
  projectEntryTool,
  claimTaskTool,
  submitTaskResultTool,
  // 批3 C-015 接线（DESIGN.md §2.5/§2.6）：需求/变更对象命令与受检施工定义导入的真实入口。
  // 校验只活在对象命令层（单一判据来源）；写操作经 ctx.work 转接唯一写入服务，read 只读投影。
  manageRequirementTool,
  manageChangeTool,
  importPlanDefinitionsTool,
  // V07-02（DESIGN.md §5.6）：待重绑的出口——事件面检查（scripts/check-event-surface.ts）
  // 断言每种事件类型有工具触发路径或白名单"仅系统内部"，本工具补上 task.rebound 的路径。
  rebindTaskTool,
  // V07-04（DESIGN 附录 C.5-4）：接续入口体检——一次调用报写服务/描述符/基线/迁移/事件面五项；
  // 只读探活，heal=true 才走自愈。它只报事实，不做任何写入（不是 gate 写入类工具）。
  doctorTool,
];

export function findTool(name: string): McpTool | undefined {
  return TOOLS.find((t) => t.name === name);
}

// 事件面检查（`src/server/work/eventSurface.ts`）需要工具名单来断言"每种事件的 mcp: 出口真实存在"。
// 方向必须是**注册表 → 检查器**（检查器在下层，反向 import 会成环，见 eventSurface.ts 顶部注释）：
// 这里在 TOOLS 建好之后把名单登记进去。放在文件末尾而不是顶部——登记的是读取 TOOLS 的闭包，
// 顶部登记会在 TOOLS 尚未初始化时就把一个未定义的引用传出去。
registerToolNameSource(() => TOOLS.map((t) => t.name));
