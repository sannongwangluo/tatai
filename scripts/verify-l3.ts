// L3 验证脚本（用 tsx 跑）：`templates/.工作台.example/` 空模板（PLAN.md 发布 3 / DESIGN.md §8.3）。
// 用法：pnpm verify:l3
//
// 覆盖点（对 L3 卡 DoD 逐条）：
//   ① 目录结构与 `DESIGN.md` §2.2 逐项对齐：贴树形输出 + 逐项打勾（含 A2/F4/N2/B3/A5/C2/E3 各卡新增文件）。
//   ② 零真实数据：模板全部文本文件按「私人数据形态」扫描——本机用户名 / 盘符与 UNC 路径 / 真实项目名 /
//      密钥与长随机串形态，断言命中 0（打印命中明细，便于定位）。
//   ③ 冷启动接入：模板复制到**全新临时目录** → 真起服务（动态端口 + 探活）→ `POST /api/projects` 接入
//      → 读设计书 / 读进度 / 写任务 / 真起监听看变更流水落盘 → 跑完删临时项目与夹具。
//   ④ 模板 schema ↔ 代码 schema 同步（漂移即红）：模板里每个文件都拿**代码自己的读取器 / 校验函数**读一遍
//      （`readProgress` / `readTasks` / `readGateLines` / `parseChangeLine` / `readModules` / `readNames` /
//      `readLayoutByRoot` / `readFoldFileByRoot` / `readSession` / `queryTerminalHistory` / 对账读取）；
//      生成类文件的**键集**与本卡真跑一次的产物对照，且每个键都必须在 `templates/README.md` 的字段口径里有记载
//      （代码加了字段而文档没跟上，同样报红）。
//
// 端口策略（与 verify-f4 / verify-u2 同口径）：不碰任何既有监听——bind 0 取空闲端口 + 起前探活 + 起后盯早退。
// 隐私（AGENTS.md §5/§6）：全程只用临时数据目录与虚构夹具，不读真实注册表、不碰真实项目、不贴真实路径；
// 临时目录根可用 `TATAI_L3_TMPDIR` 指定（审计流水里不想出现本机用户名时指到中立路径）。
import { spawn, execSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LAYOUT_MIGRATION_MODE, readLayoutByRoot, savePositionsByRoot } from "../src/arch/layoutStore";
import { readFoldFileByRoot, saveFoldByRoot } from "../src/arch/foldStore";
import { nameModules, readNames } from "../src/arch/name";
import { parseDirectory, parseProject, readModules } from "../src/arch/parse";
import { RECONCILE_SIGNAL_NOTE, readLastReconcile, reconcileProject } from "../src/arch/reconcile";
import { addProject } from "../src/server/registry";
import { privateTokens } from "./lib/fixtures";
import { listSessions, readSession } from "../src/server/chat";
import { appendTerminalHistoryLine, queryTerminalHistory } from "../src/server/terminalHistory";
import { nowIso } from "../src/server/time";
import { parseChangeLine, readChanges } from "../src/server/watcher";
import {
  addModule,
  addTask,
  GATE_STEPS,
  initWorkstation,
  readGateLines,
  readProgress,
  readTasks,
  recordGateTransition,
} from "../src/server/workstation";
import { appendDesign, appendDiscuss } from "../src/server/workstation";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE_DIR = path.join(REPO_ROOT, "templates", ".工作台.example");
const TEMPLATE_README = path.join(REPO_ROOT, "templates", "README.md");
const TMP_BASE = fs.mkdtempSync(
  path.join(process.env.TATAI_L3_TMPDIR ?? os.tmpdir(), "tatai-l3-verify-"),
);
const DATA_DIR = path.join(TMP_BASE, "home");
/** 冷启动夹具（DoD③：复制模板 → HTTP 接入 → 真跑一遍） */
const COLD_ROOT = path.join(TMP_BASE, "project-cold");
/** schema 夹具（DoD④：模板文件过代码校验，写操作与冷启动夹具分开，互不污染） */
const SCHEMA_ROOT = path.join(TMP_BASE, "project-schema");
const COLD_ID = "l3-cold-start";
const SCHEMA_ID = "l3-schema";

const ok = (cond: boolean, label: string) => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (!cond) process.exitCode = 1;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const readText = (p: string) => fs.readFileSync(p, "utf8");
/**
 * 行尾归一（只用于「模板文件 ↔ 代码产物」的逐字节比对）：仓库 blob 里存的是 LF，但
 * `core.autocrlf=true` 的克隆会把模板检出成 CRLF（本机实测：`git clone` 后 `design.md` 末尾是 `\r\n`），
 * 而代码自己写文件一律用 LF——不归一会让**全新 clone** 里的断言假红。归一只动行尾，不动任何字符，
 * schema 层面两者等价（所有读取器按 `/\r?\n/` 切行，JSON.parse 也吃 CRLF）。
 */
const lf = (text: string) => text.replace(/\r\n/g, "\n");


// ───────────────────────── ① 目录结构 ↔ DESIGN.md §2.2 ─────────────────────────

/** §2.2 的树 + 各卡新增文件；`design` 列写明出处，逐项核对时就照这列对 */
const STRUCTURE: { rel: string; kind: "file" | "dir"; design: string }[] = [
  { rel: "design.md", kind: "file", design: "§2.2 设计书（唯一事实源，§3.5 只读展示）" },
  { rel: "design.discuss.md", kind: "file", design: "§2.2 待议记录（§3.5 提疑权）" },
  { rel: "progress.json", kind: "file", design: "§2.2 / §2.3.2 Gate 状态 + 模块四色" },
  { rel: "gate.jsonl", kind: "file", design: "§2.2 / §2.3.3 过关打回流水" },
  { rel: "tasks.json", kind: "file", design: "§2.2 / §2.3.4 任务级状态" },
  { rel: "chat", kind: "dir", design: "§2.2 聊天目录" },
  { rel: "chat/example-session.jsonl", kind: "file", design: "§2.2 / §2.3.6 chat/<session>.jsonl（C2）" },
  { rel: "changes.jsonl", kind: "file", design: "§2.2 / §2.3.5 变更流水（H1 监听产出）" },
  { rel: "arch", kind: "dir", design: "§2.2 架构目录" },
  { rel: "arch/modules.json", kind: "file", design: "§2.2 / A1 顶层模块骨架" },
  { rel: "arch/layout.json", kind: "file", design: "§2.2 / A4 + F4 布局记忆（v2 按视图分键）" },
  { rel: "arch/names.json", kind: "file", design: "A2 起名缓存（§2.2 arch/ 内）" },
  { rel: "arch/mindmap-fold.json", kind: "file", design: "N2 导图折叠记忆" },
  { rel: "arch/reconcile-request.json", kind: "file", design: "B3 对账钩子（A5 消费）" },
  { rel: "arch/reconcile-last.json", kind: "file", design: "A5 对账结果" },
  { rel: "logs", kind: "dir", design: "§2.2 运行日志位" },
  { rel: "logs/terminal-history.jsonl", kind: "file", design: "E3 终端命令历史（logs/ 位）" },
];

/** 模板里**不该**出现的文件（避免把瞬时状态 / 真实运行产物当结构预置） */
const NOT_IN_TEMPLATE = [
  "design.draft.md",
  "chat/19700101-000000-a1b2c3d4.jsonl",
  "logs/backend.log",
];

function printTree(dir: string, prefix = ""): void {
  const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  entries.forEach((e, i) => {
    const last = i === entries.length - 1;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      console.log(`${prefix}${last ? "└── " : "├── "}${e.name}/`);
      printTree(abs, `${prefix}${last ? "    " : "│   "}`);
    } else {
      console.log(`${prefix}${last ? "└── " : "├── "}${e.name}  (${fs.statSync(abs).size} B)`);
    }
  });
}

/** 递归收集模板内全部文本文件（相对路径 + 内容） */
function templateFiles(): { rel: string; text: string }[] {
  const out: { rel: string; text: string }[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.isFile()) {
        out.push({ rel: path.relative(TEMPLATE_DIR, abs).split(path.sep).join("/"), text: readText(abs) });
      }
    }
  };
  walk(TEMPLATE_DIR);
  return out;
}

function copyDir(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

console.log("=".repeat(72));
console.log("① 模板目录结构 ↔ DESIGN.md §2.2 逐项核对");
console.log("=".repeat(72));
console.log(`templates/.工作台.example/  ${TEMPLATE_DIR}`);
printTree(TEMPLATE_DIR);
console.log("");
for (const item of STRUCTURE) {
  const abs = path.join(TEMPLATE_DIR, item.rel);
  const exists = item.kind === "dir" ? fs.existsSync(abs) && fs.statSync(abs).isDirectory() : fs.existsSync(abs) && fs.statSync(abs).isFile();
  ok(exists, `① 逐项 [${exists ? "√" : "×"}] ${item.rel}${item.kind === "dir" ? "/" : ""} ← ${item.design}`);
}
const templateRelSet = new Set(templateFiles().map((f) => f.rel));
for (const rel of NOT_IN_TEMPLATE) {
  ok(!templateRelSet.has(rel), `① 不该预置的文件未出现：${rel}（瞬时状态 / 真实运行产物不预置）`);
}
ok(
  fs.existsSync(TEMPLATE_README),
  "① 字段口径文档在场：templates/README.md（JSON 没有注释语法，字段口径统一记在这里）",
);

/**
 * ① 模板树逐条标注（V09-05 检查项⑤）：`templates/README.md` 的目录树里**每个 `.工作台/` 一级条目**，
 * 要么在模板里真的存在，要么该行**显式标注**「`[不预置]`」——两个都不满足就报红。
 * 意图：文档写了一个文件、模板却没有、也没说明它会由程序自建 ⇒ 读的人会以为"铺了模板就有它"。
 * 判据不放宽：不是"树里至少有一个条目对得上"，而是**逐条**要么存在、要么带标注；反过来，
 * 真在模板里的条目也不许同时标「不预置」（自相矛盾同样是红）。
 */
function firstLevelTreeEntries(): { name: string; marked: boolean; inFence: boolean }[] {
  const out: { name: string; marked: boolean; inFence: boolean }[] = [];
  let fence = false;
  for (const line of readText(TEMPLATE_README).split(/\r?\n/)) {
    if (/^```/.test(line)) {
      fence = !fence;
      continue;
    }
    if (!fence) continue;
    const m = /^│   [├└]── ([^\s]+)/.exec(line);
    if (m) out.push({ name: m[1], marked: line.includes("[不预置]"), inFence: true });
  }
  return out;
}

{
  const entries = firstLevelTreeEntries();
  ok(entries.length >= 15, `① 模板树一级条目可解析（templates/README.md 树里 ${entries.length} 条）`);
  const unannotated = entries.filter((e) => !fs.existsSync(path.join(TEMPLATE_DIR, e.name)) && !e.marked);
  ok(
    unannotated.length === 0,
    `① 模板树逐条标注：每个一级条目要么在模板里存在、要么写明「[不预置]」（不满足：${
      unannotated.map((e) => e.name).join("、") || "无"
    }）`,
  );
  const contradictory = entries.filter((e) => fs.existsSync(path.join(TEMPLATE_DIR, e.name)) && e.marked);
  ok(
    contradictory.length === 0,
    `① 标了「[不预置]」的条目不得同时又真在模板里（自相矛盾：${contradictory.map((e) => e.name).join("、") || "无"}）`,
  );
  ok(
    entries.some((e) => e.marked) && entries.some((e) => !e.marked),
    "① 模板树同时存在「预置」与「不预置」两类条目（两类标注都在，不是一边倒）",
  );
}

// ───────────────────────── ② 零真实数据自查 ─────────────────────────

// 关键词家族（DoD②）：
//   · 本机用户名——运行期从操作系统取，脚本里不落任何真名；
//   · 真实项目名——**不写死任何真名**：走 `privateTokens()`（显式设 TATAI_HOME 时从注册表现取项目名/id，
//     或用 TATAI_PRIVATE_TOKENS 追加）；两者都没给 → 这组探针缺席，下面如实打印"这组没跑"；
//   · 密钥 / token 形态——前缀类（sk- / ghp_ / AKIA / AIza / xox- / Bearer）+ 长随机串（32 位以上混合串）；
//   · 机器路径——盘符路径、UNC 路径、Unix home 路径。
const USER_NAME = os.userInfo().username;
const PROJECT_TOKENS = privateTokens();
const PRIVATE_PATTERNS: { name: string; re: RegExp }[] = [
  { name: `本机用户名（${USER_NAME.length} 字符，不回显）`, re: new RegExp(escapeRe(USER_NAME)) },
  ...PROJECT_TOKENS.map((t) => ({
    name: `真实项目名 / 自定义探针（${t.length} 字符，不回显）`,
    re: new RegExp(escapeRe(t)),
  })),
  { name: "盘符路径", re: /[A-Za-z]:[\\/]/ },
  { name: "UNC 路径", re: /\\\\[A-Za-z0-9._-]+\\/ },
  { name: "Unix home 路径", re: /\/(Users|home)\/[A-Za-z0-9._-]+/ },
  { name: "sk- 形态密钥", re: /(^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{8,}/ },
  { name: "云厂商 / GitHub 密钥前缀", re: /\b(gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{12,}|AIza[0-9A-Za-z_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})/ },
  { name: "Bearer 凭据", re: /Bearer\s+[A-Za-z0-9._-]{10,}/ },
  { name: "token 形态长随机串（32+ 位字母数字）", re: /\b(?=[A-Za-z0-9_-]{32,}\b)(?=[^\s]*[A-Za-z])(?=[^\s]*[0-9])[A-Za-z0-9_-]{32,}\b/ },
];

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 扫描一批文本，返回命中明细（文件:行号:关键词） */
function scanPrivate(files: { rel: string; text: string }[]): string[] {
  const hits: string[] = [];
  for (const f of files) {
    f.text.split(/\r?\n/).forEach((line, i) => {
      for (const p of PRIVATE_PATTERNS) {
        if (p.re.test(line)) hits.push(`${f.rel}:${i + 1} 命中「${p.name}」`);
      }
    });
  }
  return hits;
}

console.log("");
console.log("=".repeat(72));
console.log("② 零真实数据自查（模板全部文本文件）");
console.log("=".repeat(72));
const TPL_FILES = templateFiles();
const HITS = scanPrivate(TPL_FILES);
console.log(`[verify] 扫描文件 ${TPL_FILES.length} 个，关键词家族 ${PRIVATE_PATTERNS.length} 组：`);
for (const p of PRIVATE_PATTERNS) console.log(`[verify]   - ${p.name}`);
if (PROJECT_TOKENS.length === 0) {
  console.log(
    "[verify]   ⚠ 真实项目名这组探针这轮没跑（没设 TATAI_HOME / TATAI_PRIVATE_TOKENS）——" +
      "本机复现完整自查：TATAI_PRIVATE_TOKENS=<项目名,…> 或 TATAI_HOME=<数据目录> pnpm verify:l3",
  );
}
console.log(`[verify] 命中明细（应为空）：${HITS.length === 0 ? "（无）" : ""}`);
for (const h of HITS) console.log(`[verify]   ! ${h}`);
ok(HITS.length === 0, "② 模板零真实数据：私人数据形态命中 0");

// ───────────────────────── 夹具准备 ─────────────────────────

/** 给夹具项目铺一点虚构源码：让 A1 静态解析真出模块（模板里的空 modules.json 应被整份覆盖） */
function seedSource(root: string): void {
  const files: Record<string, string> = {
    "src/kernel/core.ts": 'import { util } from "./util";\nexport const core = util;\n',
    "src/kernel/util.ts": "export const util = 1;\n",
    "src/web/app.tsx": 'import { core } from "../kernel/core";\nexport const app = core;\n',
    "src/web/page.tsx": "export const page = 2;\n",
    "docs/guide.md": "# 夹具说明\n",
  };
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(root, rel.split("/").join(path.sep));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text, "utf8");
  }
  fs.writeFileSync(path.join(root, ".gitignore"), ".工作台/\n", "utf8");
}

/** 把模板复制成夹具项目的 `.工作台/`（DoD③ 的「复制到全新临时目录」就是这一步） */
function makeFixture(root: string): void {
  fs.mkdirSync(root, { recursive: true });
  copyDir(TEMPLATE_DIR, path.join(root, ".工作台"));
  seedSource(root);
}

fs.mkdirSync(DATA_DIR, { recursive: true });
makeFixture(COLD_ROOT);
makeFixture(SCHEMA_ROOT);
fs.writeFileSync(
  path.join(DATA_DIR, "registry.json"),
  JSON.stringify({ version: 1, projects: [] }, null, 2) + "\n",
  "utf8",
);
// 进程内模块级函数（terminalHistory 这类不吃 dataDir 的）也走同一个临时数据目录
process.env.TATAI_HOME = DATA_DIR;
console.log(`\n[verify] 夹具：${path.relative(TMP_BASE, DATA_DIR)}（TATAI_HOME）/ ${path.basename(COLD_ROOT)} / ${path.basename(SCHEMA_ROOT)}`);

// ───────────────────────── 端口 / 服务 ─────────────────────────

function portListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: "127.0.0.1" });
    const done = (busy: boolean) => {
      sock.destroy();
      resolve(busy);
    };
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
    sock.setTimeout(800, () => done(false));
  });
}

async function pickFreePort(): Promise<number> {
  for (let i = 0; i < 5; i++) {
    const port = await new Promise<number>((resolve, reject) => {
      const srv = net.createServer();
      srv.once("error", reject);
      srv.listen(0, "127.0.0.1", () => {
        const addr = srv.address();
        const p = typeof addr === "object" && addr ? addr.port : 0;
        srv.close(() => resolve(p));
      });
    });
    if (port > 0 && !(await portListening(port))) return port;
  }
  throw new Error("分配不到空闲端口（连续 5 次都被抢）");
}

/** 收尾要杀的端口（退出回调据此区分「意外早退」与「正常收尾」） */
const intentionalStop = new Set<number>();
/** 服务子进程与端口放模块级：验证中途抛错时 finally 也能把进程树收干净 */
let serverChild: ChildProcess | null = null;
let serverPort = 0;

function killTree(child: ChildProcess, port?: number): void {
  if (port) intentionalStop.add(port);
  if (!child.pid) return;
  if (process.platform === "win32") {
    try {
      execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore" });
    } catch {
      // 已经退了
    }
  } else {
    child.kill("SIGTERM");
  }
}

async function main(): Promise<void> {
  const backendPort = await pickFreePort();
  const base = `http://127.0.0.1:${backendPort}`;
  serverPort = backendPort;
  const child = spawn(
    process.execPath,
    ["--import", "tsx", path.join("src", "server", "index.ts")],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, TATAI_HOME: DATA_DIR, TATAI_PORT: String(backendPort) },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout?.on("data", (d: Buffer) => process.stdout.write(`[server] ${d}`));
  child.stderr?.on("data", (d: Buffer) => process.stderr.write(`[server] ${d}`));
  child.once("exit", (code) => {
    if (!intentionalStop.has(backendPort)) {
      console.error(`[verify] 后端意外退出：code=${code}（端口 ${backendPort} 被抢？）`);
    }
  });
  serverChild = child;

  const alive = () => child.exitCode === null;
  const deadline = Date.now() + 60_000;
  let up = false;
  while (Date.now() < deadline && !up) {
    if (!alive()) throw new Error(`后端起不来：进程已退出（exitCode=${child.exitCode}）`);
    try {
      const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2500) });
      up = r.status < 500;
    } catch {
      await sleep(250);
    }
  }
  ok(up, `③ 探活：后端在动态端口 ${backendPort} 就绪（/health）`);
  if (!up) throw new Error("后端未就绪，后续验证无法进行");

  const api = async (p: string, init?: RequestInit): Promise<{ status: number; body: any }> => {
    const r = await fetch(`${base}${p}`, init);
    const text = await r.text();
    let body: any = text;
    try {
      body = JSON.parse(text);
    } catch {
      // 非 JSON 响应（如 ndjson）原样带回
    }
    return { status: r.status, body };
  };
  const postJson = (p: string, payload: unknown) =>
    api(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });

  // ───────────────────────── ③ 冷启动接入 ─────────────────────────
  console.log("");
  console.log("=".repeat(72));
  console.log("③ 冷启动接入：模板复制到全新目录 → POST /api/projects → 真跑一遍");
  console.log("=".repeat(72));
  const before = await api("/api/projects");
  ok(Array.isArray(before.body) && before.body.length === 0, "③ 接入前注册表为空（干净夹具，不是本机真实注册表）");

  const onboard = await postJson("/api/projects", { path: COLD_ROOT, id: COLD_ID, name: "L3 冷启动夹具" });
  ok(
    onboard.status === 200 && onboard.body?.ok === true && onboard.body?.already_registered === false,
    `③ POST /api/projects 接入模板副本成功（id=${COLD_ID}）`,
  );
  ok(
    onboard.body?.gitignore?.has_workbench_line === true,
    "③ 接入时识别到夹具 .gitignore 已有 `.工作台/` 一行（§8.2 提示不误报）",
  );
  console.log(`[verify] 接入回执：${JSON.stringify({ ok: onboard.body?.ok, kind: onboard.body?.detected?.kind, gitignore: onboard.body?.gitignore?.has_workbench_line })}`);

  // ③-1 读设计书：读到的是模板给的标题头（逐字节与模板文件一致）
  const design = await api(`/api/projects/${COLD_ID}/design`);
  const tplDesign = readText(path.join(TEMPLATE_DIR, "design.md"));
  ok(
    design.status === 200 && design.body?.design?.exists === true && design.body?.design?.content === tplDesign,
    "③ 读设计书：GET /design 返回模板标题头（与模板文件逐字节一致，只读）",
  );

  // ③-2 读进度：模板的七步 pending 原样读出，不是"缺文件自动初始化"
  const progress = await api(`/api/projects/${COLD_ID}/progress`);
  ok(
    progress.status === 200 &&
      progress.body?.progress?.gate?.current_step === "kickoff" &&
      progress.body?.progress?.gate?.history?.length === 7,
    "③ 读进度：GET /progress → current_step=kickoff，七步 history（模板空态可读）",
  );

  // ③-3 写任务：真实走 HTTP 写口 + 顺带断言落盘结构与模板一致
  const taskRes = await postJson(`/api/projects/${COLD_ID}/tasks`, {
    id: "t-l3-001",
    title: "冷启动夹具任务",
    module_id: "m-l3",
    reporter: "kimi-code",
  });
  ok(
    taskRes.status === 200 && taskRes.body?.task?.status === "todo" && taskRes.body?.task?.reporter === "kimi-code",
    "③ 写任务：POST /tasks → 200，缺省状态 todo（模板 tasks.json 空态写进第一条）",
  );
  const coldTasks = JSON.parse(readText(path.join(COLD_ROOT, ".工作台", "tasks.json")));
  ok(
    coldTasks.version === 1 &&
      coldTasks.tasks.length === 1 &&
      Object.keys(coldTasks).join(",") === Object.keys(JSON.parse(readText(path.join(TEMPLATE_DIR, "tasks.json")))).join(","),
    "③ 写任务后 tasks.json 顶层键集 == 模板 keys（模板结构被真写口接受，未变形）",
  );

  // ③-4 架构：模板里的空 modules.json 被 A1 静态解析整份覆盖，架构图真出节点
  const parsed = await postJson(`/api/projects/${COLD_ID}/arch/parse`, {});
  ok(parsed.status === 200, "③ 架构：POST /arch/parse 真解析夹具源码 → 200（模板的 arch/ 被程序接管）");
  const render = await api(`/api/projects/${COLD_ID}/arch/render`);
  const renderExists = render.body?.render?.exists === true;
  const nodeCount = render.body?.render?.graph?.nodes?.length ?? 0;
  ok(
    render.status === 200 && renderExists && nodeCount > 0,
    `③ 架构：GET /arch/render → exists=${String(renderExists)}，${nodeCount} 个模块节点（模板空 modules.json 已被解析产物替换）`,
  );

  // ③-5 起监听：真监听夹具目录、真改文件、真看 changes.jsonl 落一行（模板的变更流水长在第一行上）
  const watch = await postJson(`/api/projects/${COLD_ID}/watch`, {});
  ok(watch.status === 200 && watch.body?.watch?.watching === true, "③ 起监听：POST /watch → 200，监听中");
  // 等 chokidar 初始扫描就绪再改文件：ready 之前的事件只喂 size 表、不写流水（H1 口径），
  // 过早改动会被当成"存量文件"而漏记——验证要等 ready，不能靠 sleep 碰运气
  let watchReady = false;
  for (let i = 0; i < 40 && !watchReady; i++) {
    await sleep(250);
    const w = await api("/api/watch");
    watchReady = w.body?.details?.[0]?.ready === true;
  }
  ok(watchReady, "③ 起监听：GET /watch 报告初始扫描就绪（ready=true，随后才动的文件才算变更）");
  const probe = path.join(COLD_ROOT, "docs", "guide.md");
  fs.appendFileSync(probe, "\n（冷启动探针）\n", "utf8");
  let coldChanges: any[] = [];
  for (let i = 0; i < 40 && coldChanges.length === 0; i++) {
    await sleep(250);
    coldChanges = readChanges(COLD_ID, undefined, DATA_DIR);
  }
  ok(coldChanges.length > 0, `③ 起监听：改夹具文件后 changes.jsonl 真落 ${coldChanges.length} 行`);
  if (coldChanges.length > 0) {
    const line = parseChangeLine(JSON.stringify(coldChanges[0]), "冷启动 changes.jsonl 首行");
    ok(
      typeof line.ts === "string" && line.path === "docs/guide.md" && line.action === "modify",
      `③ 变更行过 §2.3.5 校验：path=${line.path} action=${line.action} size_delta=${String(line.size_delta)}`,
    );
    const httpChanges = await api(`/api/projects/${COLD_ID}/changes?limit=5`);
    ok(
      httpChanges.status === 200 && Array.isArray(httpChanges.body?.changes) && httpChanges.body.changes.length > 0,
      "③ 变更流水 HTTP 可读（GET /changes → 非空）",
    );
    // 键集 ↔ 文档口径（代码加了字段而 README 没跟上 → 红）
    assertKeysInDoc(Object.keys(line), "changes.jsonl 行");
  }
  await api(`/api/projects/${COLD_ID}/watch`, { method: "DELETE" });
  ok(
    (await api("/api/watch")).body?.watching?.length === 0,
    "③ 收尾：DELETE /watch 后无监听中的项目（本脚本自起的监听自己关）",
  );

  // ───────────────────────── ④ 模板 schema ↔ 代码 schema ─────────────────────────
  console.log("");
  console.log("=".repeat(72));
  console.log("④ 模板 schema ↔ 代码 schema 同步断言（漂移即红）");
  console.log("=".repeat(72));
  addProject({ id: SCHEMA_ID, name: "L3 schema 夹具", path: SCHEMA_ROOT, kind: "backend" }, DATA_DIR);
  const schemaWorkbench = path.join(SCHEMA_ROOT, ".工作台");

  // ④-1 progress.json：模板文件 == 代码首建产物（逐字节）；readProgress 真读
  const cleanRoot = path.join(TMP_BASE, "project-clean");
  fs.mkdirSync(cleanRoot, { recursive: true });
  addProject({ id: "l3-clean", name: "L3 干净夹具", path: cleanRoot, kind: "backend" }, DATA_DIR);
  initWorkstation("l3-clean", DATA_DIR);
  const codeProgress = readText(path.join(cleanRoot, ".工作台", "progress.json"));
  const tplProgressText = readText(path.join(TEMPLATE_DIR, "progress.json"));
  ok(
    lf(codeProgress) === lf(tplProgressText),
    "④ progress.json：模板逐字节（行尾归一）== initWorkstation 的首建产物（current_step=kickoff + 七步 pending）",
  );
  const p = readProgress(SCHEMA_ID, DATA_DIR);
  ok(
    p.version === 1 &&
      p.gate.current_step === "kickoff" &&
      p.gate.history.length === 7 &&
      p.gate.history.every((h, i) => h.step === GATE_STEPS[i].id && h.result === "pending" && h.at === null && h.note === null) &&
      p.modules.length === 0,
    "④ progress.json 过 readProgress：七步顺序 / pending / at=null / modules 空",
  );
  assertKeysInDoc(Object.keys(JSON.parse(tplProgressText)), "progress.json 顶层");
  assertKeysInDoc(Object.keys(p.gate.history[0]), "progress.json gate.history 条目");
  const mod = addModule(SCHEMA_ID, { id: "m-l3", name: "L3 模块" }, DATA_DIR);
  assertKeysInDoc(Object.keys(mod), "progress.json modules 条目");

  // ④-2 gate.jsonl：模板 0 行合法；追加一行后过 readGateLines 同族校验
  ok(readGateLines(SCHEMA_ID, DATA_DIR).length === 0, "④ gate.jsonl 空文件合法（readGateLines → 0 行 = 还没有过关/打回）");
  ok(readText(path.join(TEMPLATE_DIR, "gate.jsonl")) === "", "④ gate.jsonl 只追加：模板给的是 0 字节空文件");
  recordGateTransition(SCHEMA_ID, { step: "kickoff", result: "pass", note: "冷启动自检" }, DATA_DIR);
  const gateLines = readGateLines(SCHEMA_ID, DATA_DIR);
  ok(
    gateLines.length === 1 && gateLines[0].step === "kickoff" && gateLines[0].result === "pass" && gateLines[0].by === "user",
    "④ 追加后的 gate 行过 readGateLines（ts/step/result/by/note）",
  );
  assertKeysInDoc(Object.keys(gateLines[0]), "gate.jsonl 行");
  ok(readGateLines(SCHEMA_ID, DATA_DIR).every((l) => l.result === "pass" || l.result === "reject"), "④ gate 行的 result 只有 pass/reject（pending 不进流水）");

  // ④-3 tasks.json：模板空表可读；真写一条后记录键集与文档口径一致
  ok(
    JSON.stringify(readTasks(SCHEMA_ID, DATA_DIR)) === JSON.stringify({ version: 1, tasks: [] }),
    "④ tasks.json 过 readTasks：模板空表 = { version:1, tasks:[] }",
  );
  const t = addTask(SCHEMA_ID, { id: "t-1", title: "L3 自检任务", module_id: "m-l3", reporter: "kimi-code" }, DATA_DIR);
  assertKeysInDoc(Object.keys(t), "tasks.json 条目");
  ok(
    readTasks(SCHEMA_ID, DATA_DIR).tasks.length === 1,
    "④ tasks.json 真写一条后过 readTasks（validateTask 逐字段校验，含四值状态）",
  );

  // ④-4 arch/modules.json：键集 ↔ 代码真解析产物
  const tplModules = JSON.parse(readText(path.join(TEMPLATE_DIR, "arch", "modules.json")));
  assertKeysInDoc(Object.keys(tplModules), "arch/modules.json 顶层");
  const modulesRead = readModules(SCHEMA_ID, DATA_DIR);
  ok(modulesRead.exists === true && Array.isArray(modulesRead.arch?.modules), "④ arch/modules.json 过 readModules（模板空骨架可读）");
  const parsedFile = parseDirectory(SCHEMA_ROOT).file;
  ok(
    Object.keys(parsedFile).join(",") === Object.keys(tplModules).join(","),
    `④ arch/modules.json 顶层键集 == parseDirectory 产物（${Object.keys(parsedFile).join("/")}）`,
  );
  assertKeysInDoc(Object.keys(parsedFile.modules[0]), "arch/modules.json 模块条目");
  const firstDep = parsedFile.modules.find((m) => m.deps.length > 0)?.deps[0];
  if (firstDep) assertKeysInDoc(Object.keys(firstDep), "arch/modules.json deps 条目");
  const rewritten = parseProject(SCHEMA_ID, DATA_DIR);
  ok(
    readModules(SCHEMA_ID, DATA_DIR).arch?.modules.length === rewritten.file.modules.length &&
      rewritten.file.modules.length > 0,
    `④ 真跑一次解析后 modules.json 被整份覆盖：${rewritten.file.modules.length} 个模块（模板空骨架让位给产物）`,
  );

  // ④-5 arch/names.json：空态可读；真起名（mock 掉外部模型调用）后条目键集 ↔ 文档口径
  ok(
    JSON.stringify(readNames(SCHEMA_ROOT)) === JSON.stringify({ version: 1, entries: {} }),
    "④ arch/names.json 过 readNames：模板空 entries = { version:1, entries:{} }",
  );
  const named = await nameModules(SCHEMA_ID, {
    dataDir: DATA_DIR,
    force: true,
    chat: async () => JSON.stringify({ name: "夹具模块", blurb: "自检用", kind: "code" }),
  });
  const nameEntry = Object.values(named.file.entries)[0];
  ok(named.named > 0 && typeof nameEntry?.signature === "string", "④ 真跑一次起名（mock 模型调用）后 names.json 条目带签名缓存");
  assertKeysInDoc(Object.keys(nameEntry), "arch/names.json 条目");

  // ④-6 arch/layout.json：模板必须是 v2（v1 会被迁移写回）；按视图分键真写回
  const tplLayout = JSON.parse(readText(path.join(TEMPLATE_DIR, "arch", "layout.json")));
  ok(
    tplLayout.version === 2 && typeof tplLayout.positions === "object" && Object.keys(tplLayout.positions).length === 0,
    "④ arch/layout.json 模板为 v2 空 positions（v1 会被代码当成旧结构迁移写回，不能是 v1）",
  );
  const layoutRead = readLayoutByRoot(SCHEMA_ROOT);
  ok(
    layoutRead.version === 2 && Object.keys(layoutRead.positions).length === 0,
    "④ arch/layout.json 过 readLayoutByRoot：v2 + 空 positions",
  );
  const savedLayout = savePositionsByRoot(SCHEMA_ROOT, { "src-kernel": { x: 1, y: 2 } }, LAYOUT_MIGRATION_MODE).file;
  ok(
    savedLayout.version === 2 && savedLayout.positions[LAYOUT_MIGRATION_MODE]?.["src-kernel"]?.x === 1,
    `④ 布局记忆真写回：positions.${LAYOUT_MIGRATION_MODE} 按视图分键（F4 口径）`,
  );
  assertKeysInDoc(Object.keys(tplLayout), "arch/layout.json 顶层");
  assertKeysInDoc(["x", "y"], "arch/layout.json 坐标");

  // ④-7 arch/mindmap-fold.json：空态可读；按项目 + 节点真写回
  const tplFold = JSON.parse(readText(path.join(TEMPLATE_DIR, "arch", "mindmap-fold.json")));
  ok(
    tplFold.version === 1 && typeof tplFold.projects === "object" && Object.keys(tplFold.projects).length === 0,
    "④ arch/mindmap-fold.json 模板为 v1 空 projects",
  );
  const foldRead = readFoldFileByRoot(SCHEMA_ROOT);
  ok(foldRead.version === 1 && Object.keys(foldRead.projects).length === 0, "④ arch/mindmap-fold.json 过 readFoldFileByRoot");
  const savedFold = saveFoldByRoot(SCHEMA_ROOT, SCHEMA_ID, [{ id: "src-kernel", path: "src/kernel" }]).file;
  ok(
    savedFold.projects[SCHEMA_ID]?.expanded[0]?.path === "src/kernel",
    "④ 折叠记忆真写回：按项目 id 分层 + {id,path}",
  );
  assertKeysInDoc(Object.keys(tplFold), "arch/mindmap-fold.json 顶层");
  assertKeysInDoc(["expanded", "id", "path"], "arch/mindmap-fold.json 条目");

  // ④-8 arch/reconcile-request.json + reconcile-last.json：钩子被真消费、结果键集 ↔ 代码产物
  const reqPath = path.join(schemaWorkbench, "arch", "reconcile-request.json");
  ok(fs.existsSync(reqPath) && JSON.stringify(JSON.parse(readText(reqPath))) === "{}", "④ arch/reconcile-request.json 模板给的是空壳 {}（瞬时标记，结构占位）");
  const lastBefore = readLastReconcile(SCHEMA_ID, DATA_DIR);
  ok(lastBefore.exists === true && lastBefore.result?.note === RECONCILE_SIGNAL_NOTE, "④ arch/reconcile-last.json 模板的 note == 代码常量 RECONCILE_SIGNAL_NOTE（§4.5 口径不漂移）");
  assertKeysInDoc(Object.keys(lastBefore.result ?? {}), "arch/reconcile-last.json");
  assertKeysInDoc(["ts", "trigger", "gate_step"], "arch/reconcile-request.json");
  const reconcileRun = reconcileProject(SCHEMA_ID, { trigger: "manual", dataDir: DATA_DIR });
  ok(
    Object.keys(reconcileRun).join(",") === Object.keys(lastBefore.result ?? {}).join(","),
    `④ arch/reconcile-last.json 键集 == 代码真跑一次对账的产物（${Object.keys(reconcileRun).length} 个字段）`,
  );
  ok(
    !fs.existsSync(reqPath) && JSON.stringify(reconcileRun.consumed_request) === "{}",
    "④ arch/reconcile-request.json 被真消费（跑一次对账后删除标记，模板空壳消费无副作用）",
  );

  // ④-9 chat/<session>.jsonl：过 readSession（§2.3.6：assistant 行必须带 model）
  const session = readSession(SCHEMA_ID, "example-session", DATA_DIR);
  const [userLine, assistantLine] = session;
  ok(
    session.length === 2 &&
      userLine.role === "user" &&
      assistantLine.role === "assistant" &&
      typeof assistantLine.model === "string",
    "④ chat/example-session.jsonl 过 readSession：user 行 + assistant 行（带 model）",
  );
  assertKeysInDoc(Object.keys(session[0]), "chat/<session>.jsonl user 行");
  assertKeysInDoc(Object.keys(session[1]), "chat/<session>.jsonl assistant 行");
  const sessions = listSessions(SCHEMA_ID, DATA_DIR);
  ok(
    sessions.length === 1 && sessions[0].session_id === "example-session" && sessions[0].message_count === 2,
    "④ chat/ 会话可列出（listSessions 按 mtime 倒序，示例文件被正常识别）",
  );

  // ④-10 logs/terminal-history.jsonl：空态合法；真写一行后过检索口径
  const empty = queryTerminalHistory(SCHEMA_ID);
  ok(empty.items.length === 0 && empty.corrupt === 0, "④ logs/terminal-history.jsonl 空文件合法（0 条 / 0 坏行）");
  ok(readText(path.join(TEMPLATE_DIR, "logs", "terminal-history.jsonl")) === "", "④ logs/terminal-history.jsonl 只追加：模板给的是 0 字节空文件");
  appendTerminalHistoryLine(SCHEMA_ID, {
    ts: nowIso(),
    project_id: SCHEMA_ID,
    session_id: "tmg00000-1",
    cwd: SCHEMA_ROOT,
    command: "pnpm typecheck",
    duration_ms: 1200,
  });
  const one = queryTerminalHistory(SCHEMA_ID);
  ok(one.items.length === 1 && one.corrupt === 0, "④ 追加一行后过 queryTerminalHistory（历史行字段口径）");
  assertKeysInDoc(Object.keys(one.items[0]), "logs/terminal-history.jsonl 行");

  // ④-11 design.md / design.discuss.md：模板标题头 == 代码首建产物（逐字节）
  const headerRoot = path.join(TMP_BASE, "project-header");
  fs.mkdirSync(headerRoot, { recursive: true });
  addProject({ id: "l3-header", name: "<项目名>", path: headerRoot, kind: "backend" }, DATA_DIR);
  appendDesign("l3-header", "（示例）落稿正文占位", DATA_DIR);
  ok(
    lf(readText(path.join(headerRoot, ".工作台", "design.md"))) === lf(`${tplDesign}（示例）落稿正文占位\n`),
    "④ design.md 模板标题头 == 落稿笔首建产物（逐字节、行尾归一：标题 + §3.5 口径句）",
  );
  const discussFile = path.join(headerRoot, ".工作台", "design.discuss.md");
  appendDiscuss("l3-header", "（示例）待议内容占位", DATA_DIR);
  const tplDiscuss = readText(path.join(TEMPLATE_DIR, "design.discuss.md"));
  const discussOnDisk = lf(readText(discussFile));
  const tplDiscussLf = lf(tplDiscuss);
  ok(
    discussOnDisk.startsWith(tplDiscussLf) &&
      discussOnDisk.slice(tplDiscussLf.length) === `- \`${nowIso().slice(0, 10)}\` （示例）待议内容占位\n`,
    "④ design.discuss.md 模板标题头 == 待议笔首建产物（逐字节、行尾归一：标题 + 提疑权口径句）",
  );

  // ④-12 模板文件全集：每个模板文件都被某条断言覆盖（清单与脚本同步，防"漏验"）
  const covered = new Set([
    "design.md",
    "design.discuss.md",
    "progress.json",
    "gate.jsonl",
    "tasks.json",
    "chat/example-session.jsonl",
    "changes.jsonl",
    "arch/modules.json",
    "arch/layout.json",
    "arch/names.json",
    "arch/mindmap-fold.json",
    "arch/reconcile-request.json",
    "arch/reconcile-last.json",
    "logs/terminal-history.jsonl",
  ]);
  const uncovered = templateFiles().map((f) => f.rel).filter((rel) => !covered.has(rel));
  ok(uncovered.length === 0, `④ 模板文件全被 schema 断言覆盖（未覆盖：${uncovered.join("、") || "无"}）`);

  // ───────────────────────── 收尾 ─────────────────────────

  const del = await api(`/api/projects/${COLD_ID}`, { method: "DELETE" });
  ok(del.status === 200 && del.body?.removed === COLD_ID, "⑤ 收尾：DELETE /api/projects/:id 把冷启动夹具移出注册表");
  const registryAfter = JSON.parse(readText(path.join(DATA_DIR, "registry.json")));
  ok(
    !registryAfter.projects.some((x: { id: string }) => x.id === COLD_ID),
    "⑤ 收尾：注册表里已无冷启动夹具（只动注册表，不删磁盘目录——塔台红线）",
  );
  ok(fs.existsSync(COLD_ROOT), "⑤ 收尾：磁盘上的夹具目录仍完好（塔台从不删被纳管目录）");

  killTree(child, backendPort);
  await sleep(500);
  ok(!(await portListening(backendPort)), `⑤ 收尾：后端进程树已回收，端口 ${backendPort} 不再响应`);
}

/** 断言之辅助：这些键必须在 templates/README.md 的字段口径里有记载（代码加字段 → 文档跟不上的漂移也报红） */
function assertKeysInDoc(keys: string[], label: string): void {
  const doc = readText(TEMPLATE_README);
  const missing = keys.filter((k) => !doc.includes(k));
  ok(missing.length === 0, `④ ${label} 字段口径在 templates/README.md 有记载（缺：${missing.join("、") || "无"}）`);
}

try {
  await main();
} catch (e) {
  ok(false, `验证中断：${(e as Error).message}`);
  console.error(e);
} finally {
  // 中途抛错也要收干净：先杀自起的后端进程树，再删夹具（不碰任何既有监听）
  if (serverChild) killTree(serverChild, serverPort);
  await sleep(300);
  fs.rmSync(TMP_BASE, { recursive: true, force: true });
  console.log(`\n[verify] 夹具已清理：${path.basename(TMP_BASE)}（临时数据目录 + 夹具项目 + 探针，注册表也在里面）`);
  console.log(process.exitCode ? "[verify] 存在 FAIL" : "[verify] 全部 PASS");
}
