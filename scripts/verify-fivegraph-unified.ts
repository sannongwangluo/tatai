// 五图补齐 · 技术详情两图与 MCP 同名图**同源**定向回归（2026-10-08 Kimi Flash 第二阶段）：
//   pnpm exec tsx scripts/verify-fivegraph-unified.ts
//
// 背景（技术 REPORT §4-A 同源缺口，Codex 裁定必须修）：UI 的模块方框图 / 思维导图此前只读
// **纯静态代码关系层**（9 节点），而 MCP 的 `module_map` / `mind_map` 读 **静态＋已发布规划层**
// （118/119 节点）——同一张图在两个读口给出不同节点集合。本卡在 `arch/render` 上加显式
// `planning=1`（旧无参数仍原静态接口），UI `getArchRender` 默认显式请求它，两读口改为**同一 builder**
// （`viewGraphWithPlan`）。
//
// 本脚本断言面（逐条对任务要求）：
//   ① 同源：worker / 进程内计算的 `arch_render(planning=1)` 节点 id 集 == `viewGraphWithPlan` 同一
//      builder 的结果 == MCP 同名图（`sixGraphsOf` 的 module_map / mind_map）节点 id 集；
//   ② full：`planning=1&full=1` == `viewGraphWithPlan(..., RENDER_FULL_LIMITS)` == MCP `mode=full`
//      的**未聚合并集**（同一组上限，规划层不受 15 代码节点上限）；
//   ③ 规划标记：并入的规划节点带 `plan_origin:"plan"`、`path:""`、`canDrillSharedNode=false`；
//      代码节点仍有真实路径、可下钻；
//   ④ 兼容：不带 `planning` 的 `arch_render` 输出与旧静态口 `renderGraph` **逐字节一致**（仍是纯静态层）；
//   ⑤ 空态真实：有规划无代码 → 仍显示规划图（exists:true）；无规划无代码 → exists:false（不拿顶住的空图冒充）；
//   ⑥ 同源接线：`archReadWorker` 走 `viewGraphWithPlan`、HTTP 路由把 `planning` 同传给 worker 与退化路径、
//      UI `getArchRender` 默认带 `planning=1`、`ArchView` 把**同一份** canonical 投影同时传 `scope_projection`。
//
// 隐私 / 边界（AGENTS.md §5/§6）：隔离 `TATAI_HOME` + `os.tmpdir` 夹具项目，脚本结束整目录删除；
// 不注册真实项目、不碰真实 `.工作台`、零写盘到仓库；临时探针不留盘。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { addProject, resolveDataDir } from "../src/server/registry";
import { computeArchRenderRead } from "../src/server/work/archReadWorker";
import { runReadJob, stopReadWorkers } from "../src/server/work/readWorkerPool";
import { renderGraph, buildSharedGraph } from "../src/arch/render";
import { viewGraphWithPlan, type Blueprint } from "../src/arch/blueprint";
import { selectGraph, canDrillSharedNode, type SharedGraph } from "../src/arch/shared-graph";
import { sixGraphsOf } from "../src/arch/sixGraphs";
import { RENDER_FULL_LIMITS } from "../src/arch/config";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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
const info = (m: string): void => console.log(`[verify]   ${m}`);

// ── 隔离夹具：临时 TATAI_HOME + tmpdir 项目（结束时整目录删除）────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-fivegraph-unified-"));
const HOME = path.join(TMP, "home");
fs.mkdirSync(HOME, { recursive: true });
// 关键：所有不带 dataDir 的读路径（viewGraphWithPlan / computeArchRenderRead / readModules）
// 都走 resolveDataDir() —— 先把它指到隔离 HOME，绝不去读真实注册表。
process.env.TATAI_HOME = HOME;
process.env.TATAI_WORK_DIR = path.join(TMP, "work");

interface Mod {
  id: string;
  path: string;
  file_count?: number;
  loc?: number;
  deps?: { to: string; weight: number }[];
}

/** 写一个隔离夹具项目根：modules.json（可选）+ names.json + 已发布 blueprint.json（可选） */
function makeFixture(opts: {
  id: string;
  modules?: Mod[];
  blueprint?: Blueprint | null;
}): string {
  const root = path.join(TMP, opts.id);
  fs.mkdirSync(path.join(root, ".工作台", "arch"), { recursive: true });
  if (opts.modules !== undefined) {
    fs.writeFileSync(
      path.join(root, ".工作台", "arch", "modules.json"),
      JSON.stringify(
        {
          version: 1,
          generated_at: "2026-10-08T00:00:00+08:00",
          budget_exhausted: false,
          modules: opts.modules.map((m) => ({
            id: m.id,
            name: "",
            path: m.path,
            file_count: m.file_count ?? 3,
            loc: m.loc ?? 30,
            deps: m.deps ?? [],
          })),
        },
        null,
        2,
      ),
      "utf8",
    );
    fs.writeFileSync(
      path.join(root, ".工作台", "arch", "names.json"),
      JSON.stringify(
        { version: 1, entries: Object.fromEntries(opts.modules.map((m) => [m.id, { name: `${m.id} 模块`, blurb: "", kind: "code" }])) },
        null,
        2,
      ),
      "utf8",
    );
  }
  if (opts.blueprint !== undefined && opts.blueprint !== null) {
    fs.writeFileSync(path.join(root, ".工作台", "arch", "blueprint.json"), JSON.stringify(opts.blueprint, null, 2), "utf8");
  }
  addProject({ id: opts.id, name: opts.id, path: root, kind: "backend" }, HOME);
  return root;
}

const DESIGN_REF = (chapter: number) => ({ kind: "design_section" as const, locator: `§${chapter}`, chapter });
const CODE_REF = (locator: string) => ({ kind: "code_module" as const, locator });
const TASK_REF = (task: string) => ({ kind: "plan_task" as const, locator: task });

/** 一份最小可读的已发布规划图（只填 planningLayerInput / 读口实际消费的字段） */
function makeBlueprint(): Blueprint {
  const nodes = [
    // 能力：命中静态模块 src（只挂 plan_refs，不新建节点）
    { id: "plan:cap:01", kind: "capability" as const, name: "样本能力", source_refs: [DESIGN_REF(1), CODE_REF("src")], related_ids: ["plan:mod:01"] },
    // 模块：也命中 src
    { id: "plan:mod:01", kind: "module" as const, name: "样本模块", source_refs: [DESIGN_REF(2), CODE_REF("src")], related_ids: ["plan:cap:01", "plan:task:01"] },
    // 任务：无实测模块 → 追加规划灰节点
    { id: "plan:task:01", kind: "task" as const, name: "样本任务一", source_refs: [TASK_REF("FX-01")], related_ids: ["plan:task:02", "plan:mod:01"] },
    { id: "plan:task:02", kind: "task" as const, name: "样本任务二", source_refs: [TASK_REF("FX-02")], related_ids: ["plan:task:01"] },
  ];
  const edges = [
    { source: "plan:task:01", target: "plan:task:02", kind: "task_dependency" as const, source_refs: [TASK_REF("FX-01")], certainty: "declared" as const },
    { source: "plan:mod:01", target: "plan:task:01", kind: "task_design_ref" as const, source_refs: [DESIGN_REF(2)], certainty: "declared" as const },
    { source: "plan:cap:01", target: "src", kind: "implementation_map" as const, source_refs: [CODE_REF("src")], certainty: "observed" as const },
  ];
  return {
    version: 1 as Blueprint["version"],
    baseline_id: "bl-fx-1",
    generator_version: "verify-fivegraph-unified",
    generated_at: "2026-10-08T00:00:00+08:00",
    source_manifest: [],
    nodes,
    edges,
    coverage: {
      design_sections: { total: 2, mapped: 2, unmapped: [] },
      plan_tasks: { total: 2, mapped: 2, unmapped: [] },
      code_modules: { total: 3, mapped: 2, unmapped: [{ key: "docs", detail: "无规划映射" }] },
      nodes_total: nodes.length,
      nodes_kept: nodes.length,
      edges_total: edges.length,
      edges_kept: edges.length,
      note: "隔离夹具",
    },
    omitted: [],
    model_receipt: null,
    publish: { published: true, reason: null, validated_at: "2026-10-08T00:00:00+08:00" },
    based_on: { baseline_id: "bl-fx-1", design_sha256: "d".repeat(64), plan_definition_sha256: "p".repeat(64), generator_version: "verify-fivegraph-unified", semantics: false },
  } as unknown as Blueprint;
}

const idsOf = (nodes: readonly { id: string }[]): string[] => [...new Set(nodes.map((n) => n.id))].sort();
const same = (a: readonly string[], b: readonly string[]): boolean => JSON.stringify(a) === JSON.stringify(b);
const graphOf = (render: unknown): SharedGraph => (render as { render: { graph: SharedGraph } }).render.graph;
/** 两份派生逐字节比对时抹掉**构建时刻**（`generated_at` 是现算时间戳，非派生内容）——比的是内容身份。 */
const stable = (v: unknown): string => JSON.stringify(v, (k, val) => (k === "generated_at" ? "<generated_at>" : val));

async function main(): Promise<void> {
  console.log(`[verify] 隔离 HOME=${rel(HOME)}（临时目录，结束删除）`);

  const A = "fx-unified-both"; // 代码 + 规划
  const B = "fx-unified-planonly"; // 只有规划，无代码
  const C = "fx-unified-empty"; // 空仓
  makeFixture({
    id: A,
    modules: [
      { id: "src", path: "src", deps: [{ to: "scripts", weight: 5 }] },
      { id: "scripts", path: "scripts" },
      { id: "docs", path: "docs" },
    ],
    blueprint: makeBlueprint(),
  });
  makeFixture({ id: B, blueprint: makeBlueprint() });
  makeFixture({ id: C });

  // ════════ ① 同源：worker / 进程内 / viewGraphWithPlan / MCP 节点 id 集一致（概览口径）════════
  console.log("\n[verify] ── ① 同源：planning=1 与 MCP 同名图读同一份（静态＋已发布规划层）");
  {
    const view = viewGraphWithPlan(A);
    const viewIds = idsOf(view.graph.nodes);
    const worker = await runReadJob("arch_render", { projectId: A, full: false, planning: true });
    const local = computeArchRenderRead(A, false, true);
    ok(stable(worker) === stable(local), "① arch_render(planning) 经 worker 与进程内派生逐字节一致（除构建时刻）");
    const workerIds = idsOf(graphOf(worker).nodes);
    ok(same(workerIds, viewIds), `① worker planning 节点 id 集 == viewGraphWithPlan（${workerIds.length} 个：${workerIds.join(", ")}）`);

    const mcpOverview = sixGraphsOf(A, { dataDir: HOME, graph: "module_map", mode: "overview" });
    const mm = mcpOverview.graphs.module_map;
    ok(mm !== undefined, "① MCP module_map 可读（概览）");
    if (mm !== undefined) {
      ok(same(idsOf(mm.nodes), viewIds), `① MCP module_map 节点 id 集 == UI planning 口径（${mm.nodes.length} 个）`);
    }
    const mind = sixGraphsOf(A, { dataDir: HOME, graph: "mind_map", mode: "overview" }).graphs.mind_map;
    ok(
      mind !== undefined && same(idsOf(mind.nodes), [...viewIds, A].sort()),
      "① MCP mind_map 节点 id 集 == UI planning 口径 ＋ 项目根（导图与方框图逐 id 相同，根是导图特有）",
    );

    // 静态层节点（3 个代码模块）必须在场；规划灰节点也在场
    ok(
      ["docs", "scripts", "src"].every((id) => workerIds.includes(id)) && workerIds.includes("plan:task:01") && workerIds.includes("plan:task:02"),
      "① 代码模块（src/scripts/docs）与规划灰节点（plan:task:01/02）同时在图（能力/模块命中静态节点不建第二份）",
    );
    const sel = selectGraph("MODULE_BOX", graphOf(worker));
    ok(same(idsOf(sel.nodes), workerIds), "① 方框图选择器节点集合 == 共用层（零过滤，规划节点也在场）");
  }

  // ════════ ② full：planning+full == viewGraphWithPlan(RENDER_FULL) == MCP mode=full ════════
  console.log("\n[verify] ── ② full：同一份输入，UI保留既有安全上限（规划层不受 15 代码节点上限）");
  {
    const unlimited = viewGraphWithPlan(A, { limits: RENDER_FULL_LIMITS });
    const workerFull = await runReadJob("arch_render", { projectId: A, full: true, planning: true });
    const localFull = computeArchRenderRead(A, true, true);
    ok(stable(workerFull) === stable(localFull), "② arch_render(planning+full) worker 与进程内逐字节一致（除构建时刻）");
    ok(same(idsOf(graphOf(workerFull).nodes), idsOf(unlimited.graph.nodes)), "② planning+full 节点 id 集 == viewGraphWithPlan(RENDER_FULL_LIMITS)");
    const mcpFull = sixGraphsOf(A, { dataDir: HOME, graph: "module_map", mode: "full" }).graphs.module_map;
    ok(mcpFull !== undefined && same(idsOf(mcpFull.nodes), idsOf(graphOf(workerFull).nodes)), "② planning+full 节点 id 集 == MCP module_map mode=full（未聚合并集）");
    const g = graphOf(workerFull);
    ok(
      g.nodes.some((n) => n.plan_origin === "plan") && g.limits.MAX_NODES === RENDER_FULL_LIMITS.MAX_NODES,
      `② full 保留UI安全上限 MAX_NODES=${RENDER_FULL_LIMITS.MAX_NODES}（规划节点不被 15 上限裁掉）`,
    );
    // 不变量：规划节点数 > 概览的 15 代码节点上限也无妨（此夹具 2 个规划灰节点在 15 内，直接断言 >= 上限数无意义——改为断言"规划节点在场且未被聚合占位替代"）
    ok(!g.nodes.some((n) => n.aggregate === true), "② 该小夹具 full 不需要聚合");
  }

  // 输入同源不等于一次把所有对象塞进画布；超额代码对象仍按 V09-22 入口取回。
  {
    const largeId = 'fivegraph-ui-cap';
    const count = RENDER_FULL_LIMITS.MAX_NODES + 1;
    makeFixture({ id: largeId, modules: Array.from({ length: count }, (_, i) => ({ id: `m-${i}`, path: `m-${i}` })) });
    const bounded = graphOf(computeArchRenderRead(largeId, true, true));
    ok(bounded.nodes.length <= RENDER_FULL_LIMITS.MAX_NODES, '② planning+full 仍保留画布安全上限');
    ok(bounded.truncated.nodes > 0 && bounded.nodes.some(n => n.aggregate === true), '② 超额对象显式聚合/计数，不静默丢失');
  }

  // ════════ ③ 规划标记：规划节点无真实路径、不可下钻；代码节点可下钻 ════════
  console.log("\n[verify] ── ③ 规划标记与下钻可达口径");
  {
    const g = graphOf(computeArchRenderRead(A, false, true));
    const planNodes = g.nodes.filter((n) => n.plan_origin === "plan");
    ok(planNodes.length === 2, `③ 规划灰节点 ${planNodes.length} 个（plan:task:01/02）`);
    ok(
      planNodes.every((n) => n.path === "" && canDrillSharedNode(n) === false),
      "③ 规划节点 path 为空、canDrillSharedNode=false（无真实路径不画下钻控件）",
    );
    const codeNodes = g.nodes.filter((n) => n.plan_origin !== "plan" && n.aggregate !== true);
    ok(
      codeNodes.length === 3 && codeNodes.every((n) => n.path !== "" && canDrillSharedNode(n) === true),
      `③ 代码模块 ${codeNodes.length} 个仍有真实路径、可下钻`,
    );
    ok(g.nodes.find((n) => n.id === "src")?.plan_refs?.includes("plan:cap:01") === true, "③ 命中静态模块的规划对象只挂 plan_refs（不建第二份节点）");
  }

  // ════════ ④ 兼容：不带 planning 的旧静态口逐字节不变 ════════
  console.log("\n[verify] ── ④ 兼容：不带 planning 仍是纯静态口");
  {
    const oldEnvelope = computeArchRenderRead(A, false) as { render: unknown };
    const legacy = renderGraph(A, undefined);
    ok(stable(oldEnvelope.render) === stable(legacy), "④ arch_render 无 planning 的 render == 旧口 renderGraph 逐字节一致（除构建时刻）");
    ok(stable(buildSharedGraph(A)) === stable(legacy), "④ 与 buildSharedGraph 逐字节一致（旧读口零改动）");
    const ids = idsOf(graphOf(oldEnvelope).nodes);
    ok(same(ids, ["docs", "scripts", "src"]), `④ 无 planning 节点 = 纯静态 ${ids.length} 个（无任何 plan:*）`);
    const workerOld = await runReadJob("arch_render", { projectId: A, full: false });
    ok(stable((workerOld as { render: unknown }).render) === stable(oldEnvelope.render), "④ worker 无 planning 参数 == 进程内旧静态口（缺省不变）");
  }

  // ════════ ⑤ 空态真实：有规划无代码 / 无规划无代码 ════════
  console.log("\n[verify] ── ⑤ 空态真实（有规划无代码可显示；两者皆无 → exists:false）");
  {
    const planOnly = computeArchRenderRead(B, false, true) as { render: { exists: boolean; graph?: SharedGraph } };
    ok(planOnly.render.exists === true, "⑤ 有已发布规划、无代码解析 → exists:true（空仓也能看规划图）");
    const planOnlyIds = idsOf(planOnly.render.graph?.nodes ?? []);
    ok(planOnlyIds.includes("plan:task:01") && planOnlyIds.includes("plan:task:02") && !planOnlyIds.includes("src"), "⑤ 空代码时只见规划节点（plan:task:01/02），无代码节点");
    const planOnlyLegacy = computeArchRenderRead(B, false) as { render: { exists: boolean } };
    ok(planOnlyLegacy.render.exists === false, "⑤ 同项目不带 planning → exists:false（旧静态口真实空态）");

    const empty = computeArchRenderRead(C, false, true) as { render: { exists: boolean; graph?: SharedGraph } };
    ok(empty.render.exists === false, "⑤ 无规划无代码 → exists:false（不拿顶住的空图冒充有图）");
  }

  // ════════ ⑥ 同源接线（源码级）：worker / HTTP 路由 / UI / ArchView ════════
  console.log("\n[verify] ── ⑥ 同源接线（源码级，判据不放宽）");
  {
    const workerSrc = read("src/server/work/archReadWorker.ts");
    ok(/viewGraphWithPlan\(/.test(workerSrc) && /RENDER_FULL_LIMITS/.test(workerSrc), "⑥ archReadWorker 的 planning 分支走 viewGraphWithPlan ＋ UI安全上限");
    ok(/renderGraph\(projectId, full \? \{ limits: RENDER_FULL_LIMITS \}/.test(workerSrc), "⑥ 无 planning 分支仍走旧静态 renderGraph");
    const indexSrc = read("src/server/index.ts");
    ok(/const planning = query\.some\(\(kv\) => kv === "planning=1"\)/.test(indexSrc), "⑥ HTTP arch/render 解析显式 planning=1");
    ok(
      /archReadViaWorker\("arch_render", \{ projectId: id, full, planning \}, \(\) => computeArchRenderRead\(id, full, planning\)\)/.test(indexSrc),
      "⑥ HTTP 把 planning 同传 worker args 与进程内退化 fallback（同一判据）",
    );
    ok(/const full = query\.some\(\(kv\) => kv === "full=1"\)/.test(indexSrc), "⑥ full=1 解析保持手写 split（不引 URL 依赖）");
    const apiSrc = read("src/ui/api.ts");
    ok(/if \(opts\?\.planning !== false\) params\.push\("planning=1"\)/.test(apiSrc) && /if \(opts\?\.full === true\) params\.push\("full=1"\)/.test(apiSrc), "⑥ UI getArchRender 默认 planning=1；full 与 planning 并存");
    const archViewSrc = read("src/ui/components/ArchView.tsx");
    ok(
      /taskDerivedModuleStatus\(\{ blueprint, projection, declared_links: links, scope_projection: projection \}\)/.test(archViewSrc),
      "⑥ ArchView 把同一份 canonical 投影同时传 scope_projection（能力/功能范围状态唯一来源，不另算 cap 状态）",
    );
    const canvasSrc = read("src/ui/arch/ArchCanvas.tsx");
    ok(/data-arch-plan-node=\{id\}/.test(canvasSrc) && /n\.plan_origin === "plan" \? \{ planOrigin: true as const \}/.test(canvasSrc), "⑥ 方框图规划节点带「规划」徽标（data-arch-plan-node）");
    const mindSrc = read("src/ui/arch/MindMapView.tsx");
    ok(/data-mm-plan/.test(mindSrc) && /plan_origin === "plan"/.test(mindSrc), "⑥ 思维导图规划节点带「规划」徽标（data-mm-plan，不改节点文字）");
    // 无递归：静态合成层（render.ts / shared-graph.ts）不 import arch 读口，读口只调 builder
    ok(!/archReadWorker|readWorkerPool/.test(read("src/arch/render.ts")) && !/archReadWorker|readWorkerPool/.test(read("src/arch/shared-graph.ts")), "⑥ 不产生「静态→蓝图→渲染」递归（合成层不引读口）");
  }

  console.log(`[verify] 隔离目录将删除：${rel(TMP)}`);
}

async function run(): Promise<void> {
  try {
    await main();
  } catch (e) {
    console.error("[verify] 异常:", e);
    process.exitCode = 1;
  } finally {
    try {
      await stopReadWorkers();
    } catch {
      /* 只收自己起的只读线程 */
    }
    fs.rmSync(TMP, { recursive: true, force: true });
  }
  const code = process.exitCode ?? 0;
  console.log(`[verify] 结果: ${code === 0 ? "全部 PASS" : "有 FAIL（见上）"}（exit ${code}）`);
}

void run();
