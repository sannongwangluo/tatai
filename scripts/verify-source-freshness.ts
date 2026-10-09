// V09-29 证据有效性/来源变化验证脚本（PLAN V09-29；DESIGN.md §5.6；契约 F4）。
//
// 判据（先 RED 对照再 GREEN，真跑）：
//   · **主反例**：一条"检查通过"绑 code 修订；随后改掉被覆盖的真实源文件、**不再上报**。
//     - 旧口径（拿账本自报的 code 修订当"当前代码版本"）→ 永远 passed = **假绿**（本脚本 §3 明确记 RED 对照）；
//     - 新口径（当前源码默认未知 / 带清单的按声明范围现读复核）→ 无清单 = unknown 待复核；覆盖源变了 = stale。
//   · 保留历史记录 ≠ 继续采信它是当前验证：**不删除、不改写任何历史事件**，只改读侧结论。
//
// 口径：**经真实 MCP 工具 handler**（`findTool(...).handler`）＋**真实唯一写入服务**（进程内 WorkService +
// 回环 HTTP + 描述符 + WorkServiceClient）＋**真实读侧投影**（`collectProjectFacts`/`projectFromFacts`，
// 与 project_entry / HTTP 读口同一装配）。隔离：mkdtemp 夹具 + 隔离 TATAI_HOME + 随机端口；
// 不碰真实 ~/.tatai、真实项目与账本、8787；收尾清临时目录。
//
// 覆盖：好清单登记/读回；覆盖源改了不报 → stale；无关未覆盖文件变化 → 不变；删除覆盖文件 → stale；
// 覆盖路径取不到内容 → unknown；**清单指纹与检查绑定不一致 → unknown（不拿无关清单背书）**；坏清单如实拒
// （越界/绝对路径/盘符/UNC/忽略目录/私密文件/大小写/缺失/编造哈希/超量/空）；**业务 audit 目录不受影响**；
// git 忽略路径拒（有界 check-ignore）；读口 sha256 严格 64hex；**无清单的 code 检查 → unknown（消除假绿）**；
// 结果回报交付包只读映射；RED 对照（旧口径 → passed）。
// **载体完整性（V09-29 终审补修）**：只改载体正文 `content`、保留 `source_manifest`/`binding` →
// 读侧判 `intact:false` ⇒ unknown（证据不可变、正文必须可取回；历史事件原样保留，读口取回被拒）。
// **Git 探针 fail-closed**：非 Git 项目明确不适用；真仓探针失败（坏 `.git`/git 不可用）→ 拒绝登记
// （"未知"绝不当"未忽略"）；真仓探针成功仍照旧剔忽略路径、不误伤未忽略文件。
//
// **RED（先红）**：以文档化的测试专用覆盖 `opts.code_revision`（契约允许的显式覆盖）**复现旧默认**——
// 把账本自报的 code 修订当"当前代码版本"（修复前 `revisions.code = latestCodeBindingRevision`）。此模式下
// §11 的「源码已在盘上改过、但不再上报」的无清单检查仍判 passed = **假绿**（11-3/11-4 按 RED 期望失败；
// 其余断言与 GREEN 一致）：
//   TATAI_V0929_LEGACY_CODE_REV=1 npx tsx scripts/verify-source-freshness.ts   → 期望 FAIL（11-3 判 passed）
// **GREEN（后绿）**：不带该变量（产品默认 `code=null`）→ §11 判 unknown，全绿：
//   npx tsx scripts/verify-source-freshness.ts                                  → 期望 全 PASS
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { addProject } from "../src/server/registry";
import { WorkService, WorkServiceClient, handleWorkRequest, writeServiceDescriptor } from "../src/server/work/service";
import { submitDefinitionImports } from "../src/server/work/tasks";
import { claimTask, readClaimEvents } from "../src/server/work/claims";
import { submitSubmission } from "../src/server/work/audit";
import {
  checkEffectiveness,
  checksWithSourceManifests,
  collectProjectFacts,
  projectFromFacts,
  type CheckInput,
} from "../src/server/work/statusProjection";
import { buildSourceManifest, gitIgnoredPaths, verifySourceManifest } from "../src/server/work/sourceEvidence";
import { importPlanChecked } from "../src/server/work/references";
import { findTool } from "../src/mcp/tools";
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
const sha256 = (t: string | Buffer): string => crypto.createHash("sha256").update(t).digest("hex");

// ── 隔离夹具 ──
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-v0929-fresh-"));
const dataDir = path.join(tmpBase, "home");
const projRoot = path.join(tmpBase, "proj-fx");
process.env.TATAI_HOME = dataDir;
process.env.TATAI_NO_AUTOSTART = "1";
const PID = "fx29";
const CHG = "chg-29";
const workDir = path.join(projRoot, ".工作台", "work");
/**
 * RED 复现开关（测试专用）：`opts.code_revision` 是契约允许的**显式覆盖**——置 1 即复现修复前的默认口径
 * （拿账本自报的 code 修订当"当前代码版本"）。产品路径**不**传它，故这正是"旧口径"的精确对照。
 */
const LEGACY_CODE_REV = process.env.TATAI_V0929_LEGACY_CODE_REV === "1";

const mkdirp = (d: string): void => { fs.mkdirSync(d, { recursive: true }); };
const write = (f: string, t: string): void => { mkdirp(path.dirname(f)); fs.writeFileSync(f, t, "utf8"); };
const rm = (f: string): void => { fs.rmSync(f, { recursive: true, force: true }); };

// 施工图：T-1（1 条验收项 + 交付要求）、T-2（第二张卡，用于"清单与检查绑定不一致"反例）
const PLAN_TEXT = [
  "# V09-29 夹具施工图",
  "",
  "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |",
  "| --- | --- | --- | --- | --- |",
  "| T-1 | todo | 夹具源码能力落成 |  | T-1 验收记录 |",
  "| T-2 | todo | 夹具第二卡落成 |  | T-2 验收记录 |",
  "",
  "### T-1 夹具源码能力落成",
  "",
  "**设计依据**：§1。**文件责任**：`src/foo.ts`、`src/other.ts`。**责任角色**：executor。",
  "",
  "- [ ] 夹具源码能力落成",
  "",
  "**交付**：能力验收记录。",
  "",
  "### T-2 夹具第二卡落成",
  "",
  "**设计依据**：§1。**文件责任**：`src/foo.ts`。**责任角色**：executor。",
  "",
  "- [ ] 第二卡能力落成",
  "",
  "**交付**：第二卡验收记录。",
  "",
].join("\n");

const FOO_REL = "src/foo.ts";
const OTHER_REL = "src/other.ts";
const AUDIT_REL = "audit/business-check.ts";
const FOO_V1 = "export const FOO = 'foo-v1';\n";
const FOO_V2 = "export const FOO = 'foo-v2-changed';\n";
const OTHER_V1 = "export const OTHER = 'other-v1';\n";
const OTHER_V2 = "export const OTHER = 'other-v2-changed';\n";

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
const errCode = (j: unknown): string => String(asObj(j).code ?? "");
const eventCount = (): number => { try { return readClaimEvents(workDir).length; } catch { return -1; } };
const entityRev = (entityId: string): number => readClaimEvents(workDir).filter((e) => e.entity_id === entityId).length;

async function startService(): Promise<{ server: http.Server; service: WorkService }> {
  const service = new WorkService({ dataDir });
  const token = crypto.randomBytes(18).toString("base64url");
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    void handleWorkRequest(req, res, { service, token, pathname }).then((handled) => { if (!handled) { res.writeHead(404); res.end(); } });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  writeServiceDescriptor(dataDir, { schema_version: 2, pid: process.pid, host: "127.0.0.1", port, token, started_at: new Date().toISOString(), url: `http://127.0.0.1:${port}` });
  return { server, service };
}

/** 读侧：目标检查的现读复核结论（与 project_entry / HTTP 读口同一装配口径） */
function effectivenessOf(taskId: string, checkId: string): { effective: string; manifest: unknown } | null {
  const { projection } = projectFromFacts(PID, dataDir, LEGACY_CODE_REV ? { code_revision: sha256(FOO_V1) } : {});
  const basis = projection.by_id[taskId]?.evidence_basis.find((b) => b.check_id === checkId);
  if (basis === undefined) return null;
  return { effective: basis.effective, manifest: basis.source_manifest ?? null };
}

/**
 * 读侧（直连装配，与 `projectFromFacts` 同一份 `checksWithSourceManifests`）：取指定 check_id 的
 * 现读复核结论。用于**不属于任何卡必需项**的反例检查（投影只收必需项，直连装配能覆盖任意 check_id）。
 */
function readSideEffective(checkId: string): { effective: string; manifest: unknown } | null {
  const facts = collectProjectFacts(PID, dataDir);
  const checks = checksWithSourceManifests(facts.audit, { projectRoot: projRoot, workDir: facts.work_dir });
  const target = checks.find((c) => c.check_id === checkId);
  if (target === undefined) return null;
  const eff = checkEffectiveness(target, facts.revisions, new Set(), facts.binding_segments);
  return { effective: eff.effective, manifest: target.source_manifest ?? null };
}

/** 读侧：该检查当前的缺口理由（未通过/待复核的检查会进 missing.why） */
function missingWhy(taskId: string, checkId: string): string {
  const { projection } = projectFromFacts(PID, dataDir, LEGACY_CODE_REV ? { code_revision: sha256(FOO_V1) } : {});
  return projection.by_id[taskId]?.missing.find((m) => m.check_id === checkId)?.why ?? "";
}

async function main(): Promise<void> {
  info(`V09-29 证据有效性验证（${process.platform} · node ${process.version}）`);
  info(`  夹具根 ${tmpBase}（TATAI_HOME ${dataDir}）`);
  mkdirp(dataDir);
  write(path.join(projRoot, ".工作台", "design.md"), "# 夹具设计书\n\n## 1 目标\n\n夹具设计正文。\n");
  write(path.join(projRoot, ".工作台", "plan.md"), PLAN_TEXT);
  write(path.join(projRoot, FOO_REL), FOO_V1);
  write(path.join(projRoot, OTHER_REL), OTHER_V1);
  write(path.join(projRoot, AUDIT_REL), "export const BUSINESS = 'audit-dir-is-not-secret';\n");
  addProject({ id: PID, name: "V09-29 夹具", path: projRoot, kind: "backend" }, dataDir);

  const live = await startService();
  const client = new WorkServiceClient({ dataDir, autostart: false });
  const ctx: McpContext = { clientName: "verify-fresh", work: client };
  const submitter = { submit: (c: unknown) => live.service.submit(c) };
  const defs = importPlanChecked(PLAN_TEXT, workDir).definitions;
  submitDefinitionImports(submitter, { project_id: PID, change_id: CHG, actor_id: "fixture", role: "coordinator", definitions: defs });

  // ═══ 0. 工具就位 ═══
  info("── 0. 工具与夹具");
  ok(findTool("record_work_evidence") !== undefined, "0-1 record_work_evidence 已注册（工具入口可达）");

  // ═══ 1. 登记源清单（服务端现读核实） ═══
  info("── 1. 源清单登记（有限文件集合 + 内容哈希，服务端现读核实）");
  const fooShaV1 = sha256(FOO_V1);
  // 载体**自报绑定**必须 == 清单指纹（= 检查要绑的 code 修订）：先用服务端同一实现把指纹算出来当登记
  // binding；不预知指纹就登记会让读侧按"载体绑定与检查对不上"判未知（这正是要修的口径）。
  const manifestFp = buildSourceManifest(projRoot, [{ path: FOO_REL, sha256: fooShaV1 }]).fingerprint;
  const store = await call("record_work_evidence", {
    op: "store", project_id: PID, role: "executor", kind: "source_manifest",
    summary: "T-1 检查覆盖的源码清单", created_by: "agent-1",
    binding: { revision_kind: "code", revision: manifestFp },
    source_manifest: [{ path: FOO_REL, sha256: fooShaV1 }],
  }, ctx);
  ok(store.ok, "1-1 源清单经 record_work_evidence(store) 登记成功（服务端现读核实）", store.text.slice(0, 240));
  const manifestSha = String(asObj(asObj(store.json).evidence).sha256 ?? "");
  const manifestFiles = asObj(asObj(asObj(store.json).evidence).source_manifest).files;
  ok(
    /^[0-9a-f]{64}$/.test(manifestSha) && /^[0-9a-f]{64}$/.test(manifestFp) &&
      Array.isArray(manifestFiles) && (manifestFiles as unknown[]).length === 1,
    `1-2 回执带内容寻址 sha 与清单指纹、1 条文件（sha=${manifestSha.slice(0, 12)}…, fp=${manifestFp.slice(0, 12)}…）`,
    { manifestSha, manifestFp },
  );
  const readBack = await call("record_work_evidence", { op: "read", project_id: PID, sha256: manifestSha }, ctx);
  ok(
    readBack.ok && String(asObj(asObj(readBack.json).evidence).content ?? "").includes(FOO_REL),
    "1-3 读回清单证据正文（宿主只读读口，正文含覆盖路径）",
    readBack.text.slice(0, 200),
  );
  // 非 Git 项目：这一层明确不适用（不是"没忽略"）——1-1 的登记能成，正因为探针如实报"不适用"
  const noGitProbe = gitIgnoredPaths(projRoot, [FOO_REL]);
  ok(
    noGitProbe.is_repo === false && noGitProbe.failure === null && noGitProbe.ignored.size === 0,
    "1-4 非 Git 项目：忽略探针明确不适用（is_repo=false，不是把未知当未忽略）",
    { is_repo: noGitProbe.is_repo, failure: noGitProbe.failure },
  );

  // ═══ 2. 主反例（GREEN）：检查通过绑清单指纹，随后改真实源文件但不再上报 ═══
  info("── 2. 主反例：覆盖源码改了不再上报 → 旧检查必须失效");
  const selfCheck = await call("record_work_evidence", {
    op: "self_check", project_id: PID, role: "executor", actor_id: "agent-1", change_id: CHG,
    record_id: "sc-fresh-1", task_id: "T-1", checked_by: "agent-1", conclusion: "pass",
    binding: { revision_kind: "code", revision: manifestFp },
    checks: [{
      check_id: "T-1::check:0", method: "跑 foo 检查", command: "node -e check",
      exit_code: 0, output_ref: `evidence:${manifestSha}`, evidence_sha256: manifestSha,
      scope: [FOO_REL], verifies: "code",
    }],
  }, ctx);
  ok(selfCheck.ok, "2-1 检查（绑 code 修订 = 清单指纹）记录在册", selfCheck.text.slice(0, 240));
  if (!selfCheck.ok) { info("2-x 检查登记失败，后续断言将连锁失败——先修登记再复跑"); }

  const before = effectivenessOf("T-1", "T-1::check:0");
  ok(before?.effective === "passed" && asObj(before?.manifest).status === "valid",
    `2-2 改源**之前**：清单覆盖范围一致 → 检查 passed（实际 ${before?.effective}）`, before);

  // 关键一步：改掉被覆盖的真实源文件，**不再上报任何事件**
  const eventsBeforeEdit = eventCount();
  write(path.join(projRoot, FOO_REL), FOO_V2);
  ok(eventCount() === eventsBeforeEdit, "2-3 改源之后**没有**新增任何账本事件（正是「改了但不再上报」的现场）");

  const after = effectivenessOf("T-1", "T-1::check:0");
  ok(
    after?.effective === "stale",
    `2-4 改源**之后**：覆盖的源码变了 → 旧检查必须失效（stale），不能仍算 passed（实际 ${after?.effective}）`,
    after,
  );
  ok(
    asObj(after?.manifest).status === "invalidated" && Array.isArray(asObj(after?.manifest).changed) &&
      (asObj(after?.manifest).changed as string[]).includes(FOO_REL),
    "2-5 失效结论如实点名：清单现读复核 = invalidated，且指出变了的是 src/foo.ts",
    after?.manifest,
  );

  // ═══ 3. RED 对照：旧口径拿账本自报的 code 修订当"当前代码版本" → 恒 passed（本卡要消除的假绿） ═══
  info("── 3. RED 对照（小对照，不整树还原）：旧口径 vs 新口径");
  const decisionAt = effectivenessOf("T-1", "T-1::check:0");
  ok(decisionAt !== null, "3-0 目标检查在投影里可见（用于小对照）");
  const probe: CheckInput = {
    check_id: "T-1::check:0", object_id: "T-1", result: "passed", actor_id: "agent-1", role: "executor",
    independence: "author_self", at: new Date().toISOString(),
    binding: { revision_kind: "code", revision: manifestFp },
    evidence_sha256: manifestSha, command: "node -e check", exit_code: 0, method: "跑 foo 检查", verifies: "code",
  };
  // 旧口径：`revisions.code = latestCodeBindingRevision(...)`（账本自报值）——源改了它也不会变，于是恒 passed
  const oldEff = checkEffectiveness(probe, { code: manifestFp }, new Set());
  // 新口径：产品读口默认 `code = null`（当前源码未知）——没有可核对来源的 code 检查一律待复核
  const newEff = checkEffectiveness(probe, { code: null }, new Set());
  info(`  RED 对照：旧口径（自报 code 修订）= ${oldEff.effective}；新口径（当前源码未知/清单现读）= ${newEff.effective}`);
  ok(oldEff.effective === "passed",
    "3-1 RED：旧口径把「改了源、不再上报」的检查判 passed（源在盘上已改，自报修订却没变）——这就是假绿");
  ok(newEff.effective === "unknown",
    "3-2 GREEN：新口径（当前源码未知）→ unknown 待复核，不默认通过");

  // ═══ 4. 无关且未覆盖的文件变化 → 不失效 ═══
  info("── 4. 无关未覆盖文件变化不无依据全失效");
  write(path.join(projRoot, FOO_REL), FOO_V1); // 先把覆盖面恢复一致
  const restored = effectivenessOf("T-1", "T-1::check:0");
  ok(restored?.effective === "passed", `4-0 覆盖面内容恢复一致 → 又 passed（实际 ${restored?.effective}）`, restored);
  write(path.join(projRoot, OTHER_REL), OTHER_V2); // 改**未覆盖**的 src/other.ts
  const untouched = effectivenessOf("T-1", "T-1::check:0");
  ok(
    untouched?.effective === "passed",
    `4-1 改未覆盖的 ${OTHER_REL} → 覆盖范围（只含 ${FOO_REL}）没变 → 检查仍 passed（不无依据全失效）（实际 ${untouched?.effective}）`,
    untouched,
  );
  write(path.join(projRoot, OTHER_REL), OTHER_V1);

  // ═══ 5. 删除覆盖文件 → 失效 ═══
  info("── 5. 删除覆盖文件 → 失效");
  const fooAbs = path.join(projRoot, FOO_REL);
  rm(fooAbs);
  const deleted = effectivenessOf("T-1", "T-1::check:0");
  ok(
    deleted?.effective === "stale" && (asObj(deleted?.manifest).missing as string[] | undefined)?.includes(FOO_REL) === true,
    `5-1 覆盖文件被删 → 失效（stale）且记 missing（实际 ${deleted?.effective}）`,
    deleted,
  );
  write(fooAbs, FOO_V1);

  // ═══ 6. 覆盖文件取不到内容 → 未知待复核（不是通过，也不是失效） ═══
  info("── 6. 覆盖路径取不到内容 → 未知待复核");
  rm(fooAbs);
  fs.mkdirSync(fooAbs, { recursive: true });
  const unreadable = effectivenessOf("T-1", "T-1::check:0");
  ok(
    unreadable?.effective === "unknown" && asObj(unreadable?.manifest).status === "unreadable",
    `6-1 覆盖路径变成目录（取不到内容）→ 未知待复核（unknown），不当通过也不静默失效（实际 ${unreadable?.effective}）`,
    unreadable,
  );
  rm(fooAbs);
  write(fooAbs, FOO_V1);

  // ═══ 7. 清单与检查绑定不一致 → 未知待复核（不拿无关清单背书） ═══
  info("── 7. 清单指纹 ≠ 检查绑定的 code 修订 → unknown");
  const mismatch = await call("record_work_evidence", {
    op: "self_check", project_id: PID, role: "executor", actor_id: "agent-3", change_id: CHG,
    record_id: "sc-mismatch-1", task_id: "T-2", checked_by: "agent-3", conclusion: "pass",
    // 绑到 T-2 的 code 修订 = other 的文件哈希，却引用 T-1 那份清单（指纹对不上）
    binding: { revision_kind: "code", revision: sha256(OTHER_V1) },
    checks: [{
      check_id: "T-2::check:0", method: "跑 T-2 检查", command: "node -e t2", exit_code: 0,
      output_ref: `evidence:${manifestSha}`, evidence_sha256: manifestSha, verifies: "code",
    }],
  }, ctx);
  ok(mismatch.ok, "7-1 不一致用例的检查已登记在册", mismatch.text.slice(0, 200));
  const mismatched = effectivenessOf("T-2", "T-2::check:0");
  ok(
    mismatched?.effective === "unknown" && asObj(mismatched?.manifest).status === "unreadable",
    `7-2 清单指纹与检查绑定的 code 修订不一致 → unknown（不拿无关清单给旧 check 通行）（实际 ${mismatched?.effective}）`,
    mismatched,
  );

  // ═══ 8. 坏清单/越界/私密 → 如实拒（登记前） ═══
  info("── 8. 坏清单如实拒（越界·绝对路径·盘符·UNC·忽略目录·私密文件·大小写·缺失·编造哈希·超量·空）");
  const eventsBeforeRejects = eventCount();
  const storeArgs = (manifest: unknown): Record<string, unknown> => ({
    op: "store", project_id: PID, role: "executor", kind: "source_manifest", summary: "坏清单反例",
    created_by: "agent-1", binding: { revision_kind: "code", revision: fooShaV1 }, source_manifest: manifest,
  });
  const rejectCases: { label: string; manifest: unknown }[] = [
    { label: "越界相对路径 ../outside.ts", manifest: ["../outside.ts"] },
    { label: "绝对路径 /etc/passwd", manifest: ["/etc/passwd"] },
    { label: "带盘符 C:/x/y", manifest: ["C:/x/y"] },
    { label: "UNC 路径 //host/share/x", manifest: ["//host/share/x"] },
    { label: "私密忽略目录 .工作台/work/events.jsonl", manifest: [".工作台/work/events.jsonl"] },
    { label: "忽略目录 node_modules/x.js", manifest: ["node_modules/x.js"] },
    { label: "忽略目录大小写 NODE_MODULES/x.js", manifest: ["NODE_MODULES/x.js"] },
    { label: "私密文件 .env", manifest: [".env"] },
    { label: "私密文件 .ENV.local（大小写）", manifest: [".ENV.local"] },
    { label: "私密文件 credentials.json", manifest: ["credentials.json"] },
    { label: "私密文件 id_rsa", manifest: ["id_rsa"] },
    { label: "私密文件 server.pem", manifest: ["server.pem"] },
    { label: "私密文件 secrets.yaml", manifest: ["secrets.yaml"] },
    { label: "不存在的文件", manifest: ["src/does-not-exist.ts"] },
    { label: "编造当前哈希（对不上现读）", manifest: [{ path: FOO_REL, sha256: "0".repeat(64) }] },
    { label: "非 64hex 的声明哈希", manifest: [{ path: FOO_REL, sha256: "abc" }] },
    { label: "空清单", manifest: [] },
    { label: "超量清单（600 条）", manifest: Array.from({ length: 600 }, (_, i) => `src/gen-${i}.ts`) },
  ];
  for (const rc of rejectCases) {
    const r = await call("record_work_evidence", storeArgs(rc.manifest), ctx);
    ok(!r.ok && /EVIDENCE_INVALID|INVALID_COMMAND/.test(errCode(r.json)), `8 拒收：${rc.label}（code=${errCode(r.json)}）`, r.text.slice(0, 200));
  }
  // 业务 audit 目录**不是秘密**：不被固定段表误伤（这正是本次要纠正的过宽口径）
  const auditDir = await call("record_work_evidence", storeArgs([AUDIT_REL]), ctx);
  ok(auditDir.ok, "8-x 业务目录 audit/ 下的真实源码可登记（不把普通业务 audit 目录当秘密）", auditDir.text.slice(0, 200));
  // 符号链接逃逸（若平台允许建软链）
  const linkRel = "src/link-escape.ts";
  const linkAbs = path.join(projRoot, linkRel);
  const outside = path.join(tmpBase, "outside.ts");
  write(outside, "export const OUT = 1;\n");
  let linkMade = false;
  try { fs.symlinkSync(outside, linkAbs); linkMade = true; } catch { /* Windows 无权限建软链：跳过 */ }
  if (linkMade) {
    const r = await call("record_work_evidence", storeArgs([linkRel]), ctx);
    ok(!r.ok, `8 拒收：符号链接逃逸 ${linkRel}（code=${errCode(r.json)}）`, r.text.slice(0, 200));
    rm(linkAbs);
  } else {
    info("8 符号链接用例跳过：当前环境不允许建软链（非确定性，不冒充通过）");
  }
  ok(eventCount() === eventsBeforeRejects, "8-尾 全部坏清单在**动账本前**被拒（事件数不变）", { before: eventsBeforeRejects, after: eventCount() });

  // ═══ 9. 读口的 sha256 严格 64hex（拒绝路径穿越） ═══
  info("── 9. 读口 sha256 严格校验");
  const badRead = await call("record_work_evidence", { op: "read", project_id: PID, sha256: "../../etc/passwd" }, ctx);
  ok(!badRead.ok && /INVALID_COMMAND/.test(errCode(badRead.json)), `9-1 非 64hex 的 sha256 → 拒（拒绝路径穿越）（code=${errCode(badRead.json)}）`, badRead.text.slice(0, 200));
  const missingRead = await call("record_work_evidence", { op: "read", project_id: PID, sha256: "a".repeat(64) }, ctx);
  ok(!missingRead.ok && /EVIDENCE_INVALID/.test(errCode(missingRead.json)), `9-2 合法但不存在的 sha256 → EVIDENCE_INVALID（不是空成功）（code=${errCode(missingRead.json)}）`, missingRead.text.slice(0, 200));

  // ═══ 10. 交付包只读映射（task.result_submitted 的验证/未测/已知问题） ═══
  info("── 10. 结果回报交付包只读映射（不只看 runtime_entries）");
  const evidenceForDelivery = await call("record_work_evidence", {
    op: "store", project_id: PID, role: "executor", kind: "other",
    summary: "交付证据", content: "交付证据正文\n", created_by: "agent-1",
    binding: { revision_kind: "code", revision: sha256(FOO_V1) },
  }, ctx);
  ok(evidenceForDelivery.ok, "10-0 交付证据正文落库（store）", evidenceForDelivery.text.slice(0, 200));
  const deliveryEvSha = String(asObj(asObj(evidenceForDelivery.json).evidence).sha256 ?? "");
  const sub = submitSubmission(submitter, {
    project_id: PID, change_id: CHG, actor_id: "agent-1", role: "executor", record_id: "sub-29-1",
    goal: "T-1 交付", task_id: "T-1", submitted_by: "agent-1",
    changed_files: [FOO_REL], untested: [{ item: "真实项目迁移", reason: "按夹具红线不碰真实项目" }],
    known_issues: ["F8 已知限制（待用户接受）"],
    commands: [{ command: "node -e check", exit_code: 0, output_ref: `evidence:${deliveryEvSha}` }],
    evidence_refs: [deliveryEvSha], binding: { revision_kind: "code", revision: sha256(FOO_V1) },
  });
  ok(sub.seq >= 0, "10-1 成果登记（audit.submission）落账（用于对照结果回报映射）", { seq: sub.seq });
  // 真实结果回报：落一条 task.result_submitted 事件（与 submitTaskResult 的 payload 同形）。
  // P2/V09-47 返工：结果提交现在必须在锁内按**合法认领 + 证据**核实——夹具先真认领 T-1，再带真 token 交付
  // （不再用假的 "fx-token" 走通，也不能删 token 免检查）。
  const claim29 = await claimTask(
    { project_id: PID, task_id: "T-1", role: "executor", owner_id: "agent-1", change_id: CHG },
    live.service,
    dataDir,
  );
  if (!claim29.ok) throw new Error(`夹具缺陷：认领 T-1 失败：${claim29.message}`);
  const resultSubmit = await live.service.submit({
    schema_version: 2, project_id: PID, change_id: CHG, entity_id: "task:T-1", expected_revision: claim29.claim.entity_revision,
    type: "task.result_submitted", actor_id: "agent-1", role: "executor",
    idempotency_key: `fx29-result-1`, payload: {
      claim_token: claim29.claim.claim_token, owner_id: "agent-1", owner_role: "executor",
      deliverables: ["T-1 交付物"], evidence_refs: [deliveryEvSha],
      verification: [{ command: "node -e check", exit_code: 0, output_ref: `evidence:${deliveryEvSha}` }],
      untested: ["真实项目迁移（夹具不碰）"], known_issues: ["F8 已知限制（待用户接受）"],
      diff_ref: null, result_revision: sha256(FOO_V1), meaning: "执行者已提交结果；不表示审计通过或人工验收接受（DESIGN.md §5.4）",
    },
  });
  ok(resultSubmit.seq >= 0, "10-2 结果回报（task.result_submitted）落账", { seq: resultSubmit.seq });
  const facts = collectProjectFacts(PID, dataDir);
  const summary = (facts.result_submissions ?? []).find((s) => s.task_id === "T-1");
  ok(
    summary !== undefined &&
      summary.verification.some((v) => v.command === "node -e check" && v.exit_code === 0) &&
      summary.untested.length === 1 && summary.known_issues.length === 1 &&
      summary.deliverables.length === 1 && summary.evidence_refs.length === 1,
    "10-3 验收页只读映射：结果回报的 verification/untested/known_issues/deliverables/evidence_refs 都折进只读摘要（Agent 不必补登记 audit.submission）",
    summary,
  );

  // ═══ 11. 无清单的 code 检查 → unknown（消除「源码在盘上改了、不再上报也 passed」的假绿） ═══
  info("── 11. 无清单检查：源码已在盘上改过也不能凭旧自报判 passed（必须 unknown 待复核）");
  // 主反例现场：把被覆盖的真实源码改成 v2、**不再上报任何事件**（检查却仍声称通过、绑旧修订）
  write(path.join(projRoot, FOO_REL), FOO_V2);
  const eventsBeforePlain = eventCount();
  const noManifest = await call("record_work_evidence", {
    op: "self_check", project_id: PID, role: "executor", actor_id: "agent-2", change_id: CHG,
    record_id: "sc-plain-1", task_id: "T-1", checked_by: "agent-2", conclusion: "pass",
    binding: { revision_kind: "code", revision: sha256(FOO_V1) },
    checks: [{ check_id: "T-1::evidence", method: "交付记录", evidence_sha256: deliveryEvSha, verifies: "code" }],
  }, ctx);
  ok(noManifest.ok, "11-1 不带清单的检查照样在册（历史记录原样保留，不删不重写）", noManifest.text.slice(0, 200));
  ok(eventCount() === eventsBeforePlain + 1, "11-2 该检查只落了一条事件：源码变了但**没有**任何「上报变更」的现场");
  const plain = effectivenessOf("T-1", "T-1::evidence");
  ok(
    plain?.effective === "unknown" && plain.manifest === null,
    `11-3 无清单的 code 检查（源码已在盘上改过、未再上报）→ unknown 待复核；` +
      `不得凭账本自报的 code 修订判 passed（实际 ${plain?.effective}；RED 模式会在这里判 passed = 假绿）`,
    plain,
  );
  ok(
    /复核|未知|拿不到/.test(missingWhy("T-1", "T-1::evidence")),
    "11-4 结论如实点名原因（进 missing.why，不是空转的 unknown）",
    missingWhy("T-1", "T-1::evidence"),
  );
  write(path.join(projRoot, FOO_REL), FOO_V1);

  // ═══ 12. 真实被 git 忽略的路径 → 拒（有界 git check-ignore） ═══
  info("── 12. git 忽略路径（有界 git check-ignore，不全盘扫描）");
  let gitReady = false;
  try {
    const r = spawnSync("git", ["init", "-q"], { cwd: projRoot, encoding: "utf8", timeout: 15000, windowsHide: true });
    gitReady = r.status === 0;
  } catch { gitReady = false; }
  if (gitReady) {
    write(path.join(projRoot, ".gitignore"), "local-only.ts\n");
    write(path.join(projRoot, "local-only.ts"), "export const LOCAL = 1;\n");
    write(path.join(projRoot, "src/kept.ts"), "export const KEPT = 1;\n");
    const ignored = await call("record_work_evidence", storeArgs(["local-only.ts"]), ctx);
    ok(!ignored.ok && /EVIDENCE_INVALID/.test(errCode(ignored.json)), `12-1 被 .gitignore 忽略的路径 → 拒（code=${errCode(ignored.json)}）`, ignored.text.slice(0, 200));
    const kept = await call("record_work_evidence", storeArgs(["src/kept.ts"]), ctx);
    ok(kept.ok, "12-2 同目录未被忽略的路径仍可登记（git-ignore 不误伤未忽略文件）", kept.text.slice(0, 200));
  } else {
    info("12 git 忽略用例跳过：当前环境无法 git init（非确定性，不冒充通过）");
  }

  // ═══ 13. 载体正文被改过/截损（清单与 binding 字段未动）→ 读侧必须 unknown ═══
  info("── 13. 载体完整性：只改正文 content、保留 source_manifest/binding → 读侧必须 unknown");
  const TAMPER_REL = "src/tamper.ts";
  write(path.join(projRoot, TAMPER_REL), "export const TAMPER = 'tamper-v1';\n");
  const tamperFp = buildSourceManifest(projRoot, [TAMPER_REL]).fingerprint;
  const tamperStore = await call("record_work_evidence", {
    op: "store", project_id: PID, role: "executor", kind: "source_manifest",
    summary: "载体完整性反例清单", created_by: "agent-9",
    binding: { revision_kind: "code", revision: tamperFp },
    source_manifest: [TAMPER_REL],
  }, ctx);
  ok(tamperStore.ok, "13-1 反例清单（供一条独立检查引用）登记成功", tamperStore.text.slice(0, 200));
  const tamperSha = String(asObj(asObj(tamperStore.json).evidence).sha256 ?? "");
  const tamperCheck = await call("record_work_evidence", {
    op: "self_check", project_id: PID, role: "executor", actor_id: "agent-9", change_id: CHG,
    record_id: "sc-tamper-1", task_id: "T-2", checked_by: "agent-9", conclusion: "pass",
    binding: { revision_kind: "code", revision: tamperFp },
    checks: [{
      check_id: "T-2::check:9", method: "载体完整性检查", command: "node -e t",
      exit_code: 0, evidence_sha256: tamperSha, verifies: "code",
    }],
  }, ctx);
  ok(tamperCheck.ok, "13-2 引用该载体的检查在册", tamperCheck.text.slice(0, 200));
  const tamperBefore = readSideEffective("T-2::check:9");
  ok(
    tamperBefore?.effective === "passed" && asObj(tamperBefore?.manifest).status === "valid",
    `13-3 改载体**之前**：清单覆盖一致 → passed（实际 ${tamperBefore?.effective}）`,
    tamperBefore,
  );
  const eventsBeforeTamper = eventCount();
  // 只改载体正文 content：source_manifest 与 binding 字段原样保留（正是要防的"改正文不改清单"）
  const tamperBlobFile = path.join(workDir, "evidence", `${tamperSha}.json`);
  const tamperBlob = JSON.parse(fs.readFileSync(tamperBlobFile, "utf8")) as Record<string, unknown>;
  tamperBlob.content = `${String(tamperBlob.content)}<!-- 正文被改过：清单/binding 未动 -->\n`;
  fs.writeFileSync(tamperBlobFile, JSON.stringify(tamperBlob, null, 2) + "\n", "utf8");
  const tamperAfter = readSideEffective("T-2::check:9");
  ok(
    tamperAfter?.effective === "unknown" && asObj(tamperAfter?.manifest).status === "unreadable",
    `13-4 只改载体正文（清单/binding 未动）→ unknown 待复核，不拿被改过的载体判 passed（实际 ${tamperAfter?.effective}）`,
    tamperAfter,
  );
  ok(
    eventCount() === eventsBeforeTamper,
    "13-5 历史检查事件原样保留（读侧结论变化不改账本，不删不重写）",
    { before: eventsBeforeTamper, after: eventCount() },
  );
  const tamperRead = await call("record_work_evidence", { op: "read", project_id: PID, sha256: tamperSha }, ctx);
  ok(
    !tamperRead.ok && /EVIDENCE_INVALID/.test(errCode(tamperRead.json)),
    `13-6 被改过的载体经读口取回被拒（证据不可变：正文地址对不上不静默放过）（code=${errCode(tamperRead.json)}）`,
    tamperRead.text.slice(0, 200),
  );
  // 13-7 载体**自报绑定**与检查**不同来源类**（指纹却一致）→ unknown：读回却不用，等于跨来源类也能背书
  const BIND_REL = "src/bindcheck.ts";
  write(path.join(projRoot, BIND_REL), "export const BINDCHECK = 1;\n");
  const bindFp = buildSourceManifest(projRoot, [BIND_REL]).fingerprint;
  const bindStore = await call("record_work_evidence", {
    op: "store", project_id: PID, role: "executor", kind: "source_manifest",
    summary: "载体自报绑定反例清单", created_by: "agent-9",
    binding: { revision_kind: "plan", revision: "plan-rev-x" }, // 故意声明成**别的来源类**
    source_manifest: [BIND_REL],
  }, ctx);
  ok(bindStore.ok, "13-7a 反例清单登记成功（自报绑定=plan 来源类）", bindStore.text.slice(0, 200));
  const bindSha = String(asObj(asObj(bindStore.json).evidence).sha256 ?? "");
  await call("record_work_evidence", {
    op: "self_check", project_id: PID, role: "executor", actor_id: "agent-9", change_id: CHG,
    record_id: "sc-bind-1", task_id: "T-2", checked_by: "agent-9", conclusion: "pass",
    binding: { revision_kind: "code", revision: bindFp },
    checks: [{
      check_id: "T-2::check:10", method: "载体绑定一致性检查", evidence_sha256: bindSha, verifies: "code",
    }],
  }, ctx);
  const bindEff = readSideEffective("T-2::check:10");
  ok(
    bindEff?.effective === "unknown" &&
      asObj(bindEff?.manifest).status === "unreadable" &&
      /绑定/.test(String(asObj(bindEff?.manifest).reason ?? "")),
    `13-7 载体自报绑定与检查**不同来源类**（plan 清单给 code 检查背书；指纹一致）→ unknown（实际 ${bindEff?.effective}）`,
    bindEff,
  );

  // ═══ 14. Git 探针异常（真实仓 + 坏 .git）→ 拒绝登记，不把未知当未忽略 ═══
  info("── 14. Git 探针异常：真实仓探不到忽略 → 拒绝（未知不当未忽略）");
  const gitMarker = path.join(projRoot, ".git");
  const readProbeManifest = buildSourceManifest(projRoot, [BIND_REL]);
  const ignoreFile = path.join(projRoot, ".gitignore");
  const oldIgnore = fs.existsSync(ignoreFile) ? fs.readFileSync(ignoreFile, "utf8") : "";
  fs.writeFileSync(ignoreFile, `${oldIgnore}\n${BIND_REL}\n`, "utf8");
  ok(verifySourceManifest(projRoot, readProbeManifest).status === "unreadable",
    "14-0 登记后忽略规则改变：复核停止读取该路径，按未知待复核");
  fs.writeFileSync(ignoreFile, oldIgnore, "utf8");
  const gitBackup = path.join(tmpBase, "dotgit-backup");
  rm(gitBackup);
  const hadGit = fs.existsSync(gitMarker);
  if (hadGit) fs.renameSync(gitMarker, gitBackup);
  fs.writeFileSync(gitMarker, "gitdir: /nonexistent/nowhere\n", "utf8");
  const brokenProbe = gitIgnoredPaths(projRoot, [FOO_REL]);
  ok(
    brokenProbe.is_repo === true && brokenProbe.failure !== null,
    "14-1 真仓 + 坏 .git：探针明确失败（is_repo=true、failure 非空），不当「未忽略」",
    { is_repo: brokenProbe.is_repo, failure: brokenProbe.failure },
  );
  const brokenStore = await call("record_work_evidence", storeArgs([FOO_REL]), ctx);
  ok(verifySourceManifest(projRoot, readProbeManifest).status === "unreadable",
    "14-1b 读侧 Git 探针失败同样停止读取源码，不能沿用旧通过");
  ok(
    !brokenStore.ok && /EVIDENCE_INVALID/.test(errCode(brokenStore.json)),
    `14-2 Git 探针失败 → 拒绝登记（不能保证不读取忽略目录；未知不当未忽略）（code=${errCode(brokenStore.json)}）`,
    brokenStore.text.slice(0, 240),
  );
  rm(gitMarker);
  if (hadGit) fs.renameSync(gitBackup, gitMarker);

  // ── 收尾 ──
  await new Promise<void>((r) => live.server.close(() => r()));
  info(`── 收尾：${passCount} PASS / ${failCount} FAIL`);
  if (process.env.TATAI_KEEP_TMP !== "1") {
    try { rm(tmpBase); } catch { /* 清理失败不影响结论 */ }
  } else {
    info(`  保留现场 ${tmpBase}`);
  }
  console.log(failCount === 0 ? "[verify] 结果: 全部 PASS" : "[verify] 结果: FAIL（上面有 FAIL 行）");
}

main().catch((e) => {
  console.error(`[verify] 脚本异常：${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  process.exitCode = 1;
});
