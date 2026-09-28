// C3 聊天 Tab（DESIGN.md §3.6 Flash 聊天视图）：每项目一个聊天页签。
// 会话列表侧栏（GET sessions，倒序+首条摘要）+「+ 新会话」；选中会话 GET :sid 读回历史
// （jsonl 落盘即事实源，刷新后可恢复，DoD③）。发问走 POST messages，fetch+ReadableStream
// 真流式读 SSE 逐 delta 上屏（不是等全文，DoD①）；assistant 气泡用 streamdown 渲染
// 流式 markdown。SSE error 事件显示可读错误条（user 行已落盘不丢消息）。
// D3 落稿（§3.5/§3.6 落稿笔）：点「落稿」→ 弹窗里 flash 把当前会话提炼成可编辑草稿
// （POST design/draft，只生成不落盘）→ 用户编辑确认 → POST design/append 写入 design.md
// （被纳管项目追加到末尾；塔台自身插到 DESIGN.md 附录 B 之前——2026-09-19 主人拍板解锁）；
// 不点就绝不写（聊天过程零 design.md 写入）。
// 密钥红线：前端只调 /api，body 只发 content/session_id——apiKey/baseURL 永远不进前端（C1）。
import { useEffect, useRef, useState } from "react";
import { Streamdown, type Components } from "streamdown";
import "streamdown/styles.css";
import type { ChatLine, ChatSessionSummary } from "../../server/chat";
import type { ChatActionView, ChatSelection } from "../../server/work/chatActions";
import {
  activateChatAction,
  createChatSession,
  deleteChatSession,
  getChatSession,
  listChatActions,
  listChatSessions,
  postDesignAppend,
  postDesignDraft,
  retryChatAction,
  sendChatMessage,
} from "../api";
import type { ProjectItem } from "../api";
import { useProjectScope } from "../projectScope";

/** assistant 气泡 markdown 渲染样式（与 DesignView 深色主题同口径；覆盖文字级元素，
 *  代码块交给 streamdown 默认组件） */
const mdComponents: Components = {
  h1: (p) => <h1 className="mt-4 mb-2 text-lg font-bold text-neutral-100" {...p} />,
  h2: (p) => (
    <h2
      className="mt-4 mb-2 border-b border-neutral-700 pb-1 text-base font-semibold text-neutral-100"
      {...p}
    />
  ),
  h3: (p) => <h3 className="mt-3 mb-1 text-sm font-semibold text-neutral-100" {...p} />,
  p: (p) => <p className="my-1.5" {...p} />,
  ul: (p) => <ul className="my-1.5 list-disc space-y-0.5 pl-5" {...p} />,
  ol: (p) => <ol className="my-1.5 list-decimal space-y-0.5 pl-5" {...p} />,
  blockquote: (p) => (
    <blockquote className="my-1.5 border-l-2 border-neutral-600 pl-3 text-neutral-400" {...p} />
  ),
  a: (p) => <a className="text-sky-400 underline" {...p} />,
  table: (p) => (
    <div className="my-2 overflow-x-auto">
      <table className="border-collapse text-xs" {...p} />
    </div>
  ),
  th: (p) => (
    <th
      className="border border-neutral-700 bg-neutral-900 px-2 py-1 text-left font-semibold"
      {...p}
    />
  ),
  td: (p) => <td className="border border-neutral-700 px-2 py-1 align-top" {...p} />,
  hr: () => <hr className="my-3 border-neutral-700" />,
};

export function ChatView({ project }: { project: ProjectItem }) {
  const [sessions, setSessions] = useState<ChatSessionSummary[] | null>(null);
  const [sid, setSid] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatLine[]>([]);
  const [sending, setSending] = useState(false);
  const [streamText, setStreamText] = useState<string | null>(null);
  /** 工具调用活动提示（试用增强二期）：模型正在读项目文件/搜代码时的一行动态，终答后清掉 */
  const [toolNote, setToolNote] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // D3 落稿弹窗：open=弹窗显隐；draft=null 表示草稿提炼中；busy=确认提交中
  const [commitOpen, setCommitOpen] = useState(false);
  const [commitDraft, setCommitDraft] = useState<string | null>(null);
  const [commitBusy, setCommitBusy] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [commitDone, setCommitDone] = useState<string | null>(null);
  /** 会话删除两击确认态（2026-09-19 主人试用报障：没有手动删会话入口）：
   *  第一击 × 进入待确认（记录 sessionId），第二击真删；点别处/删别的会话即取消 */
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  // ── V06-07：动作回执（§3.5–§3.6）──
  // 六阶段文案来自**服务端真实回执**（`label`），前端不猜、不推断状态；重开会话/重开进程也能读回。
  const [actions, setActions] = useState<ChatActionView[]>([]);
  /** 待审定的提案（正式修订的"人确认"入口）：要填审定依据 */
  const [basisOf, setBasisOf] = useState<Record<string, string>>({});
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  /** 未发草稿**按项目隔离**（§3.6：切项目不串稿；每个项目自己的半截话留着）。
   *  V06-08：从组件内 useState 换成 `projectScope`（sessionStorage 镜像）——切页签/刷新都不再清空草稿
   *  （§3.1「项目切换保留…聊天草稿」+ §3.14「刷新不丢草稿」）。 */
  const { scope: chatScope, patch: patchChatScope } = useProjectScope(project.id);
  const scrollRef = useRef<HTMLDivElement>(null);
  // 聊天输入框 ref（2026-09-19 主人试用报障：发送后光标不回输入框，每次要鼠标点回来）——
  // 发送瞬间把焦点拉回输入框；等待回答期间输入框也不再 disabled（disabled 会把焦点挤掉）
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // 流式累积用 ref 保证 onDelta 闭包拿到最新值（setState 只负责触发重渲染上屏）
  const accRef = useRef("");
  /** 当前项目的未发草稿（每项目一份，见 `projectScope`） */
  const draft = chatScope.chatDraft;
  const setDraft = (v: string) => patchChatScope({ chatDraft: v });
  // V06-07（§3.6「切项目不串稿」）：在飞的回包回来时可能已经切走项目——把"当前项目"放 ref，
  // 发送流程里每条晚到的 setState 都先确认"还是同一个项目"，旧项目的延迟回包写不进新项目的界面。
  const projectIdRef = useRef(project.id);
  useEffect(() => {
    projectIdRef.current = project.id;
  }, [project.id]);

  const refreshSessions = (selectFirst: boolean) =>
    listChatSessions(project.id)
      .then((list) => {
        setSessions(list);
        setLoadError(null);
        if (selectFirst) setSid(list[0]?.session_id ?? null);
      })
      .catch((e: Error) => setLoadError(e.message));

  // 删会话（两击确认后走这里）：删的是当前选中会话则切到余下第一个；发送中不允许删
  const removeSession = (target: string) => {
    if (sending) return;
    deleteChatSession(project.id, target)
      .then(() =>
        listChatSessions(project.id).then((list) => {
          setSessions(list);
          setConfirmDeleteId(null);
          setLoadError(null);
          if (sid === target) {
            const next = list[0]?.session_id ?? null;
            setSid(next);
            if (next === null) setMessages([]);
          }
        }),
      )
      .catch((e: Error) => setLoadError(e.message));
  };

  // 切项目联动：重拉会话列表并选中最新一个（stale 守卫防串项目）
  useEffect(() => {
    let stale = false;
    setSessions(null);
    setSid(null);
    setMessages([]);
    setLoadError(null);
    setSendError(null);
    setCommitOpen(false);
    setCommitDone(null);
    listChatSessions(project.id)
      .then((list) => {
        if (stale) return;
        setSessions(list);
        setSid(list[0]?.session_id ?? null);
      })
      .catch((e: Error) => {
        if (!stale) setLoadError(e.message);
      });
    return () => {
      stale = true;
    };
  }, [project.id]);

  // 切会话联动：GET :sid 读回 jsonl 消息数组（DoD③ 历史恢复的唯一数据源）
  useEffect(() => {
    if (sid === null) {
      setMessages([]);
      return;
    }
    let stale = false;
    getChatSession(project.id, sid)
      .then((msgs) => {
        if (!stale) {
          setMessages(msgs);
          setLoadError(null);
        }
      })
      .catch((e: Error) => {
        if (!stale) setLoadError(e.message);
      });
    return () => {
      stale = true;
    };
  }, [project.id, sid]);

  // V06-07：动作回执读回（重新打开会话/重开进程后仍能核实"做过什么"）——切项目/切会话都要重拉，
  // stale 守卫防串项目（旧项目延迟回包不许写进新项目的列表）。
  useEffect(() => {
    let stale = false;
    setActions([]);
    setActionError(null);
    listChatActions(project.id, sid)
      .then((list) => {
        if (!stale) setActions(list);
      })
      .catch(() => {
        /* 动作读不回不阻断聊天：错误只影响动作卡片 */
      });
    return () => {
      stale = true;
    };
  }, [project.id, sid]);

  // 新消息 / 流式增长时滚到底
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, streamText, actions]);

  const newSession = async () => {
    if (sending) return;
    try {
      const newSid = await createChatSession(project.id);
      await refreshSessions(false);
      setSid(newSid);
      setSendError(null);
      setCommitDone(null);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  };

  // D3 落稿第 ① 步：开弹窗 + 让 flash 把当前会话提炼成草稿（只生成，不落盘）
  const openCommit = async () => {
    if (sending || commitBusy) return;
    setCommitDone(null);
    setCommitOpen(true);
    setCommitError(null);
    setCommitDraft(null);
    if (sid === null) {
      setCommitError("当前还没有会话，先聊几句再落稿");
      return;
    }
    const useSid = sid;
    try {
      const { draft } = await postDesignDraft(project.id, useSid);
      // 用户可能在等待期间关了弹窗：已关闭就不回填草稿
      setCommitDraft(draft);
    } catch (e) {
      setCommitError((e as Error).message);
    }
  };

  // D3 落稿第 ② 步：用户确认（可编辑过）的草稿 → POST design/append 追加到 design.md 末尾
  const confirmCommit = async () => {
    const content = commitDraft ?? "";
    if (content.trim() === "" || commitBusy) return;
    setCommitBusy(true);
    setCommitError(null);
    try {
      const r = await postDesignAppend(project.id, content);
      setCommitOpen(false);
      setCommitDone(`已落稿到 design.md（${r.lines_before} → ${r.lines_after} 行）`);
    } catch (e) {
      setCommitError((e as Error).message);
    } finally {
      setCommitBusy(false);
    }
  };

  const send = async () => {
    const content = draft.trim();
    if (content === "" || sending) return;
    setSending(true);
    inputRef.current?.focus(); // 发送后光标留在输入框（Enter 发送/点按钮两态都覆盖）
    setSendError(null);
    setCommitDone(null);
    // V06-07：本轮属于哪个项目（晚到的回包只更新"还是这个项目"的界面）
    const forProject = project.id;
    const stillHere = () => projectIdRef.current === forProject;
    try {
      // 没有会话时先建（首次发问即开聊），会话文件落盘在 C2 层完成
      let useSid = sid;
      if (useSid === null) {
        useSid = await createChatSession(project.id);
        if (stillHere()) setSid(useSid);
      }
      // 乐观上屏 user 气泡（后端同步落盘 user 行在前，SSE 在后）
      if (stillHere()) {
        setMessages((prev) => [...prev, { role: "user", content, ts: new Date().toISOString() }]);
        setDraft("");
        accRef.current = "";
        setStreamText("");
        setToolNote(null);
      }
      const result = await sendChatMessage(
        project.id,
        useSid,
        content,
        (delta) => {
          accRef.current += delta;
          if (stillHere()) setStreamText(accRef.current);
        },
        // 工具活动提示：读文件/搜代码期间气泡还没字，这行让人知道它没卡死
        (info) => {
          if (stillHere()) setToolNote(info.summary);
        },
        // V06-07：动作回执上屏（服务端已落盘，这里只把同一份回执显示出来）
        (action) => {
          if (!stillHere()) return;
          setActions((prev) => [action, ...prev.filter((a) => a.action_id !== action.action_id)]);
        },
      );
      if (!stillHere()) return; // 旧项目的延迟回包：不写新项目的界面（会话/消息/动作都不串）
      setStreamText(null);
      setToolNote(null);
      if (result.error !== null) {
        // SSE error 事件：失败那一回合已由服务端如实落盘（Q34：assistant 行带 error），
        // 重新读回消息流，让它在会话里看得见——错误条只是即时提示，不是唯一痕迹
        setSendError(result.error);
        try {
          setMessages(await getChatSession(project.id, useSid));
        } catch {
          /* 读不回就保持现状：上面的错误条已说明失败原因 */
        }
      } else {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: result.full, ts: new Date().toISOString(), model: "" },
        ]);
      }
      // 列表的首条摘要/时间变了，重拉（动作回执也重读一次，以后端落盘为唯一事实源）
      await refreshSessions(false);
      if (!stillHere()) return;
      try {
        setActions(await listChatActions(project.id, useSid));
      } catch {
        /* 读不回就保持 SSE 那一条 */
      }
    } catch (e) {
      if (stillHere()) {
        setStreamText(null);
        setToolNote(null);
        setSendError((e as Error).message);
      }
    } finally {
      if (stillHere()) {
        setSending(false);
        inputRef.current?.focus(); // 回答完仍把光标留在输入框（§3.6：发送后保持焦点）
      } else {
        setSending(false);
      }
    }
  };

  // V06-07：续接失败动作（输入与幂等键都在服务端记录里，不会产生第二个动作）
  const retryAction = async (actionId: string) => {
    if (actionBusy !== null) return;
    setActionBusy(actionId);
    setActionError(null);
    try {
      const next = await retryChatAction(project.id, actionId);
      setActions((prev) => [next, ...prev.filter((a) => a.action_id !== next.action_id)]);
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setActionBusy(null);
    }
  };

  // V06-07：审定并激活提案——正式修订的**人确认**入口；gate/基线只在这里被真实写入
  const activateAction = async (actionId: string) => {
    const basis = (basisOf[actionId] ?? "").trim();
    if (basis === "" || actionBusy !== null) return;
    setActionBusy(actionId);
    setActionError(null);
    try {
      const next = await activateChatAction(project.id, actionId, {
        approved_by: "user",
        approval_basis: basis,
        approval_kind: "user_confirmed",
      });
      setActions((prev) => [next, ...prev.filter((a) => a.action_id !== next.action_id)]);
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setActionBusy(null);
    }
  };

  return (
    <div className="flex h-full w-full self-stretch" data-chat-view>
      {/* ── 会话列表侧栏：倒序 + 首条摘要，新建/切换 ── */}
      <aside className="flex w-56 shrink-0 flex-col border-r border-neutral-800">
        <div className="border-b border-neutral-800 p-2">
          <button
            data-new-session
            onClick={() => void newSession()}
            disabled={sending}
            className="w-full rounded border border-neutral-700 px-2 py-1.5 text-xs text-neutral-300 hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-40"
          >
            + 新会话
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto" data-session-list>
          {sessions === null ? (
            <p className="px-3 py-2 text-xs text-neutral-600">加载会话…</p>
          ) : sessions.length === 0 ? (
            <p className="px-3 py-2 text-xs text-neutral-600">
              还没有会话。点「+ 新会话」或直接发问开聊。
            </p>
          ) : (
            sessions.map((s) => (
              <div
                key={s.session_id}
                data-session-item
                data-session-id={s.session_id}
                role="button"
                tabIndex={0}
                onClick={() => {
                  if (sending) return;
                  setConfirmDeleteId(null); // 点条目本体 = 切过去看，顺带取消任何待确认删除
                  setSid(s.session_id);
                  setSendError(null);
                  setCommitDone(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    if (sending) return;
                    setConfirmDeleteId(null);
                    setSid(s.session_id);
                  }
                }}
                className={`relative block w-full cursor-pointer border-b border-neutral-900 px-3 py-2 text-left ${
                  sid === s.session_id
                    ? "bg-neutral-900 text-neutral-100"
                    : "text-neutral-400 hover:bg-neutral-900/60"
                }`}
              >
                <span className="block truncate pr-5 text-xs">
                  {s.first_message ?? "（空会话）"}
                </span>
                <span className="mt-0.5 block pr-5 text-[10px] text-neutral-600">
                  {s.message_count} 条 · {s.updated_at.slice(0, 16).replace("T", " ")}
                </span>
                <button
                  data-delete-session={s.session_id}
                  disabled={sending}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (confirmDeleteId === s.session_id) {
                      removeSession(s.session_id);
                    } else {
                      setConfirmDeleteId(s.session_id);
                    }
                  }}
                  title={
                    confirmDeleteId === s.session_id
                      ? "再点一次确认删除（连带聊天记录，不可恢复）"
                      : "删除会话"
                  }
                  className={`absolute right-1.5 top-1.5 rounded px-1 text-[10px] leading-4 disabled:cursor-not-allowed disabled:opacity-40 ${
                    confirmDeleteId === s.session_id
                      ? "bg-red-900/80 text-red-100"
                      : "text-neutral-600 hover:bg-neutral-800 hover:text-neutral-300"
                  }`}
                >
                  {confirmDeleteId === s.session_id ? "确认删" : "×"}
                </button>
              </div>
            ))
          )}
        </div>
      </aside>

      {/* ── 主区：工具栏（落稿入口）+ 消息流 + 输入框 ── */}
      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 items-center gap-2 border-b border-neutral-800 px-3 py-2">
          <h2 className="text-xs font-semibold text-neutral-300">
            {project.name} · Flash 聊天
          </h2>
          <span className="text-[10px] text-neutral-600">
            记录落盘 .工作台/chat/（§3.6：不点就绝不写设计书）
          </span>
          <div className="flex-1" />
          <button
            data-commit-button
            onClick={() => void openCommit()}
            disabled={sending}
            className="rounded border border-amber-700/60 bg-amber-950/40 px-3 py-1 text-xs font-semibold text-amber-300 hover:bg-amber-900/40 disabled:cursor-not-allowed disabled:opacity-40"
          >
            落稿
          </button>
        </header>
        {commitDone && (
          <p
            data-commit-success
            className="shrink-0 border-b border-green-800/50 bg-green-950/30 px-3 py-1.5 text-xs text-green-300"
          >
            {commitDone}
          </p>
        )}

        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {loadError ? (
            <p className="text-xs text-red-400">聊天加载失败:{loadError}</p>
          ) : messages.length === 0 && streamText === null && actions.length === 0 ? (
            <p className="mt-8 text-center text-xs text-neutral-600">
              {sid === null
                ? "在下方输入问题直接开聊（会自动新建会话）"
                : "空会话。在下方输入问题开始。"}
            </p>
          ) : (
            <div className="mx-auto max-w-3xl space-y-3">
              {messages.map((m, i) =>
                m.role === "user" ? (
                  <div key={i} className="flex justify-end">
                    <div
                      data-msg-user
                      className="max-w-[80%] whitespace-pre-wrap rounded-lg bg-sky-900/50 px-3 py-2 text-sm leading-6 text-neutral-100"
                    >
                      {m.content}
                    </div>
                  </div>
                ) : (
                  <div key={i} className="flex justify-start">
                    <div
                      data-msg-assistant
                      className="max-w-[85%] rounded-lg border border-neutral-800 bg-neutral-900/60 px-3 py-2 text-sm leading-6 text-neutral-200"
                    >
                      {m.content !== "" && (
                        <Streamdown mode="static" components={mdComponents}>
                          {m.content}
                        </Streamdown>
                      )}
                      {m.error && (
                        <p data-msg-assistant-error className="text-xs text-red-400">
                          这一回合没有答完:{m.error}
                        </p>
                      )}
                    </div>
                  </div>
                ),
              )}
              {streamText !== null && (
                <div className="flex justify-start">
                  <div
                    data-msg-streaming
                    className="max-w-[85%] rounded-lg border border-sky-800/60 bg-neutral-900/60 px-3 py-2 text-sm leading-6 text-neutral-200"
                  >
                    <Streamdown mode="streaming" components={mdComponents}>
                      {streamText}
                    </Streamdown>
                    <span className="mt-1 block text-[10px] text-sky-500">
                      {toolNote !== null ? `正在查项目：${toolNote}…` : "流式输出中…"}
                    </span>
                  </div>
                </div>
              )}
              {/* ── V06-07：动作回执卡片（六阶段文案来自服务端真实回执；重开会话也读得回） ── */}
              {actions.map((a) => (
                <div
                  key={a.action_id}
                  data-chat-action
                  data-action-id={a.action_id}
                  data-action-kind={a.kind}
                  data-action-status={a.status}
                  data-action-label={a.label}
                  className={`rounded border px-3 py-2 text-xs ${
                    a.status === "failed"
                      ? "border-red-800/60 bg-red-950/25 text-red-200"
                      : a.status === "review_needed"
                        ? "border-amber-700/50 bg-amber-950/25 text-amber-100"
                        : a.status === "applied"
                          ? "border-green-800/50 bg-green-950/25 text-green-100"
                          : "border-neutral-700 bg-neutral-900/50 text-neutral-300"
                  }`}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span data-action-phase className="font-semibold">
                      {a.label}
                    </span>
                    <span className="text-neutral-400">{a.kind_label}</span>
                    <span className="text-neutral-500">{a.trigger.replace(/\s+/g, " ").slice(0, 60)}</span>
                    {a.archived && <span className="text-neutral-500">（会话已归档，引用保留）</span>}
                  </div>
                  {a.result_ref?.path !== null && a.result_ref?.path !== undefined && (
                    <p data-action-result className="mt-1 break-all text-neutral-400">
                      产物：{a.result_ref.path}
                    </p>
                  )}
                  {a.affected_ids.length > 0 && (
                    <p data-action-affected className="mt-1 break-all text-neutral-500">
                      影响：{a.affected_ids.slice(0, 8).join("、")}
                      {a.affected_ids.length > 8 ? `…（共 ${a.affected_ids.length} 项）` : ""}
                    </p>
                  )}
                  {a.tool_receipts.length > 0 && (
                    <ul className="mt-1 space-y-0.5 text-neutral-500">
                      {a.tool_receipts.map((r, i) => (
                        <li key={`${a.action_id}-${i}`} data-action-receipt={r.tool}>
                          {r.ok ? "成功" : "失败"}·{r.tool}·{r.write ? "已写盘" : "只读"}：{r.summary}
                        </li>
                      ))}
                    </ul>
                  )}
                  {a.error !== null && (
                    <p data-action-error className="mt-1 text-red-300">
                      失败原因：{a.error.message}
                    </p>
                  )}
                  {a.status === "failed" && (
                    <button
                      data-action-retry={a.action_id}
                      disabled={actionBusy !== null}
                      onClick={() => void retryAction(a.action_id)}
                      className="mt-2 rounded border border-neutral-700 px-2 py-1 text-[11px] hover:bg-neutral-800 disabled:opacity-40"
                    >
                      {actionBusy === a.action_id ? "续接中…" : "续接（重跑这一次动作）"}
                    </button>
                  )}
                  {a.status === "review_needed" && a.kind === "proposal" && (
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <input
                        data-action-basis={a.action_id}
                        value={basisOf[a.action_id] ?? ""}
                        onChange={(e) => setBasisOf((prev) => ({ ...prev, [a.action_id]: e.target.value }))}
                        placeholder="审定依据（必填；缺依据不能激活）"
                        className="min-w-48 flex-1 rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-[11px] text-neutral-200 placeholder:text-neutral-600"
                      />
                      <button
                        data-action-activate={a.action_id}
                        disabled={actionBusy !== null || (basisOf[a.action_id] ?? "").trim() === ""}
                        onClick={() => void activateAction(a.action_id)}
                        className="rounded bg-amber-700 px-2 py-1 text-[11px] font-semibold text-neutral-100 hover:bg-amber-600 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        {actionBusy === a.action_id ? "激活中…" : "审定并激活（人确认）"}
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {actionError && (
          <p
            data-action-op-error
            className="shrink-0 border-t border-red-900/60 bg-red-950/40 px-4 py-1.5 text-xs text-red-300"
          >
            动作操作失败:{actionError}
          </p>
        )}

        {sendError && (
          <p
            data-chat-error
            className="shrink-0 border-t border-red-900/60 bg-red-950/40 px-4 py-2 text-xs text-red-300"
          >
            发送失败:{sendError}（你发的消息已落盘保存）
          </p>
        )}

        <form
          className="flex shrink-0 items-end gap-2 border-t border-neutral-800 p-3"
          onSubmit={(ev) => {
            ev.preventDefault();
            void send();
          }}
        >
          <textarea
            ref={inputRef}
            data-chat-input
            rows={2}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // Enter 发送，Shift+Enter 换行
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder={sending ? "等待回答…（可先打字，回答完再按 Enter 发）" : "向 Flash 提问（Enter 发送，Shift+Enter 换行）"}
            className="flex-1 resize-none rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 placeholder:text-neutral-600 focus:border-sky-600 focus:outline-none disabled:opacity-50"
          />
          <button
            type="submit"
            data-chat-send
            disabled={sending || draft.trim() === ""}
            className="rounded bg-sky-700 px-4 py-2 text-xs font-semibold text-neutral-100 hover:bg-sky-600 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {sending ? "发送中…" : "发送"}
          </button>
        </form>
      </section>

      {/* ── D3 落稿预览/确认弹窗：草稿可编辑；确认才写 design.md，取消/关闭零写入 ── */}
      {commitOpen && (
        <div
          className="fixed inset-0 z-10 flex items-center justify-center bg-black/60"
          onClick={() => {
            if (!commitBusy) setCommitOpen(false);
          }}
        >
          <div
            data-commit-dialog
            className="flex max-h-[85vh] w-[42rem] max-w-[92vw] flex-col rounded-lg border border-neutral-700 bg-neutral-900 p-4 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="mb-1 text-sm font-semibold">落稿到 design.md</h2>
            <p className="mb-3 text-xs text-neutral-500">
              草稿由 Flash 从当前会话提炼，可在确认前编辑；确认后追加到 design.md 末尾（§3.5/§3.6：不点就绝不写）
            </p>
            {commitDraft === null && !commitError ? (
              <p
                data-commit-loading
                className="rounded border border-neutral-800 bg-neutral-950/60 px-3 py-6 text-center text-xs text-neutral-400"
              >
                Flash 正在提炼落稿草稿…
              </p>
            ) : (
              <textarea
                data-commit-draft
                value={commitDraft ?? ""}
                onChange={(e) => setCommitDraft(e.target.value)}
                disabled={commitBusy}
                rows={14}
                placeholder="（无草稿）"
                className="min-h-40 flex-1 resize-y rounded border border-neutral-700 bg-neutral-950 px-3 py-2 font-mono text-xs leading-5 text-neutral-200 placeholder:text-neutral-600 focus:border-amber-600 focus:outline-none disabled:opacity-50"
              />
            )}
            {commitError && (
              <p
                data-commit-error
                className="mt-2 rounded bg-red-900/40 px-2 py-1.5 text-xs text-red-300"
              >
                {commitError}
              </p>
            )}
            <div className="flex justify-end gap-2 pt-3 text-xs">
              <button
                data-commit-cancel
                onClick={() => setCommitOpen(false)}
                disabled={commitBusy}
                className="rounded bg-neutral-800 px-3 py-1.5 hover:bg-neutral-700 disabled:opacity-50"
              >
                取消
              </button>
              <button
                data-commit-confirm
                onClick={() => void confirmCommit()}
                disabled={commitBusy || commitDraft === null || commitDraft.trim() === ""}
                className="rounded bg-amber-700 px-3 py-1.5 font-semibold text-neutral-100 hover:bg-amber-600 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {commitBusy ? "落稿中…" : "确认落稿"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
