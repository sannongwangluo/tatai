// B3+B4 收口：**真实宿主**只读入口带逐 check 工作包的端到端实测（PLAN V09-53/V09-54；DESIGN §2.7/§6.7/§6.8）。
//
// 这条脚本存在的理由（D1 全链）：B3 首稿在「宿主在跑」时拿不到工作包——宿主只读入口 `GET /api/work/entry`
// 不认 `work_package` 查询参数，客户端只能如实标 `unsupported_by_host`。D1 把
// 「MCP 工具入参 → syncHost → fetchHostEntryResult → 查询参数 → service.ts 路由 → readJobs.computeEntryView
//  → evaluateProjectEntry(work_package)」整条接通。本脚本用**真实 HTTP 宿主**证明这条链真的通，且：
//   · 宿主那条读口带回的工作包与入口/图/同步出自**同一份现读快照**；
//   · 宿主读口的版本/游标契约（expected_revision、跨请求游标）逐条如实失效；
//   · 工作包里的下一步是**真实可执行操作**——脚本照着它真做（认领 → 源清单/自检 → 非作者独审 → 提交）；
//   · **重进**已完成卡时不再派同一份活（幂等、不重复干），且不追加事件。
//
// 口径（诚实边界）：
//   · 宿主 = `handleWorkRequest`（桌面宿主与独立 daemon **共用的生产路由实现**）+ `WorkService` + 真实描述符/令牌，
//     HTTP 走真实回环 socket + 动态端口；MCP 侧用**真实工具 handler**（与 stdio MCP 同一份 handler），
//     经 `ctx.work`（真实 `WorkServiceClient`）转接宿主。**不在本脚本里另写一套路由或假造回包。**
//   · 「真 stdio MCP + spawn 的 `src/server/index.ts` 桌面壳」那一档由 `scripts/verify-forward-journey.ts`
//     覆盖（那里也断言了工作包，见其 6-4/6-5/6-6）；本脚本补的是「同一宿主读口在 HTTP 层的逐条契约」。
//   · 隔离：mkdtemp + 隔离 `TATAI_HOME` + 动态端口（绑 0）；**绝不碰** 8787、**绝不碰**任何真实项目/账本。
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
import { buildSourceManifest } from "../src/server/work/sourceEvidence";
import { handleWorkRequest, WorkService, WorkServiceClient, writeServiceDescriptor } from "../src/server/work/service";
import { projectEntryTool, claimTaskTool, submitTaskResultTool } from "../src/mcp/tools/projectEntry";
import { taskBriefTool } from "../src/mcp/tools/taskBrief";
import { recordWorkEvidenceTool } from "../src/mcp/tools/recordWorkEvidence";
import type { McpTool, ToolResult } from "../src/mcp/tools/types";

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
const info = (t: string): void => console.log(`[verify]   ${t}`);
const sha256 = (b: string | Buffer): string => crypto.createHash("sha256").update(b).digest("hex");

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-host-wp-"));
const dataDir = path.join(tmpBase, "home");
fs.mkdirSync(dataDir, { recursive: true });
process.env.TATAI_HOME = dataDir;
const service = new WorkService({ dataDir });
const CHG = "chg-host-wp";
const executor = "kimi-code";
const auditor = "codex-audit";
const HOST_TOKEN = "host-wp-token";

const write = (f: string, text: string): void => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text, "utf8");
};

interface Card {
  id: string;
  goal: string;
}
function planText(title: string, cards: Card[]): string {
  const lines = ["# " + title, "", "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |", "| --- | --- | --- | --- | --- |"];
  for (const c of cards) lines.push(`| ${c.id} | todo | ${c.goal} |  | ${c.id} 的完成证据 |`);
  lines.push("");
  for (const c of cards) {
    lines.push(`### ${c.id} ${c.goal}`, "");
    lines.push(`**设计依据**：§1。**依赖**：无。**文件责任**：\`src/${c.id.toLowerCase()}.ts\`。`, "");
    lines.push(`- [ ] **chk-${c.id.toLowerCase()}-01** 目标达标`);
    lines.push(`- [ ] **chk-${c.id.toLowerCase()}-02** 非作者复核：独立验证达标`);
    lines.push("");
  }
  return lines.join("\n");
}

const root = path.join(tmpBase, "proj-host-wp");
fs.mkdirSync(path.join(root, ".工作台"), { recursive: true });
const designFile = path.join(root, ".工作台", "design.md");
const planFile = path.join(root, ".工作台", "plan.md");
write(designFile, "# host-wp 设计书\n\n## 1 目标\n\n夹具设计正文。\n");
// 两张卡：T-1（本脚本做完）与 T-2（**没做**）——这样「重进已完成不重复干」是真断言：
// 做完 T-1 后重进必须指向 T-2，而不是把 T-1 的活再派一遍。
const plan = planText("host-wp 施工图", [
  { id: "T-1", goal: "宿主工作包闭环卡" },
  { id: "T-2", goal: "下一张待做卡" },
]);
write(planFile, plan);
const PID = "host-wp";
addProject({ id: PID, name: "宿主工作包夹具", path: root, kind: "backend" }, dataDir);
const defs: TaskDefinition[] = importTaskDefinitions(plan, { plan_revision: sha256(plan) }).definitions;
activateBaseline(PID, { approved_by: "user", approval_basis: "宿主工作包夹具审定", approval_kind: "user_confirmed" }, dataDir);
submitDefinitionImports(service, { project_id: PID, change_id: CHG, actor_id: executor, role: "executor", definitions: defs });

const workDir = projectWorkDir(PID, dataDir);
const eventsFile = path.join(workDir, "events.jsonl");
const eventsHash = (): string => (fs.existsSync(eventsFile) ? sha256(fs.readFileSync(eventsFile)) : "<none>");
const revOf = (): number => readTaskStates(workDir).states["T-1"]?.revision ?? 0;

// ── 真实 HTTP 宿主（生产路由实现 + 动态端口 + 真实描述符/令牌） ──
const listen = (srv: http.Server): Promise<number> =>
  new Promise((resolve, reject) => {
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => resolve((srv.address() as { port: number }).port));
  });
let host: { port: number; close: () => void } | null = null;

const textOf = (r: ToolResult): string =>
  (r.content ?? [])
    .filter((c): c is { type: "text"; text: string } => (c as { type: string }).type === "text")
    .map((c) => c.text)
    .join("\n");
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

/** 裸 HTTP GET 宿主只读入口（生产路由 `handleWorkRequest`） */
async function hostEntry(qs: Record<string, string>): Promise<any | null> {
  const port = host!.port;
  const url = `/api/work/entry?${new URLSearchParams({ project_id: PID, role: "executor", client_capabilities: "continuable", ...qs }).toString()}`;
  return new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port, path: url, method: "GET", headers: { "x-tatai-work-token": HOST_TOKEN } }, (res) => {
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
    });
    req.on("error", () => resolve(null));
    req.end();
  });
}

/** 工作包的一句话概览（进失败现场/诊断行，便于人工核对） */
const wpView = (wp: any): unknown =>
  wp === undefined || wp === null
    ? null
    : {
        task_id: wp.task_id,
        revision: typeof wp.package_revision === "string" ? wp.package_revision.slice(0, 12) : null,
        ok: wp.ok ?? true,
        checks: (wp.checks ?? []).map((c: any) => `${c.check_id}:${c.effective}:${c.next_operation?.tool ?? ""}.${c.next_operation?.operation ?? ""}`),
        satisfied: wp.completion?.satisfied,
        continuation: `${wp.continuation?.operation ?? ""}`,
      };

async function main(): Promise<void> {
  const server = http.createServer((req, res) => {
    const pathname = (req.url ?? "/").split("?")[0];
    void handleWorkRequest(req, res, { service, token: HOST_TOKEN, pathname }).then((handled) => {
      if (!handled) {
        res.statusCode = 404;
        res.end("{}");
      }
    });
  });
  host = { port: await listen(server), close: () => server.close() };
  writeServiceDescriptor(dataDir, {
    schema_version: 2,
    pid: process.pid,
    host: "127.0.0.1",
    port: host.port,
    token: HOST_TOKEN,
    started_at: new Date().toISOString(),
    url: `http://127.0.0.1:${host.port}`,
  });
  const client = new WorkServiceClient({ dataDir, autostart: false });

  // ═══ ① 宿主回包契约：默认不含工作包；显式索取才附（同一现读快照） ═══
  section("① 宿主只读入口：默认契约逐字不变；显式 work_package=true 才附（HTTP 直连）");
  const legacy = await hostEntry({});
  ok(legacy?.ok === true && legacy.entry !== undefined, "① 宿主读口可达（生产路由 + 真实令牌）");
  ok(
    legacy !== null && (legacy.entry as { work_package?: unknown }).work_package === undefined,
    "① 默认（不带 work_package）⇒ 回包**不含**该字段（旧宿主/旧客户端兼容，逐字不变）",
    legacy === null ? null : Object.keys(legacy.entry as object).filter((k) => k.includes("work")),
  );
  const httpWp = await hostEntry({ work_package: "true" });
  ok(httpWp?.ok === true && httpWp.entry?.work_package !== undefined, "① 显式 work_package=true ⇒ 回包带 work_package（D1 全链接通）");
  const pkg = httpWp?.entry?.work_package ?? {};
  ok(typeof pkg.package_revision === "string" && pkg.package_revision.length === 64, "① 工作包带 package_revision（内容身份，不是自报版本号）", pkg.package_revision);
  ok(pkg.task_id === "T-1" && typeof pkg.task_revision === "string", "① 工作包指向当前任务 T-1 与实体版本", { task: pkg.task_id, rev: pkg.task_revision });
  const ids: string[] = (pkg.checks ?? []).map((c: any) => c.check_id);
  ok(
    ids.includes("chk-t-1-01") && ids.includes("chk-t-1-02") && ids.includes("T-1::evidence"),
    "① 逐项检查齐全（两条稳定键验收检查 + 完成证据要求）",
    ids,
  );
  ok(
    (pkg.checks ?? []).every((c: any) => typeof c.next_operation?.tool === "string" && typeof c.next_operation?.operation === "string"),
    "① 每个 check 都给 next_operation（tool/operation 具名）",
  );
  // 兼容反例：依赖参数却不索取工作包 ⇒ 显式 400（不静默忽略）
  const badCombo = await hostEntry({ work_package_limit: "1" });
  ok(
    badCombo?.code === "INVALID_COMMAND",
    "① 给了 work_package_limit 却没给 work_package=true ⇒ 显式 INVALID_COMMAND（不静默忽略无效组合）",
    badCombo?.code,
  );

  // ═══ ② 宿主读口的版本/游标契约（此刻 T-1 在 executor 位，共 3 条检查） ═══
  section("② 宿主读口：expected_revision / 分页游标显式失效（不返回跨版本数据）");
  const stale = await hostEntry({ work_package: "true", work_package_expected_revision: "deadbeef" });
  ok(
    stale?.ok === true && stale.entry?.work_package?.ok === false && stale.entry.work_package.code === "REVISION_CHANGED",
    "② 旧 expected_revision ⇒ 工作包显式 REVISION_CHANGED（带重读入口）",
    stale?.entry?.work_package?.code,
  );
  const same = await hostEntry({ work_package: "true", work_package_expected_revision: pkg.package_revision });
  ok(same?.entry?.work_package?.ok !== false, "② 相符的 expected_revision ⇒ 正常返回工作包", same?.entry?.work_package?.code);
  const page1 = await hostEntry({ work_package: "true", work_package_limit: "1" });
  const cursor = page1?.entry?.work_package?.paging?.cursor;
  ok(page1?.entry?.work_package?.paging?.complete === false && typeof cursor === "string", "② limit=1 ⇒ 给不透明游标", page1?.entry?.work_package?.paging);
  const resume = await hostEntry({ work_package: "true", work_package_limit: "1", work_package_cursor: cursor });
  ok(
    resume?.entry?.work_package?.ok !== false && (resume?.entry?.work_package?.checks ?? []).length === 1,
    "② 同版本同请求的游标可续读（第二页恰 1 条）",
    wpView(resume?.entry?.work_package),
  );
  const crossRole = await hostEntry({ role: "coordinator", client_capabilities: "coordination", work_package: "true", work_package_limit: "1", work_package_cursor: cursor });
  ok(
    crossRole?.entry?.work_package?.ok === false && crossRole.entry.work_package.code === "REVISION_CHANGED",
    "② **跨请求**（不同角色档）的游标不互用（显式失效）",
    crossRole?.entry?.work_package?.code,
  );

  // ═══ ③ MCP 工具路径与宿主读口**同一份**事实快照 ═══
  section("③ MCP project_entry / task_brief 经宿主拿工作包（与 HTTP 直连同版）");
  const pe = await callTool(projectEntryTool, { project_id: PID, role: "executor", client_capabilities: "continuable" }, { work: client });
  ok(!pe.isError && pe.json?.work_package !== undefined, "③ project_entry（MCP）经宿主带出 work_package", Object.keys(pe.json ?? {}));
  ok(pe.json?.versions !== undefined && pe.json?.source !== undefined, "③ 这一份来自宿主只读读口（versions/source 在场，非本地回退）");
  ok(
    pe.json?.work_package?.package_revision === pkg.package_revision,
    "③ HTTP 直连与 MCP 路径算出**同一个** package_revision（同一判据、同一事实）",
    { http: pkg.package_revision?.slice(0, 12), mcp: pe.json?.work_package?.package_revision?.slice(0, 12) },
  );
  const tb = await callTool(taskBriefTool, { project_id: PID, role: "executor", client_capabilities: "continuable", detail: "full" }, { work: client });
  ok(tb.json?.work_package_status === "ok", `③ task_brief 经宿主报 work_package_status=ok（实测 ${tb.json?.work_package_status}），不再是 unsupported_by_host`);
  const wp = pe.json.work_package;
  ok(pe.json?.next_action === "claim_task", `③ 入口动作与工作包一致：claim_task（实测 ${pe.json?.next_action}）`);
  ok(wp.continuation?.operation === "claim_task", `③ continuation.operation 对齐入口真实动作（实测 ${wp.continuation?.operation}）`);
  ok(!JSON.stringify(wp).includes("summarize_work_package_checks"), "③ 工作包不含虚构操作");

  // ═══ ④ 照工作包给的下一步真做（不是只断言字段在场） ═══
  section("④ 按工作包的点名操作真做：认领 → 源清单/自检 → 非作者独审");
  const checkOf = (id: string): any => (wp.checks ?? []).find((c: any) => c.check_id === id);
  const c1 = checkOf("chk-t-1-01");
  const c2 = checkOf("chk-t-1-02");
  ok(c1?.effective === "missing" && c1?.next_operation?.tool === "record_work_evidence" && c1.next_operation.operation === "self_check",
    `④ 未开工 ⇒ 点名 record_work_evidence/self_check（实测 ${c1?.next_operation?.tool}.${c1?.next_operation?.operation}）`, c1?.next_operation);
  ok(c2?.independence_required === true && c2?.next_operation?.operation === "independent_audit" && c2?.responsible_role === "auditor",
    `④ 要求独审且未记录 ⇒ 点名非作者 independent_audit（实测 ${c2?.next_operation?.operation}/${c2?.responsible_role}）`, c2?.next_operation);

  const claimed = await callTool(
    claimTaskTool,
    { op: "claim", project_id: PID, task_id: "T-1", role: "executor", owner_id: executor, change_id: CHG, expected_revision: Number(wp.task_revision) },
    { work: client },
  );
  ok(!claimed.isError && claimed.json?.ok === true, "④ 按工作包给的实体版本认领成功", claimed.text.slice(0, 220));
  const claimToken = claimed.json?.claim?.claim_token as string;
  ok(typeof claimToken === "string" && claimToken !== "" && !JSON.stringify(wp).includes(claimToken), "④ 认领 token 真实存在且工作包不回显它");

  const srcRel = "src/t1.ts";
  write(path.join(root, srcRel), "export const T1_OK = true;\n");
  const fingerprint = buildSourceManifest(root, [srcRel]).fingerprint;
  const stored = await callTool(
    recordWorkEvidenceTool,
    { op: "store", project_id: PID, role: "executor", kind: "source_manifest", summary: "T-1 源清单", binding: { revision_kind: "code", revision: fingerprint }, source_manifest: [srcRel] },
    { work: client },
  );
  const sourceBlob = stored.json?.evidence?.sha256 as string;
  ok(typeof sourceBlob === "string" && /^[0-9a-f]{64}$/.test(sourceBlob), "④ 源清单存证经唯一宿主（内容寻址）", stored.text.slice(0, 220));

  const sc = await callTool(
    recordWorkEvidenceTool,
    {
      op: "self_check",
      project_id: PID,
      role: "executor",
      change_id: CHG,
      record_id: "sc-host-01",
      task_id: "T-1",
      conclusion: "pass",
      binding: { revision_kind: "code", revision: fingerprint },
      checks: [
        { check_id: "chk-t-1-01", method: "跑了该检查对应的验证", evidence_sha256: sourceBlob, verifies: "code" },
        { check_id: "T-1::evidence", method: "完成证据落盘", evidence_sha256: sourceBlob, verifies: "code" },
      ],
    },
    { work: client },
  );
  ok(!sc.isError && sc.json?.ok === true, "④ 自检落账（作者档）", sc.text.slice(0, 220));
  const au = await callTool(
    recordWorkEvidenceTool,
    {
      op: "independent_audit",
      project_id: PID,
      role: "auditor",
      change_id: CHG,
      record_id: "au-host-01",
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
      // 逐项检查必须显式给 `result`（passed/failed/not_checked）：唯一写入服务的新写前校验
      // （`src/server/work/auditValidation.ts`）拒绝「未知检查结果默认 passed」，缺 result 整条**零写入**。
      // 这里按**真实执行**写 `passed`（该检查确实复核过），不靠省略字段让产品替我们默认，也不裸写绕开写口。
      checks: [{ check_id: "chk-t-1-02", result: "passed", evidence_sha256: sourceBlob, verifies: "code" }],
      binding: { revision_kind: "code", revision: fingerprint },
    },
    { work: client, clientName: auditor },
  );
  ok(!au.isError && au.json?.ok === true, "④ 非作者独立审计落账（作者自检不冒充独审）", au.text.slice(0, 240));

  // 反例（判据**不放宽**）：同样一条独审、逐项检查**缺 `result`** ⇒ 唯一写入服务在落盘前拒收、零写入。
  // 这条负例证明上面那条不是「省略字段也能过」；产品判据一分未改，也不走裸写。
  const auditShaBeforeNeg = eventsHash();
  const negAudit = await callTool(
    recordWorkEvidenceTool,
    {
      op: "independent_audit",
      project_id: PID,
      role: "auditor",
      change_id: CHG,
      record_id: "au-host-neg-missing-result",
      task_id: "T-1",
      auditor,
      author_id: executor,
      conclusion: "pass",
      coverage: [
        { area: "behavior_boundaries", basis: "读了实现与边界用例" },
        { area: "data_concurrency", basis: "查了并发路径" },
        { area: "interface_integration", basis: "核了接口契约" },
        { area: "failure_recovery", basis: "核了失败路径" },
        { area: "trust_permission", basis: "核了权限边界" },
      ],
      checks: [{ check_id: "chk-t-1-02", evidence_sha256: sourceBlob, verifies: "code" }],
      binding: { revision_kind: "code", revision: fingerprint },
    },
    { work: client, clientName: auditor },
  );
  ok(
    (negAudit.isError === true || negAudit.json?.ok === false) &&
      String(negAudit.json?.code ?? "") === "EVENT_INVALID" &&
      String(negAudit.json?.message ?? "").includes("未知检查结果"),
    "④ 反例：逐项检查缺 result ⇒ 独立审计被拒（未知检查结果不得默认 passed）",
    negAudit.text.slice(0, 240),
  );
  ok(
    eventsHash() === auditShaBeforeNeg,
    "④ 反例零写入：缺 result 的审计**一个字节都没落盘**（事件文件 sha256 逐字节不变）",
  );

  // ═══ ⑤ 回收口逐项收口 → 提交 ═══
  section("⑤ 回收口逐项收口 → 提交（技术完成）");
  const wp2 = (await callTool(projectEntryTool, { project_id: PID, role: "executor", client_capabilities: "continuable" }, { work: client })).json.work_package;
  info(`⑤ 收口后工作包：${JSON.stringify(wpView(wp2))}`);
  const c1b = (wp2.checks ?? []).find((c: any) => c.check_id === "chk-t-1-01");
  const c2b = (wp2.checks ?? []).find((c: any) => c.check_id === "chk-t-1-02");
  ok(c1b?.effective === "passed" && c2b?.effective === "passed", "⑤ 两条验收检查各经对应档（自检/独审）⇒ passed", { c1: c1b?.effective, c2: c2b?.effective });
  ok(c2b?.next_operation?.tool === "", "⑤ 已收口的检查不再给待办动作");
  ok(wp2.completion?.satisfied === true, "⑤ 逐项收口 + 独审义务满足 ⇒ completion.satisfied（技术完成）", wp2.completion);
  ok(wp2.continuation?.operation === "resume_task", `⑤ 已认领 ⇒ 入口动作 resume_task（实测 ${wp2.continuation?.operation}）`);

  const submitted = await callTool(
    submitTaskResultTool,
    {
      project_id: PID,
      task_id: "T-1",
      role: "executor",
      owner_id: executor,
      change_id: CHG,
      claim_token: claimToken,
      expected_revision: revOf(),
      evidence_refs: [srcRel],
      deliverables: ["T-1 实现"],
      verification: [],
      untested: [],
      known_issues: [],
    },
    { work: client },
  );
  ok(!submitted.isError && submitted.json?.ok === true, "⑤ submit_task_result 成功（技术完成 → result_submitted）", submitted.text.slice(0, 260));

  // ═══ ⑥ 重进：已完成不再派同一份活；两读不追加事件 ═══
  section("⑥ 重进入口：该卡已收口 ⇒ 不再派同一份活；同事实两读不追加事件");
  const before = eventsHash();
  const re1 = await callTool(projectEntryTool, { project_id: PID, role: "executor", client_capabilities: "continuable" }, { work: client });
  const re2 = await callTool(projectEntryTool, { project_id: PID, role: "executor", client_capabilities: "continuable" }, { work: client });
  const coordRe = await callTool(projectEntryTool, { project_id: PID, role: "coordinator", client_capabilities: "coordination" }, { work: client });
  ok(eventsHash() === before, "⑥ 重进入口**零写入**（events.jsonl 逐字节不变）");
  info(`⑥ 重进（executor）现场：${JSON.stringify({ next_action: re1.json?.next_action, wp: wpView(re1.json?.work_package) })}`);
  info(`⑥ 重进（coordinator）现场：${JSON.stringify({ next_action: coordRe.json?.next_action, wp: wpView(coordRe.json?.work_package) })}`);
  const reWp = re1.json?.work_package;
  ok(
    re1.json?.next_action !== "resume_task" && reWp?.task_id === "T-2",
    `⑥ 重进把工作包指向**下一张**未做卡 T-2（实测 next_action=${re1.json?.next_action}、wp.task=${reWp?.task_id}）——已完成不重复干`,
    wpView(reWp),
  );
  // 已完成卡 T-1 的检查**一条都不再出现**在工作包里（不重复派已收口的活）
  const leaked = (reWp?.checks ?? []).filter((c: any) => c.check_id.startsWith("chk-t-1-") || c.check_id.startsWith("T-1::"));
  ok(leaked.length === 0, "⑥ 已完成卡 T-1 的检查**不再出现**在重进工作包里（不重复干）", leaked.map((c: any) => c.check_id));
  const rePending = (reWp?.checks ?? []).filter((c: any) => c.next_operation?.tool !== "");
  ok(
    rePending.length > 0 && rePending.every((c: any) => c.check_id.startsWith("chk-t-2-") || c.check_id.startsWith("T-2::")),
    "⑥ 重进工作包的待办动作**只**属于 T-2（新活，不是把 T-1 再派一遍）",
    rePending.map((c: any) => `${c.check_id}:${c.next_operation.tool}.${c.next_operation.operation}`),
  );
  ok(re2.json?.next_action === re1.json?.next_action, "⑥ 同一事实连读两次给**同一**动作（幂等）", { a: re1.json?.next_action, b: re2.json?.next_action });
  // T-1 已收口：协调者视角不再给它派任何动作（收件面）
  const coordWp = coordRe.json?.work_package;
  const coordT1 = (coordWp?.checks ?? []).filter((c: any) => c.check_id.startsWith("chk-t-1-") || c.check_id.startsWith("T-1::"));
  ok(coordT1.length === 0, "⑥ 协调者视角同样不再出现 T-1 的检查（已收口不再派工）", coordT1.map((c: any) => c.check_id));
  const dupClaim = await callTool(
    claimTaskTool,
    { op: "claim", project_id: PID, task_id: "T-1", role: "executor", owner_id: "another-agent", change_id: CHG, expected_revision: revOf() },
    { work: client },
  );
  ok(dupClaim.isError === true || dupClaim.json?.ok === false, "⑥ 已完成卡再认领被拒（不重复干）", dupClaim.text.slice(0, 260));

  console.log(`\n[verify] 小结：PASS ${passCount}，FAIL ${failCount}`);
}

void main()
  .catch((e) => {
    console.error("[verify] 验证中断：", e instanceof Error ? e.stack ?? e.message : String(e));
    failCount++;
  })
  .finally(() => {
    try {
      host?.close();
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
