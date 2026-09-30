// 同步证据发现与完整性验收的**只读返回契约**（PLAN V09-23；DESIGN.md §2.10；docs/sync-evidence-contract.md「接口、界面和交付」）。
//
// 为什么单独一份 shared：界面（V09-24）、HTTP 读口（GET /api/projects/:id/sync-status）与 MCP（read_sync_status）
// **共用同一份判据与返回体**——界面不许另造一套类型语义，也不许在端上另算完成色。本文件是那份返回体的
// 单一出处：后端（server/work/sync.ts）产出它，界面只读它。
//
// 本模块**只放类型与常量**，不 import 任何 node 内置/服务端模块（界面打包要能直接引它）。
// 字段细节与判定语义的实现在 src/server/work/sync.ts；契约本身的解析/冻结也在那边。

/** 契约与证据包的 schema 版本（唯一认的值；转格式要显式改代码，不靠猜） */
export const SYNC_SCHEMA_VERSION = 1;

/** 每个项目约定的证据收件目录（项目根内相对路径，POSIX 写法） */
export const SYNC_INBOX_REL = ".工作台/work/sync-inbox";

/** 证据包文件名后缀：`<batch_id>.evidence.json`（只发现该格式，不扫整仓任意 Markdown 推测完成） */
export const SYNC_EVIDENCE_FILE_SUFFIX = ".evidence.json";

/** batch_id 的安全 ASCII 标识：字母/数字开头，允许字母数字与 `._-`，1–64 字符 */
export const SYNC_BATCH_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** 契约标题上限（防把长文塞进标题冒充结构化登记） */
export const SYNC_TITLE_MAX = 200;
/** item 的 label 上限 */
export const SYNC_ITEM_LABEL_MAX = 200;

/** 契约的检查类型（闭合的 discriminated union；每种只接受明确字段，不能塞任意脚本/正则执行器） */
export const SYNC_CHECK_TYPES = [
  "file_hash",
  "json_value",
  "task_definitions",
  "task_states",
  "graph_full",
  "required_reads",
] as const;
export type SyncCheckType = (typeof SYNC_CHECK_TYPES)[number];

/** 顶层 verdict 值集（`item` 不用 `not_configured`） */
export const SYNC_VERDICTS = [
  "not_configured",
  "missing",
  "passed",
  "failed",
  "stale",
  "needs_review",
  "invalid",
  "incomplete",
] as const;
export type SyncVerdict = (typeof SYNC_VERDICTS)[number];

/** 逐项 verdict 值集（= 顶层去掉 `not_configured`） */
export const SYNC_ITEM_VERDICTS = [
  "missing",
  "passed",
  "failed",
  "stale",
  "needs_review",
  "invalid",
  "incomplete",
] as const;
export type SyncItemVerdict = (typeof SYNC_ITEM_VERDICTS)[number];

/** 证据包里单项的**声明**结果（只是声明；程序必须再按契约检查当前实际目标） */
export const SYNC_EVIDENCE_RESULTS = ["passed", "failed", "needs_review"] as const;
export type SyncEvidenceResult = (typeof SYNC_EVIDENCE_RESULTS)[number];

// ── 契约（登记时冻结；内容地址 = 确定性 SHA256） ──

export interface SyncContractSource {
  /** 项目根内相对路径（原始工作范围/设计/交接说明） */
  path: string;
  sha256: string;
}

/** 1. file_hash：path + sha256（当前目标字节必须匹配登记期望） */
export interface SyncCheckFileHash {
  type: "file_hash";
  path: string;
  sha256: string;
}
/** 2. json_value：path + JSON Pointer + expected（按 JSON 语义深比较实际字段） */
export interface SyncCheckJsonValue {
  type: "json_value";
  path: string;
  pointer: string;
  expected: unknown;
}
/** 3. task_definitions：指定审定 plan 原文及其登记哈希给出分母，与账本导入定义逐项比 */
export interface SyncCheckTaskDefinitions {
  type: "task_definitions";
  source_plan: string;
  source_sha256: string;
  /** 参与比对的定义字段（`owner_role` 与 `dependency_ids` 逐卡比） */
  compare: { owner_role: boolean; dependency_ids: boolean };
  /** 期望卡号上限（缺省 = 源原文解析出的全集；给出则额外核对卡数，少一多一都点名） */
  expected_task_ids?: string[];
}
/** task_states 的核对口径：current＝本次当前状态（改变即失败）；at_registration＝以登记事件前一个 seq 为截点 */
export const SYNC_TASK_STATES_SCOPE_MODES = ["current", "at_registration"] as const;
export type SyncTaskStatesScopeMode = (typeof SYNC_TASK_STATES_SCOPE_MODES)[number];
/** 4. task_states：登记 task_id → execution_status 的准确期望集合（真实 v2 事件折叠）。
 *  `scope_mode=at_registration` 的截点 at_seq＝**该契约登记事件的 seq − 1**（由服务确定，不能调用方任填）：
 *  核对登记时已经存在的历史状态；其后合法认领/reopen 不让旧同步批次永久阻塞。读口在 actual 里回带 at_seq。 */
export interface SyncCheckTaskStates {
  type: "task_states";
  scope_mode: SyncTaskStatesScopeMode;
  expected: Record<string, string>;
}
/** 5. graph_full：六图 canonical builder 全量同快照取齐，期望有效 baseline_id */
export interface SyncCheckGraphFull {
  type: "graph_full";
  expected_baseline_id: string;
}
/** 6. required_reads：期望项目内路径集合，核对 stage-reads.json 的 validated entries */
export interface SyncCheckRequiredReads {
  type: "required_reads";
  expected: { path: string; sha256?: string }[];
}

export type SyncCheck =
  | SyncCheckFileHash
  | SyncCheckJsonValue
  | SyncCheckTaskDefinitions
  | SyncCheckTaskStates
  | SyncCheckGraphFull
  | SyncCheckRequiredReads;

export interface SyncContractItem {
  /** 稳定 item_id（同一契约内不重复） */
  id: string;
  label: string;
  /** 必需项至少一条；必需项决定 `blocks_entry` 是否阻断 */
  required: boolean;
  check: SyncCheck;
}

export interface SyncContract {
  schema_version: number;
  batch_id: string;
  project_id: string;
  title: string;
  /** 非空：本批次所依据的原始工作范围/设计/交接说明 */
  sources: SyncContractSource[];
  /** 非空：至少一条 required */
  items: SyncContractItem[];
  /** true = 本批次未当前通过时阻断接续与认领 */
  blocks_entry: boolean;
  /** 可选：显式取代相同项目的旧批次（旧记录保留，只作历史，不再阻断） */
  supersedes?: string;
}

// ── 证据包（Agent 侧交付，`<batch_id>.evidence.json`） ──

export interface SyncEvidenceArtifact {
  path: string;
  sha256: string;
}
export interface SyncEvidenceItem {
  id: string;
  result: SyncEvidenceResult;
  artifacts: SyncEvidenceArtifact[];
}
export interface SyncEvidencePackage {
  schema_version: number;
  batch_id: string;
  project_id: string;
  contract_sha256: string;
  completed: boolean;
  items: SyncEvidenceItem[];
}

// ── 只读返回契约（界面 / HTTP / MCP 共用） ──

export interface SyncArtifactRef {
  path: string;
  sha256: string;
}

export interface SyncItemReport {
  id: string;
  label: string;
  required: boolean;
  verdict: SyncItemVerdict;
  /** 期望（登记值；可序列化 JSON） */
  expected: unknown;
  /** 实际（本次核对读到的真实值；可序列化 JSON） */
  actual: unknown;
  reasons: string[];
  artifacts: SyncArtifactRef[];
}

export interface SyncBatchReport {
  batch_id: string;
  title: string;
  /** 是否仍为现行批次（被 supersede 的旧批次 = false，只作历史，不再阻断） */
  active: boolean;
  blocks_entry: boolean;
  verdict: SyncVerdict;
  contract_sha256: string;
  /** 证据包路径（项目根内相对路径；没有证据为 null） */
  evidence_path: string | null;
  items: SyncItemReport[];
}

export interface SyncUnregisteredEvidence {
  path: string;
  batch_id: string | null;
  reason: string;
}

export interface SyncCollection {
  complete: boolean;
  reasons: string[];
}

export interface SyncStatusReport {
  project_id: string;
  configured: boolean;
  overall: SyncVerdict;
  /** 实际本次核对时间（ISO） */
  checked_at: string;
  scan_error: string | null;
  batches: SyncBatchReport[];
  unregistered_evidence: SyncUnregisteredEvidence[];
  collection: SyncCollection;
}

/** 界面短标（§3.11 口径：人看的一句话；不默认展示实现 jargon） */
export const SYNC_VERDICT_LABELS: Readonly<Record<SyncVerdict, string>> = {
  not_configured: "未配置",
  missing: "等待证据",
  passed: "同步通过",
  failed: "发现缺项",
  stale: "来源已变",
  needs_review: "待审核",
  invalid: "检查失败",
  incomplete: "检查未完成",
};
