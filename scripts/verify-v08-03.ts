// V08-03 验证脚本（tsx 跑）：模块层「验证通过」派生（DESIGN.md 附录 D）。
//
// 覆盖（每条对着卡面/附录的一条）：
//   ① 映射增强：卡面「声明真实路径」（文件责任段 ＋ 完成证据/交付里的反引号路径）∩ 代码模块；
//      根模块 `.` 只在该卡没有更具体命中时才算命中；同一条边只记一次；认不出的路径不硬凑；
//   ② 状态派生：模块验证通过 ＝ 映射到它的卡**全部** verified 且映射非空（替换 V08-02 的封顶）；
//      不是全部通过 ⇒ §4.2 优先级序取最高、**不给绿**；没有映射 ⇒ 如实「无状态记录」；
//      声明模块按审定材料索引继承对应代码模块的状态；能力不另设验证、由成员派生；
//   ③ 文案人话化：模块验证通过的短标点明「已存在」；六态 `full` 与服务端口径仍逐字一致；
//   ④ 红线：模型整理的线索边（declared/inferred/unverified）不参与判据；空映射/无证据不许绿；
//      真 todo（planned）不染绿。
//
// 上界与红线：不发明任何事件类型；不写完成色到任何源；只读蓝图 + 状态投影 + 对账配对。
import assert from "node:assert/strict";
import {
  MODULE_VERIFIED_SHORT,
  PROJECT_VIEWS,
  buildViewModel,
  canonicalScopeStatusOf,
  directStatusOf,
  noStatusRecordOf,
  taskDerivedModuleStatus,
} from "../src/ui/arch/projectGraph";
import {
  DISPLAY_STATUS_KEYS,
  DISPLAY_STATUS_PALETTE,
  NO_STATUS_RECORD_KEY,
} from "../src/ui/arch/statusColor";
import {
  backtickedPathTokens,
  declaredRealPathsOf,
  deriveBlueprint,
  looksLikeRepoPath,
  normalizeRepoPath,
  pathIntersectsPath,
} from "../src/arch/blueprint";
import { DISPLAY_STATUS_LABELS } from "../src/server/work/statusProjection";
import { declaredLinksFromMatched } from "../src/shared/reconcileLinks";

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

// ═════════════════════════ ① 映射增强 ═════════════════════════
console.log("[verify] ═══ ① 卡面声明真实路径 ∩ 代码模块（附录 D 映射来源①）═══");
const CODE_MODULES = [
  { id: "src", path: "src" },
  { id: "docs", path: "docs" },
  { id: "root", path: "." },
];
ok(
  looksLikeRepoPath("src/core/a.py") && looksLikeRepoPath("templates/.工作台.example/") && looksLikeRepoPath("pyproject.toml"),
  "路径形态判据：带目录的相对路径、中文目录名、单段文件名都算真实路径",
);
ok(
  !looksLikeRepoPath("C:/x/y") && !looksLikeRepoPath("/abs/path") && !looksLikeRepoPath("../../escape") && !looksLikeRepoPath("§4.2") && !looksLikeRepoPath("readTaskLedger"),
  "认不出的不当路径：盘符/绝对路径/上跳/章节号/裸标识符都不算（不硬凑）",
);
ok(
  pathIntersectsPath("src", "src/core/a.py") && pathIntersectsPath("docs/a.md", "docs"),
  "路径相交：模块目录含声明路径、声明目录含模块路径，两个方向都算",
);
ok(
  !pathIntersectsPath("src", "src-other/x.ts") && !pathIntersectsPath("src", "."),
  "目录边界对齐：`src` 不覆盖 `src-other`；根靠调用方单独处理（不用 `.` 一把糊）",
);
const tokens = backtickedPathTokens("看 `config/settings.toml [storage] [hnsw]`、`src/a.py` 与 `README`");
ok(
  tokens.includes("config/settings.toml") && tokens.includes("src/a.py") && !tokens.includes("README"),
  `反引号里的路径 token 逐个取出、方括号修饰语切掉、裸名字丢掉（取到 ${tokens.join("、")}）`,
);
const declared = declaredRealPathsOf({
  allowed_paths: ["  文件责任里的 `/x` 不算", "src/server/work/"],
  evidence_requirement: "见 `scripts/verify.ts`",
  deliverables: ["交付 `docs/scale.md`"],
});
ok(
  declared.includes("src/server/work") && declared.includes("scripts/verify.ts") && declared.includes("docs/scale.md") && !declared.includes("  文件责任里的 `/x` 不算"),
  `卡面声明真实路径 = 文件责任段 ＋ 完成证据 ＋ 交付（去重保序）：${declared.join(" | ")}`,
);

// 真派生：三张卡 → 模块（根模块只在没有更具体命中时算）
const bp = deriveBlueprint(
  {
    project_id: "fixture",
    project_root: "/tmp/fixture",
    design: {
      path: "DESIGN.md",
      content_sha256: "d".repeat(64),
      definition_sha256: "d".repeat(64),
      sections: [
        { level: 1, title: "夹具设计书", path: "夹具设计书", line_start: 1, line_end: 20, sha256: "s1" },
        { level: 2, title: "一、能力甲", path: "夹具设计书 / 一、能力甲", line_start: 3, line_end: 20, sha256: "s2" },
        { level: 3, title: "1.1 模块清单", path: "夹具设计书 / 一、能力甲 / 1.1 模块清单", line_start: 5, line_end: 14, sha256: "s3" },
      ],
    },
    plan: {
      path: "PLAN.md",
      content_sha256: "p".repeat(64),
      definition_sha256: "p".repeat(64),
      tasks: [
        { task_id: "T-1", goal: "核心实现", dependency_ids: [], design_refs: ["§1.1"], allowed_paths: ["src/core/a.py"], evidence_requirement: "`src/core/a.py`", deliverables: null },
        { task_id: "T-2", goal: "收尾实现", dependency_ids: ["T-1"], design_refs: [], allowed_paths: [], evidence_requirement: "`src/core/b.py`", deliverables: null },
        { task_id: "T-3", goal: "文档", dependency_ids: [], design_refs: [], allowed_paths: [], evidence_requirement: "`docs/readme.md`", deliverables: null },
        { task_id: "T-4", goal: "只看根目录", dependency_ids: [], design_refs: [], allowed_paths: [], evidence_requirement: "`pyproject.toml`", deliverables: null },
      ],
    },
    declared_modules: [
      { stable_id: "01", name: "src/", section_path: "夹具设计书 / 一、能力甲 / 1.1 模块清单" },
      { stable_id: "02", name: "docs/", section_path: "夹具设计书 / 一、能力甲 / 1.1 模块清单" },
    ],
    code: { modules: CODE_MODULES },
    // 2026-09-25 判据细化：单段声明 token 落根模块须「仓库根真实存在」——夹具如实给出根级文件清单
    // （T-4 声明的 `pyproject.toml` 是根级真实文件 ⇒ 落根模块成立；不给清单则一律不产根模块映射）
    repo_root_files: ["pyproject.toml"],
    names: {},
  } as never,
  {
    based_on: {
      model_key: "fixture-key",
      full_key: "fixture-key",
      design_content_sha256: "d".repeat(64),
      plan_definition_sha256: "p".repeat(64),
      semantic: false,
    },
  },
);
const impl = bp.edges.filter((e) => e.kind === "implementation_map");
const implPairs = impl.map((e) => `${e.source.replace("plan:task:", "")}→${e.target.replace("plan:code:", "")}`).sort();
ok(
  implPairs.join(",") === "T-1→src,T-2→src,T-3→docs,T-4→root",
  `实现映射按声明真实路径派生：${implPairs.join(" , ")}`,
);
ok(
  impl.every((e) => e.certainty === "observed") && new Set(implPairs).size === implPairs.length,
  `${impl.length} 条实现映射边全部 certainty=observed 且**同一条边只记一次**（去重后 ${new Set(implPairs).size} 条）`,
);
ok(
  !implPairs.some((p) => p.startsWith("T-1→root") || p.startsWith("T-2→root")),
  "根模块只在该卡没有更具体命中时才算命中（T-1/T-2 有 src，就不算 root）",
);
info(`  夹具蓝图：${bp.nodes.length} 节点 / ${bp.edges.length} 边`);

// ═════════════════════════ ② 状态派生 ═════════════════════════
console.log("[verify] ═══ ② 模块/能力「验证通过」派生（附录 D）═══");
const proj = (status: string | null, mapping = "mapped") =>
  ({ object_id: "x", mapping, display_status: status, reasons: [] }) as never;
const P = {
  "T-1": proj("verified"),
  "T-2": proj("in_progress"),
  "T-3": proj("verified"),
  "T-4": proj("in_progress"),
} as never;
const links = { "01": ["src"], "02": ["docs"] } as never;
const derived = taskDerivedModuleStatus({ blueprint: bp, projection: P, declared_links: links });
ok(
  derived.status["plan:code:docs"].display === "verified" && derived.status["plan:code:docs"].short === MODULE_VERIFIED_SHORT,
  `成员卡全部 verified ⇒ 模块**验证通过（绿）**，短标「${derived.status["plan:code:docs"].short}」`,
);
ok(
  derived.status["plan:code:src"].display === "in_progress",
  `成员里有没通过/在跑的卡（T-1 verified + T-2 in_progress）⇒ 取最高状态、**不给绿**（${derived.status["plan:code:src"].display}）`,
);
ok(
  derived.status["plan:code:root"].display === "in_progress",
  "只被真 todo/在跑的卡映射的模块不得判绿",
);
ok(
  derived.status["plan:mod:01"].display === "in_progress" && derived.status["plan:mod:02"].display === "verified",
  `声明模块按审定材料索引继承对应代码模块（01→src=${derived.status["plan:mod:01"].display}、02→docs=${derived.status["plan:mod:02"].display}）`,
);
const noLink = taskDerivedModuleStatus({ blueprint: bp, projection: P, declared_links: { "01": ["nope"] } as never });
ok(
  noLink.status["plan:mod:01"].display === null && noLink.status["plan:mod:01"].unmapped_reason === "no_task_evidence",
  "声明模块没有对应代码模块 ⇒ 如实「无状态记录」（不硬凑一个落点）",
);
// V09-08 ①②：继承表的**入口判据**（附录 E.7 裁定①）——只有材料点名了实现落点的配对才继承
ok(
  JSON.stringify(
    declaredLinksFromMatched([
      { stable_id: "01", module_id: "src", via: "plan_section_ref" },
      { stable_id: "02", module_id: "templates", via: "plan_section_locator", locator_unverified: true },
      { stable_id: "03", module_id: "docs", via: "name_signal" },
    ]),
  ) === JSON.stringify({ "01": ["src"] }),
  "声明模块继承只收「点名了实现落点」的配对：落点未证实（plan_section_locator）与名字信号（name_signal）都不进继承表",
);
// 全部 verified 的极端：整张图的卡都过了 ⇒ 模块与声明模块都能绿
const allGreen = taskDerivedModuleStatus({
  blueprint: bp,
  projection: { "T-1": proj("verified"), "T-2": proj("verified"), "T-3": proj("verified"), "T-4": proj("verified") } as never,
  declared_links: links,
});
ok(
  allGreen.status["plan:code:src"].display === "verified" && allGreen.status["plan:mod:01"].display === "verified" && allGreen.status["plan:code:root"].display === "verified",
  "全部卡都 verified ⇒ 模块全部验证通过（空映射仍不算过：没有成员的模块仍走「无状态记录」）",
);
// 空映射 / 没有一个成员有状态结论
const emptyMembers = taskDerivedModuleStatus({ blueprint: bp, projection: {} as never });
ok(
  emptyMembers.status["plan:code:docs"].display === null && emptyMembers.status["plan:code:docs"].unmapped_reason === "members_without_status",
  "成员都没有状态结论 ⇒ 不着完成色（不空集判绿）",
);
ok(
  emptyMembers.status["plan:code:src"].member_count === 2,
  "成员账目仍如实记数量（2 张卡映射到 src）",
);

// 红线：模型整理的线索边不参与判据
const bpInferred = {
  ...bp,
  edges: [
    ...bp.edges,
    { source: "plan:task:T-2", target: "plan:code:docs", kind: "implementation_map", source_refs: [], certainty: "inferred" },
  ],
} as never;
const withInferred = taskDerivedModuleStatus({ blueprint: bpInferred, projection: P });
ok(
  withInferred.status["plan:code:docs"].display === "verified" && withInferred.tasks_by_module["plan:code:docs"].join(",") === "T-3",
  "模型推断（inferred）的实现映射边**不进成员账目**、也不参与「验证通过」判据（不给推断染绿/染红的机会）",
);

// 能力：状态**只读 canonical 义务层投影**（V09-55 返工；不再本地按成员汇总出一套绿公式）
console.log("[verify] ═══ ②b 能力：状态只读 canonical 义务层投影（判据不在此）═══");
const capProj = (display: string | null, mapping: "mapped" | "unmapped" = "mapped") =>
  ({ object_id: "cap", mapping, display_status: display, display_status_label: display, reasons: [] }) as never;
ok(
  canonicalScopeStatusOf(capProj("verified")).display === "verified",
  "canonical 投影 verified ⇒ 能力 verified（原样读出，本层不判绿）",
);
ok(
  canonicalScopeStatusOf(capProj("blocked")).display === "blocked",
  "canonical 投影 blocked ⇒ 能力 blocked（不被改写、不降成橙）",
);
ok(
  canonicalScopeStatusOf(null).unmapped_reason === "no_status_source" && canonicalScopeStatusOf(null).basis.includes("canonical"),
  "没有 canonical 范围投影 ⇒ 未知/未接入（不退回本地按成员汇总造绿）",
);
ok(
  canonicalScopeStatusOf(capProj(null, "unmapped")).display === null &&
    canonicalScopeStatusOf(capProj(null, "unmapped")).unmapped_reason === "object_unmapped",
  "canonical 未映射 ⇒ 能力不着完成色（不空集判绿；判据在 canonical 义务层）",
);

// 视图层：三种视图的成员口径与状态来源
const viewInput = { blueprint: bp, projection: P, module_status: derived.status } as never;
const arch = buildViewModel({ ...(viewInput as object), view: "architecture" } as never);
const func = buildViewModel({ ...(viewInput as object), view: "functional" } as never);
const archIds = arch.nodes.map((n) => n.id);
ok(
  PROJECT_VIEWS.architecture.member_kinds.join(",") === "module" && PROJECT_VIEWS.functional.member_kinds.join(",") === "module,task",
  "三视图成员口径仍分开声明（架构＝模块；功能＝模块＋任务）",
);
ok(
  arch.nodes.some((n) => n.id.startsWith("ungrouped:") && n.status.display !== null),
  `架构视图的模块分组拿到派生状态（${archIds.filter((i) => i.startsWith("ungrouped:")).length} 个分组）`,
);
void func;

// ═════════════════════════ ③ 文案人话化 ═════════════════════════
console.log("[verify] ═══ ③ 展示层文案（六态键表与 full 口径不动）═══");
ok(
  DISPLAY_STATUS_PALETTE.verified.short === "已验证通过" && MODULE_VERIFIED_SHORT === "已存在·已验证通过",
  `验证通过的短标是人话（任务/通用「${DISPLAY_STATUS_PALETTE.verified.short}」；模块点明「${MODULE_VERIFIED_SHORT}」）`,
);
ok(
  DISPLAY_STATUS_KEYS.every((k) => DISPLAY_STATUS_PALETTE[k].full === DISPLAY_STATUS_LABELS[k]),
  "六态 `full` 仍与服务端 DISPLAY_STATUS_LABELS **逐字相同**（口径只有一份，判据未放宽）",
);
ok(
  DISPLAY_STATUS_PALETTE.no_status_record.short === "无状态记录" && NO_STATUS_RECORD_KEY === "no_status_record",
  "「无状态记录」仍是独立的中性虚线标签，**没有混进六态键表**",
);
ok(
  noStatusRecordOf("module:x").basis.includes("附录 D") && noStatusRecordOf("module:x").unmapped_reason === "no_task_evidence",
  "「无状态记录」的口径句点明判据出处（DESIGN.md 附录 D）",
);

// ═════════════════════════ ④ 就地自洽 ═════════════════════════
console.log("[verify] ═══ ④ 自洽检查 ═══");
ok(
  normalizeRepoPath("templates/.工作台.example/") === "templates/.工作台.example" && normalizeRepoPath("./src//") === "src",
  "路径归一：去 `./`、去尾斜杠、反斜杠转正斜杠",
);
ok(
  directStatusOf(P["T-1"]).display === "verified" && directStatusOf(null).display === null,
  "任务侧仍按状态投影直取（本卡没有改任务状态口径）",
);
assert.ok(true);

console.log(`\n[verify] 汇总：${pass} PASS / ${fail} FAIL`);
