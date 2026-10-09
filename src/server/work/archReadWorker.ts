// V09-31/37 目标二（复审 E）：UI 重的 arch/blueprint 只读派生（provenance / plan-code / view / 草稿预览）
// 与 arch/render 的图合成——**纯只读、零写盘、零模型**——抽成一份实现，供
//   ① 主宿主只读 worker（`readWorker.ts` 的 `arch_blueprint` / `arch_render` 作业）跑；
//   ② worker 起不来时桌面宿主的**进程内退化**直接调用（同一份实现，输出逐字一致）。
//
// 为什么单独一个模块：这些派生在主线程同步跑时会占住事件循环，健康读/轻状态读被拖慢（复审 E 实测）。
// 抽出来才能既进 worker、又在退化路径复用同一份判据，不产生"两份实现慢慢漂移"。
//
// 红线：只调用既有读函数的**现读**，不新增跨请求缓存（复审：「全图跨请求缓存未证明依赖不能启用」）；
// 不写盘、不调模型（`semanticStateOf`/`graphUpdateOf` 都是只读取回执）。返回对象**不含**本机绝对路径的
// 清洗——那一步（`withoutLocalPaths`）留在主宿主按 `guard.remote` 决定，见 `index.ts`。
import { resolveDataDir } from "../registry";
import {
  archProvenanceModelOf,
  draftBlueprintOf,
  planVsCode,
  readBlueprint,
  readBlueprintReceipt,
  viewGraphWithPlan,
} from "../../arch/blueprint";
import { semanticStateOf } from "../../arch/blueprintAuto";
import { renderGraph } from "../../arch/render";
import { readModules } from "../../arch/parse";
import { RENDER_FULL_LIMITS } from "../../arch/config";
import { graphUpdateOf } from "./graphRefresh";

/**
 * §3.2 草稿图预览（只读、零写盘、零模型）：已有已发布图时不给草稿，避免两份图混看。
 * 与 `index.ts` 原闭包逐字同款（移到此处后主宿主与 worker 共用同一份）。
 */
export function draftPreviewOf(projectId: string, hasPublished: boolean): Record<string, unknown> {
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
}

/** GET /api/projects/:id/arch/blueprint 的只读派生（同一份事实与判据；主宿主随后按 remote 做路径清洗）。 */
export function computeArchBlueprintRead(projectId: string): Record<string, unknown> {
  const dataDir = resolveDataDir();
  const bp = readBlueprint(projectId);
  return {
    ok: true,
    blueprint:
      bp === null
        ? { exists: false }
        : { exists: true, blueprint: bp, receipt: readBlueprintReceipt(projectId) },
    draft: draftPreviewOf(projectId, bp !== null),
    plan_code: planVsCode(projectId),
    view: viewGraphWithPlan(projectId),
    semantic: semanticStateOf(projectId),
    update: graphUpdateOf(projectId, dataDir),
    provenance: archProvenanceModelOf(projectId, { dataDir }),
  };
}

/**
 * GET /api/projects/:id/arch/render 的只读图合成（`full` 用同一 builder 的另一组参数）。
 *
 * `planning=true`（UI 技术详情两图自 2026-10-08 五图补齐起的默认口径）：与 MCP 同名图
 * （`module_map`／`mind_map`）读**同一份**静态＋已发布规划层——同一个 builder `viewGraphWithPlan`
 * （旧静态口 `renderGraph` 不含规划层；不带 `planning` 的旧调用逐字不变）。
 *   · `full` 保留 UI 的 `RENDER_FULL_LIMITS` 安全上限；MCP 以分页取齐同源未聚合集，UI 超额内容仍走隐藏对象入口；
 *   · 规划层节点由 `mergePlanningLayer` **追加**在静态层之后，不受 15 个代码节点的概览上限约束；
 *   · 既没有已发布规划图、也没有解析产物时返回 `{exists:false}` 真实空态（不拿顶住的空图冒充有图）。
 * 纯只读、零写盘、零模型；不产生「静态 → 蓝图 → 渲染」递归（本函数只读两份、合并一份）。
 */
export function computeArchRenderRead(
  projectId: string,
  full: boolean,
  planning = false,
): Record<string, unknown> {
  if (planning) {
    const view = viewGraphWithPlan(projectId, full ? { limits: RENDER_FULL_LIMITS } : {});
    // 静态侧是否存在：与 `viewGraphWithPlan` 内部 `buildSharedGraph` 同一判据（`readModules` 的 exists）。
    const { exists: staticExists } = readModules(projectId);
    const exists = staticExists || view.blueprint !== null;
    return { ok: true, render: exists ? { exists: true, graph: view.graph } : { exists: false } };
  }
  return { ok: true, render: renderGraph(projectId, full ? { limits: RENDER_FULL_LIMITS } : undefined) };
}
