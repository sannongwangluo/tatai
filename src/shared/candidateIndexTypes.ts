// 候选完整索引（candidate-index-v1）的**共享类型/常量**（DESIGN.md §6.13 第 3/5/6 段、§6.14 第 4/5 段；
// PLAN V09-64 chk-v09-64-01/02/03/04）。
//
// 为什么单独一层、而且**无 fs 依赖**：候选索引是「被验输入」的完整身份，服务端派生与界面只读展示要读同一份
// 形态（DESIGN §2.6 单一派生 → 各只读投影）。界面不得 import 带 fs 的服务端模块，所以形态落在这里；
// 服务端与 UI 都只 import 本模块（`import type` 为主）。
//
// 红线（§6.14 第 4 段）：
//   · **不复用** `scripts/lib/sourceFingerprint.ts` 的全树口径（其目录跳过会漏掉 worktree 的 `.git` **文件**），
//     不改旧算法与既有包身份；
//   · 逐检查 `source_manifest` 的 512 文件 / 8 MiB 单文件 / 64 MiB 总量判据**完全不变**；本文件是**另一套**
//     完整候选口径（分片、有界、可判定），两者**不互相顶替**；
//   · 本模块**只有类型与常量**，不含任何判据、不读盘、不写盘。

/** 候选索引口径标签：改这里就是改"什么算同一份候选"，指纹随版本变化 */
export const CANDIDATE_INDEX_VERSION = "candidate-index-v1" as const;

/** 完整候选声明的文件数上限（有界：不是无上限全盘清单） */
export const MAX_CANDIDATE_FILES = 32768;
/** 每片文件数上限 */
export const MAX_CANDIDATE_SHARD_FILES = 512;
/** 单文件内容上限（超过如实拒，不假装读到了） */
export const MAX_CANDIDATE_FILE_BYTES = 8 * 1024 * 1024;
/** 每片内容总量上限 */
export const MAX_CANDIDATE_SHARD_BYTES = 64 * 1024 * 1024;
/** 片数上限 */
export const MAX_CANDIDATE_SHARDS = 64;
/** 索引 JSON 序列化上限 */
export const MAX_CANDIDATE_INDEX_BYTES = 64 * 1024 * 1024;

/**
 * 事件里存「候选索引 / 恢复材料」**紧凑引用**（`CandidateIndexRef` / `CandidateRecoveryRef`）的字节上限。
 * 完整索引可达 64 MiB，**不能**塞进事件 payload（§6.14 第 3/4 段：候选索引不是第二张台账，事件只记
 * 引用）；引用只放内容寻址证据 id、内容指纹与计数，恒定远小于 64 KiB。
 */
export const MAX_CANDIDATE_EVENT_REF_BYTES = 64 * 1024;

/** 候选来源类：Git 项目用 tracked+untracked 实枚举；非 Git 按同一显式排除规则枚举 */
export type CandidateSourceKind = "git" | "directory";

/** 一条候选条目的状态：`deleted` = 相对来源提交被删除（保住"删除项"这一事实） */
export type CandidateEntryState = "present" | "deleted";

/** 稳定问题码（结构化，供读侧/审计按码分支；message 是人话，不解析 message） */
export type CandidateProblemCode =
  /** 根不存在 / 不是目录 / 规范化不了 */
  | "CANDIDATE_ROOT_INVALID"
  /** 根不是 Git 仓库根（声明为 git 源但 rev-parse 不到，或 toplevel ≠ root） */
  | "CANDIDATE_ROOT_NOT_REPO"
  /** 枚举规模超界（文件数/片数/索引体积）——如实拒，不截断成假完整 */
  | "CANDIDATE_TOO_LARGE"
  /** 单文件超 8 MiB 上限 */
  | "CANDIDATE_FILE_TOO_LARGE"
  /** 单文件读不出来（权限/被占用/不是普通文件） */
  | "CANDIDATE_FILE_UNREADABLE"
  /** 遇到符号链接 / 目录联接（真拒，不跟随、不静默跳过） */
  | "CANDIDATE_LINK_REFUSED"
  /** 存在未提交改动但 `included_uncommitted=false`（不能用 HEAD 冒充实际内容） */
  | "CANDIDATE_UNCOMMITTED_EXCLUDED"
  /** 未提交改动的路径不在 `declared_paths` 声明范围内（未声明变更） */
  | "CANDIDATE_UNDECLARED_CHANGES"
  /** 声明的 `declared_paths` 里有非法路径（绝对/越界/空） */
  | "CANDIDATE_DECLARED_INVALID"
  /** 显式声明纳入的路径在实枚举里找不到 */
  | "CANDIDATE_DECLARED_MISSING"
  /** Git 探针失败（git 不可用/超时/非预期退出码）——未知不当未变更 */
  | "CANDIDATE_GIT_PROBE_FAILED"
  /** 秘密类文件被排除（只记计数/模式，不写路径） */
  | "CANDIDATE_SECRET_EXCLUDED"
  /**
   * 被排除的秘密类文件**是被跟踪/已声明的真实源**：静默排除会让候选与"实际被验输入"不符，
   * 必须**明确冲突**（拒绝冻结），不能一边排除一边自称完整（§6.14 第 4 段）。
   */
  | "CANDIDATE_SECRET_TRACKED_CONFLICT"
  /** verify：目录存在但内容指纹与索引不符（篡改/漂移，失效） */
  | "CANDIDATE_TAMPERED"
  /** resolve：目录不在且来源提交不可达/快照库不可用 */
  | "CANDIDATE_SOURCE_UNAVAILABLE";

export interface CandidateProblem {
  code: CandidateProblemCode;
  /** 相关项目相对路径（秘密类不写路径 → null；规模类可为 null） */
  path: string | null;
  message: string;
}

/** 一条候选条目（完整来源清单的一项） */
export interface CandidateEntry {
  /** 项目相对路径（`/` 分隔、归一化、无 `..`） */
  path: string;
  /** 内容 sha256（严格 64 位小写十六进制）；`deleted` 时为 `""` */
  sha256: string;
  bytes: number;
  /** 文件模式位：Git 源为 100644/100755；文件系统源为 `mode & 0o777`；未知为 0 */
  mode: number;
  state: CandidateEntryState;
  /**
   * `true` = tracked 且相对**声明的来源提交**未改（字节可由该提交还原，raw 可不必另存）；
   * `false` = untracked / 未提交改动 / 被删 / 非 Git（恢复需保原字节或另有快照）。
   */
  git_backed: boolean;
  /** present 且工作字节含 CRLF（blob 与 raw 可能不同 → 恢复需保原字节） */
  crlf: boolean;
}

/** 一片（≤512 文件、≤64 MiB 内容），按规范路径升序切分 */
export interface CandidateShard {
  index: number;
  files: number;
  bytes: number;
  entries: CandidateEntry[];
}

/** 完整候选索引（被验输入的完整来源身份；不是第二张追溯台账） */
export interface CandidateIndex {
  version: typeof CANDIDATE_INDEX_VERSION;
  /** 规范绝对路径（`path.resolve` 后的来源根） */
  root: string;
  source_kind: CandidateSourceKind;
  /** Git 源 = 仓库根规范路径；非 Git = null */
  git_repository: string | null;
  /** 来源提交（HEAD）；拿不到（无提交/非 Git）= null */
  source_commit: string | null;
  /** 未提交改动是否纳入本候选（§6.14 第 3 段：须保全并**声明**，不用 HEAD 冒充） */
  included_uncommitted: boolean;
  /** 调用方声明的应纳入/应变更路径（规范化项目相对路径）；未声明 = null */
  declared_paths: string[] | null;
  /** 全条目，按 `path` 升序（= 各片依次拼接） */
  entries: CandidateEntry[];
  shards: CandidateShard[];
  /** 全条目确定性内容指纹（见 `candidateIndexFingerprint` 判据） */
  content_fingerprint: string;
  file_count: number;
  present_count: number;
  deleted_count: number;
  total_bytes: number;
  shard_count: number;
  /** 索引 JSON 序列化后的字节数（≤ MAX_CANDIDATE_INDEX_BYTES） */
  index_bytes: number;
  /** 被排除的秘密类文件条数（**只记计数**） */
  secret_files: number;
  /** 命中的秘密模式名（**只记模式，不写路径/内容**） */
  secret_patterns: string[];
  problems: CandidateProblem[];
  /** 枚举是否因规模上限被中止（true ⇒ 不是完整候选，冻结必须拒） */
  truncated: boolean;
  inspected_at: string;
}

/** 现读复核结论（拿索引比当前盘上内容） */
export interface CandidateVerify {
  status: "valid" | "invalidated" | "missing" | "unreadable";
  /** 现算的候选指纹（`valid` 时等于索引指纹；算不出为 null） */
  current_fingerprint: string | null;
  /** 内容与索引不同（现读 sha256 对不上） */
  changed: string[];
  /** 索引声明但现在不在盘上 */
  missing: string[];
  /** 现在在盘上、当前有效枚举里有、但索引没声明（不会让旧绿失效，只如实列） */
  extra: string[];
  problems: CandidateProblem[];
}

/** 来源解析结论（确定性顺序，见 §6.14 第 5 段） */
export interface CandidateResolution {
  /** present = 目录在且相符；recovered = 从提交/证据只读物化到缓存后相符；tampered = 目录在但指纹不符；unknown = 均不可得 */
  status: "present" | "recovered" | "tampered" | "unknown";
  /** 可用来源根（present = 原目录；recovered = 可再生缓存目录；否则 null）——**绝不**是开发目录兜底 */
  root: string | null;
  /** 本次物化用的缓存目录（recovered 时非空；可再生、可清理、不参与指纹） */
  cache_root: string | null;
  /** 本次复核确认的内容指纹（present/recovered 时非空） */
  content_fingerprint: string | null;
  problems: CandidateProblem[];
}

/** `preserveCandidateSource` 的产物：恢复材料引用（证据 id 一律内容寻址） */
export interface CandidateRecoveryRawEntry {
  path: string;
  /**
   * 原字节的证据 id（内容寻址）。原字节 base64 后超过单条证据上限（8 MiB）时，写入方会落成一个
   * **分块清单包装 id**（读取方按同一 id 取回并自动拼接、核哈希）；`bytes` 始终是原始字节数。
   */
  evidence_id: string;
  bytes: number;
  mode: number;
  crlf: boolean;
}

export interface CandidateRecoveryRefusal {
  path: string;
  bytes: number;
  reason: string;
}

export interface CandidateRecovery {
  /** 被保全的索引内容指纹（恢复后据此重核） */
  index_fingerprint: string;
  /** 索引片证据 id（按片序；每片一条；片过大时片内再分的块也计入本数组尾部） */
  shard_evidence_ids: string[];
  /** 不可从提交还原的普通文件原字节证据（untracked/未提交改/CRLF 等） */
  raw_evidence: CandidateRecoveryRawEntry[];
  /** 超过单文件上限、明确拒保的条目（不静默丢） */
  refused: CandidateRecoveryRefusal[];
  /** 配套版本绑定（DESIGN/PLAN 内容哈希/基线/账本游标）——与索引同源 */
  version_binding: CandidateVersionBinding | null;
  /** 本次物化的来源（读侧复原后回填） */
  materialized_from?: "git" | "evidence";
  /**
   * 是否完整保全了**全部 present 条目**的原始字节（`refused` 非空 ⇒ false）。
   * `false` 时读取方**不得**据本恢复材料声称"候选可完整复原"（§6.14 第 5 段：不部分保存后自称完整）。
   */
  complete?: boolean;
  /** `raw_evidence` 覆盖的 present 条目数（供读侧核对覆盖度；旧材料缺此字段 = 未知） */
  raw_present_count?: number;
}

/**
 * 事件可存的最小候选索引引用（≤ `MAX_CANDIDATE_EVENT_REF_BYTES`）：完整索引经内容寻址证据保全，
 * 事件只记 **索引分块证据 id + 内容指纹 + 计数**。读取方按 id 取回并核 `content_fingerprint`。
 */
export interface CandidateIndexRef {
  version: typeof CANDIDATE_INDEX_VERSION;
  /** = 索引 `content_fingerprint`（读回重算须一致，否则拒） */
  index_fingerprint: string;
  /** 完整索引 JSON 的证据 id（内容寻址；超上限时分块清单包装 id，读取方自动拼接） */
  index_evidence_id: string;
  /** 恢复材料（原字节）的紧凑引证据 id（无恢复材料 = null） */
  recovery_evidence_id: string | null;
  entry_count: number;
  shard_count: number;
  /** 引用自身的 JSON 字节数（保证 ≤ MAX_CANDIDATE_EVENT_REF_BYTES） */
  ref_bytes: number;
}

/** 恢复材料的紧凑引用（恢复描述符经内容寻址证据保全） */
export interface CandidateRecoveryRef {
  version: typeof CANDIDATE_INDEX_VERSION;
  index_fingerprint: string;
  recovery_evidence_id: string;
  raw_count: number;
  refused_count: number;
  complete: boolean;
  ref_bytes: number;
}

/** 配套版本绑定（§6.14 第 3 段：被验输入与配套 DESIGN/PLAN/基线同源） */
export interface CandidateVersionBinding {
  design_sha256: string;
  plan_sha256: string;
  baseline_id: string | null;
  ledger_last_seq: number;
}
