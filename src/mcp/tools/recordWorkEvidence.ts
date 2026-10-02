// record_work_evidence：证据/审计记录的受控 MCP 入口（PLAN V09-27；DESIGN.md §5.5/§6.7；契约 F3）。
//
// 为什么需要它：`audit.ts` 的自检/独立审计/修复/复测与 `evidence.ts` 的缺陷台账此前**在 src/ 内零调用点**
// （唯一实际入口是本机私有脚本，换机即失效）。本工具把它们接成 Agent 真实可调用的入口，判据**完全复用**
// `audit.ts` / `evidence.ts`（独立性固定 author_self、审计者≠作者、覆盖矩阵五视角齐、带 command 必须 exit_code=0、
// 绑定跟随被验对象、缺陷去重/不自动关闭……），不在工具层重造第二套。
//
// 分工与红线（§5.5/§5.8；契约「分工和边界」）：
//   · **证据正文**（store/read）由**唯一写服务宿主**落盘/读回（`reportingHost`），stdio 不直接写项目目录；
//   · 其余 op 经 `ctx.work` 转接唯一写入服务提交事件（MCP 不自己追加事件，§2.6）；
//   · 本工具**不暴露**人工验收 / 用户接受风险（只有用户本人能触发）——`human_acceptance`/`accepted_risk`
//     在这里被点名拒；**不接受 role=user** 的写身份（Agent 不代签用户 Gate）；
//   · 记录有明确版本/对象/来源；不把执行者的自报验证冒充独立审计。
import { projectWorkDir } from "../../server/workstation";
import { resolveDataDir } from "../../server/registry";
import {
  submitFix,
  submitIndependentAudit,
  submitRetest,
  submitSelfCheck,
  submitSubmission,
  type AuditWriteContext,
  type IndependentAuditInput,
  type SelfCheckInput,
  type SubmissionInput,
} from "../../server/work/audit";
import {
  openFinding,
  readFindings,
  submitFindingFix,
  submitFindingRetest,
  transitionFinding,
  type FindingEventInput,
  type FindingSubmitter,
} from "../../server/work/evidence";
import { WorkError, isWorkError, type WorkReceipt } from "../../server/work/types";
import type { WorkSubmitter } from "../../server/work/tasks";
import { errorResult, textResult, type McpContext, type McpTool, type ToolResult } from "./types";

const OPS = ["store", "read", "submission", "self_check", "independent_audit", "fix", "retest", "finding"] as const;
type Op = (typeof OPS)[number];

/** 明确不暴露的用户专属操作（点名拒；Agent 不代签用户 Gate） */
const USER_ONLY_OPS = new Set(["human_acceptance", "acceptance", "accepted_risk", "risk_acceptance", "user_acceptance"]);

const ENVELOPE = ["op", "project_id", "role", "actor_id", "change_id", "occurred_at"] as const;
const OP_KEYS: Record<Op, readonly string[]> = {
  store: ["op", "project_id", "role", "kind", "content", "summary", "created_by", "binding", "source_ref", "source_manifest", "occurred_at"],
  read: ["op", "project_id", "sha256"],
  submission: [
    ...ENVELOPE,
    "record_id",
    "goal",
    "submitted_by",
    "baseline",
    "task_id",
    "round",
    "diff_sha256",
    "diff_recovery",
    "changed_files",
    "affected_interfaces",
    "commands",
    "untested",
    "known_issues",
    "requirement_refs",
    "evidence_refs",
    "binding",
    "runtime_entries",
  ],
  self_check: [...ENVELOPE, "record_id", "task_id", "round", "checked_by", "checks", "conclusion", "binding", "coverage", "method_limits"],
  independent_audit: [
    ...ENVELOPE,
    "record_id",
    "task_id",
    "round",
    "auditor",
    "auditor_role",
    "author_id",
    "same_session_as_author",
    "read_author_summary_first",
    "model_note",
    "checks",
    "coverage",
    "findings",
    "conclusion",
    "not_reported_scope",
    "method_limits",
    "binding",
    "resolves",
    "fix_refs",
  ],
  fix: [...ENVELOPE, "record_id", "finding_id", "fix_revision", "fixed_by", "evidence_ref", "regression"],
  retest: [...ENVELOPE, "record_id", "finding_id", "fix_revision", "retested_by", "retest_evidence", "result", "rerepro_gone", "regression_scope"],
  finding: [
    ...ENVELOPE,
    "sub_op",
    "finding_id",
    "severity",
    "source",
    "expected",
    "actual",
    "repro",
    "evidence_sha256",
    "affected_revision",
    "object_id",
    "duplicate_of",
    "note",
    "to",
    "reviewer",
    "retest_evidence",
    "fix_revision",
    "fixed_by",
    "retested_by",
    "result",
    "rerepro_gone",
    "regression_scope",
  ],
};

const FINDING_SUB_OPS = ["open", "transition", "fix", "retest"] as const;
type FindingSubOp = (typeof FINDING_SUB_OPS)[number];

function jsonOk(payload: unknown): ToolResult {
  return textResult(JSON.stringify(payload, null, 2));
}
function jsonError(payload: unknown): ToolResult {
  return errorResult(JSON.stringify(payload, null, 2));
}
function str(args: Record<string, unknown>, key: string): string {
  return typeof args[key] === "string" ? (args[key] as string).trim() : "";
}
/**
 * 严格数字：**给了就必须是有限数**。旧实现把非法数值静默丢成"没给"（`numOrNull` 回 null），
 * 等于调用者写的 `round: "3"` 被吞掉——闭键不等于严格校验（codex 复审第 3 项）。
 * 一律在**追加事件之前**报错，不静默改内容。
 */
function numOrNull(args: Record<string, unknown>, key: string): number | null {
  const v = args[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new WorkError("INVALID_COMMAND", `入参 ${key} 必须是有限数值（收到 ${JSON.stringify(v)}）`, { field: key });
  }
  return v;
}
/** 严格可选字符串：非字符串一律拒（旧实现把 123/null 之类静默丢成 undefined） */
function strOrUndef(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") {
    throw new WorkError("INVALID_COMMAND", `入参 ${key} 必须是字符串（收到 ${typeof v}）`, { field: key });
  }
  return v.trim() !== "" ? v : undefined;
}
/**
 * 严格字符串数组：给了就必须是"全是非空字符串的数组"。
 * **不 filter**——旧的 `filter` 会把调用者给的已知问题/未测项里非法的那几项悄悄删掉
 * （codex 复审第 3 项：错误必须在追加事件前返回，不能把内容静默丢）。
 */
function strList(args: Record<string, unknown>, key: string): string[] | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) {
    throw new WorkError("INVALID_COMMAND", `入参 ${key} 必须是字符串数组（收到 ${typeof v}）`, { field: key });
  }
  v.forEach((x, i) => {
    if (typeof x !== "string" || x.trim() === "") {
      throw new WorkError(
        "INVALID_COMMAND",
        `入参 ${key}[${i}] 必须是非空字符串（收到 ${JSON.stringify(x)}）：不在追加事件前静默删掉你给的项`,
        { field: key, index: i },
      );
    }
  });
  return v as string[];
}
/** 严格对象数组：给了就必须是"全是对象（非 null、非数组）的数组"，否则明确拒（不静默丢项） */
function objList(args: Record<string, unknown>, key: string): Record<string, unknown>[] | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) {
    throw new WorkError("INVALID_COMMAND", `入参 ${key} 必须是对象数组（收到 ${typeof v}）`, { field: key });
  }
  v.forEach((x, i) => {
    if (typeof x !== "object" || x === null || Array.isArray(x)) {
      throw new WorkError("INVALID_COMMAND", `入参 ${key}[${i}] 必须是对象（收到 ${JSON.stringify(x)}）`, { field: key, index: i });
    }
  });
  return v as Record<string, unknown>[];
}
/** 严格的必填对象：给了就必须是非 null、非数组的对象 */
function requireObject(args: Record<string, unknown>, key: string): Record<string, unknown> {
  const v = args[key];
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new WorkError("INVALID_COMMAND", `入参 ${key} 必须是对象（收到 ${JSON.stringify(v)}）`, { field: key });
  }
  return v as Record<string, unknown>;
}
function badArgs(message: string): ToolResult {
  return jsonError({ ok: false, code: "INVALID_COMMAND", message });
}
function failWith(e: unknown, what: string): ToolResult {
  if (isWorkError(e)) return jsonError({ ok: false, code: e.code, message: e.message, detail: e.detail });
  return errorResult(`${what}失败：${e instanceof Error ? e.message : String(e)}`);
}
function assertToolArgs(args: Record<string, unknown>, allowed: readonly string[], what: string): void {
  const extra = Object.keys(args).filter((k) => !allowed.includes(k));
  if (extra.length === 0) return;
  throw new Error(`${what} 的入参只收这些键（${allowed.join(" / ")}），多出来的键一律拒：${extra.join("、")}`);
}

/**
 * `ctx.work` 的提交适配：`WorkSubmitter.submit` 在类型上是同步的（进程内 `WorkService.submit` 就是同步的），
 * 但 MCP 侧是异步转接客户端。这里把 Promise 转型回 `WorkReceipt`（运行时就是 Promise），
 * 调用方对本工具的这些写函数一律 `await`——与 workObjects/syncEvidence 的转接口径一致。
 */
function submitterOf(work: { submit(command: unknown): Promise<WorkReceipt> }): WorkSubmitter {
  return { submit: (command: unknown): WorkReceipt => work.submit(command) as unknown as WorkReceipt };
}

/**
 * 同步占位回执：只给**同步签名**的缺陷函数兜底（它读不到返回的回执就自己拼一个），
 * **不出本工具**——真实回执由 `await Promise.all(pending)` 之后从盘上读回的权威事实给出。
 */
const PLACEHOLDER_RECEIPT: WorkReceipt = {
  ok: true,
  event_id: "<pending-尚未提交>",
  seq: 0,
  entity_revision: 0,
  received_at: "",
  duplicate: false,
  projection: { state: "applied" },
};

export const recordWorkEvidenceTool: McpTool = {
  name: "record_work_evidence",
  description:
    "证据/审计记录的受控上报（DESIGN.md §5.5/§6.7；契约 F3）。op=store（落证据正文，宿主不可变写入）/ " +
    "read（读回证据正文）/ submission（成果登记）/ self_check（作者自检，独立性固定 author_self）/ " +
    "independent_audit（独立审计，审计者≠作者，覆盖矩阵五视角齐）/ fix（修复待复测）/ retest（复测）/ " +
    "finding（缺陷台账：sub_op=open/transition/fix/retest）。判据复用 audit/evidence，写经唯一写入服务。" +
    "**不暴露人工验收/用户接受风险**，不接受 role=user 代签用户 Gate。",
  inputSchema: {
    type: "object",
    properties: {
      op: { type: "string", enum: [...OPS], description: "store/read/submission/self_check/independent_audit/fix/retest/finding" },
      sub_op: { type: "string", enum: [...FINDING_SUB_OPS], description: "op=finding 必填：open/transition/fix/retest" },
      project_id: { type: "string" },
      role: { type: "string", description: "调用方角色（写操作必填；不接受 user）" },
      actor_id: { type: "string", description: "执行者标识（缺省取 MCP 客户端名）" },
      change_id: { type: "string", description: "事件信封的变更批次" },
      occurred_at: { type: "string", description: "可选：业务发生时间（本地带偏移 ISO）" },
      kind: { type: "string", description: "store：证据 kind（见 evidence.EVIDENCE_KINDS）" },
      content: { type: "string", description: "store：证据正文（字符串）" },
      summary: { type: "string", description: "store：一句话摘要" },
      created_by: { type: "string", description: "store：谁落的正文（缺省取 actor_id）" },
      binding: {
        type: "object",
        description: "store：源修订绑定（revision_kind × revision）",
        properties: {
          revision_kind: { type: "string", enum: ["design", "plan", "interface", "code"] },
          revision: { type: "string" },
        },
        required: ["revision_kind", "revision"],
        additionalProperties: false,
      },
      source_manifest: {
        type: "array",
        description:
          "store（kind=source_manifest）：有限、项目内的源文件清单——每项是项目内相对路径串，或 {path, sha256?}" +
          "（也接受 {files:[...]} 包装）。服务端现读核实（越界/软链/私密目录/超限/编造哈希一律拒）；" +
          "取回 evidence.source_manifest.fingerprint 后，以该指纹填写自检/独审的 binding.revision（revision_kind=code），" +
          "并以 evidence.sha256 填检查项 evidence_sha256。覆盖的源码一变即失效，没覆盖的无关文件变化不影响它。",
        items: {
          type: "object",
          properties: { path: { type: "string" }, sha256: { type: "string" } },
          required: ["path"],
          additionalProperties: false,
        },
      },
      source_ref: { type: "string", description: "store：来源引用" },
      sha256: { type: "string", description: "read：证据内容哈希" },
      record_id: { type: "string", description: "submission/self_check/independent_audit/fix/retest：记录 id" },
      goal: { type: "string", description: "submission：本次目标" },
      submitted_by: { type: "string", description: "submission：提交者（缺省取 actor_id）" },
      task_id: { type: "string", description: "可选：关联任务" },
      round: { type: "number", description: "可选：第几轮" },
      diff_sha256: { type: "string", description: "submission：diff 内容哈希" },
      diff_recovery: { type: "string", description: "submission：diff 取回位置" },
      changed_files: { type: "array", items: { type: "string" }, description: "submission" },
      affected_interfaces: { type: "array", items: { type: "string" }, description: "submission" },
      commands: {
        type: "array",
        description: "submission：验证命令+退出码+输出位置",
        items: {
          type: "object",
          properties: { command: { type: "string" }, exit_code: { type: "number" }, output_ref: { type: "string" } },
          required: ["command", "exit_code"],
          additionalProperties: false,
        },
      },
      untested: {
        type: "array",
        description: "submission：未测项",
        items: {
          type: "object",
          properties: { item: { type: "string" }, reason: { type: "string" } },
          required: ["item", "reason"],
          additionalProperties: false,
        },
      },
      known_issues: { type: "array", items: { type: "string" }, description: "submission" },
      requirement_refs: { type: "array", items: { type: "string" }, description: "submission" },
      evidence_refs: { type: "array", items: { type: "string" }, description: "submission：证据引用" },
      runtime_entries: {
        type: "array",
        description: "submission：可体验运行入口",
        items: {
          type: "object",
          properties: {
            scenario: { type: "string" },
            url: { type: "string" },
            verified_at: { type: "string" },
            status: { type: "string" },
            reason: { type: "string" },
          },
          required: ["scenario", "url", "verified_at", "status"],
          additionalProperties: false,
        },
      },
      baseline: {
        type: "object",
        description: "submission：目标基线",
        properties: {
          baseline_id: { type: "string" },
          design_revision: { type: "string" },
          plan_revision: { type: "string" },
        },
        additionalProperties: false,
      },
      checked_by: { type: "string", description: "self_check：检查者（缺省取 actor_id）" },
      checks: {
        type: "array",
        description: "self_check/independent_audit：逐项检查",
        items: {
          type: "object",
          properties: {
            check_id: { type: "string" },
            result: { type: "string", enum: ["passed", "failed"] },
            command: { type: "string" },
            exit_code: { type: "number" },
            output_ref: { type: "string" },
            evidence_sha256: { type: "string" },
            method: { type: "string" },
            scope: { type: "array", items: { type: "string" } },
            verifies: { type: "string", enum: ["document", "code", "artifact"] },
          },
          required: ["check_id"],
          additionalProperties: false,
        },
      },
      conclusion: { type: "string", enum: ["pass", "fail"], description: "self_check/independent_audit：结论" },
      coverage: {
        type: "array",
        description: "self_check/independent_audit：覆盖矩阵",
        items: {
          type: "object",
          properties: { area: { type: "string" }, status: { type: "string" }, basis: { type: "string" } },
          required: ["area", "basis"],
          additionalProperties: false,
        },
      },
      method_limits: { type: "array", items: { type: "string" }, description: "self_check/independent_audit：方法限制" },
      auditor: { type: "string", description: "independent_audit：审计者" },
      auditor_role: { type: "string", description: "independent_audit：审计者角色" },
      author_id: { type: "string", description: "independent_audit：被审作者（审计者≠作者）" },
      same_session_as_author: { type: "boolean", description: "independent_audit" },
      read_author_summary_first: { type: "boolean", description: "independent_audit" },
      model_note: { type: "string", description: "independent_audit" },
      findings: { type: "array", items: { type: "string" }, description: "independent_audit" },
      not_reported_scope: { type: "array", items: { type: "string" }, description: "independent_audit" },
      resolves: { type: "array", items: { type: "string" }, description: "independent_audit：本记录解除的失败审计 id" },
      fix_refs: { type: "array", items: { type: "string" }, description: "independent_audit：修复事实引用" },
      finding_id: { type: "string", description: "fix/retest/finding：缺陷 id" },
      fix_revision: { type: "string", description: "fix/finding：修复绑定的版本" },
      fixed_by: { type: "string", description: "fix/finding：修复者（缺省取 actor_id）" },
      evidence_ref: { type: "string", description: "fix：修复证据位置" },
      regression: {
        type: "array",
        description: "fix：回归命令",
        items: {
          type: "object",
          properties: { command: { type: "string" }, exit_code: { type: "number" }, output_ref: { type: "string" } },
          required: ["command", "exit_code"],
          additionalProperties: false,
        },
      },
      retested_by: { type: "string", description: "retest/finding：复测者" },
      retest_evidence: { type: "string", description: "retest/finding：复测证据" },
      result: { type: "string", enum: ["pass", "fail"], description: "retest/finding：结果" },
      rerepro_gone: { type: "boolean", description: "retest/finding" },
      regression_scope: { type: "array", items: { type: "string" }, description: "retest/finding" },
      severity: { type: "string", description: "finding(open)：严重度" },
      source: { type: "string", description: "finding(open)：来源" },
      expected: { type: "string", description: "finding(open)：应当怎样" },
      actual: { type: "string", description: "finding(open)：实际怎样" },
      repro: { type: "string", description: "finding(open)：复现步骤" },
      evidence_sha256: { type: "string", description: "finding(open/fix)：证据哈希" },
      affected_revision: { type: "string", description: "finding(open)：受影响版本" },
      object_id: { type: "string", description: "finding(open)：被验对象" },
      duplicate_of: { type: "string", description: "finding(open/transition)：重复本体" },
      note: { type: "string", description: "finding：备注" },
      to: { type: "string", description: "finding(transition)：目标状态" },
      reviewer: { type: "string", description: "finding(transition)：评审者" },
    },
    required: ["op", "project_id"],
    additionalProperties: false,
  },
  handler: async (args, ctx?: McpContext): Promise<ToolResult> => {
    const op = str(args, "op") as Op;
    if (USER_ONLY_OPS.has(op)) {
      return jsonError({
        ok: false,
        code: "FORBIDDEN",
        message: `record_work_evidence 不暴露人工验收/用户接受风险（收到 op=${op}）：那只能由用户本人在用户界面触发，Agent 不代签（DESIGN.md §5.8）`,
      });
    }
    if (!OPS.includes(op)) return badArgs(`record_work_evidence 的 op 只接受 ${OPS.join("/")}（收到 ${JSON.stringify(args.op)}）`);
    try {
      assertToolArgs(args, OP_KEYS[op], `record_work_evidence(${op})`);
    } catch (e) {
      return badArgs((e as Error).message);
    }
    const projectId = str(args, "project_id");
    if (projectId === "") return badArgs("record_work_evidence 缺入参 project_id");
    const role = str(args, "role");

    // read 走宿主只读读口；不需要 role / 不改账
    if (op === "read") {
      const sha256 = str(args, "sha256");
      if (sha256 === "") return badArgs("record_work_evidence(read) 缺入参 sha256");
      if (!/^[0-9a-f]{64}$/.test(sha256)) {
        return badArgs("record_work_evidence(read) 的 sha256 必须是 64 位小写十六进制（拒绝路径穿越/非法内容地址）");
      }
      const work = ctx?.work;
      if (work === undefined) return jsonError({ ok: false, code: "SERVICE_UNAVAILABLE", message: "record_work_evidence(read) 拿不到转接客户端（ctx.work）：证据正文只能由唯一写服务宿主读回" });
      try {
        return jsonOk({ ok: true, evidence: await work.readEvidenceRemote(projectId, sha256) });
      } catch (e) {
        return failWith(e, "record_work_evidence(read)");
      }
    }

    if (role === "") return badArgs(`record_work_evidence(${op}) 缺入参 role`);
    if (role === "user") {
      return jsonError({
        ok: false,
        code: "FORBIDDEN",
        message: "record_work_evidence 不接受 role=user：Agent 工具不代签用户 Gate/人工验收（DESIGN.md §5.8）",
      });
    }
    const work = ctx?.work;
    if (work === undefined) {
      return jsonError({ ok: false, code: "SERVICE_UNAVAILABLE", message: `record_work_evidence(${op}) 拿不到转接客户端（ctx.work）：v2 事实只有一个写入者（DESIGN.md §2.6）` });
    }
    const actorId = str(args, "actor_id") || ctx?.clientName || role;
    const changeId = str(args, "change_id");
    // store 只落证据正文（不改账、无事件），不需要 change_id；其余写事件的操作都要信封批次
    if (op !== "store" && changeId === "") return badArgs(`record_work_evidence(${op}) 缺入参 change_id`);
    const occurredAt = strOrUndef(args, "occurred_at");
    const writeCtx: AuditWriteContext = {
      project_id: projectId,
      change_id: changeId,
      actor_id: actorId,
      role,
      ...(occurredAt === undefined ? {} : { occurred_at: occurredAt }),
    };
    const submitter = submitterOf(work);

    try {
      if (op === "store") {
        const kind = str(args, "kind");
        const summary = str(args, "summary");
        if (kind === "" || summary === "") return badArgs("record_work_evidence(store) 缺入参 kind/summary");
        const binding = args.binding;
        if (typeof binding !== "object" || binding === null) return badArgs("record_work_evidence(store) 缺入参 binding（{revision_kind, revision}）");
        const hasManifest = args.source_manifest !== undefined && args.source_manifest !== null;
        const content = typeof args.content === "string" ? args.content : "";
        if (content === "" && !hasManifest) {
          return badArgs("record_work_evidence(store) 缺入参 content（证据正文字符串）——要么给正文，要么给 source_manifest 清单");
        }
        if (kind === "source_manifest" && !hasManifest) {
          return badArgs("record_work_evidence(store) 的 kind=source_manifest 必须带 source_manifest（有限文件集合 {path,sha256?}[]）");
        }
        const blob = await work.saveEvidence(projectId, {
          content,
          kind: kind as never,
          summary,
          created_by: str(args, "created_by") || actorId,
          role,
          binding: binding as never,
          source_ref: strOrUndef(args, "source_ref") ?? null,
          ...(hasManifest ? { source_manifest: args.source_manifest } : {}),
          ...(occurredAt === undefined ? {} : { occurred_at: occurredAt }),
        });
        return jsonOk({ ok: true, op, evidence: blob });
      }

      if (op === "submission") {
        const recordId = str(args, "record_id");
        const goal = str(args, "goal");
        if (recordId === "" || goal === "") return badArgs("record_work_evidence(submission) 缺入参 record_id/goal");
        const input: SubmissionInput = {
          ...writeCtx,
          record_id: recordId,
          goal,
          submitted_by: str(args, "submitted_by") || actorId,
          ...(args.baseline === undefined ? {} : { baseline: requireObject(args, "baseline") as never }),
          ...(strOrUndef(args, "task_id") === undefined ? {} : { task_id: str(args, "task_id") }),
          ...(numOrNull(args, "round") === null ? {} : { round: numOrNull(args, "round")! }),
          ...(strOrUndef(args, "diff_sha256") === undefined ? {} : { diff_sha256: str(args, "diff_sha256") }),
          ...(strOrUndef(args, "diff_recovery") === undefined ? {} : { diff_recovery: str(args, "diff_recovery") }),
          ...(strList(args, "changed_files") === undefined ? {} : { changed_files: strList(args, "changed_files")! }),
          ...(strList(args, "affected_interfaces") === undefined ? {} : { affected_interfaces: strList(args, "affected_interfaces")! }),
          ...(objList(args, "commands") === undefined ? {} : { commands: objList(args, "commands") as never }),
          ...(objList(args, "untested") === undefined ? {} : { untested: objList(args, "untested") as never }),
          ...(strList(args, "known_issues") === undefined ? {} : { known_issues: strList(args, "known_issues")! }),
          ...(strList(args, "requirement_refs") === undefined ? {} : { requirement_refs: strList(args, "requirement_refs")! }),
          ...(strList(args, "evidence_refs") === undefined ? {} : { evidence_refs: strList(args, "evidence_refs")! }),
          ...(args.binding === undefined ? {} : { binding: args.binding as never }),
          ...(objList(args, "runtime_entries") === undefined ? {} : { runtime_entries: objList(args, "runtime_entries") as never }),
        };
        const receipt = await submitSubmission(submitter, input);
        return jsonOk({ ok: true, op, receipt });
      }

      if (op === "self_check") {
        const recordId = str(args, "record_id");
        if (recordId === "") return badArgs("record_work_evidence(self_check) 缺入参 record_id");
        if (args.conclusion !== "pass" && args.conclusion !== "fail") return badArgs("record_work_evidence(self_check) 的 conclusion 只接受 pass/fail");
        const checks = objList(args, "checks");
        if (checks === undefined) return badArgs("record_work_evidence(self_check) 缺入参 checks[]");
        const input: SelfCheckInput = {
          ...writeCtx,
          record_id: recordId,
          checked_by: str(args, "checked_by") || actorId,
          checks: checks as never,
          conclusion: args.conclusion,
          ...(strOrUndef(args, "task_id") === undefined ? {} : { task_id: str(args, "task_id") }),
          ...(numOrNull(args, "round") === null ? {} : { round: numOrNull(args, "round")! }),
          ...(args.binding === undefined ? {} : { binding: args.binding as never }),
          ...(objList(args, "coverage") === undefined ? {} : { coverage: objList(args, "coverage") as never }),
          ...(strList(args, "method_limits") === undefined ? {} : { method_limits: strList(args, "method_limits")! }),
        };
        const receipt = await submitSelfCheck(submitter, input);
        return jsonOk({ ok: true, op, receipt });
      }

      if (op === "independent_audit") {
        const recordId = str(args, "record_id");
        const auditor = str(args, "auditor");
        const authorId = str(args, "author_id");
        if (recordId === "" || auditor === "" || authorId === "") return badArgs("record_work_evidence(independent_audit) 缺入参 record_id/auditor/author_id");
        if (args.conclusion !== "pass" && args.conclusion !== "fail") return badArgs("record_work_evidence(independent_audit) 的 conclusion 只接受 pass/fail");
        const coverage = objList(args, "coverage");
        if (coverage === undefined) return badArgs("record_work_evidence(independent_audit) 缺入参 coverage[]（五个视角都要给依据）");
        const input: IndependentAuditInput = {
          ...writeCtx,
          record_id: recordId,
          auditor,
          author_id: authorId,
          coverage: coverage as never,
          conclusion: args.conclusion,
          ...(strOrUndef(args, "auditor_role") === undefined ? {} : { auditor_role: str(args, "auditor_role") }),
          ...(strOrUndef(args, "task_id") === undefined ? {} : { task_id: str(args, "task_id") }),
          ...(numOrNull(args, "round") === null ? {} : { round: numOrNull(args, "round")! }),
          ...(args.same_session_as_author === undefined ? {} : { same_session_as_author: args.same_session_as_author === true }),
          ...(args.read_author_summary_first === undefined ? {} : { read_author_summary_first: args.read_author_summary_first === true }),
          ...(strOrUndef(args, "model_note") === undefined ? {} : { model_note: str(args, "model_note") }),
          ...(objList(args, "checks") === undefined ? {} : { checks: objList(args, "checks") as never }),
          ...(strList(args, "findings") === undefined ? {} : { findings: strList(args, "findings")! }),
          ...(strList(args, "not_reported_scope") === undefined ? {} : { not_reported_scope: strList(args, "not_reported_scope")! }),
          ...(strList(args, "method_limits") === undefined ? {} : { method_limits: strList(args, "method_limits")! }),
          ...(args.binding === undefined ? {} : { binding: args.binding as never }),
          ...(strList(args, "resolves") === undefined ? {} : { resolves: strList(args, "resolves")! }),
          ...(strList(args, "fix_refs") === undefined ? {} : { fix_refs: strList(args, "fix_refs")! }),
        };
        const receipt = await submitIndependentAudit(submitter, input);
        return jsonOk({ ok: true, op, receipt });
      }

      if (op === "fix") {
        const recordId = str(args, "record_id");
        const findingId = str(args, "finding_id");
        const fixRevision = str(args, "fix_revision");
        if (recordId === "" || findingId === "" || fixRevision === "") return badArgs("record_work_evidence(fix) 缺入参 record_id/finding_id/fix_revision");
        const receipt = await submitFix(submitter, {
          ...writeCtx,
          record_id: recordId,
          finding_id: findingId,
          fix_revision: fixRevision,
          fixed_by: str(args, "fixed_by") || actorId,
          ...(strOrUndef(args, "evidence_ref") === undefined ? {} : { evidence_ref: str(args, "evidence_ref") }),
          ...(objList(args, "regression") === undefined ? {} : { regression: objList(args, "regression") as never }),
        });
        return jsonOk({ ok: true, op, receipt });
      }

      if (op === "retest") {
        const recordId = str(args, "record_id");
        const findingId = str(args, "finding_id");
        const retestEvidence = str(args, "retest_evidence");
        if (recordId === "" || findingId === "" || retestEvidence === "") return badArgs("record_work_evidence(retest) 缺入参 record_id/finding_id/retest_evidence");
        if (args.result !== "pass" && args.result !== "fail") return badArgs("record_work_evidence(retest) 的 result 只接受 pass/fail");
        const receipt = await submitRetest(submitter, {
          ...writeCtx,
          record_id: recordId,
          finding_id: findingId,
          retested_by: str(args, "retested_by") || actorId,
          retest_evidence: retestEvidence,
          result: args.result,
          ...(strOrUndef(args, "fix_revision") === undefined ? {} : { fix_revision: str(args, "fix_revision") }),
          ...(args.rerepro_gone === undefined ? {} : { rerepro_gone: args.rerepro_gone === true }),
          ...(strList(args, "regression_scope") === undefined ? {} : { regression_scope: strList(args, "regression_scope")! }),
        });
        return jsonOk({ ok: true, op, receipt });
      }

      // op=finding：缺陷台账（去重先于新建；复测者≠报告者；接受风险只能用户——本工具不暴露）
      //
      // evidence.ts 的缺陷函数是**同步签名**（提交 + 立刻读盘算 expected_revision / 判去重）；MCP 侧提交是
      // **异步转接**。若直传异步客户端，函数内部的读盘会赶在写入落地之前（读到旧现场），且 openFinding 把
      // 未 await 的 Promise 丢在身后。这里用 workObjects 同款的「同步占位回执 + 记录真实提交」转接口径：
      // 函数同步跑完后 `await Promise.all(pending)` 保证每个提交都落地（失败即抛→工具报错），
      // 再从盘上读回权威缺陷事实——**不丢提交、不把占位回执出接口**。
      const subOp = str(args, "sub_op") as FindingSubOp;
      if (!FINDING_SUB_OPS.includes(subOp)) return badArgs(`record_work_evidence(finding) 缺/非法 sub_op：只接受 ${FINDING_SUB_OPS.join("/")}`);
      const workDir = projectWorkDir(projectId, resolveDataDir());
      const pending: Promise<WorkReceipt>[] = [];
      const findingSubmitter: FindingSubmitter = {
        submit: (command: unknown): WorkReceipt => {
          pending.push(work.submit(command));
          return PLACEHOLDER_RECEIPT;
        },
        read: () => readFindings(workDir),
      };
      const findingCtx: FindingEventInput = { project_id: projectId, change_id: changeId, actor_id: actorId, role, ...(occurredAt === undefined ? {} : { occurred_at: occurredAt }) };
      let findingId = "";
      let deduped: boolean | null = null;
      if (subOp === "open") {
        const severity = str(args, "severity");
        const source = str(args, "source");
        const expected = str(args, "expected");
        const actual = str(args, "actual");
        if (severity === "" || source === "" || expected === "" || actual === "") {
          return badArgs("record_work_evidence(finding:open) 缺入参 severity/source/expected/actual");
        }
        const res = openFinding(findingSubmitter, {
          ...findingCtx,
          severity: severity as never,
          source,
          expected,
          actual,
          ...(strOrUndef(args, "repro") === undefined ? {} : { repro: str(args, "repro") }),
          ...(strOrUndef(args, "evidence_sha256") === undefined ? {} : { evidence_sha256: str(args, "evidence_sha256") }),
          ...(strOrUndef(args, "affected_revision") === undefined ? {} : { affected_revision: str(args, "affected_revision") }),
          ...(strOrUndef(args, "object_id") === undefined ? {} : { object_id: str(args, "object_id") }),
          ...(strOrUndef(args, "duplicate_of") === undefined ? {} : { duplicate_of: str(args, "duplicate_of") }),
          ...(strOrUndef(args, "note") === undefined ? {} : { note: str(args, "note") }),
        });
        findingId = res.finding_id;
        deduped = res.deduped;
      } else if (subOp === "transition") {
        const id = str(args, "finding_id");
        const to = str(args, "to");
        if (id === "" || to === "") return badArgs("record_work_evidence(finding:transition) 缺入参 finding_id/to");
        transitionFinding(findingSubmitter, {
          ...findingCtx,
          finding_id: id,
          to: to as never,
          ...(strOrUndef(args, "reviewer") === undefined ? {} : { reviewer: str(args, "reviewer") }),
          ...(strOrUndef(args, "duplicate_of") === undefined ? {} : { duplicate_of: str(args, "duplicate_of") }),
          ...(strOrUndef(args, "note") === undefined ? {} : { note: str(args, "note") }),
          ...(strOrUndef(args, "retest_evidence") === undefined ? {} : { retest_evidence: str(args, "retest_evidence") }),
        });
        findingId = id;
      } else if (subOp === "fix") {
        const id = str(args, "finding_id");
        const fixRevision = str(args, "fix_revision");
        if (id === "" || fixRevision === "") return badArgs("record_work_evidence(finding:fix) 缺入参 finding_id/fix_revision");
        submitFindingFix(findingSubmitter, {
          ...findingCtx,
          finding_id: id,
          fix_revision: fixRevision,
          ...(strOrUndef(args, "fixed_by") === undefined ? {} : { fixed_by: str(args, "fixed_by") }),
          ...(strOrUndef(args, "evidence_sha256") === undefined ? {} : { evidence_sha256: str(args, "evidence_sha256") }),
        });
        findingId = id;
      } else {
        const id = str(args, "finding_id");
        const retestEvidence = str(args, "retest_evidence");
        if (id === "" || retestEvidence === "") return badArgs("record_work_evidence(finding:retest) 缺入参 finding_id/retest_evidence");
        if (args.result !== "pass" && args.result !== "fail") return badArgs("record_work_evidence(finding:retest) 的 result 只接受 pass/fail");
        submitFindingRetest(findingSubmitter, {
          ...findingCtx,
          finding_id: id,
          retested_by: str(args, "retested_by") || actorId,
          retest_evidence: retestEvidence,
          result: args.result,
          ...(args.rerepro_gone === undefined ? {} : { rerepro_gone: args.rerepro_gone === true }),
          ...(strList(args, "regression_scope") === undefined ? {} : { regression_scope: strList(args, "regression_scope")! }),
        });
        findingId = id;
      }
      const receipts = await Promise.all(pending);
      const authoritative = findingId === "" ? null : readFindings(workDir).findings[findingId] ?? null;
      return jsonOk({
        ok: true,
        op,
        sub_op: subOp,
        ...(findingId === "" ? {} : { finding_id: findingId }),
        ...(deduped === null ? {} : { deduped }),
        finding: authoritative,
        receipt: receipts[receipts.length - 1] ?? null,
      });
    } catch (e) {
      return failWith(e, `record_work_evidence(${op})`);
    }
  },
};
