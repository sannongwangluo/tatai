// V09-41（docs/efficiency-20261004.md）：`project_entry` → **紧凑只读简报**的纯投影层。
//
// 定位（红线）：
//   · **只读、零副作用**：不读事件、不写账、不认领、不调模型，也**不重算**判定——输入就是
//     `project_entry` 那一次调用已算好的**同一份**结果（调用方在工具层只调它一次 handler）。
//   · **不新增授权、也不丢事实**：`reasons` **原样逐条保留**（不按 code 过滤、不补齐 null/空数组——
//     checkpoint 等说明性理由也不许被当"说明"丢掉）、`current_runs`／`required_reads` 原样、
//     `next_action`、角色/能力、有效基线与 `versions`/`source` 逐字保留。当前卡只给 task_id/版本。
//   · 裁剪的只是"要的时候再取"的冗长字段：`project` 路径/工作目录/图纸清单、`context_manifest` 的来源与
//     覆盖账本、`graph_summary` 的每图明细与其余交付/时间戳/横幅字段（逐项列在 `omitted.fields`）。
//     省略项在 `omitted.fields` 里**只列字段名**，并给回 `project_entry` 的补取入口（参数原样）。
import crypto from "node:crypto";
import type { CurrentRun, EntryReason, EntrySyncSummary, ProjectEntry, RequiredRead } from "./entry";
import type { WorkPackageFailure, WorkPackageFull } from "./workPackage";
import type { SyncRepairPlan, SyncToolCall, SyncVerdict } from "../../shared/syncEvidence";

/** `project_entry` 的完整返回：契约九字段 + 宿主只读入口路径额外带的 compat 字段（本地回退路径没有）。 */
export type EntryFull = ProjectEntry & {
  graph_summary?: unknown;
  versions?: unknown;
  source?: unknown;
  contract?: unknown;
};

/**
 * 当前任务落在哪些理由的 code 上。**故意不含 `blocked_task`**：`next_action=blocked` 的现场不选中任何
 * "当前任务"（`current_task=null`），阻塞任务的信息仍在**原样逐条保留**的 `reasons` 里（含 `packOf` 与
 * `task_id`），不会被丢；这里只挑有明确归属、可据此接续的 code。只改注释澄清，不改选卡逻辑。
 */
const CURRENT_TASK_CODES: readonly string[] = ["claimable", "resume_available", "review_pending", "role_mismatch"];

/**
 * 简报里的图状态：**只要**可用性/更新态/语义态/快照标识/异常与下一读取入口。
 * 完整六图走 `next_read_entry`（`get_project_graphs`，同一份事实与判据），简报不内联整图计数与交付判词。
 */
export interface BriefGraph {
  availability: string | null;
  update_state: string | null;
  semantic_state: string | null;
  snapshot_id: string | null;
  anomalies: string[];
  next_read_entry: { tool: string; args: Record<string, unknown>; note: string };
  /** 图更新中/失败/过期时的如实原因（取自 `graph_summary.update_reason`，有摘要时才可能带） */
  reason?: string;
}

export interface TaskBrief {
  brief: "task_brief";
  project: {
    project_id: string;
    name: string;
    kind: string;
    role: string;
    role_class: string;
    capability: {
      effective: string;
      declared: { read: boolean; continue: boolean; coordinate: boolean };
      basis: string;
      limits: string[];
      unrecognized: string[];
    };
  };
  baseline: {
    active: {
      baseline_id: string | null;
      active_at: string | null;
      approved_by: string | null;
      approval_basis: string | null;
      approval_kind: string | null;
      design_revision: string | null;
      plan_revision: string | null;
    } | null;
    valid: boolean;
    source_changed_since_baseline: boolean;
    revalidate: string[];
  };
  /** 宿主只读入口路径的版本/来源（本地回退路径为 null；逐字透传，不伪造） */
  versions: unknown;
  source: unknown;
  current_change: ProjectEntry["current_change"];
  next_action: string;
  /** 当前卡只要 task_id 与实体版本；完成要求/允许范围/依赖都在原样保留的 `reasons` 里 */
  current_task: { task_id: string; task_revision: number | null } | null;
  /** **全部**理由原样逐条保留（不过滤、不截断、不补齐——blocking 与说明性理由一视同仁） */
  reasons: EntryReason[];
  current_runs: CurrentRun[];
  required_reads: RequiredRead[];
  sync: EntrySyncSummary | null;
  graph: BriefGraph;
  /**
   * V09-53（B3/§2.7）：**逐 check 工作包**（`work_package`）——入口/简报输出可直接执行的逐项材料。
   * 原样取自已调用的 `project_entry`（同一份 facts.obligations；**不重算**）。`null` = 本次没有包。
   */
  work_package: WorkPackageFull | WorkPackageFailure | null;
  /**
   * 该 `work_package` 的来历：`ok`＝拿到包；`invalid`＝入口显式失效（旧游标/入参，带重读入口）；
   * `unsupported_by_host`＝**宿主只读入口（另一进程）未返回该字段**（旧宿主不支持）——如实标注，
   * **不本地另算一套判据冒充远端支持**（§6.6/§6.11）。
   */
  work_package_status: "ok" | "invalid" | "unsupported_by_host";
  /** 上述状态的人话说明（含「旧客户端不具备完整接续能力」的提示，§2.7） */
  work_package_note: string;
  omitted: {
    /** 省略的字段名（补取入口见 refetch；不声称 versions/source 被省略——它们原样保留） */
    fields: string[];
    refetch: { tool: "project_entry"; args: Record<string, unknown> };
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function asRecord(v: unknown): Record<string, unknown> {
  return isRecord(v) ? v : {};
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

function asStringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function currentTaskOf(reasons: readonly EntryReason[]): TaskBrief["current_task"] {
  const index = currentTaskReasonIndex(reasons);
  if (index < 0) return null;
  const hit = reasons[index];
  return {
    task_id: hit.task_id as string,
    task_revision: typeof hit.task_revision === "number" ? hit.task_revision : null,
  };
}

function compactGraph(raw: unknown, projectId: string, degradedReason: string | null): BriefGraph {
  const nextRead = {
    tool: "get_project_graphs",
    args: { project_id: projectId, graph: "all", mode: "full" },
    note:
      "六图完整状态在本工具（架构判断/影响分析用 mode=full 并按同快照游标逐图取齐；" +
      "complete:true 只表示图对象取完，不等于源码全覆盖）",
  };
  if (!isRecord(raw)) {
    return {
      availability: null,
      update_state: null,
      semantic_state: null,
      snapshot_id: null,
      anomalies: [],
      next_read_entry: nextRead,
      reason: degradedReason ?? "project_entry 未返回六图摘要：按「读不到」如实表达，不假装有图",
    };
  }
  const out: BriefGraph = {
    availability: asString(raw.availability),
    update_state: asString(raw.update_state),
    semantic_state: asString(raw.semantic_state),
    snapshot_id: asString(raw.snapshot_id),
    anomalies: asStringList(raw.anomalies),
    next_read_entry: isRecord(raw.next_read_entry)
      ? (raw.next_read_entry as BriefGraph["next_read_entry"])
      : nextRead,
  };
  // 图更新中/失败/过期的原因在 `graph_summary.update_reason`（`reason` 只是历史兜底键，`graphSummaryOf`
  // 不产出它）——按真实的 `update_reason` 保留，别让「如实给原因」在图摘要层被静默削弱。
  const reason = asString(raw.update_reason) ?? asString(raw.reason);
  if (reason !== null) out.reason = reason;
  return out;
}

/**
 * 把一次 `project_entry` 的完整返回投影成紧凑简报。**纯函数**：不改输入、不产生副作用。
 * `refetchArgs` = 本次转发给 `project_entry` 的同版入参（补取入口原样带回）。
 */
export function buildTaskBrief(full: EntryFull, refetchArgs: Record<string, unknown> = {}): TaskBrief {
  const reasons = Array.isArray(full.reasons) ? full.reasons : [];
  const project = asRecord(full.project);
  const capability = asRecord(project.capability);
  const declared = asRecord(capability.declared);
  const baseline = asRecord(full.baseline);
  const active = isRecord(baseline.active) ? baseline.active : null;

  // V09-53（B3/§2.7）：逐 check 工作包（原样取自同一次 project_entry；**不重算**）。
  const workPackage = full.work_package ?? null;
  const workPackageStatus: TaskBrief["work_package_status"] =
    workPackage === null ? "unsupported_by_host" : isRecord(workPackage) && workPackage.ok === false ? "invalid" : "ok";
  const workPackageNote =
    workPackageStatus === "ok"
      ? "逐 check 工作包：与入口判定同一份 facts.obligations；只读派生、不含认领秘密（claim_token）。"
      : workPackageStatus === "invalid"
        ? `工作包显式失效：${String((workPackage as { message?: unknown }).message ?? "见 work_package")}` +
          "——**不静默返回跨版本数据**，按 work_package.next_read 重读。"
        : "入口（宿主只读路径）未返回 `work_package`：旧宿主不支持该字段。**不本地另算一套判据冒充远端支持**" +
          "（§6.6/§6.11）——升级宿主后用同一入口重取。旧字段逐字可用，但**不具备完整接续能力**（§2.7）。";

  return {
    brief: "task_brief",
    project: {
      project_id: asString(project.project_id) ?? "",
      name: asString(project.name) ?? "",
      kind: asString(project.kind) ?? "",
      role: asString(project.role) ?? "",
      role_class: asString(project.role_class) ?? "unknown",
      capability: {
        effective: asString(capability.effective) ?? "read_only",
        declared: {
          read: declared.read === true,
          continue: declared.continue === true,
          coordinate: declared.coordinate === true,
        },
        basis: asString(capability.basis) ?? "",
        limits: asStringList(capability.limits),
        unrecognized: asStringList(capability.unrecognized),
      },
    },
    baseline: {
      active:
        active === null
          ? null
          : {
              baseline_id: asString(active.baseline_id),
              active_at: asString(active.active_at),
              approved_by: asString(active.approved_by),
              approval_basis: asString(active.approval_basis),
              approval_kind: asString(active.approval_kind),
              design_revision: asString(active.design_revision),
              plan_revision: asString(active.plan_revision),
            },
      valid: baseline.valid === true,
      source_changed_since_baseline: baseline.source_changed_since_baseline === true,
      revalidate: asStringList(baseline.revalidate),
    },
    versions: full.versions ?? null,
    source: full.source ?? null,
    current_change: full.current_change ?? null,
    next_action: typeof full.next_action === "string" ? full.next_action : "unknown",
    current_task: currentTaskOf(reasons),
    reasons,
    current_runs: Array.isArray(full.current_runs) ? full.current_runs : [],
    required_reads: Array.isArray(full.required_reads) ? full.required_reads : [],
    sync: full.sync_summary ?? null,
    graph: compactGraph(
      full.graph_summary,
      asString(project.project_id) ?? "",
      full.graph_summary === undefined
        ? "project_entry 走本地回退路径时不含 graph_summary：按「读不到」如实表达，不假装有图"
        : null,
    ),
    work_package: workPackage,
    work_package_status: workPackageStatus,
    work_package_note: workPackageNote,
    omitted: {
      fields: [
        "project.path",
        "project.workstation_dir",
        "project.documents",
        "context_manifest",
        "graph_summary.graphs",
        "graph_summary.delivery",
        "graph_summary.capability_table_state",
        "graph_summary.update_phase",
        "graph_summary.update_eta_text",
        "graph_summary.banners",
        "graph_summary.baseline_id",
        "graph_summary.read_at",
        "graph_summary.generated_at",
      ],
      refetch: { tool: "project_entry", args: refetchArgs },
    },
  };
}

// ── V09-41 第二轮（2026-10-04）：detail=summary / detail=reason 的紧凑投影 ──
//
// 定位（红线）：
//   · **不改判定**：摘要在 `buildTaskBrief` 的完整投影**之上**做——理由与门禁结论来自同一次
//     `project_entry` 调用，只压缩"要的时候再取"的冗长文本，不重算、不新增任何授权。
//   · **不丢索引**：**每一条** reason 都在（含未知 code 与说明性理由），核心索引字段
//     （code/task_id/handoff_id/basis_revision/task_revision/blocking）原样保留；**只有当前选中任务**
//     的那条 reason 原样完整保留（允许范围/依赖/完成要求/版本等一个字都不动）。
//   · **截断明示**：其余 reason 的 `text` 截到 `SUMMARY_REASON_TEXT_LIMIT` 字符并带显式标记；
//     `text_length` 给原长度、`omitted_fields` 列该条被省略的大数组字段——摘要**不是完整执行依据**。
//   · **可校验取回**：`reasons_revision` = 原完整 reasons 的 sha256（规范化序列化）；按
//     `detail=reason` + `reason_index` + 该 revision 可取回单条完整原文，现场已变则显式拒绝。

/** 摘要模式每条理由保留的 text 字符数（超出即明确截断；完整原文按 detail=reason 取回） */
export const SUMMARY_REASON_TEXT_LIMIT = 120;

/** 摘要理由里保留的核心索引字段（原值有才带；`undefined` 就省略——不虚造成 false/null） */
const SUMMARY_REASON_CORE_FIELDS = ["task_id", "handoff_id", "basis_revision", "task_revision", "blocking"] as const;
/** 摘要理由里**不内联**的大数组字段（只列名，完整值按 detail=reason 取回） */
const SUMMARY_REASON_PACK_FIELDS = ["dependency_ids", "allowed_paths", "completion_requirements", "missing_items"] as const;

export interface BriefReasonSummary {
  /** 在原完整 `reasons` 数组里的下标（0 基；`detail=reason` 的 `reason_index` 就是它） */
  index: number;
  code: string;
  /** 短 text：超过上限时截断并带显式标记（不是完整原文） */
  text: string;
  /** true = `text` 被截断（完整原文按 detail=reason 取回） */
  text_truncated: boolean;
  /** 该条理由**原** text 的字符数（截断前的真实长度） */
  text_length: number;
  task_id?: string | null;
  handoff_id?: string | null;
  basis_revision?: string | null;
  task_revision?: number | null;
  blocking?: boolean;
  /** 该条被省略的大数组字段名（当前选中任务的 reason 不带本项——它原样完整保留） */
  omitted_fields?: string[];
  /** true = 当前选中任务的 reason：原样完整保留（不截断、不省略任何字段） */
  preserved?: boolean;
}

export interface TaskBriefSummary extends Omit<TaskBrief, "reasons" | "current_task" | "omitted" | "sync"> {
  detail: "summary";
  current_task: (NonNullable<TaskBrief["current_task"]> & { reason_index: number | null }) | null;
  reasons: BriefReasonSummary[];
  /**
   * P3 集成修正：同步段与完整简报**同字段**（configured/overall/blocked/blocking_batches），
   * 只有**新增**的 `repair_plan` 在 summary 里转紧凑导航（`BriefRepairNavigation`）——类型上与完整计划的
   * `SyncRepairPlan` 分开，不混用；其余字段逐字一致。
   */
  sync: TaskBriefSummarySync | null;
  /** **原完整 reasons** 的 sha256（规范化序列化）；`detail=reason` 的校验令牌 */
  reasons_revision: string;
  reasons_total: number;
  /** 明确声明：本摘要是紧凑投影，**不是完整执行依据** */
  summary_note: string;
  omitted: TaskBrief["omitted"] & { reason_fields: string[] };
}

/** `detail=reason` 的单条完整理由视图（含当前 next_action / current_task，便于就地校验） */
export interface TaskBriefReasonView {
  brief: "task_brief";
  detail: "reason";
  reason_index: number;
  reasons_revision: string;
  reasons_total: number;
  next_action: string;
  current_task: TaskBrief["current_task"];
  /** 选中理由的**原样完整**原文 */
  reason: EntryReason;
}

const SUMMARY_NOTE =
  "摘要（detail=summary）：**不是完整执行依据**。每条理由都保留索引与 code/task_id/blocking，" +
  `text 超过 ${SUMMARY_REASON_TEXT_LIMIT} 字符即截断（见 text_truncated/text_length）；` +
  "非当前选中理由的允许范围/依赖/完成要求/缺失项数组未内联（见 omitted_fields）。" +
  "当前选中任务的 reason 原样完整保留；判定与门禁结论与 project_entry 同一次调用、未改。" +
  "取完整原文：detail=full（完整简报）或 detail=reason + reason_index + reasons_revision（单条完整原文）。";

// ── P3 集成修正（2026-10-06，`P3-brief-size-decision.md`）：summary 的 repair_plan 转紧凑导航 ──
//
// 实际证据：V09-48 的 `repair_plan` 逐项带 expected/actual/reasons/候选工件，单批即 ~349KB；
// task_brief 默认 summary 原样透传会让返回体从 ~36KB 膨胀到 ~390KB，与「Agent 更容易接手」冲突。
// 按 Codex 裁定：**只**对**新增**的 repair_plan 在 default summary 里转紧凑导航（计数 + 每批有界摘要 +
// 结构化补取入口），**不再**逐项内联长话/候选 JSON；`read_sync_status` 与 `project_entry/detail=full`
// **一字不删**地保留完整修复计划。summary 不重算同步——只复用同一次评估已有的投影。

/** summary 里**每批**的紧凑导航（只计数与路径，不含逐项 expected/actual/reasons/候选） */
export interface BriefRepairBatchNav {
  batch_id: string;
  title: string;
  active: boolean;
  blocks_entry: boolean;
  verdict: SyncVerdict;
  item_count: number;
  item_counts_by_verdict: Record<string, number>;
  waiting_count: number;
  contract_sha256_12: string;
  /** 来源漂移**路径**（完整注册/当前哈希与原因读 read_sync_status 全文） */
  source_drift_paths: string[];
}

/**
 * `task_brief` **summary** 里 `repair_plan` 的紧凑导航（P3 集成修正）。
 * 与完整 `SyncRepairPlan` **同键不同型**：`nav:true` 明示这是摘要导航，不是完整计划；
 * 具体修复用 `refetch`（`read_sync_status`，带 `project_id`）一次读完整。
 */
export interface BriefRepairNavigation {
  generated_from: "read_sync_status";
  read_only: true;
  /** 判别位：summary 的 repair_plan 是紧凑导航（**没有**逐项 expected/actual/reasons/候选） */
  nav: true;
  note: string;
  /** 现行（active）批次数 */
  active_batch_count: number;
  /** 逐 verdict 项数（现行批次汇总） */
  item_counts_by_verdict: Record<string, number>;
  /** 阻断批次数（active + blocks_entry + verdict≠passed，与认领门禁同一口径） */
  blocked_batch_count: number;
  /** 等待派生计数（waiting_for_derivation 非空的项数） */
  waiting_count: number;
  batches: BriefRepairBatchNav[];
  /** 明确省略了什么；完整修复计划只在 read_sync_status 全文 */
  omitted: { fields: string[]; note: string };
  /** 结构化补取入口（可被程序直接调用）：一次读完整修复计划 */
  refetch: SyncToolCall;
}

const REPAIR_NAV_NOTE =
  "摘要导航：只给现行批次计数、逐 verdict 项数、阻断/等待计数与补取入口；" +
  "逐项 expected/actual/reasons、补证动作与候选工件 JSON 未内联。要具体修复时用 refetch（read_sync_status）一次读完整计划；" +
  "本摘要不重算同步、不改任何门禁（blocks_entry/认领阻断一字不动）。";

/**
 * 把完整 `SyncRepairPlan` 压成 summary 的紧凑导航。**纯函数**：只统计既有字段，不重算同步、不读盘。
 * `projectId` 用于结构化 refetch 的 `read_sync_status(project_id)`。
 */
export function summarizeRepairPlan(plan: SyncRepairPlan, projectId: string): BriefRepairNavigation {
  const batches = Array.isArray(plan.batches) ? plan.batches : [];
  const counts: Record<string, number> = {};
  let activeCount = 0;
  let blockedCount = 0;
  let waiting = 0;
  const navBatches: BriefRepairBatchNav[] = batches.map((b) => {
    const items = Array.isArray(b.items) ? b.items : [];
    const itemCounts: Record<string, number> = {};
    let batchWaiting = 0;
    for (const it of items) {
      itemCounts[it.verdict] = (itemCounts[it.verdict] ?? 0) + 1;
      if (it.waiting_for_derivation !== null && it.waiting_for_derivation !== undefined) batchWaiting += 1;
    }
    if (b.active) {
      activeCount += 1;
      for (const [k, v] of Object.entries(itemCounts)) counts[k] = (counts[k] ?? 0) + v;
      waiting += batchWaiting;
      if (b.blocks_entry && b.verdict !== "passed") blockedCount += 1;
    }
    return {
      batch_id: b.batch_id,
      title: b.title,
      active: b.active,
      blocks_entry: b.blocks_entry,
      verdict: b.verdict,
      item_count: items.length,
      item_counts_by_verdict: itemCounts,
      waiting_count: batchWaiting,
      contract_sha256_12: typeof b.contract_sha256 === "string" ? b.contract_sha256.slice(0, 12) : "",
      source_drift_paths: Array.isArray(b.source_drift) ? b.source_drift.map((d) => d.path) : [],
    };
  });
  return {
    generated_from: "read_sync_status",
    read_only: true,
    nav: true,
    note: REPAIR_NAV_NOTE,
    active_batch_count: activeCount,
    item_counts_by_verdict: counts,
    blocked_batch_count: blockedCount,
    waiting_count: waiting,
    batches: navBatches,
    omitted: {
      fields: [
        "batches[].items[].expected",
        "batches[].items[].actual",
        "batches[].items[].reasons",
        "batches[].items[].source_drift",
        "batches[].items[].reusable_artifacts",
        "batches[].items[].expired_artifacts",
        "batches[].items[].next_read_entry",
        "batches[].items[].next_evidence_action",
        "batches[].items[].waiting_for_derivation",
        "batches[].items[].registered_by",
        "batches[].candidate_evidence",
      ],
      note: "逐项期望/实际/理由/补证动作/候选工件只在完整修复计划里；用 refetch 一次读完整，本摘要不重算同步。",
    },
    refetch: { tool: "read_sync_status", args: { project_id: projectId } },
  };
}

/** summary 的同步段：其余字段（configured/overall/blocked/blocking_batches）原样，仅新增的 repair_plan 转导航 */
export type TaskBriefSummarySync = Omit<EntrySyncSummary, "repair_plan"> & { repair_plan?: BriefRepairNavigation };

function summarizeSync(sync: EntrySyncSummary | null, projectId: string): TaskBriefSummarySync | null {
  if (sync === null) return null;
  const { repair_plan, ...rest } = sync;
  if (repair_plan === undefined) return { ...rest };
  return { ...rest, repair_plan: summarizeRepairPlan(repair_plan, projectId) };
}

/** 规范化 JSON（对象键排序）：让 `reasons_revision` 不依赖键序、可复现 */
function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(",")}}`;
}

/** 原完整 `reasons` 的内容哈希（sha256；规范化序列化，键序无关） */
export function reasonsRevisionOf(reasons: readonly EntryReason[]): string {
  return crypto.createHash("sha256").update(canonicalJson(reasons)).digest("hex");
}

/** 当前选中任务所在的 reason 下标（0 基；没有则 -1）。判据与 `currentTaskOf` 逐字一致。 */
export function currentTaskReasonIndex(reasons: readonly EntryReason[]): number {
  for (const code of CURRENT_TASK_CODES) {
    const index = reasons.findIndex((r) => r.code === code && typeof r.task_id === "string" && r.task_id !== "");
    if (index >= 0) return index;
  }
  return -1;
}

function clippedText(text: string): string {
  return (
    text.slice(0, SUMMARY_REASON_TEXT_LIMIT) +
    `…（摘要截断：原文 ${text.length} 字符，完整原文用 detail=reason 按 reasons_revision 取回）`
  );
}

function summarizeReason(reason: EntryReason, index: number, preserved: boolean): BriefReasonSummary {
  const src = reason as unknown as Record<string, unknown>;
  const full = typeof src.text === "string" ? src.text : "";
  if (preserved) {
    // 原样完整保留：先展开原对象（允许范围/依赖/完成要求/missing_items/未知字段一个不动），再补位置与明示字段。
    return {
      ...(src as unknown as EntryReason),
      index,
      preserved: true,
      text_truncated: false,
      text_length: full.length,
    } as unknown as BriefReasonSummary;
  }
  const truncated = full.length > SUMMARY_REASON_TEXT_LIMIT;
  const out: BriefReasonSummary = {
    index,
    code: typeof src.code === "string" ? src.code : "",
    text: truncated ? clippedText(full) : full,
    text_truncated: truncated,
    text_length: full.length,
  };
  for (const field of SUMMARY_REASON_CORE_FIELDS) {
    if (src[field] !== undefined) (out as unknown as Record<string, unknown>)[field] = src[field];
  }
  // Disclose every omitted field, including fields introduced by future entry versions.
  // A fixed pack whitelist would silently hide a new constraint from the disclosure.
  const retained = new Set<string>(["code", "text", ...SUMMARY_REASON_CORE_FIELDS]);
  const omitted = Object.keys(src).filter((f) => !retained.has(f) && src[f] !== undefined);
  if (omitted.length > 0) out.omitted_fields = [...omitted];
  return out;
}

/**
 * 把 `buildTaskBrief` 的完整投影压成默认摘要。**纯函数**：不改输入；除 reasons/current_task/omitted
 * 之外的全部字段（next_action/current_runs/required_reads/graph/baseline/versions/source…）原样；
 * 同步段只有**新增**的 `repair_plan` 转紧凑导航（其余同步字段逐字保留，见 `TaskBriefSummarySync`）。
 */
export function summarizeTaskBrief(
  brief: TaskBrief,
  options: { refetchArgs?: Record<string, unknown> } = {},
): TaskBriefSummary {
  const reasons = Array.isArray(brief.reasons) ? brief.reasons : [];
  const preservedIndex = currentTaskReasonIndex(reasons);
  const projectId = typeof brief.project?.project_id === "string" ? brief.project.project_id : "";
  return {
    ...brief,
    detail: "summary",
    current_task:
      brief.current_task === null
        ? null
        : { ...brief.current_task, reason_index: preservedIndex >= 0 ? preservedIndex : null },
    reasons: reasons.map((reason, index) => summarizeReason(reason, index, index === preservedIndex)),
    sync: summarizeSync(brief.sync, projectId),
    reasons_revision: reasonsRevisionOf(reasons),
    reasons_total: reasons.length,
    summary_note: SUMMARY_NOTE,
    omitted: {
      ...brief.omitted,
      refetch: { tool: "project_entry", args: options.refetchArgs ?? brief.omitted.refetch.args },
      reason_fields: [...SUMMARY_REASON_PACK_FIELDS],
    },
  };
}

/** `detail=reason` 的单条完整视图；`reasonIndex` 非法/越界返回 null（由调用方显式拒绝，不返回错行）。 */
export function buildReasonView(brief: TaskBrief, reasonIndex: number): TaskBriefReasonView | null {
  const reasons = Array.isArray(brief.reasons) ? brief.reasons : [];
  if (!Number.isInteger(reasonIndex) || reasonIndex < 0 || reasonIndex >= reasons.length) return null;
  return {
    brief: "task_brief",
    detail: "reason",
    reason_index: reasonIndex,
    reasons_revision: reasonsRevisionOf(reasons),
    reasons_total: reasons.length,
    next_action: brief.next_action,
    current_task: brief.current_task,
    reason: reasons[reasonIndex],
  };
}
