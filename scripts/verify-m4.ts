// M4 验证脚本（用 tsx 跑）：agent 登记层 + GET /api/agents + 隐私自查（PLAN.md M4 卡）。
// 用法：pnpm verify:m4（自带临时 TATAI_HOME 与临时项目目录，不碰真实注册表与真实项目）
// 覆盖点（对应 M4 DoD 逐条）：
//   ① SDK client（clientInfo.name="m4-verify-agent"）调一次 list_projects →
//      <临时TATAI_HOME>/agents.json 出现该 agent 条目（贴文件内容）
//   ② 同一名字再调一次 → last_active_at 刷新且不产生第二条
//   ③ 第二个 client 名 → 第二条目
//   ④ GET /api/agents 返回对照（last_active_at 倒序）
//   ⑤ 隐私：agents.json 只在全局数据目录——不在任何项目目录内；
//      用真实全局数据目录（`TATAI_HOME` > 缺省 `~/.tatai/`）登记一条后 git status 依然干净（不进仓库）
import { spawn, execSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { addProject } from "../src/server/registry";
import { finish, realHome } from "./lib/fixtures";
import { agentsPath, listAgents, readAgents, registerAgentActivity } from "../src/server/agents";
import { compareIsoTime } from "../src/server/time";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8799;
const BASE = `http://localhost:${PORT}`;

const ok = (cond: boolean, label: string) => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (!cond) process.exitCode = 1;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 路径边界判定（Q112，2026-09-18 审计）：纯字符串 `startsWith` 没有分隔符边界——
 * `TATAI_HOME=D:\tatai-audit-tmp` 确在仓库外，却因前缀撞上 `D:\tatai` 被判成"在仓库内" → 假 FAIL。
 * 口径：两边 `path.resolve` 归一化后取相对路径；在 parent 内 ⇔ 相对串不以 `..` 起头（也不是跨盘绝对路径）。
 * Windows 大小写：`path.win32.relative` 内部已按小写比较，`D:\tatai` 与 `d:\tatai\x` 判得对。
 */
function isInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

// ── 临时数据目录与临时项目（不碰真实注册表与真实项目）──
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-m4-verify-"));
const dataDir = path.join(tmpBase, "home");
const projDir = path.join(tmpBase, "m4-proj");
fs.mkdirSync(path.join(projDir, ".工作台"), { recursive: true });
addProject({ id: "m4-proj", name: "M4 验证项目", path: projDir, kind: "backend" }, dataDir);

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

/** 起一个 MCP SDK client（clientInfo.name 自报为给定名字），调一次 list_projects 后关闭 */
async function callListProjects(clientName: string): Promise<void> {
  const tsxCli = path.join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [tsxCli, path.join(REPO_ROOT, "src", "mcp", "index.ts")],
    cwd: REPO_ROOT,
    env: { ...process.env, TATAI_HOME: dataDir } as Record<string, string>,
    stderr: "inherit",
  });
  const client = new Client({ name: clientName, version: "0.0.1" });
  await client.connect(transport);
  try {
    const r = await client.callTool({ name: "list_projects", arguments: {} });
    const text = (r.content as Array<{ type: string; text?: string }>)
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    console.log(`[verify] ── ${clientName} 调 list_projects 返回（isError=${r.isError === true}）:\n${text}`);
    if (r.isError === true) throw new Error(`list_projects 调用失败: ${text}`);
  } finally {
    await client.close();
    await transport.close();
  }
}

async function main(): Promise<void> {
  console.log("[verify] ══ DoD①：首次调用任一工具 → agents.json 出现条目 ══");
  await callListProjects("m4-verify-agent");
  const agentsFile = agentsPath(dataDir);
  ok(fs.existsSync(agentsFile), "agents.json 已生成于全局数据目录");
  const content1 = fs.readFileSync(agentsFile, "utf8");
  console.log(`[verify] ── cat ${agentsFile}:\n${content1}`);
  const store1 = readAgents(dataDir);
  const rec1 = store1.agents.find((a) => a.name === "m4-verify-agent");
  ok(
    store1.version === 1 && store1.agents.length === 1 && rec1 !== undefined &&
      rec1.id === "m4-verify-agent" && rec1.first_seen_at !== "" && rec1.last_active_at !== "",
    `DoD①：agents.json 结构 {version:1, agents:[{id,name,first_seen_at,last_active_at}]}，含 m4-verify-agent（id=${rec1?.id}）`,
  );

  console.log("\n[verify] ══ DoD②：同名再调 → 只刷 last_active_at，不出第二条 ══");
  const firstActive = rec1!.last_active_at;
  await sleep(1100); // nowIso 秒级精度，跨秒保证刷新可见
  await callListProjects("m4-verify-agent");
  const store2 = readAgents(dataDir);
  const rec2 = store2.agents.find((a) => a.name === "m4-verify-agent");
  ok(
    store2.agents.length === 1 && rec2 !== undefined &&
      compareIsoTime(rec2.last_active_at, firstActive) > 0 && rec2.first_seen_at === rec1!.first_seen_at,
    `DoD②：不产生第二条（共 ${store2.agents.length} 条），last_active_at ${firstActive} → ${rec2?.last_active_at}`,
  );

  console.log("\n[verify] ══ DoD③：第二个 client 名 → 第二条目 ══");
  await sleep(1100); // 与上一步跨秒，保证 DoD④ 的倒序可分辨
  await callListProjects("m4-second-agent");
  const store3 = readAgents(dataDir);
  ok(
    store3.agents.length === 2 &&
      store3.agents.some((a) => a.name === "m4-second-agent" && a.id === "m4-second-agent"),
    `DoD③：第二个名字新增第二条（共 ${store3.agents.length} 条）`,
  );

  console.log("\n[verify] ══ DoD④：GET /api/agents 对照 ══");
  await startServer();
  try {
    const r = await fetch(`${BASE}/api/agents`);
    const body = (await r.json()) as { ok: boolean; agents: Array<{ name: string; last_active_at: string }> };
    console.log(`[verify] ── GET /api/agents 返回: ${JSON.stringify(body)}`);
    ok(
      r.ok && body.ok && body.agents.length === 2 &&
        body.agents[0].name === "m4-second-agent" && // 后调的在前（倒序）
        body.agents[1].name === "m4-verify-agent",
      "DoD④：/api/agents 返回两条，按 last_active_at 倒序",
    );
    const viaLayer = listAgents(dataDir);
    ok(
      JSON.stringify(viaLayer.map((a) => a.name)) === JSON.stringify(body.agents.map((a) => a.name)),
      "DoD④b：HTTP 与数据层口径一致",
    );
  } finally {
    serverProc?.kill();
    serverProc = null;
  }

  console.log("\n[verify] ══ DoD⑤：隐私自查 ══");
  // 临时 TATAI_HOME 天然在仓库外；断言 agents.json 不在任何项目目录内
  ok(!agentsFile.startsWith(projDir), "agents.json 不在项目目录内");
  ok(!fs.existsSync(path.join(projDir, "agents.json")) &&
    !fs.existsSync(path.join(projDir, ".工作台", "agents.json")),
  "项目目录与其 .工作台/ 下无 agents.json");
  // 真实全局数据目录（`TATAI_HOME` > 缺省 `~/.tatai/`）登记一条后 git status 自查（数据层直接调，等价于 MCP 触发路径）
  const realHomeDir = realHome();
  registerAgentActivity("m4-verify-agent", realHomeDir);
  const realFile = agentsPath(realHomeDir);
  // Q112：边界感知判定（原 `!realFile.startsWith(REPO_ROOT)` 会被 D:\tatai-audit-tmp 这类前缀撞名假 FAIL）
  ok(fs.existsSync(realFile) && !isInside(REPO_ROOT, realFile),
    `真实 agents.json 落在仓库外全局目录（${realFile}）`);
  const gitStatus = execSync("git status --porcelain", { cwd: REPO_ROOT, encoding: "utf8" });
  const agentsInGit = gitStatus.split(/\r?\n/).filter((l) => l.includes("agents.json"));
  ok(
    agentsInGit.length === 0,
    `git status 看不到 agents.json（git status --porcelain 中 agents.json 行数=${agentsInGit.length}）`,
  );
  console.log(`[verify] ── git status --porcelain（前 20 行）:\n${gitStatus.split(/\r?\n/).slice(0, 20).join("\n")}`);

  fs.rmSync(tmpBase, { recursive: true, force: true });
  finish();
}

main().catch((err) => {
  serverProc?.kill();
  console.error("[verify] 异常:", err);
  process.exitCode = 1;
});
