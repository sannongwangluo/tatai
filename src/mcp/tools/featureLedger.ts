// feature_ledger：功能清单**只读**读口（B2/V09-52；DESIGN.md §6.12）。
//
// 与 HTTP `GET /api/projects/:id/feature-ledger` **同底层**（`readFeatureLedger`）、同义参数、同错误语义；
// 只读：不写事件/证据/租约、不自愈、不启动写宿主、不调模型。宿主不支持 ⇒ 明确 `unsupported`，
// **绝不**回退任何写路由（§6.6、§6.11、§6.12）。

import { getProject, resolveDataDir } from "../../server/registry";
import { readFeatureLedger, parseFeatureLedgerParams } from "../../server/work/featureLedger";
import { textResult, type McpTool } from "./types";

export const featureLedgerTool: McpTool = {
  name: "feature_ledger",
  description:
    "功能清单与四维读数**只读**读口（DESIGN.md §6.12；B2/V09-52）。" +
    "同一 revision 的事实快照 → 唯一义务派生 → feature_item[]（设计覆盖/实现/验证/用户接受四维**分开**，绿色只取 verification）。" +
    "参数：project_id（必填）、scope=current|<scope_id>、document=current|active|<revision>（active=**已批准基线快照**，不是「现行文件恰好被批准过」；<revision>=不可变历史快照）、artifact_ref（必须是**已登记**产物引用，取不到 ⇒ 422）、expected_revision、cursor、limit=1..200。" +
    "语义：`paging.complete` 只表示本次分页结束；来源是否读齐看 `coverage.source_complete`（空需求/未读齐 ⇒ false，**不报完整**）；" +
    "`document_selection` 如实回报实际读到的是哪一版与草稿漂移；`package_revision_basis` 逐条点名包版本绑定了哪些读数（换任一项旧游标失效）。" +
    "错误：400 INVALID_INPUT／404 PROJECT_NOT_FOUND／409 REVISION_CHANGED（包版本或游标过期）／422 SOURCE_INVALID（声明区缺列/重复 ID/悬空需求/章节定位不到/**产物引用未登记**）／503 SOURCE_UNAVAILABLE（读失败，**不回空成功**）。" +
    "交付读数（§3.16／§3.17，均为同源只读派生，不另算绿）：顶层 `delivery`＝交付总览（`state=ready_for_trial|not_ready|unknown`、`blockers[]` 逐条点名还差什么、`gates[]` 三类交付核对 coverage/review/runtime、`integration`＝`project:delivery` 组合流程验证、`counts`、`user_acceptance`、`version`）；逐项 `agent_review`＝该功能的**非作者审查**读数（作者自检或与作者同会话的记录会降级，**不充作**独立审查）。" +
    "口径**分开**：这些读数只是「能不能开始人工试用」的派生结论，**不等于用户接受**——`user_acceptance` 单列，试用与接受只由用户记录，Agent 不代签；`delivery.state=ready_for_trial` 也不等于已交付或已验收。" +
    "只读：不写事件/证据/租约、不触发扫描、不自愈、不调模型；`state=not_derived` 表示定义尚未派生（带 reason + 补取入口），**不等于空项目**。" +
    "读到清单**不等于已通过**：引用存在 ≠ 已核对、模型提案 ≠ 已审定、设计被激活 ≠ 本需求已覆盖。",
  inputSchema: {
    type: "object",
    properties: {
      project_id: { type: "string", description: "注册表里的项目 id" },
      scope: { type: "string", description: "current（缺省）或明确 scope_id" },
      document: { type: "string", description: "current | active（缺省）| <revision>" },
      artifact_ref: { type: "string", description: "已登记产物引用（可选）" },
      expected_revision: { type: "string", description: "包版本；不符 ⇒ 409 REVISION_CHANGED" },
      cursor: { type: "string", description: "分页游标（绑定 package_revision；版本变 ⇒ 409）" },
      limit: { type: "number", description: "1..200，缺省 50" },
    },
    required: ["project_id"],
    additionalProperties: false,
  },
  handler: (args) => {
    // 严格参数（与 inputSchema.additionalProperties:false 同一口径）：未知键一律拒，不静默忽略。
    const allowed = ["project_id", "scope", "document", "artifact_ref", "expected_revision", "cursor", "limit"];
    const extra = Object.keys(args).filter((k) => !allowed.includes(k));
    if (extra.length > 0) {
      return {
        content: [{ type: "text", text: `feature_ledger 未知参数：${extra.join("、")}（只收 ${allowed.join("/")}）` }],
        isError: true,
      };
    }
    const projectId = typeof args.project_id === "string" ? args.project_id.trim() : "";
    if (projectId === "") {
      return { content: [{ type: "text", text: "feature_ledger 缺入参 project_id" }], isError: true };
    }
    const parsed = parseFeatureLedgerParams({
      scope: args.scope,
      document: args.document,
      artifact_ref: args.artifact_ref,
      expected_revision: args.expected_revision,
      cursor: args.cursor,
      limit: args.limit,
    });
    if ("ok" in parsed) {
      return { content: [{ type: "text", text: JSON.stringify(parsed, null, 2) }], isError: true };
    }
    const dataDir = resolveDataDir();
    const result = readFeatureLedger(projectId, dataDir, parsed, {
      // `getProject` 返回 `undefined`（不是 null）：按 undefined 判，项目不存在才走 404
      project_exists: (id) => getProject(id, dataDir) !== undefined,
    });
    if (!result.ok) {
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], isError: true };
    }
    return textResult(JSON.stringify({ ok: true, ledger: result.ledger }, null, 2));
  },
};
