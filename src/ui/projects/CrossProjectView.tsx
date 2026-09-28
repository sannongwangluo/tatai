// P2 跨项目视图（PLAN P2 卡；DESIGN.md §11.2 二期「多项目并行增强」、§3.1 左栏「项目管理」的放大镜）。
//
// 一句话：**一屏看全部已登记项目**——每个项目一行，行上是 Gate 当前步 + 模块状态汇总 + 最近活动时间，
// 外加 doing/blocked 任务数与 severity 色点；行序 = P1 定的排序（有卡住的 > 在做的 > 静止的，
// 同桶内最近活动倒序）；点任意一行 → 切进这个项目的单项目上下文（URL hash `#p/<id>`，与左栏点选同一口径）。
//
// ███ 口径红线：本组件是**纯渲染器** ███
// 不排序、不分桶、不重算严重度、不读文件——排好序的行（P1 `sortProjectRows`）与分好组的分桶
// （P1 `groupRowsByGateStep`）都由 `GET /api/summary/projects` 给（服务端 `src/server/summary.ts`
// 调 P1 模块），两种口径共用同一批行对象：切口径不重新请求，也就无从"分叉"。
// 这里只 **type-only** import P1 的类型（值 import 会把服务端的 node:fs 链拖进前端包，
// 同 F2 拆 `arch/shared-graph.ts` 的理由）。行上的字段一个都不多——不许在这里顺手撑宽行（P1 ROW_FIELDS）。
//
// P3：头部多一个「全局变更流」入口（`GlobalChangesPage` 全屏覆盖层，与 H3 的单项目流水同一个渲染器
// `ChangesView.tsx`）；过滤下拉的项目清单直接取这一屏已经拿到的 rows，不为下拉再打一次接口，
// 左栏 §3.1 两段结构一字未动。
//
// Q139 刷新失败（已有数据时也明说）：行留在屏上，但顶部红色横幅 +「重试」——行上的最近活动时间
// 不推进，不写清楚会被读成"项目一直没动静"（数据源断了 ≠ 项目卡了），与实况 Tab 同一口径。
import { useCallback, useEffect, useState } from "react";
import type { ProjectSummaryRow, SummaryScope } from "../../server/projects-summary";
import { getProjectsSummary, type ProjectItem, type ProjectsSummaryPayload } from "../api";
import { STATUS_STYLE, statusStyle } from "../arch/statusColor";
import { GlobalChangesPage } from "../components/GlobalChangesPage";

/** 相对时间：刚刚 / N 分钟前 / …（AgentList 同一口径；最近活动时间用） */
function relativeTime(iso: string | null): string {
  if (iso === null) return "无活动记录";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const diff = Date.now() - t;
  if (diff < 60_000) return "刚刚";
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days <= 30) return `${days} 天前`;
  return iso.slice(0, 10);
}

/** Gate 三态 → 四色表取色（pass 绿 / reject 红 / pending 灰）：色值仍只来自 statusColor 一处 */
const GATE_RESULT_STYLE = {
  pass: STATUS_STYLE.done,
  reject: STATUS_STYLE.issue,
  pending: STATUS_STYLE.todo,
} as const;

const KIND_LABEL: Record<ProjectItem["kind"], string> = {
  backend: "后端",
  frontend: "前端",
  fullstack: "前后端",
  static: "静态站",
};

/** 模块状态汇总的四个计数键（顺序 = statusColor 的四色顺序，色值共用） */
const MODULE_KEYS = ["todo", "doing", "done", "issue"] as const;

/**
 * 一个项目一行（DoD①：Gate 当前步 + 模块状态汇总 + 最近活动时间；外加任务态与 severity 色点）。
 * 整行可点：进入该项目（DoD③）。
 */
function ProjectRow({ row, onOpen }: { row: ProjectSummaryRow; onOpen: (id: string) => void }) {
  const mods = row.module_status_counts;
  const sev = row.severity === null ? null : statusStyle(row.severity);
  const gate = GATE_RESULT_STYLE[row.gate.result];
  return (
    <li>
      <button
        data-cross-row
        data-project-id={row.project_id}
        data-severity={row.severity ?? "none"}
        data-gate-step={row.gate.current_step}
        onClick={() => onOpen(row.project_id)}
        title={`进入「${row.name}」（${row.gate.step_name} · ${row.gate.result}）`}
        className="flex w-full items-center gap-3 border-b border-neutral-800/60 px-4 py-2 text-left text-xs hover:bg-neutral-900"
      >
        {/* severity 色点（P1 口径：四色按 issue > doing > todo > done 归约；无模块 = 空心点，不是灰） */}
        <span
          data-severity-dot
          title={sev ? `项目级最严重色：${sev.label}` : "无模块（不是灰，是没有数据）"}
          className="h-2.5 w-2.5 shrink-0 rounded-full"
          style={
            sev
              ? { background: sev.hex }
              : { background: "transparent", border: "1px solid #525252" }
          }
        />

        {/* 是谁 */}
        <span className="flex w-52 shrink-0 items-center gap-1.5">
          <span className="min-w-0 truncate font-semibold text-neutral-100">{row.name}</span>
          <span className="shrink-0 rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-400">
            {KIND_LABEL[row.kind]}
          </span>
          {row.self_managed && (
            <span className="shrink-0 rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-500">
              自举
            </span>
          )}
        </span>

        {/* Gate 当前步 + 三态（DoD①） */}
        <span data-row-gate className="w-40 shrink-0">
          <span className="text-neutral-500">Gate </span>
          <span className="text-neutral-200">{row.gate.step_name}</span>
          <span className={`ml-1.5 rounded border px-1 py-0.5 text-[10px] ${gate.text}`}>
            {row.gate.result}
          </span>
        </span>

        {/* 模块状态汇总（DoD①）：四色计数，不重算状态，只显示 progress.json 里已有的值 */}
        <span data-row-modules className="flex w-64 shrink-0 items-center gap-1">
          {MODULE_KEYS.map((k) => (
            <span
              key={k}
              data-module-count={k}
              className={`whitespace-nowrap rounded border px-1 py-0.5 text-[10px] ${statusStyle(k).text}`}
              title={statusStyle(k).label}
            >
              {statusStyle(k).label} {mods[k]}
            </span>
          ))}
          <span className="whitespace-nowrap text-[10px] text-neutral-500">共 {mods.total}</span>
        </span>

        {/* 任务态：doing / blocked 是两个硬信号（P1 排序键只看这两个） */}
        <span data-row-tasks className="w-40 shrink-0">
          <span className="text-amber-300">doing {row.task_counts.doing}</span>
          <span className="mx-1.5 text-neutral-700">|</span>
          <span className={row.task_counts.blocked > 0 ? "text-red-300" : "text-neutral-400"}>
            blocked {row.task_counts.blocked}
          </span>
        </span>

        {/* 最近活动时间（DoD①，三个源的尾值取最大） */}
        <span data-row-activity className="ml-auto shrink-0 text-neutral-400" title={row.last_activity_at ?? ""}>
          {relativeTime(row.last_activity_at)}
        </span>
      </button>
    </li>
  );
}

export function CrossProjectView({ onOpenProject }: { onOpenProject: (id: string) => void }) {
  const [data, setData] = useState<ProjectsSummaryPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // 口径：初值取服务端给的 default_scope（P1 定为 PROJECT_ROW），用户可在视图里切到分桶
  const [scope, setScope] = useState<SummaryScope | null>(null);
  const [loading, setLoading] = useState(false);
  // P3：全局变更流子页面（全屏覆盖层，与 H3 的单项目流水同一形态）——入口就在本视图头部
  const [changesOpen, setChangesOpen] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    getProjectsSummary()
      .then((s) => {
        setData(s);
        setLoadError(null);
        setScope((cur) => cur ?? s.default_scope);
      })
      .catch((e: Error) => setLoadError(e.message))
      .finally(() => setLoading(false));
  }, []);

  // 挂载即拉一次 + 每 10s 轻刷新（与实况 Tab 的轮询同路子：跨项目快照是只读合成，频率低够用），
  // 另有手动「刷新」按钮；不挂 SSE / 文件监听——跨项目视图不是常驻监视，别为它挂 N 个项目的监听。
  useEffect(() => {
    load();
    const timer = setInterval(load, 10_000);
    return () => clearInterval(timer);
  }, [load]);

  if (loadError && !data) {
    return (
      <div className="flex items-center gap-2 p-6 text-xs text-red-400">
        <span className="min-w-0 flex-1">跨项目汇总加载失败：{loadError}</span>
        <button
          data-cross-error-retry
          onClick={load}
          className="shrink-0 rounded border border-red-500/40 px-2 py-0.5 text-red-300 hover:bg-red-500/20"
        >
          重试
        </button>
      </div>
    );
  }
  if (!data || scope === null) {
    return <p className="p-6 text-xs text-neutral-500">跨项目汇总加载中…</p>;
  }

  const active = scope;
  return (
    <div
      data-cross-view
      data-cross-stale={loadError ? "1" : "0"}
      className="flex min-h-0 flex-1 flex-col"
    >
      {/* ── 顶部：口径切换（P1 的两种口径）+ 计数 + 刷新 ── */}
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-neutral-800 px-4 py-2 text-xs">
        <span data-cross-count className="font-semibold text-neutral-200">
          跨项目视图 · {data.rows.length} 个项目
        </span>
        <nav className="flex gap-1">
          {(Object.keys(data.scopes) as SummaryScope[]).map((key) => (
            <button
              key={key}
              data-scope-toggle={key}
              onClick={() => setScope(key)}
              title={data.scopes[key].when}
              className={`rounded border px-2 py-1 text-xs ${
                key === active
                  ? "border-neutral-600 bg-neutral-800 text-neutral-100"
                  : "border-neutral-800 text-neutral-500 hover:text-neutral-300"
              }`}
            >
              {data.scopes[key].label}
            </button>
          ))}
        </nav>
        <span data-scope-question className="text-neutral-500">
          {data.scopes[active].question}
        </span>
        {/* P3：全局变更流入口（挂在跨项目视图头部，不动 §3.1 左栏两段结构；点开全屏覆盖层，
            主视图原样留在它下面，关闭即回）——过滤下拉的项目清单直接用这一屏已经拿到的 rows */}
        <button
          data-entry="global-changes"
          onClick={() => setChangesOpen(true)}
          title="全部项目的变更流水合并成一条时间倒序的流（每条标明所属项目，可按项目过滤）"
          className="ml-auto rounded border border-neutral-700 px-2 py-1 text-neutral-300 hover:bg-neutral-800"
        >
          全局变更流
        </button>
        <button
          data-cross-refresh
          onClick={load}
          className="rounded border border-neutral-700 px-2 py-1 text-neutral-300 hover:bg-neutral-800"
        >
          {loading ? "刷新中…" : "刷新"}
        </button>
      </div>

      {/* Q139：刷新失败要明说（有数据时原来一个字都不出）——行上的「最近活动」是上次成功那次的读数，
          数据源断了它不推进，看着像"项目静止"，其实只是读不到新状态；重试成功自己消失 */}
      {loadError && (
        <div
          data-cross-error-banner={loadError}
          className="flex shrink-0 items-center gap-2 border-b border-red-500/40 bg-red-500/10 px-4 py-1.5 text-xs text-red-300"
        >
          <span className="min-w-0 flex-1 truncate" title={loadError}>
            跨项目汇总刷新失败：{loadError}——下面是上次成功的读数（「最近活动」那列没有推进）
          </span>
          <button
            data-cross-error-retry
            onClick={load}
            className="shrink-0 rounded border border-red-500/40 px-1.5 py-0.5 hover:bg-red-500/20"
          >
            重试
          </button>
        </div>
      )}

      {/* ── 读失败的项目：不静默丢（行集合恒等于「读得到的项目」，失败单列一条） ── */}
      {data.errors.length > 0 && (
        <div data-cross-errors className="shrink-0 border-b border-amber-500/40 bg-amber-500/10 px-4 py-1.5 text-xs text-amber-300">
          {data.errors.length} 个项目读失败：
          {data.errors.map((e) => `${e.project_id}（${e.message}）`).join("；")}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {data.rows.length === 0 && (
          <p className="p-6 text-xs text-neutral-500">
            还没有登记项目——先在左栏「项目管理」里加一个
          </p>
        )}

        {/* 口径 ①：按项目一行（默认，P1 的数据口径单位） */}
        {active === "PROJECT_ROW" && data.rows.length > 0 && (
          <ul data-cross-rows>
            {data.rows.map((row) => (
              <ProjectRow key={row.project_id} row={row} onOpen={onOpenProject} />
            ))}
          </ul>
        )}

        {/* 口径 ②：按 Gate 步分桶（同一批行的分组渲染，组内顺序不变；空步也列出来供阶段盘点） */}
        {active === "GATE_STEP_GROUP" && (
          <div data-cross-groups>
            {data.groups.map((g) => (
              <section key={g.step} data-cross-group data-step={g.step}>
                <h3 className="flex items-baseline gap-2 border-b border-neutral-800 bg-neutral-900/60 px-4 py-1.5 text-xs">
                  <span data-step-name className="font-semibold text-neutral-200">
                    {g.step_name}
                  </span>
                  <span className="text-[10px] text-neutral-500">{g.step}</span>
                  <span data-step-count className="ml-auto text-neutral-400">
                    {g.rows.length} 个项目
                  </span>
                </h3>
                {g.rows.length === 0 ? (
                  <p className="px-4 py-1.5 text-[10px] text-neutral-600">
                    没有项目停在这一步
                  </p>
                ) : (
                  <ul>
                    {g.rows.map((row) => (
                      <ProjectRow key={row.project_id} row={row} onOpen={onOpenProject} />
                    ))}
                  </ul>
                )}
              </section>
            ))}
          </div>
        )}
      </div>

      {/* P3：全局变更流子页面（全屏覆盖层；主视图原样留在它下面，Esc / 「关闭」即回） */}
      {changesOpen && (
        <GlobalChangesPage
          projects={data.rows.map((r) => ({ id: r.project_id, name: r.name }))}
          onClose={() => setChangesOpen(false)}
        />
      )}
    </div>
  );
}
