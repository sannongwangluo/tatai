// M2 验证脚本（用 tsx 跑）：真实 MCP client 连真实 server 子进程，逐个真实调用一期 8 个基础工具（PLAN.md M2 卡）。
// 用法：pnpm verify:m2（自带临时 TATAI_HOME 造 1 条被纳管项目，不碰真实注册表）
// 覆盖点（对应 M2 DoD 逐条）：
//   ① 8 个工具逐个真实调用一次，贴入参与返回（对照 DESIGN.md §6.3"返回"列）
//   ② 权限证伪：listTools 无 write_design；callTool write_design 回 isError
//   ③ 权限证伪：append_discuss 带 index/edit/delete 字段试图改已有条目必须失败
//   ③b 权限证伪：listTools 无任何 gate 写入类工具
//   ④ report_task_status 写出的 tasks.json cat 出来字段符合 §2.3.4（id/title/module_id/status/reporter/updated_at/note?）；
//      含"首报即建档"（新建）与"再报改状态"（更新）两条路径，reporter 缺省取 MCP client 名；
//      note 留痕（2026-09-19 主人拍板）：首报带 note 落盘、再报不传 note 保留旧值、再报传新 note 覆盖
//   ⑤ update_progress 改模块四色状态，progress.json 里 gate.current_step 未被动
//   ⑥ select_project 的 project_id / path 两种入参各调一次
//   ⑦ listTools 恰好 28 个（一期 8 + §6.4 两件 + V06-10 三件套 + C-015 三件套 + V07-02 出口件 +
//      V07-04 doctor + V09-19 六图读口 + V09-23 同步域三接口 + V09-27/V09-28 三接口 +
//      V09-32/33/35 read_plan/expand_module + V09-39 project_index 逐个点名）；V06-10
//      三件套的入参 schema 点到点 + 各真调一次（没有 v2 事实的窗口期：入口给只读结论，两个写口明确拒绝）；
//      C-015 三件套（manage_requirement/manage_change/import_plan_definitions）的 schema 点到点与
//      负例真链路在 verify-requirements.ts ⑧-5（96 条守着）、写口服务侧校验在 verify-c015-service.ts，
//      这里不重复造第二套，只做独立的身份/集合点名
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { addProject } from "../src/server/registry";
import { addModule, readProgress } from "../src/server/workstation";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const ok = (cond: boolean, label: string) => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (!cond) process.exitCode = 1;
};

// ── 临时数据目录 + 造 1 条被纳管项目（不碰真实注册表）──
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-m2-verify-"));
const dataDir = path.join(tmpBase, "home");
const projDir = path.join(tmpBase, "m2-proj");
fs.mkdirSync(path.join(projDir, ".工作台"), { recursive: true });
addProject({ id: "m2-proj", name: "M2 验证项目", path: projDir, kind: "backend" }, dataDir);
// 设计书与模块夹具（数据层直造，与工具链路无关）
fs.writeFileSync(
  path.join(projDir, ".工作台", "design.md"),
  "# M2 验证项目 设计稿\n\n> 验证夹具：read_design 应原样读回本行。\n",
  "utf8",
);
addModule("m2-proj", { id: "m-1", name: "模块一" }, dataDir);

const CLIENT_NAME = "m2-verify-client";

async function main(): Promise<void> {
  // ── 起真实 server 子进程（node + tsx CLI 跑 src/mcp/index.ts，与 verify-m1 同口径）──
  const tsxCli = path.join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [tsxCli, path.join(REPO_ROOT, "src", "mcp", "index.ts")],
    cwd: REPO_ROOT,
    env: { ...process.env, TATAI_HOME: dataDir } as Record<string, string>,
    stderr: "inherit",
  });
  const client = new Client({ name: CLIENT_NAME, version: "0.0.1" });
  await client.connect(transport);
  const serverPid = transport.pid;
  ok(serverPid != null, `server 子进程已拉起（pid=${serverPid}）`);

  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content as Array<{ type: string; text?: string }>)
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    console.log(`\n[verify] ── callTool ${name} 入参: ${JSON.stringify(args)}`);
    console.log(`[verify] ── ${name} 返回（isError=${r.isError === true}）:\n${text}`);
    return { isError: r.isError === true, text };
  };

  // ── listTools：一期 8 个 + §6.4 两件 + V06-10 三件套 + C-015 三件套全在且数量恰好；权限证伪②③b ──
  const tools = await client.listTools();
  const names = tools.tools.map((t) => t.name);
  console.log(`\n[verify] listTools 返回工具名: ${names.join(", ")}`);
  const EXPECTED = [
    "list_projects",
    "select_project",
    "read_design",
    "read_progress",
    "report_task_status",
    "update_progress",
    "append_discuss",
    "list_tasks",
  ];
  // 2026-09-19 主人拍板扩充（DESIGN.md §6.4）：get_arch + ask_flash 两工具当日实现，
  // 注册表从一期 8 个变 10 个。护栏口径跟上：一期 8 个必须全在 + 扩充两件在 + 数量恰 10
  // （将来再扩，这里继续点名登记——不放宽成"包含即可"）。
  const M5_TOOLS = ["get_arch", "ask_flash"];
  // 2026-09-20（V06-10，DESIGN.md §6.7）：项目接续入口 + 认领/回报写口三件套，
  // 注册表从 10 个变 13 个。同一个口径：**逐个点名登记**，数量判据仍是"恰好"（不是 >=）。
  const V0610_TOOLS = ["project_entry", "claim_task", "submit_task_result"];
  // 2026-09-20/21（批3 C-015，DESIGN.md §2.5/§2.6）：需求/变更对象命令与受检施工定义导入三件套，
  // 注册表从 13 个变 16 个。同一个口径：**逐个点名登记**，数量判据仍是"恰好"（不是 >=）。
  // 这三件的 schema 点到点 + 负例真链路不在此重造——verify-requirements.ts ⑧-5（96 条）与
  // verify-c015-service.ts（写口服务侧校验）各自守着；本脚本只做独立的身份/集合断言。
  const C015_TOOLS = ["manage_requirement", "manage_change", "import_plan_definitions"];
  // 2026-09-22（V07-02，DESIGN.md §5.6）：待重绑出口 rebind_task，注册表 17 → 18。
  // 定点更新（V06-10 先例）：逐个点名登记、数量判据仍是"恰好"，判据未放宽；
  // 其 schema/处置语义由 verify:v07-02 C/D 段与事件面检查（check-event-surface）守。
  const V0702_TOOLS = ["rebind_task"];
  // 2026-09-22（V07-04，DESIGN 附录 C.5-4）：接续入口体检 doctor，注册表 18 → 19。
  // 同一个口径（V06-10/V07-02 先例）：**逐个点名登记**、数量判据仍是"恰好"。其五段报因由
  // verify:v07-04 用真目录/真描述符/真端口守；本脚本只做身份/集合断言，不验语义。
  const V0704_TOOLS = ["doctor"];
  // 2026-09-26（V09-19，DESIGN.md §6.4／附录 E.18 四）：六图**完整当前状态**读口 get_project_graphs，
  // 注册表 18 → 19。同一个口径（V06-10/V07-02/V07-04 先例）：**逐个点名登记**、数量判据仍是"恰好"。
  // 其四档读取/同源/完整性口径由 verify:v09-19 用真实项目与夹具（大图分页、缺图、表损坏）守；
  // 本脚本只做身份/集合断言，不验语义。
  const V0919_TOOLS = ["get_project_graphs"];
  // 2026-09-30（V09-23，DESIGN §2.10 / docs/sync-evidence-contract.md）：同步证据域三接口，
  // 注册表 19 → 22。同一个口径（V06-10/V07-02/V07-04/V09-19 先例）：**逐个点名登记**、
  // 数量判据仍是"恰好"（**不**改成从注册表动态生成期望集合）。其契约/反例语义由
  // verify:sync-evidence 等各自守；本脚本只做身份/集合断言，不验语义。
  const V0923_TOOLS = ["register_sync_contract", "scan_sync_evidence", "read_sync_status"];
  // 2026-10-02（V09-27 契约 F3 / V09-28 契约 F1）：执行回执 report_execution、证据/审计
  // record_work_evidence、正向成套图纸入口 manage_baseline，注册表 22 → 25。同一个口径
  // （V06-10/V07-02/V07-04/V09-19/V09-23 先例）：**逐个点名登记**、数量判据仍是"恰好"
  // （不从注册表动态生成期望）。其行为语义由 verify:progress-reporting（handler+真宿主）与
  // verify:forward-journey（真 stdio MCP + 真 index.ts 完整旅程）各自守；本脚本只做身份/集合断言。
  const V0927_TOOLS = ["report_execution", "record_work_evidence", "manage_baseline"];
  // 2026-10-03（统一优化 V09-32/33/35，DESIGN §6.8／契约 U3）：施工图按卡/索引/章节/行范围原读取材
  // read_plan、深层结构下钻 expand_module，注册表 25 → 27。同一个口径（**逐个点名登记**、数量判据仍是"恰好"，
  // 不从注册表动态生成期望）。语义由 verify:v09-32/v09-33/v09-35 各自守；本脚本只做身份/集合断言。
  const V0932_TOOLS = ["read_plan", "expand_module"];
  // 2026-10-03（统一优化 V09-39，DESIGN §6.8／契约 U5/U5.1）：持久项目说明索引 project_index，注册表 27 → 28。
  // 同一个口径（**逐个点名登记**、数量判据仍是"恰好"）。语义由 verify:unified-index 守；本脚本只做身份/集合断言。
  const V0939_TOOLS = ["project_index"];
  ok(
    EXPECTED.every((n) => names.includes(n)) &&
      M5_TOOLS.every((n) => names.includes(n)) &&
      V0610_TOOLS.every((n) => names.includes(n)) &&
      C015_TOOLS.every((n) => names.includes(n)) &&
      V0702_TOOLS.every((n) => names.includes(n)) &&
      V0704_TOOLS.every((n) => names.includes(n)) &&
      V0919_TOOLS.every((n) => names.includes(n)) &&
      V0923_TOOLS.every((n) => names.includes(n)) &&
      V0927_TOOLS.every((n) => names.includes(n)) &&
      V0932_TOOLS.every((n) => names.includes(n)) &&
      V0939_TOOLS.every((n) => names.includes(n)) &&
      names.length ===
        EXPECTED.length +
          M5_TOOLS.length +
          V0610_TOOLS.length +
          C015_TOOLS.length +
          V0702_TOOLS.length +
          V0704_TOOLS.length +
          V0919_TOOLS.length +
          V0923_TOOLS.length +
          V0927_TOOLS.length +
          V0932_TOOLS.length +
          V0939_TOOLS.length,
    `listTools 恰含一期 8 个 + 扩充 2 个 + V06-10 三件套 + C-015 三件套 + V07-02 出口件 + V07-04 doctor + V09-19 六图读口 + V09-23 同步域三接口 + V09-27/V09-28 三接口 + V09-32/33/35 两件 + V09-39 project_index（实际 ${names.length} 个）`,
  );
  ok(!names.includes("write_design"), "权限证伪②：listTools 不存在 write_design");
  ok(
    !names.some((n) => /gate|write_design|set_step|record_gate/i.test(n)),
    "权限证伪③b：listTools 无任何 gate 写入类工具",
  );

  // ── DoD①：8 个工具逐个真实调用一次，贴入参与返回 ──

  // 1. list_projects
  const r1 = await call("list_projects", {});
  const p1 = JSON.parse(r1.text) as { projects: Array<{ id: string; name: string; path: string; kind: string }> };
  ok(
    p1.projects.length === 1 &&
      p1.projects[0].id === "m2-proj" &&
      p1.projects[0].name === "M2 验证项目" &&
      p1.projects[0].kind === "backend",
    "list_projects 返回 id/name/path/kind 与注册表一致",
  );

  // 2. select_project（DoD⑥：project_id 与 path 两种入参各调一次）
  const r2a = await call("select_project", { project_id: "m2-proj" });
  const p2a = JSON.parse(r2a.text) as { path: string; workstation_dir: string };
  ok(
    path.resolve(p2a.path) === path.resolve(projDir) &&
      p2a.workstation_dir === path.join(projDir, ".工作台"),
    "select_project(project_id) 返回项目根目录 + .工作台/ 路径",
  );
  const r2b = await call("select_project", { path: projDir });
  const p2b = JSON.parse(r2b.text) as { id: string; workstation_dir: string };
  ok(p2b.id === "m2-proj", "select_project(path) 按路径解析到同一项目");

  // 3. read_design
  const r3 = await call("read_design", { project_id: "m2-proj" });
  const p3 = JSON.parse(r3.text) as {
    design: { exists: boolean; content?: string };
    discuss: { exists: boolean };
  };
  ok(
    p3.design.exists && (p3.design.content ?? "").includes("read_design 应原样读回本行"),
    "read_design 返回 design.md 全文 + 待议记录（只读）",
  );

  // 4. read_progress
  const r4 = await call("read_progress", { project_id: "m2-proj" });
  const p4 = JSON.parse(r4.text) as {
    gate: { current_step: string; history: unknown[] };
    modules: Array<{ id: string; status: string }>;
  };
  ok(
    p4.gate.current_step === "kickoff" &&
      p4.gate.history.length === 7 &&
      p4.modules.some((m) => m.id === "m-1" && m.status === "todo"),
    "read_progress 返回 Gate 状态（current_step/history）+ 模块状态",
  );

  // 5. report_task_status（两条路径：首报即建档 → 再报改状态）
  const r5a = await call("report_task_status", {
    project_id: "m2-proj",
    task_id: "t-001",
    title: "实现 M2 验证任务",
    module_id: "m-1",
    status: "doing",
    note: "首报建档",
  });
  const p5a = JSON.parse(r5a.text) as { created: boolean; task: { reporter: string } };
  ok(
    p5a.created === true && p5a.task.reporter === CLIENT_NAME,
    `report_task_status 首报即建档，reporter 缺省取 MCP client 名（${CLIENT_NAME}）`,
  );
  const r5b = await call("report_task_status", {
    project_id: "m2-proj",
    task_id: "t-001",
    status: "done",
  });
  const p5b = JSON.parse(r5b.text) as { created: boolean; task: { status: string } };
  ok(p5b.created === false && p5b.task.status === "done", "report_task_status 再报改状态（done）");
  // note 留痕①：再报不传 note，tasks.json 里旧备注保留
  const tasksKeep = JSON.parse(fs.readFileSync(path.join(projDir, ".工作台", "tasks.json"), "utf8")) as {
    tasks: Array<{ note?: string }>;
  };
  ok(tasksKeep.tasks[0].note === "首报建档", "note 留痕：再报不传 note，旧备注保留（不冲掉）");
  // note 留痕②：再报传新 note，覆盖旧值
  const r5c = await call("report_task_status", {
    project_id: "m2-proj",
    task_id: "t-001",
    status: "done",
    note: "done，收工",
  });
  ok(!r5c.isError, "report_task_status 再报带 note 不报错");
  // DoD④：cat tasks.json，字段符合 §2.3.4
  const tasksJsonText = fs.readFileSync(path.join(projDir, ".工作台", "tasks.json"), "utf8");
  console.log(`\n[verify] ── cat .工作台/tasks.json:\n${tasksJsonText}`);
  const tf = JSON.parse(tasksJsonText) as {
    version: number;
    tasks: Array<Record<string, unknown>>;
  };
  const t1 = tf.tasks[0];
  ok(
    tf.version === 1 &&
      tf.tasks.length === 1 &&
      typeof t1.id === "string" &&
      typeof t1.title === "string" &&
      t1.module_id === "m-1" &&
      t1.status === "done" &&
      t1.reporter === CLIENT_NAME &&
      typeof t1.updated_at === "string" &&
      t1.note === "done，收工",
    "DoD④：tasks.json 字段符合 §2.3.4（id/title/module_id/status/reporter/updated_at/note?）",
  );

  // 6. update_progress（DoD⑤：改模块四色，gate.current_step 不动）
  const gateBefore = readProgress("m2-proj", dataDir).gate.current_step;
  const r6 = await call("update_progress", { project_id: "m2-proj", module_id: "m-1", status: "done" });
  const p6 = JSON.parse(r6.text) as { module: { id: string; status: string } };
  const after = readProgress("m2-proj", dataDir);
  const progressFileText = fs.readFileSync(path.join(projDir, ".工作台", "progress.json"), "utf8");
  console.log(`\n[verify] ── cat .工作台/progress.json:\n${progressFileText}`);
  ok(p6.module.id === "m-1" && p6.module.status === "done", "update_progress 改了模块四色状态（m-1 → done）");
  ok(
    after.gate.current_step === gateBefore && gateBefore === "kickoff",
    `DoD⑤：gate.current_step 未被动（${gateBefore} → ${after.gate.current_step}）`,
  );
  const r6bad = await call("update_progress", { project_id: "m2-proj", module_id: "m-1", status: "blocked" });
  ok(r6bad.isError, "update_progress 拒绝任务态值 blocked（模块只接受四色 todo/doing/done/issue）");

  // 7. append_discuss（正常追加 + DoD③ 证伪：改已有条目必须失败）
  const r7a = await call("append_discuss", {
    project_id: "m2-proj",
    content: "M2 验证：§6.3 report_task_status 的 note 不落盘，是否要在 §2.3.4 加字段？",
  });
  const p7a = JSON.parse(r7a.text) as { source: string; line: number; entry: string };
  ok(
    typeof p7a.line === "number" && p7a.entry.startsWith("- `"),
    `append_discuss 返回写入行号（line=${p7a.line}）`,
  );
  const r7b = await call("append_discuss", {
    project_id: "m2-proj",
    content: "试图改写第 1 条",
    index: 0,
    edit: true,
  });
  ok(
    r7b.isError && /只能追加/.test(r7b.text),
    "DoD③ 证伪：append_discuss 带 index/edit 字段改已有条目被拒绝",
  );
  const r7c = await call("append_discuss", {
    project_id: "m2-proj",
    content: "x",
    delete: 1,
  });
  ok(r7c.isError, "DoD③ 证伪：append_discuss 带 delete 字段被拒绝");
  const discussText = fs.readFileSync(path.join(projDir, ".工作台", "design.discuss.md"), "utf8");
  console.log(`\n[verify] ── cat .工作台/design.discuss.md:\n${discussText}`);
  ok(
    discussText.split(/\r?\n/).filter((l) => l.startsWith("- `")).length === 1,
    "证伪后 design.discuss.md 仍只有最初 1 条（追加未被篡改）",
  );

  // 8. list_tasks（不带 / 带 module_id 过滤各一次）
  const r8a = await call("list_tasks", { project_id: "m2-proj" });
  const p8a = JSON.parse(r8a.text) as { tasks: unknown[] };
  ok(p8a.tasks.length === 1, "list_tasks 返回任务列表");
  const r8b = await call("list_tasks", { project_id: "m2-proj", module_id: "m-9" });
  const p8b = JSON.parse(r8b.text) as { tasks: unknown[] };
  ok(p8b.tasks.length === 0, "list_tasks 按 module_id 过滤（m-9 → 空）");

  // ── V06-10 三件套（§6.7）：描述/入参 schema 点到点 + 各真调一次 ──
  // 本脚本的既有风格是"逐个点名 + 真调一次看返回"，这三件套照同一套办：
  // ① schema 层：name/description/required/properties 逐项对上（不许只由数量兜住）；
  // ② 行为层：真调一次。这个夹具项目没有 v2 事实、也没有跑写入服务，
  //    所以 project_entry 应回只读的"待审定"结论，两个写口应**明确拒绝**（不是静默成功、也不是崩）。
  const schemaOf = (name: string): { description?: string; required?: string[]; properties?: Record<string, unknown> } => {
    const t = tools.tools.find((x) => x.name === name);
    return (t?.inputSchema ?? {}) as { description?: string; required?: string[]; properties?: Record<string, unknown> };
  };
  const entryTool = tools.tools.find((t) => t.name === "project_entry");
  const entrySchema = schemaOf("project_entry");
  const entryProps = entrySchema.properties ?? {};
  // 定向更新（V09-34，2026-10-03）：入参 schema 由 §6.7 的既有五字段 + 一个**可选 boolean** `preconditions`
  //   变为恰好六字段。判据未放宽——仍是"恰好这几个键、多一个少一个都红"：
  //     旧期望 ["client_capabilities","known_revision","project_id","resume_hint","role"]｜依据：§6.7 五字段
  //     新期望 上述五项 + "preconditions"（type=boolean，默认 false 时**不改变**默认 entry 的既有业务字段）
  //   `required` 不变（仍只 project_id/role），`additionalProperties:false` 仍由实现侧守住。
  ok(
    entrySchema.required?.length === 2 &&
      entrySchema.required[0] === "project_id" &&
      entrySchema.required[1] === "role" &&
      Object.keys(entryProps).sort().join(",") ===
        ["client_capabilities", "known_revision", "preconditions", "project_id", "resume_hint", "role"].join(",") &&
      (entryProps.preconditions as { type?: string } | undefined)?.type === "boolean" &&
      (entryTool?.description ?? "").includes("只读"),
    "V06-10 project_entry 入参 schema 点到点：原 §6.7 五字段 + V09-34 可选 boolean preconditions（恰 6）、required 仍仅 project_id/role、描述写明只读",
  );
  const claimSchema = schemaOf("claim_task");
  const opEnum = ((claimSchema.properties?.op ?? {}) as { enum?: string[] }).enum ?? [];
  // 定向更新（V09-10，2026-09-24）：op 枚举 三值 → 四值。判据未放宽——仍是"恰好这几个值、多一个少一个都红"：
  //   旧期望 ["claim","renew","release"]｜依据：PLAN V09-10／DESIGN 附录 F——claim_task 增 op=reopen
  //   （协调器受控重开；**不新增工具**，工具面 18 计数与本文件工具清单断言零波及）｜
  //   新期望 ["claim","renew","release","reopen"]｜保留意图：op 面精确钉死、takeover_basis/expected_revision 在册。
  ok(
    claimSchema.required?.sort().join(",") === ["change_id", "project_id", "role", "task_id"].sort().join(",") &&
      opEnum.sort().join(",") === ["claim", "renew", "release", "reopen"].sort().join(",") &&
      (claimSchema.properties?.takeover_basis ?? undefined) !== undefined &&
      (claimSchema.properties?.expected_revision ?? undefined) !== undefined &&
      (claimSchema.properties?.reopen_basis ?? undefined) !== undefined,
    "V06-10 claim_task 入参 schema 点到点：必填四项 + op 四值枚举（V09-10 增 reopen）+ expected_revision/takeover_basis/reopen_basis 在册",
  );
  const submitSchema = schemaOf("submit_task_result");
  ok(
    ["claim_token", "expected_revision", "evidence_refs"].every((k) => (submitSchema.required ?? []).includes(k)) &&
      ["deliverables", "verification", "untested", "known_issues", "ownership_basis", "diff_ref"].every(
        (k) => (submitSchema.properties ?? {})[k] !== undefined,
      ),
    "V06-10 submit_task_result 入参 schema 点到点：认领/版本/证据必填 + 交付包字段在册",
  );

  const rPe = await call("project_entry", { project_id: "m2-proj", role: "executor" });
  const pPe = JSON.parse(rPe.text) as { next_action?: string; baseline?: { active: unknown } };
  // 枚举用**字面量**对账（同一份实现导出的常量拿来比等于自证，§6.7 的七个值写死在这里）
  const ENTRY_ACTIONS_RE = /^(resume_task|claim_task|review_result|await_role|await_decision|blocked|complete)$/;
  ok(
    !rPe.isError &&
      ENTRY_ACTIONS_RE.test(pPe.next_action ?? "") &&
      pPe.baseline?.active === null,
    `V06-10 project_entry 真调：没有生效基线 → next_action=${pPe.next_action}（只读入口不认领，§6.7）`,
  );
  const rClaim = await call("claim_task", {
    project_id: "m2-proj",
    task_id: "t-001",
    role: "executor",
    change_id: "chg-m2",
  });
  ok(
    rClaim.isError && /没有运行状态/.test(rClaim.text),
    "V06-10 claim_task 真调：没有 v2 事实/未导入定义 → 明确拒绝（窗口期不静默认领）",
  );
  const rSubmit = await call("submit_task_result", {
    project_id: "m2-proj",
    task_id: "t-001",
    role: "executor",
    change_id: "chg-m2",
    claim_token: "clm-not-issued",
    expected_revision: 1,
    evidence_refs: ["notes/none.txt"],
  });
  ok(
    rSubmit.isError && /没有运行状态/.test(rSubmit.text),
    "V06-10 submit_task_result 真调：同一个现场下明确拒绝（无认领就不收交付，§2.7）",
  );

  // ── DoD② 证伪：callTool write_design 必须失败（工具不存在）──
  const rWd = await call("write_design", { project_id: "m2-proj", content: "越权写设计书" });
  ok(rWd.isError, "DoD② 证伪：callTool write_design 回 isError（工具不存在）");

  // ── 无 gate 写入工具的旁证：callTool 假想 gate 工具必须失败 ──
  const rGate = await call("record_gate_transition", { project_id: "m2-proj", step: "kickoff", result: "pass" });
  ok(rGate.isError, "DoD③b 旁证：callTool 假想 gate 写入工具回 isError（不存在）");

  await client.close();
  await transport.close();
  fs.rmSync(tmpBase, { recursive: true, force: true });
  console.log(process.exitCode ? "\n[verify] 有 FAIL" : "\n[verify] 全部 PASS");
}

main().catch((err) => {
  console.error("[verify] 异常:", err);
  process.exitCode = 1;
});
