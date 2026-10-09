// V09-41（docs/efficiency-20261004.md）：`task_brief` —— project_entry 的**紧凑只读简报**。
//
// 职责只有一层：把**同一次** project_entry 的完整返回投影成紧凑白名单（投影在
// `server/work/taskBrief.ts`，纯函数）。它**不重算**判定、不读事件、不写账、不认领、不调模型，
// 也不新增任何授权——门禁结论与理由都来自那一份完整入口。
//
// 三种详略（`detail`）：
//   · `summary`（默认）：紧凑简报。每条理由保留核心索引 + 截断短 text，当前选中任务的 reason
//     原样完整保留；附 `reasons_revision`（原完整 reasons 的 sha256）。**不是完整执行依据**。
//   · `full`：`buildTaskBrief` 的完整简报（旧默认行为，兼容所有原事实；无服务器缓存）。
//   · `reason`：配 `reason_index`（0 基）+ `reasons_revision`，在**同一次**入口结果上现算哈希，
//     匹配才返回单条完整原文与当前 next_action；不匹配显式 `REVISION_CHANGED`，不返回错行。
//
// 红线：
//   · 只调 `projectEntryTool.handler` **一次**（同一份同版判据），不复制它的判定逻辑；
//   · 错误 `isError` **原样透传**（含缺参/项目不存在/宿主明确报错），不包装成成功；
//   · 新入参（detail/reason_index/reasons_revision）**绝不转发** project_entry；
//   · 非法参数组合**在调用入口前**显式拒绝（不静默忽略、不悄悄当默认）；
//   · 省略字段在 `omitted` 里只列字段名，并给回 `project_entry` 的补取入口（参数原样）；
//     返回体用**紧凑 JSON**（不 pretty-print）——省的是结构冗余，不是判定。
import { projectEntryTool } from "./projectEntry";
import {
  buildReasonView,
  buildTaskBrief,
  reasonsRevisionOf,
  summarizeTaskBrief,
  type EntryFull,
} from "../../server/work/taskBrief";
import { errorResult, textResult, type McpContext, type McpTool, type ToolResult } from "./types";

/** 转发给 project_entry 的入参键（与它一致；不含 task_id、不含 preconditions，也不含本工具的新入参）。 */
const FORWARD_PARAMS = ["project_id", "role", "client_capabilities", "known_revision", "resume_hint", "expected_revision"] as const;

const DETAIL_MODES = ["summary", "full", "reason"] as const;
type DetailMode = (typeof DETAIL_MODES)[number];

/** 结构化拒绝：显式 `code` + 说明；isError 让客户端按失败处理，不返回半截/错行结果。 */
function reject(code: string, message: string): ToolResult {
  return errorResult(JSON.stringify({ ok: false, code, message }));
}

type ArgCheck = { ok: true; detail: DetailMode } | { ok: false; code: string; message: string };

/**
 * 校验本工具新增入参（**调用 project_entry 之前**跑完）。只认 detail/reason_index/reasons_revision：
 * 非法组合显式拒绝，不静默忽略；其余键维持既有宽容（project_entry 只取它认的五个）。
 */
function checkArgs(args: Record<string, unknown>): ArgCheck {
  const raw = args.detail;
  let detail: DetailMode = "summary";
  if (raw !== undefined) {
    if (typeof raw !== "string" || !(DETAIL_MODES as readonly string[]).includes(raw)) {
      return { ok: false, code: "INVALID_ARGUMENT", message: `detail 只接受 summary/full/reason（收到 ${JSON.stringify(raw)}）；缺省=summary` };
    }
    detail = raw as DetailMode;
  }
  const hasIndex = args.reason_index !== undefined;
  const hasRevision = args.reasons_revision !== undefined;
  if (detail === "reason") {
    if (!hasIndex || !hasRevision) {
      return { ok: false, code: "INVALID_ARGUMENT", message: "detail=reason 必须同时给 reason_index（整数，0 基）与 reasons_revision（summary 返回的 sha256）" };
    }
    if (typeof args.reason_index !== "number" || !Number.isInteger(args.reason_index) || args.reason_index < 0) {
      return { ok: false, code: "INVALID_ARGUMENT", message: `reason_index 必须是非负整数（0 基；收到 ${JSON.stringify(args.reason_index)}）` };
    }
    if (typeof args.reasons_revision !== "string" || args.reasons_revision.trim() === "") {
      return { ok: false, code: "INVALID_ARGUMENT", message: `reasons_revision 必须是非空字符串（收到 ${JSON.stringify(args.reasons_revision)}）` };
    }
    return { ok: true, detail };
  }
  if (hasIndex || hasRevision) {
    return {
      ok: false,
      code: "INVALID_ARGUMENT",
      message: `reason_index/reasons_revision 只在 detail=reason 时可用（detail=${detail} 时给了这些参数）：不接受无效组合，不静默忽略`,
    };
  }
  return { ok: true, detail };
}

function textOf(result: ToolResult): string {
  return (result.content ?? [])
    .filter((c): c is { type: "text"; text: string } => (c as { type: string }).type === "text")
    .map((c) => c.text)
    .join("\n");
}

export const taskBriefTool: McpTool = {
  name: "task_brief",
  description:
    "常规接续的只读简报（默认 detail=summary）：复用 project_entry 一次判定，保留动作、理由索引、当前任务要求、所有权、版本与必读材料；" +
    "不认领、不写账、不调模型。摘要不是完整执行依据（理由 text 截断、非当前任务的 pack 未内联），要完整原文用 detail=full 或 detail=reason+reason_index+reasons_revision；" +
    "**同步修复计划**在 summary 里只给紧凑导航（现形批次/逐 verdict 计数/阻断与等待计数 + 结构化 refetch 到 read_sync_status(project_id)），完整逐项修复计划在 detail=full 与 read_sync_status 全文；" +
    "省略内容列在 omitted，preconditions 解释按需用 project_entry；架构分析用 get_project_graphs mode=full 按同一快照取齐。错误原样返回。",
  inputSchema: {
    type: "object",
    properties: {
      project_id: { type: "string", description: "注册表里的项目 id" },
      role: { type: "string", description: "调用方角色（如 executor/auditor/coordinator/designer/user；角色名不是安全凭证）" },
      client_capabilities: {
        description:
          "客户端自述能力：**字符串**传 `continuable` 或 `coordination`（也可 `read_only`），或**对象** `{can_continue:true}`。" +
          "不要传 JSON 字符串化的数组。**不声明按「仅可读取」处理**（DESIGN.md §6.2）",
      },
      known_revision: {
        type: "string",
        description: "调用方已知的版本（基线 id 或设计/施工图修订 sha256）；落后于当前有效版本时不派新任务",
      },
      resume_hint: { type: "string", description: "可选：接续提示（任务或交接 ID）；只是提示，不越权绕过角色/依赖/范围检查" },
      expected_revision: {
        type: "string",
        description:
          "可选（V09-53）：调用方持有的 `work_package.package_revision`；不符即简报里的 `work_package` 显式 `REVISION_CHANGED`" +
          "（**不静默返回跨版本数据**），`work_package_status=invalid` 并给重读入口",
      },
      detail: {
        type: "string",
        enum: ["summary", "full", "reason"],
        description:
          "可选，默认 summary。summary=紧凑简报（理由索引完整、非当前任务 text 截断，**不是完整执行依据**）；" +
          "full=完整简报（旧行为）；reason=取单条完整原文，须配 reason_index+reasons_revision",
      },
      reason_index: {
        type: "integer",
        description: "仅 detail=reason：reasons 数组下标（0 基，见 summary 每条理由的 index 与 current_task.reason_index）",
      },
      reasons_revision: {
        type: "string",
        description: "仅 detail=reason：summary 返回的 reasons_revision（原完整 reasons 的 sha256）；现场已变则显式 REVISION_CHANGED",
      },
    },
    required: ["project_id", "role"],
    additionalProperties: false,
  },
  handler: async (args: Record<string, unknown>, ctx?: McpContext): Promise<ToolResult> => {
    // 先验新入参：非法/无效组合**在调用入口前**拒（不悄悄当默认、不转发给 project_entry）。
    const check = checkArgs(args);
    if (!check.ok) return reject(check.code, check.message);
    const { detail } = check;

    const forwarded: Record<string, unknown> = {};
    for (const key of FORWARD_PARAMS) if (args[key] !== undefined) forwarded[key] = args[key];

    // **唯一一次**调用完整入口：同版判据只算一遍（不复制、不重算）。错误原样透传。
    const full = await projectEntryTool.handler(forwarded, ctx);
    if (full.isError === true) return full;

    let parsed: unknown;
    try {
      parsed = JSON.parse(textOf(full));
    } catch {
      // 完整入口的返回解析不了：不做半截投影，原样返回（不把"解析失败"伪装成成功简报）。
      return full;
    }
    // 同一份投影（纯函数）；三种详略共用它，判定与门禁结论不变。
    const brief = buildTaskBrief(parsed as EntryFull, forwarded);

    if (detail === "full") {
      // 原版本完整简报：兼容所有原事实，永不做服务器缓存（每次现调现投影）。
      return textResult(JSON.stringify(brief));
    }
    if (detail === "reason") {
      const want = (args.reasons_revision as string).trim();
      const now = reasonsRevisionOf(brief.reasons);
      if (now !== want) {
        // 现场已变：不返回可能错行的旧下标（显式失败，请重取 summary）。
        return reject(
          "REVISION_CHANGED",
          `理由现场已变（期望 reasons_revision=${want}，当前 ${now}）：不返回错行。请重新取 detail=summary 拿新 revision 与新 reason_index`,
        );
      }
      const view = buildReasonView(brief, args.reason_index as number);
      if (view === null) {
        return reject(
          "INDEX_OUT_OF_RANGE",
          `reason_index=${String(args.reason_index)} 越界：本现场 reasons 长度为 ${brief.reasons.length}（有效下标 0…${brief.reasons.length - 1}）`,
        );
      }
      return textResult(JSON.stringify(view));
    }
    // detail=summary（默认）：紧凑投影——每条理由保留索引与截断短 text，当前任务 reason 原样完整保留。
    return textResult(JSON.stringify(summarizeTaskBrief(brief)));
  },
};
