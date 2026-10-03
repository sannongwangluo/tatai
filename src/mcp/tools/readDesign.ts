// read_design：读项目设计书 + 待议记录（DESIGN.md §6.3 第三行；分段读见 V07-04 附录 C.5-4）。
// 只读：全 server 不存在 write_design 工具（§6.3 硬性权限约束），设计书只有 Flash 落稿 / Max 审改两条笔。
//
// 分段读（V07-04）为什么加：接手 agent 面对几百节的设计书，一次读全文既烧上下文又难定位；
// 但"省着读"必须保证不丢字节——所以 section/range 切出来的是**原文切片**（含行尾换行），
// 按行序首尾相接拼回去与全文逐字节相同（切片自带 sha256，调用方可以自己核对）。
// 章节口径直接复用 documents.ts 的章节索引（buildSectionIndex），不在这里另立一套切段规则。
import { buildSectionIndex, sha256Hex, sliceDocumentLines, sliceDocumentSection } from "../../server/work/documents";
import {
  CONTINUATION_PAGE_MAX_CHARS,
  continuationPayload,
  readContinuationPage,
} from "../../server/work/continuation";
import { isWorkError, WorkError } from "../../server/work/types";
import { readDesign, readDiscuss } from "../../server/workstation";
import { errorResult, textResult, type McpTool } from "./types";

interface LineRange {
  from_line: number;
  to_line: number;
}

/** range 入参的严格解析：只收 {from_line, to_line} 两个整数，多键/缺键一律拒（不在工具层猜） */
function parseRange(value: unknown): LineRange {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WorkError("INVALID_COMMAND", "range 必须是 {from_line, to_line}（1 基、闭区间，均含）", { got: value });
  }
  const raw = value as Record<string, unknown>;
  const extra = Object.keys(raw).filter((k) => k !== "from_line" && k !== "to_line");
  if (extra.length > 0) {
    throw new WorkError("INVALID_COMMAND", `range 只收 from_line / to_line，多出来的键一律拒：${extra.join("、")}`, {
      extra,
    });
  }
  const from = raw.from_line;
  const to = raw.to_line;
  if (typeof from !== "number" || typeof to !== "number" || !Number.isInteger(from) || !Number.isInteger(to)) {
    throw new WorkError("INVALID_COMMAND", "range.from_line / range.to_line 必须是整数行号（1 基、闭区间）", {
      from_line: from,
      to_line: to,
    });
  }
  return { from_line: from, to_line: to };
}

export const readDesignTool: McpTool = {
  name: "read_design",
  description:
    "读项目 design.md + 待议记录（只读；设计书只能由落稿/审改流程改，agent 有异议请用 append_discuss）（DESIGN.md §6.3）。" +
    "分段读（V07-04）：section=章节标题或路径（精确匹配，如 “6. MCP 接口设计 / 6.4 扩展工具”）/" +
    "range={from_line,to_line}（1 基闭区间，均含）/ index=true 只列章节索引；" +
    "切出来的片段按行序首尾相接与全文逐字节一致（已含行尾换行，片段附 sha256 自证）",
  inputSchema: {
    type: "object",
    properties: {
      project_id: { type: "string", description: "注册表里的项目 id" },
      section: { type: "string", description: "章节标题或标题路径（与章节索引精确匹配）；与 range 二选一" },
      range: {
        type: "object",
        description: "行范围（1 基、闭区间、均含）；与 section 二选一",
        properties: { from_line: { type: "number" }, to_line: { type: "number" } },
        required: ["from_line", "to_line"],
        additionalProperties: false,
      },
      index: { type: "boolean", description: "true = 只列章节索引（level/title/path/行范围），不返回正文" },
      cursor: {
        type: "string",
        description:
          "完整版本续读游标（`tcur1:<design|plan>:<绑定16位>:<完整sha64>:lines:<起始行>`）。" +
            "游标绑定项目/文档与完整内容哈希：跨项目/跨文档/源变都会明确报错；旧 `tctx1` 短前缀游标只定位、不能当完整版本证明，会被拒绝并要求重取（DESIGN §6.8／契约 U3）",
      },
    },
    required: ["project_id"],
    additionalProperties: false,
  },
  handler: (args) => {
    const projectId = typeof args.project_id === "string" ? args.project_id.trim() : "";
    if (projectId === "") {
      return errorResult("read_design 缺入参 project_id");
    }
    const section = typeof args.section === "string" ? args.section.trim() : "";
    const cursor = typeof args.cursor === "string" ? args.cursor.trim() : "";
    const wantsIndex = args.index === true;
    const hasRange = args.range !== undefined;
    if (section !== "" && hasRange) {
      return errorResult("read_design 的 section 与 range 只能给一个（给两个＝没说清读哪一段）");
    }
    const locators = [...(section === "" ? [] : ["section"]), ...(hasRange ? ["range"] : []), ...(cursor === "" ? [] : ["cursor"])];
    if (locators.length > 1) {
      return errorResult(
        `read_design 的定位参数只能给一个（收到 ${locators.join("、")}）：section 按章节、range 按行范围、cursor 续读，多给＝没说清读哪一段`,
      );
    }
    if (wantsIndex && locators.length > 0) {
      return errorResult(`read_design 的 index=true 与 ${locators[0]} 不能同时给（index 只列章节索引，不返回正文）`);
    }
    const design = readDesign(projectId);
    const discuss = readDiscuss(projectId);
    const discussPayload = discuss.exists
      ? { exists: true, source: discuss.source, count: discuss.count, content: discuss.content }
      : { exists: false };
    if (!design.exists) {
      // 设计书不在场时照旧如实报空态；分段读没有正文可切，明确说明，不假装切出空段
      return textResult(
        JSON.stringify(
          { design: { exists: false }, discuss: discussPayload, slice: null, note: "设计书不存在，无从分段读" },
          null,
          2,
        ),
      );
    }
    const text = design.content;
    const lineCount = text.split("\n").length;
    // 全文哈希：调用方把各段拼回去后算同一个哈希，就能自证"没漏字节"（分段读的核心验收口径）
    const fullSha = sha256Hex(text);
    try {
      if (wantsIndex) {
        return textResult(
          JSON.stringify(
            {
              design: {
                exists: true,
                source: design.source,
                lines: lineCount,
                sha256: fullSha,
                sections: buildSectionIndex(text).map((s) => ({
                  level: s.level,
                  title: s.title,
                  path: s.path,
                  line_start: s.line_start,
                  line_end: s.line_end,
                })),
              },
              discuss: discussPayload,
              slice: null,
            },
            null,
            2,
          ),
        );
      }
      if (cursor !== "") {
        const outcome = readContinuationPage({
          text,
          projectId,
          doc: "design",
          sourceLabel: design.source ?? "design.md",
          cursorRaw: cursor,
          pageMaxChars: CONTINUATION_PAGE_MAX_CHARS,
        });
        if (!outcome.ok) {
          const f = outcome.failure!;
          return errorResult(JSON.stringify({ ok: false, code: f.code, message: f.message, detail: f.detail }, null, 2));
        }
        const page = outcome.page!;
        return textResult(
          JSON.stringify(
            {
              design: {
                exists: true,
                source: design.source,
                lines: lineCount,
                sha256: fullSha,
                content: page.slice.content,
              },
              discuss: discussPayload,
              slice: {
                kind: "cursor",
                selector: cursor,
                line_start: page.slice.line_start,
                line_end: page.slice.line_end,
                chars: page.slice.content.length,
                sha256: page.slice.sha256,
                section: null,
              },
              continuation: continuationPayload(page, projectId, "design", fullSha),
            },
            null,
            2,
          ),
        );
      }
      if (section !== "" || hasRange) {
        const range = hasRange ? parseRange(args.range) : null;
        const sliced =
          section !== "" ? sliceDocumentSection(text, section) : sliceDocumentLines(text, range!.from_line, range!.to_line);
        return textResult(
          JSON.stringify(
            {
              design: {
                exists: true,
                source: design.source,
                lines: lineCount,
                sha256: fullSha,
                content: sliced.content,
              },
              discuss: discussPayload,
              slice: {
                kind: section !== "" ? "section" : "range",
                selector: section !== "" ? section : range,
                line_start: sliced.line_start,
                line_end: sliced.line_end,
                chars: sliced.content.length,
                sha256: sliced.sha256,
                section:
                  sliced.section === null
                    ? null
                    : {
                        level: sliced.section.level,
                        title: sliced.section.title,
                        path: sliced.section.path,
                        line_start: sliced.section.line_start,
                        line_end: sliced.section.line_end,
                      },
              },
            },
            null,
            2,
          ),
        );
      }
      return textResult(
        JSON.stringify(
          { design: { exists: true, source: design.source, content: text }, discuss: discussPayload, slice: null },
          null,
          2,
        ),
      );
    } catch (e) {
      if (isWorkError(e)) {
        const detail = e.detail ?? {};
        return errorResult(
          JSON.stringify({ ok: false, code: e.code, message: e.message, detail }, null, 2),
        );
      }
      return errorResult(`read_design 失败：${e instanceof Error ? e.message : String(e)}`);
    }
  },
};
