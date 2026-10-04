// V09-22 验证脚本（tsx 跑）：六图聚合节点「全量可查看」的两档口径（overview=概览默认 / full=全量）。
// 用法：pnpm verify:v09-22
//
// 覆盖（逐条对着施工任务书 §3.1 A–D）：
//   A. 纯函数夹具（buildSharedGraphFrom / capMergedGraph / capChildren / expandDirectory）：
//      概览 15 节点上限 / 40 边截断 / 扇出过滤计数（回归）；全量逐 ID 对账（无漏无重、2500 仍聚合不静默）；
//      边端点有效、权重排序稳定；tmp 目录 45 直接子级的单枝上限（概览 39+聚合，全量 45 全可见）。
//   B. capOverview / buildViewModel 的 >15 分组夹具：概览 15 分组+聚合；全量全分组、aggregate_node=null、
//      hidden_members=0、成员并集=源。
//   C. sixGraphsOf 双模式 + MCP 语义：真实项目 full 小 limit 走 cursor 逐页取到 complete（无漏无重）；
//      module_map/data_flow 全量 id 并集 === 源文件现场算出的期望全集；overview vs full 逐 id 来源/状态一致；
//      overview 隐藏量指引 + underlying 计数；伪快照游标明确报错、真游标续取与一次全量逐 id 一致；
//      budget_exhausted 夹具 + 忽略目录/origin:chat 标注；80/1000/2500 与两真实项目 full 构建计时。
//   D. 兼容回归：不带新参数调纯函数 / buildViewModel / capOverview / capChildren，概览语义数值不变。
//   G. 上限外逐项取回（V09-22 返工，终态契约 1/2/3/4）：2001 节点 / 2001 子级 / 20001 节点＋41000 边 /
//      10 节点 9 入边（扇出）——断言 archItemsOf 逐项取回、expandDirectory childrenOffset 稳定分页、
//      sixGraphsOf mode=full 未聚合候选分页、扇出只记 layers（钉住不回退）。**未实现的契约记为 FAIL
//      （消息含「契约未实现（修前红）」），不降强度、不让脚本中途崩掉。**
//   H. 游标模式绑定：概览游标传 full / full 游标传概览被拒（点名模式），旧三段概览游标兼容，full 续取无重叠。
//   I. 草稿快照稳定：草稿态夹具跨 1.3s 续取 snapshot_id 不漂移；modules.json 变更 ⇒ snapshot_id 变、旧游标拒。
//   K. 采集层无损化（2026-09-29 六图完整读取轮）：真实目录扫描 20 顶层目录 → parseDirectory 全候选保留
//      （修前红：14＋「其他」桶＝15）＋概览投影 15 上限仍在；落盘读回 full/archItemsOf 取齐；旧「其他」桶
//      识别＋anomalies/notes 标注；next_read_entry 指向 mode=full；by_origin 分层计数与逐节点 origin_layer。
//   R. 2026-09-29 返工回归（F2/F3/F4/F5）＋同日定向收尾（R1/R3）：names.json 入指纹的同进程改名一致性
//      （overview/full/archItemsOf 同见新名、snapshot_id 随改名变）；by_origin 只数可见真实实体＋
//      by_origin_underlying 底层口径；顶层 collection 结构化采集完整性（与分页 completeness 独立、
//      可同时成立）；真实 other/ 目录不误报旧桶、重采集后残留旧人名引用不炸、不串名；
//      R-F6 损坏结构（合法 JSON、modules 或 path 形状不对）在读取边界拒绝、六图降级 unknown＋原因；
//      R-F7 非布尔 budget_exhausted 标记按未知处理、不回显非法值、不判 complete。
//
// 隔离口径（AGENTS.md §5）：夹具一律放系统 tmp 下 `tmp-v0922-` 前缀目录，收尾自清；真实项目**只读**
// （sixGraphsOf / renderGraph / expandDirectory 全是只读函数，直接 import 调用，不写任何真实数据）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { getProjectGraphsTool } from "../src/mcp/tools/getProjectGraphs";
import { readBlueprint, viewGraphWithPlan, type Blueprint } from "../src/arch/blueprint";
import { ARCH_LIMITS, MCP_FULL_LIMITS, MORE_NODE_ID, RENDER_FULL_LIMITS } from "../src/arch/config";
import { expandDirectory } from "../src/arch/expand";
import { archItemsOf } from "../src/arch/items";
import { legacyAggregationOf, parseDirectory, parseProject, readModules, slugify } from "../src/arch/parse";
import { renderGraph } from "../src/arch/render";
import { readSupplement } from "../src/arch/supplement";
import {
  buildSharedGraphFrom,
  capChildren,
  capMergedGraph,
  type SharedModuleInput,
} from "../src/arch/shared-graph";
import { SIX_GRAPH_KEYS, sixGraphsOf, type SixGraphKey } from "../src/arch/sixGraphs";
import { addProject, listProjects, resolveDataDir } from "../src/server/registry";
import { readProgress } from "../src/server/workstation";
import { buildViewModel, capOverview } from "../src/ui/arch/projectGraph";
import { REPO_ROOT } from "./lib/fixtures";

let pass = 0;
const fails: string[] = [];
/** 本步未能取到读数、留给第二步复跑的段（如超时/环境不可用），不计入 FAIL */
const skips: string[] = [];
/** 分段计数（J：脚本尾部打印各段 PASS/FAIL/SKIP） */
let curSection = "(未分段)";
const sectionStats = new Map<string, { pass: number; fail: number; skip: number }>();
const statOf = (name: string): { pass: number; fail: number; skip: number } => {
  let s = sectionStats.get(name);
  if (s === undefined) {
    s = { pass: 0, fail: 0, skip: 0 };
    sectionStats.set(name, s);
  }
  return s;
};
const ok = (cond: boolean, label: string): void => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (cond) {
    pass += 1;
    statOf(curSection).pass += 1;
  } else {
    fails.push(label);
    statOf(curSection).fail += 1;
  }
};
const skip = (label: string): void => {
  console.log(`[verify] SKIP ${label}`);
  skips.push(label);
  statOf(curSection).skip += 1;
};
const info = (msg: string): void => console.log(`[verify]   ${msg}`);
const section = (t: string): void => {
  curSection = t;
  console.log(`\n[verify] ── ${t} ──`);
};

// ─────────────────────────────── 夹具目录（tmp 前缀，收尾自清） ───────────────────────────────
const TMP_BASE = fs.existsSync("D:\\tmp") ? "D:\\tmp" : os.tmpdir();
const CLEANUP: string[] = [];
const mkTmp = (tag: string): string => {
  const dir = fs.mkdtempSync(path.join(TMP_BASE, `tmp-v0922-${tag}-`));
  CLEANUP.push(dir);
  return dir;
};

// ─────────────────────────────── 纯函数夹具构造 ───────────────────────────────
/** 顶层模块夹具：id `mod<i>`、file_count 降序唯一。`dense` 时每节点 3 条出边 + 12 条汇入末节点
 *  （末节点入度 15 > MAX_FANOUT 8 ⇒ 触发扇出过滤；总边数 > MAX_EDGES 40 ⇒ 触发边截断）。 */
function makeModules(n: number, dense = false): SharedModuleInput[] {
  const mods: SharedModuleInput[] = [];
  for (let i = 0; i < n; i++) {
    const deps: { to: string; weight: number }[] = [];
    if (dense && n > 1) {
      for (const off of [1, 3, 5]) deps.push({ to: `mod${(i + off) % n}`, weight: 1 + ((i * 7 + off) % 5) });
      if (i < 12) deps.push({ to: `mod${n - 1}`, weight: 2 });
    }
    mods.push({ id: `mod${i}`, path: `mod${i}`, file_count: n - i, deps });
  }
  return mods;
}

/** 边端点的独立口径统计（fixture 语义：端点不被聚合时 from/to 即真实 id） */
function expectedEdgeStats(mods: SharedModuleInput[], maxEdges: number, maxFanout: number, fanoutKeep: number) {
  const pairs = new Set<string>();
  const inDeg = new Map<string, number>();
  for (const m of mods) {
    for (const d of m.deps) {
      if (m.id === d.to) continue;
      const key = `${m.id}>${d.to}`;
      if (pairs.has(key)) continue; // 同一对端点在解析层会先聚合（权重求和）再算入度，这里按唯一边计
      pairs.add(key);
      inDeg.set(d.to, (inDeg.get(d.to) ?? 0) + 1);
    }
  }
  let fanoutDropped = 0;
  for (const deg of inDeg.values()) if (deg > maxFanout) fanoutDropped += deg - fanoutKeep;
  const afterFanout = pairs.size - fanoutDropped;
  return { unique: pairs.size, fanoutDropped, afterFanout, capped: Math.max(0, afterFanout - maxEdges) };
}

const isSortedEdges = (edges: { from: string; to: string; weight: number }[]): boolean => {
  for (let i = 1; i < edges.length; i++) {
    const a = edges[i - 1];
    const b = edges[i];
    if (a.weight < b.weight) return false;
    if (a.weight === b.weight && a.from > b.from) return false;
    if (a.weight === b.weight && a.from === b.from && a.to > b.to) return false;
  }
  return true;
};

// ─────────────────────────────── G/H/I 夹具构造（tmp 前缀，收尾自清） ───────────────────────────────

/** 顺序模块夹具：id `n0001…`（位数可调），file_count **严格降序唯一**（保证节点保留顺序确定） */
function makeSeqModules(n: number, width = 4): SharedModuleInput[] {
  const mods: SharedModuleInput[] = [];
  for (let i = 1; i <= n; i++) {
    const id = `n${String(i).padStart(width, "0")}`;
    mods.push({ id, path: id, file_count: n - i + 1, deps: [] });
  }
  return mods;
}

/** G3 夹具：`n` 个模块 + `edgeCount` 条**唯一、无互逆**依赖边。
 *  构造：偏移族 [1,3,7]，第 k 条边 = `n{(k%n)+1} → n{((k%n)+off)%n + 1}`，off 随族递增。
 *  偏移均小于 n，故 (i,i+o1) 与 (j,j+o2) 相等只能同 i 同 o——族间不重复；o1+o2=n 不可达 ⇒ 无互逆。
 *  现场算出唯一边对数写在断言里（本应恰等于 edgeCount）。 */
function makeEdgeFixture(n: number, edgeCount: number, width = 5): { mods: SharedModuleInput[]; pairs: Set<string> } {
  const offsets = [1, 3, 7];
  const depsById = new Map<string, { to: string; weight: number }[]>();
  const pairs = new Set<string>();
  const idOf = (i: number): string => `n${String(i + 1).padStart(width, "0")}`;
  for (let k = 0; k < edgeCount; k++) {
    const off = offsets[Math.min(offsets.length - 1, Math.floor(k / n))];
    const i = k % n;
    const from = idOf(i);
    const to = idOf((i + off) % n);
    const key = `${from}>${to}`;
    if (pairs.has(key)) continue; // 防御：理论不重复
    pairs.add(key);
    if (!depsById.has(from)) depsById.set(from, []);
    depsById.get(from)!.push({ to, weight: 1 });
  }
  const mods: SharedModuleInput[] = [];
  for (let i = 0; i < n; i++) {
    const id = idOf(i);
    mods.push({ id, path: id, file_count: n - i, deps: depsById.get(id) ?? [] });
  }
  return { mods, pairs };
}

/** 临时项目夹具：建 home + 项目目录，写入给定的相对路径文件（字符串原样写，其余 JSON），注册进 home。
 *  只落系统 tmp（收尾随 CLEANUP 自清），真实数据不动。
 *  预置 progress.json（F2 返工后必需）：快照标识自 V09-22 返工起含 progress.json 内容 sha，而 progress.json
 *  是 readProgress 首次调用时**懒建**的副作用（发生在本读口算完快照之后）→ 不预置则同一夹具首读建文件、
 *  第二次调用快照就变（分页/续取误报「另一份快照」）。真实工程跑过初始化后 progress.json 恒在，
 *  这里一次性预置，让夹具与真实工程的稳态一致（不是绕开采集完整性判据：那只读 modules.json）。 */
function makeTmpProject(
  tag: string,
  id: string,
  files: Record<string, unknown>,
): { home: string; dir: string } {
  const home = mkTmp(`${tag}-home`);
  const dir = mkTmp(`${tag}-proj`);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, ...rel.split("/"));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, typeof content === "string" ? content : JSON.stringify(content), "utf8");
  }
  addProject({ id, name: id, path: dir, kind: "backend" }, home);
  readProgress(id, home); // 幂等初始化 `.工作台/progress.json`（内容确定，无时间戳 ⇒ 快照稳定）
  return { home, dir };
}

/** 动态 import 包一层：模块/导出不存在时返回 null（不抛），供「契约未实现（修前红）」分支用 */
async function tryImport<T>(spec: string): Promise<T | null> {
  try {
    return (await import(spec)) as T;
  } catch {
    return null;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  // ═════════════════════ A. 纯函数夹具 ═════════════════════
  section("A1. 概览上限（15 节点聚合 / 40 边截断 / 扇出过滤计数）");
  {
    for (const n of [15, 16, 80, 1000]) {
      const g = buildSharedGraphFrom(makeModules(n), {});
      ok(g.nodes.length === ARCH_LIMITS.MAX_NODES, `A1 概览 n=${n} 节点数=${g.nodes.length}（=上限 ${ARCH_LIMITS.MAX_NODES}）`);
      const agg = g.nodes.filter((x) => x.aggregate === true);
      const overflow = n > ARCH_LIMITS.MAX_NODES;
      ok(
        overflow ? agg.length === 1 && g.truncated.nodes === n - (ARCH_LIMITS.MAX_NODES - 1) : agg.length === 0 && g.truncated.nodes === 0,
        `A1 概览 n=${n} 聚合节点=${agg.length}、truncated.nodes=${g.truncated.nodes}（与既有口径一致）`,
      );
    }
    const dense = makeModules(15, true);
    const g = buildSharedGraphFrom(dense, {});
    const exp = expectedEdgeStats(dense, ARCH_LIMITS.MAX_EDGES, ARCH_LIMITS.MAX_FANOUT, ARCH_LIMITS.FANOUT_KEEP);
    info(`A1 密边夹具：唯一边 ${exp.unique} 条、扇出丢弃 ${exp.fanoutDropped}、边上限再截断 ${exp.capped}`);
    ok(g.truncated.layers?.parse.fanout === exp.fanoutDropped, `A1 扇出丢弃计数=${g.truncated.layers?.parse.fanout}（期望 ${exp.fanoutDropped}，回归 §4.3 第 4 招）`);
    ok(g.edges.length === ARCH_LIMITS.MAX_EDGES && g.truncated.edges === exp.capped, `A1 40 边硬上限：本页边=${g.edges.length}、truncated.edges=${g.truncated.edges}（期望 ${exp.capped}）`);
  }

  section("A2. 全量逐 ID 对账 + 2500 仍聚合不静默");
  {
    const cases: { n: number; limits: typeof RENDER_FULL_LIMITS | typeof MCP_FULL_LIMITS; label: string }[] = [
      { n: 15, limits: RENDER_FULL_LIMITS, label: "RENDER_FULL" },
      { n: 16, limits: RENDER_FULL_LIMITS, label: "RENDER_FULL" },
      { n: 80, limits: RENDER_FULL_LIMITS, label: "RENDER_FULL" },
      { n: 1000, limits: RENDER_FULL_LIMITS, label: "RENDER_FULL" },
      { n: 2500, limits: MCP_FULL_LIMITS, label: "MCP_FULL" },
    ];
    for (const c of cases) {
      const src = makeModules(c.n);
      const g = buildSharedGraphFrom(src, {}, new Map(), c.limits);
      const realIds = g.nodes.filter((x) => x.aggregate !== true).map((x) => x.id);
      const srcIds = src.map((m) => m.id);
      const sameSet = realIds.length === srcIds.length && new Set(realIds).size === realIds.length && srcIds.every((id) => realIds.includes(id));
      ok(sameSet, `A2 ${c.label} n=${c.n}：全量非聚合 id 集合 === 源全集（${realIds.length}/${srcIds.length}，无漏无重）`);
      ok(g.truncated.nodes === 0, `A2 ${c.label} n=${c.n}：未触发节点上限（truncated.nodes=${g.truncated.nodes}）`);
    }
    const src2500 = makeModules(2500);
    const g2500 = buildSharedGraphFrom(src2500, {}, new Map(), RENDER_FULL_LIMITS);
    const hidden = 2500 - (RENDER_FULL_LIMITS.MAX_NODES - 1);
    ok(
      g2500.nodes.length === RENDER_FULL_LIMITS.MAX_NODES && g2500.truncated.nodes === hidden && g2500.nodes.some((x) => x.aggregate === true),
      `A2 RENDER_FULL n=2500：本页 ${g2500.nodes.length} 节点、仍聚合 ${g2500.truncated.nodes}（期望 ${hidden}，计数如实不静默）`,
    );
  }

  section("A3. 边端点有效 + 权重排序稳定");
  {
    for (const n of [80, 1000]) {
      const g = buildSharedGraphFrom(makeModules(n, true), {}, new Map(), RENDER_FULL_LIMITS);
      const ids = new Set(g.nodes.map((x) => x.id));
      const dangling = g.edges.filter((e) => !ids.has(e.from) || !ids.has(e.to));
      ok(dangling.length === 0, `A3 n=${n} 全量：每条边 from/to 均在节点集内（悬空 ${dangling.length} 条）`);
      ok(isSortedEdges(g.edges), `A3 n=${n} 全量：边按（权重降序→from 升序→to 升序）稳定排序`);
    }
  }

  section("A4. expandDirectory tmp 目录夹具（45 个直接子级）");
  {
    const root = mkTmp("expand");
    const N = 45;
    for (let i = 0; i < N; i++) fs.writeFileSync(path.join(root, `part-${String(i).padStart(3, "0")}.txt`), "x", "utf8");
    const ov = expandDirectory(root, ".");
    const kept = ov.children.filter((c) => c.kind !== "aggregate");
    ok(ov.children.length === ARCH_LIMITS.MAX_CHILDREN && kept.length === ARCH_LIMITS.MAX_CHILDREN - 1 && ov.truncated.children === N - kept.length, `A4 概览：本页 ${ov.children.length} 子级（保留 ${kept.length} + 聚合 1）、truncated.children=${ov.truncated.children}`);
    ok(ov.children.some((c) => c.kind === "aggregate" && c.name.includes("还有")), "A4 概览：聚合节点在场（name 含「还有 N 个」）");
    const full = expandDirectory(root, ".", { childrenLimit: RENDER_FULL_LIMITS.MAX_CHILDREN });
    const ids = full.children.map((c) => c.id);
    ok(full.children.length === N && new Set(ids).size === N, `A4 全量：子级 ${full.children.length}（=源 ${N}）、id 唯一（${new Set(ids).size}）`);
    ok(full.truncated.children === 0 && full.limit.children === RENDER_FULL_LIMITS.MAX_CHILDREN, `A4 全量：truncated.children=${full.truncated.children}、生效上限=${full.limit.children}`);
    ok(typeof full.stats.budget_exhausted === "boolean" && typeof full.limit.children === "number", "A4 响应自带预算与上限字段（budget_exhausted / limit.children）");
  }

  section("A5. capMergedGraph 合并后再施上限（补全层并入后仍聚合+计数）");
  {
    const base = buildSharedGraphFrom(makeModules(10), {});
    const extra = base.nodes.map((x, i) => ({ ...x, id: `chat:extra-${i}`, file_count: 0 }));
    const merged = { ...base, nodes: [...base.nodes, ...extra] };
    const capped = capMergedGraph(merged, { MAX_NODES: 12 });
    ok(capped.nodes.length === 12 && capped.truncated.nodes === merged.nodes.length - 11, `A5 capMergedGraph：本页 ${capped.nodes.length} 节点、聚合 ${capped.truncated.nodes}（合并层计数如实）`);
    ok(capped.nodes.some((x) => x.aggregate === true), "A5 聚合节点在场（不静默截断）");
  }

  // ═════════════════════ B. capOverview / buildViewModel 分组夹具 ═════════════════════
  section("B. capOverview / buildViewModel（>15 分组最小蓝图）");
  {
    const G = 20;
    const nodes: Blueprint["nodes"] = [];
    const edges: Blueprint["edges"] = [];
    const taskIds: string[] = [];
    for (let i = 1; i <= G; i++) {
      const k = String(i).padStart(2, "0");
      nodes.push({ id: `plan:cap:${k}`, kind: "capability", name: `能力 ${k}`, source_refs: [], related_ids: [] });
      nodes.push({ id: `plan:task:T${k}`, kind: "task", name: `任务 T${k}`, source_refs: [], related_ids: [] });
      nodes.push({ id: `plan:code:m${k}`, kind: "module", name: `模块 m${k}`, source_refs: [], related_ids: [] });
      taskIds.push(`plan:task:T${k}`);
      // 分组归属：任务的设计依据指向能力（成员 = 任务）；实现映射连到代码模块（机械构造，供状态层）
      edges.push({ source: `plan:task:T${k}`, target: `plan:cap:${k}`, kind: "task_design_ref", source_refs: [], certainty: "declared" });
      edges.push({ source: `plan:task:T${k}`, target: `plan:code:m${k}`, kind: "implementation_map", source_refs: [], certainty: "observed" });
    }
    const bp: Blueprint = {
      version: 1,
      baseline_id: null,
      generator_version: "verify-v09-22",
      generated_at: new Date().toISOString(),
      source_manifest: [],
      nodes,
      edges,
      coverage: {
        design_sections: { total: 0, mapped: 0, unmapped: [] },
        plan_tasks: { total: G, mapped: G, unmapped: [] },
        code_modules: { total: G, mapped: G, unmapped: [] },
        nodes_total: nodes.length,
        nodes_kept: nodes.length,
        edges_total: edges.length,
        edges_kept: edges.length,
        note: "验证夹具",
      },
      omitted: [],
      model_receipt: null,
      publish: { published: true, reason: null, validated_at: null },
      based_on: { model_key: "fixture", full_key: "fixture", design_content_sha256: null, plan_definition_sha256: null, semantic: false },
    };
    const ov = buildViewModel({ view: "functional", blueprint: bp, projection: {} });
    const ovGroups = ov.nodes.filter((n) => n.kind !== "aggregate");
    const aggregate = ov.nodes.find((n) => n.aggregate === true);
    ok(ovGroups.length === 15 && aggregate !== undefined && ov.aggregate_node !== null, `B 概览：分组节点 ${ovGroups.length}（=15）+ 聚合节点在场（hidden_count=${ov.overview.hidden_count}）`);
    ok(ov.overview.hidden_count === G - 15, `B 概览：隐藏分组数=${ov.overview.hidden_count}（期望 ${G - 15}）`);
    const full = buildViewModel({ view: "functional", blueprint: bp, projection: {}, overview_full: true });
    ok(full.nodes.length === G && full.nodes.every((n) => n.kind !== "aggregate"), `B 全量：分组节点 ${full.nodes.length}（=源 ${G}）、无聚合节点`);
    ok(full.aggregate_node === null && full.nodes.every((n) => n.hidden_members === 0), `B 全量：aggregate_node=${full.aggregate_node}、hidden_members 全 0`);
    const shownMembers = new Set(full.nodes.flatMap((n) => n.members));
    ok(shownMembers.size === G && taskIds.every((t) => shownMembers.has(t)), `B 全量：成员 id 并集=${shownMembers.size}（=源任务 ${G}，一个不漏）`);
    info(`B 概览聚合节点 label：${aggregate?.label ?? "(无)"}`);
  }

  // ═════════════════════ C. sixGraphsOf 双模式 + MCP 语义 ═════════════════════
  const HOME = resolveDataDir();
  const realProjects = listProjects(HOME).filter((p) => fs.existsSync(path.join(p.path, ".工作台", "arch", "modules.json")));
  info(`真实数据目录 ${HOME} 下可读项目：${realProjects.map((p) => p.id).join("、")}（只读）`);

  /** 现场算出技术层「期望全集」：modules.json 模块 id ∪ supplement.json 补全节点 ∪ 蓝图规划层新增节点 */
  const expectedTechIds = (projectId: string): Set<string> => {
    const { arch } = readModules(projectId);
    const staticIds = new Set((arch?.modules ?? []).map((m) => m.id));
    const chatIds = (readSupplement(projectId)?.nodes ?? []).map((n) => n.id);
    const bp = readBlueprint(projectId);
    const planNew: string[] = [];
    for (const n of bp?.nodes ?? []) {
      const codeIds = n.source_refs.filter((r) => r.kind === "code_module").map((r) => r.locator);
      if (codeIds.some((c) => staticIds.has(c))) continue; // 命中实测模块 → 复用静态节点，不新增 id
      planNew.push(n.id);
    }
    return new Set([...staticIds, ...chatIds, ...planNew]);
  };

  /** 逐图把整份响应取到 complete（同快照 cursor 续取）：单图请求，避免预算被别的图吃掉 */
  const collectGraph = (
    projectId: string,
    mode: "overview" | "full",
    limit: number,
    key: SixGraphKey,
    dataDir?: string,
  ) => {
    const pages: { nodes: { id: string }[]; edges: { from: string; to: string }[] }[] = [];
    const first = sixGraphsOf(projectId, { mode, limit, graph: key, ...(dataDir ? { dataDir } : {}) });
    const g0 = first.graphs[key];
    if (g0) pages.push({ nodes: g0.nodes, edges: g0.edges });
    let cursor: string | null = first.completeness.cursors[key] ?? null;
    let guard = 0;
    while (cursor !== null && guard++ < 500) {
      const snap = sixGraphsOf(projectId, { mode, limit, graph: key, cursor, ...(dataDir ? { dataDir } : {}) });
      const g = snap.graphs[key];
      if (g) pages.push({ nodes: g.nodes, edges: g.edges });
      cursor = snap.completeness.cursors[key] ?? null;
    }
    return pages;
  };

  /** 项目是否有稳定快照（有已发布规划图 ⇒ generated_at 固定，同快照 cursor 续取可用）。
   *  草稿态工程（无已发布图）的快照标识取自每次现派生的草稿 generated_at，会随时间漂移——
   *  那种工程上跨快照续取按设计被拒（见下方 C1 说明），不在此断言续取。 */
  const hasStableSnapshot = (projectId: string): boolean =>
    sixGraphsOf(projectId, { summary_only: true }).graph_state.availability === "published";

  section("C1. 真实项目 full 小 limit 逐页续取 + 底层 id 并集 === 源全集");
  {
    for (const p of realProjects) {
      const oneShot = sixGraphsOf(p.id, { mode: "full", limit: 100000 });
      const stable = hasStableSnapshot(p.id);
      if (!stable) {
        info(
          `C1 ${p.id} 是草稿态工程（无已发布规划图）：快照标识取自每次现派生的草稿 generated_at，跨调用会漂移，` +
            "同快照 cursor 续取按设计被拒（不跨快照拼数据）——本工程改用一次全量逐 id 对账（下方断言），续取契约在 C5 夹具（稳定快照）与已发布工程上验证",
        );
      }
      for (const key of ["module_map", "data_flow"] as const) {
        // 逐页续取（同快照）：仅对有稳定快照的工程断言；草稿态工程一次全量取（见上说明）
        const pages = stable ? collectGraph(p.id, "full", 200, key) : [];
        const ids: string[] = [];
        const edgeEndpoints: string[] = [];
        const nodeIdSet = new Set<string>();
        for (const pg of pages) {
          for (const n of pg.nodes) {
            ids.push(n.id);
            nodeIdSet.add(n.id);
          }
          for (const e of pg.edges) edgeEndpoints.push(e.from, e.to);
        }
        const oneNodes = oneShot.graphs[key]?.nodes ?? [];
        const oneIds = oneNodes.map((n) => n.id);
        const oneSet = new Set(oneIds);
        if (stable) {
          const noDup = new Set(ids).size === ids.length;
          ok(noDup && ids.length === oneIds.length && oneIds.every((id) => nodeIdSet.has(id)), `C1 ${p.id}/${key}：limit=200 逐页续取并集 ${ids.length} 个 node id 无漏无重（一次全量 ${oneIds.length}，complete）`);
          const dangle = edgeEndpoints.filter((id) => !nodeIdSet.has(id));
          ok(dangle.length === 0, `C1 ${p.id}/${key}：每条边端点 ∈ 节点集（悬空 ${dangle.length}）`);
        }
        // 底层 id 并集 === 源全集（现场算出的期望集，one-shot 与分页两种取法同断言）
        const expected = expectedTechIds(p.id);
        const missing = [...expected].filter((id) => !oneSet.has(id));
        const extra = [...oneIds].filter((id) => !expected.has(id));
        ok(new Set(oneIds).size === oneIds.length && missing.length === 0 && extra.length === 0, `C1 ${p.id}/${key}：底层 id 并集 === 源全集（期望 ${expected.size}，缺 ${missing.length}/多 ${extra.length}，无重复）`);
      }
    }
  }

  section("C2. 同一 node id 在 overview 与 full 的来源/状态逐 id 一致");
  {
    for (const p of realProjects) {
      const ov = sixGraphsOf(p.id, { mode: "overview" });
      const full = sixGraphsOf(p.id, { mode: "full", limit: 100000 });
      for (const key of ["module_map", "data_flow"] as const) {
        const fmap = new Map((full.graphs[key]?.nodes ?? []).map((n) => [n.id, n]));
        const common = (ov.graphs[key]?.nodes ?? []).filter((n) => fmap.has(n.id));
        const same = common.every((n) => {
          const f = fmap.get(n.id)!;
          return (
            n.object.status_key === f.object.status_key &&
            n.object.evidence_state === f.object.evidence_state &&
            n.object.source_kinds.join(",") === f.object.source_kinds.join(",")
          );
        });
        ok(common.length > 0 && same, `C2 ${p.id}/${key}：${common.length} 个共有 id 的 status_key/evidence_state/source_kinds 逐 id 相等`);
      }
    }
  }

  section("C3. overview 隐藏量指引 + underlying 计数");
  {
    const p = realProjects.find((x) => (sixGraphsOf(x.id, { mode: "overview" }).graphs.module_map?.counts.hidden_members ?? 0) > 0) ?? realProjects[0];
    const ov = sixGraphsOf(p.id, { mode: "overview" });
    const full = sixGraphsOf(p.id, { mode: "full", limit: 100000 });
    info(`C3 用项目 ${p.id}（概览 module_map hidden_members=${ov.graphs.module_map?.counts.hidden_members ?? 0}）`);
    ok((ov.completeness.note ?? "").includes("mode=full"), "C3 overview 且 hidden>0 ⇒ completeness.note 含「mode=full」指引");
    // module_map：underlying_nodes = 本页非聚合节点 + 隐藏节点（§1.5 口径，逐项可核）
    const mm = ov.graphs.module_map!.counts;
    const mmShown = mm.nodes - (mm.aggregate_node ? 1 : 0);
    ok(mm.underlying_nodes === mmShown + mm.hidden_members, `C3 module_map：underlying_nodes=${mm.underlying_nodes} = 本页非聚合 ${mmShown} + 隐藏 ${mm.hidden_members}（§1.5）`);
    // 两种模式的底层**节点**候选总数同源（同一 builder，只是上限不同）
    for (const key of ["module_map", "data_flow"] as const) {
      const c = ov.graphs[key]!.counts;
      const fc = full.graphs[key]!.counts;
      ok(c.underlying_nodes === fc.underlying_nodes, `C3 ${key}：overview 与 full 的底层节点候选总数一致（${c.underlying_nodes}）`);
      // 全量无节点/边上限：module_map 视图边 = 全量边集合（相等）；data_flow 视图边是方向子集（≤ 全量）
      ok(fc.underlying_edges >= fc.edges, `C3 ${key}：full underlying_edges=${fc.underlying_edges} ≥ 本页返回边 ${fc.edges}（data_flow 为方向子集）`);
      ok(c.underlying_edges >= c.edges && c.underlying_edges <= fc.underlying_edges, `C3 ${key}：概览 underlying_edges=${c.underlying_edges} 介于本页边 ${c.edges} 与全量 ${fc.underlying_edges} 之间`);
    }
    ok(mm.underlying_edges <= full.graphs.module_map!.counts.underlying_edges, `C3 module_map：概览底层边 ${mm.underlying_edges} ≤ 全量底层边 ${full.graphs.module_map!.counts.underlying_edges}`);
    // 口径差异登记（不修，仅如实说明）：data_flow 的 hidden_members/aggregate_node 恒 0/false，
    // 而 underlying_nodes 已计入隐藏节点；underlying_edges 也不含「被节点上限重定向合掉的边」。
    info(
      `C3 口径备注：data_flow counts.hidden_members=${ov.graphs.data_flow!.counts.hidden_members}、aggregate_node=${ov.graphs.data_flow!.counts.aggregate_node}（硬编码），` +
        `而 underlying_nodes=${ov.graphs.data_flow!.counts.underlying_nodes} 已含隐藏——「underlying = 显示 + hidden_members」在 data_flow 上不成立；` +
        `module_map 概览 underlying_edges=${mm.underlying_edges} 不含被节点上限重定向合掉的边（truncated.edges=${mm.truncated_by_limit}）`,
    );
  }

  section("C4. MCP 语义：伪快照游标明确报错、真游标续取与一次全量逐 id 一致");
  {
    const p = realProjects[0];
    const bad = getProjectGraphsTool.handler({ project_id: p.id, mode: "full", limit: 200, cursor: "gs-deadbeef:module_map:5" });
    ok(typeof (bad as { then?: unknown }).then !== "function", "C4 伪快照游标：handler 同步返回（不抛异常）");
    const badRes = bad as { isError?: boolean; content: { text: string }[] };
    ok(badRes.isError === true && badRes.content[0].text.includes("另一份快照"), `C4 伪快照游标：返回 errorResult 且文案点名「另一份快照」（${(badRes.content[0].text || "").slice(0, 40)}…）`);
    // 真游标续取（用有稳定快照的工程；草稿态工程的快照标识会漂移，见 C1 说明）
    const stableProject = realProjects.find((x) => hasStableSnapshot(x.id)) ?? null;
    ok(stableProject !== null, `C4 找到有稳定快照的工程用于真游标续取（${stableProject?.id ?? "无"}）`);
    if (stableProject !== null) {
      const sid = stableProject.id;
      const first = getProjectGraphsTool.handler({ project_id: sid, mode: "full", limit: 200, graph: "module_map" }) as { content: { text: string }[] };
      const snap = JSON.parse(first.content[0].text) as {
        completeness: { cursors: Partial<Record<SixGraphKey, string>> };
        graphs: Record<string, { nodes: { id: string }[] }>;
      };
      const realCursor = snap.completeness.cursors.module_map;
      ok(typeof realCursor === "string" && realCursor.length > 0, `C4 首轮 full 返回真游标（module_map: ${realCursor ?? "(无)"}）`);
      if (typeof realCursor === "string") {
        const page2 = JSON.parse(
          (getProjectGraphsTool.handler({ project_id: sid, mode: "full", limit: 200, graph: "module_map", cursor: realCursor }) as { content: { text: string }[] }).content[0].text,
        ) as { graphs: Record<string, { nodes: { id: string }[] }> };
        const oneShot = sixGraphsOf(sid, { mode: "full", limit: 100000 });
        const union = new Set([...snap.graphs.module_map.nodes.map((n) => n.id), ...page2.graphs.module_map.nodes.map((n) => n.id)]);
        const oneIds = (oneShot.graphs.module_map?.nodes ?? []).map((n) => n.id);
        ok(oneIds.every((id) => union.has(id)), `C4 真游标续取：并集覆盖一次全量的全部 ${oneIds.length} 个 module_map node id`);
      }
    }
  }

  section("C5. budget_exhausted 夹具 + 忽略目录 / origin:chat 标注");
  {
    const TMP_HOME = mkTmp("home");
    const projDir = mkTmp("proj");
    const archDir = path.join(projDir, ".工作台", "arch");
    fs.mkdirSync(archDir, { recursive: true });
    fs.writeFileSync(
      path.join(archDir, "modules.json"),
      JSON.stringify({
        version: 1,
        generated_at: new Date().toISOString(),
        budget_exhausted: true,
        modules: [
          { id: "src", name: "", path: "src", file_count: 9, loc: 0, deps: [{ to: "lib", weight: 1 }] },
          { id: "lib", name: "", path: "lib", file_count: 5, loc: 0, deps: [] },
        ],
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(archDir, "supplement.json"),
      JSON.stringify({
        version: 1,
        updated_at: new Date().toISOString(),
        nodes: [{ id: "chat:concept", name: "聊天补的概念", blurb: "", kind: "mixed", path: "" }],
        edges: [],
      }),
      "utf8",
    );
    addProject({ id: "v0922-fixture", name: "V09-22 夹具", path: projDir, kind: "backend" }, TMP_HOME);
    const snap = sixGraphsOf("v0922-fixture", { dataDir: TMP_HOME, mode: "full", limit: 10000 });
    const notes = snap.graphs.module_map?.notes ?? [];
    ok(snap.graphs.module_map?.counts.underlying_nodes === 3, `C5 夹具项目读出（module_map 底层节点 ${snap.graphs.module_map?.counts.underlying_nodes}）`);
    ok(notes.some((n) => n.includes("采集侧不完整") && n.includes("budget_exhausted")), "C5 budget_exhausted=true ⇒ module_map notes 含「采集侧不完整」");
    ok(notes.some((n) => n.includes("规则忽略目录")), "C5 常驻：忽略目录标注条在场（规则性排除，不是遗漏）");
    ok(notes.some((n) => n.includes("origin:chat")), "C5 存在补全节点 ⇒ origin:chat 待审线索标注条在场");
  }

  section("C5b. 稳定快照夹具上的 cursor 续取契约（同快照分页，确定性）");
  {
    // 有已发布规划图 ⇒ 快照标识固定 ⇒ 同快照 cursor 续取可用（草稿态工程不可用，见 C1）。
    const TMP_HOME = mkTmp("home-stable");
    const projDir = mkTmp("proj-stable");
    const archDir = path.join(projDir, ".工作台", "arch");
    fs.mkdirSync(archDir, { recursive: true });
    const mods = [
      { id: "alpha", name: "", path: "alpha", file_count: 5, loc: 0, deps: [{ to: "beta", weight: 2 }] },
      { id: "beta", name: "", path: "beta", file_count: 3, loc: 0, deps: [] },
    ];
    fs.writeFileSync(path.join(archDir, "modules.json"), JSON.stringify({ version: 1, generated_at: "2026-01-01T00:00:00+08:00", budget_exhausted: false, modules: mods }), "utf8");
    const bpFixture = {
      version: 1,
      baseline_id: "bl-fixture",
      generator_version: "verify-v09-22",
      generated_at: "2026-01-01T00:00:00+08:00",
      source_manifest: [],
      nodes: [{ id: "plan:cap:01", kind: "capability", name: "夹具能力", source_refs: [], related_ids: [] }],
      edges: [],
      coverage: { design_sections: { total: 0, mapped: 0, unmapped: [] }, plan_tasks: { total: 0, mapped: 0, unmapped: [] }, code_modules: { total: 2, mapped: 2, unmapped: [] }, nodes_total: 1, nodes_kept: 1, edges_total: 0, edges_kept: 0, note: "验证夹具" },
      omitted: [],
      model_receipt: null,
      publish: { published: true, reason: null, validated_at: "2026-01-01T00:00:00+08:00" },
      based_on: { model_key: "fx", full_key: "fx", design_content_sha256: null, plan_definition_sha256: null, semantic: false },
    };
    fs.writeFileSync(path.join(archDir, "blueprint.json"), JSON.stringify(bpFixture), "utf8");
    addProject({ id: "v0922-stable", name: "V09-22 稳定快照夹具", path: projDir, kind: "backend" }, TMP_HOME);
    const one = sixGraphsOf("v0922-stable", { dataDir: TMP_HOME, mode: "full", limit: 100000 });
    ok(one.graph_state.availability === "published", `C5b 夹具快照稳定（availability=${one.graph_state.availability}）`);
    const pages = collectGraph("v0922-stable", "full", 2, "module_map", TMP_HOME);
    const union = new Set(pages.flatMap((pg) => pg.nodes.map((n) => n.id)));
    const oneIds = (one.graphs.module_map?.nodes ?? []).map((n) => n.id);
    ok(pages.length > 1, `C5b limit=2 触发分页（${pages.length} 页）`);
    ok(union.size === oneIds.length && oneIds.every((id) => union.has(id)), `C5b 逐页续取并集 ${union.size} === 一次全量 ${oneIds.length}（同快照 cursor 续取可用）`);
  }

  section("C6. 计时输出（80/1000/2500 夹具 + 两真实项目 full 构建）");
  {
    for (const n of [80, 1000, 2500]) {
      const mods = makeModules(n, true);
      const t0 = Date.now();
      const g = buildSharedGraphFrom(mods, {}, new Map(), MCP_FULL_LIMITS);
      const ms = Date.now() - t0;
      info(`C6 夹具 n=${n} full 构建 ${ms} ms（节点 ${g.nodes.length}、边 ${g.edges.length}）`);
      ok(ms >= 0, `C6 夹具 n=${n} full 构建耗时打印（${ms} ms）`);
    }
    for (const p of realProjects) {
      const t0 = Date.now();
      const mg = viewGraphWithPlan(p.id, { limits: MCP_FULL_LIMITS });
      const ms = Date.now() - t0;
      info(`C6 真实项目 ${p.id} full 构建 ${ms} ms（节点 ${mg.graph.nodes.length}、边 ${mg.graph.edges.length}）`);
      ok(mg.graph.nodes.length > 0, `C6 真实项目 ${p.id} full 构建耗时打印（${ms} ms）`);
    }
  }

  // ═════════════════════ D. 兼容回归 ═════════════════════
  section("D. 不带新参数的兼容回归（概览语义数值不变）");
  {
    const items = Array.from({ length: 16 }, (_, i) => i);
    const c = capOverview(items, { unit: "分组" });
    ok(c.shown.length === ARCH_LIMITS.MAX_NODES && c.hidden_count === 1 && c.aggregate !== null, `D capOverview 默认：shown=${c.shown.length}、hidden=${c.hidden_count}、聚合非空`);
    const kids = Array.from({ length: 45 }, (_, i) => ({ name: `c${i}` }));
    const cc = capChildren(kids, "p");
    ok(cc.kept.length === ARCH_LIMITS.MAX_CHILDREN - 1 && cc.dropped === 6 && cc.truncated === true, `D capChildren 默认：kept=${cc.kept.length}、dropped=${cc.dropped}、truncated=${cc.truncated}`);
    const g16 = buildSharedGraphFrom(makeModules(16), {});
    ok(g16.limits.MAX_NODES === ARCH_LIMITS.MAX_NODES && g16.nodes.length === 15 && g16.nodes.some((n) => n.id === MORE_NODE_ID), "D buildSharedGraphFrom 默认：15 节点上限 + __more__ 聚合照旧");
    ok(!Object.prototype.hasOwnProperty.call(g16, "mode"), "D SharedGraph 无 mode 字段泄漏（旧路径逐字不变）");
    // sixGraphsOf 缺省 = overview：mode 字段是新增字段（JSON 序列化多一个键属预期），概览计数不变
    const p = realProjects[0];
    const snap = sixGraphsOf(p.id, {});
    ok(snap.graphs.module_map?.mode === "overview", "D sixGraphsOf 缺省 mode=overview（新增字段，语义不变）");
    const mm = snap.graphs.module_map!;
    // 2026-09-29 勘误（数据时点漂移）：旧断言「本页节点 ≤15」在 realProjects[0] 无规划层时碰巧成立；
    // 规划层（plan_origin:"plan"）并入发生在 §4.3 上限之后、不被 15 裁（V09-20 以来既有行为，
    // Codex 复核 2026-09-29 确认：塔台 80＝8 代码＋72 规划）。定向更新：上限照旧约束的是**代码层**。
    const mmCode = mm.nodes.filter((n) => n.origin_layer === undefined || n.origin_layer === "code").length;
    ok(
      mmCode <= ARCH_LIMITS.MAX_NODES,
      `D 概览 module_map 代码层节点 ${mmCode} ≤ ${ARCH_LIMITS.MAX_NODES}（上限照旧；规划层并入不受代码层上限裁，本页总节点 ${mm.counts.nodes}）`,
    );
    const mmByOrigin = mm.counts.by_origin;
    const recount = { code: 0, plan: 0, chat: 0 };
    // 沿革（2026-10-04 test-repair 定向修正）：既有 F4 契约（src/arch/sixGraphs.ts byOriginOf）明确
    // 「__more__ 聚合占位不冒充实体」，counts.by_origin 不计聚合占位，本脚本 R-F4 也严格钉住该口径。
    // 本段旧复算却按 origin_layer 静态相加，一旦代码层 >15（如合成夹具 synth-alpha 240 模块，概览
    // 14 真实＋1 聚合）就会把聚合占位当成代码模块数进去，与 R-F4 自相矛盾。此处按同一 F4 口径过滤
    // aggregate===true；每个来源层的精确相等断言与其余检查一律保留，不缩强度。
    for (const n of mm.nodes) {
      if (n.aggregate === true) continue;
      recount[(n.origin_layer ?? "code") as "code" | "plan" | "chat"] += 1;
    }
    ok(
      mmByOrigin !== undefined && mmByOrigin.code === recount.code && mmByOrigin.plan === recount.plan && mmByOrigin.chat === recount.chat,
      `D 概览 module_map counts.by_origin 逐节点可复算（code=${mmByOrigin?.code}/${recount.code}、plan=${mmByOrigin?.plan}/${recount.plan}、chat=${mmByOrigin?.chat}/${recount.chat}）`,
    );
  }

  // ═════════════════════ G. 上限外逐项取回（V09-22 返工，终态契约 1/2/3） ═════════════════════
  section("G. 上限外逐项取回（archItemsOf / childrenOffset / sixGraphsOf full / 扇出）");
  {
    // ── G1. 2001 模块：渲染安全上限保留 + archItemsOf 逐项取回 ──
    const N1 = 2001;
    const g1mods = makeSeqModules(N1);
    const g1 = makeTmpProject("g1", "v0922-g1", {
      ".工作台/arch/modules.json": { version: 1, generated_at: new Date().toISOString(), budget_exhausted: false, modules: g1mods },
    });
    const rg = renderGraph("v0922-g1", { dataDir: g1.home, limits: RENDER_FULL_LIMITS });
    const rgGraph = rg.graph;
    // 注：施工卡此处写 `truncated.nodes===1`，与现行（须保留的）渲染上限口径冲突——
    // 现行口径保留 `MAX_NODES-1` 个真实节点 + 1 个「还有 N 个」聚合，故 2001 模块截断量 = 2001-(2000-1) = 2。
    // 按现行口径断言（不降强度），卡上数值差异登记在报告里。
    const g1drop = N1 - (RENDER_FULL_LIMITS.MAX_NODES - 1);
    ok(
      rg.exists && rgGraph !== undefined && rgGraph.nodes.length === RENDER_FULL_LIMITS.MAX_NODES && rgGraph.nodes.some((n) => n.aggregate === true),
      `G1a renderGraph RENDER_FULL：本页 ${rgGraph?.nodes.length ?? 0} 节点（=上限 ${RENDER_FULL_LIMITS.MAX_NODES}）、含聚合节点（安全上限保留）`,
    );
    ok(rgGraph?.truncated.nodes === g1drop, `G1a renderGraph RENDER_FULL：truncated.nodes=${rgGraph?.truncated.nodes}（期望 ${g1drop}，卡面写 1 与现行 MAX_NODES-1 口径冲突，按现行口径）`);
    ok(rgGraph !== undefined && !rgGraph.nodes.some((n) => n.id === "n2001"), "G1a renderGraph RENDER_FULL：n2001 不在本页（被上限聚合）");

    const archMod = await tryImport<{ archItemsOf?: (projectId: string, opts: unknown) => unknown }>("../src/arch/items");
    const archItemsOf = archMod?.archItemsOf;
    if (typeof archItemsOf !== "function") {
      ok(false, "G1b archItemsOf 契约未实现（修前红）：src/arch/items.ts 未导出 archItemsOf");
    } else {
      type ItemsRes = { total: number; offset: number; returned: number; has_more: boolean; nodes?: { id: string }[]; edges?: { from: string; to: string }[] };
      const collectItems = (q?: string): string[] => {
        const ids: string[] = [];
        let offset = 0;
        let guard = 0;
        for (;;) {
          const page = archItemsOf("v0922-g1", { dataDir: g1.home, kind: "nodes", q, offset, limit: 500 }) as ItemsRes;
          for (const n of page.nodes ?? []) ids.push(n.id);
          if (page.has_more !== true || guard++ > 20) break;
          offset += page.returned;
        }
        return ids;
      };
      const allIds = collectItems();
      const srcIds = new Set(g1mods.map((m) => m.id));
      const noDup = new Set(allIds).size === allIds.length;
      ok(noDup && allIds.length === N1 && allIds.every((id) => srcIds.has(id)), `G1b archItemsOf kind=nodes 逐页走完：${allIds.length} 个 id 无漏无重（=夹具 ${N1}）`);
      const hit = archItemsOf("v0922-g1", { dataDir: g1.home, kind: "nodes", q: "n2001", limit: 500 }) as ItemsRes;
      ok((hit.total ?? -1) === 1 && (hit.nodes ?? []).length === 1, `G1b archItemsOf q=n2001：恰 1 命中（total=${hit.total}）`);
      const none = archItemsOf("v0922-g1", { dataDir: g1.home, kind: "nodes", q: "zzz_nothing", limit: 500 }) as ItemsRes;
      ok((none.total ?? -1) === 0 && (none.nodes ?? []).length === 0, `G1b archItemsOf q=zzz_nothing：0 命中且 total=0（total=${none.total}）`);
    }

    // ── G2. 2001 直接子级：概览上限现状 + childrenOffset 稳定分页（终态契约 2） ──
    const g2root = mkTmp("g2dir");
    for (let i = 0; i < N1; i++) fs.writeFileSync(path.join(g2root, `part-${String(i).padStart(4, "0")}.txt`), "x", "utf8");
    const g2def = expandDirectory(g2root, ".");
    ok(
      g2def.children.length === ARCH_LIMITS.MAX_CHILDREN && g2def.truncated.children === N1 - (ARCH_LIMITS.MAX_CHILDREN - 1),
      `G2 缺省调用＝现状：本页 ${g2def.children.length} 子级（保留 ${ARCH_LIMITS.MAX_CHILDREN - 1}+聚合 1）、truncated.children=${g2def.truncated.children}（期望 ${N1 - (ARCH_LIMITS.MAX_CHILDREN - 1)},按 40 上限现行值）`,
    );
    const g2cap = expandDirectory(g2root, ".", { childrenLimit: 2000 });
    ok(
      g2cap.children.length === 2000 && g2cap.truncated.children === N1 - (2000 - 1),
      `G2 childrenLimit=2000 不带 offset：${g2cap.children.length} 子级（=2000）、truncated.children=${g2cap.truncated.children}（期望 ${N1 - (2000 - 1)},卡面写 1 与现行 MAX_CHILDREN-1 口径冲突）`,
    );
    type OffsetChild = { id: string; kind: string };
    type OffsetRes = { children: OffsetChild[]; children_total?: number; children_offset?: number; children_returned?: number; children_has_more?: boolean };
    type OffsetOpts = { childrenLimit?: number; childrenOffset?: number };
    const pg0 = expandDirectory(g2root, ".", { childrenLimit: 700, childrenOffset: 0 } as unknown as OffsetOpts) as unknown as OffsetRes;
    if (pg0.children_total === undefined) {
      ok(false, "G2 childrenOffset 契约未实现（修前红）：返回体无 children_total（现状逐字节不变＝无此字段）");
    } else {
      const srcKids = new Set(
        expandDirectory(g2root, ".", { childrenLimit: 5000 }).children.filter((c) => c.kind !== "aggregate").map((c) => c.id),
      );
      const ids: string[] = [];
      let off = 0;
      let hasMore = true;
      let lastTotal = -1;
      let guard = 0;
      while (hasMore && guard++ < 10) {
        const pg = expandDirectory(g2root, ".", { childrenLimit: 700, childrenOffset: off } as unknown as OffsetOpts) as unknown as OffsetRes;
        for (const c of pg.children) if (c.kind !== "aggregate") ids.push(c.id);
        lastTotal = pg.children_total ?? -1;
        hasMore = pg.children_has_more === true;
        off = (pg.children_offset ?? off) + (pg.children_returned ?? 0);
        if ((pg.children_returned ?? 0) === 0) break;
      }
      ok(new Set(ids).size === ids.length && ids.length === srcKids.size && ids.every((id) => srcKids.has(id)), `G2 childrenOffset 700/页 走完：${ids.length} 个子级无漏无重（=夹具 ${srcKids.size}）`);
      ok(lastTotal === N1, `G2 childrenOffset：children_total=${lastTotal}（期望 ${N1}）`);
      ok(hasMore === false, "G2 childrenOffset：末页 children_has_more=false");
    }

    // ── G3. 20001 模块 + 41000 条唯一依赖边：full 逐页取完未聚合候选（终态契约 3） ──
    const N3 = 20001;
    const EDGES3 = 41000;
    const g3fix = makeEdgeFixture(N3, EDGES3);
    ok(g3fix.pairs.size === EDGES3, `G3 夹具唯一依赖边对数=${g3fix.pairs.size}（期望 ${EDGES3}，无重复对）`);
    // 空节点**已发布**蓝图只为了让快照标识稳定（无它则草稿 generated_at 每次现取 ⇒ 跨调用游标被拒，
    // 影响的是「跨调用续取」而不是本段要测的「full 是否解除上限」；空蓝图不新增任何 plan 节点）。
    const g3Blueprint = {
      version: 1, baseline_id: "bl-g3", generator_version: "verify-v09-22", generated_at: "2026-01-01T00:00:00+08:00",
      source_manifest: [], nodes: [], edges: [],
      coverage: { design_sections: { total: 0, mapped: 0, unmapped: [] }, plan_tasks: { total: 0, mapped: 0, unmapped: [] }, code_modules: { total: N3, mapped: 0, unmapped: [] }, nodes_total: 0, nodes_kept: 0, edges_total: 0, edges_kept: 0, note: "验证夹具（空规划层，仅稳定快照）" },
      omitted: [], model_receipt: null,
      publish: { published: true, reason: null, validated_at: "2026-01-01T00:00:00+08:00" },
      based_on: { model_key: "fx", full_key: "fx", design_content_sha256: null, plan_definition_sha256: null, semantic: false },
    };
    const g3 = makeTmpProject("g3", "v0922-g3", {
      ".工作台/arch/modules.json": { version: 1, generated_at: new Date().toISOString(), budget_exhausted: false, modules: g3fix.mods },
      ".工作台/arch/blueprint.json": g3Blueprint,
    });
    const pages3 = collectGraph("v0922-g3", "full", 3000, "module_map", g3.home);
    const nodeIds3: string[] = [];
    const edgePairs3 = new Set<string>();
    for (const pg of pages3) {
      for (const n of pg.nodes) nodeIds3.push(n.id);
      for (const e of pg.edges) edgePairs3.add(`${e.from}>${e.to}`);
    }
    const src3 = new Set(g3fix.mods.map((m) => m.id));
    const nodeSet3 = new Set(nodeIds3);
    ok(new Set(nodeIds3).size === nodeIds3.length && nodeIds3.length === N3 && nodeIds3.every((id) => src3.has(id)), `G3 full 逐页取完节点：${nodeIds3.length} 个 id 无漏无重（=夹具 ${N3}）`);
    ok(edgePairs3.size === EDGES3, `G3 full 逐页取完边：${edgePairs3.size} 条（=夹具 ${EDGES3}，无重复）`);
    const dangling3 = [...edgePairs3].filter((p) => {
      const [f, t] = p.split(">");
      return !nodeSet3.has(f) || !nodeSet3.has(t);
    });
    ok(dangling3.length === 0, `G3 full：每条边两端都在节点全集内（悬空 ${dangling3.length} 条）`);
    const full3counts = sixGraphsOf("v0922-g3", { dataDir: g3.home, mode: "full", limit: 1, graph: "module_map" }).graphs.module_map!.counts;
    ok(full3counts.underlying_nodes === N3, `G3 full counts.underlying_nodes=${full3counts.underlying_nodes}（期望 ${N3}）`);
    let ov3Err: string | null = null;
    let ov3: { counts: { hidden_members: number; aggregate_node: boolean } } | undefined;
    try {
      ov3 = sixGraphsOf("v0922-g3", { dataDir: g3.home, mode: "overview", graph: "module_map" }).graphs.module_map!;
    } catch (e) {
      ov3Err = (e as Error).message;
    }
    ok(
      ov3Err === null && ov3 !== undefined && ov3.counts.hidden_members > 0 && ov3.counts.aggregate_node === true,
      `G3 概览同夹具：仍聚合并如实计数（hidden_members=${ov3?.counts.hidden_members}）、不抛错`,
    );

    // ── G4. 扇出夹具（10 模块，hub 收 9 条入边）：概览只记 layers，全量全部在场 ──
    const g4mods: SharedModuleInput[] = [
      { id: "hub", path: "hub", file_count: 20, deps: [] },
      ...Array.from({ length: 9 }, (_, i) => ({ id: `m${i + 1}`, path: `m${i + 1}`, file_count: 10 - i, deps: [{ to: "hub", weight: 1 }] })),
    ];
    const g4 = buildSharedGraphFrom(g4mods, {});
    ok(g4.truncated.nodes === 0 && g4.truncated.edges === 0, `G4 概览：truncated.nodes=${g4.truncated.nodes}、truncated.edges=${g4.truncated.edges}（10 模块未触节点/边上限）`);
    ok(g4.truncated.layers?.parse.fanout === 9 - ARCH_LIMITS.FANOUT_KEEP, `G4 概览：layers.parse.fanout=${g4.truncated.layers?.parse.fanout}（期望 4，现行契约扇出只记 layers）`);
    const g4in = g4.edges.filter((e) => e.to === "hub");
    ok(g4in.length === ARCH_LIMITS.FANOUT_KEEP, `G4 概览：可见入边 ${g4in.length} 条（=FANOUT_KEEP ${ARCH_LIMITS.FANOUT_KEEP}）`);
    const g4full = buildSharedGraphFrom(g4mods, {}, new Map(), RENDER_FULL_LIMITS);
    const g4fullIn = g4full.edges.filter((e) => e.to === "hub").map((e) => e.from).sort();
    ok(g4fullIn.length === 9 && g4fullIn.join(",") === ["m1","m2","m3","m4","m5","m6","m7","m8","m9"].join(","), `G4 全量：9 条入边全部在场（${g4fullIn.join("、")}）`);
  }

  // ═════════════════════ H. 游标模式绑定（终态契约 4） ═════════════════════
  section("H. 游标模式绑定（概览↔full 跨模式拒绝、旧三段兼容）");
  {
    const hMods = makeSeqModules(30);
    const hBlueprint = {
      version: 1,
      baseline_id: "bl-h",
      generator_version: "verify-v09-22",
      generated_at: "2026-01-01T00:00:00+08:00",
      source_manifest: [],
      nodes: [{ id: "plan:cap:01", kind: "capability", name: "夹具能力", source_refs: [], related_ids: [] }],
      edges: [],
      coverage: { design_sections: { total: 0, mapped: 0, unmapped: [] }, plan_tasks: { total: 0, mapped: 0, unmapped: [] }, code_modules: { total: 30, mapped: 30, unmapped: [] }, nodes_total: 1, nodes_kept: 1, edges_total: 0, edges_kept: 0, note: "验证夹具" },
      omitted: [],
      model_receipt: null,
      publish: { published: true, reason: null, validated_at: "2026-01-01T00:00:00+08:00" },
      based_on: { model_key: "fx", full_key: "fx", design_content_sha256: null, plan_definition_sha256: null, semantic: false },
    };
    const h = makeTmpProject("h", "v0922-h", {
      ".工作台/arch/modules.json": { version: 1, generated_at: new Date().toISOString(), budget_exhausted: false, modules: hMods },
      ".工作台/arch/blueprint.json": hBlueprint,
    });
    const ov1 = sixGraphsOf("v0922-h", { dataDir: h.home, mode: "overview", limit: 12, graph: "module_map" });
    const ovCursor = ov1.completeness.cursors.module_map;
    ok(typeof ovCursor === "string", `H 概览首屏给出游标（${ovCursor ?? "(无)"}，快照稳定）`);
    // H1 概览游标 → full：被拒且点名模式
    let h1err: string | null = null;
    try {
      sixGraphsOf("v0922-h", { dataDir: h.home, mode: "full", limit: 12, graph: "module_map", cursor: ovCursor });
    } catch (e) {
      h1err = (e as Error).message;
    }
    ok(h1err !== null && h1err.includes("模式"), `H1 概览游标传给 full：被拒且错误点名「模式」（修前：会被接受＝红；实际 ${h1err === null ? "未拒绝" : h1err.slice(0, 50)}）`);
    // 造四段游标：把「快照:图:偏移」扩成「快照:模式:图:偏移」
    const full1 = sixGraphsOf("v0922-h", { dataDir: h.home, mode: "full", limit: 12, graph: "module_map" });
    const fullCursor = full1.completeness.cursors.module_map;
    ok(typeof fullCursor === "string", `H full 首屏给出游标（${fullCursor ?? "(无)"}）`);
    const seg = typeof fullCursor === "string" ? fullCursor.split(":") : [];
    const fourSeg = seg.length === 3 ? `${seg[0]}:full:${seg[1]}:${seg[2]}` : (fullCursor ?? "");
    // H2 full 四段游标 → 概览：被拒且点名模式
    let h2err: string | null = null;
    try {
      sixGraphsOf("v0922-h", { dataDir: h.home, mode: "overview", graph: "module_map", cursor: fourSeg });
    } catch (e) {
      h2err = (e as Error).message;
    }
    ok(h2err !== null && h2err.includes("模式"), `H2 full 四段游标传给概览：被拒且错误点名「模式」（实际 ${h2err === null ? "未拒绝" : h2err.slice(0, 50)}）`);
    // H3 旧三段概览游标 → 概览：继续可用（兼容）
    let h3ok = false;
    try {
      const r3 = sixGraphsOf("v0922-h", { dataDir: h.home, mode: "overview", graph: "module_map", cursor: ovCursor });
      h3ok = r3.graphs.module_map !== undefined;
    } catch {
      h3ok = false;
    }
    ok(h3ok, "H3 旧三段概览游标在概览续取：继续可用（兼容）");
    // H4 full 四段/同快照游标续取两页：第二页与第一页无重叠、offset 前进
    let h4ok = false;
    try {
      const p2 = sixGraphsOf("v0922-h", { dataDir: h.home, mode: "full", graph: "module_map", cursor: fullCursor });
      const set1 = new Set((full1.graphs.module_map?.nodes ?? []).map((n) => n.id));
      const overlap = (p2.graphs.module_map?.nodes ?? []).filter((n) => set1.has(n.id)).length;
      h4ok = p2.graphs.module_map !== undefined && overlap === 0;
      if (!h4ok) info(`H4 诊断：第二页节点 ${p2.graphs.module_map?.nodes.length ?? 0}、与第一页重叠 ${overlap}`);
    } catch (e) {
      info(`H4 续取抛错：${(e as Error).message.slice(0, 80)}`);
    }
    ok(h4ok, "H4 full 续取两页：第二页与第一页无重叠（offset 前进）");
  }

  // ═════════════════════ I. 草稿快照稳定（终态契约 5） ═════════════════════
  section("I. 草稿快照稳定（跨 1.3s 续取不漂移、输入变则 snapshot 变）");
  {
    const N_I = 30;
    const iMods = makeSeqModules(N_I);
    // 无已发布蓝图（blueprint.json 缺席）⇒ draft_only：草稿 generated_at 每次现取 nowIso()，
    // 正是「1.3s 后 snapshot 漂移、第二页被拒」的红现场。
    const i = makeTmpProject("i", "v0922-i", {
      ".工作台/arch/modules.json": { version: 1, generated_at: new Date().toISOString(), budget_exhausted: false, modules: iMods },
    });
    const first = sixGraphsOf("v0922-i", { dataDir: i.home, mode: "full", limit: 2, graph: "module_map" });
    const sid0 = first.snapshot_id;
    const pageSids = new Set<string>([sid0]);
    const idsI: string[] = (first.graphs.module_map?.nodes ?? []).map((n) => n.id);
    let cursor: string | null = first.completeness.cursors.module_map ?? null;
    let rejected: string | null = null;
    let guard = 0;
    let pagesI = 1; // 已成功取到的页数（首屏算 1）
    while (cursor !== null && guard++ < 60) {
      if (guard <= 2) await sleep(1300); // 第 1→2 页、2→3 页之间各等 1.3s
      try {
        const nxt = sixGraphsOf("v0922-i", { dataDir: i.home, mode: "full", limit: 2, graph: "module_map", cursor });
        pagesI += 1;
        pageSids.add(nxt.snapshot_id);
        for (const n of nxt.graphs.module_map?.nodes ?? []) idsI.push(n.id);
        cursor = nxt.completeness.cursors.module_map ?? null;
      } catch (e) {
        rejected = (e as Error).message;
        break;
      }
    }
    info(`I 诊断：成功取到 ${pagesI} 页；pageSids=${[...pageSids].join(",")}；续取${rejected === null ? "未被拒" : `被拒：${rejected.slice(0, 60)}`}`);
    ok(rejected === null, `I 草稿快照稳定：跨 1.3s 续取未被拒（修前：snapshot 漂移、第二页被拒＝红）`);
    ok(pagesI >= 2 && pageSids.size === 1, `I 至少跨 2 页且全部页 snapshot_id 相同（实际 ${pagesI} 页 / ${pageSids.size} 个 snapshot）`);
    const srcI = new Set(iMods.map((m) => m.id));
    ok(new Set(idsI).size === idsI.length && idsI.length > 0 && [...srcI].every((id) => new Set(idsI).has(id)), `I ${N_I} 个模块 id 无漏无重（收集 ${idsI.length}）`);
    ok(rejected === null && cursor === null, "I 末页 complete=true（游标取尽）");
    // ── 输入变更 → snapshot 变、旧游标拒（终态契约 5 第二条） ──
    const modsPath = path.join(i.dir, ".工作台", "arch", "modules.json");
    const before = sixGraphsOf("v0922-i", { dataDir: i.home, mode: "full", limit: 2, graph: "module_map" }).snapshot_id;
    const modsObj = JSON.parse(fs.readFileSync(modsPath, "utf8")) as { modules: SharedModuleInput[] };
    modsObj.modules.push({ id: "n0031", path: "n0031", file_count: 0, deps: [] });
    fs.writeFileSync(modsPath, JSON.stringify(modsObj), "utf8");
    const after = sixGraphsOf("v0922-i", { dataDir: i.home, mode: "full", limit: 2, graph: "module_map" }).snapshot_id;
    ok(after !== before, `I modules.json 内容变化 → snapshot_id 变化（${before} → ${after}）`);
    let oldRejected: string | null = null;
    try {
      sixGraphsOf("v0922-i", { dataDir: i.home, mode: "full", limit: 2, graph: "module_map", cursor: first.completeness.cursors.module_map ?? `${sid0}:module_map:2` });
    } catch (e) {
      oldRejected = (e as Error).message;
    }
    ok(oldRejected !== null, `I 拿旧 snapshot 游标续取被拒（来源真变必拒；实际 ${oldRejected === null ? "未拒绝" : oldRejected.slice(0, 50)}）`);
  }

  // ═════════════════════ K. 采集层无损化与读侧标注（2026-09-29 六图完整读取轮） ═════════════════════
  section("K. 采集层无损化（真实目录扫描 >15 候选）＋旧桶标注＋full 引导");
  {
    // ── K1. 真实目录扫描：20 个顶层目录 → parseDirectory → 全部候选保留 ──
    // 修前红（Codex 复核 2026-09-29 独立确认）：旧 mergeOverflow 会给 15 个模块＝14 真实＋1 个
    // 「其他:…」桶（原始身份丢失、full 不可恢复）。本轮起采集层保留全部候选，15 上限只在概览投影层。
    const scanDir = mkTmp("k1-scan");
    const TOPS = 20;
    for (let i = 1; i <= TOPS; i++) {
      const top = path.join(scanDir, `mod${String(i).padStart(2, "0")}`);
      fs.mkdirSync(top, { recursive: true });
      const prev = `mod${String(i - 1).padStart(2, "0")}`;
      fs.writeFileSync(
        path.join(top, "a.ts"),
        i > 1 ? `import { x } from "../${prev}/a";\nexport const a = ${i};\n` : `export const a = ${i};\n`,
        "utf8",
      );
      fs.writeFileSync(path.join(top, "b.ts"), `export const b = ${i};\n`, "utf8");
    }
    const parsed = parseDirectory(scanDir);
    const modsK = parsed.file.modules;
    ok(modsK.length === TOPS, `K1 真实目录扫描：${TOPS} 个顶层目录 → ${modsK.length} 个模块全保留（修前红：14＋「其他」桶＝15）`);
    ok(!modsK.some((m) => m.id === "other" || m.path.startsWith("其他:")), "K1 无「其他」有损聚合桶（原始候选逐个在场）");
    ok(parsed.file.budget_exhausted === false, "K1 预算未耗尽（小夹具不该残缺；预算/忽略目录口径未动）");
    ok(modsK.every((m) => m.id === slugify(m.path)), "K1 模块 id＝slugify(前缀)（稳定身份）");
    const edgeTotal = modsK.reduce((n, m) => n + m.deps.length, 0);
    ok(edgeTotal === TOPS - 1, `K1 跨目录 import 聚合为 ${edgeTotal} 条模块间边（期望 ${TOPS - 1}：原始对象与关系都可取齐）`);
    // 概览投影层上限仍在（14＋__more__）；RENDER_FULL 全给——「15 限制放概览层」的两侧证据
    const gOverview = buildSharedGraphFrom(modsK, {});
    ok(
      gOverview.nodes.length === ARCH_LIMITS.MAX_NODES &&
        gOverview.nodes.some((n) => n.id === MORE_NODE_ID) &&
        gOverview.truncated.nodes === TOPS - (ARCH_LIMITS.MAX_NODES - 1),
      `K1 概览投影：15 节点（14＋__more__）、隐藏 ${gOverview.truncated.nodes}（上限移到概览层，不消失）`,
    );
    const gFull = buildSharedGraphFrom(modsK, {}, new Map(), RENDER_FULL_LIMITS);
    ok(gFull.nodes.length === TOPS && !gFull.nodes.some((n) => n.aggregate === true), `K1 全量上限：${gFull.nodes.length} 节点全给（无聚合）`);

    // ── K2. 落盘→注册→读回：六图 full 与 archItemsOf 都取得到全部 20 个 ──
    const k2 = makeTmpProject("k2", "v0922-k2", {
      ".工作台/arch/modules.json": parsed.file,
    });
    const snapK2 = sixGraphsOf("v0922-k2", { dataDir: k2.home, mode: "full" });
    const mmK2 = snapK2.graphs.module_map!;
    ok(mmK2.counts.underlying_nodes >= TOPS, `K2 六图 full：底层候选 ${mmK2.counts.underlying_nodes} ≥ ${TOPS}（未聚合并集含全部采集模块）`);
    const archItemsK = await tryImport<{ archItemsOf?: (projectId: string, opts: { dataDir?: string; kind: "nodes" | "edges"; limit?: number }) => { total: number } }>("../src/arch/items");
    const itemsK2 = archItemsK?.archItemsOf?.("v0922-k2", { dataDir: k2.home, kind: "nodes", limit: 200 });
    ok(itemsK2 !== undefined && itemsK2.total >= TOPS, `K2 archItemsOf 未聚合并集 ${itemsK2?.total ?? "（取不到）"} ≥ ${TOPS}`);
    const snapOv = sixGraphsOf("v0922-k2", { dataDir: k2.home, mode: "overview" });
    ok(
      (snapOv.graphs.module_map?.counts.hidden_members ?? 0) === TOPS - (ARCH_LIMITS.MAX_NODES - 1),
      `K2 概览隐藏量 ${snapOv.graphs.module_map?.counts.hidden_members}（＝20−14，如实计数）`,
    );

    // ── K3. 旧「其他」桶数据：识别＋标注（不默认完整、不丢证据绑定） ──
    // 真实旧落盘形状（Codex 审验：旧 mergeOverflow 落盘是 id:"other"、path 为逗号前缀列表，
    // **不带**「其他:」前缀——那前缀只在旧内存候选里、从不落盘）。
    const k3 = makeTmpProject("k3", "v0922-k3", {
      ".工作台/arch/modules.json": {
        version: 1,
        generated_at: "2026-09-01T00:00:00.000Z",
        budget_exhausted: false,
        modules: [
          { id: "src-arch", name: "", path: "src/arch", file_count: 10, loc: 100, deps: [] },
          { id: "other", name: "", path: "docs,scripts,tests,tools,examples,vendor", file_count: 30, loc: 300, deps: [] },
        ],
      },
    });
    const legacyInfo = legacyAggregationOf(readModules("v0922-k3", k3.home).arch);
    ok(
      legacyInfo.has_legacy_other && legacyInfo.merged_prefixes === 6,
      `K3 旧桶识别：has_legacy_other=${legacyInfo.has_legacy_other}、merged_prefixes=${legacyInfo.merged_prefixes}（期望 6）`,
    );
    // 人工/夹具变体兼容：path 直接带「其他:」前缀（旧内存候选形状；真实落盘不带，读侧一并兼容）
    const k3v = makeTmpProject("k3v", "v0922-k3v", {
      ".工作台/arch/modules.json": {
        version: 1,
        generated_at: "2026-09-01T00:00:00.000Z",
        budget_exhausted: false,
        modules: [{ id: "other", name: "", path: "其他:docs,scripts", file_count: 4, loc: 4, deps: [] }],
      },
    });
    const k3vInfo = legacyAggregationOf(readModules("v0922-k3v", k3v.home).arch);
    ok(
      k3vInfo.has_legacy_other && k3vInfo.merged_prefixes === 2,
      `K3 人工变体（path 带「其他:」前缀）：has_legacy_other=${k3vInfo.has_legacy_other}、merged_prefixes=${k3vInfo.merged_prefixes}（期望 true/2）`,
    );
    const snapK3 = sixGraphsOf("v0922-k3", { dataDir: k3.home });
    ok(
      snapK3.anomalies.some((a) => a.includes("「其他」") && a.includes("重跑解析")),
      `K3 六图读口把旧桶标进 anomalies（不默认完整；anomalies ${snapK3.anomalies.length} 条）`,
    );
    ok(
      (snapK3.graphs.module_map?.notes ?? []).some((n) => n.includes("不完整")),
      "K3 module_map notes 点名模块层不完整＋重跑解析入口",
    );

    // ── K4. next_read_entry 引导 full（接续入口的推荐下一读取） ──
    const nre = snapK2.next_read_entry;
    ok(
      nre.tool === "get_project_graphs" && (nre.args as { mode?: string }).mode === "full",
      `K4 next_read_entry 指向 mode=full（args=${JSON.stringify(nre.args)}）`,
    );
    ok(nre.note.includes("complete"), "K4 note 区分「图对象取完」≠「源码全覆盖」");
    ok(nre.note.includes("cursors") && nre.note.includes("续取"), "K4 note 给逐图续取方法（cursors[<graphKey>]＋graph＋mode）");

    // ── K5. by_origin 分层计数（真实项目：已发布蓝图 ⇒ plan>0、code>0；不写死时点值） ──
    const tataiSnap = sixGraphsOf("tatai", { mode: "overview" });
    const bo = tataiSnap.graphs.module_map?.counts.by_origin;
    ok(
      bo !== undefined && bo.code > 0 && bo.plan > 0,
      `K5 塔台 by_origin 分层可读（code=${bo?.code}、plan=${bo?.plan}、chat=${bo?.chat}——「节点总数」≠「代码模块数」）`,
    );
    ok(
      (tataiSnap.graphs.module_map?.nodes ?? []).length > 0 && tataiSnap.graphs.module_map!.nodes.every((n) => n.origin_layer !== undefined),
      "K5 技术图逐节点带 origin_layer（Agent 可机械分层）",
    );
  }

  // ═════════════════════ R. 2026-09-29 返工回归（F2/F3/F4/F5） ═════════════════════
  section("R. 2026-09-29 返工回归（F2 改名一致 / F4 来源计数 / F5 采集完整性 / F3 旧桶判据）");
  {
    // ── R-F2. 同进程改名一致性：names.json 入指纹 ⇒ overview/full/archItemsOf 同见新名、快照随改名变 ──
    // 修前红（F2）：names.json 不在 graphInputSha 指纹里 → 同进程 full/archItemsOf 命中旧缓存返回旧名，
    // 且 snapshot_id 不随改名变化；只有概览（现读现算）见到新名。
    const rf2 = makeTmpProject("rf2", "v0922-rf2", {
      "alpha/a.ts": 'import { b } from "../beta/b";\nexport const a = 1;\n',
      "beta/b.ts": 'import { c } from "../gamma/c";\nexport const b = 2;\n',
      "gamma/c.ts": 'import { a } from "../alpha/a";\nexport const c = 3;\n',
    });
    const rf2Parsed = parseDirectory(rf2.dir);
    const rf2ArchDir = path.join(rf2.dir, ".工作台", "arch");
    fs.mkdirSync(rf2ArchDir, { recursive: true });
    fs.writeFileSync(path.join(rf2ArchDir, "modules.json"), JSON.stringify(rf2Parsed.file), "utf8");
    // 断言先取模块 id、再在 nodes 里按 id 定位看 label（不从节点列表顺序猜是哪个模块）
    const rf2ModId = rf2Parsed.file.modules[0].id;
    const rf2Names = (name: string): unknown => ({
      version: 1,
      entries: {
        [rf2ModId]: { name, blurb: "夹具人话名", kind: "code", named_at: "2026-01-01T00:00:00.000Z", signature: "fixture-sig" },
      },
    });
    fs.writeFileSync(path.join(rf2ArchDir, "names.json"), JSON.stringify(rf2Names("BEFORE_RENAME")), "utf8");

    const rf2Full1 = sixGraphsOf("v0922-rf2", { dataDir: rf2.home, mode: "full" });
    const rf2Node1 = rf2Full1.graphs.module_map?.nodes.find((n) => n.id === rf2ModId);
    ok(
      rf2Node1 !== undefined && rf2Node1.label === "BEFORE_RENAME",
      `R-F2 首次 full：模块 ${rf2ModId} 人话名=BEFORE_RENAME（按 id 定位，label=${rf2Node1?.label ?? "(未找到)"}）`,
    );
    const rf2Snap1 = rf2Full1.snapshot_id;

    // 同一进程里直接改写 names.json（modules.json 不动）
    fs.writeFileSync(path.join(rf2ArchDir, "names.json"), JSON.stringify(rf2Names("AFTER_RENAME")), "utf8");

    const rf2Ov = sixGraphsOf("v0922-rf2", { dataDir: rf2.home, mode: "overview" });
    const rf2NodeOv = rf2Ov.graphs.module_map?.nodes.find((n) => n.id === rf2ModId);
    ok(
      rf2NodeOv !== undefined && rf2NodeOv.label === "AFTER_RENAME",
      `R-F2 改名后 overview：模块 ${rf2ModId} 人话名=AFTER_RENAME（现读现算，修前也过，作对照）`,
    );

    const rf2Full2 = sixGraphsOf("v0922-rf2", { dataDir: rf2.home, mode: "full" });
    const rf2Node2 = rf2Full2.graphs.module_map?.nodes.find((n) => n.id === rf2ModId);
    ok(
      rf2Node2 !== undefined && rf2Node2.label === "AFTER_RENAME",
      `R-F2 改名后 full：模块 ${rf2ModId} 人话名=AFTER_RENAME（修前红：命中旧缓存返回 BEFORE_RENAME，label=${rf2Node2?.label ?? "(未找到)"}）`,
    );

    const rf2Items = archItemsOf("v0922-rf2", { dataDir: rf2.home, kind: "nodes", limit: 50 });
    const rf2ItemNode = rf2Items.nodes?.find((n) => n.id === rf2ModId);
    ok(
      rf2ItemNode !== undefined && rf2ItemNode.name === "AFTER_RENAME",
      `R-F2 改名后 archItemsOf：模块 ${rf2ModId} 人话名=AFTER_RENAME（修前红：缓存键不含 names → 返回 BEFORE_RENAME，name=${rf2ItemNode?.name ?? "(未找到)"}）`,
    );

    ok(
      rf2Full2.snapshot_id !== rf2Snap1,
      `R-F2 改名后 snapshot_id 变化（${rf2Snap1} → ${rf2Full2.snapshot_id}；修前红：不变）`,
    );

    // ── R-F4. 来源计数：by_origin 只数可见真实实体（聚合占位不计）＋ by_origin_underlying 底层未聚合并集 ──
    // 修前红（F4）：by_origin.code 把 __more__ 聚合占位也数进去（＝可见模块＋1），且无 by_origin_underlying。
    const RF4_N = 20;
    const rf4Mods = makeSeqModules(RF4_N);
    const rf4 = makeTmpProject("rf4", "v0922-rf4", {
      ".工作台/arch/modules.json": { version: 1, generated_at: new Date().toISOString(), budget_exhausted: false, modules: rf4Mods },
    });
    const rf4Vis = ARCH_LIMITS.MAX_NODES - 1; // 概览保留的真实模块数（超出部分进 __more__）
    const rf4Hidden = RF4_N - rf4Vis;
    const rf4Ov = sixGraphsOf("v0922-rf4", { dataDir: rf4.home, mode: "overview", graph: "module_map" }).graphs.module_map!;
    ok(
      rf4Ov.counts.by_origin?.code === rf4Vis,
      `R-F4 概览 by_origin.code=${rf4Ov.counts.by_origin?.code}（期望可见真实代码模块 ${rf4Vis}；修前红：把 __more__ 也数进去＝${rf4Vis + 1}）`,
    );
    ok(
      rf4Ov.counts.by_origin_underlying?.code === RF4_N,
      `R-F4 概览 by_origin_underlying.code=${rf4Ov.counts.by_origin_underlying?.code}（期望底层未聚合并集 ${RF4_N}）`,
    );
    ok(rf4Ov.counts.hidden_members === rf4Hidden, `R-F4 概览 hidden_members=${rf4Ov.counts.hidden_members}（期望 ${rf4Hidden}）`);
    ok(rf4Ov.counts.aggregate_node === true, "R-F4 概览 aggregate_node=true（本页含聚合节点）");
    const rf4AggNodes = rf4Ov.nodes.filter((n) => n.aggregate === true);
    ok(
      rf4AggNodes.length === 1 && rf4AggNodes[0].id === MORE_NODE_ID,
      `R-F4 概览 aggregate===true 的节点恰 1 个（${rf4AggNodes.map((n) => n.id).join("、")}）`,
    );
    ok(rf4Ov.notes.some((n) => n.includes("聚合占位不计入")), "R-F4 module_map notes 含「聚合占位不计入」口径句");
    const rf4Full = sixGraphsOf("v0922-rf4", { dataDir: rf4.home, mode: "full", graph: "module_map" }).graphs.module_map!;
    ok(
      rf4Full.counts.by_origin?.code === RF4_N && rf4Full.counts.by_origin_underlying?.code === RF4_N,
      `R-F4 full by_origin.code=${rf4Full.counts.by_origin?.code}、by_origin_underlying.code=${rf4Full.counts.by_origin_underlying?.code}（两者都应=${RF4_N}）`,
    );

    // ── R-F5. 结构化采集完整性（顶层 collection；与分页 completeness 语义独立、可同时成立） ──
    // 修前红（F5）：六图响应根本没有顶层 collection 字段。
    // (a) budget_exhausted=true：采集未完成 ＋ 分页取完 同时成立
    const rf5a = makeTmpProject("rf5a", "v0922-rf5a", {
      ".工作台/arch/modules.json": { version: 1, generated_at: new Date().toISOString(), budget_exhausted: true, modules: makeSeqModules(3) },
    });
    const rf5aSnap = sixGraphsOf("v0922-rf5a", { dataDir: rf5a.home, mode: "full", graph: "module_map" });
    ok(rf5aSnap.collection !== undefined, "R-F5(a) 六图响应带顶层 collection 字段（修前红：无此字段）");
    ok(rf5aSnap.collection?.status === "incomplete", `R-F5(a) budget_exhausted=true ⇒ collection.status=${rf5aSnap.collection?.status}（期望 incomplete）`);
    ok(rf5aSnap.collection?.budget_exhausted === true, `R-F5(a) collection.budget_exhausted=${rf5aSnap.collection?.budget_exhausted}（期望 true）`);
    ok(
      (rf5aSnap.collection?.reasons ?? []).join(" ").includes("budget_exhausted"),
      `R-F5(a) collection.reasons 含 budget_exhausted（${(rf5aSnap.collection?.reasons ?? []).join(" ").slice(0, 60)}…）`,
    );
    ok(
      rf5aSnap.completeness.complete === true,
      `R-F5(a) 分页 completeness.complete=${rf5aSnap.completeness.complete}（期望 true：图对象取完，与采集 incomplete 同时成立）`,
    );

    // (b) 正常件（budget_exhausted=false）⇒ complete
    const rf5b = makeTmpProject("rf5b", "v0922-rf5b", {
      ".工作台/arch/modules.json": { version: 1, generated_at: new Date().toISOString(), budget_exhausted: false, modules: makeSeqModules(3) },
    });
    const rf5bSnap = sixGraphsOf("v0922-rf5b", { dataDir: rf5b.home, mode: "full", graph: "module_map" });
    ok(
      rf5bSnap.collection?.status === "complete" && rf5bSnap.collection?.budget_exhausted === false,
      `R-F5(b) 正常件 ⇒ status=${rf5bSnap.collection?.status}、budget_exhausted=${rf5bSnap.collection?.budget_exhausted}（期望 complete/false）`,
    );

    // (c) 旧落盘件（modules.json 不含 budget_exhausted 字段）⇒ unknown
    const rf5c = makeTmpProject("rf5c", "v0922-rf5c", {
      ".工作台/arch/modules.json": { version: 1, generated_at: "2026-09-01T00:00:00.000Z", modules: makeSeqModules(3) },
    });
    const rf5cSnap = sixGraphsOf("v0922-rf5c", { dataDir: rf5c.home, mode: "full", graph: "module_map" });
    ok(
      rf5cSnap.collection?.status === "unknown" && rf5cSnap.collection?.budget_exhausted === null,
      `R-F5(c) 旧落盘件（无 budget_exhausted）⇒ status=${rf5cSnap.collection?.status}、budget_exhausted=${rf5cSnap.collection?.budget_exhausted}（期望 unknown/null）`,
    );
    ok(
      (rf5cSnap.collection?.reasons ?? []).some((r) => r.includes("no_budget_marker")),
      "R-F5(c) reasons 含 no_budget_marker（完整性未知，不许当全量）",
    );

    // (d) 旧桶夹具（真实旧格式那条）⇒ incomplete ＋ legacy_other_bucket
    const rf5d = makeTmpProject("rf5d", "v0922-rf5d", {
      ".工作台/arch/modules.json": {
        version: 1,
        generated_at: "2026-09-01T00:00:00.000Z",
        budget_exhausted: false,
        modules: [
          { id: "src-arch", name: "", path: "src/arch", file_count: 10, loc: 100, deps: [] },
          { id: "other", name: "", path: "docs,scripts,tests,tools,examples,vendor", file_count: 30, loc: 300, deps: [] },
        ],
      },
    });
    const rf5dSnap = sixGraphsOf("v0922-rf5d", { dataDir: rf5d.home, mode: "full", graph: "module_map" });
    ok(rf5dSnap.collection?.status === "incomplete", `R-F5(d) 旧桶件 ⇒ collection.status=${rf5dSnap.collection?.status}（期望 incomplete）`);
    ok(rf5dSnap.collection?.legacy_other_bucket === true, `R-F5(d) collection.legacy_other_bucket=${rf5dSnap.collection?.legacy_other_bucket}（期望 true）`);
    ok(rf5dSnap.collection?.legacy_merged_prefixes === 6, `R-F5(d) collection.legacy_merged_prefixes=${rf5dSnap.collection?.legacy_merged_prefixes}（期望 6）`);

    // (e) 没跑过解析的项目（不放 modules.json）⇒ not_parsed
    const rf5e = makeTmpProject("rf5e", "v0922-rf5e", {});
    const rf5eSnap = sixGraphsOf("v0922-rf5e", { dataDir: rf5e.home, mode: "full", graph: "module_map" });
    ok(rf5eSnap.collection?.status === "not_parsed", `R-F5(e) 没跑过解析 ⇒ collection.status=${rf5eSnap.collection?.status}（期望 not_parsed）`);

    // (f) 任一响应的 collection.ignored_dir_segments 都含 node_modules（规则性排除，不是遗漏）
    ok(
      (rf5bSnap.collection?.ignored_dir_segments ?? []).includes("node_modules") &&
        (rf5dSnap.collection?.ignored_dir_segments ?? []).includes("node_modules"),
      `R-F5(f) collection.ignored_dir_segments 含 node_modules（${(rf5bSnap.collection?.ignored_dir_segments ?? []).join("、")}）`,
    );

    // ── R-F3(4). 正常 other/ 目录不误报为旧桶 ──
    // 修前红（F3）：旧判据只看 id==="other" → 真实 other/ 目录被误判成有损聚合桶（has_legacy_other=true）。
    const rf3a = makeTmpProject("rf3a", "v0922-rf3a", {
      "other/a.ts": "export const a = 1;\n",
      "src/a.ts": "export const a = 2;\n",
    });
    parseProject("v0922-rf3a", rf3a.home);
    const rf3aLegacy = legacyAggregationOf(readModules("v0922-rf3a", rf3a.home).arch);
    ok(
      rf3aLegacy.has_legacy_other === false,
      `R-F3 真实 other/ 目录：has_legacy_other=${rf3aLegacy.has_legacy_other}（期望 false；修前红：只看 id==="other" 误报 true）`,
    );
    const rf3aSnap = sixGraphsOf("v0922-rf3a", { dataDir: rf3a.home, mode: "full" });
    ok(
      rf3aSnap.collection.legacy_other_bucket === false,
      `R-F3 真实 other/ 目录：collection.legacy_other_bucket=${rf3aSnap.collection.legacy_other_bucket}（期望 false）`,
    );
    ok(
      !rf3aSnap.anomalies.some((a) => a.includes("「其他」")),
      `R-F3 真实 other/ 目录：anomalies 无「其他」桶条目（共 ${rf3aSnap.anomalies.length} 条）`,
    );

    // ── R-F3(5). 重采集：旧桶识别 → 重跑解析展开 → 残留旧人名引用不炸、不串名 ──
    const rf3b = makeTmpProject("rf3b", "v0922-rf3b", {
      "docs/a.ts": "export const a = 1;\n",
      "scripts/a.ts": "export const a = 2;\n",
      "tests/a.ts": "export const a = 3;\n",
      "tools/a.ts": "export const a = 4;\n",
      "examples/a.ts": "export const a = 5;\n",
      "vendor/a.ts": "export const a = 6;\n",
    });
    const rf3bArchDir = path.join(rf3b.dir, ".工作台", "arch");
    fs.mkdirSync(rf3bArchDir, { recursive: true });
    // 真实旧落盘形状：id="other"、path 为 6 段逗号列表（不带「其他:」前缀）
    fs.writeFileSync(
      path.join(rf3bArchDir, "modules.json"),
      JSON.stringify({
        version: 1,
        generated_at: "2026-09-01T00:00:00.000Z",
        budget_exhausted: false,
        modules: [{ id: "other", name: "", path: "docs,scripts,tests,tools,examples,vendor", file_count: 6, loc: 6, deps: [] }],
      }),
      "utf8",
    );
    // names.json 里给 "other" 留一条人话名（旧引用）——重采集后模块身份没了，这条要无害残留
    const rf3bOldName = "旧其他桶残留名";
    fs.writeFileSync(
      path.join(rf3bArchDir, "names.json"),
      JSON.stringify({
        version: 1,
        entries: { other: { name: rf3bOldName, blurb: "", kind: "code", named_at: "2026-09-01T00:00:00.000Z", signature: "old-sig" } },
      }),
      "utf8",
    );
    const rf3bBefore = legacyAggregationOf(readModules("v0922-rf3b", rf3b.home).arch);
    ok(
      rf3bBefore.has_legacy_other && rf3bBefore.merged_prefixes === 6,
      `R-F3 重采集前：旧桶被识别（has_legacy_other=${rf3bBefore.has_legacy_other}、merged_prefixes=${rf3bBefore.merged_prefixes}，期望 6）`,
    );
    parseProject("v0922-rf3b", rf3b.home); // 重采集：other 桶消失、真实模块展开
    const rf3bAfter = legacyAggregationOf(readModules("v0922-rf3b", rf3b.home).arch);
    ok(rf3bAfter.has_legacy_other === false, `R-F3 重采集后：旧桶消失（has_legacy_other=${rf3bAfter.has_legacy_other}，期望 false）`);
    let rf3bErr: string | null = null;
    let rf3bSnap: ReturnType<typeof sixGraphsOf> | null = null;
    try {
      rf3bSnap = sixGraphsOf("v0922-rf3b", { dataDir: rf3b.home, mode: "full" });
    } catch (e) {
      rf3bErr = (e as Error).message;
    }
    const rf3bNodes = rf3bSnap?.graphs.module_map?.nodes ?? [];
    ok(
      rf3bErr === null && rf3bSnap?.graphs.module_map !== undefined,
      `R-F3 重采集后 sixGraphsOf(full) 不抛、module_map 正常返回（${rf3bErr ?? "无异常"}）`,
    );
    ok(
      rf3bNodes.every((n) => n.label !== rf3bOldName),
      `R-F3 names.json 残留 "other" 条目：无节点串成旧名（命中 ${rf3bNodes.filter((n) => n.label === rf3bOldName).length} 个）`,
    );
    ok(!rf3bNodes.some((n) => n.id === "other"), "R-F3 重采集后模块层无 other 桶节点（真实候选逐个在场）");

    // ── R-F2b. 首次调用快照稳定：progress.json 懒建次序（graphInputSha 先让懒建落定再算指纹） ──
    // 修前红（F2 修正中发现的次生缺陷）：progress.json 由 readProgress 懒建，指纹在懒建之前算——
    // 无 progress.json 的全新工程首次调用快照用 "none"、第二次用落盘内容，同输出两个快照 id、游标被误拒。
    // 本夹具**不走** makeTmpProject 的 progress 预置（那模拟的是真实工程稳态），专门覆盖「全新工程首调」。
    const rf2bHome = mkTmp("rf2b-home");
    const rf2bDir = mkTmp("rf2b-proj");
    for (const d of ["alpha", "beta", "gamma"]) {
      fs.mkdirSync(path.join(rf2bDir, d), { recursive: true });
      fs.writeFileSync(path.join(rf2bDir, d, "a.ts"), `export const a = "${d}";\n`, "utf8");
    }
    fs.mkdirSync(path.join(rf2bDir, ".工作台", "arch"), { recursive: true });
    fs.writeFileSync(
      path.join(rf2bDir, ".工作台", "arch", "modules.json"),
      JSON.stringify({ version: 1, generated_at: "2026-09-29T00:00:00.000Z", budget_exhausted: false, modules: makeSeqModules(3) }),
      "utf8",
    );
    addProject({ id: "v0922-rf2b", name: "v0922-rf2b", path: rf2bDir, kind: "backend" }, rf2bHome);
    ok(
      !fs.existsSync(path.join(rf2bDir, ".工作台", "progress.json")),
      "R-F2b 前置：全新工程无 progress.json（懒建尚未触发）",
    );
    const rf2bSnap1 = sixGraphsOf("v0922-rf2b", { dataDir: rf2bHome, mode: "full" });
    const rf2bSnap2 = sixGraphsOf("v0922-rf2b", { dataDir: rf2bHome, mode: "full" });
    const rf2bSnap3 = sixGraphsOf("v0922-rf2b", { dataDir: rf2bHome, mode: "overview" });
    ok(
      rf2bSnap1.snapshot_id === rf2bSnap2.snapshot_id,
      `R-F2b 全新工程首调后 full 两次同快照（${rf2bSnap1.snapshot_id} / ${rf2bSnap2.snapshot_id}；修前红：none→真实内容漂移）`,
    );
    ok(
      rf2bSnap1.snapshot_id === rf2bSnap3.snapshot_id,
      `R-F2b overview 与 full 同快照（${rf2bSnap3.snapshot_id}）`,
    );

    // ── R-F6. 损坏结构降级（2026-09-29 定向收尾 R1；复现依据＝Codex 审验 root-malformed-probe）──
    // 修前红（c70be8d）：legacyAggregationOf 移出 readModules 异常保护外——合法 JSON 但
    // modules:null／缺 modules／模块缺 path／path:null 直接把整个六图读口炸掉（Agent 拿不到图、
    // 也拿不到 collection）；4036dcd 曾能降级。修复＝读取边界结构校验（validateArchShape）。
    const rf6Shared = { version: 1, generated_at: "2026-09-29T00:00:00.000Z", budget_exhausted: false };
    const rf6Good = { id: "a", name: "", path: "a", file_count: 1, loc: 1, deps: [] };
    const rf6Cases: Record<string, unknown> = {
      modules_null: { ...rf6Shared, modules: null },
      modules_missing: { ...rf6Shared },
      path_missing: { ...rf6Shared, modules: [{ id: "a", name: "", file_count: 1, deps: [] }] },
      path_null: { ...rf6Shared, modules: [{ ...rf6Good, path: null }] },
    };
    for (const [tag, content] of Object.entries(rf6Cases)) {
      const fx = makeTmpProject(`rf6-${tag}`, `v0922-rf6-${tag}`, {
        ".工作台/arch/modules.json": content,
      });
      let snap: ReturnType<typeof sixGraphsOf> | null = null;
      let err: string | null = null;
      try {
        snap = sixGraphsOf(`v0922-rf6-${tag}`, { dataDir: fx.home, mode: "full", graph: "module_map" });
      } catch (e) {
        err = (e as Error).message;
      }
      ok(
        err === null && snap !== null,
        `R-F6 ${tag}：sixGraphsOf 正常返回（修前红：整个读口抛错——${err ?? "无异常"}）`,
      );
      if (snap !== null) {
        ok(
          snap.collection?.status === "unknown",
          `R-F6 ${tag}：collection.status=${snap.collection?.status}（期望 unknown，不阻断也不冒充 complete）`,
        );
        ok(
          (snap.collection?.reasons ?? []).some((r) => r.startsWith("modules_json_unreadable")),
          `R-F6 ${tag}：collection.reasons 带 modules_json_unreadable（结构损坏有可判读原因）`,
        );
        ok(
          snap.anomalies.some((a) => a.includes("modules.json 损坏")),
          `R-F6 ${tag}：anomalies 带具体损坏原因（共 ${snap.anomalies.length} 条）`,
        );
        ok(
          snap.graphs.module_map !== undefined,
          `R-F6 ${tag}：module_map 给出可构造响应（空态 payload，见 anomalies）`,
        );
        // 读取边界直检：readModules 对该形状抛 WsError（INVALID_INPUT 口径），而不是下游 TypeError
        let rmErr: string | null = null;
        try {
          readModules(`v0922-rf6-${tag}`, fx.home);
        } catch (e) {
          rmErr = (e as Error).message;
        }
        ok(
          rmErr !== null && rmErr.includes("损坏"),
          `R-F6 ${tag}：readModules 在读取边界拒绝（${rmErr ?? "未抛"}）`,
        );
      }
    }
    // 对照组①：JSON 语法损坏（原有降级路径，不许因结构校验回退）
    const rf6Json = makeTmpProject("rf6-json", "v0922-rf6-json", { ".工作台/arch/modules.json": "NOT-JSON{{{" });
    const rf6JsonSnap = sixGraphsOf("v0922-rf6-json", { dataDir: rf6Json.home, mode: "full", graph: "module_map" });
    ok(
      rf6JsonSnap.collection?.status === "unknown" &&
        (rf6JsonSnap.collection?.reasons ?? []).some((r) => r.startsWith("modules_json_unreadable")),
      "R-F6 对照：JSON 语法损坏照旧 unknown＋modules_json_unreadable（回归不回退）",
    );
    // 对照组②：自家写口产物不误伤（校验只挡外部改坏的形状，真解析落盘件全通过）
    const rf6Real = makeTmpProject("rf6-real", "v0922-rf6-real", {
      "src/a.ts": 'import { b } from "../lib/b";\nexport const a = 1;\n',
      "lib/b.ts": "export const b = 2;\n",
    });
    parseProject("v0922-rf6-real", rf6Real.home);
    const rf6RealSnap = sixGraphsOf("v0922-rf6-real", { dataDir: rf6Real.home, mode: "full", graph: "module_map" });
    ok(
      rf6RealSnap.collection?.status === "complete" && (rf6RealSnap.graphs.module_map?.nodes.length ?? 0) > 0,
      `R-F6 对照：真解析落盘件零告警（status=${rf6RealSnap.collection?.status}、节点 ${rf6RealSnap.graphs.module_map?.nodes.length}）`,
    );

    // ── R-F7. budget_exhausted 类型边界（2026-09-29 定向收尾 R3）──
    // 修前红（c70be8d）：只区分 ===true／===null，"true"、1 等非布尔标记全落 complete 分支、
    // 且响应回显原值（违反 collection.budget_exhausted: boolean|null 接口类型）。
    for (const [tag, marker] of [["string", "true"], ["number", 1]] as const) {
      const fx = makeTmpProject(`rf7-${tag}`, `v0922-rf7-${tag}`, {
        ".工作台/arch/modules.json": { version: 1, generated_at: "2026-09-29T00:00:00.000Z", budget_exhausted: marker, modules: makeSeqModules(3) },
      });
      const snap = sixGraphsOf(`v0922-rf7-${tag}`, { dataDir: fx.home, mode: "full", graph: "module_map" });
      ok(
        snap.collection?.status === "unknown",
        `R-F7 ${tag}：collection.status=${snap.collection?.status}（期望 unknown；修前红：complete）`,
      );
      ok(
        snap.collection?.budget_exhausted === null,
        `R-F7 ${tag}：collection.budget_exhausted 回显 null（修前红：回显 ${JSON.stringify(marker)}）`,
      );
      ok(
        (snap.collection?.reasons ?? []).some((r) => r.startsWith("budget_marker_invalid")),
        `R-F7 ${tag}：reasons 带 budget_marker_invalid（类型非法有可判读原因）`,
      );
      const rm = readModules(`v0922-rf7-${tag}`, fx.home);
      ok(
        rm.arch?.budget_exhausted === undefined && rm.budget_marker_invalid === true,
        `R-F7 ${tag}：readModules 剥掉非法标记并立 budget_marker_invalid（arch.budget_exhausted=${JSON.stringify(rm.arch?.budget_exhausted)}）`,
      );
      // 分页语义独立性不受影响：图对象取完仍 complete:true（与采集 unknown 同时成立）
      ok(
        snap.completeness.complete === true,
        `R-F7 ${tag}：分页 completeness.complete=${snap.completeness.complete}（语义独立，照旧取完）`,
      );
    }
    // 合法 false 不受累（R-F5(b) 已断言 complete；这里补 readModules 原样透传布尔）
    const rf7False = makeTmpProject("rf7-false", "v0922-rf7-false", {
      ".工作台/arch/modules.json": { version: 1, generated_at: "2026-09-29T00:00:00.000Z", budget_exhausted: false, modules: makeSeqModules(3) },
    });
    const rf7FalseRm = readModules("v0922-rf7-false", rf7False.home);
    ok(
      rf7FalseRm.arch?.budget_exhausted === false && rf7FalseRm.budget_marker_invalid === undefined,
      "R-F7 合法 false：readModules 原样透传布尔、无 invalid 标记（既有语义不变）",
    );
  }

  console.log(`\n[verify] V09-22 ${pass} PASS / ${fails.length} FAIL`);
  // J：各段 PASS/FAIL/SKIP 计数（沿用现有 finish 口径；主行格式不变，另起逐段统计）
  console.log("[verify] 分段统计（PASS/FAIL/SKIP）：");
  for (const [name, s] of sectionStats) console.log(`[verify]   ${name}：${s.pass}/${s.fail}/${s.skip}`);
  if (skips.length > 0) {
    console.log(`[verify] 本步 SKIP ${skips.length} 项（留第二步）：`);
    for (const s of skips) console.log(`[verify]   SKIP ${s}`);
  }
  if (fails.length > 0) {
    for (const f of fails) console.log(`[verify]   FAIL ${f}`);
    process.exitCode = 1;
  }
}

(async () => {
  try {
    await main();
  } finally {
  // 夹具自清（只删本脚本在 tmp 下自建的目录）
  for (const dir of CLEANUP) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 清不掉不阻塞结论 */
    }
  }
  const leftovers = CLEANUP.filter((d) => fs.existsSync(d));
  console.log(`[verify] 夹具清理：${CLEANUP.length} 个 tmp 目录，残留 ${leftovers.length} 个`);
  info(`仓库根：${REPO_ROOT}（真实项目只读，未写入）`);
  }
})();
