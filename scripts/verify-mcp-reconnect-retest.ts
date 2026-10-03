// 项2 复测：用当前构建产物 mcp.js 起 stdio MCP，调 project_entry / list_tasks，
// 证明新代码能回放账本越过 seq 675 的 task.reopened 到最新。
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MCP = path.join(ROOT, "src-tauri", "target", "release", "server", "mcp.js");

interface RpcMsg {
  id?: number;
  result?: { content?: { text?: string }[]; isError?: boolean };
  error?: unknown;
}

const child = spawn(process.execPath, [MCP], { stdio: ["pipe", "pipe", "pipe"] });
let buf = "";
const pending = new Map<number, (msg: RpcMsg) => void>();
let idc = 0;
const send = (method: string, params: unknown): Promise<RpcMsg> =>
  new Promise((resolve) => {
    const id = ++idc;
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
child.stdout.on("data", (d: Buffer) => {
  buf += d.toString("utf8");
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg: RpcMsg;
    try {
      msg = JSON.parse(line) as RpcMsg;
    } catch {
      continue;
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)!(msg);
      pending.delete(msg.id);
    }
  }
});
child.stderr.on("data", () => {});

const callTool = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
  const r = await send("tools/call", { name, arguments: args });
  if (r.error) throw new Error(`${name} RPC 错误：${JSON.stringify(r.error)}`);
  const text = r.result?.content?.[0]?.text ?? "";
  if (r.result?.isError) throw new Error(`${name} isError：${text.slice(0, 300)}`);
  return JSON.parse(text) as Record<string, unknown>;
};

await send("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "review-fix-retest", version: "1.0" },
});
await send("notifications/initialized", {}).catch(() => {});

const entry = (await callTool("project_entry", {
  project_id: "tatai",
  role: "auditor",
  client_capabilities: "read_only",
})) as { context_manifest?: { sources?: { path: string; content_sha256?: string }[] }; next_action?: string };
const seq = entry.context_manifest?.sources?.find((s) => s.path.endsWith("events.jsonl"))?.content_sha256;
console.log(`[retest] project_entry OK：账本投影 ${seq}，next_action=${entry.next_action}`);

const tasks = (await callTool("list_tasks", { project_id: "tatai" })) as {
  tasks?: { ledger_source?: string }[];
  projection?: { last_seq?: number };
};
const rows = tasks.tasks?.length ?? 0;
const lastSeq = tasks.projection?.last_seq;
console.log(`[retest] list_tasks OK：${rows} 行，last_seq=${lastSeq}，ledger_source=${tasks.tasks?.[0]?.ledger_source}`);

// 回放成功且越过 seq 675（task.reopened）即通过；1104 是本轮复核时的下限，账本会继续增长。
// 账本内容身份自 2026-10-03（V09-39/统一优化）起是**真实账本内容 sha256**（64 位小写十六进制），
// 不再是旧 `last_seq:` 前缀串——这里按真实语义断言。
if (typeof lastSeq !== "number" || lastSeq < 1104 || !/^[0-9a-f]{64}$/.test(String(seq))) {
  console.error(`[retest] FAIL：回放不完整或账本内容身份不是 64 位 sha（${seq} / last_seq=${lastSeq}）`);
  process.exit(1);
}
console.log(`[retest] PASS：构建产物 mcp.js 回放账本到内容 sha ${String(seq).slice(0, 16)}…（越过 seq 675 task.reopened）`);
child.kill();
process.exit(0);
