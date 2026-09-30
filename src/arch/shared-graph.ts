// F2：两图共用数据层（DESIGN.md §3.2「三视图共享同一份邻居数据」＋ §4.3 防爆炸四招）。
// graph-mode.ts 的三条契约常量在这里落地，且**全仓只落一次**：
//   NODE_SET_RULE            节点集合唯一来源：A1 modules.json 骨架（＋ A2 names.json 起名 / progress.json 四色）
//   EDGE_SET_SOURCE          全量聚合依赖边唯一来源：modules.json 的 deps 聚合（from = 依赖方、to = 被依赖方）
//   EXPLOSION_CONTROL_STAGE  §4.3 四招（硬上限 / 边聚合 / 扇出过滤）在模式过滤**之前**施加一次
// 各视图一律走 `selectGraph(mode, shared)` 取自己要画的 {nodes, edges}（§3.2：节点集合相同，
// 边集合按方向过滤/着色）：节点集合**原样复用**，任何模式不得自建节点集合、不得过滤掉节点。
// A4 下钻子级（本层之上）同样只有一份产出：`expand.ts` 的 `expandDirectory`，视图侧复用同一份结果。
//
// 为什么 IO 入口不在本文件：本文件要同时被浏览器（F3 数据流向渲染器 / N1 思维导图）与服务端
// （arch/render 路由）引**同一份**实现，所以零 node / 零 server import——运行时只依赖
// graph-mode.ts（纯口径）与 config.ts（纯配置）。读注册表与 modules.json / names.json /
// progress.json 的项目级入口 `buildSharedGraph(projectId)` 落在 render.ts（服务端专用，
// 浏览器不 import 它，否则 tree-sitter 会被打进前端包）。
import { ARCH_LIMITS, MORE_NODE_ID, type ModuleKind } from "./config";
import {
  DATA_FLOW_EDGE_RULE,
  GRAPH_MODES,
  edgeColorRoleOf,
  flowRoleOf,
  type FlowRole,
  type GraphMode,
  type GraphModeSpec,
} from "./graph-mode";

// ───────────────────────────── 输入（共用节点/边来源的上游） ─────────────────────────────

/** A1 modules.json 的模块骨架（结构化入参：A1 `ArchModule` 天然满足，便于临时夹具验证） */
export interface SharedModuleInput {
  id: string;
  path: string;
  file_count: number;
  deps: { to: string; weight: number }[];
}

/** A2 names.json 的单条起名结果（结构化入参：A2 `NameEntry` 天然满足） */
export interface SharedNameEntry {
  name: string;
  blurb: string;
  kind: ModuleKind;
}

// ───────────────────────────── 共用数据层产物（未按视图过滤） ─────────────────────────────

export interface GraphNode {
  id: string;
  /** 人话名（names.json 缓存）；无缓存兜底模块 id */
  name: string;
  /** 模块路径（A4 展开子树入参；聚合节点为 ""） */
  path: string;
  blurb: string;
  kind: ModuleKind;
  file_count: number;
  /** 模块四色状态（progress.json，§4.2）；对不上 id 时缺省 */
  status?: string;
  /** 「还有 N 个」聚合节点标记（渲染层据此特殊展示，不可下钻） */
  aggregate?: boolean;
  /** 聊天补全层节点标记（2026-09-19 试用增强三期）：静态解析层永不设此字段；
   *  渲染层据此加「chat」徽标、禁下钻（补全节点没有可解析的子树）。见 arch/supplement.ts。 */
  origin?: "chat";
  /**
   * V06-05 规划层标记：`origin:"plan"` 的节点来自审定图纸派生（DESIGN.md §4.1），**还没**
   * 对应到任何实测代码模块——§4.2 里的「灰：已规划，未开始」。静态解析层与聊天补全层永不设它。
   */
  plan_origin?: "plan";
  /** 规划层节点 id 清单（V06-05）：本实现节点被哪些规划对象引用（§4.5「实际映射用稳定关系连接」）。
   *  与 `origin` 是两件事：`origin` 说的是"这个节点从哪来"，本字段说的是"它挂在哪些规划对象上"。 */
  plan_refs?: string[];
}

/** 聚合依赖边（§4.3 第 3 招）：from = 依赖方、to = 被依赖方（DEP_EDGE_DIRECTION） */
export interface GraphEdge {
  from: string;
  to: string;
  weight: number;
  /** V06-05：本边来自规划层（审定图纸派生）而非 import 聚合——视图可按来源分样式，
   *  不许把它当"静态 import 聚合边"（§3.2：静态 import 不称为运行时业务流）。 */
  origin?: "plan";
}

/** 生效的硬上限数值（各维都是数字；具体口径字面量集中在 `config.ts` 的 `ARCH_LIMITS` /
 *  `RENDER_FULL_LIMITS` / `MCP_FULL_LIMITS`）。写成映射类型而不是 `typeof ARCH_LIMITS` 本身：
 *  后者被 `as const` 收成字面量（MAX_NODES 只能等于 15），V09-22 的全量上限（2000/20000）
 *  根本传不进来；而 config.ts 不 import 本类型（config ← shared-graph 反向 import 会成环），
 *  由使用侧按结构收窄。 */
export type GraphLimits = { [K in keyof typeof ARCH_LIMITS]: number };

/** 上限覆盖入参（只给要改的维，缺的维取 `ARCH_LIMITS` 默认） */
export type SharedLimits = Partial<GraphLimits>;

/** **单层**的截断计数（R1-ZS-005：各层分开如实记，不许把上一层的计数吞掉或重复计）。
 *  三个口径对应 §4.3 的三种削减：nodes = 被聚合成「还有 N 个」的节点数；
 *  edges = 被边硬上限按权重截断掉的边数；fanout = 被扇出过滤（第 4 招）丢弃的边数。 */
export interface TruncatedCounts {
  nodes: number;
  edges: number;
  fanout: number;
}

/** 按层分开的截断计数：parse = 解析层（`buildSharedGraphFrom` 那一遍），
 *  merged = 补全层并入后这一遍（`capMergedGraph`）。总量 = 两层相加，见 SharedGraph.truncated。 */
export interface TruncatedLayers {
  parse: TruncatedCounts;
  merged: TruncatedCounts;
}

/** 共用数据层：节点集合一份 ＋ 全量边集合 E_ALL 一份（任何模式只能从这里取子集） */
export interface SharedGraph {
  version: 1;
  generated_at: string;
  /** 生效的硬上限数值（config.ts 口径，随渲染结果带出供界面展示） */
  limits: GraphLimits;
  nodes: GraphNode[];
  /** E_ALL：已过 §4.3 防爆炸的全量聚合边，未按视图过滤 */
  edges: GraphEdge[];
  /** 被聚合截断的节点/边数（0 表示未触发上限）：nodes/edges 是**合并后总量**（＝各层相加，
   *  保持既有读口语义不变）；按层分开的明细（含扇出过滤计数）见 `layers`。
   *  `layers` 可选：旧落盘件/视图自造的局部图没有它，读口要按"退回扁平值当解析层"处理。 */
  truncated: { nodes: number; edges: number; layers?: TruncatedLayers };
  /** Q133：本图的节点集合**采集侧**是否完整——与 truncated 是两回事（truncated 是渲染侧的硬上限
   *  聚合，节点一个不少；本字段是 A1 解析到点收工，节点本身就少）。
   *  true = 残缺集（只含已扫到的部分）；false = 全量；null = 落盘件产自没有这个标记的旧版本，
   *  **完整性未知**——界面据此区分"扫完了"与"到点收工"，不许把残缺当全量展示。 */
  budget_exhausted: boolean | null;
}

/**
 * 边端点的**无歧义**内部索引键：`<from 长度>:<from><to>`（长度前缀代替裸分隔符）。
 * 为什么不能再用 `from>to` 拼串：节点 id 可合法含 `>` 等分隔符（补全层写入口就收 `chat:a>b`），
 * 裸分隔符拼出来的键既会把 `(a>b, c)` 与 `(a, b>c)` 并成同一条边，`split(">")` 解回来还会
 * 把端点切碎成悬空边（R1-ZS-002 实测输出 `chat:a → b`）。长度前缀读键时先取第一个 `:` 前的
 * 数字定 from 长度，天然无歧义。本键**只在本文件内部作 Map/Set 索引，不落盘、不作视图 id**，
 * 不改变任何历史稳定 ID 与已落盘文件的兼容读取。
 */
const pairKey = (from: string, to: string): string => `${from.length}:${from}${to}`;

/**
 * §4.3 第 4 招（扇出过滤）：入边数 > MAX_FANOUT 的公共节点只保留 top FANOUT_KEEP 条入边（按权重）。
 * 解析层（`buildSharedGraphFrom`）与合并后的最终图（`capMergedGraph`）**共用这一份实现**——
 * 补全层并入的入边同样要过这一关（R1-ZS-005：补全层 9 条边指向同一 hub 不能全保留）。
 * 返回过滤后的新数组与被丢弃的边数；边按 (from,to) 唯一，故丢弃数 = 命中键数，可如实回带。
 */
function dropFanout(
  edges: readonly GraphEdge[],
  limits: { MAX_FANOUT: number; FANOUT_KEEP: number },
): { edges: GraphEdge[]; dropped: number } {
  const inEdges = new Map<string, GraphEdge[]>();
  for (const e of edges) {
    const arr = inEdges.get(e.to) ?? [];
    arr.push(e);
    inEdges.set(e.to, arr);
  }
  const dropKeys = new Set<string>();
  for (const arr of inEdges.values()) {
    if (arr.length <= limits.MAX_FANOUT) continue;
    const sortedIn = [...arr].sort((a, b) => b.weight - a.weight);
    for (const e of sortedIn.slice(limits.FANOUT_KEEP)) dropKeys.add(pairKey(e.from, e.to));
  }
  if (dropKeys.size === 0) return { edges: [...edges], dropped: 0 };
  return { edges: edges.filter((e) => !dropKeys.has(pairKey(e.from, e.to))), dropped: dropKeys.size };
}

/**
 * 合成共用数据层（与项目 id 解耦：直接吃 A1 骨架 + 起名缓存 + 四色状态，便于临时夹具验证）。
 * 唯一节点来源 + 唯一全量边集合 + §4.3 防爆炸只在这一处施加一次（EXPLOSION_CONTROL_STAGE）：
 *   第 1 招 硬上限：节点按 file_count 降序保留 MAX_NODES-1 个，其余合并为「还有 N 个」聚合节点；
 *   第 3 招 边聚合：模块内多条 import 聚合为一条边，权重求和；端点被聚合的重定向到 __more__；
 *   第 4 招 扇出过滤：入边爆高的公共节点只保留 top FANOUT_KEEP 条入边（按依赖方向判）；
 *   第 1 招 边上限：按权重从高到低截断到 MAX_EDGES；
 * 第 2 招（分层懒加载）不在本层：顶层先出，展开才解析下一层（A4 `expandDirectory`）。
 * `budgetExhausted` 是**入参**而非本层自己算的：完整性只由 A1 解析那一刻知道（parse.ts），
 * 本层只负责原样带出给视图（null = 落盘件没标记）。
 */
export function buildSharedGraphFrom(
  modules: SharedModuleInput[],
  names: Record<string, SharedNameEntry>,
  statusById: ReadonlyMap<string, string> = new Map(),
  limitsOverride: SharedLimits = {},
  budgetExhausted: boolean | null = null,
): SharedGraph {
  const limits = { ...ARCH_LIMITS, ...limitsOverride };

  // ── 节点硬上限（§4.3 第 1 招）：按 file_count 降序保留前 MAX_NODES-1 个，
  // 其余合并为「还有 N 个」聚合节点；聚合节点排最后。
  const sorted = [...modules].sort((a, b) => b.file_count - a.file_count || a.id.localeCompare(b.id));
  const overflow = sorted.length > limits.MAX_NODES;
  const kept = overflow ? sorted.slice(0, limits.MAX_NODES - 1) : sorted;
  const dropped = overflow ? sorted.slice(limits.MAX_NODES - 1) : [];
  const keptIds = new Set(kept.map((m) => m.id));

  const nodes: GraphNode[] = kept.map((m) => {
    const entry = names[m.id];
    const status = statusById.get(m.id);
    return {
      id: m.id,
      name: entry?.name ?? m.id,
      path: m.path,
      blurb: entry?.blurb ?? "",
      kind: entry?.kind ?? "code",
      file_count: m.file_count,
      ...(status ? { status } : {}),
    };
  });
  if (dropped.length > 0) {
    nodes.push({
      id: MORE_NODE_ID,
      name: `还有 ${dropped.length} 个`,
      path: "",
      blurb: `超出节点上限 ${limits.MAX_NODES}，聚合展示，共 ${dropped.reduce((n, m) => n + m.file_count, 0)} 个文件`,
      kind: "mixed",
      file_count: dropped.reduce((n, m) => n + m.file_count, 0),
      aggregate: true,
    });
  }

  // ── 边合成（§4.3 第 3 招）：端点被聚合的重定向到 __more__（权重求和），自环不画 ──
  // 聚合索引是嵌套 Map（from → to → 权重），**不**用 `from>to` 拼串再 split：id 可合法含 `>`，
  // 裸分隔符拼键既会并错边、解回来还会把端点切碎成悬空边（R1-ZS-002，pairKey 的同类修法）。
  const redirect = (id: string) => (keptIds.has(id) ? id : MORE_NODE_ID);
  const edgeWeight = new Map<string, Map<string, number>>();
  for (const m of modules) {
    for (const d of m.deps) {
      const from = redirect(m.id);
      const to = redirect(d.to);
      if (from === to) continue;
      const row = edgeWeight.get(from) ?? new Map<string, number>();
      row.set(to, (row.get(to) ?? 0) + d.weight);
      edgeWeight.set(from, row);
    }
  }
  let edges: GraphEdge[] = [];
  for (const [from, row] of edgeWeight) {
    for (const [to, weight] of row) edges.push({ from, to, weight });
  }
  edges.sort((a, b) => b.weight - a.weight || a.from.localeCompare(b.from) || a.to.localeCompare(b.to));

  // ── 扇出过滤（§4.3 第 4 招）：入边数 > MAX_FANOUT 的公共节点只留 top FANOUT_KEEP 条入边 ──
  const fanout = dropFanout(edges, limits);
  edges = fanout.edges;

  // ── 边硬上限：按权重截断（§4.3 第 1 招）──
  const truncatedEdges = Math.max(0, edges.length - limits.MAX_EDGES);
  if (truncatedEdges > 0) edges = edges.slice(0, limits.MAX_EDGES);

  return {
    version: 1,
    generated_at: new Date().toISOString(),
    limits,
    nodes,
    edges,
    truncated: {
      nodes: dropped.length,
      edges: truncatedEdges,
      layers: {
        parse: { nodes: dropped.length, edges: truncatedEdges, fanout: fanout.dropped },
        merged: { nodes: 0, edges: 0, fanout: 0 },
      },
    },
    budget_exhausted: budgetExhausted,
  };
}

/**
 * 合并补全层（`arch/supplement.ts#mergeSupplement`）之后，对**最终图**统一施加 §4.3 防爆炸口径。
 * 为什么要有这一步：`buildSharedGraphFrom` 只对解析层模块施加过上限，而 mergeSupplement 追加的补全
 * 节点/边会**绕过**上限（实测 brain-memory 合并后 47 节点 / 186 边，`truncated` 却全 0）。本函数把
 * 口径收口到合并后的现实：
 *   · 节点：按 (file_count 降序, id 升序) 保留 MAX_NODES-1 个 ＋ 一个「还有 N 个」聚合节点
 *     （补全节点无 file_count，按 0 参与排序）；解析层已聚合过的节点数/文件数折叠进新聚合，不产生第二个聚合节点。
 *   · 边：端点被聚合的重定向到 __more__（权重求和、去自环）→ **扇出过滤（§4.3 第 4 招，与解析层同一份
 *     `dropFanout`）** → 按权重降序截断到 MAX_EDGES。补全层并入的入边同样要过 top-K 这一关
 *     （R1-ZS-005：9 条补全边指向同一 hub 不能全保留）。
 *   · 聚合索引一律走嵌套 Map / `pairKey`，不用裸分隔符拼键再 split（R1-ZS-002）。
 *   · truncated 计数按层分开如实记：`layers.parse` = 解析层既有，`layers.merged` = 本遍新增；
 *     扁平总量 = 两层相加——既不吞掉解析层既有计数，也不重复计（可反复调用，累加幂等）。
 * 注意：「未触发任何削减就原样返回」的短路条件**加了扇出这一维**——补全层并入的入边可能在一个
 * 节点/边都没超硬上限的小图上把某个公共节点顶过 MAX_FANOUT（正是 ZS-005 的反例），旧版只看
 * 节点/边数的短路会让它漏网。未触发任何削减时仍原对象原样返回（逐字节不变）。
 */
export function capMergedGraph(graph: SharedGraph, limitsOverride: SharedLimits = {}): SharedGraph {
  const limits = { ...graph.limits, ...limitsOverride };
  // 解析层那一层的计数：新格式读 layers.parse，旧落盘件/旧调用方没有 layers 就退回扁平值当解析层。
  const parseLayer: TruncatedCounts = graph.truncated.layers?.parse ?? {
    nodes: graph.truncated.nodes,
    edges: graph.truncated.edges,
    fanout: 0,
  };
  // 本函数若被调用多次：已记过的合并层计数继续累加（不重头算、不覆盖）。
  const priorMerged: TruncatedCounts = graph.truncated.layers?.merged ?? { nodes: 0, edges: 0, fanout: 0 };

  // 没有任何削减要施加（节点/边都没超硬上限，也没有公共节点入边爆高）→ **原对象原样返回**，
  // 既有常规小图路径逐字节不变。补全层并入的入边若把某个 hub 顶过 MAX_FANOUT（ZS-005 反例），
  // 这里判出 dropped>0 就会往下走——旧版的「节点/边未超限即短路」正是漏掉这一关的原因。
  if (
    graph.nodes.length <= limits.MAX_NODES &&
    graph.edges.length <= limits.MAX_EDGES &&
    dropFanout(graph.edges, limits).dropped === 0
  ) {
    return graph;
  }

  let nodes: GraphNode[] = graph.nodes;
  let mergedNodes = priorMerged.nodes;
  if (graph.nodes.length > limits.MAX_NODES) {
    // 既有聚合节点（解析层溢出时留下的）折叠进新聚合：不参与排序、不产生第二个聚合节点
    const aggregates = graph.nodes.filter((n) => n.aggregate === true);
    const reals = graph.nodes
      .filter((n) => n.aggregate !== true)
      .sort((a, b) => b.file_count - a.file_count || a.id.localeCompare(b.id));
    const aggFiles = aggregates.reduce((n, a) => n + a.file_count, 0);
    const keepCount = Math.max(0, limits.MAX_NODES - 1);
    const kept = reals.slice(0, keepCount);
    const dropped = reals.slice(keepCount);
    mergedNodes = priorMerged.nodes + dropped.length;
    const totalTruncatedNodes = parseLayer.nodes + mergedNodes;
    const moreFiles = aggFiles + dropped.reduce((n, m) => n + m.file_count, 0);
    nodes = [
      ...kept,
      {
        id: MORE_NODE_ID,
        name: `还有 ${totalTruncatedNodes} 个`,
        path: "",
        blurb: `超出节点上限 ${limits.MAX_NODES}，聚合展示，共 ${moreFiles} 个文件`,
        kind: "mixed",
        file_count: moreFiles,
        aggregate: true,
      },
    ];
  }
  const keptIds = new Set(nodes.map((n) => n.id));

  // 边：端点被聚合（不在最终节点集）的重定向到 __more__（权重求和、去自环）→ 扇出过滤 → 边硬上限截断。
  // 聚合用嵌套 Map，不用分隔符拼键再 split（R1-ZS-002）。
  const redirect = (id: string) => (keptIds.has(id) ? id : MORE_NODE_ID);
  const edgeWeight = new Map<string, Map<string, number>>();
  for (const e of graph.edges) {
    const from = redirect(e.from);
    const to = redirect(e.to);
    if (from === to) continue;
    const row = edgeWeight.get(from) ?? new Map<string, number>();
    row.set(to, (row.get(to) ?? 0) + e.weight);
    edgeWeight.set(from, row);
  }
  let edges: GraphEdge[] = [];
  for (const [from, row] of edgeWeight) {
    for (const [to, weight] of row) edges.push({ from, to, weight });
  }
  edges.sort((a, b) => b.weight - a.weight || a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  const fanout = dropFanout(edges, limits);
  edges = fanout.edges;
  const newEdgeTrunc = Math.max(0, edges.length - limits.MAX_EDGES);
  if (newEdgeTrunc > 0) edges = edges.slice(0, limits.MAX_EDGES);

  const mergedLayer: TruncatedCounts = {
    nodes: mergedNodes,
    edges: priorMerged.edges + newEdgeTrunc,
    fanout: priorMerged.fanout + fanout.dropped,
  };
  return {
    ...graph,
    limits,
    nodes,
    edges,
    truncated: {
      nodes: parseLayer.nodes + mergedLayer.nodes,
      edges: parseLayer.edges + mergedLayer.edges,
      layers: { parse: parseLayer, merged: mergedLayer },
    },
  };
}

// ─────────────── §4.3 第 1 招的第二个落点：A4 下钻层的单枝子级硬上限 ───────────────
// 顶层（`buildSharedGraphFrom`）与下钻层（`capChildren`，A4 `expandDirectory` 调用）用的是同一招数、
// 同一份数值口径（config.ts 的 ARCH_LIMITS / MORE_NODE_ID），**实现也全仓只在这一个文件里**——
// 视图侧与 A4 都只是调用方，不各自再写一套截断（verify-f2 的源码级扫描就是这条红线）。

/** 下钻层子级硬上限的截断结果 */
export interface CappedChildren<T> {
  /** 保留的子级（未截断时 = 入参原序全部；截断时 = 前 limit-1 个） */
  kept: T[];
  /** 触发上限时要补的「还有 N 个」聚合节点（未触发为 null） */
  aggregate: { id: string; name: string; path: string; aggregate: true } | null;
  /** 被截断掉的子级数（0 = 未触发上限） */
  dropped: number;
  /** 本次生效的上限 */
  limit: number;
  truncated: boolean;
}

/**
 * A4 下钻层的子级硬上限（§4.3 第 1 招：JSON 层面就截断，超出部分不渲染，改「还有 N 个」聚合节点）。
 * 红线：截断是**入参顺序的前 limit-1 个**，被截断的那些**不遍历、不解析**——这正是巨枝
 * （实测一个 1.2 万文件的真实项目里 `.tmp` 有 294 个直接子级）能把耗时降下来的原因（§4.3 第 2 招：
 * 不展开的分支完全不计算）。因此聚合节点不带文件数：算它就得把整枝走一遍，等于把这招又拆了。
 *
 * @param children 已按渲染顺序排好的子级（A4 口径：子目录 → 文件，各自按名字升序）
 * @param parentId 父节点 id —— 聚合节点 id 带父级后缀（`<聚合 id>:<父 slug>`）：同一张图里可能
 *                 同时展开多个巨枝，聚合节点 id 必须唯一，否则 React Flow 的节点键会撞
 * @param limit    生效上限（缺省走 config.ts 数值口径；验证脚本可传小值构造夹具）
 */
export function capChildren<T extends { name: string }>(
  children: readonly T[],
  parentId: string,
  limit: number = ARCH_LIMITS.MAX_CHILDREN,
): CappedChildren<T> {
  if (children.length <= limit) {
    return { kept: [...children], aggregate: null, dropped: 0, limit, truncated: false };
  }
  const kept = children.slice(0, Math.max(0, limit - 1));
  const dropped = children.length - kept.length;
  return {
    kept: [...kept],
    aggregate: {
      id: `${MORE_NODE_ID}:${parentId}`,
      name: `还有 ${dropped} 个`,
      path: "",
      aggregate: true,
    },
    dropped,
    limit,
    truncated: true,
  };
}

// ───────────────────────── 视图选择器（§3.2「同一份数据的按模式取向」） ─────────────────────────

/** 视图要画的边：方向已按模式定（spec.edgeDirection）、色标已按模式定（spec.edgeColoring） */
export interface SelectedEdge {
  id: string;
  /** DEP_EDGE_DIRECTION 时 = 依赖方；DATA_FLOW_DIRECTION 时 = 数据提供者 */
  from: string;
  to: string;
  weight: number;
  /** 互惠对（A↔B 互相 import）归并后的双向标记（DATA_FLOW_EDGE_RULE.mutual_pair_flag） */
  bidirectional?: true;
  /** 边色角色（F3 取色值；null = 中性色 / 该模式不着色） */
  color_role: "flow_source" | "flow_relay" | null;
}

/** 视图要画的节点：共用节点集合**原样复用**（一个都不过滤），DATA_FLOW 额外带流向角色 */
export interface SelectedNode extends GraphNode {
  /** 流向角色（只 DATA_FLOW 有；节点色仍走 §4.2 四色，不因模式改色） */
  flow_role?: FlowRole;
}

/** 选择器统计（F2 验证脚本的 DoD 证据口径：E_view ⊆ E_ALL 的计数） */
export interface SelectionStats {
  /** 共用全量边集合条数 E_ALL */
  all_edges: number;
  /** 本视图边数 */
  view_edges: number;
  /** 剔自环条数（DATA_FLOW_EDGE_RULE 第 1 步；E_ALL 已无自环时恒 0，幂等兜底） */
  dropped_self_loop: number;
  /** 互惠对归并对数（第 2 步） */
  merged_mutual_pairs: number;
}

export interface SelectedGraph {
  mode: GraphMode;
  /** 该模式的口径表（方向 / 着色 / 权重映射出处），渲染器读它，不各自写一份 */
  spec: GraphModeSpec;
  /** 该视图要画的节点：MODULE_BOX / MIND_MAP = `shared.nodes` 同一数组引用（调用方只读，勿原地改）；
   *  DATA_FLOW = 带 `flow_role` 的新数组（id 集合与共用层完全相同，未过滤） */
  nodes: SelectedNode[];
  edges: SelectedEdge[];
  stats: SelectionStats;
}

const edgeKey = (from: string, to: string) => `${from}>${to}`;

/**
 * 选择器：输入模式，输出该视图要画的 `{nodes, edges}`（F2 DoD②）。
 * 节点集合三种模式完全相同（NODE_SET_RULE：同一份 shared.nodes，DATA_FLOW 只加 flow_role 字段）；
 * 边集合按 GRAPH_MODES[mode].edgeRule 取共用全量边集合的子集（E_view ⊆ E_ALL）：
 *   MODULE_BOX = 全量边原样（all_shared_edges，顺序保持 E_ALL，dagre 布局与 A3 时代逐字节一致）；
 *   DATA_FLOW  = 方向子集（directional_subset，规则见 DATA_FLOW_EDGE_RULE.steps）；
 *   MIND_MAP   = 层级父子边（hierarchy_parent_child，§3.2 表格第三行 / §3.3 可折叠树）。
 */
export function selectGraph(mode: GraphMode, shared: SharedGraph): SelectedGraph {
  const spec = GRAPH_MODES[mode];
  if (spec.edgeRule === "directional_subset") return selectDataFlow(shared);
  if (spec.edgeRule === "hierarchy_parent_child") {
    const edges = hierarchyEdges(shared.nodes);
    return {
      mode,
      spec,
      nodes: shared.nodes,
      edges,
      stats: { all_edges: shared.edges.length, view_edges: edges.length, dropped_self_loop: 0, merged_mutual_pairs: 0 },
    };
  }
  // all_shared_edges：全量依赖边原样画，方向与权重都保持共用层口径，边中性色（颜色留给节点四色）
  return {
    mode,
    spec,
    nodes: shared.nodes,
    edges: shared.edges.map((e) => ({ ...e, id: edgeKey(e.from, e.to), color_role: null })),
    stats: { all_edges: shared.edges.length, view_edges: shared.edges.length, dropped_self_loop: 0, merged_mutual_pairs: 0 },
  };
}

/** 过滤流水线里的一条边（依赖方向：from = 依赖方、to = 被依赖方） */
interface FlowStepEdge {
  from: string;
  to: string;
  weight: number;
  /** 互惠对归并标记（merge_mutual_pair 步产出） */
  bidirectional?: true;
}

type FlowStepName = (typeof DATA_FLOW_EDGE_RULE.steps)[number];

/** 三个过滤步骤的真实现；调用顺序由 DATA_FLOW_EDGE_RULE.steps 说了算（常量即口径，不是注释） */
const FLOW_STEPS: Record<
  FlowStepName,
  (edges: FlowStepEdge[], stats: SelectionStats) => FlowStepEdge[]
> = {
  /** 1) 自环不画（幂等兜底：共用层聚合时已剔过一次，此处防调用方喂坏数据） */
  drop_self_loop: (edges, stats) => {
    stats.dropped_self_loop = edges.filter((e) => e.from === e.to).length;
    return edges.filter((e) => e.from !== e.to);
  },
  /** 2) 互惠对（A→B 与 B→A 同时存在）归并为一条：权重求和 + 标 bidirectional，不画两条打架的箭头。
   *  归并后的方向取权重大的一侧作依赖方向（相等时取 id 小的一侧，与 E_ALL 排序口径一致）。 */
  merge_mutual_pair: (edges, stats) => {
    // 权重按 (from,to) 聚合，键走 pairKey（无歧义的内部索引）——不用 `from>to` 拼串再 split，
    // 否则 id 含 `>` 时端点会被切碎（R1-ZS-002 的同类写法，本文件内一并对齐）
    const weightOf = new Map<string, { from: string; to: string; weight: number }>();
    for (const e of edges) {
      const k = pairKey(e.from, e.to);
      const cur = weightOf.get(k);
      if (cur !== undefined) cur.weight += e.weight;
      else weightOf.set(k, { from: e.from, to: e.to, weight: e.weight });
    }
    const handled = new Set<string>();
    const out: FlowStepEdge[] = [];
    for (const [key, cur] of weightOf) {
      if (handled.has(key)) continue;
      const { from, to, weight } = cur;
      const rev = pairKey(to, from);
      const wRev = weightOf.get(rev)?.weight ?? 0;
      handled.add(key);
      const mutual = wRev > 0;
      if (mutual) {
        handled.add(rev);
        stats.merged_mutual_pairs++;
      }
      const flip = wRev > weight;
      out.push({
        from: flip ? to : from,
        to: flip ? from : to,
        weight: weight + wRev,
        ...(mutual ? { bidirectional: true as const } : {}),
      });
    }
    return out;
  },
  /** 3) 方向翻转为数据流向：提供者 → 消费者（DEP_EDGE_DIRECTION 的反向，见 DATA_FLOW_DIRECTION） */
  reverse_direction: (edges) => edges.map((e) => ({ ...e, from: e.to, to: e.from })),
};

/** DATA_FLOW 过滤/着色的产物（顶层全量边与 A4 下钻子级边共用同一份口径） */
export interface DataFlowEdgeSelection {
  edges: SelectedEdge[];
  stats: SelectionStats;
  /** 入参节点集合的流向角色（按**依赖方向**度数判，in = 被 import 次数）；不在边集合里的节点 = isolated */
  roles: ReadonlyMap<string, FlowRole>;
}

/**
 * DATA_FLOW 的边过滤/着色（照 DATA_FLOW_EDGE_RULE.steps 声明的顺序逐步施加，顺序换不得）：
 *   drop_self_loop → merge_mutual_pair → reverse_direction（实现即上面的 FLOW_STEPS）
 * 边色按**上游（数据提供者）**节点的流向角色（edgeColorRoleOf）；角色度数按依赖方向算
 * （in = 被 import 次数），不随渲染方向翻转（§4.3 第 3/4 招同一口径，见 EXPLOSION_CONTROL_STAGE）。
 * 输出仍是入参边集合的子集：把每条渲染边还原成依赖方向的边键，必落在入参边集合内。
 *
 * 边集合参数化（不是只吃 SharedGraph）的原因：F3 数据流向图还要画 **A4 下钻子级的边**
 * （`expand.ts` 的 `children[].deps`，同为依赖方向）。子级边走同一份实现——不另抄一套
 * 过滤/着色逻辑，否则顶层与子级两处口径迟早分叉（F1 跑偏点的同一类问题）。
 */
export function selectDataFlowEdges(
  edges: GraphEdge[],
  nodeIds: readonly string[],
): DataFlowEdgeSelection {
  const stats: SelectionStats = {
    all_edges: edges.length,
    view_edges: 0,
    dropped_self_loop: 0,
    merged_mutual_pairs: 0,
  };

  // ── 流向角色：按依赖方向度数判（in = 被 import 次数 = 供数据给别人）──
  const inDeg = new Map<string, number>();
  const outDeg = new Map<string, number>();
  for (const e of edges) {
    if (e.from === e.to) continue;
    outDeg.set(e.from, (outDeg.get(e.from) ?? 0) + 1);
    inDeg.set(e.to, (inDeg.get(e.to) ?? 0) + 1);
  }
  const roles = new Map<string, FlowRole>();
  for (const id of nodeIds) roles.set(id, flowRoleOf(inDeg.get(id) ?? 0, outDeg.get(id) ?? 0));
  // 边的端点未必都在 nodeIds 里（调用方只传本次要渲染的节点），缺的按同一口径现算
  const roleOf = (id: string) => roles.get(id) ?? flowRoleOf(inDeg.get(id) ?? 0, outDeg.get(id) ?? 0);

  // ── 按 DATA_FLOW_EDGE_RULE.steps 的顺序逐步过滤（顺序换不得：先归并再翻转）──
  let stepped: FlowStepEdge[] = edges.map((e) => ({
    from: e.from,
    to: e.to,
    weight: e.weight,
  }));
  for (const step of DATA_FLOW_EDGE_RULE.steps) stepped = FLOW_STEPS[step](stepped, stats);

  const out: SelectedEdge[] = stepped.map((e) => ({
    id: edgeKey(e.from, e.to),
    from: e.from,
    to: e.to,
    weight: e.weight,
    ...(e.bidirectional ? { bidirectional: true as const } : {}),
    color_role: edgeColorRoleOf(roleOf(e.from)), // 上游 = 渲染方向起点 = 数据提供者
  }));
  // 渲染顺序确定化（与 E_ALL 同口径：权重降序 → id 升序），保证重渲染边序稳定
  out.sort(
    (a, b) => b.weight - a.weight || a.from.localeCompare(b.from) || a.to.localeCompare(b.to),
  );
  stats.view_edges = out.length;
  return { edges: out, stats, roles };
}

/** DATA_FLOW 模式的选择：节点集合原样复用（只加 flow_role 字段），边走上表的过滤/着色 */
function selectDataFlow(shared: SharedGraph): SelectedGraph {
  const spec = GRAPH_MODES.DATA_FLOW;
  const { edges, stats, roles } = selectDataFlowEdges(shared.edges, shared.nodes.map((n) => n.id));
  const nodes: SelectedNode[] = shared.nodes.map((n) => ({
    ...n,
    flow_role: roles.get(n.id) ?? "isolated",
  }));
  return { mode: "DATA_FLOW", spec, nodes, edges, stats };
}

/**
 * MIND_MAP 的边（§3.2 表格第三行「层级结构一览」/ §3.3 可折叠树）：层级父子边。
 * 父 = 本节点路径的**最近祖先目录节点**——只在同一份共用节点集合里找路径包含关系，
 * 不另扫目录、不新建数据源；层级边不表达依赖强度（GRAPH_MODES.MIND_MAP.weightScale = null），
 * weight 恒 1。模块路径不是单一目录的（聚合模块 path 是被合并路径清单）不参与。
 * 更深的层级（子模块 → 文件）用同一份 A4 下钻结果（expand.ts），不在本层重复解析。
 */
function hierarchyEdges(nodes: GraphNode[]): SelectedEdge[] {
  const isModulePath = (p: string) => p !== "" && p !== "." && !p.includes(",");
  const idOfPath = new Map(
    nodes.filter((n) => !n.aggregate && isModulePath(n.path)).map((n) => [n.path, n.id]),
  );
  const edges: SelectedEdge[] = [];
  for (const n of nodes) {
    if (n.aggregate || !isModulePath(n.path)) continue;
    let cur = n.path;
    for (;;) {
      const idx = cur.lastIndexOf("/");
      if (idx <= 0) break;
      cur = cur.slice(0, idx);
      const parentId = idOfPath.get(cur);
      if (parentId !== undefined) {
        edges.push({ id: edgeKey(parentId, n.id), from: parentId, to: n.id, weight: 1, color_role: null });
        break;
      }
    }
  }
  return edges.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
}

// ═════════════════ V06-05：规划层的**唯一合并点**（DESIGN.md §3.2 / §4.1 / §4.7）═════════════════
// 与聊天补全层（arch/supplement.ts 的 mergeSupplement）同一套分层做法，理由也一样：
//   · 规划图是**独立派生管线**（`.工作台/arch/blueprint.json`），静态解析层（modules.json）与
//     聊天补全层（supplement.json）各自的原写口**一个字节都不改**（§4.1 末段：新规划图不覆写它们）；
//   · 「三视图共用同一份数据」的红线靠**合并点唯一**保住：全仓只有本函数把规划层并进共用数据层，
//     视图照旧只能从这份合并集里取子集（graph-mode.ts 的 NODE_SET_RULE 语义不变）。
// 入参是**结构化**的（不 import blueprint.ts）：本文件要同时被浏览器与服务端引同一份实现，
// 运行时 import 只能有 config/graph-mode（verify-f2 的源码级扫描就在钉这一条），
// 所以这里只认形状——blueprint.ts 的 PlanLayerInput 天然满足。
//
// 合并口径（三条，逐条对应 §4.1/§4.2/§4.5）：
//   ① 规划节点已经对应到实测模块（code_module_ids 命中共用层节点 id）→ **不新建节点**，
//      把规划 id 记到那个静态节点的 `plan_refs` 上（实测映射用稳定关系连接，不复制一份）；
//   ② 规划节点还没有实现 → 追加 `plan_origin:"plan"` 的灰节点（§4.2「灰：已规划，未开始」），
//      file_count 为 0、path 为空（没有可下钻的子树，不假装有）；
//   ③ 规划关系 → 带 `origin:"plan"` 的边：端点按上面的映射落到共用层节点上；
//      端点解析不到（规划 id 打错）**直接丢弃**，不造悬空边（§4.1：端点存在是发布前提）。

/** 规划层的一个节点（结构化入参：`Blueprint` 节点经 `planningLayerInput()` 转换后天然满足） */
export interface PlanLayerNode {
  id: string;
  name: string;
  /** 规划节点 kind（capability/module/task/concept）：只作展示说明，不映射到 ModuleKind */
  kind: string;
  /** 该规划对象对应的实测代码模块 id（空数组 = 还没实现） */
  code_module_ids: string[];
}

/** 规划层的一条关系 */
export interface PlanLayerEdge {
  source: string;
  target: string;
  kind: string;
  certainty: string;
}

export interface PlanLayerInput {
  baseline_id: string | null;
  nodes: PlanLayerNode[];
  edges: PlanLayerEdge[];
}

/** 规划节点没有实测模块可挂时的兜底 kind（MODULE_KINDS 里"说不清或混合"，不假装是 code） */
const PLAN_FALLBACK_KIND: ModuleKind = "mixed";

/**
 * 把规划层并进共用数据层（唯一合并点，见上面三条口径）。
 * 纯函数、零 IO、零新 import：入参是已经读好的两份数据，返回一份新的共用数据层。
 */
export function mergePlanningLayer(graph: SharedGraph, layer: PlanLayerInput): SharedGraph {
  const staticIds = new Set(graph.nodes.map((n) => n.id));
  // planId → 共用层节点 id（命中实测模块就复用那个节点；否则用新建的灰节点）
  const resolve = new Map<string, string>();
  const appended: GraphNode[] = [];
  for (const n of layer.nodes) {
    if (resolve.has(n.id)) continue;
    const hit = n.code_module_ids.find((id) => staticIds.has(id));
    if (hit !== undefined) {
      resolve.set(n.id, hit);
      continue;
    }
    const newId = n.id;
    resolve.set(n.id, newId);
    appended.push({
      id: newId,
      name: n.name,
      path: "",
      blurb: `规划层（${n.kind}）：来自审定图纸派生，尚无实测代码对应`,
      kind: PLAN_FALLBACK_KIND,
      file_count: 0,
      plan_origin: "plan",
    });
  }

  // 静态节点挂上规划 id（原数组不动：调用方只读口径与 selectGraph 一致）
  const planRefs = new Map<string, string[]>();
  for (const n of layer.nodes) {
    const target = resolve.get(n.id);
    if (target === undefined) continue;
    if (!staticIds.has(target)) continue; // 新追加的灰节点自己就是规划节点，不需要 plan_refs
    const arr = planRefs.get(target) ?? [];
    if (!arr.includes(n.id)) arr.push(n.id);
    planRefs.set(target, arr);
  }
  const nodes: GraphNode[] = [
    ...graph.nodes.map((n) => {
      const refs = planRefs.get(n.id);
      if (refs === undefined) return n;
      return { ...n, plan_refs: [...(n.plan_refs ?? []), ...refs.filter((r) => !(n.plan_refs ?? []).includes(r))] };
    }),
    ...appended,
  ];

  const known = new Set(nodes.map((n) => n.id));
  // 端点对去重用 pairKey（无歧义的内部索引）：id 可含 `>` 等分隔符，裸拼串会把两对不同端点误判成同一对
  const seen = new Set(graph.edges.map((e) => pairKey(e.from, e.to)));
  const edges: GraphEdge[] = [...graph.edges];
  for (const e of layer.edges) {
    const from = resolve.get(e.source);
    const to = resolve.get(e.target);
    if (from === undefined || to === undefined || from === to) continue; // 悬空/自环：不造边
    if (!known.has(from) || !known.has(to)) continue;
    const key = pairKey(from, to);
    if (seen.has(key)) continue; // 同一对节点已有静态边：不重复画（规划关系不改变静态依赖口径）
    seen.add(key);
    edges.push({ from, to, weight: 1, origin: "plan" });
  }

  return { ...graph, nodes, edges };
}
