// 遍历预算闸门回归：WALK_LIMITS 文件数 20k→50k、耗时 30s→120s（2026-10-04，用户授权的最小修法）。
// 用法：pnpm verify:walk-budget（或 node --import tsx scripts/verify-walk-budget.ts）
//
// 背景（独立真实复测）：示例项目整目录 21 226 个文件/条目——旧的 20 000 文件上限先于 120 s 时间上限到点，
// parseDirectory 在 28.173 s 就 budget_exhausted=true（模块图残缺）；原先记的"2335 源文件"是这趟
// 截断遍历之后的统计。故两处预算一起修：maxFiles 20 000→50 000、maxMs 30 000→120 000。同步
// parseDirectory、后台 parseDirectoryAsync（HTTP 全量入口）与 A4 expandDirectory 共用这份常量；
// 取消/单飞/如实残缺（budget_exhausted）全不变。合同原文 DESIGN §11.8 末段、§12.1-3（上限按实测调节）。
//
// 为什么用虚拟时钟：真等「30s 过了但 120s 没到」要实耗两分钟，回归不可接受。本脚本在**测试进程**
// 内替换全局 `Date.now`（parse.ts 的闸门只读它），把「已过去 N 秒」精确搬到确定时刻，不改任何生产
// 接口（parseDirectory / startParseProjectRun 签名一字未动，复用既有 ParseHooks.onCheckpoint）。
//
// 断言分五组：
//   S 耗时灵敏度对照（直接调导出的 boundedWalk）：同一虚拟时钟跳变，30s 预算截断、120s 预算不截断——
//     证明「30s 后 120s 前仍完整」不是巧合，而是这道常量在起作用（旧值 30_000 会红）。
//   A 同步 parseDirectory：跳变 +35s（>旧 30s、<新 120s）→ 跑完、budget_exhausted=false、loc 与真跑一致；
//     跳变 +125s（>新 120s）→ budget_exhausted=true 且 loc 明显小于完整跑（真残缺）。
//   B 后台 parseDirectoryAsync（经 startParseProjectRun，与 HTTP 全量入口同一执行体）：同样两档，
//     +35s 跑完且如实完整；+125s 停在预算处、budget_exhausted=true、module 仍有（如实残缺不冒充完整）。
//   F 文件数闸门正/负对照：小夹具 + 显式 budget（不造 5 万文件）——上限够→不截断、上限小→必截断且
//     恰好停在 maxFiles；再钉死新上限覆盖实测文件数（旧 20000 覆盖不到）。
//   C 常量契约钉值：maxMs===120_000、maxFiles===50_000（防再被无声改回）。
//
// 隔离与清理：夹具一律建在 os.tmpdir() 下的临时目录，跑完即删；注册表/解析产物都落在临时 home 的
// 临时项目里，不读不写用户真实 TATAI_HOME 与任何纳管项目；不调任何模型网关；收尾恢复 Date.now。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { boundedWalk, parseDirectory, startParseProjectRun, WALK_LIMITS, type ArchModule } from "../src/arch/parse";
import { addProject } from "../src/server/registry";

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

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-walk-budget-"));
console.log(`[verify] 临时夹具根：${tmpBase}`);

// ── 虚拟时钟：全局替换 Date.now（parse.ts 闸门只读它）──
const realNow = Date.now.bind(Date);
let clockOffset = 0;
const installClock = (): void => {
  Date.now = () => realNow() + clockOffset;
};
const setOffset = (ms: number): void => {
  clockOffset = ms;
};
const restoreClock = (): void => {
  Date.now = realNow;
};
installClock();
process.on("exit", restoreClock);

// ── 夹具 ──
interface Fixture {
  id: string;
  home: string;
  root: string;
  sourceFiles: number;
}

const FILE_LINES = 31; // 每文件固定行数：loc 可直接按「解析了几个文件 × 行数」核对

function makeSource(i: number, j: number): string {
  const lines = [`export const anchor${i}_${j} = ${i * 100 + j};`];
  for (let k = 0; k < FILE_LINES - 1; k++) lines.push(`export const pad${k} = ${k};`);
  return lines.join("\n") + "\n";
}

/** loc 口径 = text.split("\n").length：末尾换行也算一个空段，故每文件计 FILE_LINES+1 行 */
const LOC_PER_FILE = FILE_LINES + 1;

function makeProject(id: string, dirs: number, filesPerDir: number): Fixture {
  const home = path.join(tmpBase, `home-${id}`);
  const root = path.join(tmpBase, `proj-${id}`);
  fs.mkdirSync(root, { recursive: true });
  for (let d = 0; d < dirs; d++) {
    const dir = path.join(root, `d${String(d).padStart(2, "0")}`);
    fs.mkdirSync(dir, { recursive: true });
    for (let f = 0; f < filesPerDir; f++) fs.writeFileSync(path.join(dir, `f${f}.ts`), makeSource(d, f));
  }
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: id }));
  fs.mkdirSync(home, { recursive: true });
  addProject({ id, name: id, path: root, kind: "backend" }, home);
  return { id, home, root, sourceFiles: dirs * filesPerDir };
}

const sumLoc = (modules: ArchModule[]): number => modules.reduce((n, m) => n + m.loc, 0);
const modulesJsonPath = (root: string): string => path.join(root, ".工作台", "arch", "modules.json");

// ══════════════════════ S：灵敏度对照（boundedWalk，同一跳变、两个预算） ══════════════════════
// 直接调导出的 boundedWalk，避免依赖解析耗时。在**读根目录那一刻**把时钟跳到 +35s（遍历里每个
// 目录边界都查闸门，跳变点确定）：30s 预算随即截断（旧值现场），120s 预算照常走完（新值现场）。
console.log("\n[verify] ── S 灵敏度：同一 +35s 跳变，30s 预算截断 / 120s 预算不截断");
{
  const fx = makeProject("sensitivity", 8, 6); // 48 文件 / 8 目录，跳变后仍有大量闸门检查
  const realReaddir = fs.readdirSync;
  const walkWithJump = (maxMs: number): ReturnType<typeof boundedWalk> => {
    let flipped = false;
    // 读根目录后跳时钟（读目录本身不读 Date.now；跳变从随后的 overBudget 检查起生效）
    (fs as unknown as { readdirSync: typeof fs.readdirSync }).readdirSync = ((dir: fs.PathLike, opts?: unknown) => {
      const out = (realReaddir as unknown as (d: fs.PathLike, o?: unknown) => unknown)(dir, opts);
      if (!flipped && path.resolve(String(dir)) === path.resolve(fx.root)) {
        flipped = true;
        setOffset(35_000);
      }
      return out;
    }) as typeof fs.readdirSync;
    setOffset(0);
    try {
      return boundedWalk(fx.root, { maxFiles: WALK_LIMITS.maxFiles, maxMs });
    } finally {
      (fs as unknown as { readdirSync: typeof fs.readdirSync }).readdirSync = realReaddir;
    }
  };
  const old30 = walkWithJump(30_000);
  const new120 = walkWithJump(120_000);
  info(`旧 30s 预算：files=${old30.files.length} truncated=${old30.truncated}；新 120s 预算：files=${new120.files.length} truncated=${new120.truncated}`);
  ok(old30.truncated === true, "S 同一 +35s 跳变下，30s 预算（旧值）截断——证明这道常量是决定因素");
  ok(new120.truncated === false && new120.files.length === fx.sourceFiles + 1, `S 同一 +35s 跳变下，120s 预算（新值）走完（${new120.files.length} 个文件条目，含 package.json）`);
}

// ══════════════════════ A：同步 parseDirectory（读首个源文件时跳时钟） ══════════════════════
// 同步路径没有检查点钩子，改在**首次读 .ts 源文件**时跳时钟（遍历不读文件内容，跳变必落在解析阶段）。
console.log("\n[verify] ── A 同步 parseDirectory：+35s 仍完整 / +125s 真残缺");
{
  const fx = makeProject("sync", 6, 8); // 48 个源文件
  const realReadFile = fs.readFileSync;
  const parseWithJump = (offset: number) => {
    let flipped = false;
    (fs as unknown as { readFileSync: typeof fs.readFileSync }).readFileSync = ((p: fs.PathLike, ...rest: unknown[]) => {
      const out = (realReadFile as unknown as (pp: fs.PathLike, ...r: unknown[]) => unknown)(p, ...rest);
      if (!flipped && String(p).toLowerCase().endsWith(".ts") && path.resolve(String(p)).startsWith(path.resolve(fx.root))) {
        flipped = true;
        setOffset(offset);
      }
      return out;
    }) as typeof fs.readFileSync;
    setOffset(0);
    try {
      return parseDirectory(fx.root);
    } finally {
      (fs as unknown as { readFileSync: typeof fs.readFileSync }).readFileSync = realReadFile;
    }
  };
  const full = parseDirectory(fx.root);
  const fullLoc = sumLoc(full.file.modules);
  setOffset(0);
  const at35 = parseWithJump(35_000);
  const at125 = parseWithJump(125_000);
  info(`完整 loc=${fullLoc}（budget_exhausted=${String(full.file.budget_exhausted)}）· +35s loc=${sumLoc(at35.file.modules)}（${String(at35.file.budget_exhausted)}）· +125s loc=${sumLoc(at125.file.modules)}（${String(at125.file.budget_exhausted)}）`);
  ok(full.file.budget_exhausted === false && fullLoc === fx.sourceFiles * LOC_PER_FILE, `A 基准：真时钟跑完、loc=${fullLoc}=${fx.sourceFiles}×${LOC_PER_FILE}`);
  ok(
    at35.file.budget_exhausted === false && sumLoc(at35.file.modules) === fullLoc,
    `A +35s（>30s、<120s）仍完整：budget_exhausted=false、loc=${sumLoc(at35.file.modules)}=完整值`,
  );
  ok(
    at125.file.budget_exhausted === true && sumLoc(at125.file.modules) < fullLoc,
    `A +125s（>120s）真残缺：budget_exhausted=true、loc=${sumLoc(at125.file.modules)} < 完整值 ${fullLoc}`,
  );
}

// ══════════════════════ B：后台 parseDirectoryAsync（经 ParseHooks.onCheckpoint 跳时钟） ══════════════════════
console.log("\n[verify] ── B 后台 run：+35s 跑完且完整 / +125s 停在预算处、如实残缺");
{
  const jumpAtFirstParse = (ms: number) => {
    let jumped = false;
    return (p: { phase: string }): void => {
      if (!jumped && p.phase === "parsing") {
        jumped = true;
        setOffset(ms);
      }
    };
  };

  const fx35 = makeProject("async35", 6, 10); // 60 个源文件；首个解析检查点在 32 个文件
  setOffset(0);
  const r35 = await startParseProjectRun(fx35.id, fx35.home, { onCheckpoint: jumpAtFirstParse(35_000) }).done;
  info(`+35s：status=${r35.status} parsed=${r35.progress.parsed_files}/${fx35.sourceFiles} budget_exhausted=${String(r35.result?.stats.budget_exhausted)}`);
  ok(
    r35.status === "done" && r35.result !== null && r35.result.stats.budget_exhausted === false && r35.progress.parsed_files === fx35.sourceFiles,
    `B +35s 跑完且如实完整（status=${r35.status}、parsed=${r35.progress.parsed_files}=${fx35.sourceFiles}、budget_exhausted=false）`,
  );
  const written35 = JSON.parse(fs.readFileSync(modulesJsonPath(fx35.root), "utf8")) as { budget_exhausted?: boolean };
  ok(written35.budget_exhausted === false, "B +35s 落盘件 budget_exhausted=false（完整结果正常发布）");

  const fx125 = makeProject("async125", 6, 10);
  setOffset(0);
  const r125 = await startParseProjectRun(fx125.id, fx125.home, { onCheckpoint: jumpAtFirstParse(125_000) }).done;
  info(`+125s：status=${r125.status} parsed=${r125.progress.parsed_files}/${fx125.sourceFiles} budget_exhausted=${String(r125.result?.stats.budget_exhausted)} module_count=${r125.result?.module_count}`);
  ok(
    r125.status === "done" && r125.result !== null && r125.result.stats.budget_exhausted === true,
    `B +125s 跑完但如实记残缺（status=${r125.status}、budget_exhausted=true）`,
  );
  ok(
    r125.progress.parsed_files < fx125.sourceFiles && (r125.result?.module_count ?? 0) > 0,
    `B +125s 停在预算处、未冒充全量（parsed=${r125.progress.parsed_files} < ${fx125.sourceFiles}、module_count=${r125.result?.module_count} > 0）`,
  );
  const written125 = JSON.parse(fs.readFileSync(modulesJsonPath(fx125.root), "utf8")) as { budget_exhausted?: boolean };
  ok(written125.budget_exhausted === true, "B +125s 落盘件带 budget_exhausted=true（残缺标记随结果一起落盘，刷新/重启后仍可认）");
}

// ══════════════════════ F：文件数预算正/负对照（小夹具 + 显式 budget，不造 5 万文件） ══════════════════════
// 第二个必要缺陷正是这道文件数闸门：真造 2 万+ 文件才验旧上限，代价不可接受。改为在**同一个小夹具**上
// 显式传两个预算——上限够（正例）不截断、上限小（负例）必截断且**恰好停在 maxFiles**——证明闸门按
// maxFiles 精确生效；再用独立实测的文件数钉死"旧 20000 覆盖不到、新 50000 覆盖得到"。
console.log("\n[verify] ── F 文件数预算：上限够→不截断 / 上限小→恰好停在 maxFiles");
{
  const fx = makeProject("filecount", 8, 6); // 48 源文件 + package.json = 49 个文件条目
  const total = fx.sourceFiles + 1;
  const under = boundedWalk(fx.root, { maxFiles: 50_000, maxMs: Number.POSITIVE_INFINITY });
  const over = boundedWalk(fx.root, { maxFiles: 10, maxMs: Number.POSITIVE_INFINITY });
  info(`夹具共 ${total} 个文件条目：maxFiles=50000 → files=${under.files.length} truncated=${under.truncated}；maxFiles=10 → files=${over.files.length} truncated=${over.truncated}`);
  ok(under.truncated === false && under.files.length === total, `F 正例：上限充足不截断，走完 ${under.files.length} 个文件条目`);
  ok(over.truncated === true && over.files.length === 10, `F 负例：maxFiles=10 必截断且恰好停在 10（实际 ${over.files.length}）——闸门按 maxFiles 精确生效`);
  const realZhixuFiles = 21_226; // 独立真实复测：示例项目整目录 21 226 文件/条目（"2335 源文件"是这些上限截断后的统计）
  ok(20_000 < realZhixuFiles && realZhixuFiles <= WALK_LIMITS.maxFiles, `F 实测覆盖：示例项目 ${realZhixuFiles} 文件 > 旧上限 20000（旧值必截断）且 ≤ 新上限 ${WALK_LIMITS.maxFiles}`);
}

// ══════════════════════ C：常量契约钉值 ══════════════════════
console.log("\n[verify] ── C 常量契约钉值");
ok(WALK_LIMITS.maxMs === 120_000, `C WALK_LIMITS.maxMs === 120000（实际 ${WALK_LIMITS.maxMs}）`);
ok(WALK_LIMITS.maxFiles === 50_000, `C WALK_LIMITS.maxFiles === 50000（原 20000 文件上限先于时间上限到点，实际 ${WALK_LIMITS.maxFiles}）`);

// ── 收尾 ──
restoreClock();
try {
  fs.rmSync(tmpBase, { recursive: true, force: true });
  console.log("[verify] 临时夹具已删除");
} catch {
  console.log(`[verify] 临时夹具删除失败（Windows 偶发占用，残留无害）：${tmpBase}`);
}
console.log(`\n[verify] 结果：${pass} PASS / ${fail} FAIL`);
if (fail > 0) process.exitCode = 1;
