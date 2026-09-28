// T19 全量解析入口（POST /arch/parse）后台可取消形态回归（R20260920-1 修复批 3，PLAN 契约对齐表 T19 行，
// 判词口径 .工作台/audit/R20260920-1/06-审计包/T19-全量扫描入口适用性.md，合同原文 DESIGN.md §11.8 末段）。
// 用法：node --import tsx scripts/verify-t19-parse-run.ts（或 pnpm verify:t19-parse-run）
//
// 合同（§11.8 末段，权威原文）逐条 → 本脚本后端可证部分：
//   ① 后台可取消、前台保持响应（"同步接口"不构成豁免）
//      → 函数级：解析分片让出事件循环、检查点注入取消在确定位置停手（B/C 段，不靠 sleep 竞态）；
//      → HTTP 级：run 进行中 GET /health、GET /api/projects、GET arch/modules（旧结果）全部可响应、
//        SSE /events 首帧 hello 及时到达（H2 段，旧红实测：/health 最大延迟 3431ms、SSE 首帧 2963ms）。
//   ② 进行中 UI/health/SSE 可响应 + GET 可见 run 状态与进度
//      → H1（GET arch/parse 轮询可见 running + progress）、H2（health/轻端点/SSE）；UI 部分由
//        verify-t19-parse-run-ui.py 覆盖。
//   ③ 取消只来自显式动作：客户端断连/SSE 断线/切项目 ≠ 取消，重连可续看进度
//      → H5：杀掉等待中的 POST 连接（fetch abort）后 run 不终止、GET 续看直到 done、完整结果照常发布；
//      → H6：进行中重复 POST 单飞去重（deduplicated，挂到同一 run，不另起）。
//   ④ 显式取消不发布半成品：保留上次有效结果并标明未完成原因
//      → B/C/D（函数级：取消/失败不落盘，哨兵 modules.json 逐字节不变）；
//      → H3：DELETE 回执形状（cancelled/run_id/progress/partial/note）＋ POST 只回取消回执不下发部分结果
//        ＋ run 终态 cancelled 带进度与 finished_at＋上次有效 modules.json 逐字节不变。
//   ⑤ 取消后可重试
//      → E（失败后可再跑）、H4（取消后重跑 done 并完整发布）、H5 收尾（断连续跑 done）。
//   ⑥ 同步有界读仅限明确标注部分/预览且显示省略量
//      → 本入口已后台化，不适用；按范围下钻（arch/expand 子级截断「还有 N 个」聚合标注）属既有
//        verify-a4/f2 的口径，本脚本不重复断言（登记口径，不冒充新证据）。
//
// 隔离与清理：夹具一律建在 os.tmpdir() 下的临时目录，跑完即删；注册表与解析产物全落在临时 home 的
// 临时项目里，不读不写用户真实 TATAI_HOME 与任何纳管项目；DEEPSEEK_API_KEY 置空，不调任何模型网关。
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  getParseRunStatus,
  requestParseCancel,
  startParseProjectRun,
  type ParseCancelReceipt,
  type ParseRun,
  type ParseRunProgress,
} from "../src/arch/parse";
import { addProject } from "../src/server/registry";
import { WsError } from "../src/server/workstation";

let pass = 0;
let fail = 0;
const ok = (cond: boolean, label: string) => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (cond) pass += 1;
  else {
    fail += 1;
    process.exitCode = 1;
  }
};
const info = (msg: string): void => console.log(`[verify]   ${msg}`);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");

// 起过的服务子进程都记下来，脚本异常退出时兜底杀掉（Windows 上父进程被强杀不会带走子进程树）
const spawnedServers: ChildProcess[] = [];
process.on("exit", () => {
  for (const proc of spawnedServers) {
    try {
      if (proc.exitCode === null) proc.kill("SIGKILL");
    } catch {
      // 进程已经没了：忽略
    }
  }
});

// 临时数据目录（不碰真实 TATAI_HOME 与真实项目）
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-t19-parse-run-"));
console.log(`[verify] 临时夹具根：${tmpBase}`);

interface Fixture {
  id: string;
  home: string;
  root: string;
  modulesFile: string;
  sourceFiles: number;
}

/** 带 import 的源码（让 tree-sitter 真干活；pad 行把单文件解析耗时垫到可观测量级） */
function makeSource(d: number, f: number): string {
  const lines: string[] = [
    `import { v0 } from "./f0";`,
    `export const v${f} = v0 + ${f};`,
    `export function fn${f}(x: number): number {`,
    `  const a = x * ${f};`,
    `  return a + v0;`,
    `}`,
  ];
  for (let i = 0; i < 24; i++) lines.push(`export const pad${i} = ${d * 1000 + f * 100 + i};`);
  return lines.join("\n") + "\n";
}

/**
 * 造一个隔离项目：多目录多 .ts 文件；`sentinel` = 预置"上次完整落盘"的 modules.json
 * （取消/失败不得写它半截、也不得删它）。`opts.home` 复用已有 home（HTTP 段一个后端看多个项目）。
 */
function makeProject(
  id: string,
  opts: { home?: string; dirs: number; filesPerDir: number; sentinel?: boolean },
): Fixture {
  const home = opts.home ?? path.join(tmpBase, `home-${id}`);
  const root = path.join(tmpBase, `proj-${id}`);
  fs.mkdirSync(root, { recursive: true });
  for (let d = 0; d < opts.dirs; d++) {
    const dir = path.join(root, `d${String(d).padStart(2, "0")}`);
    fs.mkdirSync(dir, { recursive: true });
    for (let f = 0; f < opts.filesPerDir; f++) {
      fs.writeFileSync(path.join(dir, `f${f}.ts`), makeSource(d, f));
    }
  }
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: id }));
  fs.writeFileSync(path.join(root, "README.md"), `# ${id} 夹具\n`);
  fs.mkdirSync(home, { recursive: true });
  addProject({ id, name: id, path: root, kind: "backend" }, home);
  const archDir = path.join(root, ".工作台", "arch");
  const modulesFile = path.join(archDir, "modules.json");
  if (opts.sentinel === true) {
    // 上次完整落盘状态（哨兵）：内容是伪造但形状合法的旧解析产物，取消后必须逐字节还是它
    fs.mkdirSync(archDir, { recursive: true });
    fs.writeFileSync(
      modulesFile,
      JSON.stringify({
        version: 1,
        generated_at: "2026-09-20T00:00:00.000Z",
        modules: [{ id: "sentinel-old", name: "上次完整结果", path: ".", file_count: 1, loc: 1, deps: [] }],
        budget_exhausted: false,
      }),
      "utf8",
    );
  }
  return { id, home, root, modulesFile, sourceFiles: opts.dirs * opts.filesPerDir };
}

const fileBytes = (p: string): Buffer => (fs.existsSync(p) ? fs.readFileSync(p) : Buffer.alloc(0));

// ══════════ A：基准——无取消时后台 run 跑完并完整发布（函数级） ══════════
console.log("\n[verify] ── A 基准：后台 run 跑完、结果完整落盘（建立比对基线）");
const fxA = makeProject("t19a", { dirs: 4, filesPerDir: 5 });
const aCheckpoints: ParseRunProgress[] = [];
const handleA = startParseProjectRun(fxA.id, fxA.home, {
  onCheckpoint: (p) => aCheckpoints.push({ ...p }),
});
ok(handleA.deduplicated === false && handleA.run.status === "running", "A 启动新 run（deduplicated=false、初始 running）");
const runA = await handleA.done;
const aModulesOnDisk = JSON.parse(fileBytes(fxA.modulesFile).toString("utf8")) as { modules: unknown[] };
ok(runA.status === "done" && runA.result !== null, `A 终态 done（status=${runA.status}）`);
ok(
  runA.result !== null && runA.result.stats.source_files === fxA.sourceFiles && runA.result.module_count >= 4,
  `A 结果完整（source_files=${runA.result?.stats.source_files}=${fxA.sourceFiles}、module_count=${runA.result?.module_count} ≥ 4）`,
);
ok(
  runA.progress.parsed_files === fxA.sourceFiles && runA.progress.phase === "parsing",
  `A 进度记到终态（parsed_files=${runA.progress.parsed_files}=${fxA.sourceFiles}）`,
);
ok(aModulesOnDisk.modules.length >= 4, `A modules.json 真实落盘（${aModulesOnDisk.modules.length} 个模块 ≥ 4 目录）`);
ok(aCheckpoints.length >= 1, `A 解析过程有安全检查点观测（${aCheckpoints.length} 个）`);
ok(
  getParseRunStatus(fxA.id, fxA.home)?.id === runA.id && getParseRunStatus(fxA.id, fxA.home)?.status === "done",
  "A 终态 run 可经 getParseRunStatus 查到（同 id、done）",
);

// ══════════ B：①实际停止——确定性检查点注入取消（shouldCancel，不靠 sleep） ══════════
console.log("\n[verify] ── B ①④：检查点注入取消 → 确定位置停手、部分结果不落盘");
const fxB = makeProject("t19b", { dirs: 2, filesPerDir: 100, sentinel: true });
const bSentinel = fileBytes(fxB.modulesFile);
const CANCEL_PARSED_AT = 32; // 解析到 32 个文件后的下一个检查点命中取消（总 200，必然提前停手）
const bCheckpoints: ParseRunProgress[] = [];
const runB = await startParseProjectRun(fxB.id, fxB.home, {
  onCheckpoint: (p) => bCheckpoints.push({ ...p }),
  shouldCancel: (p) => p.phase === "parsing" && p.parsed_files >= CANCEL_PARSED_AT,
}).done;
const bStop = bCheckpoints.at(-1);
info(
  `B 取消：status=${runB.status}、停在 parsed_files=${runB.progress.parsed_files}/${fxB.sourceFiles}、检查点 ${bCheckpoints.length} 个`,
);
ok(runB.status === "cancelled" && runB.result === null, "B ① 命中取消检查点后 run 如实 cancelled（无结果）");
ok(
  bStop !== undefined && bStop.parsed_files >= CANCEL_PARSED_AT && bStop.parsed_files < fxB.sourceFiles,
  `B ① 确实提前停手（停在 parsed_files=${bStop?.parsed_files}，∈ [${CANCEL_PARSED_AT}, ${fxB.sourceFiles})）`,
);
ok(
  runB.progress.parsed_files === bStop?.parsed_files && bCheckpoints.every((p) => p.parsed_files <= (bStop?.parsed_files ?? -1)),
  `B ① 取消后解析计数不再增长：所有检查点 parsed_files ≤ 停点 ${bStop?.parsed_files}，无越过取消点的后续检查点`,
);
ok(
  bCheckpoints.some((p) => p.phase === "walking") && bCheckpoints.some((p) => p.phase === "parsing"),
  "B ① 遍历与解析两阶段都有安全检查点（取消在两阶段都可生效）",
);
ok(
  fileBytes(fxB.modulesFile).equals(bSentinel),
  "B ④ 取消不落盘：上次完整 modules.json（哨兵）逐字节不变、部分结果已丢弃",
);

// ══════════ C：①——遍历/解析中排队的取消回调被服务（requestParseCancel 走登记表，非 shouldCancel 注入） ══════════
console.log("\n[verify] ── C ①④：首个解析检查点 setImmediate 排队取消（与 HTTP DELETE 同一入口函数）");
const fxC = makeProject("t19c", { dirs: 2, filesPerDir: 100, sentinel: true });
const cSentinel = fileBytes(fxC.modulesFile);
let cQueued = false;
let cCallbackBeforeCompletion: boolean | null = null;
let cCompleted = false;
const cReceiptBox: { value: ParseCancelReceipt | null } = { value: null };
const runC = await startParseProjectRun(fxC.id, fxC.home, {
  onCheckpoint: (p) => {
    if (cQueued || p.phase !== "parsing") return;
    cQueued = true;
    // 首个**解析**检查点把取消排进事件循环（不是 shouldCancel 注入）：只有解析真的协作式让出，
    // 这个回调才可能在解析**中**执行
    setImmediate(() => {
      cCallbackBeforeCompletion = !cCompleted;
      cReceiptBox.value = requestParseCancel(fxC.id, fxC.home);
    });
  },
}).done;
cCompleted = true;
const cR = cReceiptBox.value;
info(`C 取消：status=${runC.status}、停在 parsed_files=${runC.progress.parsed_files}/${fxC.sourceFiles}、回执=${JSON.stringify(cR)}`);
ok(runC.status === "cancelled" && cR?.cancelled === true, "C ① 排队的取消回调被服务：run cancelled、回执 cancelled=true");
ok(
  cCallbackBeforeCompletion === true,
  `C ① 取消回调**先于解析完成**执行（回调内观测到 run 未完成＝${cCallbackBeforeCompletion}）`,
);
ok(
  cR !== null && cR.run_id !== null && cR.progress !== null && cR.partial === true && cR.note.includes("部分结果不写入"),
  `C ④ 取消回执形状齐全（run_id=${cR?.run_id?.slice(0, 8)}…、progress=${JSON.stringify(cR?.progress)}、partial=${cR?.partial}）`,
);
ok(
  cR !== null && cR.note.includes("沿用上次完整落盘状态"),
  `C ④ 回执写明未完成原因与旧结果口径：${cR?.note ?? "（无）"}`,
);
ok(fileBytes(fxC.modulesFile).equals(cSentinel), "C ④ 取消后哨兵 modules.json 逐字节不变");

// ══════════ D：③单飞——进行中重复启动挂到同一 run，不另起（旧 run 覆盖新结果结构上不可能） ══════════
console.log("\n[verify] ── D ③：单飞去重（进行中重复启动 = 挂上同一 run）");
const fxD = makeProject("t19d", { dirs: 2, filesPerDir: 60 });
const handleD1 = startParseProjectRun(fxD.id, fxD.home);
let handleD2: { run: ParseRun; deduplicated: boolean } | null = null;
// 等 run 确实登记进活动表（下一个事件循环轮次）后再重复启动——不依赖解析耗时
await new Promise<void>((resolve) => setImmediate(resolve));
handleD2 = startParseProjectRun(fxD.id, fxD.home);
const runD1 = await handleD1.done;
ok(
  handleD2.deduplicated === true && handleD2.run.id === handleD1.run.id,
  `D ③ 进行中重复启动 → deduplicated=true、同一 run_id（${handleD1.run.id.slice(0, 8)}…）`,
);
ok(runD1.status === "done", `D 单飞 run 正常跑完（status=${runD1.status}）`);
const dIdle = requestParseCancel(fxD.id, fxD.home);
ok(
  dIdle.cancelled === false && dIdle.run_id === null && dIdle.progress === null && dIdle.note.includes("没有进行中的解析"),
  `D ⑤ 终态后登记表清干净：取消回诚实回执 cancelled=false（note=${dIdle.note}）`,
);

// ══════════ E：④失败不落盘 + ⑤失败后可重试（异常路径 finally 清理） ══════════
console.log("\n[verify] ── E ④⑤：onCheckpoint 抛错 → failed 不落盘、可再跑");
const fxE = makeProject("t19e", { dirs: 2, filesPerDir: 40, sentinel: true });
const eSentinel = fileBytes(fxE.modulesFile);
let eCp = 0;
const runE = await startParseProjectRun(fxE.id, fxE.home, {
  onCheckpoint: () => {
    eCp += 1;
    if (eCp === 3) throw new Error("夹具：检查点第 3 次故意抛错");
  },
}).done;
ok(
  runE.status === "failed" && runE.result === null && (runE.error ?? "").includes("故意抛错"),
  `E ④ 检查点抛错 → run failed 且错误如实带回（error_code=${runE.error_code}、error=${runE.error}）`,
);
ok(fileBytes(fxE.modulesFile).equals(eSentinel), "E ④ 失败不落盘：哨兵 modules.json 逐字节不变");
ok(
  getParseRunStatus(fxE.id, fxE.home)?.status === "failed",
  "E 失败 run 留档可查（getParseRunStatus 返回最近一次 failed）",
);
const runE2 = await startParseProjectRun(fxE.id, fxE.home).done;
ok(runE2.status === "done", `E ⑤ 失败后可重试：再跑 done（不留脏标记/死锁）`);

// ══════════ F：诚实边界——无 run 可查/无进行中可取消/项目不存在 ══════════
console.log("\n[verify] ── F：诚实边界（空态不冒充）");
const fxF = makeProject("t19f", { dirs: 1, filesPerDir: 2 });
ok(getParseRunStatus(fxF.id, fxF.home) === null, "F 从未解析的项目：getParseRunStatus → null（不伪造 run）");
const fIdle = requestParseCancel(fxF.id, fxF.home);
ok(
  fIdle.cancelled === false && fIdle.partial === false && fIdle.note.includes("没有进行中的解析"),
  `F 无进行中解析时取消 → 诚实回执 cancelled=false（不报错）：${fIdle.note}`,
);
const notFound = (fn: () => unknown): string => {
  try {
    fn();
    return "(没有抛错)";
  } catch (e) {
    return e instanceof WsError ? e.code : `(非 WsError: ${(e as Error).message})`;
  }
};
ok(
  notFound(() => startParseProjectRun("no-such-project-xyz", fxF.home)) === "PROJECT_NOT_FOUND",
  "F 不存在的项目 startParseProjectRun → PROJECT_NOT_FOUND",
);
ok(
  notFound(() => requestParseCancel("no-such-project-xyz", fxF.home)) === "PROJECT_NOT_FOUND",
  "F 不存在的项目 requestParseCancel → PROJECT_NOT_FOUND",
);
ok(
  notFound(() => getParseRunStatus("no-such-project-xyz", fxF.home)) === "PROJECT_NOT_FOUND",
  "F 不存在的项目 getParseRunStatus → PROJECT_NOT_FOUND",
);

// ══════════ HTTP 集成：真起后端 + 真 HTTP（合同 ①②③④⑤ 的服务端形态） ══════════
console.log("\n[verify] ── HTTP 集成段（真后端进程）");

interface Backend {
  proc: ChildProcess;
  port: number;
}
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}
async function httpJson(
  port: number,
  method: string,
  urlPath: string,
  timeoutMs = 60_000,
): Promise<{ status: number; ms: number; json: Record<string, unknown> }> {
  const t0 = Date.now();
  const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  return { status: res.status, ms: Date.now() - t0, json };
}
async function startBackend(home: string): Promise<Backend> {
  const port = await freePort();
  const logPath = path.join(tmpBase, `backend-${port}.log`);
  const proc = spawn("node", ["--import", "tsx", path.join("src", "server", "index.ts")], {
    cwd: REPO,
    env: { ...process.env, TATAI_HOME: home, TATAI_PORT: String(port), DEEPSEEK_API_KEY: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  spawnedServers.push(proc);
  const chunks: string[] = [];
  proc.stdout?.on("data", (c: Buffer) => chunks.push(c.toString("utf8")));
  proc.stderr?.on("data", (c: Buffer) => chunks.push(c.toString("utf8")));
  const deadline = Date.now() + 90_000;
  for (;;) {
    if (proc.exitCode !== null) {
      fs.writeFileSync(logPath, chunks.join(""), "utf8");
      throw new Error(`后端进程提前退出（exit ${proc.exitCode}），日志见 ${logPath}`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) break;
    } catch {
      // 还没起来
    }
    if (Date.now() > deadline) {
      fs.writeFileSync(logPath, chunks.join(""), "utf8");
      throw new Error(`后端 ${port} 未在 90s 内就绪，日志见 ${logPath}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return { proc, port };
}

/** 轮询 GET run 状态直到满足条件（或超时返回最后一次）；这是"重连续看"的同一通道 */
async function pollRun(
  port: number,
  projectId: string,
  until: (run: ParseRun | null) => boolean,
  timeoutMs = 30_000,
): Promise<ParseRun | null> {
  const deadline = Date.now() + timeoutMs;
  let last: ParseRun | null = null;
  for (;;) {
    const r = await httpJson(port, "GET", `/api/projects/${projectId}/arch/parse`);
    last = (r.json.run as ParseRun | null) ?? null;
    if (until(last)) return last;
    if (Date.now() > deadline) return last;
    await new Promise((r2) => setTimeout(r2, 30));
  }
}

// HTTP 大夹具：12 目录 × 300 文件 = 3600 个带 import 的 .ts——解析耗时长到足够从另一个请求
// 观测/取消（与 verify-scan-cancel 大夹具同一思路；哨兵 = 上次完整落盘，取消不得动它）。
// 目录数刻意 ≤ MAX_MODULES(15)：顶层模块不触发"其他"聚合桶，模块数断言才钉得死。
const BIG_DIRS = 12;
const BIG_FILES_PER_DIR = 300;
const fxHttp = makeProject("t19http", { dirs: BIG_DIRS, filesPerDir: BIG_FILES_PER_DIR, sentinel: true });
const fxHttp2 = makeProject("t19http2", { home: fxHttp.home, dirs: 2, filesPerDir: 3 });
const sentinelBytes = fileBytes(fxHttp.modulesFile);

let backend: Backend | null = null;
try {
  backend = await startBackend(fxHttp.home);
  const port = backend.port;
  info(`后端就绪：127.0.0.1:${port}`);

  // ── H0：HTTP 空态诚实（无 run / 无进行中取消 / 假 id 404）──
  const h0get = await httpJson(port, "GET", `/api/projects/${fxHttp2.id}/arch/parse`);
  ok(
    h0get.status === 200 && h0get.json.ok === true && h0get.json.run === null,
    `HTTP F 从未解析的项目 GET run → null（${h0get.status}）`,
  );
  const h0del = await httpJson(port, "DELETE", `/api/projects/${fxHttp2.id}/arch/parse`);
  ok(
    h0del.status === 200 && h0del.json.cancelled === false && typeof h0del.json.note === "string",
    `HTTP F 无进行中解析 DELETE → 诚实回执 cancelled=false（note=${String(h0del.json.note)}）`,
  );
  const h0post = await httpJson(port, "POST", `/api/projects/no-such/arch/parse`);
  ok(h0post.status === 404, `HTTP F 伪造项目 id POST → 404（实际 ${h0post.status}）`);

  // ── H1/H2：POST 启动 → GET 可见 running＋进度；进行中 health/轻端点/旧结果/SSE 全部可响应（①②） ──
  console.log("\n[verify] ── H1/H2 ①②：run 进行中前台可响应＋GET 可见进度");
  let post1Settled = false;
  const post1P = httpJson(port, "POST", `/api/projects/${fxHttp.id}/arch/parse`).then((r) => {
    post1Settled = true;
    return r;
  });
  const running1 = await pollRun(port, fxHttp.id, (r) => r?.status === "running", 15_000);
  ok(
    running1 !== null && running1.status === "running" && typeof running1.id === "string",
    `HTTP ② POST 后 GET 可见进行中 run（run_id=${running1?.id.slice(0, 8)}…、status=${running1?.status}）`,
  );
  ok(
    running1 !== null &&
      (running1.progress.phase === "walking" || running1.progress.phase === "parsing") &&
      typeof running1.progress.walked_files === "number" &&
      typeof running1.progress.parsed_files === "number",
    `HTTP ② 进行中 run 带进度现场（progress=${JSON.stringify(running1?.progress)}）`,
  );
  const run1Id = running1?.id ?? "";
  // 趁 run 进行中：连打前台端点，全部必须在 run 完成前响应（旧红：事件循环被同步解析冻结 ~3s）
  const healthDuring = await httpJson(port, "GET", "/health", 10_000);
  const projectsDuring = await httpJson(port, "GET", "/api/projects", 10_000);
  const modulesDuring = await httpJson(port, "GET", `/api/projects/${fxHttp.id}/arch/modules`, 10_000);
  // SSE 首帧（hello）：run 进行中必须及时到达（旧红：首帧延迟 2963ms）
  let sseHelloMs = -1;
  let sseHelloOk = false;
  {
    const t0 = Date.now();
    const ac = new AbortController();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/projects/${fxHttp.id}/events`, { signal: ac.signal });
      const reader = res.body?.getReader();
      const first = await Promise.race([
        reader?.read(),
        new Promise<undefined>((r2) => setTimeout(() => r2(undefined), 5000)),
      ]);
      sseHelloMs = Date.now() - t0;
      sseHelloOk = first !== undefined && first.done === false && new TextDecoder().decode(first.value).includes("hello");
    } catch {
      sseHelloOk = false;
    } finally {
      ac.abort();
    }
  }
  ok(
    healthDuring.status === 200 && !post1Settled && healthDuring.ms < 1500,
    `HTTP ①② 解析进行中 GET /health 可响应（${healthDuring.ms}ms < 1500ms，旧红 3431ms；响应时 run 未完成=${!post1Settled}）`,
  );
  ok(
    projectsDuring.status === 200 && Array.isArray(projectsDuring.json) && (projectsDuring.json as unknown[]).length >= 2,
    `HTTP ① 解析进行中轻端点 GET /api/projects 可响应（${projectsDuring.ms}ms，${Array.isArray(projectsDuring.json) ? (projectsDuring.json as unknown[]).length : "?"} 个项目）`,
  );
  // GET arch/modules 应答形状：{ok, arch: readModules(...)}——readModules 的 modules 清单在 .arch.arch 里
  const modulesInner = (modulesDuring.json.arch as { arch?: { modules?: { id?: string }[] } } | undefined)?.arch;
  ok(
    modulesDuring.status === 200 && modulesInner?.modules?.[0]?.id === "sentinel-old",
    "HTTP ①④ 解析进行中读到的仍是上次有效 modules.json（哨兵），半成品不可见",
  );
  ok(
    sseHelloOk && sseHelloMs < 1500,
    `HTTP ①② 解析进行中 SSE /events 首帧 hello 及时到达（${sseHelloMs}ms < 1500ms，旧红 2963ms）`,
  );

  // ── H3 ④：显式取消 → 不发布半成品、旧结果逐字节保留、run 终态 cancelled 带进度 ──
  console.log("\n[verify] ── H3 ④：显式取消不发布半成品");
  const del1 = await httpJson(port, "DELETE", `/api/projects/${fxHttp.id}/arch/parse`);
  info(`HTTP DELETE 回执：${JSON.stringify(del1.json)}`);
  ok(
    del1.status === 200 && del1.json.cancelled === true && del1.json.run_id === run1Id,
    `HTTP ④ DELETE 定向取消成功（cancelled=${String(del1.json.cancelled)}、run_id 对得上进行中 run）`,
  );
  ok(
    del1.json.partial === true &&
      del1.json.progress !== null &&
      typeof del1.json.note === "string" &&
      (del1.json.note as string).includes("部分结果不写入") &&
      (del1.json.note as string).includes("沿用上次完整落盘状态"),
    "HTTP ④ 取消回执带 progress/partial/未完成原因 note",
  );
  const post1 = await post1P;
  ok(
    post1.status === 200 &&
      post1.json.ok === true &&
      post1.json.cancelled === true &&
      post1.json.partial === true &&
      post1.json.result === undefined &&
      typeof post1.json.note === "string",
    `HTTP ④ 等待中的 POST 只回取消回执（cancelled=true、不下发部分结果：result 字段=${String(post1.json.result)}）`,
  );
  const cancelledRun = await pollRun(port, fxHttp.id, (r) => r?.status === "cancelled", 10_000);
  ok(
    cancelledRun !== null &&
      cancelledRun.status === "cancelled" &&
      cancelledRun.id === run1Id &&
      cancelledRun.finished_at !== null &&
      cancelledRun.result === null &&
      cancelledRun.progress.parsed_files < fxHttp.sourceFiles,
    `HTTP ④ GET 可见 run 终态 cancelled 带停止位置（parsed_files=${cancelledRun?.progress.parsed_files} < ${fxHttp.sourceFiles}、finished_at 已记）`,
  );
  ok(
    fileBytes(fxHttp.modulesFile).equals(sentinelBytes),
    "HTTP ④ 取消后上次有效 modules.json（哨兵）逐字节不变——显式取消不发布半成品",
  );

  // ── H4 ⑤①：取消后可重试 → done 完整发布 ──
  console.log("\n[verify] ── H4 ⑤：取消后重跑 done、完整结果发布");
  const post2 = await httpJson(port, "POST", `/api/projects/${fxHttp.id}/arch/parse`);
  const post2Result = post2.json.result as
    | { module_count?: number; stats?: { source_files?: number; imports?: number; budget_exhausted?: boolean } }
    | undefined;
  ok(
    post2.status === 200 && post2.json.ok === true && post2.json.cancelled === undefined && post2Result !== undefined,
    `HTTP ⑤ 取消后可重试：重跑 POST 成功应答（${post2.status}）`,
  );
  ok(
    (post2Result?.module_count ?? 0) >= BIG_DIRS &&
      post2Result?.stats?.source_files === fxHttp.sourceFiles &&
      (post2Result?.stats?.imports ?? 0) > 0,
    `HTTP ① done 发布完整结果（module_count=${post2Result?.module_count} ≥ ${BIG_DIRS}、source_files=${post2Result?.stats?.source_files}、imports=${post2Result?.stats?.imports}）`,
  );
  const published = JSON.parse(fileBytes(fxHttp.modulesFile).toString("utf8")) as {
    modules: { id: string; path: string; file_count: number }[];
  };
  ok(
    published.modules.length >= BIG_DIRS && !fileBytes(fxHttp.modulesFile).equals(sentinelBytes),
    `HTTP ① done 后 modules.json 真落盘（${published.modules.length} 个模块，哨兵已被完整结果替换）`,
  );
  // 终态 done 后 GET 可见最近一次 run（留档，不冒充进行中）
  const doneRun = await pollRun(port, fxHttp.id, (r) => r?.status === "done", 5_000);
  ok(
    doneRun?.status === "done" && doneRun.id === (post2.json.run_id as string),
    `HTTP ② GET 可见终态 done run（run_id 与 POST 应答一致）`,
  );

  // ── H5 ③：杀掉等待中的 POST 连接（客户端断连）→ run 不终止、GET 续看到 done、结果照常发布 ──
  console.log("\n[verify] ── H5 ③：断连≠取消（abort POST 后 run 继续，GET 续看）");
  const ac = new AbortController();
  let post3AbortError: string | null = null;
  const post3P = fetch(`http://127.0.0.1:${port}/api/projects/${fxHttp.id}/arch/parse`, {
    method: "POST",
    signal: ac.signal,
  })
    .then(async (res) => ({ aborted: false, body: await res.text() }))
    .catch((e: Error) => {
      post3AbortError = e.name;
      return { aborted: true, body: "" };
    });
  const running3 = await pollRun(port, fxHttp.id, (r) => r?.status === "running", 15_000);
  ok(running3?.status === "running", `HTTP ③ 第三次 run 进入进行中（run_id=${running3?.id.slice(0, 8)}…）`);
  const run3Id = running3?.id ?? "";
  ac.abort(); // 客户端断连（杀掉等待中的 POST 连接）——按合同这不是取消
  const post3 = await post3P;
  ok(
    post3.aborted === true && post3AbortError === "AbortError",
    `HTTP ③ POST 连接已被客户端中止（${post3AbortError}）——模拟断连/页面刷新`,
  );
  // 断连后立刻查：run 不得因断连进 cancelled（进行中或已 done 都合法，唯独 cancelled 不合法）
  const afterAbort = await pollRun(port, fxHttp.id, (r) => r?.id === run3Id, 5_000);
  ok(
    afterAbort !== null && afterAbort.status !== "cancelled",
    `HTTP ③ 断连后 run 未被取消（status=${afterAbort?.status}，绝非 cancelled）`,
  );
  // 重连续看：只靠 GET 轮询跟到终态（POST 已经没了）——断连前的进度重连后照常可见
  const finalRun3 = await pollRun(port, fxHttp.id, (r) => r?.id === run3Id && r.status !== "running", 60_000);
  ok(
    finalRun3?.status === "done" && finalRun3.result !== null,
    `HTTP ③ 断连后 GET 续看直到 done（result.module_count=${finalRun3?.result?.module_count}）——重连可续看进度`,
  );
  const republished = JSON.parse(fileBytes(fxHttp.modulesFile).toString("utf8")) as {
    modules: { id: string; path: string; file_count: number }[];
  };
  const shapeOf = (ms: { id: string; path: string; file_count: number }[]) =>
    JSON.stringify(ms.map((m) => ({ id: m.id, path: m.path, file_count: m.file_count })));
  ok(
    shapeOf(republished.modules) === shapeOf(published.modules),
    "HTTP ③ 断连后续跑的结果照常完整发布（模块集与上一次完整发布一致）",
  );

  // ── H6 ③：单飞去重（进行中重复 POST = 挂上，不另起） ──
  console.log("\n[verify] ── H6 ③：HTTP 单飞去重");
  const post4P = httpJson(port, "POST", `/api/projects/${fxHttp.id}/arch/parse`);
  const running4 = await pollRun(port, fxHttp.id, (r) => r?.status === "running" && r.progress.parsed_files > 0, 15_000);
  ok(running4?.status === "running", "HTTP ③ 第四次 run 进行中（进入解析阶段）");
  const post5 = await httpJson(port, "POST", `/api/projects/${fxHttp.id}/arch/parse`);
  const post4 = await post4P;
  ok(
    post5.json.run_id === post4.json.run_id && post5.json.deduplicated === true && post4.json.deduplicated === false,
    `HTTP ③ 进行中重复 POST → 同一 run_id、第二发 deduplicated=true（不另起 run，旧 run 覆盖新结果结构上不可能）`,
  );
  ok(post4.json.ok === true && post4.json.result !== undefined, "HTTP ④/⑤ 单飞 run 正常 done（未被重复启动干扰）");
} catch (e) {
  ok(false, `HTTP 集成段失败：${(e as Error).message}`);
} finally {
  if (backend !== null) {
    backend.proc.kill();
    await new Promise((r) => setTimeout(r, 300));
  }
}

// ── 清理临时夹具（含后端日志）──
try {
  fs.rmSync(tmpBase, { recursive: true, force: true });
  console.log("[verify] 临时夹具已删除");
} catch {
  console.log(`[verify] 临时夹具删除失败（Windows 偶发占用，残留无害）：${tmpBase}`);
}

console.log(`\n[verify] 合计 PASS ${pass} / FAIL ${fail}`);
if (fail > 0) process.exitCode = 1;
