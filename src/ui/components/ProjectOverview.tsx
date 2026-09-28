// R4 右栏项目概览（DESIGN.md §3.1 辅助入口「项目信息」）。
// V06-08：从主导航挪到辅助入口（主导航只剩 项目图/设计书/施工图/聊天/实况与验收），
// 并按 §3.1 补上「当前目标 / 有效版本」两个只读派生值——它们分别来自实况快照与生效基线，
// 不是注册表字段，取不到就如实说"未激活/未知"，不编造。
import { useEffect, useState } from "react";
import { getActiveBaseline, getLive, getWorkUsage, type ProjectItem, type ProjectUsage } from "../api";
import { BackupPanel } from "./BackupPanel";

/** kind 四值的中文显示名（DESIGN.md §2.3.1），与 ProjectList 同一口径 */
const KIND_LABEL: Record<ProjectItem["kind"], string> = {
  backend: "后端",
  frontend: "前端",
  fullstack: "前后端",
  static: "静态站",
};

export function ProjectOverview({ project }: { project: ProjectItem }) {
  const [goal, setGoal] = useState<string | null>(null);
  const [stage, setStage] = useState<string | null>(null);
  const [baseline, setBaseline] = useState<string | null>(null);
  const [baselineCount, setBaselineCount] = useState<number | null>(null);
  const [derivedError, setDerivedError] = useState<string | null>(null);
  const [usage, setUsage] = useState<ProjectUsage | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);

  useEffect(() => {
    let stale = false;
    setGoal(null);
    setStage(null);
    setBaseline(null);
    setBaselineCount(null);
    setDerivedError(null);
    Promise.all([getLive(project.id), getActiveBaseline(project.id)])
      .then(([live, base]) => {
        if (stale) return;
        setStage(live.stage);
        setGoal(live.current_task === null ? null : `${live.current_task.id}「${live.current_task.title}」`);
        setBaseline(base.active === null ? null : base.active.baseline_id);
        setBaselineCount(base.count);
      })
      .catch((e: Error) => {
        if (!stale) setDerivedError(e.message);
      });
    return () => {
      stale = true;
    };
  }, [project.id]);

  // C017 用量区：同项目信息走（§3.1 辅助入口）；服务端只读现算，界面只展示不自行计数。
  // 项目还没激活 v2 基线（没有事件流）时端点照常 200：usage=0、上限不限、无耗时条目——
  // 这不是"没数据"，是如实空态。
  useEffect(() => {
    let stale = false;
    setUsage(null);
    setUsageError(null);
    getWorkUsage(project.id)
      .then((u) => {
        if (!stale) setUsage(u);
      })
      .catch((e: Error) => {
        if (!stale) setUsageError(e.message);
      });
    return () => {
      stale = true;
    };
  }, [project.id]);

  const rows: [string, string][] = [
    ["路径", project.path],
    ["类型", `${KIND_LABEL[project.kind]}（${project.kind}）`],
    ["注册时间", project.registered_at],
    ["最近打开", project.last_opened_at],
  ];
  return (
    <div className="mx-auto w-full max-w-xl space-y-4 p-8" data-project-info>
      <header className="flex items-center gap-2">
        <h2 className="text-lg font-semibold">{project.name}</h2>
        {project.self_managed && (
          <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-400">
            自举项目
          </span>
        )}
        {!project.exists && (
          <span className="rounded bg-red-900/40 px-1.5 py-0.5 text-[10px] text-red-300">
            目录不存在
          </span>
        )}
      </header>
      <dl className="space-y-2 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="flex gap-3">
            <dt className="w-20 shrink-0 text-neutral-500">{label}</dt>
            <dd className="min-w-0 break-all text-neutral-200">{value}</dd>
          </div>
        ))}
        <div className="flex gap-3">
          <dt className="w-20 shrink-0 text-neutral-500">当前目标</dt>
          <dd data-project-goal className="min-w-0 text-neutral-200">
            {derivedError !== null
              ? `（读不到：${derivedError}）`
              : goal ?? stage ?? "（读取中…）"}
          </dd>
        </div>
        <div className="flex gap-3">
          <dt className="w-20 shrink-0 text-neutral-500">有效版本</dt>
          <dd data-project-version className="min-w-0 break-all text-neutral-200">
            {derivedError !== null
              ? "（读不到）"
              : baselineCount === null
                ? "（读取中…）"
                : baseline === null
                  ? "尚未激活任何基线"
                  : `${baseline}（共 ${baselineCount} 条基线记录）`}
          </dd>
        </div>
      </dl>
      {/* C017 用量区（PLAN.md 2026-09-21 契约对齐登记，DESIGN.md §5.7 / §6.5 末段）：
          认领额度＝运营节流（只数认领动作，不代表任何实耗，配额数字不与任何费用表述同框）；
          耗时只有事件流可核对配对的才给毫秒；Token/金额缺可核对来源，显式标「未计量」。 */}
      <section className="space-y-2 border-t border-neutral-800 pt-3" data-usage-panel>
        <h3 className="text-sm font-semibold text-neutral-300">用量</h3>
        {usageError !== null ? (
          <p className="text-xs text-neutral-500">（读不到：{usageError}）</p>
        ) : usage === null ? (
          <p className="text-xs text-neutral-500">（读取中…）</p>
        ) : (
          <dl className="space-y-2 text-sm">
            <div className="flex gap-3">
              <dt className="w-20 shrink-0 text-neutral-500">认领额度</dt>
              <dd data-usage-quota className="min-w-0 text-neutral-200">
                已认领 {usage.claim_quota.usage} 次 / 上限{" "}
                {usage.claim_quota.max === null ? "不限" : `${usage.claim_quota.max} 次`}
                {usage.claim_quota.remaining !== null && `，剩余可认领 ${usage.claim_quota.remaining} 次`}
                {usage.claim_quota.status === "near" && (
                  <span className="ml-2 rounded bg-amber-900/50 px-1.5 py-0.5 text-[10px] text-amber-300">
                    接近上限
                  </span>
                )}
                {usage.claim_quota.status === "exhausted" && (
                  <span className="ml-2 rounded bg-red-900/40 px-1.5 py-0.5 text-[10px] text-red-300">
                    已达上限
                  </span>
                )}
                <span className="ml-2 text-xs text-neutral-500">
                  运营节流：只数认领动作，不代表任何实耗
                </span>
              </dd>
            </div>
            <div className="flex gap-3">
              <dt className="w-20 shrink-0 text-neutral-500">执行耗时</dt>
              <dd data-usage-durations className="min-w-0 text-neutral-200">
                {usage.durations.items.length === 0 ? (
                  <span className="text-neutral-500">（事件流里还没有认领动作）</span>
                ) : (
                  <ul className="space-y-1">
                    {usage.durations.items.map((it) => (
                      <li key={`${it.task_id}:${it.claimed_seq}`} data-usage-duration-item={it.task_id}>
                        <span className="font-mono text-xs">{it.task_id}</span>：
                        {it.status === "delivered" && it.duration_ms !== null
                          ? `${(it.duration_ms / 1000).toFixed(1)} 秒（${it.duration_ms} 毫秒，认领→交付）`
                          : it.status_label}
                      </li>
                    ))}
                  </ul>
                )}
                <p className="mt-1 text-xs text-neutral-600">{usage.durations.source}</p>
              </dd>
            </div>
            <div className="flex gap-3">
              <dt className="w-20 shrink-0 text-neutral-500">Token</dt>
              <dd data-usage-token className="min-w-0 text-neutral-200">
                未计量
                <span className="ml-2 text-xs text-neutral-500">{usage.token.reason}</span>
              </dd>
            </div>
            <div className="flex gap-3">
              <dt className="w-20 shrink-0 text-neutral-500">金额</dt>
              <dd data-usage-cost className="min-w-0 text-neutral-200">
                未计量
                <span className="ml-2 text-xs text-neutral-500">{usage.cost.reason}</span>
              </dd>
            </div>
          </dl>
        )}
      </section>
      <p className="text-xs text-neutral-600">
        「当前目标 / 有效版本」是只读派生值（实况快照 + 生效基线），不是注册表字段。
        各页的现场（页面、草稿、选中项、滚动位置）按项目各留各的（§3.1）。
      </p>
      {/* V09-06：私有事实（`.工作台/`）的显式备份与隔离恢复入口（§8.5 / §12.2 末行）。
          放在既有的「项目信息」辅助入口里，不新增导航页签（DESIGN.md §3.1 的辅助入口清单不变）。 */}
      <BackupPanel projectId={project.id} />
    </div>
  );
}
