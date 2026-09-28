import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import {
  RegistryRecoveryInputError,
  RegistryStateError,
  getProject,
  listProjects,
  recoverRegistry,
  removeProject,
  resolveDataDir,
  setProjectDocumentPaths,
  touchLastOpened,
} from "./registry";
import { closeBackendLog, teeBackendLog } from "./backendLog";
import {
  AuthError,
  AuthService,
  PUBLIC_PATHS,
  READ_ONLY_EXEMPT_PATHS,
  SESSION_ID_PREFIX,
  SHELL_ORIGINS,
  authRejectStatus,
  credentialFromHeader,
  guardRemoteRequest,
  permissionHint,
  requestPathOf,
  type GuardResult,
} from "./auth";
import {
  RemoteConfigError,
  REMOTE_CHAT_ENV,
  REMOTE_HOST_ENV,
  REMOTE_MEMORY_ENV,
  assertBindHostnameSafe,
  isPublicBindAddress,
  lanAddresses,
  resolveRemoteConfig,
} from "./remote-config";
import { sanitizeErrorMessage } from "./redact";
import { AuditPathError, RemoteAuditLog, actionOfRequest, credentialKindOf, projectIdOfPath } from "./remote-audit";
import { WriteModeController } from "./remote-write";
import { remotePageHtml } from "./remote-page";
import { createWorkHost } from "./workHost";
import { readServiceDescriptor, WORK_TOKEN_HEADER } from "./work/service";
import { onboardProject } from "./onboard";
import { requestScanCancel, scanProjectAsync } from "./scanner";
import { sweepAllTmpResidue } from "./tmpSweep";
import { readModules, startParseProjectRun, requestParseCancel, getParseRunStatus } from "../arch/parse";
import { nameModules } from "../arch/name";
import { dataFlowLayerOf, renderGraph } from "../arch/render";
import { expandProject } from "../arch/expand";
import { readLastReconcile, reconcileProject } from "../arch/reconcile";
import {
  archProvenanceModelOf,
  draftBlueprintOf,
  planVsCode,
  readBlueprint,
  readBlueprintReceipt,
  rebuildBlueprint,
  viewGraphWithPlan,
} from "../arch/blueprint";
import {
  recordExplicitSemanticResult,
  semanticStateOf,
  triggerBlueprintAuto,
} from "../arch/blueprintAuto";
import { readLayout, savePositions, LAYOUT_MIGRATION_MODE, isLayoutMode, type NodePosition } from "../arch/layoutStore";
import { readFold, saveFold } from "../arch/foldStore";
import type { GraphMode } from "../arch/graph-mode";
import { queryMemory } from "./memory";
import { draftDesign, finalizeDraft, readReverseDraft, readReversePlanDraft } from "./reverseDraft";
import {
  chatStream,
  chatWithContinue as flashChat,
  DEFAULT_MODEL,
  type FlashMessage,
  type FlashRoundMessage,
} from "./flash";
import {
  appendMessage,
  createSession,
  deleteSession,
  listSessions,
  readSession,
  type ChatLine,
} from "./chat";
// 2026-09-19 试用增强：聊天背景材料（设计书/进度/Gate/动作流/架构顶层模块现读拼装）
import { buildChatContext } from "./chatContext";
// 试用增强二期/三期：工具调用循环抽到 chatTurn（MCP ask_flash 同一个循环，§6.4）
import { runChatTurn } from "./chatTurn";
import { nowIso, latestByTime, compareIsoTime } from "./time";
import { listAgents } from "./agents";
import {
  closeAllWatchers,
  listWatchDetails,
  listWatching,
  onProjectChange,
  queryChanges,
  readChanges,
  unwatchProject,
  watchProject,
} from "./watcher";
// V09-07（附录 E.8）：源变化发现链——watch 落地即挂、unwatch/退出即摘（模块本体在 work/graphRefresh.ts）
// V09-12：`graphUpdateOf` = 该链的更新状态读口（GET arch/blueprint 的 `update` 字段，只读）
import { graphUpdateOf, startGraphRefresh, stopAllGraphRefresh, stopGraphRefresh } from "./work/graphRefresh";
import { queryGlobalChanges } from "./global-changes";
import { getLive } from "./live";
import { summarizeAllProjects } from "./summary";
import {
  assertTerminalSession,
  closeAllTerminals,
  closeProjectTerminals,
  closeTerminal,
  createTerminalSession,
  listTerminalSessions,
  onTerminalData,
  onTerminalExit,
  resizeTerminal,
  terminalSessionCount,
  writeTerminal,
} from "./pty";
import {
  clearTerminalHistory,
  DEFAULT_HISTORY_LIMIT,
  MAX_HISTORY_LIMIT,
  queryTerminalHistory,
} from "./terminalHistory";
import {
  addModule,
  addTask,
  appendDesign,
  appendDiscuss,
  listTasks,
  readDesign,
  readDiscuss,
  readGateLines,
  readProgressReportingInit,
  recordGateTransition,
  setCurrentStep,
  setModuleStatus,
  setTaskStatus,
  WsError,
  projectWorkDir,
  type DesignAppendResult,
  type ModuleStatus,
  type TaskStatus,
} from "./workstation";
// V06-02：两份图纸的版本与审定（唯一当前源解析 / 章节差异 / 不可变历史 / 双版本激活）。
// 路由只暴露读写入口，不新增 UI；四条路由同步登记在 remote-routes.ts。
import {
  activateBaseline,
  activeBaseline,
  BASELINES_FILE,
  diffRevisionsByHash,
  loadDocument,
  planStructure,
  preserveDocumentRevision,
  projectWorkbenchDir,
  readBaselineLog,
  WORKBENCH_DIRNAME,
  type ActivateBaselineInput,
  type DocumentKind,
} from "./work/documents";
import { isWorkError, type WorkErrorCode } from "./work/types";
// V06-08：施工图定义 + 运行状态（定义与状态分开给，界面不合并成"完成度"）与待议处置记录。
// C-015 接线：本服务唯一的图纸导入点走受检导入（references.ts），与正式提交路径同一份引用判据
import { taskDefinitionHash } from "./work/plan";
import { importPlanChecked } from "./work/references";
import { alignDefinitionsAndStates, readTaskStates } from "./work/tasks";
import { readAuditRecords, submitHumanAcceptance } from "./work/audit";
import {
  DECISIONS_FILE,
  appendDecision,
  deriveDispositions,
  discussionEntriesOf,
  discussionRefKey,
  readDecisions,
  relatedImplementationOf,
  validateDecisionInput,
} from "./work/decisions";
// V06-09：证据/审计/状态投影（只读入口两条，同步登记在 remote-routes.ts）。
// 状态纯由事实算出（§4.2），这里只做"读现场 → 派生 → 回传"，一个字节都不写。
import { evidenceManifest, findingLedger, sha256Hex } from "./work/evidence";
// C017（2026-09-21 契约对齐登记）：用量统计只读派生（认领额度＝运营节流口径、事件流可核对耗时、
// Token/金额缺来源如实「未计量」）。路由同步登记在 remote-routes.ts。
import { buildProjectUsage } from "./work/usage";
// V09-06：私有事实备份/恢复的**产品入口**（§8.5 / §12.2 末行）。语义复用 V06-14 的 `backup.ts`，
// 本模块只补落点策略 / 幂等 / 失败分类；四条路由登记在 remote-routes.ts（防漂移锚点）。
import {
  backupEntryStatus,
  createBackupEntry,
  inspectBackupEntry,
  isBackupEntryError,
  listBackupEntries,
  restoreBackupEntry,
} from "./work/backupEntry";
// V06-12：Git 保存版本提醒的**只读**探测与提醒派生（§3.15）。整条链只读，见 gitStatus.ts 文件头。
import { buildVersionReminder, inspectGitStatus } from "./gitStatus";
import { buildAuditPackage, buildSpotCheckPackage, checkAuditChain } from "./work/audit";
// 补修包 F：项目可体验运行入口（§3.7）。登记落在成果登记里（`audit.submission_submitted`），
// 读取从权威事实装配——纯口径在 `work/runtimeEntries.ts`，本文件只做接线（不另立一套状态）。
import {
  RUNTIME_ENTRY_REVIEW_MS,
  runtimeEntrySummaryOf,
  runtimeEntryViews,
  type RuntimeEntrySource,
  type RuntimeEntryView,
} from "./work/runtimeEntries";
import {
  acceptanceDimensionOf,
  checksFromAudit,
  collectProjectFacts,
  dependencyRelease,
  objectsFromFacts,
  projectStatuses,
  requiredChecksFromDefinitions,
  v1ModuleStatusOf,
} from "./work/statusProjection";
// V06-07：聊天动作与可追溯回执（§3.5–§3.6）。修订动作**不在本文件里长**——本文件只做接线：
// 意图 → 动作 → SSE 回执 + 三条只读/审定路由；动作的语义、落盘与红线全在 work/chatActions.ts。
import {
  actionStatusLabel,
  activateChatActionProposal,
  appendChatActionReceipt,
  CHAT_ACTION_STATUS_LABELS,
  chatActionViewOf,
  classifyChatIntent,
  getChatAction,
  listChatActions,
  retryChatAction,
  runChatAction,
  type ChatAction,
  type ChatSelection,
} from "./work/chatActions";

// 后端骨架（R1）：只用 node:http，不引清单外框架。端口 8787，起法：pnpm dev:server
const PORT = Number(process.env.TATAI_PORT ?? 8787);

// U2：打包态（桌面壳 release 分支置 TATAI_LOG_TO_FILE=1）把 stdout/stderr 再抄一份到
// <全局数据目录>/logs/backend.log——GUI 子系统双击启动没有控制台，日志否则凭空消失。
// dev 不置位 → 本行返回 null，行为与 U2 之前逐字相同（副本不改变 stdout 内容）。
// 落盘位置口径与理由全在 backendLog.ts。
// Q130（2026-09-19 审计）：本行在模块顶层、listen 之前——`teeBackendLog` 内部已把目录/开文件整段收在
// try 里（写不进去只打一行并返回 null），日志目录不可用不再让后端"零输出 DOA"。
const backendLogFile = teeBackendLog();

// ══ 三期 S1：远程访问安全红线（PLAN.md S1 卡；红线依据 DESIGN.md §1.4「本期不做远程」= 解锁前非目标、
// §10.2 私人数据隔离；口径变更登记在 DESIGN.md 附录 B）══
// 九条红线的唯一事实源是 `remote-config.ts`：这里只做两件事——启动期 fail-fast（违规即拒绝启动，
// 不"先起来再说"）+ 每个请求进路由前过一遍 `auth.ts` 的放行口。默认（无环境变量）行为 = 只绑回环、
// 零外部监听、连口令文件都不生成。
const remoteConfig = (() => {
  try {
    return resolveRemoteConfig(process.env);
  } catch (e) {
    if (e instanceof RemoteConfigError) {
      console.error(`[tatai-server] 启动被安全红线拦下 [${e.code}] ${e.message}`);
      console.error(`[tatai-server] 提示：${e.hint}`);
      return process.exit(1);
    }
    throw e;
  }
})();

/** 鉴权服务（默认关闭远程时为 null：不开远程就一个字节的口令都不落盘） */
const authService = remoteConfig.enabled
  ? new AuthService({
      dataDir: resolveDataDir(),
      tokenTtlMs: remoteConfig.tokenTtlMs,
      sessionTtlMs: remoteConfig.sessionTtlMs,
    })
  : null;

// ══ 三期 S3：访问审计 + 写模式运行期状态（PLAN.md S3 卡 DoD①②③）══
// 审计落点 = `<全局数据目录>/logs/remote-audit.jsonl`（DESIGN.md §8.1 第一层全局层；<全局数据目录> = `TATAI_HOME` > 缺省 `~/.tatai/`）——
// 绝不进任何被纳管项目、绝不进仓库（`RemoteAuditLog` 构造时若发现落点在 repo 内直接拒启动，
// 见 remote-audit.ts 的 AuditPathError）。**远程没开就不建这份文件**（默认零副作用，与"不开远程不落口令"同口径）。
// 写模式的两个乘数：启动期双开关（armed，红线④）+ 主机上的开关文件（运行期，`pnpm remote:write on|off`）——
// 生效值由 `WriteModeController` 每请求现算，所以关掉写模式**下一个写请求**就吃 403，不必重启。
const DATA_DIR = resolveDataDir();

// ── V06-07：聊天动作的三个接线小件（语义都在 work/chatActions.ts）──

/** body.selection → 选中对象（形状不合法一律当"没选"；不因为脏输入吞掉用户的意见表达） */
function normalizeChatSelection(raw: unknown): ChatSelection | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const kinds = ["capability", "module", "task", "concept"] as const;
  const kind = kinds.find((k) => k === r.kind);
  const id = typeof r.id === "string" ? r.id.trim() : "";
  if (kind === undefined || id === "") return null;
  return { kind, id, name: typeof r.name === "string" ? r.name : null };
}

/** 动作 → SSE 事件体：直接复用服务端同一份视图映射（文案来自回执，前端不猜） */
const chatActionEventOf = chatActionViewOf;

/** 动作结果说给模型听（在动作**真实回执**之上说，不让模型凭想象讲"已生效"） */
function actionNoteOf(action: ChatAction | null): string {
  if (action === null) return "";
  const receipts = action.tool_receipts.map((r) => `- ${r.tool}：${r.ok ? "成功" : "失败"}｜${r.summary}`).join("\n");
  return (
    "\n\n【本轮动作回执（服务器落盘，不是你的推测）】\n" +
    `动作 ${action.action_id}（${action.kind}）当前：${actionStatusLabel(action)}（status=${action.status}）。\n` +
    `${receipts}\n` +
    (action.error === null ? "" : `失败原因：${action.error.message}\n`) +
    "（只有 applied 才代表已写盘生效；review_needed 只是待审定。回答里不要把它说成已完成。）"
  );
}

/** V06-07：本轮模型工具调用与动作关联落盘（只写动作记录；失败不影响聊天） */
function associateTurnTools(
  projectId: string,
  action: ChatAction | null,
  tools: { name: string; summary: string; writes: { path: string; affected_ids: string[] }[] }[],
): void {
  if (action === null || tools.length === 0) return;
  try {
    const writes = tools.flatMap((t) => t.writes);
    const counts = new Map<string, number>();
    for (const t of tools) counts.set(t.name, (counts.get(t.name) ?? 0) + 1);
    appendChatActionReceipt(projectId, action.action_id, {
      tool: "chat_tools",
      ok: true,
      write: writes.length > 0,
      summary:
        `本轮模型调用工具 ${tools.length} 次：${[...counts].map(([n, c]) => `${n}×${c}`).join("、")}` +
        (writes.length > 0 ? `；真实写入 ${writes.map((w) => w.path).join("、")}` : ""),
      affected_ids: writes.flatMap((w) => w.affected_ids),
      detail: { calls: tools.map((t) => ({ name: t.name, summary: t.summary })), writes },
    });
  } catch {
    /* 关联落盘失败不改变聊天结果 */
  }
}
const auditLog: RemoteAuditLog | null = (() => {
  if (!remoteConfig.enabled) return null;
  try {
    return new RemoteAuditLog({ dataDir: DATA_DIR, repoRoot: process.cwd() });
  } catch (e) {
    if (e instanceof AuditPathError) {
      console.error(`[tatai-server] 启动被安全红线拦下 [AUDIT_PATH_FORBIDDEN] ${e.message}`);
      return process.exit(1);
    }
    throw e;
  }
})();
const writeMode = new WriteModeController({
  dataDir: DATA_DIR,
  startupEnabled: remoteConfig.writeEnabled,
  audit: auditLog,
});

/**
 * 分页参数字面校验（H3 起口径，P3 全局流共用）：非负数字，否则 400 INVALID_INPUT。
 * 缺失返回 undefined（调用方各自决定缺省值）。
 */
function nonNegParam(params: URLSearchParams, name: string): number | undefined {
  const raw = params.get(name);
  if (raw === null) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new WsError("INVALID_INPUT", `${name} 必须是非负数字: ${JSON.stringify(raw)}`);
  }
  return n;
}

/** JSON body 上限（字节）；按字节判而不是按字符数，中文体积口径才准 */
const MAX_JSON_BODY_BYTES = 1024 * 1024;

/** 读 JSON body；超限/非法 JSON 时 reject，不抛裸栈 */
function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    // Q60（2026-09-18 审计）：原先逐块 `chunk.toString("utf8")` 再拼字符串——`toString` 是**独立**
    // 解码、不携带跨块状态，一个汉字（3 字节）正好跨 TCP 读块时两半各解成 U+FFFD，改完仍是合法
    // JSON，静默损坏且无人能察觉。改为收字节、结束时一次解码（与 flash.ts 的 TextDecoder 流式口径
    // 同效，这里一次性解码更简单）；上限顺势按**字节**判。
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      size += chunk.length;
      if (size > MAX_JSON_BODY_BYTES) {
        reject(new Error("请求体过大"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text === "" ? {} : JSON.parse(text));
      } catch {
        reject(new Error("请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

/**
 * 路径段解码（Q57，2026-09-18 审计）：畸形百分号编码（一条 `%`、`%ZZ`）会让 `decodeURIComponent`
 * 抛 `URIError`。裸调点摆在 handler 顶层时，异常直达 `uncaughtException → process.exit(1)`
 * ——一条畸形 URL 就能把整个后端打掉（审计实测 `/api/projects/%/memory` 即复现）。
 * 全文件 52 处路径段解码统一走这里：解不开就抛 `INVALID_INPUT`，由各自路由的 catch、
 * `withWs` 或 createServer 的顶层兜底（Q39）收成结构化 400，进程照常服务。
 */
function decodePathSegment(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new WsError("INVALID_INPUT", `路径里的百分号编码不合法: ${JSON.stringify(raw)}`);
  }
}

/**
 * U1：桌面壳的 origin 白名单（Tauri v2 在 Windows 上是 http(s)://tauri.localhost，其余平台 tauri://localhost）。
 * 命中才挂 CORS 头并返回 true；普通浏览器请求（无 Origin 或非同源）一律不受影响。
 * F1（2026-09-18 审计）起常量本体搬到 auth.ts（与放行口 Origin 闸同一份，单一出处），这里只消费。
 */
function applyShellCors(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const origin = req.headers.origin;
  if (typeof origin !== "string" || !SHELL_ORIGINS.includes(origin)) return false;
  res.setHeader("access-control-allow-origin", origin);
  // Q35（2026-09-18 审计）：allow-methods 漏了 PUT——壳里两处 PUT（arch/layout 拖动写回、
  // arch/mindmap-fold 折叠态）带 JSON body，属非简单请求，必先预检；预检不过浏览器就不发真请求，
  // 于是拖动与折叠静默写不进（前端两处 .catch(() => {}) 把失败吞了）。方法表与下面的路由一一对齐。
  res.setHeader("access-control-allow-methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");
  res.setHeader("vary", "origin");
  return true;
}

/**
 * 「只传必要数据」（PLAN.md S2 DoD④ + S3 补齐）：非回环来源的读响应里不下发**本机绝对路径**。
 *
 * S2 的口径是"删三个键"（`path` / `source` / `data_dir`，最多两层）；S3 把键名单扩到九个，
 * 并只在"**键名在名单里、值又是本机绝对路径**"时才删——因为同名键在不同接口里既可能是绝对路径、
 * 也可能是界面要显示的**项目内相对路径**（`render.graph.nodes[].path` / `changes[].path` /
 * `docs[].path`），按 S2 的"只有键名对就删"会误删整块界面。
 *
 * Q74（2026-09-18 审计）：键名单 + 两层深度上限留了两个绕过口——`{files:["C:\\…"]}` 这种把绝对路径
 * 放进**纯字符串数组**（元素不是对象，永远到不了键判定）；以及任何深度 >2 的结构（`depth < 0`
 * 原样返回）。现在改为**纯值判定、不设深度**：任意键、任意深度、数组元素，只要字符串本身是本机
 * 绝对路径就裁掉（对象键整条删、数组元素过滤掉）。相对路径照旧原样保留，本机回环来源行为逐字不变
 * （`remote=false` 直接原样返回），所以本地 UI 与既有验证脚本零影响。
 */
/** 本机绝对路径判定（Windows `C:\…` / UNC `\\…`、POSIX `/…`）——只看值，不看键名。
 *  额外排除**多行文本与超长字符串**：那种值不是"一个路径"，而是正文（设计书/聊天/变更摘要
 *  恰好以盘符或 `/` 起笔）；按"路径"整条裁掉会把内容误删，故只认单行、≤ 260 字符（Windows
 *  MAX_PATH 量级）的短字符串。 */
function isLocalAbsolutePath(v: unknown): boolean {
  if (typeof v !== "string" || v === "") return false;
  if (v.length > 260 || /[\r\n]/.test(v)) return false;
  return /^[A-Za-z]:[\\/]/.test(v) || v.startsWith("\\\\") || v.startsWith("/");
}

function withoutLocalPaths<T>(value: T, remote: boolean): T {
  if (!remote || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value
      .filter((v) => !isLocalAbsolutePath(v))
      .map((v) => withoutLocalPaths(v, remote)) as unknown as T;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (isLocalAbsolutePath(v)) continue;
    out[k] = withoutLocalPaths(v, remote);
  }
  return out as unknown as T;
}

// ── 资源回收（2026-09-18 审计补，DELETE /api/projects/:id 用）─────────────────────────
// 有界等待：回收卡住不拖死删除响应；超时/失败如实回 fallback + timedOut，不抛（调用方只记日志）。
// Q52（2026-09-18 审计）：失败这一支原先连**错误**一起吞掉，catch 里的 released 与"本来就没东西
// 可回收"逐字同形（watch:false / terminals:0 / timedOut:false）——删除响应看着像一切正常。
// 现在把回收动作自己抛的错（脱敏后）带成 `error`、汇总成 `errors`，客户端能分辨"没东西可收"与"没收成"。
const RELEASE_TIMEOUT_MS = 2000;

interface TimedResult<T> {
  value: T;
  timedOut: boolean;
  /** 回收动作自己抛错时的脱敏文案；正常返回/超时均为 null */
  error: string | null;
}

function timed<T>(p: Promise<T>, fallback: T, ms = RELEASE_TIMEOUT_MS): Promise<TimedResult<T>> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ value: fallback, timedOut: true, error: null });
    }, ms);
    timer.unref();
    p.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ value, timedOut: false, error: null });
      },
      (e: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          value: fallback,
          timedOut: false,
          error: sanitizeErrorMessage((e as Error)?.message ?? String(e)),
        });
      },
    );
  });
}

/** 停该项目监听（先把已排队变更刷完盘）+ 杀该项目全部终端会话（复用 watcher/pty 既有清理函数） */
async function releaseProjectResources(
  id: string,
): Promise<{ watch: boolean; terminals: number; timedOut: boolean; errors: string[] }> {
  const watch = await timed(unwatchProject(id), false);
  const terminals = await timed(closeProjectTerminals(id), 0);
  return {
    watch: watch.value,
    terminals: terminals.value,
    timedOut: watch.timedOut || terminals.timedOut,
    errors: [watch.error, terminals.error].filter((m): m is string => m !== null),
  };
}

/** WsError 的 code → HTTP 状态码（`wsFail` 与 createServer 的顶层兜底共用同一份口径） */
function wsErrorStatus(code: string): number {
  if (code === "PROJECT_NOT_FOUND" || code === "SESSION_NOT_FOUND") return 404;
  return 400;
}

/**
 * v2 事实错误码 → HTTP 状态码（PLAN.md V06-02 的图纸/基线路由用；与 `docs/work-v2-contract.md`
 * 的错误表同一口径：409 是"你手里的版本旧了"，503 是"写入服务不在"，其余按入参错/内部错分）。
 */
function workErrorStatus(code: WorkErrorCode): number {
  if (code === "VERSION_CONFLICT" || code === "IDEMPOTENCY_CONFLICT") return 409;
  if (code === "SERVICE_UNAVAILABLE") return 503;
  if (code === "PROJECTION_FAILED" || code === "MIDDLE_CORRUPT" || code === "EVENT_INVALID") {
    return 500;
  }
  return 400;
}

/**
 * 补修包 F：一条任务的"结果入口"一句话口径（§3.7）。
 *   · 该任务的成果登记里没有入口 → 如实说"尚不可体验"（**不是**加载失败，也**不是**已验证通过）；
 *   · 有在有效期内的可打开入口 → 给 **第一个** 地址（受控打开的落点由界面再判协议白名单）；
 *   · 登记过但当前都不可打开（探测失败/过期/未知）→ **说明状态**，不静默消失（§3.7）。
 */
function taskResultEntry(views: readonly RuntimeEntryView[]): {
  kind: "available" | "stale" | "unavailable";
  url: string | null;
  note: string;
} {
  if (views.length === 0) {
    return {
      kind: "unavailable",
      url: null,
      note:
        "尚不可体验：这条任务的成果没有登记过可打开的运行入口（§3.7）。" +
        "塔台不执行外部命令、不跑任意协议；打开入口也不等于用户验收接受（§5.8）。",
    };
  }
  const openable = views.find((v) => v.openable) ?? null;
  if (openable !== null) {
    const due =
      openable.state === "reverify_due"
        ? "（注意：该入口待重新验证——验证时间已超过复查提醒阈值，入口仍可打开，只是该再确认一次）"
        : "";
    const outdated =
      openable.revision_state === "outdated"
        ? "（版本提示：这条入口绑定的成果版本已不是当前版本，入口仍可打开但对应的是旧版本）"
        : "";
    return {
      kind: "available",
      url: openable.url,
      note:
        `可体验入口：${openable.scenario}（来源 ${openable.source_kind === "submission" ? "成果登记" : "结果回报"} ${openable.source_record_id}` +
        (openable.source_revision === null ? "" : ` · ${openable.source_revision_kind ?? "修订"} ${openable.source_revision.slice(0, 12)}…`) +
        ` · ${openable.verified_at} 实测可打开）${due}${outdated}。打开入口不等于用户验收接受（§5.8）。`,
    };
  }
  const kinds = views.map((v) => `${v.state}${v.revision_state === "outdated" ? "+outdated" : ""}`).join("/");
  return {
    kind: "stale",
    url: null,
    note: `登记过 ${views.length} 条运行入口，但当前都不可打开（${kinds}）：逐条状态见「可体验运行入口」，不静默消失（§3.7）。`,
  };
}

/**
 * 请求处理主链：一个后端进程里唯一的 HTTP 入口（路由分发全在这里）。
 * 顶层兜底不写在这里，而在下方 `createServer` 的回调里——见 Q39 的注释。
 */
function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  // ── API 响应一律禁缓存（2026-09-19 主人试用报障：设计书已改、界面疑似命中 WebView 缓存显示旧文）。
  // 本地实时数据（列表/设计书/进度/架构图）缓存零收益，只有"看到旧数据"的坏处；SSE 流同样无害。
  res.setHeader("cache-control", "no-store");
  // ── 三期 S1 放行口：先鉴权，后路由（顺序本身就是红线：不给"先能连上、安全后补"的缝）──
  // 本机回环来源直接放行（与桌面壳同信任域，S1 之前的行为逐字不变）；非回环来源一律过 auth.ts。
  // 拒绝原因逐条落启动日志（**S3 起同时进审计流水**：`actor=remote/action=rejected` + 拒绝码，见 remote-audit.ts）。
  // S2 起把**路径**一并喂给放行口：`/` 与 `/remote` 是登录页本体（免凭据、只认 GET，见 auth.ts
  // 的 PUBLIC_PATHS）；`/api/remote/login|logout` 是会话生命周期（写方法的唯一例外）；
  // `.../chat/sessions*` 走聊天闸门（默认不下发）。
  const reqPath = requestPathOf(req.url);
  const reqMethod = req.method ?? "GET";
  const sourceIp = req.socket.remoteAddress ?? null;
  // S3：写模式生效值**每请求现取**（`WriteModeController.enabled()` 只做一次开关文件的 stat）——
  // 这就是 DoD③「关闭写模式后写接口立刻失效、不等重启」的实现点。
  const writeEnabled = writeMode.enabled();
  // F7（2026-09-18 审计）：放行口自身抛错（含 REMOTE_REQUIRES_TOKEN 红线自断言）绝不带崩进程，
  // 也不回显异常原文——结构化 500 + 消息级脱敏（sanitizeErrorMessage），进程活着、原始错误落日志。
  let guard: GuardResult;
  try {
    guard = guardRemoteRequest(remoteConfig, authService, {
      remoteAddress: req.socket.remoteAddress,
      method: reqMethod,
      authorization: req.headers.authorization,
      path: reqPath,
      writeEnabled,
      // F1：Origin/Host 两道闸的输入（判定在放行口里；Origin 缺席 = 非浏览器客户端直接跳过，
      // Host 缺席 = HTTP/1.0 极旧客户端同样跳过——两道闸防的都是浏览器侧攻击）
      origin: req.headers.origin,
      host: req.headers.host,
    });
  } catch (e) {
    const safe = sanitizeErrorMessage((e as Error)?.message ?? String(e));
    // Q19（2026-09-18 审计）：日志只记**归一后**的 path（去 query）——审计口径明写"query 里可能有
    // 检索词，那是内容不是访问足迹"（remote-audit.ts 文件头），拒绝日志不该比审计记更多。
    console.error(`[tatai-server] 放行口内部异常 ${reqMethod} ${reqPath || "?"}：${safe}`);
    res.statusCode = 500;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: false, error: { code: "INTERNAL", message: `放行口内部错误：${safe}` } }));
    return;
  }
  if (!guard.ok) {
    console.log(
      `[remote] 拒绝 ${reqMethod} ${reqPath || "?"} 来源=${req.socket.remoteAddress ?? "?"} → ${guard.status} ${guard.code}`,
    );
    // S3 审计（DoD②）：非回环来源被拒的**每一次**都留痕（拒绝码、来源、路径、凭据种类）。
    // 凭据只记种类与指纹，**口令原文永不入日志**（audit.ts 的红线，验证脚本会 grep 原件反证）。
    auditLog?.record({
      actor: "remote",
      action: "rejected",
      ip: sourceIp,
      method: reqMethod,
      path: reqPath,
      status: guard.status,
      code: guard.code,
      fingerprint: null,
      credential: credentialKindOf(credentialFromHeader(req.headers.authorization)),
      project_id: projectIdOfPath(reqPath),
      source: null,
      note:
        guard.code === "REMOTE_READ_ONLY"
          ? `写方法被只读红线拦下（运行期写模式=${writeEnabled ? "开" : "关"}）`
          : null,
    });
    res.statusCode = guard.status;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("www-authenticate", 'Bearer realm="tatai-remote"');
    if (guard.retryAfterMs !== undefined) {
      res.setHeader("retry-after", String(Math.ceil(guard.retryAfterMs / 1000)));
    }
    res.end(JSON.stringify({ ok: false, error: { code: guard.code, message: guard.message } }));
    return;
  }

  // S3 审计：放行的远程请求在响应收尾时按**真实结果码**落一条（写进 actor=remote）。
  // 本机回环来源不记（它不是"远程访问"，也没有 token 概念——红线①口径：本机是桌面 UI 的信任域）。
  // 例外是**长连接（SSE）**：`/events`、`/terminal/:sid/out` 挂上就不松手，等断开才记等于把足迹
  // 押在连接寿命上（一个开着不动的 SSE 就等于审计里看不见）——这两类**连上即记**，断开不再补记。
  if (guard.remote) {
    const auditAction = actionOfRequest(reqPath, reqMethod);
    const credentialKind = credentialKindOf(credentialFromHeader(req.headers.authorization));
    const isSse = /\/events$/.test(reqPath) || /\/terminal\/[^/]+\/out$/.test(reqPath);
    const noteOf = (extra: string | null) =>
      extra ??
      (auditAction === "write"
        ? `远程写请求（运行期写模式=${writeEnabled ? "开" : "关"}）`
        : auditAction === "session"
          ? "会话生命周期（口令换会话 / 登出）"
          : null);
    if (isSse) {
      auditLog?.record({
        actor: "remote",
        action: auditAction,
        ip: sourceIp,
        method: reqMethod,
        path: reqPath,
        status: 200,
        code: null,
        fingerprint: guard.fingerprint,
        credential: credentialKind,
        project_id: projectIdOfPath(reqPath),
        source: null,
        note: noteOf("SSE 长连接：连上即记（断开不补记）"),
      });
    } else {
      res.on("finish", () => {
        auditLog?.record({
          actor: "remote",
          action: auditAction,
          ip: sourceIp,
          method: reqMethod,
          path: reqPath,
          status: res.statusCode,
          code: null,
          fingerprint: guard.fingerprint,
          credential: credentialKind,
          project_id: projectIdOfPath(reqPath),
          source: null,
          note: noteOf(null),
        });
      });
    }
  }

  res.setHeader("content-type", "application/json; charset=utf-8");

  // U1（三期）：桌面壳里的前端与后端**不同源**——Tauri WebView 的 origin 是 http://tauri.localhost，
  // 浏览器同源策略会挡下跨源响应，POST JSON 还要先过 OPTIONS 预检。
  // 只放行壳自己的几个 origin（窄白名单，不放行任意源、不带凭证、不带 cookie），
  // 浏览器里跑（同源 / vite 代理）时这段完全不生效，行为与本卡之前逐字相同。
  // 局域网鉴权与只读红线在三期 S 组（PLAN.md S1），这里的白名单不含任何外部来源。
  if (applyShellCors(req, res) && req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  // ── V06-01 唯一写入服务面（PLAN.md V06-01，DESIGN.md §2.6）──
  // 位置在放行口**之后**：非回环来源照旧先过远程红线（只读模式下写方法 403 REMOTE_READ_ONLY），
  // 回环来源（桌面 UI / stdio MCP）才谈得上描述符令牌那一关。四条路由登记在 remote-routes.ts。
  // 处理是异步的（要读请求体），但本函数签名是同步的——故 fire-and-forget，错误在本地兜住。
  const replyWorkRoutes = (): void => {
    void workHost.handle(req, res, reqPath).catch((e: unknown) => {
      const message = sanitizeErrorMessage((e as Error)?.message ?? String(e));
      console.error(`[tatai-server] work 面异常 ${reqMethod} ${reqPath}：${message}`);
      if (res.headersSent) {
        res.end();
        return;
      }
      res.statusCode = 500;
      res.end(JSON.stringify({ ok: false, error: { code: "INTERNAL", message } }));
    });
  };
  if (req.method === "POST" && reqPath === "/api/work/command") {
    replyWorkRoutes();
    return;
  }
  if (req.method === "POST" && reqPath === "/api/work/repair") {
    replyWorkRoutes();
    return;
  }
  if (req.method === "GET" && reqPath === "/api/work/health") {
    replyWorkRoutes();
    return;
  }
  if (req.method === "GET" && reqPath === "/api/work/snapshot") {
    replyWorkRoutes();
    return;
  }

  // G1：工作台数据读写层 HTTP 最小集。错误统一走结构化 { ok:false, error:{code,message} }：
  // 项目不存在 404，其余参数/状态校验失败 400，不抛裸栈。
  const wsFail = (e: unknown) => {
    if (e instanceof WsError) {
      // Q122（2026-09-19 审计）：这一支此前**不做任何脱敏**，而 WsError 的文案里常嵌本机绝对路径
      // （扫描器的 `目录不存在或不是目录: D:\…`、global-changes 的 `changes.jsonl 有一行超过…：D:\…`），
      // 远程只读客户端原样收到本机目录结构。脱敏只在非回环来源上做（与 withoutLocalPaths 的
      // `remote` 分支同一口径）：本机回环是本机排障要用的，文案逐字不变。
      res.statusCode = wsErrorStatus(e.code);
      res.end(
        JSON.stringify({
          ok: false,
          error: { code: e.code, message: guard.remote ? sanitizeErrorMessage(e.message) : e.message },
        }),
      );
    } else if (isWorkError(e)) {
      // V06-02：图纸/基线走 v2 错误口径（code + detail，`docs/work-v2-contract.md` 同一张表）。
      // detail 里可能带项目根相对路径（不含本机绝对路径），远程来源照旧过一遍消息脱敏。
      res.statusCode = workErrorStatus(e.code);
      res.end(
        JSON.stringify({
          ok: false,
          error: {
            ...e.toJSON(),
            ...(guard.remote ? { message: sanitizeErrorMessage(e.message) } : {}),
          },
        }),
      );
    } else if (e instanceof RegistryStateError) {
      // Q129（2026-09-19 审计）+ 补修 A（2026-09-20）：注册表"读不到/坏/丢"**不是**用户入参错——
      // 500 + 专用 code + 结构化现场（state/reason/traces/recovery）+ 可操作文案，不再含糊地回 INTERNAL，
      // 也**不**把它说成空项目列表。消息同样过消息级脱敏（文案里带本机绝对路径）。
      res.statusCode = 500;
      res.end(
        JSON.stringify({
          ok: false,
          error: { ...e.toJSON(), message: sanitizeErrorMessage(e.message) },
        }),
      );
    } else {
      // F5（2026-09-18 审计）：非 WsError 的 500 不回显异常原文里的本机绝对路径（ENOENT 的
      // `open 'C:\Users\…'` 一类），先过消息级脱敏（盘符/UNC → <path>），可读性不打折。
      // Q207（2026-09-19 二轮审计）：取文案与同文件 :334/:395/:2141 口径统一——`(e as Error).message`
      // 在 `throw "x"` 一类非 Error 抛出值上是 undefined（旧码在这里连脱敏都进不去，wsFail 自崩，
      // 500 被上层的 withWs 链报成 400），`?.message ?? String(e)` 至少留下可读原文。
      res.statusCode = 500;
      res.end(
        JSON.stringify({
          ok: false,
          error: { code: "INTERNAL", message: sanitizeErrorMessage((e as Error)?.message ?? String(e)) },
        }),
      );
    }
  };
  const withWs = (fn: (body: unknown) => unknown) => {
    readJsonBody(req)
      .then((body) => {
        try {
          res.end(JSON.stringify(fn(body)));
        } catch (e) {
          wsFail(e);
        }
      })
      .catch((e: Error) => wsFail(new WsError("INVALID_INPUT", e.message)));
  };

  // ── 三期 S2：远程只读入口（PLAN.md S2 卡；路由清单与拒绝口径见 src/server/remote-routes.ts）──
  // 只有四条：免凭据的页面本体、口令换会话、登出、会话自述。**页面本体是一张自包含 HTML**
  // （src/server/remote-page.ts），复用服务端既有读接口，不另写一套业务 UI（U1 红线精神）。
  if (req.method === "GET" && (reqPath === "/" || reqPath === "/remote")) {
    // nonce 每次现生成：CSP 只认本页这一处脚本（页面内联 JS 是自己写的，不引任何外部资源）
    const nonce = crypto.randomBytes(16).toString("base64url");
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader(
      "content-security-policy",
      `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self'; ` +
        "form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
    res.end(remotePageHtml(nonce));
    return;
  }
  // POST /api/remote/login —— 口令换会话（DoD③）：口令只走 Authorization 头，body 不接口令；
  // 换来的会话 id 由页面自己存放（sessionStorage），服务端只在内存里记，登出/到期即失效。
  if (req.method === "POST" && reqPath === "/api/remote/login") {
    if (!remoteConfig.enabled || authService === null) {
      res.statusCode = 403;
      res.end(
        JSON.stringify({
          ok: false,
          error: {
            code: "REMOTE_DISABLED",
            message: "远程访问未开启：主机上置 TATAI_REMOTE=1 才有登录口（DESIGN.md §1.4 / §10.2）",
          },
        }),
      );
      return;
    }
    try {
      const session = authService.createSession(
        credentialFromHeader(req.headers.authorization),
        req.socket.remoteAddress ?? null,
      );
      console.log(
        `[remote] 会话签发 来源=${req.socket.remoteAddress ?? "?"} 指纹=${session.token_fingerprint} 到期=${session.expires_at}`,
      );
      res.end(
        JSON.stringify({
          ok: true,
          remote: guard.remote,
          chat_exposed: remoteConfig.chatExposed,
          session: {
            session_id: session.session_id,
            created_at: session.created_at,
            expires_at: session.expires_at,
            session_ttl_ms: authService.sessionTtlMs,
            token_fingerprint: session.token_fingerprint,
          },
        }),
      );
    } catch (e) {
      // F5：口令文件坏结构等场景的 message 里带本机路径（`口令文件结构不对: C:\Users\…`），脱敏后再回显
      const code = e instanceof AuthError ? e.code : "SESSION_FAILED";
      res.statusCode = 401;
      res.end(
        JSON.stringify({ ok: false, error: { code, message: sanitizeErrorMessage((e as Error).message) } }),
      );
    }
    return;
  }
  // POST /api/remote/logout —— 登出（DoD③）：会话立刻作废；用口令调用时如实回 logged_out:false
  // （口令不是会话，没有"登出"这回事，不假装成功）。幂等：重复登出也 200。
  if (req.method === "POST" && reqPath === "/api/remote/logout") {
    if (!remoteConfig.enabled || authService === null) {
      res.statusCode = 403;
      res.end(
        JSON.stringify({
          ok: false,
          error: { code: "REMOTE_DISABLED", message: "远程访问未开启，无会话可登出" },
        }),
      );
      return;
    }
    const credential = credentialFromHeader(req.headers.authorization);
    const isSession = typeof credential === "string" && credential.startsWith(SESSION_ID_PREFIX);
    const removed = isSession ? authService.logout(credential) : false;
    if (isSession) {
      console.log(
        `[remote] 登出 来源=${req.socket.remoteAddress ?? "?"} 结果=${removed ? "会话已作废" : "会话不存在"}`,
      );
    }
    res.end(
      JSON.stringify({
        ok: true,
        logged_out: removed,
        note: isSession
          ? removed
            ? "会话已作废：同一凭据再用会得到 401 SESSION_INVALID"
            : "会话不存在（可能已过期或已登出）"
          : "口令不是会话：登出只作废由口令换来的会话，口令本身仍在有效期内",
      }),
    );
    return;
  }
  // GET /api/remote/session —— 会话自述（页面启动时对账用）：凭据类型、到期时间、聊天是否下发
  if (req.method === "GET" && reqPath === "/api/remote/session") {
    if (!remoteConfig.enabled || authService === null) {
      res.statusCode = 403;
      res.end(
        JSON.stringify({
          ok: false,
          error: { code: "REMOTE_DISABLED", message: "远程访问未开启（本机回环可直接用本地界面）" },
        }),
      );
      return;
    }
    const writeSnap = writeMode.snapshot();
    const base = {
      ok: true,
      chat_exposed: remoteConfig.chatExposed,
      terminal_exposed: remoteConfig.terminalExposed,
      memory_exposed: remoteConfig.memoryExposed,
      write_enabled: writeSnap.enabled,
      read_only: !writeSnap.enabled,
      write_mode_since: writeSnap.enabled ? writeSnap.since : null,
    };
    if (!guard.remote) {
      // 本机回环免凭据（S1 口径）：本地开这个页面直接可用，不需要口令
      res.end(JSON.stringify({ ...base, remote: false, via: "loopback", session: null, fingerprint: null }));
      return;
    }
    const verdict = authService.authorize(credentialFromHeader(req.headers.authorization));
    if (!verdict.ok) {
      const { status, code } = authRejectStatus(verdict.reason);
      res.statusCode = status;
      res.end(JSON.stringify({ ok: false, error: { code, message: `凭据不可用: ${verdict.reason}` } }));
      return;
    }
    res.end(
      JSON.stringify({
        ...base,
        remote: true,
        via: verdict.via,
        fingerprint: verdict.fingerprint,
        session: verdict.session
          ? {
              created_at: verdict.session.created_at,
              expires_at: verdict.session.expires_at,
              session_ttl_ms: authService.sessionTtlMs,
            }
          : null,
      }),
    );
    return;
  }

  const sub = req.url?.match(/^\/api\/projects\/([^/]+)\/(progress|gate|gate\.jsonl|tasks|modules|design|discuss|documents|activity|live)(?:\/([^/]+))?(?:\/(status|back))?$/);

  // GET /api/projects/:id/activity —— 反查兜底（M3，DESIGN.md §12.2 风险 4，做到可观测即可）：
  // 返回两个时间字段对照——last_change_at = changes.jsonl 最后一行 ts（agent 改没改文件），
  // last_task_report_at = tasks.json 最大 updated_at（agent 报没报状态）；
  // 一眼看出"agent 在改文件但没汇报"。只读合成，不写任何文件；无数据时字段为 null（正常空态）。
  if (req.method === "GET" && sub && sub[2] === "activity" && !sub[3]) {
    try {
      const id = decodePathSegment(sub[1]);
      // Q28（2026-09-18 审计）：这里只要最新一条，走 readChanges 的尾部窗口读——
      // queryChanges 得为 total/path 过滤全量读整份 changes.jsonl（本项目变更多时纯属白读）
      const latestChange = readChanges(id, 1)[0];
      // `tasks.json` 的 `updated_at` 可能跨偏移/被外部写脏：取**真实时刻**最晚的一条；
      // 一条都解析不出来 → null（不把时间非法的值当成"最近上报"）。
      const lastTaskReportAt = latestByTime(listTasks(id), (t) => t.updated_at)?.updated_at ?? null;
      res.end(
        JSON.stringify(
          withoutLocalPaths(
            {
              ok: true,
              activity: {
                last_change_at: latestChange ? latestChange.ts : null,
                last_task_report_at: lastTaskReportAt,
              },
            },
            guard.remote,
          ),
        ),
      );
    } catch (e) {
      wsFail(e);
    }
    return;
  }

  // GET /api/summary/projects —— 跨项目汇总（P2，DESIGN.md §11.2「多项目并行增强」）。
  // 只读合成：注册表 + 各项目 progress/tasks/gate.jsonl/changes.jsonl——一个文件都不写，
  // 也不写注册表（不开监听、不 touch last_opened_at）。
  // 口径全部来自 P1 `src/server/projects-summary.ts`（见 `src/server/summary.ts` 头部）；
  // 响应一次给两种口径的渲染（rows = 按项目一行，groups = 同一批行按 Gate 步分桶），
  // 前端切换口径零请求——这也是「两种口径不是两套数据」的直接体现。
  if (req.method === "GET" && req.url === "/api/summary/projects") {
    try {
      res.end(JSON.stringify(withoutLocalPaths({ ok: true, summary: summarizeAllProjects() }, guard.remote)));
    } catch (e) {
      wsFail(e);
    }
    return;
  }

  // GET /api/projects/:id/live —— 实况聚合快照（V1，DESIGN.md §3.10）。
  // 只读合成 tasks/progress/gate.jsonl/changes.jsonl/agents.json，一个都不写（DoD⑤）；
  // 实时口径：文件变更走 SSE events 通道推送，Gate/任务变化由前端对本接口 5s 轻轮询对账
  // （见 src/server/live.ts 头部注释——不为低频源再开推送通道）。
  if (req.method === "GET" && sub && sub[2] === "live" && !sub[3]) {
    try {
      res.end(
        JSON.stringify(withoutLocalPaths({ ok: true, live: getLive(decodePathSegment(sub[1])) }, guard.remote)),
      );
    } catch (e) {
      wsFail(e);
    }
    return;
  }

  // ── V06-02：两份图纸的版本与审定（PLAN.md V06-02，DESIGN.md §2.6 / §2.9 / §3.5）──
  // 本卡**不新增 UI**，只给文档读写入口（四条路由，同步登记在 remote-routes.ts）：
  //   GET  /documents           读两份图纸的当前源 + 修订（哈希/章节索引）+ 生效基线与结构问题
  //   GET  /documents/diff      两个修订之间的章节差异（query: kind/from/to，按哈希取原文）
  //   POST /documents/preserve  把当前源存成不可变历史（Git 可取回的直接引用，否则落副本并校验哈希）
  //   POST /documents/activate  审定配套版本 → 双版本激活（只追加 baselines.jsonl；不写 gate.jsonl）
  // 响应里只出现**项目根内相对路径**（source_path / recovery.ref），本机绝对路径一个都不外发——
  // 比 withoutLocalPaths 的裁剪更彻底，所以这几条路由不必再套它。
  const documentSummary = (projectId: string, kind: DocumentKind) => {
    const loaded = loadDocument(projectId, kind);
    if (loaded === null) return { exists: false as const, kind };
    const r = loaded.revision;
    return {
      exists: true as const,
      kind,
      source_path: r.source_path,
      origin: r.origin,
      content_sha256: r.content_sha256,
      definition_sha256: r.definition_sha256,
      bytes: r.bytes,
      lines: r.lines,
      // 章节索引给标题路径与行范围（正文哈希不必外发：定位与差异够用了）
      sections: r.sections.map((s) => ({
        level: s.level,
        title: s.title,
        path: s.path,
        line_start: s.line_start,
        line_end: s.line_end,
      })),
      recovery: r.recovery,
    };
  };
  if (req.method === "GET" && sub && sub[2] === "documents" && !sub[3]) {
    try {
      const id = decodePathSegment(sub[1]);
      const planLoaded = loadDocument(id, "plan");
      const log = readBaselineLog(id);
      res.end(
        JSON.stringify({
          ok: true,
          documents: {
            design: documentSummary(id, "design"),
            plan: documentSummary(id, "plan"),
            plan_structure: planLoaded === null ? null : planStructure(planLoaded),
            baseline: {
              active: log.baselines.length === 0 ? null : log.baselines[log.baselines.length - 1],
              count: log.baselines.length,
              corrupt: log.corrupt,
              path: BASELINES_FILE,
            },
          },
        }),
      );
    } catch (e) {
      wsFail(e);
    }
    return;
  }
  const documentsDiffMatch = req.url?.match(
    /^\/api\/projects\/([^/]+)\/documents\/diff(?:\?(.*))?$/,
  );
  if (req.method === "GET" && documentsDiffMatch) {
    try {
      const id = decodePathSegment(documentsDiffMatch[1]);
      const q = new URLSearchParams(documentsDiffMatch[2] ?? "");
      const kind = String(q.get("kind") ?? "");
      if (kind !== "design" && kind !== "plan") {
        throw new WsError("INVALID_INPUT", `kind 只接受 design/plan（收到 ${JSON.stringify(kind)}）`);
      }
      const sha = (name: string): string => {
        const v = String(q.get(name) ?? "");
        if (!/^[0-9a-f]{64}$/.test(v)) {
          throw new WsError("INVALID_INPUT", `${name} 必须是 sha256 十六进制（64 位小写十六进制）`);
        }
        return v;
      };
      res.end(JSON.stringify({ ok: true, diff: diffRevisionsByHash(id, kind, sha("from"), sha("to")) }));
    } catch (e) {
      wsFail(e);
    }
    return;
  }
  if (req.method === "POST" && sub && sub[2] === "documents" && sub[3] === "preserve") {
    withWs((body) => {
      const input = body as Record<string, unknown>;
      const kind = String(input.kind ?? "");
      if (kind !== "design" && kind !== "plan") {
        throw new WsError("INVALID_INPUT", `kind 只接受 design/plan（收到 ${JSON.stringify(input.kind)}）`);
      }
      return { ok: true, result: preserveDocumentRevision(decodePathSegment(sub[1]), kind) };
    });
    return;
  }
  if (req.method === "POST" && sub && sub[2] === "documents" && sub[3] === "activate") {
    withWs((body) => {
      const input = body as Record<string, unknown>;
      const expected =
        typeof input.expected === "object" && input.expected !== null
          ? (input.expected as ActivateBaselineInput["expected"])
          : undefined;
      // 审定字段一律按原样交给 documents.assertApproval 判（缺/假/技术审定冒充用户 Gate 都在那里拒绝）
      const result = activateBaseline(decodePathSegment(sub[1]), {
        approved_by: input.approved_by as string,
        approval_basis: input.approval_basis as string,
        approval_kind: input.approval_kind as ActivateBaselineInput["approval_kind"],
        ...(expected === undefined ? {} : { expected }),
      });
      // §4.4：有效基线激活**触发规划关联重建**。异步执行（不 await）：派生是激活的派生动作，
      // 模型不可用/校验不过都只留回执与状态并保留旧图，绝不把已经成立的激活拖成失败。
      // 补修包 E：这条链现在是**自动链**——先零模型地发确定性派生（复用已保存的语义整理结果），
      // 再按"基线 + 该段来源内容 + 生成器版本"自动检查分段整理结果：命中即复用（零调用），
      // 缺失或该段来源变了才触发必要整理（只整理受影响范围、有界重试、失败降级）。
      // `semantic:true` 仍是显式重试/高级入口（POST arch/blueprint），但它**不是**唯一触发方式。
      triggerBlueprintAuto(decodePathSegment(sub[1]), { trigger: "baseline_activated" });
      return { ok: true, ...result };
    });
    return;
  }

  // ── V06-09：证据/审计/状态投影的**只读入口**（PLAN.md V06-09，DESIGN.md §4.2 / §5.5）──
  //   GET /api/projects/:id/status-projection  每对象四维 + 六态 + 计数 + 缺口 + 复核范围
  //   GET /api/projects/:id/audit              缺陷台账 + 审计链 + 证据清单 + 审计包 + 抽查包
  // 两条都从**现场事实**（事件 + 图纸定义 + 生效基线 + 证据正文）现算，不写任何文件；
  // 响应里只出现项目根内相对路径（改动文件名、证据恢复位置），本机绝对路径一个都不外发。
  // 两条路由共用一个分支，故只登记一条（path + altPaths），锚点唯一（remote-routes.ts 对账口径）。
  //
  // **补修 C 红线**：本分支**不读任何 query 参数**（`workProjectionMatch[3]` 是 url 形态的一部分，
  // 从不解析）——"需要哪些集成检查"只从施工图的版本化验收定义 + 有效基线装配，
  // 检查结果只从事件装配。GET 参数与前端声明都产生不了绿灯；`integration_checks` 这类
  // 进程内覆盖参数一个都不在这里传（见 `objectsFromFacts` 的 `FactsToObjectsOptions` 注释）。
  const workProjectionMatch = req.url?.match(
    /^\/api\/projects\/([^/]+)\/(status-projection|audit)(?:\?(.*))?$/,
  );
  if (req.method === "GET" && workProjectionMatch) {
    try {
      const id = decodePathSegment(workProjectionMatch[1]);
      const which = workProjectionMatch[2];
      const project = getProject(id);
      if (!project) throw new WsError("PROJECT_NOT_FOUND", `项目不存在: ${id}`);
      const facts = collectProjectFacts(id, DATA_DIR);
      // 人工验收按对象取（任务按 task_id 关联；模块/连线只看批次级或 pending）——不接受"质量状态代写验收"
      const withAcceptance = (objs: ReturnType<typeof objectsFromFacts>) =>
        objs.map((o) => ({
          ...o,
          acceptance:
            o.object_kind === "task"
              ? acceptanceDimensionOf(Object.values(facts.audit.acceptances), { task_id: o.object_id })
              : ("pending" as const),
        }));
      // 两趟：先算每个依赖线的"前置是否释放"，再让依赖线带上释放结论（依赖释放不看前卡自报 done）
      const pass1 = projectStatuses({
        objects: withAcceptance(objectsFromFacts(id, DATA_DIR, facts)),
        findings: facts.findings,
        checks: checksFromAudit(facts.audit),
        source_revision: facts.revisions,
        binding_segments: facts.binding_segments,
      });
      const releases: Record<string, { released: boolean; reasons: string[] }> = {};
      for (const def of facts.definitions) {
        for (const dep of def.dependency_ids) {
          const prereq = pass1.by_id[dep];
          if (prereq === undefined) continue;
          releases[`${dep}->${def.task_id}`] = dependencyRelease({
            prerequisite_id: dep,
            prerequisite: prereq,
            evidence_requirement: def.dependency_evidence.find((d) => d.dependency_id === dep)?.evidence ?? null,
          });
        }
      }
      const projection = projectStatuses({
        objects: withAcceptance(objectsFromFacts(id, DATA_DIR, facts, { dependency_releases: releases })),
        findings: facts.findings,
        checks: checksFromAudit(facts.audit),
        source_revision: facts.revisions,
        binding_segments: facts.binding_segments,
      });
      if (which === "status-projection") {
        res.end(
          JSON.stringify({
            ok: true,
            projection: {
              last_seq: facts.last_seq,
              revisions: facts.revisions,
              baseline: facts.baseline,
              // 补修 C：把"需要哪些集成检查"的来源一起带出（可解释性：绿灯依据来自哪版定义、
              // 是否已被有效基线批准）。**只读事实摘要**，不接受任何 query/前端声明覆盖。
              integration_requirements: {
                declared: facts.integration_requirements.declared,
                plan_revision: facts.integration_requirements.plan_revision,
                in_force: facts.integration_requirements.in_force,
                not_in_force_reason: facts.integration_requirements.not_in_force_reason,
                issues: facts.integration_requirements.issues,
                by_object: facts.integration_requirements.by_object,
              },
              summary: projection.summary,
              objects: projection.objects.map((p) => ({
                ...p,
                // 兼容投影的四色（v1 读口的派生值；真状态仍看 display_status）
                v1_status: v1ModuleStatusOf(p.display_status),
              })),
            },
          }),
        );
        return;
      }
      const ledger = findingLedger(facts.findings);
      const manifest = evidenceManifest(facts.work_dir);
      // 结果提交的 `at` 来自 `occurred_at`（调用方给的时间，偏移任意）：按**真实时刻**取最近一次。
      // 时间解析不出来的提交不参与"最近"的比较；一条都解析不出来 → 视为拿不到最近提交（null）。
      const latest = latestByTime(Object.values(facts.audit.submissions), (s) => s.at);
      const coverage = (Object.values(facts.audit.independent_audits)[0]?.coverage ?? []).map((c) => ({
        area: c.area,
        status: c.status,
        basis: c.basis,
        source: "independent_audit",
      }));
      const changedFiles = latest?.changed_files ?? [];
      const sources = changedFiles.map((rel) => {
        // 只读项目根内的相对路径；越界/不存在一律记 null（不给摘要冒充原文）
        const abs = path.resolve(project.path, rel);
        const inside = abs.startsWith(path.resolve(project.path) + path.sep);
        let sha: string | null = null;
        try {
          if (inside && fs.existsSync(abs) && fs.statSync(abs).isFile()) {
            sha = sha256Hex(fs.readFileSync(abs));
          }
        } catch {
          sha = null;
        }
        return { locator: rel, sha256: sha, note: sha === null ? "取不到原文（越界或不存在）" : "读源码原文" };
      });
      const spotCheck = buildSpotCheckPackage({
        spot_check_id: `spot:${id}:${facts.last_seq}`,
        seed: `${id}:${latest?.record_id ?? "no-submission"}`,
        sources,
        user_paths: Object.values(facts.audit.acceptances).flatMap((a) =>
          a.scenario_refs.map((s) => ({ locator: s, note: "走一遍用户路径（真实操作）" })),
        ),
        unreported_areas: (Object.values(facts.audit.independent_audits)[0]?.not_reported_scope ?? []).map((s) => ({
          locator: s,
          note: "未报错范围抽查",
        })),
      });
      const auditPackage =
        latest === null
          ? null
          : buildAuditPackage({
              package_id: `pkg:${id}:${latest.record_id}`,
              batch_id: latest.record_id,
              change_id: null,
              submission: latest,
              coverage,
              self_checks: Object.values(facts.audit.self_checks),
              independent_audits: Object.values(facts.audit.independent_audits),
              fixes: Object.values(facts.audit.fixes),
              retests: Object.values(facts.audit.retests),
              findings: facts.findings,
              evidence: manifest.map((m) => ({
                evidence_id: m.evidence_id,
                recovery_path: m.recovery_path,
                kind: m.kind,
                summary: m.summary,
              })),
            });
      res.end(
        JSON.stringify({
          ok: true,
          audit: {
            last_seq: facts.last_seq,
            findings: {
              ledger: {
                confirmed: ledger.confirmed.map((f) => f.finding_id),
                unverified: ledger.unverified.map((f) => f.finding_id),
                false_positive: ledger.false_positive.map((f) => f.finding_id),
                duplicate: ledger.duplicate.map((f) => f.finding_id),
                fixed_pending_retest: ledger.fixed_pending_retest.map((f) => f.finding_id),
                closed: ledger.closed.map((f) => f.finding_id),
                accepted_risk: ledger.accepted_risk.map((f) => f.finding_id),
                blocking: ledger.blocking.map((f) => f.finding_id),
              },
              records: facts.findings,
            },
            audit_records: {
              submissions: Object.values(facts.audit.submissions),
              self_checks: Object.values(facts.audit.self_checks),
              independent_audits: Object.values(facts.audit.independent_audits),
              fixes: Object.values(facts.audit.fixes),
              retests: Object.values(facts.audit.retests),
              acceptances: Object.values(facts.audit.acceptances),
            },
            chain: checkAuditChain({ records: facts.audit, findings: facts.findings }),
            evidence: manifest,
            audit_package: auditPackage,
            spot_check: spotCheck,
          },
        }),
      );
    } catch (e) {
      wsFail(e);
    }
    return;
  }

  // ── V06-12：Git 保存版本提醒的**只读**探测口（PLAN.md V06-12，DESIGN.md §3.15 / §8.5）──
  //   GET /api/projects/:id/git-status → { git: 只读探测结果, reminder: 提醒派生 }
  // ██ 红线：**一个写操作都没有**。探测只跑 `src/server/gitStatus.ts` 里登记过的固定 argv
  //    （全部带全局 `--no-optional-locks` + `GIT_OPTIONAL_LOCKS=0`，因为裸跑 `git status` 会写
  //    `.git/index` 的 stat 缓存）；没有 fetch/联网/认证/推送，也不自动 add/commit；
  //    不是仓库时如实回「未使用 Git」，不擅自 init。整条路由只读文件，不落一个字节。██
  // 补修 D：判定事实从**权威事实**装配（提交记录 / 检查记录 / 证据清单 / 任务定义的必需检查 /
  //    用户接受 / 未收口缺陷），内容版本由 `gitStatus.ts` 按盘上内容现算；
  //    这条路由**不读任何请求参数**，前端与 GET 参数产生不了"已通过必要检查"。
  const gitStatusMatch = requestPathOf(req.url).match(/^\/api\/projects\/([^/]+)\/git-status$/);
  if (req.method === "GET" && gitStatusMatch) {
    const gitStatusProjectId = decodePathSegment(gitStatusMatch[1]);
    // 只读探测是子进程，异步跑（同步 execFile 会卡住整个后端，SSE 与聊天一起停顿）
    void (async () => {
      try {
        const project = getProject(gitStatusProjectId);
        if (!project) throw new WsError("PROJECT_NOT_FOUND", `项目不存在: ${gitStatusProjectId}`);
        // 路径只走注册表（§2.3.1）：不接受 query/body 里给的任何目录
        const status = await inspectGitStatus(project.path);
        const facts = collectProjectFacts(gitStatusProjectId, DATA_DIR);
        const manifest = evidenceManifest(facts.work_dir);
        const reminder = buildVersionReminder(
          status,
          {
            // 提醒来源关联**成果 ID**（提交记录 id）与**证据 ID**（内容寻址哈希）：界面据此说清
            // "这批改动对应哪次成果提交"，而不是笼统说"有改动"
            submissions: Object.values(facts.audit.submissions).map((s) => ({
              record_id: s.record_id,
              task_id: s.task_id,
              changed_files: s.changed_files,
              evidence_refs: s.evidence_refs,
              at: s.at,
              submitted_by: s.submitted_by,
            })),
            evidence: manifest.map((m) => ({ evidence_id: m.evidence_id, intact: m.intact })),
            // 检查记录 = 自检 / 独立审计两类既有事件（复用 V06-09 的装配，不另造存储）
            checks: checksFromAudit(facts.audit),
            // 「哪些必需检查」= 任务定义里的验收项 + 完成证据要求（同一份口径的单一出处）
            required_checks_by_task: requiredChecksFromDefinitions(facts.definitions),
            // 用户接受单独一段（检查通过不得扩写成已验收）
            acceptances: Object.values(facts.audit.acceptances).map((a) => ({
              record_id: a.record_id,
              task_id: a.task_id,
              decision: a.decision,
              at: a.at,
            })),
            // 未收口阻断：未关闭/未判误报重复、也未被用户接受风险的缺陷；外加**未解决的 Git 冲突**
            // （冲突态的工作树本身就说不清"这批内容已经成形"）
            blockers: [
              ...facts.findings
                .filter((f) => !["closed", "false_positive", "duplicate", "accepted_risk"].includes(f.status))
                .map((f) => ({
                  blocker_id: f.finding_id,
                  kind: "finding" as const,
                  severity: f.severity,
                  must_block: f.must_block,
                  status: f.status,
                  object_id: f.object_id,
                  note: f.actual,
                })),
              ...(status.conflicted ?? []).map((p) => ({
                blocker_id: `git:conflicted:${p}`,
                kind: "conflict" as const,
                severity: "blocks_core_goal",
                must_block: true,
                status: "confirmed",
                paths: [p],
                note: "工作树有未解决的合并冲突：内容还没成形，不算检查通过",
              })),
            ],
          },
          { project_name: project.name },
        );
        res.end(JSON.stringify(withoutLocalPaths({ ok: true, git: status, reminder }, guard.remote)));
      } catch (e) {
        wsFail(e);
      }
    })();
    return;
  }

  // ── C017：用量统计的**只读入口**（PLAN.md 2026-09-21 契约对齐登记，DESIGN.md §5.7 / §6.5 末段）──
  //   GET /api/projects/:id/work/usage → { usage: { claim_quota, durations, token, cost } }
  // ██ 红线：**一个写操作都没有**——全部从事件流（events.jsonl）与 budget.json 现算，不落一个字节；
  //    本分支不读任何 query/body 参数。██
  // 口径（验收组②，与组①配额节流行为互不冒充）：
  //   · claim_quota：认领额度＝运营节流，usage 复用 budget.ts 的 countTaskClaims 同一口径；
  //     它只是"认领了多少次、还能认领几次"，应答里**不出现**任何把它表述为费用/成本的文字。
  //   · durations：task.claimed → execution.delivered 按 task_id+claim_token 配对（received_at 之差）；
  //     未完结如实标「进行中/无来源」，不给毫秒。
  //   · token / cost：缺可核对来源，如实「未计量」（不设阈值、不设计价算法，§1.4/§5.7）。
  const workUsageMatch = requestPathOf(req.url).match(/^\/api\/projects\/([^/]+)\/work\/usage$/);
  if (req.method === "GET" && workUsageMatch) {
    try {
      const id = decodePathSegment(workUsageMatch[1]);
      if (!getProject(id)) throw new WsError("PROJECT_NOT_FOUND", `项目不存在: ${id}`);
      // 路径只走注册表（§2.3.1）：不接受 query/body 里给的任何目录
      const usage = buildProjectUsage(id, projectWorkDir(id, DATA_DIR));
      res.end(JSON.stringify(withoutLocalPaths({ ok: true, usage }, guard.remote)));
    } catch (e) {
      wsFail(e);
    }
    return;
  }

  // ── V09-06：私有事实备份/恢复的**产品入口**（PLAN.md V09-06，DESIGN.md §8.5 / §12.2 末行）──
  //   GET  /api/projects/:id/backups                         → 备份清单（版本 / 截止序号 / 内容哈希 / 证据）
  //   GET  /api/projects/:id/backups?source_parent=<绝对路径>  → 从**用户重新选的来源位置**列本项目自己的备份
  //   POST /api/projects/:id/backups        {dest_parent?}   → 在事件提交边界上创建一份一致备份（幂等）
  //   GET  /api/projects/:id/backups/:backupId[?source_parent=] → 单份：清单 + 八条核验 + 恢复预览（只读）
  //   POST /api/projects/:id/backups/:backupId/restore {dest_parent?, source_parent?} → 只恢复到**隔离目录**
  //   source_parent（可选）的由来：落点既然由用户选，就可能在项目外任意目录里 ⇒ 只认默认落点会让
  //   "备份到别处"变成"列表找不到、重启后恢复不了"。位置由用户再选一次，服务端在该位置上按清单
  //   归属认领（别的项目的备份一律不列、不读、不恢复，`BACKUP_PROJECT_MISMATCH`）。
  // ██ 红线（PLAN V09-06「禁止越界」，与 V06-14 逐字一致）██
  //   · 语义全部复用 `src/server/work/backup.ts` 的既有实现（一致切片 / 清单 / 隔离恢复），
  //     本入口只补"产品入口"缺的落点策略、幂等、失败分类与**位置发现**（`work/backupEntry.ts`），不另造存储；
  //   · **绝不自动替换当前数据**：恢复只落隔离目录，应答恒为 `replaced:false`；这里没有替换动作；
  //   · 原项目一个字节都不写；位置不得落在项目根内（会被 Git 与扫描看成项目产出）；
  //   · 位置由用户选，但只接受**回环来源**给的路径（远程来源连读面都拿不到：远程写模式不能拿它当
  //     宿主机任意写口，远程读客户端也不能拿它当遍历宿主机目录的口子）；
  //   · 不新增事件类型；不因为代码进了 Git 就把 `.工作台/` 说成「已备份」（那是两条不同的事实）。
  const backupsMatch = requestPathOf(req.url).match(
    /^\/api\/projects\/([^/]+)\/backups(?:\/([^/]+)(?:\/(restore))?)?$/,
  );
  // 位置参数走查询串（`requestPathOf` 已经把 `?` 后面切掉了，这里按既有写法自己取）
  const backupSourceParent = (): string | null =>
    new URLSearchParams((req.url ?? "").split("?")[1] ?? "").get("source_parent");
  // 备份面的失败一律走 `backupEntry.ts` 的可分辨失败码（损坏/权限/空间不足/目标不可写/已存在各自
  // 一个 code 与状态码）；不是备份面的异常退回既有 `wsFail` 口径，不吞。
  const backupFail = (e: unknown): void => {
    if (isBackupEntryError(e)) {
      res.statusCode = backupEntryStatus(e.code);
      res.end(
        JSON.stringify(
          withoutLocalPaths(
            {
              ok: false,
              error: {
                code: e.code,
                message: guard.remote ? sanitizeErrorMessage(e.message) : e.message,
                detail: e.detail,
              },
            },
            guard.remote,
          ),
        ),
      );
      return;
    }
    wsFail(e);
  };
  /** 备份面的请求体：形状不对按既有 `withWs` 同一口径报 400，不落成 500 */
  const backupBody = (): Promise<{ dest_parent?: unknown; source_parent?: unknown }> =>
    readJsonBody(req)
      .catch((e: Error) => {
        throw new WsError("INVALID_INPUT", e.message);
      })
      .then((raw) => (raw ?? {}) as { dest_parent?: unknown; source_parent?: unknown });
  if (req.method === "GET" && backupsMatch && !backupsMatch[2]) {
    try {
      const id = decodePathSegment(backupsMatch[1]);
      const list = listBackupEntries(id, {
        dataDir: DATA_DIR,
        sourceParent: backupSourceParent(),
        sourceParentAllowed: !guard.remote,
      });
      res.end(JSON.stringify(withoutLocalPaths({ ok: true, backups: list }, guard.remote)));
    } catch (e) {
      backupFail(e);
    }
    return;
  }
  if (req.method === "POST" && backupsMatch && !backupsMatch[2]) {
    void backupBody()
      .then((body) => {
        const id = decodePathSegment(backupsMatch[1]);
        const result = createBackupEntry(id, {
          destParent: body.dest_parent,
          destParentAllowed: !guard.remote,
          dataDir: DATA_DIR,
        });
        res.end(JSON.stringify(withoutLocalPaths({ ok: true, backup: result }, guard.remote)));
      })
      .catch(backupFail);
    return;
  }
  if (req.method === "GET" && backupsMatch && backupsMatch[2] && !backupsMatch[3]) {
    try {
      const id = decodePathSegment(backupsMatch[1]);
      const backupId = decodePathSegment(backupsMatch[2]);
      const detail = inspectBackupEntry(id, backupId, {
        dataDir: DATA_DIR,
        sourceParent: backupSourceParent(),
        sourceParentAllowed: !guard.remote,
      });
      res.end(JSON.stringify(withoutLocalPaths({ ok: true, backup: detail }, guard.remote)));
    } catch (e) {
      backupFail(e);
    }
    return;
  }
  if (req.method === "POST" && backupsMatch && backupsMatch[2] && backupsMatch[3] === "restore") {
    void backupBody()
      .then((body) => {
        const id = decodePathSegment(backupsMatch[1]);
        const backupId = decodePathSegment(backupsMatch[2]);
        const result = restoreBackupEntry(id, backupId, {
          destParent: body.dest_parent,
          destParentAllowed: !guard.remote,
          sourceParent: body.source_parent,
          sourceParentAllowed: !guard.remote,
          dataDir: DATA_DIR,
        });
        res.end(JSON.stringify(withoutLocalPaths({ ok: true, restore: result }, guard.remote)));
      })
      .catch(backupFail);
    return;
  }

  // GET /api/projects/:id/discuss —— 读待议记录全文（D2，§3.5 提疑权）。
  // 口径：塔台自身 = 抽取 repo 根 DESIGN.md 附录 B 区段（自举例外，无 .工作台 副本）；
  // 其他项目 = <项目根>/.工作台/design.discuss.md；不存在返回 {ok:true,discuss:{exists:false}}（200 空态）。
  if (req.method === "GET" && sub && sub[2] === "discuss" && !sub[3]) {
    try {
      res.end(
        JSON.stringify(
          withoutLocalPaths({ ok: true, discuss: readDiscuss(decodePathSegment(sub[1])) }, guard.remote),
        ),
      );
    } catch (e) {
      wsFail(e);
    }
    return;
  }
  // POST /api/projects/:id/discuss { content } —— 追加一条待议记录（D2）：
  // 服务端补 `- \`YYYY-MM-DD\` ` 日期前缀，前端只发内容本体；写入只走服务端（workstation.appendDiscuss）。
  // ████████████████████████████ 红线 ████████████████████████████
  // 待议记录【只追加】：全仓不提供任何修改/删除待议条目的接口（PUT/DELETE /discuss
  // 一律 404）。提疑权是"提"不是"改"（§6.3 硬性权限约束）。
  // ███████████████████████████████████████████████████████████████
  if (req.method === "POST" && sub && sub[2] === "discuss" && !sub[3]) {
    withWs((body) => {
      const input = body as Record<string, unknown>;
      const result = appendDiscuss(decodePathSegment(sub[1]), String(input.content ?? ""));
      // F6：写响应与读响应同口径——远程来源裁掉 result.source 里的本机绝对路径
      return withoutLocalPaths({ ok: true, result }, guard.remote);
    });
    return;
  }

  // ── V06-08：自用工作面的两条读取口与两条用户动作口（PLAN.md V06-08，DESIGN.md §3.1/§3.4–§3.5/§3.7/§3.10）──
  //   GET  /api/projects/:id/plan                  施工定义（TaskDefinition）+ 运行状态（TaskState）+ 对齐 + 原文定位片段
  //   GET  /api/projects/:id/discussions           待议条目（带 discussion_ref）+ 处置派生态 + 处置记录
  //   POST /api/projects/:id/discussions/decisions **只追加**一条处置记录到 `.工作台/decisions.jsonl`
  //   POST /api/projects/:id/acceptance            用户人工验收（接受/退回/接受已知限制）→ v2 事件
  // 四条都同步登记在 remote-routes.ts（POST 两条在只读模式下由 S2 红线先拒）。
  // ██ 红线：待议原文一个字节都不改。GET discussions 只读待议正文；POST decisions 只往
  //    decisions.jsonl 追加整行（`appendDecision` 里没有任何 write/truncate 分支），
  //    塔台自身本体（repo 根 DESIGN.md 附录 B）因此逐字节不变。██
  const planReadMatch = requestPathOf(req.url).match(/^\/api\/projects\/([^/]+)\/plan$/);
  if (req.method === "GET" && planReadMatch) {
    try {
      const id = decodePathSegment(planReadMatch[1]);
      if (!getProject(id)) throw new WsError("PROJECT_NOT_FOUND", `项目不存在: ${id}`);
      const loaded = loadDocument(id, "plan");
      if (loaded === null) {
        // 缺施工图是**正常空态**（不是错误）：界面必须与"加载失败"分开显示（§3.3）
        res.end(JSON.stringify({ ok: true, plan: { exists: false } }));
        return;
      }
      const planRevision = loaded.revision.content_sha256;
      // 受检导入（C-015 接线）：生产读入口与提交路径共用同一份引用判据——图纸若挂上
      // 解析不到的需求/变更引用，这里点名拒，不静默照常返回；旧图纸（全 null 引用）一条都不查
      const { definitions } = importPlanChecked(loaded.text, projectWorkDir(id, DATA_DIR), { plan_revision: planRevision });
      // 每卡的定义哈希（"状态绑的是哪一版定义"要能一眼对上；定义哈希不含状态/时间/执行日志）
      const definitionHashes: Record<string, string> = {};
      for (const d of definitions) definitionHashes[d.task_id] = taskDefinitionHash(d);
      const projection = readTaskStates(projectWorkDir(id, DATA_DIR));
      const alignment = alignDefinitionsAndStates(definitions, projection.states, planRevision);
      const lines = loaded.text.split(/\r?\n/);
      // 卡片 ↔ 原文双向定位的原料：每卡的正文小节原文 + 表格行原文 + 行范围（1 起）
      const excerpts: Record<
        string,
        { section_text: string | null; row_text: string | null; section_lines: [number, number] | null; row_line: number }
      > = {};
      for (const d of definitions) {
        excerpts[d.task_id] = {
          section_text:
            d.section_lines === null
              ? null
              : lines.slice(d.section_lines[0] - 1, d.section_lines[1]).join("\n"),
          row_text: lines[d.row_line - 1] ?? null,
          section_lines: d.section_lines,
          row_line: d.row_line,
        };
      }
      const active = activeBaseline(id, DATA_DIR);
      res.end(
        JSON.stringify({
          ok: true,
          plan: {
            exists: true,
            source_path: loaded.revision.source_path,
            origin: loaded.revision.origin,
            content_sha256: planRevision,
            definition_sha256: loaded.revision.definition_sha256,
            lines: loaded.revision.lines,
            baseline:
              active === null
                ? null
                : {
                    baseline_id: active.baseline_id,
                    design_revision: active.design_revision.content_sha256,
                    plan_revision: active.plan_revision.content_sha256,
                    approved_by: active.approved_by,
                    approval_kind: active.approval_kind,
                    active_at: active.active_at,
                  },
            // 定义（施工合同）与状态（事件派生）**分开给**，界面不合并成"完成度"（§2.6）
            definitions,
            definition_hashes: definitionHashes,
            states: projection.states,
            alignment,
            excerpts,
          },
        }),
      );
    } catch (e) {
      wsFail(e);
    }
    return;
  }

  const discussionsReadMatch = requestPathOf(req.url).match(/^\/api\/projects\/([^/]+)\/discussions$/);
  if (req.method === "GET" && discussionsReadMatch) {
    try {
      const id = decodePathSegment(discussionsReadMatch[1]);
      const doc = readDiscuss(id, DATA_DIR);
      // discussion_ref 的「原源」必须是**项目根内相对路径**（可移植、跨机可对账），
      // 不用 readDiscuss 回的绝对路径——绝对路径换个机器就对不上，处置记录会整批失去意义
      const isSelf = id === "tatai" || getProject(id)?.self_managed === true;
      const discussSource = isSelf ? "DESIGN.md" : `${WORKBENCH_DIRNAME}/design.discuss.md`;
      const workDir = projectWorkDir(id, DATA_DIR);
      // 处置记录落在 `.工作台/decisions.jsonl`（与 baselines.jsonl 同一层，§2.6 三件套并列），
      // **不是** `work/` 下的 v2 事实；`.工作台/work/` 只放事件与快照
      const decisionsDir = projectWorkbenchDir(id, DATA_DIR);
      const { records, corrupt } = readDecisions(decisionsDir);
      const entries = doc.exists ? discussionEntriesOf(doc.content, discussSource) : [];
      const dispositions = deriveDispositions(entries, records);
      // 采纳 ≠ 已实现（§3.5）：对"采纳/被替代且关联了任务"的条目，现算关联任务的真实状态与用户验收
      const tasksProjection = readTaskStates(workDir);
      const acceptances = Object.values(readAuditRecords(workDir).acceptances);
      const implementations: Record<string, ReturnType<typeof relatedImplementationOf>> = {};
      for (const [key, disp] of Object.entries(dispositions)) {
        const taskId = disp.decision?.related.task_id ?? null;
        if (taskId === null) continue;
        const state = tasksProjection.states[taskId] ?? null;
        implementations[key] = relatedImplementationOf(
          taskId,
          state === null ? null : { status: state.status, status_label: state.status_label },
          acceptanceDimensionOf(acceptances, { task_id: taskId }),
        );
      }
      res.end(
        JSON.stringify(
          withoutLocalPaths(
            {
              ok: true,
              discussions: {
                exists: doc.exists,
                is_tatai: isSelf,
                source: doc.exists ? discussSource : null,
                entries: entries.map((e) => ({
                  index: e.index,
                  ref: e.ref,
                  text: e.text,
                  disposition: dispositions[discussionRefKey(e.ref)],
                })),
                decisions: records,
                implementations,
                corrupt,
                decisions_path: `${WORKBENCH_DIRNAME}/${DECISIONS_FILE}`,
              },
            },
            guard.remote,
          ),
        ),
      );
    } catch (e) {
      wsFail(e);
    }
    return;
  }

  const discussionsDecideMatch = requestPathOf(req.url).match(
    /^\/api\/projects\/([^/]+)\/discussions\/decisions$/,
  );
  if (req.method === "POST" && discussionsDecideMatch) {
    withWs((body) => {
      const id = decodePathSegment(discussionsDecideMatch[1]);
      if (!getProject(id)) throw new WsError("PROJECT_NOT_FOUND", `项目不存在: ${id}`);
      const doc = readDiscuss(id, DATA_DIR);
      if (!doc.exists) throw new WsError("INVALID_INPUT", "该项目还没有待议记录，处置无处可挂");
      const isSelf = id === "tatai" || getProject(id)?.self_managed === true;
      const discussSource = isSelf ? "DESIGN.md" : `${WORKBENCH_DIRNAME}/design.discuss.md`;
      const entries = discussionEntriesOf(doc.content, discussSource);
      const input = validateDecisionInput(body);
      // 处置必须落在**当前**待议原文上：原文/序号对不上就拒（不写一条挂错原文的记录）
      const entry = entries.find(
        (e) =>
          e.ref.index === input.discussion_ref.index &&
          e.ref.content_sha256 === input.discussion_ref.content_sha256,
      );
      // 原源以服务端算出的相对路径为准（客户端换机器/手改路径都不该影响"挂在哪条原文上"）
      const normalized: typeof input = {
        ...input,
        discussion_ref: { ...input.discussion_ref, source: discussSource },
      };
      if (entry === undefined) {
        throw new WsError(
          "INVALID_INPUT",
          "discussion_ref 对不上任何待议条目（原文或序号已变）：请重新读取待议记录后再处置，不写挂错原文的记录",
        );
      }
      // 适用版本如实填：调用方没给就取**处置当时生效基线**的图纸修订（没有基线就 null，不编造）
      const active = activeBaseline(id, DATA_DIR);
      const record = appendDecision(projectWorkbenchDir(id, DATA_DIR), {
        ...normalized,
        applicable: {
          design_revision:
            normalized.applicable?.design_revision ?? active?.design_revision.content_sha256 ?? null,
          plan_revision:
            normalized.applicable?.plan_revision ?? active?.plan_revision.content_sha256 ?? null,
        },
      });
      const after = readDecisions(projectWorkbenchDir(id, DATA_DIR));
      const dispositions = deriveDispositions(entries, after.records);
      return withoutLocalPaths(
        {
          ok: true,
          decision: record,
          disposition: dispositions[discussionRefKey(record.discussion_ref)] ?? null,
          decisions_count: after.records.length,
        },
        guard.remote,
      );
    });
    return;
  }

  const acceptanceMatch = requestPathOf(req.url).match(/^\/api\/projects\/([^/]+)\/acceptance$/);
  if (req.method === "GET" && acceptanceMatch) {
    try {
      const id = decodePathSegment(acceptanceMatch[1]);
      if (!getProject(id)) throw new WsError("PROJECT_NOT_FOUND", `项目不存在: ${id}`);
      const facts = collectProjectFacts(id, DATA_DIR);
      // 与 status-projection 同一份两趟口径（先判依赖释放，再算主状态）——验收页读的是**同一份**
      // 状态投影，不另立一套"验收专用状态"（两套状态就是两个真相）。
      const withAcceptance = (objs: ReturnType<typeof objectsFromFacts>) =>
        objs.map((o) => ({
          ...o,
          acceptance:
            o.object_kind === "task"
              ? acceptanceDimensionOf(Object.values(facts.audit.acceptances), { task_id: o.object_id })
              : ("pending" as const),
        }));
      const pass1 = projectStatuses({
        objects: withAcceptance(objectsFromFacts(id, DATA_DIR, facts)),
        findings: facts.findings,
        checks: checksFromAudit(facts.audit),
        source_revision: facts.revisions,
        binding_segments: facts.binding_segments,
      });
      const releases: Record<string, { released: boolean; reasons: string[] }> = {};
      for (const def of facts.definitions) {
        for (const dep of def.dependency_ids) {
          const prereq = pass1.by_id[dep];
          if (prereq === undefined) continue;
          releases[`${dep}->${def.task_id}`] = dependencyRelease({
            prerequisite_id: dep,
            prerequisite: prereq,
            evidence_requirement:
              def.dependency_evidence.find((d) => d.dependency_id === dep)?.evidence ?? null,
          });
        }
      }
      const projection = projectStatuses({
        objects: withAcceptance(objectsFromFacts(id, DATA_DIR, facts, { dependency_releases: releases })),
        findings: facts.findings,
        checks: checksFromAudit(facts.audit),
        source_revision: facts.revisions,
        binding_segments: facts.binding_segments,
      });
      const manifest = evidenceManifest(facts.work_dir);
      const manifestById = new Map(manifest.map((m) => [m.evidence_id, m]));
      const defsById = new Map(facts.definitions.map((d) => [d.task_id, d]));
      const acceptances = Object.values(facts.audit.acceptances);
      const submissions = Object.values(facts.audit.submissions);
      // 补修包 F ③：可体验入口来自**成果登记**（谁的成果、哪一版、什么时候验的），
      // **不来自用户的验收记录**——所以用户还没接受时，入口照样能显示。
      const runtimeNow = Date.now();
      const runtimeSources: RuntimeEntrySource[] = [
        ...submissions.map((s) => ({
          kind: "submission" as const,
          record_id: s.record_id,
          task_id: s.task_id,
          submitted_by: s.submitted_by,
          at: s.at,
          revision: s.binding?.revision ?? null,
          revision_kind: s.binding?.revision_kind ?? null,
          entries: s.runtime_entries,
        })),
        // 补修 F3：**Agent 结果回报**那条路径（`task.result_submitted`）。两条路径形状/校验/状态判定同一套，
        // 只是来源不同；读取侧一律从权威事实装配，不靠调用方在进程内传参（§3.7）。
        ...facts.result_runtime_sources,
      ];
      // 2026-09-20（补修 F2）：`reviewMs` 只产出"待重新验证"，**不判不可达、不撤打开入口**；
      // 版本轴另算——拿当前事实里的代码版本对比，过期与"打不开"是两条互不覆盖的判断。
      const runtimeEntries = runtimeEntryViews(runtimeSources, runtimeNow, {
        reviewMs: RUNTIME_ENTRY_REVIEW_MS,
        currentRevision: facts.revisions.code ?? null,
      });
      const runtimeSummary = runtimeEntrySummaryOf(runtimeEntries);
      const tasks = Object.keys(facts.task_states)
        .sort()
        .map((taskId) => {
          const p = projection.by_id[taskId] ?? null;
          const def = defsById.get(taskId) ?? null;
          const state = facts.task_states[taskId];
          // 逐任务取"最近一次验收 / 最近一次结果提交"：同样按**真实时刻**，非法/缺失时间排最前，
          // 抢不到"最新"；同一任务全部时间都非法时退化为事实顺序（事件顺序）。
          const acc = acceptances
            .filter((a) => a.task_id === taskId)
            .sort((a, b) => compareIsoTime(a.at, b.at));
          const latestAcc = acc.length === 0 ? null : acc[acc.length - 1];
          const submission = latestByTime(
            submissions.filter((s) => s.task_id === taskId),
            (s) => s.at,
          );
          // 旧结论的哈希（§5.6：源变了的那些证据不再有效，界面必须说清"这条证据已经不作数"）
          const supersededShas = new Set(
            (p?.history ?? []).map((h) => h.evidence_sha256).filter((s): s is string => s !== null),
          );
          // 证据引用三处合起来：投影里的必需项证据 + 用户验收记录里的 + **成果登记里执行者自己交的**
          // （补修 F：纯后端"真实输入/期望/实际/证据"里的证据就是成果登记交上来的那几条；
          //   找不到正文的如实显示为 missing/不作数，不伪造）
          const evidenceIds = [
            ...new Set([
              ...(p?.evidence_refs ?? []),
              ...acc.flatMap((a) => a.evidence_refs),
              ...(submission?.evidence_refs ?? []),
            ]),
          ];
          const evidence = evidenceIds.map((eid) => {
            const m = manifestById.get(eid);
            if (m === undefined) {
              return {
                evidence_id: eid,
                kind: "missing",
                summary: "引用的证据不在证据清单里（清单里没有这条）",
                recovery_path: null,
                intact: false,
                effective: false,
              };
            }
            // 证据正文按内容寻址：`evidence_id` 就是它的 sha256（与 history[].evidence_sha256 同口径）
            const isSuperseded = supersededShas.has(m.evidence_id);
            return { ...m, effective: m.intact && !isSuperseded };
          });
          // 场景引用：只把 http(s) 的当可打开入口（§3.7）；其余（如"走一遍下单流程"）按可读场景文本给
          const scenarioRefs = [...new Set(acc.flatMap((a) => a.scenario_refs))];
          const scenarios = scenarioRefs.map((ref) => {
            const url = /^https?:\/\//i.test(ref) ? ref : null;
            return { ref, url, kind: url === null ? "text" : "link" };
          });
          return {
            task_id: taskId,
            goal: def?.goal ?? p?.label ?? taskId,
            deliverables: def?.deliverables ?? null,
            evidence_requirement: def?.evidence_requirement ?? null,
            checks: def?.acceptance?.checks ?? [],
            execution_status: state?.status ?? null,
            execution_label: state?.status_label ?? null,
            display_status: p?.display_status ?? null,
            display_status_label: p?.display_status_label ?? null,
            reasons: p?.reasons ?? [],
            missing: p?.missing ?? [],
            acceptance: p?.acceptance ?? "pending",
            acceptance_records: acc,
            latest_acceptance: latestAcc,
            evidence,
            scenarios,
            submission:
              submission === null
                ? null
                : {
                    record_id: submission.record_id,
                    at: submission.at,
                    submitted_by: submission.submitted_by,
                    commands: submission.commands,
                    untested: submission.untested,
                    known_issues: submission.known_issues,
                    changed_files: submission.changed_files,
                    evidence_refs: submission.evidence_refs,
                  },
            // 纯后端项目的**可读场景**（§3.7：输入/期望/实际/证据；塔台不执行外部命令）
            readable_scenario: {
              input:
                submission === null
                  ? "（还没有任何结果提交，因此没有可复现的输入）"
                  : submission.commands.length > 0
                    ? submission.commands.map((c) => `${c.command}（exit ${c.exit_code}）`).join(" · ")
                    : "（这次提交没有登记验证命令）",
              expected:
                (def?.acceptance?.checks ?? []).map((c) => c.text).join("；") ||
                def?.evidence_requirement ||
                "（施工图里没有验收检查项）",
              actual:
                state === null ? "没有任何执行状态" : `执行状态：${state.status_label}`,
              evidence:
                evidence.length === 0
                  ? "（没有绑定任何证据）"
                  : evidence.map((e) => `${e.effective ? "有效" : "已失效"}：${e.summary}`).join("；"),
              result: p?.display_status ?? null,
            },
            // 结果入口口径（§3.7 / 补修包 F）：入口来自**成果登记**（见 runtime_entries），
            // 不是用户的验收记录。塔台**不执行外部命令、不跑任意协议**：登记里非 http(s) 的地址
            // 在读侧就被拒，前端打开时再过一遍协议白名单（见 src/ui/result-entry.ts）。
            result_entry: taskResultEntry(runtimeEntries.filter((v) => v.source_task_id === taskId)),
          };
        });
      const counts = { pending: 0, accepted: 0, rejected: 0, accepted_known_limit: 0 };
      for (const t of tasks) counts[t.acceptance] += 1;
      res.end(
        JSON.stringify(
          withoutLocalPaths(
            {
              ok: true,
              acceptance: {
                last_seq: facts.last_seq,
                baseline: facts.baseline,
                tasks,
                pending: tasks.filter((t) => t.acceptance === "pending").map((t) => t.task_id),
                evidence_manifest: manifest,
                counts,
                // 补修包 F：项目级可体验运行入口（装配自成果登记，**不依赖用户验收记录**）
                runtime_entries: runtimeEntries,
                runtime_entry_summary: runtimeSummary,
                basis:
                  "人工验收只由真实用户记录（§5.8）：没有用户记录就是 pending，不接受质量状态自动代写；" +
                  "可体验入口来自成果登记（§3.7），打开入口不等于用户验收接受",
              },
            },
            guard.remote,
          ),
        ),
      );
    } catch (e) {
      wsFail(e);
    }
    return;
  }
  if (req.method === "POST" && acceptanceMatch) {
    withWs((body) => {
      const id = decodePathSegment(acceptanceMatch[1]);
      const input = body as Record<string, unknown>;
      const decision = String(input.decision ?? "");
      if (decision !== "accept" && decision !== "reject" && decision !== "accept_known_limit") {
        throw new WsError(
          "INVALID_INPUT",
          `decision 只接受 accept/reject/accept_known_limit（收到 ${JSON.stringify(input.decision)}）`,
        );
      }
      const decisionCn = decision === "accept" ? "accepted" : decision === "reject" ? "rejected" : "limit";
      const taskId = typeof input.task_id === "string" && input.task_id.trim() !== "" ? input.task_id.trim() : null;
      const scenarioRefs = Array.isArray(input.scenario_refs)
        ? input.scenario_refs.filter((s): s is string => typeof s === "string" && s !== "")
        : [];
      const evidenceRefs = Array.isArray(input.evidence_refs)
        ? input.evidence_refs.filter((s): s is string => typeof s === "string" && s !== "")
        : [];
      // 人工验收**只接受真实用户身份**（§5.8）：role 固定 user，Agent/技术审定不得代签
      const receipt = submitHumanAcceptance(workHost.service, {
        project_id: id,
        change_id: "manual-acceptance",
        actor_id: typeof input.accepted_by === "string" && input.accepted_by.trim() !== "" ? input.accepted_by.trim() : "user",
        role: "user",
        record_id: `acc-${id}-${decisionCn}-${Date.now()}`,
        decision,
        task_id: taskId,
        scenario_refs: scenarioRefs,
        evidence_refs: evidenceRefs,
        accepted_by: typeof input.accepted_by === "string" && input.accepted_by.trim() !== "" ? input.accepted_by.trim() : "user",
        note: typeof input.note === "string" && input.note.trim() !== "" ? input.note.trim() : null,
      });
      const records = readAuditRecords(projectWorkDir(id, DATA_DIR));
      return withoutLocalPaths(
        {
          ok: true,
          receipt,
          acceptance: taskId === null ? null : acceptanceDimensionOf(Object.values(records.acceptances), { task_id: taskId }),
        },
        guard.remote,
      );
    });
    return;
  }

  // GET /api/projects/:id/design —— 读设计书全文（D1，§3.5 只读展示）。
  // 口径：塔台（self_managed 或 id=="tatai"）读 <repo>/DESIGN.md（AGENTS.md §7 塔台自身例外），
  // 其他项目读 <项目根>/.工作台/design.md（§2.2）；不存在返回 {ok:true,design:{exists:false}}（200 空态，不是错误）。
  // ████████████████████████████ 红线 ████████████████████████████
  // 设计书【只读 + 唯一写口 = 落稿笔】：PUT/DELETE /design 一律 404；POST /design 本体也 404。
  // 唯一的写接口是下方 POST /design/append（D3 落稿笔，§3.5 两条笔之一）——塔台自身同样
  // 开放（2026-09-19 主人拍板解锁，落点在 DESIGN.md 附录 B 之前）；POST /design/draft 只生成
  // 草稿（读会话 + 调 flash），不落盘。
  // ███████████████████████████████████████████████████████████████
  if (req.method === "GET" && sub && sub[2] === "design" && !sub[3]) {
    try {
      res.end(
        JSON.stringify(
          withoutLocalPaths({ ok: true, design: readDesign(decodePathSegment(sub[1])) }, guard.remote),
        ),
      );
    } catch (e) {
      wsFail(e);
    }
    return;
  }

  // GET /api/projects/:id/design/draft —— B3 逆向草稿读取（§9.2）：读 .工作台/design.draft.md。
  // 草稿不是 design.md，互不混淆；不存在返回 {ok:true,draft:{exists:false}}（200 空态）。
  // Q138（2026-09-19 审计）：草稿派生自记忆检索（reverseDraft.ts 把 memory.results 塞进提示词、
  // 落盘件还带「- 历史记忆：…」段），**远程闸门在放行口**——auth.ts 的 `isMemoryDerivedReadPath`
  // 把它并进记忆闸门（默认 403 REMOTE_MEMORY_HIDDEN）。这里不再补一道，避免两处口径分叉。
  if (req.method === "GET" && sub && sub[2] === "design" && sub[3] === "draft") {
    try {
      res.end(
        JSON.stringify(
          withoutLocalPaths(
            {
              ok: true,
              draft: readReverseDraft(decodePathSegment(sub[1])),
              // V06-07 双文档链：第二份草稿（剩余施工）与第一份同路径读回，前端一次拿齐两份。
              plan_draft: readReversePlanDraft(decodePathSegment(sub[1])),
            },
            guard.remote,
          ),
        ),
      );
    } catch (e) {
      wsFail(e);
    }
    return;
  }

  // POST /api/projects/:id/design/draft —— 两个起草入口共路径，按 body 分流：
  //   · body 带 session_id → D3 落稿第 ① 步：读会话消息，用 flash chat() 把讨论提炼成
  //     "可落入设计书的条目"返回草稿文本——【只读 + LLM 调用，不写任何文件】；草稿由前端弹窗
  //     交给用户编辑，用户确认后才走 /design/append 落盘（§3.6：不点就绝不写）。密钥只走服务端（C1 红线）。
  //   · body 不带 session_id → B3 逆向落稿（§9.2）：扫描 + 记忆检索 → Flash 起草四块雏形
  //     （项目是什么/模块划分/当前实际阶段/Gate 标在哪一步）→ 落 .工作台/design.draft.md。
  //     已有 design.md → 不覆盖，200 返回 {conflict:true} + 待议通道提示（DoD⑤）。
  //     重复调用 = 重生成草稿（覆盖旧 draft 文件，不碰 design.md）。
  // Q16（2026-09-18 审计）：这条**派生**通道读的是聊天/记忆正文，闸门必须与两条读接口同口径——
  //   放行口（auth.ts）只按路径判，而本路由靠 body 分流（带 session_id = 读聊天、不带 = 读记忆），
  //   路径级闸门分辨不出这两支，故在分流处按分支补判（**只对非回环来源生效**：回环 = 桌面 UI 的
  //   信任域，与既有闸门口径一致，本地行为逐字不变）。
  if (req.method === "POST" && sub && sub[2] === "design" && sub[3] === "draft") {
    const projectId = decodePathSegment(sub[1]);
    readJsonBody(req)
      .then(async (body) => {
        const input = body as Record<string, unknown>;
        try {
          const distillFromChat = typeof input.session_id === "string" && input.session_id !== "";
          if (guard.remote) {
            const hiding = distillFromChat
              ? !remoteConfig.chatExposed
                ? {
                    code: "REMOTE_CHAT_HIDDEN",
                    message:
                      "会话提炼读的是聊天正文，与聊天读接口同口径（默认关闭，见 DESIGN.md §10.2）" +
                      `——要在主机上显式置位 ${REMOTE_CHAT_ENV}=1 重启后才允许`,
                  }
                : null
              : !remoteConfig.memoryExposed
                ? {
                    code: "REMOTE_MEMORY_HIDDEN",
                    message:
                      "逆向起草要读记忆原文摘要，与记忆读接口同口径（默认关闭，见 DESIGN.md §10.2）" +
                      `——要在主机上显式置位 ${REMOTE_MEMORY_ENV}=1 重启后才允许`,
                  }
                : null;
            if (hiding) {
              res.statusCode = 403;
              res.end(JSON.stringify({ ok: false, error: hiding }));
              return;
            }
          }
          // ── B3 逆向落稿起草（无 session_id）──
          if (!distillFromChat) {
            const result = await draftDesign(projectId, {
              ...(typeof input.memory_timeout_ms === "number"
                ? { memoryTimeoutMs: input.memory_timeout_ms }
                : {}),
            });
            // F6：result 里 draft_source 等键带本机路径，远程裁掉（草稿文本本身是字符串，不受影响）
            res.end(JSON.stringify(withoutLocalPaths({ ok: true, result }, guard.remote)));
            return;
          }
          // ── D3 落稿草稿（有 session_id）──
          const sid = String(input.session_id ?? "");
          const history = readSession(projectId, sid);
          if (history.length === 0) {
            throw new WsError("INVALID_INPUT", "会话还没有消息，无可提炼的讨论");
          }
          const transcript = history
            .map((m) => `${m.role === "user" ? "用户" : "Flash"}：${m.content}`)
            .join("\n\n");
          const draft = await flashChat(
            [
              {
                role: "system",
                content:
                  "你是设计书落稿助手。把讨论提炼成可直接落入 design.md 的 markdown 条目片段：" +
                  "只保留已确认的结论、口径与决定，不照搬闲聊过程；用条目/小节组织，不要解释、不要客套。",
              },
              { role: "user", content: `把以下讨论提炼成可落入设计书的条目：\n\n${transcript}` },
            ],
            // chatWithContinue：长讨论提炼出的草稿可能超单次输出上限，截断自动续写（§3.6）
            { model: DEFAULT_MODEL },
          );
          res.end(JSON.stringify({ ok: true, draft, model: DEFAULT_MODEL }));
        } catch (e) {
          wsFail(e);
        }
      })
      .catch((e: Error) => wsFail(new WsError("INVALID_INPUT", e.message)));
    return;
  }

  // POST /api/projects/:id/design/finalize { gate_step, note? } —— B3 定版入口（§9.2/§9.3）：
  // 【只能由人/Max 触发】——gate_step 是人确认后的 Gate 位置（推断初值只是 UI 默认值）。
  // 动作：草稿转正为 design.md（无则建；已有 design.md 拒绝不覆盖）→ progress.json 逐步
  // pass 到确认步（每步留 gate.jsonl 行 by:"user" note"逆向落稿定版"）→ 落对账钩子
  // .工作台/arch/reconcile-request.json（A5 消费，DoD④）。无草稿 → 400。
  if (req.method === "POST" && sub && sub[2] === "design" && sub[3] === "finalize") {
    withWs((body) => {
      const input = body as Record<string, unknown>;
      const result = finalizeDraft(decodePathSegment(sub[1]), {
        gate_step: String(input.gate_step ?? ""),
        note: typeof input.note === "string" ? input.note : null,
      });
      return withoutLocalPaths({ ok: true, result }, guard.remote); // F6：design_source 等键同口径裁剪
    });
    return;
  }

  // POST /api/projects/:id/design/append { content } —— D3 落稿第 ② 步：确认后落盘。
  // content 是【用户在预览弹窗里确认（可编辑过）的草稿】，服务端原样写入 design.md：
  // 被纳管项目追加到末尾；塔台自身插入到 repo 根 DESIGN.md「附录 B」标题之前
  // （读全文→定位→原子写回→前后段逐字节复核；2026-09-19 主人拍板解锁塔台落稿）。
  if (req.method === "POST" && sub && sub[2] === "design" && sub[3] === "append") {
    withWs((body) => {
      const input = body as Record<string, unknown>;
      const result: DesignAppendResult = appendDesign(
        decodePathSegment(sub[1]),
        String(input.content ?? ""),
      );
      return withoutLocalPaths({ ok: true, result }, guard.remote); // F6：source 键远程裁掉
    });
    return;
  }

  // GET /api/projects/:id/progress —— 读 progress.json（§2.3.2）；缺文件自动初始化（幂等）
  // S3 审计（DoD② 后半）：初始化是**服务端自己的副作用**，不是远程写请求（远程发的是 GET，被只读红线放行）。
  // 真建了文件就单记一条 `actor: server-init` 行（带 on_behalf_of 说明是替谁做的），与同一请求那条
  // `actor: remote` 的读记录分开——"谁在读"与"谁写了盘"在审计里不许混为一谈。
  if (req.method === "GET" && sub && sub[2] === "progress" && !sub[3]) {
    try {
      const id = decodePathSegment(sub[1]);
      const { progress, initialized } = readProgressReportingInit(id);
      if (initialized.length > 0) {
        auditLog?.record({
          actor: "server-init",
          action: "side-effect",
          ip: sourceIp,
          method: reqMethod,
          path: reqPath,
          status: 200,
          code: null,
          fingerprint: guard.fingerprint,
          credential: credentialKindOf(credentialFromHeader(req.headers.authorization)),
          project_id: id,
          source: null,
          on_behalf_of: guard.remote ? "remote" : "local",
          files: initialized,
          note:
            `服务端自身副作用：读 progress 时缺文件，自动初始化建了 ${initialized.join("、")}` +
            "（发起方是读请求，不是远程写请求）",
        });
      }
      res.end(JSON.stringify(withoutLocalPaths({ ok: true, progress }, guard.remote)));
    } catch (e) {
      wsFail(e);
    }
    return;
  }
  // POST /api/projects/:id/gate { step, result, note? } —— 人手点过关/打回（§5.2）：
  // 同步 progress history + current_step，并追加一行 gate.jsonl（只追加，永不改历史行）。
  // G3 权限口径（在 recordGateTransition 内强制）：by 固定 "user"、reject 必填 note、只能对当前步转移。
  // A5（§4.5 对账长在 Gate 流程上）：每次过关/打回自动跑一次对账，结果落
  // .工作台/arch/reconcile-last.json 并随响应带回（reconcile 字段），作为过关参考之一。
  // 对账是【信号不是错误】：reconcile 失败绝不阻断 Gate——try/catch 包住，失败只带 reconcile_error。
  if (req.method === "POST" && sub && sub[2] === "gate" && !sub[3]) {
    withWs((body) => {
      const input = body as Record<string, unknown>;
      const projectId = decodePathSegment(sub[1]);
      const progress = recordGateTransition(projectId, {
        step: String(input.step ?? ""),
        result: input.result as "pass" | "reject",
        note: typeof input.note === "string" ? input.note : null,
        by: typeof input.by === "string" ? input.by : "user",
      });
      let reconcile: unknown;
      try {
        reconcile = reconcileProject(projectId, { trigger: "gate" });
      } catch (e) {
        // F5：对账失败是信号不是错误，错误文本过脱敏（可能夹本机路径）
        reconcile = { error: sanitizeErrorMessage((e as Error).message) };
      }
      return withoutLocalPaths({ ok: true, progress, reconcile }, guard.remote); // F6：reconcile 里可能带 source 键
    });
    return;
  }
  // POST /api/projects/:id/gate/back { step } —— 迭代回「需求」步（§5.1：交付后发现问题回第 ② 步重走，
  // 不是回设计或开发；目标步固定 requirement，其他目标一律 400）
  if (req.method === "POST" && sub && sub[2] === "gate" && sub[3] === "back") {
    withWs((body) => {
      const input = body as Record<string, unknown>;
      const step = String(input.step ?? "");
      if (step !== "requirement") {
        throw new WsError(
          "INVALID_STEP",
          `迭代只能回「需求」步（DESIGN.md §5.1），不接受目标: ${JSON.stringify(step)}`,
        );
      }
      const progress = setCurrentStep(decodePathSegment(sub[1]), step);
      return withoutLocalPaths({ ok: true, progress }, guard.remote); // F6：与写响应同口径
    });
    return;
  }
  // GET /api/projects/:id/gate.jsonl —— 读 gate 流水全部行（§2.3.3，jsonl 原文返回）
  if (req.method === "GET" && sub && sub[2] === "gate.jsonl") {
    try {
      const lines = readGateLines(decodePathSegment(sub[1]));
      res.setHeader("content-type", "application/x-ndjson; charset=utf-8");
      res.end(
        lines.map((l) => JSON.stringify(withoutLocalPaths(l, guard.remote))).join("\n") +
          (lines.length ? "\n" : ""),
      );
    } catch (e) {
      wsFail(e);
    }
    return;
  }
  // GET /api/projects/:id/tasks —— 列举任务（§2.3.4）
  if (req.method === "GET" && sub && sub[2] === "tasks" && !sub[3]) {
    try {
      res.end(
        JSON.stringify(
          withoutLocalPaths({ ok: true, tasks: listTasks(decodePathSegment(sub[1])) }, guard.remote),
        ),
      );
    } catch (e) {
      wsFail(e);
    }
    return;
  }
  // POST /api/projects/:id/tasks { id, title, module_id, reporter, status? } —— 新增任务
  if (req.method === "POST" && sub && sub[2] === "tasks" && !sub[3]) {
    withWs((body) => {
      const input = body as Record<string, unknown>;
      const task = addTask(decodePathSegment(sub[1]), {
        id: String(input.id ?? ""),
        title: String(input.title ?? ""),
        module_id: String(input.module_id ?? ""),
        reporter: String(input.reporter ?? ""),
        ...(typeof input.status === "string" ? { status: input.status as TaskStatus } : {}),
      });
      return withoutLocalPaths({ ok: true, task }, guard.remote); // F6：与写响应同口径
    });
    return;
  }
  // POST /api/projects/:id/tasks/:taskId/status { status } —— 任务状态自报（§5.3 四值）
  if (req.method === "POST" && sub && sub[2] === "tasks" && sub[3] && sub[4] === "status") {
    withWs((body) => {
      const input = body as Record<string, unknown>;
      const task = setTaskStatus(
        decodePathSegment(sub[1]),
        decodePathSegment(sub[3]),
        input.status as TaskStatus,
      );
      return withoutLocalPaths({ ok: true, task }, guard.remote); // F6：与写响应同口径
    });
    return;
  }
  // POST /api/projects/:id/modules { id, name?, status? } —— 新增模块（§2.3.2）
  if (req.method === "POST" && sub && sub[2] === "modules" && !sub[3]) {
    withWs((body) => {
      const input = body as Record<string, unknown>;
      const module = addModule(decodePathSegment(sub[1]), {
        id: String(input.id ?? ""),
        name: String(input.name ?? input.id ?? ""),
        ...(typeof input.status === "string" ? { status: input.status as ModuleStatus } : {}),
      });
      return withoutLocalPaths({ ok: true, module }, guard.remote); // F6：与写响应同口径
    });
    return;
  }
  // POST /api/projects/:id/modules/:moduleId/status { status } —— 模块四色状态（§2.3.2 四值）
  if (req.method === "POST" && sub && sub[2] === "modules" && sub[3] && sub[4] === "status") {
    withWs((body) => {
      const input = body as Record<string, unknown>;
      const progress = setModuleStatus(
        decodePathSegment(sub[1]),
        decodePathSegment(sub[3]),
        input.status as ModuleStatus,
      );
      return withoutLocalPaths({ ok: true, progress }, guard.remote); // F6：与写响应同口径
    });
    return;
  }

  // ── C2：聊天记录落盘（DESIGN.md §2.3.6 / §3.6）──
  // 路由：POST /api/projects/:id/chat/sessions（创建）→ {session_id}
  //       GET  /api/projects/:id/chat/sessions（列表，按最后写入倒序，带首条消息摘要）
  //       GET  /api/projects/:id/chat/sessions/:sid（读回消息数组，供续接）
  //       POST /api/projects/:id/chat/sessions/:sid/messages {content}（发问 + SSE 流式回答）
  // 路径安全：sid 只收 [0-9A-Za-z_-]（chat.assertSessionId），`../x`、`..%2Fx` 等穿越形态
  // 一律 400 INVALID_INPUT，在拼路径之前拦下；项目 id 一律走注册表解析。
  const chatMatch = req.url?.match(
    /^\/api\/projects\/([^/]+)\/chat\/sessions(?:\/([^/]+)(\/messages)?)?$/,
  );
  // POST /api/projects/:id/chat/sessions —— 创建会话（建空 jsonl 文件，建会话即分文件）
  if (req.method === "POST" && chatMatch && !chatMatch[2]) {
    try {
      const sessionId = createSession(decodePathSegment(chatMatch[1]));
      res.end(JSON.stringify({ ok: true, session_id: sessionId }));
    } catch (e) {
      wsFail(e);
    }
    return;
  }
  // GET /api/projects/:id/chat/sessions —— 列出会话（倒序 + 首条消息摘要）
  if (req.method === "GET" && chatMatch && !chatMatch[2]) {
    try {
      res.end(
        JSON.stringify({ ok: true, sessions: listSessions(decodePathSegment(chatMatch[1])) }),
      );
    } catch (e) {
      wsFail(e);
    }
    return;
  }
  // GET /api/projects/:id/chat/sessions/:sid —— 读回消息数组（jsonl 原文口径，含 ts/model）
  if (req.method === "GET" && chatMatch && chatMatch[2] && !chatMatch[3]) {
    try {
      const messages = readSession(
        decodePathSegment(chatMatch[1]),
        decodePathSegment(chatMatch[2]),
      );
      res.end(JSON.stringify({ ok: true, session_id: decodePathSegment(chatMatch[2]), messages }));
    } catch (e) {
      wsFail(e);
    }
    return;
  }
  // DELETE /api/projects/:id/chat/sessions/:sid —— 删除会话（2026-09-19 主人试用报障：
  // 聊天页没有手动删会话的入口，测试/误建的会话删不掉）。jsonl 连带删除不可恢复；
  // 写操作——远程模式下统一过写开关（guardRemoteRequest 对非读方法拦截，与 POST 创建同口径）；
  // 聊天闸门（S2）按 sessions 路径前缀生效，DELETE 一并默认不下发。
  if (req.method === "DELETE" && chatMatch && chatMatch[2] && !chatMatch[3]) {
    try {
      // V06-07（§3.6）：没有有效引用的普通聊天照旧删除；**被动作引用的会话转归档留引用**
      // （内容挪到 chat/archive/，动作记录里的引用仍可核实）——删除行为在响应里如实说明。
      const result = deleteSession(decodePathSegment(chatMatch[1]), decodePathSegment(chatMatch[2]));
      res.end(JSON.stringify({ ok: true, ...result }));
    } catch (e) {
      wsFail(e);
    }
    return;
  }
  // ── V06-07：聊天动作（DESIGN.md §3.5–§3.6 / §3.12）──
  // GET  /api/projects/:id/chat/actions?session_id=… —— 读动作回执（重新打开会话/重开进程后可核实）
  // POST /api/projects/:id/chat/actions —— 按 op 分流：
  //   · run（默认）：body { session_id?, text, selection? } 显式跑一次动作（自然表达触发的兜底入口）
  //   · retry：body { action_id } 续接失败动作（输入与幂等键都在记录里，不产生第二个动作）
  //   · activate：body { action_id, approved_by, approval_basis, approval_kind }
  //     审定并激活提案——**唯一会写现行图纸的动作**，其余动作只写 .工作台/work/ 下的派生件。
  // 闸门：动作记录含用户的聊天原话（派生自聊天正文），**与聊天读接口同口径**——非回环来源要
  // 显式 `TATAI_REMOTE_CHAT=1` 才下发（S2 的 `isChatReadPath` 只认 `chat/sessions*`，
  // 那条正则与它的断言都不动，闸门在本路由内按分支补判，同 POST design/draft 的 Q16 先例）。
  const chatActionsMatch = requestPathOf(req.url).match(/^\/api\/projects\/([^/]+)\/chat\/actions$/);
  if (req.method === "GET" && chatActionsMatch) {
    try {
      if (guard.remote && !remoteConfig.chatExposed) {
        res.statusCode = 403;
        res.end(
          JSON.stringify({
            ok: false,
            error: {
              code: "REMOTE_CHAT_HIDDEN",
              message:
                "动作回执含聊天原话（派生自聊天正文），与聊天读接口同口径（默认关闭，见 DESIGN.md §10.2）" +
                `——要在主机上显式置位 ${REMOTE_CHAT_ENV}=1 重启后才允许`,
            },
          }),
        );
        return;
      }
      const url = new URL(req.url ?? "/", "http://localhost");
      const sessionId = url.searchParams.get("session_id");
      const actionId = url.searchParams.get("action_id");
      if (actionId !== null) {
        const one = getChatAction(decodePathSegment(chatActionsMatch[1]), actionId);
        if (one === null) {
          res.statusCode = 404;
          res.end(JSON.stringify({ ok: false, error: { code: "NOT_FOUND", message: "动作不存在" } }));
          return;
        }
        res.end(JSON.stringify({ ok: true, action: one }));
        return;
      }
      const actions = listChatActions(
        decodePathSegment(chatActionsMatch[1]),
        sessionId === null ? {} : { sessionId },
      );
      res.end(
        JSON.stringify({
          ok: true,
          actions: actions.map(chatActionEventOf),
          phase_labels: CHAT_ACTION_STATUS_LABELS,
        }),
      );
    } catch (e) {
      wsFail(e);
    }
    return;
  }
  if (req.method === "POST" && chatActionsMatch) {
    const projectId = decodePathSegment(chatActionsMatch[1]);
    readJsonBody(req)
      .then(async (body) => {
        const input = body as Record<string, unknown>;
        const op = typeof input.op === "string" ? input.op : "run";
        try {
          if (op === "retry") {
            const action = await retryChatAction(projectId, String(input.action_id ?? ""));
            res.end(JSON.stringify({ ok: true, action: chatActionEventOf(action) }));
            return;
          }
          if (op === "activate") {
            const action = activateChatActionProposal(projectId, String(input.action_id ?? ""), {
              approved_by: String(input.approved_by ?? ""),
              approval_basis: String(input.approval_basis ?? ""),
              approval_kind:
                input.approval_kind === "user_confirmed" ? "user_confirmed" : "delegated_technical_review",
            });
            res.end(JSON.stringify({ ok: true, action: chatActionEventOf(action) }));
            return;
          }
          const text = typeof input.text === "string" ? input.text : "";
          if (text.trim() === "") {
            throw new WsError("INVALID_INPUT", "body.text 必须是非空字符串");
          }
          const sessionId = typeof input.session_id === "string" && input.session_id !== "" ? input.session_id : null;
          const r = await runChatAction({
            projectId,
            sessionId,
            text,
            selection: normalizeChatSelection(input.selection),
          });
          res.end(JSON.stringify({ ok: true, action: chatActionEventOf(r.action), deduplicated: r.deduplicated }));
        } catch (e) {
          wsFail(e);
        }
      })
      .catch((e: Error) =>
        wsFail(new WsError("INVALID_INPUT", sanitizeErrorMessage(e.message))),
      );
    return;
  }
  // GET /api/projects/:id/chat/actions/:actionId —— 单条动作回执（点开卡片看明细/失败原因）
  // 不单开路由：`?action_id=` 走上面那条 GET（少一条路由 = 少一处 s2 防漂移对账面）。

  // POST /api/projects/:id/chat/sessions/:sid/messages { content, model?, temperature? }
  // —— 发问：先同步写 user 行（实时落盘红线：API 响应流出之前已落盘），再带历史上下文
  // 调 flash.chatStream，SSE 逐 chunk 流出 delta，收齐后写 assistant 行（完整 content + model）。
  // flash 不可用（未配密钥/网络/HTTP 错误）时：user 行已落盘不丢消息，SSE 发
  // {"error": "...", "user_message_saved": true} 事件收尾（可读错误，不吞异常）。
  // body 只收 content / model / temperature——绝不接受 apiKey/baseURL（同 C1 泄钥红线）。
  if (req.method === "POST" && chatMatch && chatMatch[2] && chatMatch[3] === "/messages") {
    const projectId = decodePathSegment(chatMatch[1]);
    const sid = decodePathSegment(chatMatch[2]);
    readJsonBody(req)
      .then(async (body) => {
        const input = body as Record<string, unknown>;
        if (typeof input.content !== "string" || input.content.trim() === "") {
          res.statusCode = 400;
          res.end(
            JSON.stringify({
              ok: false,
              error: { code: "INVALID_INPUT", message: "body.content 必须是非空字符串" },
            }),
          );
          return;
        }
        // 实时落盘 DoD③：user 行在调 flash 之前同步 append；随后读回全文（含刚写的
        // user 行）作为上下文历史——落盘文件即事实源，续接上下文不依赖内存状态
        const userLine: ChatLine = { role: "user", content: input.content, ts: nowIso() };
        let history: ChatLine[];
        try {
          appendMessage(projectId, sid, userLine);
          history = readSession(projectId, sid);
        } catch (e) {
          wsFail(e);
          return;
        }
        const model = typeof input.model === "string" ? input.model : DEFAULT_MODEL;
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        let full = "";
        // ── V06-07：自然表达触发动作（DESIGN.md §3.6 的四行动作表）──
        // 认得出动作就先跑动作链路并把**真实回执**落盘 + 随 SSE 示出（六阶段文案来自回执，
        // 不靠前端猜）；认不出照常聊天。动作失败/异常绝不阻断聊天（动作自己落 failed 记录）。
        const selection = normalizeChatSelection(input.selection);
        let action: ChatAction | null = null;
        const intent = classifyChatIntent(input.content, { hasSelection: selection !== null });
        if (intent !== null) {
          try {
            action = (await runChatAction({ projectId, sessionId: sid, text: input.content, selection })).action;
          } catch (e) {
            action = null;
            console.warn(`[chat-actions] 动作未启动：${sanitizeErrorMessage((e as Error).message)}`);
          }
          if (action !== null) {
            res.write(`data: ${JSON.stringify({ action: chatActionEventOf(action) })}\n\n`);
          }
        }
        // 2026-09-19 试用增强（主人裁定：默认自动带，不加开关）：发问前现读项目实时状态
        // （设计书/进度/Gate/动作流/架构顶层模块）拼成背景，作为 system 消息置于历史之前——
        // 聊天从"盲聊"变成能对齐项目现状的讨论。材料读失败只在背景里降级一行，不阻断聊天
        // （口径见 chatContext.ts）；材料只进模型请求，不写进会话 jsonl，落盘口径不变。
        // V06-07：带 sessionId → 背景追加"本轮之前的动作回执"（真实落盘口径），
        // 并在动作刚发生时就地把这一轮的动作结果说给模型（免得它凭想象说"已生效"）。
        const context = buildChatContext(projectId, { sessionId: sid }) + actionNoteOf(action);
        // 2026-09-19 试用增强二期（主人裁定"现在就做全量"）：工具调用循环。模型可点名
        // read_file / search_code / get_arch 三只只读的"手"读项目真实文件（安全红线与上限见
        // chatTools.ts）；每轮工具结果作为 tool 消息喂回、循环直到终答。轮次/每轮只数有上限，
        // 防模型套娃。工具轮次的 assistant/tool 行只活在本次请求里，不落盘（§2.3.6 口径不变）。
        const toolMessages: FlashRoundMessage[] = [
          { role: "system", content: context },
          // Q34（2026-09-18 审计）：失败行（error 有值）不进续接上下文——它是"上一回合没答完"的
          // 记录，喂回模型只会多一轮空 assistant；历史展示（GET :sid）照旧带回全部行。
          ...history
            .filter((m) => !(m.role === "assistant" && m.error !== undefined))
            .map((m) => ({ role: m.role, content: m.content }) as FlashMessage),
        ];
        // V06-07：本轮工具调用的真实回执（先攒着，回合结束后与动作关联落盘）
        const turnTools: { name: string; summary: string; writes: { path: string; affected_ids: string[] }[] }[] = [];
        try {
          // 工具循环在 chatTurn.runChatTurn（与 MCP ask_flash 同一个循环）；这里只把
          // 事件翻成 SSE。full 由 delta 累计——模型中途抛错时半截文本留在手里（Q34 留痕用）。
          for await (const ev of runChatTurn(projectId, toolMessages, {
            model,
            ...(typeof input.temperature === "number"
              ? { temperature: input.temperature }
              : {}),
            onToolResult: (r) => turnTools.push(r),
          })) {
            if (ev.type === "delta") {
              full += ev.text;
              res.write(`data: ${JSON.stringify({ delta: ev.text })}\n\n`);
            } else {
              res.write(`data: ${JSON.stringify({ tool: { name: ev.name, summary: ev.summary } })}\n\n`);
            }
          }
        } catch (e) {
          // flash.ts 红线：错误消息只含状态码/响应体摘要，不含密钥材料；
          // F5：再过一层消息级脱敏（flash 配置错误带 config.json 的本机绝对路径）；
          // 响应头已是 SSE（无法再改状态码），以 SSE error 事件收尾；user 行已落盘不丢
          const reason = sanitizeErrorMessage((e as Error).message);
          // V06-07：图写成功但回答中断——工具回执照样与动作关联落盘（"做过的"不因回答半截而丢）
          associateTurnTools(projectId, action, turnTools);
          // Q34（2026-09-18 审计）：失败也要在会话里留痕——把这一回合如实落盘（content 是失败前
          // 收到的半截，error 记原因），否则记录里只剩"问了没答"，事后分不清是模型失败、
          // 配置缺失还是网络中断。落盘失败不改变响应（主因仍是上面那条，照发 SSE error）。
          try {
            appendMessage(projectId, sid, {
              role: "assistant",
              content: full,
              ts: nowIso(),
              model,
              error: reason,
            });
          } catch {
            /* 失败行也写不进去（磁盘/会话没了）：不覆盖原错误，响应照发 */
          }
          res.write(`data: ${JSON.stringify({ error: reason, user_message_saved: true })}\n\n`);
          res.end();
          return;
        }
        // 流式收齐后写 assistant 行（完整 content + model，§2.3.6）
        try {
          appendMessage(projectId, sid, {
            role: "assistant",
            content: full,
            ts: nowIso(),
            model,
          });
        } catch (e) {
          associateTurnTools(projectId, action, turnTools);
          res.write(`data: ${JSON.stringify({ error: sanitizeErrorMessage((e as Error).message) })}\n\n`); // F5：ENOENT 一类路径脱敏
          res.end();
          return;
        }
        // V06-07：工具动作与结果关联落盘（本轮模型真调了什么工具、真写了哪个文件）
        associateTurnTools(projectId, action, turnTools);
        res.write("data: [DONE]\n\n");
        res.end();
      })
      .catch((e: Error) => {
        // Q69（2026-09-18 审计）：这条（以及 POST /api/projects、POST /api/flash/chat 两条同形兜底）
        // 原先直接回显 e.message，与同文件邻居（wsFail 的 500、F5 的三处）口径不一致——
        // 消息里可能夹本机绝对路径，对远程等于把目录结构递出去。统一过 sanitizeErrorMessage。
        res.statusCode = 400;
        res.end(
          JSON.stringify({
            ok: false,
            error: { code: "INVALID_INPUT", message: sanitizeErrorMessage(e.message) },
          }),
        );
      });
    return;
  }

  // ── B1：项目扫描器（DESIGN.md §9.1/§9.3 逆向落稿第一卡）──
  // GET /api/projects/:id/scan —— 现扫现返：文件树规模 / README 摘要 / docs 清单 /
  // git log 活跃度 / 关键清单文件。只读，结果不缓存不落盘（缓存是后续卡的事）。
  // Q131（2026-09-19 审计）：走**异步版**扫描（`scanProjectAsync`）——git 子进程不再同步阻塞
  // 事件循环（原来两次 execFileSync 串行最坏 20s，SSE ping 与 UI 轮询全停）。
  const scanMatch = req.url?.match(/^\/api\/projects\/([^/]+)\/scan$/);
  if (req.method === "GET" && scanMatch) {
    const scanId = decodePathSegment(scanMatch[1]);
    scanProjectAsync(scanId)
      .then((scan) => {
        // 批2 T12（2026-09-20 审计轮，判词 R1-ZS-004）：命中取消检查点时只回**取消回执**，
        // 不把未完成的部分结果出网（部分结果未写入，沿用上次完整落盘状态，可能已过期）。
        if (scan.cancelled) {
          res.end(
            JSON.stringify(
              withoutLocalPaths(
                {
                  ok: true,
                  cancelled: true,
                  partial: true,
                  project_id: scan.project_id,
                  progress: scan.progress ?? null,
                  note: "扫描已在安全检查点取消：部分结果未写入，沿用上次完整落盘状态（可能已过期）",
                },
                guard.remote,
              ),
            ),
          );
          return;
        }
        // S3：扫描结果里 `root` 是项目根**绝对路径**（S2 遗留未裁的读接口之一），与相对路径的
        // readme.path / docs[].path 靠"值判定"区分开——绝对的裁掉，相对的留给界面
        res.end(JSON.stringify(withoutLocalPaths({ ok: true, scan }, guard.remote)));
      })
      .catch((e) => wsFail(e));
    return;
  }
  // 批2 T12（2026-09-20 审计轮，判词 R1-ZS-004）：DELETE /api/projects/:id/scan —— 取消该项目
  // **进行中**的全量扫描（对齐 DELETE /watch 的命名与鉴权风格；不动 DELETE /watch 的语义＝停文件监听）。
  // 没有进行中的扫描时如实回 cancelled:false 加原因，不报错；项目不存在仍 404 PROJECT_NOT_FOUND。
  if (req.method === "DELETE" && scanMatch) {
    try {
      const receipt = requestScanCancel(decodePathSegment(scanMatch[1]));
      res.end(JSON.stringify(withoutLocalPaths({ ok: true, ...receipt }, guard.remote)));
    } catch (e) {
      wsFail(e);
    }
    return;
  }

  // ── A1：顶层模块静态解析（DESIGN.md §4.1 混合管线第一层，纯静态零 LLM）──
  // POST /api/projects/:id/arch/parse —— 启动（或挂上）后台解析 run 并等它出终态：
  //   tree-sitter 真解析项目根 → 模块骨架 + import 聚合依赖边 → 落 .工作台/arch/modules.json（唯一写口）。
  //   批3终审 T19（DESIGN §11.8「全量扫描放后台且可取消」）：遍历/解析分片让出事件循环——旧形态是
  //   HTTP 回调里同步 parseProject，万级文件夹具冻结事件循环 ~3s（实测旧红）；现在前台请求不阻塞
  //   事件循环。成功应答形状与旧契约一致（ok + result{source,module_count,duration_ms,parse_ms,stats}，
  //   另附 run_id/deduplicated）；被取消时回取消回执（不下发部分结果）；失败按 wsFail 出 4xx/5xx。
  // GET    /api/projects/:id/arch/parse —— run 状态定位（进行中优先，否则最近一次；run:null = 没跑过）。
  // DELETE /api/projects/:id/arch/parse —— 取消进行中的 run：部分结果不落盘，旧 modules.json 原样保留；
  //   无进行中 run 时如实回 cancelled:false（不报错），项目不存在仍 404。
  const archParseMatch = req.url?.match(/^\/api\/projects\/([^/]+)\/arch\/parse$/);
  if (req.method === "POST" && archParseMatch) {
    const projectId = decodePathSegment(archParseMatch[1]);
    readJsonBody(req) // body 被忽略，但要排空请求流；坏 JSON 与旧 withWs 同口径 400
      .catch((e: Error) => {
        throw new WsError("INVALID_INPUT", e.message);
      })
      .then(() => {
        let handle: ReturnType<typeof startParseProjectRun>;
        try {
          handle = startParseProjectRun(projectId);
        } catch (e) {
          wsFail(e); // 项目不存在 → 404（与旧口径一致）
          return;
        }
        handle.done
          .then((run) => {
            if (run.status === "done" && run.result) {
              res.end(
                JSON.stringify(
                  withoutLocalPaths(
                    {
                      ok: true,
                      run_id: run.id,
                      deduplicated: handle.deduplicated,
                      result: run.result, // F6：result.source 是本机绝对路径，远程裁掉（withoutLocalPaths）
                    },
                    guard.remote,
                  ),
                ),
              );
              return;
            }
            if (run.status === "cancelled") {
              // 与 DELETE /scan 同一口径：只回取消回执，不下发部分结果（旧 modules.json 未被触碰）
              res.end(
                JSON.stringify(
                  withoutLocalPaths(
                    {
                      ok: true,
                      run_id: run.id,
                      cancelled: true,
                      partial: true,
                      project_id: run.project_id,
                      progress: run.progress,
                      note: "解析已在安全检查点取消：部分结果未写入 modules.json，沿用上次完整落盘状态（可能已过期）",
                    },
                    guard.remote,
                  ),
                ),
              );
              return;
            }
            // failed：错误按来源还原——WsError 系回 4xx 业务码，其余 500 INTERNAL（同 wsFail 既有口径）
            wsFail(
              run.error_code !== null && run.error_code !== "INTERNAL"
                ? new WsError(run.error_code as WsError["code"], run.error ?? "解析失败")
                : new Error(run.error ?? "解析失败（无错误明细）"),
            );
          })
          .catch((e) => wsFail(e)); // done 设计上不 reject；这层是防御兜底
      })
      .catch((e) => wsFail(e));
    return;
  }
  if (req.method === "GET" && archParseMatch) {
    try {
      const run = getParseRunStatus(decodePathSegment(archParseMatch[1]));
      res.end(JSON.stringify(withoutLocalPaths({ ok: true, run }, guard.remote)));
    } catch (e) {
      wsFail(e);
    }
    return;
  }
  if (req.method === "DELETE" && archParseMatch) {
    try {
      const receipt = requestParseCancel(decodePathSegment(archParseMatch[1]));
      res.end(JSON.stringify(withoutLocalPaths({ ok: true, ...receipt }, guard.remote)));
    } catch (e) {
      wsFail(e);
    }
    return;
  }
  // GET  /api/projects/:id/arch/modules —— 读已落盘 modules.json；未解析过返回 exists:false（200 空态）。
  const archModulesMatch = req.url?.match(/^\/api\/projects\/([^/]+)\/arch\/modules$/);
  if (req.method === "GET" && archModulesMatch) {
    try {
      res.end(
        JSON.stringify(
          withoutLocalPaths({ ok: true, arch: readModules(decodePathSegment(archModulesMatch[1])) }, guard.remote),
        ),
      );
    } catch (e) {
      wsFail(e);
    }
    return;
  }

  // ── A2：Flash 起名 + 硬上限渲染 JSON（DESIGN.md §4.1 第二层、§4.3 第 1/4 招）──
  // POST /api/projects/:id/arch/name {force?} —— 对 modules.json 逐模块调 Flash 起名，
  //   落 .工作台/arch/names.json 缓存；签名未变的模块命中缓存零请求（§12.2 风险 2），
  //   幂等：重复 POST 不重复请求。force:true 为 §4.4 手动「重命名刷新」口径。
  // GET  /api/projects/:id/arch/render —— 合成 modules + names → 带硬上限的渲染 JSON；
  //   未解析过返回 exists:false（200 空态）。纯本地零 LLM。
  const archNameMatch = req.url?.match(/^\/api\/projects\/([^/]+)\/arch\/name$/);
  if (req.method === "POST" && archNameMatch) {
    const projectId = decodePathSegment(archNameMatch[1]);
    readJsonBody(req)
      .then((body) =>
        nameModules(projectId, {
          force: typeof (body as { force?: unknown })?.force === "boolean" ? (body as { force: boolean }).force : false,
        }),
      )
      .then((result) => {
        res.end(
          JSON.stringify(
            withoutLocalPaths(
              {
                ok: true,
                result: {
                  source: result.source, // F6：names.json 的本机绝对路径，远程裁掉
                  named: result.named,
                  cache_hits: result.cache_hits,
                  fallbacks: result.fallbacks,
                  pruned: result.pruned,
                  entries: result.file.entries,
                },
              },
              guard.remote,
            ),
          ),
        );
      })
      .catch((e) => wsFail(e));
    return;
  }
  // ── V09-11：数据流向图的**来源分层**（DESIGN.md §3.2／§11.2；PLAN V09-11）──
  // GET /api/projects/:id/arch/dataflow —— 读该项目的「当前实现 vs 目标语义」口径与
  // 实体/关系/端到端数据链/覆盖对账（同一份派生也给 `get_arch` 的 v2 返回体）。
  // 只读：不写盘、不调模型、不给纳管项目加运行时埋点；未登记声明的项目给空态＋如实说明。
  const archDataFlowMatch = req.url?.match(/^\/api\/projects\/([^/]+)\/arch\/dataflow$/);
  if (req.method === "GET" && archDataFlowMatch) {
    try {
      res.end(
        JSON.stringify(
          withoutLocalPaths(
            { ok: true, data_flow: dataFlowLayerOf(decodePathSegment(archDataFlowMatch[1])) },
            guard.remote,
          ),
        ),
      );
    } catch (e) {
      wsFail(e);
    }
    return;
  }
  const archRenderMatch = req.url?.match(/^\/api\/projects\/([^/]+)\/arch\/render$/);
  if (req.method === "GET" && archRenderMatch) {
    try {
      res.end(
        JSON.stringify(
          withoutLocalPaths({ ok: true, render: renderGraph(decodePathSegment(archRenderMatch[1])) }, guard.remote),
        ),
      );
    } catch (e) {
      wsFail(e);
    }
    return;
  }

  // ── A5：对账标黄（DESIGN.md §4.5）──
  // GET  /api/projects/:id/arch/reconcile —— 读最近一次对账结果（reconcile-last.json）；
  //   未跑过返回 reconcile:{exists:false}（200 空态，不是错误）。
  // POST /api/projects/:id/arch/reconcile —— 立即跑一次对账并落 reconcile-last.json；
  //   同时消费 B3 对账钩子：.工作台/arch/reconcile-request.json 存在即跑一次后清除标记
  //   （结果 consumed_request 字段带回钩子原文，无钩子为 null）。
  // 红线：对账只读合成 design.md + modules.json + names.json，不写 design/progress，
  // 差异是信号不是错误——本路由绝不用对账结果阻断任何操作。
  const archReconcileMatch = req.url?.match(/^\/api\/projects\/([^/]+)\/arch\/reconcile$/);
  if (req.method === "GET" && archReconcileMatch) {
    try {
      res.end(
        JSON.stringify(
          withoutLocalPaths(
            { ok: true, reconcile: readLastReconcile(decodePathSegment(archReconcileMatch[1])) },
            guard.remote,
          ),
        ),
      );
    } catch (e) {
      wsFail(e);
    }
    return;
  }
  if (req.method === "POST" && archReconcileMatch) {
    withWs(() => {
      const result = reconcileProject(decodePathSegment(archReconcileMatch[1]), { trigger: "manual" });
      return withoutLocalPaths({ ok: true, result }, guard.remote); // F6：reconcile_request_source 等键同口径
    });
    return;
  }

  // ── V06-05：图纸派生的规划关联数据（DESIGN.md §4.1 / §4.4–§4.7）──
  // GET  /api/projects/:id/arch/blueprint —— 读**已发布**的规划图（`.工作台/arch/blueprint.json`；
  //   从未发布过返回 blueprint:{exists:false} 的 200 空态，不是错误）+ 最近一次派生尝试的回执
  //   （成功与失败都留，失败时旧图还在、原因从回执读）+ 旧图与规划层合成后的视图数据
  //   （§3.2：空仓也有规划图——旧侧为空，合成结果就是纯规划图）+ 规划↔实现对账（§4.5）。
  //   + `draft`：**未审定方案的可预览草稿**（§3.2）——没有已发布图时给出派生草稿并明标
  //   `label:"draft_unaudited"`；它**只读**（不落 blueprint.json、连回执都不碰）、**零模型**，
  //   且恒为 `publish.published:false`，绝不冒充已发布的有效图。
  //   + `update`（V09-12）：源变化发现链的**图更新状态**
  //   （`.工作台/arch/graph-update.json`：`updating`/`ready`/`stale`/`failed` + 阶段 + 有依据的
  //   预计用时或「无法估计」+ 原因 + 本轮变更指纹）。只读、零副作用；没跑过返回 null（不当成"在更新"）。
  //   界面据此显示「正在更新／预计用时」与「已过期/失败＋原因」——不得以旧图冒充新图（§3.3 / §4.4）。
  // POST /api/projects/:id/arch/blueprint {trigger?,semantic?,force?} —— 触发一次派生与发布：
  //   程序校验通过且没有未处理的基线冲突才落盘；失败/过时都保留上次有效图并如实回报；
  //   `semantic:true` 才调模型做语义整理（缺省零模型，§4.4：任务/验证变化只重算状态）。
  //   补修包 E：`semantic:true` 是**显式重试/高级入口**（正常产品链路由"基线激活自动链"与
  //   "更新图"动作走，不由它兜底）；它这轮的结果会落进分段缓存，随后的自动链因此命中缓存、不重复调用。
  /** §3.2 草稿图预览（只读、零写盘、零模型）：已有已发布图时不给草稿，避免两份图混看 */
  const draftPreview = (projectId: string, hasPublished: boolean): Record<string, unknown> => {
    if (hasPublished) {
      return { exists: false, note: "已有已发布的规划图：读口只给有效图，不另给草稿（§3.2 不把草稿混进正在施工的有效图）" };
    }
    let draft: ReturnType<typeof draftBlueprintOf> = null;
    try {
      draft = draftBlueprintOf(projectId);
    } catch (e) {
      return { exists: false, reason: `草稿派生失败：${(e as Error).message}` };
    }
    if (draft === null) {
      return { exists: false, reason: "可派生的规划对象为空（设计书/施工图里没有可映射的章节、模块或任务）" };
    }
    return {
      exists: true,
      label: "draft_unaudited",
      note: "草稿图（未审定、未激活基线）：只用于预览「图纸会派生成什么」，不能当施工依据（DESIGN.md §3.2）",
      reason: draft.reason,
      baseline_id: draft.blueprint.baseline_id,
      generated_at: draft.blueprint.generated_at,
      validation: draft.validation,
      blueprint: draft.blueprint,
    };
  };
  const archBlueprintMatch = req.url?.match(/^\/api\/projects\/([^/]+)\/arch\/blueprint$/);
  if (req.method === "GET" && archBlueprintMatch) {
    try {
      const id = decodePathSegment(archBlueprintMatch[1]);
      const bp = readBlueprint(id);
      res.end(
        JSON.stringify(
          withoutLocalPaths(
            {
              ok: true,
              blueprint:
                bp === null
                  ? { exists: false }
                  : { exists: true, blueprint: bp, receipt: readBlueprintReceipt(id) },
              draft: draftPreview(id, bp !== null),
              plan_code: planVsCode(id),
              view: viewGraphWithPlan(id),
              // 补修包 E：这张图这一版的**语义整理状态**（哪次跑的、基于哪版分段来源、模型可不可用、
              // 覆盖了什么缺了什么）——只读、零副作用、只含哈希与说明
              semantic: semanticStateOf(id),
              // V09-12：图更新状态（§3.3 末段）——只读；没有记录 = null（读侧不把 null 当成"正在更新"）
              update: graphUpdateOf(id, DATA_DIR),
              // V09-13：每个节点/关系的**来源与证据状态**＋交付阻断读数（判据唯一实现在
              // `src/ui/arch/provenance.ts`；界面与 MCP 读口读的是同一份派生，不各算一套）
              provenance: archProvenanceModelOf(id, { dataDir: DATA_DIR }),
            },
            guard.remote,
          ),
        ),
      );
    } catch (e) {
      wsFail(e);
    }
    return;
  }
  if (req.method === "POST" && archBlueprintMatch) {
    const id = decodePathSegment(archBlueprintMatch[1]);
    readJsonBody(req)
      .then(async (raw) => {
        const body = (raw ?? {}) as Record<string, unknown>;
        try {
          const result = await rebuildBlueprint(id, {
            trigger: typeof body.trigger === "string" && body.trigger !== "" ? body.trigger : "http",
            semantic: body.semantic === true,
            force: body.force === true,
            // 显式整理的结果落进分段缓存（随后自动链命中缓存 → 不重复调用，§4.4「重复事件合并」）
            on_semantic: (info) => recordExplicitSemanticResult(id, info, { dataDir: DATA_DIR, trigger: "http_semantic" }),
          });
          res.end(
            JSON.stringify(
              withoutLocalPaths(
                {
                  ok: true,
                  result: {
                    rebuilt: result.rebuilt,
                    model_calls: result.model_calls,
                    cache_key: result.cache_key,
                    publish: result.publish,
                    stale_discarded: result.stale_discarded,
                    kept_previous: result.kept_previous,
                    validation: result.validation,
                    findings: result.findings,
                    blueprint: result.blueprint,
                  },
                },
                guard.remote,
              ),
            ),
          );
        } catch (e) {
          wsFail(e);
        }
      })
      .catch((e: Error) => wsFail(new WsError("INVALID_INPUT", e.message)));
    return;
  }

  // ── A4：逐级下钻 + 懒加载 + 布局记忆（DESIGN.md §3.3 规则 2/3、§4.1 下钻层、§4.4）──
  // POST /api/projects/:id/arch/expand {module_path} —— 就地展开指定模块的直接子级：
  //   子目录成子模块节点、文件成文件节点（文件名即名字，纯静态零 LLM，响应带 llm_calls:0）；
  //   tree-sitter 只解析该子树内源码（懒加载：不展开的分支无解析开销，stats.parsed_files 为证）；
  //   子级超硬上限时截断成「还有 N 个」聚合节点（§4.3 第 1 招，见 expand.ts）。
  // N2 打点：每次展开在服务端留一行（未点开的枝一行都不会有 → 未展开分支零解析；这一行的
  //   parsed 计数全部落在被展开的子树内）。验证脚本抓服务端 stdout 作为 DoD② 的日志证据。
  // GET/PUT /api/projects/:id/arch/layout —— 布局记忆：GET 读 layout.json（缺文件返回空 positions 空态；
  //   文件按视图分键 {version:2, positions:{<mode>:{nodeId:{x,y}}}}，读时自动把 v1 旧结构迁到 MODULE_BOX）；
  //   PUT {mode?, positions:{nodeId:{x,y}}} 按视图合并写回（已有节点保持原位，只覆盖上报节点与上报视图）。
  // GET/PUT /api/projects/:id/arch/mindmap-fold —— 思维导图折叠态记忆（N2 DoD④）：GET 返回本项目已展开的
  //   [{id,path}]（缺文件/缺本项目键 → 空数组 = 默认全折叠）；PUT 覆盖写本项目那份（原子落盘，
  //   文件 <项目根>/.工作台/arch/mindmap-fold.json，见 foldStore.ts 里"为什么不并进 layout.json"）。
  const archExpandMatch = req.url?.match(/^\/api\/projects\/([^/]+)\/arch\/expand$/);
  if (req.method === "POST" && archExpandMatch) {
    const projectId = decodePathSegment(archExpandMatch[1]);
    readJsonBody(req)
      .then((body) => {
        const modulePath = (body as { module_path?: unknown })?.module_path;
        const result = expandProject(projectId, modulePath as string);
        console.log(
          `[arch/expand] project=${projectId} path=${result.parent.path || "."} ` +
            `children=${result.children.length}(截断 ${result.truncated.children} / 上限 ${result.limit.children}) ` +
            `parsed=${result.stats.parsed_files.length}/${result.stats.subtree_files} ` +
            `parse_ms=${result.parse_ms} duration_ms=${result.duration_ms} ` +
            `project_walk=${result.stats.skipped_project_walk ? "skipped" : "walked"} ` +
            `budget=${result.stats.budget_exhausted ? "exhausted" : "ok"} llm=${result.llm_calls}`,
        );
        res.end(JSON.stringify(withoutLocalPaths({ ok: true, result }, guard.remote))); // F6：与写响应同口径
      })
      .catch((e) => wsFail(e));
    return;
  }
  const archLayoutMatch = req.url?.match(/^\/api\/projects\/([^/]+)\/arch\/layout$/);
  if (req.method === "GET" && archLayoutMatch) {
    try {
      // Q18（2026-09-18 审计）：读接口不产生写盘副作用——非回环来源读 layout 时只做内存迁移，
      // 不再顺手把 v1 旧文件原子写回 v2（那条写回没有请求侧审计行，是"GET 偷偷写盘"）。
      // 回环来源（桌面 UI）行为逐字不变；PUT 那条写路径照旧写回（默认 migrate=true）。
      res.end(
        JSON.stringify(
          withoutLocalPaths(
            {
              ok: true,
              layout: readLayout(decodePathSegment(archLayoutMatch[1]), undefined, { migrate: !guard.remote }),
            },
            guard.remote,
          ),
        ),
      );
    } catch (e) {
      wsFail(e);
    }
    return;
  }
  if (req.method === "PUT" && archLayoutMatch) {
    const projectId = decodePathSegment(archLayoutMatch[1]);
    readJsonBody(req)
      .then((body) => {
        const { positions, mode } = body as { positions?: unknown; mode?: unknown };
        const saved = savePositions(projectId, positions as Record<string, NodePosition>, mode as GraphMode);
        return res.end(
          JSON.stringify(
            withoutLocalPaths(
              {
                ok: true,
                result: {
                  source: saved.source, // F6：layout.json 的本机绝对路径，远程裁掉
                  mode: isLayoutMode(mode) ? mode : LAYOUT_MIGRATION_MODE,
                  saved: Object.keys((positions as object) ?? {}).length,
                  positions: saved.file.positions,
                },
              },
              guard.remote,
            ),
          ),
        );
      })
      .catch((e) => wsFail(e));
    return;
  }
  const archFoldMatch = req.url?.match(/^\/api\/projects\/([^/]+)\/arch\/mindmap-fold$/);
  if (req.method === "GET" && archFoldMatch) {
    try {
      res.end(
        JSON.stringify(
          withoutLocalPaths(
            { ok: true, fold: { expanded: readFold(decodePathSegment(archFoldMatch[1])) } },
            guard.remote,
          ),
        ),
      );
    } catch (e) {
      wsFail(e);
    }
    return;
  }
  if (req.method === "PUT" && archFoldMatch) {
    const projectId = decodePathSegment(archFoldMatch[1]);
    readJsonBody(req)
      .then((body) => {
        const expanded = (body as { expanded?: unknown })?.expanded;
        const saved = saveFold(projectId, expanded ?? []);
        return res.end(
          JSON.stringify(
            withoutLocalPaths(
              {
                ok: true,
                result: {
                  source: saved.source, // F6：mindmap-fold.json 的本机绝对路径，远程裁掉
                  saved: saved.file.projects[projectId]?.expanded.length ?? 0,
                  expanded: saved.file.projects[projectId]?.expanded ?? [],
                },
              },
              guard.remote,
            ),
          ),
        );
      })
      .catch((e) => wsFail(e));
    return;
  }

  // ── B2：记忆检索 MCP（DESIGN.md §9.2/§9.3 逆向落稿第二卡）──
  // GET /api/projects/:id/memory?q=<关键词> —— 走记忆检索 MCP（mcp.json 的 brain-memory 条目）
  // 检索该项目的历史记忆；
  // q 缺省用项目名。检索不可用（未配置/连不上/超时/工具缺失）不报错，返回
  // {ok:true, memory:{available:false, reason}} 降级标记，起草退化为"仅代码扫描"（§9.3）。
  // 隐私红线：结果只在内存里现取现返，不落盘、不写仓库。
  const memoryMatch = req.url?.match(/^\/api\/projects\/([^/]+)\/memory(?:\?(.*))?$/);
  if (req.method === "GET" && memoryMatch) {
    const id = decodePathSegment(memoryMatch[1]);
    const project = getProject(id);
    if (!project) {
      res.statusCode = 404;
      res.end(
        JSON.stringify({
          ok: false,
          error: { code: "PROJECT_NOT_FOUND", message: `项目不存在: ${id}` },
        }),
      );
      return;
    }
    const params = new URLSearchParams(memoryMatch[2] ?? "");
    const q = params.get("q")?.trim() || project.name;
    queryMemory(q)
      .then((memory) => {
        res.end(JSON.stringify(withoutLocalPaths({ ok: true, memory }, guard.remote)));
      })
      .catch((e: Error) => wsFail(e));
    return;
  }

  // ── P3：全局变更流（PLAN P3 卡；DESIGN.md §2.3.5 字段不变 + §11.2「全局变更流」）──
  // GET /api/changes/all?limit=&offset=&project_id=
  // 合并各项目 changes.jsonl 成一条时间倒序的全局流：每条附 project_id/project_name（DoD①），
  // project_id 可选过滤（DoD②）；**不把全部行读进内存**（DoD③ 红线）——口径、压测数字与
  // 已知取舍见 src/server/global-changes.ts 文件头与 PROGRESS 对应流水：
  // 每项目只倒读需要的窗口（64KB 块，与文件大小无关）+ K 路最大堆归并，收满 limit 立即停手；
  // total 走流式行计数（精确值，按 size+mtimeMs 缓存）。limit 缺省 200 / 上限 2000，超上限明示
  // 400 拒绝——不静默截断，也不允许"一次要全部行"把 10 万行读成对象。
  if (
    req.method === "GET" &&
    req.url !== undefined &&
    (req.url === "/api/changes/all" || req.url.startsWith("/api/changes/all?"))
  ) {
    try {
      const qs = req.url.includes("?") ? req.url.slice(req.url.indexOf("?") + 1) : "";
      const params = new URLSearchParams(qs);
      const pid = params.get("project_id");
      res.end(
        JSON.stringify(
          withoutLocalPaths(
            {
              ok: true,
              ...queryGlobalChanges({
                limit: nonNegParam(params, "limit"),
                offset: nonNegParam(params, "offset"),
                projectId: pid === null || pid === "" ? undefined : pid,
              }),
            },
            guard.remote,
          ),
        ),
      );
    } catch (e) {
      wsFail(e);
    }
    return;
  }

  // ── H1：文件监听 + 变更流水（DESIGN.md §2.3.5 / §3.8 / §3.9，防失控口径 §12.2 风险 3）──
  // 路由：POST   /api/projects/:id/watch（开监听，幂等）
  //       DELETE /api/projects/:id/watch（关监听，幂等）
  //       GET    /api/projects/:id/changes?limit=N&offset=M&path=子串（读流水，时间倒序，H3 加分页/过滤）
  //       GET    /api/watch（列出当前监听中的项目 + 项目级明细 details：模式/truncated/计数，H4 加）
  // 生命周期红线：服务启动时【不自动监听任何项目】，只由这里的接口显式开/关——
  // 避免一启动就挂上全部项目（含 node_modules 上千文件）导致资源失控。
  const watchMatch = req.url?.match(/^\/api\/projects\/([^/]+)\/watch$/);
  if (req.method === "POST" && watchMatch) {
    try {
      const result = watchProject(decodePathSegment(watchMatch[1]));
      // Q51（2026-09-18 审计）：挂载是异步的（先有界预扫描），但应答必须等这次挂载**落地**——
      // 此前恒回 `{watching:true}`，挂载失败只在 stderr 留痕，界面那边毫不知情（还会被当成"在听"）。
      // 失败走 wsFail（结构化错误 + 状态码），成功才回 watching:true。
      result.mounted
        .then(() => {
          // V09-07：watch 成功落地后才挂源变化发现链（挂载失败不挂链；幂等，already 时不重复挂）
          startGraphRefresh(decodePathSegment(watchMatch[1]));
          res.end(JSON.stringify({ ok: true, watch: { watching: result.watching, already: result.already } }));
        })
        .catch((e) => wsFail(e));
    } catch (e) {
      wsFail(e);
    }
    return;
  }
  if (req.method === "DELETE" && watchMatch) {
    const id = decodePathSegment(watchMatch[1]);
    unwatchProject(id)
      .then((removed) => {
        stopGraphRefresh(id); // V09-07：关监听同时摘发现链（幂等）
        res.end(JSON.stringify({ ok: true, removed }));
      })
      .catch((e) => wsFail(e));
    return;
  }
  if (req.method === "GET" && req.url === "/api/watch") {
    // H4：除 id 列表外附项目级明细（模式 full/top、truncated 与原因、事件/落盘/丢弃/错误计数）——
    // 降级与洪峰不静默，验证脚本与人工排查读同一份数字。老字段 watching 原样保留（H1/H2/H3 口径不变）。
    res.end(
      JSON.stringify(
        withoutLocalPaths({ ok: true, watching: listWatching(), details: listWatchDetails() }, guard.remote),
      ),
    );
    return;
  }
  const changesMatch = req.url?.match(/^\/api\/projects\/([^/]+)\/changes(?:\?(.*))?$/);
  if (req.method === "GET" && changesMatch) {
    try {
      const params = new URLSearchParams(changesMatch[2] ?? "");
      const limit = nonNegParam(params, "limit");
      const offset = nonNegParam(params, "offset");
      const pathFilter = params.get("path") ?? undefined;
      const id = decodePathSegment(changesMatch[1]);
      // H3：带 offset/path 参数（或显式分页）走 queryChanges，响应附带 total；
      // 只带 limit 的旧调用（H2 入口对账）响应结构不变，仅追加 total 字段（增量兼容）
      const { changes, total } = queryChanges(id, { limit, offset, path: pathFilter });
      // S3：行里的 `path` 是**项目内相对路径**（界面要显示），值判定保证它不被误裁；
      // 万一哪天行里混进绝对路径，这里也会自动裁掉
      res.end(JSON.stringify(withoutLocalPaths({ ok: true, changes, total }, guard.remote)));
    } catch (e) {
      wsFail(e);
    }
    return;
  }
  // H2：GET /api/projects/:id/events —— SSE 实时推送变更事件（DESIGN.md §3.9 无刷新更新）。
  // 手写 SSE（零新依赖）：纯 `data: <json>\n\n` 行（前端 EventSource onmessage 直接收）+
  // `: ping` 心跳行保活。连接即推一条 hello；随后订阅 watcher 的变更事件钩子
  // （watcher.onProjectChange——SSE 只是消费者之一），本项目的事件原样转推
  // {ts,path,action,size_delta}（与 changes.jsonl 行同口径，§2.3.5）。
  // 生命周期：SSE 只订阅、不开监听——开/关监听是 POST/DELETE /watch 的事（选中态驱动）；
  // 连接断开（页面关闭/切项目）即退订清心跳，不留悬挂。
  const eventsMatch = req.url?.match(/^\/api\/projects\/([^/]+)\/events$/);
  if (req.method === "GET" && eventsMatch) {
    const projectId = decodePathSegment(eventsMatch[1]);
    if (!getProject(projectId)) {
      res.statusCode = 404;
      res.end(
        JSON.stringify({
          ok: false,
          error: { code: "PROJECT_NOT_FOUND", message: `项目不存在: ${projectId}` },
        }),
      );
      return;
    }
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write(`data: ${JSON.stringify({ hello: true, project: projectId, ts: nowIso() })}\n\n`);
    const off = onProjectChange((pid, line) => {
      if (pid === projectId) {
        res.write(`data: ${JSON.stringify(withoutLocalPaths(line, guard.remote))}\n\n`);
      }
    });
    const ping = setInterval(() => {
      res.write(`: ping ${nowIso()}\n\n`);
    }, 25000);
    req.on("close", () => {
      clearInterval(ping);
      off();
    });
    return;
  }

  // ── T1：终端 PTY 通道（DESIGN.md §3.7，node-pty 真 PTY；T2 xterm.js 接这里；E1 多终端分屏）──
  // 路由：POST   /api/projects/:id/terminal（建会话，cwd 锁项目根，不落到全局数据目录）
  //       GET    /api/terminal/sessions?project_id=（E1：列某项目当前活跃会话）
  //       GET    /api/terminal/:sid/out?project_id=（SSE 流式输出：data 事件 + exit 事件收尾）
  //       POST   /api/terminal/:sid/in?project_id= {data}（写 stdin）
  //       POST   /api/terminal/:sid/resize?project_id= {cols,rows}（尺寸变更，ConPTY 真 resize）
  //       DELETE /api/terminal/:sid?project_id=（关闭：kill + 等退出码，不留僵尸）
  // E1 会话隔离：以上四个 :sid 路由支持可选 `?project_id=`——带上时该 sid 必须属于这个项目，
  // 否则一律 404 SESSION_NOT_FOUND（A 项目的 sid 在 B 项目上不可用；E1 前端每个 pane 都带自己的项目 id）。
  // 错误口径与 G1 一致：项目/会话不存在 404（PROJECT_NOT_FOUND / SESSION_NOT_FOUND），
  // 参数错 / 会话数超上限 400（INVALID_INPUT / SESSION_LIMIT_REACHED）。
  const createTermMatch = req.url?.match(/^\/api\/projects\/([^/]+)\/terminal$/);
  if (req.method === "POST" && createTermMatch) {
    withWs((body) => {
      const input = body as Record<string, unknown>;
      // 只认正整数；上限（MAX_TERMINAL_DIMENSION，Q125）由 createTerminalSession 统一卡——
      // 超限的大整数（如 1e7）会原样送进 pty 层被判 INVALID_INPUT → 400，
      // 不在这里折成默认值（那会"看着成功、实际没生效"）
      const num = (v: unknown): number | undefined =>
        typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined;
      const session = createTerminalSession(
        decodePathSegment(createTermMatch[1]),
        num(input.cols) ?? 80,
        num(input.rows) ?? 24,
      );
      return withoutLocalPaths({ ok: true, session }, guard.remote); // F6：session.cwd 是项目根绝对路径，远程裁掉
    });
    return;
  }
  // ── E3：命令历史检索（DESIGN.md §3.7 二期「命令历史检索」）──
  // GET    /api/projects/:id/terminal/history?q=&limit= —— 按关键字检索本项目历史（跨会话、跨 pane）
  // DELETE /api/projects/:id/terminal/history —— 清空本项目历史（隐私红线：用户必须有删除权；
  //        前端二次确认后才调本接口，后端不做二次确认的假动作）
  // 数据源 = `<项目根>/.工作台/logs/terminal-history.jsonl`（自管落盘，见 `terminalHistory.ts`），
  // **不是** shell 自己的历史文件（PLAN E3 跑偏点）。
  // 错误口径与既有路由一致：项目不存在 404 PROJECT_NOT_FOUND；q/limit 不合法 400 INVALID_INPUT。
  const histMatch = req.url?.match(/^\/api\/projects\/([^/]+)\/terminal\/history(?:\?(.*))?$/);
  if (histMatch && (req.method === "GET" || req.method === "DELETE")) {
    const projectId = decodePathSegment(histMatch[1]);
    if (!getProject(projectId)) {
      res.statusCode = 404;
      res.end(
        JSON.stringify({
          ok: false,
          error: { code: "PROJECT_NOT_FOUND", message: `项目不存在: ${projectId}` },
        }),
      );
      return;
    }
    if (req.method === "DELETE") {
      const cleared = clearTerminalHistory(projectId);
      res.end(JSON.stringify({ ok: true, project_id: projectId, ...cleared }));
      return;
    }
    const params = new URLSearchParams(histMatch[2] ?? "");
    const rawLimit = params.get("limit");
    let limit = DEFAULT_HISTORY_LIMIT;
    if (rawLimit !== null) {
      const n = Number(rawLimit);
      if (!Number.isInteger(n) || n < 1 || n > MAX_HISTORY_LIMIT) {
        res.statusCode = 400;
        res.end(
          JSON.stringify({
            ok: false,
            error: {
              code: "INVALID_INPUT",
              message: `limit 必须是 1..${MAX_HISTORY_LIMIT} 的整数: ${rawLimit}`,
            },
          }),
        );
        return;
      }
      limit = n;
    }
    const result = queryTerminalHistory(projectId, params.get("q") ?? undefined, limit);
    // S3 红线⑧：本条路径默认被 `REMOTE_TERMINAL_HIDDEN` 拦下（命令原文不外泄）；
    // 主机上显式放开时，返回体仍过一遍裁剪（`file` 是相对路径，值判定不会误裁）
    res.end(
      JSON.stringify(
        withoutLocalPaths(
          {
            ok: true,
            project_id: projectId,
            q: params.get("q") ?? null,
            limit,
            count: result.items.length,
            total: result.total,
            corrupt: result.corrupt,
            file: result.file,
            items: result.items,
          },
          guard.remote,
        ),
      ),
    );
    return;
  }
  // 终端路由带查询串（?project_id=），所以按 path 匹配、按 query 取项目范围
  const termPath = (req.url ?? "").startsWith("/api/terminal")
    ? (req.url ?? "").split("?")[0]
    : "";
  const termProjectId = termPath
    ? new URLSearchParams((req.url ?? "").split("?")[1] ?? "").get("project_id") || undefined
    : undefined;
  // GET /api/terminal/sessions?project_id= —— E1：列该项目当前活跃会话（分屏 pane 的对照清单）。
  // 必须带 project_id：不带时列全部（排查用），带伪造项目 404（不静默返回空表）。
  if (req.method === "GET" && termPath === "/api/terminal/sessions") {
    const projectId = termProjectId;
    if (projectId !== undefined && !getProject(projectId)) {
      res.statusCode = 404;
      res.end(
        JSON.stringify({
          ok: false,
          error: { code: "PROJECT_NOT_FOUND", message: `项目不存在: ${projectId}` },
        }),
      );
      return;
    }
    const list = listTerminalSessions(projectId);
    // S3 红线⑧：默认被 REMOTE_TERMINAL_HIDDEN 拦下；放开时 `cwd`（项目绝对路径）也要裁掉
    res.end(
      JSON.stringify(
        withoutLocalPaths({ ok: true, project_id: projectId ?? null, count: list.length, sessions: list }, guard.remote),
      ),
    );
    return;
  }
  const termMatch = termPath.match(/^\/api\/terminal\/([^/]+)(?:\/(out|in|resize))?$/);
  // GET /api/terminal/:sid/out —— SSE：连接即 hello；pty 输出原样推 {"data":"..."}；
  // 会话退出推 {"exit":{"exitCode":N}} 后收流；连接断开退订清心跳，不留悬挂。
  if (req.method === "GET" && termMatch && termMatch[2] === "out") {
    const sid = decodePathSegment(termMatch[1]);
    let offData: () => void;
    let offExit: () => void;
    try {
      assertTerminalSession(sid, termProjectId); // 写响应头前先校验（跨项目/不存在 → 404，不污染 SSE 流）
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(`data: ${JSON.stringify({ hello: true, sid, ts: nowIso() })}\n\n`);
      offData = onTerminalData(
        sid,
        (data) => {
          res.write(`data: ${JSON.stringify({ data })}\n\n`);
        },
        termProjectId,
      );
      offExit = onTerminalExit(
        sid,
        ({ exitCode }) => {
          res.write(`data: ${JSON.stringify({ exit: { exitCode } })}\n\n`);
          res.end();
        },
        termProjectId,
      );
    } catch (e) {
      wsFail(e);
      return;
    }
    const ping = setInterval(() => {
      res.write(`: ping ${nowIso()}\n\n`);
    }, 25000);
    req.on("close", () => {
      clearInterval(ping);
      offData();
      offExit();
    });
    return;
  }
  // POST /api/terminal/:sid/in {data} —— 写 stdin
  if (req.method === "POST" && termMatch && termMatch[2] === "in") {
    withWs((body) => {
      const input = body as Record<string, unknown>;
      if (typeof input.data !== "string") {
        throw new WsError("INVALID_INPUT", "body.data 必须是字符串");
      }
      const session = writeTerminal(
        decodePathSegment(termMatch[1]),
        input.data,
        termProjectId,
      );
      return withoutLocalPaths({ ok: true, session }, guard.remote); // F6：同上
    });
    return;
  }
  // POST /api/terminal/:sid/resize {cols,rows}
  if (req.method === "POST" && termMatch && termMatch[2] === "resize") {
    withWs((body) => {
      const input = body as Record<string, unknown>;
      const session = resizeTerminal(
        decodePathSegment(termMatch[1]),
        Number(input.cols),
        Number(input.rows),
        termProjectId,
      );
      return withoutLocalPaths({ ok: true, session }, guard.remote); // F6：同上
    });
    return;
  }
  // DELETE /api/terminal/:sid —— 关闭会话（幂等：不存在的 sid 返回 removed:false）
  if (req.method === "DELETE" && termMatch && !termMatch[2]) {
    const sid = decodePathSegment(termMatch[1]);
    closeTerminal(sid, termProjectId)
      .then((result) => {
        res.end(
          JSON.stringify({ ok: true, removed: result !== null, exit: result ?? null }),
        );
      })
      .catch((e) => wsFail(e));
    return;
  }

  // ── 补修 A（V06-14）：注册表恢复入口（**显式触发**；塔台不在读写路径上自动重建）──
  // POST /api/registry/recover
  //   body `{}`                       → 把读不出来的现场留档后重建空表（确认这一份救不回来）
  //   body `{"from":"<文件名>"}`       → 从数据目录内的留档/备份恢复（必须能过注册表校验）
  // 只接受**数据目录内**的文件名（不带路径）；全程 withFileLock + 原子换表，现场先改名留档。
  // 只读（远程）模式下由红线先拒（写方法），本机回环可用。
  if (req.method === "POST" && req.url === "/api/registry/recover") {
    readJsonBody(req)
      .then((body) => {
        const input = (body ?? {}) as Record<string, unknown>;
        const from = typeof input.from === "string" ? input.from : undefined;
        const result = recoverRegistry(DATA_DIR, from === undefined ? {} : { from });
        res.end(JSON.stringify(withoutLocalPaths({ ok: true, ...result }, guard.remote)));
      })
      .catch((e: Error) => {
        if (e instanceof RegistryRecoveryInputError) {
          res.statusCode = 400;
          res.end(
            JSON.stringify({
              ok: false,
              error: { code: e.code, message: sanitizeErrorMessage(e.message) },
            }),
          );
          return;
        }
        if (e instanceof RegistryStateError) {
          res.statusCode = 500;
          res.end(
            JSON.stringify({
              ok: false,
              error: { ...e.toJSON(), message: sanitizeErrorMessage(e.message) },
            }),
          );
          return;
        }
        res.statusCode = 500;
        res.end(
          JSON.stringify({
            ok: false,
            error: { code: "INTERNAL", message: sanitizeErrorMessage(e.message) },
          }),
        );
      });
    return;
  }

  if (req.method === "GET" && req.url === "/api/projects") {
    // R3：list 接口顺带给出 exists（目录存在性），状态点口径由后端定，前端不瞎猜
    const projects = listProjects().map((p) => ({
      ...p,
      exists: fs.existsSync(p.path),
    }));
    res.end(JSON.stringify(withoutLocalPaths(projects, guard.remote)));
    return;
  }
  // R2 项目接入：POST /api/projects { path, id?, name?, self_managed? }
  if (req.method === "POST" && req.url === "/api/projects") {
    readJsonBody(req)
      .then((body) => {
        const input = body as Record<string, unknown>;
        const result = onboardProject({
          path: String(input.path ?? ""),
          ...(typeof input.id === "string" ? { id: input.id } : {}),
          ...(typeof input.name === "string" ? { name: input.name } : {}),
          ...(input.self_managed === true ? { self_managed: true } : {}),
        });
        // V06-02：接入时可一并登记两份图纸的项目根内相对路径（design_path / plan_path）。
        // 只做形态校验（非绝对路径、无 `..`）；真实越界（软链逃逸）在读取时按项目根真实路径拒绝。
        // 登记失败不回滚注册表（项目已接入是有效事实），但**如实把失败报出来**，不留半截成功。
        const wantsPaths = "design_path" in input || "plan_path" in input;
        if (result.ok && wantsPaths) {
          setProjectDocumentPaths(result.record.id, {
            ...("design_path" in input ? { design_path: String(input.design_path ?? "") } : {}),
            ...("plan_path" in input ? { plan_path: String(input.plan_path ?? "") } : {}),
          });
          const reselected = getProject(result.record.id);
          if (reselected) {
            result.record = { ...result.record, ...reselected };
          }
        }
        if (!result.ok) {
          res.statusCode = result.error.code === "INVALID_INPUT" ? 400 : 422;
        }
        // F6：成功分支带回完整 project 记录（含 path 本机绝对路径），远程裁掉
        res.end(JSON.stringify(withoutLocalPaths(result, guard.remote)));
      })
      .catch((e: Error) => {
        // Q129（2026-09-19 审计）+ 补修 A：注册表读不到是**服务端数据问题**，不是"用户 path 传错了"——
        // 此前一律回 400 INVALID_INPUT，把排查方向指歪。现在回 500 + 专用 code + 结构化现场与恢复入口；
        // 写路径也不再留档重建（一次普通登记不许把历史缺失掩盖掉）。
        if (e instanceof RegistryStateError) {
          res.statusCode = 500;
          res.end(
            JSON.stringify({
              ok: false,
              error: { ...e.toJSON(), message: sanitizeErrorMessage(e.message) },
            }),
          );
          return;
        }
        res.statusCode = 400;
        res.end(
          JSON.stringify({
            ok: false,
            error: { code: "INVALID_INPUT", message: sanitizeErrorMessage(e.message) },
          }),
        );
      });
    return;
  }
  // R4：POST /api/projects/:id/open —— 选中项目时写回 last_opened_at（DESIGN.md §2.3.1）
  const openMatch = req.url?.match(/^\/api\/projects\/([^/]+)\/open$/);
  if (req.method === "POST" && openMatch) {
    const id = decodePathSegment(openMatch[1]);
    if (!touchLastOpened(id)) {
      res.statusCode = 404;
      res.end(
        JSON.stringify({
          ok: false,
          error: { code: "PROJECT_NOT_FOUND", message: `项目不存在: ${id}` },
        }),
      );
      return;
    }
    // Q86（2026-09-18 审计）：`touchLastOpened` 与这里之间是两次独立的注册表读，跨进程写（MCP 进程
    // 也在改同一份 registry.json）可能把记录抽走——`JSON.stringify` 会丢掉 undefined 键，客户端就
    // 收到 `{"ok":true}` 而 `body.project` 是 undefined（前端断言成 ProjectRecord，唯一调用方恰好
    // 不消费；但契约不能靠"调用方不看"成立）。这里如实回 404，与上面同码同形状。
    const project = getProject(id);
    if (!project) {
      res.statusCode = 404;
      res.end(
        JSON.stringify({
          ok: false,
          error: { code: "PROJECT_NOT_FOUND", message: `项目不存在: ${id}` },
        }),
      );
      return;
    }
    res.end(JSON.stringify(withoutLocalPaths({ ok: true, project }, guard.remote))); // F6：project.path 远程裁掉
    return;
  }
  // R4：DELETE /api/projects/:id —— 移除项目
  const removeMatch = req.url?.match(/^\/api\/projects\/([^/]+)$/);
  if (req.method === "DELETE" && removeMatch) {
    const id = decodePathSegment(removeMatch[1]);
    // ████ 红线 ████ 本接口只操作注册表记录，绝不做任何 fs 删除——
    // 磁盘上的项目目录不属于塔台的管辖范围（"只从注册表移除，不删磁盘目录"是移除确认弹窗对用户的承诺）。
    if (!removeProject(id)) {
      res.statusCode = 404;
      res.end(
        JSON.stringify({
          ok: false,
          error: { code: "PROJECT_NOT_FOUND", message: `项目不存在: ${id}` },
        }),
      );
      return;
    }
    // 资源回收（2026-09-18 审计补）：注册表移除的同时回收该项目的监听与终端会话——
    // 此前只删记录，watcher 还盯着已删项目、PTY 还开着它的 shell（资源泄漏 + 幽灵会话）。
    // 复用 watcher.unwatchProject（会把已排队的变更刷完盘再关）与 pty.closeProjectTerminals
    // （逐个 kill 等退出）；整体有界等待（超时如实报未回收完，不拖死删除响应），
    // 回收失败只记日志不回滚删除（注册表事实已移除，重试删除同一 id 只会 404）。
    releaseProjectResources(id)
      .then((released) => {
        console.log(
          `[projects] 移除 ${id}：资源回收 监听=${released.watch ? "已停" : "原本未开"} 终端会话=${released.terminals}` +
            `（超时=${released.timedOut ? "是" : "否"}，失败=${released.errors.length}）` +
            (released.errors.length > 0 ? ` 原因：${released.errors.join("；")}` : ""),
        );
        res.end(JSON.stringify({ ok: true, removed: id, released }));
      })
      .catch((e: Error) => {
        // 这一支近乎不可达（timed() 内部已把抛错收成 released.errors），保留为最后一道网：
        // 同样如实带出原因，不再回一个与"本来就没东西可回收"同形的形状（Q52）。
        const reason = sanitizeErrorMessage(e.message);
        console.error(`[projects] 移除 ${id} 后资源回收异常：${reason}`);
        res.end(
          JSON.stringify({
            ok: true,
            removed: id,
            released: { watch: false, terminals: 0, timedOut: false, errors: [reason] },
          }),
        );
      });
    return;
  }
  // C1：POST /api/flash/chat —— Flash 流式聊天管道（DESIGN.md §3.6）。
  // 本接口只通管道：不做会话落盘（那是 C2 的事）。响应为 SSE：每个 chunk 一行
  // `data: {"delta":"..."}`，正常结束发 `data: [DONE]`；流中途出错发 `data: {"error":"..."}`。
  // body 只收 messages（必填）/ model / temperature——绝不接受 apiKey/baseURL
  // （密钥只走服务端环境变量/config.json，防 baseURL 被改向第三方主机泄钥）。
  if (req.method === "POST" && req.url === "/api/flash/chat") {
    readJsonBody(req)
      .then(async (body) => {
        const input = body as Record<string, unknown>;
        const messages = input.messages as FlashMessage[] | undefined;
        if (!Array.isArray(messages) || messages.length === 0) {
          res.statusCode = 400;
          res.end(
            JSON.stringify({
              ok: false,
              error: { code: "INVALID_INPUT", message: "body.messages 必须是非空数组" },
            }),
          );
          return;
        }
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        try {
          for await (const delta of chatStream(messages, {
            ...(typeof input.model === "string" ? { model: input.model } : {}),
            ...(typeof input.temperature === "number" ? { temperature: input.temperature } : {}),
          })) {
            res.write(`data: ${JSON.stringify({ delta })}\n\n`);
          }
          res.write("data: [DONE]\n\n");
          res.end();
        } catch (e) {
          // flash.ts 红线：错误消息只含状态码/响应体摘要，不含密钥材料；
          // F5：再过一层消息级脱敏（flash 配置错误带 config.json 的本机绝对路径）；
          // 响应头已是 SSE（无法再改状态码），以 SSE error 事件收尾
          res.write(`data: ${JSON.stringify({ error: sanitizeErrorMessage((e as Error).message) })}\n\n`);
          res.end();
        }
      })
      .catch((e: Error) => {
        res.statusCode = 400;
        res.end(
          JSON.stringify({
            ok: false,
            error: { code: "INVALID_INPUT", message: sanitizeErrorMessage(e.message) },
          }),
        );
      });
    return;
  }
  if (req.method === "GET" && req.url === "/api/agents") {
    // M4：左栏「Agent 管理」数据源——全局 agents.json（只读，last_active_at 倒序）
    try {
      res.end(JSON.stringify(withoutLocalPaths({ ok: true, agents: listAgents() }, guard.remote)));
    } catch (e) {
      wsFail(e);
    }
    return;
  }
  if (req.method === "GET" && req.url === "/health") {
    res.end(
      // pid：给桌面壳做应答方归属对账用（src-tauri/src/backend.rs M-2——/health 200 之外还要
      // pid 对得上本轮子进程才算"后端就绪"，防上一代残留后端冒名应答的假就绪）。
      // pid 是数字，不受 withoutLocalPaths 的本地路径裁剪影响。
      // Q54（2026-09-18 审计）：审计落盘失败此前只有 stderr 一行、无结构化出口——把落盘健康度
      // （累计失败次数 + 最近原因，原因已脱敏）一并回出来，缺口从此可查、不只在日志里。
      JSON.stringify(
        withoutLocalPaths(
          {
            ok: true,
            data_dir: resolveDataDir(),
            pid: process.pid,
            ...(auditLog ? { audit: auditLog.health() } : {}),
          },
          guard.remote,
        ),
      ),
    );
    return;
  }
  // Q84（2026-09-18 审计）：兜底 404 的形状原先不在全站契约里（`{error:"not found"}`，没有 ok、
  // error 还是字符串），前端 45 处调用点一律按 `body.error.code` 取值 → 渲染成 `[undefined] undefined`。
  // 改成与其余路由同一形状；`/design` 的 PUT/DELETE 有意落空到这条兜底（见上面红线段），
  // 客户端现在拿到的是可读的结构化错误。
  res.statusCode = 404;
  res.end(JSON.stringify({ ok: false, error: { code: "NOT_FOUND", message: "not found" } }));
}

// Q39（2026-09-18 审计）：路由分发的**顶层兜底**。此前 handler 内唯一的 try 只包住放行口
// （guardRemoteRequest），三千多行的路由体全裸——registry.json 一坏（`JSON.parse` 读到 BOM 等），
// 任何 handler 顶层裸调 `listProjects()` / `getProject()` 抛出的异常都直达
// `process.on("uncaughtException")` → `process.exit(1)`：一个坏文件把整个后端带走，
// 桌面壳那头表现为"后端没了"（无人重启）。这里把异常收在请求边界内：
//   · WsError → 与 wsFail 同一份状态码口径（业务错误照旧 4xx，语义不变）；
//   · 其它 → 结构化 500，消息过 sanitizeErrorMessage（不回显本机路径），进程继续服务。
// 已在写响应途中（headersSent）时不再改状态码，直接收尾，避免二次写头。
// ── V06-01 唯一写入服务（PLAN.md V06-01 / DESIGN.md §2.6）──
// 服务实例与令牌在这里建；描述符在绑上之后发布（见下面的 listen 回调），地址取
// `server.address()` 的实际落地值——stdio MCP 进程据此发现唯一的写入服务。
// 故障注入只认环境变量（产品路径不传 faults）：验证脚本用它制造"已提交但快照失败"。
const workHost = createWorkHost(DATA_DIR, {
  faults: process.env.TATAI_WORK_FAULT_SNAPSHOT === "1" ? { snapshot: "throw" } : undefined,
});

const server = http.createServer((req, res) => {
  try {
    handleRequest(req, res);
  } catch (e) {
    const message = sanitizeErrorMessage((e as Error)?.message ?? String(e));
    console.error(`[tatai-server] 请求处理异常 ${req.method ?? "?"} ${requestPathOf(req.url)}：${message}`);
    if (res.headersSent) {
      res.end();
      return;
    }
    // Q129（2026-09-19 审计）：坏注册表也在这条顶层兜底里带上专用 code（多数路由的 500 走这里）
    // 补修 A（2026-09-20）：注册表"丢/坏/读不了/判不出"四种现场都带上结构化字段（state/reason/traces/recovery），
    // 客户端据此能看出"不是空项目列表"以及怎么恢复。
    const code = e instanceof WsError ? e.code : e instanceof RegistryStateError ? e.code : "INTERNAL";
    res.statusCode = e instanceof WsError ? wsErrorStatus(e.code) : 500;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(
      JSON.stringify({
        ok: false,
        // Q122（2026-09-19 审计）：WsError 的文案也过一遍脱敏——这条兜底没有 guard 可判来源，
        // 与 F5 的 500 分支同一口径（盘符/UNC → <path>，其余文案原样）
        error:
          e instanceof RegistryStateError
            ? { ...e.toJSON(), code, message }
            : { code, message },
      }),
    );
  }
});

// ██ 三期 S1 红线（DESIGN.md §1.4 解锁版 / §10.2）██
// 绑哪个地址不再是"随手 TATAI_HOST"：一律过 `remote-config.ts` 的红线校验——默认 127.0.0.1；
// 非回环地址必须先显式开启远程（TATAI_REMOTE=1）；0.0.0.0/:: 默认硬拒（要危险开关 + 醒目警告）；
// 公网 IP 一律拒（不面向公网）。配置违规在启动期 exit(1)，不会"先起来再说"。
const HOST = remoteConfig.bindHost;
// F2（2026-09-18 审计）：TATAI_HOST 是主机名时，listen 之前先做一次 DNS 解析
// （assertBindHostnameSafe，remote-config.ts）——解析结果逐一过既有公网判定，命中公网即与
// IP 字面量**同路径同错误码**拒启动（PUBLIC_HOST_FORBIDDEN，堵"主机名解析公网 A 记录绕红线⑥"）；
// 解析失败/无记录维持"仅警告"口径（不新增拒绝路径）。resolveRemoteConfig 是同步的
// （checkRedlines/CLI/验证脚本都依赖），这一步只能在启动链路这里以异步补做。
void (async () => {
  if (remoteConfig.hostKind === "hostname") {
    try {
      const { resolved } = await assertBindHostnameSafe(HOST);
      console.log(
        resolved.length > 0
          ? `[tatai-server] 主机名绑定 ${HOST} 解析到 ${resolved.join("、")}（均非公网，放行）`
          : `[tatai-server] 主机名绑定 ${HOST}：DNS 无记录/解析失败，按既有口径放行（可达范围由用户负责）`,
      );
    } catch (e) {
      if (e instanceof RemoteConfigError) {
        console.error(`[tatai-server] 启动被安全红线拦下 [${e.code}] ${e.message}`);
        console.error(`[tatai-server] 提示：${e.hint}`);
        process.exit(1);
      }
      throw e;
    }
  }
  server.listen(PORT, HOST, async () => {
  // Q20（2026-09-18 审计）：上面那次主机名预检走 `dns.resolve`（c-ares：只查 DNS，**不读 hosts 文件**），
  // 而 `listen` 走 Node 内置 `dns.lookup`（读 hosts + 系统解析器）——两次解析不是同一份来源：
  // 把主机名写进 hosts 指向某个非回环地址，预检看不见、listen 却认，红线⑥ 于是留了二次解析窗口。
  // 这里在**真绑上之后**按 `server.address()` 复检一次（fail-closed）：实际落地地址过同一条公网判定，
  // 命中即停服务退出——口令/闸门都拦不住"这台机器已经把塔台挂在公网接口上"这件事，只能不起来。
  // 复检放在 "listening on" 之前：绑错就不该对外打出那条"就绪"日志。
  if (remoteConfig.hostKind === "hostname") {
    const bound = server.address();
    const boundAddr = typeof bound === "object" && bound !== null ? bound.address : "";
    if (isPublicBindAddress(boundAddr)) {
      console.error(
        `[tatai-server] 启动被安全红线拦下 [PUBLIC_HOST_FORBIDDEN] ${REMOTE_HOST_ENV}=${HOST} 实际绑到了公网地址 ` +
          `${boundAddr}（预检的 DNS 解析与 listen 的解析源不同，hosts 文件可让两者不一致）——塔台不面向公网`,
      );
      server.close(() => process.exit(1));
      setTimeout(() => process.exit(1), 2000).unref();
      return;
    }
    console.log(`[tatai-server] 主机名绑定 ${HOST} 实际落地 ${boundAddr}（绑后复检：非公网，放行）`);
  }
  // V06-01：绑上之后发布写入服务描述符——地址取**实际落地值**（`server.address()`），
  // 不是 PORT/HOST 字面量（`PORT=0` 时两者不同）；MCP 进程按描述符找服务，没有描述符就是"未启动"。
  // V07-01（接管握手）：若写入服务正由独立 daemon 承载（agent 无头期被按需拉起），先请它让位——
  // 单写者经描述符交接：daemon 撤描述符后本进程再发布；交接窗口内 MCP 客户端走自愈重试不丢写。
  // 对端不是 daemon（404/超时）就照常发布覆盖——陈旧描述符/死端口同样被本进程发布取代。
  try {
    const existing = readServiceDescriptor(DATA_DIR);
    if (existing !== null) {
      const res = await fetch(`http://${existing.host}:${existing.port}/api/work/admin/shutdown`, {
        method: "POST",
        headers: { [WORK_TOKEN_HEADER]: existing.token },
        signal: AbortSignal.timeout(3000),
      }).catch(() => null);
      if (res !== null && res.ok) {
        for (let i = 0; i < 15; i++) {
          if (readServiceDescriptor(DATA_DIR) === null) break;
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        console.log("[tatai-server] 已接管写入服务（daemon 让位，描述符交接完成）");
      }
    }
  } catch (e) {
    console.log(`[tatai-server] 写入服务接管握手未成（${e instanceof Error ? e.message : String(e)}），照常发布`);
  }
  const workBound = server.address();
  if (workBound && typeof workBound === "object") {
    workHost.publish(workBound.port, workBound.address);
  }
  console.log(`[tatai-server] listening on http://${HOST}:${PORT} (${HOST === "127.0.0.1" ? "仅本机" : "⚠ 非回环地址"})`);
  console.log(`[tatai-server] data dir: ${resolveDataDir()}`);
  // Q66（2026-09-18 审计）：原子写会在被 kill 时留下 `<文件>.<pid>.<时间戳>.tmp` 残骸，全仓此前没有
  // 任何清扫、也不在启动期清——每个残骸都换个新名字，于是逐个累积。这里启动时扫一遍（只清够老的：
  // 在途临时文件活不过毫秒级，5 分钟安全边际避免误删别的进程正在写的那份）。
  // 清扫是尽力而为：出错只打一行，绝不影响服务起来。
  try {
    const swept = sweepAllTmpResidue();
    if (swept.removed > 0) {
      console.log(
        `[tatai-server] 清理原子写残骸 ${swept.removed} 个（${swept.bytes} B，走查 ${swept.scanned_dirs} 个目录${swept.truncated ? "，已达上限提前停手" : ""}）`,
      );
    }
  } catch (e) {
    console.warn(`[tatai-server] 原子写残骸清扫失败（不影响启动）：${(e as Error).message}`);
  }
  // U2：打包态日志落盘位置一并打出来（这条本身也进了那份日志，等于自证在写）
  if (backendLogFile) console.log(`[tatai-server] 日志落盘: ${backendLogFile}`);
  // S1：红线生效口径与 token 落点（口令本体不打印——要看得用 `pnpm remote:token`，避免日志顺手外传）
  for (const line of remoteConfig.reasons) console.log(`[tatai-server] 安全口径: ${line}`);
  for (const line of remoteConfig.warnings) console.log(`[tatai-server] ${line}`);
  if (remoteConfig.enabled && authService) {
    // Q62（2026-09-18 审计）：`ensureToken()` 此前裸放在 listen 回调里——口令文件坏掉/写不进去时
    // 异常从这里逃出（回调内无 catch）直达 `uncaughtException` → `process.exit(1)`，一个坏文件把整个
    // 后端带走（桌面壳那头表现为"后端没了"，且无人重启）。这里收住异常：如实报错、服务照常起，
    // 远程侧仍 fail-closed（`readTokenRecord` 读不出记录 → 每个非回环请求 401 BAD_TOKEN）。
    // Q124（2026-09-19 审计）：预检 `load()` 此前在 try **之外**——"合法 JSON 但结构不对"的口令文件
    // （kind/token 字段不符，readTokenRecord 按设计抛 AuthError）正是在这一行抛的，于是 Q62 的 catch
    // 一点没兜住：异常逃出 listen 回调 → uncaughtException → exit(1)，整个后端起不来。预检并入同一个
    // try：结构坏的文件走下面的 catch（如实报错 + 服务照常起 + 远程 fail-closed 401）。
    try {
      const brokenTokenFile = fs.existsSync(authService.tokenPath()) && authService.load() === null;
      const { record, created } = authService.ensureToken();
      console.log(
        `[tatai-server] 远程鉴权: ${created ? "已签发新口令" : "沿用既有口令"}，到期 ${record.expires_at}`,
      );
      if (created && brokenTokenFile) {
        console.error(
          `[tatai-server] ⚠ 口令文件原本是坏的/读不出（已重签一枚覆盖，旧文件内容取不出可用口令）：${authService.tokenPath()}`,
        );
      }
    } catch (e) {
      console.error(`[tatai-server] ⚠ 口令不可用（远程鉴权本次不生效，远程请求一律 401）：${sanitizeErrorMessage((e as Error).message)}`);
      console.error(`[tatai-server] 提示：修复或删除 ${authService.tokenPath()} 后重启；本机回环界面不受影响`);
    }
    console.log(`[tatai-server] 口令文件: ${authService.tokenPath()}（勿外传；查看：pnpm remote:token）`);
    console.log(`[tatai-server] ${permissionHint(resolveDataDir())}`);
    if (remoteConfig.hostKind === "lan") {
      for (const { iface, address } of lanAddresses()) {
        console.log(`[tatai-server] 局域网入口: http://${address}:${PORT}（${iface}）`);
        // S2：只读页面入口（另一台设备在浏览器里打开它 → 填口令 → 只读看四样）
        console.log(
          `[tatai-server] 远程只读页面: http://${address}:${PORT}/（只读；口令用 pnpm remote:token 取，` +
            `聊天下发=${remoteConfig.chatExposed ? "开" : "关（默认）"}）`,
        );
      }
    }
    console.log(
      `[tatai-server] 只读口径: 远程来源只放行读方法；会话生命周期例外 ${READ_ONLY_EXEMPT_PATHS.join(" / ")}；` +
        `免凭据静态入口 ${PUBLIC_PATHS.join(" / ")}`,
    );
    // ── S3：审计落点 + 写模式时段起点（DoD①②）──
    // 两件事都在这里做，因为"写模式时段起点"必须**先落审计再开始服务**：审计文件里
    // `action=write-mode-on/off` 这些边界行圈出来的区间就是"写模式时间段"，事后可倒查。
    if (auditLog) {
      auditLog.record({
        actor: "local",
        action: "server-start",
        ip: "127.0.0.1",
        method: null,
        path: null,
        status: null,
        code: null,
        fingerprint: null,
        credential: null,
        project_id: null,
        source: "startup",
        note: `塔台后端启动 pid=${process.pid}；审计只记非回环来源的请求与写模式边界`,
      });
      const snap = writeMode.applyStartup();
      console.log(`[tatai-server] 访问审计: ${auditLog.filePath()}（只追加，滚动留归档；**不在任何项目/仓库内**）`);
      console.log(`[tatai-server] ${auditLog.permissionHint()}`);
      console.log(
        `[tatai-server] 写模式: ${snap.enabled ? "⚠ 开（非回环来源可发起写请求）" : "关（只读为核心）"}；` +
          `时段起点 ${snap.since}（来源 ${snap.source}）`,
      );
      console.log(
        "[tatai-server] 写模式怎么关：主机上 `pnpm remote:write off`（写开关文件，**下一个写请求立即 403**，不用重启）；" +
          "怎么查时段：`pnpm remote:write status` 或读上面那份审计里的 write-mode-on/off 行",
      );
    }
  } else {
    console.log("[tatai-server] 远程访问未开启（默认关闭）：只监听本机回环，外部设备连不上，也未生成任何 token");
  }
  });
})();

// ██ 三期 S3：退出时给写模式时间段收尾（DoD①"写模式时间段明确"）██
// 写模式开着就记一条 `write-mode-off`（来源 shutdown）——审计里的 on/off 边界行成对，区间可倒查；
// 另外记一条 server-stop。进程被强杀（Windows `taskkill /F`）时这些行写不出来，属于预期：
// 此时"关"的边界由下一次启动的那条 startup 行兜住（审计里每个时段至少有一端有据）。
let shutdownLogged = false;
function logShutdown(why: string): void {
  if (shutdownLogged) return;
  shutdownLogged = true;
  try {
    writeMode.closeOnShutdown(why);
  } catch {
    // 审计是旁路：收尾失败不影响退出
  }
}

// Q22（2026-09-18 审计）：退出路径此前既不刷监听队列、也不收 PTY 会话——`closeAllWatchers` 定义在
// watcher.ts 却全仓零调用（死代码），PTY 的 shell 只能指望壳的 `taskkill /T` 或 OS 兜住。
// 现在优雅退出（信号）里真跑一遍：先把各项目已排队的变更刷进 changes.jsonl（不静默丢行），
// 再杀掉全部终端会话（不留孤儿 shell 进程）。两条都容错——收尾失败只记日志，不拦住退出。
async function shutdownCleanup(): Promise<void> {
  try {
    stopAllGraphRefresh(); // V09-07：先摘发现链（退订 + 清防抖），再收 watcher 本体
    await closeAllWatchers();
  } catch (e) {
    console.error(`[tatai-server] 退出收尾：关闭文件监听失败（已忽略，继续退出）：${(e as Error).message}`);
  }
  try {
    await closeAllTerminals();
  } catch (e) {
    console.error(`[tatai-server] 退出收尾：关闭终端会话失败（已忽略，继续退出）：${(e as Error).message}`);
  }
}

// Q128（2026-09-19 审计）：收尾链路改成**两条退出路共用**的一段——
// ① 信号退出（Ctrl+C / SIGTERM / SIGHUP）；② 未捕获异常（`uncaughtException` 的 exit 1）。
// 原先 ② 直接 `process.exit(1)`：既不等 `closeAllWatchers()`（各项目已排队的变更随进程一起丢），
// 也不等 `closeAllTerminals()`（PTY 里的 shell 变成孤儿，全靠壳的 `taskkill /T` 或 OS 兜）。
// 附带修的时序问题：兜底计时原先从"信号进来"起算，而 `closeAllTerminals` 最坏一个会话
// `CLOSE_FORCE_TIMEOUT_MS`=3s——多会话时 2s 计时先到，`exit(0)` 抢在收尾完成前，后面的会话根本
// 轮不到收。现在兜底计时**从收尾完成起算**，只负责"SSE 长连接挂着时 server.close 等太久"这一件事。
// 收尾本身再套一个总上限：链路里每步都有自己的超时，这里只作最后一道保险（收尾卡住也不能把
// 进程永久挂住——Ctrl+C 得能退）。
const CLEANUP_HARD_TIMEOUT_MS = 15_000;
function exitAfterCleanup(code: number): void {
  const hardExit = setTimeout(() => process.exit(code), CLEANUP_HARD_TIMEOUT_MS);
  hardExit.unref();
  void shutdownCleanup().finally(() => {
    clearTimeout(hardExit);
    server.close(() => process.exit(code));
    // SSE 长连接（events / terminal out）挂着时 close 会一直等：收尾完成后 2s 兜底
    setTimeout(() => process.exit(code), 2000).unref();
  });
}

for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(sig, () => {
    logShutdown(`signal:${sig}`);
    // Q22：先收尾（刷队列 + 收 PTY）再关服务；收尾本身不会抛（内部各自 catch），故有界退出见上
    exitAfterCleanup(0);
  });
}
// Q81（2026-09-18 审计）：日志文件收尾（fsync + close）挂在 exit 上——信号退出与任何
// `process.exit()` 都会经过这里；桌面壳收窗的 `taskkill /F` 走不到信号处理器，那种场景靠
// backendLog 的**同步写**兜住（writeSync 返回即已交给内核，没有在途字节可丢）。
process.on("exit", () => {
  // V06-01：撤销写入服务描述符（同步操作，适合这条"只能同步"的退出路径）——
  // 撤销后客户端拿到的是"服务未启动"，而不是指向死端口的旧地址。
  workHost.unpublish();
  // Q128：这个处理器只能同步（不能 await 收尾），真收尾在信号/未捕获异常两条路上做。
  // 走到这里若还有终端会话/监听项目，说明这条退出路径没走收尾——如实打一行（不静默），
  // 让"还有资源没回收"看得见，剩下的交给壳的 taskkill /T 或 OS 回收。
  const leftSessions = terminalSessionCount();
  const leftWatching = listWatching().length;
  if (leftSessions > 0 || leftWatching > 0) {
    console.error(
      `[tatai-server] 退出时仍有未回收资源：终端会话 ${leftSessions} 个、正在监听的项目 ${leftWatching} 个` +
        "（该退出路径无法等待异步收尾）",
    );
  }
  logShutdown("exit");
  closeBackendLog();
});

// ██ 进程级兜底（2026-09-18 安全审计）██
// 两条口径是**刻意分开**的，理由写死在这里：
//   · unhandledRejection（异步拒绝）→ 只记日志，**不退进程**：Node ≥15 的默认行为是整进程崩，
//     对常驻桌面后端过脆——一条 SSE 写失败 / 后台刷盘拒绝就把整套工作台带崩，收益不成比例；
//     请求路径自身都有 catch（见各路由），漏到这里的应是"没接住的旁路"，记下来修而不是崩给人看。
//   · uncaughtException（同步崩溃）→ 记完整日志后**仍退出**（exit 1）：同步异常意味着进程状态
//     已不可信（内存/句柄/半写的文件），按 Node 官方口径吞掉它只会把不确定状态带得更远——
//     保守选择是"崩，但先留证据"；退出前**真跑一遍收尾**（刷监听队列 + 收 PTY，
//     Q128 起与信号退出同一段 `exitAfterCleanup`，原先只补写模式收尾行就退）。
process.on("unhandledRejection", (reason) => {
  const text = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
  console.error(`[tatai-server] 未处理的 Promise 拒绝（已兜住，进程继续）：${text}`);
});
process.on("uncaughtException", (err) => {
  // Q127（2026-09-19 审计）：原先是 `err.stack ?? String(err)` 的模板串——非 Error 抛出（`throw null`、
  // `throw "boom"`）时**读 `.stack` 这一步自己就抛**，handler 自身崩：原始异常栈一个字没打印、
  // 下面的 logShutdown / closeBackendLog / process.exit(1) 全被跳过，退出码从 1 变 7（Node 兜底）。
  // 取值口径与上面的 unhandledRejection 对齐（有 instanceof 守卫）。
  const text = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(`[tatai-server] 未捕获异常（进程状态不可信，记录后退出）：${text}`);
  logShutdown("uncaught-exception");
  // Q128：与信号退出同一口径——先收尾（刷监听队列 + 收 PTY）再退，退出码保持 1
  exitAfterCleanup(1);
});
