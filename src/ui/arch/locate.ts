// N3：三视图互相定位（DESIGN.md §3.2 三视图 / §3.3 可折叠树；PLAN N3 卡）。
//
// **对齐键 = 共用层的 module_id**（`src/arch/shared-graph.ts` 的节点 id：顶层 = A1 模块 slug，
// 子级 = A4 slug；两视图同一份数据层，id 逐字相同）。**不是节点显示名**——A2/Flash 会给模块起
// 人话名（`names.json`），用户从设计书改个名、缓存一失效名字就变，拿名字当对齐键一跳就断
// （PLAN N3「跑偏点」红线）。显示名只进提示文案，不参与任何查找。
//
// 本文件零 React / 零 IO：两个渲染器（`ArchCanvas.tsx` / `MindMapView.tsx`）、页签容器
// （`components/ArchView.tsx`）与验证脚本（verify-n3）读同一份口径，不各写一套。
import type { GraphMode } from "../../arch/graph-mode";

/** 视图键（§3.2 表格三行；与 `GraphMode` 同一份，不另立枚举） */
export type ViewKey = GraphMode;

/** 视图在提示文案里的短名（「该节点在方框图无对应」用的就是它） */
export const VIEW_SHORT: Record<ViewKey, string> = {
  MODULE_BOX: "方框图",
  DATA_FLOW: "数据流向图",
  MIND_MAP: "思维导图",
};

/** 一次定位请求（单向：`to` 是要被定位的那个视图） */
export interface LocateRequest {
  /** 对齐键：共用层 module_id（**唯一查找依据**） */
  id: string;
  /** 目标视图（谁被切出来并居中高亮） */
  to: ViewKey;
  /** 发起视图（提示文案用） */
  from: ViewKey;
  /** 请求号（单调递增）：连点同一个节点也是新请求，目标视图要重新居中 */
  nonce: number;
  /** 节点显示名：**只用于提示文案**，不参与对齐（PLAN N3 跑偏点） */
  label: string;
  /** 节点路径（A4 口径）：只用于提示文案与回查 */
  path?: string;
}

/** 未匹配提示（DoD④：一侧没有这个 module_id 时明说，不静默失败）。
 *  文案开头固定是「该节点在 X 无对应」，后面挂对齐口径与原因——让人知道去哪儿查。 */
export function unmatchedNote(req: LocateRequest, why: string): string {
  const name = req.label ? `显示名「${req.label}」` : "该节点";
  return `该节点在${VIEW_SHORT[req.to]}无对应（按 module_id 对齐：${name}的 id 是 ${req.id}${req.path ? ` · 路径 ${req.path}` : ""}；${why}）`;
}

/** 匹配成功的提示（定位发生了就留痕：点的是谁、对到哪个 id——显示名与 id 摆在一起，差异一眼可见） */
export function matchedNote(req: LocateRequest, extra?: string): string {
  const name = req.label ? `「${req.label}」` : "";
  return `已定位：${name}${VIEW_SHORT[req.to]}节点 ${req.id}（module_id 对齐${extra ? `；${extra}` : ""}）`;
}

// ═══════════ V06-06：主视图（功能全景/系统架构/施工依赖）的跨视图定位与返回位置 ═══════════
//
// 与 N3 同一套口径的延伸（§3.2「跨视图跳转保留同一能力/模块/任务的关联范围，返回保留位置」）：
//   ① 对齐键 = **稳定 ID**（主视图用蓝图节点 id，技术详情用 module_id）——显示名只进文案；
//   ② 定位**不重置**对方视图的折叠与布局（各视图自己的 state 说了算）；
//   ③ 「返回上次位置」= 记下的上一条位置（视图 + 节点 id），不是"重新算一遍全图"。

export type ProjectViewKey = "functional" | "architecture" | "construction";

/** 主视图在提示文案里的短名（未匹配提示用的就是它） */
export const PROJECT_VIEW_SHORT: Record<ProjectViewKey, string> = {
  functional: "功能全景",
  architecture: "系统架构",
  construction: "施工依赖",
};

/** 技术详情那一侧在文案里的短名（主视图 ↔ 技术详情的定位共用） */
export const TECH_VIEW_SHORT = "技术详情";

/** 主视图之间/主视图与技术详情之间的一次定位请求（单向：`to` 是被定位的那一方） */
export interface ProjectLocateRequest {
  /** 对齐键：稳定 ID（蓝图节点 id 或 module_id；**唯一查找依据**） */
  id: string;
  to: ProjectViewKey | "tech";
  from: ProjectViewKey | "tech";
  nonce: number;
  /** 节点显示名：只用于文案 */
  label: string;
}

const viewShortName = (v: ProjectViewKey | "tech"): string =>
  v === "tech" ? TECH_VIEW_SHORT : PROJECT_VIEW_SHORT[v];

/** 主视图定位命中（留痕：显示名与对齐用的稳定 ID 摆在一起） */
export function projectMatchedNote(req: ProjectLocateRequest, extra?: string): string {
  const name = req.label ? `「${req.label}」` : "";
  return `已定位：${name}${viewShortName(req.to)}节点 ${req.id}（稳定 ID 对齐${extra ? `；${extra}` : ""}）`;
}

/** 主视图定位未命中（明说在哪一方没有对应，不静默失败） */
export function projectUnmatchedNote(req: ProjectLocateRequest, why: string): string {
  const name = req.label ? `显示名「${req.label}」` : "该节点";
  return `该节点在${viewShortName(req.to)}无对应（按稳定 ID 对齐：${name}的 id 是 ${req.id}；${why}）`;
}

/** 一条位置记录（"返回上次位置"就是回到这里：视图 + 节点 + 当时的筛选与搜索） */
export interface ViewBookmark {
  view: ProjectViewKey;
  /** 当时选中的节点稳定 ID（null = 只记得视图） */
  node_id: string | null;
  /** 当时的筛选（回到位置时一并还原，避免"回去以后东西又被筛没了"） */
  filter_kind: string;
  query: string;
}

export const sameBookmark = (a: ViewBookmark, b: ViewBookmark): boolean =>
  a.view === b.view && a.node_id === b.node_id && a.filter_kind === b.filter_kind && a.query === b.query;

/**
 * 记一条位置（最新在前、去重、有上限）。**返回上次位置**靠它：
 * 传进来的 `history` 是"到目前为止的位置栈"，压栈前先去掉与当前这条完全相同的记录。
 */
export function pushBookmark(
  history: readonly ViewBookmark[],
  entry: ViewBookmark,
  max = 12,
): ViewBookmark[] {
  const rest = history.filter((h) => !sameBookmark(h, entry));
  return [entry, ...rest].slice(0, max);
}

/**
 * 「返回上次位置」要回到的那一条 = 位置栈里**第一条与当前位置不同**的记录（没有就 null：
 * 按按钮时明说"没有可返回的上次位置"，不假装跳了一下）。当前位置用 `current` 传进来。
 */
export function previousBookmark(
  history: readonly ViewBookmark[],
  current: ViewBookmark,
): ViewBookmark | null {
  return history.find((h) => !sameBookmark(h, current)) ?? null;
}
