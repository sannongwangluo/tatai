// P3 / V09-48：同步只读**修复计划**与**候选证据**的装配（纯函数：零 fs、零 node import）。
//
// 为什么单独一份、且是纯的：
//   · 判据只在 `sync.ts`/`syncChecks.ts` 算一次——本模块**只把同一次 `evaluateBatch` 的既有结果**
//     （逐项 verdict/expected/actual/reasons、来源快照、工件可复用/已失效、图更新态）装配成修复计划，
//     **不重算、不另读一遍目标、不自动刷新漂移哈希、不缩小必需项、不改 required/blocks_entry**；
//   · `sync.ts`（唯一读口编排）import 它；它**不能**反向 import `sync.ts`，也**不能** import
//     `graphUpdate.ts`（`graphUpdate → arch/blueprint → work/entry → work/sync` 会形成 `sync → 本模块 →
//     … → sync` 的循环 import——与 `syncGraph.ts` 那处红线的同类）。因此图更新态只取自 `syncChecks`
//     从**全量图探针**带回的 `graph_update_state`/`graph_update_sole`（探针值本身来自 `graphUpdate` 的持久状态）。
//   · 候选证据是**明确未验证的草稿**：只读返回、零落盘、不新增保存入口；`package` 保持**原闭键解析**
//     能读的证据包形状（可进既有正式 scan 链路），身份/输入版本放在并列的 `meta` 里，不塞进包内。
//   · **读真实目标字节的唯一一处**：候选工件必须落到**真实目标文件**上（整文件 sha），因此本模块接受一个
//     **注入的只读读器** `readTargetSha`（由 `sync.ts` 提供，仍是只读、零写）；本模块自己不 import `node:fs`，
//     不自己拼路径——判据（怎么核）只在 `sync.ts`/`syncChecks.ts`，这里只装配。
//
// 本模块产出的东西**不是**通过、**不是**独立审查证据。候选进正式链路前不需另造一份"实核"判据：
// 走**真实 scan 链路**即可——`evaluateBatch` 会按**当前实际目标**重核契约来源、证据包逐项 artifact 与
// check 目标；源/目标在复制后再次变化 ⇒ 该批次**不通过**（stale/invalid），这就够了（见 verify 段）。
import {
  SYNC_EVIDENCE_FILE_SUFFIX,
  SYNC_INBOX_REL,
  SYNC_SCHEMA_VERSION,
  type SyncCandidateArtifactBasis,
  type SyncCandidateEvidence,
  type SyncCheck,
  type SyncContract,
  type SyncEvidenceAction,
  type SyncEvidenceArtifact,
  type SyncEvidenceItem,
  type SyncEvidencePackage,
  type SyncEvidenceResult,
  type SyncExpiredArtifact,
  type SyncItemVerdict,
  type SyncRecommendedRole,
  type SyncRegisteredBy,
  type SyncRepairArtifact,
  type SyncRepairBatch,
  type SyncRepairItem,
  type SyncRepairPlan,
  type SyncSourceDrift,
  type SyncToolCall,
  type SyncVerdict,
  type SyncWaitingForDerivation,
} from "../../shared/syncEvidence";
import type { BatchEvaluation } from "./syncChecks";

/** 修复计划装配的**一个现行批次**输入：全部来自同一次 `evaluateBatch` 与已折叠契约（不重算） */
export interface RepairBatchInput {
  batch_id: string;
  title: string;
  active: boolean;
  blocks_entry: boolean;
  contract: SyncContract;
  contract_sha256: string;
  registered_seq: number;
  /** 契约**登记事件**的角色/actor（登记人**不是**所有修复项的责任人） */
  registered_by: SyncRegisteredBy;
  evaluation: BatchEvaluation;
}

/** 只读目标读器（由 `sync.ts` 注入）：项目根内相对路径 → 当前整文件 sha256；不可读/非法/超界为 null */
export type TargetShaReader = (rel: string) => string | null;

export const REPAIR_PLAN_NOTE =
  "只读修复计划：逐项给本次实时核验的原因/期望/实际、来源漂移、可复用与已失效工件、契约代次、登记人、" +
  "按失败类型的**建议**角色、**结构化**下一读取入口（tool+args），以及需要补证时的**具体补证动作**" +
  "（目标路径/角色/核对内容 + 补证完成后的扫描入口）。它**只列不自动做**——不自动补证、不自动改契约、" +
  "不自动刷新漂移哈希、不缩小必需项；`recommended_role` 只是建议，不替人授权、不改变任何角色权限；" +
  "不改任何门禁（blocks_entry/认领阻断一字不动）。";

const CANDIDATE_NOTE =
  "候选是**明确未验证的草稿**（`verified:false`、`package.completed=false`）：按当前真实目标机械生成或复用" +
  "**仍适用**的既有证据工件，**不是**证据、**不是**通过、**不是**独立审查结论（同一份源生成不构成独立审查）。" +
  "它**不**证明目标/验证内容已覆盖完整——只保证所列工件仍指向真实目标文件。只读返回、零落盘、不新增保存入口；" +
  "不改 required/blocks_entry、不自动刷新来源、不降级 current/整文件绑定。协调者核实后**显式**把 `package.completed` " +
  "置 true 再走既有 register/scan 链路：真实 scan 会按当前实际目标重核来源与逐项目标，源/目标在复制后再次变化即不通过。";

/** 契约来源的**当前漂移**（只列不匹配的：缺失/不可读/超界/自引用也算——current_sha256 为 null，不冒充一致） */
function sourceDriftOf(batch: RepairBatchInput): SyncSourceDrift[] {
  const registered = new Map(batch.contract.sources.map((s) => [s.path, s.sha256]));
  const out: SyncSourceDrift[] = [];
  for (const snap of batch.evaluation.source_snapshots) {
    if (snap.problem === null) continue;
    out.push({ path: snap.path, registered_sha256: registered.get(snap.path) ?? "", current_sha256: snap.sha256 });
  }
  return out;
}

/**
 * 按**失败类型**给出的**建议**承接角色（Codex 纠正：登记人 ≠ 责任人；这只是建议，不替人授权、不构成指派）：
 *   来源漂移/目标不符/契约与证据包损坏 → coordinator；必需项缺证/验证未跑 → executor；结论冲突/证据采信 → auditor。
 */
function recommendedRoleOf(itemVerdict: SyncItemVerdict, batchVerdict: SyncVerdict, sourceDrift: readonly SyncSourceDrift[]): SyncRecommendedRole | null {
  // 来源漂移优先：即使本项本身 passed，整批 stale 的补救责任在协调（重新登记/收口来源）。
  if (sourceDrift.length > 0) return "coordinator";
  const v = itemVerdict !== "passed" ? itemVerdict : batchVerdict;
  if (v === "passed" || v === "not_configured") return null;
  if (v === "missing") return "executor";
  if (v === "needs_review") return "auditor";
  return "coordinator";
}

/** 结构化的"下一读取入口"（可被程序直接调用；不再是不合法 JSON 式字符串） */
function nextReadEntryOf(projectId: string, recommendedRole: SyncRecommendedRole | null, sourceDrift: readonly SyncSourceDrift[], waiting: SyncWaitingForDerivation | null): SyncToolCall {
  if (waiting !== null) return { tool: "read_sync_status", args: { project_id: projectId } };
  if (sourceDrift.length > 0) return { tool: "project_entry", args: { project_id: projectId, role: "coordinator" } };
  if (recommendedRole !== null) return { tool: "project_entry", args: { project_id: projectId, role: recommendedRole } };
  return { tool: "read_sync_status", args: { project_id: projectId } };
}

/** 本项要覆盖/核对的目标路径（项目根内相对路径；无可机械指认的文件目标时为空数组） */
function targetPathsOf(check: SyncCheck): string[] {
  switch (check.type) {
    case "file_hash":
    case "json_value":
    case "markdown_section":
      return [check.path];
    case "task_definitions":
      return [check.source_plan];
    case "required_reads":
      return [...new Set(check.expected.map((e) => e.path))];
    case "task_states":
    case "graph_full":
      return [];
    default:
      return [];
  }
}

/** 本项核对内容（人话；供执行者知道要证明什么） */
function verifyOf(check: SyncCheck): string {
  switch (check.type) {
    case "file_hash":
      return `核对 ${check.path} 的**整文件字节** sha256 == 登记值 ${check.sha256}（登记后内容变过就是 stale/failed）`;
    case "json_value":
      return `核对 ${check.path} 的 JSON 指针 ${check.pointer} 的当前值 == 登记期望`;
    case "task_definitions":
      return `按审定原文 ${check.source_plan} 逐项核对账本导入的任务定义（定义哈希始终完整核对）`;
    case "task_states":
      return `按真实 v2 事件折叠核对任务状态集合 == 登记期望（scope_mode=${check.scope_mode}）`;
    case "graph_full":
      return `六图全量同快照取齐、采集完整无异常、期望有效基线 ${check.expected_baseline_id} 当前仍有效`;
    case "required_reads":
      return "核对阶段必读指针（.工作台/work/stage-reads.json）里这些条目按 (path, section) 配对存在、revision 相符";
    case "markdown_section":
      return `核对 ${check.path} 章节 ${JSON.stringify(check.section)} 的**子树** sha256 == 登记值 ${check.sha256}（artifact 仍须是**整文件** sha）`;
    default:
      return "按 check 类型核对当前实际目标";
  }
}

/** 需要补证/修正时的**具体补证动作**（明确目标/角色/核对内容，再给扫描入口）；只指引，不替人做、不写盘 */
function evidenceActionOf(projectId: string, batchId: string, recommendedRole: SyncRecommendedRole | null, check: SyncCheck): SyncEvidenceAction {
  const evidencePath = `${SYNC_INBOX_REL}/${batchId}${SYNC_EVIDENCE_FILE_SUFFIX}`;
  return {
    action:
      `按契约补齐本项证据：把覆盖目标的证据工件写入 ${evidencePath}（先写临时文件再原子改名）。` +
      "不要拿契约来源路径/收件目录里的东西冒充本项**独立目标工件**；非机械项（账本折叠/图派生等）按原流程交付真实证据，不代造成 passed",
    role: recommendedRole ?? "executor",
    evidence_path: evidencePath,
    target_paths: targetPathsOf(check),
    verify: verifyOf(check),
    then_scan: { tool: "scan_sync_evidence", args: { project_id: projectId } },
  };
}

/** 需要交付/修正证据的逐项 verdict（已通过项不给补证动作） */
const NEEDS_EVIDENCE: readonly SyncItemVerdict[] = ["missing", "failed", "invalid", "incomplete"];

/** 命中"图正在派生"（图更新态 updating）导致的 graph_full 未通过 → 只读说明；**绝不放行** */
function waitingOf(
  checkType: string | null,
  verdict: SyncItemVerdict,
  graphUpdateState: string | null,
  graphUpdateSole: boolean,
  reasons: readonly string[],
  sourceDrift: readonly SyncSourceDrift[],
): SyncWaitingForDerivation | null {
  if (checkType !== "graph_full" || verdict === "passed" || graphUpdateState !== "updating") return null;
  // 除 updating 之外的已知失败原因：来源漂移，以及探针除"图正在更新"外带回的原因（reasons.length>1 即另有原因）。
  const otherFailures: string[] = sourceDrift.map((d) => `来源已漂移：${d.path}`);
  if (!graphUpdateSole && reasons.length > 1) otherFailures.push("本项另有非更新类失败原因（见 reasons 与 source_drift，逐条核）");
  const sole = graphUpdateSole && otherFailures.length === 0;
  const reason = sole
    ? "本项未通过的直接原因是「图正在派生」（图更新态 updating）：这只是**只读说明**——v1 必需项 graph_full 未满足时" +
      "**仍阻断**接续与认领，不放行、不降级；派生完成后重读本入口即可（重试有界、同代请求合并由既有发现链承担，不新建重试器）。"
    : "本项未通过**不只**因为图正在派生：除图更新态 updating 外还有其它失败原因（来源漂移/其它检查不符，见 reasons 与 source_drift）" +
      "——updating 只是其中之一，**不**当唯一直接原因；先处理其它原因再重试。这只是**只读说明**：v1 必需项 graph_full 未满足时**仍阻断**接续与认领。";
  return {
    state: "updating",
    phase: null,
    retryable: true,
    sole_cause: sole,
    other_failures: otherFailures,
    reason,
    eta: {
      basis: "none",
      total_ms: null,
      note: "当前读口取到图更新态（updating），但取不到本轮阶段与历史耗时样本——依据不足即无法估计，**不编造 ETA**。",
    },
  };
}

function groupArtifacts(batch: RepairBatchInput): { reusable: Map<string, SyncRepairArtifact[]>; expired: Map<string, SyncExpiredArtifact[]> } {
  const reusable = new Map<string, SyncRepairArtifact[]>();
  const expired = new Map<string, SyncExpiredArtifact[]>();
  for (const c of batch.evaluation.artifact_checks) {
    if (c.reusable) {
      const arr = reusable.get(c.item_id) ?? [];
      arr.push({ path: c.path, sha256: c.current_sha256 ?? c.declared_sha256 });
      reusable.set(c.item_id, arr);
    } else if (c.problem !== null) {
      const arr = expired.get(c.item_id) ?? [];
      arr.push({ path: c.path, reason: c.problem });
      expired.set(c.item_id, arr);
    }
  }
  return { reusable, expired };
}

/**
 * 逐项 verdict → 证据包声明的 result（**不代造**）：passed→passed、needs_review→needs_review、其余→failed。
 * 非机械项只有在其自身判据**机械通过**（本批 `evaluateBatch` 真跑了 check）时才可能给 passed。
 */
function evidenceResultOf(verdict: SyncItemVerdict | undefined): SyncEvidenceResult {
  if (verdict === "passed") return "passed";
  if (verdict === "needs_review") return "needs_review";
  return "failed";
}

/**
 * 每类 check **能机械生成什么**（明确口径；否则返回 null＝该类型不能机械生成候选工件）：
 *   · file_hash / json_value / markdown_section → **整文件** sha（markdown_section 也**不**用章节哈希，章节 sha 不是 artifact 口径）；
 *   · task_definitions → 审定原文 source_plan 的整文件 sha；
 *   · task_states / graph_full / required_reads / 未知类型 → **不可机械生成**（账本折叠/图派生/指针集合，没有单文件目标），
 *     此时只能**复用仍适用的既有证据工件**（见 buildCandidateEvidence），否则 `candidate_unavailable_reason`。
 * 一律**不用**契约来源的 `sha256` 冒充目标工件（来源可能是章节哈希，且来源≠目标）。
 */
function mechanicalArtifactsOf(check: SyncCheck, read: TargetShaReader): SyncEvidenceArtifact[] | null {
  const one = (rel: string): SyncEvidenceArtifact[] | null => {
    const sha = read(rel);
    return sha === null ? null : [{ path: rel, sha256: sha }];
  };
  switch (check.type) {
    case "file_hash":
    case "json_value":
    case "markdown_section":
      return one(check.path);
    case "task_definitions":
      return one(check.source_plan);
    case "task_states":
    case "graph_full":
    case "required_reads":
      return null;
    default:
      return null;
  }
}

/**
 * 机械生成候选证据（**只读、零落盘**）：只在**来源未漂移**时成立（漂移时不给候选，理由写明）。
 * 逐项工件口径（**保留证据语义**）：
 *   ① 该批次现有证据包里**仍适用**（哈希与当前目标一致）的工件 → 原样保留（不替换成契约来源）；
 *   ② 否则按 **check 的真实目标**机械生成**整文件** sha 工件（见 `mechanicalArtifactsOf`）；
 *   ③ 否则（非机械项且无可复用旧工件）**不代造**：必需项 ⇒ 整份候选不可用（`candidate_unavailable_reason`）；非必需项 ⇒ 不列入。
 * `package.completed=false`（草稿默认不完整）。**同一份源生成不构成独立审查证据**。
 */
export function buildCandidateEvidence(
  batch: RepairBatchInput,
  generatedBy: string,
  readTargetSha: TargetShaReader,
): { candidate: SyncCandidateEvidence | null; reason: string | null } {
  const drift = sourceDriftOf(batch);
  if (drift.length > 0) {
    return { candidate: null, reason: `来源已漂移（${drift.map((d) => d.path).join("、")}）：修复计划只列漂移、不自动刷新——先按来源修复/重新登记后再取候选（候选不自动采纳漂移）` };
  }

  const evaluByItem = new Map(batch.evaluation.items.map((i) => [i.id, i]));
  // 现有证据包里**仍适用**的工件（逐项；同一路径去重）。这是"旧适用工件"，不替换成设计源/契约来源。
  const reusableByItem = new Map<string, SyncEvidenceArtifact[]>();
  for (const c of batch.evaluation.artifact_checks) {
    if (!c.reusable) continue;
    const sha = c.current_sha256 ?? c.declared_sha256;
    const arr = reusableByItem.get(c.item_id) ?? [];
    if (!arr.some((a) => a.path === c.path)) arr.push({ path: c.path, sha256: sha });
    reusableByItem.set(c.item_id, arr);
  }

  const items: SyncEvidenceItem[] = [];
  const itemBasis: { item_id: string; basis: SyncCandidateArtifactBasis }[] = [];
  for (const ci of batch.contract.items) {
    const reusable = reusableByItem.get(ci.id);
    if (reusable !== undefined && reusable.length > 0) {
      items.push({ id: ci.id, result: evidenceResultOf(evaluByItem.get(ci.id)?.verdict), artifacts: reusable.map((a) => ({ path: a.path, sha256: a.sha256 })) });
      itemBasis.push({ item_id: ci.id, basis: "reused_existing_evidence" });
      continue;
    }
    const mechanical = mechanicalArtifactsOf(ci.check, readTargetSha);
    if (mechanical !== null) {
      items.push({ id: ci.id, result: evidenceResultOf(evaluByItem.get(ci.id)?.verdict), artifacts: mechanical });
      itemBasis.push({ item_id: ci.id, basis: "mechanical_target" });
      continue;
    }
    if (ci.required) {
      return {
        candidate: null,
        reason:
          `必需项 ${ci.id}（check.type=${ci.check.type}）没有可机械生成的整文件目标工件，也没有可复用的既有证据工件` +
          "——候选不可自动生成（非机械项不代造 passed；请按原流程交付真实证据）",
      };
    }
    // 非必需项：不列入（不代造）。
  }
  if (items.length === 0) return { candidate: null, reason: "契约项全为不可机械生成的项且无可复用既有工件——候选不可自动生成（非机械项不代造）" };

  const pkg: SyncEvidencePackage = {
    schema_version: SYNC_SCHEMA_VERSION,
    batch_id: batch.contract.batch_id,
    project_id: batch.contract.project_id,
    contract_sha256: batch.contract_sha256,
    completed: false,
    items,
  };
  return {
    candidate: {
      package: pkg,
      meta: {
        verified: false,
        completed_default: false,
        generated_by: generatedBy,
        based_on_contract_sha256: batch.contract_sha256,
        based_on_registered_seq: batch.registered_seq,
        item_basis: itemBasis,
        note: CANDIDATE_NOTE,
      },
    },
    reason: null,
  };
}

function buildBatch(projectId: string, batch: RepairBatchInput, generatedBy: string, readTargetSha: TargetShaReader): SyncRepairBatch {
  const drift = sourceDriftOf(batch);
  const checkById = new Map(batch.contract.items.map((i) => [i.id, i.check]));
  const { reusable, expired } = groupArtifacts(batch);
  const contractGeneration = { sha256_12: batch.contract_sha256.slice(0, 12), registered_seq: batch.registered_seq, active: batch.active };

  const items: SyncRepairItem[] = batch.evaluation.items.map((it) => {
    const check = checkById.get(it.id);
    const waiting = waitingOf(check?.type ?? null, it.verdict, batch.evaluation.graph_update_state, batch.evaluation.graph_update_sole, it.reasons, drift);
    const recommendedRole = recommendedRoleOf(it.verdict, batch.evaluation.verdict, drift);
    return {
      item_id: it.id,
      label: it.label,
      required: it.required,
      verdict: it.verdict,
      reasons: it.reasons,
      expected: it.expected,
      actual: it.actual,
      source_drift: drift,
      reusable_artifacts: reusable.get(it.id) ?? [],
      expired_artifacts: expired.get(it.id) ?? [],
      registered_by: batch.registered_by,
      recommended_role: recommendedRole,
      next_read_entry: nextReadEntryOf(projectId, recommendedRole, drift, waiting),
      next_evidence_action: check !== undefined && NEEDS_EVIDENCE.includes(it.verdict) ? evidenceActionOf(projectId, batch.batch_id, recommendedRole, check) : null,
      waiting_for_derivation: waiting,
    };
  });

  const reusableAll = [...reusable.values()].flat();
  const expiredAll = [...expired.values()].flat();
  const { candidate, reason } = buildCandidateEvidence(batch, generatedBy, readTargetSha);

  return {
    batch_id: batch.batch_id,
    title: batch.title,
    active: batch.active,
    blocks_entry: batch.blocks_entry,
    verdict: batch.evaluation.verdict,
    contract_sha256: batch.contract_sha256,
    contract_generation: contractGeneration,
    registered_by: batch.registered_by,
    source_drift: drift,
    reusable_artifacts: reusableAll,
    expired_artifacts: expiredAll,
    items,
    candidate_evidence: candidate,
    candidate_unavailable_reason: reason,
  };
}

/**
 * 装配只读修复计划（**只对现行批次**调；历史批次不参与）。输入必须全是同一次 `evaluateBatch` 的结果——
 * 本函数不重算判定；候选工件所需的"当前整文件 sha"经注入的只读读器取得（不在这里自己做 fs）。
 */
export function buildRepairPlan(input: { projectId: string; batches: readonly RepairBatchInput[]; generatedBy?: string; readTargetSha: TargetShaReader }): SyncRepairPlan {
  const generatedBy = input.generatedBy ?? "syncRepair.buildRepairPlan（只读机械生成，未验证草稿）";
  return {
    generated_from: "read_sync_status",
    read_only: true,
    note: REPAIR_PLAN_NOTE,
    batches: input.batches.map((b) => buildBatch(input.projectId, b, generatedBy, input.readTargetSha)),
  };
}
