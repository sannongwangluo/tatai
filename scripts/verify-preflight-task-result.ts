// P2 / V09-47 验证脚本（PLAN 卡 V09-47；DESIGN §6.7/§6.11；docs/agent-optimization-20261006.md §6）。
// 用法：D:/tatai/node_modules/.bin/tsx.cmd scripts/verify-preflight-task-result.ts
//
// 自带隔离环境：临时 `TATAI_HOME` + `os.tmpdir()` 下的夹具项目，**不碰**任何真实项目/账本/生产服务。
// 覆盖（先红后绿；P2 最终纠正后按现状如实写）：
//   ① 一致 + 一次列清：冻结输入下**预检与真实提交的失败项逐条逐序相符**；多缺项一次列全（逐项 kind/status/expected/actual/source_ref/remediation）；
//   ② 零写入（字节级）+ 幂等短路：调用前后 `.工作台/work` 树哈希**逐字节不变**；已提交 → already_submitted＋原回执（checks 未重查）；
//   ③ 秘密完全隐藏：claim_token（含前缀）不出现在预检输出/错误文本（含阶段上报文案的同类纠正）；
//   ④ 变化仍拒：预检→提交之间 版本/租约/定义 变后提交仍拒（预检不产生通行票）；
//   ⑤ 直写拒 + **helper 语义**：通用命令直写 task.result_submitted（删/空/错 token、空证据）一律锁内拒且零字节；
//      `submitTaskStatus(result_submitted)` **保留原事件语义**（产出 task.result_submitted）因此照样被拒——产品 helper
//      不为夹具让路；只造**历史/迁移状态**的夹具走既有状态边界 `task.status_changed`（标记：不测试新交付）；
//   ⑥ 不假装已核：未执行/锁内特有项只列 not_checked；不适用逐条 not_applicable（两类不混用）；
//   ⑦ 证据源四态：带 source_manifest 的证据源漂移即拒旧；无载体如实 legacy_unbound（不冒充 valid）；单列逐项差异与修复位置；
//   ⑧ 宿主只读路由 + 能力协商：`POST /api/work/preflight` 零写入；旧宿主 unsupported、缺宿主 unavailable，**绝不回退**提交；公开 now 明确拒；
//   ⑨ 提交路径 schema 不变：preflight 与 submit 复用**同一个** inputSchema、必填逐字不变、无 now；
//   ⑩ 入参校验按公开 schema（闭键/类型/必填）：unknown/now/负版本/非字符串数组，以及**显式给错的类型**
//      （verification 非对象项、缺/错 command/exit_code、owner_id 显式非字符串）一律如实拒（宿主/HTTP/MCP 实测反例）；合法省略 owner_id 仍等价；
//   ⑪ 预检 → 锁内：依赖变化在锁内按锁内事件重核（直写也拒、零字节）；
//   ⑫ 旧历史读兼容：账本里既有的无 token result_submitted 仍照常折叠/读回。
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { addProject } from "../src/server/registry";
import { projectWorkDir } from "../src/server/workstation";
import { activateBaseline } from "../src/server/work/documents";
import { putEvidence } from "../src/server/work/evidence";
import { importTaskDefinitions, type TaskDefinition } from "../src/server/work/plan";
import { claimTask, readClaimEvents, renewClaim, submitTaskResult, verifyTaskPhaseCommand, type SubmitResultInput } from "../src/server/work/claims";
import { readTaskStates, submitDefinitionImports, submitTaskStatus } from "../src/server/work/tasks";
import { submitSelfCheck, submitSubmission } from "../src/server/work/audit";
import { buildSourceManifest } from "../src/server/work/sourceEvidence";
import {
  handleWorkRequest,
  removeServiceDescriptor,
  WORK_TOKEN_HEADER,
  WorkService,
  WorkServiceClient,
  writeServiceDescriptor,
} from "../src/server/work/service";
import {
  evaluateSubmitResultChecks,
  parseResultSubmitInput,
  RESULT_SUBMIT_INPUT_KEYS,
  RESULT_SUBMIT_REQUIRED_KEYS,
  type SubmitResultChecksInput,
} from "../src/server/work/submitChecks";
import { SUBMIT_TASK_RESULT_SCHEMA, submitTaskResultTool } from "../src/mcp/tools/projectEntry";
import { preflightTaskResultTool } from "../src/mcp/tools/preflightTaskResult";

// ── 断言与日志 ──
let passCount = 0;
let failCount = 0;
const ok = (cond: boolean, label: string, detail?: unknown) => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (cond) passCount++;
  else {
    failCount++;
    process.exitCode = 1;
    if (detail !== undefined) console.log(`[verify]   现场：${JSON.stringify(detail).slice(0, 1500)}`);
  }
};
const section = (t: string) => console.log(`\n[verify] ── ${t}`);
const sha256 = (b: string | Buffer): string => crypto.createHash("sha256").update(b).digest("hex");

// ── 隔离环境 ──
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-p2-preflight-"));
const dataDir = path.join(tmpBase, "home");
fs.mkdirSync(dataDir, { recursive: true });
process.env.TATAI_HOME = dataDir;
const service = new WorkService({ dataDir });
const CHG = "chg-p2";
const executor = "kimi-code";
const REL_EVIDENCE = "evidence/out.txt";

const write = (f: string, text: string) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text, "utf8");
};

interface Card {
  id: string;
  goal: string;
  dep?: string;
}
function planText(title: string, cards: Card[]): string {
  const lines = ["# " + title, "", "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |", "| --- | --- | --- | --- | --- |"];
  for (const c of cards) lines.push(`| ${c.id} | todo | ${c.goal} | ${c.dep ?? ""} | ${c.id} 的完成证据 |`);
  lines.push("");
  for (const c of cards) {
    lines.push(`### ${c.id} ${c.goal}`, "");
    lines.push(`**设计依据**：§1。**依赖**：${c.dep ?? "无"}。**文件责任**：\`src/${c.id.toLowerCase()}.ts\`。`);
    lines.push("", `- [ ] ${c.goal} 达标`, "");
  }
  return lines.join("\n");
}

interface Fixture {
  id: string;
  root: string;
  workDir: string;
  plan: string;
  defs: TaskDefinition[];
}
function makeFixture(id: string, cards: Card[]): Fixture {
  const root = path.join(tmpBase, id);
  fs.mkdirSync(path.join(root, ".工作台"), { recursive: true });
  write(path.join(root, ".工作台", "design.md"), `# ${id} 设计书\n\n## 1 目标\n\n夹具设计正文。\n`);
  const plan = planText(`${id} 施工图`, cards);
  write(path.join(root, ".工作台", "plan.md"), plan);
  write(path.join(root, REL_EVIDENCE), `evidence for ${id}\n`);
  addProject({ id, name: `P2 夹具 ${id}`, path: root, kind: "backend" }, dataDir);
  const imported = importTaskDefinitions(plan, { plan_revision: sha256(plan) });
  activateBaseline(id, { approved_by: "user", approval_basis: "P2 夹具审定", approval_kind: "user_confirmed" }, dataDir);
  submitDefinitionImports(service, { project_id: id, change_id: CHG, actor_id: executor, role: "executor", definitions: imported.definitions });
  return { id, root, workDir: projectWorkDir(id, dataDir), plan, defs: imported.definitions };
}

const revOf = (fx: Fixture, taskId: string): number => readTaskStates(fx.workDir).states[taskId]?.revision ?? 0;

async function claim(fx: Fixture, taskId: string, owner = executor, leaseMs?: number) {
  const outcome = await claimTask(
    {
      project_id: fx.id,
      task_id: taskId,
      role: "executor",
      owner_id: owner,
      change_id: CHG,
      expected_revision: revOf(fx, taskId),
      ...(leaseMs === undefined ? {} : { lease_ms: leaseMs }),
    },
    service,
    dataDir,
  );
  if (!outcome.ok) throw new Error(`夹具缺陷：领取 ${taskId} 失败：${outcome.message}`);
  return { token: outcome.claim.claim_token, revision: outcome.claim.entity_revision, lease: outcome.claim.lease_expires_at };
}

function treeHashes(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    if (!fs.existsSync(d)) return;
    for (const name of fs.readdirSync(d).sort()) {
      const abs = path.join(d, name);
      if (fs.statSync(abs).isDirectory()) walk(abs);
      else out[path.relative(dir, abs).replace(/\\/g, "/")] = sha256(fs.readFileSync(abs));
    }
  };
  walk(dir);
  return out;
}
const eqTree = (a: Record<string, string>, b: Record<string, string>): boolean => JSON.stringify(a) === JSON.stringify(b);
const stateOf = (fx: Fixture, taskId: string) => readTaskStates(fx.workDir).states[taskId] ?? null;

function intentOf(
  fx: Fixture,
  taskId: string,
  token: string,
  revision: number,
  extra: Partial<{ evidence_refs: string[]; owner_id: string; now: string; ownership_basis: string; deliverables: string[] }> = {},
): SubmitResultInput {
  return {
    project_id: fx.id,
    task_id: taskId,
    role: "executor",
    owner_id: extra.owner_id ?? executor,
    change_id: CHG,
    claim_token: token,
    expected_revision: revision,
    evidence_refs: extra.evidence_refs ?? [REL_EVIDENCE],
    deliverables: extra.deliverables ?? [],
    verification: [],
    untested: [],
    known_issues: [],
    ...(extra.now === undefined ? {} : { now: extra.now }),
    ...(extra.ownership_basis === undefined ? {} : { ownership_basis: extra.ownership_basis }),
  };
}

const isWorkError = (e: unknown): e is { code: string; detail: Record<string, unknown> } =>
  typeof e === "object" && e !== null && "code" in e && "detail" in e;

/**
 * 让一张卡走到"验证通过"（真提交结果 + 自检证据，绑定可核对的源清单）——用来造"依赖已释放"的现场。
 * 与 verify-v06-10 的夹具同一口径（同一份判据的来源）。
 *
 * **P2 最终纠正（同根因）**：这里是**真实结果场景**，按设计走**合法认领 + 真证据**的结果提交
 * （`claimTask` → `submitTaskResult`），不再借 `submitTaskStatus` 的"只置状态"口径冒充交付。
 * `task.result_submitted` 是一条**交付提交**事件：锁内共享判据要求当前认领 token + 可追溯证据，
 * 夹具按设计补真认领/真证据，而不是要求产品放宽校验。
 */
async function makeGreen(fx: Fixture, taskId: string): Promise<void> {
  const def = fx.defs.find((d) => d.task_id === taskId);
  if (def === undefined) throw new Error(`夹具缺陷：没有 ${taskId} 的定义`);
  const srcRel = `src/green-${taskId.toLowerCase()}.ts`;
  write(path.join(fx.root, srcRel), `export const ${taskId.replace(/[^A-Za-z0-9]/g, "_")}_OK = true;\n`);
  const manifestFp = buildSourceManifest(fx.root, [srcRel]).fingerprint;
  const blob = putEvidence(fx.workDir, {
    content: "",
    kind: "source_manifest",
    summary: `${taskId} 源清单（覆盖 ${srcRel}）`,
    created_by: executor,
    role: "executor",
    binding: { revision_kind: "code", revision: manifestFp },
    source_manifest: [srcRel],
  });
  submitSubmission(service, {
    project_id: fx.id,
    change_id: CHG,
    actor_id: executor,
    role: "executor",
    record_id: `sub-${taskId}`,
    task_id: taskId,
    goal: def.goal ?? taskId,
    binding: { revision_kind: "code", revision: manifestFp },
    evidence_refs: [blob.sha256],
    changed_files: def.allowed_paths,
    submitted_by: executor,
  });
  const checks = (def.acceptance?.checks ?? []).map((c, i) => ({
    check_id: `${taskId}::check:${i}`,
    method: c.text,
    evidence_sha256: blob.sha256,
    verifies: "code" as const,
  }));
  if (def.evidence_requirement !== null && def.evidence_requirement !== "") {
    checks.push({ check_id: `${taskId}::evidence`, method: def.evidence_requirement, evidence_sha256: blob.sha256, verifies: "code" as const });
  }
  submitSelfCheck(service, {
    project_id: fx.id,
    change_id: CHG,
    actor_id: executor,
    role: "executor",
    record_id: `sc-${taskId}`,
    task_id: taskId,
    checked_by: executor,
    checks,
    conclusion: "pass",
    binding: { revision_kind: "code", revision: manifestFp },
  });
  // 真实结果交付：先按原子认领拿到当前 token，再带真证据提交（与 §6.7 主链同一路径）。
  const claimed = await claim(fx, taskId);
  const submitted = await submitTaskResult(
    {
      project_id: fx.id,
      task_id: taskId,
      role: "executor",
      owner_id: executor,
      change_id: CHG,
      claim_token: claimed.token,
      expected_revision: claimed.revision,
      deliverables: [`${taskId} 夹具交付物`],
      evidence_refs: [blob.sha256],
      verification: [{ command: "node -e fixture", exit_code: 0, output_ref: `evidence:${blob.sha256}` }],
      untested: [],
      known_issues: [],
    },
    { submitter: service },
    dataDir,
  );
  if (!submitted.ok) {
    throw new Error(`夹具缺陷：${taskId} 真实结果提交失败：${JSON.stringify(submitted).slice(0, 400)}`);
  }
}

/** 直接调宿主唯一实现（等价于 `POST /api/work/preflight`，不入库 HTTP），供无需 HTTP 的断言复用 */
function hostPreflight(
  fx: Fixture,
  c: { token: string; revision: number },
  extra: { deliverables?: string[]; now?: unknown } = {},
  taskId = "T-1",
) {
  return service.preflightResult({
    project_id: fx.id,
    task_id: taskId,
    role: "executor",
    owner_id: executor,
    change_id: CHG,
    claim_token: c.token,
    expected_revision: c.revision,
    evidence_refs: [REL_EVIDENCE],
    deliverables: extra.deliverables ?? [],
    verification: [],
    untested: [],
    known_issues: [],
    ...(extra.now === undefined ? {} : { now: extra.now }),
  });
}

async function main(): Promise<void> {
  // ═══════════════════ ① 一致 + 一次列清 ═══════════════════
  section("① 冻结输入：预检判据与真实提交失败项相符（A2-一致 / A2-一次列清）");
  {
    const fx = makeFixture("p2a", [
      { id: "T-1", goal: "无依赖卡" },
      { id: "T-2", goal: "依赖 T-1 的卡", dep: "T-1" },
    ]);
    const c = await claim(fx, "T-1");
    const bad = intentOf(fx, "T-1", c.token, c.revision + 5, { evidence_refs: [], owner_id: "someone-else" });
    const pre = evaluateSubmitResultChecks(bad, stateOf(fx, "T-1"), { dataDir });
    ok(!pre.ok && pre.failures.length >= 3, "①-1 多缺项在一次响应里列清（≥3 条 failures）", pre.failures);
    ok(pre.code === "VERSION_CONFLICT", "①-2 失败码取首因 VERSION_CONFLICT（检查顺序不变）", pre.code);
    ok(
      pre.checks.every(
        (r) =>
          typeof r.kind === "string" &&
          typeof r.status === "string" &&
          "expected" in r &&
          "actual" in r &&
          "source_ref" in r &&
          "remediation" in r,
      ),
      "①-3 逐项含 kind/status/expected/actual/source_ref/remediation",
    );
    const failedKinds = pre.checks.filter((r) => r.status === "failed").map((r) => r.kind).sort();
    ok(failedKinds.includes("task_version") && failedKinds.includes("claim_owner"), "①-4 失败项逐条点名（task_version + claim_owner）", failedKinds);

    const sub = await submitTaskResult(bad, { submitter: service }, dataDir);
    ok(!sub.ok, "①-5 同一冻结输入：真实提交也被拒", sub.ok);
    if (!sub.ok) {
      ok(sub.code === "VERSION_CONFLICT", "①-6 提交失败码与预检一致", sub.code);
      ok(JSON.stringify(sub.failures) === JSON.stringify(pre.failures), "①-7 提交失败项与预检**逐条逐序**相符", { pre: pre.failures, sub: sub.failures });
    }

    // 依赖未释放：合成一张 T-2 的"已认领"状态（一切除依赖外都过），逐项列清为 DEPENDENCY_UNMET
    const synthetic = {
      revision: 1,
      status: "claimed" as const,
      cancelled: false,
      cancel_reason: null,
      owner_id: executor,
      claim_token: "syn-token",
      lease_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      definition_sha256: null,
      definition_change_id: null,
    };
    const dep = evaluateSubmitResultChecks(intentOf(fx, "T-2", "syn-token", 1), synthetic, { dataDir });
    ok(!dep.ok && dep.code === "DEPENDENCY_UNMET", "①-8 依赖未释放 ⇒ 唯一失败项为 DEPENDENCY_UNMET", dep.failures);
    ok(dep.checks.some((r) => r.kind === "dependencies" && r.status === "failed"), "①-9 依赖项逐条列为 failed（dependencies）", dep.checks.filter((r) => r.kind === "dependencies"));
  }

  // ═══════════════════ ② 零写入（字节级）+ 幂等前置 ═══════════════════
  section("② 零写入（字节级）+ 幂等前置");
  {
    const fx = makeFixture("p2b", [{ id: "T-1", goal: "结果卡" }]);
    const c = await claim(fx, "T-1");
    const before = treeHashes(fx.workDir);
    const pre = evaluateSubmitResultChecks(intentOf(fx, "T-1", c.token, c.revision), stateOf(fx, "T-1"), { dataDir });
    ok(pre.ok, "②-1 正常输入预检通过（would_pass）", pre.failures);
    const after = treeHashes(fx.workDir);
    ok(eqTree(before, after), "②-2 预检调用前后 `.工作台/work` 树哈希**逐字节不变**", { before: Object.keys(before).length, after: Object.keys(after).length });

    const r1 = await submitTaskResult(intentOf(fx, "T-1", c.token, c.revision), { submitter: service }, dataDir);
    ok(r1.ok, "②-3 真实提交成功", r1.ok ? null : r1);
    const resultEvents1 = fs.readFileSync(path.join(fx.workDir, "events.jsonl"), "utf8").split("\n").filter((l) => l.includes("task.result_submitted"));
    ok(resultEvents1.length === 1, "②-4 首次提交只产生一个结果事件", resultEvents1.length);

    const r2 = await submitTaskResult(intentOf(fx, "T-1", c.token, c.revision), { submitter: service }, dataDir);
    ok(r2.ok && r2.receipt.duplicate === true, "②-5 同键同内容重发 → duplicate 原回执", r2.ok ? r2.receipt.duplicate : r2);
    const resultEvents2 = fs.readFileSync(path.join(fx.workDir, "events.jsonl"), "utf8").split("\n").filter((l) => l.includes("task.result_submitted"));
    ok(resultEvents2.length === 1, "②-6 幂等重试不产生第二个结果事件（提交侧只一个）", resultEvents2.length);

    const preDup = hostPreflight(fx, c);
    ok(preDup.already_submitted !== null, "②-7 预检命中已提交 → already_submitted 非空");
    ok(preDup.already_submitted !== null && preDup.already_submitted.duplicate === true && preDup.already_submitted.event_id !== "", "②-8 already_submitted 带原事件回执（event_id/seq）", preDup.already_submitted);
    ok(
      preDup.already_submitted !== null && (preDup.already_submitted.result_summary.evidence_refs as string[] | undefined)?.length === 1,
      "②-8b already_submitted 带原提交的非秘密交付摘要（恢复原回执）",
      preDup.already_submitted?.result_summary,
    );
    ok(
      preDup.checks_rechecked === false && preDup.checks.length === 0,
      "②-9 已提交预检**没有重跑五查**（checks_rechecked=false、checks 空），不冒充通过/失败",
      { rechecked: preDup.checks_rechecked, checks: preDup.checks.length },
    );
    ok(preDup.would_pass === null, "②-9b 未重查时 would_pass=null（不把旧提交的版本/状态失败当当前结论）", preDup.would_pass);
    ok(
      preDup.not_checked.some((r) => r.kind === "idempotency_short_circuit"),
      "②-9c not_checked 明示 idempotency_short_circuit（未重查）",
      preDup.not_checked,
    );
    ok(preDup.idempotency_status === "already_submitted", "②-10 idempotency_status=already_submitted", preDup.idempotency_status);

    const preConflict = hostPreflight(fx, c, { deliverables: ["另一份交付物"] });
    ok(preConflict.idempotency_status === "conflict", "②-11 预检同键异内容 → conflict", preConflict.idempotency_status);
    ok(preConflict.rejection_code === "IDEMPOTENCY_CONFLICT", "②-12 conflict 的 rejection_code=IDEMPOTENCY_CONFLICT", preConflict.rejection_code);
    ok(
      preConflict.checks_rechecked === false && preConflict.checks.length === 0 && preConflict.would_pass === null,
      "②-12b conflict 同样不重跑五查（checks 空、would_pass=null）",
      { rechecked: preConflict.checks_rechecked, wp: preConflict.would_pass },
    );

    // 已提交后 PLAN/证据读不出来，也必须能恢复原回执（把 plan.md 与证据文件移走再预检）
    const planPath = path.join(fx.root, ".工作台", "plan.md");
    const planBackup = fs.readFileSync(planPath, "utf8");
    const evAbs = path.join(fx.root, REL_EVIDENCE);
    const evBackup = fs.readFileSync(evAbs, "utf8");
    fs.rmSync(planPath);
    fs.rmSync(evAbs);
    let preDup2: ReturnType<typeof hostPreflight> | null = null;
    try {
      preDup2 = hostPreflight(fx, c);
    } catch (e) {
      console.log(`[verify]   （PLAN/证据缺失时预检抛错：${e instanceof Error ? e.message : String(e)}）`);
    }
    ok(
      preDup2 !== null &&
        preDup2.idempotency_status === "already_submitted" &&
        preDup2.already_submitted?.event_id === preDup.already_submitted?.event_id,
      "②-13 已提交后 PLAN/证据不可读，仍恢复原回执（幂等短路不读 PLAN/证据）",
      preDup2 === null ? "threw" : { status: preDup2.idempotency_status, ev: preDup2.already_submitted?.event_id },
    );
    write(planPath, planBackup);
    write(evAbs, evBackup);
  }

  // ═══════════════════ ③ 秘密完全隐藏 ═══════════════════
  section("③ 秘密完全隐藏（claim_token 含前缀不出现在预检输出/错误文本）");
  {
    const fx = makeFixture("p2c", [{ id: "T-1", goal: "秘密卡" }]);
    const c = await claim(fx, "T-1");
    const prefix = c.token.slice(0, 12);
    const preOkJson = JSON.stringify(hostPreflight(fx, c));
    ok(!preOkJson.includes(c.token), "③-1 预检成功响应不含完整 claim_token");
    ok(!preOkJson.includes(prefix), "③-2 预检成功响应不含 token 前缀");
    const bad = evaluateSubmitResultChecks(intentOf(fx, "T-1", "clm-not-the-real-token", c.revision), stateOf(fx, "T-1"), { dataDir });
    const badJson = JSON.stringify(bad);
    ok(!bad.ok && !badJson.includes(c.token) && !badJson.includes(prefix), "③-3 认领不符的失败文本不回显现场 token（含前缀）", bad.failures);
    // ③-6 同类纠正：阶段上报（report_phase=doing）认领不符的文案也不回显现场 token 前缀
    const phaseFail = verifyTaskPhaseCommand(
      readClaimEvents(fx.workDir),
      {
        entity_id: "task:T-1",
        type: "task.status_changed",
        role: "executor",
        actor_id: executor,
        payload: { report_phase: "doing", claim_token: "clm-wrong-token", owner_id: executor },
      },
      { projectRoot: fx.root, workDir: fx.workDir },
    );
    const phaseJson = JSON.stringify(phaseFail.failures);
    ok(
      !phaseFail.ok && !phaseJson.includes(c.token) && !phaseJson.includes(prefix),
      "③-6 阶段上报认领不符文案不回显现场 token（含前缀，同类安全纠正）",
      phaseFail.failures,
    );
    const sub1 = await submitTaskResult(intentOf(fx, "T-1", c.token, c.revision, { deliverables: ["x"] }), { submitter: service }, dataDir);
    ok(sub1.ok, "③-4 首次提交成功（准备异内容冲突）");
    const conflict = await submitTaskResult(intentOf(fx, "T-1", c.token, c.revision, { deliverables: ["y"] }), { submitter: service }, dataDir);
    const conflictJson = JSON.stringify(conflict);
    ok(!conflict.ok && !conflictJson.includes(c.token) && !conflictJson.includes(prefix), "③-5 幂等冲突文本不回显幂等键/claim_token", !conflict.ok ? conflict.code : conflict);
  }

  // ═══════════════════ ④ 变化仍拒（预检不产生通行票） ═══════════════════
  section("④ 预检→提交之间 版本/租约/定义 变化仍拒");
  {
    // (a) 版本变（续约推进实体版本）
    const fx = makeFixture("p2d", [{ id: "T-1", goal: "版本卡" }]);
    const c = await claim(fx, "T-1");
    ok(evaluateSubmitResultChecks(intentOf(fx, "T-1", c.token, c.revision), stateOf(fx, "T-1"), { dataDir }).ok, "④-1 变化前预检通过");
    const renew = await renewClaim(
      { project_id: fx.id, task_id: "T-1", role: "executor", owner_id: executor, change_id: CHG, claim_token: c.token, expected_revision: c.revision },
      service,
      dataDir,
    );
    ok(renew.ok, "④-2 续约成功（推进实体版本）", renew.ok ? null : renew);
    const subVersion = await submitTaskResult(intentOf(fx, "T-1", c.token, c.revision), { submitter: service }, dataDir);
    ok(!subVersion.ok && subVersion.code === "VERSION_CONFLICT", "④-3 预检后版本变 ⇒ 提交仍拒（VERSION_CONFLICT）", subVersion.ok ? null : subVersion.code);

    // (b) 定义变（编辑 PLAN，不重导定义）
    const fx2 = makeFixture("p2e", [{ id: "T-1", goal: "定义卡" }]);
    const c2 = await claim(fx2, "T-1");
    ok(evaluateSubmitResultChecks(intentOf(fx2, "T-1", c2.token, c2.revision), stateOf(fx2, "T-1"), { dataDir }).ok, "④-4 定义变前预检通过");
    const planPath = path.join(fx2.root, ".工作台", "plan.md");
    write(planPath, fs.readFileSync(planPath, "utf8").replace("定义卡", "定义卡（改）"));
    const subDef = await submitTaskResult(intentOf(fx2, "T-1", c2.token, c2.revision), { submitter: service }, dataDir);
    ok(!subDef.ok && (subDef.failures ?? []).some((f) => f.includes("施工定义")), "④-5 PLAN 定义变后提交仍拒（定义绑定漂移）", subDef.ok ? null : subDef.failures);

    // (c) 租约变（测试时钟推进到到期后，无 ownership_basis）
    const fx3 = makeFixture("p2f", [{ id: "T-1", goal: "租约卡" }]);
    const c3 = await claim(fx3, "T-1", executor, 60_000);
    const t0 = new Date(Date.parse(c3.lease) - 30_000).toISOString();
    const t1 = new Date(Date.parse(c3.lease) + 30_000).toISOString();
    ok(evaluateSubmitResultChecks(intentOf(fx3, "T-1", c3.token, c3.revision, { now: t0 }), stateOf(fx3, "T-1"), { dataDir }).ok, "④-6 租约在效时预检通过");
    const subLease = await submitTaskResult(intentOf(fx3, "T-1", c3.token, c3.revision, { now: t1 }), { submitter: service }, dataDir);
    ok(!subLease.ok && subLease.code === "LEASE_NEEDS_VERIFICATION", "④-7 租约到期后提交拒（LEASE_NEEDS_VERIFICATION）", subLease.ok ? null : subLease.code);
  }

  // ═══════════════════ ⑤ 直写拒 ═══════════════════
  section("⑤ 通用命令直写 task.result_submitted（带认领绑定）不能旁路锁内共享判据");
  {
    const fx = makeFixture("p2g", [
      { id: "T-1", goal: "直写卡" },
      { id: "T-2", goal: "状态边界卡" },
    ]);
    const c = await claim(fx, "T-1");
    const eventsPath = path.join(fx.workDir, "events.jsonl");
    const before = sha256(fs.readFileSync(eventsPath));
    let threw: unknown = null;
    try {
      service.submit({
        schema_version: 2,
        project_id: fx.id,
        change_id: CHG,
        entity_id: "task:T-1",
        expected_revision: c.revision,
        type: "task.result_submitted",
        actor_id: "forger",
        role: "executor",
        idempotency_key: "p2-direct-write-1",
        payload: { claim_token: "clm-forged", owner_id: "forger", owner_role: "executor", evidence_refs: [REL_EVIDENCE], deliverables: [], verification: [], untested: [], known_issues: [] },
      });
    } catch (e) {
      threw = e;
    }
    ok(isWorkError(threw) && threw.code === "INVALID_COMMAND", "⑤-1 直写被拒（INVALID_COMMAND）", threw);
    ok(isWorkError(threw) && threw.detail.reason === "result_submit_lockin_failed", "⑤-2 拒因=result_submit_lockin_failed（锁内共享判据）", isWorkError(threw) ? threw.detail : null);
    ok(sha256(fs.readFileSync(eventsPath)) === before, "⑤-3 直写被拒后 events.jsonl 逐字节不变（零字节落盘）");

    // **P2 返工反例**：删 token / 空 token / 带交付字段省略 token —— 都不能免锁内五查。
    const directWrite = (
      payload: Record<string, unknown>,
      key: string,
      entity = "task:T-1",
      revision: number | null = revOf(fx, "T-1"),
    ): unknown => {
      const before = sha256(fs.readFileSync(eventsPath));
      let threwLocal: unknown = null;
      try {
        service.submit({
          schema_version: 2,
          project_id: fx.id,
          change_id: CHG,
          entity_id: entity,
          expected_revision: revision,
          type: "task.result_submitted",
          actor_id: executor,
          role: "executor",
          idempotency_key: key,
          payload,
        });
      } catch (e) {
        threwLocal = e;
      }
      const zeroByte = sha256(fs.readFileSync(eventsPath)) === before;
      return { threw: threwLocal, zeroByte };
    };
    const isLockinReject = (r: unknown): boolean =>
      typeof r === "object" && r !== null && isWorkError((r as { threw: unknown }).threw) &&
      (r as { threw: { code: string; detail: Record<string, unknown> } }).threw.code === "INVALID_COMMAND" &&
      (r as { threw: { detail: Record<string, unknown> } }).threw.detail.reason === "result_submit_lockin_failed";

    const bare = directWrite({}, "p2-noclaim-bare-1");
    ok(isLockinReject(bare) && (bare as { zeroByte: boolean }).zeroByte, "⑤-4 删掉 claim_token 的 bare result_submitted 不再免检查（锁内拒、零字节）", bare);

    const deliveryNoToken = directWrite({ deliverables: ["x"], evidence_refs: [REL_EVIDENCE] }, "p2-noclaim-delivery-1");
    ok(isLockinReject(deliveryNoToken) && (deliveryNoToken as { zeroByte: boolean }).zeroByte, "⑤-5 带交付字段但省略 token 的 result_submitted 被拒（锁内拒、零字节）", deliveryNoToken);

    const emptyToken = directWrite({ claim_token: "", owner_id: executor, evidence_refs: [REL_EVIDENCE] }, "p2-empty-token-1");
    ok(isLockinReject(emptyToken) && (emptyToken as { zeroByte: boolean }).zeroByte, "⑤-6 空 claim_token 的 result_submitted 被拒（锁内拒、零字节）", emptyToken);

    const badToken = directWrite({ claim_token: "clm-not-mine", owner_id: executor, evidence_refs: [REL_EVIDENCE] }, "p2-badtoken-1");
    ok(isLockinReject(badToken) && (badToken as { zeroByte: boolean }).zeroByte, "⑤-7 非当前认领的 token 被拒（锁内拒、零字节）", badToken);

    // **P2 最终纠正（同根因）**：`submitTaskStatus` 的 `result_submitted` **保留原事件语义**（产出
    // `task.result_submitted`，不再被改成"只置状态"来让旧夹具保持绿）。它没有认领 token、也没有交付证据，
    // 因此**照样被锁内共享判据拒**（零字节）——产品 helper 不为脚本回归让路。
    const beforeHelper = sha256(fs.readFileSync(eventsPath));
    let helperThrew: unknown = null;
    try {
      submitTaskStatus(service, {
        project_id: fx.id,
        task_id: "T-2",
        change_id: CHG,
        actor_id: executor,
        role: "executor",
        expected_revision: revOf(fx, "T-2"),
        status: "result_submitted",
      });
    } catch (e) {
      helperThrew = e;
    }
    ok(
      isLockinReject({ threw: helperThrew, zeroByte: sha256(fs.readFileSync(eventsPath)) === beforeHelper }) &&
        sha256(fs.readFileSync(eventsPath)) === beforeHelper,
      "⑤-8 submitTaskStatus(result_submitted) 仍按原语义产出 task.result_submitted ⇒ 缺认领/证据照样被锁内拒（零字节，helper 不为夹具让路）",
      isWorkError(helperThrew) ? helperThrew.detail : helperThrew,
    );
    ok(
      readTaskStates(fx.workDir).states["T-2"]?.status !== "result_submitted",
      "⑤-8b 被拒后 T-2 状态没有被改成 result_submitted（零字节、没有副作用）",
      readTaskStates(fx.workDir).states["T-2"]?.status,
    );

    // **历史/迁移状态夹具（合法）**：只构造"这张卡历史上是 result_submitted"的**状态**（不测试新交付、
    // 不冒充交付提交）就走**既有迁移链**的同一形态——`task.status_changed` + `payload.status="result_submitted"`，
    // 与 `migrate.ts` 把 v1 `done` 折成 `result_submitted` 逐字同一口径（不带交付包、不宣称判据通过）。
    const beforeHist = sha256(fs.readFileSync(eventsPath));
    const histReceipt = service.submit({
      schema_version: 2,
      project_id: fx.id,
      change_id: CHG,
      entity_id: "task:T-2",
      expected_revision: revOf(fx, "T-2"),
      type: "task.status_changed",
      actor_id: executor,
      role: "executor",
      idempotency_key: "p2-hist-status-result-submitted-1",
      payload: { status: "result_submitted" },
    });
    const statusEvents = fs
      .readFileSync(eventsPath, "utf8")
      .split("\n")
      .filter((l) => l.includes("task.status_changed") && l.includes("task:T-2"));
    ok(
      histReceipt.ok === true &&
        sha256(fs.readFileSync(eventsPath)) !== beforeHist &&
        readTaskStates(fx.workDir).states["T-2"]?.status === "result_submitted" &&
        statusEvents.length === 1,
      "⑤-8c 历史/迁移状态走既有状态边界（task.status_changed + payload.status）仍能只置状态（标记：不测试新交付，不冒充交付提交）",
      { ok: histReceipt.ok, events: statusEvents.length, note: "本项只造历史状态，不测试新交付" },
    );
    // 该历史状态**不**产出任何交付回执/证据行：账本里没有 T-2 的 task.result_submitted，也没有交付包引用。
    ok(
      !fs.readFileSync(eventsPath, "utf8").split("\n").some((l) => l.includes('"task.result_submitted"') && l.includes("task:T-2")),
      "⑤-8d 历史状态夹具没有产出 task.result_submitted、也没冒称交付（只有状态事件）",
    );
  }

  // ═══════════════════ ⑥ 不假装已核 ═══════════════════
  section("⑥ 不假装已核：not_checked 与 not_applicable 分开，未执行的不 passed");
  {
    const fx = makeFixture("p2h", [{ id: "T-1", goal: "已核卡" }]);
    const c = await claim(fx, "T-1");
    const pre = evaluateSubmitResultChecks(intentOf(fx, "T-1", c.token, c.revision), stateOf(fx, "T-1"), { dataDir });
    const notCheckedKinds = pre.not_checked.map((r) => r.kind);
    ok(notCheckedKinds.includes("lock_in_recheck"), "⑥-1 not_checked 含 lock_in_recheck（锁内按当前事实重核）", notCheckedKinds);
    ok(notCheckedKinds.includes("test_execution_and_coverage"), "⑥-2 not_checked 含 test_execution_and_coverage（测试执行/覆盖不在预检断言范围）", notCheckedKinds);
    const naRows = pre.checks.filter((r) => r.status === "not_applicable").map((r) => r.kind);
    ok(naRows.includes("assertClaimSyncGate"), "⑥-3 不适用项逐条 not_applicable（assertClaimSyncGate）", naRows);
    ok(pre.checks.some((r) => r.status === "passed" && r.kind === "evidence_refs"), "⑥-4 证据引用只判「可解析/在库/路径存在」并标 passed");
    ok(!pre.checks.some((r) => r.status === "passed" && /test|coverage|执行/.test(r.kind)), "⑥-5 未执行的检查绝不标 passed");
    ok(pre.checks.every((r) => r.status !== "not_checked"), "⑥-6 checks 里不出现 not_checked 状态（与 not_applicable 不混用）");
    ok(pre.not_checked.every((r) => typeof r.kind === "string" && typeof r.reason === "string" && r.reason !== ""), "⑥-7 not_checked 每项带 kind + reason");
  }

  // ═══════════════════ ⑦ 带 source_manifest 的证据源漂移拒旧 ═══════════════════
  section("⑦ 带 source_manifest 的证据源变化 ⇒ 拒旧（复用现有 verifySourceManifest 判据）");
  {
    const fx = makeFixture("p2i", [{ id: "T-1", goal: "源清单卡" }]);
    const c = await claim(fx, "T-1");
    const srcRel = "src/covered.ts";
    write(path.join(fx.root, srcRel), "export const x = 1;\n");
    const blob = putEvidence(fx.workDir, {
      content: `# 源清单\n覆盖 ${srcRel}\n`,
      kind: "source_manifest",
      summary: "p2 源清单",
      created_by: executor,
      role: "executor",
      binding: { revision_kind: "code", revision: "x" },
      source_manifest: [srcRel],
    });
    const good = evaluateSubmitResultChecks(intentOf(fx, "T-1", c.token, c.revision, { evidence_refs: [blob.sha256] }), stateOf(fx, "T-1"), { dataDir });
    ok(good.ok, "⑦-1 源未变时带清单证据的提交判据通过", good.failures);
    write(path.join(fx.root, srcRel), "export const x = 2;\n");
    const stale = evaluateSubmitResultChecks(intentOf(fx, "T-1", c.token, c.revision, { evidence_refs: [blob.sha256] }), stateOf(fx, "T-1"), { dataDir });
    ok(!stale.ok && stale.failures.some((f) => f.includes("源清单")), "⑦-2 覆盖源变化 ⇒ 拒旧（源清单现读复核非 valid）", stale.failures);

    // ⑦-3 在库的 64-hex 证据但**没有** source_manifest 载体 → 如实标 legacy_unbound（不当 valid、不拒旧格式）
    const fxL = makeFixture("p2i2", [{ id: "T-1", goal: "旧证据卡" }]);
    const cL = await claim(fxL, "T-1");
    const legacy = putEvidence(fxL.workDir, {
      content: "legacy evidence without source_manifest carrier\n",
      kind: "other",
      summary: "旧格式证据（无载体）",
      created_by: executor,
      role: "executor",
      binding: { revision_kind: "code", revision: "x" },
    });
    const legacyOutcome = evaluateSubmitResultChecks(
      intentOf(fxL, "T-1", cL.token, cL.revision, { evidence_refs: [legacy.sha256] }),
      stateOf(fxL, "T-1"),
      { dataDir },
    );
    const legacyVerdict = (
      legacyOutcome.checks.find((r) => r.kind === "evidence_refs")?.actual as
        | { source_manifests?: { status: string }[] }
        | undefined
    )?.source_manifests?.[0]?.status;
    ok(
      legacyOutcome.ok &&
        legacyVerdict === "legacy_unbound" &&
        legacyOutcome.not_checked.some((r) => r.kind === "evidence_source_manifest_unbound") &&
        !legacyOutcome.checks.some((r) => r.kind === "evidence_source_manifests" && r.status === "passed"),
      "⑦-3 无 source_manifest 载体的旧证据如实标 legacy_unbound（不当 valid、进 not_checked，也不拒旧格式）",
      { verdict: legacyVerdict, notChecked: legacyOutcome.not_checked.map((r) => r.kind) },
    );

    // ⑦-4 覆盖源变化：`evidence_refs` 行也必须 failed（不再自相矛盾地 passed）
    const refsRow = stale.checks.find((r) => r.kind === "evidence_refs");
    ok(refsRow?.status === "failed" && stale.code === "EVIDENCE_MISSING", "⑦-4 源漂移时 evidence_refs 行 failed、失败码 EVIDENCE_MISSING", { status: refsRow?.status, code: stale.code });

    // ⑦-5 单列 evidence_source_manifests 行给逐项源差异（changed/missing/unreadable）与修复位置
    const driftRow = stale.checks.find((r) => r.kind === "evidence_source_manifests");
    const driftActual = JSON.stringify(driftRow?.actual ?? null);
    ok(
      driftRow?.status === "failed" &&
        typeof driftRow.remediation === "string" &&
        driftRow.remediation.length > 0 &&
        driftActual.includes("changed") &&
        driftActual.includes(srcRel),
      "⑦-5 单列 evidence_source_manifests 行给逐项源差异与修复位置（remediation 非空）",
      driftRow,
    );

    // ⑦-6 源未变且载体完整：该行 passed 且 checked 里有这份证据
    const goodRow = good.checks.find((r) => r.kind === "evidence_source_manifests");
    ok(
      goodRow?.status === "passed" &&
        (goodRow.actual as { checked?: string[] }).checked?.includes(blob.sha256) === true,
      "⑦-6 源未变时 evidence_source_manifests 行 passed 且 checked 列出该证据",
      goodRow,
    );
  }

  // ═══════════════════ ⑧ 宿主只读路由 + 客户端 + 能力协商 ═══════════════════
  section("⑧ 宿主只读路由 POST /api/work/preflight + 客户端 + 能力协商");
  {
    const fx = makeFixture("p2j", [{ id: "T-1", goal: "路由卡" }]);
    const c = await claim(fx, "T-1");
    const hostToken = "host-token-p2";
    const body = intentOf(fx, "T-1", c.token, c.revision);
    const live = await startWorkServer(service, hostToken);
    writeServiceDescriptor(dataDir, { schema_version: 2, pid: process.pid, host: "127.0.0.1", port: live.port, token: hostToken, started_at: new Date().toISOString(), url: `http://127.0.0.1:${live.port}` });

    const noToken = await fetch(`http://127.0.0.1:${live.port}/api/work/preflight`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    ok(noToken.status === 401, "⑧-1 缺 token → 401（与既有只读读口同一鉴权门）", noToken.status);

    const before = treeHashes(fx.workDir);
    const client = new WorkServiceClient({ dataDir, autostart: false });
    const fetched = await client.preflightResultRemote(body);
    ok(fetched.kind === "ok", "⑧-2 客户端经宿主只读路由取到预检（supported_contract=preflight/v1）", fetched.kind);
    if (fetched.kind === "ok") {
      ok(fetched.result.supported_contract === "preflight/v1", "⑧-3 响应带 supported_contract=preflight/v1");
      ok(fetched.result.recheck_on_commit === true, "⑧-4 recheck_on_commit=true 如实");
      ok(fetched.result.read_only === true, "⑧-5 响应明示 read_only");
      const j = JSON.stringify(fetched.result);
      ok(!j.includes(c.token) && !j.includes(c.token.slice(0, 12)), "⑧-6 路由响应不含 claim_token（含前缀）");
    }
    ok(eqTree(before, treeHashes(fx.workDir)), "⑧-7 宿主只读路由调用前后 `.工作台/work` 逐字节不变（零写入）");

    // 公开 now 明确拒（不再悄悄接受/丢弃）——运行时不能回拨时钟延长租约
    let nowThrew: unknown = null;
    try {
      service.preflightResult({ ...body, now: new Date(Date.now() + 1e12).toISOString() });
    } catch (e) {
      nowThrew = e;
    }
    ok(
      isWorkError(nowThrew) &&
        nowThrew.code === "INVALID_COMMAND" &&
        ((nowThrew.detail.failures as string[] | undefined) ?? []).some((f) => f.includes("now")),
      "⑧-8 公开 now 明确拒（INVALID_COMMAND，不悄悄接受）",
      isWorkError(nowThrew) ? nowThrew.detail : nowThrew,
    );
    ok(service.preflightResult({ ...body }).checks_rechecked === true, "⑧-8b 不带 now 的正常预检照常返回判据结果（checks_rechecked=true）");

    const toolOk = await preflightTaskResultTool.handler({ ...body } as Record<string, unknown>, { clientName: executor, work: client });
    ok(toolOk.isError !== true, "⑧-9 MCP 工具在支持宿主上返回预检结果（非错误）", String(toolOk.content?.[0]?.text).slice(0, 120));
    live.close();

    // 旧宿主：404 → unsupported + 零写入
    const old = await start404Server();
    writeServiceDescriptor(dataDir, { schema_version: 2, pid: process.pid, host: "127.0.0.1", port: old.port, token: hostToken, started_at: new Date().toISOString(), url: `http://127.0.0.1:${old.port}` });
    const beforeOld = treeHashes(fx.workDir);
    const oldFetch = await new WorkServiceClient({ dataDir, autostart: false }).preflightResultRemote(body);
    ok(oldFetch.kind === "unsupported", "⑧-10 旧宿主（404）→ unsupported", oldFetch.kind);
    const toolOld = await preflightTaskResultTool.handler({ ...body } as Record<string, unknown>, { clientName: executor, work: new WorkServiceClient({ dataDir, autostart: false }) });
    ok(toolOld.isError === true && String(toolOld.content?.[0]?.text).includes("UNSUPPORTED_BY_HOST"), "⑧-11 MCP 工具对旧宿主报 UNSUPPORTED_BY_HOST", String(toolOld.content?.[0]?.text).slice(0, 160));
    ok(eqTree(beforeOld, treeHashes(fx.workDir)), "⑧-12 旧宿主 unsupported 路径零写入（事件/证据/租约均不变）");
    old.close();

    // 缺宿主：删描述符 → unavailable
    removeServiceDescriptor(dataDir);
    const missing = await new WorkServiceClient({ dataDir, autostart: false }).preflightResultRemote(body);
    ok(missing.kind === "unavailable", "⑧-13 缺宿主（无描述符）→ unavailable", missing.kind);
    const toolMissing = await preflightTaskResultTool.handler({ ...body } as Record<string, unknown>, { clientName: executor, work: new WorkServiceClient({ dataDir, autostart: false }) });
    ok(toolMissing.isError === true && String(toolMissing.content?.[0]?.text).includes("SERVICE_UNAVAILABLE"), "⑧-14 MCP 工具对缺宿主报 SERVICE_UNAVAILABLE（不报通过）", String(toolMissing.content?.[0]?.text).slice(0, 160));
  }

  // ═══════════════════ ⑨ 提交路径行为不变 ═══════════════════
  section("⑨ 提交路径行为不变：schema 同形、必填恰好、无 now");
  {
    ok(preflightTaskResultTool.inputSchema === submitTaskResultTool.inputSchema, "⑨-1 preflight 与 submit 复用**同一个** inputSchema 对象（同形）");
    const schema = SUBMIT_TASK_RESULT_SCHEMA as { required: string[]; properties: Record<string, unknown> };
    ok(
      JSON.stringify(schema.required) === JSON.stringify(["project_id", "task_id", "role", "change_id", "claim_token", "expected_revision", "evidence_refs"]),
      "⑨-2 必填恰好（逐字不变，原必填不省略）",
      schema.required,
    );
    ok(!("now" in schema.properties), "⑨-3 schema 无 now（测试时钟非公开字段）");
    ok(preflightTaskResultTool.name === "preflight_task_result", "⑨-4 工具名为独立只读名 preflight_task_result");
    ok(submitTaskResultTool.name === "submit_task_result", "⑨-5 submit 工具名未变");
  }

  // ═══════════════════ ⑩ 预检入参校验与真实提交同源（闭键/类型/role/命令信封；非法不静默过滤） ═══════════════════
  section("⑩ 预检入参校验与真实提交同源（闭键/类型/role/命令信封；非法不静默过滤）");
  {
    const schema = SUBMIT_TASK_RESULT_SCHEMA as { properties: Record<string, unknown>; required: string[] };
    ok(
      JSON.stringify([...RESULT_SUBMIT_INPUT_KEYS].sort()) === JSON.stringify(Object.keys(schema.properties).sort()),
      "⑩-1 预检闭键集与 submit_task_result schema 属性**逐字一致**（同源）",
      { preflight: RESULT_SUBMIT_INPUT_KEYS, schema: Object.keys(schema.properties) },
    );
    ok(
      JSON.stringify(RESULT_SUBMIT_REQUIRED_KEYS) === JSON.stringify(schema.required),
      "⑩-2 预检必填与 schema.required 逐字一致（同源）",
      { preflight: RESULT_SUBMIT_REQUIRED_KEYS, schema: schema.required },
    );

    const fx = makeFixture("p2k", [{ id: "T-1", goal: "入参卡" }]);
    const c = await claim(fx, "T-1");
    const goodBody: Record<string, unknown> = { ...intentOf(fx, "T-1", c.token, c.revision) };
    const expectHostReject = (label: string, patch: Record<string, unknown>, needle: string): void => {
      let threwLocal: unknown = null;
      try {
        service.preflightResult({ ...goodBody, ...patch });
      } catch (e) {
        threwLocal = e;
      }
      ok(
        isWorkError(threwLocal) && threwLocal.code === "INVALID_COMMAND" && JSON.stringify(threwLocal.detail).includes(needle),
        label,
        isWorkError(threwLocal) ? threwLocal.detail : threwLocal,
      );
    };
    expectHostReject("⑩-3 unknown 字段明确拒（闭键，不静默丢弃）", { bogus_field: 1 }, "bogus_field");
    expectHostReject("⑩-4 非法 role（空）明确拒", { role: "" }, "role");
    expectHostReject("⑩-5 负版本明确拒", { expected_revision: -1 }, "expected_revision");
    expectHostReject("⑩-6 非整数版本明确拒", { expected_revision: 1.5 }, "expected_revision");
    expectHostReject("⑩-7 非 string 数组项明确拒（不静默过滤）", { evidence_refs: [REL_EVIDENCE, 42] }, "evidence_refs");
    expectHostReject("⑩-8 公开 now 明确拒", { now: "2026-10-06T00:00:00+08:00" }, "now");

    const parsedBad = parseResultSubmitInput({ ...goodBody, expected_revision: -3 });
    ok(
      !parsedBad.ok && parsedBad.failures.some((f) => f.includes("expected_revision")),
      "⑩-9 parseResultSubmitInput 纯校验同源拒负版本（预检与提交同一份）",
      parsedBad.failures,
    );

    // HTTP 与 MCP 实际行为反例（不是只断言内部函数）
    const hostToken = "host-token-p2k";
    const live = await startWorkServer(service, hostToken);
    writeServiceDescriptor(dataDir, {
      schema_version: 2,
      pid: process.pid,
      host: "127.0.0.1",
      port: live.port,
      token: hostToken,
      started_at: new Date().toISOString(),
      url: `http://127.0.0.1:${live.port}`,
    });
    const post = (b: unknown) =>
      fetch(`http://127.0.0.1:${live.port}/api/work/preflight`, {
        method: "POST",
        headers: { "content-type": "application/json", [WORK_TOKEN_HEADER]: hostToken },
        body: JSON.stringify(b),
      });
    const httpUnknown = await post({ ...goodBody, bogus: 1 });
    const httpUnknownBody = (await httpUnknown.json().catch(() => null)) as { code?: string; detail?: unknown } | null;
    ok(
      httpUnknown.status >= 400 && httpUnknownBody?.code === "INVALID_COMMAND" && JSON.stringify(httpUnknownBody.detail).includes("bogus"),
      "⑩-10 HTTP 直连带 unknown 字段被明确拒（不再静默过滤）",
      { status: httpUnknown.status, body: httpUnknownBody },
    );
    const httpNow = await post({ ...goodBody, now: "2026-01-01T00:00:00+08:00" });
    const httpNowBody = (await httpNow.json().catch(() => null)) as { code?: string } | null;
    ok(httpNow.status >= 400 && httpNowBody?.code === "INVALID_COMMAND", "⑩-11 HTTP 直连带 now 被明确拒", { status: httpNow.status, body: httpNowBody });
    const httpNeg = await post({ ...goodBody, expected_revision: -2 });
    const httpNegBody = (await httpNeg.json().catch(() => null)) as { code?: string } | null;
    ok(httpNeg.status >= 400 && httpNegBody?.code === "INVALID_COMMAND", "⑩-12 HTTP 直连带负版本被明确拒", { status: httpNeg.status, body: httpNegBody });
    const mcpClient = new WorkServiceClient({ dataDir, autostart: false });
    const toolBad = await preflightTaskResultTool.handler({ ...goodBody, bogus: 1 } as Record<string, unknown>, {
      clientName: executor,
      work: mcpClient,
    });
    ok(
      toolBad.isError === true && String(toolBad.content?.[0]?.text).includes("bogus"),
      "⑩-13 MCP 工具带 unknown 字段被拒（宿主同源校验，不在本进程静默过滤）",
      String(toolBad.content?.[0]?.text).slice(0, 200),
    );

    // ── P2 最终纠正的**实际反例**：调用方显式给错的类型/缺必填项一律如实拒（不静默改默认、不报通过） ──
    expectHostReject("⑩-14 宿主：verification 非对象项 [42] 明确拒（不再静默过滤）", { verification: [42] }, "verification");
    expectHostReject("⑩-15 宿主：verification.command 类型错误明确拒（不改成空串）", { verification: [{ command: 7, exit_code: 0 }] }, "command");
    expectHostReject("⑩-16 宿主：verification.exit_code 缺失明确拒", { verification: [{ command: "node -e x" }] }, "exit_code");
    expectHostReject("⑩-17 宿主：verification.exit_code 类型错误明确拒（不改成 -1）", { verification: [{ command: "node -e x", exit_code: "0" }] }, "exit_code");
    expectHostReject("⑩-18 宿主：owner_id 显式非字符串（42）明确拒（不静默换成合法缺省）", { owner_id: 42 }, "owner_id");
    // 合法**省略** owner_id：缺省只在真正未提供时补（宿主按 role 补缺省，与 parse 层同一口径）
    const { owner_id: _omitted, ...bodyWithoutOwner } = goodBody as Record<string, unknown>;
    const parsedNoOwner = parseResultSubmitInput(bodyWithoutOwner);
    ok(
      parsedNoOwner.ok === true && parsedNoOwner.input?.owner_id === "executor",
      "⑩-19 合法省略 owner_id ⇒ 只在真正未提供时按同一缺省口径补成 role（不报类型错）",
      parsedNoOwner.ok ? { owner_id: parsedNoOwner.input?.owner_id } : parsedNoOwner.failures,
    );

    const httpOwner = await post({ ...goodBody, owner_id: 42 });
    const httpOwnerBody = (await httpOwner.json().catch(() => null)) as { code?: string; detail?: unknown } | null;
    ok(
      httpOwner.status >= 400 && httpOwnerBody?.code === "INVALID_COMMAND" && JSON.stringify(httpOwnerBody.detail).includes("owner_id"),
      "⑩-20 HTTP 直连 owner_id=42 被明确拒（不静默改合法缺省）",
      { status: httpOwner.status, body: httpOwnerBody },
    );
    const httpVerif = await post({ ...goodBody, verification: [42] });
    const httpVerifBody = (await httpVerif.json().catch(() => null)) as { code?: string; detail?: unknown } | null;
    ok(
      httpVerif.status >= 400 && httpVerifBody?.code === "INVALID_COMMAND" && JSON.stringify(httpVerifBody.detail).includes("verification"),
      "⑩-21 HTTP 直连 verification=[42] 被明确拒（同上）",
      { status: httpVerif.status, body: httpVerifBody },
    );
    const mcpClient2 = new WorkServiceClient({ dataDir, autostart: false });
    const toolOwner = await preflightTaskResultTool.handler({ ...goodBody, owner_id: 42 } as Record<string, unknown>, {
      clientName: executor,
      work: mcpClient2,
    });
    ok(
      toolOwner.isError === true && String(toolOwner.content?.[0]?.text).includes("owner_id"),
      "⑩-22 MCP 工具带 owner_id=42 被拒（不静默 str()+fallback 换成合法缺省）",
      String(toolOwner.content?.[0]?.text).slice(0, 200),
    );
    const toolVerif = await preflightTaskResultTool.handler({ ...goodBody, verification: [{ command: "x" }] } as Record<string, unknown>, {
      clientName: executor,
      work: mcpClient2,
    });
    ok(
      toolVerif.isError === true && String(toolVerif.content?.[0]?.text).includes("exit_code"),
      "⑩-23 MCP 工具带 verification 缺 exit_code 被拒（宿主同源校验）",
      String(toolVerif.content?.[0]?.text).slice(0, 200),
    );
    const toolNoOwner = await preflightTaskResultTool.handler({ ...bodyWithoutOwner } as Record<string, unknown>, {
      clientName: executor,
      work: mcpClient2,
    });
    const toolWithOwner = await preflightTaskResultTool.handler({ ...goodBody } as Record<string, unknown>, {
      clientName: executor,
      work: mcpClient2,
    });
    ok(
      toolNoOwner.isError !== true &&
        toolWithOwner.isError !== true &&
        String(toolNoOwner.content?.[0]?.text) === String(toolWithOwner.content?.[0]?.text),
      "⑩-24 MCP 工具省略 owner_id 与显式给同一持有者**等价**（同结果；缺省只在真正未提供时补）",
      { omitted: String(toolNoOwner.content?.[0]?.text).slice(0, 120) },
    );
    live.close();
    removeServiceDescriptor(dataDir);
  }

  // ═══════════════════ ⑪ 预检 → 锁内：依赖变化必须被锁内重核挡住 ═══════════════════
  section("⑪ 预检到锁内依赖变化：锁内按锁内事件重核依赖（直写也不能旁路）");
  {
    const fx = makeFixture("p2l", [
      { id: "T-1", goal: "前置卡" },
      { id: "T-2", goal: "依赖卡", dep: "T-1" },
    ]);
    await makeGreen(fx, "T-1");
    const c = await claim(fx, "T-2");
    const preOk = hostPreflight(fx, c, {}, "T-2");
    ok(preOk.would_pass === true, "⑪-1 依赖已释放时 T-2 预检通过（would_pass=true）", preOk.rejection_code);
    // 预检之后依赖变化：取消前置 T-1（走既有状态边界 task.status_changed）
    submitTaskStatus(service, {
      project_id: fx.id,
      task_id: "T-1",
      change_id: CHG,
      actor_id: executor,
      role: "executor",
      expected_revision: revOf(fx, "T-1"),
      status: "cancelled",
      reason: "夹具：预检后依赖变化",
    });
    const preAfter = hostPreflight(fx, c, {}, "T-2");
    ok(
      preAfter.would_pass === false && preAfter.rejection_code === "DEPENDENCY_UNMET",
      "⑪-2 依赖变化后预检即报 DEPENDENCY_UNMET",
      { wp: preAfter.would_pass, code: preAfter.rejection_code },
    );
    // 直写（绕过调用层）也必须在**锁内**被拒：按锁内事件重核依赖，零字节
    const eventsPath = path.join(fx.workDir, "events.jsonl");
    const before = sha256(fs.readFileSync(eventsPath));
    let threw: unknown = null;
    try {
      service.submit({
        schema_version: 2,
        project_id: fx.id,
        change_id: CHG,
        entity_id: "task:T-2",
        expected_revision: revOf(fx, "T-2"),
        type: "task.result_submitted",
        actor_id: executor,
        role: "executor",
        idempotency_key: "p2-dep-change-1",
        payload: {
          claim_token: c.token,
          owner_id: executor,
          owner_role: "executor",
          deliverables: [],
          evidence_refs: [REL_EVIDENCE],
          verification: [],
          untested: [],
          known_issues: [],
        },
      });
    } catch (e) {
      threw = e;
    }
    ok(
      isWorkError(threw) &&
        threw.code === "INVALID_COMMAND" &&
        threw.detail.reason === "result_submit_lockin_failed" &&
        ((threw.detail.failures as string[] | undefined) ?? []).some((f) => f.includes("前置")),
      "⑪-3 直写结果在锁内按锁内事件重核依赖 → 拒（DEPENDENCY_UNMET 类失败）",
      isWorkError(threw) ? threw.detail : threw,
    );
    ok(sha256(fs.readFileSync(eventsPath)) === before, "⑪-4 被拒后零字节（events.jsonl 不变）");
  }

  // ═══════════════════ ⑫ 旧历史读取兼容（账本里既有的无 token result_submitted 仍可折叠） ═══════════════════
  section("⑫ 旧历史读取兼容：账本里无 claim_token 的旧 result_submitted 仍折叠/读回");
  {
    const fx = makeFixture("p2m", [{ id: "T-1", goal: "历史卡" }]);
    const eventsPath = path.join(fx.workDir, "events.jsonl");
    const existingLines = fs.readFileSync(eventsPath, "utf8").trim().split("\n").filter((l) => l !== "");
    const lastSeq = (JSON.parse(existingLines[existingLines.length - 1]) as { seq: number }).seq;
    const curRev = readTaskStates(fx.workDir).states["T-1"]?.revision ?? 0;
    const histEvent = {
      schema_version: 2,
      event_id: "hist-result-1",
      project_id: fx.id,
      change_id: CHG,
      entity_id: "task:T-1",
      entity_revision: curRev + 1,
      seq: lastSeq + 1,
      type: "task.result_submitted",
      actor_id: executor,
      role: "executor",
      occurred_at: "2026-09-01T00:00:00+08:00",
      received_at: "2026-09-01T00:00:00+08:00",
      idempotency_key: "hist-result-1",
      payload: { deliverables: ["历史回放"], evidence_refs: [REL_EVIDENCE], verification: [], untested: [], known_issues: [] },
    };
    fs.appendFileSync(eventsPath, JSON.stringify(histEvent) + "\n");
    const st = readTaskStates(fx.workDir).states["T-1"];
    ok(st?.status === "result_submitted", "⑫-1 账本里无 token 的旧 result_submitted 仍折叠为 result_submitted（读兼容）", st?.status);
    // 读侧投影也能算（依赖重查/入口都走同一份读路径），不因缺 token 就炸
    let readErr: string | null = null;
    try {
      const pre2 = service.preflightResult({
        project_id: fx.id,
        task_id: "T-1",
        role: "executor",
        owner_id: executor,
        change_id: CHG,
        claim_token: "clm-whatever",
        expected_revision: 1,
        evidence_refs: [REL_EVIDENCE],
      });
      readErr = pre2.idempotency_status;
    } catch (e) {
      readErr = `threw:${e instanceof Error ? e.message : String(e)}`;
    }
    ok(typeof readErr === "string" && !readErr.startsWith("threw:"), "⑫-2 预检在含旧 result_submitted 的账本上照常读（不因缺 token 就炸）", readErr);
  }

  section(`结果：${passCount} PASS / ${failCount} FAIL`);
  if (failCount > 0) process.exitCode = 1;
  try {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响结论 */
  }
}

// ── HTTP 宿主辅助 ──
function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const a = server.address();
      resolve(typeof a === "object" && a !== null ? a.port : 0);
    });
  });
}
async function startWorkServer(svc: WorkService, token: string): Promise<{ port: number; close: () => void }> {
  const server = http.createServer((req, res) => {
    const pathname = (req.url ?? "/").split("?")[0];
    void handleWorkRequest(req, res, { service: svc, token, pathname }).then((handled) => {
      if (!handled) {
        res.statusCode = 404;
        res.end("{}");
      }
    });
  });
  const port = await listen(server);
  return { port, close: () => server.close() };
}
async function start404Server(): Promise<{ port: number; close: () => void }> {
  const server = http.createServer((_req, res) => {
    res.statusCode = 404;
    res.end("{}");
  });
  const port = await listen(server);
  return { port, close: () => server.close() };
}

void main().catch((e) => {
  console.error("[verify] 验证中断：", e instanceof Error ? e.stack ?? e.message : String(e));
  process.exitCode = 1;
});
