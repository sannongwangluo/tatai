// V09-10 验证脚本（tsx 跑）：返工流程——协调器受控重开同卡新 attempt 入口
// （PLAN.md V09-10 卡面 ①–⑧；DESIGN.md 附录 F；用户裁定原文 `.工作台/handoff/2026-09-24-返工流程裁定.md`）。
// 用法：pnpm verify:v09-10（自带临时 TATAI_HOME 与夹具项目；真实账本只读并做零写入自证）。
//
// 覆盖（逐条对卡面检查项）：
//   ① 负例保持：未重开时 executor 对已提交卡 claim 仍 NOT_CLAIMABLE；
//   ② 合法重开→可领可交：coordinator + 可取回 reopen_basis 重开 ⇒ 新 attempt 可 claim（新 token、
//      attempt 沿用重开值）、可 submit；旧 token 提交被拒；
//   ③ 旧结果可追溯：两次 result_submitted 事件都在册、previous_result 引用链指回第一次、
//      project_entry 呈现当前 attempt/返工理由/历史提交；
//   ④ 误用全拒（逐条零写入）：executor 角色／空依据／依据取不回／依据越界／目录冲突未核实／
//      错误 expected_revision／非已提交状态／旧 run 租约未过期／**直连写口绕 reopenTask**
//      （写边界同闸：角色非 coordinator 拒、payload 多键拒）／重复幂等重开 ⇒ duplicate、不另起 attempt；
//   ⑤ 重启回放一致：删 state.json 重放，快照与状态逐字节一致；
//   ⑥ 未迁移项目：v1 写闸照旧放行、reopen 对它明确拒且零写入、台账不动；
//   ⑦ 依赖门禁保持：前置卡重开后证据未达标 ⇒ 依赖卡仍 DEPENDENCY_UNMET；新 attempt 补达标证据 ⇒ 释放。
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { WorkService } from "../src/server/work/service";
import { loadEvents } from "../src/server/work/eventStore";
import { readTaskStates, submitDefinitionImports, v1TaskWriteGate } from "../src/server/work/tasks";
import { importPlanChecked } from "../src/server/work/references";
import { activateBaseline } from "../src/server/work/documents";
import { claimTask, submitTaskResult, claimRecordsOf, liveClaimRecord } from "../src/server/work/claims";
import { evaluateProjectEntry } from "../src/server/work/entry";
import { isWorkError, REGISTERED_EVENT_TYPES } from "../src/server/work/types";
import { EVENT_SURFACE } from "../src/server/work/eventSurface";
import { projectWorkDir } from "../src/server/workstation";
import { claimTaskTool } from "../src/mcp/tools/projectEntry";

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
const section = (t: string): void => console.log(`\n[verify] ── ${t}`);
const sha256File = (f: string): string | null =>
  fs.existsSync(f) ? crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex") : null;

// ── 真实账本（只读；首尾 sha256 对照＝零写入自证，与 verify-v09-01 同一惯例）──
const REAL_DATA_DIR =
  (process.env.TATAI_HOME ?? "").trim() !== "" ? process.env.TATAI_HOME!.trim() : path.join(os.homedir(), ".tatai");
const realLedger = (() => {
  try {
    const reg = JSON.parse(fs.readFileSync(path.join(REAL_DATA_DIR, "registry.json"), "utf8")) as {
      projects?: { id?: unknown; path?: unknown }[];
    };
    const hit = (reg.projects ?? []).find((p) => p.id === "tatai");
    if (typeof hit?.path !== "string") return null;
    return { file: path.join(hit.path as string, ".工作台", "work", "events.jsonl") };
  } catch {
    return null;
  }
})();
const realLedgerHashBefore = realLedger === null ? null : sha256File(realLedger.file);
info(`真实账本：${realLedger?.file ?? "（本机取不到，零写入自证段 SKIP）"} sha256（前）=${realLedgerHashBefore ?? "n/a"}`);

// ── 隔离夹具（临时 TATAI_HOME + 夹具项目；不碰真实注册表与任何真实项目）──
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-v09-10-"));
const dataDir = path.join(tmpBase, "home");
const RW = "v0910";
const root = path.join(tmpBase, "proj");
const V1 = "v0910-v1";
const v1Root = path.join(tmpBase, "v1-proj");
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(path.join(root, ".工作台"), { recursive: true });
fs.mkdirSync(path.join(v1Root, ".工作台"), { recursive: true });

const write = (f: string, text: string): void => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text, "utf8");
};

const DESIGN = "# V09-10 夹具设计书\n\n## 2 模块划分\n\n| # | 模块 | 说明 |\n| --- | --- | --- |\n| 1 | 甲模块 | 夹具 |\n";
const PLAN = [
  "# V09-10 夹具施工图",
  "",
  "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |",
  "| --- | --- | --- | --- | --- |",
  "| R-1 | todo | 主返工卡 |  | R-1 验收记录 |",
  "| R-2 | todo | 依赖卡 | R-1 | R-2 验收记录 |",
  "| R-3 | todo | 误用卡 |  | R-3 验收记录 |",
  "| R-4 | todo | 未提交卡 |  | R-4 验收记录 |",
  "| R-5 | todo | 租约卡 |  | R-5 验收记录 |",
  "",
  "### R-1 主返工卡",
  "",
  "**设计依据**：§2。**契约**：输入甲，输出甲。",
  "",
  "**文件责任**：`src/a.ts`。",
  "",
  "- [ ] 甲做出来",
  "",
  "**交付**：R-1 验收记录。",
  "",
  "**完成证据**：R-1 验收记录。",
  "",
  "### R-2 依赖卡",
  "",
  "**设计依据**：§2。**契约**：依赖 R-1 的有效证据。",
  "",
  "**文件责任**：`src/b.ts`。",
  "",
  "**交付**：R-2 验收记录。",
  "",
  "**完成证据**：R-2 验收记录。",
  "",
  "### R-3 误用卡",
  "",
  "**设计依据**：§2。**契约**：误用矩阵用。",
  "",
  "**文件责任**：`src/c.ts`。",
  "",
  "**交付**：R-3 验收记录。",
  "",
  "**完成证据**：R-3 验收记录。",
  "",
  "### R-4 未提交卡",
  "",
  "**设计依据**：§2。**契约**：未提交状态用。",
  "",
  "**文件责任**：`src/d.ts`。",
  "",
  "**交付**：R-4 验收记录。",
  "",
  "**完成证据**：R-4 验收记录。",
  "",
  "### R-5 租约卡",
  "",
  "**设计依据**：§2。**契约**：租约未过期拒重开用。",
  "",
  "**文件责任**：`src/e.ts`。",
  "",
  "**交付**：R-5 验收记录。",
  "",
  "**完成证据**：R-5 验收记录。",
  "",
].join("\n");
/** 返工依据（真实存在的项目根内相对路径——reopen_basis 的合法形态） */
const BASIS_REL = ".工作台/handoff/2026-09-24-返工流程裁定.md";
const BASIS_TEXT = "# 夹具返工裁定存档\n\n（V09-10 夹具：模拟用户裁定原话存档——协调器重开的可取回依据。）\n";

write(path.join(root, ".工作台", "design.md"), DESIGN);
write(path.join(root, ".工作台", "plan.md"), PLAN);
write(path.join(root, BASIS_REL), BASIS_TEXT);
write(path.join(root, "src", "a.ts"), "export const a = 1;\n");
write(path.join(v1Root, ".工作台", "tasks.json"), JSON.stringify({ version: 1, tasks: [{ id: "V-1", status: "doing" }] }, null, 2) + "\n");

const nowStamp = "2026-09-24T00:00:00+08:00";
write(
  path.join(dataDir, "registry.json"),
  JSON.stringify({
    version: 1,
    projects: [
      { id: RW, name: "V09-10 返工夹具", path: root, kind: "backend", registered_at: nowStamp, last_opened_at: nowStamp },
      { id: V1, name: "V09-10 未迁移夹具", path: v1Root, kind: "backend", registered_at: nowStamp, last_opened_at: nowStamp },
    ],
  }),
);
process.env.TATAI_HOME = dataDir;

const service = new WorkService({ dataDir });
const workDir = projectWorkDir(RW, dataDir);
const eventCount = (): number => loadEvents(workDir).events.length;
const statesOf = () => readTaskStates(workDir).states;
const CHANGE = "change-v0910";
const EXEC = "v0910-executor";
const COORD = "v0910-coordinator";

// ── 定义导入（受检入口，真写口）──
{
  const imported = importPlanChecked(PLAN, workDir, { plan_revision: crypto.createHash("sha256").update(PLAN, "utf8").digest("hex") });
  const receipts = submitDefinitionImports(service, {
    project_id: RW,
    change_id: CHANGE,
    actor_id: "v0910-setup",
    role: "coordinator",
    definitions: imported.definitions,
  });
  ok(
    receipts.length === 5 && statesOf()["R-1"] !== undefined && statesOf()["R-2"] !== undefined,
    `⓪ 受检定义导入落地（${receipts.length} 张卡可认领）`,
  );
  // 入口派活以有效基线为前提（§6.7 现行口径）：夹具激活一条，reopen 事件的 baseline_id 也才能真绑上
  const baseline = activateBaseline(
    RW,
    { approved_by: "user", approval_basis: "V09-10 隔离夹具审定（不代表真实用户 Gate）", approval_kind: "user_confirmed" },
    dataDir,
  );
  ok(baseline.baseline.baseline_id !== "", `⓪ 夹具基线激活（${baseline.baseline.baseline_id.slice(0, 18)}…）`);
}

// 使第一次认领的租约**当场过期**（时钟打在 25 分钟前）：提交走 ownership_basis 通道，
// 之后的合法重开才不会被「旧租约未过期」挡住（那条拒径在 ④ 用 R-5 单独验）。
const PAST = new Date(Date.now() - 25 * 60 * 1000).toISOString();

/** 认领+提交一条卡（旧 attempt 走到 result_submitted） */
async function claimAndSubmit(taskId: string, opts: { expiredLease: boolean; evidenceRel: string }): Promise<{ token: string; revision: number; seq: number }> {
  const claim = await claimTask(
    {
      project_id: RW,
      task_id: taskId,
      role: "executor",
      owner_id: EXEC,
      change_id: CHANGE,
      ...(opts.expiredLease ? { now: PAST } : {}),
    },
    service,
    dataDir,
  );
  if (!claim.ok) throw new Error(`夹具缺陷：认领 ${taskId} 被拒 ${claim.code} ${claim.message}`);
  const submit = await submitTaskResult(
    {
      project_id: RW,
      task_id: taskId,
      role: "executor",
      owner_id: EXEC,
      change_id: CHANGE,
      claim_token: claim.claim.claim_token,
      expected_revision: claim.receipt.entity_revision,
      deliverables: [`${taskId} 交付物`],
      evidence_refs: [opts.evidenceRel],
      verification: [{ command: "fixture-check", exit_code: 0 }],
      untested: [],
      ...(opts.expiredLease ? { ownership_basis: "旧租约已过期；核实本进程即原执行者（夹具时钟）" } : {}),
    },
    { submitter: service },
    dataDir,
  );
  if (!submit.ok) throw new Error(`夹具缺陷：提交 ${taskId} 被拒 ${submit.code} ${submit.message}`);
  return { token: claim.claim.claim_token, revision: submit.receipt.entity_revision, seq: submit.receipt.seq };
}

const first = await claimAndSubmit("R-1", { expiredLease: true, evidenceRel: BASIS_REL });

// ═════════════════════ ① 负例保持：executor 直领已提交卡 ═════════════════════
section("① 未重开时 executor 对已提交卡 claim 仍 NOT_CLAIMABLE");
{
  const direct = await claimTask(
    { project_id: RW, task_id: "R-1", role: "executor", owner_id: EXEC, change_id: CHANGE },
    service,
    dataDir,
  );
  ok(
    !direct.ok && direct.code === "NOT_CLAIMABLE",
    `① executor 直领已提交卡 ⇒ NOT_CLAIMABLE（实际: ${direct.ok ? "（意外放行）" : direct.code}）`,
  );
}

// ═════════════════════ ② 合法重开 → 新 attempt 可领可交 ═════════════════════
section("② 协调器带可取回依据重开 ⇒ 新 attempt 可领可交；旧 token 提交拒");
const claims = await import("../src/server/work/claims");
const reopenTask = (claims as { reopenTask?: unknown }).reopenTask as
  | undefined
  | ((input: Record<string, unknown>, submitter: unknown, dataDir?: string) => Promise<{ ok: boolean; code?: string; message?: string; failures?: string[]; duplicate?: boolean; reopen?: { attempt: number; workspace: string; previous_result: { seq: number } }; receipt?: { entity_revision: number } }>);
ok(typeof reopenTask === "function", "② claims.reopenTask 存在（红：受控重开入口未实现）");

let reopenedAttempt = 0;
if (typeof reopenTask === "function") {
  const before = eventCount();
  const r = await reopenTask(
    {
      project_id: RW,
      task_id: "R-1",
      role: "coordinator",
      actor_id: COORD,
      change_id: CHANGE,
      reopen_basis: [BASIS_REL],
      reason: "改版重交：定义在旧提交后变更，按附录 F 重开新 attempt",
      request_id: "req-r1-1",
    },
    service,
    dataDir,
  );
  ok(
    r.ok === true && eventCount() === before + 1,
    `② 合法重开被接受并落 task.reopened 事件（${r.ok ? "ok" : `${r.code}: ${String(r.message).slice(0, 60)}`}）`,
  );
  const st = statesOf()["R-1"];
  reopenedAttempt = st.attempt ?? 0;
  ok(
    st.status === "ready" && st.claim_token === null && reopenedAttempt === 2,
    `② 重开后状态回到可认领态（status=${st.status}、attempt=${String(st.attempt)}、旧 token 已作废）`,
  );
  ok(
    st.last_reopen?.previous_result?.seq === first.seq &&
      st.last_reopen.reason.includes("改版重交") &&
      (st.last_reopen.reopen_basis as string[]).includes(BASIS_REL),
    `② 事件带返工理由/依据与上一提交引用（previous_result.seq=${String(st.last_reopen?.previous_result?.seq)}）`,
  );
  ok(st.run_id !== null && st.attempt_id !== null, `② 新 run_id/attempt_id 已就位（${st.run_id} / ${st.attempt_id}）`);

  // project_entry 读侧呈现（③ 一并验）：executor 的下一动作恢复 claim_task 派发，且理由里能看见返工三态
  const entry = evaluateProjectEntry({ project_id: RW, role: "executor", client_capabilities: ["continuable"] }, { dataDir });
  const reopenReason = entry.reasons.find((x) => x.code === "reopen_trace");
  ok(
    entry.next_action === "claim_task" && reopenReason !== undefined,
    `③ project_entry 对重开卡恢复 claim_task 派发（next_action=${entry.next_action}），并带 reopen_trace 呈现`,
  );
  ok(
    reopenReason !== undefined &&
      reopenReason.text.includes("第 2 次尝试") &&
      reopenReason.text.includes("改版重交") &&
      reopenReason.text.includes(`seq ${first.seq}`),
    `③ 入口理由呈现 当前 attempt/返工理由/上一提交（${(reopenReason?.text ?? "").slice(0, 60)}…）`,
  );

  // 新 attempt 可 claim（新 token、attempt 沿用重开值）
  const claim2 = await claimTask(
    { project_id: RW, task_id: "R-1", role: "executor", owner_id: EXEC, change_id: CHANGE },
    service,
    dataDir,
  );
  ok(
    claim2.ok === true && claim2.claim.attempt === 2 && claim2.claim.claim_token !== first.token,
    `② 重开后的任务可正常 claim（attempt=${claim2.ok ? claim2.claim.attempt : "（被拒）"}、token 换新）`,
  );
  ok(
    claim2.ok === true && claim2.claim.workspace.includes(".工作台/runs/R-1/"),
    `② 新工作目录按 attempt 隔离（${claim2.ok ? claim2.claim.workspace : "n/a"}）`,
  );

  // ⑦ 反：前置证据未达标 ⇒ 依赖卡仍 DEPENDENCY_UNMET
  section("⑦ 依赖门禁保持（反）：重开后证据未达标 ⇒ 依赖卡仍拦");
  {
    const claimR2 = await claimTask(
      { project_id: RW, task_id: "R-2", role: "executor", owner_id: EXEC, change_id: CHANGE },
      service,
      dataDir,
    );
    ok(
      claimR2.ok === false && claimR2.code === "DEPENDENCY_UNMET",
      `⑦ 前置卡证据未达标时依赖卡仍 DEPENDENCY_UNMET（实际: ${claimR2.ok ? "（意外放行）" : claimR2.code}）`,
    );
  }

  // 新 attempt 补达标证据（R-1 必需检查 = 验收项 R-1::check:0 + 完成证据 R-1::evidence，两项都过才算达标）
  const planSha = crypto.createHash("sha256").update(PLAN, "utf8").digest("hex");
  service.submit({
    schema_version: 2,
    project_id: RW,
    change_id: CHANGE,
    entity_id: "check:v0910-r1-pass",
    expected_revision: null,
    type: "audit.self_check_recorded",
    actor_id: EXEC,
    role: "executor",
    idempotency_key: "v0910:self-check:r1-evidence:1",
    payload: {
      checked_by: EXEC,
      task_id: "R-1",
      checks: [
        {
          check_id: "R-1::check:0",
          method: "夹具验收：甲做出来",
          command: "fixture-accept",
          exit_code: 0,
          evidence_sha256: "a".repeat(64),
          verifies: "document",
        },
        {
          check_id: "R-1::evidence",
          method: "夹具验收：核对交付物与验收记录",
          command: "fixture-accept",
          exit_code: 0,
          evidence_sha256: "a".repeat(64),
          verifies: "document",
        },
      ],
      conclusion: "pass",
      binding: { revision_kind: "plan", revision: planSha },
    },
  });
  if (!claim2.ok) throw new Error("夹具缺陷：新 attempt 认领失败");
  const submit2 = await submitTaskResult(
    {
      project_id: RW,
      task_id: "R-1",
      role: "executor",
      owner_id: EXEC,
      change_id: CHANGE,
      claim_token: claim2.claim.claim_token,
      expected_revision: claim2.receipt.entity_revision,
      deliverables: ["R-1 第二版交付物"],
      evidence_refs: [BASIS_REL],
      verification: [{ command: "fixture-check-v2", exit_code: 0 }],
      untested: [],
    },
    { submitter: service },
    dataDir,
  );
  ok(submit2.ok === true, `② 新 attempt 带有效证据提交成功（${submit2.ok ? "ok" : `${submit2.code}: ${String(submit2.message).slice(0, 60)}`}）`);

  section("⑦ 依赖门禁保持（正）：证据达标 ⇒ 释放");
  {
    const claimR2b = await claimTask(
      { project_id: RW, task_id: "R-2", role: "executor", owner_id: EXEC, change_id: CHANGE },
      service,
      dataDir,
    );
    ok(claimR2b.ok === true, `⑦ 新 attempt 交有效证据后依赖卡可领（${claimR2b.ok ? "ok" : `${claimR2b.code}：依赖闸没放开`}）`);
  }

  // 旧 token 提交必拒（提交校验只认当前 attempt 的认领 token）
  {
    const beforeStale = eventCount();
    const stale = await submitTaskResult(
      {
        project_id: RW,
        task_id: "R-1",
        role: "executor",
        owner_id: EXEC,
        change_id: CHANGE,
        claim_token: first.token,
        expected_revision: statesOf()["R-1"].revision,
        deliverables: ["旧 token 的提交"],
        evidence_refs: [BASIS_REL],
        untested: [],
      },
      { submitter: service },
      dataDir,
    );
    ok(
      stale.ok === false && stale.code === "CLAIM_NOT_YOURS" && eventCount() === beforeStale,
      `②/④ 旧 token 提交被拒且零写入（code=${stale.ok ? "（意外放行）" : stale.code}）`,
    );
  }
}

// ═════════════════════ ③ 旧结果可追溯 ═════════════════════
section("③ 旧提交事件/证据永久保留、引用链不断");
{
  const events = loadEvents(workDir).events;
  const submits = events.filter((e) => e.type === "task.result_submitted" && e.entity_id === "task:R-1");
  ok(
    submits.length === 2 && submits[0].seq === first.seq && submits[1].seq > first.seq,
    `③ 两次 result_submitted 都在册（seq ${submits.map((s) => s.seq).join("、")}；旧提交一条没丢）`,
  );
  const st = statesOf()["R-1"];
  ok(
    st.last_reopen?.previous_result?.seq === first.seq &&
      st.last_reopen?.previous_result?.event_id === submits[0]?.event_id,
    "③ previous_result 引用链精确指回第一次提交（seq + event_id）",
  );
  ok(
    Array.isArray((submits[0]?.payload as { evidence_refs?: unknown[] })?.evidence_refs) &&
      (((submits[0]?.payload as { evidence_refs?: unknown[] })?.evidence_refs) ?? []).includes(BASIS_REL),
    "③ 旧提交的证据引用原样可读（历史只读，不覆盖）",
  );
}

// ═════════════════════ ④ 误用全拒（逐条零写入） ═════════════════════
section("④ 误用全拒：角色/依据/目录/版本/状态/租约/直绕写口/重复幂等");
if (typeof reopenTask !== "function") {
  ok(false, "④ 误用矩阵可跑（红：reopenTask 未实现）");
} else {
  // 夹具 R-3 走到已提交（租约当场过期）
  await claimAndSubmit("R-3", { expiredLease: true, evidenceRel: BASIS_REL });
  const r3 = statesOf()["R-3"];
  const base = {
    project_id: RW,
    task_id: "R-3",
    actor_id: COORD,
    change_id: CHANGE,
    reopen_basis: [BASIS_REL],
    reason: "误用矩阵探针",
  };
  const expectReject = async (label: string, input: Record<string, unknown>, needle: string): Promise<void> => {
    const before = eventCount();
    const r = await reopenTask(input, service, dataDir);
    const noWrites = eventCount() === before;
    ok(
      r.ok === false && noWrites && (r.message ?? "").includes(needle),
      `④ ${label} ⇒ 拒且零写入（${r.ok ? "（意外放行）" : `${r.code}：${String(r.message).slice(0, 56)}…`}）`,
    );
  };
  await expectReject("executor 角色重开", { ...base, role: "executor" }, "coordinator");
  await expectReject("空依据重开", { ...base, role: "coordinator", reopen_basis: [] }, "reopen_basis");
  await expectReject(
    "依据取不回（路径不存在）",
    { ...base, role: "coordinator", reopen_basis: [".工作台/handoff/不存在.md"] },
    "取不回",
  );
  await expectReject("依据越出项目根", { ...base, role: "coordinator", reopen_basis: ["../escape.md"] }, "越出项目根");
  const oldWorkspace = claimRecordsOf(loadEvents(workDir).events)["R-3"]?.slice(-1)[0]?.workspace ?? "";
  await expectReject(
    "目录冲突未核实（沿用旧 run 工作目录）",
    { ...base, role: "coordinator", workspace: oldWorkspace },
    "目录冲突",
  );
  await expectReject(
    "错误 expected_revision",
    { ...base, role: "coordinator", expected_revision: r3.revision + 99 },
    "版本",
  );

  // 非已提交状态拒（R-4 仅认领未提交）
  {
    const c4 = await claimTask(
      { project_id: RW, task_id: "R-4", role: "executor", owner_id: EXEC, change_id: CHANGE },
      service,
      dataDir,
    );
    if (!c4.ok) throw new Error(`夹具缺陷：R-4 认领被拒 ${c4.code}`);
    const before = eventCount();
    const r = await reopenTask({ ...base, task_id: "R-4", role: "coordinator" }, service, dataDir);
    ok(
      r.ok === false && eventCount() === before && String(r.message).includes("已提交"),
      `④ 非已提交状态（认领中）重开 ⇒ 拒且零写入（${r.ok ? "（意外放行）" : r.code}）`,
    );
  }

  // 旧 run 租约未过期拒（R-5 默认 15 分钟租约：提交后仍 active）
  {
    await claimAndSubmit("R-5", { expiredLease: false, evidenceRel: BASIS_REL });
    const before = eventCount();
    const r = await reopenTask({ ...base, task_id: "R-5", role: "coordinator" }, service, dataDir);
    ok(
      r.ok === false &&
        eventCount() === before &&
        (String(r.message).includes("租约") || String(r.message).includes("无心跳不等于进程已停止")),
      `④ 旧 run 仍有未过期租约 ⇒ 拒并指引（无心跳不等于进程已停止）（${r.ok ? "（意外放行）" : String(r.message).slice(0, 56)}…）`,
    );
  }

  // 直连写口绕 reopenTask：写边界同闸——角色非 coordinator 拒、payload 多键拒（各零写入）
  {
    const before = eventCount();
    let roleRejected = false;
    try {
      service.submit({
        schema_version: 2,
        project_id: RW,
        change_id: CHANGE,
        entity_id: "task:R-3",
        expected_revision: statesOf()["R-3"].revision,
        type: "task.reopened",
        actor_id: EXEC,
        role: "executor",
        idempotency_key: "v0910:boundary:executor",
        payload: {
          attempt: 2,
          run_id: "run-R-3-2",
          attempt_id: "att-R-3-2-deadbeef",
          workspace: ".工作台/runs/R-3/att-R-3-2-deadbeef",
          reason: "直连写口伪造重开",
          reopen_basis: [BASIS_REL],
          previous_result: { seq: statesOf()["R-3"].seq, event_id: statesOf()["R-3"].last_event_id, run_id: null, attempt_id: null },
          definition_sha256: null,
          baseline_id: null,
        },
      });
    } catch (e) {
      roleRejected = isWorkError(e);
    }
    ok(roleRejected && eventCount() === before, "④ 直连写口以 executor 角色手写 task.reopened ⇒ 写边界拒且零字节");
    let keyRejected = false;
    try {
      service.submit({
        schema_version: 2,
        project_id: RW,
        change_id: CHANGE,
        entity_id: "task:R-3",
        expected_revision: statesOf()["R-3"].revision,
        type: "task.reopened",
        actor_id: COORD,
        role: "coordinator",
        idempotency_key: "v0910:boundary:extra-key",
        payload: {
          attempt: 2,
          run_id: "run-R-3-2",
          attempt_id: "att-R-3-2-deadbeef",
          workspace: ".工作台/runs/R-3/att-R-3-2-deadbeef",
          reason: "多键探针",
          reopen_basis: [BASIS_REL],
          previous_result: { seq: statesOf()["R-3"].seq, event_id: statesOf()["R-3"].last_event_id, run_id: null, attempt_id: null },
          definition_sha256: null,
          baseline_id: null,
          smuggled: true,
        },
      });
    } catch (e) {
      keyRejected = isWorkError(e);
    }
    ok(keyRejected && eventCount() === before, "④ payload 闭键（多一个键）⇒ 拒且零字节");
  }

  // 合法重开 R-3 + 重复幂等：同一 request_id 再发 ⇒ duplicate、不另起 attempt
  {
    const before = eventCount();
    const r = await reopenTask({ ...base, role: "coordinator", request_id: "req-r3-1" }, service, dataDir);
    ok(r.ok === true && eventCount() === before + 1, "④ 合法重开 R-3 成功（幂等前置）");
    const attemptAfterFirst = statesOf()["R-3"].attempt ?? 0;
    const dup = await reopenTask({ ...base, role: "coordinator", request_id: "req-r3-1" }, service, dataDir);
    ok(
      dup.ok === true &&
        dup.duplicate === true &&
        eventCount() === before + 1 &&
        (statesOf()["R-3"].attempt ?? 0) === attemptAfterFirst,
      `④ 同一幂等键重复重开 ⇒ 回执 duplicate、不另起 attempt（attempt=${String(statesOf()["R-3"].attempt)}、事件数不变）`,
    );
  }
}

// ═════════════════════ ⑤ 重启回放一致 ═════════════════════
section("⑤ 删快照重放事件流：状态/attempt/历史链逐字节一致");
{
  const stateFile = path.join(workDir, "state.json");
  const statesBefore = JSON.stringify(statesOf());
  const snapshotBefore = fs.existsSync(stateFile) ? fs.readFileSync(stateFile, "utf8") : "";
  ok(snapshotBefore !== "", "⑤ 前置：快照已生成（提交链真落过盘）");
  fs.rmSync(stateFile, { force: true });
  service.repair(RW);
  const snapshotAfter = fs.existsSync(stateFile) ? fs.readFileSync(stateFile, "utf8") : "";
  const statesAfter = JSON.stringify(statesOf());
  ok(snapshotAfter === snapshotBefore, "⑤ 删 state.json 重建后快照逐字节一致");
  ok(statesAfter === statesBefore, "⑤ 重放后的任务状态（含 attempt/历史链）逐字节一致");
}

// ═════════════════════ ⑥ 未迁移项目不受影响 ═════════════════════
section("⑥ 未迁移项目：v1 行为不变、reopen 明确拒且零写入");
{
  const v1Work = path.join(v1Root, ".工作台", "work");
  const v1Tasks = path.join(v1Root, ".工作台", "tasks.json");
  const v1HashBefore = sha256File(v1Tasks);
  const gate = v1TaskWriteGate({ work_dir: v1Work, tasks_file: v1Tasks, what: "report_task_status" });
  ok(gate.allowed === true, "⑥ 未迁移项目的 v1 写闸照旧放行（行为逐字不变）");
  if (typeof reopenTask === "function") {
    const r = await reopenTask(
      {
        project_id: V1,
        task_id: "V-1",
        role: "coordinator",
        actor_id: COORD,
        change_id: CHANGE,
        reopen_basis: [BASIS_REL],
        reason: "未迁移项目探针",
      },
      service,
      dataDir,
    );
    ok(
      r.ok === false && !fs.existsSync(v1Work),
      `⑥ 未迁移项目重开 ⇒ 明确拒（无运行状态）且不建 v2 目录（${r.ok ? "（意外放行）" : r.code}）`,
    );
  }
  ok(sha256File(v1Tasks) === v1HashBefore, "⑥ 未迁移项目台账逐字节未动");
}

// ═════════════════════ 登记面对账 ═════════════════════
section("登记面：事件注册表 / 事件面 / MCP op 面");
{
  ok(
    REGISTERED_EVENT_TYPES.some((t) => t.type === "task.reopened" && t.entity_prefix === "task:"),
    "登记面：task.reopened 已注册（types.ts REGISTERED_EVENT_TYPES）",
  );
  ok(EVENT_SURFACE["task.reopened"] === "mcp:claim_task", "登记面：事件面登记 task.reopened → mcp:claim_task");
  const opDesc = JSON.stringify(claimTaskTool.inputSchema.properties ?? {});
  ok(opDesc.includes("reopen"), "登记面：claim_task 的 op enum 含 reopen（不新增工具）");
  const desc = claimTaskTool.description + JSON.stringify(claimTaskTool.inputSchema);
  ok(desc.includes("coordinator") && desc.includes("reopen_basis"), "登记面：claim_task 说明 reopen 为协调器专用并要 reopen_basis");
}

// MCP 工具面端到端（op=reopen 走真 handler + 真写入服务；R-3 当前是重开后的 ready 态——先补一次提交再经 MCP 重开）
section("MCP 端到端：claim_task op=reopen 真 handler");
if (typeof reopenTask !== "function") {
  ok(false, "MCP 端到端可跑（红：reopenTask 未实现）");
} else {
  const r3b = statesOf()["R-3"];
  if (r3b.status !== "ready") throw new Error("夹具缺陷：R-3 状态不在预期 ready");
  const c3 = await claimTask(
    { project_id: RW, task_id: "R-3", role: "executor", owner_id: EXEC, change_id: CHANGE, now: PAST },
    service,
    dataDir,
  );
  if (!c3.ok) throw new Error(`夹具缺陷：R-3 新 attempt 认领被拒 ${c3.code}`);
  const s3 = await submitTaskResult(
    {
      project_id: RW,
      task_id: "R-3",
      role: "executor",
      owner_id: EXEC,
      change_id: CHANGE,
      claim_token: c3.claim.claim_token,
      expected_revision: c3.receipt.entity_revision,
      deliverables: ["R-3 交付"],
      evidence_refs: [BASIS_REL],
      untested: [],
      ownership_basis: "夹具时钟：旧租约已过期",
    },
    { submitter: service },
    dataDir,
  );
  if (!s3.ok) throw new Error(`夹具缺陷：R-3 提交被拒 ${s3.code}`);
  const before = eventCount();
  const res = await claimTaskTool.handler(
    {
      op: "reopen",
      project_id: RW,
      task_id: "R-3",
      role: "coordinator",
      change_id: CHANGE,
      reopen_basis: [BASIS_REL],
      reason: "MCP handler 端到端重开",
      request_id: "req-r3-mcp-1",
    },
    { work: service, clientName: "v0910-verify" } as never,
  );
  const st3 = statesOf()["R-3"];
  ok(
    res.isError !== true && eventCount() === before + 1 && st3.status === "ready" && st3.attempt === 3,
    `MCP claim_task(op=reopen) 端到端成功（R-3 attempt=${String(st3.attempt)}、回 ready）`,
  );
  const bad = await claimTaskTool.handler(
    { op: "reopen", project_id: RW, task_id: "R-3", role: "executor", change_id: CHANGE, reopen_basis: [BASIS_REL], reason: "x" },
    { work: service, clientName: "v0910-verify" } as never,
  );
  ok(bad.isError === true && eventCount() === before + 1, "MCP 面 executor 角色 reopen ⇒ 结构化拒绝且零写入");
}

// ── 真实账本零写入自证（首尾对照）──
section("隔离自证：真实账本零写入");
if (realLedger === null || realLedgerHashBefore === null) {
  info("（真实账本取不到，本段 SKIP）");
} else {
  const after = sha256File(realLedger.file);
  ok(after === realLedgerHashBefore, `隔离自证：真实账本 sha256 前后一致（${realLedgerHashBefore.slice(0, 16)}…）`);
}

console.log(`\n[verify] 汇总：${pass} PASS / ${fail} FAIL`);
console.log(process.exitCode ? "[verify] 存在 FAIL" : "[verify] 全部 PASS");
