// V09-66b 验证脚本（tsx 跑）：本地 Git 自动收尾的**宿主接线**——事实源真实派生、请求闭键（不得自带
// grant/通过布尔/root）、未授权/未接探针时 fail-closed 且**零 Git 副作用**、工具经唯一宿主转发。
// （DESIGN.md §6.13 第 7 段／§6.14 第 9 段；PLAN V09-66。）用法：npx tsx scripts/verify-v09-66b.ts
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { WorkService } from "../src/server/work/service";
import { readWorkspaces, registerWorkspace } from "../src/server/work/workspaces";
import { projectWorkDir } from "../src/server/workstation";
import { createFinalizeFactSource } from "../src/server/work/gitFinalizeHost";
import { executeVerifiedLocalCommit } from "../src/server/work/gitFinalize";
import { finalizeLocalCommitTool } from "../src/mcp/tools/workspaceTools";
import { findTool } from "../src/mcp/tools/index";

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

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-v09-66b-"));
const dataDir = path.join(tmpBase, "home");
const P = "v0966b";
const root = path.join(tmpBase, "proj");
const repo = path.join(tmpBase, "repo");
fs.mkdirSync(path.join(root, ".工作台"), { recursive: true });
fs.mkdirSync(repo, { recursive: true });

const git = (cwd: string, args: string[]): string =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

// 真实 Git 仓库（隔离夹具）
git(repo, ["init", "-q", "-b", "main"]);
git(repo, ["config", "user.email", "fixture@example.com"]);
git(repo, ["config", "user.name", "fixture"]);
fs.writeFileSync(path.join(repo, "a.txt"), "a\n", "utf8");
git(repo, ["add", "a.txt"]);
git(repo, ["commit", "-q", "-m", "base"]);
const headBefore = git(repo, ["rev-parse", "HEAD"]).trim();

const nowStamp = "2026-10-09T00:00:00+08:00";
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(
  path.join(dataDir, "registry.json"),
  JSON.stringify({ version: 1, projects: [{ id: P, name: "V09-66b 夹具", path: root, kind: "backend", registered_at: nowStamp, last_opened_at: nowStamp }] }),
  "utf8",
);
process.env.TATAI_HOME = dataDir;
fs.mkdirSync(path.join(root, ".工作台"), { recursive: true });
fs.writeFileSync(path.join(root, ".工作台", "design.md"), "# 设计\n", "utf8");
fs.writeFileSync(path.join(root, ".工作台", "plan.md"), "# 施工\n", "utf8");

const service = new WorkService({ dataDir });
const workDir = projectWorkDir(P, dataDir);
const submitter = { submit: (c: unknown) => service.submit(c), read: () => readWorkspaces(workDir) };
const CHANGE = "change-v0966b";
const COORD = "v0966b-coordinator";

section("⓪ 登记 git_worktree 工作区");
{
  const reg = registerWorkspace(submitter, {
    project_id: P, workspace_id: "ws-repo", change_id: CHANGE, actor_id: COORD, role: "coordinator",
    kind: "candidate", purpose: "git 候选", root: repo, source_kind: "git_worktree",
  });
  ok(reg.ok === true, `⓪ 登记 ws-repo（git_worktree）（${reg.ok ? "ok" : reg.code}）`);
}

section("② 宿主事实源：安全关键字段现读账本；未授权 fail-closed");
{
  const facts = createFinalizeFactSource({ dataDir });
  const grant = await facts.resolveFinalizeGrant({ project_id: P, task_id: "T-1", workspace_id: "ws-repo", actor: { id: "exec", role: "executor" } });
  ok(grant.root === path.resolve(repo), `② 宿主派生 root = 工作区登记路径（${grant.root}）`);
  ok(grant.workspace_kind === "candidate" && grant.source_kind === "git_worktree", `② 宿主派生 kind/source_kind（${grant.workspace_kind}/${grant.source_kind}）`);
  ok(grant.authorized === false && grant.technical_verified === false && grant.independent_audit_passed === false, `② 无认领/无探针 → 授权与技术/独审均 fail-closed=false`);
}

section("② 未授权收尾：refused 且**零 Git 副作用**");
{
  const facts = createFinalizeFactSource({ dataDir });
  const result = await executeVerifiedLocalCommit({
    request: { project_id: P, task_id: "T-1", workspace_id: "ws-repo", actor: { id: "exec", role: "executor" }, subject: "should-refuse" },
    facts,
  });
  ok(result.status === "refused" && result.accepted === false, `② 未授权收尾 refused（code=${result.code}）`);
  ok(result.code === "NOT_AUTHORIZED", `② 拒绝码 NOT_AUTHORIZED（实际 ${result.code}）`);
  ok(result.side_effects.commit_created === false && result.commit === null, `② 零副作用：未产生提交`);
  const headAfter = git(repo, ["rev-parse", "HEAD"]).trim();
  ok(headAfter === headBefore, `② 仓库 HEAD 未变（${headAfter.slice(0, 12)}…，零 git 写）`);
}

section("⑤ 工具面：请求闭键（不得自带 grant/布尔/root）；无宿主 → SERVICE_UNAVAILABLE");
{
  ok(findTool("finalize_local_commit") === finalizeLocalCommitTool, `⑤ finalize_local_commit 已注册进 TOOLS`);
  const noCtx = await finalizeLocalCommitTool.handler({ project_id: P, task_id: "T-1", workspace_id: "ws-repo", subject: "x" });
  const noCtxBody = JSON.parse((noCtx.content[0] as { text: string }).text);
  ok(noCtxBody.code === "SERVICE_UNAVAILABLE", `⑤ 无 ctx.work → SERVICE_UNAVAILABLE（不本地跑 git）（${noCtxBody.code}）`);

  // 自带 grant/allow_local_commit/expected_root/root → 闭键拒
  const fakeWork = { finalizeLocalCommitRemote: async () => ({ kind: "unsupported", reason: "test" }) };
  const bad = await finalizeLocalCommitTool.handler(
    { project_id: P, task_id: "T-1", workspace_id: "ws-repo", subject: "x", grant: { authorized: true }, allow_local_commit: true, expected_root: repo },
    { clientName: "t", work: fakeWork as never },
  );
  const badBody = JSON.parse((bad.content[0] as { text: string }).text);
  ok(badBody.code === "INVALID_COMMAND" && Array.isArray(badBody.detail?.extra) && badBody.detail.extra.length === 3, `⑤ 请求自带 grant/布尔/root → 闭键拒（extra=${JSON.stringify(badBody.detail?.extra)}）`);
}

console.log(`\n[verify] V09-66b 结果：PASS ${pass} / FAIL ${fail}`);
if (fail > 0) process.exitCode = 1;
