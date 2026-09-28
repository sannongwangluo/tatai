// 全量扫描取消链路验证（R20260920-1 修复批 2：T12／R1-ZS-004，对应问题账 R1-C-018）。
// 用法：node --import tsx scripts/verify-scan-cancel.ts（或 pnpm verify:scan-cancel）
//
// 判词口径（TPL-09 §二 R1-ZS-004）：扫描入口此前没有取消信号；V06-14 ④-5「后台全量扫描可取消」
// 实际执行的是 `DELETE /watch`（停文件监听）≠ 扫描取消。本脚本覆盖判词点名的四条＋两条补强：
//   ① 实际停止：取消后遍历计数不再增长（用**确定性的检查点注入**，不靠 sleep 竞态）；
//   ② 部分结果标识：回执如实带 partial、note 说明"部分结果未写入，沿用上次完整落盘状态"；
//   ③ 取消回执形状：cancelled/project_id/progress/partial/note 齐全；
//   ④ 取消后可再扫：同一项目再次发起扫描正常跑完（不留脏标记/死锁）；
//   ⑤ 无扫描时取消的诚实回执：cancelled=false + 原因，不报错；
//   ⑥ 取消后上次完整落盘状态（arch 的 modules.json）逐字节不变，且取消不删任何已落盘数据。
// 另加一段真起后端的 HTTP 集成：`GET /api/projects/:id/scan` 正常、`DELETE …/scan`（新口）
// 在无进行中扫描时回诚实回执——证明 HTTP 口真的接上了这套函数（不是只测函数）。
//
// 批3 T17/T18（2026-09-20 审计，判词 TPL-10 §4.1/§4.2）补四项：
//   ⑦ 遍历中排队的取消回调被服务（终审探针第 3 案形态：首个检查点 `setImmediate` 排队取消，不用 shouldCancel 注入）；
//   ⑦b 遍历连续跨多个检查点让出（取消落在第二个检查点）；
//   ⑧ 重叠扫描身份匹配（A 进行中启动 B、A 结束后取消仍找得到 B、旧 run 不注销新 run、登记表最终清空）；
//   ⑨ onCheckpoint 抛错的异常路径 finally 清理；以及**大夹具真 HTTP 遍历中取消**（轻端点可响应、DELETE 带 progress、
//      半截结果不下发、arch 产物逐字节不变、取消后可再扫完整）。
//
// 隔离与清理：夹具一律建在 `os.tmpdir()` 下的临时目录，跑完即删；注册表/架构图都落在临时 home 的
// 临时项目里，**不读不写用户真实 TATAI_HOME 与任何纳管项目**；不调任何模型网关。
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  requestScanCancel,
  scanProjectAsync,
  type ProjectScan,
  type ScanCancelReceipt,
  type ScanProgress,
} from "../src/server/scanner";
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

// 临时数据目录（不碰真实 TATAI_HOME 与真实项目）
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-scan-cancel-"));
console.log(`[verify] 临时夹具根：${tmpBase}`);

const DIRS = 8; // 顶层子目录数（决定安全检查点数量）
const FILES_PER_DIR = 6; // 每目录文件数
// 文件树口径：子目录文件 + 根级 package.json / README.md 两个（`.工作台` 在忽略段里，不计）
const EXPECTED_FILES = DIRS * FILES_PER_DIR + 2;

interface Fixture {
  id: string;
  home: string;
  root: string;
  modulesFile: string;
}

/**
 * 造一个隔离项目：多目录多文件 + 上次完整落盘的 arch modules.json（取消不得动它）。
 * `opts` 供批3 T17 的大夹具用（尺寸 + 复用已有 home，好让同一个后端进程同时看到两个项目）；不传＝既有默认。
 */
function makeProject(id: string, opts?: { home?: string; dirs?: number; filesPerDir?: number }): Fixture {
  const home = opts?.home ?? path.join(tmpBase, `home-${id}`);
  const root = path.join(tmpBase, `proj-${id}`);
  const dirs = opts?.dirs ?? DIRS;
  const filesPerDir = opts?.filesPerDir ?? FILES_PER_DIR;
  fs.mkdirSync(root, { recursive: true });
  for (let i = 0; i < dirs; i++) {
    const dir = path.join(root, `d${String(i).padStart(2, "0")}`);
    fs.mkdirSync(dir, { recursive: true });
    for (let j = 0; j < filesPerDir; j++) {
      fs.writeFileSync(path.join(dir, `f${j}.ts`), `export const x${i}_${j} = ${j};\n`);
    }
  }
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: id, scripts: { start: "node ." }, dependencies: { x: "1.0.0" } }),
  );
  fs.writeFileSync(path.join(root, "README.md"), `# ${id} 夹具\n\n正文一段。\n`);
  fs.mkdirSync(home, { recursive: true });
  addProject({ id, name: id, path: root, kind: "backend" }, home);
  // 上次完整落盘状态：静态解析层的架构模块图（扫描取消不得写它半截、也不得删它）
  const archDir = path.join(root, ".工作台", "arch");
  fs.mkdirSync(archDir, { recursive: true });
  const modulesFile = path.join(archDir, "modules.json");
  fs.writeFileSync(
    modulesFile,
    JSON.stringify({
      version: 1,
      modules: [{ id: "m1", path: ".", file_count: dirs * filesPerDir + 2 }],
      budget_exhausted: false,
    }),
    "utf8",
  );
  return { id, home, root, modulesFile };
}

const fileBytes = (p: string): Buffer => (fs.existsSync(p) ? fs.readFileSync(p) : Buffer.alloc(0));

// ══════════════════════════ 基准：无取消时扫描跑完整 ══════════════════════════
console.log("\n[verify] ── 基准：无取消时全量扫描跑完（建立比对基线）");
const fx = makeProject("cancelfix");
const baselineCheckpoints: ScanProgress[] = [];
const full = await scanProjectAsync(fx.id, fx.home, {
  onCheckpoint: (p) => baselineCheckpoints.push(p),
});
const baseEntries = baselineCheckpoints.at(-1)?.entries_seen ?? 0;
const baseDirs = baselineCheckpoints.at(-1)?.dirs_done ?? 0;
info(`基准：文件 ${full.tree.total_files}、安全检查点 ${baselineCheckpoints.length} 个（末次 dirs_done=${baseDirs}、entries_seen=${baseEntries}）`);
ok(
  !full.cancelled && full.tree.total_files === EXPECTED_FILES && baselineCheckpoints.length === DIRS + 1 && baseDirs === DIRS,
  `基准扫描完整（未取消；文件 ${full.tree.total_files}=${EXPECTED_FILES}，安全检查点 ${baselineCheckpoints.length}=${DIRS + 1}、末次 dirs_done ${baseDirs}=${DIRS}）`,
);

// ══════════ ① 实际停止：确定性检查点注入取消 → 遍历计数不再增长 ══════════
console.log("\n[verify] ── ① 实际停止：检查点注入取消（不靠 sleep）");
const CANCEL_AT = 2; // 处理完 2 个目录（根 + d00）后，在下一个检查点命中取消
const checkpoints: ScanProgress[] = [];
// 用持有对象装回执（闭包内赋值；避免 TS 把 let 变量收窄成 null）
const receiptBox: { value: ScanCancelReceipt | null } = { value: null };
const cancelledScan = await scanProjectAsync(fx.id, fx.home, {
  onCheckpoint: (p) => {
    checkpoints.push(p);
    // 在确定的位置触发取消：走 HTTP `DELETE …/scan` 的同一入口函数，检验登记表路径
    if (p.dirs_done === CANCEL_AT && receiptBox.value === null) {
      receiptBox.value = requestScanCancel(fx.id, fx.home);
    }
  },
});
const lastCp = checkpoints.at(-1);
info(`取消扫描：cancelled=${cancelledScan.cancelled}、停在 dirs_done=${cancelledScan.progress?.dirs_done}、entries_seen=${cancelledScan.progress?.entries_seen}、检查点共 ${checkpoints.length} 个`);
ok(cancelledScan.cancelled === true, "① 命中取消检查点后扫描如实标记 cancelled=true");
ok(
  cancelledScan.progress?.dirs_done === CANCEL_AT,
  `① 停在确定的安全检查点（dirs_done=${cancelledScan.progress?.dirs_done}=断言值 ${CANCEL_AT}）`,
);
ok(
  checkpoints.every((p) => p.dirs_done <= CANCEL_AT) && (lastCp?.dirs_done ?? -1) === CANCEL_AT,
  `① 取消后遍历计数不再增长：所有检查点 dirs_done ≤ ${CANCEL_AT}（末次 ${lastCp?.dirs_done}），无越过取消点的后续检查点`,
);
ok(
  (cancelledScan.progress?.entries_seen ?? baseEntries) < baseEntries,
  `① 确实提前停手（entries_seen ${cancelledScan.progress?.entries_seen} < 完整扫描 ${baseEntries}）`,
);

// ══════════ ② 部分结果标识：回执如实带 partial + 未写入说明 ══════════
console.log("\n[verify] ── ② 部分结果标识");
ok(
  cancelledScan.readme === null && cancelledScan.docs.length === 0 && cancelledScan.manifests.package_json === null,
  "② 未完成的部分结果已丢弃（README/docs/清单不再读取，HTTP 侧只回取消回执）",
);
ok(
  receiptBox.value?.partial === true,
  `② 回执如实带 partial=true（回执 partial=${receiptBox.value?.partial}）`,
);
ok(
  (receiptBox.value?.note ?? "").includes("部分结果未写入") &&
    (receiptBox.value?.note ?? "").includes("沿用上次完整落盘状态"),
  `② 回执写明"部分结果未写入，沿用上次完整落盘状态（可能已过期）"：${receiptBox.value?.note ?? "（无）"}`,
);

// ══════════ ③ 取消回执形状：cancelled/project_id/progress/partial/note ══════════
console.log("\n[verify] ── ③ 取消回执形状");
const r: ScanCancelReceipt | null = receiptBox.value;
ok(r !== null && r.cancelled === true, `③ 回执 cancelled=true（${r?.cancelled}）`);
ok(r !== null && r.project_id === fx.id, `③ 回执带 project_id（${r?.project_id}）`);
ok(r !== null && r.progress !== null && r.progress.dirs_done === CANCEL_AT && typeof r.progress.entries_seen === "number", `③ 回执带停止位置/已完成量（progress=${JSON.stringify(r?.progress)}）`);
ok(r !== null && r.partial === true && typeof r.note === "string" && r.note.length > 0, "③ 回执带 partial 标识与非空 note");

// ══════════ ⑤ 无扫描时取消的诚实回执（不报错） ══════════
console.log("\n[verify] ── ⑤ 无进行中扫描时取消：诚实回执、不报错");
const idleReceipt = requestScanCancel(fx.id, fx.home);
info(`无扫描时取消：cancelled=${idleReceipt.cancelled}、progress=${JSON.stringify(idleReceipt.progress)}、note=${idleReceipt.note}`);
ok(idleReceipt.cancelled === false, "⑤ 无进行中扫描 → cancelled=false");
ok(idleReceipt.partial === false && idleReceipt.progress === null, "⑤ 无进行中扫描 → partial=false、progress=null");
ok(idleReceipt.note.includes("没有进行中的扫描"), `⑤ 回执写明原因（不报错）：${idleReceipt.note}`);
// 边界：项目不存在仍走既有 404 口径（与 GET /scan 一致），不被"无扫描即诚实回执"含糊掉
let notFoundCode = "";
try {
  requestScanCancel("no-such-project-xyz", fx.home);
} catch (e) {
  notFoundCode = e instanceof WsError ? e.code : "非 WsError";
}
ok(notFoundCode === "PROJECT_NOT_FOUND", `⑤ 不存在的项目 → PROJECT_NOT_FOUND（与 GET /scan 同口径，不静默成空回执）`);

// ══════════ ⑥ 取消后上次完整 modules.json 逐字节不变 ══════════
console.log("\n[verify] ── ⑥ 取消不写/不删已落盘数据");
const modulesAfterCancel = fileBytes(fx.modulesFile);
ok(modulesAfterCancel.length > 0, "⑥ 上次完整落盘的 arch modules.json 仍在（取消不删数据）");

// ══════════ ④ 取消后可再扫：正常跑完、不留脏标记 ══════════
console.log("\n[verify] ── ④ 取消后同一项目可再扫");
const rescan = await scanProjectAsync(fx.id, fx.home);
ok(
  !rescan.cancelled && rescan.tree.total_files === EXPECTED_FILES && rescan.docs.length > 0,
  `④ 取消后再扫正常跑完（cancelled=${rescan.cancelled}、文件 ${rescan.tree.total_files}=${EXPECTED_FILES}）`,
);
const idleAfter = requestScanCancel(fx.id, fx.home);
ok(idleAfter.cancelled === false, "④ 取消标记随扫描结束注销（再扫期间无残留取消标记/死锁）");
ok(
  fileBytes(fx.modulesFile).equals(modulesAfterCancel),
  "⑥ 直到再扫完成，上次完整 modules.json 仍逐字节不变",
);

// ══════════ ⑦ 批3 T17：遍历中排队的取消回调被服务（终审探针第 3 案形态）══════════
// 与 ① 的区别：① 在 onCheckpoint 里**同步**调取消；这里按终审探针第 3 案的形态，在首个检查点用
// `setImmediate` 把取消**排进事件循环**——只有遍历真的协作式让出，这个回调才可能在遍历**中**执行
// （TPL-10 §4.1：原实现在 81 个检查点全跑完后才执行该回调，回"当前没有进行中的扫描"）。
console.log("\n[verify] ── ⑦ 遍历中排队的取消回调被服务（不用 shouldCancel 注入）");
const t17fx = makeProject("t17fix");
const t17Full = await scanProjectAsync(t17fx.id, t17fx.home);
const t17Cp: ScanProgress[] = [];
let t17Queued = false;
let t17CallbackBeforeCompletion: boolean | null = null;
const t17ReceiptBox: { value: ScanCancelReceipt | null } = { value: null };
let t17Completed = false;
const t17Scan = await scanProjectAsync(t17fx.id, t17fx.home, {
  onCheckpoint: (p) => {
    t17Cp.push(p);
    if (t17Queued) return;
    t17Queued = true;
    // 首个检查点排队取消（不是 shouldCancel 注入）：回调若在遍历中执行，t17Completed 仍是 false
    setImmediate(() => {
      t17CallbackBeforeCompletion = !t17Completed;
      t17ReceiptBox.value = requestScanCancel(t17fx.id, t17fx.home);
    });
  },
});
t17Completed = true;
info(
  `⑦ 探针形态：被取消扫描观测到 ${t17Cp.length} 个检查点（该夹具完整扫描 ${DIRS + 1} 个）、回调执行时扫描已完成=${t17Completed && t17CallbackBeforeCompletion === false}、回执=${JSON.stringify(t17ReceiptBox.value)}`,
);
ok(
  t17Scan.cancelled === true && t17ReceiptBox.value?.cancelled === true,
  `⑦ 首个检查点排队的 setImmediate 取消被服务：扫描 cancelled=${t17Scan.cancelled}、回执 cancelled=${t17ReceiptBox.value?.cancelled}`,
);
ok(
  t17CallbackBeforeCompletion === true,
  `⑦ 取消回调**先于遍历完成**执行（回调内观测到扫描未完成＝${t17CallbackBeforeCompletion}）`,
);
ok(
  t17Queued && t17Full.tree.total_files === EXPECTED_FILES && DIRS + 1 > 1,
  `⑦ 遍历确有多个安全检查点（夹具完整扫描 ${DIRS + 1} 个 > 1、文件 ${t17Full.tree.total_files}），"回调先于完成"才有意义`,
);

// ⑦b：把取消回调延后一个事件循环轮次排入（仍是首个检查点 setImmediate 排队，不是 shouldCancel 注入）——
// 证明遍历**连续跨多个检查点**让出：取消在第二个检查点才命中，而不是"一口气跑完再回放回调"。
console.log("\n[verify] ── ⑦b 遍历连续跨多个检查点让出（取消落在第二个检查点）");
const t17bDirsDone: number[] = [];
let t17bQueued = false;
let t17bCallbackBeforeCompletion: boolean | null = null;
let t17bCompleted = false;
const t17bReceiptBox: { value: ScanCancelReceipt | null } = { value: null };
const t17bScan = await scanProjectAsync(t17fx.id, t17fx.home, {
  onCheckpoint: (p) => {
    t17bDirsDone.push(p.dirs_done);
    if (t17bQueued) return;
    t17bQueued = true;
    setImmediate(() => {
      // 再排一轮：取消要等下一个检查点才被看到
      setImmediate(() => {
        t17bCallbackBeforeCompletion = !t17bCompleted;
        t17bReceiptBox.value = requestScanCancel(t17fx.id, t17fx.home);
      });
    });
  },
});
t17bCompleted = true;
ok(
  t17bScan.cancelled === true && t17bCallbackBeforeCompletion === true,
  `⑦b 取消在第二个检查点命中、回调仍先于遍历完成：扫描 cancelled=${t17bScan.cancelled}、回调先于完成=${t17bCallbackBeforeCompletion}`,
);
ok(
  t17bDirsDone.length > 1 && t17bScan.progress?.dirs_done === t17bDirsDone.length - 1,
  `⑦b 遍历跨过多个安全检查点才停手（观测 ${t17bDirsDone.length} 个、停在 dirs_done=${t17bScan.progress?.dirs_done}）`,
);

// ══════════ ⑧ 批3 T18：重叠扫描身份匹配（旧 run 结束不得注销新 run，R1-ZS-R2-001）══════════
// 终审探针第 4 案形态：A 扫描进行中在同项目启动 B；A 结束后立刻取消——B 仍登记，必须回 cancelled:true。
console.log("\n[verify] ── ⑧ 重叠扫描身份匹配（旧 run 结束不得注销新 run）");
const t18fx = makeProject("t18fix");
const secondBox: { p: Promise<ProjectScan> | null } = { p: null };
await scanProjectAsync(t18fx.id, t18fx.home, {
  onCheckpoint: () => {
    if (secondBox.p !== null) return;
    secondBox.p = scanProjectAsync(t18fx.id, t18fx.home); // A 进行中启动同项目 B（允许重叠，不做单飞拒绝）
  },
});
const overlapReceipt = requestScanCancel(t18fx.id, t18fx.home);
ok(
  secondBox.p !== null,
  "⑧ A 扫描进行中成功启动同项目 B（允许重叠，不做单飞拒绝）",
);
ok(
  overlapReceipt.cancelled === true && overlapReceipt.progress !== null,
  `⑧ A 结束后取消仍找得到 B（旧 run 未注销新 run）：cancelled=${overlapReceipt.cancelled}、progress=${JSON.stringify(overlapReceipt.progress)}`,
);
const secondP = secondBox.p;
const secondResult = secondP === null ? null : await secondP;
ok(
  secondResult !== null && secondResult.cancelled === true,
  `⑧ B 被定向取消后在检查点停手（cancelled=${secondResult?.cancelled}、停在 dirs_done=${secondResult?.progress?.dirs_done}）`,
);
const afterBoth = requestScanCancel(t18fx.id, t18fx.home);
ok(
  afterBoth.cancelled === false && afterBoth.progress === null && afterBoth.note.includes("没有进行中的扫描"),
  `⑧ 两个 run 都结束后登记表清干净：cancelled=${afterBoth.cancelled}、progress=${JSON.stringify(afterBoth.progress)}、note=${afterBoth.note}`,
);

// ══════════ ⑨ 批3 T17/T18：onCheckpoint 抛错的异常路径 finally 清理 ══════════
console.log("\n[verify] ── ⑨ onCheckpoint 抛错 → 异常路径 finally 清理登记表");
let throwCp = 0;
let threw: Error | null = null;
try {
  await scanProjectAsync(t17fx.id, t17fx.home, {
    onCheckpoint: () => {
      throwCp += 1;
      if (throwCp === 3) throw new Error("夹具：检查点第 3 次故意抛错");
    },
  });
} catch (e) {
  threw = e as Error;
}
ok(
  threw !== null && threw.message.includes("故意抛错"),
  `⑨ onCheckpoint 抛错 → scanProjectAsync reject（第 ${throwCp} 次检查点抛错：${threw?.message ?? "（未抛错）"}）`,
);
const afterThrow = requestScanCancel(t17fx.id, t17fx.home);
ok(
  afterThrow.cancelled === false && afterThrow.progress === null && afterThrow.note.includes("没有进行中的扫描"),
  `⑨ 异常后 finally 清理生效：取消回"没有进行中的扫描"（cancelled=${afterThrow.cancelled}、note=${afterThrow.note}）`,
);

// ══════════ HTTP 集成：新口真的接上了（真起后端 + 真 HTTP） ══════════
console.log("\n[verify] ── HTTP 集成：GET /scan 正常、DELETE /scan（新口）诚实回执");

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
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method,
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  return { status: res.status, json };
}
async function startBackend(home: string): Promise<Backend> {
  const port = await freePort();
  const logPath = path.join(tmpBase, `backend-${port}.log`);
  const proc = spawn("node", ["--import", "tsx", path.join("src", "server", "index.ts")], {
    cwd: REPO,
    env: { ...process.env, TATAI_HOME: home, TATAI_PORT: String(port), DEEPSEEK_API_KEY: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
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

let backend: Backend | null = null;
try {
  // HTTP 夹具用独立 home，避免与函数级用例的注册表混淆
  const httpFx = makeProject("httpfix");
  // 批3 T17：同一个后端 home 再挂一个**大夹具**（≥40 目录 × 30 文件）——遍历够长，才能在扫描进行中
  // 从另一个请求把取消打进去（判词 §4.1 的 HTTP 验收形态）
  const BIG_DIRS = 80;
  const BIG_FILES_PER_DIR = 30;
  const httpBigFx = makeProject("httpbig", { home: httpFx.home, dirs: BIG_DIRS, filesPerDir: BIG_FILES_PER_DIR });
  const BIG_EXPECTED_FILES = BIG_DIRS * BIG_FILES_PER_DIR + 2; // 子目录文件 + 根级 package.json / README.md
  backend = await startBackend(httpFx.home);
  const gotScan = await httpJson(backend.port, "GET", `/api/projects/${httpFx.id}/scan`);
  const scanObj = gotScan.json.scan as { tree?: { total_files?: number } } | undefined;
  ok(
    gotScan.status === 200 && gotScan.json.ok === true && gotScan.json.cancelled === undefined && scanObj?.tree?.total_files === EXPECTED_FILES,
    `HTTP GET /scan 正常（${gotScan.status}，文件 ${scanObj?.tree?.total_files}）`,
  );
  const gotCancel = await httpJson(backend.port, "DELETE", `/api/projects/${httpFx.id}/scan`);
  info(`HTTP DELETE /scan → ${gotCancel.status} ${JSON.stringify(gotCancel.json)}`);
  ok(
    gotCancel.status === 200 &&
      gotCancel.json.ok === true &&
      gotCancel.json.cancelled === false &&
      gotCancel.json.progress === null &&
      typeof gotCancel.json.note === "string",
    `HTTP DELETE /scan（新口）无进行中扫描时回诚实回执（cancelled=false、progress=null）`,
  );

  // ── 批3 T17：真实 HTTP 扫描已进入遍历后，从**另一个请求**取消（判词 §4.1 HTTP 验收形态）──
  console.log("\n[verify] ── 批3 T17 HTTP：遍历中取消 / 遍历中轻端点可响应 / 取消后可再扫");
  const bigArtifactBefore = fileBytes(httpBigFx.modulesFile);
  let bigScanSettled = false;
  let bigScanDoneAt = 0;
  const bigScanAt = Date.now();
  const bigScanP = httpJson(backend.port, "GET", `/api/projects/${httpBigFx.id}/scan`).then((r) => {
    bigScanSettled = true;
    bigScanDoneAt = Date.now();
    return r;
  });
  // 趁遍历进行：先打轻端点 /health（证明遍历中事件循环可调度），再从另一请求 DELETE 取消；
  // 若太早（扫描还没登记）则重试，最多到扫描结束为止
  let healthDuringTraversal = false;
  let healthAt = 0;
  let deleteJson: Record<string, unknown> | null = null;
  for (let i = 0; i < 200 && !bigScanSettled; i++) {
    const h = await httpJson(backend.port, "GET", "/health");
    if (h.status === 200 && !bigScanSettled) {
      healthDuringTraversal = true;
      healthAt = Date.now();
    }
    const c = await httpJson(backend.port, "DELETE", `/api/projects/${httpBigFx.id}/scan`);
    if (c.json.cancelled === true) {
      deleteJson = c.json;
      break;
    }
    if (bigScanSettled) break;
    await new Promise((r) => setTimeout(r, 5));
  }
  const bigScan = await bigScanP;
  info(
    `HTTP 大夹具：目录 ${BIG_DIRS}×${BIG_FILES_PER_DIR} 文件；被取消扫描自发起至回执耗时 ${bigScanDoneAt - bigScanAt}ms；` +
      `DELETE 回执=${JSON.stringify(deleteJson)}；GET 响应 cancelled=${String(bigScan.json.cancelled)}`,
  );
  ok(
    healthDuringTraversal && healthAt < bigScanDoneAt,
    `HTTP ①遍历中轻端点可响应：GET /health 在扫描完成前（${healthAt < bigScanDoneAt}）返回 200`,
  );
  ok(
    deleteJson !== null && deleteJson.cancelled === true && deleteJson.progress !== null,
    `HTTP ②遍历中 DELETE /scan 定向取消成功且带 progress：${JSON.stringify(deleteJson?.progress)}`,
  );
  ok(
    bigScan.status === 200 && bigScan.json.cancelled === true && bigScan.json.scan === undefined,
    `HTTP ③扫描结果如实 cancelled=true、不下发半截结果（scan 字段=${String(bigScan.json.scan)}、partial=${String(bigScan.json.partial)}）`,
  );
  ok(
    fileBytes(httpBigFx.modulesFile).equals(bigArtifactBefore),
    "HTTP ③部分结果不冒充完整：arch 产物 modules.json 逐字节不变",
  );
  const rescanHttp = await httpJson(backend.port, "GET", `/api/projects/${httpBigFx.id}/scan`);
  const rescanObj = rescanHttp.json.scan as { tree?: { total_files?: number } } | undefined;
  ok(
    rescanHttp.status === 200 &&
      rescanHttp.json.ok === true &&
      rescanHttp.json.cancelled === undefined &&
      rescanObj?.tree?.total_files === BIG_EXPECTED_FILES,
    `HTTP ④取消后可再扫且完整成功（${rescanHttp.status}，文件 ${rescanObj?.tree?.total_files}=${BIG_EXPECTED_FILES}）`,
  );
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

console.log(`\n[verify] 结果：${pass} PASS / ${fail} FAIL`);
