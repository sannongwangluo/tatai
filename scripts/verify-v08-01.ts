// V08-01 验证脚本（PLAN.md v0.8 轮卡，授权语见「当前施工入口 v0.8」段）。
// 用法：pnpm verify:v08-01（或 node --import tsx scripts/verify-v08-01.ts）
//
// 自带隔离环境（临时 TATAI_HOME + 临时项目），**不碰**任何真实项目的 .工作台/；模型环节零调用
// （人话名用**签名命中缓存**的夹具，不真调 Flash）。
//
// 覆盖点（V08-01 四个范围里可离线断言的部分）：
//   ① §11.1 → 稳定 ID 契约：材料声明的编号当身份、改名不换身份、材料没给键时如实标注为材料定位；
//      审定材料索引：施工图交叉引用（`§<节号> 第 N 项`）能定位到落点章节，章节内点名的路径能解析到代码模块
//   ② 状态区 v2 派生：任务状态读口径 v2 优先（source=v2_events）、未迁移项目退回 v1 台账；
//      /live 的计数与"结果已提交≠已验收"语义（task_counts_v2 / result_submitted_ids / current_task 取认领·执行中）
//   ③ 测试欠账的定点更新由各脚本自身守护（d2/s2/f3/v06-14 见 PROGRESS 本卡条）
//   ④ 欠账④：人话名缓存剪掉"已不存在的模块 id"（只清孤儿、活着的不动）；audit 模块色在已迁移项目
//      没有合法写口 → 闸门拒绝且零字节（不绕闸门）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  declaredPathsInSection,
  extractDesignModules,
  extractTataiDesignModules,
  reconcileProject,
  resolveModuleForPath,
  resolvePlanCounterparts,
} from "../src/arch/reconcile";
import { moduleSignature, nameModules } from "../src/arch/name";
import { addModule, readProgress, readTaskLedger, setModuleStatus, WsError } from "../src/server/workstation";
import { getLive } from "../src/server/live";
import { WorkService } from "../src/server/work/service";
import { importTaskDefinitions } from "../src/server/work/plan";
import { submitDefinitionImports, submitTaskStatus, readTaskStates } from "../src/server/work/tasks";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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
const info = (m: string): void => console.log(`[verify] ${m}`);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-v0801-"));
const dataDir = path.join(tmp, "home");
fs.mkdirSync(dataDir, { recursive: true });
process.env.TATAI_HOME = dataDir;
const write = (f: string, text: string): void => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text, "utf8");
};
const record = (id: string, name: string, dir: string) => ({
  id,
  name,
  path: dir,
  kind: "backend",
  registered_at: "2026-09-23T00:00:00+08:00",
  last_opened_at: "2026-09-23T00:00:00+08:00",
});

async function main(): Promise<void> {
  // ── ① 稳定 ID 契约（单元级，零 IO）──
  info("── ① §11.1 → 稳定 ID 契约（身份＝材料声明的编号，不再是中文功能名）");
  const designMd = fs.readFileSync(path.join(REPO, "DESIGN.md"), "utf8");
  const tataiMods = extractTataiDesignModules(designMd);
  ok(
    tataiMods.length === 10 && tataiMods[0].stable_id === "11.1-01" && tataiMods[9].stable_id === "11.1-10" &&
      tataiMods.every((m) => m.identity_basis === "declared_number"),
    `① §11.1 十项身份＝材料声明的编号（${tataiMods.map((m) => m.stable_id).join("/")}），依据如实标为 declared_number`,
  );
  const renameA = extractDesignModules(["# d", "", "## 模块划分", "", "- 甲", "- 乙", ""].join("\n"));
  const renameB = extractDesignModules(["# d", "", "## 模块划分", "", "- 甲改名了", "- 乙也改名", ""].join("\n"));
  ok(
    JSON.stringify(renameA.map((m) => m.stable_id)) === JSON.stringify(renameB.map((m) => m.stable_id)) &&
      renameA.every((m) => m.identity_basis === "material_position"),
    `① 改名不换身份（材料没给稳定键时身份＝材料定位，依据如实标注）：${renameA.map((m) => m.stable_id).join("/")} —— §4.7`,
  );

  // ── ① 审定材料索引（施工图交叉引用 → 落点章节 → 章节内点名的代码路径）──
  info("── ① 审定材料索引：`§<设计节号> 第 N 项` 交叉引用 → 施工图章节 → 代码模块");
  const planText = fs.readFileSync(path.join(REPO, "PLAN.md"), "utf8");
  const counterparts = resolvePlanCounterparts(planText);
  ok(
    counterparts.size >= 10 && counterparts.get("11.1-01") !== undefined &&
      counterparts.get("11.1-01")!.section_path.includes("一期 1") &&
      counterparts.get("11.1-01")!.ref_text === "§11.1 第 1 项",
    `① 施工图里 ${counterparts.size} 条交叉引用可定位（11.1-01 → 「${String(counterparts.get("11.1-01")?.section_path).slice(0, 22)}…」）——关系有可核对出处`,
  );
  const cp1 = counterparts.get("11.1-01")!;
  const declared = declaredPathsInSection(planText, cp1.section_line);
  const resolved = [...new Set(declared.map((d) => resolveModuleForPath(d.path, [{ id: "templates", path: "templates" }, { id: "src", path: "src" }])).filter((x): x is string => x !== null))];
  ok(
    declared.length > 0 && resolved.includes("templates"),
    `① 章节内点名的仓库路径能解析到代码模块（${declared.slice(0, 3).map((d) => `${d.path}@L${d.line}`).join("、")} → ${resolved.join("/")}）`,
  );
  ok(
    resolveModuleForPath("DESIGN.md", [{ id: "root", path: "." }, { id: "docs", path: "docs" }]) === null,
    "① 根模块（path=.）不参与锚定、认不出的路径不硬凑（不为了对上而伪造关联，§4.5 末句）",
  );

  // ── ② 状态区 v2 派生（隔离夹具：一个已迁移项目 + 一个未迁移项目）──
  info("── ② 状态区 v2 派生：任务状态读口径 v2 优先，未迁移项目如实退回 v1 台账");
  const migRoot = path.join(tmp, "mig");
  const plainRoot = path.join(tmp, "plain");
  write(path.join(migRoot, ".工作台", "design.md"), "# 夹具设计书\n\n## 1 目标\n\n迁移夹具。\n");
  write(path.join(plainRoot, ".工作台", "design.md"), "# 夹具设计书\n\n## 1 目标\n\n未迁移夹具。\n");
  const plan = [
    "# 夹具施工图",
    "",
    "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |",
    "| --- | --- | --- | --- | --- |",
    "| T-1 | doing | 卡一 |  | 证据一 |",
    "| T-2 | todo | 卡二 | T-1 | 证据二 |",
    "",
    "### T-1 卡一",
    "",
    "**设计依据**：§1。**文件责任**：`src/**`。",
    "",
    "- [ ] 甲检查",
    "",
    "**交付**：证据一。",
    "",
    "### T-2 卡二",
    "",
    "**设计依据**：§1。**文件责任**：`src/**`。",
    "",
    "- [ ] 乙检查",
    "",
    "**交付**：证据二。",
    "",
  ].join("\n");
  write(path.join(migRoot, ".工作台", "plan.md"), plan);
  write(path.join(plainRoot, ".工作台", "plan.md"), plan);
  write(path.join(plainRoot, ".工作台", "tasks.json"), JSON.stringify({ version: 1, tasks: [{ id: "T-9", title: "台账里的卡", module_id: "m", status: "doing", reporter: "x", updated_at: "2026-09-23T00:00:00+08:00" }] }, null, 2) + "\n");
  fs.writeFileSync(
    path.join(dataDir, "registry.json"),
    JSON.stringify({ version: 1, projects: [record("v0801-mig", "迁移夹具", migRoot), record("v0801-plain", "未迁移夹具", plainRoot)] }, null, 2),
  );

  const svc = new WorkService({ dataDir });
  const submitter = svc as unknown as Parameters<typeof submitDefinitionImports>[0];
  const defs = importTaskDefinitions(plan, { plan_revision: "rev-1" }).definitions;
  submitDefinitionImports(submitter, { project_id: "v0801-mig", change_id: "change-v0801", actor_id: "verify", role: "coordinator", definitions: defs });
  submitTaskStatus(submitter, { project_id: "v0801-mig", task_id: "T-1", change_id: "change-v0801", actor_id: "verify", role: "executor", expected_revision: 1, status: "executing" });
  submitTaskStatus(submitter, { project_id: "v0801-mig", task_id: "T-2", change_id: "change-v0801", actor_id: "verify", role: "executor", expected_revision: 1, status: "result_submitted" });

  const ledMig = readTaskLedger("v0801-mig");
  ok(
    ledMig.source === "v2_events" && ledMig.last_seq !== null && ledMig.rows.length === 2 &&
      ledMig.rows.every((r) => r.v2_status !== null && r.v2_status_label !== null),
    `② 已迁移项目：任务状态读的是 **v2 事件投影**（source=${ledMig.source} last_seq=${ledMig.last_seq}，每行带 v2 状态与标签）`,
  );
  ok(
    ledMig.rows.find((r) => r.id === "T-1")?.v2_status === "executing" &&
      ledMig.rows.find((r) => r.id === "T-2")?.v2_status === "result_submitted" &&
      ledMig.rows.find((r) => r.id === "T-2")?.v2_status_label === "结果已提交",
    "② 每行的 v2 状态与标签取自事件（§5.4 原文口径：结果已提交＝执行者交了结果，不是已验收）",
  );
  const ledPlain = readTaskLedger("v0801-plain");
  ok(
    ledPlain.source === "v1_file" && ledPlain.rows.length === 1 && ledPlain.rows[0].v2_status === null,
    `② 未迁移项目：如实退回 v1 台账（source=${ledPlain.source}，没有 v2 状态就不编一个）`,
  );

  const liveMig = getLive("v0801-mig");
  ok(
    liveMig.task_source === "v2_events" && liveMig.task_last_seq === ledMig.last_seq &&
      liveMig.task_counts_v2["执行中"] === 1 && liveMig.task_counts_v2["结果已提交"] === 1 &&
      liveMig.result_submitted_ids.join(",") === "T-2",
    `② /live 计数与"待验收"语义来自 v2：${JSON.stringify(liveMig.task_counts_v2)}；result_submitted_ids=${liveMig.result_submitted_ids.join(",")}`,
  );
  ok(
    liveMig.current_task !== null && liveMig.current_task.id === "T-1" && liveMig.current_task.v2_status_label === "执行中" &&
      !liveMig.result_submitted_ids.includes("T-1"),
    `② "谁在干活"取 v2 的认领/执行中（当前卡 ${liveMig.current_task?.id}「${liveMig.current_task?.v2_status_label}」），已交结果的卡不被当成在跑`,
  );
  const livePlain = getLive("v0801-plain");
  ok(
    livePlain.task_source === "v1_file" && livePlain.task_counts.doing === 1 && livePlain.result_submitted_ids.length === 0,
    "② 未迁移项目 /live 口径一致退回 v1（doing=1），且不虚报「待验收」",
  );

  // ── ④ 欠账清理：人话名缓存剪孤儿；audit 模块色不许绕闸门 ──
  info("── ④ 欠账清理：names 缓存剪孤儿（活着的不动）；已迁移项目模块四色闸门");
  write(path.join(migRoot, ".工作台", "arch", "modules.json"), JSON.stringify({ version: 1, generated_at: "2026-09-23T00:00:00+08:00", modules: [{ id: "src", name: "", path: "src", file_count: 1, loc: 1, deps: [] }] }, null, 2) + "\n");
  // 活模块的人话名签名按**产品同一份算法**算出来（moduleSignature），保证命中缓存、零模型调用
  const srcSignature = moduleSignature({ id: "src", name: "", path: "src", file_count: 1, loc: 1, deps: [] } as never);
  write(
    path.join(migRoot, ".工作台", "arch", "names.json"),
    JSON.stringify(
      {
        version: 1,
        entries: {
          src: { name: "保留的活模块", blurb: "", kind: "code", named_at: "2026-09-23T00:00:00Z", signature: srcSignature },
          "gone-module": { name: "孤儿的旧模块", blurb: "", kind: "code", named_at: "2026-01-01T00:00:00Z", signature: "sig-old" },
        },
      },
      null,
      2,
    ) + "\n",
  );
  const named = await nameModules("v0801-mig", { dataDir });
  const entriesAfter = named.file.entries;
  ok(
    named.pruned === 1 && entriesAfter["gone-module"] === undefined && entriesAfter["src"]?.name === "保留的活模块" && named.named === 0,
    `④ 人话名缓存剪掉已不存在的模块 id（剪 ${named.pruned} 条；活着的 src 原样保留、零模型调用 named=${named.named}）`,
  );
  const progressBefore = JSON.stringify(readProgress("v0801-mig", dataDir));
  let refused = "";
  try {
    addModule("v0801-mig", { id: "audit", name: "审计报告集", status: "todo" }, dataDir);
  } catch (e) {
    refused = e instanceof WsError ? e.code : String(e);
  }
  ok(
    refused === "WRITE_UPGRADE_REQUIRED" && JSON.stringify(readProgress("v0801-mig", dataDir)) === progressBefore,
    `④ 已迁移项目的模块四色**没有合法 v1 写口**：addModule 被闸门拒（${refused}）且 progress.json 零字节改变——不绕闸门`,
  );
  void setModuleStatus;

  // ── ① 真实项目对账（只读）：塔台自身按新契约出"真实差异"而不是名字对不上 ──
  info("── ① 真实项目对账（只读，不写盘）：塔台自身");
  const realHome = process.env.TATAI_REAL_HOME ?? "";
  if (realHome === "") {
    console.log("[verify] SKIP ① 真实项目对账：未设 TATAI_REAL_HOME（真实注册表目录），本段跳过（不计为 PASS）");
  } else {
    const real = reconcileProject("tatai", { trigger: "verify-v08-01", dataDir: realHome });
    const byRef = real.matched.filter((m) => m.via === "plan_section_ref");
    ok(
      byRef.length > 0 && real.design_modules.every((d) => d.stable_id.startsWith("11.1-")),
      `① 塔台自身：声明模块与代码模块按**材料写明的交叉引用**对上 ${byRef.length} 条（修前 matched=0）；声明侧身份全为稳定 ID`,
    );
  }

  if (process.env.TATAI_KEEP_TMP !== "1") fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n[verify] V08-01 结果：${pass} PASS / ${fail} FAIL（exit ${process.exitCode ?? 0}）`);
}

main().catch((e) => {
  console.error("[verify] 运行失败：", e);
  process.exit(1);
});
