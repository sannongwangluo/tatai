// V09-22 返工（契约 1／3）：**未聚合并集取回** `archItemsOf` ＋ 无上限构建缓存 `unlimitedGraphOf`。
//
// 要解决的问题：六图的概览/全量两档都有"安全上限"（ARCH_LIMITS / RENDER_FULL / MCP_FULL），
// 超限的节点/边被聚合成「还有 N 个」——**看得到却取不回**。本模块提供"上限外逐项可取"的读口：
//   ① `unlimitedGraphOf`：与 `/arch/render` 同一 builder 管线（readModules → buildSharedGraphFrom
//      → mergeSupplement），但上限用 `ARCH_UNLIMITED_LIMITS`（五维全 1e9，builder 不聚合/不截断/
//      不扇出过滤）→ 节点/边就是**未聚合并集**真值。带内容哈希缓存（见下），供 `sixGraphsOf`
//      的 mode=full 复用，避免分页遍历每页重读盘重合成。2026-09-29 返工（F2）把 names.json/progress.json
//      纳入指纹，缓存键与快照身份同口径。
//   ② `archItemsOf`：按 kind=nodes/edges 在未聚合并集上做「先过滤后开窗」的稳定分页，逐项取回。
//
// 只读：不写盘、不调模型、不给纳管项目加运行时埋点。缓存只存内存、进程内有效、按内容哈希失效。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { getProject } from "../server/registry";
import { readProgress, WsError, workstationDir } from "../server/workstation";
import { ARCH_UNLIMITED_LIMITS } from "./config";
import { readNames } from "./name";
import { readModules } from "./parse";
import { buildSharedGraphFrom, type GraphEdge, type GraphNode, type SharedGraph } from "./shared-graph";
import { mergeSupplement, readSupplement } from "./supplement";

/** 与 render 同构的节点/边类型（`shared-graph.ts` 的 GraphNode / GraphEdge）：凡 builder 给的字段都带。
 *  契约里写作 `SharedModuleNode` / `SharedGraphEdge`，此处给别名，避免调用方认不出与共用层是同一份。 */
export type SharedModuleNode = GraphNode;
export type SharedGraphEdge = GraphEdge;

// ───────────────────────────── 内容指纹（快照身份与缓存键共用） ─────────────────────────────

/** sha256 十六进制（blueprint.ts 里同名助手是私有的，这里按"或 node:crypto"口径自持一份，
 *  不为了复用去改 blueprint.ts 的可见性）。 */
export function sha256Hex(data: string | Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

/** 文件内容 sha256；文件不存在/读不动记 `"none"`（不是错误——空态与旧工程都合法）。 */
export function fileContentShaOrNone(absPath: string): string {
  try {
    return sha256Hex(fs.readFileSync(absPath));
  } catch {
    return "none";
  }
}

/** 未聚合并集的实际输入指纹：modules.json / supplement.json / names.json / progress.json 四份**文件内容** sha256
 *  （读不到 `"none"`）。快照身份（契约 5）与无上限构建缓存键（契约 1）读的是同一份口径，不各算一套。
 *  V09-22 返工（F2，2026-09-29）：names.json 与 progress.json 也是 buildUnlimitedGraph 的实际输入
 *  （模块人话名/兼容状态上屏）——漏进指纹会出现「改名后 overview 新名、full/items 旧名」的同进程分叉，
 *  且快照标识不随改名变化；四份输入一并入指纹。 */
export function graphInputSha(
  projectId: string,
  dataDir?: string,
): { modulesSha: string; supplementSha: string; namesSha: string; progressSha: string } {
  const project = getProject(projectId, dataDir);
  if (!project) throw new WsError("PROJECT_NOT_FOUND", `项目不存在: ${projectId}`);
  // progress.json 由 readProgress **懒建**（首次读会落初始文件，本管线后续构建本来就会触发）：
  // 先让它落定再算指纹——否则「首次调用的快照/缓存键用 "none"、第二次用真实内容」会漂，
  // 同输出两个快照 id、分页游标被误判成另一份快照（V09-22 返工实测的首次读取漂移）。
  try {
    readProgress(projectId, dataDir);
  } catch {
    // 读不动（权限/结构非法）：按盘上现状算（可能 "none"），不阻断指纹
  }
  return {
    modulesSha: fileContentShaOrNone(path.join(project.path, ".工作台", "arch", "modules.json")),
    supplementSha: fileContentShaOrNone(path.join(workstationDir(projectId, dataDir), "arch", "supplement.json")),
    namesSha: fileContentShaOrNone(path.join(project.path, ".工作台", "arch", "names.json")),
    progressSha: fileContentShaOrNone(path.join(workstationDir(projectId, dataDir), "progress.json")),
  };
}

// ───────────────────────────── 无上限构建缓存（契约 1／3 复用） ─────────────────────────────

/** 无上限构建缓存容量：超出逐**最旧**插入清除（FIFO；Map 保持插入序，命中不重排）。 */
const UNLIMITED_CACHE_LIMIT = 8;
const unlimitedCache = new Map<string, SharedGraph>();

/** 按 `/arch/render` 同一 builder 管线合成**未聚合并集**（无上限），与项目 id 解耦的内部核。 */
function buildUnlimitedGraph(projectId: string, projectPath: string, dataDir?: string): SharedGraph {
  const { exists, arch } = readModules(projectId, dataDir);
  // 未解析过（与 render 的 {exists:false} 空态同口径）：给一份空的无上限图顶住，不抛
  if (!exists || !arch) return buildSharedGraphFrom([], {}, new Map(), ARCH_UNLIMITED_LIMITS, null);
  const names = readNames(projectPath);
  const statusById = new Map<string, string>();
  try {
    for (const m of readProgress(projectId, dataDir).modules) statusById.set(m.id, m.status);
  } catch {
    // progress 不可读时省略 status 字段（与 render 同口径，不阻塞）
  }
  const g = buildSharedGraphFrom(arch.modules, names.entries, statusById, ARCH_UNLIMITED_LIMITS, arch.budget_exhausted ?? null);
  try {
    const sup = readSupplement(projectId, dataDir);
    if (sup === null) return g;
    // 补全层并入：无上限组下 capMergedGraph 是恒等短路（五维都 1e9），故不再多收一遍（与 render 等效）
    return mergeSupplement(g, sup);
  } catch {
    return g; // 补全层损坏：照常出解析层无上限图（与 render 的容错同口径）
  }
}

/**
 * 未聚合并集构建（**契约 1 的缓存构建函数**；`sixGraphsOf` 的 mode=full 与 `archItemsOf` 复用同一份）。
 * 缓存键 = `${projectId}:${modulesSha}:${supplementSha}:${namesSha}:${progressSha}`——
 * modules/supplement/names/progress 四份输入的文件内容 sha256（读不到 `"none"`）：
 * 输入内容一变键就变、旧结果自然失效（无 TTL、无脏读）；容量 8，超出逐最旧清除。
 * V09-22 返工（F2，2026-09-29）：names/progress 是 buildUnlimitedGraph 的实际输入
 * （模块人话名/兼容状态上屏），改名或状态变化即失效。
 * 需要并入规划层（主/技术视图的完整口径）由调用方再 `mergePlanningLayer`，本函数只给静态＋补全层。
 */
export function unlimitedGraphOf(projectId: string, dataDir?: string): SharedGraph {
  const project = getProject(projectId, dataDir);
  if (!project) throw new WsError("PROJECT_NOT_FOUND", `项目不存在: ${projectId}`);
  const { modulesSha, supplementSha, namesSha, progressSha } = graphInputSha(projectId, dataDir);
  const key = `${projectId}:${modulesSha}:${supplementSha}:${namesSha}:${progressSha}`;
  const hit = unlimitedCache.get(key);
  if (hit !== undefined) return hit;
  const graph = buildUnlimitedGraph(projectId, project.path, dataDir);
  if (unlimitedCache.size >= UNLIMITED_CACHE_LIMIT) {
    const oldest = unlimitedCache.keys().next().value;
    if (oldest !== undefined) unlimitedCache.delete(oldest);
  }
  unlimitedCache.set(key, graph);
  return graph;
}

// ───────────────────────────── 未聚合并集取回（契约 1） ─────────────────────────────

export interface ArchItemsQuery {
  dataDir?: string;
  kind: "nodes" | "edges";
  /** 大小写不敏感子串：节点匹配 id/name/path；边匹配 from/to（共用层的聚合边没有 kind 字段） */
  q?: string;
  /** 缺省 0；负数/非整数按 400 口径报错（与项目其他路由的 `nonNegParam` 一致） */
  offset?: number;
  /** 缺省 200、clamp 到 [1,2000] */
  limit?: number;
}

export interface ArchItemsResult {
  /** 过滤后总数（先过滤后开窗） */
  total: number;
  offset: number;
  /** 本页实际返回条数 */
  returned: number;
  /** N + returned < total */
  has_more: boolean;
  nodes?: SharedModuleNode[];
  edges?: SharedGraphEdge[];
}

const ITEMS_DEFAULT_LIMIT = 200;
const ITEMS_MAX_LIMIT = 2000;

const clampLimit = (limit: number | undefined): number => {
  if (limit === undefined || !Number.isFinite(limit)) return ITEMS_DEFAULT_LIMIT;
  return Math.min(ITEMS_MAX_LIMIT, Math.max(1, Math.floor(limit)));
};

const nodeMatches = (n: GraphNode, q: string): boolean =>
  n.id.toLowerCase().includes(q) || n.name.toLowerCase().includes(q) || n.path.toLowerCase().includes(q);

const edgeMatches = (e: GraphEdge, q: string): boolean =>
  e.from.toLowerCase().includes(q) || e.to.toLowerCase().includes(q);

/**
 * 未聚合并集逐项取回（契约 1）：与 `/arch/render` 同一 builder 管线、无上限组构建，
 * **先过滤后开窗**——`q` 先过滤出全集，`total` = 过滤后总数，再取 `[offset, offset+limit)` 窗口。
 * 节点序 = builder 既有确定性序（file_count 降序、id 升序）；边序 = 权重降序、from/to 升序。
 * `kind` 必填；`offset` 负数/非整数报 `INVALID_INPUT`（与项目其他路由同一 400 口径）。
 */
export function archItemsOf(projectId: string, opts: ArchItemsQuery): ArchItemsResult {
  const graph = unlimitedGraphOf(projectId, opts.dataDir);
  const offset = opts.offset ?? 0;
  if (!Number.isInteger(offset) || offset < 0) {
    throw new WsError("INVALID_INPUT", `offset 必须是非负整数: ${JSON.stringify(opts.offset)}`);
  }
  const limit = clampLimit(opts.limit);
  const q = (opts.q ?? "").trim().toLowerCase();

  const source: (GraphNode | GraphEdge)[] =
    opts.kind === "edges"
      ? q === ""
        ? graph.edges
        : graph.edges.filter((e) => edgeMatches(e, q))
      : q === ""
        ? graph.nodes
        : graph.nodes.filter((n) => nodeMatches(n, q));

  const total = source.length;
  const start = Math.min(offset, total);
  const page = source.slice(start, start + limit);
  const base = { total, offset, returned: page.length, has_more: start + page.length < total };
  return opts.kind === "edges"
    ? { ...base, edges: page as GraphEdge[] }
    : { ...base, nodes: page as GraphNode[] };
}
