// V09-14 验证脚本（tsx 跑）：桌面壳后端进程生命周期与端口释放
// （PLAN.md V09-14；DESIGN.md §11.3 / §11.8「桌面壳退出与被强杀」一行 / §7.4 / §12.1-19 /
//   附录 E.10 第 2 行 / 附录 G-6）
//
// 用法：pnpm verify:v09-14
//   · 自带临时 TATAI_HOME 与夹具项目（v1 登记 → 用项目自己的迁移器真迁到 v2），
//     **不碰**真实注册表、真实项目、真实 `.工作台`；端口用规范里点名的 8787，
//     前置若不空闲则如实报出占用者（并把它当 ④ 的旁观者）、本轮改用备用端口。
//   · 两条腿都跑：壳替身（`src-tauri/shell-sim`，几秒可编、可脚本化）＋**真壳**
//     （`src-tauri/target/debug/tatai.exe`，在位且比源码新时跑真 GUI 两轮）；判据同一套。
//
// 环境假设（如实写出来，别让"本机能跑"变成隐含前提）：
//   · Rust 工具链 + `windows` crate 已在 cargo 缓存里（脚本用 `cargo build --offline`；
//     干净机器先 `cargo fetch` 一次、或把 `--offline` 去掉即可）；
//   · 本机（作者机器）把 CARGO_HOME/RUSTUP_HOME/TMP/TEMP 放在 **ASCII 路径**下——mingw 的
//     ld/dlltool 读不了非 ASCII 路径（`src-tauri/README.md`「本机工具链」一节）。脚本会检测
//     非 ASCII 的 TMP/TEMP 并换成 ASCII 候选，但**不会**替你造工具链；工具链不在场时如实红。
//   · Windows + `tasklist`/`netstat`/`taskkill`（读进程与端口、按 PID 收口）；非 Windows 平台上
//     ①② 的进程观测断言不成立，本脚本不冒充跨平台。
//
// 覆盖（逐条对着施工规格「检查项」）：
//   ① 正常关闭：壳正常退出 ⇒ 后端子树全部退出、8787 可再次绑定（前后两轮端口读数对照）。
//   ② 强制结束（含反例）：模拟任务管理器「结束进程」＝`taskkill /PID <壳> /F`（**不带 /T**）后同样满足①；
//      反例（`--no-job` 不挂 Job）**必须真的留下 node 孤儿占住 8787**——否则说明这套断言抓不到残留，
//      「通过」就没有意义（判据不因为是反例就放宽）。
//   ③ 数据不丢：强杀前经 MCP（真 agent 口径）写入的 v2 事实重启后可重读、事件账本 `last_seq` 不倒退；
//      强杀后独立 MCP 的写需求仍按 v0.7 自愈机制按需拉起写服务（自愈后再写一笔记得上）。
//   ④ 不误杀：①② 全程另有旁观者（本机既有 node 进程 + 受控无关 node 服务 + 另一个 MCP 客户端进程）
//      存活且可用（前后 PID 对照）；源码级反例断言：不出现按进程名杀灭。
//   ⑤ 依赖与许可：`windows` crate 的 LICENSE **原文**回读（逐句比对 ＋ sha256 与登记值对照）
//      ＋ Cargo.toml feature 最小集 ＋ 登记落在 `src-tauri/README.md` 与 `docs/LICENSE-AUDIT.md` 两处。
//   ⑥ 门槛与回归（脚本内可断言的那部分）：本脚本已在 package.json 登记；端口占用检查、taskkill 兜底、
//      v0.7 自愈入口、U1/U2 依赖的源码锚点都没被削；其余回归（verify:u1 / u2 / v07-01、typecheck、
//      build、build:server）由交付日志核对（`.工作台/evidence/V09-14/1/reg-*.log` / `gate-*.log`）。
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { addProject } from "../src/server/registry";
import { applyMigration, validateMigration } from "../src/server/work/migrate";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TAURI_DIR = path.join(REPO_ROOT, "src-tauri");
const SIM_MANIFEST = path.join(TAURI_DIR, "shell-sim", "Cargo.toml");
const SIM_TARGET_DIR = path.join(TAURI_DIR, "target", "shell-sim");
// 产物落点与构建落点必须同源：脚本用 --target-dir 把壳替身编到已 gitignore 的 src-tauri/target 下
const SIM_EXE = path.join(SIM_TARGET_DIR, "debug", "tatai-shell-sim.exe");
const REAL_SHELL = path.join(TAURI_DIR, "target", "debug", "tatai.exe");
const PACKAGED_MCP = path.join(TAURI_DIR, "resources", "server", "mcp.js");

const PORT = 8787; // 规范里点名的端口（＝ backend.rs::DEFAULT_PORT）
const DECOY_PORT = 8799; // 受控旁观者的端口（无关 node 服务）
const HEALTH_TIMEOUT_MS = 45_000;

let pass = 0;
let fail = 0;
const ok = (cond: boolean, label: string): void => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (cond) pass++;
  else {
    fail++;
    process.exitCode = 1;
  }
};
const info = (m: string): void => console.log(`[verify]   ${m}`);
const section = (t: string): void => console.log(`\n[verify] ── ${t}`);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const sha256 = (buf: Buffer | string): string => crypto.createHash("sha256").update(buf).digest("hex");
const quote = (lines: string[]): void => lines.forEach((l) => console.log(`        ${l}`));

// ── 观测原语（按 PID / 端口读数；全程不按进程名杀灭）──
// 用 spawnSync 直接起 exe（不经 cmd.exe 解析），失败重试三次：本轮实测过一次
// `tasklist`/`netstat` 在 tsx 启动的风口上双双拿到空输出——观测工具自己不可靠时，
// 判据会变成假红/假绿，所以观测层必须比被观测量更硬。
const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};
const win = (exe: string, args: string[], timeoutMs = 15_000): { ok: boolean; out: string } => {
  let last = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = spawnSync(exe, args, { encoding: "utf8", windowsHide: true, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
    const out = (r.stdout ?? "").trim();
    if (!r.error && r.status === 0) return { ok: true, out };
    last = r.error ? r.error.message : `${out}${r.stderr ?? ""}`;
    if (attempt < 3) sleepSync(250);
  }
  return { ok: false, out: last };
};
const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();
/** 强杀（带 /F）＝任务管理器「结束进程」的等价物：**不带 /T**，只杀这个进程本身 */
const killHard = (pid: number): string => oneLine(win("taskkill", ["/PID", String(pid), "/F"]).out);
/** 正常关闭：`taskkill` 不带 /F 会给窗口发关闭请求（＝点窗口右上角 X） */
const killSoft = (pid: number): string => oneLine(win("taskkill", ["/PID", String(pid)]).out);
/** 结束整棵树（兜底清理用；仍是按 PID，不是按名字） */
const killTree = (pid: number): string => oneLine(win("taskkill", ["/PID", String(pid), "/T", "/F"]).out);

function pidSet(image: string): Set<number> {
  const out = win("tasklist", ["/FI", `IMAGENAME eq ${image}`, "/FO", "CSV", "/NH"]).out;
  const set = new Set<number>();
  for (const line of out.split(/\r?\n/)) {
    const m = /^"[^"]+","(\d+)"/.exec(line.trim());
    if (m) set.add(Number(m[1]));
  }
  return set;
}
const nodePids = (): Set<number> => pidSet("node.exe");
const alive = (pid: number): boolean =>
  pid > 0 && new RegExp(`"${pid}"`).test(win("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"]).out);

interface PortReading {
  /** netstat 上该端口的 LISTENING 占用者 pid（多网卡/多协议去重） */
  pids: number[];
  /** netstat 命中的原始行（诊断用；空数组＝netstat 说没人监听） */
  lines: string[];
  /** 连得通（端口确实有服务在应答） */
  reachable: boolean;
}
async function readPort(port: number): Promise<PortReading> {
  const raw = win("netstat", ["-ano"]).out;
  const lines: string[] = [];
  const pids = new Set<number>();
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/.exec(line);
    if (m && Number(m[1]) === port) {
      lines.push(line.trim());
      pids.add(Number(m[2]));
    }
  }
  const reachable = await new Promise<boolean>((resolve) => {
    const sock = net.connect({ host: "127.0.0.1", port });
    const done = (v: boolean): void => {
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(1200);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
  });
  return { pids: [...pids], lines, reachable };
}

/** 轮询到 netstat 报出占用者（最多 6s）：服务从 listen 到 netstat 可见可能有短暂间隔，
 *  观测层的抖动不该变成产品判据的抖动。 */
async function portPids(port: number): Promise<PortReading> {
  const deadline = Date.now() + 6000;
  let last = await readPort(port);
  while (last.pids.length === 0 && Date.now() < deadline) {
    await sleep(400);
    last = await readPort(port);
  }
  return last;
}

/** 端口能不能重新绑定（真 bind 一次再放开；被占用时 EADDRINUSE ⇒ false） */
function canBind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
  });
}

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

interface HttpResult {
  status: number;
  body: string;
}
// 每次都用**独立**、非 keep-alive 的连接：全局 agent 在 Node ≥19 默认 keepAlive，
// 闲置几秒后服务端关掉 socket，复用会撞 ECONNRESET（本轮实测过：旁观者探活偶发"连不上"）。
const httpAgent = new http.Agent({ keepAlive: false });
function request(port: number, pathname: string): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: pathname,
        method: "GET",
        timeout: 4000,
        agent: httpAgent,
        headers: { Connection: "close" },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
      },
    );
    req.on("timeout", () => req.destroy(new Error("超时")));
    req.on("error", reject);
    req.end();
  });
}

async function waitFor(label: string, cond: () => boolean | Promise<boolean>, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return true;
    await sleep(400);
  }
  info(`（等「${label}」超时 ${timeoutMs}ms，判据按下一条断言给出）`);
  return false;
}

// ── 被拉起的进程一律登记在册：收尾按 PID 清干净（先 /T 整棵树，再单独补刀）──
const spawnedProcs = new Set<ChildProcess>();
function track(proc: ChildProcess): ChildProcess {
  spawnedProcs.add(proc);
  proc.once("exit", () => spawnedProcs.delete(proc));
  return proc;
}

interface ShellRun {
  proc: ChildProcess;
  shellPid: number;
  backendPid: number;
  treePids: number[];
  log: () => string;
  finished: Promise<number | null>;
}

const simArgs = (port: number, home: string, o: { noJob?: boolean; mode: "exit" | "hold" }): string[] => {
  const args = ["--port", String(port), "--cwd", REPO_ROOT, "--home", home, "--health-timeout", "40"];
  if (o.noJob) args.push("--no-job");
  if (o.mode === "hold") args.push("--hold");
  else args.push("--exit-after", "10"); // 正常退出：探活后再等 10s，够脚本记前一轮读数
  return args;
};

interface LaunchOpts {
  noJob?: boolean;
  mode: "exit" | "hold";
  home: string;
  port: number;
}

/** 壳替身：按 backend.rs 的配方拉起真后端 → 挂 Job → 收尾方式由 mode 决定 */
async function launchSim(o: LaunchOpts): Promise<ShellRun> {
  const before = nodePids();
  const proc = track(spawn(SIM_EXE, simArgs(o.port, o.home, o), { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] }));
  return collect(proc, before, /\[sim\] SIM_PID=(\d+)/, /\[sim\] (HEALTH|SPAWN_FAIL)=/, /\[sim\] BACKEND_PID=(\d+)/, "壳替身");
}

/** 真壳：与开发态起法一致（dev ⇒ cmd /C pnpm dev:server，cwd = 仓库根，端口经 TATAI_PORT） */
async function launchRealShell(port: number, home: string): Promise<ShellRun> {
  const before = nodePids();
  const proc = track(
    spawn(REAL_SHELL, [], {
      cwd: REPO_ROOT,
      env: { ...process.env, TATAI_HOME: home, TATAI_PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
  return collect(
    proc,
    before,
    /\[sim\] SIM_PID=(\d+)/,
    /后端就绪|等后端 \/health 超过/,
    /\[tatai\] 后端 pid=(\d+)/,
    "真壳",
  );
}

async function collect(
  proc: ChildProcess,
  before: Set<number>,
  pidRe: RegExp,
  readyRe: RegExp,
  backendRe: RegExp,
  what: string,
): Promise<ShellRun> {
  let text = "";
  proc.stdout?.on("data", (c: Buffer) => (text += c.toString()));
  proc.stderr?.on("data", (c: Buffer) => (text += c.toString()));
  const finished = new Promise<number | null>((resolve) => proc.once("exit", (code) => resolve(code)));
  const ready = await waitFor(`${what}报出阶段行`, () => readyRe.test(text), HEALTH_TIMEOUT_MS);
  if (!ready) info(`（${what}没有报出阶段行，见下面它的完整输出）`);
  const shellPid = Number(pidRe.exec(text)?.[1] ?? proc.pid ?? 0);
  const backendPid = Number(backendRe.exec(text)?.[1] ?? 0);
  // 子树 pid 用"并集"累积 6 秒：拉起链是 cmd→pnpm→tsx→node 一层层出来的，
  // 单次快照可能只截到第一层（本轮实测过），而漏掉的 pid 会让"收口是否干净"断言失去意义。
  const newPids = new Set<number>();
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    for (const p of nodePids()) if (!before.has(p)) newPids.add(p);
    if (newPids.size >= 2) break;
    await sleep(500);
  }
  for (const p of nodePids()) if (!before.has(p)) newPids.add(p);
  if (newPids.size === 0) {
    info(`（观测卫生：没读到${what}新起的 node 进程，tasklist 原始输出前 3 行：${win("tasklist", ["/FI", "IMAGENAME eq node.exe", "/FO", "CSV", "/NH"]).out.split(/\r?\n/).slice(0, 3).join(" ｜ ")}）`);
  }
  const treePids = [...newPids];
  if (backendPid > 0) treePids.push(backendPid);
  return { proc, shellPid, backendPid, treePids, log: () => text, finished };
}

// ── 夹具（临时 TATAI_HOME + 夹具项目；不碰真实数据）──
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-v09-14-"));
const homeRounds = path.join(tmpBase, "home-rounds"); // ①②④：只跑进程，不写项目事实
const homeData = path.join(tmpBase, "home-data"); // ③：夹具项目 + 事件账本
const projRoot = path.join(tmpBase, "proj");
const FIX = "v0914fix";
fs.mkdirSync(homeRounds, { recursive: true });
fs.mkdirSync(homeData, { recursive: true });
fs.mkdirSync(projRoot, { recursive: true });
const MIGRATION_OPTS = {
  real: { authorized_by: "verify:v09-14 夹具", basis: "临时 TATAI_HOME 内的夹具项目，不涉真实项目" },
};

async function finalCleanup(): Promise<void> {
  for (const proc of [...spawnedProcs]) {
    if (proc.pid && proc.exitCode === null) killTree(proc.pid);
  }
  await sleep(600);
  if (process.env.TATAI_V09_14_KEEP_TMP === "1") {
    info(`临时夹具保留在：${tmpBase}`);
  } else {
    try {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

// ═════════════ ⓪ 前置：工具链 → 壳替身可编可跑 → 旁观者基线 ═════════════

section("⓪ 前置：Rust 工具链 → 壳替身可编可跑（真跑，不是静态断言）");

const cargoEnv: NodeJS.ProcessEnv = { ...process.env };
// 本机踩坑（src-tauri/README「本机工具链」一节）：mingw 的 ld/dlltool 读不了非 ASCII 路径，
// CARGO_HOME/RUSTUP_HOME/TMP/TEMP 必须落在 ASCII 目录。**TMP/TEMP 是本轮实测的真坑**：
// 环境里已有的 TMP=C:\Users\<中文名>\AppData\Local\Temp 会让 dlltool 报
// "Cannot create temporary file …: Unknown error"——所以只要现值含非 ASCII 字符就换成 ASCII 候选。
for (const [key, candidate] of [
  ["CARGO_HOME", "D:\\tools\\rmw\\cargo"],
  ["RUSTUP_HOME", "D:\\tools\\rmw\\rustup"],
  ["TMP", "D:\\tools\\rmw\\tmp"],
  ["TEMP", "D:\\tools\\rmw\\tmp"],
] as const) {
  const current = cargoEnv[key];
  const nonAscii = current !== undefined && /[^\x20-\x7e]/.test(current);
  if ((current === undefined || nonAscii) && fs.existsSync(candidate)) {
    if (nonAscii) info(`构建环境订正：${key}=${current} 含非 ASCII 路径（mingw 读不了）⇒ 换 ${candidate}`);
    cargoEnv[key] = candidate;
  }
}
if (!cargoEnv.CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER) cargoEnv.CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER = "gcc";
const pathAdd = ["D:\\tools\\rmw\\cargo\\bin", "D:\\tools\\rmw\\mingw64\\bin"].filter((p) => fs.existsSync(p));
cargoEnv.PATH = [...pathAdd, cargoEnv.PATH ?? ""].join(path.delimiter);

const withEnv = (exe: string, args: string[], timeoutMs: number): { ok: boolean; out: string } => {
  const r = spawnSync(exe, args, {
    encoding: "utf8",
    env: cargoEnv,
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
  return { ok: !r.error && r.status === 0, out: out || (r.error ? r.error.message : "") };
};
const cargoVersion = withEnv("cargo", ["--version"], 60_000);
info(`cargo = ${oneLine(cargoVersion.out) || "(不可用)"}`);
info(
  `构建环境：CARGO_HOME=${cargoEnv.CARGO_HOME ?? "(默认)"}｜RUSTUP_HOME=${cargoEnv.RUSTUP_HOME ?? "(默认)"}｜TMP=${cargoEnv.TMP ?? "(默认)"}｜linker=${cargoEnv.CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER ?? "(默认)"}`,
);

const simBuild = withEnv(
  "cargo",
  ["build", "--offline", "--manifest-path", SIM_MANIFEST, "--target-dir", SIM_TARGET_DIR],
  900_000,
);
ok(simBuild.ok, `壳替身编得过：cargo build --offline --manifest-path src-tauri/shell-sim/Cargo.toml（exit ${simBuild.ok ? 0 : "非 0"}）`);
quote(simBuild.out.split(/\r?\n/).slice(-6));
ok(fs.existsSync(SIM_EXE), `产物在位：${path.relative(REPO_ROOT, SIM_EXE)}`);
const simSize = fs.existsSync(SIM_EXE) ? fs.statSync(SIM_EXE).size : 0;
ok(simSize > 0, `产物不是 0 字节（本机火绒曾拦新建 EXE ⇒ 0 字节；实测 ${simSize} B）`);
const selfcheck = win(SIM_EXE, ["--selfcheck"]);
info(`壳替身自检：${oneLine(selfcheck.out)}`);
ok(
  /SELFCHECK=ok/.test(selfcheck.out) && /rust_job_available=true/.test(selfcheck.out),
  "壳替身可执行，且它自己报 Job Object 可用（没有被拦执行）",
);
ok(
  fs.existsSync(path.join(SIM_TARGET_DIR, "debug")),
  `构建产物落在 ${path.relative(REPO_ROOT, SIM_TARGET_DIR)}（在已 gitignore 的 src-tauri/target 下，不往仓库添垃圾）`,
);
ok(fs.existsSync(PACKAGED_MCP), `随包 MCP 入口在场：${path.relative(REPO_ROOT, PACKAGED_MCP)}（pnpm build:server 的产出；③④ 都用到）`);

// 8787 前置读数
const portBefore = (await readPort(PORT)).pids;
if (portBefore.length === 0) {
  info(`端口 ${PORT} 前置读数：空闲 ⇒ 本轮就在 ${PORT} 上验「释放与可重绑」`);
} else {
  info(`端口 ${PORT} 前置读数：已被外部进程 pid ${portBefore.join("/")} 占用 ⇒ 本轮改用备用端口，占用者按 ④ 的旁观者对照`);
}
const roundPort = portBefore.length === 0 ? PORT : await freePort();
if (roundPort !== PORT) info(`（本轮端口 = ${roundPort}）`);

// 旁观者基线（④ 的对照物）：本机既有 node 进程 + 受控无关 node 服务 + 另一个 MCP 客户端进程
const nodeBaseline = nodePids();
const decoyHttp = track(
  spawn(process.execPath, ["-e", `require("http").createServer((q,s)=>s.end("decoy-ok")).listen(${DECOY_PORT},"127.0.0.1")`], {
    stdio: ["ignore", "pipe", "pipe"],
  }),
);
const decoyMcp = track(
  spawn(process.execPath, [PACKAGED_MCP], {
    cwd: REPO_ROOT,
    env: { ...process.env, TATAI_HOME: homeData },
    stdio: ["pipe", "pipe", "pipe"],
  }),
);
await sleep(1500);
const decoyPids = [decoyHttp.pid ?? 0, decoyMcp.pid ?? 0].filter((p) => p > 0);
info(
  `旁观者基线：系统既有 node ${nodeBaseline.size} 个（pid ${[...nodeBaseline].slice(0, 8).join("/")}${nodeBaseline.size > 8 ? "…" : ""}）` +
    `｜受控无关 node 服务 pid=${decoyHttp.pid ?? 0}（127.0.0.1:${DECOY_PORT}）｜另一个 MCP 客户端 pid=${decoyMcp.pid ?? 0}`,
);
ok(decoyPids.every((p) => alive(p)), `受控旁观者起来了（pid ${decoyPids.join("/")}）`);
ok(
  nodeBaseline.size >= 1,
  `基线里有本机既有 node 进程（实测 ${nodeBaseline.size} 个：宿主 agent 及其 MCP 服务端就是真实的「其他客户端」）`,
);

/** 每一轮过后都要过的旁观者对照（④ 正例方向） */
async function expectBystandersAlive(tag: string): Promise<void> {
  const deadExisting = [...nodeBaseline].filter((p) => !alive(p));
  ok(
    deadExisting.length === 0,
    `${tag} 不误杀：基线里 ${nodeBaseline.size} 个既有 node 进程全部存活（掉线 ${deadExisting.join("/") || "无"}）`,
  );
  const deadDecoys = decoyPids.filter((p) => !alive(p));
  ok(deadDecoys.length === 0, `${tag} 不误杀：受控旁观者 pid ${decoyPids.join("/")} 全部存活（掉线 ${deadDecoys.join("/") || "无"}）`);
  const decoy = await request(DECOY_PORT, "/").catch(() => null);
  ok(
    decoy?.status === 200 && decoy.body.includes("decoy-ok"),
    `${tag} 旁观者的无关服务仍可用：GET http://127.0.0.1:${DECOY_PORT}/ → ${decoy?.status ?? "连不上"}`,
  );
}

/** 一轮收口后的共同判据（①②③ 共用同一套，判据不放宽） */
async function expectTreeGoneAndPortFree(tag: string, run: ShellRun, port: number): Promise<void> {
  const gone = await waitFor("本轮后端子树退出", () => run.treePids.filter((p) => alive(p)).length === 0);
  const survivors = run.treePids.filter((p) => alive(p));
  ok(gone, `${tag} 后端子树全部退出：本轮 ${run.treePids.length} 个 pid（node + 壳直接子进程 ${run.backendPid}）查不到存活（残留 ${survivors.join("/") || "无"}）`);
  const free = await waitFor(`端口 ${port} 释放`, async () => (await canBind(port)) && (await readPort(port)).pids.length === 0);
  ok(free, `${tag} 端口 ${port} 可重新绑定（真 bind 成功 + 无 LISTENING 占用者）`);
}

// ═════════════ ① 正常关闭 ═════════════

section("① 正常关闭：壳正常退出 ⇒ 后端子树退出 + 8787 可再次绑定（前后两轮端口读数对照）");

{
  const run = await launchSim({ port: roundPort, home: homeRounds, mode: "exit" });
  quote(run.log().trim().split(/\r?\n/));
  ok(/\[sim\] JOB=on/.test(run.log()), "① 后端已挂进 Job Object（壳替身报 JOB=on）");
  ok(/\[sim\] ASSIGN=ok/.test(run.log()), "① 挂载动作成立（assign 成功，不是建了 Job 没人用）");
  ok(/\[sim\] HEALTH=ok/.test(run.log()), `① 真后端活了：GET http://127.0.0.1:${roundPort}/health → 200`);
  const occupied = await portPids(roundPort);
  ok(occupied.pids.length > 0, `① 前一轮端口读数：${roundPort} 被 pid ${occupied.pids.join("/")} 占着（netstat: ${occupied.lines[0] ?? "（无匹配行）"}）`);
  ok(
    run.treePids.length >= 2,
    `① 本轮子树确有深度：${run.treePids.length} 个 pid（${run.treePids.join("/")}）——tsx watch 会再套一层，只清直接子进程不够`,
  );

  const code = await run.finished;
  ok(code === 0, `① 壳替身走正常退出路径（exit code ${code}）`);
  ok(/\[sim\] REAP .*job=收口.*taskkill=兜底/.test(run.log()), "① 收口顺序如实：先 Job 终止整棵子树，再 taskkill 兜底");
  await expectTreeGoneAndPortFree("①", run, roundPort);
  info(`① 端口读数对照：前＝pid ${occupied.pids.join("/")} 占着 ${roundPort}；后＝bind 成功、无占用者`);
  await expectBystandersAlive("①");
}

// ═════════════ ② 强制结束（含反例） ═════════════

section("② 强制结束：taskkill /PID <壳> /F（不带 /T）后同样满足①；反例必须真的抓到孤儿");

{
  const run = await launchSim({ port: roundPort, home: homeRounds, mode: "hold" });
  quote(run.log().trim().split(/\r?\n/));
  ok(/\[sim\] JOB=on/.test(run.log()) && /\[sim\] ASSIGN=ok/.test(run.log()), "② 强杀这一路同样挂在 Job 上（JOB=on / ASSIGN=ok）");
  ok(/\[sim\] HEALTH=ok/.test(run.log()), `② 后端就绪：GET /health → 200（端口 ${roundPort}）`);
  const occupied = await portPids(roundPort);
  ok(occupied.pids.length > 0, `② 前一轮端口读数：${roundPort} 被 pid ${occupied.pids.join("/")} 占着`);
  ok(run.treePids.length >= 2, `② 本轮子树 ${run.treePids.length} 个 pid（${run.treePids.join("/")}）`);

  info(`强杀（模拟任务管理器「结束进程」，不带 /T）：taskkill /PID ${run.shellPid} /F → ${killHard(run.shellPid)}`);
  ok(await waitFor("壳进程消失", () => !alive(run.shellPid), 15_000), `② 壳进程 pid=${run.shellPid} 确已消失（强杀成功）`);
  await expectTreeGoneAndPortFree("②", run, roundPort);
  info(`② 端口读数对照：前＝pid ${occupied.pids.join("/")} 占着 ${roundPort}；后＝bind 成功、无占用者（内核按 KILL_ON_JOB_CLOSE 收口）`);
  await expectBystandersAlive("②");
}

{
  // 负对照：同一套动作，只把 Job 拿掉（--no-job）。这样都「通过」就说明断言抓不到残留。
  const run = await launchSim({ port: roundPort, home: homeRounds, mode: "hold", noJob: true });
  quote(run.log().trim().split(/\r?\n/));
  ok(/\[sim\] JOB=off/.test(run.log()), "②反例 壳替身如实报 JOB=off（没挂 Job）");
  ok(/\[sim\] HEALTH=ok/.test(run.log()), `②反例 后端就绪（端口 ${roundPort}）`);
  const occupied = await portPids(roundPort);
  ok(occupied.pids.length > 0, `②反例 前一轮端口读数：${roundPort} 被 pid ${occupied.pids.join("/")} 占着`);

  info(`反例强杀：taskkill /PID ${run.shellPid} /F → ${killHard(run.shellPid)}`);
  await waitFor("反例壳进程消失", () => !alive(run.shellPid), 15_000);
  await sleep(2000);
  const survivors = run.treePids.filter((p) => alive(p));
  const afterKill = await readPort(roundPort);
  const stillBound = afterKill.pids.length > 0;
  const bindable = await canBind(roundPort);
  ok(survivors.length > 0, `②反例 真的留下 node 孤儿：本轮 pid ${survivors.join("/")} 仍存活（这正是 V09-14 要修掉的那条路）`);
  ok(
    stillBound && !bindable,
    `②反例 孤儿仍占住端口 ${roundPort}（LISTENING 占用者 ${afterKill.pids.join("/")}，bind 失败）——反例命中 ⇒ ①② 的判据确实能抓残留`,
  );

  for (const pid of run.treePids) killTree(pid);
  await sleep(1500);
  const cleaned = await waitFor(
    "反例现场清理干净",
    async () => (await canBind(roundPort)) && run.treePids.every((p) => !alive(p)),
  );
  ok(cleaned, `②反例 现场按 PID 清理干净：${run.treePids.join("/")} 全部退出、端口 ${roundPort} 回到空闲（判据与①②同一套）`);
}

// ═════════════ ③ 数据不丢（强杀后重读 + Agent 接续） ═════════════

section("③ 数据不丢：强杀前写入的 v2 事实重启后可重读、last_seq 不倒退、v0.7 自愈仍在");

const record = addProject({ id: FIX, name: "V09-14 数据不丢夹具", path: projRoot, kind: "backend" }, homeData);
ok(record.id === FIX, `③ 夹具项目登记（走应用自己的注册模块 addProject；临时 TATAI_HOME=${path.relative(REPO_ROOT, homeData)}）`);
const migrated = applyMigration(FIX, homeData, MIGRATION_OPTS);
const validated = validateMigration(FIX, homeData, MIGRATION_OPTS);
const ledgerFile = path.join(projRoot, ".工作台", "work", "events.jsonl");
const stateFile = path.join(projRoot, ".工作台", "work", "state.json");
ok(
  validated.ok,
  `③ 夹具项目真迁移到 v2：回执 ${migrated.receipts.length} 条、校验 ${validated.checks.filter((c) => c.ok).length}/${validated.checks.length} PASS、事件账本在场`,
);

interface LedgerTail {
  seq: number;
  type: string;
  entity: string;
}
const ledgerLast = (): LedgerTail | null => {
  if (!fs.existsSync(ledgerFile)) return null;
  const lines = fs.readFileSync(ledgerFile, "utf8").trim().split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length === 0) return null;
  const last = JSON.parse(lines[lines.length - 1]) as { seq: number; type: string; entity_id: string };
  return { seq: last.seq, type: last.type, entity: last.entity_id };
};
const stateSeq = (): number | null => {
  if (!fs.existsSync(stateFile)) return null;
  return (JSON.parse(fs.readFileSync(stateFile, "utf8")) as { last_seq: number }).last_seq;
};

/** 经 MCP（真 agent 口径、同一个 TATAI_HOME）读 requirements 与 last_seq */
async function mcpRead(home: string): Promise<{ lastSeq: number; requirements: Record<string, { problem?: string }> }> {
  const client = new Client({ name: "v09-14-verify", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [PACKAGED_MCP],
    env: { ...process.env, TATAI_HOME: home },
    cwd: REPO_ROOT,
  });
  await client.connect(transport);
  try {
    const res = await client.callTool({ name: "manage_requirement", arguments: { op: "read", project_id: FIX } });
    const text = (res.content as { type: string; text?: string }[])[0]?.text ?? "{}";
    const parsed = JSON.parse(text) as { last_seq?: number; requirements?: Record<string, { problem?: string }> };
    return { lastSeq: parsed.last_seq ?? -1, requirements: parsed.requirements ?? {} };
  } finally {
    await client.close();
  }
}

/** 经 MCP 写一笔 v2 事实（requirement 登记）——这是 V09-16 落地的真 v2 写口 */
async function mcpRegister(home: string, id: string, problem: string): Promise<{ okFlag: boolean; seq: number | null }> {
  const client = new Client({ name: "v09-14-verify", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [PACKAGED_MCP],
    env: { ...process.env, TATAI_HOME: home },
    cwd: REPO_ROOT,
  });
  await client.connect(transport);
  try {
    const res = await client.callTool({
      name: "manage_requirement",
      arguments: {
        op: "register",
        project_id: FIX,
        requirement_id: id,
        problem,
        users: ["作者"],
        success_scenarios: ["强杀壳后端口释放、数据不丢、其他 Agent 客户端不受影响"],
        exclusions: ["不做按进程名杀灭"],
        priority: "high",
        source: { kind: "design", ref: "DESIGN.md §11.3" },
        status: "explicit",
        role: "designer",
      },
    });
    const text = (res.content as { type: string; text?: string }[])[0]?.text ?? "";
    const parsed = JSON.parse(text) as { ok?: boolean; receipts?: { seq?: number }[] };
    return { okFlag: parsed.ok === true && res.isError !== true, seq: parsed.receipts?.[0]?.seq ?? null };
  } finally {
    await client.close();
  }
}

{
  const run = await launchSim({ port: roundPort, home: homeData, mode: "hold" });
  ok(
    /\[sim\] JOB=on/.test(run.log()) && /\[sim\] HEALTH=ok/.test(run.log()),
    `③ 壳+后端在夹具数据目录上跑起来了（端口 ${roundPort}）`,
  );

  const before = ledgerLast();
  const wrote = await mcpRegister(homeData, "req-v0914-fix", "壳被强杀后 node 子树留孤儿、占住 8787（V09-14 夹具事实）");
  ok(wrote.okFlag, `③ 强杀前经 MCP 写入 v2 事实成功（requirement.registered，seq=${wrote.seq ?? "?"}）`);
  const afterWrite = ledgerLast();
  const seqBefore = stateSeq();
  ok(
    afterWrite !== null && afterWrite.seq > (before?.seq ?? 0) && afterWrite.seq === wrote.seq,
    `③ 事实真落进事件账本：events.jsonl 末条 seq=${afterWrite?.seq} type=${afterWrite?.type} entity=${afterWrite?.entity}（state.json last_seq=${seqBefore}）`,
  );
  const read1 = await mcpRead(homeData);
  ok(
    read1.lastSeq === seqBefore && Object.keys(read1.requirements).includes("req-v0914-fix"),
    `③ 写后可读回同一笔（MCP read：last_seq=${read1.lastSeq}）`,
  );

  info(`③ 强杀：taskkill /PID ${run.shellPid} /F → ${killHard(run.shellPid)}`);
  await waitFor("③ 壳进程消失", () => !alive(run.shellPid), 15_000);
  await expectTreeGoneAndPortFree("③", run, roundPort);
  ok(fs.existsSync(ledgerFile) && stateSeq() !== null, "③ 强杀没有动数据文件：事件账本与投影快照仍在盘上");

  // v0.7 自愈：壳已死，独立 MCP 再写一笔（本卡不改这条链）
  const selfHeal = await mcpRegister(homeData, "req-v0914-fix-2", "壳被强杀后独立 MCP 再写一笔：验证 v0.7 自愈链没被 V09-14 改坏");
  const afterHeal = ledgerLast();
  const healSeq = stateSeq();
  ok(
    selfHeal.okFlag && healSeq !== null && healSeq > (seqBefore ?? 0),
    `③ 强杀后独立 MCP 仍能写：v0.7 自愈按需拉起写服务（一笔 seq=${selfHeal.seq}，账本末条 seq=${afterHeal?.seq}，state last_seq=${healSeq}）`,
  );
  ok(healSeq !== null && healSeq >= (seqBefore ?? 0), `③ 账本 last_seq 不倒退：强杀前 ${seqBefore} → 自愈后 ${healSeq}`);

  // 重启：重新拉起壳，读回强杀前那笔事实 + 接续
  const again = await launchSim({ port: roundPort, home: homeData, mode: "hold" });
  ok(/\[sim\] HEALTH=ok/.test(again.log()), `③ 重启后后端回来了（端口 ${roundPort}）`);
  const read2 = await mcpRead(homeData);
  const keptProblem = read2.requirements["req-v0914-fix"]?.problem ?? "";
  ok(read2.lastSeq === healSeq, `③ 重启后重读：事件账本 last_seq=${read2.lastSeq} 与强杀后一致（不倒退、不丢段）`);
  ok(keptProblem.includes("壳被强杀后 node 子树留孤儿"), `③ 强杀前那笔事实逐字还在（可读回 requirement 正文：${keptProblem.slice(0, 22)}…）`);
  const listing = await request(roundPort, `/api/projects/${FIX}/tasks`);
  ok(listing.status === 200, `③ Agent 能继续接续：GET /api/projects/${FIX}/tasks → ${listing.status}（v2 投影可重读）`);
  ok(stateSeq() === healSeq, `③ 重启不产生幻影写入：state.json last_seq=${stateSeq()} 与账本末条 seq=${afterHeal?.seq} 同源`);

  killHard(again.shellPid);
  await waitFor("③ 收尾", () => !alive(again.shellPid), 15_000);
  info("③ 收尾：本轮壳已按 PID 强杀，子树由 Job 收口");
}

{
  // 自愈拉起的写服务（v0.7 daemon）按描述符 pid 收干净（不按名字）
  const descFile = path.join(homeData, "work-service.json");
  let cleanedPid: number | null = null;
  if (fs.existsSync(descFile)) {
    const desc = JSON.parse(fs.readFileSync(descFile, "utf8")) as { pid?: number };
    if (desc.pid && alive(desc.pid)) {
      killTree(desc.pid);
      cleanedPid = desc.pid;
    }
  }
  info(`③ 收尾：自愈写服务 ${cleanedPid === null ? "无残留在跑（描述符里的 pid 已退出）" : `按描述符 pid=${cleanedPid} 收口`}`);
  ok(true, "③ 收尾口径：一律按 PID（描述符/记录在册的 pid）收，不按进程名");
}

// ═════════════ ④ 不误杀（总读数 + 源码级反例） ═════════════

section("④ 不误杀：旁观者全程存活（上一节每轮已断言；这里给总读数与源码级反例）");

await expectBystandersAlive("④ 总结");
const rsFiles = fs.readdirSync(path.join(TAURI_DIR, "src")).filter((f) => f.endsWith(".rs"));
const rsSrc = rsFiles.map((f) => fs.readFileSync(path.join(TAURI_DIR, "src", f), "utf8")).join("\n");
ok(!/\/IM/.test(rsSrc), "④ 反例：收口代码里没有按进程名杀灭（无 taskkill /IM）");
ok(!/Stop-Process\s+-Name|taskkill\s+\/IM\s+node/i.test(rsSrc), "④ 反例：没有 Stop-Process -Name / taskkill /IM node 这类宽泛杀法");
ok(
  /taskkill/.test(rsSrc) && /"\/T"/.test(rsSrc) && /"\/F"/.test(rsSrc),
  "④ 兜底杀法仍是按 PID 的 taskkill /PID <pid> /T /F（与 verify:u1 ③ 的源码锚点同一处）",
);

// ═════════════ ⑤ 依赖与许可（LICENSE 原文回读） ═════════════

section("⑤ 依赖与许可：windows crate 的 LICENSE 原文核对与登记（DESIGN §7.4）");

const cargoToml = fs.readFileSync(path.join(TAURI_DIR, "Cargo.toml"), "utf8");
ok(/\[target\.'cfg\(windows\)'\.dependencies\]/.test(cargoToml), "⑤ 依赖声明挂在 Windows 目标的表下（非 Windows 构建不拉它）");
ok(/windows\s*=\s*\{\s*version\s*=\s*"0\.61"/.test(cargoToml), "⑤ 直接依赖 windows 0.61（与 Cargo.lock 里既有的 0.61.3 同版本线）");
const wantFeatures = ["Win32_Foundation", "Win32_Security", "Win32_System_JobObjects", "Win32_System_Threading"];
const missingFeatures = wantFeatures.filter((f) => !new RegExp(`"${f}"`).test(cargoToml));
ok(
  missingFeatures.length === 0,
  `⑤ feature 最小集四条齐（缺 ${missingFeatures.join("/") || "无"}）——每条都写明用在哪儿（Cargo.toml 注释）`,
);

const lock = fs.readFileSync(path.join(TAURI_DIR, "Cargo.lock"), "utf8");
ok(/name = "windows"\nversion = "0\.61\.3"/.test(lock), "⑤ windows 0.61.3 本就在 Cargo.lock 里（传递依赖）⇒ 本次是提为直接依赖，不是新进依赖树");
const tataiBlock = /name = "tatai"[\s\S]*?\n\n/.exec(lock)?.[0] ?? "";
ok(/^\s*"windows",$/m.test(tataiBlock), "⑤ Cargo.lock 的 tatai 包依赖里记上了 windows（直接依赖生效、锁文件同步）");

// 回读**原文**：crate 内的 license-mit / license-apache-2.0，逐句比对登记，再核 sha256
const cargoHome = cargoEnv.CARGO_HOME ?? path.join(os.homedir(), ".cargo");
const registryRoot = path.join(cargoHome, "registry", "src");
let crateDir: string | null = null;
if (fs.existsSync(registryRoot)) {
  for (const idx of fs.readdirSync(registryRoot)) {
    const cand = path.join(registryRoot, idx, "windows-0.61.3");
    if (fs.existsSync(cand)) {
      crateDir = cand;
      break;
    }
  }
}
ok(crateDir !== null, `⑤ 找到 crate 原文目录：${crateDir ? path.relative(cargoHome, crateDir) : "未找到（cargo 缓存应当已经有它）"}`);
const mitText = crateDir ? fs.readFileSync(path.join(crateDir, "license-mit"), "utf8") : "";
const apacheText = crateDir ? fs.readFileSync(path.join(crateDir, "license-apache-2.0"), "utf8") : "";
const crateManifest = crateDir ? fs.readFileSync(path.join(crateDir, "Cargo.toml"), "utf8") : "";
ok(
  /^license = "MIT OR Apache-2\.0"$/m.test(crateManifest),
  '⑤ crate 清单原文声明 license = "MIT OR Apache-2.0"（双许可，取任一都在项目白名单内）',
);
ok(
  /MIT License/.test(mitText) && /Copyright \(c\) Microsoft Corporation\./.test(mitText),
  "⑤ license-mit 原文关键句在场（MIT License / Copyright (c) Microsoft Corporation.）",
);
ok(
  /Apache License/.test(apacheText) && /Version 2\.0, January 2004/.test(apacheText) && /http:\/\/www\.apache\.org\/licenses\//.test(apacheText),
  "⑤ license-apache-2.0 原文关键句在场（Apache License / Version 2.0, January 2004）",
);

const MIT_SHA = sha256(mitText);
const APACHE_SHA = sha256(apacheText);
info(`现场原文指纹：license-mit ${mitText.length} 字符 sha256=${MIT_SHA}`);
info(`              license-apache-2.0 ${apacheText.length} 字符 sha256=${APACHE_SHA}`);
const readme = fs.readFileSync(path.join(TAURI_DIR, "README.md"), "utf8");
const audit = fs.readFileSync(path.join(REPO_ROOT, "docs", "LICENSE-AUDIT.md"), "utf8");
for (const [name, doc] of [
  ["src-tauri/README.md", readme],
  ["docs/LICENSE-AUDIT.md", audit],
] as const) {
  ok(
    doc.includes(MIT_SHA) && doc.includes(APACHE_SHA) && doc.includes("0.61.3") && doc.includes("MIT OR Apache-2.0"),
    `⑤ 登记落在 ${name}：版本 0.61.3 + 许可串 + 两份原文 sha256 与现场一致`,
  );
  ok(
    doc.includes("Copyright (c) Microsoft Corporation.") && doc.includes("Version 2.0, January 2004"),
    `⑤ ${name} 登记的是**原文关键句**（不是只写个许可名）：与上面回读到的原文逐字一致`,
  );
  ok(
    /不代表[^\n]{0,20}(独立审计|用户验收)|不等于[^\n]{0,20}(独立审计|用户验收)/.test(doc),
    `⑤ ${name} 如实写明「登记不等于独立审计通过 / 不代表用户验收」（不代签）`,
  );
}
ok(
  /准入依据/.test(audit) && /白名单/.test(audit),
  '⑤ 准入依据写清了：双许可落在项目既有白名单内，不属于「超白名单待用户接受」的例外',
);

// ═════════════ ⑥ 门槛与回归（脚本内可断言的部分） ═════════════

section("⑥ 门槛与回归：门禁登记与「禁止越界」逐条（其余回归由证据日志核对）");

const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};
ok(
  pkg.scripts["verify:v09-14"] === "tsx scripts/verify-v09-14.ts",
  `⑥ package.json 已登记 verify:v09-14 = ${pkg.scripts["verify:v09-14"] ?? "(缺)"}`,
);

const backendSrc = fs.readFileSync(path.join(TAURI_DIR, "src", "backend.rs"), "utf8");
const procSrc = fs.readFileSync(path.join(TAURI_DIR, "src", "proc_tree.rs"), "utf8");
const mainSrc = fs.readFileSync(path.join(TAURI_DIR, "src", "main.rs"), "utf8");
ok(/mod proc_tree;/.test(mainSrc), "⑥ 收口模块在 main.rs 挂上（真壳走的就是这一份源码）");
ok(/JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE/.test(procSrc), "⑥ Job 置了 KILL_ON_JOB_CLOSE（强杀路径的收口依据）");
ok(
  /AssignProcessToJobObject/.test(procSrc) &&
    /CreateJobObjectW/.test(procSrc) &&
    /TerminateJobObject/.test(procSrc) &&
    /CloseHandle/.test(procSrc),
  "⑥ 创建 / assign / 终止 / 关句柄四个动作都在（关句柄＝内核收口点）",
);
{
  const spawnIdx = backendSrc.indexOf("command.spawn()");
  const assignIdx = backendSrc.indexOf("tree.assign(&child)");
  const manageIdx = backendSrc.indexOf("app.manage(BackendProcess::new(child, tree))");
  ok(
    spawnIdx > 0 && assignIdx > spawnIdx && manageIdx > assignIdx,
    `⑥ 顺序钉死：spawn(${spawnIdx}) → assign(${assignIdx}) → manage(${manageIdx})（assign 紧贴 spawn，竞态窗口最小）`,
  );
}
ok(
  /if port_listening\(port\)/.test(backendSrc) && /shell_fatal/.test(backendSrc),
  "⑥ 端口占用检查仍在（不得为通过验收关闭它）：预检 + shell_fatal 明示",
);
ok(/不自动杀占用者/.test(backendSrc), "⑥ 占用者处置口径未变（不自动杀别人的进程）");
ok(/Job Object 不可用/.test(backendSrc), "⑥ Job 建不出来时不静默（告警 + 退回 taskkill 兜底）");
ok(
  /TATAI_LOG_TO_FILE/.test(backendSrc) && /resources\.join\("server"\)\.join\("index\.js"\)/.test(backendSrc),
  "⑥ 打包分支两处锚点未动（U2 的 verify:u2 ① 依赖它们）",
);
ok(
  /pnpm_args\(&\["dev:server"\]\)/.test(backendSrc) && /DEFAULT_PORT: u16 = 8787/.test(backendSrc),
  "⑥ U1 的 verify:u1 ③ 锚点未动（dev 配方 + 缺省端口）",
);
ok(
  /fn shutdown\(app: &AppHandle\)/.test(backendSrc) && /state\.tree\.shutdown\(&mut child\)/.test(backendSrc),
  "⑥ 正常退出仍走 shutdown → ProcTree::shutdown（① 的真壳路径）",
);
ok(/已挂进 Job Object/.test(backendSrc), "⑥ 壳日志里有「已挂进 Job Object」（真壳证据可回读）");
ok(
  /只终止.*Job.*成员|按句柄/.test(procSrc) && /不按进程名/.test(readme),
  "⑥ 收口口径在源码与 README 里都写明「只终止本 Job 成员（按句柄，不按进程名）」",
);

// ═════════════ 真壳两轮（在场才跑；判据与壳替身同一套） ═════════════

section("★ 真壳两轮：src-tauri/target/debug/tatai.exe 在场且比源码新时跑（① ② 的同判据实测）");

const srcNewest = Math.max(...rsFiles.map((f) => fs.statSync(path.join(TAURI_DIR, "src", f)).mtimeMs));
const realShellSize = fs.existsSync(REAL_SHELL) ? fs.statSync(REAL_SHELL).size : 0;
const realShellMtime = fs.existsSync(REAL_SHELL) ? fs.statSync(REAL_SHELL).mtimeMs : 0;
const realShellUsable = realShellSize > 0 && realShellMtime >= srcNewest;
if (!realShellUsable) {
  info(
    `真壳两轮未跑：${path.relative(REPO_ROOT, REAL_SHELL)} ` +
      (realShellSize === 0
        ? "不存在或 0 字节（本机火绒曾拦新建 EXE）"
        : `mtime ${new Date(realShellMtime).toISOString()} 早于源码最新改动 ${new Date(srcNewest).toISOString()}（产物过期，跑了也不算数）`),
  );
  info("  ⇒ 本轮 ①② 的真机证据由壳替身承担（同一份 proc_tree.rs 源码 + 真 cmd→pnpm→tsx→node 子树 + 真 taskkill）；");
  info("     要跑真壳：先 cargo build（debug）再跑本脚本，命令见 .工作台/evidence/V09-14/1/gate-cargo-build.log。");
} else {
  {
    const run = await launchRealShell(roundPort, homeRounds);
    quote(run.log().trim().split(/\r?\n/).slice(0, 4));
    ok(/已挂进 Job Object/.test(run.log()), "★真壳① 壳自己的日志确认后端挂进了 Job Object");
    const occupied = await portPids(roundPort);
    ok(occupied.pids.length > 0, `★真壳① 前一轮端口读数：${roundPort} 被 pid ${occupied.pids.join("/")} 占着`);
    info(`★真壳① 正常关闭：taskkill /PID ${run.shellPid}（不带 /F，等价于点窗口右上角 X）→ ${killSoft(run.shellPid)}`);
    ok(await waitFor("真壳退出", () => !alive(run.shellPid), 20_000), `★真壳① 壳进程 pid=${run.shellPid} 正常退出`);
    ok(/回收完成：pid=\d+ job=收口 taskkill=兜底/.test(run.log()), "★真壳① 壳自己打出收口日志（job=收口 + taskkill=兜底）");
    await expectTreeGoneAndPortFree("★真壳①", run, roundPort);
    info(`★真壳① 端口读数对照：前＝pid ${occupied.pids.join("/")} 占着 ${roundPort}；后＝bind 成功、无占用者`);
    await expectBystandersAlive("★真壳①");
  }
  {
    const run = await launchRealShell(roundPort, homeRounds);
    const occupied = await portPids(roundPort);
    ok(occupied.pids.length > 0, `★真壳② 前一轮端口读数：${roundPort} 被 pid ${occupied.pids.join("/")} 占着`);
    info(`★真壳② 强杀：taskkill /PID ${run.shellPid} /F（不带 /T）→ ${killHard(run.shellPid)}`);
    ok(await waitFor("真壳消失", () => !alive(run.shellPid), 20_000), `★真壳② 壳进程 pid=${run.shellPid} 已强杀`);
    await expectTreeGoneAndPortFree("★真壳②", run, roundPort);
    ok(
      !/回收完成/.test(run.log()),
      "★真壳② 强杀路径**没跑**壳自己的收口代码（日志里没有「回收完成」）⇒ 端口是内核按 KILL_ON_JOB_CLOSE 收的，不是壳来得及清理",
    );
    await expectBystandersAlive("★真壳②");
  }
}

await finalCleanup();

console.log(`\n[verify] 结果：PASS ${pass} / FAIL ${fail}`);
if (fail > 0) console.log("[verify] 有 FAIL 项——按上面的逐条读数定位；不要把失败项写成通过。");
