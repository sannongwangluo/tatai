// get_project_graphs：**六图完整当前状态**的 MCP 读口（DESIGN.md §6.4、§6.7；附录 E.18 四；PLAN V09-19）。
//
// 它回答的不是「有哪些节点」，而是「**这六张图现在各是什么、算到哪一版、哪里没验证、下一步读什么**」——
// Agent 只给项目入口就能据此说出六图内容、按节点/关系追到证据，**不必先读仓库代码**。
//
// 六图（用户口径）＝功能全景／系统架构／施工依赖（三张主视图）＋模块方框图／数据流向图／思维导图（三张技术详情图）。
// 四档读取：① 全部六图（缺省）；② `graph=<六图之一>`；③ `node_id=<稳定 ID>`；④ `relation_id=<稳定关系 ID>`。
//
// 红线（与界面/HTTP **同源同判据**，不另造一套）：
//   · 图面与状态复用既有唯一实现（`blueprint.json` / `buildViewModel` / `render.ts` / `dataFlowLayerOf` /
//     `provenance.ts` / `statusColor.ts`）——本工具**不**自己算颜色或绿灯；
//   · 不许静默截断后仍称「全图」（超限给 total/returned/同一快照 cursor ＋ `incomplete:true`）；
//   · 更新中/失败/过期如实返回状态与原因，预计用时只用有依据的实测值（不编造 ETA）；
//   · 模型提案待审线索**单列**，不混进正式节点/关系、不计入任何验证读数；
//   · 数据流向图分「当前静态 import 方向图」与「目标业务数据流」及其已验证链与缺口；
//   · 交付读数、工作流 `next_action`、用户 Gate **分开表达**，任一项都不等于「已交付」。
// 只读：不写盘、不调模型、不给纳管项目加运行时埋点。现有 `get_arch` 的技术详情层含义与兼容返回**保持有效**。
import { SIX_GRAPH_KEYS, SIX_GRAPH_META, sixGraphsOf, type SixGraphKey } from "../../arch/sixGraphs";
import { errorResult, textResult, type McpTool } from "./types";

const GRAPH_ALIASES: Record<string, SixGraphKey> = {
  all: "functional", // 占位：下面按 "all" 单独处理
  functional: "functional",
  architecture: "architecture",
  construction: "construction",
  module_map: "module_map",
  data_flow: "data_flow",
  mind_map: "mind_map",
};

export const getProjectGraphsTool: McpTool = {
  name: "get_project_graphs",
  description:
    "读项目的**六图完整当前状态**（只读、不调模型）：功能全景／系统架构／施工依赖＋模块方框图／数据流向图／思维导图。" +
    "四档读取：① 缺省一次取**全部六图**；② `graph=<六图之一>`；③ `node_id=<稳定 ID>`；④ `relation_id=<稳定关系 ID>`。" +
    "每张图给实际节点、关系、分组与同组关系；逐对象带稳定 ID、名称、状态键、界面短标与颜色口径、来源（需求/设计/代码）、" +
    "映射（需求 id/设计章节/代码模块）、证据状态（verified/unverified/missing/invalidated/user_pending）、有效版本、阻断原因与用户待验标记。" +
    "同一份图共用**一个快照标识**（基线＋生成时刻＋来源修订）。**完整性**：当前规模下一次请求返回完整数据；超过安全上限时给 " +
    "`total`/`returned`/同一快照 `cursor` 与 `incomplete:true` 并允许续取——**不静默截断还称「全图」**。" +
    "**数据流向图分两层**：`current_implementation`（当前实现＝三张技术图共用的静态 import 依赖层方向渲染，**不是**业务数据流）与 " +
    "`target_semantics`（目标＝输入源→处理→存储→输出/外部系统的实际路径，逐跳带出处与验证态，含已验证链与缺口）——" +
    "静态依赖**不得**被称为已验证业务数据流。图更新中/失败/过期时返回真实状态与原因（预计用时只用有依据的实测值，依据不足写「无法估计」）。" +
    "模型提案**待审线索**（`model_leads`/`model_node_leads`）单列、标「未审定」，不混进正式节点/关系、不计入任何读数。" +
    "交付读数（`delivery.verdict`：可请求验收／不可判定项目可交付，**仍不等于用户接受**）、工作流 `next_action`、用户 Gate " +
    "在 `separate_readouts` 里**分开表达**，任一项都不等于「已交付」。状态与颜色与界面/HTTP **同一份判据**" +
    "（buildViewModel／dataFlowLayerOf／provenance／statusColor），本工具不另算一套。没有可读的图时如实给空态与原因（不是错误）。" +
    "`get_arch` 仍是技术详情三图共用的代码关系层读口，本工具不取代它。",
  inputSchema: {
    type: "object",
    properties: {
      project_id: { type: "string", description: "注册表里的项目 id" },
      graph: {
        type: "string",
        enum: ["all", ...SIX_GRAPH_KEYS],
        description:
          "取哪张图：all（缺省＝全部六图）／functional（功能全景）／architecture（系统架构）／construction（施工依赖）／" +
          "module_map（模块方框图）／data_flow（数据流向图）／mind_map（思维导图）",
      },
      node_id: {
        type: "string",
        description:
          "指定节点（稳定 ID：规划节点 plan:… 或技术模块 id）：返回它出现在**本次取回的那几张图**里的分组、同组关系、相邻关系与逐对象状态（不传 graph 时默认在全部六图里找；与 graph 同传则只在那张图里找）",
      },
      relation_id: {
        type: "string",
        description:
          "指定关系（稳定关系 ID：<from>|<to>|<kind> 或 <from>><to>:<kind>）；取回范围同 node_id",
      },
      cursor: {
        type: "string",
        description:
          "续取游标（上一轮 completeness.cursor 或 completeness.cursors[<graphKey>]，格式 <snapshot_id>:<graphKey>:<下一位置>）：**同一快照内有效**，快照对不上明确拒绝（不跨快照拼数据）；续取时请同时传 graph（两者指向不同图会被拒）。取完（complete:true）时为 null、终页不再给游标。",
      },
      limit: {
        type: "number",
        description:
          "本次最多返回的对象条数（缺省 4000＝当前规模下足够一次取完；按**整份响应**计，六图共用这一份预算）。超限时给 total/returned/逐图 cursors 与 incomplete:true（不静默截断），按 `cursors[<graphKey>]`＋`graph=<graphKey>` 逐图续取直到 complete:true——所有页合并后与不限量返回逐对象一致。",
      },
    },
    required: ["project_id"],
    additionalProperties: false,
  },
  handler: (args) => {
    const projectId = typeof args.project_id === "string" ? args.project_id.trim() : "";
    if (projectId === "") return errorResult("get_project_graphs 缺入参 project_id");
    const rawGraph = typeof args.graph === "string" ? args.graph.trim() : "all";
    const graphKey = rawGraph === "all" ? undefined : GRAPH_ALIASES[rawGraph];
    if (rawGraph !== "all" && graphKey === undefined) {
      return errorResult(
        `get_project_graphs 的 graph 只认 ${["all", ...SIX_GRAPH_KEYS].join("/")}（给的是 ${rawGraph}）——` +
          "六图的键与标题见工具描述",
      );
    }
    const limit = typeof args.limit === "number" && Number.isFinite(args.limit) ? Math.max(1, Math.floor(args.limit)) : undefined;
    try {
      const snapshot = sixGraphsOf(projectId, {
        ...(graphKey === undefined ? {} : { graph: graphKey }),
        ...(typeof args.node_id === "string" && args.node_id.trim() !== "" ? { node_id: args.node_id.trim() } : {}),
        ...(typeof args.relation_id === "string" && args.relation_id.trim() !== "" ? { relation_id: args.relation_id.trim() } : {}),
        ...(typeof args.cursor === "string" && args.cursor.trim() !== "" ? { cursor: args.cursor.trim() } : {}),
        ...(limit === undefined ? {} : { limit }),
      });
      // 六图清单放在返回体开头（机器可读），免得调用方从工具描述猜键名
      return textResult(
        JSON.stringify(
          {
            graphs_available: SIX_GRAPH_KEYS.map((k) => ({ key: k, title: SIX_GRAPH_META[k].title, layer: SIX_GRAPH_META[k].layer })),
            ...snapshot,
          },
          null,
          2,
        ),
      );
    } catch (e) {
      return errorResult(`get_project_graphs 失败：${e instanceof Error ? e.message : String(e)}`);
    }
  },
};
