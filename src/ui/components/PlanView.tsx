// V06-08 施工图页（DESIGN.md §3.4–§3.5 / §2.6）：把施工定义（TaskDefinition）与运行状态
// （TaskState）**分开**展示，并按依赖/状态筛选、卡片与原文双向定位。
//
// 三条口径（每条对应 §3.5 的一句原文）：
//   · 「施工图另提供按依赖/状态筛选的任务卡」→ 卡片列表 + 两组筛选（状态 / 依赖情形）。
//   · 「卡片与原文双向定位」→ 点卡片看它的原文小节与表格行（带行号）；点原文里的任务行
//     反过来选中那张卡。定位不猜测：行号来自服务端 `TaskDefinition.section_lines/row_line`。
//   · 「定义与状态严格分离」（§2.6）→ 卡片上**同时**显示"定义哈希绑定的状态"与"待重绑/悬空"
//     这类对齐结论；不把两者揉成一个"完成度"。
//
// 本组件只读：唯一写口是「用户验收」，那在 AcceptanceView 里（§5.8 人工验收只由用户记录）。
import { useEffect, useMemo, useRef, useState } from "react";
import { getPlan, type PlanPayload, type ProjectItem } from "../api";
import { useProjectScope } from "../projectScope";

/** 运行状态标签的显示色（只借色相区分进度，语义仍以文字为准；不着"完成绿"给未验证状态） */
const EXECUTION_TONE: Record<string, string> = {
  preparing: "border-neutral-700 bg-neutral-800/60 text-neutral-300",
  ready: "border-sky-700/60 bg-sky-950/40 text-sky-200",
  claimed: "border-sky-600/60 bg-sky-900/40 text-sky-100",
  executing: "border-sky-500/60 bg-sky-900/50 text-sky-100",
  result_submitted: "border-amber-600/60 bg-amber-950/40 text-amber-200",
  blocked: "border-red-600/60 bg-red-950/40 text-red-200",
  cancelled: "border-neutral-700 bg-neutral-900 text-neutral-400",
};

type StatusFilter = "all" | "no_state" | string;
type DepFilter = "all" | "none" | "has" | "unreleased" | "attention";

export function PlanView({ project }: { project: ProjectItem }) {
  const [plan, setPlan] = useState<PlanPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [depFilter, setDepFilter] = useState<DepFilter>("all");
  const { scope, setBucket } = useProjectScope(project.id);
  const selected = scope.selections["plan"] ?? null;
  const scrollRef = useRef<HTMLDivElement>(null);
  /** 项目 id 的镜像：回包落地前先问"还是不是发起那个项目"（§3.1 旧项目响应不许写进新界面） */
  const projectIdRef = useRef(project.id);
  projectIdRef.current = project.id;

  useEffect(() => {
    const id = project.id;
    setPlan(null);
    setLoadError(null);
    getPlan(id)
      .then((p) => {
        if (projectIdRef.current !== id) return;
        setPlan(p);
      })
      .catch((e: Error) => {
        if (projectIdRef.current !== id) return;
        setLoadError(e.message);
      });
  }, [project.id, reloadTick]);

  // 滚动位置按项目隔离（§3.1：切项目保留滚动位置）
  useEffect(() => {
    const el = scrollRef.current;
    const saved = scope.scroll["plan"];
    if (el && saved !== undefined) el.scrollTop = saved;
    // 只在项目切换时归位一次（不跟着每次渲染抖）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);

  const definitions = plan?.exists ? plan.definitions : [];
  const states = plan?.exists ? plan.states : {};
  const alignment = plan?.exists ? plan.alignment : null;

  const depSatisfied = useMemo(() => {
    // 依赖情形只看"前置卡的状态"（不把依赖线的集成结论混进来——那是 §4.2 的模块线）
    const out = new Map<string, { unreleased: string[]; unstarted: string[] }>();
    for (const d of definitions) {
      const unreleased: string[] = [];
      const unstarted: string[] = [];
      for (const dep of d.dependency_ids) {
        const st = states[dep]?.status;
        if (st === undefined) unstarted.push(dep);
        else if (st !== "result_submitted") unreleased.push(`${dep}(${states[dep].status_label})`);
      }
      out.set(d.task_id, { unreleased, unstarted });
    }
    return out;
  }, [definitions, states]);

  const rebindSet = useMemo(
    () => new Set((alignment?.needs_rebind ?? []).map((r) => r.task_id)),
    [alignment],
  );
  const orphanSet = useMemo(
    () => new Set((alignment?.orphan_states ?? []).map((o) => o.task_id)),
    [alignment],
  );

  const visible = definitions.filter((d) => {
    const st = states[d.task_id];
    if (statusFilter === "no_state") {
      if (st !== undefined) return false;
    } else if (statusFilter !== "all") {
      if (st?.status !== statusFilter) return false;
    }
    if (depFilter === "all") return true;
    const dep = depSatisfied.get(d.task_id) ?? { unreleased: [], unstarted: [] };
    if (depFilter === "none") return d.dependency_ids.length === 0;
    if (depFilter === "has") return d.dependency_ids.length > 0;
    if (depFilter === "unreleased") return dep.unreleased.length > 0 || dep.unstarted.length > 0;
    return rebindSet.has(d.task_id) || orphanSet.has(d.task_id);
  });

  const excerpt = plan?.exists && selected !== null ? plan.excerpts[selected] ?? null : null;

  if (loadError !== null) {
    return (
      <div className="w-full p-8" data-plan-view data-plan-load-error>
        <p className="text-sm text-red-400">施工图加载失败：{loadError}</p>
        <button
          data-plan-retry
          onClick={() => setReloadTick((t) => t + 1)}
          className="mt-2 rounded border border-red-500/40 px-2 py-1 text-xs text-red-300 hover:bg-red-500/20"
        >
          重试
        </button>
      </div>
    );
  }
  if (plan === null) {
    return (
      <div className="w-full p-8" data-plan-view data-plan-loading>
        <p className="text-sm text-neutral-500">加载施工图…</p>
      </div>
    );
  }
  if (!plan.exists) {
    // 缺施工图是**正常空态**，与"加载失败"分开显示（§3.3 的口径）
    return (
      <div className="w-full space-y-2 p-8" data-plan-view data-plan-empty>
        <h2 className="text-lg font-semibold">{project.name} · 施工图</h2>
        <p className="text-sm text-neutral-500">
          这个项目还没有施工图（不是加载失败）。施工图来源是项目根内登记的
          <code className="mx-1 rounded bg-neutral-800 px-1">{".工作台/plan.md"}</code>
          （§2.9）；有了它这里会按卡号列出定义与运行状态。
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col" data-plan-view>
      {/* ── 头：来源 + 生效版本 + 定义/状态分离的说明 ── */}
      <header className="shrink-0 border-b border-neutral-800 px-4 py-2">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-neutral-400">
          <span data-plan-source>
            来源：<span className="text-neutral-300">{plan.source_path}</span>（{plan.lines} 行）
          </span>
          <span data-plan-baseline>
            {plan.baseline === null ? (
              <span className="text-amber-300">还没有生效基线（有效版本未知）</span>
            ) : (
              <>
                生效版本：<span className="text-neutral-300">{plan.baseline.baseline_id}</span>
              </>
            )}
          </span>
          <span data-plan-count>
            卡 {plan.definitions.length} 张 · 筛选后 {visible.length} 张
            {plan.definitions.length !== visible.length ? `（隐藏 ${plan.definitions.length - visible.length} 张）` : ""}
          </span>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-neutral-500">
          <label>
            状态
            <select
              data-plan-status-filter
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="ml-1 rounded border border-neutral-700 bg-neutral-900 px-1 py-0.5 text-neutral-200"
            >
              <option value="all">全部</option>
              <option value="no_state">未开工（无运行状态）</option>
              <option value="ready">就绪</option>
              <option value="executing">执行中</option>
              <option value="result_submitted">结果已提交</option>
              <option value="blocked">阻塞</option>
              <option value="cancelled">取消</option>
            </select>
          </label>
          <label>
            依赖
            <select
              data-plan-dep-filter
              value={depFilter}
              onChange={(e) => setDepFilter(e.target.value as DepFilter)}
              className="ml-1 rounded border border-neutral-700 bg-neutral-900 px-1 py-0.5 text-neutral-200"
            >
              <option value="all">全部</option>
              <option value="none">无依赖</option>
              <option value="has">有依赖</option>
              <option value="unreleased">前置未满足</option>
              <option value="attention">待重绑 / 悬空</option>
            </select>
          </label>
          <span>定义与状态分开显示（§2.6）：状态来自已提交事件，定义只描述合同，两者不合成"完成度"</span>
        </div>
      </header>

      <div ref={scrollRef} data-plan-scroll className="min-h-0 flex-1 overflow-y-auto p-4"
        onScroll={(e) => setBucket("scroll", "plan", (e.target as HTMLDivElement).scrollTop)}>
        <div className="grid gap-4 lg:grid-cols-2">
          {/* ── 左：任务卡（按依赖/状态筛选） ── */}
          <ul className="space-y-2" data-plan-cards>
            {visible.length === 0 && (
              <li data-plan-no-match className="rounded border border-neutral-800 bg-neutral-900/60 px-3 py-2 text-xs text-neutral-500">
                没有匹配的卡（筛选后为空，不是"全部完成"）。
              </li>
            )}
            {visible.map((d) => {
              const st = states[d.task_id];
              const dep = depSatisfied.get(d.task_id) ?? { unreleased: [], unstarted: [] };
              const isSel = d.task_id === selected;
              const tone = st === undefined ? "border-neutral-800 bg-neutral-900/60 text-neutral-400" : EXECUTION_TONE[st.status] ?? "";
              return (
                <li
                  key={d.task_id}
                  data-plan-card={d.task_id}
                  data-plan-card-status={st?.status ?? "no_state"}
                  data-plan-card-deps={d.dependency_ids.join(",")}
                  {...(isSel ? { "data-plan-selected": "1" } : {})}
                  onClick={() => setBucket("selections", "plan", d.task_id)}
                  className={`cursor-pointer rounded border px-3 py-2 text-xs ${tone} ${
                    isSel ? "ring-1 ring-sky-500" : ""
                  }`}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-sm font-semibold" data-plan-card-id>
                      {d.task_id}
                    </span>
                    <span data-plan-card-goal className="min-w-0 flex-1 truncate text-neutral-200">
                      {d.goal ?? "（定义里没有交付目标）"}
                    </span>
                    <span
                      data-plan-card-status-label
                      className="rounded bg-neutral-950/60 px-1.5 py-0.5 text-[10px]"
                    >
                      状态：{st === undefined ? "未开工（无运行状态）" : st.status_label}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1 text-[10px]">
                    <span
                      data-plan-card-revision
                      className="rounded bg-neutral-950/60 px-1.5 py-0.5 text-neutral-400"
                      title={plan.definition_hashes[d.task_id] ?? ""}
                    >
                      定义 rev {d.revision}
                      {plan.definition_hashes[d.task_id] === undefined
                        ? ""
                        : ` · ${plan.definition_hashes[d.task_id].slice(0, 8)}`}
                    </span>
                    {d.dependency_ids.length === 0 ? (
                      <span className="rounded bg-neutral-950/60 px-1.5 py-0.5 text-neutral-400">无依赖</span>
                    ) : (
                      <span data-plan-card-dependency className="rounded bg-neutral-950/60 px-1.5 py-0.5 text-neutral-400">
                        依赖：{d.dependency_ids.join("、")}
                      </span>
                    )}
                    {rebindSet.has(d.task_id) && (
                      <span data-plan-card-rebind className="rounded bg-amber-900/50 px-1.5 py-0.5 text-amber-200">
                        待重绑（状态绑的是旧定义）
                      </span>
                    )}
                    {orphanSet.has(d.task_id) && (
                      <span data-plan-card-orphan className="rounded bg-red-900/50 px-1.5 py-0.5 text-red-200">
                        悬空状态（定义里没有这张卡）
                      </span>
                    )}
                    {dep.unreleased.length > 0 && (
                      <span data-plan-card-dep-unreleased className="rounded bg-amber-900/40 px-1.5 py-0.5 text-amber-200">
                        前置未满足：{dep.unreleased.join("、")}
                      </span>
                    )}
                    {dep.unstarted.length > 0 && (
                      <span data-plan-card-dep-unstarted className="rounded bg-neutral-800 px-1.5 py-0.5 text-neutral-300">
                        前置未开工：{dep.unstarted.join("、")}
                      </span>
                    )}
                  </div>
                  {d.acceptance !== null && d.acceptance.checks.length > 0 && (
                    <p data-plan-card-checks className="mt-1 text-[11px] text-neutral-400">
                      验收检查项 {d.acceptance.checks.filter((c) => c.checked).length}/{d.acceptance.checks.length} 已勾
                    </p>
                  )}
                </li>
              );
            })}
          </ul>

          {/* ── 右：选中卡的原文（回到源章节；双向定位的另一半在下面的原文行列表） ── */}
          <div className="space-y-3">
            {selected === null || excerpt === null ? (
              <p data-plan-excerpt-hint className="rounded border border-neutral-800 bg-neutral-900/60 px-3 py-2 text-xs text-neutral-500">
                点左边任意一张卡，这里显示它在施工图原文里的小节与表格行（带行号，随基线版本）。
              </p>
            ) : (
              <section data-plan-excerpt={selected} className="rounded border border-neutral-800 bg-neutral-900/60 p-3">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <h3 className="font-semibold text-neutral-100">原文出处 · {selected}</h3>
                  <span data-plan-excerpt-source className="text-neutral-500">
                    {plan.source_path}
                    {excerpt.section_lines === null
                      ? ""
                      : ` 第 ${excerpt.section_lines[0]}–${excerpt.section_lines[1]} 行`}
                  </span>
                  <button
                    data-plan-back-to-source
                    onClick={() => {
                      const row = document.querySelector(`[data-plan-source-line="${excerpt.row_line}"]`);
                      if (row instanceof HTMLElement) row.scrollIntoView({ block: "center" });
                      setBucket("scroll", "plan", scrollRef.current?.scrollTop ?? 0);
                    }}
                    className="rounded border border-neutral-700 px-2 py-0.5 text-[11px] text-neutral-300 hover:bg-neutral-800"
                  >
                    定位到原文行
                  </button>
                </div>
                {excerpt.row_text !== null && (
                  <p data-plan-excerpt-row className="mt-2 font-mono text-[11px] text-neutral-300">
                    第 {excerpt.row_line} 行（表格行）：{excerpt.row_text}
                  </p>
                )}
                <pre
                  data-plan-excerpt-section
                  className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded bg-neutral-950/70 p-2 text-[11px] leading-5 text-neutral-300"
                >
                  {excerpt.section_text ?? "（这张卡在原文里只有表格行，没有正文小节）"}
                </pre>
              </section>
            )}

            {/* ── 原文逐行列（表格行 → 卡片：双向定位的另一半） ── */}
            <section data-plan-source-lines className="rounded border border-neutral-800 bg-neutral-900/60 p-3">
              <h3 className="text-xs font-semibold text-neutral-300">施工图原文（表格行 → 卡片）</h3>
              <p className="mt-1 text-[11px] text-neutral-500">
                点表中任一行，选中对应卡片；行号与卡片上的出处一致。
              </p>
              <ul className="mt-2 max-h-64 space-y-0.5 overflow-y-auto font-mono text-[11px]">
                {plan.definitions.map((d) => (
                  <li key={d.task_id}>
                    <button
                      data-plan-source-line={d.row_line}
                      data-plan-source-task={d.task_id}
                      onClick={() => setBucket("selections", "plan", d.task_id)}
                      className={`w-full rounded px-1 py-0.5 text-left ${
                        d.task_id === selected ? "bg-sky-900/40 text-sky-100" : "text-neutral-400 hover:bg-neutral-800"
                      }`}
                    >
                      {d.row_line}: {plan.excerpts[d.task_id]?.row_text ?? ""}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
