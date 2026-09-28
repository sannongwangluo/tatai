// N2：思维导图的折叠状态记忆（PLAN N2 DoD④「同一项目内刷新后折叠状态保持」）。
// 存 <项目根>/.工作台/arch/mindmap-fold.json：`{version:1, projects:{<项目 id>:{expanded:[{id,path}]}}}`。
//
// 为什么单独一个文件、而不是并进 `layout.json`（§4.4 布局记忆）：
//   layout.json 记的是**坐标**，按视图分键（F4 口径），由画布拖动 debounce 写回；
//   折叠态是**拓扑可见性**，只有思维导图有（方框图的下钻折叠态是会话级的，A4 起就没落盘），
//   两者写入时机、键空间、语义都不同——并在一起会让"拖动一次"或"折叠一次"互相触发整份文件重写，
//   还得给 layout 的 v2 结构再套一层。理由与 F4「按视图分键」同源：不同语义的状态不共用一份键空间。
// 为什么按**项目 id 再嵌一层**：文件本身已按项目根存放（一项目一份），这一层是为了让"折叠态属于哪个
// 项目"在文件里也显式（PLAN N2 口径：按项目 + 节点 id 记展开态），且日后若把多项目状态并成一份文件
// 不用改结构。读的时候只认自己那份：文件里的项目键与注册表 id 对不上就返回空（不猜、不串台）。
// 存的是 `{id, path}` 而不是光 id：展开态恢复时要用 path 重新走一次 A4（节点 id 是路径 slug，
// 但服务端接口吃的是路径）——恢复**只补拉上次展开过的那几枝**，不是全量（§4.3 第 2 招）。
// 原子落盘（临时文件 + rename）与读损坏处理照 layoutStore.ts 同一套写法。
import fs from "node:fs";
import path from "node:path";
import { getProject } from "../server/registry";
import { WsError } from "../server/workstation";

/** 一条展开态：节点 id（回查树）+ 节点路径（恢复时重新走 A4 的入参） */
export interface MindMapExpandEntry {
  id: string;
  path: string;
}

export interface MindMapFoldFile {
  version: 1;
  /** 项目 id → 该项目已展开的节点清单（顺序 = 展开顺序，父在子先，恢复时按序补拉） */
  projects: Record<string, { expanded: MindMapExpandEntry[] }>;
}

const foldJsonPath = (root: string) => path.join(root, ".工作台", "arch", "mindmap-fold.json");

/** 展开态清单校验（PUT 的入参来自 HTTP，是外部输入） */
function assertEntries(value: unknown, where: string): MindMapExpandEntry[] {
  if (!Array.isArray(value)) throw new WsError("INVALID_INPUT", `${where} 必须是 [{id,path}] 数组`);
  const out: MindMapExpandEntry[] = [];
  for (const item of value) {
    const e = item as Partial<MindMapExpandEntry> | null;
    if (!e || typeof e.id !== "string" || e.id === "" || typeof e.path !== "string" || e.path === "") {
      throw new WsError("INVALID_INPUT", `${where} 条目不合法: ${JSON.stringify(item)}`);
    }
    out.push({ id: e.id, path: e.path });
  }
  return out;
}

/** 原子落盘：同目录临时文件 + rename 替换（不能写出半个文件） */
function writeFoldAtomic(source: string, file: MindMapFoldFile): void {
  fs.mkdirSync(path.dirname(source), { recursive: true });
  const tmp = `${source}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(file, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, source);
}

/**
 * 读整份折叠态记忆（按项目根，与项目 id 解耦，便于临时目录验证）；不存在 → 空 projects（200 空态）。
 * 文件损坏抛 WsError（同 layoutStore：损坏按可读错误处理，不静默吞）——界面侧按空态兜底（默认全折叠）。
 */
export function readFoldFileByRoot(root: string): MindMapFoldFile {
  const source = foldJsonPath(root);
  if (!fs.existsSync(source)) return { version: 1, projects: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(source, "utf8")) as { version?: unknown; projects?: unknown };
    if (raw.version !== 1) throw new Error(`version ${String(raw.version)} 不支持`);
    if (raw.projects === null || typeof raw.projects !== "object" || Array.isArray(raw.projects)) {
      throw new Error("projects 结构不符");
    }
    const projects: MindMapFoldFile["projects"] = {};
    for (const [id, value] of Object.entries(raw.projects as Record<string, unknown>)) {
      const expanded = (value as { expanded?: unknown } | null)?.expanded;
      projects[id] = { expanded: assertEntries(expanded ?? [], `projects.${id}.expanded`) };
    }
    return { version: 1, projects };
  } catch (e) {
    throw new WsError("INVALID_INPUT", `mindmap-fold.json 损坏: ${(e as Error).message}`);
  }
}

/** 读某个项目的展开态（缺该项目的键 → 空数组 = 默认全折叠，§3.3 规则 5） */
export function readFoldByRoot(root: string, projectId: string): MindMapExpandEntry[] {
  return readFoldFileByRoot(root).projects[projectId]?.expanded ?? [];
}

/** 写某个项目的展开态（只动自己那一份，其它项目的键原样保留）；返回落盘后的全量文件与路径 */
export function saveFoldByRoot(
  root: string,
  projectId: string,
  expanded: unknown,
): { file: MindMapFoldFile; source: string } {
  const entries = assertEntries(expanded, "expanded");
  const current = readFoldFileByRoot(root);
  const file: MindMapFoldFile = {
    version: 1,
    projects: { ...current.projects, [projectId]: { expanded: entries } },
  };
  const source = foldJsonPath(root);
  writeFoldAtomic(source, file);
  return { file, source };
}

/** 按注册表项目 id 读（HTTP 路由入口；路径只走注册表） */
export function readFold(projectId: string, dataDir?: string): MindMapExpandEntry[] {
  const project = getProject(projectId, dataDir);
  if (!project) throw new WsError("PROJECT_NOT_FOUND", `项目不存在: ${projectId}`);
  return readFoldByRoot(project.path, projectId);
}

/** 按注册表项目 id 写（HTTP 路由入口） */
export function saveFold(
  projectId: string,
  expanded: unknown,
  dataDir?: string,
): { file: MindMapFoldFile; source: string } {
  const project = getProject(projectId, dataDir);
  if (!project) throw new WsError("PROJECT_NOT_FOUND", `项目不存在: ${projectId}`);
  return saveFoldByRoot(project.path, projectId, expanded);
}
