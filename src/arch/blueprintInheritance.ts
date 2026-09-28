// C016 收口第二包（2026-09-21）：蓝图删除/拆并的**语义登记命令**（DESIGN.md §4.1、§12.1 第 16 项；
// PLAN.md V06-05 下 2026-09-21 C016 登记）。
//
// 定版契约：派生蓝图的权威来源 = 已审定图纸基线 + 合法变更事实；本期不提供直接编辑派生蓝图的
// 独立入口。删除/拆并的唯一合法路径是"**源先改、事实后记、再派生**"：
//   ① 获授权设计角色先修订设计/施工权威原文并激活新基线；
//   ② 本命令登记 `change.blueprint_inheritance_recorded` 事实（唯一事实流 = work 事件流，
//      不落 blueprint.json——派生缓存可删可重建，不单独保存权威变更）；
//   ③ rebuildBlueprint 从修订后的权威源重派生（事实不驱动节点/边，只留可追溯记录）。
//
// 本模块是**语义闸**：所有跨基线/源图/引用校验都在 submit 之前完成——任何一项不成立，
// events.jsonl 一个字节都不变（拒绝是原子的）。结构判据（键闭合/非空/去重/基数/处置形态）
// 复用 changes.ts 的 readBlueprintInheritancePayload（与折叠、与 WorkService.submit 直连预检同一份）。
//
// 逐道闸（顺序即语义）：
//   ① 入参闭键 → ② 结构判据 → ③ 角色必须是设计授权角色（roleClassOf === designer）→
//   ④ 批次真实存在且未关闭 → ⑤ from_baseline 逐字段等于批次 target_baseline（change 引用不接受
//      任意非空值）→ ⑥ from 基线在基线流水里真实存在（拿得到不可变恢复位置）→
//   ⑦ to_baseline 就是当前生效基线 → ⑧ from ≠ to（没有发生源修订的事实不是变更事实），
//      且 from 在 to 的 supersedes 修订链上（跨基线/乱序拒）→ ⑨ 当前权威源内容与生效基线一致
//      （激活后又被改 = 先重新审定激活）→ ⑩ 前任确实存在于从 from 基线不可变修订重建的 from 图 →
//   ⑪ to 图（从当前权威源确定性重派生）已形成预期结果：remove=前任不在；split=前任不在且继任全在；
//      merge=应消失的前任不在且唯一继任在——**事实不能凭空删/造节点** →
//   ⑫ 有效任务/证据对前任的引用全部有处置明细（缺一项/多一项都整体拒；证据读不出 fail-closed 拒）→
//   ⑬ 批次授权范围逐字覆盖每个前任（节点 id / 名称 / 出处定位串至少其一）→ 提交。
import { getProject } from "../server/registry";
import { projectWorkDir } from "../server/workstation";
import {
  activeBaseline,
  readBaselineLog,
  recoverRevision,
  type ProjectBaseline,
} from "../server/work/documents";
import {
  readBlueprintInheritancePayload,
  recordBlueprintInheritance,
  type BlueprintInheritancePayload,
  type BlueprintReferenceDisposition,
  type ChangeSubmitter,
  type ChangeTargetBaseline,
} from "../server/work/changes";
import { readTaskStates } from "../server/work/tasks";
import { evidenceManifest, readEvidence } from "../server/work/evidence";
import { roleClassOf } from "../server/work/entry";
import { WorkError, type WorkReceipt } from "../server/work/types";
import {
  PLAN_PREFIX,
  blueprintCacheKeysOf,
  deriveBlueprint,
  deriveBlueprintFromTexts,
  readBlueprintSources,
  type Blueprint,
} from "./blueprint";

// ───────────────────────────────── 入参 ─────────────────────────────────

export interface RegisterBlueprintInheritanceInput extends BlueprintInheritancePayload {
  /** 目标变更批次 id（事实挂在它身上；批次必须真实存在、未关闭、target_baseline == from_baseline） */
  change_batch_id: string;
  actor_id: string;
  /** 必须是设计授权角色（归一后 = designer，如 designer/gpt-6）；其他角色一律拒 */
  role: string;
  occurred_at?: string;
}

const INPUT_KEYS = [
  "change_batch_id",
  "actor_id",
  "role",
  "occurred_at",
  "kind",
  "from_baseline",
  "to_baseline",
  "predecessor_ids",
  "successor_ids",
  "affected_node_ids",
  "reference_dispositions",
] as const;

function bad(message: string, detail: Record<string, unknown> = {}): never {
  throw new WorkError("INVALID_COMMAND", `蓝图继承事实登记不合法：${message}`, detail);
}

const sameBaselineRef = (a: ChangeTargetBaseline, b: ChangeTargetBaseline): boolean =>
  a.baseline_id === b.baseline_id && a.design_revision === b.design_revision && a.plan_revision === b.plan_revision;

/** 同一基线引用指向当前生效基线（baseline_id 给了就必须逐字对上） */
function matchesActiveBaseline(ref: ChangeTargetBaseline, active: ProjectBaseline): boolean {
  return (
    ref.design_revision === active.design_revision.content_sha256 &&
    ref.plan_revision === active.plan_revision.content_sha256 &&
    (ref.baseline_id === null || ref.baseline_id === active.baseline_id)
  );
}

/** 从基线流水里找出 from 引用指向的那条记录（baseline_id 给了就连 id 一起对；找不到 = 伪造/未知） */
function findBaselineRecord(log: ProjectBaseline[], ref: ChangeTargetBaseline): ProjectBaseline | null {
  return (
    log.find(
      (b) =>
        (ref.baseline_id === null || b.baseline_id === ref.baseline_id) &&
        b.design_revision.content_sha256 === ref.design_revision &&
        b.plan_revision.content_sha256 === ref.plan_revision,
    ) ?? null
  );
}

/** active 的 supersedes 祖先链（不含自己）：逐条跟 supersedes 走，断链即止 */
function ancestorIdsOf(log: ProjectBaseline[], active: ProjectBaseline): Set<string> {
  const byId = new Map(log.map((b) => [b.baseline_id, b]));
  const out = new Set<string>();
  let cur: string | null = active.supersedes;
  while (cur !== null && !out.has(cur)) {
    out.add(cur);
    cur = byId.get(cur)?.supersedes ?? null;
  }
  return out;
}

/** 一份图纸在 from/to 两侧的节点集合比对用 id 清单 */
const nodeIdsOf = (bp: Blueprint): Set<string> => new Set(bp.nodes.map((n) => n.id));

/** 授权范围覆盖判定（闸⑬ 单一口径，2026-09-21 收口审计 F-05）：needle 必须**词边界**出现——
 *  前后不许紧跟字母数字（id/名称/定位串的延续字符是字母数字；冒号、连字符、空白、标点、
 *  换行都算边界）。子串包含会让 `plan:mod:01-12` 替 `plan:mod:01-1` 顶包（前缀碰撞放行），
 *  词边界不会。导出是给验证脚本做 unit 级断言（夹具难造前缀碰撞的节点对）。 */
export function authorizationTextCovers(haystack: string, needle: string): boolean {
  const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^A-Za-z0-9])${esc}(?:$|[^A-Za-z0-9])`).test(haystack);
}

/**
 * 有效任务/证据对前任节点的引用（**从项目存储现读**，调用方声明不采信）：
 *   · 任务：任务投影里未取消的任务卡——前任本身是它的任务节点（`plan:task:<卡号>`），
 *     或在 from 图上与该任务节点相邻（保守方向：牵连就算引用，§4.1 核对有效任务引用）；
 *   · 证据：`.工作台/work/evidence/` 里完整（哈希自洽）且 source_ref 逐字指向 from 图上前任的证据。
 * 证据读不出/哈希不自洽时不猜——由调用方按 fail-closed 拒掉（无法证明引用处置已全覆盖）。
 */
function collectPredecessorReferences(
  workDir: string,
  fromGraph: Blueprint,
  predecessorIds: readonly string[],
): { refs: Map<string, string[]>; evidence_unreadable: string[] } {
  const refs = new Map<string, string[]>(predecessorIds.map((id) => [id, []]));
  const fromNodeIds = nodeIdsOf(fromGraph);

  const activeTaskIds = Object.values(readTaskStates(workDir).states)
    .filter((t) => !t.cancelled && t.status !== "cancelled")
    .map((t) => t.task_id);
  const activeTaskNodes = new Set(activeTaskIds.map((id) => `${PLAN_PREFIX}task:${id}`));
  const taskRefOf = (nodeId: string): string | null =>
    nodeId.startsWith(`${PLAN_PREFIX}task:`) ? nodeId.slice(`${PLAN_PREFIX}task:`.length) : null;
  for (const pred of predecessorIds) {
    const selfTask = taskRefOf(pred);
    if (selfTask !== null && activeTaskNodes.has(pred)) refs.get(pred)!.push(`task:${selfTask}`);
    for (const e of fromGraph.edges) {
      const other = e.source === pred ? e.target : e.target === pred ? e.source : null;
      if (other === null || !activeTaskNodes.has(other)) continue;
      const taskId = taskRefOf(other);
      if (taskId !== null) refs.get(pred)!.push(`task:${taskId}`);
    }
  }

  const unreadable: string[] = [];
  for (const entry of evidenceManifest(workDir)) {
    if (!entry.intact) {
      unreadable.push(entry.evidence_id);
      continue;
    }
    try {
      const blob = readEvidence(workDir, entry.evidence_id);
      const s = blob.source_ref;
      if (s === null || s === "") continue;
      const hit = fromNodeIds.has(s) ? s : fromNodeIds.has(`${PLAN_PREFIX}task:${s}`) ? `${PLAN_PREFIX}task:${s}` : null;
      if (hit !== null && refs.has(hit)) refs.get(hit)!.push(`evidence:${entry.evidence_id}`);
    } catch {
      unreadable.push(entry.evidence_id);
    }
  }
  for (const [k, list] of refs) refs.set(k, [...new Set(list)].sort());
  return { refs, evidence_unreadable: unreadable };
}

// ───────────────────────────────── 语义登记命令 ─────────────────────────────────

/**
 * 登记一条蓝图删除/拆并的合法变更事实。全部语义校验在 submit 前完成：
 * 任何一道闸不成立都抛 `WorkError(INVALID_COMMAND)` 且 **events.jsonl 零字节变化**；
 * 全部通过才经 changes.ts 的 `recordBlueprintInheritance` 走唯一写入服务落事件。
 */
export function registerBlueprintInheritance(
  projectId: string,
  input: RegisterBlueprintInheritanceInput,
  opts: { dataDir?: string; submitter: ChangeSubmitter },
): WorkReceipt {
  // ① 入参闭键
  const extra = Object.keys(input as unknown as Record<string, unknown>).filter((k) => !(INPUT_KEYS as readonly string[]).includes(k));
  if (extra.length > 0) {
    bad(`入参只收这些键（${INPUT_KEYS.join(" / ")}），多出来的键一律拒：${extra.join("、")}`, { extra });
  }
  const where = `登记蓝图继承事实 ${input.change_batch_id}`;

  // ② 结构判据（与折叠/写命令同一份）
  const payload = readBlueprintInheritancePayload(
    {
      kind: input.kind,
      from_baseline: input.from_baseline,
      to_baseline: input.to_baseline,
      predecessor_ids: input.predecessor_ids,
      successor_ids: input.successor_ids,
      affected_node_ids: input.affected_node_ids,
      reference_dispositions: input.reference_dispositions,
    },
    "INVALID_COMMAND",
    where,
  );

  // ③ 角色闸：只能由设计授权角色登记
  if (typeof input.role !== "string" || roleClassOf(input.role) !== "designer") {
    bad(
      `只能由设计授权角色登记（收到 role=${JSON.stringify(input.role)}）：删除/拆并的前提是设计角色先修订权威原文，` +
        "执行/协调/审计角色都不能直接把删除/拆并写成事实（DESIGN §4.1）",
      { role: input.role },
    );
  }
  if (typeof input.actor_id !== "string" || input.actor_id.trim() === "") {
    bad("actor_id 必须是非空字符串（谁登记的必须如实写）", { field: "actor_id" });
  }

  // ④ 批次真实存在且未关闭
  const projection = opts.submitter.read?.();
  if (projection === undefined) {
    bad("提交者没有给出变更批次读侧（submitter.read）：登记前必须先读当前批次，不能靠「我以为它开着」", {
      reason: "missing_change_reader",
    });
  }
  const batch = projection.changes[input.change_batch_id];
  if (batch === undefined) {
    bad(`变更批次不存在：${input.change_batch_id}（登记继承事实前先开批次；批次是事实的归属）`, {
      change_batch_id: input.change_batch_id,
      known: Object.keys(projection.changes).sort(),
    });
  }
  if (batch.status === "closed") {
    bad(`变更批次 ${input.change_batch_id} 已关闭：关闭的批次不再授权新的删除/拆并（接着干请开新批次/新迭代，§2.5）`, {
      change_batch_id: input.change_batch_id,
    });
  }

  // ⑤ from 必须逐字段等于批次 target_baseline（change 引用不接受任意非空值）
  if (!sameBaselineRef(payload.from_baseline, batch.target_baseline)) {
    bad(
      `from_baseline 必须等于批次 ${input.change_batch_id} 的 target_baseline（批次登记的目标基线是 ` +
        `${JSON.stringify(batch.target_baseline)}）：批次授权只覆盖它点名要修订的那条基线，跨目标登记拒`,
      { from_baseline: payload.from_baseline, target_baseline: batch.target_baseline },
    );
  }

  // ⑥ from 基线真实存在（拿得到不可变恢复位置，才能重建 from 图核对前任）
  const project = getProject(projectId, opts.dataDir);
  if (!project) throw new WorkError("INVALID_COMMAND", `项目不存在: ${projectId}`, { project_id: projectId });
  const log = readBaselineLog(projectId, opts.dataDir);
  const fromRecord = findBaselineRecord(log.baselines, payload.from_baseline);
  if (fromRecord === null) {
    bad(
      `from_baseline 指向的基线在基线流水里找不到（${JSON.stringify(payload.from_baseline)}）：` +
        "伪造/未知基线一律拒——事实必须锚在真实存在、可恢复的基线上",
      { from_baseline: payload.from_baseline },
    );
  }

  // ⑦ to 就是当前生效基线，且 from 在它的 supersedes 修订链上
  const active = activeBaseline(projectId, opts.dataDir);
  if (active === null) {
    bad("项目还没有生效基线：没有 to 基线可登记（先由用户/设计角色审定激活，§2.9）", { project_id: projectId });
  }
  if (!matchesActiveBaseline(payload.to_baseline, active)) {
    bad(
      `to_baseline 必须是真实当前生效基线（当前是 ${active.baseline_id}）：` +
        "登记时生效的是哪条就锚哪条，不接受旧的/未来的/伪造的生效基线",
      { to_baseline: payload.to_baseline, active_baseline_id: active.baseline_id },
    );
  }
  // ⑧ from ≠ to（没有发生源修订就不是变更事实；先于修订链核对——相同本身就是最直接的不成立）
  if (sameBaselineRef(payload.from_baseline, payload.to_baseline)) {
    bad(
      "from_baseline 与 to_baseline 相同：没有发生源修订。合法路径是「源先改、事实后记、再派生」——" +
        "先修订设计/施工权威原文并激活新基线，再登记事实（§4.1）",
    );
  }
  if (!ancestorIdsOf(log.baselines, active).has(fromRecord.baseline_id)) {
    bad(
      `from 基线 ${fromRecord.baseline_id} 不在当前生效基线 ${active.baseline_id} 的 supersedes 修订链上：` +
        "跨基线/乱序登记拒——事实的 from/to 必须与真实修订链一致",
      { from_baseline_id: fromRecord.baseline_id, active_baseline_id: active.baseline_id },
    );
  }

  // ⑨ 当前权威源内容与生效基线一致（激活后又改了图纸 = 先重新审定激活再登记）
  const src = readBlueprintSources(projectId, opts.dataDir);
  if (src.design === null || src.plan === null) {
    bad("当前权威源缺设计书或施工图：无法核对 to 图是否已成形（缺源不登记）", {
      design: src.design !== null,
      plan: src.plan !== null,
    });
  }
  if (
    src.design.content_sha256 !== active.design_revision.content_sha256 ||
    src.plan.content_sha256 !== active.plan_revision.content_sha256
  ) {
    bad(
      "当前图纸内容与生效基线不一致（基线激活后图纸又被改动）：先重新审定激活，再登记事实——" +
        "登记核对的是「审定基线 ↔ 权威原文」一致的现场",
      {
        active_baseline_id: active.baseline_id,
        design_matches: src.design.content_sha256 === active.design_revision.content_sha256,
        plan_matches: src.plan.content_sha256 === active.plan_revision.content_sha256,
      },
    );
  }

  // ⑩ 前任确实存在于 from 图（从 from 基线的不可变修订重建；不复制第二份正文作事实源）
  const isTatai = project.self_managed === true || project.id === "tatai";
  const fromDesign = recoverRevision(project.path, fromRecord.design_revision.recovery).text;
  const fromPlan = recoverRevision(project.path, fromRecord.plan_revision.recovery).text;
  const fromGraph = deriveBlueprintFromTexts({
    baseline_id: fromRecord.baseline_id,
    is_tatai: isTatai,
    design: { path: fromRecord.design_revision.source_path, text: fromDesign },
    plan: { path: fromRecord.plan_revision.source_path, text: fromPlan },
    code: src.code,
    names: src.names,
  });
  const fromIds = nodeIdsOf(fromGraph);
  const missingPreds = payload.predecessor_ids.filter((id) => !fromIds.has(id));
  if (missingPreds.length > 0) {
    const codePreds = missingPreds.filter((id) => id.startsWith(`${PLAN_PREFIX}code:`));
    bad(
      `前任不在 from 图里：${missingPreds.join("、")}（from 基线 ${fromRecord.baseline_id} 的不可变修订重建结果中没有它们）——` +
        "事实只能登记真实存在过的节点的删除/拆并，不虚构前任" +
        (codePreds.length > 0
          ? `。其中 ${codePreds.join("、")} 是代码派生节点（${PLAN_PREFIX}code:*）：代码快照不随基线钉住——` +
            "from 图只能用**当前**代码重建（历史没有实现观察快照），已删除的代码模块在 from 图里天然缺席；" +
            "代码派生节点的删除/拆并本期按 blueprint.ts「从历史/指定文本派生」一节声明的限制不可登记为继承事实，" +
            "只能在代码真实变更后重派生"
          : ""),
      { missing: missingPreds, from_baseline_id: fromRecord.baseline_id },
    );
  }

  // ⑪ to 图已由修订后的权威源形成预期结果（事实不能凭空删/造节点/边）
  const toGraph = deriveBlueprint(src, { based_on: blueprintCacheKeysOf(src, false) });
  const toIds = nodeIdsOf(toGraph);
  const survivingPreds = payload.predecessor_ids.filter((id) => toIds.has(id));
  if (survivingPreds.length > 0) {
    const codePreds = survivingPreds.filter((id) => id.startsWith(`${PLAN_PREFIX}code:`));
    bad(
      `to 图未形成预期结果：前任 ${survivingPreds.join("、")} 仍由修订后的权威源派生出来` +
        `（kind=${payload.kind} 要求应消失的前任不在 to 图）——事实不能凭空删节点：请先修订设计/施工权威原文再登记` +
        (codePreds.length > 0
          ? `。其中 ${codePreds.join("、")} 是代码派生节点（${PLAN_PREFIX}code:*）：它跟的是**当前**代码快照，` +
            "不是设计/施工文本修订——代码没变它就照派生；代码派生节点的删除/拆并本期按 blueprint.ts" +
            "「从历史/指定文本派生」一节声明的限制不可登记为继承事实，只能在代码真实变更后重派生"
          : ""),
      { surviving: survivingPreds },
    );
  }
  const missingSuccs = payload.successor_ids.filter((id) => !toIds.has(id));
  if (missingSuccs.length > 0) {
    bad(
      `继任不在 to 图里：${missingSuccs.join("、")}——继任必须由修订后的权威源真实派生，事实不能凭空造节点`,
      { missing: missingSuccs },
    );
  }

  // ⑫ 有效任务/证据引用的处置明细：缺一项/多一项都整体拒；证据读不出 fail-closed 拒
  const workDir = projectWorkDir(projectId, opts.dataDir);
  const { refs, evidence_unreadable } = collectPredecessorReferences(workDir, fromGraph, payload.predecessor_ids);
  if (evidence_unreadable.length > 0) {
    bad(
      `有证据读不出/哈希不自洽：${evidence_unreadable.join("、")}——无法证明引用处置已全覆盖（fail-closed）：` +
        "先处理证据现场再登记",
      { evidence_unreadable },
    );
  }
  const provided = new Map<string, BlueprintReferenceDisposition>();
  for (const d of payload.reference_dispositions) provided.set(`${d.predecessor_id}${d.referenced_by}`, d);
  const missingRefs: string[] = [];
  for (const [pred, list] of refs) {
    for (const refBy of list) {
      if (!provided.has(`${pred}${refBy}`)) missingRefs.push(`${pred} 的 ${refBy}`);
    }
  }
  if (missingRefs.length > 0) {
    bad(
      `有效任务/证据引用缺处置明细：${missingRefs.join("；")}——被引用的前任必须先在权威记录中合法迁移/处置引用，` +
        "缺一项整体拒绝（§4.1 引用守卫；migrated 迁到继任，disposed 随前任退役）",
      { missing: missingRefs },
    );
  }
  const requiredPairs = new Set<string>();
  for (const [pred, list] of refs) for (const refBy of list) requiredPairs.add(`${pred}${refBy}`);
  const extraDispositions = payload.reference_dispositions.filter(
    (d) => !requiredPairs.has(`${d.predecessor_id}${d.referenced_by}`),
  );
  if (extraDispositions.length > 0) {
    bad(
      `多余处置明细：${extraDispositions.map((d) => `${d.predecessor_id} 的 ${d.referenced_by}`).join("；")}——` +
        "当前有效任务/证据引用里没有它们（处置只能覆盖真实存在的有效引用，不多报）",
      { extra: extraDispositions },
    );
  }

  // ⑬ 批次授权范围逐字覆盖每个前任（节点 id / 名称 / 出处定位串至少其一，**词边界**判定）
  const haystack = [batch.goal, batch.authorized_scope, batch.exit_criteria, ...batch.affected_subsystems].join("\n");
  const uncovered: string[] = [];
  for (const pred of payload.predecessor_ids) {
    const node = fromGraph.nodes.find((n) => n.id === pred);
    const needles = [pred, node?.name ?? "", ...(node?.source_refs.map((r) => r.locator) ?? [])].filter((s) => s !== "");
    if (!needles.some((needle) => authorizationTextCovers(haystack, needle))) uncovered.push(pred);
  }
  if (uncovered.length > 0) {
    bad(
      `批次授权范围不覆盖目标：${uncovered.join("、")} 的节点 id / 名称 / 出处定位串都未逐字出现在批次 ` +
        `${input.change_batch_id} 的 goal/authorized_scope/exit_criteria/affected_subsystems 里——范围不点名目标就不授权`,
      { uncovered, change_batch_id: input.change_batch_id },
    );
  }

  // 全部通过才落事件（唯一写入服务；此刻之前 events.jsonl 零字节）
  return recordBlueprintInheritance(opts.submitter, {
    project_id: projectId,
    change_batch_id: input.change_batch_id,
    change_id: input.change_batch_id,
    actor_id: input.actor_id.trim(),
    role: input.role,
    ...(input.occurred_at === undefined ? {} : { occurred_at: input.occurred_at }),
    ...payload,
  });
}
