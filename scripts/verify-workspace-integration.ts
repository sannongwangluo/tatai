// V09-64/66 集成验证（tsx 跑）：把「冻结候选来源 → 正式存证/义务派生 → 交付读数 → 真实 Git 收尾」真正打通，
// 走**生产 API 调用链**（manage_workspace MCP 工具 / reportingHost HTTP / readFeatureLedger 同底层 / gitFinalizeHost
// HTTP 路由），不是单函数 fixture、不是 mock 探针。
//
// ⚠ 口径：本脚本的 HTTP 面是**进程内路由 CPU 路径**（mockReq/mockRes 直调处理器），**不代表已真实监听端口或
//    已跑新 stdio 客户端**——真实跨进程 host + fresh stdio 的端到端见 `verify-workspace-host-e2e.ts`。
//
// 覆盖（对应复审 CANDIDATE-READOUT-R3 / CORE-R4-REVIEW 的接缝真实缺口）：
//  ① 冻结统一候选引用（事件只存 ≤64KiB 紧凑引用，可取回并核内容指纹）；未验时 point_trial 拒（保留旧指针）；
//  ② 真证据齐备后才允许试用提升（宿主实测已验版本）；
//  ③ featureLedger 真实 resolveCandidateSource：present / tampered 降级；开发目录变化不机械失效；
//  ④ gitFinalizeHost 真实证据链：未授权拒（零副作用）→ 技术+独审通过 → 真 commit → 幂等重试复用（不双 commit）；
//  ⑤ 工作包 completion.finalize 的 finalize_local_commit 机器可执行下一步（合格+已授权时给真实参数）；
//  ⑥ 同版本：HTTP / MCP / entry 三处读回同一 workspace 结论；
//  ⑪ 全批授权：本批**实际纳入变化**对应的每个任务都要同候选通过技术+独审（T2 未验拒、T2 验后真提交）；
//  ⑫ 已回收候选：retire 后移除候选目录，同版证据与显式 feature_ledger 仍可按同版恢复读取（不判失效）；
//  ⑬ 指针补丁：select_dev 只改开发指针、保留试用指针（反之亦然）；
//  ⑭ 冻结引用损坏：新格式引用损坏如实标失效，**不**按旧口径回落工作区根。
//
// 自带隔离环境（临时 TATAI_HOME + os.tmpdir() 夹具 + 真实临时 Git 仓库），**不碰**任何真实项目/账本/生产服务。
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { execFileSync } from "node:child_process";

import { WorkService, WORK_TOKEN_HEADER } from "../src/server/work/service";
import { addProject } from "../src/server/registry";
import { projectWorkDir } from "../src/server/workstation";
import { activateBaseline, buildSectionIndex } from "../src/server/work/documents";
import { importTaskDefinitions } from "../src/server/work/plan";
import { submitDefinitionImports } from "../src/server/work/tasks";
import { registerRequirement } from "../src/server/work/requirements";
import { claimTask } from "../src/server/work/claims";
import { submitSelfCheck, submitIndependentAudit, COVERAGE_AREAS, COVERAGE_AREA_LABELS } from "../src/server/work/audit";
import { openFinding, readFindings } from "../src/server/work/evidence";
import { readFeatureLedger } from "../src/server/work/featureLedger";
import { evaluateProjectEntry } from "../src/server/work/entry";
import { featureLedgerTool } from "../src/mcp/tools/featureLedger";
import { manageWorkspaceTool } from "../src/mcp/tools/workspaceTools";
import { handleReportingRequest } from "../src/server/work/reportingHost";
import { handleFinalizeRequest } from "../src/server/work/gitFinalizeHost";
import { installWorkspaceHostWiring, scopeRootOf } from "../src/server/work/hostWiring";
import { inspectCandidateSource, parseCandidateIndexRef, readCandidateIndex } from "../src/server/work/candidateSource";
import { readWorkspaces, resolveFrozenCandidateSource } from "../src/server/work/workspaces";
import { evidenceManifestRootVerdict } from "../src/server/work/evidence";
import { verifySourceManifest } from "../src/server/work/sourceEvidence";

let pass = 0;
let fail = 0;
const ok = (cond: boolean, label: string, detail?: unknown): void => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (cond) pass++;
  else {
    fail++;
    process.exitCode = 1;
    if (detail !== undefined) console.log(`[verify]   现场：${JSON.stringify(detail).slice(0, 1500)}`);
  }
};
const section = (t: string): void => console.log(`\n[verify] ═══ ${t}`);
const sha256 = (b: string | Buffer): string => crypto.createHash("sha256").update(b).digest("hex");

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-wsint-"));
const dataDir = path.join(tmpBase, "home");
fs.mkdirSync(dataDir, { recursive: true });
process.env.TATAI_HOME = dataDir;
installWorkspaceHostWiring();

const P = "wsint";
const projRoot = path.join(tmpBase, "proj");
const candRoot = path.join(tmpBase, "cand");
const CHANGE = "change-wsint";
const COORD = "wsint-coord";
const EXEC = "wsint-exec";
const AUDITOR = "wsint-auditor";
const WS = "ws-cand";

const write = (f: string, text: string): void => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text, "utf8");
};
function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

// ── mock HTTP req/res（走生产路由 CPU 路径，不连网） ──
function mockReq(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): IncomingMessage {
  const text = body === undefined ? "" : JSON.stringify(body);
  const req = Readable.from([Buffer.from(text, "utf8")]) as unknown as IncomingMessage;
  (req as unknown as { method: string }).method = method;
  (req as unknown as { url: string }).url = url;
  (req as unknown as { headers: Record<string, string> }).headers = headers;
  return req;
}
function mockRes(): { res: ServerResponse; read: () => { status: number; body: unknown } } {
  const st = { status: 0, body: "" };
  const res = {
    setHeader: (): void => {},
    writeHead: (s: number): unknown => {
      st.status = s;
      return res;
    },
    end: (v?: unknown): void => {
      if (typeof v === "string") st.body = v;
      else if (Buffer.isBuffer(v)) st.body = v.toString("utf8");
      else if (v !== undefined) st.body = String(v);
    },
  };
  Object.defineProperty(res, "statusCode", {
    get: () => st.status,
    set: (s: number) => {
      st.status = s;
    },
  });
  return { res: res as unknown as ServerResponse, read: () => ({ status: st.status, body: st.body === "" ? null : (JSON.parse(st.body) as unknown) }) };
}

const service = new WorkService({ dataDir });
const work = { submit: (c: unknown) => service.submit(c) };

/** 建一个带 DESIGN/PLAN/需求/基线的项目（返回 workDir） */
function setupProject(
  id: string,
  root: string,
  planText: string,
  designText: string,
  changeId: string,
): string {
  fs.mkdirSync(path.join(root, ".工作台"), { recursive: true });
  write(path.join(root, ".工作台", "design.md"), designText);
  write(path.join(root, ".工作台", "plan.md"), planText);
  addProject({ id, name: id, path: root, kind: "backend" }, dataDir);
  registerRequirement(work as never, {
    project_id: id, requirement_id: "req-t", change_id: changeId, actor_id: "fixture", role: "designer",
    source: { kind: "user", ref: "夹具" }, problem: "夹具需求", users: [], success_scenarios: [], exclusions: [],
    priority: "P1", status: "explicit",
  });
  submitDefinitionImports(service, {
    project_id: id, change_id: changeId, actor_id: "fixture", role: "coordinator",
    definitions: importTaskDefinitions(planText, { plan_revision: sha256(planText) }).definitions,
  });
  activateBaseline(id, { approved_by: "user", approval_basis: "wsint 夹具审定（非用户 Gate）", approval_kind: "user_confirmed" }, dataDir);
  return projectWorkDir(id, dataDir);
}

const DECL_HEAD = [
  "| 功能 ID | 人话功能名 | 需求 ID | 设计章节 | 本期范围（scope_id） | 覆盖结论 | 依据/缺口（review） | 使用结果与场景 |",
  "| --- | --- | --- | --- | --- | --- | --- | --- |",
];
const planText = [
  "# 施工图",
  "",
  "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |",
  "| --- | --- | --- | --- | --- |",
  "| T-1 | todo | 集成卡 |  | 证据齐 |",
  "",
  "### T-1 集成卡",
  "",
  "**设计依据**：§3.5。**依赖**：无。**文件责任**：`a.txt`。",
  "",
  "- [ ] **chk-t-1-01 达标 [独立审计]**",
  "",
  "| 功能 ID | 人话功能名 | 承接卡 | 必需检查 | 集成检查 | 结果状态 |",
  "| --- | --- | --- | --- | --- | --- |",
  "| cap-t | 集成功能 | T-1 | chk-t-1-01 | int-t-01 | 未验 |",
  "",
  "## 集成检查要求",
  "",
  "| 对象 ID | 检查 ID | 说明 | 必需性 |",
  "| --- | --- | --- | --- |",
  "| cap-t | int-t-01 | 端到端集成 | 必需 |",
  "",
].join("\n");
const designDraft = [
  "# 设计书",
  "",
  "### 3.5 目标章节",
  "",
  "正文。",
  "",
  "#### 功能清单声明（夹具）",
  "",
  DECL_HEAD[0],
  DECL_HEAD[1],
  "| cap-t | 集成功能 | req-t | §3.5 | cap-t | 待审 | reviewer=; ref=DESIGN.md#3.5; section_sha256=SECT; gap=x | 场景 |",
  "",
].join("\n");
const sectSha = buildSectionIndex(designDraft).find((s) => s.title.startsWith("3.5 "))?.sha256 ?? "";
const designText = designDraft.replace("section_sha256=SECT", `section_sha256=${sectSha}`);

// ── 夹具 Git 候选仓库：base 提交 + 一个未提交改动（冻结时纳入） ──
fs.mkdirSync(candRoot, { recursive: true });
git(candRoot, ["init", "-q", "-b", "main"]);
git(candRoot, ["config", "user.email", "wsint@test"]);
git(candRoot, ["config", "user.name", "wsint"]);
write(path.join(candRoot, "a.txt"), "v1\n");
write(path.join(candRoot, "keep.txt"), "keep\n");
git(candRoot, ["add", "-A"]);
git(candRoot, ["commit", "-q", "-m", "base"]);
const baseHead = git(candRoot, ["rev-parse", "HEAD"]).trim();
write(path.join(candRoot, "a.txt"), "v2-modified\n");

const workDir = setupProject(P, projRoot, planText, designText, CHANGE);
const mcpCtx = { clientName: "wsint-mcp", work } as never;
const projectIds = new Set<string>([P]);
const exists = (id: string): boolean => projectIds.has(id);

// ═════════════════════ ① 冻结统一候选引用 ═════════════════════
section("① 冻结统一候选引用：事件存 ≤64KiB 紧凑引用，可取回并核内容指纹；未验拒提升");
const expectedFp = inspectCandidateSource({ root: candRoot, included_uncommitted: true, declared_paths: ["a.txt"] }).content_fingerprint;
{
  const reg = await manageWorkspaceTool.handler(
    { op: "register", project_id: P, role: "coordinator", actor_id: COORD, change_id: CHANGE, workspace_id: WS, kind: "candidate", purpose: "集成候选", root: candRoot, source_kind: "git_worktree", task_ids: ["T-1"] },
    mcpCtx,
  );
  ok((JSON.parse((reg.content[0] as { text: string }).text) as { ok?: boolean }).ok === true, "① MCP register 经唯一写口落事件");

  const rec0 = readWorkspaces(workDir).workspaces[WS];
  const fr = await manageWorkspaceTool.handler(
    { op: "freeze", project_id: P, role: "coordinator", actor_id: COORD, change_id: CHANGE, workspace_id: WS, expected_revision: rec0.revision, included_uncommitted: true, declared_paths: ["a.txt"], source_commit: baseHead },
    mcpCtx,
  );
  const frBody = JSON.parse((fr.content[0] as { text: string }).text) as { ok?: boolean; code?: string };
  ok(frBody.ok === true, "① MCP freeze 成功（宿主实测指纹+配套版本）", frBody);

  const evLine = fs.readFileSync(path.join(workDir, "events.jsonl"), "utf8").split("\n").filter((l) => l.includes('"workspace.frozen"')).slice(-1)[0] ?? "{}";
  const ev = JSON.parse(evLine) as { payload?: Record<string, unknown> };
  const refText = ev.payload?.candidate_index_revision;
  ok(Buffer.byteLength(JSON.stringify(ev.payload ?? {}), "utf8") <= 64 * 1024, "① 冻结事件 payload ≤64KiB", Buffer.byteLength(JSON.stringify(ev.payload ?? {}), "utf8"));
  ok(typeof refText === "string" && !JSON.stringify(ev.payload).includes('"entries"'), "① 事件只存引用、不塞完整索引 entries");
  const ref = parseCandidateIndexRef(refText as string);
  ok(ref !== null, "① candidate_index_revision 解析为合法 CandidateIndexRef");
  if (ref !== null) {
    ok(ref.ref_bytes <= 64 * 1024, "① 引用自身 ≤64KiB", ref.ref_bytes);
    ok(ref.index_fingerprint === expectedFp, "① 引用指纹 = 宿主实测内容指纹");
    const back = readCandidateIndex(workDir, ref);
    ok(back.content_fingerprint === expectedFp && back.entries.length > 0, "① 从引用取回完整索引并核指纹一致");
    ok(ref.index_evidence_id === (ev.payload?.index_evidence_id as string) && ref.recovery_evidence_id === (ev.payload?.recovery_evidence_id as string), "① index/recovery 证据 id 与引用同源（旧字段与引用统一）");
  }

  // 尚无技术验证/独立审查 → 试用提升必须拒，且保留旧指针（旧指针为空）
  const ptrBefore = readWorkspaces(workDir).pointer?.revision ?? 0;
  const ptReject = await manageWorkspaceTool.handler(
    { op: "point_trial", project_id: P, role: "coordinator", actor_id: COORD, change_id: CHANGE, workspace_id: WS, expected_revision: ptrBefore },
    mcpCtx,
  );
  const ptRejBody = JSON.parse((ptReject.content[0] as { text: string }).text) as { ok?: boolean; code?: string; detail?: { reason?: string } };
  ok(ptRejBody.ok === false && (ptRejBody.detail?.reason === "PROMOTION_UNVERIFIED" || ptRejBody.code === "PROMOTION_UNVERIFIED"), "① 未验（尚无技术/独审）时 point_trial 拒 PROMOTION_UNVERIFIED（旧指针保留）", ptRejBody);
  ok((readWorkspaces(workDir).pointer?.current_trial_workspace_id ?? null) === null, "① 未验拒提升后试用指针仍为空（保留旧指针）");
}

// ═════════════════════ ③ 正式存证（HTTP reporting）+ 认领 + 自检 + 独立审查 ═════════════════════
section("③ 正式存证（HTTP reporting）+ 自检 + 独立审查");
let manifestEvidenceId = "";
let manifestFingerprint = "";
{
  const { res, read } = mockRes();
  await handleReportingRequest(
    mockReq("POST", "/api/work/reporting/evidence", {
      project_id: P, workspace_id: WS, content: "", kind: "source_manifest", summary: "候选源清单",
      created_by: EXEC, role: "executor", binding: { revision_kind: "code", revision: "rev-x" }, source_manifest: [{ path: "a.txt" }],
    }),
    res,
    { pathname: "/api/work/reporting/evidence", dataDir },
  );
  const body = read().body as { ok?: boolean; evidence?: { evidence_id: string; source_manifest?: { fingerprint: string }; workspace_id?: string | null } };
  ok(body.ok === true, "③ 经 reportingHost HTTP 存 source_manifest（workspace_id 透传）", body);
  manifestEvidenceId = body.evidence?.evidence_id ?? "";
  manifestFingerprint = body.evidence?.source_manifest?.fingerprint ?? "";
  ok(body.evidence?.workspace_id === WS && manifestEvidenceId !== "" && manifestFingerprint !== "", "③ 证据记目标工作区 + 清单指纹（只 id，不传绝对根）");

  const claim = await claimTask({ project_id: P, task_id: "T-1", role: "executor", owner_id: EXEC, change_id: CHANGE, workspace_id: WS }, service, dataDir);
  ok(claim.ok === true, "③ claim_task 认领 T-1（授权）", claim.ok ? undefined : claim);

  const sc = submitSelfCheck(work as never, {
    project_id: P, change_id: CHANGE, actor_id: EXEC, role: "executor", record_id: "sc-t-1",
    task_id: "T-1", checked_by: EXEC, conclusion: "pass",
    binding: { revision_kind: "code", revision: manifestFingerprint },
    checks: [{ check_id: "chk-t-1-01", method: "定向检查（夹具）", command: null, exit_code: null, evidence_sha256: manifestEvidenceId, scope: [], verifies: "code" }],
  });
  const scEv = submitSelfCheck(work as never, {
    project_id: P, change_id: CHANGE, actor_id: EXEC, role: "executor", record_id: "sc-t-1-ev",
    task_id: "T-1", checked_by: EXEC, conclusion: "pass",
    binding: { revision_kind: "code", revision: manifestFingerprint },
    checks: [{ check_id: "T-1::evidence", method: "交付物证据（夹具）", command: null, exit_code: null, evidence_sha256: manifestEvidenceId, scope: [], verifies: "code" }],
  });
  ok(sc.ok === true && scEv.ok === true, "③ 作者自检落账（必检 + 交付物证据，绑候选清单指纹）", sc);

  const coverage = COVERAGE_AREAS.map((a) => ({ area: a, status: "checked" as const, basis: `${COVERAGE_AREA_LABELS[a]}：夹具已独立复核` }));
  const ia = submitIndependentAudit(work as never, {
    project_id: P, change_id: CHANGE, actor_id: AUDITOR, role: "auditor", record_id: "ia-t-1",
    task_id: "T-1", auditor: AUDITOR, author_id: EXEC, conclusion: "pass",
    binding: { revision_kind: "code", revision: manifestFingerprint },
    checks: [{ check_id: "chk-t-1-01", result: "passed", evidence_sha256: manifestEvidenceId, scope: [] }],
    coverage,
  });
  ok(ia.ok === true, "③ 非作者独立审查落账", ia);

  const ic = submitSelfCheck(work as never, {
    project_id: P, change_id: CHANGE, actor_id: EXEC, role: "executor", record_id: "sc-int-1",
    task_id: "cap-t", checked_by: EXEC, conclusion: "pass",
    binding: { revision_kind: "code", revision: manifestFingerprint },
    checks: [{ check_id: "int-t-01", method: "端到端集成（夹具）", command: null, exit_code: null, evidence_sha256: manifestEvidenceId, scope: [], verifies: "code" }],
  });
  ok(ic.ok === true, "③ 集成检查证据落账", ic);
}

// ═════════════════════ ②′ 真证据齐备后的试用提升 ═════════════════════
section("②′ 真证据齐备后试用提升：宿主实测已验版本通过");
{
  const ptrBefore = readWorkspaces(workDir).pointer?.revision ?? 0;
  const pt = await manageWorkspaceTool.handler(
    { op: "point_trial", project_id: P, role: "coordinator", actor_id: COORD, change_id: CHANGE, workspace_id: WS, expected_revision: ptrBefore },
    mcpCtx,
  );
  const ptBody = JSON.parse((pt.content[0] as { text: string }).text) as { ok?: boolean; code?: string; message?: string };
  ok(ptBody.ok === true, "②′ 真证据齐备后 point_trial 成功（宿主实测已验版本）", ptBody);
  ok((readWorkspaces(workDir).pointer?.current_trial_workspace_id ?? null) === WS, "②′ 当前试用候选指针＝候选工作区");
}

// ═════════════════════ ② 交付读数按候选来源解析 ═════════════════════
section("② featureLedger 真实 resolveCandidateSource：present / tampered 降级");
{
  const L = readFeatureLedger(P, dataDir, {}, { project_exists: exists });
  ok(L.ok === true, "② 默认试用视图 ok", L.ok ? undefined : L);
  if (L.ok) {
    ok(L.ledger.workspace?.resolved === true && L.ledger.workspace?.workspace_id === WS, "② 默认试用解析到冻结候选工作区", L.ledger.workspace);
    ok(L.ledger.workspace?.root === path.resolve(candRoot), "② 解析根 = 候选原目录（present）", L.ledger.workspace?.root);
    ok(L.ledger.document_selection?.mode === "frozen_candidate", "② 读冻结候选文档快照", L.ledger.document_selection);
  }
}

// ═════════════════════ ④ 真实 Git 收尾链 ═════════════════════
section("④ gitFinalizeHost：未授权拒（零副作用）→ 通过 → 真 commit → 幂等重试复用");
const token = "wsint-token";
const callFinalize = async (body: Record<string, unknown>): Promise<{ status: number; body: unknown }> => {
  const { res, read } = mockRes();
  await handleFinalizeRequest(mockReq("POST", "/api/work/git/finalize", body, { [WORK_TOKEN_HEADER]: token }), res, {
    dataDir, token, pathname: "/api/work/git/finalize", assertWriteOwnership: () => {},
  });
  return read();
};
const countCommits = (): number => Number(git(candRoot, ["rev-list", "--count", "HEAD"]).trim());
{
  const bad = await callFinalize({ project_id: P, task_id: "T-1", workspace_id: WS, actor_id: "stranger", role: "executor", subject: "unauthorized" });
  const badBody = bad.body as { ok?: boolean; result?: { status: string; code: string | null } };
  ok(badBody.result?.status === "refused" && badBody.result?.code === "NOT_AUTHORIZED", "④ 未授权收尾 refused/NOT_AUTHORIZED", badBody.result);
  ok(countCommits() === 1, "④ 未授权零副作用（HEAD 未变）");

  const good = await callFinalize({ project_id: P, task_id: "T-1", workspace_id: WS, actor_id: EXEC, role: "executor", subject: "feat: 集成收尾" });
  const goodBody = good.body as { ok?: boolean; result?: { status: string; code: string | null; commit: string | null }; association_evidence_id?: string | null };
  ok(goodBody.result?.status === "committed", `④ 合格+已授权 → committed（实际 ${goodBody.result?.status}/${goodBody.result?.code}）`, goodBody.result);
  ok(countCommits() === 2, "④ 真实产生 1 个新提交（总提交数 2）", countCommits());
  const firstCommit = goodBody.result?.commit ?? null;
  ok(typeof firstCommit === "string" && firstCommit !== null, "④ 回执带 commit");
  ok(typeof goodBody.association_evidence_id === "string", "④ 收尾关联经唯一写口落库", goodBody.association_evidence_id);

  const retry = await callFinalize({ project_id: P, task_id: "T-1", workspace_id: WS, actor_id: EXEC, role: "executor", subject: "feat: 集成收尾" });
  const retryBody = retry.body as { result?: { status: string; commit: string | null } };
  ok(retryBody.result?.status === "reused" && retryBody.result?.commit === firstCommit, "④ 幂等重试 reused 且同提交（不双 commit）", retryBody.result);
  ok(countCommits() === 2, "④ 重试后提交数仍为 2");
  if (typeof firstCommit === "string") {
    const committedA = git(candRoot, ["show", `${firstCommit}:a.txt`]);
    ok(committedA === "v2-modified\n", "④ 提交内容 = 受验原始字节（a.txt）", JSON.stringify(committedA));
  } else {
    ok(false, "④ 无 commit 可比对提交内容");
  }
}

// ═════════════════════ ⑤ 工作包 finalize 下一步 ═════════════════════
section("⑤ 工作包 completion.finalize：合格+已授权时给 finalize_local_commit 实际参数");
{
  const entry = evaluateProjectEntry({ project_id: P, role: "executor", client_capabilities: ["continuable", "can_continue", "can_coordinate"] }, { dataDir, work_package: true });
  const wp = (entry as { work_package?: { completion?: { satisfied?: boolean; finalize?: { tool?: string; known_args?: Record<string, unknown> } | null } } }).work_package;
  const fin = wp?.completion?.finalize ?? null;
  if (wp?.completion?.satisfied === true) {
    ok(fin !== null && fin?.tool === "finalize_local_commit", "⑤ 技术完成+已授权 ⇒ 给 finalize_local_commit 下一步", fin);
    ok(fin?.known_args?.project_id === P && fin?.known_args?.task_id === "T-1" && fin?.known_args?.workspace_id === WS, "⑤ next_operation 带真实参数（project/task/workspace）", fin?.known_args);
  } else {
    ok(fin === null, "⑤ 未达技术完成 ⇒ finalize 下一步如实为 null（不孤立放置/不臆造）", wp?.completion);
    console.log(`[verify]   NOTE ⑤ 本夹具 work_package.completion.satisfied=${wp?.completion?.satisfied}（未达 canonical 技术完成档，记录为已知未覆盖）`);
  }
}

// ═════════════════════ ⑥ 同版本（HTTP / MCP / entry） ═════════════════════
section("⑥ 同版本：HTTP 读口 / MCP feature_ledger / entry 三处读回同一 workspace 结论");
{
  const httpLike = readFeatureLedger(P, dataDir, {}, { project_exists: exists });
  const mcpRes = await featureLedgerTool.handler({ project_id: P }, { clientName: "wsint-mcp", work } as never);
  const mcpBody = JSON.parse((mcpRes.content[0] as { text: string }).text) as { ok?: boolean; ledger?: { workspace?: { workspace_id?: string; root?: string | null } } };
  ok(httpLike.ok === true && mcpBody.ok === true, "⑥ HTTP 与 MCP 都 ok");
  const httpWs = httpLike.ok ? httpLike.ledger.workspace?.workspace_id : undefined;
  ok(mcpBody.ledger?.workspace?.workspace_id === httpWs && httpWs === WS, "⑥ MCP 与 HTTP 读回同一 workspace", { httpWs, mcp: mcpBody.ledger?.workspace?.workspace_id });
}

// ═════════════════════ ⑩ 冻结后新失败追记 ⇒ 同版变红 ═════════════════════
section("⑩ 冻结后对新失败（阻断缺陷）追记 ⇒ 旧候选同版读数变红；收尾如实拒绝");
{
  const wpBefore = (evaluateProjectEntry({ project_id: P, role: "executor", client_capabilities: ["continuable", "can_continue", "can_coordinate"] }, { dataDir, work_package: true }) as { work_package?: { completion?: { satisfied?: boolean } } }).work_package;
  const beforeSatisfied = wpBefore?.completion?.satisfied === true;
  const workWithRead = { submit: (c: unknown) => service.submit(c), read: () => readFindings(workDir) };
  openFinding(workWithRead as never, {
    project_id: P, change_id: "change-wsint-fail", actor_id: AUDITOR, role: "auditor",
    severity: "blocks_core_goal", source: "夹具：冻结后独立审计发现新缺陷",
    expected: "收尾前无未收口缺陷", actual: "发现阻断缺陷", repro: "夹具复现",
    evidence_sha256: manifestEvidenceId, object_id: "T-1",
  });
  const after = readFeatureLedger(P, dataDir, {}, { project_exists: exists });
  const wpAfter = (evaluateProjectEntry({ project_id: P, role: "executor", client_capabilities: ["continuable", "can_continue", "can_coordinate"] }, { dataDir, work_package: true }) as { work_package?: { completion?: { satisfied?: boolean; blocking_findings?: string[]; finalize?: unknown } } }).work_package;
  ok(beforeSatisfied === true && wpAfter?.completion?.satisfied === false, "⑩ 新缺陷追记 ⇒ 同候选完成读数由 satisfied 转否（不隐藏后续失败）", { beforeSatisfied, afterSatisfied: wpAfter?.completion?.satisfied });
  ok(wpAfter?.completion?.finalize === null, "⑩ 技术完成被新缺陷打破 ⇒ finalize 下一步如实收回");
  ok(after.ok === true, "⑩ 同候选仍可读（不因新缺陷隐藏现场）", after.ok ? undefined : after);
  const { res, read } = mockRes();
  await handleFinalizeRequest(mockReq("POST", "/api/work/git/finalize", { project_id: P, task_id: "T-1", workspace_id: WS, actor_id: EXEC, role: "executor", subject: "should-refuse-after-fail" }, { [WORK_TOKEN_HEADER]: token }), res, { dataDir, token, pathname: "/api/work/git/finalize", assertWriteOwnership: () => {} });
  const r = read().body as { result?: { status: string; code: string | null } };
  ok(r.result?.status === "refused", "⑩ 技术验证失效后收尾如实 refused（不拿旧绿放行）", r.result);
}

// ═════════════════════ ⑦ 篡改 / 回收恢复（读侧拒绝与如实降级） ═════════════════════
section("⑦ 篡改候选 ⇒ 失效；删候选目录 ⇒ 从中央内容寻址恢复仍可核");
{
  write(path.join(candRoot, "a.txt"), "v2-TAMPERED\n");
  const Lbad = readFeatureLedger(P, dataDir, {}, { project_exists: exists });
  ok(Lbad.ok === false && Lbad.status === 400, "⑦ 篡改候选字节 ⇒ 默认试用读口如实降级（不造绿）", Lbad.ok ? Lbad.ledger.workspace : Lbad);
  write(path.join(candRoot, "a.txt"), "v2-modified\n");
  write(path.join(candRoot, "extra-not-in-index.txt"), "x\n");
  ok(readFeatureLedger(P, dataDir, {}, { project_exists: exists }).ok === false, "⑦ 新增未在候选索引的输入 ⇒ 判失效（extra）");
  fs.rmSync(path.join(candRoot, "extra-not-in-index.txt"), { force: true });
  ok(readFeatureLedger(P, dataDir, {}, { project_exists: exists }).ok === true, "⑦ 恢复原字节 ⇒ 又正常（同版可读）");

  fs.rmSync(candRoot, { recursive: true, force: true });
  const v = evidenceManifestRootVerdict(workDir, manifestEvidenceId, projRoot);
  ok(v.unavailable_reason === null && v.root !== null && v.root !== path.resolve(candRoot), "⑦ 目录删除后证据作用域解析到可再生缓存根", v);
  if (v.root !== null) {
    const manifest = { fingerprint: manifestFingerprint, files: [{ path: "a.txt", sha256: sha256("v2-modified\n"), bytes: Buffer.byteLength("v2-modified\n") }] } as never;
    ok(verifySourceManifest(v.root, manifest).status === "valid", "⑦ 恢复根上 source_manifest 现读 valid（保住原字节）");
  }
  const Lrec = readFeatureLedger(P, dataDir, {}, { project_exists: exists });
  ok(Lrec.ok === true && Lrec.ledger.workspace?.resolved === true, "⑦ 默认试用读口从恢复缓存仍可读（不判失效）", Lrec.ok ? Lrec.ledger.workspace : Lrec);
}

// ═════════════════════ ⑧ 开发目录变化不机械失效冻结候选 ═════════════════════
section("⑧ 改开发目录代码/图纸 ⇒ 冻结试用版同版不掉绿；dev 视图真实读开发区");
{
  const designFrozen = readFeatureLedger(P, dataDir, {}, { project_exists: exists });
  const frozenRev = designFrozen.ok ? designFrozen.ledger.document_selection?.design_revision : null;
  write(path.join(projRoot, ".工作台", "design.md"), designText + "\n<!-- 开发目录后续修改 -->\n");
  write(path.join(projRoot, "dev-src.ts"), "export const dev = 1;\n");
  const afterDev = readFeatureLedger(P, dataDir, {}, { project_exists: exists });
  ok(afterDev.ok === true && afterDev.ledger.document_selection?.mode === "frozen_candidate" && afterDev.ledger.document_selection?.design_revision === frozenRev, "⑧ 改开发图纸后冻结试用版仍读冻结快照（同版不掉绿）", afterDev.ok ? afterDev.ledger.document_selection : afterDev);
  const devView = readFeatureLedger(P, dataDir, { workspace: "dev" }, { project_exists: exists });
  ok(devView.ok === true && devView.ledger.workspace?.kind === "dev" && devView.ledger.document_selection?.mode !== "frozen_candidate", "⑧ workspace=dev 明确读当前开发工作区（非冻结候选）", devView.ok ? { ws: devView.ledger.workspace, mode: devView.ledger.document_selection?.mode } : devView);
}

// ═════════════════════ ⑨ entry 与读口同版本 ═════════════════════
section("⑨ entry（project_entry）默认试用解析与读口同版本同结论");
{
  const entry = evaluateProjectEntry({ project_id: P, role: "executor", client_capabilities: ["continuable"] }, { dataDir });
  const cm = (entry as { context_manifest?: { workspace?: { workspace_id?: string; trial?: { workspace_id?: string } | null; trial_status?: string } } }).context_manifest;
  ok(cm?.workspace?.trial_status === "ok" && cm?.workspace?.trial?.workspace_id === WS, "⑨ entry context_manifest.workspace 标出当前试用候选（与读口同版本）", cm?.workspace);
  ok(cm?.workspace?.workspace_id === `${P}:main`, "⑨ 目标开发工作区为 :main（试用候选另列，不改锚点）", cm?.workspace?.workspace_id);
}

// ═════════════════════ ⑪ 全批授权：T2 未验拒、T2 验后真提交 ═════════════════════
section("⑪ 全批授权：本批实际纳入变化对应的每个任务都要同候选通过技术+独审");
{
  const P2 = "wsint2";
  const proj2 = path.join(tmpBase, "proj2");
  const cand2 = path.join(tmpBase, "cand2");
  const CHANGE2 = "change-wsint2";

  const plan2 = [
    "# 施工图",
    "",
    "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |",
    "| --- | --- | --- | --- | --- |",
    "| T-1 | todo | 甲卡 |  | 证据齐 |",
    "| T-2 | todo | 乙卡 |  | 证据齐 |",
    "",
    "### T-1 甲卡",
    "",
    "**设计依据**：§3.5。**依赖**：无。**文件责任**：`a.txt`。",
    "",
    "- [ ] **chk-t-1-01 甲达标 [独立审计]**",
    "",
    "### T-2 乙卡",
    "",
    "**设计依据**：§3.5。**依赖**：无。**文件责任**：`b.txt`。",
    "",
    "- [ ] **chk-t-2-01 乙达标 [独立审计]**",
    "",
  ].join("\n");
  const workDir2 = setupProject(P2, proj2, plan2, designText, CHANGE2);
  projectIds.add(P2);

  fs.mkdirSync(cand2, { recursive: true });
  git(cand2, ["init", "-q", "-b", "main"]);
  git(cand2, ["config", "user.email", "wsint2@test"]);
  git(cand2, ["config", "user.name", "wsint2"]);
  write(path.join(cand2, "a.txt"), "a1\n");
  write(path.join(cand2, "b.txt"), "b1\n");
  git(cand2, ["add", "-A"]);
  git(cand2, ["commit", "-q", "-m", "base"]);
  const base2 = git(cand2, ["rev-parse", "HEAD"]).trim();
  write(path.join(cand2, "a.txt"), "a2\n");
  write(path.join(cand2, "b.txt"), "b2\n");

  const WS2 = "ws-batch";
  const reg2 = await manageWorkspaceTool.handler(
    { op: "register", project_id: P2, role: "coordinator", actor_id: COORD, change_id: CHANGE2, workspace_id: WS2, kind: "candidate", purpose: "全批候选", root: cand2, source_kind: "git_worktree", task_ids: ["T-1", "T-2"] },
    mcpCtx,
  );
  ok((JSON.parse((reg2.content[0] as { text: string }).text) as { ok?: boolean }).ok === true, "⑪ 登记双任务候选（task_ids=[T-1,T-2]）");
  const rec2 = readWorkspaces(workDir2).workspaces[WS2];
  const fr2 = await manageWorkspaceTool.handler(
    { op: "freeze", project_id: P2, role: "coordinator", actor_id: COORD, change_id: CHANGE2, workspace_id: WS2, expected_revision: rec2.revision, included_uncommitted: true, declared_paths: ["a.txt", "b.txt"], source_commit: base2 },
    mcpCtx,
  );
  ok((JSON.parse((fr2.content[0] as { text: string }).text) as { ok?: boolean }).ok === true, "⑪ 冻结双任务候选（declared=[a.txt,b.txt]）");

  // 共享源清单证据
  const { res: res2, read: read2 } = mockRes();
  await handleReportingRequest(
    mockReq("POST", "/api/work/reporting/evidence", {
      project_id: P2, workspace_id: WS2, content: "", kind: "source_manifest", summary: "候选源清单",
      created_by: EXEC, role: "executor", binding: { revision_kind: "code", revision: "rev-x" }, source_manifest: [{ path: "a.txt" }, { path: "b.txt" }],
    }),
    res2,
    { pathname: "/api/work/reporting/evidence", dataDir },
  );
  const ev2 = read2().body as { evidence?: { evidence_id: string; source_manifest?: { fingerprint: string } } };
  const evid2 = ev2.evidence?.evidence_id ?? "";
  const fp2 = ev2.evidence?.source_manifest?.fingerprint ?? "";

  // 两任务都认领（授权齐），但**只**验 T-1
  await claimTask({ project_id: P2, task_id: "T-1", role: "executor", owner_id: EXEC, change_id: CHANGE2, workspace_id: WS2 }, service, dataDir);
  await claimTask({ project_id: P2, task_id: "T-2", role: "executor", owner_id: EXEC, change_id: CHANGE2, workspace_id: WS2 }, service, dataDir);
  submitSelfCheck(work as never, {
    project_id: P2, change_id: CHANGE2, actor_id: EXEC, role: "executor", record_id: "sc2-t1", task_id: "T-1", checked_by: EXEC, conclusion: "pass",
    binding: { revision_kind: "code", revision: fp2 },
    checks: [
      { check_id: "chk-t-1-01", method: "夹具", command: null, exit_code: null, evidence_sha256: evid2, scope: [], verifies: "code" },
      { check_id: "T-1::evidence", method: "交付物证据（夹具）", command: null, exit_code: null, evidence_sha256: evid2, scope: [], verifies: "code" },
    ],
  });
  submitIndependentAudit(work as never, {
    project_id: P2, change_id: CHANGE2, actor_id: AUDITOR, role: "auditor", record_id: "ia2-t1", task_id: "T-1", auditor: AUDITOR, author_id: EXEC, conclusion: "pass",
    binding: { revision_kind: "code", revision: fp2 },
    checks: [{ check_id: "chk-t-1-01", result: "passed", evidence_sha256: evid2, scope: [] }],
    coverage: COVERAGE_AREAS.map((a) => ({ area: a, status: "checked" as const, basis: `${COVERAGE_AREA_LABELS[a]}：夹具` })),
  });

  const callFinalize2 = async (taskId: string, subject: string): Promise<{ status: number; body: unknown }> => {
    const { res, read } = mockRes();
    await handleFinalizeRequest(mockReq("POST", "/api/work/git/finalize", { project_id: P2, task_id: taskId, workspace_id: WS2, actor_id: EXEC, role: "executor", subject }, { [WORK_TOKEN_HEADER]: token }), res, {
      dataDir, token, pathname: "/api/work/git/finalize", assertWriteOwnership: () => {},
    });
    return read();
  };
  const count2 = (): number => Number(git(cand2, ["rev-list", "--count", "HEAD"]).trim());

  const refuse = await callFinalize2("T-1", "feat: 全批收尾（T-2 未验）");
  const refuseBody = refuse.body as { result?: { status: string; code: string | null } };
  ok(refuseBody.result?.status === "refused" && refuseBody.result?.code === "NOT_VERIFIED", "⑪ T-2 未验（其路径 b.txt 在本批变化里）⇒ 收尾拒 NOT_VERIFIED（不拿 T-1 的绿替 T-2 提交）", refuseBody.result);
  ok(count2() === 1, "⑪ 拒后零副作用（HEAD 未变）");

  // 验 T-2 后再收尾 → 真提交
  submitSelfCheck(work as never, {
    project_id: P2, change_id: CHANGE2, actor_id: EXEC, role: "executor", record_id: "sc2-t2", task_id: "T-2", checked_by: EXEC, conclusion: "pass",
    binding: { revision_kind: "code", revision: fp2 },
    checks: [
      { check_id: "chk-t-2-01", method: "夹具", command: null, exit_code: null, evidence_sha256: evid2, scope: [], verifies: "code" },
      { check_id: "T-2::evidence", method: "交付物证据（夹具）", command: null, exit_code: null, evidence_sha256: evid2, scope: [], verifies: "code" },
    ],
  });
  submitIndependentAudit(work as never, {
    project_id: P2, change_id: CHANGE2, actor_id: AUDITOR, role: "auditor", record_id: "ia2-t2", task_id: "T-2", auditor: AUDITOR, author_id: EXEC, conclusion: "pass",
    binding: { revision_kind: "code", revision: fp2 },
    checks: [{ check_id: "chk-t-2-01", result: "passed", evidence_sha256: evid2, scope: [] }],
    coverage: COVERAGE_AREAS.map((a) => ({ area: a, status: "checked" as const, basis: `${COVERAGE_AREA_LABELS[a]}：夹具` })),
  });
  const good2 = await callFinalize2("T-1", "feat: 全批收尾（T-1+T-2 均验）");
  const good2Body = good2.body as { result?: { status: string; code: string | null; commit: string | null } };
  ok(good2Body.result?.status === "committed", `⑪ T-2 验后全批收尾真提交（实际 ${good2Body.result?.status}/${good2Body.result?.code}）`, good2Body.result);
  ok(count2() === 2, "⑪ 真产生 1 个新提交");
}

// ═════════════════════ ⑫ 已回收候选：同版恢复读取 ═════════════════════
section("⑫ 已回收（retired）候选：移除目录后同版证据与显式 feature_ledger 仍可恢复读取");
{
  const P3 = "wsint3";
  const proj3 = path.join(tmpBase, "proj3");
  const cand3 = path.join(tmpBase, "cand3");
  const CHANGE3 = "change-wsint3";
  const workDir3 = setupProject(P3, proj3, planText, designText, CHANGE3);
  projectIds.add(P3);

  fs.mkdirSync(cand3, { recursive: true });
  git(cand3, ["init", "-q", "-b", "main"]);
  git(cand3, ["config", "user.email", "wsint3@test"]);
  git(cand3, ["config", "user.name", "wsint3"]);
  write(path.join(cand3, "a.txt"), "v1\n");
  git(cand3, ["add", "-A"]);
  git(cand3, ["commit", "-q", "-m", "base"]);
  const base3 = git(cand3, ["rev-parse", "HEAD"]).trim();
  write(path.join(cand3, "a.txt"), "v2\n");

  const WS3 = "ws-retired";
  await manageWorkspaceTool.handler(
    { op: "register", project_id: P3, role: "coordinator", actor_id: COORD, change_id: CHANGE3, workspace_id: WS3, kind: "candidate", purpose: "将回收的候选", root: cand3, source_kind: "git_worktree", task_ids: ["T-1"] },
    mcpCtx,
  );
  const rec3 = readWorkspaces(workDir3).workspaces[WS3];
  await manageWorkspaceTool.handler(
    { op: "freeze", project_id: P3, role: "coordinator", actor_id: COORD, change_id: CHANGE3, workspace_id: WS3, expected_revision: rec3.revision, included_uncommitted: true, declared_paths: ["a.txt"], source_commit: base3 },
    mcpCtx,
  );
  const rec3f = readWorkspaces(workDir3).workspaces[WS3];
  const ret = await manageWorkspaceTool.handler(
    { op: "retire", project_id: P3, role: "coordinator", actor_id: COORD, change_id: CHANGE3, workspace_id: WS3, expected_revision: rec3f.revision, reason: "夹具：按规则回收", reachability: "来源提交可达 + 中央恢复材料在" },
    mcpCtx,
  );
  ok((JSON.parse((ret.content[0] as { text: string }).text) as { ok?: boolean }).ok === true, "⑫ retire 成功（宿主实测可还原）");
  ok(readWorkspaces(workDir3).workspaces[WS3].status === "retired", "⑫ 工作区状态＝retired");

  // 移除**仅该测试候选**目录：同版仍应从中央恢复材料读取（不判失效）
  fs.rmSync(cand3, { recursive: true, force: true });
  const scope = scopeRootOf(workDir3, WS3, null);
  ok(scope.root !== null && path.resolve(scope.root) !== path.resolve(cand3), "⑫ retired 且目录移除后 scopeRootOf 仍解析到同版可再生根（不因 retired 直接 null）", scope);
  const L3 = readFeatureLedger(P3, dataDir, { workspace: WS3 }, { project_exists: exists });
  ok(L3.ok === true && L3.ledger.workspace?.resolved === true, "⑫ 显式 feature_ledger 读已回收候选：按同版恢复仍可读（不判失效）", L3.ok ? L3.ledger.workspace : L3);
}

// ═════════════════════ ⑬ 指针补丁：保留另一半 ═════════════════════
section("⑬ 指针是逐字段补丁：select_dev 只改开发指针、保留试用指针");
{
  const devRoot = path.join(tmpBase, "dev-ws-p");
  fs.mkdirSync(devRoot, { recursive: true });
  write(path.join(devRoot, "x.ts"), "export const x = 1;\n");
  const reg = await manageWorkspaceTool.handler(
    { op: "register", project_id: P, role: "coordinator", actor_id: COORD, change_id: CHANGE, workspace_id: "ws-dev-p", kind: "dev", purpose: "开发工作区（夹具）", root: devRoot, source_kind: "directory" },
    mcpCtx,
  );
  ok((JSON.parse((reg.content[0] as { text: string }).text) as { ok?: boolean }).ok === true, "⑬ 登记 dev 工作区");
  const ptrBefore = readWorkspaces(workDir).pointer?.revision ?? 0;
  const sd = await manageWorkspaceTool.handler(
    { op: "select_dev", project_id: P, role: "coordinator", actor_id: COORD, change_id: CHANGE, workspace_id: "ws-dev-p", expected_revision: ptrBefore, basis: "夹具：设开发指针" },
    mcpCtx,
  );
  ok((JSON.parse((sd.content[0] as { text: string }).text) as { ok?: boolean }).ok === true, "⑬ select_dev 成功");
  const ptrAfter = readWorkspaces(workDir).pointer;
  ok(ptrAfter?.current_dev_workspace_id === "ws-dev-p", "⑬ 开发指针＝ws-dev-p", ptrAfter);
  ok(ptrAfter?.current_trial_workspace_id === WS, "⑬ select_dev **保留**另一半试用指针（不被整条替换清空）", ptrAfter);
}

// ═════════════════════ ⑭ 冻结引用损坏：不按旧口径回落工作区根 ═════════════════════
section("⑭ 新格式冻结引用损坏 ⇒ 如实标失效，不回落工作区根（legacy 成功）");
{
  const P4 = "wsint4";
  const proj4 = path.join(tmpBase, "proj4");
  const cand4 = path.join(tmpBase, "cand4");
  const CHANGE4 = "change-wsint4";
  const workDir4 = setupProject(P4, proj4, planText, designText, CHANGE4);
  projectIds.add(P4);
  fs.mkdirSync(cand4, { recursive: true });
  write(path.join(cand4, "a.txt"), "v1\n");
  const WS4 = "ws-corrupt";
  await manageWorkspaceTool.handler(
    { op: "register", project_id: P4, role: "coordinator", actor_id: COORD, change_id: CHANGE4, workspace_id: WS4, kind: "candidate", purpose: "损坏引用候选", root: cand4, source_kind: "directory", task_ids: ["T-1"] },
    mcpCtx,
  );
  const rec4 = readWorkspaces(workDir4).workspaces[WS4];
  await manageWorkspaceTool.handler(
    { op: "freeze", project_id: P4, role: "coordinator", actor_id: COORD, change_id: CHANGE4, workspace_id: WS4, expected_revision: rec4.revision, included_uncommitted: false, declared_paths: [] },
    mcpCtx,
  );
  const recGood = readWorkspaces(workDir4).workspaces[WS4];
  const goodRef = parseCandidateIndexRef(recGood.freeze?.candidate_index_revision ?? null);
  ok(goodRef !== null, "⑭ 冻结引用合法（对照）");

  // 篡改冻结事件里的统一引用（隔离夹具；只为造出"新格式引用损坏"的现场）
  const eventsFile = path.join(workDir4, "events.jsonl");
  const lines = fs.readFileSync(eventsFile, "utf8").split("\n");
  let tampered = false;
  const out = lines.map((line) => {
    if (!line.includes('"workspace.frozen"') || !line.includes(WS4) || tampered) return line;
    const re = /"candidate_index_revision":"(?:[^"\\]|\\.)*"/;
    if (!re.test(line)) return line;
    tampered = true;
    return line.replace(re, '"candidate_index_revision":"{corrupted-ref"');
  });
  fs.writeFileSync(eventsFile, out.join("\n"), "utf8");
  ok(tampered, "⑭ 已篡改冻结事件的统一引用（隔离夹具）");

  const recBad = readWorkspaces(workDir4).workspaces[WS4];
  const readBad = resolveFrozenCandidateSource(workDir4, recBad);
  ok(readBad.ref === null && readBad.corrupt === true, "⑭ 引用损坏判为 corrupt（不按旧口径回落 rec.root）", { ref: readBad.ref, corrupt: readBad.corrupt });
  const scopeBad = scopeRootOf(workDir4, WS4, null);
  ok(scopeBad.root === null, "⑭ scopeRootOf 对损坏引用返回 null（不回落工作区根）", scopeBad);
  const L4 = readFeatureLedger(P4, dataDir, { workspace: WS4 }, { project_exists: exists });
  ok(L4.ok === false && L4.status === 400, "⑭ 显式 feature_ledger 对损坏引用如实 400（不 legacy 成功）", L4.ok ? L4.ledger.workspace : L4);
}

console.log(`\n[verify] ═══ 汇总：PASS=${pass} FAIL=${fail} ═══`);
if (fail > 0) process.exitCode = 1;
try {
  fs.rmSync(tmpBase, { recursive: true, force: true });
} catch {
  /* 回收失败不影响判分 */
}
