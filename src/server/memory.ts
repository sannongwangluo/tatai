import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// 记忆检索 MCP 客户端（B2，逆向落稿第二卡，DESIGN.md §9.2/§9.3 + §6.4 query_memory 对应能力）：
// 塔台后端作为 MCP client，stdio 拉起用户的记忆 server（Python，mcp.json 里的 brain-memory 条目），
// 调它的 search 工具检索某项目的历史记忆——代码是结果、记忆是原因，逆向落稿两者都要。
// 口径：
//   · 连接参数默认读本机 kimi-code MCP 配置（~/.kimi-code/mcp.json 的 brain-memory 条目）；
//     读不到就按「未配置」降级，不内置任何兜底路径（AGENTS.md §6 开源红线）；
//   · 降级红线：未配置/连不上/超时/工具缺失/调用出错 → 返回 {available:false, reason}，
//     绝不抛给上层——检索不可用不阻塞起草（退化为"仅代码扫描"）；
//   · 隐私红线：检索结果只在内存里传给上层，不落盘、不写仓库（写 .工作台/ 是 B3 的事）；
//   · 每次调用一个短命连接，用完即关，杀掉 python 子进程，不留悬挂。

const DEFAULT_TIMEOUT_MS = 15_000; // 连接+检索整体超时，超时按不可用降级
const DEFAULT_LIMIT = 8; // top N 命中上限
const MAX_SUMMARY_CHARS = 200; // 摘要限长（流水/上层只消费主题词级摘要，不搬全文）

/** 记忆 server 启动参数（与 mcp.json 条目同构） */
export interface BrainMcpConfig {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
}

/** 单条命中（两阶段注入第一阶段：只有摘要，无全文） */
export interface MemoryHit {
  id: number | null;
  summary: string;
  score: number | null;
  created: string | null;
}

/** 检索结果：可用（含零命中）或降级（带原因） */
export type MemoryQueryResult =
  | {
      available: true;
      query: string;
      tool: string;
      results: MemoryHit[];
      duration_ms: number;
    }
  | { available: false; query: string; reason: string };

export interface QueryMemoryOpts {
  /** 覆盖启动参数（验证降级路径/测试用；缺省走 resolveBrainMcpConfig） */
  config?: BrainMcpConfig;
  /** 整体超时（连接+listTools+callTool），默认 15s */
  timeoutMs?: number;
  /** top N，默认 8 */
  limit?: number;
}

// 红线（AGENTS.md §6 开源红线）：不内置任何作者真实路径的兜底配置——
// 本机连接参数一律来自 ~/.kimi-code/mcp.json（或 TATAI_BRAIN_MCP_CONFIG 指定的文件），
// 读不到就按「未配置」降级为仅代码扫描（PLAN.md B2 DoD②）。

/** mcp.json 里 brain-memory 条目的预期形状（宽容解析，缺字段给默认） */
function parseMcpJsonEntry(raw: unknown): BrainMcpConfig | null {
  if (typeof raw !== "object" || raw === null) return null;
  const entry = raw as Record<string, unknown>;
  if (typeof entry.command !== "string" || entry.command === "") return null;
  const env: Record<string, string> = {};
  if (typeof entry.env === "object" && entry.env !== null) {
    for (const [k, v] of Object.entries(entry.env as Record<string, unknown>)) {
      if (typeof v === "string") env[k] = v;
    }
  }
  return {
    command: entry.command,
    args: Array.isArray(entry.args) ? entry.args.map(String) : [],
    ...(typeof entry.cwd === "string" ? { cwd: entry.cwd } : {}),
    ...(Object.keys(env).length > 0 ? { env } : {}),
  };
}

/**
 * 解析记忆 server 启动参数。
 * 口径：优先读本机 kimi-code MCP 配置（~/.kimi-code/mcp.json → mcpServers.brain-memory，
 * 顶层也容忍直接挂 brain-memory）；读不到/解析失败/条目缺失 → null
 * （上层按"未配置"降级）。可用 TATAI_BRAIN_MCP_CONFIG 指向别的 mcp.json。
 */
export function resolveBrainMcpConfig(configPath?: string): BrainMcpConfig | null {
  const p =
    configPath ??
    process.env.TATAI_BRAIN_MCP_CONFIG ??
    path.join(os.homedir(), ".kimi-code", "mcp.json");
  try {
    if (!fs.existsSync(p)) return null;
    const json = JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
    const servers = (json.mcpServers ?? json) as Record<string, unknown>;
    return parseMcpJsonEntry(servers["brain-memory"]);
  } catch {
    return null;
  }
}

/** 从工具返回的 content 里取出 JSON payload（text 内容拼接后解析） */
function extractPayload(result: unknown): Record<string, unknown> | null {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content;
  if (!Array.isArray(content)) return null;
  const text = content
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text!)
    .join("\n");
  if (text === "") return null;
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

/** 规整命中条目：只留 id/摘要/分数/时间，摘要限长（不搬全文） */
function toHit(raw: unknown): MemoryHit | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const summary =
    typeof r.summary === "string" && r.summary.trim() !== ""
      ? r.summary.trim()
      : typeof r.content === "string"
        ? r.content.trim()
        : "";
  if (summary === "") return null;
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
  return {
    id: num(r.id),
    summary: summary.slice(0, MAX_SUMMARY_CHARS),
    score: num(r.score ?? r.meta_score),
    created: str(r.created) ?? str(r.created_at),
  };
}

/**
 * 检索项目历史记忆。任何失败都降级为 {available:false, reason}，不抛。
 * 成功（含零命中）返回 {available:true, results}（results 可能为空数组）。
 */
export async function queryMemory(
  query: string,
  opts: QueryMemoryOpts = {},
): Promise<MemoryQueryResult> {
  const q = query.trim();
  if (q === "") {
    return { available: false, query, reason: "检索关键词为空" };
  }
  const config = opts.config ?? resolveBrainMcpConfig();
  if (!config) {
    return { available: false, query: q, reason: "未配置记忆检索 MCP（mcp.json 无 brain-memory 条目）" };
  }
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const limit = opts.limit ?? DEFAULT_LIMIT;

  const t0 = Date.now();
  let transport: StdioClientTransport | undefined;
  let client: Client | undefined;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    // 超时强杀：关 transport（连带杀子进程），外层 await 会随连接断开而 reject
    void transport?.close().catch(() => {});
  }, timeoutMs);

  try {
    transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      ...(config.cwd ? { cwd: config.cwd } : {}),
      env: { ...process.env, ...(config.env ?? {}) } as Record<string, string>,
      stderr: "ignore",
    });
    client = new Client({ name: "tatai-memory-client", version: "0.0.1" });
    await client.connect(transport);

    const tools = await client.listTools();
    // 检索类工具按优先级挑：search（混合检索+精排）→ recall（联想检索兜底）
    const names = tools.tools.map((t) => t.name);
    const toolName = names.includes("search")
      ? "search"
      : names.includes("recall")
        ? "recall"
        : null;
    if (!toolName) {
      return {
        available: false,
        query: q,
        reason: `记忆检索 server 无检索类工具（实际工具: ${names.join(", ") || "(空)"}）`,
      };
    }

    const result = await client.callTool({
      name: toolName,
      arguments: { query: q, limit },
    });
    if (result.isError === true) {
      const content = (result.content as Array<{ type: string; text?: string }>)
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join(" ");
      return { available: false, query: q, reason: `检索工具返回错误: ${content.slice(0, 200)}` };
    }
    const payload = extractPayload(result);
    if (!payload || !Array.isArray(payload.results)) {
      return { available: false, query: q, reason: "检索返回结构无法解析（无 results 数组）" };
    }
    const results = payload.results
      .map(toHit)
      .filter((h): h is MemoryHit => h !== null)
      .slice(0, limit);
    return { available: true, query: q, tool: toolName, results, duration_ms: Date.now() - t0 };
  } catch (e) {
    const msg = (e as Error).message.split("\n")[0];
    return {
      available: false,
      query: q,
      reason: timedOut ? `检索超时（>${timeoutMs}ms）` : `连接/检索失败: ${msg}`,
    };
  } finally {
    clearTimeout(timer);
    try {
      await client?.close();
    } catch {
      // 关闭失败不遮蔽主结果
    }
    try {
      await transport?.close();
    } catch {
      // 同上
    }
    // 双保险：子进程仍活着就强杀（python 子进程绝不残留）
    const pid = transport?.pid;
    if (pid != null) {
      try {
        process.kill(pid, 0);
        process.kill(pid);
      } catch {
        // 已退出
      }
    }
  }
}
