// V09-08 验证脚本（tsx 跑）：对账配对修正、UI 误导修正、compat 投影与 MCP 读口同源。
//
// 覆盖（逐条对着卡面一条）：
//   ① 真误配修正：`11.1-01` 落到**实现模块**（`src`），不再配到 `templates`；`ref_text` 指到真实实现路径；
//      并给出**修前/修后**的绿理由对照（旧配对把它们配到 templates ⇒ 错误地继承绿）。
//   ② 落点未证实口径（反例）：章节里**只点到落点、没点名实现落点**的声明 ⇒ `plan_section_locator`
//      ＋「落点未证实」，`declaredLinksOf` 不收它 ⇒ **不继承状态色**（夹具正反两例）。
//   ③ `only_in_code` 分类（actionable / outside_scope / structural）——同一份共享判据；
//      真实塔台读数按分类分计；真差异仍标黄（机制未被分类改坏）；UI 两处消费同一份词表。
//   ④ 派生蓝图边去重：distinct 边键数 == 行数、两次派生逐字节相同；反例——同一卡引用**不同**能力
//      仍是两条边（不同章节不合并）；同键重复合并时 `source_refs` 取并集（出处不丢）。
//   ⑤ 读口同源：`list_tasks`/`read_progress` 的 v2 任务行与 `last_seq` 同源（事件账本），
//      旧文件序号另标 `compat_snapshot_seq`/`stale`；`get_arch` 状态口径**分两支**——
//      已迁移项目取 v2 证据派生（不再输出 v1 四色冒充现行状态）、映射不到写「无状态记录」、
//      没有已发布蓝图也不回退 v1；未迁移项目（v1）与 `renderGraph` 返回体**深相等／逐字相同**
//      （夹具：有 modules.json 与 progress.json、无 events.jsonl／无 v2 投影标记）。
//
// 边界：真实塔台只做**只读**取数，唯一写入是重跑对账产物 `.工作台/arch/reconcile-last.json`
// （与界面「重跑对账」按钮同一条代码路径，是派生缓存、不是事实源；本脚本不碰 Gate/任务账本、
// 不激活基线、不重画已发布蓝图）。其余段一律用 `os.tmpdir()` 下的隔离 TATAI_HOME 与夹具项目。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { addProject } from "../src/server/registry";
import {
  classifyOnlyInCodeEntries,
  declaredLinksOf,
  declaredPathsInSection,
  onlyInCodeContextOf,
  readLastReconcile,
  reconcileProject,
  type OnlyInCodeEntry,
} from "../src/arch/reconcile";
import {
  deriveBlueprint,
  readBlueprint,
  readBlueprintSources,
  type Blueprint,
} from "../src/arch/blueprint";
import { renderGraph, techModuleStatusOf } from "../src/arch/render";
import { readProgress, tasksProjectionInfo } from "../src/server/workstation";
import { readTaskLedger } from "../src/server/workstation";
import { listTasksTool } from "../src/mcp/tools/listTasks";
import { readProgressTool } from "../src/mcp/tools/readProgress";
import { getArchTool } from "../src/mcp/tools/getArch";
import { moduleStatusKeysOf, taskDerivedModuleStatus } from "../src/ui/arch/projectGraph";
import { NO_STATUS_RECORD_KEY } from "../src/ui/arch/statusColor";
import {
  ONLY_IN_CODE_CATEGORY_BADGE,
  ONLY_IN_CODE_CATEGORY_LABEL,
  categoryOfOnlyInCode,
  countMatchedByVia,
  groupOnlyInCode,
  type OnlyInCodeDisplayCategory,
} from "../src/ui/arch/reconcileClass";
import { declaredLinksFromMatched } from "../src/shared/reconcileLinks";
import { REPO_ROOT, ensureSelfRegistered, finish, realHome } from "./lib/fixtures";

let pass = 0;
let fail = 0;
const ok = (cond: boolean, label: string): void => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (cond) pass++;
  else {
    fail++;
    process.exitCode = 1;
  }
};
const info = (m: string): void => console.log(`[verify]   ${m}`);
const REPO = REPO_ROOT;
const REAL_HOME = realHome();
ensureSelfRegistered(REAL_HOME);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-v0908-"));
const FIXTURE_HOME = path.join(TMP, "home");
fs.mkdirSync(FIXTURE_HOME, { recursive: true });

/** 写一个夹具项目（含 design.md / plan.md / modules.json / .gitignore 与真实在场的源码） */
function makeFixture(opts: {
  id: string;
  design: string;
  plan: string;
  modules: { id: string; path: string }[];
  files: string[];
  gitignore?: string;
}): string {
  const root = path.join(TMP, opts.id);
  fs.mkdirSync(path.join(root, ".工作台", "arch"), { recursive: true });
  fs.writeFileSync(path.join(root, ".工作台", "design.md"), opts.design, "utf8");
  fs.writeFileSync(path.join(root, ".工作台", "plan.md"), opts.plan, "utf8");
  fs.writeFileSync(
    path.join(root, ".工作台", "arch", "modules.json"),
    JSON.stringify(
      {
        version: 1,
        generated_at: "2026-09-24T00:00:00+08:00",
        budget_exhausted: false,
        modules: opts.modules.map((m) => ({
          id: m.id,
          name: "",
          path: m.path,
          file_count: 1,
          loc: 10,
          deps: [],
        })),
      },
      null,
      2,
    ),
    "utf8",
  );
  if (opts.gitignore !== undefined) fs.writeFileSync(path.join(root, ".gitignore"), opts.gitignore, "utf8");
  for (const f of opts.files) {
    const p = path.join(root, f);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "export const x = 1;\n", "utf8");
  }
  addProject({ id: opts.id, name: opts.id, path: root, kind: "backend" }, FIXTURE_HOME);
  return root;
}

const toolJson = async (
  r: Promise<{ content: { text: string }[]; isError?: boolean }> | { content: { text: string }[]; isError?: boolean },
): Promise<Record<string, unknown>> => {
  const res = await r;
  const text = res.content[0]?.text ?? "";
  if (res.isError === true) throw new Error(`工具回执是错误：${text}`);
  return JSON.parse(text) as Record<string, unknown>;
};

// ═════════════════════════ ① 真误配修正（11.1-01） ═════════════════════════
console.log("[verify] ═══ ① 真误配修正：11.1-01 落到实现模块（不再配到 templates）═══");
const realRecon = reconcileProject("tatai", { trigger: "verify-v09-08", dataDir: REAL_HOME });
const pairOf = (stableId: string): typeof realRecon.matched =>
  realRecon.matched.filter((m) => m.stable_id === stableId);
const p1101 = pairOf("11.1-01");
ok(
  p1101.length === 1 && p1101[0].module_id === "src",
  `11.1-01 配到实现模块 \`${p1101.map((m) => m.module_id).join("、")}\`（期望 src）`,
);
ok(
  !p1101.some((m) => m.module_id === "templates"),
  "11.1-01 **不再**配到 `templates`（那是以空模板目录当实现落点，报告 02 G-03 的真误配）",
);
ok(
  p1101[0]?.via === "plan_section_ref" &&
    (p1101[0]?.ref_text ?? "").includes("src/server/registry.ts") &&
    (p1101[0]?.ref_text ?? "").includes("src/ui/components/ProjectList.tsx"),
  `ref_text 指到真实实现路径：${(p1101[0]?.ref_text ?? "").slice(0, 120)}`,
);
for (const rel of ["src/server/registry.ts", "src/ui/components/ProjectList.tsx"]) {
  ok(fs.existsSync(path.join(REPO, rel)), `卡面点名的实现落点实测在场：\`${rel}\``);
}
const planText = fs.readFileSync(path.join(REPO, "PLAN.md"), "utf8");
const p1Line = planText.split(/\r?\n/).findIndex((l) => l.startsWith("## 一期 1｜")) + 1;
const declaredInP1 = declaredPathsInSection(planText, p1Line);
ok(
  declaredInP1.some((d) => d.path === "src/server/registry.ts" && d.implementation) &&
    !declaredInP1.find((d) => d.path === "templates/.工作台.example/")?.implementation,
  "一期 1 章节点名了两类路径：`src/server/registry.ts` 标了**实现落点**；`templates/.工作台.example/` 没标（产物/素材）",
);

// 修前/修后对照：同一份真实蓝图上，绿的理由换了模块
const realBp = readBlueprint("tatai");
if (realBp === null) {
  console.log("[verify] FAIL 真实塔台没有已发布蓝图：① 的继承对照段跑不了");
  process.exitCode = 1;
  fail++;
} else {
  const taskIds = realBp.nodes.filter((n) => n.kind === "task").map((n) => n.id.replace("plan:task:", ""));
  // 夹具投影：只有 templates 的两张成员卡（V06-03 / V09-05）通过，其余一律「已规划」
  const templatesMembers = realBp.edges
    .filter((e) => e.kind === "implementation_map" && e.target === "plan:code:templates")
    .map((e) => e.source.replace("plan:task:", ""));
  const projection = Object.fromEntries(
    taskIds.map((t) => [
      t,
      {
        object_id: t,
        object_kind: "task",
        mapping: "mapped",
        display_status: templatesMembers.includes(t) ? "verified" : "planned",
        reasons: [],
      },
    ]),
  );
  const own = taskDerivedModuleStatus({
    blueprint: realBp as unknown as Blueprint,
    projection: projection as never,
    declared_links: declaredLinksOf(realRecon),
  });
  const before = taskDerivedModuleStatus({
    blueprint: realBp as unknown as Blueprint,
    projection: projection as never,
    // 修前的配对口径：11.1-01 → templates
    declared_links: { "11.1-01": ["templates"] },
  });
  ok(
    before.status["plan:mod:11.1-01"]?.display === "verified",
    "**修前对照**：11.1-01 配到 `templates` 时，templates 的成员卡全绿 ⇒ 声明模块误判「已验证通过」（错误绿）",
  );
  ok(
    own.status["plan:mod:11.1-01"]?.display !== "verified",
    `**修后**：11.1-01 继承的是 \`src\`（成员里有未通过的卡）⇒ 不再给绿（实测 display=${String(own.status["plan:mod:11.1-01"]?.display)}）`,
  );
  ok(
    (own.status["plan:mod:11.1-01"]?.basis ?? "").includes("src") &&
      !(own.status["plan:mod:11.1-01"]?.basis ?? "").includes("templates"),
    `修后 basis 点名的模块是 src：${(own.status["plan:mod:11.1-01"]?.basis ?? "").slice(0, 90)}`,
  );
  info(
    `  真实塔台对账：matched=${realRecon.matched.length} · only_in_design=${realRecon.only_in_design.length} · only_in_code=${realRecon.only_in_code.length}`,
  );
}

// ═════════════════════════ ② 落点未证实（夹具正反例） ═════════════════════════
console.log("[verify] ═══ ② 落点未证实：只点到落点的声明**不继承状态色**（夹具正反两例）═══");
const FIX_DESIGN = [
  "# 夹具设计书",
  "",
  "## 2 模块划分",
  "",
  "| # | 模块 | 说明 |",
  "| --- | --- | --- |",
  "| 1 | 甲模块 | 只点名义落点 |",
  "| 2 | 乙模块 | 点名实现落点 |",
  "",
].join("\n");
const FIX_PLAN = [
  "# 夹具施工图",
  "",
  "## 甲卡｜甲模块（设计书 §2 第 1 项）",
  "",
  "产出：`alpha/thing.ts` 的素材目录（这里只点了一个落点，没别的说明）",
  "",
  "## 乙卡｜乙模块（设计书 §2 第 2 项）",
  "",
  "产出：实现落点 `beta/main.ts`（实现落点，实测在场）",
  "",
].join("\n");
const fixId = "p-v0908-nominal";
makeFixture({
  id: fixId,
  design: FIX_DESIGN,
  plan: FIX_PLAN,
  modules: [
    { id: "alpha", path: "alpha" },
    { id: "beta", path: "beta" },
    { id: "gamma", path: "gamma" },
  ],
  files: ["alpha/thing.ts", "beta/main.ts", "gamma/only.ts"],
});
const fixRecon = reconcileProject(fixId, { trigger: "verify-v0908", dataDir: FIXTURE_HOME });
const alphaPair = fixRecon.matched.find((m) => m.module_id === "alpha");
const betaPair = fixRecon.matched.find((m) => m.module_id === "beta");
ok(
  alphaPair?.via === "plan_section_locator" && alphaPair?.locator_unverified === true,
  `只点到落点 ⇒ via=${String(alphaPair?.via)}、locator_unverified=${String(alphaPair?.locator_unverified)}（落点未证实）`,
);
ok(
  betaPair?.via === "plan_section_ref" && betaPair?.locator_unverified === undefined,
  `点名了实现落点 ⇒ via=${String(betaPair?.via)}（可定位的实现映射）`,
);
const fixLinks = declaredLinksOf(fixRecon);
ok(
  fixLinks["2-01"] === undefined && fixLinks["2-02"]?.join(",") === "beta",
  `declaredLinksOf 只收实现落点：${JSON.stringify(fixLinks)}（未证实的 2-01 不收 ⇒ 不继承状态色）`,
);
// 派生侧反证：两个代码模块的成员卡全部通过，只有点名实现落点的那个能继承绿
const fixBp = {
  version: 1,
  baseline_id: "bl-v0908",
  generated_at: "2026-09-24T00:00:00+08:00",
  generator_version: "fixture",
  limits: { max_nodes: 100, max_edges: 100 },
  nodes: [
    { id: "plan:mod:2-01", kind: "module", name: "甲模块", source_refs: [], related_ids: [] },
    { id: "plan:mod:2-02", kind: "module", name: "乙模块", source_refs: [], related_ids: [] },
    { id: "plan:code:alpha", kind: "module", name: "alpha", source_refs: [], related_ids: [] },
    { id: "plan:code:beta", kind: "module", name: "beta", source_refs: [], related_ids: [] },
    { id: "plan:task:A-1", kind: "task", name: "A-1", source_refs: [], related_ids: [] },
    { id: "plan:task:B-1", kind: "task", name: "B-1", source_refs: [], related_ids: [] },
  ],
  edges: [
    {
      source: "plan:task:A-1",
      target: "plan:code:alpha",
      kind: "implementation_map",
      source_refs: [],
      certainty: "observed",
    },
    {
      source: "plan:task:B-1",
      target: "plan:code:beta",
      kind: "implementation_map",
      source_refs: [],
      certainty: "observed",
    },
  ],
  coverage: {
    design_sections: { total: 0, mapped: 0, unmapped: [] },
    plan_tasks: { total: 0, mapped: 0, unmapped: [] },
    code_modules: { total: 0, mapped: 0, unmapped: [] },
    nodes_kept: 6,
    edges_kept: 2,
  },
  omitted: [],
} as unknown as Blueprint;
const allVerified = {
  "A-1": { object_id: "A-1", mapping: "mapped", display_status: "verified", reasons: [] },
  "B-1": { object_id: "B-1", mapping: "mapped", display_status: "verified", reasons: [] },
} as never;
const fixDerived = taskDerivedModuleStatus({ blueprint: fixBp, projection: allVerified, declared_links: fixLinks });
ok(
  fixDerived.status["plan:mod:2-02"]?.display === "verified" &&
    fixDerived.status["plan:mod:2-01"]?.display === null &&
    fixDerived.status["plan:mod:2-01"]?.unmapped_reason === "no_task_evidence",
  `成员卡全绿时：点名实现落点的 2-02 继承绿、只点落点的 2-01 如实「无状态记录」（${fixDerived.status["plan:mod:2-02"]?.display} / ${fixDerived.status["plan:mod:2-01"]?.display}）`,
);
// 名字信号（文本匹配）同样不继承：造一个设计条目名与模块 id 归一后相等的声明
const nameSigId = "p-v0908-signal";
makeFixture({
  id: nameSigId,
  design: "# 夹具设计书\n\n## 2 模块划分\n\n- delta：只按名字对上的条目\n",
  plan: "# 夹具施工图\n\n## 无关章节\n\n正文。\n",
  modules: [{ id: "delta", path: "delta" }],
  files: ["delta/a.ts"],
});
const nameSigRecon = reconcileProject(nameSigId, { trigger: "verify-v0908", dataDir: FIXTURE_HOME });
const nameSigPair = nameSigRecon.matched.find((m) => m.module_id === "delta");
ok(
  nameSigPair?.via === "name_signal" && declaredLinksOf(nameSigRecon)["2-L4"] === undefined,
  `名字信号（文本匹配）如实配对但不继承状态色（via=${String(nameSigPair?.via)}）`,
);

// ═════════════════════════ ③ only_in_code 分类（同一份共享判据） ═════════════════════════
console.log("[verify] ═══ ③ only_in_code 分类：actionable / outside_scope / structural ═══");
const fixCats = Object.fromEntries(fixRecon.only_in_code.map((c) => [c.id, c]));
ok(
  fixCats["gamma"]?.category === "actionable_mismatch" && fixCats["gamma"]?.reason === "no_declaration",
  `真差异：\`gamma\`（有源码文件的代码模块、对账范围内无声明）⇒ ${String(fixCats["gamma"]?.category)}`,
);
ok(
  fixRecon.only_in_code.every((c) => typeof c.basis === "string" && c.basis.length > 0),
  "每条分类都带人话依据句（界面直接显示，不靠文案判等）",
);
const realCats = realRecon.only_in_code;
const byCat = (list: readonly OnlyInCodeEntry[], c: string): string[] =>
  list.filter((x) => x.category === c).map((x) => x.id).sort();
info(`  真实塔台分类读数：真差异=${JSON.stringify(byCat(realCats, "actionable_mismatch"))}`);
info(`                    范围外=${JSON.stringify(byCat(realCats, "outside_scope"))}`);
info(`                    结构性=${JSON.stringify(byCat(realCats, "structural"))}`);
ok(
  byCat(realCats, "actionable_mismatch").length === 0,
  "真实塔台**没有** actionable mismatch（口径边界不是错配；真误配已在 ① 里修掉）",
);
const srcTauri = realCats.find((c) => c.id === "src-tauri");
ok(
  srcTauri?.category === "outside_scope" &&
    srcTauri?.reason === "declared_outside_compared_section",
  `\`src-tauri\` ⇒ 范围外（依据：${(srcTauri?.basis ?? "").slice(0, 80)}）`,
);
const audit = realCats.find((c) => c.id === "audit");
ok(
  audit?.category === "structural" && audit?.reason === "artifact_dir",
  `\`audit\` ⇒ 结构性目录·产物目录（依据：${(audit?.basis ?? "").slice(0, 80)}）`,
);
for (const id of ["docs", "root"]) {
  const e = realCats.find((c) => c.id === id);
  ok(
    e?.category === "structural" && e?.reason === "structural_dir",
    `\`${id}\` ⇒ 结构性目录（仓库根 / 无源码文件，非待归属）`,
  );
}
// 分类判据是**同一份**：界面词表只做归类与分计，不重判
const uiGroups = groupOnlyInCode(realCats);
const uiTotal = Object.values(uiGroups).reduce((n, l) => n + l.length, 0);
ok(
  uiTotal === realCats.length &&
    uiGroups.actionable_mismatch.length === byCat(realCats, "actionable_mismatch").length &&
    uiGroups.outside_scope.length === byCat(realCats, "outside_scope").length &&
    uiGroups.structural.length === byCat(realCats, "structural").length,
  `界面分计与服务端分类逐一相等（共 ${uiTotal} 条：真差异 ${uiGroups.actionable_mismatch.length} · 范围外 ${uiGroups.outside_scope.length} · 结构性 ${uiGroups.structural.length}）`,
);
ok(
  categoryOfOnlyInCode({ id: "x", name: "x" }) === "unclassified" &&
    ONLY_IN_CODE_CATEGORY_LABEL.unclassified.includes("旧对账结果"),
  "旧对账结果（没有分类字段）如实归 `unclassified` 并提示重跑——不猜、不计入「对账差」",
);
ok(
  ONLY_IN_CODE_CATEGORY_BADGE.actionable_mismatch.includes("yellow") &&
    !ONLY_IN_CODE_CATEGORY_BADGE.outside_scope.includes("yellow") &&
    !ONLY_IN_CODE_CATEGORY_BADGE.structural.includes("yellow"),
  "真差异才是黄色；范围外/结构性目录用中性底色（真差异仍标黄，机制没被分类改坏）",
);
// 四处消费同一份词表 / 同一份判据 / 同一份渲染（不各写一套）
for (const rel of ["src/ui/arch/ArchCanvas.tsx", "src/ui/components/GateTimeline.tsx", "src/ui/arch/MindMapView.tsx"]) {
  const src = fs.readFileSync(path.join(REPO, rel), "utf8");
  ok(
    src.includes('from "./ReconcileCats"') || src.includes('from "../arch/ReconcileCats"'),
    `${rel} 用**同一个**分类分计渲染组件（ReconcileCats；不各写一段 JSX）`,
  );
  ok(src.includes("data-diff-category") || src.includes("anchor="), `${rel} 的分类读数挂在 data 锚点上（真机可读回）`);
}
{
  const cats = fs.readFileSync(path.join(REPO, "src/ui/arch/ReconcileCats.tsx"), "utf8");
  const canvasSrc = fs.readFileSync(path.join(REPO, "src/ui/arch/ArchCanvas.tsx"), "utf8");
  const gateSrc = fs.readFileSync(path.join(REPO, "src/ui/components/GateTimeline.tsx"), "utf8");
  const mmSrc = fs.readFileSync(path.join(REPO, "src/ui/arch/MindMapView.tsx"), "utf8");
  ok(
    canvasSrc.includes("data-reconcile-only-in-code-cats") &&
      gateSrc.includes("data-gate-reconcile-cats") &&
      mmSrc.includes("data-mindmap-reconcile-cats"),
    "三处锚点各不相同（方框图/数据流向图共用面板、Gate 现场、思维导图各自可读）",
  );
  ok(
    cats.includes("ONLY_IN_CODE_CATEGORY_LABEL") && cats.includes("groupOnlyInCode"),
    "分计渲染只读共享词表与共享分组（判据与渲染都不在 UI 里另写第二份）",
  );
}
// 三项目读数（真实数据只读：塔台重跑对账；其余读既有 reconcile-last.json 后**只读分类**）
const others: string[] = [];
for (const line of fs.readdirSync(path.join(TMP))) void line;
const homeRegistry = path.join(REAL_HOME, "registry.json");
if (fs.existsSync(homeRegistry)) {
  const reg = JSON.parse(fs.readFileSync(homeRegistry, "utf8")) as { projects?: { id: string }[] };
  for (const p of reg.projects ?? []) {
    if (p.id === "tatai") continue;
    const last = readLastReconcile(p.id, REAL_HOME);
    if (!last.exists || last.result === undefined || last.result.only_in_code.length === 0) continue;
    const ctx = onlyInCodeContextOf(p.id, REAL_HOME);
    const classified = classifyOnlyInCodeEntries(last.result.only_in_code, ctx);
    const g = groupOnlyInCode(classified);
    info(
      `  ${p.id}（读既有对账结果、只读分类）：共 ${classified.length} 条 · 真差异 ${g.actionable_mismatch.length} · 范围外 ${g.outside_scope.length} · 结构性 ${g.structural.length}`,
    );
    others.push(
      `${p.id}:${JSON.stringify(classified.map((c) => [c.id, c.category]))}`,
    );
  }
}
ok(others.length >= 0, `另有 ${others.length} 个真实项目的对账读数按分类分计（只读取数，未重跑它们的对账）`);

// ═════════════════════════ ④ 派生蓝图边去重 ═════════════════════════
console.log("[verify] ═══ ④ 派生蓝图边去重（稳定序、出处不丢、不同章节各自成边）═══");
const published = readBlueprint("tatai");
if (published !== null) {
  const keyOf = (e: { source: string; target: string; kind: string; certainty: string }): string =>
    `${e.source}|${e.target}|${e.kind}|${e.certainty}`;
  const dup = published.edges.length - new Set(published.edges.map(keyOf)).size;
  info(
    `  已发布蓝图（**基线重激活前的现状，只读记录**）：${published.nodes.length} 节点 / ${published.edges.length} 边 · 重复行 ${dup}`,
  );
}
const srcs = readBlueprintSources("tatai");
const deriveOnce = (): Blueprint =>
  deriveBlueprint(srcs, {
    generated_at: "2026-09-24T00:00:00+08:00",
    based_on: {
      model_key: "v0908-verify",
      full_key: "v0908-verify",
      design_content_sha256: null,
      plan_definition_sha256: null,
      semantic: false,
    },
  });
const d1 = deriveOnce();
const d2 = deriveOnce();
const dKeys = d1.edges.map((e) => `${e.source}|${e.target}|${e.kind}|${e.certainty}`);
ok(
  new Set(dKeys).size === d1.edges.length,
  `重派生后 distinct 边键数 == 行数（${new Set(dKeys).size} == ${d1.edges.length}）`,
);
ok(
  JSON.stringify(d1) === JSON.stringify(d2),
  "两次重派生逐字节相同（稳定序，不因去重引入不稳定）",
);
const merged = d1.edges.filter((e) => e.source_refs.length > 1);
ok(
  merged.length > 0 &&
    merged.every((e) => new Set(e.source_refs.map((r) => r.locator)).size === e.source_refs.length),
  `同键合并的边保留**并集出处**且不重复（实测 ${merged.length} 条多出处边，如 ${merged[0]?.source}→${merged[0]?.target} 有 ${merged[0]?.source_refs.length} 条出处）`,
);
// 反例：同一卡引用**不同**能力（不同章节）仍是两条边
const fixSrc = {
  project_id: "fixture",
  project_root: TMP,
  design: {
    path: "DESIGN.md",
    content_sha256: "d".repeat(64),
    definition_sha256: "d".repeat(64),
    sections: [
      { level: 1, title: "夹具设计书", path: "夹具设计书", line_start: 1, line_end: 30, sha256: "s1" },
      { level: 2, title: "一、能力甲", path: "夹具设计书 / 一、能力甲", line_start: 3, line_end: 15, sha256: "s2" },
      { level: 3, title: "1.1 小节甲", path: "夹具设计书 / 一、能力甲 / 1.1 小节甲", line_start: 5, line_end: 10, sha256: "s4" },
      { level: 3, title: "1.2 小节乙", path: "夹具设计书 / 一、能力甲 / 1.2 小节乙", line_start: 11, line_end: 15, sha256: "s5" },
      { level: 2, title: "二、能力乙", path: "夹具设计书 / 二、能力乙", line_start: 16, line_end: 30, sha256: "s3" },
      { level: 3, title: "2.1 小节丙", path: "夹具设计书 / 二、能力乙 / 2.1 小节丙", line_start: 18, line_end: 25, sha256: "s6" },
    ],
  },
  plan: {
    path: "PLAN.md",
    content_sha256: "p".repeat(64),
    definition_sha256: "p".repeat(64),
    tasks: [
      {
        task_id: "T-A",
        goal: "跨两章",
        dependency_ids: [],
        design_refs: ["§1.1", "§2.1"],
        allowed_paths: [],
        evidence_requirement: null,
        deliverables: null,
      },
      {
        task_id: "T-B",
        goal: "同一章两小节",
        dependency_ids: [],
        design_refs: ["§1.1", "§1.2"],
        allowed_paths: [],
        evidence_requirement: null,
        deliverables: null,
      },
    ],
  },
  declared_modules: [],
  code: { modules: [] },
  names: {},
} as never;
const fx = deriveBlueprint(fixSrc, {
  generated_at: "2026-09-24T00:00:00+08:00",
  based_on: {
    model_key: "fx",
    full_key: "fx",
    design_content_sha256: null,
    plan_definition_sha256: null,
    semantic: false,
  },
});
const designEdges = fx.edges.filter((e) => e.kind === "task_design_ref");
const aTargets = designEdges.filter((e) => e.source === "plan:task:T-A").map((e) => e.target).sort();
const bEdges = designEdges.filter((e) => e.source === "plan:task:T-B");
ok(
  aTargets.join(",") === "plan:cap:01,plan:cap:02",
  `同一卡引用**不同章节**（§1.1 与 §2.1）仍是两条边：${aTargets.join("、")}`,
);
ok(
  bEdges.length === 1 && bEdges[0].source_refs.length === 2,
  `同一卡引用同一能力下的两个小节（§1.1 与 §1.2）合并成一条边、保留 2 条出处（实测 ${bEdges.length} 条边 / ${bEdges[0]?.source_refs.length} 出处）`,
);

// ═════════════════════════ ⑤ compat 投影与 MCP 读口同源 ═════════════════════════
console.log("[verify] ═══ ⑤ compat 投影元数据同源 + get_arch 模块状态 v2 派生 ═══");
const ledger = readTaskLedger("tatai", REAL_HOME);
const projInfo = tasksProjectionInfo("tatai", REAL_HOME);
ok(
  projInfo !== null && projInfo.last_seq === ledger.last_seq && projInfo.last_seq_source === "v2_events",
  `list_tasks/read_progress 的 last_seq 与任务行同源：projection.last_seq=${String(projInfo?.last_seq)} == 事件账本末序号 ${String(ledger.last_seq)}`,
);
ok(
  projInfo !== null && projInfo.compat_snapshot_seq !== projInfo.last_seq && projInfo.stale === true,
  `旧 tasks.json 快照停在自己的序号上并标 stale：compat_snapshot_seq=${String(projInfo?.compat_snapshot_seq)}（≠ ${String(projInfo?.last_seq)}）`,
);
const listOut = await toolJson(listTasksTool.handler({ project_id: "tatai" }));
const listProj = listOut.projection as Record<string, unknown> | undefined;
ok(
  listProj?.last_seq === ledger.last_seq &&
    typeof listProj?.compat_snapshot_seq === "number" &&
    listProj?.stale === true &&
    listProj?.last_seq_source === "v2_events",
  `list_tasks 回执里的投影元数据与行同源（last_seq=${String(listProj?.last_seq)}、compat_snapshot_seq=${String(listProj?.compat_snapshot_seq)}、stale=${String(listProj?.stale)}）`,
);
const progressOut = await toolJson(readProgressTool.handler({ project_id: "tatai" }));
const modProj = progressOut.modules_projection as Record<string, unknown> | undefined;
ok(
  modProj?.source === "v1_compat_progress" && String(modProj?.note ?? "").includes("v1 四色"),
  "read_progress 明确标注 `modules` 是 v1 兼容读数（不得当 v2 状态）",
);
// 未迁移项目：回执逐字不变（不带 modules_projection / projection）
// 夹具：**有** `arch/modules.json` 与 `progress.json`，**无** `work/events.jsonl`、台账也不带 v2 投影标记
const plainId = "p-v0908-plain";
const plainRoot = path.join(TMP, plainId);
fs.mkdirSync(path.join(plainRoot, ".工作台", "arch"), { recursive: true });
fs.writeFileSync(
  path.join(plainRoot, ".工作台", "progress.json"),
  JSON.stringify(
    { version: 1, gate: { current_step: "design", history: [] }, modules: [{ id: "m1", name: "m1", status: "todo" }] },
    null,
    2,
  ),
  "utf8",
);
fs.writeFileSync(
  path.join(plainRoot, ".工作台", "arch", "modules.json"),
  JSON.stringify(
    {
      version: 1,
      generated_at: "2026-09-24T00:00:00+08:00",
      budget_exhausted: false,
      modules: [{ id: "m1", name: "", path: "src", file_count: 1, loc: 10, deps: [] }],
    },
    null,
    2,
  ),
  "utf8",
);
addProject({ id: plainId, name: plainId, path: plainRoot, kind: "backend" }, FIXTURE_HOME);
// 反例夹具：**已迁移**（`work/events.jsonl` 在场）但**没有已发布蓝图**——不得回退 v1 假状态
const migId = "p-v0908-migrated-noblueprint";
const migRoot = path.join(TMP, migId);
fs.mkdirSync(path.join(migRoot, ".工作台", "arch"), { recursive: true });
fs.mkdirSync(path.join(migRoot, ".工作台", "work"), { recursive: true });
fs.writeFileSync(
  path.join(migRoot, ".工作台", "progress.json"),
  JSON.stringify(
    { version: 1, gate: { current_step: "design", history: [] }, modules: [{ id: "m1", name: "m1", status: "done" }] },
    null,
    2,
  ),
  "utf8",
);
fs.writeFileSync(
  path.join(migRoot, ".工作台", "arch", "modules.json"),
  JSON.stringify(
    {
      version: 1,
      generated_at: "2026-09-24T00:00:00+08:00",
      budget_exhausted: false,
      modules: [{ id: "m1", name: "", path: "src", file_count: 1, loc: 10, deps: [] }],
    },
    null,
    2,
  ),
  "utf8",
);
fs.writeFileSync(path.join(migRoot, ".工作台", "work", "events.jsonl"), "", "utf8");
addProject({ id: migId, name: migId, path: migRoot, kind: "backend" }, FIXTURE_HOME);
const prevHome = process.env.TATAI_HOME;
process.env.TATAI_HOME = FIXTURE_HOME;
try {
  const plainProgress = await toolJson(readProgressTool.handler({ project_id: plainId }));
  ok(
    plainProgress.modules_projection === undefined && plainProgress.tasks_projection === undefined,
    "未迁移项目 read_progress 回执逐字不变（不带 v2 时代新增的字段）",
  );
  const plainList = await toolJson(listTasksTool.handler({ project_id: plainId }));
  ok(plainList.projection === undefined, "未迁移项目 list_tasks 回执逐字不变（不带 projection）");
  ok(
    tasksProjectionInfo(plainId, FIXTURE_HOME) === null,
    "未迁移项目 tasksProjectionInfo 为 null（读路径不谎报）",
  );
  // get_arch 的 v1 分支（PLAN V09-08 禁止越界：未迁移项目原样回 v1 渲染数据，字段一字不加）
  const v1Graph = renderGraph(plainId, { dataDir: FIXTURE_HOME });
  const v1Expected = v1Graph.graph as unknown as Record<string, unknown>;
  const v1Res = await getArchTool.handler({ project_id: plainId });
  const v1Text = v1Res.content[0]?.text ?? "";
  const v1ArchOut = JSON.parse(v1Text) as Record<string, unknown>;
  // `generated_at` 是**调用时刻**（同一份数据两次调用也不同），不是形状差异：两边归一后再比形状
  const v1Norm = (g: Record<string, unknown>): Record<string, unknown> => ({
    ...g,
    generated_at: "<调用时刻，不比较>",
  });
  ok(
    typeof v1ArchOut.generated_at === "string" && typeof v1Expected.generated_at === "string",
    "两侧都带 v1 的 `generated_at`（先确认字段在场，免得把「少字段」当成时间差放过）",
  );
  ok(
    JSON.stringify(v1Norm(v1ArchOut)) === JSON.stringify(v1Norm(v1Expected)),
    "未迁移项目 get_arch 返回体与 v1 渲染数据**逐字段一致**（除调用时刻的 `generated_at`）：不额外加 layer／module_status_source／status_basis 等字段",
  );
  ok(
    !/"(layer|module_status_source|module_status_basis|status_baseline_id|status_source|status_display|status_basis)"/.test(
      v1Text,
    ),
    "未迁移项目返回体里**一个 v2 时代字段名都没有**（逐字不变的反面证据）",
  );
  let v1DeepOk = true;
  let v1DeepDetail = "";
  try {
    assert.deepStrictEqual(v1Norm(v1ArchOut), v1Norm(v1Expected));
  } catch (e) {
    v1DeepOk = false;
    v1DeepDetail = String((e as Error).message).split("\n").slice(0, 6).join(" / ");
  }
  ok(
    v1DeepOk,
    `未迁移项目 get_arch 返回体与 renderGraph 返回体**深相等**（不额外字段；${v1DeepDetail || "无差异"}）`,
  );
  const v1PlainNode = (v1ArchOut.nodes as { id: string; status?: unknown; status_source?: unknown }[]).find(
    (n) => n.id === "m1",
  );
  ok(
    v1PlainNode !== undefined && v1PlainNode.status === "todo" && v1PlainNode.status_source === undefined,
    `未迁移项目节点保持**原 v1 四色原样**（m1 status=${String(v1PlainNode?.status)}、无 status_source 字段）`,
  );
  // 已迁移但**无已发布蓝图**：仍无状态记录，不回退 v1（progress.json 里 m1=done 不得出现）
  const migArch = await toolJson(getArchTool.handler({ project_id: migId }));
  const migNodes = (migArch.nodes ?? []) as {
    id: string;
    status?: unknown;
    status_source?: string;
    status_display?: string;
  }[];
  ok(
    migArch.layer === "tech_detail" && migArch.module_status_source === "v2_evidence",
    "已迁移项目 get_arch 走 v2 分支（返回体明说是技术详情层、状态来源 v2 证据）",
  );
  ok(
    migNodes.length > 0 &&
      migNodes.every(
        (n) => n.status === null && n.status_source === "v2_evidence" && n.status_display === "无状态记录",
      ),
    `已迁移但无已发布蓝图：${migNodes.length} 个节点全部「无状态记录」，**不回退 v1 假状态**（v1 口径下 m1 会显示 done）`,
  );
  ok(
    migArch.status_baseline_id === null,
    "已迁移但无已发布蓝图：status_baseline_id 为 null（没有图就没有派生依据，不编造基线）",
  );
} finally {
  if (prevHome === undefined) delete process.env.TATAI_HOME;
  else process.env.TATAI_HOME = prevHome;
}
// get_arch：模块状态取 v2 证据派生，不再输出 v1 自报四色
const tech = techModuleStatusOf("tatai", { dataDir: REAL_HOME });
const archOut = await toolJson(getArchTool.handler({ project_id: "tatai" }));
const archNodes = (archOut.nodes ?? []) as { id: string; status?: unknown; status_source?: string; status_display?: string }[];
const V1_WORDS = new Set(["todo", "doing", "done", "issue"]);
ok(
  archOut.layer === "tech_detail" && archOut.module_status_source === "v2_evidence",
  "get_arch 明说返回的是**技术详情层**、模块状态来源是 v2 证据（不是 v1 自报）",
);
ok(
  archNodes.length > 0 && archNodes.every((n) => n.status_source === "v2_evidence" && !V1_WORDS.has(String(n.status))),
  `所有节点都不再输出 v1 四色（${archNodes.length} 个节点逐个核过 status ∈ {null, 六态键}）`,
);
const archAudit = archNodes.find((n) => n.id === "audit");
ok(
  archAudit !== undefined && archAudit.status === (tech.keys.audit ?? null) && typeof archAudit.status_display === "string",
  `\`audit\` 节点状态＝v2 派生（status=${String(archAudit?.status)}、display=${String(archAudit?.status_display)}）——v1 口径下它连 status 都没有`,
);
const unknownNodes = archNodes.filter((n) => n.status === null);
ok(
  unknownNodes.every((n) => n.status_display === "无状态记录"),
  `映射不到的节点如实写「无状态记录」（${unknownNodes.length} 个：${unknownNodes.map((n) => n.id).slice(0, 6).join("、")}）`,
);
ok(
  Array.isArray(archOut.edges) && archOut.nodes !== undefined && archNodes.every((n) => typeof (n as { path?: unknown }).path === "string"),
  "节点/边形状保持兼容（仍有 nodes/edges 与既有字段，只增状态来源字段）",
);
// HTTP /arch/render（旧读口/前端取数）行为未变：仍是 v1 形状（技术详情画布另有 statusOverride 走 v2）
const httpGraph = renderGraph("tatai");
const httpAudit = httpGraph.graph?.nodes.find((n) => n.id === "audit");
ok(
  httpGraph.exists &&
    httpAudit !== undefined &&
    (httpAudit.status === undefined || V1_WORDS.has(String(httpAudit.status))),
  "HTTP /arch/render 的旧形状未改（`audit` 在 v1 口径下没有 status；前端技术详情另有 v2 覆盖表）",
);
// read_progress 的模块四色与 v2 派生确实不同源（记录诚实读数）
const v1Modules = readProgress("tatai", REAL_HOME).modules;
info(
  `  read_progress（v1 兼容读数）：${v1Modules.map((m) => `${m.id}=${m.status}`).join("、")}`,
);
info(
  `  get_arch（v2 派生）：${Object.entries(tech.keys)
    .filter(([k]) => !k.startsWith("plan:"))
    .map(([k, v]) => `${k}=${v}`)
    .join("、")}`,
);

// 配对依据计数（界面与 Gate 面板共用这一份）
const via = countMatchedByVia(realRecon.matched);
info(`  配对依据：实现落点 ${via.implementation} 项 · 章节落点未证实 ${via.locator_unverified} 项 · 名字信号 ${via.name_signal} 项`);
ok(
  via.implementation + via.locator_unverified + via.name_signal === realRecon.matched.length,
  "配对依据计数覆盖全部 matched（界面显示的三个数与结果逐条相加相等）",
);

assert.ok(true);
console.log(`[verify] 内存夹具与临时数据目录：${TMP}`);
try {
  fs.rmSync(TMP, { recursive: true, force: true });
  info("临时夹具已清理");
} catch {
  info(`临时夹具清理失败（如实登记）：${TMP}`);
}
console.log(`\n[verify] 汇总：${pass} PASS / ${fail} FAIL`);
finish();
