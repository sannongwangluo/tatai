// E3 验证脚本（用 tsx 跑）：命令历史检索（PLAN.md E3 卡 DoD①–④ + 卡上「跑偏点」红线）。
// 用法：pnpm verify:e3
//
// 覆盖点（逐条对 DoD）：
//   ① **落盘位置在 `.工作台/` 内、git 看不到**（DoD①）：断言 `terminalHistoryPath()` ==
//      `<项目根>/.工作台/logs/terminal-history.jsonl`、路径在项目根内、`git status --porcelain` 里
//      **零 `.工作台/` 行**、`.gitignore` 含 `.工作台/`。
//   ② **检索 + 一键回填**（DoD②）：HTTP 段验证检索命中/不命中/limit 边界；UI 段真点「历史」→ 搜索框过滤 →
//      点一条 → 断言**命令进了输入行但没被执行**（回填前后标记行计数不变），再按回车才 +1。
//   ③ **跨会话仍可查**（DoD③，本卡硬证据）：关掉 pane 会话 + **重启后端进程** → 同一批命令仍能查到
//      （重启前后各贴一次落盘内容与检索结果）。
//   ④ **隐私红线**（DoD④）：历史文件在项目私有目录且 gitignore；清空接口把文件打回空态；
//      **反证跑偏点**：把 `$HISTFILE` / PowerShell `ConsoleHost_history.txt` / 项目根 `.bash_history`
//      都塞进哨兵内容，启动后端时把环境指过去，断言塔台历史里**零哨兵命中**（＝没把 shell 自己的
//      历史文件当数据源）；再用一条**不经塔台**的直连 shell 命令在项目根里跑，断言它也没进塔台历史；
//      最后断言历史里每条 `session_id` 都是本轮经塔台建出来的会话 id（数据源的唯一性证据）。
//   附：按键流解析（中文/管道/长命令/退格/左方向键/粘贴多行/Ctrl-C）、无回显口令与敏感形态不落盘、
//      滚动归档与保留上限、清空回空态、落盘失败不拖垮终端通道（`close()` 兜底）。
//
// 端口策略（同 verify-e2）：**不碰任何既有监听**——后端与 vite 都 bind 0 让系统分配，vite 经
// TATAI_DEV_API_PORT 代理到动态后端；起前探活、起后盯早退；开头末尾各探一次 8787/5173（只记录不杀）。
// 夹具（全部在 gitignore 的 `.工作台/verify/` 内，跑完删）：`e3-home`（临时 TATAI_HOME，不碰真实注册表）
// + `e3-fixture/p`（HTTP 段项目根）+ `e3-fixture/mod`（模块段项目根）+ `e3-sentinel/`（哨兵文件）。
// 截图落 `.工作台/verify/e3-*.png`（gitignore）。**真实敏感命令原文不进本脚本、不进 PROGRESS**：
// 验证用的全是合成标记串（E3_*），贴证据时把夹具路径统一打码成 `<项目根>`。
import { execFileSync, execSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { addProject } from "../src/server/registry";
import {
  appendTerminalHistoryLine,
  clearTerminalHistory,
  DEFAULT_HISTORY_LIMIT,
  ECHO_QUIET_MS,
  HISTORY_FILE_NAME,
  MAX_HISTORY_ARCHIVES,
  MAX_HISTORY_BYTES,
  MAX_HISTORY_LIMIT,
  queryTerminalHistory,
  TerminalHistoryRecorder,
  terminalHistoryPath,
} from "../src/server/terminalHistory";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VERIFY_DIR = path.join(REPO_ROOT, ".工作台", "verify");
const HOME_DIR = path.join(VERIFY_DIR, "e3-home");
const FIXTURE_DIR = path.join(VERIFY_DIR, "e3-fixture");
const SENTINEL_DIR = path.join(VERIFY_DIR, "e3-sentinel");
/** HTTP 段项目（真 PTY 敲命令的那个） */
const PROJ = "e3-fix";
const ROOT = path.join(FIXTURE_DIR, "p");
/** 模块段项目（按键解析/滚动/清空，自己一个项目根，免得污染 HTTP 段的证据） */
const PROJ_MOD = "e3-mod";
const ROOT_MOD = path.join(FIXTURE_DIR, "mod");

/** 模块段记录器用的会话 id（真会话 id 由 pty.ts 生成，这里只做单元级）
 *  注意：**不在** 会话 id 白名单里——白名单断言只覆盖 HTTP/UI 段真会话。 */
const MOD_SESSION = "tmod-1";

/** 哨兵（只为"反证数据源"存在；一个字节都不会经塔台输入） */
const SENTINEL_HISTFILE = "E3_SENTINEL_HISTFILE_ONLY";
const SENTINEL_PSREADLINE = "E3_SENTINEL_PSREADLINE_ONLY";
const SENTINEL_BASH = "E3_SENTINEL_BASH_HISTORY_ONLY";
const SENTINEL_DIRECT = "E3_SENTINEL_DIRECT_SHELL_ONLY";

/** 验证命令（全合成标记，无任何真实敏感内容）。长命令 ~370 字符，必跨行。 */
const CMD_ZH = "echo 中文命令 E3_ZH_END";
const CMD_PIPE = "echo 管道 E3_PIPE_END | findstr E3_PIPE_END";
const CMD_LONG = `echo E3_LONG_${"x".repeat(330)}_LONG_END`;
const CMD_CD = "cd sub";
const CMD_PLAIN = "echo E3_PLAIN_END";
/** 敏感形态（不该落盘）：password 字样 */
const CMD_SENSITIVE = "net user e3user MyPassword123";

const ok = (cond: boolean, label: string) => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (!cond) process.exitCode = 1;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 贴证据用：把夹具绝对路径打码（真实路径不进 PROGRESS，也不进截图外的日志）。
 *  jsonl 里的路径是**转义过的**（`D:\\<盘符下的项目名>\\…`），所以每个路径要按原形与转义形各替换一次。 */
const MASK_TABLE: Array<[string, string]> = [
  [ROOT_MOD, "<模块段项目根>"],
  [ROOT, "<项目根>"],
  [HOME_DIR, "<临时 TATAI_HOME>"],
  [SENTINEL_DIR, "<哨兵目录>"],
  [REPO_ROOT, "<repo>"],
];
const mask = (s: string): string =>
  MASK_TABLE.reduce(
    (acc, [p, label]) =>
      acc.split(p.replace(/\\/g, "\\\\")).join(label).split(p).join(label),
    s,
  );

const historyFileOf = (projectId: string) => terminalHistoryPath(projectId);
const readFileText = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "");
const linesOf = (text: string) =>
  text
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);

/** 造一个"另一条 shell 通道"的命令：直连 cmd（不经塔台），在项目根里跑 */
function runDirectShellCommand(command: string): string {
  const out = execFileSync(process.env.COMSPEC || "cmd.exe", ["/c", command], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return out.trim();
}

// ───────────────────────── 端口：探活 + 动态分配（与 verify-e1/e2 同一份写法） ─────────────────────────

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
      srv.listen(0, () => {
        const addr = srv.address();
        const p = typeof addr === "object" && addr ? addr.port : 0;
        srv.close(() => resolve(p));
      });
    });
    if (port > 0 && !(await portListening(port))) return port;
  }
  throw new Error("分配不到空闲端口（连续 5 次都被抢）");
}

async function waitUpAny(
  urls: string[],
  label: string,
  opts: { timeoutMs?: number; isAlive?: () => boolean } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (opts.isAlive && !opts.isAlive()) throw new Error(`${label} 进程已退出（端口可能被抢）`);
    for (const url of urls) {
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(2500) });
        if (r.status < 500) return;
      } catch {
        // 还没起来
      }
    }
    await sleep(250);
  }
  throw new Error(`${label} 未就绪（${timeoutMs / 1000}s 超时）：${urls.join(" / ")}`);
}

const intentionalStop = new Set<number>();

function pipeOutput(child: ChildProcess, label: string): void {
  child.stdout?.on("data", (d: Buffer) => process.stdout.write(`[${label}] ${d}`));
  child.stderr?.on("data", (d: Buffer) => process.stderr.write(`[${label}] ${d}`));
}

function killTree(child: ChildProcess, port?: number): void {
  if (port) intentionalStop.add(port);
  if (!child.pid) return;
  if (process.platform === "win32") {
    try {
      execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore" });
    } catch {
      // 已退出则忽略
    }
  } else {
    child.kill();
  }
}

/** 起后端：动态端口 + 临时 TATAI_HOME + 三个 shell 历史哨兵环境（反证数据源用） */
async function startBackend(port: number): Promise<ChildProcess> {
  if (await portListening(port)) {
    throw new Error(`后端端口 ${port} 已被占用（本脚本不碰既有监听，请重跑）`);
  }
  const child = spawn(
    process.execPath,
    ["--import", "tsx", path.join("src", "server", "index.ts")],
    {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        TATAI_HOME: HOME_DIR,
        TATAI_PORT: String(port),
        // ↓↓↓ 反证用：把这些"shell 自己的历史文件"指到哨兵，塔台历史里出现哨兵即失败
        HISTFILE: path.join(SENTINEL_DIR, "fake-histfile.txt"),
        APPDATA: SENTINEL_DIR,
      },
    },
  );
  pipeOutput(child, `后端:${port}`);
  child.once("exit", (code) => {
    if (!intentionalStop.has(port) && code !== 0) {
      console.error(`[verify] 后端（端口 ${port}）意外退出：code=${code}（端口被抢？）`);
    }
  });
  await waitUpAny(
    [`http://127.0.0.1:${port}/health`, `http://localhost:${port}/health`],
    `后端 ${port}`,
    { isAlive: () => child.exitCode === null },
  );
  return child;
}

async function pidAlive(pid: number): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn("tasklist", ["/FI", `PID eq ${pid}`, "/NH"]);
    let out = "";
    p.stdout.on("data", (d: Buffer) => (out += d.toString()));
    p.on("close", () => resolve(out.includes(String(pid))));
    p.on("error", () => resolve(false));
  });
}

async function waitPidGone(pid: number, timeoutMs = 8000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await pidAlive(pid))) return true;
    await sleep(300);
  }
  return false;
}

// ───────────────────────── 夹具：临时 TATAI_HOME + 两个临时项目根 + 哨兵文件 ─────────────────────────

function buildFixture(): void {
  fs.rmSync(HOME_DIR, { recursive: true, force: true });
  fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
  fs.rmSync(SENTINEL_DIR, { recursive: true, force: true });
  fs.mkdirSync(HOME_DIR, { recursive: true });
  fs.mkdirSync(path.join(ROOT, "sub"), { recursive: true });
  fs.mkdirSync(ROOT_MOD, { recursive: true });
  fs.mkdirSync(path.join(SENTINEL_DIR, "Microsoft", "Windows", "PowerShell", "PSReadLine"), {
    recursive: true,
  });
  // 探针用的记录器要按注册表解析项目根 → 本进程也用临时 TATAI_HOME（绝不碰真实注册表）
  process.env.TATAI_HOME = HOME_DIR;
  addProject({ id: PROJ, name: "E3 验证项目", path: ROOT, kind: "backend" }, HOME_DIR);
  addProject({ id: PROJ_MOD, name: "E3 模块段项目", path: ROOT_MOD, kind: "backend" }, HOME_DIR);

  // 哨兵：三种"shell 自己的历史文件"都塞上只该出现在它们里的标记串
  fs.writeFileSync(
    path.join(SENTINEL_DIR, "fake-histfile.txt"),
    `echo ${SENTINEL_HISTFILE}\n`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(SENTINEL_DIR, "Microsoft", "Windows", "PowerShell", "PSReadLine", "ConsoleHost_history.txt"),
    `echo ${SENTINEL_PSREADLINE}\n`,
    "utf8",
  );
  fs.writeFileSync(path.join(ROOT, ".bash_history"), `echo ${SENTINEL_BASH}\n`, "utf8");

  console.log(
    `[verify] 夹具就绪：TATAI_HOME=${path.relative(REPO_ROOT, HOME_DIR)} · 项目根 p=${path.relative(REPO_ROOT, ROOT)} / mod=${path.relative(REPO_ROOT, ROOT_MOD)} · 哨兵目录 ${path.relative(REPO_ROOT, SENTINEL_DIR)}`,
  );
}

/** 哨兵文件的字节快照（跑完比对：塔台没读过、更没改过它们） */
function sentinelSnapshot(): Record<string, string> {
  const files = [
    path.join(SENTINEL_DIR, "fake-histfile.txt"),
    path.join(SENTINEL_DIR, "Microsoft", "Windows", "PowerShell", "PSReadLine", "ConsoleHost_history.txt"),
    path.join(ROOT, ".bash_history"),
  ];
  return Object.fromEntries(files.map((f) => [path.relative(VERIFY_DIR, f), fs.readFileSync(f, "utf8")]));
}

// ───────────────────────── HTTP 客户端 ─────────────────────────

let base = "";

interface ApiResp {
  status: number;
  body: Record<string, unknown>;
}

async function api(method: string, rawPath: string, body?: unknown): Promise<ApiResp> {
  const res = await fetch(`${base}${rawPath}`, {
    method,
    ...(body !== undefined
      ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
      : {}),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

interface HistoryItem {
  ts: string;
  project_id: string;
  session_id: string;
  cwd: string;
  command: string;
  duration_ms: number | null;
}

async function getHistory(
  projectId: string,
  q?: string,
  limit?: number,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const params = new URLSearchParams();
  if (q !== undefined) params.set("q", q);
  if (limit !== undefined) params.set("limit", String(limit));
  const qs = params.toString();
  return api("GET", `/api/projects/${encodeURIComponent(projectId)}/terminal/history${qs ? `?${qs}` : ""}`);
}

async function newSession(projectId: string, cols = 120, rows = 30): Promise<{ id: string; pid: number; cwd: string }> {
  const r = await api("POST", `/api/projects/${encodeURIComponent(projectId)}/terminal`, { cols, rows });
  const session = r.body.session as { id: string; pid: number; cwd: string } | undefined;
  if (r.status !== 200 || !session) throw new Error(`建会话失败：${r.status} ${JSON.stringify(r.body)}`);
  return session;
}

const typeIn = (projectId: string, sid: string, data: string): Promise<ApiResp> =>
  api("POST", `/api/terminal/${encodeURIComponent(sid)}/in?project_id=${encodeURIComponent(projectId)}`, {
    data,
  });

/** 轮询历史直到 predicate 满足（记录是"输出静默后"才落盘的，测试必须等） */
async function waitHistory(
  projectId: string,
  predicate: (items: HistoryItem[]) => boolean,
  timeoutMs = 15_000,
): Promise<HistoryItem[]> {
  const deadline = Date.now() + timeoutMs;
  let items: HistoryItem[] = [];
  while (Date.now() < deadline) {
    const r = await getHistory(projectId, undefined, MAX_HISTORY_LIMIT);
    items = (r.body.items ?? []) as HistoryItem[];
    if (predicate(items)) return items;
    await sleep(150);
  }
  return items;
}

// ───────────────────────── ① 模块层：落盘位置 / 按键流解析 / 滚动 / 清空 / 源码护栏 ─────────────────────────

/** 喂一行（含回显）并等静默落盘 */
async function feedLine(rec: TerminalHistoryRecorder, input: string, echo: string | null): Promise<void> {
  rec.feedInput(input);
  if (echo !== null) rec.feedOutput(echo);
  await sleep(ECHO_QUIET_MS + 120);
}

async function moduleSection(): Promise<void> {
  console.log("\n[verify] ── ① 落盘位置 + 按键流解析 + 滚动/清空 + 源码护栏（DoD①④）");
  const file = historyFileOf(PROJ_MOD);
  ok(
    file === path.join(ROOT_MOD, ".工作台", "logs", HISTORY_FILE_NAME),
    `① 落盘位置 = <项目根>/.工作台/logs/${HISTORY_FILE_NAME}（实际 ${mask(file)}）`,
  );
  ok(
    file.startsWith(path.join(ROOT_MOD, ".工作台") + path.sep),
    `① 历史文件在**项目私有目录**内（路径前缀 = <项目根>/.工作台/），不在仓库、不在项目公开目录`,
  );
  const gitignore = fs.readFileSync(path.join(REPO_ROOT, ".gitignore"), "utf8");
  ok(/^\.工作台\/$/m.test(gitignore), `① 塔台 .gitignore 含 \`.工作台/\`（依据 DESIGN.md §8.2）：${JSON.stringify(gitignore.split(/\r?\n/).filter(Boolean).join(" / "))}`);

  // 非注册表项目：路径解析必须抛（不静默落到别处）
  let threw = "";
  try {
    terminalHistoryPath("e3-no-such-project");
  } catch (e) {
    threw = (e as Error).message;
  }
  ok(threw.includes("PROJECT_NOT_FOUND") || threw.includes("项目不存在"), `① 未登记项目取历史路径走注册表报错（不静默换目录）：${mask(threw)}`);

  clearTerminalHistory(PROJ_MOD);
  const rec = new TerminalHistoryRecorder(MOD_SESSION, PROJ_MOD, ROOT_MOD);

  // ── 合成按键流：正常命令（中文 / 管道 / 长命令）──
  const batch = [
    [CMD_ZH + "\r", `${CMD_ZH}\r\n中文命令 E3_ZH_END\r\nD:\\x>`],
    [CMD_PIPE + "\r", `${CMD_PIPE}\r\n管道 E3_PIPE_END\r\nD:\\x>`],
    [CMD_LONG + "\r", `${CMD_LONG}\r\nE3_LONG_${"x".repeat(330)}_LONG_END\r\nD:\\x>`],
  ] as Array<[string, string]>;
  for (const [input, echo] of batch) await feedLine(rec, input, echo);

  // ── 退格：末尾多余字符被删掉 ──
  await feedLine(rec, "echo hix\u007f\r", "echo hix\u0008 \u0008\r\nhi\r\nD:\\x>");
  // ── 左方向键：光标处的插入（回显是屏幕状态，按设计跳过回显比对）──
  await feedLine(rec, "echo hi\u001b[DX\r", "echo hi\u0008Xi\r\nhXi\r\nD:\\x>");
  // ── 粘贴多行：按行切成两条 ──
  await feedLine(rec, "echo paste1\r\necho paste2\r", "echo paste1\r\npaste1\r\necho paste2\r\npaste2\r\nD:\\x>");
  // ── ↑ 召回历史 / Tab 补全：重建不出来 → 不落盘 ──
  await feedLine(rec, "echo recalled\u001b[A\r", "echo recalled\r\n");
  await feedLine(rec, "cd su\t\r", "cd sub>\r\n");
  // ── 真无回显（没喂任何回显）→ 不落盘 ──
  await feedLine(rec, "hunter2xyz\r", null);
  // ── 密码提示词 + 无回显 → 不落盘 ──
  rec.feedOutput("D:\\x>ssh box\r\nbox's Password: ");
  await feedLine(rec, "hunter2xyz\r", null);
  // ── 敏感形态（英文 password / 中文 密码）→ 不落盘 ──
  await feedLine(rec, CMD_SENSITIVE + "\r", `${CMD_SENSITIVE}\r\n`);
  await feedLine(rec, `set 密码=abc123\r`, `set 密码=abc123\r\n`);
  // ── 空行 / Ctrl-C 弃行 ──
  await feedLine(rec, "\r", "\r\nD:\\x>");
  await feedLine(rec, "echo never\u0003\r", "echo never\u0003\r\nD:\\x>");
  // ── close() 兜底：不等静默就把待落盘队列落掉（会话被杀不留半条）──
  rec.feedInput("echo onclose\r");
  rec.feedOutput("echo onclose\r\nonclose\r\n");
  rec.close();
  await sleep(120);

  const text = readFileText(file);
  const written = linesOf(text);
  const commands = written.map((l) => l.command as string);
  const expectWritten = [
    CMD_ZH,
    CMD_PIPE,
    CMD_LONG,
    "echo hi",
    "echo hXi",
    "echo paste1",
    "echo paste2",
    "echo onclose",
  ];
  const missing = expectWritten.filter((c) => !commands.includes(c));
  ok(
    missing.length === 0 && commands.length === expectWritten.length,
    `① 按键流 → 命令：应落盘 ${expectWritten.length} 条、实际 ${commands.length} 条（中文「${CMD_ZH}」/ 管道「${CMD_PIPE}」/ 长命令 ${CMD_LONG.length} 字符 / 退格→「echo hi」/ 左方向键→「echo hXi」/ 粘贴多行→2 条；缺：${missing.join(" | ") || "无"}）`,
  );
  ok(
    !commands.some((c) => /recalled|su\b|hunter2xyz|password|密码|never|net user/i.test(c)),
    `① 不落盘的四类都真的没落：↑ 召回「echo recalled」、Tab 补全「cd su*」、无回显口令、密码提示词后输入、敏感形态（net user + password / 中文密码词）、Ctrl-C 弃行、「echo never」`,
  );
  const skip = rec.skipped;
  console.log(
    `[verify]   跳过计数（内存，不落盘）：unreconstructable=${skip.unreconstructable} · no_echo=${skip.no_echo} · no_echo_prompt=${skip.no_echo_prompt} · sensitive_shape=${skip.sensitive_shape} · empty=${skip.empty}`,
  );
  ok(
    skip.unreconstructable === 2 && skip.no_echo === 1 && skip.no_echo_prompt === 1 && skip.sensitive_shape === 2 && skip.empty === 3,
    `① 每类跳过的理由都被数到了：不可重建 2（↑召回 / Tab 补全）· 无回显 1 · 密码提示词 1 · 敏感形态 2（英文 password / 中文密码词）· 空提交 3（空行 / 粘贴的 \\r\\n 里那半个 \\n / Ctrl-C 弃行后的回车）`,
  );

  // 字段口径
  const sample = written[0];
  const keys = Object.keys(sample).sort().join(",");
  ok(
    keys === "command,cwd,duration_ms,project_id,session_id,ts" &&
      sample.project_id === PROJ_MOD &&
      sample.session_id === MOD_SESSION &&
      typeof sample.ts === "string" &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/.test(sample.ts as string),
    `① 记录字段齐：${keys}（project_id / session_id / cwd / ts（本地 ISO 带时区偏移）/ command / duration_ms）`,
  );
  console.log(`[verify]   落盘原文（打码后，逐条）：`);
  for (const l of written) console.log(`[verify]     ${mask(JSON.stringify(l))}`);

  // 检索（模块层）：命中 / 不命中 / 时间倒序
  const hit = queryTerminalHistory(PROJ_MOD, "E3_ZH_END");
  ok(hit.total === 1 && hit.items[0].command === CMD_ZH, `① 关键字检索命中 1 条（q=E3_ZH_END）`);
  const miss = queryTerminalHistory(PROJ_MOD, "E3_NO_SUCH_KEYWORD_ZZZ");
  ok(miss.total === 0 && miss.items.length === 0, `① 关键字不命中返回 0 条（q=E3_NO_SUCH_KEYWORD_ZZZ）`);
  const all = queryTerminalHistory(PROJ_MOD, undefined, MAX_HISTORY_LIMIT);
  ok(
    all.items[0].command === "echo onclose" && all.items[all.items.length - 1].command === CMD_ZH,
    `① 时间倒序：首条 = 最后敲的「echo onclose」、末条 = 最早敲的「${CMD_ZH}」`,
  );

  // ── 滚动归档 + 保留上限（**追加**垃圾内容，不清掉已落的历史行）──
  const logsDir = path.dirname(file);
  const beforeRotate = fs.statSync(file).size;
  fs.appendFileSync(file, "z".repeat(MAX_HISTORY_BYTES + 1024) + "\n", "utf8");
  appendTerminalHistoryLine(PROJ_MOD, {
    ts: "2099-01-01T00:00:00+08:00",
    project_id: PROJ_MOD,
    session_id: MOD_SESSION,
    cwd: ROOT_MOD,
    command: "echo rotate-trigger",
    duration_ms: null,
  });
  let archives = fs.readdirSync(logsDir).filter((f) => /^terminal-history\.\d+\.jsonl$/.test(f));
  const activeAfterRotate = readFileText(file);
  ok(
    archives.length === 1 &&
      fs.statSync(file).size < MAX_HISTORY_BYTES &&
      activeAfterRotate.includes("rotate-trigger") &&
      !activeAfterRotate.includes("E3_ZH_END"),
    `① 单文件超 ${MAX_HISTORY_BYTES / 1024 / 1024}MB 触发滚动：归档 ${archives.length} 个（滚前活跃文件 ${beforeRotate} 字节 → 滚后 ${fs.statSync(file).size} 字节），旧记录进了归档、活跃文件里只剩新写的那条`,
  );
  const rotatedRead = queryTerminalHistory(PROJ_MOD, "E3_ZH_END");
  ok(
    rotatedRead.total === 1,
    `① **归档一起读**：滚进归档里的旧命令照样检索得到（q=E3_ZH_END → ${rotatedRead.total} 条，来自 terminal-history.<ts>.jsonl）`,
  );
  ok(
    queryTerminalHistory(PROJ_MOD, "E3_NO_SUCH_KEYWORD_ZZZ").total === 0,
    "① 归档 + 活跃合起来检索时不命中的仍是 0 条",
  );

  for (let i = 0; i < 7; i++) fs.writeFileSync(path.join(logsDir, `terminal-history.${1000 + i}.jsonl`), "\n", "utf8");
  fs.appendFileSync(file, "w".repeat(MAX_HISTORY_BYTES + 1024) + "\n", "utf8");
  appendTerminalHistoryLine(PROJ_MOD, {
    ts: "2099-01-02T00:00:00+08:00",
    project_id: PROJ_MOD,
    session_id: MOD_SESSION,
    cwd: ROOT_MOD,
    command: "echo prune-trigger",
    duration_ms: null,
  });
  archives = fs.readdirSync(logsDir).filter((f) => /^terminal-history\.\d+\.jsonl$/.test(f));
  ok(
    archives.length === MAX_HISTORY_ARCHIVES,
    `① 归档保留上限 ${MAX_HISTORY_ARCHIVES} 份：塞 8 份后仍是 ${archives.length} 份（丢的是最旧的，归档只是备份）`,
  );

  // ── 坏行容错：手工塞一行非 JSON，检索不炸、只计数 ──
  fs.appendFileSync(file, "这不是 JSON\n", "utf8");
  const withCorrupt = queryTerminalHistory(PROJ_MOD, undefined, MAX_HISTORY_LIMIT);
  ok(
    withCorrupt.corrupt >= 1 && withCorrupt.items.every((i) => typeof i.command === "string"),
    `① 坏行（半截写入/手工改坏/滚动测试塞的垃圾行）不炸检索：corrupt=${withCorrupt.corrupt} 条被跳过、其余 ${withCorrupt.items.length} 条照常返回`,
  );

  // ── 清空：文件回空态 ──
  const beforeClear = queryTerminalHistory(PROJ_MOD, undefined, MAX_HISTORY_LIMIT).total;
  const cleared = clearTerminalHistory(PROJ_MOD);
  const afterClear = queryTerminalHistory(PROJ_MOD, undefined, MAX_HISTORY_LIMIT).total;
  archives = fs.readdirSync(logsDir).filter((f) => /^terminal-history\.\d+\.jsonl$/.test(f));
  ok(
    afterClear === 0 && fs.existsSync(file) && fs.statSync(file).size === 0 && archives.length === 0,
    `④ 清空本项目历史：清空前 ${beforeClear} 条 → 清空后 ${afterClear} 条，活跃文件仍在但 **0 字节**（回空态）、归档 ${cleared.removed_files} 个已删`,
  );

  sourceGuard();
}

/** 源码护栏：数据源唯一性 + 零 shell 历史文件引用 + 零新依赖 */
function sourceGuard(): void {
  console.log("\n[verify] ── 源码护栏：数据源唯一（不读 shell 自己的历史）+ 零新依赖");
  const read = (f: string) => fs.readFileSync(path.join(REPO_ROOT, f), "utf8");
  const strip = (s: string) => s.replace(/\/\/[^\n]*/g, ""); // 先剥注释再扫，防"注释里提到"假通过
  const src = read("src/server/terminalHistory.ts");
  const pty = read("src/server/pty.ts");
  const index = read("src/server/index.ts");
  const server = read("src/server/workstation.ts");

  const shellHistoryTokens = [
    "HISTFILE",
    "ConsoleHost_history",
    "bash_history",
    "PSReadLine",
    "doskey",
    "zsh_history",
    "fish_history",
  ];
  const hitTokens = shellHistoryTokens.filter((t) => strip(src).includes(t));
  ok(
    hitTokens.length === 0,
    `跑偏点反证（源码侧）：terminalHistory.ts 里零 shell 历史文件引用（扫 ${shellHistoryTokens.join(" / ")} → 命中 ${hitTokens.join(",") || "无"}）—— 历史只可能来自塔台自己的输入通道`,
  );
  ok(
    !/child_process|execSync|spawn\(/.test(strip(src)),
    "跑偏点反证（源码侧）：terminalHistory.ts 不起任何子进程、不调 shell（不可能去问 shell 要历史）",
  );

  // 输入口唯一：feedInput 只在 writeTerminal 里被调用；pty.write 全仓只有 pty.ts 一处
  const feedCalls = [...pty.matchAll(/\.history\.feedInput\(/g)];
  const writeTerminalBody = /export function writeTerminal\([\s\S]*?\n}/.exec(pty)?.[0] ?? "";
  ok(
    feedCalls.length === 1 && writeTerminalBody.includes(".history.feedInput("),
    `跑偏点反证（源码侧）：\`feedInput\` 全仓唯一调用点在 writeTerminal 里（${feedCalls.length} 处）—— 只有"经塔台 pane 敲进来的字节"会进历史`,
  );
  const ptyWriteInSrc = fs
    .readdirSync(path.join(REPO_ROOT, "src", "server"))
    .filter((f) => f.endsWith(".ts"))
    .flatMap((f) => [...read(path.join("src", "server", f)).matchAll(/\.pty\.write\(/g)].map(() => f));
  ok(
    ptyWriteInSrc.length === 1 && ptyWriteInSrc[0] === "pty.ts",
    `跑偏点反证（源码侧）：写 PTY 的口子全仓唯一（${ptyWriteInSrc.join(",") || "无"}）—— 不存在绕过 writeTerminal 的第二条输入路`,
  );
  // 白名单（2026-09-18 更新，随 S3 落地）：terminalHistory.ts 仍是**唯一定义处**（HISTORY_FILE_NAME /
  // terminalHistoryPath() 只在这一个文件）；S3 之后 remote-config.ts（R8 红线注释里点名这份文件）、
  // remote-routes.ts（只读路由清单 id：terminal-history-read / -clear）为远程闸门**合法引用**了文件名。
  // 断言语义不变——除白名单外，任何模块不得再写一份这个文件名/路径。
  const histNameWhitelist = ["terminalHistory.ts", "remote-config.ts", "remote-routes.ts"];
  const histMentions = fs
    .readdirSync(path.join(REPO_ROOT, "src", "server"))
    .filter((f) => f.endsWith(".ts"))
    .filter((f) => strip(read(path.join("src", "server", f))).includes("terminal-history"));
  const histIllegal = histMentions.filter((f) => !histNameWhitelist.includes(f));
  ok(
    histIllegal.length === 0 && histMentions.includes("terminalHistory.ts"),
    `落盘文件名的唯一定义处 = terminalHistory.ts，白名单（= 定义处 + S3 远程闸门合法引用 remote-config.ts / remote-routes.ts）之外零提及（实际提及：${histMentions.join(",") || "无"}）`,
  );
  ok(
    !histMentions
      .filter((f) => f !== "terminalHistory.ts")
      .some((f) => /terminalHistoryPath|HISTORY_FILE_NAME/.test(read(path.join("src", "server", f)))),
    "白名单里的引用只是文件名字符串：remote-config.ts / remote-routes.ts 不 import、不自建路径（terminalHistoryPath()/HISTORY_FILE_NAME 全仓仍只有 terminalHistory.ts 一处）",
  );
  ok(
    strip(index).includes("queryTerminalHistory") && strip(index).includes("clearTerminalHistory"),
    "路由层只经 terminalHistory.ts 的导出读/清（index.ts 不自己读文件）",
  );
  ok(
    !/terminal-history|HISTORY_FILE_NAME/.test(strip(server)),
    "workstation.ts 不掺和历史（`.工作台` 目录常量的唯一定义处仍只有它自己）",
  );

  const pkg = JSON.parse(read("package.json")) as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  const all = { ...pkg.dependencies, ...pkg.devDependencies };
  const suspicious = Object.keys(all).filter((d) => /hist|sqlite|lowdb|level|nedb|store/i.test(d));
  ok(
    suspicious.length === 0,
    `④ 零新 npm 依赖：package.json 共 ${Object.keys(all).length} 个依赖（dependencies ${Object.keys(pkg.dependencies).length} + devDependencies ${Object.keys(pkg.devDependencies).length}），` +
      `没有为历史引入任何存储类依赖（扫 hist/sqlite/lowdb/level/nedb/store → 命中 ${suspicious.join(",") || "无"}）：历史就用 node 自带 fs 写 jsonl`,
  );
  const externalImports = [...src.matchAll(/from\s+"([^"]+)"/g)]
    .map((m) => m[1])
    .filter((x) => !x.startsWith("."));
  ok(
    externalImports.every((x) => x.startsWith("node:")),
    `④ 记录层的外部 import 全是 node 内置模块：${externalImports.join(" / ")}`,
  );
  ok(
    /from "node:fs"/.test(src) && /from "node:path"/.test(src) && !/from "node-pty"/.test(src),
    "④ 记录层不 import PTY 层（分层单向：pty → terminalHistory，反向依赖会成环）",
  );
}

// ───────────────────────── ② HTTP 段 A：真 PTY 敲命令 → 落盘 → 检索 → 清空（DoD①②④） ─────────────────────────

/** 本轮经塔台建过的会话 id 全集（哨兵反证用：历史里只该有这些会话的记录） */
const tataiSessionIds = new Set<string>();

/** 打码后贴落盘原文（证据用；命令全是合成标记） */
function dumpHistory(file: string, label: string): void {
  const lines = readFileText(file).split(/\r?\n/).filter((l) => l.trim() !== "");
  console.log(`[verify]   ${label}：${path.relative(REPO_ROOT, file)}（${lines.length} 条）`);
  for (const l of lines) console.log(`[verify]     ${mask(l)}`);
}

async function httpSectionA(): Promise<void> {
  console.log("\n[verify] ── ② HTTP 段：真 PTY 经 POST /in 敲命令 → 落盘 → 检索（DoD②③④）");
  const s1 = await newSession(PROJ);
  tataiSessionIds.add(s1.id);
  console.log(`[verify]   会话 1：${s1.id}（pid ${s1.pid}，cwd ${mask(s1.cwd)}）`);
  await sleep(1500); // 等 cmd 首帧提示符

  for (const c of [CMD_ZH, CMD_PIPE, CMD_LONG, CMD_CD, CMD_PLAIN, CMD_SENSITIVE]) {
    await typeIn(PROJ, s1.id, c + "\r");
  }
  const items = await waitHistory(PROJ, (list) => list.length >= 5);
  const commands = items.map((i) => i.command);
  ok(
    [CMD_ZH, CMD_PIPE, CMD_LONG, CMD_CD, CMD_PLAIN].every((c) => commands.includes(c)),
    `② 真 PTY 敲的命令全落盘（中文 / 管道 / ${CMD_LONG.length} 字符长命令 / cd / 普通）：${items.length} 条`,
  );
  ok(
    !commands.includes(CMD_SENSITIVE),
    `④ 敏感形态命令**没落盘**（真 PTY 也拦住）：${mask(JSON.stringify(CMD_SENSITIVE))}`,
  );
  ok(
    items.every((i) => i.project_id === PROJ && tataiSessionIds.has(i.session_id)),
    `跑偏点反证：落盘记录 100% 带 project_id + 塔台会话 id（${[...new Set(items.map((i) => i.session_id))].join(",")}）—— 数据源只可能是本项目经塔台输入的命令`,
  );
  ok(
    items.every(
      (i) => typeof i.ts === "string" && (i.cwd === ROOT || i.cwd.startsWith(ROOT + path.sep)),
    ),
    `② 每条都带时间戳与 cwd（cd 后 cwd 跟着变、且始终在项目根内）：${[...new Set(items.map((i) => mask(i.cwd)))].join(" | ")}`,
  );
  dumpHistory(historyFileOf(PROJ), "落盘原文");

  // 检索：命中 / 不命中 / limit / 参数校验 / 伪造项目
  const hit = await getHistory(PROJ, "E3_PIPE_END");
  ok(
    hit.status === 200 && (hit.body.total as number) === 1 && (hit.body.items as HistoryItem[])[0].command === CMD_PIPE,
    `② 关键字检索命中 1 条（q=E3_PIPE_END）`,
  );
  const zhHit = await getHistory(PROJ, "中文");
  ok(
    zhHit.status === 200 && (zhHit.body.total as number) >= 1,
    `② 中文关键字也能检索（q=中文 → ${zhHit.body.total} 条，匹配到 command 与 cwd 两个字段）`,
  );
  const miss = await getHistory(PROJ, "E3_NO_SUCH_KEYWORD_ZZZ");
  ok(miss.status === 200 && (miss.body.total as number) === 0, `② 不命中返回 0 条`);
  const lim = await getHistory(PROJ, undefined, 1);
  ok(
    lim.status === 200 && (lim.body.items as HistoryItem[]).length === 1 && (lim.body.total as number) >= 5,
    `② limit=1 生效：返回 1 条 / 命中总数为 ${lim.body.total}（默认 limit ${DEFAULT_HISTORY_LIMIT}、上限 ${MAX_HISTORY_LIMIT}）`,
  );
  const badLim = await getHistory(PROJ, undefined, MAX_HISTORY_LIMIT + 1);
  ok(
    badLim.status === 400 && (badLim.body.error as { code: string }).code === "INVALID_INPUT",
    `② limit 越界 → 400 INVALID_INPUT（不静默截断）`,
  );
  const fake = await getHistory("e3-no-such-project");
  ok(
    fake.status === 404 && (fake.body.error as { code: string }).code === "PROJECT_NOT_FOUND",
    `② 伪造项目 id → 404 PROJECT_NOT_FOUND（不静默返回空表，跨项目不串）`,
  );
  const fileRel = lim.body.file as string;
  ok(
    fileRel.includes(".工作台") && fileRel.includes("logs") && !path.isAbsolute(fileRel),
    `① 接口回的落盘位置是**项目内相对路径**：${JSON.stringify(fileRel)}（绝对路径不外泄）`,
  );

  // 第二个会话（跨 pane / 跨会话，同一后端进程内）
  const s2 = await newSession(PROJ);
  tataiSessionIds.add(s2.id);
  await sleep(1200);
  await typeIn(PROJ, s2.id, "echo E3_SECOND_SESSION\r");
  const afterTwo = await waitHistory(PROJ, (list) => list.some((i) => i.command === "echo E3_SECOND_SESSION"));
  ok(
    afterTwo.some((i) => i.session_id === s1.id) && afterTwo.some((i) => i.session_id === s2.id),
    `② 跨会话（两个 pane 两个会话 ${s1.id} / ${s2.id}）的历史在同一个检索里都能查到 —— 检索按**项目**范围，不按会话`,
  );

  // 纯 HTTP 清空：清空 → 0 条 + 文件 0 字节（隐私删除权）
  const file = historyFileOf(PROJ);
  const beforeSize = fs.statSync(file).size;
  const del = await api("DELETE", `/api/projects/${PROJ}/terminal/history`);
  const after = await getHistory(PROJ, undefined, MAX_HISTORY_LIMIT);
  ok(
    del.status === 200 && (del.body.removed_lines as number) >= 5 && (after.body.total as number) === 0,
    `④ DELETE 清空本项目历史：删 ${del.body.removed_lines} 条（清空前文件 ${beforeSize} 字节）→ 再查 ${after.body.total} 条`,
  );
  ok(
    fs.existsSync(file) && fs.statSync(file).size === 0,
    `④ 清空后活跃文件回到**空态**（文件仍在、0 字节，界面显示"没有历史"而不是"文件不见了"）`,
  );

  // 清空后再敲：功能没被清坏（也顺手给跨会话/UI 段留证据）
  await typeIn(PROJ, s2.id, "echo E3_AFTER_CLEAR\r");
  await typeIn(PROJ, s2.id, CMD_ZH + "\r");
  const refill = await waitHistory(PROJ, (list) => list.length >= 2);
  ok(
    refill.filter((i) => i.command === "echo E3_AFTER_CLEAR").length === 1 && refill.some((i) => i.command === CMD_ZH),
    `④ 清空后继续记录正常（${refill.length} 条：echo E3_AFTER_CLEAR / ${CMD_ZH}）—— 清空是清数据，不是把功能关了`,
  );

  // 关会话（DoD③ 前半：关 pane 会话后仍能查）
  const closed = await api("DELETE", `/api/terminal/${s2.id}?project_id=${PROJ}`);
  const goneS1 = await api("DELETE", `/api/terminal/${s1.id}?project_id=${PROJ}`);
  await waitPidGone(s2.pid);
  ok(
    closed.body.removed === true && goneS1.body.removed === true && (await waitPidGone(s1.pid)),
    `③ 两个 pane 会话都关掉（removed=true，pid ${s1.pid} / ${s2.pid} 在 tasklist 查不到）`,
  );
  const afterClose = await getHistory(PROJ, "E3_AFTER_CLEAR");
  ok(
    (afterClose.body.total as number) === 1,
    `③ 会话关掉后历史照样查得到（q=E3_AFTER_CLEAR → ${afterClose.body.total} 条）—— 历史不跟着会话死`,
  );
}

// ───────────────────────── ③ HTTP 段 B：重启后跨会话仍可查 + 哨兵反证（DoD③，卡上跑偏点） ─────────────────────────

async function httpSectionB(): Promise<void> {
  console.log("\n[verify] ── ③ 跨会话（后端进程重启后）+ 哨兵反证（DoD③，PLAN E3 跑偏点）");

  // ── DoD③ 硬证据：进程重启了，历史文件还在，检索照样命中 ──
  const items = await waitHistory(PROJ, (list) => list.length >= 2);
  const commands = items.map((i) => i.command);
  ok(
    commands.includes("echo E3_AFTER_CLEAR") && commands.includes(CMD_ZH),
    `③ **重启后端进程后**仍能查到重启前敲的命令（${items.length} 条：${items.map((i) => mask(JSON.stringify(i.command))).join(" · ")}）`,
  );
  ok(
    items.every((i) => tataiSessionIds.has(i.session_id)),
    `③ 重启后查到的记录带着**上一进程的会话 id**（${[...new Set(items.map((i) => i.session_id))].join(",")}）—— 来源就是重启前那次 pane 会话`,
  );
  const hitAfterRestart = await getHistory(PROJ, "E3_AFTER_CLEAR");
  ok(
    hitAfterRestart.status === 200 && (hitAfterRestart.body.total as number) === 1,
    `③ 重启后关键字检索照样命中（q=E3_AFTER_CLEAR → ${hitAfterRestart.body.total} 条）：历史落盘在项目里，不随进程走`,
  );
  const missAfterRestart = await getHistory(PROJ, "E3_NO_SUCH_KEYWORD_ZZZ");
  ok((missAfterRestart.body.total as number) === 0, "③ 重启后不命中的关键字仍是 0 条（检索不是「全量返回」）");
  dumpHistory(historyFileOf(PROJ), "重启后落盘原文");

  // ── 跑偏点反证：shell 自己的历史文件不是数据源 ──
  const sentinelFiles = {
    "fake-histfile.txt ($HISTFILE)": path.join(SENTINEL_DIR, "fake-histfile.txt"),
    "ConsoleHost_history.txt (PowerShell)": path.join(
      SENTINEL_DIR,
      "Microsoft",
      "Windows",
      "PowerShell",
      "PSReadLine",
      "ConsoleHost_history.txt",
    ),
    ".bash_history（项目根里）": path.join(ROOT, ".bash_history"),
  };
  const fileText = readFileText(historyFileOf(PROJ));
  for (const [label, f] of Object.entries(sentinelFiles)) {
    const content = fs.readFileSync(f, "utf8");
    const sentinel = content.trim();
    ok(
      !fileText.includes(sentinel),
      `跑偏点反证：${label} 里的哨兵命令（${sentinel.replace("echo ", "")}）在塔台历史里**零命中**（后端启动时 $HISTFILE/APPDATA 就指着它）`,
    );
  }
  const snapAfterRun = sentinelSnapshot();
  ok(
    Object.keys(snapAfterRun).length === 3 &&
      Object.entries(snapAfterRun).every(([rel, text]) => text.includes("E3_SENTINEL_")),
    `哨兵文件共 3 个、都在"会被当成数据源"的位置且内容完好（塔台没读过更没改过它们）：${Object.keys(snapAfterRun).map((r) => mask(r)).join(" · ")}`,
  );

  // 另一条 shell 通道（不经塔台）里跑命令：不该出现在塔台历史里
  const directOut = runDirectShellCommand(`echo ${SENTINEL_DIRECT}`);
  const afterDirect = await getHistory(PROJ, SENTINEL_DIRECT);
  ok(
    directOut.includes(SENTINEL_DIRECT) && (afterDirect.body.total as number) === 0,
    `跑偏点反证：直连 shell（不经塔台）在项目根里跑 \`echo ${SENTINEL_DIRECT}\`（真输出：${directOut}）→ 塔台历史里 0 条命中 —— 塔台只记自己 pane 里敲的`,
  );

  // 往哨兵文件里追加"别的项目/别的会话的命令"，塔台历史依旧不受影响
  const foreign = "echo E3_FOREIGN_OTHER_PROJECT_ZZZ";
  fs.appendFileSync(sentinelFiles["fake-histfile.txt ($HISTFILE)"], foreign + "\n", "utf8");
  fs.appendFileSync(sentinelFiles[".bash_history（项目根里）"], foreign + "\n", "utf8");
  const afterForeign = await getHistory(PROJ, "E3_FOREIGN_OTHER_PROJECT_ZZZ");
  ok(
    (afterForeign.body.total as number) === 0,
    `跑偏点反证：往 $HISTFILE / .bash_history 追加"别的项目敲的命令"（${foreign}）后，塔台历史仍是 0 条 —— 塔台不把任何 shell 历史文件当数据源`,
  );

  // 数据源唯一性：历史里每条 session_id 都必须是本轮经塔台建出来的会话
  const all = await getHistory(PROJ, undefined, MAX_HISTORY_LIMIT);
  const sids = [...new Set((all.body.items as HistoryItem[]).map((i) => i.session_id))];
  const foreignSids = sids.filter((s) => !tataiSessionIds.has(s));
  ok(
    foreignSids.length === 0,
    `跑偏点反证：历史里的会话 id 全部来自本轮塔台的会话（${sids.join(",")} ⊆ 本轮建过的 ${[...tataiSessionIds].join(",")}），没有一个外来来源`,
  );
  ok(
    (all.body.items as HistoryItem[]).every((i) => i.project_id === PROJ),
    `跑偏点反证：历史里每条都带本项目 id（${PROJ}）—— 范围限定当前项目，不含别的项目命令`,
  );
}

// ───────────────────────── ④ UI 段：playwright（动态端口 + 探活） ─────────────────────────

async function uiPlaywright(specPath: string, backendPort: number): Promise<void> {
  fs.mkdirSync(VERIFY_DIR, { recursive: true });
  const pyPath = path.join(VERIFY_DIR, "e3-shot.py");
  fs.writeFileSync(pyPath, PY_SHOT, "utf8");
  let vitePort = 0;
  let vite: ChildProcess | null = null;
  for (let attempt = 1; attempt <= 3 && !vite; attempt++) {
    vitePort = await pickFreePort();
    const child = spawn(
      process.execPath,
      [path.join(REPO_ROOT, "node_modules", "vite", "bin", "vite.js"), "dev", "--port", String(vitePort), "--strictPort"],
      {
        stdio: ["ignore", "pipe", "pipe"],
        cwd: REPO_ROOT,
        env: { ...process.env, TATAI_DEV_API_PORT: String(backendPort) },
      },
    );
    pipeOutput(child, `vite:${vitePort}`);
    try {
      await waitUpAny(
        [`http://localhost:${vitePort}/`, `http://127.0.0.1:${vitePort}/`, `http://[::1]:${vitePort}/`],
        `vite ${vitePort}`,
        { timeoutMs: 90_000, isAlive: () => child.exitCode === null },
      );
      vite = child;
      console.log(`[verify]   vite ${vitePort} 已就绪（第 ${attempt} 次尝试）`);
    } catch (e) {
      console.log(`[verify]   vite 端口 ${vitePort} 起不来（第 ${attempt} 次）：${(e as Error).message}`);
      killTree(child, vitePort);
    }
  }
  if (!vite) {
    ok(false, "UI 段：vite 起不来（连续 3 个动态端口都失败）");
    return;
  }
  console.log(`[verify]   UI 段服务就绪：后端 ${backendPort}（动态端口）+ vite ${vitePort}（动态端口）`);
  try {
    const out = execSync(`python "${pyPath}" ${vitePort} ${backendPort} "${specPath}"`, {
      cwd: VERIFY_DIR,
      stdio: "pipe",
      timeout: 900_000,
      env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
    }).toString();
    process.stdout.write(out);
    ok(out.includes("UI_ASSERT_ALL_PASS"), "② ④ UI 段：历史面板列出 / 搜索过滤 / 一键回填未执行 / 二次确认清空 全过");
  } catch (e) {
    process.stdout.write((e as { stdout?: Buffer }).stdout?.toString() ?? "");
    process.stderr.write((e as { stderr?: Buffer }).stderr?.toString() ?? "");
    ok(false, "UI 段执行失败（见上方输出）");
  } finally {
    killTree(vite, vitePort);
    await sleep(500);
  }
  for (const f of [
    "e3-01-history-panel.png",
    "e3-02-search-filter.png",
    "e3-03-fill-no-exec.png",
    "e3-04-clear-confirm.png",
    "e3-05-cleared.png",
  ]) {
    ok(fs.existsSync(path.join(VERIFY_DIR, f)), `UI 产物落盘 .工作台/verify/${f}`);
  }
}

/** UI 段 python（playwright 写法同 verify-e1/e2；参数走一段 JSON 文件） */
const PY_SHOT = String.raw`# E3 UI 验证：命令历史面板（列出 / 搜索过滤 / 一键回填不执行 / 二次确认清空）
# 用法：python e3-shot.py <vitePort> <backendPort> <spec.json>
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

from playwright.sync_api import sync_playwright

VITE_PORT, BACKEND_PORT, SPEC_PATH = sys.argv[1], sys.argv[2], sys.argv[3]
SPEC = json.load(open(SPEC_PATH, encoding="utf-8"))
BASE = "http://localhost:" + VITE_PORT
API = "http://127.0.0.1:" + BACKEND_PORT
PID = SPEC["project"]
MARKER_CMD = SPEC["marker_cmd"]      # 面板里点它回填（输出是一个独占一行的标记）
MARKER = SPEC["marker"]
FILTER_CMD = SPEC["filter_cmd"]      # 搜索关键字命中它
FILTER_KEY = SPEC["filter_key"]

fails = []
PAGE = None
OUT = "."


def ok(cond, label):
    print(("[UI PASS] " if cond else "[UI FAIL] ") + label)
    if not cond:
        fails.append(label)


def api(method, path, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(
        API + path, data=data, method=method, headers={"content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode())


def pane(idx):
    return PAGE.locator("[data-terminal-pane-index='%d']" % idx)


def pane_text(idx):
    return pane(idx).locator(".xterm").first.inner_text()


def marker_lines(text):
    """终端可见文本里"独占一行的标记"条数：回填不执行时这个数不该变，执行了才 +1。"""
    return sum(1 for line in text.splitlines() if line.strip() == MARKER)


def wait_text(idx, needle, timeout=40):
    t0 = time.time()
    while time.time() - t0 < timeout:
        t = pane_text(idx)
        if needle in t:
            return t
        time.sleep(0.3)
    raise AssertionError("pane %d 输出未含 %r，当前: %r" % (idx, needle, pane_text(idx)[-200:]))


def type_in(idx, text):
    pane(idx).locator(".xterm").first.click()
    PAGE.keyboard.type(text)
    PAGE.keyboard.press("Enter")


def shot(name, clip=None):
    PAGE.screenshot(path=os.path.join(OUT, name), clip=clip)
    print("[info] 截图 " + name)


def wait_attr(idx, name, timeout=30):
    t0 = time.time()
    while time.time() - t0 < timeout:
        v = pane(idx).get_attribute(name)
        if v:
            return v
        time.sleep(0.2)
    raise AssertionError("pane %d 的 %s 迟迟为空" % (idx, name))


def wait_history_rows(min_rows, timeout=30, keyword=None):
    """等历史面板里的条数稳定到 >= min_rows（记录是"输出静默后"才落盘的，测试必须等）。"""
    t0 = time.time()
    rows = []
    while time.time() - t0 < timeout:
        if keyword:
            rows = pane(0).locator("[data-terminal-history-item][data-terminal-history-command*='%s']" % keyword).all()
        else:
            rows = pane(0).locator("[data-terminal-history-item]").all()
        if len(rows) >= min_rows:
            return rows
        time.sleep(0.3)
    return rows


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1680, "height": 1100})
    PAGE = page
    page_errors = []
    page.on("pageerror", lambda e: page_errors.append(str(e)))
    page.goto(BASE + "/#p/" + PID)
    page.wait_for_selector("text=项目管理", timeout=20000)
    page.locator("nav button:has-text('终端')").click()
    page.wait_for_selector("[data-terminal-view]", timeout=20000)
    page.wait_for_selector("[data-terminal-pane] .xterm", timeout=20000)
    # 会话没建好之前敲键会被丢：必须等 data-terminal-sid 落地再敲（pane 的 onData 要 sessionId 才有出口）
    sid0 = wait_attr(0, "data-terminal-sid")
    print("[info] pane 会话已就绪: " + sid0)

    # ── 从 UI 真敲三条命令（这才是"本人经塔台 pane 输入"）──
    type_in(0, "echo " + MARKER)
    wait_text(0, MARKER)
    ok(len(pane_text(0).strip()) > 0,
       "pane 是活的（敲一条后终端里真有输出与提示符）: %r" % pane_text(0).splitlines()[-1][-40:])
    type_in(0, FILTER_CMD)
    wait_text(0, FILTER_KEY)
    type_in(0, "echo E3_UI_THIRD")
    wait_text(0, "E3_UI_THIRD")
    ok(pane(0).get_attribute("data-terminal-history-open") == "off",
       "历史面板默认收起（data-terminal-history-open=off），不占终端可视区")
    ok("历史：关" in pane(0).locator("[data-terminal-history-toggle]").inner_text(),
       "头部入口文案 = 「历史：关」: %s" % pane(0).locator("[data-terminal-history-toggle]").inner_text())

    # ── 打开历史面板：列出（时间倒序）+ cwd ──
    pane(0).locator("[data-terminal-history-toggle]").click()
    page.wait_for_selector("[data-terminal-history-panel]", timeout=10000)
    rows = wait_history_rows(3, timeout=40)
    ok(len(rows) >= 3, "② 面板列出本项目历史 %d 条（跨会话、时间倒序）" % len(rows))
    ok(pane(0).get_attribute("data-terminal-history-open") == "on",
       "点头部「历史」→ 面板展开（data-terminal-history-open=on）")
    cmds = [r.get_attribute("data-terminal-history-command") for r in rows]
    cwds = [r.get_attribute("data-terminal-history-cwd") for r in rows]
    print("[info] 面板条目（最新在前）: " + repr(cmds[:5]))
    print("[info] 每条带 cwd: " + repr(cwds[:3]))
    ok(cmds[0] == "echo E3_UI_THIRD", "② 首条 = 最后敲的「echo E3_UI_THIRD」（时间倒序）")
    ok(all(len(c) > 0 for c in cwds), "② 每条都列出 cwd（%s）" % (cwds[0] if cwds else "?"))
    ts_cell = rows[0].inner_text()
    ok(("20" in ts_cell) and ("echo E3_UI_THIRD" in ts_cell),
       "② 每条显示时间戳 + 命令: %r" % ts_cell[:80])
    shot("e3-01-history-panel.png")

    # ── 搜索框实时过滤 ──
    page.fill("[data-terminal-history-search]", FILTER_KEY)
    page.wait_for_timeout(900)
    filtered = pane(0).locator("[data-terminal-history-item]").all()
    fcmds = [r.get_attribute("data-terminal-history-command") for r in filtered]
    print("[info] 过滤后条目: " + repr(fcmds))
    ok(len(filtered) >= 1 and len(filtered) < len(rows) and all(FILTER_KEY in c for c in fcmds),
       "② 搜索框输入 %r → 只留命中项 %d 条（过滤前 %d 条）: %s" % (FILTER_KEY, len(filtered), len(rows), fcmds))
    shot("e3-02-search-filter.png")

    # 搜不存在的关键字 → 空态
    page.fill("[data-terminal-history-search]", "E3_UI_NO_SUCH_ZZZ")
    page.wait_for_timeout(900)
    ok(pane(0).locator("[data-terminal-history-empty]").count() == 1,
       "② 搜不存在的关键字 → 明确空态提示（不是空白列表）")
    page.fill("[data-terminal-history-search]", FILTER_KEY)
    page.wait_for_timeout(900)
    wait_history_rows(1, keyword=FILTER_KEY)

    # ── 一键回填：命令进输入行、**不执行** ──
    # 搜索框里再改成回填目标那条（顺带证明"搜索 + 回填"能连着用）
    page.fill("[data-terminal-history-search]", MARKER)
    page.wait_for_timeout(900)
    rows = wait_history_rows(1, keyword=MARKER, timeout=20)
    before = marker_lines(pane_text(0))
    print("[info] 回填前终端里独占一行的标记 %r 有 %d 行" % (MARKER, before))
    target = [r for r in rows
              if r.get_attribute("data-terminal-history-command") == "echo " + MARKER]
    assert target, "面板里没找到「echo %s」这条" % MARKER
    target[0].locator("[data-terminal-history-pick]").click()
    page.wait_for_timeout(1200)
    after_text = pane_text(0)
    after = marker_lines(after_text)
    print("[info] 回填后终端里独占一行的标记有 %d 行" % after)
    ok(before == after,
       "② 点一条 → 命令进了输入行但**没有执行**（独占一行的输出标记 %d → %d 行，未变；执行了才会 +1）" % (before, after))
    tail = [l for l in after_text.splitlines() if l.strip()]
    ok(("echo " + MARKER) in (tail[-1] if tail else ""),
       "② 回填落在输入行（最后一行是提示符 + 这条命令，没被回车带走）: %r" % (tail[-1][-60:] if tail else ""))
    ok(pane(0).locator("[data-terminal-history-panel]").count() == 0,
       "② 回填后面板自动收起，用户能直接看到输入行")
    ok("未执行" in pane(0).locator("[data-terminal-history-fill-note]").inner_text(),
       "② pane 上给出「已回填到输入行（未执行）」提示: %s" % pane(0).locator("[data-terminal-history-fill-note]").inner_text())
    shot("e3-03-fill-no-exec.png")

    # 回车才执行（证明回填的内容是真命令，不是摆设）
    pane(0).locator(".xterm").first.click()
    PAGE.keyboard.press("Enter")
    page.wait_for_timeout(1200)
    executed = marker_lines(pane_text(0))
    ok(executed == before + 1,
       "② 用户按下回车才执行（标记行 %d → %d，正好 +1）—— 回填与执行分得开" % (after, executed))

    # ── 清空：二次确认 + 生效 ──
    pane(0).locator("[data-terminal-history-toggle]").click()
    page.wait_for_selector("[data-terminal-history-panel]", timeout=10000)
    wait_history_rows(1, timeout=30)
    pane(0).locator("[data-terminal-history-clear]").click()
    page.wait_for_selector("[data-terminal-history-confirm]", timeout=5000)
    ok(pane(0).locator("[data-terminal-history-list]").count() == 1,
       "④ 点「清空」先出**二次确认**（历史还在、没当场删）—— 隐私删除权与手滑保护两头都要")
    shot("e3-04-clear-confirm.png")
    # 先点取消：确认框消失、历史仍在
    pane(0).locator("[data-terminal-history-confirm-no]").click()
    page.wait_for_timeout(400)
    ok(pane(0).locator("[data-terminal-history-confirm]").count() == 0
       and len(pane(0).locator("[data-terminal-history-item]").all()) >= 1,
       "④ 点「取消」→ 确认框消失、历史一条没少（取消是真取消）")
    # 再走一遍并确认清空
    pane(0).locator("[data-terminal-history-clear]").click()
    page.wait_for_selector("[data-terminal-history-confirm]", timeout=5000)
    pane(0).locator("[data-terminal-history-confirm-yes]").click()
    page.wait_for_timeout(1200)
    ok(pane(0).locator("[data-terminal-history-item]").count() == 0
       and pane(0).locator("[data-terminal-history-empty]").count() == 1,
       "④ 确认清空 → 列表空、空态提示上屏（本项目历史已删）")
    ok("已清空本项目历史" in pane(0).locator("[data-terminal-history-note]").inner_text(),
       "④ 清空后给出条数提示: %s" % pane(0).locator("[data-terminal-history-note]").inner_text())
    shot("e3-05-cleared.png")

    # 清空后后端确实 0 条（接口侧复核，防"界面清了、文件没清"）
    st, body = api("GET", "/api/projects/" + urllib.parse.quote(PID) + "/terminal/history")
    ok(st == 200 and body.get("total") == 0,
       "④ 清空后接口复核 total=%s（界面与落盘一致）" % body.get("total"))

    ok(not page_errors, "全过程零页面 JS 异常（%s）" % ("；".join(page_errors[:2]) if page_errors else "无"))
    browser.close()

print("UI_ASSERT_ALL_PASS" if not fails else "UI_ASSERT_FAILS:%d" % len(fails))
`;

// ───────────────────────── 主流程 ─────────────────────────

async function main(): Promise<void> {
  console.log("[verify] ── 端口：先探 8787 / 5173 是不是别人的（本脚本一律动态端口，绝不杀既有监听）");
  const fixedBefore = { v: await portListening(8787), d: await portListening(5173) };
  console.log(
    `[verify]   8787 ${fixedBefore.v ? "有人监听（别人的，不碰）" : "空闲"} · 5173 ${fixedBefore.d ? "有人监听（别人的，不碰）" : "空闲"}`,
  );

  buildFixture();
  const sentinelBefore = sentinelSnapshot();
  await moduleSection();

  const specPath = path.join(VERIFY_DIR, "e3-spec.json");
  const MARKER = "E3_UI_PICK_MARKER";
  fs.writeFileSync(
    specPath,
    JSON.stringify(
      {
        project: PROJ,
        projectRoot: ROOT,
        marker_cmd: `echo ${MARKER}`,
        marker: MARKER,
        filter_cmd: "echo E3_UI_FILTER_ZZZ",
        filter_key: "E3_UI_FILTER_ZZZ",
      },
      null,
      2,
    ),
    "utf8",
  );

  // 阶段 A：动态端口起后端 → 真 PTY 敲命令 → 检索 → 清空 → 重敲 → 关会话
  const port = await pickFreePort();
  let backend: ChildProcess | null = null;
  try {
    console.log(`\n[verify] ── 起后端 A（动态端口 ${port}，TATAI_HOME=临时目录，$HISTFILE/APPDATA 指向哨兵）`);
    backend = await startBackend(port);
    base = `http://127.0.0.1:${port}`;
    ok(true, `后端 A 已就绪：动态端口 ${port}（探活通过，TATAI_HOME=${path.relative(REPO_ROOT, HOME_DIR)}）`);
    await httpSectionA();
  } finally {
    if (backend) killTree(backend, port);
    await sleep(1000);
  }

  // 阶段 B：**重启后端进程**（DoD③ 硬证据）→ 同一端口、同一 TATAI_HOME 再起
  console.log(`\n[verify] ── 重启后端（同一动态端口 ${port}、同一 TATAI_HOME）：跨会话硬证据`);
  ok(!(await portListening(port)), `③ 后端 A 已停干净（端口 ${port} 已释放），没有残留进程`);
  let backend2: ChildProcess | null = null;
  try {
    backend2 = await startBackend(port);
    base = `http://127.0.0.1:${port}`;
    ok(true, `后端 B 已就绪（端口 ${port}，进程换了、注册表与历史文件没换）`);
    await httpSectionB();

    // 哨兵文件跑完仍与开机时逐字节一致（塔台没读过/没改过 shell 自己的历史文件）
    const sentinelAfter = sentinelSnapshot();
    const same = Object.keys(sentinelBefore).every(
      (k) => sentinelBefore[k].split("\n")[0] === sentinelAfter[k].split("\n")[0],
    );
    ok(same, "跑偏点反证（文件侧）：三个哨兵文件的**原有内容逐字节未变**（塔台只读自己落的盘）");

    console.log("\n[verify] ── ④ UI 段：起 vite（动态端口）+ playwright 真开 pane（敲 → 历史 → 搜索 → 回填 → 清空）");
    await uiPlaywright(specPath, port);

    // UI 段结束后：清空动作已由界面执行，这里复核接口与文件
    const final = await getHistory(PROJ, undefined, MAX_HISTORY_LIMIT);
    const finalFile = historyFileOf(PROJ);
    ok(
      (final.body.total as number) === 0 && fs.statSync(finalFile).size === 0,
      `④ UI 二次确认清空后：接口 0 条、活跃文件 ${fs.statSync(finalFile).size} 字节（界面清空与落盘一致）`,
    );
  } finally {
    if (backend2) killTree(backend2, port);
    await sleep(1000);
  }

  // git 自查：`.工作台/` 永不进仓库
  console.log("\n[verify] ── ① git 自查：`.工作台/` 不进仓库（AGENTS.md §6 开源红线）");
  const porcelain = execSync("git status --porcelain", { cwd: REPO_ROOT }).toString();
  const workbenchLines = porcelain.split(/\r?\n/).filter((l) => l.includes(".工作台"));
  ok(
    workbenchLines.length === 0,
    `① \`git status --porcelain\` 里**零 \`.工作台/\` 行**（历史文件、截图、夹具全都看不见）：${porcelain.split(/\r?\n/).filter(Boolean).length} 行改动，含 .工作台 的 0 行`,
  );
  ok(
    !porcelain.includes("terminal-history"),
    "① git 里也看不到任何历史文件（文件名零出现）",
  );

  console.log("\n[verify] ── 收尾：进程杀净 + 动态端口释放 + 8787/5173 仍是别人的 + 夹具清理");
  ok(!(await portListening(port)), `收尾：动态端口 ${port} 已释放（进程杀净）`);
  const fixedAfter = { v: await portListening(8787), d: await portListening(5173) };
  ok(
    fixedBefore.v === fixedAfter.v && fixedBefore.d === fixedAfter.d,
    `收尾：8787/5173 状态与开工前一致（${fixedAfter.v ? "有人在用" : "空闲"} / ${fixedAfter.d ? "有人在用" : "空闲"}）—— 本脚本没占用、没杀 PID`,
  );
  fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
  fs.rmSync(HOME_DIR, { recursive: true, force: true });
  fs.rmSync(SENTINEL_DIR, { recursive: true, force: true });
  ok(
    !fs.existsSync(FIXTURE_DIR) && !fs.existsSync(HOME_DIR) && !fs.existsSync(SENTINEL_DIR),
    "收尾：临时夹具（e3-fixture / e3-home / e3-sentinel）已删除，真实注册表与真实项目零触碰",
  );
}

main()
  .then(() => console.log(process.exitCode ? "[verify] 存在 FAIL" : "[verify] 全部 PASS"))
  .catch((e) => {
    console.error("[verify] 异常:", e);
    process.exitCode = 1;
  });
