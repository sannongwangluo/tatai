// 候选完整输入索引与来源恢复（DESIGN.md §6.13 第 3/5/6 段、§6.14 第 4/5 段；PLAN V09-64）。
//
// 为什么单独一个模块、且**不复用** `scripts/lib/sourceFingerprint.ts`：
//   · 旧全树指纹的目录跳过按**目录名**判，worktree 的 `.git` 是**文件**（`gitdir:` 指针）→ 会被当普通
//     文件收进候选（评审第 2 项实测）；因此候选枚举改用 Git 自身口径（tracked ∪ 非 ignored untracked），
//     再叠加固定排除段。
//   · 旧算法与既有包身份**一字不改**（§4.5）；逐检查 `source_manifest` 的 512/8MiB/64MiB 判据也不变。
//     本模块是**另一套**完整候选口径（分片、有界、可判定），两者互不顶替。
//
// 判据边界（严格、有界、只读）：
//   · 枚举工作树**实际内容**：Git 源 = `git ls-files --cached --others --exclude-standard`；非 Git 源 =
//     按同一显式排除规则递归枚举。`.git` 任意形态、`.工作台`、依赖/产物/缓存/被忽略文件一律排除。
//   · 秘密类（.env/凭据/私钥）**只记计数与模式**，不写路径/内容；symlink·目录联接**真拒**（不跟随）。
//   · 有界：32768 文件 / 每片 512 文件 / 单文件 8 MiB / 每片 64 MiB / 64 片 / 索引 JSON 64 MiB——超限如实拒。
//   · 保住实际未提交内容、删除项与文件模式；未提交改动是否纳入由调用方**声明**，不用 HEAD 冒充。
//
// 本模块只读盘（除 `preserveCandidateSource` 经既有 `putEvidence` 写**中央证据库**，且先验证再写）。
// 不 checkout、不写任何用户工作树、不动 Git 配置。
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  CANDIDATE_INDEX_VERSION,
  MAX_CANDIDATE_EVENT_REF_BYTES,
  MAX_CANDIDATE_FILES,
  MAX_CANDIDATE_FILE_BYTES,
  MAX_CANDIDATE_INDEX_BYTES,
  MAX_CANDIDATE_SHARD_BYTES,
  MAX_CANDIDATE_SHARD_FILES,
  MAX_CANDIDATE_SHARDS,
  type CandidateEntry,
  type CandidateIndex,
  type CandidateIndexRef,
  type CandidateProblem,
  type CandidateProblemCode,
  type CandidateRecovery,
  type CandidateRecoveryRawEntry,
  type CandidateRecoveryRef,
  type CandidateRecoveryRefusal,
  type CandidateResolution,
  type CandidateShard,
  type CandidateSourceKind,
  type CandidateVerify,
  type CandidateVersionBinding,
} from "../../shared/candidateIndexTypes";
import { isIgnoredManifestPath, isPrivateManifestPath } from "./sourceEvidence";
import { putEvidence, sha256Hex, type EvidenceBlob } from "./evidence";

// ────────────────────────── 常量与工具 ──────────────────────────

/** 证据正文上限（与 evidence.ts 同一口径；避免循环 import 故在此重复常量值） */
const MAX_EVIDENCE_BYTES = 8 * 1024 * 1024;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

const problem = (code: CandidateProblemCode, message: string, p: string | null = null): CandidateProblem => ({
  code,
  path: p,
  message,
});

const FATAL_CODES: ReadonlySet<CandidateProblemCode> = new Set([
  "CANDIDATE_ROOT_INVALID",
  "CANDIDATE_ROOT_NOT_REPO",
  "CANDIDATE_TOO_LARGE",
  "CANDIDATE_FILE_TOO_LARGE",
  "CANDIDATE_FILE_UNREADABLE",
  "CANDIDATE_LINK_REFUSED",
  "CANDIDATE_UNCOMMITTED_EXCLUDED",
  "CANDIDATE_UNDECLARED_CHANGES",
  "CANDIDATE_DECLARED_INVALID",
  "CANDIDATE_DECLARED_MISSING",
  "CANDIDATE_GIT_PROBE_FAILED",
  // 被排除的秘密类文件其实是跟踪/已声明的真实源 → 候选与实际被验输入不符，冻结必须拒
  "CANDIDATE_SECRET_TRACKED_CONFLICT",
]);

/** 是否有致命问题（冻结必须拒；损坏的候选不静默算成完整） */
export function candidateHasFatalProblems(index: CandidateIndex): boolean {
  return index.problems.some((p) => FATAL_CODES.has(p.code)) || index.truncated;
}

/** 声明路径归一化（返回 null = 非法；不读盘） */
export function normalizeCandidatePath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (text === "") return null;
  const unified = text.replace(/\\/g, "/");
  if (unified.startsWith("/") || /^[a-zA-Z]:/.test(unified) || unified.startsWith("//")) return null;
  const parts = unified.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.length === 0) return null;
  for (const p of parts) {
    if (p === ".." || p.includes("\0")) return null;
  }
  return parts.join("/");
}

/** 固定排除段：`.git`（任意形态）+ 既有忽略段（.工作台/依赖/产物/缓存/被忽略目录） */
export function isCandidateExcludedPath(rel: string): boolean {
  if (rel.split("/").some((seg) => seg === ".git")) return true;
  return isIgnoredManifestPath(rel);
}

/** 候选内容指纹：按 `path/bytes/sha/mode/delete` 排序的确定性 sha256（两侧同一实现） */
export function candidateIndexFingerprint(entries: readonly CandidateEntry[]): string {
  const sorted = [...entries].sort(
    (a, b) =>
      a.path.localeCompare(b.path) ||
      a.bytes - b.bytes ||
      a.sha256.localeCompare(b.sha256) ||
      a.mode - b.mode ||
      (a.state === "deleted" ? 1 : 0) - (b.state === "deleted" ? 1 : 0),
  );
  const h = crypto.createHash("sha256");
  h.update(`${CANDIDATE_INDEX_VERSION}\n`, "utf8");
  for (const e of sorted) {
    h.update(`${e.path}\0${e.sha256}\0${e.bytes}\0${e.mode}\0${e.state === "deleted" ? 1 : 0}\n`, "utf8");
  }
  return h.digest("hex");
}

interface GitRun {
  ok: boolean;
  status: number | null;
  stdout: Buffer;
  stderr: string;
  error: string | null;
}

function runGit(cwd: string, args: readonly string[], input?: string): GitRun {
  let res: ReturnType<typeof spawnSync>;
  try {
    res = spawnSync("git", ["-C", cwd, ...args], {
      input,
      maxBuffer: 256 * 1024 * 1024,
      timeout: 30000,
      windowsHide: true,
    });
  } catch (e) {
    return { ok: false, status: null, stdout: Buffer.alloc(0), stderr: "", error: (e as Error).message };
  }
  if (res.error !== undefined && res.error !== null) {
    return { ok: false, status: res.status ?? null, stdout: Buffer.alloc(0), stderr: "", error: res.error.message };
  }
  const out = Buffer.isBuffer(res.stdout) ? res.stdout : Buffer.from(String(res.stdout ?? ""), "utf8");
  const err = Buffer.isBuffer(res.stderr) ? String(res.stderr.toString("utf8")) : String(res.stderr ?? "");
  return { ok: res.status === 0, status: res.status ?? null, stdout: out, stderr: err, error: null };
}

const splitZ = (buf: Buffer): string[] => {
  const text = buf.toString("utf8");
  const out = text.split("\0");
  if (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out;
};

const existsOnDisk = (root: string, rel: string): boolean => {
  try {
    return fs.lstatSync(path.resolve(root, rel)).isFile();
  } catch {
    return false;
  }
};

/** 文件模式归一：按可执行位映射到 Git 风格文件模式（0o100644 / 0o100755），使 Git 源与非 Git 源可比 */
const gitFileMode = (raw: number): number => ((raw & 0o111) !== 0 ? 0o100755 : 0o100644);

const countCrlf = (buf: Buffer): boolean => {
  for (let i = 0; i + 1 < buf.length; i += 1) {
    if (buf[i] === 0x0d && buf[i + 1] === 0x0a) return true;
  }
  return false;
};

// ────────────────────────── inspectCandidateSource ──────────────────────────

export interface InspectCandidateInput {
  root: string;
  included_uncommitted: boolean;
  declared_paths?: readonly string[] | null;
  source_commit?: string | null;
  git_repository?: string | null;
  /**
   * 内部/测试用：强制按目录枚举，**不做 Git 探测**。用于复核物化缓存（缓存可能在某个 Git 项目里，
   * `git -C <cache>` 会命中外层主仓）。默认 false（按 Git 能力自动判）。
   */
  force_directory?: boolean;
}

interface Collected {
  entries: CandidateEntry[];
  problems: CandidateProblem[];
  secretCount: number;
  secretPatterns: Set<string>;
  truncated: boolean;
  sourceKind: CandidateSourceKind;
  gitRepo: string | null;
  sourceCommit: string | null;
  uncommitted: Set<string>;
}

/**
 * 只读枚举候选来源的实际完整内容，返回 `CandidateIndex`。
 * 不改盘、不写字节；超限/软链/秘密等如实进 `problems`（致命码见 `candidateHasFatalProblems`）。
 */
export function inspectCandidateSource(input: InspectCandidateInput): CandidateIndex {
  const root = path.resolve(input.root);
  const inspectedAt = new Date().toISOString();
  const declaredPaths = normalizeDeclared(input.declared_paths);
  const problems: CandidateProblem[] = [];

  if (declaredPaths !== null && declaredPaths.invalid.length > 0) {
    for (const bad of declaredPaths.invalid) {
      problems.push(problem("CANDIDATE_DECLARED_INVALID", `declared_paths 含非法路径：${JSON.stringify(bad)}`));
    }
  }
  const declared = declaredPaths?.ok ?? null;

  let st: fs.Stats | null = null;
  try {
    st = fs.lstatSync(root);
  } catch {
    st = null;
  }
  if (st === null || !st.isDirectory()) {
    problems.push(problem("CANDIDATE_ROOT_INVALID", `候选根不存在或不是目录：${root}`));
    return emptyIndex(root, input.included_uncommitted, declared, inspectedAt, problems);
  }

  const collected = collectEntries(root, input, problems, declared);
  const sorted = [...collected.entries].sort((a, b) => a.path.localeCompare(b.path));
  const shard = buildShards(sorted, problems);

  const base: Omit<CandidateIndex, "content_fingerprint" | "index_bytes"> = {
    version: CANDIDATE_INDEX_VERSION,
    root,
    source_kind: collected.sourceKind,
    git_repository: collected.gitRepo,
    source_commit: collected.sourceCommit,
    included_uncommitted: input.included_uncommitted,
    declared_paths: declared,
    entries: sorted,
    shards: shard.shards,
    file_count: sorted.length,
    present_count: sorted.filter((e) => e.state === "present").length,
    deleted_count: sorted.filter((e) => e.state === "deleted").length,
    total_bytes: sorted.reduce((n, e) => n + e.bytes, 0),
    shard_count: shard.shards.length,
    secret_files: collected.secretCount,
    secret_patterns: [...collected.secretPatterns].sort(),
    problems,
    truncated: collected.truncated,
    inspected_at: inspectedAt,
  };
  const content_fingerprint = candidateIndexFingerprint(sorted);
  const index: CandidateIndex = { ...base, content_fingerprint, index_bytes: 0 };
  index.index_bytes = Buffer.byteLength(JSON.stringify(index), "utf8");
  if (index.index_bytes > MAX_CANDIDATE_INDEX_BYTES) {
    index.problems.push(
      problem("CANDIDATE_TOO_LARGE", `候选索引 JSON 超上限 ${MAX_CANDIDATE_INDEX_BYTES} 字节（本次 ${index.index_bytes}）`),
    );
    index.truncated = true;
  }
  return index;
}

function normalizeDeclared(raw: readonly unknown[] | null | undefined): { ok: string[]; invalid: unknown[] } | null {
  if (raw === null || raw === undefined) return null;
  const ok: string[] = [];
  const invalid: unknown[] = [];
  for (const item of raw) {
    const n = normalizeCandidatePath(item);
    if (n === null) invalid.push(item);
    else if (!ok.includes(n)) ok.push(n);
  }
  ok.sort();
  return { ok, invalid };
}

function emptyIndex(
  root: string,
  includedUncommitted: boolean,
  declared: string[] | null,
  inspectedAt: string,
  problems: CandidateProblem[],
): CandidateIndex {
  const index: CandidateIndex = {
    version: CANDIDATE_INDEX_VERSION,
    root,
    source_kind: "directory",
    git_repository: null,
    source_commit: null,
    included_uncommitted: includedUncommitted,
    declared_paths: declared,
    entries: [],
    shards: [],
    content_fingerprint: candidateIndexFingerprint([]),
    file_count: 0,
    present_count: 0,
    deleted_count: 0,
    total_bytes: 0,
    shard_count: 0,
    index_bytes: 0,
    secret_files: 0,
    secret_patterns: [],
    problems,
    truncated: false,
    inspected_at: inspectedAt,
  };
  index.index_bytes = Buffer.byteLength(JSON.stringify(index), "utf8");
  return index;
}

function collectEntries(
  root: string,
  input: InspectCandidateInput,
  problems: CandidateProblem[],
  declared: string[] | null,
): Collected {
  if (input.force_directory === true) {
    return collectDirectory(root, input, problems, declared);
  }
  const gitRoot = detectGitRoot(root, input.git_repository);
  if (gitRoot === "not_repo") {
    return collectDirectory(root, input, problems, declared);
  }
  if (gitRoot === "probe_failed") {
    problems.push(problem("CANDIDATE_GIT_PROBE_FAILED", "git 探针失败：无法核实仓库/忽略规则，未知不当未变更"));
    return {
      entries: [], problems, secretCount: 0, secretPatterns: new Set(), truncated: false,
      sourceKind: "git", gitRepo: null, sourceCommit: null, uncommitted: new Set(),
    };
  }
  return collectGit(root, gitRoot, input, problems, declared);
}

function detectGitRoot(root: string, declaredRepo: string | null | undefined): string | "not_repo" | "probe_failed" {
  const hasGit = fs.existsSync(path.join(root, ".git"));
  const res = runGit(root, ["rev-parse", "--show-toplevel"]);
  if (res.error !== null) return "probe_failed";
  if (!res.ok) {
    // 不是仓库（git 明确报 not a git repository）→ 非 Git 源；其它错误当探针失败
    if (res.stderr.includes("not a git repository")) return "not_repo";
    if (!hasGit) return "not_repo";
    return "probe_failed";
  }
  const top = path.resolve(res.stdout.toString("utf8").trim());
  if (declaredRepo !== null && declaredRepo !== undefined && path.resolve(declaredRepo) !== top) {
    // 声明的仓库根与实探不一致 → 当作探针失败（不猜）
    return "probe_failed";
  }
  // root **不是**仓库根（落在某个仓库的子目录里，例如候选只读物化缓存就放在 Git 项目的 `.工作台/work/` 下）：
  // `git -C <root> ls-files` 会返回**整个外层主仓**的清单，把缓存误当那个工作树（评审第 3 项实测反例）。
  // 这种情况按**目录**枚举（严格限定在 root 之内），不当 Git 源。
  if (top !== root) return "not_repo";
  return top;
}

function collectGit(
  root: string,
  gitRoot: string,
  input: InspectCandidateInput,
  problems: CandidateProblem[],
  declared: string[] | null,
): Collected {
  const secretPatterns = new Set<string>();
  let secretCount = 0;
  const entries: CandidateEntry[] = [];
  let truncated = false;

  const lsFiles = runGit(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
  if (!lsFiles.ok) {
    problems.push(problem("CANDIDATE_GIT_PROBE_FAILED", `git ls-files 失败：${lsFiles.error ?? lsFiles.stderr.trim()}`));
    return { entries, problems, secretCount, secretPatterns, truncated: true, sourceKind: "git", gitRepo: gitRoot, sourceCommit: null, uncommitted: new Set() };
  }
  const trackedRes = runGit(root, ["ls-files", "-z", "--cached"]);
  const tracked = new Set(splitZ(trackedRes.ok ? trackedRes.stdout : Buffer.alloc(0)));
  const stage = parseStage(runGit(root, ["ls-files", "-z", "--stage"]).stdout);

  const statusRes = runGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=no"]);
  if (!statusRes.ok) {
    problems.push(problem("CANDIDATE_GIT_PROBE_FAILED", `git status 失败：${statusRes.error ?? statusRes.stderr.trim()}`));
    return { entries, problems, secretCount, secretPatterns, truncated: true, sourceKind: "git", gitRepo: gitRoot, sourceCommit: null, uncommitted: new Set() };
  }
  const status = parseStatus(statusRes.stdout);
  const dirty = new Set<string>();
  const untracked = new Set<string>();
  const stagedDeleted = new Set<string>();
  for (const s of status) {
    if (s.x === "?" && s.y === "?") {
      untracked.add(s.path);
      continue;
    }
    dirty.add(s.path);
    if (s.orig !== undefined) dirty.add(s.orig);
    if (s.x === "D" || s.y === "D") stagedDeleted.add(s.path);
  }

  const uncommitted = new Set<string>([...dirty, ...untracked, ...stagedDeleted]);

  const headRes = runGit(root, ["rev-parse", "--verify", "HEAD"]);
  const sourceCommit = headRes.ok ? headRes.stdout.toString("utf8").trim() : null;

  const allPaths = new Set<string>(splitZ(lsFiles.stdout));
  for (const s of status) {
    if (s.orig !== undefined) allPaths.add(s.orig);
    if (s.x === "D" || s.y === "D") allPaths.add(s.path);
  }

  const deleted = new Set<string>(stagedDeleted);
  for (const p of allPaths) {
    if (tracked.has(p) && !existsOnDisk(root, p)) deleted.add(p);
  }

  const paths = [...allPaths].sort();
  // git_backed 的**真判据**：worktree 原始字节 == 该路径在**索引里的 blob 内容**（逐字节比）。
  // 不能比 `ls-files --stage` 的 oid（那是 Git 对象名，默认 SHA-1）与候选的 SHA-256；也不能只看
  // `status` 干净或无 CRLF——clean/smudge filter（`.gitattributes` ident/text、inherited config 的
  // core.autocrlf）会让 raw ≠ blob 而 status 仍干净（评审第 3 项）。这里取回 blob 内容算 SHA-256 比对。
  const cleanTracked = paths.filter(
    (p) => tracked.has(p) && !dirty.has(p) && !isCandidateExcludedPath(p) && !isPrivateManifestPath(p) && existsOnDisk(root, p),
  );
  const oidByPath = new Map<string, string>();
  for (const p of cleanTracked) {
    const s = stage.get(p);
    if (s !== undefined) oidByPath.set(p, s.sha);
  }
  const blobDigest = fetchBlobDigests(root, [...new Set(oidByPath.values())]);
  for (const rel of paths) {
    if (isCandidateExcludedPath(rel)) continue;
    const isDeleted = deleted.has(rel);
    if (!isDeleted && !existsOnDisk(root, rel)) continue; // 只在索引/状态里出现的幻影（非 tracked 删除）——跳过
    if (isPrivateManifestPath(rel)) {
      secretCount += 1;
      secretPatterns.add(secretPatternOf(rel));
      // 被排除的秘密类若是**跟踪/已声明的真实源**，静默排除会让候选与"实际被验输入"不符：
      // 明确冲突（致命，冻结必须拒），且**不写路径/内容**（§6.14 第 4 段）。
      if (tracked.has(rel) || (declared !== null && declared.includes(rel))) {
        problems.push(
          problem(
            "CANDIDATE_SECRET_TRACKED_CONFLICT",
            "秘密类文件是被跟踪/已声明的真实源，排除后候选与实际被验输入不符：须明确处理（移出跟踪或显式声明冲突），不静默排除",
            null,
          ),
        );
      }
      continue;
    }
    if (isDeleted) {
      entries.push({
        path: rel,
        sha256: "",
        bytes: 0,
        mode: stage.has(rel) ? gitFileMode(stage.get(rel)!.mode) : 0,
        state: "deleted",
        git_backed: false,
        crlf: false,
      });
      continue;
    }
    const link = lstatLink(root, rel);
    if (link === "link") {
      problems.push(problem("CANDIDATE_LINK_REFUSED", `候选不收符号链接/目录联接（越界防线）：${rel}`, rel));
      continue;
    }
    const read = readCandidateFile(root, rel, problems);
    if (read === null) continue;
    // raw==blob ⟺ 该路径索引 blob 内容的 SHA-256/长度与工作树原始字节一致（filter 会改变字节）
    const blobOid = oidByPath.get(rel);
    const digest = blobOid === undefined ? undefined : blobDigest.get(blobOid);
    const rawMatchesBlob = digest !== undefined && digest.sha256 === read.sha256 && digest.bytes === read.bytes;
    entries.push({
      path: rel,
      sha256: read.sha256,
      bytes: read.bytes,
      mode: stage.has(rel) ? gitFileMode(stage.get(rel)!.mode) : gitFileMode(read.mode),
      state: "present",
      git_backed: tracked.has(rel) && !dirty.has(rel) && rawMatchesBlob,
      crlf: read.crlf,
    });
    if (entries.length > MAX_CANDIDATE_FILES) {
      problems.push(problem("CANDIDATE_TOO_LARGE", `候选文件数超上限 ${MAX_CANDIDATE_FILES}`));
      truncated = true;
      break;
    }
  }

  applyDeclaredChecks(entries, uncommitted, declared, input, problems);
  return { entries, problems, secretCount, secretPatterns, truncated, sourceKind: "git", gitRepo: gitRoot, sourceCommit, uncommitted };
}

function collectDirectory(
  root: string,
  input: InspectCandidateInput,
  problems: CandidateProblem[],
  declared: string[] | null,
): Collected {
  const secretPatterns = new Set<string>();
  let secretCount = 0;
  const entries: CandidateEntry[] = [];
  let truncated = false;
  const uncommitted = new Set<string>();

  const walk = (dir: string): void => {
    if (truncated) return;
    let names: fs.Dirent[];
    try {
      names = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return;
    }
    for (const e of names) {
      if (truncated) return;
      const abs = path.join(dir, e.name);
      const rel = path.relative(root, abs).split(path.sep).join("/");
      if (isCandidateExcludedPath(rel)) continue;
      let lst: fs.Stats;
      try {
        lst = fs.lstatSync(abs);
      } catch {
        continue;
      }
      if (lst.isSymbolicLink()) {
        problems.push(problem("CANDIDATE_LINK_REFUSED", `候选不收符号链接/目录联接（越界防线）：${rel}`, rel));
        continue;
      }
      if (lst.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!lst.isFile()) continue;
      if (isPrivateManifestPath(rel)) {
        secretCount += 1;
        secretPatterns.add(secretPatternOf(rel));
        continue;
      }
      const read = readCandidateFile(root, rel, problems);
      if (read === null) continue;
      entries.push({
        path: rel,
        sha256: read.sha256,
        bytes: read.bytes,
        mode: gitFileMode(read.mode),
        state: "present",
        git_backed: false,
        crlf: read.crlf,
      });
      if (entries.length > MAX_CANDIDATE_FILES) {
        problems.push(problem("CANDIDATE_TOO_LARGE", `候选文件数超上限 ${MAX_CANDIDATE_FILES}`));
        truncated = true;
        return;
      }
    }
  };
  walk(root);

  applyDeclaredChecks(entries, uncommitted, declared, input, problems);
  return { entries, problems, secretCount, secretPatterns, truncated, sourceKind: "directory", gitRepo: null, sourceCommit: null, uncommitted };
}

function applyDeclaredChecks(
  entries: CandidateEntry[],
  uncommitted: Set<string>,
  declared: string[] | null,
  input: InspectCandidateInput,
  problems: CandidateProblem[],
): void {
  if (!input.included_uncommitted && uncommitted.size > 0) {
    problems.push(
      problem(
        "CANDIDATE_UNCOMMITTED_EXCLUDED",
        `存在 ${uncommitted.size} 处未提交改动但 included_uncommitted=false：不能用 HEAD 冒充候选的实际内容`,
      ),
    );
  }
  if (declared === null) return;
  const declaredSet = new Set(declared);
  const undeclared = [...uncommitted].filter((p) => !declaredSet.has(p) && !isCandidateExcludedPath(p));
  for (const p of undeclared.slice(0, 16)) {
    problems.push(problem("CANDIDATE_UNDECLARED_CHANGES", `未提交改动不在 declared_paths 声明范围内：${p}`, p));
  }
  if (undeclared.length > 16) {
    problems.push(problem("CANDIDATE_UNDECLARED_CHANGES", `另有 ${undeclared.length - 16} 处未声明改动`));
  }
  const present = new Set(entries.map((e) => e.path));
  for (const d of declared) {
    if (!present.has(d) && !isCandidateExcludedPath(d)) {
      problems.push(problem("CANDIDATE_DECLARED_MISSING", `声明的路径在实枚举里找不到：${d}`, d));
    }
  }
}

function lstatLink(root: string, rel: string): "link" | "ok" | "absent" {
  try {
    const st = fs.lstatSync(path.resolve(root, rel));
    if (st.isSymbolicLink()) return "link";
    // Windows 目录联接：realpath 与自身不同且是目录 reparse —— lstat 通常已判符号链接；再兜底一次
    if (st.isDirectory()) return "link";
    return st.isFile() ? "ok" : "absent";
  } catch {
    return "absent";
  }
}

function readCandidateFile(
  root: string,
  rel: string,
  problems: CandidateProblem[],
): { sha256: string; bytes: number; mode: number; crlf: boolean } | null {
  const abs = path.resolve(root, rel);
  let st: fs.Stats;
  try {
    st = fs.statSync(abs);
  } catch {
    problems.push(problem("CANDIDATE_FILE_UNREADABLE", `候选文件读不出来：${rel}`, rel));
    return null;
  }
  if (!st.isFile()) {
    problems.push(problem("CANDIDATE_FILE_UNREADABLE", `候选路径不是普通文件：${rel}`, rel));
    return null;
  }
  if (st.size > MAX_CANDIDATE_FILE_BYTES) {
    problems.push(
      problem("CANDIDATE_FILE_TOO_LARGE", `候选单文件超 ${MAX_CANDIDATE_FILE_BYTES} 字节上限（${st.size}）：${rel}`, rel),
    );
    return null;
  }
  let buf: Buffer;
  try {
    buf = fs.readFileSync(abs);
  } catch {
    problems.push(problem("CANDIDATE_FILE_UNREADABLE", `候选文件读不出来：${rel}`, rel));
    return null;
  }
  return { sha256: sha256Hex(buf), bytes: buf.length, mode: st.mode & 0o777, crlf: countCrlf(buf) };
}

function secretPatternOf(rel: string): string {
  const base = rel.split("/").pop() ?? rel;
  if (/^\.env/i.test(base)) return ".env*";
  if (/\.(pem|key|p12|pfx|jks|keystore)$/i.test(base)) return "*.pem|*.key|*.p12|*.pfx|*.jks|*.keystore";
  if (/^id_(rsa|dsa|ecdsa|ed25519)$/i.test(base)) return "id_*";
  if (/^credentials/i.test(base)) return "credentials*";
  if (/^secrets?\./i.test(base)) return "secret*.{json,yaml,toml}";
  if (/^\.(git-credentials|npmrc|netrc|pgpass|pypirc|htpasswd)$/i.test(base)) return base;
  return "<private-file>";
}

interface StageInfo {
  mode: number;
  sha: string;
}
function parseStage(buf: Buffer): Map<string, StageInfo> {
  const out = new Map<string, StageInfo>();
  for (const tok of splitZ(buf)) {
    // "<mode> <sha> <stage>\t<path>"
    const tab = tok.indexOf("\t");
    if (tab < 0) continue;
    const meta = tok.slice(0, tab).split(" ");
    const p = tok.slice(tab + 1);
    if (meta.length < 3) continue;
    const mode = Number.parseInt(meta[0], 8);
    if (!Number.isFinite(mode)) continue;
    out.set(p, { mode, sha: meta[1] });
  }
  return out;
}

interface StatusEntry {
  x: string;
  y: string;
  path: string;
  orig?: string;
}
function parseStatus(buf: Buffer): StatusEntry[] {
  const tokens = splitZ(buf);
  const out: StatusEntry[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i];
    if (tok.length < 3) continue;
    const x = tok[0];
    const y = tok[1];
    const p = tok.slice(3);
    const entry: StatusEntry = { x, y, path: p };
    if (x === "R" || x === "C" || y === "R" || y === "C") {
      i += 1;
      if (i < tokens.length) entry.orig = tokens[i];
    }
    out.push(entry);
  }
  return out;
}

function buildShards(entries: readonly CandidateEntry[], problems: CandidateProblem[]): { shards: CandidateShard[] } {
  const shards: CandidateShard[] = [];
  let cur: CandidateEntry[] = [];
  let curBytes = 0;
  const flush = (): void => {
    if (cur.length === 0) return;
    shards.push({ index: shards.length, files: cur.length, bytes: curBytes, entries: cur });
    cur = [];
    curBytes = 0;
  };
  for (const e of entries) {
    if (cur.length > 0 && (cur.length >= MAX_CANDIDATE_SHARD_FILES || curBytes + e.bytes > MAX_CANDIDATE_SHARD_BYTES)) {
      flush();
    }
    cur.push(e);
    curBytes += e.bytes;
  }
  flush();
  if (shards.length > MAX_CANDIDATE_SHARDS) {
    problems.push(problem("CANDIDATE_TOO_LARGE", `候选分片数超上限 ${MAX_CANDIDATE_SHARDS}（本次 ${shards.length}）`));
  }
  return { shards };
}

// ────────────────────────── verifyCandidateIndex ──────────────────────────

export interface CandidateVerifyOptions {
  /**
   * 强制按**目录**枚举（不走 Git）。用于物化缓存：缓存目录常落在某个 Git 项目的 `.工作台/work/` 下，
   * `git -C <cache> rev-parse --show-toplevel` 会命中**外层主仓**——若照 Git 口径枚举，`git ls-files`
   * 会返回外层仓库的清单（空/错误集合），把缓存误判成那个工作树（评审第 3 项实测反例）。
   */
  force_directory?: boolean;
}

/** 现读重新枚举并与索引逐条比对（内容指纹 + 条目）。不改盘。 */
export function verifyCandidateIndex(root: string, index: CandidateIndex, opts: CandidateVerifyOptions = {}): CandidateVerify {
  if (!fs.existsSync(root)) {
    return { status: "missing", current_fingerprint: null, changed: [], missing: [], extra: [], problems: [] };
  }
  const current = inspectCandidateSource({
    root,
    included_uncommitted: index.included_uncommitted,
    // 现读复核只比**内容**：`declared_paths` 的"声明齐全/缺失"判据在**冻结时**已核过（且删除项本就不在盘上，
    // 再核会把合法的删除项误报成"声明缺项"）。这里传 null 跳过声明检查，删除事实由条目 `state` 表达。
    declared_paths: null,
    source_commit: index.source_commit,
    git_repository: index.git_repository,
    ...(opts.force_directory === true ? { force_directory: true } : {}),
  });
  if (current.problems.some((p) => p.code === "CANDIDATE_ROOT_INVALID")) {
    return {
      status: "unreadable",
      current_fingerprint: null,
      changed: [],
      missing: [],
      extra: [],
      problems: current.problems,
    };
  }
  // **任何 fatal / 截断都不能算 valid**：即便条目集合恰好相同，出现链接越界、单文件超限、跟踪秘密冲突
  // 或规模截断都说明这不是一份可信的完整候选（评审第 4 项：verify 只比 fingerprint/changed/missing 会漏判）。
  if (candidateHasFatalProblems(current)) {
    return {
      status: "invalidated",
      current_fingerprint: null,
      changed: [],
      missing: [],
      extra: [],
      problems: current.problems,
    };
  }
  const curMap = new Map(current.entries.map((e) => [e.path, e]));
  const idxMap = new Map(index.entries.map((e) => [e.path, e]));
  const changed: string[] = [];
  const missing: string[] = [];
  const extra: string[] = [];
  for (const e of index.entries) {
    const c = curMap.get(e.path);
    if (c === undefined) {
      // 非 Git 源（如只读物化缓存）无法表达"删除项"：索引声明的删除项**不在盘上**即视为一致；
      // 若它反而又在盘上，则下面按 `changed` 判红。
      if (e.state !== "deleted") missing.push(e.path);
      continue;
    }
    if (c.sha256 !== e.sha256 || c.state !== e.state || c.mode !== e.mode) changed.push(e.path);
  }
  for (const e of current.entries) {
    if (!idxMap.has(e.path)) extra.push(e.path);
  }
  // 有效现读集合 = 现读到的在盘项 + 「索引声明删除且现在确实不在盘上」的项（删除事实参与指纹）
  const deletedAbsent = index.entries.filter((e) => e.state === "deleted" && !curMap.has(e.path));
  const effectiveFingerprint = candidateIndexFingerprint([...current.entries, ...deletedAbsent]);
  const valid = changed.length === 0 && missing.length === 0 && effectiveFingerprint === index.content_fingerprint;
  return {
    status: valid ? "valid" : "invalidated",
    current_fingerprint: effectiveFingerprint,
    changed,
    missing,
    extra,
    problems: current.problems,
  };
}

// ────────────────────────── resolveCandidateSource ──────────────────────────

export interface ResolveCandidateInput {
  root: string;
  work_dir: string;
  index: CandidateIndex;
  source_commit?: string | null;
  git_repository?: string | null;
  /** 可选：`preserveCandidateSource` 产出的恢复材料（非 Git / CRLF 原字节） */
  recovery?: CandidateRecovery | null;
}

/**
 * 确定性来源解析（§6.14 第 5 段）：目录在且相符 → present；目录被回收/不在且来源提交可达 → 只读物化到
 * hash 命名**可再生缓存**后复核（不 checkout）；否则从恢复材料的原字节复原；均不可得 → unknown。
 * **目录在但指纹不符 = tampered（失效），不静默转读 Git/开发目录。**
 */
export function resolveCandidateSource(input: ResolveCandidateInput): CandidateResolution {
  const root = path.resolve(input.root);
  const problems: CandidateProblem[] = [];
  if (fs.existsSync(root)) {
    const v = verifyCandidateIndex(root, input.index);
    if (v.status === "valid") {
      return { status: "present", root, cache_root: null, content_fingerprint: v.current_fingerprint, problems: [] };
    }
    problems.push(
      problem(
        "CANDIDATE_TAMPERED",
        `候选目录存在但内容指纹与索引不符（changed=${v.changed.length}/missing=${v.missing.length}/extra=${v.extra.length}）：` +
          "按失效处理，不静默转读 Git 或开发目录",
      ),
    );
    return { status: "tampered", root: null, cache_root: null, content_fingerprint: null, problems };
  }

  const commit = input.source_commit ?? input.index.source_commit;
  const repo = input.git_repository ?? input.index.git_repository;
  const cacheRoot = cacheDirOf(input.work_dir, input.index);

  if (commit !== null && commit !== "" && repo !== null && gitCommitReachable(repo, commit)) {
    const mat = materializeCommit(repo, commit, cacheRoot);
    if (mat.ok) {
      applyIndexDeletions(cacheRoot, input.index); // 候选声明的删除项：从物化缓存移除（提交里仍在）
      overlayRawEvidence(input.work_dir, cacheRoot, input.recovery ?? null);
      // **强制目录口径**复核缓存：缓存可能在某个 Git 项目里，`git -C <cache>` 会命中外层主仓
      const v = verifyCandidateIndex(cacheRoot, input.index, { force_directory: true });
      if (v.status === "valid") {
        return { status: "recovered", root: cacheRoot, cache_root: cacheRoot, content_fingerprint: v.current_fingerprint, problems: [] };
      }
      problems.push(
        problem(
          "CANDIDATE_SOURCE_UNAVAILABLE",
          `从来源提交 ${commit.slice(0, 12)}… 物化到缓存后复核不符（changed=${v.changed.length}/missing=${v.missing.length}/extra=${v.extra.length}）：` +
            "如实报未知，不拿开发目录兜底",
        ),
      );
      return { status: "unknown", root: null, cache_root: cacheRoot, content_fingerprint: null, problems };
    }
    problems.push(problem("CANDIDATE_SOURCE_UNAVAILABLE", `从提交物化失败：${mat.reason}`));
  }

  if (input.recovery !== null && input.recovery !== undefined && input.recovery.raw_evidence.length > 0) {
    const ok = restoreFromEvidence(input.work_dir, cacheRoot, input.recovery, input.index);
    if (ok) {
      const v = verifyCandidateIndex(cacheRoot, input.index, { force_directory: true });
      if (v.status === "valid") {
        return { status: "recovered", root: cacheRoot, cache_root: cacheRoot, content_fingerprint: v.current_fingerprint, problems: [] };
      }
      problems.push(problem("CANDIDATE_SOURCE_UNAVAILABLE", "从恢复材料复原后复核不符：如实报未知"));
      return { status: "unknown", root: null, cache_root: cacheRoot, content_fingerprint: null, problems };
    }
    problems.push(problem("CANDIDATE_SOURCE_UNAVAILABLE", "恢复材料不足以复原完整候选（缺口见 refused）"));
  }

  problems.push(
    problem(
      "CANDIDATE_SOURCE_UNAVAILABLE",
      "候选目录不在，且来源提交不可达、恢复材料不足：源与证据都取不回，如实报未知/失效（不用开发目录兜底）",
    ),
  );
  return { status: "unknown", root: null, cache_root: null, content_fingerprint: null, problems };
}

/** 可再生缓存目录：workspace 身份/根路径的哈希命名（不把含冒号的 ID 直接当 Windows 目录名） */
export function cacheDirOf(workDir: string, index: CandidateIndex): string {
  const key = sha256Hex(`${index.version}\u0000${index.root}\u0000${index.content_fingerprint}`);
  return path.join(workDir, "candidate-cache", key.slice(0, 32));
}

function gitCommitReachable(repo: string, commit: string): boolean {
  if (!fs.existsSync(path.join(repo, ".git"))) return false;
  const res = runGit(repo, ["cat-file", "-e", `${commit}^{commit}`]);
  return res.ok;
}

function materializeCommit(repo: string, commit: string, dest: string): { ok: boolean; reason: string } {
  const tree = runGit(repo, ["ls-tree", "-r", "-z", commit]);
  if (!tree.ok) return { ok: false, reason: `ls-tree 失败：${tree.error ?? tree.stderr.trim()}` };
  const blobs: { mode: number; sha: string; path: string }[] = [];
  for (const tok of splitZ(tree.stdout)) {
    const tab = tok.indexOf("\t");
    if (tab < 0) continue;
    const meta = tok.slice(0, tab).split(/\s+/);
    const p = tok.slice(tab + 1);
    if (meta.length < 3 || meta[1] !== "blob") continue;
    const rawMode = Number.parseInt(meta[0], 8);
    if (!Number.isFinite(rawMode)) continue;
    blobs.push({ mode: rawMode, sha: meta[2], path: p });
  }
  if (blobs.length === 0) return { ok: true, reason: "" };
  const input = blobs.map((b) => b.sha).join("\n") + "\n";
  const batch = runGit(repo, ["cat-file", "--batch"], input);
  if (!batch.ok) return { ok: false, reason: `cat-file 失败：${batch.error ?? batch.stderr.trim()}` };
  const contents = parseBatch(batch.stdout);
  try {
    fs.mkdirSync(dest, { recursive: true });
  } catch (e) {
    return { ok: false, reason: `建缓存目录失败：${(e as Error).message}` };
  }
  for (const b of blobs) {
    const buf = contents.get(b.sha);
    if (buf === undefined) return { ok: false, reason: `cat-file 未返回 blob ${b.sha.slice(0, 12)}…` };
    const abs = path.join(dest, ...b.path.split("/"));
    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, buf);
      if ((b.mode & 0o111) !== 0) {
        try {
          fs.chmodSync(abs, 0o755);
        } catch {
          /* 平台不支持 chmod：忽略（模式差异由 verify 如实体现） */
        }
      }
    } catch (e) {
      return { ok: false, reason: `写缓存文件失败 ${b.path}：${(e as Error).message}` };
    }
  }
  return { ok: true, reason: "" };
}

/** 取回一批 Git 对象（blob）的**内容摘要**（SHA-256 + 长度）：`oid → {sha256, bytes}`。失败返回空表（调用方按不可证处理） */
function fetchBlobDigests(repo: string, oids: readonly string[]): Map<string, { sha256: string; bytes: number }> {
  const out = new Map<string, { sha256: string; bytes: number }>();
  if (oids.length === 0) return out;
  const batch = runGit(repo, ["cat-file", "--batch"], oids.join("\n") + "\n");
  if (!batch.ok) return out;
  const contents = parseBatch(batch.stdout);
  for (const oid of oids) {
    const buf = contents.get(oid);
    if (buf !== undefined) out.set(oid, { sha256: sha256Hex(buf), bytes: buf.length });
  }
  return out;
}

function parseBatch(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let pos = 0;
  while (pos < buf.length) {
    const nl = buf.indexOf(0x0a, pos);
    if (nl < 0) break;
    const header = buf.slice(pos, nl).toString("utf8");
    pos = nl + 1;
    if (header.endsWith(" missing") || header.endsWith(" ambiguous")) continue;
    const parts = header.split(" ");
    if (parts.length < 3) continue;
    const sha = parts[0];
    const size = Number.parseInt(parts[2], 10);
    if (!Number.isFinite(size) || size < 0) continue;
    const content = buf.slice(pos, pos + size);
    pos += size + 1; // 跳过内容后的换行
    out.set(sha, content);
  }
  return out;
}

/** 把候选声明的删除项从物化缓存移除（提交树里仍在；用删除项这一事实还原候选实际内容） */
function applyIndexDeletions(dest: string, index: CandidateIndex): void {
  for (const e of index.entries) {
    if (e.state !== "deleted") continue;
    try {
      fs.rmSync(path.join(dest, ...e.path.split("/")), { force: true });
    } catch {
      /* 删不掉由后续 verify 如实体现 */
    }
  }
}

function overlayRawEvidence(workDir: string, dest: string, recovery: CandidateRecovery | null): void {
  if (recovery === null || recovery.raw_evidence.length === 0) return;
  for (const raw of recovery.raw_evidence) {
    const bytes = readRawEvidenceEntry(workDir, raw);
    if (bytes === null) continue;
    const abs = path.join(dest, ...raw.path.split("/"));
    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, bytes);
    } catch {
      /* 写失败由后续 verify 如实体现 */
    }
  }
}

function restoreFromEvidence(
  workDir: string,
  dest: string,
  recovery: CandidateRecovery,
  index: CandidateIndex,
): boolean {
  const rawByPath = new Map(recovery.raw_evidence.map((r) => [r.path, r]));
  const present = index.entries.filter((e) => e.state === "present");
  // 覆盖度：**全部** present 条目都必须有原字节证据（"尽量统一保住所有源原字节"）——缺一即不足以复原。
  for (const e of present) {
    if (!rawByPath.has(e.path)) return false;
  }
  try {
    fs.mkdirSync(dest, { recursive: true });
  } catch {
    return false;
  }
  for (const e of present) {
    const raw = rawByPath.get(e.path)!;
    const bytes = readRawEvidenceEntry(workDir, raw);
    if (bytes === null) return false;
    // 逐字节核到索引：内容哈希与长度都要对上（证据现场被改/分块缺失都在此暴露）
    if (sha256Hex(bytes) !== e.sha256 || bytes.length !== e.bytes) return false;
    const abs = path.join(dest, ...e.path.split("/"));
    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, bytes);
    } catch {
      return false;
    }
  }
  // 候选声明的删除项：复原时移除（提交树/物化里可能仍在）
  for (const e of index.entries) {
    if (e.state !== "deleted") continue;
    try {
      fs.rmSync(path.join(dest, ...e.path.split("/")), { force: true });
    } catch {
      /* 删不掉由后续 verify 如实体现 */
    }
  }
  return true;
}

/** 读一条 raw 条目的原字节（`evidence_id` 可能是分块清单包装 id，`readRawEvidence` 会自动拼接） */
function readRawEvidenceEntry(workDir: string, raw: CandidateRecoveryRawEntry): Buffer | null {
  return readRawEvidence(workDir, raw.evidence_id);
}

/**
 * 读一份内容寻址证据的正文（独立核内容地址）。正文可能是：
 *   · `base64:<...>` → 一段原字节分块；
 *   · 分块清单 `{kind:"chunked", chunks:[id...]}` → 按序拼接（大到 64MiB 的索引/原字节也读得回）；
 *   · 其它 → 按 UTF-8 文本。
 */
function readRawEvidence(workDir: string, evidenceId: string): Buffer | null {
  try {
    const file = path.join(workDir, "evidence", `${evidenceId}.json`);
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { content?: unknown };
    if (typeof raw.content !== "string") return null;
    if (sha256Hex(raw.content) !== evidenceId) return null; // 现场被改过 → 不采信
    if (raw.content.startsWith("base64:")) return Buffer.from(raw.content.slice("base64:".length), "base64");
    const parsed = safeJsonObject(raw.content);
    if (parsed !== null && parsed.kind === "chunked" && Array.isArray(parsed.chunks)) {
      const parts: Buffer[] = [];
      for (const id of parsed.chunks as unknown[]) {
        if (typeof id !== "string") return null;
        const b = readRawEvidence(workDir, id);
        if (b === null) return null;
        parts.push(b);
      }
      return Buffer.concat(parts);
    }
    return Buffer.from(raw.content, "utf8");
  } catch {
    return null;
  }
}

function safeJsonObject(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text) as unknown;
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// ────────────────────────── preserveCandidateSource ──────────────────────────

export interface PreserveCandidateInput {
  root: string;
  work_dir: string;
  index: CandidateIndex;
  actor_id: string;
  role?: string;
  version_binding?: CandidateVersionBinding | null;
}

/**
 * 保全候选恢复材料（**只在宿主真实写调用时**）：先现读复核索引与目录相符，再经既有 `putEvidence`
 * 把分片索引与「不可从提交还原」的原字节写成**内容寻址证据**。单文件 >8 MiB 明确拒（列入 refused）。
 * 不写候选目录、不改库；返回恢复材料引用（供 resolve 复原）。
 */
export function preserveCandidateSource(input: PreserveCandidateInput): CandidateRecovery {
  const v = verifyCandidateIndex(input.root, input.index);
  if (v.status !== "valid") {
    throw new Error(
      `候选来源保全前复核未通过（status=${v.status}，changed=${v.changed.length}/missing=${v.missing.length}）：` +
        "先验证再写——不放行保全，避免把不符/漂移的内容写成恢复材料",
    );
  }
  const role = input.role ?? "executor";
  const binding = { revision_kind: "code" as const, revision: input.index.content_fingerprint };

  const shardEvidenceIds: string[] = [];
  for (const shard of input.index.shards) {
    for (const chunk of chunkShardForEvidence(shard)) {
      const content = JSON.stringify({
        version: CANDIDATE_INDEX_VERSION,
        shard: shard.index,
        content_fingerprint: input.index.content_fingerprint,
        entries: chunk,
      });
      const blob = putEvidence(input.work_dir, {
        content,
        kind: "other",
        summary: `候选索引片 ${shard.index}（${chunk.length} 条；指纹 ${input.index.content_fingerprint.slice(0, 12)}…）`,
        created_by: input.actor_id,
        role,
        binding,
      });
      shardEvidenceIds.push(blob.evidence_id);
    }
  }

  const rawEvidence: CandidateRecoveryRawEntry[] = [];
  const refused: CandidateRecoveryRefusal[] = [];
  const presentEntries = input.index.entries.filter((e) => e.state === "present");
  // 逐条**先验证再写**：现读字节必须与索引声明的 sha256/长度逐字节一致（漂移即拒），再落内容寻址证据。
  // 「尽量统一保住所有源原字节」——包括 tracked/unmodified 的条目（filter 会让 raw ≠ blob，只靠 commit
  // 不能逐字节恢复）；任何一条不达标都记 refused，`complete` 随之为 false（**不部分保存后自称完整**）。
  for (const e of presentEntries) {
    const abs = path.join(path.resolve(input.root), ...e.path.split("/"));
    let buf: Buffer;
    try {
      buf = fs.readFileSync(abs);
    } catch {
      refused.push({ path: e.path, bytes: e.bytes, reason: "原字节读不出来" });
      continue;
    }
    if (sha256Hex(buf) !== e.sha256 || buf.length !== e.bytes) {
      refused.push({ path: e.path, bytes: buf.length, reason: "现读字节与索引 sha256/长度不符（漂移），不保全" });
      continue;
    }
    let evidenceId: string;
    try {
      evidenceId = putChunkedBuffer(input.work_dir, buf, {
        actor_id: input.actor_id,
        role,
        binding,
        label: `候选原字节 ${e.path}${e.crlf ? "（含 CRLF）" : ""}`,
      });
    } catch (err) {
      refused.push({ path: e.path, bytes: buf.length, reason: `保全失败：${(err as Error).message}` });
      continue;
    }
    rawEvidence.push({ path: e.path, evidence_id: evidenceId, bytes: buf.length, mode: e.mode, crlf: e.crlf });
  }

  return {
    index_fingerprint: input.index.content_fingerprint,
    shard_evidence_ids: shardEvidenceIds,
    raw_evidence: rawEvidence,
    refused,
    version_binding: input.version_binding ?? null,
    complete: refused.length === 0,
    raw_present_count: presentEntries.length,
  };
}

/** 单条证据正文 ≤8MiB：把索引片按"文件数 + 字节"细分，避免被证据上限拒 */
function chunkShardForEvidence(shard: CandidateShard): CandidateEntry[][] {
  const chunks: CandidateEntry[][] = [];
  let cur: CandidateEntry[] = [];
  let curBytes = 0;
  const flush = (): void => {
    if (cur.length === 0) return;
    chunks.push(cur);
    cur = [];
    curBytes = 0;
  };
  const per = 256;
  const maxBytes = 4 * 1024 * 1024; // 序列化 + JSON 包裹后仍远小于 8MiB
  for (const e of shard.entries) {
    if (cur.length > 0 && (cur.length >= per || curBytes + e.bytes > maxBytes)) flush();
    cur.push(e);
    curBytes += e.bytes;
  }
  flush();
  return chunks.length === 0 ? [[]] : chunks;
}

interface ChunkWriteArgs {
  actor_id: string;
  role: string;
  binding: { revision_kind: "code"; revision: string };
  label: string;
}

/**
 * 把一段字节落成**内容寻址证据**：单块 base64 正文 ≤ 证据上限，超过则切成多块 +
 * 一张**分块清单包装证据**（其内容是 `{chunks:[id...]}`，本身很小）。返回**包装证据 id**——
 * 读取方按同一 id 取回即可自动拼接（大到 64MiB 的索引也不会超单条证据上限）。
 */
function putChunkedBuffer(workDir: string, buf: Buffer, args: ChunkWriteArgs): string {
  const maxRawPerChunk = Math.floor(((MAX_EVIDENCE_BYTES - 32) * 3) / 4);
  const chunkIds: string[] = [];
  if (buf.length === 0) {
    const blob = putEvidence(workDir, {
      content: "base64:",
      kind: "other",
      summary: `${args.label}（空内容）`,
      created_by: args.actor_id,
      role: args.role,
      binding: args.binding,
    });
    chunkIds.push(blob.evidence_id);
  } else {
    for (let off = 0; off < buf.length; off += maxRawPerChunk) {
      const slice = buf.subarray(off, Math.min(off + maxRawPerChunk, buf.length));
      const encoded = `base64:${slice.toString("base64")}`;
      if (Buffer.byteLength(encoded, "utf8") > MAX_EVIDENCE_BYTES) {
        throw new Error(`分块正文超过证据上限 ${MAX_EVIDENCE_BYTES} 字节（切片 ${slice.length} 字节）`);
      }
      const blob = putEvidence(workDir, {
        content: encoded,
        kind: "other",
        summary: `${args.label} 分块 ${chunkIds.length}/${Math.max(1, Math.ceil(buf.length / maxRawPerChunk))}（${slice.length} 字节）`,
        created_by: args.actor_id,
        role: args.role,
        binding: args.binding,
      });
      chunkIds.push(blob.evidence_id);
    }
  }
  const wrapper = JSON.stringify({ kind: "chunked", chunks: chunkIds });
  const wblob = putEvidence(workDir, {
    content: wrapper,
    kind: "other",
    summary: `${args.label} 分块清单（${chunkIds.length} 块，共 ${buf.length} 字节）`,
    created_by: args.actor_id,
    role: args.role,
    binding: args.binding,
  });
  return wblob.evidence_id;
}

// ──────────────────── 索引 / 恢复材料的紧凑引用读写（事件只存引用，≤64KiB） ────────────────────

export interface PersistIndexOptions {
  actor_id: string;
  role?: string;
  version_binding?: CandidateVersionBinding | null;
  /** 一并保全的恢复材料（可选）；给了就把它的紧凑引用写进 `CandidateIndexRef` */
  recovery?: CandidateRecovery | null;
}

/** 把完整索引（可达 64MiB）分块落**内容寻址证据**，返回 ≤64KiB 的紧凑引用（事件里存它，不存完整索引） */
export function persistCandidateIndex(workDir: string, index: CandidateIndex, opts: PersistIndexOptions): CandidateIndexRef {
  const role = opts.role ?? "executor";
  const binding = { revision_kind: "code" as const, revision: index.content_fingerprint };
  const serialized = Buffer.from(JSON.stringify({ version: index.version, kind: "candidate-index", index }), "utf8");
  const indexEvidenceId = putChunkedBuffer(workDir, serialized, {
    actor_id: opts.actor_id,
    role,
    binding,
    label: `候选完整索引（指纹 ${index.content_fingerprint.slice(0, 12)}…）`,
  });
  let recoveryEvidenceId: string | null = null;
  if (opts.recovery !== undefined && opts.recovery !== null) {
    recoveryEvidenceId = persistCandidateRecovery(workDir, opts.recovery, { actor_id: opts.actor_id, role }).recovery_evidence_id;
  }
  const ref: CandidateIndexRef = {
    version: index.version,
    index_fingerprint: index.content_fingerprint,
    index_evidence_id: indexEvidenceId,
    recovery_evidence_id: recoveryEvidenceId,
    entry_count: index.entries.length,
    shard_count: index.shard_count,
    ref_bytes: 0,
  };
  ref.ref_bytes = Buffer.byteLength(JSON.stringify(ref), "utf8");
  if (ref.ref_bytes > MAX_CANDIDATE_EVENT_REF_BYTES) {
    throw new Error(`候选索引引用 ${ref.ref_bytes} 字节超过事件引用上限 ${MAX_CANDIDATE_EVENT_REF_BYTES}：不把完整索引塞进事件`);
  }
  return ref;
}

/**
 * 解析冻结事件里的 `candidate_index_revision`：
 *   · 合法 `CandidateIndexRef` JSON（统一后的规范形态）→ 取回引用；
 *   · 旧格式（裸内容指纹/其它串）→ null（调用方按**旧口径**处理，不臆造成引用）。
 * 只做形态校验，不读盘、不核指纹（取回与核指纹在 `readCandidateIndex`）。
 */
export function parseCandidateIndexRef(text: string | null | undefined): CandidateIndexRef | null {
  if (typeof text !== "string" || text.trim() === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const r = parsed as Record<string, unknown>;
  if (r.version !== CANDIDATE_INDEX_VERSION) return null;
  if (typeof r.index_fingerprint !== "string" || !SHA256_HEX_RE.test(r.index_fingerprint)) return null;
  if (typeof r.index_evidence_id !== "string" || r.index_evidence_id === "") return null;
  if (r.recovery_evidence_id !== null && typeof r.recovery_evidence_id !== "string") return null;
  return r as unknown as CandidateIndexRef;
}

/** 从紧凑引用取回完整索引并**核内容指纹**（引用与索引/现场不符即拒，不采信畸形引用） */
export function readCandidateIndex(workDir: string, ref: CandidateIndexRef): CandidateIndex {
  const bytes = readRawEvidence(workDir, ref.index_evidence_id);
  if (bytes === null) throw new Error(`候选索引证据读不回或内容地址对不上：${ref.index_evidence_id}`);
  let parsed: { kind?: unknown; index?: CandidateIndex };
  try {
    parsed = JSON.parse(bytes.toString("utf8")) as { kind?: unknown; index?: CandidateIndex };
  } catch (e) {
    throw new Error(`候选索引证据不是合法 JSON：${(e as Error).message}`);
  }
  if (parsed.kind !== "candidate-index" || parsed.index === undefined) throw new Error("候选索引证据格式不对（不是 candidate-index）");
  const index = parsed.index;
  const recomputed = candidateIndexFingerprint(index.entries);
  if (recomputed !== ref.index_fingerprint || index.content_fingerprint !== ref.index_fingerprint) {
    throw new Error(
      `候选索引内容指纹与引用不符（引用 ${ref.index_fingerprint.slice(0, 12)}…，重算 ${recomputed.slice(0, 12)}…）：不采信`,
    );
  }
  return index;
}

export interface PersistRecoveryOptions {
  actor_id: string;
  role?: string;
}

/** 把恢复材料（原字节证据 id 列表）序列化分块落证据，返回紧凑引用 */
export function persistCandidateRecovery(workDir: string, recovery: CandidateRecovery, opts: PersistRecoveryOptions): CandidateRecoveryRef {
  const role = opts.role ?? "executor";
  const binding = { revision_kind: "code" as const, revision: recovery.index_fingerprint };
  const serialized = Buffer.from(JSON.stringify({ version: CANDIDATE_INDEX_VERSION, kind: "candidate-recovery", recovery }), "utf8");
  const evidenceId = putChunkedBuffer(workDir, serialized, {
    actor_id: opts.actor_id,
    role,
    binding,
    label: `候选恢复材料（指纹 ${recovery.index_fingerprint.slice(0, 12)}…）`,
  });
  const complete = recovery.complete ?? recovery.refused.length === 0;
  const ref: CandidateRecoveryRef = {
    version: CANDIDATE_INDEX_VERSION,
    index_fingerprint: recovery.index_fingerprint,
    recovery_evidence_id: evidenceId,
    raw_count: recovery.raw_evidence.length,
    refused_count: recovery.refused.length,
    complete,
    ref_bytes: 0,
  };
  ref.ref_bytes = Buffer.byteLength(JSON.stringify(ref), "utf8");
  if (ref.ref_bytes > MAX_CANDIDATE_EVENT_REF_BYTES) {
    throw new Error(`候选恢复引用 ${ref.ref_bytes} 字节超过事件引用上限 ${MAX_CANDIDATE_EVENT_REF_BYTES}`);
  }
  return ref;
}

/** 从紧凑引用取回恢复材料并核指纹（拒不完整或其他指纹的引用冒充可复原） */
export function readCandidateRecovery(workDir: string, ref: CandidateRecoveryRef): CandidateRecovery {
  const bytes = readRawEvidence(workDir, ref.recovery_evidence_id);
  if (bytes === null) throw new Error(`候选恢复材料证据读不回：${ref.recovery_evidence_id}`);
  let parsed: { kind?: unknown; recovery?: CandidateRecovery };
  try {
    parsed = JSON.parse(bytes.toString("utf8")) as { kind?: unknown; recovery?: CandidateRecovery };
  } catch (e) {
    throw new Error(`候选恢复材料不是合法 JSON：${(e as Error).message}`);
  }
  if (parsed.kind !== "candidate-recovery" || parsed.recovery === undefined) throw new Error("候选恢复材料格式不对（不是 candidate-recovery）");
  if (parsed.recovery.index_fingerprint !== ref.index_fingerprint) {
    throw new Error(
      `候选恢复材料指纹与引用不符（引用 ${ref.index_fingerprint.slice(0, 12)}…，材料 ${parsed.recovery.index_fingerprint.slice(0, 12)}…）`,
    );
  }
  return parsed.recovery;
}

// 保留 SHA256_HEX_RE 供外部/测试引用（严格 64hex 判据集中在 evidence.ts，此处仅声明意图）
export const isCandidateSha256Hex = (v: unknown): v is string => typeof v === "string" && SHA256_HEX_RE.test(v);

// 接线说明：worker A 的 `workspaces.ts` 已把 `inspectCandidateSource` 直接用作默认源检查器
// （`WorkspaceSourceInspector` 的 `defaultInspect`），因此本模块**不**反向 import `workspaces.ts`
// （否则 candidateSource ↔ workspaces 成环）。冻结/试用提升的宿主实测与锁内重核都经那条默认实现走本模块。
