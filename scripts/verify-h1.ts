// H1 验证脚本（用 tsx 跑）：HTTP 全链路验证 chokidar 文件监听 + changes.jsonl（DESIGN.md §2.3.5/§3.8/§3.9）。
// 用法：pnpm verify:h1（自带临时 TATAI_HOME 与临时项目目录，不碰真实注册表；
// 例外：注册一个指向本 repo 根的 "tatai" 记录用于 CPU 观察，只挂监听不写任何文件）
// 覆盖点（PLAN.md H1 DoD 与施工图）：
//   ① 新建文件 → changes.jsonl 追加 add 行且字段符合 §2.3.5（ts 本地 ISO 带偏移 / path 相对根 / action / size_delta）
//   ② 修改同一文件 → modify 行且 size_delta 正确（贴真实行）；删除 → remove 行
//   ③ 忽略规则：node_modules/ 内造文件不产生行；改 .工作台/ 内文件不产生行（无自监听死循环）；
//      CPU 观察：对塔台自身（真实项目，含 node_modules 上千文件）挂监听 30s 采样进程 CPU（贴数值）
//   ④ 监听范围限定项目根内：根外造文件不产生行
//   ⑤ 生命周期：服务启动不自动监听（GET /api/watch 为空）；POST/DELETE 显式开/关；关后改动不再记
import { execSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { addProject } from "../src/server/registry";
import type { ChangeLine } from "../src/server/watcher";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8797;
const BASE = `http://localhost:${PORT}`;

const ok = (cond: boolean, label: string) => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (!cond) process.exitCode = 1;
};

// ── 临时数据目录与临时项目（不碰真实注册表与真实项目）──
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-h1-verify-"));
const dataDir = path.join(tmpBase, "home");
const projDir = path.join(tmpBase, "h1-proj");
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(path.join(projDir, "src"), { recursive: true });
fs.mkdirSync(path.join(projDir, "node_modules", "pkg"), { recursive: true });
fs.mkdirSync(path.join(projDir, ".工作台"), { recursive: true });
addProject({ id: "h1-proj", name: "H1 验证项目", path: projDir, kind: "backend" }, dataDir);
// CPU 观察对象：塔台自身（真实项目，node_modules 上千文件——忽略规则的真考场）
addProject(
  { id: "tatai", name: "塔台", path: REPO_ROOT, kind: "fullstack", self_managed: true },
  dataDir,
);

const changesFile = path.join(projDir, ".工作台", "changes.jsonl");
const tataiChangesFile = path.join(REPO_ROOT, ".工作台", "changes.jsonl");
const tataiChangesExistedBefore = fs.existsSync(tataiChangesFile);

function readLines(file: string): ChangeLine[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter((s) => s.trim() !== "")
    .map((s) => JSON.parse(s) as ChangeLine);
}

/** 轮询等流水行数达到 min（chokidar 事件 + awaitWriteFinish 防抖是异步的，断言必须等） */
async function waitForLines(file: string, min: number, timeoutMs = 10000): Promise<ChangeLine[]> {
  const t0 = Date.now();
  for (;;) {
    const lines = readLines(file);
    if (lines.length >= min) return lines;
    if (Date.now() - t0 > timeoutMs) {
      throw new Error(`等待超时：${file} 行数=${lines.length}，期望≥${min}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitUp(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) {
        upPorts.add(PORT);
        return;
      }
    } catch {
      // 还没起来，继续等
    }
    await sleep(200);
  }
  throw new Error("后端 10 秒内未就绪");
}

// ── 端口冲突快速失败（2026-09-18 加）────────────────────────────────
// 端口被残留服务 / 并行会话占用时，子进程 EADDRINUSE 会静默死掉，而 waitUp 会打到占用者身上，
// 导致后续莫名 404 崩溃或对错误数据假通过。这里：起前探端口 → 起后盯早退。
const upPorts = new Set<number>();

function portListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: "127.0.0.1" });
    const done = (busy: boolean) => {
      sock.destroy();
      resolve(busy);
    };
    sock.once("connect", () => done(true)); // 有人监听 = 端口被占
    sock.once("error", () => done(false)); // 拒绝连接 = 端口空闲
    sock.setTimeout(1000, () => done(false));
  });
}

/** 起前预探测：端口已被占用立刻报错退出，不拿别人的服务跑验证 */
async function assertPortFree(port: number): Promise<void> {
  if (await portListening(port)) {
    console.error(`[verify] 后端起不来：端口 ${port} 被占用，先清理残留进程`);
    process.exit(1);
  }
}

/** 起后盯早退：子进程在就绪前退出（典型 EADDRINUSE）立即报错退出，不再继续验证 */
function watchChild(proc: ChildProcess, port: number, isUp: () => boolean): void {
  proc.once("exit", async (code) => {
    if (isUp()) return; // 脚本自己收尾杀的，不算异常
    const why = (await portListening(port))
      ? `端口 ${port} 被占用`
      : `后端进程提前退出（code=${code}）`;
    console.error(`[verify] 后端起不来：${why}，先清理残留进程`);
    process.exit(1);
  });
}

interface ApiResp {
  status: number;
  body: {
    ok?: boolean;
    watch?: { watching: boolean; already: boolean };
    watching?: string[];
    removed?: boolean;
    changes?: ChangeLine[];
    error?: { code: string; message: string };
  };
}

async function http(method: string, rawPath: string): Promise<ApiResp> {
  const res = await fetch(`${BASE}${rawPath}`, { method });
  return { status: res.status, body: (await res.json()) as ApiResp["body"] };
}

/** PowerShell 采样进程 CPU（累计 CPU 秒数）；pid 不存在返回 NaN */
function readCpuSeconds(pid: number): number {
  const out = execSync(
    `powershell -NoProfile -Command "(Get-Process -Id ${pid}).CPU"`,
  )
    .toString()
    .trim();
  return Number(out);
}

const ISO_LOCAL_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/;

let child: ChildProcess | undefined;
try {
  await assertPortFree(PORT); // 端口已被占：立刻失败，不拿占用者的服务跑验证
  const proc = spawn(
    process.execPath,
    ["--import", "tsx", path.join("src", "server", "index.ts")],
    {
      env: { ...process.env, TATAI_HOME: dataDir, TATAI_PORT: String(PORT) },
      stdio: ["ignore", "pipe", "pipe"],
      cwd: REPO_ROOT,
    },
  );
  child = proc;
  proc.stderr?.on("data", (d: Buffer) => process.stderr.write(`[server] ${d}`));
  watchChild(proc, PORT, () => upPorts.has(PORT)); // 子进程早退（EADDRINUSE）立刻报错退出
  await waitUp();
  console.log(`[verify] server up at ${BASE}（TATAI_HOME=${dataDir}）`);

  // ── ⑤ 生命周期：启动后不自动监听任何项目 ──
  const w0 = await http("GET", "/api/watch");
  ok(
    w0.status === 200 && Array.isArray(w0.body.watching) && w0.body.watching.length === 0,
    `⑤ 服务启动后 GET /api/watch 为空（不自动监听，实际: ${JSON.stringify(w0.body.watching)}）`,
  );

  // ── 开监听（幂等性也一起验）──
  const w1 = await http("POST", "/api/projects/h1-proj/watch");
  ok(
    w1.status === 200 && w1.body.watch?.watching === true && w1.body.watch?.already === false,
    `POST watch 首开 → watching:true already:false（实际: ${JSON.stringify(w1.body.watch)}）`,
  );
  const w2 = await http("POST", "/api/projects/h1-proj/watch");
  ok(
    w2.status === 200 && w2.body.watch?.already === true,
    "POST watch 重复开 → already:true（幂等）",
  );
  const wList = await http("GET", "/api/watch");
  ok(
    Array.isArray(wList.body.watching) && wList.body.watching.includes("h1-proj"),
    `GET /api/watch 含 h1-proj（实际: ${JSON.stringify(wList.body.watching)}）`,
  );
  const wBad = await http("POST", "/api/projects/nosuchproj/watch");
  ok(
    wBad.status === 404 && wBad.body.error?.code === "PROJECT_NOT_FOUND",
    "伪造 id 开监听 → 404 PROJECT_NOT_FOUND（路径只走注册表）",
  );

  // 等初始扫描 ready（临时项目只有 3 个空目录，扫描是即时的；等 2s 留足 awf 余量）
  await sleep(2000);

  // ── ① 新建文件 → add 行，字段符合 §2.3.5 ──
  console.log("[verify] ── ① 新建文件 → add 行 ──");
  const contentA = "hello h1"; // 8 字节
  fs.writeFileSync(path.join(projDir, "a.txt"), contentA, "utf8");
  const lines1 = await waitForLines(changesFile, 1);
  const addLine = lines1[lines1.length - 1];
  console.log(`[verify]   真实行: ${JSON.stringify(addLine)}`);
  ok(addLine.action === "add", `① action=add（实际: ${addLine.action}）`);
  ok(addLine.path === "a.txt", `① path 为项目根相对路径（实际: ${addLine.path}）`);
  ok(ISO_LOCAL_RE.test(addLine.ts), `① ts 为本地 ISO 带偏移（实际: ${addLine.ts}）`);
  ok(
    addLine.size_delta === Buffer.byteLength(contentA),
    `① add 的 size_delta = 文件大小 ${Buffer.byteLength(contentA)}（实际: ${addLine.size_delta}）`,
  );

  // ── ② 修改同一文件 → modify 行，size_delta 正确 ──
  console.log("[verify] ── ② 修改文件 → modify 行 ──");
  const append = "++append"; // +8 字节
  fs.appendFileSync(path.join(projDir, "a.txt"), append, "utf8");
  const lines2 = await waitForLines(changesFile, 2);
  const modifyLine = lines2[lines2.length - 1];
  console.log(`[verify]   真实行: ${JSON.stringify(modifyLine)}`);
  ok(
    modifyLine.action === "modify" && modifyLine.path === "a.txt",
    `② action=modify（实际: ${modifyLine.action}）`,
  );
  ok(
    modifyLine.size_delta === Buffer.byteLength(append),
    `② modify 的 size_delta = +${Buffer.byteLength(append)}（实际: ${modifyLine.size_delta}）`,
  );

  // ── ② 删除文件 → remove 行（add/modify 之外的补充）──
  fs.unlinkSync(path.join(projDir, "a.txt"));
  const lines3 = await waitForLines(changesFile, 3);
  const removeLine = lines3[lines3.length - 1];
  console.log(`[verify]   真实行: ${JSON.stringify(removeLine)}`);
  ok(
    removeLine.action === "remove" &&
      removeLine.path === "a.txt" &&
      removeLine.size_delta === -(Buffer.byteLength(contentA) + Buffer.byteLength(append)),
    `② action=remove 且 size_delta 为 -旧大小（实际: ${JSON.stringify(removeLine)}）`,
  );

  // ── ③ 忽略规则：node_modules/ 内造文件 → 不产生行 ──
  console.log("[verify] ── ③ 忽略规则（node_modules / .工作台 自监听 / 根外）──");
  const countBefore = readLines(changesFile).length;
  fs.writeFileSync(path.join(projDir, "node_modules", "pkg", "x.js"), "module.exports=1;", "utf8");
  fs.writeFileSync(path.join(projDir, ".工作台", "probe.txt"), "直改 .工作台 内文件", "utf8");
  fs.writeFileSync(path.join(tmpBase, "outside.txt"), "项目根外的文件", "utf8"); // ④ 根外
  await sleep(2500); // awf 300ms + poll 100ms + 事件延迟，留足余量再断言"没有新增"
  const countAfter = readLines(changesFile).length;
  ok(
    countAfter === countBefore,
    `③ node_modules/ 内造文件 + 直改 .工作台/ 内文件 + ④ 根外造文件 → 流水零新增（${countBefore} → ${countAfter}）`,
  );

  // 自监听死循环专项检查：流水自身追加不会触发新事件，连续观察 3s 行数必须纹丝不动
  const c1 = readLines(changesFile).length;
  await sleep(1500);
  const c2 = readLines(changesFile).length;
  await sleep(1500);
  const c3 = readLines(changesFile).length;
  ok(
    c1 === c2 && c2 === c3,
    `③ 无自监听死循环：changes.jsonl 3s 内行数稳定（${c1} → ${c2} → ${c3}）`,
  );

  // ── GET changes?limit=N：倒序 + 截断 ──
  const ch = await http("GET", "/api/projects/h1-proj/changes?limit=2");
  ok(
    ch.status === 200 &&
      Array.isArray(ch.body.changes) &&
      ch.body.changes.length === 2 &&
      ch.body.changes[0].action === "remove" &&
      ch.body.changes[1].action === "modify",
    `GET changes?limit=2 → 倒序最新在前（实际: ${JSON.stringify(ch.body.changes?.map((l) => l.action))}）`,
  );
  const chBad = await http("GET", "/api/projects/h1-proj/changes?limit=-1");
  ok(
    chBad.status === 400 && chBad.body.error?.code === "INVALID_INPUT",
    "GET changes?limit=-1 → 400 INVALID_INPUT",
  );

  // ── ③ CPU 观察：对塔台自身（真实项目）挂监听，30s 采样 ──
  console.log("[verify] ── ③ CPU 观察（塔台自身，含 node_modules 上千文件）──");
  const wt = await http("POST", "/api/projects/tatai/watch");
  ok(wt.status === 200 && wt.body.watch?.watching === true, "POST watch tatai → 200");
  await sleep(3000); // 等初始扫描（含忽略规则剪枝 node_modules）完成，进入稳态
  const pid = proc.pid!;
  const cpuStart = readCpuSeconds(pid);
  const samples: number[] = [];
  const cpuT0 = Date.now();
  for (let i = 0; i < 10; i++) {
    await sleep(3000);
    samples.push(readCpuSeconds(pid));
  }
  const cpuEnd = samples[samples.length - 1];
  const wallSec = (Date.now() - cpuT0) / 1000;
  const cpuDelta = cpuEnd - cpuStart;
  console.log(`[verify]   采样起点 CPU=${cpuStart.toFixed(2)}s；30s 内逐点: ${samples.map((s) => s.toFixed(2)).join(", ")}`);
  console.log(
    `[verify]   30s 稳态 CPU 增量 ${cpuDelta.toFixed(2)}s / 墙钟 ${wallSec.toFixed(0)}s ≈ 平均 ${((cpuDelta / wallSec) * 100).toFixed(1)}%（单核口径）`,
  );
  ok(
    cpuDelta < 3,
    `③ 稳态 CPU 不失控：30s 增量 ${cpuDelta.toFixed(2)}s < 3s（即平均 <10% 单核，§12.2 风险 3）`,
  );
  const wtOff = await http("DELETE", "/api/projects/tatai/watch");
  ok(wtOff.status === 200 && wtOff.body.removed === true, "DELETE watch tatai → removed:true");
  ok(
    fs.existsSync(tataiChangesFile) === tataiChangesExistedBefore,
    "③ CPU 观察期间塔台 repo 未被监听写入（稳态无事件即零写入）",
  );

  // ── ⑤ 关监听后改动不再记 ──
  const dw = await http("DELETE", "/api/projects/h1-proj/watch");
  ok(dw.status === 200 && dw.body.removed === true, "DELETE watch → removed:true");
  const dw2 = await http("DELETE", "/api/projects/h1-proj/watch");
  ok(dw2.status === 200 && dw2.body.removed === false, "DELETE watch 重复关 → removed:false（幂等）");
  const countBeforeClose = readLines(changesFile).length;
  fs.writeFileSync(path.join(projDir, "after-close.txt"), "关监听后的改动", "utf8");
  await sleep(2000);
  ok(
    readLines(changesFile).length === countBeforeClose,
    "⑤ 关监听后改动不再记流水（生命周期闭环）",
  );
  const wEnd = await http("GET", "/api/watch");
  ok(
    Array.isArray(wEnd.body.watching) && wEnd.body.watching.length === 0,
    `⑤ 全部关闭后 GET /api/watch 为空（实际: ${JSON.stringify(wEnd.body.watching)}）`,
  );
} finally {
  child?.kill();
  fs.rmSync(tmpBase, { recursive: true, force: true });
  // CPU 观察若在塔台 repo 留下 changes.jsonl（验证前不存在的），清掉，保持 repo 干净
  if (!tataiChangesExistedBefore && fs.existsSync(tataiChangesFile)) {
    fs.rmSync(tataiChangesFile, { force: true });
  }
}

console.log(process.exitCode ? "[verify] 存在 FAIL" : "[verify] 全部 PASS");
