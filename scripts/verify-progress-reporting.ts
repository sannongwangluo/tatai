// V09-27 验证脚本：Agent 完整上报、回执与接续（PLAN V09-27；DESIGN.md §5.4/§5.5/§6.7；契约 F3/F5）。
//
// 口径：**经真实 MCP 工具 handler**（`src/mcp/tools` 的 findTool().handler）＋**真实唯一写入服务**
// （进程内 WorkService + 回环 HTTP + 描述符 + WorkServiceClient），不直接调库函数冒充工具入口。
// 隔离：mkdtemp 夹具 + 隔离 TATAI_HOME + 随机端口；不碰真实 ~/.tatai、真实项目与账本；收尾清临时目录。
//
// 覆盖：v1 行为保持与升级指南 / 开工 doing / 阻塞与协调器有依据解阻（错误 token·角色·旧版·无依据）/
// 幂等（同 request_id 重复=原回执、异内容拒）/ report_execution 启动·心跳·检查点·停止（缺确认拒）/
// record_work_evidence 存读证据·成果登记·自检（带 command 非零拒）·独审（作者即审者拒）·修复·复测·缺陷/
// 人工验收与 user 身份被拒 / submit_task_result 重试拿回原回执且异内容拒 / 服务不可用 / 重启接续 /
// current_runs 运行现场（缺心跳不当停机）/ 事件面检查。
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { addProject, resolveDataDir } from "../src/server/registry";
import { projectWorkDir } from "../src/server/workstation";
import { WorkService, WorkServiceClient, handleWorkRequest, writeServiceDescriptor } from "../src/server/work/service";
import { readTaskStates } from "../src/server/work/tasks";
import { importPlanChecked } from "../src/server/work/references";
import { activateBaseline } from "../src/server/work/documents";
import { readClaimEvents } from "../src/server/work/claims";
import { evaluateProjectEntry } from "../src/server/work/entry";
import { checkEventSurface } from "../src/server/work/eventSurface";
import { findTool, TOOLS } from "../src/mcp/tools";
import type { McpContext } from "../src/mcp/tools/types";

// ── 断言 ──
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

// ── 隔离夹具 ──
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-v0927-"));
const dataDir = path.join(tmpBase, "home");
const projRoot = path.join(tmpBase, "proj-fx");
const legacyRoot = path.join(tmpBase, "proj-legacy");
const noServiceDir = path.join(tmpBase, "no-service-home");
process.env.TATAI_HOME = dataDir;
process.env.TATAI_NO_AUTOSTART = "1"; // 验证脚本里绝不拉起独立写服务
const PID = "fx27";
const LEGACY = "fx27-legacy";
const CHG = "chg-27";
const workDir = path.join(projRoot, ".工作台", "work");
const PLAN_REL = ".工作台/plan.md";
const DESIGN_REL = ".工作台/design.md";

const mkdirp = (d: string): void => { fs.mkdirSync(d, { recursive: true }); };
const write = (f: string, t: string): void => { mkdirp(path.dirname(f)); fs.writeFileSync(f, t, "utf8"); };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Card { id: string; goal: string; dep?: string; role: string }
const planText = (title: string, cards: Card[]): string => {
  const L = [`# ${title}`, "", "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |", "| --- | --- | --- | --- | --- |"];
  for (const c of cards) L.push(`| ${c.id} | todo | ${c.goal} | ${c.dep ?? ""} | ${c.id} 的完成证据 |`);
  L.push("");
  for (const c of cards) L.push(`### ${c.id} ${c.goal}`, "", `**设计依据**：§1。**依赖**：${c.dep ?? "无"}。**文件责任**：\`src/${c.id.toLowerCase()}.ts\`。**责任角色**：${c.role}。`, "", `- [ ] ${c.goal} 达标`, "");
  return L.join("\n");
};
const PLAN_TEXT = planText("V09-27 夹具施工图", [
  { id: "T-1", goal: "夹具卡一", role: "executor" },
  { id: "T-2", goal: "夹具卡二", role: "executor" },
]);

interface ToolCall { ok: boolean; text: string; json: unknown }
async function call(name: string, args: Record<string, unknown>, context: McpContext): Promise<ToolCall> {
  const t = findTool(name);
  if (t === undefined) return { ok: false, text: `工具 ${name} 未注册（红：入口不存在）`, json: null };
  const r = await t.handler(args, context);
  const text = r.content?.[0]?.text ?? "";
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON 文本 */ }
  return { ok: r.isError !== true, text, json };
}
const asObj = (j: unknown): Record<string, unknown> => (typeof j === "object" && j !== null ? (j as Record<string, unknown>) : {});
const revOf = (taskId: string): number => readTaskStates(workDir).states[taskId]?.revision ?? -1;
const statusOf = (taskId: string): string => readTaskStates(workDir).states[taskId]?.status ?? "<none>";
const eventCount = (): number => { try { return readClaimEvents(workDir).length; } catch { return -1; } };

// ── 起一个真实写入服务（进程内）+ 描述符 ──
interface LiveServer { server: http.Server; port: number; service: WorkService; token: string }
async function startService(): Promise<LiveServer> {
  const service = new WorkService({ dataDir });
  const token = crypto.randomBytes(18).toString("base64url");
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    void handleWorkRequest(req, res, { service, token, pathname }).then((handled) => { if (!handled) { res.writeHead(404); res.end(); } });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  writeServiceDescriptor(dataDir, { schema_version: 2, pid: process.pid, host: "127.0.0.1", port, token, started_at: new Date().toISOString(), url: `http://127.0.0.1:${port}` });
  return { server, port, service, token };
}
const closeServer = (s: LiveServer): Promise<void> => new Promise((r) => s.server.close(() => r()));

async function main(): Promise<void> {
  info(`V09-27 上报链验证（${process.platform} · node ${process.version}）`);
  info(`  夹具根 ${tmpBase}（TATAI_HOME ${dataDir}）`);
  mkdirp(dataDir);
  mkdirp(noServiceDir);

  // ── 夹具：两个项目（proj-fx 迁移态；proj-legacy 未迁移） ──
  write(path.join(projRoot, DESIGN_REL), "# 夹具设计书\n\n## 1 目标\n\n夹具设计正文。\n");
  write(path.join(projRoot, PLAN_REL), PLAN_TEXT);
  write(path.join(legacyRoot, DESIGN_REL), "# 旧夹具设计书\n\n## 1 目标\n\n旧夹具正文。\n");
  addProject({ id: PID, name: "V09-27 夹具", path: projRoot, kind: "backend" }, dataDir);
  addProject({ id: LEGACY, name: "未迁移夹具", path: legacyRoot, kind: "backend" }, dataDir);

  const live = await startService();
  const client = new WorkServiceClient({ dataDir, autostart: false });
  const ctx: McpContext = { clientName: "verify-agent", work: client };
  const submitter = { submit: (c: unknown) => live.service.submit(c) };

  // 定义导入 + 基线激活（迁移态）
  const defs = importPlanChecked(PLAN_TEXT, workDir).definitions;
  const { submitDefinitionImports } = await import("../src/server/work/tasks");
  submitDefinitionImports(submitter, { project_id: PID, change_id: CHG, actor_id: "fixture", role: "coordinator", definitions: defs });
  activateBaseline(PID, { approved_by: "user", approval_basis: "V09-27 夹具审定", approval_kind: "user_confirmed" }, dataDir);

  // ═══ 0. 工具与事件面 ═══
  info("── 0. 工具注册与事件面");
  ok(findTool("report_execution") !== undefined, "report_execution 已注册");
  ok(findTool("record_work_evidence") !== undefined, "record_work_evidence 已注册");
  ok(findTool("manage_baseline") !== undefined, "manage_baseline 已注册（V09-27 统一集成）");
  const surface = checkEventSurface(TOOLS.map((t) => t.name));
  ok(surface.ok, "事件面检查通过（每个事件有出口或声明内部来源）", surface.problems);
  ok(TOOLS.map((t) => t.name).includes("report_execution"), "TOOLS 名单含新工具");

  // ═══ 1. v1 行为保持 + 已迁移项目升级指南 ═══
  info("── 1. v1 行为与升级指南");
  const v1legacy = await call("report_task_status", { project_id: LEGACY, task_id: "L-1", status: "doing", title: "旧卡" }, ctx);
  ok(v1legacy.ok, "v1 未迁移项目：report_task_status 照旧写 tasks.json", v1legacy.text.slice(0, 200));
  const legacyTasks = JSON.parse(fs.readFileSync(path.join(legacyRoot, ".工作台", "tasks.json"), "utf8")) as { tasks: { id: string; status: string }[] };
  ok(legacyTasks.tasks.some((t) => t.id === "L-1" && t.status === "doing"), "v1 写盘生效（L-1=doing）");
  const v1migrated = await call("report_task_status", { project_id: PID, task_id: "T-1", status: "doing" }, ctx);
  ok(!v1migrated.ok && /WRITE_UPGRADE_REQUIRED|升级写口/.test(v1migrated.text), "已迁移项目：旧写口被拒并给升级指南", v1migrated.text.slice(0, 240));

  // ═══ 2. 认领 → 开工 doing ═══
  info("── 2. 认领与开工 doing");
  let rev = revOf("T-1");
  const claim1 = await call("claim_task", { project_id: PID, task_id: "T-1", role: "executor", change_id: CHG, expected_revision: rev, owner_id: "agent-1", lease_ms: 1 }, ctx);
  ok(claim1.ok, "claim_task 认领成功", claim1.text.slice(0, 200));
  const claim1Json = asObj(claim1.json);
  const token1 = String((claim1Json.claim as Record<string, unknown> | undefined)?.claim_token ?? "");
  ok(token1 !== "", "拿到 claim token", token1.slice(0, 10));
  rev = revOf("T-1");

  const doing = await call("report_task_status", { project_id: PID, task_id: "T-1", status: "doing", expected_revision: rev, claim_token: token1, owner_id: "agent-1", role: "executor", change_id: CHG, request_id: "req-doing-1" }, ctx);
  ok(doing.ok && statusOf("T-1") === "executing", "v2 开工 doing → 执行中", { ok: doing.ok, status: statusOf("T-1"), text: doing.text.slice(0, 200) });
  rev = revOf("T-1");

  // 幂等：同 request_id 重复 → 原回执 duplicate；异内容 → 拒
  const doingRetry = await call("report_task_status", { project_id: PID, task_id: "T-1", status: "doing", expected_revision: rev, claim_token: token1, owner_id: "agent-1", role: "executor", change_id: CHG, request_id: "req-doing-1" }, ctx);
  ok(doingRetry.ok && asObj(doingRetry.json).duplicate === true, "同 request_id 重复上报 → 原回执 duplicate=true", doingRetry.text.slice(0, 220));
  const doingConflict = await call("report_task_status", { project_id: PID, task_id: "T-1", status: "doing", expected_revision: rev, claim_token: token1, owner_id: "agent-1", role: "executor", change_id: CHG, request_id: "req-doing-1", reason: "换了个理由" }, ctx);
  ok(!doingConflict.ok && /IDEMPOTENCY_CONFLICT/.test(doingConflict.text), "同 request_id 异内容 → IDEMPOTENCY_CONFLICT", doingConflict.text.slice(0, 220));

  // ═══ 3. 错误版本 / 错误 token / 错误角色 / 无依据解阻（零字节） ═══
  info("── 3. 反例：版本/token/角色/依据");
  const beforeRej = eventCount();
  const staleRev = await call("report_task_status", { project_id: PID, task_id: "T-1", status: "blocked", reason: "x", expected_revision: rev - 1, claim_token: token1, owner_id: "agent-1", role: "executor", change_id: CHG }, ctx);
  ok(!staleRev.ok && /VERSION_CONFLICT/.test(staleRev.text), "旧版本上报 → VERSION_CONFLICT", staleRev.text.slice(0, 200));
  const badToken = await call("report_task_status", { project_id: PID, task_id: "T-1", status: "blocked", reason: "x", expected_revision: rev, claim_token: "not-the-token", owner_id: "agent-1", role: "executor", change_id: CHG }, ctx);
  ok(!badToken.ok && /INVALID_COMMAND|认领/.test(badToken.text), "错误 token 上报 → 明确拒绝", badToken.text.slice(0, 240));
  const badRoleReady = await call("report_task_status", { project_id: PID, task_id: "T-1", status: "ready", expected_revision: rev, role: "executor", change_id: CHG, reason: "想解阻" }, ctx);
  ok(!badRoleReady.ok && /协调器/.test(badRoleReady.text), "非协调器解阻 → 拒（协调器专用）", badRoleReady.text.slice(0, 240));
  const noBasisReady = await call("report_task_status", { project_id: PID, task_id: "T-1", status: "ready", expected_revision: rev, role: "coordinator", change_id: CHG, reason: "无依据" }, ctx);
  ok(!noBasisReady.ok && /readiness_basis|依据/.test(noBasisReady.text), "无依据解阻 → 拒", noBasisReady.text.slice(0, 240));
  ok(eventCount() === beforeRej, "上述反例全部零字节（事件数不变）", { before: beforeRej, after: eventCount() });

  // ═══ 3.5 未知顶级键边界：v2 闭键拒绝；v1 兼容保持；新增两工具现闭键 ═══
  info("── 3.5 未知字段边界（v2 闭键 / v1 兼容）");
  const beforeUnknown = eventCount();
  const v2Unknown = await call("report_task_status", { project_id: PID, task_id: "T-1", status: "doing", expected_revision: rev, claim_token: token1, owner_id: "agent-1", role: "executor", change_id: CHG, unexpected_field: "x" }, ctx);
  ok(!v2Unknown.ok && /unexpected_field/.test(v2Unknown.text), "v2 上报带未知顶级键 → 拒并点名", v2Unknown.text.slice(0, 240));
  ok(!v2Unknown.text.includes(token1), "v2 未知键拒绝信息不回显 claim_token", v2Unknown.text.slice(0, 200));
  const v1Unknown = await call("report_task_status", { project_id: LEGACY, task_id: "L-2", status: "doing", reporter: "x", legacy_extra: "keep" }, ctx);
  ok(v1Unknown.ok, "v1 未迁移项目带未知键 → 原行为保持（兼容，不误判全体缺陷）", v1Unknown.text.slice(0, 200));
  const exUnknown = await call("report_execution", { op: "heartbeat", bogus_exec_key: 1 }, ctx);
  ok(!exUnknown.ok && /bogus_exec_key/.test(exUnknown.text), "report_execution 未知键 → 拒（现闭键，未改）", exUnknown.text.slice(0, 240));
  const evUnknown = await call("record_work_evidence", { op: "store", bogus_ev_key: 1 }, ctx);
  ok(!evUnknown.ok && /bogus_ev_key/.test(evUnknown.text), "record_work_evidence 未知键 → 拒（现闭键，未改）", evUnknown.text.slice(0, 240));
  ok(eventCount() === beforeUnknown, "未知键用例（v2 拒 + v1 兼容写旧文件）§账本事件数不变", { before: beforeUnknown, after: eventCount() });

  // ═══ 4. 阻塞 → 阻塞卡不许新领 → 协调器有依据解阻 → 再领 ═══
  info("── 4. 阻塞与解阻闭环");
  const blocked = await call("report_task_status", { project_id: PID, task_id: "T-1", status: "blocked", reason: "等前置卡证据", expected_revision: rev, claim_token: token1, owner_id: "agent-1", role: "executor", change_id: CHG, request_id: "req-blocked-1" }, ctx);
  ok(blocked.ok && statusOf("T-1") === "blocked", "阻塞上报成功（task.blocked）", { ok: blocked.ok, status: statusOf("T-1"), text: blocked.text.slice(0, 200) });
  rev = revOf("T-1");
  const reclaimBlocked = await call("claim_task", { project_id: PID, task_id: "T-1", role: "executor", change_id: CHG, expected_revision: rev, owner_id: "agent-2" }, ctx);
  ok(!reclaimBlocked.ok, "阻塞卡不许新领", reclaimBlocked.text.slice(0, 200));
  const ready = await call("report_task_status", { project_id: PID, task_id: "T-1", status: "ready", expected_revision: rev, role: "coordinator", change_id: CHG, reason: "前置已补齐", readiness_basis: [DESIGN_REL], request_id: "req-ready-1" }, ctx);
  ok(ready.ok && statusOf("T-1") === "ready", "协调器有依据解阻成功（status_changed ready）", { ok: ready.ok, status: statusOf("T-1"), text: ready.text.slice(0, 240) });
  rev = revOf("T-1");
  const claim2 = await call("claim_task", { project_id: PID, task_id: "T-1", role: "executor", change_id: CHG, expected_revision: rev, owner_id: "agent-2", takeover_basis: "旧认领租约已到期，隔离新工作目录并确认新 attempt", workspace: path.join(projRoot, ".工作台", "runs", "T-1", "att2") }, ctx);
  ok(claim2.ok, "解阻后可重新领取", claim2.text.slice(0, 160));
  const token2 = String((asObj(claim2.json).claim as Record<string, unknown> | undefined)?.claim_token ?? "");
  ok(token2 !== "" && token2 !== token1, "新认领 token ≠ 旧 token");
  const claim2Json = asObj(claim2.json).claim as Record<string, unknown> | undefined;
  const target = {
    project_id: PID,
    task_id: "T-1",
    run_id: String(claim2Json?.run_id ?? ""),
    attempt_id: String(claim2Json?.attempt_id ?? ""),
    workspace: String(claim2Json?.workspace ?? ""),
    claim_token: token2,
    change_id: CHG,
    owner_id: "agent-2",
    role: "executor",
    client_id: "kimi-code",
  };
  ok(target.run_id !== "" && target.workspace !== "", "拿到 run/workspace 现场", target);

  // ═══ 5. 运行现场：无事件 = 未知；心跳缺失不等于停机 ═══
  info("── 5. current_runs 运行现场（缺心跳不当停机）");
  const entry0 = evaluateProjectEntry({ project_id: PID, role: "executor", client_capabilities: "continuable" }, { dataDir });
  const run0 = entry0.current_runs.find((r) => r.task_id === "T-1");
  ok(run0?.run_site?.state === "no_events", "无执行事件 → run_site=no_events（未知）", run0?.run_site);

  const startedReq = await call("report_execution", { op: "start_requested", ...target, goal: "夹具执行", argv_digest: "d1", template_source: "tmpl", timeout_ms: 60000 }, ctx);
  ok(startedReq.ok, "report_execution(start_requested) 回执", startedReq.text.slice(0, 160));
  const pastIso = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const started = await call("report_execution", { op: "started", ...target, client_version: "0.9", argv_digest: "d1", pid: 1234, started_at: pastIso }, ctx);
  ok(started.ok, "report_execution(started) 回执", started.text.slice(0, 160));
  const beat = await call("report_execution", { op: "heartbeat", ...target, note: "正在改 calc.js", observed_at: pastIso }, ctx);
  ok(beat.ok, "report_execution(heartbeat) 回执", beat.text.slice(0, 160));
  const cp = await call("report_execution", { op: "checkpoint", ...target, note: "改到一半", artifacts: ["src/calc.js"], observed_at: pastIso }, ctx);
  ok(cp.ok, "report_execution(checkpoint) 回执", cp.text.slice(0, 160));
  const entry1 = evaluateProjectEntry({ project_id: PID, role: "executor", client_capabilities: "continuable" }, { dataDir });
  const run1 = entry1.current_runs.find((r) => r.task_id === "T-1");
  ok(run1?.run_site?.observed === true && run1?.run_site?.state !== "confirmed_stopped", "有执行回执时 run_site 观测到现场且不是已停止（缺心跳不当停机）", run1?.run_site);
  ok(run1?.run_site?.note !== undefined && !String(run1.run_site.note).includes("停止已确认"), "运行现场不把心跳/检查点读成停止", run1?.run_site?.note);
  ok(run1?.run_site?.last_checkpoint != null, "运行现场带出最后检查点", run1?.run_site?.last_checkpoint);
  // 函数级（livenessOf 既有判据）：10 分钟无信号 → unknown 且如实声明"缺心跳不等于停机"。
  // 工具级 run_site 因 requested_at 取服务端接收时刻（刚编辑必<2 分钟）而显示 alive——这正是"有信号"的口径；
  // 真正"长期无观测"的语义由这条函数级断言覆盖（card：工具端到端与函数测试分别记录）。
  const { livenessOf } = await import("../src/server/work/executionReceipts");
  const staleRec = {
    execution_id: "ex-stale", task_id: "T-1", run_id: "r", attempt_id: "a", attempt: 1, claim_token: "", owner_id: "",
    owner_role: "", coordinator_id: "", client_id: "", model: null, effort: null, workspace: "", project_id: PID, change_id: CHG,
    parent_execution_id: null, parent_run_id: null, site_state: "running", last_submitted_state: "running",
    requested_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(), started_at: null, client_version: null, pid: null,
    stopped_at: null, stop_confirmation: null, stop_confirmation_evidence: [], failed: null, delivered: null,
    heartbeats: [], checkpoints: [], effects: [], event_ids: [], revision: 1, updated_at: "",
  };
  const staleLive = livenessOf(staleRec as never, new Date().toISOString());
  ok(staleLive.state === "unknown" && staleLive.note.includes("不等于"), "函数级：10 分钟无心跳 → unknown（不是已停止）", staleLive);

  const stopNoConfirm = await call("report_execution", { op: "stopped", ...target }, ctx);
  ok(!stopNoConfirm.ok && /STOP_NOT_CONFIRMED|确认依据/.test(stopNoConfirm.text), "停止缺确认依据 → 拒收", stopNoConfirm.text.slice(0, 220));
  const stopReq = await call("report_execution", { op: "stop_requested", ...target, reason: "任务转派", confirm_method: "kill 后查 PID" }, ctx);
  ok(stopReq.ok, "report_execution(stop_requested) 回执", stopReq.text.slice(0, 160));
  const entryStop = evaluateProjectEntry({ project_id: PID, role: "executor", client_capabilities: "continuable" }, { dataDir });
  const runStop = entryStop.current_runs.find((r) => r.task_id === "T-1");
  ok(runStop?.run_site?.state !== "confirmed_stopped", "只有停止请求、未确认 → 仍非 confirmed_stopped", runStop?.run_site?.state);
  const stopped = await call("report_execution", { op: "stopped", ...target, confirmation: "kill 后按 PID 查不到进程 + 目录 mtime 不再变化", exit_code: 0 }, ctx);
  ok(stopped.ok, "report_execution(stopped) 带确认依据 → 回执", stopped.text.slice(0, 160));
  const entryStopped = evaluateProjectEntry({ project_id: PID, role: "executor", client_capabilities: "continuable" }, { dataDir });
  const runStopped = entryStopped.current_runs.find((r) => r.task_id === "T-1");
  ok(runStopped?.run_site?.state === "confirmed_stopped" && (runStopped?.run_site?.confirmation ?? "") !== "", "带确认依据的停止 → confirmed_stopped", runStopped?.run_site);

  // ═══ 6. record_work_evidence：证据/审计/缺陷 ═══
  info("── 6. record_work_evidence 存读与审计五件事");
  const store = await call("record_work_evidence", { op: "store", project_id: PID, role: "executor", kind: "self_check", content: "夹具自检输出\n", summary: "自检原始输出", binding: { revision_kind: "code", revision: "deadbeef" } }, ctx);
  ok(store.ok, "store 证据正文（宿主不可变写入）", store.text.slice(0, 200));
  const evSha = String(asObj(asObj(store.json).evidence).sha256 ?? "");
  ok(/^[0-9a-f]{64}$/.test(evSha), "证据内容寻址 sha256", evSha.slice(0, 12));
  const readBack = await call("record_work_evidence", { op: "read", project_id: PID, sha256: evSha }, ctx);
  ok(readBack.ok && String(asObj(asObj(readBack.json).evidence).content ?? "").includes("夹具自检输出"), "read 读回证据正文（同一份）", readBack.text.slice(0, 160));

  const sub = await call("record_work_evidence", { op: "submission", project_id: PID, role: "executor", actor_id: "agent-2", change_id: CHG, record_id: "sub-1", goal: "夹具成果", submitted_by: "agent-2", evidence_refs: [evSha], untested: [], known_issues: [] }, ctx);
  ok(sub.ok, "成果登记 submission", sub.text.slice(0, 160));
  const selfPass = await call("record_work_evidence", { op: "self_check", project_id: PID, role: "executor", actor_id: "agent-2", change_id: CHG, record_id: "sc-1", checked_by: "agent-2", conclusion: "pass", binding: { revision_kind: "code", revision: "deadbeef" }, checks: [{ check_id: "c1", command: "pnpm test", exit_code: 0, output_ref: evSha, evidence_sha256: evSha, verifies: "code" }] }, ctx);
  ok(selfPass.ok, "作者自检（带 command 退出码 0）", selfPass.text.slice(0, 160));
  const selfBad = await call("record_work_evidence", { op: "self_check", project_id: PID, role: "executor", actor_id: "agent-2", change_id: CHG, record_id: "sc-2", checked_by: "agent-2", conclusion: "pass", binding: { revision_kind: "code", revision: "deadbeef" }, checks: [{ check_id: "c1", command: "pnpm test", exit_code: 1, evidence_sha256: evSha, verifies: "code" }] }, ctx);
  ok(!selfBad.ok, "自检声称通过但退出码非零 → 写侧拒收", selfBad.text.slice(0, 220));
  const auditSelf = await call("record_work_evidence", { op: "independent_audit", project_id: PID, role: "auditor", actor_id: "agent-3", change_id: CHG, record_id: "au-1", auditor: "agent-3", author_id: "agent-3", conclusion: "pass", coverage: [] }, ctx);
  ok(!auditSelf.ok && /不能是被审作者本人|独立审计/.test(auditSelf.text), "独立审计：审计者=作者 → 拒", auditSelf.text.slice(0, 220));
  const coverage = [
    { area: "behavior_boundaries", status: "checked", basis: "边界用例" },
    { area: "data_concurrency", status: "checked", basis: "并发写" },
    { area: "interface_integration", status: "checked", basis: "工具入口" },
    { area: "failure_recovery", status: "checked", basis: "服务不可用" },
    { area: "trust_permission", status: "checked", basis: "越权反例" },
  ];
  const auditOk = await call("record_work_evidence", { op: "independent_audit", project_id: PID, role: "auditor", actor_id: "agent-3", change_id: CHG, record_id: "au-2", auditor: "agent-3", author_id: "agent-2", conclusion: "pass", coverage, checks: [{ check_id: "c1", result: "passed", evidence_sha256: evSha }], not_reported_scope: ["未跑性能"] }, ctx);
  ok(auditOk.ok, "独立审计（审计者≠作者 + 五视角覆盖）", auditOk.text.slice(0, 160));
  const fix = await call("record_work_evidence", { op: "fix", project_id: PID, role: "executor", actor_id: "agent-2", change_id: CHG, record_id: "fx-1", finding_id: "f-xyz", fix_revision: "rev2", fixed_by: "agent-2", evidence_ref: evSha }, ctx);
  ok(fix.ok, "修复记录（待复测）", fix.text.slice(0, 160));
  const retest = await call("record_work_evidence", { op: "retest", project_id: PID, role: "auditor", actor_id: "agent-3", change_id: CHG, record_id: "rt-1", finding_id: "f-xyz", retested_by: "agent-3", retest_evidence: evSha, result: "pass" }, ctx);
  ok(retest.ok, "复测记录", retest.text.slice(0, 160));
  const findOpen = await call("record_work_evidence", { op: "finding", sub_op: "open", project_id: PID, role: "auditor", actor_id: "agent-3", change_id: CHG, severity: "user_visible_defect", source: "verify:v0927", expected: "应返回 1", actual: "返回 0", repro: "复现步骤", evidence_sha256: evSha, object_id: "T-1" }, ctx);
  ok(findOpen.ok, "缺陷 open（含复现+证据 → 确认）", findOpen.text.slice(0, 200));
  const findingId = String(asObj(findOpen.json).finding_id ?? "");
  ok(findingId !== "", "缺陷 open 返回 finding_id", findingId);
  const findFix = await call("record_work_evidence", { op: "finding", sub_op: "fix", project_id: PID, role: "executor", actor_id: "agent-2", change_id: CHG, finding_id: findingId, fix_revision: "rev2", evidence_sha256: evSha }, ctx);
  ok(findFix.ok, "缺陷 fix（不自动关闭）", findFix.text.slice(0, 160));
  const findRetest = await call("record_work_evidence", { op: "finding", sub_op: "retest", project_id: PID, role: "auditor", actor_id: "agent-4", change_id: CHG, finding_id: findingId, retested_by: "agent-4", retest_evidence: "复现消失", result: "pass" }, ctx);
  ok(findRetest.ok, "缺陷 retest（pass 才关闭）", findRetest.text.slice(0, 160));

  // 人工验收/user 身份被拒
  const human = await call("record_work_evidence", { op: "acceptance", project_id: PID, role: "user", change_id: CHG }, ctx);
  ok(!human.ok && /不暴露人工验收|FORBIDDEN/.test(human.text), "人工验收 op → 不暴露（Agent 不代签）", human.text.slice(0, 200));
  const userRole = await call("record_work_evidence", { op: "submission", project_id: PID, role: "user", change_id: CHG, record_id: "sub-x", goal: "g" }, ctx);
  ok(!userRole.ok && /user/.test(userRole.text), "role=user 写身份 → 拒", userRole.text.slice(0, 200));

  // ═══ 7. submit_task_result 重试拿回原回执 ═══
  info("── 7. submit_task_result 幂等重试");
  rev = revOf("T-1");
  const submitArgs = { project_id: PID, task_id: "T-1", role: "executor", owner_id: "agent-2", change_id: CHG, claim_token: token2, expected_revision: rev, deliverables: ["交付物"], evidence_refs: [evSha], verification: [{ command: "pnpm test", exit_code: 0, output_ref: evSha }], untested: [], known_issues: [] };
  const submit1 = await call("submit_task_result", submitArgs, ctx);
  ok(submit1.ok && statusOf("T-1") === "result_submitted", "提交结果成功", { ok: submit1.ok, status: statusOf("T-1"), text: submit1.text.slice(0, 200) });
  const submit2 = await call("submit_task_result", submitArgs, ctx);
  ok(submit2.ok && asObj(submit2.json).receipt !== undefined && (asObj(submit2.json).receipt as Record<string, unknown>).duplicate === true, "同结果请求重试 → 拿回原回执 duplicate=true（不是 VERSION_CONFLICT）", submit2.text.slice(0, 260));
  const submitConflict = await call("submit_task_result", { ...submitArgs, deliverables: ["改了内容"] }, ctx);
  ok(!submitConflict.ok && /IDEMPOTENCY_CONFLICT/.test(submitConflict.text), "同键异内容 → IDEMPOTENCY_CONFLICT", submitConflict.text.slice(0, 240));
  ok(readClaimEvents(workDir).filter((e) => e.type === "task.result_submitted" && e.entity_id === "task:T-1").length === 1, "账本里 result_submitted 恰好 1 条（无二次效果）");

  // ═══ 8. 服务不可用 ═══
  info("── 8. 服务不可用不降级");
  const noService = new WorkServiceClient({ dataDir: noServiceDir, autostart: false });
  const ctxNo: McpContext = { clientName: "verify-agent-no-service", work: noService };
  const exNo = await call("report_execution", { op: "start_requested", ...target, goal: "x", argv_digest: "d", template_source: "t", timeout_ms: 1 }, ctxNo);
  ok(!exNo.ok && /SERVICE_UNAVAILABLE/.test(exNo.text), "服务不可用：report_execution 报 SERVICE_UNAVAILABLE", exNo.text.slice(0, 200));
  const evNo = await call("record_work_evidence", { op: "submission", project_id: PID, role: "executor", change_id: CHG, record_id: "s", goal: "g" }, ctxNo);
  ok(!evNo.ok && /SERVICE_UNAVAILABLE/.test(evNo.text), "服务不可用：record_work_evidence 报 SERVICE_UNAVAILABLE", evNo.text.slice(0, 200));

  // ═══ 9. 重启 / 新客户端接续 ═══
  info("── 9. 重启与接续");
  await closeServer(live);
  const eventsBeforeRestart = eventCount();
  await sleep(50);
  const live2 = await startService();
  const client2 = new WorkServiceClient({ dataDir, autostart: false });
  const ctx2: McpContext = { clientName: "verify-agent-restarted", work: client2 };
  ok(eventCount() === eventsBeforeRestart, "重启前后账本事件数一致（事实持久化）");
  const entryRestart = evaluateProjectEntry({ project_id: PID, role: "executor", client_capabilities: "continuable" }, { dataDir });
  ok(entryRestart.current_runs.find((r) => r.task_id === "T-1") === undefined, "T-1 已提交 → 不在途（重启后如实）");
  const v1After = await call("report_task_status", { project_id: PID, task_id: "T-1", status: "doing" }, ctx2);
  ok(!v1After.ok, "重启新客户端：旧写口仍被拒（事实未变）");
  const store2 = await call("record_work_evidence", { op: "store", project_id: PID, role: "executor", kind: "other", content: "重启后新证据\n", summary: "重启后", binding: { revision_kind: "code", revision: "deadbeef" } }, ctx2);
  ok(store2.ok, "重启新客户端：经新宿主写证据成功（同源）", store2.text.slice(0, 160));
  await closeServer(live2);

  info(`── 收尾：${passCount} PASS / ${failCount} FAIL`);
  if (process.env.TATAI_KEEP_TMP !== "1") {
    try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
  } else {
    info(`  保留现场 ${tmpBase}`);
  }
  if (process.exitCode && process.exitCode !== 0) {
    console.log("[verify] 结果: FAIL（上面有 FAIL 行）");
  } else {
    console.log("[verify] 结果: 全部 PASS");
  }
}

main().catch((e) => {
  console.error(`[verify] 脚本异常：${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  process.exitCode = 1;
});
