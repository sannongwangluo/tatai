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
// P2/V09-47（DESIGN §6.11）：结果提交前的**只读预检**（独立工具名，旧宿主上明确"不支持"，绝不回退成写入）。
import { preflightTaskResultTool } from "./preflightTaskResult";
import { taskBriefTool } from "./taskBrief";
import { manageRequirementTool, manageChangeTool, importPlanDefinitionsTool } from "./workObjects";
import { rebindTaskTool } from "./rebindTask";
import { doctorTool } from "./doctor";
import { readDesignTool } from "./readDesign";
import { readPlanTool } from "./readPlan";
import { expandModuleTool } from "./expandModule";
import { readProgressTool } from "./readProgress";
import { reportTaskStatusTool } from "./reportTaskStatus";
import { reportExecutionTool } from "./reportExecution";
import { recordWorkEvidenceTool } from "./recordWorkEvidence";
import { manageBaselineTool } from "./manageBaseline";
import { projectIndexTool } from "./projectIndex";
import { selectProjectTool } from "./selectProject";
import { updateProgressTool } from "./updateProgress";
import { SYNC_EVIDENCE_TOOLS } from "./syncEvidence";
// B2/V09-52（DESIGN.md §6.12）：功能清单**只读**读口 feature_ledger（与 HTTP feature-ledger 同底层、同错误语义）。
import { featureLedgerTool } from "./featureLedger";
import { registerToolNameSource } from "../../server/work/eventSurface";
import type { McpTool } from "./types";

/** 全部已注册工具（按注册顺序暴露给 listTools） */
export const TOOLS: readonly McpTool[] = [
  listProjectsTool,
  selectProjectTool,
  readDesignTool,
  // V09-32/V09-33（DESIGN.md §6.8；契约 U3）：施工图**按卡／索引／章节／行范围**原读取材，复用
  // documents.ts 的分段机制；定义存在与执行台账分开（未入账卡仍可读）；续读绑完整 sha 与项目/文档，
  // 旧短前缀游标明确失效重取。只读：不存在 write_plan。
  readPlanTool,
  // V09-35（DESIGN.md §6.8；契约 U3）：深层结构 MCP 下钻，复用 expandProject（与 HTTP 同一派生）；
  // 稳定分页 + 来源版本、预算/忽略/静态依赖如实声明、中间联接点防逃逸。只读：不写图/账本、不调模型。
  expandModuleTool,
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
  // P2/V09-47：提交前**只读**预检（与 submit_task_result 同形输入、共用同一份判据；不写字节、不自愈、
  // 不产生通行票；旧宿主 unsupported，绝不回退成写入）。注册在 submit 之后，工具面 29 → 30。
  preflightTaskResultTool,
  // V09-41（docs/efficiency-20261004.md）：project_entry 的**紧凑只读简报**——同一份同版判据一次算好后
  // 只投影白名单字段（next_action/全部 blocking 理由/角色能力/基线/当前卡范围/必读/sync/图简要），
  // 冗长字段改为补取入口。只读、不认领、不写账、不调模型；描述见 projectEntry.ts 顶部（§6.7）。
  taskBriefTool,
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
  // V09-23（DESIGN §2.10 / docs/sync-evidence-contract.md）：同步域三个规范接口——
  // register_sync_contract（写）/ scan_sync_evidence（写，经宿主）/ read_sync_status（只读）。
  ...SYNC_EVIDENCE_TOOLS,
  // V09-27（DESIGN.md §5.4/§5.5/§6.7；契约 F3）：Agent 完整上报链的可达入口——
  // report_execution（执行回执/心跳/检查点/停止/失败的受控适配）、
  // record_work_evidence（证据正文经宿主 + 成果登记/自检/独审/修复/复测/缺陷的受控适配）。
  // 两者都经 ctx.work 转接唯一写入服务；report_task_status 的 v2 扩展复用同一份写边界判据。
  reportExecutionTool,
  recordWorkEvidenceTool,
  // V09-28（DESIGN.md §2.9/§6.7；契约 F1）：正向成套图纸入口（read/preserve/activate 经唯一宿主）。
  // 由 V09-27 统一在本注册表集成（基线工人产出该文件，不在别处另注册）。
  manageBaselineTool,
  // V09-39（DESIGN.md §6.8；契约 U5/U5.1）：持久项目说明索引——read/impact/coverage 只读（本地读、不拉 writer），
  // upsert/remove 经唯一宿主（完整文件 hash CAS＋锁内核对＋原子写）。Agent 声明默认待审；未声明≠无影响。
  projectIndexTool,
  // B2/V09-52（DESIGN.md §6.12／契约 B2）：功能清单**只读**读口 feature_ledger——同一 revision 事实快照 →
  // 唯一义务派生 → feature_item[]（四维分开，绿只取 verification）；与 HTTP GET feature-ledger 同底层、同错误语义。
  // 只读：不写事件/证据/租约、不触发扫描、不自愈、不调模型；工具面 30 → 31。
  featureLedgerTool,
];

export function findTool(name: string): McpTool | undefined {
  return TOOLS.find((t) => t.name === name);
}

// 事件面检查（`src/server/work/eventSurface.ts`）需要工具名单来断言"每种事件的 mcp: 出口真实存在"。
// 方向必须是**注册表 → 检查器**（检查器在下层，反向 import 会成环，见 eventSurface.ts 顶部注释）：
// 这里在 TOOLS 建好之后把名单登记进去。放在文件末尾而不是顶部——登记的是读取 TOOLS 的闭包，
// 顶部登记会在 TOOLS 尚未初始化时就把一个未定义的引用传出去。
registerToolNameSource(() => TOOLS.map((t) => t.name));
