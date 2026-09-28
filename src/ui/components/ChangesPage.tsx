// H3 变更流水子页面（DESIGN.md §3.8：点顶部入口开出独立子页面看完整流水，查证用，不占主页面）。
//
// ███ 这里**只有数据源声明**，渲染在 `ChangesView.tsx` ███
// H3 原本自带一份「时间倒序列表 + 按文件分组 + 行内展开详情 + 分页」的渲染实现；P3 要的全局变更流
// 是同一份东西多一个「所属项目」列 + 项目过滤，所以渲染实现上提成了共享组件 `ChangesView.tsx`
// （PLAN P3 DoD④ 的硬要求：不另写第二份行渲染）。本文件退化成薄壳：只声明"单项目、按路径过滤、
// 行上没有项目列"这一份数据源。DOM 结构与字段渲染与 H3 逐字相同（单项目源的 projectLabel 恒为
// null，行里就不会多出项目标签那个格子）。
import { useMemo } from "react";
import { getChangesPage, type ProjectItem } from "../api";
import { ChangesView, type ChangeStreamSource } from "./ChangesView";

export function ChangesPage({ project, onClose }: { project: ProjectItem; onClose: () => void }) {
  // 数据源身份必须稳定（渲染器把它当依赖）：只在项目切换时重建
  const source = useMemo<ChangeStreamSource>(
    () => ({
      title: `变更流水 · ${project.name}`,
      fetchPage: ({ limit, offset, pathFilter }) =>
        getChangesPage(project.id, { limit, offset, path: pathFilter }),
      projectLabel: () => null, // 单项目视图没有"所属项目"这一列
      supportsPathFilter: true,
      emptyText: "还没有变更记录（监听随选中项目自动开启）",
    }),
    [project.id, project.name],
  );

  return <ChangesView source={source} onClose={onClose} />;
}
