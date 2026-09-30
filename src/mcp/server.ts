// 塔台 MCP server 骨架（PLAN.md M1，DESIGN.md §6）。
//
// ═══ 方向红线（DESIGN.md §6.1，违反直接打回）═══
//   · 只有一个 MCP server：全仓库唯一的 MCP 入口就是 src/mcp/index.ts。
//   · 方向是 agent → 工作台：agent 经自己的 MCP 客户端以 stdio 主动调进来；
//     本 server 只响应调用，本文件及本目录**不含任何拉起 agent / 切换模型档位的代码**。
//
// ═══ 与 8787 HTTP 服务的关系 ═══
//   MCP server 是独立进程入口（pnpm mcp），不走 8787 HTTP 转发；
//   它直接 import 同一份数据层模块（src/server/registry.ts / workstation.ts / chat.ts / watcher.ts），
//   读写同一份 registry.json 与各项目 .工作台/ 文件——单一事实源，不另起存储。
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { findTool, TOOLS } from "./tools";
import { errorResult } from "./tools/types";
import { registerAgentActivity } from "../server/agents";
import { resolveDataDir } from "../server/registry";
import { WorkServiceClient } from "../server/work/service";
import { APP_VERSION } from "../shared/version";

/** 构造塔台 MCP server：注册工具清单与调用分发。传输层由入口（index.ts）接。 */
export function createTataiMcpServer(): Server {
  const server = new Server(
    // version 与 package.json 同源（src/shared/version.ts，构建期内联）——别再写死字面量
    { name: "tatai", version: APP_VERSION },
    { capabilities: { tools: {} } },
  );
  // Q63：登记失败不再整段静默——每个进程只嚷一次（工具调用本身照旧不受影响）
  let warnedRegistrationFailure = false;

  // 列出全部已注册工具（元数据原样透传）
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  // 分发调用：按名字找工具 → 跑 handler；未知名/抛错一律回 isError，不让进程挂掉
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = findTool(request.params.name);
    if (!tool) {
      return errorResult(`未知工具: ${request.params.name}`);
    }
    try {
      // reporter 缺省口径：MCP 客户端 initialize 握手自报的 clientInfo.name（getClientVersion 拿不到时为 undefined）
      const clientName = server.getClientVersion()?.name;
      // M4 agent 登记：任一工具被调即记（含未知工具路径之外的全部成功分发）；
      // 登记失败不让登记表影响工具调用本身，但也**不整段吞掉**（Q63，2026-09-18 审计）——
      // 否则 agents.json 出问题时左栏"最近活跃"永远不动、MCP 侧毫无感知；每个进程只嚷一次。
      try {
        registerAgentActivity(clientName ?? "unknown");
      } catch (e) {
        if (!warnedRegistrationFailure) {
          warnedRegistrationFailure = true;
          console.warn(
            `[agents] 登记本次 agent 活动失败（不影响工具调用）：${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
      // V06-01（DESIGN.md §2.6）：注入 v2 事实的**转接**客户端——MCP 进程不自己追加事件，
      // 写入一律经桌面服务里的唯一写入服务；服务不在时工具会拿到 SERVICE_UNAVAILABLE。
      const ctx = { clientName, work: new WorkServiceClient({ dataDir: resolveDataDir() }) };
      return await tool.handler((request.params.arguments ?? {}) as Record<string, unknown>, ctx);
    } catch (err) {
      return errorResult(`工具 ${tool.name} 执行失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  return server;
}
