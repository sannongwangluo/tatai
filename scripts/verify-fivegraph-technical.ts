// 五图技术详情（模块方框图 + 思维导图）定向回归（用 tsx 跑）：pnpm exec tsx scripts/verify-fivegraph-technical.ts
//
// 覆盖 DESIGN §3.2（技术详情两图共用同一份静态关系层）/§3.3（聚合不得吃掉可达性、按需下钻）/
// §4.1（规划层并入的唯一合并点、模型不写状态）/§4.3（防爆炸四招、截断实现全仓唯一）/§4.7 的**可断言部分**：
//   ① 代码扫描输入：共用层节点集合唯一来源，三模式逐 id 全等（零截断）；
//   ② 防爆炸口径：50 模块夹具 → 14 保留 + 1 聚合；`capChildren` 前后计数自洽；**源码级红线**
//      ——A4（`expand.ts`）只调用共用层的 `capChildren`/`defaultChildLimit`，**不引** `ARCH_LIMITS`/`MORE_NODE_ID`；
//   ③ 目录根 / 孤立节点：`path:"."`（根散文件模块）与孤立节点在三模式下都在场、不被过滤；
//   ④ 规划分层：并入的规划节点 path 为空、**不可下钻**（`canDrillSharedNode=false`），静态模块仍可下钻；
//      规划边带 origin/plan_kind（不冒充静态 import）；
//   ⑤ 深层展开（A4）：隔离临时夹具上真跑 `expandDirectory`——子级 id 唯一、路径落在子树内、
//      依赖边端点闭合、聚合节点是不可下钻的叶子、文件节点是叶子；
//   ⑥ 思维导图层级契约：`buildMindTree` 节点计数/层数自洽、每个共用节点恰好出现一次、
//      层级边只由路径包含关系推出（不凭空造层级）、按需下钻只加载被展开的枝；
//   ⑦ 下钻控件口径接线：方框图（ArchCanvas）与导图（isDrillable）对"没有真实路径的节点"一致判不可下钻。
//
// 隐私（AGENTS.md §5/§6）：真实项目只贴路径、结构与计数，不贴内容；本脚本零写盘（不注册项目、
// 不动真实 `.工作台`，临时夹具落在 os.tmpdir 并在结束时删掉）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ARCH_LIMITS, MORE_NODE_ID } from "../src/arch/config";
import { expandDirectory } from "../src/arch/expand";
import { buildMindTree } from "../src/arch/mindmap";
import { buildSharedGraph } from "../src/arch/render";
import {
  buildSharedGraphFrom,
  canDrillSharedNode,
  capChildren,
  mergePlanningLayer,
  selectGraph,
  type GraphNode,
  type SharedGraph,
} from "../src/arch/shared-graph";
import { skip, skips } from "./lib/fixtures";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODES = ["MODULE_BOX", "DATA_FLOW", "MIND_MAP"] as const;
const read = (rel: string): string => fs.readFileSync(path.join(REPO_ROOT, ...rel.split("/")), "utf8");
const rel = (p: string): string => path.relative(REPO_ROOT, p).split(path.sep).join("/");

let failCount = 0;
const ok = (cond: boolean, label: string): void => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (!cond) {
    failCount += 1;
    process.exitCode = 1;
  }
};

// ── 夹具：结构化模块骨架（不经注册表、不落盘） ───────────────────────────────────────
interface Mod {
  id: string;
  path: string;
  file_count: number;
  deps: { to: string; weight: number }[];
}
const mod = (id: string, p: string, files: number, deps: [string, number][] = []): Mod => ({
  id,
  path: p,
  file_count: files,
  deps: deps.map(([to, weight]) => ({ to, weight })),
});
const sameIds = (a: readonly { id: string }[], b: readonly { id: string }[]): boolean =>
  a.length === b.length && a.every((x, i) => x.id === b[i].id);

// ════════════════ ① 代码扫描输入：节点集合唯一来源 + 零截断 ════════════════
console.log("[verify] ── ① 共用层节点集合唯一来源（三模式逐 id 全等、零截断）");
{
  const modules = [
    mod("src", "src", 40, [["scripts", 3]]),
    mod("scripts", "scripts", 12, [["src", 1]]),
    mod("docs", "docs", 8),
    mod("root", ".", 5, [["src", 2]]),
  ];
  const shared = buildSharedGraphFrom(modules, { src: { name: "前端", blurb: "", kind: "code" } }, new Map(), {}, false);
  ok(shared.edges.length === 3, `边聚合按 (from,to) 唯一：${shared.edges.length} 条（src→scripts/scripts→src/root→src）`);
  ok(
    shared.edges.some((e) => e.from === "root" && e.to === "src") && !shared.edges.some((e) => e.from === "src" && e.to === "root"),
    "依赖边方向 = 依赖方 → 被依赖方（root→src 存在、src→root 不存在）",
  );
  for (const m of MODES) {
    const sel = selectGraph(m, shared);
    ok(
      sameIds(sel.nodes, shared.nodes) && sel.nodes.length === shared.nodes.length,
      `① ${m} 选择器零截断：节点 ${sel.nodes.length} 个与共用层逐 id 全等（含聚合节点 ${MORE_NODE_ID}）`,
    );
  }
  const mb = selectGraph("MODULE_BOX", shared);
  ok(mb.edges.length === shared.edges.length, `① MODULE_BOX 画全量边：${mb.edges.length} = 共用层 ${shared.edges.length}`);
  const flow = selectGraph("DATA_FLOW", shared);
  ok(
    flow.edges.length === 2 && flow.stats.merged_mutual_pairs === 1,
    `① DATA_FLOW 只做方向/着色子集、不新增边：3 → ${flow.edges.length}（互惠对 src↔scripts 归并 ${flow.stats.merged_mutual_pairs} 对）`,
  );

}

// ════════════════ ② 防爆炸口径：硬上限 + 截断实现唯一出处 ════════════════
console.log("[verify] ── ② 防爆炸（硬上限 / 子级截断 / 截断实现全仓唯一）");
{
  const big = Array.from({ length: 50 }, (_, i) => mod(`m${String(i).padStart(2, "0")}`, `m${i}`, 100 - i));
  const shared = buildSharedGraphFrom(big, {}, new Map(), {}, false);
  ok(shared.nodes.length === ARCH_LIMITS.MAX_NODES, `节点硬上限：50 → ${shared.nodes.length}（${ARCH_LIMITS.MAX_NODES - 1} 保留 + 1 聚合）`);
  ok(shared.truncated.nodes === 50 - (ARCH_LIMITS.MAX_NODES - 1), `截断计数 ${shared.truncated.nodes} = 50 − (MAX_NODES−1)`);
  ok(shared.nodes.some((n) => n.id === MORE_NODE_ID && n.aggregate === true), "超限部分合并为单一聚合节点（不可下钻）");

  const kids = Array.from({ length: 9 }, (_, i) => ({ name: `c${i}` }));
  const capped = capChildren(kids, "parent", 4);
  ok(capped.kept.length === 3 && capped.dropped === 6 && capped.aggregate !== null, "capChildren(9, limit 4) → 保留 3 + 聚合 1（dropped 6）");
  ok(capped.aggregate!.id === `${MORE_NODE_ID}:parent`, `聚合节点 id 带父级后缀（${capped.aggregate!.id}）避免多枝展开时节点键相撞`);
  const noCap = capChildren(kids.slice(0, 3), "parent", 4);
  ok(noCap.kept.length === 3 && noCap.dropped === 0 && noCap.aggregate === null && noCap.truncated === false, "未超上限：原序全保留、不产生聚合节点");

  // 源码级红线：A4 只调用共用层的截断实现，自己不引上限数值标识（§4.3 第 1 招「实现全仓唯一」）
  const expandSrc = read("src/arch/expand.ts");
  ok(
    !/ARCH_LIMITS|MORE_NODE_ID/.test(expandSrc) && /capChildren[<(]/.test(expandSrc) && /defaultChildLimit\(\)/.test(expandSrc),
    "② A4（expand.ts）只调用 capChildren/defaultChildLimit，不引 ARCH_LIMITS/MORE_NODE_ID",
  );
  const sharedSrc = read("src/arch/shared-graph.ts");
  ok(
    sharedSrc.includes("export function capChildren") && sharedSrc.includes("export function defaultChildLimit"),
    "② 单枝上限的数值出口与实现都落在共用数据层（config.ts 出数值、shared-graph.ts 出实现/出口）",
  );
}

// ════════════════ ③ 目录根 / 孤立节点：三模式都在场 ════════════════
console.log("[verify] ── ③ 目录根（path=\".\"）与孤立节点在所有模式都在场");
{
  const modules = [
    mod("src", "src", 10),
    mod("lonely-a", "lonely-a", 5),
    mod("lonely-b", "lonely-b", 4),
    mod("root", ".", 3),
  ];
  const shared = buildSharedGraphFrom(modules, {}, new Map(), {}, false);
  for (const m of MODES) {
    const sel = selectGraph(m, shared);
    ok(
      ["src", "lonely-a", "lonely-b", "root"].every((id) => sel.nodes.some((n) => n.id === id)),
      `③ ${m} 保留孤立节点与根散文件模块（节点集合不过滤：${sel.nodes.length} 个）`,
    );
  }
  const flow = selectGraph("DATA_FLOW", shared);
  const roles = new Map(flow.nodes.map((n) => [n.id, (n as { flow_role?: string }).flow_role]));
  ok(roles.get("lonely-a") === "isolated" && roles.get("lonely-b") === "isolated", "③ 零度节点流向角色 = isolated（如实标，不并进别处）");
  ok(shared.nodes.find((n) => n.id === "root")!.path === ".", "③ 根散文件模块 path 保持 \".\"（不兜底成空串/不吞掉）");
}

// ════════════════ ④ 规划分层：并入节点无路径、不可下钻；规划边不冒充静态 import ════════════════
console.log("[verify] ── ④ 规划层并入（无路径规划节点不可下钻；规划边保真 origin/plan_kind）");
{
  const base = buildSharedGraphFrom([mod("src", "src", 10, [["scripts", 2]]), mod("scripts", "scripts", 6)], {}, new Map(), {}, false);
  const merged = mergePlanningLayer(base, {
    baseline_id: "bl-x",
    nodes: [
      { id: "plan:code:src", name: "前端界面层", kind: "module", code_module_ids: ["src"] },
      { id: "plan:cap:01", name: "能力一", kind: "capability", code_module_ids: [] },
    ],
    edges: [
      { source: "plan:code:src", target: "plan:cap:01", kind: "design_interface", certainty: "declared" },
      { source: "plan:cap:01", target: "plan:code:src", kind: "implementation_map", certainty: "observed" },
      { source: "plan:cap:01", target: "plan:ghost:missing", kind: "task_design_ref", certainty: "declared" },
    ],
  });
  const planNode = merged.nodes.find((n) => n.id === "plan:cap:01");
  ok(planNode !== undefined && planNode.plan_origin === "plan" && planNode.path === "", "④ 无实测落点的规划节点：灰节点（plan_origin）且 path 为空");
  ok(canDrillSharedNode(planNode!) === false, "④ 规划节点判定为不可下钻（canDrillSharedNode=false）——不画死控件");
  ok(canDrillSharedNode(merged.nodes.find((n) => n.id === "src")!) === true, "④ 命中实测模块的静态节点仍可下钻（path 非空）");
  ok(
    !merged.nodes.some((n) => n.id === "plan:code:src"),
    "④ 规划节点命中实测模块时不新建第二份节点（实测映射用稳定关系连接）",
  );
  ok(merged.nodes.find((n) => n.id === "src")!.plan_refs?.includes("plan:code:src") === true, "④ 静态节点挂上引用它的规划 id（plan_refs）");
  const planEdges = merged.edges.filter((e) => e.origin === "plan");
  ok(planEdges.length === 2 && planEdges.every((e) => e.plan_kind !== undefined), `④ 规划边 ${planEdges.length} 条（悬空端点 plan:ghost:missing 被丢弃）且带 plan_kind`);
  ok(
    planEdges.some((e) => e.plan_kind === "design_interface" && e.plan_certainty === "declared"),
    "④ 规划边原关系类型/确定性保真（不一律标成 static_import/observed）",
  );
  ok(merged.edges.every((e) => merged.nodes.some((n) => n.id === e.from) && merged.nodes.some((n) => n.id === e.to)), "④ 无悬空边（端点都存在）");
}

// ════════════════ ⑤ 深层展开（A4）：隔离临时夹具真跑 ════════════════
console.log("[verify] ── ⑤ A4 深层展开（隔离临时夹具，真扫目录/真解析 import）");
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tt-verify-tech-"));
try {
  fs.mkdirSync(path.join(tmpRoot, "mod", "sub"), { recursive: true });
  fs.mkdirSync(path.join(tmpRoot, "mod", "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(tmpRoot, "mod", "a.ts"), 'import { b } from "./sub/b";\nexport const a = b + 1;\n', "utf8");
  fs.writeFileSync(path.join(tmpRoot, "mod", "sub", "b.ts"), 'export const b = 1;\n', "utf8");
  fs.writeFileSync(path.join(tmpRoot, "mod", "sub", "c.ts"), 'import { b } from "./b";\nexport const c = b;\n', "utf8");
  fs.writeFileSync(path.join(tmpRoot, "mod", "readme.md"), "# 非源码\n", "utf8");
  fs.writeFileSync(path.join(tmpRoot, "mod", "node_modules", "ignored.ts"), "export const x = 1;\n", "utf8");

  const top = expandDirectory(tmpRoot, "mod");
  const ids = top.children.map((c) => c.id);
  ok(new Set(ids).size === ids.length, `⑤ 子级 id 唯一（${ids.length} 个：${ids.join(", ")}）`);
  ok(
    top.children.every((c) => c.path === "mod" || c.path.startsWith("mod/")),
    "⑤ 每个子级路径都落在被展开子树内（懒加载边界不越界）",
  );
  ok(
    !top.children.some((c) => c.path.includes("node_modules")),
    "⑤ 忽略目录（node_modules）不进子级（与 A1 同一忽略口径）",
  );
  const fileNodes = top.children.filter((c) => c.kind === "file");
  ok(fileNodes.every((c) => c.leaf === true && c.file_count === 1), "⑤ 文件节点是叶子（file_count=1、leaf=true）");
  ok(fileNodes.some((c) => c.name === "readme.md") && fileNodes.some((c) => c.name === "a.ts"), "⑤ 非源码文件也作为文件节点在场（不下钻、不解析）");
  const dirNode = top.children.find((c) => c.kind === "dir" && c.name === "sub")!;
  ok(dirNode.file_count === 2, `⑤ 子目录 file_count = 子树文件数（sub: ${dirNode.file_count}）`);
  const childIds = new Set(top.children.map((c) => c.id));
  ok(
    top.children.every((c) => c.deps.every((d) => childIds.has(d.to))),
    "⑤ 子级间依赖边端点闭合（目标必在本层子级里，不产生悬空边）",
  );
  ok(top.children.find((c) => c.name === "a.ts")!.deps.some((d) => d.to === dirNode.id), "⑤ import 聚合到子目录节点（a.ts → sub）");

  const sub = expandDirectory(tmpRoot, "mod/sub");
  ok(sub.children.every((c) => c.leaf === true && (c.kind === "file")), "⑤ 再下一层（mod/sub）：全是文件叶子，逐级下钻到文件级为止");
  ok(sub.children.reduce((n, c) => n + c.deps.length, 0) === 1, "⑤ 再下一层的依赖边（c.ts → b.ts）在本层闭合");

  // 巨枝截断：60 个文件 → 40 上限（39 保留 + 1 聚合），聚合节点是不可下钻的叶子
  fs.mkdirSync(path.join(tmpRoot, "wide"), { recursive: true });
  for (let i = 0; i < 60; i++) fs.writeFileSync(path.join(tmpRoot, "wide", `f${String(i).padStart(2, "0")}.txt`), "x", "utf8");
  const wide = expandDirectory(tmpRoot, "wide");
  const agg = wide.children.find((c) => c.kind === "aggregate");
  ok(wide.children.length === ARCH_LIMITS.MAX_CHILDREN && agg !== undefined, `⑤ 巨枝：60 个直接子级 → 40（${ARCH_LIMITS.MAX_CHILDREN - 1} 保留 + 1 聚合）`);
  ok(wide.truncated.children === 21, `⑤ 截断量如实回带（truncated.children=${wide.truncated.children}）`);
  ok(agg!.leaf === true && agg!.path === "" && agg!.file_count === 0, "⑤ 聚合节点是叶子、无路径、无文件数（被截断的枝不遍历）");

  // ⑤b 隐藏内容可达：被截断掉的子级经**稳定分页**逐项取回（无重无漏、指纹稳定、全是真实子级）
  const first = expandDirectory(tmpRoot, "wide", { childrenOffset: 0, childrenLimit: 25, childrenSource: true });
  ok(first.children_total === 60 && first.children_returned === 25 && first.children_has_more === true, `⑤b 分页第一页：total=${first.children_total} returned=${first.children_returned} has_more=${first.children_has_more}`);
  ok(!first.children.some((c) => c.kind === "aggregate"), "⑤b 分页窗口全是真实子级（不为「还有 N 个」保留名额、不带 __more__）");
  const all: string[] = [];
  let off = 0;
  for (let page = 0; page < 10; page += 1) {
    const pg = expandDirectory(tmpRoot, "wide", { childrenOffset: off, childrenLimit: 25 });
    all.push(...pg.children.map((c) => c.id));
    if (pg.children_has_more !== true) break;
    off += pg.children_returned ?? pg.children.length;
  }
  ok(all.length === 60 && new Set(all).size === 60, `⑤b 截断掉的子级经稳定分页可逐项取回（${all.length}/60、无重无漏）`);
  const again = expandDirectory(tmpRoot, "wide", { childrenOffset: 0, childrenLimit: 25, childrenSource: true });
  ok(again.children_fingerprint === first.children_fingerprint, "⑤b 分页来源指纹稳定（同一窗内成员集合未变时为同值）");
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

// ════════════════ ⑥ 思维导图层级契约 ════════════════
console.log("[verify] ── ⑥ 思维导图：节点/层数自洽 + 层级边只来自路径包含 + 按需下钻");
{
  const modules = [
    mod("app", "app", 30),
    mod("app-ui", "app/ui", 12),
    mod("app-ui-arch", "app/ui/arch", 5),
    mod("other", "other", 3), // 与 app 无路径包含关系：不该被凭空挂上去
    mod("root", ".", 2),
  ];
  const shared = buildSharedGraphFrom(modules, {}, new Map(), {}, false);
  const sel = selectGraph("MIND_MAP", shared);
  const edgePairs = new Set(sel.edges.map((e) => `${e.from}>${e.to}`));
  ok(edgePairs.has("app>app-ui") && edgePairs.has("app-ui>app-ui-arch"), "⑥ 层级边由路径包含推出（app→app/ui→app/ui/arch）");
  ok(!edgePairs.has("app>other") && !sel.edges.some((e) => e.from === "other" || e.to === "other"), "⑥ 无包含关系的模块不造层级边（other 不在层级边里）");
  ok(sel.edges.every((e) => e.weight === 1 && e.color_role === null), "⑥ 层级边不表达依赖强度（weight 恒 1、不着依赖色）");

  const closed = buildMindTree(shared, { id: "p", name: "项目" }, new Map());
  ok(closed.nodeCount === shared.nodes.length + 1 && closed.depth === 4, `⑥ 未展开树：${closed.nodeCount} 节点（项目根 + ${shared.nodes.length}）、${closed.depth} 层（根→app→app/ui→app/ui/arch）`);
  ok(closed.expandedBranches === 0, "⑥ 未展开时零下钻（expandedBranches=0）——不把未展开树冒充全仓覆盖");
  const seen = new Set<string>();
  const walk = (n: { id: string; children: { id: string }[] }): void => {
    seen.add(n.id);
    for (const c of n.children) walk(c as { id: string; children: { id: string }[] });
  };
  walk(closed.root as unknown as { id: string; children: { id: string }[] });
  ok(seen.size === closed.nodeCount, `⑥ 树里每个 id 恰好出现一次（${seen.size} = nodeCount）`);
  ok(
    shared.nodes.every((n) => seen.has(n.id)),
    "⑥ 共用层每个节点都在树里（没有节点被悄悄丢掉）",
  );

  // 展开一枝：只在被点开的枝加载子级（§4.3 第 2 招）
  const kids = new Map([
    ["app-ui", [{ id: "app-ui-new-ts", name: "new.ts", path: "app/ui/new.ts", file_count: 1, loc: 0, leaf: true, kind: "file" as const, deps: [] }]],
  ]);
  const one = buildMindTree(shared, { id: "p", name: "项目" }, kids);
  ok(
    one.expandedBranches === 1 && one.nodeCount === closed.nodeCount + 1 && one.depth === closed.depth,
    `⑥ 只展开一枝：仅多出该枝的子级（${closed.nodeCount} → ${one.nodeCount}），层数不凭空增加`,
  );
}

// ════════════════ ⑦ 下钻控件口径接线（方框图 ↔ 导图一致） ════════════════
console.log("[verify] ── ⑦ 下钻控件口径唯一（无真实路径的节点两图一致判不可下钻）");
{
  const canvasSrc = read("src/ui/arch/ArchCanvas.tsx");
  ok(
    /expandable:\s*canDrillSharedNode\(n\)/.test(canvasSrc),
    "⑦ 方框图（ArchCanvas）用共用层 canDrillSharedNode 判可下钻（不再只按 aggregate/chat 判）",
  );
  ok(
    !/expandable:\s*!n\.aggregate/.test(canvasSrc),
    "⑦ 已移除会给出「死下钻控件」的旧判据（无路径规划节点不再画 + 钮）",
  );
  const mindSrc = read("src/arch/mindmap.ts");
  ok(/isDrillable/.test(mindSrc) && /n\.path !== ""/.test(mindSrc), "⑦ 导图取数口对共用层节点同样按「path 非空」判可下钻（两图同口径）");

  // ⑦b 隐藏内容可达：两图的「显示全部 / 加载全部子级 / 查看被聚合对象」入口都在（受控、不静默）
  const mindViewSrc = read("src/ui/arch/MindMapView.tsx");
  ok(
    /data-mindmap-show-all/.test(mindViewSrc) && /data-mindmap-show-overview/.test(mindViewSrc) && /data-mindmap-load-all/.test(mindViewSrc),
    "⑦b 导图：顶层聚合有「显示全部/返回概览」，巨枝截断有「加载全部子级」（隐藏内容可达、不冒充全量）",
  );
  ok(
    /data-arch-show-all/.test(canvasSrc) && /data-arch-show-overview/.test(canvasSrc) && /data-arch-hidden-items/.test(canvasSrc),
    "⑦b 方框图：顶层有「显示全部/返回概览」，被聚合/扇出过滤对象有「查看被聚合对象」入口（隐藏内容可逐项取回）",
  );
  ok(
    /MAX_EXPAND_PAGES/.test(canvasSrc) && /MAX_EXPAND_PAGES/.test(mindViewSrc) && /console\.warn/.test(canvasSrc),
    "⑦b 分页续取有安全上限并如实告警（到顶不静默丢页、不冒充全量）",
  );
}

// ════════════════ ⑧ 真实项目只读冒烟（塔台自身，只贴结构/计数） ════════════════
console.log("[verify] ── ⑧ 真实项目只读冒烟（buildSharedGraph + selectGraph + buildMindTree）");
{
  let shared: SharedGraph | null = null;
  try {
    const r = buildSharedGraph("tatai");
    shared = r.exists && r.graph ? r.graph : null;
  } catch {
    shared = null;
  }
  if (shared === null) {
    skip("⑧ 真实项目冒烟（tatai 未登记/未解析）", "设 TATAI_HOME 指向已登记 tatai 的数据目录后重跑");
  } else {
    const ids = shared.nodes.map((n) => n.id);
    ok(new Set(ids).size === ids.length, `⑧ 真实项目：${shared.nodes.length} 个顶层模块（id 唯一），${shared.edges.length} 条依赖边，budget_exhausted=${String(shared.budget_exhausted)}`);
    const mb = selectGraph("MODULE_BOX", shared);
    ok(sameIds(mb.nodes, shared.nodes), "⑧ 真实项目 MODULE_BOX 节点集合与共用层逐 id 全等（零截断/零过滤）");
    const deg = new Map<string, number>();
    for (const e of mb.edges) {
      deg.set(e.from, (deg.get(e.from) ?? 0) + 1);
      deg.set(e.to, (deg.get(e.to) ?? 0) + 1);
    }
    const isolated = shared.nodes.filter((n) => !deg.has(n.id) && !n.aggregate).map((n) => n.id);
    console.log(`[verify]    孤立模块 ${isolated.length} 个：${isolated.join(", ") || "（无）"}（无跨模块 import，如实保留）`);
    ok(
      shared.nodes.every((n) => !n.aggregate || !canDrillSharedNode(n)),
      "⑧ 真实项目：聚合节点一律判不可下钻",
    );
    const drillable = shared.nodes.filter((n) => canDrillSharedNode(n));
    ok(drillable.length === shared.nodes.filter((n) => !n.aggregate && n.origin !== "chat").length, `⑧ 真实项目可下钻模块 ${drillable.length} 个（静态模块都带真实路径，path=\".\" 的根散文件模块也算）`);
    const tree = buildMindTree(shared, { id: "tatai", name: "tatai" }, new Map());
    ok(tree.nodeCount === shared.nodes.length + 1 && tree.depth === 2, `⑧ 真实项目未展开导图：${tree.nodeCount} 节点、${tree.depth} 层（项目根 + 顶层模块）`);
    const mindEdges = selectGraph("MIND_MAP", shared).edges;
    console.log(`[verify]    真实项目 MIND_MAP 层级边 ${mindEdges.length} 条（顶层模块间无目录包含关系时为 0，更深层级按需懒加载）`);
    ok(mindEdges.every((e) => shared.nodes.some((n) => n.id === e.from) && shared.nodes.some((n) => n.id === e.to)), "⑧ 真实项目层级边端点都在节点集合内");
    // 只读冒烟：逐模块真跑一次 A4，确认「按需下钻」可达（不改任何真实数据）
    let reachable = 0;
    let unreachable: string[] = [];
    for (const n of shared.nodes) {
      if (!canDrillSharedNode(n) || n.path === "") continue;
      try {
        const res = expandDirectory(REPO_ROOT, n.path);
        reachable += 1;
        if (res.children.length === 0) unreachable.push(n.id);
      } catch (e) {
        unreachable.push(`${n.id}(${(e as Error).message})`);
      }
    }
    ok(unreachable.length === 0, `⑧ 真实项目每个可下钻模块都能就地展开（${reachable} 个成功${unreachable.length ? "，失败：" + unreachable.join("; ") : ""}）`);
  }
}

console.log(`[verify] 断言 FAIL ${failCount} 条，SKIP ${skips()} 段`);
if (process.exitCode && process.exitCode !== 0) {
  console.log("[verify] 结果: FAIL（上面有 FAIL 行）");
} else if (skips() > 0) {
  console.log("[verify] 结果: 没跑全（有 SKIP 段）——退出码 3");
  process.exitCode = 3;
} else {
  console.log("[verify] 结果: 全部 PASS");
}
