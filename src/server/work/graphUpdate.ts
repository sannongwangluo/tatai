// V09-12：图更新的**状态机与预计用时口径**（PLAN.md V09-12，DESIGN.md §3.3 / §4.4、附录 E.8-2/E.8-4）。
//
// 这一份只回答三件事，且都必须是**可追的实测量**换来的：
//   ① 现在图在什么状态：`updating`（正在更新）/ `ready`（图与最近一次已完成变更一致）/
//      `stale`（有变更没反映到图里、且当前没有在跑）/ `failed`（本轮派生失败，旧图保留）；
//   ② 正在更新时**预计用时**是多少、依据是什么；**依据不足就"无法估计"，绝不编造数字**；
//   ③ 本次变更是哪一次（`change_token`）——"下一次打开拿到本次变更对应的完整新图"要对得上号。
//
// 落点：`<项目根>/.工作台/arch/graph-update.json`（生成物；watcher 侧 `.工作台/**` 整段忽略，
// 不会自触发）。读口是 `GET /api/projects/:id/arch/blueprint` 的 `update` 字段（`src/server/index.ts`），
// 界面侧的口径镜像与文案在 `src/ui/arch/projectGraph.ts`（前端不 import 服务端模块）。
//
// **预计用时的依据只有两种，都在这里写明来源，且都写进 `note`**（§3.3「依据只认可追的实测量」）：
//   · `history_median`：本机**历史完成轮次耗时**的中位数（`history_ms`，同一份记录里保存的实测量）；
//   · `elapsed_phases`：本轮**已完成的阶段数 + 已耗时**的外推（阶段数分母是 `PHASES_TOTAL`）；
//   · `wait_window`：安全防抖闸门（最小间隔 / 窗口预算）还要等多久——等待时长本身是算出来的实测量；
//   · `none`：以上都没有 → 输出「无法估计」，**不给数字**。
import fs from "node:fs";
import path from "node:path";
import { blueprintDir, writeJsonAtomic } from "../../arch/blueprint";
import { nowIso } from "../time";

/** 状态落点文件名（与 graph-refresh-last.json / blueprint.json 同在 `.工作台/arch/`） */
export const GRAPH_UPDATE_FILE = "graph-update.json";

/** 图更新的四态（§3.3 末段 + §4.4：不含"旧图当新图"这一种） */
export type GraphUpdateState = "updating" | "ready" | "stale" | "failed";

/** 更新中的当前阶段（"正在更新"要能说清在等什么、在做什么） */
export type GraphUpdatePhase =
  /** 安全防抖静默窗内（突发变更合批中） */
  | "debounce"
  /** 在等闸门（最小间隔 / 窗口预算）：还没开跑 */
  | "queued"
  /** 确定性重解析（代码结构 → modules.json） */
  | "reparse"
  /** 蓝图重建（确定性派生链，§4.1 红线：不新建第二套派生） */
  | "blueprint";

/** 触发范围（§3.2「目录、深层模块、接口与依赖关系的变化都要触发相关图更新」） */
export type GraphTriggerScope =
  /** 图纸源（未审定）变化 → 只重算草稿 */
  | "doc"
  /** 顶层目录增删 */
  | "structure_top"
  /** 深层目录（二级及更深）增删——模块划分可能变 */
  | "structure_deep"
  /** 模块对外接口文件（桶/入口/类型声明）改动 */
  | "interface"
  /** 跨模块依赖（import）变化 */
  | "dependency";

/** ETA 的依据档（`none` = 无法估计；其余三档都必须能指出实测量来源） */
export type GraphEtaBasis = "history_median" | "elapsed_phases" | "wait_window" | "none";

export interface GraphUpdateEta {
  basis: GraphEtaBasis;
  /** 预计**本轮总耗时**（毫秒）；`basis=none` 时恒为 null（界面据此显示「无法估计」） */
  total_ms: number | null;
  /** 依据说明（人话，含实测量数值；`basis=none` 时写明为什么估不出来） */
  note: string;
  /** 依据用到的实测量样本（可追：历史样本数 / 已完成阶段数 / 总阶段数） */
  samples: { history: number; phases_done: number; phases_total: number };
}

/** 本轮派生的结果事实（"本次变更对应的完整新图"对不对得上号，靠这几项对账） */
export interface GraphUpdateResult {
  /** 重解析产出 modules.json 的 generated_at（代码结构图那一份） */
  modules_generated_at: string | null;
  /** 蓝图重建产出（或保留）的 generated_at */
  blueprint_generated_at: string | null;
  blueprint_published: boolean;
  publish_reason: string | null;
  kept_previous: boolean;
}

export interface GraphUpdateRecord {
  version: 1;
  project_id: string;
  state: GraphUpdateState;
  scope: GraphTriggerScope | null;
  /** 判据说明：这一轮是被哪条判据判成"相关图要更新"的（可追，不是一句"图待更新"） */
  reason: string | null;
  phase: GraphUpdatePhase | null;
  /** 本轮已完成阶段数 / 总阶段数（ETA 的实测量之一） */
  phases_done: number;
  phases_total: number;
  /** 本轮变更指纹（sha256 截断；由本轮收下的 `action:path` 集合算出——下一次打开按它对上号） */
  change_token: string | null;
  /** 本轮起点（防抖窗首条变化到达时刻；未开轮为 null） */
  started_at: string | null;
  updated_at: string;
  finished_at: string | null;
  eta: GraphUpdateEta;
  result: GraphUpdateResult | null;
  /** 本机历史完成轮次耗时（毫秒，最近 N 次）——ETA 唯一可用的历史实测量 */
  history_ms: number[];
  /** 最近一次失败原因（成功为 null；失败/中断都如实写人话） */
  last_error: string | null;
}

/** 迭代阶段总数（reparse + blueprint）：ETA 的"已完成阶段数"分母 */
export const PHASES_TOTAL = 2;
/** 历史耗时样本上限（本机实测量；只留最近 N 次，文件有界） */
export const HISTORY_MAX = 5;

/** 中位数（偶数取中间两个的平均；空数组返回 null） */
export function medianOf(values: readonly number[]): number | null {
  const xs = values.filter((v) => Number.isFinite(v) && v >= 0).slice().sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 === 1 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

/** 秒数上屏口径（一位小数；只在有定量依据时用） */
export function secondsText(ms: number): string {
  return `${Math.max(0, Math.round(ms / 100) / 10)} 秒`;
}

/**
 * 预计用时（**纯函数**，依据见文件头）。判据顺序：等待闸门 → 历史中位 → 本轮阶段外推 → 无法估计。
 * 任何一档都带 `note` 写明实测量来源与数值；`none` 档不给数字（§3.3 不编造 ETA）。
 */
export function estimateEta(input: {
  history_ms: readonly number[];
  phases_done: number;
  phases_total?: number;
  started_at?: string | null;
  /** 当前时刻（毫秒；便于验证脚本注入，不取系统时钟） */
  now_ms?: number;
  /** 等闸门还要多久（毫秒；null/缺省 = 不在等） */
  wait_ms?: number | null;
}): GraphUpdateEta {
  const phasesTotal = input.phases_total ?? PHASES_TOTAL;
  const phasesDone = Math.max(0, Math.min(phasesTotal, input.phases_done));
  const samples = { history: input.history_ms.length, phases_done: phasesDone, phases_total: phasesTotal };
  const wait = input.wait_ms ?? null;
  if (wait !== null && wait > 0) {
    return {
      basis: "wait_window",
      total_ms: Math.round(wait),
      note: `依据＝安全防抖闸门（最小间隔／窗口预算）还要等 ${secondsText(wait)}（等待时长由上一轮起点与闸门参数算出，是本机实测量）`,
      samples,
    };
  }
  const median = medianOf(input.history_ms);
  if (median !== null) {
    return {
      basis: "history_median",
      total_ms: Math.round(median),
      note: `依据＝本机历史 ${input.history_ms.length} 轮完成耗时中位 ${secondsText(median)}（history_ms 实测量）`,
      samples,
    };
  }
  const started = typeof input.started_at === "string" ? Date.parse(input.started_at) : NaN;
  const now = input.now_ms ?? Date.now();
  const elapsed = Number.isNaN(started) ? NaN : now - started;
  if (phasesDone >= 1 && Number.isFinite(elapsed) && elapsed > 0) {
    const total = (elapsed / phasesDone) * phasesTotal;
    return {
      basis: "elapsed_phases",
      total_ms: Math.round(total),
      note:
        `依据＝本轮已完成 ${phasesDone}/${phasesTotal} 阶段、已耗时 ${secondsText(elapsed)}的单位阶段外推` +
        `（本机没有历史完成记录，只有这一轮的实测量）`,
      samples,
    };
  }
  return {
    basis: "none",
    total_ms: null,
    note: "本机没有历史完成耗时记录，本轮也还没有已完成的阶段——依据不足，无法估计（不编造数字）",
    samples,
  };
}

export function updateFilePath(projectId: string, dataDir?: string): string {
  return path.join(blueprintDir(projectId, dataDir), GRAPH_UPDATE_FILE);
}

/** 空白骨架（还没跑过任何一轮时的缺省；`state:"ready"` = 没有待更新的东西） */
export function emptyGraphUpdate(projectId: string, now: string): GraphUpdateRecord {
  return {
    version: 1,
    project_id: projectId,
    state: "ready",
    scope: null,
    reason: null,
    phase: null,
    phases_done: 0,
    phases_total: PHASES_TOTAL,
    change_token: null,
    started_at: null,
    updated_at: now,
    finished_at: null,
    eta: estimateEta({ history_ms: [], phases_done: 0 }),
    result: null,
    history_ms: [],
    last_error: null,
  };
}

/** 读回状态记录；文件不存在/读不动/形状不对一律 null（读侧不当成"图在更新"） */
export function readGraphUpdate(projectId: string, dataDir?: string): GraphUpdateRecord | null {
  let raw: string;
  try {
    raw = fs.readFileSync(updateFilePath(projectId, dataDir), "utf8");
  } catch {
    return null;
  }
  try {
    const rec = JSON.parse(raw) as GraphUpdateRecord;
    if (rec === null || typeof rec !== "object" || typeof rec.state !== "string") return null;
    if (rec.state !== "updating" && rec.state !== "ready" && rec.state !== "stale" && rec.state !== "failed") {
      return null;
    }
    return {
      ...emptyGraphUpdate(projectId, typeof rec.updated_at === "string" ? rec.updated_at : nowIso()),
      ...rec,
      history_ms: Array.isArray(rec.history_ms) ? rec.history_ms.filter((n) => typeof n === "number") : [],
    };
  } catch {
    return null;
  }
}

/** 落盘（原子写；写失败只打屏——状态是派生物，写不动不能让发现链炸掉） */
export function writeGraphUpdate(record: GraphUpdateRecord): void {
  try {
    writeJsonAtomic(updateFilePath(record.project_id), record);
  } catch (e) {
    console.warn(`[graph-update] 项目 ${record.project_id} 更新状态落盘失败：${(e as Error).message}`);
  }
}

/**
 * 把"上一次派生被中断"（进程重启 / 监听被关）如实标成 `stale`：
 * 记录里还写着 `updating` 却没有进程在跑，**继续显示"正在更新"就是骗人**，而旧图确实可能不是最新。
 * 返回改写后的记录（没有记录或状态不是 updating 时返回 null = 没动）。
 */
export function markInterrupted(projectId: string, reason: string, dataDir?: string, now?: string): GraphUpdateRecord | null {
  const rec = readGraphUpdate(projectId, dataDir);
  if (rec === null || rec.state !== "updating") return null;
  const next: GraphUpdateRecord = {
    ...rec,
    state: "stale",
    phase: null,
    finished_at: rec.finished_at ?? (now ?? nowIso()),
    updated_at: now ?? nowIso(),
    reason: rec.reason,
    last_error: `${reason}（本轮派生未收尾：${rec.reason ?? "原因未记"}）`,
    eta: estimateEta({ history_ms: rec.history_ms, phases_done: rec.phases_done, phases_total: rec.phases_total }),
  };
  writeGraphUpdate(next);
  return next;
}

/** 界面/HTTP 用的状态视图：就是记录本身（字段与 `src/ui/arch/projectGraph.ts` 的镜像类型一致） */
export type GraphUpdateView = GraphUpdateRecord;
