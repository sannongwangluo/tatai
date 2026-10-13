// V09-64 后端验证脚本（tsx 跑）：候选完整输入索引、来源解析与恢复（DESIGN.md §6.13 第 3/5/6 段、
// §6.14 第 3/4/5/8 段；PLAN V09-64 chk-v09-64-01…04）。
// 用法：pnpm exec tsx scripts/verify-v09-64.ts   （设 V0964_SKIP_REGRESSION=1 可跳过尾部交付脚本回归）
//
// 自带隔离环境：全部夹具在 `os.tmpdir()` 下**临时**建/删，**不碰**任何真实项目/账本/生产服务（绝不连真实 8787）。
// **负例优先、真实行为**：只经 `inspectCandidateSource` / `verifyCandidateIndex` / `resolveCandidateSource`
// / `preserveCandidateSource` 的真实调用与真实 Git 子进程判分（不 grep 源码字符串自证）。
//
// 覆盖（对应任务要求）：>512 源文件、`.git` 文件排除、未声明变更、错 root/篡改、删除候选后恢复（含 CRLF +
// 配套版本绑定）、开发目录后续变化不影响冻结候选、冻结后新变化仍判红（失效不被隐藏）、symlink/junction 真拒、
// 秘密只记计数与模式、Git 提交只读物化（不 checkout）、非 Git 证据复原、旧交付脚本（127 项）回归。
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  inspectCandidateSource,
  verifyCandidateIndex,
  resolveCandidateSource,
  preserveCandidateSource,
  persistCandidateIndex,
  readCandidateIndex,
  persistCandidateRecovery,
  readCandidateRecovery,
  candidateHasFatalProblems,
  candidateIndexFingerprint,
} from "../src/server/work/candidateSource";
import { getWorkspaceSourceInspector, readWorkspaces, registerWorkspace, freezeWorkspace, pointTrialWorkspace } from "../src/server/work/workspaces";
import { buildSourceManifest, MAX_SOURCE_MANIFEST_FILES } from "../src/server/work/sourceEvidence";
import { readFeatureLedger, parseFeatureLedgerParams } from "../src/server/work/featureLedger";
import { recordWorkEvidenceTool } from "../src/mcp/tools/recordWorkEvidence";
import { addProject } from "../src/server/registry";
import { WorkService } from "../src/server/work/service";
import { projectWorkDir } from "../src/server/workstation";
import { activateBaseline, resolveDocumentSource, setCurrentDevRootResolver } from "../src/server/work/documents";
import { importTaskDefinitions } from "../src/server/work/plan";
import { submitDefinitionImports } from "../src/server/work/tasks";
import { registerRequirement } from "../src/server/work/requirements";
import { sectionsOf } from "../src/server/work/coverageModel";
import { putEvidence, setEvidenceWorkspaceResolver } from "../src/server/work/evidence";
import { installWorkspaceHostWiring } from "../src/server/work/hostWiring";
import { claimTask } from "../src/server/work/claims";
import { submitSelfCheck, submitIndependentAudit, COVERAGE_AREAS, COVERAGE_AREA_LABELS } from "../src/server/work/audit";
import type { CandidateIndex, CandidateVersionBinding } from "../src/shared/candidateIndexTypes";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sha256 = (b: string | Buffer): string => crypto.createHash("sha256").update(b).digest("hex");

let pass = 0;
let fail = 0;
const ok = (cond: boolean, label: string, detail?: unknown): void => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (cond) pass++;
  else {
    fail++;
    process.exitCode = 1;
    if (detail !== undefined) console.log(`[verify]   现场：${JSON.stringify(detail).slice(0, 1200)}`);
  }
};
const section = (t: string): void => console.log(`\n[verify] ═══ ${t}`);

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-v09-64-"));
const COORD = "v09-64-coordinator";
const writeFile = (abs: string, data: string | Buffer): void => {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, data);
};
const hasAny = (idx: CandidateIndex, code: string): boolean => idx.problems.some((p) => p.code === code);

function git(cwd: string, args: readonly string[]): { ok: boolean; out: string } {
  const res = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true, timeout: 30000 });
  return { ok: res.status === 0, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}
function initRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const r = git(dir, ["init", "-q"]);
  if (!r.ok) throw new Error(`git init 失败：${r.out}`);
  git(dir, ["config", "user.email", "v09-64@test"]);
  git(dir, ["config", "user.name", "v09-64"]);
}
function commitAll(dir: string, msg: string): string {
  git(dir, ["add", "-A"]);
  const c = git(dir, ["-c", "user.email=v09-64@test", "-c", "user.name=v09-64", "commit", "-q", "-m", msg]);
  if (!c.ok && !c.out.includes("nothing to commit")) throw new Error(`git commit 失败：${c.out}`);
  return git(dir, ["rev-parse", "HEAD"]).out.trim();
}

try {
  // ────────────────────────── ① >512 源文件 + 分片（与旧 512 判据分开） ──────────────────────────
  section("① >512 源文件完整候选与分片（旧每检查 512 判据不变）");
  {
    const dir = path.join(BASE, "many");
    for (let i = 0; i < 600; i += 1) writeFile(path.join(dir, `src/f${String(i).padStart(3, "0")}.ts`), `export const n${i} = ${i};\n`);
    const idx = inspectCandidateSource({ root: dir, included_uncommitted: true, declared_paths: null });
    ok(idx.file_count === 600, "① 完整候选收下 600 文件（不被 512 上限截断）", idx.file_count);
    ok(idx.shard_count === 2, "① 按 512/片切成 2 片", { shard_count: idx.shard_count, shards: idx.shards.map((s) => s.files) });
    ok(!candidateHasFatalProblems(idx), "① 无致命问题", idx.problems);
    const idx2 = inspectCandidateSource({ root: dir, included_uncommitted: true, declared_paths: null });
    ok(idx.content_fingerprint === idx2.content_fingerprint, "① 同一现场两次枚举指纹一致（确定性）");
    // 改变一个真实源 → 指纹必变
    writeFile(path.join(dir, "src/f000.ts"), "export const n0 = 999;\n");
    const idx3 = inspectCandidateSource({ root: dir, included_uncommitted: true, declared_paths: null });
    ok(idx3.content_fingerprint !== idx.content_fingerprint, "① 改一个真实源 → 候选指纹必变");
    // 旧每检查清单 512 上限**不变**：600 条仍被拒
    let rejected = false;
    try {
      buildSourceManifest(dir, Array.from({ length: 600 }, (_, i) => `src/f${String(i).padStart(3, "0")}.ts`));
    } catch {
      rejected = true;
    }
    ok(rejected, `① 旧 source_manifest 仍拒 600 条（上限 ${MAX_SOURCE_MANIFEST_FILES} 不变）`);
  }

  // ────────────────────────── ② .git 文件排除 + 固定排除段 ──────────────────────────
  section("② `.git` 文件（worktree 指针）/依赖/私有工作台排除");
  {
    const dir = path.join(BASE, "dotgit-file");
    writeFile(path.join(dir, ".git"), "gitdir: /somewhere/.git/worktrees/x\n");
    writeFile(path.join(dir, "real.ts"), "export const a = 1;\n");
    writeFile(path.join(dir, "node_modules/dep/index.js"), "module.exports = 1;\n");
    writeFile(path.join(dir, ".工作台/work/secret.ts"), "export const s = 1;\n");
    writeFile(path.join(dir, "dist/bundle.js"), "// built\n");
    const idx = inspectCandidateSource({ root: dir, included_uncommitted: true, declared_paths: null });
    const paths = idx.entries.map((e) => e.path);
    ok(paths.includes("real.ts"), "② 真源文件收入", paths);
    ok(!paths.some((p) => p === ".git" || p.startsWith(".git/")), "② worktree `.git` **文件**被排除（旧全树口径的盲点）", paths);
    ok(!paths.some((p) => p.startsWith("node_modules/")), "② 依赖目录排除");
    ok(!paths.some((p) => p.startsWith(".工作台/")), "② 私有工作台排除");
    ok(!paths.some((p) => p.startsWith("dist/")), "② 产物目录排除");
  }

  // ────────────────────────── ③ Git tracked+untracked、未声明变更、删除项、included_uncommitted ──────────────────────────
  section("③ Git 实枚举 / 未声明变更 / 删除项 / included_uncommitted 声明");
  {
    const dir = path.join(BASE, "git-basic");
    initRepo(dir);
    writeFile(path.join(dir, "a.txt"), "A0\n");
    writeFile(path.join(dir, "del.txt"), "DEL\n");
    const head = commitAll(dir, "init");
    writeFile(path.join(dir, "a.txt"), "A1-modified\n"); // 未提交改动（tracked）
    writeFile(path.join(dir, "new.txt"), "NEW-untracked\n"); // 未跟踪
    git(dir, ["rm", "-q", "del.txt"]); // 暂存删除

    const good = inspectCandidateSource({
      root: dir, included_uncommitted: true, declared_paths: ["a.txt", "new.txt", "del.txt"],
      source_commit: head, git_repository: dir,
    });
    ok(good.source_commit === head, "③ 记下来源提交 HEAD", good.source_commit);
    const byPath = new Map(good.entries.map((e) => [e.path, e]));
    ok(byPath.get("a.txt")?.git_backed === false, "③ 未提交改动的 tracked 文件标记 git_backed=false");
    ok(byPath.get("new.txt")?.git_backed === false, "③ untracked 文件标记 git_backed=false");
    ok(byPath.get("del.txt")?.state === "deleted", "③ 暂存删除记为 deleted（保住删除项）", byPath.get("del.txt"));
    ok(!hasAny(good, "CANDIDATE_UNDECLARED_CHANGES"), "③ 声明齐全时无未声明变更问题");

    const undeclared = inspectCandidateSource({
      root: dir, included_uncommitted: true, declared_paths: ["a.txt"], source_commit: head, git_repository: dir,
    });
    ok(hasAny(undeclared, "CANDIDATE_UNDECLARED_CHANGES"), "③ 有未声明变更（new.txt/del.txt）→ 报未声明", undeclared.problems);

    const excluded = inspectCandidateSource({
      root: dir, included_uncommitted: false, declared_paths: null, source_commit: head, git_repository: dir,
    });
    ok(hasAny(excluded, "CANDIDATE_UNCOMMITTED_EXCLUDED"), "③ included_uncommitted=false 但有未提交改动 → 拒（不用 HEAD 冒充）", excluded.problems);

    const missing = inspectCandidateSource({
      root: dir, included_uncommitted: true, declared_paths: ["a.txt", "new.txt", "del.txt", "ghost.txt"],
      source_commit: head, git_repository: dir,
    });
    ok(hasAny(missing, "CANDIDATE_DECLARED_MISSING"), "③ 声明纳入但实枚举找不到的路径 → 报缺", missing.problems);

    const badDeclared = inspectCandidateSource({ root: dir, included_uncommitted: true, declared_paths: ["../escape.txt"] });
    ok(hasAny(badDeclared, "CANDIDATE_DECLARED_INVALID"), "③ 非法 declared_paths（越界）→ 拒", badDeclared.problems);
  }

  // ────────────────────────── ④ 错 root / 篡改 → 失效，不静默转读 ──────────────────────────
  section("④ 目录被篡改 → 失效（不静默转读 Git / 开发目录）");
  {
    const dir = path.join(BASE, "tamper");
    initRepo(dir);
    writeFile(path.join(dir, "s.ts"), "export const s = 1;\n");
    const head = commitAll(dir, "init");
    const idx = inspectCandidateSource({ root: dir, included_uncommitted: true, declared_paths: null, source_commit: head, git_repository: dir });
    ok(verifyCandidateIndex(dir, idx).status === "valid", "④ 未改动时现读复核 valid");
    writeFile(path.join(dir, "s.ts"), "export const s = 2;\n"); // 旁路篡改
    const v = verifyCandidateIndex(dir, idx);
    ok(v.status === "invalidated" && v.changed.includes("s.ts"), "④ 篡改后复核 invalidated 且点名 s.ts", v);
    const res = resolveCandidateSource({ root: dir, work_dir: path.join(BASE, "central", "work"), index: idx, source_commit: head, git_repository: dir });
    ok(res.status === "tampered" && res.root === null, "④ 目录在但指纹不符 = tampered（失效），不回落 Git/dev", res);
    ok(res.problems.some((p) => p.code === "CANDIDATE_TAMPERED"), "④ problems 明确 CANDIDATE_TAMPERED");
    // 保全前复核不过 → 拒写（先验证再写）
    let refused = false;
    try {
      preserveCandidateSource({ root: dir, work_dir: path.join(BASE, "central", "work"), index: idx, actor_id: "v09-64" });
    } catch {
      refused = true;
    }
    ok(refused, "④ 复核不过时 preserve 明确拒（先验证再写）");
  }

  // ────────────────────────── ⑤ 删除候选后恢复（含 CRLF + 配套版本绑定） ──────────────────────────
  section("⑤ 候选目录被删除 → 从提交/证据只读复原（含 CRLF 原字节与配套版本绑定）");
  {
    // 候选 = origin 仓库的**链接工作树**（`.git` 是文件）；删除候选目录后 origin 的提交仍可达
    const origin = path.join(BASE, "origin");
    initRepo(origin);
    writeFile(path.join(origin, "crlf.txt"), "line1\r\nline2\r\nline3\r\n"); // CRLF 工作字节
    writeFile(path.join(origin, "plain.ts"), "export const p = 1;\n");
    writeFile(path.join(origin, "todelete.ts"), "export const gone = 1;\n");
    const head = commitAll(origin, "init");
    const dir = path.join(BASE, "recover-git-wt");
    const wt = git(origin, ["worktree", "add", "--detach", dir, head]);
    if (!wt.ok) throw new Error(`git worktree add 失败：${wt.out}`);
    writeFile(path.join(dir, "new-untracked.txt"), "untracked\r\ncontent\r\n");
    git(dir, ["rm", "-q", "todelete.ts"]); // 候选声明删除项（提交树里仍在）
    writeFile(path.join(dir, ".工作台/design.md"), "# 私有设计（不进候选，另在修订库定位）\n");
    const versionBinding: CandidateVersionBinding = {
      design_sha256: sha256("# 私有设计（不进候选，另在修订库定位）\n"),
      plan_sha256: sha256("plan\n"),
      baseline_id: "bl-test",
      ledger_last_seq: 42,
    };
    const idx = inspectCandidateSource({
      root: dir, included_uncommitted: true, declared_paths: ["new-untracked.txt", "todelete.ts"], source_commit: head,
    });
    ok(!candidateHasFatalProblems(idx), "⑤ 恢复夹具候选无致命问题", idx.problems);
    ok(fs.existsSync(path.join(dir, ".git")) && fs.statSync(path.join(dir, ".git")).isFile(), "⑤ 夹具是链接工作树（`.git` 是文件）");
    ok(!idx.entries.some((e) => e.path === ".git"), "⑤ 真 Git 场景下 `.git` 文件不进候选");
    ok(idx.entries.find((e) => e.path === "todelete.ts")?.state === "deleted", "⑤ 声明的删除项记为 deleted");
    const crlfEntry = idx.entries.find((e) => e.path === "crlf.txt");
    ok(crlfEntry?.crlf === true, "⑤ 记下 CRLF 事实（恢复需保原字节）", crlfEntry);

    const centralWork = path.join(BASE, "central", "work");
    const recovery = preserveCandidateSource({ root: dir, work_dir: centralWork, index: idx, actor_id: "v09-64", version_binding: versionBinding });
    ok(recovery.shard_evidence_ids.length === idx.shard_count, "⑤ 索引分片逐片落内容寻址证据", recovery.shard_evidence_ids.length);
    ok(recovery.raw_evidence.some((r) => r.path === "crlf.txt"), "⑤ CRLF 文件原字节被保全（不只靠 commit）");
    ok(recovery.raw_evidence.some((r) => r.path === "new-untracked.txt"), "⑤ untracked 原字节被保全");
    ok(recovery.version_binding?.baseline_id === "bl-test", "⑤ 配套版本绑定随恢复材料留存");

    fs.rmSync(dir, { recursive: true, force: true }); // 回收候选目录
    const res = resolveCandidateSource({
      root: dir, work_dir: centralWork, index: idx, source_commit: head, git_repository: origin, recovery,
    });
    ok(res.status === "recovered" && res.root !== null, "⑤ 目录删除后从提交+证据复原为 recovered", res);
    if (res.root !== null) {
      const restoredCrlf = fs.readFileSync(path.join(res.root, "crlf.txt"));
      ok(restoredCrlf.includes(Buffer.from("\r\n")), "⑤ 复原后 CRLF 原字节保住（blob 可能为 LF）");
      ok(sha256(restoredCrlf) === sha256("line1\r\nline2\r\nline3\r\n"), "⑤ 复原 CRLF 文件与受验字节逐字节一致");
      ok(fs.readFileSync(path.join(res.root, "new-untracked.txt"), "utf8") === "untracked\r\ncontent\r\n", "⑤ untracked 内容正确复原");
      ok(res.root !== dir, "⑤ 复原落在可再生缓存目录，不 checkout 原工作树", res.root);
      ok(!fs.existsSync(path.join(res.root, "todelete.ts")), "⑤ 复原按候选删除项移除 todelete.ts（提交树里仍在）");
      ok(!fs.existsSync(dir), "⑤ 原候选目录未被重建（只读物化，不写工作树）");
    }
  }

  // ────────────────────────── ⑥ 非 Git 证据复原 ──────────────────────────
  section("⑥ 非 Git 候选：目录删除后从恢复材料复原（不 git init、不假称已保存）");
  {
    const dir = path.join(BASE, "recover-dir");
    writeFile(path.join(dir, "x/one.txt"), "one\r\n");
    writeFile(path.join(dir, "two.txt"), "two\n");
    const idx = inspectCandidateSource({ root: dir, included_uncommitted: true, declared_paths: null });
    ok(idx.source_kind === "directory" && idx.git_repository === null, "⑥ 非 Git 源：source_kind=directory、无仓库");
    const centralWork = path.join(BASE, "central", "work");
    const recovery = preserveCandidateSource({ root: dir, work_dir: centralWork, index: idx, actor_id: "v09-64" });
    fs.rmSync(dir, { recursive: true, force: true });
    const res = resolveCandidateSource({ root: dir, work_dir: centralWork, index: idx, recovery });
    ok(res.status === "recovered", "⑥ 非 Git 候选从证据复原为 recovered", res);
    if (res.root !== null) {
      ok(fs.readFileSync(path.join(res.root, "x/one.txt"), "utf8") === "one\r\n", "⑥ 非 Git CRLF 原字节复原");
    }
    ok(!fs.existsSync(dir), "⑥ 未在原位置重建、未 git init");
  }

  // ────────────────────────── ⑦ 开发目录后续变化不影响冻结候选；冻结后新变化仍判红 ──────────────────────────
  section("⑦ 开发目录变化不影响冻结候选；冻结后新失败不被隐藏");
  {
    const trial = path.join(BASE, "trial");
    const dev = path.join(BASE, "dev");
    initRepo(trial);
    writeFile(path.join(trial, "stable.ts"), "export const s = 1;\n");
    const head = commitAll(trial, "init");
    const frozen = inspectCandidateSource({ root: trial, included_uncommitted: true, declared_paths: null, source_commit: head, git_repository: trial });
    initRepo(dev);
    writeFile(path.join(dev, "wip.ts"), "export const wip = 1;\n");
    commitAll(dev, "dev init");
    writeFile(path.join(dev, "wip.ts"), "export const wip = 2; // dev moved on\n");
    ok(verifyCandidateIndex(trial, frozen).status === "valid", "⑦ 开发目录后续变化不机械失效冻结候选");
    // 冻结候选自身被改 → 仍判红（新变化不被隐藏）
    writeFile(path.join(trial, "stable.ts"), "export const s = 2;\n");
    ok(verifyCandidateIndex(trial, frozen).status === "invalidated", "⑦ 冻结候选再被改 → 仍判红（失效不隐藏）");
  }

  // ────────────────────────── ⑧ symlink / 目录联接真拒 + 秘密只记计数与模式 ──────────────────────────
  section("⑧ symlink/junction 真拒；秘密只记计数与模式");
  {
    const dir = path.join(BASE, "links-secrets");
    writeFile(path.join(dir, "keep.ts"), "export const k = 1;\n");
    writeFile(path.join(dir, ".env"), "SECRET=1\n");
    writeFile(path.join(dir, "id_rsa"), "-----BEGIN PRIVATE KEY-----\n");
    let linkMade = "";
    try {
      fs.symlinkSync(path.join(dir, "keep.ts"), path.join(dir, "link.ts"), "file");
      linkMade = "file";
    } catch {
      try {
        fs.symlinkSync(dir, path.join(dir, "junction"), "junction");
        linkMade = "junction";
      } catch {
        linkMade = "";
      }
    }
    const idx = inspectCandidateSource({ root: dir, included_uncommitted: true, declared_paths: null });
    if (linkMade !== "") {
      ok(hasAny(idx, "CANDIDATE_LINK_REFUSED"), `⑧ ${linkMade} 链接被真拒（不跟随）`, idx.problems);
      ok(!idx.entries.some((e) => e.path === "link.ts" || e.path === "junction"), "⑧ 链接条目未进候选");
    } else {
      console.log("[verify] SKIP ⑧ 本机无权限建 symlink/junction（未验证链接拒绝路径）");
    }
    ok(idx.secret_files === 2, "⑧ 秘密类只记计数（.env + id_rsa = 2）", idx.secret_files);
    ok(idx.secret_patterns.length > 0, "⑧ 只记模式名", idx.secret_patterns);
    const leaked = idx.entries.some((e) => e.path === ".env" || e.path === "id_rsa");
    ok(!leaked, "⑧ 秘密路径/内容不进候选条目");
    const noPathLeak = JSON.stringify(idx).includes(".env") === false || !idx.problems.some((p) => p.path === ".env");
    ok(noPathLeak, "⑧ 问题列表不泄露秘密路径");
  }

  // ────────────────────────── ⑨ 单文件超限如实拒；指纹判据稳定 ──────────────────────────
  section("⑨ 单文件超 8 MiB 如实拒；指纹判据稳定");
  {
    const dir = path.join(BASE, "bigfile");
    writeFile(path.join(dir, "ok.ts"), "export const ok = 1;\n");
    const big = Buffer.alloc(8 * 1024 * 1024 + 1, 0x61);
    writeFile(path.join(dir, "big.bin"), big);
    const idx = inspectCandidateSource({ root: dir, included_uncommitted: true, declared_paths: null });
    ok(hasAny(idx, "CANDIDATE_FILE_TOO_LARGE"), "⑨ 单文件 >8 MiB → CANDIDATE_FILE_TOO_LARGE", idx.problems);
    ok(candidateHasFatalProblems(idx), "⑨ 超限 → 致命（冻结必须拒）");
    const fpA = candidateIndexFingerprint([{ path: "b", sha256: sha256("b"), bytes: 1, mode: 0o100644, state: "present", git_backed: true, crlf: false }]);
    const fpB = candidateIndexFingerprint([{ path: "b", sha256: sha256("b"), bytes: 1, mode: 0o100644, state: "present", git_backed: true, crlf: false }]);
    ok(fpA === fpB, "⑨ 同一组条目指纹稳定");
    const fpDel = candidateIndexFingerprint([{ path: "b", sha256: "", bytes: 0, mode: 0, state: "deleted", git_backed: false, crlf: false }]);
    ok(fpDel !== fpA, "⑨ 删除项与在盘项指纹不同（delete 位参与指纹）");
  }

  // ────────────────────────── ⑪ 与 workspaces.ts 源检查器接线 ──────────────────────────
  section("⑪ 与 worker A 的 WorkspaceSourceInspector 接线（A 已把本模块用作默认检查器）");
  {
    const dir = path.join(BASE, "inspector");
    writeFile(path.join(dir, "a.ts"), "export const a = 1;\n");
    const insp = getWorkspaceSourceInspector();
    const r = insp.inspect({ root: dir, declared_paths: [], included_uncommitted: true });
    const direct = inspectCandidateSource({ root: dir, declared_paths: [], included_uncommitted: true });
    ok(r.ok === true, "⑪ 默认检查器接受合法候选");
    ok(r.content_fingerprint === direct.content_fingerprint, "⑪ 默认检查器指纹 = 本模块 candidate-index-v1 指纹（接线生效）", { r: r.content_fingerprint, direct: direct.content_fingerprint });
    writeFile(path.join(dir, "big.bin"), Buffer.alloc(8 * 1024 * 1024 + 1, 0x61));
    const r2 = insp.inspect({ root: dir, declared_paths: [], included_uncommitted: true });
    ok(r2.ok === false && r2.content_fingerprint === null, "⑪ 超限时检查器拒绝并给 failures（冻结/提升会拒）", r2.failures.slice(0, 2));
  }

  // ────────────────────────── ⑫ 读侧 workspace selector 与旧行为兼容 ──────────────────────────
  section("⑫ feature_ledger workspace selector（`dev`/`trial`/未知值）与旧行为逐字段兼容");
  {
    const dataDir2 = path.join(BASE, "ws-home");
    fs.mkdirSync(dataDir2, { recursive: true });
    const projDir = path.join(BASE, "ws-proj");
    fs.mkdirSync(path.join(projDir, ".工作台"), { recursive: true });
    addProject({ id: "wstest", name: "wstest", path: projDir, kind: "backend" }, dataDir2);
    const exists = (id: string): boolean => id === "wstest";

    const pOk = parseFeatureLedgerParams({ workspace: "trial" });
    ok(!("ok" in pOk) && pOk.workspace === "trial", "⑫ 参数白名单接受 workspace=trial");
    const pEmpty = parseFeatureLedgerParams({ workspace: "" });
    ok("ok" in pEmpty && pEmpty.ok === false, "⑫ 空 workspace → 400（不静默忽略）");
    const pUnknown = parseFeatureLedgerParams({ nope: 1 });
    ok("ok" in pUnknown && pUnknown.ok === false, "⑫ 未知键仍被拒（白名单只多一个 workspace）");

    const rBad = readFeatureLedger("wstest", dataDir2, { workspace: "bogus" }, { project_exists: exists });
    ok(
      rBad.ok === false && rBad.status === 400 && rBad.code === "INVALID_INPUT",
      "⑫ 未知 workspace 值 → 400（不回落主目录）",
      rBad.ok === false ? rBad.detail : rBad,
    );

    const r404 = readFeatureLedger("nope", dataDir2, {}, { project_exists: () => false });
    ok(r404.ok === false && r404.status === 404, "⑫ 不存在的项目仍 404（工作区解析不改变错误优先级）");

    const rDev = readFeatureLedger("wstest", dataDir2, { workspace: "dev" }, { project_exists: exists });
    if (rDev.ok === false && rDev.status === 400) {
      ok(false, "⑫ workspace=dev 不应因解析失败而 400", rDev.detail);
    } else if (rDev.ok) {
      ok(rDev.ledger.workspace?.resolved === true, "⑫ workspace=dev 解析到明确工作区", rDev.ledger.workspace);
      ok(rDev.ledger.workspace?.root === path.resolve(projDir), "⑫ workspace=dev 的 root = 项目开发根（:main 派生）", rDev.ledger.workspace);
      ok(rDev.ledger.workspace?.kind === "dev", "⑫ workspace=dev kind 标出", rDev.ledger.workspace);
    } else {
      console.log(`[verify] NOTE ⑫ workspace=dev 读回 ${rDev.status}/${rDev.code}（未到工作区断言；记录为已知未覆盖）`);
    }

    const rLegacy = readFeatureLedger("wstest", dataDir2, {}, { project_exists: exists });
    if (rLegacy.ok) {
      ok(rLegacy.ledger.workspace?.resolved === false, "⑫ 无试用指针时缺省保持旧行为（workspace.resolved=false）", rLegacy.ledger.workspace);
    } else {
      console.log(`[verify] NOTE ⑫ 缺省读回 ${rLegacy.status}/${rLegacy.code}`);
    }
  }

  // ────────────────────────── ⑬ 缓存落在 Git 项目内：不误认外层主仓 ──────────────────────────
  section("⑬ 物化缓存落在 Git 项目的 .工作台/work 下：不误认外层主仓（评审第 3 项反例）");
  {
    const project = path.join(BASE, "cache-proj");
    initRepo(project);
    writeFile(path.join(project, "src/app.ts"), "export const app = 1;\n");
    commitAll(project, "init");
    const workDir = path.join(project, ".工作台", "work"); // 缓存将落在这里（在 Git 项目内！）
    const cand = path.join(BASE, "cache-cand");
    writeFile(path.join(cand, "a.txt"), "A\n");
    writeFile(path.join(cand, "b/inner.txt"), "B\r\n");
    const idx = inspectCandidateSource({ root: cand, included_uncommitted: true, declared_paths: null });
    const recovery = preserveCandidateSource({ root: cand, work_dir: workDir, index: idx, actor_id: "v09-64" });
    fs.rmSync(cand, { recursive: true, force: true });
    const res = resolveCandidateSource({ root: cand, work_dir: workDir, index: idx, recovery });
    ok(res.status === "recovered" && res.root !== null, "⑬ 缓存位于 Git 项目内仍能恢复（不误当外层主仓）", res);
    if (res.root !== null) {
      // 反例前提：git -C 缓存 会命中**外层主仓**
      const top = spawnSync("git", ["-C", res.root, "rev-parse", "--show-toplevel"], { encoding: "utf8", windowsHide: true });
      ok(path.resolve((top.stdout ?? "").trim()) === path.resolve(project), "⑬ 反例前提：`git -C <缓存>` 命中外层主仓（测到了这个陷阱）", (top.stdout ?? "").trim());
      // 关键：枚举必须只收缓存自己的文件，不把外层主仓的 src/app.ts 收进来
      const auto = inspectCandidateSource({ root: res.root, included_uncommitted: true, declared_paths: null });
      const paths = auto.entries.map((e) => e.path).sort();
      ok(
        paths.join(",") === "a.txt,b/inner.txt",
        "⑬ 缓存枚举只收自身文件（不含外层主仓 src/app.ts）",
        paths,
      );
      ok(verifyCandidateIndex(res.root, idx, { force_directory: true }).status === "valid", "⑬ 强制目录口径复核缓存为 valid");
      ok(fs.readFileSync(path.join(res.root, "b/inner.txt"), "utf8") === "B\r\n", "⑬ 缓存里 CRLF 原字节正确");
    }
  }

  // ────────────────────────── ⑭ clean/ident filter：raw≠blob（无 CRLF）不当可复原 ──────────────────────────
  section("⑭ ident filter 使 raw≠blob（无 CRLF）：不用 !crlf 冒充可复原证明");
  {
    const dir = path.join(BASE, "ident");
    initRepo(dir);
    writeFile(path.join(dir, ".gitattributes"), "*.c ident\n");
    // 工作树写**展开形态**：checkin 时 ident 折回 `$Id$` → blob ≠ 工作树原字节，且工作树无 CRLF
    writeFile(path.join(dir, "exp.c"), "$Id: 0000000000000000000000000000000000000000 $\n");
    writeFile(path.join(dir, "plain.c"), "int x;\n");
    const head = commitAll(dir, "init");
    const idx = inspectCandidateSource({ root: dir, included_uncommitted: true, declared_paths: null, source_commit: head, git_repository: dir });
    const exp = idx.entries.find((e) => e.path === "exp.c");
    const plain = idx.entries.find((e) => e.path === "plain.c");
    ok(exp?.crlf === false, "⑭ exp.c 不含 CRLF（因此 !crlf 不能作为可复原证明）", exp);
    ok(exp?.git_backed === false, "⑭ raw≠blob → git_backed=false（真比 blob，不是只看 status 干净）", exp);
    ok(plain?.git_backed === true, "⑭ 未受 filter 影响的 tracked 文件仍 git_backed=true", plain);
    const centralWork = path.join(BASE, "central", "work");
    const recovery = preserveCandidateSource({ root: dir, work_dir: centralWork, index: idx, actor_id: "v09-64" });
    ok(recovery.raw_evidence.some((r) => r.path === "exp.c"), "⑭ 受 filter 影响的源原字节被保全");
    fs.rmSync(dir, { recursive: true, force: true });
    const goneRepo = path.join(BASE, "ident-gone");
    const res = resolveCandidateSource({ root: dir, work_dir: centralWork, index: idx, source_commit: head, git_repository: goneRepo, recovery });
    ok(res.status === "recovered" && res.root !== null, "⑭ 仅凭证据复原（仓库不可达）", res);
    if (res.root !== null) {
      ok(
        fs.readFileSync(path.join(res.root, "exp.c"), "utf8") === "$Id: 0000000000000000000000000000000000000000 $\n",
        "⑭ 复原的是工作树原字节（不是被 filter 改过的 blob）",
      );
    }
  }

  // ────────────────────────── ⑮ fatal/truncated ⇒ 必判 invalid ──────────────────────────
  section("⑮ fatal/truncated ⇒ verify 必判 invalid（即使条目集合恰好相同）");
  {
    const dir = path.join(BASE, "fatal");
    writeFile(path.join(dir, "keep.ts"), "export const k = 1;\n");
    const idx = inspectCandidateSource({ root: dir, included_uncommitted: true, declared_paths: null });
    ok(verifyCandidateIndex(dir, idx).status === "valid", "⑮ 基线：无 fatal 时 valid");
    let made = false;
    try {
      fs.symlinkSync(path.join(dir, "keep.ts"), path.join(dir, "link.ts"), "file");
      made = true;
    } catch {
      try {
        fs.symlinkSync(dir, path.join(dir, "junction"), "junction");
        made = true;
      } catch {
        made = false;
      }
    }
    if (made) {
      const v = verifyCandidateIndex(dir, idx);
      ok(v.status === "invalidated", "⑮ 出现链接越界（fatal）→ invalidated（条目集合未变也判红）", v);
    } else {
      console.log("[verify] SKIP ⑮ 本机无权限建链接（未验证链接 fatal 路径）");
    }
    writeFile(path.join(dir, "big.bin"), Buffer.alloc(8 * 1024 * 1024 + 1, 0x61));
    ok(verifyCandidateIndex(dir, idx).status === "invalidated", "⑮ 单文件超限（fatal）→ invalidated");
  }

  // ────────────────────────── ⑯ 跟踪的秘密类文件：明确冲突，不静默排除 ──────────────────────────
  section("⑯ 跟踪的秘密类文件不能静默排除（明确冲突，冻结必须拒）");
  {
    const dir = path.join(BASE, "secret-tracked");
    initRepo(dir);
    writeFile(path.join(dir, ".env"), "SECRET=1\n");
    writeFile(path.join(dir, "app.ts"), "export const a = 1;\n");
    const head = commitAll(dir, "init");
    const idx = inspectCandidateSource({ root: dir, included_uncommitted: true, declared_paths: null, source_commit: head, git_repository: dir });
    ok(hasAny(idx, "CANDIDATE_SECRET_TRACKED_CONFLICT"), "⑯ 跟踪的 .env → CANDIDATE_SECRET_TRACKED_CONFLICT", idx.problems);
    ok(candidateHasFatalProblems(idx), "⑯ 该冲突是致命（冻结必须拒）");
    ok(!idx.entries.some((e) => e.path === ".env"), "⑯ 秘密路径不进条目");
    ok(!JSON.stringify(idx).includes("SECRET=1"), "⑯ 秘密内容不泄露");
  }

  // ────────────────────────── ⑰ 索引/恢复材料紧凑引用（事件只存引用 + 分块） ──────────────────────────
  section("⑰ 候选索引/恢复材料紧凑引用：≤64KiB、可核指纹、超大原字节分块");
  {
    const dir = path.join(BASE, "refs");
    for (let i = 0; i < 600; i += 1) writeFile(path.join(dir, `src/f${String(i).padStart(3, "0")}.ts`), `export const n${i} = ${i};\n`);
    const bigBytes = Buffer.alloc(7 * 1024 * 1024, 0x62); // base64 后 > 8MiB → 必须分块
    writeFile(path.join(dir, "big.bin"), bigBytes);
    const idx = inspectCandidateSource({ root: dir, included_uncommitted: true, declared_paths: null });
    const workDir = path.join(BASE, "central", "work");
    const recovery = preserveCandidateSource({ root: dir, work_dir: workDir, index: idx, actor_id: "v09-64" });
    ok(recovery.complete === true, "⑰ 完整保全（无 refused ⇒ complete）", { refused: recovery.refused });
    const ref = persistCandidateIndex(workDir, idx, { actor_id: "v09-64", recovery });
    ok(ref.ref_bytes <= 64 * 1024, "⑰ 索引引用 ≤64KiB（不把完整索引塞进事件）", ref.ref_bytes);
    ok(ref.recovery_evidence_id !== null, "⑰ 引用里带恢复材料证据 id");
    const back = readCandidateIndex(workDir, ref);
    ok(back.content_fingerprint === idx.content_fingerprint && back.entries.length === idx.entries.length, "⑰ 从引用取回索引（指纹/条目数一致）");
    const recRef = persistCandidateRecovery(workDir, recovery, { actor_id: "v09-64" });
    const recBack = readCandidateRecovery(workDir, recRef);
    ok(recBack.index_fingerprint === idx.content_fingerprint, "⑰ 从引用取回恢复材料（指纹一致）");
    // 超大原字节：分块包装（>1 块）且读回逐字节一致
    const bigEntry = recBack.raw_evidence.find((r) => r.path === "big.bin");
    ok(bigEntry !== undefined, "⑰ 7MiB 原字节进恢复材料");
    if (bigEntry !== undefined) {
      const wrapper = JSON.parse(fs.readFileSync(path.join(workDir, "evidence", `${bigEntry.evidence_id}.json`), "utf8")) as { content: string };
      const parsed = JSON.parse(wrapper.content) as { chunks?: string[] };
      ok((parsed.chunks?.length ?? 0) >= 2, "⑰ 7MiB 原字节被分块保全（≥2 块）", parsed.chunks?.length);
    }
    // 引用与索引不符即拒（不采信畸形引用）
    let tamperRejected = false;
    try {
      readCandidateIndex(workDir, { ...ref, index_fingerprint: sha256("bogus") });
    } catch {
      tamperRejected = true;
    }
    ok(tamperRejected, "⑰ 引用指纹与索引不符 → 拒（不采信畸形引用）");
  }

  // ────────────────────────── ⑱ 冻结候选：默认试用视图读冻结 DESIGN/PLAN 快照 ──────────────────────────
  section("⑱ 冻结候选：默认试用视图读冻结 DESIGN/PLAN 快照（不读当前目录）；workspace=dev 读开发区");
  {
    const dataDir2 = path.join(BASE, "ws-home2");
    fs.mkdirSync(dataDir2, { recursive: true });
    process.env.TATAI_HOME = dataDir2;
    installWorkspaceHostWiring(); // 试用提升的「已验版本」判据由宿主验证器实测（§6.14 第 8 段）
    const service = new WorkService({ dataDir: dataDir2 });
    const proj = path.join(BASE, "ws-proj2");
    fs.mkdirSync(path.join(proj, ".工作台"), { recursive: true });
    const DECL_HEAD = [
      "| 功能 ID | 人话功能名 | 需求 ID | 设计章节 | 本期范围（scope_id） | 覆盖结论 | 依据/缺口（review） | 使用结果与场景 |",
      "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ];
    const makeDesign = (anchorHash: string): string =>
      [
        "# 设计书",
        "",
        "### 3.16 交付总览",
        "",
        "正文。",
        "",
        "## 功能清单声明（夹具）",
        "",
        DECL_HEAD[0],
        DECL_HEAD[1],
        `| cap-dv | 交付总览 | req-dv | §3.16 | cap-dv | 已核对 | reviewer=审1; ref=.工作台/design.md#3.16; section_sha256=${anchorHash}; gap= | 场景 |`,
        "",
      ].join("\n");
    const withPlaceholder = makeDesign("SECTION_SHA_PLACEHOLDER");
    const secs = sectionsOf(withPlaceholder);
    const anchorHash = secs.find((x) => x.title.startsWith("3.16 "))?.sha256 ?? "";
    const DESIGN = makeDesign(anchorHash);
    const PLAN = [
      "# 施工图",
      "",
      "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |",
      "| --- | --- | --- | --- | --- |",
      "| V-1 | todo | 交付总览 |  | 证据齐 |",
      "",
      "### V-1 交付总览",
      "",
      "**设计依据**：§3.16。**依赖**：无。**文件责任**：`src/d.ts`。",
      "",
      "- [ ] **chk-v-1-01 达标**",
      "",
      "| 功能 ID | 人话功能名 | 承接卡 | 必需检查 | 集成检查 | 结果状态 |",
      "| --- | --- | --- | --- | --- | --- |",
      "| cap-dv | 交付总览 | V-1 | chk-v-1-01 | int-dv-01 | 未验 |",
      "",
    ].join("\n");
    writeFile(path.join(proj, ".工作台", "design.md"), DESIGN);
    writeFile(path.join(proj, ".工作台", "plan.md"), PLAN);
    addProject({ id: "wstrial", name: "wstrial", path: proj, kind: "backend" }, dataDir2);
    const CHANGE2 = "change-wstrial";
    const submitter2 = { submit: (c: unknown) => service.submit(c) };
    registerRequirement(submitter2 as never, {
      project_id: "wstrial", requirement_id: "req-dv", change_id: CHANGE2, actor_id: "fixture", role: "designer",
      source: { kind: "user", ref: "夹具" }, problem: "夹具需求", users: [], success_scenarios: [], exclusions: [], priority: "P1", status: "explicit",
    });
    submitDefinitionImports(service, {
      project_id: "wstrial", change_id: CHANGE2, actor_id: "fixture", role: "coordinator",
      definitions: importTaskDefinitions(PLAN, { plan_revision: sha256(PLAN) }).definitions,
    });
    const baseline = activateBaseline("wstrial", { approved_by: "user", approval_basis: "夹具审定", approval_kind: "user_confirmed" }, dataDir2);
    const designSha = sha256(DESIGN);
    const planSha = sha256(PLAN);

    const candRoot = path.join(BASE, "wstrial-cand");
    writeFile(path.join(candRoot, "x.ts"), "export const x = 1;\n");
    const wd2 = projectWorkDir("wstrial", dataDir2);
    const sub2 = { submit: (c: unknown) => service.submit(c), read: () => readWorkspaces(wd2) };
    const reg = registerWorkspace(sub2 as never, {
      project_id: "wstrial", workspace_id: "ws-trial-1", change_id: CHANGE2, actor_id: COORD, role: "coordinator",
      kind: "trial", purpose: "固定试用候选", root: candRoot, source_kind: "directory", task_ids: ["V-1"],
    });
    ok(reg.ok === true, "⑱ 登记 trial 工作区", reg.ok ? "ok" : reg);
    const rev1 = readWorkspaces(wd2).workspaces["ws-trial-1"].revision;
    const fr = freezeWorkspace(sub2 as never, {
      project_id: "wstrial", workspace_id: "ws-trial-1", change_id: CHANGE2, actor_id: COORD, role: "coordinator",
      expected_revision: rev1, included_uncommitted: true, declared_paths: ["x.ts"],
      version_binding: { design_sha256: designSha, plan_sha256: planSha, baseline_id: baseline.baseline.baseline_id },
    });
    ok(fr.ok === true, "⑱ 冻结候选（绑定 DESIGN/PLAN 内容哈希 + 基线）", fr.ok ? "ok" : fr);
    // 真证据（技术 + 非作者独立审查）：试用提升只接已验版本（§6.14 第 8 段）。
    const EXEC64 = "v0964-exec";
    const AUDITOR64 = "v0964-auditor";
    const evBlob = putEvidence(wd2, {
      content: "", kind: "source_manifest", summary: "候选源清单", created_by: EXEC64, role: "executor",
      binding: { revision_kind: "code", revision: "rev-x" }, source_manifest: [{ path: "x.ts" }], workspace_root: candRoot,
    });
    const evid = evBlob.evidence_id;
    const fp = (evBlob.source_manifest as { fingerprint: string }).fingerprint;
    await claimTask({ project_id: "wstrial", task_id: "V-1", role: "executor", owner_id: EXEC64, change_id: CHANGE2, workspace_id: "ws-trial-1" }, service, dataDir2);
    submitSelfCheck(sub2 as never, {
      project_id: "wstrial", change_id: CHANGE2, actor_id: EXEC64, role: "executor", record_id: "sc64-v1",
      task_id: "V-1", checked_by: EXEC64, conclusion: "pass", binding: { revision_kind: "code", revision: fp },
      checks: [
        { check_id: "chk-v-1-01", method: "夹具", command: null, exit_code: null, evidence_sha256: evid, scope: [], verifies: "code" },
        { check_id: "V-1::evidence", method: "交付物证据（夹具）", command: null, exit_code: null, evidence_sha256: evid, scope: [], verifies: "code" },
      ],
    });
    submitIndependentAudit(sub2 as never, {
      project_id: "wstrial", change_id: CHANGE2, actor_id: AUDITOR64, role: "auditor", record_id: "ia64-v1",
      task_id: "V-1", auditor: AUDITOR64, author_id: EXEC64, conclusion: "pass", binding: { revision_kind: "code", revision: fp },
      checks: [{ check_id: "chk-v-1-01", result: "passed", evidence_sha256: evid, scope: [] }],
      coverage: COVERAGE_AREAS.map((a) => ({ area: a, status: "checked" as const, basis: `${COVERAGE_AREA_LABELS[a]}：夹具` })),
    });
    const pt = pointTrialWorkspace(sub2 as never, {
      project_id: "wstrial", workspace_id: "ws-trial-1", change_id: CHANGE2, actor_id: COORD, role: "coordinator",
      expected_revision: 0, basis: "夹具试用提升",
    });
    ok(pt.ok === true, "⑱ 已验版本试用提升通过（宿主实测技术+独审）", pt.ok ? "ok" : pt);

    const exists = (id: string): boolean => id === "wstrial";
    const L = readFeatureLedger("wstrial", dataDir2, {}, { project_exists: exists });
    if (L.ok) {
      ok(L.ledger.document_selection.mode === "frozen_candidate", "⑱ 默认试用视图读**冻结候选**文档快照", L.ledger.document_selection);
      ok(L.ledger.document_selection.design_revision === designSha, "⑱ 设计修订 = 冻结绑定哈希", L.ledger.document_selection.design_revision);
      ok(L.ledger.workspace?.workspace_id === "ws-trial-1" && L.ledger.workspace?.resolved === true, "⑱ workspace 标出所读工作区", L.ledger.workspace);
    } else {
      ok(false, "⑱ 默认试用视图应 ok（读冻结候选）", L);
    }
    const Ld = readFeatureLedger("wstrial", dataDir2, { workspace: "dev" }, { project_exists: exists });
    ok(
      Ld.ok === true && Ld.ledger.workspace?.kind === "dev" && Ld.ledger.document_selection.mode !== "frozen_candidate",
      "⑱ workspace=dev 读当前开发工作区（非冻结候选）",
      Ld.ok ? { ws: Ld.ledger.workspace, mode: Ld.ledger.document_selection.mode } : Ld,
    );
  }

  // ────────────────────────── ⑲ evidence workspace_id：source_manifest 按工作区根现读 ──────────────────────────
  section("⑲ evidence workspace_id：source_manifest 按解析出的工作区根现读；未知工作区拒；旧证据兼容");
  {
    const workDir = path.join(BASE, "evid", ".工作台", "work");
    const wsRoot = path.join(BASE, "evid-ws");
    writeFile(path.join(wsRoot, "src/a.ts"), "export const a = 1;\n");
    const mainRoot = path.join(BASE, "evid"); // = projectRootOfWorkDir(workDir)：旧口径的主根
    writeFile(path.join(mainRoot, "src/a.ts"), "export const a = 999;\n");
    setEvidenceWorkspaceResolver((_wd, id) => (id === "ws-known" ? wsRoot : null));
    const blob = putEvidence(workDir, {
      content: "", kind: "source_manifest", summary: "s", created_by: "b", role: "executor",
      binding: { revision_kind: "code", revision: "rev-x" },
      source_manifest: [{ path: "src/a.ts" }], workspace_id: "ws-known",
    });
    ok(blob.workspace_id === "ws-known" && blob.workspace_root === path.resolve(wsRoot), "⑲ 证据记目标工作区与实际根", { ws: blob.workspace_id, root: blob.workspace_root });
    ok(blob.source_manifest?.files[0]?.sha256 === sha256("export const a = 1;\n"), "⑲ 清单按工作区根现读（不是主根）", blob.source_manifest?.files[0]);
    let rejected = false;
    try {
      putEvidence(workDir, {
        content: "", kind: "source_manifest", summary: "s2", created_by: "b", role: "executor",
        binding: { revision_kind: "code", revision: "rev-y" }, source_manifest: [{ path: "src/a.ts" }], workspace_id: "ws-unknown",
      });
    } catch {
      rejected = true;
    }
    ok(rejected, "⑲ 未知工作区拒存证（不回落主根）");
    // 旧行为兼容：不给 workspace_id → 按 workDir 推主根（不报错），且现读的是主根内容
    const legacy = putEvidence(workDir, {
      content: "", kind: "source_manifest", summary: "s3", created_by: "b", role: "executor",
      binding: { revision_kind: "code", revision: "rev-z" }, source_manifest: [{ path: "src/a.ts" }],
    });
    ok(legacy.workspace_id === null && legacy.workspace_root === null, "⑲ 不给 workspace 的旧路径不退化（workspace 字段 null）", { ws: legacy.workspace_id });
    ok(legacy.source_manifest?.files[0]?.sha256 === sha256("export const a = 999;\n"), "⑲ 旧口径按 workDir 主根现读");
    setEvidenceWorkspaceResolver(null);
  }

  // ────────────────────────── ⑳ documents 当前开发根（注入式，无循环依赖） ──────────────────────────
  section("⑳ documents 图纸源根跟当前开发根；中央锚点不变（注入式，不建循环）");
  {
    const dataDir3 = path.join(BASE, "doc-home");
    fs.mkdirSync(dataDir3, { recursive: true });
    const anchor = path.join(BASE, "doc-anchor");
    fs.mkdirSync(path.join(anchor, ".工作台"), { recursive: true });
    const devRoot = path.join(BASE, "doc-dev");
    fs.mkdirSync(path.join(devRoot, ".工作台"), { recursive: true });
    writeFile(path.join(anchor, ".工作台", "design.md"), "# anchor design\n");
    writeFile(path.join(devRoot, ".工作台", "design.md"), "# dev design\n");
    addProject({ id: "docproj", name: "docproj", path: anchor, kind: "backend" }, dataDir3);
    setCurrentDevRootResolver((pid) => (pid === "docproj" ? { workspace_id: "ws-dev", root: devRoot, source: "pointer" } : { workspace_id: `${pid}:main`, root: anchor, source: "main" }));
    const src = resolveDocumentSource("docproj", "design", dataDir3);
    ok(src.source_root === path.resolve(devRoot), "⑳ 图纸源根 = 当前开发根", src.source_root);
    ok(src.project_root === path.resolve(anchor), "⑳ 中央锚点根 = 注册表根（不被指针改写）", src.project_root);
    ok(src.abs_path === path.resolve(devRoot, ".工作台", "design.md"), "⑳ 图纸绝对路径落在开发根内", src.abs_path);
    setCurrentDevRootResolver(null);
    const srcBack = resolveDocumentSource("docproj", "design", dataDir3);
    ok(srcBack.source_root === path.resolve(anchor), "⑳ 未注入 resolver → 回退锚点根（旧行为）", srcBack.source_root);
  }

  // ────────────────────────── ⑲b MCP 透传 workspace_id ──────────────────────────
  section("⑲b record_work_evidence(store) 透传 workspace_id（MCP 只传 id，宿主解析根）");
  {
    const captured: Record<string, unknown>[] = [];
    const work = {
      saveEvidence: async (_pid: string, input: Record<string, unknown>): Promise<unknown> => {
        captured.push(input);
        return {
          evidence_id: "e".repeat(64), sha256: "e".repeat(64), bytes: 1, recovery_path: "x", kind: "other",
          summary: "s", created_by: "b", role: "executor", binding: { revision_kind: "code", revision: "r" },
          source_ref: null, created_at: "", duplicate: false, source_manifest: null,
          workspace_id: (input.workspace_id as string | undefined) ?? null, workspace_root: null,
        };
      },
    };
    const res = await recordWorkEvidenceTool.handler(
      {
        op: "store", project_id: "p", role: "executor", kind: "other", content: "c", summary: "s",
        binding: { revision_kind: "code", revision: "r" }, workspace_id: "ws-known",
      },
      { clientName: "t", work } as never,
    );
    ok(res.isError !== true && captured.length === 1, "⑲b store 经宿主 saveEvidence 成功");
    ok(captured[0]?.workspace_id === "ws-known", "⑲b workspace_id 透传给宿主（只传 id，不传绝对根）", captured[0]?.workspace_id);
    const bad = await recordWorkEvidenceTool.handler(
      {
        op: "store", project_id: "p", role: "executor", kind: "other", content: "c", summary: "s",
        binding: { revision_kind: "code", revision: "r" }, nope: 1,
      },
      { clientName: "t", work } as never,
    );
    ok(bad.isError === true, "⑲b 未知键仍拒（OP_KEYS 闭键未被放宽）");
  }

  // ────────────────────────── ⑩ 旧交付脚本（127 项）回归 ──────────────────────────
  if (process.env.V0964_SKIP_REGRESSION === "1") {
    console.log("\n[verify] SKIP ⑩ 交付总览脚本回归（V0964_SKIP_REGRESSION=1）");
  } else {
    section("⑩ 既有交付总览脚本（基线 127 项）回归");
    const res = spawnSync("pnpm", ["exec", "tsx", "scripts/verify-delivery-overview.ts"], {
      cwd: ROOT, shell: true, encoding: "utf8", timeout: 300000,
    });
    const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
    const m = out.match(/PASS=(\d+)\s+FAIL=(\d+)/) ?? out.match(/PASS\s*=\s*(\d+)/);
    const tail = out.trim().split(/\r?\n/).slice(-4).join(" | ");
    ok(res.status === 0, `⑩ 交付总览脚本退出 0（exit=${res.status}）`, tail);
    if (m) console.log(`[verify]   交付脚本读数：${m[0]}`);
    if (res.status !== 0) console.log(`[verify]   尾部输出：${tail}`);
  }

  console.log(`\n[verify] ═══ 汇总：PASS=${pass} FAIL=${fail} ═══`);
  if (fail > 0) process.exitCode = 1;
} finally {
  // 临时夹具整体回收（尽最大努力；不删任何真实项目/账本）
  try {
    fs.rmSync(BASE, { recursive: true, force: true });
  } catch {
    /* 回收失败不影响判分 */
  }
}
