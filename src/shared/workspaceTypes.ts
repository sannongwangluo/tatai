// 项目工作目录与交付候选：共享类型与稳定失败码（PLAN V09-63/V09-65；DESIGN.md §6.13／§6.14）。
//
// 为什么放在 `src/shared/`：工作区记录要被服务端（唯一写口、入口、认领）与 MCP 工具层共用同**一份**形状；
// 各写一份就会"两份都像真的"（§6.14 第 1 段：复用边界，不另造第二套）。
//
// 硬口径（照 §6.14 读）：
//   · 项目身份仍是注册表 `ProjectRecord.id`；主开发目录由 `<project_id>:main` **派生**，不重复保存。
//     无工作区记录时 `ProjectRecord.path` 就是默认开发根，且它始终是项目与**唯一账本/工作台**的定位锚点。
//   · 工作区与候选只记**事件 + 只读投影**；候选**不复制第二套可写 `.工作台/`**、不为候选另发项目身份。
//   · 记录里的 `root` 是**规范绝对路径**；来源可以是 Git 提交/worktree 或可核验内容指纹。
//   · 项目级指针（当前开发工作区／当前试用候选）记独立实体 `workspace-pointer:<project_id>`，
//     **不改 `ProjectRecord.path`**。
import type { WorkErrorCode } from "../server/work/types";
import type { ToolchainIdentity } from "./buildIdentity";

/** 工作区用途（§6.14 第 2 段：`kind`） */
export const WORKSPACE_KINDS = ["dev", "trial", "candidate"] as const;
export type WorkspaceKind = (typeof WORKSPACE_KINDS)[number];

export const WORKSPACE_KIND_LABELS: Readonly<Record<WorkspaceKind, string>> = {
  dev: "开发工作区",
  trial: "固定试用候选",
  candidate: "候选/准备区",
};

/** 来源种类（§6.14 第 2 段：`source_kind`） */
export const WORKSPACE_SOURCE_KINDS = ["directory", "git_worktree", "git_commit", "content_snapshot"] as const;
export type WorkspaceSourceKind = (typeof WORKSPACE_SOURCE_KINDS)[number];

/** 工作区状态（§6.14 第 2 段：`preparing`／`frozen`／`retired`） */
export const WORKSPACE_STATUSES = ["preparing", "frozen", "retired"] as const;
export type WorkspaceStatus = (typeof WORKSPACE_STATUSES)[number];

export const WORKSPACE_STATUS_LABELS: Readonly<Record<WorkspaceStatus, string>> = {
  preparing: "准备中",
  frozen: "已冻结",
  retired: "已回收",
};

/** 允许登记/改写的角色（§6.14 第 2 段 op 表的「允许角色」列；角色名不是安全凭证，§6.5） */
export const WORKSPACE_WRITE_ROLES = ["executor", "coordinator", "designer"] as const;
export type WorkspaceWriteRole = (typeof WORKSPACE_WRITE_ROLES)[number];
/** 只能由协调者/设计者执行的 op（executor 不能改项目级指针、不能回收） */
export const WORKSPACE_COORDINATOR_ROLES = ["coordinator", "designer"] as const;

/**
 * 候选冻结的**构建包身份**绑定（§6.14 第 3 段「构建输入＝`release_id`／组件输入指纹（复用 §6.10，不另算）」）。
 *
 * 语义（照 §6.14 读）：
 *   · 冻结阶段只定**构建输入**（`release_id`／组件输入指纹／工具链），**不要求先有包**——「先冻结后构建」成立；
 *   · 试用提升（第 8 段）由**宿主自行实测**该目录的真实产物身份，与本记录逐项相符才放行；
 *   · `delivery_kind="not_applicable"` 只用于「该候选根没有 §6.10 构建链且调用方未声明包交付」的普通项目——
 *     **不能靠省略请求字段**把本应是包交付的候选降成非包（宿主按根实测判定）；
 *   · 旧记录缺本段 = `null`：**已知包项目不得默认通过**，按未知处理（§6.14 第 8/10 段）。
 */
export const WORKSPACE_DELIVERY_KINDS = ["package", "not_applicable"] as const;
export type WorkspaceDeliveryKind = (typeof WORKSPACE_DELIVERY_KINDS)[number];

export interface WorkspaceBuildBinding {
  delivery_kind: WorkspaceDeliveryKind;
  /** 宿主判定依据（人话；说明为何是包交付或合理不适用） */
  basis: string;
  /** `release_id`＝同一批构建的输入决定（§6.10）。`not_applicable` 时为 null，如实标未知 */
  release_id: string | null;
  build_id: { server: string; ui: string } | null;
  server_input_fingerprint: string | null;
  ui_input_fingerprint: string | null;
  /** 两个显式构建输入集的清单哈希（相对路径 + 每文件 sha256，定序） */
  server_input_manifest_sha256: string | null;
  ui_input_manifest_sha256: string | null;
  server_input_file_count: number | null;
  ui_input_file_count: number | null;
  /** 构建环境与编译目标（进 release_id；随身份带出便于对照） */
  toolchain: ToolchainIdentity | null;
}

/**
 * 候选冻结绑定：把"被验候选"固定到**同一候选**的源码内容与配套版本（§6.14 第 3 段）。
 * 交付读数与检查判据一律用它冻结的 DESIGN/PLAN 内容与同一 baseline，不读当前开发目录的最新文档。
 */
export interface WorkspaceVersionBinding {
  /** 所绑 `DESIGN.md` 内容 sha256（进既有不可变修订库；读不回时为 null，如实标未知） */
  design_sha256: string | null;
  /** 所绑 `PLAN.md` 内容 sha256（同上） */
  plan_sha256: string | null;
  /** 生效基线 id（不自动激活新基线，只如实绑定当时那条） */
  baseline_id: string | null;
  /** 冻结来源游标（**只作游标，不能用来截断冻结后的新证据**，§6.14 第 3 段） */
  ledger_last_seq: number | null;
  /** 需求/功能清单快照游标（可核验的版本指针；给不出时 null） */
  requirement_cursor: string | null;
  /** 构建包身份绑定（§6.14 第 3/8 段；旧记录缺本段 = null，按未知处理） */
  build_identity: WorkspaceBuildBinding | null;
}

/** 一次冻结的事实（§6.14 第 3 段：被验输入与配套版本同源） */
export interface WorkspaceFreeze {
  frozen_at: string;
  frozen_by: string;
  /** 全树内容指纹（候选索引 + 内容指纹的稳定摘要，§6.14 第 3 段） */
  content_fingerprint: string;
  /** 未提交改动是否纳入候选（**必须显式声明**，不用 HEAD 冒充实际内容） */
  included_uncommitted: boolean;
  /** 声明纳入的路径（`included_uncommitted` 为真时至少一条；给不出＝拒冻结） */
  declared_paths: string[];
  /** 候选全量索引的版本指针（= 候选索引内容指纹；未接线时为 null，如实标未知） */
  candidate_index_revision: string | null;
  /** 完整候选索引证据（内容寻址，经唯一宿主 `putEvidence` 落库；payload 只存这个引用，不塞索引本体） */
  index_evidence_id: string | null;
  /** 候选恢复材料证据（索引片 + 不可从提交还原的原字节；同上，只存引用） */
  recovery_evidence_id: string | null;
  /** 冻结时的来源提交（Git 项目；非 Git 为 null） */
  source_commit: string | null;
  version_binding: WorkspaceVersionBinding;
}

/** 一条工作区记录（事件投影；`:main` 为派生视图，见 `derived`） */
export interface WorkspaceRecord {
  workspace_id: string;
  kind: WorkspaceKind;
  purpose: string;
  /** 规范绝对路径（`path.resolve` 后的唯一真实指向） */
  root: string;
  source_kind: WorkspaceSourceKind;
  /** 来源提交（`source_kind` 为 git_commit／git_worktree 时给；否则 null） */
  source_commit: string | null;
  /** 来源引用（分支/快照名等；给不出为 null） */
  source_ref: string | null;
  /** 可核验内容指纹（非 Git 快照），或 Git 项目里候选全树指纹的稳定摘要；未冻结时为 null */
  content_fingerprint: string | null;
  status: WorkspaceStatus;
  owner_role: string | null;
  task_ids: string[];
  /** true = 由 `<project_id>:main` **派生**（不重复保存、不可 freeze/retire 改写 ProjectRecord.path） */
  derived: boolean;
  /** 冻结事实（status="frozen" 时在场） */
  freeze: WorkspaceFreeze | null;
  /** 事件实体版本（派生 `:main` 为 0） */
  revision: number;
  seq: number;
  updated_at: string;
  last_actor: string;
}

/** 项目级指针（当前开发工作区／当前试用候选）——独立实体，**不改 ProjectRecord.path** */
export interface WorkspacePointer {
  project_id: string;
  /** 当前开发工作区 id（null ＝ 未指定，按 `<project_id>:main` 派生） */
  current_dev_workspace_id: string | null;
  /** 当前试用候选 id（null ＝ 未提升任何固定试用版） */
  current_trial_workspace_id: string | null;
  revision: number;
  seq: number;
  updated_at: string;
  last_actor: string;
}

/**
 * 当前开发根的解析结果（DESIGN §6.14 第 2 段「只允许完全无登记时 legacy 默认」）。
 * `source`：
 *   · `pointer`＝显式开发指针指向的合法工作区；
 *   · `main`＝**没有任何开发指针登记**时的派生 `:main`（唯一允许的 legacy 默认）；
 *   · `blocked`＝**有显式指针但目标坏**（不存在/已回收）——**绝不静默回落 `:main`**，`root` 为 null。
 */
export interface WorkspaceDevResolution {
  /** 目标工作区 id（`blocked` 时＝指针所指 id，便于点名） */
  workspace_id: string;
  /** 当前开发根；`blocked` 时为 **null**（不拿 `:main` 顶替） */
  root: string | null;
  source: "pointer" | "main" | "blocked";
  /** `blocked` 的原因（结构化可读，逐条点名） */
  blocked_reason?: string;
}

/** 只读派生视图（`manage_workspace(op=read/list)` 的返回体） */
export interface WorkspaceView {
  project_id: string;
  /** 项目与唯一账本/工作台的定位锚点（`ProjectRecord.path`；**不被工作区指针改写**） */
  anchor_root: string;
  pointer: WorkspacePointer;
  /** 含派生 `:main` 的全部工作区，按 `workspace_id` 升序 */
  workspaces: WorkspaceRecord[];
  /** 当前实际开发根（指针所指；完全无登记才回退派生 `:main`；坏指针＝blocked、不回退） */
  current_dev: WorkspaceDevResolution;
}

/** `manage_workspace` 的 op（§6.14 第 2 段 op 表） */
export const WORKSPACE_OPS = ["read", "list", "register", "update", "freeze", "retire", "select_dev", "point_trial"] as const;
export type WorkspaceOp = (typeof WORKSPACE_OPS)[number];

/**
 * 稳定失败码（§6.14 op 表「失败口径」列）。这是**调用层**码（与 `ClaimFailureCode` 同层），
 * **不扩写入服务的 `WORK_ERROR_CODES`**（那是 v2 信封/写入协议层面的错误码集）。
 * 写口锁内拒绝把它们放进 `WorkError.detail.reason`，读口/工具层把它们原样带给调用方。
 */
export type WorkspaceFailureCode =
  | WorkErrorCode
  | "WORKSPACE_ROOT_INVALID"
  | "WORKSPACE_UNKNOWN"
  | "WORKSPACE_MISMATCH"
  | "WORKSPACE_ROLE_FORBIDDEN"
  | "WORKSPACE_NOT_FROZEN"
  | "CANDIDATE_FROZEN"
  | "CANDIDATE_INVALID"
  | "CANDIDATE_TAMPERED"
  | "FREEZE_SOURCE_UNRESOLVED"
  | "FREEZE_MISSING_DECLARED"
  | "PACKAGE_IDENTITY_UNSUPPORTED"
  | "RETIRE_PRECONDITION_UNMET"
  | "PROMOTION_UNVERIFIED";

/** 调用层通用结局（与 claims 的 `ClaimOutcome` 同形：明确拒绝 + 现场，不抛栈） */
export interface WorkspaceFailure {
  ok: false;
  code: WorkspaceFailureCode;
  message: string;
  /** 稳定失败原因（放进 detail 里的同一码，便于结构化分支） */
  reason: WorkspaceFailureCode;
  /** 逐条失败项（如实，不合并成一句） */
  failures: string[];
  /** 重新读状态的入口（点名 `manage_workspace` 与事件文件） */
  read_again: string;
  detail: Record<string, unknown>;
}

export type WorkspaceOutcome<T> = ({ ok: true } & T) | WorkspaceFailure;

/** op 表：允许角色（§6.14 第 2 段；写 op 的「允许角色」列） */
export const WORKSPACE_OP_ROLES: Readonly<Record<WorkspaceOp, readonly WorkspaceWriteRole[]>> = {
  read: WORKSPACE_WRITE_ROLES, // 只读，任意角色
  list: WORKSPACE_WRITE_ROLES,
  register: WORKSPACE_WRITE_ROLES,
  update: WORKSPACE_WRITE_ROLES,
  freeze: WORKSPACE_WRITE_ROLES,
  retire: WORKSPACE_COORDINATOR_ROLES,
  select_dev: WORKSPACE_COORDINATOR_ROLES,
  point_trial: WORKSPACE_COORDINATOR_ROLES,
};
