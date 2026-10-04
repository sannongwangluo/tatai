// M4 左栏上半「Agent 管理」列表（DESIGN.md §3.1）。
// 数据源：GET /api/agents（全局 agents.json，last_active_at 倒序，后端排好）。
// 刷新口径：挂载即拉一次 + 每 30s 轻刷新（相对时间显示也随之重算，不用 SSE）。
// 2026-09-19 试用修订：① 首拉落地前显示「加载中」——原来空数据渲染成「暂无接入 agent」，
// 冷启动窗口里看着像坏了；② 连不上后端（壳先开窗后起服务，冷启动必现）加 0.5s 快重试
// （与 App 项目列表同款，判定 isBackendUnreachable 共享自 ./api）——原来只能干等 30s 周期。
// 2026-09-21 用户拍板：列表最多显示 6 个（后端已按最近活跃倒序，取前 6 即可），超出的
// 折叠为一行计数提示，不再撑高左栏上半区。
import { useCallback, useEffect, useState } from "react";
import { isBackendUnreachable, listAgents } from "../api";
import type { AgentRecord } from "../../server/agents";

/** 左栏上半区最多显示的 agent 数（2026-09-21 用户拍板，DESIGN.md §3.1 同口径） */
const MAX_VISIBLE_AGENTS = 6;

/** 相对时间显示：刚刚 / N 分钟前 / N 小时前 / N 天前；超过 30 天落回日期 */
function relativeTime(iso: string): string {
  const t = new Date(iso).getTime();
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

export function AgentList({ onErrorChange }: { onErrorChange?: (error: string | null) => void } = {}) {
  const [agents, setAgents] = useState<AgentRecord[]>([]);
  /** 首拉落地前 true：渲染「加载中」而不是误导性的「暂无接入 agent」 */
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { onErrorChange?.(error); }, [error, onErrorChange]);

  const load = useCallback(() => {
    return listAgents()
      .then((list) => {
        setAgents(list);
        setError(null);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoaded(true));
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 30_000);
    return () => clearInterval(timer);
  }, [load]);

  // 连不上后端：0.5s 快重试（成功即停——load 会把 error 清掉）；业务错误不重试，理由同 App。
  useEffect(() => {
    if (error === null || !isBackendUnreachable(error)) return;
    const timer = setInterval(() => void load(), 500);
    return () => clearInterval(timer);
  }, [error, load]);

  if (error) {
    return (
      <div className="px-3 pb-3 text-xs">
        <p className="text-red-400">加载失败：{error}</p>
        {isBackendUnreachable(error) && (
          <p className="mt-1 text-amber-400">后端未就绪，每 0.5 秒自动重试，起来后自愈。</p>
        )}
      </div>
    );
  }
  if (!loaded) {
    return (
      <p className="animate-pulse px-3 pb-3 text-xs text-neutral-500">加载中…</p>
    );
  }
  if (agents.length === 0) {
    return (
      <p className="px-3 pb-3 text-xs text-neutral-600">
        暂无接入 agent——任一 agent 调用一次 MCP 工具后出现在这里
      </p>
    );
  }
  const visibleAgents = agents.slice(0, MAX_VISIBLE_AGENTS);
  const hiddenCount = agents.length - visibleAgents.length;
  return (
    <ul className="space-y-0.5 px-2 pb-2">
      {visibleAgents.map((a: AgentRecord) => (
        <li
          key={a.id}
          title={`首次接入：${a.first_seen_at}\n最近活跃：${a.last_active_at}`}
          className="flex items-center gap-2 rounded px-2 py-1.5 text-sm"
        >
          {/* 活跃点：5 分钟内绿，其后灰 */}
          <span
            className={`h-2 w-2 shrink-0 rounded-full ${
              Date.now() - new Date(a.last_active_at).getTime() < 5 * 60_000
                ? "bg-green-500"
                : "bg-neutral-500"
            }`}
          />
          <span className="min-w-0 flex-1 truncate">{a.name}</span>
          <span className="shrink-0 text-[10px] text-neutral-500">
            {relativeTime(a.last_active_at)}
          </span>
        </li>
      ))}
      {hiddenCount > 0 && (
        <li className="px-2 pt-1 text-[10px] text-neutral-600">
          另有 {hiddenCount} 个不常活跃的 agent 未显示
        </li>
      )}
    </ul>
  );
}
