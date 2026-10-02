// V09-29 集成发现 F-2 · 定义/需求映射对齐定点验证（PLAN V09-29；DESIGN.md §2.5/§2.7/§2.9）。
//
// 缺陷（修前，RED）：`import_plan_definitions` 公开支持 `requirement_ids` 做**施工图外**的需求映射，
// 但 `alignDefinitionsAndStates` 只回放定义级 `change_id`，不回放 `requirement_ids`——而 `requirement_ids`
// 同样进定义哈希 canonical（`shared/planCardHash.ts`）。于是施工图**没有**需求映射表（现解析 `requirement_ids=null`）
// 时，同一张刚导入的卡在接续入口被判 `needs_rebind`（`claim_task` 却成功，两个结论打架）。
//
// 修后（GREEN）口径：定义级引用元数据（`change_id` + `requirement_ids`）都随事件回放再复算哈希；
// 但**施工图当前解析出的 `requirement_ids`（需求映射表）非空时以文档为准**——文档改稿带来的真实变化仍判重绑，
// 不用"忽略需求映射"把真实改稿掩盖过去。
//
// 本脚本用**真唯一写服务**（进程内 WorkService）+ 真 `importPlanChecked` / `submitDefinitionImports` /
// `readTaskStates` / `alignPlanWithWork` 钉住四类现场：
//   ① 工具外映射（`requirement_ids` 参数、施工图无映射表）→ 对齐 `same_source`（不误判 needs_rebind）；
//   ② 文档映射（施工图含需求映射表）→ 对齐 `same_source`；
//   ③ 真正改稿（定义内容/映射表变了、未重导）→ **必须** needs_rebind（不掩盖真实改稿）；
//   ④ 回放事实钉住：状态里带出 `definition_requirement_ids`，与导入参数一致。
// 隔离：mkdtemp 夹具 + 隔离 TATAI_HOME；不碰真实 ~/.tatai / 真实项目与账本。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { addProject } from "../src/server/registry";
import { WorkService } from "../src/server/work/service";
import { alignPlanWithWork, readTaskStates, submitDefinitionImports } from "../src/server/work/tasks";
import { collectRegisteredReferences, importPlanChecked } from "../src/server/work/references";
import { registerRequirement } from "../src/server/work/requirements";

let passCount = 0;
let failCount = 0;
const ok = (cond: boolean, label: string, detail?: unknown): void => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (cond) passCount += 1;
  else {
    failCount += 1;
    process.exitCode = 1;
    if (detail !== undefined) console.log(`[verify]   现场：${JSON.stringify(detail).slice(0, 1600)}`);
  }
};
const info = (m: string): void => console.log(`[verify] ${m}`);
const mkdirp = (d: string): void => { fs.mkdirSync(d, { recursive: true }); };
const write = (f: string, t: string): void => { mkdirp(path.dirname(f)); fs.writeFileSync(f, t, "utf8"); };

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-defalign-"));
const dataDir = path.join(tmpBase, "home");
process.env.TATAI_HOME = dataDir;
process.env.TATAI_NO_AUTOSTART = "1";
mkdirp(dataDir);

const service = new WorkService({ dataDir });
const REQ = "req-align-1";
/** 提交者：写口接唯一写服务；`readReferences` 从该项目的投影现读（定义带引用时写口必查） */
const submitterFor = (workDir: string) => ({
  submit: (c: unknown) => service.submit(c),
  readReferences: () => collectRegisteredReferences(workDir),
});

const planNoTable = (goal: string): string =>
  [
    "# 夹具施工图（无需求映射表）", "",
    "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |",
    "| --- | --- | --- | --- | --- |",
    `| T-1 | todo | ${goal} |  | T-1 证据 |`, "",
    "### T-1 夹具卡一", "",
    "**设计依据**：§1。**文件责任**：`src/t-1.ts`。**责任角色**：executor。", "",
    `- [ ] ${goal}`, "",
    "**交付**：证据。", "",
  ].join("\n");

const planWithTable = (goal: string, reqId: string): string =>
  [
    "# 夹具施工图（含需求映射表）", "",
    "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |",
    "| --- | --- | --- | --- | --- |",
    `| T-1 | todo | ${goal} |  | T-1 证据 |`, "",
    "| 需求 | 承接卡 | 分类 | 来源 | 适用范围 | 确认度 |",
    "| --- | --- | --- | --- | --- | --- |",
    `| ${reqId} | T-1 | 当前有效 | 夹具需求 | 全程 | 明确 |`, "",
    "### T-1 夹具卡一", "",
    "**设计依据**：§1。**文件责任**：`src/t-1.ts`。**责任角色**：executor。", "",
    `- [ ] ${goal}`, "",
    "**交付**：证据。", "",
  ].join("\n");

interface Fixture { pid: string; chg: string; workDir: string; root: string; submitter: ReturnType<typeof submitterFor> }
function fixture(tag: string): Fixture {
  const pid = `fx-${tag}`;
  const chg = `chg-${tag}`;
  const root = path.join(tmpBase, `proj-${tag}`);
  const workDir = path.join(root, ".工作台", "work");
  mkdirp(workDir);
  write(path.join(root, "src", "t-1.ts"), "export const t1 = 1;\n");
  addProject({ id: pid, name: `夹具 ${tag}`, path: root, kind: "backend" }, dataDir);
  const submitter = submitterFor(workDir);
  // 需求登记（source.kind=user：不依赖意图解析/注册表定位）
  registerRequirement(submitter, {
    project_id: pid, requirement_id: REQ, change_id: chg, actor_id: "fixture", role: "designer",
    source: { kind: "user", ref: "夹具用户 2026-10-02 指令" },
    problem: "夹具需求：验证需求映射对齐", users: ["夹具用户"], success_scenarios: ["对齐一致"],
    exclusions: ["不做逆向"], priority: "高", status: "explicit",
  } as never);
  return { pid, chg, workDir, root, submitter };
}

async function main(): Promise<void> {
  info(`V09-29 定义/需求映射对齐 · 专项（${process.platform} · node ${process.version}）`);
  info(`  夹具 ${tmpBase}（TATAI_HOME ${dataDir}）`);

  // ═══ ① 工具外映射（施工图无映射表）→ 不误判 needs_rebind ═══
  info("── ① 工具外 requirement_ids 映射（施工图无映射表）");
  {
    const f = fixture("tool");
    const defs = importPlanChecked(planNoTable("夹具卡一"), f.workDir, { requirement_ids: { "T-1": [REQ] } }).definitions;
    submitDefinitionImports(f.submitter, { project_id: f.pid, change_id: f.chg, actor_id: "fixture", role: "coordinator", definitions: defs });
    // 回放事实：状态带出 definition_requirement_ids，与导入参数一致
    const st = readTaskStates(f.workDir).states["T-1"];
    ok(
      Array.isArray(st?.definition_requirement_ids) && (st.definition_requirement_ids as string[]).join(",") === REQ,
      "①-1 状态回放带出 definition_requirement_ids（与导入参数一致）",
      { got: st?.definition_requirement_ids },
    );
    // 读侧现解析：施工图无映射表 → requirement_ids=null；对齐必须回放事件里的工具外映射
    const align = alignPlanWithWork(planNoTable("夹具卡一"), f.workDir);
    ok(
      align.alignment.same_source === true && align.alignment.needs_rebind.length === 0,
      "①-2 工具外映射的刚导入卡对齐 same_source（**不**误判 needs_rebind）",
      { alignment: align.alignment },
    );
  }

  // ═══ ② 文档映射（施工图含映射表）→ 对齐 ═══
  info("── ② 文档内需求映射表");
  {
    const f = fixture("doc");
    const plan = planWithTable("夹具卡一", REQ);
    const defs = importPlanChecked(plan, f.workDir).definitions;
    submitDefinitionImports(f.submitter, { project_id: f.pid, change_id: f.chg, actor_id: "fixture", role: "coordinator", definitions: defs });
    const align = alignPlanWithWork(plan, f.workDir);
    ok(
      align.alignment.same_source === true && align.alignment.needs_rebind.length === 0,
      "②-1 文档映射表的卡对齐 same_source",
      { alignment: align.alignment },
    );
    // ═══ ③ 真正改稿：定义内容变了、未重导 → 必须 needs_rebind ═══
    const alignChanged = alignPlanWithWork(planWithTable("夹具卡一（改稿）", REQ), f.workDir);
    ok(
      alignChanged.alignment.needs_rebind.some((n) => n.task_id === "T-1") && alignChanged.alignment.same_source === false,
      "③-1 定义内容真实改稿（目标文字变了、未重导）→ 必须 needs_rebind（不掩盖真实改稿）",
      { needs_rebind: alignChanged.alignment.needs_rebind },
    );
    // ═══ ③b 映射表本身变了、未重导 → 必须 needs_rebind ═══
    // 再登记一条需求，把施工图里的承接映射从 REQ 改成 REQ2（文档当前解析出的 requirement_ids 非空且与回放值不同）
    registerRequirement(f.submitter, {
      project_id: f.pid, requirement_id: "req-align-2", change_id: f.chg, actor_id: "fixture", role: "designer",
      source: { kind: "user", ref: "夹具用户 2026-10-02 指令二" },
      problem: "夹具需求二", users: ["夹具用户"], success_scenarios: ["对齐一致"], exclusions: [], priority: "中", status: "explicit",
    } as never);
    const alignRemapped = alignPlanWithWork(planWithTable("夹具卡一", "req-align-2"), f.workDir);
    ok(
      alignRemapped.alignment.needs_rebind.some((n) => n.task_id === "T-1"),
      "③-2 施工图需求映射表改稿（承接映射变了、未重导）→ 必须 needs_rebind（文档优先，不被回放掩掉）",
      { needs_rebind: alignRemapped.alignment.needs_rebind },
    );
    // 复原：映射表改回 REQ → 对齐恢复（证明结论随当前文档，而非一次性误报）
    const alignBack = alignPlanWithWork(planWithTable("夹具卡一", REQ), f.workDir);
    ok(alignBack.alignment.same_source === true, "③-3 映射表改回原映射 → 对齐恢复 same_source（结论随当前文档）", { alignment: alignBack.alignment });
  }

  // ═══ ④ 兼容：不带任何映射的旧路径行为不变 ═══
  info("── ④ 旧数据路径（无映射、无表）行为不变");
  {
    const f = fixture("plain");
    const plan = planNoTable("夹具卡一");
    const defs = importPlanChecked(plan, f.workDir).definitions;
    submitDefinitionImports(f.submitter, { project_id: f.pid, change_id: f.chg, actor_id: "fixture", role: "coordinator", definitions: defs });
    const align = alignPlanWithWork(plan, f.workDir);
    const st = readTaskStates(f.workDir).states["T-1"];
    ok(align.alignment.same_source === true, "④-1 无映射的卡仍对齐 same_source（旧路径零改动）", { alignment: align.alignment });
    ok(st?.definition_requirement_ids == null, "④-2 无映射时状态不带 requirement_ids（显式 null/未设）", { got: st?.definition_requirement_ids });
  }

  info(`── 收尾：${passCount} PASS / ${failCount} FAIL`);
  console.log(failCount === 0 ? "[verify] 结果: 全部 PASS" : "[verify] 结果: FAIL（上面有 FAIL 行）");
  if (process.env.TATAI_KEEP_TMP !== "1") {
    try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch { /* ignore */ }
  } else {
    info(`  保留现场 ${tmpBase}`);
  }
}

main().catch((e) => {
  console.error(`[verify] 脚本异常：${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  process.exitCode = 1;
});
