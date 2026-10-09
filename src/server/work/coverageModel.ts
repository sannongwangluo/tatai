// 功能清单投影（B2/V09-52；DESIGN.md §2.5.1／§4.2／§6.12）。
//
// 本模块只做一件事：把**已算好的结论**（唯一义务派生层 `deriveObligations` 的投影 + 需求投影 +
// 声明区解析 + PLAN 映射）**只读投影**成 `feature_item[]`。它**不判通过条件**（绿公式唯一实现在
// `statusProjection.ts#projectStatuses`），也**不读**其它投影（workPackage）的输出（§2.6）。
//
// 四条硬约束（§4.2，planning C 段）：
//   ① 四维**可同时发生**，不进单一枚举；绿只取 `verification`；
//   ② `design_coverage` **不得自动推断**（引用存在 ≠ 已覆盖；模型提案 ≠ 已审定；设计激活 ≠ 已覆盖）；
//   ③ `implementation` 只用既有事实（无运行记录 ≠ 未实现；结果已提交 ≠ 已通过）；
//   ④ 两个 Gate 不合并（设计审定 / 用户接受分开）。

import { buildSectionIndex, type DocumentSection } from "./documents";
import { type AcceptanceDimension, type SourceRevisions, type StatusProjection } from "./statusProjection";
import type { RequirementProjection } from "./requirements";
import type {
  CoverageDesignSectionRef,
  DesignCoverage,
  DesignCoverageState,
  AgentReview,
  AgentReviewEvidence,
  FeatureItem,
  ImplementationReadout,
  ImplementationState,
  PendingDecision,
  RequirementRef,
  TaskRef,
  UserAcceptanceReadout,
  VerificationEvidenceEntry,
  VerificationReadout,
} from "../../shared/coverageTypes";
import type { EvidenceState } from "../../ui/arch/provenance";

// ────────────────────────── ① 声明区解析（§2.5.1） ──────────────────────────

/** 声明区的**精确标题标记**：标题文本含它才算候选（`功能清单的正式声明语法` 不含，故不误命中） */
export const FEATURE_DECLARATION_HEADING_HINT = "功能清单声明";

/** 声明表必需列（八列齐全才吸收；缺列即 SOURCE_INVALID，§2.5.1） */
export const FEATURE_DECLARATION_COLUMNS = [
  "功能 ID",
  "人话功能名",
  "需求 ID",
  "设计章节",
  "本期范围",
  "覆盖结论",
  "依据",
  "使用结果",
] as const;

/** 覆盖结论的合法取值（§4.2；`已核对` 只能由审定声明行复算，不得自签） */
export const DESIGN_COVERAGE_STATES: readonly DesignCoverageState[] = [
  "缺失",
  "部分",
  "待审",
  "已核对",
  "源变待复核",
  "无法判断",
];

export interface SourceIssue {
  /** 机器可判的类别：缺列/重复功能ID/悬空需求/章节定位不到/形态非法/表缺失/缺 PLAN 映射 */
  code:
    | "TABLE_MISSING"
    | "COLUMNS_MISSING"
    | "DUPLICATE_FEATURE_ID"
    | "DANGLING_REQUIREMENT"
    | "SECTION_UNRESOLVED"
    | "SCOPE_INVALID"
    | "COVERAGE_INVALID"
    | "REVIEW_MALFORMED"
    /** 声明了功能但施工图映射表里没有对应行 ⇒ **未归属**（可见、不判绿；**不是**结构非法，不整页 422） */
    | "PLAN_MAPPING_MISSING";
  line: number | null;
  message: string;
}

export interface DeclaredFeature {
  item_id: string;
  display_name: string;
  requirement_ids: string[];
  design_sections: string[];
  /** 本期范围原始列值（`cap-*` 或字面量 `null`；其他 ⇒ SCOPE_INVALID） */
  scope_raw: string;
  coverage_raw: string;
  review_raw: string;
  scenario: string;
  row_line: number;
}

export interface FeatureDeclarationParse {
  found: boolean;
  heading_line: number | null;
  features: DeclaredFeature[];
  issues: SourceIssue[];
}

/** 去掉 Markdown 加粗与反引号，取纯文本（表头/单元格比对用） */
function plainCell(raw: string): string {
  return raw.replace(/\*\*/g, "").replace(/`/g, "").trim();
}

/** 一行是否表格行；是则切单元格 */
function splitRow(line: string): string[] | null {
  const t = line.trim();
  if (!t.startsWith("|")) return null;
  const body = t.replace(/^\|/, "").replace(/\|$/, "");
  return body.split("|").map((c) => c.trim());
}

/** 表头行后面的分隔行（`| --- | --- |`） */
function isSeparatorRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every((c) => /^:?-{1,}:?$/.test(c.replace(/\s/g, "")));
}

/**
 * 解析 DESIGN 正文的功能清单声明区（§2.5.1）。
 *
 * 规则：
 *   · 精确标题（标题文本含 `功能清单声明`）+ **完整八列表头**才吸收；**代码围栏内排除**；
 *   · 缺列、重复功能 ID、悬空正式需求、章节无法定位**分别报错**（不静默）；
 *   · 不靠任意三列相似就吸收普通表格。
 */
export function parseFeatureDeclaration(
  designText: string,
  opts: { known_requirement_ids: ReadonlySet<string> },
): FeatureDeclarationParse {
  const lines = designText.split(/\r?\n/);
  // 先标出代码围栏内的行（同形表头在示例围栏里出现时必须排除）
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
  // 找候选标题行
  let headingIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (fenced[i]) continue;
    const m = /^#{1,6}\s+(.*\S)\s*$/.exec(lines[i]);
    if (m && m[1].includes(FEATURE_DECLARATION_HEADING_HINT)) {
      headingIdx = i;
      break;
    }
  }
  if (headingIdx === -1) {
    return {
      found: false,
      heading_line: null,
      features: [],
      issues: [
        { code: "TABLE_MISSING", line: null, message: `DESIGN 正文找不到含「${FEATURE_DECLARATION_HEADING_HINT}」的标题：声明区缺失` },
      ],
    };
  }
  const headingLine = headingIdx + 1;
  // 找标题之后第一张完整的表
  let headerIdx = -1;
  for (let i = headingIdx + 1; i < lines.length; i++) {
    if (fenced[i]) continue;
    const cells = splitRow(lines[i]);
    if (cells === null) {
      // 遇下一个同级/更高级标题就停（声明区只认标题后的表）
      const m = /^(#{1,6})\s+/.exec(lines[i]);
      if (m && m[1].length <= (/^(#{1,6})/.exec(lines[headingIdx])?.[1].length ?? 6)) break;
      continue;
    }
    headerIdx = i;
    break;
  }
  if (headerIdx === -1) {
    return {
      found: true,
      heading_line: headingLine,
      features: [],
      issues: [
        { code: "TABLE_MISSING", line: headingLine, message: `标题「${lines[headingIdx].trim()}」之后没有找到声明表` },
      ],
    };
  }
  const rawHeader = splitRow(lines[headerIdx])!;
  const header = rawHeader.map(plainCell);
  const issues: SourceIssue[] = [];
  const missingColumns = FEATURE_DECLARATION_COLUMNS.filter((need) => !header.some((h) => h.includes(need)));
  if (missingColumns.length > 0) {
    return {
      found: true,
      heading_line: headingLine,
      features: [],
      issues: [
        {
          code: "COLUMNS_MISSING",
          line: headerIdx + 1,
          message: `声明表表头缺列：${missingColumns.join("、")}（八列齐全才吸收，不靠三列相似）`,
        },
      ],
    };
  }
  const colIdx = (need: string): number => header.findIndex((h) => h.includes(need));
  const idx = {
    id: colIdx("功能 ID"),
    name: colIdx("人话功能名"),
    req: colIdx("需求 ID"),
    sections: colIdx("设计章节"),
    scope: colIdx("本期范围"),
    coverage: colIdx("覆盖结论"),
    review: colIdx("依据"),
    scenario: colIdx("使用结果"),
  };
  // 跳过分隔行
  let row = headerIdx + 1;
  if (row < lines.length) {
    const sep = splitRow(lines[row]);
    if (sep !== null && isSeparatorRow(sep)) row += 1;
  }
  const features: DeclaredFeature[] = [];
  const seen = new Set<string>();
  for (; row < lines.length; row++) {
    if (fenced[row]) continue;
    const cells = splitRow(lines[row]);
    if (cells === null) break;
    if (isSeparatorRow(cells)) continue;
    if (cells.every((c) => c === "")) continue;
    const rowLine = row + 1;
    const id = plainCell(cells[idx.id] ?? "");
    if (id === "") continue;
    if (seen.has(id)) {
      issues.push({ code: "DUPLICATE_FEATURE_ID", line: rowLine, message: `重复功能 ID：${id}` });
      continue;
    }
    seen.add(id);
    const reqRaw = plainCell(cells[idx.req] ?? "");
    const requirement_ids = reqRaw
      .split(/[、,]/)
      .map((s) => s.trim())
      .filter((s) => s !== "");
    for (const rid of requirement_ids) {
      if (!opts.known_requirement_ids.has(rid)) {
        issues.push({
          code: "DANGLING_REQUIREMENT",
          line: rowLine,
          message: `功能 ${id} 引用的需求「${rid}」尚未登记（悬空正式需求）`,
        });
      }
    }
    const scope_raw = plainCell(cells[idx.scope] ?? "");
    if (scope_raw !== "null" && !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(scope_raw)) {
      issues.push({
        code: "SCOPE_INVALID",
        line: rowLine,
        message: `功能 ${id} 的「本期范围」列非法：${JSON.stringify(scope_raw)}（只接受明确 scope_id 或字面量 null）`,
      });
    }
    const coverage_raw = plainCell(cells[idx.coverage] ?? "");
    if (!DESIGN_COVERAGE_STATES.includes(coverage_raw as DesignCoverageState)) {
      issues.push({
        code: "COVERAGE_INVALID",
        line: rowLine,
        message: `功能 ${id} 的「覆盖结论」非法：${JSON.stringify(coverage_raw)}（合法值：${DESIGN_COVERAGE_STATES.join("/")}）`,
      });
    }
    features.push({
      item_id: id,
      display_name: plainCell(cells[idx.name] ?? ""),
      requirement_ids,
      design_sections: plainCell(cells[idx.sections] ?? "")
        .split(/[、,]/)
        .map((s) => s.trim())
        .filter((s) => s !== ""),
      scope_raw,
      coverage_raw,
      review_raw: plainCell(cells[idx.review] ?? ""),
      scenario: plainCell(cells[idx.scenario] ?? ""),
      row_line: rowLine,
    });
  }
  return { found: true, heading_line: headingLine, features, issues };
}

// ────────────────────────── ② review 键值解析（§2.5.1） ──────────────────────────

export interface ReviewKeys {
  reviewer: string | null;
  ref: string | null;
  section_sha256: string | null;
  gap: string | null;
}

/** `依据/缺口` 列：`; ` 分隔的键值段（`reviewer=…; ref=…; section_sha256=…; gap=…`） */
export function parseReviewCell(raw: string): ReviewKeys {
  const out: ReviewKeys = { reviewer: null, ref: null, section_sha256: null, gap: null };
  for (const seg of raw.split(";")) {
    const at = seg.indexOf("=");
    if (at === -1) continue;
    const key = seg.slice(0, at).trim();
    const value = seg.slice(at + 1).trim();
    if (key === "reviewer") out.reviewer = value === "" ? null : value;
    else if (key === "ref") out.ref = value === "" ? null : value;
    else if (key === "section_sha256") out.section_sha256 = value === "" ? null : value;
    else if (key === "gap") out.gap = value === "" ? null : value;
  }
  return out;
}

/** 章节 anchor（`§3.5` / `3.5`）→ 章节序号串；定位不到返回 null（不猜近似标题，§6.9） */
function sectionAnchorOf(cell: string): string | null {
  const m = /(?:§|#)?\s*(\d+(?:\.\d+)*)/.exec(cell.replace(/^DESIGN\.md#/, ""));
  return m === null ? null : m[1];
}

/** 证据正文是**内容寻址**（严格 64 位小写十六进制）；大写/其它长度不是证据哈希形态 */
const EVIDENCE_SHA_RE = /^[0-9a-f]{64}$/;

export interface ParsedReviewRef {
  /** `section` = `<项目相对路径>#<锚点>`；`evidence` = 64hex；`none` = 没有/形态不认识 */
  kind: "section" | "evidence" | "none";
  file: string | null;
  anchor: string | null;
  /** 形态或路径不合法时的人话原因（kind=none 时非空） */
  reason: string | null;
}

/**
 * 解析 `依据/缺口` 列的 `ref`（§2.5.1 冻结语法：`<项目相对路径#锚点>` 或证据哈希）。
 * **只看形态**；能不能定位到真实文件/章节/证据由调用方用可读回调复核（`coverageModel` 不自己碰盘）。
 * 绝对路径、`..` 段、没有 `#` 的非哈希串一律按不可定位处理——**不许"任意 file#anchor 蒙混"**。
 */
export function parseReviewRef(ref: string | null): ParsedReviewRef {
  if (ref === null || ref.trim() === "") return { kind: "none", file: null, anchor: null, reason: "ref 为空" };
  const value = ref.trim();
  if (EVIDENCE_SHA_RE.test(value)) return { kind: "evidence", file: null, anchor: null, reason: null };
  if (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith("/") || value.startsWith("\\\\")) {
    return { kind: "none", file: null, anchor: null, reason: "ref 指向绝对路径（只接受项目根内相对路径）" };
  }
  const at = value.indexOf("#");
  if (at <= 0 || at === value.length - 1) {
    return { kind: "none", file: null, anchor: null, reason: "ref 形态不认识（须形如 `<项目相对路径>#<章节锚点>`）" };
  }
  const file = value.slice(0, at).trim();
  const anchorRaw = value.slice(at + 1).trim();
  if (file.split(/[\\/]/).some((seg) => seg === "..")) {
    return { kind: "none", file: null, anchor: null, reason: "ref 路径含 `..` 段（拒绝路径穿越）" };
  }
  const anchor = sectionAnchorOf(anchorRaw);
  if (anchor === null) {
    return { kind: "none", file, anchor: null, reason: `ref 的锚点「${anchorRaw}」不是章节号（不猜近似标题）` };
  }
  return { kind: "section", file, anchor, reason: null };
}

function findSection(sections: readonly DocumentSection[], anchor: string): DocumentSection | null {
  for (const s of sections) {
    if (s.title.startsWith(anchor + " ") || s.title.startsWith(anchor + "　") || s.title === anchor) return s;
    // 标题形如「2.5.1 …」时 title 以 anchor 开头
  }
  return null;
}

// ────────────────────────── ③ PLAN 功能映射表（§2.5.2／C.5 PLAN 侧） ──────────────────────────

export const PLAN_FEATURE_MAP_COLUMNS = ["功能 ID", "人话功能名", "承接卡", "必需检查", "集成检查"] as const;

export interface PlanFeatureRow {
  feature_id: string;
  display_name: string;
  task_ids: string[];
  required_check_ids: string[];
  integration_check_ids: string[];
  row_line: number;
}

export interface PlanFeatureMapParse {
  found: boolean;
  rows: PlanFeatureRow[];
  issues: SourceIssue[];
}

/**
 * 解析 PLAN 的「功能 → 任务/检查/集成」映射表（表头同时含「功能 ID」「承接卡」）。
 * 「结果状态」是**派生列**，不进映射（改它不改变定义内容，§2.5.2）。
 */
export function parsePlanFeatureMap(planText: string): PlanFeatureMapParse {
  const lines = planText.split(/\r?\n/);
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
  const issues: SourceIssue[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (fenced[i]) continue;
    const header = splitRow(lines[i]);
    if (header === null) continue;
    const cells = header.map(plainCell);
    const has = (need: string) => cells.some((c) => c.includes(need));
    if (!(has("功能 ID") && has("承接卡"))) continue;
    const missing = PLAN_FEATURE_MAP_COLUMNS.filter((need) => !has(need));
    if (missing.length > 0) continue; // 不是这张表（不靠相似吸收）
    const colIdx = (need: string): number => cells.findIndex((c) => c.includes(need));
    const idx = {
      id: colIdx("功能 ID"),
      name: colIdx("人话功能名"),
      tasks: colIdx("承接卡"),
      required: colIdx("必需检查"),
      integration: colIdx("集成检查"),
    };
    const rows: PlanFeatureRow[] = [];
    let row = i + 1;
    const sep = splitRow(lines[row] ?? "");
    if (sep !== null && isSeparatorRow(sep)) row += 1;
    const splitList = (s: string): string[] =>
      plainCell(s)
        .split(/[、,]/)
        .map((x) => x.trim())
        .filter((x) => x !== "");
    for (; row < lines.length; row++) {
      if (fenced[row]) continue;
      const c = splitRow(lines[row]);
      if (c === null) break;
      if (isSeparatorRow(c)) continue;
      const id = plainCell(c[idx.id] ?? "");
      if (id === "") continue;
      const required = splitList(c[idx.required] ?? "");
      for (const chk of required) {
        if (!/^chk-[A-Za-z0-9]/.test(chk)) {
          issues.push({
            code: "REVIEW_MALFORMED",
            line: row + 1,
            message: `功能 ${id} 的「必需检查」列不是稳定 ID 形式：${JSON.stringify(chk)}（须形如 chk-<卡号>-NN）`,
          });
        }
      }
      const integration = splitList(c[idx.integration] ?? "");
      for (const int of integration) {
        if (!/^int-/.test(int)) {
          issues.push({
            code: "REVIEW_MALFORMED",
            line: row + 1,
            message: `功能 ${id} 的「集成检查」列不是稳定 ID 形式：${JSON.stringify(int)}（须形如 int-<能力>-NN）`,
          });
        }
      }
      rows.push({
        feature_id: id,
        display_name: plainCell(c[idx.name] ?? ""),
        task_ids: splitList(c[idx.tasks] ?? ""),
        required_check_ids: required,
        integration_check_ids: integration,
        row_line: row + 1,
      });
    }
    return { found: true, rows, issues };
  }
  return { found: false, rows: [], issues };
}

// ────────────────────────── ④ 投影：feature_item[] ──────────────────────────

export interface FeatureScopeStatus {
  /** 该功能范围的**主状态投影**（唯一义务层 `deriveObligations` 的产物；覆盖模型**只消费**） */
  projection: StatusProjection;
  /** 输入侧缺口（范围未定/未映射/集成检查缺失/检查不在定义里），逐条点名 */
  input_gaps: string[];
}

export interface FeatureAcceptanceInput {
  state: AcceptanceDimension;
  gate_refs: string[];
  accepted_tasks: string[];
  unmet: string | null;
}

/**
 * 每项功能的**非作者审查**读数（§3.16）：canonical 投影 `evidence_basis` 的**只读适配**。
 * 判据不新造：只认 canonical 判为「有效通过（`effective==="passed"`）∧ 独立（`independence==="independent"`）」的记录；
 * 作者自检/同会话降级（canonical 已降级）与旧通过、开放缺陷都不充作独立审查完成。
 * 未归属/范围未定/无投影 ⇒ 明确未知，不给通过。
 */
function agentReviewOf(args: {
  item_id: string;
  projection: StatusProjection | undefined;
  unmapped: boolean;
  scope_null: boolean;
}): AgentReview {
  const { item_id, projection, unmapped, scope_null } = args;
  if (projection === undefined) {
    return {
      state: "unknown",
      required_count: 0,
      passed_count: 0,
      missing: [`功能 ${item_id} 没有范围投影（缺项不假绿）`],
      evidence: [],
    };
  }
  const evidence = projection.evidence_basis
    .filter((e) => e.effective === "passed" && e.independence === "independent")
    .map<AgentReviewEvidence>((e) => ({
      check_id: e.check_id,
      reviewer: e.actor_id,
      at: e.at,
      evidence_ref: e.evidence_sha256 ?? e.record_ref ?? "",
      record_ref: e.record_ref ?? null,
      notes: [...e.independence_notes],
    }));
  const missing: string[] = [];
  for (const m of projection.missing) missing.push(`${m.check_id}：${m.why}`);
  for (const e of projection.evidence_basis) {
    if (e.effective === "passed" && e.independence !== "independent") {
      missing.push(
        `「${e.check_id}」当前采信的是**作者自检/同会话**记录（${e.actor_id}）：不充作独立审查完成（§3.16）`,
      );
    }
  }
  const openFindings = projection.open_findings.filter((f) => f.status !== "accepted_risk");
  for (const f of openFindings) {
    missing.push(
      `开放缺陷 ${f.finding_id}（${f.severity}，${f.status}${f.must_block ? "，必须拦截" : ""}）：审查/问题收口未完成`,
    );
  }
  if (unmapped || scope_null) {
    missing.unshift(
      unmapped
        ? "PLAN 功能映射表缺本功能行（未归属）：无法判定独立审查完成"
        : "「本期范围」为 null：范围未定，无法判定独立审查完成",
    );
    return { state: "unknown", required_count: projection.required_count, passed_count: evidence.length, missing, evidence };
  }
  const passed = evidence.length;
  const state: AgentReview["state"] =
    projection.required_count > 0 && passed === projection.required_count && openFindings.length === 0
      ? "passed"
      : "pending";
  return { state, required_count: projection.required_count, passed_count: passed, missing, evidence };
}

export interface BuildFeatureItemsInput {
  design_text: string | null;
  plan_text: string | null;
  /**
   * 功能映射表解析结果——**与装配义务用的是同一次解析**（同一事实快照，§2.6）：
   * 调用方解析一次，同时交给 `deriveObligations` 与这里，避免两处各解析一遍后可能对不上。
   */
  plan_map: PlanFeatureMapParse;
  requirements: RequirementProjection;
  /**
   * 功能 → 该范围的 canonical 投影（**唯一义务层产物**）。
   * 覆盖模型**不**再按"各卡最差"另算一套；缺这个键 = 该功能没有投影（如实记缺口，不假绿）。
   */
  feature_status: Record<string, FeatureScopeStatus>;
  /** 功能 → 用户接受读数（唯一义务层按**范围**采信：单卡 accepted ≠ 多卡功能 accepted） */
  feature_acceptance: Record<string, FeatureAcceptanceInput>;
  /** 功能 → 成员任务里有没有运行记录（无 ⇒ `no_run_record`，**不写「未实现」**） */
  feature_has_run: Record<string, boolean>;
  /** 功能 → 运行事实引用（最近事件 seq 文本；无运行记录 = null） */
  feature_run_basis: Record<string, string | null>;
  /** 成员任务 → 定义指纹 */
  task_fingerprints: Record<string, string>;
  /** 章节索引（所选 design_text 的 buildSectionIndex 结果；无设计 = 空数组） */
  sections: readonly DocumentSection[];
  /** 所选设计文档的项目相对路径（`review.ref` 未带路径时的解析基准） */
  design_rel_path: string;
  /** 项目相对路径 → 该文件的章节索引（不存在/读不到 = null；用于核 `ref` 指的文件真实存在） */
  sections_of_file: (rel_path: string) => DocumentSection[] | null;
  /** 证据正文在证据库里取得到吗（64hex 引用必须**真取得到**，不能只是形态像） */
  evidence_exists: (sha256: string) => boolean;
  /** 设计基线是否已批准**当前所读的这份设计**（review 四条件之一） */
  design_baseline_approved: boolean;
  /** 判 `已核对` 的说明性原因（基线不匹配时点名人话原因；不参与判绿） */
  design_baseline_note: string | null;
  source_revision: SourceRevisions;
  ledger_last_seq: number;
  /** 变更/范围身份的版本（成员与检查定义的版本） */
  scope_revision: string;
  /**
   * 逐条计算**该 item 自身 scope** 的版本串（唯一义务层 `scopeVersionOf`；与六图/HTTP 同值）。
   * 不给 ⇒ 退回 `scope_revision`（旧调用方行为）。给了就**每条按自身 scope** 取，**不得**把整清单的
   * 聚合版本赋给每个 item（WATCH 11:58 B：默认无 scope 过滤时多功能的版本会被整成同一个）。
   */
  scope_revision_of?: (input: {
    scope_id: string;
    member_task_ids: readonly string[];
    required_check_ids: readonly string[];
    integration_check_ids: readonly string[];
  }) => string;
  /** 未登记候选（用户补充）：稳定来源定位符摘要 → 人话（身份不从中文标题重算） */
  unregistered_candidates: { locator_digest: string; display_name: string; source_ref: string }[];
  /** 待议/待决项（另列，不与四维混） */
  pending_decisions: PendingDecision[];
  /** 该 scope 的成员（缺省 = 全部声明功能） */
  scope_filter?: { scope_id: string | null } | null;
  /** 五档证据状态判据（唯一义务层提供；覆盖模型**不另写一套**） */
  evidence_state_of: (p: StatusProjection) => EvidenceState;
}

export interface BuildFeatureItemsResult {
  items: FeatureItem[];
  issues: SourceIssue[];
  /** 覆盖摘要计数用 */
  mapped_requirement_ids: Set<string>;
  /** 已登记待确认候选（未映射 ∧ `status=unconfirmed`）的 requirement_id；**不受 scope 过滤影响** */
  registered_candidate_ids: Set<string>;
  /** 声明区解析是否成功（false ⇒ 上游据此判 SOURCE_INVALID） */
  declaration_found: boolean;
  /** 全部成员需求 id（**不受 scope 过滤影响**；覆盖分母口径用） */
  item_feature_ids: string[];
}

export function buildFeatureItems(input: BuildFeatureItemsInput): BuildFeatureItemsResult {
  const issues: SourceIssue[] = [];
  const knownReq = new Set(Object.keys(input.requirements.requirements));
  const decl = parseFeatureDeclaration(input.design_text ?? "", { known_requirement_ids: knownReq });
  issues.push(...decl.issues);
  const planMap = input.plan_map;
  issues.push(...planMap.issues);
  const mapByFeature = new Map(planMap.rows.map((r) => [r.feature_id, r]));

  // 配置的 scope 过滤
  const scopeWanted = input.scope_filter === undefined ? null : input.scope_filter;

  // **逐条自身 scope** 的版本（不给回调则退回整份 `scope_revision`，保持旧调用方行为）
  const revisionFor = (scope_id: string, row: PlanFeatureRow | undefined): string => {
    if (input.scope_revision_of === undefined) return input.scope_revision;
    return input.scope_revision_of({
      scope_id,
      member_task_ids: row?.task_ids ?? [],
      required_check_ids: row?.required_check_ids ?? [],
      integration_check_ids: row?.integration_check_ids ?? [],
    });
  };

  const mapped_requirement_ids = new Set<string>();
  const items: FeatureItem[] = [];

  // 声明区功能
  for (const f of decl.features) {
    const scope_id = f.scope_raw === "null" ? null : f.scope_raw;
    // 覆盖分母口径：**不受 scope 过滤影响**——先记成员，再决定这条是否进本次分页
    for (const rid of f.requirement_ids) mapped_requirement_ids.add(rid);
    if (scopeWanted !== null && scope_id !== scopeWanted.scope_id) continue;
    const planRow = mapByFeature.get(f.item_id);
    if (planRow === undefined) {
      // **不是结构非法**：声明了功能但施工图还没映射 ⇒ 按"未归属"如实显示，不整页 422 掩盖其他功能
      issues.push({
        code: "PLAN_MAPPING_MISSING",
        line: f.row_line,
        message: `功能 ${f.item_id} 在 PLAN 功能映射表里没有对应行（承接卡/检查未定义）：按未归属显示，不给通过结论`,
      });
    }

    // 设计章节引用（逐条定位 + 章节 hash；定位不到如实 unresolved）
    const sectionRefs: CoverageDesignSectionRef[] = [];
    // 本功能**明确声明**且**定位到**的章节（精确章节对象）：ref 主章节归属判定的唯一依据（不靠标题包含/近似）
    const declaredSections: DocumentSection[] = [];
    const review = parseReviewCell(f.review_raw);
    for (const secCell of f.design_sections) {
      const anchor = sectionAnchorOf(secCell);
      const sec = anchor === null ? null : findSection(input.sections, anchor);
      if (sec === null) {
        sectionRefs.push({
          title: secCell,
          line: 0,
          anchor: anchor ?? secCell,
          hash: "",
          status: "unresolved",
        });
        if (anchor !== null) {
          issues.push({
            code: "SECTION_UNRESOLVED",
            line: f.row_line,
            message: `功能 ${f.item_id} 引用的设计章节「${secCell}」定位不到（不猜近似标题，§6.9）`,
          });
        }
      } else {
        declaredSections.push(sec);
        sectionRefs.push({
          title: sec.title,
          line: sec.line_start,
          anchor: anchor ?? sec.title,
          hash: sec.sha256,
          status: "located",
        });
      }
    }
    // 覆盖结论复算：只有 review 四条件成立才可「已核对」
    //   reviewer 非空 ∧ ref **实际可定位**（`<项目相对路径>#<锚点>`：该文件真实存在、
    //   锚点在该文件里定位到；或 64hex：证据正文在证据库里真取得到）∧
    //   section_sha256 与 **ref 指定的主章节**现值一致（不是"任意被引章节之一"）∧
    //   **被审主章节属于本功能「设计章节」列明确声明的章节**（精确章节身份，不靠标题包含/近似）∧
    //   该设计基线已批准（§2.5.1）
    const reviewerOk = review.reviewer !== null;
    const parsed = parseReviewRef(review.ref);
    const refSection = ((): DocumentSection | null => {
      if (parsed.kind !== "section" || parsed.file === null || parsed.anchor === null) return null;
      const fileSections =
        parsed.file === input.design_rel_path ? input.sections : input.sections_of_file(parsed.file);
      if (fileSections === null) return null;
      return findSection(fileSections, parsed.anchor);
    })();
    const refOk =
      parsed.kind === "evidence"
        ? review.ref !== null && input.evidence_exists(review.ref)
        : refSection !== null;
    // **主章节身份**：ref 指向的章节必须**就是**「设计章节」列声明的某一节（同一解析读到的精确章节对象）。
    // 声明节定位不到、ref 在别的文档/定位不到、或 ref 是证据哈希 ⇒ 建立不了声明集合内的主章节 ⇒ 不放行。
    // （多声明章节现行只有一个主 section_sha256：这里只核**被审主章节**是否在声明集合内，
    //   不要求一个哈希同时等于所有声明章节。）
    const mainSectionDeclared = refSection !== null && declaredSections.some((s) => s === refSection);
    // 主章节 hash：必须等于 **ref 指定的那一节**的现值（ref 指向别处、hash 拿另一节凑数 ⇒ 不通过）
    const hashOk = review.section_sha256 !== null && refSection !== null && refSection.sha256 === review.section_sha256;
    // 「源变待复核」只在**主章节确实属于声明集合**时才有意义：无关章节/定位不到不冒充源变，如实「待审」。
    const sectionHashMismatch =
      refSection !== null &&
      mainSectionDeclared &&
      review.section_sha256 !== null &&
      refSection.sha256 !== review.section_sha256;
    const verified = reviewerOk && refOk && hashOk && mainSectionDeclared && input.design_baseline_approved;
    const unmet = verified
      ? null
      : [
          reviewerOk ? null : "reviewer 为空（未审定，不得自签）",
          refOk
            ? null
            : parsed.kind === "evidence"
              ? `ref（证据哈希）在证据库里取不到`
              : parsed.reason !== null
                ? `ref 不可定位：${parsed.reason}`
                : `ref 指向的章节在「${parsed.file ?? "?"}」里定位不到`,
          mainSectionDeclared
            ? null
            : parsed.kind === "evidence"
              ? "ref 是证据哈希：建立不了「设计章节」列声明的主章节（不借证据存在性判「已核对」）"
              : refSection === null
                ? "ref 主章节定位不到，无法归入「设计章节」列声明的章节（不借无关来源通过）"
                : declaredSections.length === 0
                  ? "本功能「设计章节」列没有可定位的章节，建立不了主章节归属（不放行）"
                  : `ref 指向的主章节「${parsed.file ?? "?"}#${parsed.anchor ?? "?"}」不属于本功能「设计章节」列声明的章节（不借无关章节哈希通过）`,
          hashOk ? null : "section_sha256 与 ref 指定主章节的现值不一致",
          input.design_baseline_approved ? null : `设计基线未批准当前所读版本（${input.design_baseline_note ?? "原因未知"}）`,
        ]
          .filter((x): x is string => x !== null)
          .join("；");
    let coverageState: DesignCoverageState;
    if (f.coverage_raw === "已核对" && !verified) {
      coverageState = sectionHashMismatch ? "源变待复核" : "待审";
    } else if (sectionHashMismatch) {
      coverageState = "源变待复核";
    } else if (f.coverage_raw === "已核对" && verified) {
      coverageState = "已核对";
    } else if (DESIGN_COVERAGE_STATES.includes(f.coverage_raw as DesignCoverageState)) {
      coverageState = f.coverage_raw as DesignCoverageState;
    } else {
      coverageState = "无法判断";
    }
    const design_coverage: DesignCoverage = {
      state: coverageState,
      review: {
        reviewer: review.reviewer,
        ref: review.ref,
        section_sha256: review.section_sha256,
        verified,
        ref_kind: parsed.kind,
        unmet,
      },
      gap: review.gap,
    };

    // 卡与逐项义务
    const task_ids = planRow?.task_ids ?? [];
    const taskRefs: TaskRef[] = task_ids.map((t) => ({
      task_id: t,
      definition_fingerprint: input.task_fingerprints[t] ?? "",
    }));
    // 实现维度：只用既有事实（成员任务没有运行留痕 ⇒ 无运行记录，**不写「未实现」**）
    const featureStatus = input.feature_status[f.item_id];
    let implementation: ImplementationReadout;
    if (input.feature_has_run[f.item_id] !== true) {
      implementation = { state: "no_run_record", basis: null };
    } else {
      const state: ImplementationState = featureStatus?.projection.execution ?? "not_started";
      implementation = { state, basis: input.feature_run_basis[f.item_id] ?? null };
    }

    // 验证维度：**直接消费该范围的 canonical 投影**（唯一义务层产物）——不按"各卡最差"另算一套
    let verification: VerificationReadout;
    if (featureStatus === undefined) {
      verification = {
        display_status: "unknown",
        evidence_state: "missing",
        required_count: 0,
        passed_count: 0,
        missing: [`功能 ${f.item_id} 没有范围投影（缺项不假绿）`],
        effective_version: null,
        evidence_entry: [],
      };
    } else {
      const p = featureStatus.projection;
      verification = {
        display_status: p.display_status ?? "planned",
        evidence_state: input.evidence_state_of(p),
        required_count: p.required_count,
        passed_count: p.passed_count,
        missing: [
          ...p.missing.map((m) => `${m.check_id}：${m.label}（${m.why}）`),
          ...(featureStatus.input_gaps ?? []),
        ],
        effective_version: p.evidence_basis[0]?.bound_revision.revision ?? null,
        evidence_entry: p.evidence_basis.map<VerificationEvidenceEntry>((e) => ({
          check_id: e.check_id,
          evidence_ref: e.evidence_sha256 ?? e.record_ref ?? "",
          effective: e.effective,
        })),
      };
    }

    // 用户接受维度：**按范围真实采信**（单卡 accepted ≠ 多卡功能 accepted；gate_ref 与判词对应）
    const acc = input.feature_acceptance[f.item_id];
    const user_acceptance: UserAcceptanceReadout = {
      state: acc?.state ?? "pending",
      gate_ref: acc !== undefined && acc.gate_refs.length > 0 ? acc.gate_refs.join("、") : null,
      scope_tasks: task_ids,
      accepted_tasks: acc?.accepted_tasks ?? [],
      unmet: acc?.unmet ?? "本功能没有范围接受读数（不借别的卡的用户 Gate）",
    };

    // 非作者审查读数：canonical 投影的只读适配（未归属/范围未定/无投影 ⇒ 未知，不给通过）
    const agent_review = agentReviewOf({
      item_id: f.item_id,
      projection: featureStatus?.projection,
      unmapped: planRow === undefined,
      scope_null: scope_id === null,
    });

    items.push({
      item_id: f.item_id,
      scope_id,
      scope_revision: revisionFor(f.item_id, planRow),
      display_name: f.display_name,
      user_description: f.scenario,
      scenario: f.scenario,
      requirement_refs: f.requirement_ids.map<RequirementRef>((rid) => ({
        requirement_id: rid,
        source_ref: input.requirements.requirements[rid]?.source.ref ?? "",
        certainty:
          input.requirements.requirements[rid]?.status === "explicit"
            ? "明确"
            : input.requirements.requirements[rid]?.status === "inferred"
              ? "推断"
              : "待确认",
      })),
      design_section_refs: sectionRefs,
      design_coverage,
      implementation,
      verification,
      user_acceptance,
      pending_decisions: input.pending_decisions,
      task_refs: taskRefs,
      agent_review,
      provenance: {
        extraction: "declared",
        // 未归属（施工图缺映射）在这里如实点名，与"已声明"并存，不掩盖也不假绿
        unmapped: planRow === undefined ? ["PLAN 功能映射表缺本功能行（未归属）"] : [],
        pending_leads: [],
        derivation: {
          design_revision: input.source_revision.design ?? null,
          plan_revision: input.source_revision.plan ?? null,
          plan_definition: input.source_revision.plan_definition ?? null,
          ledger_last_seq: input.ledger_last_seq,
        },
      },
    });
  }

  // 已登记但未被任何声明功能映射的需求 → pending:<requirement_id>，按登记状态**分两类**（同一源快照派生，不另判）：
  //   · `unconfirmed`（待确认）⇒ **已登记待确认候选**：单列可见、有来源、certainty=待确认，**不阻断交付**、不冒充正式功能；
  //   · `explicit`/`inferred` ⇒ **正式待映射**：如实阻断交付（未映射的明确/推断需求不得因曾被当候选而留白）。
  // 已有正式声明映射的需求在上一段已 `continue`（正式映射优先，不因 `unconfirmed` 被降级或免验）。
  const allReqIds = Object.keys(input.requirements.requirements).sort();
  const registered_candidate_ids = new Set<string>();
  for (const rid of allReqIds) {
    if (mapped_requirement_ids.has(rid)) continue;
    const st = input.requirements.requirements[rid];
    const isCandidate = st.status === "unconfirmed";
    if (isCandidate) registered_candidate_ids.add(rid);
    const domain = isCandidate ? "已登记待确认候选" : "已登记需求";
    const noMapping = isCandidate ? "已登记待确认候选尚无正式功能映射" : "已登记需求尚无功能映射";
    items.push({
      item_id: `pending:${rid}`,
      scope_id: null,
      scope_revision: revisionFor(`pending:${rid}`, undefined),
      display_name: isCandidate ? `（已登记待确认）${rid}` : `（未映射需求）${rid}`,
      user_description: st.problem,
      scenario: st.success_scenarios[0] ?? "",
      requirement_refs: [
        {
          requirement_id: rid,
          source_ref: st.source.ref,
          certainty: st.status === "explicit" ? "明确" : st.status === "inferred" ? "推断" : "待确认",
        },
      ],
      design_section_refs: [],
      design_coverage: {
        state: "缺失",
        review: {
          reviewer: null,
          ref: null,
          section_sha256: null,
          verified: false,
          ref_kind: "none",
          unmet: `${noMapping}（未映射 ⇒ 不可能「已核对」）`,
        },
        gap: noMapping,
      },
      implementation: { state: "no_run_record", basis: null },
      verification: { display_status: "planned", evidence_state: "missing", required_count: 0, passed_count: 0, missing: [`${domain}：没有功能范围，不判绿`], effective_version: null, evidence_entry: [] },
      user_acceptance: { state: "pending", gate_ref: null, scope_tasks: [], accepted_tasks: [], unmet: `${domain}没有范围证据` },
      pending_decisions: [],
      task_refs: [],
      agent_review: {
        state: "unknown",
        required_count: 0,
        passed_count: 0,
        missing: [`${domain}：没有功能范围，无法判定非作者审查`],
        evidence: [],
      },
      provenance: {
        extraction: isCandidate ? "registered_candidate" : "mapped_requirement_pending",
        unmapped: isCandidate ? [] : [rid],
        pending_leads: [],
        derivation: {
          design_revision: input.source_revision.design ?? null,
          plan_revision: input.source_revision.plan ?? null,
          plan_definition: input.source_revision.plan_definition ?? null,
          ledger_last_seq: input.ledger_last_seq,
        },
      },
    });
  }

  // 未登记候选（用户补充）→ 单列，可追溯，不冒充正式功能身份
  for (const c of input.unregistered_candidates) {
    items.push({
      item_id: `pending:${c.locator_digest}`,
      scope_id: null,
      scope_revision: revisionFor(`pending:${c.locator_digest}`, undefined),
      display_name: c.display_name,
      user_description: c.display_name,
      scenario: "",
      requirement_refs: [],
      design_section_refs: [],
      design_coverage: {
        state: "待审",
        review: {
          reviewer: null,
          ref: null,
          section_sha256: null,
          verified: false,
          ref_kind: "none",
          unmet: "未登记候选：来源待核对，不得判「已核对」",
        },
        gap: "未登记候选，来源待核对",
      },
      implementation: { state: "no_run_record", basis: null },
      verification: { display_status: "planned", evidence_state: "missing", required_count: 0, passed_count: 0, missing: ["未登记候选：没有正式范围，不判绿"], effective_version: null, evidence_entry: [] },
      user_acceptance: { state: "pending", gate_ref: null, scope_tasks: [], accepted_tasks: [], unmet: "未登记候选没有范围证据" },
      pending_decisions: [],
      task_refs: [],
      agent_review: {
        state: "unknown",
        required_count: 0,
        passed_count: 0,
        missing: ["未登记候选：没有正式范围，无法判定非作者审查"],
        evidence: [],
      },
      provenance: {
        extraction: "unregistered_candidate",
        unmapped: [],
        pending_leads: [c.source_ref],
        derivation: {
          design_revision: input.source_revision.design ?? null,
          plan_revision: input.source_revision.plan ?? null,
          plan_definition: input.source_revision.plan_definition ?? null,
          ledger_last_seq: input.ledger_last_seq,
        },
      },
    });
  }

  return {
    items,
    issues,
    mapped_requirement_ids,
    registered_candidate_ids,
    declaration_found: decl.found,
    // 声明区功能的 id（**不受 scope 过滤影响**）：覆盖分母口径用它，避免 scope 过滤把账目打歪
    item_feature_ids: decl.features.map((f) => f.item_id),
  };
}

/** 章节索引入口（供 loader 与验证脚本复用同一口径） */
export function sectionsOf(designText: string | null): DocumentSection[] {
  return designText === null ? [] : buildSectionIndex(designText);
}
