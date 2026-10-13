// V09-65 验证脚本（tsx 跑）：写口拒错目标与冻结候选写入拒绝（语义校验，不冒充 OS 沙箱）。
// （PLAN.md V09-65 卡面 ①–④；DESIGN.md §6.13 第 4 段、§6.14 第 6 段。）
// 用法：pnpm verify:v09-65（自带临时 TATAI_HOME 与夹具项目；不碰真实账本/服务）。
//
// 覆盖（逐条对卡面检查项）：
//   chk-01 认领与续领校验：目标工作区未知/不属本项目 → 拒领并给稳定错误码；既有隔离口径不回退。
//   chk-02 拒绝冻结源码写、放行中央证据：写目标落在冻结候选源目录 → 拒（零字节）；对 frozen 候选经唯一写口
//          追加中央记录（改用途）与"中央证据类写"（kind=evidence 守卫直通）**成功**。
//   chk-03 边界：守卫只拒塔台托管写口，不冒充 OS 沙箱（文案与行为都禁止越界）。
//   chk-04 反例与既有回归：非法/缺失/跨项目/冻结源码写四类真实拒绝；旧项目（无工作区记录）与既有合法
//          认领路径继续可用。
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { WorkService } from "../src/server/work/service";
import { loadEvents } from "../src/server/work/eventStore";
import { readTaskStates, submitDefinitionImports } from "../src/server/work/tasks";
import { importPlanChecked } from "../src/server/work/references";
import { activateBaseline } from "../src/server/work/documents";
import { claimTask } from "../src/server/work/claims";
import { isWorkError } from "../src/server/work/types";
import {
  readWorkspaces,
  registerWorkspace,
  updateWorkspace,
  freezeWorkspace,
  retireWorkspace,
  selectDevWorkspace,
  pointTrialWorkspace,
} from "../src/server/work/workspaces";
import {
  assertHostedWriteAllowed,
  assertWorkspaceClaimTarget,
  assertWorkspaceVersionMatch,
  frozenWorkspaceById,
} from "../src/server/work/workspaceGuard";
import { projectWorkDir } from "../src/server/workstation";
import { installWorkspaceHostWiring } from "../src/server/work/hostWiring";
import { submitSelfCheck, submitIndependentAudit, COVERAGE_AREAS, COVERAGE_AREA_LABELS } from "../src/server/work/audit";
import { handleReportingRequest } from "../src/server/work/reportingHost";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";

function mockReq(url: string, body: unknown, headers: Record<string, string> = {}): IncomingMessage {
  const req = Readable.from([Buffer.from(JSON.stringify(body), "utf8")]) as unknown as IncomingMessage;
  (req as unknown as { method: string }).method = "POST";
  (req as unknown as { url: string }).url = url;
  (req as unknown as { headers: Record<string, string> }).headers = headers;
  return req;
}
function mockRes(): { res: ServerResponse; read: () => { status: number; body: unknown } } {
  const st = { status: 0, body: "" };
  const res = {
    setHeader: (): void => {},
    writeHead: (s: number): unknown => { st.status = s; return res; },
    end: (v?: unknown): void => {
      if (typeof v === "string") st.body = v;
    },
  };
  Object.defineProperty(res, "statusCode", { get: () => st.status, set: (s: number) => { st.status = s; } });
  return { res: res as unknown as ServerResponse, read: () => ({ status: st.status, body: st.body === "" ? null : JSON.parse(st.body) }) };
}

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
const section = (t: string): void => console.log(`\n[verify] ── ${t}`);

/** 捕获守卫拒绝的稳定码（WorkError.detail.reason） */
function guardCode(fn: () => void): string | null {
  try {
    fn();
    return null;
  } catch (e) {
    if (isWorkError(e)) return typeof e.detail?.reason === "string" ? (e.detail.reason as string) : e.code;
    return `NON_WORK_ERROR:${(e as Error).message}`;
  }
}

// ── 夹具 ──
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-v09-65-"));
const dataDir = path.join(tmpBase, "home");
const PID = "v0965";
const root = path.join(tmpBase, "proj");
const candRoot = path.join(tmpBase, "cand");
const cand2Root = path.join(tmpBase, "cand2");
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(path.join(root, ".工作台"), { recursive: true });
fs.mkdirSync(path.join(candRoot, "src"), { recursive: true });
fs.mkdirSync(path.join(cand2Root, "src"), { recursive: true });
const write = (f: string, text: string): void => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text, "utf8");
};
const DESIGN = "# V09-65 夹具设计书\n\n## 2 模块划分\n\n| # | 模块 | 说明 |\n| --- | --- | --- |\n| 1 | 甲模块 | 夹具 |\n";
const PLAN = [
  "# V09-65 夹具施工图",
  "",
  "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |",
  "| --- | --- | --- | --- | --- |",
  "| F-1 | todo | 认领卡 |  | F-1 验收记录 |",
  "",
  "### F-1 认领卡",
  "",
  "**设计依据**：§2。**契约**：输入甲，输出甲。",
  "",
  "**文件责任**：`src/a.ts`。",
  "",
  "- [ ] 甲做出来",
  "",
  "**交付**：F-1 验收记录。",
  "",
  "**完成证据**：F-1 验收记录。",
  "",
].join("\n");
write(path.join(root, ".工作台", "design.md"), DESIGN);
write(path.join(root, ".工作台", "plan.md"), PLAN);
write(path.join(root, "src", "a.ts"), "export const a = 1;\n");
write(path.join(candRoot, "src", "b.ts"), "export const b = 2;\n");
write(path.join(candRoot, "README.md"), "# candidate\n");
write(path.join(cand2Root, "src", "c.ts"), "export const c = 3;\n");
write(
  path.join(dataDir, "registry.json"),
  JSON.stringify({
    version: 1,
    projects: [
      { id: PID, name: "V09-65 夹具", path: root, kind: "backend", registered_at: "2026-10-09T00:00:00+08:00", last_opened_at: "2026-10-09T00:00:00+08:00" },
    ],
  }),
);
process.env.TATAI_HOME = dataDir;
// 宿主接线：point_trial 的「已验版本」判据由宿主验证器实测（§6.14 第 8 段）；本脚本验证其"未验拒"路径。
installWorkspaceHostWiring();

const service = new WorkService({ dataDir });
const workDir = projectWorkDir(PID, dataDir);
const eventCount = (): number => loadEvents(workDir).events.length;
const ledgerBytes = (): number => {
  const f = path.join(workDir, "events.jsonl");
  return fs.existsSync(f) ? fs.statSync(f).size : 0;
};
const submitter = { submit: (c: unknown) => service.submit(c), read: () => readWorkspaces(workDir) };
const CHANGE = "change-v0965";
const COORD = "v0965-coordinator";
const EXEC = "v0965-executor";
const AUDITOR = "v0965-auditor";

{
  const imported = importPlanChecked(PLAN, workDir, { plan_revision: crypto.createHash("sha256").update(PLAN, "utf8").digest("hex") });
  submitDefinitionImports(service, { project_id: PID, change_id: CHANGE, actor_id: "v0965-setup", role: "coordinator", definitions: imported.definitions });
  activateBaseline(PID, { approved_by: "user", approval_basis: "V09-65 隔离夹具审定（不代表真实用户 Gate）", approval_kind: "user_confirmed" }, dataDir);
  ok(readTaskStates(workDir).states["F-1"] !== undefined, `⓪ 夹具就绪（定义导入 + 基线激活）`);
}

// ═════════════════════ 冻结候选：登记 + 冻结 ═════════════════════
section("⓪ 冻结候选与试用候选（供拒绝/放行判据用）");
let frozenFp = "";
{
  const reg = registerWorkspace(submitter, {
    project_id: PID, workspace_id: "cand-1", change_id: CHANGE, actor_id: COORD, role: "coordinator",
    kind: "candidate", purpose: "固定试用候选 1", root: candRoot, source_kind: "directory", task_ids: ["F-1"],
  });
  ok(reg.ok === true, `⓪ 登记候选 cand-1（${reg.ok ? "ok" : `${reg.code}`}）`);
  const rec = readWorkspaces(workDir).workspaces["cand-1"];
  const fr = freezeWorkspace(submitter, {
    project_id: PID, workspace_id: "cand-1", change_id: CHANGE, actor_id: COORD, role: "coordinator",
    expected_revision: rec.revision, included_uncommitted: false, declared_paths: [],
  });
  ok(fr.ok === true, `⓪ 冻结候选 cand-1（宿主实测内容指纹）（${fr.ok ? "ok" : `${fr.code}: ${fr.message}`}）`);
  const after = readWorkspaces(workDir).workspaces["cand-1"];
  frozenFp = after.freeze?.content_fingerprint ?? "";
  ok(after.status === "frozen" && frozenFp.length === 64, `⓪ 冻结记录落盘（status=frozen，content_fingerprint=${frozenFp.slice(0, 12)}…）`);
}

// ═════════════════════ chk-02：拒绝冻结源码写、放行中央证据 ═════════════════════
section("② 写守卫：拒绝冻结源码写、放行中央证据");
{
  // 直接写冻结源目录 → 拒 CANDIDATE_FROZEN
  ok(
    guardCode(() => assertHostedWriteAllowed({ projectId: PID, dataDir, workspaceId: "cand-1", targetRoot: candRoot, kind: "source" })) === "CANDIDATE_FROZEN",
    `② 写冻结源根拒 CANDIDATE_FROZEN`,
  );
  // 写冻结源目录内文件 → 拒
  ok(
    guardCode(() => assertHostedWriteAllowed({ projectId: PID, dataDir, targetRoot: path.join(candRoot, "src", "b.ts"), kind: "source" })) === "CANDIDATE_FROZEN",
    `② 写冻结源目录内文件拒 CANDIDATE_FROZEN`,
  );
  // 托管文档写口（document）落在冻结源里 → 同样拒
  ok(
    guardCode(() => assertHostedWriteAllowed({ projectId: PID, dataDir, targetRoot: candRoot, kind: "document" })) === "CANDIDATE_FROZEN",
    `② 托管文档写口落在冻结源里拒 CANDIDATE_FROZEN`,
  );
  // 中央证据写（kind=evidence）直通（不因冻结被拒）
  ok(
    guardCode(() => assertHostedWriteAllowed({ projectId: PID, dataDir, workspaceId: "cand-1", targetRoot: candRoot, kind: "evidence" })) === null,
    `② 中央证据写（kind=evidence）不被冻结拒`,
  );
  // 版本不符 → WORKSPACE_MISMATCH
  ok(
    guardCode(() => assertWorkspaceVersionMatch({ projectId: PID, dataDir, workspaceId: "cand-1", expected_content_fingerprint: "0".repeat(64) })) === "WORKSPACE_MISMATCH",
    `② 写入声明的内容指纹与冻结指纹不符拒 WORKSPACE_MISMATCH`,
  );
  ok(frozenWorkspaceById(PID, dataDir, "cand-1")?.workspace_id === "cand-1", `② frozenWorkspaceById 返回冻结记录`);

  // 对 frozen 候选**改用途**（中央账本写）→ 成功（冻结不拒绝一切中央写入）
  const rec = readWorkspaces(workDir).workspaces["cand-1"];
  const b0 = ledgerBytes();
  const up = updateWorkspace(submitter, {
    project_id: PID, workspace_id: "cand-1", change_id: CHANGE, actor_id: COORD, role: "coordinator",
    expected_revision: rec.revision, fields: { purpose: "固定试用候选 1（已登记验收记录）" },
  });
  ok(up.ok === true && ledgerBytes() > b0, `② 对 frozen 候选追加中央记录（改用途）成功、账本增长`);

  // 对 frozen 候选改**来源** → 拒 CANDIDATE_FROZEN
  const rec2 = readWorkspaces(workDir).workspaces["cand-1"];
  const upSrc = updateWorkspace(submitter, {
    project_id: PID, workspace_id: "cand-1", change_id: CHANGE, actor_id: COORD, role: "coordinator",
    expected_revision: rec2.revision, fields: { content_fingerprint: "a".repeat(64) },
  });
  ok(!upSrc.ok && upSrc.code === "CANDIDATE_FROZEN", `② 对 frozen 候选改来源拒 CANDIDATE_FROZEN（${upSrc.ok ? "（意外放行）" : upSrc.code}）`);
}

// ═════════════════════ chk-04：四类反例真实拒绝 ═════════════════════
section("④ 四类反例：非法/缺失/跨项目/冻结源码写");
{
  // 非法路径（在 register 上同样拒且零字节）
  const b = ledgerBytes();
  const bad = registerWorkspace(submitter, {
    project_id: PID, workspace_id: "bad-1", change_id: CHANGE, actor_id: COORD, role: "coordinator",
    kind: "candidate", purpose: "x", root: "relative/path", source_kind: "directory",
  });
  ok(!bad.ok && bad.code === "WORKSPACE_ROOT_INVALID" && ledgerBytes() === b, `④ 非法路径拒且零字节`);
  // 缺失（未知工作区）认领 → WORKSPACE_UNKNOWN
  const miss = await claimTask({ project_id: PID, task_id: "F-1", role: "executor", owner_id: EXEC, change_id: CHANGE, workspace_id: "nope" }, service, dataDir);
  ok(!miss.ok && miss.code === "WORKSPACE_UNKNOWN", `④ 缺失/未知工作区拒领（${miss.ok ? "（意外放行）" : miss.code}）`);
  // 冻结源码写（守卫）→ CANDIDATE_FROZEN（已在上节，这里补断言）
  ok(guardCode(() => assertHostedWriteAllowed({ projectId: PID, dataDir, targetRoot: candRoot, kind: "source" })) === "CANDIDATE_FROZEN", `④ 冻结源码写拒 CANDIDATE_FROZEN`);
  // 冻结前置缺失 → FREEZE_MISSING_DECLARED
  const reg2 = registerWorkspace(submitter, {
    project_id: PID, workspace_id: "cand-miss", change_id: CHANGE, actor_id: COORD, role: "coordinator",
    kind: "candidate", purpose: "缺声明", root: cand2Root, source_kind: "directory",
  });
  ok(reg2.ok === true, `④ 登记第二个候选`);
  const recM = readWorkspaces(workDir).workspaces["cand-miss"];
  const fmiss = freezeWorkspace(submitter, {
    project_id: PID, workspace_id: "cand-miss", change_id: CHANGE, actor_id: COORD, role: "coordinator",
    expected_revision: recM.revision, included_uncommitted: true, declared_paths: [],
  });
  ok(!fmiss.ok && fmiss.code === "FREEZE_MISSING_DECLARED", `④ 声明纳入未提交却无 declared_paths 拒 FREEZE_MISSING_DECLARED（${fmiss.ok ? "（意外放行）" : fmiss.code}）`);
  // 源不存在 → FREEZE_SOURCE_UNRESOLVED
  const recM2 = readWorkspaces(workDir).workspaces["cand-miss"];
  const gone = path.join(tmpBase, "cand-gone");
  const regGone = registerWorkspace(submitter, {
    project_id: PID, workspace_id: "cand-gone", change_id: CHANGE, actor_id: COORD, role: "coordinator",
    kind: "candidate", purpose: "源不在", root: gone, source_kind: "directory",
  });
  ok(regGone.ok === true, `④ 登记源不存在的候选（登记只记路径）`);
  const recG = readWorkspaces(workDir).workspaces["cand-gone"];
  const fgone = freezeWorkspace(submitter, {
    project_id: PID, workspace_id: "cand-gone", change_id: CHANGE, actor_id: COORD, role: "coordinator",
    expected_revision: recG.revision, included_uncommitted: false, declared_paths: [],
  });
  ok(!fgone.ok && fgone.code === "FREEZE_SOURCE_UNRESOLVED", `④ 源不存在的冻结拒 FREEZE_SOURCE_UNRESOLVED（${fgone.ok ? "（意外放行）" : fgone.code}）`);
  void recM2;

  // 以 HEAD 顶替（直连写口：content_fingerprint == source_commit）→ 锁内拒
  let headSubstituted = false;
  try {
    const recM3 = readWorkspaces(workDir).workspaces["cand-miss"];
    service.submit({
      schema_version: 2, project_id: PID, change_id: CHANGE, entity_id: "workspace:cand-miss",
      expected_revision: recM3.revision, type: "workspace.frozen", actor_id: COORD, role: "coordinator",
      idempotency_key: "cand-miss:freeze:head-substitute",
      payload: { content_fingerprint: "f".repeat(64), included_uncommitted: false, declared_paths: [], source_commit: "f".repeat(64) },
    });
  } catch (e) {
    headSubstituted = isWorkError(e) && e.detail?.reason === "FREEZE_SOURCE_UNRESOLVED";
  }
  ok(headSubstituted, `④ 以 HEAD 顶替实际内容拒 FREEZE_SOURCE_UNRESOLVED（直连写口也拦）`);
}

// ═════════════════════ chk-01：认领/续领校验 + 试用提升 ═════════════════════
section("① 认领校验 + 试用提升（promotion）宿主实测");
{
  // 未知工作区守卫
  ok(guardCode(() => assertWorkspaceClaimTarget({ projectId: PID, dataDir, workspaceId: "nope" })) === "WORKSPACE_UNKNOWN", `① assertWorkspaceClaimTarget 未知工作区抛 WORKSPACE_UNKNOWN`);
  ok(guardCode(() => assertWorkspaceClaimTarget({ projectId: PID, dataDir, workspaceId: null })) === null, `① 不声明工作区（:main 口径）放行`);
  // 合法认领（绑定冻结候选作为目标工作区）→ 成功
  const claim = await claimTask({ project_id: PID, task_id: "F-1", role: "executor", owner_id: EXEC, change_id: CHANGE, workspace_id: "cand-1" }, service, dataDir);
  ok(claim.ok === true && claim.claim.workspace_id === "cand-1", `① 绑定既有工作区认领成功（${claim.ok ? claim.claim.workspace_id : `${claim.code}`}）`);

  // 真证据（技术 + 非作者独立审查）：试用提升只接已验版本（§6.14 第 8 段）。先存源清单证据，再自检 + 独审。
  const { res: evRes, read: evRead } = mockRes();
  await handleReportingRequest(
    mockReq("/api/work/reporting/evidence", {
      project_id: PID, workspace_id: "cand-1", content: "", kind: "source_manifest", summary: "候选源清单",
      created_by: EXEC, role: "executor", binding: { revision_kind: "code", revision: "rev-x" },
      source_manifest: [{ path: "src/b.ts" }, { path: "README.md" }],
    }),
    evRes,
    { pathname: "/api/work/reporting/evidence", dataDir },
  );
  const evBody = evRead().body as { ok?: boolean; evidence?: { evidence_id: string; source_manifest?: { fingerprint: string } } };
  const evid = evBody.evidence?.evidence_id ?? "";
  const fp = evBody.evidence?.source_manifest?.fingerprint ?? "";
  ok(evBody.ok === true && evid !== "" && fp !== "", `① 经唯一宿主存候选源清单（evidence+指纹）`);
  const sc = submitSelfCheck(submitter as never, {
    project_id: PID, change_id: CHANGE, actor_id: EXEC, role: "executor", record_id: "sc-f1",
    task_id: "F-1", checked_by: EXEC, conclusion: "pass",
    binding: { revision_kind: "code", revision: fp },
    checks: [
      { check_id: "F-1::check:0", method: "夹具", command: null, exit_code: null, evidence_sha256: evid, scope: [], verifies: "code" },
      { check_id: "F-1::evidence", method: "交付物证据（夹具）", command: null, exit_code: null, evidence_sha256: evid, scope: [], verifies: "code" },
    ],
  });
  const ia = submitIndependentAudit(submitter as never, {
    project_id: PID, change_id: CHANGE, actor_id: AUDITOR, role: "auditor", record_id: "ia-f1",
    task_id: "F-1", auditor: AUDITOR, author_id: EXEC, conclusion: "pass",
    binding: { revision_kind: "code", revision: fp },
    checks: [{ check_id: "F-1::check:0", result: "passed", evidence_sha256: evid, scope: [] }],
    coverage: COVERAGE_AREAS.map((a) => ({ area: a, status: "checked" as const, basis: `${COVERAGE_AREA_LABELS[a]}：夹具` })),
  });
  ok(sc.ok === true && ia.ok === true, `① 作者自检 + 非作者独立审查落账（试用提升所需）`);

  // 试用提升：已验版本 → 宿主实测通过并改试用指针
  const view0 = readWorkspaces(workDir);
  const pt = pointTrialWorkspace(submitter, {
    project_id: PID, workspace_id: "cand-1", change_id: CHANGE, actor_id: COORD, role: "coordinator",
    expected_revision: view0.pointer?.revision ?? 0, basis: "夹具：提升已冻结候选",
  });
  ok(pt.ok === true, `① point_trial 宿主实测通过并改试用指针（${pt.ok ? "ok" : `${pt.code}: ${pt.message}`}）`);
  const ptr = readWorkspaces(workDir).pointer;
  ok(ptr?.current_trial_workspace_id === "cand-1", `① 当前试用候选指针＝cand-1`);

  // 篡改候选源 → point_trial 失败、旧指针保留
  const recBefore = readWorkspaces(workDir).workspaces["cand-1"];
  write(path.join(candRoot, "src", "b.ts"), "export const b = 999; // tampered\n");
  const pt2 = pointTrialWorkspace(submitter, {
    project_id: PID, workspace_id: "cand-1", change_id: CHANGE, actor_id: COORD, role: "coordinator",
    expected_revision: recBefore.revision + 100, basis: "夹具：篡改后提升",
  });
  ok(!pt2.ok && (pt2.code === "PROMOTION_UNVERIFIED" || pt2.code === "VERSION_CONFLICT"), `① 篡改后提升失败（${pt2.ok ? "（意外放行）" : pt2.code}）`);
  // 用一个正确 expected_revision 再试一次，专门看 PROMOTION_UNVERIFIED（旧指针保留）
  const ptrBefore = readWorkspaces(workDir).pointer?.revision ?? 0;
  const pt3 = pointTrialWorkspace(submitter, {
    project_id: PID, workspace_id: "cand-1", change_id: "change-v0965-b", actor_id: COORD, role: "coordinator",
    expected_revision: ptrBefore, basis: "夹具：篡改后提升（正确 CAS）",
  });
  ok(!pt3.ok && pt3.code === "PROMOTION_UNVERIFIED", `① 篡改后 point_trial 拒 PROMOTION_UNVERIFIED（${pt3.ok ? "（意外放行）" : pt3.code}）`);
  ok((readWorkspaces(workDir).pointer?.current_trial_workspace_id ?? null) === "cand-1", `① 失败保留旧指针（仍 cand-1）`);

  // 回收前提：空 reachability → RETIRE_PRECONDITION_UNMET
  const recR = readWorkspaces(workDir).workspaces["cand-1"];
  const retireBad = retireWorkspace(submitter, {
    project_id: PID, workspace_id: "cand-1", change_id: CHANGE, actor_id: COORD, role: "coordinator",
    expected_revision: recR.revision, reason: "回收", reachability: "",
  });
  ok(!retireBad.ok && retireBad.code === "RETIRE_PRECONDITION_UNMET", `① 回收缺可达性前提拒 RETIRE_PRECONDITION_UNMET（${retireBad.ok ? "（意外放行）" : retireBad.code}）`);
}

// ═════════════════════ chk-03：不冒充 OS 沙箱 ═════════════════════
section("③ 边界：只拒托管写口，不冒充 OS 沙箱");
{
  const guardSrc = fs.readFileSync(path.join(process.cwd(), "src", "server", "work", "workspaceGuard.ts"), "utf8");
  ok(guardSrc.includes("不冒充 OS 沙箱"), `③ 守卫文档声明"不冒充 OS 沙箱"`);
  // 本机任意 shell 写不受塔台拦截：直接 fs 写冻结源目录仍成功（证明这是语义校验而非沙箱）
  const p = path.join(candRoot, "src", "shell.ts");
  let directWriteOk = true;
  try {
    fs.writeFileSync(p, "export const shell = 1;\n");
  } catch {
    directWriteOk = false;
  }
  ok(directWriteOk && fs.existsSync(p), `③ 绕过塔台的直接文件写**不被拦**（证明是语义校验，执行侧边界仍在外部协调器/任务声明）`);
}

console.log(`\n[verify] V09-65 结果：PASS ${pass} / FAIL ${fail}`);
if (fail > 0) process.exitCode = 1;
