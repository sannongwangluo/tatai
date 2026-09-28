// V09-07：源变化发现链（PLAN.md V09-07，DESIGN.md §2.9 / §3.9 / §4.4、附录 E.8）。
// V09-12：**触发范围扩展**（深层模块 / 接口 / 依赖）＋**更新状态机与预计用时口径**
// （PLAN.md V09-12，DESIGN.md §3.2 触发范围 / §3.3 更新中与下次打开 / §4.4、附录 E.8-2、E.8-4）。
//
// 本模块把 watcher 的变更流（`onProjectChange`）分类成两条确定性链：
//
//   ① **文档源变化**（唯一当前源：塔台自身 = 根 DESIGN.md/PLAN.md；其他项目 = 登记的
//      或缺省的 `.工作台/design.md` / `.工作台/plan.md`）→ 只重算**草稿**与「源已变」标记：
//      用既有 `draftBlueprintOf`（只读、零模型）重算草稿落 `.工作台/arch/blueprint-draft.json`
//      （`draft:true`、`publish.published:false`、`based_on` 指向当前未审定源哈希）。
//      **正式图一个字节不动**（发布门禁仍只属于基线激活链，§2.9 / E.8-2）。
//   ② **代码结构变化** → **安全防抖**（静默窗 `GRAPH_REFRESH_QUIET_MS` 合批去重 + 最小间隔
//      `GRAPH_REFRESH_MIN_INTERVAL_MS` + 滚动窗口轮数预算）→ `startParseProjectRun`（确定性重解析，
//      单飞）→ run 成功才重建蓝图（走**同一条**既有自动链，不新建第二套派生）。
//      触发范围（§3.2 / §4.4，2026-09-24 用户澄清「不只是顶层目录」）见 `changeVerdict`：
//        · `structure_top`：顶层目录新增/消失（V09-07 原口径）；
//        · `structure_deep`：**深层目录（二级及更深）**新增/消失——候选模块还要按二级及更深细分时
//          （`modules.length < MIN_MODULES`，与划分本体同一个数）划分就可能变；
//        · `interface`：**模块对外接口文件**（桶/入口 `index`·`mod`·`main`·`app`·`lib`·`__init__`… 与
//          `*.d.ts`）被增删改——接口面变了对依赖方就是相关变化（判据保守：宁可多跑一轮**有界**
//          重解析，不漏判接口面变化）；
//        · `dependency`：源码文件的**跨模块依赖**变了——`probeFileImports`（与真解析同一段解析本体，
//          但按文件存在确认目标、**不遍历全项目**）把该文件解析到的目标模块与 `modules.json` 已记录的
//          边比对：出现未记录的目标 → 依赖变化；同一文件上一次探针的依赖集合与这次不同 → 依赖变化。
//      run 失败/被取消 → 旧 modules.json 与旧蓝图**原样保留**，回执与更新状态如实写原因（§4.4 降级口径）。
//   ③ 其余路径一律忽略；`.工作台/**` 里的生成物（modules.json、blueprint*.json、回执、更新状态）
//      在 watcher 侧就不进事件流，这里再兜底一道——**绝不自触死循环**（E.8-4）。
//
// 有界与去重（E.8-4「有界与去重是判据不是可选项」）：
//   · 同一静默窗内的突发变更合并成**一轮**（回执 `collapsed` 记被合掉的条数）；
//   · 外部触发的两轮之间至少隔 `GRAPH_REFRESH_MIN_INTERVAL_MS`；滚动窗口
//     `GRAPH_REFRESH_BUDGET_WINDOW_MS` 内最多 `GRAPH_REFRESH_MAX_ROUNDS_PER_WINDOW` 轮；
//     闸门不足时**等**（状态如实写「等闸门 + 还要等多久」），不丢弃、更不是无界重试；
//   · 解析进行中再来结构变化 → 记 pending，本轮结束后**最多再补一轮**（不并行起新 run、
//     不无界重试；失败/取消永不自动重试）。
//
// 更新状态（V09-12，§3.3 末段）：
//   · 每轮的 `updating / ready / stale / failed`、当前阶段、**有依据的预计用时或「无法估计」**、
//     本轮变更指纹（`change_token`）与派生结果事实落 `.工作台/arch/graph-update.json`
//     （口径与 ETA 纯函数在 `./graphUpdate.ts`；读口是 `GET arch/blueprint` 的 `update` 字段）；
//   · 进程重启/监听被关时把上次遗留的 `updating` 标成 `stale` 并给原因——**不把旧图当新图**
//     （`markInterrupted`）。
//
// 每轮（含文档轮）落 `.工作台/arch/graph-refresh-last.json`：
//   {version, project_id, last_trigger, last_parse_run_id, collapsed, last_error, at}。
//
// 生命周期：由 HTTP 面接线（POST /watch 落地后 `startGraphRefresh`；DELETE /watch 与
// 服务退出时 `stopGraphRefresh` / `stopAllGraphRefresh`）。本模块**不碰** SSE 既有口径。
// deps 可注入 `{parse, rebuild, draft, verdict, now, quietMs, minIntervalMs, budgetWindowMs,
// maxRoundsPerWindow, dataDir}`——失败/取消/有界/闸门分支的单测靠它（verify-v09-07 ④、
// verify-v09-12 ④），产品路径一个注入都不用。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  MIN_MODULES,
  SOURCE_EXTS,
  probeFileImports,
  readModules,
  startParseProjectRun,
  type ArchModulesFile,
} from "../../arch/parse";
import { autoRebuildBlueprint } from "../../arch/blueprintAuto";
import { blueprintDir, draftBlueprintOf, writeJsonAtomic, type BlueprintDraftResult } from "../../arch/blueprint";
import { getProject } from "../registry";
import { resolveDocumentSource } from "./documents";
import { sanitizeErrorMessage } from "../redact";
import { nowIso } from "../time";
import { onProjectChange, type ChangeLine } from "../watcher";
import {
  HISTORY_MAX,
  PHASES_TOTAL,
  emptyGraphUpdate,
  estimateEta,
  markInterrupted,
  readGraphUpdate,
  writeGraphUpdate,
  type GraphTriggerScope,
  type GraphUpdateRecord,
  type GraphUpdateResult,
} from "./graphUpdate";

/**
 * 安全防抖的三个闸门（E.8-2「合并突发变更、限定最小间隔与总预算」）。数值即定版口径；
 * 与 `watcher.ts` 的 `TATAI_WATCH_*` 同一先例，可用 `TATAI_GRAPH_REFRESH_<项名>` **收紧或放宽**
 * （`TATAI_GRAPH_REFRESH_MIN_INTERVAL_MS` / `_QUIET_MS` / `_BUDGET_WINDOW_MS` / `_MAX_ROUNDS_PER_WINDOW`）——
 * 唯一目的是让验证能在真机上把闸门调到"看得见"的量级（如把排队窗口拉长到 UI 轮询能读到的长度），
 * 或给极端环境运维调参；不设时行为与定版口径逐字节一致（无效值一律回落默认值）。
 */
function gateNumber(name: string, fallback: number): number {
  const raw = process.env[`TATAI_GRAPH_REFRESH_${name}`];
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** 安全防抖静默窗（附录 E.8-2「合并突发变更」）：窗内突发合批成一轮 */
export const GRAPH_REFRESH_QUIET_MS = gateNumber("QUIET_MS", 1200);
/**
 * 外部触发的两轮之间的**最小间隔**（E.8-2「限定最小间隔」）：闸门不足时排队等待，
 * 不是丢弃（等的时候状态如实写「等闸门 + 还要等多久」）。补跑那一轮不受它限制——
 * 它本来就属于同一个突发（已经计过一次账）。
 */
export const GRAPH_REFRESH_MIN_INTERVAL_MS = gateNumber("MIN_INTERVAL_MS", 4000);
/** 滚动预算窗口（E.8-2「总预算」） */
export const GRAPH_REFRESH_BUDGET_WINDOW_MS = gateNumber("BUDGET_WINDOW_MS", 60_000);
/** 每个滚动窗口内允许的**外部触发**轮数上限（超了等窗口滚动，不无界重试） */
export const GRAPH_REFRESH_MAX_ROUNDS_PER_WINDOW = gateNumber("MAX_ROUNDS_PER_WINDOW", 10);
/** 单文件依赖探针的进程内记忆上限（超出整体清空：只影响"同一文件前后对比"的精度，不影响有界性） */
export const PROBE_SIG_MAX = 5000;

/** 「源已变」草稿标记与回执的落点文件名（都在 `.工作台/arch/` 下——生成物，watcher 不监听） */
export const GRAPH_REFRESH_DRAFT_FILE = "blueprint-draft.json";
export const GRAPH_REFRESH_RECEIPT_FILE = "graph-refresh-last.json";

/** 每轮回执（成功与失败都写；失败时旧图还在，原因从这份读——与 blueprint-receipt 同一口径） */
export interface GraphRefreshReceipt {
  version: 1;
  project_id: string;
  /** 最近一轮的触发类别（文档源变化 / 代码结构变化） */
  last_trigger: "doc_changed" | "parse_changed" | null;
  /** 最近一次重解析 run 的 id（文档轮沿用上一次解析的 id；从未解析过为 null） */
  last_parse_run_id: string | null;
  /** 本轮被防抖合批去重掉的变更条数（0 = 单条变更直接成轮） */
  collapsed: number;
  /** 最近一轮的失败原因（成功为 null；失败/取消如实写人话） */
  last_error: string | null;
  at: string;
}

/** 重解析入口的返回形状（与 `startParseProjectRun` 的 ParseRunHandle 结构兼容；单测注入用） */
export interface GraphRefreshParseHandle {
  run: { id: string };
  done: Promise<{ id: string; status: string; error?: string | null; error_code?: string | null }>;
  deduplicated?: boolean;
}

/** 蓝图重建的返回（缺省实现 = 既有自动链；**只认它给出的结论**，不自己重算发布与否） */
export interface GraphRebuildOutcome {
  published?: boolean;
  kept_previous?: boolean;
  publish_reason?: string | null;
  blueprint?: { generated_at?: string } | null;
  model_calls?: number;
}

/** 触发判据的结论：这条变化属于哪一类、按哪条判据判的（**可追**，不是一句"图待更新"） */
export interface ChangeVerdict {
  scope: GraphTriggerScope;
  reason: string;
}

/** 判据上下文（纯函数入参：触发范围判据不依赖进程状态，验证脚本可直接喂） */
export interface VerdictContext {
  /** 项目根（判"目录是否已消失"用） */
  root: string;
  /** 当前已落盘的模块划分；null = 划分未知 */
  arch: ArchModulesFile | null;
  /** 同一文件上一次探针到的跨模块依赖签名（缺省 = 没有记忆，只按已记录边判"新增"） */
  probe_before?: (rel: string) => string | undefined;
  /** 记下本次探针结果 */
  probe_after?: (rel: string, sig: string) => void;
}

export interface GraphRefreshDeps {
  /** 数据目录（缺省 = 全局 TATAI_HOME 解析；验证脚本传夹具目录） */
  dataDir?: string;
  /** 防抖静默窗毫秒数（缺省 1200；单测缩短用，产品路径不传） */
  quietMs?: number;
  /** 外部触发轮次之间的最小间隔（缺省 `GRAPH_REFRESH_MIN_INTERVAL_MS`） */
  minIntervalMs?: number;
  /** 滚动预算窗口（缺省 `GRAPH_REFRESH_BUDGET_WINDOW_MS`） */
  budgetWindowMs?: number;
  /** 窗口内外部触发轮数上限（缺省 `GRAPH_REFRESH_MAX_ROUNDS_PER_WINDOW`） */
  maxRoundsPerWindow?: number;
  /** 重解析入口（缺省 = arch/parse 的后台 run，单飞口径不变） */
  parse?: (projectId: string) => GraphRefreshParseHandle;
  /** 蓝图重建触发口（缺省 = 既有自动链 `autoRebuildBlueprint`，**run 成功才会被叫到**） */
  rebuild?: (projectId: string, opts: { trigger: string }) => void | Promise<GraphRebuildOutcome | void>;
  /** 草稿重算口（缺省 = draftBlueprintOf：只读、零模型、不落正式图） */
  draft?: (projectId: string) => BlueprintDraftResult | null;
  now?: () => string;
}

interface RefreshState {
  deps: Required<Pick<GraphRefreshDeps, "now">> & GraphRefreshDeps;
  /** 项目根（remove 判"目录是否已消失"要用） */
  root: string;
  /** 本项目的两份图纸源相对路径（POSIX；解析失败回落到四个默认形态） */
  docPaths: Set<string>;
  quietMs: number;
  minIntervalMs: number;
  budgetWindowMs: number;
  maxRoundsPerWindow: number;
  off: () => void;
  stopped: boolean;
  /** 防抖定时器（静默窗） */
  debounce: NodeJS.Timeout | null;
  /** 闸门等待定时器（最小间隔/窗口预算不足时，等到点再开跑） */
  gateTimer: NodeJS.Timeout | null;
  /** 当前防抖窗内累计的结构变化条数（开下一轮时折成 collapsed） */
  collected: number;
  /** 当前防抖窗内收下的变更指纹（`action:path`；开轮时算成本轮 change_token） */
  tokens: Set<string>;
  /** 当前防抖窗的触发判据（第一条命中的判据；同一轮可能出现多类变化） */
  pendingVerdict: ChangeVerdict | null;
  /** 有 run 在飞（不并行起第二个） */
  parseActive: boolean;
  /** run 飞行中又来了结构变化：本轮结束后最多补一轮 */
  pending: boolean;
  lastParseRunId: string | null;
  lastTrigger: GraphRefreshReceipt["last_trigger"];
  /** 最近一次轮次起点（毫秒；0 = 本进程还没有过） */
  lastRoundStartedAt: number;
  /** 滚动窗口内的轮次起点（毫秒） */
  recentRoundAt: number[];
  /** 本轮现场（写更新状态用；null = 当前没有轮） */
  round: { startedAtMs: number; startedAt: string } | null;
  /** 与落盘件对齐的内存镜像（history_ms 要在轮间延续） */
  update: GraphUpdateRecord;
  /** modules.json 的短缓存（按 mtime+size 失效）：探针每次文件事件都要问"模块划分是什么" */
  modulesCache: { key: string; arch: ArchModulesFile | null } | null;
  /** 单文件依赖签名（进程内；重启后退化为"按已记录边判新增"） */
  probeSig: Map<string, string>;
}

const states = new Map<string, RefreshState>();

const sha256 = (text: string): string => crypto.createHash("sha256").update(text, "utf8").digest("hex");

/** 图纸源相对路径（POSIX）：按登记的唯一当前源解析；项目读不动时回落到四种常见形态 */
function docPathsOf(projectId: string, dataDir?: string): Set<string> {
  try {
    return new Set([
      resolveDocumentSource(projectId, "design", dataDir).rel_path,
      resolveDocumentSource(projectId, "plan", dataDir).rel_path,
    ]);
  } catch {
    return new Set(["DESIGN.md", "PLAN.md", ".工作台/design.md", ".工作台/plan.md"]);
  }
}

/** modules.json 的短缓存（按 mtime+size 失效）：读不到/损坏按 null（= 划分未知）缓存一次 */
function modulesOf(st: RefreshState, projectId: string): ArchModulesFile | null {
  const file = path.join(blueprintDir(projectId, st.deps.dataDir), "modules.json");
  let key = "missing";
  try {
    const s = fs.statSync(file);
    key = `${s.mtimeMs}:${s.size}`;
  } catch {
    key = "missing";
  }
  if (st.modulesCache !== null && st.modulesCache.key === key) return st.modulesCache.arch;
  let arch: ArchModulesFile | null = null;
  try {
    const { exists, arch: read } = readModules(projectId, st.deps.dataDir);
    arch = exists && read !== undefined && read !== null ? read : null;
  } catch {
    arch = null;
  }
  st.modulesCache = { key, arch };
  return arch;
}

/** 模块路径集合（"other" 模块的 path 是逗号清单；"." = 根散文件） */
export function modulePathsOf(arch: ArchModulesFile): Set<string> {
  const out = new Set<string>();
  for (const m of arch.modules) {
    for (const p of m.id === "other" ? m.path.split(",") : [m.path]) out.add(p);
  }
  return out;
}

/** 路径 → 模块 id（最长前缀匹配；与 `assembleParseResult` 的文件归属同一口径） */
export function moduleIdOfPath(arch: ArchModulesFile, rel: string): string | null {
  let best: string | null = null;
  let bestLen = -1;
  for (const m of arch.modules) {
    for (const p of m.id === "other" ? m.path.split(",") : [m.path]) {
      const hit = p === "." ? !rel.includes("/") : rel === p || rel.startsWith(`${p}/`);
      if (hit && p.length > bestLen) {
        best = m.id;
        bestLen = p.length;
      }
    }
  }
  return best;
}

/** 深层目录前缀（深度 ≥ 2；`a/b/c.ts` → ["a/b"]，`a/b/c/d.ts` → ["a/b", "a/b/c"]） */
function deepDirPrefixes(segs: string[]): string[] {
  const out: string[] = [];
  for (let i = 2; i <= segs.length - 1; i++) out.push(segs.slice(0, i).join("/"));
  return out;
}

/**
 * 模块对外接口文件判据（V09-12）：桶/入口文件与类型声明文件。
 * 这些文件是模块**对外接口面**的落点（别的模块从这里 import 它），改动它们按"接口面可能变"触发
 * 相关图更新。判据保守（宁可多跑一轮有界重解析），且**只认文件名形态**——不猜内容、不调模型。
 */
const INTERFACE_BASENAMES: ReadonlySet<string> = new Set([
  "index",
  "mod",
  "main",
  "app",
  "lib",
  "__init__",
  "__main__",
  "public-api",
  "exports",
]);

export function isInterfaceFile(rel: string): boolean {
  const base = rel.slice(rel.lastIndexOf("/") + 1);
  if (base === "" || base.startsWith(".")) return false;
  if (base.endsWith(".d.ts")) return true;
  const ext = base.lastIndexOf(".");
  const stem = ext > 0 ? base.slice(0, ext) : base;
  return INTERFACE_BASENAMES.has(stem);
}

/** 顶层结构变化判定（一级目录 add/unlink；`modify` 不算）——V09-07 原口径，保持不变 */
function isTopLevelStructureChange(root: string, line: ChangeLine, arch: ArchModulesFile | null): boolean {
  if (line.action === "modify") return false;
  const segs = line.path.split("/");
  if (segs.length < 2) return false;
  const top = segs[0];
  if (line.action === "add") {
    if (arch === null) return true; // 结构未知：任何带目录的新增都算
    const tops = new Set<string>();
    for (const m of arch.modules) {
      // "other" 聚合模块的 path 是成员前缀逗号清单：每个成员的顶层目录都算已知
      for (const p of m.id === "other" ? m.path.split(",") : [m.path]) {
        if (p === "." || p === "") continue;
        tops.add(p.split("/")[0]);
      }
    }
    return !tops.has(top);
  }
  return !fs.existsSync(path.join(root, top));
}

/** 深层目录（二级及更深）结构变化判定（V09-12）：模块划分可能变时才触发，避免大仓过度重解析 */
function deepStructureVerdict(root: string, line: ChangeLine, arch: ArchModulesFile | null): ChangeVerdict | null {
  if (line.action === "modify") return null;
  const segs = line.path.split("/");
  if (segs.length < 3) return null; // 没有二级目录参与：顶层判据已覆盖
  if (arch === null) return null; // 划分未知：顶层判据已把 add 全包了
  const paths = modulePathsOf(arch);
  // 候选还要按二级及更深细分（与划分本体同一个数）→ 深层目录的新增/消失会让划分变
  const subdividing = arch.modules.length < MIN_MODULES;
  if (line.action === "add") {
    const fresh = deepDirPrefixes(segs).filter((d) => !paths.has(d));
    if (fresh.length === 0) return null;
    if (!subdividing) return null; // 模块数已达硬区间下限：不再细分，深层目录不影响划分
    return {
      scope: "structure_deep",
      reason: `新增深层目录 ${fresh[fresh.length - 1]}/（当前模块数 ${arch.modules.length} < ${MIN_MODULES}，划分仍按二级及更深细分 → 相关图要更新）`,
    };
  }
  const gone = deepDirPrefixes(segs).filter((d) => !fs.existsSync(path.join(root, ...d.split("/"))));
  if (gone.length === 0) return null;
  const vanished = gone[0];
  const wasModule = paths.has(vanished) || [...paths].some((p) => p.startsWith(`${vanished}/`));
  if (wasModule) {
    return { scope: "structure_deep", reason: `深层模块目录已消失：${vanished}/（当前划分里的模块路径不再存在）` };
  }
  if (!subdividing) return null;
  return {
    scope: "structure_deep",
    reason: `深层目录被删除：${vanished}/（当前模块数 ${arch.modules.length} < ${MIN_MODULES}，划分仍按二级及更深细分 → 划分可能变）`,
  };
}

/**
 * 跨模块依赖探针（V09-12）：这个源码文件的跨模块依赖是否变了？
 * 依据全部可追：`probeFileImports`（与真解析同一段解析本体）+ `modules.json` 已记录的边 +
 * 同一文件上一次探针结果（进程内记忆）。判不出来（划分未知/文件不在划分内/解析跳过）时**保守触发**。
 */
function dependencyVerdict(ctx: VerdictContext, rel: string, action: ChangeLine["action"]): ChangeVerdict | null {
  const arch = ctx.arch;
  if (arch === null) {
    return { scope: "dependency", reason: `源码变化 ${rel}：没有已落盘的模块骨架，划分未知 → 相关图要更新` };
  }
  const fromId = moduleIdOfPath(arch, rel);
  if (fromId === null) {
    return { scope: "dependency", reason: `源码变化 ${rel}：该路径不在当前模块划分内 → 划分可能已变，相关图要更新` };
  }
  if (action === "remove") {
    return { scope: "dependency", reason: `源码文件被删除 ${rel}：模块内容与依赖边可能减少（文件已不存在，无法探针）` };
  }
  const probe = probeFileImports(ctx.root, rel);
  if (probe === null) return null; // 不是源码扩展名
  if (probe.skip !== null) {
    return { scope: "dependency", reason: `源码变化 ${rel}：单文件解析跳过（${probe.skip}），判不了依赖是否变 → 保守重解析` };
  }
  const targets = new Set<string>();
  for (const t of probe.targets) {
    const toId = moduleIdOfPath(arch, t);
    if (toId !== null && toId !== fromId) targets.add(toId);
  }
  const sig = [...targets].sort().join("|");
  const before = ctx.probe_before?.(rel);
  ctx.probe_after?.(rel, sig);
  if (before !== undefined && before !== sig) {
    return {
      scope: "dependency",
      reason: `文件 ${rel} 的跨模块依赖集合变了（${before === "" ? "（无）" : before} → ${sig === "" ? "（无）" : sig}）`,
    };
  }
  const recorded = new Set<string>();
  for (const d of arch.modules.find((m) => m.id === fromId)?.deps ?? []) recorded.add(d.to);
  const added = [...targets].filter((t) => !recorded.has(t));
  if (added.length > 0) {
    return { scope: "dependency", reason: `文件 ${rel} 出现未记录的跨模块依赖：${added.join("、")}` };
  }
  return null;
}

/**
 * 触发范围判据（V09-12 §3.2 触发范围 / §4.4 / 附录 E.8-2）：`null` = 这条变化不可能改变相关图，不触发。
 * 判据顺序 = 由粗到细：顶层结构 → 接口文件 → 深层结构 → 跨模块依赖。**纯函数**（不读进程状态）。
 */
export function changeVerdict(line: ChangeLine, ctx: VerdictContext): ChangeVerdict | null {
  const posix: ChangeLine = { ...line, path: line.path.split(/[\\/]/).join("/") };
  if (posix.path === "" || posix.path.startsWith("/") || posix.path.split("/").includes("..")) return null;
  if (isTopLevelStructureChange(ctx.root, posix, ctx.arch)) {
    return {
      scope: "structure_top",
      reason:
        posix.action === "add"
          ? `新增顶层目录 ${posix.path.split("/")[0]}/（当前模块划分里没有它）`
          : `顶层目录已消失 ${posix.path.split("/")[0]}/`,
    };
  }
  // 模块对外接口文件（桶/入口/类型声明）：接口面可能变
  if (isInterfaceFile(posix.path) && SOURCE_EXTS.has(path.posix.extname(posix.path).toLowerCase())) {
    return { scope: "interface", reason: `模块对外接口文件被${actionText(posix.action)}：${posix.path}` };
  }
  const deep = deepStructureVerdict(ctx.root, posix, ctx.arch);
  if (deep !== null) return deep;
  if (!SOURCE_EXTS.has(path.posix.extname(posix.path).toLowerCase())) return null;
  return dependencyVerdict(ctx, posix.path, posix.action);
}

function actionText(action: ChangeLine["action"]): string {
  return action === "add" ? "新增" : action === "remove" ? "删除" : "修改";
}

function receiptFile(projectId: string, dataDir?: string): string {
  return path.join(blueprintDir(projectId, dataDir), GRAPH_REFRESH_RECEIPT_FILE);
}

/** 每轮落回执（写失败只打屏——回执是派生物，写不动不能让发现链炸掉监听本体） */
function writeReceipt(
  projectId: string,
  st: RefreshState,
  patch: { last_trigger: GraphRefreshReceipt["last_trigger"]; collapsed: number; last_error: string | null; last_parse_run_id?: string | null },
): void {
  try {
    if (patch.last_parse_run_id !== undefined) st.lastParseRunId = patch.last_parse_run_id;
    st.lastTrigger = patch.last_trigger;
    const receipt: GraphRefreshReceipt = {
      version: 1,
      project_id: projectId,
      last_trigger: patch.last_trigger,
      last_parse_run_id: st.lastParseRunId,
      collapsed: patch.collapsed,
      last_error: patch.last_error,
      at: st.deps.now(),
    };
    writeJsonAtomic(receiptFile(projectId, st.deps.dataDir), receipt);
  } catch (e) {
    console.warn(`[graph-refresh] 项目 ${projectId} 回执落盘失败：${sanitizeErrorMessage((e as Error).message)}`);
  }
}

// ───────────────────────────────── 更新状态（V09-12） ─────────────────────────────────

/** 判据上下文（进程态 → 纯判据入参） */
function verdictContext(st: RefreshState, projectId: string): VerdictContext {
  return {
    root: st.root,
    arch: modulesOf(st, projectId),
    probe_before: (rel) => st.probeSig.get(rel),
    probe_after: (rel, sig) => {
      if (st.probeSig.size >= PROBE_SIG_MAX) st.probeSig.clear(); // 有界：整体清空（只降精度）
      st.probeSig.set(rel, sig);
    },
  };
}

/** 更新状态落盘：把 patch 并进内存镜像，重算 ETA 与时间戳，再写 `.工作台/arch/graph-update.json` */
function persistUpdate(
  projectId: string,
  st: RefreshState,
  patch: Partial<GraphUpdateRecord>,
  etaInput: { wait_ms?: number | null; phases_done?: number; phases_total?: number; started_at?: string | null } = {},
): void {
  const now = st.deps.now();
  const phasesTotal = etaInput.phases_total ?? st.update.phases_total;
  const phasesDone = etaInput.phases_done ?? st.update.phases_done;
  const startedAt = etaInput.started_at !== undefined ? etaInput.started_at : st.update.started_at;
  const eta = estimateEta({
    history_ms: st.update.history_ms,
    phases_done: phasesDone,
    phases_total: phasesTotal,
    started_at: startedAt,
    now_ms: Date.now(),
    wait_ms: etaInput.wait_ms ?? null,
  });
  st.update = {
    ...st.update,
    ...patch,
    version: 1,
    project_id: projectId,
    phases_done: phasesDone,
    phases_total: phasesTotal,
    started_at: startedAt,
    eta,
    updated_at: now,
  };
  writeGraphUpdate(st.update);
}

/** 本轮成功收尾（失败/取消走 `finishFailed`） */
function finishReady(
  projectId: string,
  st: RefreshState,
  extra: { result?: GraphUpdateResult | null; scope?: GraphTriggerScope; reason?: string; push_history?: boolean },
): void {
  const duration = st.round === null ? null : Date.now() - st.round.startedAtMs;
  const history = [...st.update.history_ms];
  if (extra.push_history === true && duration !== null && duration >= 0) {
    history.push(duration);
    while (history.length > HISTORY_MAX) history.shift();
  }
  st.update = { ...st.update, history_ms: history };
  persistUpdate(
    projectId,
    st,
    {
      state: "ready",
      phase: null,
      phases_done: st.update.phases_total,
      finished_at: st.deps.now(),
      last_error: null,
      scope: extra.scope ?? st.update.scope,
      reason: extra.reason ?? st.update.reason,
      result: extra.result ?? st.update.result,
    },
    { phases_done: st.update.phases_total },
  );
  st.round = null;
}

function finishFailed(projectId: string, st: RefreshState, message: string, scope?: GraphTriggerScope): void {
  persistUpdate(projectId, st, {
    state: "failed",
    phase: null,
    finished_at: st.deps.now(),
    last_error: message,
    scope: scope ?? st.update.scope,
  });
  st.round = null;
}

/**
 * 文档源变化 → 只重算草稿 +「源已变」标记（E.8-2：未审定的文档变化不发布正式图、不恢复派活）。
 * 草稿落 `.工作台/arch/blueprint-draft.json`；正式 `blueprint.json` 一个字节不动。
 * 文档轮是同步的（毫秒级），所以更新状态只写终态；重解析轮在飞时**不动**它的状态（那一轮说了算）。
 */
function handleDocChange(projectId: string, st: RefreshState, rel: string, action: ChangeLine["action"]): void {
  if (st.round !== null) return; // 重解析轮在飞：状态由它写（不覆盖它的"正在更新"）
  const token = sha256(`${action}:${rel}`).slice(0, 16);
  try {
    const dir = blueprintDir(projectId, st.deps.dataDir);
    const draft = st.deps.draft!(projectId);
    if (draft !== null) {
      // 草稿本体（draft:true、publish.published:false、based_on 指向当前未审定源哈希）
      writeJsonAtomic(path.join(dir, GRAPH_REFRESH_DRAFT_FILE), draft.blueprint);
    } else {
      // 派不出草稿也要如实留标记（空草稿不冒充有图）
      writeJsonAtomic(path.join(dir, GRAPH_REFRESH_DRAFT_FILE), {
        version: 1,
        draft: true,
        empty: true,
        publish: { published: false, reason: "可派生的规划对象为空（图纸源里没有可映射的章节、模块或任务）", validated_at: null },
        at: st.deps.now(),
      });
    }
    writeReceipt(projectId, st, { last_trigger: "doc_changed", collapsed: 0, last_error: null });
    persistUpdate(
      projectId,
      st,
      {
        state: "ready",
        scope: "doc",
        reason: `图纸源（未审定）变化：${rel} 被${actionText(action)}——只重算草稿与「源已变」标记，正式图不动（§2.9 / E.8-2）`,
        phase: null,
        phases_done: 1,
        phases_total: 1,
        change_token: token,
        started_at: null,
        finished_at: st.deps.now(),
        last_error: null,
        result: {
          modules_generated_at: null,
          blueprint_generated_at: draft?.blueprint.generated_at ?? null,
          blueprint_published: false,
          publish_reason: "源未审定激活：只更新草稿预览（§2.9 / E.8-2）",
          kept_previous: true,
        },
      },
      { phases_done: 1, phases_total: 1, started_at: null },
    );
  } catch (e) {
    const message = sanitizeErrorMessage(`草稿重算失败：${(e as Error).message}`).slice(0, 300);
    writeReceipt(projectId, st, { last_trigger: "doc_changed", collapsed: 0, last_error: message });
    persistUpdate(
      projectId,
      st,
      {
        state: "failed",
        scope: "doc",
        reason: `图纸源（未审定）变化：${rel} 被${actionText(action)}`,
        phase: null,
        phases_done: 1,
        phases_total: 1,
        change_token: token,
        started_at: null,
        finished_at: st.deps.now(),
        last_error: message,
      },
      { phases_done: 1, phases_total: 1, started_at: null },
    );
  }
}

// ───────────────────────────────── 重解析轮 ─────────────────────────────────

/** 闸门还要等多久（毫秒；0 = 可以开跑）。外部触发用；补跑那一轮不查（它属于同一突发）。 */
function gateWaitMs(st: RefreshState, nowMs: number): number {
  st.recentRoundAt = st.recentRoundAt.filter((t) => nowMs - t < st.budgetWindowMs);
  const waitMin = st.lastRoundStartedAt > 0 ? Math.max(0, st.minIntervalMs - (nowMs - st.lastRoundStartedAt)) : 0;
  const waitBudget =
    st.recentRoundAt.length >= st.maxRoundsPerWindow
      ? Math.max(0, st.budgetWindowMs - (nowMs - Math.min(...st.recentRoundAt)) + 1)
      : 0;
  return Math.max(waitMin, waitBudget);
}

/** 防抖到点 → 跑一轮「重解析 →（成功才）蓝图重建」；run 在飞则记 pending（最多补一轮） */
async function runParseRound(projectId: string, st: RefreshState, opts: { pending: boolean }): Promise<void> {
  if (st.stopped) return;
  if (st.parseActive) {
    // 解析进行中再来变化：记 pending，本轮结束后最多补一轮（有界，不并行起新 run）
    st.pending = true;
    return;
  }
  // 安全防抖闸门（最小间隔 + 滚动窗口预算）：不足就**等**（如实写「等闸门 + 还要等多久」），不丢、不无界重试
  if (!opts.pending) {
    const wait = gateWaitMs(st, Date.now());
    if (wait > 0) {
      persistUpdate(
        projectId,
        st,
        {
          state: "updating",
          phase: "queued",
          scope: st.pendingVerdict?.scope ?? st.update.scope,
          reason: st.pendingVerdict?.reason ?? st.update.reason,
          finished_at: null,
          last_error: null,
        },
        { wait_ms: wait },
      );
      if (st.gateTimer === null) {
        st.gateTimer = setTimeout(() => {
          st.gateTimer = null;
          void runParseRound(projectId, st, { pending: false });
        }, wait + 5);
      }
      return;
    }
  }
  st.parseActive = true;
  const collapsed = Math.max(0, st.collected - 1);
  st.collected = 0;
  const token = sha256([...st.tokens].sort().join("\n")).slice(0, 16);
  st.tokens.clear();
  const verdict = st.pendingVerdict;
  st.pendingVerdict = null;
  const scope: GraphTriggerScope = verdict?.scope ?? "structure_top";
  const reason = verdict?.reason ?? "代码结构变化（沿上一轮判据）";
  const startedAtMs = st.round?.startedAtMs ?? Date.now();
  const startedAt = st.round?.startedAt ?? st.deps.now();
  st.round = { startedAtMs, startedAt };
  st.lastRoundStartedAt = Date.now();
  st.recentRoundAt.push(Date.now());
  persistUpdate(
    projectId,
    st,
    {
      state: "updating",
      scope,
      reason,
      phase: "reparse",
      change_token: token,
      started_at: startedAt,
      finished_at: null,
      last_error: null,
      result: null,
    },
    { phases_done: 0, started_at: startedAt },
  );
  try {
    const handle = st.deps.parse!(projectId);
    st.lastParseRunId = handle.run.id;
    const run = await handle.done;
    if (st.stopped) return;
    if (run.status === "done") {
      let modulesGeneratedAt: string | null = null;
      try {
        modulesGeneratedAt = modulesOf(st, projectId)?.generated_at ?? null;
      } catch {
        modulesGeneratedAt = null;
      }
      persistUpdate(projectId, st, { phase: "blueprint" }, { phases_done: 1 });
      writeReceipt(projectId, st, {
        last_trigger: "parse_changed",
        last_parse_run_id: run.id,
        collapsed,
        last_error: null,
      });
      // run 成功才触发蓝图重建（既有确定性派生链；发布与否仍由既有门禁裁定，这里只如实记下结论）
      let outcome: GraphRebuildOutcome = {};
      try {
        const rebuilt = await Promise.resolve(st.deps.rebuild!(projectId, { trigger: "parse_changed" }));
        if (rebuilt !== undefined && rebuilt !== null) outcome = rebuilt;
      } catch (e) {
        const message = sanitizeErrorMessage(`蓝图重建触发失败：${(e as Error).message}`).slice(0, 300);
        writeReceipt(projectId, st, { last_trigger: "parse_changed", collapsed, last_error: message });
        finishFailed(projectId, st, message);
        return;
      }
      finishReady(projectId, st, {
        push_history: true,
        result: {
          modules_generated_at: modulesGeneratedAt,
          blueprint_generated_at: outcome.blueprint?.generated_at ?? null,
          blueprint_published: outcome.published === true,
          publish_reason: outcome.publish_reason ?? null,
          kept_previous: outcome.kept_previous === true,
        },
      });
    } else {
      // 失败/被取消：旧 modules.json 与旧蓝图原样保留（parse/blueprint 各自的落盘口径本来就如此），
      // 这里如实把原因写进回执与更新状态——不冒充成功、不自动重试（有界红线）
      const message = `重解析未成功（${run.status}）${run.error ? `：${run.error}` : ""}——旧 modules.json 与旧蓝图原样保留`.slice(0, 300);
      writeReceipt(projectId, st, {
        last_trigger: "parse_changed",
        last_parse_run_id: run.id,
        collapsed,
        last_error: message,
      });
      finishFailed(projectId, st, message);
    }
  } catch (e) {
    if (!st.stopped) {
      const message = sanitizeErrorMessage(`重解析启动失败：${(e as Error).message}`).slice(0, 300);
      writeReceipt(projectId, st, { last_trigger: "parse_changed", collapsed, last_error: message });
      finishFailed(projectId, st, message);
    }
  } finally {
    st.parseActive = false;
    if (!st.stopped && st.pending) {
      st.pending = false;
      // 补跑也过一次防抖窗（把 pending 期间到的变化再合一批）；补跑不吃最小间隔闸门（同一突发）
      st.debounce = setTimeout(() => {
        st.debounce = null;
        void runParseRound(projectId, st, { pending: true });
      }, st.quietMs);
    }
  }
}

/**
 * 变更行分类与分发（`onProjectChange` 订阅回调的本体；**单测直接调它**，不起 watcher）：
 * 文档源 → 草稿链；代码结构（顶层/深层/接口/依赖）→ 防抖重解析链；其余（含 `.工作台/**` 生成物）忽略。
 */
export function graphRefreshDispatch(projectId: string, line: ChangeLine): void {
  const st = states.get(projectId);
  if (st === undefined || st.stopped) return;
  const posix = line.path.split(/[\\/]/).join("/");
  if (st.docPaths.has(posix)) {
    handleDocChange(projectId, st, posix, line.action);
    return;
  }
  // 兜底防线：`.工作台/**` 的其余生成物（含本模块自己写的回执/草稿/更新状态）绝不进发现链
  // （watcher 侧本来就忽略它们；这里再拦一道，防豁免口径被误改后自触死循环）
  if (posix === ".工作台" || posix.startsWith(".工作台/")) return;
  const verdict = changeVerdict({ ...line, path: posix }, verdictContext(st, projectId));
  if (verdict === null) return;
  st.collected += 1;
  st.tokens.add(`${line.action}:${posix}`);
  if (st.pendingVerdict === null) st.pendingVerdict = verdict;
  // 正在更新（防抖合批）：第一次收下变化就把状态标出来（本轮没在跑时；在跑时那一轮已经标着）
  if (st.round === null) {
    st.round = { startedAtMs: Date.now(), startedAt: st.deps.now() };
    persistUpdate(
      projectId,
      st,
      {
        state: "updating",
        scope: verdict.scope,
        reason: verdict.reason,
        phase: "debounce",
        change_token: null,
        started_at: st.round.startedAt,
        finished_at: null,
        last_error: null,
      },
      { phases_done: 0, started_at: st.round.startedAt },
    );
  }
  if (st.debounce !== null) clearTimeout(st.debounce);
  st.debounce = setTimeout(() => {
    st.debounce = null;
    void runParseRound(projectId, st, { pending: false });
  }, st.quietMs);
}

/**
 * 开发现链（幂等：已挂着时返回 false 不重复订阅）。订阅 watcher 的变更广播；
 * 本模块自己**不开**监听（开/关监听是 POST/DELETE /watch 的事）。
 * V09-12：开链时把上次遗留的 `updating` 标成 `stale`（进程重启/上次监听被关——**不把旧图当新图**）。
 */
export function startGraphRefresh(projectId: string, deps: GraphRefreshDeps = {}): boolean {
  if (states.has(projectId)) return false;
  const project = getProject(projectId, deps.dataDir);
  if (!project) return false; // 项目不存在：不开链（调用方是 watch 落地路径，项目已在的；这里兜底）
  markInterrupted(projectId, "上次派生被中断（进程重启或监听被关）", deps.dataDir);
  const persisted = readGraphUpdate(projectId, deps.dataDir);
  const st: RefreshState = {
    deps: { now: deps.now ?? nowIso, ...deps },
    root: project.path,
    docPaths: docPathsOf(projectId, deps.dataDir),
    quietMs: deps.quietMs ?? GRAPH_REFRESH_QUIET_MS,
    minIntervalMs: deps.minIntervalMs ?? GRAPH_REFRESH_MIN_INTERVAL_MS,
    budgetWindowMs: deps.budgetWindowMs ?? GRAPH_REFRESH_BUDGET_WINDOW_MS,
    maxRoundsPerWindow: deps.maxRoundsPerWindow ?? GRAPH_REFRESH_MAX_ROUNDS_PER_WINDOW,
    off: () => {},
    stopped: false,
    debounce: null,
    gateTimer: null,
    collected: 0,
    tokens: new Set<string>(),
    pendingVerdict: null,
    parseActive: false,
    pending: false,
    lastParseRunId: null,
    lastTrigger: null,
    lastRoundStartedAt: 0,
    recentRoundAt: [],
    round: null,
    update: persisted ?? emptyGraphUpdate(projectId, (deps.now ?? nowIso)()),
    modulesCache: null,
    probeSig: new Map<string, string>(),
  };
  // 缺省实现在这里接线（注入优先：单测不碰真 parse/真蓝图/真草稿）
  st.deps.parse = deps.parse ?? ((id) => startParseProjectRun(id, deps.dataDir));
  st.deps.rebuild =
    deps.rebuild ??
    (async (id, opts) => {
      // 走**同一条**既有自动链（不新建第二套派生）：`awaitSemantic:false` = 确定性派生/发布先落地，
      // 语义整理阶段仍在后台按既有口径跑（它的状态有 V08-05 的三态横幅）。这里只如实取回结论。
      const result = await autoRebuildBlueprint(id, {
        trigger: opts.trigger,
        awaitSemantic: false,
        ...(deps.dataDir === undefined ? {} : { dataDir: deps.dataDir }),
      });
      return {
        published: result.published,
        kept_previous: result.kept_previous,
        publish_reason: result.publish_reason,
        blueprint: result.blueprint,
        model_calls: result.model_calls,
      } satisfies GraphRebuildOutcome;
    });
  st.deps.draft =
    deps.draft ?? ((id) => draftBlueprintOf(id, { ...(deps.dataDir === undefined ? {} : { dataDir: deps.dataDir }) }));
  st.off = onProjectChange((pid, line) => {
    if (pid === projectId) graphRefreshDispatch(pid, line);
  });
  states.set(projectId, st);
  return true;
}

/**
 * 关发现链（幂等）：退订 + 清防抖/闸门定时器；在飞的 run 不归本模块取消（它的取消只来自显式入口）。
 * 若关链时还有一轮没跑完（记录仍是 `updating`），如实标成 `stale` + 原因——不留下"正在更新"的假象。
 */
export function stopGraphRefresh(projectId: string): boolean {
  const st = states.get(projectId);
  if (st === undefined) return false;
  states.delete(projectId);
  st.stopped = true;
  st.off();
  if (st.debounce !== null) {
    clearTimeout(st.debounce);
    st.debounce = null;
  }
  if (st.gateTimer !== null) {
    clearTimeout(st.gateTimer);
    st.gateTimer = null;
  }
  if (st.parseActive || st.update.state === "updating") {
    markInterrupted(projectId, "监听已关（watcher 停止或服务退出）", st.deps.dataDir, st.deps.now());
  }
  return true;
}

/** 服务退出兜底：关掉全部发现链（与 closeAllWatchers 同一时机） */
export function stopAllGraphRefresh(): void {
  for (const id of [...states.keys()]) stopGraphRefresh(id);
}

/** 读某项目当前的更新状态（只读；HTTP 读口用；没有记录返回 null） */
export function graphUpdateOf(projectId: string, dataDir?: string): GraphUpdateRecord | null {
  return readGraphUpdate(projectId, dataDir);
}

/** 供验证脚本断言"阶段总数"（口径只有一处：graphUpdate.PHASES_TOTAL） */
export const GRAPH_UPDATE_PHASES_TOTAL = PHASES_TOTAL;
