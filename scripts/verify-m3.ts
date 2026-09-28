// M3 验证脚本（用 tsx 跑）：AGENTS.md 约定段接入（幂等）+ 任务→模块四色汇总 + activity 反查兜底（PLAN.md M3 卡）。
// 用法：pnpm verify:m3（自带临时 TATAI_HOME 与临时项目目录，不碰真实注册表与真实项目）
// 覆盖点（对应 M3 DoD 逐条）：
//   ① 模板文本与 DESIGN.md §6.2 引用句一致（"本目录接了塔台（Tatai）工作台 MCP，干活时汇报状态。"）
//   ② attach 两次 → AGENTS.md 只有一段标记段（幂等）；已有内容前缀逐字节不动；
//      无 AGENTS.md 的项目 → 创建最小骨架 + 插入
//   ③ 三条任务状态变化驱动模块四色：全 todo→todo / 有 doing→doing / 全 done→done / 有 blocked→issue；
//      空模块（无任务）保持原状态不动；HTTP POST tasks/:tid/status 也触发汇总
//   ④ GET /api/projects/:id/activity 返回 last_change_at（changes.jsonl 末行 ts）+
//      last_task_report_at（tasks.json 最大 updated_at）两字段对照（只读）
//   ⑤ MCP 链路闭环：SDK client 调 report_task_status 触发汇总（progress.json 模块四色真实变化）
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { addProject } from "../src/server/registry";
import { attachAgentsMd, SNIPPET_START_MARK } from "../src/server/attachAgentsMd";
import {
  addModule,
  addTask,
  readProgress,
  rollupModuleStatus,
  setModuleStatus,
  setTaskStatus,
} from "../src/server/workstation";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8798;
const BASE = `http://localhost:${PORT}`;

const ok = (cond: boolean, label: string) => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (!cond) process.exitCode = 1;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── 临时数据目录与两个临时项目（不碰真实注册表与真实项目）──
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-m3-verify-"));
const dataDir = path.join(tmpBase, "home");
const projDir = path.join(tmpBase, "m3-proj");
const proj2Dir = path.join(tmpBase, "m3-proj2");
fs.mkdirSync(path.join(projDir, ".工作台"), { recursive: true });
fs.mkdirSync(proj2Dir, { recursive: true });
addProject({ id: "m3-proj", name: "M3 验证项目", path: projDir, kind: "backend" }, dataDir);
addProject({ id: "m3-proj2", name: "M3 无AGENTS项目", path: proj2Dir, kind: "backend" }, dataDir);

// p1 已有 AGENTS.md（模拟真实项目），记录原文供前缀核对
const agentsFile = path.join(projDir, "AGENTS.md");
const agentsBefore = "# M3 验证项目 规矩\n\n> 原有内容，接入后必须逐字节保留。\n";
fs.writeFileSync(agentsFile, agentsBefore, "utf8");

const moduleStatus = (id: string) =>
  readProgress("m3-proj", dataDir).modules.find((m) => m.id === id)?.status;

function checkAttach(): void {
  console.log("\n[verify] ══ DoD①②：AGENTS.md 约定段接入 ══");
  // DoD①：模板文本含 §6.2 引用句原文
  const snippet = fs.readFileSync(
    path.join(REPO_ROOT, "templates", "agents-md-snippet.md"),
    "utf8",
  );
  ok(
    snippet.includes("本目录接了塔台（Tatai）工作台 MCP，干活时汇报状态。"),
    "DoD①：模板文本与 DESIGN.md §6.2 引用句一致",
  );
  ok(
    snippet.includes("report_task_status") &&
      snippet.includes(SNIPPET_START_MARK) &&
      snippet.includes("<!-- tatai-mcp:end -->"),
    "模板含汇报指引（report_task_status）与 start/end 标记",
  );

  // DoD②：attach 两次 → 只有一段标记段（幂等）；已有内容前缀不动
  const r1 = attachAgentsMd("m3-proj", dataDir);
  ok(r1.inserted === true && r1.created === false, "首次 attach：插入约定段（不建骨架）");
  const after1 = fs.readFileSync(agentsFile, "utf8");
  const r2 = attachAgentsMd("m3-proj", dataDir);
  const after2 = fs.readFileSync(agentsFile, "utf8");
  ok(r2.inserted === false && after2 === after1, "DoD②：重复 attach 幂等（第二次不插入，文件不变）");
  const markCount = after2.split(SNIPPET_START_MARK).length - 1;
  ok(markCount === 1, `DoD②：AGENTS.md 只有一段标记段（实际 ${markCount} 段）`);
  ok(after2.startsWith(agentsBefore), "attach 后原有内容前缀逐字节不动（防吞行）");
  console.log(`[verify] ── attach 后的 AGENTS.md:\n${after2}`);

  // DoD②b：无 AGENTS.md 的项目 → 创建最小骨架 + 插入
  const r3 = attachAgentsMd("m3-proj2", dataDir);
  const p2Text = fs.readFileSync(path.join(proj2Dir, "AGENTS.md"), "utf8");
  ok(
    r3.inserted === true &&
      r3.created === true &&
      p2Text.includes("# M3 无AGENTS项目 AGENTS.md") &&
      p2Text.includes(SNIPPET_START_MARK),
    "DoD②b：无 AGENTS.md 时创建最小骨架再插入约定段",
  );
}

function checkRollup(): void {
  console.log("\n[verify] ══ DoD③：任务 → 模块四色汇总 ══");
  addModule("m3-proj", { id: "m-1", name: "汇总模块" }, dataDir);
  addModule("m3-proj", { id: "m-empty", name: "空模块" }, dataDir);
  setModuleStatus("m3-proj", "m-empty", "done", dataDir);

  // 全 todo → todo
  addTask("m3-proj", { id: "t-1", title: "任务一", module_id: "m-1", reporter: "verify" }, dataDir);
  addTask("m3-proj", { id: "t-2", title: "任务二", module_id: "m-1", reporter: "verify" }, dataDir);
  addTask("m3-proj", { id: "t-3", title: "任务三", module_id: "m-1", reporter: "verify" }, dataDir);
  ok(moduleStatus("m-1") === "todo", "汇总：三条任务全 todo → 模块 todo");

  // 有任一 doing → doing
  setTaskStatus("m3-proj", "t-1", "doing", dataDir);
  ok(moduleStatus("m-1") === "doing", "汇总：有任一 doing → 模块 doing");

  // 全 done → done
  setTaskStatus("m3-proj", "t-1", "done", dataDir);
  setTaskStatus("m3-proj", "t-2", "done", dataDir);
  setTaskStatus("m3-proj", "t-3", "done", dataDir);
  ok(moduleStatus("m-1") === "done", "汇总：全 done → 模块 done");

  // 有任一 blocked → issue
  setTaskStatus("m3-proj", "t-2", "blocked", dataDir);
  ok(moduleStatus("m-1") === "issue", "汇总：有任一 blocked → 模块 issue");

  // 解除阻塞回到 doing
  setTaskStatus("m3-proj", "t-2", "doing", dataDir);
  ok(moduleStatus("m-1") === "doing", "汇总：blocked 解除（回到 doing）→ 模块 doing");

  // 空模块保持原状态不动
  rollupModuleStatus("m3-proj", "m-empty", dataDir);
  ok(moduleStatus("m-empty") === "done", "汇总：空模块（无任务）保持原状态不动（done）");

  // module_id 空串 / 未登记模块不拦任务写入
  addTask("m3-proj", { id: "t-9", title: "无模块任务", module_id: "", reporter: "verify" }, dataDir);
  ok(true, "汇总：module_id 空串的任务正常建档（跳过汇总不报错）");
}

// ── 端口冲突快速失败（2026-09-18 加）────────────────────────────────
// 端口被残留服务 / 并行会话占用时，子进程 EADDRINUSE 会静默死掉，而健康探测会打到占用者身上，
// 导致后续莫名 404 崩溃或对错误数据假通过。这里：起前探端口 → 起后盯早退。
const upPorts = new Set<number>();

function portListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: "127.0.0.1" });
    const done = (busy: boolean) => {
      sock.destroy();
      resolve(busy);
    };
    sock.once("connect", () => done(true)); // 有人监听 = 端口被占
    sock.once("error", () => done(false)); // 拒绝连接 = 端口空闲
    sock.setTimeout(1000, () => done(false));
  });
}

/** 起前预探测：端口已被占用立刻报错退出，不拿别人的服务跑验证 */
async function assertPortFree(port: number): Promise<void> {
  if (await portListening(port)) {
    console.error(`[verify] 后端起不来：端口 ${port} 被占用，先清理残留进程`);
    process.exit(1);
  }
}

/** 起后盯早退：子进程在就绪前退出（典型 EADDRINUSE）立即报错退出，不再继续验证 */
function watchChild(proc: ChildProcess, port: number, isUp: () => boolean): void {
  proc.once("exit", async (code) => {
    if (isUp()) return; // 脚本自己收尾杀的，不算异常
    const why = (await portListening(port))
      ? `端口 ${port} 被占用`
      : `后端进程提前退出（code=${code}）`;
    console.error(`[verify] 后端起不来：${why}，先清理残留进程`);
    process.exit(1);
  });
}

let serverProc: ChildProcess | null = null;

async function startServer(): Promise<void> {
  const tsxCli = path.join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  await assertPortFree(PORT); // 端口已被占：立刻失败，不拿占用者的服务跑验证
  serverProc = spawn(process.execPath, [tsxCli, path.join(REPO_ROOT, "src", "server", "index.ts")], {
    cwd: REPO_ROOT,
    env: { ...process.env, TATAI_HOME: dataDir, TATAI_PORT: String(PORT) },
    stdio: ["ignore", "inherit", "inherit"],
  });
  watchChild(serverProc, PORT, () => upPorts.has(PORT)); // 子进程早退（EADDRINUSE）立刻报错退出
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) {
        upPorts.add(PORT);
        return;
      }
    } catch {
      // 还没起来，继续等
    }
    await sleep(200);
  }
  throw new Error("HTTP 服务启动超时");
}

async function checkHttp(): Promise<void> {
  console.log("\n[verify] ══ DoD③b/④：HTTP 汇总挂钩 + activity 反查兜底 ══");
  // HTTP POST tasks/:tid/status 也触发汇总（t-3 当前 done → 改 blocked，模块应变 issue）
  const before = moduleStatus("m-1");
  const r = await fetch(`${BASE}/api/projects/m3-proj/tasks/t-3/status`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "blocked" }),
  });
  const body = (await r.json()) as { ok: boolean; task?: { status: string } };
  ok(
    r.ok && body.ok && moduleStatus("m-1") === "issue" && before === "doing",
    `HTTP POST tasks/:tid/status 触发汇总（模块 ${before} → ${moduleStatus("m-1")}）`,
  );
  await fetch(`${BASE}/api/projects/m3-proj/tasks/t-3/status`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "done" }),
  });
  ok(moduleStatus("m-1") === "doing", "HTTP 再报 done：模块回到 doing（t-2 仍 doing）");

  // DoD④：activity 两时间字段对照（手写一行 changes.jsonl 模拟 agent 改文件）
  const changesFile = path.join(projDir, ".工作台", "changes.jsonl");
  const changeLine = { ts: "2026-09-18T10:00:00.000+08:00", path: "src/x.ts", action: "modify", size_delta: 12 };
  fs.appendFileSync(changesFile, JSON.stringify(changeLine) + "\n", "utf8");
  const rAct = await fetch(`${BASE}/api/projects/m3-proj/activity`);
  const actBody = (await rAct.json()) as {
    ok: boolean;
    activity: { last_change_at: string | null; last_task_report_at: string | null };
  };
  console.log(`[verify] ── GET activity 返回: ${JSON.stringify(actBody)}`);
  ok(
    rAct.ok &&
      actBody.ok &&
      actBody.activity.last_change_at === changeLine.ts &&
      typeof actBody.activity.last_task_report_at === "string" &&
      actBody.activity.last_task_report_at !== "",
    "DoD④：activity 返回 last_change_at（changes.jsonl 末行 ts）+ last_task_report_at（tasks.json 最大 updated_at）",
  );
  // 空态：m3-proj2 无变更无任务 → 两字段 null
  const rAct2 = await fetch(`${BASE}/api/projects/m3-proj2/activity`);
  const act2 = (await rAct2.json()) as {
    activity: { last_change_at: string | null; last_task_report_at: string | null };
  };
  ok(
    act2.activity.last_change_at === null && act2.activity.last_task_report_at === null,
    "DoD④b：无数据项目两字段为 null（正常空态，不报错）",
  );
}

async function checkMcp(): Promise<void> {
  console.log("\n[verify] ══ DoD⑤：MCP 链路闭环（report_task_status 触发汇总）══");
  addModule("m3-proj", { id: "m-mcp", name: "MCP 汇总模块" }, dataDir);
  const tsxCli = path.join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [tsxCli, path.join(REPO_ROOT, "src", "mcp", "index.ts")],
    cwd: REPO_ROOT,
    env: { ...process.env, TATAI_HOME: dataDir } as Record<string, string>,
    stderr: "inherit",
  });
  const client = new Client({ name: "m3-verify-client", version: "0.0.1" });
  await client.connect(transport);
  try {
    const call = async (status: string) => {
      const r = await client.callTool({
        name: "report_task_status",
        arguments: {
          project_id: "m3-proj",
          task_id: "t-mcp-1",
          title: "MCP 汇总验证任务",
          module_id: "m-mcp",
          status,
        },
      });
      const text = (r.content as Array<{ type: string; text?: string }>)
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n");
      console.log(`[verify] ── report_task_status(${status}) 返回（isError=${r.isError === true}）:\n${text}`);
      return r.isError !== true;
    };
    ok(
      (await call("doing")) && moduleStatus("m-mcp") === "doing",
      "MCP 首报 doing → 模块 m-mcp 汇总为 doing",
    );
    ok(
      (await call("done")) && moduleStatus("m-mcp") === "done",
      "MCP 再报 done → 模块 m-mcp 汇总为 done",
    );
  } finally {
    await client.close();
    await transport.close();
  }
}

async function main(): Promise<void> {
  checkAttach();
  checkRollup();
  await startServer();
  try {
    await checkHttp();
  } finally {
    serverProc?.kill();
    serverProc = null;
  }
  await checkMcp();
  fs.rmSync(tmpBase, { recursive: true, force: true });
  console.log(process.exitCode ? "\n[verify] 有 FAIL" : "\n[verify] 全部 PASS");
}

main().catch((err) => {
  serverProc?.kill();
  console.error("[verify] 异常:", err);
  process.exitCode = 1;
});
