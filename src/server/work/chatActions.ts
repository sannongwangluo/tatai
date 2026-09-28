// V06-07：聊天修订动作与可追溯回执（PLAN.md V06-07，DESIGN.md §3.5 / §3.6 / §3.12 / §9.2–§9.4）。
//
// 本模块把"聊出来的方向"变成**可查的动作记录**，并守住三条红线：
//
// ① **动作落盘可查**（§3.6）：每次动作落一行 `<项目根>/.工作台/work/chat-actions.jsonl`（追加式快照，
//    最后一次快照即现状）。重新打开会话/重开进程后仍能核实"做过什么、影响了哪些对象、失败原因是什么"。
// ② **`applied` 只能由真实写入回执产生**：`save()` 在任何一次落盘前校验——状态是 `applied` 时，
//    `tool_receipts` 里必须至少有一条 `ok && write` 的回执。模型说"我做完了"不产生 applied。
// ③ **冪等写入**：同一（项目 + 会话 + 动作类型 + 触发原文 + 选中对象 + 现行版本）只产生一次效果；
//    重复发送命中既有动作直接返回，不产生第二次效果（§3.6「写动作使用幂等键」）。
//
// 与既有"落稿笔"的关系（本卡最易踩混的一条）：
//   `workstation.appendDesign`（聊天总结追加到 design.md / 塔台附录 B 之前）**原样保留、语义不变**，
//   它是"确认后追加"的笔；本模块走的是**按章节/任务定位的修订链路**
//   （提案 → review_needed → 审定 → 走 V06-02 `documents.activateBaseline` 激活基线）。
//   两条路各有入口，都可用；本模块不调用 appendDesign，也不改它的行为。
//
// 只读边界：本模块除"讨论草稿/方案件/变更记录"三类**派生件**（`.工作台/work/` 下）与"审定激活"
//   这一次显式写（由人触发）之外，不写任何图纸；讨论/定位反馈一律不碰 gate.jsonl、progress.json、
//   tasks.json——"一次不满"不会把整个项目判成失败（§3.6）。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  readBlueprint,
  readBlueprintReceipt,
  type Blueprint,
  type BlueprintRebuildResult,
  // 只作类型用（`BlueprintRebuildFn` 的入参口径取自它）：不把它当缺省入口——缺省入口是自动链
  type rebuildBlueprint,
} from "../../arch/blueprint";
import { autoRebuildBlueprint, type AutoRebuildResult } from "../../arch/blueprintAuto";
import { chatStructuredJson, type FlashMessage } from "../flash";
import { appendJsonlLine } from "../lineStream";
import { sanitizeErrorMessage } from "../redact";
import { getProject } from "../registry";
import { nowIso, compareIsoTime } from "../time";
import {
  activateBaseline,
  activeBaseline,
  buildSectionIndex,
  diffSections,
  loadDocuments,
  projectWorkbenchDir,
  resolveDocumentSource,
  sha256Hex,
  type BaselineApprovalKind,
  type DocumentDiff,
  type DocumentKind,
} from "./documents";
import { diffTaskDefinitions, importTaskDefinitions, type TaskRevisionChange } from "./plan";
import {
  definitionHashOf,
  parsePlanTable,
  validatePlanTasks,
  type PlanTable,
  type PlanTask,
} from "./planValidate";
import { WorkError, type WorkErrorCode } from "./types";

// ───────────────────────────────── 类型 ─────────────────────────────────

export type ChatActionKind = "discussion" | "proposal" | "blueprint_update" | "locate_feedback";

export const CHAT_ACTION_KINDS: readonly ChatActionKind[] = [
  "discussion",
  "proposal",
  "blueprint_update",
  "locate_feedback",
];

/** 六阶段（DESIGN.md §3.6 的六句话，一一对应） */
export type ChatActionStatus =
  | "reading"
  | "drafting"
  | "saved"
  | "review_needed"
  | "applied"
  | "failed";

export const CHAT_ACTION_STATUSES: readonly ChatActionStatus[] = [
  "reading",
  "drafting",
  "saved",
  "review_needed",
  "applied",
  "failed",
];

/**
 * 六阶段的**默认文案**（逐字取 DESIGN.md §3.6：「正在读取/整理中/已保存草稿/待审定/图已更新/失败」）。
 * `applied` 的文案由真实回执决定（图派生 →「图已更新」；基线激活 →「基线已激活」），
 * 前端不猜——见 `actionStatusLabel()`。
 */
export const CHAT_ACTION_STATUS_LABELS: Readonly<Record<ChatActionStatus, string>> = {
  reading: "正在读取",
  drafting: "整理中",
  saved: "已保存草稿",
  review_needed: "待审定",
  applied: "图已更新",
  failed: "失败",
};

export const CHAT_ACTION_KIND_LABELS: Readonly<Record<ChatActionKind, string>> = {
  discussion: "讨论",
  proposal: "整理方案",
  blueprint_update: "更新图",
  locate_feedback: "定位反馈",
};

/** 用户当前的选中对象（定位反馈必须携带，§3.6「携带当前选中能力/任务与项目」） */
export interface ChatSelection {
  kind: "capability" | "module" | "task" | "concept";
  id: string;
  name?: string | null;
}

/** 读到的现行图纸版本（动作的输入版本，正式修订/整理方案必须有） */
export interface ActionDocRef {
  kind: DocumentKind;
  /** 项目根内相对路径（对外只用它） */
  source_path: string;
  content_sha256: string;
  definition_sha256: string;
  bytes: number;
  lines: number;
}

export interface ActionSourceVersions {
  design: ActionDocRef | null;
  plan: ActionDocRef | null;
  /** 现行生效基线（没有 = null，不假装有） */
  baseline_id: string | null;
  /** 基线流水读失败时的如实说明（读不到 ≠ 没有基线） */
  baseline_error: string | null;
  read_at: string;
}

/** 一次工具动作及其结果（"工具动作与结果关联持久化"，§3.6） */
export interface ActionToolReceipt {
  tool: string;
  ok: boolean;
  /** true = 这一步**真实写了盘**（`applied` 的成立条件） */
  write: boolean;
  summary: string;
  affected_ids: string[];
  at: string;
  detail?: unknown;
}

export interface ActionResultRef {
  kind: "discussion_draft" | "proposal" | "blueprint" | "baseline" | "change" | "issue";
  /** 项目根内相对路径 */
  path: string | null;
  sha256: string | null;
  detail: string | null;
  extra?: Record<string, unknown>;
}

export interface ActionError {
  code: string;
  message: string;
  /** 失败落在哪一阶段（续接从这里的输入重跑） */
  stage: ChatActionStatus;
  /** true = 可重跑（输入还在，重试不产生半成品） */
  recoverable: boolean;
}

export interface ChatActionStage {
  status: ChatActionStatus;
  at: string;
  detail: string;
  /** 该阶段完成时的回执下标（reading/drafting 阶段可能没有） */
  receipt_index: number | null;
}

export interface ChatAction {
  action_id: string;
  project_id: string;
  /** 触发动作的会话（会话被删时可能已归档，引用仍在） */
  session_id: string | null;
  kind: ChatActionKind;
  status: ChatActionStatus;
  /** 用户原话（自然表达） */
  trigger: string;
  idempotency_key: string;
  /** 认成这个动作的依据（规则名 + 命中串），可复核 */
  intent: { matched: string; rule: string };
  /** 定位反馈携带的选中对象 */
  selection: ChatSelection | null;
  source_versions: ActionSourceVersions;
  stages: ChatActionStage[];
  tool_receipts: ActionToolReceipt[];
  affected_ids: string[];
  result_ref: ActionResultRef | null;
  error: ActionError | null;
  /** 会话被删但有有效引用 → 转归档留引用（§3.6） */
  archived: boolean;
  archive: { reason: string; at: string; session_archive_path: string | null } | null;
  created_at: string;
  updated_at: string;
  /** 快照版本号（每次落盘 +1；重开进程后按最大值取现状） */
  rev: number;
}

/** 状态文案：`applied` 由真实回执决定，前端不猜 */
export function actionStatusLabel(action: ChatAction): string {
  if (action.status !== "applied") return CHAT_ACTION_STATUS_LABELS[action.status];
  const last = [...action.tool_receipts].reverse().find((r) => r.ok && r.write);
  if (last === undefined) return CHAT_ACTION_STATUS_LABELS.applied;
  if (last.tool === "baseline_activate") return "基线已激活";
  if (last.tool === "blueprint") return "图已更新";
  return CHAT_ACTION_STATUS_LABELS.applied;
}

/** 动作卡片视图（HTTP/SSE/前端共用同一份映射：文案来自回执，前端不推断状态） */
export interface ChatActionView {
  action_id: string;
  kind: ChatActionKind;
  kind_label: string;
  status: ChatActionStatus;
  /** 该状态的人话文案（`applied` 由真实回执决定：图已更新 / 基线已激活） */
  label: string;
  trigger: string;
  affected_ids: string[];
  result_ref: ActionResultRef | null;
  error: ActionError | null;
  tool_receipts: { tool: string; ok: boolean; write: boolean; summary: string }[];
  archived: boolean;
  updated_at: string;
}

export function chatActionViewOf(action: ChatAction): ChatActionView {
  return {
    action_id: action.action_id,
    kind: action.kind,
    kind_label: CHAT_ACTION_KIND_LABELS[action.kind],
    status: action.status,
    label: actionStatusLabel(action),
    trigger: action.trigger,
    affected_ids: action.affected_ids,
    result_ref: action.result_ref,
    error: action.error,
    tool_receipts: action.tool_receipts.map((r) => ({
      tool: r.tool,
      ok: r.ok,
      write: r.write,
      summary: r.summary,
    })),
    archived: action.archived,
    updated_at: action.updated_at,
  };
}

// ───────────────────────────────── 路径 ─────────────────────────────────

const WORK_SUBDIR = "work";
export const CHAT_ACTIONS_FILE = "chat-actions.jsonl";
export const CHAT_DRAFTS_DIR = "chat-drafts";
export const CHAT_PROPOSALS_DIR = "chat-proposals";
export const CHAT_CHANGES_FILE = "chat-changes.jsonl";

/** `<项目根>/.工作台/work/`（与 V06-04 的检查点同目录；路径只从注册表取） */
export function chatActionWorkDir(projectId: string, dataDir?: string): string {
  return path.join(projectWorkbenchDir(projectId, dataDir), WORK_SUBDIR);
}

export const chatActionsPath = (projectId: string, dataDir?: string): string =>
  path.join(chatActionWorkDir(projectId, dataDir), CHAT_ACTIONS_FILE);

/** 对外只用项目根内相对路径（与 documents.ts 同一口径，不外发本机绝对路径） */
function relToRoot(projectId: string, abs: string, dataDir?: string): string {
  const root = resolveDocumentSource(projectId, "design", dataDir).project_root;
  return path.relative(root, abs).split(path.sep).join("/");
}

function absFromRel(projectId: string, rel: string, dataDir?: string): string {
  const root = resolveDocumentSource(projectId, "design", dataDir).project_root;
  return path.join(root, rel.split("/").join(path.sep));
}

export function chatDraftPath(projectId: string, actionId: string, dataDir?: string): string {
  return path.join(chatActionWorkDir(projectId, dataDir), CHAT_DRAFTS_DIR, `${actionId}.md`);
}

export function chatProposalDir(projectId: string, actionId: string, dataDir?: string): string {
  return path.join(chatActionWorkDir(projectId, dataDir), CHAT_PROPOSALS_DIR, actionId);
}

// ───────────────────────────────── 小工具 ─────────────────────────────────

/** 原子写文本：先写临时文件再 rename，写完读盘复核（吞行/写坏一律报错，不假装成功） */
function writeTextAtomic(file: string, text: string, expectBefore?: string | null): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (expectBefore !== null && expectBefore !== undefined) {
    const cur = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
    if (cur !== expectBefore) {
      throw new WorkError(
        "VERSION_CONFLICT",
        `写入前磁盘内容已变（${path.basename(file)}）：读到的与手上的不是同一份，拒绝覆盖（重读后再来）`,
        { reason: "source_changed_before_write" },
      );
    }
  }
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, file);
  const onDisk = fs.readFileSync(file, "utf8");
  if (onDisk !== text) {
    throw new WorkError("INVALID_COMMAND", `写入后复核不一致（${path.basename(file)}，疑似吞行）`, {
      reason: "write_back_mismatch",
    });
  }
}

const countLines = (t: string): number => (t === "" ? 0 : t.replace(/\n+$/, "").split("\n").length);

function newActionId(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `act-${stamp}-${crypto.randomBytes(4).toString("hex")}`;
}

/** 触发原文归一化（幂等键用；首尾空白与连续空白不影响"是不是同一句"） */
const normalizeTrigger = (t: string): string => t.replace(/\s+/g, " ").trim();

/**
 * 幂等键：同项目 + 同会话 + 同动作类型 + 同触发原文 + 同选中对象 + **同现行版本**。
 * 现行版本进键是刻意的：图纸变了就是另一件事，重跑不是"第二次效果"。
 */
export function chatActionIdempotencyKey(input: {
  projectId: string;
  sessionId: string | null;
  kind: ChatActionKind;
  text: string;
  selection?: ChatSelection | null;
  versions: ActionSourceVersions;
}): string {
  const digestOf = (r: ActionDocRef | null): string =>
    r === null ? "none" : `${r.source_path}@${r.content_sha256}`;
  return sha256Hex(
    [
      "chat-action-v1",
      input.projectId,
      input.sessionId ?? "-",
      input.kind,
      normalizeTrigger(input.text),
      input.selection === null || input.selection === undefined ? "-" : `${input.selection.kind}:${input.selection.id}`,
      digestOf(input.versions.design),
      digestOf(input.versions.plan),
      input.versions.baseline_id ?? "-",
    ].join("\u0000"),
  );
}

// ───────────────────────────────── 自然表达 → 动作 ─────────────────────────────────

export interface IntentMatch {
  kind: ChatActionKind;
  /** 命中的规则名（可复核"为什么认成这个动作"） */
  rule: string;
  /** 命中的原文片段 */
  matched: string;
}

/**
 * 从用户自然表达里认出动作（§3.6 的四行动作表）。
 * 只做**确定性关键词**判定（零模型、零网络）：认不出来就返回 null——聊天照常，不硬塞动作。
 * 规则顺序即优先级：更新图 > 整理方案 > 定位反馈 > 讨论。
 */
const INTENT_RULES: readonly { kind: ChatActionKind; rule: string; re: RegExp }[] = [
  {
    kind: "blueprint_update",
    rule: "按定版图纸画图/更新图",
    re: /(按定版图纸|按有效图纸|按基线图纸|更新图|刷新图|重画图|重建图|重新生成图|把图更新|图更新一下|更新一下图)/,
  },
  {
    kind: "proposal",
    rule: "整理成方案/交设计审定/正式修订",
    re: /(整理成方案|整理方案|整理成设计|形成方案|出个方案|出方案|交给设计|交设计|设计审定|正式修订|修订设计|改设计书|提出章节差异|章节差异|交给\s*GPT)/i,
  },
  {
    kind: "locate_feedback",
    rule: "这里不对/我想改这里（携带选中能力或任务）",
    re: /(这里不对|这里不合适|这里有问题|此处不对|我想改这里|想改这里|这一节不对|这个任务不对|这里要改|这里得改|这里改成|这里要改成|这里需要改)/,
  },
  {
    kind: "discussion",
    rule: "我想做……/先讨论",
    re: /(我想做|我想加|我想改|想做一|准备做|打算做|计划做|讨论一下|聊一下|聊聊|商量一下|我的想法是|目标应该)/,
  },
];

export function classifyChatIntent(
  text: string,
  opts: { hasSelection?: boolean } = {},
): IntentMatch | null {
  if (typeof text !== "string" || text.trim() === "") return null;
  for (const r of INTENT_RULES) {
    const m = r.re.exec(text);
    if (m === null) continue;
    // 定位反馈若无选中对象也照样认（记录里明说"未携带选中对象"），不因缺选中就吞掉用户的意见
    void opts.hasSelection;
    return { kind: r.kind, rule: r.rule, matched: m[1] };
  }
  return null;
}

// ───────────────────────────────── 落盘与读回 ─────────────────────────────────

/**
 * 落盘前校验（红线②）：`applied` 必须由**真实写入成功的回执**产生。
 * 没有 ok+write 的回执却标 applied → 拒绝落盘（不伪造回执、不提前 applied）。
 */
export function assertAppliedHasWriteReceipt(action: ChatAction): void {
  if (action.status !== "applied") return;
  const ok = action.tool_receipts.some((r) => r.ok && r.write);
  if (!ok) {
    throw new WorkError(
      "INVALID_COMMAND",
      `动作 ${action.action_id} 标了 applied 却没有"真实写入成功"的回执——applied 只能由真实回执产生` +
        "（模型说做完了不算，DESIGN.md §3.6）",
      { action_id: action.action_id, reason: "applied_without_write_receipt" },
    );
  }
}

function validateSnapshot(raw: unknown, line: number): ChatAction {
  const bad = (why: string): never => {
    throw new WorkError("INVALID_COMMAND", `chat-actions.jsonl 第 ${line} 行不合法：${why}`, {
      line,
      reason: "chat_action_line_corrupt",
    });
  };
  if (typeof raw !== "object" || raw === null) return bad("不是 JSON 对象");
  const r = raw as Record<string, unknown>;
  const str = (k: string): string => {
    const v = r[k];
    if (typeof v !== "string" || v === "") return bad(`缺字段或类型不对: ${k}`);
    return v;
  };
  if (!CHAT_ACTION_KINDS.includes(r.kind as ChatActionKind)) return bad(`kind 非法: ${String(r.kind)}`);
  if (!CHAT_ACTION_STATUSES.includes(r.status as ChatActionStatus)) {
    return bad(`status 非法: ${String(r.status)}`);
  }
  if (!Array.isArray(r.tool_receipts)) return bad("tool_receipts 不是数组");
  const action: ChatAction = {
    action_id: str("action_id"),
    project_id: str("project_id"),
    session_id: typeof r.session_id === "string" ? r.session_id : null,
    kind: r.kind as ChatActionKind,
    status: r.status as ChatActionStatus,
    trigger: typeof r.trigger === "string" ? r.trigger : "",
    idempotency_key: typeof r.idempotency_key === "string" ? r.idempotency_key : "",
    intent: (r.intent ?? { matched: "", rule: "" }) as ChatAction["intent"],
    selection: (r.selection ?? null) as ChatSelection | null,
    source_versions: (r.source_versions ?? {
      design: null,
      plan: null,
      baseline_id: null,
      baseline_error: null,
      read_at: "",
    }) as ActionSourceVersions,
    stages: Array.isArray(r.stages) ? (r.stages as ChatActionStage[]) : [],
    tool_receipts: r.tool_receipts as ActionToolReceipt[],
    affected_ids: Array.isArray(r.affected_ids) ? (r.affected_ids as string[]) : [],
    result_ref: (r.result_ref ?? null) as ActionResultRef | null,
    error: (r.error ?? null) as ActionError | null,
    archived: r.archived === true,
    archive: (r.archive ?? null) as ChatAction["archive"],
    created_at: str("created_at"),
    updated_at: str("updated_at"),
    rev: typeof r.rev === "number" ? r.rev : 1,
  };
  assertAppliedHasWriteReceipt(action); // 读回也校验：坏行不会因为"读出来好看"被当真
  return action;
}

export interface ChatActionLog {
  actions: ChatAction[];
  /** 坏行（只读路径如实报出，不跳过、不当没看见） */
  corrupt: { line: number; reason: string }[];
}

function readChatActionLog(projectId: string, dataDir?: string): ChatActionLog {
  const file = chatActionsPath(projectId, dataDir);
  if (!fs.existsSync(file)) return { actions: [], corrupt: [] };
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  const byId = new Map<string, ChatAction>();
  const corrupt: { line: number; reason: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i].trim();
    if (text === "") continue;
    try {
      const action = validateSnapshot(JSON.parse(text), i + 1);
      const prev = byId.get(action.action_id);
      if (prev === undefined || prev.rev <= action.rev) byId.set(action.action_id, action); // 最后快照即现状
    } catch (e) {
      corrupt.push({ line: i + 1, reason: (e as Error).message });
    }
  }
  return { actions: [...byId.values()], corrupt };
}

/** 读动作日志（含坏行如实报出） */
export function readChatActions(projectId: string, dataDir?: string): ChatActionLog {
  return readChatActionLog(projectId, dataDir);
}

/** 列动作（按创建时间倒序；归档过的默认也列出——它们仍是被保留的引用） */
export function listChatActions(
  projectId: string,
  opts: { sessionId?: string | null; includeArchived?: boolean } = {},
  dataDir?: string,
): ChatAction[] {
  const all = readChatActionLog(projectId, dataDir).actions;
  const filtered = all.filter((a) => {
    if (opts.sessionId !== undefined && opts.sessionId !== null && a.session_id !== opts.sessionId) return false;
    if (opts.includeArchived === false && a.archived) return false;
    return true;
  });
  return filtered.sort(
    (a, b) => compareIsoTime(b.created_at, a.created_at) || b.action_id.localeCompare(a.action_id),
  );
}

export function getChatAction(projectId: string, actionId: string, dataDir?: string): ChatAction | null {
  const log = readChatActionLog(projectId, dataDir);
  return log.actions.find((a) => a.action_id === actionId) ?? null;
}

/** 落一次快照（rev+1；applied 红线在这里守） */
function save(projectId: string, action: ChatAction, at: string, dataDir?: string): ChatAction {
  // 错误消息过一层消息级脱敏（F5 口径）：动作回执会进 HTTP 响应与聊天背景，
  // 不能把本机绝对路径递出去（ENOENT/EEXIST 一类消息里常夹盘符路径）。
  const next: ChatAction = {
    ...action,
    ...(action.error === null
      ? {}
      : { error: { ...action.error, message: sanitizeErrorMessage(action.error.message) } }),
    rev: action.rev + 1,
    updated_at: at,
  };
  assertAppliedHasWriteReceipt(next);
  const file = chatActionsPath(projectId, dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  appendJsonlLine(file, JSON.stringify(next));
  return next;
}

/** 追加一条动作事件到既有动作（工具动作与结果关联持久化用；不改状态） */
export function appendChatActionReceipt(
  projectId: string,
  actionId: string,
  receipt: Omit<ActionToolReceipt, "at"> & { at?: string },
  dataDir?: string,
): ChatAction {
  const action = getChatAction(projectId, actionId, dataDir);
  if (action === null) {
    throw new WorkError("INVALID_COMMAND", `动作不存在: ${actionId}`, { action_id: actionId });
  }
  const full: ActionToolReceipt = {
    tool: receipt.tool,
    ok: receipt.ok,
    write: receipt.write,
    summary: receipt.summary,
    affected_ids: receipt.affected_ids,
    at: receipt.at ?? nowIso(),
    ...(receipt.detail !== undefined ? { detail: receipt.detail } : {}),
  };
  return save(
    projectId,
    {
      ...action,
      tool_receipts: [...action.tool_receipts, full],
      affected_ids: [...new Set([...action.affected_ids, ...full.affected_ids])],
    },
    full.at,
    dataDir,
  );
}

// ───────────────────────────────── 读现行版本 ─────────────────────────────────

export function readActionSourceVersions(projectId: string, dataDir?: string, at?: string): ActionSourceVersions {
  const docs = loadDocuments(projectId, dataDir);
  const refOf = (kind: DocumentKind): ActionDocRef | null => {
    const d = docs[kind];
    if (d === null) return null;
    return {
      kind,
      source_path: d.source.rel_path,
      content_sha256: d.revision.content_sha256,
      definition_sha256: d.revision.definition_sha256,
      bytes: d.revision.bytes,
      lines: d.revision.lines,
    };
  };
  let baselineId: string | null = null;
  let baselineError: string | null = null;
  try {
    baselineId = activeBaseline(projectId, dataDir)?.baseline_id ?? null;
  } catch (e) {
    baselineError = (e as Error).message;
  }
  return {
    design: refOf("design"),
    plan: refOf("plan"),
    baseline_id: baselineId,
    baseline_error: baselineError,
    read_at: at ?? nowIso(),
  };
}

// ───────────────────────────────── 模型接口 ─────────────────────────────────

export type ChatActionChatFn = (
  messages: FlashMessage[],
) => Promise<{ text: string; json: unknown | null; error: string | null }>;

export const defaultChatActionChat: ChatActionChatFn = async (messages) => chatStructuredJson(messages);

type BlueprintRebuildFn = (
  projectId: string,
  opts: Parameters<typeof rebuildBlueprint>[1],
) => Promise<BlueprintRebuildResult>;

export interface ChatActionDeps {
  dataDir?: string;
  /** 方案整理的模型入口（缺省 = flash 结构化口；验证脚本注入确定性夹具） */
  chat?: ChatActionChatFn;
  /** 图派生入口（缺省 = V06-05 的 rebuildBlueprint；夹具注入它即走"只做确定性派生"的老口径） */
  rebuild?: BlueprintRebuildFn;
  /** 自动链入口（缺省 = 补修包 E 的 autoRebuildBlueprint：确定性派生 + 自动语义整理检查） */
  auto?: (projectId: string, opts: Parameters<typeof autoRebuildBlueprint>[1]) => Promise<AutoRebuildResult>;
  now?: () => string;
}

// ───────────────────────────────── 动作执行 ─────────────────────────────────

export interface RunChatActionInput {
  projectId: string;
  sessionId: string | null;
  /** 用户原话 */
  text: string;
  /** 当前选中对象（定位反馈携带） */
  selection?: ChatSelection | null;
  /** 已判定的意图（缺省现判；判不出来抛 INVALID_COMMAND） */
  intent?: IntentMatch;
}

export interface RunChatActionResult {
  action: ChatAction;
  /** true = 命中幂等键，返回既有动作（没有产生第二次效果） */
  deduplicated: boolean;
}

function requireProject(projectId: string, dataDir?: string): void {
  if (!getProject(projectId, dataDir)) {
    throw new WorkError("INVALID_COMMAND", `项目不存在: ${projectId}`, { project_id: projectId });
  }
}

function failed(
  action: ChatAction,
  stage: ChatActionStatus,
  code: WorkErrorCode | string,
  message: string,
  recoverable: boolean,
  at: string,
  dataDir?: string,
): ChatAction {
  const killed: ChatAction = {
    ...action,
    status: "failed",
    error: { code, message, stage, recoverable },
    stages: [...action.stages, { status: "failed", at, detail: message, receipt_index: null }],
  };
  return save(action.project_id, killed, at, dataDir);
}

/**
 * 跑一次动作（DESIGN.md §3.6 的四行动作表）。
 * 任何一步失败都落成 `failed` 动作（带阶段、原因、是否可续接），**不抛给聊天**——
 * 聊天本身绝不因为动作失败而挂掉；调用方按需读回执。
 */
export async function runChatAction(
  input: RunChatActionInput,
  deps: ChatActionDeps = {},
): Promise<RunChatActionResult> {
  const dataDir = deps.dataDir;
  const now = deps.now ?? nowIso;
  const projectId = input.projectId;
  requireProject(projectId, dataDir);
  const intent = input.intent ?? classifyChatIntent(input.text, { hasSelection: input.selection != null });
  if (intent === null) {
    throw new WorkError(
      "INVALID_COMMAND",
      "这句话没有可执行的动作（讨论/整理方案/更新图/定位反馈四类之外照常聊天，不产生动作记录）",
      { project_id: projectId },
    );
  }
  const at0 = now();
  const versions = readActionSourceVersions(projectId, dataDir, at0);
  const key = chatActionIdempotencyKey({
    projectId,
    sessionId: input.sessionId,
    kind: intent.kind,
    text: input.text,
    selection: input.selection ?? null,
    versions,
  });
  const existing = readChatActionLog(projectId, dataDir).actions.find((a) => a.idempotency_key === key);
  if (existing !== undefined && existing.status !== "failed") {
    // 幂等命中：重复发送不产生第二次效果（仍返回同一动作，前端显示同一份回执）
    return { action: existing, deduplicated: true };
  }

  const base: ChatAction = existing ?? {
    action_id: newActionId(),
    project_id: projectId,
    session_id: input.sessionId,
    kind: intent.kind,
    status: "reading",
    trigger: input.text,
    idempotency_key: key,
    intent: { matched: intent.matched, rule: intent.rule },
    selection: input.selection ?? null,
    source_versions: versions,
    stages: [],
    tool_receipts: [],
    affected_ids: [],
    result_ref: null,
    error: null,
    archived: false,
    archive: null,
    created_at: at0,
    updated_at: at0,
    rev: 0,
  };

  // ① reading：现行两份材料**先读再动**（正式修订/整理方案的必要前置，§3.5）
  const readReceipt: ActionToolReceipt = {
    tool: "read_documents",
    ok: true,
    write: false,
    summary:
      `读到设计 ${versions.design === null ? "（无）" : `${versions.design.source_path} @ ${versions.design.content_sha256.slice(0, 8)}`}` +
      `、施工 ${versions.plan === null ? "（无）" : `${versions.plan.source_path} @ ${versions.plan.definition_sha256.slice(0, 8)}`}` +
      `、生效基线 ${versions.baseline_id ?? "（无）"}`,
    affected_ids: [],
    at: at0,
    detail: {
      design: versions.design,
      plan: versions.plan,
      baseline_id: versions.baseline_id,
      baseline_error: versions.baseline_error,
    },
  };
  let action: ChatAction = save(
    projectId,
    {
      ...base,
      status: "reading",
      source_versions: versions,
      error: null,
      stages: [...base.stages, { status: "reading", at: at0, detail: readReceipt.summary, receipt_index: 0 }],
      tool_receipts: [...base.tool_receipts.filter((r) => r.tool !== "read_documents"), readReceipt],
    },
    at0,
    dataDir,
  );

  try {
    switch (intent.kind) {
      case "discussion":
        action = runDiscussion(projectId, action, now, dataDir);
        break;
      case "locate_feedback":
        action = runLocateFeedback(projectId, action, now, dataDir);
        break;
      case "blueprint_update":
        action = await runBlueprintUpdate(projectId, action, deps, now);
        break;
      case "proposal":
        action = await runProposal(projectId, action, deps, now);
        break;
    }
  } catch (e) {
    const err = e as Error;
    const code = e instanceof WorkError ? e.code : "ACTION_FAILED";
    action = failed(action, "drafting", code, err.message, true, now(), dataDir);
  }
  return { action, deduplicated: false };
}

/** 讨论：存草稿、标出推断，**不激活任何基线**（§3.5「日常讨论保存为草稿」） */
function runDiscussion(
  projectId: string,
  action: ChatAction,
  now: () => string,
  dataDir?: string,
): ChatAction {
  const at = now();
  const draft = [
    `# 讨论草稿：${action.action_id}`,
    "",
    "> 本文件是**讨论草稿**（DESIGN.md §3.5）：只记录方向与推断，**不激活任何基线**，",
    "> 也不改动设计书 / 施工图 / Gate。要正式修订请走「整理成方案 → 交设计审定」。",
    "",
    "## 用户原话",
    "",
    action.trigger.trim(),
    "",
    "## 据原话整理出的目标",
    "",
    `- ${action.trigger.replace(/\s+/g, " ").trim()}`,
    "",
    "## 待确认的边界与场景（未确认 = 推断）",
    "",
    "- 【推断】涉及范围与验收场景尚未在讨论中明确，需用户/设计角色确认后才进入正式修订。",
    "",
    "## 关键疑问",
    "",
    ...extractQuestions(action.trigger),
    "",
    "## 关联",
    "",
    `- 会话：${action.session_id ?? "（无）"}`,
    `- 现行设计：${action.source_versions.design?.source_path ?? "（无）"} @ ${action.source_versions.design?.content_sha256.slice(0, 12) ?? "-"}`,
    `- 现行施工：${action.source_versions.plan?.source_path ?? "（无）"} @ ${action.source_versions.plan?.definition_sha256.slice(0, 12) ?? "-"}`,
    `- 生效基线：${action.source_versions.baseline_id ?? "（无）"}`,
    "",
  ].join("\n");
  const file = chatDraftPath(projectId, action.action_id, dataDir);
  writeTextAtomic(file, draft);
  const sha = sha256Hex(draft);
  const rel = relToRoot(projectId, file, dataDir);
  const receipt: ActionToolReceipt = {
    tool: "write_draft",
    ok: true,
    write: true,
    summary: `讨论草稿已保存（${rel}，${countLines(draft)} 行）——未激活任何基线`,
    affected_ids: [rel],
    at,
    detail: { sha256: sha, kind: "discussion_draft" },
  };
  return save(
    projectId,
    {
      ...action,
      status: "saved",
      tool_receipts: [...action.tool_receipts, receipt],
      affected_ids: [rel],
      result_ref: { kind: "discussion_draft", path: rel, sha256: sha, detail: "讨论草稿（未激活）" },
      stages: [...action.stages, { status: "saved", at, detail: receipt.summary, receipt_index: action.tool_receipts.length }],
    },
    at,
    dataDir,
  );
}

function extractQuestions(text: string): string[] {
  const parts = text.split(/[？?]/).map((s) => s.trim()).filter((s) => s !== "");
  const qs = parts.length > 1 ? parts.slice(0, -1).map((s) => s.split(/[。；;\n]/).pop() ?? s) : [];
  const out = qs.filter((s) => s !== "").slice(0, 5).map((s) => `- ${s}？`);
  return out.length > 0 ? out : ["- （讨论中没有明确疑问，等设计与施工差异出来后再确认）"];
}

/** 定位反馈：携带选中能力/任务，形成变更或问题——不把一次不满判成整个项目失败 */
function runLocateFeedback(
  projectId: string,
  action: ChatAction,
  now: () => string,
  dataDir?: string,
): ChatAction {
  const at = now();
  const sel = action.selection;
  const record = {
    change_id: `chg-${action.action_id.slice(4)}`,
    project_id: projectId,
    at,
    session_id: action.session_id,
    action_id: action.action_id,
    kind: sel !== null && sel.kind === "task" ? "issue" : "change",
    target: sel,
    text: action.trigger,
    /** 出处：一句话来自哪个会话/哪次讨论 */
    sources: [action.session_id === null ? "chat" : `chat:${action.session_id}`],
    /** 现状口径：只登记意见，不动项目状态（§3.6：一次不满 ≠ 整个项目失败） */
    scope: "local",
    status: "open",
  };
  const file = path.join(chatActionWorkDir(projectId, dataDir), CHAT_CHANGES_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const line = JSON.stringify(record);
  appendJsonlLine(file, line);
  // 写回复核：最后一行必须是我们刚写的那条（否则报错，不假装登记成功）
  const written = fs.readFileSync(file, "utf8").replace(/\n+$/, "").split(/\r?\n/).pop() ?? "";
  if (written !== line) {
    throw new WorkError("INVALID_COMMAND", "变更/问题记录写入后复核不一致：不把这次登记当作成功", {
      reason: "change_log_write_unverified",
    });
  }
  const rel = relToRoot(projectId, file, dataDir);
  const affected = sel === null ? [] : [`${sel.kind}:${sel.id}`];
  const receipt: ActionToolReceipt = {
    tool: "record_change",
    ok: true,
    write: true,
    summary:
      (record.kind === "issue" ? "问题" : "变更") +
      `已登记（${record.change_id}）` +
      (sel === null ? "；未携带选中对象（只按原话记录）" : `；定位到 ${sel.kind}:${sel.id}${sel.name ? `（${sel.name}）` : ""}`) +
      "；项目状态与 Gate 未改动",
    affected_ids: affected,
    at,
    detail: { change_id: record.change_id, kind: record.kind, target: sel, file: rel },
  };
  return save(
    projectId,
    {
      ...action,
      status: "saved",
      tool_receipts: [...action.tool_receipts, receipt],
      affected_ids: affected,
      result_ref: {
        kind: record.kind === "issue" ? "issue" : "change",
        path: rel,
        sha256: null,
        detail: `${record.change_id}（只登记意见，未改项目状态）`,
        extra: { change_id: record.change_id, target: sel },
      },
      stages: [...action.stages, { status: "saved", at, detail: receipt.summary, receipt_index: action.tool_receipts.length }],
    },
    at,
    dataDir,
  );
}

/**
 * 更新图：读有效基线 → 走 §4.1 派生链 → 回执列覆盖与未映射；只有真发布才 applied。
 *
 * 补修包 E：这条入口不再"只做零模型确定性派生"——它走**自动链**（`autoRebuildBlueprint`）：
 *   ① 先零模型地发确定性派生 + 复用已保存的语义整理结果（立即可用）；
 *   ② 再自动检查分段整理结果：命中即复用（零调用），缺失/该段来源变了才在**后台**触发必要整理
 *      （不阻塞这次动作，状态与回执可查）。
 *   "更新图"因此**不会**把图里已有的语义整理结果抹掉（这正是补修 E 联验 V06-07 的那一点）；
 *   用户显式要求"重新整理"仍走 POST arch/blueprint {semantic:true}（`semantic:true` 是显式重试入口，
 *   不是产品链路的唯一触发方式）。
 *   夹具注入了 `deps.rebuild` 时保持"只做确定性派生"的老口径（既有夹具语义不变）。
 */
async function runBlueprintUpdate(
  projectId: string,
  action: ChatAction,
  deps: ChatActionDeps,
  now: () => string,
): Promise<ChatAction> {
  const dataDir = deps.dataDir;
  const at = now();
  const before = readBlueprint(projectId, dataDir);
  const drafting: ChatAction = save(
    projectId,
    {
      ...action,
      status: "drafting",
      stages: [
        ...action.stages,
        {
          status: "drafting",
          at,
          detail: `调用 §4.1 派生流程（基线 ${action.source_versions.baseline_id ?? "（无）"}；上次发布图 ${before?.based_on.full_key.slice(0, 12) ?? "（无）"}）`,
          receipt_index: null,
        },
      ],
    },
    at,
    dataDir,
  );
  let bp: Blueprint | null;
  let published: boolean;
  let reason: string | null;
  let didRebuild: boolean;
  let staleDiscarded: boolean;
  let keptPrevious: boolean;
  let cacheKey: string;
  let semanticDetail: Record<string, unknown> | null = null;
  if (deps.rebuild !== undefined) {
    const result = await deps.rebuild(projectId, {
      ...(dataDir !== undefined ? { dataDir } : {}),
      trigger: "chat_action",
      semantic: false, // 夹具注入的确定性入口：老口径（零模型）
      force: true,
    });
    bp = result.blueprint;
    published = result.publish.published;
    reason = result.publish.reason;
    didRebuild = result.rebuilt;
    staleDiscarded = result.stale_discarded;
    keptPrevious = result.kept_previous;
    cacheKey = result.cache_key;
  } else {
    const auto = deps.auto ?? ((pid: string, o: Parameters<typeof autoRebuildBlueprint>[1]) => autoRebuildBlueprint(pid, o));
    const result = await auto(projectId, {
      ...(dataDir !== undefined ? { dataDir } : {}),
      trigger: "chat_action",
      awaitSemantic: false, // 整理阶段在后台继续：动作不因模型快慢卡住，状态与回执可查
    });
    bp = result.blueprint;
    published = result.published;
    reason = result.publish_reason;
    didRebuild = result.repainted;
    keptPrevious = result.kept_previous;
    cacheKey = result.cache_key ?? "";
    staleDiscarded = readBlueprintReceipt(projectId, dataDir)?.stale_discarded === true;
    semanticDetail = {
      outcome: result.status.outcome,
      semantic_complete: result.status.semantic_complete,
      model_calls: result.model_calls,
      phase: result.status.phase,
      note: result.status.note,
      scopes: result.status.scopes.map((s) => ({ scope: s.scope, state: s.state, key: s.key, stale_source: s.stale_source, entries: s.entries, error: s.error })),
      missing: result.status.missing,
    };
  }
  const after = now();
  const coverage = bp === null ? null : bp.coverage;
  const unmapped = [
    ...(coverage?.design_sections.unmapped ?? []).map((u) => `设计节 ${u.key}`),
    ...(coverage?.plan_tasks.unmapped ?? []).map((u) => `任务 ${u.key}`),
    ...(coverage?.code_modules.unmapped ?? []).map((u) => `代码模块 ${u.key}`),
  ];
  const prevNodes = new Map((before?.nodes ?? []).map((n) => [n.id, sha256Hex(JSON.stringify(n))]));
  const added = (bp?.nodes ?? []).filter((n) => !prevNodes.has(n.id)).map((n) => n.id);
  const changed = (bp?.nodes ?? []).filter((n) => {
    const p = prevNodes.get(n.id);
    return p !== undefined && p !== sha256Hex(JSON.stringify(n));
  }).map((n) => n.id);
  const affected = [...added, ...changed].slice(0, 200);
  const semanticClaim =
    semanticDetail === null
      ? ""
      : `；语义整理 ${
          semanticDetail.semantic_complete === true
            ? "本轮覆盖全部来源段"
            : `**未完整**（${String(semanticDetail.note ?? "")}）`
        }`;
  const summary =
    (published ? "图已更新" : "图未更新（保留上次有效图）") +
    `：节点 +${added.length} / 改 ${changed.length}；覆盖 设计 ${coverage?.design_sections.mapped ?? 0}/${coverage?.design_sections.total ?? 0}` +
    `、任务 ${coverage?.plan_tasks.mapped ?? 0}/${coverage?.plan_tasks.total ?? 0}` +
    `、代码模块 ${coverage?.code_modules.mapped ?? 0}/${coverage?.code_modules.total ?? 0}；` +
    `未映射 ${unmapped.length} 项` +
    semanticClaim +
    (reason === null ? "" : `；原因：${reason}`) +
    `；图版本 ${cacheKey.slice(0, 12)}`;
  const receipt: ActionToolReceipt = {
    tool: "blueprint",
    ok: published,
    write: published,
    summary,
    affected_ids: affected,
    at: after,
    detail: {
      published,
      reason,
      rebuilt: didRebuild,
      stale_discarded: staleDiscarded,
      kept_previous: keptPrevious,
      cache_key: cacheKey,
      coverage,
      unmapped,
      semantic: semanticDetail,
    },
  };
  const base: ChatAction = {
    ...action,
    tool_receipts: [...action.tool_receipts, receipt],
    affected_ids: [...new Set([...action.affected_ids, ...affected, ...unmapped])],
    stages: [
      ...drafting.stages,
      {
        status: published ? "applied" : "failed",
        at: after,
        detail: summary,
        receipt_index: drafting.tool_receipts.length,
      },
    ],
  };
  if (!published) {
    return save(
      projectId,
      {
        ...base,
        status: "failed",
        error: {
          code: "BLUEPRINT_NOT_PUBLISHED",
          message: `图没有发布：${reason ?? "未知原因"}（上次有效图保留 ${keptPrevious ? "是" : "否"}）`,
          stage: "drafting",
          recoverable: true,
        },
      },
      after,
      dataDir,
    );
  }
  const bpFile = path.join(projectDir(projectId, dataDir), ".工作台", "arch", "blueprint.json");
  return save(
    projectId,
    {
      ...base,
      status: "applied",
      error: null,
      result_ref: {
        kind: "blueprint",
        path: relToRoot(projectId, bpFile, dataDir),
        sha256: fs.existsSync(bpFile) ? sha256Hex(fs.readFileSync(bpFile)) : null,
        detail: `未映射 ${unmapped.length} 项：${unmapped.slice(0, 10).join("、")}${unmapped.length > 10 ? "…" : ""}`,
        extra: { cache_key: cacheKey, coverage, unmapped, semantic: semanticDetail },
      },
    },
    after,
    dataDir,
  );
}

function projectDir(projectId: string, dataDir?: string): string {
  return resolveDocumentSource(projectId, "design", dataDir).project_root;
}

// ───────────────────────────────── 整理方案（提案） ─────────────────────────────────

interface DesignProposalItem {
  op: "replace" | "add";
  path: string;
  text: string;
  rationale: string;
  sources: string[];
}

interface PlanProposalItem {
  op: "add" | "update";
  card_id: string;
  goal: string;
  dependencies: string;
  evidence: string;
  body: string;
  rationale: string;
  sources: string[];
}

interface ProposalParseResult {
  design_items: DesignProposalItem[];
  plan_items: PlanProposalItem[];
  notes: string[];
  /** 被丢弃的条目（无出处 / 定位不到 / 缺验收 / 悬空依赖）：不静默吞掉 */
  dropped: { what: string; why: string }[];
}

/** 从模型 JSON 里取数组字段（形状不对就丢，不硬塞） */
function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
const asStr = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

function parseProposal(
  json: unknown,
  designPaths: ReadonlySet<string>,
  planTaskIds: ReadonlySet<string>,
): ProposalParseResult {
  const out: ProposalParseResult = { design_items: [], plan_items: [], notes: [], dropped: [] };
  if (typeof json !== "object" || json === null) {
    out.dropped.push({ what: "model_output", why: "模型输出不是 JSON 对象" });
    return out;
  }
  const root = json as Record<string, unknown>;
  out.notes = asArray(root.notes).map(asStr).filter((s) => s !== "");
  for (const raw of asArray(root.design_items)) {
    if (typeof raw !== "object" || raw === null) continue;
    const r = raw as Record<string, unknown>;
    const op = asStr(r.op) === "add" ? "add" : "replace";
    const p = asStr(r.path);
    const text = typeof r.text === "string" ? r.text.trim() : "";
    const sources = asArray(r.sources).map(asStr).filter((s) => s !== "");
    if (p === "" || text === "") {
      out.dropped.push({ what: `design:${p || "（无路径）"}`, why: "缺章节路径或正文" });
      continue;
    }
    // 「有出处」硬口径：没有来源的条目不是方案，是臆断——丢弃并如实登记
    if (sources.length === 0) {
      out.dropped.push({ what: `design:${p}`, why: "条目没有任何出处（sources 为空）：不采信无出处的差异" });
      continue;
    }
    if (op === "replace" && !designPaths.has(p)) {
      out.dropped.push({ what: `design:${p}`, why: "现行设计书里找不到这个章节路径（不静默新建同义节）" });
      continue;
    }
    out.design_items.push({ op, path: p, text, rationale: asStr(r.rationale), sources });
  }
  const known = new Set(planTaskIds);
  for (const raw of asArray(root.plan_items)) {
    if (typeof raw !== "object" || raw === null) continue;
    const r = raw as Record<string, unknown>;
    const op = asStr(r.op) === "update" ? "update" : "add";
    const cardId = asStr(r.card_id);
    const goal = asStr(r.goal);
    const evidence = asStr(r.evidence);
    const sources = asArray(r.sources).map(asStr).filter((s) => s !== "");
    if (cardId === "") {
      out.dropped.push({ what: "plan:（无卡号）", why: "缺卡号" });
      continue;
    }
    if (sources.length === 0) {
      out.dropped.push({ what: `plan:${cardId}`, why: "条目没有任何出处（sources 为空）" });
      continue;
    }
    if (op === "update" && !planTaskIds.has(cardId)) {
      out.dropped.push({ what: `plan:${cardId}`, why: "现行施工图里没有这张卡（update 定位不到）" });
      continue;
    }
    if (op === "add") {
      if (goal === "" || evidence === "") {
        out.dropped.push({ what: `plan:${cardId}`, why: "新卡缺交付目标或缺完成证据（不许无验收的新卡）" });
        continue;
      }
      known.add(cardId);
    }
    out.plan_items.push({
      op,
      card_id: cardId,
      goal,
      dependencies: asStr(r.dependencies),
      evidence,
      body: typeof r.body === "string" ? r.body.trim() : "",
      rationale: asStr(r.rationale),
      sources,
    });
  }
  // 悬空依赖：新卡依赖了不存在的卡 → 丢弃并点名（不静默）
  out.plan_items = out.plan_items.filter((item) => {
    const deps = item.dependencies.split(/[,，、\s/|]+/).map((s) => s.trim()).filter((s) => s !== "");
    const dangling = deps.filter((d) => !known.has(d));
    if (dangling.length > 0) {
      out.dropped.push({ what: `plan:${item.card_id}`, why: `依赖了不存在的卡：${dangling.join("、")}` });
      return false;
    }
    return true;
  });
  return out;
}

/** 把设计条目落到候选原文上（替换按行号倒序处理，免得前面的改动挪动后面的行号） */
function applyDesignItems(
  text: string,
  items: readonly DesignProposalItem[],
): { text: string; applied: { path: string; op: string; lines: [number, number] | null }[] } {
  const sections = buildSectionIndex(text);
  const byPath = new Map(sections.map((s) => [s.path, s]));
  const lines = text.split(/\r?\n/);
  const applied: { path: string; op: string; lines: [number, number] | null }[] = [];
  // 嵌套节的重复替换会互相挪动行号：区间被别的替换区间**包含**的条目直接让位给外层
  // （外层替换已把子节一并换掉），避免按过期行号再去 splice 一次。
  const candidates = items.filter((i) => i.op === "replace" && byPath.has(i.path));
  const outer = candidates.filter((i) => {
    const s = byPath.get(i.path)!;
    return !candidates.some((o) => {
      if (o === i) return false;
      const t = byPath.get(o.path)!;
      return t.line_start <= s.line_start && t.line_end >= s.line_end && (t.line_start !== s.line_start || t.line_end !== s.line_end);
    });
  });
  const replacements = outer.sort((a, b) => byPath.get(b.path)!.line_start - byPath.get(a.path)!.line_start);
  for (const item of replacements) {
    const s = byPath.get(item.path)!;
    const body = item.text.endsWith("\n") ? item.text : `${item.text}\n`;
    lines.splice(s.line_start - 1, s.line_end - s.line_start + 1, ...body.replace(/\n$/, "").split("\n"));
    applied.push({ path: item.path, op: "replace", lines: [s.line_start, s.line_end] });
  }
  let out = lines.join("\n");
  const additions = items.filter((i) => i.op === "add" || !byPath.has(i.path));
  if (additions.length > 0) {
    const block = additions.map((i) => `${i.text.replace(/\n+$/, "")}\n`).join("\n");
    out = `${out.replace(/\n+$/, "")}\n\n${block}`;
    for (const i of additions) applied.push({ path: i.path, op: "add", lines: null });
  }
  return { text: out, applied };
}

/** 把任务条目落到候选施工图原文上（按表格行原地改；新卡插在表尾；卡正文追加在文档末尾） */
function applyPlanItems(
  text: string,
  items: readonly PlanProposalItem[],
  table: PlanTable,
): { text: string; applied: { card_id: string; op: string }[] } {
  const header = table.header;
  const lines = text.split(/\r?\n/);
  const cellOf = (line: string, name: string): string => {
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    const idx = header.indexOf(name);
    return idx >= 0 && idx < cells.length ? cells[idx] : "";
  };
  const rowOf = (id: string, goal: string, deps: string, evidence: string, status: string): string => {
    const values: Record<string, string> = {
      卡号: id,
      状态: status,
      交付目标: goal,
      依赖: deps,
      完成证据: evidence,
    };
    return `| ${header.map((h) => values[h] ?? "").join(" | ")} |`;
  };
  const applied: { card_id: string; op: string }[] = [];
  let lastRow = table.rows.length === 0 ? table.start_line + 1 : table.rows[table.rows.length - 1].row;
  for (const item of items) {
    const cur = table.rows.find((r) => r.id === item.card_id);
    if (item.op === "update" && cur !== undefined) {
      const status = cellOf(lines[cur.row - 1] ?? "", "状态") || "todo";
      lines[cur.row - 1] = rowOf(
        item.card_id,
        item.goal === "" ? cur.goal : item.goal,
        item.dependencies,
        item.evidence === "" ? cur.evidence : item.evidence,
        status,
      );
      applied.push({ card_id: item.card_id, op: "update" });
    } else if (item.op === "add") {
      lines.splice(lastRow, 0, rowOf(item.card_id, item.goal, item.dependencies, item.evidence, "todo"));
      lastRow++;
      applied.push({ card_id: item.card_id, op: "add" });
    }
  }
  let out = lines.join("\n");
  const bodies = items.filter((i) => i.body !== "").map((i) => {
    const head = i.body.startsWith("###") ? "" : `### ${i.card_id} ${i.goal}\n\n`;
    return `${head}${i.body.replace(/\n+$/, "")}\n`;
  });
  if (bodies.length > 0) out = `${out.replace(/\n+$/, "")}\n\n${bodies.join("\n")}`;
  return { text: out, applied };
}

function buildProposalMessages(input: {
  projectName: string;
  trigger: string;
  designText: string;
  designSections: { path: string; line_start: number; line_end: number }[];
  planText: string;
  tasks: { id: string; goal: string; dependencies: string[]; evidence: string }[];
  baselineId: string | null;
}): FlashMessage[] {
  const sectionIndex = input.designSections
    .map((s) => `- ${s.path}（第 ${s.line_start}–${s.line_end} 行）`)
    .join("\n");
  const taskList = input.tasks
    .map((t) => `- ${t.id}：${t.goal}（依赖 ${t.dependencies.join("、") || "无"}；完成证据：${t.evidence || "（缺）"}）`)
    .join("\n");
  return [
    {
      role: "system",
      content:
        "你是塔台的方案整理助手（DESIGN.md §3.5：正式修订走「读取现行原文 → 提出章节/任务差异 → " +
        "检查关联影响 → 审定配套版本 → 激活基线」）。你的输出**只是提案**，不会自动生效；" +
        "审定与激活由人/设计角色决定。硬性要求：\n" +
        "1. 只输出一个 JSON 对象，不要围栏、不要解释；\n" +
        "2. 结构：{\"design_items\":[{\"op\":\"replace|add\",\"path\":\"现行章节路径或新节标题路径\"," +
        "\"text\":\"该节完整正文（第一行是标题）\",\"rationale\":\"为什么改\",\"sources\":[\"出处\"]}]," +
        "\"plan_items\":[{\"op\":\"add|update\",\"card_id\":\"卡号\",\"goal\":\"交付目标\"," +
        "\"dependencies\":\"依赖卡号（逗号分隔，可空）\",\"evidence\":\"完成证据\",\"body\":\"卡正文 markdown（可空）\"," +
        "\"rationale\":\"为什么\",\"sources\":[\"出处\"]}],\"notes\":[\"提醒\"]}；\n" +
        "3. replace 的 path 必须是**现行章节路径清单**里已有的路径（一字不差）；新增节用 add；\n" +
        "4. 每个条目都必须带 sources（出处：讨论里的原话、现行材料里的位置）。**没有出处的条目会被丢弃**；\n" +
        "5. 新卡必须有完成证据（缺证据的卡会被丢弃）；依赖只能指向现行卡或本次新增卡；\n" +
        "6. 不编造现行材料里没有的事实；拿不准就写进 notes，不要硬改。",
    },
    {
      role: "user",
      content:
        `项目：${input.projectName}\n生效基线：${input.baselineId ?? "（无）"}\n\n` +
        `【用户原话（讨论）】\n${input.trigger}\n\n` +
        `【现行设计书章节路径清单】\n${sectionIndex || "（无章节）"}\n\n` +
        `【现行设计书正文】\n${input.designText}\n\n` +
        `【现行施工图任务】\n${taskList || "（无任务）"}\n\n` +
        `【现行施工图正文】\n${input.planText}\n\n` +
        "请给出章节差异与任务差异的提案 JSON。",
    },
  ];
}

/** 整理方案：读现行两份材料 → 模型出有出处的差异 → 落提案件 → review_needed（不激活） */
async function runProposal(
  projectId: string,
  action: ChatAction,
  deps: ChatActionDeps,
  now: () => string,
): Promise<ChatAction> {
  const dataDir = deps.dataDir;
  const at = now();
  const project = getProject(projectId, dataDir);
  if (!project) {
    throw new WorkError("INVALID_COMMAND", `项目不存在: ${projectId}`, { project_id: projectId });
  }
  const docs = loadDocuments(projectId, dataDir);
  if (docs.design === null) {
    throw new WorkError(
      "INVALID_COMMAND",
      "还没有设计书：整理方案先要有现行原文（可先走「落稿」或逆向落稿），当前无法提出章节差异",
      { project_id: projectId, reason: "missing_design" },
    );
  }
  if (docs.plan === null) {
    throw new WorkError(
      "INVALID_COMMAND",
      "还没有施工图：正式修订要读**两份**现行材料（§3.5），当前缺施工图，无法提出配套差异",
      { project_id: projectId, reason: "missing_plan" },
    );
  }
  const design = docs.design;
  const plan = docs.plan;
  const sections = buildSectionIndex(design.text);
  const planTable = parsePlanTable(plan.text);
  const planTasks: PlanTask[] = planTable?.rows ?? plan.tasks;
  const drafting: ChatAction = save(
    projectId,
    {
      ...action,
      status: "drafting",
      stages: [
        ...action.stages,
        {
          status: "drafting",
          at,
          detail:
            `读现行两份材料（设计 ${design.revision.content_sha256.slice(0, 8)} / 施工 ${plan.revision.definition_sha256.slice(0, 8)}）` +
            `，让模型提出有出处的章节/任务差异`,
          receipt_index: null,
        },
      ],
    },
    at,
    dataDir,
  );
  const chat = deps.chat ?? defaultChatActionChat;
  const out = await chat(
    buildProposalMessages({
      projectName: project.name,
      trigger: action.trigger,
      designText: design.text,
      designSections: sections.map((s) => ({ path: s.path, line_start: s.line_start, line_end: s.line_end })),
      planText: plan.text,
      tasks: planTasks.map((t) => ({
        id: t.id,
        goal: t.goal,
        dependencies: t.dependencies,
        evidence: t.evidence,
      })),
      baselineId: action.source_versions.baseline_id,
    }),
  );
  const after = now();
  if (out.error !== null || out.json === null) {
    return save(
      projectId,
      {
        ...drafting,
        status: "failed",
        error: {
          code: "MODEL_OUTPUT_INVALID",
          message: `整理方案失败：${out.error ?? "模型输出里没有 JSON"}（现行原文已读到，重试不必重读）`,
          stage: "drafting",
          recoverable: true,
        },
        tool_receipts: [
          ...drafting.tool_receipts,
          {
            tool: "model",
            ok: false,
            write: false,
            summary: `模型整理失败：${out.error ?? "输出里没有 JSON"}`,
            affected_ids: [],
            at: after,
            detail: { raw_excerpt: out.text.slice(0, 500) },
          },
        ],
        stages: [...drafting.stages, { status: "failed", at: after, detail: "模型整理失败", receipt_index: null }],
      },
      after,
      dataDir,
    );
  }
  const designPaths = new Set(sections.map((s) => s.path));
  const planIds = new Set(planTasks.map((t) => t.id));
  const parsed = parseProposal(out.json, designPaths, planIds);
  if (parsed.design_items.length === 0 && parsed.plan_items.length === 0) {
    return save(
      projectId,
      {
        ...drafting,
        status: "failed",
        error: {
          code: "PROPOSAL_EMPTY",
          message: `提案里没有任何可用条目（被丢弃 ${parsed.dropped.length} 条：${parsed.dropped.map((d) => `${d.what}→${d.why}`).join("；")}）`,
          stage: "drafting",
          recoverable: true,
        },
        tool_receipts: [
          ...drafting.tool_receipts,
          {
            tool: "model",
            ok: false,
            write: false,
            summary: `模型出了 ${parsed.dropped.length} 条无可采信条目，全部被丢弃`,
            affected_ids: [],
            at: after,
            detail: { dropped: parsed.dropped, raw_excerpt: out.text.slice(0, 500) },
          },
        ],
        stages: [...drafting.stages, { status: "failed", at: after, detail: "提案空", receipt_index: null }],
      },
      after,
      dataDir,
    );
  }

  // 落候选原文（**不改现行图纸**）+ 章节/任务差异
  const designApplied = applyDesignItems(design.text, parsed.design_items);
  const planApplied = applyPlanItems(plan.text, parsed.plan_items, planTable ?? {
    start_line: 1,
    header: ["卡号", "状态", "交付目标", "依赖", "完成证据"],
    rows: [],
  });
  const proposedTable = parsePlanTable(planApplied.text);
  const proposedTasks = proposedTable?.rows ?? [];
  const blocking = validatePlanTasks(proposedTasks, proposedTable !== null);
  const sectionDiff = diffSections(
    "design",
    {
      text: design.text,
      content_sha256: design.revision.content_sha256,
      definition_sha256: design.revision.definition_sha256,
    },
    { text: designApplied.text, content_sha256: sha256Hex(designApplied.text), definition_sha256: sha256Hex(designApplied.text) },
  );
  const taskDiff: TaskRevisionChange[] = diffTaskDefinitions(
    importTaskDefinitions(plan.text).definitions,
    importTaskDefinitions(planApplied.text).definitions,
  );

  const dir = chatProposalDir(projectId, action.action_id, dataDir);
  const designCandidateFile = path.join(dir, "design.candidate.md");
  const planCandidateFile = path.join(dir, "plan.candidate.md");
  writeTextAtomic(designCandidateFile, designApplied.text);
  writeTextAtomic(planCandidateFile, planApplied.text);
  const reportFile = path.join(dir, "proposal.md");
  const changedSections = sectionDiff.changed;
  const changedTasks = taskDiff.filter((t) => t.change !== "unchanged");
  const report = [
    `# 方案提案 ${action.action_id}`,
    "",
    "> 本文件是**待审定提案**（DESIGN.md §3.5）：现行图纸**一个字节都没改**。",
    "> 审定后由人/设计角色点「审定并激活」才写入现行源码并激活基线。",
    "",
    "## 输入版本（读取时）",
    "",
    `- 设计：${design.source.rel_path} @ ${design.revision.content_sha256}`,
    `- 施工：${plan.source.rel_path} @ ${plan.revision.definition_sha256}（定义哈希）`,
    `- 生效基线：${action.source_versions.baseline_id ?? "（无）"}`,
    "",
    "## 用户原话（出处）",
    "",
    action.trigger.trim(),
    "",
    "## 章节差异（设计）",
    "",
    `计数：新增 ${sectionDiff.counts.added} / 删除 ${sectionDiff.counts.removed} / 修改 ${sectionDiff.counts.changed} / 未变 ${sectionDiff.counts.unchanged}`,
    "",
    "| 章节路径 | 变更 | 改前哈希 | 改后哈希 | 改前行范围 | 改后行范围 |",
    "| --- | --- | --- | --- | --- | --- |",
    ...changedSections.map(
      (c) =>
        `| ${c.path} | ${c.change} | ${c.before_sha256?.slice(0, 8) ?? "-"} | ${c.after_sha256?.slice(0, 8) ?? "-"} | ` +
        `${c.before_lines?.join("–") ?? "-"} | ${c.after_lines?.join("–") ?? "-"} |`,
    ),
    "",
    "## 任务差异（施工图）",
    "",
    "| 卡号 | 变更 | 改前定义哈希 | 改后定义哈希 | 变化字段 |",
    "| --- | --- | --- | --- | --- |",
    ...changedTasks.map(
      (t) =>
        `| ${t.task_id} | ${t.change} | ${t.before_sha256?.slice(0, 8) ?? "-"} | ${t.after_sha256?.slice(0, 8) ?? "-"} | ${t.changed_fields.join("、") || "-"} |`,
    ),
    "",
    `施工图结构校验：${blocking.length === 0 ? "通过" : `不通过（${blocking.map((b) => b.detail).join("；")}）`}`,
    "",
    "## 提案条目与出处",
    "",
    ...parsed.design_items.map(
      (i) =>
        `- [设计·${i.op}] ${i.path}｜出处：${i.sources.join("、")}｜理由：${i.rationale || "（未写）"}`,
    ),
    ...parsed.plan_items.map(
      (i) =>
        `- [施工·${i.op}] ${i.card_id}｜出处：${i.sources.join("、")}｜理由：${i.rationale || "（未写）"}`,
    ),
    "",
    "## 被丢弃的条目（不静默）",
    "",
    ...(parsed.dropped.length === 0
      ? ["- （无）"]
      : parsed.dropped.map((d) => `- ${d.what}：${d.why}`)),
    "",
    "## 关联候选件",
    "",
    `- 候选设计原文：${relToRoot(projectId, designCandidateFile, dataDir)}`,
    `- 候选施工原文：${relToRoot(projectId, planCandidateFile, dataDir)}`,
    ...(parsed.notes.length > 0 ? ["", "## 提醒", "", ...parsed.notes.map((n) => `- ${n}`)] : []),
    "",
  ].join("\n");
  writeTextAtomic(reportFile, report);
  const reportRel = relToRoot(projectId, reportFile, dataDir);
  const receipt: ActionToolReceipt = {
    tool: "write_proposal",
    ok: true,
    write: true,
    summary:
      `提案已落盘（${reportRel}）：章节差异 新增 ${sectionDiff.counts.added}/删除 ${sectionDiff.counts.removed}/修改 ${sectionDiff.counts.changed}；` +
      `任务差异 ${changedTasks.length} 张；丢弃无可信条目 ${parsed.dropped.length} 条——**待审定，未激活**`,
    affected_ids: [...changedSections.map((c) => c.path), ...changedTasks.map((t) => t.task_id)],
    at: after,
    detail: {
      section_diff: sectionDiff,
      task_diff: taskDiff,
      dropped: parsed.dropped,
      structure_ok: blocking.length === 0,
    },
  };
  return save(
    projectId,
    {
      ...drafting,
      status: "review_needed",
      error: null,
      tool_receipts: [...drafting.tool_receipts, receipt],
      affected_ids: receipt.affected_ids,
      result_ref: {
        kind: "proposal",
        path: reportRel,
        sha256: sha256Hex(report),
        detail: `待审定：章节差异 ${sectionDiff.changed.length} 处、任务差异 ${changedTasks.length} 张`,
        extra: {
          design_candidate: {
            path: relToRoot(projectId, designCandidateFile, dataDir),
            sha256: sha256Hex(designApplied.text),
          },
          plan_candidate: {
            path: relToRoot(projectId, planCandidateFile, dataDir),
            sha256: sha256Hex(planApplied.text),
          },
          section_diff_counts: sectionDiff.counts,
          changed_tasks: changedTasks.length,
          dropped: parsed.dropped,
          expected: {
            design_content_sha256: design.revision.content_sha256,
            design_definition_sha256: design.revision.definition_sha256,
            plan_content_sha256: plan.revision.content_sha256,
            plan_definition_sha256: plan.revision.definition_sha256,
          },
        },
      },
      stages: [...drafting.stages, { status: "review_needed", at: after, detail: receipt.summary, receipt_index: drafting.tool_receipts.length }],
    },
    after,
    dataDir,
  );
}

// ───────────────────────────────── 审定并激活（正式修订的唯一写口） ─────────────────────────────────

export interface ActivateProposalInput {
  approved_by: string;
  approval_basis: string;
  approval_kind: BaselineApprovalKind;
}

/**
 * 审定并激活提案（DESIGN.md §3.5 的最后两步）：把候选原文写进现行源 → 激活基线。
 *
 * 三道闸（任一不过都不写一个字节）：
 *   ① 动作必须是 `proposal` 且 `review_needed`（审定未完成不许激活）；审定者与依据必填；
 *   ② 现行源必须仍等于提案读取时的版本（变了 = 重读后再审定，报 VERSION_CONFLICT）；
 *   ③ 候选件必须与提案记录里的哈希一致（被改过的候选件不采信）。
 * 写盘 / 激活任一步失败 → 回滚写盘（不留"半套新图纸"），动作落 failed（可续接）。
 */
export function activateChatActionProposal(
  projectId: string,
  actionId: string,
  input: ActivateProposalInput,
  deps: ChatActionDeps = {},
): ChatAction {
  const dataDir = deps.dataDir;
  const now = deps.now ?? nowIso;
  requireProject(projectId, dataDir);
  const action = getChatAction(projectId, actionId, dataDir);
  if (action === null) throw new WorkError("INVALID_COMMAND", `动作不存在: ${actionId}`, { action_id: actionId });
  if (action.kind !== "proposal") {
    throw new WorkError("INVALID_COMMAND", `动作 ${actionId} 不是提案（kind=${action.kind}），不能审定激活`, {
      action_id: actionId,
    });
  }
  if (action.status !== "review_needed") {
    throw new WorkError(
      "INVALID_COMMAND",
      `动作 ${actionId} 当前状态是 ${action.status}，只有 review_needed（待审定）的提案能审定激活`,
      { action_id: actionId, status: action.status },
    );
  }
  if (input.approved_by.trim() === "" || input.approval_basis.trim() === "") {
    throw new WorkError("INVALID_COMMAND", "审定必须有审定者与审定依据（§2.9：无依据不能激活）", {
      action_id: actionId,
    });
  }
  const extra = (action.result_ref?.extra ?? {}) as Record<string, unknown>;
  const designCand = extra.design_candidate as { path: string; sha256: string } | undefined;
  const planCand = extra.plan_candidate as { path: string; sha256: string } | undefined;
  const expected = (extra.expected ?? {}) as Record<string, string>;
  const at = now();
  if (designCand === undefined || planCand === undefined) {
    return failed(
      action,
      "review_needed",
      "PROPOSAL_INCOMPLETE",
      "提案记录里没有候选原文引用（缺 design_candidate / plan_candidate），无法审定激活",
      false,
      at,
      dataDir,
    );
  }
  // ③ 候选件哈希复核：被改过的候选件不采信
  const designFile = absFromRel(projectId, designCand.path, dataDir);
  const planFile = absFromRel(projectId, planCand.path, dataDir);
  const readCandidate = (file: string, want: string, label: string): string | { error: string } => {
    if (!fs.existsSync(file)) return { error: `${label}候选件不存在：${path.basename(file)}` };
    const text = fs.readFileSync(file, "utf8");
    if (sha256Hex(text) !== want) return { error: `${label}候选件与提案记录不一致（被改过？），拒绝采信` };
    return text;
  };
  const designText = readCandidate(designFile, designCand.sha256, "设计");
  const planText = readCandidate(planFile, planCand.sha256, "施工");
  if (typeof designText !== "string" || typeof planText !== "string") {
    const msg = [
      typeof designText === "string" ? "" : designText.error,
      typeof planText === "string" ? "" : planText.error,
    ]
      .filter((s) => s !== "")
      .join("；");
    return failed(action, "review_needed", "PROPOSAL_TAMPERED", msg, false, at, dataDir);
  }

  // ② 源在审定期间变没变（§2.9 的 VERSION_CONFLICT 口径）
  const docs = loadDocuments(projectId, dataDir);
  if (docs.design === null || docs.plan === null) {
    return failed(action, "review_needed", "SOURCE_MISSING", "现行图纸缺失，无法审定激活", true, at, dataDir);
  }
  const conflicts: string[] = [];
  const cmp = (label: string, want: string | undefined, current: string): void => {
    if (want === undefined || want === "") return; // 提案没记这一项就不比，不拿"没记"当"变了"
    if (want !== current) conflicts.push(label);
  };
  cmp("设计内容哈希", expected.design_content_sha256, docs.design.revision.content_sha256);
  cmp("设计定义哈希", expected.design_definition_sha256, docs.design.revision.definition_sha256);
  cmp("施工内容哈希", expected.plan_content_sha256, docs.plan.revision.content_sha256);
  cmp("施工定义哈希", expected.plan_definition_sha256, docs.plan.revision.definition_sha256);
  if (conflicts.length > 0) {
    return failed(
      action,
      "review_needed",
      "VERSION_CONFLICT",
      `源在审定中改变了（${conflicts.join("、")}）：本次提案作废，重新读取现行原文后再审定（§2.9），现状未被改动`,
      true,
      at,
      dataDir,
    );
  }

  // 结构先校验：不过就一个字节都不写
  const proposedTable = parsePlanTable(planText);
  const blocking = validatePlanTasks(proposedTable?.rows ?? [], proposedTable !== null);
  if (blocking.length > 0) {
    return failed(
      action,
      "review_needed",
      "PLAN_STRUCTURE_INVALID",
      `候选施工图结构不合法（${blocking.map((b) => b.detail).join("；")}），拒绝激活`,
      true,
      at,
      dataDir,
    );
  }

  const designAbs = resolveDocumentSource(projectId, "design", dataDir).abs_path;
  const planAbs = resolveDocumentSource(projectId, "plan", dataDir).abs_path;
  const designBefore = docs.design.text;
  const planBefore = docs.plan.text;
  const receipts: ActionToolReceipt[] = [...action.tool_receipts];
  try {
    writeTextAtomic(designAbs, designText, designBefore);
    receipts.push({
      tool: "write_document",
      ok: true,
      write: true,
      summary: `设计书已按章节修订写入（${relToRoot(projectId, designAbs, dataDir)}）`,
      affected_ids: [relToRoot(projectId, designAbs, dataDir)],
      at,
      detail: { sha256: sha256Hex(designText) },
    });
    writeTextAtomic(planAbs, planText, planBefore);
    receipts.push({
      tool: "write_document",
      ok: true,
      write: true,
      summary: `施工图已按任务修订写入（${relToRoot(projectId, planAbs, dataDir)}）`,
      affected_ids: [relToRoot(projectId, planAbs, dataDir)],
      at,
      detail: { sha256: sha256Hex(planText) },
    });
    const activated = activateBaseline(
      projectId,
      {
        approved_by: input.approved_by,
        approval_basis: input.approval_basis,
        approval_kind: input.approval_kind,
        expected: {
          // 审定者手上的是**候选原文**（已写入现行源）：比对基准取候选哈希，
          // 「源在审定中改变」由本函数上一段（现行 == 提案读取版本）独立把住。
          design_content_sha256: sha256Hex(designText),
          plan_definition_sha256: definitionHashOf(proposedTable?.rows ?? []),
        },
      },
      dataDir,
    );
    receipts.push({
      tool: "baseline_activate",
      ok: true,
      write: true,
      summary: `基线已激活（${activated.baseline.baseline_id}，${activated.created ? "新建" : "同一对修订已生效"}；审定 ${activated.baseline.approved_by}/${activated.baseline.approval_kind}）`,
      affected_ids: [activated.baseline.baseline_id],
      at: now(),
      detail: { baseline: activated.baseline, created: activated.created },
    });
    const done = now();
    return save(
      projectId,
      {
        ...action,
        status: "applied",
        error: null,
        tool_receipts: receipts,
        affected_ids: [...new Set([...action.affected_ids, activated.baseline.baseline_id])],
        result_ref: {
          kind: "baseline",
          path: baselinesRel(projectId, dataDir),
          sha256: null,
          detail: `基线 ${activated.baseline.baseline_id} 已激活（设计 ${activated.baseline.design_revision.content_sha256.slice(0, 8)} / 施工 ${activated.baseline.plan_revision.definition_sha256.slice(0, 8)}）`,
          extra: { baseline_id: activated.baseline.baseline_id, created: activated.created },
        },
        stages: [
          ...action.stages,
          { status: "applied", at: done, detail: "审定并激活成功", receipt_index: receipts.length - 1 },
        ],
      },
      done,
      dataDir,
    );
  } catch (e) {
    // 回滚：不让"半套新图纸"留在盘上（写盘成功但激活失败）
    const rollback: string[] = [];
    try {
      if (fs.existsSync(designAbs) && fs.readFileSync(designAbs, "utf8") === designText) {
        writeTextAtomic(designAbs, designBefore);
        rollback.push("设计书已回滚");
      }
    } catch {
      rollback.push("设计书回滚失败（需人工核对）");
    }
    try {
      if (fs.existsSync(planAbs) && fs.readFileSync(planAbs, "utf8") === planText) {
        writeTextAtomic(planAbs, planBefore);
        rollback.push("施工图已回滚");
      }
    } catch {
      rollback.push("施工图回滚失败（需人工核对）");
    }
    const msg = `${(e as Error).message}（${rollback.join("；") || "无需回滚"}）`;
    const failedAt = now();
    return save(
      projectId,
      {
        ...action,
        status: "failed",
        error: {
          code: e instanceof WorkError ? e.code : "ACTIVATE_FAILED",
          message: msg,
          stage: "review_needed",
          recoverable: true,
        },
        tool_receipts: receipts,
        stages: [...action.stages, { status: "failed", at: failedAt, detail: msg, receipt_index: null }],
      },
      failedAt,
      dataDir,
    );
  }
}

/** undefined 的期望值不参与比对（`activateBaseline` 同口径） */

function baselinesRel(projectId: string, dataDir?: string): string {
  return relToRoot(projectId, path.join(projectWorkbenchDir(projectId, dataDir), "baselines.jsonl"), dataDir);
}

// ───────────────────────────────── 失败续接 ─────────────────────────────────

/** 重试失败动作：输入（原话/选中/现行版本）都在记录里，重跑不产生半成品 */
export async function retryChatAction(
  projectId: string,
  actionId: string,
  deps: ChatActionDeps = {},
): Promise<ChatAction> {
  const action = getChatAction(projectId, actionId, deps.dataDir);
  if (action === null) throw new WorkError("INVALID_COMMAND", `动作不存在: ${actionId}`, { action_id: actionId });
  if (action.status !== "failed") {
    throw new WorkError(
      "INVALID_COMMAND",
      `动作 ${actionId} 当前状态是 ${action.status}，只有 failed 的动作需要续接`,
      { action_id: actionId, status: action.status },
    );
  }
  // 续接先记一笔（谁在哪里续），再重跑；幂等键不变 → 不会产生第二个动作
  const resumed = await runChatAction(
    {
      projectId,
      sessionId: action.session_id,
      text: action.trigger,
      selection: action.selection,
      intent: { kind: action.kind, rule: `${action.intent.rule}（续接）`, matched: action.intent.matched },
    },
    { ...deps, now: deps.now },
  );
  return resumed.action;
}

// ───────────────────────────────── 会话删除：归档留引用 ─────────────────────────────────

/** 该会话是否被动作**有效引用**（有产物指针/影响对象/待审定/已生效） */
export function actionHasValidReference(action: ChatAction): boolean {
  if (action.archived) return true;
  if (action.result_ref !== null) return true;
  if (action.affected_ids.length > 0) return true;
  return action.status === "review_needed" || action.status === "applied";
}

/** 列出引用了该会话的动作（含归档过的） */
export function chatActionsReferencingSession(
  projectId: string,
  sessionId: string,
  dataDir?: string,
): ChatAction[] {
  return readChatActionLog(projectId, dataDir).actions.filter(
    (a) => a.session_id === sessionId && actionHasValidReference(a),
  );
}

/**
 * 会话转归档：把 `<会话>.jsonl` 挪到 `chat/archive/`（内容一字不改），
 * 并在引用它的动作记录上留痕（§3.6「有有效引用的内容归档留引用，删除行为如实说明」）。
 * 返回归档到的相对路径；调用方据此决定"归档"还是"真删"。
 */
export function archiveChatSession(
  projectId: string,
  sessionId: string,
  opts: { chatFile: string; reason: string },
  dataDir?: string,
): { archived: boolean; archive_path: string | null; action_ids: string[] } {
  const referencing = chatActionsReferencingSession(projectId, sessionId, dataDir);
  if (referencing.length === 0) return { archived: false, archive_path: null, action_ids: [] };
  const at = nowIso();
  const dir = path.join(path.dirname(opts.chatFile), "archive");
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, path.basename(opts.chatFile));
  fs.renameSync(opts.chatFile, target);
  const rel = relToRoot(projectId, target, dataDir);
  const ids: string[] = [];
  for (const action of referencing) {
    // 落一行"会话已归档"，引用仍在（不是删除动作记录）
    save(
      projectId,
      {
        ...action,
        archived: true,
        archive: {
          reason: opts.reason,
          at,
          session_archive_path: rel,
        },
        tool_receipts: [
          ...action.tool_receipts,
          {
            tool: "session_archive",
            ok: true,
            write: true,
            summary: `会话 ${sessionId} 已被归档（${rel}）：本动作引用它，内容保留、引用不失效`,
            affected_ids: [rel],
            at,
            detail: { session_id: sessionId, reason: opts.reason },
          },
        ],
      },
      at,
      dataDir,
    );
    ids.push(action.action_id);
  }
  return { archived: true, archive_path: rel, action_ids: ids };
}

/** 归档位置（只读口 / 测试用） */
export function archivedChatPath(chatFile: string): string {
  return path.join(path.dirname(chatFile), "archive", path.basename(chatFile));
}
