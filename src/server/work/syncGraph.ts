// graph_full 检查的六图探针（PLAN V09-23；DESIGN.md §2.10 / §3.2 / §4.2）。
//
// 为什么单独一个薄模块：`check.graph_full` 必须用**只读 canonical builder `sixGraphsOf`** 全量同快照取齐，
// 但 `sync.ts` 若直接 import sixGraphs，会形成 `sync.ts → sixGraphs.ts → entry.ts → sync.ts` 的循环 import
// （sixGraphs 依赖 entry 的 projectWithReleases）——这正是 design-review findings D 的红线。
// 所以这里用**注册制**把探针注入 sync.ts：sync.ts 不反向 import 上层模块，本模块只被组合根 import。
//
// 判据：可用性 published、本次取齐 complete、采集完整性 complete、无 anomalies、更新态非 updating/failed/stale、
// 期望有效 baseline_id 相符，且**生效基线当前仍然有效**（设计/施工源在基线与激活后没变过——
// 只比 baseline_id 不够：旧 id 相同但 design source 变了也必须失败，Codex 反例11）。
// **不**把 614 之类的对象数写成通用规则（H-2）。
//
// 另注册一个**有界图源探针**（只读生效基线身份 + 设计/施工源修订，不跑 sixGraphsOf），
// 供文件锁内的目标指纹复核用——锁内不跑不受控全量图构建（契约「不要跑不受控全仓扫描」）。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { activeBaseline, loadDocument, resolveProjectRelative } from "./documents";
import { getProject } from "../registry";
import { baselineRevalidateOf } from "./entry";
import { sixGraphsOf } from "../../arch/sixGraphs";
import {
  registerSyncGraphProbe,
  registerSyncGraphSourceProbe,
  SYNC_GRAPH_INPUT_FILE_MAX_BYTES,
  SYNC_GRAPH_INPUT_TOTAL_MAX_BYTES,
  type SyncGraphInputs,
  type SyncGraphProbeResult,
  type SyncGraphSourceResult,
} from "./syncProbe";

interface SourceIdentity {
  baseline_id: string | null;
  baseline_valid: boolean;
  design_revision: string | null;
  plan_revision: string | null;
  plan_definition_revision: string | null;
  reasons: string[];
}

/** canonical builder 实际图输入文件（项目内相对路径；有界读取）。漏一个就会「基线没变就信旧全量」（Codex 反例14）。 */
const GRAPH_INPUT_FILES: readonly { key: string; rel: string }[] = [
  { key: "blueprint", rel: ".工作台/arch/blueprint.json" },
  { key: "modules", rel: ".工作台/arch/modules.json" },
  { key: "supplement", rel: ".工作台/arch/supplement.json" },
  { key: "names", rel: ".工作台/arch/names.json" },
  { key: "graph_update", rel: ".工作台/arch/graph-update.json" },
  { key: "reconcile_last", rel: ".工作台/arch/reconcile-last.json" },
  { key: "semantic_status", rel: ".工作台/arch/semantic-status.json" },
];

/** 有界图输入读取的结果：身份快照 + 实际读取异常（非空即不可当通过） */
export interface GraphInputsRead {
  inputs: SyncGraphInputs;
  /** 实际有界输入读取异常/超界（超界、非文件、非 ENOENT 的读取失败）；空 = 可核实 */
  problems: string[];
  /** 是否含 I/O 不可读（EACCES/EIO 等）——裁决 incomplete；纯超界/非文件裁决 failed */
  incomplete: boolean;
}

/**
 * **有界**读 canonical builder 的实际图输入身份：逐文件路径守卫（项目根内、非软链逃逸、常规文件、
 * 单文件/总字节上限），内容 sha256。**只有 ENOENT 是合法缺失**（记为 null，空态合法）；
 * 超界/非文件/非 ENOENT 的 lstat 失败/读失败都是**实际异常**——既记稳定 marker，也进 `problems`
 * 让探针明确 failed/incomplete（不能 `catch` 一切 lstat 异常当不存在，Codex 反例）。
 * `progress.json` 是 v1 兼容派生（读时懒建），不入指纹——v2 业务事件投影由 `graph_full` 的
 * `events_fp`（`syncChecks` 里算）覆盖。**不含**任何 sync 事件序号/时间/墙钟 → 连续扫描指纹稳定。
 */
export function graphInputsOf(projectId: string, dataDir: string): GraphInputsRead {
  const out: SyncGraphInputs = {};
  const problems: string[] = [];
  let incomplete = false;
  const project = getProject(projectId, dataDir);
  if (project === undefined) return { inputs: out, problems, incomplete };
  const projectRoot = path.resolve(project.path);
  let total = 0;
  for (const { key, rel } of GRAPH_INPUT_FILES) {
    const guard = resolveProjectRelative(projectRoot, rel);
    if (!guard.ok) {
      out[key] = `invalid:${guard.reason}`;
      problems.push(`图输入 ${rel} 路径不合法（${guard.reason}：必须在项目根内且不经软链逃逸）`);
      continue;
    }
    let st: fs.Stats;
    try {
      st = fs.lstatSync(guard.abs);
    } catch (e) {
      // **只有 ENOENT 是合法缺失**；EACCES/EPERM/EIO 等读不到不能当 null 静默放行。
      if ((e as NodeJS.ErrnoException | null)?.code === "ENOENT") {
        out[key] = null;
        continue;
      }
      out[key] = "lstat_failed";
      problems.push(`图输入 ${rel} 读不到（${e instanceof Error ? e.message : String(e)}）——只有 ENOENT 算合法缺失，不当 null 放行`);
      incomplete = true;
      continue;
    }
    if (st.isSymbolicLink() || !st.isFile()) {
      out[key] = st.isSymbolicLink() ? "symbolic_link" : "not_regular_file";
      problems.push(`图输入 ${rel} 不是常规文件（软链/目录等）——不跟随，也不当通过`);
      continue;
    }
    if (st.size > SYNC_GRAPH_INPUT_FILE_MAX_BYTES) {
      out[key] = `oversize:${st.size}`;
      problems.push(`图输入 ${rel} 单文件 ${st.size} 字节超过上限 ${SYNC_GRAPH_INPUT_FILE_MAX_BYTES}——不静默截断，明确失败`);
      continue;
    }
    if (total + st.size > SYNC_GRAPH_INPUT_TOTAL_MAX_BYTES) {
      out[key] = "total_budget_exceeded";
      problems.push(`图输入总字节超过上限 ${SYNC_GRAPH_INPUT_TOTAL_MAX_BYTES}（读 ${rel} 前已累计 ${total}，本条 ${st.size}）——不静默截断，明确失败`);
      continue;
    }
    total += st.size;
    try {
      out[key] = crypto.createHash("sha256").update(fs.readFileSync(guard.abs)).digest("hex");
    } catch (e) {
      out[key] = "unreadable";
      problems.push(`图输入 ${rel} 读不出（${e instanceof Error ? e.message : String(e)}）——明确失败，不当空态`);
      incomplete = true;
    }
  }
  return { inputs: out, problems, incomplete };
}

/** 读**当前生效基线**身份与其源修订，并实核它是否仍然有效（设计比内容哈希、施工图比定义哈希）。 */
function sourceIdentityOf(projectId: string, dataDir: string): SourceIdentity {
  const reasons: string[] = [];
  let baseline = null as ReturnType<typeof activeBaseline>;
  try {
    baseline = activeBaseline(projectId, dataDir);
  } catch (e) {
    reasons.push(`基线流水不可读：${e instanceof Error ? e.message : String(e)}`);
    return { baseline_id: null, baseline_valid: false, design_revision: null, plan_revision: null, plan_definition_revision: null, reasons };
  }
  let designRev: string | null = null;
  let planRev: string | null = null;
  let planDefRev: string | null = null;
  try {
    const design = loadDocument(projectId, "design", dataDir);
    designRev = design === null ? null : design.revision.content_sha256;
    const plan = loadDocument(projectId, "plan", dataDir);
    planRev = plan === null ? null : plan.revision.content_sha256;
    planDefRev = plan === null ? null : plan.revision.definition_sha256;
  } catch (e) {
    reasons.push(`图纸读不出：${e instanceof Error ? e.message : String(e)}`);
  }
  const revalidate = baselineRevalidateOf(baseline, { design_revision: designRev, plan_revision: planRev, plan_definition_revision: planDefRev });
  if (revalidate.source_changed) reasons.push(...revalidate.messages);
  const baselineValid = baseline !== null && !revalidate.source_changed;
  return {
    baseline_id: baseline?.baseline_id ?? null,
    baseline_valid: baselineValid,
    design_revision: designRev,
    plan_revision: planRev,
    plan_definition_revision: planDefRev,
    reasons,
  };
}

registerSyncGraphSourceProbe((projectId, dataDir): SyncGraphSourceResult => {
  const id = sourceIdentityOf(projectId, dataDir);
  const gi = graphInputsOf(projectId, dataDir);
  // 实际有界图输入读取异常/超界 = 不可核实：与基线有效性一起并进 ok / reasons，
  // 并给锁内复核一个明确的 failed/incomplete 口径（不是只带稳定 marker 的 actual）。
  const reasons = [...id.reasons, ...gi.problems];
  return {
    ok: id.baseline_valid && gi.problems.length === 0,
    baseline_id: id.baseline_id,
    baseline_valid: id.baseline_valid,
    design_revision: id.design_revision,
    plan_revision: id.plan_revision,
    plan_definition_revision: id.plan_definition_revision,
    graph_inputs: gi.inputs,
    graph_input_problems: gi.problems,
    graph_input_verdict: gi.problems.length === 0 ? null : gi.incomplete ? "incomplete" : "failed",
    reasons,
  };
});

registerSyncGraphProbe((projectId, dataDir): SyncGraphProbeResult => {
  const snap = sixGraphsOf(projectId, { dataDir, mode: "full" });
  const identity = sourceIdentityOf(projectId, dataDir);
  const graphInputs = graphInputsOf(projectId, dataDir);
  const reasons: string[] = [];
  let ok = true;
  const availability = snap.graph_state.availability;
  const updateState = snap.graph_state.update_state;
  if (availability !== "published") {
    ok = false;
    reasons.push(`图可用性 ${availability}（未发布/只有草稿）`);
  }
  if (snap.completeness.complete !== true) {
    ok = false;
    reasons.push(`本次未取齐（complete=false：${snap.completeness.note}）`);
  }
  if (snap.collection.status !== "complete") {
    ok = false;
    reasons.push(`采集完整性 ${snap.collection.status}：${snap.collection.reasons.join("；") || "（无）"}`);
  }
  if (snap.anomalies.length > 0) {
    ok = false;
    reasons.push(`图带异常 ${snap.anomalies.length} 条：${snap.anomalies.slice(0, 3).join("；")}`);
  }
  if (updateState === "updating") {
    ok = false;
    reasons.push("图正在更新");
  } else if (updateState === "failed") {
    ok = false;
    reasons.push("图更新失败");
  } else if (updateState === "stale") {
    ok = false;
    reasons.push("图已过期（下次打开应拿到完整新图或以明确失败代替）");
  }
  // 生效基线是否仍然有效（源没在激活后变过）＋ 图是否确实由这条生效基线构建（不是旧图）。
  if (!identity.baseline_valid) {
    ok = false;
    reasons.push(`生效基线当前无效（设计/施工源在基线激活后变过）：${identity.reasons.join("；") || "来源已变"}`);
  }
  if (identity.baseline_id !== null && snap.baseline.baseline_id !== identity.baseline_id) {
    ok = false;
    reasons.push(`已发布图由基线 ${snap.baseline.baseline_id ?? "（无）"} 构建，与当前生效基线 ${identity.baseline_id} 不一致（旧图）`);
  }
  // 实际有界图输入读取异常/超界 = 不可核实（不能只带稳定 marker 放行）：明确 failed/incomplete。
  if (graphInputs.problems.length > 0) {
    ok = false;
    reasons.push(`图输入不可核实（有界读取异常/超界）：${graphInputs.problems.slice(0, 3).join("；")}`);
  }
  const staleLike = updateState === "stale" || !identity.baseline_valid;
  const verdict = ok
    ? "passed"
    : staleLike
      ? "stale"
      : graphInputs.problems.length > 0
        ? graphInputs.incomplete
          ? "incomplete"
          : "failed"
        : snap.completeness.complete === true
          ? "failed"
          : "incomplete";
  return {
    ok,
    verdict,
    baseline_id: identity.baseline_id,
    baseline_valid: identity.baseline_valid,
    design_revision: identity.design_revision,
    plan_revision: identity.plan_revision,
    plan_definition_revision: identity.plan_definition_revision,
    graph_inputs: graphInputs.inputs,
    graph_input_problems: graphInputs.problems,
    availability,
    update_state: updateState,
    collection_status: snap.collection.status,
    complete: snap.completeness.complete,
    anomalies: snap.anomalies,
    reasons,
  };
});
