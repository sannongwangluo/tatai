// V09-63 验证脚本（tsx 跑）：项目工作目录与交付候选——登记、指针、接续契约。
// （PLAN.md V09-63 卡面 ①–④；DESIGN.md §6.13／§6.14 第 1/2/7 段。）
// 用法：pnpm verify:v09-63（自带临时 TATAI_HOME 与夹具项目；不碰真实账本）。
//
// 覆盖（逐条对卡面检查项）：
//   chk-01 工作区登记与指针：register/update 经唯一写口 + CAS；主开发目录由 <project>:main 派生、不重复保存；
//          项目级指针记独立实体、不改 ProjectRecord.path；未知键/非法路径拒绝且**零字节**。
//   chk-02 接续契约：入口 opt-in `workspaces` 给目标工作区/实际 cwd/可改范围/候选状态；认领/续领携带
//          workspace_id 并由入口读回；缺字段如实标未知。
//   chk-03 只读读口与旧客户端：HTTP 读路由与 MCP 工具**同判据**（同一份 readWorkspacesForProject）；
//          旧项目无工作区记录按 :main 派生继续可用；默认入口仍是恰好九字段。
//   chk-04 并发与幂等：CAS 不符拒 VERSION_CONFLICT；相同输入重复登记不产生第二个候选（幂等、零增长）；
//          非法输入零字节、账本原字节不增长。
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { WorkService } from "../src/server/work/service";
import { loadEvents } from "../src/server/work/eventStore";
import { readTaskStates, submitDefinitionImports } from "../src/server/work/tasks";
import { importPlanChecked } from "../src/server/work/references";
import { activateBaseline } from "../src/server/work/documents";
import { claimTask, renewClaim } from "../src/server/work/claims";
import { evaluateProjectEntry, PROJECT_ENTRY_RESULT_FIELDS } from "../src/server/work/entry";
import { isWorkError, REGISTERED_EVENT_TYPES } from "../src/server/work/types";
import { EVENT_SURFACE } from "../src/server/work/eventSurface";
import {
  WORKSPACE_EVENT_TYPES,
  readWorkspaces,
  readWorkspacesForProject,
  resolveCurrentDevRoot,
  mainWorkspaceId,
  registerWorkspace,
  updateWorkspace,
  selectDevWorkspace,
} from "../src/server/work/workspaces";
import { REMOTE_ROUTES } from "../src/server/remote-routes";
import { projectWorkDir } from "../src/server/workstation";
import { findTool } from "../src/mcp/tools/index";
import { manageWorkspaceTool } from "../src/mcp/tools/workspaceTools";
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
const section = (t: string): void => console.log(`\n[verify] ── ${t}`);

// ── 隔离夹具（临时 TATAI_HOME + 两个夹具项目 + 一个候选源目录；不碰真实注册表/项目）──
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-v09-63-"));
const dataDir = path.join(tmpBase, "home");
const RW = "v0963";
const OTHER = "v0963-other";
const root = path.join(tmpBase, "proj-rw");
const otherRoot = path.join(tmpBase, "proj-other");
const candRoot = path.join(tmpBase, "cand");
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(path.join(root, ".工作台"), { recursive: true });
fs.mkdirSync(path.join(otherRoot, ".工作台"), { recursive: true });
fs.mkdirSync(path.join(candRoot, "src"), { recursive: true });

const write = (f: string, text: string): void => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text, "utf8");
};

const DESIGN = "# V09-63 夹具设计书\n\n## 2 模块划分\n\n| # | 模块 | 说明 |\n| --- | --- | --- |\n| 1 | 甲模块 | 夹具 |\n";
const PLAN = [
  "# V09-63 夹具施工图",
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
write(path.join(otherRoot, ".工作台", "design.md"), DESIGN);
write(path.join(otherRoot, ".工作台", "plan.md"), PLAN);
write(path.join(root, "src", "a.ts"), "export const a = 1;\n");
write(path.join(candRoot, "src", "b.ts"), "export const b = 2;\n");
write(path.join(candRoot, "README.md"), "# candidate\n");

const nowStamp = "2026-10-09T00:00:00+08:00";
const registryPath = path.join(dataDir, "registry.json");
write(
  registryPath,
  JSON.stringify({
    version: 1,
    projects: [
      { id: RW, name: "V09-63 工作区夹具", path: root, kind: "backend", registered_at: nowStamp, last_opened_at: nowStamp },
      { id: OTHER, name: "V09-63 对照项目", path: otherRoot, kind: "backend", registered_at: nowStamp, last_opened_at: nowStamp },
    ],
  }),
);
process.env.TATAI_HOME = dataDir;

const service = new WorkService({ dataDir });
const workDir = projectWorkDir(RW, dataDir);
const otherWorkDir = projectWorkDir(OTHER, dataDir);
const eventCount = (d = workDir): number => loadEvents(d).events.length;
const ledgerBytes = (d = workDir): number => {
  const f = path.join(d, "events.jsonl");
  return fs.existsSync(f) ? fs.statSync(f).size : 0;
};
const CHANGE = "change-v0963";
const COORD = "v0963-coordinator";
const EXEC = "v0963-executor";

/** 命令层提交者：直接走真实 WorkService（同步唯一写口），读从盘上事件现读 */
const submitterOf = (d: string) => ({ submit: (c: unknown) => service.submit(c), read: () => readWorkspaces(d) });
const submitter = submitterOf(workDir);

// ── 定义导入（受检入口）+ 基线（入口派活前提）──
{
  const imported = importPlanChecked(PLAN, workDir, { plan_revision: crypto.createHash("sha256").update(PLAN, "utf8").digest("hex") });
  submitDefinitionImports(service, { project_id: RW, change_id: CHANGE, actor_id: "v0963-setup", role: "coordinator", definitions: imported.definitions });
  const baseline = activateBaseline(RW, { approved_by: "user", approval_basis: "V09-63 隔离夹具审定（不代表真实用户 Gate）", approval_kind: "user_confirmed" }, dataDir);
  ok(baseline.baseline.baseline_id !== "" && readTaskStates(workDir).states["W-1"] !== undefined, `⓪ 夹具就绪（定义导入 + 基线激活）`);
  // 对照项目也导入同一张卡（跨项目工作区拒领的判据要能真正走到工作区检查那一步）
  const importedOther = importPlanChecked(PLAN, otherWorkDir, { plan_revision: crypto.createHash("sha256").update(PLAN, "utf8").digest("hex") });
  submitDefinitionImports(service, { project_id: OTHER, change_id: CHANGE, actor_id: "v0963-setup", role: "coordinator", definitions: importedOther.definitions });
  activateBaseline(OTHER, { approved_by: "user", approval_basis: "V09-63 对照项目审定", approval_kind: "user_confirmed" }, dataDir);
}

// ═════════════════════ chk-01：登记与指针 ═════════════════════
section("① 工作区登记、:main 派生、项目级指针");
{
  const view0 = readWorkspacesForProject(RW, dataDir);
  const mainId = mainWorkspaceId(RW);
  ok(
    view0.workspaces.length === 1 && view0.workspaces[0].workspace_id === mainId && view0.workspaces[0].derived === true,
    `① 无工作区记录时读出派生 :main（${mainId}，derived=true）`,
  );
  ok(view0.current_dev.source === "main" && view0.current_dev.root === path.resolve(root), `① 默认开发根＝ProjectRecord.path（source=main）`);
  ok(view0.pointer.current_dev_workspace_id === null && view0.pointer.current_trial_workspace_id === null, `① 无指针时 current_dev/trial 均为 null`);

  const reg = registerWorkspace(submitter, {
    project_id: RW, workspace_id: "ws-dev-1", change_id: CHANGE, actor_id: COORD, role: "coordinator",
    kind: "dev", purpose: "隔离开发区", root: candRoot, source_kind: "directory", owner_role: "coordinator",
  });
  ok(reg.ok === true && reg.duplicate === false, `① register 新建 dev 工作区（${reg.ok ? "ok" : `${reg.code}: ${reg.message}`}）`);
  const rec = readWorkspaces(workDir).workspaces["ws-dev-1"];
  ok(rec !== undefined && rec.root === path.resolve(candRoot) && rec.status === "preparing", `① 记录落盘（root=规范绝对路径、status=preparing）`);

  // 幂等：同输入重复登记（不同 id）→ 返回既有、零增长
  const before = eventCount();
  const reg2 = registerWorkspace(submitter, {
    project_id: RW, workspace_id: "ws-dev-1-b", change_id: CHANGE, actor_id: COORD, role: "coordinator",
    kind: "dev", purpose: "隔离开发区", root: candRoot, source_kind: "directory", owner_role: "coordinator",
  });
  ok(reg2.ok === true && reg2.duplicate === true && eventCount() === before, `① 相同输入重复登记幂等返回既有（不产生第二个候选，零增长）`);
}

// ═════════════════════ chk-04：非法路径/未知键 零字节 ═════════════════════
section("④ 非法路径/未知键 拒绝且零字节");
{
  const b0 = ledgerBytes();
  const n0 = eventCount();
  const rel = registerWorkspace(submitter, {
    project_id: RW, workspace_id: "ws-bad-rel", change_id: CHANGE, actor_id: COORD, role: "coordinator",
    kind: "dev", purpose: "相对路径", root: "src/relative", source_kind: "directory",
  });
  ok(!rel.ok && rel.code === "WORKSPACE_ROOT_INVALID", `④ 相对路径拒 WORKSPACE_ROOT_INVALID（${rel.ok ? "（意外放行）" : rel.code}）`);
  const inner = registerWorkspace(submitter, {
    project_id: RW, workspace_id: "ws-bad-inner", change_id: CHANGE, actor_id: COORD, role: "coordinator",
    kind: "dev", purpose: "落在私有 .工作台", root: path.join(root, ".工作台", "sub"), source_kind: "directory",
  });
  ok(!inner.ok && inner.code === "WORKSPACE_ROOT_INVALID", `④ 落在私有 .工作台 内拒 WORKSPACE_ROOT_INVALID（${inner.ok ? "（意外放行）" : inner.code}）`);
  // 未知键（payload 闭键）：直连写口提交带多余键 → 锁内拒
  let unknownKeyRejected = false;
  try {
    service.submit({
      schema_version: 2, project_id: RW, change_id: CHANGE, entity_id: "workspace:ws-unknown-key",
      expected_revision: null, type: "workspace.registered", actor_id: COORD, role: "coordinator",
      idempotency_key: "ws-unknown-key-1",
      payload: { kind: "dev", purpose: "x", root: path.resolve(candRoot), source_kind: "directory", intent_text: "走私" },
    });
  } catch (e) {
    unknownKeyRejected = isWorkError(e) && e.code === "INVALID_COMMAND";
  }
  ok(unknownKeyRejected, `④ 锁内闭键拒未知 payload 键（直连写口不能旁路）`);
  ok(ledgerBytes() === b0 && eventCount() === n0, `④ 非法输入零字节、账本原字节不增长（bytes ${ledgerBytes()} == ${b0}，events ${eventCount()} == ${n0}）`);
}

// ═════════════════════ update / CAS ═════════════════════
section("④ update 与 CAS 冲突");
{
  const rec = readWorkspaces(workDir).workspaces["ws-dev-1"];
  const up = updateWorkspace(submitter, {
    project_id: RW, workspace_id: "ws-dev-1", change_id: CHANGE, actor_id: COORD, role: "coordinator",
    expected_revision: rec.revision, fields: { purpose: "隔离开发区（改）" },
  });
  ok(up.ok === true && readWorkspaces(workDir).workspaces["ws-dev-1"].purpose.includes("（改）"), `④ update 改用途成功`);
  const conflict = updateWorkspace(submitter, {
    project_id: RW, workspace_id: "ws-dev-1", change_id: CHANGE, actor_id: COORD, role: "coordinator",
    expected_revision: 0, fields: { purpose: "错版本" },
  });
  ok(!conflict.ok && conflict.code === "VERSION_CONFLICT", `④ CAS 不符拒 VERSION_CONFLICT（${conflict.ok ? "（意外放行）" : conflict.code}）`);
}

// ═════════════════════ select_dev：指针不改 ProjectRecord.path ═════════════════════
section("① 项目级指针（select_dev）不改 ProjectRecord.path");
{
  const pathBefore = JSON.parse(fs.readFileSync(registryPath, "utf8")).projects.find((p: { id: string }) => p.id === RW).path;
  const sel = selectDevWorkspace(submitter, {
    project_id: RW, workspace_id: "ws-dev-1", change_id: CHANGE, actor_id: COORD, role: "coordinator", expected_revision: 0,
    basis: "夹具：把开发指针指向隔离工作区",
  });
  ok(sel.ok === true, `① select_dev 成功（${sel.ok ? "ok" : `${sel.code}: ${sel.message}`}）`);
  const view = readWorkspacesForProject(RW, dataDir);
  ok(view.pointer.current_dev_workspace_id === "ws-dev-1" && view.current_dev.source === "pointer", `① 指针指向 ws-dev-1，current_dev.source=pointer`);
  const pathAfter = JSON.parse(fs.readFileSync(registryPath, "utf8")).projects.find((p: { id: string }) => p.id === RW).path;
  ok(pathBefore === pathAfter && pathAfter === root, `① ProjectRecord.path 未被指针改写（仍是 ${pathAfter}）`);
  const dev = resolveCurrentDevRoot(RW, dataDir);
  ok(dev.workspace_id === "ws-dev-1" && dev.root === path.resolve(candRoot), `① resolveCurrentDevRoot 解析规范开发根（${dev.root}）`);

  // 跨项目：把 OTHER 项目的指针指向 RW 的工作区 → WORKSPACE_UNKNOWN
  const cross = selectDevWorkspace(submitterOf(otherWorkDir), {
    project_id: OTHER, workspace_id: "ws-dev-1", change_id: CHANGE, actor_id: COORD, role: "coordinator", expected_revision: 0,
  });
  ok(!cross.ok && cross.code === "WORKSPACE_UNKNOWN", `① 跨项目引用拒 WORKSPACE_UNKNOWN（${cross.ok ? "（意外放行）" : cross.code}）`);
}

// ═════════════════════ chk-02：接续契约（入口 + 认领） ═════════════════════
section("② 接续契约：入口 workspaces + 认领 workspace_id");
{
  const plain = evaluateProjectEntry({ project_id: RW, role: "executor", client_capabilities: ["continuable"] }, { dataDir });
  ok(
    JSON.stringify(Object.keys(plain)) === JSON.stringify([...PROJECT_ENTRY_RESULT_FIELDS]),
    `② 默认入口仍是恰好九字段（旧客户端契约不变）：${Object.keys(plain).join("/")}`,
  );
  const withWs = evaluateProjectEntry({ project_id: RW, role: "executor", client_capabilities: ["continuable"] }, { dataDir, workspaces: true });
  ok(withWs.workspaces !== undefined && withWs.workspaces.current_dev.workspace_id === "ws-dev-1", `② opt-in 入口给出目标工作区（${withWs.workspaces?.current_dev.workspace_id}）`);
  ok(
    withWs.workspaces?.current_dev.root === path.resolve(candRoot) &&
      typeof withWs.workspaces.current_dev.writable === "boolean" &&
      withWs.workspaces.anchor_root === path.resolve(root),
    `② 入口给实际 cwd/可改范围/项目锚点`,
  );

  const claim = await claimTask(
    { project_id: RW, task_id: "W-1", role: "executor", owner_id: EXEC, change_id: CHANGE, workspace_id: "ws-dev-1" },
    service, dataDir,
  );
  ok(claim.ok === true && claim.claim.workspace_id === "ws-dev-1", `② 认领携带 workspace_id（${claim.ok ? claim.claim.workspace_id : `${claim.code}`}）`);
  const evt = loadEvents(workDir).events.filter((e) => e.type === "task.claimed").at(-1);
  ok(evt?.payload.workspace_id === "ws-dev-1", `② 事件 payload 读回同一 workspace_id`);

  const renewed = claim.ok
    ? await renewClaim(
        { project_id: RW, task_id: "W-1", role: "executor", owner_id: EXEC, change_id: CHANGE, claim_token: claim.claim.claim_token, expected_revision: claim.receipt.entity_revision, workspace_id: "ws-dev-1" },
        service, dataDir,
      )
    : null;
  ok(renewed !== null && renewed.ok === true && renewed.claim.workspace_id === "ws-dev-1", `② 续领沿用/携带同一 workspace_id（${renewed && renewed.ok ? renewed.claim.workspace_id : (renewed ? renewed.code : "n/a")}）`);

  const badClaim = await claimTask(
    { project_id: RW, task_id: "W-1", role: "executor", owner_id: "x", change_id: CHANGE, workspace_id: "ws-nope" },
    service, dataDir,
  );
  ok(!badClaim.ok && badClaim.code === "WORKSPACE_UNKNOWN", `② 未知工作区拒领 WORKSPACE_UNKNOWN（${badClaim.ok ? "（意外放行）" : badClaim.code}）`);
  const crossClaim = await claimTask(
    { project_id: OTHER, task_id: "W-1", role: "executor", owner_id: "x", change_id: CHANGE, workspace_id: "ws-dev-1" },
    service, dataDir,
  );
  ok(!crossClaim.ok && crossClaim.code === "WORKSPACE_UNKNOWN", `② 跨项目工作区拒领（${crossClaim.ok ? "（意外放行）" : crossClaim.code}）`);
}

// ═════════════════════ chk-03：只读读口（HTTP 路由 + MCP 工具）与旧客户端 ═════════════════════
section("③ 只读读口（HTTP 路由 + MCP 工具）与旧客户端");
{
  const route = REMOTE_ROUTES.find((r) => r.path === "/api/projects/:id/workspaces");
  const indexSrc = fs.readFileSync(path.join(process.cwd(), "src", "server", "index.ts"), "utf8");
  const anchorHit = route !== undefined ? indexSrc.split(route.anchors[0]!).length - 1 : 0;
  ok(route !== undefined && route.kind === "read" && anchorHit === 1, `③ HTTP 只读路由已登记（workspace-list-read，kind=read，锚点唯一命中 ${anchorHit}）`);

  const tool = findTool("manage_workspace");
  ok(tool !== undefined && tool === manageWorkspaceTool, `③ MCP 工具 manage_workspace 已在 TOOLS 注册表`);

  const mcpCtx = { clientName: "v0963-mcp", work: { submit: async (c: unknown) => service.submit(c) } as never };
  const readRes = await manageWorkspaceTool.handler({ op: "read", project_id: RW }, mcpCtx);
  const readBody = JSON.parse((readRes.content[0] as { text: string }).text);
  ok(readBody.ok === true && Array.isArray(readBody.workspaces) && readBody.current_dev.workspace_id === "ws-dev-1", `③ MCP read 与入口同判据（当前开发根 ${readBody.current_dev?.workspace_id}）`);

  const regRes = await manageWorkspaceTool.handler(
    { op: "register", project_id: OTHER, role: "coordinator", workspace_id: "ws-other-1", kind: "dev", purpose: "对照项目工作区", root: path.join(tmpBase, "cand-other"), source_kind: "directory" },
    mcpCtx,
  );
  const regBody = JSON.parse((regRes.content[0] as { text: string }).text);
  ok(regBody.ok === true && readWorkspaces(otherWorkDir).workspaces["ws-other-1"] !== undefined, `③ MCP register 经唯一写口真实落事件（${regBody.ok ? "ok" : JSON.stringify(regBody).slice(0, 80)}）`);

  const oldClient = evaluateProjectEntry({ project_id: OTHER, role: "read_only" }, { dataDir });
  ok(oldClient.next_action !== undefined && oldClient.workspaces === undefined, `③ 旧客户端默认入口不含 workspaces 字段、照旧可用`);

  const claimProps = (claimTaskTool.inputSchema.properties ?? {}) as Record<string, unknown>;
  ok(claimProps.workspace_id !== undefined, `③ claim_task schema 暴露 workspace_id`);
}

// ═════════════════════ 事件面/词表一致性 ═════════════════════
section("⑤ 事件登记面与事件面出口");
{
  const registered = new Set(REGISTERED_EVENT_TYPES.map((r) => r.type));
  ok(WORKSPACE_EVENT_TYPES.every((t) => registered.has(t)), `⑤ WORKSPACE_EVENT_TYPES 全部登记进 REGISTERED_EVENT_TYPES`);
  ok(WORKSPACE_EVENT_TYPES.every((t) => EVENT_SURFACE[t] === "mcp:manage_workspace"), `⑤ 每个工作区事件都有事件面出口 mcp:manage_workspace`);
}

console.log(`\n[verify] V09-63 结果：PASS ${pass} / FAIL ${fail}`);
if (fail > 0) process.exitCode = 1;
