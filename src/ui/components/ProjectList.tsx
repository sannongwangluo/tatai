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
    return <p className="tt-project-empty">还没有登记项目</p>;
  }
  return (
    <ul className="tt-project-list">
      {projects.map((p) => (
        <li
          key={p.id}
          data-project-item={p.id}
          {...(p.id === selectedId ? { "data-project-selected": "1" } : {})}
          title={p.path}
          className="tt-project-row"
        >
          <button className="tt-project-select" onClick={() => onSelect(p.id)} aria-current={p.id === selectedId ? "page" : undefined}>
            <span className="tt-project-symbol" aria-hidden="true">{p.name.slice(0, 1)}</span>
            <span className="tt-project-text">
              <span className="tt-project-name">{p.name}</span>
              <span className="tt-project-kind"><span className={`tt-project-presence ${p.exists ? "" : "is-missing"}`} aria-hidden="true" />{p.exists ? KIND_LABEL[p.kind] : "项目目录暂不可用"}</span>
            </span>
          </button>
          {/* 移除入口：默认收起，悬停该行时出现；点击不触发选中切换 */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              onRemove(p);
            }}
            title="从注册表移除（不删磁盘目录）"
            className="tt-project-remove"
          >
            移除
          </button>
        </li>
      ))}
    </ul>
  );
}
