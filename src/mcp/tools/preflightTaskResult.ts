// 结果提交前的**只读预检** MCP 工具（PLAN V09-47 / P2；DESIGN.md §6.7/§6.11；docs/agent-optimization-20261006.md §6）。
//
// 定位（红线）：
//   · **明确只读**：不写事件、不存证、不续租、不生成证据、不自愈拉起写者、不产生认领；
//   · **不是门禁、不是通行票**：预检成功不产生"必须先过"的审批层，也不是"已交付/已通过"；
//   · **不采用给旧工具加 mode=check 的办法**：独立只读名字在旧宿主上明确"工具不存在/不支持"，
//     **绝不回退成写入**；也不在 MCP 进程本地另算一套判据冒充"远端已支持"（会漏掉宿主的锁内判据）。
//
// 输入与 `submit_task_result` **同形**（复用同一份 `SUBMIT_TASK_RESULT_SCHEMA`，原必填不省略）：
// 面向**已经取得合法认领的执行者**；未认领者请用 `project_entry`/`task_brief` 的 `preconditions` 看准备条件。
// `now` **不是**公开预检输入（运行时调用方不能回拨时钟延长租约）。
//
// 能力协商：宿主不支持该只读路由（旧宿主 404/405/响应不符）⇒ `UNSUPPORTED_BY_HOST`（给明确指引、零写入）；
// 宿主不可达/非当前写者 ⇒ `SERVICE_UNAVAILABLE`（**不报通过**）。
import { isWorkError } from "../../server/work/types";
import { resolveDataDir } from "../../server/registry";
import { SUBMIT_TASK_RESULT_SCHEMA } from "./projectEntry";
import { errorResult, textResult, type McpContext, type McpTool, type ToolResult } from "./types";

/** 结构化结果（照原样给：成功给预检结果；失败给 code/message/detail，isError 让客户端按失败处理） */
function jsonResult(payload: unknown, isError: boolean): ToolResult {
  return isError ? errorResult(JSON.stringify(payload, null, 2)) : textResult(JSON.stringify(payload, null, 2));
}

// 入参映射与 projectEntry.ts 的 submit_task_result **同一口径**：这里只补 `owner_id` 缺省
// （缺省取 MCP 客户端名 / role），**其余原样转给唯一宿主**——闭键/类型/必填/命令信封校验由宿主
// 的 `parseResultSubmitInput`（与 submit 同源）统一判定，不在本进程另算一套、也不静默过滤非法值。
function str(args: Record<string, unknown>, key: string): string {
  return typeof args[key] === "string" ? (args[key] as string).trim() : "";
}

export const preflightTaskResultTool: McpTool = {
  name: "preflight_task_result",
  description:
    "**只读**：提交结果前预检（一次列清可预判的缺项，逐项 kind/status/expected/actual/source_ref/remediation）。" +
    "与 `submit_task_result` 共用同一份判据、**不写任何字节**（不写事件/证据/租约），**不是门禁、不是通行票**：" +
    "预检到提交之间版本/认领/租约/定义/证据源可能变化，提交时在唯一写入服务临界区内按当前事实重核（recheck_on_commit=true）。" +
    "命中已提交的同一幂等键 ⇒ **短路五查**、只返回 already_submitted＋原回执（checks 未重查、would_pass=null，**不冒称当前校验通过/失败**）；同键异内容 ⇒ conflict。" +
    "入参按 `submit_task_result` 的闭键/类型/必填**同源**校验（unknown 字段、非法 role、负版本、非字符串数组、公开 now 一律明确拒，不静默过滤）；" +
    "**显式给错的类型**（如 `verification:[42]`、缺 `exit_code`、`owner_id:42`）同样如实拒，不静默改默认后报通过；" +
    "不适用于 task.result_submitted 的锁内校验逐条标 not_applicable，锁内未查项单列 not_checked（两类不混用）。" +
    "宿主不支持该只读路由（旧宿主）⇒ UNSUPPORTED_BY_HOST，**绝不回退**到提交路由。",
  inputSchema: SUBMIT_TASK_RESULT_SCHEMA,
  handler: async (args, ctx?: McpContext) => {
    const work = ctx?.work;
    if (work === undefined) {
      return jsonResult(
        {
          ok: false,
          code: "SERVICE_UNAVAILABLE",
          message:
            "preflight_task_result 拿不到转接客户端（ctx.work）：只读预检只在唯一写服务宿主上执行——" +
            "MCP 进程不本地另算一套判据冒充远端已支持（那会漏掉宿主的锁内判据）",
        },
        true,
      );
    }
    // 原样转发调用方入参（含非法/多余字段——由宿主同源校验明确拒，不在这里静默过滤），
    // 只补**真正未提供**（缺键 / null / 空串）的 `owner_id` 缺省（与 submit_task_result 同一缺省口径，
    // 保证幂等内容比对一致）。**P2 最终纠正**：调用方显式给的非字符串（如 `owner_id: 42`）**不**用
    // `str()+fallback` 覆盖成合法缺省——那等于替调用方改意图、把非法输入洗成 would_pass；原样转发，
    // 由宿主的 `parseResultSubmitInput` 按类型如实拒（本进程只补缺省，不做类型静默修正）。
    const rawOwner = args.owner_id;
    const ownerMissing =
      rawOwner === undefined || rawOwner === null || (typeof rawOwner === "string" && rawOwner.trim() === "");
    const ownerId: unknown = ownerMissing ? (ctx?.clientName ?? "") || str(args, "role") : rawOwner;
    try {
      resolveDataDir(); // 与其它 v2 工具同一数据目录（MCP 与唯一写服务同源）
      const r = await work.preflightResultRemote({ ...args, owner_id: ownerId });
      if (r.kind === "ok") return jsonResult(r.result, false);
      if (r.kind === "unsupported") {
        return jsonResult(
          {
            ok: false,
            code: "UNSUPPORTED_BY_HOST",
            message: r.reason,
            guidance:
              "该宿主不支持只读预检路由（旧版本）。请升级宿主，或**直接用 submit_task_result**——" +
              "本工具**绝不回退**到提交路由，也不在本进程另算一套判据冒充远端已支持",
          },
          true,
        );
      }
      if (r.kind === "unavailable") {
        return jsonResult(
          {
            ok: false,
            code: "SERVICE_UNAVAILABLE",
            message: r.reason,
            guidance:
              "唯一写服务宿主不可达或当前不是写宿主：**不报通过**（预检只在唯一写服务宿主上回答）。" +
              "稍后重试或启动塔台桌面应用——本工具**不自愈**拉起写者、不本地兜底",
          },
          true,
        );
      }
      return jsonResult({ ok: false, code: r.code, message: r.message, detail: r.detail, http_status: r.httpStatus }, true);
    } catch (e) {
      if (isWorkError(e)) return jsonResult({ ok: false, code: e.code, message: e.message, detail: e.detail }, true);
      return errorResult(`preflight_task_result 失败：${e instanceof Error ? e.message : String(e)}`);
    }
  },
};
