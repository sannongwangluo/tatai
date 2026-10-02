// V09-29 唯一写宿主恢复保护 · 专项验证（PLAN V09-29；契约 `docs/forward-progress-contract.md` F3 尾段；
// DESIGN.md §2.6/§11.3；现场依据 `.工作台/evidence/progress-loop-20261002/runtime-observation.md`）。
//
// 现场（真安装版）：`/health` 读 15s 超时、同一个 `C:/Users/<user>/.tatai` 同时存在多个 daemon/write-service
// 进程；旧实现"探活超时即当死宿主"会在慢但存活的宿主旁再拉起第二个写者。本脚本用**真子进程 + 动态端口 +
// 隔离 home** 构造反例，钉住五条边界（先红后绿）：
//   ① 探活超时但描述符 pid 仍活 → daemon **不另起写者**（描述符不被覆盖）；
//   ② 冷启动并发双拉起 → 有界跨进程锁 + 存活核实，**只有一个发布者**；
//   ③ 旧宿主失去描述符 → 停发现并退出，**退出不删新宿主的描述符**；
//   ④ 描述符所指 pid **真死**（ESRCH）→ 才允许清陈旧描述符后自愈发布；
//   ⑤ 桌面后端（真 `index.ts`）接管：对端 pid 仍活但不可达 → **不发布**、报原因（不覆盖仍活不可达宿主）。
// 边界补修（ownership-review-remaining.md 第 1–4 条，真 child + HTTP 反例）：
//   ⑥ 接管失败宿主：本地直挂写路由（人工验收）与带旧令牌的 work 写命令都被 503 拒绝、**账本零增**——
//      只"不发布"不够，失败宿主仍会经本地直写函数当第二写者；
//   ⑦ 描述符易主后旧端点写请求被拒（账本零增）、新 owner 描述符保留、旧宿主退出也不删它（锁内比对后删除）；
//   ⑧ 撤描述符=锁内比对后删除：自持才删，易主/坏描述符保守不删；
//   ⑨ 描述符「在场但坏/读不了」= 所有权**未知**（不是"无人拥有"）：发布仲裁保守拒绝、不覆写，真 daemon 退位。
//
// 另加进程内单元：`publishUnderOwnershipLock` 三种现场（活外来宿主→拒；真死→清陈旧后发布；无描述符→发布）。
// 隔离口径（AGENTS.md §5）：mkdtemp 夹具 + 隔离 TATAI_HOME + localhost 动态端口 + 真子进程；
// 有界等待；finally 清子进程与临时目录；不碰真实 ~/.tatai / 真实项目与账本 / 8787 / 不接网关 / 不调模型。
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  descriptorBelongsTo,
  publishUnderOwnershipLock,
  readDescriptorState,
  readOwnership,
  removeDescriptorIfOwned,
  removeDescriptorIfDead,
} from "../src/server/work/serviceOwnership";
import { WorkServiceClient, WORK_TOKEN_HEADER } from "../src/server/work/service";

let passCount = 0;
let failCount = 0;
const ok = (cond: boolean, label: string, detail?: unknown): void => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (cond) passCount += 1;
  else {
    failCount += 1;
    process.exitCode = 1;
    if (detail !== undefined) console.log(`[verify]   现场：${JSON.stringify(detail).slice(0, 1600)}`);
  }
};
const info = (m: string): void => console.log(`[verify] ${m}`);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const mkdirp = (d: string): void => { fs.mkdirSync(d, { recursive: true }); };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DAEMON_ENTRY = path.join(ROOT, "src", "server", "work", "daemon.ts");
const DESKTOP_ENTRY = path.join(ROOT, "src", "server", "index.ts");
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-host-own-"));

interface Desc { schema_version: number; pid: number; host: string; port: number; token: string; started_at: string; url: string }
const descPath = (home: string): string => path.join(home, "work-service.json");
const writeDescRaw = (home: string, d: Desc): void => { mkdirp(home); fs.writeFileSync(descPath(home), `${JSON.stringify(d, null, 2)}\n`, "utf8"); };
const readDescRaw = (home: string): Desc | null => { try { return JSON.parse(fs.readFileSync(descPath(home), "utf8")) as Desc; } catch { return null; } };

function cleanEnv(home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("TATAI_")) delete env[k];
  env.TATAI_HOME = home;
  env.TATAI_NO_AUTOSTART = "1";
  env.TATAI_SYNC_DISCOVERY = "0";
  env.TATAI_SEMANTIC_AUTO = "0";
  return { ...env, ...extra };
}

interface Proc { child: ChildProcess; log: () => string; exited: () => number | null }
function spawnNode(args: string[], home: string, extra: Record<string, string> = {}): Proc {
  const child = spawn(process.execPath, args, { cwd: ROOT, env: cleanEnv(home, extra), windowsHide: true });
  let buf = "";
  child.stdout?.on("data", (d: Buffer) => (buf += d.toString("utf8")));
  child.stderr?.on("data", (d: Buffer) => (buf += d.toString("utf8")));
  return { child, log: () => buf, exited: () => child.exitCode };
}
const spawnDaemon = (home: string): Proc => spawnNode(["--import", "tsx", DAEMON_ENTRY], home);
const spawnDesktop = (home: string, port = 0): Proc =>
  spawnNode(["--import", "tsx", DESKTOP_ENTRY], home, { TATAI_PORT: String(port) });

/** 取一个当前空闲的 TCP 端口（供真桌面后端绑定；桌面接管失败时不发布描述符，拿不到实际端口，只能预先给一个）。 */
async function freePort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const addr = srv.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

interface HttpResult { status: number; json: unknown }
/** POST JSON（8s 有界）；网络层失败返回 status 0，不抛。 */
async function httpPostJson(url: string, body: unknown, headers: Record<string, string> = {}): Promise<HttpResult> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    const json = (await res.json().catch(() => null)) as unknown;
    return { status: res.status, json };
  } catch (e) {
    return { status: 0, json: { error: e instanceof Error ? e.message : String(e) } };
  }
}

/** 写一份最小注册表（只有一个项目 → 指向隔离项目目录），让"若允许则真会写账本"的探针成立。 */
const writeRegistry = (home: string, id: string, dir: string): void => {
  mkdirp(home);
  fs.writeFileSync(
    path.join(home, "registry.json"),
    JSON.stringify(
      {
        version: 1,
        projects: [
          {
            id,
            name: id,
            path: dir,
            kind: "backend",
            registered_at: "2026-10-02T00:00:00+08:00",
            last_opened_at: "2026-10-02T00:00:00+08:00",
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );
};
const eventsFileOf = (projDir: string): string => path.join(projDir, ".工作台", "work", "events.jsonl");
const ledgerLines = (projDir: string): number => {
  const f = eventsFileOf(projDir);
  if (!fs.existsSync(f)) return 0;
  return fs.readFileSync(f, "utf8").split(/\r?\n/).filter((l) => l.trim() !== "").length;
};
/** 递归数一个目录下的文件数（证据正文/基线副本/事件账本"零增"用它比对，不看内容只看有没有多出东西）。 */
const countFiles = (dir: string): number => {
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) n += countFiles(p);
    else n += 1;
  }
  return n;
};
const parseHttpStatus = (raw: string): number => {
  const m = /^HTTP\/1\.[01] (\d{3})/.exec(raw);
  return m === null ? 0 : Number(m[1]);
};
interface SlowBodyResult { status: number; raw: string }
/**
 * 真 HTTP 慢 body 写请求：先发请求行+头+前半 body，调用 `midway()`（换描述符，模拟"body 到达前宿主易主"），
 * 再补后半 body，读回状态。用裸 socket 控制分片时机——`fetch` 会一次发完，造不出"慢 body"反例。
 */
function slowBodyPost(port: number, pathname: string, token: string, bodyStr: string, midway: () => void): Promise<SlowBodyResult> {
  return new Promise((resolve) => {
    const payload = Buffer.from(bodyStr, "utf8");
    const socket = net.connect(port, "127.0.0.1");
    let raw = "";
    let done = false;
    const finish = (status: number): void => {
      if (done) return;
      done = true;
      try { socket.destroy(); } catch { /* ignore */ }
      resolve({ status, raw });
    };
    socket.on("connect", () => {
      const head =
        `POST ${pathname} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n` +
        `content-type: application/json\r\n${WORK_TOKEN_HEADER}: ${token}\r\n` +
        `content-length: ${payload.length}\r\nconnection: close\r\n\r\n`;
      socket.write(head);
      const half = Math.max(1, Math.floor(payload.length / 2));
      socket.write(payload.subarray(0, half));
      setTimeout(() => {
        midway();
        socket.write(payload.subarray(half));
      }, 350);
    });
    socket.on("data", (d: Buffer) => { raw += d.toString("utf8"); });
    socket.on("end", () => finish(parseHttpStatus(raw)));
    socket.on("close", () => finish(parseHttpStatus(raw)));
    socket.on("error", () => finish(0));
    socket.setTimeout(15_000, () => finish(0));
  });
}
/** 一条会真写账本的合法命令（task.created；项目已登记时提交即落一行）。 */
const taskCreated = (projectId: string, entityId: string, key: string): Record<string, unknown> => ({
  schema_version: 2,
  project_id: projectId,
  change_id: "chg-boundary",
  entity_id: entityId,
  expected_revision: null,
  type: "task.created",
  actor_id: "verify",
  role: "executor",
  idempotency_key: key,
  payload: { title: "boundary" },
});
/** 有界停一个子进程（先温和 kill，等它退，超时再 SIGKILL）。 */
async function stopProc(p: Proc): Promise<void> {
  try { if (p.child.exitCode === null) p.child.kill(); } catch { /* ignore */ }
  await waitFor(() => (p.exited() === null ? null : true), 8000);
  try { if (p.child.exitCode === null) p.child.kill("SIGKILL"); } catch { /* ignore */ }
}

/** 起一个「活但不可达」的真 HTTP 宿主：绑定端口、接受连接但**从不应答**（探活必超时；pid 真活）。 */
async function startSlowHost(home: string): Promise<{ proc: Proc; port: number }> {
  const src = "const h=require('http').createServer(()=>{});h.listen(0,'127.0.0.1',()=>{console.log('PORT='+h.address().port)});setInterval(()=>{},1e9);";
  const proc = spawnNode(["-e", src], home);
  const deadline = Date.now() + 10_000;
  for (;;) {
    const m = /PORT=(\d+)/.exec(proc.log());
    if (m !== null) return { proc, port: Number(m[1]) };
    if (Date.now() > deadline) throw new Error(`慢宿主未报端口：${proc.log().slice(-200)}`);
    await sleep(100);
  }
}
async function deadPid(): Promise<number> {
  const p = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore", windowsHide: true });
  const pid = p.pid ?? -1;
  await new Promise<void>((r) => p.on("exit", () => r()));
  await sleep(150);
  return pid;
}
async function waitFor<T>(fn: () => T | null | false, timeoutMs: number, stepMs = 150): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v !== null && v !== false) return v;
    if (Date.now() > deadline) return null;
    await sleep(stepMs);
  }
}
async function handoff(home: string, proc: Proc): Promise<void> {
  const dd = readDescRaw(home);
  if (dd === null) return;
  await fetch(`http://${dd.host}:${dd.port}/api/work/admin/shutdown`, {
    method: "POST",
    headers: { "x-tatai-work-token": dd.token },
    signal: AbortSignal.timeout(3000),
  }).catch(() => null);
  await waitFor(() => (proc.exited() === null ? null : true), 8000);
}

const procs: Proc[] = [];
const track = (p: Proc): Proc => { procs.push(p); return p; };

async function main(): Promise<void> {
  info(`V09-29 唯一写宿主恢复保护 · 专项（${process.platform} · node ${process.version}）`);
  info(`  夹具根 ${tmpBase}`);

  // ═══ S0 单元：publishUnderOwnershipLock 三种现场 ═══
  info("── S0 发布仲裁单元（活外来宿主→拒 / 真死→清陈旧后发布 / 无描述符→发布）");
  {
    const home = path.join(tmpBase, "unit-home");
    mkdirp(home);
    const slow = await startSlowHost(home);
    track(slow.proc);
    const foreign: Desc = { schema_version: 2, pid: slow.proc.child.pid ?? -1, host: "127.0.0.1", port: slow.port, token: "foreign-token", started_at: new Date().toISOString(), url: `http://127.0.0.1:${slow.port}` };
    writeDescRaw(home, foreign);
    let called = 0;
    const r1 = publishUnderOwnershipLock(home, () => { called += 1; });
    ok(r1.published === false && r1.reason === "owned_by_live_process" && called === 0, "S0-1 描述符属别的活进程 → 拒发布（不覆盖、publish 回调不被调）", r1);
    ok((readDescRaw(home)?.pid ?? -1) === foreign.pid, "S0-2 拒发布后既有描述符原样保留");

    const dead = await deadPid();
    writeDescRaw(home, { ...foreign, pid: dead, token: "stale-token" });
    const r2 = publishUnderOwnershipLock(home, () => { writeDescRaw(home, { ...foreign, pid: process.pid, token: "mine" }); });
    ok(r2.published === true && (readDescRaw(home)?.pid ?? -1) === process.pid, "S0-3 描述符 pid 真死 → 清陈旧后发布（自愈）", r2);

    fs.rmSync(descPath(home), { force: true });
    const r3 = publishUnderOwnershipLock(home, () => { writeDescRaw(home, { ...foreign, pid: process.pid, token: "mine" }); });
    ok(r3.published === true, "S0-4 无描述符 → 直接发布", r3);
    ok(!removeDescriptorIfDead(home) && readDescRaw(home)?.token === "mine",
      "S0-5 自愈清理重读现状：新活宿主已接管时保留描述符");
    writeDescRaw(home, { ...foreign, pid: dead, token: "dead-again" });
    ok(removeDescriptorIfDead(home) && readDescRaw(home) === null,
      "S0-6 自愈清理在发布锁内确认 PID 真死后才删除");
  }

  // ═══ S1 探活超时但 pid 仍活 → daemon 不另起写者 ═══
  info("── S1 慢/不可达但 pid 活的宿主：daemon 不繁殖第二个写者");
  {
    const home = path.join(tmpBase, "slow-home");
    mkdirp(home);
    const slow = await startSlowHost(home);
    track(slow.proc);
    const foreign: Desc = { schema_version: 2, pid: slow.proc.child.pid ?? -1, host: "127.0.0.1", port: slow.port, token: "slow-token", started_at: new Date().toISOString(), url: `http://127.0.0.1:${slow.port}` };
    writeDescRaw(home, foreign);
    const daemon = track(spawnDaemon(home));
    const gone = await waitFor(() => (daemon.exited() === null ? null : daemon.exited()), 12_000);
    ok(gone === 0, "S1-1 探活超时但描述符 pid 仍活 → daemon 退位 exit=0（不抢写者身份）", { code: gone, log: daemon.log().slice(-400) });
    ok((readDescRaw(home)?.pid ?? -1) === foreign.pid, "S1-2 描述符仍是慢宿主的（daemon 未覆盖发布）", { pid: readDescRaw(home)?.pid, foreign: foreign.pid });
    ok(/探活|不可达|所有权/.test(daemon.log()), "S1-3 daemon 如实报「不可达/所有权待核实」原因（不静默）", { log: daemon.log().slice(-300) });
  }

  // ═══ S2 冷启动并发双拉起 → 只有一个发布者 ═══
  info("── S2 冷启动并发双拉起：有界跨进程锁 + 存活核实只允许一个发布者");
  {
    const home = path.join(tmpBase, "race-home");
    mkdirp(home);
    const a = track(spawnDaemon(home));
    const b = track(spawnDaemon(home));
    const d = await waitFor(() => { const x = readDescRaw(home); return x === null ? null : x; }, 25_000);
    ok(d !== null && (d.pid === a.child.pid || d.pid === b.child.pid), "S2-1 恰发布一个描述符，且属于两个 daemon 之一", { desc_pid: d?.pid, a: a.child.pid, b: b.child.pid });
    // 有界等待：输家应退位（另一个仍活）
    const settled = await waitFor(() => {
      const ea = a.exited();
      const eb = b.exited();
      if (ea !== null && eb !== null) return null; // 两个都退 = 异常
      return ea !== null || eb !== null ? { ea, eb } : null;
    }, 12_000);
    ok(settled !== null, "S2-2 并发双拉起后恰一个 daemon 存活（另一个让位退出）", { settled, a: a.exited(), b: b.exited(), logA: a.log().slice(-200), logB: b.log().slice(-200) });
    const winner = a.exited() === null ? a : b;
    const loser = a.exited() === null ? b : a;
    ok(winner.exited() === null && loser.exited() === 0, "S2-3 赢家仍在跑、输家 exit=0（不双写）", { winner: winner.exited(), loser: loser.exited(), loseLog: loser.log().slice(-300) });
    ok((readDescRaw(home)?.pid ?? -1) === winner.child.pid, "S2-4 描述符属于赢家（未被输家覆盖）", { desc: readDescRaw(home)?.pid, winner: winner.child.pid });
    await handoff(home, winner);
  }

  // ═══ S3 旧宿主失去描述符 → 停发现并退出，且不删新宿主描述符 ═══
  info("── S3 旧宿主失去描述符：停发现退出，不删新宿主的描述符");
  {
    const home = path.join(tmpBase, "lost-home");
    mkdirp(home);
    const oldHost = track(spawnDaemon(home));
    const d = await waitFor(() => { const x = readDescRaw(home); return x === null ? null : x; }, 25_000);
    ok(d !== null && d.pid === oldHost.child.pid, "S3-0 旧宿主发布描述符（本进程 pid）", { desc: d?.pid, child: oldHost.child.pid });
    // 另一个「新宿主」接管描述符（pid 用测试进程冒充一个活进程；token 不同）
    const newDesc: Desc = { schema_version: 2, pid: process.pid, host: "127.0.0.1", port: 9, token: "new-owner-token", started_at: new Date().toISOString(), url: "http://127.0.0.1:9" };
    writeDescRaw(home, newDesc);
    const gone = await waitFor(() => (oldHost.exited() === null ? null : oldHost.exited()), 12_000);
    ok(gone === 0, "S3-1 旧宿主察觉描述符易主 → 停发现并退出 exit=0", { code: gone, log: oldHost.log().slice(-400) });
    const after = readDescRaw(home);
    ok(after !== null && after.pid === newDesc.pid && after.token === newDesc.token, "S3-2 退出不删新宿主描述符（描述符原样保留）", { after });
    ok(/易主|lost-ownership|失去/.test(oldHost.log()), "S3-3 旧宿主日志如实报「失去所有权」（不静默）", { log: oldHost.log().slice(-300) });
  }

  // ═══ S4 描述符 pid 真死 → 允许自愈发布 ═══
  info("── S4 真 PID 死（ESRCH）→ 清陈旧描述符后自愈发布");
  {
    const home = path.join(tmpBase, "dead-home");
    mkdirp(home);
    const dead = await deadPid();
    writeDescRaw(home, { schema_version: 2, pid: dead, host: "127.0.0.1", port: 1, token: "dead-token", started_at: new Date().toISOString(), url: "http://127.0.0.1:1" });
    const daemon = track(spawnDaemon(home));
    const d = await waitFor(() => { const x = readDescRaw(home); return x === null || x.pid === daemon.child.pid ? x : null; }, 20_000);
    ok(d !== null && d.pid === daemon.child.pid, "S4-1 陈旧描述符（pid 已死）→ daemon 自愈发布为唯一写者", { desc: d?.pid, child: daemon.child.pid, log: daemon.log().slice(-300) });
    ok(daemon.exited() === null, "S4-2 自愈后的 daemon 仍在跑（成为写者）", { code: daemon.exited() });
    await handoff(home, daemon);
  }

  // ═══ S5 桌面接管：对端 pid 仍活但不可达 → 不发布、报原因 ═══
  info("── S5 桌面后端（真 index.ts）接管：不覆盖仍活不可达的宿主");
  {
    const home = path.join(tmpBase, "desktop-home");
    mkdirp(home);
    const slow = await startSlowHost(home);
    track(slow.proc);
    const foreign: Desc = { schema_version: 2, pid: slow.proc.child.pid ?? -1, host: "127.0.0.1", port: slow.port, token: "slow-token", started_at: new Date().toISOString(), url: `http://127.0.0.1:${slow.port}` };
    writeDescRaw(home, foreign);
    const desktop = track(spawnDesktop(home));
    // 桌面接管有界重试（3×4s）后才判；等它把「不发布」记进日志
    const reported = await waitFor(() => (/不发布写入服务描述符|接管未确认/.test(desktop.log()) ? true : null), 30_000);
    ok(reported !== null, "S5-1 桌面后端对仍活不可达宿主不发布并如实报原因", { log: desktop.log().slice(-500) });
    const after = readDescRaw(home);
    ok(after !== null && after.pid === foreign.pid && after.token === foreign.token, "S5-2 描述符仍是原宿主的（桌面未覆盖发布）", { after });
    ok(desktop.exited() === null, "S5-3 桌面后端仍照常运行（只是不发布写入服务）", { code: desktop.exited() });
  }

  // ═══ S6 接管失败宿主：本地直写被拒、账本零增（不是第二写者） ═══
  info("── S6 桌面接管失败（另一活宿主不让位）：本地直写被拒、账本零增");
  {
    const home = path.join(tmpBase, "blocked-desktop-home");
    const proj = path.join(tmpBase, "blocked-desktop-proj");
    mkdirp(home);
    mkdirp(proj);
    writeRegistry(home, "blocked-proj", proj);
    const slow = await startSlowHost(home);
    track(slow.proc);
    const foreign: Desc = {
      schema_version: 2,
      pid: slow.proc.child.pid ?? -1,
      host: "127.0.0.1",
      port: slow.port,
      token: "slow-token",
      started_at: new Date().toISOString(),
      url: `http://127.0.0.1:${slow.port}`,
    };
    writeDescRaw(home, foreign);
    const port = await freePort();
    const desktop = track(spawnDesktop(home, port));
    const ready = await waitFor(() => (/接管未确认|不发布写入服务描述符/.test(desktop.log()) ? true : null), 40_000);
    ok(ready !== null, "S6-0 桌面后端进入接管未确认（不发布、不当写者）", { log: desktop.log().slice(-400) });

    // ① 本地**直挂**写路由（人工验收，无需 work 令牌）→ 必须 503，账本零增。
    //    RED（修前）：这条路由不经 workHost 委派、也从不校验所有权，会直接调 WorkService 写第二份事件。
    const acc = await httpPostJson(`http://127.0.0.1:${port}/api/projects/blocked-proj/acceptance`, {
      decision: "accept",
      accepted_by: "user",
      task_id: "t1",
    });
    ok(acc.status === 503, "S6-1 接管失败宿主：本地 POST 验收被 503 拒绝（不当第二写者）", acc);
    ok(ledgerLines(proj) === 0, "S6-2 账本零增（接管失败宿主没写第二份事件）", { lines: ledgerLines(proj) });

    // ② work 面写命令（带原宿主的旧令牌）→ 也必须 503（所有权闸先于令牌闸）。
    const cmd = await httpPostJson(
      `http://127.0.0.1:${port}/api/work/command`,
      taskCreated("blocked-proj", "task-b1", "k-b1"),
      { "x-tatai-work-token": foreign.token },
    );
    ok(cmd.status === 503, "S6-3 work 面写命令（带旧令牌）同样被 503 拒绝", cmd);
    ok(ledgerLines(proj) === 0, "S6-4 work 面拒绝后账本仍零增", { lines: ledgerLines(proj) });

    const after = readDescRaw(home);
    ok(after !== null && after.pid === foreign.pid && after.token === foreign.token, "S6-5 描述符仍是原活宿主的（桌面未覆盖）", { after });
    await stopProc(desktop);
  }

  // ═══ S7 描述符易主：旧端点写被拒（账本零增）、新 owner 描述符保留 ═══
  info("── S7 描述符易主：旧端点写请求被拒、新 owner 描述符保留（退出也不删）");
  {
    const home = path.join(tmpBase, "swapped-desktop-home");
    const proj = path.join(tmpBase, "swapped-desktop-proj");
    mkdirp(home);
    mkdirp(proj);
    writeRegistry(home, "swapped-proj", proj);
    const port = await freePort();
    const desktop = track(spawnDesktop(home, port));
    const mine = await waitFor(() => {
      const d = readDescRaw(home);
      return d !== null && d.pid === desktop.child.pid ? d : null;
    }, 40_000);
    ok(mine !== null, "S7-0 桌面后端首发成为唯一写宿主（描述符属本进程）", { desc: mine, child: desktop.child.pid });

    // 基线：owner 态下 work 写命令成功、账本 1 行（证明**该端点确实能写**——不是"零增"本身当覆盖）。
    const w1 = await httpPostJson(
      `http://127.0.0.1:${port}/api/work/command`,
      taskCreated("swapped-proj", "task-s1", "k-s1"),
      { "x-tatai-work-token": mine?.token ?? "" },
    );
    ok(w1.status === 200 && ledgerLines(proj) === 1, "S7-1 owner 态写命令成功、账本 1 行（端点为真写口）", { status: w1.status, lines: ledgerLines(proj), body: w1.json });

    // 换描述符：冒充一个新 owner（pid 用测试进程，token 不同）。
    const newDesc: Desc = {
      schema_version: 2,
      pid: process.pid,
      host: "127.0.0.1",
      port: 9,
      token: "new-owner-token",
      started_at: new Date().toISOString(),
      url: "http://127.0.0.1:9",
    };
    writeDescRaw(home, newDesc);

    // 旧端点（桌面）带旧令牌写新实体 → 必须 503，账本零增。
    const w2 = await httpPostJson(
      `http://127.0.0.1:${port}/api/work/command`,
      taskCreated("swapped-proj", "task-s2", "k-s2"),
      { "x-tatai-work-token": mine?.token ?? "" },
    );
    ok(w2.status === 503, "S7-2 易主后旧端点 work 写命令被 503 拒绝（即使带旧令牌）", w2);
    ok(ledgerLines(proj) === 1, "S7-3 旧端点被拒后账本零增（仍 1 行）", { lines: ledgerLines(proj) });
    const acc2 = await httpPostJson(`http://127.0.0.1:${port}/api/projects/swapped-proj/acceptance`, {
      decision: "accept",
      accepted_by: "user",
    });
    ok(acc2.status === 503, "S7-4 易主后本地直挂写路由（验收）同样 503", acc2);
    ok(ledgerLines(proj) === 1, "S7-5 本地直挂写被拒后账本仍零增", { lines: ledgerLines(proj) });

    const afterSwap = readDescRaw(home);
    ok(afterSwap !== null && afterSwap.pid === newDesc.pid && afterSwap.token === newDesc.token, "S7-6 新 owner 描述符保留（旧宿主未覆盖/未删）", { afterSwap });

    // 旧宿主退出：锁内比对后删除——不得删新 owner 的描述符。
    await stopProc(desktop);
    const afterExit = readDescRaw(home);
    ok(afterExit !== null && afterExit.pid === newDesc.pid && afterExit.token === newDesc.token, "S7-7 旧宿主退出后新 owner 描述符仍在（不删别人的）", { afterExit });
  }

  // ═══ S8 撤描述符：锁内比对后删除（单元） ═══
  info("── S8 撤描述符=锁内比对后删除（自持才删 / 易主不删 / 坏描述符不删）");
  {
    const home = path.join(tmpBase, "unpublish-home");
    mkdirp(home);
    const selfDesc: Desc = { schema_version: 2, pid: process.pid, host: "127.0.0.1", port: 1, token: "t-self", started_at: new Date().toISOString(), url: "http://127.0.0.1:1" };
    writeDescRaw(home, selfDesc);
    const r1 = removeDescriptorIfOwned(home, "t-self");
    ok(r1.removed === true && readDescRaw(home) === null, "S8-1 描述符属本进程（pid+token）→ 删除", r1);

    writeDescRaw(home, { ...selfDesc, pid: process.pid + 1, token: "t-other" });
    const r2 = removeDescriptorIfOwned(home, "t-self");
    ok(r2.removed === false && r2.reason === "owned_by_other" && readDescRaw(home)?.token === "t-other", "S8-2 描述符属别的进程 → 不删（不删新宿主的描述符）", r2);

    const corrupt = "{ this is not json\n";
    fs.writeFileSync(descPath(home), corrupt, "utf8");
    const r3 = removeDescriptorIfOwned(home, "t-self");
    ok(r3.removed === false && r3.reason === "descriptor_unreadable" && fs.readFileSync(descPath(home), "utf8") === corrupt, "S8-3 坏/读不了的描述符 → 保守不删（不当它不存在）", r3);
  }

  // ═══ S9 坏描述符：所有权未知 → 发布仲裁保守拒绝、不覆写（单元 + 真 daemon） ═══
  info("── S9 坏描述符=所有权未知：发布仲裁保守拒绝、不覆写；真 daemon 退位");
  {
    const home = path.join(tmpBase, "bad-desc-home");
    mkdirp(home);
    const corrupt = '{"pid": not-json\n';
    fs.writeFileSync(descPath(home), corrupt, "utf8");

    const st = readDescriptorState(home);
    ok(st.kind === "invalid", "S9-1 readDescriptorState 把坏描述符判 invalid（不是 missing）", st);
    const own = readOwnership(home);
    ok(own.state === "invalid" && own.descriptor === null, "S9-2 readOwnership 报 invalid、descriptor=null", own);

    let called = 0;
    const arb = publishUnderOwnershipLock(home, () => { called += 1; });
    ok(arb.published === false && arb.reason === "descriptor_unreadable" && called === 0, "S9-3 坏描述符 → 发布仲裁保守拒绝（不覆写、不调用 publish）", arb);
    ok(fs.readFileSync(descPath(home), "utf8") === corrupt, "S9-4 坏描述符原样保留（没被当不存在覆盖）");

    const daemon = track(spawnDaemon(home));
    const gone = await waitFor(() => (daemon.exited() === null ? null : daemon.exited()), 15_000);
    ok(gone === 0, "S9-5 真 daemon 面对坏描述符退位 exit=0（不抢写者身份）", { code: gone, log: daemon.log().slice(-400) });
    ok(fs.readFileSync(descPath(home), "utf8") === corrupt, "S9-6 daemon 未覆写坏描述符", { content: fs.readFileSync(descPath(home), "utf8").slice(0, 80) });

    // readDescriptorState / descriptorBelongsTo 三态补齐
    const home2 = path.join(tmpBase, "descstate-home");
    mkdirp(home2);
    ok(readDescriptorState(home2).kind === "missing", "S9-7 无描述符 → missing");
    writeDescRaw(home2, { schema_version: 2, pid: process.pid, host: "127.0.0.1", port: 1, token: "t", started_at: new Date().toISOString(), url: "http://127.0.0.1:1" });
    ok(readDescriptorState(home2).kind === "valid", "S9-8 合法描述符 → valid");
    ok(descriptorBelongsTo(home2, "t") === true, "S9-9 描述符属本进程（pid+token）→ belongsTo=true");
    ok(descriptorBelongsTo(home2, "other") === false, "S9-10 token 不符 → belongsTo=false");
  }

  // ═══ S10 慢 body 竞态：body 到达前描述符易主 → 实际写入前重查所有权、503、零变更 ═══
  info("── S10 真 child + HTTP 慢 body：body 中途易主 → 落盘前重查所有权（command / reporting / baseline / 直挂 documents）");
  {
    const home = path.join(tmpBase, "slowbody-home");
    const proj = path.join(tmpBase, "slowbody-proj");
    mkdirp(home);
    mkdirp(proj);
    mkdirp(path.join(proj, ".工作台"));
    fs.writeFileSync(path.join(proj, ".工作台", "design.md"), "# 设计\n\n慢 body 夹具\n", "utf8");
    fs.writeFileSync(path.join(proj, ".工作台", "plan.md"), "# 施工图\n\n慢 body 夹具\n", "utf8");
    writeRegistry(home, "slow-proj", proj);
    const port = await freePort();
    const desktop = track(spawnDesktop(home, port));
    const mine = await waitFor(() => { const d = readDescRaw(home); return d !== null && d.pid === desktop.child.pid ? d : null; }, 40_000);
    ok(mine !== null, "S10-0 桌面后端成为唯一写宿主（描述符属本进程）", { desc: mine, child: desktop.child.pid });
    const token = mine?.token ?? "";
    const evidenceDir = path.join(proj, ".工作台", "work", "evidence");
    const workbench = path.join(proj, ".工作台");

    // 先各写一次，证明端点**确实是真写口**（不是"本来就零增"当覆盖）。
    const w0 = await httpPostJson(`http://127.0.0.1:${port}/api/work/command`, taskCreated("slow-proj", "task-sb0", "k-sb0"), { [WORK_TOKEN_HEADER]: token });
    ok(w0.status === 200 && ledgerLines(proj) === 1, "S10-1 owner 态快写命令成功、账本 1 行（端点为真写口）", { status: w0.status, lines: ledgerLines(proj), body: w0.json });
    const ev0 = await httpPostJson(`http://127.0.0.1:${port}/api/work/reporting/evidence`, {
      project_id: "slow-proj", content: "owner evidence", kind: "other", summary: "owner write",
      created_by: "verify", role: "executor", binding: { revision_kind: "design", revision: "r1" },
    }, { [WORK_TOKEN_HEADER]: token });
    ok(ev0.status === 200 && countFiles(evidenceDir) === 1, "S10-2 owner 态证据写成功、证据 1 份（端点为真写口）", { status: ev0.status, files: countFiles(evidenceDir), body: ev0.json });
    const b0 = await httpPostJson(`http://127.0.0.1:${port}/api/work/baseline/preserve`, { project_id: "slow-proj", kind: "design" }, { [WORK_TOKEN_HEADER]: token });
    ok(b0.status === 200, "S10-3 owner 态基线 preserve 成功（端点为真写口）", { status: b0.status, body: b0.json });

    const led0 = ledgerLines(proj);
    const evShadow = countFiles(evidenceDir);
    const baseShadow = countFiles(workbench);
    const swap = (): void => writeDescRaw(home, { schema_version: 2, pid: process.pid, host: "127.0.0.1", port: 9, token: "new-owner-token", started_at: new Date().toISOString(), url: "http://127.0.0.1:9" });
    const resetMine = (): void => { if (mine !== null) writeDescRaw(home, mine); };

    // ① 事件写口：头+半 body 后换描述符 → 锁内落盘前重查 → 503、账本零增。
    resetMine();
    const rCmd = await slowBodyPost(port, "/api/work/command", token, JSON.stringify(taskCreated("slow-proj", "task-sb1", "k-sb1")), swap);
    ok(rCmd.status === 503, "S10-4 慢 body+中途易主 → work 命令 503（锁内落盘前重查所有权）", { status: rCmd.status, raw: rCmd.raw.slice(0, 300) });
    ok(ledgerLines(proj) === led0, "S10-5 慢 body 被拒后账本零增", { lines: ledgerLines(proj), before: led0 });

    // 旧令牌：易主后**快写**同样拒（不是只拦慢 body）。
    const rOld = await httpPostJson(`http://127.0.0.1:${port}/api/work/command`, taskCreated("slow-proj", "task-sb2", "k-sb2"), { [WORK_TOKEN_HEADER]: token });
    ok(rOld.status === 503, "S10-6 易主后旧令牌快写同样 503", rOld);
    ok(ledgerLines(proj) === led0, "S10-7 旧令牌被拒后账本仍零增", { lines: ledgerLines(proj) });

    // ② 证据写口：慢 body 中途易主 → 落盘前重查 → 503、证据零增。
    resetMine();
    const rEv = await slowBodyPost(port, "/api/work/reporting/evidence", token, JSON.stringify({
      project_id: "slow-proj", content: "slow body evidence", kind: "other", summary: "slow body race",
      created_by: "verify", role: "executor", binding: { revision_kind: "design", revision: "r1" },
    }), swap);
    ok(rEv.status === 503, "S10-8 慢 body+中途易主 → 证据写 503（落盘前重查所有权）", { status: rEv.status, raw: rEv.raw.slice(0, 300) });
    ok(countFiles(evidenceDir) === evShadow, "S10-9 证据零增（没有第二份正文落盘）", { files: countFiles(evidenceDir), before: evShadow });

    // ③ 基线写口：慢 body 中途易主 → 落盘前重查 → 503、基线零增。
    resetMine();
    const rBase = await slowBodyPost(port, "/api/work/baseline/preserve", token, JSON.stringify({ project_id: "slow-proj", kind: "design" }), swap);
    ok(rBase.status === 503, "S10-10 慢 body+中途易主 → 基线 preserve 503（落盘前重查所有权）", { status: rBase.status, raw: rBase.raw.slice(0, 300) });
    ok(countFiles(workbench) === baseShadow, "S10-11 基线零增（不可变历史未多变一份）", { files: countFiles(workbench), before: baseShadow });

    // ④ 直挂 documents/preserve：慢 body 中途易主 → 回调内落盘前重查 → 503，**不**"写响应后又返回成功"。
    resetMine();
    const rDirect = await slowBodyPost(port, "/api/projects/slow-proj/documents/preserve", "", JSON.stringify({ kind: "design" }), swap);
    ok(rDirect.status === 503, "S10-12 慢 body+中途易主 → 直挂 documents/preserve 503（回调内落盘前重查）", { status: rDirect.status, raw: rDirect.raw.slice(0, 300) });
    ok(countFiles(workbench) === baseShadow, "S10-13 直挂 preserve 被拒后基线仍零增（无二次响应/无半写）", { files: countFiles(workbench) });

    await stopProc(desktop);
  }

  // ═══ S11 ensureWorkService：慢活/坏描述符不 spawn 真实链、真死才 recover ═══
  info("── S11 ensureWorkService：慢活/坏描述符不 spawn 真实链；真死 pid 才 recover");
  {
    // 用一个"若真被 spawn 就落标记再退出"的真链替代品，直接侦测有没有 spawn。
    const sentinel = path.join(tmpBase, "spawn-probe.js");
    fs.writeFileSync(
      sentinel,
      "const fs=require('fs');try{fs.writeFileSync(process.env.SPAWN_MARKER||'spawn.marker','spawned')}catch{};process.exit(0);\n",
      "utf8",
    );
    const prevEntry = process.env.TATAI_WRITE_SERVICE_ENTRY;
    process.env.TATAI_WRITE_SERVICE_ENTRY = sentinel;

    // ① 慢活（描述符 pid 活、探活不可达）→ 不 spawn
    {
      const home = path.join(tmpBase, "ensure-slow-home");
      const marker = path.join(tmpBase, "ensure-slow.marker");
      mkdirp(home);
      const slow = await startSlowHost(home);
      track(slow.proc);
      writeDescRaw(home, { schema_version: 2, pid: slow.proc.child.pid ?? -1, host: "127.0.0.1", port: slow.port, token: "slow-tok", started_at: new Date().toISOString(), url: `http://127.0.0.1:${slow.port}` });
      process.env.SPAWN_MARKER = marker;
      const client = new WorkServiceClient({ dataDir: home, timeoutMs: 400, autostart: true });
      const got = await client.ensureWorkService();
      await sleep(500);
      ok(got === null && !fs.existsSync(marker), "S11-1 慢活描述符 → ensure 返回 null 且未 spawn 真实链", { got, marker: fs.existsSync(marker) });
      ok((readDescRaw(home)?.token ?? "") === "slow-tok", "S11-2 慢活描述符未被覆盖", { desc: readDescRaw(home)?.token });
    }

    // ② 坏描述符（在场但解析不出）→ 所有权未知 → 不 spawn、不覆写
    {
      const home = path.join(tmpBase, "ensure-bad-home");
      const marker = path.join(tmpBase, "ensure-bad.marker");
      mkdirp(home);
      const corrupt = '{"pid": not-json\n';
      fs.writeFileSync(descPath(home), corrupt, "utf8");
      process.env.SPAWN_MARKER = marker;
      const client = new WorkServiceClient({ dataDir: home, timeoutMs: 400, autostart: true });
      const got = await client.ensureWorkService();
      await sleep(500);
      ok(got === null && !fs.existsSync(marker), "S11-3 坏描述符 → ensure 返回 null 且未 spawn（不当它不存在）", { got, marker: fs.existsSync(marker) });
      ok(fs.readFileSync(descPath(home), "utf8") === corrupt, "S11-4 坏描述符原样保留（没被覆盖）");
    }

    // ③ 真死 pid → 清陈旧后 recover（spawn 真实链）——保留 dead recover，别把自愈一起关掉。
    {
      const home = path.join(tmpBase, "ensure-dead-home");
      const marker = path.join(tmpBase, "ensure-dead.marker");
      mkdirp(home);
      const dead = await deadPid();
      writeDescRaw(home, { schema_version: 2, pid: dead, host: "127.0.0.1", port: 1, token: "dead-tok", started_at: new Date().toISOString(), url: "http://127.0.0.1:1" });
      process.env.SPAWN_MARKER = marker;
      const client = new WorkServiceClient({ dataDir: home, timeoutMs: 400, autostart: true });
      await client.ensureWorkService();
      const spawned = await waitFor(() => (fs.existsSync(marker) ? true : null), 4000);
      ok(spawned === true, "S11-5 真死描述符 → 清陈旧后 recover（spawn 真实链）", { marker: fs.existsSync(marker), desc: readDescRaw(home)?.pid });
    }

    if (prevEntry === undefined) delete process.env.TATAI_WRITE_SERVICE_ENTRY;
    else process.env.TATAI_WRITE_SERVICE_ENTRY = prevEntry;
    delete process.env.SPAWN_MARKER;
  }

  // ── 收尾 ──
  info(`── 收尾：${passCount} PASS / ${failCount} FAIL`);
  console.log(failCount === 0 ? "[verify] 结果: 全部 PASS" : "[verify] 结果: FAIL（上面有 FAIL 行）");
}

async function cleanup(): Promise<void> {
  for (const p of procs) {
    try { if (p.child.exitCode === null) p.child.kill(); } catch { /* ignore */ }
  }
  await sleep(400);
  for (const p of procs) {
    try { if (p.child.exitCode === null) p.child.kill("SIGKILL"); } catch { /* ignore */ }
  }
  if (process.env.TATAI_KEEP_TMP !== "1") {
    try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch { /* ignore */ }
  } else {
    info(`  保留现场 ${tmpBase}`);
  }
}

main()
  .catch((e) => { console.error(`[verify] 脚本异常：${e instanceof Error ? (e.stack ?? e.message) : String(e)}`); process.exitCode = 1; })
  .finally(() => { void cleanup(); });
