// 正向成套图纸的基线入口（PLAN.md V09-28；DESIGN.md §2.9/§6.7；docs/forward-progress-contract.md F1）。
//
// `manage_baseline` 三个操作：
//   · read（只读）：读两份源当前修订 + 生效基线。**零副作用**——不起宿主、不起模型、不写盘；
//   · preserve（写）：把当前一份图纸存成不可变历史（Git 可取回的直接引用，否则落副本）；
//   · activate（写）：把**已有成套图纸**审定激活成配套基线——**零差异**、不经过模型、不经过逆向落稿。
//     复用 `documents.activateBaseline` 的既有判据（源冲突/保留历史/确定性派生/幂等不滥增）。
//
// 硬口径（DESIGN.md §2.9、契约 F1）：
//   · MCP 的激活**只允许 designer/coordinator**，`approval_kind` **固定** `delegated_technical_review`；
//     **不支持 user_confirmation**（用户 Gate 不由 Agent 代签）。
//   · 激活必须带**两份源的当前 expected 内容哈希** + `approved_by` + `approval_basis`：缺一即拒，
//     源在审定中改变由 `activateBaseline` 报 `VERSION_CONFLICT`（保留草稿与差异）。
//   · 写经 `ctx.work` 转给**唯一宿主**（`baselineHost`），不在 stdio 进程另建写者；宿主不可达如实报不可用。
//   · 激活只影响配套基线：不写 Gate、不自动领取任务、不调模型。
//
// 注册：工具清单在 `src/mcp/tools/index.ts`（本卡不改；由 core 集成方统一登记 `manageBaselineTool`）。
import { resolveDataDir } from "../../server/registry";
import { WorkError } from "../../server/work/types";
import { callBaselineHost, readBaselineView, type BaselineWriteOp } from "../../server/work/baselineHost";
import { errorResult, textResult, type McpTool } from "./types";

/** 允许写基线的角色（与 `register_sync_contract` 同类的"限设计/协调职责"口径） */
const WRITE_ROLES: readonly string[] = ["designer", "coordinator"];

const projectIdOf = (args: Record<string, unknown>): string => (typeof args.project_id === "string" ? args.project_id.trim() : "");
const strOf = (args: Record<string, unknown>, key: string): string => (typeof args[key] === "string" ? (args[key] as string).trim() : "");

function requireWriteRole(role: string): void {
  if (!WRITE_ROLES.includes(role)) {
    throw new WorkError(
      "INVALID_COMMAND",
      `manage_baseline 的写限设计/协调职责（role 需 ${WRITE_ROLES.join(" / ")}，收到 ${JSON.stringify(role || "(缺)")}）——` +
        "基线审定的责任角色必须如实声明（DESIGN.md §2.9）",
      { field: "role", allowed: WRITE_ROLES },
    );
  }
}

export const manageBaselineTool: McpTool = {
  name: "manage_baseline",
  description:
    "正向成套图纸的基线入口。op=read 只读两份源当前修订与生效基线（零副作用，不启宿主/模型）；" +
    "op=preserve 把当前一份图纸（kind=design|plan）存成不可变历史；" +
    "op=activate 用**已有的** DESIGN/PLAN 审定激活配套基线（零差异、不调模型、不经过逆向落稿）。" +
    "写限 designer/coordinator；激活固定 delegated_technical_review、不支持 user_confirmation，必须带两份源当前 expected 内容哈希与 approved_by/approval_basis；" +
    "源冲突拒、保留历史、重复请求不新增；不写用户 Gate、不自动领取任务。",
  inputSchema: {
    type: "object",
    properties: {
      project_id: { type: "string", description: "注册表里的项目 id" },
      op: { type: "string", enum: ["read", "preserve", "activate"], description: "读取 / 保存一份修订 / 激活配套基线" },
      role: { type: "string", description: "调用方角色（写限 designer/coordinator；read 不需要）" },
      kind: { type: "string", enum: ["design", "plan"], description: "op=preserve 时要保存的那一份" },
      approved_by: { type: "string", description: "审定者（op=activate 必填；技术审定不得为 user）" },
      approval_basis: { type: "string", description: "审定依据（op=activate 必填，不能空）" },
      approval_kind: {
        type: "string",
        description: "固定 delegated_technical_review（缺省即此）；不接受 user_confirmation——用户确认不由 Agent 代签（DESIGN.md §2.9）",
      },
      expected: {
        type: "object",
        description:
          "审定者手上那份草稿的版本标识（op=activate 必填：两份源的 content_sha256，建议由 op=read 取回后原样回填）；源在审定中改变会被拒（VERSION_CONFLICT）",
        properties: {
          design_content_sha256: { type: "string" },
          design_definition_sha256: { type: "string" },
          design_source_path: { type: "string" },
          plan_content_sha256: { type: "string" },
          plan_definition_sha256: { type: "string" },
          plan_source_path: { type: "string" },
        },
        additionalProperties: false,
      },
    },
    required: ["project_id", "op"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const projectId = projectIdOf(args);
    if (projectId === "") return errorResult("manage_baseline 缺入参 project_id");
    const op = typeof args.op === "string" ? args.op.trim() : "";
    try {
      if (op === "read") {
        const dataDir = resolveDataDir();
        return textResult(JSON.stringify(readBaselineView(projectId, dataDir), null, 2));
      }
      if (op === "preserve" || op === "activate") {
        const role = strOf(args, "role");
        requireWriteRole(role);
        const work = ctx?.work;
        if (work === undefined) {
          throw new WorkError("SERVICE_UNAVAILABLE", `manage_baseline 拿不到转接客户端（ctx.work）：v2 事实只有一个写入者`, { tool: "manage_baseline", op });
        }
        const payload: Record<string, unknown> = {};
        if (op === "preserve") {
          const kind = strOf(args, "kind");
          if (kind !== "design" && kind !== "plan") {
            throw new WorkError("INVALID_COMMAND", `op=preserve 需要 kind=design|plan（收到 ${JSON.stringify(kind || "(缺)")}）`, { field: "kind" });
          }
          payload.kind = kind;
        } else {
          const approvedBy = strOf(args, "approved_by");
          const approvalBasis = strOf(args, "approval_basis");
          if (approvedBy === "") throw new WorkError("INVALID_COMMAND", "op=activate 缺审定者 approved_by（谁审定的要如实写，不能空）", { field: "approved_by" });
          if (approvalBasis === "") throw new WorkError("INVALID_COMMAND", "op=activate 缺审定依据 approval_basis：没有依据的基线不可激活（DESIGN.md §2.9）", { field: "approval_basis" });
          const expected = args.expected;
          if (typeof expected !== "object" || expected === null || Array.isArray(expected)) {
            throw new WorkError("INVALID_COMMAND", "op=activate 缺 expected（两份源的当前内容哈希）：先 op=read 取回 current_pair 再回填", { field: "expected" });
          }
          const e = expected as Record<string, unknown>;
          const designSha = typeof e.design_content_sha256 === "string" ? e.design_content_sha256.trim() : "";
          const planSha = typeof e.plan_content_sha256 === "string" ? e.plan_content_sha256.trim() : "";
          if (designSha === "" || planSha === "") {
            throw new WorkError(
              "INVALID_COMMAND",
              "op=activate 的 expected 必须同时给两份源的 design_content_sha256 与 plan_content_sha256（半套图纸不能激活，DESIGN.md §2.9）",
              { field: "expected", got: { design: designSha !== "", plan: planSha !== "" } },
            );
          }
          payload.approved_by = approvedBy;
          payload.approval_basis = approvalBasis;
          // MCP 面固定技术审定；调用方若显式给 user_confirmation 一律拒（不在 Agent 侧代签用户 Gate）
          const kind = typeof args.approval_kind === "string" ? (args.approval_kind as string).trim() : "delegated_technical_review";
          if (kind !== "delegated_technical_review") {
            throw new WorkError(
              "INVALID_COMMAND",
              `manage_baseline 不支持 approval_kind=${JSON.stringify(kind)}：MCP 激活固定 delegated_technical_review（用户确认由人经界面完成，DESIGN.md §2.9）`,
              { field: "approval_kind" },
            );
          }
          payload.approval_kind = "delegated_technical_review";
          payload.expected = e;
        }
        const raw = await callBaselineHost(work, projectId, op as BaselineWriteOp, payload);
        // preserve 的宿主回包把结果装在 `result` 里（与直挂路由同形），activate 是平铺的——
        // 这里统一取"有意义的那一层"，让两种 op 的回包形状一致（调用方不必记得哪条路由的包装不同）。
        const result = typeof raw === "object" && raw !== null && "result" in raw ? raw.result : raw;
        // 写完后把**当前**读数一并带回，调用方不必再猜基线是否已生效（read 与写同一份判据）
        const view = readBaselineView(projectId, resolveDataDir());
        return textResult(JSON.stringify({ ok: true, op, result, view }, null, 2));
      }
      return errorResult(`manage_baseline 的 op 只接受 read/preserve/activate（收到 ${JSON.stringify(op || "(缺)")}）`);
    } catch (e) {
      return errorResult(e instanceof WorkError ? `${e.code}: ${e.message}` : `manage_baseline 失败：${e instanceof Error ? e.message : String(e)}`);
    }
  },
};
