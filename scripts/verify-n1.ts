// N1 验证脚本（用 tsx 跑）：思维导图渲染器（PLAN N1 卡 DoD 逐条 + 卡上"跑偏点"红线）。
// 用法：pnpm verify:n1
//
// 覆盖点：
//   ② 数据不新建来源：真实项目走 A1 落盘（readModules）→ 项目级共用数据层 buildSharedGraph →
//      buildMindTree（MIND_MAP 选择器）→ markdown 导出，贴计数与耗时；源码级断言 src/ui 下没有
//      第二处目录扫描/解析调用（唯一来源 = 共用数据层），导图取数口全仓只有 src/arch/mindmap.ts 一处。
//   ① 层级与 A1 清单一致：markdown 每行注释（id/path/files/from）逐层回查——第 1 层比对 A1 模块清单，
//      第 2/3 层比对 A4 expandDirectory 真结果；并断言 markmap-lib 真能把这份 markdown 解析成同一棵树
//      （渲染输入 = 导出物，不是两份数据）。
//   ③ 节点硬上限与聚合规则和方框图同一份：方框图与思维导图的节点集合逐 id 全等、≤ graph.limits.MAX_NODES；
//      50 模块夹具下导图同样只出 MAX_NODES 个节点（含「还有 N 个」聚合节点，导图零自建截断）；
//      真实项目（塔台自身 + `TATAI_REAL_IDS` 给的每个项目）贴节点数与耗时。
//   ④ 界面真起（playwright，动态端口 + 端口探活）：塔台与另一个真实项目的思维导图截图（层级可见、
//      中文名来自 A2 缓存）、点节点就地懒加载 A4 子级（DOM 读数 + 耗时）、导出面板里的 markdown 注释可核对、
//      切走再切回懒加载结果不丢且不触发第二次全量解析。
//
// 端口策略（外部审计点名过"固定端口易受残留进程干扰"）：**不碰任何既有监听**——后端 bind 0 让系统分配，
// vite 同样动态选端口并把后端端口经 TATAI_DEV_API_PORT 传进代理；起前探活、起后盯子进程早退。
// 全程不用 8787 / 5173（开头末尾各探一次，只记录状态，不杀别人的进程）。
//
// 隐私（AGENTS.md §5/§6）：真实项目只贴路径、结构与计数；脚本自身零写盘（不碰 .工作台 数据），
// 截图落 .工作台/verify/n1-*.png（gitignore）。
import { execSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Transformer } from "markmap-lib/no-plugins";
import { ARCH_LIMITS, MORE_NODE_ID } from "../src/arch/config";
import { expandDirectory } from "../src/arch/expand";
import { GRAPH_MODES } from "../src/arch/graph-mode";
import { buildMindTree, toMarkdown, type MindTree, type MindTreeNode } from "../src/arch/mindmap";
import { readNames } from "../src/arch/name";
import { readModules } from "../src/arch/parse";
import { buildSharedGraph } from "../src/arch/render";
import { buildSharedGraphFrom, selectGraph, type SharedGraph } from "../src/arch/shared-graph";
import { getProject } from "../src/server/registry";
import { ensureSelfRegistered, finish, realHome, realProjectIds, skip } from "./lib/fixtures";
import { SYNTH_HINT, applySynthN1 } from "./lib/synth";

// Q6：TATAI_SYNTH=1 且真实 env 没给 → 临时目录造授权合成夹具（临时 home + 两个合成导图项目，
// 注册表/A1 产物/人话名全预置），必须在下面 realHome()/realProjectIds() 之前跑（它们读 process.env）
applySynthN1();

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REAL_DATA_DIR = realHome(); // TATAI_HOME > 缺省 ~/.tatai（脚本不写死作者本机路径）
const VERIFY_DIR = path.join(REPO_ROOT, ".工作台", "verify");

/** 真实项目：塔台自身（开源 repo，可贴模块名）+ `TATAI_REAL_IDS` 给的项目（只贴结构与计数） */
const PROJECTS = realProjectIds();
const UI_PROJECTS = ["tatai", ...realProjectIds().filter((id) => id !== "tatai").slice(0, 1)];
ensureSelfRegistered(REAL_DATA_DIR);

const ok = (cond: boolean, label: string) => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (!cond) process.exitCode = 1;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ───────────────────────── 端口：探活 + 动态分配（与 verify-f4 同一份写法） ─────────────────────────

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

function pipeOutput(child: ChildProcess, label: string): void {
  child.stdout?.on("data", (d: Buffer) => process.stdout.write(`[${label}] ${d}`));
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
): Promise<ChildProcess> {
  if (await portListening(port)) throw new Error(`${label} 端口 ${port} 已被占用（本脚本不碰既有监听，请重跑）`);
  const child = spawnFn(port);
  pipeOutput(child, `${label}:${port}`);
  child.once("exit", (code) => {
    if (!intentionalStop.has(port) && code !== 0) {
      console.error(`[verify] ${label}（端口 ${port}）意外退出：code=${code}（端口被抢？）`);
    }
  });
  await waitUpAny(readyUrls, `${label} ${port}`, { isAlive: () => child.exitCode === null });
  return child;
}

/** 折叠态文件（N2 起思维导图会落盘展开态）：UI 段要"初次进入只见顶层"，先快照再清空，跑完还原 */
const foldFileOf = (id: string): string | null => {
  const project = getProject(id, REAL_DATA_DIR);
  return project ? path.join(project.path, ".工作台", "arch", "mindmap-fold.json") : null;
};

function snapshotFolds(ids: string[]): Map<string, string | null> {
  const snapshot = new Map<string, string | null>();
  for (const id of ids) {
    const file = foldFileOf(id);
    if (!file) continue;
    snapshot.set(file, fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null);
    fs.rmSync(file, { force: true });
  }
  return snapshot;
}

function restoreFolds(snapshot: Map<string, string | null>): void {
  for (const [file, content] of snapshot) {
    try {
      if (content === null) fs.rmSync(file, { force: true });
      else fs.writeFileSync(file, content, "utf8");
    } catch {
      // 还原失败不阻断验证结论（折叠态是运行态数据，不影响本卡断言）
    }
  }
}

// ───────────────────────── markdown 解析（逐层回查用） ─────────────────────────

interface MdLine {
  /** 0 = 顶层模块（根节点下第一层） */
  level: number;
  id: string;
  path: string;
  files: number;
  from: string;
  label: string;
  /** 本行的父行 id（缩进决定，顶层 = null） */
  parentId: string | null;
}

const unescapeMd = (s: string) => s.replace(/\\(.)/g, "$1");

/** 解析 toMarkdown 的产物（行尾注释就是本卡的可核对信息）。
 *  `path` 用 `\S*`（可为空）：**空 path = 没有真实路径**（「还有 N 个」聚合节点），与 `toMarkdown`
 *  和 A4 `expand.ts` 同一口径；`.` 是"根散文件模块"的**真实**路径，不能拿来当空值的替身。
 *  这样聚合节点那一行照样被解析出来、照样逐字段与 A4 真结果严格比（不是跳过、不是放宽）。 */
function parseMarkdown(md: string): { root: { id: string; label: string }; lines: MdLine[] } {
  const raw = md.split("\n");
  const head = raw.find((l) => l.startsWith("# "));
  const hm = head?.match(/^# (.*?) `([^`]+)`/);
  const lines: MdLine[] = [];
  const stack: string[] = [];
  for (const line of raw) {
    const indent = line.match(/^( *)- /);
    if (!indent) continue;
    const level = indent[1].length / 2;
    const note = line.match(/<!-- id=(\S+) path=(\S*) files=(\d+) from=(\S+) -->/);
    if (!note) continue;
    const beforeNote = line.split(" <!-- ")[0].trim().replace(/^-\s*/, "").replace(/\s*▸$/, "");
    const label = unescapeMd(beforeNote.replace(/\*\*/g, "").split(" `")[0]);
    stack.length = level;
    stack.push(note[1]);
    lines.push({
      level,
      id: note[1],
      path: note[2],
      files: Number(note[3]),
      from: note[4],
      label,
      parentId: level === 0 ? null : (stack[level - 1] ?? null),
    });
  }
  return { root: { id: hm?.[2] ?? "", label: unescapeMd(hm?.[1] ?? "") }, lines };
}

/** markmap 侧的树节点数（markmap 真解析这份 markdown → "导出物就是渲染输入"） */
function markmapNodeCount(root: { children?: unknown[] }): number {
  const kids = (root.children ?? []) as { children?: unknown[] }[];
  return 1 + kids.reduce((s, c) => s + markmapNodeCount(c), 0);
}

/** 节点在树里的前序序号（0 = 根）——DOM 里 `g[data-path]` 的顺序就是前序，点击定位用 */
function preOrderIndex(root: MindTreeNode, id: string): number {
  let i = -1;
  let hit = -1;
  const walk = (n: MindTreeNode): void => {
    i++;
    if (n.id === id && hit < 0) hit = i;
    for (const c of n.children) walk(c);
  };
  walk(root);
  return hit;
}

// ───────────────────────── ① ② ③：脚本侧（真实项目 + 夹具） ─────────────────────────

interface ProjectReport {
  id: string;
  /** 顶层树节点数（根 + 顶层模块） */
  nodes: number;
  limit: number;
  ms: { tree: number; markdown: number; transform: number };
  markdown: string;
  tree: MindTree;
}

function checkProject(id: string): ProjectReport | null {
  const project = getProject(id, REAL_DATA_DIR);
  if (!project) {
    skip(`③ 真实项目 ${id} 的导图取数`, `注册表里没有 ${id}：设 TATAI_HOME=<数据目录>（可选 TATAI_REAL_IDS）后可跑，${SYNTH_HINT}`);
    return null;
  }
  const modules = readModules(id, REAL_DATA_DIR);
  if (!modules.exists || !modules.arch) {
    console.log(`[verify]   SKIP ${id}：还没解析过（A1 产物不存在，先跑 arch/parse）`);
    return null;
  }
  const built = buildSharedGraph(id, { dataDir: REAL_DATA_DIR });
  if (!built.exists || !built.graph) {
    console.log(`[verify]   SKIP ${id}：项目级共用数据层没有数据`);
    return null;
  }
  const shared: SharedGraph = built.graph;
  const names = readNames(project.path);

  // ② 数据只经共用层：同一份 shared 喂方框图与思维导图两种选择
  const box = selectGraph("MODULE_BOX", shared);
  const mind = selectGraph("MIND_MAP", shared);
  const boxIds = box.nodes.map((n) => n.id).sort();
  const mindIds = mind.nodes.map((n) => n.id).sort();
  ok(
    JSON.stringify(boxIds) === JSON.stringify(mindIds),
    `③ ${id}：思维导图节点集合与方框图逐 id 全等（各 ${mind.nodes.length} 个）`,
  );
  ok(
    mind.nodes.length <= shared.limits.MAX_NODES,
    `③ ${id}：节点 ${mind.nodes.length} ≤ graph.limits.MAX_NODES=${shared.limits.MAX_NODES}（同一份硬上限，导图零自建截断）`,
  );

  const t0 = performance.now();
  const tree = buildMindTree(shared, { id: project.id, name: project.name }, new Map());
  const t1 = performance.now();
  const markdown = toMarkdown(tree.root);
  const t2 = performance.now();
  const transformed = new Transformer().transform(markdown);
  const t3 = performance.now();

  const parsedMd = parseMarkdown(markdown);
  const byId = new Map(modules.arch.modules.map((m) => [m.id, m]));
  // ① 第 1 层逐条回查 A1 模块清单（id / path / file_count / from）
  const badFirst = parsedMd.lines.filter((l) => {
    const m = byId.get(l.id);
    return !m || m.path !== l.path || m.file_count !== l.files || l.from !== "shared";
  });
  ok(
    badFirst.length === 0 && parsedMd.lines.length === shared.nodes.length,
    `① ${id}：markdown 第 1 层 ${parsedMd.lines.length} 行逐条等于 A1 模块清单（id/path/file_count 全等，异常 ${badFirst.length} 行）`,
  );
  // ① 显示名出处：A2 起名缓存（names.json）里有就用它，没有就兜底模块 id（与共用层同一口径）
  const badName = parsedMd.lines.filter((l) => l.label !== (names.entries[l.id]?.name ?? l.id));
  const named = parsedMd.lines.filter((l) => names.entries[l.id]).length;
  ok(
    badName.length === 0 && named > 0,
    `① ${id}：markdown 第 1 层显示名全部来自 A2 起名缓存（命中 ${named}/${parsedMd.lines.length} 个模块，未命中的兜底模块 id）`,
  );
  ok(
    parsedMd.root.label === project.name && parsedMd.root.id === project.id,
    `① ${id}：markdown 根节点 = 项目名/id（注册表口径，不是新数据源）`,
  );
  ok(
    markmapNodeCount(transformed.root) === tree.nodeCount,
    `① ${id}：markmap-lib 真解析这份 markdown → ${markmapNodeCount(transformed.root)} 个节点 = 导图树 ${tree.nodeCount} 个（渲染输入 = 导出物）`,
  );
  ok(
    transformed.root.children.length === tree.root.children.length,
    `① ${id}：markmap 解析出的顶层分支数 ${transformed.root.children.length} = 顶层模块数 ${tree.root.children.length}`,
  );
  if (shared.truncated.nodes > 0) {
    const aggregate = parsedMd.lines.find((l) => l.id === MORE_NODE_ID);
    ok(
      aggregate !== undefined && parsedMd.lines.length === shared.limits.MAX_NODES,
      `③ ${id}：超上限项目在导图里同样只剩 ${shared.limits.MAX_NODES} 个节点（聚合节点 ${MORE_NODE_ID} 在，与方框图同一份聚合规则）`,
    );
  }

  console.log(
    `[verify]   ${id}（${project.kind}）：共用层节点 ${shared.nodes.length} · 层级边 ${mind.edges.length} · ` +
      `markdown ${parsedMd.lines.length + 1} 行（1 根 + ${parsedMd.lines.length} 顶层）· ` +
      `耗时 建树 ${(t1 - t0).toFixed(2)}ms / 导出 ${(t2 - t1).toFixed(2)}ms / markmap 解析 ${(t3 - t2).toFixed(2)}ms`,
  );
  return {
    id,
    nodes: parsedMd.lines.length + 1,
    limit: shared.limits.MAX_NODES,
    ms: { tree: t1 - t0, markdown: t2 - t1, transform: t3 - t2 },
    markdown,
    tree,
  };
}

/** 塔台自身：全量展开（顶层 → 子模块 → 文件三层），逐层回查 A4 真结果 */
function checkTataiDeeper(): void {
  const project = getProject("tatai", REAL_DATA_DIR);
  const modules = readModules("tatai", REAL_DATA_DIR);
  const built = buildSharedGraph("tatai", { dataDir: REAL_DATA_DIR });
  if (!project || !built.exists || !built.graph || !modules.exists || !modules.arch) {
    ok(false, "① tatai：真实数据不可读（注册表 / A1 产物）");
    return;
  }
  const root = project.path;
  type Children = ReturnType<typeof expandDirectory>["children"];
  const t0 = performance.now();
  const childrenByParent = new Map<string, Children>();
  const childById = new Map<string, Children[number]>();
  const parentOfChild = new Map<string, string>();
  for (const m of modules.arch.modules) {
    const r = expandDirectory(root, m.path);
    childrenByParent.set(m.id, r.children);
    for (const c of r.children) {
      childById.set(c.id, c);
      parentOfChild.set(c.id, m.id);
    }
  }
  // 第 3 层：把第 2 层的目录子级再展开一级（§3.3 规则 3 逐级下钻到文件级）
  let dirs = 0;
  for (const children of [...childrenByParent.values()]) {
    for (const c of children) {
      if (c.kind !== "dir") continue;
      dirs++;
      const r = expandDirectory(root, c.path);
      childrenByParent.set(c.id, r.children);
      for (const cc of r.children) {
        childById.set(cc.id, cc);
        parentOfChild.set(cc.id, c.id);
      }
    }
  }
  const t1 = performance.now();
  const tree = buildMindTree(built.graph, { id: project.id, name: project.name }, childrenByParent);
  const markdown = toMarkdown(tree.root);
  const t2 = performance.now();
  const parsedMd = parseMarkdown(markdown);
  const deep = parsedMd.lines.filter((l) => l.from === "expand");
  const badDeep = deep.filter((l) => {
    const child = childById.get(l.id);
    return !child || child.path !== l.path || child.file_count !== l.files;
  });
  const badParent = deep.filter((l) => parentOfChild.get(l.id) !== l.parentId);
  const level1 = parsedMd.lines.filter((l) => l.level === 1).length;
  const level2 = parsedMd.lines.filter((l) => l.level === 2).length;
  console.log(
    `[verify]   tatai 全量下钻：${childrenByParent.size} 个父节点（${modules.arch.modules.length} 顶层模块 + ${dirs} 子目录）· ` +
      `树 ${tree.nodeCount} 节点 / ${tree.depth} 层 · markdown ${parsedMd.lines.length} 行（顶层 ${parsedMd.lines.length - level1 - level2} / 第 2 层 ${level1} / 第 3 层 ${level2}）· ` +
      `耗时 A4 展开 ${(t1 - t0).toFixed(0)}ms / 建树+导出 ${(t2 - t1).toFixed(2)}ms`,
  );
  ok(tree.depth === 4, `① tatai：导图真出三层（顶层模块 → 子模块 → 文件，树深 ${tree.depth} 层含根）`);
  ok(
    deep.length > 0 && badDeep.length === 0,
    `① tatai：markdown 里 ${deep.length} 行下钻节点逐条等于 A4 expandDirectory 真结果（id/path/file_count 全等，异常 ${badDeep.length} 行）`,
  );
  ok(badParent.length === 0, `① tatai：下钻行的父行都是它的真实父节点（逐行回查，异常 ${badParent.length} 行）`);
  // 「还有 N 个」聚合节点（§4.3 第 1 招）：显式断言它的 path 就是空串（不是跳过、不是"随便什么都行"）——
  // 它是"被截断的枝"，A4 给的 path 是 ""，图上一行注释也必须是 `path=`（空），不兜底成 "."（那会与
  // "根散文件模块"的真实路径 "." 混成一个样子）。逐行严格比已在上面 badDeep 里，这里把口径单独立一条眼见的断言。
  const aggDeep = deep.filter((l) => childById.get(l.id)?.kind === "aggregate");
  const aggChildren = [...childById.values()].filter((c) => c.kind === "aggregate");
  ok(
    aggDeep.length === aggChildren.length &&
      aggDeep.every((l) => l.path === "" && l.files === 0 && /^还有 \d+ 个$/.test(l.label)),
    `① tatai：聚合节点逐条为无路径（path 必须为 ""：${aggDeep.length}/${aggChildren.length} 条，files=0，文字形如「还有 N 个」）`,
  );
  const mmDeep = new Transformer().transform(markdown);
  ok(
    markmapNodeCount(mmDeep.root) === tree.nodeCount,
    `① tatai：三层 markdown 也能被 markmap 真解析（${markmapNodeCount(mmDeep.root)} 节点，markdown ${markdown.split("\n").length} 行）`,
  );
  // 骨架无关（2026-09-18）：不锚 src-ui——取第一个有目录子级的顶层模块的目录子级验"目录能继续下钻"
  const dirOwner = modules.arch.modules.find((m) => childrenByParent.get(m.id)?.some((c) => c.kind === "dir"));
  const oneDir = dirOwner ? childrenByParent.get(dirOwner.id)?.find((c) => c.kind === "dir") : undefined;
  ok(
    oneDir !== undefined && (childrenByParent.get(oneDir.id)?.length ?? 0) > 0,
    `③ tatai：子模块（目录）能继续下钻到文件级（${dirOwner?.id ?? "?"} 的目录 ${oneDir?.path ?? "?"} → ${childrenByParent.get(oneDir?.id ?? "")?.length ?? 0} 子项，导图无自建截断）`,
  );
}

/** 50 模块夹具：导图侧的硬上限/聚合与共用层同一份（导图自己一行截断代码都没有） */
function checkFixture(): void {
  const big = Array.from({ length: 50 }, (_, k) => {
    const n = String(k + 1).padStart(2, "0");
    return { id: `mod${n}`, path: `mod${n}`, file_count: 50 - k, deps: [] as { to: string; weight: number }[] };
  });
  const names = Object.fromEntries(
    big.map((m) => [m.id, { name: `模块${m.id}`, blurb: "", kind: "code" as const }]),
  );
  const shared = buildSharedGraphFrom(big, names);
  const tree = buildMindTree(shared, { id: "fixture", name: "夹具项目" }, new Map());
  const parsedMd = parseMarkdown(toMarkdown(tree.root));
  const aggregate = parsedMd.lines.find((l) => l.id === MORE_NODE_ID);
  console.log(
    `[verify]   50 模块夹具：共用层 ${shared.nodes.length} 节点（保留 ${Math.min(50, shared.limits.MAX_NODES - 1)} + 聚合 1）→ ` +
      `导图顶层 ${parsedMd.lines.length} 行（聚合行 ${aggregate ? "在" : "缺"}：「${aggregate?.label ?? "?"}」）`,
  );
  ok(
    parsedMd.lines.length === ARCH_LIMITS.MAX_NODES && aggregate !== undefined && aggregate.label.startsWith("还有"),
    `③ 夹具：导图顶层 = MAX_NODES = ${ARCH_LIMITS.MAX_NODES} 行且含聚合节点（与方框图同一份聚合规则）`,
  );
  // 顶层聚合节点（共用层的 `__more__`）同样是"无真实路径"：显式断言它的 path 为空串（不是 `.`），
  // 文件数逐字等于共用层那个聚合节点的 file_count（真值源 = `buildSharedGraphFrom` 的产物，
  // 不是另算一遍）。这条不依赖任何真实数据，是"空串口径"最稳的那一条护栏。
  const aggNode = shared.nodes.find((n) => n.id === MORE_NODE_ID);
  ok(
    aggregate !== undefined && aggNode !== undefined &&
      aggregate.path === "" && aggregate.files === aggNode.file_count,
    `③ 夹具：顶层聚合节点 path 必须为 ""（实际 ${JSON.stringify(aggregate?.path)}）、files=${aggregate?.files} = 共用层聚合节点（不兜底成 "."）`,
  );
}

/** ② 源码级：src/ui 下不许出现第二处目录扫描 / 解析调用；导图取数口只此一处 */
function checkSourceRedlines(): void {
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (/\.tsx?$/.test(e.name)) out.push(p);
    }
    return out;
  };
  const rel = (f: string) => path.relative(REPO_ROOT, f).split(path.sep).join("/");
  const stripComments = (t: string) =>
    t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  const uiFiles = walk(path.join(REPO_ROOT, "src", "ui"));
  // 目录扫描 / 解析 / 数据源直读：视图层命中即"第二数据源"（唯一来源 = 共用数据层）
  const banned = /readdirSync|walkFiles|parseFileImports|readModules\s*\(|expandDirectory\s*\(|modules\.json/;
  const offenders = uiFiles.filter((f) => banned.test(stripComments(fs.readFileSync(f, "utf8")))).map(rel);
  ok(
    offenders.length === 0,
    `② src/ui 下 ${uiFiles.length} 个文件零第二处目录扫描/解析调用（命中：${offenders.join(", ") || "无"}）`,
  );
  const selectInUi = uiFiles
    .filter((f) => stripComments(fs.readFileSync(f, "utf8")).includes("selectGraph("))
    .map(rel);
  ok(
    JSON.stringify(selectInUi) === JSON.stringify(["src/ui/arch/ArchCanvas.tsx"]),
    `② 视图层消费共用层的出口仍只有共用画布（${selectInUi.join(", ") || "无"}）：导图的取数在 src/arch/mindmap.ts，不在 src/ui 里另调一次`,
  );
  const mindSrc = stripComments(fs.readFileSync(path.join(REPO_ROOT, "src", "arch", "mindmap.ts"), "utf8"));
  ok(
    mindSrc.split("selectGraph(").length - 1 === 1 && mindSrc.includes('selectGraph("MIND_MAP", shared)'),
    "② 导图取数口只有一处：src/arch/mindmap.ts 里就一次 MIND_MAP 选择（不新建数据源）",
  );
  ok(
    !/ARCH_LIMITS|MORE_NODE_ID|readdirSync|expandDirectory\s*\(/.test(mindSrc),
    "③ 导图不做自己的截断/聚合：mindmap.ts 不引 ARCH_LIMITS/MORE_NODE_ID，也不扫目录（上限随 graph.limits）",
  );
  const spec = GRAPH_MODES.MIND_MAP;
  ok(
    spec.edgeRule === "hierarchy_parent_child" && spec.edgeDirection === "parent_to_child" && spec.weightScale === null,
    `② 口径契约到位：MIND_MAP edgeRule=${spec.edgeRule} / 方向=${spec.edgeDirection} / 权重映射=${String(spec.weightScale)}（F1 定版口径，导图不另立）`,
  );
}

// ───────────────────────── ④ UI 段：playwright ─────────────────────────

interface UiExpect {
  nodes: number;
  limit: number;
  /** 要展开的枝：前序序号（DOM 中 g[data-path] 的顺序）+ 节点文字里的路径（双重定位） */
  index: number;
  branch: string;
}

async function uiPlaywright(expected: Map<string, UiExpect>, viteEntry: string, backendPort: number): Promise<void> {
  fs.mkdirSync(VERIFY_DIR, { recursive: true });
  const pyPath = path.join(VERIFY_DIR, "n1-shot.py");
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
    ok(false, "④ UI 段：vite 起不来（连续 3 个动态端口都失败）");
    return;
  }
  console.log(`[verify]   UI 段服务就绪：后端 ${backendPort}（动态端口）+ vite ${vitePort}（动态端口）`);
  // 每个项目一组参数：id 顶层节点数 上限 枝序号 枝路径 塔台第 2/3 枝
  const arg = (id: string) => {
    const e = expected.get(id)!;
    return `${id} ${e.nodes} ${e.limit} ${e.index} ${e.branch}`;
  };
  const tatai = expected.get("tatai")!;
  // 塔台三级下钻的两级枝（骨架无关，2026-09-18）：deepMod → deepDir，不再锚 src/ui → src/ui/arch。
  // 注意 DEEPER_TEXT1 必须传**整行节点文字**（「中文名 路径」）：click_branch 按前序序号定位时会先
  // 拿文字对索引做包含校验，只传路径会撞子串（如路径 src 含于「构建脚本集 scripts」）点错枝。
  const picks = tataiBranchPicks();
  if (!picks) {
    ok(false, "④ UI 段：塔台三级下钻枝取形失败（A1/A4 实况里找不到可连钻的「模块 → 子目录」枝）");
    killTree(vite, vitePort);
    return;
  }
  const tataiProject = getProject("tatai", REAL_DATA_DIR);
  const names = tataiProject
    ? readNames(tataiProject.path)
    : { entries: {} as Record<string, { name: string }> };
  const deepModText = `${names.entries[picks.deepMod.id]?.name ?? picks.deepMod.id} ${picks.deepMod.path}`;
  // 第二个项目 = UI_PROJECTS[1]（清单由 `TATAI_REAL_IDS` 定，不在这里写死项目 id：换台机器照跑；
  // 尾修前这里写死 `arg("brain-memory")`，没设 TATAI_REAL_IDS 时直接抛 TypeError 收场）
  // Q6：deepModText 是「中文名 路径」整行文字（含一个空格），不加引号会被 cmd.exe 拆成两个参数——
  // python 侧 argv[14]/argv[15] 整体错位（DEEPER_TEXT2 拿到模块路径、子目录路径被挤掉），
  // 第三层下钻必超时。加双引号保住"一个参数"的口径（python argv[13..15] 与这里一一对应）。
  const cmd =
    `python "${pyPath}" ${vitePort} ${backendPort} ${arg("tatai")} ${arg(UI_PROJECTS[1])} ` +
    `${tatai.index} "${deepModText}" ${picks.deepDir.path}`;
  try {
    const out = execSync(cmd, { cwd: VERIFY_DIR, stdio: "pipe", timeout: 420_000 }).toString();
    process.stdout.write(out);
    ok(out.includes("UI_ASSERT_ALL_PASS"), "④ playwright UI 断言全过（导图可见 / 懒加载 A4 / 导出可核对 / 切换不丢）");
  } catch (e) {
    process.stdout.write((e as { stdout?: Buffer }).stdout?.toString() ?? "");
    process.stderr.write((e as { stderr?: Buffer }).stderr?.toString() ?? "");
    ok(false, "④ UI 段执行失败（见上方输出）");
  } finally {
    killTree(vite, vitePort);
    await sleep(500);
  }
  for (const shot of [
    "n1-01-tatai-mindmap-top.png",
    "n1-02-tatai-mindmap-expanded.png",
    "n1-03-brain-memory-mindmap.png",
  ]) {
    ok(fs.existsSync(path.join(VERIFY_DIR, shot)), `④ UI 截图落盘 .工作台/verify/${shot}`);
  }
}

/** UI 段 python（与 A3/A4/A5/F3/F4 同风格；断言失败打印 [UI FAIL] 并以 UI_ASSERT_FAILS 收尾） */
const PY_SHOT = String.raw`# N1 UI 验证：思维导图（markmap）——层级可见 / 点节点懒加载 A4 子级 / 导出 markdown 可核对 / 切换不丢
# 用法：python n1-shot.py <vitePort> <backendPort> \
#        <idA> <nodesA> <limitA> <indexA> <branchA> <idB> <nodesB> <limitB> <indexB> <branchB> \
#        <tataiDeeperIndex> <tataiDeeperText1> <tataiDeeperText2>
import re
import sys
import time

from playwright.sync_api import sync_playwright

VITE_PORT, BACKEND_PORT = sys.argv[1], sys.argv[2]
A = sys.argv[3:8]
B = sys.argv[8:13]
DEEPER_INDEX, DEEPER_TEXT1, DEEPER_TEXT2 = sys.argv[13], sys.argv[14], sys.argv[15]
BASE = f"http://localhost:{VITE_PORT}"
OUT = "."
fails = []
STEP = {"now": "启动"}   # 当前步骤：页面 JS 异常按步骤归因

def ok(cond, label):
    print(("[UI PASS] " if cond else "[UI FAIL] ") + label)
    if not cond:
        fails.append(label)

def attr(page, sel, name):
    el = page.locator(sel).first
    return el.get_attribute(name) if el.count() else None

def num(page, name):
    v = attr(page, "[data-mindmap-view]", name)
    return int(v) if v not in (None, "") else -1

def cjk(text):
    return bool(re.search(r"[\u4e00-\u9fa5]", text))

def wait_loads(page, n, timeout=40000):
    page.wait_for_function(
        "n => { const el = document.querySelector('[data-mindmap-view]');"
        " return !!el && Number(el.getAttribute('data-mindmap-loads')) >= n; }",
        arg=n, timeout=timeout)

def wait_visible(page, n, timeout=60000):
    """条件等待：画布上真渲染出的节点数到位（折叠的子级不在 DOM 里）"""
    page.wait_for_function(
        "n => document.querySelectorAll('svg.markmap g[data-path]').length >= n", arg=n, timeout=timeout)

def wait_settle(page, timeout=30000, stable=3, gap=120):
    """条件等待画布**稳定**：markmap 重画是 enter/exit 过渡，退出中的旧节点会在 DOM 里多停留
    约 200ms——刚展开时数一遍会数到"旧树 + 新树"两套（N2 实测一次点击后先读到 20、稳定后 14）。
    这里等可见节点数连续 stable 次不变再返回；本卡（N2）实测的首跑 flake 根因就在这里：
    原先固定 wait_for_timeout(800/900) 读到过渡中间态，换成这个条件等待后连跑三次全绿。"""
    last, same, deadline = -1, 0, time.time() + timeout / 1000
    while time.time() < deadline:
        n = nodes_locator(page).count()
        if n == last:
            same += 1
            if same >= stable:
                return n
        else:
            same, last = 0, n
        page.wait_for_timeout(gap)
    return nodes_locator(page).count()

def wait_mm_ready(page, timeout=60000):
    """等"这次 setData 画完了"：data-mindmap-mm-nodes 只在 markmap 渲染完成后写（换项目会归零），
    与导图树节点数相等 = 这次渲染落地。点完一枝后用它当"新渲染已到位"的信号——比"等可见节点数"
    可靠：过渡期间可见节点数是旧+新两套（旧节点要等约 200ms 淡出），拿它当基准会把期望值算错
    （N2 加固时踩过：wait_visible(当前可见数+1) 拿到的是过渡中的 22，期望值直接算成 23）。"""
    page.wait_for_function(
        "() => { const el = document.querySelector('[data-mindmap-view]'); if (!el) return false;"
        " const mm = Number(el.getAttribute('data-mindmap-mm-nodes'));"
        " const n = Number(el.getAttribute('data-mindmap-nodes')); return mm > 0 && mm === n; }",
        timeout=timeout)

def nodes_locator(page):
    return page.locator("svg.markmap g[data-path]")

def svg_text(page):
    """SVG 节点不是 HTMLElement，inner_text 会报错——用 text_content 读节点文字"""
    return page.locator("svg.markmap").text_content() or ""

def markdown_text(page):
    """读导出面板里的 markdown：细节面板不必展开（textContent 与渲染无关，读之前不必开面板，
    也就不会让面板挡住画布上的节点）"""
    return page.locator("[data-mindmap-markdown]").evaluate("el => el.textContent") or ""

def open_export(page):
    """只在要截图时展开导出面板"""
    if page.locator("[data-mindmap-export-panel]").get_attribute("open") is None:
        page.locator("[data-mindmap-export-panel] summary").click()
        page.wait_for_timeout(300)

def click_branch(page, index, text):
    """点某一枝：优先按前序序号（DOM 顺序 = 前序）定位，文字对不上再退回文字匹配；
    真点（mouse）失败时退化为在该节点上派发一次冒泡 click——markmap 缩放过的大树里，
    节点的几何中心可能落在视口外，真点会被 Playwright 的可点击性检查拦下（F4/A4 同款处理）。"""
    loc = nodes_locator(page)
    target = loc.nth(index) if 0 <= index < loc.count() and text in (loc.nth(index).text_content() or "") else \
        page.locator("svg.markmap g[data-path]", has_text=text).first
    try:
        target.click(timeout=6000)
        return "mouse"
    except Exception:
        target.evaluate("el => el.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true}))")
        return "dispatch"

def parse_calls(page):
    v = attr(page, "[data-arch-parse-calls]", "data-arch-parse-calls")
    return int(v) if v not in (None, "") else -1

def run_project(page, pid, want_nodes, limit, index, branch, shot_top=None, shot=None):
    # 两个项目连着跑：只换 hash 不会重载 SPA（视图状态会留在上一个项目的思维导图上），
    # 所以切项目后显式 reload 一次，拿干净的初始态（默认方框图）当基线。
    # 时序一律**条件等待**（N2 加固：原先这里是固定 wait_for_timeout，首跑冷启动会读到中间态）
    page.goto(f"{BASE}/#p/{pid}", wait_until="domcontentloaded")
    page.reload(wait_until="domcontentloaded")
    page.wait_for_selector('button[data-view="arch"]', timeout=60000)
    page.locator('button[data-view="arch"]').click()
    # V06-08：§3.1 把「项目图」默认落点切到「功能全景」；N1 守的是技术详情里的思维导图与懒加载，
    # 所以显式进入「技术详情」——断言、判据与阈值一个字都不动。
    page.locator('[data-project-view-tab="tech"]').click()
    page.wait_for_selector('[data-graph-mode="MIND_MAP"]', timeout=30000)
    # 共用画布要等数据到位才挂出 data-arch-mode（那之前是"加载中…"）：计数与基线都得等它
    page.wait_for_selector('[data-arch-mode="MODULE_BOX"]', timeout=30000)
    ok(page.locator('[data-arch-mode="MODULE_BOX"]').count() == 1, f"① {pid}：技术详情默认方框图（共用画布在挂）")
    parse0 = parse_calls(page)

    # 第三视图：markmap 真渲染（等"这次 setData 画完" + 画布稳定，再读任何数）
    page.locator('[data-graph-mode="MIND_MAP"]').click()
    page.wait_for_selector("svg.markmap g[data-path]", timeout=30000)
    wait_mm_ready(page)
    wait_visible(page, want_nodes)
    vis0 = wait_settle(page)
    nodes0, depth0, loads0 = num(page, "data-mindmap-nodes"), num(page, "data-mindmap-depth"), num(page, "data-mindmap-loads")
    mm0 = num(page, "data-mindmap-mm-nodes")
    ok(page.locator("[data-mindmap-view]").count() == 1, f"① {pid}：架构图 Tab 里有第三个视图「思维导图」（markmap 已渲染）")
    ok(attr(page, "[data-mindmap-view]", "data-mindmap-source") == "selectGraph:MIND_MAP",
       f"② {pid}：导图数据源标记 = selectGraph:MIND_MAP（共用数据层，不新建数据源）")
    ok(nodes0 == want_nodes, f"① {pid}：顶层树 {nodes0} 个节点（根 + 顶层模块 {want_nodes-1}）")
    ok(vis0 == nodes0,
       f"① {pid}：画布上真渲染 {vis0} 个节点 = 树节点 {nodes0}（初次进入默认全折叠，两者相等）")
    ok(depth0 == 2 and loads0 == 0, f"① {pid}：初次进入只有 2 层（根 + 顶层模块），未加载的枝不显示（§3.3 规则 5）")
    ok(nodes0 - 1 <= limit, f"③ {pid}：顶层节点 {nodes0-1} ≤ 硬上限 {limit}（同一份 graph.limits）")
    ok(mm0 == nodes0, f"① {pid}：markmap 实际渲染节点 {mm0} = 树节点 {nodes0}（导出物即渲染输入）")
    text0 = svg_text(page)
    ok(cjk(text0), f"① {pid}：节点文字里有中文名（A2 起名缓存，不是目录名）")
    ok("/" in text0, f"① {pid}：节点文字里带模块路径")
    # 导出 markdown：注释可逐行核对（读 textContent，不必开面板 -> 面板不挡画布上的点击）
    md0 = markdown_text(page)
    lines0 = [l for l in md0.split("\n") if l.startswith("- ")]
    ok(len(lines0) == want_nodes - 1, f"④ {pid}：导出 markdown 顶层 {len(lines0)} 行 = 顶层模块数 {want_nodes-1}")
    ok(all(re.search(r"<!-- id=\S+ path=\S+ files=\d+ from=shared -->", l) or
           re.search(r"<!-- id=__more__ path= files=\d+ from=shared -->", l) for l in lines0),
       f"④ {pid}：导出 markdown 每行带 id/path/files/from 注释（可逐行回查 A1 模块清单）")
    ok(re.search(r"^- \*\*.+\*\* \x60[^\x60]+\x60", lines0[0]) is not None,
       f"④ {pid}：第 1 行形如 '- **中文名** 「路径」'（人话名 + 路径）")
    if shot_top:
        page.screenshot(path=f"{OUT}/{shot_top}")

    # 点节点就地懒加载（A4 arch/expand）：树长大、层变深、DOM 记下耗时。
    # 时序：等加载记账 → 等这次渲染落地（mm-nodes 跟上）→ 等画布稳定，然后才读可见节点数
    STEP["now"] = f"{pid}:点枝 {branch}"
    how = click_branch(page, index, branch)
    wait_loads(page, 1)
    wait_mm_ready(page)
    vis1 = wait_settle(page)
    ok(vis1 > vis0, f"① {pid}：展开后画布上真渲染 {vis0} → {vis1} 个节点（等画布稳定后计数）")
    nodes1, depth1, loads1 = num(page, "data-mindmap-nodes"), num(page, "data-mindmap-depth"), num(page, "data-mindmap-loads")
    ms1 = num(page, "data-mindmap-last-ms")
    ok(loads1 == 1, f"④ {pid}：点节点就地懒加载走了一次 A4（data-mindmap-loads=1，定位方式 {how}）")
    ok(nodes1 > nodes0 and depth1 == 3, f"① {pid}：展开 {branch} 后 {nodes0} → {nodes1} 节点、{depth0} → {depth1} 层")
    text1 = svg_text(page)
    ok(text1.count(".") > text0.count("."), f"① {pid}：展开后画布上出现文件级节点（'.' 计数 {text0.count('.')} → {text1.count('.')}）")
    md1 = markdown_text(page)
    ok("from=expand" in md1, f"④ {pid}：导出 markdown 里下钻行标 from=expand（A4 出处可核对）")
    ok(re.search(r"<!-- id=\S+ path=" + re.escape(branch) + r" files=\d+ from=shared -->", md1) is not None,
       f"④ {pid}：展开的那枝是顶层行（id/path 注释与 A4 入参对得上）")
    if shot:
        open_export(page)
        page.screenshot(path=f"{OUT}/{shot}")
    # 切走再切回：懒加载结果不丢，且没有第二次全量解析
    STEP["now"] = f"{pid}:切走再切回"
    page.locator('[data-graph-mode="MODULE_BOX"]').click()
    page.wait_for_selector("[data-arch-view]", timeout=30000)
    wait_settle(page)
    ok(nodes_locator(page).count() > 0, f"③ {pid}：切回方框图时导图隐藏但不卸载（markmap 节点仍在 DOM）")
    page.locator('[data-graph-mode="MIND_MAP"]').click()
    wait_settle(page)
    nodes2, loads2 = num(page, "data-mindmap-nodes"), num(page, "data-mindmap-loads")
    ok(nodes2 == nodes1 and loads2 == 1, f"③ {pid}：切回来还是展开态（{nodes2} 节点 / 懒加载 {loads2} 次，没重新拉一遍）")
    ok(parse_calls(page) == parse0, f"③ {pid}：进出思维导图没触发第二次全量解析（解析入口计数 {parse0} 不变）")
    print(f"[UI] {pid}：A4 懒加载 {ms1}ms · 展开后 {nodes1} 节点 / {depth1} 层 · 顶层 {nodes0-1} 个模块 ≤ 上限 {limit}")
    return {"nodes": nodes1, "depth": depth1, "ms": ms1, "top": nodes0}

def run_tatai_deeper(page, first_index, deeper_index, text1, text2):
    """塔台：接着钻两级（模块 → 子目录 → 文件；枝由 ts 侧按 A1/A4 实况动态传入），证明逐级下钻到文件级"""
    ok(num(page, "data-mindmap-loads") == 1, "① tatai：当前已展开一枝（接着钻下一级）")
    click_branch(page, deeper_index, text1)
    wait_loads(page, 2)
    wait_mm_ready(page)
    wait_settle(page)
    ok(num(page, "data-mindmap-depth") == 3, "① tatai：第二枝展开（出现子目录级）")
    click_branch(page, -1, text2)
    wait_loads(page, 3)
    wait_mm_ready(page)
    wait_settle(page)
    nodes, depth, loads = num(page, "data-mindmap-nodes"), num(page, "data-mindmap-depth"), num(page, "data-mindmap-loads")
    ms = num(page, "data-mindmap-last-ms")
    md = markdown_text(page)
    deep_lines = [l for l in md.split("\n") if "from=expand" in l]
    ok(depth == 4 and nodes > 0, f"① tatai：钻到第 4 层（根 → 模块 → 子模块 → 文件），{nodes} 节点 / 懒加载 {loads} 次")
    ok(len(deep_lines) > 0 and all(re.search(r"<!-- id=\S+ path=\S+ files=\d+ from=expand -->", l) or
                                   re.search(r"<!-- id=__more__:[^ ]+ path= files=0 from=expand -->", l) for l in deep_lines),
       f"④ tatai：{len(deep_lines)} 行下钻节点全带 id/path/files/from=expand 注释（聚合节点 path 为空串）")
    ok(re.search(r"^    - .*\x60" + re.escape(text2) + r"/\S+\x60", md, re.M) is not None,
       "④ tatai：第 4 层文件行的缩进与路径对得上（'    - 文件名 「text2/…」'）")
    open_export(page)
    page.screenshot(path=f"{OUT}/n1-02-tatai-mindmap-expanded.png")
    print(f"[UI] tatai：三级下钻后 {nodes} 节点 / {depth} 层 / 懒加载 {loads} 次（最近一次 {ms}ms）")
    return nodes

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_context(viewport={"width": 1600, "height": 950}).new_page()
    errors = []
    # 页面异常按步骤归因 + 带栈：N2 加固时实测偶发一条 SVGLength 页面异常
    # （「Could not resolve relative length」，约 1/3 次全跑出现一次），定位需要知道它发生在哪一步、来自哪一行
    page.on("pageerror", lambda e: errors.append(f"[{STEP['now']}] {e}\n{getattr(e, 'stack', '(无栈)')}"))
    expands = []
    page.on("request", lambda r: expands.append(r.url) if "/arch/expand" in r.url else None)

    # ── 塔台：顶层 → 第 3 层 → 第 4 层 ──
    STEP["now"] = f"{A[0]}:初次进入"
    t = run_project(page, A[0], int(A[1]), int(A[2]), int(A[3]), A[4],
                    shot_top="n1-01-tatai-mindmap-top.png")
    STEP["now"] = f"{A[0]}:三级下钻"
    top_and_expanded = run_tatai_deeper(page, int(A[3]), int(DEEPER_INDEX), DEEPER_TEXT1, DEEPER_TEXT2)

    # ── 另一个真实项目：中文名来自 A2 缓存 + 中等枝懒加载耗时 ──
    STEP["now"] = f"{B[0]}:初次进入"
    b = run_project(page, B[0], int(B[1]), int(B[2]), int(B[3]), B[4],
                    shot="n1-03-brain-memory-mindmap.png")

    ok(len(expands) == 4, f"④ 全程只发了 4 次 A4 懒加载请求（{len(expands)} 次：塔台 3 枝 + 另一个真实项目 1 枝，没有第二套解析通道）")
    ok(not errors, f"④ 全程零页面 JS 异常（{errors[:1] if errors else '无'}）")
    print(f"[UI] 耗时汇总：{A[0]} 顶层 {t['top']-1} 模块 / A4 懒加载 {t['ms']}ms / 三级下钻后 {top_and_expanded} 节点；"
          f"{B[0]} 顶层 {b['top']-1} 模块 / A4 懒加载 {b['ms']}ms / 展开后 {b['nodes']} 节点")
    browser.close()

print("UI_ASSERT_ALL_PASS" if not fails else f"UI_ASSERT_FAILS:{len(fails)}")
`;

// ───────────────────────── 主流程 ─────────────────────────

/** UI 段另一个真实项目要点的枝：挑文件数中等、结构浅的模块（只贴路径，不贴内容） */
function pickBranchModule(id: string): { id: string; path: string } | null {
  const modules = readModules(id, REAL_DATA_DIR);
  if (!modules.exists || !modules.arch) return null;
  const pick = [...modules.arch.modules]
    .filter((m) => m.file_count > 0 && m.file_count <= 60 && m.path !== "." && !m.path.includes(","))
    .sort((a, b) => a.file_count - b.file_count || a.id.localeCompare(b.id))[0];
  return pick ? { id: pick.id, path: pick.path } : null;
}

/** 塔台 UI 段的三级下钻取形（2026-09-18 骨架无关化）：导图要点的枝不写死——
 *  first = 第一个有直属文件子级的顶层模块（展开后文件级节点立即出现，供 run_project 一枝懒加载）；
 *  deepMod = 另一个「子目录里有直属文件」的模块，deepDir 是它的那个子目录
 *  （供 run_tatai_deeper 两级连钻：模块 → 子目录 → 文件）。全部从 A1 modules.json + A4 expand 实况算。 */
function tataiBranchPicks(): {
  first: { id: string; path: string };
  deepMod: { id: string; path: string };
  deepDir: { id: string; path: string };
} | null {
  const project = getProject("tatai", REAL_DATA_DIR);
  const modules = readModules("tatai", REAL_DATA_DIR);
  if (!project || !modules.exists || !modules.arch) return null;
  const root = project.path;
  const info = modules.arch.modules.map((m) => {
    const r = expandDirectory(root, m.path);
    const dirWithFiles = r.children.find(
      (c) => c.kind === "dir" && expandDirectory(root, c.path).children.some((cc) => cc.kind === "file"),
    );
    return { m, hasFile: r.children.some((c) => c.kind === "file"), dirWithFiles };
  });
  const first = info.find((x) => x.hasFile);
  const deep = info.find((x) => x.m.id !== first?.m.id && x.dirWithFiles);
  if (!first || !deep?.dirWithFiles) return null;
  return {
    first: { id: first.m.id, path: first.m.path },
    deepMod: { id: deep.m.id, path: deep.m.path },
    deepDir: { id: deep.dirWithFiles.id, path: deep.dirWithFiles.path },
  };
}

async function main(): Promise<void> {
  console.log("[verify] ── ④ 端口：先探 8787 / 5173 是不是别人的（本脚本一律动态端口，绝不杀既有监听）");
  const fixedBefore = { v: await portListening(8787), d: await portListening(5173) };
  console.log(
    `[verify]   8787 ${fixedBefore.v ? "有人监听（别人的，不碰）" : "空闲"} · 5173 ${fixedBefore.d ? "有人监听（别人的，不碰）" : "空闲"}`,
  );

  console.log("\n[verify] ── ① ② ③ 脚本侧：真实项目导图取数 + markdown 逐层回查 + 硬上限/耗时");
  const reports: ProjectReport[] = [];
  for (const id of PROJECTS) {
    const r = checkProject(id);
    if (r) reports.push(r);
  }
  const registeredProjects = PROJECTS.filter((id) => getProject(id, REAL_DATA_DIR) !== null);
  ok(
    reports.length === registeredProjects.length,
    `③ 注册表里点名的真实项目都过了一遍（点名 ${PROJECTS.length} 个 / 已登记 ${registeredProjects.length} 个 / 有报告 ${reports.length} 个；清单＝塔台自身 + TATAI_REAL_IDS）`,
  );
  if (registeredProjects.length < 2) {
    skip(
      "③ 多真实项目对照（≥2 个）",
      `设 TATAI_REAL_IDS=<已登记的项目 id,…>（并保证它们在 TATAI_HOME 的注册表里）后可跑，${SYNTH_HINT}`,
    );
  }
  const totalMs = reports.map((r) => r.ms.tree + r.ms.markdown + r.ms.transform);
  ok(
    totalMs.every((ms) => ms < 50),
    `③ 各项目取数+导出+markmap 解析都是毫秒级（最慢 ${Math.max(...totalMs).toFixed(2)}ms，无"卡"）`,
  );
  ok(
    reports.every((r) => r.nodes - 1 <= r.limit),
    `③ 顶层节点均 ≤ 硬上限（${reports.map((r) => `${r.id}:${r.nodes - 1}/${r.limit}`).join(" · ")}）`,
  );

  console.log("\n[verify] ── ① 塔台三层下钻（顶层 → 子模块 → 文件，逐层回查 A4 真结果）");
  checkTataiDeeper();

  console.log("\n[verify] ── ③ 50 模块夹具：导图的硬上限/聚合与共用层同一份");
  checkFixture();

  console.log("\n[verify] ── ②③ 源码级红线：视图层零第二数据源、导图零自建截断");
  checkSourceRedlines();

  const tataiReport = reports.find((r) => r.id === "tatai");
  if (tataiReport) {
    console.log("\n[verify] ── ④ 真实 markdown 片段（塔台，顶层样例：根 + 前 3 行）");
    console.log(
      tataiReport.markdown
        .split("\n")
        .slice(0, 5)
        .map((l) => `[verify]     ${l}`)
        .join("\n"),
    );
  }

  console.log("\n[verify] ── ④ UI 段：playwright 真起塔台 + 另一个真实项目的思维导图");
  const tataiPicks = tataiBranchPicks();
  const expected = new Map<string, UiExpect>();
  for (const id of UI_PROJECTS) {
    const r = reports.find((x) => x.id === id);
    // 塔台的枝骨架无关（2026-09-18）：第一个有直属文件子级的顶层模块，不再锚 src/arch
    const branch =
      id === "tatai"
        ? tataiPicks
          ? { id: tataiPicks.first.id, path: tataiPicks.first.path }
          : null
        : pickBranchModule(id);
    if (!r || !branch) {
      ok(false, `④ UI 段缺前置数据：${id}（共用层报告 ${r ? "有" : "无"} / 可点枝 ${branch ? "有" : "无"}）`);
      continue;
    }
    const index = preOrderIndex(r.tree.root, branch.id);
    ok(index > 0, `④ ${id}：UI 要展开的枝 ${branch.path}（前序序号 ${index}）在导图树里定位到`);
    expected.set(id, { nodes: r.nodes, limit: r.limit, index, branch: branch.path });
  }
  ok(
    UI_PROJECTS.every((id) => expected.has(id)),
    `④ UI 段参数齐备（${UI_PROJECTS.map((id) => `${id}:${expected.get(id)?.branch ?? "缺"}`).join(" · ")}）`,
  );
  // UI 段的 python 固定吃"塔台 + 另一个真实项目"两组参数（同屏对照两种项目），少一个就凑不出这一组：
  // 没有 TATAI_REAL_IDS（只剩塔台自己）时这里按 SKIP 收场（退出码 3），不许在半路上崩（尾修前会
  // 拿 undefined 去取参数，抛 TypeError 收尾——那既不是 FAIL 也不是 SKIP，读不出结论）。
  if (UI_PROJECTS.length < 2) {
    skip(
      "④ UI 段（playwright：两个真实项目的思维导图）",
      `需要塔台自身 + TATAI_REAL_IDS 里的另一个真实项目（且已解析过、有可点枝）：设好后重跑，${SYNTH_HINT}`,
    );
    return;
  }
  if (!UI_PROJECTS.every((id) => expected.has(id))) {
    skip(
      "④ UI 段（playwright：两个真实项目的思维导图）",
      `需要塔台自身 + TATAI_REAL_IDS 里的另一个真实项目（且已解析过、有可点枝）：设好后重跑，${SYNTH_HINT}`,
    );
    return;
  }

  const backendPort = await pickFreePort();
  const viteEntry = path.join(REPO_ROOT, "node_modules", "vite", "bin", "vite.js");
  let backend: ChildProcess | null = null;
  // N2 起思维导图会记住展开态（`<项目根>/.工作台/arch/mindmap-fold.json`）：本卡的"初次进入
  // 只见顶层"必须是干净现场，所以先把两个 UI 项目的折叠态快照下来再清空，跑完逐字节还原
  // （同 verify-f4 对 layout.json 的处理；折叠态是运行态数据，不进 git）。
  const foldSnapshots = snapshotFolds(UI_PROJECTS);
  try {
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
    );
    await uiPlaywright(expected, viteEntry, backendPort);
  } finally {
    restoreFolds(foldSnapshots);
    if (backend) {
      intentionalStop.add(backendPort);
      backend.kill();
    }
    await sleep(300);
  }

  console.log("\n[verify] ── ⑤ 收尾：进程杀净 + 动态端口已释放 + 8787/5173 仍是别人的");
  await sleep(1200);
  ok(!(await portListening(backendPort)), `⑤ 后端动态端口 ${backendPort} 已释放（进程杀净）`);
  const fixedAfter = { v: await portListening(8787), d: await portListening(5173) };
  ok(
    fixedBefore.v === fixedAfter.v && fixedBefore.d === fixedAfter.d,
    `⑤ 8787/5173 状态与开工前一致（${fixedAfter.v ? "有人在用" : "空闲"} / ${fixedAfter.d ? "有人在用" : "空闲"}）——本脚本没占用、没杀 PID`,
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
