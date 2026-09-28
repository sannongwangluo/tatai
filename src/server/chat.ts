// C2：聊天记录落盘（DESIGN.md §2.3.6 / §3.6 Flash 聊天）。
// 每个项目 `<项目根>/.工作台/chat/<sessionId>.jsonl`，一行一条消息：
//   user 行      {"role":"user","content":"…","ts":"本地ISO带偏移"}
//   assistant 行 {"role":"assistant","content":"…","ts":"…","model":"<模型id>"}
//
// 实时落盘红线（§3.6「聊天记录实时落盘」）：本层只做同步 append——
// user 行在发问时写，assistant 行在流式收齐后由 HTTP 层写完整 content + model，
// 不存在"退出才写"的缓冲路径。
//
// 路径安全红线：本层所有公开函数只收项目 id + sessionId。项目根路径一律走注册表
// （workstationDir → getProject），sessionId 只接受 [0-9A-Za-z_-]，含 `/`、`\`、`.`、
// 百分号等一律 INVALID_INPUT——伪造 sid（如 `../x`、`..%2Fx`）在拼路径之前就被拦下。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { appendJsonlLine, iterFileLines, warnCorruptLinesThrottled } from "./lineStream";
import { toIso } from "./time";
import { archiveChatSession } from "./work/chatActions";
import { WsError, workstationDir } from "./workstation";

/** chat/<session>.jsonl 一行（DESIGN.md §2.3.6；assistant 行必须带 model）
 *  Q34（2026-09-18 审计）：assistant 行多一个**可选** `error`——流失败时也把这一回合如实落盘
 *  （content = 失败前已收到的半截，可能为空；error = 脱敏后的失败原因）。不落这一行的话，
 *  会话记录里只剩"问了没答"，事后分不清是模型拒绝、配置缺失还是网络中断。 */
export type ChatLine =
  | { role: "user"; content: string; ts: string }
  | { role: "assistant"; content: string; ts: string; model: string; error?: string };

/** 会话列表条目：按最后写入时间倒序，带首条消息摘要 */
export interface ChatSessionSummary {
  session_id: string;
  message_count: number;
  /** 首条消息摘要（单条消息首行，截断 60 字）；空会话为 null */
  first_message: string | null;
  created_at: string;
  /** 最后写入时间（本地 ISO 带偏移），列表按它倒序 */
  updated_at: string;
}

const CHAT_DIR = "chat";
const SESSION_FILE_EXT = ".jsonl";
/** sessionId 合法字符集：不含路径分隔符与点，防路径穿越（生成与校验共用同一口径） */
const SESSION_ID_RE = /^[0-9A-Za-z_-]+$/;
const FIRST_MESSAGE_MAX = 60;

/** sessionId 校验：非法（含路径穿越形态）抛 INVALID_INPUT，在拼路径之前调用 */
export function assertSessionId(sessionId: string): void {
  if (typeof sessionId !== "string" || !SESSION_ID_RE.test(sessionId)) {
    throw new WsError(
      "INVALID_INPUT",
      `非法 sessionId: ${JSON.stringify(sessionId)}（只接受字母/数字/-/_，路径穿越一律拒绝）`,
    );
  }
}

/** 生成 sessionId：本地时间戳（yyyymmdd-hhmmss）+ 8 位十六进制随机，全部落在合法字符集内 */
export function newSessionId(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `${stamp}-${crypto.randomBytes(4).toString("hex")}`;
}

/** 项目 id → `<项目根>/.工作台/chat/`（项目根只走注册表） */
export function chatDir(projectId: string, dataDir?: string): string {
  return path.join(workstationDir(projectId, dataDir), CHAT_DIR);
}

function sessionPath(projectId: string, sessionId: string, dataDir?: string): string {
  assertSessionId(sessionId);
  return path.join(chatDir(projectId, dataDir), `${sessionId}${SESSION_FILE_EXT}`);
}

function statIso(ms: number): string {
  return toIso(new Date(ms));
}

/** 创建会话：建 `<项目根>/.工作台/chat/` 目录 + 空的 `<sessionId>.jsonl`，返回 sessionId */
export function createSession(projectId: string, dataDir?: string): string {
  const sessionId = newSessionId();
  const file = sessionPath(projectId, sessionId, dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // 建会话即分文件（PLAN.md C2 DoD②：两个会话就是两个 jsonl 文件，不等首条消息）
  fs.writeFileSync(file, "", "utf8");
  return sessionId;
}

/** 删除会话的回执（V06-07）：有有效引用的会话转归档，内容与引用都不失效 */
export interface DeleteSessionResult {
  /** true = 被动作有效引用，已转归档（内容保留，动作记录里的引用仍可核实） */
  archived: boolean;
  /** 归档到的**项目根内相对路径**（未归档为 null） */
  archive_path: string | null;
  /** 引用它的动作 id（归档原因要说清"谁还在引用"） */
  action_ids: string[];
}

/**
 * 删除会话（§3.6）：**没有有效引用**的普通聊天照旧删除（不可恢复）；
 * **有有效引用**的会话转归档——`chat/<sid>.jsonl` 挪到 `chat/archive/`（内容一字不改），
 * 引用它的动作记录留痕（`archived` + 归档位置），删除行为如实说明。
 * 会话不存在抛 SESSION_NOT_FOUND（与 readSession 同口径）。
 */
export function deleteSession(projectId: string, sessionId: string, dataDir?: string): DeleteSessionResult {
  const file = sessionPath(projectId, sessionId, dataDir); // assertSessionId 在拼路径之前拦穿越
  if (!fs.existsSync(file)) {
    throw new WsError("SESSION_NOT_FOUND", `会话不存在: ${sessionId}`);
  }
  const archived = archiveChatSession(
    projectId,
    sessionId,
    { chatFile: file, reason: "用户删除会话，但仍有动作记录引用它（保留引用，转而归档）" },
    dataDir,
  );
  if (archived.archived) return archived;
  fs.unlinkSync(file);
  return { archived: false, archive_path: null, action_ids: [] };
}

/**
 * 追加一条消息（实时落盘：同步 append，无缓冲）。会话不存在抛 SESSION_NOT_FOUND。
 * user 行由调用方在发问时写；assistant 行由调用方在流式收齐后写（content 全文 + model）。
 */
export function appendMessage(
  projectId: string,
  sessionId: string,
  msg: ChatLine,
  dataDir?: string,
): void {
  const file = sessionPath(projectId, sessionId, dataDir);
  if (!fs.existsSync(file)) {
    throw new WsError("SESSION_NOT_FOUND", `会话不存在: ${sessionId}`);
  }
  // Q136（2026-09-19 审计）：走 `appendJsonlLine`——文件尾部若留着半截行（上次写到一半被 kill，
  // 或流式回合中途断电），裸 appendFileSync 会把新消息粘在残尾后面一起变坏行：之后**每条新消息
  // 都丢**（读侧拒读整份、写侧继续往残尾后接）。封口口径见 lineStream.ts。
  appendJsonlLine(file, JSON.stringify(msg));
}

/** 校验一行 jsonl 是否符合 §2.3.6（user: role/content/ts；assistant: 另含 model） */
function validateChatLine(raw: unknown, ctx: string): ChatLine {
  const l = raw as ChatLine;
  if (
    typeof l !== "object" ||
    l === null ||
    (l.role !== "user" && l.role !== "assistant") ||
    typeof l.content !== "string" ||
    typeof l.ts !== "string"
  ) {
    throw new WsError(
      "CHAT_JSONL_CORRUPT",
      `${ctx} 字段不符合 DESIGN.md §2.3.6（role/content/ts，assistant 行含 model）`,
    );
  }
  if (l.role === "assistant" && typeof l.model !== "string") {
    throw new WsError("CHAT_JSONL_CORRUPT", `${ctx} assistant 行缺 model 字段（§2.3.6）`);
  }
  if (l.role === "assistant" && l.error !== undefined && typeof l.error !== "string") {
    throw new WsError("CHAT_JSONL_CORRUPT", `${ctx} assistant 行的 error 字段必须是字符串（Q34 失败行）`);
  }
  return l;
}

/**
 * 读回会话全文（jsonl → 消息数组，供续接上下文）；会话不存在抛 SESSION_NOT_FOUND。
 *
 * Q136（2026-09-19 审计）：此前任一行损坏即整份拒读（抛 `CHAT_JSONL_CORRUPT` 带行号）——而续聊是
 * **先 appendMessage 再 readSession**（index.ts 的聊天路由）：一旦会话文件里出现半截行，此后每条
 * 新消息都会在写入后被这次读拒掉（400），而每试一次文件里又多一行——会话彻底用不了且没有修复入口。
 * 现与 changes.jsonl 的 Q32 口径对齐：**跳过坏行、其余照常读出** + 限频告警，续聊恢复正常。
 * 读路径只读不修（不为修文件写盘）。
 */
export function readSession(
  projectId: string,
  sessionId: string,
  dataDir?: string,
): ChatLine[] {
  const file = sessionPath(projectId, sessionId, dataDir);
  if (!fs.existsSync(file)) {
    throw new WsError("SESSION_NOT_FOUND", `会话不存在: ${sessionId}`);
  }
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  const out: ChatLine[] = [];
  let bad = 0;
  let firstBad = "";
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i].trim();
    if (text === "") continue;
    const where = `chat/${sessionId}.jsonl 第 ${i + 1} 行`;
    let parsed: ChatLine | null = null;
    let reason = "";
    try {
      parsed = validateChatLine(JSON.parse(text), where);
    } catch (e) {
      reason = (e as Error).message;
    }
    if (parsed === null) {
      bad++; // 坏行跳过（Q136）：不因为一行半截让整个会话永久打不开
      if (firstBad === "") firstBad = reason;
      continue;
    }
    out.push(parsed);
  }
  if (bad > 0) {
    warnCorruptLinesThrottled(
      `chat:${projectId}:${sessionId}`,
      `[chat] 会话 ${sessionId}（项目 ${projectId}）有 ${bad} 行坏行（首处：${firstBad}）` +
        "——已跳过这些行、其余照常读出；最常见成因是落盘写到一半被 kill 留下的半截行（读路径只读不修）",
    );
  }
  return out;
}

/**
 * 列出会话：按最后写入时间倒序，带首条消息摘要与消息数。
 * 没有 chat/ 目录时返回空数组（正常空态，不是错误）。
 *
 * Q46（2026-09-18 审计）：此前 `message_count` 只为数行数就把每个会话文件**整份读进内存**再
 * `split`（会话文件没有单文件上限、会话数也没有上限，且这个函数在切项目、每次发完消息后都会调）——
 * 现在逐行流式数（`iterFileLines`，内存 = 一块 + 一行的残片），只留**首行原文**用来取摘要。
 */
export function listSessions(projectId: string, dataDir?: string): ChatSessionSummary[] {
  const dir = chatDir(projectId, dataDir);
  if (!fs.existsSync(dir)) return [];
  const out: { summary: ChatSessionSummary; mtimeMs: number }[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(SESSION_FILE_EXT)) continue;
    const sessionId = name.slice(0, -SESSION_FILE_EXT.length);
    // 目录里混进不合规文件名（如手工放的 ../x.jsonl 残骸）直接跳过，不读
    if (!SESSION_ID_RE.test(sessionId)) continue;
    const file = path.join(dir, name);
    const stat = fs.statSync(file);
    if (!stat.isFile()) continue;
    let count = 0;
    let firstLine: string | null = null;
    for (const raw of iterFileLines(file)) {
      const text = raw.trim();
      if (text === "") continue;
      count++;
      if (firstLine === null) firstLine = text; // 摘要只要首行，其余行读完即弃
    }
    let firstMessage: string | null = null;
    if (firstLine !== null) {
      try {
        const first = JSON.parse(firstLine) as { content?: unknown };
        if (typeof first.content === "string") {
          const oneLine = first.content.replace(/\s+/g, " ").trim();
          firstMessage =
            oneLine.length > FIRST_MESSAGE_MAX
              ? oneLine.slice(0, FIRST_MESSAGE_MAX) + "…"
              : oneLine;
        }
      } catch {
        firstMessage = null; // 首行损坏不阻塞列表，摘要保持 null
      }
    }
    out.push({
      summary: {
        session_id: sessionId,
        message_count: count,
        first_message: firstMessage,
        created_at: statIso(stat.birthtimeMs),
        updated_at: statIso(stat.mtimeMs),
      },
      mtimeMs: stat.mtimeMs,
    });
  }
  // 按最后写入时间倒序；mtime 相同时按 sessionId 倒序（时间戳前缀大的新）兜底
  out.sort((a, b) =>
    b.mtimeMs - a.mtimeMs ||
    b.summary.session_id.localeCompare(a.summary.session_id),
  );
  return out.map((o) => o.summary);
}
