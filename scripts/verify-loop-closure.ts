// B3+B4 共同根因验证（PLAN V09-53 / V09-54；DESIGN §2.6/§2.7/§5.4/§5.6/§5.8/§6.7/§6.11；已审方案 §4A M1/M3）。
//
// 这是**实测工作流**，不是字段存在断言：用隔离 WorkService + **真实工具 handler**
// （project_entry / task_brief / claim_task / submit_task_result / preflight_task_result / record_work_evidence）
// 跑通「冷认领→执行→存证据/源清单→自检→独审→提交→复审终结→连读三次不重复→源变复验→失败重开」。
//
// 自带隔离环境：临时 `TATAI_HOME` + `os.tmpdir()` 下的夹具项目；宿主 HTTP 用**动态空闲端口**（绑 0），
// **绝不碰 8787**，也**绝不碰**任何真实项目/账本（D:/tatai、D:/demo-project）。
//
// 覆盖：
//   B3 chk-v09-53-01..07：字段完备 / 旧包·旧游标失效（含**源读数**与**跨请求游标**）/ 定义重排不按序号继承 /
//                          两模式同形 / 旧客户端 unsupported / 与预检同判据 / 逐项 next_operation 真实可执行
//   B4 chk-v09-54-01..08：三读不重复与复审终结 / 逐 check 关联与不采信 / 有界复验（相关源变恰一个动作、
//                          无关源不连坐）/ 失败返工闭合（受控重开）/ 幂等与预检边界 / 两轮同因诊断
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { addProject } from "../src/server/registry";
import { projectWorkDir } from "../src/server/workstation";
import { activateBaseline } from "../src/server/work/documents";
import { importTaskDefinitions, type TaskDefinition } from "../src/server/work/plan";
import { readTaskStates, submitDefinitionImports } from "../src/server/work/tasks";
import { submitSubmission } from "../src/server/work/audit";
import { buildSourceManifest } from "../src/server/work/sourceEvidence";
import { handleWorkRequest, WorkService, WorkServiceClient, writeServiceDescriptor } from "../src/server/work/service";
import { evaluateProjectEntry } from "../src/server/work/entry";
import { evaluateSubmitResultChecks } from "../src/server/work/submitChecks";
import { stableCheckDefinitionsOf, deriveObligations } from "../src/server/work/obligations";
import { collectProjectFacts, eventsSnapshotOf } from "../src/server/work/statusProjection";
import { LOCK_IN_NOT_CHECKED, RECORD_OP_KEYS, TOOL_PARAM_KEYS } from "../src/server/work/workPackage";
import { projectEntryTool, claimTaskTool, submitTaskResultTool } from "../src/mcp/tools/projectEntry";
import { taskBriefTool } from "../src/mcp/tools/taskBrief";
import { preflightTaskResultTool } from "../src/mcp/tools/preflightTaskResult";
import { recordWorkEvidenceTool } from "../src/mcp/tools/recordWorkEvidence";
import { findTool } from "../src/mcp/tools/index";
import type { McpTool, ToolResult } from "../src/mcp/tools/types";

// ── 断言与日志 ──
let passCount = 0;
let failCount = 0;
const ok = (cond: boolean, label: string, detail?: unknown): void => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (cond) passCount++;
  else {
    failCount++;
    process.exitCode = 1;
    if (detail !== undefined) console.log(`[verify]   现场：${JSON.stringify(detail).slice(0, 1600)}`);
  }
};
const section = (t: string): void => console.log(`\n[verify] ══ ${t}`);
const sha256 = (b: string | Buffer): string => crypto.createHash("sha256").update(b).digest("hex");

// ── 隔离环境 ──
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-loop-closure-"));
const dataDir = path.join(tmpBase, "home");
fs.mkdirSync(dataDir, { recursive: true });
process.env.TATAI_HOME = dataDir;
const service = new WorkService({ dataDir });
const CHG = "chg-loop-closure";
const executor = "kimi-code";
const auditor = "codex-audit";
const coordinator = "claude-code";

const write = (f: string, text: string): void => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text, "utf8");
};

// ── 夹具 ──
interface Card {
  id: string;
  goal: string;
  dep?: string;
  checks?: string[];
}
const defaultChecks = (id: string): string[] => [`**chk-${id.toLowerCase()}-01** 目标达标`, `**chk-${id.toLowerCase()}-02** 非作者复核：独立验证达标`];
function planText(title: string, cards: Card[]): string {
  const lines = ["# " + title, "", "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |", "| --- | --- | --- | --- | --- |"];
  for (const c of cards) lines.push(`| ${c.id} | todo | ${c.goal} | ${c.dep ?? ""} | ${c.id} 的完成证据 |`);
  lines.push("");
  for (const c of cards) {
    lines.push(`### ${c.id} ${c.goal}`, "");
    lines.push(`**设计依据**：§1。**依赖**：${c.dep ?? "无"}。**文件责任**：\`src/${c.id.toLowerCase()}.ts\`。`);
    lines.push("");
    for (const chk of c.checks ?? defaultChecks(c.id)) lines.push(`- [ ] ${chk}`);
    lines.push("");
  }
  return lines.join("\n");
}

interface Fixture {
  id: string;
  root: string;
  workDir: string;
  designFile: string;
  planFile: string;
  plan: string;
  defs: TaskDefinition[];
}
function makeFixture(id: string, cards: Card[]): Fixture {
  const root = path.join(tmpBase, id);
  fs.mkdirSync(path.join(root, ".工作台"), { recursive: true });
  const designFile = path.join(root, ".工作台", "design.md");
  const planFile = path.join(root, ".工作台", "plan.md");
  write(designFile, `# ${id} 设计书\n\n## 1 目标\n\n夹具设计正文。\n`);
  const plan = planText(`${id} 施工图`, cards);
  write(planFile, plan);
  addProject({ id, name: `闭环夹具 ${id}`, path: root, kind: "backend" }, dataDir);
  const imported = importTaskDefinitions(plan, { plan_revision: sha256(plan) });
  activateBaseline(id, { approved_by: "user", approval_basis: "闭环夹具审定", approval_kind: "user_confirmed" }, dataDir);
  if (cards.length > 0) {
    submitDefinitionImports(service, { project_id: id, change_id: CHG, actor_id: executor, role: "executor", definitions: imported.definitions });
  }
  return { id, root, workDir: projectWorkDir(id, dataDir), designFile, planFile, plan, defs: imported.definitions };
}

const eventsFile = (fx: Fixture): string => path.join(fx.workDir, "events.jsonl");
const eventsHash = (fx: Fixture): string => (fs.existsSync(eventsFile(fx)) ? sha256(fs.readFileSync(eventsFile(fx))) : "<none>");
const eventsText = (fx: Fixture): string => (fs.existsSync(eventsFile(fx)) ? fs.readFileSync(eventsFile(fx), "utf8") : "");
const revOf = (fx: Fixture, taskId: string): number => readTaskStates(fx.workDir).states[taskId]?.revision ?? 0;

const entryOf = (fx: Fixture, role: string, caps: unknown = "continuable", opts: Record<string, unknown> = {}): any =>
  evaluateProjectEntry({ project_id: fx.id, role, client_capabilities: caps }, { dataDir, ...opts });
const wpOf = (fx: Fixture, role: string, caps: unknown = "continuable", opts: Record<string, unknown> = {}): any =>
  entryOf(fx, role, caps, { work_package: true, ...opts }).work_package;
const checkOf = (wp: any, id: string): any => (wp?.checks ?? []).find((c: any) => c.check_id === id) ?? null;

// ── 工具调用 ──
function textOf(r: ToolResult): string {
  return (r.content ?? [])
    .filter((c): c is { type: "text"; text: string } => (c as { type: string }).type === "text")
    .map((c) => c.text)
    .join("\n");
}
async function callTool(tool: McpTool, args: Record<string, unknown>, ctx: Record<string, unknown> = {}): Promise<{ isError: boolean; text: string; json: any }> {
  const r = await tool.handler(args, { clientName: executor, ...ctx } as never);
  const text = textOf(r);
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { isError: r.isError === true, text, json };
}

// ── 宿主 HTTP（动态端口，绝不 8787） ──
const listen = (srv: http.Server): Promise<number> =>
  new Promise((resolve, reject) => {
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => resolve((srv.address() as { port: number }).port));
  });
async function startHost(token: string): Promise<{ port: number; close: () => void }> {
  const server = http.createServer((req, res) => {
    const pathname = (req.url ?? "/").split("?")[0];
    void handleWorkRequest(req, res, { service, token, pathname }).then((handled) => {
      if (!handled) {
        res.statusCode = 404;
        res.end("{}");
      }
    });
  });
  const port = await listen(server);
  return { port, close: () => server.close() };
}

/** 裸 HTTP GET 宿主只读入口（同一条生产路由代码）；返回解析后的 JSON 或 null。 */
async function httpEntryRaw(projectId: string, role: string, extra: Record<string, string> = {}): Promise<any | null> {
  if (hostHandle === null || hostHandle.port === undefined || hostHandle.token === undefined) return null;
  const qs = new URLSearchParams({ project_id: projectId, role, ...extra }).toString();
  return new Promise((resolve) => {
    const req = http.request(
      { host: "127.0.0.1", port: hostHandle!.port!, path: `/api/work/entry?${qs}`, method: "GET", headers: { "x-tatai-work-token": hostHandle!.token! } },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (d) => (body += d));
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on("error", () => resolve(null));
    req.end();
  });
}

/** 不带 `work_package` 的宿主读口回包（模拟"旧宿主/旧客户端"：默认契约逐字不变）。 */
async function fetchHostEntryByName(projectId: string, role: string): Promise<{ entry: Record<string, unknown> } | null> {
  const r = await httpEntryRaw(projectId, role);
  return r?.ok === true && r.entry !== undefined ? { entry: r.entry as Record<string, unknown> } : null;
}

/** 存一份源清单载体（真实工具 handler store），返回载体哈希与清单指纹。 */
async function storeManifest(
  fx: Fixture,
  client: WorkServiceClient,
  opts: { rel: string; taskId: string },
): Promise<{ blob: string; fingerprint: string }> {
  const fingerprint = buildSourceManifest(fx.root, [opts.rel]).fingerprint;
  const stored = await callTool(
    recordWorkEvidenceTool,
    { op: "store", project_id: fx.id, role: "executor", kind: "source_manifest", summary: `${opts.taskId} 源清单（${opts.rel}）`, binding: { revision_kind: "code", revision: fingerprint }, source_manifest: [opts.rel] },
    { work: client },
  );
  const blob = stored.json?.evidence?.sha256 as string;
  if (typeof blob !== "string" || !/^[0-9a-f]{64}$/.test(blob)) throw new Error(`夹具缺陷：源清单存证失败：${stored.text.slice(0, 300)}`);
  return { blob, fingerprint };
}

/** 记一条「通过」的自检（真实验证通路），可一次带上多条检查。 */
async function selfCheckPass(
  fx: Fixture,
  client: WorkServiceClient,
  opts: { recordId: string; taskId: string; checks: { checkId: string; blob: string; fingerprint: string }[] },
): Promise<{ isError: boolean; text: string; json: any }> {
  const first = opts.checks[0];
  return callTool(
    recordWorkEvidenceTool,
    {
      op: "self_check",
      project_id: fx.id,
      role: "executor",
      change_id: CHG,
      record_id: opts.recordId,
      task_id: opts.taskId,
      conclusion: "pass",
      binding: { revision_kind: "code", revision: first.fingerprint },
      checks: opts.checks.map((c) => ({ check_id: c.checkId, method: "跑了该检查对应的验证", evidence_sha256: c.blob, verifies: "code" })),
    },
    { work: client },
  );
}

async function main(): Promise<void> {
  // ═══════════════════ ① 冷认领：入口 + 逐项工作包（真实 MCP 工具，无宿主＝本地路径） ═══════════════════
  section("① 冷认领：project_entry/task_brief 真实挂接 + 逐项 next_operation 真实可执行");
  const fx = makeFixture("lc-a", [
    { id: "T-1", goal: "闭环主卡" },
    { id: "T-2", goal: "无关卡" },
  ]);
  {
    const pe = await callTool(projectEntryTool, { project_id: fx.id, role: "executor", client_capabilities: "continuable" });
    ok(!pe.isError && pe.json?.next_action === "claim_task", `① project_entry（真实工具）⇒ claim_task（实测 ${pe.json?.next_action}）`, pe.json?.next_action);
    ok(!pe.isError && typeof pe.json?.work_package === "object" && pe.json.work_package !== null, "① project_entry（真实工具，本地路径）带出 work_package（真实挂接）", Object.keys(pe.json ?? {}));
    const tb = await callTool(taskBriefTool, { project_id: fx.id, role: "executor", client_capabilities: "continuable", detail: "full" });
    ok(tb.json?.work_package_status === "ok" && tb.json?.work_package?.checks?.length >= 2, `① task_brief 带逐 check 工作包（status=${tb.json?.work_package_status}）`, tb.json?.work_package_status);

    const wp = wpOf(fx, "executor");
    ok(
      wp?.task_id === "T-1" && wp.checks.filter((c: any) => c.check_id.startsWith("chk-")).length === 2,
      "① 工作包只指向当前任务 T-1（含 2 条稳定键验收检查 + 1 条完成证据要求）",
      { task: wp?.task_id, checks: wp?.checks?.map((c: any) => c.check_id) },
    );
    const c1 = checkOf(wp, "chk-t-1-01");
    const c2 = checkOf(wp, "chk-t-1-02");
    ok(c1?.effective === "missing" && c2?.effective === "missing", "① 未开工 ⇒ 逐项 effective=missing（不按空集通过）");
    ok(
      c1?.next_operation?.tool === "record_work_evidence" && c1?.next_operation?.operation === "self_check",
      `① missing 且不要求独审 ⇒ record_work_evidence/self_check（实测 ${c1?.next_operation?.tool}.${c1?.next_operation?.operation}）`,
      c1?.next_operation,
    );
    ok(
      c2?.next_operation?.tool === "record_work_evidence" && c2?.next_operation?.operation === "independent_audit" && c2?.responsible_role === "auditor",
      `① missing 且 independence_required ⇒ 非作者独立审计（实测 ${c2?.next_operation?.tool}.${c2?.next_operation?.operation}/${c2?.responsible_role}）`,
      c2?.next_operation,
    );
    ok(
      !wp.checks.some((c: any) => c.next_operation.tool === "submit_task_result"),
      "① 未开工的逐项动作**不是** submit_task_result（不再一律推提交）",
      wp.checks.map((c: any) => `${c.check_id}:${c.next_operation.tool}.${c.next_operation.operation}`),
    );
    ok(wp.continuation.operation === "claim_task", `① continuation.operation 对齐入口真实动作（实测 ${wp.continuation.operation}）`);
    ok(!JSON.stringify(wp).includes("summarize_work_package_checks"), "① 不再出现虚构操作 summarize_work_package_checks");
    for (const c of wp.checks as any[]) {
      const op = c.next_operation.operation as string;
      const known = Object.keys(c.next_operation.known_args);
      const bad = known.filter((k) => !(RECORD_OP_KEYS[op] ?? []).includes(k));
      ok(bad.length === 0, `① ${c.check_id}：known_args 全落在 record_work_evidence(${op}) 闭键内（越界=${bad.join("/") || "无"}）`, known);
      ok(
        c.next_operation.missing_args.includes("record_id") && c.next_operation.missing_args.includes("conclusion"),
        `① ${c.check_id}：缺参点名 record_id/conclusion 等必填运行时字段`,
        c.next_operation.missing_args,
      );
      ok(!known.includes("claim_token") && !c.next_operation.missing_args.includes("claim_token"), `① ${c.check_id}：不回显/不索要 claim_token`);
      // B3-REVIEW-WATCH 11:36 第 4 项：能从快照取到的**真给**（本 check 的稳定 check_id 组成 checks 骨架），
      // 只有现场才能产的（method/证据哈希）才列缺参——不把整条检查的参数面留空让接手者猜。
      const scaffold = (c.next_operation.known_args as { checks?: { check_id?: unknown }[] }).checks;
      ok(
        Array.isArray(scaffold) && scaffold[0]?.check_id === c.check_id,
        `① ${c.check_id}：known_args.checks 骨架**真给**本 check 的稳定 check_id`,
        c.next_operation.known_args,
      );
      // B3-REVIEW-WATCH 12:40 第 2 项：**条件项**（第二档 evidence/method 二选一、机械 command+exit_code）进
      // 只读 `prerequisites`/`guidance`、不进 `missing_args`；独审没有无条件必填的 `checks[].` 子字段，
      // 故这里认「missing_args 有 checks[]. 或只读指导里给了条件组」两者之一，仍不许把整条检查的参数面留空。
      const onSiteInMissing = c.next_operation.missing_args.some((m: string) => m.startsWith("checks[]."));
      const onSiteGuide = [...(c.next_operation.prerequisites ?? []), ...(c.next_operation.guidance ?? [])].join("\n");
      ok(
        onSiteInMissing || /checks\[\]\./.test(onSiteGuide),
        `① ${c.check_id}：现场才能产的逐检查子字段（证据/方法/条件组）在 missing_args 或只读 guidance 里给到`,
        { missing: c.next_operation.missing_args, guidance: onSiteGuide.slice(0, 400) },
      );
    }

    const rev = wp.package_revision as string;
    const staleWp = wpOf(fx, "executor", "continuable", { work_package_expected_revision: "deadbeef" });
    ok(staleWp?.ok === false && staleWp.code === "REVISION_CHANGED", "① expected_revision 不符 ⇒ 工作包显式 REVISION_CHANGED（工具入口真连）", staleWp);
    const sameRev = wpOf(fx, "executor", "continuable", { work_package_expected_revision: rev });
    ok(sameRev?.ok !== false, "① expected_revision 相符 ⇒ 正常返回工作包");
    // 分页游标绑定 package_revision；跨版本显式失效
    const page1 = wpOf(fx, "executor", "continuable", { work_package_paging: { limit: 1 } });
    ok(page1.paging.complete === false && typeof page1.paging.cursor === "string", "① limit=1 ⇒ paging 给不透明游标", page1.paging);
    const staleCursor = wpOf(fx, "executor", "continuable", { work_package_paging: { limit: 1, cursor: page1.paging.cursor } });
    ok(staleCursor.ok !== false && staleCursor.checks.length === 1, "① 同版本同请求的游标可续读");
    const crossRequest = wpOf(fx, "coordinator", "coordination", { work_package_paging: { limit: 1, cursor: page1.paging.cursor } });
    ok(crossRequest?.ok === false && crossRequest.code === "REVISION_CHANGED", "① **跨请求**（不同接续模式/角色档）的游标不互用（显式失效）", crossRequest);
  }

  // ═══════════════════ ② 认领 → doing（真实 claim_task 工具） ═══════════════════
  section("② 认领 → doing → resume_task");
  const hostToken = "loop-closure-token";
  const host = await startHost(hostToken);
  hostHandle = { ...host, token: hostToken };
  writeServiceDescriptor(dataDir, { schema_version: 2, pid: process.pid, host: "127.0.0.1", port: host.port, token: hostToken, started_at: new Date().toISOString(), url: `http://127.0.0.1:${host.port}` });
  const client = new WorkServiceClient({ dataDir, autostart: false });
  let claimToken = "";
  {
    const claimed = await callTool(
      claimTaskTool,
      { op: "claim", project_id: fx.id, task_id: "T-1", role: "executor", owner_id: executor, change_id: CHG, expected_revision: revOf(fx, "T-1") },
      { work: client },
    );
    ok(!claimed.isError && claimed.json?.ok === true, "② 真实 claim_task 领取成功", claimed.json);
    claimToken = claimed.json?.claim?.claim_token ?? "";
    ok(claimToken !== "", "② 领到 claim_token（不回显在工作包里）");
    const done = entryOf(fx, "executor");
    ok(done.next_action === "resume_task", `② 已认领 ⇒ 入口给 resume_task（实测 ${done.next_action}）`);
    const wp2 = wpOf(fx, "executor");
    ok(wp2.continuation.operation === "resume_task", `② continuation.operation 随之对齐（实测 ${wp2.continuation.operation}）`);
    ok(wp2.ownership.owner_id === executor && wp2.task_revision === String(revOf(fx, "T-1")), "② ownership/task_revision 如实", wp2.ownership);
    ok(!JSON.stringify(wp2).includes(claimToken), "② 工作包**不回显** claim_token");
  }

  // ═══════════════════ ③ 逐 check 采信：正例 + 反例（真实 record_work_evidence 工具） ═══════════════════
  section("③ 逐 check 回报走正式采信通路（正例 + 错 ID / 错绑定 / 作者独审）");
  const srcRel = "src/t1.ts";
  let sourceBlob = "";
  {
    write(path.join(fx.root, srcRel), "export const T1_OK = true;\n");
    const made = await storeManifest(fx, client, { rel: srcRel, taskId: "T-1" });
    sourceBlob = made.blob;
    // 反例 1：错 check ID —— 记录合法但**不被采信**（当前定义里没有它）
    const wrongId = await callTool(
      recordWorkEvidenceTool,
      {
        op: "self_check",
        project_id: fx.id,
        role: "executor",
        change_id: CHG,
        record_id: "sc-wrong-id",
        task_id: "T-1",
        conclusion: "pass",
        binding: { revision_kind: "code", revision: made.fingerprint },
        checks: [{ check_id: "chk-does-not-exist", method: "手工", evidence_sha256: made.blob, verifies: "code" }],
      },
      { work: client },
    );
    ok(!wrongId.isError, "③ 错 check ID 的自检记录本身可写（写侧只管采信形态）");
    ok(checkOf(wpOf(fx, "executor"), "chk-t-1-01")?.effective === "missing", "③ 错 check ID **不被采信**：chk-t-1-01 仍 missing");

    // 反例 2：错源绑定（验代码却只绑文档）—— 写侧彩排闸逐项点名拒
    const wrongBinding = await callTool(
      recordWorkEvidenceTool,
      {
        op: "self_check",
        project_id: fx.id,
        role: "executor",
        change_id: CHG,
        record_id: "sc-bad-bind",
        task_id: "T-1",
        conclusion: "pass",
        binding: { revision_kind: "plan", revision: sha256(fx.plan).slice(0, 12) },
        checks: [{ check_id: "chk-t-1-01", method: "手工", evidence_sha256: made.blob, verifies: "code" }],
      },
      { work: client },
    );
    ok(wrongBinding.isError === true && /绑定|verifies|来源/.test(wrongBinding.text), "③ 错源绑定被拒且**逐项点名**（E.3.3）", wrongBinding.text.slice(0, 300));

    // 正例：合法自检（绑定 code 修订 = 源清单指纹）；一并满足该卡的完成证据要求
    const sc = await selfCheckPass(fx, client, {
      recordId: "sc-t1-01",
      taskId: "T-1",
      checks: [
        { checkId: "chk-t-1-01", blob: made.blob, fingerprint: made.fingerprint },
        { checkId: "T-1::evidence", blob: made.blob, fingerprint: made.fingerprint },
      ],
    });
    ok(!sc.isError && sc.json?.ok === true, "③ 合法自检经唯一写服务落账", sc.json);
    const after = wpOf(fx, "executor");
    ok(checkOf(after, "chk-t-1-01")?.effective === "passed", "③ chk-t-1-01 经正式采信通路 ⇒ passed", checkOf(after, "chk-t-1-01"));
    ok(checkOf(after, "chk-t-1-01")?.evidence_refs?.includes(sourceBlob), "③ 采信带证据引用（内容寻址）");
    ok(checkOf(after, "chk-t-1-02")?.effective === "missing", "③ 独审必需项**不被作者自检冒充**（仍 missing）");
    ok(checkOf(after, "chk-t-1-02")?.next_operation?.operation === "independent_audit", "③ 独审缺失 ⇒ 仍派非作者（不是先让作者自检）");
    ok(after.completion.satisfied === false, "③ completion 不因单项自检就 satisfied");

    // 反例 3：作者自己给自己签独审（同会话声明）
    const selfAudit = await callTool(
      recordWorkEvidenceTool,
      {
        op: "independent_audit",
        project_id: fx.id,
        role: "auditor",
        change_id: CHG,
        record_id: "au-self",
        task_id: "T-1",
        auditor,
        author_id: auditor,
        same_session_as_author: true,
        conclusion: "pass",
        coverage: [
          { area: "behavior_boundaries", basis: "看了" },
          { area: "data_concurrency", basis: "看了" },
          { area: "interface_integration", basis: "看了" },
          { area: "failure_recovery", basis: "看了" },
          { area: "trust_permission", basis: "看了" },
        ],
        checks: [{ check_id: "chk-t-1-02", result: "passed", evidence_sha256: sourceBlob, verifies: "code" }],
        binding: { revision_kind: "code", revision: made.fingerprint },
      },
      { work: client, clientName: auditor },
    );
    const afterSelfAudit = wpOf(fx, "executor");
    ok(
      selfAudit.isError === true || checkOf(afterSelfAudit, "chk-t-1-02")?.effective !== "passed",
      "③ 作者自签独审**不采信**（要么写侧拒，要么投影降级为作者自检）",
      { isError: selfAudit.isError, effective: checkOf(afterSelfAudit, "chk-t-1-02")?.effective, text: selfAudit.text.slice(0, 220) },
    );
  }

  // ═══════════════════ ④ 非作者独立审计 → 技术完成 ═══════════════════
  section("④ 非作者独立审计 ⇒ 逐 check 收口（B4 采信通路）");
  {
    const fingerprint = buildSourceManifest(fx.root, [srcRel]).fingerprint;
    const au = await callTool(
      recordWorkEvidenceTool,
      {
        op: "independent_audit",
        project_id: fx.id,
        role: "auditor",
        change_id: CHG,
        record_id: "au-t1-02",
        task_id: "T-1",
        auditor,
        author_id: executor,
        auditor_role: "auditor",
        conclusion: "pass",
        read_author_summary_first: false,
        same_session_as_author: false,
        coverage: [
          { area: "behavior_boundaries", basis: "读了实现与边界用例" },
          { area: "data_concurrency", basis: "查了并发路径" },
          { area: "interface_integration", basis: "核了接口契约" },
          { area: "failure_recovery", basis: "核了失败路径" },
          { area: "trust_permission", basis: "核了权限边界" },
        ],
        checks: [{ check_id: "chk-t-1-02", result: "passed", evidence_sha256: sourceBlob, verifies: "code" }],
        binding: { revision_kind: "code", revision: fingerprint },
      },
      { work: client, clientName: auditor },
    );
    ok(!au.isError && au.json?.ok === true, "④ 非作者独立审计落账", au.text.slice(0, 240));
    const wp = wpOf(fx, "executor");
    ok(checkOf(wp, "chk-t-1-02")?.effective === "passed", "④ chk-t-1-02 经非作者复核 ⇒ passed", checkOf(wp, "chk-t-1-02"));
    ok(checkOf(wp, "chk-t-1-02")?.next_operation?.tool === "", "④ 已收口的检查不再给待办动作");
    ok(wp.completion.satisfied === true, "④ 全部必需项有效通过 + 独审满足 ⇒ 技术完成", wp.completion);
  }

  // ═══════════════════ ⑤ 提交 → 复审终结 + 三读不重复 ═══════════════════
  section("⑤ 提交 → 复审终结（coordinator/auditor 两分支）+ 同事实三读不重复、不追加事件");
  {
    const submit = await callTool(
      submitTaskResultTool,
      {
        project_id: fx.id,
        task_id: "T-1",
        role: "executor",
        owner_id: executor,
        change_id: CHG,
        claim_token: claimToken,
        expected_revision: revOf(fx, "T-1"),
        evidence_refs: [srcRel],
        deliverables: ["T-1 实现"],
        verification: [],
        untested: [],
        known_issues: [],
      },
      { work: client },
    );
    ok(!submit.isError && submit.json?.ok === true, "⑤ 结果提交成功（真实 submit_task_result）", submit.text.slice(0, 260));

    const coord = entryOf(fx, "coordinator", "coordination");
    const aud = entryOf(fx, "auditor", "continuable");
    ok(coord.next_action !== "review_result", `⑤ 全部必需检查有效通过 ⇒ 协调者**不**再列复审候选（实测 ${coord.next_action}）`, coord.next_action);
    ok(aud.next_action !== "review_result", `⑤ 审计者也不再被反复派审（实测 ${aud.next_action}）`, aud.next_action);

    const before = eventsHash(fx);
    // 同一事实 + 同一进程内时钟（`now` 只影响租约判定；固定它才谈得上"同事实三读"）
    const fixedNow = new Date().toISOString();
    const reads = [0, 1, 2].map(() => {
      const e = entryOf(fx, "coordinator", "coordination", { now: fixedNow });
      // 契约要的是**同一动作**：入口的 `context_manifest.package_id` 含每次现算的包身份（既有 V09-31 口径），
      // 那不是"重复动作"；这里比 next_action + 理由（code/text/task）+ 必需列表。
      return JSON.stringify({ action: e.next_action, reasons: e.reasons, reads: e.required_reads });
    });
    ok(reads[0] === reads[1] && reads[1] === reads[2], "⑤ 同事实连读三次 ⇒ 同一动作、同一理由（不产生重复 review_result）");
    ok(eventsHash(fx) === before, "⑤ 三次读 events.jsonl **逐字节不变**（只读入口零写入）");
    const wpReads = [0, 1, 2].map(() => JSON.stringify(wpOf(fx, "coordinator", "coordination", { now: fixedNow })));
    ok(wpReads[0] === wpReads[1] && wpReads[1] === wpReads[2], "⑤ 工作包三读逐字节一致（幂等）");
    const wp = wpOf(fx, "coordinator", "coordination");
    ok(
      wp.continuation.operation !== "" && wp.continuation.operation !== "summarize_work_package_checks",
      `⑤ 工作包 continuation.operation 仍是入口真实动作（${wp.continuation.operation}）`,
    );
    ok(
      wp.continuation.operation === coord.next_action,
      "⑤ 工作包的 operation 与入口 next_action 逐字一致（不另造下一步）",
      { wp: wp.continuation.operation, entry: coord.next_action },
    );
    // 已完成卡**不再**出现在复审候选；当前动作转向下一张卡（T-2，尚未开工 ⇒ 不 satisfied）
    ok(wp.task_id === "T-2" && wp.completion.satisfied === false && wp.completion.remaining_checks.length > 0, "⑤ 当前动作转向下一张未开工卡 ⇒ 如实不 satisfied（不借别卡的绿）", { task: wp.task_id, completion: wp.completion });
  }

  // ⑤b 复审终结两分支：**独审义务未满足** ⇒ coordinator 与 auditor 都仍列；部分/旧审计不退出
  section("⑤b 复审终结两分支：独审未满足 ⇒ coordinator/auditor 都仍列（不因「有审计记录」退出）");
  {
    const fx5 = makeFixture("lc-i", [{ id: "T-1", goal: "独审未满足卡" }]);
    const cl5 = await callTool(
      claimTaskTool,
      { op: "claim", project_id: fx5.id, task_id: "T-1", role: "executor", owner_id: executor, change_id: CHG, expected_revision: revOf(fx5, "T-1") },
      { work: client },
    );
    ok(!cl5.isError, "⑤b 认领成功", cl5.text.slice(0, 160));
    write(path.join(fx5.root, "src/i1.ts"), "export const I1 = true;\n");
    const m5 = await storeManifest(fx5, client, { rel: "src/i1.ts", taskId: "T-1" });
    // 作者**自检**两条（含独审必需项）——独审义务未满足
    const sc5 = await selfCheckPass(fx5, client, {
      recordId: "sc-i-01",
      taskId: "T-1",
      checks: [
        { checkId: "chk-t-1-01", blob: m5.blob, fingerprint: m5.fingerprint },
        { checkId: "chk-t-1-02", blob: m5.blob, fingerprint: m5.fingerprint },
        { checkId: "T-1::evidence", blob: m5.blob, fingerprint: m5.fingerprint },
      ],
    });
    ok(!sc5.isError, "⑤b 作者自检落账（含独审必需项）", sc5.text.slice(0, 160));
    write(path.join(fx5.root, "evidence/i.txt"), "ok\n");
    const sub5 = await callTool(
      submitTaskResultTool,
      { project_id: fx5.id, task_id: "T-1", role: "executor", owner_id: executor, change_id: CHG, claim_token: cl5.json?.claim?.claim_token, expected_revision: revOf(fx5, "T-1"), evidence_refs: ["evidence/i.txt"], deliverables: [], verification: [], untested: [], known_issues: [] },
      { work: client },
    );
    ok(!sub5.isError && sub5.json?.ok === true, "⑤b 提交成功（有独立审计记录？没有——不该据此退出）", sub5.text.slice(0, 200));
    const coord5 = entryOf(fx5, "coordinator", "coordination");
    const aud5 = entryOf(fx5, "auditor", "continuable");
    ok(coord5.next_action === "review_result", `⑤b 协调者仍列复审候选（实测 ${coord5.next_action}）`, coord5.next_action);
    ok(aud5.next_action === "review_result", `⑤b 审计者仍列（独审义务未满足，**部分/旧审计不退出**）（实测 ${aud5.next_action}）`, aud5.next_action);
    const wp5 = wpOf(fx5, "auditor", "continuable");
    ok(checkOf(wp5, "chk-t-1-02")?.effective === "passed" && checkOf(wp5, "chk-t-1-02")?.next_operation?.operation === "independent_audit", "⑤b 自检撑着的独审必需项 ⇒ 仍派非作者复核", checkOf(wp5, "chk-t-1-02"));
    ok(wp5.completion.satisfied === false, "⑤b 独审义务未满足 ⇒ 不算技术完成（不越 canonical 独审口径）", wp5.completion);

  }

  // ⑥b 失败项的**前置推进**：在册缺陷未修 ⇒ 修复路径（不回退成"让审计者复测未修的缺陷"）；
  //     修复落账（缺陷 fixed_pending_retest）⇒ 下一步才轮到**非作者复测**。
  section("⑥b 失败项前置推进：未修 ⇒ fix（带在册 finding_id）；已修待复测 ⇒ retest（非作者）");
  {
    const fx6b = makeFixture("lc-m", [{ id: "T-1", goal: "失败前置卡" }]);
    const cl6b = await callTool(
      claimTaskTool,
      { op: "claim", project_id: fx6b.id, task_id: "T-1", role: "executor", owner_id: executor, change_id: CHG, expected_revision: revOf(fx6b, "T-1") },
      { work: client },
    );
    ok(!cl6b.isError, "⑥b 认领成功", cl6b.text.slice(0, 160));
    write(path.join(fx6b.root, "src/m1.ts"), "export const M1 = true;\n");
    const m6b = await storeManifest(fx6b, client, { rel: "src/m1.ts", taskId: "T-1" });
    // 登记缺陷 + 确认（到 confirmed 才允许 fix 推进到 fixed_pending_retest）
    const opened = await callTool(
      recordWorkEvidenceTool,
      { op: "finding", sub_op: "open", project_id: fx6b.id, role: "auditor", change_id: CHG, severity: "user_visible_defect", source: "m 检测", expected: "通过", actual: "失败", object_id: "T-1", repro: "夹具复现" },
      { work: client, clientName: auditor },
    );
    const findingId = opened.json?.finding_id as string;
    ok(typeof findingId === "string" && findingId !== "", "⑥b 缺陷登记入册（finding_id 从快照可取）", opened.text.slice(0, 240));
    const confirmed = await callTool(
      recordWorkEvidenceTool,
      { op: "finding", sub_op: "transition", project_id: fx6b.id, role: "auditor", change_id: CHG, finding_id: findingId, to: "confirmed" },
      { work: client, clientName: auditor },
    );
    ok(!confirmed.isError, "⑥b 缺陷确认（confirmed）", confirmed.text.slice(0, 200));
    const auFail6b = await callTool(
      recordWorkEvidenceTool,
      {
        op: "independent_audit",
        project_id: fx6b.id,
        role: "auditor",
        change_id: CHG,
        record_id: "au-m-fail",
        task_id: "T-1",
        auditor,
        author_id: executor,
        conclusion: "fail",
        coverage: [
          { area: "behavior_boundaries", basis: "复现了缺陷" },
          { area: "data_concurrency", basis: "查了" },
          { area: "interface_integration", basis: "查了" },
          { area: "failure_recovery", basis: "查了" },
          { area: "trust_permission", basis: "查了" },
        ],
        findings: [findingId],
        checks: [{ check_id: "chk-t-1-02", result: "failed", evidence_sha256: m6b.blob }],
        binding: { revision_kind: "plan", revision: sha256(fx6b.plan) },
      },
      { work: client, clientName: auditor },
    );
    ok(!auFail6b.isError, "⑥b 非作者审计判失败落账", auFail6b.text.slice(0, 200));
    const wp6b1 = wpOf(fx6b, "executor");
    const c6b1 = checkOf(wp6b1, "chk-t-1-02");
    ok(
      c6b1?.next_operation?.operation === "fix" && (c6b1.next_operation.known_args as { finding_id?: unknown }).finding_id === findingId,
      "⑥b 缺陷在册但未修 ⇒ 下一步 fix 且**真给** finding_id（不从快照取到的就不该留空）",
      c6b1?.next_operation,
    );
    // 落修复（finding → fixed_pending_retest）
    const fix6b = await callTool(
      recordWorkEvidenceTool,
      { op: "fix", project_id: fx6b.id, role: "executor", change_id: CHG, record_id: "fix-m-1", finding_id: findingId, fix_revision: sha256(fx6b.plan), fixed_by: executor, evidence_ref: "src/m1.ts" },
      { work: client, clientName: executor },
    );
    ok(!fix6b.isError, "⑥b 修复记录落账", fix6b.text.slice(0, 220));
    const wp6b2 = wpOf(fx6b, "auditor");
    const c6b2 = checkOf(wp6b2, "chk-t-1-02");
    ok(
      c6b2?.effective === "failed" && c6b2?.next_operation?.operation === "retest" && c6b2?.responsible_role === "auditor",
      "⑥b 修复已落（缺陷 fixed_pending_retest）⇒ 下一步才轮到**非作者复测**",
      { effective: c6b2?.effective, next: c6b2?.next_operation, role: c6b2?.responsible_role },
    );
    ok(wp6b2.completion.satisfied === false, "⑥b 缺陷未复测收口 ⇒ 仍不 satisfied");
  }

  // ⑤d 两分支互不串：**独审义务已满足**、只剩作者自己的普通缺项 ⇒ 不错误交审计，但协调者仍收件
  section("⑤d 独审已满足、只剩作者普通缺项 ⇒ 审计者不被误派；协调者仍收件");
  {
    const fx5d = makeFixture("lc-k", [{ id: "T-1", goal: "普通缺项卡" }]);
    const cl5d = await callTool(
      claimTaskTool,
      { op: "claim", project_id: fx5d.id, task_id: "T-1", role: "executor", owner_id: executor, change_id: CHG, expected_revision: revOf(fx5d, "T-1") },
      { work: client },
    );
    ok(!cl5d.isError, "⑤d 认领成功", cl5d.text.slice(0, 160));
    write(path.join(fx5d.root, "src/k1.ts"), "export const K1 = true;\n");
    const m5d = await storeManifest(fx5d, client, { rel: "src/k1.ts", taskId: "T-1" });
    const sub5d = await callTool(
      submitTaskResultTool,
      { project_id: fx5d.id, task_id: "T-1", role: "executor", owner_id: executor, change_id: CHG, claim_token: cl5d.json?.claim?.claim_token, expected_revision: revOf(fx5d, "T-1"), evidence_refs: ["src/k1.ts"], deliverables: [], verification: [], untested: [], known_issues: [] },
      { work: client },
    );
    ok(!sub5d.isError && sub5d.json?.ok === true, "⑤d 提交成功（作者自己的必需项 chk-t-1-01 还没做）", sub5d.text.slice(0, 200));
    // 只补**独审必需项**的非作者审计 ⇒ 独审义务满足，但 chk-t-1-01（不要求独审）仍缺
    const au5d = await callTool(
      recordWorkEvidenceTool,
      {
        op: "independent_audit",
        project_id: fx5d.id,
        role: "auditor",
        change_id: CHG,
        record_id: "au-k-01",
        task_id: "T-1",
        auditor,
        author_id: executor,
        auditor_role: "auditor",
        conclusion: "pass",
        read_author_summary_first: false,
        same_session_as_author: false,
        coverage: [
          { area: "behavior_boundaries", basis: "读了实现与边界用例" },
          { area: "data_concurrency", basis: "查了并发路径" },
          { area: "interface_integration", basis: "核了接口契约" },
          { area: "failure_recovery", basis: "核了失败路径" },
          { area: "trust_permission", basis: "核了权限边界" },
        ],
        checks: [{ check_id: "chk-t-1-02", result: "passed", evidence_sha256: m5d.blob, verifies: "code" }],
        binding: { revision_kind: "code", revision: m5d.fingerprint },
      },
      { work: client, clientName: auditor },
    );
    ok(!au5d.isError && au5d.json?.ok === true, "⑤d 非作者独审把 chk-t-1-02 收口", au5d.text.slice(0, 220));
    const aud5d = entryOf(fx5d, "auditor", "continuable");
    const coord5d = entryOf(fx5d, "coordinator", "coordination");
    ok(
      aud5d.next_action !== "review_result",
      `⑤d 独审义务已满足、只剩作者自己的普通缺项 ⇒ **不**把卡错误交审计（实测 ${aud5d.next_action}）`,
      aud5d.reasons,
    );
    ok(coord5d.next_action === "review_result", `⑤d 协调者仍收件（两分支互不串；实测 ${coord5d.next_action}）`, coord5d.reasons);
  }

  // ⑤c 独审必需项**从未记录**（一条 check 记录都没有）⇒ 审计者必须能接（不是只有"作者自检撑着"才派）
  section("⑤c 独审必需项从未记录 ⇒ auditor 可接（basis=null 也要派，不只在「已 passed 作者」时分流）");
  {
    const fx5c = makeFixture("lc-j", [{ id: "T-1", goal: "独审从未记录卡" }]);
    const cl5c = await callTool(
      claimTaskTool,
      { op: "claim", project_id: fx5c.id, task_id: "T-1", role: "executor", owner_id: executor, change_id: CHG, expected_revision: revOf(fx5c, "T-1") },
      { work: client },
    );
    ok(!cl5c.isError, "⑤c 认领成功", cl5c.text.slice(0, 160));
    write(path.join(fx5c.root, "evidence/j.txt"), "ok\n");
    // 直接提交结果：**任何** check 记录都没有（独审必需项从未记录）
    const sub5c = await callTool(
      submitTaskResultTool,
      { project_id: fx5c.id, task_id: "T-1", role: "executor", owner_id: executor, change_id: CHG, claim_token: cl5c.json?.claim?.claim_token, expected_revision: revOf(fx5c, "T-1"), evidence_refs: ["evidence/j.txt"], deliverables: [], verification: [], untested: [], known_issues: [] },
      { work: client },
    );
    ok(!sub5c.isError && sub5c.json?.ok === true, "⑤c 提交成功（独审必需项一条记录都没有）", sub5c.text.slice(0, 200));
    const audC = entryOf(fx5c, "auditor", "continuable");
    ok(
      audC.next_action === "review_result",
      `⑤c 独审必需项从未记录 ⇒ 审计者可接（实测 ${audC.next_action}）——真正缺独审的卡不会无人接`,
      audC.reasons,
    );
    const wpC = wpOf(fx5c, "auditor", "continuable");
    ok(
      checkOf(wpC, "chk-t-1-02")?.effective === "missing" && checkOf(wpC, "chk-t-1-02")?.next_operation?.operation === "independent_audit",
      "⑤c 逐项工作包同样把 missing 的独审必需项点名给非作者",
      checkOf(wpC, "chk-t-1-02"),
    );
  }

  // ═══════════════════ ⑥ 失败返工闭合：受控重开 + 旧证据留存 ═══════════════════
  section("⑥ 失败持续阻断 → 修复不自关 → 受控重开 → 有效复验才恢复（旧判词留存）");
  {
    const fx6 = makeFixture("lc-b", [{ id: "T-1", goal: "重开卡" }]);
    const cl6 = await callTool(
      claimTaskTool,
      { op: "claim", project_id: fx6.id, task_id: "T-1", role: "executor", owner_id: executor, change_id: CHG, expected_revision: revOf(fx6, "T-1"), lease_ms: 3000 },
      { work: client },
    );
    const token6 = cl6.json?.claim?.claim_token as string;
    ok(!cl6.isError && typeof token6 === "string", "⑥ 认领成功（短租约，用于演示租约到期后的受控重开）", cl6.text.slice(0, 180));

    write(path.join(fx6.root, "src/b1.ts"), "export const B1 = true;\n");
    const m6 = await storeManifest(fx6, client, { rel: "src/b1.ts", taskId: "T-1" });
    const sc6 = await selfCheckPass(fx6, client, {
      recordId: "sc-b-01",
      taskId: "T-1",
      checks: [
        { checkId: "chk-t-1-01", blob: m6.blob, fingerprint: m6.fingerprint },
        { checkId: "T-1::evidence", blob: m6.blob, fingerprint: m6.fingerprint },
      ],
    });
    // 注意：**不**给 chk-t-1-02 记作者自检——否则作者的"通过"会盖过非作者的失败记录
    // （`pickCheckRecords` 取最优记录；该口径在共享层，不在本卡写域）。
    ok(!sc6.isError, "⑥ 作者自检落账", sc6.text.slice(0, 160));
    // 非作者审计**判失败**
    const openedB = await callTool(recordWorkEvidenceTool,
      { op: "finding", sub_op: "open", project_id: fx6.id, role: "auditor", change_id: CHG,
        severity: "user_visible_defect", source: "b-test", expected: "pass", actual: "fail", object_id: "T-1", repro: "fixture" },
      { work: client, clientName: auditor });
    const findingB = openedB.json?.finding_id as string;
    const auFail = await callTool(
      recordWorkEvidenceTool,
      {
        op: "independent_audit",
        project_id: fx6.id,
        role: "auditor",
        change_id: CHG,
        record_id: "au-b-fail",
        task_id: "T-1",
        auditor,
        author_id: executor,
        conclusion: "fail",
        coverage: [
          { area: "behavior_boundaries", basis: "复现了缺陷" },
          { area: "data_concurrency", basis: "查了" },
          { area: "interface_integration", basis: "查了" },
          { area: "failure_recovery", basis: "查了" },
          { area: "trust_permission", basis: "查了" },
        ],
        findings: [findingB],
        checks: [{ check_id: "chk-t-1-02", result: "failed", evidence_sha256: m6.blob }],
        binding: { revision_kind: "plan", revision: sha256(fx6.plan) },
      },
      { work: client, clientName: auditor },
    );
    ok(!auFail.isError, "⑥ 非作者审计判失败已如实落账", auFail.text.slice(0, 200));
    const afterFail = wpOf(fx6, "executor");
    ok(checkOf(afterFail, "chk-t-1-02")?.effective === "failed", "⑥ 失败**持续阻断**（chk-t-1-02=failed）", checkOf(afterFail, "chk-t-1-02"));
    // B3-REVIEW-WATCH 11:36 第 3 项：失败**还没修** ⇒ 先给**修复路径**（不直接要求 auditor 复测未修的缺陷）；
    // 在册缺陷能取到的就在 known_args 里真给，取不到的把 `finding_id` 当**明确前置**点名。
    ok(
      checkOf(afterFail, "chk-t-1-02")?.next_operation?.tool === "record_work_evidence" &&
        checkOf(afterFail, "chk-t-1-02")?.next_operation?.operation === "fix",
      "⑥ 非作者判失败、缺陷还没修 ⇒ 下一步是**修复**（不是直接复测未修的缺陷）",
      checkOf(afterFail, "chk-t-1-02")?.next_operation,
    );
    ok(
      (checkOf(afterFail, "chk-t-1-02")?.next_operation?.known_args as { finding_id?: unknown })?.finding_id !== undefined ||
        checkOf(afterFail, "chk-t-1-02")?.next_operation?.missing_args?.includes("finding_id"),
      "⑥ 修复路径如实点名在册缺陷；没有在册缺陷时把 finding_id 列为**明确前置**（先登记缺陷）",
      checkOf(afterFail, "chk-t-1-02")?.next_operation,
    );
    ok(afterFail.completion.satisfied === false && afterFail.completion.remaining_checks.includes("chk-t-1-02"), "⑥ 失败 ⇒ 不 satisfied（缺口逐条点名）", afterFail.completion);
    // 受控修复（`op=fix`）记录本身**不自动关闭**失败
    const fixRec = await callTool(
      recordWorkEvidenceTool,
      { op: "fix", project_id: fx6.id, role: "executor", change_id: CHG, record_id: "fix-b-1", finding_id: findingB, fix_revision: sha256(fx6.plan), fixed_by: executor, evidence_ref: "evidence/b.txt" },
      { work: client },
    );
    ok(!fixRec.isError || /拒/.test(fixRec.text), "⑥ 受控修复记录（op=fix）可写或按口径拒", fixRec.text.slice(0, 200));
    const stillBlocked = wpOf(fx6, "executor");
    ok(checkOf(stillBlocked, "chk-t-1-02")?.effective === "failed" && stillBlocked.completion.satisfied === false, "⑥ 修复记录**不自行关闭**失败（仍是 failed，§5.6）", checkOf(stillBlocked, "chk-t-1-02"));

    // 提交（在租约内）后等租约到期，再受控重开
    write(path.join(fx6.root, "evidence/b.txt"), "ok\n");
    const sub6 = await callTool(
      submitTaskResultTool,
      { project_id: fx6.id, task_id: "T-1", role: "executor", owner_id: executor, change_id: CHG, claim_token: token6, expected_revision: revOf(fx6, "T-1"), evidence_refs: ["evidence/b.txt"], deliverables: [], verification: [], untested: [], known_issues: [] },
      { work: client },
    );
    ok(!sub6.isError && sub6.json?.ok === true, "⑥ 结果提交成功（租约内）", sub6.text.slice(0, 200));
    await new Promise((r) => setTimeout(r, 3400));
    const reopen = await callTool(
      claimTaskTool,
      { op: "reopen", project_id: fx6.id, task_id: "T-1", role: "coordinator", owner_id: coordinator, change_id: CHG, reason: "独立复核未过：修复后复验", reopen_basis: ["src/b1.ts"], expected_revision: revOf(fx6, "T-1") },
      { work: client, clientName: coordinator },
    );
    ok(!reopen.isError && reopen.json?.ok === true, "⑥ 协调器受控重开成功（新 attempt）", reopen.text.slice(0, 260));
    ok(reopen.json?.reopen?.attempt >= 2, "⑥ 重开产生 attempt≥2（不覆盖已提交结果）", reopen.json?.reopen);

    const oldTokenSubmit = await callTool(
      submitTaskResultTool,
      { project_id: fx6.id, task_id: "T-1", role: "executor", owner_id: executor, change_id: CHG, claim_token: token6, expected_revision: revOf(fx6, "T-1"), evidence_refs: ["evidence/b.txt"], deliverables: [], verification: [], untested: [], known_issues: [] },
      { work: client },
    );
    ok(oldTokenSubmit.isError === true, "⑥ 重开后**旧认领 token 即刻作废**（旧 token 提交被拒）", oldTokenSubmit.text.slice(0, 240));

    const ledger6 = eventsText(fx6);
    ok(ledger6.includes("sc-b-01") && ledger6.includes("au-b-fail"), "⑥ 旧证据与旧判词**永不被删除**（历史在册）");

    const reClaim = await callTool(
      claimTaskTool,
      { op: "claim", project_id: fx6.id, task_id: "T-1", role: "executor", owner_id: executor, change_id: CHG, expected_revision: revOf(fx6, "T-1") },
      { work: client },
    );
    ok(!reClaim.isError && reClaim.json?.ok === true, "⑥ 重开后可再次领取（新 attempt）", reClaim.text.slice(0, 220));
    // 有效复验（非作者）才恢复
    const auPass = await callTool(
      recordWorkEvidenceTool,
      {
        op: "independent_audit",
        project_id: fx6.id,
        role: "auditor",
        change_id: CHG,
        record_id: "au-b-pass",
        task_id: "T-1",
        auditor,
        author_id: executor,
        conclusion: "pass",
        resolves: ["au-b-fail"],
        fix_refs: ["fix-b-1"],
        coverage: [
          { area: "behavior_boundaries", basis: "复现已消失" },
          { area: "data_concurrency", basis: "查了" },
          { area: "interface_integration", basis: "查了" },
          { area: "failure_recovery", basis: "查了" },
          { area: "trust_permission", basis: "查了" },
        ],
        checks: [{ check_id: "chk-t-1-02", result: "passed", evidence_sha256: m6.blob }],
        binding: { revision_kind: "plan", revision: sha256(fx6.plan) },
      },
      { work: client, clientName: auditor },
    );
    ok(!auPass.isError, "⑥ 非作者**有效复验**落账", auPass.text.slice(0, 200));
    const recovered = wpOf(fx6, "executor");
    ok(checkOf(recovered, "chk-t-1-02")?.effective === "passed", "⑥ 有效复验后**恢复**（chk-t-1-02=passed）", checkOf(recovered, "chk-t-1-02"));
    ok(eventsText(fx6).includes("au-b-fail"), "⑥ 恢复**不清除**旧判词（失败记录仍在册，§5.6）");
  }

  // ═══════════════════ ⑦ 有界复验：相关源变恰一个动作、无关源不连坐 ═══════════════════
  section("⑦ 有界复验：相关源变 ⇒ 恰一个可识别复验动作；无关源变不连坐");
  {
    const cl = makeFixture("lc-c", [{ id: "T-1", goal: "源变卡", checks: ["**chk-t-1-01** 目标达标"] }]);
    const relA = "src/c1.ts";
    const relEv = "src/c-evidence-src.ts";
    const relNever = "src/never-declared.ts";
    write(path.join(cl.root, relA), "export const C1 = 1;\n");
    write(path.join(cl.root, relEv), "export const CEV = 1;\n");
    write(path.join(cl.root, relNever), "export const N = 1;\n");
    const made = await storeManifest(cl, client, { rel: relA, taskId: "T-1" });
    const madeEv = await storeManifest(cl, client, { rel: relEv, taskId: "T-1" });
    const scC = await selfCheckPass(cl, client, { recordId: "sc-c1", taskId: "T-1", checks: [{ checkId: "chk-t-1-01", blob: made.blob, fingerprint: made.fingerprint }] });
    const scCev = await selfCheckPass(cl, client, { recordId: "sc-c-ev", taskId: "T-1", checks: [{ checkId: "T-1::evidence", blob: madeEv.blob, fingerprint: madeEv.fingerprint }] });
    ok(!scC.isError && !scCev.isError, "⑦ 前置：该卡检查经正式通路自检通过", scC.text.slice(0, 200));
    const before = wpOf(cl, "executor");
    ok(before.completion.satisfied === true && checkOf(before, "chk-t-1-01")?.effective === "passed", "⑦ 前置：该卡全部必需检查已有效通过", before.completion);
    const revBefore = before.package_revision;
    const actionBefore = before.continuation.action_id;

    const a1 = wpOf(cl, "executor");
    ok(a1.continuation.action_id === actionBefore, "⑦ 同事实重复读 ⇒ 同一动作（不重复派）");

    // 相关源变（无新事件）
    write(path.join(cl.root, relA), "export const C1 = 2;\n");
    const afterRel = wpOf(cl, "executor");
    ok(afterRel.package_revision !== revBefore, "⑦ 相关源变（无新事件）⇒ package_revision 变（旧包/旧游标失效；§5.6）", { revBefore, after: afterRel.package_revision });
    ok(checkOf(afterRel, "chk-t-1-01")?.effective === "stale", "⑦ 相关源变 ⇒ 命中 source_manifest，该检查转待复验（stale）", checkOf(afterRel, "chk-t-1-01"));
    ok(
      afterRel.completion.satisfied === false &&
        afterRel.checks.filter((c: any) => c.effective !== "passed").length === 1 &&
        afterRel.completion.remaining_checks[0] === "chk-t-1-01",
      "⑦ 恰**一个**检查进入待复验（复验动作只有一个）",
      afterRel.completion,
    );
    ok(afterRel.continuation.action_id !== actionBefore, "⑦ 相关源变产生**新的**一个可识别复验动作（action_id 改变）");
    const afterRel2 = wpOf(cl, "executor");
    ok(afterRel2.continuation.action_id === afterRel.continuation.action_id, "⑦ 同一事实重复读 ⇒ 复验动作稳定（不重复派审）");
    ok(checkOf(afterRel, "chk-t-1-01")?.uncovered?.some((u: string) => u.includes(relA)) === true, "⑦ 缺口逐条点名该源路径", checkOf(afterRel, "chk-t-1-01")?.uncovered);

    // 无关源变：不连坐
    const revRel = afterRel.package_revision;
    const actionRel = afterRel.continuation.action_id;
    write(path.join(cl.root, relNever), "export const N = 2;\n");
    write(path.join(cl.root, "src/another-untouched.ts"), "export const X = 1;\n");
    const afterIrrel = wpOf(cl, "executor");
    ok(afterIrrel.package_revision === revRel, "⑦ 无关源变**不**改包版本、不连坐（§5.6）", { revRel, after: afterIrrel.package_revision });
    ok(afterIrrel.continuation.action_id === actionRel, "⑦ 无关源变 ⇒ 同一动作（action_id 不变）");
    ok(checkOf(afterIrrel, "chk-t-1-01")?.effective === "stale", "⑦ 无关源变不改变该项的新鲜度判据");
    void made;

    // 定义重排不按序号继承通过
    const swapped = planText("lc-c 施工图", [{ id: "T-1", goal: "源变卡", checks: ["**chk-t-1-01** 目标达标"] }]);
    const fpBy = (plan: string): Record<string, string> =>
      Object.fromEntries(stableCheckDefinitionsOf(importTaskDefinitions(plan, { plan_revision: sha256(plan) }).definitions[0]).map((x) => [x.check_id, x.definition_fingerprint]));
    ok(JSON.stringify(fpBy(cl.plan)) === JSON.stringify(fpBy(swapped)), "⑦ 定义重排/改序号 ⇒ 稳定键定义指纹不变（不按序号继承通过）", { a: fpBy(cl.plan), b: fpBy(swapped) });
  }

  // ═══════════════════ ⑧ DESIGN/PLAN 缺失 ⇒ fail-closed ═══════════════════
  section("⑧ 设计/施工图读不到 ⇒ fail-closed（读不到 ≠ 没变）");
  {
    const fx8 = makeFixture("lc-d", [{ id: "T-1", goal: "源缺失卡" }]);
    const designBackup = fs.readFileSync(fx8.designFile);
    fs.rmSync(fx8.designFile);
    const e8 = entryOf(fx8, "executor");
    const noDesign = wpOf(fx8, "executor");
    ok(e8.next_action === "blocked" && e8.baseline.source_changed_since_baseline === true, "⑧ 删 DESIGN ⇒ 入口 blocked + 不算「没变」", { a: e8.next_action });
    ok(noDesign === null || noDesign.work_package?.completion?.satisfied === false || noDesign.completion?.satisfied === false, "⑧ 源读不到 ⇒ 工作包不冒充成功", noDesign?.completion ?? noDesign);
    fs.writeFileSync(fx8.designFile, designBackup);
    const planBackup = fs.readFileSync(fx8.planFile);
    fs.rmSync(fx8.planFile);
    ok(entryOf(fx8, "executor").next_action === "blocked", "⑧ 删 PLAN ⇒ 同样 blocked");
    fs.writeFileSync(fx8.planFile, planBackup);
  }

  // ═══════════════════ ⑨ 两模式同形 + 旧客户端 unsupported ═══════════════════
  section("⑨ direct_tatai / coordinator_managed 同形；只读客户端**具名** unsupported");
  {
    const fx9 = makeFixture("lc-e", [{ id: "T-1", goal: "同形卡" }]);
    const direct = wpOf(fx9, "executor", "continuable");
    const managed = wpOf(fx9, "coordinator", "coordination");
    ok(direct.source_mode === "direct_tatai" && managed.source_mode === "coordinator_managed", "⑨ 两种接续模式如实标注", { a: direct.source_mode, b: managed.source_mode });
    ok(
      direct.package_revision === managed.package_revision &&
        JSON.stringify(direct.checks) === JSON.stringify(managed.checks) &&
        JSON.stringify(direct.completion) === JSON.stringify(managed.completion),
      "⑨ 两模式**同形同判据**（package_revision / checks / completion 一致）",
    );
    const ro = wpOf(fx9, "executor", null); // client_capabilities=null ⇒ 未声明 ⇒ 只读档（conservative fail-closed）
    ok(ro.unsupported.length > 0 && ro.unsupported.every((u: any) => u.tool !== "" && u.operation !== "" && u.reason.length > 0), "⑨ 只读客户端 ⇒ unsupported **逐工具/操作具名**（不是一句全局 read_only）", ro.unsupported);

    // 宿主在跑（D1 已接通）：宿主只读入口**显式索取** work_package ⇒ 客户端经宿主拿到逐 check 工作包，
    // 不再是 `unsupported_by_host`；且必须是宿主那一份（同一现读快照），不是本地另算。
    const brief = await callTool(taskBriefTool, { project_id: fx9.id, role: "executor", client_capabilities: "continuable", detail: "full" });
    ok(
      brief.json?.work_package_status === "ok" && Array.isArray(brief.json?.work_package?.checks) && brief.json.work_package.checks.length >= 1,
      `⑨ 经宿主只读入口 ⇒ task_brief 拿到逐 check 工作包（实测 ${brief.json?.work_package_status}），不再 unsupported_by_host`,
      { status: brief.json?.work_package_status, checks: brief.json?.work_package?.checks?.length },
    );
    const peHost = await callTool(projectEntryTool, { project_id: fx9.id, role: "executor", client_capabilities: "continuable" });
    ok(
      !peHost.isError && peHost.json?.work_package !== undefined && typeof peHost.json?.work_package?.package_revision === "string",
      "⑨ project_entry（宿主路径）真带 package_revision 的工作包（D1 全链接通）",
      { hasWorkPackage: peHost.json?.work_package !== undefined, source: peHost.json?.source ?? null },
    );
    // 旧宿主（不认 `work_package` 查询参数）不会带该字段 ⇒ 仍必须**如实**标 unsupported_by_host，不本地另算。
    // 用不带该参数的裸宿主读口模拟旧宿主：回包里没有 work_package。
    const legacyView = await fetchHostEntryByName(fx9.id, "executor");
    ok(
      legacyView !== null && (legacyView.entry as { work_package?: unknown }).work_package === undefined,
      "⑨ 不带 work_package 的宿主读口回包**逐字不含**该字段（旧宿主/旧客户端兼容：默认契约不变）",
      legacyView === null ? "读口不可达" : Object.keys(legacyView.entry as object).slice(0, 20),
    );
  }

  // ═══════════════════ ⑩ 预检不是通行票 + 幂等 ═══════════════════
  section("⑩ 预检不产生授权；同键同内容返回原回执、同键异内容明确拒");
  {
    const fx10 = makeFixture("lc-f", [{ id: "T-1", goal: "幂等卡" }]);
    const claimed = await callTool(
      claimTaskTool,
      { op: "claim", project_id: fx10.id, task_id: "T-1", role: "executor", owner_id: executor, change_id: CHG, expected_revision: revOf(fx10, "T-1") },
      { work: client },
    );
    const token = claimed.json?.claim?.claim_token as string;
    write(path.join(fx10.root, "evidence/out.txt"), "ok\n");
    const intent = {
      project_id: fx10.id,
      task_id: "T-1",
      role: "executor",
      owner_id: executor,
      change_id: CHG,
      claim_token: token,
      expected_revision: revOf(fx10, "T-1"),
      evidence_refs: ["evidence/out.txt"],
      deliverables: [],
      verification: [],
      untested: [],
      known_issues: [],
    };
    const beforeTree = eventsHash(fx10);
    const pre = await callTool(preflightTaskResultTool, intent as unknown as Record<string, unknown>, { work: client });
    ok(!pre.isError && pre.json?.ok === true, "⑩ 预检返回判据结果", pre.text.slice(0, 220));
    ok(eventsHash(fx10) === beforeTree, "⑩ 预检零写入（events.jsonl 逐字节不变）");
    const submitBadRev = await callTool(submitTaskResultTool, { ...intent, expected_revision: (intent.expected_revision as number) + 99 }, { work: client });
    ok(submitBadRev.isError === true, "⑩ 预检结果**不是通行票**：版本不符的提交仍被拒", submitBadRev.text.slice(0, 220));

    const s1 = await callTool(submitTaskResultTool, intent as unknown as Record<string, unknown>, { work: client });
    ok(!s1.isError && s1.json?.ok === true, "⑩ 首次提交成功", s1.text.slice(0, 220));
    const s2 = await callTool(submitTaskResultTool, intent as unknown as Record<string, unknown>, { work: client });
    ok(s2.json?.ok === true, "⑩ 同键同内容 ⇒ 原回执（不另起效果）", { duplicate: s2.json?.duplicate, seq: s2.json?.receipt?.seq });
    const seq1 = s1.json?.receipt?.seq ?? s1.json?.seq;
    const seq2 = s2.json?.receipt?.seq ?? s2.json?.seq;
    ok(seq1 !== undefined && seq1 === seq2, "⑩ 两次回执指向**同一提交**（序号相同，不重复落账）", { seq1, seq2 });
    const s3 = await callTool(submitTaskResultTool, { ...intent, deliverables: ["改了内容"] }, { work: client });
    ok(s3.isError === true, "⑩ 同键**异内容** ⇒ 明确拒绝（不冒称重放）", s3.text.slice(0, 220));

    const probe = evaluateSubmitResultChecks({ ...intent, claim_token: "clm-x" } as never, null, { dataDir });
    ok(
      JSON.stringify(probe.not_checked.map((r) => r.kind)) === JSON.stringify(LOCK_IN_NOT_CHECKED.map((r) => r.kind)),
      "⑩ 工作包 lock_in_not_checked 与 submit_task_result 真实现场**同一份**（未查项显式 not_checked）",
      { real: probe.not_checked.map((r) => r.kind) },
    );
  }

  // ═══════════════════ ⑪ 两轮同因诊断 ═══════════════════
  section("⑪ 同一原因连续两轮无进展 ⇒ 转协调者诊断共同前置（不是自动放行）");
  {
    const fx11 = makeFixture("lc-g", [{ id: "T-3", goal: "两轮同因卡" }]);
    // 先把 T-3 真的提交掉（否则入口会先给 claim_task，轮不到复审）
    const cl11 = await callTool(
      claimTaskTool,
      { op: "claim", project_id: fx11.id, task_id: "T-3", role: "executor", owner_id: executor, change_id: CHG, expected_revision: revOf(fx11, "T-3") },
      { work: client },
    );
    write(path.join(fx11.root, "evidence/g.txt"), "ok\n");
    const sub11 = await callTool(
      submitTaskResultTool,
      { project_id: fx11.id, task_id: "T-3", role: "executor", owner_id: executor, change_id: CHG, claim_token: cl11.json?.claim?.claim_token, expected_revision: revOf(fx11, "T-3"), evidence_refs: ["evidence/g.txt"], deliverables: [], verification: [], untested: [], known_issues: [] },
      { work: client },
    );
    ok(!sub11.isError && sub11.json?.ok === true, "⑪ 前置：T-3 已提交（之后两轮同因从既有回执识别）", sub11.text.slice(0, 180));
    for (const rid of ["sub-t3-r1", "sub-t3-r2"]) {
      submitSubmission(service, {
        project_id: fx11.id,
        change_id: CHG,
        actor_id: executor,
        role: "executor",
        record_id: rid,
        task_id: "T-3",
        goal: "两轮同因",
        submitted_by: executor,
        untested: [{ item: "还没跑集成", reason: "同一原因" }],
        known_issues: ["同一已知问题"],
        evidence_refs: [],
      } as never);
    }
    const entry = entryOf(fx11, "coordinator", "coordination");
    const reasonText = JSON.stringify(entry.reasons ?? []);
    ok(entry.next_action === "review_result", `⑪ 未收口的已提交卡仍进复审（实测 ${entry.next_action}）`, entry.next_action);
    ok(/两轮同因/.test(reasonText), "⑪ 从既有结果回执识别「两轮同因无进展」并提示转协调者诊断（不另建事件类型）", reasonText.slice(0, 420));
    ok(/不是.*自动放行|免验|放弃/.test(reasonText), "⑪ 文案明确「不是自动放行/免验/放弃」");
  }

  // ⑪b 正例（B4 复审 11:36 第 2 条）：**备注逐字相同**但两轮之间真有了有效通过 ⇒ **不得**误报「两轮同因」
  section("⑪b 备注相同但有效检查减少了 ⇒ 不误报「两轮同因无进展」");
  {
    const fx11b = makeFixture("lc-l", [{ id: "T-1", goal: "有进展的卡" }]);
    const cl11b = await callTool(
      claimTaskTool,
      { op: "claim", project_id: fx11b.id, task_id: "T-1", role: "executor", owner_id: executor, change_id: CHG, expected_revision: revOf(fx11b, "T-1") },
      { work: client },
    );
    ok(!cl11b.isError, "⑪b 认领成功", cl11b.text.slice(0, 160));
    write(path.join(fx11b.root, "src/l1.ts"), "export const L1 = true;\n");
    const m11b = await storeManifest(fx11b, client, { rel: "src/l1.ts", taskId: "T-1" });
    const sameNotes = { untested: [{ item: "还没跑集成", reason: "同一原因" }], known_issues: ["同一已知问题"] };
    // 第一轮提交（备注 X）
    submitSubmission(service, {
      project_id: fx11b.id,
      change_id: CHG,
      actor_id: executor,
      role: "executor",
      record_id: "sub-l-r1",
      task_id: "T-1",
      goal: "同一备注两轮",
      submitted_by: executor,
      ...sameNotes,
      evidence_refs: [],
      occurred_at: "2026-10-07T10:00:00.000Z",
    } as never);
    // 两轮**之间**：落一条真实有效通过（作者自检收口一条验收检查）
    const sc11b = await callTool(
      recordWorkEvidenceTool,
      {
        op: "self_check",
        project_id: fx11b.id,
        role: "executor",
        change_id: CHG,
        record_id: "sc-l-01",
        task_id: "T-1",
        occurred_at: "2026-10-07T10:05:00.000Z",
        conclusion: "pass",
        binding: { revision_kind: "code", revision: m11b.fingerprint },
        checks: [{ check_id: "chk-t-1-01", method: "跑了该检查对应的验证", evidence_sha256: m11b.blob, verifies: "code" }],
      },
      { work: client },
    );
    ok(!sc11b.isError && sc11b.json?.ok === true, "⑪b 两轮之间落了真实有效通过（chk-t-1-01）", sc11b.text.slice(0, 200));
    // 第二轮提交（备注逐字相同）
    submitSubmission(service, {
      project_id: fx11b.id,
      change_id: CHG,
      actor_id: executor,
      role: "executor",
      record_id: "sub-l-r2",
      task_id: "T-1",
      goal: "同一备注两轮",
      submitted_by: executor,
      ...sameNotes,
      evidence_refs: [],
      occurred_at: "2026-10-07T10:10:00.000Z",
    } as never);
    const eff = wpOf(fx11b, "coordinator", "coordination");
    const check11b = (eff.checks ?? []).find((c: any) => c.check_id === "chk-t-1-01");
    ok(check11b?.effective === "passed", "⑪b 前提成立：期间新增的有效通过确实生效（chk-t-1-01=passed）", check11b);
    const entry11b = entryOf(fx11b, "coordinator", "coordination");
    const reasons11b = JSON.stringify(entry11b.reasons ?? []);
    ok(
      !/两轮同因/.test(reasons11b),
      "⑪b 备注逐字相同但期间有有效通过 ⇒ **不**误报「两轮同因无进展」（比真实进展事实，不是只比备注）",
      entry11b.reasons,
    );
  }

  // ⑪c 反例（Codex 12:04）：**别的任务**的修复/复测不得冒充本任务的进展 ⇒ 本任务照旧报「两轮同因」
  section("⑪c 两轮之间只有**其他任务**的修复 ⇒ 本任务仍报「两轮同因」（进展必须归属本任务）");
  {
    // T-2 依赖 T-1（T-1 未收口前 T-2 不可领）⇒ 提交 T-1 后协调者动作落在**复审**，不会被新的可领卡截走。
    const fx11c = makeFixture("lc-n", [
      { id: "T-1", goal: "停滞卡" },
      { id: "T-2", goal: "无关卡", dep: "T-1" },
    ]);
    const cl11c = await callTool(
      claimTaskTool,
      { op: "claim", project_id: fx11c.id, task_id: "T-1", role: "executor", owner_id: executor, change_id: CHG, expected_revision: revOf(fx11c, "T-1") },
      { work: client },
    );
    ok(!cl11c.isError, "⑪c 认领成功", cl11c.text.slice(0, 160));
    write(path.join(fx11c.root, "src/n1.ts"), "export const N1 = true;\n");
    const sub11c0 = await callTool(
      submitTaskResultTool,
      { project_id: fx11c.id, task_id: "T-1", role: "executor", owner_id: executor, change_id: CHG, claim_token: cl11c.json?.claim?.claim_token, expected_revision: revOf(fx11c, "T-1"), evidence_refs: ["src/n1.ts"], deliverables: [], verification: [], untested: [], known_issues: [] },
      { work: client },
    );
    ok(!sub11c0.isError && sub11c0.json?.ok === true, "⑪c 前置：T-1 真的提交（入口才轮到复审）", sub11c0.text.slice(0, 180));
    const sameNotes11c = { untested: [{ item: "还没跑集成", reason: "同一原因" }], known_issues: ["同一已知问题"] };
    // 第一轮（10:00）
    submitSubmission(service, {
      project_id: fx11c.id, change_id: CHG, actor_id: executor, role: "executor",
      record_id: "sub-n-r1", task_id: "T-1", goal: "同因", submitted_by: executor,
      ...sameNotes11c, evidence_refs: [], occurred_at: "2026-10-07T10:00:00.000Z",
    } as never);
    // 两轮之间：只推进**另一个任务 T-2** 的缺陷（登记→确认→修复）
    const openedC = await callTool(
      recordWorkEvidenceTool,
      { op: "finding", sub_op: "open", project_id: fx11c.id, role: "auditor", change_id: CHG, severity: "user_visible_defect", source: "T-2 检测", expected: "通过", actual: "失败", object_id: "T-2", repro: "夹具复现", occurred_at: "2026-10-07T10:03:00.000Z" },
      { work: client, clientName: auditor },
    );
    const findingC = openedC.json?.finding_id as string;
    const confirmedC = await callTool(
      recordWorkEvidenceTool,
      { op: "finding", sub_op: "transition", project_id: fx11c.id, role: "auditor", change_id: CHG, finding_id: findingC, to: "confirmed", occurred_at: "2026-10-07T10:04:00.000Z" },
      { work: client, clientName: auditor },
    );
    const fixedC = await callTool(
      recordWorkEvidenceTool,
      { op: "fix", project_id: fx11c.id, role: "executor", change_id: CHG, record_id: "fix-n-1", finding_id: findingC, fix_revision: "rev-n", fixed_by: executor, evidence_ref: "src/n1.ts", occurred_at: "2026-10-07T10:05:00.000Z" },
      { work: client, clientName: executor },
    );
    ok(typeof findingC === "string" && findingC !== "" && !confirmedC.isError && !fixedC.isError, "⑪c 前置：两轮之间只落了 **T-2** 的修复（本任务一无进展）", { findingC, fix: fixedC.text.slice(0, 120) });
    // 第二轮（10:10，备注逐字相同）
    submitSubmission(service, {
      project_id: fx11c.id, change_id: CHG, actor_id: executor, role: "executor",
      record_id: "sub-n-r2", task_id: "T-1", goal: "同因", submitted_by: executor,
      ...sameNotes11c, evidence_refs: [], occurred_at: "2026-10-07T10:10:00.000Z",
    } as never);
    const entry11c = entryOf(fx11c, "coordinator", "coordination");
    const reasons11c = JSON.stringify(entry11c.reasons ?? []);
    ok(
      /两轮同因/.test(reasons11c),
      "⑪c **其他任务**的修复不算本任务进展 ⇒ 本任务照旧报「两轮同因」（归属过滤生效）",
      entry11c.reasons,
    );
    // 反例对照：同一条修复若挂在**本任务**的缺陷上，就应算进展（归属链正例）
    const openedD = await callTool(
      recordWorkEvidenceTool,
      { op: "finding", sub_op: "open", project_id: fx11c.id, role: "auditor", change_id: CHG, severity: "user_visible_defect", source: "T-1 检测", expected: "通过", actual: "失败", object_id: "T-1", repro: "夹具复现", occurred_at: "2026-10-07T10:11:00.000Z" },
      { work: client, clientName: auditor },
    );
    const findingD = openedD.json?.finding_id as string;
    await callTool(
      recordWorkEvidenceTool,
      { op: "finding", sub_op: "transition", project_id: fx11c.id, role: "auditor", change_id: CHG, finding_id: findingD, to: "confirmed", occurred_at: "2026-10-07T10:12:00.000Z" },
      { work: client, clientName: auditor },
    );
    // 第三轮：把本任务缺陷的修复排在 r2 与 r3 之间
    const fixedD = await callTool(
      recordWorkEvidenceTool,
      { op: "fix", project_id: fx11c.id, role: "executor", change_id: CHG, record_id: "fix-n-2", finding_id: findingD, fix_revision: "rev-n2", fixed_by: executor, evidence_ref: "src/n2.ts", occurred_at: "2026-10-07T10:14:00.000Z" },
      { work: client, clientName: executor },
    );
    ok(!fixedD.isError, "⑪c 对照前置：本任务缺陷的修复落账", fixedD.text.slice(0, 140));
    submitSubmission(service, {
      project_id: fx11c.id, change_id: CHG, actor_id: executor, role: "executor",
      record_id: "sub-n-r3", task_id: "T-1", goal: "同因", submitted_by: executor,
      ...sameNotes11c, evidence_refs: [], occurred_at: "2026-10-07T10:15:00.000Z",
    } as never);
    const entry11c2 = entryOf(fx11c, "coordinator", "coordination");
    const reasons11c2 = JSON.stringify(entry11c2.reasons ?? []);
    ok(
      !/两轮同因/.test(reasons11c2),
      "⑪c 对照：**本任务**缺陷的修复落在最近两轮之间 ⇒ 算真实进展，不再报「两轮同因」",
      entry11c2.reasons,
    );
  }

  // ⑪d（Codex 12:04）：判进展按**服务端账本 seq**，不按可自报的 `occurred_at`。
  // 反例构造：真实有效通过的自报 `occurred_at` **早于上一轮**且两轮自报**同一秒**——按 at 比会漏判进展；
  // 但该通过事件是在 r1 之后**追加**的（账本 seq 落在窗口内），按 seq 就是真实进展。
  section("⑪d 有效通过的自报 occurred_at 早于上一轮/与两轮同秒 ⇒ 仍按账本 seq 算进展（不误报停滞）");
  {
    const fx11d = makeFixture("lc-p", [{ id: "T-1", goal: "自报时间误导卡" }]);
    const cl11d = await callTool(
      claimTaskTool,
      { op: "claim", project_id: fx11d.id, task_id: "T-1", role: "executor", owner_id: executor, change_id: CHG, expected_revision: revOf(fx11d, "T-1") },
      { work: client },
    );
    ok(!cl11d.isError, "⑪d 认领成功", cl11d.text.slice(0, 160));
    write(path.join(fx11d.root, "src/p1.ts"), "export const P1 = true;\n");
    const m11d = await storeManifest(fx11d, client, { rel: "src/p1.ts", taskId: "T-1" });
    // 真提交（让入口进复审；之后两轮同因从既有回执识别）
    const sub11d0 = await callTool(
      submitTaskResultTool,
      { project_id: fx11d.id, task_id: "T-1", role: "executor", owner_id: executor, change_id: CHG, claim_token: cl11d.json?.claim?.claim_token, expected_revision: revOf(fx11d, "T-1"), evidence_refs: ["src/p1.ts"], deliverables: [], verification: [], untested: [], known_issues: [] },
      { work: client },
    );
    ok(!sub11d0.isError && sub11d0.json?.ok === true, "⑪d 前置：T-1 真提交（入口轮到复审）", sub11d0.text.slice(0, 180));
    const sameNotesD = { untested: [{ item: "还没跑集成", reason: "同一原因" }], known_issues: ["同一已知问题"] };
    // 第一轮（自报 10:00:00）
    submitSubmission(service, {
      project_id: fx11d.id, change_id: CHG, actor_id: executor, role: "executor",
      record_id: "sub-p-r1", task_id: "T-1", goal: "同因", submitted_by: executor,
      ...sameNotesD, evidence_refs: [], occurred_at: "2026-10-07T10:00:00.000Z",
    } as never);
    // 两轮之间：落一条**真实有效通过**，但自报 occurred_at = 09:00:00（**早于上一轮**，按 at 比会漏）
    const sc11d = await callTool(
      recordWorkEvidenceTool,
      {
        op: "self_check", project_id: fx11d.id, role: "executor", change_id: CHG, record_id: "sc-p-01",
        task_id: "T-1", occurred_at: "2026-10-07T09:00:00.000Z", conclusion: "pass",
        binding: { revision_kind: "code", revision: m11d.fingerprint },
        checks: [{ check_id: "chk-t-1-01", method: "跑了该检查对应的验证", evidence_sha256: m11d.blob, verifies: "code" }],
      },
      { work: client },
    );
    ok(!sc11d.isError && sc11d.json?.ok === true, "⑪d 两轮之间落了真实有效通过（自报时间早于上一轮）", sc11d.text.slice(0, 200));
    // 第二轮（自报与第一轮**同一秒** 10:00:00）
    submitSubmission(service, {
      project_id: fx11d.id, change_id: CHG, actor_id: executor, role: "executor",
      record_id: "sub-p-r2", task_id: "T-1", goal: "同因", submitted_by: executor,
      ...sameNotesD, evidence_refs: [], occurred_at: "2026-10-07T10:00:00.000Z",
    } as never);
    const check11d = checkOf(wpOf(fx11d, "coordinator", "coordination"), "chk-t-1-01");
    ok(check11d?.effective === "passed", "⑪d 前提成立：期间新增的有效通过确实生效（chk-t-1-01=passed）", check11d);
    const reasons11d = JSON.stringify(entryOf(fx11d, "coordinator", "coordination").reasons ?? []);
    ok(
      !/两轮同因/.test(reasons11d),
      "⑪d 按账本 seq 判进展（自报 at 早于上一轮/同秒都**不**误报停滞）",
      entryOf(fx11d, "coordinator", "coordination").reasons,
    );
  }

  // ⑪e（Codex 12:04）：**重复同 check 通过**（有效缺口未变）不得假推进 ⇒ 仍报「两轮同因」。
  // 反例构造：chk-t-1-01 在 r1 **之前**已通过一次，r1/r2 之间又通过一次（重复记录）。
  section("⑪e 重复同 check 通过（有效缺口未变）⇒ 仍报「两轮同因」（不假推进）");
  {
    const fx11e = makeFixture("lc-q", [{ id: "T-1", goal: "重复通过卡" }]);
    const cl11e = await callTool(
      claimTaskTool,
      { op: "claim", project_id: fx11e.id, task_id: "T-1", role: "executor", owner_id: executor, change_id: CHG, expected_revision: revOf(fx11e, "T-1") },
      { work: client },
    );
    ok(!cl11e.isError, "⑪e 认领成功", cl11e.text.slice(0, 160));
    write(path.join(fx11e.root, "src/q1.ts"), "export const Q1 = true;\n");
    const m11e = await storeManifest(fx11e, client, { rel: "src/q1.ts", taskId: "T-1" });
    const sameNotesE = { untested: [{ item: "还没跑集成", reason: "同一原因" }], known_issues: ["同一已知问题"] };
    const passFor = (recordId: string, at: string) =>
      callTool(
        recordWorkEvidenceTool,
        {
          op: "self_check", project_id: fx11e.id, role: "executor", change_id: CHG, record_id: recordId,
          task_id: "T-1", occurred_at: at, conclusion: "pass",
          binding: { revision_kind: "code", revision: m11e.fingerprint },
          checks: [{ check_id: "chk-t-1-01", method: "跑了该检查对应的验证", evidence_sha256: m11e.blob, verifies: "code" }],
        },
        { work: client },
      );
    // P1：r1 **之前**先通过一次
    const p1 = await passFor("sc-q-1", "2026-10-07T10:01:00.000Z");
    ok(!p1.isError && p1.json?.ok === true, "⑪e 前置：chk-t-1-01 在首轮之前已通过一次", p1.text.slice(0, 160));
    // 真提交（让入口进复审）
    const sub11e0 = await callTool(
      submitTaskResultTool,
      { project_id: fx11e.id, task_id: "T-1", role: "executor", owner_id: executor, change_id: CHG, claim_token: cl11e.json?.claim?.claim_token, expected_revision: revOf(fx11e, "T-1"), evidence_refs: ["src/q1.ts"], deliverables: [], verification: [], untested: [], known_issues: [] },
      { work: client },
    );
    ok(!sub11e0.isError && sub11e0.json?.ok === true, "⑪e 前置：T-1 真提交（入口轮到复审）", sub11e0.text.slice(0, 180));
    submitSubmission(service, {
      project_id: fx11e.id, change_id: CHG, actor_id: executor, role: "executor",
      record_id: "sub-q-r1", task_id: "T-1", goal: "同因", submitted_by: executor,
      ...sameNotesE, evidence_refs: [], occurred_at: "2026-10-07T10:02:00.000Z",
    } as never);
    // P2：r1/r2 之间**重复**通过同一条检查
    const p2 = await passFor("sc-q-2", "2026-10-07T10:05:00.000Z");
    ok(!p2.isError && p2.json?.ok === true, "⑪e 两轮之间重复通过同一 check", p2.text.slice(0, 160));
    submitSubmission(service, {
      project_id: fx11e.id, change_id: CHG, actor_id: executor, role: "executor",
      record_id: "sub-q-r2", task_id: "T-1", goal: "同因", submitted_by: executor,
      ...sameNotesE, evidence_refs: [], occurred_at: "2026-10-07T10:10:00.000Z",
    } as never);
    const check11e = checkOf(wpOf(fx11e, "coordinator", "coordination"), "chk-t-1-01");
    ok(check11e?.effective === "passed", "⑪e 前提成立：chk-t-1-01 仍为有效通过（重复记录不改缺口）", check11e);
    const reasons11e = JSON.stringify(entryOf(fx11e, "coordinator", "coordination").reasons ?? []);
    ok(
      /两轮同因/.test(reasons11e),
      "⑪e 重复同 check 通过**不**算有效缺口减少 ⇒ 照旧报「两轮同因」",
      entryOf(fx11e, "coordinator", "coordination").reasons,
    );
  }

  // ⑪f（Codex 12:04）：本任务缺陷的**失败**复测不得假推进 ⇒ 仍报「两轮同因」。
  section("⑪f 本任务缺陷的失败复测（未解除）⇒ 仍报「两轮同因」（不假推进）");
  {
    const fx11f = makeFixture("lc-r", [{ id: "T-1", goal: "失败复测卡" }]);
    const cl11f = await callTool(
      claimTaskTool,
      { op: "claim", project_id: fx11f.id, task_id: "T-1", role: "executor", owner_id: executor, change_id: CHG, expected_revision: revOf(fx11f, "T-1") },
      { work: client },
    );
    ok(!cl11f.isError, "⑪f 认领成功", cl11f.text.slice(0, 160));
    const openedF = await callTool(
      recordWorkEvidenceTool,
      { op: "finding", sub_op: "open", project_id: fx11f.id, role: "auditor", change_id: CHG, severity: "user_visible_defect", source: "T-1 检测", expected: "通过", actual: "失败", object_id: "T-1", repro: "夹具复现", occurred_at: "2026-10-07T09:59:00.000Z" },
      { work: client, clientName: auditor },
    );
    const findingF = openedF.json?.finding_id as string;
    ok(typeof findingF === "string" && findingF !== "", "⑪f 前置：本任务在册缺陷已登记", openedF.text.slice(0, 160));
    write(path.join(fx11f.root, "evidence/r.txt"), "ok\n");
    // 真提交（让入口进复审）
    const sub11f0 = await callTool(
      submitTaskResultTool,
      { project_id: fx11f.id, task_id: "T-1", role: "executor", owner_id: executor, change_id: CHG, claim_token: cl11f.json?.claim?.claim_token, expected_revision: revOf(fx11f, "T-1"), evidence_refs: ["evidence/r.txt"], deliverables: [], verification: [], untested: [], known_issues: [] },
      { work: client },
    );
    ok(!sub11f0.isError && sub11f0.json?.ok === true, "⑪f 前置：T-1 真提交（入口轮到复审）", sub11f0.text.slice(0, 180));
    const sameNotesF = { untested: [{ item: "还没跑集成", reason: "同一原因" }], known_issues: ["同一已知问题"] };
    submitSubmission(service, {
      project_id: fx11f.id, change_id: CHG, actor_id: executor, role: "executor",
      record_id: "sub-r-r1", task_id: "T-1", goal: "同因", submitted_by: executor,
      ...sameNotesF, evidence_refs: [], occurred_at: "2026-10-07T10:00:00.000Z",
    } as never);
    // 两轮之间：对本任务缺陷记一条**失败**复测（无修复、未解除；result=fail 不算推进）
    const retF = await callTool(
      recordWorkEvidenceTool,
      { op: "retest", project_id: fx11f.id, role: "auditor", change_id: CHG, record_id: "ret-r-1", finding_id: findingF, retested_by: auditor, retest_evidence: "复现仍在", result: "fail", occurred_at: "2026-10-07T10:05:00.000Z" },
      { work: client, clientName: auditor },
    );
    ok(!retF.isError, "⑪f 两轮之间落了本任务缺陷的**失败**复测", retF.text.slice(0, 160));
    submitSubmission(service, {
      project_id: fx11f.id, change_id: CHG, actor_id: executor, role: "executor",
      record_id: "sub-r-r2", task_id: "T-1", goal: "同因", submitted_by: executor,
      ...sameNotesF, evidence_refs: [], occurred_at: "2026-10-07T10:10:00.000Z",
    } as never);
    const reasons11f = JSON.stringify(entryOf(fx11f, "coordinator", "coordination").reasons ?? []);
    ok(
      /两轮同因/.test(reasons11f),
      "⑪f 失败复测**不**解除停滞 ⇒ 照旧报「两轮同因」",
      entryOf(fx11f, "coordinator", "coordination").reasons,
    );
  }

  // ⑪g 正例（Codex 12:20）：**曾通过 → 相关源改（旧通过失效）→ 本轮复验新通过** ⇒ 算进展。
  // 反例构造：chk-t-1-01 在 r1 **之前**通过（绑源清单 M1）→ 改 s1.ts（M1 清单失效、旧通过转 stale）
  // → 上轮 r1 仍缺该检查 → 本轮重新存清单 M2 并**新复验**通过；另一检查 chk-t-1-02 仍缺、两轮备注逐字相同。
  // 旧实现把「历史上通过过」一律算作已通过（passedBefore 不看有效性）⇒ 误报「两轮同因无进展」。
  section("⑪g 旧通过因源变失效、本轮复验新通过（另一检查仍缺、备注相同）⇒ 算进展，不误报「两轮同因」");
  {
    const fx11g = makeFixture("lc-s", [{ id: "T-1", goal: "源变后复验恢复卡" }]);
    const cl11g = await callTool(
      claimTaskTool,
      { op: "claim", project_id: fx11g.id, task_id: "T-1", role: "executor", owner_id: executor, change_id: CHG, expected_revision: revOf(fx11g, "T-1") },
      { work: client },
    );
    ok(!cl11g.isError, "⑪g 认领成功", cl11g.text.slice(0, 160));
    // 相关源初始版本 + 源清单 M1
    write(path.join(fx11g.root, "src/s1.ts"), "export const S1 = 1;\n");
    const m1 = await storeManifest(fx11g, client, { rel: "src/s1.ts", taskId: "T-1" });
    // P0：r1 **之前**先有效通过 chk-t-1-01（绑 M1 源清单）
    const p0 = await callTool(
      recordWorkEvidenceTool,
      {
        op: "self_check", project_id: fx11g.id, role: "executor", change_id: CHG, record_id: "sc-s-0",
        task_id: "T-1", occurred_at: "2026-10-07T09:50:00.000Z", conclusion: "pass",
        binding: { revision_kind: "code", revision: m1.fingerprint },
        checks: [{ check_id: "chk-t-1-01", method: "跑了该检查对应的验证", evidence_sha256: m1.blob, verifies: "code" }],
      },
      { work: client },
    );
    ok(!p0.isError && p0.json?.ok === true, "⑪g 前置：chk-t-1-01 在首轮之前已有效通过（绑 M1）", p0.text.slice(0, 180));
    // 真提交（让入口进复审）
    const sub11g0 = await callTool(
      submitTaskResultTool,
      { project_id: fx11g.id, task_id: "T-1", role: "executor", owner_id: executor, change_id: CHG, claim_token: cl11g.json?.claim?.claim_token, expected_revision: revOf(fx11g, "T-1"), evidence_refs: ["src/s1.ts"], deliverables: [], verification: [], untested: [], known_issues: [] },
      { work: client },
    );
    ok(!sub11g0.isError && sub11g0.json?.ok === true, "⑪g 前置：T-1 真提交（入口轮到复审）", sub11g0.text.slice(0, 180));
    // 相关源改：s1.ts 内容变 ⇒ 旧通过的 M1 清单现读判失效（stale）
    write(path.join(fx11g.root, "src/s1.ts"), "export const S1 = 2;\n");
    const sameNotesG = { untested: [{ item: "还没跑集成", reason: "同一原因" }], known_issues: ["同一已知问题"] };
    submitSubmission(service, {
      project_id: fx11g.id, change_id: CHG, actor_id: executor, role: "executor",
      record_id: "sub-s-r1", task_id: "T-1", goal: "同因", submitted_by: executor,
      ...sameNotesG, evidence_refs: [], occurred_at: "2026-10-07T10:00:00.000Z",
    } as never);
    // 本轮复验：重新存清单 M2（覆盖改后的源）并**新复验**通过 chk-t-1-01（另一检查 chk-t-1-02 仍缺）
    const m2 = await storeManifest(fx11g, client, { rel: "src/s1.ts", taskId: "T-1" });
    const p2 = await callTool(
      recordWorkEvidenceTool,
      {
        op: "self_check", project_id: fx11g.id, role: "executor", change_id: CHG, record_id: "sc-s-1",
        task_id: "T-1", occurred_at: "2026-10-07T10:05:00.000Z", conclusion: "pass",
        binding: { revision_kind: "code", revision: m2.fingerprint },
        checks: [{ check_id: "chk-t-1-01", method: "源改后重新跑该检查的验证", evidence_sha256: m2.blob, verifies: "code" }],
      },
      { work: client },
    );
    ok(!p2.isError && p2.json?.ok === true, "⑪g 本轮复验：chk-t-1-01 重新有效通过（绑改后的 M2）", p2.text.slice(0, 180));
    // 第二轮（备注逐字相同）
    submitSubmission(service, {
      project_id: fx11g.id, change_id: CHG, actor_id: executor, role: "executor",
      record_id: "sub-s-r2", task_id: "T-1", goal: "同因", submitted_by: executor,
      ...sameNotesG, evidence_refs: [], occurred_at: "2026-10-07T10:10:00.000Z",
    } as never);
    const check11g = checkOf(wpOf(fx11g, "coordinator", "coordination"), "chk-t-1-01");
    ok(check11g?.effective === "passed", "⑪g 前提成立：本轮复验后 chk-t-1-01 为有效通过", check11g);
    ok(
      checkOf(wpOf(fx11g, "coordinator", "coordination"), "chk-t-1-02")?.effective === "missing",
      "⑪g 前提成立：另一检查 chk-t-1-02 仍缺（两轮备注相同）",
    );
    const reasons11g = JSON.stringify(entryOf(fx11g, "coordinator", "coordination").reasons ?? []);
    ok(
      !/两轮同因/.test(reasons11g),
      "⑪g 旧通过因源变失效、本轮复验新通过 ⇒ 算真实进展，**不**误报「两轮同因无进展」",
      entryOf(fx11g, "coordinator", "coordination").reasons,
    );
  }

  // ⑪h 正例（B3-REVIEW-WATCH 12:40）：**同 stableID 定义语义变、code 绑定不变** ⇒ 旧通过不得占位。
  // 构造：chk-t-1-01 在 r1 之前有效通过（绑 M1 源清单；其后 `src/s1.ts` **一字未改**，故 code 指纹与清单现读都仍 valid）
  // → 只改该检查**定义正文**（同 stableID `chk-t-1-01`，语义变）并重导入/重激活基线（唯一义务层的记录级定义绑定
  // 会把那条旧通过判 `changed`，真实入口据此判它不再通过）→ 上轮 r1 仍缺该检查 → 本轮在**新定义**下新复验通过；
  // 另一检查 chk-t-1-02 仍缺、两轮备注逐字相同。
  // 旧实现只经 `checksFromFacts` ＋ `checkEffectiveness`（看 code 绑定/源清单，**不看定义语义**）⇒ 旧通过仍算
  // 「此前已有效通过」⇒ 本轮新复验被当成「重复记同 check 通过」⇒ 误报「两轮同因无进展」。
  section("⑪h 同 stableID 定义语义变（code 未变）⇒ 旧通过不占位；本轮新复验算进展，不误报「两轮同因」");
  {
    const fx11h = makeFixture("lc-defbind", [{ id: "T-1", goal: "定义语义变后复验卡" }]);
    const cl11h = await callTool(
      claimTaskTool,
      { op: "claim", project_id: fx11h.id, task_id: "T-1", role: "executor", owner_id: executor, change_id: CHG, expected_revision: revOf(fx11h, "T-1") },
      { work: client },
    );
    ok(!cl11h.isError, "⑪h 认领成功", cl11h.text.slice(0, 160));
    write(path.join(fx11h.root, "src/s1.ts"), "export const S1 = 1;\n");
    const m1 = await storeManifest(fx11h, client, { rel: "src/s1.ts", taskId: "T-1" });
    const p0 = await callTool(
      recordWorkEvidenceTool,
      {
        op: "self_check", project_id: fx11h.id, role: "executor", change_id: CHG, record_id: "sc-db-0",
        task_id: "T-1", occurred_at: "2026-10-07T09:50:00.000Z", conclusion: "pass",
        binding: { revision_kind: "code", revision: m1.fingerprint },
        checks: [{ check_id: "chk-t-1-01", method: "跑了该检查对应的验证", evidence_sha256: m1.blob, verifies: "code" }],
      },
      { work: client },
    );
    ok(!p0.isError && p0.json?.ok === true, "⑪h 前置：chk-t-1-01 在首轮之前已有效通过（绑 M1；s1.ts 此后一字未改）", p0.text.slice(0, 180));
    const sub11h0 = await callTool(
      submitTaskResultTool,
      { project_id: fx11h.id, task_id: "T-1", role: "executor", owner_id: executor, change_id: CHG, claim_token: cl11h.json?.claim?.claim_token, expected_revision: revOf(fx11h, "T-1"), evidence_refs: ["src/s1.ts"], deliverables: [], verification: [], untested: [], known_issues: [] },
      { work: client },
    );
    ok(!sub11h0.isError && sub11h0.json?.ok === true, "⑪h 前置：T-1 真提交（入口轮到复审）", sub11h0.text.slice(0, 180));
    // 同 stableID 改**定义正文**（语义变）：源码一字未改 ⇒ code 指纹与源清单现读都不变，只有定义语义变了。
    const next11h = fx11h.plan.replace("**chk-t-1-01** 目标达标", "**chk-t-1-01** 目标达标（语义已改）");
    write(fx11h.planFile, next11h);
    submitDefinitionImports(service, {
      project_id: fx11h.id, change_id: CHG, actor_id: executor, role: "coordinator",
      expected_revisions: { "T-1": revOf(fx11h, "T-1") },
      definitions: importTaskDefinitions(next11h, { plan_revision: sha256(next11h), revisions: { "T-1": 2 } }).definitions.filter((d) => d.task_id === "T-1"),
    });
    activateBaseline(fx11h.id, { approved_by: "user", approval_basis: "定义语义变后重新审定", approval_kind: "user_confirmed" }, dataDir);
    ok(
      checkOf(wpOf(fx11h, "coordinator", "coordination"), "chk-t-1-01")?.effective !== "passed",
      "⑪h 前提成立：同 stableID 改定义语义后旧通过失效（真实入口判 chk-t-1-01 不再通过；code 未变也拦得住）",
      checkOf(wpOf(fx11h, "coordinator", "coordination"), "chk-t-1-01"),
    );
    const sameNotesH = { untested: [{ item: "还没跑集成", reason: "同一原因" }], known_issues: ["同一已知问题"] };
    submitSubmission(service, {
      project_id: fx11h.id, change_id: CHG, actor_id: executor, role: "executor",
      record_id: "sub-db-r1", task_id: "T-1", goal: "同因", submitted_by: executor,
      ...sameNotesH, evidence_refs: [], occurred_at: "2026-10-07T10:00:00.000Z",
    } as never);
    // 本轮：在新定义下**新复验**通过（源码未改，复用同一份 M1 清单/证据；这是**新记录**，不是重复旧记录）
    const p2 = await callTool(
      recordWorkEvidenceTool,
      {
        op: "self_check", project_id: fx11h.id, role: "executor", change_id: CHG, record_id: "sc-db-1",
        task_id: "T-1", occurred_at: "2026-10-07T10:05:00.000Z", conclusion: "pass",
        binding: { revision_kind: "code", revision: m1.fingerprint },
        checks: [{ check_id: "chk-t-1-01", method: "定义改语义后重新跑该检查的验证", evidence_sha256: m1.blob, verifies: "code" }],
      },
      { work: client },
    );
    ok(!p2.isError && p2.json?.ok === true, "⑪h 本轮复验：chk-t-1-01 在新定义下重新有效通过", p2.text.slice(0, 180));
    submitSubmission(service, {
      project_id: fx11h.id, change_id: CHG, actor_id: executor, role: "executor",
      record_id: "sub-db-r2", task_id: "T-1", goal: "同因", submitted_by: executor,
      ...sameNotesH, evidence_refs: [], occurred_at: "2026-10-07T10:10:00.000Z",
    } as never);
    const check11h = checkOf(wpOf(fx11h, "coordinator", "coordination"), "chk-t-1-01");
    ok(check11h?.effective === "passed", "⑪h 前提成立：本轮复验后 chk-t-1-01 为有效通过", check11h);
    ok(
      checkOf(wpOf(fx11h, "coordinator", "coordination"), "chk-t-1-02")?.effective === "missing",
      "⑪h 前提成立：另一检查 chk-t-1-02 仍缺（两轮备注相同）",
    );
    const reasons11h = JSON.stringify(entryOf(fx11h, "coordinator", "coordination").reasons ?? []);
    ok(
      !/两轮同因/.test(reasons11h),
      "⑪h 同 stableID 语义变（code 未变）：定义已变的旧通过**不占位**、本轮新复验算进展 ⇒ **不**误报「两轮同因无进展」",
      entryOf(fx11h, "coordinator", "coordination").reasons,
    );
  }

  // ⑪i 正例（B3-REVIEW-WATCH 12:51）：**窗口前的旧通过拿不到定义绑定判词（unknown）** ⇒ 不据此断言停滞。
  // 构造与 ⑪e 同形（窗口前已通过一次 → 两轮之间重复通过同一 check → 两轮备注逐字相同），但把**记录时点的
  // 不可变施工图快照**删掉（真实条件「不可变定义快照读不到」）：唯一义务层对那条旧通过给 `verdict=unknown`，
  // 而 `checkEffectiveness` 只看代码绑定，旧通过**仍判 `passed`**。
  // 旧实现让这条"证明不了当时定义语义"的旧通过**占位** ⇒ 把本轮重复通过挤成"无进展" ⇒ 误报「两轮同因」；
  // 本处应判"历史状态不可证明" ⇒ **不**把不确定说成停滞（`historyUnprovable`）。
  // 对照：⑪e 同样的形状（定义绑定 `match`）**仍报**「两轮同因」——正常可证明的重复通过照旧诊断。
  section("⑪i 窗口前旧通过的定义绑定 unknown（不可变快照读不到）⇒ 不据此断言「两轮同因」");
  {
    const fx11i = makeFixture("lc-unk", [{ id: "T-1", goal: "定义绑定不可证明卡" }]);
    const cl11i = await callTool(
      claimTaskTool,
      { op: "claim", project_id: fx11i.id, task_id: "T-1", role: "executor", owner_id: executor, change_id: CHG, expected_revision: revOf(fx11i, "T-1") },
      { work: client },
    );
    ok(!cl11i.isError, "⑪i 认领成功", cl11i.text.slice(0, 160));
    write(path.join(fx11i.root, "src/u1.ts"), "export const U1 = true;\n");
    const m11i = await storeManifest(fx11i, client, { rel: "src/u1.ts", taskId: "T-1" });
    const sameNotesI = { untested: [{ item: "还没跑集成", reason: "同一原因" }], known_issues: ["同一已知问题"] };
    const passI = (recordId: string, at: string) =>
      callTool(
        recordWorkEvidenceTool,
        {
          op: "self_check", project_id: fx11i.id, role: "executor", change_id: CHG, record_id: recordId,
          task_id: "T-1", occurred_at: at, conclusion: "pass",
          binding: { revision_kind: "code", revision: m11i.fingerprint },
          checks: [{ check_id: "chk-t-1-01", method: "跑了该检查对应的验证", evidence_sha256: m11i.blob, verifies: "code" }],
        },
        { work: client },
      );
    // P1：r1 **之前**先通过一次（此后其定义绑定因快照读不到而不可证明）
    const p11i = await passI("sc-unk-0", "2026-10-07T10:01:00.000Z");
    ok(!p11i.isError && p11i.json?.ok === true, "⑪i 前置：chk-t-1-01 在首轮之前已通过一次", p11i.text.slice(0, 160));
    const sub11i0 = await callTool(
      submitTaskResultTool,
      { project_id: fx11i.id, task_id: "T-1", role: "executor", owner_id: executor, change_id: CHG, claim_token: cl11i.json?.claim?.claim_token, expected_revision: revOf(fx11i, "T-1"), evidence_refs: ["src/u1.ts"], deliverables: [], verification: [], untested: [], known_issues: [] },
      { work: client },
    );
    ok(!sub11i0.isError && sub11i0.json?.ok === true, "⑪i 前置：T-1 真提交（入口轮到复审）", sub11i0.text.slice(0, 180));
    submitSubmission(service, {
      project_id: fx11i.id, change_id: CHG, actor_id: executor, role: "executor",
      record_id: "sub-unk-r1", task_id: "T-1", goal: "同因", submitted_by: executor,
      ...sameNotesI, evidence_refs: [], occurred_at: "2026-10-07T10:02:00.000Z",
    } as never);
    // 两轮之间：**重复**通过同一条检查（与 ⑪e 同形；若旧通过可证明则这不算进展）
    const p2i = await passI("sc-unk-1", "2026-10-07T10:05:00.000Z");
    ok(!p2i.isError && p2i.json?.ok === true, "⑪i 两轮之间重复通过同一 check", p2i.text.slice(0, 160));
    // 真实条件「不可变定义快照读不到」：删掉该修订在盘上的不可变施工图快照（其余现场一字不动）
    const snapDir11i = path.join(fx11i.root, ".工作台", "plan-revisions");
    const removed11i = fs.existsSync(snapDir11i) ? fs.readdirSync(snapDir11i) : [];
    for (const f of removed11i) fs.rmSync(path.join(snapDir11i, f), { force: true });
    ok(removed11i.length > 0, "⑪i 前置：确有不可变施工图快照被移除（记录时点定义再也取不回）", removed11i);
    submitSubmission(service, {
      project_id: fx11i.id, change_id: CHG, actor_id: executor, role: "executor",
      record_id: "sub-unk-r2", task_id: "T-1", goal: "同因", submitted_by: executor,
      ...sameNotesI, evidence_refs: [], occurred_at: "2026-10-07T10:10:00.000Z",
    } as never);
    // 前提①：旧通过**仍判有效通过**（`checkEffectiveness` 只看代码绑定）——这正是"会占位"的危险条件。
    const check11i = checkOf(wpOf(fx11i, "coordinator", "coordination"), "chk-t-1-01");
    ok(check11i?.effective === "passed", "⑪i 前提成立：删快照后 chk-t-1-01 仍判有效通过（占位条件真实存在）", check11i);
    // 前提②：唯一义务层对**窗口前那条旧通过**给的是 unknown（不是 match/changed）⇒ 当时定义不可证明。
    const snap11i = eventsSnapshotOf(fx11i.id, dataDir);
    const facts11i = collectProjectFacts(fx11i.id, dataDir, { events: snap11i });
    const binds11i = deriveObligations({ project_id: fx11i.id, data_dir: dataDir, facts: facts11i, events: snap11i.events })
      .check_identity.definition_bindings.filter((b) => b.check_id === "chk-t-1-01");
    ok(
      binds11i.length >= 2 && binds11i.every((b) => b.verdict === "unknown"),
      "⑪i 前提成立：窗口前旧通过的定义绑定判词是 unknown（快照读不到 ⇒ 定义语义不可证明）",
      binds11i.map((b) => ({ ref: b.record_ref, seq: b.record_seq, verdict: b.verdict })),
    );
    const entry11i = entryOf(fx11i, "coordinator", "coordination");
    const reasons11i = JSON.stringify(entry11i.reasons ?? []);
    // 非空跑：入口确实把该卡当"已提交待复审"评估过（`repeatDiagnosisOf` 真的被调用）。
    ok(
      entry11i.next_action === "review_result" && /review_pending/.test(reasons11i),
      "⑪i 前提成立：入口确实按「已提交待复审」评估该卡（诊断路径真的被走到，不是空跑）",
      entry11i.next_action,
    );
    ok(
      !/两轮同因/.test(reasons11i),
      "⑪i 定义绑定 unknown／证明不了旧通过**不占位**、也不据不确定断言停滞（**不**报「两轮同因无进展」）",
      entry11i.reasons,
    );
  }

  // ═══════════════════ ⑫ 不造字段：工作包参数面 vs 真实注册表 ═══════════════════
  section("⑫ 工作包的 known_args 参数面与真实工具 schema 一致（不造字段）");
  for (const [tool, keys] of Object.entries(TOOL_PARAM_KEYS)) {
    const t = findTool(tool);
    const schema = (t?.inputSchema ?? {}) as { properties?: Record<string, unknown>; required?: string[] };
    const props = new Set(Object.keys(schema.properties ?? {}));
    const missing = keys.filter((k) => !props.has(k));
    const reqMissing = (schema.required ?? []).filter((k) => !keys.includes(k));
    ok(missing.length === 0 && reqMissing.length === 0, `⑫ ${tool}：参数表与真实 schema 一致（自造=${missing.join("/") || "无"}；漏 required=${reqMissing.join("/") || "无"}）`, { props: [...props] });
  }
  {
    const t = findTool("record_work_evidence");
    const schema = (t?.inputSchema ?? {}) as { properties?: Record<string, unknown> };
    const props = new Set(Object.keys(schema.properties ?? {}));
    let bad = 0;
    for (const keys of Object.values(RECORD_OP_KEYS)) for (const k of keys) if (!props.has(k)) bad++;
    ok(bad === 0, "⑫ record_work_evidence 各 op 闭键都在真实 schema 属性面内", { bad });
  }

  // ═══════════════ ⑬ 定义绑定核验在**真实入口/宿主路径**实际执行（B3-REVIEW-WATCH 12:05） ═══════════════
  // 断言的**不是** pure `deriveObligations`（verify-feature-ledger ⑮ 已覆盖那层），而是：入口把**同一份快照的
  // 原始事件**传给唯一义务层后，真实 `project_entry` / 宿主 HTTP 读口会实际执行「record → 账本 seq → 当时不可变
  // 定义」的语义核验。若入口漏传 events（原状），这里会判「仍通过」——本段就是那道实现边界的回归钉。
  section("⑬ 真实入口/宿主执行「record→seq→当时定义」核验：同 stableID 改语义失效、无关卡不连坐");
  {
    /** 存源清单载体 + 记一条 code 绑定的作者自检（与 ⑪b 同机制：清单现读 ⇒ 通过，不依赖自报 code 版本） */
    const recordPass = async (fx: Fixture): Promise<void> => {
      write(path.join(fx.root, "src/t1.ts"), "export const T1 = true;\n");
      const m = await storeManifest(fx, client, { rel: "src/t1.ts", taskId: "T-1" });
      const sc = await callTool(
        recordWorkEvidenceTool,
        {
          op: "self_check", project_id: fx.id, role: "executor", change_id: CHG, record_id: "sc-eb-01",
          task_id: "T-1", conclusion: "pass",
          binding: { revision_kind: "code", revision: m.fingerprint },
          checks: [{ check_id: "chk-t-1-01", method: "跑了该检查对应的验证", evidence_sha256: m.blob, verifies: "code" }],
        },
        { work: client },
      );
      ok(!sc.isError && sc.json?.ok === true, "⑬ 前置：chk-t-1-01 真实有效通过已落账", sc.text.slice(0, 200));
    };
    /** 改一张卡某条检查的**正文字**（同 stableID）并重新导入 + 重新激活基线 */
    const rewriteCheck = (fx: Fixture, taskId: string, from: string, to: string): void => {
      const next = fx.plan.replace(from, to);
      write(fx.planFile, next);
      submitDefinitionImports(service, {
        project_id: fx.id, change_id: CHG, actor_id: executor, role: "coordinator",
        expected_revisions: { [taskId]: 1 },
        definitions: importTaskDefinitions(next, { plan_revision: sha256(next), revisions: { [taskId]: 2 } }).definitions.filter((d) => d.task_id === taskId),
      });
      activateBaseline(fx.id, { approved_by: "user", approval_basis: "重导入后重新审定", approval_kind: "user_confirmed" }, dataDir);
    };
    const wpCheck = (fx: Fixture, id: string): any =>
      (wpOf(fx, "executor")?.checks ?? []).find((c: any) => c.check_id === id) ?? null;

    // 控制组：定义一字不改 ⇒ 通过保持（证明"失效"不是因为改文档本身把一切都打翻）
    const ctrl = makeFixture("lc-eb-ctrl", [{ id: "T-1", goal: "定义绑定控制组" }]);
    await recordPass(ctrl);
    ok(wpCheck(ctrl, "chk-t-1-01")?.effective === "passed", "⑬ 控制组：定义未改 ⇒ 真实 project_entry 判 chk-t-1-01 通过", wpCheck(ctrl, "chk-t-1-01"));

    // 自身定义改语义 ⇒ 旧通过失效（**真实 project_entry**）
    const self = makeFixture("lc-eb-self", [{ id: "T-1", goal: "定义绑定自身改" }]);
    await recordPass(self);
    rewriteCheck(self, "T-1", "**chk-t-1-01** 目标达标", "**chk-t-1-01** 目标达标（语义已改）");
    const selfCheck = wpCheck(self, "chk-t-1-01");
    ok(
      selfCheck !== null && selfCheck.effective !== "passed",
      "⑬ 同 stableID 改语义 ⇒ 真实 project_entry 判 chk-t-1-01 **不再通过**（旧通过失效；入口真在跑定义绑定核验）",
      selfCheck,
    );
    // 宿主 HTTP 读口同一判据（同一条生产路由）
    const selfHost: any = await httpEntryRaw(self.id, "executor", { client_capabilities: "continuable", work_package: "true" });
    const hostCheck = (selfHost?.entry?.work_package?.checks ?? []).find((c: any) => c.check_id === "chk-t-1-01") ?? null;
    ok(
      hostCheck !== null && hostCheck.effective === selfCheck?.effective,
      "⑬ 宿主 HTTP 读口与 project_entry **同一 effective**（D1 全链同一判据、不是两条读路径两套结论）",
      { entry: selfCheck?.effective, host: hostCheck?.effective },
    );

    // 只有**别的卡**定义变 ⇒ 本卡不连坐（仍通过）
    const other = makeFixture("lc-eb-other", [{ id: "T-1", goal: "定义绑定本卡" }, { id: "T-2", goal: "别的卡" }]);
    await recordPass(other);
    rewriteCheck(other, "T-2", "**chk-t-2-01** 目标达标", "**chk-t-2-01** 目标达标（语义已改）");
    ok(
      wpCheck(other, "chk-t-1-01")?.effective === "passed",
      "⑬ 只有**别的卡**定义变 ⇒ 本卡 chk-t-1-01 仍通过（别的卡定义变不连坐）",
      wpCheck(other, "chk-t-1-01"),
    );
  }

  section("⑭ 未检查的人验不能派给 Agent 或继承旧通过");
  {
    const fx=makeFixture("lc-human",[{id:"T-1",goal:"human check pending"}]);
    const claim=await callTool(claimTaskTool,{op:"claim",project_id:fx.id,task_id:"T-1",role:"executor",owner_id:executor,change_id:CHG,expected_revision:revOf(fx,"T-1")},{work:client});
    write(path.join(fx.root,"src/human.ts"),"export const human = true;\n");
    const manifest=await storeManifest(fx,client,{rel:"src/human.ts",taskId:"T-1"});
    await selfCheckPass(fx,client,{recordId:"human-self",taskId:"T-1",checks:["chk-t-1-01","T-1::evidence"].map(checkId=>({checkId,blob:manifest.blob,fingerprint:manifest.fingerprint}))});
    const submitted=await callTool(submitTaskResultTool,{project_id:fx.id,task_id:"T-1",role:"executor",owner_id:executor,change_id:CHG,claim_token:claim.json?.claim?.claim_token,expected_revision:revOf(fx,"T-1"),evidence_refs:["src/human.ts"],deliverables:[],verification:[],untested:["human"],known_issues:[]},{work:client});
    ok(!submitted.isError,"⑭ 前置结果已真实提交",submitted.text);
    const result = await callTool(recordWorkEvidenceTool, {
      op:"independent_audit",project_id:fx.id,role:"auditor",change_id:CHG,record_id:"human-pending",
      task_id:"T-1",auditor,author_id:executor,conclusion:"pass",
      coverage:["behavior_boundaries","data_concurrency","interface_integration","failure_recovery","trust_permission"].map(area=>({area,basis:"technical scope reviewed; human experiment not performed"})),
      checks:[{check_id:"chk-t-1-02",result:"not_checked",pending:{role:"human_tester",reason:"human experiment not performed",basis:"DESIGN 5.8"}}],
      binding:{revision_kind:"plan",revision:sha256(fx.plan)}
    },{work:client,clientName:auditor});
    ok(!result.isError,"⑭ 明确未检查记录经真实写口落账",result.text);
    const wp=wpOf(fx,"coordinator");
    const human=checkOf(wp,"chk-t-1-02");
    ok(human?.effective==="not_checked" && human.next_operation?.operation==="await_human" && human.responsible_role==="human_tester","⑭ 逐项待人验，无 Agent 写操作",human);
    ok(!wp.completion.satisfied && wp.completion.remaining_checks.includes("chk-t-1-02"),"⑭ 必需计数保留且不继承旧通过",wp.completion);
    const entry=await callTool(projectEntryTool,{project_id:fx.id,role:"auditor",client_capabilities:"continuable",work_package:true},{work:client,clientName:auditor});
    ok(entry.json?.next_action==="await_role","⑭ 仅剩人验明确等待真实人，不重复派 Agent 独审",entry.json?.next_action);
    ok(wp.continuation.role==="human_tester","⑭ 整包续接责任也是测试人",wp.continuation);
  }
  console.log(`\n[verify] 小结：PASS ${passCount}，FAIL ${failCount}`);
}

/** 收尾：关宿主、清临时目录，然后**显式退出**（宿主 server 会挂住事件循环）。 */
let hostHandle: { close: () => void; port?: number; token?: string } | null = null;
void main()
  .catch((e) => {
    console.error("[verify] 验证中断：", e instanceof Error ? e.stack ?? e.message : String(e));
    failCount++;
  })
  .finally(() => {
    try {
      hostHandle?.close();
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    } catch {
      /* 收尾失败不影响结论 */
    }
    process.exit(failCount > 0 ? 1 : 0);
  });
