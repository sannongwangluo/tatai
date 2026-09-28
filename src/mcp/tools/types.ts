// MCP 工具统一约定（PLAN.md M1/M2，DESIGN.md §6）。
// 每个工具一个文件，导出符合本接口的对象，由 ./index.ts 收进统一注册表。
// handler 只负责"调数据层 → 拼 MCP 返回"，不做任何拉起 agent / 选模型的事（§6.1 方向红线）。

import type { WorkServiceClient } from "../../server/work/service";

/** MCP 工具返回的 content 块（M1 只用 text；后续可加 structuredContent） */
export interface ToolTextContent {
  type: "text";
  text: string;
}

export interface ToolResult {
  content: ToolTextContent[];
  isError?: boolean;
  /** 兼容 SDK ServerResult 的开放字段要求 */
  [key: string]: unknown;
}

/** 调用上下文：server 分发时注入的 MCP 客户端信息（report_task_status 的 reporter 缺省口径用） */
export interface McpContext {
  /** MCP 客户端自报名（initialize 握手里的 clientInfo.name）；拿不到时为 undefined */
  clientName?: string;
  /**
   * v2 事实的**转接**客户端（PLAN.md V06-01，DESIGN.md §2.6）。
   *
   * MCP 进程不自己追加事件——要用就 `ctx.work.submit(...)`，由桌面服务进程里的唯一写入服务
   * 仲裁；服务不可用时拿到 `SERVICE_UNAVAILABLE`，**不**退化成"自己写 events.jsonl"。
   * 当前 v1 工具尚未切到 v2（迁移工具在 V06-03，真实项目切换要等 V06-10 的认领/兼容写入口），
   * 这里先把接入边界留出来，供后续卡使用。
   */
  work?: WorkServiceClient;
}

/** MCP 工具统一形状：M2 的 8 个工具（§6.3）一律按此框架填 */
export interface McpTool {
  /** 工具名，与 §6.3 表一致（如 list_projects） */
  name: string;
  /** 给 agent 看的一句话说明 */
  description: string;
  /** JSON Schema 对象（SDK listTools 原样透传给客户端） */
  inputSchema: Record<string, unknown>;
  /** 业务实现：入参已按 inputSchema 由 agent 侧构造，这里只管执行 */
  handler: (args: Record<string, unknown>, ctx?: McpContext) => Promise<ToolResult> | ToolResult;
}

/** 拼一个 text 结果的便利函数 */
export function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

/** 拼一个错误结果（isError 让客户端按失败处理） */
export function errorResult(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}
