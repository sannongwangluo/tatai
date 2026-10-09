// M1 验证脚本（用 tsx 跑）：真实 MCP client 连真实 server 子进程验证 MCP server 骨架（PLAN.md M1 卡）。
// 用法：pnpm verify:m1（自带临时 TATAI_HOME 造 2 条项目，不碰真实注册表）
// 覆盖点（对应 M1 DoD）：
//   ① SDK client + StdioClientTransport 真实连上 server 子进程，listTools 返回含 list_projects（贴工具列表）
//   ② callTool list_projects 返回真实注册表内容（2 条项目逐字段核对）
//   ③ idle：连接后静默 10s，子进程仍活着且 CPU 采样≈0
//   ④ 只有一个 server 口径：grep 自查 @modelcontextprotocol 只出现在 src/mcp（+本脚本）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { addProject } from "../src/server/registry";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const ok = (cond: boolean, label: string) => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (!cond) process.exitCode = 1;
};

// ── 临时数据目录 + 造 2 条项目（不碰真实注册表）──
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-m1-verify-"));
const dataDir = path.join(tmpBase, "home");
const projDirA = path.join(tmpBase, "m1-proj-a");
const projDirB = path.join(tmpBase, "m1-proj-b");
fs.mkdirSync(projDirA, { recursive: true });
fs.mkdirSync(projDirB, { recursive: true });
addProject({ id: "m1-proj-a", name: "M1 验证项目甲", path: projDirA, kind: "backend" }, dataDir);
addProject({ id: "m1-proj-b", name: "M1 验证项目乙", path: projDirB, kind: "static" }, dataDir);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 采样子进程累计 CPU 秒数（Windows PowerShell Get-Process；采样两次做差） */
function sampleCpuSeconds(pid: number): number | null {
  try {
    const out = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-Command", `(Get-Process -Id ${pid} -ErrorAction Stop).CPU`],
      { encoding: "utf8" },
    ).trim();
    const v = Number(out);
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  // ── ① 起真实 server 子进程（node + tsx CLI 跑 src/mcp/index.ts，平台无关）──
  const tsxCli = path.join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [tsxCli, path.join(REPO_ROOT, "src", "mcp", "index.ts")],
    cwd: REPO_ROOT,
    env: { ...process.env, TATAI_HOME: dataDir } as Record<string, string>,
    stderr: "inherit",
  });
  const client = new Client({ name: "m1-verify-client", version: "0.0.1" });
  await client.connect(transport);
  const serverPid = transport.pid;
  ok(serverPid !== undefined && serverPid !== null, `server 子进程已拉起（pid=${serverPid}）`);

  // ── ② listTools：真实列出工具 ──
  const tools = await client.listTools();
  console.log("[verify] listTools 返回：");
  console.log(JSON.stringify(tools.tools, null, 2));
  const names = tools.tools.map((t) => t.name);
  ok(names.includes("list_projects"), `listTools 含 list_projects（实际: ${names.join(", ")}）`);

  // ── ③ callTool list_projects：返回真实注册表内容 ──
  const result = await client.callTool({ name: "list_projects", arguments: {} });
  const text = (result.content as Array<{ type: string; text?: string }>)
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  console.log("[verify] callTool list_projects 返回：");
  console.log(text);
  const payload = JSON.parse(text) as {
    projects: Array<{ id: string; name: string; path: string; kind: string }>;
  };
  ok(payload.projects.length === 2, `返回 2 条项目（实际 ${payload.projects.length}）`);
  const a = payload.projects.find((p) => p.id === "m1-proj-a");
  const b = payload.projects.find((p) => p.id === "m1-proj-b");
  ok(
    !!a && a.name === "M1 验证项目甲" && a.kind === "backend" && path.resolve(a.path) === path.resolve(projDirA),
    "m1-proj-a 字段与注册表逐字段一致",
  );
  ok(
    !!b && b.name === "M1 验证项目乙" && b.kind === "static" && path.resolve(b.path) === path.resolve(projDirB),
    "m1-proj-b 字段与注册表逐字段一致",
  );

  // ── ④ 未知工具回 isError，进程不挂 ──
  const bad = await client.callTool({ name: "no_such_tool", arguments: {} });
  ok(bad.isError === true, `未知工具回 isError（text=${JSON.stringify((bad.content as any[])[0]?.text)}）`);

  // ── ⑤ idle 测试：静默 10s，进程仍活着且 CPU≈0 ──
  const cpu0 = serverPid != null ? sampleCpuSeconds(serverPid) : null;
  await sleep(10_000);
  let alive = false;
  if (serverPid != null) {
    try {
      process.kill(serverPid, 0);
      alive = true;
    } catch {
      alive = false;
    }
  }
  ok(alive, "idle 10s 后 server 子进程仍活着（未异常退出）");
  const cpu1 = serverPid != null ? sampleCpuSeconds(serverPid) : null;
  if (cpu0 !== null && cpu1 !== null) {
    const delta = cpu1 - cpu0;
    console.log(`[verify] idle 10s CPU 采样：${cpu0.toFixed(3)}s → ${cpu1.toFixed(3)}s（增量 ${delta.toFixed(3)}s）`);
    ok(delta < 0.2, `idle 期间 CPU 增量≈0（实际 ${delta.toFixed(3)}s < 0.2s）`);
  } else {
    ok(false, "CPU 采样失败（Get-Process 不可用）");
  }

  // ── ⑥ 只有一个 server 口径：SDK 真实 import 只出现在 src/mcp、验证脚本（点名白名单）与 B2 客户端 ──
  // （onboard.ts 第 114 行只是 R2 kind 启发式的依赖名字符串，非引用；
  //   verify-m2/m3.ts 是 M2/M3 新增的真实 client 验证脚本，同样要 import SDK；
  //   src/server/memory.ts 是 B2 记忆检索的 MCP 客户端（往外连，非第二个 server），
  //   只允许 import client 子路径——一期审计 2026-09-18 把它加进白名单并加严检查；
  //   **2026-09-20（V06-10）**：v06-* 卡开始要求"真起 MCP 客户端/server 子进程做端到端"
  //   （verify-v06-10.ts 用真 client 抢同一张卡、验认领/回报链路），这类脚本**必然** import SDK，
  //   故白名单点名加上 `v06-\d+`。口径不变：仍是**逐个点名的白名单**，不是"任意脚本都能 import"。）
  const B2_CLIENT = "src/server/memory.ts";
  // **2026-09-23（DES 等价检查，验收区收口）**：`verify-des-v06-current.ts` 要真起 stdio MCP server
  // 读回工具数与 DESIGN 原文（与原 verify-v06.mjs 同一目的），故白名单**点名**加上它——口径不变，
  // 仍是逐个点名的白名单，不是"任意脚本都能 import"。
  // 2026-09-26（V09-19）定向更新：白名单补 `v09-\d+`／`v09-\d+-[a-z0-9]+` 两种命名形式。五要素留档：
  //   旧期望：只认 m\d／u2／des-v06-current／v06-\d+／v06-\d+-字母 ⇒ `scripts/verify-v09-14.ts`（v0.9 批次
  //     9b26e15 新增、真起 stdio MCP 客户端）被判成"越界的 SDK 引用"，本断言自那以后一直红。
  //   依据：本断言的口径是「SDK 引用只在 src/mcp/、**验证脚本**与 B2 客户端」——具体脚本名单按命名形式登记，
  //     历史上已两次按新命名形式加白（V06-10 的端到端脚本、补修脚本的 `verify-v06-NN-<字母>`）。
  //   新期望：加白 `v09-\d+` 与 `v09-\d+-[a-z0-9]+`（与 v06 同族，理由同类）。
  //   保留意图：SDK 引用仍只允许出现在 src/mcp/、白名单验证脚本与 src/server/memory.ts——不是删断言、不是改成
  //     "任何 verify-* 都放行"（白名单仍是**逐族点名**，新增一族要在这里留痕）。
  //   判据不放宽：允许面只增加了 v0.9 批次的验证脚本族（它们与 v06 族做同一件事：真起 stdio 客户端验收）。
  // 2026-10-08（共同夹具修复批）定向更新：`verify-forward-journey.ts`（V09-29 正向闭环完整旅程，真 stdio
  //   MCP 客户端 + 真 `src/mcp/index.ts` 子进程）不落在原命名形式里（它既非 m\d／u2／v06-\d+／v09-\d+ 任一形式），
  //   被这条白名单判成"越界的 SDK 引用"而一直红。五要素留档：
  //   旧期望＝上面的正则（不含 forward-journey）｜依据＝历史上按命名形式逐族点名登记；
  //   新期望＝**按名点名**加上 `forward-journey`（不引入通配、不改成"任意 verify-* 都放行"）｜
  //   保留意图＝SDK 引用仍只允许出现在 src/mcp/、白名单验证脚本与 B2 客户端；新增一族仍要在这里留痕。
  //   旁证（真实 SDK client，非第二个 server）：下面新增一条独立断言——scripts/ 下每个命中脚本的 SDK 引用
  //   只 import client 子路径（`@modelcontextprotocol/sdk/client/*`），没有一个 import server 子路径。
  const SDK_WHITELIST_RE = /^scripts\/verify-(?:m\d|u2|forward-journey|des-v06-current|v06-\d+|v06-\d+-[a-z0-9]+|v09-\d+|v09-\d+-[a-z0-9]+)\.ts$/;
  const hits: string[] = [];
  const walk = (dir: string, relPrefix: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      const rel = relPrefix ? `${relPrefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(abs, rel);
      else if (/\.(ts|tsx)$/.test(e.name)) {
        const content = fs.readFileSync(abs, "utf8");
        if (/from\s+["']@modelcontextprotocol\//.test(content)) hits.push(rel);
      }
    }
  };
  walk(path.join(REPO_ROOT, "src"), "src");
  walk(path.join(REPO_ROOT, "scripts"), "scripts");
  console.log(`[verify] SDK import 出现位置: ${hits.join(", ")}`);
  const b2Content = fs.readFileSync(path.join(REPO_ROOT, B2_CLIENT), "utf8");
  const b2SdkImports = b2Content.match(/from\s+["']@modelcontextprotocol\/[^"']+["']/g) ?? [];
  ok(
    b2SdkImports.every((i) => i.includes("/client/")),
    `B2 客户端 ${B2_CLIENT} 只 import SDK client 子路径（实际: ${b2SdkImports.join(" ")}）`,
  );
  ok(
    hits.every((h) => h.startsWith("src/mcp/") || SDK_WHITELIST_RE.test(h) || h === B2_CLIENT),
    "SDK 引用只在 src/mcp/、verify-{m*,u2,forward-journey,des-v06-current,v06-*,v09-*} 与 B2 客户端 memory.ts（唯一 MCP server 入口；u2 用 SDK client 测随包 server，2026-09-18 审计订正白名单；2026-09-20 V06-10 端到端脚本点名加白；同因再加补修脚本的命名形式 `verify-v06-NN-<字母>`；2026-09-23 再加 `verify-des-v06-current.ts`；2026-10-08 再加 `verify-forward-journey.ts`——完整旅程要真起 stdio MCP 客户端）",
  );
  // 白名单只证明"名字在族里"；再按**真实 import 子路径**证伪"第二个 server"：scripts/ 下的 SDK 引用
  // 一条都不能 import server 子路径（server 只能有一个，在 src/mcp/）。这条是独立判据，不放宽原白名单。
  const scriptSdkImports = hits
    .filter((h) => h.startsWith("scripts/"))
    .flatMap((h) => fs.readFileSync(path.join(REPO_ROOT, h), "utf8").match(/from\s+["']@modelcontextprotocol\/[^"']+["']/g) ?? []);
  ok(
    scriptSdkImports.length > 0 && scriptSdkImports.every((i) => i.includes("/client/")),
    `白名单脚本都是真实 SDK client（只 import client 子路径、不是第二个 server；样本 ${scriptSdkImports.length} 条引用）`,
  );

  await client.close();
  await transport.close();
  fs.rmSync(tmpBase, { recursive: true, force: true });
  console.log(process.exitCode ? "[verify] 有 FAIL" : "[verify] 全部 PASS");
}

main().catch((err) => {
  console.error("[verify] 异常:", err);
  process.exitCode = 1;
});
