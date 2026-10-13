// 本地 Git 自动收尾引擎（PLAN V09-66；**DESIGN.md §6.14 第 9 段是唯一规范**）。
//
// 职责边界（为什么长这样）：
//   · 它只做「把**已受验**的候选内容提交成本地 Git 提交，并**真实核验**提交 == 受验输入」这一件事；
//     授权、当前技术验证/独审状态、冻结候选都**来自宿主传入的中央事实**（`FinalizeFactSource`），
//     引擎**不自己读账本、不自己发项目身份**，也**不接受调用方的自报通过**（见 `evaluateFinalizeEligibility`）。
//   · 它**不 push、不改远端、不改 Git 配置、不代签用户 Gate、不 `git init`、不 reset/restore/checkout**。
//   · 只读能力仍归 `src/server/gitStatus.ts`（其只读白名单/写子命令黑名单一字未动）；本模块自己持有
//     写子命令的**固定 argv** 与运行期闸门 `assertNoForbiddenGitArgs`，不给只读路径加白。
//   · 结果与中央登记解耦：引擎返回 `association`，由宿主经**既有唯一写口**登记；引擎不写账本、不新建台账、
//     不复制原证据（原始字节的保全复用既有中央内容寻址机制；这里只返回 raw oid / sha256 与规范化标记）。
//
// 契约要点（逐条对应 §6.14 第 9 段）：
//   · 提交内容必须覆盖该已验版本相对预期基准 HEAD 的**全部**获准修改（含新增与删除）；无关已暂存内容
//     明确拒绝并**保留现场**（`REFUSED_UNRELATED_STAGED`，发生在任何写之前）。
//   · 用显式路径 + NUL pathspec + `--only` 精确暂存与提交，**保留用户 hook**；不用 `-A`/`-a`/`--allow-empty`/
//     `--no-verify`/`commit-tree`，不改 Git 配置绕过语义。
//   · 提交后核：parent 是预期基准、分支未换、HEAD 正是本次提交；`diff(基准,提交)` 恰等于授权改动集合；
//     完整新树 == 预期基准树 + 已验修改；逐 blob/mode 与受验字节按属性预测一致；受验工作区与无关 index 未变。
//     **不把整棵树当改动集合**，**不把正常 HEAD 前进误报漂移**；hook 只改 index / 注入无关路径 / 改源文件都必抓。
//   · CRLF/attributes 允许 raw ≠ blob：分别记录工作区原始字节指纹与入库 blob 指纹，**不改 Git 配置硬凑相等**，
//     也不因此判失败；需要逐字节复原时靠既有内容寻址保管处（本模块不做自动覆盖工作区的恢复）。
//   · 幂等：提交消息带确定性 `finalize_id`；响应/回执丢失后的重试**限量查找**并重核 parent/可达性/完整树/
//     工作区/候选身份，全部相符才复用；**不凭尾注信任提交**。同内容已在 HEAD 如实返回无需提交，不造空提交。
//   · **重试/复用与首次提交用同一套只读校验**：复用旧提交的前提不只是"旧提交本身正确"，还必须
//     "**当前工作区仍等于该受验候选**"——实际 `diff(基准)` + 非 ignored untracked 的改动集合与授权集合
//     必须一致，无关已暂存/未验新增/候选漂移一律拒绝且不产生新提交、不改现场。
//   · 只读枚举（`status`/`ls-files`/`diff`/`ls-tree`/`log`/`show`）非零退出**fail closed**：不把失败的
//     stdout 当空集合（那会假 noop/假 reused/假"无改动"），而是记录出错命令与 exit 后明确拒绝/失败。
//   · Git 非零退出 / 资格与源漂移 / 回执失败分别如实返回；已有真实提交但后验失败时说明**提交已产生、不自动撤销**。
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ───────────────────────────── 0. 常量 ─────────────────────────────

/** 结果口径标签：改这里就是改「什么算同一次收尾」 */
export const FINALIZE_SCHEMA = "git-finalize-v1";

export const DEFAULT_FINALIZE_TIMEOUT_MS = 180_000;
export const DEFAULT_FINALIZE_MAX_BUFFER = 64 * 1024 * 1024;

/** 幂等复用扫描的**有界**范围：只看 HEAD 最近这么多条提交（够覆盖"刚提交完就丢回执"的重试） */
export const REUSE_SCAN_LIMIT = 200;
/** 单次结果里点名无关暂存路径的上限（有界报告，不是全量倾倒） */
export const MAX_REPORT_PATHS = 20;
/** 单次结果里后验失败明细条目的上限（总数仍在 `detail.failure_count` 里） */
export const MAX_FAILURE_NOTES = 500;
/** 单次结果里点名的枚举故障条数上限（总数仍在 `detail.enumeration_failure_count` 里） */
export const MAX_ENUMERATION_FAILURES = 20;

/** 工作区快照上限（有界：超了如实拒绝，不做全盘散列） */
export const DEFAULT_WORKSPACE_FILE_LIMIT = 20_000;
export const DEFAULT_WORKSPACE_BYTE_LIMIT = 512 * 1024 * 1024;

/** 允许触发本地收尾的角色（§6.14 第 9 段：executor 须核真实任务/工作区授权；coordinator 可对已授权批次收尾） */
export const FINALIZE_ALLOWED_ROLES: readonly string[] = ["executor", "coordinator"];

/** 提交消息尾注（确定性检索键；**只是检索键，不是证据**） */
export const FINALIZE_TRAILER = {
  finalize_id: "Tatai-Finalize",
  candidate: "Tatai-Candidate",
  base: "Tatai-Base",
} as const;

/** 本模块唯一允许出现的 git 子命令（写子命令只在这两个里） */
const ALLOWED_SUBCOMMANDS: readonly string[] = [
  "add",
  "commit",
  "hash-object",
  "rev-parse",
  "rev-list",
  "ls-files",
  "ls-tree",
  "cat-file",
  "diff",
  "diff-tree",
  "status",
  "log",
  "show",
];

/**
 * 明令禁止出现在 argv 里的词元：**运行期闸门**（不是"扫源码找字符串"）。
 * 覆盖 §6.14 第 9 段点名的绕过手段与任何改配置/改历史/换工作树的入口。
 */
const FORBIDDEN_TOKENS: readonly string[] = [
  "-a",
  "-A",
  "--all",
  "--allow-empty",
  "--no-verify",
  "--no-gpg-sign",
  "--amend",
  "--force",
  "-f",
  "--hard",
  "--soft",
  "--mixed",
  "-c",
  "--config",
  "--global",
  "--system",
  "-C",
  "--work-tree",
  "--git-dir",
  "--bare",
  "--no-filters",
  "--pathspec-from-file=/dev/null",
  "push",
  "pull",
  "fetch",
  "checkout",
  "switch",
  "restore",
  "reset",
  "clean",
  "stash",
  "init",
  "commit-tree",
  "update-ref",
  "update-index",
  "write-tree",
  "read-tree",
  "merge",
  "rebase",
  "cherry-pick",
  "revert",
  "gc",
  "prune",
  "config",
  "filter-branch",
  "fast-import",
  "replace",
  "symbolic-ref",
  "worktree",
  "remote",
  "submodule",
  "reflog",
  "am",
];

// ───────────────────────────── 1. 类型 ─────────────────────────────

export type FinalizeChangeStatus = "added" | "modified" | "deleted" | "typechange";
export type FinalizeStatus = "committed" | "reused" | "noop_up_to_date" | "refused" | "failed";

export type FinalizeRefusalCode =
  | "INVALID_INPUT"
  | "NOT_A_GIT_REPOSITORY"
  | "NON_GIT_SNAPSHOT_NO_COMMIT"
  | "WORKSPACE_ROOT_INVALID"
  | "WORKSPACE_NOT_REPO_ROOT"
  | "GIT_DIR_INVALID"
  | "WORKSPACE_MISMATCH"
  | "NOT_AUTHORIZED"
  | "NOT_VERIFIED"
  | "NOT_INDEPENDENTLY_AUDITED"
  | "AUDIT_REVIEWER_IS_AUTHOR"
  | "FINALIZE_NOT_PERMITTED"
  | "CANDIDATE_UNRESOLVED"
  | "CANDIDATE_TAMPERED"
  | "CHANGE_SET_MISMATCH"
  | "OUT_OF_SCOPE_CHANGE"
  | "MISSING_AUTHORIZED_CHANGE"
  | "REFUSED_UNRELATED_STAGED"
  | "WORKSPACE_CONFLICTED"
  | "WORKSPACE_TOO_LARGE"
  | "HEAD_DRIFT"
  | "BRANCH_DRIFT"
  | "CONCURRENT_BUSY"
  | "COMMIT_FAILED"
  | "COMMIT_NO_CHANGES"
  | "POST_VERIFY_FAILED"
  | "RECEIPT_REPLAY_MISMATCH"
  | "GIT_ENUMERATION_FAILED"
  | "INTERNAL_ERROR";

export const FINALIZE_REFUSAL_CODES: readonly FinalizeRefusalCode[] = [
  "INVALID_INPUT",
  "NOT_A_GIT_REPOSITORY",
  "NON_GIT_SNAPSHOT_NO_COMMIT",
  "WORKSPACE_ROOT_INVALID",
  "WORKSPACE_NOT_REPO_ROOT",
  "GIT_DIR_INVALID",
  "WORKSPACE_MISMATCH",
  "NOT_AUTHORIZED",
  "NOT_VERIFIED",
  "NOT_INDEPENDENTLY_AUDITED",
  "AUDIT_REVIEWER_IS_AUTHOR",
  "FINALIZE_NOT_PERMITTED",
  "CANDIDATE_UNRESOLVED",
  "CANDIDATE_TAMPERED",
  "CHANGE_SET_MISMATCH",
  "OUT_OF_SCOPE_CHANGE",
  "MISSING_AUTHORIZED_CHANGE",
  "REFUSED_UNRELATED_STAGED",
  "WORKSPACE_CONFLICTED",
  "WORKSPACE_TOO_LARGE",
  "HEAD_DRIFT",
  "BRANCH_DRIFT",
  "CONCURRENT_BUSY",
  "COMMIT_FAILED",
  "COMMIT_NO_CHANGES",
  "POST_VERIFY_FAILED",
  "RECEIPT_REPLAY_MISMATCH",
  "GIT_ENUMERATION_FAILED",
  "INTERNAL_ERROR",
];

/** 该候选相对基准的实际改动（**完整集合**，不是路径交集） */
export interface FinalizeChangeEntry {
  /** 仓库根相对 POSIX 路径 */
  path: string;
  status: FinalizeChangeStatus;
  /** 受验**原始字节** sha256（deleted 为 null） */
  sha256: string | null;
  /** "100644" / "100755" / "120000"（deleted 为 null） */
  mode: string | null;
  /** 原始字节长度（deleted 为 null；给出则一并核对） */
  size: number | null;
}

/** 完整候选索引条目（给出则逐条核工作区字节；与逐检查 source_manifest 是两件事） */
export interface FinalizeIndexEntry {
  path: string;
  sha256: string;
  size: number;
  mode: string;
}

/**
 * 中央事实 grant：**由宿主读唯一写口/账本后填入**。
 * 引擎把它当作"这次收尾的授权与输入"，并对其**重跑资格判据**——调用方不能自报通过。
 */
export interface FinalizeGrant {
  project_id: string;
  task_id: string;
  workspace_id: string;
  /** 冻结/登记工作区的**绝对**路径（引擎以此作 cwd） */
  root: string;
  /** Git 目录绝对路径；给出则必须 == `rev-parse --absolute-git-dir` */
  git_dir?: string | null;
  workspace_kind: "dev" | "trial" | "candidate" | "unknown";
  workspace_status: "preparing" | "frozen" | "retired" | "unknown";
  source_kind: "directory" | "git_worktree" | "git_commit" | "content_snapshot" | "unknown";
  /** 授权判据是「存在有效授权记录」，**不因任务转入完成态而失效**（§6.14 第 9 段） */
  authorized: boolean;
  authorization_ref: string | null;
  technical_verified: boolean;
  independent_audit_passed: boolean;
  audit_reviewer_id: string | null;
  task_author_id: string | null;
  candidate_kind: "candidate_index" | "content_snapshot" | "unknown";
  candidate_fingerprint: string | null;
  candidate_base_head: string | null;
  candidate_branch: string | null;
  allow_local_commit: boolean;
  changes: FinalizeChangeEntry[];
  full_index?: FinalizeIndexEntry[];
  evidence_refs: string[];
}

export interface FinalizeGrantQuery {
  project_id: string;
  task_id: string;
  workspace_id: string;
  actor: { id: string; role: string };
}

/** 中央事实源（宿主实现；引擎不自带事实库） */
export interface FinalizeFactSource {
  resolveFinalizeGrant(query: FinalizeGrantQuery): Promise<FinalizeGrant> | FinalizeGrant;
}

export interface FinalizeRequest {
  project_id: string;
  task_id: string;
  workspace_id: string;
  actor: { id: string; role: string };
  subject: string;
  body?: string;
  /** 省略则由 `computeFinalizeId` 按稳定输入派生 */
  finalize_id?: string;
  /** 宿主实际观测到的 cwd；给出则必须 == grant.root */
  expected_root?: string;
  limits?: { timeout_ms?: number; max_buffer?: number };
}

export interface FinalizeInput {
  request: FinalizeRequest;
  facts: FinalizeFactSource;
}

export interface FinalizeEligibility {
  eligible: boolean;
  code: FinalizeRefusalCode | null;
  reasons: string[];
  missing: string[];
}

export interface FinalizeIdSeed {
  project_id: string;
  task_id: string;
  workspace_id: string;
  candidate_fingerprint: string;
  base_head: string;
}

export interface FinalizeMessageInput {
  subject: string;
  body?: string;
  finalize_id: string;
  candidate_fingerprint: string;
  base_head: string;
}

export interface FinalizeTrailers {
  finalize_id: string | null;
  candidate: string | null;
  base: string | null;
}

export interface FinalizeBlobRecord {
  path: string;
  status: FinalizeChangeStatus;
  mode: string | null;
  raw_sha256: string | null;
  raw_oid: string | null;
  canonical_oid: string | null;
  committed_oid: string | null;
  blob_sha256: string | null;
  /** true = 工作区原始字节 ≠ 入库 blob（CRLF/attributes/filter 规范化） */
  normalized: boolean;
}

export interface FinalizeChecks {
  base_head_match: boolean;
  branch_match: boolean;
  staged_unrelated_absent: boolean;
  candidate_bytes_match: boolean;
  change_set_matches_workspace: boolean;
  commit_range_exact: boolean;
  commit_tree_exact: boolean;
  commit_blobs_canonical: boolean;
  index_matches_commit: boolean;
  worktree_unchanged: boolean;
  head_is_commit: boolean;
  parent_is_base: boolean;
  unrelated_index_unchanged: boolean;
  other_worktree_unchanged: boolean;
  failures: string[];
}

export interface FinalizeAssociation {
  project_id: string;
  task_id: string;
  workspace_id: string;
  finalize_id: string;
  commit: string;
  tree: string;
  parent: string;
  branch: string;
  candidate_fingerprint: string;
  base_head: string;
  authorization_ref: string | null;
  evidence_refs: string[];
  blobs: Array<{ path: string; mode: string | null; raw_sha256: string | null; blob_oid: string | null; normalized: boolean }>;
}

export interface FinalizeResult {
  schema: string;
  status: FinalizeStatus;
  code: FinalizeRefusalCode | null;
  message: string;
  finalize_id: string;
  accepted: boolean;
  commit: string | null;
  tree: string | null;
  parent: string | null;
  branch: string | null;
  git: { cwd: string; git_dir: string | null; git_version: string | null };
  changes: FinalizeChangeEntry[];
  blobs: FinalizeBlobRecord[];
  checks: FinalizeChecks | null;
  association: FinalizeAssociation | null;
  side_effects: { commit_created: boolean; worktree_restored: boolean; index_restored: boolean; reset_performed: boolean };
  commands: string[];
  detail: Record<string, unknown>;
}

// ───────────────────────────── 2. 运行期闸门与纯工具 ─────────────────────────────

/**
 * argv 闸门：子命令必须在允许集里，且**任何位置**不得出现被明令禁止的词元。
 * 与 `gitStatus.ts` 的只读黑名单同精神、不同用途：那边防"只读探测里混进写"，这边防"收尾里混进绕过"。
 */
export function assertNoForbiddenGitArgs(argv: readonly string[]): void {
  if (!Array.isArray(argv) || argv.length === 0) throw new Error("git argv 不能为空");
  const sub = argv[0];
  if (typeof sub !== "string" || sub.startsWith("-")) throw new Error(`git argv 必须以子命令开头，收到 ${JSON.stringify(sub)}`);
  if (!ALLOWED_SUBCOMMANDS.includes(sub)) throw new Error(`收尾引擎不允许的子命令：${JSON.stringify(sub)}`);
  for (const token of argv) {
    if (typeof token !== "string") throw new Error("git argv 只接受字符串");
    if (FORBIDDEN_TOKENS.includes(token)) throw new Error(`收尾引擎禁止的参数：${JSON.stringify(token)}`);
  }
}

/** 确定性幂等键（检索键，不是证据）：同一 (项目,任务,工作区,候选指纹,基准) → 同一 finalize_id */
export function computeFinalizeId(seed: FinalizeIdSeed): string {
  const canon = JSON.stringify({
    schema: FINALIZE_SCHEMA,
    project_id: seed.project_id,
    task_id: seed.task_id,
    workspace_id: seed.workspace_id,
    candidate_fingerprint: seed.candidate_fingerprint,
    base_head: seed.base_head,
  });
  return crypto.createHash("sha256").update(canon).digest("hex").slice(0, 32);
}

export function buildFinalizeMessage(input: FinalizeMessageInput): string {
  const lines: string[] = [input.subject.trim()];
  if (typeof input.body === "string" && input.body.trim().length > 0) lines.push("", input.body.trim());
  lines.push("", `${FINALIZE_TRAILER.finalize_id}: ${input.finalize_id}`);
  lines.push(`${FINALIZE_TRAILER.candidate}: ${input.candidate_fingerprint}`);
  lines.push(`${FINALIZE_TRAILER.base}: ${input.base_head}`);
  return lines.join("\n");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function parseFinalizeTrailers(message: string): FinalizeTrailers {
  const grab = (key: string): string | null => {
    const m = message.match(new RegExp(`^${escapeRegExp(key)}:[ \\t]*(\\S+)[ \\t]*$`, "m"));
    return m === null ? null : m[1];
  };
  return {
    finalize_id: grab(FINALIZE_TRAILER.finalize_id),
    candidate: grab(FINALIZE_TRAILER.candidate),
    base: grab(FINALIZE_TRAILER.base),
  };
}

function sha256Hex(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}
const SHA256_RE = /^[0-9a-f]{64}$/;
const OID_RE = /^[0-9a-f]{40,64}$/;
const MODE_RE = /^(100644|100755|120000|160000)$/;

function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

function normalizeAbsPath(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function samePath(a: string, b: string): boolean {
  try {
    return fs.realpathSync.native(a) === fs.realpathSync.native(b);
  } catch {
    return normalizeAbsPath(a) === normalizeAbsPath(b);
  }
}

/** 候选路径口径：仓库根相对 POSIX，禁绝对/盘符/`..`/反斜杠/`.git` 首段 */
function validateRelPath(rel: unknown): string | null {
  if (typeof rel !== "string" || rel.length === 0) return null;
  if (rel.startsWith("/") || rel.startsWith("\\")) return null;
  if (/^[A-Za-z]:/.test(rel)) return null;
  if (rel.includes("\\")) return null;
  const parts = rel.split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) return null;
  if (parts[0] === ".git") return null;
  return rel;
}

function absOf(root: string, rel: string): string {
  return path.join(root, ...rel.split("/"));
}

// ───────────────────────────── 3. 资格判据（纯函数） ─────────────────────────────

/**
 * 由**真实中央事实**（grant）派生资格。引擎/宿主都调它；调用方无法通过自报布尔通过，
 * 因为 `FinalizeGrant` 的字段就是"存在有效授权记录/技术验证与独审状态/冻结候选"的读数，
 * 宿主必须从唯一写口与账本读出（缺字段应给 `false`/`unknown`，不得回退写路由）。
 */
export function evaluateFinalizeEligibility(
  grant: FinalizeGrant | null | undefined,
  actor: { id: string; role: string } | null | undefined,
): FinalizeEligibility {
  const reasons: string[] = [];
  const missing: string[] = [];
  const fail = (code: FinalizeRefusalCode): FinalizeEligibility => ({ eligible: false, code, reasons, missing });
  if (grant === null || grant === undefined) {
    return { eligible: false, code: "NOT_AUTHORIZED", reasons: ["没有中央事实 grant（宿主未解析授权）"], missing: ["grant"] };
  }
  if (actor === null || actor === undefined || typeof actor.id !== "string" || actor.id.length === 0) {
    return { eligible: false, code: "NOT_AUTHORIZED", reasons: ["调用者身份未知"], missing: ["actor.id"] };
  }
  if (!FINALIZE_ALLOWED_ROLES.includes(actor.role)) {
    reasons.push(`角色 ${JSON.stringify(actor.role)} 不得触发本地收尾（只允许 ${FINALIZE_ALLOWED_ROLES.join("/")}）`);
    return fail("NOT_AUTHORIZED");
  }
  if (grant.authorized !== true || typeof grant.authorization_ref !== "string" || grant.authorization_ref.length === 0) {
    reasons.push("没有有效授权记录（authorized=false 或缺 authorization_ref）");
    return fail("NOT_AUTHORIZED");
  }
  if (grant.workspace_status === "retired") {
    reasons.push("工作区已回收（retired）：不得对已回收工作区收尾");
    return fail("FINALIZE_NOT_PERMITTED");
  }
  if (grant.technical_verified !== true) {
    reasons.push("技术验证未通过或未绑定同一候选");
    missing.push("technical_verified");
    return fail("NOT_VERIFIED");
  }
  if (grant.independent_audit_passed !== true) {
    reasons.push("独立审查未通过");
    missing.push("independent_audit_passed");
    return fail("NOT_INDEPENDENTLY_AUDITED");
  }
  if (
    typeof grant.audit_reviewer_id === "string" &&
    typeof grant.task_author_id === "string" &&
    grant.audit_reviewer_id === grant.task_author_id
  ) {
    reasons.push("独审者与作者同一人：独审不成立");
    return fail("AUDIT_REVIEWER_IS_AUTHOR");
  }
  if (grant.candidate_kind === "content_snapshot" || grant.source_kind === "content_snapshot") {
    reasons.push("非 Git 项目用可核验内容快照，不擅自本地提交（也不 git init）");
    return fail("NON_GIT_SNAPSHOT_NO_COMMIT");
  }
  if (grant.candidate_kind !== "candidate_index") {
    reasons.push(`候选种类未解析（candidate_kind=${JSON.stringify(grant.candidate_kind)}）`);
    missing.push("candidate_kind");
    return fail("CANDIDATE_UNRESOLVED");
  }
  if (grant.allow_local_commit !== true) {
    reasons.push("该候选/工作区未获本地提交许可（allow_local_commit=false）");
    return fail("FINALIZE_NOT_PERMITTED");
  }
  if (typeof grant.candidate_fingerprint !== "string" || grant.candidate_fingerprint.length === 0) {
    reasons.push("候选内容指纹缺失");
    missing.push("candidate_fingerprint");
    return fail("CANDIDATE_UNRESOLVED");
  }
  if (typeof grant.candidate_base_head !== "string" || grant.candidate_base_head.length === 0) {
    reasons.push("预期基准 HEAD 缺失（不得用当前 HEAD 顶替）");
    missing.push("candidate_base_head");
    return fail("CANDIDATE_UNRESOLVED");
  }
  if (!Array.isArray(grant.changes)) {
    reasons.push("候选改动集合缺失");
    missing.push("changes");
    return fail("CANDIDATE_UNRESOLVED");
  }
  return { eligible: true, code: null, reasons, missing };
}

// ───────────────────────────── 4. 进程执行 ─────────────────────────────

interface Exec {
  root: string;
  timeoutMs: number;
  maxBuffer: number;
  commands: string[];
  /**
   * 只读**枚举**命令的非零退出记录。这些命令的 stdout 在失败时不可当「空集合」用
   * （否则会假 noop／假 reused／假「工作区无改动」），一律 fail closed，由调用方转成拒绝/失败。
   */
  enumeration_failures: EnumerationFailure[];
}

interface EnumerationFailure {
  command: string;
  exit: number | null;
  timed_out: boolean;
  stderr: string;
}

interface GitRun {
  status: number | null;
  stdout: Buffer;
  stderr: string;
  spawn_error: string | null;
  timed_out: boolean;
}

// @types/node 未给 `encoding: "buffer"`（Node 支持的 Buffer 形态）写重载；这里做一次收口的类型转换。
type ExecCallback = (error: (Error & { code?: unknown; killed?: boolean; signal?: unknown }) | null, stdout: Buffer, stderr: Buffer) => void;
const execFileBuffer = execFile as unknown as (
  file: string,
  args: readonly string[],
  options: Record<string, unknown>,
  cb: ExecCallback,
) => unknown;

let cachedGitVersion: string | null | undefined;
/** 本机 git 版本（进结果便于取证）；失败如实 null，不阻塞收尾 */
async function gitVersion(cwd: string, timeoutMs: number): Promise<string | null> {
  if (cachedGitVersion !== undefined) return cachedGitVersion;
  cachedGitVersion = await new Promise<string | null>((resolve) => {
    execFileBuffer(
      "git",
      ["--version"],
      { cwd, shell: false, windowsHide: true, timeout: timeoutMs, encoding: "buffer", env: gitEnv() },
      (error, stdout) => {
        if (error !== null) {
          resolve(null);
          return;
        }
        const out = (Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout ?? ""), "utf8")).toString("utf8").trim();
        resolve(out.length > 0 ? out : null);
      },
    );
  });
  return cachedGitVersion;
}

function gitEnv(): Record<string, string | undefined> {
  return {
    ...process.env,
    // 语义：不弹交互凭据、不分页、不把路径当 pathspec magic（空格/中文/前导 `-`/glob 字符都按字面）
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
    GIT_EDITOR: "true",
    GIT_LITERAL_PATHSPECS: "1",
    // 关掉"可选锁"刷新：读操作不因 status 之类的可选刷新改写 index（提交所需的锁照常获取）
    GIT_OPTIONAL_LOCKS: "0",
  };
}

function runGit(exec: Exec, argv: readonly string[], input?: Buffer): Promise<GitRun> {
  assertNoForbiddenGitArgs(argv);
  exec.commands.push(`git -C ${exec.root} ${argv.join(" ")}`);
  const options: Record<string, unknown> = {
    cwd: exec.root,
    shell: false,
    windowsHide: true,
    timeout: exec.timeoutMs,
    maxBuffer: exec.maxBuffer,
    encoding: "buffer",
    env: gitEnv(),
  };
  return new Promise((resolve) => {
    let settled = false;
    const child = execFileBuffer("git", ["-C", exec.root, ...argv], options, (error, stdout, stderr) => {
      if (settled) return;
      settled = true;
      const out = Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout ?? ""), "utf8");
      const err = Buffer.isBuffer(stderr) ? stderr : Buffer.from(String(stderr ?? ""), "utf8");
      if (error === null) {
        resolve({ status: 0, stdout: out, stderr: err.toString("utf8"), spawn_error: null, timed_out: false });
        return;
      }
      const code = typeof error.code === "number" ? error.code : null;
      const timedOut = error.killed === true || (error as { signal?: unknown }).signal === "SIGTERM";
      resolve({
        status: code,
        stdout: out,
        stderr: err.toString("utf8"),
        spawn_error: code === null ? error.message : null,
        timed_out: timedOut,
      });
    }) as unknown as { stdin?: { on(event: string, cb: () => void): void; end(chunk?: Buffer): void } | null } | null;
    // `execFile`（异步）没有 `input` 选项：显式把字节写进 stdin 并关掉它。
    // 不关 stdin 会让 `hash-object --stdin` 这类命令一直等到超时（曾经的实测踩坑）。
    const stdin = child?.stdin ?? null;
    if (stdin === null) return;
    stdin.on("error", () => {
      /* EPIPE：子进程提前退出，错误由回调统一处理 */
    });
    stdin.end(input ?? Buffer.alloc(0));
  });
}

async function gitText(exec: Exec, argv: string[], input?: Buffer): Promise<{ ok: boolean; status: number | null; stdout: string; stderr: string; timed_out: boolean }> {
  const r = await runGit(exec, argv, input);
  return { ok: r.status === 0, status: r.status, stdout: r.stdout.toString("utf8"), stderr: r.stderr, timed_out: r.timed_out };
}

/**
 * 只读**枚举**的统一入口（`status`／`ls-files`／`diff`／`ls-tree`／`log`／`show`…）。
 * 非零退出**绝不**降级成「空集合」：记录出错命令、真实 exit 与 stderr，返回 `ok=false`，
 * 由调用方明确拒绝/失败。空集合与「命令没跑成」是两件不同的事，混起来会假 noop／假 reused。
 */
async function gitEnumerate(exec: Exec, argv: string[]): Promise<{ ok: boolean; text: string; status: number | null }> {
  const r = await gitText(exec, argv);
  if (!r.ok) recordEnumerationFailure(exec, argv, r);
  return { ok: r.ok, text: r.ok ? r.stdout : "", status: r.status };
}

/** 记录一条枚举故障（需要 Buffer 输出的命令走这里，避免 utf8 转码破坏字节） */
function recordEnumerationFailure(
  exec: Exec,
  argv: readonly string[],
  r: { status: number | null; stderr: string; timed_out: boolean },
): void {
  exec.enumeration_failures.push({
    command: `git -C ${exec.root} ${argv.join(" ")}`,
    exit: r.status,
    timed_out: r.timed_out,
    stderr: r.stderr.trim().slice(0, 400),
  });
}

/** 拒绝/失败明细里的枚举故障片段（有界：全量条数另放 `enumeration_failure_count`） */
function enumerationDetail(exec: Exec, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    enumeration_failures: exec.enumeration_failures.slice(-MAX_ENUMERATION_FAILURES),
    enumeration_failure_count: exec.enumeration_failures.length,
    ...extra,
  };
}

// ───────────────────────────── 5. git 输出解析（纯函数） ─────────────────────────────

export interface TreeEntry {
  mode: string;
  type: string;
  oid: string;
}

/** `git ls-tree -r -z` / `git ls-tree -z <rev> -- <p>` 的解析 */
export function parseLsTreeZ(text: string): Map<string, TreeEntry> {
  const out = new Map<string, TreeEntry>();
  for (const rec of text.split("\0")) {
    if (rec === "") continue;
    const tab = rec.indexOf("\t");
    if (tab < 0) continue;
    const meta = rec.slice(0, tab).split(" ");
    const p = rec.slice(tab + 1);
    if (meta.length < 3) continue;
    out.set(p, { mode: meta[0], type: meta[1], oid: meta[2] });
  }
  return out;
}

/** `git ls-files -s -z` 的解析（stage 0 之外也读，冲突在更早处已拒） */
export function parseLsFilesZ(text: string): Map<string, { mode: string; oid: string; stage: string }> {
  const out = new Map<string, { mode: string; oid: string; stage: string }>();
  for (const rec of text.split("\0")) {
    if (rec === "") continue;
    const tab = rec.indexOf("\t");
    if (tab < 0) continue;
    const parts = rec.slice(0, tab).split(" ");
    if (parts.length < 3) continue;
    out.set(rec.slice(tab + 1), { mode: parts[0], oid: parts[1], stage: parts[2] });
  }
  return out;
}

/**
 * `git diff --name-status -z` 的解析。
 * `-z` 下是 **NUL 分隔的字段**：`STATUS\0PATH\0`（改名/复制为 `R100\0OLD\0NEW\0`），
 * 不是 `STATUS<TAB>PATH`——按后者的写法会一个路径都解析不出来。
 */
export function parseNameStatusZ(text: string): Array<{ status: string; path: string }> {
  const tokens = text.split("\0");
  const out: Array<{ status: string; path: string }> = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "") continue;
    const status = token[0];
    const p = tokens[++i];
    if (p === undefined) break;
    if (status === "R" || status === "C") {
      // 多一格是目标路径：我们只关心"现在叫这个名字"的路径，但必须把它吃掉
      const dest = tokens[++i];
      out.push({ status, path: dest === undefined ? p : dest });
      continue;
    }
    out.push({ status, path: p });
  }
  return out;
}

/** `git status --porcelain=v1 -z` 的未跟踪/冲突解析（沿用 gitStatus.ts 的 -z 口径） */
export function parseStatusZ(text: string): { untracked: string[]; conflicted: boolean } {
  const untracked: string[] = [];
  let conflicted = false;
  const records = text.split("\0");
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    if (rec === "") continue;
    const xy = rec.slice(0, 2);
    const p = rec.slice(3);
    if (xy === "??") {
      untracked.push(p);
      continue;
    }
    if (xy === "!!") continue;
    if (["AA", "DD", "AU", "UA", "DU", "UD", "UU"].includes(xy)) {
      conflicted = true;
      continue;
    }
    if (xy.includes("R") || xy.includes("C")) i++;
  }
  return { untracked, conflicted };
}

// ───────────────────────────── 6. 主流程 ─────────────────────────────

interface Ctx {
  request: FinalizeRequest | null;
  finalize_id: string;
  git: { cwd: string; git_dir: string | null; git_version: string | null };
  changes: FinalizeChangeEntry[];
  checks: FinalizeChecks | null;
  blobs: FinalizeBlobRecord[];
  side_effects: FinalizeResult["side_effects"];
  commit: string | null;
  tree: string | null;
  parent: string | null;
  branch: string | null;
  association: FinalizeAssociation | null;
  commands: string[];
  grant: FinalizeGrant | null;
}

function emptyChecks(): FinalizeChecks {
  return {
    base_head_match: false,
    branch_match: false,
    staged_unrelated_absent: false,
    candidate_bytes_match: false,
    change_set_matches_workspace: false,
    commit_range_exact: false,
    commit_tree_exact: false,
    commit_blobs_canonical: false,
    index_matches_commit: false,
    worktree_unchanged: false,
    head_is_commit: false,
    parent_is_base: false,
    unrelated_index_unchanged: false,
    other_worktree_unchanged: false,
    failures: [],
  };
}

function finish(
  ctx: Ctx,
  status: FinalizeStatus,
  code: FinalizeRefusalCode | null,
  message: string,
  detail: Record<string, unknown> = {},
): FinalizeResult {
  return {
    schema: FINALIZE_SCHEMA,
    status,
    code,
    message,
    finalize_id: ctx.finalize_id,
    accepted: status === "committed" || status === "reused",
    commit: ctx.commit,
    tree: ctx.tree,
    parent: ctx.parent,
    branch: ctx.branch,
    git: ctx.git,
    changes: ctx.changes,
    blobs: ctx.blobs,
    checks: ctx.checks,
    association: ctx.association,
    side_effects: ctx.side_effects,
    commands: ctx.commands,
    detail,
  };
}

function refuse(ctx: Ctx, code: FinalizeRefusalCode, message: string, detail: Record<string, unknown> = {}): FinalizeResult {
  // 拒绝一律**零副作用**：不 add、不 commit、不碰 index/工作区/ref、不 reset。
  return finish(ctx, "refused", code, message, detail);
}

/** 同一仓库互斥（进程内）：并发收尾 → 明确拒绝，不排队也不互相踩 index */
const activeRepos = new Set<string>();
function acquireRepo(key: string): (() => void) | null {
  if (activeRepos.has(key)) return null;
  activeRepos.add(key);
  return () => {
    activeRepos.delete(key);
  };
}

interface WorktreeSnapshot {
  files: Map<string, string | null>; // path → sha256（null = 已从工作区删除）
  count: number;
  bytes: number;
  truncated: boolean;
  /** false = 枚举命令（ls-files/status）没有成功跑完；此时 `files` 不是可信现场，调用方不得当空集合用 */
  ok: boolean;
}

async function snapshotWorktree(exec: Exec, limits: { files: number; bytes: number }): Promise<WorktreeSnapshot> {
  const files = new Map<string, string | null>();
  let bytes = 0;
  let truncated = false;
  const trackedRun = await gitEnumerate(exec, ["ls-files", "-z"]);
  const statusRun = await gitEnumerate(exec, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (!trackedRun.ok || !statusRun.ok) return { files, count: 0, bytes: 0, truncated: false, ok: false };
  const tracked = trackedRun.text.split("\0").filter((p) => p !== "");
  const { untracked } = parseStatusZ(statusRun.text);
  const all = new Set<string>([...tracked, ...untracked]);
  for (const rel of all) {
    if (files.size >= limits.files || bytes > limits.bytes) {
      truncated = true;
      break;
    }
    const abs = absOf(exec.root, rel);
    let buf: Buffer;
    try {
      if (!fs.statSync(abs).isFile()) continue;
      buf = fs.readFileSync(abs);
    } catch {
      files.set(rel, null);
      continue;
    }
    bytes += buf.length;
    files.set(rel, sha256Hex(buf));
  }
  return { files, count: files.size, bytes, truncated, ok: true };
}

async function canonicalOid(exec: Exec, rel: string, bytes: Buffer): Promise<{ oid: string | null; error: string | null }> {
  const r = await runGit(exec, ["hash-object", `--path=${rel}`, "--stdin"], bytes);
  if (r.status !== 0) return { oid: null, error: r.stderr.trim() || `exit ${r.status}` };
  const oid = r.stdout.toString("utf8").trim();
  return OID_RE.test(oid) ? { oid, error: null } : { oid: null, error: `无法解析 oid：${oid}` };
}

async function rawOid(exec: Exec, bytes: Buffer): Promise<string | null> {
  const r = await runGit(exec, ["hash-object", "--stdin"], bytes);
  if (r.status !== 0) return null;
  const oid = r.stdout.toString("utf8").trim();
  return OID_RE.test(oid) ? oid : null;
}

async function headOf(exec: Exec): Promise<string | null> {
  const r = await runGit(exec, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  if (r.status !== 0) return null;
  const v = r.stdout.toString("utf8").trim();
  return OID_RE.test(v) ? v : null;
}

async function branchOf(exec: Exec): Promise<string | null> {
  const r = await runGit(exec, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (r.status !== 0) return null;
  const v = r.stdout.toString("utf8").trim();
  return v === "" || v === "HEAD" ? null : v;
}

async function revOf(exec: Exec, spec: string): Promise<string | null> {
  const r = await runGit(exec, ["rev-parse", "--verify", "--quiet", spec]);
  if (r.status !== 0) return null;
  const v = r.stdout.toString("utf8").trim();
  return OID_RE.test(v) ? v : null;
}

interface ChangeEntryInternal {
  entry: FinalizeChangeEntry;
  verifiedBytes: Buffer | null;
  rawDigest: string | null;
  canonical: string | null;
}

async function verifyCommit(args: {
  exec: Exec;
  commit: string;
  base: string;
  branchExpected: string | null;
  branchActual: string | null;
  internal: ChangeEntryInternal[];
  checks: FinalizeChecks;
  blobs: FinalizeBlobRecord[];
  beforeWorktree: WorktreeSnapshot;
  beforeIndex: Map<string, { mode: string; oid: string; stage: string }>;
}): Promise<{ enumeration_failed: boolean }> {
  const { exec, commit, base, internal, checks, blobs } = args;
  const enumFailuresBefore = exec.enumeration_failures.length;
  const authorized = new Set(internal.map((i) => i.entry.path));
  /** 失败明细有界（全量只体现在 failure_count）；布尔判定另用局部变量，不靠"有没有记到条目"推 */
  const note = (msg: string): void => {
    if (checks.failures.length < MAX_FAILURE_NOTES) checks.failures.push(msg);
  };
  const statusExpect: Record<FinalizeChangeStatus, string> = { added: "A", modified: "M", deleted: "D", typechange: "T" };
  const expectedStatusOf = new Map(internal.map((i) => [i.entry.path, statusExpect[i.entry.status]]));

  // ── A 变更范围：diff(base, commit) 必须恰等于授权改动集合（整棵树 ≠ 改动集合） ──
  const rangeRun = await gitEnumerate(exec, ["diff", "--no-renames", "--name-status", "-z", base, commit]);
  let rangeOk = rangeRun.ok;
  if (!rangeOk) note(`ENUMERATION_FAILED:diff-range:exit=${rangeRun.status}`);
  const actualRange = new Map<string, string>();
  for (const { status, path: p } of parseNameStatusZ(rangeRun.text)) actualRange.set(p, status);
  for (const [p, s] of actualRange) {
    if (!authorized.has(p)) {
      rangeOk = false;
      note(`RANGE_MISMATCH:extra=${p}`);
    } else if (s !== expectedStatusOf.get(p)) {
      rangeOk = false;
      note(`RANGE_MISMATCH:status=${p}:${expectedStatusOf.get(p)}/${s}`);
    }
  }
  for (const p of authorized) {
    if (!actualRange.has(p)) {
      rangeOk = false;
      note(`RANGE_MISMATCH:missing=${p}`);
    } else if (actualRange.get(p) !== expectedStatusOf.get(p)) {
      rangeOk = false;
      note(`RANGE_MISMATCH:status=${p}:${expectedStatusOf.get(p)}/${actualRange.get(p)}`);
    }
  }
  checks.commit_range_exact = rangeOk;

  // ── 完整树：提交树 == 预期基准树 + 已验修改（逐 path/mode/oid） ──
  const baseTreeRun = await gitEnumerate(exec, ["ls-tree", "-r", "-z", base]);
  const commitTreeRun = await gitEnumerate(exec, ["ls-tree", "-r", "-z", commit]);
  let treeOk = baseTreeRun.ok && commitTreeRun.ok;
  if (!treeOk) note(`ENUMERATION_FAILED:ls-tree:${baseTreeRun.ok ? "commit" : "base"}`);
  const baseTree = parseLsTreeZ(baseTreeRun.text);
  const commitTree = parseLsTreeZ(commitTreeRun.text);
  const expectedTree = new Map<string, TreeEntry>(baseTree);
  for (const i of internal) {
    if (i.entry.status === "deleted") expectedTree.delete(i.entry.path);
    else expectedTree.set(i.entry.path, { mode: i.entry.mode ?? "100644", type: "blob", oid: i.canonical ?? "" });
  }
  for (const [p, e] of commitTree) {
    const want = expectedTree.get(p);
    if (want === undefined) {
      treeOk = false;
      note(`TREE_MISMATCH:extra=${p}`);
    } else if (want.oid !== e.oid) {
      treeOk = false;
      note(`TREE_MISMATCH:oid=${p}`);
    } else if (want.mode !== e.mode) {
      treeOk = false;
      note(`TREE_MISMATCH:mode=${p}`);
    }
  }
  for (const p of expectedTree.keys()) {
    if (!commitTree.has(p)) {
      treeOk = false;
      note(`TREE_MISMATCH:missing=${p}`);
    }
  }
  checks.commit_tree_exact = treeOk;

  // ── B 提交字节：逐路径 blob == 受验字节的 canonical 预测；raw 与 blob 分别记录 ──
  const indexRun = await gitEnumerate(exec, ["ls-files", "-s", "-z"]);
  if (!indexRun.ok) note(`ENUMERATION_FAILED:ls-files-index:exit=${indexRun.status}`);
  const indexAfter = parseLsFilesZ(indexRun.text);
  let blobsOk = true;
  let indexOk = indexRun.ok;
  for (const i of internal) {
    const p = i.entry.path;
    const rec: FinalizeBlobRecord = {
      path: p,
      status: i.entry.status,
      mode: i.entry.mode,
      raw_sha256: i.rawDigest,
      raw_oid: null,
      canonical_oid: i.canonical,
      committed_oid: null,
      blob_sha256: null,
      normalized: false,
    };
    if (i.entry.status === "deleted") {
      // 删除项不进 blobs 表（没有 blob），但树里必须确实没有它
      if (commitTree.has(p)) {
        blobsOk = false;
        note(`BLOB_MISMATCH:${p}`);
      }
      continue;
    }
    const treeRec = commitTree.get(p);
    if (treeRec === undefined) {
      blobsOk = false;
      note(`BLOB_MISMATCH:${p}`);
      blobs.push(rec);
      continue;
    }
    rec.committed_oid = treeRec.oid;
    const blobRun = await runGit(exec, ["cat-file", "blob", treeRec.oid]);
    if (blobRun.status === 0) {
      rec.blob_sha256 = sha256Hex(blobRun.stdout);
      rec.normalized = rec.raw_sha256 !== null && rec.raw_sha256 !== rec.blob_sha256;
    } else {
      blobsOk = false;
      recordEnumerationFailure(exec, ["cat-file", "blob", treeRec.oid], blobRun);
      note(`ENUMERATION_FAILED:cat-file:${p}`);
    }
    if (i.verifiedBytes !== null) {
      rec.raw_oid = await rawOid(exec, i.verifiedBytes);
      if (rec.raw_oid === null) {
        blobsOk = false;
        note(`ENUMERATION_FAILED:hash-object:${p}`);
      }
    }
    if (i.canonical === null || treeRec.oid !== i.canonical) {
      blobsOk = false;
      note(`BLOB_MISMATCH:${p}`);
    }
    blobs.push(rec);
    // ── D index 与提交一致（hook 只改 index 会在这一步或上一步暴露） ──
    const idx = indexAfter.get(p);
    if (idx === undefined || idx.stage !== "0" || idx.oid !== treeRec.oid) {
      indexOk = false;
      note(`INDEX_MISMATCH:${p}`);
    }
  }
  checks.commit_blobs_canonical = blobsOk;
  checks.index_matches_commit = indexOk;

  // ── C 工作区未漂移（受验路径）；顺带核上限（超了如实标，不假装核过） ──
  const afterWorktree = await snapshotWorktree(exec, {
    files: DEFAULT_WORKSPACE_FILE_LIMIT,
    bytes: DEFAULT_WORKSPACE_BYTE_LIMIT,
  });
  let worktreeOk = afterWorktree.ok;
  if (!afterWorktree.ok) note("ENUMERATION_FAILED:worktree-snapshot");
  if (afterWorktree.ok && afterWorktree.truncated) {
    worktreeOk = false;
    note("WORKTREE_SNAPSHOT_TRUNCATED");
  }
  if (afterWorktree.ok) {
    for (const i of internal) {
      const p = i.entry.path;
      const now = afterWorktree.files.get(p) ?? null;
      const want = i.entry.status === "deleted" ? null : i.rawDigest;
      if (now !== want) {
        worktreeOk = false;
        note(`WORKTREE_DRIFT:${p}`);
      }
    }
  }
  checks.worktree_unchanged = worktreeOk;

  // ── E 起点与等价性 ──
  const headNow = await headOf(exec);
  checks.head_is_commit = headNow !== null && headNow === commit;
  if (!checks.head_is_commit) note("HEAD_NOT_COMMIT");
  const parent = await revOf(exec, `${commit}^`);
  checks.parent_is_base = parent !== null && parent === base;
  if (!checks.parent_is_base) note("PARENT_NOT_BASE");
  const branchNow = await branchOf(exec);
  checks.branch_match =
    branchNow !== null && branchNow === args.branchActual && (args.branchExpected === null || branchNow === args.branchExpected);
  if (!checks.branch_match) note("BRANCH_DRIFT");

  // ── F 现场未扰动：无关 index 逐条不变 + 非授权工作区文件字节逐条不变 ──
  let unrelatedIndexOk = indexRun.ok;
  if (indexRun.ok) {
    for (const [p, e] of args.beforeIndex) {
      if (authorized.has(p)) continue;
      const now = indexAfter.get(p);
      if (now === undefined || now.oid !== e.oid || now.mode !== e.mode || now.stage !== e.stage) {
        unrelatedIndexOk = false;
        note(`UNRELATED_INDEX_DRIFT:${p}`);
      }
    }
    for (const p of indexAfter.keys()) {
      if (!authorized.has(p) && !args.beforeIndex.has(p)) {
        unrelatedIndexOk = false;
        note(`UNRELATED_INDEX_DRIFT:${p}`);
      }
    }
  }
  checks.unrelated_index_unchanged = unrelatedIndexOk;

  let otherOk = afterWorktree.ok;
  if (afterWorktree.ok) {
    const seen = new Set<string>([...args.beforeWorktree.files.keys(), ...afterWorktree.files.keys()]);
    for (const p of seen) {
      if (authorized.has(p)) continue;
      const before = args.beforeWorktree.files.get(p) ?? null;
      const after = afterWorktree.files.get(p) ?? null;
      if (before !== after) {
        otherOk = false;
        note(`WORKTREE_DRIFT:other:${p}`);
      }
    }
  }
  checks.other_worktree_unchanged = otherOk;

  return { enumeration_failed: exec.enumeration_failures.length > enumFailuresBefore };
}

/**
 * 主入口。**永不抛**：预期失败都以 `status`/`code` 返回；只在意外 JS 异常时返回 `INTERNAL_ERROR`。
 */
export async function executeVerifiedLocalCommit(input: FinalizeInput): Promise<FinalizeResult> {
  const reqMaybe = (input as { request?: FinalizeRequest } | null | undefined)?.request ?? null;
  const ctx: Ctx = {
    request: reqMaybe,
    finalize_id: reqMaybe !== null && typeof reqMaybe.finalize_id === "string" && reqMaybe.finalize_id.length > 0 ? reqMaybe.finalize_id : "pending",
    git: { cwd: reqMaybe !== null && typeof reqMaybe.expected_root === "string" ? reqMaybe.expected_root : "", git_dir: null, git_version: null },
    changes: [],
    checks: null,
    blobs: [],
    side_effects: { commit_created: false, worktree_restored: false, index_restored: false, reset_performed: false },
    commit: null,
    tree: null,
    parent: null,
    branch: null,
    association: null,
    commands: [],
    grant: null,
  };
  try {
    return await runFinalize(input, ctx);
  } catch (e) {
    return finish(ctx, "failed", "INTERNAL_ERROR", `引擎内部异常：${errText(e)}`, { error: errText(e) });
  }
}

async function runFinalize(input: FinalizeInput, ctx: Ctx): Promise<FinalizeResult> {
  const request = ctx.request;

  // ── 输入校验 ──
  if (request === null || typeof request !== "object") return refuse(ctx, "INVALID_INPUT", "缺少 request");
  for (const key of ["project_id", "task_id", "workspace_id"] as const) {
    if (typeof request[key] !== "string" || request[key].length === 0) return refuse(ctx, "INVALID_INPUT", `request.${key} 必须是非空字符串`);
  }
  if (request.actor === null || typeof request.actor !== "object" || typeof request.actor.id !== "string" || typeof request.actor.role !== "string") {
    return refuse(ctx, "INVALID_INPUT", "request.actor 必须是 {id, role}");
  }
  if (typeof request.subject !== "string" || request.subject.trim().length === 0) return refuse(ctx, "INVALID_INPUT", "request.subject 不能为空");
  if (input === null || typeof input !== "object" || input.facts === null || typeof input.facts?.resolveFinalizeGrant !== "function") {
    return refuse(ctx, "INVALID_INPUT", "缺少中央事实源 FinalizeFactSource（引擎不自带事实库，也不接受调用方自报通过）");
  }

  const timeoutMs = request.limits?.timeout_ms ?? DEFAULT_FINALIZE_TIMEOUT_MS;
  const maxBuffer = request.limits?.max_buffer ?? DEFAULT_FINALIZE_MAX_BUFFER;

  // ── 读中央事实（宿主实现的解析器） ──
  let grant: FinalizeGrant;
  try {
    grant = await input.facts.resolveFinalizeGrant({
      project_id: request.project_id,
      task_id: request.task_id,
      workspace_id: request.workspace_id,
      actor: request.actor,
    });
  } catch (e) {
    return finish(ctx, "failed", "INTERNAL_ERROR", `读取中央事实失败：${errText(e)}`);
  }
  if (grant === null || grant === undefined) return refuse(ctx, "NOT_AUTHORIZED", "中央事实没有该任务/工作区的授权记录");
  ctx.grant = grant;
  if (grant.project_id !== request.project_id || grant.task_id !== request.task_id || grant.workspace_id !== request.workspace_id) {
    return refuse(ctx, "NOT_AUTHORIZED", "中央事实与请求的项目/任务/工作区不一致", {
      grant: { project_id: grant.project_id, task_id: grant.task_id, workspace_id: grant.workspace_id },
    });
  }

  // ── 资格（对同一 grant 重跑，不信任调用方声明） ──
  const eligibility = evaluateFinalizeEligibility(grant, request.actor);
  if (!eligibility.eligible) {
    return refuse(ctx, eligibility.code ?? "NOT_AUTHORIZED", `资格判据未通过：${eligibility.reasons.join("；")}`, {
      reasons: eligibility.reasons,
      missing: eligibility.missing,
    });
  }

  // ── 工作区路径与 gitdir 绝对路径确认 ──
  if (typeof grant.root !== "string" || grant.root.length === 0 || !path.isAbsolute(grant.root)) {
    return refuse(ctx, "WORKSPACE_ROOT_INVALID", `工作区根必须是绝对路径：${JSON.stringify(grant.root)}`);
  }
  let rootStat: fs.Stats;
  try {
    rootStat = fs.statSync(grant.root);
  } catch (e) {
    return refuse(ctx, "WORKSPACE_ROOT_INVALID", `工作区根不可访问：${errText(e)}`);
  }
  if (!rootStat.isDirectory()) return refuse(ctx, "WORKSPACE_ROOT_INVALID", "工作区根不是目录");
  if (request.expected_root !== undefined) {
    if (typeof request.expected_root !== "string" || !path.isAbsolute(request.expected_root)) {
      return refuse(ctx, "WORKSPACE_MISMATCH", "request.expected_root 必须是绝对路径");
    }
    if (!samePath(request.expected_root, grant.root)) {
      return refuse(ctx, "WORKSPACE_MISMATCH", "请求 cwd 与该任务授权工作区不一致", {
        expected_root: request.expected_root,
        grant_root: grant.root,
      });
    }
  }
  if (grant.git_dir !== undefined && grant.git_dir !== null) {
    if (typeof grant.git_dir !== "string" || !path.isAbsolute(grant.git_dir)) {
      return refuse(ctx, "GIT_DIR_INVALID", `grant.git_dir 必须是绝对路径：${JSON.stringify(grant.git_dir)}`);
    }
  }

  // ── 互斥 ──
  const lockKey = normalizeAbsPath(grant.root);
  const release = acquireRepo(lockKey);
  if (release === null) return refuse(ctx, "CONCURRENT_BUSY", "同一仓库已有本地收尾在执行");
  try {
    return await runLocked(input, ctx, grant, { timeoutMs, maxBuffer });
  } finally {
    release();
  }
}

async function runLocked(
  _input: FinalizeInput,
  ctx: Ctx,
  grant: FinalizeGrant,
  limits: { timeoutMs: number; maxBuffer: number },
): Promise<FinalizeResult> {
  const request = ctx.request as FinalizeRequest;
  const exec: Exec = {
    root: grant.root,
    timeoutMs: limits.timeoutMs,
    maxBuffer: limits.maxBuffer,
    commands: ctx.commands,
    enumeration_failures: [],
  };
  ctx.git.cwd = grant.root;

  const version = await gitVersion(grant.root, limits.timeoutMs);
  ctx.git.git_version = version;

  // ── 是 Git 工作树吗（不 git init） ──
  const gitDirRun = await runGit(exec, ["rev-parse", "--absolute-git-dir"]);
  if (gitDirRun.status !== 0) {
    return refuse(ctx, "NOT_A_GIT_REPOSITORY", `${grant.root} 不是 Git 工作树（不擅自 git init）`, {
      stderr: gitDirRun.stderr.trim(),
    });
  }
  const actualGitDir = gitDirRun.stdout.toString("utf8").trim();
  if (!path.isAbsolute(actualGitDir)) return refuse(ctx, "GIT_DIR_INVALID", `git 返回的 gitdir 不是绝对路径：${actualGitDir}`);
  ctx.git.git_dir = actualGitDir;
  if (grant.git_dir !== undefined && grant.git_dir !== null && !samePath(grant.git_dir, actualGitDir)) {
    return refuse(ctx, "GIT_DIR_INVALID", "grant.git_dir 与实际 gitdir 不一致", { grant_git_dir: grant.git_dir, actual: actualGitDir });
  }
  // 授权工作区必须是该仓库的**工作树根**：否则（例如目录只是某个外层仓库的子目录）会把提交打进那个仓库，
  // 越过本任务的范围。这里明确拒绝，而不是"就近借用外层仓库"。
  const topRun = await runGit(exec, ["rev-parse", "--show-toplevel"]);
  const topLevel = topRun.status === 0 ? topRun.stdout.toString("utf8").trim() : "";
  if (topLevel === "" || !samePath(topLevel, grant.root)) {
    return refuse(ctx, "WORKSPACE_NOT_REPO_ROOT", "授权工作区不是该仓库的工作树根：拒绝（避免把提交打进入它的外层仓库）", {
      workspace_root: grant.root,
      worktree_root: topLevel,
    });
  }

  // ── 基准 HEAD 与分支（先只读快照：**幂等预检必须排在硬性 HEAD 判定之前**，
  //    否则"已提交成功但回执丢失"的重试会因为 HEAD 已前进而被误判成漂移） ──
  const baseHead = grant.candidate_base_head as string;
  const headNow = await headOf(exec);
  const branchNow = await branchOf(exec);
  const branchExpected = typeof grant.candidate_branch === "string" && grant.candidate_branch.length > 0 ? grant.candidate_branch : null;
  const checks = emptyChecks();
  ctx.checks = checks;
  checks.base_head_match = headNow !== null && headNow === baseHead;
  checks.branch_match = branchNow !== null && (branchExpected === null || branchNow === branchExpected);

  // ── 候选改动集合校验（含路径/状态/哈希形状） ──
  const changes: FinalizeChangeEntry[] = [];
  const seenPaths = new Set<string>();
  for (const raw of grant.changes) {
    const p = validateRelPath(raw?.path);
    if (p === null) return refuse(ctx, "INVALID_INPUT", `候选改动路径不合法：${JSON.stringify(raw?.path)}`);
    if (seenPaths.has(p)) return refuse(ctx, "INVALID_INPUT", `候选改动集合有重复路径：${p}`);
    seenPaths.add(p);
    if (!["added", "modified", "deleted", "typechange"].includes(raw.status)) {
      return refuse(ctx, "INVALID_INPUT", `候选改动状态不合法：${JSON.stringify(raw.status)}`);
    }
    if (raw.status === "deleted") {
      changes.push({ path: p, status: raw.status, sha256: null, mode: null, size: null });
      continue;
    }
    if (typeof raw.sha256 !== "string" || !SHA256_RE.test(raw.sha256)) {
      return refuse(ctx, "INVALID_INPUT", `候选改动缺合法 sha256：${p}`);
    }
    if (typeof raw.mode !== "string" || !MODE_RE.test(raw.mode)) {
      return refuse(ctx, "INVALID_INPUT", `候选改动缺合法 mode：${p}`);
    }
    changes.push({
      path: p,
      status: raw.status,
      sha256: raw.sha256,
      mode: raw.mode,
      size: typeof raw.size === "number" ? raw.size : null,
    });
  }
  ctx.changes = changes;

  // ── 幂等预检：按 finalize_id 限量查找，重核 parent/可达性/候选后才复用（不凭尾注信任） ──
  const seed: FinalizeIdSeed = {
    project_id: request.project_id,
    task_id: request.task_id,
    workspace_id: request.workspace_id,
    candidate_fingerprint: grant.candidate_fingerprint as string,
    base_head: baseHead,
  };
  const derivedId = computeFinalizeId(seed);
  if (request.finalize_id === undefined) {
    ctx.finalize_id = derivedId;
  } else if (request.finalize_id !== derivedId) {
    // 调用方显式给的幂等键必须与稳定输入一致，否则不能作为可复用键
    return refuse(ctx, "INVALID_INPUT", "request.finalize_id 与稳定输入派生的幂等键不一致", { derived: derivedId, given: request.finalize_id });
  }
  const finalizeId = ctx.finalize_id;

  const replay = await findReplayClaimants(exec, grant, finalizeId);
  if (replay.enumeration_failed) {
    return refuse(ctx, "GIT_ENUMERATION_FAILED", "幂等查找所需的只读枚举命令未成功执行：拒绝（不凭空集合推断「没有声明者」）", enumerationDetail(exec));
  }
  if (replay.commit !== null) {
    if (!checks.branch_match) {
      return refuse(ctx, "BRANCH_DRIFT", "当前分支与候选预期不一致（或处于游离头）", { expected: branchExpected, actual: branchNow });
    }
    if (!replay.clean) {
      return refuse(ctx, "RECEIPT_REPLAY_MISMATCH", `已存在声明同一 finalize_id 的提交，但重核不符：${replay.reasons.join("；")}`, {
        claimants: replay.claimants,
      });
    }
    // 复用旧提交的前提不只是"旧提交本身正确"，还必须"**当前工作区仍等于该受验候选**"：
    // 与首次提交跑同一套只读校验（实际 diff(基准) + 非 ignored untracked 恰等于授权集合；
    // 无关已暂存/未验新增/候选漂移一律拒绝，且不产生新提交、不改现场）。
    const insp = await inspectWorkspaceReadonly({ ctx, exec, checks, baseHead, grant, changes, seenPaths });
    if (!insp.ok) return refuse(ctx, insp.code, insp.message, { ...insp.detail, existing_commit: replay.commit });
    if (insp.facts.outOfScope.length > 0) {
      return refuse(ctx, "OUT_OF_SCOPE_CHANGE", "重试时工作区存在未获授权/未验证的改动：拒绝复用旧提交（不产生新提交）", {
        out_of_scope: insp.facts.outOfScope.slice(0, MAX_REPORT_PATHS),
        out_of_scope_count: insp.facts.outOfScope.length,
        existing_commit: replay.commit,
      });
    }
    if (insp.facts.missingAuthorized.length > 0) {
      return refuse(ctx, "MISSING_AUTHORIZED_CHANGE", "重试时授权的实际改动在工作区缺失：拒绝复用旧提交", {
        missing: insp.facts.missingAuthorized.slice(0, MAX_REPORT_PATHS),
        missing_count: insp.facts.missingAuthorized.length,
        existing_commit: replay.commit,
      });
    }
    // 复用：把所有后验断言**再跑一遍**（parent/完整树/raw/工作区/候选身份）
    const treeOid = await revOf(exec, `${replay.commit}^{tree}`);
    if (treeOid === null) {
      return refuse(ctx, "GIT_ENUMERATION_FAILED", "无法解析已存在提交的 tree：拒绝复用", enumerationDetail(exec, { existing_commit: replay.commit }));
    }
    ctx.commit = replay.commit;
    ctx.tree = treeOid;
    ctx.parent = baseHead;
    ctx.branch = branchNow;
    const verify = await verifyCommit({
      exec,
      commit: replay.commit,
      base: baseHead,
      branchExpected: branchExpected,
      branchActual: branchNow,
      internal: insp.facts.internal.items,
      checks,
      blobs: ctx.blobs,
      beforeWorktree: insp.facts.beforeWorktree,
      beforeIndex: insp.facts.beforeIndex,
    });
    if (verify.enumeration_failed) {
      return finish(ctx, "failed", "GIT_ENUMERATION_FAILED", "复用的后验核验有只读枚举命令未成功执行：不得复用（该提交未被接受）", enumerationDetail(exec, { commit: replay.commit }));
    }
    if (checks.failures.length > 0) {
      return finish(ctx, "failed", "RECEIPT_REPLAY_MISMATCH", `尾注命中的提交重核未通过：${checks.failures.join("；")}`, {
        failures: checks.failures,
        commit: replay.commit,
      });
    }
    ctx.association = buildAssociation(grant, finalizeId, ctx);
    return finish(ctx, "reused", null, "同一 finalize_id 的提交已存在且重核相符：复用，不重复提交", {
      commit: replay.commit,
      reused: true,
    });
  }

  // 没有幂等声明者 → 进入正常收尾：此时才把 HEAD 漂移/分支漂移当硬性拒绝
  if (headNow === null) return refuse(ctx, "HEAD_DRIFT", "仓库没有 HEAD（空仓库），与预期基准不符");
  if (!checks.base_head_match) {
    return refuse(ctx, "HEAD_DRIFT", "实际 HEAD 与候选预期基准不一致（并发漂移）", { expected: baseHead, actual: headNow });
  }
  if (!checks.branch_match) {
    return refuse(ctx, "BRANCH_DRIFT", "当前分支与候选预期不一致（或处于游离头）", { expected: branchExpected, actual: branchNow });
  }

  // ── 候选/工作区/暂存区/范围核验（全部只读；与重试/复用**共用同一套**校验） ──
  const insp = await inspectWorkspaceReadonly({ ctx, exec, checks, baseHead, grant, changes, seenPaths });
  if (!insp.ok) return refuse(ctx, insp.code, insp.message, insp.detail);
  const { internal, beforeWorktree, beforeIndex, actual, outOfScope, missingAuthorized, allNoop } = insp.facts;

  // 同内容已在 HEAD → 无需提交，不造空提交（排在"授权路径缺失"之前：
  // 内容已在基准时该路径本就不会出现在 diff 里，那不是"漏内容"）
  if (allNoop && actual.size === 0) {
    return finish(ctx, "noop_up_to_date", null, "内容已在预期基准 HEAD：无需提交（不造空提交）", { base_head: baseHead });
  }

  if (outOfScope.length > 0) {
    return refuse(ctx, "OUT_OF_SCOPE_CHANGE", "工作区存在未获授权/未验证的改动：拒绝提交（不取交集、不遗漏）", {
      out_of_scope: outOfScope.slice(0, MAX_REPORT_PATHS),
      out_of_scope_count: outOfScope.length,
    });
  }
  if (missingAuthorized.length > 0) {
    return refuse(ctx, "MISSING_AUTHORIZED_CHANGE", "授权的实际改动在工作区缺失：拒绝提交（不许漏内容）", {
      missing: missingAuthorized.slice(0, MAX_REPORT_PATHS),
      missing_count: missingAuthorized.length,
    });
  }

  // ── 精确暂存 + 提交（写操作从这里开始） ──
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-finalize-"));
  try {
    const newPaths = internal.items.filter((i) => !beforeIndex.has(i.entry.path)).map((i) => i.entry.path);
    if (newPaths.length > 0) {
      const psf = path.join(tmpDir, "add.pathspec");
      fs.writeFileSync(psf, newPaths.join("\0") + "\0");
      const addRun = await runGit(exec, ["add", `--pathspec-from-file=${psf}`, "--pathspec-file-nul"]);
      if (addRun.status !== 0) {
        return finish(ctx, "failed", "COMMIT_FAILED", "暂存新增文件失败（如实返回，未 reset）", {
          exit: addRun.status,
          stderr: addRun.stderr.trim().slice(0, 4000),
          timed_out: addRun.timed_out,
        });
      }
    }

    const allSpec = internal.items.map((i) => i.entry.path);
    const psfAll = path.join(tmpDir, "commit.pathspec");
    fs.writeFileSync(psfAll, allSpec.join("\0") + "\0");
    const message = buildFinalizeMessage({
      subject: request.subject,
      body: request.body,
      finalize_id: finalizeId,
      candidate_fingerprint: grant.candidate_fingerprint as string,
      base_head: baseHead,
    });
    const commitRun = await runGit(exec, [
      "commit",
      "--only",
      "-m",
      message,
      `--pathspec-from-file=${psfAll}`,
      "--pathspec-file-nul",
    ]);
    if (commitRun.status !== 0) {
      const stderr = commitRun.stderr.trim();
      const nothing = /nothing to commit|no changes added to commit/i.test(stderr);
      return finish(
        ctx,
        "failed",
        nothing ? "COMMIT_NO_CHANGES" : "COMMIT_FAILED",
        nothing
          ? "git 报无可提交内容（与 noop 预检不符）：如实返回，未造空提交"
          : "git 提交失败（如实返回；保留现场，不 reset/restore）",
        { exit: commitRun.status, stderr: stderr.slice(0, 4000), timed_out: commitRun.timed_out, stdout: commitRun.stdout.toString("utf8").trim().slice(0, 2000) },
      );
    }

    const newHead = await headOf(exec);
    if (newHead === null || newHead === baseHead) {
      return finish(ctx, "failed", "COMMIT_FAILED", "git 退出码为 0 但 HEAD 未产生新提交（如实返回）", { head: newHead });
    }
    ctx.commit = newHead;
    ctx.tree = await revOf(exec, `${newHead}^{tree}`);
    ctx.parent = baseHead;
    ctx.branch = await branchOf(exec);
    ctx.side_effects.commit_created = true;

    const verify = await verifyCommit({
      exec,
      commit: newHead,
      base: baseHead,
      branchExpected: branchExpected,
      branchActual: ctx.branch,
      internal: internal.items,
      checks,
      blobs: ctx.blobs,
      beforeWorktree,
      beforeIndex,
    });
    if (verify.enumeration_failed) {
      // 提交已产生，但后验核验有只读枚举命令没跑成：不得当成"全绿"——如实说明提交已产生、未接受、不自动撤销。
      return finish(ctx, "failed", "GIT_ENUMERATION_FAILED", "提交已产生，但后验核验有只读枚举命令未成功执行：未接受，保留现场（不自动撤销）", enumerationDetail(exec, { commit: newHead }));
    }
    if (checks.failures.length > 0) {
      // 提交已产生但后验失败：如实说明「提交已产生、未接受」，**不自动撤销**、保留 hook 副作用。
      return finish(ctx, "failed", "POST_VERIFY_FAILED", "提交已产生，但后验断言未通过：未接受，保留现场（不自动撤销）", {
        failures: checks.failures.slice(0, MAX_REPORT_PATHS * 4),
        failure_count: checks.failures.length,
        commit: newHead,
      });
    }
    ctx.association = buildAssociation(grant, finalizeId, ctx);
    return finish(ctx, "committed", null, "本地提交已产生且后验全部通过", { commit: newHead, tree: ctx.tree, parent: baseHead });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

interface InternalChanges {
  items: ChangeEntryInternal[];
  byPath: Map<string, ChangeEntryInternal>;
}

async function buildInternal(
  _ctx: Ctx,
  exec: Exec,
  grant: FinalizeGrant,
  changes: FinalizeChangeEntry[],
): Promise<InternalChanges | { code: FinalizeRefusalCode; message: string; detail: Record<string, unknown> }> {
  const items: ChangeEntryInternal[] = [];
  const byPath = new Map<string, ChangeEntryInternal>();
  const tampered: string[] = [];
  for (const entry of changes) {
    if (entry.status === "deleted") {
      const abs = absOf(exec.root, entry.path);
      if (fs.existsSync(abs)) tampered.push(`${entry.path}(仍存在)`);
      const item: ChangeEntryInternal = { entry, verifiedBytes: null, rawDigest: null, canonical: null };
      items.push(item);
      byPath.set(entry.path, item);
      continue;
    }
    const abs = absOf(exec.root, entry.path);
    let buf: Buffer;
    try {
      if (!fs.statSync(abs).isFile()) throw new Error("不是普通文件");
      buf = fs.readFileSync(abs);
    } catch (e) {
      tampered.push(`${entry.path}(读不到：${errText(e)})`);
      continue;
    }
    const digest = sha256Hex(buf);
    if (digest !== entry.sha256 || (entry.size !== null && buf.length !== entry.size)) {
      tampered.push(`${entry.path}(字节不符)`);
      continue;
    }
    const canon = await canonicalOid(exec, entry.path, buf);
    if (canon.oid === null) {
      return { code: "CANDIDATE_TAMPERED", message: `无法按当前仓库属性预测入库 blob：${entry.path}`, detail: { path: entry.path, error: canon.error } };
    }
    const item: ChangeEntryInternal = { entry, verifiedBytes: buf, rawDigest: digest, canonical: canon.oid };
    items.push(item);
    byPath.set(entry.path, item);
  }
  if (tampered.length > 0) {
    return {
      code: "CANDIDATE_TAMPERED",
      message: "工作区当前字节与冻结候选不一致（不是已受验输入）：拒绝",
      detail: { tampered: tampered.slice(0, MAX_REPORT_PATHS), tampered_count: tampered.length },
    };
  }
  if (Array.isArray(grant.full_index)) {
    const bad: string[] = [];
    for (const idx of grant.full_index) {
      const p = validateRelPath(idx?.path);
      if (p === null) {
        bad.push(`${String(idx?.path)}(路径不合法)`);
        continue;
      }
      const abs = absOf(exec.root, p);
      try {
        if (!fs.statSync(abs).isFile()) throw new Error("不存在");
        const buf = fs.readFileSync(abs);
        if (sha256Hex(buf) !== idx.sha256 || buf.length !== idx.size) bad.push(p);
      } catch {
        bad.push(`${p}(读不到)`);
      }
    }
    if (bad.length > 0) {
      return {
        code: "CANDIDATE_TAMPERED",
        message: "工作区与完整候选索引不一致：拒绝（当前字节必须等于完整冻结候选）",
        detail: { mismatched: bad.slice(0, MAX_REPORT_PATHS), mismatched_count: bad.length },
      };
    }
  }
  return { items, byPath };
}

interface WorkspaceFacts {
  internal: InternalChanges;
  beforeWorktree: WorktreeSnapshot;
  beforeIndex: Map<string, { mode: string; oid: string; stage: string }>;
  /** 工作区相对基准的**实际**改动集合（tracked diff + 非 ignored untracked 记为 `A`） */
  actual: Map<string, string>;
  untracked: string[];
  outOfScope: string[];
  missingAuthorized: string[];
  /** 授权内容与基准完全相同且工作区无实际改动 → 没有可提交内容 */
  allNoop: boolean;
}

type WorkspaceInspection =
  | { ok: true; facts: WorkspaceFacts }
  | { ok: false; code: FinalizeRefusalCode; message: string; detail: Record<string, unknown> };

/**
 * **首次提交与重试/复用共用的只读校验**（全部发生在任何写之前）。
 *
 * 它证明的是「**当前工作区仍然等于该受验候选**」：实际 `diff(<基准>)` 加上非 ignored untracked 得到的
 * 改动集合必须**恰等于**授权集合（多 = 未验/未授权，少 = 漏内容），无关已暂存一律拒绝。
 * `full_index` 是可选的分片清单，**不是**这项资格的替代品：它只逐条核已列出的路径，看不见新增未验文件。
 * 任一枚举命令非零退出 → `GIT_ENUMERATION_FAILED`（fail closed），**不**把失败的 stdout 当空集合。
 */
async function inspectWorkspaceReadonly(args: {
  ctx: Ctx;
  exec: Exec;
  checks: FinalizeChecks;
  baseHead: string;
  grant: FinalizeGrant;
  changes: FinalizeChangeEntry[];
  seenPaths: Set<string>;
}): Promise<WorkspaceInspection> {
  const { ctx, exec, checks, baseHead, grant, changes, seenPaths } = args;
  const enumFail = (): WorkspaceInspection => ({
    ok: false,
    code: "GIT_ENUMERATION_FAILED",
    message: "只读枚举命令未成功执行：拒绝（不把失败的输出当空集合/无改动）",
    detail: enumerationDetail(exec),
  });

  // ① 工作区快照（tracked + 非 ignored untracked；超上限如实拒绝，不做全盘散列）
  const beforeWorktree = await snapshotWorktree(exec, {
    files: DEFAULT_WORKSPACE_FILE_LIMIT,
    bytes: DEFAULT_WORKSPACE_BYTE_LIMIT,
  });
  if (!beforeWorktree.ok) return enumFail();
  if (beforeWorktree.truncated) {
    return {
      ok: false,
      code: "WORKSPACE_TOO_LARGE",
      message: "工作区文件数量/总量超过收尾核验上限（有界；不做全盘散列）",
      detail: { files: beforeWorktree.count, bytes: beforeWorktree.bytes },
    };
  }

  // ② 冲突
  const statusRun = await gitEnumerate(exec, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (!statusRun.ok) return enumFail();
  const statusParsed = parseStatusZ(statusRun.text);
  if (statusParsed.conflicted) {
    return { ok: false, code: "WORKSPACE_CONFLICTED", message: "工作区存在未解决的冲突，先人工处理", detail: {} };
  }

  const indexRun = await gitEnumerate(exec, ["ls-files", "-s", "-z"]);
  if (!indexRun.ok) return enumFail();
  const beforeIndex = parseLsFilesZ(indexRun.text);

  // ③ 无关已暂存内容：**任何写之前**明确拒绝（保留现场）
  const stagedRun = await gitEnumerate(exec, ["diff", "--cached", "--no-renames", "--name-status", "-z", baseHead]);
  if (!stagedRun.ok) return enumFail();
  const unrelatedStaged: string[] = [];
  for (const { path: p } of parseNameStatusZ(stagedRun.text)) {
    if (!seenPaths.has(p)) unrelatedStaged.push(p);
  }
  checks.staged_unrelated_absent = unrelatedStaged.length === 0;
  if (unrelatedStaged.length > 0) {
    return {
      ok: false,
      code: "REFUSED_UNRELATED_STAGED",
      message: "暂存区含不属于本授权的条目：拒绝提交并保留现场",
      detail: {
        unrelated_staged: unrelatedStaged.slice(0, MAX_REPORT_PATHS),
        unrelated_staged_count: unrelatedStaged.length,
      },
    };
  }

  // ④ 候选字节（受验原始字节）与工作区逐条一致；full_index 给出则逐条核
  const internal = await buildInternal(ctx, exec, grant, changes);
  if ("code" in internal) return { ok: false, code: internal.code, message: internal.message, detail: internal.detail };
  checks.candidate_bytes_match = true;

  // ⑤ 实际改动集合必须恰等于授权集合（`git diff <base>` 只覆盖已跟踪文件：未跟踪新增按 `A` 补进来）
  const wtRun = await gitEnumerate(exec, ["diff", "--no-renames", "--name-status", "-z", baseHead]);
  if (!wtRun.ok) return enumFail();
  const actual = new Map<string, string>();
  for (const { status, path: p } of parseNameStatusZ(wtRun.text)) actual.set(p, status);
  for (const p of statusParsed.untracked) {
    if (!actual.has(p)) actual.set(p, "A");
  }
  const statusExpect: Record<FinalizeChangeStatus, string> = { added: "A", modified: "M", deleted: "D", typechange: "T" };
  const outOfScope: string[] = [];
  const missingAuthorized: string[] = [];
  for (const [p, s] of actual) {
    const item = internal.byPath.get(p);
    if (item === undefined || !seenPaths.has(p)) outOfScope.push(p);
    else if (s !== statusExpect[item.entry.status]) outOfScope.push(p);
  }
  for (const c of changes) if (!actual.has(c.path)) missingAuthorized.push(c.path);
  checks.change_set_matches_workspace = outOfScope.length === 0 && missingAuthorized.length === 0;

  // ⑥ 同内容已在基准 → 无需提交，不造空提交（排在「授权路径缺失」之前：
  //    内容已在基准时该路径本就不会出现在 diff 里，那不是"漏内容"）
  const baseTreeRun = await gitEnumerate(exec, ["ls-tree", "-r", "-z", baseHead]);
  if (!baseTreeRun.ok) return enumFail();
  const baseTree = parseLsTreeZ(baseTreeRun.text);
  let allNoop = true;
  for (const i of internal.items) {
    const e = baseTree.get(i.entry.path);
    if (i.entry.status === "deleted") {
      if (e !== undefined) allNoop = false;
    } else if (e === undefined || e.oid !== i.canonical) {
      allNoop = false;
    }
  }

  return {
    ok: true,
    facts: {
      internal,
      beforeWorktree,
      beforeIndex,
      actual,
      untracked: statusParsed.untracked,
      outOfScope,
      missingAuthorized,
      allNoop,
    },
  };
}

interface ReplayResult {
  commit: string | null;
  clean: boolean;
  reasons: string[];
  claimants: string[];
  /** true = 幂等查找所需的只读枚举没跑成；调用方必须 fail closed，**不得**当「没有声明者」 */
  enumeration_failed: boolean;
}

/** 受限历史里按 finalize_id 找声明者；命中的提交必须在 HEAD 且尾注候选/基准一致才算可复用 */
async function findReplayClaimants(exec: Exec, grant: FinalizeGrant, finalizeId: string): Promise<ReplayResult> {
  const line = `${FINALIZE_TRAILER.finalize_id}: ${finalizeId}`;
  const scan = await gitEnumerate(exec, ["log", `--max-count=${REUSE_SCAN_LIMIT}`, "--fixed-strings", `--grep=${line}`, "--format=%H"]);
  if (!scan.ok) return { commit: null, clean: false, reasons: [], claimants: [], enumeration_failed: true };
  const claimants = scan.text.split("\n").map((s) => s.trim()).filter((s) => OID_RE.test(s));
  if (claimants.length === 0) return { commit: null, clean: false, reasons: [], claimants, enumeration_failed: false };
  const reasons: string[] = [];
  if (claimants.length > 1) reasons.push(`历史中有 ${claimants.length} 个声明同一 finalize_id 的提交`);
  const head = await headOf(exec);
  const target = claimants[0];
  const msgRun = await gitEnumerate(exec, ["show", "-s", "--format=%B", target]);
  if (!msgRun.ok) return { commit: null, clean: false, reasons: ["无法读取声明者提交的消息"], claimants, enumeration_failed: true };
  const trailers = parseFinalizeTrailers(msgRun.text);
  if (head === null || head !== target) reasons.push("声明者不是当前 HEAD");
  if (trailers.finalize_id !== finalizeId) reasons.push("尾注 finalize_id 不完全匹配");
  if (trailers.candidate !== grant.candidate_fingerprint) reasons.push("尾注候选指纹与当前候选不一致");
  if (trailers.base !== grant.candidate_base_head) reasons.push("尾注基准与当前预期基准不一致");
  const parent = await revOf(exec, `${target}^`);
  if (parent === null || parent !== grant.candidate_base_head) reasons.push("声明者的 parent 不是预期基准");
  return { commit: target, clean: reasons.length === 0, reasons, claimants, enumeration_failed: false };
}

function buildAssociation(grant: FinalizeGrant, finalizeId: string, ctx: Ctx): FinalizeAssociation {
  return {
    project_id: grant.project_id,
    task_id: grant.task_id,
    workspace_id: grant.workspace_id,
    finalize_id: finalizeId,
    commit: ctx.commit as string,
    tree: ctx.tree as string,
    parent: ctx.parent as string,
    branch: ctx.branch as string,
    candidate_fingerprint: grant.candidate_fingerprint as string,
    base_head: grant.candidate_base_head as string,
    authorization_ref: grant.authorization_ref,
    evidence_refs: Array.isArray(grant.evidence_refs) ? [...grant.evidence_refs] : [],
    blobs: ctx.blobs.map((b) => ({
      path: b.path,
      mode: b.mode,
      raw_sha256: b.raw_sha256,
      blob_oid: b.committed_oid,
      normalized: b.normalized,
    })),
  };
}
