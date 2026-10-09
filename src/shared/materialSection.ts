// 「明确 Markdown 章节绑定」的**唯一解析与哈希判据**（V09-42；docs/efficiency-20261004.md 第 2 条）。
//
// 为什么单独一份 shared：**三个消费者共用同一份口径**——阶段必读指针（`server/work/stageReads.ts`，
// v2 的 `generated_from` / `entries` 可显式点名章节）、同步检查（`server/work/syncChecks.ts` 的
// `markdown_section`）、以及机械生成脚本（`scripts/prepare-stage-reads.ts`）。谁也不许另写一套
// "章节怎么切、哈希怎么算"——一处放宽，别处就会出现"同一节算出两个哈希"的静默假绿。
//
// ── 口径（字节与换行规则，一个字节都不许含糊）──
//   ① **ATX 标题**：行首至多 3 个空格，1–6 个 `#`，其后必须是空白或行尾；标题文本 = 去掉前导 `#`
//      与尾部可选闭合 `#` 序列（闭合序列须由空白引出）后 `trim`。空标题合法（路径里就是空段）。
//   ② **代码围栏里的 `#` 行不是标题**：行首至多 3 个空格的 ``` 或 ~~~ 开启围栏，同字符、不短于
//      开启长度的围栏行关闭；围栏内部一律不产生标题（否则文档里贴一段示例 markdown 就能伪造章节）。
//   ③ **完整标题路径**：按标题层级维护祖先栈（进入新标题时先弹出层级 ≥ 本标题的项），用 `" / "`
//      连接各级标题文本。**每一级路径都必须唯一**：同一级路径出现两次（同级同名，或重复父标题导致
//      子节点路径同名）即无法唯一定位，选择器拒绝——**即使目标标题只出现一次，只要祖先链上有重复的
//      那一级也拒绝**。这就是"选择器每级唯一"的机器判据（判据在 `findSection`）。
//   ④ **章节正文 = 标题行 + 全部后代**：从标题行到"下一个层级 ≤ 本标题的行"之前（含全部后代子树），
//      **不含**下一同级/上级标题行。切行按 `/\r?\n/`，再以 `\n` 重新拼接：行内字符原样保留，
//      **行尾 CRLF 归一为 LF**；文件末尾的换行（split 出的空尾行）按其原样参与拼接。
//   ⑤ **sha256 = 上述正文字符串的 UTF-8 字节哈希**。无 `section` 时是**整文件原始字节**哈希
//      （v1 口径，逐字节、不归一），两者边界清晰：点名章节走本节判据，不点名走整文件。
//   ⑥ **非 Markdown / 非文本拒绝**：含 NUL 字节、或非合法 UTF-8（严格解码失败）一律拒；
//      开头 UTF-8 BOM 在读文本时剥掉（不参与标题解析，也不影响整文件字节哈希）。
//
// 本模块是**纯解析 + 哈希**：不吃任何注册表/项目根路径、不碰 fs、不写盘（文件读取由调用方负责），
// 所以 stageReads / syncChecks / 生成脚本拿到的永远是同一把尺子。
import crypto from "node:crypto";

/** 选择器（完整标题路径）长度上限（防把整篇正文塞进 section 冒充定位） */
export const MATERIAL_SECTION_SELECTOR_MAX = 2048;

/** 章节哈希口径的一句话（错误文案与报告引用同一句，避免各写各的） */
export const MATERIAL_SECTION_HASH_RULE =
  "章节正文 = 标题行到子树末行（含标题行与全部后代，不含下一个同级/上级标题行）；按 /\\r?\\n/ 切行后以 \\n 重新拼接（行尾 CRLF 归一为 LF，行内字符原样保留）；sha256 = 该字符串 UTF-8 字节的哈希；无 section 时按整文件原始字节哈希（v1 口径）";

export interface MarkdownSectionNode {
  /** ATX 层级 1–6 */
  level: number;
  /** 标题文本（去前导 `#` 与尾部闭合 `#`，trim；可为空串） */
  title: string;
  /** 完整标题路径（各级标题以 `" / "` 连接） */
  path: string;
  /**
   * 从根到本节点的**每一级**完整标题路径（末项 = `path`）。用于判「每一级路径都唯一」：同级同名、
   * 或重复父标题导致子节点路径同名，都会让某一级出现两次——该级无法唯一定位，选择器拒绝。
   */
  path_levels: string[];
  /** 标题行（1 基，闭） */
  line_start: number;
  /** 子树末行（1 基，闭） */
  line_end: number;
  /** 章节正文（标题行 + 全部后代）——哈希就是对它算 */
  content: string;
  /** 章节正文的 sha256（UTF-8 字节） */
  sha256: string;
}

export interface MarkdownSectionParseError {
  ok: false;
  reason: string;
}
export type MarkdownSectionParse = { ok: true; sections: MarkdownSectionNode[] } | MarkdownSectionParseError;

export type SectionDigestFailureCode = "not_text" | "bad_selector" | "missing" | "duplicate";
export type SectionDigest =
  | { ok: true; sha256: string; section: MarkdownSectionNode }
  | { ok: false; code: SectionDigestFailureCode; reason: string };

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
const ATX_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;

const sha256Hex = (data: string | Buffer): string => crypto.createHash("sha256").update(data).digest("hex");

/**
 * 严格解码 Markdown 文本：
 *   · 含 NUL 字节 → 拒绝（二进制/非文本，不能当 Markdown）；
 *   · 非合法 UTF-8 → 拒绝（严格解码，不用替换字符吞掉坏字节）；
 *   · 开头 UTF-8 BOM 剥掉（只影响文本解析；整文件字节哈希仍按原始字节，由调用方算）。
 */
export function decodeMarkdownBytes(bytes: Uint8Array): { ok: true; text: string } | { ok: false; reason: string } {
  if (bytes.includes(0)) return { ok: false, reason: "含 NUL 字节：是二进制/非文本文件，不能按 Markdown 章节定位" };
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (e) {
    return { ok: false, reason: `不是合法 UTF-8 文本（${e instanceof Error ? e.message : String(e)}）` };
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return { ok: true, text };
}

/** 围栏跟踪：返回是否处于围栏内、以及本行是否开启/关闭围栏后的新状态 */
function fenceStep(line: string, open: { char: string; len: number } | null): { char: string; len: number } | null {
  const m = FENCE_RE.exec(line);
  if (open === null) {
    if (m === null) return null;
    const seq = m[1] as string;
    return { char: seq[0] as string, len: seq.length };
  }
  // 关闭围栏：同字符、不短于开启长度、其后只有空白
  const ch = open.char;
  const closeRe = new RegExp(`^ {0,3}${ch === "`" ? "`" : "~"}{${open.len},}[ \\t]*$`);
  return closeRe.test(line) ? null : open;
}

/** 解析 ATX 标题树（围栏内的 `#` 行不算标题）。空文档/无标题 → ok + 空数组。 */
export function parseMarkdownSections(text: string): MarkdownSectionParse {
  const lines = text.split(/\r?\n/);
  const heads: { level: number; title: string; index: number }[] = [];
  let fence: { char: string; len: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const nextFence = fenceStep(line, fence);
    if (fence !== null) {
      fence = nextFence;
      continue;
    }
    if (nextFence !== null) {
      fence = nextFence;
      continue;
    }
    const m = ATX_RE.exec(line);
    if (m === null) continue;
    // 尾部闭合 `#` 序列（须由空白引出）；在**去前导后的原样串**上剥，再 trim。
    const raw = (m[2] ?? "").replace(/[ \t]+#+[ \t]*$/, "");
    heads.push({ level: (m[1] as string).length, title: raw.trim(), index: i });
  }
  const sections: MarkdownSectionNode[] = [];
  // 祖先栈：进入一个标题前，先弹出所有层级 ≥ 本标题的项；栈里剩下的就是真正的祖先链（层级严格递减）。
  const stack: { level: number; title: string }[] = [];
  for (let h = 0; h < heads.length; h++) {
    const head = heads[h] as { level: number; title: string; index: number };
    while (stack.length > 0 && (stack[stack.length - 1] as { level: number }).level >= head.level) stack.pop();
    // 子树末行：下一个层级 ≤ 本标题的行之前
    let endIdx = lines.length;
    for (let j = h + 1; j < heads.length; j++) {
      if ((heads[j] as { level: number }).level <= head.level) {
        endIdx = (heads[j] as { index: number }).index;
        break;
      }
    }
    // 每一级完整标题路径（从根逐级累积）——按段 join，**不拆选择器文本**（标题本身可含 `" / "`）。
    const titles = stack.map((a) => a.title);
    const path_levels: string[] = [];
    for (let k = 1; k <= titles.length; k++) path_levels.push(titles.slice(0, k).join(" / "));
    path_levels.push([...titles, head.title].join(" / "));
    const content = lines.slice(head.index, endIdx).join("\n");
    sections.push({
      level: head.level,
      title: head.title,
      path: path_levels[path_levels.length - 1] as string,
      path_levels,
      line_start: head.index + 1,
      line_end: endIdx,
      content,
      sha256: sha256Hex(content),
    });
    stack.push({ level: head.level, title: head.title });
  }
  return { ok: true, sections };
}

/** 选择器合法性：非空、≤ 上限、无控制字符（含换行/NUL/Tab）。返回问题文案或 null。 */
export function sectionSelectorProblem(selector: unknown): string | null {
  if (typeof selector !== "string") return `section 必须是字符串，收到 ${JSON.stringify(selector)}`;
  const s = selector.trim();
  if (s === "") return "section 不能为空（完整标题路径）";
  if (s.length > MATERIAL_SECTION_SELECTOR_MAX) return `section 超长（> ${MATERIAL_SECTION_SELECTOR_MAX}）`;
  if (/[\u0000-\u001f\u007f]/.test(s)) return "section 不许含控制字符（换行/制表/NUL 等）";
  return null;
}

export type SectionLookupFailure = { ok: false; kind: "bad_selector" | "missing" | "duplicate"; reason: string };
export type SectionLookupResult = { ok: true; section: MarkdownSectionNode } | SectionLookupFailure;

/**
 * 按完整标题路径在**已解析的章节树**上唯一定位章节。`findSection` 与严格设计引用解析
 * （`src/shared/designRefStrict.ts`）共用这一份判据——「每级唯一」只有一处实现。
 *
 * **缺失/重复（同级同名、重复父标题、跨支同名）/选择器非法**都返回失败并点名原因。
 * 只按算出的 `path` 精确相等匹配——不拆选择器文本（标题本身可含 `" / "`，拆解会误判）。
 * **每一级路径都须唯一**：命中项的祖先链上任一级出现两次（如重复父标题下子标题只出现一次）也拒绝。
 */
export function findSectionInParsed(sections: readonly MarkdownSectionNode[], selector: string): SectionLookupResult {
  const problem = sectionSelectorProblem(selector);
  if (problem !== null) return { ok: false, kind: "bad_selector", reason: problem };
  const wanted = selector.trim();
  // 每个**节点路径**出现的次数（只数 `path` 本身，不能数前缀，否则共享祖先会被子树大小重复计）。
  const pathCounts = new Map<string, number>();
  for (const s of sections) pathCounts.set(s.path, (pathCounts.get(s.path) ?? 0) + 1);
  const hits = sections.filter((s) => s.path === wanted);
  if (hits.length === 0) {
    return { ok: false, kind: "missing", reason: `没有完整标题路径为 ${JSON.stringify(wanted)} 的章节（缺失即拒，不硬凑）` };
  }
  if (hits.length > 1) {
    return {
      ok: false,
      kind: "duplicate",
      reason: `完整标题路径 ${JSON.stringify(wanted)} 命中 ${hits.length} 处（同级同名标题重复），无法唯一定位——每级标题必须唯一`,
    };
  }
  const hit = hits[0] as MarkdownSectionNode;
  const dupLevel = hit.path_levels.find((level) => (pathCounts.get(level) ?? 0) > 1);
  if (dupLevel !== undefined) {
    return {
      ok: false,
      kind: "duplicate",
      reason: `选择器 ${JSON.stringify(wanted)} 的某一级路径 ${JSON.stringify(dupLevel)} 在文档里出现多次（每级完整标题路径必须唯一）——重复父标题下即使本标题只出现一次也无法唯一定位`,
    };
  }
  return { ok: true, section: hit };
}

/**
 * 按完整标题路径唯一定位章节（解析文本 → 复用 `findSectionInParsed`）。**行为一字不变**：
 * 仅把判据本体抽到 `findSectionInParsed` 以便严格设计引用解析复用同一把尺子。
 */
export function findSection(text: string, selector: string): SectionLookupResult {
  const problem = sectionSelectorProblem(selector);
  if (problem !== null) return { ok: false, kind: "bad_selector", reason: problem };
  const parsed = parseMarkdownSections(text);
  if (!parsed.ok) return { ok: false, kind: "bad_selector", reason: parsed.reason };
  return findSectionInParsed(parsed.sections, selector);
}

/**
 * 读到的字节 + 显式 section → 章节子树哈希。**给 sync / stage-reads / 生成脚本共用的唯一入口**。
 * `code` 让调用方把「非文本」与「章节缺失/重复」映射到不同裁决（invalid vs failed），不各写各的。
 */
export function markdownSectionDigest(bytes: Uint8Array, selector: string): SectionDigest {
  const decoded = decodeMarkdownBytes(bytes);
  if (!decoded.ok) return { ok: false, code: "not_text", reason: decoded.reason };
  const found = findSection(decoded.text, selector);
  if (!found.ok) return { ok: false, code: found.kind, reason: found.reason };
  return { ok: true, sha256: found.section.sha256, section: found.section };
}
