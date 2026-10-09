// V09-14 验证脚本（tsx 跑）：桌面壳后端进程生命周期与端口释放
// （PLAN.md V09-14；DESIGN.md §11.3 / §11.8「桌面壳退出与被强杀」一行 / §7.4 / §12.1-19 /
//   附录 E.10 第 2 行 / 附录 G-6）
//
// 用法：pnpm verify:v09-14
//   · 自带临时 TATAI_HOME 与夹具项目（v1 登记 → 用项目自己的迁移器真迁到 v2），
//     **不碰**真实注册表、真实项目、真实 `.工作台`；端口用规范里点名的 8787，
//     前置若不空闲则如实报出占用者（并把它当 ④ 的旁观者）、本轮改用备用端口。
//   · 两条腿都跑：壳替身（`src-tauri/shell-sim`，几秒可编、可脚本化）＋**真壳/最终安装包**
//     （判据同一套）。
//   · **最终安装包验收**：TATAI_V0914_REAL_SHELL=<被测 tatai.exe 绝对路径>
//     （可配 TATAI_V0914_EXPECT_RELEASE=<期望 release_id>；TATAI_V0914_REQUIRE_REAL=1 时
//     没跑成"指定包真机两轮 + release 核对"就直接 FAIL）。**指定了却缺失/身份不符一律 fail，
//     不跳过**。被测包用**自己的**隔离 TATAI_HOME ＋ 随机端口 ＋ 私有 WebView2 profile 启动，
//     不占 8787、不停正式壳；打包产物是 GUI 子系统（无 stdout），日志读 `<home>/logs/shell.log`
//     且**只取本轮启动后的字节**（否则上一轮正常退出的「回收完成」会把强杀负例判成假失败）。
//   · 缺省不带环境变量时退回**开发态真壳**（`src-tauri/target/debug/tatai.exe`，在位且比源码新
//     才跑）：那只是开发态真机证据，**不是最终安装包验收**——运行结束会如实标出完整性。
//
// 环境假设（如实写出来，别让"本机能跑"变成隐含前提）：
//   · Rust 工具链 + `windows` crate 已在 cargo 缓存里（脚本用 `cargo build --offline`；
//     干净机器先 `cargo fetch` 一次、或把 `--offline` 去掉即可）；
//   · 本机（作者机器）把 CARGO_HOME/RUSTUP_HOME/TMP/TEMP 放在 **ASCII 路径**下——mingw 的
//     ld/dlltool 读不了非 ASCII 路径（`src-tauri/README.md`「本机工具链」一节）。脚本会检测
//     非 ASCII 的 TMP/TEMP 并换成 ASCII 候选，但**不会**替你造工具链；工具链不在场时如实红。
//   · Windows + `tasklist`/`netstat`/`taskkill`（读进程与端口、按 PID 收口）＋ **Windows PowerShell
//     5.1（`powershell.exe`，随系统自带）**：归属要靠 `Get-CimInstance Win32_Process` 读父子链与
//     PID 实例创建时间（本机无 `wmic`）。PowerShell 不在场时归属断言会红，那是环境缺件、如实报，
//     不退回"全机差集"那种假绿。非 Windows 平台上①② 的进程观测断言不成立，本脚本不冒充跨平台。
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
//      掉线者会带**杀进程留痕**与基线命令行：是本脚本杀的，还是它自己退的，一眼可分。
//   ⑦ 归属（④ 的判据核心）：本壳子树**只按实际父子链**归属（记 PID 实例创建时间，终止前核验）；
//      **实例未知（读不到创建时间）或复用（PID 已给别人）一律拒杀**（未知⇒明确失败+诊断，复用⇒诊断），
//      收口**逐个 PID、绝不用 `taskkill /T`**（/T 会沿系统父子链把筛掉的陈旧 ppid 后代捎走），
//      持 `ChildProcess` 句柄的直接子进程用句柄收尾；**不做全机 node 差集**；
//      观测窗口里中途新起的无关 node 不入树、不被杀，而本壳自己的孤儿（--no-job 反例）仍抓得住。
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
// 缺省「开发态真壳」＝ cargo build（debug）的产物：**只算开发态真机证据，不是最终安装包验收**
//（debug 壳走 stdout、且产物常比源码旧——过期就如实跳过，但那只能标「非完整验收」）。
const DEV_SHELL = path.join(TAURI_DIR, "target", "debug", "tatai.exe");
// 最终安装包验收必须**显式指定**被测 exe：TATAI_V0914_REAL_SHELL=<exe 绝对路径>；
// 指定了却缺失/身份不符一律 **FAIL**（不得跳过）。TATAI_V0914_EXPECT_RELEASE 给期望 release
// （缺省取正式实例 /health 的 release 也行，但指定更硬）；TATAI_V0914_REQUIRE_REAL=1 时，
// 若本轮没跑成「指定包真机两轮」，末尾的完整性判据直接判 FAIL——不许"过期就跳过、还能全绿"。
const REAL_SHELL_ENV = "TATAI_V0914_REAL_SHELL";
const EXPECT_RELEASE_ENV = "TATAI_V0914_EXPECT_RELEASE";
const REQUIRE_REAL_ENV = "TATAI_V0914_REQUIRE_REAL";
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
// 杀进程留痕：旁观者判据报"掉线"时，能分清**是本脚本杀的**还是它自己退的——
// 否则一个自行退出的无关 node 会被读成"我们误杀"，或者反过来把真误杀掩盖成"环境抖动"。
const killedPids = new Map<number, string>();
const noteKill = (pid: number, how: string): void => {
  killedPids.set(pid, how);
};

/** 终止一个进程时给 `taskkill` 的参数。**永远只有 /PID（＋可选 /F），绝不 /T**：
 *  `/T` 会让内核沿**操作系统的父子链**重新展开一遍，把本脚本刚刚用实例创建时间筛掉的陈旧 ppid
 *  后代（甚至别的进程）一并捎走——那正好绕过了"只终止核明自有实例的 PID"这道闸。
 *  本函数单独抽出来，便于自测直接断言"真实参数里没有 /T"。 */
const killArgsFor = (inv: KillInvocation): string[] => {
  const args = ["/PID", String(inv.pid)];
  if (inv.force) args.push("/F");
  return args;
};

/** 终止动作的**唯一出口**。生产＝真 `taskkill`（单个 PID，不带 /T）；SELFTEST 换成记录器，
 *  只为统计"哪些 PID 被下了杀动作"——被调用的是本文件**同一批真实函数体**
 *  （reapVerified / killOwnedSubtree / finalCleanup / closeShellSoft），不是另抄一份。 */
interface KillInvocation {
  pid: number;
  force: boolean;
  how: string;
}
let killExecutor: (inv: KillInvocation) => string = (inv) => {
  noteKill(inv.pid, inv.how);
  return oneLine(win("taskkill", killArgsFor(inv)).out);
};
/** 正常关闭：`taskkill` 不带 /F 会给窗口发关闭请求（＝点窗口右上角 X）；
 *  强杀（带 /F，任务管理器「结束进程」的等价物）由 `reapVerified(..., force=true)` 直接调执行器。 */
const killSoft = (pid: number, how = "正常关闭"): string => killExecutor({ pid, force: false, how });

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

// ── 归属：**只看父子链**，不做全机差集 ──
// 旧实现把"两次全机 node.exe 快照的差集"当本壳子树：观测窗口里任何别处新起的 node（其他 Agent、
// 编辑器插件、并行任务）都会被算进来，②反例收尾那句 `taskkill /PID <pid> /T /F` 就把它一起杀了——
// 那是**误杀**，而且被判据当成"自己的子树"放过。归属只认**实际父子链**，并记下每个 PID 的
// **实例创建时间**：终止前复读一次，实例不符（PID 已被回收复用给别的进程）就**拒杀**。
// 禁止再按"全机新增差集"归属，禁止按进程名杀灭（收尾一律按 PID + 实例核验）。
interface ProcRow {
  ppid: number;
  /** PID 实例创建时间（.NET DateTime ticks）；同一 PID 被回收复用给新进程时会变 */
  created: number;
  name: string;
}
/** 一次读全表（PID / 父 PID / 实例创建时间 / 映像名）；观测原语本身不进任何产品判据 */
const procTable = (): Map<number, ProcRow> => {
  // 每行拼成**一个字符串**再输出：直接写 `$_.A,$_.B,…` 会被 PowerShell 当数组、逐元素一行，
  // 解析就散了（本轮实测踩过）。
  const out = win("powershell", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate,Name | ForEach-Object { "$($_.ProcessId),$($_.ParentProcessId),$($_.CreationDate.Ticks),$($_.Name)" }',
  ]).out;
  const map = new Map<number, ProcRow>();
  for (const line of out.split(/\r?\n/)) {
    const m = /^(\d+),(\d+),(\d*),(.*)$/.exec(line.trim());
    if (m) map.set(Number(m[1]), { ppid: Number(m[2]), created: m[3] === "" ? 0 : Number(m[3]), name: m[4].trim() });
  }
  return map;
};
/** 从 root 起沿父子链取全部后代（任意映像名）——**不依赖全机差集**。
 *  父进程已死也不影响：Windows 保留原始 ppid，所以强杀后仍能沿链找到它留下的孤儿。
 *  但"保留 ppid"也带来一个反方向的坑（本轮实测踩到）：**那个 pid 后来被复用**时，
 *  死去父进程留下的孤儿会被错认成新进程的孩子。所以链路要过**三道**核：
 *   ① 根实例必须**核明**：根在表里就要求能读到创建时间且与记下的实例一致；根已退出（不在表里）
 *      就要求**记下过**创建时间。根实例读不到（created=0）或对不上 ⇒ 整条链不可信，一个都不算；
 *   ② 每个后代的实例也要**核明**（created 读不到＝证明不了是我们的 ⇒ 不收，也不穿过它往下展开）；
 *   ③ 真子进程的创建时间不可能早于父进程 ⇒ "子比父老"的边是陈旧 ppid，丢弃。 */
const descendants = (root: number, table: Map<number, ProcRow>, rootCreated?: number, onUnknown?: (pid: number) => void): number[] => {
  if (root <= 0) return [];
  if (rootCreated === 0) { onUnknown?.(root); return []; }
  const rootRow = table.get(root);
  if (rootRow) {
    if (rootRow.created === 0) { onUnknown?.(root); return []; } // 不把未知链当已收干净
    if (rootCreated !== undefined && rootCreated !== 0 && rootRow.created !== rootCreated) {
      return []; // 根 PID 已被回收复用给别的进程：这条链不是我们的，不能照它杀
    }
  } else if (rootCreated === undefined || rootCreated === 0) {
    return []; // 根已退出又没记下实例 ⇒ 没有可取信的依据
  }
  const rootCreatedValue = rootRow ? rootRow.created : (rootCreated as number);
  const kids = new Map<number, number[]>();
  for (const [pid, row] of table) {
    const arr = kids.get(row.ppid);
    if (arr) arr.push(pid);
    else kids.set(row.ppid, [pid]);
  }
  const out: number[] = [];
  const seen = new Set<number>([root]);
  const queue: Array<[number, number]> = [[root, rootCreatedValue]]; // [pid, 该实例已核明的创建时间]
  while (queue.length > 0) {
    const [cur, curCreated] = queue.shift() as [number, number];
    for (const c of kids.get(cur) ?? []) {
      if (seen.has(c)) continue;
      const row = table.get(c);
      if (!row) continue;
      if (row.created === 0) { onUnknown?.(c); continue; } // 不收也不展开；清理时必须报告未知
      if (row.created < curCreated) continue; // 陈旧 ppid（子比父老）
      seen.add(c);
      out.push(c);
      queue.push([c, row.created]);
    }
  }
  return out;
};
/** 全表 PID → 命令行（诊断用：旁观者掉线时能说出"死的是谁"，不参与任何杀灭决定） */
const procCmdlines = (): Map<number, string> => {
  const out = win("powershell", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    'Get-CimInstance Win32_Process | ForEach-Object { [string]$_.ProcessId + [char]9 + [string]$_.CommandLine }',
  ]).out;
  const map = new Map<number, string>();
  for (const line of out.split(/\r?\n/)) {
    const i = line.indexOf("\t");
    if (i > 0) map.set(Number(line.slice(0, i)), line.slice(i + 1).trim());
  }
  return map;
};

/** same=还是记下的那个实例｜gone=已退出｜reused=PID 已被别的进程复用｜
 *  **unknown=读不到实例创建时间，证明不了身份（既不能说"还是我们的"，也不能杀）** */
type InstanceState = "same" | "gone" | "reused" | "unknown";
const instanceState = (pid: number, created: number | undefined, table?: Map<number, ProcRow>): InstanceState => {
  const row = (table ?? procTable()).get(pid);
  if (!row) return "gone";
  // 读不到创建时间（记下的或当下的）就没法核实例：**明确归为 unknown**，既不冒充 same（会把
  // 证明不了身份的 PID 往杀动作里放），也不当成 gone（会把还活着的进程当已退出，判据假绿）。
  if (created === undefined || created === 0 || row.created === 0) return "unknown";
  return row.created === created ? "same" : "reused";
};

/** 收尾/关闭一个进程的**唯一**入口：先核实例，**只有核明是自有实例（same）才下杀动作**。
 *  · 复用（PID 已给别人）⇒ **拒杀 + 留下诊断**：含义是"记下的那个实例确已退出"，不需要再杀，
 *    也不该因为 PID 恰好被别人拿去就报错（那会是假红）；
 *  · 未知（读不到创建时间）⇒ **拒杀 + 明确失败（ok(false)）**：既杀不了、也证明不了它已退出，
 *    绝不能静默放过——宁可留下孤儿显式报错，也不拿一个证明不了身份的 PID 去 taskkill。 */
type ReapResult = "killed" | "gone" | "refused-reused" | "refused-unknown";
interface ReapOutcome {
  result: ReapResult;
  /** 杀动作的原始输出（成功时）或拒杀说明 */
  note: string;
}
const reapVerified = (pid: number, created: number | undefined, why: string, force = true, table?: Map<number, ProcRow>): ReapOutcome => {
  const st = instanceState(pid, created, table);
  if (st === "gone") return { result: "gone", note: `pid ${pid} 已退出` };
  if (st === "reused") {
    const note = `拒杀 pid ${pid}：实例已不是记下的那个（PID 已被复用给别的进程 ⇒ 本轮那个实例确实已退出）`;
    info(`（${note} —— ${why}）`);
    return { result: "refused-reused", note };
  }
  if (st === "unknown") {
    const note = `拒杀 pid ${pid}：读不到实例创建时间，证明不了是自有进程`;
    info(`（${note} —— ${why}）`);
    ok(false, `收尾/关闭拒绝杀实例读不明的进程：pid ${pid}（${why}）`);
    return { result: "refused-unknown", note };
  }
  return { result: "killed", note: killExecutor({ pid, force, how: why }) };
};

/** 本脚本**直接 spawn** 的进程持有 `ChildProcess` 句柄：用句柄收尾它本身最稳妥——
 *  句柄就指着这一个进程，不经 `taskkill`、也不沿系统父子链展开，误伤面最小。 */
const reapHandle = (proc: ChildProcess, why: string): boolean => {
  if (!proc.pid || proc.exitCode !== null) return false;
  noteKill(proc.pid, why);
  try {
    proc.kill();
  } catch {
    /* 已经退出的竞态：按已退出处理 */
  }
  return true;
};

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

// ── 被拉起的进程一律登记在册：收尾按 PID 逐个核实例后清干净（持句柄者用句柄，绝不用 /T 捎带后代）──
const spawnedProcs = new Set<ChildProcess>();
const ownedRuns = new Set<ShellRun>();
function track(proc: ChildProcess): ChildProcess {
  spawnedProcs.add(proc);
  proc.once("exit", () => spawnedProcs.delete(proc));
  return proc;
}
/** 经 Start-Process 拉起的安装版壳不是我们的子进程：收尾按「PID + 实例创建时间」登记 */
const ownedShells = new Map<number, number>();
/** 本轮**归属过**的 pid：本壳父子链上出现过的（含壳自报后端）。旁观者掉线时用来判"能不能归因到本轮"。 */
const attributedToRun = new Set<number>();
/** 受保护的长寿命旁观者（pid → 人话说明）：正式/外部后端、受控无关 HTTP 服务、另一个 MCP 客户端。
 *  它们不归本轮所有，**掉一个就是 FAIL**——这是"桌面壳退出不许误杀别的客户端"的硬判据。 */
const protectedBystanders = new Map<number, string>();

/** 控制台壳（壳替身 / dev 壳）的 stdout+stderr 累积文本 */
const pipeLog = (proc: ChildProcess): (() => string) => {
  let text = "";
  proc.stdout?.on("data", (c: Buffer) => (text += c.toString()));
  proc.stderr?.on("data", (c: Buffer) => (text += c.toString()));
  return () => text;
};
/** 打包 GUI 无 stdout（`windows_subsystem = "windows"`）：真日志在 `<home>/logs/shell.log`
 *  （backend.rs::append_shell_log；debug 构建不落盘）。**只取本轮启动之后新增的字节**——
 *  同一 home 多轮追加同一个文件，若整篇读，②强杀轮会读到上一轮正常退出留下的「回收完成」，
 *  把"强杀路径没跑壳自己的收口代码"的正例判成假失败（反之也会掩盖真失败）。 */
const fileLogTail = (file: string): (() => string) => {
  const start = fs.existsSync(file) ? fs.statSync(file).size : 0;
  return () => {
    try {
      if (!fs.existsSync(file)) return "";
      return fs.readFileSync(file).subarray(start).toString("utf8");
    } catch {
      return "";
    }
  };
};
const mergeLog = (...parts: Array<() => string>): (() => string) => () => parts.map((p) => p()).join("");

interface ShellRun {
  proc?: ChildProcess;
  shellPid: number;
  backendPid: number;
  /** 本轮子树 = 本壳的 **node 后代**（父子链归属）＋ 壳自报的后端 pid；**不是全机差集** */
  treePids: number[];
  /** pid → 实例创建时间：终止前核验用（PID 已被复用即拒杀） */
  instances: Map<number, number>;
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

/** 按父子链把本壳的 node 后代收成子树（并记每个 pid 的实例创建时间）。
 *  拉起链是一层层出来的，连续两轮读数一致即认为树已稳定；最多观测 6s。 */
async function attributeTree(shellPid: number): Promise<{ pids: number[]; instances: Map<number, number> }> {
  const instances = new Map<number, number>();
  const pids = new Set<number>();
  if (shellPid <= 0) return { pids: [], instances };
  let prev = "";
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    const table = procTable();
    const self = table.get(shellPid);
    if (self) instances.set(shellPid, self.created);
    for (const pid of descendants(shellPid, table, self?.created)) {
      const row = table.get(pid);
      if (!row || !/^node\.exe$/i.test(row.name)) continue;
      pids.add(pid);
      if (!instances.has(pid)) instances.set(pid, row.created);
    }
    const key = [...pids].sort((a, b) => a - b).join(",");
    if (key !== "" && key === prev) break;
    prev = key;
    await sleep(700);
  }
  return { pids: [...pids].sort((a, b) => a - b), instances };
}

async function collect(
  shellPidHint: number,
  log: () => string,
  finished: Promise<number | null>,
  pidRe: RegExp | null,
  readyRe: RegExp,
  backendRe: RegExp,
  what: string,
  proc?: ChildProcess,
): Promise<ShellRun> {
  const ready = await waitFor(`${what}报出阶段行`, () => readyRe.test(log()), HEALTH_TIMEOUT_MS);
  if (!ready) info(`（${what}没有报出阶段行，见下面它的完整输出）`);
  const shellPid = Number((pidRe ? pidRe.exec(log())?.[1] : undefined) ?? shellPidHint ?? 0);
  const { pids, instances } = await attributeTree(shellPid);
  const treePids = [...pids];
  const backendPid = Number(backendRe.exec(log())?.[1] ?? 0);
  if (backendPid > 0 && !treePids.includes(backendPid)) {
    // 只补**壳自报的**后端 pid（它自己日志里的身份），且要求当场读得到实例才收；
    // 读不到＝已退出，没有要杀的。这不是"全机差集"，也不按名字补。
    const row = procTable().get(backendPid);
    if (row) {
      treePids.push(backendPid);
      instances.set(backendPid, row.created);
    }
  }
  if (treePids.length === 0) {
    info(`（观测卫生：没读到${what}的 node 后代（父子链归属，不做全机差集）；shellPid=${shellPid}）`);
  }
  attributedToRun.add(shellPid);
  for (const p of treePids) attributedToRun.add(p);
  const run = { proc, shellPid, backendPid, treePids, instances, log, finished };
  ownedRuns.add(run);
  return run;
}

/** 壳替身：按 backend.rs 的配方拉起真后端 → 挂 Job → 收尾方式由 mode 决定 */
async function launchSim(o: LaunchOpts): Promise<ShellRun> {
  const proc = track(spawn(SIM_EXE, simArgs(o.port, o.home, o), { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] }));
  const finished = new Promise<number | null>((resolve) => proc.once("exit", (code) => resolve(code)));
  return collect(proc.pid ?? 0, pipeLog(proc), finished, /\[sim\] SIM_PID=(\d+)/, /\[sim\] (HEALTH|SPAWN_FAIL)=/, /\[sim\] BACKEND_PID=(\d+)/, "壳替身", proc);
}

/** dev 真壳：与开发态起法一致（dev ⇒ cmd /C pnpm dev:server，cwd = 仓库根，端口经 TATAI_PORT） */
async function launchRealShell(exePath: string, port: number, home: string): Promise<ShellRun> {
  const proc = track(
    spawn(exePath, [], {
      cwd: REPO_ROOT,
      env: { ...process.env, TATAI_HOME: home, TATAI_PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
  const finished = new Promise<number | null>((resolve) => proc.once("exit", (code) => resolve(code)));
  // debug 壳只走 stdout（backend.rs 的 append_shell_log 在 debug 下直接 return）；release 壳反之。
  // 两条通道合并读，谁在场用谁——判据同一套。
  const log = mergeLog(pipeLog(proc), fileLogTail(path.join(home, "logs", "shell.log")));
  return collect(proc.pid ?? 0, log, finished, /\[sim\] SIM_PID=(\d+)/, /后端就绪|等后端 \/health 超过/, /\[tatai\] 后端 pid=(\d+)/, "真壳", proc);
}

/** 安装版/最终包（GUI 子系统，无 stdout）：隔离 TATAI_HOME ＋ 随机端口 ＋ 私有 WebView2 profile，
 *  窗口隐藏。**只能有自己的进程**：不占 8787、不停正式壳（本节不接触任何非本次 pid）。 */
async function launchInstalledShell(exePath: string, port: number, home: string): Promise<ShellRun> {
  const webviewDir = path.join(home, "webview2-profile");
  fs.mkdirSync(webviewDir, { recursive: true });
  // 先定下 shell.log 的起点偏移，再启动——否则可能把启动瞬间已经写下的行算进"上一轮"
  const log = fileLogTail(path.join(home, "logs", "shell.log"));
  const q = (s: string): string => s.replace(/'/g, "''");
  const launch = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$p = Start-Process -FilePath '${q(exePath)}' -WorkingDirectory '${q(path.dirname(exePath))}' -PassThru -WindowStyle Hidden; $p.Id`,
    ],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
      env: { ...process.env, TATAI_HOME: home, TATAI_PORT: String(port), WEBVIEW2_USER_DATA_FOLDER: webviewDir },
    },
  );
  const shellPid = Number((launch.stdout ?? "").trim().split(/\r?\n/).filter((l) => l.trim() !== "").pop() ?? 0);
  if (shellPid > 0) {
    const row = procTable().get(shellPid);
    if (row) ownedShells.set(shellPid, row.created);
  }
  const finished = new Promise<number | null>((resolve) => {
    const t = setInterval(() => {
      if (shellPid <= 0 || !alive(shellPid)) {
        clearInterval(t);
        resolve(null);
      }
    }, 300);
  });
  return collect(shellPid, log, finished, null, /已挂进 Job Object|后端 pid=/, /\[tatai\] 后端 pid=(\d+)/, "安装版真壳");
}

/** 本轮子树里**还在场**的 pid：实例相符（same），或实例读不明（unknown）。
 *  读不明**不能当作已退出**——否则收口判据会假绿（把一个还活着、只是核不了身份的进程当已收干净）。 */
const survivors = (run: ShellRun, table?: Map<number, ProcRow>): number[] => {
  const t = table ?? procTable();
  return run.treePids.filter((p) => {
    const st = instanceState(p, run.instances.get(p), t);
    return st === "same" || st === "unknown";
  });
};

/** 收口本次壳的整棵**自有**子树（含 WebView2 与"晚生的"孩子）。取值只走本壳的父子链
 *  （根实例核明 + 子不早于父 + 子实例核明）；再**逐个 PID** 核实例创建时间后终止。
 *  关键两点：
 *   · **绝不用 `taskkill /T`**：/T 会让内核沿操作系统父子链**重新展开**一遍，正好把上面筛掉的
 *     陈旧 ppid 后代（乃至别的进程）捎走，等于绕过"只终止核明自有实例的 PID"这道闸；
 *   · 直接 spawn 的壳替身持有 `ChildProcess` 句柄，用句柄收尾它本身（最不容易误伤）。
 *  实例未知/复用一律拒杀（`reapVerified` 会留下诊断并记 FAIL），不是全机差集，也不按名字杀。 */
const killOwnedSubtree = (run: ShellRun, tag: string, table?: Map<number, ProcRow>): void => {
  const t = table ?? procTable();
  const unknown = new Set<number>();
  const linked = descendants(run.shellPid, t, run.instances.get(run.shellPid), (pid) => unknown.add(pid));
  for (const pid of unknown) {
    info(`（${tag} 拒杀 pid ${pid}：链上实例创建时间未知，保留现场）`);
    ok(false, `${tag} 子树身份有未知节点 ${pid}，不能宣称清理完成`);
  }
  // 已捕获的实例即使父进程退出/复用也保留核验；晚生成员仅从此刻核明的链补入。
  const expected = new Map(run.instances);
  for (const pid of linked) if (!expected.has(pid)) expected.set(pid, t.get(pid)!.created);
  const all = [...new Set([run.shellPid, ...run.treePids, ...linked])].reverse();
  let killed = 0;
  const refused: string[] = [];
  for (const pid of all) {
    if (run.proc?.pid === pid) continue;
    // 真实运行每次终止前重读，不能拿第一轮进程表判断整轮之后的 PID。
    const result = reapVerified(pid, expected.get(pid), `${tag} 收口自有子树`, true, table);
    if (result.result === "killed") killed++;
    else if (result.result !== "gone") refused.push(`${pid}(${result.result})`);
  }
  if (run.proc && reapHandle(run.proc, `${tag} 收口自有子树（持有句柄）`)) killed++;
  if (refused.length > 0) info(`（${tag} 拒杀 ${refused.join("、")}）`);
  if (killed > 0) info(`（${tag} 收口本壳自有子树 ${killed} 个 pid：逐个 PID + 实例核验，不带 /T）`);
};

/** 正常关闭壳：`taskkill` 不带 /F 会给窗口发关闭请求（＝点窗口右上角 X）。本脚本把窗口隐藏起来起，
 *  关闭请求偶尔没被当场处理（本轮实测过一次），所以按**同样的方式**重发若干次；判据不变——必须真退出。
 *  关闭请求同样只发给**核明是自有实例**的 PID：PID 被复用/读不明时给窗口发关闭请求就是在动别人的进程，
 *  一律拒发并留下诊断（复用＝我们那个实例确已退出；读不明＝无法确认，不冒充成功）。 */
const closeShellSoft = async (pid: number, created: number | undefined, label: string, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  let round = 0;
  while (Date.now() < deadline) {
    const st = alive(pid) ? instanceState(pid, created) : "gone";
    if (st === "gone" || st === "reused") return true;
    if (st === "unknown") {
      info(`${label} 正常关闭：拒发关闭请求——pid ${pid} 实例读不明，证明不了是本轮的壳（可能已不是我们的进程）`);
      return false;
    }
    round++;
    const out = killSoft(pid, `${label} 正常关闭壳（第 ${round} 次）`);
    if (round === 1) info(`${label} 正常关闭：taskkill /PID ${pid}（不带 /F，等价于点窗口右上角 X）→ ${out}`);
    const tick = Math.min(5000, Math.max(0, deadline - Date.now()));
    const until = Date.now() + tick;
    while (Date.now() < until) {
      if (!alive(pid)) return true;
      await sleep(500);
    }
  }
  const st = alive(pid) ? instanceState(pid, created) : "gone";
  return st === "gone" || st === "reused";
};

/** 收口后复核：本壳父子链上**还活着**的 node 后代（用于自证"没留下孤儿"，也让漏抓无处藏） */
const chainNodesLeft = (run: ShellRun): number[] => {
  const table = procTable();
  return descendants(run.shellPid, table, run.instances.get(run.shellPid)).filter((p) => /^node\.exe$/i.test(table.get(p)?.name ?? ""));
};

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
  for (const run of ownedRuns) killOwnedSubtree(run, "收尾：已登记本轮子树");
  for (const proc of [...spawnedProcs]) {
    // 本脚本直接 spawn 的进程持有句柄：用句柄收尾它本身（只结束这一个进程，不沿系统父子链展开）
    if (proc.pid && reapHandle(proc, "收尾：本脚本直接子进程（句柄）")) {
      info(`收尾：按句柄结束本脚本直接子进程 pid=${proc.pid}`);
    }
  }
  // 安装版壳经 Start-Process 拉起，不是我们的子进程：按 PID + 实例创建时间核验后收口（**不带 /T**，
  // 只收口核明是自有实例的那个 PID；它的 WebView2 子树由 ★ 两轮的 killOwnedSubtree 按链收干净）。
  for (const [pid, created] of ownedShells) {
    const out = reapVerified(pid, created, "收尾：本轮安装版壳", true);
    if (out.result === "killed") info(`收尾：按实例核验收口本轮安装版壳 pid=${pid}（只按 PID，不带 /T）`);
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

/** 掉线归因（纯函数；运行时与下面的反例自测**共用同一份**）：
 *  - alive：还活着；
 *  - protected-dead：受保护的长寿命旁观者掉了 ⇒ FAIL；
 *  - attributed-miskill：掉线的 pid **能归因到本轮**（进过本脚本的杀进程名单，或落进本壳子树）⇒ FAIL；
 *  - unattributed：归因不上（既不在杀进程名单、也不在本壳子树）。
 *    **不等于"已证明没误杀"**：只表示"本脚本的杀进程动作与归属都解释不了它"，
 *    可能自行退出、也可能被外部结束。产品内核会不会连带误杀，另由受控旁观者与 ⑦ 的
 *    「窗口中新起无关 node」受控例承担，不靠这条采样推。 */
type DropoutVerdict = "alive" | "protected-dead" | "attributed-miskill" | "unattributed";
const classifyDropout = (o: { alive: boolean; isProtected: boolean; killRecorded: boolean; inOwnChain: boolean }): DropoutVerdict => {
  if (o.alive) return "alive";
  if (o.killRecorded || o.inOwnChain) return "attributed-miskill";
  return o.isProtected ? "protected-dead" : "unattributed";
};

// ═════════════ 反例自测：用本文件**同一份**函数（不另抄一份） ═════════════
// 归属修复（PID 复用）与旁观者判据都是"判据本身容易假绿"的地方，所以自测跑的是**真实函数本体**：
//   · descendants：喂 run4 实测的那张进程表，钉死"陈旧 ppid 造成的假子孙不入树、真后端仍入树"；
//   · classifyDropout：钉死"可归属的 PID 杀错会 fail"，以及"归因不上的瞬态退出不再被误判成误杀"。
if (process.env.TATAI_V09_14_SELFTEST === "1") {
  section("反例自测（SELFTEST=1）：真实函数本体 + run4 实测现场");
  const R = (ppid: number, created: number, name = "node.exe"): ProcRow => ({ ppid, created, name });
  const T = (entries: Array<[number, ProcRow]>): Map<number, ProcRow> => new Map(entries);

  // 场景1（run4 真实现场）：壳 50420（created=1000）下挂着一个**父 PID 被复用**的陈旧孤儿 48664
  //（真父早退出、pid 后被壳拿到，比壳还老）＋ 真后端 61464。
  {
    const table = T([
      [50420, R(1, 1000, "tatai.exe")],
      [61464, R(50420, 1100)],
      [48664, R(50420, 500)],
    ]);
    const tree = descendants(50420, table, 1000);
    console.log(`[selftest] 场景1 真函数子树=${tree.join("/")}`);
    ok(!tree.includes(48664), "场景1 真负例：陈旧 ppid 造成的假子孙 48664 **不入树**（run4 误杀的就是它）");
    ok(tree.includes(61464), "场景1 真正例：本壳真后端 61464 仍入树");
  }
  // 场景2：根 PID 已被复用（实例创建时间对不上）⇒ 整链不可信
  {
    const tree = descendants(50420, T([[50420, R(1, 9999, "someone-else.exe")], [61464, R(50420, 10050)]]), 1000);
    ok(tree.length === 0, `场景2 根 PID 已被复用 ⇒ 整链返回空（实得 ${tree.join("/") || "空"}）`);
  }
  // 场景3：壳已退出（根不在表里），仍按记下的根实例时序取真孩子、丢陈旧边
  {
    const tree = descendants(50420, T([[70001, R(50420, 900)], [70002, R(50420, 1200)]]), 1000);
    ok(!tree.includes(70001) && tree.includes(70002), `场景3 壳已退出仍取真孩子 70002、丢陈旧 70001（实得 ${tree.join("/") || "空"}）`);
  }
  // 场景3b：根实例不明（无 rootCreated）⇒ 一个都不取（宁漏不错）
  {
    const tree = descendants(50420, T([[70003, R(50420, 1200)]]));
    ok(tree.length === 0, "场景3b 根实例不明 ⇒ 一个都不取");
  }
  // 场景4（真实读数）：真起一个 node 子进程，核对 created 单调（子晚于父）且真孩子入树
  {
    const child = spawn(process.execPath, ["-e", "setTimeout(()=>{},5000)"], { stdio: "ignore" });
    await sleep(900);
    const table = procTable();
    const me = table.get(process.pid);
    const kid = table.get(child.pid ?? 0);
    ok(
      me !== undefined && kid !== undefined && kid.created >= me.created,
      `场景4 真实读数：子进程创建时间 ≥ 父进程（${kid?.created} ≥ ${me?.created}）`,
    );
    const tree = descendants(process.pid, table, me?.created);
    ok(tree.includes(child.pid ?? 0), "场景4 真实读数：真子进程仍按链收入（规则没误伤正常链路）");
    child.kill();
  }
  // 判定层：可归属的杀错 ⇒ fail；归因不上的瞬态退出 ⇒ 不 fail（但如实标 unattributed）
  {
    ok(classifyDropout({ alive: true, isProtected: true, killRecorded: false, inOwnChain: false }) === "alive", "判定：活着的旁观者 = alive");
    ok(
      classifyDropout({ alive: false, isProtected: true, killRecorded: false, inOwnChain: false }) === "protected-dead",
      "判定：受保护长寿命者掉线 = protected-dead（FAIL 方向）",
    );
    // run4 实测现场：基线里的 48664 被本脚本「★指定包①洁净」收口时 taskkill 掉 ⇒ 可归因
    ok(
      classifyDropout({ alive: false, isProtected: false, killRecorded: true, inOwnChain: false }) === "attributed-miskill",
      "判定（负例）：落进本脚本杀进程名单的基线 pid 掉线 = attributed-miskill ⇒ **会 fail**",
    );
    ok(
      classifyDropout({ alive: false, isProtected: false, killRecorded: false, inOwnChain: true }) === "attributed-miskill",
      "判定（负例）：落进本壳父子链的基线 pid 掉线 = attributed-miskill ⇒ **会 fail**",
    );
    ok(
      classifyDropout({ alive: false, isProtected: false, killRecorded: false, inOwnChain: false }) === "unattributed",
      "判定（原 bug 修正）：归因不上的瞬态退出 = unattributed ⇒ 不判误杀，但如实报出来（不静默放过）",
    );
  }
  // ── 收尾/关闭动作的核心修复：实例未知或复用**绝不进 kill 动作** ──
  // 用**注入的 kill 执行器**只统计"哪些 PID 被下了杀动作"，而被调用的是本文件**同一批真实函数体**
  // （killOwnedSubtree → reapVerified → killExecutor）——不是另抄一份假 helper。
  const killedCalls: KillInvocation[] = [];
  const realKillExecutor = killExecutor;
  const mkRun = (shellPid: number, treePids: number[], instances: Record<number, number>): ShellRun => ({
    shellPid,
    backendPid: 0,
    treePids,
    instances: new Map(Object.entries(instances).map(([k, v]) => [Number(k), v as number])),
    log: () => "",
    finished: Promise.resolve(0),
  });
  /** 跑一次**真实** killOwnedSubtree，返回它触发的 kill 调用、它**明确记下的 FAIL 数**、以及
   *  它打出的诊断行；随后把计分归位——本场景的"预期失败"不污染总账，场景本身另用 ok() 计分。 */
  const runReap = (run: ShellRun, tag: string, table: Map<number, ProcRow>): { calls: number[]; refusedFails: number; logged: string } => {
    killedCalls.length = 0;
    killExecutor = (inv) => {
      killedCalls.push(inv);
      return "SELFTEST(未真杀)";
    };
    const lines: string[] = [];
    const realLog = console.log;
    console.log = (...a: unknown[]) => {
      lines.push(a.map((x) => String(x)).join(" "));
    };
    const f0 = fail;
    let refusedFails = 0;
    try {
      killOwnedSubtree(run, tag, table);
      refusedFails = fail - f0;
    } finally {
      console.log = realLog;
      fail = f0; // 归位：本场景的"预期 FAIL"不落总账
      process.exitCode = 0;
      killExecutor = realKillExecutor;
    }
    return { calls: killedCalls.map((c) => c.pid), refusedFails, logged: lines.join("\n") };
  };

  // 场景5：**子**实例读不明（created=0）⇒ 不入树、真实收尾函数也不对它下 kill（真孩子照收）
  {
    const table = T([
      [8200, R(9000, 1200)],
      [8201, R(9000, 0)],
    ]);
    const tree = descendants(9000, table, 1000);
    ok(tree.includes(8200) && !tree.includes(8201), `场景5 子实例读不明(8201)**不入树**、真孩子(8200)仍入树（实得 ${tree.join("/") || "空"}）`);
    const r = runReap(mkRun(9000, [8200, 8201], { 9000: 1000, 8200: 1200, 8201: 0 }), "SELFTEST 场景5", table);
    ok(!r.calls.includes(8201), "场景5 真实收尾函数**没有**对实例读不明的子进程下 kill 动作");
    ok(r.calls.includes(8200), "场景5 真孩子仍逐个 PID 收口（规则没误伤正常链路）");
    ok(r.refusedFails > 0 && r.logged.includes("8201"), "场景5 未知子节点必须显式失败并留诊断，不能跳过后假绿");
  }
  // 场景6：**根**实例读不明（表里 created=0）⇒ 拒杀、一个 kill 动作都不下、**明确失败**且留诊断
  {
    const table = T([[9000, R(1, 0, "node.exe")]]);
    const r = runReap(mkRun(9000, [9000], { 9000: 1000 }), "SELFTEST 场景6", table);
    ok(r.calls.length === 0, `场景6 根实例读不明 ⇒ 真实收尾函数一个 kill 动作都没下（实得 ${r.calls.length} 次）`);
    ok(r.refusedFails >= 1, "场景6 根实例读不明 ⇒ 真实收尾函数**明确失败**（拒杀并 ok(false)）");
    ok(/拒杀/.test(r.logged) && r.logged.includes("9000"), "场景6 根实例读不明 ⇒ 留下诊断（打出「拒杀 … 9000」）");
  }
  // 场景7：**中间节点**实例读不明 ⇒ 不穿过它展开，它和它的后代都不入树、不被杀（真链仍收）
  {
    const table = T([
      [9000, R(1, 1000, "tatai.exe")],
      [8300, R(9000, 1200)],
      [8301, R(8300, 1300)],
      [8310, R(9000, 0)],
      [8311, R(8310, 1400)],
    ]);
    const tree = descendants(9000, table, 1000);
    ok(
      tree.includes(8300) && tree.includes(8301) && !tree.includes(8310) && !tree.includes(8311),
      `场景7 实例读不明的中间节点(8310)及其孩子(8311)**不入树**、真链(8300→8301)仍入树（实得 ${tree.join("/") || "空"}）`,
    );
    const r = runReap(mkRun(9000, [8300, 8301], { 9000: 1000, 8300: 1200, 8301: 1300 }), "SELFTEST 场景7", table);
    ok(!r.calls.includes(8310) && !r.calls.includes(8311), "场景7 真实收尾函数没有对 8310/8311 下 kill 动作（不沿未知中间节点把后代捎走）");
    ok(r.calls.includes(8300) && r.calls.includes(8301), "场景7 真链仍逐个 PID 收口");
    ok(r.refusedFails > 0 && r.logged.includes("8310"), "场景7 未知中间节点必须显式失败");
  }
  // 场景8：**缺根**——根已退出但记下过实例 ⇒ 仍沿链取真后代；缺根且无实例记录 ⇒ 一个都不取
  {
    const table = T([[8400, R(9000, 1200)]]);
    ok(descendants(9000, table, 1000).join(",") === "8400", "场景8 缺根（根已退出）但记下过实例 ⇒ 仍沿链取真后代 8400");
    ok(descendants(9000, table, 0).length === 0 && descendants(9000, table).length === 0, "场景8 缺根且无实例记录（0/未提供）⇒ 一个都不取（宁漏不错）");
  }
  // 场景9：PID 被**复用**（记下实例 vs 当下不符）⇒ 拒杀、不下 kill 动作、留诊断（且**不误报失败**——
  // 复用意味着"记下的那个实例确已退出"，不是清理失败；否则每次收尾都可能假红）
  {
    const table = T([[9000, R(1, 7777, "someone-else.exe")]]);
    const r = runReap(mkRun(9000, [9000], { 9000: 1000 }), "SELFTEST 场景9", table);
    ok(r.calls.length === 0, `场景9 PID 已被复用给别的实例 ⇒ 真实收尾函数一个 kill 动作都没下（实得 ${r.calls.length} 次）`);
    ok(/拒杀/.test(r.logged) && /复用/.test(r.logged), "场景9 PID 复用 ⇒ 留下诊断（打出「拒杀 … 复用」）");
    ok(r.refusedFails === 0, "场景9 PID 复用 ⇒ 不误报失败（复用＝那个实例确已退出，不是清理失败）");
  }
  // 场景10：正常链 ⇒ 逐个 PID 下 kill，且真实 kill 参数里**没有 /T**（不沿系统父子链捎走未知后代）
  {
    const table = T([
      [9200, R(9000, 1200)],
      [9201, R(9200, 1300)],
    ]);
    const r = runReap(mkRun(9000, [9200, 9201], { 9000: 1000, 9200: 1200, 9201: 1300 }), "SELFTEST 场景10", table);
    ok(r.calls.length === 2 && r.calls.includes(9200) && r.calls.includes(9201), `场景10 正常链逐个 PID 下 kill（实得 ${r.calls.join("/") || "无"}）`);
    ok(r.refusedFails === 0, "场景10 正常链没有被拒杀的成员");
    ok(!killArgsFor({ pid: 9200, force: true, how: "x" }).includes("/T"), "场景10 真实 kill 参数不含 /T（不会沿系统父子链把未知后代捎走）");
  }
  // 晚生成员可由核明的链捕获；根已复用时不得把别人的新后代认领进来。
  {
    const t = T([[9000, R(1, 1000, "tatai.exe")], [9300, R(9000, 1400, "msedgewebview2.exe")]]);
    const r = runReap(mkRun(9000, [], { 9000: 1000 }), "SELFTEST 晚生成员", t);
    ok(r.calls.includes(9300) && r.refusedFails === 0, "晚生 WebView 成员沿核明的链捕获后逐个收口");
    const reused = T([[9000, R(1, 7777, "someone-else.exe")], [9400, R(9000, 8888)]]);
    const rr = runReap(mkRun(9000, [], { 9000: 1000 }), "SELFTEST 复用根新孩子", reused);
    ok(rr.calls.length === 0, "复用根的新孩子绝不进入终止动作");
  }
  // 判定层：instanceState 对"未知"必须**明确**，不再冒充 same
  {
    ok(instanceState(1, undefined, T([[1, R(1, 555)]])) === "unknown", "判定：instanceState(未记下实例)= unknown（原 bug：返回 same）");
    ok(instanceState(1, 0, T([[1, R(1, 555)]])) === "unknown", "判定：instanceState(记下 0)= unknown（读不到就不冒充已核）");
    ok(instanceState(1, 555, T([[1, R(1, 0)]])) === "unknown", "判定：instanceState(当下读不到)= unknown");
    ok(instanceState(1, 555, T([[1, R(1, 555)]])) === "same", "判定：instanceState(实例相符)= same");
    ok(instanceState(1, 555, T([[1, R(1, 999)]])) === "reused", "判定：instanceState(实例不符)= reused");
    ok(instanceState(1, 555, T([])) === "gone", "判定：instanceState(不在场)= gone");
  }
  console.log(`\n[selftest] 结果：PASS ${pass} / FAIL ${fail}`);
  process.exit(fail > 0 ? 1 : 0);
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
const cmdlinesAtBaseline = procCmdlines(); // 掉线时用来说出"死的是谁"（只读诊断）
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

// 受保护的长寿命旁观者登记：正式/外部后端（:8787 的占用者）＋ 受控无关 HTTP 服务 ＋ 另一个 MCP 客户端。
// 判据只为这条真实功能：桌面壳退出不得带走**别人的**长寿命服务。
for (const p of portBefore) protectedBystanders.set(p, `正式/外部后端（占用 :${PORT}）`);
if (decoyHttp.pid) protectedBystanders.set(decoyHttp.pid, `受控无关 node HTTP 服务（:${DECOY_PORT}）`);
if (decoyMcp.pid) protectedBystanders.set(decoyMcp.pid, `另一个 MCP 客户端（独立 stdio 服务端）`);

/** 掉线者的人话说明（只读诊断：说出"死的是谁"、能不能归因） */
const describeDropout = (p: number, verdict: DropoutVerdict): string => {
  const cl = (cmdlinesAtBaseline.get(p) ?? "").replace(/\s+/g, " ").slice(0, 96);
  const why = killRecordedReason(p);
  return `${p}[${verdict}${why}]${cl ? `⟨${cl}⟩` : ""}`;
};
const killRecordedReason = (p: number): string => {
  const kill = killedPids.get(p);
  if (kill) return `本脚本杀过：${kill}`;
  if (attributedToRun.has(p)) return "在本壳父子链上（本轮归属过）";
  return "归因不上";
};

/** 每一轮过后都要过的旁观者对照（④ 正例方向）。
 *  判据按**意图**分两层，不把"全机任何瞬态进程自行退出"当成产品不误杀需求：
 *   ① 受保护的长寿命旁观者（正式后端 / 受控无关服务 / 另一个 MCP 客户端）：掉一个即 FAIL；
 *   ② 全机 node 采样里的其余进程：**保留采样读数**，但只有能归因到本轮的掉线才算判错杀（FAIL）；
 *      归因不上的如实列出来标「unattributed」，不冒充"没误杀"、也不静默放过。 */
async function expectBystandersAlive(tag: string): Promise<void> {
  // ① 受保护的长寿命旁观者
  const protDead: string[] = [];
  for (const [p, why] of protectedBystanders) {
    const v = classifyDropout({ alive: alive(p), isProtected: true, killRecorded: killedPids.has(p), inOwnChain: attributedToRun.has(p) });
    if (v !== "alive") protDead.push(`${describeDropout(p, v)}（${why}）`);
  }
  ok(
    protDead.length === 0,
    `${tag} 不误杀：受保护的长寿命旁观者 ${protectedBystanders.size} 个全部存活（掉线 ${protDead.join("、") || "无"}）`,
  );

  // ② 全机 node 采样（受保护者已单独判，串行重复没意义）：采样保留，按"能否归因"判
  const fleet = [...nodeBaseline].filter((p) => !protectedBystanders.has(p));
  const dropped = fleet.filter((p) => !alive(p));
  const attributed = dropped.filter((p) => classifyDropout({ alive: false, isProtected: false, killRecorded: killedPids.has(p), inOwnChain: attributedToRun.has(p) }) === "attributed-miskill");
  const unattributed = dropped.filter((p) => !attributed.includes(p));
  ok(
    attributed.length === 0,
    `${tag} 不误杀：全机 node 采样里没有「可归因到本轮」的掉线（采样 ${fleet.length} 个｜掉线 ${dropped.length}｜可归因 ${attributed.length}${
      attributed.length > 0 ? "：" + attributed.map((p) => describeDropout(p, "attributed-miskill")).join("、") : ""
    }）`,
  );
  if (unattributed.length > 0) {
    info(
      `${tag} 全机采样里 ${unattributed.length} 个掉线**归因不上**（不等于已证明没误杀，只是本脚本的杀进程动作与归属都解释不了）：` +
        unattributed.map((p) => describeDropout(p, "unattributed")).join("、"),
    );
  } else if (dropped.length > 0) {
    info(`${tag} 全机采样里 ${dropped.length} 个掉线全部可归因到本轮（已按判错杀计入上面那条断言）`);
  }

  // ③ 受控旁观者的"服务仍可用"（真活着不只 PID 在）
  const deadDecoys = decoyPids.filter((p) => !alive(p));
  ok(deadDecoys.length === 0, `${tag} 不误杀：受控旁观者 pid ${decoyPids.join("/")} 全部存活（掉线 ${deadDecoys.join("/") || "无"}）`);
  const decoy = await request(DECOY_PORT, "/").catch(() => null);
  ok(
    decoy?.status === 200 && decoy.body.includes("decoy-ok"),
    `${tag} 旁观者的无关服务仍可用：GET http://127.0.0.1:${DECOY_PORT}/ → ${decoy?.status ?? "连不上"}`,
  );
}

/** 一轮收口后的共同判据（①②③ 共用同一套，判据不放宽）。
 *  "退出"按 **PID 实例** 判：实例不再相符（已退出，或 PID 被复用给别的进程）都算本轮进程已走。 */
async function expectTreeGoneAndPortFree(tag: string, run: ShellRun, port: number): Promise<void> {
  const gone = await waitFor("本轮后端子树退出", () => survivors(run).length === 0);
  const left = survivors(run);
  ok(gone, `${tag} 后端子树全部退出：本轮 ${run.treePids.length} 个 pid（父子链归属：node 后代 + 壳自报后端 ${run.backendPid}）查不到存活（残留 ${left.join("/") || "无"}）`);
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

  const killedSim = reapVerified(run.shellPid, run.instances.get(run.shellPid), "②本轮壳强杀（模拟任务管理器结束进程，不带 /T）");
  info(`强杀（模拟任务管理器「结束进程」，不带 /T）：taskkill /PID ${run.shellPid} /F → ${killedSim.note}`);
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

  const killedNeg = reapVerified(run.shellPid, run.instances.get(run.shellPid), "②反例壳强杀");
  info(`反例强杀：taskkill /PID ${run.shellPid} /F → ${killedNeg.note}`);
  await waitFor("反例壳进程消失", () => !alive(run.shellPid), 15_000);
  await sleep(2000);
  const orphanLeft = survivors(run);
  const afterKill = await readPort(roundPort);
  const stillBound = afterKill.pids.length > 0;
  const bindable = await canBind(roundPort);
  ok(orphanLeft.length > 0, `②反例 真的留下 node 孤儿：本轮 pid ${orphanLeft.join("/")} 仍存活（这正是 V09-14 要修掉的那条路）`);
  ok(
    stillBound && !bindable,
    `②反例 孤儿仍占住端口 ${roundPort}（LISTENING 占用者 ${afterKill.pids.join("/")}，bind 失败）——反例命中 ⇒ ①② 的判据确实能抓残留`,
  );

  // 清理：只收**自己的**孤儿——取值走父子链（链路核过），杀前再核实例创建时间（PID 被复用则拒杀）；
  // 晚生的孩子（快照之后才 fork 出来的）也在这条链上，一并收干净，避免留个孤儿去污染后续轮次的归属。
  killOwnedSubtree(run, "②反例");
  await sleep(1500);
  const cleaned = await waitFor(
    "反例现场清理干净",
    async () => (await canBind(roundPort)) && survivors(run).length === 0 && chainNodesLeft(run).length === 0,
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

  const killedData = reapVerified(run.shellPid, run.instances.get(run.shellPid), "③本轮壳强杀");
  info(`③ 强杀：taskkill /PID ${run.shellPid} /F → ${killedData.note}`);
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

  reapVerified(again.shellPid, again.instances.get(again.shellPid), "③重启轮壳收尾");
  await waitFor("③ 收尾", () => !alive(again.shellPid), 15_000);
  info("③ 收尾：本轮壳已按 PID 强杀，子树由 Job 收口");
}

{
  // 自愈拉起的写服务（v0.7 daemon）按描述符 pid 收干净（不按名字）。
  // 描述符落盘后 pid 可能已被回收复用给别的进程：**核命令行确属本轮隔离 home** 才收，
  // 否则拒杀（"只清理本次自建有身份依据的进程"）。
  const descFile = path.join(homeData, "work-service.json");
  let cleanedPid: number | null = null;
  if (fs.existsSync(descFile)) {
    const desc = JSON.parse(fs.readFileSync(descFile, "utf8")) as { pid?: number };
    if (desc.pid && alive(desc.pid)) {
      const cl = procCmdlines().get(desc.pid) ?? "";
      const isOurs = cl.includes(homeData);
      ok(isOurs, `③ 收尾：描述符 pid=${desc.pid} 的命令行指向本轮隔离 home（身份依据成立，才收口）`);
      if (isOurs) {
        // 身份依据＝命令行确属本轮隔离 home（描述符 pid 可能已被复用，绝不信 pid 本身）；
        // 收口仍只按**单个 PID**（不带 /T），避免沿系统父子链把未知后代捎走。
        killExecutor({ pid: desc.pid, force: true, how: "③自愈写服务(描述符 pid，命令行核过 home，不带 /T)" });
        cleanedPid = desc.pid;
      } else {
        info(`③ 收尾：描述符 pid=${desc.pid} 的命令行**不含**本轮隔离 home（${cl.slice(0, 80) || "读不到"}）⇒ 拒杀`);
      }
    }
  }
  info(`③ 收尾：自愈写服务 ${cleanedPid === null ? "无残留在跑（描述符里的 pid 已退出 / 身份核不上）" : `按描述符 pid=${cleanedPid} 收口`}`);
  ok(true, "③ 收尾口径：一律按 PID + 身份依据（描述符 pid ∩ 命令行指本轮 home / 记录在册的实例）收，不按进程名");
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

// ═════════════ ⑦ 归属专项（④「不误杀」的判据核心） ═════════════

section("⑦ 归属专项：观测窗口里新起的无关 node 不入树、不被杀；自己的 node 后代入树；②反例孤儿仍被抓住");

{
  const intruderPort = await freePort();
  // 「并行启动的不相关 node」：由一个**先在场**的启动器在观测窗口**中途** fork 出来。
  // 旧实现（两次全机 node.exe 快照的差集）会把它算进本壳子树，②反例收尾的 taskkill /T /F 就把它杀了。
  let intruderBuf = "";
  const launcher = track(
    spawn(
      process.execPath,
      [
        "-e",
        `const {spawn}=require("child_process");setTimeout(()=>{const c=spawn(process.execPath,["-e","require('http').createServer((q,s)=>s.end('intruder-ok')).listen(${intruderPort},'127.0.0.1')"],{stdio:'ignore'});console.log('INTRUDER_PID='+c.pid);console.log('LAUNCHER_PID='+process.pid);},3000);`,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    ),
  );
  launcher.stdout?.on("data", (d: Buffer) => (intruderBuf += d.toString()));

  const run = await launchSim({ port: roundPort, home: homeRounds, mode: "exit" });
  await waitFor("无关 node 落地", () => /INTRUDER_PID=(\d+)/.test(intruderBuf), 15_000);
  const intruderPid = Number(/INTRUDER_PID=(\d+)/.exec(intruderBuf)?.[1] ?? 0);
  const launcherPid = Number(/LAUNCHER_PID=(\d+)/.exec(intruderBuf)?.[1] ?? 0);
  ok(intruderPid > 0 && alive(intruderPid), `⑦ 窗口内新起的无关 node pid=${intruderPid}（:${intruderPort}，由 pid=${launcherPid} 中途 fork）在场`);

  const chain = new Set(descendants(run.shellPid, procTable(), run.instances.get(run.shellPid)));
  ok(
    run.treePids.length > 0 && run.treePids.every((p) => chain.has(p) || p === run.backendPid),
    `⑦ 本壳自己的 node 后代**入树**：treePids=${run.treePids.join("/")}（逐个都能从 shellPid=${run.shellPid} 沿父子链走到）`,
  );
  ok(run.treePids.length >= 2, `⑦ 本壳子树仍有深度：${run.treePids.length} 个 pid（收口判据没被削弱）`);
  ok(!run.treePids.includes(intruderPid), `⑦ 无关 node pid=${intruderPid} **不在**树里（父子链归属，不再用全机差集）`);

  const code = await run.finished;
  ok(code === 0, `⑦ 本轮走正常退出（exit ${code}）`);
  await expectTreeGoneAndPortFree("⑦", run, roundPort);
  const stillAlive = alive(intruderPid);
  const probe = stillAlive ? await request(intruderPort, "/").catch(() => null) : null;
  ok(stillAlive && probe?.body.includes("intruder-ok") === true, `⑦ 收口后无关 node pid=${intruderPid} 仍存活且服务可用（未被误杀）`);

  // 反例（--no-job）：孤儿仍要被父子链抓住——"禁止全机差集"不等于漏抓残留
  const orphanRun = await launchSim({ port: roundPort, home: homeRounds, mode: "hold", noJob: true });
  const killedOrphan = reapVerified(orphanRun.shellPid, orphanRun.instances.get(orphanRun.shellPid), "⑦反例壳强杀");
  info(`⑦ 反例强杀：taskkill /PID ${orphanRun.shellPid} /F → ${killedOrphan.note}`);
  await waitFor("⑦反例壳消失", () => !alive(orphanRun.shellPid), 15_000);
  await sleep(1500);
  const stillOrphan = survivors(orphanRun);
  ok(stillOrphan.length > 0, `⑦反例 父子链仍抓住孤儿：pid ${stillOrphan.join("/")} 仍存活（不是漏抓）`);
  ok((await portPids(roundPort)).pids.length > 0, `⑦反例 孤儿仍占住端口 ${roundPort}`);
  killOwnedSubtree(orphanRun, "⑦反例");
  const cleaned = await waitFor(
    "⑦反例现场清理",
    async () => survivors(orphanRun).length === 0 && chainNodesLeft(orphanRun).length === 0 && (await canBind(roundPort)),
  );
  ok(cleaned, `⑦反例 现场按实例核验收口干净（判据与①②同一套）`);
  ok(alive(intruderPid), `⑦反例 强杀轮同样没带上无关 node pid=${intruderPid}`);
}

// ═════════════ ★ 真壳 / 最终安装包两轮 ═════════════

section(`★ 真壳两轮：指定包（${REAL_SHELL_ENV}）必须跑成并核身份；缺省开发态真壳可选、如实标「非完整验收」`);

/** PE 子系统：2=GUI（GUI 子系统无 stdout，日志只在 <home>/logs/shell.log）、3=控制台。
 *  靠文件头判，不靠文件名猜——"该读 stdout 还是读 shell.log"是判据的一部分。 */
const peSubsystem = (file: string): number | null => {
  try {
    const fd = fs.openSync(file, "r");
    const head = Buffer.alloc(0x40);
    fs.readSync(fd, head, 0, 0x40, 0);
    if (head.toString("ascii", 0, 2) !== "MZ") {
      fs.closeSync(fd);
      return null;
    }
    const peOff = head.readUInt32LE(0x3c);
    const buf = Buffer.alloc(4 + 20 + 0x60);
    fs.readSync(fd, buf, 0, buf.length, peOff);
    fs.closeSync(fd);
    if (buf.toString("ascii", 0, 4) !== "PE\0\0") return null;
    return buf.readUInt16LE(4 + 20 + 0x44); // Subsystem：PE32/PE32+ 都在可选头 +0x44
  } catch {
    return null;
  }
};

const srcNewest = Math.max(...rsFiles.map((f) => fs.statSync(path.join(TAURI_DIR, "src", f)).mtimeMs));
const specifiedExe = (process.env[REAL_SHELL_ENV] ?? "").trim();
const expectRelease = (process.env[EXPECT_RELEASE_ENV] ?? "").trim();
const requireReal = process.env[REQUIRE_REAL_ENV] === "1";
const homeReal = path.join(tmpBase, "home-real");
fs.mkdirSync(homeReal, { recursive: true });
let realShellRan = false; // 真壳两轮真跑成
let realShellFull = false; // 且身份明确（指定包 + 期望 release 核对）

async function healthOf(port: number): Promise<Record<string, unknown> | null> {
  try {
    const r = await request(port, "/health");
    if (r.status !== 200) return null;
    return JSON.parse(r.body) as Record<string, unknown>;
  } catch {
    return null;
  }
}
async function waitHealth(port: number, timeoutMs: number): Promise<Record<string, unknown> | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const h = await healthOf(port);
    if (h) return h;
    await sleep(500);
  }
  return null;
}

/** 真壳/安装包两轮（① 正常关闭、② 强杀），判据与壳替身同一套；额外核身份（data_dir/pid/release）。
 *  全程隔离：随机空闲端口 + 私有 TATAI_HOME + 私有 WebView2 profile，**不碰**正式 8787 与正式壳。 */
async function realShellRounds(exePath: string, label: string): Promise<boolean> {
  const port = await freePort();
  const subsystem = peSubsystem(exePath);
  const packaged = subsystem === 2;
  const officialBefore = await healthOf(PORT);
  info(`${label}：被测 ${exePath}（PE 子系统 ${subsystem ?? "?"}${packaged ? "＝GUI，日志读 shell.log" : "＝控制台，日志走 stdout"}）`);
  info(`${label}：隔离 TATAI_HOME=${path.relative(REPO_ROOT, homeReal)}｜随机端口 ${port}｜私有 WebView2 profile；**不碰**正式 ${PORT} 与正式壳`);
  if (officialBefore) {
    const bi = (officialBefore.build_identity ?? {}) as Record<string, unknown>;
    info(`（正式实例仍在：:${PORT}/health → pid=${officialBefore.pid} release=${String(bi.release_id ?? "").slice(0, 12)}…，本轮只读、不停）`);
  }

  let identOk = true;
  const identity = async (tag: string, run: ShellRun): Promise<void> => {
    const h = await waitHealth(port, 90_000);
    ok(h !== null, `${tag} 后端起来并应答 /health（端口 ${port}）`);
    if (!h) {
      identOk = false;
      return;
    }
    const dataDir = String(h.data_dir ?? "");
    const okDir = path.resolve(dataDir).toLowerCase() === path.resolve(homeReal).toLowerCase();
    ok(okDir, `${tag} /health data_dir 就是本轮隔离目录（${dataDir}）`);
    const bi = (h.build_identity ?? {}) as Record<string, unknown>;
    ok(bi.embedded === true, `${tag} /health build_identity.embedded=true（身份内嵌现算，不是回退值）`);
    const rel = String(bi.release_id ?? "");
    if (expectRelease !== "") {
      const same = rel === expectRelease;
      ok(same, `${tag} release 与期望一致：${rel.slice(0, 12)}… == ${expectRelease.slice(0, 12)}…`);
      if (!same) identOk = false;
    } else {
      info(`${tag} release = ${rel.slice(0, 12)}…（未设 ${EXPECT_RELEASE_ENV}，只如实记读数；本次不算"指定包身份核验"）`);
      identOk = false;
    }
    const pid = Number(h.pid ?? 0);
    const inTree = new Set(descendants(run.shellPid, procTable(), run.instances.get(run.shellPid))).has(pid);
    ok(inTree, `${tag} /health pid=${pid} 确是本壳 pid=${run.shellPid} 的**后代**（父子链归属，不是全机差集）`);
    if (!okDir || !inTree) identOk = false;
  };

  // ① 正常关闭
  {
    const run = packaged ? await launchInstalledShell(exePath, port, homeReal) : await launchRealShell(exePath, port, homeReal);
    quote(run.log().trim().split(/\r?\n/).slice(0, 4));
    ok(run.shellPid > 0, `${label}① 壳进程起来了（pid=${run.shellPid}）`);
    await identity(`${label}①`, run);
    const occupied = await portPids(port);
    ok(occupied.pids.length > 0, `${label}① 前一轮端口读数：${port} 被 pid ${occupied.pids.join("/")} 占着`);
    const closed = await closeShellSoft(run.shellPid, run.instances.get(run.shellPid), `${label}①`, 45_000);
    ok(closed, `${label}① 壳进程 pid=${run.shellPid} 正常退出（taskkill 不带 /F ＝点窗口右上角 X；窗口是隐藏起的，一次没关掉就按同样的方式再关一次，判据仍是"必须真退出"）`);
    ok(/回收完成/.test(run.log()), `${label}① 壳自己打出收口日志（本轮日志里有「回收完成：… job=收口 taskkill=兜底」）`);
    await expectTreeGoneAndPortFree(`${label}①`, run, port);
    info(`${label}① 端口读数对照：前＝pid ${occupied.pids.join("/")} 占着 ${port}；后＝bind 成功、无占用者`);
    await expectBystandersAlive(`${label}①`);
    killOwnedSubtree(run, `${label}①洁净`);
  }

  // ② 强制结束
  {
    const run = packaged ? await launchInstalledShell(exePath, port, homeReal) : await launchRealShell(exePath, port, homeReal);
    ok(run.shellPid > 0, `${label}② 壳进程起来了（pid=${run.shellPid}）`);
    await identity(`${label}②`, run);
    const occupied = await portPids(port);
    ok(occupied.pids.length > 0, `${label}② 前一轮端口读数：${port} 被 pid ${occupied.pids.join("/")} 占着`);
    const killedPkg = reapVerified(run.shellPid, run.instances.get(run.shellPid), `${label}② 强杀壳`);
    info(`${label}② 强杀：taskkill /PID ${run.shellPid} /F（不带 /T）→ ${killedPkg.note}`);
    ok(await waitFor(`${label}② 壳消失`, () => !alive(run.shellPid), 30_000), `${label}② 壳进程 pid=${run.shellPid} 已强杀`);
    await expectTreeGoneAndPortFree(`${label}②`, run, port);
    ok(
      !/回收完成/.test(run.log()),
      `${label}② 强杀路径**没跑**壳自己的收口代码（本轮日志里没有「回收完成」）⇒ 端口是内核按 KILL_ON_JOB_CLOSE 收的，不是壳来得及清理`,
    );
    await expectBystandersAlive(`${label}②`);
    killOwnedSubtree(run, `${label}②洁净`);
  }

  const after = await healthOf(PORT);
  ok(
    officialBefore === null ? true : after?.pid === officialBefore.pid,
    `${label} 全程没动正式实例：:${PORT}/health pid ${String(officialBefore?.pid ?? "（起先就没跑）")} → ${String(after?.pid ?? "（现在取不到）")}`,
  );
  return identOk;
}

if (specifiedExe !== "") {
  // 指定了就必须在：缺失即 FAIL，**不跳过**（这正是旧实现"过期只 info 跳过、还能全绿"的漏洞）
  const exePath = path.resolve(specifiedExe);
  const exists = fs.existsSync(exePath);
  const size = exists ? fs.statSync(exePath).size : 0;
  ok(exists && size > 0, `★ 指定包在位：${exePath}（${size} B）——设了 ${REAL_SHELL_ENV} 就必须在，缺失即 FAIL、不跳过`);
  if (exists && size > 0) {
    realShellFull = await realShellRounds(exePath, "★指定包");
    realShellRan = true;
  }
} else {
  const devSize = fs.existsSync(DEV_SHELL) ? fs.statSync(DEV_SHELL).size : 0;
  const devMtime = fs.existsSync(DEV_SHELL) ? fs.statSync(DEV_SHELL).mtimeMs : 0;
  const devUsable = devSize > 0 && devMtime >= srcNewest;
  if (devUsable) {
    info(`（缺省开发态真壳：${path.relative(REPO_ROOT, DEV_SHELL)}，mtime 新于源码——跑它只算**开发态**真机证据）`);
    await realShellRounds(DEV_SHELL, "★dev真壳");
    realShellRan = true;
  } else {
    info(
      `真壳两轮未跑：${path.relative(REPO_ROOT, DEV_SHELL)} ` +
        (devSize === 0
          ? "不存在或 0 字节（本机火绒曾拦新建 EXE）"
          : `mtime ${new Date(devMtime).toISOString()} 早于源码最新改动 ${new Date(srcNewest).toISOString()}（产物过期，跑了也不算数）`),
    );
    info("  ⇒ 本轮 ①② 的真机证据由壳替身承担（同一份 proc_tree.rs 源码 + 真 cmd→pnpm→tsx→node 子树 + 真 taskkill）；");
    info("     这**不是最终安装包验收**：要跑最终包，设 " + REAL_SHELL_ENV + "=<安装版 tatai.exe 路径>（可配 " + EXPECT_RELEASE_ENV + "）。");
  }
}

ok(
  !requireReal || realShellFull,
  `★ 真机验收完整性：${realShellFull ? "完整（指定包真机两轮 + release 身份核对通过）" : realShellRan ? "部分（跑了真壳，但身份未核——缺期望 release）" : "非完整（未跑指定包，只有开发态/壳替身证据）"}` +
    (requireReal ? `（设了 ${REQUIRE_REAL_ENV}=1，非完整即 FAIL）` : ""),
);

await finalCleanup();

console.log(`\n[verify] 结果：PASS ${pass} / FAIL ${fail}`);
if (fail > 0) console.log("[verify] 有 FAIL 项——按上面的逐条读数定位；不要把失败项写成通过。");
