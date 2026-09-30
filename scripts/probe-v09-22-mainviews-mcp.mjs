#!/usr/bin/env node
// V09-22 定向收尾 · 两张主视图的数据期望值探针（安装版 MCP 六图入口）。
//
// 用途：对**安装版** mcp.js（协调器已同步到新构建的那份）按 stdio JSON-RPC 调
// get_project_graphs（overview，functional / construction 两张），把 counts/节点数写进 JSON——
// 供 CDP UI 探针（probe-v09-22-mainviews-installed.py）与画布 DOM 对照。
// 数据期望值**只从 MCP 六图入口取**：上一轮真实数据探针调了不存在的
// /api/projects/:id/graphs HTTP 路由（404 中止），本驱动不重蹈（Codex 复核 2026-09-29 §2）。
//
// 用法：node scripts/probe-v09-22-mainviews-mcp.mjs <安装版mcp.js绝对路径> <隔离TATAI_HOME> <项目id> <输出json>
// 隔离口径：子进程 env 清掉全部既有 TATAI_*，只设 TATAI_HOME=调用方给的隔离目录；本驱动不写任何盘
// （唯一写口＝命令行指定的输出 json）。
import { spawn } from "node:child_process";
import fs from "node:fs";

const [mcpPath, home, projectId, outFile] = process.argv.slice(2);
if (!mcpPath || !home || !projectId || !outFile) {
  console.error("用法: node probe-v09-22-mainviews-mcp.mjs <mcp.js绝对路径> <隔离TATAI_HOME> <项目id> <输出json>");
  process.exit(2);
}

const env = { ...process.env };
for (const k of Object.keys(env)) if (k.startsWith("TATAI_")) delete env[k];
env.TATAI_HOME = home;

const child = spawn(process.execPath, [mcpPath], { env });
let stderrBuf = "";
child.stderr.on("data", (d) => {
  stderrBuf += d.toString("utf8");
});

const TIMEOUT_MS = 60_000;
let buf = "";
const pending = new Map();
let idc = 0;
const send = (method, params) =>
  new Promise((resolve, reject) => {
    const id = ++idc;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`请求超时 ${TIMEOUT_MS}ms：${method}`));
    }, TIMEOUT_MS);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
const notify = (method, params) => {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
};
child.stdout.on("data", (d) => {
  buf += d.toString("utf8");
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

const die = (msg) => {
  console.error("[mcp-probe] FAIL " + msg);
  if (stderrBuf.trim()) console.error("[mcp-probe] stderr 尾部：" + stderrBuf.slice(-800));
  try {
    child.kill();
  } catch {}
  process.exit(1);
};

// ── 握手 → 两张主视图各取一次 overview ──
const init = await send("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "probe-v09-22-mainviews", version: "0.1.0" },
});
if (init.error) die("initialize 失败：" + JSON.stringify(init.error).slice(0, 200));
notify("notifications/initialized", {});

const out = {
  mcp_path: mcpPath,
  tatai_home: home,
  project_id: projectId,
  server_info: init.result?.serverInfo ?? null,
  graphs: {},
};
for (const graph of ["functional", "construction"]) {
  const res = await send("tools/call", {
    name: "get_project_graphs",
    arguments: { project_id: projectId, graph, mode: "overview" },
  });
  if (res.error) die(`get_project_graphs(${graph}) 出错：` + JSON.stringify(res.error).slice(0, 200));
  const text = res.result?.content?.[0]?.text;
  if (typeof text !== "string") die(`get_project_graphs(${graph}) 无文本内容`);
  let snap;
  try {
    snap = JSON.parse(text);
  } catch (e) {
    die(`get_project_graphs(${graph}) 文本不是 JSON：${e.message}`);
  }
  const g = snap.graphs?.[graph];
  if (!g) die(`响应缺 graphs.${graph}（keys=${Object.keys(snap.graphs ?? {}).join(",")}）`);
  out.graphs[graph] = {
    snapshot_id: snap.snapshot_id,
    availability: snap.graph_state?.availability ?? null,
    counts: g.counts,
    node_ids: (g.nodes ?? []).map((n) => n.id),
    anomalies: snap.anomalies ?? [],
  };
}
child.stdin.end();
try {
  await new Promise((r) => child.on("exit", r));
} catch {}
fs.writeFileSync(outFile, JSON.stringify(out, null, 2), "utf8");
console.log(
  `[mcp-probe] OK functional.nodes=${out.graphs.functional.counts.nodes} construction.nodes=${out.graphs.construction.counts.nodes} → ${outFile}`,
);
