// V09-63b 验证脚本（tsx 跑）：**有界返工**——坏指针不回退、select_dev/retire 合法性、executor 真授权、
// 冻结宿主实测绑定与保全、工作区上下文默认可见、认领目标工作区锁内校验。
// （DESIGN.md §6.13／§6.14 第 2/3/6/7 段；PLAN V09-63/V09-65。）用法：npx tsx scripts/verify-v09-63b.ts
// 自带临时 TATAI_HOME 与夹具项目；不碰真实账本。
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
import { evaluateProjectEntry, PROJECT_ENTRY_RESULT_FIELDS } from "../src/server/work/entry";
import { isWorkError } from "../src/server/work/types";
import {
  foldWorkspaces,
  readWorkspaces,
  resolveDevFromProjection,
  mainWorkspaceId,
  registerWorkspace,
  selectDevWorkspace,
  freezeWorkspace,
  retireWorkspace,
  type WorkspaceProjection,
} from "../src/server/work/workspaces";
import { projectWorkDir } from "../src/server/workstation";

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
const sha256 = (s: string): string => crypto.createHash("sha256").update(s, "utf8").digest("hex");

// ── 隔离夹具 ──
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-v09-63b-"));
const dataDir = path.join(tmpBase, "home");
const P = "v0963b";
const root = path.join(tmpBase, "proj");
const devRoot = path.join(tmpBase, "dev");
const candRoot = path.join(tmpBase, "cand");
const goneRoot = path.join(tmpBase, "gone");
fs.mkdirSync(path.join(root, ".工作台"), { recursive: true });
fs.mkdirSync(path.join(devRoot, "src"), { recursive: true });
fs.mkdirSync(path.join(candRoot, "src"), { recursive: true });

const write = (f: string, text: string): void => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text, "utf8");
};

const DESIGN = "# V09-63b 夹具设计书\n\n## 2 模块划分\n\n| # | 模块 | 说明 |\n| --- | --- | --- |\n| 1 | 甲模块 | 夹具 |\n";
const PLAN = [
  "# V09-63b 夹具施工图",
  "",
  "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |",
  "| --- | --- | --- | --- | --- |",
  "| W-1 | todo | 认领卡 |  | W-1 验收记录 |",
  "",
  "### W-1 认领卡",
  "",
  "**设计依据**：§2。**契约**：输入甲，输出甲。",
  "",
  "**文件责任**：`src/a.ts`。",
  "",
  "- [ ] 甲做出来",
  "",
  "**交付**：W-1 验收记录。",
  "",
  "**完成证据**：W-1 验收记录。",
  "",
].join("\n");
write(path.join(root, ".工作台", "design.md"), DESIGN);
write(path.join(root, ".工作台", "plan.md"), PLAN);
write(path.join(root, "src", "a.ts"), "export const a = 1;\n");
write(path.join(devRoot, "src", "d.ts"), "export const d = 1;\n");
write(path.join(candRoot, "src", "b.ts"), "export const b = 2;\n");
write(path.join(candRoot, "README.md"), "# cand\n");

const nowStamp = "2026-10-09T00:00:00+08:00";
write(
  path.join(dataDir, "registry.json"),
  JSON.stringify({
    version: 1,
    projects: [{ id: P, name: "V09-63b 夹具", path: root, kind: "backend", registered_at: nowStamp, last_opened_at: nowStamp }],
  }),
);
process.env.TATAI_HOME = dataDir;

const service = new WorkService({ dataDir });
const workDir = projectWorkDir(P, dataDir);
const eventCount = (): number => loadEvents(workDir).events.length;
const CHANGE = "change-v0963b";
const COORD = "v0963b-coordinator";
const EXEC = "v0963b-executor";

const submitter = { submit: (c: unknown) => service.submit(c), read: () => readWorkspaces(workDir) };

// ── 定义导入 + 基线 ──
{
  const imported = importPlanChecked(PLAN, workDir, { plan_revision: sha256(PLAN) });
  submitDefinitionImports(service, { project_id: P, change_id: CHANGE, actor_id: "setup", role: "coordinator", definitions: imported.definitions });
  const baseline = activateBaseline(P, { approved_by: "user", approval_basis: "V09-63b 隔离夹具审定（不代表真实用户 Gate）", approval_kind: "user_confirmed" }, dataDir);
  ok(baseline.baseline.baseline_id !== "" && readTaskStates(workDir).states["W-1"] !== undefined, `⓪ 夹具就绪（定义导入 + 基线激活）`);
}

// ═════════ 组 1：坏指针不静默回退 / select_dev / retire 合法性 ═════════
section("① 坏开发指针**不**静默回落 :main（读侧守卫）");
{
  const reg = registerWorkspace(submitter, {
    project_id: P, workspace_id: "ws-dev-1", change_id: CHANGE, actor_id: COORD, role: "coordinator",
    kind: "dev", purpose: "隔离开发区", root: devRoot, source_kind: "directory",
  });
  ok(reg.ok === true, `① 登记 dev 工作区 ws-dev-1（${reg.ok ? "ok" : reg.code}）`);
  const sel = selectDevWorkspace(submitter, { project_id: P, workspace_id: "ws-dev-1", change_id: CHANGE, actor_id: COORD, role: "coordinator", expected_revision: 0 });
  ok(sel.ok === true, `① select_dev 合法 preparing dev 成功（${sel.ok ? "ok" : `${sel.code}: ${sel.message}`}）`);

  const proj: WorkspaceProjection = readWorkspaces(workDir);
  const ptr = proj.pointer!;
  // (a) 指针指向不存在的工作区 → blocked、root=null，**不回退 :main**
  const missing = resolveDevFromProjection(P, root, proj, { ...ptr, current_dev_workspace_id: "ws-not-there" });
  ok(missing.source === "blocked" && missing.root === null, `① 指针指向不存在的工作区 → blocked、root=null（实际 ${missing.source}/${missing.root}）`);
  // (b) 指针指向已回收工作区 → blocked
  const reg2 = registerWorkspace(submitter, { project_id: P, workspace_id: "ws-dev-2", change_id: CHANGE, actor_id: COORD, role: "coordinator", kind: "dev", purpose: "将被回收", root: path.join(tmpBase, "dev2"), source_kind: "directory" });
  fs.mkdirSync(path.join(tmpBase, "dev2"), { recursive: true });
  ok(reg2.ok === true || (reg2 as { code?: string }).code === undefined, `① 登记 ws-dev-2`);
  const rec2 = readWorkspaces(workDir).workspaces["ws-dev-2"];
  const rt2 = retireWorkspace(submitter, { project_id: P, workspace_id: "ws-dev-2", change_id: CHANGE, actor_id: COORD, role: "coordinator", expected_revision: rec2.revision, reason: "夹具回收", reachability: "目录在场" });
  ok(rt2.ok === true, `① 回收非活指针工作区（目录在场）成功（${rt2.ok ? "ok" : rt2.code}）`);
  const proj2 = readWorkspaces(workDir);
  const retiredPtr = resolveDevFromProjection(P, root, proj2, { ...proj2.pointer!, current_dev_workspace_id: "ws-dev-2" });
  ok(retiredPtr.source === "blocked" && retiredPtr.root === null, `① 指针指向已回收工作区 → blocked、root=null（实际 ${retiredPtr.source}）`);
  // (c) 完全无登记指针 → legacy 默认 :main
  const noPtr = resolveDevFromProjection(P, root, proj2, { ...proj2.pointer!, current_dev_workspace_id: null });
  ok(noPtr.source === "main" && noPtr.root === path.resolve(root) && noPtr.workspace_id === mainWorkspaceId(P), `① 无登记指针 → legacy 默认 :main（唯一允许的默认）`);
}

section("① select_dev 必须合法 preparing dev；retire 活指针拒绝");
{
  // select_dev 到冻结候选 → WORKSPACE_MISMATCH（先造一个冻结候选）
  const regC = registerWorkspace(submitter, { project_id: P, workspace_id: "cand-x", change_id: CHANGE, actor_id: COORD, role: "coordinator", kind: "candidate", purpose: "候选", root: candRoot, source_kind: "directory" });
  ok(regC.ok === true, `① 登记候选 cand-x`);
  const recC = readWorkspaces(workDir).workspaces["cand-x"];
  const fr = freezeWorkspace(submitter, { project_id: P, workspace_id: "cand-x", change_id: CHANGE, actor_id: COORD, role: "coordinator", expected_revision: recC.revision, included_uncommitted: false, declared_paths: [] });
  ok(fr.ok === true, `① 冻结候选 cand-x（${fr.ok ? "ok" : `${fr.code}: ${fr.message}`}）`);
  const selFrozen = selectDevWorkspace(submitter, { project_id: P, workspace_id: "cand-x", change_id: CHANGE, actor_id: COORD, role: "coordinator", expected_revision: readWorkspaces(workDir).pointer!.revision });
  ok(selFrozen.ok === false && selFrozen.code === "WORKSPACE_MISMATCH", `① select_dev 冻结候选拒 WORKSPACE_MISMATCH（${selFrozen.ok ? "（意外放行）" : selFrozen.code}）`);

  // retire 当前活指针 → RETIRE_PRECONDITION_UNMET
  const recDev = readWorkspaces(workDir).workspaces["ws-dev-1"];
  const rtActive = retireWorkspace(submitter, { project_id: P, workspace_id: "ws-dev-1", change_id: CHANGE, actor_id: COORD, role: "coordinator", expected_revision: recDev.revision, reason: "想回收", reachability: "在场" });
  ok(rtActive.ok === false && rtActive.code === "RETIRE_PRECONDITION_UNMET", `① 回收当前开发指针拒 RETIRE_PRECONDITION_UNMET（${rtActive.ok ? "（意外放行）" : rtActive.code}）`);

  // 显式切走（select_dev 回 :main）后再回收 → 允许（目录在场）
  const back = selectDevWorkspace(submitter, { project_id: P, workspace_id: mainWorkspaceId(P), change_id: CHANGE, actor_id: COORD, role: "coordinator", expected_revision: readWorkspaces(workDir).pointer!.revision });
  ok(back.ok === true, `① select_dev 切回 :main（${back.ok ? "ok" : back.code}）`);
  const recDev2 = readWorkspaces(workDir).workspaces["ws-dev-1"];
  const rtOk = retireWorkspace(submitter, { project_id: P, workspace_id: "ws-dev-1", change_id: CHANGE, actor_id: COORD, role: "coordinator", expected_revision: recDev2.revision, reason: "已切走", reachability: "目录在场" });
  ok(rtOk.ok === true, `① 切走后回收 ws-dev-1（目录在场）成功（${rtOk.ok ? "ok" : rtOk.code}）`);

  // 源目录不在且无提交 → RETIRE_PRECONDITION_UNMET（宿主实测不可还原，不认 reachability 字符串）
  fs.rmSync(goneRoot, { recursive: true, force: true });
  const regG = registerWorkspace(submitter, { project_id: P, workspace_id: "ws-gone", change_id: CHANGE, actor_id: COORD, role: "coordinator", kind: "candidate", purpose: "源不在", root: goneRoot, source_kind: "directory" });
  ok(regG.ok === true, `① 登记源不在的 ws-gone`);
  const recG = readWorkspaces(workDir).workspaces["ws-gone"];
  const rtGone = retireWorkspace(submitter, { project_id: P, workspace_id: "ws-gone", change_id: CHANGE, actor_id: COORD, role: "coordinator", expected_revision: recG.revision, reason: "回收", reachability: "声称可达（不作证明）" });
  ok(rtGone.ok === false && rtGone.code === "RETIRE_PRECONDITION_UNMET", `① 源不可还原的回收拒 RETIRE_PRECONDITION_UNMET（不认 reachability 字符串）（${rtGone.ok ? "（意外放行）" : rtGone.code}）`);
}

section("① executor 登记必须以**真实认领**为凭据（不只 task_id 字段）");
{
  const noClaim = registerWorkspace(submitter, { project_id: P, workspace_id: "ws-exec-bad", change_id: CHANGE, actor_id: EXEC, role: "executor", kind: "dev", purpose: "无认领", root: path.join(tmpBase, "exec-bad"), source_kind: "directory", task_ids: ["W-1"] });
  ok(noClaim.ok === false && noClaim.code === "WORKSPACE_ROLE_FORBIDDEN", `① 未认领的 executor 登记拒 WORKSPACE_ROLE_FORBIDDEN（${noClaim.ok ? "（意外放行）" : noClaim.code}）`);

  const claim = await claimTask({ project_id: P, task_id: "W-1", role: "executor", owner_id: EXEC, change_id: CHANGE }, service, dataDir);
  ok(claim.ok === true, `① 先真实认领 W-1（${claim.ok ? "ok" : claim.code}）`);
  const withClaim = registerWorkspace(submitter, { project_id: P, workspace_id: "ws-exec-ok", change_id: CHANGE, actor_id: EXEC, role: "executor", kind: "dev", purpose: "有认领", root: devRoot, source_kind: "directory", task_ids: ["W-1"] });
  ok(withClaim.ok === true, `① 持有真实认领的 executor 登记成功（${withClaim.ok ? "ok" : `${withClaim.code}: ${withClaim.message}`}）`);
}

// ═════════ 组 2：冻结宿主实测绑定与保全 ═════════
section("② 冻结须宿主现读 DESIGN/PLAN 绑定 + 内容寻址保全；客户端伪造哈希拒");
{
  const reg = registerWorkspace(submitter, { project_id: P, workspace_id: "cand-f", change_id: CHANGE, actor_id: COORD, role: "coordinator", kind: "candidate", purpose: "冻结绑定", root: candRoot, source_kind: "directory" });
  ok(reg.ok === true, `② 登记 cand-f`);

  // 客户端自报伪造 DESIGN 哈希 → VERSION_CONFLICT（宿主现读不符）
  const recBad = readWorkspaces(workDir).workspaces["cand-f"];
  const bad = freezeWorkspace(submitter, { project_id: P, workspace_id: "cand-f", change_id: CHANGE, actor_id: COORD, role: "coordinator", expected_revision: recBad.revision, included_uncommitted: false, declared_paths: [], version_binding: { design_sha256: "a".repeat(64) } });
  ok(bad.ok === false && bad.code === "VERSION_CONFLICT", `② 客户端伪造 DESIGN 哈希拒 VERSION_CONFLICT（${bad.ok ? "（意外放行）" : bad.code}）`);

  // 正确冻结
  const recOk = readWorkspaces(workDir).workspaces["cand-f"];
  const good = freezeWorkspace(submitter, { project_id: P, workspace_id: "cand-f", change_id: CHANGE, actor_id: COORD, role: "coordinator", expected_revision: recOk.revision, included_uncommitted: false, declared_paths: [], version_binding: { design_sha256: sha256(DESIGN) } });
  ok(good.ok === true, `② 冻结成功（客户端 DESIGN 哈希与现读一致）（${good.ok ? "ok" : `${good.code}: ${good.message}`}）`);

  const frozen = readWorkspaces(workDir).workspaces["cand-f"];
  ok(frozen.freeze?.version_binding.design_sha256 === sha256(DESIGN) && frozen.freeze?.version_binding.plan_sha256 === sha256(PLAN), `② 冻结记录绑定宿主现读 DESIGN/PLAN 哈希`);
  ok(frozen.freeze?.version_binding.baseline_id !== null, `② 冻结记录绑定真实 active baseline id（${frozen.freeze?.version_binding.baseline_id}）`);
  ok((frozen.freeze?.index_evidence_id ?? "").length === 64 && (frozen.freeze?.recovery_evidence_id ?? "").length === 64, `② 完整索引/恢复材料经 putEvidence 保全（index_evidence_id / recovery_evidence_id 64hex）`);
  const evFile = path.join(workDir, "evidence", `${frozen.freeze?.recovery_evidence_id}.json`);
  ok(fs.existsSync(evFile), `② 恢复材料证据文件真实落盘（${frozen.freeze?.recovery_evidence_id?.slice(0, 12)}…）`);

  // 事件 payload ≤64KiB 且不含完整索引 entries
  const frozenEvent = loadEvents(workDir).events.filter((e) => e.type === "workspace.frozen" && e.entity_id === "workspace:cand-f").at(-1)!;
  const payloadJson = JSON.stringify(frozenEvent.payload);
  ok(Buffer.byteLength(payloadJson, "utf8") <= 64 * 1024, `② 事件 payload ≤64KiB（实测 ${Buffer.byteLength(payloadJson, "utf8")} 字节）`);
  ok(!payloadJson.includes('"entries"'), `② 事件 payload 不塞完整候选索引（无 entries 数组）`);
  ok(frozenEvent.payload.index_evidence_id !== undefined && frozenEvent.payload.version_binding !== undefined, `② 事件 payload 带内容寻址引用与配套版本绑定`);
}

// ═════════ 组 4：工作区上下文默认可见 + 认领锁内校验 ═════════
section("④ 入口/工作包默认带目标工作区；认领直连写口校验");
{
  const entry = evaluateProjectEntry({ project_id: P, role: "executor", client_capabilities: ["continuable"] }, { dataDir });
  ok(JSON.stringify(Object.keys(entry)) === JSON.stringify([...PROJECT_ENTRY_RESULT_FIELDS]), `④ 默认入口仍是恰好九顶层字段`);
  const cm = entry.context_manifest as unknown as { workspace?: { workspace_id: string; root: string | null; source: string; anchor_root?: string } };
  ok(cm.workspace !== undefined && cm.workspace.workspace_id === mainWorkspaceId(P), `④ 默认 context_manifest.workspace 默认可见（当前 ${cm.workspace?.workspace_id}）`);

  // 指向 dev 后，入口默认读 dev，且中央账本仍在 anchor 下
  const devEntryRoot = path.join(tmpBase, "dev-entry");
  fs.mkdirSync(path.join(devEntryRoot, "src"), { recursive: true });
  write(path.join(devEntryRoot, "src", "e.ts"), "export const e = 1;\n");
  const reg = registerWorkspace(submitter, { project_id: P, workspace_id: "ws-dev-entry", change_id: CHANGE, actor_id: COORD, role: "coordinator", kind: "dev", purpose: "入口开发区", root: devEntryRoot, source_kind: "directory" });
  ok(reg.ok === true, `④ 登记 ws-dev-entry`);
  const sel = selectDevWorkspace(submitter, { project_id: P, workspace_id: "ws-dev-entry", change_id: CHANGE, actor_id: COORD, role: "coordinator", expected_revision: readWorkspaces(workDir).pointer!.revision });
  ok(sel.ok === true, `④ select_dev 指向 ws-dev-entry（${sel.ok ? "ok" : `${sel.code}: ${sel.message}`}）`);
  const entry2 = evaluateProjectEntry({ project_id: P, role: "executor", client_capabilities: ["continuable"] }, { dataDir });
  const cm2 = entry2.context_manifest as unknown as { workspace?: { workspace_id: string; root: string | null } };
  ok(cm2.workspace?.workspace_id === "ws-dev-entry" && cm2.workspace?.root === path.resolve(devEntryRoot), `④ 默认入口实际去 dev（root=${cm2.workspace?.root}）`);
  const wpDir = projectWorkDir(P, dataDir);
  ok(path.resolve(wpDir).startsWith(path.resolve(root) + path.sep), `④ 中央账本/证据仍在 registered anchor 下（${wpDir}）`);

  // 工作包默认带 workspace
  const wpEntry = evaluateProjectEntry({ project_id: P, role: "executor", client_capabilities: ["continuable"] }, { dataDir, work_package: true });
  const wp = wpEntry.work_package as unknown as { checks?: unknown[]; workspace?: { workspace_id: string } };
  ok(Array.isArray(wp.checks) && wp.workspace?.workspace_id === "ws-dev-entry", `④ 工作包默认带目标工作区（${wp.workspace?.workspace_id}）`);

  // 直连写口手写 task.claimed 带未知 workspace_id → 锁内拒 WORKSPACE_UNKNOWN
  // （用当前实体版本，避免先在版本校验处被拒，证明确实走到了工作区校验）
  const wSeen = loadEvents(workDir).events.filter((e) => e.entity_id === "task:W-1");
  const wRev = wSeen.length === 0 ? 0 : Math.max(...wSeen.map((e) => e.entity_revision));
  let directRejected = false;
  try {
    service.submit({
      schema_version: 2, project_id: P, change_id: CHANGE, entity_id: "task:W-1", expected_revision: wRev,
      type: "task.claimed", actor_id: EXEC, role: "executor", idempotency_key: "direct-bad-ws",
      payload: { run_id: "r1", attempt_id: "a1", owner_id: EXEC, claim_token: "t1", lease_expires_at: "2099-01-01T00:00:00.000Z", workspace_id: "ws-nope-direct" },
    });
  } catch (e) {
    directRejected = isWorkError(e) && e.detail?.reason === "WORKSPACE_UNKNOWN";
  }
  ok(directRejected, `④ 直连写口 task.claimed 带未知 workspace_id 拒 WORKSPACE_UNKNOWN（不只工具包装）`);
}

console.log(`\n[verify] V09-63b 结果：PASS ${pass} / FAIL ${fail}`);
if (fail > 0) process.exitCode = 1;
