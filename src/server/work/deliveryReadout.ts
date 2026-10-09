// 交付总览的**只读派生**（V09-62；DESIGN.md §3.16／§3.17）。
//
// 一件事：把**已算好**的同一份事实结论（唯一义务派生 `deriveObligations` / `statusProjection` 的投影 +
// 覆盖摘要 + PLAN 的「交付核对声明」「集成检查要求」）投影成 `FeatureLedger.delivery`。
// **不新建完成台账**、**不另算一套绿色**：三类交付核对与每项功能的非作者审查都只从 canonical 投影
// 里采信「有效 ∧ 独立」的记录；缺声明/重复/悬空/空/未批准一律 fail-closed（unknown，不猜）。
//
// 边界（§3.16）：
//   · 摘要在服务端对**本次完整范围**算好再分页——局部/历史只能给有界信息，不宣布当前整项目可试用；
//   · 人工接受单列，`pending` 不阻断进入试用，但**不得**改称已接受；
//   · 版本/证据有效性随既有 `package_revision` 现读依赖变化（设计/施工图修订、账本末序号、源读数），
//     不借分页或缓存把旧结论当新结论。

import type { ProjectFacts, StatusObjectInput, StatusProjectionSet } from "./statusProjection";
import type { EvidenceBasis } from "./statusProjection";
import type { StableCheckDefinition } from "./obligations";
import type {
  AcceptanceDimension,
  AgentReviewEvidence,
  DeliveryBlocker,
  DeliveryGate,
  DeliveryGateId,
  DeliveryIntegrationReadout,
  DeliveryOverview,
  DesignCoverageState,
  DisplayStatus,
} from "../../shared/coverageTypes";

// ────────────────────────── 三类交付核对的固定身份 ──────────────────────────

export const DELIVERY_GATE_IDS: readonly DeliveryGateId[] = ["coverage", "review", "runtime"];

export const DELIVERY_GATE_LABELS: Readonly<Record<DeliveryGateId, string>> = {
  coverage: "完整功能范围核查",
  review: "非作者审查与问题收口",
  runtime: "运行交付版本核对",
};

/** 交付范围对象 id（唯一义务层里的集成检查范围；不新增产品功能或六图节点） */
export const DELIVERY_SCOPE_ID = "project:delivery";

// ────────────────────────── PLAN「交付核对声明」解析 ──────────────────────────

export interface DeliveryGateRow {
  gate: DeliveryGateId;
  card_id: string;
  check_ids: string[];
  line: number;
}

export interface DeliveryGateDeclarationParse {
  found: boolean;
  /** 「交付核对声明」段的标题行（1 起）；没定位到 = null */
  section_line: number | null;
  table_line: number | null;
  rows: DeliveryGateRow[];
  /** 结构问题（未识别核对项/缺列/空值/重复段或表/非法检查键…）——非空即整段不据此判定 */
  issues: string[];
}

function plainCell(raw: string): string {
  return raw.replace(/\*\*/g, "").replace(/`/g, "").trim();
}

function splitRow(line: string): string[] | null {
  const t = line.trim();
  if (!t.startsWith("|")) return null;
  const body = t.replace(/^\|/, "").replace(/\|$/, "");
  return body.split("|").map((c) => c.trim());
}

function isSeparatorRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every((c) => /^:?-{1,}:?$/.test(c.replace(/\s/g, "")));
}

function fencedLines(lines: readonly string[]): boolean[] {
  const fenced = new Array<boolean>(lines.length).fill(false);
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) {
      fenced[i] = true;
      inFence = !inFence;
      continue;
    }
    fenced[i] = inFence;
  }
  return fenced;
}

/** 该行是不是 Markdown 标题行（1–6 级；围栏内不算） */
function isHeadingLine(line: string): boolean {
  return /^\s{0,3}#{1,6}\s/.test(line);
}

/** 稳定检查键形态（`chk-…` 等；宽松：字母开头、不含空白/通配符） */
function looksStableCheckKey(id: string): boolean {
  return /^[A-Za-z][A-Za-z0-9._:-]*$/.test(id);
}

/**
 * 解析 PLAN 的「交付核对声明」表（§3.16：固定三行 coverage/review/runtime；列＝核对项/承接卡/检查 ID）。
 *
 * **必须定位到「交付核对声明」段**：只在含该标题的段内、且表头含「核对项」「承接卡」「检查 ID」三列的
 * 表才是声明表——任意其它同表头（别名、示例、别段）**都不能冒充**。围栏内的示例排除。
 *
 * **fail-closed**：段/表重复、未识别核对项、空值、非稳定检查键等一律逐条进 `issues`
 * （判定层据此整段不据此判定，不静默选第一张表、不让首表遮后表）。
 */
export function parseDeliveryGateDeclaration(planText: string): DeliveryGateDeclarationParse {
  const lines = planText.split(/\r?\n/);
  const fenced = fencedLines(lines);
  const issues: string[] = [];
  const empty: DeliveryGateDeclarationParse = { found: false, section_line: null, table_line: null, rows: [], issues };

  // ① 定位「交付核对声明」段（标题行含该短语）；段范围到下一个标题行为止。
  const sectionStarts: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (fenced[i] || !isHeadingLine(lines[i])) continue;
    if (lines[i].includes("交付核对声明")) sectionStarts.push(i);
  }
  if (sectionStarts.length === 0) return empty;
  if (sectionStarts.length > 1) {
    issues.push(
      `「交付核对声明」段出现 ${sectionStarts.length} 次（第 ${sectionStarts.map((n) => n + 1).join("、")} 行）：声明段重复，不猜`,
    );
  }
  const start = sectionStarts[0];
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (!fenced[i] && isHeadingLine(lines[i])) {
      end = i;
      break;
    }
  }

  // ② 段内找声明表（表头含三列）。多于一张 ⇒ 重复。
  const headerIdx: number[] = [];
  for (let i = start + 1; i < end; i++) {
    if (fenced[i]) continue;
    const header = splitRow(lines[i]);
    if (header === null) continue;
    const cells = header.map(plainCell);
    const has = (need: string): boolean => cells.some((c) => c.includes(need));
    if (has("核对项") && has("检查 ID") && has("承接卡")) headerIdx.push(i);
  }
  if (headerIdx.length === 0) {
    issues.push(
      `「交付核对声明」段（第 ${start + 1} 行）里没有可识别的声明表（表头须含「核对项」「承接卡」「检查 ID」三列）`,
    );
    return { ...empty, section_line: start + 1, issues };
  }
  if (headerIdx.length > 1) {
    issues.push(
      `「交付核对声明」段里有 ${headerIdx.length} 张同表头的表（第 ${headerIdx.map((n) => n + 1).join("、")} 行）：声明表重复，不猜`,
    );
  }
  const table = headerIdx[0];
  const cells = splitRow(lines[table])!.map(plainCell);
  const colGate = cells.findIndex((c) => c.includes("核对项"));
  const colCard = cells.findIndex((c) => c.includes("承接卡"));
  const colChecks = cells.findIndex((c) => c.includes("检查 ID"));

  // ③ 逐行读声明行（围栏内排除；到非表行止）。
  const rows: DeliveryGateRow[] = [];
  let row = table + 1;
  const sep = splitRow(lines[row] ?? "");
  if (sep !== null && isSeparatorRow(sep)) row += 1;
  for (; row < end; row++) {
    if (fenced[row]) continue;
    const c = splitRow(lines[row]);
    if (c === null) break;
    if (isSeparatorRow(c)) continue;
    const gateRaw = plainCell(c[colGate] ?? "");
    const card = plainCell(c[colCard] ?? "");
    const checkIds = plainCell(c[colChecks] ?? "")
      .split(/[、,]/)
      .map((s) => s.trim())
      .filter((s) => s !== "");
    if (gateRaw === "" && card === "" && checkIds.length === 0) continue; // 真正的空行
    if (!DELIVERY_GATE_IDS.includes(gateRaw as DeliveryGateId)) {
      issues.push(`第 ${row + 1} 行「核对项」不是 coverage/review/runtime 之一：${JSON.stringify(gateRaw)}`);
      continue;
    }
    if (card === "") issues.push(`第 ${row + 1} 行「${gateRaw}」缺承接卡`);
    if (checkIds.length === 0) issues.push(`第 ${row + 1} 行「${gateRaw}」的「检查 ID」为空集`);
    else if (!checkIds.every(looksStableCheckKey)) {
      issues.push(`第 ${row + 1} 行「${gateRaw}」的检查 ID 不是稳定键：${JSON.stringify(checkIds.join("、"))}`);
    }
    rows.push({ gate: gateRaw as DeliveryGateId, card_id: card, check_ids: checkIds, line: row + 1 });
  }
  return { found: true, section_line: start + 1, table_line: table + 1, rows, issues };
}

// ────────────────────────── 证据只读适配 ──────────────────────────

/** canonical `EvidenceBasis` → 人类可展开的审查记录（reviewer/time/ref） */
export function evidenceAdapter(e: EvidenceBasis): AgentReviewEvidence {
  return {
    check_id: e.check_id,
    reviewer: e.actor_id,
    at: e.at,
    evidence_ref: e.evidence_sha256 ?? e.record_ref ?? "",
    record_ref: e.record_ref ?? null,
    notes: [...e.independence_notes],
  };
}

/** 一条 canonical 依据是否「有效通过 ∧ 独立」（唯一判据在 statusProjection，不另算） */
function independentlyPassed(e: EvidenceBasis): boolean {
  return e.effective === "passed" && e.independence === "independent";
}

/** 未通过时的人话原因（逐条点名口径） */
function notEffectiveReason(e: EvidenceBasis): string {
  if (e.effective === "passed") {
    return `这次通过来自作者自检或与作者同会话的记录（记录者：${e.actor_id || "未记名"}）：不能当作非作者审查通过（§3.16）`;
  }
  switch (e.effective) {
    case "failed":
      return "检查未通过（已确认失败，需修复后复测）";
    case "stale":
      return "旧通过已转待验证（源版本已变）";
    case "not_checked":
      return "尚未检查";
    default:
      return "有效性未知（不默认通过）";
  }
}

// ────────────────────────── project:delivery 集成范围 ──────────────────────────

export interface DeliveryIntegrationDeclarationRow {
  check_id: string;
  label: string;
  required: boolean;
}

export interface DeliveryIntegrationDeclaration {
  declared: boolean;
  in_force: boolean;
  not_in_force_reason: string | null;
  check_ids: string[];
  /** 声明行的原始必需性（`必需`/`非必需`）；判定要消费它（不只看有没有证据） */
  rows: DeliveryIntegrationDeclarationRow[];
  /** 声明生效且有检查时才给出可入投影的对象；否则 null（此时不给交付集成背书） */
  object: StatusObjectInput | null;
}

/** 从事实装配 `project:delivery` 的集成检查范围对象（沿用已有义务派生方式） */
export function deliveryIntegrationOf(facts: ProjectFacts): DeliveryIntegrationDeclaration {
  const req = facts.integration_requirements;
  const rows = req.by_object[DELIVERY_SCOPE_ID] ?? [];
  const check_ids = rows.map((r) => r.check_id);
  const object: StatusObjectInput | null =
    req.declared && req.in_force && rows.length > 0
      ? {
          object_id: DELIVERY_SCOPE_ID,
          object_kind: "capability",
          label: DELIVERY_SCOPE_ID,
          executions: [],
          required_checks: [],
          integration_checks: rows.map((r) => ({ check_id: r.check_id, label: r.label, required: r.required })),
          integration_checks_source: "plan",
          integration_checks_revision: req.plan_revision,
          integration_checks_blocked_reason: null,
          finding_ids: facts.findings
            .filter((f) => f.object_id === DELIVERY_SCOPE_ID)
            .map((f) => f.finding_id),
          revisions: facts.revisions,
        }
      : null;
  return {
    declared: req.declared,
    in_force: req.in_force,
    not_in_force_reason: req.not_in_force_reason,
    check_ids,
    rows: rows.map((r) => ({ check_id: r.check_id, label: r.label, required: r.required !== false })),
    object,
  };
}

/** 交付范围集成检查读数（形态落在 shared；成功时也带依据） */
export type DeliveryIntegrationResolution = DeliveryIntegrationReadout;

/**
 * 交付范围集成检查（`project:delivery` 的 `int-project-delivery-01`）的判定。
 *
 * **消费 canonical 完整判据**：不只循环 `evidence_basis` 另判通过——
 *   · 缺声明 / 声明空集 / **没有「必需」的集成检查** / 未获有效基线批准 / 未进投影 一律 unknown；
 *   · canonical 投影自己点名的缺口（`missing`）与开放缺陷一并计入；
 *   · 只有声明为「必需」的集成检查全部「有效 ∧ 独立」且无未收口缺陷才 passed。
 */
export function resolveDeliveryIntegration(args: {
  declaration: DeliveryIntegrationDeclaration;
  projection: StatusProjectionSet;
}): DeliveryIntegrationResolution {
  const d = args.declaration;
  const base = { check_ids: d.check_ids };
  if (!d.declared) {
    return {
      ...base,
      state: "unknown",
      missing: ["PLAN 未声明「集成检查要求」小节：project:delivery 的交付集成条件尚未核对"],
      evidence: [],
    };
  }
  if (d.check_ids.length === 0) {
    return {
      ...base,
      state: "unknown",
      missing: [`「集成检查要求」没有 ${DELIVERY_SCOPE_ID} 行（预期 int-project-delivery-01）：交付集成条件尚未核对`],
      evidence: [],
    };
  }
  if (!d.rows.some((r) => r.required)) {
    return {
      ...base,
      state: "unknown",
      missing: [`${DELIVERY_SCOPE_ID} 的集成检查没有一项标为「必需」：交付集成条件尚未成立`],
      evidence: [],
    };
  }
  if (!d.in_force) {
    return {
      ...base,
      state: "unknown",
      missing: [d.not_in_force_reason ?? `${DELIVERY_SCOPE_ID} 的集成检查要求未获有效基线批准：暂不能判定交付集成通过`],
      evidence: [],
    };
  }
  const proj = args.projection.by_id[DELIVERY_SCOPE_ID];
  if (proj === undefined) {
    return { ...base, state: "unknown", missing: [`${DELIVERY_SCOPE_ID} 未进入状态投影：无法判定交付集成检查`], evidence: [] };
  }
  const missing: string[] = [];
  const evidence: AgentReviewEvidence[] = [];
  let allPassed = true;
  // canonical 投影自己点名的必需项缺口：一律计入（不靠另算的循环漏掉）
  for (const m of proj.missing) {
    allPassed = false;
    missing.push(`${m.check_id}：${m.why}`);
  }
  const requiredIds = new Set(d.rows.filter((r) => r.required).map((r) => r.check_id));
  for (const check_id of d.check_ids) {
    const entry = proj.evidence_basis.find((e) => e.check_id === check_id);
    // 非必需项：有证据就带出供人展开，但**不据此判通过**（必需性由 `requiredIds` / canonical `missing` 决定）
    if (entry !== undefined) evidence.push(evidenceAdapter(entry));
    if (!requiredIds.has(check_id)) continue;
    if (entry === undefined) {
      allPassed = false;
      if (!proj.missing.some((m) => m.check_id === check_id)) {
        missing.push(`${check_id}：没有任何检查记录（结果提交不等于集成通过）`);
      }
      continue;
    }
    if (!independentlyPassed(entry)) {
      allPassed = false;
      missing.push(`${check_id}：${notEffectiveReason(entry)}`);
    }
  }
  for (const f of proj.open_findings.filter((x) => x.status !== "accepted_risk")) {
    allPassed = false;
    missing.push(
      `${DELIVERY_SCOPE_ID} 开放缺陷 ${f.finding_id}（${f.severity}，${f.status}${f.must_block ? "，必须拦截" : ""}）：集成核对未收口`,
    );
  }
  return { ...base, state: allPassed ? "passed" : "pending", missing: [...new Set(missing)], evidence };
}

// ────────────────────────── 三类交付核对判定 ──────────────────────────

/** 某承接卡的稳定检查定义里有没有这条 check（悬空判据） */
function checkDefined(
  task_checks: Record<string, StableCheckDefinition[]>,
  card_id: string,
  check_id: string,
): boolean {
  return (task_checks[card_id] ?? []).some((d) => d.check_id === check_id);
}

/**
 * 逐条判定三类交付核对（§3.16）。
 * 通过依据只取 canonical 投影里**有效且独立**的记录；缺声明/重复/悬空/空/未批准一律 unknown。
 * **声明段有结构问题（`issues` 非空）时整段 fail-closed**：完整三行 + 一个坏行也不能仍按三行通过。
 */
export function resolveDeliveryGates(args: {
  declaration: DeliveryGateDeclarationParse;
  plan_mapping_approved: boolean;
  projection: StatusProjectionSet;
  task_checks: Record<string, StableCheckDefinition[]>;
}): DeliveryGate[] {
  const { declaration, plan_mapping_approved, projection, task_checks } = args;
  const out: DeliveryGate[] = [];
  for (const id of DELIVERY_GATE_IDS) {
    const label = DELIVERY_GATE_LABELS[id];
    const rows = declaration.rows.filter((r) => r.gate === id);
    const missing: string[] = [];
    const evidence: AgentReviewEvidence[] = [];
    const unknown = (msgs: string[]): DeliveryGate => ({ id, label, state: "unknown", check_ids: rows[0]?.check_ids ?? [], missing: msgs, evidence: [] });
    if (!declaration.found) {
      out.push(unknown([`PLAN 未声明「交付核对声明」表：${label}尚未核对（交付条件尚未核对）`]));
      continue;
    }
    if (rows.length === 0) {
      out.push(unknown([`「交付核对声明」缺 ${id} 行：${label}尚未核对`]));
      continue;
    }
    if (rows.length > 1) {
      out.push(unknown([`「交付核对声明」${id} 行重复（${rows.length} 条）：异常，不猜`]));
      continue;
    }
    const row = rows[0];
    if (row.check_ids.length === 0) {
      out.push({ id, label, state: "unknown", check_ids: [], missing: [`「交付核对声明」${id} 行的「检查 ID」为空集`], evidence: [] });
      continue;
    }
    if (row.card_id === "") {
      out.push({ id, label, state: "unknown", check_ids: row.check_ids, missing: [`「交付核对声明」${id} 行缺承接卡`], evidence: [] });
      continue;
    }
    if (!plan_mapping_approved) {
      out.push({
        id,
        label,
        state: "unknown",
        check_ids: row.check_ids,
        missing: [`PLAN 定义未获有效基线批准（${id}）：该定义暂不能判定${label}通过`],
        evidence: [],
      });
      continue;
    }
    const dangling = row.check_ids.filter((c) => !checkDefined(task_checks, row.card_id, c));
    if (dangling.length > 0) {
      out.push({
        id,
        label,
        state: "unknown",
        check_ids: row.check_ids,
        missing: dangling.map((c) => `承接卡 ${row.card_id} 的定义里没有检查 ${c}（悬空引用）：暂不能判定通过`),
        evidence: [],
      });
      continue;
    }
    const proj = projection.by_id[row.card_id];
    if (proj === undefined) {
      out.push({
        id,
        label,
        state: "unknown",
        check_ids: row.check_ids,
        missing: [`承接卡 ${row.card_id} 未进入状态投影：无法判定 ${id}`],
        evidence: [],
      });
      continue;
    }
    let allPassed = true;
    for (const check_id of row.check_ids) {
      const entry = proj.evidence_basis.find((e) => e.check_id === check_id);
      if (entry === undefined) {
        allPassed = false;
        missing.push(`${check_id}：没有任何检查记录（结果提交不等于核对通过）`);
        continue;
      }
      evidence.push(evidenceAdapter(entry));
      if (!independentlyPassed(entry)) {
        allPassed = false;
        missing.push(`${check_id}：${notEffectiveReason(entry)}`);
      }
    }
    out.push({ id, label, state: allPassed ? "passed" : "pending", check_ids: row.check_ids, missing, evidence });
  }
  // 声明段结构问题 ⇒ 整段 fail-closed（否则"完整三行 + 坏行"仍会按三行通过）
  if (declaration.found && declaration.issues.length > 0) {
    return out.map((g) => ({
      ...g,
      state: "unknown",
      missing: [...declaration.issues.map((m) => `「交付核对声明」段结构问题：${m}`), ...g.missing],
    }));
  }
  return out;
}

// ────────────────────────── 交付总览装配 ──────────────────────────

export interface DeliveryFeatureRead {
  item_id: string;
  design_state: DesignCoverageState;
  display_status: DisplayStatus | null;
  agent_review_state: "passed" | "pending" | "unknown";
  acceptance: AcceptanceDimension;
}

export interface DeliveryOverviewInput {
  scope: "project" | "partial" | "historical";
  drift: string | null;
  design_baseline_approved: boolean;
  plan_mapping_approved: boolean;
  coverage: {
    source_complete: boolean;
    registered_requirement_count: number;
    mapped_count: number;
    /** 正式待映射（`explicit`/`inferred`）需求数 */
    pending_count: number;
    /** 已登记待确认候选（`unconfirmed` 未映射）需求数——单列、**不阻断** */
    registered_candidate_count: number;
    unregistered_candidate_count: number;
    unexamined_sources: { ref: string; reason: string }[];
  };
  /** 正式声明功能（**不含** pending 前缀项与候选）的全范围读数 */
  features: DeliveryFeatureRead[];
  /** **正式待映射**需求 id（逐条点名，进 blocker）；待确认候选**不在此列**（单列可见，不阻断） */
  pending_requirement_ids: string[];
  gates: DeliveryGate[];
  integration: DeliveryIntegrationResolution;
  blocking_findings: { finding_id: string; object_id: string | null; message: string }[];
  version: DeliveryOverview["version"];
}

const countBy = <T>(rows: readonly T[], pick: (r: T) => string | undefined): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const r of rows) {
    const k = pick(r) ?? "";
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
};

/** 交付集成读数的**人话**状态（摘要/普通文案里不出现 passed/pending 原始英文） */
const INTEGRATION_STATE_LABEL: Readonly<Record<"passed" | "pending" | "unknown", string>> = {
  passed: "已通过",
  pending: "未通过",
  unknown: "尚未核对",
};

/**
 * 装配交付总览（§3.16）。**全范围**结论在此一次算好，分页只影响 `items`（调用方负责）。
 * 分母守恒：`mapped_requirements + pending_requirements + registered_candidates = requirements`；
 * 正式需求分母 `formal_requirements = mapped + pending`（不含任何候选）。已登记待确认候选单列可见、
 * **不阻断**；未登记候选另计。**只有**正式待映射需求（`pending_requirement_ids`）进 `unmapped_requirement` 阻断。
 * `ready_for_trial` 须同时满足：正式功能非空；来源读齐且登记需求全有正式去向；
 * 每项功能设计覆盖已核对且技术验证有效、非作者审查通过；三类核对与 project:delivery 集成检查
 * 均有有效独立证据；现行完整有效基线、无阻断缺陷。人的接受为 pending 不阻断，但**不得**改称已接受。
 * 每种返回都附 `integration` 读数（成功时也带依据，供人展开）。
 */
export function buildDeliveryOverview(input: DeliveryOverviewInput): DeliveryOverview {
  const { coverage, features, gates, integration } = input;
  const acceptance = countBy(features, (f) => f.acceptance);
  const user_acceptance = {
    pending: acceptance.pending ?? 0,
    accepted: acceptance.accepted ?? 0,
    rejected: acceptance.rejected ?? 0,
    accepted_known_limit: acceptance.accepted_known_limit ?? 0,
  };
  const counts = {
    features: features.length,
    design_checked: features.filter((f) => f.design_state === "已核对").length,
    verified: features.filter((f) => f.display_status === "verified").length,
    reviewed: features.filter((f) => f.agent_review_state === "passed").length,
    requirements: coverage.registered_requirement_count,
    mapped_requirements: coverage.mapped_count,
    pending_requirements: coverage.pending_count,
    // 正式需求分母与已登记待确认候选**显式分开**：mapped + pending + registered_candidates = requirements。
    formal_requirements: coverage.mapped_count + coverage.pending_count,
    registered_candidates: coverage.registered_candidate_count,
    candidates: coverage.unregistered_candidate_count,
  };

  const blockers: DeliveryBlocker[] = [];
  const push = (kind: string, item_id: string | null, message: string): void => {
    blockers.push({ kind, item_id, message });
  };

  // ── 有界信息（历史/局部）或版本不可采信：不宣布当前整项目可试用（unknown） ──
  if (input.scope !== "project") {
    push(
      input.scope === "historical" ? "scope_historical" : "scope_partial",
      null,
      input.scope === "historical"
        ? "当前读的是不可变历史快照：只给有界信息，不宣布当前整项目可试用"
        : "当前只读取局部范围：只给有界信息，不据此宣布整项目可试用",
    );
    return {
      state: "unknown",
      summary: summarise(input, counts, "unknown"),
      scope: input.scope,
      counts,
      gates,
      integration,
      blockers,
      version: input.version,
      user_acceptance,
    };
  }
  if (input.drift !== null || !input.design_baseline_approved || !input.plan_mapping_approved) {
    push(
      "version",
      null,
      input.drift ?? "PLAN 功能映射未获有效基线批准：该版本暂不能判定交付通过",
    );
    return { state: "unknown", summary: summarise(input, counts, "unknown"), scope: "project", counts, gates, integration, blockers, version: input.version, user_acceptance };
  }
  if (!coverage.source_complete) {
    const unread = coverage.unexamined_sources.map((u) => `${u.ref}（${u.reason}）`);
    push(
      "source_incomplete",
      null,
      `必需来源未读齐（${coverage.registered_requirement_count === 0 ? "登记需求为空" : `${unread.length} 项未读`}）：来源未读齐不报完整`,
    );
    return { state: "unknown", summary: summarise(input, counts, "unknown"), scope: "project", counts, gates, integration, blockers, version: input.version, user_acceptance };
  }

  // ── 全范围结论 ──
  if (features.length === 0) push("no_features", null, "正式功能为空：没有可交付的正式功能范围");
  for (const f of features) {
    if (f.design_state !== "已核对") push("design_coverage", f.item_id, `功能 ${f.item_id} 设计覆盖未「已核对」（当前：${f.design_state}）`);
    if (f.display_status !== "verified") push("technical_verification", f.item_id, `功能 ${f.item_id} 技术验证未通过（当前：${f.display_status ?? "无"}）`);
    if (f.agent_review_state !== "passed") push("agent_review", f.item_id, `功能 ${f.item_id} 非作者审查未完成（当前：${f.agent_review_state}）`);
  }
  for (const rid of input.pending_requirement_ids) {
    push("unmapped_requirement", `pending:${rid}`, `已登记需求 ${rid} 尚无正式功能映射（待映射）`);
  }
  for (const f of input.blocking_findings) {
    push("blocking_finding", f.object_id, `阻断缺陷 ${f.finding_id}：${f.message}`);
  }
  for (const g of gates) {
    if (g.state === "unknown") push(`gate_${g.id}`, null, `交付核对「${g.label}」尚未核对：${g.missing.join("；")}`);
    else if (g.state === "pending") push(`gate_${g.id}`, null, `交付核对「${g.label}」未通过：${g.missing.join("；")}`);
  }
  if (integration.state === "unknown") push("integration_check", DELIVERY_SCOPE_ID, `交付集成检查尚未核对：${integration.missing.join("；")}`);
  else if (integration.state === "pending") push("integration_check", DELIVERY_SCOPE_ID, `交付集成检查未通过：${integration.missing.join("；")}`);

  // unknown 优先：任一类核对或集成检查尚未核对（条件不成）时不假装可结论
  const unknownGate = gates.some((g) => g.state === "unknown") || integration.state === "unknown";
  const state: DeliveryOverview["state"] = unknownGate ? "unknown" : blockers.length === 0 ? "ready_for_trial" : "not_ready";
  return { state, summary: summarise(input, counts, state), scope: "project", counts, gates, integration, blockers, version: input.version, user_acceptance };
}

function summarise(input: DeliveryOverviewInput, counts: DeliveryOverview["counts"], state: DeliveryOverview["state"]): string {
  const parts: string[] = [
    `正式功能 ${counts.features} 项：设计覆盖已核对 ${counts.design_checked}、技术验证通过 ${counts.verified}、非作者审查通过 ${counts.reviewed}`,
    `登记需求 ${counts.requirements}（正式 ${counts.formal_requirements ?? "未知"}：已映射 ${counts.mapped_requirements}、待映射 ${counts.pending_requirements}；` +
      `已登记待确认候选 ${counts.registered_candidates ?? "未知"}，不阻断）、未登记待议 ${counts.candidates}`,
    `三类交付核对 ${input.gates.filter((g) => g.state === "passed").length}/3 通过、交付集成核对${INTEGRATION_STATE_LABEL[input.integration.state]}`,
  ];
  if (state === "ready_for_trial") {
    parts.push("人工接受仍待用户确认（待确认不阻断进入试用，但不得改称已接受）");
    return `可以开始人工试用：${parts.join("；")}。`;
  }
  if (state === "not_ready") {
    return `尚不能开始人工试用：${parts.join("；")}。`;
  }
  return `交付条件尚未核对（未知）：${parts.join("；")}。`;
}
