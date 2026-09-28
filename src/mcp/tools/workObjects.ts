// 需求/变更对象命令与施工定义导入的 MCP 入口（批3 C-015 接线；DESIGN.md §2.5 / §2.6 / §6）。
//
// 为什么要有这个文件（终审 C-015 的修复落点）：
//   · requirements.ts / changes.ts 的七个公共写命令与 references.ts 的引用校验，
//     此前只有验证脚本在调——**没有任何生产入口**（MCP 工具面、HTTP 面都没有）。
//     这里把"创建/读回"接成 Agent 真实可调用的 MCP 工具，校验仍只活在对象命令层
//     （单一判据来源），不在工具里重造第二套。
//   · 写操作走 `ctx.work` 转接唯一写入服务（§2.6：MCP 不自己追加事件）；
//     对象命令是同步函数（库层与进程内服务同用它），所以先在进程内**校验 + 计划出命令本体**
//     （此阶段零写入，校验失败同步抛），再把同一份命令逐条交给转接客户端真实提交——
//     版本/幂等由服务端仲裁，回执用真实回执（校验计划阶段的占位回执不出本文件）。
//   · 读操作只读盘上投影（与 claims.ts 读事件同一口径），不需要写入服务在场。
//   · 入参闭键：工具边界同样 fail-closed——没声明的键（intent_text 等正文走私面）
//     在工具层就点名拒，不静默丢弃后还回成功（与对象命令的 assertCommandKeys 同一口径）。
import { getProject, resolveDataDir } from "../../server/registry";
import { projectWorkDir, workstationDir } from "../../server/workstation";
import { loadDocument } from "../../server/work/documents";
import { NO_CHANGE_ID, WorkError, isWorkError, type WorkReceipt } from "../../server/work/types";
import {
  collectRegisteredReferences,
  importPlanChecked,
  type RegisteredReferences,
} from "../../server/work/references";
import {
  readRequirements,
  registerRequirement,
  setRequirementStatus,
  updateRequirement,
  type RequirementState,
} from "../../server/work/requirements";
import {
  readChanges,
  readChatChangeRecords,
  openChange,
  setChangeStatus,
  closeChange,
  adoptChatChange,
  autoChangeBatchId,
  type ChangeState,
} from "../../server/work/changes";
import { readTaskStates, submitDefinitionImports, type WorkSubmitter } from "../../server/work/tasks";
import { errorResult, textResult, type McpContext, type McpTool, type ToolResult } from "./types";

function jsonOk(payload: unknown): ToolResult {
  return textResult(JSON.stringify(payload, null, 2));
}

function jsonError(payload: unknown): ToolResult {
  return errorResult(JSON.stringify(payload, null, 2));
}

function str(args: Record<string, unknown>, key: string): string {
  return typeof args[key] === "string" ? (args[key] as string).trim() : "";
}

function strOrNull(args: Record<string, unknown>, key: string): string | null {
  const v = str(args, key);
  return v === "" ? null : v;
}

function numOrNull(args: Record<string, unknown>, key: string): number | null {
  const v = args[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** 写入服务转接客户端不在场的统一话术：不自己写事件（§2.6） */
function serviceUnavailable(e: unknown): ToolResult | null {
  if (isWorkError(e) && e.code === "SERVICE_UNAVAILABLE") {
    return jsonError({ ok: false, code: "SERVICE_UNAVAILABLE", message: e.message, detail: e.detail });
  }
  return null;
}

function failWith(e: unknown, what: string): ToolResult {
  const offline = serviceUnavailable(e);
  if (offline !== null) return offline;
  if (isWorkError(e)) return jsonError({ ok: false, code: e.code, message: e.message, detail: e.detail });
  return errorResult(`${what}失败：${e instanceof Error ? e.message : String(e)}`);
}

/**
 * 工具入参闭键守卫：没声明的键一律拒（正文走私面在工具层就挡下，
 * 不让"被静默丢掉却回了成功"这种现场存在——与对象命令的 assertCommandKeys 同一口径）
 */
function assertToolArgs(args: Record<string, unknown>, allowed: readonly string[], what: string): void {
  const extra = Object.keys(args).filter((k) => !allowed.includes(k));
  if (extra.length === 0) return;
  throw new WorkError(
    "INVALID_COMMAND",
    `${what} 的入参只收这些键（${allowed.join(" / ")}），多出来的键一律拒：${extra.join("、")}。` +
      "意图/设计正文的唯一写入源仍是各自的事实文件（DESIGN.md §2.6 单源分工），这里只收结构化字段与引用",
    { extra, allowed, tool: what },
  );
}

function badArgs(message: string, detail: Record<string, unknown> = {}): never {
  throw new WorkError("INVALID_COMMAND", message, detail);
}

/** 项目 v2 事实目录（路径只走注册表；未知项目按 INVALID_COMMAND 拒，不猜路径） */
function workDirOf(projectId: string, dataDir: string): string {
  const project = getProject(projectId, dataDir);
  if (!project) {
    throw new WorkError("INVALID_COMMAND", `项目不存在: ${projectId}`, { project_id: projectId });
  }
  return projectWorkDir(projectId, dataDir);
}

// ── 校验 + 计划（同步，零写入）→ 转接真实提交（异步，唯一写入者仲裁） ──

/** 占位回执：只给同步对象命令的返回值兜底，**不出本文件**——调用方拿到的一定是真实提交的回执 */
const PLANNED_ONLY_RECEIPT: WorkReceipt = {
  ok: true,
  event_id: "<planned-尚未提交>",
  seq: 0,
  entity_revision: 0,
  received_at: "",
  duplicate: false,
  projection: { state: "failed", error: "这条回执只是校验通过后的计划占位，事件尚未提交" },
};

/** 计划提交者：捕获对象命令算出的命令本体；读侧闭包从盘上投影现读（模块不猜项目路径） */
interface Planner extends WorkSubmitter {
  /** 项目 `.工作台/` 目录（核 `kind="intent"` 的来源引用要用，见 requirements.ts `RequirementReadSource`） */
  workbenchDir: string;
  read: () => { requirements: Record<string, RequirementState>; changes: Record<string, ChangeState> };
  readChatChanges: () => ReturnType<typeof readChatChangeRecords>;
  readReferences: () => RegisteredReferences;
  planned: unknown[];
}

/** `workbenchDir` = 项目的 `.工作台/`（`intent.json` 在这一层），与 `workDir` 同一条注册表路径规则 */
function plannerFor(workDir: string, workbenchDir: string): Planner {
  const planned: unknown[] = [];
  return {
    planned,
    workbenchDir,
    submit: (command: unknown): WorkReceipt => {
      planned.push(command);
      return PLANNED_ONLY_RECEIPT;
    },
    read: () => {
      const r = readRequirements(workDir);
      const c = readChanges(workDir);
      return { requirements: r.requirements, changes: c.changes };
    },
    readChatChanges: () => readChatChangeRecords(workDir),
    readReferences: () => collectRegisteredReferences(workDir),
  };
}

/**
 * 跑一条对象命令：同步校验 + 计划（失败抛 WorkError，**零写入**），再逐条真实提交。
 * 对象命令的幂等键是确定性的，重发同一次意图由服务端幂等仲裁（同键同内容返回原回执）。
 */
async function runPlanned(
  ctx: McpContext | undefined,
  workDir: string,
  workbenchDir: string,
  what: string,
  plan: (planner: Planner) => void,
): Promise<WorkReceipt[]> {
  const work = ctx?.work;
  if (work === undefined) {
    throw new WorkError(
      "SERVICE_UNAVAILABLE",
      `${what} 拿不到转接客户端（ctx.work）：v2 事实只有一个写入者，MCP 不自己追加事件（DESIGN.md §2.6）`,
      { tool: what },
    );
  }
  const planner = plannerFor(workDir, workbenchDir);
  plan(planner);
  if (planner.planned.length === 0) {
    throw new WorkError("INVALID_COMMAND", `${what} 校验通过但没有计划出任何命令——这是工具内部异常，本次零写入`, {
      tool: what,
    });
  }
  const receipts: WorkReceipt[] = [];
  for (const command of planner.planned) {
    receipts.push(await work.submit(command));
  }
  return receipts;
}

/** 写操作公共入参解析（project_id/role 必填；actor_id 缺省取 MCP 客户端名，再缺省取 role） */
function writeEnvelope(args: Record<string, unknown>, ctx: McpContext | undefined, what: string) {
  const projectId = str(args, "project_id");
  const role = str(args, "role");
  if (projectId === "" || role === "") badArgs(`${what} 缺入参 project_id/role（两者都必填）`);
  const actorId = str(args, "actor_id") || ctx?.clientName || role;
  return { projectId, role, actorId };
}

// ── ① manage_requirement：需求对象的创建/更新/改状态/读回 ──

const REQUIREMENT_OPS = ["register", "update", "set_status", "read"] as const;
type RequirementOp = (typeof REQUIREMENT_OPS)[number];

const REQUIREMENT_ENVELOPE_KEYS = ["op", "project_id", "role", "change_id", "actor_id"] as const;
const REQUIREMENT_OP_ARG_KEYS: Record<RequirementOp, readonly string[]> = {
  register: [
    ...REQUIREMENT_ENVELOPE_KEYS,
    "requirement_id",
    "source",
    "problem",
    "users",
    "success_scenarios",
    "exclusions",
    "priority",
    "status",
  ],
  update: [...REQUIREMENT_ENVELOPE_KEYS, "requirement_id", "fields"],
  set_status: [...REQUIREMENT_ENVELOPE_KEYS, "requirement_id", "status", "reason"],
  read: ["op", "project_id", "requirement_id"],
};

export const manageRequirementTool: McpTool = {
  name: "manage_requirement",
  description:
    "需求对象命令入口（DESIGN.md §2.5/§2.6）：op=register（注册，字段是 §2.5 最小集，多键拒）/ update（改字段，稳定 id 不变）/ " +
    "set_status（明确/推断/待确认）/ read（读回投影，不给 requirement_id 则列全部）。写操作经唯一写入服务转接提交；" +
    "只存结构化字段与来源引用 source{kind,ref}，意图正文仍在 intent.json/聊天记录/设计原文（塞正文键一律拒）",
  inputSchema: {
    type: "object",
    properties: {
      op: { type: "string", enum: [...REQUIREMENT_OPS], description: "register/update/set_status/read" },
      project_id: { type: "string", description: "注册表里的项目 id" },
      role: { type: "string", description: "调用方角色（写操作必填）" },
      change_id: {
        type: "string",
        description: `事件信封的变更批次（写操作用；不挂批次填 ${NO_CHANGE_ID}，缺省即此值）`,
      },
      actor_id: { type: "string", description: "执行者标识（缺省取 MCP 客户端名）" },
      requirement_id: { type: "string", description: "需求稳定 id（req- 前缀；read 不给则返回全部）" },
      source: {
        type: "object",
        description: "op=register 必填：来源引用 {kind: intent/chat/design/decision/user/external, ref: 位置引用}——不是正文",
        properties: { kind: { type: "string" }, ref: { type: "string" } },
        required: ["kind", "ref"],
        additionalProperties: false,
      },
      problem: { type: "string", description: "op=register 必填：要解决的问题" },
      users: { type: "array", items: { type: "string" }, description: "op=register 必填：使用者（空数组=已确认没有）" },
      success_scenarios: { type: "array", items: { type: "string" }, description: "op=register 必填：成功场景" },
      exclusions: { type: "array", items: { type: "string" }, description: "op=register 必填：排除项" },
      priority: { type: "string", description: "op=register 必填：优先级" },
      status: { type: "string", enum: ["explicit", "inferred", "unconfirmed"], description: "明确/推断/待确认" },
      fields: { type: "object", description: "op=update 必填：要改的字段（至少一个，键集合同注册字段）" },
      reason: { type: "string", description: "op=set_status 可选：改状态的理由" },
    },
    required: ["op", "project_id"],
    additionalProperties: false,
  },
  handler: async (args, ctx?: McpContext) => {
    const op = str(args, "op") as RequirementOp;
    if (!REQUIREMENT_OPS.includes(op)) {
      return errorResult(`manage_requirement 的 op 只接受 ${REQUIREMENT_OPS.join("/")}（收到 ${JSON.stringify(args.op)}）`);
    }
    try {
      assertToolArgs(args, REQUIREMENT_OP_ARG_KEYS[op], `manage_requirement(${op})`);
      const dataDir = resolveDataDir();
      const projectId = str(args, "project_id");
      if (projectId === "") return errorResult("manage_requirement 缺入参 project_id");
      const workDir = workDirOf(projectId, dataDir);

      if (op === "read") {
        const projection = readRequirements(workDir);
        const requirementId = strOrNull(args, "requirement_id");
        if (requirementId === null) {
          return jsonOk({ ok: true, requirements: projection.requirements, last_seq: projection.last_seq });
        }
        return jsonOk({
          ok: true,
          requirement: projection.requirements[requirementId] ?? null,
          known_ids: Object.keys(projection.requirements).sort(),
        });
      }

      const { role, actorId } = writeEnvelope(args, ctx, `manage_requirement(${op})`);
      const changeId = str(args, "change_id") || NO_CHANGE_ID;
      const requirementId = str(args, "requirement_id");
      if (requirementId === "") return errorResult(`manage_requirement(${op}) 缺入参 requirement_id`);
      // 登记/更新要核 `kind="intent"` 的来源引用：把项目的 `.工作台/`（intent.json 所在层）交给对象命令层
      const workbenchDir = workstationDir(projectId, dataDir);
      const envelope = {
        project_id: projectId,
        requirement_id: requirementId,
        change_id: changeId,
        actor_id: actorId,
        role,
      };
      const receipts = await runPlanned(ctx, workDir, workbenchDir, `manage_requirement(${op})`, (planner) => {
        if (op === "register") {
          registerRequirement(planner, {
            ...envelope,
            // 字段原样透传给对象命令的权威校验（不过滤、不修剪——非法值要在对象命令层被点名拒，
            // 不能在工具层被"显式挑键"悄悄丢掉还回成功）
            source: args.source as never,
            problem: args.problem as string,
            users: args.users as string[],
            success_scenarios: args.success_scenarios as string[],
            exclusions: args.exclusions as string[],
            priority: args.priority as string,
            status: args.status as never,
          });
        } else if (op === "update") {
          if (typeof args.fields !== "object" || args.fields === null || Array.isArray(args.fields)) {
            badArgs("manage_requirement(update) 的 fields 必须是对象（要改的字段，至少一个）", { got: args.fields });
          }
          updateRequirement(planner, { ...envelope, fields: args.fields as Record<string, unknown> });
        } else {
          setRequirementStatus(planner, {
            ...envelope,
            status: args.status as never,
            ...(strOrNull(args, "reason") === null ? {} : { reason: str(args, "reason") }),
          });
        }
      });
      const state = readRequirements(workDir).requirements[requirementId] ?? null;
      return jsonOk({ ok: true, op, receipts, requirement: state });
    } catch (e) {
      return failWith(e, `manage_requirement(${op})`);
    }
  },
};

// ── ② manage_change：变更批次的开启/改状态/关闭/采纳聊天记录/读回 ──

const CHANGE_OPS = ["open", "set_status", "close", "adopt_chat_change", "read"] as const;
type ChangeOp = (typeof CHANGE_OPS)[number];

const CHANGE_ENVELOPE_KEYS = ["op", "project_id", "role", "change_id", "actor_id"] as const;
const CHANGE_OP_ARG_KEYS: Record<ChangeOp, readonly string[]> = {
  open: [
    ...CHANGE_ENVELOPE_KEYS,
    "change_batch_id",
    "goal",
    "authorized_scope",
    "target_baseline",
    "affected_subsystems",
    "exit_criteria",
  ],
  set_status: [...CHANGE_ENVELOPE_KEYS, "change_batch_id", "status", "iteration", "reason"],
  close: [...CHANGE_ENVELOPE_KEYS, "change_batch_id", "reason"],
  adopt_chat_change: [...CHANGE_ENVELOPE_KEYS, "change_batch_id", "chat_record_id", "chat_record_sha256", "note"],
  read: ["op", "project_id", "change_batch_id"],
};

export const manageChangeTool: McpTool = {
  name: "manage_change",
  description:
    "变更批次命令入口（DESIGN.md §2.5/§2.6）：op=open（开启，五字段 + 目标基线只引用既有基线哈希；**省略 change_batch_id 时服务端自动生成 change-<日期>-<摘要> 稳定 id**，重试同一请求不会开第二个批次）/ " +
    "set_status（含进第 N 轮迭代）/ close（关闭依据必填）/ adopt_chat_change（按 id+内容哈希显式采纳 chat-changes.jsonl 记录，悬空/对不上都拒）/ read（读回投影）。" +
    "写操作经唯一写入服务转接提交；已关闭批次不能再改回（接着干请开新批次/新迭代）",
  inputSchema: {
    type: "object",
    properties: {
      op: { type: "string", enum: [...CHANGE_OPS], description: "open/set_status/close/adopt_chat_change/read" },
      project_id: { type: "string", description: "注册表里的项目 id" },
      role: { type: "string", description: "调用方角色（写操作必填）" },
      change_id: {
        type: "string",
        description: "事件信封的批次上下文（缺省 = 本批次 id：批次自己就是批次；上层另有批次上下文时按上层的填）",
      },
      actor_id: { type: "string", description: "执行者标识（缺省取 MCP 客户端名）" },
      change_batch_id: {
        type: "string",
        description: "变更批次稳定 id（change- 前缀）；op=open 省略则由服务端按请求内容自动生成，其余 op 必填；read 不给则返回全部",
      },
      goal: { type: "string", description: "op=open 必填：本次目标" },
      authorized_scope: { type: "string", description: "op=open 必填：授权范围" },
      target_baseline: {
        type: "object",
        description:
          "op=open 必填：目标基线引用 {design_revision, plan_revision（既有基线的 sha256 内容哈希）, baseline_id?}——只引用哈希，不复制基线内容",
        properties: {
          baseline_id: { type: "string" },
          design_revision: { type: "string" },
          plan_revision: { type: "string" },
        },
        required: ["design_revision", "plan_revision"],
        additionalProperties: false,
      },
      affected_subsystems: { type: "array", items: { type: "string" }, description: "op=open 必填：受影响子系统" },
      exit_criteria: { type: "string", description: "op=open 必填：出口条件" },
      status: { type: "string", enum: ["open", "iterating", "closed"], description: "op=set_status：进行中/迭代中/已关闭" },
      iteration: { type: "number", description: "op=set_status 可选：第几轮迭代（>=1 整数）" },
      reason: { type: "string", description: "op=close 必填关闭依据；op=set_status 可选理由" },
      chat_record_id: { type: "string", description: "op=adopt_chat_change 必填：chat-changes.jsonl 里那条记录的标识（chg-…）" },
      chat_record_sha256: { type: "string", description: "op=adopt_chat_change 必填：该记录的内容哈希（与盘上不一致即拒）" },
      note: { type: "string", description: "op=adopt_chat_change 可选备注" },
    },
    required: ["op", "project_id"],
    additionalProperties: false,
  },
  handler: async (args, ctx?: McpContext) => {
    const op = str(args, "op") as ChangeOp;
    if (!CHANGE_OPS.includes(op)) {
      return errorResult(`manage_change 的 op 只接受 ${CHANGE_OPS.join("/")}（收到 ${JSON.stringify(args.op)}）`);
    }
    try {
      assertToolArgs(args, CHANGE_OP_ARG_KEYS[op], `manage_change(${op})`);
      const dataDir = resolveDataDir();
      const projectId = str(args, "project_id");
      if (projectId === "") return errorResult("manage_change 缺入参 project_id");
      const workDir = workDirOf(projectId, dataDir);

      if (op === "read") {
        const projection = readChanges(workDir);
        const batchId = strOrNull(args, "change_batch_id");
        if (batchId === null) {
          return jsonOk({ ok: true, changes: projection.changes, last_seq: projection.last_seq });
        }
        return jsonOk({
          ok: true,
          change: projection.changes[batchId] ?? null,
          known_ids: Object.keys(projection.changes).sort(),
        });
      }

      const { role, actorId } = writeEnvelope(args, ctx, `manage_change(${op})`);
      // "给错了"（给了非字符串）不能悄悄当成"没给"——那会让调用方以为用了他给的 id（fail-closed）
      if (args.change_batch_id !== undefined && typeof args.change_batch_id !== "string") {
        return errorResult(
          `manage_change(${op}) 的 change_batch_id 必须是字符串（收到 ${JSON.stringify(args.change_batch_id)}）；只有 op=open 省略该键时才由服务端自动生成`,
        );
      }
      let batchId = str(args, "change_batch_id");
      // op=open 允许省略批次号（V07-04）：这里用服务端同一个算法先算出来，回执才能报"开的是哪个批次"。
      // 算出来的 id 会显式传给 openChange——同一请求重试恒得同一个 id ⇒ 同一个幂等键 ⇒ 原回执（不实开两个批次）。
      if (batchId === "" && op === "open") {
        batchId = autoChangeBatchId({
          project_id: projectId,
          goal: args.goal,
          authorized_scope: args.authorized_scope,
          target_baseline: args.target_baseline,
          affected_subsystems: args.affected_subsystems,
          exit_criteria: args.exit_criteria,
        });
      }
      if (batchId === "") return errorResult(`manage_change(${op}) 缺入参 change_batch_id`);
      const envelope = {
        project_id: projectId,
        change_batch_id: batchId,
        change_id: str(args, "change_id") || batchId,
        actor_id: actorId,
        role,
      };
      const receipts = await runPlanned(ctx, workDir, workstationDir(projectId, dataDir), `manage_change(${op})`, (planner) => {
        if (op === "open") {
          openChange(planner, {
            ...envelope,
            goal: args.goal as string,
            authorized_scope: args.authorized_scope as string,
            target_baseline: args.target_baseline as never,
            affected_subsystems: args.affected_subsystems as string[],
            exit_criteria: args.exit_criteria as string,
          });
        } else if (op === "set_status") {
          setChangeStatus(planner, {
            ...envelope,
            status: args.status as never,
            ...(numOrNull(args, "iteration") === null ? {} : { iteration: numOrNull(args, "iteration")! }),
            ...(strOrNull(args, "reason") === null ? {} : { reason: str(args, "reason") }),
          });
        } else if (op === "close") {
          closeChange(planner, { ...envelope, reason: args.reason as string });
        } else {
          adoptChatChange(planner, {
            ...envelope,
            chat_record_id: args.chat_record_id as string,
            chat_record_sha256: args.chat_record_sha256 as string,
            ...(strOrNull(args, "note") === null ? {} : { note: str(args, "note") }),
          });
        }
      });
      const state = readChanges(workDir).changes[batchId] ?? null;
      return jsonOk({ ok: true, op, change_batch_id: batchId, receipts, change: state });
    } catch (e) {
      return failWith(e, `manage_change(${op})`);
    }
  },
};

// ── ③ import_plan_definitions：受检导入施工定义并提交（task.definition_imported 的真实写口） ──

const IMPORT_ARG_KEYS = [
  "project_id",
  "role",
  "change_id",
  "actor_id",
  "requirement_ids",
  "bind_change_id",
  "expected_revisions",
] as const;

/** requirement_ids 入参的严格解析（这是引用面，必须 fail-closed：{任务id: [req-id,…]}，一个形态不对都拒） */
function readRequirementIdsArg(value: unknown): Record<string, string[]> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    badArgs("requirement_ids 必须是 {任务id: [需求id, …]} 的对象", { got: value });
  }
  const out: Record<string, string[]> = {};
  for (const [taskId, ids] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(ids) || ids.some((x) => typeof x !== "string" || x.trim() === "")) {
      badArgs(`requirement_ids[${JSON.stringify(taskId)}] 必须是非空字符串数组（需求稳定 id）`, { got: ids });
    }
    out[taskId] = (ids as string[]).map((x) => x.trim());
  }
  return out;
}

/** expected_revisions 入参的严格解析（{任务id: 当前实体版本 或 null}） */
function readExpectedRevisionsArg(value: unknown): Record<string, number | null> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    badArgs("expected_revisions 必须是 {任务id: 整数版本 或 null} 的对象", { got: value });
  }
  const out: Record<string, number | null> = {};
  for (const [taskId, rev] of Object.entries(value as Record<string, unknown>)) {
    if (rev !== null && (typeof rev !== "number" || !Number.isInteger(rev) || rev < 0)) {
      badArgs(`expected_revisions[${JSON.stringify(taskId)}] 必须是 >=0 的整数或 null（null = 期望该任务尚无事件）`, {
        got: rev,
      });
    }
    out[taskId] = rev as number | null;
  }
  return out;
}

export const importPlanDefinitionsTool: McpTool = {
  name: "import_plan_definitions",
  description:
    "受检导入项目登记的施工图并提交 task.definition_imported（真实写口）：先解析 → 按**已提交投影**校验需求/变更引用" +
    "（悬空点名拒、零写入；旧图纸全不带引用则一条都不查）→ 逐条提交（版本/幂等由唯一写入服务仲裁）→ 读回任务状态。" +
    "可带 requirement_ids（任务→需求 id 映射）与 bind_change_id（定义级批次绑定）；引用必须已登记，不凭调用方自报清单放行",
  inputSchema: {
    type: "object",
    properties: {
      project_id: { type: "string", description: "注册表里的项目 id" },
      role: { type: "string", description: "调用方角色" },
      change_id: { type: "string", description: `事件信封的变更批次（不挂批次填 ${NO_CHANGE_ID}）` },
      actor_id: { type: "string", description: "执行者标识（缺省取 MCP 客户端名）" },
      requirement_ids: {
        type: "object",
        description: "可选：{任务id: [需求 id, …]}——每个 id 必须能在需求投影里解析到，悬空即拒（DESIGN.md §2.7）",
      },
      bind_change_id: { type: "string", description: "可选：定义级绑定的变更批次 id（必须在批次投影里存在）" },
      expected_revisions: {
        type: "object",
        description: "可选：{任务id: 当前实体版本 或 null}——重导已有任务必须给当前版本，缺省按「期望新建」",
      },
    },
    required: ["project_id", "role", "change_id"],
    additionalProperties: false,
  },
  handler: async (args, ctx?: McpContext) => {
    try {
      assertToolArgs(args, IMPORT_ARG_KEYS, "import_plan_definitions");
      const { projectId, role, actorId } = writeEnvelope(args, ctx, "import_plan_definitions");
      const changeId = str(args, "change_id");
      if (changeId === "") return errorResult(`import_plan_definitions 缺入参 change_id（不挂批次填 ${NO_CHANGE_ID}）`);
      const dataDir = resolveDataDir();
      const workDir = workDirOf(projectId, dataDir);
      const requirementIds = readRequirementIdsArg(args.requirement_ids);
      const expectedRevisions = readExpectedRevisionsArg(args.expected_revisions);
      const bindChangeId = strOrNull(args, "bind_change_id");

      const loaded = loadDocument(projectId, "plan", dataDir);
      if (loaded === null) {
        throw new WorkError(
          "INVALID_COMMAND",
          `项目 ${projectId} 还没有登记的施工图（plan 源不存在）——先登记施工图再导入定义；缺图纸是正常空态，不拿空定义冒充`,
          { project_id: projectId },
        );
      }
      // 受检导入（与 GET /api/projects/:id/plan 同一入口、同一份引用判据）：悬空引用在这里就点名拒
      const imported = importPlanChecked(loaded.text, workDir, {
        plan_revision: loaded.revision.content_sha256,
        ...(bindChangeId === null ? {} : { change_id: bindChangeId }),
        ...(requirementIds === undefined ? {} : { requirement_ids: requirementIds }),
      });
      const receipts = await runPlanned(ctx, workDir, workstationDir(projectId, dataDir), "import_plan_definitions", (planner) => {
        submitDefinitionImports(planner, {
          project_id: projectId,
          change_id: changeId,
          actor_id: actorId,
          role,
          definitions: imported.definitions,
          ...(expectedRevisions === undefined ? {} : { expected_revisions: expectedRevisions }),
        });
      });
      const states = readTaskStates(workDir).states;
      return jsonOk({
        ok: true,
        plan_revision: loaded.revision.content_sha256,
        imported: imported.definitions.map((d, i) => ({
          task_id: d.task_id,
          definition_sha256: receipts[i] === undefined ? null : states[d.task_id]?.definition_sha256 ?? null,
          requirement_ids: d.requirement_ids,
          change_id: d.change_id,
          receipt: receipts[i] ?? null,
        })),
        states: Object.fromEntries(
          Object.values(states).map((s) => [
            s.task_id,
            { status: s.status, definition_sha256: s.definition_sha256, plan_revision: s.plan_revision, revision: s.revision },
          ]),
        ),
      });
    } catch (e) {
      return failWith(e, "import_plan_definitions");
    }
  },
};

/** 本卡新增的三个工具（index.ts 按此顺序登记；read 是纯读，其余经 ctx.work 转接唯一写入服务） */
export const workObjectTools: readonly McpTool[] = [manageRequirementTool, manageChangeTool, importPlanDefinitionsTool];
