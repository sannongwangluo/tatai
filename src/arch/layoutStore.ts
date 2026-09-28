// A4：布局记忆（DESIGN.md §4.4：记住布局位置不跳动——新节点补空白处、已有节点保持原位）。
// 存 <项目根>/.工作台/arch/layout.json：`{version:2, positions:{<视图>:{<nodeId>:{x,y}}}}`。
// 前端拖动节点后 debounce 写回（PUT 按视图合并写）；刷新/重开按本文件复原（§4.4）。
// F4：**按视图分键**（PLAN F4 DoD②）。同一模块在两图里的 dagre 兜底位置本就不同（方框图按依赖方向
// 分层、数据流向图按数据流向分层），共用一份坐标必然导致切视图跳位——那是 F4 卡写明的跑偏点，
// 因此两视图各存各的坐标，互不覆盖。
// 兼容读 v1 旧结构 `{version:1, positions:{<nodeId>:{x,y}}}`：旧结构没有视图维度，按"当时只有
// 方框图"的事实把旧坐标归给 MODULE_BOX，并**原子写回**升级成 v2（临时文件 + rename 替换），
// 用户已拖过的位置一条不丢。迁移只在读到 v1 文件时发生，缺文件仍是空态不落盘。
// 纯本地零 LLM；损坏不报 500，按可读错误处理（WsError → 400）。
import fs from "node:fs";
import path from "node:path";
import { GRAPH_MODES, PROJECT_ARCH_LAYOUT_KEY, type GraphMode } from "./graph-mode";
import { getProject } from "../server/registry";
import { WsError } from "../server/workstation";

export interface NodePosition {
  x: number;
  y: number;
}

/** 旧结构里旧坐标的归属视图：v1 时代只有方框图（§3.2 前两行的第二个视图是 F3 才落地的） */
export const LAYOUT_MIGRATION_MODE: GraphMode = "MODULE_BOX";

// V09-21 R3：主视图「系统架构」的独立布局桶键 PROJECT_ARCH_LAYOUT_KEY 的**唯一出处**是
// ./graph-mode（同构常量模块；本文件引 node:fs，UI 侧不能引本文件，只能引那边）。

/** 磁盘结构（v2）：positions 的第一层键是视图模式（LAYOUT_MODES），第二层是节点 id */
export interface ArchLayoutFile {
  version: 2;
  positions: Record<string, Record<string, NodePosition>>;
}

const layoutJsonPath = (root: string) => path.join(root, ".工作台", "arch", "layout.json");

/** 视图键是否合法（PUT 的入参来自 HTTP，是外部输入）。GRAPH_MODES 之外放行主视图架构的独立桶
 *  （PROJECT_ARCH_LAYOUT_KEY，见该常量注释）——它没有数据视图模式，但有自己的布局记忆。 */
export function isLayoutMode(mode: unknown): mode is GraphMode | typeof PROJECT_ARCH_LAYOUT_KEY {
  return (
    (typeof mode === "string" && Object.prototype.hasOwnProperty.call(GRAPH_MODES, mode)) ||
    mode === PROJECT_ARCH_LAYOUT_KEY
  );
}

/** 坐标集合校验：{nodeId:{x,y}}，坐标必须是有限数值 */
function assertPositions(value: unknown, where: string): Record<string, NodePosition> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WsError("INVALID_INPUT", `${where} 必须是 {nodeId:{x,y}} 对象`);
  }
  for (const [id, p] of Object.entries(value as Record<string, unknown>)) {
    const pos = p as Partial<NodePosition> | null;
    if (id === "" || !pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) {
      throw new WsError("INVALID_INPUT", `坐标非法: ${id}=${JSON.stringify(p)}`);
    }
  }
  return value as Record<string, NodePosition>;
}

/** 原子落盘：同目录临时文件 + rename 替换（迁移写回不能写出半个文件） */
function writeLayoutAtomic(source: string, file: ArchLayoutFile): void {
  fs.mkdirSync(path.dirname(source), { recursive: true });
  const tmp = `${source}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(file, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, source);
}

/**
 * 读布局记忆（按项目根，与项目 id 解耦，便于临时目录验证）；不存在 → 空 positions（200 空态）。
 * 读到 v1 旧结构时在内存里迁移成 v2 并原子写回（迁移是幂等的：写回失败也不丢坐标，
 * 下次读同一份 v1 文件会再迁一次）。
 * `migrate: false`（2026-09-18 审计 Q18）→ **只做内存迁移、不写盘**：读接口由远程只读来源打进来时
 * 不能产生写盘副作用（注册表移除后 `remote-routes.ts` 把 GET /arch/layout 归为 `kind:"read"`，
 * 只读红线放行读方法，迁移写回就成了"读接口偷偷写盘"）。返回结构与写盘版逐字相同。
 */
export function readLayoutByRoot(root: string, opts: { migrate?: boolean } = {}): ArchLayoutFile {
  const source = layoutJsonPath(root);
  if (!fs.existsSync(source)) return { version: 2, positions: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(source, "utf8")) as {
      version?: unknown;
      positions?: unknown;
    };
    if (raw.positions === null || typeof raw.positions !== "object") {
      throw new Error("positions 结构不符");
    }
    // ── v1 旧结构：{version:1, positions:{nodeId:{x,y}}} → 旧坐标归 MODULE_BOX，原子写回 v2 ──
    if (raw.version === 1) {
      const legacy = assertPositions(raw.positions, "v1 positions");
      const migrated: ArchLayoutFile = {
        version: 2,
        positions: Object.keys(legacy).length > 0 ? { [LAYOUT_MIGRATION_MODE]: legacy } : {},
      };
      if (opts.migrate === false) return migrated;
      try {
        writeLayoutAtomic(source, migrated);
      } catch {
        // 写回失败（目录只读等）不打断读取：本次仍按迁移结果返回，文件里的 v1 坐标没被破坏
      }
      return migrated;
    }
    if (raw.version !== 2) throw new Error(`version ${String(raw.version)} 不支持`);
    const positions: Record<string, Record<string, NodePosition>> = {};
    for (const [mode, value] of Object.entries(raw.positions as Record<string, unknown>)) {
      if (!isLayoutMode(mode)) throw new Error(`视图键非法: ${mode}`);
      positions[mode] = assertPositions(value, `positions.${mode}`);
    }
    return { version: 2, positions };
  } catch (e) {
    throw new WsError("INVALID_INPUT", `layout.json 损坏: ${(e as Error).message}`);
  }
}

/**
 * 合并写回某个视图的布局记忆（§4.4：已有节点保持原位，只覆盖本次上报的节点坐标）。
 * 只动 `positions[mode]` 这一层，其它视图的坐标原样保留（F4 DoD②：两视图互不覆盖）。
 * 返回合并后的全量文件与落盘路径。
 */
export function savePositionsByRoot(
  root: string,
  positions: Record<string, NodePosition>,
  mode: GraphMode | typeof PROJECT_ARCH_LAYOUT_KEY = LAYOUT_MIGRATION_MODE,
): { file: ArchLayoutFile; source: string } {
  if (!isLayoutMode(mode)) throw new WsError("INVALID_INPUT", `视图键非法: ${String(mode)}`);
  const reported = assertPositions(positions, "positions");
  const current = readLayoutByRoot(root);
  const merged: ArchLayoutFile = {
    version: 2,
    positions: {
      ...current.positions,
      [mode]: { ...(current.positions[mode] ?? {}), ...reported },
    },
  };
  const source = layoutJsonPath(root);
  writeLayoutAtomic(source, merged);
  return { file: merged, source };
}

/** 按注册表项目 id 读（HTTP 路由入口；路径只走注册表）；`opts.migrate:false` = 只内存迁移不写盘（Q18） */
export function readLayout(
  projectId: string,
  dataDir?: string,
  opts: { migrate?: boolean } = {},
): ArchLayoutFile {
  const project = getProject(projectId, dataDir);
  if (!project) throw new WsError("PROJECT_NOT_FOUND", `项目不存在: ${projectId}`);
  return readLayoutByRoot(project.path, opts);
}

/** 按注册表项目 id 按视图合并写（HTTP 路由入口） */
export function savePositions(
  projectId: string,
  positions: Record<string, NodePosition>,
  mode: GraphMode | typeof PROJECT_ARCH_LAYOUT_KEY = LAYOUT_MIGRATION_MODE,
  dataDir?: string,
): { file: ArchLayoutFile; source: string } {
  const project = getProject(projectId, dataDir);
  if (!project) throw new WsError("PROJECT_NOT_FOUND", `项目不存在: ${projectId}`);
  return savePositionsByRoot(project.path, positions, mode);
}
