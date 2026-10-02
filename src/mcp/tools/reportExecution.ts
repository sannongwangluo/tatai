// report_execution：外部执行器回执链的受控 MCP 入口（PLAN V09-27；DESIGN.md §5.4/§6.5/§6.7；契约 F3）。
//
// 为什么需要它：`execution.*` 的启动请求/启动确认/心跳/检查点/停止请求/停止确认/失败/效果声明·确认·
// 待核实/交付此前只有验证脚本在直调库函数（`src/` 内零调用点），入口 `project_entry.current_runs` 也看不到
// "执行器是否真停/失联"。本工具把这些**既有**回执接成 Agent 真实可调的入口，判据**完全复用**
// `executionReceipts.ts`（认领 token 当前、workspace 隔离、停止必须有确认依据、心跳缺失≠停止），
// 不在工具层重造第二套；写操作经 `ctx.work` 转接唯一写入服务（§2.6），MCP 不自己追加事件。
//
// 红线：
//   · 每次回执都核**当前认领 token + 持有者**（只有持有者能报自己那次执行的现场）；
//   · `stopped` 必须有确认依据（`confirmation`），`failed` 必须有现场（`scene.message`）——
//     缺了就在这里被 executionReceipts 拒（零写入）；
//   · **不把缺心跳当停机**：`heartbeat` 只是"这一刻还有信号"，`stopped` 才代表停止（判据在库层）。
import type { ExecutionTarget } from "../../server/work/executionReceipts";
import {
  declareEffect,
  confirmEffect,
  markEffectUnverified,
  recordCheckpoint,
  recordDelivered,
  recordFailed,
  recordHeartbeat,
  recordStartRequested,
  recordStarted,
  recordStopRequested,
  recordStopped,
} from "../../server/work/executionReceipts";
import { WorkError, isWorkError } from "../../server/work/types";
import { errorResult, textResult, type McpContext, type McpTool, type ToolResult } from "./types";

const OPS = [
  "start_requested",
  "started",
  "heartbeat",
  "checkpoint",
  "stop_requested",
  "stopped",
  "failed",
  "effect_declared",
  "effect_confirmed",
  "effect_unverified",
  "delivered",
] as const;
type Op = (typeof OPS)[number];

const BASE_KEYS = [
  "op",
  "project_id",
  "task_id",
  "run_id",
  "attempt_id",
  "attempt",
  "execution_id",
  "coordinator_id",
  "client_id",
  "model",
  "effort",
  "workspace",
  "claim_token",
  "owner_id",
  "owner_role",
  "role",
  "change_id",
  "expected_revision",
  "parent_execution_id",
  "parent_run_id",
  "occurred_at",
] as const;

const OP_KEYS: Record<Op, readonly string[]> = {
  start_requested: [...BASE_KEYS, "goal", "argv_digest", "template_source", "timeout_ms"],
  started: [...BASE_KEYS, "client_version", "pid", "argv_digest", "started_at"],
  heartbeat: [...BASE_KEYS, "note", "awaiting_input", "observed_at"],
  checkpoint: [...BASE_KEYS, "note", "artifacts", "worktree", "effects_in_flight", "awaiting_input", "observed_at"],
  stop_requested: [...BASE_KEYS, "reason", "confirm_method"],
  stopped: [...BASE_KEYS, "confirmation", "evidence", "exit_code"],
  failed: [...BASE_KEYS, "phase", "scene", "log_ref"],
  effect_declared: [...BASE_KEYS, "effect_id", "target", "authorization", "verify_method", "external_idempotency_key"],
  effect_confirmed: [...BASE_KEYS, "effect_id", "result_ref", "note"],
  effect_unverified: [...BASE_KEYS, "effect_id", "check_evidence"],
  delivered: [...BASE_KEYS, "deliverables", "evidence_refs", "verification", "untested", "known_issues", "diff_ref", "result_revision", "exit_code", "client_version"],
};

function jsonOk(payload: unknown): ToolResult {
  return textResult(JSON.stringify(payload, null, 2));
}
function jsonError(payload: unknown): ToolResult {
  return errorResult(JSON.stringify(payload, null, 2));
}
function str(args: Record<string, unknown>, key: string): string {
  return typeof args[key] === "string" ? (args[key] as string).trim() : "";
}
/** 严格字符串数组（给了就必须全是非空字符串）：不 filter、不静默删掉调用者给的项（复审第 3 项） */
function strList(args: Record<string, unknown>, key: string): string[] {
  const v = args[key];
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new WorkError("INVALID_COMMAND", `入参 ${key} 必须是字符串数组（收到 ${typeof v}）`, { field: key });
  v.forEach((x, i) => {
    if (typeof x !== "string" || x.trim() === "") {
      throw new WorkError("INVALID_COMMAND", `入参 ${key}[${i}] 必须是非空字符串（收到 ${JSON.stringify(x)}）`, { field: key, index: i });
    }
  });
  return v as string[];
}
/** 严格数字：给了就必须是有限数（不把非法数值静默丢成"没给"） */
function numOrNull(args: Record<string, unknown>, key: string): number | null {
  const v = args[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new WorkError("INVALID_COMMAND", `入参 ${key} 必须是有限数值（收到 ${JSON.stringify(v)}）`, { field: key });
  }
  return v;
}
/** 严格对象数组：给了就必须全是对象（不静默丢项） */
function objList(args: Record<string, unknown>, key: string): Record<string, unknown>[] | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) throw new WorkError("INVALID_COMMAND", `入参 ${key} 必须是对象数组（收到 ${typeof v}）`, { field: key });
  v.forEach((x, i) => {
    if (typeof x !== "object" || x === null || Array.isArray(x)) {
      throw new WorkError("INVALID_COMMAND", `入参 ${key}[${i}] 必须是对象（收到 ${JSON.stringify(x)}）`, { field: key, index: i });
    }
  });
  return v as Record<string, unknown>[];
}
/** 严格的必填对象 */
function requireObject(args: Record<string, unknown>, key: string): Record<string, unknown> {
  const v = args[key];
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new WorkError("INVALID_COMMAND", `入参 ${key} 必须是对象（收到 ${JSON.stringify(v)}）`, { field: key });
  }
  return v as Record<string, unknown>;
}

function assertToolArgs(args: Record<string, unknown>, allowed: readonly string[], what: string): void {
  const extra = Object.keys(args).filter((k) => !allowed.includes(k));
  if (extra.length === 0) return;
  throw new Error(
    `${what} 的入参只收这些键（${allowed.join(" / ")}），多出来的键一律拒：${extra.join("、")}`,
  );
}

function badArgs(message: string): ToolResult {
  return jsonError({ ok: false, code: "INVALID_COMMAND", message });
}

/** 公共执行目标：每次回执都核"谁的哪次执行"（claim_token/owner/workspace 缺一即拒） */
function targetOf(
  args: Record<string, unknown>,
  ctx: McpContext | undefined,
  op: Op,
): { ok: true; target: ExecutionTarget } | { ok: false; result: ToolResult } {
  const projectId = str(args, "project_id");
  const taskId = str(args, "task_id");
  const runId = str(args, "run_id");
  const attemptId = str(args, "attempt_id");
  const workspace = str(args, "workspace");
  const claimToken = str(args, "claim_token");
  const changeId = str(args, "change_id");
  if (projectId === "" || taskId === "" || runId === "" || attemptId === "" || workspace === "" || claimToken === "" || changeId === "") {
    return {
      ok: false,
      result: badArgs(
        `report_execution(${op}) 缺入参：project_id/task_id/run_id/attempt_id/workspace/claim_token/change_id 都必填` +
          "（执行回执只接当前认领持有人，且要带隔离工作目录）",
      ),
    };
  }
  const role = str(args, "role") || "executor";
  const ownerId = str(args, "owner_id") || ctx?.clientName || role;
  const ownerRole = str(args, "owner_role") || role;
  const coordinatorId = str(args, "coordinator_id") || ownerId;
  const clientId = str(args, "client_id") || ctx?.clientName || "unknown";
  const attempt = numOrNull(args, "attempt");
  const expected = numOrNull(args, "expected_revision");
  const target: ExecutionTarget = {
    project_id: projectId,
    task_id: taskId,
    run_id: runId,
    attempt_id: attemptId,
    workspace,
    claim_token: claimToken,
    change_id: changeId,
    owner_id: ownerId,
    owner_role: ownerRole,
    coordinator_id: coordinatorId,
    client_id: clientId,
    ...(str(args, "execution_id") === "" ? {} : { execution_id: str(args, "execution_id") }),
    ...(attempt === null ? {} : { attempt }),
    ...(str(args, "parent_execution_id") === "" ? {} : { parent_execution_id: str(args, "parent_execution_id") }),
    ...(str(args, "parent_run_id") === "" ? {} : { parent_run_id: str(args, "parent_run_id") }),
    ...(str(args, "model") === "" ? {} : { model: str(args, "model") }),
    ...(str(args, "effort") === "" ? {} : { effort: str(args, "effort") }),
    ...(expected === null ? {} : { expected_revision: expected }),
    ...(str(args, "occurred_at") === "" ? {} : { occurred_at: str(args, "occurred_at") }),
  };
  return { ok: true, target };
}

function failWith(e: unknown, what: string): ToolResult {
  if (isWorkError(e)) return jsonError({ ok: false, code: e.code, message: e.message, detail: e.detail });
  return errorResult(`${what}失败：${e instanceof Error ? e.message : String(e)}`);
}

export const reportExecutionTool: McpTool = {
  name: "report_execution",
  description:
    "外部执行器回执链的受控上报（DESIGN.md §5.4；契约 F3）：op=start_requested/started/heartbeat/checkpoint/" +
    "stop_requested/stopped/failed/effect_declared/effect_confirmed/effect_unverified/delivered。" +
    "判据复用 executionReceipts（先声明后确认、停止必须有 confirmation、心跳缺失≠停止）；" +
    "每次回执都核当前认领 token 与持有者；经唯一写入服务转接，返回真实回执。",
  inputSchema: {
    type: "object",
    properties: {
      op: { type: "string", enum: [...OPS], description: "执行回执种类" },
      project_id: { type: "string" },
      task_id: { type: "string" },
      run_id: { type: "string", description: "本次 run 标识（认领事件里的 run_id）" },
      attempt_id: { type: "string", description: "本次 attempt 标识" },
      attempt: { type: "number", description: "可选：第几次尝试" },
      execution_id: { type: "string", description: "可选：执行实体 id（缺省由 task+attempt_id 生成）" },
      coordinator_id: { type: "string", description: "可选：协调器标识（缺省取 owner_id）" },
      client_id: { type: "string", description: "可选：实际客户端（缺省取 MCP 客户端名）" },
      model: { type: "string", description: "可选：实际模型" },
      effort: { type: "string", description: "可选：实际档位" },
      workspace: { type: "string", description: "隔离工作目录（恢复时要按它核对旧进程与未提交改动）" },
      claim_token: { type: "string", description: "本次认领 token（回执只接当前认领持有人）" },
      owner_id: { type: "string", description: "可选：持有者标识（缺省取 MCP 客户端名，再缺省取 role）" },
      owner_role: { type: "string", description: "可选：持有者角色（缺省取 role）" },
      role: { type: "string", description: "调用方角色（缺省 executor）" },
      change_id: { type: "string", description: "事件信封的变更批次" },
      expected_revision: { type: "number", description: "可选：执行实体版本（补交同一意图时带原次版本）" },
      parent_execution_id: { type: "string", description: "可选：父执行 id（协调器自身也是一次执行时给）" },
      parent_run_id: { type: "string", description: "可选：父 run id" },
      occurred_at: { type: "string", description: "可选：业务发生时间（本地带偏移 ISO）" },
      // op 专属
      goal: { type: "string", description: "start_requested：这次跑什么（人话，不进 argv）" },
      argv_digest: { type: "string", description: "start_requested/started：受控模板 argv 摘要" },
      template_source: { type: "string", description: "start_requested：受控模板来源" },
      timeout_ms: { type: "number", description: "start_requested：超时毫秒" },
      client_version: { type: "string", description: "started/delivered：实际客户端版本" },
      pid: { type: "number", description: "started：实际进程号" },
      started_at: { type: "string", description: "started：实际启动时间" },
      note: { type: "string", description: "heartbeat/checkpoint/effect_confirmed：说明" },
      awaiting_input: { type: "boolean", description: "heartbeat/checkpoint：执行器是否在等输入" },
      observed_at: { type: "string", description: "heartbeat/checkpoint：观测时间" },
      artifacts: { type: "array", items: { type: "string" }, description: "checkpoint：已产生成果/证据引用" },
      worktree: { type: "object", description: "checkpoint：工作树未提交改动 {dirty,changed_files,head?}" },
      effects_in_flight: { type: "array", items: { type: "string" }, description: "checkpoint：在飞外部动作" },
      reason: { type: "string", description: "stop_requested：停止理由" },
      confirm_method: { type: "string", description: "stop_requested：怎么确认停止" },
      confirmation: { type: "string", description: "stopped：确认依据（必填，空即拒）" },
      evidence: { type: "array", items: { type: "string" }, description: "stopped：停止现场证据" },
      exit_code: { type: "number", description: "stopped/delivered：退出码" },
      phase: { type: "string", enum: ["launch", "run"], description: "failed：失败阶段" },
      scene: { type: "object", description: "failed：失败现场 {message,exit_code?,stderr_tail?,argv_digest?}" },
      log_ref: { type: "string", description: "failed：失败日志位置" },
      effect_id: { type: "string", description: "effect_*：稳定效果 id" },
      target: { type: "string", description: "effect_declared：动作目标" },
      authorization: { type: "string", description: "effect_declared：授权依据" },
      verify_method: { type: "string", description: "effect_declared：核实方法" },
      external_idempotency_key: { type: "string", description: "effect_declared：外部系统幂等键" },
      result_ref: { type: "string", description: "effect_confirmed：实际结果标识（必填）" },
      check_evidence: { type: "string", description: "effect_unverified：怎么查的/为什么查不清" },
      deliverables: { type: "array", items: { type: "string" }, description: "delivered：交付物" },
      evidence_refs: { type: "array", items: { type: "string" }, description: "delivered：证据引用" },
      verification: { type: "array", description: "delivered：验证命令+退出码+输出位置" },
      untested: { type: "array", items: { type: "string" }, description: "delivered：未测项" },
      known_issues: { type: "array", items: { type: "string" }, description: "delivered：已知问题" },
      diff_ref: { type: "string", description: "delivered：diff 取回位置" },
      result_revision: { type: "string", description: "delivered：结果绑定版本" },
    },
    required: ["op", "project_id", "task_id", "run_id", "attempt_id", "workspace", "claim_token", "change_id"],
    additionalProperties: false,
  },
  handler: async (args, ctx?: McpContext): Promise<ToolResult> => {
    const op = str(args, "op") as Op;
    if (!OPS.includes(op)) return badArgs(`report_execution 的 op 只接受 ${OPS.join("/")}（收到 ${JSON.stringify(args.op)}）`);
    try {
      assertToolArgs(args, OP_KEYS[op], `report_execution(${op})`);
    } catch (e) {
      return badArgs((e as Error).message);
    }
    const work = ctx?.work;
    if (work === undefined) {
      return jsonError({ ok: false, code: "SERVICE_UNAVAILABLE", message: `report_execution(${op}) 拿不到转接客户端（ctx.work）：v2 事实只有一个写入者（DESIGN.md §2.6）` });
    }
    const targetOut = targetOf(args, ctx, op);
    if (!targetOut.ok) return targetOut.result;
    const t = targetOut.target;
    try {
      switch (op) {
        case "start_requested":
          return outcomeResult(await recordStartRequested({ ...t, goal: str(args, "goal"), argv_digest: str(args, "argv_digest"), template_source: str(args, "template_source"), timeout_ms: numOrNull(args, "timeout_ms") ?? 0 }, work));
        case "started":
          return outcomeResult(await recordStarted({ ...t, client_version: str(args, "client_version"), argv_digest: str(args, "argv_digest"), ...(numOrNull(args, "pid") === null ? {} : { pid: numOrNull(args, "pid")! }), ...(str(args, "started_at") === "" ? {} : { started_at: str(args, "started_at") }) }, work));
        case "heartbeat":
          return outcomeResult(await recordHeartbeat({ ...t, ...(str(args, "note") === "" ? {} : { note: str(args, "note") }), ...(args.awaiting_input === undefined ? {} : { awaiting_input: args.awaiting_input === true }), ...(str(args, "observed_at") === "" ? {} : { observed_at: str(args, "observed_at") }) }, work));
        case "checkpoint":
          return outcomeResult(await recordCheckpoint({ ...t, note: str(args, "note"), artifacts: strList(args, "artifacts"), ...(args.worktree === undefined ? {} : { worktree: args.worktree as never }), effects_in_flight: strList(args, "effects_in_flight"), ...(args.awaiting_input === undefined ? {} : { awaiting_input: args.awaiting_input === true }), ...(str(args, "observed_at") === "" ? {} : { observed_at: str(args, "observed_at") }) }, work));
        case "stop_requested":
          return outcomeResult(await recordStopRequested({ ...t, reason: str(args, "reason"), confirm_method: str(args, "confirm_method") }, work));
        case "stopped":
          return outcomeResult(await recordStopped({ ...t, confirmation: str(args, "confirmation"), evidence: strList(args, "evidence"), ...(numOrNull(args, "exit_code") === null ? {} : { exit_code: numOrNull(args, "exit_code")! }) }, work));
        case "failed":
          return outcomeResult(await recordFailed({ ...t, phase: str(args, "phase") as "launch" | "run", scene: (args.scene === undefined ? {} : requireObject(args, "scene")) as never, ...(str(args, "log_ref") === "" ? {} : { log_ref: str(args, "log_ref") }) }, work));
        case "effect_declared":
          return outcomeResult(await declareEffect({ ...t, effect_id: str(args, "effect_id"), target: str(args, "target"), authorization: str(args, "authorization"), verify_method: str(args, "verify_method"), ...(str(args, "external_idempotency_key") === "" ? {} : { external_idempotency_key: str(args, "external_idempotency_key") }) }, work));
        case "effect_confirmed":
          return outcomeResult(await confirmEffect({ ...t, effect_id: str(args, "effect_id"), result_ref: str(args, "result_ref"), ...(str(args, "note") === "" ? {} : { note: str(args, "note") }) }, work));
        case "effect_unverified":
          return outcomeResult(await markEffectUnverified({ ...t, effect_id: str(args, "effect_id"), check_evidence: str(args, "check_evidence") }, work));
        case "delivered":
          return outcomeResult(await recordDelivered({ ...t, deliverables: strList(args, "deliverables"), evidence_refs: strList(args, "evidence_refs"), ...(objList(args, "verification") === undefined ? {} : { verification: objList(args, "verification") as never }), untested: strList(args, "untested"), known_issues: strList(args, "known_issues"), ...(str(args, "diff_ref") === "" ? {} : { diff_ref: str(args, "diff_ref") }), ...(str(args, "result_revision") === "" ? {} : { result_revision: str(args, "result_revision") }), ...(numOrNull(args, "exit_code") === null ? {} : { exit_code: numOrNull(args, "exit_code")! }), ...(str(args, "client_version") === "" ? {} : { client_version: str(args, "client_version") }) }, work));
        default:
          return badArgs(`report_execution 不识别的 op: ${String(op)}`);
      }
    } catch (e) {
      return failWith(e, `report_execution(${op})`);
    }
  },
};

/**
 * 执行回执的结论映射：`ok:true` → 正常结果；`ok:false`（库层的受控拒绝，如
 * `STOP_NOT_CONFIRMED`/`EFFECT_DECLARATION_MISSING`/`CLAIM_NOT_YOURS` 等）→ **MCP 错误结果**，
 * 让客户端按失败处理（不把"被拒"冒充成"成功了但内容里带 ok:false"）。
 */
function outcomeResult(outcome: { ok: boolean }): ToolResult {
  return outcome.ok ? jsonOk(outcome) : jsonError(outcome);
}
