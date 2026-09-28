// 架构共用数据层的防爆炸口径验证（R20260920-1 修复批 2：T10/R1-ZS-002 ＋ T13/R1-ZS-005）。
// 用法：node --import tsx scripts/verify-arch-cap2.ts（或 pnpm verify:arch-cap2）
//
// 覆盖点（全部纯函数 + 临时目录夹具，不调模型、不起服务、不碰任何真实项目的 `.工作台`）：
//   a 小图（节点/边都没超硬上限、公共节点入边也没爆高）→ capMergedGraph 原对象原样返回，与修前语义一致；
//   b 只超边数不超节点数 → 边按权重截断到 MAX_EDGES，节点一个不动，计数进 layers.merged.edges；
//   c 解析层已先截断出「还有 N 个」聚合节点，再叠补全层 → 仍只有一个聚合节点，计数按层相加（不吞不重）；
//   d ID 含 `>` 的合法补全节点（复刻判词场景：write_arch 写入 → 落盘 → buildSharedGraph 渲染 JSON）
//     → 端点原样保留、零悬空边（旧版 `from>to` 拼串再 split 会输出 `chat:a → b`）；
//   e top-K：补全层 9 条边指向同一 hub → 最终只留 FANOUT_KEEP 条（解析层与合并层同一份口径），扇出计数如实；
//   f 总不变量：以上每一份最终图，每条边的两端都必须落在最终节点集里。
//
// 隔离与清理：夹具一律建在 `os.tmpdir()` 下的临时目录，跑完即删；注册表/补全层都落在临时 home 的临时项目里，
// 不读不写用户真实 TATAI_HOME 与任何纳管项目。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ARCH_LIMITS, MORE_NODE_ID } from "../src/arch/config";
import { buildSharedGraph } from "../src/arch/render";
import {
  buildSharedGraphFrom,
  capMergedGraph,
  type SharedGraph,
  type SharedModuleInput,
} from "../src/arch/shared-graph";
import {
  applySupplementInput,
  mergeSupplement,
  readSupplement,
  type SupNode,
  type SupplementFile,
} from "../src/arch/supplement";
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

// 临时数据目录（不碰真实 TATAI_HOME 与真实项目）
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-arch-cap2-"));
console.log(`[verify] 临时夹具根：${tmpBase}`);

const mod = (
  id: string,
  fileCount: number,
  deps: { to: string; weight: number }[] = [],
): SharedModuleInput => ({ id, path: id, file_count: fileCount, deps });

const namesOf = (mods: SharedModuleInput[]): Record<string, { name: string; blurb: string; kind: "code" }> =>
  Object.fromEntries(mods.map((m) => [m.id, { name: m.id, blurb: "", kind: "code" as const }]));

const supNode = (id: string, name: string = id): SupNode => ({ id, name, blurb: "", kind: "mixed", path: "" });

const supFile = (
  nodes: SupNode[],
  edges: { from: string; to: string; weight?: number }[],
): SupplementFile => ({
  version: 1,
  updated_at: "2026-09-20T00:00:00Z",
  nodes,
  edges: edges.map((e) => ({ from: e.from, to: e.to, weight: e.weight ?? 1, note: "" })),
});

/** 悬空边：端点不在最终节点集里的边（总不变量 f 的判据） */
const dangling = (graph: SharedGraph): string[] => {
  const ids = new Set(graph.nodes.map((n) => n.id));
  return graph.edges.filter((e) => !ids.has(e.from) || !ids.has(e.to)).map((e) => `${e.from}→${e.to}`);
};

/** 收齐每一份最终图，供 f 段统一复查（同时按用例即时断言一次） */
const produced: { label: string; graph: SharedGraph }[] = [];
const checkNoDangling = (label: string, graph: SharedGraph, note = ""): void => {
  produced.push({ label, graph });
  const bad = dangling(graph);
  ok(bad.length === 0, `${label} 无悬空边${note ? `（${note}）` : ""}${bad.length > 0 ? `——悬空：${bad.slice(0, 5).join("，")}` : ""}`);
};

// ══════════════════════════════ a 小图：不触发任何削减 ══════════════════════════════
console.log("\n[verify] ── a 小图（不超限、无扇出）：capMergedGraph 原对象原样返回，修前语义一致");
{
  const mods = [
    mod("core", 12, [{ to: "util", weight: 3 }]),
    mod("util", 8, [{ to: "core", weight: 1 }]),
    mod("ui", 5, [{ to: "core", weight: 2 }]),
    mod("api", 3),
  ];
  const base = buildSharedGraphFrom(mods, namesOf(mods));
  const merged = mergeSupplement(
    base,
    supFile([supNode("chat:doc"), supNode("chat:flow"), supNode("chat:retry")], [{ from: "chat:doc", to: "chat:flow" }]),
  );
  const capped = capMergedGraph(merged);
  ok(capped.nodes.length === 7 && capped.edges.length === 4, `a 小图规模：节点 ${capped.nodes.length} / 边 ${capped.edges.length}（均远低于硬上限）`);
  ok(capped === merged, "a 未触发任何削减 → 返回同一对象引用（既有常规小图路径逐字节不变）");
  ok(
    JSON.stringify(capped.nodes) === JSON.stringify(merged.nodes) && JSON.stringify(capped.edges) === JSON.stringify(merged.edges),
    "a 节点集与边集与合并后逐条一致（无重排、无合并、无丢边）",
  );
  ok(
    capped.truncated.nodes === 0 &&
      capped.truncated.edges === 0 &&
      capped.truncated.layers?.parse.nodes === 0 &&
      capped.truncated.layers?.merged.fanout === 0,
    "a 截断计数全 0（各层都没有削减）",
  );
  checkNoDangling("a", capped);
}

// ══════════════════════════════ b 只超边数不超节点数 ══════════════════════════════
console.log("\n[verify] ── b 只超边数不超节点数：边按权重截断，节点一个不动");
{
  const N = 10;
  const nodes = Array.from({ length: N }, (_, i) => supNode(`chat:t${String(i).padStart(2, "0")}`));
  const edges: { from: string; to: string }[] = [];
  for (let i = 0; i < N; i++) {
    for (let k = 1; k <= 5; k++) {
      edges.push({
        from: `chat:t${String((i + k) % N).padStart(2, "0")}`,
        to: `chat:t${String(i).padStart(2, "0")}`,
      });
    }
  }
  const merged = mergeSupplement(buildSharedGraphFrom([], {}), supFile(nodes, edges));
  const capped = capMergedGraph(merged);
  ok(merged.nodes.length === N && merged.edges.length === 50, `b 合并后：节点 ${merged.nodes.length}（≤ ${ARCH_LIMITS.MAX_NODES}）/ 边 ${merged.edges.length}（> ${ARCH_LIMITS.MAX_EDGES}）`);
  ok(
    capped.nodes.length === N && !capped.nodes.some((n) => n.aggregate === true),
    `b 节点未超限：仍是 ${capped.nodes.length} 个普通节点，没有「还有 N 个」聚合节点`,
  );
  ok(capped.edges.length === ARCH_LIMITS.MAX_EDGES, `b 边截断到 ${capped.edges.length} = MAX_EDGES=${ARCH_LIMITS.MAX_EDGES}`);
  ok(
    capped.truncated.edges === 50 - ARCH_LIMITS.MAX_EDGES && capped.truncated.nodes === 0,
    `b 扁平计数：truncated.edges=${capped.truncated.edges}（= 50-40）、truncated.nodes=${capped.truncated.nodes}`,
  );
  ok(
    capped.truncated.layers?.parse.edges === 0 && capped.truncated.layers?.merged.edges === 10,
    `b 计数按层分开：layers.parse.edges=${capped.truncated.layers?.parse.edges}、layers.merged.edges=${capped.truncated.layers?.merged.edges}`,
  );
  ok(
    capped.edges.every((e, i, arr) => i === 0 || arr[i - 1].weight >= e.weight),
    "b 保留的是权重大的边（降序截断）",
  );
  checkNoDangling("b", capped);
}

// ══════════════════════════ c 解析层已先出聚合节点，再叠补全层 ══════════════════════════
console.log("\n[verify] ── c 解析层已先截断出聚合节点，再叠补全层：仍只有一个聚合节点，计数按层相加");
{
  const mods = Array.from({ length: 20 }, (_, i) =>
    mod(
      `m${String(i).padStart(2, "0")}`,
      100 - i,
      i > 0 ? [{ to: `m${String(i - 1).padStart(2, "0")}`, weight: 1 }] : [],
    ),
  );
  const base = buildSharedGraphFrom(mods, namesOf(mods));
  ok(
    base.truncated.nodes === 20 - (ARCH_LIMITS.MAX_NODES - 1) && base.nodes.filter((n) => n.aggregate === true).length === 1,
    `c 解析层先聚合：truncated.nodes=${base.truncated.nodes}、聚合节点 1 个（${base.nodes.find((n) => n.aggregate)?.name}）`,
  );
  const sup = supFile(
    Array.from({ length: 10 }, (_, i) => supNode(`chat:c${i}`)),
    [
      { from: "chat:c0", to: "chat:c9" }, // 两端都被聚合 → 自环，丢弃
      { from: "m00", to: "chat:c9" }, // 目标被聚合 → 重定向到 __more__
    ],
  );
  const capped = capMergedGraph(mergeSupplement(base, sup));
  const aggs = capped.nodes.filter((n) => n.aggregate === true);
  ok(
    capped.nodes.length === ARCH_LIMITS.MAX_NODES && aggs.length === 1,
    `c 收口后节点 ${capped.nodes.length} = MAX_NODES，聚合节点恰 ${aggs.length} 个（不产生第二个）`,
  );
  ok(
    capped.truncated.nodes === base.truncated.nodes + 10,
    `c 节点计数按层相加：解析层 ${base.truncated.nodes} + 合并层 10 = ${capped.truncated.nodes}（不吞不重）`,
  );
  ok(
    capped.truncated.layers?.parse.nodes === base.truncated.nodes && capped.truncated.layers?.merged.nodes === 10,
    `c layers 分开记：parse.nodes=${capped.truncated.layers?.parse.nodes}、merged.nodes=${capped.truncated.layers?.merged.nodes}`,
  );
  ok(aggs[0]?.name === `还有 ${capped.truncated.nodes} 个`, `c 聚合节点名「${aggs[0]?.name}」= 两层相加的总数`);
  ok(capped.edges.some((e) => e.to === MORE_NODE_ID), `c 端点被聚合的补全边重定向到 ${MORE_NODE_ID}（没丢成悬空边）`);
  checkNoDangling("c", capped);
}

// ═════════════════════ d ID 含 `>` 的合法补全节点：写入 → 落盘 → 渲染 ═════════════════════
console.log("\n[verify] ── d ID 含 `>` 的合法补全节点：write_arch 写入 → 落盘 → 渲染 JSON，零悬空边");
{
  const home = path.join(tmpBase, "home-d");
  const proj = path.join(tmpBase, "proj-d");
  fs.mkdirSync(path.join(proj, ".工作台", "arch"), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  addProject({ id: "cap-d", name: "cap-d", path: proj, kind: "backend" }, home);
  // 解析层空骨架（补全层独挑，聚焦补全层口径）
  fs.writeFileSync(
    path.join(proj, ".工作台", "arch", "modules.json"),
    JSON.stringify({ version: 1, modules: [], budget_exhausted: false }),
    "utf8",
  );

  const ids = ["chat:a>b", ...Array.from({ length: 15 }, (_, i) => `chat:n${String(i).padStart(2, "0")}`)];
  const receipt = applySupplementInput(
    "cap-d",
    {
      nodes: ids.map((id) => ({ id, name: id })),
      edges: [
        { from: "chat:a>b", to: "chat:n00" }, // 两端都保留：必须原样输出
        { from: "chat:a>b", to: "chat:n14" }, // 目标被聚合 → 重定向 __more__
        { from: "chat:n13", to: "chat:a>b" }, // 源被聚合 → 重定向 __more__
      ],
      mode: "replace",
    },
    home,
  );
  ok(
    receipt.added_nodes === 16 && receipt.added_edges === 3 && receipt.dropped_invalid_nodes === 0 && receipt.dropped_invalid_edges === 0,
    `d 写入口接受 16 个含 \`>\` 的 id 与 3 条边（回执：+${receipt.added_nodes} 节点 / +${receipt.added_edges} 边，无效节点 ${receipt.dropped_invalid_nodes} / 无效边 ${receipt.dropped_invalid_edges}）`,
  );
  const persisted = readSupplement("cap-d", home);
  ok(persisted !== null && persisted.nodes.some((n) => n.id === "chat:a>b"), "d 落盘件 supplement.json 里 chat:a>b 原样保留");

  const graph = buildSharedGraph("cap-d", { dataDir: home }).graph;
  ok(graph !== undefined && graph.nodes.length === ARCH_LIMITS.MAX_NODES, `d 渲染 JSON 节点 ${graph?.nodes.length} 个（16 补全节点超 15 → 聚合收口）`);
  if (!graph) throw new Error("渲染未产出图");
  ok(graph.nodes.some((n) => n.id === "chat:a>b"), "d 渲染 JSON 里 chat:a>b 原样保留（合法 ID 不被改写）");
  ok(
    !graph.nodes.some((n) => n.id === "chat:a" || n.id === "b") && !graph.edges.some((e) => [e.from, e.to].some((x) => x === "chat:a" || x === "b")),
    "d 没有把 ID 在 `>` 处切碎成 chat:a / b（旧版 split(\">\") 缺陷）",
  );
  ok(
    graph.edges.some((e) => e.from === "chat:a>b" && e.to === "chat:n00"),
    "d 两端都保留的那条边原样输出 chat:a>b → chat:n00",
  );
  checkNoDangling("d", graph, "写入→落盘→渲染全链路");
}

// ══════════════════════════════ e top-K：补全层入边爆高 ══════════════════════════════
console.log("\n[verify] ── e top-K：补全层 9 条入边指向同一 hub → 最终只留 5 条");
{
  const base = buildSharedGraphFrom([], {});
  const nodes = [supNode("chat:hub"), ...Array.from({ length: 9 }, (_, i) => supNode(`chat:leaf${i}`))];
  const edges = Array.from({ length: 9 }, (_, i) => ({ from: `chat:leaf${i}`, to: "chat:hub" }));
  const merged = mergeSupplement(base, supFile(nodes, edges));
  const hubInBefore = merged.edges.filter((e) => e.to === "chat:hub").length;
  const capped = capMergedGraph(merged);
  const hubIn = capped.edges.filter((e) => e.to === "chat:hub");
  ok(hubInBefore === 9, `e 合并后 hub 入边 ${hubInBefore} 条（未过滤前）`);
  ok(
    capped.nodes.length === 10 && !capped.nodes.some((n) => n.aggregate === true),
    "e 节点数 10 < MAX_NODES：本例考的是扇出过滤，不是节点聚合",
  );
  ok(hubIn.length === ARCH_LIMITS.FANOUT_KEEP, `e 最终 hub 入边 ${hubIn.length} = FANOUT_KEEP=${ARCH_LIMITS.FANOUT_KEEP}（旧版 9 条全留）`);
  ok(
    capped.truncated.layers?.merged.fanout === 9 - ARCH_LIMITS.FANOUT_KEEP,
    `e 扇出计数如实：layers.merged.fanout=${capped.truncated.layers?.merged.fanout}（= 9-5）`,
  );
  ok(
    capped.truncated.edges === 0 && capped.truncated.nodes === 0,
    "e 扇出丢弃不混进 edges/nodes 总量（只在 layers.fanout 里单独如实记）",
  );
  checkNoDangling("e", capped);

  // 边界：恰好 MAX_FANOUT（8）条入边不触发过滤
  const bNodes = [supNode("chat:hub2"), ...Array.from({ length: 8 }, (_, i) => supNode(`chat:l${i}`))];
  const bEdges = Array.from({ length: 8 }, (_, i) => ({ from: `chat:l${i}`, to: "chat:hub2" }));
  const bCapped = capMergedGraph(mergeSupplement(base, supFile(bNodes, bEdges)));
  const bHubIn = bCapped.edges.filter((e) => e.to === "chat:hub2");
  ok(
    bHubIn.length === ARCH_LIMITS.MAX_FANOUT,
    `e 边界：${ARCH_LIMITS.MAX_FANOUT} 条入边 = MAX_FANOUT 不触发过滤（保留 ${bHubIn.length} 条）`,
  );
  checkNoDangling("e(hub2)", bCapped);
}

// ═══════════ g 解析层扇出（回归：解析层与合并层共用同一份 dropFanout 后口径不变） ═══════════
console.log("\n[verify] ── g 解析层扇出：两处共用 dropFanout 重构后，解析层 top-K 口径不变");
{
  const mods = [
    mod("hub", 5),
    ...Array.from({ length: 10 }, (_, i) => mod(`d${String(i).padStart(2, "0")}`, 3, [{ to: "hub", weight: 10 - i }])),
  ];
  const base = buildSharedGraphFrom(mods, namesOf(mods));
  const hubIn = base.edges.filter((e) => e.to === "hub");
  ok(
    hubIn.length === ARCH_LIMITS.FANOUT_KEEP,
    `g 解析层 hub 入边 ${hubIn.length} = FANOUT_KEEP=${ARCH_LIMITS.FANOUT_KEEP}（10 条入边触发第 4 招）`,
  );
  ok(
    base.truncated.layers?.parse.fanout === 10 - ARCH_LIMITS.FANOUT_KEEP,
    `g 解析层扇出计数如实：layers.parse.fanout=${base.truncated.layers?.parse.fanout}（= 10-5）`,
  );
  checkNoDangling("g", base);
}

// ══════════════════════════ f 总不变量：边端点必须存在 ══════════════════════════
console.log("\n[verify] ── f 总不变量：每一份最终图，每条边的两端都必须在最终节点集里");
{
  const bad = produced.flatMap(({ label, graph }) => dangling(graph).map((e) => `${label}: ${e}`));
  ok(
    produced.length >= 6 && bad.length === 0,
    `f 共核 ${produced.length} 份最终图、${bad.length} 条悬空边（覆盖小图 / 只超边 / 聚合叠加 / 含 \`>\` ID / 扇出 / 解析层扇出）`,
  );
}

// ── 清理临时夹具 ──
try {
  fs.rmSync(tmpBase, { recursive: true, force: true });
  console.log("[verify] 临时夹具已删除");
} catch {
  console.log(`[verify] 临时夹具删除失败（Windows 偶发占用，残留无害）：${tmpBase}`);
}

console.log(`\n[verify] 结果：${pass} PASS / ${fail} FAIL`);
