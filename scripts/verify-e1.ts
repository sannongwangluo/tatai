// E1 验证脚本（用 tsx 跑）：多终端分屏（PLAN.md E1 卡 DoD①–④ + 卡上"跑偏点"红线）。
// 用法：pnpm verify:e1
//
// 覆盖点（逐条对 DoD）：
//   ① **每个 pane 独立会话、输入不串台**（DoD①，跑偏点防线）：同一项目建两个会话，各自 `cd` 到
//      **不同子目录**再 `cd` 打印自己的路径 → 两个 SSE 流各自只出现自己的路径与自己的标记串，
//      交叉出现的次数为 0（贴真实输出）；UI 段再在两 pane 各敲不同命令，断言 pane 1 输出区
//      不含 pane 2 的标记串（DOM 断言 + 截图）。
//   ② **关一个不影响另一个**（DoD②）：DELETE 会话 A → A 的 SSE 收到 exit 收流，B 照常执行命令出结果；
//      UI 段关掉 pane 1 → 剩下的 pane 2 仍是**同一个会话**（sid/pid 不变）且还能敲。
//   ③ **左右/上下布局可切换**（DoD③）：UI 段切布局 → `data-terminal-layout` row↔column 变、两个 pane
//      的几何关系真变（左右并排 ↔ 上下叠放），且两个会话 sid 不变（切布局不重建会话）；两张截图对照。
//   ④ **每个 pane 的 cwd 仍锁项目根**（DoD④，沿用 T1 约束）：建会话响应 cwd == 项目根，两个 pane 都一样，
//      并且 pane 头部把它显示出来（`data-terminal-cwd` 打点，用户可核对）。
//   附（本卡新增的后端口径）：每项目会话数上限（超限 400 SESSION_LIMIT_REACHED）；关闭幂等；
//      伪造项目 id 404；每项目会话隔离（A 项目的 sid 带 B 项目的 project_id 一律 404 且**不落到 A**）；
//      关会话后 pid 在 tasklist 查不到（无僵尸）。
//
// 端口策略（照 verify-n3/f4 写法）：**不碰任何既有监听**——后端与 vite 都 bind 0 让系统分配，
// vite 经 TATAI_DEV_API_PORT 代理到动态后端；起前探活、起后盯早退；开头末尾各探一次 8787/5173（只记录不杀）。
// 夹具（全部在 gitignore 的 `.工作台/verify/` 内，跑完删）：`.工作台/verify/e1-home`（临时 TATAI_HOME，
// 不碰真实注册表）+ `.工作台/verify/e1-fixture/p|q`（两个临时项目根，各带 sa/sb 两个子目录）。
// 截图落 `.工作台/verify/e1-*.png`（gitignore）。
import { execSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { addProject } from "../src/server/registry";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VERIFY_DIR = path.join(REPO_ROOT, ".工作台", "verify");
const HOME_DIR = path.join(VERIFY_DIR, "e1-home");
const FIXTURE_DIR = path.join(VERIFY_DIR, "e1-fixture");
const PROJ_A = "e1-fix";
const PROJ_B = "e1-fix-b";
const ROOT_A = path.join(FIXTURE_DIR, "p");
const ROOT_B = path.join(FIXTURE_DIR, "q");

const ok = (cond: boolean, label: string) => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (!cond) process.exitCode = 1;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ───────────────────────── 端口：探活 + 动态分配（与 verify-n3/f4 同一份写法） ─────────────────────────

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

/** 等 pid 消失（关闭会话后进程回收需要一点时间），超时返回 false */
async function waitPidGone(pid: number, timeoutMs = 8000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await pidAlive(pid))) return true;
    await sleep(300);
  }
  return false;
}

// ───────────────────────── 夹具：临时 TATAI_HOME + 两个临时项目 ─────────────────────────

interface Ctx {
  base: string;
  home: string;
}

function buildFixture(): void {
  fs.rmSync(HOME_DIR, { recursive: true, force: true });
  fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
  fs.mkdirSync(HOME_DIR, { recursive: true });
  for (const root of [ROOT_A, ROOT_B]) {
    fs.mkdirSync(path.join(root, "sa"), { recursive: true });
    fs.mkdirSync(path.join(root, "sb"), { recursive: true });
  }
  addProject(
    { id: PROJ_A, name: "E1 验证项目 A", path: ROOT_A, kind: "backend" },
    HOME_DIR,
  );
  addProject(
    { id: PROJ_B, name: "E1 验证项目 B", path: ROOT_B, kind: "backend" },
    HOME_DIR,
  );
  console.log(
    `[verify] 夹具就绪：TATAI_HOME=${path.relative(REPO_ROOT, HOME_DIR)} · 项目根 ${path.relative(REPO_ROOT, ROOT_A)}（sa/sb 两个子目录）与 ${path.relative(REPO_ROOT, ROOT_B)}`,
  );
}

// ───────────────────────── HTTP 客户端 ─────────────────────────

interface ApiResp {
  status: number;
  body: {
    ok?: boolean;
    session?: SessionInfo;
    sessions?: SessionInfo[];
    count?: number;
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

/** 建会话（HTTP 口径与前端一致：POST /api/projects/:id/terminal） */
async function newSession(projectId: string, cols = 200, rows = 30): Promise<SessionInfo> {
  const r = await api("POST", `/api/projects/${encodeURIComponent(projectId)}/terminal`, {
    cols,
    rows,
  });
  if (r.status !== 200 || !r.body.session) {
    throw new Error(`建会话失败：${r.status} ${JSON.stringify(r.body)}`);
  }
  return r.body.session;
}

interface StreamHandle {
  text(): string;
  exitCode(): number | null;
  ended(): boolean;
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
  let exitCodeVal: number | null = null;
  let ended = false;
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
            const ev = JSON.parse(line.slice(6)) as {
              data?: string;
              exit?: { exitCode: number };
            };
            if (typeof ev.data === "string") text += ev.data;
            if (ev.exit) exitCodeVal = ev.exit.exitCode;
          }
        }
      }
    } catch {
      // 收尾杀服务端是正常终态
    }
    ended = true;
  })();
  return {
    text: () => text,
    exitCode: () => exitCodeVal,
    ended: () => ended,
    waitFor: async (needle, timeoutMs = 20_000) => {
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

function listSessions(projectId?: string): Promise<ApiResp> {
  return api(
    "GET",
    projectId
      ? `/api/terminal/sessions?project_id=${encodeURIComponent(projectId)}`
      : "/api/terminal/sessions",
  );
}

function closeSession(projectId: string, sid: string): Promise<ApiResp> {
  return api(
    "DELETE",
    `/api/terminal/${encodeURIComponent(sid)}?project_id=${encodeURIComponent(projectId)}`,
  );
}

/**
 * 剥掉 ANSI 转义序列（CSI / OSC 等）：PTY 给的是**原始字节**，光标定位、清行、窗口标题这些序列
 * 跟正文混在同一条"行"里（实测：`cd` 打印的路径后面紧跟 `\u001b[9;1H` 再是提示符，永远不以路径结尾），
 * 判"这段输出里有没有某个路径"必须先剥壳。
 */
function stripAnsi(s: string): string {
  return s
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\|$)/g, "") // OSC（窗口标题等）
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "") // CSI（光标定位/清行/私有模式）
    .replace(/\u001b[@-Z\\-_]/g, ""); // 其余两字符转义
}

/** 可读转录（验证证据用）：剥 ANSI → \r 归一 → 去空行 */
function transcript(text: string): string {
  return stripAnsi(text)
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join("\n");
}

// ───────────────────────── ① ② ④ HTTP 层 ─────────────────────────

async function httpSection(): Promise<void> {
  console.log("\n[verify] ── ① 每个 pane 独立会话：两个会话各自 cd 到不同子目录，输出互不串（DoD①）");

  const a = await newSession(PROJ_A);
  const b = await newSession(PROJ_A);
  ok(
    a.id !== b.id && a.pid !== b.pid && a.pid > 0 && b.pid > 0,
    `① 两个会话各自独立：sid ${a.id} / ${b.id}，pid ${a.pid} / ${b.pid}（不同 PTY、不同进程）`,
  );
  ok(
    path.resolve(a.cwd) === path.resolve(ROOT_A) && path.resolve(b.cwd) === path.resolve(ROOT_A),
    `④ 两个会话 cwd 都锁项目根（实际：${a.cwd} · ${b.cwd}）`,
  );

  const sa = await openStream(a.id, PROJ_A);
  const sb = await openStream(b.id, PROJ_A);
  await sleep(1200); // 等 cmd 首帧提示符

  // 两侧**交错**发命令（不 await 顺序）：串台的话输出会跑到对方的流里
  await Promise.all([
    typeIn(PROJ_A, a.id, "cd sa\r"),
    typeIn(PROJ_A, b.id, "cd sb\r"),
  ]);
  await Promise.all([
    typeIn(PROJ_A, a.id, "cd\r"),
    typeIn(PROJ_A, b.id, "cd\r"),
  ]);
  await Promise.all([
    typeIn(PROJ_A, a.id, "echo E1_MARK_A\r"),
    typeIn(PROJ_A, b.id, "echo E1_MARK_B\r"),
  ]);
  await sa.waitFor("E1_MARK_A");
  await sb.waitFor("E1_MARK_B");
  await sleep(600); // 等路径行落全

  const textA = sa.text();
  const textB = sb.text();
  const pathA = path.join(ROOT_A, "sa");
  const pathB = path.join(ROOT_A, "sb");
  const transA = transcript(textA);
  const transB = transcript(textB);
  console.log("[verify]   会话 A 实录（PTY 原始字节剥 ANSI 后逐行）:");
  for (const line of transA.split("\n")) console.log(`[verify]     | ${line}`);
  console.log("[verify]   会话 B 实录（PTY 原始字节剥 ANSI 后逐行）:");
  for (const line of transB.split("\n")) console.log(`[verify]     | ${line}`);
  const stripA = stripAnsi(textA);
  const stripB = stripAnsi(textB);
  ok(
    stripA.includes(pathA) &&
      !stripA.includes(pathB) &&
      /E1_MARK_A/.test(textA) &&
      !/E1_MARK_B/.test(textA),
    `① 会话 A 的 cd 输出是自己的目录（…\\p\\sa）+ 自己的标记，且不含会话 B 的目录（…\\p\\sb）与标记 —— 输入/输出不串台`,
  );
  ok(
    stripB.includes(pathB) &&
      !stripB.includes(pathA) &&
      /E1_MARK_B/.test(textB) &&
      !/E1_MARK_A/.test(textB),
    "① 会话 B 的 cd 输出是自己的目录（…\\p\\sb）+ 自己的标记，且不含会话 A 的目录与标记 —— 输入/输出不串台",
  );

  // resize 各自生效：只改 A 的尺寸，B 不受影响
  await api("POST", `/api/terminal/${a.id}/resize?project_id=${PROJ_A}`, { cols: 120, rows: 40 });
  const afterResize = await listSessions(PROJ_A);
  const infoA = afterResize.body.sessions?.find((s) => s.id === a.id);
  const infoB = afterResize.body.sessions?.find((s) => s.id === b.id);
  ok(
    infoA?.cols === 120 && infoA?.rows === 40 && infoB?.cols === 200 && infoB?.rows === 30,
    `① resize 只作用于本会话：A=${infoA?.cols}x${infoA?.rows}（改了）· B=${infoB?.cols}x${infoB?.rows}（原样 200x30）`,
  );

  console.log("\n[verify] ── ② 关闭会话 A → 会话 B 仍能执行命令（DoD②）");
  const pidA = a.pid;
  const del = await closeSession(PROJ_A, a.id);
  ok(
    del.status === 200 && del.body.removed === true,
    `② DELETE 会话 A → removed=true，退出码=${del.body.exit?.exitCode}`,
  );
  await sleep(800);
  ok(sa.ended() && sa.exitCode() !== null, `② 会话 A 的 SSE 收到 exit 收流（exitCode=${sa.exitCode()}）`);
  await typeIn(PROJ_A, b.id, "echo E1_B_ALIVE_AFTER_CLOSE\r");
  const afterClose = await sb.waitFor("E1_B_ALIVE_AFTER_CLOSE");
  const echoes = (afterClose.match(/E1_B_ALIVE_AFTER_CLOSE/g) ?? []).length;
  ok(echoes >= 2, `② 会话 B 在 A 关闭后照常执行命令（回显 + 输出双现，出现 ${echoes} 次）`);
  const afterCloseList = await listSessions(PROJ_A);
  ok(
    afterCloseList.body.count === 1 && afterCloseList.body.sessions?.[0].id === b.id,
    `② 项目活跃会话 1 个且是 B（${afterCloseList.body.sessions?.[0].id}）——关 A 只关 A`,
  );
  ok(await waitPidGone(pidA), `② 会话 A 的 pid=${pidA} 在 tasklist 查不到（进程/句柄回收，无僵尸）`);

  // 关闭幂等：再关一次 / 关不存在的 sid
  const delAgain = await closeSession(PROJ_A, a.id);
  const delGhost = await closeSession(PROJ_A, "t0-ghost");
  ok(
    delAgain.status === 200 &&
      delAgain.body.removed === false &&
      delGhost.status === 200 &&
      delGhost.body.removed === false,
    "② 关闭幂等：已关的 sid 与不存在的 sid 都返回 200 removed=false（不报错、不 500）",
  );

  console.log("\n[verify] ── ③ 会话上限 / 伪造项目 id / 每项目会话隔离（E1 后端口径）");
  // 先关掉 B，从干净状态数上限
  await closeSession(PROJ_A, b.id);
  await waitPidGone(b.pid);

  const created: SessionInfo[] = [];
  for (let i = 0; i < 8; i++) created.push(await newSession(PROJ_A, 100, 24));
  const over = await api("POST", `/api/projects/${PROJ_A}/terminal`, { cols: 100, rows: 24 });
  ok(
    over.status === 400 &&
      over.body.error?.code === "SESSION_LIMIT_REACHED" &&
      /上限 8/.test(over.body.error?.message ?? ""),
    `③ 每项目会话数上限：第 9 个 → ${over.status} ${over.body.error?.code}「${over.body.error?.message}」`,
  );
  const atLimit = await listSessions(PROJ_A);
  ok(atLimit.body.count === 8, `③ 上限期内活跃会话数恒为 8（实际 ${atLimit.body.count}）`);
  const freed = await closeSession(PROJ_A, created[0].id);
  const refilled = await newSession(PROJ_A, 100, 24);
  ok(
    freed.body.removed === true && refilled.id !== created[0].id,
    `③ 关掉一个后可再开（${created[0].id} → ${refilled.id}），上限是"同时在开"的口径而非累计`,
  );
  created.push(refilled);

  const bogus = await api("POST", "/api/projects/__no_such_project__/terminal", {});
  const bogusList = await listSessions("__no_such_project__");
  ok(
    bogus.status === 404 &&
      bogus.body.error?.code === "PROJECT_NOT_FOUND" &&
      bogusList.status === 404 &&
      bogusList.body.error?.code === "PROJECT_NOT_FOUND",
    `③ 伪造项目 id：建会话 ${bogus.status} ${bogus.body.error?.code} · 列会话 ${bogusList.status} ${bogusList.body.error?.code}`,
  );

  // 每项目会话隔离：项目 B 的 sid 不能用于项目 A（反之亦然）
  const bSession = await newSession(PROJ_B, 100, 24);
  ok(
    path.resolve(bSession.cwd) === path.resolve(ROOT_B),
    `③ 项目 B 的会话 cwd 锁 B 的项目根（${bSession.cwd}）`,
  );
  const crossStream = await openStream(refilled.id, PROJ_A); // 先订阅（否则晚订阅会漏掉输出，"没串台"就证不实）
  await sleep(800); // 等 cmd 首帧
  const crossIn = await api(
    "POST",
    `/api/terminal/${encodeURIComponent(refilled.id)}/in?project_id=${PROJ_B}`,
    { data: "echo E1_CROSS_TALK_SHOULD_NOT_LAND\r" },
  );
  await sleep(1000);
  const crossListA = await listSessions(PROJ_A);
  const crossListB = await listSessions(PROJ_B);
  ok(
    crossIn.status === 404 && crossIn.body.error?.code === "SESSION_NOT_FOUND",
    `③ 项目 A 的 sid 挂项目 B 的项目范围 → ${crossIn.status} ${crossIn.body.error?.code}（跨项目一律视为不存在）`,
  );
  ok(
    !/E1_CROSS_TALK_SHOULD_NOT_LAND/.test(crossStream.text()),
    "③ 被跨项目拒掉的那次输入**没有落到 A 的会话**（A 自己的输出流里查不到该串）",
  );
  ok(
    crossListA.body.sessions?.every((s) => s.projectId === PROJ_A) === true &&
      crossListB.body.sessions?.every((s) => s.projectId === PROJ_B) === true &&
      crossListA.body.sessions?.every((s) => s.id !== bSession.id) === true &&
      crossListB.body.sessions?.every((s) => s.id !== refilled.id) === true,
    `③ 会话清单按项目隔离：A 列 ${crossListA.body.count} 个全属 A、B 列 ${crossListB.body.count} 个全属 B，两边 sid 互不出现`,
  );
  const crossDelete = await api(
    "DELETE",
    `/api/terminal/${encodeURIComponent(refilled.id)}?project_id=${PROJ_B}`,
  );
  const stillThere = await api(
    "POST",
    `/api/terminal/${encodeURIComponent(refilled.id)}/in?project_id=${PROJ_A}`,
    { data: "\r" },
  );
  ok(
    crossDelete.body.removed === false && stillThere.status === 200,
    "③ 项目 B 关不掉项目 A 的会话（removed=false），A 自己的会话照旧可用（200）",
  );
  const crossStream404 = await fetch(
    `${base}/api/terminal/${encodeURIComponent(refilled.id)}/out?project_id=${PROJ_B}`,
  );
  ok(
    crossStream404.status === 404,
    `③ 跨项目连 SSE 输出流 → ${crossStream404.status}（不是 200 空流，不静默）`,
  );

  // 收尾：把本轮所有会话关掉，并逐个断言 pid 消失（无僵尸）
  const allNow = await listSessions();
  const pids = (allNow.body.sessions ?? []).map((s) => s.pid);
  for (const s of allNow.body.sessions ?? []) {
    await closeSession(s.projectId, s.id);
  }
  let allGone = true;
  for (const pid of pids) {
    if (!(await waitPidGone(pid))) allGone = false;
  }
  const afterAll = await listSessions();
  ok(
    afterAll.body.count === 0,
    `③ 收尾：全部会话关闭后活跃会话数 ${afterAll.body.count}（Map 摘除干净）`,
  );
  ok(
    allGone && pids.length > 0,
    `③ 收尾：本轮 ${pids.length} 个 PTY 进程 pid 在 tasklist 全部查不到（无僵尸）—— ${pids.slice(0, 3).join("/")}${pids.length > 3 ? "/…" : ""}`,
  );
}

// ───────────────────────── ④ 源码级护栏：pane 上限两侧同口径 + 独立三件套只在 pane 内 ─────────────────────────

function checkSourceGuard(): void {
  console.log("\n[verify] ── ④ 源码级护栏：分屏结构（每 pane 独立会话）+ 上限同口径 + 零新依赖");
  const read = (f: string) => fs.readFileSync(path.join(REPO_ROOT, f), "utf8");
  const strip = (s: string) => s.replace(/\/\/[^\n]*/g, ""); // 先剥注释再扫，防"注释里提到"假通过
  const server = read("src/server/pty.ts");
  const container = read("src/ui/components/TerminalView.tsx");
  const pane = read("src/ui/terminal/TerminalPane.tsx");
  const apiSrc = read("src/ui/api.ts");

  const num = (src: string, name: string): number => {
    const m = src.match(new RegExp(`${name}\\s*=\\s*(\\d+)`));
    return m ? Number(m[1]) : NaN;
  };
  const serverMax = num(server, "MAX_SESSIONS_PER_PROJECT");
  const uiMax = num(container, "MAX_PANES_PER_PROJECT");
  ok(
    Number.isFinite(serverMax) && serverMax === uiMax && serverMax > 1,
    `④ pane 上限两侧同口径：后端 MAX_SESSIONS_PER_PROJECT=${serverMax} == 前端 MAX_PANES_PER_PROJECT=${uiMax}`,
  );

  const c = strip(container);
  ok(
    !/new\s+Terminal\s*\(/.test(c) && !/new\s+EventSource\s*\(/.test(c) && !/createTerminal\s*\(/.test(c),
    "④ 分屏容器（TerminalView）零 xterm 实例 / 零 EventSource / 零建会话调用 —— 结构上不可能共用 PTY",
  );
  const p = strip(pane);
  ok(
    /new\s+Terminal\s*\(/.test(p) &&
      /new\s+EventSource\s*\(/.test(p) &&
      /createTerminal\s*\(/.test(p) &&
      /new\s+ResizeObserver\s*\(/.test(p),
    "④ 每个 pane 自建独立 xterm + 独立 SSE + 独立 ResizeObserver（三件套全在 pane 内，per-pane）",
  );
  ok(
    /terminalStreamUrl\s*\(/.test(p) && apiSrc.includes("?project_id=") && apiSrc.includes("scopeQuery"),
    "④ pane 的每个请求都带项目范围（api.ts 的 scopeQuery → ?project_id=），后端会话隔离真生效",
  );
  const external = (s: string) =>
    [...s.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]).filter((x) => !x.startsWith("."));
  const ext = [...new Set([...external(container), ...external(pane)])];
  ok(
    ext.length > 0 && ext.every((x) => x === "react" || x.startsWith("@xterm/")),
    `④ 零新 npm 依赖：分屏代码的外部 import 只有 ${ext.join(" / ")}（@xterm/* 与 react 都是 T2 起既有）`,
  );
}

// ───────────────────────── ⑤ UI 段：playwright（动态端口 + 探活） ─────────────────────────

async function uiPlaywright(specPath: string, backendPort: number): Promise<void> {
  fs.mkdirSync(VERIFY_DIR, { recursive: true });
  const pyPath = path.join(VERIFY_DIR, "e1-shot.py");
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
    }).toString();
    process.stdout.write(out);
    ok(
      out.includes("UI_ASSERT_ALL_PASS"),
      "① ② ③ ④ playwright：两个 pane 独立会话 / 不串台 / 左右上下切换 / 关一个不影响另一个 全过",
    );
  } catch (e) {
    process.stdout.write((e as { stdout?: Buffer }).stdout?.toString() ?? "");
    process.stderr.write((e as { stderr?: Buffer }).stderr?.toString() ?? "");
    ok(false, "UI 段执行失败（见上方输出）");
  } finally {
    killTree(vite, vitePort);
    await sleep(500);
  }
  const shots = [
    "e1-01-one-pane.png",
    "e1-02-two-panes-row.png",
    "e1-03-two-panes-typed-row.png",
    "e1-04-two-panes-column.png",
    "e1-05-layout-back-row.png",
    "e1-06-close-one-pane.png",
  ];
  for (const shot of shots) {
    ok(fs.existsSync(path.join(VERIFY_DIR, shot)), `UI 截图落盘 .工作台/verify/${shot}`);
  }
}

/** UI 段 python（playwright 写法同 verify-n3/f4；参数走一段 JSON） */
const PY_SHOT = String.raw`# E1 UI 验证：多终端分屏（两个 pane 独立会话 / 左右上下切换 / 关一个不影响另一个）
# 用法：python e1-shot.py <vitePort> <backendPort> <spec.json>
import json
import os
import re
import subprocess
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
ROOT = SPEC["projectRoot"]
SUB_A = SPEC["subA"]
SUB_B = SPEC["subB"]
PANE_MARKS = SPEC["marks"]
OUT = "."

fails = []
PAGE = None


def ok(cond, label):
    print(("[UI PASS] " if cond else "[UI FAIL] ") + label)
    if not cond:
        fails.append(label)


def api(method, path, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(
        API + path, data=data, method=method,
        headers={"content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode())


def pid_alive(pid):
    out = subprocess.run(
        ["tasklist", "/FI", "PID eq " + str(pid), "/NH"],
        capture_output=True, text=True, encoding="utf-8", errors="ignore").stdout
    return str(pid) in out


def wait_pid_gone(pid, timeout=10):
    t0 = time.time()
    while time.time() - t0 < timeout:
        if not pid_alive(pid):
            return True
        time.sleep(0.4)
    return False


def pane(idx):
    return PAGE.locator(f"[data-terminal-pane-index='{idx}']")


def view_attr(name):
    return PAGE.locator("[data-terminal-view]").first.get_attribute(name)


def pane_attr(idx, name):
    return pane(idx).get_attribute(name)


def wait_pane_attr(idx, name, timeout=25):
    t0 = time.time()
    while time.time() - t0 < timeout:
        v = pane_attr(idx, name)
        if v:
            return v
        time.sleep(0.2)
    raise AssertionError("pane %d 的 %s 迟迟为空" % (idx, name))


def pane_text(idx):
    return pane(idx).locator(".xterm").first.inner_text()


def wait_text(idx, needle, timeout=25):
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


def box(idx):
    return pane(idx).bounding_box()


def wait_sessions(sids, timeout=20):
    """等后端活跃会话数收敛到期望集合（StrictMode 双挂载/卸载 DELETE 在途时会有瞬时多会话）"""
    t0 = time.time()
    while time.time() - t0 < timeout:
        st, body = api("GET", "/api/terminal/sessions?project_id=" + urllib.parse.quote(PID))
        if st == 200 and set(s["id"] for s in body.get("sessions", [])) == set(sids):
            return body
        time.sleep(0.4)
    st, body = api("GET", "/api/terminal/sessions?project_id=" + urllib.parse.quote(PID))
    return body


def shot(name):
    PAGE.screenshot(path=os.path.join(OUT, name))
    print("[info] 截图 " + name)


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1680, "height": 1000})
    PAGE = page
    page_errors = []
    page.on("pageerror", lambda e: page_errors.append(str(e)))
    page.goto(BASE + "/#p/" + PID)
    page.wait_for_selector("text=项目管理", timeout=20000)
    page.locator("nav button:has-text('终端')").click()
    page.wait_for_selector("[data-terminal-view]", timeout=20000)
    page.wait_for_selector("[data-terminal-pane] .xterm", timeout=20000)

    # ── 前置：默认 1 个 pane，cwd 显示 = 项目根（DoD④）──
    ok(view_attr("data-terminal-pane-count") == "1", "初始 1 个 pane（默认单终端，T2 行为不退化）")
    cwd0 = wait_pane_attr(0, "data-terminal-cwd")
    ok(os.path.normcase(cwd0) == os.path.normcase(ROOT),
       "④ pane 1 头部显示的 cwd = 项目根（%s）" % cwd0)
    shot("e1-01-one-pane.png")

    # ── 开第二个 pane（DoD① 前提：>=2 个 pane）──
    page.locator("[data-terminal-add]").click()
    t0 = time.time()
    while time.time() - t0 < 15 and view_attr("data-terminal-pane-count") != "2":
        time.sleep(0.2)
    ok(view_attr("data-terminal-pane-count") == "2", "点「＋ 新增终端」→ 2 个 pane")
    ok(page.locator("[data-terminal-pane] .xterm").count() == 2, "两个 pane 各挂一个独立 xterm 实例（DOM 上 2 个 .xterm）")
    sid0 = wait_pane_attr(0, "data-terminal-sid")
    sid1 = wait_pane_attr(1, "data-terminal-sid")
    pid0 = wait_pane_attr(0, "data-terminal-pid")
    pid1 = wait_pane_attr(1, "data-terminal-pid")
    cwd1 = wait_pane_attr(1, "data-terminal-cwd")
    ok(sid0 != sid1 and pid0 != pid1, "① 两个 pane 是**两个独立会话**（sid %s / %s，pid %s / %s）" % (sid0, sid1, pid0, pid1))
    ok(os.path.normcase(cwd1) == os.path.normcase(ROOT), "④ pane 2 头部显示的 cwd 也 = 项目根（%s）" % cwd1)
    body = wait_sessions([sid0, sid1])
    ok(set(s["id"] for s in body.get("sessions", [])) == {sid0, sid1},
       "① 后端会话清单 = 两个 pane 的 sid 集合（前端 pane 数 = 后端会话数，无幽灵会话）")
    ok(view_attr("data-terminal-layout") == "row", "③ 默认布局 = 左右（data-terminal-layout=row）")
    b0, b1 = box(0), box(1)
    ok(abs(b0["y"] - b1["y"]) < 4 and b0["x"] + b0["width"] <= b1["x"] + 4,
       "③ 左右布局几何关系成立（pane1 在左、pane2 在右：x %.0f+%.0f <= %.0f，y 差 %.1f）" % (b0["x"], b0["width"], b1["x"], abs(b0["y"] - b1["y"])))
    shot("e1-02-two-panes-row.png")

    # ── DoD① 两 pane 各敲各的，输出各归各位 ──
    type_in(0, "cd " + SUB_A)
    type_in(0, "cd")
    type_in(0, "echo " + PANE_MARKS[0])
    type_in(1, "cd " + SUB_B)
    type_in(1, "cd")
    type_in(1, "echo " + PANE_MARKS[1])
    t1 = wait_text(0, PANE_MARKS[0])
    t2 = wait_text(1, PANE_MARKS[1])
    time.sleep(0.8)
    t1, t2 = pane_text(0), pane_text(1)
    ok(PANE_MARKS[0] in t1 and PANE_MARKS[1] not in t1,
       "① pane 1 输出区含自己的标记 %s、不含 pane 2 的标记 %s（输入没跑到对面）" % (PANE_MARKS[0], PANE_MARKS[1]))
    ok(PANE_MARKS[1] in t2 and PANE_MARKS[0] not in t2,
       "① pane 2 输出区含自己的标记 %s、不含 pane 1 的标记 %s" % (PANE_MARKS[1], PANE_MARKS[0]))
    ok(("\\" + SUB_A) in t1 and ("\\" + SUB_B) not in t1,
       "① pane 1 的 cd 输出是本 pane 的子目录（含 \\%s、不含 \\%s）" % (SUB_A, SUB_B))
    ok(("\\" + SUB_B) in t2 and ("\\" + SUB_A) not in t2,
       "① pane 2 的 cd 输出是本 pane 的子目录（含 \\%s、不含 \\%s）" % (SUB_B, SUB_A))
    print("[info] pane 1 输出实录: " + repr(t1[-260:]))
    print("[info] pane 2 输出实录: " + repr(t2[-260:]))
    shot("e1-03-two-panes-typed-row.png")

    # ── DoD③ 左右 → 上下切换（同两个会话，sid 不变）──
    page.locator("[data-terminal-layout-toggle]").click()
    page.wait_for_timeout(900)
    ok(view_attr("data-terminal-layout") == "column", "③ 点「切换布局」→ data-terminal-layout=column（上下）")
    b0, b1 = box(0), box(1)
    ok(abs(b0["x"] - b1["x"]) < 4 and b0["y"] + b0["height"] <= b1["y"] + 4,
       "③ 上下布局几何关系成立（pane1 在上、pane2 在下：y %.0f+%.0f <= %.0f，x 差 %.1f）" % (b0["y"], b0["height"], b1["y"], abs(b0["x"] - b1["x"])))
    ok(pane_attr(0, "data-terminal-sid") == sid0 and pane_attr(1, "data-terminal-sid") == sid1,
       "③ 切布局不重建会话（两个 sid 与切换前一致 %s / %s）" % (sid0, sid1))
    ok(PANE_MARKS[0] in pane_text(0) and PANE_MARKS[1] in pane_text(1),
       "③ 切布局后两个 pane 的历史输出都还在（各自的标记仍可见）")
    shot("e1-04-two-panes-column.png")

    page.locator("[data-terminal-layout-toggle]").click()
    page.wait_for_timeout(900)
    b0, b1 = box(0), box(1)
    ok(view_attr("data-terminal-layout") == "row" and abs(b0["y"] - b1["y"]) < 4,
       "③ 再切回左右（row）几何关系复原 —— 左右/上下可来回切换")
    shot("e1-05-layout-back-row.png")

    # ── DoD② 关一个 pane 不影响另一个 ──
    page.locator("[data-terminal-pane-index='0'] [data-terminal-pane-close]").click()
    t0 = time.time()
    while time.time() - t0 < 15 and view_attr("data-terminal-pane-count") != "1":
        time.sleep(0.2)
    ok(view_attr("data-terminal-pane-count") == "1", "② 点 pane 1 的「关闭」→ 只剩 1 个 pane")
    left_sid = wait_pane_attr(0, "data-terminal-sid")
    left_pid = wait_pane_attr(0, "data-terminal-pid")
    ok(left_sid == sid1 and left_pid == pid1,
       "② 剩下的就是原来的 pane 2（sid %s / pid %s 原样，没被重开会话）" % (left_sid, left_pid))
    ok(pid_alive(int(pid1)), "② 残留 pane 的 pid=%s 仍存活（关一个没连累另一个）" % pid1)
    type_in(0, "echo " + PANE_MARKS[2])
    t3 = wait_text(0, PANE_MARKS[2])
    ok(PANE_MARKS[2] in t3, "② 残留 pane 仍能执行命令（echo %s → 输出出来）" % PANE_MARKS[2])
    ok(PANE_MARKS[1] in t3 and ("\\" + SUB_B) in t3,
       "② 残留 pane 的原有输出与历史未被清掉（本 pane 的标记 %s 与 \\%s 仍在屏上）" % (PANE_MARKS[1], SUB_B))
    body = wait_sessions([sid1])
    ok(set(s["id"] for s in body.get("sessions", [])) == {sid1},
       "② 后端只剩 pane 2 的会话（活跃 %d 个，sid=%s）" % (body.get("count"), sid1))
    st, body = api("POST", "/api/terminal/" + urllib.parse.quote(sid0) + "/in?project_id=" + urllib.parse.quote(PID), {"data": "x\r"})
    ok(st == 404 and body.get("error", {}).get("code") == "SESSION_NOT_FOUND",
       "② 被关掉的那个会话已不可用（POST /in → %d SESSION_NOT_FOUND）" % st)
    ok(wait_pid_gone(int(pid0)), "② 被关掉的 pane 的 pid=%s 在 tasklist 查不到（无僵尸进程）" % pid0)
    shot("e1-06-close-one-pane.png")

    # ── 收尾：关掉最后一个 pane → 空态 + 后端零会话 + 无僵尸 ──
    page.locator("[data-terminal-pane-index='0'] [data-terminal-pane-close]").click()
    t0 = time.time()
    while time.time() - t0 < 15 and view_attr("data-terminal-pane-count") != "0":
        time.sleep(0.2)
    ok(view_attr("data-terminal-pane-count") == "0" and page.locator("[data-terminal-empty]").count() == 1,
       "② 全部 pane 关掉 → pane 数 0 + 空态提示（可再开）")
    body = wait_sessions([])
    ok(body.get("count") == 0, "② 收尾：后端该项目活跃会话 0（实际 %d）" % body.get("count"))
    ok(wait_pid_gone(int(pid1)), "② 收尾：最后一个 pane 的 pid=%s 也查不到（无僵尸）" % pid1)

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
  checkSourceGuard();

  const specPath = path.join(VERIFY_DIR, "e1-spec.json");
  fs.writeFileSync(
    specPath,
    JSON.stringify(
      {
        project: PROJ_A,
        projectRoot: ROOT_A,
        subA: "sa",
        subB: "sb",
        marks: ["E1_PANE1_ONLY", "E1_PANE2_ONLY", "E1_PANE2_STILL_ALIVE"],
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

    console.log("\n[verify] ── ⑤ UI 段：起 vite（动态端口）+ playwright 真开两个 pane");
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
    `收尾：8787/5173 状态与开工前一致（${fixedAfter.v ? "有人在用" : "空闲"} / ${fixedAfter.d ? "有人在用" : "空闲"}）——本脚本没占用、没杀 PID`,
  );
  fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
  fs.rmSync(HOME_DIR, { recursive: true, force: true });
  ok(
    !fs.existsSync(FIXTURE_DIR) && !fs.existsSync(HOME_DIR),
    "收尾：临时夹具（e1-fixture / e1-home）已删除，真实注册表与真实项目零触碰",
  );
}

main()
  .then(() => console.log(process.exitCode ? "[verify] 存在 FAIL" : "[verify] 全部 PASS"))
  .catch((e) => {
    console.error("[verify] 异常:", e);
    process.exitCode = 1;
  });
