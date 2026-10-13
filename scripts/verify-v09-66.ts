// V09-66 验证脚本：本地 Git 自动收尾引擎（`src/server/work/gitFinalize.ts`）在**真实临时 Git 仓库**上的端到端验证。
// 用法：pnpm exec tsx scripts/verify-v09-66.ts   （或 pnpm verify:v09-66）
//
// 依据：DESIGN.md §6.14 第 9 段（唯一规范）、PLAN V09-66（chk-v09-66-01…05）、git-probe/REPORT.md（实验依据）。
// 目录口径（本脚本自己守）：**所有临时 Git 仓库都建在中央证据目录 impl-git/fixtures/ 内**
//   （默认 D:/tatai/.工作台/workspace-version-implementation-20261009/impl-git；可用 TATAI_V0966_DIR 覆盖）。
//   `.工作台/` 已被 D:/tatai 的 .gitignore 忽略，夹具内嵌仓库不污染任何真实仓库；默认收尾删除（TATAI_KEEP_TMP=1 保留）。
//   本脚本**不**操作 D:/tatai 或 D:/tatai-workspaces… 的真实 Git（不 add/commit/reset），不碰 8787，不改任何全局/仓库 Git 配置。
//
// 覆盖（对应任务点名的用例）：normal(new/modify/delete)、unrelated committed 前拒绝零副作用、noop、
//   hook 只改 index / 注入范围外路径 / 改工作文件 / 失败、CRLF+attributes、回执丢失重试与伪尾注错误 tree 拒、
//   branch/head drift、多 worktree、非 Git 拒、候选被篡改、范围外改动、资格判据、pathspec 安全（空格/中文/前导-/*?!/[）。
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertNoForbiddenGitArgs,
  computeFinalizeId,
  evaluateFinalizeEligibility,
  executeVerifiedLocalCommit,
  parseFinalizeTrailers,
  type FinalizeChangeEntry,
  type FinalizeChangeStatus,
  type FinalizeFactSource,
  type FinalizeGrant,
  type FinalizeIndexEntry,
  type FinalizeRequest,
  type FinalizeResult,
} from "../src/server/work/gitFinalize";

// ── 0. 目录与工具 ────────────────────────────────────────────────────────────
const WORK_DIR =
  process.env.TATAI_V0966_DIR ??
  "D:/tatai/.工作台/workspace-version-implementation-20261009/impl-git";
const FIXTURES = path.join(WORK_DIR, "fixtures");
const KEEP = process.env.TATAI_KEEP_TMP === "1";

let failures = 0;
const ok = (cond: boolean, label: string, extra = ""): void => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) {
    failures++;
    process.exitCode = 1;
  }
};
const eq = (actual: unknown, expected: unknown): boolean =>
  JSON.stringify(actual) === JSON.stringify(expected);

function sha256(buf: Buffer | string): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function git(repo: string, argv: string[], input?: string | Buffer): string {
  const r = spawnSync("git", ["-C", repo, ...argv], { encoding: "utf8", input, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) {
    throw new Error(`git -C ${repo} ${argv.join(" ")} → exit ${r.status}\n${r.stderr}`);
  }
  return r.stdout as string;
}
function gitStatusOf(repo: string, argv: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync("git", ["-C", repo, ...argv], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}
function write(f: string, content: string | Buffer): void {
  const dir = path.dirname(f);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(f, content);
}
function mkRepo(name: string, opts: { autocrlf?: boolean } = {}): string {
  const dir = path.join(FIXTURES, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.name", "v09-66 verify"]);
  git(dir, ["config", "user.email", "v0966@example.invalid"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  git(dir, ["config", "core.autocrlf", opts.autocrlf === true ? "true" : "false"]);
  return dir;
}
function baseCommit(repo: string, msg = "base"): string {
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", msg]);
  return git(repo, ["rev-parse", "HEAD"]).trim();
}
function installHook(repo: string, body: string): void {
  const hookDir = path.join(repo, ".git", "hooks");
  fs.mkdirSync(hookDir, { recursive: true });
  const hook = path.join(hookDir, "pre-commit");
  fs.writeFileSync(hook, `#!/bin/sh\n${body}\n`);
  try {
    fs.chmodSync(hook, 0o755);
  } catch {
    /* Windows 无 exec 位；Git for Windows 按 shebang 跑 */
  }
}

/** 仓库现场快照（内容级，不是 mtime）：零副作用断言与「现场保留」断言都用它 */
function repoState(repo: string): string {
  const s: Record<string, string> = {};
  const q = (k: string, argv: string[]) => {
    const r = gitStatusOf(repo, argv);
    s[k] = `${r.status}\n${r.stdout}`;
  };
  q("head", ["rev-parse", "HEAD"]);
  q("branch", ["rev-parse", "--abbrev-ref", "HEAD"]);
  q("index", ["ls-files", "-s"]);
  q("status", ["status", "--porcelain=v1", "-uall"]);
  q("refs", ["for-each-ref", "--format=%(refname) %(objectname)"]);
  s.files = hashWorktree(repo);
  return JSON.stringify(s);
}
function hashWorktree(repo: string): string {
  const entries: string[] = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === ".git") continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) entries.push(`${path.relative(repo, p).split(path.sep).join("/")}:${sha256(fs.readFileSync(p))}`);
    }
  };
  walk(repo);
  entries.sort();
  return sha256(entries.join("\n"));
}

// ── 1. grant / request 构造（模拟宿主从中央事实读出的结果） ──────────────────────
function entryOf(repo: string, rel: string, status: FinalizeChangeStatus): FinalizeChangeEntry {
  if (status === "deleted") return { path: rel, status, sha256: null, mode: null, size: null };
  const buf = fs.readFileSync(path.join(repo, rel));
  return { path: rel, status, sha256: sha256(buf), mode: "100644", size: buf.length };
}
function fullIndexOf(repo: string): FinalizeIndexEntry[] {
  const out: FinalizeIndexEntry[] = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === ".git") continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        const buf = fs.readFileSync(p);
        out.push({
          path: path.relative(repo, p).split(path.sep).join("/"),
          sha256: sha256(buf),
          size: buf.length,
          mode: "100644",
        });
      }
    }
  };
  walk(repo);
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}
function grantOf(repo: string, changes: FinalizeChangeEntry[], over: Partial<FinalizeGrant> = {}): FinalizeGrant {
  const tryGit = (argv: string[]): string | null => {
    try {
      return git(repo, argv).trim();
    } catch {
      return null;
    }
  };
  const base = over.candidate_base_head !== undefined ? over.candidate_base_head : tryGit(["rev-parse", "HEAD"]);
  const branch = over.candidate_branch !== undefined ? over.candidate_branch : tryGit(["rev-parse", "--abbrev-ref", "HEAD"]);
  const gitDir = over.git_dir !== undefined ? over.git_dir : tryGit(["rev-parse", "--absolute-git-dir"]);
  return {
    project_id: "proj-v0966",
    task_id: "V09-66",
    workspace_id: "proj-v0966:task",
    root: repo,
    git_dir: gitDir,
    workspace_kind: "candidate",
    workspace_status: "frozen",
    source_kind: "git_worktree",
    authorized: true,
    authorization_ref: "ev-authorization-1",
    technical_verified: true,
    independent_audit_passed: true,
    audit_reviewer_id: "auditor-1",
    task_author_id: "author-1",
    candidate_kind: "candidate_index",
    candidate_fingerprint: sha256(changes.map((c) => `${c.status}:${c.path}:${c.sha256 ?? "-"}`).join("\n")),
    candidate_base_head: base,
    candidate_branch: branch,
    allow_local_commit: true,
    changes,
    evidence_refs: ["ev-self-check-1", "ev-independent-audit-1"],
    ...over,
  };
}
function factsOf(grant: FinalizeGrant): FinalizeFactSource {
  return { resolveFinalizeGrant: () => grant };
}
function requestOf(grant: FinalizeGrant, over: Partial<FinalizeRequest> = {}): FinalizeRequest {
  return {
    project_id: grant.project_id,
    task_id: grant.task_id,
    workspace_id: grant.workspace_id,
    actor: { id: "coordinator-1", role: "coordinator" },
    subject: "V09-66: finalize local commit",
    body: "verified candidate",
    ...over,
  };
}
let runSeq = 0;
async function run(grant: FinalizeGrant, over: Partial<FinalizeRequest> = {}): Promise<FinalizeResult> {
  runSeq++;
  const req = requestOf(grant, over);
  return executeVerifiedLocalCommit({ request: req, facts: factsOf(grant) });
}

function repoStateOf(repo: string): string {
  return git(repo, ["rev-parse", "HEAD"]).trim();
}

// ── 2. 用例 ─────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  fs.rmSync(FIXTURES, { recursive: true, force: true });
  fs.mkdirSync(FIXTURES, { recursive: true });
  console.log(`[verify] 夹具目录：${FIXTURES}`);

  // ── 用例 1：普通 new + modify + delete（含空格/中文/前导 -/glob 字符文件名）──────────
  {
    const repo = mkRepo("c01-normal");
    write(path.join(repo, "mod.txt"), "base-mod\n");
    write(path.join(repo, "keep.txt"), "keep\n");
    write(path.join(repo, "del.txt"), "to-delete\n");
    const base = baseCommit(repo);
    // 未跟踪的非授权文件——不该存在（否则算范围外改动）
    write(path.join(repo, "mod.txt"), "changed-mod\n");
    fs.rmSync(path.join(repo, "del.txt"));
    write(path.join(repo, "new file.txt"), "brand new\n");
    write(path.join(repo, "中文-新.txt"), "中文内容\n");
    write(path.join(repo, "-leading.txt"), "leading dash\n");
    write(path.join(repo, "!bang.txt"), "bang\n");
    write(path.join(repo, "[bracket].txt"), "bracket\n");
    write(path.join(repo, "paren(s).txt"), "paren\n");
    write(path.join(repo, "sp ace 双 空格.txt"), "spaces\n");

    const changes = [
      entryOf(repo, "mod.txt", "modified"),
      { path: "del.txt", status: "deleted", sha256: null, mode: null, size: null } as FinalizeChangeEntry,
      entryOf(repo, "new file.txt", "added"),
      entryOf(repo, "中文-新.txt", "added"),
      entryOf(repo, "-leading.txt", "added"),
      entryOf(repo, "!bang.txt", "added"),
      entryOf(repo, "[bracket].txt", "added"),
      entryOf(repo, "paren(s).txt", "added"),
      entryOf(repo, "sp ace 双 空格.txt", "added"),
    ];
    const grant = grantOf(repo, changes);
    const res = await run(grant);
    ok(res.status === "committed" && res.accepted === true, "① normal：status=committed/accepted", `${res.status}/${res.code}`);
    ok(res.checks !== null && res.checks.failures.length === 0, "① normal：全部后验断言通过", JSON.stringify(res.checks?.failures ?? []));
    ok(res.parent === base, "① normal：parent 是预期基准 HEAD");
    ok(res.commit !== null && git(repo, ["rev-parse", "HEAD"]).trim() === res.commit, "① normal：当前 HEAD 正是本次提交");
    ok(git(repo, ["rev-parse", "HEAD^"]).trim() === base, "① normal：HEAD^ == 基准");
    const range = git(repo, ["diff", "--no-renames", "--name-only", "-z", base, res.commit!]).split("\0").filter(Boolean).sort();
    ok(eq(range, changes.map((c) => c.path).sort()), "① normal：diff(base,commit) 恰等于授权集合", range.join(","));
    const tree = git(repo, ["ls-tree", "-r", "--name-only", "-z", res.commit!]).split("\0").filter(Boolean);
    const wantPaths = [...changes.filter((c) => c.status !== "deleted").map((c) => c.path), "keep.txt"].sort();
    ok(eq(tree.slice().sort(), wantPaths), "① normal：提交树恰含授权新增/修改路径 + 未改动文件", tree.sort().join(","));
    for (const c of changes.filter((c) => c.status !== "deleted")) {
      const blob = gitStatusOf(repo, ["cat-file", "blob", `${res.commit!}:${c.path}`]);
      ok(blob.status === 0 && sha256(blob.stdout) === c.sha256, `① normal：提交字节==受验字节 ${c.path}`);
    }
    ok(res.blobs.every((b) => b.normalized === false), "① normal：raw==blob（无规范化）");
    ok(git(repo, ["status", "--porcelain=v1", "-uall"]).trim() === "", "① normal：提交后工作区干净");
    ok(res.association !== null && res.association.commit === res.commit, "① normal：返回关联记录供宿主唯一写口");
    ok(res.side_effects.reset_performed === false && res.side_effects.worktree_restored === false, "① normal：未 reset/restore");
  }

  // ── 用例 2：无关已暂存内容 → REFUSED_UNRELATED_STAGED 且零副作用 ────────────────────
  {
    const repo = mkRepo("c02-unrelated-staged");
    write(path.join(repo, "mod.txt"), "base\n");
    write(path.join(repo, "other.txt"), "other-base\n");
    baseCommit(repo);
    write(path.join(repo, "mod.txt"), "authorized-change\n");
    write(path.join(repo, "other.txt"), "staged-but-unrelated\n");
    git(repo, ["add", "other.txt"]);
    write(path.join(repo, "newother.txt"), "staged new unrelated\n");
    git(repo, ["add", "newother.txt"]);
    const before = repoState(repo);
    const grant = grantOf(repo, [entryOf(repo, "mod.txt", "modified")]);
    const res = await run(grant);
    ok(res.status === "refused" && res.code === "REFUSED_UNRELATED_STAGED", "② 无关暂存：拒绝码", String(res.code));
    ok(res.commit === null && res.accepted === false, "② 无关暂存：未产生提交");
    ok(repoState(repo) === before, "② 无关暂存：零副作用（index/工作区/refs 原样）");
    ok(res.detail.unrelated_staged !== undefined, "② 无关暂存：点名无关路径");
  }

  // ── 用例 3：内容已在 HEAD → noop，不造空提交 ─────────────────────────────────────
  {
    const repo = mkRepo("c03-noop");
    write(path.join(repo, "mod.txt"), "same-content\n");
    const base = baseCommit(repo);
    const grant = grantOf(repo, [entryOf(repo, "mod.txt", "modified")]);
    const before = repoState(repo);
    const res = await run(grant);
    ok(res.status === "noop_up_to_date", "③ noop：状态", `${res.status}/${res.code}`);
    ok(res.accepted === false && res.commit === null, "③ noop：未造提交");
    ok(repoStateOf(repo) === base, "③ noop：HEAD 未前进");
    ok(repoState(repo) === before, "③ noop：零副作用");
  }

  // ── 用例 4：hook 只改 index（换掉授权路径的 blob）→ 后验必抓 ──────────────────────
  {
    const repo = mkRepo("c04-hook-index");
    write(path.join(repo, "mod.txt"), "base\n");
    write(path.join(repo, "other.txt"), "other\n");
    baseCommit(repo);
    write(path.join(repo, "mod.txt"), "authorized\n");
    installHook(
      repo,
      [
        `EVIL=$(printf 'EVIL-FROM-HOOK\\n' | git hash-object -w --stdin)`,
        `git update-index --cacheinfo 100644 "$EVIL" mod.txt`,
        `printf 'ran\\n' >> .git/hook-ran.txt`,
        `exit 0`,
      ].join("\n"),
    );
    const grant = grantOf(repo, [entryOf(repo, "mod.txt", "modified")]);
    const res = await run(grant);
    ok(fs.existsSync(path.join(repo, ".git", "hook-ran.txt")), "④ hook 只改 index：hook 确实跑了");
    ok(res.status === "failed" && res.code === "POST_VERIFY_FAILED", "④ hook 只改 index：如实失败", `${res.status}/${res.code}`);
    ok(res.accepted === false && res.commit !== null, "④ hook 只改 index：报告「提交已产生但未接受」");
    ok(
      res.checks !== null && res.checks.failures.some((f) => f.startsWith("BLOB_MISMATCH") || f.startsWith("TREE_MISMATCH")),
      "④ hook 只改 index：失配点为提交字节/树",
      JSON.stringify(res.checks?.failures ?? []),
    );
    ok(fs.readFileSync(path.join(repo, "mod.txt"), "utf8") === "authorized\n", "④ hook 只改 index：工作区未被 reset/覆盖");
  }

  // ── 用例 5：hook 往 index 注入范围外路径 → 提交范围/树断言必抓 ────────────────────
  {
    const repo = mkRepo("c05-hook-inject");
    write(path.join(repo, "mod.txt"), "base\n");
    write(path.join(repo, "other.txt"), "other\n");
    baseCommit(repo);
    write(path.join(repo, "mod.txt"), "authorized\n");
    installHook(
      repo,
      [
        `EVIL=$(printf 'INJECTED\\n' | git hash-object -w --stdin)`,
        `git update-index --add --cacheinfo 100644 "$EVIL" injected.txt`,
        `printf 'ran\\n' >> .git/hook-ran.txt`,
        `exit 0`,
      ].join("\n"),
    );
    const grant = grantOf(repo, [entryOf(repo, "mod.txt", "modified")]);
    const res = await run(grant);
    ok(fs.existsSync(path.join(repo, ".git", "hook-ran.txt")), "⑤ hook 注入范围外：hook 确实跑了");
    ok(res.status === "failed" && res.code === "POST_VERIFY_FAILED", "⑤ hook 注入范围外：如实失败", `${res.status}/${res.code}`);
    ok(
      res.checks !== null && res.checks.failures.some((f) => f.startsWith("RANGE_MISMATCH") || f.startsWith("TREE_MISMATCH")),
      "⑤ hook 注入范围外：范围/树断言抓到",
      JSON.stringify(res.checks?.failures ?? []),
    );
  }

  // ── 用例 6：hook 改工作区源文件（不动 index）→ 工作区漂移必抓 ─────────────────────
  {
    const repo = mkRepo("c06-hook-worktree");
    write(path.join(repo, "mod.txt"), "base\n");
    write(path.join(repo, "other.txt"), "other\n");
    baseCommit(repo);
    write(path.join(repo, "mod.txt"), "authorized\n");
    installHook(
      repo,
      [`printf 'APPENDED-BY-HOOK\\n' >> other.txt`, `printf 'ran\\n' >> .git/hook-ran.txt`, `exit 0`].join("\n"),
    );
    const grant = grantOf(repo, [entryOf(repo, "mod.txt", "modified")]);
    const res = await run(grant);
    ok(fs.existsSync(path.join(repo, ".git", "hook-ran.txt")), "⑥ hook 改工作文件：hook 确实跑了");
    ok(res.status === "failed" && res.code === "POST_VERIFY_FAILED", "⑥ hook 改工作文件：如实失败", `${res.status}/${res.code}`);
    ok(
      res.checks !== null && res.checks.failures.some((f) => f.startsWith("WORKTREE_DRIFT")),
      "⑥ hook 改工作文件：工作区漂移抓到",
      JSON.stringify(res.checks?.failures ?? []),
    );
    ok(fs.readFileSync(path.join(repo, "other.txt"), "utf8").includes("APPENDED-BY-HOOK"), "⑥ hook 改工作文件：现场保留（不还原）");
  }

  // ── 用例 7：hook 失败（exit 1）→ 如实失败，未产生提交 ────────────────────────────
  {
    const repo = mkRepo("c07-hook-fail");
    write(path.join(repo, "mod.txt"), "base\n");
    baseCommit(repo);
    write(path.join(repo, "mod.txt"), "authorized\n");
    installHook(repo, [`printf 'blocked\\n' >&2`, `exit 1`].join("\n"));
    const grant = grantOf(repo, [entryOf(repo, "mod.txt", "modified")]);
    const res = await run(grant);
    ok(res.status === "failed" && res.code === "COMMIT_FAILED", "⑦ hook 失败：如实返回", `${res.status}/${res.code}`);
    ok(res.commit === null && res.accepted === false, "⑦ hook 失败：未产生提交");
    ok(git(repo, ["rev-parse", "HEAD"]).trim() === git(repo, ["rev-parse", "HEAD"]).trim(), "⑦ hook 失败：HEAD 未变");
    ok(fs.readFileSync(path.join(repo, "mod.txt"), "utf8") === "authorized\n", "⑦ hook 失败：工作区保留");
  }

  // ── 用例 8：CRLF / .gitattributes 规范化（raw ≠ blob，分别记录且仍判通过） ──────────
  {
    const repo = mkRepo("c08-crlf", { autocrlf: true });
    write(path.join(repo, ".gitattributes"), "*.toml text eol=lf\n");
    write(path.join(repo, "package.json"), "{\n  \"a\": 1\n}\n");
    write(path.join(repo, "conf.toml"), "a = 1\nb = 2\n");
    baseCommit(repo);
    // 手写 CRLF 工作区文件（未按仓库规范归一）：入库应为 LF
    write(path.join(repo, "conf.toml"), "a = 1\r\nb = 2\r\nc = 3\r\n");
    write(path.join(repo, "crlf.txt"), "line1\r\nline2\r\n");
    const changes = [entryOf(repo, "conf.toml", "modified"), entryOf(repo, "crlf.txt", "added")];
    const grant = grantOf(repo, changes);
    const res = await run(grant);
    ok(res.status === "committed", "⑧ CRLF：提交成功", `${res.status}/${res.code}`);
    const recs = res.blobs.filter((b) => b.path !== ".gitattributes");
    ok(recs.every((b) => b.normalized === true), "⑧ CRLF：raw ≠ blob 如实标记", JSON.stringify(res.blobs.map((b) => [b.path, b.normalized])));
    ok(recs.every((b) => b.canonical_oid === b.committed_oid && b.canonical_oid !== null), "⑧ CRLF：canonical(--path) 预测 == 实际入库 blob");
    ok(recs.every((b) => b.raw_oid !== null && b.raw_sha256 !== null), "⑧ CRLF：原始字节指纹与 raw oid 一并记录");
    const blobText = git(repo, ["cat-file", "blob", `${res.commit!}:conf.toml`]);
    ok(blobText === "a = 1\nb = 2\nc = 3\n", "⑧ CRLF：入库字节按仓库规范归一为 LF");
    ok(fs.readFileSync(path.join(repo, "conf.toml"), "utf8").includes("\r\n"), "⑧ CRLF：工作区原始 CRLF 字节未被改写");
  }

  // ── 用例 9：回执丢失重试（幂等复用）＋ 伪尾注错误 tree 拒 ─────────────────────────
  {
    const repo = mkRepo("c09-retry");
    write(path.join(repo, "mod.txt"), "base\n");
    baseCommit(repo);
    write(path.join(repo, "mod.txt"), "authorized\n");
    const grant = grantOf(repo, [entryOf(repo, "mod.txt", "modified")]);
    const seed = {
      project_id: grant.project_id,
      task_id: grant.task_id,
      workspace_id: grant.workspace_id,
      candidate_fingerprint: grant.candidate_fingerprint!,
      base_head: grant.candidate_base_head!,
    };
    const fid = computeFinalizeId(seed);
    const r1 = await run(grant, { finalize_id: fid });
    ok(r1.status === "committed", "⑨a 首次提交成功", `${r1.status}/${r1.code}`);
    const committed = repoStateOf(repo);
    // 回执丢失：同输入重试（不做任何 reset）
    const r2 = await run(grant, { finalize_id: fid });
    ok(r2.status === "reused" && r2.accepted === true, "⑨a 重试：幂等复用（不产生第二个提交）", `${r2.status}/${r2.code}`);
    ok(repoStateOf(repo) === committed, "⑨a 重试：HEAD 未再前进");
    ok(r2.commit === committed, "⑨a 重试：复用同一提交");
    const parsed = parseFinalizeTrailers(git(repo, ["log", "-1", "--format=%B"]));
    ok(parsed.finalize_id === fid, "⑨a 提交消息带确定性 finalize_id 尾注");
  }
  {
    // 伪尾注：手工造一个带同 finalize_id 尾注、但内容/tree 不同的提交
    const repo = mkRepo("c09-forged");
    write(path.join(repo, "mod.txt"), "base\n");
    const base = baseCommit(repo);
    write(path.join(repo, "mod.txt"), "authorized\n");
    const grant = grantOf(repo, [entryOf(repo, "mod.txt", "modified")]);
    const fid = computeFinalizeId({
      project_id: grant.project_id,
      task_id: grant.task_id,
      workspace_id: grant.workspace_id,
      candidate_fingerprint: grant.candidate_fingerprint!,
      base_head: base,
    });
    // 手工提交：内容与受验不同，但尾注**完全对得上**（同 finalize_id/候选/基准）——不得仅凭尾注复用
    write(path.join(repo, "mod.txt"), "FORGED-CONTENT\n");
    git(repo, ["add", "mod.txt"]);
    git(repo, [
      "commit",
      "-q",
      "-m",
      `forged\n\nTatai-Finalize: ${fid}\nTatai-Candidate: ${grant.candidate_fingerprint!}\nTatai-Base: ${base}`,
    ]);
    const forgedHead = repoStateOf(repo);
    // 恢复工作区为受验字节，再调用引擎（尾注命中但 tree/字节不符）
    write(path.join(repo, "mod.txt"), "authorized\n");
    const res = await run(grant, { finalize_id: fid });
    ok(res.status === "refused" || res.status === "failed", "⑨b 伪尾注：不得复用", `${res.status}/${res.code}`);
    ok(res.code === "RECEIPT_REPLAY_MISMATCH", "⑨b 伪尾注：稳定码 RECEIPT_REPLAY_MISMATCH", String(res.code));
    ok(res.commit === forgedHead || res.commit === null, "⑨b 伪尾注：不产生第二个提交");
    ok(repoStateOf(repo) === forgedHead, "⑨b 伪尾注：HEAD 未再前进");
  }
  {
    // 尾注提交存在但被后续提交压在下面（HEAD ≠ 该提交）→ 拒绝，不重复 commit
    const repo = mkRepo("c09-not-head");
    write(path.join(repo, "mod.txt"), "base\n");
    write(path.join(repo, "other.txt"), "other\n");
    const base = baseCommit(repo);
    write(path.join(repo, "mod.txt"), "authorized\n");
    const grant = grantOf(repo, [entryOf(repo, "mod.txt", "modified")]);
    const fid = computeFinalizeId({
      project_id: grant.project_id,
      task_id: grant.task_id,
      workspace_id: grant.workspace_id,
      candidate_fingerprint: grant.candidate_fingerprint!,
      base_head: base,
    });
    git(repo, ["add", "mod.txt"]);
    git(repo, ["commit", "-q", "-m", `earlier\n\nTatai-Finalize: ${fid}\nTatai-Candidate: ${grant.candidate_fingerprint!}\nTatai-Base: ${base}`]);
    write(path.join(repo, "other.txt"), "later change\n");
    git(repo, ["add", "other.txt"]);
    git(repo, ["commit", "-q", "-m", "later commit on top"]);
    const head = repoStateOf(repo);
    const res = await run(grant, { finalize_id: fid });
    ok(res.status !== "committed" && res.status !== "reused", "⑨c 尾注不在 HEAD：不复用、不重复提交", `${res.status}/${res.code}`);
    ok(repoStateOf(repo) === head, "⑨c 尾注不在 HEAD：HEAD 未变");
  }

  // ── 用例 10：branch / head 漂移 → 零副作用拒绝 ──────────────────────────────────
  {
    const repo = mkRepo("c10-drift");
    write(path.join(repo, "mod.txt"), "base\n");
    baseCommit(repo);
    const staleBase = git(repo, ["rev-parse", "HEAD"]).trim();
    write(path.join(repo, "other.txt"), "second\n");
    baseCommit(repo, "second");
    write(path.join(repo, "mod.txt"), "authorized\n");
    const before = repoState(repo);
    // HEAD 漂移：grant 的基准还停在第一个提交
    const g1 = grantOf(repo, [entryOf(repo, "mod.txt", "modified")], { candidate_base_head: staleBase });
    const r1 = await run(g1);
    ok(r1.status === "refused" && r1.code === "HEAD_DRIFT", "⑩ head drift：拒绝", `${r1.status}/${r1.code}`);
    ok(repoState(repo) === before, "⑩ head drift：零副作用");

    // 分支漂移：切到别的分支
    git(repo, ["checkout", "-q", "-b", "other-branch"]);
    const g2 = grantOf(repo, [entryOf(repo, "mod.txt", "modified")], { candidate_branch: "main" });
    const before2 = repoState(repo);
    const r2 = await run(g2);
    ok(r2.status === "refused" && r2.code === "BRANCH_DRIFT", "⑩ branch drift：拒绝", `${r2.status}/${r2.code}`);
    ok(repoState(repo) === before2, "⑩ branch drift：零副作用");

    // 游离头
    git(repo, ["checkout", "-q", "--detach"]);
    const g3 = grantOf(repo, [entryOf(repo, "mod.txt", "modified")], { candidate_branch: "other-branch" });
    const r3 = await run(g3);
    ok(r3.status === "refused" && r3.code === "BRANCH_DRIFT", "⑩ detached HEAD：拒绝", `${r3.status}/${r3.code}`);
  }

  // ── 用例 11：多 worktree（含 .git 文件形态）──────────────────────────────────────
  {
    const mainRepo = mkRepo("c11-worktree-main");
    write(path.join(mainRepo, "mod.txt"), "base\n");
    write(path.join(mainRepo, "keep.txt"), "keep\n");
    baseCommit(mainRepo);
    const wt = path.join(FIXTURES, "c11-wt");
    fs.rmSync(wt, { recursive: true, force: true });
    git(mainRepo, ["worktree", "add", "-q", "-b", "wt-branch", wt]);
    write(path.join(wt, "mod.txt"), "authorized-in-worktree\n");
    const changes = [entryOf(wt, "mod.txt", "modified")];
    const grant = grantOf(wt, changes);
    const mainHead = git(mainRepo, ["rev-parse", "HEAD"]).trim();
    const res = await run(grant);
    ok(res.status === "committed", "⑪ 多 worktree：在链接工作树内提交成功", `${res.status}/${res.code}`);
    ok(res.git.git_dir !== null && path.resolve(res.git.git_dir) !== path.resolve(path.join(mainRepo, ".git")), "⑪ 多 worktree：识别 worktree 专属 gitdir");
    ok(git(mainRepo, ["rev-parse", "HEAD"]).trim() === mainHead, "⑪ 多 worktree：主仓 HEAD 未被扰动");
    ok(git(wt, ["rev-parse", "HEAD"]).trim() === res.commit, "⑪ 多 worktree：worktree HEAD 前进到本次提交");
    git(mainRepo, ["worktree", "remove", "--force", wt]);
  }

  // ── 用例 12：非 Git 目录 → 拒绝且不 init；且**已挂在别的仓库里的目录不得借用外层仓库** ──
  {
    // 真正的"非 Git"夹具必须放在任何仓库之外：impl-git 本身位于 D:/tatai 仓库内，
    // 那里的目录 `rev-parse` 会命中 D:/tatai（见下面的"挂在外层仓库里"反例），所以非 Git 用例落在 os.tmpdir()。
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-v0966-nongit-"));
    const insideProbe = gitStatusOf(outside, ["rev-parse", "--show-toplevel"]);
    const reallyOutside = insideProbe.status !== 0;
    ok(reallyOutside, "⑫ 前置：临时目录确实在任何 Git 仓库之外", insideProbe.stdout.trim() || insideProbe.stderr.trim());
    if (reallyOutside) {
      write(path.join(outside, "a.txt"), "not a repo\n");
      const grant = grantOf(outside, [entryOf(outside, "a.txt", "added")], {
        git_dir: null,
        source_kind: "directory",
        candidate_kind: "content_snapshot",
        allow_local_commit: false,
      });
      const res = await run(grant);
      ok(
        res.status === "refused" && (res.code === "NON_GIT_SNAPSHOT_NO_COMMIT" || res.code === "NOT_A_GIT_REPOSITORY"),
        "⑫ 非 Git：拒绝（不假称已保存）",
        `${res.status}/${res.code}`,
      );
      ok(!fs.existsSync(path.join(outside, ".git")), "⑫ 非 Git：未擅自 git init");

      // 非 Git 但被要求本地提交 → 明确拒绝，且不 init。
      // 这里给一个形状合法的基准/分支，是为了**绕开资格判据**、直接打到引擎的"不是 Git 工作树"分支。
      const outside2 = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-v0966-nongit2-"));
      write(path.join(outside2, "a.txt"), "not a repo\n");
      const g2 = grantOf(outside2, [entryOf(outside2, "a.txt", "added")], {
        git_dir: null,
        source_kind: "directory",
        candidate_kind: "candidate_index",
        allow_local_commit: true,
        candidate_base_head: "0".repeat(40),
        candidate_branch: "main",
      });
      const r2 = await run(g2);
      ok(r2.status === "refused" && r2.code === "NOT_A_GIT_REPOSITORY", "⑫ 非 Git + 要求提交：NOT_A_GIT_REPOSITORY", `${r2.status}/${r2.code}`);
      ok(!fs.existsSync(path.join(outside2, ".git")), "⑫ 非 Git + 要求提交：未擅自 git init");
      fs.rmSync(outside2, { recursive: true, force: true });
    }
    fs.rmSync(outside, { recursive: true, force: true });

    // 反例：目录位于**别的仓库**里（不是那个仓库的工作树根）→ 拒绝，绝不把提交打进外层仓库
    const nested = path.join(FIXTURES, "c12-nested-in-repo");
    fs.rmSync(nested, { recursive: true, force: true });
    fs.mkdirSync(nested, { recursive: true });
    write(path.join(nested, "a.txt"), "nested\n");
    const enclTop = gitStatusOf(nested, ["rev-parse", "--show-toplevel"]);
    ok(enclTop.status === 0, "⑫ 前置：该夹具确实挂在某个外层仓库里（构造反例的前提成立）", enclTop.stdout.trim());
    const g3 = grantOf(nested, [entryOf(nested, "a.txt", "added")], { git_dir: null, source_kind: "directory" });
    const r3 = await run(g3);
    ok(
      r3.status === "refused" && r3.code === "WORKSPACE_NOT_REPO_ROOT",
      "⑫ 挂在外层仓库里的目录：拒绝（不借用外层仓库提交）",
      `${r3.status}/${r3.code}`,
    );
    ok(!fs.existsSync(path.join(nested, ".git")), "⑫ 挂在外层仓库里的目录：未新建 .git");
    ok(r3.commands.every((c) => !/\bcommit\b/.test(c)), "⑫ 挂在外层仓库里的目录：未执行任何 commit");
  }

  // ── 用例 13：候选被篡改 / 范围外改动 / 授权路径缺失 → 零副作用拒绝 ────────────────
  {
    const repo = mkRepo("c13-tampered");
    write(path.join(repo, "mod.txt"), "base\n");
    write(path.join(repo, "extra.txt"), "extra-base\n");
    baseCommit(repo);
    write(path.join(repo, "mod.txt"), "authorized\n");
    const changes = [entryOf(repo, "mod.txt", "modified")];
    // 声明的受验字节与工作区不符
    const tampered = [{ ...changes[0], sha256: sha256("something else\n") }];
    const g1 = grantOf(repo, tampered);
    const before = repoState(repo);
    const r1 = await run(g1);
    ok(r1.status === "refused" && r1.code === "CANDIDATE_TAMPERED", "⑬ 候选篡改：CANDIDATE_TAMPERED", `${r1.status}/${r1.code}`);
    ok(repoState(repo) === before, "⑬ 候选篡改：零副作用");

    // 范围外改动：工作区里还有一条未授权改动
    write(path.join(repo, "extra.txt"), "unverified change\n");
    const g2 = grantOf(repo, changes);
    const before2 = repoState(repo);
    const r2 = await run(g2);
    ok(r2.status === "refused" && r2.code === "OUT_OF_SCOPE_CHANGE", "⑬ 范围外改动：OUT_OF_SCOPE_CHANGE", `${r2.status}/${r2.code}`);
    ok(repoState(repo) === before2, "⑬ 范围外改动：零副作用");

    // 授权路径在工作区缺失（不该被算成删除）
    write(path.join(repo, "extra.txt"), "extra-base\n");
    fs.rmSync(path.join(repo, "mod.txt"));
    const g3 = grantOf(repo, changes);
    const before3 = repoState(repo);
    const r3 = await run(g3);
    ok(
      r3.status === "refused" && (r3.code === "CANDIDATE_TAMPERED" || r3.code === "MISSING_AUTHORIZED_CHANGE"),
      "⑬ 授权路径缺失：拒绝",
      `${r3.status}/${r3.code}`,
    );
    ok(repoState(repo) === before3, "⑬ 授权路径缺失：零副作用");
  }

  // ── 用例 14：资格判据（无授权/未验证/无独审/独审=作者/角色/非 Git 快照） ─────────────
  {
    const repo = mkRepo("c14-eligibility");
    write(path.join(repo, "mod.txt"), "base\n");
    baseCommit(repo);
    write(path.join(repo, "mod.txt"), "authorized\n");
    const changes = [entryOf(repo, "mod.txt", "modified")];
    const before = repoState(repo);
    const cases: Array<[string, Partial<FinalizeGrant>, string]> = [
      ["无授权", { authorized: false }, "NOT_AUTHORIZED"],
      ["授权引用缺失", { authorization_ref: null }, "NOT_AUTHORIZED"],
      ["技术验证未过", { technical_verified: false }, "NOT_VERIFIED"],
      ["独立审查未过", { independent_audit_passed: false }, "NOT_INDEPENDENTLY_AUDITED"],
      ["独审者=作者", { audit_reviewer_id: "author-1" }, "AUDIT_REVIEWER_IS_AUTHOR"],
      ["候选种类未知", { candidate_kind: "unknown", candidate_fingerprint: null }, "CANDIDATE_UNRESOLVED"],
      ["非 Git 快照", { candidate_kind: "content_snapshot", allow_local_commit: false }, "NON_GIT_SNAPSHOT_NO_COMMIT"],
      ["工作区已回收", { workspace_status: "retired" }, "FINALIZE_NOT_PERMITTED"],
    ];
    for (const [label, over, code] of cases) {
      const g = grantOf(repo, changes, over);
      const res = await run(g);
      ok(res.status === "refused" && res.code === code, `⑭ 资格：${label} → ${code}`, `${res.status}/${res.code}`);
    }
    // 角色不符（调用者是只读角色）
    const g = grantOf(repo, changes);
    const res = await run(g, { actor: { id: "viewer", role: "viewer" } });
    ok(res.status === "refused" && res.code === "NOT_AUTHORIZED", "⑭ 资格：只读角色 → NOT_AUTHORIZED", `${res.status}/${res.code}`);
    ok(repoState(repo) === before, "⑭ 资格：所有拒绝均零副作用");

    // 纯函数口径（宿主可直接用）：同一 grant 必须判 eligible
    const el = evaluateFinalizeEligibility(grantOf(repo, changes), { id: "coordinator-1", role: "coordinator" });
    ok(el.eligible === true, "⑭ 纯资格函数：合规 grant → eligible");
  }

  // ── 用例 15：full_index 逐条核工作区 ────────────────────────────────────────────
  {
    const repo = mkRepo("c15-full-index");
    write(path.join(repo, "mod.txt"), "base\n");
    write(path.join(repo, "keep.txt"), "keep\n");
    baseCommit(repo);
    write(path.join(repo, "mod.txt"), "authorized\n");
    const changes = [entryOf(repo, "mod.txt", "modified")];
    const idx = fullIndexOf(repo);
    const before = repoState(repo);
    const bad = idx.map((e) => (e.path === "keep.txt" ? { ...e, sha256: sha256("different\n") } : e));
    const r1 = await run(grantOf(repo, changes, { full_index: bad }));
    ok(r1.status === "refused" && r1.code === "CANDIDATE_TAMPERED", "⑮ full_index 不符：CANDIDATE_TAMPERED", `${r1.status}/${r1.code}`);
    ok(repoState(repo) === before, "⑮ full_index 不符：零副作用");
    const r2 = await run(grantOf(repo, changes, { full_index: idx }));
    ok(r2.status === "committed", "⑮ full_index 相符：提交成功", `${r2.status}/${r2.code}`);
  }

  // ── 用例 16：运行期闸门（禁用参数）+ 非绝对路径 ──────────────────────────────────
  {
    const forbidden: string[][] = [
      ["commit", "-a"],
      ["commit", "--all"],
      ["add", "-A"],
      ["commit", "--allow-empty"],
      ["commit", "--no-verify"],
      ["commit-tree", "abc"],
      ["push"],
      ["reset", "--hard"],
      ["checkout", "--", "."],
      ["-c", "core.hooksPath=/dev/null", "commit"],
    ];
    for (const argv of forbidden) {
      let threw = false;
      try {
        assertNoForbiddenGitArgs(argv);
      } catch {
        threw = true;
      }
      ok(threw, `⑯ 运行期闸门：拒绝禁用 argv ${argv.join(" ")}`);
    }
    let okArgv = true;
    try {
      assertNoForbiddenGitArgs(["commit", "--only", "-m", "x"]);
      assertNoForbiddenGitArgs(["add", "--pathspec-from-file=/tmp/p", "--pathspec-file-nul"]);
    } catch {
      okArgv = false;
    }
    ok(okArgv, "⑯ 运行期闸门：放行合法 argv");

    const repo = mkRepo("c16-absolute");
    write(path.join(repo, "a.txt"), "a\n");
    baseCommit(repo);
    const res = await executeVerifiedLocalCommit({
      request: requestOf(grantOf(repo, []), { task_id: "V09-66" }),
      facts: factsOf(grantOf(repo, [], { root: "relative/not/absolute" })),
    });
    ok(res.status === "refused" && res.code === "WORKSPACE_ROOT_INVALID", "⑯ 非绝对工作区路径：拒绝", `${res.status}/${res.code}`);

    // 观测到的 cwd 与授权工作区不一致 → 拒绝
    const other = mkRepo("c16-other-root");
    write(path.join(other, "a.txt"), "a\n");
    baseCommit(other);
    const g2 = grantOf(repo, []);
    const r2 = await executeVerifiedLocalCommit({
      request: requestOf(g2, { expected_root: other }),
      facts: factsOf(g2),
    });
    ok(r2.status === "refused" && r2.code === "WORKSPACE_MISMATCH", "⑯ cwd ≠ 授权工作区：拒绝", `${r2.status}/${r2.code}`);

    // git_dir 与实际不符 → 拒绝
    const g3 = grantOf(repo, [], { git_dir: path.join(repo, "not-the-git-dir") });
    const r3 = await run(g3);
    ok(r3.status === "refused" && r3.code === "GIT_DIR_INVALID", "⑯ git_dir 不符：拒绝", `${r3.status}/${r3.code}`);
  }

  // ── 用例 17：提交后核「原始字节」与「关联记录」可直接供宿主存证 ────────────────────
  {
    const repo = mkRepo("c17-association");
    write(path.join(repo, "mod.txt"), "base\n");
    baseCommit(repo);
    write(path.join(repo, "mod.txt"), "authorized\n");
    const grant = grantOf(repo, [entryOf(repo, "mod.txt", "modified")]);
    const res = await run(grant);
    ok(res.status === "committed", "⑰ 关联：提交成功", `${res.status}/${res.code}`);
    const a = res.association;
    ok(a !== null && a!.candidate_fingerprint === grant.candidate_fingerprint, "⑰ 关联：带候选内容指纹");
    ok(a !== null && eq(a!.evidence_refs.slice().sort(), ["ev-independent-audit-1", "ev-self-check-1"]), "⑰ 关联：只引用证据，不复制原证据");
    ok(a !== null && a!.base_head === grant.candidate_base_head, "⑰ 关联：带基准 HEAD");
    ok(a !== null && a!.blobs.length >= 1 && a!.blobs[0].raw_sha256 !== null, "⑰ 关联：带 raw/blob 指纹表");
    // 重复触发幂等：同一 finalize_id 再来一次仍是 reused，不产生第二个提交
    const fid = computeFinalizeId({
      project_id: grant.project_id,
      task_id: grant.task_id,
      workspace_id: grant.workspace_id,
      candidate_fingerprint: grant.candidate_fingerprint!,
      base_head: grant.candidate_base_head!,
    });
    const head = repoStateOf(repo);
    const again = await run(grant, { finalize_id: fid });
    ok(again.status === "reused" || again.status === "noop_up_to_date", "⑰ 重复触发：幂等", `${again.status}/${again.code}`);
    ok(repoStateOf(repo) === head, "⑰ 重复触发：HEAD 未变");
    const count = git(repo, ["rev-list", "--count", "HEAD"]).trim();
    ok(count === "2", "⑰ 重复触发：仓库只有 2 个提交（base + 本次）", count);
  }

  // ── 用例 18：同一仓库并发收尾 → 互斥拒绝，零副作用；慢 hook 不把收尾变成失败 ──────────
  {
    const repo = mkRepo("c18-concurrent");
    write(path.join(repo, "mod.txt"), "base\n");
    baseCommit(repo);
    write(path.join(repo, "mod.txt"), "authorized\n");
    // 真 hook：先落一个"已进入提交阶段"的标记，再睡一会儿，制造可观测的临界区
    installHook(repo, [`printf 'in\\n' > .git/entered.txt`, `sleep 1`, `exit 0`].join("\n"));
    const grant = grantOf(repo, [entryOf(repo, "mod.txt", "modified")]);
    const before = repoState(repo);

    const first = run(grant);
    // 等到 hook 真的跑起来（说明第一次调用已经进入锁内的提交阶段）
    let entered = false;
    for (let i = 0; i < 200 && !entered; i++) {
      entered = fs.existsSync(path.join(repo, ".git", "entered.txt"));
      if (!entered) await new Promise((r) => setTimeout(r, 10));
    }
    ok(entered, "⑱ 并发：第一次调用确实进入了提交阶段（hook 已运行）");
    const r2 = await run(grant);
    ok(r2.status === "refused" && r2.code === "CONCURRENT_BUSY", "⑱ 并发：第二次调用被互斥拒绝", `${r2.status}/${r2.code}`);
    ok(r2.commands.length === 0, "⑱ 并发：被拒时未执行任何 git 命令（零副作用）", String(r2.commands.length));
    const r1 = await first;
    ok(r1.status === "committed", "⑱ 并发：第一次调用正常完成（慢 hook 不算失败）", `${r1.status}/${r1.code}`);
    ok(r1.checks !== null && r1.checks.failures.length === 0, "⑱ 并发：第一次调用后验全过");
    ok(repoStateOf(repo) === r1.commit, "⑱ 并发：HEAD 正是第一次调用的提交");
    ok(before !== repoState(repo), "⑱ 并发：仅由第一次调用推进了仓库");
    const cnt = git(repo, ["rev-list", "--count", "HEAD"]).trim();
    ok(cnt === "2", "⑱ 并发：只产生了一个新提交", cnt);
  }

  // ── 用例 19：仓库规模档（~600 文件，对齐 git-probe §2.4 的 572/590 现场口径）────────────
  {
    const repo = mkRepo("c19-scale");
    for (let i = 0; i < 600; i++) {
      write(path.join(repo, "src", `mod-${String(i).padStart(3, "0")}.txt`), `payload ${i}\n`.repeat(200));
    }
    baseCommit(repo);
    write(path.join(repo, "src", "mod-300.txt"), "changed payload\n".repeat(200));
    const indexed = git(repo, ["ls-files"]).trim().split("\n").filter(Boolean).length;
    const grant = grantOf(repo, [entryOf(repo, "src/mod-300.txt", "modified")]);
    const t0 = Date.now();
    const res = await run(grant);
    const ms = Date.now() - t0;
    ok(res.status === "committed", "⑲ 规模档：提交成功", `${res.status}/${res.code}`);
    ok(res.checks !== null && res.checks.failures.length === 0, "⑲ 规模档：后验全过（含 600 文件工作区快照）");
    ok(indexed >= 600, "⑲ 规模档：夹具确有 600 个已跟踪文件", String(indexed));
    ok(res.commands.every((c) => !c.includes("-A") && !c.includes("--all")), "⑲ 规模档：未用 -A/--all");
    console.log(`[verify] INFO ⑲ 规模档：${indexed} 个已跟踪文件，一次收尾 ${ms}ms，实跑 git 命令 ${res.commands.length} 条`);
    ok(ms < 60_000, "⑲ 规模档：单次收尾在 60s 内（有界；超时是真超时）", `${ms}ms`);
  }

  // ── 用例 20：被忽略文件不算"范围外改动"（真实仓库的 node_modules/、.工作台/ 就是这一类）──────
  {
    const repo = mkRepo("c20-ignored");
    write(path.join(repo, ".gitignore"), "ignored.txt\nignored-dir/\n");
    write(path.join(repo, "mod.txt"), "base\n");
    baseCommit(repo);
    write(path.join(repo, "mod.txt"), "authorized\n");
    // 被忽略的未跟踪文件/目录：既不该进候选，也不该被算成未授权改动
    write(path.join(repo, "ignored.txt"), "noise\n");
    write(path.join(repo, "ignored-dir", "deep.txt"), "noise\n");
    const grant = grantOf(repo, [entryOf(repo, "mod.txt", "modified")]);
    const res = await run(grant);
    ok(res.status === "committed", "⑳ 被忽略文件：提交成功（忽略项不算范围外）", `${res.status}/${res.code}`);
    ok(res.checks !== null && res.checks.failures.length === 0, "⑳ 被忽略文件：后验全过");
    ok(fs.readFileSync(path.join(repo, "ignored.txt"), "utf8") === "noise\n", "⑳ 被忽略文件：现场未被动（未暂存、未删除）");
    const staged = git(repo, ["diff", "--cached", "--name-only"]).trim();
    ok(staged === "", "⑳ 被忽略文件：未进入暂存区", staged);
  }

  // ── 用例 21（GIT-R1 反例）：重试/复用必须证明**当前工作区仍是受验候选** ──────────────
  // 根因（独立复测发现）：旧实现在尾注命中后把 staged_unrelated_absent / candidate_bytes_match /
  // change_set_matches_workspace **直接置 true**，只重核旧提交本身，不核「现在的工作区是否仍等于受验候选」，
  // 于是「首次提交成功 → 新增未入候选的文件 → 相同 grant 重试」会得到 reused。
  {
    /** 先跑一次成功收尾，返回**同一个 grant**（重试用）与首个提交 */
    const committedFixture = async (name: string, extraBase: Record<string, string> = {}) => {
      const repo = mkRepo(name);
      for (const [p, c] of Object.entries(extraBase)) write(path.join(repo, p), c);
      write(path.join(repo, "a.txt"), "base\n");
      baseCommit(repo);
      write(path.join(repo, "a.txt"), "verified\n");
      const changes = [entryOf(repo, "a.txt", "modified")];
      const grant = grantOf(repo, changes, { full_index: fullIndexOf(repo) });
      const first = await run(grant);
      return { repo, grant, first };
    };

    // ㉑a 重试前新增未验 untracked 源文件（root 独立探针的最小复现）→ 明确拒绝，不产生新提交、不改现场
    {
      const { repo, grant, first } = await committedFixture("c21-replay-untracked");
      ok(first.status === "committed", "㉑a 前置：首次收尾成功", `${first.status}/${first.code}`);
      const head1 = repoStateOf(repo);
      write(path.join(repo, "unverified-extra.ts"), "new unverified source\n");
      const before = repoState(repo);
      const again = await run(grant);
      ok(again.status !== "reused" && again.status !== "committed", "㉑a 新增未验文件后重试：不得复用也不得提交", `${again.status}/${again.code}`);
      ok(again.code === "OUT_OF_SCOPE_CHANGE", "㉑a 稳定码点名为未授权改动", String(again.code));
      ok(again.accepted === false && again.commit === null, "㉑a accepted=false 且不报告提交");
      ok(repoStateOf(repo) === head1 && git(repo, ["rev-list", "--count", "HEAD"]).trim() === "2", "㉑a 未产生新提交");
      ok(repoState(repo) === before, "㉑a 零副作用：工作区/index/refs 原样");
      ok(fs.readFileSync(path.join(repo, "unverified-extra.ts"), "utf8") === "new unverified source\n", "㉑a 未验证文件未被删除/暂存");
      ok(again.checks !== null && again.checks.change_set_matches_workspace === false, "㉑a change_set_matches_workspace 如实为 false（不硬置 true）");
      ok(again.checks !== null && again.checks.candidate_bytes_match === true, "㉑a 已列受验路径仍一致时 candidate_bytes_match 如实为 true");
      fs.rmSync(path.join(repo, "unverified-extra.ts"));
      const third = await run(grant);
      ok(third.status === "reused" && third.accepted === true, "㉑a 移除未验文件后：复用既有提交", `${third.status}/${third.code}`);
      ok(third.commit === head1 && repoStateOf(repo) === head1, "㉑a 复用同一提交，HEAD 未再前进");
    }

    // ㉑b 不给 full_index 时同样拒绝（full_index 可选，不是「工作区仍等于候选」的完整资格）
    {
      const repo = mkRepo("c21b-replay-no-fullindex");
      write(path.join(repo, "a.txt"), "base\n");
      baseCommit(repo);
      write(path.join(repo, "a.txt"), "verified\n");
      const grant = grantOf(repo, [entryOf(repo, "a.txt", "modified")]);
      const first = await run(grant);
      ok(first.status === "committed", "㉑b 前置：首次收尾成功", `${first.status}/${first.code}`);
      const head1 = repoStateOf(repo);
      write(path.join(repo, "extra-untracked.txt"), "unverified\n");
      const again = await run(grant);
      ok(again.status !== "reused" && again.code === "OUT_OF_SCOPE_CHANGE", "㉑b 无 full_index 时同样拒绝复用", `${again.status}/${again.code}`);
      ok(repoStateOf(repo) === head1, "㉑b 未产生新提交");
    }

    // ㉑c 重试前多了一个**已跟踪**的未验改动 → 拒绝
    {
      const repo = mkRepo("c21c-replay-tracked-extra");
      write(path.join(repo, "a.txt"), "base\n");
      write(path.join(repo, "other.txt"), "other-base\n");
      baseCommit(repo);
      write(path.join(repo, "a.txt"), "verified\n");
      const grant = grantOf(repo, [entryOf(repo, "a.txt", "modified")]);
      const first = await run(grant);
      ok(first.status === "committed", "㉑c 前置：首次收尾成功", `${first.status}/${first.code}`);
      const head1 = repoStateOf(repo);
      write(path.join(repo, "other.txt"), "unverified tracked change\n");
      const before = repoState(repo);
      const again = await run(grant);
      ok(again.status !== "reused" && again.code === "OUT_OF_SCOPE_CHANGE", "㉑c 已跟踪未验改动：拒绝复用", `${again.status}/${again.code}`);
      ok(repoStateOf(repo) === head1 && repoState(repo) === before, "㉑c 未产生提交、未改现场");
    }

    // ㉑d 重试前有**额外已暂存**内容 → REFUSED_UNRELATED_STAGED，现场保留
    {
      const repo = mkRepo("c21d-replay-staged-extra");
      write(path.join(repo, "a.txt"), "base\n");
      baseCommit(repo);
      write(path.join(repo, "a.txt"), "verified\n");
      const grant = grantOf(repo, [entryOf(repo, "a.txt", "modified")]);
      const first = await run(grant);
      ok(first.status === "committed", "㉑d 前置：首次收尾成功", `${first.status}/${first.code}`);
      const head1 = repoStateOf(repo);
      write(path.join(repo, "staged-extra.txt"), "staged unverified\n");
      git(repo, ["add", "staged-extra.txt"]);
      const before = repoState(repo);
      const again = await run(grant);
      ok(again.status === "refused" && again.code === "REFUSED_UNRELATED_STAGED", "㉑d 额外已暂存：拒绝复用", `${again.status}/${again.code}`);
      ok(repoStateOf(repo) === head1, "㉑d 未产生新提交");
      ok(git(repo, ["diff", "--cached", "--name-only"]).includes("staged-extra.txt"), "㉑d 暂存内容保留（不 reset/不 restore）");
      ok(repoState(repo) === before, "㉑d 零副作用");
    }

    // ㉑e 重试前受验候选本身漂移（受验路径字节被改）→ CANDIDATE_TAMPERED，不产生新提交
    {
      const { repo, grant, first } = await committedFixture("c21e-replay-candidate-drift");
      ok(first.status === "committed", "㉑e 前置：首次收尾成功", `${first.status}/${first.code}`);
      const head1 = repoStateOf(repo);
      write(path.join(repo, "a.txt"), "FORGED-CONTENT\n");
      const again = await run(grant);
      ok(again.status !== "reused" && again.code === "CANDIDATE_TAMPERED", "㉑e 候选漂移：拒绝复用", `${again.status}/${again.code}`);
      ok(repoStateOf(repo) === head1, "㉑e 未产生新提交");
    }

    // ㉑f 被忽略的未跟踪文件不算候选漂移（口径是「非 ignored untracked」）→ 仍可复用
    {
      const { repo, grant, first } = await committedFixture("c21f-replay-ignored-extra", { ".gitignore": "noise.txt\n" });
      ok(first.status === "committed", "㉑f 前置：首次收尾成功", `${first.status}/${first.code}`);
      const head1 = repoStateOf(repo);
      write(path.join(repo, "noise.txt"), "ignored noise\n");
      const again = await run(grant);
      ok(again.status === "reused", "㉑f 被忽略的未跟踪文件：不算漂移，仍复用", `${again.status}/${again.code}`);
      ok(repoStateOf(repo) === head1, "㉑f HEAD 未变");
      ok(fs.readFileSync(path.join(repo, "noise.txt"), "utf8") === "ignored noise\n", "㉑f 被忽略文件现场保留");
    }

    // ㉑g 新增未验文件落在**新目录**里（真实开发里最常见的漂移形态）→ 同样必须拒绝
    {
      const { repo, grant, first } = await committedFixture("c21g-replay-untracked-nested");
      ok(first.status === "committed", "㉑g 前置：首次收尾成功", `${first.status}/${first.code}`);
      const head1 = repoStateOf(repo);
      write(path.join(repo, "src", "server", "work", "unverified-extra.ts"), "new unverified source\n");
      const before = repoState(repo);
      const again = await run(grant);
      ok(again.status !== "reused" && again.code === "OUT_OF_SCOPE_CHANGE", "㉑g 新目录里的未验文件：拒绝复用", `${again.status}/${again.code}`);
      ok(repoStateOf(repo) === head1 && repoState(repo) === before, "㉑g 未产生新提交、未改现场");
      ok(
        again.detail.out_of_scope !== undefined && String(again.detail.out_of_scope).includes("unverified-extra.ts"),
        "㉑g 点名未授权路径（含目录形式）",
        JSON.stringify(again.detail.out_of_scope),
      );
      fs.rmSync(path.join(repo, "src"), { recursive: true, force: true });
      const third = await run(grant);
      ok(third.status === "reused" && third.commit === head1, "㉑g 移除后仍可复用同一提交", `${third.status}/${third.code}`);
    }
  }

  // ── 用例 22（GIT-R1 反例）：只读枚举命令非零退出必须 fail closed（不得当空集合 → 假 noop/reused）──
  // 受控故障注入：把 GIT_INDEX_FILE 指向一个**仓库外**的损坏 index 文件，让 ls-files/status/diff 以真实
  // 非零退出失败（真 git 的正常路径不受影响），用于对照「模拟命令故障」与「真 Git 正常路径」。
  // 不用 PATH 假 git：本平台 `execFile(shell:false)` 只按 PATH 解析 `.exe`，`.cmd`/`.bat` 实测不被采用。
  {
    const withCorruptGitIndex = async <T>(fn: () => Promise<T>): Promise<T> => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-v0966-corrupt-index-"));
      const idx = path.join(dir, "corrupt.index");
      fs.writeFileSync(idx, "this-is-not-a-git-index");
      const prev = process.env.GIT_INDEX_FILE;
      process.env.GIT_INDEX_FILE = idx;
      try {
        return await fn();
      } finally {
        if (prev === undefined) delete process.env.GIT_INDEX_FILE;
        else process.env.GIT_INDEX_FILE = prev;
        fs.rmSync(dir, { recursive: true, force: true });
      }
    };
    const enumFailuresOf = (res: FinalizeResult): Array<Record<string, unknown>> => {
      const v = res.detail.enumeration_failures;
      return Array.isArray(v) ? (v as Array<Record<string, unknown>>) : [];
    };

    // ㉒a 普通路径：枚举失败 → 拒绝（不提交、不假 noop），并记录出错命令与 exit
    {
      const repo = mkRepo("c22-enum-fail-normal");
      write(path.join(repo, "a.txt"), "base\n");
      baseCommit(repo);
      write(path.join(repo, "a.txt"), "authorized\n");
      const grant = grantOf(repo, [entryOf(repo, "a.txt", "modified")]);
      const head0 = repoStateOf(repo);
      const before = repoState(repo);
      const res = await withCorruptGitIndex(() => run(grant));
      ok(res.status === "refused" && res.code === "GIT_ENUMERATION_FAILED", "㉒a 枚举失败：拒绝且稳定码", `${res.status}/${res.code}`);
      ok(res.accepted === false && res.commit === null, "㉒a 不报告提交");
      const fails = enumFailuresOf(res);
      ok(fails.length > 0, "㉒a detail 记录出错命令与 exit", JSON.stringify(fails.slice(0, 1)));
      const firstFail = fails[0] ?? {};
      ok(
        typeof firstFail.command === "string" && /(ls-files|status|diff)/.test(String(firstFail.command)),
        "㉒a 点名失败的枚举命令",
        String(firstFail.command),
      );
      ok(typeof firstFail.exit === "number" && firstFail.exit !== 0, "㉒a 记录真实非零 exit", String(firstFail.exit));
      ok(String(firstFail.stderr ?? "").length > 0, "㉒a 带真实 stderr（不是空集合）");
      ok(
        res.checks !== null &&
          res.checks.candidate_bytes_match === false &&
          res.checks.change_set_matches_workspace === false &&
          res.checks.staged_unrelated_absent === false &&
          res.checks.worktree_unchanged === false,
        "㉒a checks 未虚假置 true",
        JSON.stringify(res.checks),
      );
      ok(repoStateOf(repo) === head0 && repoState(repo) === before, "㉒a 零副作用：未提交/未改现场");
      ok(res.commands.some((c) => /(ls-files|status|diff)/.test(c)), "㉒a commands 记录了实际跑过的命令");
      // 对照：同一夹具同一 grant，去掉故障注入 → 真 Git 正常路径提交成功
      const res2 = await run(grant);
      ok(res2.status === "committed", "㉒a 对照：去掉故障注入后正常提交", `${res2.status}/${res2.code}`);
      ok(repoStateOf(repo) === res2.commit && repoStateOf(repo) !== head0, "㉒a 对照：HEAD 前进到本次提交");
    }

    // ㉒b 重试路径：枚举失败不得复用旧提交；故障消除后仍可复用
    {
      const repo = mkRepo("c22b-enum-fail-replay");
      write(path.join(repo, "a.txt"), "base\n");
      baseCommit(repo);
      write(path.join(repo, "a.txt"), "authorized\n");
      const grant = grantOf(repo, [entryOf(repo, "a.txt", "modified")]);
      const first = await run(grant);
      ok(first.status === "committed", "㉒b 前置：首次收尾成功", `${first.status}/${first.code}`);
      const head1 = repoStateOf(repo);
      const before = repoState(repo);
      const again = await withCorruptGitIndex(() => run(grant));
      ok(again.status !== "reused" && again.status !== "committed", "㉒b 重试遇枚举失败：不得复用旧提交", `${again.status}/${again.code}`);
      ok(again.code === "GIT_ENUMERATION_FAILED", "㉒b 稳定码 GIT_ENUMERATION_FAILED", String(again.code));
      ok(enumFailuresOf(again).length > 0, "㉒b 记录出错命令与 exit");
      ok(again.checks !== null && again.checks.change_set_matches_workspace === false, "㉒b checks 未虚假置 true");
      ok(repoStateOf(repo) === head1 && repoState(repo) === before, "㉒b 未产生新提交、未改现场");
      const third = await run(grant);
      ok(third.status === "reused" && third.commit === head1, "㉒b 对照：故障消除后仍可复用既有提交", `${third.status}/${third.code}`);
    }

    // ㉒c 枚举失败不得把「内容已在基准」误判成成功/假 noop
    {
      const repo = mkRepo("c22c-enum-fail-noop");
      write(path.join(repo, "a.txt"), "same-content\n");
      const base = baseCommit(repo);
      const grant = grantOf(repo, [entryOf(repo, "a.txt", "modified")]);
      const res = await withCorruptGitIndex(() => run(grant));
      ok(
        res.status !== "noop_up_to_date" && res.status !== "committed" && res.status !== "reused",
        "㉒c 枚举失败：不得假 noop/提交/复用",
        `${res.status}/${res.code}`,
      );
      ok(res.code === "GIT_ENUMERATION_FAILED", "㉒c 稳定码 GIT_ENUMERATION_FAILED", String(res.code));
      ok(repoStateOf(repo) === base, "㉒c HEAD 未前进");
      const res2 = await run(grant);
      ok(res2.status === "noop_up_to_date", "㉒c 对照：故障消除后如实 noop（内容已在基准）", `${res2.status}/${res2.code}`);
    }
  }

  // ── 收尾 ──────────────────────────────────────────────────────────────────────
  console.log(`\n[verify] 失败项：${failures}`);
  if (!KEEP) {
    fs.rmSync(FIXTURES, { recursive: true, force: true });
  } else {
    console.log(`[verify] TATAI_KEEP_TMP=1：保留夹具 ${FIXTURES}`);
  }
}

main().catch((e) => {
  console.error("[verify] 脚本异常：", e);
  process.exitCode = 1;
});
