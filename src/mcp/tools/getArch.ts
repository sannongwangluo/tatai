// get_arch：读架构图**技术详情层**（模块方框图 / 数据流向图 / 思维导图共用）的渲染数据
// （DESIGN.md §6.4、附录 E.6 第 2 条；技术详情三图的归属见附录 E.5）。
//
// V09-08 ⑤（报告 02 G-07）的状态口径**分两支**（附录 E.6 第 2 条；PLAN V09-08 禁止越界）：
//   · **未迁移项目（v1）**：返回体**逐字不变**——就是 `renderGraph` 那份共用渲染数据
//     （含 `progress.json` 自报四色），一个字段都不加。迁移判定＝`isMigratedProject`（唯一判据）。
//   · **已迁移项目（v2）**：模块状态取 **v2 证据派生**（`taskDerivedModuleStatus`，附录 D）——
//     节点/边形状保持兼容（另外**只增** `status_source`/`status_display`/`status_basis`），
//     映射不到就写「无状态记录」；**没有已发布蓝图也仍是「无状态记录」，绝不回落 v1 四色**
//     （回落＝拿自报进度冒充现行状态）。
// 工具描述与返回体一致：本工具给的是**技术详情层**，规划层（能力/声明模块/任务）与逐对象状态
// 请看 `project_entry` 或状态投影。
// V09-11：v2 返回体另带 `data_flow`（数据流向图的**来源分层**：当前实现 vs 目标语义、实体/关系/
// 端到端数据链/覆盖对账）——口径与判据见 `src/ui/arch/projectGraph.ts`，派生见 `src/arch/dataflow.ts`。
// V09-13：v2 返回体另带 `provenance`（**每个节点/关系的来源与证据状态**：`source_kinds`
// （requirement/design/code）＋映射（需求 id／设计章节／代码模块）＋证据状态（verified／unverified／
// missing／invalidated／user_pending），以及**交付阻断读数**（存在未映射/未验证/缺证/证据失效 ⇒
// 「不可判定项目可交付」并逐条点名；全齐才给「可请求验收」，仍不等于用户接受）。判据的唯一实现是
// `src/ui/arch/provenance.ts`，派生见 `src/arch/blueprint.ts#archProvenanceModelOf`——读口不另算一套。
// 只读；未解析过项目返回空态说明（200 空态口径，不是错误）。
import { archProvenanceModelOf } from "../../arch/blueprint";
import { DISPLAY_STATUS_PALETTE, NO_STATUS_RECORD_KEY } from "../../ui/arch/statusColor";
import { MODULE_VERIFIED_SHORT } from "../../ui/arch/projectGraph";
import { dataFlowLayerOf, renderGraph, techModuleStatusOf } from "../../arch/render";
import { isMigratedProject } from "../../server/work/migrate";
import { errorResult, textResult, type McpTool } from "./types";

/** 上屏键 → 读口用的短标（与界面**同词**：模块绿点明"已存在"，其余走六态短标） */
function statusDisplayOf(key: string | undefined): string {
  if (key === undefined || key === NO_STATUS_RECORD_KEY) return "无状态记录";
  if (key === "unmapped") return "未映射";
  if (key === "verified") return MODULE_VERIFIED_SHORT;
  return DISPLAY_STATUS_PALETTE[key as keyof typeof DISPLAY_STATUS_PALETTE]?.short ?? key;
}

export const getArchTool: McpTool = {
  name: "get_arch",
  description:
    "读项目的**技术详情层**架构数据（模块方框图 / 数据流向图 / 思维导图三张图共用的同一份：" +
    "顶层代码模块 + 依赖边 + 聊天补全节点，节点带 origin:chat 的来自聊天补全层）。" +
    "状态口径**分两支**：**已迁移项目**的节点状态是 **v2 证据派生**（附录 D，与图面同一份口径）——" +
    "`status` 是派生上屏键、`status_display` 是短标（映射不到写「无状态记录」）、" +
    "`status_source` 恒为 `v2_evidence`，**不返回 v1 自报四色**（没有已发布蓝图时同样全部「无状态记录」，" +
    "不回退 v1）；**未迁移项目**（v1）原样返回共用渲染数据，不另加状态来源字段。" +
    "已迁移项目的返回体另带 `data_flow`（来源分层与口径，V09-11）：它**同时**给出" +
    "`current_implementation`（**当前实现＝三张技术图共用的静态 import 依赖层方向渲染，不是业务数据流**）" +
    "与 `target_semantics`（**目标＝业务/项目数据从输入源 → 处理 → 存储 → 输出/外部系统的实际路径**），" +
    "并给出实体（输入源/处理节点/存储/输出·外部系统）、关系（产生/传递/读写/转换）、" +
    "至少一条端到端数据链（逐跳带出处与验证态）与覆盖对账（缺路径显式报缺并阻断「项目可交付」）。" +
    "**静态 import 只作线索**（`static_clues`），不得据此生成「已验证」的数据边。" +
    "已迁移项目的返回体还带 `provenance`（V09-13）：每个节点与每条关系的**来源种类**" +
    "（requirement／design／code）＋**映射**（需求 id／设计章节／代码模块）＋**证据状态**" +
    "（verified／unverified／missing／invalidated／user_pending），以及**交付阻断读数**" +
    "（`delivery`：存在未映射/未验证/缺证/证据失效时给「不可判定项目可交付」并逐条点名；" +
    "全部满足才给「可请求验收」——**仍不等于用户接受**，人工待验由用户本人记录）。" +
    "规划层（能力/声明模块/任务）与逐对象状态见 `project_entry` 或状态投影。" +
    "还没静态解析过时返回空态说明。",
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
      return errorResult("get_arch 缺入参 project_id");
    }
    const r = renderGraph(projectId);
    if (!r.exists || !r.graph) {
      return textResult(
        "项目还没静态解析过（可在「架构图」页签点解析生成；聊天补全层可先写、解析后一并显示）",
      );
    }
    const tech = isMigratedProject(projectId) ? techModuleStatusOf(projectId) : null;
    // 分支一：未迁移项目（v1）——返回体**逐字不变**，不另加任何字段
    if (tech === null) {
      return textResult(JSON.stringify(r.graph, null, 2));
    }
    // 分支二：已迁移项目（v2）——模块状态取 v2 证据派生（形状兼容，只增状态来源字段）
    const graph = {
      ...r.graph,
      // 读口口径（照实写在返回体里，免得调用方猜）：
      layer: "tech_detail" as const,
      module_status_source: "v2_evidence" as const,
      module_status_basis:
        "模块状态＝v2 证据派生（DESIGN.md 附录 D / 附录 E.6 第 2 条）：由映射到该模块的任务" +
        "display_status 汇总；映射不到就写「无状态记录」——本字段**不来自** progress.json 的自报四色。",
      status_baseline_id: tech.baseline_id,
      // V09-13：每个节点/关系的**来源与证据状态** ＋ 交付阻断读数（判据唯一实现见
      // `src/ui/arch/provenance.ts`；本字段是**同一份派生**，读口不另算一套）。
      provenance: archProvenanceModelOf(projectId),
      // V09-11：数据流向图的**来源分层**（§3.2／§11.2）——`current_implementation` 与
      // `target_semantics` 两句**同时在场且互相区分**，实体/关系/链/覆盖对账各带出处与验证态
      // （口径与判据 R1–R6 的唯一出处：src/ui/arch/projectGraph.ts；派生：src/arch/dataflow.ts）。
      data_flow: dataFlowLayerOf(projectId),
      nodes: r.graph.nodes.map((n) => {
        const key = tech.keys[n.id];
        // 形状兼容：`status` 仍在（语义改为 v2 派生上屏键，取不到为 null），另加来源与短标
        return {
          ...n,
          status: key ?? null,
          status_source: "v2_evidence" as const,
          status_display: statusDisplayOf(key),
          status_basis: tech.basis[n.id] ?? tech.basis[`plan:code:${n.id}`] ?? null,
        };
      }),
    };
    return textResult(JSON.stringify(graph, null, 2));
  },
};
