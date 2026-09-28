// 施工图 → 完整任务定义（PLAN.md V06-03，DESIGN.md §2.6 / §2.7 / §2.9 / §5.6）。
//
// V06-02 的 `planValidate.ts` 只做**最小结构**：把第一张合格表解析成 4 个字段的行，并回答
// "这份图纸能不能激活基线"。本文件在它上面做**完整定义解析**（DESIGN.md §2.9 的
// "V06-03 在此基础上实现完整导入与运行投影"），不改 `planValidate.ts` 一个字节。
//
// 三件事：
//   ① **区边界**（卡内检查项 1 的"声明任务与历史区/状态区边界"）。判据逐条写在下面
//      `classifyPlanRegions` 的注释里，机器可判，不靠"看标题猜"。三类：
//        · 任务定义区 = 第一张表头同时含「卡号/依赖/完成证据」的表（同一张表里**除「状态」列**以外
//          的单元格）+ 表内每个卡号对应的 `###` 卡片小节正文（**除**「**施工备注**」段与勾选位）；
//        · 派生状态区 = 那张表的「状态」列 + 卡片小节的「**施工备注**」段 + 检查项行的勾选位
//          （`- [x]` 的 x）。判据：DESIGN.md §2.6「tasks/progress 与 PLAN 标记的状态区是兼容投影」，
//          它们的唯一写入者是状态投影，因此**不进定义哈希**；
//        · 历史归档区 = 其余全部（表头缺必需列的表、标题不以表内卡号开头的小节，如
//          「历史审计项」「v0.5 历史工作包」「审计新增待办区」「附录」）。判据：它们"保留原状态、
//          已被 V06 取代"，既不进任务定义解析，也不允许被本卡的投影写回。
//   ② **完整字段**（卡内检查项 1 的"扩展完整定义解析"）。字段来源逐个写在 `importTaskDefinitions`
//      的注释里；**源文档里没有的字段一律 null 并如实列进导入报告的缺失项，不许编造**
//      （塔台自身 PLAN 没有「风险/责任角色/优先级/输入/禁止越界」段，这些一律 null）。
//   ③ **稳定 ID 与依赖口径**（V06-02 留给本卡的遗留）。卡号就是稳定 id；另给 `stableTaskKey()`
//      做跨修订匹配（大小写/空白改动不让同一个任务换身份）。依赖单元格切分后**只把"卡号形态"
//      的 token 当依赖 id**：与本表内已出现的卡号同构（字母数字加短折线，且含数字，如 `V06-03`、`T-9`），
//      或与表内某卡号逐字/忽略大小写相同；其余 token（「用户本轮授权」「施工授权」这类自然语言）
//      归 `dependency_notes`，**不算悬空依赖**——这是塔台自身 PLAN 能通过结构与依赖校验的原因。
//
// 定义哈希口径（DESIGN.md §2.6 / §2.9 硬口径）：
//   只覆盖目标、范围、依赖、接口与验收内容，**不含**派生状态（表格「状态」列）、时间戳、执行备注
//   （「施工备注」段）、勾选位与定义修订号；绑定信息（plan_revision / design_revision）也不进哈希。
//
// 补修包 C（2026-09-20）：本文件另提供 `parseIntegrationRequirements`——把施工图里的
// 「集成检查要求」小节（对象稳定 ID → 必需集成检查）读成版本化验收定义。它读的是**独立的一张表**，
// 不进上面任何一份定义哈希（施工图的内容哈希自然覆盖它），口径与理由写在那一节上方。
import crypto from "node:crypto";
import {
  describePlanIssues,
  isCardIdToken,
  isSeparatorRow,
  parsePlanTable,
  splitDependencies,
  splitTableRow,
  type PlanIssue,
  type PlanTable,
  type PlanTask,
} from "./planValidate";
import { WorkError } from "./types";

// 卡号形态判据 2026-09-21 下沉到 planValidate（激活校验与导入路径共用同一份）；此处转发再导出，旧导入方零改动。
export { CARD_ID_RE, isCardIdToken } from "./planValidate";

// ── 常量与口径 ──

/** 表内「状态」列列名（该列是派生状态区，不进定义） */
export const PLAN_COLUMN_STATE = "状态";
/** `**字段名**：值` 的字段标签（施工卡正文的段落写法） */
const FIELD_LABEL_RE = /\*\*([^*\n]{1,120})\*\*\s*[：:]/g;

/**
 * 一个 `**X**：` 匹配是不是**字段边界**（F-2 修复判据，两个满足其一）：
 *   ① 归一后在已知标签集里（允许行中字段：`**设计依据**：…。**依赖**：…。`）；或
 *   ② 处在**字段位**——所在行行首到标签之间只有空白/列表符/引用符（未知标签在段首仍是边界，旧行为保留）。
 * 两者都不是 ⇒ 是字段值内部的强调文字，不截断字段值。
 */
function isFieldLabelBoundary(paragraphText: string, matchIndex: number, label: string): boolean {
  if (KNOWN_FIELD_LABELS.has(normalizeFieldLabel(label))) return true;
  const lineStart = paragraphText.lastIndexOf("\n", matchIndex - 1) + 1;
  const prefix = paragraphText.slice(lineStart, matchIndex);
  return /^[\s>*\-–—]*$/.test(prefix);
}
/** 卡片小节标题层级（施工卡是 `### V06-03 …`） */
const CARD_HEADING_DEPTH = 3;
/** 派生状态段的字段标签（卡片小节里的「**施工备注**」文本） */
const STATE_LABEL_HINTS = ["施工备注", "备注", "状态"];

/**
 * 施工卡正文里的字段标签 → TaskDefinition 字段。
 * 塔台 PLAN 实际只用得到「设计依据 / 文件责任 / 依赖 / 契约（输入输出口径） / 交付」，
 * 其余别名是给别的项目施工图留的口径（源里没有就是 null，不编造）。
 */
export const TASK_FIELD_ALIASES: Readonly<Record<string, keyof TaskDefinition | "dependency_statement">> = {
  设计依据: "design_refs",
  文件责任: "allowed_paths",
  依赖: "dependency_statement",
  完成证据: "evidence_requirement",
  输入与依赖版本: "inputs",
  "输入/输出契约": "inputs",
  契约: "inputs",
  输入: "inputs",
  风险: "risk",
  风险等级: "risk",
  责任角色: "owner_role",
  负责人: "owner_role",
  优先级: "priority",
  禁止: "forbidden",
  禁止越界事项: "forbidden",
  禁止越界: "forbidden",
  交付: "deliverables",
};

/** 「**交付**」段拆成条目时用的分隔符（期望交付物清单） */
const DELIVERABLE_SPLIT_RE = /[；;。]\s*/;

/**
 * 已知字段标签集（字段别名键 ∪ 派生状态标签），配合 `isFieldLabelBoundary` 使用。
 * F-2（2026-09-25 终审返工）：字段值**内部**的「加粗＋全角冒号」（如「（**新追加一个小节**：…）」）
 * 不能再被当成下一个字段标签把值截断——标签要么在已知标签集里，要么处在字段位（行行首）。
 */
const KNOWN_FIELD_LABELS: ReadonlySet<string> = new Set([...Object.keys(TASK_FIELD_ALIASES), ...STATE_LABEL_HINTS]);

/** 标签形态归一：去掉尾随括注（`**施工备注（2026-09-25 …）**：` → `施工备注`）再查已知集 */
const normalizeFieldLabel = (label: string): string => label.replace(/[（(][^\n]*$/, "").trim();

// ── 定义形态（DESIGN.md §2.7 任务契约） ──

/** 一条检查项（`- [ ] x` / `- [x] x`）；`checked` 是派生位，**不进定义哈希** */
export interface TaskAcceptanceCheck {
  text: string;
  /** 原文勾选位（派生状态：施工者勾的，不是定义内容） */
  checked: boolean;
  line: number;
}

export interface TaskAcceptance {
  /** 正文检查项（`- [ ]` / `- [x]` 行，原文顺序） */
  checks: TaskAcceptanceCheck[];
  /** 「**交付**」段原文（源里没有该段时 null） */
  deliverables: string | null;
}

/** 一条依赖的输入口径：依赖 id + 它在本文档里的"完成证据要求"（依赖释放判据，DESIGN.md §5.8） */
export interface DependencyEvidence {
  dependency_id: string;
  /** 依赖卡是否在本文档的表里（false = 悬空，结构校验会点名报错） */
  present: boolean;
  /** 依赖卡的「完成证据」单元格（依赖方据此判"前置结果是否达标"，不是"前卡自报 done"） */
  evidence: string | null;
}

/** 完整任务定义（DESIGN.md §2.7 任务契约 + §2.9 的 plan_revision 绑定） */
export interface TaskDefinition {
  /** 稳定 id：施工图表格的卡号 */
  task_id: string;
  /** 跨修订匹配用的稳定键（大小写/空白改动不换身份） */
  stable_key: string;
  /** 本次变更批次（源文档没有 → null） */
  change_id: string | null;
  /** 需求 id（§2.7；源文档没有 → null） */
  requirement_ids: string[] | null;
  /** 该定义导入时的图纸修订（原文逐字节 sha256；由导入方给或现算） */
  plan_revision: string | null;
  /** 该定义绑定的设计书修订（基线给；没有就是 null） */
  design_revision: string | null;
  /** 基线 commit（非 Git 项目用内容清单哈希；源文档没有 → null） */
  base_commit: string | null;
  /** 一句话目标（表格「交付目标」列） */
  goal: string | null;
  /** 依赖的卡号（只含"卡号形态" token） */
  dependency_ids: string[];
  /** 依赖单元格里非卡号形态的 token（外部授权/前置条件），**不算悬空依赖** */
  dependency_notes: string[];
  /** 逐条依赖的输入口径（依赖卡的完成证据要求） */
  dependency_evidence: DependencyEvidence[];
  /** 输入与依赖版本口径（「**契约**／**输入/输出契约**」段原文；没有 → null） */
  inputs: string | null;
  /** 允许修改的路径/接口（「**文件责任**」段里反引号中的路径） */
  allowed_paths: string[];
  /** 禁止越界事项（「**禁止**」一类段原文；没有 → null） */
  forbidden: string | null;
  /** 验收场景与可运行方法（正文检查项 + 「**交付**」段） */
  acceptance: TaskAcceptance | null;
  /** 风险等级（源文档没有 → null） */
  risk: string | null;
  /** 期望交付物（「**交付**」段拆条；没有 → null） */
  deliverables: string[] | null;
  /** 责任角色（源文档没有 → null） */
  owner_role: string | null;
  /** 优先级（源文档没有 → null） */
  priority: string | null;
  /** 定义修订号（同一 task 的定义内容改变才 +1；不进定义哈希） */
  revision: number;
  /** 设计依据（「**设计依据**」段的章节引用） */
  design_refs: string[];
  /** 完成证据要求（表格「完成证据」列） */
  evidence_requirement: string | null;
  /** 卡片小节在原文里的行范围（1 起；没定位到小节时为 null） */
  section_lines: [number, number] | null;
  /** 表格行号（1 起） */
  row_line: number;
}

/** 导入报告（每卡一条）：缺失项、非卡号依赖、从原文取到的段 */
export interface TaskImportReportEntry {
  task_id: string;
  /** 源文档里没有、按口径填 null 的字段（如实列出，不编造） */
  missing_fields: string[];
  /** 依赖单元格里的非卡号 token（自然语言授权/前置条件） */
  dependency_notes: string[];
  /** 正文实际出现的字段标签（可追溯哪些值来自原文） */
  extracted_labels: string[];
  /** 正文「**依赖**」段原文（与表格单元格两处对账用） */
  dependency_statement: string | null;
  /** 卡片小节是否定位到（false = 只有表格行、没有正文） */
  section_found: boolean;
  /** 定义哈希（= taskDefinitionHash(definition)；进报告便于对账） */
  definition_sha256: string;
}

export interface TaskImportReport {
  /** 本表内的全部卡号（依赖判定用的"同构"基准） */
  known_ids: string[];
  /** 施工卡表起始行（没有合格表时 null） */
  table_line: number | null;
  tasks: TaskImportReportEntry[];
  /** 区边界（定义 / 状态 / 历史三类的行范围与判据） */
  regions: PlanRegionMap;
  /** 定义内容哈希（区边界 + 状态列清零后的原文 sha256；状态列/勾选位改动不改变它） */
  definition_digest: string;
}

export interface TaskImportResult {
  definitions: TaskDefinition[];
  report: TaskImportReport;
}

// ── 区边界 ──

export type PlanRegionKind = "definition" | "state" | "history";

export interface PlanRegion {
  kind: PlanRegionKind;
  /** 人类可读判据（为什么这段归这一类） */
  reason: string;
  /** 1 起的行范围（闭区间） */
  line_start: number;
  line_end: number;
  /** 这段涉及的卡号（历史区一般为空） */
  task_ids: string[];
  shape: "table" | "card_section" | "state_paragraph" | "heading_section";
}

export interface PlanRegionMap {
  regions: PlanRegion[];
  table: PlanTable | null;
  /** 表里被判为派生状态的列名（如「状态」） */
  state_columns: string[];
  /** 表里进任务定义的列名 */
  definition_columns: string[];
}

/** 表格行的结束行号（表格结束后第一行的前一行） */
function tableEndLine(lines: string[], startLine: number): number {
  let end = startLine;
  for (let i = startLine; i < lines.length; i++) {
    const text = lines[i].trim();
    if (text === "") break;
    if (!text.startsWith("|")) break;
    end = i + 1;
  }
  return end;
}

/** 标题行 → { depth, title }（`### V06-03 …`） */
function headingOf(line: string): { depth: number; title: string } | null {
  const m = /^(#{1,6})\s+(.*\S)\s*$/.exec(line);
  return m ? { depth: m[1].length, title: m[2].trim() } : null;
}

/** 卡片小节的标题是否属于某个卡号（`### V06-03 施工定义…` → V06-03） */
function cardIdOfHeading(title: string, known: Set<string>): string | null {
  const first = title.split(/\s+/)[0] ?? "";
  for (const id of known) {
    if (id !== "" && id.toLowerCase() === first.toLowerCase()) return id;
  }
  return null;
}

/**
 * 段落切分：连续非空行算一段（空行分段）。返回原文行号映射，报错能指回原文。
 */
function paragraphs(lines: string[]): { text: string; start: number; end: number }[] {
  const out: { text: string; start: number; end: number }[] = [];
  let cur: string[] = [];
  let start = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === "") {
      if (cur.length > 0) {
        out.push({ text: cur.join("\n"), start, end: i });
        cur = [];
      }
      continue;
    }
    if (cur.length === 0) start = i;
    cur.push(lines[i]);
  }
  if (cur.length > 0) out.push({ text: cur.join("\n"), start, end: lines.length });
  return out;
}

/** 卡片小节里哪些段落是派生状态段（「**施工备注**」一类） */
function isStateParagraph(text: string): boolean {
  // 标签常带很长的括注（`**施工备注（2026-09-20 交付；证据 `.工作台/…`，流水 PROGRESS 同日条）**：`），
  // 故按**前缀**正则判，不用整段等值——否则长括注的施工备注会被当成定义内容。
  if (/\*\*\s*(施工备注|备注|状态)[^*]*\*\*\s*[：:]/.test(text)) return true;
  const labels = [...text.matchAll(FIELD_LABEL_RE)].map((m) => m[1]);
  if (labels.some((l) => STATE_LABEL_HINTS.some((h) => l.includes(h)))) return true;
  // 无标签但以「备注」开头的段落同样按状态段处理（不猜内容，只按标签/前缀判）
  // V08-04：**引用块里的备注也是备注**（`> 施工备注（U2 落地时补，卡片内容未改）：…`）——
  // 引号前缀只影响排版，不影响"这是派生状态段"这件事；去掉前导 `>` 后按同一判据判
  //（标签与冒号之间的括注同样允许，与上面 `**施工备注（…）**：` 那条口径一致）。
  const stripped = text.replace(/^\s*(?:>\s*)+/, "");
  return /^\s*(备注|施工备注|状态)\s*(?:[（(][^）)\n]*[）)])?\s*[：:]/.test(stripped);
}

// ── 需求映射表（V09-03／附录 E.2-5）──

/** 映射表行的核源分类：只「当前有效」进承接映射；「历史／待核」只进登记清单，不产生 requirement_ids */
export type RequirementMapClass = "当前有效" | "历史" | "待核";

export interface RequirementMapRow {
  requirement_id: string;
  card_ids: string[];
  classification: RequirementMapClass | null;
  /** 来源列原文（可回查位置：DESIGN.md 具体位置或用户原话的可取回引用） */
  source: string;
  /** 适用范围/生效时点列原文 */
  scope_note: string;
  /** 确认度列原文（明确/推断/待确认） */
  certainty: string;
  line: number;
}

/** 映射表头判定（按列名，不靠标题名猜）：同时含「需求」「承接卡」两列的表才算 */
function requirementMapHeaderCols(
  headerLine: string,
): { req: number; cards: number; cls: number; src: number; scope: number; cert: number } | null {
  const cells = headerLine.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
  const req = cells.findIndex((c) => c.includes("需求"));
  const cards = cells.findIndex((c) => c.includes("承接卡"));
  if (req === -1 || cards === -1) return null;
  const find = (keys: string[]): number => cells.findIndex((c) => keys.some((k) => c.includes(k)));
  return {
    req,
    cards,
    cls: find(["分类"]),
    src: find(["来源"]),
    scope: find(["适用范围", "生效时点"]),
    cert: find(["确认度"]),
  };
}

/** 文档里全部需求映射表的行范围（含表头与分隔行；1-based，供区边界判定） */
function requirementMapTableRanges(lines: string[]): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  for (let i = 0; i < lines.length - 1; i++) {
    const text = (lines[i] ?? "").trim();
    if (!text.startsWith("|")) continue;
    if (requirementMapHeaderCols(text) === null) continue;
    // 下一行必须是 Markdown 分隔行（|---|），否则不当表处理
    if (!/^\|?[\s:|-]+\|?$/.test((lines[i + 1] ?? "").trim())) continue;
    let end = i + 2;
    while (end < lines.length && (lines[end] ?? "").trim().startsWith("|")) end++;
    out.push({ start: i + 1, end });
    i = end - 1;
  }
  return out;
}

/** 解析需求映射表为结构化行（多张表合并；源文档没有这张表 = 空数组，旧数据路径零改动） */
export function parseRequirementMap(markdown: string): RequirementMapRow[] {
  const lines = markdown.split(/\r?\n/);
  const rows: RequirementMapRow[] = [];
  for (const range of requirementMapTableRanges(lines)) {
    const cols = requirementMapHeaderCols(lines[range.start - 1] ?? "");
    if (cols === null) continue;
    for (let ln = range.start + 2; ln <= range.end; ln++) {
      const text = (lines[ln - 1] ?? "").trim();
      if (!text.startsWith("|")) continue;
      const cells = text.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const clsText = cols.cls >= 0 ? (cells[cols.cls] ?? "") : "";
      rows.push({
        requirement_id: (cells[cols.req] ?? "").replace(/[`$]/g, "").trim(),
        card_ids: (cells[cols.cards] ?? "")
          .split(/[、,，;；\s]+/)
          .map((s) => s.replace(/[`$]/g, "").trim())
          .filter((s) => s !== ""),
        classification: clsText.includes("当前有效")
          ? "当前有效"
          : clsText.includes("历史")
            ? "历史"
            : clsText.includes("待核")
              ? "待核"
              : null,
        source: cols.src >= 0 ? (cells[cols.src] ?? "") : "",
        scope_note: cols.scope >= 0 ? (cells[cols.scope] ?? "") : "",
        certainty: cols.cert >= 0 ? (cells[cols.cert] ?? "") : "",
        line: ln,
      });
    }
  }
  return rows;
}

/** 当前有效的承接映射：card_id → requirement_ids（「历史／待核」行不产生承接，E.2-4） */
export function requirementMapForCards(rows: readonly RequirementMapRow[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const row of rows) {
    if (row.classification !== "当前有效") continue;
    if (row.requirement_id === "") continue;
    for (const cardId of row.card_ids) {
      const list = out.get(cardId) ?? [];
      if (!list.includes(row.requirement_id)) list.push(row.requirement_id);
      out.set(cardId, list);
    }
  }
  return out;
}

/**
 * 区边界判定（卡内检查项 1）。
 *
 * 判据（逐条可复算，不靠标题名字猜）：
 *   1. 表内行 = 任务定义区（除「状态」列）——列级的派生位另记在 `state_columns`；
 *   2. 标题首个 token 等于表内某卡号的小节 = 任务定义区；小节内带「施工备注/备注/状态」标签的
 *      段落 = 派生状态区；
 *   2′. **需求映射表**（V09-03／附录 E.2-5：表头同时含「需求」「承接卡」列的表）= 任务定义区——
 *      改映射改变施工定义哈希，被承接卡的任务定义哈希也随之变（`requirement_ids` 进 canonical）；
 *   3. 其它表（表头不同时含「卡号/依赖/完成证据」、也非需求映射表）= 历史归档区（解析器不读）；
 *   4. 标题不以表内卡号开头的小节（约定/历史/出口/附录）= 历史归档区。
 */
export function classifyPlanRegions(markdown: string): PlanRegionMap {
  const lines = markdown.split(/\r?\n/);
  const table = parsePlanTable(markdown);
  const knownIds = new Set(table?.rows.map((r) => r.id).filter((id) => id !== "") ?? []);
  const regions: PlanRegion[] = [];
  const tableStart = table?.start_line ?? -1;
  const tableEnd = table === null ? -1 : tableEndLine(lines, tableStart);

  const state_columns: string[] = [];
  const definition_columns: string[] = [];
  if (table !== null) {
    for (const col of table.header) {
      (col.includes(PLAN_COLUMN_STATE) ? state_columns : definition_columns).push(col);
    }
    regions.push({
      kind: "definition",
      reason: `第一张表头同时含「卡号」「依赖」「完成证据」的表：除「${PLAN_COLUMN_STATE}」列以外的单元格即任务定义`,
      line_start: tableStart,
      line_end: tableEnd,
      task_ids: [...knownIds],
      shape: "table",
    });
  }

  // V09-03：需求映射表进定义区（判据 2′）——按表头列名识别（同时含「需求」「承接卡」），不靠标题名猜。
  // 只影响「定义区包含哪些行」；任务定义仍只从第一张卡表解析（parsePlanTable 不变）。
  for (const range of requirementMapTableRanges(lines)) {
    regions.push({
      kind: "definition",
      reason: "需求映射表（表头同时含「需求」「承接卡」列）：进施工定义区——改映射改变施工定义哈希，被承接卡重新受检（附录 E.2-5）",
      line_start: range.start,
      line_end: range.end,
      task_ids: [],
      shape: "table",
    });
  }

  // 卡片小节：行范围 = 本 `###` 到下一个层级 <= 3 的标题前
  const headings: { line: number; depth: number; title: string }[] = [];
  lines.forEach((l, i) => {
    const h = headingOf(l);
    if (h !== null) headings.push({ line: i + 1, depth: h.depth, title: h.title });
  });

  let coveredFrom = 1;
  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];
    if (h.depth !== CARD_HEADING_DEPTH) continue;
    const id = cardIdOfHeading(h.title, knownIds);
    if (id === null) continue;
    let end = lines.length;
    for (let j = i + 1; j < headings.length; j++) {
      if (headings[j].depth <= CARD_HEADING_DEPTH) {
        end = headings[j].line - 1;
        break;
      }
    }
    const sectionLines = lines.slice(h.line, end);
    const stateRanges: [number, number][] = [];
    for (const p of paragraphs(sectionLines)) {
      if (!isStateParagraph(p.text)) continue;
      stateRanges.push([h.line + p.start, h.line + p.end]);
    }
    // 定义区 = 小节减状态段；状态段逐段登记（两段的行范围不重叠，可复算）
    let cursor = h.line;
    for (const [s, e] of stateRanges) {
      if (cursor <= s - 1) {
        regions.push({
          kind: "definition",
          reason: `卡片小节 \`${id}\` 正文（标题首 token 等于表内卡号）：定义区；已剔除「施工备注」等派生段`,
          line_start: cursor,
          line_end: s - 1,
          task_ids: [id],
          shape: "card_section",
        });
      }
      regions.push({
        kind: "state",
        reason: `卡片 \`${id}\` 的「施工备注」类段落：派生状态区（DESIGN.md §2.6 的兼容投影，唯一写入者是状态投影）`,
        line_start: s,
        line_end: e,
        task_ids: [id],
        shape: "state_paragraph",
      });
      cursor = e + 1;
    }
    if (cursor <= end) {
      regions.push({
        kind: "definition",
        reason: `卡片小节 \`${id}\` 正文（标题首 token 等于表内卡号）：定义区`,
        line_start: cursor,
        line_end: end,
        task_ids: [id],
        shape: "card_section",
      });
    }
    if (end > coveredFrom) coveredFrom = end;
  }

  // 其余行 = 历史归档区（逐段登记：表头缺必需列的表 / 非卡号标题的小节 / 前言）
  const inDefinition = (line: number): boolean =>
    regions.some((r) => r.kind === "definition" && line >= r.line_start && line <= r.line_end);
  const inState = (line: number): boolean =>
    regions.some((r) => r.kind === "state" && line >= r.line_start && line <= r.line_end);
  let runStart = -1;
  let runReason = "";
  let runShape: PlanRegion["shape"] = "heading_section";
  const flush = (endLine: number) => {
    if (runStart === -1) return;
    regions.push({
      kind: "history",
      reason: runReason,
      line_start: runStart,
      line_end: endLine,
      task_ids: [],
      shape: runShape,
    });
    runStart = -1;
  };
  for (let i = 1; i <= lines.length; i++) {
    const text = (lines[i - 1] ?? "").trim();
    if (inDefinition(i) || inState(i)) {
      flush(i - 1);
      continue;
    }
    const isTableRow = text.startsWith("|");
    const reason = isTableRow
      ? "表头不同时含「卡号/依赖/完成证据」的表：历史归档区（保留原状态，不进任务定义解析）"
      : "标题不以表内卡号开头（约定/历史/出口/附录）或前言：历史归档区";
    const shape: PlanRegion["shape"] = isTableRow ? "table" : "heading_section";
    if (runStart !== -1 && (runReason !== reason || runShape !== shape)) flush(i - 1);
    if (runStart === -1) {
      runStart = i;
      runReason = reason;
      runShape = shape;
    }
  }
  flush(lines.length);

  regions.sort((a, b) => a.line_start - b.line_start || a.line_end - b.line_end);
  return { regions, table, state_columns, definition_columns };
}

/**
 * 定义区原文（区边界 + 状态列清零 + 勾选位归一）：把「定义内容」这件事落成一段可比对的文本。
 * 用途：`definition_digest` 让"改状态列/改施工备注/改勾选位都不动定义"这句话可以被直接断言。
 */
export function definitionOnlyText(markdown: string, map = classifyPlanRegions(markdown)): string {
  const lines = markdown.split(/\r?\n/);
  const table = map.table;
  const stateCols = new Set<number>();
  if (table !== null) {
    const header = table.header;
    header.forEach((col, idx) => {
      if (col.includes(PLAN_COLUMN_STATE)) stateCols.add(idx);
    });
  }
  const out: string[] = [];
  for (const region of map.regions) {
    if (region.kind !== "definition") continue;
    for (let i = region.line_start; i <= region.line_end; i++) {
      let text = lines[i - 1] ?? "";
      if (region.shape === "table" && stateCols.size > 0 && text.trim().startsWith("|")) {
        const cells = text.trim().slice(1, -1).split("|");
        for (const col of stateCols) {
          if (col < cells.length) cells[col] = " ";
        }
        text = `|${cells.join("|")}|`;
      }
      // 勾选位归一（勾没勾是派生状态，不是定义内容）
      text = text.replace(/^(\s*[-*]\s*)\[[xX ]\]/, "$1[ ]");
      out.push(text);
    }
  }
  return out.join("\n");
}

/** 定义内容哈希（区边界 + 状态列清零 + 勾选位归一后的 sha256） */
export function planDefinitionDigest(markdown: string): string {
  return sha256Hex(definitionOnlyText(markdown));
}

// ── 字段抽取 ──

export const sha256Hex = (data: string | Buffer): string =>
  crypto.createHash("sha256").update(data).digest("hex");

/** 稳定键：跨修订匹配（大小写/空白差异不换身份） */
export function stableTaskKey(taskId: string): string {
  return taskId.trim().toUpperCase();
}

/** 依赖单元格 → { ids, notes }（切分口径沿用 planValidate.splitDependencies，id/备注判据 isCardIdToken 同源） */
export function splitDependencyCell(
  cell: string,
  known: ReadonlySet<string>,
): { ids: string[]; notes: string[] } {
  const ids: string[] = [];
  const notes: string[] = [];
  for (const token of splitDependencies(cell)) {
    if (isCardIdToken(token, known)) {
      if (!ids.includes(token)) ids.push(token);
      continue;
    }
    if (!notes.includes(token)) notes.push(token);
  }
  return { ids, notes };
}

/** `**设计依据**：§2.6–§2.9、§5.4、§5.8。` → ["§2.6–§2.9","§5.4","§5.8"] */
function splitRefs(value: string): string[] {
  const head = value.split("\n")[0].replace(/。\s*$/, "");
  // F-3（2026-09-25 终审返工）：括号感知的切分——（）()/「」/【】/《》/[] **内部**的 、，,;；
  // 不再当分隔符（此前「附录 E.2（**第 3/4 条：逐条核源＋分类、只登记「当前有效」**）」被切成两条碎片，
  // 碎片再被误报成「定位不到的设计依据」）。括号不闭合时按保守处理：余下不再切（不硬拆）。
  const OPEN = new Set(["（", "(", "【", "「", "《", "["]);
  const CLOSE = new Set(["）", ")", "】", "」", "》", "]"]);
  const SPLIT = new Set(["、", ",", "，", ";", "；"]);
  const parts: string[] = [];
  let cur = "";
  let depth = 0;
  for (const ch of head) {
    if (OPEN.has(ch)) depth += 1;
    else if (CLOSE.has(ch) && depth > 0) depth -= 1;
    if (SPLIT.has(ch) && depth === 0) {
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  parts.push(cur);
  return parts.map((s) => s.trim()).filter((s) => s !== "");
}

/** 反引号里的路径（`src/server/work/{plan,tasks,migrate}.ts`、`templates/.工作台.example/`） */
function backtickedPaths(value: string): string[] {
  const out: string[] = [];
  for (const m of value.matchAll(/`([^`\n]+)`/g)) {
    const token = m[1].trim();
    const looksLikePath = token.includes("/") || /\.[A-Za-z0-9]{1,6}$/.test(token);
    if (looksLikePath && !out.includes(token)) out.push(token);
  }
  return out;
}

interface FieldHit {
  label: string;
  value: string;
  line: number;
  paragraph: string;
}

/** 段落里抽 `**标签**：值`（同一行可以有多个标签：`**设计依据**：…。**依赖**：…。`） */
function fieldsInParagraph(p: { text: string; start: number; end: number }, baseLine: number): FieldHit[] {
  const hits: (FieldHit & { at: number; valueStart: number })[] = [];
  for (const m of p.text.matchAll(FIELD_LABEL_RE)) {
    // F-2：不是字段边界的「加粗＋冒号」（字段值内部的强调文字）直接跳过，不参与切值
    if (!isFieldLabelBoundary(p.text, m.index ?? 0, m[1])) continue;
    hits.push({
      label: m[1].trim(),
      value: "",
      at: m.index ?? 0,
      valueStart: (m.index ?? 0) + m[0].length,
      line: baseLine + p.start + p.text.slice(0, m.index ?? 0).split("\n").length - 1,
      paragraph: p.text,
    });
  }
  hits.sort((a, b) => a.at - b.at);
  for (let i = 0; i < hits.length; i++) {
    const end = i + 1 < hits.length ? hits[i + 1].at : p.text.length;
    hits[i].value = p.text.slice(hits[i].valueStart, end).trim();
  }
  return hits.map(({ label, value, line, paragraph }) => ({ label, value, line, paragraph }));
}

/** 卡片小节（标题行 + 正文行 + 定义/状态分区） */
interface CardSection {
  task_id: string;
  title: string;
  line_start: number;
  line_end: number;
  /** 定义区行号集合（1 起） */
  definition_lines: Set<number>;
  /** 状态区行号集合（1 起） */
  state_lines: Set<number>;
}

function cardSections(markdown: string, map: PlanRegionMap): Map<string, CardSection> {
  const lines = markdown.split(/\r?\n/);
  const out = new Map<string, CardSection>();
  for (const region of map.regions) {
    if (region.shape !== "card_section") continue;
    const id = region.task_ids[0];
    if (id === undefined) continue;
    const existing = out.get(id);
    const headingLine = lines[region.line_start - 1] ?? "";
    const section: CardSection =
      existing ??
      {
        task_id: id,
        title: headingOf(headingLine)?.title ?? id,
        line_start: region.line_start,
        line_end: region.line_end,
        definition_lines: new Set<number>(),
        state_lines: new Set<number>(),
      };
    for (let i = region.line_start; i <= region.line_end; i++) section.definition_lines.add(i);
    if (region.line_end > section.line_end) section.line_end = region.line_end;
    if (region.line_start < section.line_start) section.line_start = region.line_start;
    out.set(id, section);
  }
  for (const region of map.regions) {
    if (region.shape !== "state_paragraph") continue;
    const id = region.task_ids[0];
    if (id === undefined) continue;
    const section = out.get(id);
    if (!section) continue;
    for (let i = region.line_start; i <= region.line_end; i++) section.state_lines.add(i);
  }
  return out;
}

// ── 导入 ──

export interface ImportTaskOptions {
  /** 该文档的修订标识（原文逐字节 sha256）；不给就现算 */
  plan_revision?: string;
  /** 绑定的设计书修订（基线给） */
  design_revision?: string | null;
  /** 变更批次（外部批次 id）；源文档里没有该字段时只能用调用方给的 */
  change_id?: string | null;
  /**
   * 每个任务关联的需求 id（§2.7 任务契约的 `requirement_ids`；T21/I-1 起才可能非 null）。
   * 缺省不给 = 每个任务的 `requirement_ids` 仍是 **null**（旧数据路径，行为零改动）；
   * 给了的卡按调用方给的值填，调用方负责让它们能在投影里解析（`references.ts` 的悬空校验）。
   */
  requirement_ids?: Readonly<Record<string, string[]>>;
  /** 每个任务的定义修订号（同一内容重导保持原号；内容变了由调用方 +1） */
  revisions?: Readonly<Record<string, number>>;
}

/**
 * 把施工图文档导入成完整任务定义。
 *
 * 字段来源（卡面口径逐条落实）：
 *   · `task_id`      = 表格「卡号」列
 *   · `goal`         = 表格「交付目标」列
 *   · `evidence_requirement` = 表格「完成证据」列
 *   · `dependency_ids` / `dependency_notes` = 表格「依赖」列切分后的卡号 token / 其余 token
 *   · `design_refs`  = 正文「**设计依据**」段
 *   · `allowed_paths`= 正文「**文件责任**」段里反引号中的路径
 *   · `acceptance`   = 正文检查项（`- [ ]`/`- [x]` 行）+「**交付**」段
 *   · `plan_revision`= 该文档修订的内容哈希
 *   · 其余（`change_id` / `requirement_ids` / `base_commit` / `design_revision` / `inputs` /
 *     `forbidden` / `risk` / `owner_role` / `priority`）= 源文档/调用方都没给就是 **null**，
 *     并逐条进 `report.tasks[].missing_fields`——不编造、不用默认值冒充。
 */
export function importTaskDefinitions(markdown: string, options: ImportTaskOptions = {}): TaskImportResult {
  const map = classifyPlanRegions(markdown);
  const lines = markdown.split(/\r?\n/);
  const table = map.table;
  const rows: PlanTask[] = table?.rows ?? [];
  const known = new Set(rows.map((r) => r.id));
  // V09-03：需求映射表（若存在）是 requirement_ids 的施工图内来源——与卡表同一份文档、同一解析时机；
  // 调用方显式给的值优先（旧调用方行为零改动），映射表次之，都没有仍是 null（不编造）
  const mapReqIds = requirementMapForCards(parseRequirementMap(markdown));
  const sections = cardSections(markdown, map);
  const evidenceById = new Map(rows.map((r) => [r.id, r.evidence]));
  const planRevision = options.plan_revision ?? sha256Hex(markdown);

  const definitions: TaskDefinition[] = [];
  const reportEntries: TaskImportReportEntry[] = [];

  for (const row of rows) {
    const section = sections.get(row.id) ?? null;
    const hits: FieldHit[] = [];
    if (section !== null) {
      // 只吃**定义区**行：状态段（施工备注）与勾选位不进字段抽取
      const defLines = lines
        .map((text, i) => ({ no: i + 1, text }))
        .filter(({ no }) => section.definition_lines.has(no) && !section.state_lines.has(no));
      const base = defLines.length > 0 ? defLines[0].no : 1;
      for (const p of paragraphs(defLines.map((d) => d.text))) hits.push(...fieldsInParagraph(p, base));
    }
    const byField = new Map<string, FieldHit>();
    for (const hit of hits) {
      const target = TASK_FIELD_ALIASES[hit.label];
      if (target !== undefined && !byField.has(target)) byField.set(target, hit);
    }

    const dep = splitDependencyCell(row.dependencies.join("、"), known);
    const dependency_evidence: DependencyEvidence[] = dep.ids.map((id) => ({
      dependency_id: id,
      present: known.has(id),
      evidence: evidenceById.get(id) ?? null,
    }));

    const deliverableText = byField.get("deliverables")?.value ?? null;
    const deliverables =
      deliverableText === null
        ? null
        : deliverableText
            .split(DELIVERABLE_SPLIT_RE)
            .map((s) => s.trim())
            .filter((s) => s !== "");

    const checks: TaskAcceptanceCheck[] = [];
    if (section !== null) {
      for (let i = section.line_start; i <= section.line_end; i++) {
        if (section.state_lines.has(i)) continue;
        const m = /^\s*[-*]\s*\[([xX ])\]\s*(.*\S)?\s*$/.exec(lines[i - 1] ?? "");
        if (m === null) continue;
        checks.push({ text: (m[2] ?? "").trim(), checked: m[1].toLowerCase() === "x", line: i });
      }
    }
    const acceptance: TaskAcceptance | null =
      checks.length === 0 && deliverableText === null
        ? null
        : { checks, deliverables: deliverableText };

    const limitHit = byField.get("forbidden");
    const def: TaskDefinition = {
      task_id: row.id,
      stable_key: stableTaskKey(row.id),
      change_id: options.change_id ?? null,
      // 缺省仍是 null：不给关联就是"源文档/调用方都没给"，如实留空，不用空数组冒充（旧数据路径零改动）；
      // V09-03：调用方没给时回落到施工图内的需求映射表（只「当前有效」行承接）
      requirement_ids: options.requirement_ids?.[row.id] ?? mapReqIds.get(row.id) ?? null,
      plan_revision: planRevision,
      design_revision: options.design_revision ?? null,
      base_commit: null,
      goal: row.goal === "" ? null : row.goal,
      dependency_ids: dep.ids,
      dependency_notes: dep.notes,
      dependency_evidence,
      inputs: byField.get("inputs")?.value ?? null,
      allowed_paths: byField.get("allowed_paths") ? backtickedPaths(byField.get("allowed_paths")!.value) : [],
      forbidden: limitHit?.value ?? null,
      acceptance,
      risk: byField.get("risk")?.value ?? null,
      deliverables,
      owner_role: byField.get("owner_role")?.value ?? null,
      priority: byField.get("priority")?.value ?? null,
      revision: options.revisions?.[row.id] ?? 1,
      design_refs: byField.get("design_refs") ? splitRefs(byField.get("design_refs")!.value) : [],
      evidence_requirement: row.evidence === "" ? null : row.evidence,
      section_lines: section === null ? null : [section.line_start, section.line_end],
      row_line: row.row,
    };
    definitions.push(def);

    const missing: string[] = [];
    const isMissing = (v: unknown): boolean =>
      v === null || v === undefined || (typeof v === "string" && v.trim() === "") || (Array.isArray(v) && v.length === 0);
    const scalarFields: [string, unknown][] = [
      ["change_id", def.change_id],
      ["requirement_ids", def.requirement_ids],
      ["design_revision", def.design_revision],
      ["base_commit", def.base_commit],
      ["goal", def.goal],
      ["inputs", def.inputs],
      ["allowed_paths", def.allowed_paths],
      ["forbidden", def.forbidden],
      ["acceptance", def.acceptance],
      ["risk", def.risk],
      ["deliverables", def.deliverables],
      ["owner_role", def.owner_role],
      ["priority", def.priority],
      ["design_refs", def.design_refs],
      ["evidence_requirement", def.evidence_requirement],
    ];
    for (const [name, value] of scalarFields) {
      if (isMissing(value)) missing.push(name);
    }
    // 检查项为空但「交付」段在时不算缺验收（验收由两处其一表达）
    if (def.acceptance !== null && def.acceptance.checks.length === 0) missing.push("acceptance.checks");

    reportEntries.push({
      task_id: row.id,
      missing_fields: missing,
      dependency_notes: dep.notes,
      extracted_labels: [...new Set(hits.map((h) => h.label))],
      dependency_statement: byField.get("dependency_statement")?.value ?? null,
      section_found: section !== null,
      definition_sha256: taskDefinitionHash(def),
    });
  }

  return {
    definitions,
    report: {
      known_ids: [...known],
      table_line: table?.start_line ?? null,
      tasks: reportEntries,
      regions: map,
      definition_digest: planDefinitionDigest(markdown),
    },
  };
}

// ── 定义哈希（不含派生状态） ──

// 2026-09-27：单卡定义哈希的实现下沉到 `src/shared/planCardHash.ts`（浏览器安全的纯函数，
// 零 node import）——蓝图派生/校验侧与状态投影层要按**单卡**判 stale，两边都得用同一份实现
// （§一事一源），留在本文件会把 `node:crypto`/`node:fs` 那条链拉进纯解析侧与浏览器包。
// 取值口径一个字节都没变（canonical 键序与原实现逐字相同）；此处**转发再导出**，旧导入方零改动。
export { taskDefinitionHash, definitionCanonical, type PlanCardDefinitionLike } from "../../shared/planCardHash";
import { taskDefinitionHash, definitionCanonical } from "../../shared/planCardHash";

// ── 校验（卡内检查项 1：重复 ID、悬空依赖、循环依赖、缺验收要求都要点名 id） ──

/**
 * 在**完整定义**上做结构校验（V06-02 `validatePlanTasks` 的扩展口径）：
 *   ① 重复 id：逐字重复，或稳定键（去空白、忽略大小写）相同——两种都点名，避免"改个大小写就多出一张卡"；
 *   ② 悬空依赖：`dependency_ids` 里的 id 不在本表内（非卡号 token 已归 dependency_notes，**不算悬空**）；
 *   ③ 依赖成环：只算本表内的边，报一个具体环路径；
 *   ④ 缺验收要求：交付目标或完成证据为空。
 */
export function validateTaskDefinitions(definitions: TaskDefinition[], tableFound = true): PlanIssue[] {
  const issues: PlanIssue[] = [];
  if (!tableFound) {
    return [{ problem: "no_table", ids: [], detail: "没有找到表头同时含「卡号」「依赖」「完成证据」的 Markdown 表" }];
  }
  if (definitions.length === 0) {
    return [{ problem: "empty_table", ids: [], detail: "施工卡表存在但一行任务都没有" }];
  }

  const emptyIds = definitions.filter((d) => d.task_id === "").map((d) => d.row_line);
  if (emptyIds.length > 0) {
    issues.push({ problem: "empty_id", ids: [""], detail: `卡号列为空的行：${emptyIds.join("、")}` });
  }

  const byStable = new Map<string, TaskDefinition[]>();
  for (const d of definitions) {
    const list = byStable.get(d.stable_key) ?? [];
    list.push(d);
    byStable.set(d.stable_key, list);
  }
  const dup = [...byStable.entries()].filter(([, list]) => list.length > 1);
  if (dup.length > 0) {
    issues.push({
      problem: "duplicate_id",
      // 点名**全部**原样写法（`T-1` 与 `t-1` 都要出现），否则"换大小写换身份"这件事看不出来
      ids: [...new Set(dup.flatMap(([, list]) => list.map((d) => d.task_id)))].sort(),
      detail: dup
        .map(([, list]) => `${list.map((d) => d.task_id).join(" / ")}（行 ${list.map((d) => d.row_line).join("、")}）`)
        .join("；"),
    });
  }

  const known = new Set(definitions.map((d) => d.task_id));
  const dangling = new Map<string, string[]>();
  for (const d of definitions) {
    for (const dep of d.dependency_ids) {
      if (known.has(dep)) continue;
      const who = dangling.get(dep) ?? [];
      who.push(d.task_id);
      dangling.set(dep, who);
    }
  }
  if (dangling.size > 0) {
    issues.push({
      problem: "dangling_dependency",
      ids: [...dangling.keys()].sort(),
      detail: [...dangling.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([dep, who]) => `${dep}（被 ${[...new Set(who)].join("、")} 依赖，本表内不存在）`)
        .join("；"),
    });
  }

  const deps = new Map<string, string[]>();
  for (const d of definitions) deps.set(d.task_id, d.dependency_ids.filter((x) => known.has(x)));
  const cycles = findCycles([...known].filter((id) => id !== ""), deps);
  if (cycles.ids.size > 0) {
    issues.push({
      problem: "dependency_cycle",
      ids: [...cycles.ids].sort(),
      detail: `成环：${cycles.example.join(" → ")}${
        cycles.ids.size > cycles.example.length - 1 ? `（共 ${cycles.ids.size} 个 id 在环上）` : ""
      }`,
    });
  }

  const missing = definitions.filter((d) => d.goal === null || d.evidence_requirement === null);
  if (missing.length > 0) {
    issues.push({
      problem: "missing_acceptance",
      ids: missing.map((d) => d.task_id),
      detail: missing
        .map((d) => {
          const what = [d.goal === null ? "交付目标" : null, d.evidence_requirement === null ? "完成证据" : null]
            .filter((x): x is string => x !== null)
            .join("/");
          return `${d.task_id || `(行 ${d.row_line} 无卡号)`} 缺 ${what}`;
        })
        .join("；"),
    });
  }
  return issues;
}

/** 找环上的 id（与 `planValidate` 同口径：只走本表内的边，悬空依赖不参与成环判定） */
function findCycles(ids: string[], deps: Map<string, string[]>): { ids: Set<string>; example: string[] } {
  const inCycle = new Set<string>();
  let example: string[] = [];
  for (const start of ids) {
    const stack: { id: string; path: string[] }[] = [{ id: start, path: [start] }];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const { id, path } = stack.pop()!;
      for (const next of deps.get(id) ?? []) {
        if (next === start) {
          const cycle = [...path, start];
          for (const n of path) inCycle.add(n);
          if (example.length === 0 || cycle.length < example.length) example = cycle;
          continue;
        }
        if (seen.has(next) || !deps.has(next)) continue;
        seen.add(next);
        stack.push({ id: next, path: [...path, next] });
      }
    }
  }
  return { ids: inCycle, example };
}

/** 校验不通过即抛 `INVALID_COMMAND`（点名 id，带全部问题）；通过则静默返回 */
export function assertTaskDefinitionsValid(
  definitions: TaskDefinition[],
  source: string,
  tableFound = true,
): void {
  const issues = validateTaskDefinitions(definitions, tableFound);
  if (issues.length === 0) return;
  throw new WorkError(
    "INVALID_COMMAND",
    `施工定义校验不通过（${source}）：${describePlanIssues(issues)}`,
    { source, issues },
  );
}

// ── 跨修订对齐（定义 ↔ 运行任务同源） ──

export interface TaskRevisionChange {
  task_id: string;
  change: "added" | "removed" | "definition_changed" | "unchanged";
  before_sha256: string | null;
  after_sha256: string | null;
  /** 变化落在哪些字段（可读，便于人工复核） */
  changed_fields: string[];
}

/**
 * 比较两份导入结果（同一任务按 `stable_key` 对齐）：
 *   · `added` / `removed`：任务增删；
 *   · `definition_changed`：定义内容变了（列出的字段名来自定义规范化内容的差集）；
 *   · `unchanged`：定义内容一致（**状态列/施工备注/勾选位变化落在这里**——它们不进定义哈希）。
 */
export function diffTaskDefinitions(
  before: TaskDefinition[],
  after: TaskDefinition[],
): TaskRevisionChange[] {
  const beforeByKey = new Map(before.map((d) => [d.stable_key, d]));
  const afterByKey = new Map(after.map((d) => [d.stable_key, d]));
  const out: TaskRevisionChange[] = [];
  for (const [key, b] of beforeByKey) {
    const a = afterByKey.get(key);
    if (a === undefined) {
      out.push({
        task_id: b.task_id,
        change: "removed",
        before_sha256: taskDefinitionHash(b),
        after_sha256: null,
        changed_fields: [],
      });
      continue;
    }
    const bs = taskDefinitionHash(b);
    const as = taskDefinitionHash(a);
    out.push({
      task_id: a.task_id,
      change: bs === as ? "unchanged" : "definition_changed",
      before_sha256: bs,
      after_sha256: as,
      changed_fields: bs === as ? [] : diffFieldNames(b, a),
    });
  }
  for (const [key, a] of afterByKey) {
    if (beforeByKey.has(key)) continue;
    out.push({
      task_id: a.task_id,
      change: "added",
      before_sha256: null,
      after_sha256: taskDefinitionHash(a),
      changed_fields: [],
    });
  }
  return out.sort((x, y) => x.task_id.localeCompare(y.task_id));
}

/** 两个定义在哪些字段上不同（只报定义内容字段） */
function diffFieldNames(before: TaskDefinition, after: TaskDefinition): string[] {
  const b = definitionCanonical(before) as Record<string, unknown>;
  const a = definitionCanonical(after) as Record<string, unknown>;
  return Object.keys(b).filter((k) => JSON.stringify(b[k]) !== JSON.stringify(a[k]));
}

// ── 集成检查要求（补修包 C / V06-09 主责，V06-06 联验） ──
//
// **"需要哪些集成检查"是版本化验收定义，不是调用方的一次声明**（DESIGN.md §2.9 + §4.2）：
// 由设计角色写在**施工图**里，落在对象稳定 ID 上，随这份施工图的修订一起进入不可变修订与基线。
//
// 落点判据（为什么单独一张表，而不是塞进卡定义）：
//   · 需要自身集成检查的父级是 `module:<模块>` / 能力这类**非卡号对象**，施工卡表的「卡号」列
//     根本指不到它们——硬塞进卡定义只能靠"名字像"猜；
//   · 施工卡表由 V06-02 的口径读（第一张同时含「卡号/依赖/完成证据」的表），本表**不是**那张表，
//     故不改变 `parsePlanTable` / `definitionHashOf` / `taskDefinitionHash` 的任何一位；
//   · 本小节落在 `classifyPlanRegions` 的**历史归档区**（标题首 token 不是表内卡号），
//     也不进 `planDefinitionDigest`——施工图的内容哈希（`content_sha256`，检查证据绑定的那一版）
//     把它一起覆盖：改了这张表 = 施工图换了一版 = 旧证据自动过期（不默认通过）。
//
// 结构问题（缺列 / 空对象 ID / 空检查 ID / 同对象下重复检查 ID）**如实登记在 `issues` 里**，
// 由读侧决定"不据此判绿"——绝不静默当成"没有要求"。

/** 小节标题里出现这个词才算「集成检查要求」那一节（避免误吃别人的表） */
export const INTEGRATION_REQUIREMENT_HEADING_HINT = "集成检查要求";
/** 表头必须同时含这两个列名（归一后比对：去反引号/星号/空白，忽略大小写） */
export const INTEGRATION_REQUIREMENT_COLUMNS = ["对象ID", "检查ID"] as const;
/** 「必需性」列里算"可选"的写法（其余一律按**必需**——不明说的都算必需，DefaultDeny） */
const OPTIONAL_HINTS = ["可选", "选做", "非必需", "optional", "no"];

export interface IntegrationRequirementRow {
  /** 目标对象稳定 ID（跨修订不变；如 `module:paint`、`module:a->module:b::integration`） */
  object_id: string;
  /** 检查 ID（检查结果事件按它归属） */
  check_id: string;
  /** 说明（人话；缺省 = 检查 ID） */
  label: string;
  /** 必需性：`false` 只来自明确的「可选」写法 */
  required: boolean;
  /** 原文行号（1 起） */
  line: number;
}

export interface IntegrationRequirementSet {
  /** 施工图里有没有这一节（false = 设计角色没有声明任何集成检查要求） */
  declared: boolean;
  /** 该节的行范围（1 起，闭区间）；没找到时 null */
  section_lines: [number, number] | null;
  /** 表头原文（归一前的单元格） */
  columns: string[];
  rows: IntegrationRequirementRow[];
  /** 结构问题（不静默当"没有要求"） */
  issues: string[];
}

/** 表头单元格归一（与 `planValidate` 同一口径：去反引号/星号/空白） */
const normalizeColumn = (text: string): string => text.replace(/[`*\s]/g, "").toLowerCase();

/** 数据单元格取值（去反引号/星号，保留内部空白） */
const cellValue = (text: string): string => text.replace(/[`*]/g, "").trim();

/**
 * 解析施工图里的「集成检查要求」小节。
 * 找不到该小节 → `declared: false`（这不是错误：没声明就是没声明）；找到但没有合格表 → 记 `issues`。
 */
export function parseIntegrationRequirements(markdown: string): IntegrationRequirementSet {
  const empty: IntegrationRequirementSet = {
    declared: false,
    section_lines: null,
    columns: [],
    rows: [],
    issues: [],
  };
  const lines = markdown.split(/\r?\n/);
  const hint = INTEGRATION_REQUIREMENT_HEADING_HINT;
  let start = -1;
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const h = headingOf(lines[i]);
    if (h === null || !h.title.includes(hint)) continue;
    start = i;
    depth = h.depth;
    break;
  }
  if (start === -1) return empty;

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const h = headingOf(lines[i]);
    if (h !== null && h.depth <= depth) {
      end = i; // 下一个同级或更高级标题前（0 起，含本行前一行为止）
      break;
    }
  }
  // 小节里第一张表：某行是表头且下一行是分隔行
  let tableAt = -1;
  for (let i = start + 1; i < end; i++) {
    if (splitTableRow(lines[i]) === null) continue;
    if (!isSeparatorRow(lines[i + 1] ?? "")) continue;
    tableAt = i;
    break;
  }
  const sectionLines: [number, number] = [start + 1, end];
  if (tableAt === -1) {
    return {
      declared: true,
      section_lines: sectionLines,
      columns: [],
      rows: [],
      issues: [`「${hint}」小节里没有找到带分隔行的 Markdown 表（表格格式不对，读不出任何要求）`],
    };
  }

  const header = splitTableRow(lines[tableAt]) ?? [];
  const normalized = header.map(normalizeColumn);
  const colOf = (name: string): number => normalized.indexOf(name);
  const issues: string[] = [];
  const missingCols = INTEGRATION_REQUIREMENT_COLUMNS.filter((c) => colOf(normalizeColumn(c)) === -1);
  if (missingCols.length > 0) {
    issues.push(
      `「${hint}」表缺列：${missingCols.join("、")}（表头实际为 ${header.join(" | ")}）——缺列就等于读不出要求，不静默当"没有"`,
    );
    return { declared: true, section_lines: sectionLines, columns: header, rows: [], issues };
  }
  const objectCol = colOf("对象id");
  const checkCol = colOf("检查id");
  const labelCol = colOf("说明");
  const requiredCol = colOf("必需性");

  const rows: IntegrationRequirementRow[] = [];
  const seen = new Set<string>();
  for (let i = tableAt + 2; i < end; i++) {
    const cells = splitTableRow(lines[i]);
    if (cells === null) break; // 表格结束
    if (isSeparatorRow(lines[i])) continue;
    const at = (idx: number): string => (idx >= 0 && idx < cells.length ? cellValue(cells[idx] ?? "") : "");
    const objectId = at(objectCol);
    const checkId = at(checkCol);
    const line = i + 1;
    if (objectId === "" || checkId === "") {
      issues.push(
        `第 ${line} 行缺${objectId === "" ? "对象 ID" : "检查 ID"}：这一行不是一条可判定的要求，如实报出（不猜成别的对象）`,
      );
      continue;
    }
    const key = `${objectId}\u0000${checkId}`;
    if (seen.has(key)) {
      issues.push(`第 ${line} 行重复：同一个对象 ${objectId} 下的检查 ${checkId} 已经声明过一次（同一条要求只该写一行）`);
      continue;
    }
    seen.add(key);
    const requiredText = at(requiredCol).toLowerCase();
    const explicitlyOptional = requiredText !== "" && OPTIONAL_HINTS.some((h) => requiredText.includes(h));
    rows.push({
      object_id: objectId,
      check_id: checkId,
      label: at(labelCol) === "" ? checkId : at(labelCol),
      // 不明说的都算必需（DefaultDeny）：只有明确写「可选」才降级
      required: !explicitlyOptional,
      line,
    });
  }
  if (rows.length === 0 && issues.length === 0) {
    issues.push(`「${hint}」表里一条要求都没有（空表不等于"没有集成检查要求"，如实报出）`);
  }
  return { declared: true, section_lines: sectionLines, columns: header, rows, issues };
}
