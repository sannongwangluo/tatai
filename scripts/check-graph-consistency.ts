// F4 一致性检查脚本（PLAN F4 卡指定的产出文件名）：两视图**节点集合**比对 + **边集合**子集关系与差异计数。
// 用法：pnpm check:graph
//
// 为什么单独有这一条：§3.2 的红线是「三视图共享同一份邻居数据，节点集合相同、边集合按方向过滤/着色」。
// 这条红线跨视图，各卡自己的单测看不见——本脚本把两个视图的 `selectGraph` 产物摆在同一次运行里逐 id 对，
// 给出**一致 / 不一致**的结论（DoD① 的输出口径），不一致时打印差集明细，供人直接定位是哪一边多/少了节点。
//
// 覆盖点（对应 PLAN F4 DoD①②）：
//   ① 节点集合：同一项目下 MODULE_BOX 与 DATA_FLOW 逐 id 全等（真实项目 + 手写夹具），输出结论行；
//   ② 边集合（复用 F2/F3 口径）：方框图边 = E_ALL 原样；数据流向图 E_flow ⊆ E_ALL（还原成依赖方向边键后
//      逐条落在 E_ALL 内）、差异计数 = 互惠对归并数 + 自环剔除数，且交集只剩归并出的互惠边；
//   ③ 布局记忆按视图分键（DoD②，F4 卡的跑偏点）：v1 旧结构迁移一条不丢 +「方框图拖 A → 数据流向图拖 B →
//      切回方框图」的真实前后 diff（A 仍在原位、B 不越界到方框图）。
//
// 本脚本**不起任何服务、不占端口**（纯进程内读注册表 + 共用数据层 + 布局存储），所以在有残留 dev server 的
// 机器上也能稳定复现；要真起 UI 的两视图切换证据见 `pnpm verify:f4`。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DATA_FLOW_EDGE_RULE,
  DATA_FLOW_DIRECTION,
  DEP_EDGE_DIRECTION,
  EDGE_SET_SOURCE,
  GRAPH_MODES,
  NODE_SET_RULE,
} from "../src/arch/graph-mode";
import {
  buildSharedGraphFrom,
  selectGraph,
  type GraphNode,
  type SharedGraph,
} from "../src/arch/shared-graph";
import { buildSharedGraph } from "../src/arch/render";
import { LAYOUT_MIGRATION_MODE, readLayoutByRoot, savePositionsByRoot, type NodePosition } from "../src/arch/layoutStore";
import { listProjects } from "../src/server/registry";
import { ensureSelfRegistered, realHome } from "./lib/fixtures";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REAL_DATA_DIR = realHome(); // TATAI_HOME > 缺省 ~/.tatai（脚本不写死作者本机路径）
ensureSelfRegistered(REAL_DATA_DIR); // 塔台自身＝本仓库：幂等登记，脚本换台机器也能跑

const ok = (cond: boolean, label: string) => {
  console.log(`[consistency] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (!cond) process.exitCode = 1;
};

const idsOf = (nodes: GraphNode[]) => nodes.map((n) => n.id).sort();
const edgeKeys = (edges: { from: string; to: string }[]) => edges.map((e) => `${e.from}>${e.to}`).sort();
const posLine = (positions: Record<string, NodePosition>) => JSON.stringify(positions);

/** 一个项目的两视图比对结果（结论行 + 差集明细 + 两条口径断言的结果） */
interface ViewCompare {
  id: string;
  label: string;
  nodes: number;
  boxEdges: number;
  flowEdges: number;
  /** 节点集合差集（两边都空 = 一致） */
  onlyInBox: string[];
  onlyInFlow: string[];
  /** 边集合口径是否成立（E_flow ⊆ E_ALL、差异计数 = 归并互惠对） */
  edgeRuleHolds: boolean;
}

/** 逐 id 比对两视图节点集合 + 边集合子集关系，打印结论行，返回结论与差集 */
function compareViews(id: string, label: string, graph: SharedGraph): ViewCompare {
  const box = selectGraph("MODULE_BOX", graph);
  const flow = selectGraph("DATA_FLOW", graph);
  const boxIds = new Set(idsOf(box.nodes));
  const flowIds = new Set(idsOf(flow.nodes));
  const onlyInBox = [...boxIds].filter((n) => !flowIds.has(n));
  const onlyInFlow = [...flowIds].filter((n) => !boxIds.has(n));

  // ── 边集合口径（复用 F2/F3 的定义）：方框图 = E_ALL 原样；数据流向图 = E_ALL - 归并互惠对 ──
  const boxKeys = new Set(edgeKeys(box.edges));
  const flowKeys = edgeKeys(flow.edges);
  // 每条渲染边还原成依赖方向的边键必落在 E_ALL 内（互惠归并边自身方向就是 E_ALL 里的那条，也在内）
  const subsetHolds = flow.edges.every((e) => boxKeys.has(`${e.to}>${e.from}`));
  const shared = flowKeys.filter((k) => boxKeys.has(k));
  const expectFlowEdges = graph.edges.length - flow.stats.merged_mutual_pairs;
  const edgeRuleHolds =
    box.edges.length === graph.edges.length &&
    flow.edges.length === expectFlowEdges &&
    shared.length === flow.stats.merged_mutual_pairs &&
    flow.edges.length <= graph.edges.length &&
    subsetHolds;

  console.log(
    `[consistency] ${label}（${id}）：节点 ${graph.nodes.length} 个 · 方框图边 ${box.edges.length} 条 · ` +
      `数据流向图边 ${flow.edges.length} 条（剔自环 ${flow.stats.dropped_self_loop} · 互惠对归并 ${flow.stats.merged_mutual_pairs} 对）`,
  );
  console.log(
    `[consistency]   节点集合比对：方框图 ${boxIds.size} 个 / 数据流向图 ${flowIds.size} 个 → ${
      onlyInBox.length === 0 && onlyInFlow.length === 0
        ? "【一致】（逐 id 全等，差集 0）"
        : `【不一致】方差集 ${JSON.stringify({ only_in_box: onlyInBox, only_in_flow: onlyInFlow })}`
    }`,
  );
  console.log(
    `[consistency]   边集合比对：E_ALL ${graph.edges.length} 条 → 方框图 ${box.edges.length} 条（edgeRule=${GRAPH_MODES.MODULE_BOX.edgeRule}）；` +
      `数据流向图 ${flow.edges.length} 条（edgeRule=${GRAPH_MODES.DATA_FLOW.edgeRule}，期望 E_ALL-归并 ${expectFlowEdges}）→ ` +
      `${edgeRuleHolds ? "【一致】（E_flow ⊆ E_ALL；交集只剩归并出的互惠边 " + shared.length + " 条）" : "【不一致】（子集关系或差异计数对不上）"}`,
  );
  return {
    id,
    label,
    nodes: graph.nodes.length,
    boxEdges: box.edges.length,
    flowEdges: flow.edges.length,
    onlyInBox,
    onlyInFlow,
    edgeRuleHolds,
  };
}

// ───────────────────────── 夹具：确定性对照（计数可手算） ─────────────────────────

/** 夹具：6 模块（含一对互惠 lib↔util）——够触发"归并"与"方向翻转"两件事 */
const FIXTURE_MODULES = [
  { id: "page", path: "src/page", file_count: 6, deps: [{ to: "core", weight: 2 }] },
  { id: "core", path: "src/core", file_count: 5, deps: [{ to: "util", weight: 2 }, { to: "lib", weight: 5 }] },
  { id: "util", path: "src/util", file_count: 4, deps: [{ to: "lib", weight: 1 }] },
  { id: "lib", path: "src/lib", file_count: 3, deps: [{ to: "util", weight: 1 }] },
  { id: "dbfile", path: "data/db", file_count: 2, deps: [] },
  { id: "docs", path: "docs", file_count: 1, deps: [] },
];
const FIXTURE_NAMES = Object.fromEntries(
  FIXTURE_MODULES.map((m) => [m.id, { name: `模块-${m.id}`, blurb: "", kind: "code" as const }]),
);

// ───────────────────────── ② 布局记忆按视图分键（DoD②：F4 跑偏点防线） ─────────────────────────

/** 读磁盘 layout.json 的原文（diff 用；脚本自己解析一遍，不复用被测函数的产物） */
function rawLayout(file: string): string {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").replace(/\s+/g, " ").trim() : "（缺文件）";
}

function sectionLayoutPerView(tmpBase: string): void {
  console.log("\n[consistency] ── ② 布局记忆按视图分键（方框图拖 A → 数据流向图拖 B → 切回方框图）");
  const root = path.join(tmpBase, "proj-layout");
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, ".工作台", "arch", "layout.json");

  // 起点：空白项目（两个视图里都没拖过）
  ok(
    Object.keys(readLayoutByRoot(root).positions).length === 0,
    "② 起点：无 layout.json → 两视图坐标皆空（空态不报错）",
  );

  // 拖动 1：方框图把 src-arch 拖到 A
  const A: NodePosition = { x: 120.5, y: -40.25 };
  savePositionsByRoot(root, { "src-arch": A }, "MODULE_BOX");
  const afterDragA = rawLayout(file);
  const boxBefore = posLine(readLayoutByRoot(root).positions.MODULE_BOX ?? {});
  console.log(`[consistency]   拖动 1（方框图拖 src-arch → ${posLine({ "src-arch": A })}）后 layout.json：${afterDragA}`);

  // 拖动 2：切到数据流向图，把 src-server 拖到 B
  const B: NodePosition = { x: 880, y: 640 };
  savePositionsByRoot(root, { "src-server": B }, "DATA_FLOW");
  const afterDragB = rawLayout(file);
  console.log(`[consistency]   拖动 2（数据流向图拖 src-server → ${posLine({ "src-server": B })}）后 layout.json：${afterDragB}`);

  // 切回方框图：画布按 ArchCanvas 的 merge 口径读 positions[MODULE_BOX]
  const back = readLayoutByRoot(root);
  const boxBucket = back.positions.MODULE_BOX ?? {};
  const flowBucket = back.positions.DATA_FLOW ?? {};
  const boxAfter = posLine(boxBucket);
  console.log(`[consistency]   切回方框图读到 positions.MODULE_BOX = ${boxAfter}`);
  console.log(`[consistency]   数据流向图那份 positions.DATA_FLOW = ${posLine(flowBucket)}`);
  console.log(
    `[consistency]   前后 diff（MODULE_BOX 桶）：拖动 2 前 ${boxBefore} → 拖动 2 后 ${boxAfter}（${
      boxBefore === boxAfter ? "零改动：数据流向图的拖动没碰方框图坐标" : "被改动（异常：切视图跳位）"
    }）`,
  );
  console.log(
    `[consistency]   文件 diff：拖动 1 后 ${afterDragA} → 拖动 2 后 ${afterDragB}（新增的只有 DATA_FLOW 桶）`,
  );

  ok(
    boxBefore === boxAfter && boxBucket["src-arch"]?.x === A.x && boxBucket["src-arch"]?.y === A.y,
    `② 切回方框图 A（src-arch）坐标仍在原位 ${posLine({ "src-arch": boxBucket["src-arch"] })}（拖动 2 只写 DATA_FLOW 桶）`,
  );
  ok(
    boxBucket["src-server"] === undefined,
    "② 数据流向图拖的 B（src-server）没有落进方框图坐标（两视图互不覆盖）",
  );
  ok(
    flowBucket["src-arch"] === undefined && flowBucket["src-server"]?.x === B.x && flowBucket["src-server"]?.y === B.y,
    `② 数据流向图桶里只有 B ${posLine({ "src-server": flowBucket["src-server"] })}，方框图拖的 A 没有越界过去`,
  );
  ok(
    back.version === 2 &&
      Object.keys(back.positions).sort().join(",") === ["DATA_FLOW", LAYOUT_MIGRATION_MODE].sort().join(","),
    `② 磁盘结构 v2 按视图分键：positions 的键 = ${Object.keys(back.positions).join(", ")}`,
  );

  // ── ②b v1 旧结构（A4 时代的真实文件形态）：迁到 MODULE_BOX + 原子写回，用户已拖的位置一条不丢 ──
  console.log("\n[consistency] ── ②b v1 旧结构兼容（A4 时代只有方框图，旧坐标归 MODULE_BOX）");
  const legacyRoot = path.join(tmpBase, "proj-layout-v1");
  fs.mkdirSync(path.join(legacyRoot, ".工作台", "arch"), { recursive: true });
  const legacyFile = path.join(legacyRoot, ".工作台", "arch", "layout.json");
  const legacyPositions: Record<string, NodePosition> = {
    templates: { x: 1397.2650173721331, y: 1774.7511728206964 },
    scripts: { x: 12, y: 34 },
  };
  fs.writeFileSync(legacyFile, JSON.stringify({ version: 1, positions: legacyPositions }, null, 2) + "\n", "utf8");
  console.log(`[consistency]   v1 旧文件（拖动过 ${Object.keys(legacyPositions).length} 个节点）：${rawLayout(legacyFile)}`);
  const migrated = readLayoutByRoot(legacyRoot);
  const onDisk = JSON.parse(fs.readFileSync(legacyFile, "utf8")) as {
    version: number;
    positions: Record<string, Record<string, NodePosition>>;
  };
  console.log(`[consistency]   迁移后磁盘内容：${rawLayout(legacyFile)}`);
  ok(
    migrated.version === 2 && JSON.stringify(migrated.positions.MODULE_BOX) === JSON.stringify(legacyPositions),
    `②b v1 坐标一条不丢地归给 ${LAYOUT_MIGRATION_MODE}（${Object.keys(legacyPositions).length} 个节点坐标逐字节一致）`,
  );
  ok(
    onDisk.version === 2 &&
      Object.keys(onDisk.positions).join() === LAYOUT_MIGRATION_MODE &&
      !fs.existsSync(`${legacyFile}.tmp`),
    "②b 升级时原子写回磁盘（已落成 v2，无残留 .tmp 临时文件）",
  );
  savePositionsByRoot(legacyRoot, { templates: { x: 5, y: 6 } }, "DATA_FLOW");
  const legacyAfter = readLayoutByRoot(legacyRoot);
  ok(
    legacyAfter.positions.MODULE_BOX.templates.x === legacyPositions.templates.x &&
      legacyAfter.positions.DATA_FLOW.templates.x === 5,
    "②b 迁移后的 MODULE_BOX 坐标不被另一个视图的写覆盖（两视图各存各的）",
  );

  // ── ②c 真实项目的 layout.json（只读复制成 v1 形态再迁，证明真数据也不丢）──
  const realFile = path.join(REPO_ROOT, ".工作台", "arch", "layout.json");
  if (!fs.existsSync(realFile)) {
    console.log("[consistency]   本项目还没有 layout.json（没在界面上拖过节点），跳过真实数据迁移对照");
    return;
  }
  const real = JSON.parse(fs.readFileSync(realFile, "utf8")) as {
    version: number;
    positions: Record<string, Record<string, NodePosition> | NodePosition>;
  };
  const realPositions: Record<string, NodePosition> =
    real.version === 1
      ? (real.positions as Record<string, NodePosition>)
      : ((real.positions[LAYOUT_MIGRATION_MODE] ?? {}) as Record<string, NodePosition>);
  console.log(
    `[consistency]   真实塔台 layout.json（version ${real.version}，${Object.keys(realPositions).length} 个节点坐标）：${posLine(realPositions)}`,
  );
  if (Object.keys(realPositions).length === 0) {
    console.log("[consistency]   真实塔台 layout.json 里没有坐标记录（空态），跳过真实数据迁移对照");
    return;
  }
  const copyRoot = path.join(tmpBase, "proj-layout-real");
  fs.mkdirSync(path.join(copyRoot, ".工作台", "arch"), { recursive: true });
  fs.writeFileSync(
    path.join(copyRoot, ".工作台", "arch", "layout.json"),
    JSON.stringify({ version: 1, positions: realPositions }, null, 2) + "\n",
    "utf8",
  );
  const copied = readLayoutByRoot(copyRoot);
  ok(
    JSON.stringify(copied.positions[LAYOUT_MIGRATION_MODE]) === JSON.stringify(realPositions),
    `②c 真实塔台已拖过的 ${Object.keys(realPositions).length} 个节点坐标迁移后逐字节一致（用户摆过的位置不丢）`,
  );
}

// ───────────────────────── 主流程 ─────────────────────────

function main(): void {
  console.log(`[consistency] ── ① 两视图节点集合比对（节点来源：${NODE_SET_RULE}；边来源：${EDGE_SET_SOURCE}）`);
  const results: ViewCompare[] = [compareViews("fixture", "夹具 6 模块", buildSharedGraphFrom(FIXTURE_MODULES, FIXTURE_NAMES))];

  console.log("\n[consistency] ── ①b 真实项目（注册表里已解析过 modules.json 的）");
  for (const p of listProjects(REAL_DATA_DIR)) {
    const { exists, graph } = buildSharedGraph(p.id, { dataDir: REAL_DATA_DIR });
    if (!exists || !graph) {
      console.log(`[consistency]   ${p.id}（${p.name}）：还没解析过架构（arch/modules.json 缺）→ 跳过，如实报告`);
      continue;
    }
    results.push(compareViews(p.id, p.name, graph));
  }

  const nodeMismatch = results.filter((r) => r.onlyInBox.length > 0 || r.onlyInFlow.length > 0);
  const edgeMismatch = results.filter((r) => !r.edgeRuleHolds);
  console.log("\n[consistency] ── 结论");
  console.log(
    `[consistency]   节点集合：${results.length - nodeMismatch.length}/${results.length} 组【一致】` +
      `（差集合计 方框图独有 ${results.reduce((n, r) => n + r.onlyInBox.length, 0)} 个 / 数据流向图独有 ${results.reduce((n, r) => n + r.onlyInFlow.length, 0)} 个）`,
  );
  console.log(
    `[consistency]   边集合子集关系与差异计数：${results.length - edgeMismatch.length}/${results.length} 组【一致】` +
      `（口径：方框图 edgeRule=${GRAPH_MODES.MODULE_BOX.edgeRule} = E_ALL 原样；数据流向图 edgeRule=${GRAPH_MODES.DATA_FLOW.edgeRule}` +
      `，steps=${DATA_FLOW_EDGE_RULE.steps.join(" → ")}，方向 ${DEP_EDGE_DIRECTION} → ${DATA_FLOW_DIRECTION}）`,
  );
  ok(
    nodeMismatch.length === 0,
    `① 两视图节点集合**一致**（逐 id 全等，${results.length} 组）：${results.map((r) => `${r.id} ${r.nodes} 个`).join(" · ")}`,
  );
  ok(
    edgeMismatch.length === 0,
    `① 两视图边集合口径一致：${results.map((r) => `${r.id} ${r.boxEdges}→${r.flowEdges}`).join(" · ")}（方框图条数 → 数据流向图条数，差值 = 归并互惠对）`,
  );

  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-f4-consistency-"));
  try {
    sectionLayoutPerView(tmpBase);
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }

  console.log(
    process.exitCode
      ? "\n[consistency] 结论：存在不一致项（见上面 FAIL 行）→ 两视图口径已分叉，按 PLAN F4 跑偏点打回"
      : "\n[consistency] 结论：两视图【一致】——节点集合同一份、边集合是同一全量集合的子集、布局记忆按视图分键互不覆盖",
  );
}

try {
  main();
} catch (err) {
  console.error("[consistency] 异常:", err);
  process.exitCode = 1;
}
