// N2 验证脚本（用 tsx 跑）：折叠展开 + 大项目性能（PLAN N2 卡 DoD①–④ + 卡上"跑偏点"红线）。
// 用法：pnpm verify:n2
//   真实项目段要跑：设 TATAI_HOME=<数据目录>、TATAI_ID_BIG / TATAI_BIG_BRANCHES、
//   TATAI_ID_MID / TATAI_MID_BRANCHES（缺哪个就 SKIP 哪段，脚本自己说清，不当 PASS）。
//
// 覆盖点：
//   ① 初次进入默认全部折叠、只见顶层（§3.3 规则 5）：数据层（无下钻 → 树 = 根 + 顶层模块、2 层、
//      expandedBranches=0）+ UI 段真读数（可见节点数 = 顶层 + 根、A4 懒加载 0 次、网络层 0 个 arch/expand）。
//   ② 未展开分支零解析（对照）：服务端每枝一行 `[arch/expand]`（本脚本收服务端 stdout 逐行计数）——
//      没点开的枝一行都不产生；点一枝只多一行，且 parsed 计数全部落在该枝子树内。
//   ③ 大项目性能 + 巨枝降级（**贴真实数字，不许"感觉流畅"**）：真实项目逐枝贴服务端 duration_ms/parse_ms、
//      客户端端到端 ms、带 markmap 渲染的端到端 ms；巨枝（上万文件的临时产物目录 / 上千文件的日志目录）
//      触发单枝硬上限截断 → 「还有 N 个」聚合节点，超上限的部分**不遍历、不解析、不渲染**；
//      并贴"若按旧口径全量遍历这枝要多久"（walkFiles 真跑）作为降级收益的对照。
//   ④ 折叠态刷新后保持：贴 `mindmap-fold.json` 前后内容 + UI 段刷新前后可见节点数/展开态逐项一致，
//      且刷新只补拉**落盘的那几枝**（补拉请求逐条对照，不是全量解析）。
//   ⑤ 折叠回落盘 + 逐级折叠零请求：点已展开的枝再点一次 = 纯折叠（可见节点数回落、请求数不变）、
//      再点回来零请求；「回顶层」按钮清空展开态并落盘；方框图侧点同一枝，聚合节点按同一份口径渲染
//      （N2 改了 ArchCanvas 对 A4 聚合节点的展示，这里补证：虚线块 + 「还有 N 个」+ 不可下钻）。
//   ⑥ 护栏：防爆炸截断实现仍全仓唯一（`expand.ts` 只调用不复制，源码级扫描）；折叠态落盘模块
//      （foldStore）往返/原子写/`其它项目键不被覆盖`/损坏文件按可读错误处理。
//
// 端口策略（照 verify-f4/n1 写法）：**不碰任何既有监听**——后端 bind 0 让系统分配，vite 同样动态选端口
// 并把后端端口经 TATAI_DEV_API_PORT 传进代理；起前探活、起后盯子进程早退；开头末尾各探一次 8787/5173
// （只记录状态，不杀别人的进程）。
// 隐私（AGENTS.md §5/§6）：真实项目只贴路径、结构与计数；本脚本唯一写盘 = 折叠态（就是 N2 的功能本身），
// 跑完把三个被点过的项目的 `mindmap-fold.json` **逐字节还原**（原来没有的删掉），截图落
// `.工作台/verify/n2-*.png`（gitignore）。
import { execSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ARCH_LIMITS } from "../src/arch/config";
import { expandDirectory } from "../src/arch/expand";
import { readFoldByRoot, readFoldFileByRoot, saveFoldByRoot } from "../src/arch/foldStore";
import { buildMindTree, toMarkdown } from "../src/arch/mindmap";
import { readNames } from "../src/arch/name";
import { readModules, walkFiles, IGNORED_SEGMENTS } from "../src/arch/parse";
import { buildSharedGraph } from "../src/arch/render";
import { capChildren } from "../src/arch/shared-graph";
import { getProject } from "../src/server/registry";
import { ensureSelfRegistered, finish, realHome, skip } from "./lib/fixtures";
import { SYNTH_HINT, applySynthN2 } from "./lib/synth";

// Q6：TATAI_SYNTH=1 且真实 env 没给 → 临时目录造授权合成夹具（临时 home + tatai/压测/中枝三个合成项目，
// 巨枝目录 100 个非源码文件平铺），必须在下面 realHome()/process.env 读取之前跑
applySynthN2();

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REAL_DATA_DIR = realHome(); // TATAI_HOME > 缺省 ~/.tatai（脚本不写死作者本机路径）
const VERIFY_DIR = path.join(REPO_ROOT, ".工作台", "verify");

/** 环境变量给的逗号分隔清单（脚本里不写死真实项目名与它的目录结构） */
const envList = (name: string): string[] =>
  (process.env[name] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");

const TATAI = "tatai";
/**
 * 压测项目（巨枝所在；PLAN N2 DoD③ 要 500+ 文件的真实项目）与中等项目（第二处巨枝对照）：
 * id 与其巨枝路径一律从环境变量读——`TATAI_ID_BIG` / `TATAI_BIG_BRANCHES`、
 * `TATAI_ID_MID` / `TATAI_MID_BRANCHES`（例：`TATAI_BIG_BRANCHES=.tmp,logs`）。
 * 没给 → 巨枝实测段与 UI 段 SKIP（如实打印，不当 PASS）。
 */
const BIG = process.env.TATAI_ID_BIG ?? "";
const BIG_BRANCHES = envList("TATAI_BIG_BRANCHES");
const MID = process.env.TATAI_ID_MID ?? "";
const MID_BRANCHES = envList("TATAI_MID_BRANCHES");
ensureSelfRegistered(REAL_DATA_DIR); // 塔台自身＝本仓库：幂等登记，脚本换台机器也能跑
/** UI 段要点的枝（顶层模块路径）：塔台 1 枝 + 各真实项目的巨枝 */
const TATAI_BRANCHES = ["src/ui"];
/** 小枝对照（未触发上限，验证"正常枝行为不变"） */
const SMALL_BRANCH: [string, string] = [TATAI, "src"];

const ok = (cond: boolean, label: string) => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (!cond) process.exitCode = 1;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fmt = (n: number) => `${n.toFixed(1)}ms`;

// ───────────────────────── 端口：探活 + 动态分配（与 verify-f4/n1 同一份写法） ─────────────────────────

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

/** 等 HTTP 就绪（IPv4 / IPv6 回环都试：vite 可能只监听 [::1]） */
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

function pipeOutput(child: ChildProcess, label: string, onStdoutLine?: (line: string) => void): void {
  child.stdout?.on("data", (d: Buffer) => {
    if (onStdoutLine) for (const line of d.toString().split(/\r?\n/)) if (line.trim()) onStdoutLine(line);
    process.stdout.write(`[${label}] ${d}`);
  });
  child.stderr?.on("data", (d: Buffer) => process.stderr.write(`[${label}] ${d}`));
}

/** 杀掉自己起的进程树（Windows 上不杀子进程会残留 vite） */
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
  onStdoutLine?: (line: string) => void,
): Promise<ChildProcess> {
  if (await portListening(port)) throw new Error(`${label} 端口 ${port} 已被占用（本脚本不碰既有监听，请重跑）`);
  const child = spawnFn(port);
  pipeOutput(child, `${label}:${port}`, onStdoutLine);
  child.once("exit", (code) => {
    if (!intentionalStop.has(port) && code !== 0) {
      console.error(`[verify] ${label}（端口 ${port}）意外退出：code=${code}（端口被抢？）`);
    }
  });
  await waitUpAny(readyUrls, `${label} ${port}`, { isAlive: () => child.exitCode === null });
  return child;
}

// ───────────────────────── ① ② 数据层：默认全折叠 + 巨枝截断夹具 ─────────────────────────

function checkDefaultCollapsed(): void {
  const project = getProject(TATAI, REAL_DATA_DIR);
  const built = buildSharedGraph(TATAI, { dataDir: REAL_DATA_DIR });
  if (!project || !built.exists || !built.graph) {
    skip(
      "① 默认全折叠的数据口径（塔台真实数据）",
      "塔台自身还没解析过：先跑一次 `pnpm verify:a1`（或在界面上点「先解析」）再重跑本脚本",
    );
    return;
  }
  // 无下钻结果 = 初次进入：树里只有根 + 顶层模块，没有任何第 3 层（§3.3 规则 5）
  const tree = buildMindTree(built.graph, { id: project.id, name: project.name }, new Map());
  console.log(
    `[verify]   塔台初次进入（无下钻）：树 ${tree.nodeCount} 节点 / ${tree.depth} 层 / 已展开 ${tree.expandedBranches} 枝 · ` +
      `markdown ${toMarkdown(tree.root).split("\n").filter((l) => l.startsWith("- ")).length} 行`,
  );
  ok(
    tree.nodeCount === built.graph.nodes.length + 1 && tree.depth === 2 && tree.expandedBranches === 0,
    `① 默认全折叠的数据口径：树 = 根 + 顶层 ${built.graph.nodes.length} 个模块 = ${tree.nodeCount} 节点 · 2 层 · 0 枝下钻（§3.3 规则 5）`,
  );
}

function checkCapFixture(): void {
  const many = Array.from({ length: 300 }, (_, i) => ({ name: `f${String(i).padStart(3, "0")}` }));
  const capped = capChildren(many, "fixture");
  const small = capChildren(many.slice(0, 10), "fixture");
  console.log(
    `[verify]   300 个子级夹具：保留 ${capped.kept.length} + 聚合「${capped.aggregate?.name}」 · 上限 ${capped.limit} · ` +
      `聚合节点 id=${capped.aggregate?.id}`,
  );
  ok(
    capped.truncated &&
      capped.limit === ARCH_LIMITS.MAX_CHILDREN &&
      capped.kept.length + capped.dropped === many.length &&
      capped.kept[0].name === "f000" &&
      capped.kept[capped.kept.length - 1].name === `f${String(ARCH_LIMITS.MAX_CHILDREN - 2).padStart(3, "0")}`,
    `① 单枝上限夹具：保留前 ${ARCH_LIMITS.MAX_CHILDREN - 1} 个（顺序不变）+ 聚合 ${capped.dropped} 个（§4.3 第 1 招同一招数）`,
  );
  ok(
    capped.aggregate?.name === `还有 ${capped.dropped} 个` && capped.aggregate.aggregate === true &&
      capped.aggregate.id === "__more__:fixture",
    `① 聚合节点 = 「${capped.aggregate?.name}」· id 带父级后缀（同图多巨枝不撞 id）：${capped.aggregate?.id}`,
  );
  ok(
    !small.truncated && small.kept.length === 10 && small.aggregate === null && small.dropped === 0,
    "① 未超上限的枝原样返回（不截断、不加聚合节点，正常项目行为不变）",
  );
}

// ───────────────────────── ③ 巨枝实测（服务端真跑）+ 全量遍历对照 ─────────────────────────

function checkGiantBranches(): void {
  if (BIG === "" || MID === "" || BIG_BRANCHES.length === 0 || MID_BRANCHES.length === 0) {
    skip(
      "③ 巨枝实测（两个 500+ 文件的真实项目）",
      `设 TATAI_ID_BIG / TATAI_BIG_BRANCHES / TATAI_ID_MID / TATAI_MID_BRANCHES（并让 TATAI_HOME 指向已登记它们的数据目录）后可跑，${SYNTH_HINT}`,
    );
    return;
  }
  /** 逐枝真跑：服务端口径（子级/截断/解析/耗时）+ 旧口径对照（把这枝全量走一遍要多久） */
  const run = (label: string, projectId: string, dir: string, wantTruncated: boolean) => {
    const project = getProject(projectId, REAL_DATA_DIR);
    if (!project) {
      skip(`③ ${label}`, `注册表里没有 ${projectId}：设 TATAI_HOME=<已登记它的数据目录> 后可跑，${SYNTH_HINT}`);
      return null;
    }
    const t0 = performance.now();
    const r = expandDirectory(project.path, dir);
    const wall = performance.now() - t0;
    // 旧口径对照（可复现）：把这枝**全量**走一遍（只走文件名，不解析）要多久 —— 截断省掉的就是它
    const tw0 = performance.now();
    const fullWalkFiles = dir === "." ? 0 : walkFiles(path.join(project.path, ...dir.split("/"))).length;
    const fullWalkMs = performance.now() - tw0;
    const aggregate = r.children.find((c) => c.kind === "aggregate");
    console.log(
      `[verify]   ${label}：子级 ${r.children.length}（截断 ${r.truncated.children} / 上限 ${r.limit.children}） · ` +
        `子树文件 ${r.stats.subtree_files} · 解析 ${r.stats.parsed_files.length} 个文件（parse ${fmt(r.parse_ms)}）· ` +
        `服务端 duration_ms=${r.duration_ms} / 脚本实测 ${fmt(wall)} · ` +
        `（对照：全量遍历这枝 = ${fullWalkFiles} 个文件 / ${fmt(fullWalkMs)}，截断后这部分一个字都没走） · ` +
        `聚合节点「${aggregate?.name ?? "无"}」 · llm=${r.llm_calls}`,
    );
    ok(
      r.truncated.children > 0 === wantTruncated && r.children.length <= r.limit.children,
      `③ ${label}：子级 ${r.children.length} ≤ 单枝上限 ${r.limit.children}` +
        (wantTruncated ? `（截断 ${r.truncated.children} 个 → 图上留「${aggregate?.name}」聚合节点）` : "（未触发上限）"),
    );
    ok(
      r.stats.subtree_files < fullWalkFiles || !wantTruncated,
      `③ ${label}：被截断的部分**没有遍历**（本次只算了 ${r.stats.subtree_files} 个文件，全量是 ${fullWalkFiles} 个）`,
    );
    ok(
      r.duration_ms < 1500,
      `③ ${label}：整枝展开 ${r.duration_ms}ms < 1500ms 阈值（对照：光全量遍历这枝的文件名清单就要 ${fmt(fullWalkMs)}，` +
        `解析面更大；截断在遍历之前落地才拿得到这个数）`,
    );
    return { r, aggregate };
  };
  const big1 = BIG_BRANCHES[0] ? run(`压测项目 ${BIG_BRANCHES[0]}（巨枝）`, BIG, BIG_BRANCHES[0], true) : null;
  const big2 = BIG_BRANCHES[1] ? run(`压测项目 ${BIG_BRANCHES[1]}（巨枝）`, BIG, BIG_BRANCHES[1], true) : null;
  const mid1 = MID_BRANCHES[0] ? run(`中等项目 ${MID_BRANCHES[0]}（巨枝）`, MID, MID_BRANCHES[0], true) : null;
  const small = run(`塔台 ${SMALL_BRANCH[1]}（小枝，对照）`, SMALL_BRANCH[0], SMALL_BRANCH[1], false);
  // 小枝：子级数 = 目录真实直接子级数（不截断时行为与 A4 时代逐项一致）
  if (small) {
    const project = getProject(SMALL_BRANCH[0], REAL_DATA_DIR)!;
    const real = fs
      .readdirSync(path.join(project.path, ...SMALL_BRANCH[1].split("/")), { withFileTypes: true })
      .filter((e) => !(e.isDirectory() && IGNORED_SEGMENTS.has(e.name)) && !e.isSymbolicLink()).length;
    ok(
      small.r.children.length === real && small.aggregate === undefined,
      `③ 塔台 ${SMALL_BRANCH[1]}：子级 ${small.r.children.length} = 目录真实直接子级（未截断时与 A4 时代逐项一致，无聚合节点）`,
    );
    ok(small.r.stats.parsed_files.length > 0, `③ 塔台 ${SMALL_BRANCH[1]}：小枝照常解析（${small.r.stats.parsed_files.length} 个源码文件，懒加载只在被展开的子树内）`);
  }
  // 巨枝的解析面：被截断的枝里没有源码文件要解析 → 连全项目文件名清单都不走（第二个降级点）
  ok(
    big1 !== null && big1.r.stats.skipped_project_walk === true && big1.r.stats.parsed_files.length === 0,
    `③ 压测项目 ${BIG_BRANCHES[0]}：截断后无待解析文件 → 全项目文件名清单整趟跳过（skip_project_walk=true，语义不变：没有 import 需要判定）`,
  );
  ok(
    big2 !== null && mid1 !== null,
    `③ 两个 500+ 文件的真实项目巨枝都过了上限（压测项目 ${BIG_BRANCHES[1] ?? "-"} 截断 ${big2?.r.truncated.children} · 中等项目 ${MID_BRANCHES[0]} 截断 ${mid1?.r.truncated.children}）`,
  );
}

// ───────────────────────── ④ 折叠态落盘：往返 / 原子写 / 损坏处理 ─────────────────────────

function checkFoldStore(): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-n2-fold-"));
  try {
    ok(readFoldByRoot(root, "proj-a").length === 0, "④ 折叠态：文件不存在 → 空展开态（= 默认全折叠，不是错误）");
    const saved = saveFoldByRoot(root, "proj-a", [
      { id: "src-ui", path: "src/ui" },
      { id: "src-ui-arch", path: "src/ui/arch" },
    ]);
    const back = readFoldByRoot(root, "proj-a");
    ok(
      JSON.stringify(back) === JSON.stringify(saved.file.projects["proj-a"].expanded),
      `④ 折叠态往返：写 ${saved.file.projects["proj-a"].expanded.length} 条 → 读回逐条一致（${back.map((e) => e.id).join(" → ")}，父在子先）`,
    );
    ok(
      !fs.existsSync(`${saved.source}.tmp`) && saved.source.endsWith(path.join("arch", "mindmap-fold.json")),
      "④ 原子落盘：临时文件已 rename（无 .tmp 残留），落在 <项目根>/.工作台/arch/mindmap-fold.json",
    );
    saveFoldByRoot(root, "proj-b", [{ id: "logs", path: "logs" }]);
    const multi = readFoldFileByRoot(root);
    ok(
      multi.projects["proj-a"].expanded.length === 2 && multi.projects["proj-b"].expanded.length === 1,
      "④ 按项目 + 节点 id 记展开态：写另一个项目不覆盖已存的那份（两份键共存）",
    );
    saveFoldByRoot(root, "proj-a", []);
    ok(
      readFoldByRoot(root, "proj-a").length === 0 && readFoldByRoot(root, "proj-b").length === 1,
      "④ 折叠回概览 = 写空清单（本项目清空、别的项目不动）",
    );
    fs.writeFileSync(saved.source, "{ 坏文件", "utf8");
    let code = "";
    try {
      readFoldByRoot(root, "proj-a");
    } catch (e) {
      code = (e as { code?: string }).code ?? "?";
    }
    ok(code === "INVALID_INPUT", `④ 损坏文件按可读错误处理（WsError code=${code}），界面侧兜底成默认全折叠、不炸导图`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// ───────────────────────── ⑤ 源码级护栏 ─────────────────────────

function checkSourceGuard(): void {
  const read = (rel: string) => fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
  const expandSrc = read(path.join("src", "arch", "expand.ts"));
  // 防爆炸截断实现（数值 + 逻辑）全仓唯一 = 共用数据层；A4 只调用，不复制一套
  ok(
    !/ARCH_LIMITS|MORE_NODE_ID/.test(expandSrc) && /capChildren[<(]/.test(expandSrc),
    "⑥ 防爆炸截断实现仍全仓唯一：expand.ts 只调用 capChildren（不引上限数值标识、不自己算截断）",
  );
  const sharedSrc = read(path.join("src", "arch", "shared-graph.ts"));
  ok(
    sharedSrc.includes("export function capChildren") && sharedSrc.includes("MAX_CHILDREN"),
    "⑥ 单枝上限的数值与实现都落在共用数据层（config.ts 数值 + shared-graph.ts 实现，视图/A4 都只是调用方）",
  );
  const mindSrc = read(path.join("src", "arch", "mindmap.ts"));
  ok(
    !/ARCH_LIMITS|MORE_NODE_ID|readdirSync|foldStore/.test(mindSrc),
    "⑥ 导图取数口仍不碰上限数值/不扫目录/不落盘（N1 红线不变：折叠态是视图层的事，不进取数模块）",
  );
  const uiFoldCallers = ["src/ui/arch/MindMapView.tsx", "src/ui/api.ts"].filter((f) =>
    /mindmap-fold|MindMapExpandEntry/.test(read(path.join(...f.split("/")))),
  );
  ok(
    uiFoldCallers.length === 2,
    `⑥ 折叠态的唯一消费点 = 导图视图（${uiFoldCallers.join(" / ")}）：方框图/数据流向图不碰它`,
  );
}

// ───────────────────────── UI 段：playwright（动态端口 + 探活） ─────────────────────────

interface BranchSpec {
  /** 顶层模块路径（A4 入参） */
  path: string;
  /** 方框图/导图共用的节点 id = A1 模块 slug（方框图侧按它点展开钮） */
  nodeId: string;
  /** 节点在画布上的完整文字（`人话名 路径`，A2 起名缓存）：点击定位用，避免子级同名子串误命中 */
  label: string;
}
interface ProjectSpec {
  id: string;
  name: string;
  /** 顶层模块数（§3.3 规则 1：5–15） */
  top: number;
  branches: BranchSpec[];
  /** 是否做"刷新后折叠态保持"对照（塔台一处即可） */
  refresh: boolean;
  /** 方框图侧再看一眼同一枝：验证 A4 聚合节点在方框图上也按同一份口径渲染（N2 改了这块渲染） */
  boxBranch?: BranchSpec;
  shots: { top: string; afterFirst?: string; expanded?: string; restored?: string };
}

/** 顶层模块的展示文字 = A2 人话名 + 路径（与 toMarkdown 的 `**名** \`路径\`` 同一份口径）；
 *  节点 id 取 A1 模块 slug（方框图节点 id 与导图 payload id 同一口径，不另算）
 *  @param forBox 该枝是否也要在方框图侧点（那边要的是模块 id，路径走同一份 modules.json） */
function branchSpec(projectId: string, modulePath: string): BranchSpec {
  const project = getProject(projectId, REAL_DATA_DIR)!;
  const modules = readModules(projectId, REAL_DATA_DIR);
  const mod = modules.arch?.modules.find((m) => m.path === modulePath);
  const name = mod ? (readNames(project.path).entries[mod.id]?.name ?? mod.id) : modulePath;
  return { path: modulePath, nodeId: mod?.id ?? modulePath, label: `${name} ${modulePath}` };
}

async function uiPlaywright(spec: ProjectSpec[], viteEntry: string, backendPort: number): Promise<void> {
  fs.mkdirSync(VERIFY_DIR, { recursive: true });
  const pyPath = path.join(VERIFY_DIR, "n2-shot.py");
  fs.writeFileSync(pyPath, PY_SHOT, "utf8");
  let vitePort = 0;
  let vite: ChildProcess | null = null;
  for (let attempt = 1; attempt <= 3 && !vite; attempt++) {
    vitePort = await pickFreePort();
    const child = spawn(process.execPath, [viteEntry, "dev", "--port", String(vitePort), "--strictPort"], {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: REPO_ROOT,
      env: { ...process.env, TATAI_DEV_API_PORT: String(backendPort) },
    });
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
  const specPath = path.join(VERIFY_DIR, "n2-spec.json");
  fs.writeFileSync(specPath, JSON.stringify({ projects: spec, limit: ARCH_LIMITS.MAX_CHILDREN }, null, 2), "utf8");
  try {
    const out = execSync(`python "${pyPath}" ${vitePort} ${backendPort} "${specPath}"`, {
      cwd: VERIFY_DIR,
      stdio: "pipe",
      timeout: 600_000,
    }).toString();
    process.stdout.write(out);
    ok(out.includes("UI_ASSERT_ALL_PASS"), "④ UI 断言全过（默认折叠 / 巨枝截断 / 折叠零请求 / 刷新后保持）");
  } catch (e) {
    process.stdout.write((e as { stdout?: Buffer }).stdout?.toString() ?? "");
    process.stderr.write((e as { stderr?: Buffer }).stderr?.toString() ?? "");
    ok(false, "UI 段执行失败（见上方输出）");
  } finally {
    killTree(vite, vitePort);
    await sleep(500);
  }
  const shots = spec
    .flatMap((s) => [s.shots.top, s.shots.afterFirst, s.shots.expanded, s.shots.restored])
    .filter((s): s is string => !!s);
  for (const shot of shots) {
    ok(fs.existsSync(path.join(VERIFY_DIR, shot)), `UI 截图落盘 .工作台/verify/${shot}`);
  }
}

/** UI 段 python（与 verify-n1 同款 playwright 写法；本卡要跑的枝多、逐项要贴数字，参数改走一段 JSON） */
const PY_SHOT = String.raw`# N2 UI 验证：默认全折叠 / 逐枝懒加载 / 巨枝截断 / 折叠态刷新保持
# 用法：python n2-shot.py <vitePort> <backendPort> <spec.json>
# spec.json = {"limit": 40, "projects": [{id,name,top,branches:[{path,label}],refresh,shots:{...}}]}
import json
import re
import sys
import time

from playwright.sync_api import sync_playwright

VITE_PORT, BACKEND_PORT, SPEC_PATH = sys.argv[1], sys.argv[2], sys.argv[3]
SPEC = json.load(open(SPEC_PATH, encoding="utf-8"))
LIMIT = SPEC["limit"]
BASE = f"http://localhost:{VITE_PORT}"
OUT = "."
fails = []
expand_reqs = []   # 网络层 /arch/expand 请求：{module_path, ms}
step = {"now": "启动"}   # 当前步骤（页面 JS 异常按步骤归因）


def ok(cond, label):
    print(("[UI PASS] " if cond else "[UI FAIL] ") + label)
    if not cond:
        fails.append(label)


def attr(page, name):
    el = page.locator("[data-mindmap-view]").first
    return el.get_attribute(name) if el.count() else None


def num(page, name, default=-1):
    v = attr(page, name)
    return int(v) if v not in (None, "") else default


def visible(page):
    """画布上真渲染出来的节点数（折叠的子级不在 DOM 里：markmap 只为可见节点建 g）"""
    return page.locator("svg.markmap g[data-path]").count()


def load_log(page):
    v = attr(page, "data-mindmap-load-log")
    return json.loads(v) if v else []


def wait_arch(page, timeout=60000):
    page.wait_for_selector('button[data-view="arch"]', timeout=timeout)
    page.locator('button[data-view="arch"]').click()
    # V06-08：§3.1 把「项目图」默认落点切到「功能全景」；N2 守的是技术详情里的思维导图折叠态与
    # 懒加载日志，所以显式进入「技术详情」——断言、判据与阈值一个字都不动。
    page.locator('[data-project-view-tab="tech"]').click()
    page.wait_for_selector('[data-arch-mode="MODULE_BOX"]', timeout=timeout)


def open_mindmap(page):
    page.locator('[data-graph-mode="MIND_MAP"]').click()
    page.wait_for_selector("[data-mindmap-view]", timeout=60000)
    page.wait_for_selector("svg.markmap g[data-path]", timeout=60000)


def goto_project(page, pid, tries=3):
    """切到某项目并停在架构图：**带重试**（首版实测偶发一次加载卡住：有一个项目那次 60s 都没等到
    架构图 Tab，重跑同一步 2.8s 就好——环境/前一段重活留下的抖动，不是本卡的断言失败）。
    每次重试都重新 goto + reload；三次都等不到才算真失败。"""
    for i in range(1, tries + 1):
        page.goto(f"{BASE}/#p/{pid}", wait_until="domcontentloaded")
        page.reload(wait_until="domcontentloaded")
        try:
            wait_arch(page, timeout=45000 if i < tries else 90000)
            return
        except Exception as e:
            print(f"[UI]   切 {pid} 第 {i} 次没等到架构图 Tab（{str(e)[:80]}），重试", flush=True)
    raise RuntimeError(f"切 {pid}：连续 {tries} 次都没等到架构图 Tab")


def wait_loads(page, n, timeout=120000):
    """条件等待（不用固定 sleep 赌时序）：等 A4 懒加载次数到位"""
    page.wait_for_function(
        "n => { const el = document.querySelector('[data-mindmap-view]');"
        " return !!el && Number(el.getAttribute('data-mindmap-loads')) >= n; }",
        arg=n, timeout=timeout)


def wait_visible(page, n, timeout=60000):
    page.wait_for_function(
        "n => document.querySelectorAll('svg.markmap g[data-path]').length >= n", arg=n, timeout=timeout)


def wait_render_done(page, timeout=120000):
    """等"这次 setData 画完了"：data-mindmap-mm-nodes 只在 markmap 渲染完成后写，与导图树节点数
    相等 = 新树已画上去。**必须用它当基准**：过渡期间可见节点数是旧+新两套（旧节点约 200ms 后才淡出），
    拿过渡中的数去算期望值会算出个永远达不到的目标（N2 加固首跑就栽在这上面）。"""
    page.wait_for_function(
        "() => { const el = document.querySelector('[data-mindmap-view]'); if (!el) return false;"
        " const mm = Number(el.getAttribute('data-mindmap-mm-nodes'));"
        " const n = Number(el.getAttribute('data-mindmap-nodes')); return mm > 0 && mm === n; }",
        timeout=timeout)


def wait_settle(page, timeout=30000, stable=3, gap=120):
    """条件等待画布**稳定**（本卡实测到的时序坑）：markmap 重画是 enter/exit 过渡，
    退出中的旧节点会在 DOM 里多停留约 200ms——刚展开时数一遍会数到"旧树 + 新树"两套
    （实测 8 → 14 的枝在一次点击后先读到 20）。这里等可见节点数连续 stable 次不变再返回。"""
    last, same, deadline = -1, 0, time.time() + timeout / 1000
    while time.time() < deadline:
        n = visible(page)
        if n == last:
            same += 1
            if same >= stable:
                return n
        else:
            same, last = 0, n
        page.wait_for_timeout(gap)
    return visible(page)


def node_locator(page, label):
    """按节点完整文字定位（「人话名 路径」）：锚定整行，避免子级里的同名子串误命中"""
    return page.locator("svg.markmap g[data-path]").filter(
        has_text=re.compile(r"^\s*" + re.escape(label) + r"(\s*\u25b8)?\s*$"))


def click_node(page, label):
    loc = node_locator(page, label)
    if loc.count() == 0:
        return False, "未找到节点"
    el = loc.first
    # 真点（mouse）失败时退化为派发一次冒泡 click：缩放过的大树里节点中心可能落在视口外
    try:
        el.click(timeout=6000)
        return True, "mouse"
    except Exception:
        el.evaluate("e => e.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true}))")
        return True, "dispatch"


def expand_branch(page, br):
    """点一枝：掐表到"带渲染的端到端"（点击 → 画布节点数长出到位），并逐项贴数字"""
    step["now"] = f"展开 {br['path']}"
    before = {"vis": visible(page), "loads": num(page, "data-mindmap-loads")}
    net_before = len(expand_reqs)
    t0 = time.perf_counter()
    hit, how = click_node(page, br["label"])
    ok(hit, f"③ 画布上定位到枝「{br['label']}」（定位方式 {how}）")
    if not hit:
        return None
    wait_loads(page, before["loads"] + 1)
    log = load_log(page)[-1]
    expect = before["vis"] + log["children"] + (1 if log["dropped"] > 0 else 0)
    wait_render_done(page)
    settled = wait_settle(page)
    t_render = (time.perf_counter() - t0) * 1000
    net = expand_reqs[net_before] if len(expand_reqs) > net_before else {"ms": -1, "module_path": "?"}
    after = {"vis": settled, "loads": num(page, "data-mindmap-loads")}
    ok(after["vis"] == expect,
       f"③ 展开 「{br['path']}」：画布节点 {before['vis']} → {after['vis']}（服务端子级 {log['children']}"
       f"{' + 聚合 1' if log['dropped'] > 0 else ''}；等画布稳定后计数）")
    ok(after["loads"] == before["loads"] + 1, f"③ 只多一次 A4 请求（{before['loads']} → {after['loads']}）")
    print(f"[UI]   「{br['path']}」：客户端端到端 {log['ms']}ms（服务端 {net['ms']:.0f}ms 网络往返 + 本页自身计时）"
          f" · 带渲染端到端 {t_render:.0f}ms · 子级 {log['children']} · 截断 {log['dropped']} / 上限 {log['limit']}")
    if log["dropped"] > 0:
        agg = page.locator("svg.markmap g[data-path]").filter(has_text=re.compile(r"^\s*还有 \d+ 个\s*$"))
        ok(agg.count() >= 1 and log["limit"] == LIMIT,
           f"③ 巨枝降级：「{br['path']}」 超单枝上限 {log['limit']} → 画布上出现「还有 {log['dropped']} 个」聚合节点"
           f"（超上限部分不遍历、不解析、不渲染）")
        ok(page.locator(f'[data-mindmap-capped-note="{br["path"]}"]').count() == 1,
           f"③ 界面明示降级原因（口径条：「{br['path']}」 超出 {log['dropped']} 个未展开）")
    else:
        ok(log["limit"] == LIMIT, f"③ 未超上限的枝照常展开（上限 {log['limit']} 未触发，无聚合节点）")
    return {"before": before, "after": after, "log": log, "render_ms": t_render, "net_ms": net["ms"]}


def run_project(page, spec):
    pid, top = spec["id"], spec["top"]
    step["now"] = f"{pid}:初次进入"
    print(f"[UI] ── {spec['name']}（{pid}）：顶层 {top} 个模块 · 要点的枝 {[b['path'] for b in spec['branches']]}")
    goto_project(page, pid)
    net_before = len(expand_reqs)
    open_mindmap(page)
    wait_render_done(page)
    wait_visible(page, top + 1)
    vis0 = wait_settle(page)
    nodes0, mm0 = num(page, "data-mindmap-nodes"), num(page, "data-mindmap-mm-nodes")
    ok(vis0 == top + 1 and num(page, "data-mindmap-depth") == 2,
       f"① {pid}：初次进入只见顶层（画布 {vis0} 个节点 = 根 + {top} 个顶层模块，2 层 —— §3.3 规则 5 默认全折叠）")
    ok(num(page, "data-mindmap-loads") == 0 and num(page, "data-mindmap-expanded") == 0,
       f"② {pid}：未展开任何枝 → A4 懒加载 0 次、展开态 0 枝（未展开分支零解析开销）")
    ok(len(expand_reqs) == net_before,
       f"② {pid}：进导图至今网络层 0 个 /arch/expand 请求（没点开的枝一个请求都不发）")
    ok(mm0 == nodes0,
       f"① {pid}：markmap 树数据 {mm0} 节点 = 导图树 {nodes0} 节点（折叠只影响可见性，不改数据）")
    page.screenshot(path=f"{OUT}/{spec['shots']['top']}")

    results = []
    for i, br in enumerate(spec["branches"]):
        r = expand_branch(page, br)
        if r:
            results.append((br, r))
        # 第一枝展开后单独留一张：巨枝的「还有 N 个」聚合节点在这一张里看得清
        # （等到 4 枝都展开再截，画布被 autoFit 缩到看不清节点文字）
        if i == 0 and spec["shots"].get("afterFirst"):
            page.screenshot(path=f"{OUT}/{spec['shots']['afterFirst']}")
    if spec["shots"].get("expanded"):
        page.screenshot(path=f"{OUT}/{spec['shots']['expanded']}")

    if spec.get("refresh"):
        step["now"] = f"{pid}:刷新保持"
        before = {
            "vis": wait_settle(page),
            "loads": num(page, "data-mindmap-loads"),
            "exp": num(page, "data-mindmap-expanded"),
        }
        req_before = len(expand_reqs)
        goto_project(page, pid)
        open_mindmap(page)
        wait_loads(page, before["loads"])
        wait_render_done(page)
        wait_visible(page, before["vis"])
        restored = {
            "vis": wait_settle(page),
            "loads": num(page, "data-mindmap-loads"),
            "exp": num(page, "data-mindmap-expanded"),
        }
        reqs = expand_reqs[req_before:]
        paths = sorted({r["module_path"] for r in reqs})
        want = sorted(b["path"] for b in spec["branches"])
        ok(restored["vis"] == before["vis"] and restored["exp"] == before["exp"],
           f"④ {pid}：刷新后展开态保持（画布 {before['vis']} → {restored['vis']} 节点、展开 {before['exp']} → {restored['exp']} 枝）")
        ok(paths == want,
           f"④ {pid}：刷新只补拉落盘的那 {len(want)} 枝（{paths}），不是全量解析；A4 次数 {before['loads']} → {restored['loads']}")
        page.screenshot(path=f"{OUT}/{spec['shots']['restored']}")
        # 逐级折叠：点已展开的枝 → 纯折叠（零请求），再点回来 → 零请求恢复、状态落盘
        step["now"] = f"{pid}:折叠/再展开"
        br = spec["branches"][0]
        first = next((r for b, r in results if b["path"] == br["path"]), None)
        if first is None:
            ok(False, f"④ {pid}：折叠对照缺前置数据（{br['path']} 没展开成功）")
        else:
            hidden = first["log"]["children"] + (1 if first["log"]["dropped"] > 0 else 0)
            expect_folded = restored["vis"] - hidden
            loads_folded = num(page, "data-mindmap-loads")
            t0 = time.perf_counter()
            click_node(page, br["label"])
            folded_vis = wait_settle(page)
            ok(folded_vis == expect_folded and num(page, "data-mindmap-loads") == loads_folded,
               f"④ {pid}：点已展开的枝 = 纯折叠（画布 {restored['vis']} → {folded_vis} 节点 = 隐去该枝 {hidden} 个子级，"
               f"A4 请求仍是 {loads_folded} 次 = 零请求、子级缓存留着）")
            ok(num(page, "data-mindmap-expanded") == before["exp"] - 1,
               f"④ {pid}：折叠即刻落盘（展开态 {before['exp']} → {num(page, 'data-mindmap-expanded')} 枝，落盘在点击那一刻）")
            click_node(page, br["label"])
            t1 = time.perf_counter()
            try:
                wait_visible(page, restored["vis"])
            except Exception:
                pass
            unfolded = wait_settle(page)
            ok(num(page, "data-mindmap-loads") == loads_folded and unfolded == restored["vis"],
               f"④ {pid}：再点开 = 零请求恢复（{time.perf_counter() - t1:.2f}s 回到 {unfolded} 节点，无新 A4 请求；从点到折叠再点开共 {time.perf_counter() - t0:.2f}s）")

    # 方框图侧同一枝：N2 改了 ArchCanvas 对 A4 聚合节点的渲染（虚线「还有 N 个」+ 不可下钻），这里补证
    if spec.get("boxBranch"):
        step["now"] = f"{pid}:方框图聚合节点"
        br = spec["boxBranch"]
        page.locator('[data-graph-mode="MODULE_BOX"]').click()
        page.wait_for_selector('[data-arch-mode="MODULE_BOX"]', timeout=60000)
        n_before = page.locator("[data-arch-view] .react-flow__node").count()
        toggle = page.locator(f'button[data-expand-toggle="{br["nodeId"]}"]')
        ok(toggle.count() == 1, f"③ {pid}：方框图顶层模块 {br['path']} 有展开钮（节点 id = A1 slug {br['nodeId']}）")
        toggle.click()
        page.wait_for_selector("[data-arch-aggregate]", timeout=180000)
        page.wait_for_timeout(600)
        agg_text = page.locator("[data-arch-aggregate]").first.text_content() or ""
        n_after = page.locator("[data-arch-view] .react-flow__node").count()
        ok("还有" in agg_text and "未解析" in agg_text,
           f"③ {pid}：方框图展开 {br['path']} → {n_before} → {n_after} 个节点，聚合节点上屏「{agg_text.strip()[:40]}」"
           f"（与导图同一份 A4 截断口径）")
        ok(page.locator("[data-arch-aggregate] button[data-expand-toggle]").count() == 0,
           f"③ {pid}：聚合节点不可再下钻（没有展开钮 —— 超上限的枝本来就没遍历过）")
    return results


def on_request(r):
    if "/arch/expand" in r.url:
        body = {}
        try:
            body = json.loads(r.post_data or "{}")
        except Exception:
            body = {}
        expand_reqs.append({"module_path": body.get("module_path", "?"), "t0": time.perf_counter(), "ms": -1})


def on_response(r):
    if "/arch/expand" in r.url and expand_reqs and expand_reqs[-1]["ms"] < 0:
        expand_reqs[-1]["ms"] = (time.perf_counter() - expand_reqs[-1]["t0"]) * 1000


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_context(viewport={"width": 1600, "height": 950}).new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(f"[{step['now']}] {e}"))
    page.on("request", on_request)
    page.on("response", on_response)
    summary = []
    for spec in SPEC["projects"]:
        n_before = len(expand_reqs)
        res = run_project(page, spec)
        for br, r in res:
            summary.append(f"{spec['id']}:{br['path']} {r['log']['ms']}ms/渲染{r['render_ms']:.0f}ms"
                           f"（子级 {r['log']['children']}，截断 {r['log']['dropped']}）")
        print(f"[UI]   {spec['name']} 本轮 {len(expand_reqs) - n_before} 个 A4 请求")
    ok(not errors, f"④ 全程零页面 JS 异常（{errors[:2] if errors else '无'}）")
    print("[UI] 逐项耗时汇总：" + " · ".join(summary))
    browser.close()

print("UI_ASSERT_ALL_PASS" if not fails else f"UI_ASSERT_FAILS:{len(fails)}")
`;

// ───────────────────────── 折叠态文件：快照 / 清空 / 还原（AGENTS.md §5 隐私与现场保护） ─────────────────────────

const foldPaths = new Map<string, string | null>();

function foldFileOf(projectId: string): string | null {
  const project = getProject(projectId, REAL_DATA_DIR);
  return project ? path.join(project.path, ".工作台", "arch", "mindmap-fold.json") : null;
}

/** UI 段要"初次进入默认全折叠"的干净现场：先把三个项目的折叠态文件快照下来再清空，跑完逐字节还原 */
function snapshotAndClearFold(projectIds: string[]): void {
  for (const id of projectIds) {
    const file = foldFileOf(id);
    if (!file) continue;
    foldPaths.set(file, fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null);
    fs.rmSync(file, { force: true });
  }
}

function restoreFold(): void {
  for (const [file, content] of foldPaths) {
    try {
      if (content === null) fs.rmSync(file, { force: true });
      else fs.writeFileSync(file, content, "utf8");
    } catch (e) {
      console.log(`[verify]   折叠态还原失败（${path.dirname(file)}）：${(e as Error).message}`);
    }
  }
}

function reportFoldFile(projectId: string, when: string): string {
  const file = foldFileOf(projectId);
  if (!file || !fs.existsSync(file)) return `${projectId}：无（= 默认全折叠）`;
  const text = fs.readFileSync(file, "utf8").replace(/\s+/g, " ").trim();
  console.log(`[verify]   ${when} ${projectId} mindmap-fold.json：${text}`);
  return text;
}

// ───────────────────────── 主流程 ─────────────────────────

async function main(): Promise<void> {
  console.log("[verify] ── ④ 端口：先探 8787 / 5173 是不是别人的（本脚本一律动态端口，绝不杀既有监听）");
  const fixedBefore = { v: await portListening(8787), d: await portListening(5173) };
  console.log(
    `[verify]   8787 ${fixedBefore.v ? "有人监听（别人的，不碰）" : "空闲"} · 5173 ${fixedBefore.d ? "有人监听（别人的，不碰）" : "空闲"}`,
  );

  console.log("\n[verify] ── ① 默认全折叠（§3.3 规则 5）：数据口径 + 单枝上限夹具");
  checkDefaultCollapsed();
  checkCapFixture();

  console.log("\n[verify] ── ③ 巨枝实测（服务端真跑；含「全量遍历这枝要多久」的对照）");
  checkGiantBranches();

  console.log("\n[verify] ── ④ 折叠态落盘：往返 / 原子写 / 多项目互不覆盖 / 损坏处理");
  checkFoldStore();

  console.log("\n[verify] ── ⑥ 源码级护栏：防爆炸实现唯一出处 + 折叠态消费点");
  checkSourceGuard();

  // UI 段参数：每枝的节点文字（A2 人话名 + 路径）由 names.json 现算，python 侧锚定整行定位。
  if (BIG === "" || MID === "" || BIG_BRANCHES.length === 0 || MID_BRANCHES.length === 0) {
    skip(
      "UI 段（playwright：多项目 × 折叠 / 巨枝截断 / 刷新保持）+ ② [arch/expand] 日志逐行核对",
      `设 TATAI_ID_BIG / TATAI_BIG_BRANCHES / TATAI_ID_MID / TATAI_MID_BRANCHES（+ TATAI_HOME 指向已登记它们的数据目录）后可跑，${SYNTH_HINT}`,
    );
    return;
  }
  // **顺序：塔台 → 中等项目 → 压测项目（压测项目放最后，不是随手排的）**：App 打开项目时会起文件监听
  // （H3），而在"上万文件 + 大量被系统锁住的临时文件"的项目上，监听一起后端就被拖死
  // （本卡实测：开监听 5 秒后 /health 894ms、/api/projects 2210ms，15 秒后两个都直接超时——
  // 见 PROGRESS 踩坑）。等它拖死就再也答不了话，所以**需要后端答话的步骤都排在它之前**，
  // 它自己那几步（读数据 + 展开巨枝）在头几秒内跑完，跑完只剩端口释放这类不依赖 HTTP 的断言。
  const tataiModules = readModules(TATAI, REAL_DATA_DIR).arch?.modules.length ?? 0;
  const midModules = readModules(MID, REAL_DATA_DIR).arch?.modules.length ?? 0;
  const bigModules = readModules(BIG, REAL_DATA_DIR).arch?.modules.length ?? 0;
  const spec: ProjectSpec[] = [
    {
      id: TATAI,
      name: "塔台",
      top: tataiModules,
      branches: TATAI_BRANCHES.map((b) => branchSpec(TATAI, b)),
      refresh: true,
      shots: {
        top: "n2-01-tatai-default-collapsed.png",
        expanded: "n2-02-tatai-expanded-fold-persisted.png",
        restored: "n2-03-tatai-fold-restored-after-reload.png",
      },
    },
    {
      id: MID,
      name: "中等项目",
      top: midModules,
      branches: MID_BRANCHES.map((b) => branchSpec(MID, b)),
      refresh: false,
      shots: {
        top: "n2-04-mid-default-collapsed.png",
        afterFirst: "n2-05-mid-giant-branch-truncated.png",
      },
    },
    {
      id: BIG,
      name: "压测项目",
      top: bigModules,
      branches: BIG_BRANCHES.map((b) => branchSpec(BIG, b)),
      refresh: false,
      boxBranch: branchSpec(BIG, BIG_BRANCHES[0]),
      shots: {
        top: "n2-06-big-default-collapsed.png",
        afterFirst: "n2-07-big-first-branch-truncated.png",
        expanded: "n2-08-big-all-branches-expanded.png",
      },
    },
  ];
  ok(
    spec.every((s) => s.branches.length > 0 && s.branches.every((b) => b.label.includes(b.path))),
    `⑤ UI 段参数齐备：${spec.map((s) => `${s.id}(${s.branches.map((b) => b.path).join(",")})`).join(" · ")}`,
  );

  // 服务端 [arch/expand] 行数：未展开的枝一行都不该有（DoD② 的服务端侧对照）
  const expandLines: string[] = [];
  const backendPort = await pickFreePort();
  const viteEntry = path.join(REPO_ROOT, "node_modules", "vite", "bin", "vite.js");
  let backend: ChildProcess | null = null;
  // 现场保护：各项目的折叠态先快照再清空（"初次进入"必须是干净现场），跑完还原
  snapshotAndClearFold([TATAI, BIG, MID]);
  try {
    console.log("\n[verify] ── UI 段前：起后端（动态端口）+ 折叠态 HTTP 回环");
    backend = await startService(
      "后端",
      backendPort,
      (port) =>
        spawn(process.execPath, ["--import", "tsx", path.join("src", "server", "index.ts")], {
          cwd: REPO_ROOT,
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, TATAI_HOME: REAL_DATA_DIR, TATAI_PORT: String(port) },
        }),
      [`http://127.0.0.1:${backendPort}/health`, `http://localhost:${backendPort}/health`],
      (line) => {
        if (line.includes("[arch/expand]")) expandLines.push(line);
      },
    );
    const api = (p: string) => `http://127.0.0.1:${backendPort}${p}`;
    const fold0 = (await (await fetch(api(`/api/projects/${encodeURIComponent(TATAI)}/arch/mindmap-fold`))).json()) as {
      fold: { expanded: unknown[] };
    };
    ok(fold0.fold.expanded.length === 0, "④ HTTP GET arch/mindmap-fold：清空后读回空清单（= 默认全折叠）");
    const put = (await (
      await fetch(api(`/api/projects/${encodeURIComponent(TATAI)}/arch/mindmap-fold`), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expanded: [{ id: "src-ui", path: "src/ui" }] }),
      })
    ).json()) as { ok: boolean; result: { expanded: unknown[]; saved: number } };
    const fold1 = (await (await fetch(api(`/api/projects/${encodeURIComponent(TATAI)}/arch/mindmap-fold`))).json()) as {
      fold: { expanded: { id: string }[] };
    };
    ok(
      put.result.saved === 1 && fold1.fold.expanded.length === 1 && fold1.fold.expanded[0].id === "src-ui",
      `④ HTTP PUT → GET 回环：写 1 条 → 读回 ${fold1.fold.expanded.length} 条（${fold1.fold.expanded[0]?.id}）`,
    );
    reportFoldFile(TATAI, "HTTP 段后");
    // 巨枝的 HTTP 响应口径（服务端真的带回了截断量/上限：界面上的「还有 N 个」就是从这两个字段来的）
    const exp = (await (
      await fetch(api(`/api/projects/${encodeURIComponent(BIG)}/arch/expand`), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ module_path: BIG_BRANCHES[0] }),
      })
    ).json()) as {
      result: { children: { kind: string; name: string }[]; limit: { children: number }; truncated: { children: number } };
    };
    const aggChild = exp.result.children.find((c) => c.kind === "aggregate");
    ok(
      exp.result.truncated.children > 0 &&
        exp.result.limit.children === ARCH_LIMITS.MAX_CHILDREN &&
        exp.result.children.length === ARCH_LIMITS.MAX_CHILDREN &&
        aggChild?.name === `还有 ${exp.result.truncated.children} 个`,
      `③ HTTP arch/expand（压测项目 ${BIG_BRANCHES[0]}）：子级 ${exp.result.children.length} = 上限 ${exp.result.limit.children}，截断 ${exp.result.truncated.children} → 聚合节点「${aggChild?.name}」`,
    );
    // HTTP 段写进 tatai 的折叠态会干扰"初次进入"的 UI 断言 → 再清一次（快照已在上面留好）
    fs.rmSync(foldFileOf(TATAI)!, { force: true });

    console.log("\n[verify] ── UI 段：playwright 真起三视图（默认折叠 / 巨枝截断 / 刷新保持）");
    await uiPlaywright(spec, viteEntry, backendPort);
  } finally {
    restoreFold();
    if (backend) {
      intentionalStop.add(backendPort);
      backend.kill();
    }
    await sleep(300);
  }

  console.log("\n[verify] ── ② 服务端 [arch/expand] 日志逐行核对（未展开的枝一行都没有）");
  // 预期行数 = 各项目点过的枝 + 塔台刷新补拉的那 1 枝 + HTTP 段那 1 枝 + 方框图侧那 1 枝；
  // 折叠/再展开是零请求，不该多行
  const boxExpands = spec.filter((s) => s.boxBranch).length;
  const expectedLines =
    TATAI_BRANCHES.length + 1 + BIG_BRANCHES.length + MID_BRANCHES.length + boxExpands + 1;
  console.log(
    `[verify]   服务端共 ${expandLines.length} 行 / 预期 ${expectedLines}（${spec.map((s) => `${s.id} 导图 ${s.branches.length} 枝`).join(" · ")} · 塔台刷新补拉 1 枝 · 方框图 ${boxExpands} 枝 · HTTP 段 1 枝）`,
  );
  for (const line of expandLines) console.log(`[verify]     ${line.trim()}`);
  ok(
    expandLines.length === expectedLines,
    `② 服务端只为被点开的枝留日志（${expandLines.length} 行 = 预期 ${expectedLines}）——没展开的枝零解析行、折叠/再展开零请求（DoD② 日志证据）`,
  );

  console.log("\n[verify] ── ⑦ 收尾：进程杀净 + 动态端口已释放 + 8787/5173 仍是别人的 + 折叠态现场还原");
  await sleep(1200);
  ok(!(await portListening(backendPort)), `⑦ 后端动态端口 ${backendPort} 已释放（进程杀净）`);
  const fixedAfter = { v: await portListening(8787), d: await portListening(5173) };
  ok(
    fixedBefore.v === fixedAfter.v && fixedBefore.d === fixedAfter.d,
    `⑦ 8787/5173 状态与开工前一致（${fixedAfter.v ? "有人在用" : "空闲"} / ${fixedAfter.d ? "有人在用" : "空闲"}）——本脚本没占用、没杀 PID`,
  );
  ok(
    [...foldPaths.keys()].every((f) => {
      const content = foldPaths.get(f) ?? null;
      return content === null ? !fs.existsSync(f) : fs.readFileSync(f, "utf8") === content;
    }),
    `⑦ 各项目的折叠态文件已逐字节还原（快照 ${foldPaths.size} 个）`,
  );
}

try {
  main()
    .then(() => finish())
    .catch((e) => {
      console.error("[verify] 异常:", e);
      process.exitCode = 1;
    });
} catch (err) {
  console.error("[verify] 异常:", err);
  process.exitCode = 1;
}
