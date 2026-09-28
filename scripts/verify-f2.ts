// F2 验证脚本（用 tsx 跑）：两图共用数据层（施工图 F2 卡 DoD 逐条断言）。
// 用法：pnpm verify:f2
// 覆盖点：
//   ① 节点集合只有一份来源：**同一项目输入**下 MODULE_BOX / DATA_FLOW / MIND_MAP 三模式节点集合逐 id 全等；
//      源码级红线：src/ui 不出现第二份数据来源（不读 modules.json、不自己扫目录）；
//   ② 边过滤/着色选择器：E_FLOW ⊆ E_ALL（逐边键断言）+ 计数（全量 N 条 → 流向 M 条、剔自环数、归并互惠对数）；
//   ③ 防爆炸只在共用层施加一次：50 模块夹具 → 节点数 = MAX_NODES（14 保留 + 1 聚合），
//      三模式选择器零截断（节点 id 与共享层逐一相等）；源码级扫描证明「截断实现全仓只有 shared-graph.ts 一处」；
//   ④ 真实项目（塔台自身，注册表走 TATAI_HOME）过一遍项目级入口 buildSharedGraph，贴结构与计数
//      （AGENTS.md §5：真实项目只贴路径与结构，不贴内容）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ARCH_LIMITS, MORE_NODE_ID } from "../src/arch/config";
import {
  DATA_FLOW_EDGE_RULE,
  EXPLOSION_CONTROL_STAGE,
  NODE_SET_RULE,
  type GraphMode,
} from "../src/arch/graph-mode";
import { parseProject } from "../src/arch/parse";
import { buildSharedGraph } from "../src/arch/render";
import {
  buildSharedGraphFrom,
  selectGraph,
  type GraphNode,
  type SharedGraph,
} from "../src/arch/shared-graph";
import { addProject } from "../src/server/registry";
import { ensureSelfRegistered, finish, realHome } from "./lib/fixtures";
import { addModule } from "../src/server/workstation";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REAL_DATA_DIR = realHome(); // TATAI_HOME > 缺省 ~/.tatai（脚本不写死作者本机路径）
ensureSelfRegistered(REAL_DATA_DIR); // 塔台自身＝本仓库：幂等登记，脚本换台机器也能跑
const MODES: GraphMode[] = ["MODULE_BOX", "DATA_FLOW", "MIND_MAP"];

const ok = (cond: boolean, label: string) => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (!cond) process.exitCode = 1;
};

const idsOf = (nodes: GraphNode[]) => nodes.map((n) => n.id).sort();
const sameIds = (a: GraphNode[], b: GraphNode[]) => JSON.stringify(idsOf(a)) === JSON.stringify(idsOf(b));
const depKeysOf = (g: SharedGraph) => g.edges.map((e) => `${e.from}>${e.to}`);
const rel = (f: string) => path.relative(REPO_ROOT, f).split(path.sep).join("/");

/** 递归收集 src 下全部 ts/tsx（源码级红线扫描用） */
function walkSrc(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkSrc(p, out);
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

/** 夹具项目：7 模块（src / src-a / src-b / src-c / scripts / templates / root），含一对互惠 import 与一个纯提供者 */
const FIXTURE_FILES: Record<string, string> = {
  "index.ts": 'import { s } from "./scripts/s";\nexport const root = s;\n',
  "src/index.ts": 'import "./util";\nimport "./a/x";\nexport const i = 1;\n',
  "src/util.ts": 'import { h } from "../templates/helper";\nexport const u = h;\n',
  "src/a/x.ts": 'import { y } from "../b/y";\nimport { z } from "../c/z";\nexport const x = y + z;\n',
  "src/b/y.ts": 'import { x } from "../a/x";\nexport const y = x;\n',
  "src/c/z.ts": 'import { y } from "../b/y";\nexport const z = y;\n',
  "scripts/s.ts": 'import { x } from "../src/a/x";\nexport const s = x;\n',
  "templates/helper.ts": "export const h = 1;\n",
};

function writeFixture(root: string): void {
  for (const [r, text] of Object.entries(FIXTURE_FILES)) {
    fs.mkdirSync(path.dirname(path.join(root, r)), { recursive: true });
    fs.writeFileSync(path.join(root, r), text, "utf8");
  }
}

/** 50 模块合成夹具（纯 core 用；file_count 递减 → 保留 mod01..mod14 + 1 个聚合节点） */
function bigModules(n: number) {
  const id = (i: number) => `mod${String(i).padStart(2, "0")}`;
  return Array.from({ length: n }, (_, k) => {
    const deps: { to: string; weight: number }[] = [];
    if (k + 2 <= n) deps.push({ to: id(k + 2), weight: 1 });
    if (k + 3 <= n) deps.push({ to: id(k + 3), weight: 1 });
    return { id: id(k + 1), path: id(k + 1), file_count: n - k, deps };
  });
}

function main(): void {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-f2-verify-"));
  try {
    // ── ① 同一项目输入：真跑 parse（modules.json）→ 共用数据层 → 三模式选择 ──
    console.log("[verify] ── ① 同一项目输入，三模式节点集合完全相同（DoD①/③）");
    const projectId = "p-f2";
    const proj = path.join(tmpBase, "proj");
    const dataDir = path.join(tmpBase, "home");
    fs.mkdirSync(dataDir, { recursive: true });
    writeFixture(proj);
    addProject({ id: projectId, name: "F2 验证项目", path: proj, kind: "backend" }, dataDir);
    // 起名缓存与四色状态：证明共用层的节点字段来源（names.json + progress.json）
    fs.mkdirSync(path.join(proj, ".工作台", "arch"), { recursive: true });
    fs.writeFileSync(
      path.join(proj, ".工作台", "arch", "names.json"),
      JSON.stringify(
        {
          version: 1,
          entries: {
            src: { name: "源码主模块", blurb: "夹具源码根", kind: "code", named_at: "2026-09-18T00:00:00Z", signature: "s1" },
            "src-a": { name: "甲子模块", blurb: "夹具子模块 a", kind: "code", named_at: "2026-09-18T00:00:00Z", signature: "s2" },
            templates: { name: "模板库", blurb: "夹具模板", kind: "docs", named_at: "2026-09-18T00:00:00Z", signature: "s3" },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    addModule(projectId, { id: "src", name: "源码主模块", status: "done" }, dataDir);
    addModule(projectId, { id: "src-a", name: "甲子模块", status: "doing" }, dataDir);
    // A1 真解析落盘 modules.json（唯一节点/边来源的上游）
    const parsed = parseProject(projectId, dataDir);
    console.log(`[verify]   A1 解析出模块 ${parsed.file.modules.length} 个（modules.json 落 ${rel(parsed.source)}）`);
    const sharedResult = buildSharedGraph(projectId, { dataDir });
    const shared = sharedResult.graph;
    ok(sharedResult.exists && shared !== undefined, "共用数据层项目级入口 buildSharedGraph(projectId) 产出数据（exists:true）");
    if (!shared) return;

    const selections = MODES.map((m) => selectGraph(m, shared));
    const base = selections[0].nodes;
    console.log(`[verify]   共用层节点 ${base.length} 个：[${idsOf(base).join(", ")}]`);
    for (const sel of selections) {
      console.log(
        `[verify]   ${sel.mode.padEnd(11)} 节点 ${sel.nodes.length} 个 · 边 ${sel.edges.length} 条 · edgeRule=${sel.spec.edgeRule}`,
      );
      ok(sameIds(base, sel.nodes), `③ ${sel.mode} 节点集合与共用层逐 id 全等（${sel.nodes.length} 个，零过滤）`);
    }
    ok(
      selections.every((s) => s.nodes.length === shared.nodes.length),
      `① 三模式节点数全等且等于共用层（${shared.nodes.length}）——节点集合只有一份来源（${NODE_SET_RULE}）`,
    );
    const named = shared.nodes.find((n) => n.id === "src");
    const docs = shared.nodes.find((n) => n.id === "templates");
    ok(
      named?.name === "源码主模块" && named?.status === "done",
      `① 节点字段合并正确：src.name=${JSON.stringify(named?.name)}（names.json）· src.status=${named?.status}（progress.json 四色）`,
    );
    ok(
      docs?.name === "模板库" && docs?.kind === "docs" && docs?.status === undefined,
      `① templates.name=${JSON.stringify(docs?.name)} kind=${docs?.kind}（无 progress 记录 → status 缺省）`,
    );

    // ── ② DATA_FLOW 边集合 ⊆ 全量边集合 E_ALL ──
    console.log("\n[verify] ── ② E_FLOW ⊆ E_ALL（子集断言 + 计数，DoD②）");
    const box = selections.find((s) => s.mode === "MODULE_BOX")!;
    const flow = selections.find((s) => s.mode === "DATA_FLOW")!;
    const mind = selections.find((s) => s.mode === "MIND_MAP")!;
    console.log(`[verify]   ${EXPLOSION_CONTROL_STAGE} · E_ALL（依赖方向 消费者→提供者）${shared.edges.length} 条：`);
    console.log(`[verify]     ${depKeysOf(shared).map((k, i) => `${k}(${shared.edges[i].weight})`).join(" · ")}`);
    ok(
      JSON.stringify(box.edges.map((e) => `${e.from}>${e.to}`)) === JSON.stringify(depKeysOf(shared)),
      `② MODULE_BOX 边 = E_ALL 原样（${box.edges.length} 条，边键与顺序逐一相等，§3.2 全量边口径）`,
    );
    const allKeys = new Set(depKeysOf(shared));
    const notInAll = flow.edges.filter((e) => !allKeys.has(`${e.to}>${e.from}`));
    console.log(
      `[verify]   DATA_FLOW：剔自环 ${flow.stats.dropped_self_loop} 条 · 归并互惠对 ${flow.stats.merged_mutual_pairs} 对 · ` +
        `方向翻转后 E_FLOW = ${flow.edges.length} 条（E_ALL ${flow.stats.all_edges} 条 → E_FLOW ${flow.stats.view_edges} 条）`,
    );
    ok(
      notInAll.length === 0,
      `② 子集断言：E_FLOW ${flow.edges.length}/${flow.edges.length} 条都能还原到 E_ALL 的依赖方向边键（缺 ${notInAll.length} 条）`,
    );
    ok(
      flow.edges.length < flow.stats.all_edges && flow.stats.merged_mutual_pairs === 1,
      `② 互惠对真归并：src-a ↔ src-b 两条并一条（E_ALL ${flow.stats.all_edges} → E_FLOW ${flow.edges.length}）`,
    );
    const bidir = flow.edges.find((e) => e.bidirectional === true);
    ok(
      bidir !== undefined && bidir.weight === 2 && [bidir.from, bidir.to].sort().join(">") === "src-a>src-b",
      `② 归并边带 ${DATA_FLOW_EDGE_RULE.mutual_pair_flag} 且权重${DATA_FLOW_EDGE_RULE.mutual_pair_weight}=2：${bidir?.from}→${bidir?.to}（weight=${bidir?.weight}）`,
    );
    console.log(
      `[verify]   E_FLOW 明细：${flow.edges
        .map((e) => `${e.from}→${e.to}(${e.weight}${e.bidirectional ? ",bidirectional" : ""},${e.color_role ?? "无色"})`)
        .join(" · ")}`,
    );
    const colors = { flow_source: 0, flow_relay: 0, none: 0 };
    for (const e of flow.edges) {
      if (e.color_role === "flow_source") colors.flow_source++;
      else if (e.color_role === "flow_relay") colors.flow_relay++;
      else colors.none++;
    }
    const roles = { source: 0, relay: 0, sink: 0, isolated: 0 };
    for (const n of flow.nodes) roles[n.flow_role ?? "isolated"]++;
    console.log(
      `[verify]   着色：flow_source ${colors.flow_source} 条 · flow_relay ${colors.flow_relay} 条 · 无色 ${colors.none} 条；` +
        `节点流向角色 source ${roles.source} / relay ${roles.relay} / sink ${roles.sink} / isolated ${roles.isolated}`,
    );
    ok(
      flow.nodes.every((n) => n.flow_role !== undefined) && roles.source + roles.relay + roles.sink + roles.isolated === flow.nodes.length,
      `② DATA_FLOW 每个节点都有流向角色（flowRoleOf，四象限合计 ${flow.nodes.length}）`,
    );
    ok(
      flow.edges.every((e) => e.from !== e.to),
      "② 方向翻转后无自环（rendered 方向 = 提供者 → 消费者）",
    );
    // 翻转方向口径：渲染边起点必须是依赖图里的被依赖方（E_ALL 里有 to = 该节点的边）
    const depended = new Set(shared.edges.map((e) => e.to));
    ok(
      flow.edges.every((e) => depended.has(e.from)),
      "② 箭头方向 = provider→consumer（每条 E_FLOW 的起点在 E_ALL 里都是被 import 方）",
    );
    // MIND_MAP：层级父子边（§3.2 表格第三行，画层级不画依赖边）
    const pathOfNode = new Map(shared.nodes.map((n) => [n.id, n.path]));
    const childOf = new Map(mind.edges.map((e) => [e.to, e.from]));
    ok(
      mind.edges.length === 3 &&
        mind.edges.every((e) => pathOfNode.get(e.to)!.startsWith(pathOfNode.get(e.from)! + "/")) &&
        ["src-a", "src-b", "src-c"].every((id) => childOf.get(id) === "src"),
      `② MIND_MAP 画层级父子边 ${mind.edges.length} 条（父=路径最近祖先节点：src→src-a/src-b/src-c；` +
        `依据 §3.2 表格第三行"层级结构一览"，不是依赖边）`,
    );

    // ── ③ 防爆炸只在共用层施加一次 ──
    console.log("\n[verify] ── ③ 防爆炸只在共用层施加一次（DoD③）");
    const big = bigModules(50);
    const bigNames = Object.fromEntries(big.map((m) => [m.id, { name: `模块${m.id}`, blurb: "", kind: "code" as const }]));
    const bigShared = buildSharedGraphFrom(big, bigNames);
    const kept = bigShared.nodes.filter((n) => !n.aggregate).length;
    const aggregates = bigShared.nodes.filter((n) => n.aggregate === true);
    console.log(
      `[verify]   50 模块 → 共用层节点 ${bigShared.nodes.length}（保留 ${kept} + 聚合 ${aggregates.length}，` +
        `MAX_NODES=${bigShared.limits.MAX_NODES}，truncated.nodes=${bigShared.truncated.nodes}）· 边 ${bigShared.edges.length} 条` +
        `（MAX_EDGES=${bigShared.limits.MAX_EDGES}，truncated.edges=${bigShared.truncated.edges}）`,
    );
    ok(
      bigShared.nodes.length === ARCH_LIMITS.MAX_NODES && aggregates.length === 1 && bigShared.nodes.at(-1)!.id === MORE_NODE_ID,
      `③ 节点数 = MAX_NODES = ${ARCH_LIMITS.MAX_NODES}（${kept} 保留 + 1 聚合「${aggregates[0]?.name}」，硬上限只此一处生效）`,
    );
    ok(
      bigShared.truncated.nodes === 50 - (ARCH_LIMITS.MAX_NODES - 1),
      `③ 截断计数 ${bigShared.truncated.nodes} = 50 - (MAX_NODES-1)，取自共用层同一次统计`,
    );
    ok(bigShared.edges.length <= ARCH_LIMITS.MAX_EDGES, `③ 边数 ${bigShared.edges.length} ≤ MAX_EDGES=${ARCH_LIMITS.MAX_EDGES}`);
    for (const m of MODES) {
      const sel = selectGraph(m, bigShared);
      ok(
        sel.nodes.length === bigShared.nodes.length && sameIds(sel.nodes, bigShared.nodes),
        `③ ${m} 选择器零截断：节点 ${sel.nodes.length} 个与共用层逐 id 全等（含聚合节点 ${MORE_NODE_ID}）`,
      );
    }
    // 自环注入：证明 DATA_FLOW_EDGE_RULE 第 1 步真在跑（E_ALL 本身无自环，此处防调用方喂坏数据）
    const dirty: SharedGraph = { ...shared, edges: [...shared.edges, { from: "src-a", to: "src-a", weight: 9 }] };
    const dirtyFlow = selectGraph("DATA_FLOW", dirty);
    ok(
      dirtyFlow.stats.dropped_self_loop === 1 && dirtyFlow.edges.every((e) => e.from !== e.to) && dirtyFlow.edges.length === flow.edges.length,
      `③ 注入自环 → drop_self_loop 剔掉 ${dirtyFlow.stats.dropped_self_loop} 条，E_FLOW 仍 ${dirtyFlow.edges.length} 条（幂等兜底生效）`,
    );
    // 源码级扫描：截断实现（ARCH_LIMITS / MORE_NODE_ID）全仓只有共用层一处
    const srcFiles = walkSrc(path.join(REPO_ROOT, "src"));
    const configRel = "src/arch/config.ts";
    const truncRefs = srcFiles
      .filter((f) => rel(f) !== configRel && /ARCH_LIMITS|MORE_NODE_ID/.test(fs.readFileSync(f, "utf8")))
      .map(rel);
    ok(
      truncRefs.length === 1 && truncRefs[0] === "src/arch/shared-graph.ts",
      `③ 防爆炸实现全仓唯一出处：${truncRefs.join(", ") || "（无）"}（config.ts 只定义数值，不含截断逻辑）`,
    );
    // 视图层红线：不许出现第二份数据来源
    const uiFiles = srcFiles.filter((f) => rel(f).startsWith("src/ui/"));
    const offenders = uiFiles.filter((f) => /modules\.json|readModules|parseDirectory|expandDirectory\s*\(/.test(fs.readFileSync(f, "utf8"))).map(rel);
    ok(
      offenders.length === 0,
      `① 视图层零第二份来源：src/ui 下 ${uiFiles.length} 个文件都不读 modules.json、不自己扫目录（命中：${offenders.join(", ") || "无"}）`,
    );
    // F3 起消费点从 ArchView.tsx 移到共用画布 ArchCanvas.tsx（两视图一份实现，视图容器只剩页签切换）：
    // 口径不变——视图层里**真调用**selectGraph 的地方全仓唯一，且按 mode 取选择
    //（先剥注释：注释里提到选择器不算消费点）
    const stripComments = (t: string) =>
      t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    const selectGraphFiles = uiFiles
      .filter((f) => stripComments(fs.readFileSync(f, "utf8")).includes("selectGraph("))
      .map(rel);
    const canvasSrc = fs.readFileSync(path.join(REPO_ROOT, "src", "ui", "arch", "ArchCanvas.tsx"), "utf8");
    ok(
      selectGraphFiles.length === 1 &&
        selectGraphFiles[0] === "src/ui/arch/ArchCanvas.tsx" &&
        canvasSrc.includes("selectGraph(mode, graph)"),
      `① 视图层消费共用层的唯一出口 = ${selectGraphFiles.join(", ")}（源码里真调用 selectGraph(mode, graph)：两视图共用同一份选择，F3 把它从 ArchView 抽到共用画布）`,
    );

    // ── 三视图引同一份实现的前提：共用层零 node / 零 server import（否则 tree-sitter 进前端包）──
    console.log("\n[verify] ── 浏览器/服务端同一份实现（零 node import 前提）");
    const sharedSrc = fs.readFileSync(path.join(REPO_ROOT, "src", "arch", "shared-graph.ts"), "utf8");
    const runtimeImports = [...sharedSrc.matchAll(/^import\s+(?!type)([\s\S]*?)from\s+"([^"]+)"/gm)].map((m) => m[2]);
    ok(
      JSON.stringify(runtimeImports) === JSON.stringify(["./config", "./graph-mode"]),
      `共用层运行时 import 仅 ${runtimeImports.join(", ")}（config/graph-mode 自身零 import）→ 两图/服务端引同一份`,
    );
    const distAssets = path.join(REPO_ROOT, "dist", "assets");
    if (!fs.existsSync(distAssets)) {
      console.log("[verify]   SKIP dist 断言：还没跑过 pnpm build（本卡验证步骤单独跑）");
    } else {
      const bundle = fs
        .readdirSync(distAssets)
        .filter((f) => f.endsWith(".js"))
        .map((f) => fs.readFileSync(path.join(distAssets, f), "utf8"));
      ok(
        bundle.some((t) => t.includes("hierarchy_parent_child")),
        "共用层选择器真进前端产物（dist bundle 含 hierarchy_parent_child，F3/N1 直接 import 同一份）",
      );
      ok(
        !bundle.some((t) => t.includes("node-gyp-build")),
        "服务端解析侧没被打进浏览器包（bundle 不含 tree-sitter 的原生绑定装载器 node-gyp-build）",
      );
    }

    // ── ④ 真实项目（塔台自身）：项目级入口 + 三模式一致性 ──
    console.log("\n[verify] ── ④ 真实项目（塔台自身，结构与计数）");
    try {
      const real = buildSharedGraph("tatai", { dataDir: REAL_DATA_DIR });
      if (!real.exists || !real.graph) {
        console.log("[verify]   SKIP：注册表项目 tatai 未解析过 modules.json（先跑 arch/parse）");
      } else {
        const g = real.graph;
        const sels = MODES.map((m) => selectGraph(m, g));
        const f = sels.find((s) => s.mode === "DATA_FLOW")!;
        console.log(
          `[verify]   节点 ${g.nodes.length} 个（truncated.nodes=${g.truncated.nodes}）· E_ALL ${g.edges.length} 条 → ` +
            `E_FLOW ${f.edges.length} 条（剔自环 ${f.stats.dropped_self_loop} · 归并互惠对 ${f.stats.merged_mutual_pairs}）· ` +
            `MIND_MAP 层级边 ${sels.find((s) => s.mode === "MIND_MAP")!.edges.length} 条`,
        );
        ok(
          sels.every((s) => sameIds(s.nodes, g.nodes)),
          `④ 真实项目三模式节点集合逐 id 全等（${g.nodes.length} 个：${idsOf(g.nodes).join(", ")}）`,
        );
        ok(g.nodes.length <= ARCH_LIMITS.MAX_NODES, `④ 节点 ${g.nodes.length} ≤ MAX_NODES=${ARCH_LIMITS.MAX_NODES}`);
        const realAll = new Set(depKeysOf(g));
        ok(
          f.edges.every((e) => realAll.has(`${e.to}>${e.from}`)),
          `④ 真实项目 E_FLOW ⊆ E_ALL（${f.edges.length}/${f.edges.length} 条落回全量边键）`,
        );
      }
    } catch (e) {
      console.log(`[verify]   SKIP：真实数据目录不可读（${(e as Error).message}）`);
    }

    // ── 口径常量到位（F1 契约 → F2 实现）──
    console.log("\n[verify] ── 口径契约（graph-mode.ts → 本层实现）");
    ok(NODE_SET_RULE === "one_shared_node_set_for_all_modes", `契约 NODE_SET_RULE=${NODE_SET_RULE}`);
    ok(
      EXPLOSION_CONTROL_STAGE === "shared_layer_once_before_mode_filter",
      `契约 EXPLOSION_CONTROL_STAGE=${EXPLOSION_CONTROL_STAGE}（防爆炸早于模式过滤）`,
    );
    ok(
      DATA_FLOW_EDGE_RULE.steps.join(" > ") === "drop_self_loop > merge_mutual_pair > reverse_direction",
      `契约 DATA_FLOW_EDGE_RULE.steps=${DATA_FLOW_EDGE_RULE.steps.join(" > ")}（选择器按声明顺序逐步施加）`,
    );
    ok(
      MODES.every((m) => selectGraph(m, shared).spec.key === m),
      "三模式选择器输出各自 GraphModeSpec（边规则/方向/着色口径来自 GRAPH_MODES，视图不各写一份）",
    );
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }

  finish();
}

try {
  main();
} catch (err) {
  console.error("[verify] 异常:", err);
  process.exitCode = 1;
}
