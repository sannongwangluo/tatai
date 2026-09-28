// P3 全局变更流子页面（PLAN P3 卡；DESIGN.md §2.3.5 字段不变 + §11.2 二期「全局变更流」）。
//
// 与 H3 的单项目子页面**共用同一个渲染器**（`ChangesView.tsx`，DoD④ 的硬要求——全仓只有一份
// 流水行渲染实现）。这里只声明"跨项目"这份数据源，与单项目源的差别恰好是 P3 的两条：
//   ① 行上多一列「所属项目」（GlobalChangeLine 的 project_name，`DESIGN.md` §2.3.5 的
//      ts/path/action/size_delta 三字段渲染原样不变）；
//   ② 过滤维度是**项目**（下拉即改即生效），不是路径子串——理由见 ChangesView 文件头
//      （路径过滤要求解析每个文件的每一行，与 P3「只读窗口、流式计数」的性能口径冲突）。
//
// 数据来自 `GET /api/changes/all`（后端 K 路归并 + 倒读窗口，见 `src/server/global-changes.ts`）：
// 时间倒序由后端保证，前端不排序、不合并、不做第二套口径——与 P2 跨项目视图同一姿势。
// 「按文件分组」在跨项目视图里按**路径**聚合：两个项目里有同名文件时它们会进同一组，
// 组里每一行仍带自己的项目标签（谁改的看得出来），所以不做"项目+路径"的复合分组键。
import { useMemo } from "react";
import type { GlobalChangeLine } from "../../server/global-changes";
import { getAllChangesPage } from "../api";
import { ChangesView, type ChangeStreamSource } from "./ChangesView";

export function GlobalChangesPage({
  projects,
  onClose,
}: {
  /** 过滤下拉的项目清单（调用方现成的那份即可，不为下拉再拉一次接口） */
  projects: readonly { id: string; name: string }[];
  onClose: () => void;
}) {
  const source = useMemo<ChangeStreamSource<GlobalChangeLine>>(
    () => ({
      title: "全局变更流 · 全部项目",
      fetchPage: ({ limit, offset, projectFilter }) =>
        getAllChangesPage({ limit, offset, projectId: projectFilter }),
      projectLabel: (line) => line.project_name,
      supportsPathFilter: false, // 跨项目只看项目维度（支持路径过滤的成本见文件头）
      projectOptions: projects,
      emptyText: "还没有任何项目的变更记录（选中项目时会自动开监听，产生变更后这里就有）",
    }),
    [projects],
  );

  return <ChangesView source={source} onClose={onClose} />;
}
