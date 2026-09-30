// R3 整体布局（DESIGN.md §3.1）：左栏两段——上半「Agent 管理」、下半「项目管理」。
// R4：点击项目 → URL hash（#p/<id>）记选中态（刷新/回退可恢复，不引 react-router），
// 调 open 接口写回 last_opened_at。
// ██ V06-08 主工作面重排（§3.1）██
//   · 主导航 = **项目图 / 设计书 / 施工图 / 聊天 / 实况与验收**（`data-main-nav`）。
//   · **终端移出用户主导航**，收进辅助入口的「维护诊断」组（`data-aux-nav`，按钮文案含"终端"）——
//     §3.1「辅助入口：最近变化 / 版本提醒 / 设置与诊断」+ §3.7「现有 xterm.js/node-pty 先保留在
//     维护诊断范围」。xterm.js / node-pty 依赖与后端 PTY 通道一个字都没动。
//   · **不加**"下一步用什么工具/模型/档位"卡，也不做任意 Tab 向导（§3.1 / §12.1 明令）。
//   · 顶栏按 §3.1 显示：当前项目 · 当前目标 · 有效版本 · 保存/连接状态（+ 观测时间）。
//   · 项目级现场（页面 / 草稿 / 选中项 / 滚动位置）走 `projectScope`，切项目各留各的；
//     异步回包落地前按项目核对，旧项目的响应不写进新项目的界面（§3.1）。
// H2：右栏顶部一行左侧放「最近变更 · N 条新」小入口（§3.1/§3.8，SSE 实时推送）。
// 文件监听生命周期跟选中态走——选中即 POST watch，取消选中/移除即 DELETE watch。
// P2：左栏「项目管理」区顶部加「跨项目视图」入口（hash `#all`）。
import { useCallback, useEffect, useRef, useState } from "react";
import {
  getActiveBaseline,
  getDiscussions,
  getLive,
  isBackendUnreachable,
  listProjects,
  openProject,
  unwatchProjectApi,
  watchProjectApi,
  type ProjectItem,
} from "./api";
import { AddProjectDialog } from "./components/AddProjectDialog";
import { AgentList } from "./components/AgentList";
import { AcceptanceView } from "./components/AcceptanceView";
import { ArchView } from "./components/ArchView";
import { ChangesEntry } from "./components/ChangesEntry";
import { ChatView } from "./components/ChatView";
import { DesignView } from "./components/DesignView";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { LiveView } from "./components/LiveView";
import { PlanView } from "./components/PlanView";
import { ProjectList } from "./components/ProjectList";
import { ProjectOverview } from "./components/ProjectOverview";
import { RemoveProjectDialog } from "./components/RemoveProjectDialog";
import { SyncEvidenceStatus } from "./components/SyncEvidenceStatus";
import { TerminalView } from "./components/TerminalView";
import { VersionReminder } from "./components/VersionReminder";
import { CrossProjectView } from "./projects/CrossProjectView";
import { useProjectScope, type ViewKey } from "./projectScope";
// 版本号与 package.json 同源（src/shared/version.ts，构建期内联）——页脚别再写死字面量
import { APP_VERSION } from "../shared/version";

/** 选中态存 URL hash：#p/<id>；空 hash = 未选中。
 *  Q65（2026-09-18 审计）：手改/外链 hash 成畸形编码（`#p/%`）时 decodeURIComponent 抛 URIError，
 *  而这个函数是在 App **自己的 render 体内**被调用的（useState 初始化器 + hashchange 处理器），
 *  视图区那个 ErrorBoundary 在出错点下面救不到 → React 18 卸载整棵树 = 整页白屏，且 hash 由浏览器
 *  保留、刷新即重抛。解不开就按"没选中"处理（界面照常可交互，刷新也不再炸）。 */
function selectedFromHash(): string | null {
  const h = window.location.hash;
  if (!h.startsWith("#p/")) return null;
  try {
    return decodeURIComponent(h.slice(3));
  } catch {
    return null;
  }
}

/** P2 跨项目视图的 hash：#all（未选中单项、右栏主区换成跨项目视图） */
const CROSS_HASH = "#all";
function crossFromHash(): boolean {
  return window.location.hash === CROSS_HASH;
}

/** 用户主导航：§3.1 的五页（终端不在其中） */
const MAIN_NAV: readonly [ViewKey, string][] = [
  ["arch", "项目图"],
  ["design", "设计书"],
  ["plan", "施工图"],
  ["chat", "聊天"],
  ["live", "实况与验收"],
];

/** 辅助入口（§3.1「最近变化 / 版本提醒 / 设置与诊断」）：终端在这里，标注"维护诊断" */
const AUX_NAV: readonly [ViewKey, string][] = [
  ["overview", "项目信息"],
  ["terminal", "终端（维护诊断）"],
];

/** 上下文背景页（`overview` / `terminal` 两个辅助入口）里主区怎么铺 */
const FULL_HEIGHT_VIEWS: readonly ViewKey[] = ["chat", "terminal", "arch", "live"];

export default function App() {
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  /** 首次拉取还没落地（2026-09-19 试用反馈：这期间渲染空列表＝「暂无项目」，看着像坏了） */
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(selectedFromHash);
  const [removing, setRemoving] = useState<ProjectItem | null>(null);
  /** Q51：开监听失败的原因（服务端 POST /watch 如实回错误），上屏一行提示 */
  const [watchError, setWatchError] = useState<string | null>(null);
  // P2：跨项目视图开关（hash `#all`）；与选中态互斥——`#all` 时右栏主区换成跨项目视图
  const [crossView, setCrossView] = useState<boolean>(crossFromHash);
  /** 列表最近一次**成功**拉到数据的时间（§3.1：自动重连不清空最后成功数据，并显示观测时间） */
  const [listObservedAt, setListObservedAt] = useState<string | null>(null);
  /** 内容区滚动容器（滚动位置按「项目 + 页」隔离，§3.1） */
  const viewHostRef = useRef<HTMLDivElement>(null);
  // V06-08：页面/草稿/选中项/滚动位置按项目隔离。未选中时给一个永不显示的占位桶。
  const { scope, patch } = useProjectScope(selectedId ?? "__none__");
  const view: ViewKey = selectedId === null ? "arch" : scope.view;

  // 换项目/换页时把该「项目 + 页」的滚动位置放回去（内容还没渲染时下一帧再试一次）
  useEffect(() => {
    const el = viewHostRef.current;
    if (el === null) return;
    const saved = scope.scroll[`view:${view}`] ?? 0;
    el.scrollTop = saved;
    const t = setTimeout(() => {
      if (viewHostRef.current !== null) viewHostRef.current.scrollTop = saved;
    }, 60);
    return () => clearTimeout(t);
    // 只在项目/页变化时归位，不跟着每次滚动抖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, view]);

  const refresh = useCallback(() => {
    return listProjects()
      .then((list) => {
        setProjects(list);
        setLoadError(null);
        setListObservedAt(new Date().toISOString());
      })
      .catch((e: Error) => setLoadError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Q103：连不上后端时重试（成功即停——refresh 会把 loadError 清掉）。
  // 2026-09-19 试用修订：3s → 0.5s。实测后端冷启动 ~1.2s 就绪，而连不上时 fetch 是
  // 本机 RST、瞬间落空——0.5s 重试几乎零代价，却能把「首屏空等」从最坏 3s+ 压到 <1s。
  // 只对"根本没连上"这一档重试：业务错误（如注册表坏了）重试没有意义，反而盖住真实原因。
  useEffect(() => {
    if (loadError === null || !isBackendUnreachable(loadError)) return;
    const timer = setInterval(refresh, 500);
    return () => clearInterval(timer);
  }, [loadError, refresh]);

  // 浏览器前进/后退或手工改 hash 时同步选中态与跨项目视图开关（两者互斥：`#all` 无选中项）
  useEffect(() => {
    const onHash = () => {
      setSelectedId(selectedFromHash());
      setCrossView(crossFromHash());
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // 选中即写回 last_opened_at（§2.3.1），写完刷新列表让「最近打开」时间同步上屏
  useEffect(() => {
    if (selectedId === null) return;
    openProject(selectedId)
      .then(refresh)
      .catch(() => {
        // 选中了一个已被移除的 id（如手改 hash）：回退空态，不报错
        setSelectedId(null);
        window.location.hash = "";
      });
  }, [selectedId, refresh]);

  // H2：文件监听生命周期跟选中态走（§3.9）——选中即开监听（POST watch，幂等），
  // 取消选中/切走/移除即关监听（DELETE watch，幂等）；不全局乱挂。
  // Q29：浏览器态直接关窗/刷新时 React 清理跑不到，补一条 pagehide 兜底。
  // Q51：开监听失败不再静默——服务端如实回错误，这里把它落到一行提示上。
  useEffect(() => {
    if (selectedId === null) {
      setWatchError(null);
      return;
    }
    const id = selectedId;
    setWatchError(null);
    watchProjectApi(id)
      .then(() => setWatchError(null))
      .catch((e: Error) => setWatchError(e.message));
    const onPageHide = (e: PageTransitionEvent) => {
      if (e.persisted) return;
      unwatchProjectApi(id, { keepalive: true }).catch(() => {});
    };
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      unwatchProjectApi(id).catch(() => {});
    };
  }, [selectedId]);

  function handleRemoved(id: string) {
    setRemoving(null);
    if (selectedId === id) {
      setSelectedId(null);
      window.location.hash = "";
    }
    refresh();
  }

  const selected = projects.find((p) => p.id === selectedId) ?? null;

  return (
    <div className="flex h-screen bg-neutral-950 text-neutral-100">
      {/* ── 左栏（DESIGN.md §3.1）：上半 Agent 管理，下半 项目管理 ── */}
      <aside className="flex w-64 shrink-0 flex-col border-r border-neutral-800">
        <header className="border-b border-neutral-800 px-3 py-2.5">
          <h1 className="text-sm font-bold">塔台 Tatai</h1>
        </header>

        {/* 上半：Agent 管理（M4：经 MCP 接入的 agent 列表 + 最近活跃时间） */}
        <section className="border-b border-neutral-800">
          <h2 className="px-3 pt-2.5 pb-1 text-xs font-semibold text-neutral-400">
            Agent 管理
          </h2>
          <AgentList />
        </section>

        {/* 下半：项目管理（项目列表 + 添加入口）；P2 在列表上方加「跨项目视图」入口 */}
        <section className="flex min-h-0 flex-1 flex-col">
          <h2 className="px-3 pt-2.5 pb-1 text-xs font-semibold text-neutral-400">
            项目管理
          </h2>
          <div className="px-2 pb-1">
            <button
              data-entry="cross-project"
              onClick={() => {
                window.location.hash = CROSS_HASH;
              }}
              className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs ${
                crossView
                  ? "bg-neutral-800 text-neutral-100 ring-1 ring-neutral-600"
                  : "text-neutral-300 hover:bg-neutral-800"
              }`}
              title="一屏看全部项目的进展（Gate 当前步 / 模块状态 / 最近活动）"
            >
              <span>跨项目视图</span>
              <span className="ml-auto text-[10px] text-neutral-500">{projects.length} 个</span>
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto pb-2">
            {loadError ? (
              <div data-app-load-error className="px-3 py-2 text-xs">
                <p className="text-red-400">列表加载失败：{loadError}</p>
                {isBackendUnreachable(loadError) && (
                  <p data-backend-unreachable className="mt-1 text-amber-400">
                    后端未就绪：连不上本机后端服务（壳拉起的服务没起来或已退出，也可能是端口被占）。
                    打包态的失败原因见数据目录下的 <code>logs/shell.log</code> 与 <code>logs/backend.log</code>；
                    dev 态确认 <code>pnpm dev:server</code> 在跑。每 0.5 秒自动重试，后端起来后这里会自己消失。
                    {projects.length > 0 && listObservedAt !== null && (
                      <span data-list-stale-note className="mt-1 block text-amber-300">
                        下面是上一次成功读到的 {projects.length} 个项目（观测时间{" "}
                        <span data-observed-at={listObservedAt}>{listObservedAt}</span>
                        ）——重连不会清空它。
                      </span>
                    )}
                  </p>
                )}
              </div>
            ) : loading ? (
              /* 2026-09-19 试用反馈：首次拉取落地前渲染空列表＝「暂无项目」，看着像加载坏了。
                 加载中明示出来；fetch 一落地（成败都算）这个状态就消失。 */
              <p data-app-loading className="animate-pulse px-3 py-2 text-xs text-neutral-500">
                加载中…
              </p>
            ) : (
              <ProjectList
                projects={projects}
                selectedId={selectedId}
                onSelect={(id) => {
                  setSelectedId(id);
                  window.location.hash = `#p/${encodeURIComponent(id)}`;
                }}
                onRemove={setRemoving}
              />
            )}
          </div>
          <div className="border-t border-neutral-800 p-2">
            <button
              onClick={() => setDialogOpen(true)}
              className="w-full rounded border border-neutral-700 px-2 py-1.5 text-xs text-neutral-300 hover:bg-neutral-800"
            >
              + 添加项目
            </button>
          </div>
        </section>
        {/* 品牌印记：出品方与版本常驻左栏底部（开源 AGPL-3.0，标识归属见 README） */}
        <div
          className="border-t border-neutral-800 px-3 py-1.5 text-[9px] text-neutral-700"
          data-brand-footer="tatai"
          title="塔台 Tatai · 杭州三农网络科技有限公司 · GNU AGPL-3.0"
        >
          Tatai v{APP_VERSION} · 杭州三农网络科技有限公司 · AGPL-3.0
        </div>
      </aside>

      {/* ── 右栏主区：跨项目视图 / 选中项目 → 顶栏（当前项目·目标·有效版本·保存状态）+ 主导航 ── */}
      <main className="flex flex-1 flex-col overflow-hidden">
        <ErrorBoundary>
        {crossView ? (
          <CrossProjectView
            onOpenProject={(id) => {
              setCrossView(false);
              setSelectedId(id);
              window.location.hash = `#p/${encodeURIComponent(id)}`;
            }}
          />
        ) : selected ? (
          <>
            {/* §3.1 顶部一行：左侧「最近变更 · N 条新」与「版本提醒」两个辅助入口，右侧主导航（五页） */}
            <div className="flex shrink-0 flex-wrap items-end gap-3 border-b border-neutral-800 px-3 pt-2">
              <ChangesEntry project={selected} />
              {/* V06-12：辅助入口「版本提醒」（§3.1）——轻量提醒卡，只读探测；不占主导航、不加 Tab */}
              <VersionReminder project={selected} />
              {watchError && (
                <span
                  className="pb-1.5 text-[10px] text-red-400"
                  title={watchError}
                  data-watch-error="1"
                >
                  文件监听未起：{watchError}
                </span>
              )}
              <nav data-main-nav className="ml-auto flex gap-1">
                {MAIN_NAV.map(([key, label]) => (
                  <button
                    key={key}
                    data-view={key}
                    onClick={() => patch({ view: key })}
                    className={`rounded-t px-3 py-1.5 text-xs ${
                      view === key
                        ? "border border-b-0 border-neutral-800 bg-neutral-900 text-neutral-100"
                        : "text-neutral-500 hover:text-neutral-300"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </nav>
            </div>

            {/* 辅助入口（§3.1）：终端移到这里，明确标「维护诊断」；不占主导航 */}
            <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-neutral-800 bg-neutral-900/40 px-3 py-1">
              <span className="text-[10px] text-neutral-500">辅助入口</span>
              <nav data-aux-nav className="flex gap-1">
                {AUX_NAV.map(([key, label]) => (
                  <button
                    key={key}
                    data-view={key}
                    onClick={() => patch({ view: key })}
                    className={`rounded px-2 py-0.5 text-[11px] ${
                      view === key
                        ? "bg-neutral-800 text-neutral-100 ring-1 ring-neutral-600"
                        : "text-neutral-400 hover:bg-neutral-800"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </nav>
              {/* §3.11：必要待决事项在主工作面可见（数量 + 一键跳去处理），不打断工作 */}
              <PendingDecisions project={selected} onOpen={() => patch({ view: "design" })} />
              <span className="text-[10px] text-neutral-600">
                终端仅供维护诊断（用户主导航已移除，§3.1/§3.7）；xterm.js / node-pty 与后端 PTY 通道保留
              </span>
            </div>

            <ProjectStatusBar project={selected} />

            {/* V09-24（§2.10）：同步证据状态**小摘要入口**——只占状态条下面一行，详情是浮层；
                不加大页签、不遮图、不挤画布。点开逐项看期望/实际/原因/证据路径。 */}
            <SyncEvidenceStatus project={selected} />

            <div
              ref={viewHostRef}
              data-view-host
              onScroll={(e) => {
                // 滚动位置按「项目 + 页」隔离（§3.1）；键用 `view:<页>` 与页内自己的滚动键分开
                patch({ scroll: { ...scope.scroll, [`view:${view}`]: (e.target as HTMLDivElement).scrollTop } });
              }}
              className={
                FULL_HEIGHT_VIEWS.includes(view)
                  ? "flex min-h-0 flex-1"
                  : "flex flex-1 items-center justify-center overflow-y-auto"
              }
            >
              {view === "overview" ? (
                <ProjectOverview project={selected} />
              ) : view === "design" ? (
                <DesignView project={selected} />
              ) : view === "plan" ? (
                <PlanView project={selected} />
              ) : view === "terminal" ? (
                <TerminalView project={selected} />
              ) : view === "arch" ? (
                <ArchView project={selected} />
              ) : view === "live" ? (
                <LiveOrAcceptance project={selected} />
              ) : (
                <ChatView project={selected} />
              )}
            </div>
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center">
            <div className="space-y-2 text-center">
              <p className="text-lg text-neutral-300">选择一个项目开始</p>
              <p className="text-xs text-neutral-600">
                在左侧「项目管理」选择项目，或用「+ 添加项目」登记新目录
              </p>
            </div>
          </div>
        )}
        </ErrorBoundary>
      </main>

      {dialogOpen && (
        <AddProjectDialog onClose={() => setDialogOpen(false)} onAdded={refresh} />
      )}
      {removing && (
        <RemoveProjectDialog
          project={removing}
          onClose={() => setRemoving(null)}
          onRemoved={handleRemoved}
        />
      )}
    </div>
  );
}

/**
 * 必要待决事项（§3.11）：主工作面看得见"有几件事等我决定"，点开直接去处理。
 * 只数**还没处置完**的（待处理 / 已提出）——已采纳/驳回/被替代的不再算待决。
 * 数据来自 `GET discussions`（与设计书页同一份派生态），读不到就如实说读不到，不显示 0 冒充"没事"。
 */
function PendingDecisions({ project, onOpen }: { project: ProjectItem; onOpen: () => void }) {
  const [count, setCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const idRef = useRef(project.id);
  idRef.current = project.id;
  useEffect(() => {
    const id = project.id;
    setCount(null);
    setError(null);
    getDiscussions(id)
      .then((d) => {
        if (idRef.current !== id) return;
        setCount(
          d.entries.filter((e) => e.disposition.status === "none" || e.disposition.status === "proposed").length,
        );
      })
      .catch((e: Error) => {
        if (idRef.current === id) setError(e.message);
      });
  }, [project.id]);
  const pending = count !== null && count > 0;
  return (
    <button
      data-pending-decisions={count === null ? "unknown" : String(count)}
      onClick={onOpen}
      title={error ?? "跳到设计书的待议区处置（提出/采纳/驳回/被替代，§3.5）"}
      className={`rounded px-2 py-0.5 text-[11px] ${
        error !== null
          ? "border border-amber-700 text-amber-300"
          : pending
            ? "border border-amber-600 bg-amber-900/40 text-amber-100"
            : "text-neutral-400 hover:bg-neutral-800"
      }`}
    >
      {error !== null ? "待决事项：读不到" : count === null ? "待决事项：读取中…" : `待决事项 ${count}`}
    </button>
  );
}

/**
 * 顶栏状态（§3.1「顶部：当前项目 · 当前目标 · 有效版本 · 保存/连接状态」+ §3.9）。
 * 只读合成：`GET live` 给阶段/当前卡，`GET documents` 给生效基线。
 * §3.1 的**自动重连不清空最后成功数据并显示观测时间**也在这里落地：
 * 拉失败时**保留**上一次成功的值，只把连接状态改成"失败（重试中）"并保留观测时间。
 */
function ProjectStatusBar({ project }: { project: ProjectItem }) {
  const [stage, setStage] = useState<string | null>(null);
  const [currentTask, setCurrentTask] = useState<string | null>(null);
  const [baselineId, setBaselineId] = useState<string | null>(null);
  const [baselineKnown, setBaselineKnown] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [observedAt, setObservedAt] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const idRef = useRef(project.id);
  idRef.current = project.id;

  useEffect(() => {
    const id = project.id;
    setStage(null);
    setCurrentTask(null);
    setBaselineId(null);
    setBaselineKnown(false);
    setError(null);
    setObservedAt(null);
    Promise.all([getLive(id), getActiveBaseline(id)])
      .then(([live, base]) => {
        if (idRef.current !== id) return; // 换项目了：这份回包作废（§3.1）
        setStage(live.stage);
        setCurrentTask(live.current_task === null ? null : `${live.current_task.id}「${live.current_task.title}」`);
        setBaselineId(base.active === null ? null : base.active.baseline_id);
        setBaselineKnown(true);
        setError(null);
        setObservedAt(new Date().toISOString());
      })
      .catch((e: Error) => {
        if (idRef.current !== id) return;
        // 保留最后成功数据，只标连接失败（不许清空成"未知"以外的东西）
        setError(e.message);
      });
  }, [project.id, tick]);

  // 连不上就自动重连（不清空上面的最后成功值）；成功一次即停
  useEffect(() => {
    if (error === null || !isBackendUnreachable(error)) return;
    const timer = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(timer);
  }, [error]);

  return (
    <div
      data-project-status-bar
      data-connection={error === null ? "ok" : "failed"}
      {...(observedAt === null ? {} : { "data-observed-at": observedAt })}
      className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b border-neutral-800 bg-neutral-900/30 px-3 py-1.5 text-[11px]"
    >
      <span data-status-project>
        当前项目：<span className="text-neutral-200">{project.name}</span>
      </span>
      <span data-status-goal>
        当前目标：
        <span className="text-neutral-200">
          {currentTask ?? stage ?? (error === null ? "（读取中…）" : "（上次成功读到的目标仍在上方，连接恢复后更新）")}
        </span>
      </span>
      <span data-status-version>
        有效版本：
        <span className="text-neutral-200">
          {!baselineKnown ? "（读取中…）" : baselineId === null ? "尚未激活基线" : baselineId}
        </span>
      </span>
      <span
        data-status-save
        className={error === null ? "text-neutral-400" : "text-amber-300"}
      >
        {error === null ? "保存/连接：已连接" : `保存/连接：连接失败（自动重连中）`}
      </span>
      <span data-status-observed className="text-neutral-500">
        观测时间：{observedAt ?? "（还没有成功观测）"}
      </span>
      {error !== null && (
        <span title={error} data-status-error className="min-w-0 flex-1 truncate text-red-400">
          {error}
        </span>
      )}
    </div>
  );
}

/** 实况与验收（§3.1 第五页）：两个子页签——实况（§3.10）/ 验收（§3.10 待验收区 + §3.4 阶段摘要） */
function LiveOrAcceptance({ project }: { project: ProjectItem }) {
  const { scope, patch } = useProjectScope(project.id);
  const sub = scope.liveSub;
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-live-page>
      <div className="flex shrink-0 items-center gap-2 border-b border-neutral-800 px-3 py-1.5">
        <nav data-live-sub-nav className="flex gap-1">
          {(
            [
              ["live", "实况"],
              ["acceptance", "验收"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              data-live-sub={key}
              onClick={() => patch({ liveSub: key })}
              className={`rounded px-2.5 py-1 text-xs ${
                sub === key
                  ? "border border-neutral-700 bg-neutral-800 text-neutral-100"
                  : "text-neutral-500 hover:text-neutral-300"
              }`}
            >
              {label}
            </button>
          ))}
        </nav>
        <span className="text-[11px] text-neutral-600">
          {sub === "live"
            ? "谁在干 / 干到哪 / 刚干了什么（§3.10；无新观测只提示，不judge 项目失败）"
            : "待验收区：场景、检查结果、限制与退回原因（§3.10）；人工验收只由用户记录（§5.8）"}
        </span>
      </div>
      <div className="flex min-h-0 flex-1 overflow-y-auto">
        {sub === "live" ? <LiveView project={project} /> : <AcceptanceView project={project} />}
      </div>
    </div>
  );
}
