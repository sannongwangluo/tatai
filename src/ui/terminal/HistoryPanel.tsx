// E3：单 pane 的命令历史面板（DESIGN.md §3.7 二期「命令历史检索」）——
// 头部「历史」入口展开本组件，三件事：**列出**（时间倒序、cwd、命令）、**实时搜索**（关键字过滤）、
// **一键回填**（点一条 → 把命令写进当前 pane 的输入行，**不自动执行**，回车仍由用户按）。
//
// 数据全部来自后端 `GET /api/projects/:id/terminal/history`（数据源 = 塔台自管落盘的
// `<项目根>/.工作台/logs/terminal-history.jsonl`，跨会话有效；**不读 shell 自己的历史文件**）。
// 清空是本面板唯一写动作，且**必须二次确认**（隐私红线：用户得能删，但不能一抖手就删）。
import { useEffect, useRef, useState } from "react";
import {
  clearTerminalHistory,
  getTerminalHistory,
  type TerminalHistoryLine,
} from "../api";

/** 搜索防抖：键盘每敲一下都查后端没必要，200ms 内只发最后一次 */
const SEARCH_DEBOUNCE_MS = 200;
/** 一次最多列多少条（后端上限 500；这里取 100，够翻，不拖慢面板） */
const LIST_LIMIT = 100;

export function HistoryPanel({
  projectId,
  onPick,
}: {
  projectId: string;
  /** 点一条时回调：把命令回填到本 pane 输入行（不执行），由 pane 负责真正写 stdin */
  onPick: (command: string) => void;
}) {
  const [q, setQ] = useState("");
  const [items, setItems] = useState<TerminalHistoryLine[]>([]);
  const [total, setTotal] = useState(0);
  const [file, setFile] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  /** 面板每次打开/搜索都重新拉，用序号丢弃过期响应（快敲时后到的旧响应不许覆盖新结果） */
  const reqSeq = useRef(0);

  const load = async (keyword: string) => {
    const seq = ++reqSeq.current;
    setLoading(true);
    try {
      const result = await getTerminalHistory(projectId, keyword || undefined, LIST_LIMIT);
      if (seq !== reqSeq.current) return; // 过期响应丢弃
      setItems(result.items);
      setTotal(result.total);
      setFile(result.file);
      setError(null);
    } catch (e) {
      if (seq !== reqSeq.current) return;
      setError((e as Error).message);
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  };

  useEffect(() => {
    const t = setTimeout(() => void load(q), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
    // load 每次渲染都是新引用，依赖它会把防抖变成每次都重跑；这里只按 q / 项目变化触发
  }, [q, projectId]);

  const doClear = async () => {
    setConfirmClear(false);
    try {
      const r = await clearTerminalHistory(projectId);
      setNote(`已清空本项目历史：删除 ${r.removed_lines} 条记录、${r.removed_files} 个归档文件`);
      setQ("");
      await load("");
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div
      data-terminal-history-panel
      className="flex max-h-64 shrink-0 flex-col gap-1 border-b border-neutral-800 bg-neutral-900/80 px-2 py-1.5 text-[11px]"
    >
      <div className="flex items-center gap-2">
        <input
          data-terminal-history-search
          value={q}
          onChange={(e) => {
            setNote(null);
            setQ(e.target.value);
          }}
          placeholder="搜索命令 / 工作目录（跨会话；实时过滤）"
          className="min-w-0 flex-1 rounded border border-neutral-700 bg-neutral-950 px-1.5 py-0.5 text-neutral-200 placeholder:text-neutral-600"
        />
        <span data-terminal-history-count className="shrink-0 text-neutral-500">
          {loading ? "查询中…" : `${items.length} / ${total} 条`}
        </span>
        <button
          data-terminal-history-clear
          onClick={() => setConfirmClear(true)}
          title="清空**本项目**的全部命令历史（不可撤销；前端会先让你确认一次）"
          className="shrink-0 rounded border border-neutral-700 px-1.5 py-0.5 text-neutral-400 hover:bg-neutral-800"
        >
          清空
        </button>
      </div>
      {confirmClear && (
        <div
          data-terminal-history-confirm
          className="flex items-center gap-2 rounded border border-red-900 bg-red-950/40 px-1.5 py-1 text-red-300"
        >
          <span className="shrink-0">确认清空本项目历史？不可撤销。</span>
          <button
            data-terminal-history-confirm-yes
            onClick={() => void doClear()}
            className="shrink-0 rounded border border-red-700 px-1.5 py-0.5 hover:bg-red-900"
          >
            确认清空
          </button>
          <button
            data-terminal-history-confirm-no
            onClick={() => setConfirmClear(false)}
            className="shrink-0 rounded border border-neutral-700 px-1.5 py-0.5 text-neutral-300 hover:bg-neutral-800"
          >
            取消
          </button>
        </div>
      )}
      {note && (
        <p data-terminal-history-note className="shrink-0 text-emerald-400">
          {note}
        </p>
      )}
      {error && (
        <p data-terminal-history-error className="shrink-0 text-red-400">
          历史查询失败:{error}
        </p>
      )}
      {items.length === 0 && !loading && !error ? (
        <p data-terminal-history-empty className="shrink-0 px-1 py-1 text-neutral-500">
          {q ? `没有命中「${q}」的命令` : "本项目还没有命令历史（在终端里敲一条就记下来了）"}
        </p>
      ) : (
        <ul
          data-terminal-history-list
          className="min-h-0 flex-1 overflow-y-auto rounded border border-neutral-800"
        >
          {items.map((it, i) => (
            <li
              key={`${it.ts}#${it.session_id}#${i}`}
              data-terminal-history-item
              data-terminal-history-command={it.command}
              data-terminal-history-ts={it.ts}
              data-terminal-history-cwd={it.cwd}
              className="border-b border-neutral-800/60 last:border-b-0"
            >
              <button
                data-terminal-history-pick
                onClick={() => onPick(it.command)}
                title="点一下把这条命令回填到当前终端输入行（不自动执行，回车仍由你按）"
                className="w-full px-1.5 py-1 text-left hover:bg-neutral-800"
              >
                <span className="mr-2 shrink-0 text-neutral-500">{it.ts}</span>
                <span className="mr-2 text-neutral-600">{it.cwd}</span>
                <span className="whitespace-pre-wrap break-all font-mono text-neutral-200">
                  {it.command}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <p data-terminal-history-file className="shrink-0 text-neutral-600">
        落盘位置（项目私有，gitignore）：{file || "…"}
      </p>
    </div>
  );
}
