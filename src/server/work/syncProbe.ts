// 六图探针的注册点（PLAN V09-23；DESIGN.md §2.10）。
//
// 为什么单独一个**零依赖**模块：`sync.ts` 不能直接 import `sixGraphs`（会形成
// `sync.ts → sixGraphs.ts → entry.ts → sync.ts` 环），所以用注册制。但注册表若放在 sync.ts 里，
// `syncGraph.ts`（它 import sixGraphs）与 sync.ts 之间仍会因模块求值顺序触发 TDZ
// （`Cannot access 'registeredProbe' before initialization`）——故把注册表抽到这个不 import 任何
// 服务端模块的小文件里：任何求值顺序下它都先初始化好，注册与读取都安全。
import type { SyncItemVerdict } from "../../shared/syncEvidence";

/**
 * canonical builder（`sixGraphsOf`）实际图输入身份的有界快照（文件内容 sha256；缺失/超限用稳定标记）。
 * 覆盖 blueprint / 模块采集事实（modules/supplement/names）/ graph-update / reconcile / 语义状态——
 * 「基线 id 没变就信旧全量 passed」不算数（Codex 反例14）；**不含**自己的 sync 事件序号或墙钟。
 */
export type SyncGraphInputs = Record<string, string | null>;

export interface SyncGraphProbeResult {
  ok: boolean;
  verdict: SyncItemVerdict;
  baseline_id: string | null;
  /** 当前生效基线是否**仍然有效**（设计/施工源在基线激活后变过＝false）：只比 id 不够（Codex 反例11） */
  baseline_valid: boolean;
  design_revision: string | null;
  plan_revision: string | null;
  plan_definition_revision: string | null;
  /** 图输入身份（有界；锁内外同一份口径） */
  graph_inputs: SyncGraphInputs;
  /**
   * 实际有界图输入读取异常/超界（非空＝该图输入不可核实，**必须** failed/incomplete，不能只带稳定 marker 放行）。
   * 缺失（ENOENT）是合法空态 → null 且不入此列；`oversize`/`total_budget_exceeded`/非文件/非 ENOENT 读取失败入此列。
   */
  graph_input_problems: string[];
  availability: string;
  update_state: string | null;
  collection_status: string;
  complete: boolean;
  anomalies: string[];
  reasons: string[];
}
export type SyncGraphProbe = (projectId: string, dataDir: string) => SyncGraphProbeResult;

/**
 * **有界**图源探针：只读生效基线身份与设计/施工源修订（不跑 `sixGraphsOf` 全量），
 * 供文件锁**内**的目标指纹复核（图源输入稳定快照）——锁内不跑不受控全量图构建。
 */
export interface SyncGraphSourceResult {
  ok: boolean;
  baseline_id: string | null;
  baseline_valid: boolean;
  design_revision: string | null;
  plan_revision: string | null;
  plan_definition_revision: string | null;
  /** 图输入身份（有界；与全量探针逐字段一致，供锁内重算 source_fingerprint） */
  graph_inputs: SyncGraphInputs;
  /** 实际有界图输入读取异常/超界（非空＝不可当通过；与常驻 marker 不同，必须失败） */
  graph_input_problems: string[];
  /**
   * 图输入异常的裁决口径（无异常为 null）：超界/非文件 = failed，I/O 不可读 = incomplete。
   * 锁内复核据此把图项明确判 failed/incomplete，而不是只带稳定 marker 放行。
   */
  graph_input_verdict: SyncItemVerdict | null;
  reasons: string[];
}
export type SyncGraphSourceProbe = (projectId: string, dataDir: string) => SyncGraphSourceResult;

/**
 * 有界图源探针单次读取的**总字节界**：图输入文件合计超过即记稳定标记（不静默截断后当通过）。
 * 单文件另有过 `SYNC_GRAPH_INPUT_FILE_MAX_BYTES` 的常规文件与上限核验。
 */
export const SYNC_GRAPH_INPUT_TOTAL_MAX_BYTES = 16 * 1024 * 1024;
export const SYNC_GRAPH_INPUT_FILE_MAX_BYTES = 8 * 1024 * 1024;

let probe: SyncGraphProbe | null = null;
let sourceProbe: SyncGraphSourceProbe | null = null;

export function registerSyncGraphProbe(fn: SyncGraphProbe): void {
  probe = fn;
}
export function syncGraphProbe(): SyncGraphProbe | null {
  return probe;
}

export function registerSyncGraphSourceProbe(fn: SyncGraphSourceProbe): void {
  sourceProbe = fn;
}
export function syncGraphSourceProbe(): SyncGraphSourceProbe | null {
  return sourceProbe;
}
