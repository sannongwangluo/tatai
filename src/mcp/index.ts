// 塔台 MCP server 入口（pnpm mcp = tsx src/mcp/index.ts）。
// 传输：stdio（agent 的 MCP 客户端经标准输入输出接入，是 MCP 的标准接入方式）。
// 进程模型：连接挂上后主线程只剩事件循环，无工具调用时挂住不退出、不 CPU 空转。
// 红线重申（DESIGN.md §6.1）：本进程只响应 agent → 工作台方向的调用，不拉起任何 agent。
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createTataiMcpServer } from "./server";
import { installWorkspaceReadWiring } from "../server/work/hostWiring";

async function main(): Promise<void> {
  // 进程组合根接线（DESIGN §6.13 第 4 段／§6.14 第 2/6 段）：stdio MCP 是**独立只读进程**，
  // 不建写入服务（`createWorkHost`），但 `read_design`/`read_plan`/`project_entry`/功能清单等**在本进程内直读**
  // 图纸与当前开发根。若不在这里装只读解析器，就只会在"启动了 writer"的进程里读对——
  // MCP 自己的只读读口会退回锚点旧口径（读到错版本/坏指针静默回落）。安装本身**无 IO**、只注入解析器。
  installWorkspaceReadWiring();
  const server = createTataiMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // 不打 stdout（stdout 是协议通道）；就绪信号走 stderr 方便人观察
  console.error("[tatai-mcp] stdio server ready（agent → 工作台，等待调用）");
}

main().catch((err) => {
  console.error(`[tatai-mcp] 启动失败: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
