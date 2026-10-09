// V09-53（B3）验证脚本：逐 check 工作包（`work_package`）——DESIGN.md §2.7 / §2.6 / §5.4 / §5.6 / §6.7 / §6.9 / §6.11。
//
// 自带隔离环境：临时 `TATAI_HOME` + `os.tmpdir()` 下的夹具项目，**不碰**任何真实项目（尤其 D:/tatai、D:/demo-project）。
// 只读派生，不写事件（除夹具自身的定义导入）；不连宿主、不调模型、不占端口。
//
// 覆盖卡上检查项：
//   chk-v09-53-01 字段完备（顶层 + 逐项；required 与 independence_required 分开；uncovered 逐条点名）
//   chk-v09-53-02 定义/源变使旧包与旧游标失效并给重读入口（不静默返回跨版本数据）
//   chk-v09-53-03 定义重排不按序号继承通过（指纹按稳定键，重排不变；effective 按 check_id 取）
//   chk-v09-53-04 两模式同形（direct_tatai / coordinator_managed 同一判据；unsupported 显式、不回退）
//   chk-v09-53-05 旧客户端兼容（旧字段逐字保留；新字段缺失如实标 unsupported_by_host）
//   chk-v09-53-06 与预检同判据（next_operation 参数真实取自现工具 schema；锁内 not_checked 与预检同源）
//   另：源缺失 fail-closed（删 DESIGN/PLAN 阻断，无关源不影响）；幂等（同事实三读一致、不写账）；task 作用域隔离。
//
// 用法：node --import tsx scripts/verify-work-package.ts      （或 pnpm --config.verify-deps-before-run=false exec tsx ...）
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { addProject } from "../src/server/registry";
import { projectWorkDir } from "../src/server/workstation";
import { activateBaseline } from "../src/server/work/documents";
import { importTaskDefinitions, type TaskDefinition } from "../src/server/work/plan";
import { buildSourceManifest } from "../src/server/work/sourceEvidence";
import { handleWorkRequest, WorkService, WorkServiceClient, writeServiceDescriptor } from "../src/server/work/service";
import { submitDefinitionImports } from "../src/server/work/tasks";
import { evaluateProjectEntry, PROJECT_ENTRY_RESULT_FIELDS } from "../src/server/work/entry";
import { stableCheckDefinitionsOf } from "../src/server/work/obligations";
import {
  LOCK_IN_NOT_CHECKED,
  TOOL_PARAM_KEYS,
  WORK_PACKAGE_LIMIT_MAX,
  type WorkPackageFailure,
  type WorkPackageFull,
} from "../src/server/work/workPackage";
import { evaluateSubmitResultChecks } from "../src/server/work/submitChecks";
import { findTool, TOOLS } from "../src/mcp/tools/index";
import { taskBriefTool } from "../src/mcp/tools/taskBrief";
import { recordWorkEvidenceTool } from "../src/mcp/tools/recordWorkEvidence";
import type { McpTool } from "../src/mcp/tools/types";

// ── 断言与日志 ──

let passCount = 0;
let failCount = 0;
const ok = (cond: boolean, label: string, detail?: unknown): void => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (cond) passCount++;
  else {
    failCount++;
    process.exitCode = 1;
    if (detail !== undefined) console.log(`[verify]   现场：${JSON.stringify(detail).slice(0, 1800)}`);
  }
};
const info = (m: string): void => console.log(`[verify]   ${m}`);
const sha256 = (s: string | Buffer): string => crypto.createHash("sha256").update(s).digest("hex");

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-work-package-"));
const dataDir = path.join(tmpBase, "home");
fs.mkdirSync(dataDir, { recursive: true });
process.env.TATAI_HOME = dataDir;
const service = new WorkService({ dataDir });
const CHG = "chg-work-package";
const executor = "kimi-code";
const CONTINUABLE = "continuable";

const mkdirp = (d: string): void => {
  fs.mkdirSync(d, { recursive: true });
};
const write = (f: string, text: string): void => {
  mkdirp(path.dirname(f));
  fs.writeFileSync(f, text, "utf8");
};

interface Card {
  id: string;
  goal: string;
  paths?: string[];
  checks?: string[];
}

function planText(title: string, cards: Card[]): string {
  const lines = [`# ${title}`, "", "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |", "| --- | --- | --- | --- | --- |"];
  for (const c of cards) lines.push(`| ${c.id} | todo | ${c.goal} |  | ${c.id} 的完成证据 |`);
  lines.push("");
  for (const c of cards) {
    lines.push(`### ${c.id} ${c.goal}`);
    lines.push("");
    lines.push(`**设计依据**：§1。**依赖**：无。**文件责任**：\`${(c.paths ?? [`src/${c.id.toLowerCase()}.ts`])[0]}\`。`);
    lines.push("");
    for (const chk of c.checks ?? [`${c.goal} 达标`]) lines.push(`- [ ] ${chk}`);
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
  /** 施工图**原始**文本（恢复现场用，保证与基线逐字节一致） */
  planText: string;
  defs: TaskDefinition[];
}

function makeFixture(id: string, cards: Card[]): Fixture {
  const root = path.join(tmpBase, id);
  mkdirp(path.join(root, ".工作台"));
  const designFile = path.join(root, ".工作台", "design.md");
  const planFile = path.join(root, ".工作台", "plan.md");
  write(designFile, `# ${id} 设计书\n\n## 1 目标\n\n夹具项目的设计正文。\n`);
  const plan = planText(`${id} 施工图`, cards);
  write(planFile, plan);
  addProject({ id, name: `V09-53 夹具 ${id}`, path: root, kind: "backend" }, dataDir);
  const imported = importTaskDefinitions(plan, { plan_revision: sha256(plan) });
  activateBaseline(id, { approved_by: "user", approval_basis: "V09-53 夹具审定", approval_kind: "user_confirmed" }, dataDir);
  if (cards.length > 0) {
    submitDefinitionImports(service, {
      project_id: id,
      change_id: CHG,
      actor_id: executor,
      role: "executor",
      definitions: imported.definitions,
    });
  }
  return { id, root, workDir: projectWorkDir(id, dataDir), designFile, planFile, planText: plan, defs: imported.definitions };
}

const eventsHash = (fx: Fixture): string => {
  const f = path.join(fx.workDir, "events.jsonl");
  return fs.existsSync(f) ? sha256(fs.readFileSync(f)) : "<none>";
};

const entryOf = (fx: Fixture, args: Record<string, unknown>, opts: Record<string, unknown> = {}): any =>
  evaluateProjectEntry({ project_id: fx.id, role: "executor", client_capabilities: CONTINUABLE, ...args }, { dataDir, ...opts });

const wpOf = (entry: any): WorkPackageFull | WorkPackageFailure | null => entry?.work_package ?? null;
const isOkWp = (w: unknown): w is WorkPackageFull => w !== null && typeof w === "object" && (w as { ok?: unknown }).ok !== false;
const isFailWp = (w: unknown): w is WorkPackageFailure => w !== null && typeof w === "object" && (w as { ok?: unknown }).ok === false;

async function callTool(tool: McpTool, args: Record<string, unknown>, ctx: Record<string, unknown> = {}): Promise<{ isError: boolean; text: string; json: any }> {
  const r = await tool.handler(args, { clientName: executor, ...ctx } as never);
  const text = (r.content ?? []).filter((c): c is { type: "text"; text: string } => (c as { type: string }).type === "text").map((c) => c.text).join("\n");
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { isError: r.isError === true, text, json };
}

/** 隔离宿主（动态空闲端口，绝不 8787）：真实工具写口只经唯一写入服务。 */
let wpHost: { port: number; close: () => void } | null = null;
async function startWpHost(token: string): Promise<{ port: number; close: () => void }> {
  const server = http.createServer((req, res) => {
    const pathname = (req.url ?? "/").split("?")[0];
    void handleWorkRequest(req, res, { service, token, pathname }).then((handled) => {
      if (!handled) {
        res.statusCode = 404;
        res.end("{}");
      }
    });
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
  });
  return { port, close: () => server.close() };
}

const CHECK_EFFECTIVE = new Set(["passed", "failed", "missing", "stale", "unknown", "not_checked", "not_applicable"]);
const TOP_FIELDS = [
  "scope_id",
  "scope_revision",
  "package_revision",
  "baseline",
  "task_id",
  "task_revision",
  "ownership",
  "source_mode",
  "status",
  "checks",
  "completion",
  "continuation",
  "paging",
];
const CHECK_FIELDS = [
  "check_id",
  "definition_fingerprint",
  "requirement",
  "required",
  "independence_required",
  "effective",
  "evidence_refs",
  "verified_binding",
  "changed_paths",
  "uncovered",
  "responsible_role",
  "next_operation",
];

// ════════════════════════════════════════════════════════════════════════

const fx = makeFixture("wp-a", [
  { id: "T-1", goal: "一号目标", paths: ["src/t1.ts"], checks: ["**chk-wp-01** 目标 A 达标", "**chk-wp-02** 非作者复核：目标 B 达标"] },
  { id: "T-2", goal: "无关任务", checks: ["**chk-wp-09** 别的卡达标"] },
]);

try {
  // ── ① 字段完备 + 稳定身份 + 逐项 effective + task 作用域 ──
  info("── ① 字段完备 / 稳定 identity / 逐项 effective / task 作用域");
  const entry1 = entryOf(fx, {}, { work_package: true });
  ok(entry1.next_action === "claim_task", `① 现场可领取（next_action=${entry1.next_action}）`, entry1.next_action);
  ok(!("work_package" in entry1) === false, "① opt-in 时入口带 work_package");
  const wp = wpOf(entry1);
  ok(isOkWp(wp), "① work_package 形态为成功包（非失效对象）", wp);
  const w = wp as WorkPackageFull;

  ok(TOP_FIELDS.every((k) => k in (w as unknown as Record<string, unknown>)), `① 顶层字段齐全（${TOP_FIELDS.filter((k) => !(k in (w as any))).join("/") || "全"}）`, Object.keys(w));
  ok(
    w.baseline !== null && "design_revision" in w.baseline && "plan_revision" in w.baseline && "baseline_id" in w.baseline,
    "① baseline = design_revision/plan_revision/baseline_id",
    w.baseline,
  );
  ok(
    w.ownership !== null && ["owner_id", "run_id", "attempt_id", "lease_expires_at", "workspace"].every((k) => k in w.ownership),
    "① ownership 字段齐全（且不含 claim_token）",
    w.ownership,
  );
  ok(
    w.completion !== null && ["satisfied", "remaining_checks", "blocking_findings"].every((k) => k in w.completion),
    "① completion = satisfied/remaining_checks/blocking_findings",
    w.completion,
  );
  ok(
    w.continuation !== null && ["action_id", "role", "operation", "reason", "prerequisite"].every((k) => k in w.continuation),
    "① continuation 字段齐全",
    w.continuation,
  );
  ok(w.paging !== null && "complete" in w.paging && "cursor" in w.paging, "① paging = complete/cursor", w.paging);

  ok(w.task_id === "T-1", `① 工作包只指向当前任务 T-1（task_id=${w.task_id}）`, w.task_id);
  // 2 条验收检查（稳定键 chk-wp-01/02）+ 1 条完成证据要求（`<task>::evidence`，无稳定键）
  const stableChecks = w.checks.filter((c) => c.check_id.startsWith("chk-wp-"));
  ok(w.checks.length === 3, `① 逐项 = T-1 的 3 项必需检查（2 验收 + 1 完成证据；实测 ${w.checks.length}）`, w.checks.map((c) => c.check_id));
  ok(stableChecks.length === 2, "① 稳定键检查 2 条（chk-wp-01/02）", stableChecks.map((c) => c.check_id));
  ok(
    stableChecks.every((c) => /^chk-wp-0[0-9]$/.test(c.check_id)),
    "① 有稳定键的检查用**稳定键**（chk-*），不是位置序号",
    stableChecks.map((c) => c.check_id),
  );
  ok(!w.checks.some((c) => c.check_id.includes("chk-wp-09")), "① task 作用域隔离：无关任务 T-2 的检查不污染本包");
  ok(
    w.checks.every((c) => CHECK_FIELDS.every((k) => k in (c as unknown as Record<string, unknown>))),
    "① 逐项字段齐全",
    w.checks.map((c) => Object.keys(c)),
  );
  ok(
    w.checks.every((c) => typeof c.definition_fingerprint === "string" && /^[0-9a-f]{64}$/.test(c.definition_fingerprint)),
    "① definition_fingerprint = 64 位 sha256",
    w.checks.map((c) => c.definition_fingerprint),
  );
  ok(
    w.checks.every((c) => CHECK_EFFECTIVE.has(c.effective)),
    "① effective 在逐项闭集内（**不用 DisplayStatus**）",
    w.checks.map((c) => c.effective),
  );
  ok(w.checks.every((c) => c.required === true), "① required 为布尔且缺省必需（DefaultDeny）");
  const indep = w.checks.find((c) => c.check_id === "chk-wp-02");
  ok(
    indep !== undefined && indep.independence_required === true && indep.required === true,
    "① required 与 independence_required **分开**（chk-wp-02 独审必需）",
    indep,
  );
  ok(
    w.checks.every((c) => Array.isArray(c.uncovered) && c.uncovered.length > 0),
    "① uncovered 逐条点名（无证据 ⇒ 至少一条缺口，不合并成一句）",
    w.checks.map((c) => c.uncovered),
  );
  ok(
    w.completion.remaining_checks.length === 3 && w.completion.satisfied === false,
    "① completion 如实：三项都未通过（不按空集/假绿）",
    w.completion,
  );
  ok(
    !JSON.stringify(w).includes("clm-") && !JSON.stringify(w).includes("claim_token\":\"") && w.checks.every((c) => c.next_operation.known_args.claim_token === undefined),
    "① 工作包**不回显认领秘密**：只点名参数名，不出现 token 值（known_args 不含 claim_token）",
    w.checks.map((c) => c.next_operation.known_args),
  );

  // ── ② next_operation 参数真实取自现工具 schema ──
  info("── ② next_operation 参数对真实工具 schema 断言（不造字段）");
  for (const [tool, keys] of Object.entries(TOOL_PARAM_KEYS)) {
    const t = findTool(tool);
    const schema = (t?.inputSchema ?? {}) as { properties?: Record<string, unknown>; required?: string[] };
    const props = new Set(Object.keys(schema.properties ?? {}));
    const missing = keys.filter((k) => !props.has(k));
    const reqMissing = (schema.required ?? []).filter((k) => !keys.includes(k));
    ok(
      missing.length === 0 && reqMissing.length === 0,
      `② ${tool}：参数表与真实 schema 一致（自造字段=${missing.join("/") || "无"}；漏 required=${reqMissing.join("/") || "无"}）`,
      { schemaProps: [...props], table: keys },
    );
  }
  const allToolKeys = new Set(Object.values(TOOL_PARAM_KEYS).flat());
  // B3-REVIEW-WATCH 11:36 第 4 项：`missing_args` 允许用**下标记法**点名"现场才能产"的逐检查子字段
  // （如 `checks[].method`）——判据只放宽到「基键必须真实存在」，**不**允许出现工具不认识的基键
  // （即"不造字段"这条核心性质保持：基键一律取自真实参数面）。
  const baseKeyOf = (k: string): string => k.replace(/\[.*$/, "");
  for (const c of w.checks) {
    const known = Object.keys(c.next_operation.known_args);
    const miss = c.next_operation.missing_args;
    const bad = [...known, ...miss].map(baseKeyOf).filter((k) => !allToolKeys.has(k));
    ok(bad.length === 0, `② ${c.check_id}：next_operation 的 known/missing 参数名（含下标记法的基键）都在真实工具参数面内（越界=${bad.join("/") || "无"}）`, { known, miss });
    ok(
      c.next_operation.tool === "" || findTool(c.next_operation.tool) !== undefined,
      `② ${c.check_id}：next_operation.tool 指向真实存在的工具（${c.next_operation.tool || "（无）"}）`,
      c.next_operation.tool,
    );
  }
  // V09-53 返工（B3-REVIEW-WATCH 第 1 项）：未生效通过的检查**不得**一律推 submit_task_result，
  // 要按阶段/角色给**真实可执行**的下一步（self_check / independent_audit / retest），缺参逐条点名。
  ok(
    !w.checks.some((c) => c.next_operation.tool === "submit_task_result"),
    "② 未生效通过的逐项动作**不是** submit_task_result（不再一律推整卡提交）",
    w.checks.map((c) => `${c.check_id}:${c.next_operation.tool}.${c.next_operation.operation}`),
  );
  const evOps = w.checks.filter((c) => c.next_operation.tool === "record_work_evidence");
  ok(evOps.length === w.checks.length, "② 逐项下一步都是 record_work_evidence 的真实 op", evOps.map((c) => c.next_operation.operation));
  const indepOp = w.checks.find((c) => c.check_id === "chk-wp-02");
  ok(
    indepOp?.next_operation.operation === "independent_audit" && indepOp?.responsible_role === "auditor",
    "② 独审必需的检查缺失 ⇒ 派**非作者**独立审计（不是让作者自检）",
    indepOp?.next_operation,
  );
  const selfOp = w.checks.find((c) => c.check_id === "chk-wp-01");
  ok(
    selfOp?.next_operation.operation === "self_check" &&
      selfOp.next_operation.missing_args.includes("record_id") &&
      selfOp.next_operation.missing_args.includes("conclusion") &&
      selfOp.next_operation.known_args.claim_token === undefined,
    "② 缺参点名含 record_id/conclusion 等**必填运行时字段**，但不回显/不索要 claim_token",
    selfOp?.next_operation,
  );
  ok(
    w.continuation.operation === "claim_task" && !JSON.stringify(w).includes("summarize_work_package_checks"),
    `② continuation.operation 对齐入口真实动作（${w.continuation.operation}；不再有虚构操作）`,
    w.continuation,
  );

  // ── ②a missing_args 只列**真正必填**；机械/非机械的条件组与判据写进只读 guidance（B3-REVIEW-WATCH 12:40 第 2 项） ──
  // 无条件必填都追到真实来源：handler 缺参校验 + 写侧彩排闸（service.ts#assertSelfCheckEvidenceConsistent，
  // E.3.2/E.3.3）/ 五维覆盖（audit.ts#assertCoverageComplete，§5.5）。**条件项**（机械检查才要 command+exit_code、
  // 第二档证据或方法二选一）**不**塞进 missing_args——它们写进 `next_operation.prerequisites/guidance`（只读、不进工具参数）。
  // 能从快照取的（author_id）若已给就不必再列缺；取不到时必须列缺（否则撞一次 `缺入参 author_id` 才回头读源码）。
  info("── ②a missing_args 只列真正必填；条件组/判据走只读 prerequisites/guidance");
  {
    const selfCheckRequired = [
      "record_id",
      "conclusion",
      "binding", // 以「通过」落记录时必填（须与被验对象种类相符，E.3.3）
      "checks[].verifies", // 写侧彩排闸：新写入的通过检查必填（E.3.3）
    ];
    const selfMiss = new Set(selfOp?.next_operation.missing_args ?? []);
    const selfLack = selfCheckRequired.filter((k) => !selfMiss.has(k));
    ok(
      selfLack.length === 0,
      `②a 作者自检的 missing_args 覆盖**无条件必填**现场参数（缺=${selfLack.join("/") || "无"}）`,
      { missing: selfOp?.next_operation.missing_args, required: selfCheckRequired },
    );
    // 不许把 command/exit_code 当**所有**自检的必填（B4 既定合同：无 command 走 method/coverage 第二档）。
    // 第二档的证据/方法同理是**二选一**，不逐项必填——两者都靠 guidance 明示条件。
    ok(
      !["checks[].command", "checks[].exit_code", "checks[].method", "checks[].evidence_sha256"].some((k) => selfMiss.has(k)),
      "②a 作者自检**不**把机械命令/第二档证据当逐项必填（非机械检查不准被逼编命令）",
      selfOp?.next_operation,
    );
    const selfGuide = [...(selfOp?.next_operation.prerequisites ?? []), ...(selfOp?.next_operation.guidance ?? [])].join("\n");
    ok(
      /checks\[\]\.command/.test(selfGuide) && /exit_code/.test(selfGuide) && /非机械/.test(selfGuide),
      "②a 条件组写进只读 guidance：机械检查才要 command+exit_code，非机械走 method/证据",
      selfGuide,
    );
    const auditRequired = [
      "record_id",
      "auditor",
      "conclusion",
      "coverage", // 五维覆盖矩阵（§5.5，必填）
      "read_author_summary_first", // 独审读序/独立性现场声明
      "same_session_as_author",
    ];
    const auditMiss = new Set(indepOp?.next_operation.missing_args ?? []);
    const auditLack = auditRequired.filter((k) => !auditMiss.has(k));
    ok(
      auditLack.length === 0,
      `②a 独立审计的 missing_args 覆盖**无条件必填**现场参数（缺=${auditLack.join("/") || "无"}）`,
      { missing: indepOp?.next_operation.missing_args, required: auditRequired },
    );
    ok(
      !["checks[].method", "checks[].evidence_sha256"].some((k) => auditMiss.has(k)),
      "②a 独立审计也**不**把第二档证据/方法当逐项必填（`coverage` 依据亦可作方法；二选一）",
      indepOp?.next_operation,
    );
    ok(
      indepOp?.next_operation.known_args.author_id !== undefined || auditMiss.has("author_id"),
      "②a 独审 author_id：能从快照取到就给，取不到**必列** missing_args（handler 必填，不漏项）",
      indepOp?.next_operation,
    );
    // 现场才能产的**结论/证据**不得被伪造成 known_args（不替人下验证结论）
    ok(
      selfOp?.next_operation.known_args.conclusion === undefined &&
        selfOp?.next_operation.known_args.binding === undefined &&
        (indepOp?.next_operation.known_args as Record<string, unknown> | undefined)?.coverage === undefined,
      "②a 现场才能产的结论/证据（conclusion/binding/coverage）**不**被预填进 known_args（不伪造现场结论）",
      { self: selfOp?.next_operation.known_args, audit: indepOp?.next_operation.known_args },
    );
  }

  // ── ②c 证据前置提示**真在返回的工作包里**（B3-REVIEW-WATCH 12:35/12:40 第 1 项） ──
  // 不是源码注释：新会话 Agent 只读工作包就要知道「代码检查先跑真验证 → store(kind=source_manifest) →
  // 回执 evidence.sha256 填 checks[].evidence_sha256、source_manifest.fingerprint 填 binding.revision」，
  // 以及「普通运行日志不带源清单 ⇒ 读侧 unknown」的原因。作者自检与独审**同一链路**。
  info("── ②c 工作包可读前置/判据：source_manifest 证据链路 + 读侧 unknown 原因 + 五维/读序含义");
  {
    const selfPre = selfOp?.next_operation.prerequisites ?? [];
    const selfText = [...selfPre, ...(selfOp?.next_operation.guidance ?? [])].join("\n");
    ok(
      selfPre.length > 0 && /kind[=:"]*source_manifest|source_manifest/.test(selfText) && /op["\s:=]*store|store\(/.test(selfText),
      "②c 作者自检给**可执行**前置：先 `record_work_evidence(op=store, kind=source_manifest)` 落覆盖源清单载体",
      selfPre,
    );
    ok(
      /evidence\.sha256/.test(selfText) && /fingerprint/.test(selfText) && /checks\[\]\.evidence_sha256/.test(selfText) && /binding\.revision/.test(selfText),
      "②c 前置写清两项回填：`evidence.sha256` → `checks[].evidence_sha256`；`source_manifest.fingerprint` → `binding.revision`",
      selfText,
    );
    ok(
      /unknown|不采信/.test(selfText) && /源清单|source_manifest/.test(selfText),
      "②c 可读解释：普通运行日志不带覆盖源清单 ⇒ 读侧没法现读复核、该检查记 unknown（不用读产品实现）",
      selfText,
    );
    ok(
      /文件责任|由你|范围/.test(selfText),
      "②c 源清单文件范围**由 Agent 按任务责任决定**（不预填结论/不预喂清单）",
      selfText,
    );
    const auditPre = indepOp?.next_operation.prerequisites ?? [];
    const auditText = [...auditPre, ...(indepOp?.next_operation.guidance ?? [])].join("\n");
    ok(
      auditPre.length > 0 && /source_manifest/.test(auditText),
      "②c 独审与作者**同一证据链路**也提示源清单前置（不是只照写侧必填）",
      auditPre,
    );
    ok(
      /behavior_boundaries/.test(auditText) && /failure_recovery/.test(auditText),
      "②c 独审给五维覆盖含义（behavior_boundaries…failure_recovery）——**不替 Agent 填结论**",
      auditText,
    );
    ok(
      /读序|先独立|后取/.test(auditText) && /read_author_summary_first/.test(auditText),
      "②c 独审给读序含义（先独立实测、后取作者材料；read_author_summary_first 如实声明）",
      auditText,
    );
    ok(
      (indepOp?.next_operation.known_args as Record<string, unknown> | undefined)?.guidance === undefined &&
        (indepOp?.next_operation.known_args as Record<string, unknown> | undefined)?.prerequisites === undefined,
      "②c 指导字段**不进**工具参数（known_args 里没有 guidance/prerequisites）",
      indepOp?.next_operation.known_args,
    );
  }

  // ── ②b 锁内 not_checked 与预检同源 ──
  info("── ②b 锁内特有校验 not_checked 与 preflight/submit 同源");
  const probe = evaluateSubmitResultChecks(
    {
      project_id: fx.id,
      task_id: "T-1",
      role: "executor",
      owner_id: executor,
      change_id: CHG,
      claim_token: "clm-does-not-matter",
      expected_revision: 1,
      evidence_refs: [],
    },
    null,
    { dataDir },
  );
  ok(
    JSON.stringify(probe.not_checked.map((r) => r.kind)) === JSON.stringify(LOCK_IN_NOT_CHECKED.map((r) => r.kind)),
    `② 锁内 not_checked 类别与 submitChecks 真实现场一致（${probe.not_checked.map((r) => r.kind).join("/")}）`,
    { real: probe.not_checked.map((r) => r.kind), workPackage: LOCK_IN_NOT_CHECKED.map((r) => r.kind) },
  );
  ok(
    !probe.checks.some((c) => JSON.stringify(c).includes("clm-does-not-matter")),
    "② 预检也不回显 claim_token（同源安全口径）",
  );

  // ── ②d 机械 / 非机械自检的**真实工具调用**（走写侧彩排闸，不是纯函数断言） ──
  // 按工作包给的前置/条件组真跑：非机械检查不给 command（走 method+证据第二档）合法；
  // 机械检查给 command 就必须 exit_code=0；缺 exit_code 被写侧拒——两侧都真在生效。
  info("── ②d 机械/非机械自检都按工作包提示真调 record_work_evidence（写侧彩排闸真在判）");
  {
    const fxG = makeFixture("wp-guide", [
      { id: "T-1", goal: "证据前置卡", paths: ["src/t1.ts"], checks: ["**chk-wpg-01** 目标达标", "**chk-wpg-02** 第二项目标达标"] },
    ]);
    const hostToken = "work-package-token";
    wpHost = await startWpHost(hostToken);
    writeServiceDescriptor(dataDir, {
      schema_version: 2, pid: process.pid, host: "127.0.0.1", port: (wpHost as { port: number }).port,
      token: hostToken, started_at: new Date().toISOString(), url: `http://127.0.0.1:${(wpHost as { port: number }).port}`,
    });
    const client = new WorkServiceClient({ dataDir, autostart: false });
    // 工作包真的把「先 store(kind=source_manifest)」前置给到接手者（这里就照它做）
    const wpGuide = wpOf(entryOf(fxG, {}, { work_package: true })) as WorkPackageFull;
    const guideSelf = wpGuide?.checks?.find((c) => c.check_id === "chk-wpg-01");
    ok(
      (guideSelf?.next_operation.prerequisites ?? []).some((s) => /source_manifest/.test(s)),
      "②d 新会话只读工作包即可得到 source_manifest 前置（不用读产品实现/源码注释）",
      guideSelf?.next_operation,
    );
    write(path.join(fxG.root, "src/t1.ts"), "export const T1 = 1;\n");
    const fingerprint = buildSourceManifest(fxG.root, ["src/t1.ts"]).fingerprint;
    const stored = await callTool(
      recordWorkEvidenceTool,
      {
        op: "store", project_id: fxG.id, role: "executor", kind: "source_manifest",
        summary: "T-1 覆盖源清单（src/t1.ts）", content: "命令：node verify-t1.mjs\n退出码：0\n输出：ALL PASS（5/5）",
        binding: { revision_kind: "code", revision: fingerprint },
        source_manifest: [{ path: "src/t1.ts" }],
      },
      { work: client },
    );
    const blob = stored.json?.evidence?.sha256 as string;
    const fp = stored.json?.evidence?.source_manifest?.fingerprint as string;
    ok(!stored.isError && /^[0-9a-f]{64}$/.test(blob ?? ""), "②d store(kind=source_manifest) 真调用成功并取回 evidence.sha256", stored.text.slice(0, 260));
    ok(fp === fingerprint, "②d 回执 source_manifest.fingerprint 就是应填 binding.revision 的值", { fp, fingerprint });
    const baseArgs = { op: "self_check", project_id: fxG.id, role: "executor", change_id: CHG, task_id: "T-1", conclusion: "pass" } as const;
    // 非机械：不给 command，走 method + 证据（B4 既定合同，合法）
    const nonMech = await callTool(
      recordWorkEvidenceTool,
      {
        ...baseArgs, record_id: "sc-wpg-nonmech",
        binding: { revision_kind: "code", revision: fp },
        checks: [{ check_id: "chk-wpg-01", verifies: "code", method: "手工核对目标 A 的行为", evidence_sha256: blob }],
      },
      { work: client },
    );
    ok(!nonMech.isError && nonMech.json?.ok === true, "②d 非机械检查（无 command，走 method+证据）真实落账——不逼编命令", nonMech.text.slice(0, 300));
    // 机械：给 command 必须 exit_code=0
    const mech = await callTool(
      recordWorkEvidenceTool,
      {
        ...baseArgs, record_id: "sc-wpg-mech",
        binding: { revision_kind: "code", revision: fp },
        checks: [{ check_id: "chk-wpg-02", verifies: "code", command: "node verify-t1.mjs", exit_code: 0, evidence_sha256: blob }],
      },
      { work: client },
    );
    ok(!mech.isError && mech.json?.ok === true, "②d 机械检查（command + exit_code=0）真实落账", mech.text.slice(0, 300));
    // 机械缺 exit_code ⇒ 写侧彩排闸真拒（条件组另一头也在生效）
    const badMech = await callTool(
      recordWorkEvidenceTool,
      {
        ...baseArgs, record_id: "sc-wpg-bad",
        binding: { revision_kind: "code", revision: fp },
        checks: [{ check_id: "chk-wpg-02", verifies: "code", command: "node verify-t1.mjs", evidence_sha256: blob }],
      },
      { work: client },
    );
    ok(badMech.isError === true && /exit_code|退出码/.test(badMech.text), "②d 机械检查**缺 exit_code** 被写侧拒（零字节；条件组真在判）", badMech.text.slice(0, 300));
    // 两条真实自检经正式采信通路生效（证据指向 source_manifest 载体）
    const afterG = wpOf(entryOf(fxG, {}, { work_package: true })) as WorkPackageFull;
    const c1 = afterG?.checks?.find((c) => c.check_id === "chk-wpg-01");
    const c2 = afterG?.checks?.find((c) => c.check_id === "chk-wpg-02");
    ok(c1?.effective === "passed" && c1.evidence_refs.includes(blob), "②d 非机械自检经正式采信 ⇒ chk-wpg-01 passed（证据指向源清单载体）", c1);
    ok(c2?.effective === "passed", "②d 机械自检经正式采信 ⇒ chk-wpg-02 passed（带命令与退出码也采信）", c2);
  }

  // ── ③ 定义重排不按序号继承通过（指纹按稳定键） ──
  info("── ③ 定义重排：指纹不换身份、effective 按 check_id 取");
  const swapped = planText("wp-a 施工图", [
    { id: "T-1", goal: "一号目标", paths: ["src/t1.ts"], checks: ["**chk-wp-02** 非作者复核：目标 B 达标", "**chk-wp-01** 目标 A 达标"] },
    { id: "T-2", goal: "无关任务", checks: ["**chk-wp-09** 别的卡达标"] },
  ]);
  const origDefs = fx.defs;
  const swappedDefs = importTaskDefinitions(swapped, { plan_revision: sha256(swapped) }).definitions;
  const origT1 = origDefs.find((d) => d.task_id === "T-1")!;
  const swappedT1 = swappedDefs.find((d) => d.task_id === "T-1")!;
  const fpByid = (d: TaskDefinition): Record<string, string> =>
    Object.fromEntries(stableCheckDefinitionsOf(d).map((x) => [x.check_id, x.definition_fingerprint]));
  const fpOrig = fpByid(origT1);
  const fpSwap = fpByid(swappedT1);
  ok(
    fpOrig["chk-wp-01"] === fpSwap["chk-wp-01"] && fpOrig["chk-wp-02"] === fpSwap["chk-wp-02"],
    "③ 重排检查项顺序**不改变**稳定键的定义指纹（不按序号继承）",
    { orig: fpOrig, swapped: fpSwap },
  );
  ok(
    fpOrig["chk-wp-01"] !== fpOrig["chk-wp-02"],
    "③ 不同 check 的指纹不同（身份可区分）",
    fpOrig,
  );

  // ── ④ 源变使旧包失效 + 旧游标显式拒绝（不静默返回跨版本） ──
  info("── ④ 定义/源变 ⇒ 旧包与旧游标失效、给重读入口");
  const page1 = entryOf(fx, {}, { work_package: true, work_package_paging: { limit: 1 } });
  const wpPage1 = wpOf(page1) as WorkPackageFull;
  ok(isOkWp(wpPage1) && wpPage1.paging.complete === false && typeof wpPage1.paging.cursor === "string", "④ limit=1 ⇒ paging=true/false+opaque cursor", wpPage1.paging);
  const oldCursor = wpPage1.paging.cursor as string;
  const oldRev = wpPage1.package_revision;
  // 施工图源变（定义区外的一行注释：内容哈希变 ⇒ 包版本变；定义哈希不变 ⇒ 卡定义与对齐不受影响）
  fs.writeFileSync(fx.planFile, "<!-- 源变了 -->\n" + fx.planText, "utf8");
  const entryAfter = entryOf(fx, {}, { work_package: true });
  const wpAfter = wpOf(entryAfter) as WorkPackageFull;
  ok(
    isOkWp(wpAfter) && wpAfter.package_revision !== oldRev,
    `④ 源变 ⇒ package_revision 变（${oldRev.slice(0, 8)}… → ${(wpAfter as any)?.package_revision?.slice(0, 8)}…）`,
    { oldRev, newRev: (wpAfter as any)?.package_revision },
  );
  const stale = entryOf(fx, {}, { work_package: true, work_package_paging: { cursor: oldCursor, limit: 1 } });
  const staleWp = wpOf(stale) as WorkPackageFailure;
  ok(
    isFailWp(staleWp) && staleWp.code === "REVISION_CHANGED" && typeof staleWp.next_read === "string" && staleWp.next_read.length > 0,
    "④ 旧游标跨版本 ⇒ **显式** REVISION_CHANGED + 重读入口（不静默返回跨版本数据）",
    staleWp,
  );
  // 恢复原施工图（逐字节），后续用例用干净现场
  fs.writeFileSync(fx.planFile, fx.planText, "utf8");
  const restored = entryOf(fx, {});
  ok(restored.baseline.source_changed_since_baseline === false && restored.next_action === "claim_task", "④ 恢复原施工图 ⇒ 现场有效、可领取", { a: restored.next_action });

  // ── ⑤ 幂等：同事实三读一致、不写账 ──
  info("── ⑤ 幂等：同事实三次读返回同一包、不追加事件");
  const hBefore = eventsHash(fx);
  const reads = [0, 1, 2].map(() => JSON.stringify(wpOf(entryOf(fx, {}, { work_package: true }))));
  ok(reads[0] === reads[1] && reads[1] === reads[2], "⑤ 同事实三次读 ⇒ 工作包逐字节一致（幂等，无时间戳漂移）");
  ok(eventsHash(fx) === hBefore, "⑤ 只读：三次读工作包 events.jsonl 逐字节不变（不记账）");
  const actionIds = [0, 1, 2].map(() => (wpOf(entryOf(fx, {}, { work_package: true })) as WorkPackageFull).continuation.action_id);
  ok(actionIds[0] === actionIds[1] && actionIds[1] === actionIds[2], "⑤ continuation.action_id 幂等（同事实同动作）");

  // ── ⑥ 两模式同形 + unsupported 显式 ──
  info("── ⑥ direct_tatai / coordinator_managed 同形；不可用工具显式 unsupported");
  const direct = entryOf(fx, { role: "executor", client_capabilities: "continuable" }, { work_package: true });
  const coord = entryOf(fx, { role: "coordinator", client_capabilities: "coordination" }, { work_package: true });
  const wpDirect = wpOf(direct) as WorkPackageFull;
  const wpCoord = wpOf(coord) as WorkPackageFull;
  ok(isOkWp(wpDirect) && isOkWp(wpCoord), "⑥ 两模式都拿到工作包");
  ok(wpDirect.source_mode === "direct_tatai", `⑥ 执行者直连 ⇒ source_mode=${wpDirect.source_mode}`);
  ok(wpCoord.source_mode === "coordinator_managed", `⑥ 协调者 ⇒ source_mode=${wpCoord.source_mode}`);
  ok(
    wpDirect.package_revision === wpCoord.package_revision &&
      JSON.stringify(wpDirect.checks) === JSON.stringify(wpCoord.checks) &&
      JSON.stringify(wpDirect.completion) === JSON.stringify(wpCoord.completion),
    "⑥ 两模式**同形同判据**（package_revision / checks / completion 一致）",
  );
  const ro = entryOf(fx, { client_capabilities: undefined }, { work_package: true });
  const wpRo = wpOf(ro) as WorkPackageFull;
  ok(isOkWp(wpRo) && wpRo.unsupported.length > 0, `⑥ 只读调用方 ⇒ 显式 unsupported（${(wpRo as any)?.unsupported?.map((u: any) => u.tool).join("/")}）`, (wpRo as any)?.unsupported);
  ok(
    isOkWp(wpRo) && wpRo.unsupported.every((u) => u.reason.includes("不回退")),
    "⑥ unsupported 理由写明「不回退写路由」",
    (wpRo as any)?.unsupported,
  );

  // ── ⑦ 旧客户端兼容：旧字段逐字保留 + 新字段缺失如实标注 ──
  info("── ⑦ 旧客户端兼容：九字段默认契约不变；task_brief 带新字段且旧字段无损");
  const plain = entryOf(fx, {});
  ok(
    JSON.stringify(Object.keys(plain)) === JSON.stringify([...PROJECT_ENTRY_RESULT_FIELDS]),
    "⑦ 默认（不 opt-in）入口**恰好九字段**——旧客户端契约不变",
    Object.keys(plain),
  );
  const withWp = entryOf(fx, {}, { work_package: true });
  ok(
    JSON.stringify(plain.next_action) === JSON.stringify(withWp.next_action) &&
      JSON.stringify(plain.reasons) === JSON.stringify(withWp.reasons) &&
      JSON.stringify(plain.required_reads) === JSON.stringify(withWp.required_reads),
    "⑦ opt-in 工作包**不改** next_action/reasons/required_reads（现有 project_entry 优先级保留）",
  );
  const brief = await callTool(taskBriefTool, { project_id: fx.id, role: "executor", client_capabilities: CONTINUABLE, detail: "full" });
  ok(!brief.isError && brief.json?.work_package_status === "ok" && isOkWp(brief.json?.work_package), `⑦ task_brief 带 work_package（status=${brief.json?.work_package_status}）`, brief.json?.work_package_status);
  ok(
    Array.isArray(brief.json?.reasons) &&
      Array.isArray(brief.json?.required_reads) &&
      "next_action" in brief.json &&
      "baseline" in brief.json &&
      "current_runs" in brief.json &&
      "graph" in brief.json &&
      "omitted" in brief.json,
    "⑦ 旧字段逐字保留（reasons/required_reads/next_action/baseline/current_runs/graph/omitted）",
    Object.keys(brief.json ?? {}),
  );
  const briefSummary = await callTool(taskBriefTool, { project_id: fx.id, role: "executor", client_capabilities: CONTINUABLE });
  ok(
    briefSummary.json?.detail === "summary" && isOkWp(briefSummary.json?.work_package),
    "⑦ 默认 summary 也带 work_package（逐 check 材料给到常规接续入口）",
    briefSummary.json?.detail,
  );

  // ── ⑧ 源缺失 fail-closed：删 DESIGN/PLAN 阻断，无关源不影响 ──
  info("── ⑧ 源缺失 fail-closed（删 DESIGN 阻断；无关源不连坐）");
  const beforeDel = entryOf(fx, {});
  ok(beforeDel.next_action === "claim_task" && beforeDel.baseline.source_changed_since_baseline === false, "⑧ 前置：源在时基线有效、可领取", { a: beforeDel.next_action, s: beforeDel.baseline.source_changed_since_baseline });
  // 无关源变化：加一个仓库内无关文件——**不得**连坐
  write(path.join(fx.root, "src", "unrelated.ts"), "export const x = 1;\n");
  const withUnrelated = entryOf(fx, {});
  ok(
    withUnrelated.baseline.source_changed_since_baseline === false && withUnrelated.next_action === "claim_task",
    "⑧ 无关源（新增 src/unrelated.ts）**不**改基线有效性、不阻断（与删 DESIGN 明确不同）",
    { s: withUnrelated.baseline.source_changed_since_baseline, a: withUnrelated.next_action },
  );
  // 删 DESIGN
  const designBackup = fs.readFileSync(fx.designFile);
  fs.rmSync(fx.designFile);
  const noDesign = entryOf(fx, {}, { work_package: true });
  ok(
    noDesign.next_action === "blocked" && noDesign.baseline.source_changed_since_baseline === true && noDesign.baseline.valid === false,
    "⑧ 删 DESIGN ⇒ blocked + source_changed=true + valid=false（**读不到不等于没变**，fail-closed）",
    { a: noDesign.next_action, s: noDesign.baseline.source_changed_since_baseline, v: noDesign.baseline.valid },
  );
  ok(
    (noDesign.reasons ?? []).some((r: any) => r.code === "impact_unknown" && r.blocking === true),
    "⑧ 删 DESIGN 的理由如实标 impact_unknown（blocking）",
    (noDesign.reasons ?? []).map((r: any) => r.code),
  );
  fs.writeFileSync(fx.designFile, designBackup);
  // 删 PLAN
  const planBackup = fs.readFileSync(fx.planFile);
  fs.rmSync(fx.planFile);
  const noPlan = entryOf(fx, {}, { work_package: true });
  ok(
    noPlan.next_action === "blocked" && noPlan.baseline.source_changed_since_baseline === true,
    "⑧ 删 PLAN ⇒ 同样 blocked + source_changed=true",
    { a: noPlan.next_action, s: noPlan.baseline.source_changed_since_baseline },
  );
  // 无当前任务分支：删 PLAN 后 blocked 且选不到任务 ⇒ 工作包 checks 空、**不按空集「全通过」**
  const nw = wpOf(noPlan);
  ok(
    isOkWp(nw) && nw.task_id === "" && nw.checks.length === 0 && nw.completion.satisfied === false && nw.completion.blocking_findings.length > 0,
    "⑧ 无当前任务 ⇒ 空 checks，completion 不 satisfied，blocking_findings 逐条点名（不按空集合全通过）",
    nw === null ? null : { task_id: (nw as any).task_id, completion: (nw as any).completion },
  );
  fs.writeFileSync(fx.planFile, planBackup);
  const recovered = entryOf(fx, {});
  ok(recovered.next_action === "claim_task" && recovered.baseline.valid === true, "⑧ 恢复两份源 ⇒ 现场恢复可领取、基线有效", { a: recovered.next_action });

  // ── ⑨ 边界反例：limit 越界 ──
  info("── ⑨ 边界反例");
  const badLimit = entryOf(fx, {}, { work_package: true, work_package_paging: { limit: WORK_PACKAGE_LIMIT_MAX + 1 } });
  ok(isFailWp(wpOf(badLimit)) && (wpOf(badLimit) as WorkPackageFailure).code === "INVALID_INPUT", "⑨ limit 越界 ⇒ INVALID_INPUT（不静默夹取）", wpOf(badLimit));
} finally {
  try {
    wpHost?.close();
  } catch {
    /* 收尾失败不影响结论 */
  }
  try {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  } catch {
    /* 收尾失败不影响结论 */
  }
}

console.log(`\n[verify] 小结：PASS ${passCount}，FAIL ${failCount}`);
if (failCount > 0) {
  console.log("[verify] 结果: 有 FAIL——退出码 1");
  process.exitCode = 1;
} else {
  console.log("[verify] 结果: 全部 PASS");
  process.exitCode = 0;
}
