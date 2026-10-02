// V09-29 集成发现 F-1 · HTTP 状态投影读口与接续入口同判据验证（PLAN V09-29；契约 F4；DESIGN.md §5.6）。
//
// 缺陷（修前，RED）：`GET /api/projects/:id/status-projection` 与 `/audit` 仍用 `checksFromAudit(facts.audit)`
// 装配检查，**未**接源清单现读复核——"源清单覆盖的源码变了 → 旧绿转 stale" 只在 `project_entry` 侧成立，
// HTTP 读者把旧绿当现状（两处对同一检查各说各话）。
//
// 修后（GREEN）：`src/server/index.ts` 的 5 处读口统一走 `checksNowOf(facts)`（同一份
// `checksWithSourceManifests`，与 entry/statusProjection 同口径）。
//
// 本脚本用**真 `src/server/index.ts`**（动态端口、隔离 home）+ 真 MCP 工具 handler + 真唯一写服务：
//   ① 登记"绑 code 修订 + 源清单"的自检 → HTTP 读口与 entry 投影都 passed；
//   ② 改掉被覆盖的真实源文件、**不再上报任何事件** → HTTP 读口与 entry 投影**同判 stale**，
//      且都带 `source_manifest.status=invalidated` 并点名变了的是 src/foo.ts（不延续"历史照旧 passed"）；
//   ③ 复原源文件 → 两边都恢复 passed（不无依据全失效）。
// 隔离：mkdtemp 夹具 + 隔离 TATAI_HOME + 动态端口；不碰真实 ~/.tatai / 真实项目与账本 / 8787 / 不接网关。
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { addProject } from "../src/server/registry";
import { WorkServiceClient } from "../src/server/work/service";
import { projectFromFacts } from "../src/server/work/statusProjection";
import { findTool } from "../src/mcp/tools";
import type { McpContext } from "../src/mcp/tools/types";

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
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const mkdirp = (d: string): void => { fs.mkdirSync(d, { recursive: true }); };
const write = (f: string, t: string): void => { mkdirp(path.dirname(f)); fs.writeFileSync(f, t, "utf8"); };
const sha256 = (t: string | Buffer): string => crypto.createHash("sha256").update(t).digest("hex");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DESKTOP_ENTRY = path.join(ROOT, "src", "server", "index.ts");
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-http-fresh-"));
const HOME = path.join(tmpBase, "home");
// 本进程也要指同一隔离 home：工具 handler 用 resolveDataDir() 定位项目/施工图（与桌面子进程同源）
process.env.TATAI_HOME = HOME;
process.env.TATAI_NO_AUTOSTART = "1";
process.env.TATAI_SEMANTIC_AUTO = "0";
const PROJ = path.join(tmpBase, "proj-fx");
const PID = "fxhttpfresh";
const CHG = "chg-http-fresh";
const FOO_REL = "src/foo.ts";
const FOO_V1 = "export const FOO = 'foo-v1';\n";
const FOO_V2 = "export const FOO = 'foo-v2-changed';\n";

const PLAN_TEXT = [
  "# 夹具施工图", "",
  "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |",
  "| --- | --- | --- | --- | --- |",
  "| T-1 | todo | 夹具源码能力落成 |  | T-1 验收记录 |", "",
  "### T-1 夹具源码能力落成", "",
  "**设计依据**：§1。**文件责任**：`src/foo.ts`。**责任角色**：executor。", "",
  "- [ ] 夹具源码能力落成", "",
  "**交付**：能力验收记录。", "",
].join("\n");

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
    if (typeof d.port !== "number" || typeof d.host !== "string" || typeof d.token !== "string" || typeof d.pid !== "number") return null;
    return { host: d.host, port: d.port, token: d.token, pid: d.pid };
  } catch { return null; }
}
async function waitDescriptor(timeoutMs: number): Promise<Desc | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) { const d = descriptorOf(); if (d !== null) return d; if (Date.now() > deadline) return null; await sleep(200); }
}
async function httpGetJson(host: string, port: number, p: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`http://${host}:${port}${p}`);
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { json = { raw: text }; }
  return { status: res.status, json };
}
const asObj = (j: unknown): Record<string, unknown> => (typeof j === "object" && j !== null ? (j as Record<string, unknown>) : {});

/** 从 HTTP 状态投影里取目标检查的现读复核结论 */
function httpCheckEffectiveness(json: Record<string, unknown>, taskId: string, checkId: string): Record<string, unknown> | null {
  const objects = asObj(asObj(json.projection).objects);
  const list = Array.isArray(objects) ? (objects as Record<string, unknown>[]) : [];
  const task = list.find((o) => o.object_id === taskId);
  const basis = Array.isArray(task?.evidence_basis) ? (task!.evidence_basis as Record<string, unknown>[]).find((b) => b.check_id === checkId) : undefined;
  return basis ?? null;
}
/** 从进程内 entry 同口径投影取结论（projectFromFacts 与 project_entry 共用装配） */
function entryCheckEffectiveness(taskId: string, checkId: string): Record<string, unknown> | null {
  const { projection } = projectFromFacts(PID, HOME);
  const basis = projection.by_id[taskId]?.evidence_basis.find((b) => b.check_id === checkId);
  return basis === undefined ? null : (basis as unknown as Record<string, unknown>);
}

interface ToolCall { ok: boolean; text: string; json: Record<string, unknown> }
async function call(name: string, args: Record<string, unknown>, ctx: McpContext): Promise<ToolCall> {
  const t = findTool(name);
  if (t === undefined) return { ok: false, text: `工具 ${name} 未注册`, json: {} };
  const r = await t.handler(args, ctx);
  const text = r.content?.[0]?.text ?? "";
  let json: Record<string, unknown> = {};
  try { const p = JSON.parse(text) as unknown; if (typeof p === "object" && p !== null) json = p as Record<string, unknown>; } catch { /* 非 JSON */ }
  return { ok: r.isError !== true, text, json };
}

const children: ChildProcess[] = [];

async function main(): Promise<void> {
  info(`V09-29 HTTP 状态投影与接续入口同判据 · 专项（${process.platform} · node ${process.version}）`);
  info(`  夹具 ${PROJ}（隔离 TATAI_HOME=${HOME}，真 index.ts 动态端口）`);

  mkdirp(HOME);
  write(path.join(PROJ, ".工作台", "design.md"), "# 夹具设计书\n\n## 1 目标\n\n夹具设计正文。\n");
  write(path.join(PROJ, ".工作台", "plan.md"), PLAN_TEXT);
  write(path.join(PROJ, FOO_REL), FOO_V1);
  addProject({ id: PID, name: "HTTP 新鲜度夹具", path: PROJ, kind: "backend" }, HOME);

  const child = spawn(process.execPath, ["--import", "tsx", DESKTOP_ENTRY], { cwd: ROOT, env: cleanEnv(), windowsHide: true });
  children.push(child);
  let clog = "";
  child.stdout?.on("data", (d: Buffer) => (clog += d.toString("utf8")));
  child.stderr?.on("data", (d: Buffer) => (clog += d.toString("utf8")));

  const desc = await waitDescriptor(45_000);
  ok(desc !== null, "0-1 真 index.ts 桌面后端起并发布描述符（动态端口）", { log: clog.slice(-400) });
  if (desc === null) throw new Error("桌面后端未发布描述符");

  const client = new WorkServiceClient({ dataDir: HOME, autostart: false });
  const ctx: McpContext = { clientName: "verify-http-fresh", work: client };

  // 经 MCP 工具导入施工定义（真写口；施工图从登记的 .工作台/plan.md 现读）
  const imp = await call("import_plan_definitions", { project_id: PID, role: "coordinator", change_id: CHG }, ctx);
  ok(imp.ok, "0-2 经 MCP 工具 import_plan_definitions 导入施工定义（真唯一写口）", imp.text.slice(0, 300));

  // ① 登记源清单 + 绑 code 的自检
  const fooSha = sha256(FOO_V1);
  const store = await call("record_work_evidence", {
    op: "store", project_id: PID, role: "executor", kind: "source_manifest", summary: "T-1 源清单",
    binding: { revision_kind: "code", revision: fooSha }, source_manifest: [{ path: FOO_REL, sha256: fooSha }],
  }, ctx);
  ok(store.ok, "①-1 源清单经唯一写宿主登记（桌面宿主转发证据写口）", store.text.slice(0, 240));
  const manifestSha = String(asObj(asObj(store.json).evidence).sha256 ?? "");
  const manifestFp = String(asObj(asObj(asObj(store.json).evidence).source_manifest).fingerprint ?? "");
  ok(/^[0-9a-f]{64}$/.test(manifestSha), `①-2 清单回执带内容寻址 sha（${manifestSha.slice(0, 12)}…）`);

  const selfCheck = await call("record_work_evidence", {
    op: "self_check", project_id: PID, role: "executor", actor_id: "agent-1", change_id: CHG,
    record_id: "sc-http-1", task_id: "T-1", checked_by: "agent-1", conclusion: "pass",
    binding: { revision_kind: "code", revision: manifestFp === "" ? fooSha : manifestFp },
    checks: [{ check_id: "T-1::check:0", method: "跑 foo 检查", command: "node -e check", exit_code: 0, output_ref: `evidence:${manifestSha}`, evidence_sha256: manifestSha, scope: [FOO_REL], verifies: "code" }],
  }, ctx);
  ok(selfCheck.ok, "①-3 绑 code 修订 = 清单指纹的检查在册", selfCheck.text.slice(0, 240));

  const beforeHttp = await httpGetJson(desc.host, desc.port, `/api/projects/${PID}/status-projection`);
  const before = httpCheckEffectiveness(beforeHttp.json, "T-1", "T-1::check:0");
  ok(beforeHttp.status === 200 && before?.effective === "passed", "①-4 改源前：HTTP 状态投影检查 passed", { status: beforeHttp.status, effective: before?.effective });

  // ② 改被覆盖的真实源文件、不再上报
  write(path.join(PROJ, FOO_REL), FOO_V2);
  const afterHttp = await httpGetJson(desc.host, desc.port, `/api/projects/${PID}/status-projection`);
  const after = httpCheckEffectiveness(afterHttp.json, "T-1", "T-1::check:0");
  ok(after?.effective === "stale", "②-1 改源后：HTTP 状态投影**同判 stale**（不延续历史照旧 passed）", { effective: after?.effective });
  ok(
    asObj(after?.source_manifest).status === "invalidated" && Array.isArray(asObj(after?.source_manifest).changed) && (asObj(after?.source_manifest).changed as string[]).includes(FOO_REL),
    "②-2 HTTP 读口带 source_manifest=invalidated 并点名变了的是 src/foo.ts",
    after?.source_manifest,
  );
  const entryAfter = entryCheckEffectiveness("T-1", "T-1::check:0");
  ok(entryAfter?.effective === "stale", "②-3 entry 同口径投影也判 stale", { effective: entryAfter?.effective });
  ok(after?.effective === entryAfter?.effective, "②-4 HTTP 读口与 entry 投影**同判**（一处结论，不许各说各话）", { http: after?.effective, entry: entryAfter?.effective });

  // http 响应里也要能取到 /audit 读口同样结论（F-1 提到的另一处）
  const afterAudit = await httpGetJson(desc.host, desc.port, `/api/projects/${PID}/audit`);
  ok(afterAudit.status === 200, "②-5 /audit 读口可用（同一 index.ts 装配）", { status: afterAudit.status });

  // ③ 复原源文件 → 两边恢复 passed
  write(path.join(PROJ, FOO_REL), FOO_V1);
  const backHttp = await httpGetJson(desc.host, desc.port, `/api/projects/${PID}/status-projection`);
  const back = httpCheckEffectiveness(backHttp.json, "T-1", "T-1::check:0");
  const entryBack = entryCheckEffectiveness("T-1", "T-1::check:0");
  ok(back?.effective === "passed" && entryBack?.effective === "passed", "③-1 复原源文件 → HTTP 与 entry 都恢复 passed（不无依据全失效）", { http: back?.effective, entry: entryBack?.effective });

  // ④ 无来源的 code 检查 → HTTP 读口也判 unknown（历史自报不冒充新鲜验证；不是"历史照旧 passed"）
  const plainEv = await call("record_work_evidence", {
    op: "store", project_id: PID, role: "executor", kind: "other", summary: "旧自报原始输出", content: "旧自报原始输出（无源清单）\n",
    binding: { revision_kind: "code", revision: sha256(FOO_V1) },
  }, ctx);
  const plainEvSha = String(asObj(asObj(plainEv.json).evidence).sha256 ?? "");
  const noManifest = await call("record_work_evidence", {
    op: "self_check", project_id: PID, role: "executor", actor_id: "agent-2", change_id: CHG,
    record_id: "sc-http-nomanifest", task_id: "T-1", checked_by: "agent-2", conclusion: "pass",
    binding: { revision_kind: "code", revision: sha256(FOO_V1) },
    checks: [{ check_id: "T-1::evidence", method: "旧自报", evidence_sha256: plainEvSha, verifies: "code" }],
  }, ctx);
  ok(noManifest.ok, "④-0 无清单的 code 检查在册（历史记录原样保留）", noManifest.text.slice(0, 240));
  // 检查 id 用施工图"完成证据"对应的 `T-1::evidence`（与夹具卡的验收项同一 id 面；任意 id 不会被投影收纳）
  const nmHttp = await httpGetJson(desc.host, desc.port, `/api/projects/${PID}/status-projection`);
  const nm = httpCheckEffectiveness(nmHttp.json, "T-1", "T-1::evidence");
  const nmEntry = entryCheckEffectiveness("T-1", "T-1::evidence");
  ok(nm?.effective === "unknown", "④-1 HTTP 读口对无清单的 code 检查判 unknown（无来源不冒充新鲜 passed）", { effective: nm?.effective });
  ok(nm?.effective === nmEntry?.effective, "④-2 HTTP 与 entry 同判（无来源 → 两侧都 unknown）", { http: nm?.effective, entry: nmEntry?.effective });

  info(`── 收尾：${passCount} PASS / ${failCount} FAIL`);
  console.log(failCount === 0 ? "[verify] 结果: 全部 PASS" : "[verify] 结果: FAIL（上面有 FAIL 行）");
}

async function cleanup(): Promise<void> {
  for (const c of children) { try { if (c.exitCode === null) c.kill(); } catch { /* ignore */ } }
  await sleep(300);
  for (const c of children) { try { if (c.exitCode === null) c.kill("SIGKILL"); } catch { /* ignore */ } }
  if (process.env.TATAI_KEEP_TMP !== "1") { try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch { /* ignore */ } }
  else info(`  保留现场 ${tmpBase}`);
}

main()
  .catch((e) => { console.error(`[verify] 脚本异常：${e instanceof Error ? (e.stack ?? e.message) : String(e)}`); process.exitCode = 1; })
  .finally(() => { void cleanup(); });
