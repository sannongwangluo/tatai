// A5：对账标黄（DESIGN.md §4.5）——设计书声明的模块清单 ↔ 静态解析出的模块自动对账。
// 两向差异都是**信号不是错误**：设计书有代码没有 → 设计书过时或还没实现；
// 代码有设计书没有 → 代码跑偏或漏写设计。对账【长在 Gate 流程上】（§4.5）：
// POST gate（过关/打回）自动跑一次；B3 的对账钩子 .工作台/arch/reconcile-request.json
// 存在即消费（跑一次后清除标记）。结果落 .工作台/arch/reconcile-last.json 供 UI 标黄。
// 红线：对账只读合成 design.md + modules.json + names.json，【不写 design/progress】，
// 也绝不阻断任何流程（gate 路由里 try/catch 包住，对账失败不影响过关留痕）。
//
// 设计书模块清单提取口径（两路真实来源，不硬编）：
// - 塔台自身例外（AGENTS.md §7）：设计书 = repo 根 DESIGN.md，模块口径在 §11.1 表格
//   （| # | 模块 | 说明 |），按表格第 2 列提取；
// - 其他被纳管项目：解析 .工作台/design.md 里「模块划分」节的列表项（`- xxx` / `1. xxx`），
//   条目名截取到首个「：:（(—–」之前；找不到「模块划分」节时退化到任一含「模块」的节并标
//   confidence:"low"，都没有则空清单（差异全落 only_in_code，本身就是信号）。
import fs from "node:fs";
import path from "node:path";
import { getProject } from "../server/registry";
import { WsError, readDesign, workstationDir } from "../server/workstation";
import { loadDocument } from "../server/work/documents";
import { nowIso } from "../server/time";
import { isJunkDir } from "./config";
import { readModules } from "./parse";
import { readNames } from "./name";
import { codeLinkageOf } from "./blueprintValidate";
import { declaredLinksFromMatched, type MatchedPairLike, type ReconcileMatchVia } from "../shared/reconcileLinks";
import type { Blueprint } from "./blueprint";

/** 设计书侧提取到的一条模块声明 */
export interface DesignModuleEntry {
  name: string;
  /** high = 来自约定节（「模块划分」/塔台 §11.1 表）；low = 模糊节兜底提取 */
  confidence: "high" | "low";
  /**
   * **稳定 ID**（V08-01 迁移契约）：`<sectionKey>-<declaredKey>`，跨改名稳定；
   * 材料声明了稳定键（表编号）时是 `11.1-01` 这种形态，没有时退化为材料定位。
   * 对账/派生一律用它与材料索引关联，**不用名字猜对应**（DESIGN §4.5/§4.7）。
   */
  stable_id: string;
  /** 身份依据（如实标注）：材料声明的编号 / 材料定位（行号） */
  identity_basis: ModuleIdentityBasis;
  /** 材料里的原始声明键（`01` = 表编号；`L13` = 行号） */
  declared_key: string;
  /** 声明所在章节的标题路径（审定材料索引） */
  section_path: string | null;
}

/** 代码侧一个静态解析模块（对账视角） */
export interface CodeModuleEntry {
  id: string;
  /** 人话名（names.json 缓存），无缓存兜底 id */
  name: string;
  /** 模块在仓库内的相对路径（V08-01：与施工图「文件责任」声明匹配用） */
  path: string;
}

/**
 * 配对依据（§4.5「显式引用优先」；每种依据的信度**不一样**，界面与派生都必须分开对待）：
 *   · `plan_section_ref`     —— 显式引用 ＋ 章节里点名的**实现落点**（材料自己标了「实现落点」）；
 *                               可定位、可继承代码模块状态（附录 D.3）。
 *   · `plan_section_locator` —— 显式引用 ＋ 章节里只点到**落点**（没有实现落点标记）：
 *                               如实标「落点未证实」（E.7 裁定①），**不得直接继承绿**。
 *   · `name_signal`          —— 名字/文本匹配（设计条目 ↔ 模块 id/人话名归一化相等）；
 *                               旧图标的黄信号，**待核实**，同样不继承状态色。
 */
export type MatchVia = ReconcileMatchVia;

/** 一条对上号的声明模块 ↔ 代码模块 */
export interface MatchedPair extends MatchedPairLike {
  /** 设计侧显示名（人读） */
  design: string;
  /** 设计侧稳定 ID（V08-01 契约的身份键） */
  stable_id?: string;
  module_id: string;
  /** 配对依据：实现落点引用 / 章节落点（未证实）/ 名字信号（§4.5 标黄口径） */
  via?: MatchVia;
  /** 显式引用时的施工图侧章节路径与引用原文（可定位出处） */
  plan_section?: string;
  ref_text?: string;
  /**
   * 落点未证实（E.7 裁定①）：该声明只配到一个**章节里点名的落点**、材料没有点名实现落点
   * ⇒ 界面对账面如实标「落点未证实」，派生**不继承**代码模块状态（不直接给绿）。
   */
  locator_unverified?: true;
}

/**
 * `only_in_code` 的分类（DESIGN.md 附录 E.7 裁定④）：**原始事实保留**（id/name/path 原样），
 * 但界面必须把 actionable mismatch 与口径边界**分类分计**、分别命名，不得合并成一个「对账差」数。
 *
 * 判据（同一份共享判据，三图与 Gate 面板共用；判据本体见 `classifyOnlyInCodeEntries`）：
 *   · `actionable_mismatch` —— 真差异：对账范围内确无声明、且它是个真代码模块（有源码文件）。
 *   · `outside_scope`       —— 范围外：设计材料在**本次比对的章节之外**点到过它（如声明在别的章节）。
 *   · `structural`          —— 结构性目录：仓库根 / 目录里没有任何源码文件（文档库、模板、产物目录）。
 */
export type OnlyInCodeCategory = "actionable_mismatch" | "outside_scope" | "structural";

/** 分类原因键（稳定的机器可读值；界面据此分别命名，不靠文案判等） */
export type OnlyInCodeReason =
  | "no_declaration"
  | "declared_outside_compared_section"
  | "artifact_dir"
  | "structural_dir";

/** `only_in_code` 的一条（原始事实 ＋ 分类；分类是**解释**，不改变原始事实） */
export interface OnlyInCodeEntry extends CodeModuleEntry {
  category: OnlyInCodeCategory;
  reason: OnlyInCodeReason;
  /** 人话依据句（界面直接显示；点名它凭什么被这样归类） */
  basis: string;
}

/** 对账结果（落 .工作台/arch/reconcile-last.json 的同一份结构） */
export interface ReconcileResult {
  version: 1;
  generated_at: string;
  /** 触发来源：gate / manual / reverse-draft-finalize（消费 B3 钩子）等 */
  trigger: string;
  design_exists: boolean;
  code_exists: boolean;
  /** 设计书实际读取路径（塔台=repo 根 DESIGN.md，其他=.工作台/design.md） */
  design_source: string | null;
  design_modules: DesignModuleEntry[];
  code_modules: CodeModuleEntry[];
  /** 设计书有、代码没有（设计书过时或还没实现） */
  only_in_design: DesignModuleEntry[];
  /**
   * 代码有、设计书没有（代码跑偏或漏写设计）——**原始事实原样列出**，
   * 每条另带 `category`/`reason`/`basis`（V09-08 分类；口径见 `OnlyInCodeEntry`）。
   */
  only_in_code: OnlyInCodeEntry[];
  matched: MatchedPair[];
  /** 消费掉的 B3 对账钩子原文（无钩子为 null） */
  consumed_request: { ts?: string; trigger?: string; gate_step?: string } | null;
  /** 口径明示：差异是信号，不是错误（§4.5） */
  note: string;
}

const RECONCILE_LAST_FILE = "reconcile-last.json";
const RECONCILE_REQUEST_FILE = "reconcile-request.json";

/** 对账差异口径文案（UI 面板与结果文件共用同一句，§4.5：信号不是错误） */
export const RECONCILE_SIGNAL_NOTE =
  "差异是信号，不是错误（DESIGN.md §4.5）：设计书有代码没有=设计书过时或未实现；代码有设计书没有=代码跑偏或漏写设计。";

function reconcileDir(projectId: string, dataDir?: string): string {
  return path.join(workstationDir(projectId, dataDir), "arch");
}

function reconcileLastPath(projectId: string, dataDir?: string): string {
  return path.join(reconcileDir(projectId, dataDir), RECONCILE_LAST_FILE);
}

function reconcileRequestPath(projectId: string, dataDir?: string): string {
  return path.join(reconcileDir(projectId, dataDir), RECONCILE_REQUEST_FILE);
}

/** 原子写 JSON（与 workstation.writeJsonAtomic 同一惯例：临时文件 + rename） */
function writeJsonAtomic(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);
}

// ── 设计书模块清单提取（V08-01：稳定 ID 契约，DESIGN §4.5 那张迁移卡） ──
//
// 迁移背景：DESIGN §4.5「既有自举模块解析依赖 §11.1 的十个名字，在迁移卡通过前保留该表，
// 目标规划图改用**稳定 ID 与审定材料索引**」。本段就是那张迁移卡：
// **身份不再等于中文功能名**——名字降级为显示名，身份取材料自己声明的稳定键 + 章节索引
// （§4.7「改名不换身份」；§11.1 前言「本表的编号与模块名是当前自举对账解析契约；其稳定身份保留」）。
//
// 稳定 ID 口径（一处实现，塔台自举与纳管项目共用同一套）：
//   sectionKey  = 章节标题里的首个编号（`11.1 既有一期基础模块` → `11.1`；`2 模块划分` → `2`）；
//                 标题里没有编号时退化为 `s<章节序号>`（材料定位）
//   declaredKey = 材料**声明的稳定键**：表格行首编号列（`| 1 | … |`）→ `01`
//                 条目没有声明稳定键（纯列表项）→ `L<行号>`（材料定位）
//   stable_id   = `${sectionKey}-${declaredKey}`
// identity_basis 如实标注身份依据：declared_number（材料声明，改名/重排都不换身份）
// / material_position（材料定位，改名不换身份但重排会换身份）。
//
// §11.1 表在 DESIGN 正文里**一字不动**（历史保留）：本段只是改用它的编号列作稳定键、
// 用章节索引定位，不再把「十个功能名」当身份。旧证据与旧图不重写；口径差异见证据包。

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;
const LIST_ITEM_RE = /^\s*(?:[-*+]|\d+[.、)])\s+(.+?)\s*$/;
/** 身份依据：材料声明的编号（改名/重排都不换身份）/ 材料定位（行号，改名不换身份但重排会换） */
export type ModuleIdentityBasis = "declared_number" | "material_position";
/** 表格行首可当**稳定键**的列名（§11.1 是 `#`） */
const NUMBER_COLUMN_LABELS = ["#", "编号", "序号", "no", "no.", "id"];
/** 表格里「模块名」列的可选列名（找不到就取编号列右边第一列） */
const NAME_COLUMN_LABELS = ["模块", "名称", "模块名", "name", "module"];

/** 条目名清洗：去行内代码/加粗标记，截取到首个说明性分隔符之前（`- B：说明` → `B`） */
function cleanEntryName(raw: string): string {
  return raw
    .replace(/[`*_]/g, "")
    .split(/[：:（(—–「\[]/)[0]
    .trim();
}

interface SectionBlock {
  title: string;
  /** 标题路径（祖先标题 / 本节标题；与 documents.buildSectionIndex 同一算法） */
  path: string;
  level: number;
  /** 本节在文档里的标题序号（1-based，仅用于"标题没编号"时的退化 key） */
  ordinal: number;
  /** 行下标区间 [start, end)（start 是标题行本身） */
  start: number;
  end: number;
}

/** 标题路径（标题栈算法；与 documents.buildSectionIndex 的 path 口径一致） */
function headingPathOf(lines: string[], index: number): string {
  const stack: { level: number; title: string }[] = [];
  for (let k = 0; k <= index; k++) {
    const h = lines[k].match(HEADING_RE);
    if (h === null) continue;
    const level = h[1].length;
    while (stack.length > 0 && stack[stack.length - 1].level >= level) stack.pop();
    stack.push({ level, title: h[2] });
  }
  return stack.map((s) => s.title).join(" / ");
}

/** 定位一个章节（标题匹配 + 行区间 + 标题路径） */
export function findSectionBlock(lines: string[], pred: (title: string) => boolean): SectionBlock | null {
  let ordinal = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(HEADING_RE);
    if (m === null) continue;
    ordinal += 1;
    if (!pred(m[2])) continue;
    const level = m[1].length;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      const h = lines[j].match(HEADING_RE);
      if (h !== null && h[1].length <= level) {
        end = j;
        break;
      }
    }
    return { title: m[2], path: headingPathOf(lines, i), level, ordinal, start: i, end };
  }
  return null;
}

/** 章节稳定键：标题首个编号 → 原文；没有编号 → `s<标题序号>`（材料定位） */
function sectionKeyOf(block: SectionBlock): string {
  const m = /^(\d+(?:\.\d+)*)/.exec(block.title.trim());
  return m === null ? `s${block.ordinal}` : m[1];
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** 表格行切片；不是表格行返回 null */
function tableCells(line: string): string[] | null {
  if (!line.trim().startsWith("|")) return null;
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

const isSeparatorRow = (cells: string[]): boolean => cells.every((c) => /^:?-{2,}:?$/.test(c.replace(/\s/g, "")));

/**
 * 从一个章节里提取声明模块：**表格的编号列优先**（材料声明的稳定键），
 * 没有编号列或没有表格时退回列表项（材料定位）。
 */
function extractModulesFromSection(lines: string[], block: SectionBlock, confidence: "high" | "low"): DesignModuleEntry[] {
  const sectionKey = sectionKeyOf(block);
  const out: DesignModuleEntry[] = [];
  const seen = new Set<string>();

  const push = (name: string, declaredKey: string, basis: ModuleIdentityBasis): void => {
    if (name === "") return;
    const stable_id = `${sectionKey}-${declaredKey}`;
    if (seen.has(stable_id)) return;
    seen.add(stable_id);
    out.push({ name, confidence, stable_id, identity_basis: basis, declared_key: declaredKey, section_path: block.path });
  };

  // ① 表格里的编号列（材料声明的稳定键）
  for (let i = block.start + 1; i < block.end; i++) {
    const header = tableCells(lines[i]);
    if (header === null || i + 1 >= block.end) continue;
    const sep = tableCells(lines[i + 1]);
    if (sep === null || !isSeparatorRow(sep)) continue;
    const normalized = header.map((c) => c.replace(/[`\s]/g, "").toLowerCase());
    const numberCol = normalized.findIndex((c) => NUMBER_COLUMN_LABELS.includes(c));
    if (numberCol === -1) continue; // 没有声明稳定键的表格 → 交给列表项分支（材料定位）
    const namedCol = normalized.findIndex((c) => NAME_COLUMN_LABELS.includes(c));
    const nameCol = namedCol !== -1 ? namedCol : numberCol + 1;
    for (let j = i + 2; j < block.end; j++) {
      const cells = tableCells(lines[j]);
      if (cells === null) break;
      if (isSeparatorRow(cells)) continue;
      const numRaw = (cells[numberCol] ?? "").replace(/[`*]/g, "").trim();
      if (!/^\d+$/.test(numRaw)) continue;
      const name = cleanEntryName(cells[nameCol] ?? "");
      push(name, pad2(Number(numRaw)), "declared_number");
    }
    if (out.length > 0) return out;
  }

  // ② 列表项（材料没给稳定键 → 身份按材料定位；改名不换身份，重排会换身份）
  for (let i = block.start + 1; i < block.end; i++) {
    const li = lines[i].match(LIST_ITEM_RE);
    if (li === null) continue;
    push(cleanEntryName(li[1]), `L${i + 1}`, "material_position");
  }
  return out;
}

/** 从一个文档里按章节匹配提取声明模块（供两套入口共用；匹配不到返回 null） */
function extractModulesBySection(
  lines: string[],
  pred: (title: string) => boolean,
  confidence: "high" | "low",
): DesignModuleEntry[] | null {
  const block = findSectionBlock(lines, pred);
  if (block === null) return null;
  const out = extractModulesFromSection(lines, block, confidence);
  return out.length === 0 ? null : out;
}

/**
 * 通用提取（被纳管项目 design.md）：优先「模块划分」节（confidence:high）；
 * 找不到时退化到任一标题含「模块」的节（confidence:low）；都没有返回空清单。
 */
export function extractDesignModules(content: string): DesignModuleEntry[] {
  const lines = content.split(/\r?\n/);
  return (
    extractModulesBySection(lines, (t) => t.includes("模块划分"), "high") ??
    extractModulesBySection(lines, (t) => t.includes("模块"), "low") ??
    []
  );
}

/**
 * 塔台自身：模块索引章节在 DESIGN.md §11.1（自举例外，AGENTS.md §7）。
 * V08-01 起按**编号列**取稳定键（`11.1-01`…`11.1-10`）——不再把中文功能名当身份；
 * 表本身在 DESIGN 正文里一字不动（§4.5 的历史保留口径）。
 */
export function extractTataiDesignModules(content: string): DesignModuleEntry[] {
  const lines = content.split(/\r?\n/);
  return extractModulesBySection(lines, (t) => /^11\.1(\s|$)/.test(t.trim()), "high") ?? [];
}

// ── 审定材料索引：声明 ↔ 施工图章节 ↔ 代码模块的显式关联 ──
//
// DESIGN §4.5 要的是"稳定 ID 与审定材料索引"，§4.5 末句同时明令"不得为了让旧图对上而手工伪造
// 目录模块"——所以这里**只认材料里写明的交叉引用**，不做任何名字或位置猜测：
//   · 施工图正文用 `§<设计节号> 第 <N> 项` 点名的行（塔台 PLAN 的「一期 N｜…（DESIGN.md §11.1 第 N 项）」）
//     ⇒ 该行所在章节就是这条声明模块在施工图侧的落点；
//   · 落点章节里施工卡的「文件责任」路径 ∩ 静态模块路径 ⇒ 代码侧锚点（关系有可定位出处）。

/** 声明模块在施工图侧的对应章节（材料自己声明的交叉引用） */
export interface PlanCounterpart {
  /** 施工图侧章节标题路径 */
  section_path: string;
  /** 施工图侧章节起始行（1-based） */
  section_line: number;
  /** 交叉引用原文（如 `§11.1 第 1 项`） */
  ref_text: string;
  /** 引用所在行（1-based，便于人工核对） */
  line: number;
}

/** 交叉引用模式：`§11.1 第 1 项` */
const CROSS_REF_RE = /§\s*(\d+(?:\.\d+)*)\s*第\s*(\d+)\s*项/g;

/**
 * 解析施工图里对设计节号的交叉引用 → `stable_id → PlanCounterpart`。
 * 键与声明模块的稳定 ID 逐字对应（两侧用同一组材料声明的编号），不做模糊匹配。
 */
export function resolvePlanCounterparts(planText: string): Map<string, PlanCounterpart> {
  const lines = planText.split(/\r?\n/);
  const out = new Map<string, PlanCounterpart>();
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes("§")) continue;
    CROSS_REF_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CROSS_REF_RE.exec(lines[i])) !== null) {
      const key = `${m[1]}-${pad2(Number(m[2]))}`;
      if (out.has(key)) continue;
      // 引用所在行往上找最近一个标题 = 落点章节
      let head = -1;
      for (let k = i; k >= 0; k--) {
        if (HEADING_RE.test(lines[k])) {
          head = k;
          break;
        }
      }
      if (head === -1) continue;
      out.set(key, { section_path: headingPathOf(lines, head), section_line: head + 1, ref_text: m[0], line: i + 1 });
    }
  }
  return out;
}

/** 施工图里「文件责任」段反引号中的路径（与 plan.ts 的 allowed_paths 同一口径，用于取章节内的路径声明） */
const SCOPE_PATH_RE = /`([^`]+)`/g;

/**
 * 材料里「这条路径是实现落点」的**显式标记**（V09-08 ①/②）：路径反引号之后紧跟的括注里出现它。
 *
 * 为什么要有这个标记：一期章节的产出里既有**实现落点**（`src/server/registry.ts`），
 * 也有**非实现产物**（空模板目录 `templates/.工作台.example/`）。只看"章节里点到的路径"
 * 会把「项目注册表与目录接入」配到模板目录上并据此继承绿（报告 02 G-03 的**真误配**）。
 * 材料自己点名哪条是实现落点之后，对账区分得开「章节里点名的落点」与「实现映射」（E.7 裁定①）。
 */
export const IMPLEMENTATION_LOCATOR_MARK = "实现落点";

/** 章节里点名的一条路径（`implementation=true` ＝ 材料标了「实现落点」） */
export interface DeclaredPath {
  path: string;
  line: number;
  implementation: boolean;
}

/**
 * 取施工图某章节（自 sectionLine 起到下一个同级/更高级标题）里**反引号点名的仓库内路径**。
 *
 * 为什么是全章节而不只是「文件责任」段：塔台 PLAN 的功能章节（`一期 N｜…`）用的是
 * 「产出」表，把实现落点写在产出里（如 `templates/.工作台.example/` 空模板目录）；施工卡章节
 * 用的是「文件责任」。两者都是**材料自己点名的路径**，取法一致、出处记到行，不做名字猜测。
 *
 * `implementation` 的判据（纯排版、可测试）：反引号内的路径之后、同一行下一个反引号路径之前
 * （没有下一个就算到行尾）的那段括注里含「实现落点」三个字。**不猜、不按扩展名或目录名推断**。
 */
export function declaredPathsInSection(planText: string, sectionLine: number): DeclaredPath[] {
  const lines = planText.split(/\r?\n/);
  const start = sectionLine - 1;
  if (start < 0 || start >= lines.length) return [];
  const head = lines[start].match(HEADING_RE);
  const level = head === null ? 6 : head[1].length;
  let end = lines.length;
  for (let j = start + 1; j < lines.length; j++) {
    const h = lines[j].match(HEADING_RE);
    if (h !== null && h[1].length <= level) {
      end = j;
      break;
    }
  }
  const out: DeclaredPath[] = [];
  const seen = new Set<string>();
  for (let i = start; i < end; i++) {
    const line = lines[i];
    const hits: { path: string; start: number; end: number }[] = [];
    SCOPE_PATH_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = SCOPE_PATH_RE.exec(line)) !== null) {
      const p = m[1].trim();
      if (p === "") continue;
      hits.push({ path: p, start: m.index, end: m.index + m[0].length });
    }
    for (let k = 0; k < hits.length; k++) {
      const trailer = line.slice(hits[k].end, k + 1 < hits.length ? hits[k + 1].start : line.length);
      const p = hits[k].path;
      if (seen.has(p)) continue;
      seen.add(p);
      out.push({ path: p, line: i + 1, implementation: trailer.includes(IMPLEMENTATION_LOCATOR_MARK) });
    }
  }
  return out;
}

/**
 * 把材料点名的路径解析到代码模块：**模块路径必须是该路径的真前缀**（`src/ui/x.ts` → `src`），
 * 且不认根模块（`path` 为 `.`/空的模块覆盖一切，会把每个路径都锚上，属噪声）。
 */
export function resolveModuleForPath(
  declaredPath: string,
  modules: readonly { id: string; path: string }[],
): string | null {
  const a = declaredPath.replace(/^\.\//, "").replace(/\\/g, "/");
  let best: { id: string; len: number } | null = null;
  for (const m of modules) {
    const p = m.path.replace(/^\.\//, "").replace(/\\/g, "/");
    if (p === "" || p === ".") continue;
    if (a === p || a.startsWith(`${p}/`)) {
      if (best === null || p.length > best.len) best = { id: m.id, len: p.length };
    }
  }
  return best === null ? null : best.id;
}

/** 一个代码模块路径是否落在施工图声明的「文件责任」范围内（声明范围是文件/目录，模块是目录）
 *  V08-01 从 blueprint.ts 搬来这里：对账与派生必须用同一份口径，不能两处各写一份。 */
export function scopeCovers(allowedPath: string, modulePath: string): boolean {
  const a = allowedPath.replace(/^\.\//, "").replace(/\\/g, "/");
  const m = modulePath.replace(/^\.\//, "").replace(/\\/g, "/");
  if (m === "." || m === "") return true; // 根目录散文件覆盖一切
  return a === m || a.startsWith(`${m}/`);
}

// ── 对账核心 ──

/**
 * 匹配归一化：大小写/空白/装饰字符不敏感（设计书条目 ↔ 模块 id/人话名两边都用）。
 *
 * 路径分隔符按模块 id 的既有 slug 惯例归一（`/`、`\` → `-`）并折叠/去掉**尾随** `-`：
 * 设计书常按目录写法写 `src/`、`tests/`，代码侧 id 是 `src`、`tests`——不归一时两边永远对不上，
 * 对账会把每个模块都报成"双向差异"（2026-09-22 实测：真实项目 matched=0、14 个模块全落假差异）。
 * 两边跑同一份函数，本改动只做**加法**（原本归一后相等的串仍相等），
 * 不会把真正不同的东西判成同一条；尾随 `-` 只削右边，避免把 `_` 开头的 id 归成空串。
 */
const norm = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/[\s`_*「」『』()（）]/g, "")
    .replace(/[\\/]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/-+$/, "");

/**
 * `only_in_code` 分类的**输入现场**（V09-08 ③）：分类只看可复算的事实——项目根、本次比对的
 * 模块清单章节行区间、设计材料正文、项目根的 `.gitignore` 模式。**不含任何项目专名硬编码**。
 */
export interface OnlyInCodeContext {
  project_root: string;
  /** 设计材料正文按行切好（null = 设计书读不到） */
  design_lines: string[] | null;
  /** 本次比对的模块清单章节在 `design_lines` 里的行区间（0-based，`end` 不含；null = 没找到章节） */
  compared_section_lines: { start: number; end: number } | null;
  compared_section_path: string | null;
  /** 项目根 `.gitignore` 的忽略模式（已去注释；`!` 取反的行不进本表） */
  ignore_patterns: string[];
}

/** 读项目根 `.gitignore` 的忽略模式（只读；读不到/没有按空表，不报错） */
function readIgnorePatterns(projectRoot: string): string[] {
  const file = path.join(projectRoot, ".gitignore");
  if (!fs.existsSync(file)) return [];
  const out: string[] = [];
  try {
    for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (line === "" || line.startsWith("#") || line.startsWith("!")) continue;
      out.push(line.replace(/^\//, "").replace(/\/+$/, ""));
    }
  } catch {
    return [];
  }
  return out;
}

/** 设计书里「模块清单」所在章节的匹配口径（与 `extractDesignModules`/`extractTataiDesignModules` 一致） */
function moduleSectionBlockOf(lines: string[], isTatai: boolean): SectionBlock | null {
  if (isTatai) return findSectionBlock(lines, (t) => /^11\.1(\s|$)/.test(t.trim()));
  return (
    findSectionBlock(lines, (t) => t.includes("模块划分")) ?? findSectionBlock(lines, (t) => t.includes("模块"))
  );
}

/** 组装一次 `only_in_code` 分类的现场（只读；分类判据本体在 `classifyOnlyInCodeEntries`） */
export function onlyInCodeContextOf(projectId: string, dataDir?: string): OnlyInCodeContext {
  const project = getProject(projectId, dataDir);
  if (!project) throw new WsError("PROJECT_NOT_FOUND", `项目不存在: ${projectId}`);
  const isTatai = project.self_managed === true || project.id === "tatai";
  let designLines: string[] | null = null;
  try {
    const design = readDesign(projectId, dataDir);
    if (design.exists) designLines = design.content.split(/\r?\n/);
  } catch {
    designLines = null;
  }
  const block = designLines === null ? null : moduleSectionBlockOf(designLines, isTatai);
  return {
    project_root: project.path,
    design_lines: designLines,
    compared_section_lines: block === null ? null : { start: block.start, end: block.end },
    compared_section_path: block === null ? null : block.path,
    ignore_patterns: readIgnorePatterns(project.path),
  };
}

/** 路径归一（**与 `blueprint.ts#normalizeRepoPath` 同一条规则**；此处就地复写是因为
 *  blueprint.ts 反向 import 本文件，运行时再 import 它会成环） */
const normalizeRepoPath = (p: string): string => p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");

/** 参与判「是不是真代码模块」的源码扩展名（含非 JS 系语言；`src-tauri` 的 `.rs` 也算） */
const SOURCE_FILE_EXTS: ReadonlySet<string> = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rs", ".go", ".java", ".kt", ".kts",
  ".cs", ".c", ".h", ".cc", ".cpp", ".hpp", ".rb", ".php", ".swift", ".scala", ".sh", ".ps1",
  ".lua", ".vue", ".svelte", ".astro", ".dart", ".ex", ".exs", ".clj", ".hs", ".ml", ".r",
  ".pl", ".pm", ".sql", ".proto", ".tf", ".gradle", ".zig", ".nim", ".jl",
]);

/** 目录里有没有源码文件（有界遍历：上限条数与深度都设死，读不动就当"没有"，不抛） */
function hasSourceFile(dir: string, limit = 800, maxDepth = 5): boolean {
  let seen = 0;
  const walk = (current: string, depth: number): boolean => {
    if (depth > maxDepth || seen > limit) return false;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const e of entries) {
      if (seen++ > limit) return false;
      if (e.isFile()) {
        if (SOURCE_FILE_EXTS.has(path.extname(e.name).toLowerCase())) return true;
        continue;
      }
      if (!e.isDirectory()) continue;
      if (isJunkDir(e.name) || e.name.startsWith(".")) continue;
      if (walk(path.join(current, e.name), depth + 1)) return true;
    }
    return false;
  };
  return walk(dir, 0);
}

/** 该模块路径（相对项目根）是否被项目 `.gitignore` 忽略（首段或整路径命中即算） */
function isIgnoredPath(patternList: readonly string[], modulePath: string): boolean {
  const p = modulePath.replace(/^\.\//, "").replace(/\\/g, "/").replace(/\/+$/, "");
  if (p === "" || p === ".") return false;
  const first = p.split("/")[0];
  return patternList.some((pat) => {
    const q = pat.replace(/^\.\//, "").replace(/\\/g, "/");
    if (q === "" || q === ".") return false;
    if (q.includes("*") || q.includes("?")) return false; // 通配模式不猜（宁可归 actionable）
    return q === first || q === p || p.startsWith(`${q}/`);
  });
}

/** 设计材料里（**本次比对的章节之外**）有没有点到这个模块的 id 或路径 */
function designMentionsOutside(module: CodeModuleEntry, ctx: OnlyInCodeContext): number | null {
  if (ctx.design_lines === null) return null;
  const tokens = [module.id, module.path]
    .map((t) => t.replace(/^\.\//, "").replace(/\\/g, "/").replace(/\/+$/, ""))
    .filter((t) => t !== "" && t !== ".");
  if (tokens.length === 0) return null;
  for (let i = 0; i < ctx.design_lines.length; i++) {
    if (ctx.compared_section_lines !== null && i >= ctx.compared_section_lines.start && i < ctx.compared_section_lines.end) {
      continue; // 本次比对的那一节里的出现不算"范围外"
    }
    for (const t of tokens) {
      const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`(^|[^\\w.-])${escaped}([^\\w-]|$)`).test(ctx.design_lines[i])) return i + 1;
    }
  }
  return null;
}

/**
 * `only_in_code` 逐项分类（**同一份共享判据**：三图与 Gate 面板都消费这一份输出，不各写一套）。
 *
 * 判据（顺序即优先级；每条都写出凭什么，界面直接显示 `basis`）：
 *   ① `artifact_dir`（structural）—— 该路径被项目 `.gitignore` 忽略 ⇒ **产物目录**，不是待归属的代码模块；
 *   ② `structural_dir`（structural）—— 仓库根，或该目录里**没有任何源码文件**（文档库/模板/产物）；
 *   ③ `declared_outside_compared_section`（outside_scope）—— 设计材料在**本次比对的章节之外**点到过它
 *      （如声明在别的章节），对账只比模块清单章节 ⇒ **范围外**，不是代码跑偏；
 *   ④ `no_declaration`（actionable_mismatch）—— 以上都不成立 ⇒ **真差异**，界面按黄点标出。
 *
 * **不改变原始事实**：`id`/`name`/`path` 原样保留，分类只加解释字段。
 */
export function classifyOnlyInCodeEntries(
  items: readonly CodeModuleEntry[],
  ctx: OnlyInCodeContext,
): OnlyInCodeEntry[] {
  return items.map((m) => {
    const relPath = normalizeRepoPath(m.path);
    if (isIgnoredPath(ctx.ignore_patterns, relPath)) {
      return {
        ...m,
        category: "structural" as const,
        reason: "artifact_dir" as const,
        basis: `产物目录：\`${relPath}\` 在项目 \`.gitignore\` 里（构建/审计产出，不是源码模块）——不当代码模块判绿`,
      };
    }
    const isRoot = relPath === "" || relPath === ".";
    const dir = isRoot ? ctx.project_root : path.join(ctx.project_root, relPath);
    if (isRoot || !hasSourceFile(dir)) {
      return {
        ...m,
        category: "structural" as const,
        reason: "structural_dir" as const,
        basis: isRoot
          ? "结构性目录：仓库根（散文件的容器，不是可归属的代码模块）"
          : `结构性目录：\`${relPath}\` 里没有任何源码文件（文档/模板/产物）——非待归属`,
      };
    }
    const line = designMentionsOutside(m, ctx);
    if (line !== null) {
      return {
        ...m,
        category: "outside_scope" as const,
        reason: "declared_outside_compared_section" as const,
        basis:
          `范围外：设计材料在本次比对的章节（${ctx.compared_section_path ?? "未定位到模块清单章节"}）**之外**` +
          `第 ${line} 行点到过 \`${m.id}\`——对账只比模块清单章节，不是代码跑偏`,
      };
    }
    return {
      ...m,
      category: "actionable_mismatch" as const,
      reason: "no_declaration" as const,
      basis: `真差异：对账范围内没有对应声明，且它是一个有源码文件的代码模块（\`${relPath}\`）——交设计/执行角色核实`,
    };
  });
}

/**
 * 从对账结果取「可继承状态色」的声明 ↔ 代码模块配对（V09-08 ①②；界面与派生共用这一份）。
 *
 * 判据本体在**浏览器安全的** `src/shared/reconcileLinks.ts`（三处消费者：服务端对账/读口与
 * 前端三视图/技术详情；放本文件会把 `node:fs` 拉进前端包）——本函数只是给服务端调用方留的入口。
 *
 * 只有 `via="plan_section_ref"`（材料点名了**实现落点**）才进这张表：
 *   · `plan_section_locator`（落点未证实）——**不继承**（否则又是"只点到一个产物路径就判绿"）；
 *   · `name_signal`（文本匹配·待核实）——**不继承**（§4.5：名字相同不算已完成）。
 */
export function declaredLinksOf(
  result: Pick<ReconcileResult, "matched"> | null | undefined,
): Record<string, string[]> {
  return declaredLinksFromMatched(result?.matched ?? []);
}

/**
 * 跑一次对账并落盘 reconcile-last.json；同时消费 B3 对账钩子
 * （reconcile-request.json 存在即读后清除，原文随结果带回）。
 * 缺 design.md / 未解析过 modules.json 都不是错误——对应侧按空清单参与，
 * 差异全落另一侧（这本身就是 §4.5 要的信号）。
 */
export function reconcileProject(
  projectId: string,
  opts: { trigger?: string; dataDir?: string } = {},
): ReconcileResult {
  const project = getProject(projectId, opts.dataDir);
  if (!project) {
    throw new WsError("PROJECT_NOT_FOUND", `项目不存在: ${projectId}`);
  }
  const isTatai = project.self_managed === true || project.id === "tatai";

  // 设计书侧（只读）：稳定 ID 契约（V08-01）——塔台自举与纳管项目走同一套提取器
  const design = readDesign(projectId, opts.dataDir);
  const designModules = design.exists
    ? isTatai
      ? extractTataiDesignModules(design.content)
      : extractDesignModules(design.content)
    : [];

  // 代码侧（只读已落盘 modules.json + names.json 缓存；对账不触发解析/起名）
  const { exists: codeExists, arch } = readModules(projectId, opts.dataDir);
  const names = readNames(project.path);
  const codeModules: CodeModuleEntry[] = (codeExists && arch ? arch.modules : []).map((m) => ({
    id: m.id,
    name: names.entries[m.id]?.name ?? m.id,
    path: m.path,
  }));

  // ── 匹配（V08-01：先按审定材料索引的**显式引用**，再退化到人话名信号）──
  // ① 显式引用：施工图里 `§<设计节号> 第 N 项` 的交叉引用（材料写明的那条），
  //    其章节点名的路径 ∩ 静态模块 = 代码锚点。这条是"稳定 ID + 审定材料索引"的正路。
  //
  //    V09-08 ①/②（E.7 裁定①）：显式引用内部还要再分两层——
  //      · 材料标了「实现落点」的路径 ⇒ `plan_section_ref`（可定位的实现映射，可继承代码模块状态）；
  //      · 只有**章节里点名的落点**（没有实现落点标记）⇒ `plan_section_locator` ＋ 落点未证实，
  //        如实列出、但**不继承绿**（修前的真误配 `11.1-01 → templates` 正是把产物目录当实现落点）。
  const plan = loadDocument(projectId, "plan", opts.dataDir);
  const counterparts = plan === null ? new Map<string, PlanCounterpart>() : resolvePlanCounterparts(plan.text);
  const matched: MatchedPair[] = [];
  const usedCodeIds = new Set<string>();
  const usedDesignIds = new Set<string>();
  for (const d of designModules) {
    const cp = counterparts.get(d.stable_id);
    if (cp === undefined || plan === null) continue;
    const declared = declaredPathsInSection(plan.text, cp.section_line);
    const implIds = new Set<string>();
    const nominalIds = new Set<string>();
    for (const item of declared) {
      const mid = resolveModuleForPath(item.path, codeModules);
      if (mid === null) continue;
      (item.implementation ? implIds : nominalIds).add(mid);
    }
    const landingsOf = (id: string, implementation: boolean): string =>
      declared
        .filter((x) => x.implementation === implementation && resolveModuleForPath(x.path, codeModules) === id)
        .map((x) => `${x.path}@L${x.line}`)
        .join("、");
    const push = (id: string, via: MatchVia, refText: string, unverified: boolean): void => {
      const key = `${d.stable_id}@${id}`;
      if (matched.some((m) => `${m.stable_id}@${m.module_id}` === key)) return;
      const pair: MatchedPair = {
        design: d.name,
        stable_id: d.stable_id,
        module_id: id,
        via,
        plan_section: cp.section_path,
        ref_text: refText,
      };
      if (unverified) pair.locator_unverified = true;
      matched.push(pair);
      usedCodeIds.add(id);
      usedDesignIds.add(d.stable_id);
    };
    if (implIds.size > 0) {
      // 有实现落点 ⇒ 只认实现落点（章节里点到的其它路径是产物/素材，不是这条声明的实现映射）
      for (const id of [...implIds].sort()) {
        push(id, "plan_section_ref", `${cp.ref_text}（章节内点名的实现落点：${landingsOf(id, true)}）`, false);
      }
      continue;
    }
    // 只有「章节里点名的落点」⇒ 如实标「落点未证实」，不继承绿（E.7 裁定①）
    for (const id of [...nominalIds].sort()) {
      push(
        id,
        "plan_section_locator",
        `${cp.ref_text}（章节里只点到落点、**没有点名实现落点**：${landingsOf(id, false)}——落点未证实，不据此继承状态）`,
        true,
      );
    }
  }

  // ② 名字信号（§4.5 的旧图标黄口径，保留为**信号**）：设计条目与模块 id 或人话名归一化相等即视为同一条。
  //    只在①没配上的条目/模块之间跑，避免把材料写明的引用关系降级成名字猜测。
  //    V09-08 ②：名字信号是**文本匹配·待核实**，`declaredLinksOf` 不给它继承状态色的资格。
  const unmatched = new Map<string, DesignModuleEntry>();
  for (const d of designModules) if (!usedDesignIds.has(d.stable_id)) unmatched.set(norm(d.name), d);
  const onlyInCodeRaw: CodeModuleEntry[] = [];
  for (const c of codeModules) {
    if (usedCodeIds.has(c.id)) continue;
    const key = unmatched.has(norm(c.id))
      ? norm(c.id)
      : unmatched.has(norm(c.name))
        ? norm(c.name)
        : null;
    if (key) {
      const d = unmatched.get(key)!;
      matched.push({ design: d.name, stable_id: d.stable_id, module_id: c.id, via: "name_signal" });
      unmatched.delete(key);
      usedCodeIds.add(c.id);
      usedDesignIds.add(d.stable_id);
    } else {
      onlyInCodeRaw.push(c);
    }
  }
  const onlyInDesign = designModules.filter((d) => !usedDesignIds.has(d.stable_id));
  const onlyInCode = classifyOnlyInCodeEntries(onlyInCodeRaw, onlyInCodeContextOf(projectId, opts.dataDir));

  // 消费 B3 对账钩子（存在即读 → 跑一次后清除标记）
  let consumedRequest: ReconcileResult["consumed_request"] = null;
  const reqFile = reconcileRequestPath(projectId, opts.dataDir);
  if (fs.existsSync(reqFile)) {
    try {
      consumedRequest = JSON.parse(fs.readFileSync(reqFile, "utf8"));
    } catch {
      consumedRequest = {};
    }
    fs.rmSync(reqFile, { force: true });
  }

  const result: ReconcileResult = {
    version: 1,
    generated_at: nowIso(),
    trigger: opts.trigger ?? "manual",
    design_exists: design.exists,
    code_exists: codeExists,
    design_source: design.exists ? design.source : null,
    design_modules: designModules,
    code_modules: codeModules,
    only_in_design: [...unmatched.values()],
    only_in_code: onlyInCode,
    matched,
    consumed_request: consumedRequest,
    note: RECONCILE_SIGNAL_NOTE,
  };
  writeJsonAtomic(reconcileLastPath(projectId, opts.dataDir), result);
  return result;
}

/** 读最近一次对账结果；未跑过返回 {exists:false}（200 空态，不是错误） */
export function readLastReconcile(
  projectId: string,
  dataDir?: string,
): { exists: boolean; result?: ReconcileResult } {
  const file = reconcileLastPath(projectId, dataDir);
  if (!fs.existsSync(file)) return { exists: false };
  try {
    return { exists: true, result: JSON.parse(fs.readFileSync(file, "utf8")) as ReconcileResult };
  } catch (e) {
    throw new WsError(
      "INVALID_INPUT",
      `reconcile-last.json 不是合法 JSON: ${(e as Error).message}`,
    );
  }
}

// ═══════════════ V06-05：规划 ↔ 实现对账（DESIGN.md §4.1 末段 / §4.5）═══════════════
//
// A5 的对账口径是「设计书声明的模块清单 ↔ 静态解析出的模块」（按人话名归一化匹配，**有意模糊**，
// 因为那是给旧图标黄用的信号）。规划图引入后需要的是**另一件事**：按 §4.1 的稳定关系对账——
// 规划对象（能力/模块/任务）与实测代码模块之间**只有显式来源引用才算关联**，不靠名字猜。
// 因此本段是**新增的纯函数**，不改 `reconcileProject` 一个字节（既有 verify-a5 / verify-l3 的
// 键集断言与 templates 口径原样保留）：
//   · `planned_only` —— 规划有、代码没有：**正常的灰色待建项**，不是报警（§4.5 首句）；
//   · `code_only`    —— 代码有、规划没有：**待归属**，交设计/执行角色核实，程序不自行删代码（§4.5 末句）；
//   · `mapped`       —— 规划对象 ↔ 代码模块的稳定关系（经由 source_refs/关系里的 code_module 引用）。
// 本函数**只读**，不写 reconcile-last.json、不落任何盘（写盘口径归 `reconcileProject` 与 blueprint）。

/** 规划 ↔ 实现对账的一行稳定关系 */
export interface PlanCodeMapping {
  /** 规划对象的稳定 id（Blueprint 节点 id） */
  plan_id: string;
  /** 静态解析层的模块 id（modules.json） */
  code_module_id: string;
  /** 这条关系从哪来：节点出处 / 关系出处 */
  via: "node_source_ref" | "edge_source_ref";
}

/** 规划 ↔ 实现对账结果（纯产物，不落盘） */
export interface PlanCodeReconcile {
  version: 1;
  /** 本份对账依据的基线（null = 该图不是生效基线派生的，只作草稿预览） */
  baseline_id: string | null;
  /** 规划有、代码没有（灰色待建项，§4.5：不能仅凭此一律标黄报警） */
  planned_only: { id: string; name: string; kind: string }[];
  /** 代码有、规划没有（待归属，§4.5：交设计/执行角色核实，程序不自行删代码/改设计） */
  code_only: { id: string; name: string }[];
  mapped: PlanCodeMapping[];
  note: string;
}

export const RECONCILE_PLAN_NOTE =
  "规划↔实现对账（DESIGN.md §4.5）：规划有代码没有=正常的灰色待建项，不是报警；代码有规划没有=待归属，交设计/执行角色核实，程序不自行删代码或补造需求。";

/**
 * 规划 ↔ 实现对账（纯函数；只吃已经读好的 Blueprint 与静态模块，不读盘、不调模型）。
 * 「关联」的判据只有一条：**来源引用里出现了 code_module**（§4.1：「实际映射用稳定关系连接，
 * 不能把目录名相同当作已完成」）——名字相同但无出处的一律不算关联，如实落进待归属。
 */
export function reconcilePlanWithCodeInputs(
  blueprint: Blueprint,
  modules: readonly { id: string; path: string }[],
  names: Record<string, { name: string } | undefined> = {},
): PlanCodeReconcile {
  const linkage = codeLinkageOf(blueprint);
  const mapped: PlanCodeMapping[] = [];
  const seen = new Set<string>();
  const push = (planId: string, codeModuleId: string, via: PlanCodeMapping["via"]): void => {
    const key = `${planId}@${codeModuleId}`;
    if (seen.has(key)) return;
    seen.add(key);
    mapped.push({ plan_id: planId, code_module_id: codeModuleId, via });
  };
  // ① 关系两端：非代码节点 ↔ 代码节点（施工图「文件责任」给出的实现映射就在这一支）
  for (const e of blueprint.edges) {
    const fromCode = linkage.code_node_modules.get(e.source);
    const toCode = linkage.code_node_modules.get(e.target);
    if (fromCode !== undefined && toCode === undefined) push(e.source, fromCode, "edge_source_ref");
    if (toCode !== undefined && fromCode === undefined) push(e.target, toCode, "edge_source_ref");
  }
  // ② 非代码节点自己的出处里引用了代码模块（模型整理常把出处标在节点上）
  for (const n of blueprint.nodes) {
    if (linkage.code_node_ids.has(n.id)) continue;
    for (const r of n.source_refs) if (r.kind === "code_module") push(n.id, r.locator, "node_source_ref");
  }

  const mappedPlanIds = new Set(mapped.map((m) => m.plan_id));
  // 「规划有、代码没有」只列**实现单元**（模块 / 任务）：能力是设计章节，不是可实现的单位（§3.2 功能全景）
  const plannedOnly = blueprint.nodes
    .filter((n) => (n.kind === "module" || n.kind === "task") && !linkage.code_node_ids.has(n.id) && !mappedPlanIds.has(n.id))
    .map((n) => ({ id: n.id, name: n.name, kind: n.kind }));

  const codeOnly = modules
    .filter((m) => !linkage.linked_module_ids.has(m.id))
    .map((m) => ({ id: m.id, name: names[m.id]?.name ?? m.id }));

  return {
    version: 1,
    baseline_id: blueprint.baseline_id,
    planned_only: plannedOnly,
    code_only: codeOnly,
    mapped,
    note: RECONCILE_PLAN_NOTE,
  };
}

/**
 * 设计书里「模块清单」所在章节的**标题路径**（与 `extractDesignModules` / `extractTataiDesignModules`
 * 的取节口径一致，供规划图把每个声明模块挂到可定位的设计出处上）。
 *
 * 为什么口径要一致：规划图的 `source_refs` 要能被结构校验「来源可定位」这一条验证——
 * 定位串必须真的出现在设计章节索引里。这里按与 `buildSectionIndex` 相同的标题栈算法算路径
 * （祖先标题 `/` 本节标题），所以两边算出来的串逐字相同。
 *
 * @param content  设计书原文（只读）
 * @param isTatai  塔台自身例外（模块口径在 §11.1 表格，见 AGENTS.md §7）
 */
export function moduleSectionPathOf(content: string, isTatai: boolean): string | null {
  const lines = content.split(/\r?\n/);
  const HEADING = /^(#{1,6})\s+(.*\S)\s*$/;
  const titles: { level: number; title: string }[] = [];
  const pathAt = (title: string): string => titles.map((t) => t.title).join(" / ") + (titles.length > 0 ? " / " : "") + title;
  const matched = (title: string): boolean =>
    isTatai ? /^11\.1(\s|$)/.test(title) : title.includes("模块划分");

  let found: string | null = null;
  const fuzzy: { level: number; title: string }[] = [];
  let fuzzyPath: string | null = null;
  for (const line of lines) {
    const m = line.match(HEADING);
    if (m === null) continue;
    const level = m[1].length;
    const title = m[2];
    while (titles.length > 0 && titles[titles.length - 1].level >= level) titles.pop();
    const here = pathAt(title);
    if (found === null && matched(title)) found = here;
    if (fuzzyPath === null && title.includes("模块")) fuzzyPath = here;
    titles.push({ level, title });
  }
  // 塔台自身固定 §11.1；其他项目「模块划分」优先，找不到退化到任一含「模块」的节（与 A5 同口径）
  return found ?? (isTatai ? null : fuzzyPath);
}
