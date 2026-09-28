// R3 前端 API 客户端。dev 下 /api 经 vite 代理到后端 8787（vite.config.ts server.proxy）。
// 类型直接复用后端模块的 type-only import，前后端共享同一份口径，不另抄一份。
import type { OnboardResult } from "../server/onboard";
import type { ProjectRecord } from "../server/registry";
import type {
  DesignAppendResult,
  DesignDoc,
  DiscussAppendResult,
  DiscussDoc,
  GateLine,
  Progress,
} from "../server/workstation";
import type { ChatLine, ChatSessionSummary } from "../server/chat";
// V06-07：聊天动作（§3.5–§3.6）——只复用类型与纯口径函数（`chatActionViewOf` 是零 IO 的视图映射）；
// 服务端重逻辑（落盘/模型/派生）不进前端包。
import type { ChatSelection, ChatActionView } from "../server/work/chatActions";
import type { ChangeLine } from "../server/watcher";
import type { AgentRecord } from "../server/agents";
import { apiBase } from "./tauri-env";

// ── P2：跨项目视图（DESIGN.md §11.2「多项目并行增强」）：GET /api/summary/projects ──
// 汇总口径（行的字段 / 排序键 / 分桶 / 缺文件合成）全在服务端，见 src/server/projects-summary.ts（P1）
// 与 src/server/summary.ts（P2 只读合成层）；这里只做 **type-only** 复用——值 import 会把服务端的
// node:fs 依赖链拖进前端包（F2 拆 shared-graph.ts 的同一条理由）。
// 排好序的行与分好组的分桶都由后端给：前端不做排序、不做分桶、不归约严重度，只渲染。

import type {
  GateStepGroup,
  ProjectSummaryRow,
  SummaryScope,
  SummaryScopeSpec,
} from "../server/projects-summary";

/** P2：GET /api/summary/projects 的响应体（与 server/summary.ts 的 payload 同形） */
export interface ProjectsSummaryPayload {
  default_scope: SummaryScope;
  scopes: Record<SummaryScope, SummaryScopeSpec>;
  rows: ProjectSummaryRow[];
  groups: GateStepGroup[];
  errors: { project_id: string; message: string }[];
}

// ── U1（三期）：桌面壳里的绝对基址 ────────────────────────────────────────────
// 全前端只有这一个出口发 HTTP（调用点数随功能增长，以 verify:u1② 不变量断言为准——除 apiFetch 自身外零裸 fetch）；壳里没有 vite 代理，
// 相对路径 `/api/...` 会打到 WebView 自己身上，所以统一加一层基址前缀。
// 非壳内/dev 态 apiBase() 返回空串，请求与 U1 之前逐字相同；探测口径见 src/ui/tauri-env.ts。
function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  return fetch(`${apiBase()}${input}`, init);
}

/** Q103（2026-09-18 审计，2026-09-19 试用修订挪到此处共享）：这条失败是不是「根本没连上后端」
 *  （而非后端回了个业务错误）。判据是 fetch 自己抛的网络层 TypeError，各运行时文案不同：
 *  WebView2/Chromium = `Failed to fetch`、Node/undici = `fetch failed`、WebKit = `Load failed`；
 *  dev 下 vite 代理连不上后端时是 500 + 空体，会在 `res.json()` 上炸成
 *  `Unexpected end of JSON input`——也一并认（都属于「后端没起来」）。
 *  背景：壳是**先开窗、后起服务**（backend.rs 的 /health 探活在后台线程），冷启动/后端重启期间
 *  首屏拉取必然先落空一两次；调用方据此走快重试，别把误导性的「暂无数据」空态钉在屏上。 */
export function isBackendUnreachable(msg: string): boolean {
  return /failed to fetch|fetch failed|load failed|networkerror|err_connection|unexpected end of json input/i.test(msg);
}

/** P2：跨项目汇总快照——一次拿全两种口径的渲染 + 默认口径 + 读失败项目 */
export async function getProjectsSummary(): Promise<ProjectsSummaryPayload> {
  const res = await apiFetch("/api/summary/projects");
  const body = (await res.json()) as { ok: true; summary: ProjectsSummaryPayload } | WsFail;
  if (!body.ok) throw new Error(`[${body.error.code}] ${body.error.message}`);
  return body.summary;
}

// ── V1：实况视图（DESIGN.md §3.10）：GET /api/projects/:id/live 只读聚合快照 ──

import type { LiveSnapshot } from "../server/live";

/** V1：GET /api/projects/:id/live —— 当前阶段/干活 agent/任务计数/Gate 当前步/动作流 */
export async function getLive(id: string): Promise<LiveSnapshot> {
  const res = await apiFetch(`/api/projects/${encodeURIComponent(id)}/live`);
  const body = (await res.json()) as { ok: true; live: LiveSnapshot } | WsFail;
  if (!body.ok) throw new Error(`[${body.error.code}] ${body.error.message}`);
  return body.live;
}

// ── M4：左栏上半「Agent 管理」（DESIGN.md §3.1）：全局 agents.json 只读列表 ──

/** M4：GET /api/agents —— 已登记 agent 列表（last_active_at 倒序，后端排好） */
export async function listAgents(): Promise<AgentRecord[]> {
  const res = await apiFetch("/api/agents");
  const body = (await res.json()) as { ok: true; agents: AgentRecord[] } | WsFail;
  if (!body.ok) throw new Error(`[${body.error.code}] ${body.error.message}`);
  return body.agents;
}

// ── H2：变更流水（DESIGN.md §3.8 简版：顶部小入口「最近变更 · N 条新」，不占主页面）──
// 监听生命周期跟选中态走（§3.9）：选中项目 App 即调 watchProject，取消选中/移除调 unwatchProject。

/** H2：POST /api/projects/:id/watch —— 开监听（幂等，already=true 表示本来就在监听） */
export async function watchProjectApi(id: string): Promise<{ watching: boolean; already: boolean }> {
  const res = await apiFetch(`/api/projects/${encodeURIComponent(id)}/watch`, { method: "POST" });
  const body = (await res.json()) as
    | { ok: true; watch: { watching: boolean; already: boolean } }
    | WsFail;
  if (!body.ok) throw new Error(`[${body.error.code}] ${body.error.message}`);
  return body.watch;
}

/** H2：DELETE /api/projects/:id/watch —— 关监听（幂等，removed=false 表示本来就没在监听）
 *  Q29（2026-09-18 审计）：`keepalive: true` 给窗口关闭（pagehide/beforeunload）用——普通 fetch 会随
 *  页面一起被取消，keepalive 请求则由浏览器接管发完，服务端才真能收到这次关监听。 */
export async function unwatchProjectApi(
  id: string,
  opts?: { keepalive?: boolean },
): Promise<boolean> {
  const res = await apiFetch(`/api/projects/${encodeURIComponent(id)}/watch`, {
    method: "DELETE",
    ...(opts?.keepalive ? { keepalive: true } : {}),
  });
  const body = (await res.json()) as { ok: true; removed: boolean } | WsFail;
  if (!body.ok) throw new Error(`[${body.error.code}] ${body.error.message}`);
  return body.removed;
}

/** H2：GET /api/projects/:id/changes?limit=N —— 读变更流水（时间倒序，最新在前） */
export async function getChanges(id: string, limit?: number): Promise<ChangeLine[]> {
  const res = await apiFetch(
    `/api/projects/${encodeURIComponent(id)}/changes${limit !== undefined ? `?limit=${limit}` : ""}`,
  );
  const body = (await res.json()) as { ok: true; changes: ChangeLine[] } | WsFail;
  if (!body.ok) throw new Error(`[${body.error.code}] ${body.error.message}`);
  return body.changes;
}

/** H3：GET changes 分页/过滤版 —— offset/limit 分页 + path 子串过滤，total 为过滤后总条数 */
export async function getChangesPage(
  id: string,
  opts: { limit?: number; offset?: number; path?: string } = {},
): Promise<{ changes: ChangeLine[]; total: number }> {
  const params = new URLSearchParams();
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  if (opts.offset !== undefined) params.set("offset", String(opts.offset));
  if (opts.path !== undefined && opts.path !== "") params.set("path", opts.path);
  const qs = params.toString();
  const res = await apiFetch(
    `/api/projects/${encodeURIComponent(id)}/changes${qs ? `?${qs}` : ""}`,
  );
  const body = (await res.json()) as
    | { ok: true; changes: ChangeLine[]; total: number }
    | WsFail;
  if (!body.ok) throw new Error(`[${body.error.code}] ${body.error.message}`);
  return { changes: body.changes, total: body.total };
}

// ── P3：全局变更流（DESIGN.md §11.2 二期「全局变更流」）：GET /api/changes/all ──
// 一行 = H3 的 §2.3.5 四字段 + project_id/project_name（归属），类型 type-only 复用服务端模块
// （值 import 会把服务端 node:fs 依赖链拖进前端包，同 P2 跨项目视图那条注释的理由）。
// 后端口径：每项目只倒读需要的窗口 + K 路归并（不把全部行读进内存）、total 为精确行数，
// 见 `src/server/global-changes.ts` 文件头。前端不排序、不合并。

import type { GlobalChangeLine, GlobalChangesStats } from "../server/global-changes";
export type { GlobalChangeLine };

/** P3：GET /api/changes/all 的响应体 */
export interface AllChangesPage {
  changes: GlobalChangeLine[];
  total: number;
  /** 读失败的项目（流水损坏等；有内容就上屏告警条） */
  errors: { project_id: string; message: string }[];
  /** 服务端耗时拆解（首屏/翻页/过滤的真实数字从这里读，不靠猜） */
  stats: GlobalChangesStats;
}

/** P3：跨项目合并的变更流水 —— 时间倒序；offset/limit 分页；projectId 给值则只看这一个项目 */
export async function getAllChangesPage(
  opts: { limit?: number; offset?: number; projectId?: string } = {},
): Promise<AllChangesPage> {
  const params = new URLSearchParams();
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  if (opts.offset !== undefined) params.set("offset", String(opts.offset));
  if (opts.projectId !== undefined && opts.projectId !== "") {
    params.set("project_id", opts.projectId);
  }
  const qs = params.toString();
  const res = await apiFetch(`/api/changes/all${qs ? `?${qs}` : ""}`);
  const body = (await res.json()) as ({ ok: true } & AllChangesPage) | WsFail;
  if (!body.ok) throw new Error(`[${body.error.code}] ${body.error.message}`);
  return { changes: body.changes, total: body.total, errors: body.errors, stats: body.stats };
}

/** 列表项 = 注册表记录 + 后端顺带给出的目录存在性（R3 状态点口径，前端不瞎猜） */
export type ProjectItem = ProjectRecord & { exists: boolean };

export async function listProjects(): Promise<ProjectItem[]> {
  const res = await apiFetch("/api/projects");
  if (!res.ok) throw new Error(`GET /api/projects -> ${res.status}`);
  return (await res.json()) as ProjectItem[];
}

export interface AddProjectInput {
  path: string;
  id?: string;
  name?: string;
}

/** 调 POST /api/projects（R2 接入接口）；成功/失败都是结构化返回（OnboardResult 判别联合） */
export async function addProject(input: AddProjectInput): Promise<OnboardResult> {
  const res = await apiFetch("/api/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  // 后端失败时也返回结构化 JSON（4xx + OnboardErr），不按 HTTP 状态码 throw
  return (await res.json()) as OnboardResult;
}

/** R4：POST /api/projects/:id/open —— 选中项目写回 last_opened_at（§2.3.1） */
export async function openProject(id: string): Promise<ProjectRecord> {
  const res = await apiFetch(`/api/projects/${encodeURIComponent(id)}/open`, {
    method: "POST",
  });
  const body = (await res.json()) as
    | { ok: true; project: ProjectRecord }
    | { ok: false; error: { code: string; message: string } };
  if (!body.ok) throw new Error(`[${body.error.code}] ${body.error.message}`);
  return body.project;
}

/**
 * R4：DELETE /api/projects/:id 的资源回收结果（服务端如实回报：监听是否停掉、关了几个终端会话、
 * 是否超时；Q52 起回收动作自身的失败原因进 `errors`）。
 * Q87（2026-09-18 审计）：此前 `removeProject` 把这一整块丢弃（函数返回 void），全仓没有任何界面
 * 消费点——回收超时只落在服务端 console，用户以为"点了就都收干净了"。现在如实带回并展示。
 */
export interface ReleaseResult {
  watch: boolean;
  terminals: number;
  timedOut: boolean;
  errors: string[];
}

/** R4：DELETE /api/projects/:id —— 只从注册表移除，不删磁盘目录 */
export async function removeProject(id: string): Promise<ReleaseResult> {
  const res = await apiFetch(`/api/projects/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  const body = (await res.json()) as
    | { ok: true; removed: string; released?: Partial<ReleaseResult> }
    | { ok: false; error: { code: string; message: string } };
  if (!body.ok) throw new Error(`[${body.error.code}] ${body.error.message}`);
  const released = body.released ?? {};
  return {
    watch: released.watch === true,
    terminals: typeof released.terminals === "number" ? released.terminals : 0,
    timedOut: released.timedOut === true,
    errors: Array.isArray(released.errors) ? released.errors : [],
  };
}

// ── A3：架构图（DESIGN.md §3.2 模块方框图）：渲染 JSON + 引导态解析/起名 ──

// F2：返回的是**共用数据层**（未按视图过滤的 E_ALL），各视图在前端 selectGraph(mode, graph) 取自己那份；
// 类型走纯模块 shared-graph.ts，前端不引服务端壳 render.ts（避免 tree-sitter 进前端包）。
import type { SharedGraph } from "../arch/shared-graph";

/** A3：GET /api/projects/:id/arch/render —— 渲染数据；exists:false = 未解析（200 空态） */
export async function getArchRender(
  id: string,
): Promise<{ exists: boolean; graph?: SharedGraph }> {
  const res = await apiFetch(`/api/projects/${encodeURIComponent(id)}/arch/render`);
  const body = (await res.json()) as
    | { ok: true; render: { exists: boolean; graph?: SharedGraph } }
    | WsFail;
  if (!body.ok) throw new Error(`[${body.error.code}] ${body.error.message}`);
  return body.render;
}

// Q133：stats 是**类型only** 引用（`import type` 编译期擦除，tree-sitter 不会被打进前端包）——
// 口径只有一份，不在这里另抄一遍 server 的 stats 形状。
// T19：ParseRun/ParseCancelReceipt/ParseRunProgress 同理（run 现场与取消回执的类型only复用）。
import type { ArchParseStats, ParseCancelReceipt, ParseRun, ParseRunProgress } from "../arch/parse";

/** Q133：POST arch/parse 的应答（服务端 result 里除绝对路径 source 外的全量字段）。
 *  stats.budget_exhausted = 本次解析到点收工、模块集不完整——界面靠它当场提示"残缺不当全量" */
export interface ArchParseAck {
  module_count: number;
  duration_ms: number;
  parse_ms: number;
  stats: ArchParseStats;
}

/** T19（DESIGN §11.8）：POST arch/parse 后台 run 形态的应答——
 *  跑完给完整结果（done，形状与旧同步契约一致）；
 *  被显式取消只回取消回执（cancelled + 进度 + 原因 note，**不下发部分结果**）；
 *  失败走 WsFail 抛错（下同 api 惯例）。 */
export type ArchParsePostOutcome =
  | { kind: "done"; run_id: string; deduplicated: boolean; result: ArchParseAck }
  | { kind: "cancelled"; run_id: string; progress: ParseRunProgress; note: string };

/** A3：POST /api/projects/:id/arch/parse —— 启动（或挂上）后台解析 run 并等终态
 *  （T19 起为后台可取消形态；进度用 getArchParseRun 轮询，本调用只等终态） */
export async function postArchParse(id: string): Promise<ArchParsePostOutcome> {
  const res = await apiFetch(`/api/projects/${encodeURIComponent(id)}/arch/parse`, {
    method: "POST",
  });
  const body = (await res.json()) as
    | { ok: true; run_id: string; deduplicated: boolean; result: ArchParseAck }
    | { ok: true; run_id: string; cancelled: true; partial: true; progress: ParseRunProgress; note: string }
    | WsFail;
  if (!body.ok) throw new Error(`[${body.error.code}] ${body.error.message}`);
  if ("cancelled" in body && body.cancelled === true) {
    return { kind: "cancelled", run_id: body.run_id, progress: body.progress, note: body.note };
  }
  if ("result" in body) {
    return { kind: "done", run_id: body.run_id, deduplicated: body.deduplicated, result: body.result };
  }
  throw new Error("[INTERNAL] arch/parse 应答形状未知（既非 done 也非 cancelled）");
}

/** T19：GET /api/projects/:id/arch/parse —— run 状态（进行中优先，否则最近一次；null = 没跑过）。
 *  进页面自动挂上续看与进行中轮询都走这里（断连≠取消：刷新/重进页面靠它恢复跟踪）。 */
export async function getArchParseRun(id: string): Promise<ParseRun | null> {
  const res = await apiFetch(`/api/projects/${encodeURIComponent(id)}/arch/parse`);
  const body = (await res.json()) as { ok: true; run: ParseRun | null } | WsFail;
  if (!body.ok) throw new Error(`[${body.error.code}] ${body.error.message}`);
  return body.run;
}

/** T19：DELETE /api/projects/:id/arch/parse —— 显式取消进行中的解析 run。
 *  §11.8：取消只来自显式取消动作——本调用只允许由用户点「取消解析」触发，
 *  页面卸载/切换/断连绝不允许调它。 */
export async function deleteArchParseRun(id: string): Promise<ParseCancelReceipt> {
  const res = await apiFetch(`/api/projects/${encodeURIComponent(id)}/arch/parse`, {
    method: "DELETE",
  });
  const body = (await res.json()) as ({ ok: true } & ParseCancelReceipt) | WsFail;
  if (!body.ok) throw new Error(`[${body.error.code}] ${body.error.message}`);
  const { ok: _ok, ...receipt } = body;
  return receipt;
}

/** A3：POST /api/projects/:id/arch/name —— Flash 起名（幂等走缓存，签名未变零请求） */
export async function postArchName(id: string): Promise<{ named: number; cache_hits: number }> {
  const res = await apiFetch(`/api/projects/${encodeURIComponent(id)}/arch/name`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  const body = (await res.json()) as
    | { ok: true; result: { named: number; cache_hits: number } }
    | WsFail;
  if (!body.ok) throw new Error(`[${body.error.code}] ${body.error.message}`);
  return body.result;
}

// ── A4：逐级下钻 + 懒加载 + 布局记忆（DESIGN.md §3.3 / §4.1 下钻层 / §4.4）──

import type { ExpandResult } from "../arch/expand";
import type { GraphMode } from "../arch/graph-mode";
import type { ArchLayoutFile, NodePosition } from "../arch/layoutStore";
import { PROJECT_ARCH_LAYOUT_KEY } from "../arch/graph-mode";

/** A4：POST /api/projects/:id/arch/expand —— 就地展开模块直接子级（纯静态，llm_calls 恒 0） */
export async function postArchExpand(id: string, modulePath: string): Promise<ExpandResult> {
  const res = await apiFetch(`/api/projects/${encodeURIComponent(id)}/arch/expand`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ module_path: modulePath }),
  });
  const body = (await res.json()) as { ok: true; result: ExpandResult } | WsFail;
  if (!body.ok) throw new Error(`[${body.error.code}] ${body.error.message}`);
  return body.result;
}

/** A4/F4：GET /api/projects/:id/arch/layout —— 读布局记忆（缺文件返回空 positions；
 *  v1 旧结构由服务端迁成按视图分键的 v2，本接口返回全量两个视图的坐标） */
export async function getArchLayout(id: string): Promise<ArchLayoutFile> {
  const res = await apiFetch(`/api/projects/${encodeURIComponent(id)}/arch/layout`);
  const body = (await res.json()) as { ok: true; layout: ArchLayoutFile } | WsFail;
  if (!body.ok) throw new Error(`[${body.error.code}] ${body.error.message}`);
  return body.layout;
}

/** A4/F4：PUT /api/projects/:id/arch/layout —— 按视图合并写回节点坐标（拖动后 debounce 调用）；
 *  返回合并后的全量文件（调用方拿它刷新本地布局记忆，两视图各自的桶都在里面） */
export async function putArchLayout(
  id: string,
  mode: GraphMode | typeof PROJECT_ARCH_LAYOUT_KEY,
  positions: Record<string, NodePosition>,
): Promise<ArchLayoutFile> {
  const res = await apiFetch(`/api/projects/${encodeURIComponent(id)}/arch/layout`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode, positions }),
  });
  const body = (await res.json()) as
    | { ok: true; result: { positions: Record<string, Record<string, NodePosition>> } }
    | WsFail;
  if (!body.ok) throw new Error(`[${body.error.code}] ${body.error.message}`);
  return { version: 2, positions: body.result.positions };
}

// ── N2：思维导图折叠态记忆（GET/PUT /api/projects/:id/arch/mindmap-fold）──

import type { MindMapExpandEntry } from "../arch/foldStore";

/** N2：GET arch/mindmap-fold —— 本项目已展开的节点 [{id,path}]（缺文件/缺本项目键 → 空数组 =
 *  默认全折叠，§3.3 规则 5）。导图进入时按它补拉那几枝（只补拉已展开的枝，不全量）。 */
export async function getArchMindMapFold(id: string): Promise<MindMapExpandEntry[]> {
  const res = await apiFetch(`/api/projects/${encodeURIComponent(id)}/arch/mindmap-fold`);
  const body = (await res.json()) as { ok: true; fold: { expanded: MindMapExpandEntry[] } } | WsFail;
  if (!body.ok) throw new Error(`[${body.error.code}] ${body.error.message}`);
  return body.fold.expanded;
}

/** N2：PUT arch/mindmap-fold —— 覆盖写本项目那份展开态（原子落盘，其它项目的键原样保留） */
export async function putArchMindMapFold(
  id: string,
  expanded: MindMapExpandEntry[],
): Promise<MindMapExpandEntry[]> {
  const res = await apiFetch(`/api/projects/${encodeURIComponent(id)}/arch/mindmap-fold`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ expanded }),
  });
  const body = (await res.json()) as { ok: true; result: { expanded: MindMapExpandEntry[] } } | WsFail;
  if (!body.ok) throw new Error(`[${body.error.code}] ${body.error.message}`);
  return body.result.expanded;
}

// ── A5：对账标黄（DESIGN.md §4.5）：读最近一次对账结果 / 立即跑一次（消费 B3 对账钩子）──

import type { ReconcileResult } from "../arch/reconcile";
import type { DataFlowModel, GraphUpdateView, SemanticStatusView } from "./arch/projectGraph";
import type { ProvenanceModel } from "./arch/provenance";

/** A5：GET /api/projects/:id/arch/reconcile —— 最近一次对账结果；exists:false = 未跑过（200 空态） */
export async function getArchReconcile(
  id: string,
): Promise<{ exists: boolean; result?: ReconcileResult }> {
  const res = await apiFetch(`/api/projects/${encodeURIComponent(id)}/arch/reconcile`);
  const body = (await res.json()) as
    | { ok: true; reconcile: { exists: boolean; result?: ReconcileResult } }
    | WsFail;
  if (!body.ok) throw new Error(`[${body.error.code}] ${body.error.message}`);
  return body.reconcile;
}

/**
 * V09-11：GET /api/projects/:id/arch/dataflow —— 数据流向图的**来源分层**（§3.2／§11.2）。
 * 返回体里 `current_implementation`（当前实现＝静态依赖层方向渲染，**不是**业务数据流）与
 * `target_semantics`（目标＝输入源→处理→存储→输出/外部系统的实际路径）**同时在场且互相区分**；
 * 另带实体表、关系表、至少一条端到端数据链与覆盖对账（缺路径显式报缺）。只读接口。
 */
export async function getArchDataFlow(id: string): Promise<DataFlowModel> {
  const res = await apiFetch(`/api/projects/${encodeURIComponent(id)}/arch/dataflow`);
  const body = (await res.json()) as { ok: true; data_flow: DataFlowModel } | WsFail;
  if (!body.ok) throw new Error(`[${body.error.code}] ${body.error.message}`);
  return body.data_flow;
}

/** A5：POST /api/projects/:id/arch/reconcile —— 立即跑一次对账并落盘（差异是信号不是错误） */
export async function postArchReconcile(id: string): Promise<ReconcileResult> {
  const res = await apiFetch(`/api/projects/${encodeURIComponent(id)}/arch/reconcile`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const body = (await res.json()) as { ok: true; result: ReconcileResult } | WsFail;
  if (!body.ok) throw new Error(`[${body.error.code}] ${body.error.message}`);
  return body.result;
}

// ── G2：七步时间线数据源（DESIGN.md §3.4）：progress.json（§2.3.2）+ gate.jsonl 流水（§2.3.3）──

interface WsFail {
  ok: false;
  error: { code: string; message: string };
}

/** G2：GET /api/projects/:id/progress —— 读 progress.json（缺文件后端自动初始化，幂等） */
export async function getProgress(id: string): Promise<Progress> {
  const res = await apiFetch(`/api/projects/${encodeURIComponent(id)}/progress`);
  const body = (await res.json()) as { ok: true; progress: Progress } | WsFail;
  if (!body.ok) throw new Error(`[${body.error.code}] ${body.error.message}`);
  return body.progress;
}

/** G2：GET /api/projects/:id/gate.jsonl —— gate 流水原文（ndjson），前端逐行解析 */
export async function getGateLines(id: string): Promise<GateLine[]> {
  const res = await apiFetch(`/api/projects/${encodeURIComponent(id)}/gate.jsonl`);
  if (!res.ok) {
    const body = (await res.json()) as WsFail;
    throw new Error(`[${body.error.code}] ${body.error.message}`);
  }
  const text = await res.text();
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as GateLine);
}

// ── G3：人手点过关/打回 + 迭代回需求（§5.1/§5.2：只有人能触发转移，by 固定 "user"）──

/** A5 随 gate 响应带回的对账结果：成功 = `ReconcileResult`；对账自己失败 = `{ error }`
 *  （服务端口径：对账是信号不是错误，失败不阻断 Gate 转移，见 index.ts 的 gate 路由）。 */
export type GateReconcile = ReconcileResult | { error: string };

/** G3：POST /api/projects/:id/gate —— 对当前步点过关/打回（reject 必须带 note）。
 *  Q38（2026-09-18 审计）：响应里的 `reconcile` 一并返回——服务端每次过关/打回都跑一次对账
 *  并声明"作为过关参考之一"，此前客户端把它整段丢掉，对账结果在决策现场不可见。 */
export async function postGateTransition(
  id: string,
  input: { step: string; result: "pass" | "reject"; note?: string | null },
): Promise<{ progress: Progress; reconcile: GateReconcile | null }> {
  const res = await apiFetch(`/api/projects/${encodeURIComponent(id)}/gate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...input, by: "user" }),
  });
  const body = (await res.json()) as
    | { ok: true; progress: Progress; reconcile?: GateReconcile | null }
    | WsFail;
  if (!body.ok) throw new Error(`[${body.error.code}] ${body.error.message}`);
  return { progress: body.progress, reconcile: body.reconcile ?? null };
}

/** G3：POST /api/projects/:id/gate/back —— 迭代回「需求」步（§5.1，目标固定 requirement） */
export async function postGateBack(id: string): Promise<Progress> {
  const res = await apiFetch(`/api/projects/${encodeURIComponent(id)}/gate/back`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ step: "requirement" }),
  });
  const body = (await res.json()) as { ok: true; progress: Progress } | WsFail;
  if (!body.ok) throw new Error(`[${body.error.code}] ${body.error.message}`);
  return body.progress;
}

// ── T2：终端页签（DESIGN.md §3.7；T1 后端 PTY 通道的客户端）──
// E1 多终端分屏：四个 :sid 客户端都接可选的 projectId（拼 `?project_id=`），
// 后端据此做**会话隔离**——A 项目的 sid 报给 B 项目一律 404，pane 之间不可能互相写。

import type { TerminalSessionInfo } from "../server/pty";

/** E1：`:sid` 类请求的项目范围查询串（不带 projectId 时为空串，口径与 T2 一致） */
function scopeQuery(projectId?: string): string {
  return projectId ? `?project_id=${encodeURIComponent(projectId)}` : "";
}

/** T2：POST /api/projects/:id/terminal —— 建会话（cwd 锁项目根，由后端注册表解析） */
export async function createTerminal(
  id: string,
  cols: number,
  rows: number,
): Promise<TerminalSessionInfo> {
  const res = await apiFetch(`/api/projects/${encodeURIComponent(id)}/terminal`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cols, rows }),
  });
  const body = (await res.json()) as { ok: true; session: TerminalSessionInfo } | WsFail;
  if (!body.ok) throw new Error(`[${body.error.code}] ${body.error.message}`);
  return body.session;
}

/** E1：GET /api/terminal/sessions?project_id= —— 列某项目当前活跃会话（编号次序 = 创建序） */
export async function listTerminalSessions(projectId: string): Promise<TerminalSessionInfo[]> {
  const res = await apiFetch(
    `/api/terminal/sessions?project_id=${encodeURIComponent(projectId)}`,
  );
  const body = (await res.json()) as
    | { ok: true; sessions: TerminalSessionInfo[] }
    | WsFail;
  if (!body.ok) throw new Error(`[${body.error.code}] ${body.error.message}`);
  return body.sessions;
}

/** T2：POST /api/terminal/:sid/in {data} —— 键盘输入回写 */
export async function writeTerminalInput(
  sid: string,
  data: string,
  projectId?: string,
): Promise<void> {
  const res = await apiFetch(
    `/api/terminal/${encodeURIComponent(sid)}/in${scopeQuery(projectId)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ data }),
    },
  );
  const body = (await res.json()) as { ok: true } | WsFail;
  if (!body.ok) throw new Error(`[${body.error.code}] ${body.error.message}`);
}

/** T2：POST /api/terminal/:sid/resize {cols,rows} —— 容器尺寸变化时同步 */
export async function resizeTerminalSession(
  sid: string,
  cols: number,
  rows: number,
  projectId?: string,
): Promise<void> {
  const res = await apiFetch(
    `/api/terminal/${encodeURIComponent(sid)}/resize${scopeQuery(projectId)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cols, rows }),
    },
  );
  const body = (await res.json()) as { ok: true } | WsFail;
  if (!body.ok) throw new Error(`[${body.error.code}] ${body.error.message}`);
}

/** T2：DELETE /api/terminal/:sid —— 页签/pane 关闭或卸载时关会话（幂等，防泄漏） */
export async function closeTerminalSession(sid: string, projectId?: string): Promise<void> {
  const res = await apiFetch(`/api/terminal/${encodeURIComponent(sid)}${scopeQuery(projectId)}`, {
    method: "DELETE",
  });
  const body = (await res.json()) as { ok: true } | WsFail;
  if (!body.ok) throw new Error(`[${body.error.code}] ${body.error.message}`);
}

// ── U2（三期）：SSE 地址也必须带壳内基址（否则打包壳里终端一片空白） ──────────────
// 踩坑实证（2026-09-18，接进打包壳的 WebView2 抓包）：
// `apiFetch` 会给请求加壳内绝对基址，但 `new EventSource("/api/...")` 是**自己拼 URL** 的——
// 壳内相对路径打到 WebView 自己身上（Tauri 资产协议返回 index.html），浏览器直接报
//   EventSource's response has a MIME type ("text/html") that is not "text/event-stream". Aborting.
// 症状：打包壳里终端窗口全黑（输出根本进不来）、顶部「最近变更」与实况视图收不到推送；
// dev 走 vite 代理，同样的相对路径毫无问题——所以这条只在打包态暴露，必须在打包态验。
// 口径：SSE 的 URL 一律经 apiSseUrl 拼，全仓不再出现裸的相对 /api 路径喂给 EventSource。
export function apiSseUrl(input: string): string {
  return `${apiBase()}${input}`;
}

/** H2/V1：`/api/projects/:id/events` 的 SSE 地址（变更入口与实况视图共用同一份拼法） */
export function projectEventsUrl(projectId: string): string {
  return apiSseUrl(`/api/projects/${encodeURIComponent(projectId)}/events`);
}

/** E1：`/api/terminal/:sid/out` 的 SSE 地址（带项目范围，供 pane 各自连自己的会话） */
export function terminalStreamUrl(sid: string, projectId?: string): string {
  return apiSseUrl(`/api/terminal/${encodeURIComponent(sid)}/out${scopeQuery(projectId)}`);
}

// ── E3：命令历史检索（DESIGN.md §3.7 二期「命令历史检索」）──
// 数据源 = 后端自管落盘 `<项目根>/.工作台/logs/terminal-history.jsonl`（不是 shell 自己的历史文件）；
// 前端只有两条口子：读（检索）与清空（隐私红线，二次确认后才调清空）。

import type { TerminalHistoryLine } from "../server/terminalHistory";
export type { TerminalHistoryLine };

export interface TerminalHistoryResult {
  items: TerminalHistoryLine[];
  /** 命中总条数（未按 limit 截断前） */
  total: number;
  /** 坏行条数（后端跳过不抛，只计数） */
  corrupt: number;
  /** 活跃文件相对项目根的路径（如 `.工作台/logs/terminal-history.jsonl`） */
  file: string;
}

/** E3：GET /api/projects/:id/terminal/history?q=&limit= —— 关键字检索（跨会话、跨 pane） */
export async function getTerminalHistory(
  id: string,
  q?: string,
  limit?: number,
): Promise<TerminalHistoryResult> {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (limit !== undefined) params.set("limit", String(limit));
  const qs = params.toString();
  const res = await apiFetch(
    `/api/projects/${encodeURIComponent(id)}/terminal/history${qs ? `?${qs}` : ""}`,
  );
  const body = (await res.json()) as
    | ({ ok: true } & TerminalHistoryResult)
    | WsFail;
  if (!body.ok) throw new Error(`[${body.error.code}] ${body.error.message}`);
  return { items: body.items, total: body.total, corrupt: body.corrupt, file: body.file };
}

/** E3：DELETE /api/projects/:id/terminal/history —— 清空本项目历史（只清本项目） */
export async function clearTerminalHistory(
  id: string,
): Promise<{ removed_lines: number; removed_files: number }> {
  const res = await apiFetch(`/api/projects/${encodeURIComponent(id)}/terminal/history`, {
    method: "DELETE",
  });
  const body = (await res.json()) as
    | { ok: true; removed_lines: number; removed_files: number }
    | WsFail;
  if (!body.ok) throw new Error(`[${body.error.code}] ${body.error.message}`);
  return { removed_lines: body.removed_lines, removed_files: body.removed_files };
}

// ── V06-06：三个主视图的只读取数（DESIGN.md §3.2–§3.3 / §4.2–§4.7）──
// 两条都是**已有**的只读入口（V06-05 的 `GET arch/blueprint`、V06-09 的 `GET status-projection`），
// 本卡不新增路由、不新增写口：主视图只消费这两份已交付的数据。
// 类型一律 **type-only** 引用（与 getLive/getArchRender 同一口径）：值 import 会把服务端的
// `node:fs` 依赖链拖进前端包（V06-05 的 `pnpm build` 就是栽在这上面）。

import type { Blueprint, BlueprintReceipt } from "../arch/blueprint";
import type { StatusProjection, V1ModuleStatus } from "../server/work/statusProjection";

/** 草稿规划图（§3.2 未审定方案可预览；恒为未发布，`label` 由服务端给死） */
export interface ArchBlueprintDraft {
  exists: boolean;
  /** 服务端给的草稿标识（存在草稿时恒为 `draft_unaudited`） */
  label?: string;
  note?: string;
  /** 为什么只是草稿（首个 blocking 原因，如 `baseline_missing：…`；没有 blocking 时为 null） */
  reason?: string | null;
  baseline_id?: string | null;
  generated_at?: string;
  blueprint?: Blueprint;
}

/** V06-06：GET /api/projects/:id/arch/blueprint 的响应体（V06-05 已交付的读口） */
export interface ArchBlueprintPayload {
  /** `exists:false` = 从未发布过规划图（**正常空态**，不是错误）：与"加载失败"必须分开显示 */
  blueprint: { exists: false } | { exists: true; blueprint: Blueprint; receipt: BlueprintReceipt | null };
  /** §3.2 草稿预览：没有已发布图时给派生草稿（**未审定、不可施工**），明标 `draft_unaudited` */
  draft: ArchBlueprintDraft;
  /** 规划↔实现对账（§4.5；没图时为 null） */
  plan_code: unknown | null;
  /** 旧图与规划层合成后的共用数据层（§3.2：空仓也有规划图——旧侧为空时它就是纯规划图） */
  view: { graph: SharedGraph; blueprint: Blueprint | null; baseline_id: string | null };
  /** V08-05：语义整理层状态（横幅要如实区分"图是当前版"与"语义层未生效"；缺省 = 不知道） */
  semantic: { status?: SemanticStatusView | null } | null;
  /**
   * V09-12：源变化发现链的**图更新状态**（`.工作台/arch/graph-update.json` 的只读回读；
   * 没有记录 = null，**不当成"正在更新"**）。界面据此显示「正在更新＋有依据的预计用时／无法估计」
   * 与「已过期／失败＋原因」（§3.3 末段 / §4.4）。类型只镜像形状，前端不 import 服务端模块。
   */
  update: GraphUpdateView | null;
  /**
   * V09-13：每个节点/关系的**来源与证据标注**＋交付阻断读数（判据的唯一实现是
   * `src/ui/arch/provenance.ts`，界面只渲染、不另判一套）。缺省 = 服务端这一版还没给（旧响应）。
   */
  provenance?: ProvenanceModel | null;
}

/** V06-06：GET /api/projects/:id/arch/blueprint —— 读已发布的规划图 + 派生回执 + 合成视图 */
export async function getArchBlueprint(id: string): Promise<ArchBlueprintPayload> {
  const res = await apiFetch(`/api/projects/${encodeURIComponent(id)}/arch/blueprint`);
  const body = (await res.json()) as ({ ok: true } & ArchBlueprintPayload) | WsFail;
  if (!body.ok) throw new Error(`[${body.error.code}] ${body.error.message}`);
  return { blueprint: body.blueprint, draft: body.draft, plan_code: body.plan_code, view: body.view, semantic: body.semantic ?? null, update: body.update ?? null, provenance: body.provenance ?? null };
}

/** V06-06：GET /api/projects/:id/status-projection 的响应体（V06-09 已交付的读口） */
export interface StatusProjectionPayload {
  last_seq: number;
  /** V09-07（E.8-7）：`plan_definition` = 当前 PLAN 定义哈希（图新鲜度施工图侧改比它） */
  revisions: { design?: string | null; plan?: string | null; plan_definition?: string | null; interface?: string | null; code?: string | null };
  baseline: { baseline_id: string; design_revision: string; plan_revision: string; plan_definition?: string | null } | null;
  summary: Record<string, unknown>;
  /** 每对象四维 + 六态 + 原因 + required/passed/missing（`v1_status` 是服务端给的兼容四色） */
  objects: (StatusProjection & { v1_status: V1ModuleStatus })[];
}

/** V06-06：GET /api/projects/:id/status-projection —— 状态与原因的唯一来源（界面不自己判状态） */
export async function getStatusProjection(id: string): Promise<StatusProjectionPayload> {
  const res = await apiFetch(`/api/projects/${encodeURIComponent(id)}/status-projection`);
  const body = (await res.json()) as { ok: true; projection: StatusProjectionPayload } | WsFail;
  if (!body.ok) throw new Error(`[${body.error.code}] ${body.error.message}`);
  return body.projection;
}

// ── C017：用量统计（认领额度＝运营节流口径 + 事件流可核对耗时；Token/金额缺来源如实「未计量」）──

import type { ProjectUsage } from "../server/work/usage";
export type { ProjectUsage };

/** C017：GET /api/projects/:id/work/usage —— 只读现算（界面只展示，不自行计数/配对/计量） */
export async function getWorkUsage(id: string): Promise<ProjectUsage> {
  const res = await apiFetch(`/api/projects/${encodeURIComponent(id)}/work/usage`);
  const body = (await res.json()) as { ok: true; usage: ProjectUsage } | WsFail;
  if (!body.ok) throw new Error(`[${body.error.code}] ${body.error.message}`);
  return body.usage;
}

// ── D1：设计书只读（DESIGN.md §3.5：只读展示，界面上没有任何可编辑入口，后端也无写接口）──

/** D1：GET /api/projects/:id/design —— 读设计书全文；exists:false = 该项目还没有设计书（正常空态） */
export async function getDesign(id: string): Promise<DesignDoc> {
  const res = await apiFetch(`/api/projects/${encodeURIComponent(id)}/design`);
  const body = (await res.json()) as { ok: true; design: DesignDoc } | WsFail;
  if (!body.ok) throw new Error(`[${body.error.code}] ${body.error.message}`);
  return body.design;
}

// ── D2：待议记录（DESIGN.md §3.5 提疑权：只能追加，没有任何修改/删除接口或 UI）──

/** D2：GET /api/projects/:id/discuss —— 读待议记录全文（塔台 = DESIGN.md 附录 B 抽取）；exists:false = 还没有待议 */
export async function getDiscuss(id: string): Promise<DiscussDoc> {
  const res = await apiFetch(`/api/projects/${encodeURIComponent(id)}/discuss`);
  const body = (await res.json()) as { ok: true; discuss: DiscussDoc } | WsFail;
  if (!body.ok) throw new Error(`[${body.error.code}] ${body.error.message}`);
  return body.discuss;
}

/** D2：POST /api/projects/:id/discuss —— 追加一条待议（前端只发内容，日期前缀由服务端补） */
export async function postDiscuss(id: string, content: string): Promise<DiscussAppendResult> {
  const res = await apiFetch(`/api/projects/${encodeURIComponent(id)}/discuss`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content }),
  });
  const body = (await res.json()) as { ok: true; result: DiscussAppendResult } | WsFail;
  if (!body.ok) throw new Error(`[${body.error.code}] ${body.error.message}`);
  return body.result;
}

// ── B3：逆向落稿（DESIGN.md §9：老项目补设计书——草稿不是 design.md，定版只能由人/Max 触发）──

import type { ReverseDraftDoc, DraftDesignResult, FinalizeResult } from "../server/reverseDraft";

/** B3：GET /api/projects/:id/design/draft —— 读逆向草稿；exists:false = 还没有草稿（正常空态） */
export async function getReverseDraft(id: string): Promise<ReverseDraftDoc> {
  const res = await apiFetch(`/api/projects/${encodeURIComponent(id)}/design/draft`);
  const body = (await res.json()) as { ok: true; draft: ReverseDraftDoc } | WsFail;
  if (!body.ok) throw new Error(`[${body.error.code}] ${body.error.message}`);
  return body.draft;
}

/**
 * V06-07 双文档链：GET /api/projects/:id/design/draft（同一路径的第二份）
 * —— 读**剩余施工草稿** `.工作台/plan.draft.md`；与设计草稿一次拿齐，互不混淆。
 */
export async function getReversePlanDraft(id: string): Promise<ReverseDraftDoc> {
  const res = await apiFetch(`/api/projects/${encodeURIComponent(id)}/design/draft`);
  const body = (await res.json()) as { ok: true; plan_draft: ReverseDraftDoc } | WsFail;
  if (!body.ok) throw new Error(`[${body.error.code}] ${body.error.message}`);
  return body.plan_draft ?? { exists: false };
}

/** B3：POST /api/projects/:id/design/draft —— 生成/重生成逆向草稿（已有 design.md 返回 conflict 不覆盖） */
export async function postReverseDraft(id: string): Promise<DraftDesignResult> {
  const res = await apiFetch(`/api/projects/${encodeURIComponent(id)}/design/draft`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  const body = (await res.json()) as { ok: true; result: DraftDesignResult } | WsFail;
  if (!body.ok) throw new Error(`[${body.error.code}] ${body.error.message}`);
  return body.result;
}

/** B3：POST /api/projects/:id/design/finalize —— 定版（只能由人/Max 触发）：草稿转正 + Gate 按确认步设置 + 对账钩子 */
export async function postDesignFinalize(
  id: string,
  input: { gate_step: string; note?: string },
): Promise<FinalizeResult> {
  const res = await apiFetch(`/api/projects/${encodeURIComponent(id)}/design/finalize`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = (await res.json()) as { ok: true; result: FinalizeResult } | WsFail;
  if (!body.ok) throw new Error(`[${body.error.code}] ${body.error.message}`);
  return body.result;
}

// ── D3：落稿（DESIGN.md §3.5/§3.6：聊天 → design.md 的唯一写口；不点就绝不写）──
// 两步：draft 只生成草稿（服务端读会话 + 调 flash，不落盘）→ 用户在弹窗编辑确认后
// append 才落盘。密钥红线同 C1：前端只发 session_id / content，apiKey 永远不进前端。

/** D3：POST /api/projects/:id/design/draft —— 用 flash 把会话讨论提炼成落稿草稿（不写文件） */
export async function postDesignDraft(
  id: string,
  sessionId: string,
): Promise<{ draft: string; model: string }> {
  const res = await apiFetch(`/api/projects/${encodeURIComponent(id)}/design/draft`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session_id: sessionId }),
  });
  const body = (await res.json()) as { ok: true; draft: string; model: string } | WsFail;
  if (!body.ok) throw new Error(`[${body.error.code}] ${body.error.message}`);
  return { draft: body.draft, model: body.model };
}

/** D3：POST /api/projects/:id/design/append —— 把确认后的草稿追加到 design.md 末尾（塔台自身被拒） */
export async function postDesignAppend(
  id: string,
  content: string,
): Promise<DesignAppendResult> {
  const res = await apiFetch(`/api/projects/${encodeURIComponent(id)}/design/append`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content }),
  });
  const body = (await res.json()) as { ok: true; result: DesignAppendResult } | WsFail;
  if (!body.ok) throw new Error(`[${body.error.code}] ${body.error.message}`);
  return body.result;
}

// ── C3：Flash 聊天（DESIGN.md §3.6；存储走 C2 落盘层 .工作台/chat/<sid>.jsonl）──
// 密钥红线：前端只调 /api，body 只发 content——apiKey/baseURL 永远不进前端（C1 泄钥红线）。

/** C3：GET /api/projects/:id/chat/sessions —— 会话列表（按最后写入倒序 + 首条消息摘要） */
export async function listChatSessions(id: string): Promise<ChatSessionSummary[]> {
  const res = await apiFetch(`/api/projects/${encodeURIComponent(id)}/chat/sessions`);
  const body = (await res.json()) as { ok: true; sessions: ChatSessionSummary[] } | WsFail;
  if (!body.ok) throw new Error(`[${body.error.code}] ${body.error.message}`);
  return body.sessions;
}

/** C3：POST /api/projects/:id/chat/sessions —— 创建会话（建空 jsonl，返回 session_id） */
export async function createChatSession(id: string): Promise<string> {
  const res = await apiFetch(`/api/projects/${encodeURIComponent(id)}/chat/sessions`, {
    method: "POST",
  });
  const body = (await res.json()) as { ok: true; session_id: string } | WsFail;
  if (!body.ok) throw new Error(`[${body.error.code}] ${body.error.message}`);
  return body.session_id;
}

/** C3：GET /api/projects/:id/chat/sessions/:sid —— 读回消息数组（刷新后历史恢复走这里） */
export async function getChatSession(id: string, sid: string): Promise<ChatLine[]> {
  const res = await apiFetch(
    `/api/projects/${encodeURIComponent(id)}/chat/sessions/${encodeURIComponent(sid)}`,
  );
  const body = (await res.json()) as { ok: true; messages: ChatLine[] } | WsFail;
  if (!body.ok) throw new Error(`[${body.error.code}] ${body.error.message}`);
  return body.messages;
}

/** 删除会话（2026-09-19 主人试用报障：聊天页没有手动删会话入口）。jsonl 连带删除不可恢复 */
export async function deleteChatSession(id: string, sid: string): Promise<void> {
  const res = await apiFetch(
    `/api/projects/${encodeURIComponent(id)}/chat/sessions/${encodeURIComponent(sid)}`,
    { method: "DELETE" },
  );
  const body = (await res.json()) as { ok: true } | WsFail;
  if (!body.ok) throw new Error(`[${body.error.code}] ${body.error.message}`);
}

export interface ChatStreamResult {
  /** 收到的 assistant 全文（error 时为已收到的部分） */
  full: string;
  /** SSE error 事件的可读消息（user 行已落盘）；无错误为 null */
  error: string | null;
  /** V06-07：本轮 SSE 收到的动作回执（真实落盘口径；没触发动作为空数组） */
  actions: ChatActionView[];
}

/**
 * C3：POST /api/projects/:id/chat/sessions/:sid/messages { content } —— 发问，真流式读 SSE：
 * fetch + ReadableStream 逐 chunk 解码，`data: {"delta":"…"}` 逐 delta 回调 onDelta
 * （上屏节奏跟流走，不是等全文）；`data: {"error":"…"}` 收集为可读错误；`data: [DONE]` 收尾。
 * 2026-09-19 试用增强二期：`data: {"tool":{"name","summary"}}` 是服务端工具调用活动提示
 * （模型正在读项目文件/搜代码），经 onTool 可选回调上屏——不给回调则静默忽略。
 */
export async function sendChatMessage(
  id: string,
  sid: string,
  content: string,
  onDelta: (delta: string) => void,
  onTool?: (info: { name: string; summary: string }) => void,
  onAction?: (action: ChatActionView) => void,
): Promise<ChatStreamResult> {
  const res = await apiFetch(
    `/api/projects/${encodeURIComponent(id)}/chat/sessions/${encodeURIComponent(sid)}/messages`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content }),
    },
  );
  if (!res.ok || !res.body) {
    const body = (await res.json().catch(() => null)) as WsFail | null;
    throw new Error(
      body && !body.ok ? `[${body.error.code}] ${body.error.message}` : `HTTP ${res.status}`,
    );
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let full = "";
  let error: string | null = null;
  const actions: ChatActionView[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    // SSE 事件以空行分隔；不完整事件留在 buf 里等下一个 chunk
    let sep: number;
    while ((sep = buf.indexOf("\n\n")) !== -1) {
      const event = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      for (const line of event.split("\n")) {
        const t = line.trim();
        if (!t.startsWith("data: ") || t === "data: [DONE]") continue;
        const p = JSON.parse(t.slice(6)) as {
          delta?: string;
          error?: string;
          tool?: { name: string; summary: string };
          action?: ChatActionView;
        };
        if (typeof p.delta === "string") {
          full += p.delta;
          onDelta(p.delta);
        }
        if (typeof p.error === "string") error = p.error;
        if (p.tool && typeof p.tool.name === "string") onTool?.(p.tool);
        // V06-07：动作回执（六阶段文案来自服务端 `label`，前端只渲染不推断）
        if (p.action !== undefined && typeof p.action.action_id === "string") {
          actions.push(p.action);
          onAction?.(p.action);
        }
      }
    }
  }
  return { full, error, actions };
}

// ── V06-07：聊天动作（DESIGN.md §3.5–§3.6 / §3.12）──
// 说明：动作的触发与执行都在服务端（自然表达在 messages 路由里认、跑、落盘）；这里只做
// 读回执 / 显式跑 / 续接失败动作 / 审定并激活提案四个入口，前端不推断状态、不伪造回执。

/** V06-07：GET /api/projects/:id/chat/actions —— 读动作回执（重新打开会话/重开进程后可核实） */
export async function listChatActions(id: string, sessionId?: string | null): Promise<ChatActionView[]> {
  const q = sessionId === undefined || sessionId === null ? "" : `?session_id=${encodeURIComponent(sessionId)}`;
  const res = await apiFetch(`/api/projects/${encodeURIComponent(id)}/chat/actions${q}`);
  const body = (await res.json()) as { ok: true; actions: ChatActionView[] } | WsFail;
  if (!body.ok) throw new Error(`[${body.error.code}] ${body.error.message}`);
  return body.actions;
}

/** V06-07：POST /api/projects/:id/chat/actions（op=run）—— 显式跑一次动作 */
export async function runChatAction(
  id: string,
  input: { text: string; sessionId?: string | null; selection?: ChatSelection | null },
): Promise<ChatActionView> {
  const res = await apiFetch(`/api/projects/${encodeURIComponent(id)}/chat/actions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      op: "run",
      text: input.text,
      ...(input.sessionId !== undefined && input.sessionId !== null ? { session_id: input.sessionId } : {}),
      ...(input.selection !== undefined && input.selection !== null ? { selection: input.selection } : {}),
    }),
  });
  const body = (await res.json()) as { ok: true; action: ChatActionView } | WsFail;
  if (!body.ok) throw new Error(`[${body.error.code}] ${body.error.message}`);
  return body.action;
}

/** V06-07：POST /api/projects/:id/chat/actions（op=retry）—— 续接失败动作（不产生第二个动作） */
export async function retryChatAction(id: string, actionId: string): Promise<ChatActionView> {
  const res = await apiFetch(`/api/projects/${encodeURIComponent(id)}/chat/actions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ op: "retry", action_id: actionId }),
  });
  const body = (await res.json()) as { ok: true; action: ChatActionView } | WsFail;
  if (!body.ok) throw new Error(`[${body.error.code}] ${body.error.message}`);
  return body.action;
}

/** V06-07：POST /api/projects/:id/chat/actions（op=activate）—— 审定并激活提案（只能由人触发） */
export async function activateChatAction(
  id: string,
  actionId: string,
  input: { approved_by: string; approval_basis: string; approval_kind: "user_confirmed" | "delegated_technical_review" },
): Promise<ChatActionView> {
  const res = await apiFetch(`/api/projects/${encodeURIComponent(id)}/chat/actions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ op: "activate", action_id: actionId, ...input }),
  });
  const body = (await res.json()) as { ok: true; action: ChatActionView } | WsFail;
  if (!body.ok) throw new Error(`[${body.error.code}] ${body.error.message}`);
  return body.action;
}

// ── V06-08：施工图页 / 待议处置 / 验收页（DESIGN.md §3.1 / §3.4–§3.5 / §3.7–§3.14）──
// 类型一律 **type-only** 引用服务端模块（同 V06-06 那条注释的理由：值 import 会把服务端的
// `node:fs`/`node:crypto` 依赖链拖进浏览器包，`pnpm build` 直接红）。

import type { TaskDefinition } from "../server/work/plan";
import type { TaskAlignment, TaskState } from "../server/work/tasks";
import type {
  DecisionAction,
  DecisionRecord,
  DiscussionDisposition,
  DiscussionRef,
  RelatedImplementation,
} from "../server/work/decisions";
import type { DisplayStatus } from "../server/work/statusProjection";
import type { EvidenceManifestEntry } from "../server/work/evidence";
import type { AcceptanceRecord, SubmissionRecord } from "../server/work/audit";
import type { ProjectBaseline } from "../server/work/documents";

export type { DecisionAction, DecisionRecord, DiscussionRef, DiscussionDisposition, RelatedImplementation };

/** V06-08：每卡的原文定位片段（卡片 ↔ 施工图原文双向定位的原料） */
export interface PlanExcerpt {
  section_text: string | null;
  row_text: string | null;
  section_lines: [number, number] | null;
  row_line: number;
}

export interface PlanBaselineInfo {
  baseline_id: string;
  design_revision: string;
  plan_revision: string;
  approved_by: string;
  approval_kind: "user_confirmed" | "delegated_technical_review";
  active_at: string;
}

export type PlanPayload =
  | { exists: false }
  | {
      exists: true;
      source_path: string;
      origin: string;
      content_sha256: string;
      definition_sha256: string;
      lines: number;
      baseline: PlanBaselineInfo | null;
      definitions: TaskDefinition[];
      /** 每卡的定义哈希（`taskDefinitionHash`；不含状态/时间/执行日志） */
      definition_hashes: Record<string, string>;
      states: Record<string, TaskState>;
      alignment: TaskAlignment;
      excerpts: Record<string, PlanExcerpt>;
    };

/** V06-08：GET /api/projects/:id/plan —— 施工定义 + 运行状态 + 对齐 + 原文定位片段 */
export async function getPlan(id: string): Promise<PlanPayload> {
  const res = await apiFetch(`/api/projects/${encodeURIComponent(id)}/plan`);
  const body = (await res.json()) as { ok: true; plan: PlanPayload } | WsFail;
  if (!body.ok) throw new Error(`[${body.error.code}] ${body.error.message}`);
  return body.plan;
}

export interface DiscussionEntryView {
  index: number;
  ref: DiscussionRef;
  /** 待议原文整行（逐字节来自待议源；界面只渲染不重写） */
  text: string;
  disposition: DiscussionDisposition;
}

export interface DiscussionsPayload {
  exists: boolean;
  is_tatai: boolean;
  source: string | null;
  entries: DiscussionEntryView[];
  decisions: DecisionRecord[];
  /** 采纳 ≠ 已实现：采纳/被替代且关联任务的条目 → 关联任务的真实状态与用户验收 */
  implementations: Record<string, RelatedImplementation>;
  corrupt: number;
  decisions_path: string;
}

/** V06-08：GET /api/projects/:id/discussions —— 待议条目 + 处置派生态 + 处置记录 */
export async function getDiscussions(id: string): Promise<DiscussionsPayload> {
  const res = await apiFetch(`/api/projects/${encodeURIComponent(id)}/discussions`);
  const body = (await res.json()) as { ok: true; discussions: DiscussionsPayload } | WsFail;
  if (!body.ok) throw new Error(`[${body.error.code}] ${body.error.message}`);
  return body.discussions;
}

export interface DecisionInput {
  action: DecisionAction;
  discussion_ref: DiscussionRef;
  reason: string;
  decided_by: string;
  related?: Partial<{
    baseline_id: string | null;
    design_revision: string | null;
    plan_revision: string | null;
    task_id: string | null;
  }>;
  supersedes?: string | null;
}

/** V06-08：POST /api/projects/:id/discussions/decisions —— 只追加一条处置记录 */
export async function postDecision(
  id: string,
  input: DecisionInput,
): Promise<{ decision: DecisionRecord; disposition: DiscussionDisposition | null; decisions_count: number }> {
  const res = await apiFetch(`/api/projects/${encodeURIComponent(id)}/discussions/decisions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = (await res.json()) as
    | { ok: true; decision: DecisionRecord; disposition: DiscussionDisposition | null; decisions_count: number }
    | WsFail;
  if (!body.ok) throw new Error(`[${body.error.code}] ${body.error.message}`);
  return {
    decision: body.decision,
    disposition: body.disposition,
    decisions_count: body.decisions_count,
  };
}

export interface AcceptanceTaskView {
  task_id: string;
  goal: string;
  deliverables: string[] | null;
  evidence_requirement: string | null;
  checks: { text: string; checked: boolean; line: number }[];
  execution_status: string | null;
  execution_label: string | null;
  display_status: DisplayStatus | null;
  display_status_label: string | null;
  reasons: { code: string; text: string }[];
  missing: { check_id: string; label: string; why: string }[];
  acceptance: "pending" | "accepted" | "rejected" | "accepted_known_limit";
  acceptance_records: AcceptanceRecord[];
  latest_acceptance: AcceptanceRecord | null;
  evidence: (EvidenceManifestEntry & { effective: boolean })[];
  scenarios: { ref: string; url: string | null; kind: "link" | "text" }[];
  submission: {
    record_id: string;
    at: string;
    submitted_by: string;
    commands: { command: string; exit_code: number; output_ref: string | null }[];
    untested: { item: string; reason: string }[];
    known_issues: string[];
    changed_files: string[];
    evidence_refs: string[];
  } | null;
  readable_scenario: {
    input: string;
    expected: string;
    actual: string;
    evidence: string;
    result: DisplayStatus | null;
  };
  result_entry: { kind: "available" | "stale" | "unavailable"; url: string | null; note: string };
}

/** 补修包 F：一条已装配的运行入口（登记内容 + 来源成果与版本 + 当前状态） */
export interface RuntimeEntryView {
  scenario: string;
  url: string;
  verified_at: string;
  status: "reachable" | "unreachable" | "unknown";
  reason: string | null;
  source_record_id: string;
  /** F3：来源事实类别（成果登记 / Agent 结果回报） */
  source_kind: "submission" | "result_submitted";
  source_revision: string | null;
  source_revision_kind: string | null;
  source_submitted_by: string;
  source_task_id: string | null;
  registered_at: string;
  state: "openable" | "reverify_due" | "failed" | "unknown";
  state_label: string;
  openable: boolean;
  /** 版本轴（与 state 相互独立）：绑定的成果版本 vs 当前版本 */
  revision_state: "current" | "outdated" | "unknown";
  revision_label: string;
}

export interface RuntimeEntrySummary {
  kind: "available" | "stale" | "unavailable";
  label: string;
  note: string;
  total: number;
  /** 现在真的能打开的条数（**含**"待重新验证"） */
  can_open_count: number;
  fresh_count: number;
  reverify_due_count: number;
  failed_count: number;
  unknown_count: number;
  outdated_count: number;
}

export interface AcceptancePayload {
  last_seq: number;
  baseline: { baseline_id: string; design_revision: string; plan_revision: string } | null;
  tasks: AcceptanceTaskView[];
  pending: string[];
  evidence_manifest: EvidenceManifestEntry[];
  counts: { pending: number; accepted: number; rejected: number; accepted_known_limit: number };
  /** 补修包 F：项目级可体验运行入口（装配自成果登记，与用户验收记录无关） */
  runtime_entries: RuntimeEntryView[];
  runtime_entry_summary: RuntimeEntrySummary;
  basis: string;
}

/** V06-08：GET /api/projects/:id/acceptance —— 待验收区 + 有效场景证据 + 可读场景 */
export async function getAcceptance(id: string): Promise<AcceptancePayload> {
  const res = await apiFetch(`/api/projects/${encodeURIComponent(id)}/acceptance`);
  const body = (await res.json()) as { ok: true; acceptance: AcceptancePayload } | WsFail;
  if (!body.ok) throw new Error(`[${body.error.code}] ${body.error.message}`);
  return body.acceptance;
}

/** V06-08：POST /api/projects/:id/acceptance —— 用户人工验收（接受/退回/接受已知限制） */
export async function postAcceptance(
  id: string,
  input: {
    decision: "accept" | "reject" | "accept_known_limit";
    task_id?: string | null;
    scenario_refs?: string[];
    evidence_refs?: string[];
    note?: string | null;
  },
): Promise<{ acceptance: AcceptanceTaskView["acceptance"] | null }> {
  const res = await apiFetch(`/api/projects/${encodeURIComponent(id)}/acceptance`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...input, accepted_by: "user" }),
  });
  const body = (await res.json()) as
    | { ok: true; acceptance: AcceptanceTaskView["acceptance"] | null }
    | WsFail;
  if (!body.ok) throw new Error(`[${body.error.code}] ${body.error.message}`);
  return { acceptance: body.acceptance };
}

/** V06-08：GET /api/projects/:id/documents —— 只取生效基线（顶部状态条的「有效版本」，§3.1） */
export async function getActiveBaseline(
  id: string,
): Promise<{ active: ProjectBaseline | null; count: number; corrupt: number }> {
  const res = await apiFetch(`/api/projects/${encodeURIComponent(id)}/documents`);
  const body = (await res.json()) as
    | { ok: true; documents: { baseline: { active: ProjectBaseline | null; count: number; corrupt: number } } }
    | WsFail;
  if (!body.ok) throw new Error(`[${body.error.code}] ${body.error.message}`);
  return body.documents.baseline;
}

export type { SubmissionRecord };


// ── V06-12：Git 保存版本提醒的只读读口（DESIGN.md §3.15 / §8.5）──
// 一条口子、一个方向：界面只消费服务端算好的提醒（变更摘要 / 文件范围 / 最后检测时间 / 跟踪状态 /
// 私有事实备份 / 成果口径 / 给执行 Agent 的整理说明）。**前端不发任何 Git 写请求**——本卡没有写口，
// 「稍后提醒」也只是本地暂缓展示，不落盘、不改仓库。
// 类型一律 type-only 引用（与 getLive/getStatusProjection 同一口径）：值 import 会把服务端
// `node:crypto` / `node:child_process` 依赖链拖进前端包（V06-05 的 `pnpm build` 就是栽在这上面）。
import type { GitStatusReport, VersionReminderPayload } from "../server/gitStatus";

export type { GitStatusReport, VersionReminderPayload };

export interface GitStatusPayload {
  /** 只读探测的原始结论（契约字段就是 PLAN 点名的那些） */
  git: GitStatusReport;
  /** 折好的提醒（界面只渲染，不自己推状态） */
  reminder: VersionReminderPayload;
}

/**
 * V06-12：GET /api/projects/:id/git-status —— 只读 Git 探测 + 提醒派生。
 * 探测失败也会 200 返回（`git.error` / `reminder.probe_error` 如实带原因）：这是"结论是未知"，
 * 不是"接口坏了"，界面必须把两者分开显示（§3.15「只读探测失败不当作干净」）。
 */
export async function getGitStatus(id: string): Promise<GitStatusPayload> {
  const res = await apiFetch(`/api/projects/${encodeURIComponent(id)}/git-status`);
  const body = (await res.json()) as ({ ok: true } & GitStatusPayload) | WsFail;
  if (!body.ok) throw new Error(`[${body.error.code}] ${body.error.message}`);
  return { git: body.git, reminder: body.reminder };
}

// ── V09-06：私有事实备份/恢复入口（PLAN.md V09-06，DESIGN.md §8.5 / §12.2 末行）──
// 四条口子：清单（读）/ 创建备份（写）/ 单份清单+核验+恢复预览（读）/ 恢复到隔离目录（写）。
// 类型照旧 type-only 复用服务端模块（值 import 会把 `node:fs` 依赖链拖进前端包）。
// 失败码是本卡要的"可分辨"之处（`BackupApiError.code`）：损坏 / 权限 / 空间不足 / 目标不可写 /
// 目标已存在 / 位置不合法 各自一个 code，界面据此说清"是什么拦下了"，不合并成一句"失败了"。
import type {
  BackupCreateResult,
  BackupEntryFailureCode,
  BackupInspectResult,
  BackupListResult,
  BackupRestoreResult,
} from "../server/work/backupEntry";

export type {
  BackupCreateResult,
  BackupEntryFailureCode,
  BackupInspectResult,
  BackupListResult,
  BackupRestoreResult,
};

/** 备份面失败：`code` 是可分辨的失败码（不是笼统一句"失败"），`detail` 带服务端的现场读数 */
export class BackupApiError extends Error {
  readonly code: string;
  readonly detail: unknown;
  constructor(code: string, message: string, detail: unknown) {
    super(`[${code}] ${message}`);
    this.name = "BackupApiError";
    this.code = code;
    this.detail = detail;
  }
}

function throwBackupFail(body: { error: { code: string; message: string; detail?: unknown } }): never {
  throw new BackupApiError(body.error.code, body.error.message, body.error.detail ?? null);
}

/** V09-06：GET /api/projects/:id/backups —— 备份清单（清单读不出来的逐条如实带 ok:false + 原因） */
export async function getBackups(id: string, sourceParent?: string): Promise<BackupListResult> {
  const res = await apiFetch(`/api/projects/${encodeURIComponent(id)}/backups${sourceQuery(sourceParent)}`);
  const body = (await res.json()) as { ok: true; backups: BackupListResult } | WsFail;
  if (!body.ok) throwBackupFail(body);
  return body.backups;
}

/**
 * `source_parent` 查询串（V09-06 定向返工）。
 *
 * 备份落点由用户选 ⇒ 备份可能在项目外的任意目录里。清单/详情都带这个位置：
 * 服务端在**用户重新选的那个位置**上按清单归属认领本项目自己的备份（别的项目的不列、不读）。
 * 空串/未给 = 用默认落点（既有行为逐字不变）。
 */
function sourceQuery(sourceParent?: string): string {
  return sourceParent === undefined || sourceParent === ""
    ? ""
    : `?source_parent=${encodeURIComponent(sourceParent)}`;
}

/**
 * V09-06：POST /api/projects/:id/backups —— 创建一份一致备份。
 * `destParent` 是**落点父目录**（省略即用塔台数据目录下的默认位置）；给了则必须已存在且可写
 * （服务端只接受本机来源给的落点，且拒收落在项目根内的位置）。
 */
export async function postBackup(id: string, destParent?: string): Promise<BackupCreateResult> {
  const res = await apiFetch(`/api/projects/${encodeURIComponent(id)}/backups`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(destParent === undefined || destParent === "" ? {} : { dest_parent: destParent }),
  });
  const body = (await res.json()) as { ok: true; backup: BackupCreateResult } | WsFail;
  if (!body.ok) throwBackupFail(body);
  return body.backup;
}

/** V09-06：GET /api/projects/:id/backups/:backupId —— 清单 + 八条核验 + 恢复预览（只读） */
export async function getBackup(
  id: string,
  backupId: string,
  sourceParent?: string,
): Promise<BackupInspectResult> {
  const res = await apiFetch(
    `/api/projects/${encodeURIComponent(id)}/backups/${encodeURIComponent(backupId)}${sourceQuery(sourceParent)}`,
  );
  const body = (await res.json()) as { ok: true; backup: BackupInspectResult } | WsFail;
  if (!body.ok) throwBackupFail(body);
  return body.backup;
}

/**
 * V09-06：POST /api/projects/:id/backups/:backupId/restore —— 只恢复到**隔离目录**。
 * `destParent` 是**隔离位置的父目录**（省略即用塔台数据目录下的默认位置），隔离目录新建在它下面。
 * `sourceParent` 是这份备份**当初放在哪**（用户重新选的那个位置；省略即默认落点）。
 * 应答恒为 `replaced:false`；本入口没有"替换当前数据"的动作（那一步由用户本人另行决定）。
 */
export async function postRestoreBackup(
  id: string,
  backupId: string,
  destParent?: string,
  sourceParent?: string,
): Promise<BackupRestoreResult> {
  const res = await apiFetch(
    `/api/projects/${encodeURIComponent(id)}/backups/${encodeURIComponent(backupId)}/restore`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...(destParent === undefined || destParent === "" ? {} : { dest_parent: destParent }),
        ...(sourceParent === undefined || sourceParent === "" ? {} : { source_parent: sourceParent }),
      }),
    },
  );
  const body = (await res.json()) as { ok: true; restore: BackupRestoreResult } | WsFail;
  if (!body.ok) throwBackupFail(body);
  return body.restore;
}
