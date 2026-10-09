// 读模型**跨接口**最终整合验证（PLAN V09-52/V09-55；DESIGN §2.5.1／§2.6／§4.2／§6.12）。
//
// 目的：证明「同一份事实快照 → 唯一义务派生」在**真实读口**上产出**同一对象同一结论**——
//   · HTTP `GET /api/projects/:id/status-projection`（真 index.ts 桌面后端，动态端口）
//   · HTTP `GET /api/projects/:id/feature-ledger`（同一后端）
//   · MCP `feature_ledger`（真实工具 handler）
//   · MCP `get_project_graphs`（真实工具 handler；六图 scope_readouts）
// 比较字段：同 feature 对象的 **display_status / required_count / passed_count / scope_revision**。
//
// 覆盖状态（每个状态都做跨接口对账）：
//   ① 默认多 feature（无 scope 过滤，逐 item 自身 scope）
//   ② 显式 scope=cap-a
//   ③ 作者自检 pass + 非作者独立 fail **不得盖住**
//   ④ 失败修复真复测（独立复测 pass + fix_refs/resolves）⇒ 恢复 verified
//   ⑤ source_manifest 实际代码覆盖：无关文件变不连坐；相关源变 ⇒ stale（无新事件）
//   ⑥ 同 ID 语义改变 ⇒ 记录不继承、scope_revision 变
//   ⑦ 无已发布规划图（bp=null）时声明功能仍如实返回（不因缺蓝图整段隐没）
//
// 隔离：mkdtemp + 隔离 TATAI_HOME + 动态端口（绑 0）；不碰 8787、不碰任何真实项目/账本。
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { addProject } from "../src/server/registry";
import { activateBaseline, sha256Hex } from "../src/server/work/documents";
import { importTaskDefinitions } from "../src/server/work/plan";
import { submitDefinitionImports } from "../src/server/work/tasks";
import { registerRequirement } from "../src/server/work/requirements";
import { putEvidence, openFinding, readFindings, type FindingSubmitter } from "../src/server/work/evidence";
import { submitSelfCheck, submitIndependentAudit, submitFix, COVERAGE_AREAS } from "../src/server/work/audit";
import { WorkService } from "../src/server/work/service";
import { projectWorkDir } from "../src/server/workstation";
import { findTool } from "../src/mcp/tools";

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
const section = (t: string): void => console.log(`\n[verify] ══ ${t}`);
const info = (t: string): void => console.log(`[verify]   ${t}`);
const sha256 = (b: string | Buffer): string => crypto.createHash("sha256").update(b).digest("hex");
type Bind = { revision_kind: "design" | "plan" | "interface" | "code"; revision: string };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const write = (f: string, t: string): void => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, t, "utf8");
};

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DESKTOP_ENTRY = path.join(ROOT_DIR, "src", "server", "index.ts");
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-xif-"));
const HOME = path.join(tmpBase, "home");
process.env.TATAI_HOME = HOME;
process.env.TATAI_NO_AUTOSTART = "1";
process.env.TATAI_SEMANTIC_AUTO = "0";
const PID = "fxcore";
const ROOT = path.join(tmpBase, PID);
const CHG = "chg-xif";
const executor = "kimi-code";
const auditor = "codex-audit";
const DECL_HEAD = [
  "| 功能 ID | 人话功能名 | 需求 ID | 设计章节 | 本期范围（scope_id） | 覆盖结论 | 依据/缺口（review） | 使用结果与场景 |",
  "| --- | --- | --- | --- | --- | --- | --- | --- |",
];

const service = new WorkService({ dataDir: HOME });
const submitter = { submit: (c: unknown) => service.submit(c as never) };

// ── 夹具文件 ──
const designText = [
  "# 跨接口夹具设计书",
  "",
  "## 1 目标",
  "",
  "夹具设计正文（本版不变）。",
  "",
  "#### 功能清单声明（跨接口夹具）",
  "",
  DECL_HEAD[0],
  DECL_HEAD[1],
  "| cap-a | 能力 A | req-a | §1 | cap-a | 待审 | reviewer=; ref=DESIGN.md#1; section_sha256=x; gap=未施工 | 场景 A |",
  "| cap-b | 能力 B | req-b | §1 | cap-b | 待审 | reviewer=; ref=DESIGN.md#1; section_sha256=x; gap=未施工 | 场景 B |",
  "| cap-c | 能力 C | req-c | §1 | cap-c | 待审 | reviewer=; ref=DESIGN.md#1; section_sha256=x; gap=未施工 | 场景 C |",
  "",
].join("\n");
const planHead = [
  "# 跨接口夹具施工图",
  "",
  "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |",
  "| --- | --- | --- | --- | --- |",
  "| T-1 | todo | 能力 A 主卡 |  | 证据齐 |",
  "| T-3 | todo | 能力 B 主卡 |  | 证据齐 |",
  "| T-4 | todo | 能力 C 主卡 |  | 证据齐 |",
  "",
  "### T-1 能力 A 主卡",
  "",
  "**设计依据**：§1。**依赖**：无。**文件责任**：`src/ca.ts`。",
  "",
  "- [ ] **chk-t-1-01 能力 A 目标达标**",
  "- [ ] **chk-t-1-02 非作者复核：能力 A 独立验证**",
  "",
  "### T-3 能力 B 主卡",
  "",
  "**设计依据**：§1。**依赖**：无。**文件责任**：`src/cb.ts`。",
  "",
  "- [ ] **chk-t-3-01 能力 B 目标达标**",
  "",
  "### T-4 能力 C 主卡",
  "",
  "**设计依据**：§1。**依赖**：无。**文件责任**：`src/cc.ts`。",
  "",
  "- [ ] **chk-t-4-01 能力 C 目标达标**",
  "",
  "| 功能 ID | 人话功能名 | 承接卡 | 必需检查 | 集成检查 | 结果状态 |",
  "| --- | --- | --- | --- | --- | --- |",
  "| cap-a | 能力 A | T-1 | chk-t-1-01、chk-t-1-02 | int-a-01 | 未验 |",
  "| cap-b | 能力 B | T-3 | chk-t-3-01 | int-b-01 | 未验 |",
  "| cap-c | 能力 C | T-4 | chk-t-4-01 | int-c-01 | 未验 |",
  "",
  "## 集成检查要求",
  "",
  "| 对象 ID | 检查 ID | 说明 | 必需性 |",
  "| --- | --- | --- | --- |",
  "| cap-a | int-a-01 | 能力 A 跨卡集成 | 必需 |",
  "| cap-b | int-b-01 | 能力 B 跨卡集成 | 必需 |",
  "| cap-c | int-c-01 | 能力 C 跨卡集成 | 必需 |",
  "",
].join("\n");
const planV2 = planHead.replace("**chk-t-4-01 能力 C 目标达标**", "**chk-t-4-01 能力 C 目标达标（语义已改）**");

// ── 建夹具（全部经隔离 TATAI_HOME） ──
fs.mkdirSync(HOME, { recursive: true });
write(path.join(ROOT, ".工作台", "design.md"), designText);
write(path.join(ROOT, ".工作台", "plan.md"), planHead);
write(path.join(ROOT, "src", "ca.ts"), "export const CA = 1;\n");
write(path.join(ROOT, "src", "cb.ts"), "export const CB = 1;\n");
write(path.join(ROOT, "src", "cc.ts"), "export const CC = 1;\n");
addProject({ id: PID, name: "跨接口夹具", path: ROOT, kind: "backend" }, HOME);
const designRev = sha256Hex(designText);
for (const rid of ["req-a", "req-b", "req-c"]) {
  registerRequirement(submitter as never, {
    project_id: PID, requirement_id: rid, change_id: CHG, actor_id: "fixture", role: "designer",
    source: { kind: "user", ref: "夹具用户 2026-10-07" }, problem: `夹具需求 ${rid}`,
    users: [], success_scenarios: [], exclusions: [], priority: "P1", status: "explicit",
  });
}
submitDefinitionImports(service, {
  project_id: PID, change_id: CHG, actor_id: "fixture", role: "coordinator",
  definitions: importTaskDefinitions(planHead, { plan_revision: sha256(planHead) }).definitions,
});
activateBaseline(PID, { approved_by: "user", approval_basis: "跨接口夹具审定 v1", approval_kind: "user_confirmed" }, HOME);

const workDir = projectWorkDir(PID, HOME);
const storeManifest = (rel: string): { sha: string; fingerprint: string } => {
  const blob = putEvidence(workDir, {
    content: `源清单 ${rel}`,
    kind: "source_manifest",
    summary: `${rel} 源清单`,
    created_by: "fixture",
    role: "executor",
    binding: { revision_kind: "code", revision: sha256(`placeholder:${rel}`) },
    source_manifest: [{ path: rel }],
  });
  return { sha: blob.sha256, fingerprint: blob.source_manifest?.fingerprint ?? "" };
};
const selfCheck = (
  recordId: string,
  taskId: string,
  checkId: string,
  binding: Bind,
  evidence: string,
  verifies: "code" | "document" | "artifact",
  conclusion: "pass" | "fail" = "pass",
): void => {
  submitSelfCheck(submitter as never, {
    project_id: PID, change_id: CHG, actor_id: executor, role: "executor",
    record_id: recordId, task_id: taskId, round: 1, checked_by: executor, conclusion,
    binding, checks: [{ check_id: checkId, method: "夹具定向检查（跑后按输出判）", evidence_sha256: evidence, verifies }],
  });
};
const coverage = COVERAGE_AREAS.map((area) => ({ area, status: "checked" as const, basis: `查了 ${area}` }));
const indepAudit = (
  recordId: string,
  checkId: string,
  result: "passed" | "failed",
  binding: Bind,
  evidence: string,
  opts: { findings?: string[]; resolves?: string[]; fix_refs?: string[] } = {},
): void => {
  submitIndependentAudit(submitter as never, {
    project_id: PID, change_id: CHG, actor_id: auditor, role: "auditor",
    record_id: recordId, task_id: "T-1", round: 1, auditor, author_id: executor,
    conclusion: result === "passed" ? "pass" : "fail",
    binding, coverage,
    checks: [{ check_id: checkId, result, evidence_sha256: evidence, scope: [] }],
    findings: opts.findings ?? [],
    ...(opts.resolves === undefined ? {} : { resolves: opts.resolves }),
    ...(opts.fix_refs === undefined ? {} : { fix_refs: opts.fix_refs }),
  });
};

// ── 写事件（cap-a 用 design 绑定⇒失败/通过都能被真实识别；cap-b/cap-c 用 code+source_manifest） ──
const designBind: Bind = { revision_kind: "design", revision: designRev };
// cap-a：chk-t-1-01 作者自检过；chk-t-1-02 作者自检过（独审未过）；集成 int-a-01 过
selfCheck("sc-a-01", "T-1", "chk-t-1-01", designBind, sha256("ev:ca1"), "document");
selfCheck("sc-a-02-author", "T-1", "chk-t-1-02", designBind, sha256("ev:ca2"), "document");
selfCheck("sc-a-int", "cap-a", "int-a-01", designBind, sha256("ev:caint"), "document");
// cap-b：code + 源清单（HTTP 无 code_revision 也能靠 source_manifest 现读判绿）
const manB = storeManifest("src/cb.ts");
const codeBindB: Bind = { revision_kind: "code", revision: manB.fingerprint };
selfCheck("sc-b-01", "T-3", "chk-t-3-01", codeBindB, manB.sha, "code");
selfCheck("sc-b-int", "cap-b", "int-b-01", codeBindB, manB.sha, "code");
// cap-c：code + 源清单
const manC = storeManifest("src/cc.ts");
const codeBindC: Bind = { revision_kind: "code", revision: manC.fingerprint };
selfCheck("sc-c-01", "T-4", "chk-t-4-01", codeBindC, manC.sha, "code");
selfCheck("sc-c-int", "cap-c", "int-c-01", codeBindC, manC.sha, "code");
// cap-a②：非作者独立审计判 chk-t-1-02 **失败**（不进 pass）
// 写前校验（src/server/work/auditValidation.ts §失败独审）要求：conclusion=fail（或含 result=failed 的 check）**必须**
// 引用 foldFindings 里的**在册 finding ID**，且该 finding 的 object_id 落在本任务上；自由文本/不存在的 ID 会被
// 唯一写入服务在落盘前拒绝（零字节）。故按**真实流程**：先正式 open 一条 finding，再引用它的 id——不改产品校验。
const findingSubmitter: FindingSubmitter = {
  submit: (c: unknown) => service.submit(c as never),
  read: () => readFindings(workDir),
};
const openA = openFinding(findingSubmitter, {
    project_id: PID, change_id: CHG, actor_id: auditor, role: "auditor",
    severity: "user_visible_defect", source: "verify:feature-cross-interface",
    expected: "chk-t-1-02 能力 A 独立验证通过", actual: "独立复核判失败", repro: "跑夹具定向检查",
    evidence_sha256: sha256("ev:au-fail"), object_id: "T-1",
  },
);
const findingA = openA.finding_id;
ok(findingA !== "" && openA.deduped === false, `夹具：正式 open finding（${findingA}；object_id=T-1，供失败独审引用）`, openA);
// 负例（判据不放宽）：**散文 findings** 的失败独审仍被写前校验拒绝，且事件账本**零字节**。
{
  const evBefore = sha256(fs.readFileSync(path.join(workDir, "events.jsonl")));
  let rejected = "";
  try {
    indepAudit("au-a-prose", "chk-t-1-02", "failed", designBind, sha256("ev:au-fail"), { findings: ["chk-t-1-02 复核未过"] });
  } catch (e) {
    rejected = e instanceof Error ? e.message : String(e);
  }
  ok(
    rejected.includes("finding") && rejected.includes("零写入"),
    "负例：散文 findings 的失败独审被拒（不回落成自由文本）",
    rejected.slice(0, 200),
  );
  ok(sha256(fs.readFileSync(path.join(workDir, "events.jsonl"))) === evBefore, "负例零字节：事件账本内容未被写入");
}
indepAudit("au-a-fail", "chk-t-1-02", "failed", designBind, sha256("ev:au-fail"), { findings: [findingA] });

// ── 起真 index.ts 桌面后端（动态端口） ──
const children: ChildProcess[] = [];
function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k.startsWith("TATAI_")) delete env[k];
    if (/API_?KEY|SECRET|PASSWORD|CREDENTIAL/i.test(k)) delete env[k];
  }
  env.TATAI_HOME = HOME;
  env.TATAI_PORT = "0";
  env.TATAI_SYNC_DISCOVERY = "0";
  env.TATAI_SEMANTIC_AUTO = "0";
  env.TATAI_NO_AUTOSTART = "1";
  return env;
}
interface Desc { host: string; port: number; token: string; pid: number }
function descriptorOf(): Desc | null {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(HOME, "work-service.json"), "utf8")) as Partial<Desc>;
    if (typeof d.port !== "number" || typeof d.host !== "string" || typeof d.pid !== "number") return null;
    return { host: d.host, port: d.port, token: d.token ?? "", pid: d.pid };
  } catch {
    return null;
  }
}
async function waitDescriptor(timeoutMs: number): Promise<Desc | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const d = descriptorOf();
    if (d !== null) return d;
    if (Date.now() > deadline) return null;
    await sleep(200);
  }
}
let host: Desc | null = null;
async function httpJson(p: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`http://${host!.host}:${host!.port}${p}`);
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}
const asObj = (j: unknown): Record<string, unknown> => (typeof j === "object" && j !== null ? (j as Record<string, unknown>) : {});
async function mcp(toolName: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const t = findTool(toolName);
  if (t === undefined) throw new Error(`工具 ${toolName} 未注册`);
  const r = await t.handler(args, { clientName: "verify-xif" } as never);
  const text = (r.content ?? []).map((c) => (c as { text?: string }).text ?? "").join("\n");
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { raw: text, isError: r.isError === true };
  }
}

interface Reading {
  display: string | null;
  required: number | null;
  passed: number | null;
  scope_revision: string | null;
}
function fromStatus(proj: Record<string, unknown>, fid: string): Reading | null {
  const objects = asObj(proj.objects);
  const list = Array.isArray(objects) ? (objects as Record<string, unknown>[]) : [];
  const o = list.find((x) => x.object_id === fid);
  if (o === undefined) return null;
  // status-projection 另带**范围上屏读数**（与六图 scope_readouts 同一份）：scope_revision 从这里取
  const scopeReadouts = asObj(proj.scope_readouts);
  const sr = asObj(scopeReadouts[fid]);
  return {
    display: (o.display_status as string | null) ?? null,
    required: typeof o.required_count === "number" ? o.required_count : null,
    passed: typeof o.passed_count === "number" ? o.passed_count : null,
    scope_revision: (sr.scope_revision as string | null) ?? null,
  };
}
function fromLedger(ledger: Record<string, unknown>, fid: string): Reading | null {
  const items = Array.isArray(ledger.items) ? (ledger.items as Record<string, unknown>[]) : [];
  const it = items.find((x) => x.item_id === fid);
  if (it === undefined) return null;
  const v = asObj(it.verification);
  return {
    display: (v.display_status as string | null) ?? null,
    required: typeof v.required_count === "number" ? v.required_count : null,
    passed: typeof v.passed_count === "number" ? v.passed_count : null,
    scope_revision: (it.scope_revision as string | null) ?? null,
  };
}
function fromGraphs(snap: Record<string, unknown>, fid: string): Reading | null {
  const sr = asObj(snap.scope_readouts);
  const r = sr[fid];
  if (r === undefined) return null;
  const ro = asObj(r);
  return {
    display: (ro.display as string | null) ?? null,
    required: null,
    passed: null,
    scope_revision: (ro.scope_revision as string | null) ?? null,
  };
}

async function readAll(scope?: string): Promise<{
  httpStatus: Record<string, unknown>;
  httpLedger: Record<string, unknown>;
  mcpLedger: Record<string, unknown>;
  graphs: Record<string, unknown>;
}> {
  const q = scope === undefined ? "" : `?scope=${encodeURIComponent(scope)}`;
  const httpStatus = asObj((await httpJson(`/api/projects/${PID}/status-projection`)).json.projection);
  const httpLedger = asObj((await httpJson(`/api/projects/${PID}/feature-ledger${q}`)).json.ledger);
  const mcpLedger = asObj((await mcp("feature_ledger", { project_id: PID, ...(scope === undefined ? {} : { scope }) })).ledger);
  const graphs = await mcp("get_project_graphs", { project_id: PID, graph: "all" });
  return { httpStatus, httpLedger, mcpLedger, graphs };
}
/** 逐字段跨接口对账：http status / http ledger / mcp ledger / 六图 对**同一对象**同结论 */
function agree(label: string, fid: string, data: {
  httpStatus: Record<string, unknown>;
  httpLedger: Record<string, unknown>;
  mcpLedger: Record<string, unknown>;
  graphs: Record<string, unknown>;
}): Reading | null {
  const a = fromStatus(data.httpStatus, fid);
  const b = fromLedger(data.httpLedger, fid);
  const c = fromLedger(data.mcpLedger, fid);
  const d = fromGraphs(data.graphs, fid);
  const detail = { httpStatus: a, httpLedger: b, mcpLedger: c, graphs: d };
  ok(a !== null && b !== null && c !== null && d !== null, `${label} 四个读口都含对象 ${fid}`, detail);
  if (a === null || b === null || c === null || d === null) return a ?? b ?? c ?? d;
  const sameDisplay = a.display === b.display && b.display === c.display && c.display === d.display;
  const sameRequired = a.required === b.required && b.required === c.required;
  const samePassed = a.passed === b.passed && b.passed === c.passed;
  const sameSrev = a.scope_revision !== null && a.scope_revision === b.scope_revision && b.scope_revision === c.scope_revision && c.scope_revision === d.scope_revision;
  ok(sameDisplay, `${label} ${fid}：四接口 display_status 一致（=${a.display}）`, detail);
  ok(sameRequired, `${label} ${fid}：必需检查数一致（=${a.required}）`, detail);
  ok(samePassed, `${label} ${fid}：通过数一致（=${a.passed}）`, detail);
  ok(sameSrev, `${label} ${fid}：scope_revision 一致（=${String(a.scope_revision).slice(0, 16)}…）`, detail);
  return a;
}

async function main(): Promise<void> {
  info(`跨接口读模型整合 · ${process.platform} · node ${process.version}`);
  const child = spawn(process.execPath, ["--import", "tsx", DESKTOP_ENTRY], { cwd: ROOT_DIR, env: cleanEnv(), windowsHide: true });
  children.push(child);
  let clog = "";
  child.stdout?.on("data", (d: Buffer) => (clog += d.toString("utf8")));
  child.stderr?.on("data", (d: Buffer) => (clog += d.toString("utf8")));
  host = await waitDescriptor(45_000);
  ok(host !== null, "0-1 真 index.ts 桌面后端起并发布描述符（动态端口）", { log: clog.slice(-500) });
  if (host === null) throw new Error("桌面后端未发布描述符");

  // ═══ ① 默认多 feature（无 scope 过滤）逐 item 自身 scope + 跨接口对账 ═══
  section("① 默认多 feature：逐 item 自身 scope，四读口同对象同结论");
  const s1 = await readAll();
  const a1 = agree("①", "cap-a", s1);
  agree("①", "cap-b", s1);
  agree("①", "cap-c", s1);
  ok(a1?.display !== "verified", `① cap-a 非作者复核未过 ⇒ 不绿（实测 ${a1?.display}）`, a1);
  const b1 = fromLedger(s1.httpLedger, "cap-b");
  ok(b1?.display === "verified", `① cap-b 源清单现读有效 ⇒ verified（HTTP 无 code_revision 也真绿，实测 ${b1?.display}）`, b1);
  // 逐 item 自身 scope：cap-b 与 cap-c 的 scope_revision 必须不同（不是整清单同一个）
  const srevB = fromLedger(s1.mcpLedger, "cap-b")?.scope_revision;
  const srevC = fromLedger(s1.mcpLedger, "cap-c")?.scope_revision;
  ok(srevB !== null && srevC !== null && srevB !== srevC, "① 逐 item 自身 scope：cap-b/cap-c 的 scope_revision 不同（不共享整清单版本）", { srevB, srevC });

  // ═══ ② 显式 scope=cap-a ═══
  section("② 显式 scope=cap-a：过滤后仍为该功能自身 scope，跨接口同值");
  const s2 = await readAll("cap-a");
  const la = asObj(s2.mcpLedger).items;
  const items2 = Array.isArray(la) ? (la as Record<string, unknown>[]) : [];
  ok(items2.length === 1 && items2[0].item_id === "cap-a", "② scope=cap-a ⇒ 只返回 cap-a（过滤生效）", items2.map((i) => i.item_id));
  const a2 = agree("②", "cap-a", s2);
  ok(a2?.scope_revision === a1?.scope_revision, "② 显式 scope 与默认读的 cap-a scope_revision 同值（同一算法）", { s1: a1?.scope_revision, s2: a2?.scope_revision });

  // ═══ ③ 作者 pass + 独立 fail 不得盖住 ═══
  section("③ 作者自检 pass + 非作者独立 fail：不得盖住（跨接口同一份否决）");
  // （sc-a-02-author 是作者 pass；au-a-fail 是独立 fail，已在夹具里写入）
  const a3 = agree("③", "cap-a", s1);
  ok(a3?.display !== "verified", `③ 独立失败未被作者 pass 盖住（实测 ${a3?.display}）`, a3);
  const be = asObj((asObj(s1.httpStatus)).objects);
  const capAobj = (Array.isArray(be) ? (be as Record<string, unknown>[]) : []).find((o) => o.object_id === "cap-a");
  const basis = Array.isArray(asObj(capAobj).evidence_basis) ? (asObj(capAobj).evidence_basis as Record<string, unknown>[]) : [];
  const c02 = basis.find((b) => b.check_id === "chk-t-1-02");
  ok(c02?.effective === "failed", `③ chk-t-1-02 现读结论 = failed（独立否决优先，实测 ${String(c02?.effective)}）`, c02);

  // ═══ ④ 失败修复真复测 ⇒ 恢复 ═══
  section("④ 修复 + 非作者复测（resolves/fix_refs）⇒ 恢复 verified");
  submitFix(submitter as never, {
    project_id: PID, change_id: CHG, actor_id: executor, role: "executor",
    record_id: "fix-a-1", finding_id: findingA, fix_revision: designRev, fixed_by: executor, evidence_ref: "evidence/a.txt",
  });
  indepAudit("au-a-pass", "chk-t-1-02", "passed", designBind, sha256("ev:au-pass"), { resolves: ["au-a-fail"], fix_refs: ["fix-a-1"] });
  const s4 = await readAll();
  const a4 = agree("④", "cap-a", s4);
  ok(a4?.display === "verified", `④ 有效复测后恢复 verified（实测 ${a4?.display}）`, a4);

  // ═══ ⑤ source_manifest 实际代码覆盖：无关变不连坐 / 相关变 stale ═══
  section("⑤ source_manifest：无关文件变不连坐；相关源变（无新事件）⇒ stale");
  write(path.join(ROOT, "src", "unrelated.ts"), "export const U = 1;\n");
  const s5a = await readAll();
  const b5a = agree("⑤无关变", "cap-b", s5a);
  ok(b5a?.display === "verified", "⑤ 无关文件新增 ⇒ cap-b 仍 verified（有限覆盖不连坐）", b5a);
  write(path.join(ROOT, "src", "cb.ts"), "export const CB = 2;\n");
  const s5b = await readAll();
  const b5b = agree("⑤相关变", "cap-b", s5b);
  ok(b5b?.display !== "verified", `⑤ 被覆盖源变 ⇒ cap-b 不绿（stale，无新事件也现读发现，实测 ${b5b?.display}）`, b5b);
  // 复原
  write(path.join(ROOT, "src", "cb.ts"), "export const CB = 1;\n");
  const s5c = await readAll();
  ok(fromLedger(s5c.httpLedger, "cap-b")?.display === "verified", "⑤ 复原源 ⇒ cap-b 恢复 verified（不无依据全失效）", fromLedger(s5c.httpLedger, "cap-b"));

  // ═══ ⑥ 同 ID 语义改变 ⇒ 记录不继承、scope_revision 变 ═══
  section("⑥ 同 ID 语义改变：旧记录不继承、scope_revision 变（跨接口同步）");
  const beforeC = fromLedger(s5c.mcpLedger, "cap-c");
  write(path.join(ROOT, ".工作台", "plan.md"), planV2);
  submitDefinitionImports(service, {
    project_id: PID, change_id: CHG, actor_id: "fixture", role: "coordinator",
    expected_revisions: { "T-4": 1 },
    definitions: importTaskDefinitions(planV2, { plan_revision: sha256(planV2), revisions: { "T-4": 2 } }).definitions.filter((d) => d.task_id === "T-4"),
  });
  activateBaseline(PID, { approved_by: "user", approval_basis: "跨接口夹具审定 v2", approval_kind: "user_confirmed" }, HOME);
  const s6 = await readAll();
  const c6 = agree("⑥", "cap-c", s6);
  ok(c6?.display !== "verified", `⑥ 同 ID 改语义 ⇒ cap-c 不绿（记录不继承，实测 ${c6?.display}）`, c6);
  ok(beforeC !== null && c6 !== null && beforeC.scope_revision !== null && c6.scope_revision !== null && beforeC.scope_revision !== c6.scope_revision, "⑥ 检查定义语义变 ⇒ scope_revision 变（不是只带 checkID）", { before: beforeC?.scope_revision, after: c6?.scope_revision });
  // cap-a/cap-b 定义未变、源未变 ⇒ 仍稳定（不连坐）
  const a6 = agree("⑥不连坐", "cap-a", s6);
  ok(a6?.display === "verified", "⑥ 别的功能定义变不连坐：cap-a 仍 verified", a6);

  // ═══ ⑦ 无已发布规划图（bp=null）时声明功能仍如实返回 ═══
  section("⑦ 无已发布规划图：声明功能仍如实返回（不因缺蓝图整段隐没）");
  const bp = await httpJson(`/api/projects/${PID}/arch/blueprint`);
  const exists = asObj(asObj(bp.json.blueprint)).exists;
  ok(exists === false || exists === undefined, "⑦ 该夹具确实没有已发布规划图（bp=null 场景成立）", { exists });
  ok(fromStatus(s6.httpStatus, "cap-a") !== null && fromStatus(s6.httpStatus, "cap-b") !== null, "⑦ 无蓝图仍返回功能范围对象（cap-a/cap-b 都在 status-projection 里）", {
    capA: fromStatus(s6.httpStatus, "cap-a"),
    capB: fromStatus(s6.httpStatus, "cap-b"),
  });
  ok(fromGraphs(s6.graphs, "cap-a") !== null, "⑦ 无蓝图六图仍给声明功能的 scope_readout（不整段隐没）", fromGraphs(s6.graphs, "cap-a"));

  // ═══ ⑧ 验收页读口（/acceptance）与 status-projection 同判据（同现读快照 → 唯一义务层） ═══
  section("⑧ /acceptance 只读读口：任务结论与 status-projection 同判（同一义务层）");
  const accRes = await httpJson(`/api/projects/${PID}/acceptance`);
  ok(accRes.status === 200 && asObj(accRes.json).ok === true, "⑧ /acceptance 可达（同一 index.ts 装配）", accRes.status);
  const accTasks = Array.isArray(asObj(asObj(accRes.json).acceptance).tasks)
    ? (asObj(asObj(accRes.json).acceptance).tasks as Record<string, unknown>[])
    : [];
  const stObjects = Array.isArray(asObj(s6.httpStatus).objects) ? (asObj(s6.httpStatus).objects as Record<string, unknown>[]) : [];
  for (const tid of ["T-1", "T-3", "T-4"]) {
    const at = accTasks.find((t) => t.task_id === tid);
    const st = stObjects.find((o) => o.object_id === tid);
    ok(
      at !== undefined && st !== undefined && at.display_status === st.display_status,
      `⑧ 任务 ${tid}：验收页 display_status = status-projection（${String(at?.display_status)}）`,
      { acc: at?.display_status, status: st?.display_status },
    );
  }

  dataFlushSummary();
}

function dataFlushSummary(): void {
  console.log(`\n[verify] 小结：PASS ${passCount}，FAIL ${failCount}`);
}

void main()
  .catch((e) => {
    console.error("[verify] 验证中断：", e instanceof Error ? e.stack ?? e.message : String(e));
    failCount += 1;
    process.exitCode = 1;
  })
  .finally(() => {
    if (process.env.TATAI_KEEP_TMP === "1") {
      // 复用给 B6 浏览器复验：保留夹具与隔离 home（**不删**），打印可复用入口与重启命令。
      console.log(`\n[verify] 保留现场（TATAI_KEEP_TMP=1）：`);
      console.log(`[verify]   TATAI_HOME=${HOME}`);
      console.log(`[verify]   项目根=${ROOT}（id=${PID}，已注册进该 home 的 registry）`);
      console.log(`[verify]   本脚本进程退出后其后端随之结束；要浏览请对**同一 home** 重起桌面后端：`);
      console.log(`[verify]     TATAI_HOME="${HOME}" TATAI_PORT=0 node --import tsx src/server/index.ts`);
      console.log(`[verify]   随后读 ${HOME}\\work-service.json 的 port，再打开：`);
      console.log(`[verify]     GET http://127.0.0.1:<port>/api/projects/${PID}/status-projection`);
      console.log(`[verify]     GET http://127.0.0.1:<port>/api/projects/${PID}/feature-ledger`);
      process.exit(failCount > 0 ? 1 : 0);
    }
    for (const c of children) {
      try {
        if (c.exitCode === null) c.kill();
      } catch {
        /* ignore */
      }
    }
    try {
      // Windows：子进程刚被 kill、句柄未完全释放时 rm 会 EBUSY/EPERM。带重试等待其退出后再删，
      // 避免把夹具临时目录留在地上（本目录在 os.tmpdir()，但仍按"收尾清夹具"清干净）。
      fs.rmSync(tmpBase, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      /* ignore */
    }
    process.exit(failCount > 0 ? 1 : 0);
  });
