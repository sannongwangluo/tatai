// 严格「设计引用 → 当前设计书章节」解析（P1 / V09-46；DESIGN §6.7／§6.9、docs/agent-optimization-20261006.md §5.2、
// coordinator-decisions.md P1 纠正优先）。
//
// 为什么另立一个入口，而不是复用 `src/shared/designRef.ts#resolveDesignRef`：
// 旧判据服务**蓝图/投影**（`src/arch/blueprint.ts`、`src/server/work/statusProjection.ts`），要看的是
// “这条依据大概落在哪一节”，因此是 first-match，且附录子节缺失时**逐级放宽到父节**。本轮接续材料要的是
// **精确定位**，旧判据有两处不满足：
//   ① `designRef.ts:33-39` 附录子节缺失时降级到 `附录 X` 大标题 —— 会把“附录 E.9 不存在”静默变成“附录 E”；
//   ② `designRef.ts:41-46` 范围引用只取第一个命中的编号 —— `§2.6–§2.9` 会静默丢掉 `§2.9`。
// 故新增本严格入口：**逐个显式编号、唯一精确匹配、范围必须能证明完整展开、附录不降级**。
// 旧判据与它的消费者本批**一字不改**；两套判据并存但用途分开（旧的继续服务蓝图/投影，本模块只服务接续材料）。
//
// 本模块是**纯解析**：不吃项目根、不碰 fs、不写盘；输入是 materialSection 口径的章节树
// （围栏感知、每级路径唯一、哈希=标题行+全部后代；口径与 `required_reads.section` 完全统一）。
//
// P1 复核返工（2026-10-06，`P1-coordinator-review.md` 第 1–5 条）在此基础上收紧：
//   ① 编号每一段都必须是**非负安全整数**，范围成员数**显式有界**——`§9007199254740992–…` 不进展开循环；
//   ② 编号前缀必须有**合法边界**（`(?![0-9A-Za-z])(?!\.\d)`）：`2.6abc`／`E.5x` 不再被当近似标题命中；
//   ③ 只有「连字符族 + 右端不带 § + 层级更浅」的**明确条目语法**才读所属子节；`§2.6–§3` 的显式章节目标不吞；
//   ④ 附录连字符段先找同名连字符标题（存在 `G-2` 标题就不得退到「附录 G」大标题）；
//   ⑤ 认不出编号时按**完整标题路径**唯一精确匹配；认不出的设计引用如实 unresolved，不静默当外部追溯。
//
// P1 集成复核（2026-10-06，`P1-integration-review.md`）再补两条严格边界：
//   ⑥ 引用 atom 也要有**输入 token 合法边界**（`(?![0-9A-Za-z])(?!\.\d)` + 挡范围回退）：`§2.6abc`／`附录 E.5x`
//      与 `§2.6–§2.9abc`／`附录 E.5-1x` 不再被截短成 `§2.6`／`附录 E.5`／`§2.6–§2.9` 命中已知节；
//   ⑦ 只有**机械明确的外部文档/需求/报告**才 trace——`根标题 / 核心 / 缺失子标题` 这类完整标题路径形态与未知依据
//      一律进设计解析（认不出 ⇒ unresolved），不因认不出就静默降成"确实外部"而少读。
//
// P1 集成复核第 1 条的组合边界（2026-10-06，同一根因的返工）：`§2.6 / §2.9abc`、`§2.6 – §2.9abc`、
// `附录 E.5 / 附录 E.6x` 这类「合法子目标 + 非法子目标」同现时，此前非法项被静默丢掉、整条被错判 `resolved`。
// 现补两处：⑧ `NO_TRUNCATED_RANGE` 的分隔符前也允许空白（`§2.6 – …` 不再因空格回退命中 `§2.6`）；
//   ⑨ 未被任何 atom 覆盖的显式 `§`/`附录 X` 标记（含其非法后缀）逐条补 `unresolved(malformed)`——
//   **所有显式子目标都被解释或明确 unresolved**，不丢无法识别的显式编号；仅补这一同因组合反例，不扩展新语法。
// 同一根因的**裸续列**收口（2026-10-06 最终集成，`final-integration-report.md` §5.5 自认遗留）：`附录 E.5、E.7x`
// 里 `E.7x`（**无 `附录` 前缀**的续列项）此前不被任何残留检测覆盖（`UNCOVERED_APPENDIX_MARKER_RE` 要求 `附录` 前缀），
// 于是合法 `E.5` 仍把非法 `E.7x` 掩盖成整条 `resolved`。这**不是新语法**：裸续列（`附录 E.5、E.6`）解析器本已支持；
//   ⑩ 现补「显式附录标记之后的裸续列残留」——字母与标记同字母、含数字/点、未被任何 atom/残留覆盖 ⇒ 逐条
//   `unresolved(malformed)`。**已支持语法下的未知子目标必须显式 unresolved**，合法项不得掩盖非法项。
import { findSectionInParsed, type MarkdownSectionNode } from "./materialSection";

/** 未解析的原因（闭集；`malformed` = 形态无法证明完整展开或认不出） */
export type StrictRefReason = "missing" | "ambiguous" | "malformed";

export type StrictResolvedTarget = {
  /** token 里被逐个解析出的显式子目标（如 `§2.7` / `附录 E.5`），供人核对 */
  token_part: string;
  resolution: "resolved";
  /** 完整标题路径（materialSection 口径，即 `required_reads.section` 的语义） */
  path: string;
  /** 该章节子树哈希（标题行 + 全部后代，CRLF 归一为 LF） */
  sha256: string;
  line_start: number;
  line_end: number;
};
export type StrictUnresolvedTarget = { token_part: string; resolution: "unresolved"; reason: StrictRefReason };
export type StrictRefTarget = StrictResolvedTarget | StrictUnresolvedTarget;

export interface StrictRefResolution {
  targets: StrictRefTarget[];
  /** 全部子目标都唯一解析到当前版本才 `resolved`；任一未解析即 `unresolved`（原引用原样带出，不取第一个命中） */
  resolution: "resolved" | "unresolved";
}

/** 未解析原因的人话（工具/报告共用一句，避免各写各的） */
export const STRICT_REF_REASON_TEXT: Readonly<Record<StrictRefReason, string>> = {
  missing: "当前设计书里没有该编号的章节（缺失即 unresolved，不硬凑、不猜近似标题）",
  ambiguous: "该编号命中多处或每级完整标题路径不唯一（歧义即 unresolved，不选第一个）",
  malformed: "引用形态无法证明完整展开（或认不出），据实 unresolved，不静默只取首尾",
};

// ── 形态常量 ──
const DASHES = "\\-\\u2010-\\u2015~\\uff5e"; // - ‐ – — ― ~ ～
/** 连字符族（**条目号**分隔符）：`-` 与 U+2010；范围用 `–`/`—`/`~` 等，两者不可混同 */
const HYPHEN_LIKE = new Set(["-", "\u2010"]);
const DISPLAY_DOT = "[.\\uff0e]"; // . ．
const NUMBER = `\\d+(?:${DISPLAY_DOT}\\d+)*`;
/**
 * 引用 atom 的**输入 token 合法边界**（P1 集成复核第 1 条）：编号/子号后紧贴字母数字或 `.数字` 都不算合法结尾——
 * `§2.6abc` 不得被截短成 `§2.6`、`附录 E.5x` 不得被截短成 `附录 E.5`（完整引用认不出即 unresolved，
 * 不许拿前缀命中已知节）。中文紧跟（`§2.6 甲` / `§2.6甲`）仍是合法边界，保留「编号后中文解释」兼容。
 */
const ATOM_END_BOUNDARY = "(?![0-9A-Za-z])(?!\\.\\d)";
/**
 * 还须挡住**范围回退截断**：`§2.6–§2.9abc` 里 `§2.6–§2.9` 因尾随 `abc` 不合法，正则若回退成只匹配更短前缀
 * （乃至只匹配 `§2.6`）就是把完整引用截短命中已知节。故 atom 之后若还留着「范围分隔符 + 可选 § + 数字」，
 * 一律判该 atom 不完整（不匹配），整条 token 走「认不出 ⇒ unresolved」。
 * 分隔符**前也允许空白**（`§2.6 – §2.9abc` 里 `§2.6` 与 `–` 之间是一个空格）：否则空格一挡就回退成
 * 只命中 `§2.6`（P1 集成复核第 1 条的组合反例之一）。
 */
const NO_TRUNCATED_RANGE = `(?!\\s*[${DASHES}]\\s*(?:§)?\\s*\\d)`;
/**
 * 未被任何已解析 atom 覆盖的**显式标记**（P1 集成复核第 1 条「所有显式子目标都被解释或明确 unresolved」）：
 * 一条引用里「合法子目标 + 非法子目标」同现时，非法项此前会被静默丢掉、整条被错判 `resolved`。
 * 这里按显式 `§`/`附录 X` 标记（含其非法后缀字母数字或 `.数字`）在 atom 覆盖区间之外的残留逐条补
 * `unresolved(malformed)`，保证**不丢无法识别的显式编号**。
 */
const UNCOVERED_SECTION_MARKER_RE = new RegExp(`§\\s*${NUMBER}[0-9A-Za-z]*`, "g");
const UNCOVERED_APPENDIX_MARKER_RE = new RegExp(`附录\\s*[A-Za-z][0-9A-Za-z.\\uff0e${DASHES}]*`, "g");
/**
 * **裸续列**残留（无 `附录` 前缀的后续子号，如 `附录 E.5、E.7x` 里的 `E.7x`）——这不是新语法：
 * 解析器本就支持合法的裸续列（`附录 E.5、E.6` 由 `APPENDIX_ATOM_RE` 的裸分支解析）。这里只补
 * **认不出的续列项**（非法后缀）在显式附录标记之后的残留，保证「已支持语法下的未知子目标」也逐条 `unresolved`，
 * 不让合法项（`E.5`）把非法项（`E.7x`）掩盖成整条 `resolved`。调用处再按「字母与标记同字母 + 含数字/点」
 * 过滤，避免把 `附录 E.5 见 Excel` 这类正文英文单词误判为续列编号。
 */
const UNCOVERED_BARE_APPENDIX_RE = new RegExp(`[A-Za-z][0-9.\\uff0e${DASHES}][0-9A-Za-z.\\uff0e${DASHES}]*`, "g");
/** 裸续列必须**长得像子号**（至少含一个数字），否则不认（`Excel` / `DESIGN.md` 之类不是续列项） */
const BARE_APPENDIX_HAS_NUMBER_RE = /[0-9]/;
/**
 * `§2.8` / `§2.6–§2.9` / `§12.1-12`。第 3 组捕获分隔符字符，第 4 组捕获右端是否**显式带 §**——
 * `§2.6–§3` 的右端是显式章节，不是条目号，不得当条目落回左侧编号。
 */
const SECTION_ATOM_RE = new RegExp(
  `§\\s*(${NUMBER})(?:\\s*([${DASHES}])\\s*(§)?\\s*(${NUMBER}))?${ATOM_END_BOUNDARY}${NO_TRUNCATED_RANGE}`,
  "g",
);
/** `附录 E.5` / `附录 G-2` / 以及同一 token 里后续的裸编号 `E.6` / `G-4`（同样带输入 token 合法边界） */
const APPENDIX_ATOM_RE = new RegExp(
  `(附录\\s*)?([A-Za-z])((?:${DISPLAY_DOT}\\d+)*)((?:[${DASHES}]\\d+)*)${ATOM_END_BOUNDARY}${NO_TRUNCATED_RANGE}`,
  "g",
);

const normalizeNumber = (s: string): string => s.replace(/[\uff0e]/g, ".");
/**
 * 逐段解析编号：**每一段都必须是非负安全整数**，否则返回 null。
 * 超出安全整数的同首尾范围（如 `§9007199254740992–§9007199254740992`）里 `i++` 不再递增，
 * 放进展开循环就是无界挂起——所以先在这里判掉，绝不带着这种值进循环。
 */
function parseNumberParts(s: string): number[] | null {
  const parts = normalizeNumber(s).split(".").map((x) => Number(x));
  if (parts.length === 0) return null;
  for (const n of parts) {
    if (!Number.isSafeInteger(n) || n < 0) return null;
  }
  return parts;
}
const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * 编号前缀匹配：`^n(?![0-9A-Za-z])(?!\.\d)`。
 * 既让 `§2.6` 命中 `2.6 甲`、`§1` 命中 `1. 概述`（DESIGN 正文用 `## 1.` 写法），
 * 又不让 `§2` 误命中 `2.6 …`、`§2.6` 误命中 `2.60 …`／`2.6abc …`（字母与数字都是非法边界，
 * 不许拿「近似标题」当成功）。
 */
function numberMatcher(n: string): (title: string) => boolean {
  const re = new RegExp(`^${escapeRegex(normalizeNumber(n))}(?![0-9A-Za-z])(?!\\.\\d)`);
  return (title) => re.test(title);
}
/** 附录子节编号匹配：`E.5` 命中 `E.5 六图`，不命中 `E.5x`／`E.50`／`E.6`（大小写不敏感） */
function appendixNumberMatcher(letter: string, dotted: string): (title: string) => boolean {
  const l = `[${letter.toLowerCase()}${letter.toUpperCase()}]`;
  const re = new RegExp(`^${l}${escapeRegex(dotted)}(?![0-9A-Za-z])(?!\\.\\d)`);
  return (title) => re.test(title);
}
/** 附录连字符标题匹配：`附录 G-2` 命中 `## G-2 …`（存在该标题时**不得**退到「附录 G」大标题） */
function appendixHyphenMatcher(letter: string, suffix: string): (title: string) => boolean {
  const l = `[${letter.toLowerCase()}${letter.toUpperCase()}]`;
  const re = new RegExp(`^${l}${escapeRegex(suffix)}(?![0-9A-Za-z])(?!\\.\\d)`);
  return (title) => re.test(title);
}
/** 附录大标题匹配：`附录 E` 命中 `## 附录 E：…`（只有 token 只给字母时才用，绝不作回退） */
function appendixHeadMatcher(letter: string): (title: string) => boolean {
  const l = `[${letter.toLowerCase()}${letter.toUpperCase()}]`;
  const re = new RegExp(`^附录\\s*${l}(?![0-9A-Za-z])(?!\\.\\d)`);
  return (title) => re.test(title);
}

/** 在已解析章节树上按标题形态收集**全部**候选：0 个=missing、>1 个=ambiguous，都不选第一个 */
function lookupByMatcher(
  sections: readonly MarkdownSectionNode[],
  matches: (title: string) => boolean,
  tokenPart: string,
): StrictRefTarget {
  const candidates = sections.filter((s) => s.level >= 2 && matches(s.title));
  if (candidates.length === 0) return { token_part: tokenPart, resolution: "unresolved", reason: "missing" };
  if (candidates.length > 1) return { token_part: tokenPart, resolution: "unresolved", reason: "ambiguous" };
  const hit = candidates[0] as MarkdownSectionNode;
  // 唯一完整标题判据：候选还须通过「每一级路径唯一」的闸（重复父标题下也可能命中）
  const gate = findSectionInParsed(sections, hit.path);
  if (!gate.ok) {
    return { token_part: tokenPart, resolution: "unresolved", reason: gate.kind === "missing" ? "missing" : "ambiguous" };
  }
  return {
    token_part: tokenPart,
    resolution: "resolved",
    path: gate.section.path,
    sha256: gate.section.sha256,
    line_start: gate.section.line_start,
    line_end: gate.section.line_end,
  };
}

const MAX_RANGE_MEMBERS = 200;

/** 把 `a–b` 展开成全部成员编号（同前缀、末位递增）；不能证明完整展开就返回原因 */
function expandRange(n1: string, n2: string): { members: string[] } | { reason: StrictRefReason } {
  const a = parseNumberParts(n1);
  const b = parseNumberParts(n2);
  if (a === null || b === null || a.length !== b.length) return { reason: "malformed" };
  if (a.slice(0, -1).join(".") !== b.slice(0, -1).join(".")) return { reason: "malformed" };
  const start = a[a.length - 1] as number;
  const end = b[b.length - 1] as number;
  if (start > end) return { reason: "malformed" };
  // 成员数**显式有界**（start/end 已是安全整数，count 是有限正数）——不给循环留下界
  const count = end - start + 1;
  if (count > MAX_RANGE_MEMBERS) return { reason: "malformed" };
  const members: string[] = [];
  for (let k = 0; k < count; k++) members.push([...a.slice(0, -1), start + k].join("."));
  return { members };
}

/**
 * 一个 § 编号子目标 → target（0/1/多目标）。
 * `§2.8` 单个；`§2.6–§2.9` 范围（**必须含全部中间成员**；任一成员不能唯一解析 ⇒ 整条 unresolved，不取首尾）；
 * `§12.1-12` 末项层级更浅 + **连字符** + **右端不带 §** ⇒ 条目号，落回所属子节 `12.1`；
 * `§2.6–§3` 右端是**显式章节**（层级不齐又非条目写法）⇒ 无法证明完整展开，整条 unresolved。
 */
function numberTargets(
  n1: string,
  dash: string | undefined,
  sectMark: string | undefined,
  n2: string | null,
  rawText: string,
  sections: readonly MarkdownSectionNode[],
): StrictRefTarget[] {
  const asUnresolved = (reason: StrictRefReason): StrictRefTarget[] => [{ token_part: rawText.trim(), resolution: "unresolved", reason }];
  if (parseNumberParts(n1) === null) return asUnresolved("malformed");
  if (n2 === null) return [lookupByMatcher(sections, numberMatcher(n1), `§${normalizeNumber(n1)}`)];
  const a = parseNumberParts(n1);
  const b = parseNumberParts(n2);
  if (a === null || b === null) return asUnresolved("malformed");
  // 只有「明确条目语法」才读其所属子节：连字符族分隔、右端**不带 §**、且层级确实更浅
  const itemSyntax = sectMark === undefined && b.length < a.length && dash !== undefined && HYPHEN_LIKE.has(dash);
  if (itemSyntax) return [lookupByMatcher(sections, numberMatcher(n1), `§${normalizeNumber(n1)}`)];
  if (b.length !== a.length) return asUnresolved("malformed"); // 层级不齐又非条目写法 ⇒ 不猜、不吞右端
  const expanded = expandRange(n1, n2);
  if ("reason" in expanded) return asUnresolved(expanded.reason);
  const targets = expanded.members.map((m) => lookupByMatcher(sections, numberMatcher(m), `§${normalizeNumber(m)}`));
  if (targets.every((t) => t.resolution === "resolved")) return targets;
  const firstBad = targets.find((t) => t.resolution === "unresolved") as StrictUnresolvedTarget | undefined;
  return asUnresolved(firstBad?.reason ?? "missing");
}

/**
 * 附录子目标：只给字母=大标题；`X.N…`=该子节；带连字符段（条目号）=先看有无同名连字符标题。
 * - `附录 E.5` ⇒ 命中该子节；缺失子节**不降级**；
 * - `附录 C.5-1` ⇒ 无 `C.5-1` 标题时落回所属子节 `C.5`；
 * - `附录 G-2` ⇒ **存在 `G-2` 标题时必须命中它**（不得退到「附录 G」大标题）；不存在才落回 `附录 G`。
 */
function appendixTarget(
  letter: string,
  dotted: string,
  hyphen: string,
  tokenPart: string,
  sections: readonly MarkdownSectionNode[],
): StrictRefTarget {
  const d = normalizeNumber(dotted);
  if (hyphen !== "") {
    const itemHit = lookupByMatcher(sections, appendixHyphenMatcher(letter, d + hyphen), tokenPart);
    if (itemHit.resolution === "resolved" || itemHit.reason !== "missing") return itemHit;
  }
  if (d === "") return lookupByMatcher(sections, appendixHeadMatcher(letter), tokenPart);
  return lookupByMatcher(sections, appendixNumberMatcher(letter, d), tokenPart);
}

/** `**附录 D**` 之类加粗标记不改变判据：只剥掉 `**`/反引号，不剥文字 */
const stripEmphasis = (token: string): string => token.replace(/\*\*|`/g, "");

/** 设计书字样（`DESIGN`／`DESIGN.md`／`设计书`）：指名它就不该被当外部追溯而少读 */
const DESIGN_BOOK_MARKER_RE_SRC = "DESIGN(?:\\.md)?|设计书";
const DESIGN_BOOK_MARKER_TEST_RE = new RegExp(DESIGN_BOOK_MARKER_RE_SRC);

/** 这条 token 是否**指名设计书** */
export function namesDesignBook(token: string): boolean {
  return DESIGN_BOOK_MARKER_TEST_RE.test(token);
}

/** 完整标题路径形态：含 ` / ` 分级，或以「编号 + 空白 + 标题」起头（如 `2.6 甲`） */
const looksLikeTitlePath = (s: string): boolean => s.includes(" / ") || /^\d+(?:\.\d+)*\s+\S/.test(s);

type TitlePathMatch = { kind: "none" } | { kind: "ambiguous" } | { kind: "resolved"; target: StrictResolvedTarget };

/**
 * 完整标题路径引用（P1／§5.2「精确引用不应只支持编号」）：整条 token 去掉书名/引号包裹后，
 * **唯一精确**命中某章节的完整标题路径（或末级标题）。命中多处 ⇒ `ambiguous`（不选第一个）；命中不到 ⇒ `none`。
 * 设计书字样（`DESIGN.md`／`设计书`）按「原样」与「剥掉」两种写法各试一次——H1 标题本身可能就叫「…设计书」，
 * 剥掉反而会让整条路径匹配不上（如 `AM 设计书 / 2 核心 / 2.7 乙`）。
 */
function matchFullTitlePath(token: string, sections: readonly MarkdownSectionNode[]): TitlePathMatch {
  const normalize = (s: string): string => s.replace(/[《》「」“”‘’"]/g, " ").replace(/\s+/g, " ").trim();
  const stripped = stripEmphasis(token);
  const variants = [normalize(stripped), normalize(stripped.replace(new RegExp(DESIGN_BOOK_MARKER_RE_SRC, "g"), " "))].filter(
    (s, i, arr) => s !== "" && arr.indexOf(s) === i,
  );
  for (const cleaned of variants) {
    if (!looksLikeTitlePath(cleaned)) continue;
    const byPath = sections.filter((s) => s.level >= 2 && s.path === cleaned);
    const hits = byPath.length > 0 ? byPath : sections.filter((s) => s.level >= 2 && s.title === cleaned);
    if (hits.length === 0) continue;
    if (hits.length > 1) return { kind: "ambiguous" };
    const gate = findSectionInParsed(sections, (hits[0] as MarkdownSectionNode).path);
    if (!gate.ok) return { kind: gate.kind === "missing" ? "none" : "ambiguous" };
    return {
      kind: "resolved",
      target: {
        token_part: token.trim(),
        resolution: "resolved",
        path: gate.section.path,
        sha256: gate.section.sha256,
        line_start: gate.section.line_start,
        line_end: gate.section.line_end,
      },
    };
  }
  return { kind: "none" };
}

/**
 * 严格解析一条设计引用 token → 显式子目标列表。
 * - 逐个显式编号（`§2.8`、范围 `§2.6–§2.9`、`§2.6/§2.7`、附录子号 `附录 E.2`）**逐条输出**；
 * - 匹配一律走 materialSection 章节树（围栏感知、每级唯一），0 个=missing、>1 个=ambiguous，两种都 unresolved；
 * - 附录子节缺失**不**降级到附录大标题；范围只有可证明完整展开且每个成员唯一解析才整体 resolved；
 * - 认不出编号时再按**完整标题路径**唯一精确匹配；仍认不出 ⇒ 如实 `malformed`（不静默当“没引用”）。
 */
export function resolveDesignRefStrict(token: string, sections: readonly MarkdownSectionNode[]): StrictRefResolution {
  const text = stripEmphasis(token);
  const atoms: { index: number; target: StrictRefTarget }[] = [];
  /** 已被解析 atom 覆盖的文本区间（用于「显式标记不丢」的残留检测） */
  const covered: { start: number; end: number }[] = [];

  SECTION_ATOM_RE.lastIndex = 0;
  for (let m = SECTION_ATOM_RE.exec(text); m !== null; m = SECTION_ATOM_RE.exec(text)) {
    const n1 = m[1] as string;
    const dash = m[2];
    const sectMark = m[3];
    const n2 = m[4] ?? null;
    for (const t of numberTargets(n1, dash, sectMark, n2, m[0], sections)) atoms.push({ index: m.index, target: t });
    covered.push({ start: m.index, end: m.index + m[0].length });
  }

  // 附录：先认带「附录」前缀的显式目标；同一 token 里随后出现的裸编号（`E.6`）只有在
  // 「已见过附录标记 + 带数字后缀 + 字母与标记同字母」时才当作续列子目标（避免把正文里的字母误当引用）。
  APPENDIX_ATOM_RE.lastIndex = 0;
  let markerLetter: string | null = null;
  for (let m = APPENDIX_ATOM_RE.exec(text); m !== null; m = APPENDIX_ATOM_RE.exec(text)) {
    const withPrefix = m[1] !== undefined;
    const letter = m[2] as string;
    const dotted = m[3] ?? "";
    const hyphen = m[4] ?? "";
    if (withPrefix) {
      markerLetter = letter;
      atoms.push({ index: m.index, target: appendixTarget(letter, dotted, hyphen, `附录 ${letter}${normalizeNumber(dotted)}${hyphen}`, sections) });
      covered.push({ start: m.index, end: m.index + m[0].length });
      continue;
    }
    if (markerLetter === null || (dotted === "" && hyphen === "") || letter.toLowerCase() !== markerLetter.toLowerCase()) continue;
    atoms.push({ index: m.index, target: appendixTarget(letter, dotted, hyphen, `${letter}${normalizeNumber(dotted)}${hyphen}`, sections) });
    covered.push({ start: m.index, end: m.index + m[0].length });
  }

  // 残留显式标记（未落到任何 atom）：合法与非法子目标同现时，非法项**不得**被静默丢掉。
  // 只在**已有合法 atom** 时补报——一个 atom 都没认出的整条引用仍走下面的「整条认不出 ⇒ unresolved」，
  // 保持既有单目标形态（C8 的 `§2.6abc`／`§2.6–§2.9abc`／`附录 E.5x` 等断言不变）。
  const overlaps = (spans: readonly { start: number; end: number }[], start: number, end: number): boolean =>
    spans.some((r) => start < r.end && end > r.start);
  if (covered.length > 0) {
    const residual: { start: number; end: number }[] = [];
    for (const markerRe of [UNCOVERED_SECTION_MARKER_RE, UNCOVERED_APPENDIX_MARKER_RE]) {
      markerRe.lastIndex = 0;
      for (let m = markerRe.exec(text); m !== null; m = markerRe.exec(text)) {
        if (overlaps(covered, m.index, m.index + m[0].length) || overlaps(residual, m.index, m.index + m[0].length)) continue;
        residual.push({ start: m.index, end: m.index + m[0].length });
        atoms.push({
          index: m.index,
          target: { token_part: m[0].trim(), resolution: "unresolved", reason: "malformed" },
        });
      }
    }
    // ⑩ 裸续列残留（**已支持语法**下的未知子目标，不是新语法）：`附录 E.5、E.7x` 的 `E.7x`——
    // 有显式附录标记、字母与标记同字母、含数字/点、且不在任何已解析/已报区间内 ⇒ 逐条 unresolved(malformed)，
    // 不让合法项 `E.5` 把非法项 `E.7x` 掩盖成整条 resolved（同一根因的组合边界收口）。
    if (markerLetter !== null) {
      UNCOVERED_BARE_APPENDIX_RE.lastIndex = 0;
      for (let m = UNCOVERED_BARE_APPENDIX_RE.exec(text); m !== null; m = UNCOVERED_BARE_APPENDIX_RE.exec(text)) {
        if ((m[0].charAt(0) || "").toLowerCase() !== markerLetter.toLowerCase()) continue;
        if (!BARE_APPENDIX_HAS_NUMBER_RE.test(m[0])) continue;
        if (overlaps(covered, m.index, m.index + m[0].length) || overlaps(residual, m.index, m.index + m[0].length)) continue;
        residual.push({ start: m.index, end: m.index + m[0].length });
        atoms.push({
          index: m.index,
          target: { token_part: m[0].trim(), resolution: "unresolved", reason: "malformed" },
        });
      }
    }
  }

  // 去重（同 token 里同一位置重复列出只留一条），按出现顺序稳定输出
  const keyOf = (t: StrictRefTarget): string =>
    t.resolution === "resolved" ? `R:${t.path}` : `U:${t.token_part}:${t.reason}`;
  const seen = new Set<string>();
  const targets: StrictRefTarget[] = [];
  for (const a of atoms.sort((x, y) => x.index - y.index)) {
    const k = keyOf(a.target);
    if (seen.has(k)) continue;
    seen.add(k);
    targets.push(a.target);
  }
  if (targets.length === 0) {
    // 编号/附录一个都没认出：再按完整标题路径唯一精确匹配；仍认不出如实 unresolved（不静默当外部追溯）
    const m = matchFullTitlePath(text, sections);
    if (m.kind === "resolved") return { targets: [m.target], resolution: "resolved" };
    const reason: StrictRefReason = m.kind === "ambiguous" ? "ambiguous" : "malformed";
    return { targets: [{ token_part: text.trim(), resolution: "unresolved", reason }], resolution: "unresolved" };
  }
  return { targets, resolution: targets.every((t) => t.resolution === "resolved") ? "resolved" : "unresolved" };
}

/**
 * 非设计章节引用（需求 ID／审计报告／外部文档如 AGENTS.md/.工作台/**）的机械形态判据
 * （与 `blueprint.classifyDesignRefToken` 同款，另含外部文档/路径；文件名允许中日韩字符，
 * 如 `第三方说明.txt`——按「机械明确的外部文档」作追溯，不因它不是 ASCII 文件名就误当设计引用）。
 */
const FOREIGN_DOC_RE =
  /(?:req-[0-9A-Za-z][0-9A-Za-z-]*\d|需求\s*[＝=]|报告\s*\d|AGENTS|\.工作台\/|[0-9A-Za-z_\u3400-\u9fff][0-9A-Za-z_./\-\u3400-\u9fff]*\.(?:md|markdown|json|jsonc|ya?ml|txt|csv|ts|tsx|js|jsx|mjs|cjs|py|toml)\b)/;

/** 这条 token 是不是**机械明确的外部文档/需求/报告**（只有这一类才可当 `trace_reference`） */
export function isMechanicallyExternalRef(token: string): boolean {
  return FOREIGN_DOC_RE.test(token);
}

const SECTION_SYNTAX_RE = /§\s*\d|附录\s*[A-Za-z]/;

/**
 * token 是否含**显式设计章节编号**（`§N` / `附录 X`）——非章节类（需求 ID／报告／外部文档）不进章节解析。
 *
 * 判据是「外部文档字样出现在**章节编号之前**」：`docs/foo.md §5`、`报告 00 … §7`、`AGENTS §1` 的编号
 * 属于那份外部文档；而混合引用的设计部分照样保留——`DESIGN §2.6（见 docs/foo.md）` 里外部文档在括号内、
 * 在编号之后，**不得**因此把明确设计节整体降为追溯指针（P1 复核第 4 条）。
 */
export function hasDesignSectionSyntax(token: string): boolean {
  const m = SECTION_SYNTAX_RE.exec(token);
  if (m === null) return false;
  if (namesDesignBook(token)) return true; // 指名设计书：显式设计节与外部文档同现时保留设计部分
  return !FOREIGN_DOC_RE.test(token.slice(0, m.index));
}

/**
 * 这条 token 是否应当进**设计章节解析**（而不是当外部追溯指针）（P1 复核第 5 条 + 集成复核第 2 条）：
 * 显式章节编号（`§N`／`附录 X`）、指名设计书、**完整标题路径形态**（含 ` / ` 分级或以编号+标题起头）、
 * 或整条就是某章节的完整标题路径。**只有机械明确的外部文档/需求/报告**才作追溯；
 * **未知依据不得被静默省略**——认不出的设计引用照样进解析（⇒ `unresolved`），不当"确实外部"。
 */
export function isDesignRefToken(token: string, sections: readonly MarkdownSectionNode[]): boolean {
  if (hasDesignSectionSyntax(token)) return true;
  if (namesDesignBook(token)) return true;
  // 完整标题路径：**先**按实际章节树精确匹配（认不出也按形态判设计引用，不因认不出就降追溯）。
  if (matchFullTitlePath(token, sections).kind !== "none") return true;
  const external = isMechanicallyExternalRef(token);
  if (looksLikeTitlePath(stripEmphasis(token)) && !external) return true;
  // 机械明确外部文档/需求/报告才 trace；其余（未知依据）按设计引用解析（认不出 ⇒ unresolved，不悄悄省略）。
  return !external;
}
