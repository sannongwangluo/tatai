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
  "markdown_section",
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
/** 6. required_reads：期望项目内路径集合，核对 stage-reads.json 的 validated entries。
 *  v2 允许同一 `path` 以不同 `section` 各列一条（去重键是 path+section），故每条期望可**显式点名** `section`
 *  与 stage-reads 条目按 (path, section) 配对；不给 `section` 只匹配整文件条目，遇到"该 path 只有章节绑定条目"
 *  会明确要求点名 section，**不按整文件哈希猜**。可选 `sha256` 核对条目 revision（条目是章节绑定则比章节子树哈希）。 */
export interface SyncCheckRequiredReads {
  type: "required_reads";
  expected: { path: string; section?: string; sha256?: string }[];
}
/**
 * 7. markdown_section（V09-42）：按**完整标题路径**唯一定位 Markdown 章节，
 * 核对「标题行 + 全部后代」子树的 sha256（口径见 src/shared/materialSection.ts）。
 * 章节外改动不影响；章节缺失/同级同名重复/非文本 → 拒绝。
 * **注意**：证据包里的 `artifact` 仍是**整文件** sha（现行契约，未因本 check 放宽）——
 * 本 check 只锚定章节子树，不代表 artifact 整文件漂移被豁免。
 */
export interface SyncCheckMarkdownSection {
  type: "markdown_section";
  path: string;
  /** 完整标题路径（各级标题以 `" / "` 连接；每级唯一） */
  section: string;
  /** 该章节子树（标题行 + 后代）的 sha256 */
  sha256: string;
}

export type SyncCheck =
  | SyncCheckFileHash
  | SyncCheckJsonValue
  | SyncCheckTaskDefinitions
  | SyncCheckTaskStates
  | SyncCheckGraphFull
  | SyncCheckRequiredReads
  | SyncCheckMarkdownSection;

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
  /**
   * 本行是不是**历史批次**（active=false，已被 supersede）。历史批次不再做本次实时核验：
   * `verdict`/`items` 来自**账本里最后一次有效核验回执**（`verified_at` 那一刻的结论），
   * 只作历史，不计入范围与差项、不再阻断；**不得**把历史通过当成当前有效。
   */
  /**
   * 本行结论是不是**来自账本回执、而不是本次实时核验**。默认口径下 `historical ⟺ active=false`
   * （已被 supersede 的历史批次）：`verdict`/`items` 来自**账本里最后一次有效核验回执**
   * （`verified_at` 那一刻的结论），只作历史，不计入范围与差项、不再阻断；
   * **不得**把历史通过当成当前有效。显式历史复查（`readSyncStatus` 的 `liveHistorical`）为 `false`
   * ——那次确实做了实时求值（行仍按 `active` 归入历史组）。
   */
  historical: boolean;
  blocks_entry: boolean;
  verdict: SyncVerdict;
  contract_sha256: string;
  /** 证据包路径（项目根内相对路径；没有证据为 null） */
  evidence_path: string | null;
  /**
   * **历史回执**的核验时间（ISO）；null = 账本无有效回执（明确未核验，不冒充通过）。
   * 本次实时核验的行恒为 null（现行批次的核对时间看报告级 `checked_at`）。
   */
  verified_at: string | null;
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
  /**
   * P3 / V09-48：**只读修复计划**（现行批次逐项原因／责任**建议**／代次／来源漂移／可复用工件／下一读取入口）。
   * 只对现行（active）批次给；它是**只读附加**——不自动补证、不自动改契约、不自动刷新漂移哈希、不缩小必需项、
   * **不改任何门禁**（`blocks_entry`/认领阻断一字不动）。未配置的项目可为空计划。
   */
  repair_plan?: SyncRepairPlan;
}

// ── P3（V09-48）：只读修复计划与候选证据边界（界面 / HTTP / MCP 共用同一份形状） ──
//
// 为什么放在 shared：`read_sync_status`、`GET /api/projects/:id/sync-status` 与界面必须读**同一份**形状，
// 不许端上另造一套语义（与上面 report 同一口径）。判据（谁漂了、谁建议补、下一读哪个入口）只在
// `src/server/work/sync.ts` / `syncRepair.ts` 算一次，这里只放类型。

/** 契约来源漂移的一条：登记哈希 vs 当前实际哈希（缺失/不可读 → current_sha256=null，不冒充一致） */
export interface SyncSourceDrift {
  path: string;
  registered_sha256: string;
  current_sha256: string | null;
}

/** 可复用工件引用（哈希仍与当前目标一致） */
export interface SyncRepairArtifact {
  path: string;
  sha256: string;
}

/** 已失效引用（与可复用**分开列**：不可读/哈希不符/自引用等） */
export interface SyncExpiredArtifact {
  path: string;
  reason: string;
}

/** 按失败类型给出的**建议**承接角色（不替人授权、不构成指派、不改变任何角色的实际权限） */
export type SyncRecommendedRole = "coordinator" | "executor" | "auditor";

/**
 * **结构化工具调用**（`tool` + `args`）——读取/补证入口一律用它，不再输出"不合法 JSON 式字符串"
 * （如 `read_sync_status {project_id: X}` 这种既非合法 JSON、也无法被程序直接调用的写法）。
 */
export interface SyncToolCall {
  tool: string;
  args: Record<string, unknown>;
}

/**
 * 缺证/不符项的**具体补证动作**（不是"再扫一遍"）：明确要交付什么、写到哪个证据包落点、
 * 建议谁承接、要覆盖哪些目标与核对什么，最后再给**扫描入口**（结构化的 `then_scan`）。
 * 补证动作只是指引，**不替人执行、不自动写盘、不构成指派**。
 */
export interface SyncEvidenceAction {
  /** 补证动作（人话：要交付什么、不要拿什么冒充） */
  action: string;
  /** 建议承接角色（不替人授权、不构成指派） */
  role: SyncRecommendedRole;
  /** 证据包落点（项目根内相对路径，如 `.工作台/work/sync-inbox/<batch_id>.evidence.json`） */
  evidence_path: string;
  /** 本项要覆盖/核对的目标路径（项目根内相对路径；没有可机械指认的文件目标时为空数组） */
  target_paths: string[];
  /** 本项核对内容（人话，取自 check 类型与登记声明，供执行者知道要证明什么） */
  verify: string;
  /** 补证完成后的扫描入口（结构化；补证之后再扫，不是立刻重复扫同一缺项） */
  then_scan: SyncToolCall;
}

/** 契约代次（来自 `FoldedBatch`：内容地址截断 + 登记事件真实序号 + 是否现行） */
export interface SyncContractGeneration {
  sha256_12: string;
  registered_seq: number;
  active: boolean;
}

/** 契约**登记事件**的角色/actor（登记人**不是**所有修复项的责任人） */
export interface SyncRegisteredBy {
  role: string;
  actor_id: string;
}

/**
 * 命中"图正在派生"导致的 `graph_full` 未通过时的**只读说明**（不是放行）：
 * `state`／可选 `phase` 来自既有图更新状态；`eta` 只给**有依据**的实测量，依据不足写 `basis:"none"`
 * 且 `total_ms=null`（**不编造** ETA）。v1 `required graph_full` 未满足时**仍阻断**。
 */
export interface SyncWaitingForDerivation {
  state: "updating";
  /** 图更新所处阶段（读口取不到时为 null，如实标未知，不猜） */
  phase: string | null;
  retryable: true;
  /**
   * updating 是不是本项未通过的**唯一**已知原因：有来源漂移或其它非更新类失败原因时为 `false`
   * ——此时**不**把 updating 说成唯一"直接原因"（其余原因一并保留，不盖掉）。
   */
  sole_cause: boolean;
  /** 除 updating 之外的已知失败原因（来源漂移路径等；`sole_cause=true` 时为空数组） */
  other_failures: string[];
  reason: string;
  eta: { basis: string; total_ms: number | null; note: string };
}

/** 修复计划里的**一项**（完整项不可省略） */
export interface SyncRepairItem {
  item_id: string;
  label: string;
  required: boolean;
  verdict: SyncItemVerdict;
  reasons: string[];
  expected: unknown;
  actual: unknown;
  /** 本批次契约来源的漂移（逐条给；无漂移为空数组） */
  source_drift: SyncSourceDrift[];
  reusable_artifacts: SyncRepairArtifact[];
  expired_artifacts: SyncExpiredArtifact[];
  registered_by: SyncRegisteredBy;
  /** 按失败类型的建议；已通过项为 null */
  recommended_role: SyncRecommendedRole | null;
  /** 结构化下一读取入口（`{tool, args}`，可被程序直接调用；不是 JSON 式字符串） */
  next_read_entry: SyncToolCall;
  /** 需要补证/修正时的**具体补证动作**（含目标路径/角色/核对内容与扫描入口）；已通过项为 null */
  next_evidence_action: SyncEvidenceAction | null;
  waiting_for_derivation: SyncWaitingForDerivation | null;
}

/** 候选里单个 item 的工件**来源口径**（便于识别"保留的既有证据工件"与"按真实目标机械生成"） */
export type SyncCandidateArtifactBasis = "reused_existing_evidence" | "mechanical_target";

/** 候选证据的身份与输入版本（谁生成、依据哪一版契约与目标；`verified:false` = 明确未验证草稿） */
export interface SyncCandidateMeta {
  verified: false;
  /** 草稿**默认不完整**（`package.completed=false`）：由协调者核实后显式改 `true` 才进原流程 */
  completed_default: false;
  generated_by: string;
  based_on_contract_sha256: string;
  based_on_registered_seq: number;
  /** 逐项说明工件从哪来（**不是**所有项都拿契约来源冒充目标工件） */
  item_basis: { item_id: string; basis: SyncCandidateArtifactBasis }[];
  note: string;
}

/**
 * 候选证据：**明确未验证的草稿**，不是证据、不是通过、不是独立审查结论。`package` 就是**原闭键解析**
 * 能读的证据包（原样可进既有正式 scan 链路）；`meta` 是并列的身份/输入版本，**不塞进包内**（保持闭键兼容）。
 * 本批只读返回，**零落盘、不新增保存入口**。
 */
export interface SyncCandidateEvidence {
  package: SyncEvidencePackage;
  meta: SyncCandidateMeta;
}

export interface SyncRepairBatch {
  batch_id: string;
  title: string;
  active: boolean;
  blocks_entry: boolean;
  verdict: SyncVerdict;
  contract_sha256: string;
  contract_generation: SyncContractGeneration;
  registered_by: SyncRegisteredBy;
  source_drift: SyncSourceDrift[];
  reusable_artifacts: SyncRepairArtifact[];
  expired_artifacts: SyncExpiredArtifact[];
  items: SyncRepairItem[];
  candidate_evidence: SyncCandidateEvidence | null;
  /** 无候选时的原因（如来源已漂移——候选不自动采纳漂移） */
  candidate_unavailable_reason: string | null;
}

export interface SyncRepairPlan {
  generated_from: "read_sync_status";
  read_only: true;
  note: string;
  batches: SyncRepairBatch[];
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
