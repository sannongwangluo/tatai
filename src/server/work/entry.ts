// 项目入口与连续接续的只读契约（PLAN.md V06-10；DESIGN.md §6.7 为主契约，另见 §2.7、§5.4、§5.8、§6.2）。
//
// 三条硬口径（红线）：
//   ① **只读**：本模块只读现场事实（事件/图纸/基线/审计/待议/检查点），不提交任何事件、不写任何文件、
//      **不认领任务**。认领是 `claims.ts` 的单独原子写（§6.7「读取入口不自动认领」）。
//   ② **不悄悄调模型**：本模块零模型调用（不 import flash/chat/copilot 之类；不 fetch 任何网关），
//      候选选择只按现场事实与规则判，不做未授权模型选型（§6.7）。
//   ③ **不报假 complete**：只有当前批次全部必需工作与交付条件满足才 `complete`；
//      「没有就绪任务不等于项目完成」「无人处理的任务不可被忽略」（§6.7）。
//
// §6.7 判定规则的**优先顺序**（本文件 `decideNextAction` 逐条落地，短路先中者胜）：
//   1. 现场事实读不出来 → blocked（不拿"读不到"当空状态）
//   1.5 项目级阶段必读指针（`.工作台/work/stage-reads.json`）不合法/来源漂移 → blocked（不派活；缺文件不算）
//   2. 有效基线核对：没有生效基线 → await_decision（先审定，塔台不派活）
//   3. 源在基线激活后变过 → blocked（影响待查，不派发；§5.6）
//   4. 用户暂停/退回：任务级退回 → 停受影响任务资格；批次级退回 → await_decision（§5.8）
//   5. 待重绑/孤儿状态的任务不进候选（不静默换输入；§5.6）
//   6. 未结束 run：本角色能安全恢复 → resume_task（恢复优先于新领）
//   7. 依赖与证据已满足的队列：按 已定义优先级 → 依赖顺序 → 稳定 ID 选 → claim_task
//   8. 本角色职责内的待审结果 → review_result
//   9. 有就绪候选但角色不符 → await_role（附完整交接，等合适客户端）
//  10. 有明确的待决事项 → await_decision
//  11. 其余有阻塞/不可派/无人处理的必需工作 → blocked
//  12. 全部必需工作与交付条件满足 → complete
// 排序口径说明：第 6 条严格优先于第 7 条（§6.7「能够安全恢复本角色任务时优先续接」）；
// 第 8~12 条按 §6.7 的枚举书写顺序作稳定次序（review_result → await_role → await_decision → blocked → complete）。
//
// 能力发现（§6.2）：`client_capabilities` 未声明一律按「仅可读取」处理——只读客户端只拿到读取与
// 明确的接续指令，**不假称全自动**；要认领/执行必须声明可接续（`continuable`）或可协调执行（`coordination`）。
import fs from "node:fs";
import path from "node:path";
import { getProject, resolveDataDir } from "../registry";
import { projectWorkDir } from "../workstation";
import { auditEntityId, readAuditRecords, type AcceptanceRecord } from "./audit";
import { leaseStateOf, liveClaimRecord, claimRecordsOf, readClaimEvents, RESUME_PRECONDITIONS, type ClaimRecord, type TaskClaim } from "./claims";
import {
  buildContextPackage,
  checkpointPath,
  loadCheckpoint,
  resolveCheckpoint,
  type ContextPackage,
} from "./context";
import { readDecisions, discussionRefKey, type DecisionRecord } from "./decisions";
import { activeBaseline, loadDocument, loadDocuments, type ProjectBaseline } from "./documents";
import { readFindings } from "./evidence";
// V09-27（契约 F3）：运行现场（执行回执/liveness）只读接入 `current_runs`——无事件为未知，缺心跳不等于停机。
import { livenessOf, readExecutions, type ExecutionRecord, type RunSiteState } from "./executionReceipts";
import { importTaskDefinitions, taskDefinitionHash, type TaskDefinition } from "./plan";
import {
  acceptanceDimensionOf,
  checkEffectiveness,
  checksFromAudit,
  checksFromFacts,
  collectProjectFacts,
  eventsSnapshotOf,
  dependencyRelease,
  objectsFromFacts,
  projectStatuses,
  type EventsSnapshot,
  type ProjectFacts,
  type StatusProjection,
  type StatusProjectionSet,
} from "./statusProjection";
import { alignDefinitionsAndStates, readTaskStates, TASK_STATUS_LABELS, type TaskState } from "./tasks";
// V09-53（B3）：唯一义务/状态派生入口（§2.6）——入口的投影与逐项工作包出自**同一份** factsSnapshot.obligations。
import {
  definitionBindingKey,
  deriveObligations,
  requiredChecksOf,
  type DefinitionBindingVerdict,
  type ObligationSet,
} from "./obligations";
import {
  buildWorkPackage,
  type CapabilityClass,
  type SourceMode,
  type WorkPackageFailure,
  type WorkPackageFactsSnapshot,
  type WorkPackageFull,
  type WorkPackageOwnership,
} from "./workPackage";
import { loadStageReads, STAGE_READS_REL, type StageReadKind, type StageReadsLoad } from "./stageReads";
import { evaluateEntrySync, SYNC_INBOX_REL, type SyncBlockInfo } from "./sync";
import { preconditionsOf, type EntryPreconditions } from "./preconditions";
import type { SyncRepairPlan, SyncVerdict } from "../../shared/syncEvidence";
import { parseMarkdownSections, type MarkdownSectionNode } from "../../shared/materialSection";
import { resolveDesignRefStrict, isDesignRefToken, STRICT_REF_REASON_TEXT } from "../../shared/designRefStrict";
import { WorkError } from "./types";
import { compareIsoTime, latestByTime } from "../time";
import { withDerivationScope } from "./derivationScope";

// ── §6.7 契约常量（输入、只读返回、next_action 枚举；验证脚本按这些常量对账） ──

/** §6.7 `next_action` 的**恰好七个**取值（多一个少一个都算契约漂移） */
export const PROJECT_ENTRY_ACTIONS = [
  "resume_task",
  "claim_task",
  "review_result",
  "await_role",
  "await_decision",
  "blocked",
  "complete",
] as const;
export type ProjectEntryAction = (typeof PROJECT_ENTRY_ACTIONS)[number];

/** §6.7 入口输入字段（顺序即契约顺序） */
export const PROJECT_ENTRY_INPUT_FIELDS = [
  "project_id",
  "role",
  "client_capabilities",
  "known_revision",
  "resume_hint",
] as const;

/** §6.7 只读返回字段（顺序即契约顺序）；末项 `sync_summary` 为 V09-23 的响应层同步摘要（DESIGN §2.10） */
export const PROJECT_ENTRY_RESULT_FIELDS = [
  "project",
  "baseline",
  "context_manifest",
  "current_change",
  "current_runs",
  "next_action",
  "reasons",
  "required_reads",
  "sync_summary",
] as const;

/** 七个枚举各自的触发条件（给人读的措辞；与 `decideNextAction` 的分支一一对应） */
export const NEXT_ACTION_TRIGGERS: Readonly<Record<ProjectEntryAction, string>> = {
  resume_task: "有未结束 run（已认领/执行中）且本角色能安全恢复（第 6 步；优先于新领）",
  claim_task: "依赖与证据已满足的队列里有本角色可接的卡（第 7 步；按优先级→依赖顺序→稳定 ID）",
  review_result: "本角色职责内有已提交待审的结果（协调器收件、审计者独立审、用户人工验收；第 8 步）",
  await_role: "有就绪工作但责任角色/客户端能力/已知版本不符（第 9 步；附完整交接等合适客户端）",
  await_decision: "有效基线未审定，或用户批次级退回待明确（第 2、4、10 步）",
  blocked: "现场读不出、源变更影响待查、依赖/证据未满足、范围冲突、用户退回某任务、仍有必需工作未完成（第 1、3、4、11 步）",
  complete: "当前全部必需工作均已验证通过且该批次已获用户验收（第 12 步；fail-closed）",
};

/** 为什么不能只看历史 Gate（§5.8）：本模块**从不读**任何七步 Gate 状态，也不拿它当门禁 */
export const GATE_NOT_A_GATE_NOTE =
  "本入口不读历史七步 Gate，也不拿「整条旧 Gate 是否全绿」当唯一条件（DESIGN.md §5.8）：" +
  "能否领取下一任务由有效基线、执行授权、依赖质量、角色能力、现场安全性共同决定";

// ── 输入 / 选项 ──

/** §6.7 入口输入（**恰好**这五个字段；dataDir 等进程内参数走第二个参数，不进契约） */
export interface ProjectEntryInput {
  project_id: string;
  role: string;
  /** 客户端自述能力（未声明按「仅可读取」处理；§6.2） */
  client_capabilities?: unknown;
  /** 调用方已知的版本（基线 id 或图纸修订哈希；落后就不派新任务） */
  known_revision?: string | null;
  /** 接续提示（任务/交接 ID；只是提示，不越权绕过角色/依赖/冲突检查） */
  resume_hint?: string | null;
}

export interface ProjectEntryOptions {
  dataDir?: string;
  /** 验证钩子：把"现在"固定下来（租约判定用；产品路径不传） */
  now?: string;
  /**
   * V09-23 返工C（Codex 反例12）：唯一宿主的**同一份**后台发现错误——MCP 另一进程从只读读口取来后注入，
   * 使 entry 的 `sync_summary` 与宿主 HTTP/read 读口同源（MCP 自己进程汇为空，不能冒充"后台无故障"）。
   * 不给＝读本进程汇（宿主自身路径；老调用方行为不变）。
   */
  syncDiscoveryIssues?: string[];
  /**
   * V09-34：请求附一份**接续前置事实说明**（`preconditions`）。默认 **false**＝不附，保持 §6.7 只读返回
   * **恰好九个字段**的既有默认契约；true = 从**本次已算的同一份 EntryFacts** 派生说明性清单（`blocking:false`，
   * 不新增门禁、不改 next_action/reasons）。这是轻量选项：默认省略该字段，需要时显式索取。
   */
  preconditions?: boolean;
  /**
   * V09-53（B3／DESIGN §2.7）：请求附一份**逐 check 工作包**（`work_package`）。默认 **false**＝不附，
   * 保持 §6.7 只读返回**恰好九个字段**的既有默认契约；true = 从**本次已算的同一份** `facts.obligations`
   * 派生（`buildWorkPackage`）。只读派生，不改 next_action/reasons/门禁。这是轻量选项：默认省略，需要时显式索取。
   */
  work_package?: boolean;
  /**
   * V09-53：工作包分页（**只在 `work_package=true` 时有意义**）。游标绑定 `package_revision`，跨版本 ⇒
   * 工作包显式 `REVISION_CHANGED`（不静默返回跨版本数据）。产品路径不传（取整包）；测试/读口按需用。
   */
  work_package_paging?: { limit?: number; cursor?: string; offset?: number };
  /**
   * V09-53：调用方持有的 `package_revision`（可选）。与 `work_package_paging` 正交——
   * 不符即让工作包显式 `REVISION_CHANGED`（与功能清单读口的 `expected_revision` 同口径，§2.9/§6.11）。
   * 它与 MCP 工具入口的 `expected_revision` 参数**真实相连**（不是只有纯函数支持、工具层没接）。
   */
  work_package_expected_revision?: string;
  /**
   * V09-31：**本次请求已经现读的事件快照**（`.工作台/work/` 同一 workDir、同一截点）。宿主只读入口一次
   * 取快照后，把它同时喂给入口、六图摘要与同步判据——三者出自**同一版事实**，不再各读一遍盘。
   * **只活在这一次调用栈里**：缺省＝本函数自己现读（行为逐字不变）；来源 workDir 不一致时由
   * `eventsOfSnapshot` 回退现读（不会把别人的账本当自己的）。这是进程内选项，不进 §6.7 契约。
   */
  events?: EventsSnapshot;
}

// ── 能力发现（§6.2：如实区分 只读 / 可接续 / 可协调执行） ──

export const CLIENT_CAPABILITY_CLASSES = ["read_only", "continuable", "coordination"] as const;
export type ClientCapabilityClass = (typeof CLIENT_CAPABILITY_CLASSES)[number];

export const CLIENT_CAPABILITY_LABELS: Readonly<Record<ClientCapabilityClass, string>> = {
  read_only: "仅可读取",
  continuable: "可接续",
  coordination: "可协调执行",
};

export interface CapabilityDiscovery {
  /** 归一化后的声明（保守缺省：read=true / continue=false / coordinate=false） */
  declared: { read: boolean; continue: boolean; coordinate: boolean };
  /** 三档里的实际那一档 */
  effective: ClientCapabilityClass;
  /** 依据（谁声明的、怎么解析的；缺省按只读） */
  basis: string;
  /**
   * 如实说明的边界（不假称全自动）：
   * 「可接续」只表示塔台可以对它派发并接受它的回报，**不**表示它一定会主动调用工具。
   */
  limits: string[];
  /** 未识别的声明项（原样带回，不静默丢） */
  unrecognized: string[];
}

const CAPABILITY_TOKENS: Readonly<Record<string, "read" | "continue" | "coordinate">> = {
  read: "read",
  readonly: "read",
  read_only: "read",
  reading: "read",
  只读: "read",
  仅可读取: "read",
  continue: "continue",
  continuable: "continue",
  resume: "continue",
  可接续: "continue",
  coordinate: "coordinate",
  coordinator: "coordinate",
  coordination: "coordinate",
  可协调: "coordinate",
  可协调执行: "coordinate",
};

/**
 * 解析客户端能力声明（§6.2 的三档）。
 * 口径：**未声明 = 只读**（fail-closed）；只有明确声明 coordinate 才算「可协调执行」。
 */
export function capabilityOf(raw: unknown): CapabilityDiscovery {
  const declared = { read: true, continue: false, coordinate: false };
  const unrecognized: string[] = [];
  let basis = "调用方没有声明 client_capabilities：按最保守的「仅可读取」处理（DESIGN.md §6.2）";

  const apply = (token: string): void => {
    const key = CAPABILITY_TOKENS[token.trim().toLowerCase()];
    if (key === undefined) {
      if (token.trim() !== "") unrecognized.push(token.trim());
      return;
    }
    if (key === "read") declared.read = true;
    if (key === "continue") declared.continue = true;
    if (key === "coordinate") declared.coordinate = true;
  };

  if (typeof raw === "string") {
    for (const token of raw.split(/[\s,;+|]+/)) apply(token);
    basis = `调用方声明 client_capabilities=${JSON.stringify(raw)}（按字符串解析）`;
  } else if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item === "string") apply(item);
      else unrecognized.push(JSON.stringify(item));
    }
    basis = `调用方声明 client_capabilities=${JSON.stringify(raw)}（按数组解析）`;
  } else if (typeof raw === "object" && raw !== null) {
    const obj = raw as Record<string, unknown>;
    const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
    const read = bool(obj.read) ?? bool(obj.can_read);
    const cont = bool(obj.continue) ?? bool(obj.can_continue) ?? bool(obj.continuable);
    const coord = bool(obj.coordinate) ?? bool(obj.can_coordinate) ?? bool(obj.coordination);
    if (obj.tier !== undefined || obj.class !== undefined) apply(String(obj.tier ?? obj.class));
    if (read !== null) declared.read = read;
    if (cont !== null) declared.continue = cont;
    if (coord !== null) declared.coordinate = coord;
    for (const [k, v] of Object.entries(obj)) {
      if (!["read", "can_read", "continue", "can_continue", "continuable", "coordinate", "can_coordinate", "coordination", "tier", "class"].includes(k)) {
        unrecognized.push(`${k}=${JSON.stringify(v)}`);
      }
    }
    basis = `调用方声明 client_capabilities=${JSON.stringify(raw)}（按对象解析）`;
  } else if (raw !== undefined && raw !== null && raw !== "") {
    unrecognized.push(JSON.stringify(raw));
    basis = `client_capabilities 形态无法识别（${JSON.stringify(raw)}）：按最保守的「仅可读取」处理`;
  }

  const effective: ClientCapabilityClass = declared.coordinate
    ? "coordination"
    : declared.continue
      ? "continuable"
      : "read_only";
  const limits: string[] = [
    "未适配客户端只提供读取或明确的接续指令，塔台不假称全自动（DESIGN.md §6.2）",
    "MCP 暴露了工具不等于客户端必然主动调用；是否真调由客户端与项目规则决定（DESIGN.md §6.2）",
    "角色名不是安全凭证；能力档位只决定塔台派不派活，不代替服务端校验（DESIGN.md §6.5）",
  ];
  if (effective === "read_only") limits.push("只读档位：本客户端不会被派发认领/恢复任务，只拿读取与接续指令");
  if (effective === "continuable") limits.push("可接续档位：可以认领并回报；启动/终止外部进程不在塔台职责内（§6.5）");
  if (effective === "coordination") limits.push("可协调执行档位：还要配套的隔离目录与回执通道（V06-11 交付）");
  return { declared, effective, basis, limits, unrecognized };
}

// ── 角色 ──

export type RoleClass = "executor" | "auditor" | "coordinator" | "designer" | "user" | "unknown";

/** 角色别名表（把常见自报名归到几类职责；归不进去 = unknown，按"不派写任务"处理） */
export const ROLE_ALIASES: Readonly<Record<Exclude<RoleClass, "unknown">, readonly string[]>> = {
  executor: ["executor", "执行者", "施工者", "施工", "kimi-code", "kimicode", "worker", "developer", "dev", "agent"],
  auditor: ["auditor", "审计者", "审计", "reviewer", "verifier", "验证者"],
  coordinator: ["coordinator", "协调器", "协调", "claude-code", "orchestrator"],
  designer: ["designer", "设计者", "设计", "gpt-6", "architect", "审定者"],
  user: ["user", "主人", "人类", "human", "owner"],
};

/**
 * 角色名归一化：`**责任角色**：审计者。` 这类施工图取值会带上收尾标点，
 * 归一时去掉首尾引号/空白/中文标点，避免"名字对得上却因为一个句号判成角色不符"。
 */
export function normalizeRole(role: string): string {
  return role
    .trim()
    .replace(/^[「"'（(\[]+/, "")
    .replace(/[」"'）)\]。，、；：,.;:]+$/, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

export function roleClassOf(role: string): RoleClass {
  const key = normalizeRole(role);
  if (key === "") return "unknown";
  for (const [cls, aliases] of Object.entries(ROLE_ALIASES)) {
    if (aliases.includes(key)) return cls as RoleClass;
  }
  return "unknown";
}

/**
 * 任务的责任角色是否容得下本角色：施工图**声明了**责任角色就必须对得上
 * （逐字或同一职责类）；没声明 = 任何执行角色可按职责接（§6.7 的"从队列里选"）。
 */
export function roleMatches(ownerRole: string | null, role: string): { ok: boolean; why: string } {
  if (ownerRole === null || ownerRole.trim() === "") {
    return { ok: true, why: "施工图没有声明责任角色：任何执行角色可按职责接" };
  }
  const owner = ownerRole.trim();
  if (normalizeRole(owner) === normalizeRole(role)) return { ok: true, why: `责任角色逐字相符（${owner}）` };
  const a = roleClassOf(owner);
  const b = roleClassOf(role);
  if (a !== "unknown" && a === b) return { ok: true, why: `同一职责类（${owner} ↔ ${role}）` };
  return { ok: false, why: `责任角色是「${owner}」，本角色是「${role}」：不派（角色不符，§6.7）` };
}

// ── 优先级 / 稳定排序 ──

/**
 * 已定义优先级的排序权重（越小越先）：数字取原值，P0/P1 取数字部分，
 * 关键词按 最高<高<中<低；没声明优先级的排在所有声明过的后面（如实，不当成最高）。
 */
export function priorityRank(priority: string | null | undefined): number {
  const text = (priority ?? "").trim().toLowerCase();
  if (text === "") return Number.MAX_SAFE_INTEGER;
  const num = text.match(/\d+/);
  if (num !== null) return Number(num[0]);
  if (/最高|urgent|p0|critical/.test(text)) return 0;
  if (/高|high/.test(text)) return 1;
  if (/中|medium|normal/.test(text)) return 2;
  if (/低|low/.test(text)) return 3;
  return Number.MAX_SAFE_INTEGER - 1;
}

// ── 只读返回的形状（§6.7 八字段） ──

/** 一条理由：**必须如实**；选定动作那一条带上「任务或交接 ID、依据版本、依赖、允许范围与完成要求」 */
export interface EntryReason {
  code: string;
  text: string;
  task_id?: string | null;
  handoff_id?: string | null;
  basis_revision?: string | null;
  dependency_ids?: string[];
  allowed_paths?: string[];
  completion_requirements?: string[];
  /**
   * 该任务当前的**实体版本**（`claim_task` 的 `expected_revision` 就用它；原子领取必须带预期版本，§6.7）。
   * 它是"依据版本"的一部分：定义哈希说明"按哪版定义干"，实体版本说明"从哪个状态往下推"。
   */
  task_revision?: number | null;
  /** 候选没被选中时的缺失项（如实列出，不合并成"其它原因"） */
  missing_items?: string[];
  blocking?: boolean;
}

export interface RequiredRead {
  path: string;
  /** 显式章节绑定时 revision 是该章节哈希，不能当作整文件版本。 */
  section?: string;
  /** 取值 = `stageReads.STAGE_READ_KINDS` 的既有联合（项目级指针不发明新 kind） */
  kind: StageReadKind;
  why: string;
  revision?: string | null;
  /**
   * 阶段材料显式章节绑定时**派生**的起止行（1 基闭区间，标题行 → 子树末行；非设计图那段 `section` 参数）：
   * 执行方按 `path`+`range` 原样读回标题与整棵子树，随当前解析现算、不保存行号。
   */
  range?: { start: number; end: number } | null;
  /**
   * 用途分类（P1／§5.4）：本轮必读正文 `required_content`／追溯指针 `trace_reference`／中断续接现场 `resume_context`。
   * **恒给**（订阅方不必区分"没有"与"未分类"）；只影响读者怎么用（先读必读正文、追溯指针按需回读），
   * **不改判定、不新增授权、不改门禁**——每条仍在必读清单里并带 `why`。
   */
  purpose: RequiredReadPurpose;
  /**
   * 该条是否已解析到**当前版本**的确定位置。**仅设计引用派生条目给出**：
   * `resolved` = 已落成 `section`+`range`+`revision`；`unresolved` = 本任务声明的设计依据现在定位不到
   * （不是已读、不是已通过、不是"可跳过"——读者须按 `source_ref` 补取核实，§5.5）。
   */
  resolution?: RequiredReadResolution;
  /** `unresolved` 时的原因（章节缺失／每级路径不唯一／引用归一到不存在的章节／形态无法证明完整展开）。 */
  resolution_detail?: string;
  /** 原始引用 token（来自 `TaskDefinition.design_refs`），供人核对与补取。 */
  source_ref?: string;
}

/** 用途分类（§5.4 的闭集；只影响读者怎么用） */
export type RequiredReadPurpose = "required_content" | "trace_reference" | "resume_context";
/** 设计引用派生条目的解析态（§5.1；只在这类条目上给出） */
export type RequiredReadResolution = "resolved" | "unresolved";

export interface CurrentRun {
  task_id: string;
  run_id: string;
  attempt_id: string;
  attempt: number | null;
  owner_id: string;
  owner_role: string;
  claim_token: string;
  lease_expires_at: string;
  workspace: string;
  /** 租约状态：到期只表示「当前所有权需核实」，**不**证明旧进程已停止（§2.7） */
  lease: ReturnType<typeof leaseStateOf>;
  /** 本角色的续接前置条件（隔离目录 / 确认旧进程停止；如实给出，不当"已停止"） */
  resume_preconditions: string[];
  /**
   * 运行现场（V09-27／契约 F3；只读派生自 `execution.*`，用既有 `livenessOf` 判据）：
   * 无事件 = `no_events`（未知）；心跳缺失/超期 = `unknown`（**不等于已停止**）；
   * 只有带确认依据的 `execution.stopped` 才是 `confirmed_stopped`。绝不把缺心跳当停机。
   */
  run_site: {
    observed: boolean;
    execution_id: string | null;
    state: "confirmed_alive" | "confirmed_stopped" | "unknown" | "no_events";
    /** `unreadable` = 执行回执读不出来（现场未知）；`no_events` = 确实没有回执 */
    site_state: RunSiteState | "no_events" | "unreadable";
    last_signal_at: string | null;
    silent_ms: number | null;
    heartbeat_stale: boolean;
    note: string;
    /// 停止确认依据（没有就是 null；**不**把停止请求/失联当成依据）
    confirmation: string | null;
    last_checkpoint: { at: string; note: string; artifacts: string[]; effects_in_flight: string[] } | null;
  };
}

export interface ProjectEntry {
  project: {
    project_id: string;
    name: string;
    /** 项目根（本地绝对路径；只有本机进程内调用方看得到） */
    path: string;
    kind: string;
    workstation_dir: string;
    /** 本角色（调用方自报；角色名不是安全凭证，§6.5） */
    role: string;
    role_class: RoleClass;
    documents: {
      design: { source_path: string; origin: string; content_sha256: string; definition_sha256: string; lines: number } | null;
      plan: {
        source_path: string;
        origin: string;
        content_sha256: string;
        definition_sha256: string;
        lines: number;
        table_found: boolean;
        task_count: number;
      } | null;
    };
    /** 能力发现（§6.2：只读/可接续/可协调执行 如实区分） */
    capability: CapabilityDiscovery;
  };
  baseline: {
    active: {
      baseline_id: string;
      active_at: string;
      approved_by: string;
      approval_basis: string;
      approval_kind: string;
      design_revision: string;
      plan_revision: string;
      design_source: string;
      plan_source: string;
    } | null;
    /** true = 有生效基线且源自激活以来没变（可以直接干活） */
    valid: boolean;
    /** 失效/待核实的原因（逐条） */
    revalidate: string[];
    /** 生效基线之后源又变过（影响待查，不派发） */
    source_changed_since_baseline: boolean;
  };
  context_manifest: {
    package_id: string;
    generated_at: string;
    design_revision: string | null;
    plan_revision: string | null;
    plan_definition_digest: string | null;
    token_or_char_size: number;
    sources: ContextPackage["source_manifest"];
    omitted: ContextPackage["omitted"];
    stale_reasons: string[];
    coverage: ContextPackage["coverage"];
  };
  current_change: {
    change_id: string | null;
    task_ids: string[];
    latest_at: string | null;
    basis: { baseline_id: string | null; design_revision: string | null; plan_revision: string | null };
  } | null;
  current_runs: CurrentRun[];
  next_action: ProjectEntryAction;
  reasons: EntryReason[];
  required_reads: RequiredRead[];
  /** 同步证据摘要（V09-23／DESIGN §2.10）：在**响应层**拼，不塞进 collectProjectFacts（findings D）。未配置项目为 null。 */
  sync_summary: EntrySyncSummary | null;
  /**
   * V09-34 接续前置事实说明（**仅说明**）：只在 `opts.preconditions === true` 时给出（默认**省略**，
   * 保持 §6.7 九字段默认契约）。逐项从**本次已算的同一份 EntryFacts** 派生，`blocking:false`、
   * 不新增门禁、不改 `next_action`/`reasons`（见 `preconditions.ts`）。
   */
  preconditions?: EntryPreconditions;
  /**
   * V09-53（B3／§2.7）：逐 check 工作包。**只在 `opts.work_package===true` 时给出**（默认**省略**，
   * 保持 §6.7 九字段默认契约）。只读派生，与功能清单/六图出自**同一份** `facts.obligations`；
   * 不改 `next_action`/`reasons`/门禁。旧字段逐字保留，本字段是**兼容扩展**。
   * `WorkPackageFailure` = 分页游标/入参显式失效（**不静默返回跨版本数据**，带重读入口）。
   */
  work_package?: WorkPackageFull | WorkPackageFailure;
}

/** 同步证据的响应层摘要（判据来源＝sync 的同一份阻断评估，与 claimTask / 写口**同一份**） */
export interface EntrySyncSummary {
  configured: boolean;
  overall: SyncVerdict;
  blocked: boolean;
  blocking_batches: { batch_id: string; title: string; verdict: SyncVerdict; reasons: string[] }[];
  /**
   * P3 / V09-48：**只读修复计划**（现行批次逐项原因/来源漂移/可复用工件/契约代次/登记人/建议角色/
   * 结构化下一读取入口与补证动作）。与 `blocked`/`blocking_batches` **同一次**同步评估（不另调
   * `readSyncStatus`，全量评估不翻倍）。只读附加——不改任何门禁。
   */
  repair_plan?: SyncRepairPlan;
}

// ── 现场事实（只读；读不出来如实标 unreadable，不假装空状态） ──

export interface EntryFacts {
  projectId: string;
  dataDir: string;
  workDir: string;
  now: string;
  project: NonNullable<ReturnType<typeof getProject>>;
  states: Record<string, TaskState>;
  definitions: TaskDefinition[];
  statesByName: Record<string, { missing_fields: string[] }>;
  align: ReturnType<typeof alignDefinitionsAndStates>;
  projection: StatusProjectionSet;
  /**
   * V09-53（§2.6）：唯一义务/状态派生的结论集（`deriveObligations` 的产物）。入口的 `projection` 就是它的
   * `projection`——**同一次派生**既供入口判定、又供逐项工作包（`buildWorkPackage`）与功能清单，不各算一份。
   * 事实读不出来时为 null（对应 `unreadable`，判定层 fail-closed）。
   */
  obligations: ObligationSet | null;
  /** 同一份 `ProjectFacts`（`collectProjectFacts` 的产物；`obligations` 由它派生）。读不出来为 null。 */
  projectFacts: ProjectFacts | null;
  byId: Record<string, StatusProjection>;
  acceptances: AcceptanceRecord[];
  audit: ReturnType<typeof readAuditRecords>;
  openFindings: { task_id: string | null; must_block: boolean; status: string; finding_id: string }[];
  claims: Record<string, ClaimRecord[]>;
  live: Record<string, ClaimRecord | null>;
  /** 执行回执域现场（V09-27；无事件为空数组）：current_runs 的运行现场只读派生来源 */
  executions: ExecutionRecord[];
  /**
   * 执行回执**读不出来**的原因（V09-29／复审第 4 项）：非 null = 现场未知，
   * 不能伪装成"没有事件"（no_events）——读失败与"确实没有回执"是两种不同事实。
   */
  executions_unreadable: string | null;
  baseline: ProjectBaseline | null;
  baselineRevalidate: string[];
  /**
   * 生效基线**是否有效**（V09-31 复审）：结构化布尔＝有生效基线且**一条失效理由都没有**。
   * 判定层与前置说明一律用它，不许再拿 `baselineRevalidate` 的中文去 substring 匹配。
   */
  baselineValid: boolean;
  /** 源是否在基线激活后变过（结构化；与 `baselineValid` 区分：变过只是失效的一种） */
  baselineSourceChanged: boolean;
  /** 项目级阶段必读指针（`.工作台/work/stage-reads.json`；不存在=absent，老项目原样兼容） */
  stageReads: StageReadsLoad;
  /** 同步证据阻断（V09-23／DESIGN §2.10；未配置项目为 null，保持兼容） */
  syncBlock: SyncBlockInfo | null;
  /** P3/V09-48：只读修复计划（与 `syncBlock` **同一次**评估；未配置为空计划，读不出为 null） */
  syncRepairPlan: SyncRepairPlan | null;
  /**
   * 同步阻断**读不出来**的原因（V09-31 复审）：非 null = 同步现场未知——不能与「未配置」混为一谈
   * （`syncBlock` 为 null 且本字段为 null 才是"没配置/老项目"；读失败是另一种事实）。
   */
  syncBlockUnreadable: string | null;
  /**
   * 本次请求是否**真的**用同一份现读事件快照贯通了全链（V09-31 复审：「说明称全链同一版需事实支持」）：
   * true = `eventsSnapshotOf` 现读成功且沿任务/认领/执行/同步/投影共享；false = 快照读不出、下游各处回退现读。
   */
  eventsShared: boolean;
  /** 快照读不出来的原因（`eventsShared=false` 时给；成功时 null） */
  eventsSnapshotUnreadable: string | null;
  /**
   * 事件实体 id / 事件 id → **服务端账本 seq**（来自本次同一份现读快照；拿不到 = null）。
   * 用途：需要"按账本序"而不是"按可自报的 `occurred_at`"判定的只读派生（两轮同因诊断等）——
   * `at` 只到秒，同一秒的多条记录会让`at` 比较失去确定性（B3-REVIEW-WATCH 12:04）。
   * 快照读不出来时恒返回 null（调用方退回"读不到就不据此下结论"，**不**用自报时间顶替）。
   */
  eventSeqOf: (ref: string) => number | null;
  design: ReturnType<typeof loadDocument>;
  plan: ReturnType<typeof loadDocument>;
  context: ContextPackage | null;
  decisions: DecisionRecord[];
  unreadable: string | null;
}

function unreadableReason(message: string): EntryReason {
  return {
    code: "facts_unreadable",
    text: `现场事实读不出来：${message}。读不出就按未知处理——不判 complete、不派活（DESIGN.md §2.6/§5.6）`,
    blocking: true,
  };
}

/** 两趟投影：先算依赖释放，再让依赖线带上释放结论（与 V06-09 的只读路由同一口径）。
 *  V09-08 ⑤：**导出**给 MCP 读口复用（`get_arch` 要取与接续入口同一份的 v2 派生状态），
 *  口径一处实现、不另写第二份。 */
export function projectWithReleases(facts: {
  projectId: string;
  dataDir: string;
  definitions: TaskDefinition[];
  /** 可选：本次调用已读的事件快照（仅同一 workDir 复用，见 `EventsSnapshot`）；缺省各调用点现读 */
  events?: EventsSnapshot;
  /**
   * 可选（V09-30）：本次调用**已经算好的**同一份现场事实（同 projectId/dataDir/events 由调用方保证）。
   * 给了就直接用，**不再调 `collectProjectFacts`**——消除 `gatherFacts` 里「直接算一次 + 本函数内再算一次」
   * 的重复派生；缺省行为不变（自己现算，老调用点逐字照旧）。
   */
  projectFacts?: ProjectFacts;
  byId?: never;
}): StatusProjectionSet {
  // 同 `sixGraphsOf`：整段跑在一次派生的只读复用作用域里（作用域随本次调用结束即丢，跨请求不缓存）。
  return withDerivationScope(() => projectWithReleasesInScope(facts));
}

function projectWithReleasesInScope(facts: {
  projectId: string;
  dataDir: string;
  definitions: TaskDefinition[];
  events?: EventsSnapshot;
  projectFacts?: ProjectFacts;
  byId?: never;
}): StatusProjectionSet {
  const projectFacts = facts.projectFacts ?? collectProjectFacts(
    facts.projectId,
    facts.dataDir,
    facts.events === undefined ? {} : { events: facts.events },
  );
  const defs = facts.definitions.length > 0 ? facts.definitions : projectFacts.definitions;
  const acceptances = Object.values(projectFacts.audit.acceptances);
  // V09-29（契约 F4）：检查输入带**源清单现读复核**（绑 code 且证据带 source_manifest 的那些）；
  // 其余检查逐字照旧。project_entry/get_arch 与 HTTP 读口共用**同一份** checksFromFacts 装配口径。
  const checksNow = () => checksFromFacts(projectFacts);
  const withAcceptance = (objs: ReturnType<typeof objectsFromFacts>) =>
    objs.map((o) => ({
      ...o,
      acceptance: o.object_kind === "task" ? acceptanceDimensionOf(acceptances, { task_id: o.object_id }) : ("pending" as const),
    }));
  const pass1 = projectStatuses({
    objects: withAcceptance(objectsFromFacts(facts.projectId, facts.dataDir, projectFacts)),
    findings: projectFacts.findings,
    checks: checksNow(),
    source_revision: projectFacts.revisions,
    binding_segments: projectFacts.binding_segments,
  });
  const releases: Record<string, { released: boolean; reasons: string[]; caveats?: string[] }> = {};
  for (const def of defs) {
    for (const dep of def.dependency_ids) {
      const prerequisite = pass1.by_id[dep];
      if (prerequisite === undefined) continue;
      releases[`${dep}->${def.task_id}`] = dependencyRelease({
        prerequisite_id: dep,
        prerequisite,
        evidence_requirement: def.dependency_evidence.find((d) => d.dependency_id === dep)?.evidence ?? null,
      });
    }
  }
  return projectStatuses({
    objects: withAcceptance(objectsFromFacts(facts.projectId, facts.dataDir, projectFacts, { dependency_releases: releases })),
    findings: projectFacts.findings,
    checks: checksNow(),
    source_revision: projectFacts.revisions,
    binding_segments: projectFacts.binding_segments,
  });
}

/**
 * 基线有效性判据（DESIGN.md §2.9 / §5.6）：生效基线 + 两份源图纸是否在激活后变过。
 *
 * 抽出来是为了**一事一源**：项目入口（gatherFacts）与 doctor 工具都要报"基线还有效吗"，
 * 两处各写一遍必然漂移。
 * 返回的 messages 顺序与原实现一致（尚未激活 → 变过），调用方直接拼进各自的 reasons。
 * `source_changed` 与 `valid` 都是**结构化布尔**（V09-31 复审）：判定层与前置说明**不许**再拿
 * messages 里那句中文去 `includes("在基线激活后变过")` ——那样一旦出现其它失效理由（保全对象篡改/缺失）
 * 就会被误判成"有效/satisfied"。`valid` ＝ 有生效基线且 messages 为空（一条失效理由都没有）。
 */
export function baselineRevalidateOf(
  baseline: ProjectBaseline | null,
  current: {
    design_revision: string | null;
    plan_revision: string | null;
    /**
     * 施工图**定义**哈希（可选）。给了就按它比——DESIGN §2.9 明确：施工定义哈希只覆盖任务目标、
     * 范围、依赖、接口与验收内容，**不含派生状态、更新时间和执行日志**（"避免每报一次进度就把基线作废"）。
     * 缺省退回内容哈希（老调用方行为不变）。设计书一侧仍比内容哈希：设计书没有"定义/记录"之分。
     */
    plan_definition_revision?: string | null;
  },
): { messages: string[]; source_changed: boolean; valid: boolean } {
  const messages: string[] = [];
  if (baseline === null) {
    messages.push("尚未激活成套图纸基线（生效决定为空，不能假设按哪一版干活）");
    return { messages, source_changed: false, valid: false };
  }
  const nowPlan = current.plan_definition_revision ?? current.plan_revision;
  // V09-53（实测缺陷修复）：源**读不到**（文件被删/读不动 ⇒ 修订为 null）**不等价于「没变」**。
  // 旧判据只在「修订非 null 且不等」时置 sourceChanged——设计书/施工图被删时修订为 null，旧判据算成
  // `source_changed=false`，于是入口继续放行（实测：删 DESIGN 后 current revision=null 仍 claim）。
  // 当前图纸版本无法确认，等价于源已变：一律 fail-closed，不派发新任务（§2.9/§5.6）。**无关源**变化不经此路径。
  const designMissing = current.design_revision === null;
  const planMissing = nowPlan === null;
  const changed =
    (current.design_revision !== null && current.design_revision !== baseline.design_revision.content_sha256) ||
    (nowPlan !== null && nowPlan !== baseline.plan_revision.definition_sha256);
  const sourceChanged = designMissing || planMissing || changed;
  if (designMissing || planMissing) {
    const missing = [designMissing ? "设计书" : null, planMissing ? "施工图" : null]
      .filter((x): x is string => x !== null)
      .join("、");
    messages.push(
      `现行${missing}源**读不到**（缺失或不可读，修订为 null）：当前图纸版本无法确认，等价于源已变——影响待查，` +
        "fail-closed 不派发新任务（DESIGN.md §2.9/§5.6；「读不到」不等于「没变」）",
    );
  }
  if (changed) {
    messages.push(
      `设计/施工图源在基线激活后变过（基线 design=${baseline.design_revision.content_sha256.slice(0, 12)}… / ` +
        `plan 定义=${baseline.plan_revision.definition_sha256.slice(0, 12)}…；设计比内容哈希、施工图比定义哈希）：影响待查（§5.6）`,
    );
  }
  // V09-31 复审：`valid` **按结构事实**给——**不是**拿消息文本去 match「变过」那句（复审：其它 baselineRevalidate
  // 失败，如保全对象篡改/缺失，同样不能标 satisfied）。有生效基线且**一条失效理由都没有**才算有效。
  return { messages, source_changed: sourceChanged, valid: messages.length === 0 };
}

/** 汇总现场事实（全部只读；任何一步读不出来都记进 `unreadable`，由判定层 fail-closed） */
function gatherFacts(
  projectId: string,
  dataDir: string,
  now: string,
  syncDiscoveryIssues?: string[],
  sharedSnapshot?: EventsSnapshot,
): EntryFacts {
  const project = getProject(projectId, dataDir);
  if (!project) {
    throw new WorkError("INVALID_COMMAND", `项目不存在: ${projectId}`, { project_id: projectId });
  }
  const workDir = projectWorkDir(projectId, dataDir);
  // 项目级阶段必读指针（§6.7 required_reads 的项目级扩展；只读、fail-closed）。
  // 读不出/不合法的**不抛**（入口要如实给 blocked，而不是让调用方收一个错误），
  // 只有"文件真的不存在"才 absent——老项目因此完全兼容。
  let stageReads: StageReadsLoad;
  try {
    stageReads = loadStageReads(path.resolve(project.path));
  } catch (e) {
    stageReads = {
      status: "invalid",
      reasons: [`${STAGE_READS_REL} 读取失败：${e instanceof Error ? e.message : String(e)}`],
    };
  }
  // V09-30：同一次请求**只读一次事件账本**（`eventsSnapshotOf`），把这份同一 workDir 的同一截点快照沿
  // 任务/认领/执行/同步核验/投影全链传下去共享——与六图摘要同一套 `EventsSnapshot` 骨架。它**只活在这一次
  // 调用栈里**：下一次调用立刻现读、立刻见到新事件，**绝不跨请求缓存旧绿**。读不出来就不传（`eventsSnapshot=null`），
  // 下游各按既有路径现读并如实报错，失败语义逐字不变（不把读失败伪装成空状态）。
  //
  // V09-31：调用方（宿主只读入口）可**传入**它已经为整次请求现读的那一份快照——入口、六图摘要与同步判据
  // 共用同一版事实，不再各读一遍盘。来源 workDir 与本项目不一致时**不算数**（`eventsOfSnapshot` 会回退现读），
  // 且 `eventsShared` 只如实反映"这一次**真的**复用了同一份快照"（复审：说明称全链同一版需事实支持）。
  let eventsSnapshot: EventsSnapshot | null = null;
  let eventsSnapshotUnreadable: string | null = null;
  if (
    sharedSnapshot !== undefined &&
    sharedSnapshot !== null &&
    sharedSnapshot.work_dir === workDir
  ) {
    eventsSnapshot = sharedSnapshot;
  } else {
    try {
      eventsSnapshot = eventsSnapshotOf(projectId, dataDir);
    } catch (e) {
      eventsSnapshot = null;
      eventsSnapshotUnreadable = e instanceof Error ? e.message : String(e);
    }
  }
  const eventsShared = eventsSnapshot !== null;
  const sharedEvents = eventsSnapshot === null ? undefined : eventsSnapshot.events;
  // 账本序解析器（B3-REVIEW-WATCH 12:04）：同一次快照里 `entity_id`/`event_id` → `seq`，
  // 供"按服务端序、不按自报 at"的只读判定（两轮同因诊断）用。快照读不出来 ⇒ 恒 null（不拿自报时间顶替）。
  const entitySeqOf = new Map<string, number>();
  if (sharedEvents !== undefined) {
    for (const e of sharedEvents) {
      if (typeof e.entity_id === "string" && e.entity_id !== "") entitySeqOf.set(e.entity_id, e.seq);
      if (typeof e.event_id === "string" && e.event_id !== "") entitySeqOf.set(e.event_id, e.seq);
    }
  }
  const eventSeqOf = (ref: string): number | null => entitySeqOf.get(ref) ?? null;

  let unreadable: string | null = null;
  let states: Record<string, TaskState> = {};
  let claims: Record<string, ClaimRecord[]> = {};
  try {
    states = readTaskStates(workDir, sharedEvents).states;
    claims = claimRecordsOf(readClaimEvents(workDir, sharedEvents));
  } catch (e) {
    unreadable = `事件现场读不出来（${(e as Error).message}）`;
  }

  // 同步证据阻断（V09-23／DESIGN §2.10）：只读、fail-closed。未配置项目 computeSyncBlock 返回
  // blocked=false（老项目零影响）；读不出来**不抛**——入口如实按"读不出"处理（见 decideNextAction 第 1.6 步）。
  // V09-30：喂同一份快照，使同步判据与上面的任务/认领、下面的投影出自**同一版**事实（同版接续，V09-31 请求内部分）。
  let syncBlock: SyncBlockInfo | null = null;
  let syncRepairPlan: SyncRepairPlan | null = null;
  let syncBlockUnreadable: string | null = null;
  try {
    // P3/V09-48：**同一次**评估同时产出阻断判据与只读修复计划（不另调 readSyncStatus → 全量评估不翻倍）。
    const evaluated = evaluateEntrySync(projectId, dataDir, {
      ...(syncDiscoveryIssues === undefined ? {} : { discoveryIssues: syncDiscoveryIssues }),
      ...(sharedEvents === undefined ? {} : { events: sharedEvents }),
    });
    syncBlock = evaluated.block;
    syncRepairPlan = evaluated.repair_plan;
  } catch (e) {
    syncBlockUnreadable = e instanceof Error ? e.message : String(e);
    unreadable ??= `同步证据现场读不出来（${syncBlockUnreadable}）`;
  }

  const design = loadDocument(projectId, "design", dataDir);
  const plan = loadDocument(projectId, "plan", dataDir);
  const imported = plan === null ? null : importTaskDefinitions(plan.text, { plan_revision: plan.revision.content_sha256 });
  const definitions = imported?.definitions ?? [];
  const statesByName: EntryFacts["statesByName"] = {};
  for (const entry of imported?.report.tasks ?? []) statesByName[entry.task_id] = { missing_fields: entry.missing_fields };

  let baseline: ProjectBaseline | null = null;
  const baselineRevalidate: string[] = [];
  let baselineReadable = true;
  try {
    baseline = activeBaseline(projectId, dataDir);
  } catch (e) {
    baselineReadable = false;
    baselineRevalidate.push(`基线流水不可读：${(e as Error).message}`);
  }
  const baselineHealth = baselineRevalidateOf(baseline, {
    design_revision: design === null ? null : design.revision.content_sha256,
    plan_revision: plan === null ? null : plan.revision.content_sha256,
    plan_definition_revision: plan === null ? null : plan.revision.definition_sha256,
  });
  baselineRevalidate.push(...baselineHealth.messages);
  // V09-31 复审：结构化给「有效/源变过」——基线流水读不出来时，即便 baseline 恰为非 null 也不算有效。
  const baselineValid = baselineReadable && baselineHealth.valid;
  const baselineSourceChanged = baselineHealth.source_changed;
  // V09-30：`collectProjectFacts` **只算一次**，既供本函数的审计/缺陷取用，又透传给下面的
  // `projectWithReleases` 复用（消除「直接算一次 + projectWithReleases 内再算一次」的重复派生）。
  const project_facts = (() => {
    try {
      return collectProjectFacts(projectId, dataDir, eventsSnapshot === null ? {} : { events: eventsSnapshot });
    } catch (e) {
      unreadable ??= `任务/审计事实读不出来（${(e as Error).message}）`;
      return null;
    }
  })();

  let projection: StatusProjectionSet = { objects: [], by_id: {}, summary: { counts: {} as never, unmapped: [], blocking_findings: [], basis: "" } };
  let obligations: ObligationSet | null = null;
  try {
    if (project_facts === null) {
      // 事实读不出来：仍走既有回退路径（本函数内会再尝试并如实记 unreadable），判定层 fail-closed。
      projection = projectWithReleases({
        projectId,
        dataDir,
        definitions,
        ...(eventsSnapshot === null ? {} : { events: eventsSnapshot }),
      });
    } else {
      // V09-53（§2.6）：唯一义务/状态派生入口——入口的 `projection` **就是**它的 `projection`，
      // 后续逐项工作包（`buildWorkPackage`）复用同一份 `obligations`，不另算一份状态、不各写一套绿公式。
      //
      // B3-REVIEW-WATCH 12:05：**必须**把**本次同一份**原始事件（`sharedEvents`，与 `facts` 同一快照）传进来——
      // 否则记录级「record→账本 seq→当时不可变定义」的语义核验（`deriveObligations` 内 `checkDefinitionBindingsOf`）
      // 在生产入口/宿主路径上被**跳过**，同 stableID 改要求仍能继承旧绿（fail-open 假绿）。
      // 这里复用已在上面现读/传入的同一快照，**不另读一遍盘**：`deriveObligations` 与 `collectProjectFacts`
      // 出自同一份事件，入口/六图/工作包同一版事实。拿不到快照（`sharedEvents === undefined`）时不传，
      // 与既有"与 events 无关的调用行为逐字不变"口径一致（读失败如实回退，不伪装）。
      obligations = deriveObligations({
        project_id: projectId,
        data_dir: dataDir,
        facts: project_facts,
        ...(sharedEvents === undefined ? {} : { events: sharedEvents }),
      });
      projection = obligations.projection;
    }
  } catch (e) {
    unreadable ??= `状态投影算不出来（${(e as Error).message}）`;
  }

  const align = alignDefinitionsAndStates(definitions, states, plan?.revision.content_sha256 ?? "");
  let context: ContextPackage | null = null;
  try {
    // V09-39：上下文包**复用本次已现读的同一份账本快照**（`BuildContextOptions.events/eventsContent`）——
    // 不再另读一遍盘；内容身份与事件同源（契约 U1：不用 last_seq:N 冒充内容哈希）。
    context = buildContextPackage(projectId, {
      dataDir,
      maxChars: 6000,
      pageMaxChars: 1500,
      ...(sharedEvents === undefined ? {} : { events: sharedEvents }),
      ...(eventsSnapshot?.content === undefined ? {} : { eventsContent: eventsSnapshot.content }),
    });
  } catch {
    // 上下文包建不出来不阻断入口：manifest 如实缺席，entries 在 required_reads 里仍有原文入口
  }

  let decisions: DecisionRecord[] = [];
  try {
    decisions = readDecisions(workDir).records;
  } catch {
    decisions = [];
  }

  const audit = project_facts?.audit ?? { submissions: {}, self_checks: {}, independent_audits: {}, fixes: {}, retests: {}, acceptances: {}, ignored_entities: [] };
  const findings = project_facts?.findings ?? (() => {
    try {
      // V09-30：回退路径也喂同一份快照（`project_facts` 非空时本就不走这里）。
      return Object.values(readFindings(workDir, sharedEvents).findings);
    } catch {
      return [];
    }
  })();

  // 执行回执域现场（V09-27）：读得出来就是记录数组，**读不出来如实标原因**——
  // 不能把"读失败"伪装成"没有事件"（no_events），那是两种不同的事实（codex 复审第 4 项）。
  let executions: ExecutionRecord[] = [];
  let executionsUnreadable: string | null = null;
  try {
    // V09-30：执行回执折叠同一份快照（不再单独读一遍账本）。
    executions = readExecutions(workDir, sharedEvents);
  } catch (e) {
    executionsUnreadable = e instanceof Error ? e.message : String(e);
  }

  return {
    projectId,
    dataDir,
    workDir,
    now,
    project,
    states,
    definitions,
    statesByName,
    align,
    projection,
    obligations,
    projectFacts: project_facts,
    byId: projection.by_id,
    acceptances: Object.values(audit.acceptances),
    audit,
    openFindings: findings
      .filter((f) => f.status !== "closed" && f.status !== "false_positive" && f.status !== "accepted_risk")
      .map((f) => ({ task_id: f.object_id, must_block: f.must_block, status: f.status, finding_id: f.finding_id })),
    claims,
    // 「未结束 run」= 事件里有认领记录 **且** 任务还停在已认领/执行中：
    // 交了结果的卡现场已结束（§5.4 运行现场），不再算在途、也不再算范围冲突。
    live: Object.fromEntries(
      Object.entries(claims)
        .map(([t, records]) => {
          const state = states[t];
          const record = liveClaimRecord(records);
          const open = state !== undefined && (state.status === "claimed" || state.status === "executing");
          return [t, open ? record : null] as const;
        })
        .filter(([, record]) => record !== null),
    ),
    baseline,
    baselineRevalidate,
    baselineValid,
    baselineSourceChanged,
    stageReads,
    syncBlock,
    syncRepairPlan,
    syncBlockUnreadable,
    eventsShared,
    eventsSnapshotUnreadable,
    eventSeqOf,
    design,
    plan,
    context,
    decisions,
    executions,
    executions_unreadable: executionsUnreadable,
    unreadable,
  };
}

// ── 候选评估 ──

interface Candidate {
  def: TaskDefinition;
  state: TaskState | null;
  /** 依赖释放结论（逐条） */
  dependencies: { id: string; released: boolean; reasons: string[] }[];
  /** 允许修改范围冲突（与在途 run 的任务比对） */
  conflicts: string[];
  /** 无法判定的范围问题（未声明路径等；如实标，不静默放过） */
  caveats: string[];
  role: { ok: boolean; why: string };
  /** 该卡还缺什么（缺失项，如实列出） */
  missing_items: string[];
  /** 完成要求（定义里的验收项 + 完成证据 + 交付物） */
  completion_requirements: string[];
  depLevel: number;
}

const normPath = (p: string): string => p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "").toLowerCase();

/** 依赖层级（依赖顺序用；成环按 0 处理，不在本模块报错——结构校验是 V06-02 的活） */
function dependencyLevels(defs: TaskDefinition[]): Record<string, number> {
  const byId = new Map(defs.map((d) => [d.task_id, d]));
  const memo: Record<string, number> = {};
  const visit = (id: string, stack: Set<string>): number => {
    if (memo[id] !== undefined) return memo[id];
    if (stack.has(id)) return 0;
    const def = byId.get(id);
    if (def === undefined || def.dependency_ids.length === 0) {
      memo[id] = 0;
      return 0;
    }
    stack.add(id);
    let level = 0;
    for (const dep of def.dependency_ids) level = Math.max(level, visit(dep, stack) + 1);
    stack.delete(id);
    memo[id] = level;
    return level;
  };
  for (const d of defs) visit(d.task_id, new Set());
  return memo;
}

/** 与在途认领的范围冲突（两个执行者不得同时改同一接口，§5.4/§2.7） */
function scopeConflicts(def: TaskDefinition, facts: EntryFacts): { conflicts: string[]; caveats: string[] } {
  const conflicts: string[] = [];
  const caveats: string[] = [];
  const mine = new Set(def.allowed_paths.map(normPath));
  for (const [taskId, record] of Object.entries(facts.live)) {
    if (record === null || taskId === def.task_id) continue;
    const other = facts.definitions.find((d) => d.task_id === taskId);
    const otherPaths = new Set((other?.allowed_paths ?? []).map(normPath));
    if (mine.size > 0 && otherPaths.size > 0) {
      const overlap = [...mine].filter((p) => otherPaths.has(p));
      if (overlap.length > 0) {
        conflicts.push(
          `${taskId} 正在 ${record.owner_id ?? "?"} 手里（租约 ${record.lease_expires_at ?? "未知"}），` +
            `本卡允许修改范围与它重叠（${overlap.slice(0, 4).join("、")}）：同一接口不能两个执行者同时改（§5.4）`,
        );
      }
    } else {
      caveats.push(
        `${taskId} 在途（${record.owner_id ?? "?"}），而${mine.size === 0 ? "本卡" : "它"}没有声明允许修改路径：` +
          "范围冲突无法机械判定，由协调器串行化重叠修改（§5.4）",
      );
    }
    if (record.workspace !== null && record.workspace !== "" && record.workspace === def.allowed_paths.join("")) {
      conflicts.push(`${taskId} 与本卡指向同一工作目录 ${record.workspace}`);
    }
  }
  return { conflicts, caveats };
}

function completionRequirementsOf(def: TaskDefinition): string[] {
  const out: string[] = [];
  for (const check of def.acceptance?.checks ?? []) out.push(`验收：${check.text}`);
  if (def.evidence_requirement !== null && def.evidence_requirement !== "") {
    out.push(`完成证据要求：${def.evidence_requirement}`);
  }
  for (const d of def.deliverables ?? []) out.push(`期望交付物：${d}`);
  if (out.length === 0) out.push("该卡没有声明验收项/完成证据/交付物：按施工图原文与 §2.7 任务契约补齐后再派");
  return out;
}

function assessCandidate(def: TaskDefinition, facts: EntryFacts, levels: Record<string, number>, role: string): Candidate {
  const state = facts.states[def.task_id] ?? null;
  const dependencies = def.dependency_ids.map((dep) => {
    const prerequisite = facts.byId[dep];
    if (prerequisite === undefined) {
      return { id: dep, released: false, reasons: [`前置 ${dep} 还没有任何运行状态（依赖未释放）`] };
    }
    const release = dependencyRelease({
      prerequisite_id: dep,
      prerequisite,
      evidence_requirement: def.dependency_evidence.find((d) => d.dependency_id === dep)?.evidence ?? null,
    });
    return { id: dep, released: release.released, reasons: release.reasons };
  });
  const { conflicts, caveats } = scopeConflicts(def, facts);
  const missing_items: string[] = [...(facts.statesByName[def.task_id]?.missing_fields ?? [])];
  if (state === null) missing_items.push("运行状态（还没有 task.definition_imported）");
  if (facts.align.needs_rebind.some((r) => r.task_id === def.task_id)) missing_items.push("定义重绑（状态绑在旧定义上，§5.6）");
  if (facts.align.orphan_states.some((o) => o.task_id === def.task_id)) missing_items.push("当前定义（运行状态对不上任何定义）");
  return {
    def,
    state,
    dependencies,
    conflicts,
    caveats,
    role: roleMatches(def.owner_role, role),
    missing_items,
    completion_requirements: completionRequirementsOf(def),
    depLevel: levels[def.task_id] ?? 0,
  };
}

// ── 判定 ──

interface Decision {
  action: ProjectEntryAction;
  reasons: EntryReason[];
  required_reads: RequiredRead[];
}

interface DecideInput {
  facts: EntryFacts;
  role: string;
  capability: CapabilityDiscovery;
  knownRevision: string | null;
  resumeHint: string | null;
  acceptance: ReturnType<typeof rejectionScopeOf>;
}

/** 停受影响任务资格：被用户退回的任务 + 依赖它的任务（§5.8「记录影响范围并暂停受影响的交付/任务资格」） */
function rejectionScopeOf(facts: EntryFacts): {
  rejected: AcceptanceRecord[];
  batchRejected: AcceptanceRecord | null;
  suspended: Set<string>;
  reasons: EntryReason[];
} {
  // 验收记录的 `at` 来自调用方 `occurred_at`（偏移任意）：按**真实时刻**正序排，不能比字面钟点。
  // `compareIsoTime` 把非法/缺失时间排在最前 → 一条时间非法的记录永远抢不到"某任务最新一次验收"；
  // 整组时间都非法时退化为事实顺序（事件顺序），此时不再声称"按时间最新"。
  const byTime = [...facts.acceptances].sort((a, b) => compareIsoTime(a.at, b.at));
  const latestByTask = new Map<string, AcceptanceRecord>();
  let batchRejected: AcceptanceRecord | null = null;
  for (const rec of byTime) {
    if (rec.task_id === null || rec.task_id === "") {
      if (rec.decision === "reject") batchRejected = rec;
      continue;
    }
    latestByTask.set(rec.task_id, rec);
  }
  const rejected = [...latestByTask.values()].filter((r) => r.decision === "reject");
  const suspended = new Set<string>();
  const reasons: EntryReason[] = [];
  if (rejected.length > 0) {
    const queue = rejected.map((r) => r.task_id!) as string[];
    for (const id of queue) suspended.add(id);
    // 依赖方一并停（依赖未满足 + 交付资格暂停）
    let grew = true;
    while (grew) {
      grew = false;
      for (const def of facts.definitions) {
        if (suspended.has(def.task_id)) continue;
        if (def.dependency_ids.some((d) => suspended.has(d))) {
          suspended.add(def.task_id);
          grew = true;
        }
      }
    }
    reasons.push({
      code: "user_rejected",
      text:
        `用户退回（${rejected.map((r) => `${r.task_id}@${r.at}`).join("、")}）：暂停受影响任务的交付/任务资格` +
        `（影响范围 ${[...suspended].sort().join("、")}）；修复授权明确后由协调器建立修复任务，沿原验收要求继续（DESIGN.md §5.8）`,
      task_id: rejected[0].task_id,
      blocking: true,
    });
  }
  if (batchRejected !== null) {
    reasons.push({
      code: "user_rejected_batch",
      text:
        `用户在批次层面退回（${batchRejected.record_id}，${batchRejected.at}，理由：${batchRejected.note ?? "未写"}）：` +
        "影响范围与目标变化要由用户/获授权设计角色先明确，塔台不自行改目标（§5.8）",
      blocking: true,
    });
  }
  return { rejected, batchRejected, suspended, reasons };
}

/** 当前版本的"新鲜度令牌"集合：基线 id + 两份图纸修订（调用方声明任一个都算已知当前版本） */
function revisionTokens(facts: EntryFacts): Set<string> {
  const tokens = new Set<string>();
  if (facts.baseline !== null) tokens.add(facts.baseline.baseline_id);
  if (facts.design !== null) tokens.add(facts.design.revision.content_sha256);
  if (facts.plan !== null) tokens.add(facts.plan.revision.content_sha256);
  return tokens;
}

/** 主判定（§6.7 的优先顺序；短路先中者胜） */
function decideNextAction(input: DecideInput): Decision {
  const { facts, role, capability, knownRevision, resumeHint } = input;
  const reasons: EntryReason[] = [];
  const reads = requiredReads(facts, null);
  const levels = dependencyLevels(facts.definitions);

  // ── 1. 事实可读 ──
  if (facts.unreadable !== null) {
    return { action: "blocked", reasons: [unreadableReason(facts.unreadable)], required_reads: reads };
  }

  // ── 1.5 项目级阶段必读指针（`.工作台/work/stage-reads.json`）──
  // 指针是机器派生的事实：坏 JSON/类型不对/来源哈希漂移/路径逃逸 —— 一律**不派活**（fail-closed），
  // 不静默按旧口径给出接续包。指针不存在 = 老项目原样兼容（不加理由、不阻断，见 stageReads.ts 口径）。
  if (facts.stageReads.status === "invalid") {
    reasons.push({
      code: "stage_reads_invalid",
      text:
        `项目级阶段必读指针不可用：${facts.stageReads.reasons.join("；")}。` +
        "指针是机器派生的来源声明（不是新设计、不是授权源）：**来源缺失或改过就拒发**——" +
        "先修好/重新生成该指针（或删掉它回到无指针口径），再回来取接续工作；本条不派任何任务",
      blocking: true,
    });
    return { action: "blocked", reasons, required_reads: reads };
  }

  // ── 1.6 同步证据阻断（V09-23／DESIGN §2.10）──
  // active 且 blocks_entry 的批次未当前通过时：列出差项、required_reads 带上证据入口、next_action=blocked，
  // 与 claimTask / 唯一写服务锁内 task.claimed 门禁**同一份判据**（computeSyncBlock），避免绕开入口。
  if (facts.syncBlock !== null && facts.syncBlock.blocked) {
    for (const b of facts.syncBlock.batches) {
      reasons.push({
        code: "sync_blocked",
        text:
          `同步批次「${b.title}」（${b.batch_id}）未当前通过（verdict=${b.verdict}）：` +
          `${b.reasons.slice(0, 6).join("；") || "缺项/目标不符"}。` +
          "本批次声明 blocks_entry：其登记范围对账通过前不派发新任务、不放行实际认领；" +
          "先补齐/修复证据或按契约收口，或以新批次显式 supersede 旧批次（DESIGN.md §2.10）",
        blocking: true,
        missing_items: b.reasons.slice(0, 6),
      });
    }
    return { action: "blocked", reasons, required_reads: requiredReads(facts, null) };
  }

  // ── 2. 有效基线 ──
  if (facts.baseline === null) {
    reasons.push({
      code: "baseline_missing",
      text:
        `没有生效的成套图纸基线：${facts.baselineRevalidate.join("；")}。` +
        "先由**用户本人或获授权的设计/协调角色**审定并激活基线（§2.9），塔台在基线生效前不派发新任务（否则就是拿不确定的输入开工）。" +
        "可执行入口：① MCP `manage_baseline {op:\"read\", project_id}` 只读当前两份图纸与生效基线（零副作用）；" +
        "② MCP `manage_baseline {op:\"activate\", project_id, role:\"designer\"|\"coordinator\", approved_by, approval_basis, " +
        "expected:{design_content_sha256, plan_content_sha256}}` 做**技术审定**激活（审定类型固定 delegated_technical_review，" +
        "零差异、不调模型、不写用户 Gate；expected 两份哈希取自 ① 的当前值）；" +
        "③ 或由人在设计书页「现有成套图纸 · 审定与激活」区点「审定并激活基线」（用户确认走界面，Agent 不代签）。" +
        "缺图纸/结构冲突/读取后源变化会被明确拒绝，按返回原因补齐再重试。",
      blocking: true,
    });
    return { action: "await_decision", reasons, required_reads: reads };
  }
  reasons.push({
    code: "baseline_active",
    text:
      `有效基线 ${facts.baseline.baseline_id}（审定 ${facts.baseline.approved_by} / ${facts.baseline.approval_kind}，` +
      `生效 ${facts.baseline.active_at}）`,
    basis_revision: facts.baseline.plan_revision.content_sha256,
  });

  // ── 3. 源在基线激活后变过（**或读不到**）→ 影响待查，不派发 ──
  // V09-53：源被删/读不动时 `baselineSourceChanged` 也为 true（见 `baselineRevalidateOf`）——「读不到」不等于「没变」，
  // 一律 fail-closed；精确原因（改了 / 读不到哪个源）在 `baseline.revalidate` 与下面的括注里逐条点名。
  if (facts.baselineSourceChanged) {
    reasons.push({
      code: "impact_unknown",
      text:
        `设计/施工图源在基线激活后发生了变化（**或已读不到**）：受影响对象**影响待查**，查清前不作为就绪任务派发（DESIGN.md §5.6）。` +
        "先做影响分析并重绑/重审基线，再回来取下一项" +
        (facts.baselineRevalidate.length > 0 ? `（${facts.baselineRevalidate.join("；")}）` : ""),
      blocking: true,
    });
    return { action: "blocked", reasons, required_reads: reads };
  }

  // ── 4. 用户暂停/退回 ──
  if (input.acceptance.batchRejected !== null) {
    return { action: "await_decision", reasons: [...reasons, ...input.acceptance.reasons], required_reads: reads };
  }
  if (input.acceptance.reasons.length > 0) reasons.push(...input.acceptance.reasons);
  const suspended = input.acceptance.suspended;

  // ── 5. 待重绑 / 孤儿：这些卡不进候选（不静默换输入） ──
  for (const need of facts.align.needs_rebind) {
    reasons.push({
      code: "needs_rebind",
      text: `任务 ${need.task_id} 待重绑：${need.detail}`,
      task_id: need.task_id,
      missing_items: [need.detail],
      blocking: true,
    });
  }
  for (const orphan of facts.align.orphan_states) {
    reasons.push({
      code: "orphan_state",
      text: `任务 ${orphan.task_id} 的运行状态对不上任何当前定义：${orphan.reason}`,
      task_id: orphan.task_id,
      blocking: true,
    });
  }

  const all = facts.definitions.map((def) => assessCandidate(def, facts, levels, role));
  const excluded = new Set<string>([
    ...suspended,
    ...facts.align.needs_rebind.map((r) => r.task_id),
    ...facts.align.orphan_states.map((o) => o.task_id),
  ]);
  const cancellable = all.filter((c) => c.state?.cancelled !== true);

  // ── 6. 恢复优先：本角色能安全恢复的未结束 run ──
  const resumable = cancellable.filter((c) => {
    if (excluded.has(c.def.task_id)) return false;
    const st = c.state;
    if (st === null || (st.status !== "claimed" && st.status !== "executing")) return false;
    if (!c.role.ok) return false;
    if (c.conflicts.length > 0) return false;
    return c.dependencies.every((d) => d.released);
  });
  if (resumable.length > 0) {
    const chosen = pickStable(resumable);
    const run = runOf(facts, chosen);
    reasons.push({
      code: "resume_available",
      text:
        `未结束 run：任务 ${chosen.def.task_id} 处于「${TASK_STATUS_LABELS[chosen.state!.status]}」，` +
        `持有者 ${chosen.state!.owner_id ?? "?"} 与本角色相符：**恢复优先于新领**（§6.7）。` +
        `当前实体版本 ${chosen.state!.revision}（续约/提交都用它当 expected_revision）。` +
        (run === null
          ? "现场没有认领记录（状态有、认领没了）：按「所有权需核实」处理"
          : `租约 ${run.lease}：${leaseNoteFor(run.lease)}；续接前先按 resume_preconditions 核实旧现场`),
      ...packOf(chosen, facts),
    });
    return {
      action: applyClientGate({
        action: "resume_task",
        taskId: chosen.def.task_id,
        reasons,
        facts,
        capability,
        knownRevision,
      }),
      reasons,
      required_reads: requiredReads(facts, chosen.def),
    };
  }
  // 本角色之外的在途 run：如实报出（不当成"没人管"）
  for (const [taskId, record] of Object.entries(facts.live)) {
    if (record === null) continue;
    const st = facts.states[taskId];
    if (st === undefined || (st.status !== "claimed" && st.status !== "executing")) continue;
    const def = facts.definitions.find((d) => d.task_id === taskId) ?? null;
    const mine = def !== null ? roleMatches(def.owner_role, role) : { ok: false, why: "施工图里找不到这张卡" };
    if (mine.ok) continue;
    reasons.push({
      code: "run_other_role",
      text:
        `任务 ${taskId} 的未结束 run 由 ${record.owner_id ?? "?"}（role=${record.owner_role ?? record.role}）持有，` +
        `租约 ${leaseStateOf(record.lease_expires_at, facts.now)}：${leaseNoteFor(leaseStateOf(record.lease_expires_at, facts.now))}。` +
        `${mine.why}——本角色不接它（要重派须先核实旧进程与旧认领，§2.7）`,
      task_id: taskId,
    });
  }

  // ── 7. 依赖与证据已满足的队列 → claim_task ──
  const ready = cancellable.filter((c) => {
    if (excluded.has(c.def.task_id)) return false;
    const st = c.state;
    if (st === null) return false;
    if (st.status !== "preparing" && st.status !== "ready") return false;
    if (!c.role.ok) return false;
    if (c.conflicts.length > 0) return false;
    return c.dependencies.every((d) => d.released);
  });
  const stagePreferred = facts.stageReads.status === "ok" ? facts.stageReads.preferred_task_id : null;
  const hinted = pickHint(ready, resumeHint, reasons, stagePreferred);
  if (hinted !== null) {
    const c = hinted;
    if (ready.length > 1) {
      const order = [...ready].sort(
        (a, b) =>
          priorityRank(a.def.priority) - priorityRank(b.def.priority) ||
          a.depLevel - b.depLevel ||
          a.def.stable_key.localeCompare(b.def.stable_key),
      );
      reasons.push({
        code: "candidate_order",
        text:
          `就绪队列共 ${ready.length} 张，按「已定义优先级 → 依赖顺序 → 稳定 ID」排序：` +
          order
            .map(
              (x, i) =>
                `${i + 1}.${x.def.task_id}（优先级 ${x.def.priority ?? "未声明"}，依赖层级 ${x.depLevel}）` +
                (x.def.task_id === c.def.task_id ? " ← 本次选中" : ""),
            )
            .join("；") +
          "。其余仍在队列里等下一轮（没有就绪任务才轮得到别的动作）",
        missing_items: order.filter((x) => x.def.task_id !== c.def.task_id).map((x) => x.def.task_id),
      });
    }
    reasons.push({
      code: "claimable",
      text:
        `按「已定义优先级 ${c.def.priority ?? "（未声明）"} → 依赖顺序（层级 ${c.depLevel}）→ 稳定 ID」选出 ` +
        `任务 ${c.def.task_id}「${c.def.goal ?? "（无目标描述）"}」：依赖已释放、角色相符、范围无冲突，可以领取。` +
        `调用 claim_task 时带 expected_revision=${c.state!.revision}（当前实体版本）与隔离 workspace。` +
        (c.caveats.length > 0 ? `注意：${c.caveats.join("；")}` : ""),
      ...packOf(c, facts),
    });
    // V09-10（附录 F）：返工重开的卡在入口如实呈现三态——当前 attempt／返工理由与依据／上一提交引用
    // （历史提交与证据永久保留，seq 引用链不断；重开只是回到可认领态，不产生任何执行事实、不恢复旧绿）
    const reopenTrace = c.state?.last_reopen ?? null;
    if (reopenTrace !== null) {
      reasons.push({
        code: "reopen_trace",
        text:
          `任务 ${c.def.task_id} 是协调器重开的返工卡（第 ${reopenTrace.attempt} 次尝试，` +
          `attempt_id ${reopenTrace.attempt_id}；返工理由：${reopenTrace.reason}；` +
          `依据：${reopenTrace.reopen_basis.join("、")}；` +
          `上一提交 seq ${reopenTrace.previous_result.seq}（事件 ${reopenTrace.previous_result.event_id.slice(0, 8)}…，` +
          `run ${reopenTrace.previous_result.run_id ?? "?"}））——旧提交事件与证据永久保留、旧认领 token 已作废`,
        task_id: c.def.task_id,
        task_revision: c.state?.revision ?? null,
      });
    }
    return {
      action: applyClientGate({
        action: "claim_task",
        taskId: c.def.task_id,
        reasons,
        facts,
        capability,
        knownRevision,
      }),
      reasons,
      required_reads: requiredReads(facts, c.def),
    };
  }

  // ── 8. 本角色职责内的待审结果 → review_result ──
  const review = reviewCandidates(facts, role, all);
  if (review.length > 0) {
    const target = review[0];
    reasons.push({
      code: "review_pending",
      text: target.why,
      task_id: target.task_id,
      handoff_id: `${target.task_id}@${facts.plan?.revision.content_sha256.slice(0, 12) ?? "无图纸"}`,
      basis_revision: facts.plan?.revision.content_sha256 ?? null,
      completion_requirements: target.requirements,
      blocking: true,
    });
    return { action: "review_result", reasons, required_reads: requiredReads(facts, target.def) };
  }

  // 人验仍是必需义务；技术项均已有效通过时停止向 Agent 重派复审。
  const humanPending = all.find(c => technicalReviewState(facts, c.def.task_id).onlyHumanPending);
  if (humanPending) {
    const review = technicalReviewState(facts, humanPending.def.task_id);
    reasons.push({code:"role_mismatch",text:`等待真实用户或测试人：${review.gaps.join("；")}。Agent 不代验。`,
      ...packOf(humanPending,facts),blocking:true});
    return {action:"await_role",reasons,required_reads:requiredReads(facts,humanPending.def)};
  }

  // ── 9. 有就绪候选但角色不符 → await_role（保留完整交接） ──
  const roleBlocked = cancellable.filter((c) => {
    if (excluded.has(c.def.task_id)) return false;
    const st = c.state;
    if (st === null || (st.status !== "preparing" && st.status !== "ready")) return false;
    if (c.conflicts.length > 0) return false;
    if (c.dependencies.every((d) => d.released)) return true;
    return false;
  });
  if (roleBlocked.length > 0) {
    const c = pickStable(roleBlocked);
    reasons.push({
      code: "role_mismatch",
      text:
        `有就绪任务但**角色不符，不派**：任务 ${c.def.task_id} 的${c.role.why}。` +
        "保留完整交接，等合适客户端/角色接入（§6.7）；塔台不替你换角色，也不把这张卡算成「没活干」",
      ...packOf(c, facts),
      blocking: true,
    });
    return { action: "await_role", reasons, required_reads: requiredReads(facts, c.def) };
  }

  // ── 10. 明确的待决事项 → await_decision ──
  const pending = pendingDecisions(facts);
  if (pending.length > 0) {
    reasons.push({
      code: "await_decision_pending",
      text:
        `有提出但未处置的待议（${pending.map((p) => p.decision_id).join("、")}）：` +
        "未决取舍未明确前，相关任务不作为就绪任务派发（§2.9/§5.6）。无关任务不受影响——当前没有无关的就绪任务",
      blocking: true,
    });
    return { action: "await_decision", reasons, required_reads: reads };
  }

  // ── 12/11. 全部必需工作与交付条件满足 → complete；否则 blocked（不藏阻塞） ──
  const verdict = completionVerdict(facts, all, role);
  if (verdict.complete) {
    reasons.push({
      code: "complete_all_verified",
      text:
        `当前全部必需工作（${verdict.required} 张卡）都已验证通过，且该批次已获用户验收：${verdict.acceptance}` +
        (verdict.limits.length > 0 ? `。**带用户已接受的已知限制**：${verdict.limits.join("；")}（不算"全绿"，如实标注）` : ""),
    });
    return { action: "complete", reasons, required_reads: reads };
  }
  for (const r of verdict.blockers) reasons.push(r);
  for (const c of all) {
    if (excluded.has(c.def.task_id)) continue;
    const st = c.state;
    if (st === null) continue;
    if (st.status === "blocked") {
      reasons.push({
        code: "blocked_task",
        text: `任务 ${c.def.task_id} 处于阻塞：${st.blocked_reason ?? "未写阻塞原因"}`,
        task_id: c.def.task_id,
        blocking: true,
        ...packOf(c, facts),
      });
    } else if (!c.role.ok) {
      reasons.push({
        code: "unhandled_task",
        text: `任务 ${c.def.task_id} 没有本角色能接的迹象（${c.role.why}），也没人在做：无人处理的任务不可被忽略（§6.7）`,
        task_id: c.def.task_id,
        blocking: true,
      });
    }
  }
  // 「没有就绪任务 ≠ 项目完成」是一条**独立结论**，无论有没有别的阻塞都要如实报出（§6.7）
  // 清单只展示前 30 项防刷屏，超出必须明示总数——静默截断会让"还有几件没完成"失真（2026-09-21 实测缺陷②）
  const remainingShown = verdict.remaining.slice(0, 30).join("、") || "（无）";
  const remainingMore = verdict.remaining.length > 30 ? `…等共 ${verdict.remaining.length} 项` : "";
  reasons.push({
    code: "no_ready_task",
    text:
      "当前没有就绪任务，但项目**没完成**：没有就绪任务不等于项目完成（§6.7）。" +
      `未完成必需工作 ${remainingShown}${remainingMore}；先处理上面的阻塞/依赖/验收缺口`,
    blocking: true,
  });
  return { action: "blocked", reasons, required_reads: reads };
}

function shortHash(value: string | null): string {
  return value === null || value === "" ? "(未给)" : `${value.slice(0, 12)}…`;
}

/** known_revision 落后时给出"当前版本"的描述；不落后返回 null */
function staleKnownRevision(facts: EntryFacts, knownRevision: string | null): string | null {
  if (knownRevision === null || knownRevision.trim() === "") return null;
  const tokens = revisionTokens(facts);
  if (tokens.has(knownRevision.trim())) return null;
  return (
    `基线 ${facts.baseline?.baseline_id ?? "（无）"} / 设计修订 ${shortHash(facts.design?.revision.content_sha256 ?? null)}` +
    ` / 施工图修订 ${shortHash(facts.plan?.revision.content_sha256 ?? null)}`
  );
}

function leaseNoteFor(lease: ReturnType<typeof leaseStateOf>): string {
  if (lease === "active") return "租约仍有效：所有权在持有者手里，别抢";
  if (lease === "expired")
    return "租约已到期只表示「当前所有权需核实」，**不**证明旧进程已停止（§2.7）：要接手先核实旧进程与旧认领";
  if (lease === "unknown") return "租约时间戳解析不了：按未知处理，等同需核实";
  return "没有认领记录：按「所有权需核实」处理";
}

/**
 * 客户端资格闸门（§6.2 能力发现 + §6.7 先核对有效基线）：
 * 要"派发"的动作（resume_task / claim_task）只有在本客户端能力够、且 known_revision 不落后时才真派；
 * 否则改成 await_role 并给出**明确的接续指令**（是哪个任务、怎么领、交什么），不假称全自动、不派旧版。
 */
function applyClientGate(args: {
  action: "resume_task" | "claim_task";
  taskId: string;
  reasons: EntryReason[];
  facts: EntryFacts;
  capability: CapabilityDiscovery;
  knownRevision: string | null;
}): ProjectEntryAction {
  const { action, taskId, reasons, facts, capability, knownRevision } = args;
  if (capability.effective === "read_only") {
    reasons.push({
      code: "client_read_only",
      text:
        `本客户端的实际能力是「${CLIENT_CAPABILITY_LABELS[capability.effective]}」（依据：${capability.basis}）：` +
        `塔台给出的是**接续指令**（下一项是 ${taskId}——怎么领、交什么都在上面的理由里），` +
        "但不把认领/恢复派给只读客户端：换一个声明可接续（continuable）或可协调执行（coordination）的客户端来领（§6.2）",
      task_id: taskId,
    });
    return "await_role";
  }
  const stale = staleKnownRevision(facts, knownRevision);
  if (stale !== null) {
    reasons.push({
      code: "known_revision_stale",
      text:
        `调用方 known_revision=${shortHash(knownRevision)} 不是当前有效版本（当前：${stale}）：**旧版不派**——` +
        `先按 required_reads 重读有效基线/图纸，再回来领 ${taskId}（§6.7「先核对有效基线」）`,
      task_id: taskId,
    });
    return "await_role";
  }
  return action;
}

function runOf(facts: EntryFacts, c: Candidate): CurrentRun | null {
  const record = facts.live[c.def.task_id];
  if (record === undefined || record === null) return null;
  const lease = leaseStateOf(record.lease_expires_at, facts.now);
  return {
    task_id: c.def.task_id,
    run_id: record.run_id ?? "",
    attempt_id: record.attempt_id ?? "",
    attempt: record.attempt,
    owner_id: record.owner_id ?? "",
    owner_role: record.owner_role ?? record.role,
    claim_token: record.claim_token ?? "",
    lease_expires_at: record.lease_expires_at ?? "",
    workspace: record.workspace ?? "",
    lease,
    resume_preconditions: [...RESUME_PRECONDITIONS],
    run_site: runSiteOf(facts, c.def.task_id, record),
  };
}

/** 稳定排序：已定义优先级 → 依赖顺序 → 稳定 ID（§6.7 逐字） */
function pickStable<T extends { def: TaskDefinition; depLevel: number }>(list: readonly T[]): T {
  return [...list].sort(
    (a, b) =>
      priorityRank(a.def.priority) - priorityRank(b.def.priority) ||
      a.depLevel - b.depLevel ||
      a.def.stable_key.localeCompare(b.def.stable_key) ||
      a.def.task_id.localeCompare(b.def.task_id),
  )[0];
}

/** 接续提示：命中且合格就用它；指不动就如实记下并回落到默认排序（不越权、不静默）。
 *  调用方显式给的 `resume_hint` **优先于**项目级指针里的 `preferred_task_id`；两者都只能指向
 *  真实就绪候选（角色/依赖/范围/状态校验早在上游 `ready` 集合里算过，提示不越权绕过）。 */
function pickHint(
  ready: readonly Candidate[],
  resumeHint: string | null,
  reasons: EntryReason[],
  stagePreferred: string | null = null,
): Candidate | null {
  if (ready.length === 0) return null;
  const hint = (resumeHint ?? "").trim();
  if (hint === "") return pickProjectPreferred(ready, stagePreferred, reasons);
  const hit = ready.find((c) => c.def.task_id === hint || `${c.def.task_id}@${c.def.stable_key}` === hint);
  if (hit === undefined) {
    reasons.push({
      code: "resume_hint_unusable",
      text: `resume_hint=${hint} 不在当前可派队列里（可能已不在就绪态/依赖未释放/角色不符）：按默认规则选，不因为提示就越权`,
      blocking: false,
    });
    return pickProjectPreferred(ready, stagePreferred, reasons);
  }
  return hit;
}

/** 项目级指针的优选卡：只在真实就绪候选里选；指不动就如实记下并回落默认排序（不越权） */
function pickProjectPreferred(
  ready: readonly Candidate[],
  stagePreferred: string | null,
  reasons: EntryReason[],
): Candidate {
  const preferred = (stagePreferred ?? "").trim();
  if (preferred === "") return pickStable(ready);
  const hit = ready.find((c) => c.def.task_id === preferred || `${c.def.task_id}@${c.def.stable_key}` === preferred);
  if (hit === undefined) {
    reasons.push({
      code: "stage_preferred_unusable",
      text:
        `项目级阶段指针 ${STAGE_READS_REL} 的 preferred_task_id=${preferred} 不在当前可派队列里` +
        "（依赖未释放/角色不符/已在途或已交付/范围冲突）：按默认规则选，指针不构成授权、也不越权绕过任何校验",
      blocking: false,
    });
    return pickStable(ready);
  }
  reasons.push({
    code: "stage_preferred_selected",
    text:
      `本次按项目级阶段指针 ${STAGE_READS_REL} 的 preferred_task_id=${preferred} 从就绪队列里选中它` +
      "（该卡本就在真实就绪候选集合内：依赖已释放、角色相符、无范围冲突；指针只是排序意见，不放行任何本来领不了的卡）",
    task_id: hit.def.task_id,
  });
  return hit;
}

/** §6.7「附任务或交接 ID、依据版本、依赖、允许范围与完成要求」 */
function packOf(
  c: Candidate,
  facts: EntryFacts,
): Pick<
  EntryReason,
  | "task_id"
  | "handoff_id"
  | "basis_revision"
  | "dependency_ids"
  | "allowed_paths"
  | "completion_requirements"
  | "task_revision"
  | "missing_items"
> {
  return {
    task_id: c.def.task_id,
    handoff_id: `${c.def.task_id}@${(facts.plan?.revision.content_sha256 ?? "no-plan").slice(0, 12)}`,
    basis_revision: c.state?.definition_sha256 ?? taskDefinitionHash(c.def),
    dependency_ids: c.def.dependency_ids,
    allowed_paths: c.def.allowed_paths,
    completion_requirements: c.completion_requirements,
    task_revision: c.state?.revision ?? null,
    missing_items: c.missing_items,
  };
}

/**
 * 一个任务的**技术复审是否仍未收口**（B4/V09-54，DESIGN §5.4「复审有退出条件」）。
 *
 * 判据**只消费 canonical 事实**（`facts.obligations` 的逐项结论 + 状态投影），不另算绿公式：
 *   · 必需检查逐项生效通过、`independence_required` 的检查有**非作者**证据、无必须拦截缺陷、源未失效
 *     ⇒ **已收口**（不再列复审候选，不反复派已完成的卡）；
 *   · 任一未达 ⇒ 未收口，逐项点名列出来——**部分/旧/错误**的审计记录都不算满足（不看"有没有审计记录"）。
 */
function technicalReviewState(facts: EntryFacts, taskId: string): { outstanding: boolean; gaps: string[]; needsIndependentAudit: boolean; onlyHumanPending?: boolean } {
  const proj = facts.byId[taskId] ?? null;
  if (proj === null) {
    return {
      outstanding: true,
      gaps: [`${taskId}：状态投影缺失——无法判技术复审是否收口（不按「已收口」放行）`],
      needsIndependentAudit: false,
    };
  }
  const gaps: string[] = [];
  let humanPendingCount = 0;
  let needsIndependentAudit = false;
  const defs = facts.obligations === null ? null : requiredChecksOf(facts.obligations, taskId);
  if (defs !== null) {
    for (const def of defs) {
      const basis = proj.evidence_basis.find((b) => b.check_id === def.check_id) ?? null;
      if (basis?.effective === "not_checked" && basis.pending) {
        humanPendingCount++;
        gaps.push(`${def.check_id}（等待 ${basis.pending.role}：${basis.pending.reason}；${basis.pending.basis}）`);
        continue;
      }
      // 独审义务（B4 复审 11:36 第 1 条）：只要该检查**没有**「非作者的有效通过」，独审义务就没满足——
      // 包含**从未记录**（`basis === null`）与 missing/unknown/stale，而不只是「作者自检撑着」那一种；
      // 非作者审计判失败待复测同样在此列。否则真正缺独审的卡（一条审计记录都没有）无人接：
      // auditor 分支只认 `needsIndependentAudit`，不拿"有没有审计记录"当判据。
      // 只对 `independence_required` 的检查置位——作者自己的普通缺项不错误交审计。
      const independentPassed = basis !== null && basis.effective === "passed" && basis.independence === "independent";
      if (def.independence_required && !independentPassed) needsIndependentAudit = true;
      if (basis === null || basis.effective !== "passed") {
        gaps.push(`${def.check_id}（${basis === null ? "无记录" : basis.effective}）`);
      } else if (def.independence_required && basis.independence !== "independent") {
        gaps.push(`${def.check_id}（独审必需：当前只有作者自检，§2.7/§5.8）`);
      }
    }
  } else {
    for (const m of proj.missing) gaps.push(`${m.check_id}（${m.why}）`);
  }
  for (const f of proj.open_findings.filter((x) => x.must_block)) gaps.push(`${f.finding_id}（必须拦截的缺陷未收口）`);
  if (proj.freshness !== "fresh") gaps.push(`证据/来源不在最新版本（freshness=${proj.freshness}）：须先复验受影响项再收口（§5.6）`);
  if (gaps.length === 0 && (proj.display_status !== "verified" || proj.mapping !== "mapped")) {
    gaps.push(`canonical 主状态未到 verified（display_status=${proj.display_status ?? "null"}／mapping=${proj.mapping}）：不按集合为空当作收口`);
  }
  return { outstanding: gaps.length > 0, gaps, needsIndependentAudit,
    onlyHumanPending: humanPendingCount > 0 && gaps.length === humanPendingCount && proj.mapping === "mapped" };
}

/**
 * 两轮同因诊断（B4/V09-54，DESIGN §5.4「两轮同因」；已审方案 §4A M3）：从**既有**结果回执识别
 * 「同一原因连续两轮无进展」，提示转协调者查共同机制与前置——**不是**两轮后自动放行/免验/放弃；
 * 不新增事件类型、不建持久完成表（只读派生当时事实）。
 *
 * 判据是**两个条件的合取**（B4 复审 11:36 第 2 条）：① 最后两条回执的 `untested` + `known_issues`
 * 逐字相同且非空；② 两轮之间**确实没有**真实进展（无新增有效通过、无修复/复测、canonical 也未收口）。
 * 只有备注相同**不算**"无进展"——否则「备注没改但检查真变少了」的卡会被误判成停滞。
 *
 * **B3-REVIEW-WATCH 12:04 后的收紧（三条都按「归属本任务」＋按服务端账本 seq）**：
 *   · **归属链**：本任务在册缺陷（`finding.object_id === taskId`）→ 修复/复测只认这些缺陷；
 *     别的任务（B）的任意修复/复测**不**解除本任务（A）的停滞。
 *   · **服务端序**（不按可自报的 `occurred_at`）：窗口 = `(prev.seq, last.seq]`；`fix` 自带 `seq`，
 *     `retest` 与 `evidence_basis` 的 `record_ref` 经 `facts.eventSeqOf`（同一现读快照的 `entity_id → seq`）
 *     解析出账本序。`at` 只到秒——同一秒内的记录用 `at` 比较会漏判/误判，故一律用 seq。
 *   · **有效缺口减少才算进展**：新增**此前从未_有效_通过**的本任务检查通过（重复同 check 通过不改有效缺口 ⇒
 *     不算）、本任务缺陷的修复、本任务缺陷的**通过**复测（失败复测不算）。任何一条成立即**不**报停滞。
 *   · **B3-REVIEW-WATCH 12:20 的收紧（"曾通过过"≠"仍然有效"）**：先前通过的记录一律再用**同一份**
 *     `checksFromFacts`（含源清单现读复核）＋ `checkEffectiveness` 复核**当前是否仍有效通过**；只有仍有效的
 *     旧通过才占位（防止重复记同 check 假推进）。**曾通过→相关源改→旧证据失效（stale）**的旧通过**不占位**：
 *     本轮复验新通过即算真实进展，**不**因"历史上通过过"而永不推进。判据是"窗口前的**可复用有效**通过集合"，
 *     **不是**"历史上出现过的通过记录"。
 *   · **B3-REVIEW-WATCH 12:40 的收紧（定义语义也要看）**：`checkEffectiveness` 只看代码/源绑定，**看不见
 *     定义语义**。同 stableID 改定义正文（code 未变）时，它仍把旧通过判 `passed` ⇒ 旧通过错误占位、本轮
 *     新定义下的复验被挤成"重复通过"。这里**复用唯一义务层现成的记录级定义绑定结论**
 *     （`obligations.check_identity.definition_bindings` 的 `verdict="changed"`，与投影/身份归一同一份）：
 *     语义已变的旧通过**不占位**。
 *   · **B3-REVIEW-WATCH 12:51 的收紧（不可证明 ≠ 停滞）**：同一条结论里 `verdict="unknown"`、或窗口前那条
 *     旧通过**在结论里根本没有条目**（不可变定义快照读不到、记录时点无在效定义、取不到记录绑定）时，
 *     "它当时按哪一版定义验的、现在是否仍有效"**证明不了**——该旧通过**不占位**，并把 `historyUnprovable`
 *     置真、最终判未知（`return null`）。**只有 `match` + `checkEffectiveness=passed` 的旧通过才占位**
 *     （重复同 check 通过仍诊断），不拿"证明不了"当"无进展"的证据。
 *   · **不可证明则判未知、不断言停滞**：账本序读不到（快照不可读/记录无 `record_ref`）时，既证明不了"有进展"
 *     也证明不了"没有"——如实判未知（`return null`），**不**把不确定说成"无进展"。
 */
function repeatDiagnosisOf(facts: EntryFacts, taskId: string): string | null {
  const subs = Object.values(facts.audit.submissions)
    .filter((s) => s.task_id === taskId)
    .slice()
    .sort((a, b) => a.round - b.round || a.seq - b.seq);
  if (subs.length < 2) return null;
  const prev = subs[subs.length - 2];
  const last = subs[subs.length - 1];
  const gapSig = (s: typeof prev): string => JSON.stringify({ untested: s.untested, known: s.known_issues });
  if (gapSig(prev) !== gapSig(last) || (last.untested.length === 0 && last.known_issues.length === 0)) return null;

  const proj = facts.byId[taskId] ?? null;
  const taskFindingIds = new Set<string>();
  for (const f of facts.projectFacts?.findings ?? []) if (f.object_id === taskId) taskFindingIds.add(f.finding_id);
  for (const f of facts.openFindings) if (f.task_id === taskId) taskFindingIds.add(f.finding_id);

  const seqOf = facts.eventSeqOf;
  const inWindow = (seq: number | null): boolean => seq !== null && seq > prev.seq && seq <= last.seq;

  // ① 本任务在册缺陷的修复（`fix` 记录自带账本 seq）。
  const fixedInWindow = Object.values(facts.audit.fixes).filter(
    (f) => taskFindingIds.has(f.finding_id) && f.seq > prev.seq && f.seq <= last.seq,
  );
  // 「历史状态不可证明」标志：账本序读不到时，既证明不了"有进展"、也证明不了"没有"——不据此断言停滞。
  let historyUnprovable = false;
  // ② 本任务在册缺陷的**通过**复测（`retest` 不自带 seq：经 `record_id → retest:<id> 实体 seq` 解析；
  //    `result !== "pass"` 的失败复测**不算**推进——同一缺陷反复失败复测不得假推进）。
  const retestedInWindow = Object.values(facts.audit.retests).filter((r) => {
    if (!taskFindingIds.has(r.finding_id) || r.result !== "pass") return false;
    const seq = seqOf(auditEntityId("audit.retest_recorded", r.record_id));
    if (seq === null) historyUnprovable = true;
    return inWindow(seq);
  });
  // ③ 本任务必需检查的**新增**有效通过：该 check 在窗口**之前从未**_有效_通过（否则只是重复记一次通过，
  //    有效缺口没变 ⇒ 不算进展），且其通过记录经 `record_ref` 解析到账本 seq 落在窗口内。
  //
  //    B3-REVIEW-WATCH 12:20：判据是「窗口之前**有效**通过」，**不是**「历史上曾经通过过」——用**同一份**
  //    `checksFromFacts`（含源清单现读复核）＋ `checkEffectiveness`（与投影同一判据）复核那条旧通过**当前**
  //    是否仍有效：曾通过 → 相关源改 → 旧证据失效（stale）的旧通过**不占位**，否则「本轮复验新通过」会被
  //    当成"历史上通过过"而永不推进。`effective` 与独立性无关，故 `authorIds` 传空集（只判有效性，不判独立性）。
  const revisionFacts = facts.projectFacts;
  const priorChecks = revisionFacts !== null ? checksFromFacts(revisionFacts) : checksFromAudit(facts.audit);
  const revisions = revisionFacts?.revisions ?? {};
  const segments = revisionFacts?.binding_segments ?? null;
  //    B3-REVIEW-WATCH 12:40／12:51：`checkEffectiveness` 只看**代码/源绑定**，看不见**定义语义**——同 stableID
  //    改定义正文（code 未变）时，它仍会把旧通过判 `passed`。这里**复用唯一义务层现成的记录级定义绑定结论**
  //    （`obligations.check_identity.definition_bindings`，与投影/身份归一同一份、不另造一套）逐条取判词：
  //      · `changed` ⇒ 记录时点的定义语义已变，该旧通过**不占位**（本轮在新定义下的复验才算真实进展）；
  //      · `match`   ⇒ 定义未变，可按既有 `checkEffectiveness` 判它是否仍有效（重复同 check 通过仍算"无进展"）；
  //      · `unknown`／**该记录在结论里根本没有条目**（不可变定义快照读不到、记录时点无在效定义、取不到记录绑定）
  //        ⇒ 既证明不了"有进展"也证明不了"没有"：该旧通过**不占位**，并置 `historyUnprovable`
  //        ——**不把不确定说成"无进展"**（B3-REVIEW-WATCH 12:51：不可证明不是停滞的证据）。
  const definitionVerdicts = new Map<string, DefinitionBindingVerdict>();
  for (const b of facts.obligations?.check_identity.definition_bindings ?? []) {
    if (b.record_ref === null || b.record_ref === "") continue;
    definitionVerdicts.set(definitionBindingKey(b.object_id, b.check_id, b.record_ref), b.verdict);
  }
  const passedBefore = new Set<string>();
  for (const c of priorChecks) {
    if (c.object_id !== taskId || c.result !== "passed") continue;
    const seq = c.record_ref === undefined ? null : seqOf(c.record_ref);
    if (seq === null) {
      // 旧通过的账本序读不到：它是否在窗口之前、当前是否仍有效都无从证明 ⇒ 不据此下结论。
      historyUnprovable = true;
      continue;
    }
    if (seq > prev.seq) continue;
    // 记录时点的**定义绑定判词**（唯一义务层同一份结论；窗口前的记录才看它）。
    const verdict =
      c.record_ref === undefined
        ? undefined
        : definitionVerdicts.get(definitionBindingKey(c.object_id, c.check_id, c.record_ref));
    // 语义已变（同 stableID）⇒ 该旧通过**不占位**：它不该把本轮复验挤成"重复通过"。
    if (verdict === "changed") continue;
    // 判词不是 `match`（`unknown` 或结论里没有这条记录）⇒ 证明不了这条旧通过按当前语义仍然有效：
    // 不占位（否则会把本轮新复验挤成"重复通过"），并如实标"历史状态不可证明"，最终**不**断言停滞。
    if (verdict !== "match") {
      historyUnprovable = true;
      continue;
    }
    if (checkEffectiveness(c, revisions, new Set<string>(), segments).effective === "passed") {
      passedBefore.add(c.check_id);
    }
  }
  const newlyPassedInWindow = (proj?.evidence_basis ?? []).filter((b) => {
    if (b.effective !== "passed" || passedBefore.has(b.check_id)) return false;
    return inWindow(b.record_ref === null ? null : seqOf(b.record_ref));
  });

  if (fixedInWindow.length > 0 || retestedInWindow.length > 0 || newlyPassedInWindow.length > 0) return null;
  // 历史状态**不可证明**时不据此断言"无进展"：如实判未知（账本序读不到时，既不谎报进展，也不把
  // 不确定说成停滞——B3-REVIEW-WATCH 12:20「确无可证明历史状态应如实判断未知，不能断言无进展」）。
  if (historyUnprovable) return null;
  // 缺口已收口到位（canonical 主状态已 verified 且源新鲜）也无事可诊断。
  if (proj !== null && proj.freshness === "fresh" && proj.display_status === "verified") return null;

  return (
    `两轮同因无进展（round ${prev.round} 与 ${last.round} 的未测/已知问题逐字相同，` +
    "且两轮之间**没有**新增有效通过、也没有修复/通过复测记录）：这不是「再试一次」能解的信号——" +
    "停止盲目重复同一操作，转协调者查**共同根因与前置**（补证据／拆小任务／调整路径／换验证手段），" +
    "并**点名**导致两轮同因的具体检查项与来源；**不是**自动放行、免验或放弃（DESIGN.md §5.4）"
  );
}

function reviewCandidates(
  facts: EntryFacts,
  role: string,
  all: readonly Candidate[],
): { task_id: string; def: TaskDefinition; why: string; requirements: string[] }[] {
  const cls = roleClassOf(role);
  const submissions = Object.values(facts.audit.submissions);
  const out: { task_id: string; def: TaskDefinition; why: string; requirements: string[] }[] = [];
  for (const c of all) {
    const st = c.state;
    if (st === null) continue;
    const isSubmitted = st.status === "result_submitted" || submissions.some((s) => s.task_id === st.task_id);
    if (!isSubmitted) continue;
    // B4/V09-54：复审**有退出条件**——当前必需检查/独审/阻断都收口 ⇒ 不再列复审候选（不反复派已完成的卡）。
    const review = technicalReviewState(facts, st.task_id);
    if (!review.outstanding) continue;
    if (review.onlyHumanPending && cls !== "user" && role !== "human_tester") continue;
    const gapText =
      review.gaps.slice(0, 6).join("；") + (review.gaps.length > 6 ? `…（共 ${review.gaps.length} 项）` : "");
    const repeat = repeatDiagnosisOf(facts, st.task_id);
    const repeatText = repeat === null ? "" : `；${repeat}`;
    const requirements = c.completion_requirements;
    if (review.onlyHumanPending && (cls === "user" || role === "human_tester")) {
      out.push({task_id:st.task_id,def:c.def,why:`待真人检查：${gapText}；此项不是最终 Gate 代签`,requirements});
      continue;
    }
    if (cls === "coordinator") {
      out.push({
        task_id: st.task_id,
        def: c.def,
        why: `协调器收件：任务 ${st.task_id} 已提交结果，技术复审**未收口**——还差：${gapText}${repeatText}`,
        requirements,
      });
      continue;
    }
    // 审计者只在**独审义务未满足 / 非作者审计判失败待复测**时接手；"有没有审计记录"不作判据
    if (cls === "auditor" && review.needsIndependentAudit) {
      out.push({
        task_id: st.task_id,
        def: c.def,
        why: `待非作者复核：任务 ${st.task_id} 已提交结果，但独审义务未满足或非作者审计判失败待复测——还差：${gapText}${repeatText}`,
        requirements,
      });
    }
  }
  if (cls === "user") {
    const verdict = completionVerdict(facts, all, role);
    if (!verdict.complete && verdict.acceptancePending && verdict.remaining.length === 0) {
      out.push({
        task_id: verdict.requiredTasks[0] ?? "",
        def: all.find((c) => c.def.task_id === verdict.requiredTasks[0])?.def ?? facts.definitions[0],
        why:
          "人工验收：全部必需工作都已验证通过，等用户对该批次做接受/退回（只有用户能推进人工验收，§5.4/§5.8）",
        requirements: ["对批次做接受 / 退回 / 接受已知限制，并关联场景与证据（§5.4 人工验收维度）"],
      });
    }
  }
  return out.filter((r) => r.def !== undefined);
}

interface CompletionVerdict {
  complete: boolean;
  required: number;
  requiredTasks: string[];
  remaining: string[];
  acceptance: string;
  acceptancePending: boolean;
  limits: string[];
  blockers: EntryReason[];
}

/**
 * 交付条件判定（fail-closed）：**每张当前定义**都要有运行状态、都要到"验证通过"（§4.2 绿）、
 * 没有必须拦截的未收口缺陷，且该批次有用户验收记录（接受 / 接受已知限制）。
 * 任何一项缺 → 不 complete，缺什么逐条报出（无人处理的任务也不许被忽略）。
 */
function completionVerdict(facts: EntryFacts, all: readonly Candidate[], role: string): CompletionVerdict {
  const blockers: EntryReason[] = [];
  const remaining: string[] = [];
  const limits: string[] = [];
  for (const c of all) {
    const st = c.state;
    if (st === null) {
      remaining.push(`${c.def.task_id}（还没有运行状态）`);
      continue;
    }
    if (st.cancelled) continue;
    const proj = facts.byId[c.def.task_id];
    if (proj === undefined) {
      remaining.push(`${c.def.task_id}（状态投影缺失：${TASK_STATUS_LABELS[st.status]}）`);
      continue;
    }
    if (proj.display_status === "verified") {
      continue;
    }
    // 接受已知限制不染绿（§4.2/V06-09），但用户接受过限制 = 该批次约定的交付条件已满足：
    // 按 §5.5「其他已知限制经用户接受」计入交付，但状态与理由如实说清"不是全绿"。
    if (proj.display_status === "pending_verification" && proj.acceptance === "accepted_known_limit") {
      limits.push(`${c.def.task_id} 带用户已接受的已知限制（状态按 §4.2 不染绿，如实标待验证）`);
      continue;
    }
    remaining.push(`${c.def.task_id}（${proj.display_status_label ?? TASK_STATUS_LABELS[st.status]}：${proj.reasons.map((r) => r.text).join("；") || "无理由"})`);
  }
  const blockingFindings = facts.openFindings.filter((f) => f.must_block);
  for (const f of blockingFindings) {
    blockers.push({
      code: "blocking_finding",
      text: `阻断性缺陷未收口：${f.finding_id}（对象 ${f.task_id ?? "未指名"}，状态 ${f.status}）`,
      task_id: f.task_id,
      blocking: true,
    });
  }
  const batchAccept = latestByTime(
    facts.acceptances.filter((a) => a.task_id === null || a.task_id === ""),
    (a) => a.at,
  );
  const acceptancePending = batchAccept === null || batchAccept.decision === "reject";
  const acceptance =
    batchAccept === null
      ? "还没有批次级用户验收记录"
      : `批次验收 ${batchAccept.decision}（${batchAccept.record_id}，${batchAccept.accepted_by}，${batchAccept.at}）`;
  // 空队列判断（§6.7「没有就绪任务不等于项目完成」+ V06-09「不空集判绿」）：
  // 一张定义都没有 = 没有可判定的必需工作，**不**complete（如实标"空队列"）。
  const emptyQueue = all.length === 0;
  if (emptyQueue) {
    blockers.push({
      code: "empty_queue",
      text:
        "当前施工定义里一张卡都没有：没有可判定的必需工作，不空集判绿（也不把空队列当「项目完成」）。" +
        "先按 §2.9 激活成套基线并导入施工图",
      blocking: true,
    });
  }
  const complete =
    !emptyQueue &&
    remaining.length === 0 &&
    blockingFindings.length === 0 &&
    batchAccept !== null &&
    batchAccept.decision !== "reject";
  if (!acceptancePending && batchAccept !== null && batchAccept.decision === "accept_known_limit") {
    limits.push(`批次整体接受已知限制（${batchAccept.record_id}）`);
  }
  void role;
  return {
    complete,
    required: all.filter((c) => c.state?.cancelled !== true).length,
    requiredTasks: all.map((c) => c.def.task_id),
    remaining,
    acceptance,
    acceptancePending,
    limits,
    blockers,
  };
}

/** 明确的待决事项：待议被"提出"但还没有后续处置（按 refKey 取最后一条） */
function pendingDecisions(facts: EntryFacts): DecisionRecord[] {
  const latest = new Map<string, DecisionRecord>();
  // 决策记录的 `at` 是调用方给的时间（偏移任意）：按真实时刻正序，非法/缺失排最前 → 抢不到"最后一条"。
  for (const rec of [...facts.decisions].sort((a, b) => compareIsoTime(a.at, b.at))) {
    latest.set(discussionRefKey(rec.discussion_ref), rec);
  }
  return [...latest.values()]
    .filter((r) => r.action === "proposed")
    .sort((a, b) => compareIsoTime(a.at, b.at));
}

/** 项目根内相对路径口径（对外只给相对路径，不外发本机绝对路径） */
const WORKBENCH_REL = ".工作台";
const WORK_DIR_REL = `${WORKBENCH_REL}/work`;

/**
 * 去重键（P1／§5.3）：统一为 `kind + path + section`（无 `section` 视作空串）。
 * 旧实现有两套键（硬编码条目 `kind:path`、阶段条目 `kind:path#section`），行为差异只是"同文件多段必读互相顶掉"。
 * 另加一条 Codex 纠正：**无 `section` 的引用条目把 `source_ref` 并入键**——否则同一文件的两条失败引用
 * （或两条追溯指针）会被吞掉第二条，读者看不到"还有一条依据没定位到"。
 */
function requiredReadKey(r: RequiredRead): string {
  const section = r.section ?? "";
  const ref = section === "" && r.source_ref !== undefined ? `@${r.source_ref}` : "";
  return `${r.kind}\u0000${r.path}\u0000${section}${ref}`;
}

/** 「空依据」写法（卡面写「无」时不造引用条目）；只在整条 token 就是这个写法时命中，不吞正常引用 */
const EMPTY_DESIGN_REF_RE = /^(?:无|none|n\/a|—|-|－|–)[。.．]?$/i;

/**
 * 任务的设计引用 → 精确取材条目（P1／§5.2、§5.3）。
 * - 严格解析入口（`designRefStrict`）逐个显式编号、唯一精确匹配；范围必须能证明完整展开；附录不降级；
 * - 一次求值只把设计书解析一次（`parseMarkdownSections`），同卡全部引用共用同一棵章节树（§5.2-7）；
 * - 非章节类 token（需求 ID／报告／外部文档）不进章节解析，以 `trace_reference` 条目带出原始引用（§5.2-8）。
 */
function designReferenceReads(facts: EntryFacts, def: TaskDefinition | null): { reads: RequiredRead[]; resolved: number } {
  const reads: RequiredRead[] = [];
  if (def === null || facts.design === null) return { reads, resolved: 0 };
  const refs = Array.isArray(def.design_refs) ? def.design_refs : [];
  if (refs.length === 0) return { reads, resolved: 0 };
  const designPath = facts.design.source.rel_path;
  const parsed = parseMarkdownSections(facts.design.text);
  const sections: MarkdownSectionNode[] = parsed.ok ? parsed.sections : [];
  let resolved = 0;
  for (const raw of refs) {
    const token = typeof raw === "string" ? raw.trim() : "";
    if (token === "" || EMPTY_DESIGN_REF_RE.test(token)) continue; // 「无」这类空依据不是引用，别造一条空指针
    // 认不出的设计引用**不得**被无条件当外部追溯而少读（P1 复核第 5 条）：显式编号、指名设计书、
    // 或整条就是某章节的完整标题路径都要进严格解析；只有确实的外部文档/报告/需求才作追溯指针。
    if (!isDesignRefToken(token, sections)) {
      reads.push({
        path: designPath,
        kind: "design",
        purpose: "trace_reference",
        source_ref: token,
        why: `任务 ${def.task_id} 的设计依据「${token}」是非设计章节引用（需求 ID／审计报告／外部文档）：只作追溯指针，按需回读，不占本轮必读正文`,
      });
      continue;
    }
    const result = resolveDesignRefStrict(token, sections);
    for (const target of result.targets) {
      if (target.resolution === "resolved") {
        resolved += 1;
        reads.push({
          path: designPath,
          kind: "design",
          section: target.path,
          revision: target.sha256,
          range: { start: target.line_start, end: target.line_end },
          purpose: "required_content",
          resolution: "resolved",
          source_ref: token,
          why:
            `任务 ${def.task_id} 的设计依据「${token}」→ ${target.path}（当前行 ${target.line_start}–${target.line_end}）：` +
            "按 path+range 读回该章节标题与整棵子树，不整篇读取（section 是绑定定位，不转传 read_design/read_plan 的 section 参数）",
        });
      } else {
        reads.push({
          path: designPath,
          kind: "design",
          purpose: "required_content",
          resolution: "unresolved",
          source_ref: token,
          resolution_detail: `${STRICT_REF_REASON_TEXT[target.reason]}（子目标 ${target.token_part}）`,
          why:
            `任务 ${def.task_id} 的设计依据「${token}」当前定位不到：${STRICT_REF_REASON_TEXT[target.reason]}。` +
            "unresolved 不是已读、不是已通过、不是可跳过——按 source_ref 用 read_design(index=true) 或按 range 补取核实，不得用近似标题顶替",
        });
      }
    }
  }
  return { reads, resolved };
}

/** 用途强弱（P1 复核第 6 条）：同目标合并时强的取胜，弱指针不得顶掉强必读 */
const PURPOSE_RANK: Readonly<Record<RequiredReadPurpose, number>> = {
  required_content: 3,
  resume_context: 2,
  trace_reference: 1,
};

/**
 * 同一目标（同 kind+path+section…）出现多条时的**合并**（P1 复核第 6 条）：
 * 早先的窄范围/追溯指针**不得**吞掉后来的更强必读——保留更强的 `purpose`、更完整的范围
 * （任一条是整文件 ⇒ 合并为整文件；否则取并集）与全部来源理由（`why` 逐条并列）。
 */
function mergeRequiredRead(prev: RequiredRead, next: RequiredRead): RequiredRead {
  const purpose = PURPOSE_RANK[next.purpose] > PURPOSE_RANK[prev.purpose] ? next.purpose : prev.purpose;
  const prevRange = prev.range ?? null;
  const nextRange = next.range ?? null;
  const range =
    prevRange === null || nextRange === null
      ? null
      : { start: Math.min(prevRange.start, nextRange.start), end: Math.max(prevRange.end, nextRange.end) };
  const why = prev.why === next.why ? prev.why : `${prev.why}；同目标另有必读要求：${next.why}`;
  const merged: RequiredRead = {
    ...prev,
    purpose,
    range,
    why,
    revision: prev.revision ?? next.revision ?? null,
    section: prev.section ?? next.section,
  };
  const resolution = prev.resolution ?? next.resolution;
  if (resolution !== undefined) merged.resolution = resolution;
  const detail = prev.resolution_detail ?? next.resolution_detail;
  if (detail !== undefined) merged.resolution_detail = detail;
  const sourceRef = prev.source_ref ?? next.source_ref;
  if (sourceRef !== undefined) merged.source_ref = sourceRef;
  return merged;
}

/** 必读原文入口（§6.7「给的是结构化事实及原文入口，不要求它从截图猜进度」） */
function requiredReads(facts: EntryFacts, def: TaskDefinition | null): RequiredRead[] {
  const refReads = designReferenceReads(facts, def);
  const out: RequiredRead[] = [];
  const indexOfKey = new Map<string, number>();
  const push = (r: RequiredRead): void => {
    const key = requiredReadKey(r);
    const at = indexOfKey.get(key);
    if (at === undefined) {
      indexOfKey.set(key, out.length);
      out.push(r);
      return;
    }
    out[at] = mergeRequiredRead(out[at] as RequiredRead, r);
  };

  if (facts.plan !== null) {
    push({
      path: facts.plan.source.rel_path,
      kind: "plan",
      why: def === null ? "施工图原文（任务定义、依赖与验收的权威来源）" : `任务 ${def.task_id} 的卡区原文（定义、依赖、验收、文件责任）`,
      revision: facts.plan.revision.content_sha256,
      range: def?.section_lines === null || def?.section_lines === undefined ? null : { start: def.section_lines[0], end: def.section_lines[1] },
      purpose: "required_content",
    });
  }
  if (facts.design !== null) {
    // 整份设计书入口**始终保留**；有解析到的设计引用时它降为追溯指针，否则仍是本轮必读正文（§5.3）。
    push({
      path: facts.design.source.rel_path,
      kind: "design",
      why: "设计书原文（契约与禁止越界事项的权威来源；按任务的设计依据章节读）",
      revision: facts.design.revision.content_sha256,
      purpose: refReads.resolved > 0 ? "trace_reference" : "required_content",
    });
    for (const r of refReads.reads) push(r);
  } else {
    push({
      path: ".工作台/design.md",
      kind: "design",
      why: "设计书源缺失：先确认项目登记的设计书路径（§2.9），别拿摘要当依据",
      purpose: "required_content",
    });
  }
  if (facts.baseline !== null) {
    push({
      path: `${WORKBENCH_REL}/baselines.jsonl`,
      kind: "baseline",
      why: `生效基线 ${facts.baseline.baseline_id}（审定依据与两修订哈希）`,
      revision: facts.baseline.baseline_id,
      purpose: "trace_reference",
    });
  }
  push({
    path: `${WORK_DIR_REL}/events.jsonl`,
    kind: "task_facts",
    why: "任务执行状态的事实源（唯一写入服务追加的事件流；状态是它的投影）",
    purpose: "trace_reference",
  });
  if (Object.keys(facts.audit.submissions).length > 0) {
    push({
      path: `${WORK_DIR_REL}/events.jsonl`,
      kind: "audit",
      why: "交付/审计记录同在事件流里（提交、自检、独立审计、复测、人工验收各占实体前缀）",
      purpose: "trace_reference",
    });
  }
  const checkpointFile = checkpointPath(facts.projectId, facts.dataDir);
  if (fs.existsSync(checkpointFile)) {
    push({
      path: `${WORK_DIR_REL}/context-resume.json`,
      kind: "checkpoint",
      why: "上一轮中断留下的续接位置（服务器保留的现场：已确认来源、未读清单、续读游标）",
      purpose: "resume_context",
    });
  }
  // 项目级阶段必读（`.工作台/work/stage-reads.json` 派生指针）：本阶段必须读到的原文——
  // 项目总图、AGENTS.md、当前交接等。指针合法才追加；同一个 `kind+path（+section）` 已在上面出现就不重复列。
  // 带 `section` 的条目另透传**派生** `range`（该章节当前起止行，非指针 JSON 键）：执行方按 `path`+`range`
  // 读回标题与整棵子树，不把 `section` 当 `read_design`/`read_plan` 的章节参数转传（两套口径）。
  // 指针缺失/不合法**不在这里**表达：缺失=老项目原样兼容，不合法由判定层给 blocked（见 decideNextAction 第 1.5 步）。
  if (facts.stageReads.status === "ok") {
    for (const entry of facts.stageReads.entries) {
      push({
        path: entry.path,
        kind: entry.kind,
        why: `本阶段必读（项目级指针 ${STAGE_READS_REL}）：${entry.why}`,
        revision: entry.revision,
        ...(entry.section === undefined ? {} : { section: entry.section }),
        ...(entry.range === undefined ? {} : { range: entry.range }),
        purpose: "required_content",
      });
    }
  }
  // 同步证据阻断时带出证据入口（V09-23／DESIGN §2.10）：让接续 Agent 一眼看到缺哪一批、证据包放哪
  // （`kind` 复用既有枚举 evidence；P1／§5.4 把这类"续接现场"标为 resume_context）。
  if (facts.syncBlock !== null && facts.syncBlock.blocked) {
    for (const b of facts.syncBlock.batches) {
      const rel = `${SYNC_INBOX_REL}/${b.batch_id}.evidence.json`;
      push({
        path: rel,
        kind: "evidence",
        why: `同步批次「${b.title}」（${b.batch_id}）未当前通过（verdict=${b.verdict}）：见证它缺什么、期望与实际差在哪；blocks_entry 阻断接续与认领`,
        purpose: "resume_context",
      });
    }
  }
  return out;
}

// ── 入口求值（对外唯一入口；只读） ──

/**
 * 求一次项目入口（§6.7）。**只读**：不提交事件、不写文件、不认领、不调模型。
 * 输入校验只认 §6.7 的五个字段；`dataDir`/`now` 是进程内选项，不进契约。
 */
/**
 * V09-53（B3/§2.7）：由**本次已算的同一份** `facts.obligations` 派生逐 check 工作包。
 * **不改判定**——`taskId`/`nextAction`/角色能力都取自 `evaluateProjectEntry` 本次已定结论，这里只组织形态。
 * 事实读不出来（`obligations`/`projectFacts` 为 null）⇒ 返回 null（不假装有包；入口本身已 `blocked`）。
 */
function workPackageOf(input: {
  facts: EntryFacts;
  role: string;
  capability: ClientCapabilityClass;
  capabilityFlags: { read: boolean; continue: boolean; coordinate: boolean };
  taskId: string | null;
  nextAction: ProjectEntryAction;
  /** 入口已定的下一动作由哪个角色推进（不重算；无从得知 = null） */
  nextActionRole: string | null;
  paging?: { limit?: number; cursor?: string; offset?: number; expected_revision?: string };
}): WorkPackageFull | WorkPackageFailure | null {
  const { facts } = input;
  const obligations = facts.obligations;
  const projectFacts = facts.projectFacts;
  if (obligations === null || projectFacts === null) return null;
  const roleClass = roleClassOf(input.role);
  const sourceMode: SourceMode =
    roleClass === "coordinator" || input.capability === "coordination" ? "coordinator_managed" : "direct_tatai";
  const taskId = input.taskId;
  const changeId = taskId === null ? null : (facts.states[taskId]?.change_id ?? null);
  const live = taskId === null ? null : (facts.live[taskId] ?? null);
  const ownership: WorkPackageOwnership | null =
    live === null
      ? null
      : {
          owner_id: live.owner_id ?? "",
          run_id: live.run_id ?? "",
          attempt_id: live.attempt_id ?? "",
          lease_expires_at: live.lease_expires_at ?? "",
          workspace: live.workspace ?? "",
        };
  const snapshot: WorkPackageFactsSnapshot = {
    project_id: facts.projectId,
    data_dir: facts.dataDir,
    role: input.role,
    role_class: roleClass,
    capability: input.capability,
    capability_flags: input.capabilityFlags,
    now: facts.now,
    obligations,
    facts: projectFacts,
    baseline: {
      design_revision: projectFacts.baseline?.design_revision ?? projectFacts.revisions.design ?? null,
      plan_revision: projectFacts.baseline?.plan_revision ?? projectFacts.revisions.plan ?? null,
      baseline_id: projectFacts.baseline?.baseline_id ?? null,
    },
    task_id: taskId,
    change_id: changeId,
    source_mode: sourceMode,
    next_action: input.nextAction,
    next_action_role: input.nextActionRole,
    ownership,
  };
  const result = buildWorkPackage(snapshot, { scope_id: changeId }, input.role, input.paging ?? {});
  return result.ok ? result.work_package : result;
}

export function evaluateProjectEntry(input: ProjectEntryInput, opts: ProjectEntryOptions = {}): ProjectEntry {
  // 2026-10-07 运行时阻塞修复：整段跑在一次派生的只读复用作用域里——事实快照、
  // 图纸源读取解析、不可变修订对象读+核哈希、源清单复核、git 忽略探针在同一次派生内只算一次。
  // 作用域随本次调用结束即丢、**跨请求不缓存**（下一次调用照旧现读现算，源一变立刻可见）。
  // 证据：E/runtime-profile-only/REPORT.md、E/runtime-final/COORDINATOR-HYPOTHESES.md。
  return withDerivationScope(() => evaluateProjectEntryInScope(input, opts));
}

function evaluateProjectEntryInScope(input: ProjectEntryInput, opts: ProjectEntryOptions = {}): ProjectEntry {
  const projectId = typeof input?.project_id === "string" ? input.project_id.trim() : "";
  const role = typeof input?.role === "string" ? input.role.trim() : "";
  if (projectId === "") throw new WorkError("INVALID_COMMAND", "project_entry 缺入参 project_id", { field: "project_id" });
  if (role === "") throw new WorkError("INVALID_COMMAND", "project_entry 缺入参 role（不报角色的调用方拿不到派活）", { field: "role" });

  const dataDir = opts.dataDir ?? resolveDataDir();
  // 租约判定用毫秒精度的 ISO（`nowIso()` 只到秒：秒级以下租约会被算成"还没到期"）
  const now = opts.now ?? new Date().toISOString();
  const facts = gatherFacts(projectId, dataDir, now, opts.syncDiscoveryIssues, opts.events);
  const capability = capabilityOf(input.client_capabilities);
  const knownRevision = typeof input.known_revision === "string" && input.known_revision.trim() !== "" ? input.known_revision.trim() : null;
  const resumeHint = typeof input.resume_hint === "string" && input.resume_hint.trim() !== "" ? input.resume_hint.trim() : null;

  const acceptance = rejectionScopeOf(facts);
  const decision = decideNextAction({ facts, role, capability, knownRevision, resumeHint, acceptance });

  // 接续提示：与选中的动作一起如实带出（有检查点时给服务器保留的续接位置）
  const extra: EntryReason[] = [];
  if (resumeHint !== null) {
    extra.push({
      code: "resume_hint_received",
      text: `调用方给了 resume_hint=${resumeHint}（只是提示：不越权绕过有效基线/角色/依赖/范围检查）`,
    });
  }
  const checkpoint = loadCheckpoint(projectId, dataDir);
  if (checkpoint !== null) {
    let detail = `中断原因 ${checkpoint.reason}（${checkpoint.detail}），产生于 ${checkpoint.created_at}`;
    let resumePosition: string | null = checkpoint.resume_position?.detail ?? null;
    try {
      const resolved = resolveCheckpoint(checkpoint, projectId, dataDir);
      resumePosition = resolved.resume_position?.detail ?? resumePosition;
      if (resolved.source_changed.length > 0) {
        detail += `；已失效来源 ${resolved.source_changed.length} 个（必须重读）`;
      }
    } catch {
      // 检查点解析不了就只带原始信息，不假装可用
    }
    extra.push({
      code: "checkpoint_available",
      text: `上一轮中断的续接位置（服务器保留，不依赖旧聊天记忆）：${detail}${resumePosition === null ? "" : `；续接位置：${resumePosition}`}`,
    });
  }

  const currentChange = currentChangeOf(facts);
  const runs = currentRunsOf(facts);
  const manifest = contextManifestOf(facts.context);
  // V09-34：本次动作指向的任务（取自已定 decision 的 reasons；只为前置说明定位，不重算判定）。
  const chosenTaskId =
    decision.reasons.map((r) => r.task_id).find((id): id is string => typeof id === "string" && id !== "") ?? null;

  // V09-53（B3）：默认**不加**该字段（保持 §6.7 九字段默认契约）；`opts.work_package===true` 时才从
  // 本次同一份 facts 派生，**不改**上面的 next_action/reasons。分页游标跨版本由 `buildWorkPackage` 显式拒。
  // `next_action_role` 由**入口已定的动作 + 调用方角色档**推（不猜候选角色）；`expected_revision` 与工具入口相连。
  const callerClass = roleClassOf(role);
  const nextActionRole: string | null =
    decision.action === "claim_task" || decision.action === "resume_task"
      ? role
      : decision.action === "review_result"
        ? callerClass === "unknown"
          ? role
          : callerClass
        : decision.action === "blocked" || decision.action === "await_decision"
          ? "coordinator"
          : decision.action === "complete"
            ? ""
            : null; // await_role：具体角色由候选卡的责任角色决定，这里不猜
  const workPackage =
    opts.work_package === true
      ? workPackageOf({
          facts,
          role,
          capability: capability.effective,
          capabilityFlags: capability.declared,
          taskId: chosenTaskId,
          nextAction: decision.action,
          nextActionRole,
          ...(opts.work_package_paging === undefined ? {} : { paging: opts.work_package_paging }),
          ...(opts.work_package_expected_revision === undefined
            ? {}
            : { paging: { ...(opts.work_package_paging ?? {}), expected_revision: opts.work_package_expected_revision } }),
        })
      : null;

  return {
    project: {
      project_id: facts.project.id,
      name: facts.project.name,
      path: facts.project.path,
      kind: facts.project.kind,
      workstation_dir: `${facts.project.path}/.工作台`.replace(/\\/g, "/"),
      role,
      role_class: roleClassOf(role),
      documents: {
        design:
          facts.design === null
            ? null
            : {
                source_path: facts.design.source.rel_path,
                origin: facts.design.source.origin,
                content_sha256: facts.design.revision.content_sha256,
                definition_sha256: facts.design.revision.definition_sha256,
                lines: facts.design.revision.lines,
              },
        plan:
          facts.plan === null
            ? null
            : {
                source_path: facts.plan.source.rel_path,
                origin: facts.plan.source.origin,
                content_sha256: facts.plan.revision.content_sha256,
                definition_sha256: facts.plan.revision.definition_sha256,
                lines: facts.plan.revision.lines,
                table_found: facts.plan.table_found,
                task_count: facts.definitions.length,
              },
      },
      capability,
    },
    baseline: {
      active:
        facts.baseline === null
          ? null
          : {
              baseline_id: facts.baseline.baseline_id,
              active_at: facts.baseline.active_at,
              approved_by: facts.baseline.approved_by,
              approval_basis: facts.baseline.approval_basis,
              approval_kind: facts.baseline.approval_kind,
              design_revision: facts.baseline.design_revision.content_sha256,
              plan_revision: facts.baseline.plan_revision.content_sha256,
              design_source: facts.baseline.design_revision.source_path,
              plan_source: facts.baseline.plan_revision.source_path,
            },
      // V09-31 复审：`valid` 用结构化判据（有生效基线且**一条失效理由都没有**），
      // 不再拿中文消息 substring 匹配——保全对象篡改/缺失等失效同样会把 valid 置 false。
      valid: facts.baselineValid,
      revalidate: facts.baselineRevalidate,
      source_changed_since_baseline: facts.baselineSourceChanged,
    },
    context_manifest: manifest,
    current_change: currentChange,
    current_runs: runs,
    next_action: decision.action,
    reasons: [...decision.reasons, ...extra],
    required_reads: decision.required_reads,
    sync_summary:
      facts.syncBlock === null || !facts.syncBlock.configured
        ? null
        : {
            configured: facts.syncBlock.configured,
            overall: facts.syncBlock.overall,
            blocked: facts.syncBlock.blocked,
            blocking_batches: facts.syncBlock.batches.map((b) => ({ batch_id: b.batch_id, title: b.title, verdict: b.verdict, reasons: b.reasons })),
            // P3/V09-48：只读修复计划（与上面的阻断判据**同一次**评估；只读附加，不改门禁）。
            ...(facts.syncRepairPlan === null ? {} : { repair_plan: facts.syncRepairPlan }),
          },
    // V09-34：轻量选项——默认**不加**该字段（保持 §6.7 九字段契约）；`opts.preconditions===true` 时
    // 从本次同一份 facts 派生说明，不改上面的 `next_action`/`reasons` 任何一项。
    ...(opts.preconditions === true
      ? {
          preconditions: preconditionsOf({
            facts,
            action: decision.action,
            role,
            roleClass: roleClassOf(role),
            capability,
            runs,
            chosenTaskId,
          }),
        }
      : {}),
    // V09-53：逐 check 工作包（仅 opt-in；旧字段逐字保留，本字段是兼容扩展）。
    ...(workPackage === null ? {} : { work_package: workPackage }),
  };
}

function contextManifestOf(pkg: ContextPackage | null): ProjectEntry["context_manifest"] {
  if (pkg === null) {
    return {
      package_id: "",
      generated_at: "",
      design_revision: null,
      plan_revision: null,
      plan_definition_digest: null,
      token_or_char_size: 0,
      sources: [],
      omitted: [],
      stale_reasons: ["上下文包没建出来：manifest 如实缺席，请按 required_reads 直接读原文"],
      coverage: null,
    };
  }
  return {
    package_id: pkg.package_id,
    generated_at: pkg.generated_at,
    design_revision: pkg.design_revision,
    plan_revision: pkg.plan_revision,
    plan_definition_digest: pkg.plan_definition_digest,
    token_or_char_size: pkg.token_or_char_size,
    sources: pkg.source_manifest,
    omitted: pkg.omitted,
    stale_reasons: pkg.stale_reasons,
    coverage: pkg.coverage,
  };
}

/** 当前变更批次：取任务状态里最近一次出现的 change_id（没有事件就是 null） */
function currentChangeOf(facts: EntryFacts): ProjectEntry["current_change"] {
  const entries = Object.values(facts.states);
  if (entries.length === 0) return null;
  // `updated_at` 是事件 `received_at`（产品钟），但同样按真实时刻比：解析不出来的状态不参与"最近"。
  const latest = latestByTime(entries, (s) => s.updated_at);
  if (latest === null) return null;
  const changeId = latest.change_id;
  const taskIds = entries.filter((s) => s.change_id === changeId).map((s) => s.task_id).sort();
  return {
    change_id: changeId,
    task_ids: taskIds,
    latest_at: latest.updated_at,
    basis: {
      baseline_id: facts.baseline?.baseline_id ?? null,
      design_revision: facts.baseline?.design_revision.content_sha256 ?? facts.design?.revision.content_sha256 ?? null,
      plan_revision: facts.baseline?.plan_revision.content_sha256 ?? facts.plan?.revision.content_sha256 ?? null,
    },
  };
}

/** 未结束的 run（已认领/执行中）；租约到期只标"当前所有权需核实"（§2.7） */
function currentRunsOf(facts: EntryFacts): CurrentRun[] {
  const out: CurrentRun[] = [];
  for (const [taskId, record] of Object.entries(facts.live)) {
    if (record === null) continue;
    const state = facts.states[taskId];
    if (state?.cancelled === true) continue;
    const lease = leaseStateOf(record.lease_expires_at, facts.now);
    out.push({
      task_id: taskId,
      run_id: record.run_id ?? "",
      attempt_id: record.attempt_id ?? "",
      attempt: record.attempt,
      owner_id: record.owner_id ?? "",
      owner_role: record.owner_role ?? record.role,
      claim_token: record.claim_token ?? "",
      lease_expires_at: record.lease_expires_at ?? "",
      workspace: record.workspace ?? "",
      lease,
      resume_preconditions: [...RESUME_PRECONDITIONS],
      run_site: runSiteOf(facts, taskId, record),
    });
  }
  return out.sort((a, b) => a.task_id.localeCompare(b.task_id));
}

/**
 * 运行现场（V09-27；只读派生）：按 attempt/run 找对应执行回执，用既有 `livenessOf` 判活。
 * 无事件 = `no_events`（未知）；心跳缺失/超期 = `unknown`（**不等于已停止**）；只有带确认依据的
 * `execution.stopped` 才 `confirmed_stopped`。最后检查点原样带出（恢复第一步读它，§5.4）。
 */
function runSiteOf(facts: EntryFacts, taskId: string, record: ClaimRecord): CurrentRun["run_site"] {
  // 执行回执读不出来 → **现场未知**（不是 no_events，更不能当"没有执行"）：如实带出读取失败原因
  if (facts.executions_unreadable !== null) {
    return {
      observed: false,
      execution_id: null,
      state: "unknown",
      site_state: "unreadable",
      last_signal_at: null,
      silent_ms: null,
      heartbeat_stale: false,
      note: `执行回执读不出来（${facts.executions_unreadable}）：运行现场未知——读失败不等于没有回执，也不等于停机（DESIGN.md §5.4）`,
      confirmation: null,
      last_checkpoint: null,
    };
  }
  const matches = facts.executions.filter((x) => x.task_id === taskId);
  const rec =
    matches.find((x) => record.attempt_id !== null && record.attempt_id !== "" && x.attempt_id === record.attempt_id) ??
    matches.find((x) => record.run_id !== null && record.run_id !== "" && x.run_id === record.run_id) ??
    latestByTime(matches, (x) => x.updated_at);
  if (rec === null) {
    return {
      observed: false,
      execution_id: null,
      state: "no_events",
      site_state: "no_events",
      last_signal_at: null,
      silent_ms: null,
      heartbeat_stale: false,
      note: "没有该 run 的执行回执（execution.*）：运行现场未知——无心跳不等于停机（DESIGN.md §5.4）",
      confirmation: null,
      last_checkpoint: null,
    };
  }
  const live = livenessOf(rec, facts.now);
  const lastCheckpoint = latestByTime(rec.checkpoints, (c) => c.at);
  return {
    observed: true,
    execution_id: rec.execution_id,
    state: live.state,
    site_state: live.site_state,
    last_signal_at: live.last_signal_at,
    silent_ms: live.silent_ms,
    heartbeat_stale: live.heartbeat_stale,
    note: live.note,
    confirmation: live.confirmation,
    last_checkpoint:
      lastCheckpoint === null
        ? null
        : {
            at: lastCheckpoint.at,
            note: lastCheckpoint.note,
            artifacts: lastCheckpoint.artifacts,
            effects_in_flight: lastCheckpoint.effects_in_flight,
          },
  };
}

/** 认领凭证类型透传（实现在 `claims.ts`；MCP 层与调用方共用同一份类型） */
export type { TaskClaim };
