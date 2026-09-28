// E1：单个终端 pane（DESIGN.md §3.7 二期「多终端分屏」的最小单元）——**一个 pane 一个独立 PTY 会话**。
// 从 T2 的 TerminalView 原样抽出，保证"独立"三件套全部 per-pane：独立 xterm 实例、独立 EventSource、
// 独立 ResizeObserver + resize 上报；会话 id 只活在本组件自己的 ref 里，绝不由容器传递给别的 pane。
// （PLAN E1 跑偏点：多个 pane 共用一个 PTY，键盘输入会串台——本文件里没有任何跨 pane 的共享会话状态。）
// 生命周期与 T2 一致：建会话（cwd=项目根，后端锁）→ SSE 上屏 → onData 回写（promise 链串行化，
// 防 "mode" 变 "moed" 的乱序）→ ResizeObserver → fit 自适应 + POST resize 防抖 150ms；
// 卸载即关自己的会话（幂等），不碰别的 pane。
// E1 增量：头部显示本 pane 的会话 cwd（DoD④ 便于用户核对，来源 = 建会话响应，UI 不自己拼路径）；
// 请求均带 `?project_id=`（后端会话隔离，A 项目的 sid 在 B 项目上不可用）。
//
// E2 增量：**日志着色层**（`logColor.ts`）夹在 SSE 与 xterm 之间——只往流里**插入** SGR 序列给级别关键词上色，
// 关键词与正文一个字节都不动。原始流另存在 `rawRef`（与着色路径完全无关），
// 「导出原始输出」导出的就是它，逐字节等于源输出（PLAN E2 跑偏点：不许把 ANSI 吞掉）。
// 头部一个开关（默认开）：关掉后写进 xterm 的字节 = SSE 原始字节（`renderLogChunk(..., false) === raw`，DoD②）。
// 服务端 PTY 字节流一行没改——着色纯前端。
//
// E3 增量：头部「历史」入口 → `HistoryPanel.tsx`（列出/搜索/一键回填）。回填 = 把命令写进本 pane 的
// 输入行（`writeTerminalInput(sid, command, 项目 id)`，**不带 `\r`**）——终端里出现的就是输入行，
// 回车仍由用户按，绝不自动执行。写 stdin 走的还是 T2/E1 那条既有通道，pane 里没有第二条通路。
import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { ProjectItem } from "../api";
import {
  closeTerminalSession,
  createTerminal,
  resizeTerminalSession,
  terminalStreamUrl,
  writeTerminalInput,
} from "../api";
import {
  createLogColorState,
  flushLogColor,
  renderLogChunk,
  type LogColorState,
} from "./logColor";
import { HistoryPanel } from "./HistoryPanel";
import { RAW_BUFFER_MAX_CHARS, trimRawBuffer } from "./rawBuffer";

/** 扣住的尾巴最多等这么久就补吐一次（正常路径根本不会扣住，见 logColor.ts 的 tailToCarry） */
const CARRY_FLUSH_MS = 120;

export function TerminalPane({
  project,
  index,
  onClose,
}: {
  project: ProjectItem;
  /** pane 序号（0 起）：只用于显示与打点（data-terminal-pane-index），不参与会话身份 */
  index: number;
  onClose: () => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  /** 本 pane 收到的**原始输出流**（SSE 字节原样累积）：导出用它，与着色路径无关。
   *  有上限（见 RAW_BUFFER_MAX_CHARS）：超限从头部丢，丢了多少记在 rawDroppedRef。 */
  const rawRef = useRef("");
  /** 被上限砍掉的字符数（累计，跨多次 trim）：0 = 缓冲完整，导出就是整场会话 */
  const rawDroppedRef = useRef(0);
  /** 是否截断过（给 SSE 回调读，重置一次即可，避免每块都 setState） */
  const rawTruncatedRef = useRef(false);
  const [rawTruncated, setRawTruncated] = useState(false);
  /** E2 着色层状态（跨 chunk 的 sgrColored / carry / lastChar） */
  const colorStateRef = useRef<LogColorState>(createLogColorState());
  const [colorOn, setColorOn] = useState(true); // 默认开着色
  const colorOnRef = useRef(true); // 同一份状态给 SSE 回调读（回调闭包不随 state 重建）
  const [error, setError] = useState<string | null>(null);
  /**
   * Q67（2026-09-18 审计）：会话失效（后端先死/先重启而页面还活着）时，键盘 POST 会失败——
   * 此前 `.catch(() => {})` 把它**静默吞掉**，界面只有一句"连接断开"（还不提输入丢没丢）。
   * 现在如实上屏，并给一个「重开会话」出口。
   */
  const [sessionError, setSessionError] = useState<string | null>(null);
  /** 重开会话的触发器：进 effect 依赖 → 卸载旧会话、照原路重建一个（用户按需点，不自动重建） */
  const [rebuildNonce, setRebuildNonce] = useState(0);
  const [exitedCode, setExitedCode] = useState<number | null>(null);
  const [cwd, setCwd] = useState<string | null>(null);
  const [sid, setSid] = useState<string | null>(null);
  const [pid, setPid] = useState<number | null>(null);
  /** E3：历史面板开合（默认收起，头部按钮切换） */
  const [historyOpen, setHistoryOpen] = useState(false);
  /** E3：回填后的短提示（"已回填 XXX（未执行）"），2 秒后自己消失 */
  const [fillNote, setFillNote] = useState<string | null>(null);
  /** 回填/面板回调要拿到当前会话 id（回调闭包不重建） */
  const sidRef = useRef<string | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false; // StrictMode 双挂载/切项目时置位，晚到的建会话响应立即关闭
    let sessionId: string | null = null;
    setError(null);
    setSessionError(null);
    setExitedCode(null);
    setCwd(null);
    setSid(null);
    setPid(null);
    sidRef.current = null;
    rawRef.current = "";
    rawDroppedRef.current = 0;
    rawTruncatedRef.current = false;
    setRawTruncated(false);

    const term = new Terminal({
      fontSize: 13,
      fontFamily: "Consolas, 'Courier New', monospace",
      theme: { background: "#0a0a0a" },
      cursorBlink: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();
    termRef.current = term;

    // E2：着色层扣住的尾巴（半条转义序列 / 可能是关键词前缀的词尾）最多等 CARRY_FLUSH_MS 就补吐，
    // 免得"扣住的那几个字"在屏幕上迟迟不出现；正常输出（以换行收尾）根本不会扣住。
    let carryTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleCarryFlush = () => {
      if (carryTimer !== null) clearTimeout(carryTimer);
      carryTimer = setTimeout(() => {
        carryTimer = null;
        if (disposed) return;
        const pending = flushLogColor(colorStateRef.current);
        if (pending) term.write(pending);
      }, CARRY_FLUSH_MS);
    };

    const esHolder: { es: EventSource | null } = { es: null };

    createTerminal(project.id, term.cols, term.rows)
      .then((session) => {
        if (disposed) {
          // 组件已卸载，会话立刻关，防泄漏
          closeTerminalSession(session.id, project.id).catch(() => {});
          return;
        }
        sessionId = session.id;
        sidRef.current = session.id;
        setSid(session.id);
        setPid(session.pid);
        setCwd(session.cwd); // 本 pane 的工作目录（项目根，后端解析），头部展示供用户核对
        const es = new EventSource(terminalStreamUrl(session.id, project.id));
        esHolder.es = es;
        // SSE 断线提示（2026-09-18 审计修复）：非正常收尾（没收到 exit、组件也没在卸载）的
        // error 事件 = 连接意外断开——在终端输出区尾部插一行黄色可见提示，提醒"屏幕上的
        // 内容可能不全"。不加重连逻辑（现有语义不变，浏览器 EventSource 默认行为不干预）；
        // 提示只在每次断线时插一行（onopen 重连成功后复位标志），避免重试风暴刷屏。
        // 提示是纯 UI 层的，不进 rawRef（「导出原始输出」仍逐字节等于源输出）。
        let streamClosed = false; // 收到 exit 事件 = 正常收尾，此后的 error 不算断线
        let disconnectNoted = false; // 本轮断线是否已提示过（防重试风暴重复插行）
        es.onopen = () => {
          disconnectNoted = false; // （重）连成功：复位，下次再断再提示
        };
        es.onerror = () => {
          if (disposed || streamClosed || disconnectNoted) return;
          disconnectNoted = true;
          const pending = flushLogColor(colorStateRef.current); // 先把着色层扣住的尾巴补吐，提示行才接在真实输出之后
          if (pending) term.write(pending);
          term.write("\r\n\u001b[33m⚠ 连接断开，输出可能不完整\u001b[0m\r\n");
        };
        es.onmessage = (ev) => {
          const payload = JSON.parse(ev.data) as {
            data?: string;
            exit?: { exitCode: number };
          };
          if (typeof payload.data === "string") {
            // ① 原始流另存一份（导出用，与着色无关）：着色永远不碰它，导出才能逐字节等于源输出。
            //    有上限：超限从头部丢（丢多少记在 rawDroppedRef，界面会标出来），内存不随会话长度长。
            rawRef.current += payload.data;
            if (rawRef.current.length > RAW_BUFFER_MAX_CHARS) {
              const { text, dropped } = trimRawBuffer(rawRef.current);
              rawRef.current = text;
              rawDroppedRef.current += dropped;
              if (!rawTruncatedRef.current) {
                rawTruncatedRef.current = true;
                setRawTruncated(true);
              }
            }
            // ② 上屏：开着色只**插入** SGR 序列，关掉就是原样字节（DoD②）
            term.write(renderLogChunk(payload.data, colorStateRef.current, colorOnRef.current));
            if (colorOnRef.current) scheduleCarryFlush();
          }
          if (payload.exit) {
            const pending = flushLogColor(colorStateRef.current); // 流结束：扣住的尾巴补吐，一个字节不丢
            if (pending) term.write(pending);
            streamClosed = true; // 正常收尾：随连接关闭而来的 error 不算断线
            setExitedCode(payload.exit.exitCode);
            es.close();
          }
        };
      })
      .catch((e: Error) => {
        if (!disposed) setError(e.message);
      });

    // 键盘输入 → POST in 回写（能敲）。一敲一 POST，用 promise 链串行化——
    // 并发 fetch 到达顺序不保证，不串行会出现 "mode" 变 "moed" 的乱序（T2 UI 验证实测抓到）。
    // Q67（2026-09-18 审计）：失败不再静默吞（改前 `.catch(() => {})`）——后端先死/先重启而页面
    // 还活着时，会话已不在（SESSION_NOT_FOUND 404）或请求根本发不出去，此时**必须让用户看见**：
    // 整条链注入同一个错误处理，上屏一句可照做的提示（并给「重开会话」按钮）。
    let writeChain: Promise<void> = Promise.resolve();
    const onWriteFailure = (e: Error) => {
      if (disposed) return;
      setSessionError(e.message);
    };
    const dataSub = term.onData((data) => {
      if (sessionId) {
        const id = sessionId;
        const projectId = project.id;
        writeChain = writeChain.then(() => writeTerminalInput(id, data, projectId)).catch(onWriteFailure);
      }
    });

    // 容器尺寸变化 → fit 自适应 + POST resize（终端重排）。
    // resize 事件是连续的（拖窗口/切布局逐帧触发），fit 逐帧跟、POST 防抖 150ms 只发最后一帧。
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const ro = new ResizeObserver(() => {
      if (disposed) return;
      try {
        fit.fit();
      } catch {
        return; // 隐藏/零尺寸时 fit 会抛，忽略即可
      }
      if (resizeTimer !== null) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (disposed || !sessionId) return;
        const cols = term.cols;
        const rows = term.rows;
        if (cols > 0 && rows > 0) {
          resizeTerminalSession(sessionId, cols, rows, project.id).catch(() => {});
        }
      }, 150);
    });
    ro.observe(host);

    return () => {
      disposed = true;
      ro.disconnect();
      if (resizeTimer !== null) clearTimeout(resizeTimer);
      if (carryTimer !== null) clearTimeout(carryTimer);
      dataSub.dispose();
      esHolder.es?.close();
      if (sessionId) closeTerminalSession(sessionId, project.id).catch(() => {});
      termRef.current = null;
      term.dispose();
    };
    // Q67：rebuildNonce 变化 = 用户点了「重开会话」→ 卸载旧会话、照原路重来一遍
  }, [project.id, rebuildNonce]);

  // E2 开关：只切"上屏要不要插色"，原始流（rawRef）与控制流一个字节都不变（DoD②）。
  // 切换瞬间把上一状态扣住的尾巴（半条序列/半截关键词）补吐给终端，避免开关一切掉几个字符。
  const toggleColor = () => {
    const next = !colorOnRef.current;
    colorOnRef.current = next;
    setColorOn(next);
    const pending = flushLogColor(colorStateRef.current);
    if (pending) termRef.current?.write(pending);
  };

  // E2 导出：内容 = 本 pane 收到的**原始输出**（rawRef），逐字节等于源输出（DoD③）。
  // 着色只是往"上屏那条路"插 SGR，从来不进 rawRef——所以导出天然是"无着色 + 程序自己的 ANSI 全保留"。
  // 缓冲有上限（Q44）：截断过就只导最后保留的那段，丢了多少由界面与按钮标题如实标出（不静默）。
  const exportRaw = () => {
    const blob = new Blob([rawRef.current], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `terminal-${index + 1}${sid ? `-${sid}` : ""}.log`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000); // 立即 revoke 可能赶在下载启动前，缓一拍
  };

  // E3 回填：把历史里的一条命令写进**本 pane 的输入行**——只写命令、**不写 `\r`**，
  // 所以 shell 只会把它回显在提示符后面等着，不会执行（DoD②「一键回填、不自动执行」）。
  // 走的仍是 T2/E1 那条 `POST :sid/in` 通道，pane 里没有第二条写 stdin 的路。
  // 回填后收起面板：用户马上能看到输入行（否则面板盖着终端，回填了也看不见）。
  const fillFromHistory = (command: string) => {
    const id = sidRef.current;
    if (!id) return;
    writeTerminalInput(id, command, project.id).catch((e: Error) => setError(e.message));
    setFillNote(`已回填到输入行（未执行）：${command}`);
    setHistoryOpen(false);
    setTimeout(() => setFillNote(null), 4000);
  };

  return (
    <div
      data-terminal-pane
      data-terminal-pane-index={index}
      data-terminal-sid={sid ?? ""}
      data-terminal-pid={pid ?? ""}
      data-terminal-cwd={cwd ?? ""}
      data-terminal-color={colorOn ? "on" : "off"}
      data-terminal-history-open={historyOpen ? "on" : "off"}
      data-terminal-raw-truncated={rawTruncated ? "on" : "off"}
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded border border-neutral-800 bg-neutral-950"
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-neutral-800 bg-neutral-900/60 px-2 py-1 text-[11px]">
        <span className="shrink-0 text-neutral-300">终端 {index + 1}</span>
        <span
          data-terminal-cwd-label
          className="truncate text-neutral-500"
          title={cwd ? `工作目录（项目根，后端锁）：${cwd}` : "正在建会话…"}
        >
          {cwd ?? "正在建会话…"}
        </span>
        <button
          data-terminal-history-toggle
          data-terminal-history-state={historyOpen ? "open" : "closed"}
          onClick={() => setHistoryOpen((v) => !v)}
          title="命令历史：本项目跨会话记录的命令（塔台自管落盘在 .工作台/logs/，不读 shell 自己的历史文件）；可搜索、可一键回填到输入行（不自动执行）、可清空"
          className={`ml-auto shrink-0 rounded border px-1.5 py-0.5 ${
            historyOpen
              ? "border-emerald-800 text-emerald-300 hover:bg-emerald-950"
              : "border-neutral-700 text-neutral-400 hover:bg-neutral-800"
          }`}
        >
          历史：{historyOpen ? "开" : "关"}
        </button>
        <button
          data-terminal-color-toggle
          data-terminal-color-state={colorOn ? "on" : "off"}
          onClick={toggleColor}
          title="日志着色开关：只给级别关键词（ERROR/WARN/INFO/DEBUG 等）插颜色序列，正文与程序自己的 ANSI 一个字节都不动；关掉后上屏字节与源输出逐字节一致"
          className={`shrink-0 rounded border px-1.5 py-0.5 ${
            colorOn
              ? "border-sky-800 text-sky-300 hover:bg-sky-950"
              : "border-neutral-700 text-neutral-400 hover:bg-neutral-800"
          }`}
        >
          日志着色：{colorOn ? "开" : "关"}
        </button>
        <button
          data-terminal-export
          onClick={exportRaw}
          title={
            rawTruncated
              ? `导出本 pane 的原始输出（不含任何着色；缓冲上限 ${RAW_BUFFER_MAX_CHARS} 字符，已丢弃更早的 ${rawDroppedRef.current} 字符——导出的是最后保留的这段，程序自己发的 ANSI 序列原样保留）`
              : "导出本 pane 的原始输出（不含任何着色，逐字节等于源输出；程序自己发的 ANSI 序列原样保留）"
          }
          className="shrink-0 rounded border border-neutral-700 px-1.5 py-0.5 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
        >
          导出原始输出
        </button>
        {rawTruncated && (
          <span
            data-terminal-raw-truncated-note
            title={`原始输出缓冲上限 ${RAW_BUFFER_MAX_CHARS} 字符：已丢弃更早的 ${rawDroppedRef.current} 字符，只保留最近的输出（导出的也是这一段）`}
            className="shrink-0 text-amber-400"
          >
            缓冲已截断
          </span>
        )}
        <span className="shrink-0 text-neutral-600">{sid ? `pid ${pid}` : ""}</span>
        <button
          data-terminal-pane-close
          onClick={onClose}
          title="关闭这个终端（只关它自己的会话，其它 pane 不受影响）"
          className="shrink-0 rounded px-1.5 py-0.5 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
        >
          关闭
        </button>
      </div>
      {error && (
        <p data-terminal-pane-error className="shrink-0 px-2 py-1 text-xs text-red-400">
          终端创建失败:{error}
        </p>
      )}
      {/* Q67：会话失效（后端先死/先重启而页面还活着）——键盘输入已经发不进去了，如实说 + 给出口 */}
      {sessionError && (
        <p
          data-terminal-session-error
          className="flex shrink-0 items-center gap-2 px-2 py-1 text-xs text-red-400"
        >
          <span>
            终端会话已失效，键盘输入发不出去：{sessionError}
          </span>
          <button
            data-terminal-session-rebuild
            onClick={() => {
              setSessionError(null);
              setRebuildNonce((n) => n + 1); // 换一个会话重来（点一下才重建，不悄悄重连）
            }}
            title="关掉这个失效会话、按原样重开一个（先前的输出会留在屏幕上，导出缓冲会被清空）"
            className="shrink-0 rounded border border-red-800 px-1.5 py-0.5 text-red-300 hover:bg-red-950"
          >
            重开会话
          </button>
        </p>
      )}
      {exitedCode !== null && (
        <p className="shrink-0 px-2 py-1 text-xs text-amber-400">
          进程已退出 (code {exitedCode})
        </p>
      )}
      {fillNote && (
        <p data-terminal-history-fill-note className="shrink-0 px-2 py-1 text-xs text-emerald-400">
          {fillNote}
        </p>
      )}
      {/* E3：历史面板（头部按钮开合）；回填只写输入行，不代按回车 */}
      {historyOpen && <HistoryPanel projectId={project.id} onPick={fillFromHistory} />}
      <div
        ref={hostRef}
        data-terminal-host
        className="min-h-0 flex-1 overflow-hidden"
      />
    </div>
  );
}
