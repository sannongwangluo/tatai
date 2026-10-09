// A4 验证脚本（用 tsx 跑）：逐级下钻 + 懒加载 + 布局记忆。
// 用法：pnpm verify:a4
// 覆盖点（对应 A4 卡 DoD 逐条）：
//   ① 原地展开（UI 段 playwright 截图证明，见 .工作台/verify/a4-*.png）；
//   ② 逐级下钻到文件级、文件层纯静态 LLM 零参与：临时夹具 + 塔台 src/server 真跑，
//      断言子节点名 = 真实文件名、llm_calls 恒 0、expand.ts 不 import 任何 flash 模块（源码级红线检查）；
//   ③ 懒加载：stats.parsed_files 全部落在被展开子树内，子树外源码文件（outside/o.ts）零解析（贴清单对照）；
//   ④ 布局记忆：layoutStore 写→读坐标逐字节一致、合并写不丢旧键；HTTP PUT→GET 回环；
//      模拟「拖动落盘 → 重渲染合并」断言已有节点坐标逐字节一致、新节点有坐标且不重叠；
//      UI 段拖乱 → 刷新 → 坐标对照（python playwright，见 a4-05-restored.png 输出）；
//   ⑤ 展开子树只局部重排：layoutSubtree 单测——子树排布后全局已有节点坐标不变（调用方只 merge 子级）。
import { execSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expandDirectory } from "../src/arch/expand";
import { readModules, walkFiles } from "../src/arch/parse";
import { readLayoutByRoot, savePositionsByRoot, type ArchLayoutFile } from "../src/arch/layoutStore";
import type { GraphMode } from "../src/arch/graph-mode";
import { addProject } from "../src/server/registry";
import { ensureSelfRegistered, finish, realHome } from "./lib/fixtures";
import {
  FILE_NODE_HEIGHT,
  FILE_NODE_WIDTH,
  NODE_HEIGHT,
  NODE_WIDTH,
  layoutSubtree,
  layoutWithDagre,
} from "../src/ui/arch/layout";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HTTP_PORT = 8796;
const BASE = `http://localhost:${HTTP_PORT}`;
const REAL_DATA_DIR = realHome(); // TATAI_HOME > 缺省 ~/.tatai（脚本不写死作者本机路径）
ensureSelfRegistered(REAL_DATA_DIR); // 塔台自身＝本仓库：幂等登记，脚本换台机器也能跑
const VERIFY_DIR = path.join(REPO_ROOT, ".工作台", "verify");

const ok = (cond: boolean, label: string) => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (!cond) process.exitCode = 1;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 取回一个目录的**全部**直接子级（含被单枝上限聚合掉的那些）。
 *
 * 2026-10-06 定向更新（五要素留档）：
 *   旧前提＝「一次 `expandDirectory` 就给出该目录的全部直接子级」｜依据＝A4 下钻层单枝硬上限
 *   `ARCH_LIMITS.MAX_CHILDREN = 40`（src/arch/config.ts:20）——超限子级截断并合并为 `__more__`
 *   聚合节点（§4.3 第 1 招）；`src/server/work` 本批增至 54 个直接子级 ⇒ 一次调用只给 39 个文件
 *   ＋1 个聚合节点，余下 15 个文件永远进不了叶子集合（实测 74 ≠ 89）｜
 *   新前提＝按 §3.3「被聚合的分组必须能从聚合入口展开并找到它的每个成员」用 `childrenOffset`
 *   稳定分页逐页取回（offset 模式不返回聚合节点、全是真实子级），取到 `children_has_more` 为假为止｜
 *   保留意图＝下面的等式断言仍是**逐路径相等**，一条都不放松｜
 *   判据不放宽＝等式两侧口径未动，只是把取回手段从「一次调用」换成「同一契约的分页取全」。
 */
type ExpandChild = ReturnType<typeof expandDirectory>["children"][number];

function childrenAll(root: string, rel: string): ExpandChild[] {
  const first = expandDirectory(root, rel);
  if (first.truncated.children === 0) return first.children;
  const all: ExpandChild[] = [];
  for (let offset = 0; ; ) {
    const page = expandDirectory(root, rel, { childrenOffset: offset });
    all.push(...page.children);
    if (page.children.length === 0 || page.children_has_more !== true) break;
    offset += page.children.length;
  }
  return all;
}

/**
 * 递归下钻收集"文件叶子"的相对路径集合（供下钻终点语义断言用）：
 * dir 子级继续钻、file 子级收进集合、aggregate（超上限聚合节点）不算文件叶子。
 * 用途：把"下钻到文件级的终点语义"表达成**与仓库布局无关**的判据——
 * 递归下钻得到的叶子集合，应当等于该目录（含子层）在磁盘上的真实文件集合。
 */
function collectFileLeaves(root: string, rel: string, acc: string[] = [], depth = 0): string[] {
  for (const c of childrenAll(root, rel)) {
    if (c.kind === "dir") {
      if (depth < 12) collectFileLeaves(root, c.path, acc, depth + 1);
    } else if (c.kind === "file") {
      acc.push(c.path);
    }
  }
  return acc;
}

async function waitUp(url: string, label: string, tries = 100): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok || r.status === 404) {
        upPorts.add(Number(new URL(url).port));
        return;
      }
    } catch {
      // 还没起来，继续等
    }
    await sleep(200);
  }
  throw new Error(`${label} 20 秒内未就绪`);
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
function watchChild(
  proc: ChildProcess,
  port: number,
  isUp: () => boolean,
  label = "后端",
): void {
  proc.once("exit", async (code) => {
    if (isUp()) return; // 脚本自己收尾杀的，不算异常
    const why = (await portListening(port))
      ? `端口 ${port} 被占用`
      : `进程提前退出（code=${code}）`;
    console.error(`[verify] ${label}起不来：${why}，先清理残留进程`);
    process.exit(1);
  });
}

/** 端口是否被占（占用则不起自己的服务，避免碰用户的 dev server） */
async function portBusy(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(800) });
    return true;
  } catch {
    return false;
  }
}

function main(): void {
  // ── 源码级红线：expand.ts 不 import 任何 flash/LLM 模块（§4.1 文件层纯静态）──
  const expandSrc = fs.readFileSync(path.join(REPO_ROOT, "src", "arch", "expand.ts"), "utf8");
  ok(
    !/from\s+"[^"]*flash|from\s+"[^"]*name|chatStream|deepseek/i.test(expandSrc),
    "② 红线：src/arch/expand.ts 不 import flash/name/LLM 模块（源码级检查）",
  );

  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-a4-verify-"));
  try {
    // ── ②③ 临时夹具：下钻到文件级 + 懒加载对照 ──────────────────────
    console.log("[verify] ── ②③ 临时夹具（文件级下钻 + 懒加载对照）");
    const proj = path.join(tmpBase, "proj-expand");
    fs.mkdirSync(path.join(proj, "src", "sub"), { recursive: true });
    fs.mkdirSync(path.join(proj, "outside"), { recursive: true });
    fs.writeFileSync(
      path.join(proj, "src", "a.ts"),
      'import { s } from "./sub/s";\nimport { b } from "./b";\nconst q = require("./sub/s");\nimport { out } from "../outside/o";\nexport const a = 1;\n',
      "utf8",
    );
    fs.writeFileSync(path.join(proj, "src", "b.ts"), "export const b = 1;\n", "utf8");
    fs.writeFileSync(path.join(proj, "src", "sub", "s.ts"), "export const s = 1;\n", "utf8");
    fs.writeFileSync(path.join(proj, "src", "note.txt"), "非源码文件也成文件节点\n", "utf8");
    fs.writeFileSync(path.join(proj, "outside", "o.ts"), "export const out = 1;\n", "utf8");

    const r = expandDirectory(proj, "src");
    const names = r.children.map((c) => c.name).sort();
    ok(
      JSON.stringify(names) === JSON.stringify(["a.ts", "b.ts", "note.txt", "sub"]),
      `② 直接子级 = 子目录 + 文件（文件名即名字）：${names.join(", ")}`,
    );
    const sub = r.children.find((c) => c.name === "sub")!;
    const aTs = r.children.find((c) => c.name === "a.ts")!;
    ok(sub.kind === "dir" && sub.leaf === false, "② 子目录成子模块节点（可继续下钻，非叶子）");
    ok(
      r.children.filter((c) => c.kind === "file").every((c) => c.leaf),
      "② 文件节点全部 leaf=true（文件级再往下钻 = 无子级）",
    );
    ok(r.llm_calls === 0, "② 响应 llm_calls 恒 0（文件层 LLM 零参与）");
    ok(
      aTs.deps.find((d) => d.to === "src-sub")?.weight === 2 &&
        aTs.deps.find((d) => d.to === "src-b-ts")?.weight === 1,
      `② 子级间 import 边聚合精确：a.ts→sub 权重 2（import+require）、a.ts→b.ts 权重 1（实际 ${JSON.stringify(aTs.deps)}）`,
    );
    ok(
      r.external.some((e) => e.from === "src-a-ts" && e.to_path === "outside/o.ts" && e.weight === 1),
      `② 对外边只记目标路径（a.ts → outside/o.ts，实际 ${JSON.stringify(r.external)}）`,
    );
    // 懒加载硬证据：被解析的文件全部落在 src/ 子树内；outside/o.ts 是源码但零解析
    ok(
      r.stats.parsed_files.length > 0 && r.stats.parsed_files.every((f) => f.startsWith("src/")),
      `③ 懒加载：parsed_files 全部落在被展开子树内（${JSON.stringify(r.stats.parsed_files)}）`,
    );
    ok(
      !r.stats.parsed_files.includes("outside/o.ts"),
      "③ 懒加载：子树外源码文件 outside/o.ts 零解析（不展开不解析）",
    );
    console.log(
      `[verify]   计时：parse_ms=${r.parse_ms}（${r.stats.parsed_files.length} 文件），duration_ms=${r.duration_ms}，imports=${r.stats.imports}`,
    );
    // 逐级下钻第二级：src/sub → 只剩 s.ts 一个叶子
    const r2 = expandDirectory(proj, "src/sub");
    ok(
      r2.children.length === 1 && r2.children[0].name === "s.ts" && r2.children[0].leaf,
      "② 逐级下钻第二级：src/sub 展开 → 只剩 s.ts 叶子",
    );

    // ── ② 下钻终点语义（**用例自建夹具**：与仓库目录结构解耦）─────────────
    // 要验的语义：当某层目录**不再有子目录**时，其文件都作为叶子出现、可在文件层停住。
    // 原文把"塔台 src/server 没有子目录"当成前提——V06-01/02/03 按设计在 src/server 下加了
    // work/ 子目录后这个前提过期，断言随之变红（不是功能坏了）。改成自己造两种形态的目录：
    //   leafdir/（无子目录：3 个文件）  mixed/（一层子目录 inner/ + 直属文件）
    // 此后无论仓库怎么长，这条语义都有判据；仓库真实目录的覆盖改由下面那条"叶子集合对账"承担。
    console.log("\n[verify] ── ② 下钻终点语义（自建夹具：无子目录 / 带一层子目录）");
    const drill = path.join(tmpBase, "proj-drill-endpoint");
    fs.mkdirSync(path.join(drill, "leafdir"), { recursive: true });
    fs.mkdirSync(path.join(drill, "mixed", "inner"), { recursive: true });
    for (const f of ["a.ts", "b.txt", "c.ts"]) {
      fs.writeFileSync(path.join(drill, "leafdir", f), "export const x = 1;\n", "utf8");
    }
    fs.writeFileSync(path.join(drill, "mixed", "m.ts"), "export const m = 1;\n", "utf8");
    fs.writeFileSync(path.join(drill, "mixed", "inner", "i.ts"), "export const i = 1;\n", "utf8");

    const leafDir = expandDirectory(drill, "leafdir");
    ok(
      leafDir.children.length === 3 && leafDir.children.every((c) => c.kind === "file" && c.leaf),
      `② 无子目录的目录：直属文件**全部是叶子**＝下钻终点（${leafDir.children.map((c) => c.name).join(", ")}）`,
    );
    const mixedDir = expandDirectory(drill, "mixed");
    ok(
      mixedDir.children.some((c) => c.kind === "dir" && c.leaf === false) &&
        mixedDir.children.some((c) => c.kind === "file" && c.leaf === true),
      "② 带一层子目录：子目录**不是**叶子（可续钻）、同级文件仍是叶子（两种形态区分得开）",
    );
    const innerDir = expandDirectory(drill, "mixed/inner");
    ok(
      innerDir.children.length === 1 && innerDir.children.every((c) => c.kind === "file" && c.leaf),
      "② 下钻到第二级（同样无子目录）：文件全部是叶子（终点语义逐级收敛）",
    );

    // ── ②③ 真实塔台：src/server 展开 → 真实文件名、零 LLM、懒加载 ─────
    console.log("\n[verify] ── ②③ 真实塔台 src/server 展开");
    const rt = expandDirectory(REPO_ROOT, "src/server");
    const realNames = rt.children.map((c) => c.name);
    ok(
      realNames.includes("registry.ts") && realNames.includes("onboard.ts") && realNames.includes("index.ts"),
      `② 塔台 src/server 子节点含真实文件名（registry.ts/onboard.ts/index.ts…，共 ${realNames.length} 个）`,
    );
    ok(rt.llm_calls === 0, "② 塔台 src/server 展开 llm_calls = 0（flash 计数零）");
    // 原断言「src/server 无子目录 → 全部文件叶子」把**仓库当时的布局**当前提，前提到期即误报
    // （V06-01/02/03 已按设计新增 src/server/work/）。改成**只管语义、不管布局**：
    // 递归下钻得到的文件叶子集合，应当等于该目录（含子层）在磁盘上的真实文件集合。
    const serverLeaves = collectFileLeaves(REPO_ROOT, "src/server").sort();
    const serverDiskFiles = walkFiles(path.join(REPO_ROOT, "src", "server"))
      .map((f) => `src/server/${f}`)
      .sort();
    ok(
      rt.children.every((c) => c.kind !== "aggregate") &&
        serverLeaves.length >= 30 &&
        JSON.stringify(serverLeaves) === JSON.stringify(serverDiskFiles),
      `② 真实塔台 src/server：递归下钻的文件叶子集合 == 该目录含子层的真实文件集合` +
        `（${serverLeaves.length} 个叶子 / ${serverDiskFiles.length} 个磁盘文件，不假定有无子目录）`,
    );
    ok(
      rt.stats.parsed_files.every((f) => f.startsWith("src/server/")),
      `③ 懒加载：塔台全项目源码远不止这些，parsed_files 只含 src/server（${rt.stats.parsed_files.length} 个文件，parse_ms=${rt.parse_ms}）`,
    );
    ok(
      rt.children.some((c) => c.deps.length > 0),
      `② 子树内真实依赖边存在（如 index.ts → 兄弟文件，共 ${rt.children.reduce((n, c) => n + c.deps.length, 0)} 条聚合边）`,
    );

    // ── ④ 布局记忆逻辑层：写→读逐字节一致、合并不丢旧键、损坏报错（F4 起按视图分键）──────
    console.log("\n[verify] ── ④ 布局记忆（layoutStore 逻辑层；F4 起 positions 按视图分键）");
    const layRoot = path.join(tmpBase, "proj-layout");
    fs.mkdirSync(layRoot, { recursive: true });
    /** 取某个视图的坐标桶（缺省视图 = MODULE_BOX，A4 时代唯一的那个视图） */
    const posOf = (f: ArchLayoutFile, m: GraphMode = "MODULE_BOX") => f.positions[m] ?? {};
    ok(
      Object.keys(readLayoutByRoot(layRoot).positions).length === 0,
      "④ 缺 layout.json → 空 positions 空态（不报错）",
    );
    const p1 = { "src-server": { x: 123.5, y: -45.25 } };
    const saved1 = savePositionsByRoot(layRoot, p1);
    const back1 = readLayoutByRoot(layRoot);
    ok(
      JSON.stringify(posOf(back1)) === JSON.stringify(p1),
      "④ 写→读坐标逐字节一致（JSON 序列化级相等）",
    );
    ok(
      back1.version === 2 && Object.keys(back1.positions).join() === "MODULE_BOX",
      "④ 磁盘结构 v2：{version:2, positions:{MODULE_BOX:{…}}}（F4 按视图分键，缺省写在 MODULE_BOX 桶）",
    );
    ok(fs.existsSync(saved1.source) && saved1.source.endsWith(path.join(".工作台", "arch", "layout.json")), `④ 落盘路径 = .工作台/arch/layout.json`);
    savePositionsByRoot(layRoot, { "src-ui": { x: 0, y: 200 } });
    const back2 = readLayoutByRoot(layRoot);
    ok(
      posOf(back2)["src-server"].x === 123.5 && posOf(back2)["src-ui"].y === 200,
      "④ 合并写：新键补入、旧键原位不丢（已有节点保持原位）",
    );
    fs.writeFileSync(path.join(layRoot, ".工作台", "arch", "layout.json"), "{bad json", "utf8");
    let corrupted = false;
    try {
      readLayoutByRoot(layRoot);
    } catch {
      corrupted = true;
    }
    ok(corrupted, "④ layout.json 损坏 → 可读错误（不抛裸栈）");

    // ── ④ 模拟「拖动落盘 → 重渲染合并」：已有节点逐字节一致、新节点补位不重叠 ──
    console.log("\n[verify] ── ④ 布局复原 + 新节点补位（前端合并口径模拟）");
    const layRoot2 = path.join(tmpBase, "proj-layout2");
    fs.mkdirSync(layRoot2, { recursive: true });
    const topNodes = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const topEdges = [{ from: "a", to: "b" }];
    // 用户拖过 a → 落盘；重渲染（结构变化加了 c）→ dagre 全量补位 → layout.json 覆盖
    savePositionsByRoot(layRoot2, { a: { x: 999.5, y: 888.25 } });
    const layoutBack = readLayoutByRoot(layRoot2);
    const dagrePos = Object.fromEntries(
      layoutWithDagre(topNodes, topEdges).map((p) => [p.id, { x: p.x, y: p.y }]),
    );
    const merged = { ...dagrePos, ...posOf(layoutBack) };
    ok(
      merged.a.x === 999.5 && merged.a.y === 888.25,
      "④ 重渲染后已拖动节点坐标逐字节一致（layout.json 复原）",
    );
    ok(
      Number.isFinite(merged.b.x) && Number.isFinite(merged.c.x),
      "④ 新节点（无位置记录）由 dagre 补位、坐标有限",
    );
    const overlap = (i: string, j: string) =>
      merged[i].x < merged[j].x + NODE_WIDTH &&
      merged[j].x < merged[i].x + NODE_WIDTH &&
      merged[i].y < merged[j].y + NODE_HEIGHT &&
      merged[j].y < merged[i].y + NODE_HEIGHT;
    ok(!overlap("b", "c"), "④ dagre 补位的新节点之间不重叠");

    // ── ⑤ 展开子树只局部重排：layoutSubtree 产出只含子级、坐标在父节点右侧 ──
    console.log("\n[verify] ── ⑤ 子树局部重排（layoutSubtree）");
    const globalPos = { a: { x: 24, y: 24 }, b: { x: 600, y: 24 } };
    const laid = layoutSubtree(
      [
        { id: "a-f1", kind: "file" },
        { id: "a-f2", kind: "file" },
        { id: "a-sub", kind: "dir" },
      ],
      [{ from: "a-sub", to: "a-f1" }],
      globalPos.a,
    );
    const laidMap = Object.fromEntries(laid.map((p) => [p.id, p]));
    ok(laid.length === 3, "⑤ 局部重排只产出子级坐标（3 个，不碰全局）");
    ok(
      laid.every((p) => p.x >= globalPos.a.x + NODE_WIDTH),
      "⑤ 子树整体排在父节点右侧（原地长出不回叠父节点）",
    );
    ok(
      laidMap["a-sub"].x + NODE_WIDTH <= laidMap["a-f1"].x,
      "⑤ 子树内部按依赖方向分层（a-sub 在 a-f1 左侧）",
    );
    // 全局坐标不在返回集内 → 调用方 merge 后 a/b 原位（⑤ 的契约）
    ok(!("a" in laidMap) && !("b" in laidMap), "⑤ 全局已有节点不在重排结果内（保持原位的契约）");
    void FILE_NODE_WIDTH;
    void FILE_NODE_HEIGHT;

    // ── ②③④ HTTP 全链路（临时数据目录 + 夹具项目）────────────────
    console.log("\n[verify] ── HTTP 全链路（arch/expand + arch/layout）");
    const dataDir = path.join(tmpBase, "home");
    fs.mkdirSync(dataDir, { recursive: true });
    addProject({ id: "p-a4", name: "A4 验证项目", path: proj, kind: "backend" }, dataDir);
    const child: ChildProcess = spawn(
      process.execPath,
      ["--import", "tsx", path.join("src", "server", "index.ts")],
      {
        env: { ...process.env, TATAI_HOME: dataDir, TATAI_PORT: String(HTTP_PORT) },
        stdio: ["ignore", "pipe", "pipe"],
        cwd: REPO_ROOT,
      },
    );
    child.stderr?.on("data", (d: Buffer) => process.stderr.write(`[server] ${d}`));
    watchChild(child, HTTP_PORT, () => upPorts.has(HTTP_PORT)); // 子进程早退（EADDRINUSE）立刻报错退出
    try {
      void waitUp(`${BASE}/health`, "后端")
        .then(async () => {
          // POST arch/expand → 真实子级 + llm_calls 0
          const r1 = await fetch(`${BASE}/api/projects/p-a4/arch/expand`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ module_path: "src" }),
          });
          const b1 = (await r1.json()) as {
            ok: boolean;
            result: { children: { name: string }[]; llm_calls: number; stats: { parsed_files: string[] } };
          };
          ok(
            r1.status === 200 && b1.ok && b1.result.children.some((c) => c.name === "a.ts"),
            "HTTP POST arch/expand → 200 + 真实文件子节点",
          );
          ok(b1.result.llm_calls === 0, "HTTP arch/expand 响应 llm_calls = 0");
          ok(
            b1.result.stats.parsed_files.every((f) => f.startsWith("src/")),
            "HTTP 懒加载：parsed_files 全部在子树内",
          );

          // 非法路径 → 400；缺 module_path → 400；伪造项目 → 404
          const rBad = await fetch(`${BASE}/api/projects/p-a4/arch/expand`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ module_path: "../escape" }),
          });
          ok(rBad.status === 400, "HTTP 路径跳出项目根 → 400");
          const rMiss = await fetch(`${BASE}/api/projects/p-a4/arch/expand`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({}),
          });
          ok(rMiss.status === 400, "HTTP 缺 module_path → 400");
          const r404 = await fetch(`${BASE}/api/projects/no-such/arch/expand`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ module_path: "src" }),
          });
          ok(r404.status === 404, "HTTP 伪造项目 id → 404");

          // layout 回环：GET 空态 → PUT 合并写 → GET 读回逐字节一致 → 坏坐标 400（F4 起带 mode）
          const g0 = await fetch(`${BASE}/api/projects/p-a4/arch/layout`);
          const gb0 = (await g0.json()) as { ok: boolean; layout: { positions: Record<string, unknown> } };
          ok(g0.status === 200 && Object.keys(gb0.layout.positions).length === 0, "HTTP GET arch/layout 空态 positions={}");
          const put = await fetch(`${BASE}/api/projects/p-a4/arch/layout`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ mode: "MODULE_BOX", positions: { "src-a-ts": { x: 11.5, y: 22.75 } } }),
          });
          ok(put.status === 200, "HTTP PUT arch/layout {mode:MODULE_BOX} → 200");
          const g1 = await fetch(`${BASE}/api/projects/p-a4/arch/layout`);
          const gb1 = (await g1.json()) as {
            layout: { version: number; positions: Record<string, Record<string, { x: number; y: number }>> };
          };
          ok(
            gb1.layout.version === 2 &&
              gb1.layout.positions.MODULE_BOX["src-a-ts"].x === 11.5 &&
              gb1.layout.positions.MODULE_BOX["src-a-ts"].y === 22.75,
            "HTTP PUT→GET 坐标逐字节一致（布局记忆回环，坐标落在 MODULE_BOX 桶）",
          );
          const putFlow = await fetch(`${BASE}/api/projects/p-a4/arch/layout`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ mode: "DATA_FLOW", positions: { "src-a-ts": { x: 77, y: 88 } } }),
          });
          const gb2 = (await (await fetch(`${BASE}/api/projects/p-a4/arch/layout`)).json()) as {
            layout: { positions: Record<string, Record<string, { x: number; y: number }>> };
          };
          ok(
            putFlow.status === 200 &&
              gb2.layout.positions.DATA_FLOW["src-a-ts"].x === 77 &&
              gb2.layout.positions.MODULE_BOX["src-a-ts"].x === 11.5,
            "HTTP 按视图分键写：DATA_FLOW 桶写入后 MODULE_BOX 桶原样不动（F4 DoD②，两视图互不覆盖）",
          );
          const putBadMode = await fetch(`${BASE}/api/projects/p-a4/arch/layout`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ mode: "NOT_A_VIEW", positions: { n1: { x: 1, y: 2 } } }),
          });
          ok(putBadMode.status === 400, "HTTP 非法视图键 → 400（视图键是外部输入，必须校验）");
          ok(
            fs.existsSync(path.join(proj, ".工作台", "arch", "layout.json")),
            "HTTP PUT 真实落盘 <项目根>/.工作台/arch/layout.json",
          );
          const putBad = await fetch(`${BASE}/api/projects/p-a4/arch/layout`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ positions: { n1: { x: "bad" } } }),
          });
          ok(putBad.status === 400, "HTTP 非法坐标 → 400");

          await uiPlaywright();
        })
        .catch((e: Error) => {
          console.error("[verify] 异常:", e);
          process.exitCode = 1;
        })
        .finally(() => {
          child.kill();
          fs.rmSync(tmpBase, { recursive: true, force: true });
          finish();
          // Windows 上 pnpm/cmd 壳的 vite 子进程会挂住事件循环，强制收尾（遗留 vite 由端口复查兜底）
          setTimeout(() => process.exit(process.exitCode ?? 0), 300).unref();
        });
    } catch (e) {
      child.kill();
      throw e;
    }
  } catch (e) {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    throw e;
  }
}

/** ①④ UI 段：后端 8787 + vite（5173），python playwright 展开/折叠/拖动/刷新截图。
 *  8787 若已有服务在跑（用户自己的 dev server），先探它是否带 A4 新路由：带则复用（绝不杀），不带则跳过。 */
async function uiPlaywright(): Promise<void> {
  console.log("\n[verify] ── ①④ UI 段（python playwright，8787 + 5173）");
  let backend: ChildProcess | null = null;
  if (await portBusy("http://localhost:8787/health")) {
    // 已占用：探测是否是带 A4 路由的塔台后端（tsx watch 热加载场景）
    let reusable = false;
    try {
      const probe = await fetch("http://localhost:8787/api/projects/tatai/arch/expand", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ module_path: "src/server" }),
        signal: AbortSignal.timeout(5000),
      });
      const pb = (await probe.json()) as { ok?: boolean; result?: { llm_calls?: number } };
      reusable = probe.status === 200 && pb.ok === true && pb.result?.llm_calls === 0;
    } catch {
      reusable = false;
    }
    if (!reusable) {
      console.log("[verify] FAIL UI 段：8787 被占用且不带 A4 路由（不是可复用的塔台后端，不碰）");
      process.exitCode = 1;
      return;
    }
    console.log("[verify] 8787 已有带 A4 路由的塔台后端在跑（用户 dev server，复用不杀）");
  }
  if (await portBusy("http://localhost:5173/")) {
    console.log("[verify] SKIP UI 段：5173 已被占用（不碰）");
    process.exitCode = 1;
    return;
  }
  fs.mkdirSync(VERIFY_DIR, { recursive: true });
  // ── 骨架无关取形（2026-09-18）：UI 断言用的模块 id / 文件名全部按 A1+A4 实况动态取，不锚死旧骨架 ──
  //   modA = 第一个有 ≥2 个直属文件子级的顶层模块（原地展开立即可见真实文件名，前两个文件名做断言）；
  //   modM = 另一个「子目录里有直属文件」的模块（dirChild），供逐级下钻第二级到文件级（deepFile）；
  //   dragNode = 与前两者无关的任一顶层模块（拖动/刷新复原断言用）。
  const a1 = readModules("tatai", REAL_DATA_DIR);
  const modInfo =
    a1.arch?.modules.map((m) => {
      const r = expandDirectory(REPO_ROOT, m.path);
      const files = r.children.filter((c) => c.kind === "file");
      const dirChild = r.children.find(
        (c) => c.kind === "dir" && expandDirectory(REPO_ROOT, c.path).children.some((cc) => cc.kind === "file"),
      );
      return { m, fileA: files[0], fileB: files[1], dirChild };
    }) ?? [];
  const pickA = modInfo.find((x) => x.fileA && x.fileB);
  const pickM = modInfo.find((x) => x.m.id !== pickA?.m.id && x.dirChild);
  const deepFile = pickM?.dirChild
    ? expandDirectory(REPO_ROOT, pickM.dirChild.path).children.find((c) => c.kind === "file")
    : undefined;
  const dragNode = a1.arch?.modules.find((m) => m.id !== pickA?.m.id && m.id !== pickM?.m.id)?.id;
  if (!pickA?.fileA || !pickA.fileB || !pickM?.dirChild || !deepFile || !dragNode) {
    ok(false, "①④ UI 段前置：A1 modules.json / 可展开模块缺失（先跑 arch/parse）");
    return;
  }
  const pyPath = path.join(VERIFY_DIR, "a4-shot.py");
  fs.writeFileSync(
    pyPath,
    PY_SHOT.replaceAll("__MOD_A__", pickA.m.id)
      .replaceAll("__FILE_A__", pickA.fileA.path)
      .replaceAll("__FILE_A_NAME__", pickA.fileA.name)
      .replaceAll("__FILE_B_NAME__", pickA.fileB.name)
      .replaceAll("__MOD_M__", pickM.m.id)
      .replaceAll("__DIR_CHILD__", pickM.dirChild.id)
      .replaceAll("__DEEP_FILE__", deepFile.path)
      .replaceAll("__DRAG_NODE__", dragNode),
    "utf8",
  );

  if (!backend && !(await portBusy("http://localhost:8787/health"))) {
    backend = spawn(
      process.execPath,
      ["--import", "tsx", path.join("src", "server", "index.ts")],
      {
        env: { ...process.env, TATAI_HOME: REAL_DATA_DIR, TATAI_PORT: "8787" },
        stdio: ["ignore", "pipe", "pipe"],
        cwd: REPO_ROOT,
      },
    );
    backend.stderr?.on("data", (d: Buffer) => process.stderr.write(`[server:8787] ${d}`));
    watchChild(backend, 8787, () => upPorts.has(8787)); // 子进程早退（EADDRINUSE）立刻报错退出
  }
  const viteBin = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const vite = spawn(viteBin, ["dev", "--", "--port", "5173", "--strictPort"], {
    stdio: ["ignore", "pipe", "pipe"],
    cwd: REPO_ROOT,
    shell: process.platform === "win32",
  });
  vite.stderr?.on("data", (d: Buffer) => process.stderr.write(`[vite] ${d}`));
  // --strictPort 下 5173 被占会立刻退出，别拿错服务截图
  watchChild(vite, 5173, () => upPorts.has(5173), "vite 服务");
  // ── 布局记忆归零到已知基线（修 A4 拖动漂移欠债）─────────────────────────────
  // 欠债现场：a4-shot.py 早先按**屏幕像素**拖（fitView 的 scale 常压到 minZoom 0.2，270px 屏幕
  // 位移 = 1350 流程图坐标），历轮累积把 templates 顶到画布外（欠债现场 (2091.35, 2701.13)）→
  // 拖动断言时好时坏。修法两件：① 每次跑之前把本项目 layout.json 归零（空 positions = 全部走
  // dagre 兜底，起点确定，不再受上一轮残留坐标影响）；② python 侧改成"节点 DOM 中心起手 +
  // 按当前 zoom 换算的固定流程图位移"。现场保护：原文件快照留在下面 finally 里逐字节还原。
  const layoutPath = path.join(REPO_ROOT, ".工作台", "arch", "layout.json");
  const layoutSnapshot = fs.existsSync(layoutPath) ? fs.readFileSync(layoutPath, "utf8") : null;
  try {
    await waitUp("http://localhost:8787/health", "后端 8787");
    await waitUp("http://localhost:5173/", "vite 5173");
    fs.mkdirSync(path.dirname(layoutPath), { recursive: true });
    fs.writeFileSync(layoutPath, `${JSON.stringify({ version: 2, positions: {} }, null, 2)}\n`, "utf8");
    console.log(
      `[verify] 布局记忆已归零到已知基线（positions 空 → 全走 dagre 兜底）：${layoutPath}` +
        (layoutSnapshot ? `（原文件：${layoutSnapshot.replace(/\s+/g, " ").slice(0, 160)}）` : "（原本无文件）"),
    );
    console.log("[verify] 8787 + 5173 就绪，跑 playwright …");
    try {
      const out = execSync(`python "${pyPath}"`, { cwd: VERIFY_DIR, stdio: "pipe" }).toString();
      process.stdout.write(out);
      ok(out.includes("UI_ASSERT_ALL_PASS"), "①④ playwright UI 断言全过（展开/折叠/逐级/拖动刷新复原）");
    } catch (e) {
      process.stdout.write((e as { stdout?: Buffer }).stdout?.toString() ?? "");
      process.stderr.write((e as { stderr?: Buffer }).stderr?.toString() ?? "");
      ok(false, "①④ playwright UI 段执行失败（见上方输出）");
    }
    for (const shot of ["a4-01-overview.png", "a4-02-expand-server.png", "a4-03-deeper.png", "a4-04-collapsed.png", "a4-05-restored.png"]) {
      ok(fs.existsSync(path.join(VERIFY_DIR, shot)), `UI 截图落盘 .工作台/verify/${shot}`);
    }
  } finally {
    // Windows 上 pnpm/cmd 壳杀不干净进程树，用 taskkill /T 连根拔（只杀自己起的 vite）
    if (process.platform === "win32" && vite.pid) {
      try {
        execSync(`taskkill /PID ${vite.pid} /T /F`, { stdio: "ignore" });
      } catch {
        // 已退出则忽略
      }
    } else {
      vite.kill();
    }
    backend?.kill(); // 只杀自己起的；复用的用户 dev server 不碰
    // 布局记忆现场还原（快照在跑 playwright 前拍；基线归零只服务于本次断言）
    if (layoutSnapshot === null) fs.rmSync(layoutPath, { force: true });
    else fs.writeFileSync(layoutPath, layoutSnapshot, "utf8");
    console.log("[verify] 布局记忆现场已按快照逐字节还原（基线归零只用于本次断言）");
    await sleep(500);
  }
}

const PY_SHOT = String.raw`# A4 UI 验证截图：塔台架构图 原地展开 → 逐级下钻 → 折叠回概览 → 拖乱刷新复原
# 骨架无关（2026-09-18）：要展开的模块/文件/拖动节点由 ts 侧按 A1+A4 实况算好注入
#（__MOD_A__/__FILE_A__/__FILE_A_NAME__/__FILE_B_NAME__/__MOD_M__/__DIR_CHILD__/__DEEP_FILE__/__DRAG_NODE__），
# 不硬编码会随骨架翻新漂移的模块 id。
import re
from playwright.sync_api import sync_playwright

OUT = "."
fails = []
# 拖动位移（**流程图坐标**里的固定量，与视口缩放无关）：由 ts 侧在跑本脚本前把 layout.json
# 归零到已知基线，起点因此确定；位移按当前 zoom 换算成屏幕像素再拖。
DRAG_FLOW = (240.0, 160.0)

def ok(cond, label):
    print(("[UI PASS] " if cond else "[UI FAIL] ") + label)
    if not cond:
        fails.append(label)

def translate_of(style):
    m = re.search(r"translate\((-?[\d.]+)px[, ]+(-?[\d.]+)px\)", style or "")
    return (float(m.group(1)), float(m.group(2))) if m else None

def viewport_zoom(page):
    """React Flow 视口当前缩放：节点 transform（流程图坐标）与屏幕像素的换算系数。
    按它换算拖动位移 → 位移永远是流程图坐标里的那个固定量，不受 fitView/minZoom 影响。"""
    transform = page.locator(".react-flow__viewport").evaluate("el => getComputedStyle(el).transform")
    m = re.match(r"matrix\(([-\d.e]+),\s*([-\d.e]+),\s*([-\d.e]+),\s*([-\d.e]+),", transform or "")
    if m:
        return float(m.group(1))
    m2 = re.search(r"scale\(([\d.]+)\)", transform or "")
    return float(m2.group(1)) if m2 else 1.0

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_context(viewport={"width": 1600, "height": 950}).new_page()
    page.goto("http://localhost:5173/#p/tatai", wait_until="domcontentloaded")
    page.wait_for_timeout(2500)
    page.locator('button[data-view="arch"]').click()
    # V06-08：§3.1 把「项目图」的默认落点切到「功能全景」；A3/A4 守的是技术详情那一层，
    # 所以这里显式进入「技术详情」——下面的断言、判据与阈值一个字都不动。
    page.locator('[data-project-view-tab="tech"]').click()
    page.wait_for_selector(".react-flow__node", timeout=20000)
    page.wait_for_timeout(1500)
    top_count = page.locator(".react-flow__node").count()
    print("[UI] 顶层节点数（默认全折叠）:", top_count)
    ok(5 <= top_count <= 15, "顶层 5-15 方块、默认全折叠（§3.3 规则 1/5）")
    page.screenshot(path=f"{OUT}/a4-01-overview.png")

    # ① 点展开钮 → 顶层模块原地长出子文件（不跳页不换图；模块/文件动态取）
    page.locator('[data-expand-toggle="__MOD_A__"]').click()
    page.wait_for_selector('[data-file-node="__FILE_A__"]', timeout=15000)
    page.wait_for_timeout(1200)
    n1 = page.locator(".react-flow__node").count()
    print("[UI] 展开 __MOD_A__ 后节点数:", n1)
    ok(n1 > top_count, "① 原地长出子节点（同画布节点数增加，URL 未变）")
    ok(page.url.endswith("#p/tatai"), "① 不跳页不换图（URL 不变）")
    texts = " ".join(page.locator(".react-flow__node").all_inner_texts())
    ok("__FILE_A_NAME__" in texts and "__FILE_B_NAME__" in texts,
       "② 子节点为真实文件名（__FILE_A_NAME__ / __FILE_B_NAME__，取自 A4 真实子级）")
    page.screenshot(path=f"{OUT}/a4-02-expand-server.png")

    # 逐级下钻第二级：另一模块 → 其子目录 → 文件（全部动态取）
    page.locator('[data-expand-toggle="__MOD_M__"]').click()
    page.wait_for_selector('[data-expand-toggle="__DIR_CHILD__"]', timeout=15000)
    page.wait_for_timeout(800)
    page.locator('[data-expand-toggle="__DIR_CHILD__"]').click()
    page.wait_for_selector('[data-file-node="__DEEP_FILE__"]', timeout=15000)
    page.wait_for_timeout(1200)
    ok(page.locator('[data-file-node="__DEEP_FILE__"]').count() == 1,
       "② 逐级下钻到第二级文件（__DEEP_FILE__）")
    page.screenshot(path=f"{OUT}/a4-03-deeper.png")

    # 可收起回概览：两级都折叠 → 回到顶层方块数
    page.locator('[data-expand-toggle="__MOD_M__"]').click()
    page.locator('[data-expand-toggle="__MOD_A__"]').click()
    page.wait_for_timeout(1000)
    n2 = page.locator(".react-flow__node").count()
    ok(n2 == top_count, f"④ 折叠回概览（节点数 {n2} == 顶层 {top_count}）")
    page.screenshot(path=f"{OUT}/a4-04-collapsed.png")

    # ④ 拖乱一个节点 → 刷新 → 位置复原
    # 拖动口径（2026-09-18 修欠债）：按**节点 DOM 中心的真实坐标**起手，位移按当前视口 zoom 换算成
    # 流程图坐标里的固定量（DRAG_FLOW）。早先按屏幕像素瞎拖：fitView 的 scale 常压到 minZoom 0.2，
    # 270px 屏幕位移 = 1350 流程图单位，历轮累积把被拖节点顶出画布 → 断言时好时坏。
    # ts 侧已在本次运行前把本项目 layout.json 归零到已知基线（空 positions → 全走 dagre 兜底）。
    node = page.locator('.react-flow__node[data-id="__DRAG_NODE__"]')
    before = translate_of(node.get_attribute("style"))
    zoom = viewport_zoom(page)
    canvas = page.locator("[data-arch-view]").bounding_box()
    box = node.bounding_box()
    cx, cy = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
    dx, dy = DRAG_FLOW[0] * zoom, DRAG_FLOW[1] * zoom
    print("[UI] 拖动：viewport zoom=%.3f 节点 DOM 中心=(%.0f,%.0f) 屏幕位移=(%.1f,%.1f) → 流程图位移=%s"
          % (zoom, cx, cy, dx, dy, DRAG_FLOW))
    in_canvas = (canvas["x"] <= cx <= canvas["x"] + canvas["width"]
                 and canvas["y"] <= cy <= canvas["y"] + canvas["height"])
    ok(in_canvas, "[UI] 拖动起点（节点 DOM 中心 %.0f,%.0f）落在画布可见范围内（基线归零后 fitView 全览）" % (cx, cy))
    page.mouse.move(cx, cy)
    page.mouse.down()
    page.mouse.move(cx + dx, cy + dy, steps=12)
    page.mouse.up()
    page.wait_for_timeout(1500)  # 等 debounce PUT 落盘
    after = translate_of(node.get_attribute("style"))
    moved = (round(after[0] - before[0], 1), round(after[1] - before[1], 1)) if before and after else None
    print("[UI] 拖动前:", before, "拖动后:", after, "流程图位移:", moved)
    ok(moved is not None and abs(moved[0] - DRAG_FLOW[0]) < 40 and abs(moved[1] - DRAG_FLOW[1]) < 40,
       "④ 拖动真实生效且位移可控（%s ≈ 设定 %s：按节点中心起手 + 按 zoom 换算，不随缩放漂）" % (moved, DRAG_FLOW))
    page.reload(wait_until="domcontentloaded")
    page.wait_for_timeout(2500)
    page.locator('button[data-view="arch"]').click()
    # V06-08：同上——刷新后仍要显式进「技术详情」才看得到方框图（默认落点是功能全景）
    page.locator('[data-project-view-tab="tech"]').click()
    page.wait_for_selector(".react-flow__node", timeout=20000)
    page.wait_for_timeout(1500)
    restored = translate_of(page.locator('.react-flow__node[data-id="__DRAG_NODE__"]').get_attribute("style"))
    print("[UI] 刷新后:", restored)
    ok(restored and abs(restored[0]-after[0]) < 1 and abs(restored[1]-after[1]) < 1,
       "④ 刷新后位置按 layout.json 复原（与拖动后坐标一致）")
    page.screenshot(path=f"{OUT}/a4-05-restored.png")
    browser.close()

print("UI_ASSERT_ALL_PASS" if not fails else f"UI_ASSERT_FAILS:{len(fails)}")
`;

try {
  main();
} catch (err) {
  console.error("[verify] 异常:", err);
  process.exitCode = 1;
}
