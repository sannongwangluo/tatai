// 变更流**共享渲染器**（H3 单项目子页面与 P3 全局变更流共用**这一份**，DoD④「不另写一份」的落点）。
//
// 为什么做成"组件 + 数据源"：两处流水要的东西几乎一样——时间倒序列表、按文件分组、行内展开详情、
// 分页加载更多、action/size_delta 着色；差别只有三点：标题、行上多不多一列「所属项目」、过滤维度
// （单项目按路径子串过滤，跨项目按项目过滤）。于是把差异收进 `ChangeStreamSource` 这个数据源对象，
// 渲染路径一字不差地共用：两个薄壳（`ChangesPage.tsx` / `GlobalChangesPage.tsx`）只声明自己那份
// 数据源，下面这些 DOM 结构、字段格式、着色、详情面板**只有一份实现**。
//
// 字段口径：`DESIGN.md` §2.3.5（ts/path/action/size_delta）原样渲染；P3 的全局流在这四个字段之外
// **追加** project_id/project_name（见 `src/server/global-changes.ts`），界面上就是每行多一个项目小标签
// ——三字段的渲染与单项目视图逐字相同。
//
// 跨项目源为什么不支持路径过滤：全局流的 total 是"流式行计数"（不解析 JSON，见 global-changes.ts），
// 路径是行内字段，要按它过滤就得把每个文件的每一行都解析一遍——那就回到"全量读进内存"的老路上了。
// 所以跨项目视图的过滤维度是**项目**（`projectOptions` 下拉），单项目视图的过滤维度是**路径**；
// 数据源用 `supportsPathFilter` 声明自己支持哪种，渲染器据此决定要不要画那个输入框。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChangeLine } from "../../server/watcher";

const ACTION_LABEL: Record<ChangeLine["action"], string> = {
  add: "新增",
  modify: "修改",
  remove: "删除",
};
const ACTION_CLASS: Record<ChangeLine["action"], string> = {
  add: "text-green-400",
  modify: "text-sky-400",
  remove: "text-red-400",
};

/** 每页条数（两个视图同值；后端全局流缺省值也是这个数） */
export const CHANGES_PAGE_SIZE = 200;

function Delta({ value }: { value: number | null }) {
  if (value === null) return <span className="text-neutral-600">?</span>;
  return value >= 0 ? (
    <span className="text-green-400">+{value}</span>
  ) : (
    <span className="text-red-400">{value}</span>
  );
}

/** 一页数据（行类型由数据源定：单项目 = ChangeLine，全局 = ChangeLine + project_id/project_name） */
export interface ChangePageResult<T extends ChangeLine> {
  changes: T[];
  /** 过滤后的总条数（前端分页计数用） */
  total: number;
  /** 数据源读失败登记（多项目源才有；空 = 全部读成功。不发它 = 该源不会读失败） */
  errors?: { project_id: string; message: string }[];
}

/** 一行的业务身份（Q33）：后端 `ChangeLine` 没有单条 id，四个字段就是能做到的最强身份。
 *  用途只有一个——**追加页去重**（倒序表随增长向后漂移时，下一页会与上一页重叠）。 */
function lineKey(l: ChangeLine): string {
  return `${l.ts}|${l.path}|${l.action}|${l.size_delta}`;
}

/** 按身份合并两批行（保序、去重；已在上屏列表里的行保持原位不被后到的重复行顶掉） */
function mergeLines<T extends ChangeLine>(base: T[], add: T[]): T[] {
  const seen = new Set(base.map(lineKey));
  const out = [...base];
  for (const l of add) {
    const k = lineKey(l);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(l);
  }
  return out;
}

/**
 * 变更流数据源：渲染器只认这个接口，不认"单项目 / 跨项目"。
 * `T` 是行类型——全局源用 `GlobalChangeLine`，于是 `projectLabel` 拿到的就是带 project_id 的行，
 * 不需要任何类型断言（行字段一旦分叉，`pnpm typecheck` 直接红）。
 */
export interface ChangeStreamSource<T extends ChangeLine = ChangeLine> {
  /** 子页面标题（如「变更流水 · 项目名」/「全局变更流 · 全部项目」） */
  title: string;
  /** 拉一页（时间倒序由后端保证；offset 由渲染器给——**累计已消费行数**，不是已上屏条数，见 Q33） */
  fetchPage(opts: {
    limit: number;
    offset: number;
    /** 路径子串过滤（仅有 supportsPathFilter 的源用得上） */
    pathFilter: string;
    /** 单项目过滤（仅有多项目下拉的源用得上；"" = 不过滤） */
    projectFilter: string;
  }): Promise<ChangePageResult<T>>;
  /** 行上「所属项目」标签；返回 null = 不显示该列（单项目视图） */
  projectLabel(line: T): string | null;
  /** 该源支持按路径子串过滤吗（决定要不要画路径输入框） */
  supportsPathFilter: boolean;
  /** 单项目过滤下拉项（多项目源才有；空 = 不画下拉） */
  projectOptions?: readonly { id: string; name: string }[];
  /** 空态文案（"这个项目还没有变更"与"所有项目都还没有变更"是两句不同的话） */
  emptyText: string;
}

/** 单条流水行（时间序列表与按文件分组两处唯一的行渲染实现）：点击展开行内详情 */
function ChangeRow<T extends ChangeLine>({ line, project }: { line: T; project: string | null }) {
  const [open, setOpen] = useState(false);
  return (
    <li data-change-row data-action={line.action} className="border-b border-neutral-800/60 last:border-b-0">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-baseline gap-3 px-4 py-1.5 text-left text-xs hover:bg-neutral-900"
      >
        <span className="shrink-0 text-[10px] text-neutral-600" title={line.ts}>
          {line.ts.slice(0, 10)} {line.ts.slice(11, 19)}
        </span>
        <span className={`w-10 shrink-0 ${ACTION_CLASS[line.action]}`}>
          {ACTION_LABEL[line.action]}
        </span>
        {/* P3：所属项目列（只有跨项目源给得出标签；单项目视图这一格不出现，DOM 与 H3 逐字节相同） */}
        {project !== null && (
          <span
            data-change-project
            className="max-w-36 shrink-0 truncate rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-400"
            title={project}
          >
            {project}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate text-neutral-300" title={line.path}>
          {line.path}
        </span>
        <span className="shrink-0 text-[10px]">
          <Delta value={line.size_delta} />
        </span>
      </button>
      {open && (
        <dl
          data-change-detail
          className="space-y-1 border-t border-neutral-800/60 bg-neutral-900/60 px-4 py-2 text-[11px]"
        >
          <div className="flex gap-2">
            <dt className="w-16 shrink-0 text-neutral-600">时间</dt>
            <dd className="text-neutral-300">{line.ts}</dd>
          </div>
          {project !== null && (
            <div className="flex gap-2">
              <dt className="w-16 shrink-0 text-neutral-600">所属项目</dt>
              <dd className="text-neutral-300">{project}</dd>
            </div>
          )}
          <div className="flex gap-2">
            <dt className="w-16 shrink-0 text-neutral-600">路径</dt>
            <dd className="break-all text-neutral-300">{line.path}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-16 shrink-0 text-neutral-600">动作</dt>
            <dd className={ACTION_CLASS[line.action]}>{ACTION_LABEL[line.action]}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-16 shrink-0 text-neutral-600">大小变化</dt>
            <dd>
              <Delta value={line.size_delta} /> 字节
            </dd>
          </div>
        </dl>
      )}
    </li>
  );
}

/**
 * 变更流子页面本体（全屏覆盖层，主视图不动，关闭即回）：数据源由两个薄壳各自提供。
 * `source` 必须由调用方 useMemo（身份稳定），否则每次渲染都会重头拉第一页。
 */
export function ChangesView<T extends ChangeLine>({
  source,
  onClose,
}: {
  source: ChangeStreamSource<T>;
  onClose: () => void;
}) {
  const [lines, setLines] = useState<T[]>([]);
  const [total, setTotal] = useState(0);
  const [filter, setFilter] = useState(""); // 输入框即时值（路径过滤）
  const [applied, setApplied] = useState(""); // 已应用到查询的路径过滤串
  const [projectFilter, setProjectFilter] = useState(""); // 已应用的项目过滤（下拉即改即生效）
  const [groupByFile, setGroupByFile] = useState(false);
  const [readErrors, setReadErrors] = useState<{ project_id: string; message: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  /** Q33：已消费的服务端行数 —— 下一页的 offset 认它，不认 `lines.length`。
   *  流水是尾部追加、界面读的是倒序表：新行插在**头部**，旧下标整体后移，`offset=已上屏条数`
   *  会指向"已经拿过的行"（页间重叠）。累计已消费行数才是不随增长漂移的游标。 */
  const consumedRef = useRef(0);

  /** Q33：补拉头部新行（差量条数一次拉够；失败不打断，下一次「加载更多」会再补） */
  const pullHead = useCallback(
    (pathFilter: string, projectId: string, limit: number) => {
      source
        .fetchPage({
          limit: Math.max(1, limit),
          offset: 0,
          pathFilter,
          projectFilter: projectId,
        })
        .then(({ changes, total, errors }) => {
          setLines((cur) => mergeLines(changes, cur)); // 头部行在前 → 顺序不变
          setTotal(total);
          setReadErrors(errors ?? []);
        })
        .catch(() => {
          // 补拉失败不喧哗：已上屏的照旧，下一次「加载更多」或重开子页面会再补
        });
    },
    [source],
  );

  // 拉一页（reset=true 重头拉；否则追加下一页）。倒序由后端保证。
  const load = useCallback(
    (reset: boolean, pathFilter: string, projectId: string, current: T[]) => {
      setLoading(true);
      source
        .fetchPage({
          limit: CHANGES_PAGE_SIZE,
          offset: reset ? 0 : consumedRef.current,
          pathFilter,
          projectFilter: projectId,
        })
        .then(({ changes, total, errors }) => {
          setReadErrors(errors ?? []);
          setError(null);
          setTotal(total);
          if (reset) {
            consumedRef.current = changes.length;
            setLines(changes);
            return;
          }
          const merged = mergeLines(current, changes); // 去重：重叠页只留一份
          consumedRef.current += changes.length;
          setLines(merged);
          // Q33：这条流水一直在长，新行只出现在头部——它们排在窗口**前面**，靠 offset 向后翻
          // 永远翻不到（"永久漏行"）。差集（已消费 − 已上屏）恰好就是被挤到窗口前的那几行，
          // 按这个差量补拉一次头部：不重置用户的滚动位置，也不再等下次重开子页面。
          const missingHead = consumedRef.current - merged.length;
          if (missingHead > 0) pullHead(pathFilter, projectId, missingHead);
        })
        .catch((e: Error) => setError(e.message))
        .finally(() => setLoading(false));
    },
    [source, pullHead],
  );

  // 换数据源（切项目 / 换过滤）：重头拉第一页
  useEffect(() => {
    consumedRef.current = 0;
    setLines([]);
    load(true, applied, projectFilter, []);
  }, [load, applied, projectFilter]);

  // Esc 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // 按文件分组视图：已加载行按 path 聚合成组（组内仍时间倒序；组按最新一条的时间排）
  const groups = useMemo(() => {
    if (!groupByFile) return null;
    const map = new Map<string, T[]>();
    for (const l of lines) {
      const arr = map.get(l.path);
      if (arr) arr.push(l);
      else map.set(l.path, [l]);
    }
    return [...map.entries()].sort((a, b) => Date.parse(b[1][0].ts) - Date.parse(a[1][0].ts));
  }, [groupByFile, lines]);

  const hasMore = lines.length < total;
  const projectOptions = source.projectOptions ?? [];

  return (
    <div
      data-changes-page
      className="fixed inset-0 z-50 flex flex-col bg-neutral-950 text-neutral-100"
    >
      <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-neutral-800 px-4 py-2.5">
        <h2 className="text-sm font-bold">{source.title}</h2>
        <span data-changes-total className="text-[10px] text-neutral-600">
          共 {total} 条{applied ? `（过滤: ${applied}）` : ""}，时间倒序
        </span>
        {/* 跨项目源：单项目过滤下拉（DoD②；"全部项目"= 不过滤） */}
        {projectOptions.length > 0 && (
          <select
            data-changes-project-filter
            value={projectFilter}
            onChange={(e) => setProjectFilter(e.target.value)}
            className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-200 focus:border-neutral-500 focus:outline-none"
          >
            <option value="">全部项目</option>
            {projectOptions.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
        {/* 单项目源：路径子串过滤（跨项目源不支持，理由见文件头） */}
        {source.supportsPathFilter && (
          <form
            className="flex items-center gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              setApplied(filter.trim());
            }}
          >
            <input
              data-changes-filter
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="按路径过滤（子串），回车应用"
              className="w-56 rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-200 placeholder:text-neutral-600 focus:border-neutral-500 focus:outline-none"
            />
            {applied && (
              <button
                type="button"
                onClick={() => {
                  setFilter("");
                  setApplied("");
                }}
                className="rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-800"
              >
                清除过滤
              </button>
            )}
          </form>
        )}
        <button
          data-changes-group-toggle
          onClick={() => setGroupByFile((v) => !v)}
          className={`rounded border px-2 py-1 text-xs ${
            groupByFile
              ? "border-sky-700 bg-sky-500/10 text-sky-300"
              : "border-neutral-700 text-neutral-400 hover:bg-neutral-800"
          }`}
        >
          按文件分组
        </button>
        <button
          data-changes-close
          onClick={onClose}
          className="ml-auto rounded border border-neutral-700 px-2.5 py-1 text-xs text-neutral-300 hover:bg-neutral-800"
        >
          ✕ 关闭（Esc）
        </button>
      </header>

      {/* 读失败的数据源：不静默丢（跨项目源才有内容；单项目源不会给这个字段） */}
      {readErrors.length > 0 && (
        <div
          data-changes-errors
          className="shrink-0 border-b border-amber-500/40 bg-amber-500/10 px-4 py-1.5 text-xs text-amber-300"
        >
          {readErrors.length} 个项目流水读取失败：
          {readErrors.map((e) => `${e.project_id}（${e.message}）`).join("；")}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error ? (
          <p className="px-4 py-3 text-xs text-red-400">读取失败：{error}</p>
        ) : lines.length === 0 && !loading ? (
          <p className="px-4 py-6 text-center text-xs text-neutral-600">
            {applied ? "没有匹配该路径的变更记录" : source.emptyText}
          </p>
        ) : groups ? (
          // 按文件分组：每组折叠（details/summary），组头 = 路径 + 条数 + 最近一次时间
          <div data-changes-groups className="px-2 py-1">
            {groups.map(([path, arr]) => (
              <details key={path} className="border-b border-neutral-800/60">
                <summary className="flex cursor-pointer items-baseline gap-3 px-2 py-1.5 text-xs hover:bg-neutral-900">
                  <span className="min-w-0 flex-1 truncate text-neutral-200" title={path}>
                    {path}
                  </span>
                  <span className="shrink-0 text-[10px] text-neutral-600">
                    {arr.length} 条 · 最近 {arr[0].ts.slice(11, 19)}
                  </span>
                </summary>
                <ul>
                  {arr.map((l, i) => (
                    <ChangeRow key={`${l.ts}-${i}`} line={l} project={source.projectLabel(l)} />
                  ))}
                </ul>
              </details>
            ))}
          </div>
        ) : (
          <ul data-changes-list>
            {lines.map((l, i) => (
              <ChangeRow
                key={`${l.ts}-${l.path}-${i}`}
                line={l}
                project={source.projectLabel(l)}
              />
            ))}
          </ul>
        )}
      </div>

      <footer className="flex shrink-0 items-center justify-between border-t border-neutral-800 px-4 py-2">
        <span className="text-[10px] text-neutral-600">
          已加载 {lines.length} / {total} 条（每页 {CHANGES_PAGE_SIZE}）
        </span>
        {hasMore && (
          <button
            data-changes-more
            disabled={loading}
            onClick={() => load(false, applied, projectFilter, lines)}
            className="rounded border border-neutral-700 px-3 py-1 text-xs text-neutral-300 hover:bg-neutral-800 disabled:opacity-50"
          >
            {loading ? "加载中…" : "加载更多"}
          </button>
        )}
      </footer>
    </div>
  );
}
