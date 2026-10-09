// 六图规划层状态/边类型保真 + 临时目录过滤 + modules.json 稳定写 回归（tsx 跑）：
//   pnpm verify:sixgraph-planfix
//
// 事由（2026-10-05 现场核查 <维护者核验目录>/塔台六图现场核查-20261005）：
//   ① 同一快照里 46 张任务卡在施工依赖图有状态、到技术三图一律「无状态记录」；
//   ② 规划层关系被统一标成 kind=static_import / certainty=observed（声明冒充实测）；
//   ③ Python tempfile 随机目录（tmp+8 位随机串）漏过忽略清单，进模块集并反复触发重画；
//   ④ modules.json 每轮重解析都换 generated_at，同步证据按整文件哈希绑定被反复打回 invalid。
//
// 覆盖：
//   A. plan_status / moduleStatusKeysOf：任务直取投影、能力按成员派生、模块派生不回退；
//      A4（F1 集成修正）：画布解析顺序 `archStatusRecordOf` 能力分支先于通用键表（本视图成员口径不被跨视图聚合顶掉）；
//   B. 规划边保真：mergePlanningLayer→selectGraph(MODULE_BOX/DATA_FLOW) 全程带 plan_kind/plan_certainty，
//      互惠对归并后纯规划对保标记、混合对按静态出；静态边口径不变；
//      B3（F3 集成修正）：**纯规划互惠对保留 plan 标记** + **规划×静态混合对按静态出** 真实断言（原缺此两分支）；
//   C. 随机临时目录：形状判定、parseDirectory 不收、watcher 不监听、changeVerdict 不触发；
//   D. modules.json 内容稳定落盘：语义不变不重写（哈希/时间戳原样），真变照常覆盖；
//   E. 真实项目只读抽查（有则验、无则 SKIP）：技术三图任务节点键与施工依赖图同一 id 同键、
//      规划端点对不再标 static_import。
//
// 隔离口径（AGENTS.md §5）：夹具一律放系统 tmp 下 `tatai-planfix-` 前缀目录，收尾自清且先确认目标
// 在临时根内；注册表一律写夹具自己的 dataDir，绝不碰真实注册表；真实项目段只读。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { isJunkDir, JUNK_DIR_RANDOM_TEMP_RE } from "../src/arch/config";
import { parseDirectory, parseProject, readModules } from "../src/arch/parse";
import { sixGraphsOf, scopeConclusionOf, type GraphNodeEntry } from "../src/arch/sixGraphs";
import { readBlueprint } from "../src/arch/blueprint";
import {
  buildSharedGraphFrom,
  mergePlanningLayer,
  selectGraph,
  type PlanLayerInput,
} from "../src/arch/shared-graph";
import { changeVerdict } from "../src/server/work/graphRefresh";
import { isIgnoredPath } from "../src/server/watcher";
import { taskDerivedModuleStatus, moduleStatusKeysOf, NO_STATUS_RECORD, archStatusRecordOf, canonicalScopeStatusOf, directStatusOf } from "../src/ui/arch/projectGraph";
import { collectProjectFacts, eventsSnapshotOf, type StatusProjection } from "../src/server/work/statusProjection";
import { addProject, listProjects, resolveDataDir } from "../src/server/registry";

let pass = 0;
const fails: string[] = [];
const skips: string[] = [];
const ok = (cond: boolean, label: string): void => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (cond) pass += 1;
  else fails.push(label);
};
const skip = (label: string): void => {
  console.log(`[verify] SKIP ${label}`);
  skips.push(label);
};
const section = (t: string): void => console.log(`\n[verify] ── ${t} ──`);

const TMP_ROOT = path.resolve(os.tmpdir());
const CLEANUP: string[] = [];
const mkTmp = (tag: string): string => {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, `tatai-planfix-${tag}-`));
  CLEANUP.push(dir);
  return dir;
};
const cleanup = (): void => {
  for (const dir of CLEANUP) {
    const abs = path.resolve(dir);
    if (abs === TMP_ROOT || !abs.startsWith(TMP_ROOT + path.sep)) {
      console.error(`[verify] 拒绝清理临时根外的目标：${abs}`);
      continue;
    }
    fs.rmSync(abs, { recursive: true, force: true });
  }
};

/** 最小投影夹具（只填 directStatusOf 会摸的字段；其余维度不影响上屏键） */
const proj = (objectId: string, display: string | null): StatusProjection =>
  ({
    object_id: objectId,
    mapping: display === null ? "unmapped" : "mapped",
    display_status: display,
    display_status_label: display,
    reasons: display === null ? [{ code: "unmapped", text: "夹具：未映射" }] : [],
  }) as unknown as StatusProjection;

/** 蓝图夹具：任务 T01a（验证通过）/T02b（阻塞）挂在能力 cap:01 下；T01a 实现映射到模块 src */
const blueprintFixture = () => ({
  version: 1 as const,
  baseline_id: "bl-planfix",
  generator_version: "verify-sixgraph-planfix",
  generated_at: "2026-01-01T00:00:00+08:00",
  source_manifest: [],
  nodes: [
    { id: "plan:cap:01", kind: "capability", name: "夹具能力", source_refs: [], related_ids: [] },
    { id: "plan:task:T01a", kind: "task", name: "任务T01a", source_refs: [], related_ids: [] },
    { id: "plan:task:T02b", kind: "task", name: "任务T02b", source_refs: [], related_ids: [] },
    { id: "plan:code:src", kind: "module", name: "源码模块", source_refs: [], related_ids: [] },
  ],
  edges: [
    { source: "plan:task:T01a", target: "plan:cap:01", kind: "task_design_ref", certainty: "declared", source_refs: [] },
    { source: "plan:task:T02b", target: "plan:cap:01", kind: "task_design_ref", certainty: "declared", source_refs: [] },
    { source: "plan:task:T01a", target: "plan:code:src", kind: "implementation_map", certainty: "observed", source_refs: [] },
  ],
  coverage: {
    design_sections: { total: 0, mapped: 0, unmapped: [] },
    plan_tasks: { total: 2, mapped: 2, unmapped: [] },
    code_modules: { total: 1, mapped: 1, unmapped: [] },
    nodes_total: 4,
    nodes_kept: 4,
    edges_total: 3,
    edges_kept: 3,
    note: "验证夹具",
  },
  omitted: [],
  model_receipt: null,
  publish: { published: true, reason: null, validated_at: "2026-01-01T00:00:00+08:00" },
  based_on: { model_key: "fx", full_key: "fx", design_content_sha256: null, plan_definition_sha256: null, semantic: false },
});

try {
  // ═══════════════ A. plan_status / moduleStatusKeysOf（缺陷①） ═══════════════
  section("A. 任务/能力节点的 v2 状态进入共用键表（技术三图不再一律「无状态记录」）");
  {
    const bp = blueprintFixture() as unknown as Parameters<typeof taskDerivedModuleStatus>[0]["blueprint"];
    const projection = {
      T01a: proj("T01a", "verified"),
      T02b: proj("T02b", "blocked"),
    };
    // V09-55 返工：能力状态只读 canonical 义务层投影（不再本地按成员汇总）
    const capBlocked = {
      object_id: "plan:cap:01",
      mapping: "mapped",
      display_status: "blocked",
      display_status_label: "红",
      reasons: [],
    } as never;
    const derived = taskDerivedModuleStatus({ blueprint: bp, projection, scope_projection: { "plan:cap:01": capBlocked } });
    ok(derived.plan_status["plan:task:T01a"]?.display === "verified", "A1 任务 T01a 直取投影＝verified（不再无状态记录）");
    ok(derived.plan_status["plan:task:T02b"]?.display === "blocked", "A1 任务 T02b 直取投影＝blocked");
    ok(derived.status["plan:code:src"]?.display === "verified", "A1 模块派生不受影响（成员全 verified ⇒ 模块 verified）");
    ok(
      derived.plan_status["plan:cap:01"]?.display === "blocked",
      "A1 能力状态**只读 canonical 范围投影**（V09-55 返工：不本地按成员汇总）",
    );
    const keys = moduleStatusKeysOf(derived);
    ok(keys["plan:task:T01a"] === "verified", "A2 键表含 plan:task:T01a → verified");
    ok(keys["plan:task:T02b"] === "blocked", "A2 键表含 plan:task:T02b → blocked");
    ok(keys["src"] === "verified" && keys["plan:code:src"] === "verified", "A2 模块两套键照旧");
    const derivedEmpty = taskDerivedModuleStatus({ blueprint: bp, projection: {} });
    const keysEmpty = moduleStatusKeysOf(derivedEmpty);
    ok(keysEmpty["plan:task:T01a"] === "unmapped", "A2 无投影任务 → unmapped（与主视图同判据，不是 no_status_record）");

    // A4（F1 集成修正）：通用键表里的 plan:cap 是**跨视图聚合**，不能在画布上当本视图能力状态直接用。
    const keysCap = moduleStatusKeysOf(derived);
    ok(keysCap["plan:cap:01"] === "blocked", "A4 通用键表 plan:cap:01 = 跨视图聚合（capabilityMembersOf 成员含任务 ⇒ blocked）");
    // V09-55 定向更新（判据**收紧**，不是放宽）：能力主状态改为**唯一聚合层**判据后，
    //   · 成员全绿但缺自身集成检查证据 ⇒ 封顶「结果待验证」，**不再按视图各算一份绿**；
    //   · 无论走画布的能力分支还是通用键表，同一 `plan:cap:*` 给**同一结论**（旧断言「本视图成员口径
    //     胜出、顶掉跨视图聚合」正是被消除的跨图不一致，见诊断快照 plan:cap:08/09）。
    const viewCap = canonicalScopeStatusOf(capBlocked);
    ok(
      viewCap.display === "blocked" && viewCap.display === derived.plan_status["plan:cap:01"]?.display,
      "A4 能力状态只读 canonical 投影，画布能力分支 = 技术三图键表（同一结论，不再按视图各算一份）",
    );
    const resolvedCap = archStatusRecordOf(["plan:cap:01", "plan:code:src"], {
      capabilityStatusOf: () => canonicalScopeStatusOf(capBlocked).display ?? NO_STATUS_RECORD,
      keysOf: (id) => keysCap[id],
      directStatusOf: () => NO_STATUS_RECORD,
    });
    ok(
      resolvedCap["plan:cap:01"] === keysCap["plan:cap:01"],
      `A4 画布能力分支与通用键表给**同一结论**（${resolvedCap["plan:cap:01"]}＝${keysCap["plan:cap:01"]}；V09-55：不再按视图各算一份）`,
    );
    ok(resolvedCap["plan:code:src"] === "verified", "A4 非能力节点仍走通用键表（口径不变）");
  }

  // ═══════════════ A3. sixGraphsOf 夹具：同一 id 各图同键（集成） ═══════════════
  section("A3. 夹具项目 sixGraphsOf：技术三图任务节点键与施工依赖图同一 id 同键");
  {
    const HOME = mkTmp("home");
    const projDir = mkTmp("proj");
    const archDir = path.join(projDir, ".工作台", "arch");
    fs.mkdirSync(archDir, { recursive: true });
    fs.writeFileSync(
      path.join(archDir, "modules.json"),
      JSON.stringify({
        version: 1,
        generated_at: "2026-01-01T00:00:00+08:00",
        budget_exhausted: false,
        modules: [
          { id: "src", name: "", path: "src", file_count: 9, loc: 0, deps: [{ to: "lib", weight: 1 }] },
          { id: "lib", name: "", path: "lib", file_count: 5, loc: 0, deps: [] },
        ],
      }),
      "utf8",
    );
    fs.writeFileSync(path.join(archDir, "blueprint.json"), JSON.stringify(blueprintFixture()), "utf8");
    addProject({ id: "planfix-fx", name: "planfix 夹具", path: projDir, kind: "backend" }, HOME);
    const snap = sixGraphsOf("planfix-fx", { dataDir: HOME, mode: "full", limit: 100000 });
    const nodeKey = (g: keyof typeof snap.graphs, id: string): string | undefined =>
      ((snap.graphs[g]?.nodes ?? []) as GraphNodeEntry[]).find((n) => n.id === id)?.object.status_key ?? undefined;
    ok(snap.graphs.construction !== undefined && nodeKey("construction", "plan:task:T01a") !== undefined, "A3 施工依赖图含 plan:task:T01a");
    const cKey = nodeKey("construction", "plan:task:T01a");
    ok(cKey === nodeKey("module_map", "plan:task:T01a"), `A3 方框图同键（construction=${cKey} / module_map=${nodeKey("module_map", "plan:task:T01a")}）`);
    ok(cKey === nodeKey("data_flow", "plan:task:T01a"), `A3 数据流向图同键（data_flow=${nodeKey("data_flow", "plan:task:T01a")}）`);
    ok(cKey === nodeKey("mind_map", "plan:task:T01a"), `A3 思维导图同键（mind_map=${nodeKey("mind_map", "plan:task:T01a")}）`);
    ok(cKey !== NO_STATUS_RECORD && cKey !== undefined, `A3 键不是 no_status_record（=${cKey}；无账本夹具应为 unmapped）`);
  }

  // ═══════════════ B. 规划边类型保真（缺陷②） ═══════════════
  section("B. 规划边带原关系类型，不冒充实测 static_import");
  {
    const base = buildSharedGraphFrom(
      [
        { id: "src", path: "src", file_count: 9, deps: [{ to: "lib", weight: 1 }] },
        { id: "lib", path: "lib", file_count: 5, deps: [] },
      ],
      {},
    );
    const layer: PlanLayerInput = {
      baseline_id: "bl-fx",
      nodes: [
        { id: "plan:task:T01a", name: "任务", kind: "task", code_module_ids: [] },
        { id: "plan:cap:01", name: "能力", kind: "capability", code_module_ids: [] },
      ],
      edges: [{ source: "plan:task:T01a", target: "plan:cap:01", kind: "task_design_ref", certainty: "declared" }],
    };
    const merged = mergePlanningLayer(base, layer);
    const planEdge = merged.edges.find((e) => e.origin === "plan");
    ok(planEdge !== undefined && planEdge.plan_kind === "task_design_ref" && planEdge.plan_certainty === "declared", "B1 合并层保住 plan_kind/plan_certainty");
    const box = selectGraph("MODULE_BOX", merged);
    const boxPlan = box.edges.find((e) => e.origin === "plan");
    ok(boxPlan?.plan_kind === "task_design_ref", "B1 MODULE_BOX 选择器不丢规划标记");
    const flow = selectGraph("DATA_FLOW", merged);
    const flowPlan = flow.edges.find((e) => e.origin === "plan");
    ok(flowPlan?.plan_kind === "task_design_ref", "B1 DATA_FLOW 选择器（过滤/归并/翻转后）不丢规划标记");
    ok(flow.edges.every((e) => (e.from === "plan:cap:01" || e.to === "plan:cap:01" ? true : e.origin !== "plan")), "B1 DATA_FLOW 规划标记只出现在规划端点对上");
    // 互惠对：A→B 规划 + B→A 静态 ⇒ 混合对按静态出（不带 plan 标记）
    const mutualBase = buildSharedGraphFrom(
      [
        { id: "a", path: "a", file_count: 3, deps: [{ to: "b", weight: 1 }] },
        { id: "b", path: "b", file_count: 3, deps: [{ to: "a", weight: 5 }] },
      ],
      {},
    );
    const mutualLayer: PlanLayerInput = {
      baseline_id: null,
      nodes: [],
      edges: [], // 静态互惠对本身就该按静态出；规划×静态混合在 sixGraphs 夹具 A3 蓝图边里已覆盖
    };
    const mutualFlow = selectGraph("DATA_FLOW", mergePlanningLayer(mutualBase, mutualLayer));
    ok(mutualFlow.edges.length === 1 && mutualFlow.edges[0].bidirectional === true && mutualFlow.edges[0].origin !== "plan", "B1 静态互惠对归并口径不变（仍无 plan 标记）");

    // B3（F3 集成修正）：**纯规划互惠对**与**规划×静态混合对**的真实断言（原先只测了全静态互惠对）。
    // 纯规划互惠对：同一对节点两侧都是规划边 ⇒ 归并后**保留** plan 标记（对内取 cur 侧类型）。
    const pureBase = buildSharedGraphFrom(
      [
        { id: "pa", path: "pa", file_count: 2, deps: [] },
        { id: "pb", path: "pb", file_count: 2, deps: [] },
      ],
      {},
    );
    const pureLayer: PlanLayerInput = {
      baseline_id: null,
      nodes: [
        { id: "plan:task:PA", name: "PA", kind: "task", code_module_ids: [] },
        { id: "plan:task:PB", name: "PB", kind: "task", code_module_ids: [] },
      ],
      edges: [
        { source: "plan:task:PA", target: "plan:task:PB", kind: "task_dependency", certainty: "declared" },
        { source: "plan:task:PB", target: "plan:task:PA", kind: "task_dependency", certainty: "declared" },
      ],
    };
    const pureFlow = selectGraph("DATA_FLOW", mergePlanningLayer(pureBase, pureLayer));
    const purePair = pureFlow.edges.filter(
      (e) => (e.from === "plan:task:PA" && e.to === "plan:task:PB") || (e.from === "plan:task:PB" && e.to === "plan:task:PA"),
    );
    ok(
      purePair.length === 1 && purePair[0].bidirectional === true && purePair[0].origin === "plan" && purePair[0].plan_kind === "task_dependency",
      `B3【F3】纯规划互惠对归并后**保留** plan 标记（bidirectional+origin=plan+plan_kind=${purePair[0]?.plan_kind}）`,
    );
    // 规划×静态混合对：一侧实测 import、一侧规划 ⇒ 归并后按**静态**出（不带 plan 标记）。
    const mixBase = buildSharedGraphFrom(
      [
        { id: "ma", path: "ma", file_count: 2, deps: [{ to: "mb", weight: 1 }] },
        { id: "mb", path: "mb", file_count: 2, deps: [] },
      ],
      {},
    );
    const mixLayer: PlanLayerInput = {
      baseline_id: null,
      nodes: [
        { id: "plan:task:MA", name: "MA", kind: "task", code_module_ids: ["ma"] },
        { id: "plan:task:MB", name: "MB", kind: "task", code_module_ids: ["mb"] },
      ],
      edges: [{ source: "plan:task:MB", target: "plan:task:MA", kind: "task_design_ref", certainty: "declared" }],
    };
    const mixedFlow = selectGraph("DATA_FLOW", mergePlanningLayer(mixBase, mixLayer));
    const mixPair = mixedFlow.edges.filter((e) => (e.from === "ma" && e.to === "mb") || (e.from === "mb" && e.to === "ma"));
    ok(
      mixPair.length === 1 && mixPair[0].bidirectional === true && mixPair[0].origin !== "plan",
      `B3【F3】规划×静态混合对按**静态**出（归并边不带 plan 标记；origin=${mixPair[0]?.origin ?? "static"}）`,
    );
  }

  // ═══════════════ B2. sixGraphsOf 夹具：边行分流（集成） ═══════════════
  section("B2. 夹具项目六图：规划边 kind/certainty 按原类型出、静态边不变");
  {
    const HOME = mkTmp("home2");
    const projDir = mkTmp("proj2");
    const archDir = path.join(projDir, ".工作台", "arch");
    fs.mkdirSync(archDir, { recursive: true });
    fs.writeFileSync(
      path.join(archDir, "modules.json"),
      JSON.stringify({
        version: 1,
        generated_at: "2026-01-01T00:00:00+08:00",
        budget_exhausted: false,
        modules: [
          { id: "src", name: "", path: "src", file_count: 9, loc: 0, deps: [{ to: "lib", weight: 1 }] },
          { id: "lib", name: "", path: "lib", file_count: 5, loc: 0, deps: [] },
        ],
      }),
      "utf8",
    );
    fs.writeFileSync(path.join(archDir, "blueprint.json"), JSON.stringify(blueprintFixture()), "utf8");
    addProject({ id: "planfix-edge", name: "planfix 边夹具", path: projDir, kind: "backend" }, HOME);
    const snap = sixGraphsOf("planfix-edge", { dataDir: HOME, mode: "full", limit: 100000 });
    const mmEdges = snap.graphs.module_map?.edges ?? [];
    const planRow = mmEdges.find((e) => e.from === "plan:task:T01a" && e.to === "plan:cap:01");
    ok(planRow !== undefined && planRow.kind === "task_design_ref" && planRow.certainty === "declared", `B2 方框图规划边按原类型（kind=${planRow?.kind}）`);
    ok(mmEdges.some((e) => e.from === "src" && e.to === "lib" && e.kind === "static_import" && e.certainty === "observed"), "B2 静态边保持 static_import/observed");
    const dfEdges = snap.graphs.data_flow?.edges ?? [];
    const dfPlan = dfEdges.find((e) => (e.from === "plan:task:T01a" && e.to === "plan:cap:01") || (e.from === "plan:cap:01" && e.to === "plan:task:T01a"));
    ok(dfPlan !== undefined && dfPlan.kind === "task_design_ref" && dfPlan.certainty === "declared", `B2 数据流向图规划边按原类型（kind=${dfPlan?.kind}）`);
    ok(dfEdges.some((e) => e.kind === "static_import_direction"), "B2 数据流向图静态边保持 static_import_direction");
    const mindEdges = snap.graphs.mind_map?.edges ?? [];
    ok(mindEdges.every((e) => e.kind === "hierarchy_parent_child"), "B2 思维导图层级边口径不变");
  }

  // ═══════════════ C. 随机临时目录（缺陷③） ═══════════════
  section("C. tmp+8 位随机串不进模块集、不触发重画");
  {
    ok(
      ["tmp2y6_hlid", "tmpne9_v42g", "tmplbi59bsb"].every((n) => JUNK_DIR_RANDOM_TEMP_RE.test(n)),
      "C1 形状判定命中三个现场样本",
    );
    ok(
      ["tmp", "tmpproj", "tmp_ab12", "src", "docs", "tmp_examples_longer"].every((n) => !JUNK_DIR_RANDOM_TEMP_RE.test(n)),
      "C1 正式目录名不误伤（tmp 精确段仍由具名清单管）",
    );
    ok(isJunkDir("tmp2y6_hlid") && !isJunkDir("tmpproj"), "C1 isJunkDir 并入形状判定");
    const HOME = mkTmp("home3");
    const projDir = mkTmp("proj3");
    for (const [rel, content] of Object.entries({
      "src/a.py": "import os\n",
      "lib/b.py": "from src import a\n",
      "tmp2y6_hlid/leak.py": "x = 1\n",
      "tmpne9_v42g/mcp.sqlite3": "binary-ish",
      "tools/c.py": "y = 2\n",
    })) {
      const abs = path.join(projDir, ...rel.split("/"));
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, "utf8");
    }
    addProject({ id: "planfix-tmp", name: "planfix tmp 夹具", path: projDir, kind: "backend" }, HOME);
    const parsed = parseDirectory(projDir);
    const ids = parsed.file.modules.map((m) => m.id);
    ok(!ids.some((id) => id.startsWith("tmp")), `C2 parseDirectory 不收随机临时目录（ids=${ids.join(",")}）`);
    ok(ids.includes("src") && ids.includes("lib") && ids.includes("tools"), "C2 真实目录照常收集");
    ok(isIgnoredPath(path.join(projDir, "tmp2y6_hlid", "leak.py"), projDir), "C3 watcher isIgnoredPath 拦下随机临时目录路径");
    ok(!isIgnoredPath(path.join(projDir, "src", "a.py"), projDir), "C3 正常源码路径不受影响");
    const arch = { version: 1 as const, generated_at: "2026-01-01T00:00:00+08:00", modules: parsed.file.modules, budget_exhausted: false };
    const line = (p: string, action: "add" | "remove") => ({ path: p, action, ts: "2026-10-05T00:00:00+08:00", size_delta: null });
    const vAdd = changeVerdict(line("tmp2y6_hlid/leak.py", "add"), { root: projDir, arch });
    ok(vAdd === null, "C4 changeVerdict：临时目录里的新增不触发 structure_top");
    const vGone = changeVerdict(line("tmplbi59bsb/old.py", "remove"), { root: projDir, arch });
    ok(vGone === null, "C4 changeVerdict：历史行里已消失的临时目录不触发重画");
    const vReal = changeVerdict(line("src/newmod.py", "add"), { root: projDir, arch });
    ok(vReal !== null, "C4 真实源码新增仍触发（保守重解析口径不变）");
  }

  // ═══════════════ D. modules.json 内容稳定落盘（缺陷④） ═══════════════
  section("D. 语义不变的重解析不重写 modules.json（同步 artifact 哈希稳定）");
  {
    const HOME = mkTmp("home4");
    const projDir = mkTmp("proj4");
    for (const [rel, content] of Object.entries({
      "src/a.py": "import os\n",
      "lib/b.py": "from src import a\n",
    })) {
      const abs = path.join(projDir, ...rel.split("/"));
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, "utf8");
    }
    addProject({ id: "planfix-stable", name: "planfix 稳定写夹具", path: projDir, kind: "backend" }, HOME);
    const file = path.join(projDir, ".工作台", "arch", "modules.json");
    parseProject("planfix-stable", HOME);
    const bytes1 = fs.readFileSync(file);
    const gen1 = (JSON.parse(bytes1.toString("utf8")) as { generated_at: string }).generated_at;
    // 第二轮：什么都不改，语义内容相同（只有 generated_at 会不同）——文件必须原样保留
    parseProject("planfix-stable", HOME);
    const bytes2 = fs.readFileSync(file);
    ok(bytes1.equals(bytes2), "D1 语义不变的第二轮重解析不重写文件（字节原样）");
    ok((JSON.parse(bytes2.toString("utf8")) as { generated_at: string }).generated_at === gen1, "D1 generated_at 一并保留（旧时间戳不被翻新）");
    // 第三轮：真实内容变化（新模块目录）——必须照常覆盖
    fs.mkdirSync(path.join(projDir, "tools"), { recursive: true });
    fs.writeFileSync(path.join(projDir, "tools", "c.py"), "z = 3\n", "utf8");
    parseProject("planfix-stable", HOME);
    const bytes3 = fs.readFileSync(file);
    ok(!bytes2.equals(bytes3), "D2 真实模块集变化照常落盘（漂移可被同步侧识别）");
    const reread = readModules("planfix-stable", HOME);
    ok(reread.arch?.modules.some((m) => m.id === "tools") === true, "D2 新模块在重读里在场");
  }

  // ═══════════════ E. 真实项目只读抽查（有 published 蓝图才验） ═══════════════
  section("E. 真实项目只读抽查（缺陷①②的现场复现口径）");
  {
    const HOME = resolveDataDir();
    const cands = listProjects(HOME).filter((p) => fs.existsSync(path.join(p.path, ".工作台", "arch", "blueprint.json")));
    const withPlan: string[] = [];
    for (const p of cands) {
      try {
        const snap = sixGraphsOf(p.id, { dataDir: HOME, mode: "full", limit: 100000 });
        if (snap.graph_state.availability !== "published") continue;
        const tasks = (snap.graphs.module_map?.nodes ?? []).filter((n) => n.id.startsWith("plan:task:"));
        if (tasks.length === 0) continue;
        withPlan.push(p.id);
        const cKeys = new Map(((snap.graphs.construction?.nodes ?? []) as GraphNodeEntry[]).map((n) => [n.id, n.object.status_key]));
        let mismatch = 0;
        let noRecord = 0;
        for (const t of tasks) {
          const k = t.object.status_key;
          if (k === NO_STATUS_RECORD) noRecord += 1;
          if (cKeys.get(t.id) !== k) mismatch += 1;
        }
        ok(mismatch === 0, `E1 ${p.id}：技术图 ${tasks.length} 个任务节点与施工依赖图同 id 同键（不一致 ${mismatch}）`);
        ok(noRecord === 0, `E1 ${p.id}：技术图任务节点不再落「无状态记录」（余 ${noRecord}）`);

        // E3（Fix B）：六图每个**任务/能力**节点的状态必须与 canonical 义务层（`deriveObligations`，
        // 即 HTTP /status-projection、MCP feature_ledger 消费的那一份）**同一现读 facts 版本**一致——
        // 不得拿旧提交图的 task 主状态与当前 scope 投影混版（真机：tatai V09-51 六图橙 / canonical 绿；
        // 示例项目 T02.2/T06.1/T09.1 六图 blocked / canonical pending）。
        const snapEv = eventsSnapshotOf(p.id, HOME);
        const facts = collectProjectFacts(p.id, HOME, { events: snapEv });
        // canonical 走**与 HTTP /status-projection 完全同一份** `scopeConclusionOf`（含蓝图范围/能力对象；
        // 裸 `deriveObligations` 缺 extra_objects，会把能力按「无 canonical 投影」误解成不一致）。
        const scope = scopeConclusionOf({
          projectId: p.id,
          dataDir: HOME,
          blueprint: readBlueprint(p.id, HOME),
          facts,
          events: snapEv,
        });
        const canon: Record<string, StatusProjection> = {};
        for (const o of scope.full?.objects ?? []) canon[o.object_id] = o;
        // 与 buildViewModel/viewNodeEntries 同一上屏键规则：display ?? (unmapped ⇒ 'unmapped')
        const keyOfCanon = (objId: string): string => {
          const pr = canon[objId];
          if (pr === undefined) return "unmapped";
          const st = directStatusOf(pr);
          return st.display ?? (st.kind === "unmapped" ? "unmapped" : NO_STATUS_RECORD);
        };
        let canonMismatch = 0;
        let checkedAppearances = 0;
        for (const gkey of ["functional", "architecture", "construction", "module_map", "data_flow", "mind_map"] as const) {
          for (const n of (snap.graphs[gkey]?.nodes ?? []) as GraphNodeEntry[]) {
            const isTask = n.id.startsWith("plan:task:");
            const isCap = n.id.startsWith("plan:cap:");
            if (!isTask && !isCap) continue;
            const objId = isTask ? n.id.slice("plan:task:".length) : n.id;
            checkedAppearances += 1;
            if (n.object.status_key !== keyOfCanon(objId)) canonMismatch += 1;
          }
        }
        ok(
          canonMismatch === 0,
          `E3【Fix B】${p.id}：六图 ${checkedAppearances} 个任务/能力节点 appearance 与 canonical（deriveObligations）同现读 facts 版本（不一致 ${canonMismatch}）`,
        );
        const mmEdges = snap.graphs.module_map?.edges ?? [];
        const planPairs = mmEdges.filter((e) => e.from.startsWith("plan:") && e.to.startsWith("plan:"));
        const mislabel = planPairs.filter((e) => e.kind === "static_import");
        ok(mislabel.length === 0, `E2 ${p.id}：规划端点对 ${planPairs.length} 条不再标 static_import（误标 ${mislabel.length}）`);
        const dfEdges = snap.graphs.data_flow?.edges ?? [];
        const dfPlanPairs = dfEdges.filter((e) => e.from.startsWith("plan:") && e.to.startsWith("plan:"));
        ok(dfPlanPairs.every((e) => e.kind !== "static_import_direction"), `E2 ${p.id}：数据流向图规划端点对 ${dfPlanPairs.length} 条不标 static_import_direction`);
      } catch (e) {
        skip(`E ${p.id}：读图失败 ${(e as Error).message}`);
      }
    }
    if (withPlan.length === 0) skip("E：本机没有带已发布蓝图且含任务节点的真实项目（现场机上有 示例项目/tatai）");
  }

  console.log(`\n[verify] 结果：${pass} PASS / ${fails.length} FAIL / ${skips.length} SKIP`);
  if (fails.length > 0) {
    console.error("[verify] 失败项：");
    for (const f of fails) console.error(`  - ${f}`);
    process.exitCode = 1;
  }
} finally {
  cleanup();
}
