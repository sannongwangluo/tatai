// M5 验证脚本（tsx 跑）：MCP 扩充两件套 get_arch + ask_flash（DESIGN.md §6.4，
// 2026-09-19 主人拍板"都要做全"）。真实 MCP client 连真实 server 子进程；
// get_arch 的底图用真实 HTTP 后端 POST arch/parse 生成（不手造 modules.json）。
// 覆盖点：
//   ① listTools 含 get_arch / ask_flash；仍无 write_design（§6.3 权限红线回归）
//   ② get_arch（已解析项目）返回三视图共用数据：节点数组非空、JSON 可解析
//   ③ ask_flash 真调：marker 文件暗记被挖出（answer 含暗记与文件名）、tools_used 非空；
//     未开 full_coverage 的回答不带对账回执（口径只在开启时出现）
//   ④ ask_flash 不落盘：调用前后 .工作台/chat/ 会话文件零新增（一次性问答不是会话）
//   ⑤ 权限证伪：ask_flash 缺参回 isError
//   A  collectFiles 机械清单（不调 API）：列全含 tests/docs 的五类文件、跳 node_modules、截断如实
//   ⑥ 覆盖对账真调（2026-09-19 主人拍板，交接简报场景）：问题很窄（只问 app.ts）+
//     full_coverage=true ——服务器机械对账把清单里其余文件按住读完，回执「全部已读」，
//     无聊测试文件的暗记也进回答（读全由机器保证，不靠模型自觉）
// ████ 红线 ████ 本脚本绝不打印密钥原文（只报是否存在）。
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { addProject } from "../src/server/registry";
import { collectFiles } from "../src/server/chatTools";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8802;
const BASE = `http://localhost:${PORT}`;
const PROJ = "m5-proj";

const ok = (cond: boolean, label: string) => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (!cond) process.exitCode = 1;
};

// ── 临时数据目录 + 临时项目（不碰真实 TATAI_HOME 与真实项目）──
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-m5-verify-"));
const dataDir = path.join(tmpBase, "home");
const projDir = path.join(tmpBase, "proj");
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(path.join(projDir, "src"), { recursive: true });
fs.writeFileSync(path.join(projDir, "package.json"), '{"name":"m5-verify-proj"}\n', "utf8");
// 暗记：只有真读了文件的模型才答得出（海豚-委托-66 写在 src/app.ts 第 2 行）
fs.writeFileSync(
  path.join(projDir, "src", "app.ts"),
  ['export const APP = "app";', '// 海豚-委托-66：ask_flash 必须真调 read_file/search_code 才能引用这行', ""].join("\n"),
  "utf8",
);
fs.writeFileSync(
  path.join(projDir, "src", "util.ts"),
  ['export function util(): number { return 42; }', ""].join("\n"),
  "utf8",
);
// 覆盖对账用例的"无聊文件"：模型平时最想跳过的角落（tests/docs），对账开了就必须读到
fs.mkdirSync(path.join(projDir, "tests"), { recursive: true });
fs.writeFileSync(
  path.join(projDir, "tests", "boring_test.py"),
  ["# 水母-对账-88：只有覆盖对账强制读完这个文件，暗记才会进回答", ""].join("\n"),
  "utf8",
);
fs.mkdirSync(path.join(projDir, "docs"), { recursive: true });
fs.writeFileSync(path.join(projDir, "docs", "note.md"), "# 项目备注\n架构：无。\n", "utf8");
// 依赖垃圾：清单口径必须跳过（A 部分断言）
fs.mkdirSync(path.join(projDir, "node_modules", "junk-pkg"), { recursive: true });
fs.writeFileSync(
  path.join(projDir, "node_modules", "junk-pkg", "index.js"),
  "throw new Error('不该被列进清单');\n",
  "utf8",
);
// Python 侧缓存垃圾（2026-09-19 实测第二大脑 140 个 .pyc 混进对账清单后补的跳过规则）
fs.mkdirSync(path.join(projDir, "scripts", "__pycache__"), { recursive: true });
fs.writeFileSync(path.join(projDir, "scripts", "__pycache__", "junk.cpython-314.pyc"), "binary-junk", "utf8");
fs.mkdirSync(path.join(projDir, "demo.egg-info"), { recursive: true });
fs.writeFileSync(path.join(projDir, "demo.egg-info", "metadata.txt"), "build-meta-junk", "utf8");
addProject({ id: PROJ, name: "M5 验证项目", path: projDir, kind: "backend" }, dataDir);

// ── HTTP 后端子进程：只为 POST arch/parse 生成底图（与 verify-chat-arch-write 同口径）──
const upPorts = new Set<number>();
function portListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: "127.0.0.1" });
    const done = (busy: boolean) => {
      sock.destroy();
      resolve(busy);
    };
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
    sock.setTimeout(1000, () => done(false));
  });
}
async function assertPortFree(port: number): Promise<void> {
  if (await portListening(port)) {
    console.error(`[verify] 起不来：端口 ${port} 被占用，先清理残留进程`);
    process.exit(1);
  }
}
function watchChild(proc: ChildProcess, port: number, isUp: () => boolean): void {
  proc.once("exit", async (code) => {
    if (isUp()) return;
    const why = (await portListening(port)) ? `端口 ${port} 被占用` : `进程提前退出（code=${code}）`;
    console.error(`[verify] 起不来：${why}`);
    process.exit(1);
  });
}
async function waitUp(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return;
    } catch {
      /* 还没起来，继续等 */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("后端 10 秒内未就绪");
}

const chatDir = path.join(projDir, ".工作台", "chat");
const listChatFiles = (): string[] => (fs.existsSync(chatDir) ? fs.readdirSync(chatDir) : []);

async function main(): Promise<void> {
  // ── A：collectFiles 机械清单（不调 API）：对账的清单口径与 list_files 同源 ──
  const listed = collectFiles(projDir, "", 400);
  ok(
    ["package.json", "src/app.ts", "src/util.ts", "tests/boring_test.py", "docs/note.md"].every((f) =>
      listed.files.includes(f),
    ),
    `A collectFiles 列全五类文件，含模型最想跳过的 tests/docs（实际 ${listed.files.length} 个）`,
  );
  ok(!listed.files.some((f) => f.startsWith("node_modules/")), "A collectFiles 跳过 node_modules");
  ok(
    !listed.files.some((f) => f.includes("__pycache__") || f.endsWith(".pyc") || f.endsWith(".egg-info/")),
    "A collectFiles 跳过 Python 缓存垃圾（__pycache__/.pyc/.egg-info）",
  );
  const capped = collectFiles(projDir, "", 2);
  ok(capped.files.length === 2 && capped.truncated, "A collectFiles 上限截断如实标记 truncated=true");

  await assertPortFree(PORT);
  const backend = spawn(process.execPath, ["--import", "tsx", path.join("src", "server", "index.ts")], {
    env: { ...process.env, TATAI_HOME: dataDir, TATAI_PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
    cwd: REPO_ROOT,
  });
  backend.stderr?.on("data", (d: Buffer) => process.stderr.write(`[server] ${d}`));
  watchChild(backend, PORT, () => upPorts.has(PORT));
  await waitUp();
  upPorts.add(PORT);
  console.log(`[verify] server up at ${BASE}`);

  let client: Client | undefined;
  try {
    const pr = await fetch(`${BASE}/api/projects/${PROJ}/arch/parse`, { method: "POST" });
    ok(pr.status === 200, "前置：POST arch/parse → 200（解析层就位）");

    // ── 起真实 MCP server 子进程（与 verify-m2 同口径）──
    const tsxCli = path.join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [tsxCli, path.join(REPO_ROOT, "src", "mcp", "index.ts")],
      cwd: REPO_ROOT,
      env: { ...process.env, TATAI_HOME: dataDir } as Record<string, string>,
      stderr: "inherit",
    });
    client = new Client({ name: "m5-verify-client", version: "0.0.1" });
    await client.connect(transport);
    ok(transport.pid != null, `MCP server 子进程已拉起（pid=${transport.pid}）`);

    const call = async (name: string, args: Record<string, unknown>) => {
      const r = await client!.callTool({ name, arguments: args });
      const text = Array.isArray(r.content)
        ? r.content.filter((c): c is { type: "text"; text: string } => c.type === "text").map((c) => c.text).join("\n")
        : "";
      return { isError: r.isError === true, text };
    };

    // ① 工具清单
    const listed = await client.listTools();
    const names = listed.tools.map((t) => t.name);
    ok(names.includes("get_arch"), `① listTools 含 get_arch（实际 ${names.length} 个工具）`);
    ok(names.includes("ask_flash"), "① listTools 含 ask_flash");
    ok(!names.includes("write_design"), "① 权限红线回归：仍无 write_design");

    // ② get_arch（已解析项目）
    const g = await call("get_arch", { project_id: PROJ });
    ok(!g.isError, "② get_arch 不报错");
    let graph: { nodes?: { id: string; name?: string }[] } = {};
    try {
      graph = JSON.parse(g.text);
    } catch {
      /* 下面断言兜住 */
    }
    ok((graph.nodes?.length ?? 0) > 0, `② get_arch 返回节点数组（${graph.nodes?.length ?? 0} 个）`);

    // ⑤ 缺参证伪（放在真调前面，先廉价后昂贵）
    const bad = await call("ask_flash", { project_id: PROJ });
    ok(bad.isError, "⑤ ask_flash 缺 question → isError");
    // ⑤b 范围证伪（不调 API：预校验在模型调用之前）：目录不存在直接 isError，不静默缩范围
    const badScope = await call("ask_flash", {
      project_id: PROJ,
      question: "随便问点什么",
      full_coverage: true,
      coverage_scope: ["no-such-dir"],
    });
    ok(
      badScope.isError && badScope.text.includes("无效目录"),
      "⑤b coverage_scope 目录不存在 → isError（不静默缩范围假装读全）",
    );

    // ③④ 真调 ask_flash（需要 DEEPSEEK_API_KEY）
    if (!process.env.DEEPSEEK_API_KEY?.trim()) {
      console.log("[verify] FAIL 前置：DEEPSEEK_API_KEY 未配置，③④ 无法真调");
      process.exitCode = 1;
    } else {
      console.log("[verify] 前置：DEEPSEEK_API_KEY 已配置（原文不打印）");
      const before = listChatFiles();
      const r = await call("ask_flash", {
        project_id: PROJ,
        question: "src/app.ts 文件里写着什么暗记？原样引用那一行，并说明它在哪个文件。",
      });
      ok(!r.isError, "③ ask_flash 不报错");
      let payload: { answer?: string; tools_used?: string[] } = {};
      try {
        payload = JSON.parse(r.text);
      } catch {
        /* 断言兜住 */
      }
      const answer = payload.answer ?? "";
      console.log(`[verify]   tools_used：${(payload.tools_used ?? []).join("；")}`);
      console.log(`[verify]   answer（${answer.length} 字）：${answer.slice(0, 160)}`);
      ok(answer.includes("海豚-委托-66"), "③ answer 含暗记（Flash 真读了文件，非编造）");
      ok(answer.includes("app.ts"), "③ answer 指名文件 src/app.ts");
      ok((payload.tools_used?.length ?? 0) >= 1, "③ tools_used 非空（真调了工具）");
      ok(!answer.includes("覆盖对账"), "③ 未开 full_coverage 的回答不带对账回执（口径只在开启时出现）");
      const after = listChatFiles();
      ok(
        JSON.stringify(before) === JSON.stringify(after),
        `④ ask_flash 不落盘：调用前后会话文件一致（前 ${before.length} 个 / 后 ${after.length} 个）`,
      );

      // ⑥ 覆盖对账真调：问题很窄（只问 app.ts）+ full_coverage=true——机械对账把其余文件按住读完
      const r2 = await call("ask_flash", {
        project_id: PROJ,
        question: "src/app.ts 里写着什么暗记？原样引用那一行。",
        full_coverage: true,
      });
      ok(!r2.isError, "⑥ ask_flash(full_coverage) 不报错");
      let payload2: { answer?: string; tools_used?: string[] } = {};
      try {
        payload2 = JSON.parse(r2.text);
      } catch {
        /* 断言兜住 */
      }
      const answer2 = payload2.answer ?? "";
      console.log(`[verify]   tools_used：${(payload2.tools_used ?? []).join("；")}`);
      console.log(`[verify]   answer2（${answer2.length} 字）：${answer2.slice(0, 160)}`);
      ok(
        /——覆盖对账（服务器机械核验）——\n文件清单 \d+ 个，全部已读/.test(answer2),
        "⑥ 回答末尾有机械对账回执且「全部已读」（读全由服务器核验，非模型自述）",
      );
      ok(answer2.includes("海豚-委托-66"), "⑥ 窄问题的答案本身没丢（暗记仍被答出）");
      ok(
        answer2.includes("boring_test.py") && answer2.includes("水母-对账-88"),
        "⑥ 无聊测试文件被强制读完（文件名与暗记都进了回答）",
      );
    }
  } finally {
    await client?.close();
    if (!backend.killed) backend.kill();
    await new Promise((r) => setTimeout(r, 300));
  }
}

main()
  .catch((e) => {
    console.error(`[verify] 异常: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  })
  .finally(() => {
    try {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    } catch {
      /* Windows 下文件偶被占用，残留 tmp 目录无害 */
    }
    console.log("[verify] done");
  });
