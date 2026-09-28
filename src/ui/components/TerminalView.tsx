// E1：终端分屏容器（DESIGN.md §3.7 二期「多终端分屏」；T2 单终端 → E1 多 pane 并存）。
// 容器只管三件事：pane 列表（新增/关闭）、分屏方向（左右 / 上下可切换）、到上限的明确提示。
// **不管终端本身**——每个 pane 是 TerminalPane，自己建自己的 PTY 会话、自己连自己的 SSE、
// 自己上报 resize，容器不持有也不传递任何 sid（PLAN E1 跑偏点：共用 PTY 会串台，这里结构上不可能）。
// 上限与后端 pty.ts 的 MAX_SESSIONS_PER_PROJECT 同口径（后端超限 400，这里到顶即禁用并提示）。
import { useEffect, useRef, useState } from "react";
import type { ProjectItem } from "../api";
import { TerminalPane } from "../terminal/TerminalPane";

/** 每项目 pane 上限：必须与后端 `src/server/pty.ts` 的 MAX_SESSIONS_PER_PROJECT 同口径 */
const MAX_PANES_PER_PROJECT = 8;

/** 分屏方向：row = 左右并排，column = 上下叠放（DoD③ 可切换） */
type SplitLayout = "row" | "column";

const LAYOUT_LABEL: Record<SplitLayout, string> = {
  row: "左右分屏",
  column: "上下分屏",
};

export function TerminalView({ project }: { project: ProjectItem }) {
  const [layout, setLayout] = useState<SplitLayout>("row");
  // pane 的 React key（只增不减的序号），与"会话 sid"无关：key 变了就是新 pane、新会话
  const [panes, setPanes] = useState<number[]>([1]);
  const nextKey = useRef(2);
  const [limitNote, setLimitNote] = useState<string | null>(null);

  // 切项目 = 全部旧 pane 卸载（会各自关掉自己的会话），新项目从 1 个 pane 重新开始
  useEffect(() => {
    nextKey.current = 2;
    setPanes([1]);
    setLimitNote(null);
  }, [project.id]);

  const addPane = () => {
    if (panes.length >= MAX_PANES_PER_PROJECT) {
      setLimitNote(
        `已达上限 ${MAX_PANES_PER_PROJECT} 个终端（后端同口径）：先关掉不用的终端再开`,
      );
      return;
    }
    setLimitNote(null);
    const key = nextKey.current++;
    setPanes((prev) => [...prev, key]);
  };

  const closePane = (key: number) => {
    setLimitNote(null);
    setPanes((prev) => prev.filter((k) => k !== key)); // 只摘这一个：它自己的会话随卸载关闭
  };

  return (
    <div
      data-terminal-view
      data-terminal-layout={layout}
      data-terminal-pane-count={panes.length}
      className="flex min-h-0 flex-1 flex-col p-2"
    >
      <div className="mb-2 flex shrink-0 flex-wrap items-center gap-2 text-xs">
        <button
          data-terminal-add
          onClick={addPane}
          disabled={panes.length >= MAX_PANES_PER_PROJECT}
          className="rounded border border-neutral-700 px-2 py-1 text-neutral-300 hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-40"
        >
          ＋ 新增终端
        </button>
        <button
          data-terminal-layout-toggle
          onClick={() => setLayout((l) => (l === "row" ? "column" : "row"))}
          className="rounded border border-neutral-700 px-2 py-1 text-neutral-300 hover:bg-neutral-800"
        >
          切换布局
        </button>
        <span data-terminal-layout-label className="text-neutral-500">
          当前：{LAYOUT_LABEL[layout]}（{layout === "row" ? "左右" : "上下"}）
        </span>
        <span data-terminal-pane-count-label className="text-neutral-600">
          {panes.length} / {MAX_PANES_PER_PROJECT} 个终端
        </span>
        {limitNote && (
          <span data-terminal-limit-note className="text-amber-400">
            {limitNote}
          </span>
        )}
      </div>
      {panes.length === 0 ? (
        <div
          data-terminal-empty
          className="flex min-h-0 flex-1 items-center justify-center rounded border border-dashed border-neutral-800 text-xs text-neutral-500"
        >
          没有开着的终端，点「＋ 新增终端」开一个
        </div>
      ) : (
        <div
          data-terminal-panes
          // 左右 = flex-row、上下 = flex-col；pane 各自 flex-1 平分（DoD③）
          className={`flex min-h-0 flex-1 gap-2 ${layout === "row" ? "flex-row" : "flex-col"}`}
        >
          {panes.map((key, i) => (
            <TerminalPane
              // key 带项目 id：切项目时强制重挂载（旧会话随卸载关掉，不会留到新项目里）
              key={`${project.id}#${key}`}
              project={project}
              index={i}
              onClose={() => closePane(key)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
