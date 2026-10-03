// MCP 只读读口（read_design / read_plan）共用的**完整版本续读**实现
// —— 2026-10-03 统一优化 U3（DESIGN.md §6.8；docs/unified-optimization-contract.md U3；PLAN V09-33）。
//
// 为什么需要它：接续入口 project_entry 的上下文包过去会给 `tctx1:<内容哈希前 16 位>:lines:<N>` 形态的
// 续读游标，但该形态**只覆盖 16 位前缀、不绑定项目/文档**，不足以证明完整内容未变；而 MCP 读口
// （read_design/read_plan）当时没有消费入口。本模块把「按完整来源版本续读」接到只读读口上：
//
//   · **完整版本**：只认新格式 `tcur1:<doc>:<bind16>:<fullsha64>:<lines>:<start>`（shared/continuationCursor.ts），
//     校验项目/文档绑定与完整 64 位内容哈希（同 16 位前缀但完整哈希不同＝源变，绝不误接续）；
//   · **旧游标明确失效**：遇到旧 `tctx1` 前缀，**不做前缀近似接续**——解释它只能定位、不能证明完整一致，
//     要求按当前原文重新取（fail-closed，不静默给旧内容）；
//   · **不空包成功**：页窗口至少 1 行、起点超过末行报 `RANGE_EXHAUSTED`；**文档以换行收尾时末尾空行不单独成页**
//     （游标落在该空行上同样按 `RANGE_EXHAUSTED` 明确失败），源读不到/游标不可证时明确失败，
//     绝不返回 `content: ""` 的"成功页"，且逐页拼接仍逐字节等于全文（L1 复审修正）；
//   · **进程内包不伪装持久**：本续读只由**调用当刻现读的原文内容哈希**派生，不依赖服务端内存里的
//     上下文包注册表（context.ts 的 `PACKAGES`）；重启后旧游标只会明确报源变/失效——回执里的
//     `persistence` 字段如实标注这一点（见 `CONTINUATION_PERSISTENCE`）；
//   · **只读**：不写盘、不调模型。
import {
  CONTINUATION_PAGE_MAX_CHARS,
  cursorBinding,
  isLegacyCursor,
  makeProjectCursor,
  parseProjectCursor,
  verifyProjectCursor,
  type CursorDoc,
} from "../../shared/continuationCursor";
import { sha256Hex, sliceDocumentLines, type DocumentSlice } from "./documents";

// 单页字符预算与游标都从**纯 shared** 取（不再从 context.ts import：那会与 context 的续读接线成环）。
export { CONTINUATION_PAGE_MAX_CHARS };

/** 回执里对“游标寿命”的如实说明（进程内包不是事实源） */
export const CONTINUATION_PERSISTENCE = {
  kind: "content_derived",
  restart_safe: true,
  depends_on_in_process_package: false,
  note:
    "游标由**调用当刻现读的原文内容哈希**派生（新格式含完整 64 位 sha 与项目/文档绑定），" +
    "不依赖服务端内存里的上下文包注册表：**服务重启后，只要源未变，这个游标依然有效、可以接着读**" +
    "（重启只丢进程内包，不使基于内容哈希的无状态游标失效）；**只有源变了**（完整哈希对不上）才明确报 `SOURCE_CHANGED`，" +
    "也不会返回空包成功。若拿到的是旧 `tctx1` 短前缀游标（来自进程内包），它只能定位、不能当完整版本证明——请按当前原文重新取。",
} as const;

export type ContinuationFailureCode =
  | "INVALID_CURSOR"
  | "LEGACY_CURSOR"
  | "CROSS_DOC"
  | "CROSS_PROJECT"
  | "SOURCE_CHANGED"
  | "RANGE_EXHAUSTED";

export interface ContinuationFailure {
  code: ContinuationFailureCode;
  message: string;
  detail: Record<string, unknown>;
}

export interface ContinuationPage {
  /** 本次用的游标（原样回显） */
  cursor: string;
  slice: DocumentSlice;
  /** 下一页的完整版本游标；已到文末为 null（不伪造下一页） */
  next_cursor: string | null;
  total_lines: number;
  page_max_chars: number;
  /** 页窗口的行范围（1 基闭区间，便于调用方与 slice 对账） */
  line_start: number;
  line_end: number;
}

export interface ContinuationOutcome {
  ok: boolean;
  page?: ContinuationPage;
  failure?: ContinuationFailure;
}

export interface ContinuationInput {
  /** 目标文档全文（**逐字节原文**） */
  text: string;
  /** 目标项目 id（游标项目绑定的校验基准） */
  projectId: string;
  /** 目标文档种类（design/plan） */
  doc: CursorDoc;
  /** 报错文案里的源名（如 `PLAN.md`） */
  sourceLabel: string;
  /** 调用方原样回传的游标 */
  cursorRaw: string;
  /** 页预算（缺省与上下文包同口径） */
  pageMaxChars?: number;
}

/** 旧 `tctx1:<hex8-64>:lines|bytes:<N>` 的“仅定位”解释（不构成完整版本证明，故只用于失败详情） */
function locateLegacyCursor(raw: string): Record<string, unknown> | null {
  const m = new RegExp(`^tctx1:([0-9a-f]{8,64}):(lines|bytes):(\\d+)$`).exec(raw.trim());
  if (m === null) return null;
  return { prefix_version: m[1], unit: m[2], start: Number(m[3]) };
}

function fail(code: ContinuationFailureCode, message: string, detail: Record<string, unknown>): ContinuationOutcome {
  return { ok: false, failure: { code, message, detail } };
}

/**
 * 校验游标并取“从该行起的下一页”。绝不返回空页（至少 1 行；起点超末行＝RANGE_EXHAUSTED 明确失败）。
 */
export function readContinuationPage(input: ContinuationInput): ContinuationOutcome {
  const { text, projectId, doc, sourceLabel, cursorRaw } = input;
  const pageMaxChars = Math.max(200, input.pageMaxChars ?? CONTINUATION_PAGE_MAX_CHARS);

  if (isLegacyCursor(cursorRaw)) {
    // 旧短前缀游标：可以定位，但不能证明完整一致（契约 U3）→ 明确失效，要求重取，不做前缀近似接续。
    const located = locateLegacyCursor(cursorRaw);
    return fail(
      "LEGACY_CURSOR",
      `旧短前缀游标（tctx1）不能作为**当前版本的校验依据**：它只带内容哈希前 16 位、且不绑定项目/文档，` +
        `无法证明${sourceLabel}的完整内容未变（同前缀可能对应不同完整内容）。` +
        "已明确失效——请用 index/task_id/range/section 按**当前**原文重新定位，或重新取 project_entry 的上下文；" +
        "需要跨页续读时，用本工具返回的新格式 `tcur1:…` 完整版本游标（含完整 64 位 sha 与项目/文档绑定）。",
      { cursor: cursorRaw, source: sourceLabel, legacy_located: located, replacement: "tcur1（完整 sha + 项目/文档绑定）" },
    );
  }

  const cursor = parseProjectCursor(cursorRaw);
  if (cursor === null) {
    return fail(
      "INVALID_CURSOR",
      `续读游标形态不合法：${JSON.stringify(cursorRaw)}。` +
        "新格式形如 `tcur1:<design|plan>:<绑定16位>:<完整sha64>:lines:<起始行>`（由本工具的续读回执给出）；" +
        "形态不对就不猜，改用 index/task_id/range/section 读",
      { cursor: cursorRaw, source: sourceLabel },
    );
  }
  if (cursor.unit !== "lines") {
    return fail(
      "INVALID_CURSOR",
      `续读游标当前只支持 \`lines\` 单位，收到 ${JSON.stringify(cursor.unit)}：不改用近似口径，请用 range 读`,
      { cursor: cursorRaw, unit: cursor.unit, source: sourceLabel },
    );
  }

  const fullSha = sha256Hex(text);
  const check = verifyProjectCursor(cursor, { projectId, doc, fullSha });
  if (!check.ok) {
    return fail(check.code, check.message, { ...check.detail, source: sourceLabel });
  }

  const lines = text.split("\n");
  const totalLines = lines.length;
  if (cursor.start > totalLines) {
    return fail(
      "RANGE_EXHAUSTED",
      `游标起点 ${cursor.start} 超过 ${sourceLabel} 的末行（共 ${totalLines} 行）：已到文末之后，没有下一页`,
      { start: cursor.start, lines: totalLines, source: sourceLabel },
    );
  }

  // 页窗口：从 start 行起累加字符，直到超过页预算（至少给 1 行，保证永不返回空页）
  let end = cursor.start;
  let chars = 0;
  while (end <= totalLines) {
    const lineChars = lines[end - 1].length + 1; // +1 ≈ 行尾换行，与 sliceDocumentLines 同口径
    if (end > cursor.start && chars + lineChars > pageMaxChars) break;
    chars += lineChars;
    end += 1;
  }
  const last = Math.min(end - 1, totalLines);
  const slice = sliceDocumentLines(text, cursor.start, last);
  // L1 复审修正：文档以换行收尾时 `split("\n")` 会多出一个末尾空行。若游标正好落在那个空行上，
  // 这里曾返回一页 `content: ""` 的"成功页"（与文件头"绝不返回空包成功"相悖，调用方还得多跑一趟）。
  // 空内容的页 = 已到文末，明确按 RANGE_EXHAUSTED 失败，不伪装成功。
  if (slice.content === "") {
    return fail(
      "RANGE_EXHAUSTED",
      `续读已到 ${sourceLabel} 文末（末尾空行不单独成页，共 ${totalLines} 行）：这一段已无内容可读`,
      { start: cursor.start, lines: totalLines, source: sourceLabel, reason: "trailing_blank_line" },
    );
  }
  // 下一页游标：只在**下一段仍有非空内容**时给出——末尾那个空行不再单开一页，拼接仍逐字节等于全文。
  const nextStart = last + 1;
  const remaining = nextStart <= totalLines ? lines.slice(nextStart - 1).join("\n") : "";
  const next_cursor = remaining === "" ? null : makeProjectCursor(projectId, doc, fullSha, "lines", nextStart);
  const page: ContinuationPage = {
    cursor: cursor.raw,
    slice,
    next_cursor,
    total_lines: totalLines,
    page_max_chars: pageMaxChars,
    line_start: slice.line_start,
    line_end: slice.line_end,
  };
  return { ok: true, page };
}

/** 给续读回执用的元数据块（read_design/read_plan 共用同一形状） */
export function continuationPayload(page: ContinuationPage, projectId: string, doc: CursorDoc, fullSha: string): Record<string, unknown> {
  return {
    cursor: page.cursor,
    next_cursor: page.next_cursor,
    total_lines: page.total_lines,
    page_max_chars: page.page_max_chars,
    source_version: {
      project_id: projectId,
      doc,
      content_sha256: fullSha,
      binding: cursorBinding(projectId, doc, fullSha),
    },
    persistence: { ...CONTINUATION_PERSISTENCE },
    note: page.next_cursor === null ? "已读到文末（next_cursor=null）" : "按完整来源版本续读；next_cursor 为下一页游标",
  };
}

/**
 * 从一段自由文本里扫出续读游标 token（新格式与旧格式都扫，便于如实标注"哪些还需重取"）。
 * 只做识别，不校验版本——校验在 `readContinuationPage` 里按当前源进行。
 */
export function findContinuationCursors(text: string): { token: string; kind: "current" | "legacy" }[] {
  if (typeof text !== "string" || text === "") return [];
  const re = /(tcur1:[a-z]+:[0-9a-f]{16}:[0-9a-f]{64}:(?:lines|bytes):\d+|tctx1:[0-9a-f]{8,64}:(?:lines|bytes):\d+)/g;
  const out: { token: string; kind: "current" | "legacy" }[] = [];
  const seen = new Set<string>();
  for (const m of text.match(re) ?? []) {
    if (seen.has(m)) continue;
    seen.add(m);
    out.push({ token: m, kind: m.startsWith("tcur1:") ? "current" : "legacy" });
  }
  return out;
}
