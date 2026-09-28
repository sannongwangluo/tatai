// E2 验证脚本（用 tsx 跑）：日志着色（PLAN.md E2 卡 DoD①–④ + 卡上「跑偏点」红线）。
// 用法：pnpm verify:e2
//
// 覆盖点（逐条对 DoD）：
//   ① **带 ANSI 的字节证据**（DoD①）：拿真 PTY 流，贴"源字节 hex（无 SGR）"与"着色后同一窗口 hex
//      （含 1b5b33316d / 1b5b33336d / 1b5b33366d / 1b5b39306d）"两段对照；UI 段再数渲染层上色单元，
//      开着色的 pane 有 ≥4 种颜色、关着色的 pane 为 0（界面描述证据）。
//   ② **关闭着色 = 源字节**（DoD②）：`renderLogChunk(raw, state, false)` 与 `raw` 在**真实 PTY 流**上
//      逐字节相等（Buffer.compare === 0）；写路径唯一（源码护栏：pane 里只有一处 `term.write`，参数就是 renderLogChunk）。
//   ③ **导出与源逐字节一致**（DoD③，本卡第一红线）：UI 段在 pane 之外另开一条**同会话 SSE** 原样记录服务端推的字节，
//      pane 的「导出原始输出」落盘后必须**以这串源字节逐字节结尾**；导出里程序自己发的 ANSI 序列（`\x1b[31mRED`）
//      原样保留、而本层注入的序列（`\x1b[31mERROR` 等）**不得出现**在导出里。
//      另加"只插不改不吞"不变量：着色后输出是源的**超序列**（逐字节按序走完源），且源里每条转义序列在着色后
//      按序一条不少。
//   ④ **零新依赖**（DoD④）：`logColor.ts` 零 import、pane 的外部 import 仍只有 react/@xterm/*；
//      顺手贴既有 @xterm/xterm 的 LICENSE 原文关键句（本次未新增依赖，故无需核对新许可证）。
//   ⑤ **原始输出缓冲上限**（2026-09-18 Q44 审计修复）：`rawRef` 超限丢头留尾（`rawBuffer.ts` 的边界用例：
//      未超限原样 / 超限守恒 / 代理对不劈 / pane 循环喂 20 MiB 后恒定在上限内）+ pane 源码护栏
//      （走同一个 trimRawBuffer、截断后界面标出）——上限之内的会话导出仍逐字节等于源，超限的是如实降级。
//   附：chunk 边界无关（把真实 PTY 流按 1/7/64 字符切开发给着色层，结果与整串一致）；词边界（broken/look/OKAY 不上色）；
//      ANSI 透传优先（程序自己上色的那段不插色）。
//
// 端口策略（同 verify-e1）：**不碰任何既有监听**——后端与 vite 都 bind 0 让系统分配，vite 经
// TATAI_DEV_API_PORT 代理到动态后端；起前探活、起后盯早退；开头末尾各探一次 8787/5173（只记录不杀）。
// 夹具（全部在 gitignore 的 `.工作台/verify/` 内，跑完删）：`.工作台/verify/e2-home`（临时 TATAI_HOME，不碰真实注册表）
// + `.工作台/verify/e2-fixture/p`（临时项目根，终端 cwd 锁它）。截图/导出落 `.工作台/verify/e2-*`（gitignore）。
import { execSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { addProject } from "../src/server/registry";
import {
  createLogColorState,
  flushLogColor,
  LOG_COLOR_RULES,
  renderLogChunk,
  stripAnsi,
  type LogColorState,
} from "../src/ui/terminal/logColor";
import * as rawBuffer from "../src/ui/terminal/rawBuffer";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VERIFY_DIR = path.join(REPO_ROOT, ".工作台", "verify");
const HOME_DIR = path.join(VERIFY_DIR, "e2-home");
const FIXTURE_DIR = path.join(VERIFY_DIR, "e2-fixture");
const PROJ = "e2-fix";
const ROOT = path.join(FIXTURE_DIR, "p");
/** 读仓库内文件（相对仓库根）：源码护栏与模块层共用 */
const read = (f: string) => fs.readFileSync(path.join(REPO_ROOT, f), "utf8");
/** 先剥 // 注释再扫，防"注释里提到"假通过 */
const strip = (s: string) => s.replace(/\/\/[^\n]*/g, "");

// 验证命令：全部用 `String.fromCharCode(27)` 造 ESC，躲开 cmd / TS / Python / playwright 四层转义。
// 五级日志（中英文关键词都在表里，UI 段只跑英文那五条，中文走 HTTP 段真 PTY 流）
const FIVE_LEVEL_CMD =
  "node -e \"console.log('INFO ok');console.log('WARN slow');console.error('ERROR boom');console.log('DEBUG trace');console.error('FATAL dead')\"";
const ZH_CMD = "node -e \"console.log('失败 异常 警告 成功 完成 调试')\"";
// 程序自己发 ANSI：输出 12 字节 `ESC[31m RED ESC[0m`（DoD③ 要证明这条序列不被着色层吞掉/改写）
const ANSI_CMD =
  "node -e \"process.stdout.write(String.fromCharCode(27)+'[31mRED'+String.fromCharCode(27)+'[0m')\"";

const ok = (cond: boolean, label: string) => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (!cond) process.exitCode = 1;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hex = (s: string) => Buffer.from(s, "utf8").toString("hex");
const sameBytes = (a: string, b: string) =>
  Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")) === 0;

/** 取 needle 在 s 里最后一次出现处的 hex 窗口（前后各带一小段，便于肉眼核对照） */
function hexWindow(s: string, needle: string, before = 24, after = 40): string {
  const i = s.lastIndexOf(needle);
  if (i < 0) return `未找到 ${JSON.stringify(needle)}`;
  const from = Math.max(0, i - before);
  return `${hex(s.slice(from, i))}|${hex(needle)}|${hex(s.slice(i + needle.length, i + needle.length + after))}`;
}

/** needle 最后一次出现处前后各取一段（取不到返回空串） */
function windowAround(s: string, needle: string, before: number, after: number): string {
  const i = s.lastIndexOf(needle);
  if (i < 0) return "";
  return s.slice(Math.max(0, i - before), i + needle.length + after);
}

/** raw 里的转义序列（按序）。用于"着色不吃掉程序自己的 ANSI"——序列在着色后必须按序一条不少 */
const ESC_LIST_RE = /\u001b\[[0-9;?<>=]*[ -/]*[@-~]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)?|\u001b[@-Z\\-_]/g;
const escList = (s: string) => s.match(ESC_LIST_RE) ?? [];
function isSubsequenceList<T>(sub: T[], whole: T[]): boolean {
  let i = 0;
  for (const item of whole) {
    if (i < sub.length && item === sub[i]) i++;
  }
  return i === sub.length;
}

/** candidate 是否含 source 的全部字节（按序、可插不可删改）。返回 -1 表示是（空位=卡住位置） */
function subsequenceStuckAt(source: string, candidate: string): number {
  const a = Buffer.from(source, "utf8");
  const b = Buffer.from(candidate, "utf8");
  let i = 0;
  for (const byte of b) {
    if (i < a.length && byte === a[i]) i++;
  }
  return i === a.length ? -1 : i;
}

/** 把 s 按 size 字符切片，逐片过着色层（模拟 SSE 分片），最后补吐扣住的尾巴 */
function renderInChunks(s: string, size: number, enabled = true): string {
  const state = createLogColorState();
  let out = "";
  for (let i = 0; i < s.length; i += size) out += renderLogChunk(s.slice(i, i + size), state, enabled);
  out += flushLogColor(state);
  return out;
}

// ───────────────────────── 端口：探活 + 动态分配（与 verify-e1 同一份写法） ─────────────────────────

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

async function startService(
  label: string,
  port: number,
  spawnFn: (port: number) => ChildProcess,
  readyUrls: string[],
): Promise<ChildProcess> {
  if (await portListening(port)) {
    throw new Error(`${label} 端口 ${port} 已被占用（本脚本不碰既有监听，请重跑）`);
  }
  const child = spawnFn(port);
  pipeOutput(child, `${label}:${port}`);
  child.once("exit", (code) => {
    if (!intentionalStop.has(port) && code !== 0) {
      console.error(`[verify] ${label}（端口 ${port}）意外退出：code=${code}（端口被抢？）`);
    }
  });
  await waitUpAny(readyUrls, `${label} ${port}`, { isAlive: () => child.exitCode === null });
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

// ───────────────────────── 夹具：临时 TATAI_HOME + 临时项目根 ─────────────────────────

function buildFixture(): void {
  fs.rmSync(HOME_DIR, { recursive: true, force: true });
  fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
  fs.mkdirSync(HOME_DIR, { recursive: true });
  fs.mkdirSync(ROOT, { recursive: true });
  addProject({ id: PROJ, name: "E2 验证项目", path: ROOT, kind: "backend" }, HOME_DIR);
  console.log(
    `[verify] 夹具就绪：TATAI_HOME=${path.relative(REPO_ROOT, HOME_DIR)} · 项目根 ${path.relative(REPO_ROOT, ROOT)}（终端 cwd 锁它）`,
  );
}

// ───────────────────────── HTTP/SSE 客户端 ─────────────────────────

interface ApiResp {
  status: number;
  body: {
    ok?: boolean;
    session?: SessionInfo;
    removed?: boolean;
    exit?: { exitCode: number } | null;
    error?: { code: string; message: string };
  };
}

interface SessionInfo {
  id: string;
  projectId: string;
  pid: number;
  cwd: string;
  cols: number;
  rows: number;
  exited: boolean;
}

let base = "";

async function api(method: string, rawPath: string, body?: unknown): Promise<ApiResp> {
  const res = await fetch(`${base}${rawPath}`, {
    method,
    ...(body !== undefined
      ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
      : {}),
  });
  return { status: res.status, body: (await res.json()) as ApiResp["body"] };
}

async function newSession(projectId: string, cols = 120, rows = 30): Promise<SessionInfo> {
  const r = await api("POST", `/api/projects/${encodeURIComponent(projectId)}/terminal`, { cols, rows });
  if (r.status !== 200 || !r.body.session) {
    throw new Error(`建会话失败：${r.status} ${JSON.stringify(r.body)}`);
  }
  return r.body.session;
}

interface StreamHandle {
  text(): string;
  waitFor(needle: string, timeoutMs?: number): Promise<string>;
}

/** 连某个会话的 SSE（带项目范围），把 data 事件里的输出累起来 */
async function openStream(sid: string, projectId: string): Promise<StreamHandle> {
  const res = await fetch(
    `${base}/api/terminal/${encodeURIComponent(sid)}/out?project_id=${encodeURIComponent(projectId)}`,
  );
  if (res.status !== 200) throw new Error(`SSE 连接失败：${res.status}`);
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let text = "";
  let buf = "";
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let sep: number;
        while ((sep = buf.indexOf("\n\n")) !== -1) {
          const block = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          for (const line of block.split("\n")) {
            if (!line.startsWith("data: ")) continue;
            const ev = JSON.parse(line.slice(6)) as { data?: string };
            if (typeof ev.data === "string") text += ev.data;
          }
        }
      }
    } catch {
      // 收尾杀服务端是正常终态
    }
  })();
  return {
    text: () => text,
    waitFor: async (needle, timeoutMs = 30_000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (text.includes(needle)) return text;
        await sleep(100);
      }
      throw new Error(`等待超时：输出未含 ${needle}。当前输出：${JSON.stringify(text.slice(-400))}`);
    },
  };
}

function typeIn(projectId: string, sid: string, data: string): Promise<ApiResp> {
  return api(
    "POST",
    `/api/terminal/${encodeURIComponent(sid)}/in?project_id=${encodeURIComponent(projectId)}`,
    { data },
  );
}

// ───────────────────────── ① 模块层：着色规则 / 关闭态字节相等 / 只插不改不吞 / 词边界 ─────────────────────────

const SAMPLE =
  "INFO ok\nWARN slow\nERROR boom\nDEBUG trace\nFATAL dead\n失败 连接超时\n异常 空指针\n警告 磁盘紧张\n成功 完成 就绪\n调试 详细日志\n";

function moduleSection(): void {
  console.log("\n[verify] ── ① 模块层：规则表 / 关闭态逐字节相等 / 只插不改不吞 / 词边界（DoD①②③）");

  const levels = LOG_COLOR_RULES.map((r) => `${r.level}->${r.sgr}`);
  const allKw = LOG_COLOR_RULES.flatMap((r) => r.keywords);
  ok(
    levels.join(" ") === "error->31 warn->33 info->36 debug->90",
    `规则表：红/黄/蓝绿/灰四级 = ${levels.join(" · ")}（ERROR/FATAL/失败/异常 红 · WARN/警告 黄 · INFO/OK/成功/完成 蓝绿 · DEBUG 灰）`,
  );
  ok(
    ["ERROR", "FATAL", "失败", "异常", "WARN", "警告", "INFO", "OK", "成功", "完成", "DEBUG"].every((k) =>
      allKw.includes(k),
    ),
    `关键词表含中英文：共 ${allKw.length} 条（${allKw.slice(0, 6).join("/")}…${allKw.slice(-3).join("/")}）`,
  );

  const colored = renderLogChunk(SAMPLE, createLogColorState(), true);
  console.log("[verify]   五级样例源字节 hex（片段）:");
  console.log(`[verify]     ERROR 处 raw : ${hexWindow(SAMPLE, "ERROR", 4, 12)}`);
  console.log(`[verify]     ERROR 处 着色: ${hexWindow(colored, "ERROR", 0, 0)}`);
  console.log(`[verify]     WARN  处 着色: ${hexWindow(colored, "WARN")}`);
  console.log(`[verify]     INFO  处 着色: ${hexWindow(colored, "INFO")}`);
  console.log(`[verify]     DEBUG 处 着色: ${hexWindow(colored, "DEBUG")}`);
  console.log(`[verify]     失败   处 着色: ${hexWindow(colored, "失败")}`);
  const expect: Array<[string, string]> = [
    ["\u001b[31mERROR\u001b[39m", "红 ERROR"],
    ["\u001b[31mFATAL\u001b[39m", "红 FATAL"],
    ["\u001b[31m失败\u001b[39m", "红 失败"],
    ["\u001b[31m异常\u001b[39m", "红 异常"],
    ["\u001b[33mWARN\u001b[39m", "黄 WARN"],
    ["\u001b[33m警告\u001b[39m", "黄 警告"],
    ["\u001b[36mINFO\u001b[39m", "蓝绿 INFO"],
    ["\u001b[36mok\u001b[39m", "蓝绿 ok（样例里是小写，规则表大小写不敏感）"],
    ["\u001b[36m成功\u001b[39m", "蓝绿 成功"],
    ["\u001b[36m完成\u001b[39m", "蓝绿 完成"],
    ["\u001b[90mDEBUG\u001b[39m", "灰 DEBUG"],
    ["\u001b[90m调试\u001b[39m", "灰 调试"],
  ];
  const missing = expect.filter(([needle]) => !colored.includes(needle)).map(([, label]) => label);
  ok(
    missing.length === 0,
    `① 中英文各级关键词都按表上色（${expect.length} 条全中：${expect.map(([, l]) => l).join("、")}｜未命中：${missing.join("/") || "无"}）`,
  );
  ok(
    renderLogChunk("info ok / Info Ok\n", createLogColorState(), true) ===
      "\u001b[36minfo\u001b[39m \u001b[36mok\u001b[39m / \u001b[36mInfo\u001b[39m \u001b[36mOk\u001b[39m\n",
    "① 英文关键词大小写不敏感、原文大小写一个字不改（info/Info/Ok 都上色）",
  );

  // 关闭态 = 原样字节
  ok(
    sameBytes(renderLogChunk(SAMPLE, createLogColorState(), false), SAMPLE),
    `② 关闭着色：renderLogChunk(raw, state, false) 与 raw 逐字节相等（${Buffer.byteLength(SAMPLE)} 字节，Buffer.compare === 0）`,
  );

  // 只插不改不吞
  const stuck = subsequenceStuckAt(SAMPLE, colored);
  ok(
    stuck === -1,
    `③ 只插不改不吞：着色后输出是源的**超序列**（逐字节按序走完源 ${Buffer.byteLength(SAMPLE)} 字节，一个不吞不乱序）`,
  );
  ok(
    stripAnsi(colored) === stripAnsi(SAMPLE),
    `③ 剥掉全部转义后可见文本与源完全一致（${[...stripAnsi(SAMPLE)].length} 个字符逐字符相同）`,
  );
  ok(
    isSubsequenceList(escList(SAMPLE), escList(colored)) && escList(colored).length > escList(SAMPLE).length,
    `③ 源里每条转义序列在着色后按序一条不少（源 ${escList(SAMPLE).length} 条 → 着色后 ${escList(colored).length} 条，只增不删）`,
  );
  ok(
    renderLogChunk("no keyword here at all\n", createLogColorState(), true) === "no keyword here at all\n",
    "③ 没有关键词的行：开着色也逐字节原样（零改动，不无脑重写）",
  );

  // chunk 边界无关（SSE 一条消息不保证切在整行上）
  const whole = renderLogChunk(SAMPLE, createLogColorState(), true);
  const chunked = [1, 2, 3, 7, 64].map((n) => renderInChunks(SAMPLE, n) === whole);
  ok(
    chunked.every(Boolean),
    `③ chunk 边界无关：按 1/2/3/7/64 字符切开发给着色层，结果与整串处理逐字节一致（${chunked.map((b) => (b ? "OK" : "X")).join("/")}）`,
  );

  // 词边界
  const edge = renderLogChunk("broken look OKAY sync\n", createLogColorState(), true);
  ok(
    edge === "broken look OKAY sync\n",
    `③ 词边界：broken / look / OKAY / sync 一律不上色（不咬进更长的词里）—— 实际 ${JSON.stringify(edge)}`,
  );
  ok(
    renderLogChunk("ERROR: x\n", createLogColorState(), true) === "\u001b[31mERROR\u001b[39m: x\n",
    "③ ERROR: x → 只给 ERROR 三个字母上色，冒号与正文原样",
  );

  // ANSI 透传优先
  const passthrough = renderLogChunk("\u001b[35mINFO magenta\u001b[0m INFO plain\n", createLogColorState(), true);
  ok(
    passthrough === "\u001b[35mINFO magenta\u001b[0m \u001b[36mINFO\u001b[39m plain\n",
    `③ ANSI 透传优先：程序自己上色的那段原样不动、复位后本层才接管 —— 实际 ${JSON.stringify(passthrough)}`,
  );
}

// ───────────────────────── ② 真实 PTY 流：字节证据 + 关闭态逐字节相等 ─────────────────────────

async function httpSection(): Promise<void> {
  console.log("\n[verify] ── ② 真实 PTY 流：着色前后 hex 对照 + 关闭态逐字节相等（DoD①②③）");
  const session = await newSession(PROJ, 120, 30);
  const stream = await openStream(session.id, PROJ);
  await sleep(1200); // 等 cmd 首帧提示符

  await typeIn(PROJ, session.id, FIVE_LEVEL_CMD + "\r");
  await typeIn(PROJ, session.id, ANSI_CMD + "\r");
  await typeIn(PROJ, session.id, ZH_CMD + "\r");
  await typeIn(PROJ, session.id, "echo E2_HTTP_END\r");
  await stream.waitFor("E2_HTTP_END");
  await sleep(800);

  const raw = stream.text();
  const colored = renderLogChunk(raw, createLogColorState(), true);
  console.log(`[verify]   PTY 原始流 ${Buffer.byteLength(raw)} 字节（含 cmd/ConPTY 自己的光标与标题序列）`);

  // ① 五级日志的字节证据（取 console.error 那条**输出**，lastIndexOf 命中它而非回显里的命令原文）
  const rawWin = windowAround(raw, "ERROR boom", 30, 20);
  const colWin = windowAround(colored, "\u001b[31mERROR\u001b[39m boom", 30, 20);
  console.log(`[verify]   源字节      ERROR 输出窗口 hex: ${hex(rawWin)}`);
  console.log(`[verify]   着色后      ERROR 输出窗口 hex: ${hex(colWin)}`);
  ok(
    rawWin.length > 20 && !rawWin.includes("\u001b[31m") && colWin.includes("\u001b[31mERROR\u001b[39m boom"),
    "① 同一处对照：源字节里没有 SGR，着色后出现 `1b5b33316d` + ERROR + `1b5b33396d`（红）—— 色是本层加的，不是程序发的",
  );
  const levelHits: Array<[string, string]> = [
    ["\u001b[36mINFO\u001b[39m", "INFO 蓝绿 36"],
    ["\u001b[33mWARN\u001b[39m", "WARN 黄 33"],
    ["\u001b[31mERROR\u001b[39m", "ERROR 红 31"],
    ["\u001b[90mDEBUG\u001b[39m", "DEBUG 灰 90"],
    ["\u001b[31mFATAL\u001b[39m", "FATAL 红 31"],
  ];
  ok(
    levelHits.every(([n]) => colored.includes(n)),
    `① 五级一条不落：${levelHits.map(([n, l]) => `${l}(${hex(n).slice(0, 12)}…)`).join(" · ")}`,
  );
  // 中文关键词：ZH_CMD 打出来的那 6 个（表里另有「就绪」，样例段已覆盖）
  const zhPrinted = ["失败", "异常", "警告", "成功", "完成", "调试"];
  const zhMiss = zhPrinted.filter((k) => {
    const sgr = LOG_COLOR_RULES.find((r) => r.keywords.includes(k))!.sgr;
    return !colored.includes(`\u001b[${sgr}m${k}\u001b[39m`);
  });
  ok(
    zhMiss.length === 0,
    `① 中文关键词走真 PTY 流（node 输出 UTF-8 中文，ConPTY 原样透传）也能上色：${zhPrinted
      .map((k) => `${k}→${LOG_COLOR_RULES.find((r) => r.keywords.includes(k))!.sgr}`)
      .join(" · ")}（未命中：${zhMiss.join("/") || "无"}）`,
  );

  // ② 关闭着色 = 源字节（真实流上的逐字节对照）
  const offRendered = renderLogChunk(raw, createLogColorState(), false);
  ok(
    sameBytes(offRendered, raw),
    `② 真实 PTY 流上：关闭着色后写进终端的字节与源**逐字节一致**（${Buffer.byteLength(raw)} 字节，Buffer.compare === 0）`,
  );

  // ③ 只插不改不吞（真实流）
  const stuck = subsequenceStuckAt(raw, colored);
  ok(
    stuck === -1,
    `③ 真实流上着色后仍是源的超序列：逐字节按序走完源 ${Buffer.byteLength(raw)} 字节（一个不吞不乱序）`,
  );
  ok(
    stripAnsi(colored) === stripAnsi(raw),
    `③ 真实流上剥掉全部转义后可见文本与源一致（${[...stripAnsi(raw)].length} 个字符）`,
  );
  ok(
    isSubsequenceList(escList(raw), escList(colored)),
    `③ 真实流里程序/ConPTY 自己发的转义序列在着色后按序一条不少（源 ${escList(raw).length} 条 → 着色后 ${escList(colored).length} 条）`,
  );

  // 程序自己发的 ANSI：原样透传（不吞不改）
  const ansiIdx = raw.indexOf("\u001b[31mRED");
  ok(ansiIdx >= 0, `③ 程序自己发的 ANSI 进了 PTY 流：\`1b5b33316d524544\` @${ansiIdx}（hex ${hexWindow(raw, "\u001b[31mRED", 6, 20)}）`);
  if (ansiIdx >= 0) {
    // 该序列 + 紧随其后的几个字节（CRLF + 提示符）在着色后必须原样连着出现：
    // 说明本层没有在该处改写/吞掉任何字节（插入的颜色只会在别处，不影响这段）
    const ansiWindow = raw.slice(ansiIdx, ansiIdx + 12);
    const afterWindow = raw.slice(ansiIdx, ansiIdx + 20);
    ok(
      colored.includes(ansiWindow) && colored.includes(afterWindow),
      `③ 该序列及紧随的字节在着色后原样连着出现（hex ${hex(afterWindow)}）、未被本层改写或吞掉`,
    );
  }

  // chunk 边界无关（真实流）
  const chunkResults = [1, 7, 64].map((n) => sameBytes(renderInChunks(raw, n), colored));
  ok(
    chunkResults.every(Boolean),
    `附 chunk 边界无关（真实流）：按 1/7/64 字符切开喂着色层，与整串处理逐字节一致（${chunkResults.map((b) => (b ? "OK" : "X")).join("/")}）`,
  );

  // 关会话，不留僵尸
  const del = await api(
    "DELETE",
    `/api/terminal/${encodeURIComponent(session.id)}?project_id=${encodeURIComponent(PROJ)}`,
  );
  ok(
    del.status === 200 && del.body.removed === true && (await waitPidGone(session.pid)),
    `收尾：HTTP 段会话关闭（removed=true，退出码=${del.body.exit?.exitCode}）且 pid=${session.pid} 在 tasklist 查不到`,
  );
}

// ───────────────────────── ③ 源码护栏：写路径唯一 / 零新依赖 / 服务端 PTY 未动 ─────────────────────────

function sourceGuard(): void {
  console.log("\n[verify] ── ③ 源码护栏：写路径唯一 + 零新依赖 + 服务端 PTY 字节流一行未改");
  const pane = read("src/ui/terminal/TerminalPane.tsx");
  const color = read("src/ui/terminal/logColor.ts");
  const pty = read("src/server/pty.ts");
  const server = read("src/server/index.ts");

  const p = strip(pane);
  const writes = [...p.matchAll(/\.write\(([^;]*)\)/g)].map((m) => m[1].trim());
  const streamWrites = writes.filter((w) => /renderLogChunk\(/.test(w));
  const flushWrites = writes.filter((w) => w === "pending");
  // SSE 断线提示（2026-09-18 审计修复白名单）：onerror 的那行固定常量提示是第三种口子——
  // 纯 UI 告警，不来自数据流、也刻意不进 rawRef（「导出原始输出」仍逐字节等于源输出），
  // 与"写路径不凭空造流字节"红线不冲突。白名单口径收紧为：字符串字面量 + 含"连接断开"，且只许 1 处。
  const noticeWrites = writes.filter((w) => w.startsWith('"') && w.includes("连接断开"));
  ok(
    streamWrites.length === 1 &&
      noticeWrites.length === 1 &&
      streamWrites.length + flushWrites.length + noticeWrites.length === writes.length &&
      writes.length >= 1,
    `② pane 里写终端只三种口子：① 唯一一处数据流写 = renderLogChunk(...)（${streamWrites.length} 处）；` +
      `② 补吐扣住的尾巴 = pending（${flushWrites.length} 处）；` +
      `③ 唯一一处 SSE 断线提示常量（${noticeWrites.length} 处，纯 UI 告警不进 rawRef）；` +
      `另有 ${writes.length - streamWrites.length - flushWrites.length - noticeWrites.length} 处其他写法`,
  );
  const pendings = [...p.matchAll(/const pending = ([^;]*);/g)].map((m) => m[1]);
  ok(
    pendings.length >= 2 && pendings.every((x) => /flushLogColor\(/.test(x)),
    `② 补吐的字节只来自 flushLogColor(...)（${pendings.length} 处）—— 写路径不会凭空造字节`,
  );
  const rawAcc = p.indexOf("rawRef.current += payload.data");
  const writeAt = p.indexOf("term.write(renderLogChunk(");
  ok(
    rawAcc >= 0 && writeAt > rawAcc,
    "③ 原始流 rawRef 先原样累积、再上屏（导出与着色走两条路：着色再怎么插色也进不了 rawRef）",
  );
  ok(
    /new Blob\(\[rawRef\.current\]/.test(p) && /data-terminal-export/.test(p),
    "③ 「导出原始输出」导的就是 rawRef.current（逐字节的源输出），没有第二个数据源",
  );
  ok(
    /const \[colorOn, setColorOn\] = useState\(true\)/.test(p) && /data-terminal-color-state/.test(p),
    "② 着色开关默认开（useState(true)）+ 状态打点 data-terminal-color-state（默认开、可关）",
  );
  ok(
    /data-terminal-color=\{colorOn \? "on" : "off"\}/.test(p),
    "② pane 上有 data-terminal-color=on/off 打点（验证与用户都能一眼看出开关状态）",
  );
  ok(
    !/import\s/.test(strip(color)),
    "④ logColor.ts 零 import（着色层自己写规则表，零新 npm 依赖）",
  );
  const external = (s: string) =>
    [...s.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]).filter((x) => !x.startsWith("."));
  const ext = [...new Set(external(pane))];
  ok(
    ext.length > 0 && ext.every((x) => x === "react" || x.startsWith("@xterm/")),
    `④ pane 的外部 import 仍只有 ${ext.join(" / ")}（@xterm/* 与 react 都是 T2 起既有，本次没加依赖）`,
  );
  ok(
    !/logColor|着色|colorize|renderLogChunk/i.test(strip(pty) + strip(server)),
    "服务端 PTY 与路由层零着色代码：着色纯前端，PTY 字节流没有被改（字节保真的前提）",
  );

  const licPath = path.join(REPO_ROOT, "node_modules", "@xterm", "xterm", "LICENSE");
  const lic = fs.readFileSync(licPath, "utf8");
  const licLines = lic.split(/\r?\n/).filter((l) => l.trim().length > 0);
  console.log(`[verify]   既有依赖 @xterm/xterm/LICENSE 原文首行：${licLines[0].trim()}`);
  console.log(`[verify]   …关键句：${licLines.find((l) => /Permission is hereby granted/.test(l))?.trim().slice(0, 96)}…`);
  console.log(`[verify]   （本次零新增依赖，无新许可证可核；以上是既有 @xterm/xterm 的 LICENSE 原文关键句）`);
  ok(
    /Permission is hereby granted, free of charge/.test(lic) &&
      /THE SOFTWARE IS PROVIDED "AS IS"/.test(lic) &&
      !/GNU (General|Affero|Lesser) Public License/i.test(lic),
    "④ 既有 @xterm/xterm LICENSE 原文 = MIT 全文（含「Permission is hereby granted…」与「THE SOFTWARE IS PROVIDED AS IS」），非 GPL/AGPL",
  );
}

// ───────────────────────── ⑤ 原始输出缓冲上限（Q44：内存封顶，导出如实降级） ─────────────────────────

function rawBufferSection(): void {
  console.log("\n[verify] ── ⑤ 原始输出缓冲上限（Q44：rawRef 不再无界累积，超限丢头留尾）");

  const MAX = rawBuffer.RAW_BUFFER_MAX_CHARS;
  ok(
    MAX === 2 * 1024 * 1024 && rawBuffer.RAW_BUFFER_KEEP_CHARS === MAX / 2,
    `上限口径：RAW_BUFFER_MAX_CHARS=${MAX}（${(MAX / 1024 / 1024).toFixed(1)} MiB 字符 ≈ 4 MB 内存/pane），保留尾巴 = 上限一半（${rawBuffer.RAW_BUFFER_KEEP_CHARS}）`,
  );

  const under = "a".repeat(MAX);
  const u = rawBuffer.trimRawBuffer(under);
  ok(u.text === under && u.dropped === 0, `未超限原样返回：${MAX} 字符整串不截、dropped=0（上限之内的会话导出仍逐字节等于源）`);

  const over = "b".repeat(MAX + 4096);
  const o = rawBuffer.trimRawBuffer(over);
  ok(
    o.text.length === rawBuffer.RAW_BUFFER_KEEP_CHARS &&
      o.text === over.slice(o.dropped) &&
      over.slice(0, o.dropped) + o.text === over,
    `超限丢头留尾：输入 ${over.length} 字符 → 保留 ${o.text.length} 字符、丢弃 ${o.dropped} 字符，且「丢弃段 + 保留段 == 原串」（不凭空造字节、不乱序）`,
  );

  // 代理对边界：截断落点若撞上 emoji 的后半个码元，必须往后挪一个，别劈出孤立代理项。
  // 构造"全由配对码元组成"的串（长度 = 上限 + 1）：cut = 长度 - 保留数 落在低代理项上。
  const pair = "\u{1F600}";
  const withPairs = pair.repeat(MAX / 2) + "c";
  const rawCut = withPairs.length - rawBuffer.RAW_BUFFER_KEEP_CHARS;
  const p = rawBuffer.trimRawBuffer(withPairs);
  const first = p.text.charCodeAt(0);
  ok(
    withPairs.charCodeAt(rawCut) >= 0xdc00 &&
      withPairs.charCodeAt(rawCut) <= 0xdfff &&
      p.dropped === rawCut + 1 &&
      !(first >= 0xdc00 && first <= 0xdfff) &&
      withPairs.slice(0, p.dropped) + p.text === withPairs,
    `代理对不被劈开：切点原本落在低代理项（0x${withPairs.charCodeAt(rawCut).toString(16)}）上，实际丢弃 ${p.dropped} 字符（= 切点 +1）、` +
      `保留段首码元 0x${first.toString(16)} 不是孤立低代理项，守恒仍成立`,
  );

  // 模拟 pane 的 SSE 循环：连续喂 chunk，长度必须恒定在上限内（改前是 raw += data，无界）
  let raw = "";
  let droppedTotal = 0;
  const CHUNK = "d".repeat(64 * 1024);
  const CHUNKS = 320; // 20 MiB 输出
  for (let i = 0; i < CHUNKS; i++) {
    raw += CHUNK;
    const t = rawBuffer.trimRawBuffer(raw);
    raw = t.text;
    droppedTotal += t.dropped;
  }
  const fed = CHUNK.length * CHUNKS;
  ok(
    raw.length <= MAX && droppedTotal === fed - raw.length,
    `pane 循环模拟：喂 ${(fed / 1024 / 1024).toFixed(0)} MiB 输出后缓冲 ${(raw.length / 1024 / 1024).toFixed(1)} MiB（≤ 上限 ${(MAX / 1024 / 1024).toFixed(1)} MiB，改前这里是 ${(fed / 1024 / 1024).toFixed(0)} MiB 无界），累计丢弃 ${droppedTotal} 字符与账面一致`,
  );

  const paneSrc = strip(read("src/ui/terminal/TerminalPane.tsx"));
  ok(
    /import \{ RAW_BUFFER_MAX_CHARS, trimRawBuffer \} from "\.\/rawBuffer"/.test(paneSrc) &&
      /rawRef\.current = text;/.test(paneSrc) &&
      /rawDroppedRef\.current \+= dropped;/.test(paneSrc),
    "源码护栏：pane 走 rawBuffer.trimRawBuffer（超限改写 rawRef、累加丢弃计数），不是自己另写一份截断",
  );
  ok(
    /data-terminal-raw-truncated=\{rawTruncated \? "on" : "off"\}/.test(paneSrc) &&
      /data-terminal-raw-truncated-note/.test(paneSrc),
    "源码护栏：截断后界面标出（data-terminal-raw-truncated + 「缓冲已截断」提示）——导出不再是整场会话这件事不静默",
  );
  ok(
    !/import\s/.test(strip(read("src/ui/terminal/rawBuffer.ts"))),
    "rawBuffer.ts 零 import（纯函数、零新依赖，同 logColor.ts 的风格）",
  );
}

// ───────────────────────── ④ UI 段：playwright（动态端口 + 探活） ─────────────────────────

async function uiPlaywright(specPath: string, backendPort: number): Promise<void> {
  fs.mkdirSync(VERIFY_DIR, { recursive: true });
  const pyPath = path.join(VERIFY_DIR, "e2-shot.py");
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
    ok(
      out.includes("UI_ASSERT_ALL_PASS"),
      "① ② ③ UI 段：开着色有 ≥4 种颜色 / 关着色的 pane 零上色 / 导出的字节与源逐字节一致 全过",
    );
  } catch (e) {
    process.stdout.write((e as { stdout?: Buffer }).stdout?.toString() ?? "");
    process.stderr.write((e as { stderr?: Buffer }).stderr?.toString() ?? "");
    ok(false, "UI 段执行失败（见上方输出）");
  } finally {
    killTree(vite, vitePort);
    await sleep(500);
  }
  const files = [
    "e2-01-color-on-default.png",
    "e2-02-two-panes-one-off.png",
    "e2-03-five-levels-colored.png",
    "e2-04-five-levels-plain.png",
    "e2-05-color-on-header.png",
    "e2-06-color-off-header.png",
    "e2-export-color-on.log",
    "e2-export-color-off.log",
    "e2-tap-color-on.bin",
    "e2-tap-color-off.bin",
  ];
  for (const f of files) {
    ok(fs.existsSync(path.join(VERIFY_DIR, f)), `UI 产物落盘 .工作台/verify/${f}`);
  }
}

/** UI 段 python（playwright 写法同 verify-e1；参数走一段 JSON） */
const PY_SHOT = String.raw`# E2 UI 验证：日志着色（带色证据 / 可关闭 / 导出与源逐字节一致 / 开关状态截图）
# 用法：python e2-shot.py <vitePort> <backendPort> <spec.json>
import json
import os
import sys
import threading
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
FIVE = SPEC["five"]
ANSI = SPEC["ansi"]
OUT = "."

fails = []
PAGE = None


def ok(cond, label):
    print(("[UI PASS] " if cond else "[UI FAIL] ") + label)
    if not cond:
        fails.append(label)


class RawTap:
    """在 UI 的 pane 之外另开一条**同会话** SSE，原样记下服务端推来的字节。
    同一会话的每个订阅者收到的事件内容完全一致，所以 pane 的导出必须以这串字节**结尾**
    —— 这是"导出 == 源输出"最硬的证据：不靠肉眼、也不靠两次运行去凑对照。"""

    def __init__(self, sid):
        self.chunks = []
        self.stopped = False
        url = API + "/api/terminal/" + urllib.parse.quote(sid) + "/out?project_id=" + urllib.parse.quote(PID)
        self.thread = threading.Thread(target=self._run, args=(url,), daemon=True)
        self.thread.start()

    def _run(self, url):
        # 逐行读（SSE 就是行协议）：不能用 resp.read(n) —— 它会阻塞到**攒满 n 字节**才返回，
        # 抓流会一直落后于 pane，快照就永远不是源字节的正确尾部（第一次跑就是这么错的）。
        try:
            with urllib.request.urlopen(url, timeout=180) as resp:
                while not self.stopped:
                    line = resp.readline()
                    if not line:
                        break
                    if not line.startswith(b"data: "):
                        continue
                    ev = json.loads(line[6:].decode("utf-8"))
                    data = ev.get("data")
                    if isinstance(data, str):
                        self.chunks.append(data.encode("utf-8"))
        except Exception:
            pass

    def snapshot(self):
        return b"".join(self.chunks)


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


def pane_attr(idx, name):
    return pane(idx).get_attribute(name)


def view_attr(name):
    return PAGE.locator("[data-terminal-view]").first.get_attribute(name)


def wait_pane_attr(idx, name, timeout=30):
    t0 = time.time()
    while time.time() - t0 < timeout:
        v = pane_attr(idx, name)
        if v:
            return v
        time.sleep(0.2)
    raise AssertionError("pane %d 的 %s 迟迟为空" % (idx, name))


def pane_text(idx):
    return pane(idx).locator(".xterm").first.inner_text()


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


def colored_cells(idx):
    """数渲染层里带前景色的单元。xterm 6 的 DOM renderer 对调色板色用 **CSS 类** xterm-fg-<n>、
    只对真彩（RGB）用内联 style.color，所以两种都要数（只看内联会数出 0，第一次跑就踩了这个坑）。"""
    return PAGE.evaluate(
        """(sel) => {
          const root = document.querySelector(sel);
          const rows = root ? root.querySelector(".xterm-rows") : null;
          if (!rows) return { count: 0, colors: [], sample: "" };
          const colors = new Set();
          let count = 0;
          for (const el of rows.querySelectorAll("*")) {
            const m = /xterm-fg-(\d+)/.exec(el.className || "");
            const inline = el.style && el.style.color;
            if (m) { count++; colors.add("fg-" + m[1]); }
            else if (inline) { count++; colors.add(inline); }
          }
          return { count: count, colors: Array.from(colors).sort(), sample: rows.innerHTML.slice(0, 400) };
        }""",
        "[data-terminal-pane-index='%d']" % idx,
    )


def five_lines(text):
    """渲染层可见的五级日志行（IDENTIFIER 起头才算，避免把回显的命令原文误收进来）。"""
    keys = ("INFO ok", "WARN slow", "ERROR boom", "DEBUG trace", "FATAL dead")
    out = []
    for line in text.splitlines():
        s = line.strip()
        for k in keys:
            if s.startswith(k):
                out.append(s)
                break
    return out


def export_bytes(idx, target):
    path = os.path.join(OUT, target)
    with PAGE.expect_download() as dl:
        pane(idx).locator("[data-terminal-export]").click()
    d = dl.value
    d.save_as(path)
    b = open(path, "rb").read()
    print("[info] 导出 %s：建议文件名 %s · %d 字节" % (target, d.suggested_filename, len(b)))
    return b


def hexwin(data, needle, before=8, after=16):
    i = data.find(needle)
    if i < 0:
        return "未找到 " + repr(needle)
    return data[max(0, i - before):i + len(needle) + after].hex()


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

    # ── 默认状态：1 个 pane、日志着色默认开 ──
    ok(view_attr("data-terminal-pane-count") == "1", "初始 1 个 pane（E1 行为不退化）")
    ok(pane_attr(0, "data-terminal-color") == "on", "② 默认 data-terminal-color=on（日志着色默认开）")
    ok("开" in pane(0).locator("[data-terminal-color-toggle]").inner_text(),
       "② 头部开关文案 = 「日志着色：开」（%s）" % pane(0).locator("[data-terminal-color-toggle]").inner_text())
    shot("e2-01-color-on-default.png")

    # ── 开第二个 pane，关掉它的着色 → 两个 pane 一彩一素，同屏对照 ──
    page.locator("[data-terminal-add]").click()
    t0 = time.time()
    while time.time() - t0 < 20 and view_attr("data-terminal-pane-count") != "2":
        time.sleep(0.2)
    ok(view_attr("data-terminal-pane-count") == "2", "开了第 2 个 pane（E1 分屏复用来做开关对照）")
    pane(1).locator("[data-terminal-color-toggle]").click()
    page.wait_for_timeout(300)
    ok(pane_attr(1, "data-terminal-color") == "off" and pane_attr(0, "data-terminal-color") == "on",
       "② 点 pane2 的开关 → pane2=off、pane1 仍=on（开与关同时存在，互不影响）")
    ok("关" in pane(1).locator("[data-terminal-color-toggle]").inner_text(),
       "② pane2 开关文案 = 「日志着色：关」")
    shot("e2-02-two-panes-one-off.png")

    sid0 = wait_pane_attr(0, "data-terminal-sid")
    sid1 = wait_pane_attr(1, "data-terminal-sid")
    print("[info] 两个 pane 的会话：%s / %s" % (sid0, sid1))
    tap0 = RawTap(sid0)   # pane1（开着色）
    tap1 = RawTap(sid1)   # pane2（关着色）
    time.sleep(1.0)       # 等两条旁路 SSE 连上（连接即 hello，之后的事件与 pane 收到的一致）

    # ── 两个 pane 跑同一串命令：标记 → 程序自吐 ANSI → 标记 → 五级日志 → 标记 ──
    type_in(0, "echo " + SPEC["mark_on_begin"])
    type_in(1, "echo " + SPEC["mark_off_begin"])
    wait_text(0, SPEC["mark_on_begin"])
    wait_text(1, SPEC["mark_off_begin"])
    type_in(0, ANSI)
    type_in(1, ANSI)
    wait_text(0, "RED")
    wait_text(1, "RED")
    type_in(0, "echo " + SPEC["mark_on_red_end"])
    type_in(1, "echo " + SPEC["mark_off_red_end"])
    wait_text(0, SPEC["mark_on_red_end"])
    wait_text(1, SPEC["mark_off_red_end"])
    type_in(0, FIVE)
    type_in(1, FIVE)
    wait_text(0, "FATAL dead")
    wait_text(1, "FATAL dead")
    type_in(0, "echo " + SPEC["mark_on_end"])
    type_in(1, "echo " + SPEC["mark_off_end"])
    wait_text(0, SPEC["mark_on_end"])
    wait_text(1, SPEC["mark_off_end"])
    page.wait_for_timeout(1200)  # 等最后几条输出落屏/落流

    # ── ① 带色证据（界面侧）：开着色的 pane 有四级颜色，关着色的 pane 零上色 ──
    # xterm 6 的 DOM renderer 对调色板色用 CSS 类 xterm-fg-<n>：ANSI 1=红、3=黄、6=青（蓝绿）、8=亮黑（灰）
    on_cells = colored_cells(0)
    off_cells = colored_cells(1)
    print("[info] pane1（着色开）上色单元 %d 个，颜色类 %s" % (on_cells["count"], on_cells["colors"]))
    print("[info] pane2（着色关）上色单元 %d 个，颜色类 %s" % (off_cells["count"], off_cells["colors"]))
    want = ("fg-1", "fg-3", "fg-6", "fg-8")
    ok(on_cells["count"] > 0 and all(w in on_cells["colors"] for w in want),
       "① 开着色的 pane1 渲染层有 %d 个上色单元、四级颜色齐（fg-1 红 ERROR/FATAL · fg-3 黄 WARN · fg-6 蓝绿 INFO · fg-8 灰 DEBUG）：%s"
       % (on_cells["count"], on_cells["colors"]))
    # 关着色的 pane 只应剩**程序自己发的那条红**（ESC[31mRED，fg-1）：日志级别着色一个都不能有
    ok(off_cells["colors"] == ["fg-1"] and off_cells["count"] <= 3,
       "② 关着色的 pane2 零日志级别着色（渲染层只剩 %d 个上色单元、且只有程序自己那条 ESC[31mRED 的红 fg-1，"
       "黄/蓝绿/灰一个都没有）—— 关闭后是纯净输出、程序自己的颜色照旧：%s"
       % (off_cells["count"], off_cells["colors"]))
    if off_cells["count"] != 0:
        print("[info] pane2 rows html 片段: " + off_cells["sample"][:300])
    if on_cells["count"] == 0:
        print("[info] pane1 rows html 片段: " + on_cells["sample"][:300])
    shot("e2-03-five-levels-colored.png")
    shot("e2-04-five-levels-plain.png")

    # ── 开关状态特写（彩色 pane 的头部 / 无色 pane 的头部） ──
    b0 = pane(0).bounding_box()
    b1 = pane(1).bounding_box()
    shot("e2-05-color-on-header.png", {"x": b0["x"], "y": b0["y"], "width": b0["width"], "height": 34})
    shot("e2-06-color-off-header.png", {"x": b1["x"], "y": b1["y"], "width": b1["width"], "height": 34})

    # ── 可见文本一致：两个 pane 同一命令的五级日志行逐行相同（着色只上色不改字） ──
    t0_, t1_ = pane_text(0), pane_text(1)
    lines0, lines1 = five_lines(t0_), five_lines(t1_)
    print("[info] pane1 五级行: " + repr(lines0))
    print("[info] pane2 五级行: " + repr(lines1))
    ok(len(lines0) == 5 and lines0 == lines1,
       "③ 两个 pane 同一命令的可见文本逐行一致（各 5 行）：%s" % (" / ".join(lines0)))

    # ── ③ 导出与源逐字节一致 ──
    # 快照**先取**（旁路 SSE 只可能lag在 pane 后面，不可能超前）：源字节必须是导出里连续的一段。
    tap_on = tap0.snapshot()
    tap_off = tap1.snapshot()
    open(os.path.join(OUT, "e2-tap-color-on.bin"), "wb").write(tap_on)
    open(os.path.join(OUT, "e2-tap-color-off.bin"), "wb").write(tap_off)
    print("[info] 旁路 SSE 抓到的源字节：pane1 %d 字节 / pane2 %d 字节（原件另存 e2-tap-color-on/off.bin）"
          % (len(tap_on), len(tap_off)))
    on_bytes = export_bytes(0, "e2-export-color-on.log")
    off_bytes = export_bytes(1, "e2-export-color-off.log")

    for label, exp, tap in (("着色开", on_bytes, tap_on), ("着色关", off_bytes, tap_off)):
        at = exp.find(tap)
        tail_extra = len(exp) - (at + len(tap)) if at >= 0 else -1
        print("[info] %s：导出 %d 字节，源字节 %d 字节，源字节在导出里的起点 %d，其后剩余 %d 字节"
              % (label, len(exp), len(tap), at, tail_extra))
        ok(len(tap) > 200 and at >= 0 and tail_extra <= 200,
           "③ %s时导出 == 源输出：导出 %d 字节里有一段与另开一条同会话 SSE 抓到的 %d 字节**逐字节相同**（起点 %d，其后只剩 %d 字节收尾提示符）"
           % (label, len(exp), len(tap), at, tail_extra))
    ok(b"\x1b[31mRED" in on_bytes and b"\x1b[31mRED" in off_bytes,
       "③ 程序自己发的 ANSI 在两种状态下的导出里都原样保留：ESC[31mRED 出现 %d 次（着色开）/ %d 次（着色关）"
       % (on_bytes.count(b"\x1b[31mRED"), off_bytes.count(b"\x1b[31mRED")))
    print("[info] 导出（着色开）里 ESC[31mRED 处 hex: " + hexwin(on_bytes, b"\x1b[31mRED"))
    print("[info] 导出（着色关）里 ESC[31mRED 处 hex: " + hexwin(off_bytes, b"\x1b[31mRED"))
    injected = (b"\x1b[31mERROR", b"\x1b[36mINFO", b"\x1b[33mWARN", b"\x1b[90mDEBUG", b"\x1b[39m")
    leaked = [n for n in injected if n in on_bytes or n in off_bytes]
    ok(not leaked,
       "③ 导出里**没有**本层注入的着色序列（%s）—— 着色只影响上屏，进不了导出" % ("无泄漏" if not leaked else repr(leaked)))
    print("[info] 导出（着色开）尾部 60 字节 hex: " + on_bytes[-60:].hex())

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
  moduleSection();
  rawBufferSection();
  sourceGuard();

  const specPath = path.join(VERIFY_DIR, "e2-spec.json");
  fs.writeFileSync(
    specPath,
    JSON.stringify(
      {
        project: PROJ,
        projectRoot: ROOT,
        five: FIVE_LEVEL_CMD,
        ansi: ANSI_CMD,
        zh: ZH_CMD,
        mark_on_begin: "E2_ON_BEGIN",
        mark_on_red_end: "E2_ON_RED_END",
        mark_on_end: "E2_ON_END",
        mark_off_begin: "E2_OFF_BEGIN",
        mark_off_red_end: "E2_OFF_RED_END",
        mark_off_end: "E2_OFF_END",
      },
      null,
      2,
    ),
    "utf8",
  );

  const backendPort = await pickFreePort();
  let backend: ChildProcess | null = null;
  try {
    console.log(`\n[verify] ── 起后端（动态端口 ${backendPort}，TATAI_HOME=临时目录）`);
    backend = await startService(
      "后端",
      backendPort,
      (port) =>
        spawn(process.execPath, ["--import", "tsx", path.join("src", "server", "index.ts")], {
          cwd: REPO_ROOT,
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, TATAI_HOME: HOME_DIR, TATAI_PORT: String(port) },
        }),
      [`http://127.0.0.1:${backendPort}/health`, `http://localhost:${backendPort}/health`],
    );
    base = `http://127.0.0.1:${backendPort}`;
    ok(true, `后端已就绪：动态端口 ${backendPort}（探活通过，TATAI_HOME=${path.relative(REPO_ROOT, HOME_DIR)}）`);

    await httpSection();

    console.log("\n[verify] ── ④ UI 段：起 vite（动态端口）+ playwright 真开两个 pane（一彩一素）");
    await uiPlaywright(specPath, backendPort);
  } finally {
    if (backend) killTree(backend, backendPort);
    await sleep(800);
  }

  console.log("\n[verify] ── 收尾：进程杀净 + 动态端口释放 + 8787/5173 仍是别人的 + 夹具清理");
  ok(!(await portListening(backendPort)), `收尾：后端动态端口 ${backendPort} 已释放（进程杀净）`);
  const fixedAfter = { v: await portListening(8787), d: await portListening(5173) };
  ok(
    fixedBefore.v === fixedAfter.v && fixedBefore.d === fixedAfter.d,
    `收尾：8787/5173 状态与开工前一致（${fixedAfter.v ? "有人在用" : "空闲"} / ${fixedAfter.d ? "有人在用" : "空闲"}）—— 本脚本没占用、没杀 PID`,
  );
  fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
  fs.rmSync(HOME_DIR, { recursive: true, force: true });
  ok(
    !fs.existsSync(FIXTURE_DIR) && !fs.existsSync(HOME_DIR),
    "收尾：临时夹具（e2-fixture / e2-home）已删除，真实注册表与真实项目零触碰",
  );
}

main()
  .then(() => console.log(process.exitCode ? "[verify] 存在 FAIL" : "[verify] 全部 PASS"))
  .catch((e) => {
    console.error("[verify] 异常:", e);
    process.exitCode = 1;
  });
