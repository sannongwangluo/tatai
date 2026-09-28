// H4 验证脚本（用 tsx 跑）：文件监听加固——大项目/高翻转子目录不再把后端拖死，且监听能力不缩水。
// 用法：pnpm verify:h4
//   真实项目压测段（可选）：先设 `TATAI_H4_BIG_PROJECT=<项目根绝对路径>` 再跑，
//   脚本会对该项目做同一套压测（本机实测对象是一个真实大项目，路径与数值见 PROGRESS 流水；
//   脚本本身不写死任何真实路径，开源版不跑这一段也能全绿）。
// 覆盖点（对应 PLAN.md H4 DoD ①②③ 与施工图里的加固项）：
//   ① 动态端口 + 探活（起前探端口、起后盯子进程早退）
//   ② 根因对照（合成夹具，不依赖任何真实项目）：同一份"含联接点出项目根"的目录
//      —— chokidar 默认 followSymlinks:true 时扫描无界（事件持续上涨/ready 不达）
//      —— 本项目实现（不跟随）时扫描收敛、事件量≈真实条目数
//   ③ DoD① 压测：挂监听期间 /health 与 /api/projects 逐次采样全部 < 100ms（贴 min/avg/max + 内存）
//   ④ DoD② 高频变更：1 秒 200 次修改 → 关键项不丢、落盘账对得上（changes = written + dropped）、内存不涨；
//      再收紧队列上限重跑一次，让丢弃路径真实发生（dropped > 0 + stderr 有丢弃日志）
//   ⑤ DoD③ unwatch 回滚：句柄数/CPU 回落、延迟回落、流水不再追加
//   ⑥ 加固项自查：预算超限 → 仅顶层降级 + truncated 记录（且顶层/一级子目录仍记流水）；
//      忽略段（含 H4 新增的临时/缓存段）不产生流水；项目根在 temp/tmp/cache 类目录下时不被整体忽略
//   ⑦ H1 口径回归：add/modify/remove 区分 + size_delta 正确（本脚本自查，权威回归仍是 pnpm verify:h1）
import { execSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { watch } from "chokidar";
import { addProject } from "../src/server/registry";
import type { ChangeLine } from "../src/server/watcher";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const ok = (cond: boolean, label: string) => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (!cond) process.exitCode = 1;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── 动态端口 + 探活（照 verify-n3 的口径：端口被残留服务占用会静默假通过，必须起前探、起后盯）──
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

/** 让系统分配一个空闲端口（读完就关，靠"立刻占用"的重试窗口兜底） */
async function freePort(): Promise<number> {
  for (let i = 0; i < 20; i++) {
    const port = await new Promise<number>((resolve, reject) => {
      const srv = net.createServer();
      srv.once("error", reject);
      srv.listen(0, "127.0.0.1", () => {
        const p = (srv.address() as net.AddressInfo).port;
        srv.close(() => resolve(p));
      });
    });
    if (!(await portListening(port))) return port;
  }
  throw new Error("找不到空闲端口");
}

// ── 临时数据目录与夹具项目（不碰真实注册表；真实项目段只读注册，不写那个项目的任何文件）──
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-h4-verify-"));
const dataDir = path.join(tmpBase, "home");
fs.mkdirSync(dataDir, { recursive: true });

const smallDir = path.join(tmpBase, "h4-small"); // 常规小项目：H1 口径回归 + 忽略段自查
const manyDir = path.join(tmpBase, "h4-many"); // 300 目录：句柄/CPU 回滚证据
const bigDir = path.join(tmpBase, "h4-big"); // 单目录 3500 文件：预算超限 → 仅顶层降级
const juncDir = path.join(tmpBase, "h4-junc"); // 联接点出项目根 + 自指环：根因对照
const outsideDir = path.join(tmpBase, "h4-outside"); // junc 夹具的"项目外"

for (const d of ["src", "node_modules/pkg", ".工作台", "dist", ".tmp", "temp", "cache", "__pycache__"]) {
  fs.mkdirSync(path.join(smallDir, d), { recursive: true });
}
fs.writeFileSync(path.join(smallDir, "src", "keep.ts"), "export const k = 1;\n");
for (let i = 0; i < 300; i++) fs.mkdirSync(path.join(manyDir, `d${i}`), { recursive: true });
for (let i = 0; i < 300; i++) {
  fs.writeFileSync(path.join(manyDir, `d${i}`, "f.txt"), "x\n");
}
fs.mkdirSync(path.join(bigDir, "hot"), { recursive: true });
fs.mkdirSync(path.join(bigDir, "sub", "deep"), { recursive: true });
for (let i = 0; i < 3500; i++) {
  fs.writeFileSync(path.join(bigDir, "hot", `h${i}.log`), "x".repeat(32));
}
fs.writeFileSync(path.join(bigDir, "top.txt"), "top\n");
fs.writeFileSync(path.join(bigDir, "sub", "deep.txt"), "deep\n");
fs.writeFileSync(path.join(bigDir, "sub", "deep", "deeper.txt"), "deeper\n");
fs.mkdirSync(path.join(juncDir, "src"), { recursive: true });
fs.mkdirSync(path.join(juncDir, "hot"), { recursive: true });
fs.mkdirSync(outsideDir, { recursive: true });
fs.writeFileSync(path.join(juncDir, "src", "a.ts"), "export const a = 1;\n");
for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(juncDir, "hot", `h${i}.log`), "x".repeat(64));
for (let i = 0; i < 300; i++) fs.writeFileSync(path.join(outsideDir, `o${i}.txt`), "outside\n");
let junctionReady = true;
try {
  fs.symlinkSync(path.join(juncDir, "hot"), path.join(juncDir, "hot", "cycle"), "junction"); // 自指环
  fs.symlinkSync(outsideDir, path.join(juncDir, "out"), "junction"); // 出项目根
} catch (e) {
  junctionReady = false;
  console.log(`[verify] 建联接点失败（${(e as Error).message}），跳过联接点相关断言`);
}

addProject({ id: "h4-small", name: "H4 小项目", path: smallDir, kind: "backend" }, dataDir);
addProject({ id: "h4-many", name: "H4 多目录项目", path: manyDir, kind: "backend" }, dataDir);
addProject({ id: "h4-big", name: "H4 巨目录项目", path: bigDir, kind: "backend" }, dataDir);
addProject({ id: "h4-junc", name: "H4 联接点项目", path: juncDir, kind: "backend" }, dataDir);

// 真实项目段（可选）：只登记路径做压测，不写该项目任何文件（changes.jsonl 跑完按原样还原）
const realPath = process.env.TATAI_H4_BIG_PROJECT;
const realChangesFile = realPath ? path.join(realPath, ".工作台", "changes.jsonl") : null;
const realChangesBackup =
  realChangesFile && fs.existsSync(realChangesFile) ? fs.readFileSync(realChangesFile) : null;
if (realPath) {
  addProject({ id: "h4-real", name: "H4 真实项目", path: realPath, kind: "backend" }, dataDir);
}

interface ApiResp {
  status: number;
  body: {
    ok?: boolean;
    watching?: string[];
    details?: {
      id: string;
      mode: string;
      ready: boolean;
      truncated: boolean;
      truncate_reason: string | null;
      entries: number;
      dirs: number;
      max_dir_entries: number;
      stats: {
        events: number;
        changes: number;
        written: number;
        dropped: number;
        errors: number;
        last_error: string | null;
      };
    }[];
    changes?: ChangeLine[];
    total?: number;
    removed?: boolean;
    error?: { code: string; message: string };
  };
}

/** 一个后端实例（动态端口）：start 后拿到 BASE，stop 杀干净 */
class Server {
  readonly port: number;
  readonly base: string;
  child: ChildProcess | undefined;
  stderrLines: string[] = [];
  private up = false;
  private constructor(port: number) {
    this.port = port;
    this.base = `http://127.0.0.1:${port}`;
  }
  static async start(env: Record<string, string> = {}): Promise<Server> {
    const port = await freePort();
    const srv = new Server(port);
    const proc = spawn(
      process.execPath,
      ["--import", "tsx", path.join("src", "server", "index.ts")],
      {
        env: { ...process.env, TATAI_HOME: dataDir, TATAI_PORT: String(port), ...env },
        stdio: ["ignore", "pipe", "pipe"],
        cwd: REPO_ROOT,
      },
    );
    srv.child = proc;
    proc.stdout?.on("data", (d: Buffer) => process.stdout.write(`[srv] ${d}`));
    proc.stderr?.on("data", (d: Buffer) => srv.stderrLines.push(d.toString()));
    proc.once("exit", async (code) => {
      if (srv.up) return; // 自己收尾杀的
      const why = (await portListening(port)) ? `端口 ${port} 被占用` : `后端进程提前退出（code=${code}）`;
      console.error(`[verify] 后端起不来：${why}，先清理残留进程`);
      process.exit(1);
    });
    for (let i = 0; i < 60; i++) {
      const r = await srv.timed("/health", 1000);
      if (r.status === 200) {
        srv.up = true;
        return srv;
      }
      await sleep(200);
    }
    throw new Error("后端 15 秒内未就绪");
  }
  async timed(url: string, timeoutMs: number): Promise<{ ms: number; status: number | string }> {
    const t0 = Date.now();
    try {
      const res = await fetch(`${this.base}${url}`, { signal: AbortSignal.timeout(timeoutMs) });
      return { ms: Date.now() - t0, status: res.status };
    } catch (e) {
      return { ms: Date.now() - t0, status: `ERR:${(e as Error).name}` };
    }
  }
  async req(method: string, url: string): Promise<ApiResp> {
    const res = await fetch(`${this.base}${url}`, { method });
    return { status: res.status, body: (await res.json()) as ApiResp["body"] };
  }
  async detail(id: string): Promise<NonNullable<ApiResp["body"]["details"]>[number] | undefined> {
    const r = await this.req("GET", "/api/watch");
    return r.body.details?.find((d) => d.id === id);
  }
  async stop(): Promise<void> {
    this.up = true; // 标记为"自己收尾"，免得 exit 钩子报错
    this.child?.kill();
    await sleep(400);
  }
}

function readLines(file: string): ChangeLine[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter((s) => s.trim() !== "")
    .map((s) => JSON.parse(s) as ChangeLine);
}

/** 轮询等流水行数达到 min */
async function waitForLines(file: string, min: number, timeoutMs = 20000): Promise<ChangeLine[]> {
  const t0 = Date.now();
  for (;;) {
    const lines = readLines(file);
    if (lines.length >= min) return lines;
    if (Date.now() - t0 > timeoutMs) {
      throw new Error(`等待超时：${file} 行数=${lines.length}，期望≥${min}`);
    }
    await sleep(200);
  }
}

/** 等 details 里该项目 ready（预扫描 + chokidar 初始扫描） */
async function waitReady(srv: Server, id: string, timeoutMs = 30000): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    const d = await srv.detail(id);
    if (d?.ready) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`等待 ready 超时：${id}`);
    await sleep(200);
  }
}

function procStat(pid: number, field: "CPU" | "WorkingSet64" | "HandleCount"): number {
  try {
    return Number(
      execSync(`powershell -NoProfile -Command "(Get-Process -Id ${pid}).${field}"`)
        .toString()
        .trim(),
    );
  } catch {
    return NaN;
  }
}
const cpuSec = (pid: number) => procStat(pid, "CPU");
const rssMb = (pid: number) => procStat(pid, "WorkingSet64") / 1048576;
const handles = (pid: number) => procStat(pid, "HandleCount");

interface Pressure {
  health: number[];
  projects: number[];
  rssBefore: number;
  rssAfter: number;
  cpuDelta: number;
  detail: NonNullable<ApiResp["body"]["details"]>[number] | undefined;
}

/** DoD① 压测：挂监听 → 逐次采样 /health 与 /api/projects 延迟 + 内存/CPU */
async function pressure(srv: Server, id: string, seconds: number, label: string): Promise<Pressure> {
  const pid = srv.child!.pid!;
  const base = [await srv.timed("/health", 8000), await srv.timed("/api/projects", 8000)];
  console.log(
    `[verify]   ${label} 基线（未开监听）: /health ${base[0].ms}ms · /api/projects ${base[1].ms}ms`,
  );
  const cpu0 = cpuSec(pid);
  const rssBefore = rssMb(pid);
  const w = await srv.req("POST", `/api/projects/${encodeURIComponent(id)}/watch`);
  if (w.status !== 200) throw new Error(`${label} 开监听失败: HTTP ${w.status} ${JSON.stringify(w.body)}`);
  await waitReady(srv, id);

  const health: number[] = [];
  const projects: number[] = [];
  const t0 = Date.now();
  while (Date.now() - t0 < seconds * 1000) {
    const h = await srv.timed("/health", 8000);
    const p = await srv.timed("/api/projects", 8000);
    health.push(h.ms);
    projects.push(p.ms);
    await sleep(400);
  }
  const rssAfter = rssMb(pid);
  const cpuDelta = cpuSec(pid) - cpu0;
  const detail = await srv.detail(id);
  const fmt = (xs: number[]) =>
    `${Math.min(...xs)}/${Math.round(xs.reduce((a, b) => a + b, 0) / xs.length)}/${Math.max(...xs)}ms（min/avg/max，${xs.length} 次采样）`;
  console.log(
    `[verify]   ${label} 监听期间 /health ${fmt(health)} · /api/projects ${fmt(projects)}`,
  );
  console.log(
    `[verify]   ${label} 内存 ${rssBefore.toFixed(0)}MB → ${rssAfter.toFixed(0)}MB；监听期 CPU 增量 ${cpuDelta.toFixed(1)}s / ${seconds}s；计数 ${JSON.stringify(detail?.stats)}；模式 ${detail?.mode} truncated=${detail?.truncated} 条目=${detail?.entries}`,
  );
  return { health, projects, rssBefore, rssAfter, cpuDelta, detail };
}

let server: Server | undefined;
let server2: Server | undefined;
// Q1：② 段两个 probe watcher 捕获到的监听错误（chokidar 的 ELOOP 等以未捕获 "error" 事件抛出，
// 没有 handler 会杀进程）。收集到脚本末尾统一打印——晚到的错误可能在段②汇总行之后才到，
// 汇总在末尾才不会漏记。
const watcherErrors: string[] = [];
try {
  console.log("[verify] ── ② 根因对照：联接点出项目根时 chokidar 默认跟随 vs 本项目不跟随 ──");
  if (junctionReady) {
    // 默认跟随（修复前的等效配置）：照着现有实现的其它选项，只把 followSymlinks 调回默认 true
    const probe = async (follow: boolean): Promise<{ events: number; readyMs: number }> => {
      let events = 0;
      let readyMs = -1;
      let errSeen = 0;
      const t0 = Date.now();
      const w = watch(juncDir, {
        cwd: juncDir,
        ignoreInitial: false,
        ignorePermissionErrors: true,
        followSymlinks: follow,
        ignored: (p: string) => p.split(/[\\/]/).some((s) => s === "node_modules" || s === ".git"),
      });
      w.on("all", () => events++);
      // Q1：FSWatcher 必须挂 error 监听——chokidar 在 ELOOP 等场景抛的是未捕获 "error" 事件，
      // 没有 handler 会直接结束进程（后面的段③~⑦ 一条都跑不到）；这里只记录，不借此提前结束等待，
      // 这样出错时 readyMs 仍为 -1，下面的断言按"未收敛"如实 FAIL，而不是让整个脚本崩掉
      const onError = (err: unknown): void => {
        if (errSeen < 8) {
          errSeen++;
          watcherErrors.push(
            `[${follow ? "跟随" : "不跟随"}] ${(err as NodeJS.ErrnoException).code}: ${(err as Error).message}`,
          );
        }
      };
      w.on("error", onError);
      await new Promise<void>((resolve) => {
        w.on("ready", () => {
          readyMs = Date.now() - t0;
          resolve();
        });
        setTimeout(resolve, 8000); // 8s 还没 ready 就按"未收敛"记
      });
      // Q1：chokidar 的 close() 内部会 removeAllListeners()，而在飞扫描不会立刻停——
      // 跟随模式下扫描永远不收敛，close() 之后仍会抛 ELOOP；此时前面挂的 handler 已被摘掉，
      // 晚到的错误就成了未捕获 "error" 事件（进程被杀）。所以先同步 close()、同一个 tick 内补挂 handler，
      // 再 await 关闭完成，堵住这中间的窗口。
      const closing = w.close();
      w.on("error", onError);
      await closing;
      return { events, readyMs };
    };
    const follow = await probe(true);
    const nofollow = await probe(false);
    console.log(
      `[verify]   同一夹具（6 文件 + 2 个联接点，项目外另有 300 文件）：默认跟随 → 事件 ${follow.events} 条 / ready ${follow.readyMs < 0 ? "8s 未达" : `${follow.readyMs}ms`}；不跟随 → 事件 ${nofollow.events} 条 / ready ${nofollow.readyMs}ms`,
    );
    ok(
      nofollow.readyMs >= 0 && nofollow.events < 40,
      `② 不跟随联接点：扫描收敛（ready ${nofollow.readyMs}ms）且事件只有夹具自己的 36 个条目（实际 ${nofollow.events} 条）`,
    );
    ok(
      follow.events > nofollow.events,
      `② 根因成立：默认跟随联接点会把项目外/环里的条目也当本项目事件（跟随 ${follow.events} 条 > 不跟随 ${nofollow.events} 条）`,
    );
  }

  server = await Server.start();
  console.log(
    `[verify] server up at ${server.base}（TATAI_HOME=${dataDir}，端口由系统分配）`,
  );

  // ── ⑥ 加固项自查：联接点项目不越界、不拖慢；忽略段不产生流水 ──
  console.log("[verify] ── ⑥ 加固项自查（联接点项目 + 忽略段）──");
  const jp = await pressure(server, "h4-junc", 6, "联接点项目 h4-junc");
  ok(
    Math.max(...jp.health) < 100 && Math.max(...jp.projects) < 100,
    `⑥ 含联接点项目的服务正常：/health max ${Math.max(...jp.health)}ms、/api/projects max ${Math.max(...jp.projects)}ms（<100ms）`,
  );
  ok(
    (jp.detail?.stats.events ?? 0) < 200,
    `⑥ 不越界：初始扫描只在项目根内（事件 ${jp.detail?.stats.events} 条，项目外 300 个文件一条都没进来）`,
  );
  fs.writeFileSync(path.join(juncDir, "src", "b.ts"), "export const b = 2;\n");
  const jLines = await waitForLines(path.join(juncDir, ".工作台", "changes.jsonl"), 1);
  ok(
    jLines.some((l) => l.path === "src/b.ts"),
    `⑥ 联结点不挡正常监听：项目内改文件照常记流水（实际 ${JSON.stringify(jLines[jLines.length - 1])}）`,
  );
  ok(
    !jLines.some((l) => l.path.includes("cycle") || l.path.includes("out/")),
    "⑥ 联接点路径不进流水（自指环 hot/cycle 与出屋 out/ 都没有条目）",
  );
  await server.req("DELETE", "/api/projects/h4-junc/watch");

  // 忽略段：H4 新增的临时/缓存段 + H1 原有四大段，改了都不进流水
  const smallChanges = path.join(smallDir, ".工作台", "changes.jsonl");
  await server.req("POST", "/api/projects/h4-small/watch");
  await waitReady(server, "h4-small");
  const ignoredProbe = ["node_modules/pkg", "dist", ".工作台", ".tmp", "temp", "cache", "__pycache__"];
  for (const d of ignoredProbe) fs.writeFileSync(path.join(smallDir, d, "probe.txt"), "probe\n");
  await sleep(2500);
  const afterIgnored = readLines(smallChanges).length;
  const ignoredCount = ignoredProbe.length;
  ok(
    afterIgnored === 0,
    `⑥ 忽略段零流水：${ignoredCount} 个忽略目录（含 H4 新增 .tmp/temp/cache）内建文件 → 流水 ${afterIgnored} 条`,
  );

  // ── ⑦ H1 口径回归：add / modify / remove 区分 + size_delta ──
  console.log("[verify] ── ⑦ H1 口径回归（add/modify/remove + size_delta）──");
  const contentA = "hello h4"; // 8 字节
  fs.writeFileSync(path.join(smallDir, "a.txt"), contentA, "utf8");
  await waitForLines(smallChanges, 1);
  fs.appendFileSync(path.join(smallDir, "a.txt"), "+++", "utf8"); // +3
  const lines2 = await waitForLines(smallChanges, 2);
  fs.unlinkSync(path.join(smallDir, "a.txt"));
  const lines3 = await waitForLines(smallChanges, 3);
  console.log(`[verify]   真实三行: ${lines3.map((l) => JSON.stringify(l)).join(" | ")}`);
  ok(
    lines2[0].action === "add" && lines2[0].size_delta === 8 && lines2[0].path === "a.txt",
    `⑦ add 行：action=add、path=a.txt、size_delta=8（实际 ${JSON.stringify(lines2[0])}）`,
  );
  ok(
    lines3[1].action === "modify" && lines3[1].size_delta === 3,
    `⑦ modify 行：action=modify、size_delta=+3（实际 ${JSON.stringify(lines3[1])}）`,
  );
  ok(
    lines3[2].action === "remove" && lines3[2].size_delta === -11,
    `⑦ remove 行：action=remove、size_delta=-11（实际 ${JSON.stringify(lines3[2])}）`,
  );

  // 项目根落在 temp 类目录下时不能被整体忽略（chokidar 给 ignored 的是绝对路径，段名匹配只该管根内）
  const underTemp = path.join(tmpBase, "temp", "h4-undercache");
  fs.mkdirSync(underTemp, { recursive: true });
  addProject({ id: "h4-under", name: "H4 位于 cache 目录下的项目", path: underTemp, kind: "backend" }, dataDir);
  await server.req("POST", "/api/projects/h4-under/watch");
  await waitReady(server, "h4-under");
  fs.writeFileSync(path.join(underTemp, "z.txt"), "z\n");
  const underLines = await waitForLines(path.join(underTemp, ".工作台", "changes.jsonl"), 1);
  ok(
    underLines.some((l) => l.path === "z.txt"),
    `⑥ 项目根位于 temp/cache 类目录下仍正常监听（实际 ${JSON.stringify(underLines[underLines.length - 1]?.path)}）——段名黑名单只对项目根内相对路径生效`,
  );
  await server.req("DELETE", "/api/projects/h4-under/watch");
  await server.req("DELETE", "/api/projects/h4-small/watch");

  // ── ⑥ 预算超限 → 仅顶层降级（且仍能记流水）──
  console.log("[verify] ── ⑥ 初始扫描限量：预算超限转仅顶层 + truncated 记录 ──");
  const bp = await pressure(server, "h4-big", 6, "巨目录项目 h4-big（单目录 3500 文件）");
  ok(
    bp.detail?.truncated === true && bp.detail?.mode === "top",
    `⑥ 降级生效：mode=${bp.detail?.mode} truncated=${bp.detail?.truncated}（原因：${bp.detail?.truncate_reason}）`,
  );
  ok(
    /单目录条目/.test(bp.detail?.truncate_reason ?? ""),
    `⑥ 原因可读且指向"单目录条目"超限（实际 ${JSON.stringify(bp.detail?.truncate_reason)}）`,
  );
  ok(
    (bp.detail?.entries ?? 0) < 3600,
    `⑥ 预扫描真的限量了：只数了 ${bp.detail?.entries} 条就停手（不一次性 stat 上万文件）`,
  );
  const bigChanges = path.join(bigDir, ".工作台", "changes.jsonl");
  fs.writeFileSync(path.join(bigDir, "top.txt"), "top changed\n");
  fs.writeFileSync(path.join(bigDir, "sub", "deep.txt"), "deep changed\n");
  fs.writeFileSync(path.join(bigDir, "sub", "deep", "deeper.txt"), "deeper changed\n");
  await waitForLines(bigChanges, 2);
  await sleep(1500);
  const bigLines = readLines(bigChanges);
  const bigPaths = bigLines.map((l) => l.path);
  console.log(`[verify]   降级模式下的流水: ${JSON.stringify(bigPaths)}`);
  ok(
    bigPaths.includes("top.txt") && bigPaths.includes("sub/deep.txt"),
    "⑥ 降级不等于什么都不监：顶层文件与一级子目录里的文件照常记流水",
  );
  ok(
    !bigPaths.includes("sub/deep/deeper.txt"),
    "⑥ 降级范围明示：二级以下（sub/deep/deeper.txt）不监听——与 truncated 记录一致",
  );
  await server.req("DELETE", "/api/projects/h4-big/watch");

  // ── DoD① 压测（真实项目，可选）──
  if (realPath) {
    console.log(`[verify] ── DoD① 真实项目压测（TATAI_H4_BIG_PROJECT 指定的项目）──`);
    const rp = await pressure(server, "h4-real", 20, "真实项目");
    ok(
      Math.max(...rp.health) < 100 && Math.max(...rp.projects) < 100,
      `DoD① 监听期间 /health max ${Math.max(...rp.health)}ms、/api/projects max ${Math.max(...rp.projects)}ms，全部 < 100ms`,
    );
    ok(
      (rp.detail?.stats.errors ?? 0) <= 3,
      `DoD① 监听错误静默降级：错误 ${rp.detail?.stats.errors} 条（≤ 打屏上限 3，不刷屏）`,
    );
    const cpuRate = rp.cpuDelta / 20;
    ok(
      cpuRate < 0.5,
      `DoD① 监听期 CPU 平均 < 50% 单核（实际 ${(cpuRate * 100).toFixed(1)}%）`,
    );
    ok(
      rp.rssAfter - rp.rssBefore < 300,
      `DoD② 内存不无界增长：${rp.rssBefore.toFixed(0)}MB → ${rp.rssAfter.toFixed(0)}MB（Δ${(rp.rssAfter - rp.rssBefore).toFixed(0)}MB）`,
    );
    await server.req("DELETE", "/api/projects/h4-real/watch");
    await sleep(1000);
    const after = await server.timed("/health", 8000);
    ok(after.ms < 100, `DoD③ 关监听后 /health 仍 < 100ms（实际 ${after.ms}ms）`);
  } else {
    console.log(
      "[verify] ── DoD① 真实项目压测：未设 TATAI_H4_BIG_PROJECT，跳过（合成夹具段已覆盖同一路径）──",
    );
  }

  // ── DoD② 高频变更压测：1 秒 200 次修改 ──
  console.log("[verify] ── DoD② 高频变更：1 秒内 200 次修改 ──");
  const stormDir = path.join(tmpBase, "h4-storm");
  fs.mkdirSync(stormDir, { recursive: true });
  addProject({ id: "h4-storm", name: "H4 高频写项目", path: stormDir, kind: "backend" }, dataDir);
  const stormFiles: string[] = [];
  for (let i = 0; i < 20; i++) {
    const f = path.join(stormDir, `s${i}.txt`);
    fs.writeFileSync(f, "0\n");
    stormFiles.push(f);
  }
  await server.req("POST", "/api/projects/h4-storm/watch");
  await waitReady(server, "h4-storm");
  const stormChanges = path.join(stormDir, ".工作台", "changes.jsonl");
  const pid = server.child!.pid!;
  const rssBeforeStorm = rssMb(pid);
  const stormT0 = Date.now();
  for (let round = 0; round < 10; round++) {
    for (let i = 0; i < 20; i++) fs.appendFileSync(stormFiles[i], `${round}\n`);
  }
  const stormMs = Date.now() - stormT0;
  await waitForLines(stormChanges, 1);
  await sleep(4000); // 等 awaitWriteFinish 稳定 + 落盘合批跑完
  const stormLines = readLines(stormChanges);
  const touched = new Set(stormLines.map((l) => l.path));
  const stormDetail = await server.detail("h4-storm");
  const rssAfterStorm = rssMb(pid);
  console.log(
    `[verify]   200 次修改耗时 ${stormMs}ms；流水 ${stormLines.length} 行、覆盖 ${touched.size}/20 个文件；计数 ${JSON.stringify(stormDetail?.stats)}；内存 ${rssBeforeStorm.toFixed(0)}MB → ${rssAfterStorm.toFixed(0)}MB`,
  );
  ok(
    stormMs < 1500,
    `DoD② 200 次修改确实压在 1 秒级窗口内（实际 ${stormMs}ms）`,
  );
  ok(
    touched.size === 20,
    `DoD② 关键项不丢：20 个被改文件全部出现在流水里（实际 ${touched.size}/20）`,
  );
  ok(
    stormLines.length <= 200,
    `DoD② 无重复爆炸：${stormLines.length} 行 ≤ 200 次修改（awaitWriteFinish 把同一文件的连续写合并成一条）`,
  );
  ok(
    (stormDetail?.stats.written ?? 0) + (stormDetail?.stats.dropped ?? 0) ===
      (stormDetail?.stats.changes ?? -1),
    `DoD② 落盘账对得上：changes=${stormDetail?.stats.changes} = written=${stormDetail?.stats.written} + dropped=${stormDetail?.stats.dropped}`,
  );
  ok(
    (stormDetail?.stats.dropped ?? -1) === 0,
    `DoD② 默认预算下队列没溢出：dropped=${stormDetail?.stats.dropped}（洪峰被合批写吃下，没到 5000 上限）`,
  );
  ok(
    rssAfterStorm - rssBeforeStorm < 150,
    `DoD② 内存不涨：${rssBeforeStorm.toFixed(0)}MB → ${rssAfterStorm.toFixed(0)}MB（Δ${(rssAfterStorm - rssBeforeStorm).toFixed(0)}MB）`,
  );
  const duringStorm = await server.timed("/health", 8000);
  ok(duringStorm.ms < 100, `DoD② 洪峰后服务仍答话：/health ${duringStorm.ms}ms`);
  await server.req("DELETE", "/api/projects/h4-storm/watch");

  // ── DoD③ unwatch 资源回滚（300 目录项目：句柄数最能说明问题）──
  console.log("[verify] ── DoD③ unwatch 资源回收（300 目录项目）──");
  const mpid = server.child!.pid!;
  const h0 = handles(mpid);
  const c0 = cpuSec(mpid);
  const r0 = rssMb(mpid);
  await server.req("POST", "/api/projects/h4-many/watch");
  await waitReady(server, "h4-many");
  await sleep(1500);
  const h1 = handles(mpid);
  const r1 = rssMb(mpid);
  const manyDetail = await server.detail("h4-many");
  const tDel = Date.now();
  const del = await server.req("DELETE", "/api/projects/h4-many/watch");
  const delMs = Date.now() - tDel;
  await sleep(2500);
  const h2 = handles(mpid);
  const c2 = cpuSec(mpid);
  const r2 = rssMb(mpid);
  const idle = await srvIdle(server, 3000);
  console.log(
    `[verify]   句柄 ${h0} → ${h1}（监听 300 目录）→ ${h2}（关了）；RSS ${r0.toFixed(0)}MB → ${r1.toFixed(0)}MB → ${r2.toFixed(0)}MB；DELETE 耗时 ${delMs}ms；关后 3s 内 CPU 增量 ${idle.cpu.toFixed(2)}s（总 CPU ${c0.toFixed(1)}s → ${c2.toFixed(1)}s）；模式 ${manyDetail?.mode} truncated=${manyDetail?.truncated}`,
  );
  ok(del.status === 200 && del.body.removed === true, "DoD③ DELETE watch → removed:true");
  ok(
    delMs < 5000,
    `DoD③ 关监听不等超时：DELETE 耗时 ${delMs}ms —— 修复前同一操作 20s 超时未返回`,
  );
  ok(
    h1 > h0 + 100,
    `DoD③ 监听真挂了句柄：300 目录项目监听期句柄 ${h0} → ${h1}（+${h1 - h0}）`,
  );
  ok(
    h2 <= h0 + 30,
    `DoD③ 关监听后句柄回落：${h1} → ${h2}（基线 ${h0}，容差 30）`,
  );
  ok(
    idle.cpu < 0.5,
    `DoD③ 关监听后 CPU 回落：3s 空转增量 ${idle.cpu.toFixed(2)}s < 0.5s`,
  );
  ok(
    Math.max(...idle.health) < 100,
    `DoD③ 关监听后延迟回落：/health max ${Math.max(...idle.health)}ms < 100ms`,
  );
  ok(
    manyDetail?.mode === "full" && manyDetail?.truncated === false,
    `⑥ 正常项目不被降级：300 目录项目 mode=${manyDetail?.mode} truncated=${manyDetail?.truncated}（全量递归照旧）`,
  );
  const before = readLines(path.join(manyDir, ".工作台", "changes.jsonl")).length;
  fs.writeFileSync(path.join(manyDir, "d0", "f.txt"), "after close\n");
  await sleep(1500);
  ok(
    readLines(path.join(manyDir, ".工作台", "changes.jsonl")).length === before,
    `DoD③ 关监听后不再记流水（${before} → ${readLines(path.join(manyDir, ".工作台", "changes.jsonl")).length}）`,
  );

  // ── DoD② 背压路径：收紧队列上限，让"丢弃并计数 + 日志可见"真实发生 ──
  console.log("[verify] ── DoD② 背压路径（收紧队列上限：PENDING_MAX=50 / FLUSH_BATCH=1000 / 间隔 600ms）──");
  server2 = await Server.start({
    TATAI_WATCH_PENDING_MAX: "50",
    TATAI_WATCH_FLUSH_BATCH: "1000",
    TATAI_WATCH_FLUSH_INTERVAL_MS: "600",
    TATAI_WATCH_SCAN_MAX_ENTRIES: "100", // 顺带把"条目数闸门"这一条降级路径也走一遍
    TATAI_WATCH_MAX_WATCHING_PROJECTS: "2", // 顺带把"同时在听上限"也走一遍
  });
  const capDir = path.join(tmpBase, "h4-cap");
  fs.mkdirSync(capDir, { recursive: true });
  for (let i = 0; i < 150; i++) fs.writeFileSync(path.join(capDir, `c${i}.txt`), "c\n");
  addProject({ id: "h4-cap", name: "H4 条目闸门项目", path: capDir, kind: "backend" }, dataDir);
  // 同时在听上限：连开两个可以，第三个被拒且报明确错误码；关掉一个腾出位子就又能开
  const w1 = await server2.req("POST", "/api/projects/h4-cap/watch");
  const w2 = await server2.req("POST", "/api/projects/h4-small/watch");
  await waitReady(server2, "h4-cap");
  const w3 = await server2.req("POST", "/api/projects/h4-big/watch");
  console.log(
    `[verify]   同时在听上限（收紧到 2）：第 1、2 个 → ${w1.status}/${w2.status}，第 3 个 → ${w3.status} ${JSON.stringify(w3.body.error)}`,
  );
  ok(
    w1.status === 200 && w2.status === 200 && w3.status === 400 && w3.body.error?.code === "WATCH_LIMIT_REACHED",
    `⑥ 同时在听上限生效：第 3 个项目被拒（400 WATCH_LIMIT_REACHED，不静默丢弃）`,
  );
  await server2.req("DELETE", "/api/projects/h4-small/watch");
  const w4 = await server2.req("POST", "/api/projects/h4-big/watch");
  ok(w4.status === 200, `⑥ 腾出位子后能再开：关掉一个 → 第 3 个开监听 ${w4.status}`);
  await server2.req("DELETE", "/api/projects/h4-big/watch");

  await waitReady(server2, "h4-cap");
  const capDetail = await server2.detail("h4-cap");
  ok(
    capDetail?.truncated === true && /项目条目/.test(capDetail?.truncate_reason ?? ""),
    `⑥ 条目数闸门独立生效：mode=${capDetail?.mode} 原因=${JSON.stringify(capDetail?.truncate_reason)}（上限收紧到 100，实际 150 个文件）`,
  );
  fs.writeFileSync(path.join(capDir, "c0.txt"), "cap changed\n");
  const capLines = await waitForLines(path.join(capDir, ".工作台", "changes.jsonl"), 1);
  ok(
    capLines.some((l) => l.path === "c0.txt"),
    "⑥ 条目闸门降级后仍照常记流水（不是关掉监听）",
  );
  await server2.req("DELETE", "/api/projects/h4-cap/watch");

  const storm2Dir = path.join(tmpBase, "h4-storm2");
  fs.mkdirSync(storm2Dir, { recursive: true });
  addProject({ id: "h4-storm2", name: "H4 背压项目", path: storm2Dir, kind: "backend" }, dataDir);
  const s2files: string[] = [];
  for (let i = 0; i < 300; i++) {
    const f = path.join(storm2Dir, `t${i}.txt`);
    fs.writeFileSync(f, "0\n");
    s2files.push(f);
  }
  await server2.req("POST", "/api/projects/h4-storm2/watch");
  await waitReady(server2, "h4-storm2");
  const pid2 = server2.child!.pid!;
  const rssBefore2 = rssMb(pid2);
  const t2 = Date.now();
  for (const f of s2files) fs.appendFileSync(f, "burst\n"); // 300 次写，全挤进 600ms 落盘窗口
  console.log(`[verify]   300 次修改耗时 ${Date.now() - t2}ms`);
  await sleep(6000);
  const d2 = await server2.detail("h4-storm2");
  const rssAfter2 = rssMb(pid2);
  const stderr2 = server2.stderrLines.join("");
  console.log(
    `[verify]   计数 ${JSON.stringify(d2?.stats)}；内存 ${rssBefore2.toFixed(0)}MB → ${rssAfter2.toFixed(0)}MB`,
  );
  const dropLog = stderr2.split("\n").find((l) => l.includes("待落盘队列已满"));
  console.log(`[verify]   丢弃日志原文: ${dropLog ?? "（无）"}`);
  ok(
    (d2?.stats.dropped ?? 0) > 0,
    `DoD② 队列上限真的触发丢弃：dropped=${d2?.stats.dropped}（上限 50，收紧后 300 次写挤在同一落盘窗口）`,
  );
  ok(
    (d2?.stats.written ?? 0) + (d2?.stats.dropped ?? 0) === (d2?.stats.changes ?? -1),
    `DoD② 丢弃账对得上：changes=${d2?.stats.changes} = written=${d2?.stats.written} + dropped=${d2?.stats.dropped}`,
  );
  ok(dropLog !== undefined, "DoD② 丢弃有日志可见（stderr 打出「待落盘队列已满」，不静默丢数据）");
  ok(
    rssAfter2 - rssBefore2 < 120,
    `DoD② 丢弃后内存不涨：Δ${(rssAfter2 - rssBefore2).toFixed(0)}MB < 120MB`,
  );
  const h2r = await server2.timed("/health", 8000);
  ok(h2r.ms < 100, `DoD② 洪峰中服务仍答话：/health ${h2r.ms}ms`);
  await server2.req("DELETE", "/api/projects/h4-storm2/watch");
} finally {
  await server?.stop();
  await server2?.stop();
  fs.rmSync(tmpBase, { recursive: true, force: true });
  // 真实项目的 changes.jsonl 按跑前原样还原（跑前不存在就删掉）
  if (realChangesFile) {
    if (realChangesBackup === null) fs.rmSync(realChangesFile, { force: true });
    else fs.writeFileSync(realChangesFile, realChangesBackup);
  }
}

/** 空转窗口内的延迟与 CPU 增量（DoD③ 用） */
async function srvIdle(srv: Server, ms: number): Promise<{ cpu: number; health: number[] }> {
  const pid = srv.child!.pid!;
  const c0 = cpuSec(pid);
  const health: number[] = [];
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    health.push((await srv.timed("/health", 8000)).ms);
    await sleep(500);
  }
  return { cpu: cpuSec(pid) - c0, health };
}

if (watcherErrors.length > 0) {
  console.log(
    `[verify] ② probe watcher 捕获的监听错误 ${watcherErrors.length} 条（已挂 handler，未杀进程）：${JSON.stringify(watcherErrors)}`,
  );
}
console.log(process.exitCode ? "[verify] 存在 FAIL" : "[verify] 全部 PASS");
