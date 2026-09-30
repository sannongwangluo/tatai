// U2 验证脚本（用 tsx 跑）：桌面集成——路径 / PTY / MCP（PLAN.md 三期 U2 / DESIGN.md §8.1、§3.7、§6.1）。
// 用法：pnpm verify:u2
//
// 覆盖点（对 U2 DoD 逐条）：
//   ① 随包布局三方对齐（DoD① 的前置）：tauri.conf.json 的 bundle.resources 映射、产出目录的实际布局、
//      backend.rs 运行时找的路径——三者指向同一个 <resource_dir>/server/index.js
//   ② 包内后端入口当**普通 Node 程序**真起（动态端口 + /health 探活），不依赖 GUI（DoD①②的自动化半边）
//   ③ 路径解析（DoD①）：注册表 / 日志 / 项目 .工作台 全部落 TATAI_HOME；**安装目录与真实用户数据目录
//      逐文件哈希前后不变**（红线：配置或数据落进应用安装目录 = 卸载即丢）
//   ④ 首次运行自动建全局数据目录 + registry.json，不报错（DoD④，用"启动前该目录根本不存在"来证）
//   ⑤ PTY 在包内后端可用（DoD②）：会话 cwd 锁项目根 + 真敲命令拿回真实回显输出
//   ⑥ 原生件齐全：tree-sitter 真解析 + chokidar 真监听——资源漏拷会到运行时才炸，这里先炸
//   ⑦ MCP 的**包内入口**真被外部客户端连上（DoD③）：真 SDK client 经 stdio 拉起 + listTools + 真调工具
//   ⑧ 回收：杀整棵树后端口不响应、无残留 node.exe
//   ⑨ 真桌面壳（`src-tauri/target/release/tatai.exe` 存在才跑）：壳自己拉起随包后端 → /health 200；
//      exe 不存在时如实 SKIP + 打印手动命令（不许假装跑过）
//
// 说明：脚本自己不跑 `pnpm tauri:build`（长构建不进验证脚本，与 verify-u1 同口径）；
// 窗口截图、终端里手敲命令这类 GUI 证据由人工跑一次并记进 PROGRESS.md（本脚本把可自动化的那半边做实）。
import { spawn, execSync, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { addProject } from "../src/server/registry";
import { LOG_DIR_NAME, LOG_FILE_NAME } from "../src/server/backendLog";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TAURI_DIR = path.join(REPO_ROOT, "src-tauri");
const RES_SERVER = path.join(TAURI_DIR, "resources", "server");
const RELEASE_EXE = path.join(TAURI_DIR, "target", "release", "tatai.exe");
// 工具清单护栏（**逐个点名**，判据是"恰好"）：
//   一期基础工具 8 个（DESIGN.md §6.3）+ 2026-09-19 扩充 get_arch/ask_flash（§6.4）
//   + 2026-09-20 V06-10 扩充 project_entry/claim_task/submit_task_result（§6.7）
//   + 批3 C-015 接线 manage_requirement/manage_change/import_plan_definitions（§2.5/§2.6）= 16 个
//   + 2026-09-22 V07-02 的 rebind_task（§5.6）+ V07-04 的 doctor（附录 C.5-4）= 18 个
//   + 2026-09-26 V09-19 的 get_project_graphs（六图完整状态读口，§6.4／附录 E.18 四）
//   + 2026-09-30 V09-23 的 register_sync_contract / scan_sync_evidence / read_sync_status
//     （同步证据域三接口，DESIGN §2.10 / docs/sync-evidence-contract.md）= **22 个**。
// 如实记一句（2026-09-20 V06-10）：本常量自 2026-09-19 加 get_arch/ask_flash 起就已滞后
// （当时应为 10），只是没人跑到这条断言；V06-10 一并订正为 13，不是 V06-10 弄红的。
// 2026-09-21 收口裁定（先例 m2 25→31、u2 46→47：只改期望集合、不放宽判据）：
// C-015 三件套是注册表正常扩容（src/mcp/tools/index.ts:40-42），期望 13→16，判据一字不动。
// 2026-09-24（V09-05）定向订正：V07-02/V07-04 那两件当时只补进了下面的 MCP_TOOL_NAMES 数组、
// 没同步上面这段说明与下面断言文案里的"16 个"数字 ⇒ 口径字面与清单不一致（清单本身一直是对的）。
// 本次把说明与文案订正为 **18 个**，判据一字不动（仍是 `tools.length === MCP_TOOL_NAMES.length`
// 逐个点名的"恰好"）；注册表 = src/mcp/tools/index.ts 的 TOOLS。README 的工具数同源对账见 verify:v09-05。
// 2026-09-26（V09-19）定向订正：新增六图读口 get_project_graphs（只读，§6.4／附录 E.18 四），
// 说明与清单同步为 **19 个**——判据一字不动（仍是逐个点名的"恰好"，不放过、不放宽）。
// 2026-09-30（V09-23）定向订正：注册表新增同步证据域三接口 register_sync_contract / scan_sync_evidence /
// read_sync_status（DESIGN §2.10 / docs/sync-evidence-contract.md），说明与清单同步为 **22 个**——
// 判据一字不动（仍是逐个点名的"恰好"，不放过、不放宽；**不**改成从注册表动态生成期望）。
const MCP_TOOL_NAMES = [
  "list_projects",
  "select_project",
  "read_design",
  "read_progress",
  "report_task_status",
  "update_progress",
  "append_discuss",
  "list_tasks",
  "get_arch",
  // 2026-09-26 V09-19：六图完整状态读口（§6.4／附录 E.18 四）。只读；不取代 get_arch。
  "get_project_graphs",
  "ask_flash",
  "project_entry",
  "claim_task",
  "submit_task_result",
  "manage_requirement",
  "manage_change",
  "import_plan_definitions",
  // 2026-09-22 定点补登记（V07-02 rebind_task / V07-04 doctor）：清单自 C-015 起就漏了 V07-02
  // 新增的 rebind_task（当时无人跑到这条断言），V07-04 一并补齐并加上 doctor；判据仍是"恰好"。
  "rebind_task",
  "doctor",
  // 2026-09-30 V09-23（DESIGN §2.10 / docs/sync-evidence-contract.md）：同步证据域三个规范接口——
  // register_sync_contract（写）/ scan_sync_evidence（写，经宿主）/ read_sync_status（只读）。
  // 同一个口径（V06-10/V07-02/V07-04/V09-19 先例）：**逐个点名登记**、数量判据仍是"恰好"；
  // 三接口的契约/反例语义由 verify:sync-evidence 等各自守着，本脚本只做身份/集合断言。
  "register_sync_contract",
  "scan_sync_evidence",
  "read_sync_status",
] as const;
const MCP_TOOL_COUNT = MCP_TOOL_NAMES.length; // 22

const ok = (cond: boolean, label: string) => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (!cond) process.exitCode = 1;
};
const read = (p: string) => fs.readFileSync(p, "utf8");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ───────────────────────── 工具 ─────────────────────────

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

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

/** 目录快照：相对路径 → `大小:sha256`。用来断言"这个目录一个字都没被写" */
function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!fs.existsSync(dir)) return out;
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name);
      const rel = path.relative(dir, abs).replace(/\\/g, "/");
      if (e.isDirectory()) walk(abs);
      else if (e.isFile()) {
        const buf = fs.readFileSync(abs);
        out.set(rel, `${buf.length}:${crypto.createHash("sha256").update(buf).digest("hex").slice(0, 16)}`);
      }
    }
  };
  walk(dir);
  return out;
}

/** 前后对比两份快照，返回差异描述（空数组 = 逐字节未变） */
function diffSnapshot(before: Map<string, string>, after: Map<string, string>): string[] {
  const diffs: string[] = [];
  for (const [k, v] of before) {
    if (!after.has(k)) diffs.push(`删除 ${k}`);
    else if (after.get(k) !== v) diffs.push(`改动 ${k}`);
  }
  for (const k of after.keys()) if (!before.has(k)) diffs.push(`新增 ${k}`);
  return diffs;
}

/** 只扫顶层条目（release 目录里有 deps/ 等上百 MB 的 Rust 中间产物，全量哈希不现实）：
 *  新冒出来的目录（logs/、.tatai/、registry.json…）照样会被抓成"新增"，正是红线要防的那件事 */
function snapshotTop(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) out.set(e.name, `dir:${fs.readdirSync(abs).length}`);
    else if (e.isFile()) {
      const buf = fs.readFileSync(abs);
      out.set(e.name, `${buf.length}:${crypto.createHash("sha256").update(buf).digest("hex").slice(0, 12)}`);
    }
  }
  return out;
}

function dirStats(dir: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.isFile()) {
        files++;
        bytes += fs.statSync(abs).size;
      }
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return { files, bytes };
}

function copyTree(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, e.name);
    const to = path.join(dest, e.name);
    if (e.isDirectory()) copyTree(from, to);
    else if (e.isFile()) fs.copyFileSync(from, to);
  }
}

function nodePids(): Set<number> {
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq node.exe" /FO CSV /NH', {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const set = new Set<number>();
    for (const line of out.split(/\r?\n/)) {
      const m = /^"node\.exe","(\d+)"/i.exec(line.trim());
      if (m) set.add(Number(m[1]));
    }
    return set;
  } catch {
    return new Set();
  }
}

function killTree(pid: number): void {
  try {
    execSync(`taskkill /PID ${pid} /T /F`, { stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    // 已经死了
  }
}

async function waitHealth(port: number, tries = 60): Promise<{ status: number; body: string } | null> {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return { status: res.status, body: await res.text() };
    } catch {
      // 还没起来
    }
    await sleep(250);
  }
  return null;
}

/** 终端 SSE 客户端（与 verify-t1 同一读法：data 事件累积 + exit 事件收尾） */
class TerminalSse {
  text = "";
  chunks = 0;
  exitCode: number | null = null;
  private buf = "";
  private res: Response;
  private constructor(res: Response) {
    this.res = res;
    void this.pump();
  }
  static async connect(base: string, sid: string): Promise<TerminalSse> {
    const res = await fetch(`${base}/api/terminal/${encodeURIComponent(sid)}/out`);
    if (!res.ok || !res.body) throw new Error(`SSE 连接失败: HTTP ${res.status}`);
    return new TerminalSse(res);
  }
  private async pump(): Promise<void> {
    try {
      const reader = this.res.body!.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        this.buf += dec.decode(value, { stream: true });
        let sep: number;
        while ((sep = this.buf.indexOf("\n\n")) !== -1) {
          const block = this.buf.slice(0, sep);
          this.buf = this.buf.slice(sep + 2);
          for (const line of block.split("\n")) {
            if (!line.startsWith("data: ")) continue;
            const ev = JSON.parse(line.slice(6)) as { data?: string; exit?: { exitCode: number } };
            if (typeof ev.data === "string") {
              this.text += ev.data;
              this.chunks++;
            }
            if (ev.exit) this.exitCode = ev.exit.exitCode;
          }
        }
      }
    } catch {
      // 连接中断（含收尾杀服务端）是正常终态
    }
  }
  async waitFor(pred: (text: string) => boolean, timeoutMs = 15000): Promise<string> {
    const t0 = Date.now();
    for (;;) {
      if (pred(this.text)) return this.text;
      if (Date.now() - t0 > timeoutMs) {
        throw new Error(`等待超时。当前累计输出:\n${JSON.stringify(this.text)}`);
      }
      await sleep(100);
    }
  }
}

type Json = Record<string, any>;
async function api(base: string, method: string, rawPath: string, body?: unknown) {
  const res = await fetch(`${base}${rawPath}`, {
    method,
    ...(body !== undefined
      ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
      : {}),
  });
  const text = await res.text();
  let parsed: Json = {};
  try {
    parsed = JSON.parse(text) as Json;
  } catch {
    parsed = { raw: text };
  }
  return { status: res.status, body: parsed };
}

// ═════════════ ① 随包布局：配置 / 产出目录 / backend.rs 三方对齐（DoD① 前置） ═════════════

console.log("\n[verify] ── ① 随包布局：bundle.resources ↔ resources/server ↔ backend.rs 找的路径");

const conf = JSON.parse(read(path.join(TAURI_DIR, "tauri.conf.json"))) as Json;
const resources = (conf.bundle?.resources ?? {}) as Record<string, string>;
ok(
  JSON.stringify(resources) ===
    JSON.stringify({ "resources/server": "server", "resources/WebView2Loader.dll": "WebView2Loader.dll" }),
  `① bundle.resources = ${JSON.stringify(resources)}（map 形式把运行时布局钉在 <resource_dir>/server；` +
    `U3 追加的 WebView2Loader.dll 是壳的静态导入依赖，理由见 src-tauri/README.md）`,
);
const resourcesSrc = path.resolve(TAURI_DIR, Object.keys(resources)[0] ?? "");
ok(fs.existsSync(path.join(resourcesSrc, "index.js")), `① 映射的源目录存在且已有 index.js：${path.relative(REPO_ROOT, resourcesSrc)}`);
ok(
  String(conf.build?.beforeBuildCommand ?? "").includes("pnpm build:server"),
  `① beforeBuildCommand = ${String(conf.build?.beforeBuildCommand)}（打包前先产出随包后端）`,
);

const backendSrc = read(path.join(TAURI_DIR, "src", "backend.rs"));
ok(
  /resources\.join\("server"\)\.join\("index\.js"\)/.test(backendSrc),
  "① backend.rs 运行时找的路径 = <resource_dir>/server/index.js（与上面映射的落点同一个）",
);
ok(
  /TATAI_LOG_TO_FILE/.test(backendSrc),
  "① backend.rs 打包分支置 TATAI_LOG_TO_FILE=1（GUI 无控制台 → 日志落全局数据目录，见 backendLog.ts）",
);
ok(
  /if !cfg!\(debug_assertions\) \{\s*\n\s*command\.env\("TATAI_LOG_TO_FILE", "1"\);/.test(backendSrc),
  "① 该开关只在 release 分支生效（dev 行为与本卡之前逐字相同）",
);
ok(
  !fs.existsSync(path.join(RES_SERVER, "node.exe")),
  "① 不随包分发 node.exe（U2 口径：复用系统 PATH 里的 node；理由见 src-tauri/README.md / build-server.ts）",
);

// 产出目录布局
const resTop = fs.readdirSync(RES_SERVER).sort();
const nmPkgs = fs.readdirSync(path.join(RES_SERVER, "node_modules")).sort();
const stats = dirStats(RES_SERVER);
ok(
  fs.existsSync(path.join(RES_SERVER, "index.js")) && fs.existsSync(path.join(RES_SERVER, "mcp.js")),
  `① 两个入口都在包内根目录：${resTop.join(", ")}`,
);
ok(
  JSON.parse(read(path.join(RES_SERVER, "package.json"))).type === "module",
  "① 包内 package.json 声明 type=module（否则 Node 按 CJS 解析 index.js 直接报错）",
);
ok(
  JSON.stringify(nmPkgs) === JSON.stringify(["node-gyp-build", "node-pty", "tree-sitter", "tree-sitter-python", "tree-sitter-typescript"]),
  `① 包内 node_modules 只有原生依赖 + 它的加载器 ${nmPkgs.join("/")}（不是把仓库 node_modules 整个塞进去）`,
);
const pdbs: string[] = [];
const walkPdb = (d: string) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const abs = path.join(d, e.name);
    if (e.isDirectory()) walkPdb(abs);
    else if (/\.pdb$/i.test(e.name)) pdbs.push(path.relative(RES_SERVER, abs));
  }
};
walkPdb(RES_SERVER);
ok(pdbs.length === 0, `① 包内零 *.pdb 调试符号（拷了纯属浪费，白名单已排除）`);
console.log(
  `[verify] ① 包内组成：${resTop.join(", ")} ｜ 共 ${stats.files} 个文件 / ${(stats.bytes / 1024 / 1024).toFixed(2)} MB` +
    `（其中原生件 node-pty ${(dirStats(path.join(RES_SERVER, "node_modules", "node-pty")).bytes / 1024 / 1024).toFixed(2)}MB` +
    ` / tree-sitter 系 ${(["tree-sitter", "tree-sitter-typescript", "tree-sitter-python"].reduce((n, p) => n + dirStats(path.join(RES_SERVER, "node_modules", p)).bytes, 0) / 1024 / 1024).toFixed(2)}MB）`,
);
ok(/src-tauri\/resources\//.test(read(path.join(REPO_ROOT, ".gitignore"))), "① .gitignore 已忽略 src-tauri/resources/（构建物不进 git）");

// ① 打包态 SSE 基址（U2 在打包壳里抓出来的真 bug，回归护栏）：
// dev 走 vite 代理时 `new EventSource("/api/...")` 毫无问题，打包壳里相对路径会打到 WebView 自己身上
// （资产协议回 index.html → 浏览器报 MIME 不是 text/event-stream → 终端全黑、变更/实况收不到推送）。
// 所以全前端喂给 EventSource 的 URL 必须经 api.ts 的 SSE 拼法（apiSseUrl / projectEventsUrl / terminalStreamUrl）。
//
// 【期望集合为何是这 4 处（2026-09-20 订正，**不是**判据放宽）】
//   旧期望：sseSites.length === 3 —— 当时全前端恰好 3 处 EventSource，"恰好 3"就是判据的一部分。
//   依据：V06-08「拆出 per-pane 终端」把终端 SSE 挪进新文件 src/ui/terminal/TerminalPane.tsx（第 4 处），
//         V06-12「Git 提醒卡片」新增 src/ui/components/VersionReminder.tsx（其中的 EventSource）——
//         两者都是**已批准的设计交付**，各自正当地新增了 SSE 消费点 ⇒ 旧期望「恰好 3 处」不再适用
//         （属允许类①：已批准设计/契约变化使旧期望不再适用），故按新事实逐个点名，不删断言、不加容差。
//   新期望：EXPECTED_SSE_SITES **逐条点名**的这 4 处（文件 + 喂进去的拼法调用两列），并要求与实际扫描结果
//         **集合相等**——实际里出现未登记的新 SSE 点必须点名报错，见下面第二条 ok()。
//   保留的验收意图：判据实质没变——全前端所有 EventSource 都必须走 api.ts 的 SSE 拼法，URL 里不得出现裸相对
//         /api 路径（打包壳里相对路径会打到 WebView 自己身上，这是 U2 在打包壳里抓出来的真 bug 的回归护栏）。
//   实际回归结果：改后 `pnpm verify:u2` → ① 三条全 PASS（点数 4/4、裸相对 0、点名对账缺/多均无），
//         全脚本 49 PASS / 0 FAIL，exit code 0（原为 47 PASS / 1 FAIL，exit 1；本卡把 1 条断言拆成 2 条）。
const uiDir = path.join(REPO_ROOT, "src", "ui");
const uiSrcFiles: string[] = [];
const walkUi = (d: string) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const abs = path.join(d, e.name);
    if (e.isDirectory()) walkUi(abs);
    else if (/\.tsx?$/.test(e.name)) uiSrcFiles.push(abs);
  }
};
walkUi(uiDir);
const sseSites: { file: string; url: string }[] = [];
for (const f of uiSrcFiles) {
  // 去行注释再扫：注释里也会写「别这么写」的示例，不该被当成调用点
  const text = read(f)
    .split(/\r?\n/)
    .map((l) => l.replace(/\/\/.*$/, ""))
    .join("\n");
  // 参数捕获留一层嵌套：`new EventSource(projectEventsUrl(projectId))` 里第一个 `)` 是内层调用的，
  // 旧写法 `\(([^)]*)\)` 会把它截成 `projectEventsUrl(projectId`——当判据只数个数时看不出来，点名对账后必须完整。
  for (const m of text.matchAll(/new EventSource\(((?:[^()]|\([^()]*\))*)\)/g)) {
    sseSites.push({ file: path.relative(REPO_ROOT, f).replace(/\\/g, "/"), url: m[1].trim() });
  }
}
const siteName = (s: { file: string; url: string }) => `${s.file}: ${s.url}`;
// 期望的 SSE 消费点：**逐条点名**（旧写法是一个裸数字 3，新事实涨到 4 时它只会说"数量不对"，指不出是谁）
const EXPECTED_SSE_SITES: { file: string; url: string }[] = [
  { file: "src/ui/components/ChangesEntry.tsx", url: "projectEventsUrl(projectId)" },
  { file: "src/ui/components/LiveView.tsx", url: "projectEventsUrl(projectId)" },
  { file: "src/ui/components/VersionReminder.tsx", url: "projectEventsUrl(project.id)" },
  { file: "src/ui/terminal/TerminalPane.tsx", url: "terminalStreamUrl(session.id, project.id)" },
];
const bareSse = sseSites.filter((s) => /["'`]\s*\/api/.test(s.url));
ok(
  sseSites.length === EXPECTED_SSE_SITES.length && bareSse.length === 0,
  `① 全前端 ${sseSites.length} 处 EventSource 全走 api.ts 的基址拼法（裸相对路径 ${bareSse.length} 处）${sseSites.map((s) => `\n        ${siteName(s)}`).join("")}`,
);
const missingSse = EXPECTED_SSE_SITES.filter((e) => !sseSites.some((s) => s.file === e.file && s.url === e.url));
const extraSse = sseSites.filter((s) => !EXPECTED_SSE_SITES.some((e) => e.file === s.file && e.url === s.url));
ok(
  missingSse.length === 0 && extraSse.length === 0,
  `① SSE 消费点逐个点名对账（期望 ${EXPECTED_SSE_SITES.length} 处：ChangesEntry / LiveView / VersionReminder 的 projectEventsUrl + TerminalPane 的 terminalStreamUrl）` +
    `——缺 ${missingSse.map(siteName).join(" ｜ ") || "无"}，未登记 ${extraSse.map(siteName).join(" ｜ ") || "无"}`,
);
ok(
  /export function apiSseUrl/.test(read(path.join(uiDir, "api.ts"))) &&
    /export function projectEventsUrl/.test(read(path.join(uiDir, "api.ts"))),
  "① src/ui/api.ts 提供 apiSseUrl / projectEventsUrl（SSE 基址唯一出处，别再各处自己拼）",
);

// ═════════════ ②③④ 包内后端入口当普通 Node 程序起 ═════════════

console.log("\n[verify] ── ②③④ 包内入口真起：动态端口 + /health + 路径解析 + 首次运行");

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-u2-verify-"));
const installLike = path.join(tmpBase, "install"); // 模拟"应用安装目录"（卸载即丢的那个地方）
const dataHome = path.join(tmpBase, "home", ".tatai"); // 本脚本的临时全局数据目录（**故意建在指向前不存在**）
const projDir = path.join(tmpBase, "u2-proj");
const userHomes = [path.join(os.homedir(), ".tatai"), "D:\\.tatai"].filter((p) => fs.existsSync(p));

// 装成"安装后的目录布局"：exe 同目录下有 server/（Tauri 打包就是这个落法，见 ⑨）
copyTree(path.join(RES_SERVER), path.join(installLike, "server"));
fs.mkdirSync(path.join(projDir, "src"), { recursive: true });
fs.writeFileSync(
  path.join(projDir, "src", "index.ts"),
  'import fs from "node:fs";\nimport os from "node:os";\n\nexport function main(): void {\n  console.log(fs, os);\n}\n',
  "utf8",
);
fs.writeFileSync(path.join(projDir, "src", "util.ts"), "export const answer = 42;\n", "utf8");
fs.writeFileSync(path.join(projDir, "README.md"), "# U2 验证夹具项目\n\n只给验证脚本用，跑完即删。\n", "utf8");

ok(!fs.existsSync(path.join(tmpBase, "home")), `④ 前提：临时全局数据目录启动前**根本不存在**（${path.relative(os.tmpdir(), dataHome)}）`);

const installBefore = snapshot(installLike);
const userBefore = new Map(userHomes.map((h) => [h, snapshot(h)] as const));
const beforeNode = nodePids();

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
let serverLog = "";
let server: ChildProcess | null = null;

try {
  if (await portListening(port)) throw new Error(`端口 ${port} 被占用`);
  server = spawn(process.execPath, [path.join(installLike, "server", "index.js")], {
    // 完全按 backend.rs 打包分支的姿态起：cwd = 资源目录、plain node 跑包内入口、TATAI_PORT 透传
    cwd: installLike,
    env: { ...process.env, TATAI_HOME: dataHome, TATAI_PORT: String(port), TATAI_LOG_TO_FILE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const serverPid = server.pid!;
  server.stdout?.on("data", (d: Buffer) => (serverLog += d.toString()));
  server.stderr?.on("data", (d: Buffer) => (serverLog += d.toString()));

  const health = await waitHealth(port);
  ok(health?.status === 200, `② 包内入口当普通 node 程序真起：GET ${base}/health → ${health?.status ?? "连不上"}`);
  const healthBody = JSON.parse(health?.body ?? "{}") as Json;
  ok(
    healthBody.data_dir === dataHome,
    `③ /health 报的数据目录 = TATAI_HOME（实际: ${String(healthBody.data_dir)}）`,
  );
  console.log(`[verify] ② 后端 stdout（壳里就是转发这些行）：\n${serverLog.trim().split(/\r?\n/).map((l) => `        ${l}`).join("\n")}`);

  // ── ④ 首次运行自动建目录与 registry.json ──
  const logFile = path.join(dataHome, LOG_DIR_NAME, LOG_FILE_NAME);
  ok(fs.existsSync(dataHome), `④ 首次运行自动建了全局数据目录：${dataHome}（启动前不存在，启动后存在）`);
  ok(fs.existsSync(logFile), `③ 日志落在全局数据目录：${logFile}（不在安装目录 ${path.join(installLike, "logs")}）`);
  ok(
    fs.readFileSync(logFile, "utf8").includes("listening on"),
    "③ 日志文件里确有自己的启动行（不是建了个空文件充数）",
  );
  const listed = await api(base, "GET", "/api/projects");
  const regFile = path.join(dataHome, "registry.json");
  const regRaw = fs.existsSync(regFile) ? read(regFile) : "";
  ok(
    listed.status === 200 && fs.existsSync(regFile) && (JSON.parse(regRaw) as Json).version === 1,
    `④ 首次读注册表自动建 registry.json（version=1，projects=[]）且不报错：GET /api/projects → ${listed.status}`,
  );

  // ── ③ 安装目录 / 真实用户数据目录逐文件哈希未变（红线） ──
  const installDiffs = diffSnapshot(installBefore, snapshot(installLike));
  ok(
    installDiffs.length === 0,
    `③ 安装目录（模拟）跑完逐文件哈希未变：${path.relative(tmpBase, installLike)} 共 ${installBefore.size} 个文件，差异 ${installDiffs.join("、") || "无"}`,
  );
  for (const h of userHomes) {
    const d = diffSnapshot(userBefore.get(h)!, snapshot(h));
    ok(d.length === 0, `③ 真实用户数据目录 ${h} 未被污染（${userBefore.get(h)!.size} 个文件，差异 ${d.join("、") || "无"}）`);
  }

  // ── 夹具项目 + PTY（DoD②） ──
  addProject({ id: "u2-proj", name: "U2 验证项目", path: projDir, kind: "backend" }, dataHome);
  const created = await api(base, "POST", "/api/projects/u2-proj/terminal", { cols: 100, rows: 30 });
  const session = created.body.session as Json;
  ok(
    created.status === 200 && typeof session?.id === "string" && session.pid > 0,
    `⑤ 包内后端建 PTY 会话 → ${created.status}，sid=${String(session?.id)} pid=${String(session?.pid)}`,
  );
  ok(
    path.resolve(String(session?.cwd)) === path.resolve(projDir),
    `⑤ 会话 cwd 锁项目根（不是全局数据目录、不是安装目录）：${String(session?.cwd)}`,
  );
  const sse = await TerminalSse.connect(base, String(session.id));
  await api(base, "POST", `/api/terminal/${session.id}/in`, { data: "cd\r" });
  const cdOut = await sse.waitFor((t) => t.toLowerCase().includes(projDir.toLowerCase()));
  console.log(`[verify] ⑤ 终端真实输出摘录：${JSON.stringify(cdOut.slice(-160))}`);
  ok(cdOut.toLowerCase().includes(projDir.toLowerCase()), `⑤ 终端里敲 cd → 回显输出含项目根路径（DoD② 包内 PTY 真跑通）`);
  await api(base, "POST", `/api/terminal/${session.id}/in`, { data: "ver\r" });
  const verOut = await sse.waitFor((t) => /Windows|Microsoft/i.test(t));
  const verLine = verOut.split(/\r?\n/).find((l) => /Windows|Microsoft/i.test(l)) ?? "";
  ok(verLine.trim() !== "", `⑤ 终端里敲 ver → 系统版本真实输出：${JSON.stringify(verLine.trim())}`);
  const closed = await api(base, "DELETE", `/api/terminal/${session.id}?project_id=u2-proj`);
  ok(closed.status === 200 && closed.body.removed === true, `⑧ 关闭会话 → removed=${String(closed.body.removed)} exitCode=${String(closed.body.exit?.exitCode)}`);

  // ── ⑥ 原生件齐全：tree-sitter 真解析 + chokidar 真监听 ──
  const parsed = await api(base, "POST", "/api/projects/u2-proj/arch/parse", {});
  ok(
    parsed.status === 200 && Number(parsed.body.result?.module_count) > 0,
    `⑥ 包内 tree-sitter 真解析源码：module_count=${String(parsed.body.result?.module_count)}（原生 prebuild 拷全了）`,
  );
  const watched = await api(base, "POST", "/api/projects/u2-proj/watch", {});
  ok(watched.status === 200 && watched.body.watch?.watching === true, `⑥ 包内 chokidar 真挂上文件监听：${JSON.stringify(watched.body.watch)}`);
  // 等 chokidar 初始扫描 ready 再动手：ready 之前的改动算"初始扫描"、按 H1 口径不落流水（不是 bug 是设计）
  let ready = false;
  for (let i = 0; i < 25 && !ready; i++) {
    const w = await api(base, "GET", "/api/watch");
    ready = ((w.body.details ?? []) as Json[]).some((d) => d.id === "u2-proj" && d.ready === true);
    if (!ready) await sleep(200);
  }
  ok(ready, "⑥ chokidar 初始扫描就绪（ready=true，之后的改动才记流水）");
  fs.writeFileSync(path.join(projDir, "u2-watch.txt"), "u2\n", "utf8");
  let changeHit = false;
  for (let i = 0; i < 40 && !changeHit; i++) {
    const ch = await api(base, "GET", "/api/projects/u2-proj/changes?limit=5");
    changeHit = JSON.stringify(ch.body.changes ?? []).includes("u2-watch.txt");
    if (!changeHit) await sleep(250);
  }
  ok(changeHit, "⑥ 监听真落了变更流水（u2-watch.txt 出现在 .工作台/changes.jsonl）");
  await api(base, "DELETE", "/api/projects/u2-proj/watch");

  // ── ⑦ MCP 的包内入口被真客户端连上（DoD③） ──
  const client = new Client({ name: "u2-verify-client", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(installLike, "server", "mcp.js")],
    env: { ...process.env, TATAI_HOME: dataHome },
  });
  await client.connect(transport);
  const tools = await client.listTools();
  const toolNames = tools.tools.map((t) => t.name);
  ok(
    tools.tools.length === MCP_TOOL_COUNT,
    `⑦ 包内 mcp.js 被外部客户端经 stdio 连上：listTools → ${tools.tools.length} 个工具 ${toolNames.join("/")}`,
  );
  const missingTools = MCP_TOOL_NAMES.filter((n) => !toolNames.includes(n));
  const extraTools = toolNames.filter((n) => !(MCP_TOOL_NAMES as readonly string[]).includes(n));
  ok(
    missingTools.length === 0 && extraTools.length === 0,
    `⑦ 包内工具逐个点名对账（${MCP_TOOL_NAMES.length} 个：一期 8 + get_arch/ask_flash + V06-10 三件套 + C-015 三件套 + V07-02 rebind_task + V07-04 doctor + V09-19 get_project_graphs + V09-23 同步域三接口 register_sync_contract/scan_sync_evidence/read_sync_status）——缺 ${missingTools.join("/") || "无"}，多 ${extraTools.join("/") || "无"}`,
  );
  const listed2 = await client.callTool({ name: "list_projects", arguments: {} });
  const projectsText = (listed2.content as { type: string; text?: string }[])[0]?.text ?? "";
  ok(
    projectsText.includes("u2-proj") && projectsText.includes(projDir.replace(/\\/g, "\\\\")),
    `⑦ MCP 工具真跑通：list_projects 返回夹具项目 + 其绝对路径（读的是 TATAI_HOME 下那份注册表）`,
  );
  const reported = await client.callTool({
    name: "report_task_status",
    arguments: { project_id: "u2-proj", task_id: "u2-mcp", title: "U2 MCP 包内验证", module_id: "m", status: "done" },
  });
  const tasksFile = path.join(projDir, ".工作台", "tasks.json");
  ok(
    !reported.isError &&
      fs.existsSync(tasksFile) &&
      read(tasksFile).includes("u2-mcp") &&
      !fs.existsSync(path.join(installLike, ".工作台")),
    `⑦ MCP 写口落点正确：report_task_status → ${path.relative(projDir, tasksFile)}（安装目录下没有 .工作台）`,
  );
  await client.close();

  // ── ⑧ 回收：杀整棵树，端口不再响应、无残留 node ──
  killTree(serverPid);
  server = null;
  await sleep(1500);
  const spawned = [...nodePids()].filter((p) => !beforeNode.has(p));
  ok(spawned.length === 0, `⑧ 回收：taskkill /PID ${serverPid} /T /F 后新增 node 进程残留 ${spawned.join("/") || "无"}`);
  ok(!(await portListening(port)), `⑧ 回收后端口 ${port} 不再响应（服务真死了）`);
} finally {
  if (server && server.exitCode === null) killTree(server.pid!);
}

// ═════════════ ⑨ 真桌面壳：exe 自己拉起随包后端 ═════════════

console.log("\n[verify] ── ⑨ 真桌面壳：target/release/tatai.exe 跑起来后自己拉起包内后端");

if (!fs.existsSync(RELEASE_EXE)) {
  console.log(
    "[verify] ⑨ SKIP：src-tauri/target/release/tatai.exe 不存在（没跑过 pnpm tauri:build）。" +
      "\n          手动命令：pnpm tauri:build && TATAI_HOME=<数据目录> ./src-tauri/target/release/tatai.exe" +
      "\n          说明：本项 SKIP 时不许把 U2 记成 done，除非另有真机运行证据（窗口 + 终端输出 + MCP 工具列表）。",
  );
} else {
  const exeResDir = path.join(path.dirname(RELEASE_EXE), "server");
  const resBeside = fs.existsSync(path.join(exeResDir, "index.js"));
  ok(resBeside, `⑨ tauri build 把随包资源复制到了 exe 旁边：${path.relative(REPO_ROOT, exeResDir)}`);
  // 壳内前端基址写死 8787（src/ui/tauri-env.ts）：8787 空着就用它，让窗口里界面也是活的
  const shellPort = (await portListening(8787)) ? await freePort() : 8787;
  if (shellPort !== 8787) console.log(`[verify] ⑨ 8787 被占用 → 换动态端口 ${shellPort}（窗口里界面会连不上后端，只验壳拉进程这一环）`);
  const shellHome = path.join(tmpBase, "shell-home");
  const releaseDir = path.dirname(RELEASE_EXE);
  const releaseBefore = snapshotTop(releaseDir);
  const exeSideServerBefore = snapshot(path.join(releaseDir, "server"));
  let shellLog = "";
  const beforeShell = nodePids();
  const shell = spawn(RELEASE_EXE, [], {
    env: { ...process.env, TATAI_HOME: shellHome, TATAI_PORT: String(shellPort) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  shell.stdout?.on("data", (d: Buffer) => (shellLog += d.toString()));
  shell.stderr?.on("data", (d: Buffer) => (shellLog += d.toString()));
  try {
    const shellHealth = await waitHealth(shellPort);
    ok(shellHealth?.status === 200, `⑨ 真桌面壳（release）自己拉起了包内后端：GET http://127.0.0.1:${shellPort}/health → ${shellHealth?.status ?? "连不上"}`);
    ok(
      JSON.parse(shellHealth?.body ?? "{}").data_dir === shellHome,
      `⑨ 壳拉起的后端读的是壳传下去的 TATAI_HOME：${shellHome}`,
    );
    const shellChildLog = shellLog.trim().split(/\r?\n/).filter((l) => l.includes("[tatai"));
    console.log(`[verify] ⑨ 壳的 stdout（含它转发过来的后端日志）：\n${shellChildLog.slice(0, 8).map((l) => `        ${l}`).join("\n")}`);
    ok(
      /打包态复用系统 node：v\d/.test(shellLog),
      "⑨ 壳的打包分支真走了「探 node 版本 → 跑包内入口」这条路（不是 dev 分支）",
    );
    ok(fs.existsSync(path.join(shellHome, "logs", LOG_FILE_NAME)), `⑨ 壳跑起来的后端也把日志写进 TATAI_HOME：${path.join(shellHome, "logs", LOG_FILE_NAME)}`);
    await sleep(800);
    const releaseDiffs = diffSnapshot(releaseBefore, snapshotTop(releaseDir));
    ok(
      releaseDiffs.length === 0,
      `⑨ release 目录顶层跑完无新增/改动（配置数据没落安装目录）：${releaseDiffs.join("、") || "无"}`,
    );
    const exeSideDiffs = diffSnapshot(exeSideServerBefore, snapshot(path.join(releaseDir, "server")));
    ok(
      exeSideDiffs.length === 0,
      `⑨ 随包的 server/ 目录 ${exeSideServerBefore.size} 个文件逐字节未变（运行时不在自己的安装目录里写东西）`,
    );
    ok([...nodePids()].filter((p) => !beforeShell.has(p)).length > 0, "⑨ 壳真起了子进程（后端 node 进程存在）");
  } finally {
    killTree(shell.pid!);
    await sleep(1500);
    const survived = [...nodePids()].filter((p) => !beforeShell.has(p));
    ok(survived.length === 0, `⑨ 壳退出回收整棵树：残留 node ${survived.join("/") || "无"}`);
  }
}

// ───────────────────────── 收尾 ─────────────────────────

fs.rmSync(tmpBase, { recursive: true, force: true });

console.log(
  "\n[verify] 手动那半边（GUI，本脚本不跑）：`TATAI_HOME=D:\\.tatai .\\src-tauri\\target\\release\\tatai.exe`" +
    " → 窗口起来、终端 Tab 里敲命令、MCP 客户端连 `<安装目录>\\server\\mcp.js`；结果记 PROGRESS.md。",
);
console.log(`\n[verify] 完成：${process.exitCode === 1 ? "有 FAIL，见上" : "全部 PASS"}`);
