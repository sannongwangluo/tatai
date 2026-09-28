// 补修包 E：**有效基线激活后的自动触发链**（PLAN.md「补修分包」E 行；DESIGN §4.1 / §4.4 / §4.5）。
//
// 为什么要有这个文件：V06-05 把触发语义收窄成"基线激活只触发**确定性派生层**（零模型），
// 模型语义整理只在显式 `semantic:true` 时跑"——裁定认为这**不合原意**。本文件把缺的那条链补上：
//
//   ① **确定性派生先落地**（零模型）：激活后立刻给出可用规划内容，不因模型快慢/可用性拖着用户看图。
//   ② **自动检查语义整理结果**：按**来源分段**算键（基线 + 该段来源内容 + 生成器版本 + 分段口径版本）——
//      命中即复用（零调用）；缺失或该段来源变了才算"要整理"。
//   ③ **只处理受影响范围**：一次调用只把"要整理"的段放进输入（未受影响段只给稳定 ID 索引），
//      未受影响段的既有整理结果**原样继承**（不重跑、不丢）。
//   ④ **不该触发的别触发**：任务进度/检查结果/颜色/布局变化根本不进分段键（键里没有这些），
//      所以这些变化 = 键没变 = 零模型调用、连图都不重画（`repainted:false`）。
//   ⑤ **有界重试 + 终止态**：一轮内最多 `SEMANTIC_MAX_ATTEMPTS_PER_RUN` 次，跨轮最多
//      `SEMANTIC_MAX_FAILURE_ATTEMPTS` 次（并有退避），到顶后**不再自动重试**——只等
//      "来源变化"或"显式 `semantic:true`"才继续，绝不做无界重试。
//   ⑥ **降级与保护**：模型不可用 → 保留有效旧整理结果（标 `inherited`）或只出确定性结果，
//      并在状态/回执里说清**版本、覆盖与缺失**，`semantic_complete:false`——不冒充本轮完整整理完成。
//   ⑦ **校验失败/过时响应不覆盖较新结果**：发布走 V06-05 的校验/发布/过时把关（epoch + 缓存键复核），
//      分段结果落缓存前还要再核一次该段的键（对不上就当过时丢弃）。
//   模型**不裁定完成色或新架构**：落地的整理结果照样过 `sanitizeModelProposal` 与 `validateBlueprint`。
//
// 落点（都在项目私有目录里，不进仓库）：
//   · `<项目根>/.工作台/arch/semantic-cache.json` —— 分段语义整理结果缓存（含失败账目）
//   · `<项目根>/.工作台/arch/semantic-status.json` —— 最近一次自动链运行状态（可跨进程读）
//   · `<项目根>/.工作台/arch/blueprint.json` / `blueprint-receipt.json` —— 仍是 V06-05 的那两份
//
// 运行开关（运维/验证用，与 `TATAI_WORK_FAULT_SNAPSHOT` 同款先例，产品路径缺省开启）：
//   `TATAI_SEMANTIC_AUTO=0` → 只做确定性派生与检查登记，**不**自动发起模型整理。
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import {
  BLUEPRINT_GENERATOR_VERSION,
  blueprintCacheKeysOf,
  blueprintDir,
  buildBlueprintMessages,
  defaultBlueprintChat,
  deriveBlueprint,
  readBlueprint,
  readBlueprintSources,
  rebuildBlueprint,
  sanitizeModelProposal,
  writeJsonAtomic,
  type Blueprint,
  type BlueprintChatFn,
  type BlueprintProposal,
  type BlueprintSemanticScopeNote,
  type BlueprintSourceRef,
  type BlueprintSources,
} from "./blueprint";
import { nowIso } from "../server/time";

// ───────────────────────────────── 常量 ─────────────────────────────────

/** 分段口径版本：**只在分段口径变了时**改它（改了会让所有分段缓存失效，这是有意的）。 */
export const SEMANTIC_SCOPE_VERSION = "e.1";
/** 分段缓存落点（项目私有目录内） */
export const SEMANTIC_CACHE_FILE = "semantic-cache.json";
/** 运行状态落点（可跨进程读：回执要能回答"这一版整理是哪次跑的"） */
export const SEMANTIC_STATUS_FILE = "semantic-status.json";
/** 一轮内每段最多尝试次数（有界重试；两次之间按 `SEMANTIC_RETRY_BACKOFF_MS` 退避） */
export const SEMANTIC_MAX_ATTEMPTS_PER_RUN = 2;
/** 跨轮累计失败上限：到顶即**终止态**（只等来源变化或显式 semantic:true，不再自动重试） */
export const SEMANTIC_MAX_FAILURE_ATTEMPTS = 3;
/** 一轮内的重试退避 */
export const SEMANTIC_RETRY_BACKOFF_MS = 400;
/** 跨轮重试的最小间隔（防止"每次激活都重试一遍"变成重试风暴） */
export const SEMANTIC_RETRY_BACKOFF_ACROSS_RUNS_MS = 30_000;
/** 后台整理起跑前的静默期：让刚发出的激活响应先落地、不与紧随其后的交互请求抢网关配额 */
export const SEMANTIC_KICKOFF_DELAY_MS = 300;
/** 关闭自动整理的进程开关（`TATAI_SEMANTIC_AUTO=0`；只关"自动"，显式 `semantic:true` 照旧可用） */
export const SEMANTIC_AUTO_ENV = "TATAI_SEMANTIC_AUTO";

/** 来源分段：design = 设计段（设计书正文/章节索引与声明模块）；plan = 施工段（施工图任务定义） */
export type SemanticScopeId = "design" | "plan";
export const SEMANTIC_SCOPES: readonly SemanticScopeId[] = ["design", "plan"];

const sha256 = (data: string): string => crypto.createHash("sha256").update(data).digest("hex");

/** 项目进程开关：`TATAI_SEMANTIC_AUTO=0` 关掉自动模型整理（确定性派生照常） */
export function semanticAutoEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[SEMANTIC_AUTO_ENV]?.trim() !== "0";
}

// ───────────────────────────────── 数据契约 ─────────────────────────────────

export type SemanticScopeState =
  /** 复用既有整理结果（该段来源没变） */
  | "reused"
  /** 本轮真整理了（模型调用换来的结果） */
  | "tidied"
  /** 本轮没整理、沿用上次结果（模型不可用 / 本轮只要不整理 / 已达重试上限）——如实标注，不冒充本轮完成 */
  | "inherited"
  /** 该段来源不存在（如项目还没有设计书） */
  | "missing"
  /** 本轮发起过整理但没得到可用结果 */
  | "failed";

export interface SemanticScopeAccount {
  scope: SemanticScopeId;
  state: SemanticScopeState;
  /** 该段本轮的缓存键（null = 该段来源缺失） */
  key: string | null;
  source_sha256: string | null;
  /** 该段上一次真正跑出结果的时间（沿用旧结果时即那一版的时间） */
  last_ran_at: string | null;
  /** 该段整理结果基于的源是否已经变了（true = 这批整理结果基于旧来源，不能当现行） */
  stale_source: boolean;
  /** 本轮为该段打出去的模型调用数（0 = 没调用） */
  model_calls: number;
  /** 该段贡献的整理条目数（节点 + 关系） */
  entries: number;
  error: string | null;
}

/** 分段缓存里的一条：某段在某版来源上的语义整理结果（模型回执原文摘要一并留档） */
export interface SemanticScopeRecord {
  scope: SemanticScopeId;
  scope_key: string;
  baseline_id: string | null;
  source_sha256: string;
  generator_version: string;
  scope_version: string;
  ran_at: string;
  trigger: string;
  attempts: number;
  proposal: BlueprintProposal;
  rejected_fields: string[];
  dropped: { what: string; why: string }[];
  raw_sha256: string | null;
  raw_excerpt: string | null;
}

/** 失败账目（跨轮累计；`attempts >= SEMANTIC_MAX_FAILURE_ATTEMPTS` 即终止态） */
export interface SemanticFailureRecord {
  scope: SemanticScopeId;
  scope_key: string;
  attempts: number;
  last_at: string;
  error: string;
}

export interface SemanticCache {
  version: 1;
  generator_version: string;
  scope_version: string;
  /** 分段整理结果：键是段名，值是**该段最近一次成功**的结果（旧键的结果不再当现行，只会被标 `stale_source`） */
  shards: Partial<Record<SemanticScopeId, SemanticScopeRecord>>;
  /** 失败账目：键是段名 */
  failures: Partial<Record<SemanticScopeId, SemanticFailureRecord>>;
}

export type SemanticOutcome =
  | "semantic_ready"
  | "cache_hit"
  | "degraded_model_unavailable"
  | "degraded_partial"
  | "pending"
  | "no_baseline"
  | "deduped";

export interface SemanticRunStatus {
  version: 1;
  run_id: string;
  trigger: string;
  started_at: string;
  finished_at: string | null;
  /** 阶段：检查 → 整理 → 发布 → 终态 */
  phase: "checking" | "tidying" | "publishing" | "done" | "degraded" | "failed";
  outcome: SemanticOutcome;
  /** 这一版的语义整理是不是"覆盖全部来源段的完整一轮"（false 时不得对外说整理完成） */
  semantic_complete: boolean;
  baseline_id: string | null;
  generator_version: string;
  scope_version: string;
  /** 已发布规划图的版本信息（回执要能回答"这一版是哪一版"） */
  blueprint: {
    cache_key: string | null;
    published_at: string | null;
    published: boolean;
    reason: string | null;
    /** 本轮是否真的重画/重写了图（false = 命中完整缓存，一个字节没动） */
    repainted: boolean;
    kept_previous: boolean;
  };
  model: { enabled: boolean; available: boolean; called: boolean; calls: number; error: string | null };
  scopes: SemanticScopeAccount[];
  /** 覆盖（来自已发布的图）与缺失（哪一段、为什么没整理出来） */
  coverage: Blueprint["coverage"] | null;
  missing: { scope: SemanticScopeId; reason: string }[];
  /** 人话说明（界面/回执直接显示） */
  note: string;
}

// ───────────────────────────────── 读齐输入与分段键 ─────────────────────────────────

/** 一段的**来源内容哈希**：设计段 = 设计书整体内容哈希；施工段 = 施工图**定义**哈希。
 *  与 `blueprint.ts#cacheKeysOf` 的模型段键同一份来源（避免"自动链一套键、派生一套键"）。
 *  任务状态/进度/勾选位不进定义哈希 → 纯状态变化天然不触发整理（§4.4）。 */
export function semanticScopeSha(src: BlueprintSources, scope: SemanticScopeId): string | null {
  return scope === "design" ? src.design?.content_sha256 ?? null : src.plan?.definition_sha256 ?? null;
}

/** 一段的缓存键：基线 + 段名 + 该段来源内容 + 生成器版本 + 分段口径版本 */
export function semanticScopeKey(src: BlueprintSources, scope: SemanticScopeId): string | null {
  const sha = semanticScopeSha(src, scope);
  if (sha === null) return null;
  return sha256([src.baseline_id ?? "no-baseline", scope, sha, BLUEPRINT_GENERATOR_VERSION, SEMANTIC_SCOPE_VERSION].join("|"));
}

export function semanticCachePath(projectId: string, dataDir?: string): string {
  return path.join(blueprintDir(projectId, dataDir), SEMANTIC_CACHE_FILE);
}
export function semanticStatusPath(projectId: string, dataDir?: string): string {
  return path.join(blueprintDir(projectId, dataDir), SEMANTIC_STATUS_FILE);
}

const emptyCache = (): SemanticCache => ({
  version: 1,
  generator_version: BLUEPRINT_GENERATOR_VERSION,
  scope_version: SEMANTIC_SCOPE_VERSION,
  shards: {},
  failures: {},
});

/** 读分段缓存。坏文件**不猜新**：当"没有可用缓存"（= 要整理），并把损坏事实回报给调用方。 */
export function readSemanticCache(projectId: string, dataDir?: string): { cache: SemanticCache; corrupt: boolean } {
  const file = semanticCachePath(projectId, dataDir);
  if (!fs.existsSync(file)) return { cache: emptyCache(), corrupt: false };
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as SemanticCache;
    const cache: SemanticCache = {
      version: 1,
      generator_version: typeof raw.generator_version === "string" ? raw.generator_version : BLUEPRINT_GENERATOR_VERSION,
      scope_version: typeof raw.scope_version === "string" ? raw.scope_version : SEMANTIC_SCOPE_VERSION,
      shards: raw.shards ?? {},
      failures: raw.failures ?? {},
    };
    // 生成器/分段口径版本变了 → 旧分段结果一律不认（版本进缓存键，按设计让旧缓存失效）
    if (cache.generator_version !== BLUEPRINT_GENERATOR_VERSION || cache.scope_version !== SEMANTIC_SCOPE_VERSION) {
      return { cache: emptyCache(), corrupt: true };
    }
    return { cache, corrupt: false };
  } catch {
    return { cache: emptyCache(), corrupt: true };
  }
}

export function readSemanticStatus(projectId: string, dataDir?: string): SemanticRunStatus | null {
  const file = semanticStatusPath(projectId, dataDir);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as SemanticRunStatus;
  } catch {
    return null;
  }
}

// ───────────────────────────────── 分段归属 ─────────────────────────────────

/** 一条整理条目属于哪一段：**只看可定位出处**，不看名字。
 *  出处里出现 `plan_task` 且没有 `design_section` → 施工段；其余（设计章节 / 代码模块 / 无出处）
 *  归设计段——模型整理的主体是设计侧的语义（能力/模块/概念/推断关系），"无出处"的条目也只可能来自
 *  设计段的这次整理。 */
function scopeOfRefs(refs: BlueprintSourceRef[]): SemanticScopeId {
  const kinds = refs.map((r) => r.kind);
  return kinds.includes("plan_task") && !kinds.includes("design_section") ? "plan" : "design";
}

export interface SplitProposal {
  parts: Record<SemanticScopeId, BlueprintProposal>;
  /** 属于**本轮没整理**的段的条目：丢弃并如实登记（不许越范围改写未受影响部分） */
  outOfScope: { what: string; scope: SemanticScopeId }[];
}

/** 把一次调用的返回按来源分段拆开（只保留本轮要整理的段） */
export function splitProposalByScope(proposal: BlueprintProposal, focus: readonly SemanticScopeId[]): SplitProposal {
  const parts: Record<SemanticScopeId, BlueprintProposal> = {
    design: { nodes: [], edges: [] },
    plan: { nodes: [], edges: [] },
  };
  const outOfScope: { what: string; scope: SemanticScopeId }[] = [];
  for (const n of proposal.nodes) {
    const s = scopeOfRefs(n.source_refs);
    if (!focus.includes(s)) outOfScope.push({ what: `节点 ${n.id}`, scope: s });
    else parts[s].nodes.push(n);
  }
  for (const e of proposal.edges) {
    const s = scopeOfRefs(e.source_refs);
    if (!focus.includes(s)) outOfScope.push({ what: `关系 ${e.source}→${e.target}`, scope: s });
    else parts[s].edges.push(e);
  }
  return { parts, outOfScope };
}

/** 段集合 → 合并整理结果（并集；同 id 节点去重由发布侧的 `mergeProposal` 处理） */
function mergeScoped(proposals: (BlueprintProposal | null)[]): BlueprintProposal | null {
  const nodes = proposals.flatMap((p) => p?.nodes ?? []);
  const edges = proposals.flatMap((p) => p?.edges ?? []);
  if (nodes.length === 0 && edges.length === 0) return null;
  return { nodes, edges };
}

const countEntries = (p: BlueprintProposal | null): number => (p === null ? 0 : p.nodes.length + p.edges.length);

// ───────────────────────────────── 运行状态（进程内 + 落盘） ─────────────────────────────────

interface LiveRun {
  status: SemanticRunStatus;
  /** 分段键签名（用于重复事件合并：同项目同签名的重复触发不再开一轮） */
  signature: string;
  settled: Promise<void>;
}

const liveRuns = new Map<string, LiveRun>();

/** 进程内最近一次自动链状态（验证脚本与回执读它；重启后读落盘那份） */
export function autoRunStatusOf(projectId: string): SemanticRunStatus | null {
  return liveRuns.get(projectId)?.status ?? null;
}

/** 后台语义阶段跑完的等待口（`awaitSemantic:false` 的调用方/验证脚本用它做确定性等待） */
export function autoRunSettled(projectId: string): Promise<void> | null {
  return liveRuns.get(projectId)?.settled ?? null;
}

/** 轮内的模型调用数同步到该轮的每个范围账目上（"零模型调用"的断言按范围看也成立） */
function syncScopeCalls(status: SemanticRunStatus, focus: readonly SemanticScopeId[]): void {
  for (const s of status.scopes) if (focus.includes(s.scope)) s.model_calls = status.model.calls;
}

function persistStatus(projectId: string, dataDir: string | undefined, status: SemanticRunStatus): void {
  try {
    writeJsonAtomic(semanticStatusPath(projectId, dataDir), status);
  } catch {
    // 状态落不了盘不该把后台链打挂（回执仍在 blueprint-receipt.json 与进程内状态里）
  }
}

// ───────────────────────────────── 主流程 ─────────────────────────────────

export interface AutoRebuildOptions {
  dataDir?: string;
  /** 触发来源：baseline_activated / chat_action / manual …（进状态与回执，便于回溯） */
  trigger?: string;
  /** 注入的模型入口（缺省 = flash 结构化口；验证脚本注入确定性夹具，不依赖真网关） */
  chat?: BlueprintChatFn;
  now?: () => string;
  /** false = 本轮只做确定性派生 + 检查登记（缺省 true：缺什么整理什么） */
  semantic?: boolean;
  /** false = 确定性派生/复用缓存后立即返回，整理阶段在后台继续（状态可查；缺省 true） */
  awaitSemantic?: boolean;
  /** 后台整理起跑前的静默期（缺省 `SEMANTIC_KICKOFF_DELAY_MS`；验证脚本传 0 走确定性路径） */
  kickoff_delay_ms?: number;
  /** 强制重跑整理（= 显式重试语义：绕过分段缓存；`semantic:true` 的 HTTP 入口用它） */
  force?: boolean;
}

export interface AutoRebuildResult {
  run_id: string;
  trigger: string;
  outcome: SemanticOutcome;
  /** 本轮真正打出去的模型调用次数（纯状态变化 / 缓存命中 = 0） */
  model_calls: number;
  /** 已发布的规划图（发布失败时是上次那份 / 从没有过则 null） */
  blueprint: Blueprint | null;
  cache_key: string | null;
  published: boolean;
  publish_reason: string | null;
  /** 本轮是否真重画/重写了图（false = 完整缓存命中，一个字节没动） */
  repainted: boolean;
  kept_previous: boolean;
  scopes: SemanticScopeAccount[];
  /** 后台语义阶段的 settle 口（`awaitSemantic:false` 时尚未完成） */
  settled: Promise<void>;
  status: SemanticRunStatus;
}

const emptyStatus = (runId: string, trigger: string, at: string): SemanticRunStatus => ({
  version: 1,
  run_id: runId,
  trigger,
  started_at: at,
  finished_at: null,
  phase: "checking",
  outcome: "pending",
  semantic_complete: false,
  baseline_id: null,
  generator_version: BLUEPRINT_GENERATOR_VERSION,
  scope_version: SEMANTIC_SCOPE_VERSION,
  blueprint: { cache_key: null, published_at: null, published: false, reason: null, repainted: false, kept_previous: false },
  model: { enabled: true, available: true, called: false, calls: 0, error: null },
  scopes: [],
  coverage: null,
  missing: [],
  note: "",
});

/**
 * 自动触发链（补修包 E 的主入口）。**不抛**模型/校验类错误——触发它的是"有效基线激活""更新图"
 * 这类正常流程，派生与整理都只是它们的派生动作（读盘层面的硬错误照旧抛）。
 */
export async function autoRebuildBlueprint(projectId: string, opts: AutoRebuildOptions = {}): Promise<AutoRebuildResult> {
  const dataDir = opts.dataDir;
  const now = opts.now ?? nowIso;
  const trigger = opts.trigger ?? "auto";
  const at = now();
  const runId = `sem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const semanticWanted = opts.semantic !== false;
  const modelEnabled = semanticWanted && semanticAutoEnabled();

  const src = readBlueprintSources(projectId, dataDir);
  const keys: Record<SemanticScopeId, string | null> = {
    design: semanticScopeKey(src, "design"),
    plan: semanticScopeKey(src, "plan"),
  };
  const signature = `${keys.design ?? "-"}|${keys.plan ?? "-"}`;
  const open = liveRuns.get(projectId);
  if (open !== undefined && open.signature === signature && open.status.finished_at === null) {
    // 重复事件合并（§4.4）：同一项目、同一分段键签名、上一轮还没跑完 → 不再开一轮、不再调模型
    return {
      run_id: open.status.run_id,
      trigger,
      outcome: "deduped",
      model_calls: 0,
      blueprint: readBlueprint(projectId, dataDir),
      cache_key: open.status.blueprint.cache_key,
      published: open.status.blueprint.published,
      publish_reason: open.status.blueprint.reason,
      repainted: false,
      kept_previous: open.status.blueprint.kept_previous,
      scopes: open.status.scopes,
      settled: open.settled,
      status: {
        ...open.status,
        outcome: "deduped",
        note: `${open.status.note}（重复触发已合并到 run ${open.status.run_id}：本轮不再调模型）`,
      },
    };
  }

  const status = emptyStatus(runId, trigger, at);
  status.baseline_id = src.baseline_id;
  status.model.enabled = modelEnabled;
  let resolveSettled: () => void = () => {};
  const settledRun = new Promise<void>((r) => {
    resolveSettled = r;
  });
  liveRuns.set(projectId, { status, signature, settled: settledRun });

  // ── ① 分段检查（零模型）：哪一段命中、哪一段要整理、哪一段已达终止态 ──
  const cache = readSemanticCache(projectId, dataDir).cache;
  const scopes: SemanticScopeAccount[] = [];
  const toTidy: SemanticScopeId[] = [];
  const blockReason = new Map<SemanticScopeId, string>();
  for (const scope of SEMANTIC_SCOPES) {
    const key = keys[scope];
    const sha = semanticScopeSha(src, scope);
    const rec = cache.shards[scope];
    const fresh = key !== null && rec !== undefined && rec.scope_key === key;
    const fail = cache.failures[scope];
    if (key === null) {
      scopes.push({
        scope,
        state: "missing",
        key,
        source_sha256: null,
        last_ran_at: rec?.ran_at ?? null,
        stale_source: false,
        model_calls: 0,
        entries: countEntries(rec?.proposal ?? null),
        error: null,
      });
      continue;
    }
    if (fresh && opts.force !== true) {
      scopes.push({
        scope,
        state: "reused",
        key,
        source_sha256: sha,
        last_ran_at: rec?.ran_at ?? null,
        stale_source: false,
        model_calls: 0,
        entries: countEntries(rec?.proposal ?? null),
        error: null,
      });
      continue;
    }
    // 这一段的整理结果不是当前来源的：要么重整理，要么沿用旧结果（如实标 stale_source）
    scopes.push({
      scope,
      state: "inherited",
      key,
      source_sha256: sha,
      last_ran_at: rec?.ran_at ?? null,
      stale_source: rec !== undefined && rec.scope_key !== key,
      model_calls: 0,
      entries: countEntries(rec?.proposal ?? null),
      error: null,
    });
    // 终止态把关：达到累计失败上限 / 还在跨轮退避窗口内 → 不再自动重试（无界重试红线）
    if (fail !== undefined && fail.scope_key === key) {
      if (fail.attempts >= SEMANTIC_MAX_FAILURE_ATTEMPTS) {
        blockReason.set(
          scope,
          `该范围已连续失败 ${fail.attempts} 次（上限 ${SEMANTIC_MAX_FAILURE_ATTEMPTS}）：进入终止态，只等来源变化或显式 semantic:true`,
        );
        continue;
      }
      const elapsed = Date.parse(at) - Date.parse(fail.last_at);
      if (Number.isFinite(elapsed) && elapsed >= 0 && elapsed < SEMANTIC_RETRY_BACKOFF_ACROSS_RUNS_MS) {
        blockReason.set(scope, `距上次失败不足 ${Math.round(SEMANTIC_RETRY_BACKOFF_ACROSS_RUNS_MS / 1000)}s：本轮不重试（避免重试风暴）`);
        continue;
      }
    }
    toTidy.push(scope);
  }
  status.scopes = scopes;
  const account = (scope: SemanticScopeId): SemanticScopeAccount => scopes.find((s) => s.scope === scope)!;

  // ── ② 确定性派生 + 复用已有整理结果（零模型）先落地：模型快慢/可用性都不影响现在能看图 ──
  const cachedMerged = mergeScoped(SEMANTIC_SCOPES.map((s) => cache.shards[s]?.proposal ?? null));
  const detKey = blueprintCacheKeysOf(src, false).full_key;
  const previous = readBlueprint(projectId, dataDir);
  const recordedScopes = JSON.stringify(
    SEMANTIC_SCOPES.map((s) => ({ scope: s, key: keys[s] })),
  );
  const sameSemanticState = JSON.stringify(previous?.based_on?.semantic_scopes ?? null) === recordedScopes;
  const needRepaint = !(
    previous !== null &&
    previous.publish.published &&
    previous.based_on?.full_key === detKey &&
    sameSemanticState
  );
  let published: Blueprint | null = previous;
  let publishReason: string | null = "cache_hit";
  let repainted = false;
  let keptPrevious = previous !== null;
  if (needRepaint) {
    const first = await rebuildBlueprint(projectId, {
      ...(dataDir === undefined ? {} : { dataDir }),
      trigger: `${trigger}:deterministic`,
      semantic: false,
      force: true,
      proposal: cachedMerged,
      model_calls: 0,
      semantic_note: { scopes: status.scopes, note: "确定性派生 + 复用已保存的语义整理结果（本轮零模型）" },
    });
    published = first.blueprint;
    publishReason = first.publish.reason;
    repainted = true;
    keptPrevious = first.kept_previous;
    status.blueprint = {
      cache_key: first.cache_key,
      published_at: published?.publish.validated_at ?? null,
      published: first.publish.published,
      reason: first.publish.reason,
      repainted: true,
      kept_previous: first.kept_previous,
    };
  } else {
    // 完整缓存命中：不重画、不重写（纯状态变化走这里；"零模型 + 零重画"两件事都成立）
    status.blueprint = {
      cache_key: previous?.based_on?.full_key ?? null,
      published_at: previous?.publish.validated_at ?? null,
      published: true,
      reason: "cache_hit",
      repainted: false,
      kept_previous: true,
    };
  }
  status.coverage = published?.coverage ?? null;
  persistStatus(projectId, dataDir, status);

  // ── ③ 语义整理阶段（可后台继续；要整理的段都在 `toTidy`） ──
  const settle = async (): Promise<void> => {
    try {
      if (src.baseline_id === null) {
        // 没有生效基线：确定性派生本就拒绝发布（baseline_missing），**不调模型**（草稿不值得整理）
        status.outcome = "no_baseline";
        status.phase = "done";
        status.note = "项目还没有生效基线：只登记，不做语义整理（草稿图不发布，DESIGN §2.9）";
        status.missing = SEMANTIC_SCOPES.filter((s) => keys[s] !== null).map((s) => ({ scope: s, reason: "没有生效基线" }));
        return;
      }
      for (const [scope, reason] of blockReason) {
        account(scope).error = reason;
        status.missing.push({ scope, reason });
      }
      if (!modelEnabled) {
        status.outcome = "pending";
        status.phase = "done";
        status.note = semanticWanted
          ? `本轮关闭了自动整理（${SEMANTIC_AUTO_ENV}=0）：只发确定性派生结果与检查登记`
          : "本轮只做确定性派生与检查登记（未请求语义整理）";
        for (const s of toTidy) {
          account(s).state = "inherited";
          status.missing.push({ scope: s, reason: "本轮未请求自动整理" });
        }
        return;
      }
      if (toTidy.length === 0) {
        const complete = scopes.every((s) => s.state === "reused" || s.state === "missing");
        status.semantic_complete = complete;
        status.outcome = complete ? (repainted ? "semantic_ready" : "cache_hit") : "degraded_partial";
        status.phase = complete ? "done" : "degraded";
        status.note = complete
          ? repainted
            ? "语义整理全部命中缓存并已并进规划图（本轮零模型调用）"
            : "语义整理与图都命中完整缓存：本轮零模型调用、零重画"
          : "部分范围的既有整理结果不是当前来源的，本轮又未重试（见 missing）";
        return;
      }

      // 静默期：让激活响应/交互请求先落地（验证脚本可传 0 走确定性路径）
      const delay = opts.kickoff_delay_ms ?? SEMANTIC_KICKOFF_DELAY_MS;
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));

      status.phase = "tidying";
      status.model.available = true;
      status.note = `本轮需要整理的范围：${toTidy.join(" / ")}（未受影响范围沿用已保存结果）`;
      persistStatus(projectId, dataDir, status);

      // 一次调用（只把要整理的段放进输入）+ 有界重试
      const base = deriveBlueprint(src, { based_on: blueprintCacheKeysOf(src, false), proposal: null, model_receipt: null });
      const chat = opts.chat ?? defaultBlueprintChat;
      let calls = 0;
      let lastError: string | null = null;
      let split: SplitProposal | null = null;
      let receiptInfo: { rejected: string[]; dropped: { what: string; why: string }[]; rawSha: string | null; rawExcerpt: string | null } | null = null;
      for (let attempt = 1; attempt <= SEMANTIC_MAX_ATTEMPTS_PER_RUN; attempt++) {
        calls += 1;
        status.model.called = true;
        status.model.calls = calls;
        syncScopeCalls(status, toTidy);
        try {
          const out = await chat(buildBlueprintMessages(src, base, { focus: toTidy }));
          if (out.error !== null || out.json === null) {
            lastError = out.error ?? "模型输出里没有 JSON";
          } else {
            const sanitized = sanitizeModelProposal(out.json);
            const s = splitProposalByScope(sanitized.proposal, toTidy);
            if (!toTidy.some((scope) => countEntries(s.parts[scope]) > 0)) {
              lastError = `模型返回的条目里没有属于本轮范围（${toTidy.join("/")}）的可用条目`;
            } else {
              split = s;
              receiptInfo = {
                rejected: sanitized.rejected_fields,
                dropped: [
                  ...sanitized.dropped,
                  ...s.outOfScope.map((o) => ({ what: o.what, why: `出处属于本轮未整理的「${o.scope}」段：丢弃（不许越范围改写）` })),
                ],
                rawSha: sha256(out.text),
                rawExcerpt: out.text.slice(0, 2000),
              };
              lastError = null;
              break;
            }
          }
        } catch (e) {
          lastError = (e as Error).message;
        }
        checkModelAvailability(status, lastError);
        if (attempt < SEMANTIC_MAX_ATTEMPTS_PER_RUN) await new Promise((r) => setTimeout(r, SEMANTIC_RETRY_BACKOFF_MS));
      }

      if (split === null) {
        // 整理没成：**不覆盖**已发布的有效结果；沿用旧分段结果（没有就只剩确定性结果），并如实说明
        status.model.error = lastError;
        checkModelAvailability(status, lastError);
        const at2 = now();
        for (const scope of toTidy) {
          account(scope).state = "failed";
          account(scope).model_calls = calls;
          account(scope).error = lastError;
          const prev = cache.failures[scope];
          const sameKey = prev !== undefined && prev.scope_key === keys[scope];
          const attempts = (sameKey ? prev.attempts : 0) + calls;
          cache.failures[scope] = {
            scope,
            scope_key: keys[scope]!,
            attempts,
            last_at: at2,
            error: lastError ?? "未知原因",
          };
          status.missing.push({
            scope,
            reason: `${lastError ?? "整理失败"}（累计尝试 ${attempts}/${SEMANTIC_MAX_FAILURE_ATTEMPTS}${sameKey ? "" : "，本次为新来源重新计数"}）`,
          });
        }
        writeJsonAtomic(semanticCachePath(projectId, dataDir), cache);
        status.outcome = status.model.available ? "degraded_partial" : "degraded_model_unavailable";
        status.phase = "degraded";
        status.semantic_complete = false;
        status.note =
          `本轮语义整理未完成（${lastError ?? "未知原因"}）：规划图保留 ${published !== null ? "确定性派生 + 已保存的旧整理结果" : "（暂无图）"}` +
          `，缺失范围：${status.missing.map((m) => m.scope).join("/") || "（无）"}` +
          `；版本 基线 ${status.baseline_id ?? "（无）"} / 生成器 ${BLUEPRINT_GENERATOR_VERSION} / 分段口径 ${SEMANTIC_SCOPE_VERSION} / 图 ${status.blueprint.cache_key?.slice(0, 12) ?? "（无）"}`;
        return;
      }

      // ── 成功：合并（新整理的段 + 未受影响段的既有结果）→ **先发布**，发布成了才落缓存 ──
      // 为什么先发布再落缓存：**校验不过的整理结果不许进缓存**（否则下一次自动链会复用一份
      // 注定发布不了的整理结果，把图永久卡死）；发布与"过时/失败不覆盖较新结果"的把关仍走 V06-05 那条路。
      status.phase = "publishing";
      const nowSrc = readBlueprintSources(projectId, dataDir);
      const at2 = now();
      // 先把本轮各段**打算**变成什么状态算出来（发布回执里的分段账目要与最终状态一致）
      let staleDiscarded = 0;
      const planned = new Map<SemanticScopeId, { state: SemanticScopeState; error: string | null }>();
      for (const scope of toTidy) {
        const part = split.parts[scope];
        const keyNow = semanticScopeKey(nowSrc, scope);
        if (keyNow !== keys[scope]) {
          staleDiscarded += 1;
          planned.set(scope, { state: "failed", error: "过时响应：来源在整理期间已变，本次结果丢弃（不覆盖较新结果）" });
        } else if (countEntries(part) === 0) {
          planned.set(scope, { state: "failed", error: "本轮没有属于该范围的可用条目" });
        } else {
          planned.set(scope, { state: "tidied", error: null });
        }
      }
      for (const scope of toTidy) {
        const p = planned.get(scope)!;
        account(scope).state = p.state;
        account(scope).model_calls = calls;
        account(scope).error = p.error;
        if (p.state === "tidied") {
          account(scope).last_ran_at = at2;
          account(scope).stale_source = false;
          account(scope).entries = countEntries(split.parts[scope]);
        } else if (p.error !== null) {
          status.missing.push({ scope, reason: p.error });
        }
      }
      // 合并：**只有本轮真整理出来、且键没过期的段**才用新结果，其余段一律用已保存的结果
      const mergedParts = SEMANTIC_SCOPES.map((scope) =>
        planned.get(scope)?.state === "tidied" ? split.parts[scope] : cache.shards[scope]?.proposal ?? null,
      );
      const merged = mergeScoped(mergedParts);
      const tidiedNow = toTidy.filter((scope) => planned.get(scope)?.state === "tidied");
      // 一个段都没整理出来（全过时/全没条目）→ **不再发布**：没有新内容要并，动图只会拿旧内容覆盖较新结果
      if (tidiedNow.length === 0) {
        status.outcome = status.model.available ? "degraded_partial" : "degraded_model_unavailable";
        status.phase = "degraded";
        status.semantic_complete = false;
        status.note =
          `本轮没有可采用的整理结果（${[...planned.values()].map((p) => p.error ?? "").filter((e) => e !== "").join("；") || "未得到属于本轮范围的条目"}）：` +
          `**不改动规划图**（不覆盖较新/有效结果）；缺失范围：${status.missing.map((m) => m.scope).join("/") || "（无）"}` +
          `；版本 基线 ${status.baseline_id ?? "（无）"} / 生成器 ${BLUEPRINT_GENERATOR_VERSION} / 分段口径 ${SEMANTIC_SCOPE_VERSION} / 图 ${status.blueprint.cache_key?.slice(0, 12) ?? "（无）"}`;
        persistStatus(projectId, dataDir, status);
        return;
      }
      const noteOf = (): BlueprintSemanticScopeNote[] =>
        status.scopes.map((s) => ({
          scope: s.scope,
          key: s.key,
          state: s.state,
          source_sha256: s.source_sha256,
          last_ran_at: s.last_ran_at,
          entries: s.entries,
        }));
      const second = await rebuildBlueprint(projectId, {
        ...(dataDir === undefined ? {} : { dataDir }),
        trigger: `${trigger}:semantic`,
        semantic: false,
        force: true,
        proposal: merged,
        model_calls: calls,
        semantic_note: { scopes: noteOf(), note: status.note },
      });
      published = second.blueprint;
      publishReason = second.publish.reason;
      repainted = repainted || second.rebuilt;
      keptPrevious = second.kept_previous;
      status.blueprint = {
        cache_key: second.cache_key,
        published_at: published?.publish.validated_at ?? null,
        published: second.publish.published,
        reason: second.publish.reason,
        repainted,
        kept_previous: second.kept_previous,
      };
      status.coverage = published?.coverage ?? null;

      // 发布没成 → 整理结果一律不采用、不落缓存（图保持原样），并如实记账。
      // 落账前**重读盘上的缓存**再合并：并发的较新一轮可能已经写过更权威的记录，不能被这次旧副本冲掉。
      const fresh = readSemanticCache(projectId, dataDir).cache;
      let touched = false;
      if (!second.publish.published) {
        for (const scope of toTidy) {
          const p = planned.get(scope)!;
          if (p.state !== "tidied") continue;
          const error = `整理结果未通过程序校验，未采用：${second.publish.reason ?? "未知原因"}`;
          account(scope).state = "failed";
          account(scope).error = error;
          planned.set(scope, { state: "failed", error });
          const prev = fresh.failures[scope];
          const sameKey = prev !== undefined && prev.scope_key === keys[scope];
          fresh.failures[scope] = {
            scope,
            scope_key: keys[scope]!,
            attempts: (sameKey ? prev.attempts : 0) + calls,
            last_at: at2,
            error,
          };
          status.missing.push({ scope, reason: error });
          touched = true;
        }
      } else {
        for (const scope of toTidy) {
          if (planned.get(scope)!.state !== "tidied") continue;
          if ((fresh.shards[scope]?.ran_at ?? "") > at2) continue; // 盘上已有更新的记录：不覆盖
          fresh.shards[scope] = {
            scope,
            scope_key: keys[scope]!,
            baseline_id: src.baseline_id,
            source_sha256: semanticScopeSha(src, scope)!,
            generator_version: BLUEPRINT_GENERATOR_VERSION,
            scope_version: SEMANTIC_SCOPE_VERSION,
            ran_at: at2,
            trigger,
            attempts: calls,
            proposal: split.parts[scope],
            rejected_fields: receiptInfo?.rejected ?? [],
            dropped: receiptInfo?.dropped ?? [],
            raw_sha256: receiptInfo?.rawSha ?? null,
            raw_excerpt: receiptInfo?.rawExcerpt ?? null,
          };
          // 这一段已经拿到当前来源的结果：失败账目清掉（终止态解除靠的就是"来源变化或整理成功"）
          delete fresh.failures[scope];
          touched = true;
        }
      }
      if (touched) writeJsonAtomic(semanticCachePath(projectId, dataDir), fresh);

      const complete = status.scopes.every((s) => s.state === "reused" || s.state === "tidied" || s.state === "missing");
      status.semantic_complete = complete && staleDiscarded === 0;
      status.outcome = status.semantic_complete ? "semantic_ready" : "degraded_partial";
      status.phase = status.semantic_complete ? "done" : "degraded";
      const reused = status.scopes.filter((s) => s.state === "reused").map((s) => s.scope);
      status.note =
        `本轮整理了 ${toTidy.join("/")}（模型调用 ${calls} 次）` +
        (reused.length > 0 ? `，复用缓存 ${reused.join("/")}` : "") +
        (staleDiscarded > 0 ? `；${staleDiscarded} 个范围的响应已过时被丢弃` : "") +
        `；发布 ${second.publish.published ? "成功" : `被拒（${second.publish.reason ?? "未知原因"}）`}` +
        `；版本 基线 ${status.baseline_id ?? "（无）"} / 生成器 ${BLUEPRINT_GENERATOR_VERSION} / 分段口径 ${SEMANTIC_SCOPE_VERSION} / 图 ${second.cache_key.slice(0, 12)}` +
        (second.publish.published ? "" : `；缺失范围：${status.missing.map((m) => m.scope).join("/") || "（无）"}`);
    } catch (e) {
      status.phase = "failed";
      status.outcome = "degraded_partial";
      status.semantic_complete = false;
      status.model.error = (e as Error).message;
      status.note = `自动链异常（${(e as Error).message}）：保留已发布的规划图，不冒充本轮整理完成`;
    } finally {
      status.finished_at = now();
      status.scopes = scopes;
      persistStatus(projectId, dataDir, status);
      resolveSettled();
    }
  };

  const settledPromise = settle();
  const live = liveRuns.get(projectId)!;
  live.settled = settledPromise;
  if (opts.awaitSemantic === false) {
    persistStatus(projectId, dataDir, status);
    return summarize(status, { repainted, keptPrevious, published, publishReason }, settledPromise);
  }
  await settledPromise;
  return summarize(status, { repainted, keptPrevious, published, publishReason }, settledPromise);
}

function summarize(
  status: SemanticRunStatus,
  x: { repainted: boolean; keptPrevious: boolean; published: Blueprint | null; publishReason: string | null },
  settled: Promise<void>,
): AutoRebuildResult {
  if (status.note === "") status.note = "本轮没有需要整理的范围";
  return {
    run_id: status.run_id,
    trigger: status.trigger,
    outcome: status.outcome,
    model_calls: status.model.calls,
    blueprint: x.published,
    cache_key: status.blueprint.cache_key,
    published: status.blueprint.published,
    publish_reason: x.publishReason,
    repainted: x.repainted,
    kept_previous: x.keptPrevious,
    scopes: status.scopes,
    settled,
    status,
  };
}

/** 模型可用性判定：配置类错误（没密钥/没配好）算"不可用"，网络/输出问题算"可用但本轮失败" */
function checkModelAvailability(status: SemanticRunStatus, error: string | null): void {
  if (error === null) {
    status.model.available = true;
    return;
  }
  status.model.available = !/未配置 DeepSeek 密钥|密钥配置/.test(error);
}

/**
 * 触发式自动链（**同步返回、异步执行**，供"有效基线激活""更新图"这类正常流程调用）。
 * 沿用 V06-05 的理由：触发方是主流程，派生/整理失败绝不能把激活拖回退；失败只留状态与回执，
 * 调用方要等结果就用 `autoRebuildBlueprint`（或 `autoRunSettled`）。
 */
export function triggerBlueprintAuto(projectId: string, opts: AutoRebuildOptions = {}): void {
  void autoRebuildBlueprint(projectId, opts).catch(() => {
    // 状态与回执已在链内尽量落盘；这里连读盘硬错误都吞掉（触发方是主流程）
  });
}

// ───────────────────────────────── 显式整理路径的结果落地 ─────────────────────────────────

export interface ExplicitSemanticInfo {
  proposal: BlueprintProposal | null;
  ok: boolean;
  error: string | null;
  rejected_fields: string[];
  dropped: { what: string; why: string }[];
  raw_sha256: string | null;
  raw_excerpt: string | null;
}

/**
 * 把**显式 `semantic:true`** 那一轮的整理结果也落进分段缓存（成功才落）。
 * 为什么：显式重试与自动链共用同一份缓存，才能做到"避免重复调用"——用户在界面上点了一次
 * "重新整理"成功之后，紧接着的自动链应该命中缓存（零调用），而不是再打一次模型。
 * 失败不记进失败账目（手动重试失败不该把自动链推进终止态）。
 */
export function recordExplicitSemanticResult(
  projectId: string,
  info: ExplicitSemanticInfo,
  opts: { dataDir?: string; trigger?: string; now?: () => string } = {},
): void {
  if (!info.ok || info.proposal === null) return;
  const dataDir = opts.dataDir;
  const now = opts.now ?? nowIso;
  try {
    const src = readBlueprintSources(projectId, dataDir);
    const focus = SEMANTIC_SCOPES.filter((s) => semanticScopeKey(src, s) !== null);
    const { parts } = splitProposalByScope(info.proposal, focus);
    const cache = readSemanticCache(projectId, dataDir).cache;
    const at = now();
    let wrote = 0;
    for (const scope of focus) {
      const key = semanticScopeKey(src, scope);
      const part = parts[scope];
      if (key === null || countEntries(part) === 0) continue;
      cache.shards[scope] = {
        scope,
        scope_key: key,
        baseline_id: src.baseline_id,
        source_sha256: semanticScopeSha(src, scope)!,
        generator_version: BLUEPRINT_GENERATOR_VERSION,
        scope_version: SEMANTIC_SCOPE_VERSION,
        ran_at: at,
        trigger: opts.trigger ?? "explicit_semantic",
        attempts: 1,
        proposal: part,
        rejected_fields: info.rejected_fields,
        dropped: info.dropped,
        raw_sha256: info.raw_sha256,
        raw_excerpt: info.raw_excerpt,
      };
      delete cache.failures[scope];
      wrote += 1;
    }
    if (wrote > 0) writeJsonAtomic(semanticCachePath(projectId, dataDir), cache);
  } catch {
    // 落地失败不影响显式路径的主结果（显式路径的发布走 V06-05 那条路）
  }
}

// ───────────────────────────────── 对外只读状态 ─────────────────────────────────

export interface SemanticStateView {
  /** 自动链最近一次运行状态（进程内最新优先，其次是落盘那份） */
  status: SemanticRunStatus | null;
  /** 分段缓存现状（每段：哪一版来源、什么时候跑的、多少条目、有没有失败账目） */
  scopes: {
    scope: SemanticScopeId;
    key: string | null;
    cached_key: string | null;
    state: "fresh" | "stale" | "empty" | "missing_source";
    source_sha256: string | null;
    ran_at: string | null;
    entries: number;
    attempts: number;
    error: string | null;
  }[];
  cache: { generator_version: string; scope_version: string; corrupt: boolean };
  /** 本进程是否开着自动整理（`TATAI_SEMANTIC_AUTO`） */
  auto_enabled: boolean;
  note: string;
}

/** 只读状态快照（HTTP 读口与验证脚本共用；只出现哈希/段名/说明，不含任何本机路径） */
export function semanticStateOf(projectId: string, opts: { dataDir?: string } = {}): SemanticStateView {
  const read = readSemanticCache(projectId, opts.dataDir);
  const src = readBlueprintSources(projectId, opts.dataDir);
  const scopes = SEMANTIC_SCOPES.map((scope) => {
    const key = semanticScopeKey(src, scope);
    const rec = read.cache.shards[scope];
    const fail = read.cache.failures[scope];
    const state: SemanticStateView["scopes"][number]["state"] =
      key === null ? "missing_source" : rec === undefined ? "empty" : rec.scope_key === key ? "fresh" : "stale";
    return {
      scope,
      key,
      cached_key: rec?.scope_key ?? null,
      state,
      source_sha256: rec?.source_sha256 ?? null,
      ran_at: rec?.ran_at ?? null,
      entries: countEntries(rec?.proposal ?? null),
      attempts: fail?.attempts ?? 0,
      error: fail?.error ?? null,
    };
  });
  const fresh = scopes.filter((s) => s.state === "fresh" || s.state === "missing_source").length;
  return {
    status: autoRunStatusOf(projectId) ?? readSemanticStatus(projectId, opts.dataDir),
    scopes,
    cache: { generator_version: read.cache.generator_version, scope_version: read.cache.scope_version, corrupt: read.corrupt },
    auto_enabled: semanticAutoEnabled(),
    note: `语义整理分段 ${fresh}/${scopes.length} 段处于当前来源（fresh/missing_source）；其余段需要整理或沿用旧结果`,
  };
}
