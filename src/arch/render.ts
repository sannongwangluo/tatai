// A2 兼容壳 + 项目级入口（F2 重构：渲染数据层的真实现已抽到 `shared-graph.ts`，两图共用一份）。
// 本文件不再包含第二份实现，只做两件事（§3.2 红线：不给新视图另写一套数据/解析）：
//   ① 旧名字别名：`buildRenderGraph` / `renderGraph` / `Render*` 类型（HTTP 路由、verify-a2、
//      src/ui 的类型引用仍按旧名调用，零改动）；
//   ② 项目级入口 `buildSharedGraph(projectId)`：读注册表 + modules.json + names.json +
//      progress.json → 交给共用层合成，返回**未按视图过滤**的共用数据。
// 为什么入口在本文件而不在 `shared-graph.ts`：后者要零 node / 零 server import（浏览器侧
// F3 数据流向渲染器 / N1 思维导图直接 import 同一份选择器，tree-sitter 不能被打进前端包），
// 而本文件正是 A3 以来服务端唯一的架构数据读口，沿用不动。
import { getProject, resolveDataDir } from "../server/registry";
import { WsError, readProgress } from "../server/workstation";
import { projectWithReleases } from "../server/work/entry";
import type { StatusProjection } from "../server/work/statusProjection";
import { readBlueprint } from "./blueprint";
import { analyzeDataFlow } from "./dataflow";
import { declaredLinksOf, readLastReconcile } from "./reconcile";
import { moduleStatusKeysOf, taskDerivedModuleStatus } from "../ui/arch/projectGraph";
import type { DataFlowModel } from "../ui/arch/projectGraph";
import { readModules } from "./parse";
import { readNames } from "./name";
import { mergeSupplement, readSupplement } from "./supplement";
import {
  buildSharedGraphFrom,
  capMergedGraph,
  type GraphEdge,
  type GraphNode,
  type SharedGraph,
  type SharedLimits,
} from "./shared-graph";

/** A3 渲染数据契约（旧名）：节点 / 边 / 文件结构 = 共用数据层的同名字段 */
export type RenderNode = GraphNode;
export type RenderEdge = GraphEdge;
export type RenderGraphFile = SharedGraph;
export type RenderLimits = SharedLimits;

/** A2 旧名：共用数据层的纯合成函数（verify-a2 与临时夹具按旧名调用，等价于 buildSharedGraphFrom） */
export const buildRenderGraph = buildSharedGraphFrom;

/**
 * 按注册表项目 id 合成共用数据层（HTTP 路由 `/arch/render` 入口；F2 的唯一节点/边来源）。
 * 未解析过 modules.json → {exists:false}（200 空态，与 arch/modules 同口径）；
 * names.json 缺失不视为错误（name 兜底 id，提示前端可先跑 arch/name）。
 * 返回值是 E_ALL（已过 §4.3 防爆炸、未按视图过滤）——各视图在前端 `selectGraph(mode, graph)`
 * 取自己要画的边子集与着色，服务端不替视图过滤（EXPLOSION_CONTROL_STAGE：防爆炸只此一处）。
 */
export function buildSharedGraph(
  projectId: string,
  opts: { dataDir?: string; limits?: RenderLimits } = {},
): { exists: boolean; graph?: SharedGraph } {
  const project = getProject(projectId, opts.dataDir);
  if (!project) throw new WsError("PROJECT_NOT_FOUND", `项目不存在: ${projectId}`);
  const { exists, arch } = readModules(projectId, opts.dataDir);
  if (!exists || !arch) return { exists: false };
  const names = readNames(project.path);
  // 模块四色状态（§4.2）：progress.json 按 id 对；progress 损坏/对不上不阻塞渲染
  const statusById = new Map<string, string>();
  try {
    for (const m of readProgress(projectId, opts.dataDir).modules) {
      statusById.set(m.id, m.status);
    }
  } catch {
    // progress 不可读时省略 status 字段
  }
  return {
    exists: true,
    // Q133：完整性标记跟着模块集走（旧落盘件没这字段 → undefined → null = 完整性未知，
    // 界面按"未知"提示，不许默认当全量）
    // 2026-09-19 试用增强三期：合成后合并聊天补全层（arch/supplement.json）——三视图共用
    // 的唯一合并点，§3.2「同一份数据」红线不破；补全层读不了不阻塞渲染（渲染层只依赖解析层）
    graph: (() => {
      const g = buildSharedGraphFrom(
        arch.modules,
        names.entries,
        statusById,
        opts.limits,
        arch.budget_exhausted ?? null,
      );
      try {
        const sup = readSupplement(projectId, opts.dataDir);
        if (sup === null) return g;
        // 2026-09-20 审计（R1-C-012 / R1-ZS-002 / R1-ZS-005）：补全层节点/边会绕过解析层的
        // §4.3 防爆炸口径，故合并后的最终图在这里统一收口再施一遍（capMergedGraph）——
        // 硬上限（节点聚合 + 边按权重截断）与扇出 top-K 入边过滤都补上；truncated 按层分开
        // 如实反映合并后现实（layers.parse / layers.merged）。
        return capMergedGraph(mergeSupplement(g, sup));
      } catch {
        return g; // 补全层损坏：照常出解析层全量（错误由写入口如实报，不拖垮读路径）
      }
    })(),
  };
}

/** A2 旧名：等价于 `buildSharedGraph`（服务端路由仍按旧名调用） */
export const renderGraph = buildSharedGraph;

// ── V09-08 ⑤：技术详情层的**模块状态取 v2 证据派生**（附录 E.6 第 2 条） ──
//
// 背景（报告 02 G-07）：`get_arch` 原来把 `progress.json` 的自报四色当模块状态返回，
// 与用户在六图上看到的 v2 派生状态**不是一套口径**（实测 `audit` 连 status 都没有、
// 其余六个一律 "done"）。E.6 的裁定：保持原有查询与节点/边形状兼容的前提下，
// 让模块状态取 v2 证据派生结果，无法映射的节点写明「无状态记录」。
//
// 口径**一处实现**：派生仍走 `taskDerivedModuleStatus`（附录 D；与 UI 的
// `ProjectViewView`/`ArchView` 同一份），投影走 `projectWithReleases`（与 `project_entry` 同一份），
// 配对走 `declaredLinksOf`（只有材料点名了**实现落点**的配对才有资格继承状态色）。

/** v2 派生的技术模块状态表（键＝技术模块 id 与蓝图节点 id 两套；见 `moduleStatusKeysOf`） */
export interface TechModuleStatus {
  /** 上屏键（六态键 / `no_status_record` / `unmapped`；与画布同一份口径） */
  keys: Record<string, string>;
  /** 人话依据句（键同上；说明这个状态凭什么算出来） */
  basis: Record<string, string>;
  /** 本份派生的依据：蓝图基线（null = 没有已发布图 ⇒ 状态表为空，全按「无状态记录」） */
  baseline_id: string | null;
  /** 有没有已发布蓝图（false ⇒ `keys` 为空，读口必须如实写「无状态记录」） */
  has_blueprint: boolean;
}

/**
 * 取项目当前的技术模块状态（只读；**不写盘、不调模型**）。
 * 没有已发布蓝图时返回空表 ＋ `has_blueprint:false`——读口据此写「无状态记录」，
 * **不回落 v1 四色**（回落就是拿自报进度冒充现行状态）。
 */
export function techModuleStatusOf(
  projectId: string,
  opts: { dataDir?: string } = {},
): TechModuleStatus {
  const empty: TechModuleStatus = { keys: {}, basis: {}, baseline_id: null, has_blueprint: false };
  const blueprint = readBlueprint(projectId, opts.dataDir);
  if (blueprint === null) return empty;
  const projection: Record<string, StatusProjection> = {};
  const proj = projectWithReleases({
    projectId,
    dataDir: opts.dataDir ?? resolveDataDir(),
    definitions: [],
  });
  for (const o of proj.objects) projection[o.object_id] = o;
  const links = declaredLinksOf(readLastReconcile(projectId, opts.dataDir).result ?? null);
  const derived = taskDerivedModuleStatus({ blueprint, projection, declared_links: links });
  const keys = moduleStatusKeysOf(derived);
  const basis: Record<string, string> = {};
  for (const [id, st] of Object.entries({ ...derived.status, ...derived.by_object })) {
    basis[id] = st.basis;
    const techId = id.startsWith("plan:code:") ? id.slice("plan:code:".length) : id.startsWith("module:") ? id.slice("module:".length) : null;
    if (techId !== null && basis[techId] === undefined) basis[techId] = st.basis;
  }
  return { keys, basis, baseline_id: blueprint.baseline_id, has_blueprint: true };
}

// ── V09-11：数据流向图的**来源分层**（§3.2／§11.2）：当前实现 vs 目标语义 ──
//
// 口径一句话（§3.2 用户澄清）：三张技术详情图当前共用的静态 import 依赖层**只是当前实现**，
// 数据流向图的**目标**是业务/项目数据从输入源 → 处理 → 存储 → 输出/外部系统的实际路径；
// 每条关系要有稳定 ID、方向、逐条出处（设计声明／代码静态分析／可复跑实测）与验证态。
// 本函数是这一层在**服务端读口**的出口：UI 侧走 HTTP 路由（`GET /api/projects/:id/arch/dataflow`）、
// MCP 侧随 `get_arch` 的 v2 返回体给出——两处读的是同一份派生，不各算一套。
//
// 只读：派生不写盘、不调模型、不给纳管项目加运行时埋点（§11.2）。实现与判据见 `./dataflow.ts`。
export function dataFlowLayerOf(projectId: string, opts: { dataDir?: string } = {}): DataFlowModel {
  return analyzeDataFlow(projectId, opts);
}
