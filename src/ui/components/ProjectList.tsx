// R3 左栏项目列表（DESIGN.md §3.1 左栏下半「项目管理」）。
// 逐条：状态点（exists 绿/灰）+ 项目名 + kind 徽标。
// R4：点击切为当前项目（高亮选中）；每条尾部「移除」入口（二次确认在 RemoveProjectDialog）。
import type { ProjectItem } from "../api";

/** kind 四值的中文显示名（DESIGN.md §2.3.1） */
const KIND_LABEL: Record<ProjectItem["kind"], string> = {
  backend: "后端",
  frontend: "前端",
  fullstack: "前后端",
  static: "静态站",
};

interface Props {
  projects: ProjectItem[];
  /** 当前选中项目 id（null = 未选中，右栏空态） */
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** 点「移除」只负责打开确认弹窗，真正删在弹窗里 */
  onRemove: (project: ProjectItem) => void;
}

export function ProjectList({ projects, selectedId, onSelect, onRemove }: Props) {
  if (projects.length === 0) {
    return <p className="px-3 py-2 text-xs text-neutral-500">还没有登记项目</p>;
  }
  return (
    <ul className="space-y-0.5 px-2">
      {projects.map((p) => (
        <li
          key={p.id}
          data-project-item={p.id}
          {...(p.id === selectedId ? { "data-project-selected": "1" } : {})}
          title={p.path}
          onClick={() => onSelect(p.id)}
          className={`group flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-neutral-800 ${
            p.id === selectedId ? "bg-neutral-800 ring-1 ring-neutral-600" : ""
          }`}
        >
          {/* 状态点：目录存在=绿，不存在=灰（exists 由后端给出） */}
          <span
            className={`h-2 w-2 shrink-0 rounded-full ${
              p.exists ? "bg-green-500" : "bg-neutral-500"
            }`}
          />
          <span className="min-w-0 flex-1 truncate">{p.name}</span>
          <span className="shrink-0 rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-400">
            {KIND_LABEL[p.kind]}
          </span>
          {/* 移除入口：默认收起，悬停该行时出现；点击不触发选中切换 */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              onRemove(p);
            }}
            title="从注册表移除（不删磁盘目录）"
            className="shrink-0 rounded px-1 text-[10px] text-neutral-500 opacity-0 hover:bg-red-900/50 hover:text-red-300 group-hover:opacity-100"
          >
            移除
          </button>
        </li>
      ))}
    </ul>
  );
}
