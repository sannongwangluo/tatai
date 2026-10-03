// read_plan：读项目**施工图（PLAN.md）原文**（按卡／索引／章节／行范围／完整版本续读游标）
// —— 2026-10-03 统一优化 U3（DESIGN.md §6.8；docs/unified-optimization-contract.md U3；PLAN V09-32/33）。
//
// 为什么需要它：`read_design` 一直支持分段读，施工图没有对应入口。接手 agent 想知道「我这张卡写了什么」，
// 过去只有两条路：整份读几百 KB 的 PLAN.md，或调 `list_tasks`——而 `list_tasks` 读的是**执行台账**
// （未导入时为空），**不是施工定义原文**。本工具补上按卡取材这条路，并复用 `documents.ts` 的分段实现。
//
// 判据（契约 U3，别改口径）：
//   · **存在判据＝施工图原文的解析结果**：卡只要在卡表里能被解析出来，就能取它的卡区原文；
//     台账有没有导入只影响任务**状态**，不影响**定义原文**是否可取（「未入账定义可见」）。
//   · 三种「没有」**分开表达**：① 卡不在卡表（`CARD_NOT_FOUND`＋`known_ids`）；
//     ② 卡在卡表但没定位到卡区（成功返回＋`card.section_found=false`＋下一步建议）；
//     ③ 施工图源缺失／没有合格卡表（如实说明）。
//   · 切片与全文逐字节自洽：切片内容在 **`plan.content`**、`slice` 只带元数据（行范围/chars/sha256），
//     与 `read_design` 的 `design.content`＋`slice` **同一形状**（同一个 documents.ts 分段实现）。
//   · 续读游标走 `continuation.ts` 的**完整版本**机制（完整 sha + 项目/文档绑定；旧 `tctx1` 明确失效重取）。
//   · **只读**：不存在 write_plan（§6.3 硬性权限约束）；施工图只能由施工者同步自己卡的真实状态。
//   · 对外只给**项目根内相对路径**（`plan.source`），不外发本机绝对路径。
import {
  buildSectionIndex,
  loadDocument,
  sliceDocumentLines,
  sliceDocumentSection,
  type DocumentSlice,
} from "../../server/work/documents";
import { CONTINUATION_PAGE_MAX_CHARS, continuationPayload, readContinuationPage } from "../../server/work/continuation";
import { importTaskDefinitions } from "../../server/work/plan";
import { isWorkError, WorkError } from "../../server/work/types";
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

/** `slice` 元数据（与 read_design 同形状；内容在 `plan.content`，不在这里重复一份） */
function sliceMetaOf(kind: string, selector: unknown, sliced: DocumentSlice): Record<string, unknown> {
  return {
    kind,
    selector,
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
  };
}

export const readPlanTool: McpTool = {
  name: "read_plan",
  description:
    "读项目**施工图原文**（只读；PLAN.md 或登记的项目根内施工图源）（DESIGN.md §6.8／契约 U3）。" +
    "五档读取（**除 index 外的定位参数最多给一个，多给即拒**）：`index=true` 列全部卡（卡号／交付目标／卡区行范围／定义哈希）与章节索引；" +
    "`task_id=<卡号>` 取该卡卡区原文；`range={from_line,to_line}`（1 基闭区间）取行范围；`section=<章节标题或路径>` 取章节；" +
    "`cursor=<完整版本续读游标>` 从上一页的 `tcur1:…` 游标继续读。分段读时**切片内容在 `plan.content`**、" +
    "`slice` 只带 `line_start/line_end/chars/sha256`（与 read_design 同一形状）。" +
    "**存在判据＝施工图原文的解析结果，不是「有没有导入执行台账」**：台账未导入时卡定义照样可读；台账状态看 list_tasks／project_entry。" +
    "三种「没有」分开表达：卡不在卡表（`CARD_NOT_FOUND`＋known_ids）／卡在卡表但没定位到卡区（成功返回＋`card.section_found=false`＋下一步建议）／施工图源缺失或没有合格卡表。" +
    "切片与全文逐字节自洽（`slice.sha256` 与 `plan.content_sha256` 可自证：按行序拼接各段 ＝＝ 全文）。" +
    "续读游标绑**完整来源哈希与项目/文档**；旧 `tctx1` 短前缀游标只定位、不能当完整版本证明，会明确失效并要求重取。" +
    "只给**项目根内相对路径**，不外发本机绝对路径。本工具**只读**，不存在 write_plan——施工图只能由施工者同步自己卡的真实状态（DESIGN §2.9）。",
  inputSchema: {
    type: "object",
    properties: {
      project_id: { type: "string", description: "注册表里的项目 id" },
      index: { type: "boolean", description: "true = 只列卡清单与章节索引，不返回正文（与其它定位参数互斥）" },
      task_id: { type: "string", description: "卡号（施工图卡表「卡号」列里的值，如 V09-32）" },
      range: {
        type: "object",
        description: "行范围（1 基、闭区间、均含）",
        properties: { from_line: { type: "number" }, to_line: { type: "number" } },
        required: ["from_line", "to_line"],
        additionalProperties: false,
      },
      section: { type: "string", description: "章节标题或标题路径（与章节索引精确匹配）" },
      cursor: {
        type: "string",
        description:
          "完整版本续读游标（`tcur1:<design|plan>:<绑定16位>:<完整sha64>:lines:<起始行>`，由本工具的续读回执给出）。" +
            "游标绑定项目/文档与完整内容哈希：跨项目/跨文档/源变都会明确报错；旧 `tctx1` 短前缀游标只定位、不能当完整版本证明，会被拒绝并要求重取",
      },
    },
    required: ["project_id"],
    additionalProperties: false,
  },
  handler: (args) => {
    const projectId = typeof args.project_id === "string" ? args.project_id.trim() : "";
    if (projectId === "") return errorResult("read_plan 缺入参 project_id");
    const taskId = typeof args.task_id === "string" ? args.task_id.trim() : "";
    const section = typeof args.section === "string" ? args.section.trim() : "";
    const cursor = typeof args.cursor === "string" ? args.cursor.trim() : "";
    const wantsIndex = args.index === true;
    const hasRange = args.range !== undefined;
    const locators = [
      ...(taskId === "" ? [] : ["task_id"]),
      ...(hasRange ? ["range"] : []),
      ...(section === "" ? [] : ["section"]),
      ...(cursor === "" ? [] : ["cursor"]),
    ];
    if (locators.length > 1) {
      return errorResult(
        `read_plan 的定位参数只能给一个（收到 ${locators.join("、")}）：多给＝没说清读哪一段。` +
          "按卡读给 task_id，按行读给 range，按章节读给 section，续读写给 cursor",
      );
    }
    if (wantsIndex && locators.length > 0) {
      return errorResult(`read_plan 的 index=true 与 ${locators[0]} 不能同时给（index 只列清单，不返回正文）`);
    }
    // 定位参数互斥的错误用纯文本；下方解析/读盘错误统一走 JSON 带 code 的形态
    const badJson = (code: string, message: string, detail: Record<string, unknown> = {}) =>
      errorResult(JSON.stringify({ ok: false, code, message, detail }, null, 2));

    let doc: ReturnType<typeof loadDocument> = null;
    try {
      doc = loadDocument(projectId, "plan");
    } catch (e) {
      if (isWorkError(e)) return badJson(e.code, e.message, e.detail ?? {});
      return errorResult(`read_plan 失败：${e instanceof Error ? e.message : String(e)}`);
    }
    if (doc === null) {
      // 源缺失如实报空态：分段读没有正文可切，说明白，不假装切出空段
      return textResult(
        JSON.stringify(
          {
            plan: { exists: false },
            cards: null,
            slice: null,
            note:
              "该项目没有可读的施工图源（登记的项目根内相对路径下没有文件）。先确认项目登记的施工图路径（DESIGN §2.9），别拿摘要当依据",
          },
          null,
          2,
        ),
      );
    }

    const text = doc.text;
    // 卡清单按**施工定义原文**现解析（不走台账；台账只影响任务状态，不影响定义原文是否可取）
    const imported = importTaskDefinitions(text, { plan_revision: doc.revision.content_sha256 });
    const reportById = new Map(imported.report.tasks.map((t) => [t.task_id, t]));
    const cardsPayload = {
      total: imported.definitions.length,
      table_line: imported.report.table_line,
      table_found: doc.table_found,
      ids: imported.definitions.map((d) => d.task_id),
      ledger_independent: true,
      note: "卡定义来自施工图原文的解析结果（与执行台账是否导入无关）；任务执行/验收状态看 list_tasks 与 project_entry",
    };
    const planBase = {
      exists: true,
      source: doc.source.rel_path,
      origin: doc.source.origin,
      lines: doc.revision.lines,
      bytes: doc.revision.bytes,
      content_sha256: doc.revision.content_sha256,
      definition_sha256: doc.revision.definition_sha256,
      table_found: doc.table_found,
    };

    try {
      if (wantsIndex) {
        return textResult(
          JSON.stringify(
            {
              plan: planBase,
              cards: {
                ...cardsPayload,
                items: imported.definitions.map((d) => {
                  const entry = reportById.get(d.task_id);
                  return {
                    task_id: d.task_id,
                    goal: d.goal,
                    dependencies: d.dependency_ids,
                    section_lines:
                      d.section_lines === null ? null : { from_line: d.section_lines[0], to_line: d.section_lines[1] },
                    section_found: entry?.section_found ?? d.section_lines !== null,
                    definition_sha256: entry?.definition_sha256 ?? null,
                    missing_fields: entry?.missing_fields ?? [],
                  };
                }),
              },
              sections: buildSectionIndex(text).map((s) => ({
                level: s.level,
                title: s.title,
                path: s.path,
                line_start: s.line_start,
                line_end: s.line_end,
              })),
              slice: null,
            },
            null,
            2,
          ),
        );
      }

      if (taskId !== "") {
        const def = imported.definitions.find((d) => d.task_id === taskId);
        if (def === undefined) {
          return badJson(
            "CARD_NOT_FOUND",
            `施工图里没有卡 ${JSON.stringify(taskId)}（按卡表「卡号」列精确匹配）。` +
              (doc.table_found
                ? `当前解析出 ${imported.definitions.length} 张卡，known_ids 见 detail`
                : "而且这张施工图里没有找到合格的卡表（表头需同时含卡号/交付目标/依赖/完成证据）"),
            {
              task_id: taskId,
              table_found: doc.table_found,
              known_ids: cardsPayload.ids,
              plan: { source: doc.source.rel_path, content_sha256: doc.revision.content_sha256 },
            },
          );
        }
        const hasSection = def.section_lines !== null;
        const slice = hasSection ? sliceDocumentLines(text, def.section_lines![0], def.section_lines![1]) : null;
        return textResult(
          JSON.stringify(
            {
              plan: { ...planBase, ...(slice === null ? {} : { content: slice.content }) },
              cards: cardsPayload,
              card: {
                task_id: def.task_id,
                goal: def.goal,
                section_found: hasSection,
                section_lines: hasSection
                  ? { from_line: def.section_lines![0], to_line: def.section_lines![1] }
                  : null,
                dependencies: def.dependency_ids,
                dependency_notes: def.dependency_notes,
                design_refs: def.design_refs,
                allowed_paths: def.allowed_paths,
                evidence_requirement: def.evidence_requirement,
                ...(hasSection
                  ? {}
                  : {
                      note:
                        `施工图里 ${def.task_id} 只有卡行、没有定位到卡区小节（卡片小节缺失或解析不到）。` +
                        "这**不等于**「卡不存在」：用 index=true 看全部卡号与行范围，或用 range 按卡行附近的行号直接读",
                    }),
                ledger_note:
                  "卡定义来自**施工图原文**；它的执行/验收状态不在本工具里（看 list_tasks 与 project_entry 的执行台账）",
              },
              slice: slice === null ? null : sliceMetaOf("card", def.task_id, slice),
            },
            null,
            2,
          ),
        );
      }

      if (hasRange) {
        const range = parseRange(args.range);
        const sliced = sliceDocumentLines(text, range.from_line, range.to_line);
        return textResult(
          JSON.stringify(
            {
              plan: { ...planBase, content: sliced.content },
              cards: cardsPayload,
              slice: sliceMetaOf("range", range, sliced),
            },
            null,
            2,
          ),
        );
      }

      if (section !== "") {
        const sliced = sliceDocumentSection(text, section);
        return textResult(
          JSON.stringify(
            {
              plan: { ...planBase, content: sliced.content },
              cards: cardsPayload,
              slice: sliceMetaOf("section", section, sliced),
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
          doc: "plan",
          sourceLabel: doc.source.rel_path,
          cursorRaw: cursor,
          pageMaxChars: CONTINUATION_PAGE_MAX_CHARS,
        });
        if (!outcome.ok) {
          const f = outcome.failure!;
          return badJson(f.code, f.message, f.detail);
        }
        const page = outcome.page!;
        return textResult(
          JSON.stringify(
            {
              plan: { ...planBase, content: page.slice.content },
              cards: cardsPayload,
              slice: sliceMetaOf("cursor", cursor, page.slice),
              continuation: continuationPayload(page, projectId, "plan", doc.revision.content_sha256),
            },
            null,
            2,
          ),
        );
      }

      // 无定位参数：整份原文（与 read_design 的缺省行为一致）
      return textResult(
        JSON.stringify({ plan: { ...planBase, content: text }, cards: cardsPayload, slice: null }, null, 2),
      );
    } catch (e) {
      if (isWorkError(e)) return badJson(e.code, e.message, e.detail ?? {});
      return errorResult(`read_plan 失败：${e instanceof Error ? e.message : String(e)}`);
    }
  },
};
