// V08-04 验证脚本（tsx 跑）：声明链/证据链补全与灰色块收口。
//
// 覆盖（每条对着卡面一条）：
//   ① 花括号展开（R2 机制损耗）：只读、不猜目录、不闭合/空组原样判"认不出"、笛卡尔积有上限；
//   ② `looksLikeRepoPath` 单段目录写法（`audit/`）不再被误判（V08-04 修）；
//   ③ 卡面声明的**真实路径**都真的在场（U1/U2/U3 的 `src-tauri/**`、V06-13 的 `audit/`、一期 3/4/5/6/9/10 的落点）；
//   ④ 派生：U1/U2/U3 → `src-tauri`、V06-13 → `audit`、六个声明模块能经 §4.5 对账对上代码模块；
//   ⑤ 红线：不给 R3 灰块（cap:01/02/03/07/10/12）编造成员归属——它们在设计书模块清单里没有条目；
//      集成端点仍不着进度色；真 todo（真 `planned` 的卡）不染绿。
//
// 上界：本脚本只读仓库文件与蓝图派生（零模型、不写盘）；不新增事件类型。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  backtickedPathTokens,
  declaredRealPathsOf,
  deriveBlueprint,
  expandBracePaths,
  looksLikeRepoPath,
  normalizeRepoPath,
  readBlueprintSources,
} from "../src/arch/blueprint";
import { declaredPathsInSection, resolveModuleForPath } from "../src/arch/reconcile";
import { classifyPlanRegions } from "../src/server/work/plan";
import { buildViewModel, taskDerivedModuleStatus } from "../src/ui/arch/projectGraph";

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
const REPO = path.resolve(import.meta.dirname, "..");

// ═════════════════════════ ① 花括号展开（R2 机制损耗） ═════════════════════════
console.log("[verify] ═══ ① 反引号路径的花括号展开（只读、不猜目录） ═══");
ok(
  expandBracePaths("src/server/work/{plan,tasks,migrate}.ts").join(",") ===
    "src/server/work/plan.ts,src/server/work/tasks.ts,src/server/work/migrate.ts",
  "单组展开成三条完整路径（`src/server/work/{plan,tasks,migrate}.ts`）",
);
ok(
  expandBracePaths("src/a/{b,c}/{d,e}.ts").join(",") === "src/a/b/d.ts,src/a/b/e.ts,src/a/c/d.ts,src/a/c/e.ts",
  "多组按笛卡尔积展开（4 条）",
);
ok(
  expandBracePaths("x/{a").join(",") === "x/{a" && expandBracePaths("y/{}").join(",") === "y/{}",
  "不闭合、空组**原样返回**（上层判「认不出」，不硬凑）",
);
const many = expandBracePaths("d/{a,b,c,d,e,f,g,h}/{1,2,3,4,5,6,7,8}.ts", 32);
ok(many.length === 32, `展开有上限（默认 32 条，实测 ${many.length}）——一条声明不炸出上百条路径`);
ok(
  expandBracePaths("components/{A,B}.tsx").every((p) => looksLikeRepoPath(p)),
  "展开结果仍要过形态判据（不改语义、不补前缀）",
);
ok(
  backtickedPathTokens("见 `src/server/work/{plan,tasks}.ts` 与 `config/settings.toml [storage]`").join(",") ===
    "src/server/work/plan.ts,src/server/work/tasks.ts,config/settings.toml",
  "反引号取路径时先试整段（含花括号），再退回按空白切分的老口径",
);
ok(
  declaredRealPathsOf({ allowed_paths: ["src/ui/components/{DesignView,PlanView}.tsx"], evidence_requirement: null, deliverables: null }).join(",") ===
    "src/ui/components/DesignView.tsx,src/ui/components/PlanView.tsx",
  "「文件责任」里的花括号写法也展开（`declaredRealPathsOf`）",
);

// ═════════════════════════ ② 形态判据修正 ═════════════════════════
console.log("[verify] ═══ ② 单段目录写法不再被误判 ═══");
ok(
  looksLikeRepoPath("audit/") && normalizeRepoPath("audit/") === "audit",
  "`audit/`（单段目录写法）判**是**路径（V08-04 修：以前归一化掉尾斜杠后被判「认不出」）",
);
ok(
  looksLikeRepoPath("src/ui/x.tsx") && looksLikeRepoPath("pyproject.toml") && !looksLikeRepoPath("readTaskLedger") && !looksLikeRepoPath("audit") && !looksLikeRepoPath("C:/x") && !looksLikeRepoPath("../y"),
  "其余口径不变：带目录/带扩展名算路径；裸标识符、绝对路径、上跳不算（不带 `/` 的单段仍不认，避免把标识符当目录）",
);

// ═════════════════════════ ③ 声明的真实路径都在场 ═════════════════════════
console.log("[verify] ═══ ③ 声明链补的路径必须实测在场 ═══");
const src = readBlueprintSources("tatai");
const planTasks = src.plan?.tasks ?? [];
const taskOf = (id: string) => planTasks.find((t: { task_id: string }) => t.task_id === id);
const existsInRepo = (p: string): boolean => fs.existsSync(path.join(REPO, normalizeRepoPath(p)));
for (const id of ["U1", "U2", "U3", "V06-13"]) {
  const t = taskOf(id);
  ok(t !== undefined, `施工图里能解析出 ${id} 卡（历史交付卡补进现行施工图）`);
}
const declaredOf = (id: string): string[] => declaredRealPathsOf(taskOf(id) as never);
const u1Paths = declaredOf("U1").filter((p) => p.startsWith("src-tauri/"));
ok(
  u1Paths.length >= 5 && u1Paths.every(existsInRepo),
  `U1 声明 ${u1Paths.length} 条 src-tauri 真实路径且**全部实测在场**（${u1Paths.slice(0, 3).join("、")}…）`,
);
const u2Paths = declaredOf("U2").filter((p) => p.startsWith("src-tauri/"));
const u3Paths = declaredOf("U3").filter((p) => p.startsWith("src-tauri/"));
ok(
  u2Paths.length >= 3 && u3Paths.length >= 2 && [...u2Paths, ...u3Paths].every(existsInRepo),
  `U2/U3 的 src-tauri 落点也全部在场（U2 ${u2Paths.length} 条、U3 ${u3Paths.length} 条）`,
);
ok(
  declaredOf("V06-13").includes("audit") && fs.statSync(path.join(REPO, "audit")).isDirectory(),
  "V06-13 文件责任含 `audit/`，且 `audit/` 确实是仓库内的真实目录（收口审计批产物）",
);
const PLAN_TEXT = fs.readFileSync(path.join(REPO, "PLAN.md"), "utf8");
const LANDINGS: [string, string][] = [
  ["一期 1", "src/server/registry.ts"],
  ["一期 3", "src/ui/components/GateTimeline.tsx"],
  ["一期 4", "src/ui/components/DesignView.tsx"],
  ["一期 5", "src/server/chat.ts"],
  ["一期 6", "src/server/reverseDraft.ts"],
  ["一期 9", "src/server/pty.ts"],
  ["一期 10", "src/ui/components/LiveView.tsx"],
];
const lines = PLAN_TEXT.split(/\r?\n/);
const modules = src.code.modules as { id: string; path: string }[];
for (const [section, landing] of LANDINGS) {
  const lineNo = lines.findIndex((l) => l.startsWith(`## ${section}｜`)) + 1;
  const declared = declaredPathsInSection(PLAN_TEXT, lineNo).map((x) => x.path);
  const moduleId = resolveModuleForPath(landing, modules);
  ok(
    lineNo > 0 && declared.includes(landing) && moduleId !== null && existsInRepo(landing),
    `${section} 章节点名了 ${landing}（实测在场）并被解析到模块 \`${moduleId}\``,
  );
}
// 配对正反断言（V09-08 ①②）：**只有材料点名了「实现落点」的路径**才算实现映射
{
  const lineNo = lines.findIndex((l) => l.startsWith("## 一期 1｜")) + 1;
  const declared = declaredPathsInSection(PLAN_TEXT, lineNo);
  const impl = declared.filter((d) => d.implementation).map((d) => d.path);
  ok(
    impl.includes("src/server/registry.ts") && resolveModuleForPath("src/server/registry.ts", modules) === "src",
    `一期 1 的**实现落点**解析到实现模块 \`src\`（${impl.join("、")}）`,
  );
  ok(
    !declared.find((d) => d.path === "templates/.工作台.example/")?.implementation &&
      resolveModuleForPath("templates/.工作台.example/", modules) === "templates",
    "同一节里点到的 `templates/.工作台.example/`（空模板目录）**没有**「实现落点」标记 ⇒ 不参与实现映射（修掉 11.1-01 → templates 的真误配）",
  );
  const nominal = declaredPathsInSection(["## 甲卡｜甲模块（设计书 §11.1 第 1 项）", "产出：`src/server/registry.ts` 的说明"].join("\n"), 1);
  ok(
    nominal.length === 1 && nominal[0].implementation === false,
    "反例：只点到路径、没写「实现落点」⇒ 不算实现落点（如实标落点未证实，不继承绿）",
  );
}

// ═════════════════════════ ④ 派生：卡 → 模块 ═════════════════════════
console.log("[verify] ═══ ④ 派生映射 ═══");
const bp = deriveBlueprint(src, {
  based_on: {
    model_key: "v0804-verify",
    full_key: "v0804-verify",
    design_content_sha256: null,
    plan_definition_sha256: null,
    semantic: false,
  },
});
const implTargets = (taskId: string): string[] =>
  bp.edges
    .filter((e) => e.kind === "implementation_map" && e.source === `plan:task:${taskId}`)
    .map((e) => e.target.replace("plan:code:", ""));
ok(
  implTargets("U1").includes("src-tauri") && implTargets("U2").includes("src-tauri") && implTargets("U3").includes("src-tauri"),
  `U1/U2/U3 都映射到 \`src-tauri\`（${implTargets("U1").join(",")}｜${implTargets("U2").join(",")}｜${implTargets("U3").join(",")}）`,
);
ok(
  implTargets("V06-13").includes("audit"),
  `V06-13 映射到 \`audit\`（${implTargets("V06-13").join(",")}）`,
);
ok(
  bp.edges.filter((e) => e.kind === "implementation_map").every((e) => e.certainty === "observed"),
  "实现映射边仍全部是 `observed`（模型推断的线索边不参与判据，附录 D）",
);

// ═════════════════════════ ⑤ 红线：不编归属、R3 原样 ═════════════════════════
console.log("[verify] ═══ ⑤ 红线 ═══");
const designInterfaceTargetsOf = (capId: string): string[] =>
  bp.edges.filter((e) => e.kind === "design_interface" && e.source === capId).map((e) => e.target);
const capIds = bp.nodes.filter((n) => n.kind === "capability").map((n) => n.id);
ok(capIds.length > 0, `蓝图里有能力节点（${capIds.length} 个）`);
const cap04 = capIds.filter((id) => id.startsWith("plan:cap:04"));
ok(
  cap04.length === 1 && designInterfaceTargetsOf(cap04[0]).length === 0,
  "cap:04（架构图生成引擎）在设计书模块清单里**没有条目** ⇒ 架构视图没有合法模块成员（如实留灰，不编归属）",
);
const codeModuleNodeIds = new Set(bp.nodes.filter((n) => n.kind === "module" && n.id.startsWith("plan:code:")).map((n) => n.id));
ok(
  capIds.every((id) => designInterfaceTargetsOf(id).every((t) => !codeModuleNodeIds.has(t) || id.startsWith("plan:cap:11")) === true),
  "「代码模块归属某个能力」只允许发生在设计书模块清单所在章节（塔台=§11.1 → cap:11）——不给别的章节平白安成员",
);
// 真 todo：没有任何 `planned` 的卡把模块推成绿
const projection = Object.fromEntries(
  planTasks.map((t: { task_id: string }) => [t.task_id, { object_id: t.task_id, mapping: "mapped", display_status: "verified", reasons: [] }]),
);
const allGreen = taskDerivedModuleStatus({ blueprint: bp, projection: projection as never });
const rootStatus = allGreen.by_object["module:src-tauri"];
ok(
  rootStatus?.display === "verified",
  `全部卡都通过时 src-tauri 判「验证通过」（当前实测 display=${rootStatus?.display}）`,
);
const todoProjection = {
  ...projection,
  U1: { object_id: "U1", mapping: "mapped", display_status: "planned", reasons: [] },
};
const withTodo = taskDerivedModuleStatus({ blueprint: bp, projection: todoProjection as never });
ok(
  withTodo.by_object["module:src-tauri"]?.display !== "verified",
  `有卡是「已规划」时 src-tauri **不判绿**（实测 display=${withTodo.by_object["module:src-tauri"]?.display}）——真 todo 不染绿`,
);
const archModel = buildViewModel({ view: "architecture", blueprint: bp, projection: projection as never, module_status: allGreen.status });
const endpointLike = bp.edges.filter((e) => e.kind === "implementation_map").length;
ok(endpointLike > 0 && archModel.nodes.length > 0, `架构视图能出节点（${archModel.nodes.length} 个）`);
info(`  蓝图：${bp.nodes.length} 节点 / ${bp.edges.length} 边（实现映射 ${endpointLike} 条）`);

// ═════════════════════════ ⑥ 派生状态段判据（引用块备注） ═════════════════════════
console.log("[verify] ═══ ⑥ 派生状态段判据：引用块里的备注也是备注（V08-04 修 plan.ts） ═══");
{
  const fixture = [
    "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |",
    "| --- | --- | --- | --- | --- |",
    "| T-1 | done | 目标 | 施工授权 | 证据 |",
    "",
    "### T-1 目标",
    "",
    "**文件责任**：`src/a.ts`",
    "",
    "> 施工备注（落地时补，卡片内容未改）：这条是派生状态段。",
    "",
  ].join("\n");
  const lines = fixture.split("\n");
  const region = classifyPlanRegions(fixture).regions.find((r) => r.shape === "state_paragraph");
  const inState = (n: number): boolean => region !== undefined && n >= region.line_start && n <= region.line_end;
  const quoteLine = lines.findIndex((l) => l.startsWith("> 施工备注")) + 1;
  const fieldLine = lines.findIndex((l) => l.startsWith("**文件责任**")) + 1;
  ok(
    quoteLine > 0 && fieldLine > 0 && inState(quoteLine) && !inState(fieldLine),
    `引用块里的「> 施工备注（…）：」判为派生状态段（行 ${quoteLine}∈[${region?.line_start ?? "-"},${region?.line_end ?? "-"}]），上面的「**文件责任**」仍算定义（行 ${fieldLine} 不在状态段）`,
  );
}

assert.ok(true);
console.log(`\n[verify] 汇总：${pass} PASS / ${fail} FAIL`);
