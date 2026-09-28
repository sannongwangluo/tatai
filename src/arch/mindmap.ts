// N1：思维导图（DESIGN.md §3.2 三视图第三行「层级结构一览，适合快速总览与折叠」）的
// **取数 + markdown 导出**纯模块（markmap 渲染在 `src/ui/arch/MindMapView.tsx`）。
//
// 红线（PLAN N1 跑偏点：不许把 markmap 当"另起炉灶的独立树"自己再扫一遍目录）——本模块是全仓
// MIND_MAP 唯一的取数口，两份数据各有唯一出处：
//   ① 顶层模块 + 层级边 = 共用数据层 `selectGraph("MIND_MAP", shared)`（F2 层；节点集合与方框图
//      逐 id 相同，节点硬上限/聚合规则也随共用层同一份 `shared.limits`，本模块零截断、零聚合）；
//   ② 更深层级（子模块 → 文件）= A4 `expandDirectory` 的结果（服务端唯一解析入口；
//      视图侧只把结果喂进来，不自己扫目录、不自己解析）；A4 结果里可能带「还有 N 个」聚合节点
//      （巨枝超子级上限时的降级，§4.3 第 1 招），本模块照样只当普通叶子节点画，不自建第二套截断；
// 依据 §3.2「三视图共享同一份邻居数据」+ §4.3 第 2 招分层懒加载：顶层先出，展开哪一枝才解析哪一枝。
//
// 本模块零 React / 零 node / 零 IO：浏览器（MindMapView）与验证脚本（verify-n1，服务端真数据）
// 引**同一份**实现——markdown 导出因此可以逐行核对（DoD④：每层带 id/path 注释，可回查 modules.json）。
import type { ModuleKind } from "./config";
import type { ExpandChild } from "./expand";
import { selectGraph, type SelectedGraph, type SharedGraph } from "./shared-graph";

/** 树节点的数据出处（写进 markdown 注释 `from=`，DoD④ 可追溯证据） */
export type MindNodeFrom =
  /** 根节点：项目自身（注册表里的项目名，不是新数据源） */
  | "project"
  /** 共用数据层节点（A1 modules.json 骨架 + A2 起名 + A5 四色） */
  | "shared"
  /** A4 下钻子级（expandDirectory 结果：子模块=目录 / 文件） */
  | "expand";

/** 思维导图节点（markmap 渲染与 markdown 导出共用同一份结构） */
export interface MindTreeNode {
  /** 稳定 id：顶层 = A1 slug；子级 = A4 slug（与方框图节点 id 同一口径） */
  id: string;
  /** 显示名：顶层 = A2 人话名（中文）；子级 = 文件名/目录名（§4.1 文件层 LLM 不碰） */
  label: string;
  /** 相对项目根路径（A4 展开入参）。**空串 = 没有真实路径**（「还有 N 个」聚合节点、项目根节点），
   *  与 A4 `expand.ts` 的 `ExpandChild.path` 同一口径；空串原样往下传，全仓不兜底成 "." ——
   *  "." 是 A1 模块路径里**根散文件模块**的真实路径，两者不是一回事（N1 尾修：口径统一）。 */
  path: string;
  file_count: number;
  /** §4.2 模块四色状态（progress.json；只有 shared 层节点有） */
  status?: string;
  /** shared 层=模块分类；expand 层=dir/file；aggregate=「还有 N 个」聚合节点（§4.3 第 1 招） */
  kind: ModuleKind | "dir" | "file" | "aggregate";
  /** 共用层的「还有 N 个」聚合节点（§4.3 第 1 招），不可下钻 */
  aggregate?: boolean;
  from: MindNodeFrom;
  children: MindTreeNode[];
}

/** 项目级入参（注册表里的项目名/id；本模块不读注册表，由调用方给） */
export interface MindProject {
  id: string;
  name: string;
}

export interface MindTree {
  /** MIND_MAP 的选择结果（共用层节点 + 层级父子边）——证明数据只经 F2 层，不新建数据源 */
  selection: SelectedGraph;
  root: MindTreeNode;
  /** 树里当前全部节点数（含根节点；不含尚未懒加载的分支） */
  nodeCount: number;
  /** 当前实际层级数（根 = 1 层） */
  depth: number;
  /** 本次树里有子级的 A4 下钻层数（0 = 只有顶层，还没展开过任何一枝） */
  expandedBranches: number;
}

/** 该节点还能往下钻吗（§3.3 规则 3：逐级下钻到文件级；文件与聚合节点是终点） */
export function isDrillable(n: MindTreeNode): boolean {
  if (n.aggregate === true) return false;
  return n.from === "expand" ? n.kind === "dir" : n.path !== "";
}

/**
 * 合成思维导图树（**MIND_MAP 唯一取数口**）。
 * @param shared         共用数据层（F2：唯一节点/边来源，硬上限与聚合已在这一层施加过）
 * @param project        项目名/id（根节点文字）
 * @param childrenByParent A4 懒加载结果：父节点 id → `expandDirectory` 的直接子级（未展开的父节点不在表里）
 */
export function buildMindTree(
  shared: SharedGraph,
  project: MindProject,
  childrenByParent: ReadonlyMap<string, readonly ExpandChild[]>,
): MindTree {
  // ① 顶层：走共用层的 MIND_MAP 选择（节点集合 = 共用层同一份，层级边 = 路径包含关系）
  const selection = selectGraph("MIND_MAP", shared);
  const parentOf = new Map(selection.edges.map((e) => [e.to, e.from]));

  // ② A4 子级：同一个 id 只认一次（防御性 seen，正常数据不会成环）
  const seen = new Set<string>();
  const expandOf = (parentId: string): MindTreeNode[] => {
    const raw = childrenByParent.get(parentId);
    if (!raw || seen.has(parentId)) return [];
    seen.add(parentId);
    return raw.map((c) => ({
      id: c.id,
      label: c.name,
      path: c.path,
      file_count: c.file_count,
      kind: c.kind,
      from: "expand" as const,
      children: c.kind === "dir" ? expandOf(c.id) : [],
    }));
  };

  const toSharedNode = (n: (typeof selection.nodes)[number]): MindTreeNode => ({
    id: n.id,
    label: n.name,
    path: n.path,
    file_count: n.file_count,
    ...(n.status ? { status: n.status } : {}),
    kind: n.kind,
    ...(n.aggregate ? { aggregate: true } : {}),
    from: "shared",
    children: [],
  });

  // ③ 组装：共用层节点按「父在子先」的层级边嵌套；没有父边的（含聚合节点）平铺在根下，
  //    顺序沿用共用层自己的顺序（file_count 降序 → id 升序），重渲染稳定。
  const hierarchicalChildren = new Map<string, typeof selection.nodes>();
  for (const e of selection.edges) {
    const target = selection.nodes.find((n) => n.id === e.to);
    if (!target) continue;
    hierarchicalChildren.set(e.from, [...(hierarchicalChildren.get(e.from) ?? []), target]);
  }
  const attach = (n: MindTreeNode): MindTreeNode => {
    n.children = [
      ...(hierarchicalChildren.get(n.id) ?? []).map((c) => attach(toSharedNode(c))),
      ...expandOf(n.id),
    ];
    return n;
  };
  const root: MindTreeNode = {
    id: project.id,
    label: project.name,
    path: "",
    file_count: selection.nodes.reduce((s, n) => s + n.file_count, 0),
    kind: "mixed",
    from: "project",
    children: selection.nodes.filter((n) => !parentOf.has(n.id)).map((n) => attach(toSharedNode(n))),
  };

  let nodeCount = 0;
  let depth = 0;
  const walk = (n: MindTreeNode, d: number): void => {
    nodeCount++;
    depth = Math.max(depth, d);
    for (const c of n.children) walk(c, d + 1);
  };
  walk(root, 1);
  return { selection, root, nodeCount, depth, expandedBranches: seen.size };
}

export interface MarkdownOptions {
  /** 每行尾追加可核对注释 `<!-- id=… path=… files=… from=… -->`（默认开；DoD④ 的可追溯落点） */
  annotate?: boolean;
}

/** markdown 行内文本转义（文件名可能含 `_` `*` 等；不转义会把结构画歪） */
const escapeLabel = (text: string) => text.replace(/([\\`*_[\]<>])/g, "\\$1");

/**
 * 树 → markdown（markmap 的输入格式，也是本卡的"导出"产物，DoD④）。
 * 结构（§3.2 表格第三行 / §3.3 规则 3）：
 *   `# 项目名`（根）
 *   `- **模块人话名** \`模块路径\``（顶层：A2 中文名，来自共用层）
 *     `- 子目录/文件名 \`相对路径\``（A4 下钻层）
 * 每行尾的注释是本卡的**可核对信息**：`id` 回查 modules.json / A4 子级、`path` 回查目录、`from` 标明出处。
 * 注释是 HTML 注释，markmap 渲染时不影响节点文字（已实测：内容进到节点 HTML 里，人眼看不到）。
 *
 * **path 口径（全仓唯一）**：节点路径原样输出——`path` 是空串就写 `path=`（空），
 *   **不兜底成 `.`**。空串的含义是"没有真实路径"（「还有 N 个」聚合节点、项目根节点），
 *   而 `.` 是 A1 模块路径里"根散文件模块"的**真实**路径（`modules.json` 里确实有 `path: "."`）——
 *   把空串渲染成 `.` 会让聚合节点看起来像"根目录散文件模块"，也让逐行回查（verify-n1 拿这行注释
 *   与 A4 `expandDirectory` 真结果逐条比）对不上（N1 尾修：一处口径不一致引发的假 FAIL）。
 *   显示文字同理：没有真实路径就不画那个反引号包起来的路径那一段（不画一个凭空的 `.`）。
 */
export function toMarkdown(root: MindTreeNode, opts: MarkdownOptions = {}): string {
  const annotate = opts.annotate !== false;
  const note = (n: MindTreeNode) =>
    annotate ? ` <!-- id=${n.id} path=${n.path} files=${n.file_count} from=${n.from} -->` : "";
  const lines = [`# ${escapeLabel(root.label)} \`${root.id}\`${note(root)}`, ""];
  const render = (n: MindTreeNode, depth: number): void => {
    const indent = "  ".repeat(depth);
    const bold = n.from === "shared" ? `**${escapeLabel(n.label)}**` : escapeLabel(n.label);
    const where = n.path !== "" ? ` \`${n.path}\`` : "";
    const drill = isDrillable(n) && n.children.length === 0 ? " ▸" : "";
    lines.push(`${indent}- ${bold}${where}${drill}${note(n)}`);
    for (const c of n.children) render(c, depth + 1);
  };
  for (const c of root.children) render(c, 0);
  return lines.join("\n");
}
