import { spawn as spawnProcess } from "node:child_process";
import os from "node:os";
import { spawn, type IPty } from "node-pty";
import { getProject } from "./registry";
import { TerminalHistoryRecorder } from "./terminalHistory";
import { WsError } from "./workstation";

// 终端 PTY 通道（T1，DESIGN.md §3.7 终端视图的后端半边，T2 xterm.js 接本通道）。
// 选型：node-pty（MIT，LICENSE 原文已核对）真伪终端——Windows 下走 ConPTY，
// 有真 resize、真交互语义；非 child_process 降级路。
//
// 工作目录红线（DoD③）：shell 启动 cwd 锁在【项目根】（注册表 registry.getProject 解析），
// 绝不落到全局数据目录，也不接受调用方直接传路径（与 watcher.ts / workstation.ts 同一红线）。
// 用户进入 shell 后自行 cd 属于交互行为，不在本层限制。
//
// 生命周期（DoD④）：会话全在内存 Map 里；close 走 pty.kill() 并等待 onExit 拿到退出码，
// 退出（无论正常退出还是被 kill）即从 Map 摘除并通知全部订阅者，不留僵尸进程、不留悬挂监听器。
//
// 多会话（E1，DESIGN.md §3.7 二期「多终端分屏」）：本层从 T1 起就是"一个项目 → 多个并行会话"，
// 每个会话一个独立 PTY（独立 pid / 独立 stdin / 独立输出流）——分屏 pane 各自建各自的会话，
// 前端不许把 sid 复用给别的 pane（PLAN E1 跑偏点：共用 PTY 会串台）。
// E1 补三件：① 每项目活跃会话数上限；② 按项目列会话；③ 会话查找的项目范围（跨项目一律视为不存在）。
//
// E3（DESIGN.md §3.7 二期「命令历史检索」）：每个会话挂一个 `TerminalHistoryRecorder`，
// 输入只从 `writeTerminal`（= 前端按键经 POST /in）喂，输出只从 `pty.onData` 喂（仅用于"这条命令
// 到底有没有被 shell 回显"与耗时口径）；退出前 `close()` 把待落盘命令落掉。落盘位置与按键解析
// 口径全在 `terminalHistory.ts`，本文件不碰文件系统。

/** 终端会话对外信息（HTTP 响应口径） */
export interface TerminalSessionInfo {
  id: string;
  projectId: string;
  /** 宿主机进程 PID（node-pty 的 pty 代理进程），验证/排查僵尸用 */
  pid: number;
  /** shell 启动工作目录 = 项目根 */
  cwd: string;
  cols: number;
  rows: number;
  /** 是否已退出；退出后 exitCode 有值 */
  exited: boolean;
  exitCode: number | null;
}

interface TerminalSession extends TerminalSessionInfo {
  pty: IPty;
  dataListeners: Set<(data: string) => void>;
  exitListeners: Set<(info: { exitCode: number }) => void>;
  /** E3：本会话的命令历史记录器（唯一输入口 = 下面的 writeTerminal；输出只喂回显比对用） */
  history: TerminalHistoryRecorder;
}

/**
 * 终端尺寸上限（Q125，2026-09-19 审计）：cols/rows 此前只判"正整数"，`1e7` 这类值直接送进
 * node-pty 原生层——Windows 侧 conpty 按 SHORT 截断（1e7 → -27008），`CreatePseudoConsole`
 * 不返回（真探针：spawn 5 分钟以上无返回、无子进程），而 `createTerminalSession` 是同步调用，
 * 于是**一条本机请求就把整个后端卡死**（事件循环整体停摆）。resize 分支同病：0ms 静默失效，
 * 会话信息还记成 1e7。这里给一个明确上限——正常终端尺寸在几百量级（xterm fit 出来的列数最多
 * 小几百），1000 已极宽松，离 SHORT 截断线（32767）也远；超限抛 INVALID_INPUT（400），
 * 不静默回落到默认值（那是"看着成功、实际没生效"）。
 */
export const MAX_TERMINAL_DIMENSION = 1000;

/** cols/rows 校验（创建与 resize 共用一份口径）：正整数且不超 MAX_TERMINAL_DIMENSION */
export function assertTerminalSize(cols: number, rows: number): void {
  const bad = (v: number) => !Number.isInteger(v) || v < 1 || v > MAX_TERMINAL_DIMENSION;
  if (bad(cols) || bad(rows)) {
    throw new WsError(
      "INVALID_INPUT",
      `cols/rows 必须是 1..${MAX_TERMINAL_DIMENSION} 的整数: ${cols}x${rows}`,
    );
  }
}

const sessions = new Map<string, TerminalSession>();

let nextSid = 1;

/**
 * 每项目活跃会话数上限（E1 DoD①的前提防线）：一个项目里同时开着的终端有上限，
 * 超限新建直接报 SESSION_LIMIT_REACHED（HTTP 400），不静默丢弃、不无限起进程。
 * 前端分屏 pane 上限（`src/ui/components/TerminalView.tsx` 的 MAX_PANES_PER_PROJECT）必须与本值同口径。
 */
export const MAX_SESSIONS_PER_PROJECT = 8;

function toInfo(s: TerminalSession): TerminalSessionInfo {
  const { id, projectId, pid, cwd, cols, rows, exited, exitCode } = s;
  return { id, projectId, pid, cwd, cols, rows, exited, exitCode };
}

/** Windows 下用 cmd.exe（COMSPEC 优先），其他平台用登录 shell */
function defaultShell(): string {
  return os.platform() === "win32"
    ? process.env.COMSPEC || "cmd.exe"
    : process.env.SHELL || "/bin/sh";
}

/**
 * 建会话：项目 id → 注册表解析项目根（伪造 id 抛 PROJECT_NOT_FOUND），
 * 以项目根为 cwd 起 shell；返回会话信息（含 sid 与 pid）。
 * 每项目活跃会话数达上限抛 SESSION_LIMIT_REACHED（E1：一个项目最多同时开
 * MAX_SESSIONS_PER_PROJECT 个终端，超限明确报错，不静默失败）。
 */
export function createTerminalSession(
  projectId: string,
  cols = 80,
  rows = 24,
): TerminalSessionInfo {
  // Q125：尺寸上限在**建会话之前**校验——超限值一旦送进 conpty 原生层就再也回不来（见常量注释）
  assertTerminalSize(cols, rows);
  const project = getProject(projectId);
  if (!project) {
    throw new WsError("PROJECT_NOT_FOUND", `项目不存在: ${projectId}`);
  }
  const active = listTerminalSessions(projectId).length;
  if (active >= MAX_SESSIONS_PER_PROJECT) {
    throw new WsError(
      "SESSION_LIMIT_REACHED",
      `项目 ${projectId} 的终端会话已达上限 ${MAX_SESSIONS_PER_PROJECT} 个（E1 上限口径）：先关掉不用的终端再开`,
    );
  }
  const pty = spawn(defaultShell(), [], {
    name: "tatai-terminal",
    cols,
    rows,
    cwd: project.path,
  });
  const sid = `t${Date.now().toString(36)}-${nextSid++}`;
  const session: TerminalSession = {
    id: sid,
    projectId,
    pid: pty.pid,
    cwd: project.path,
    cols,
    rows,
    exited: false,
    exitCode: null,
    pty,
    dataListeners: new Set(),
    exitListeners: new Set(),
    // E3：历史记录器每会话一个（session id / 项目 id / cwd 建会话时定死，不由调用方传）
    history: new TerminalHistoryRecorder(sid, projectId, project.path),
  };
  sessions.set(session.id, session);
  pty.onData((data) => {
    session.history.feedOutput(data); // E3：只喂回显比对/耗时（记录内容不来自输出流）
    for (const listener of session.dataListeners) {
      try {
        listener(data);
      } catch {
        // 单个订阅者炸了不连累其他订阅者与 PTY 本体
      }
    }
  });
  pty.onExit(({ exitCode }) => {
    session.exited = true;
    session.exitCode = exitCode;
    session.history.close(); // E3：退出前把待落盘的命令落掉，不留半条
    for (const listener of session.exitListeners) {
      try {
        listener({ exitCode });
      } catch {
        // 同上
      }
    }
    session.dataListeners.clear();
    session.exitListeners.clear();
    sessions.delete(session.id);
  });
  return toInfo(session);
}

/**
 * 取会话。带 projectId 时**跨项目一律视为不存在**（E1 会话隔离：项目 A 的 sid 在项目 B 上不可用）——
 * 前端每个 pane 只拿自己项目里的 sid，一个项目的操作不可能作用到另一个项目的会话上。
 */
function findSession(sid: string, projectId?: string): TerminalSession | undefined {
  const session = sessions.get(sid);
  if (!session) return undefined;
  if (projectId !== undefined && session.projectId !== projectId) return undefined;
  return session;
}

function requireSession(sid: string, projectId?: string): TerminalSession {
  const session = findSession(sid, projectId);
  if (!session) {
    throw new WsError("SESSION_NOT_FOUND", `终端会话不存在或已退出: ${sid}`);
  }
  return session;
}

/** 会话存在性断言（可带项目范围）；不存在/跨项目抛 SESSION_NOT_FOUND。SSE 写响应头前先校验用 */
export function assertTerminalSession(sid: string, projectId?: string): TerminalSessionInfo {
  return toInfo(requireSession(sid, projectId));
}

/** 写 stdin（DoD② 连续交互的入口） —— **也是 E3 命令历史的唯一输入口**：
 *  塔台只记"经本函数写进 PTY 的按键流"，绝不读 shell 自己的历史文件（PLAN E3 跑偏点）。
 *  记录是旁路：落盘失败不影响写 PTY。 */
export function writeTerminal(
  sid: string,
  data: string,
  projectId?: string,
): TerminalSessionInfo {
  const session = requireSession(sid, projectId);
  session.history.feedInput(data);
  session.pty.write(data);
  return toInfo(session);
}

/** 尺寸变更：node-pty 真 resize（ConPTY 原生支持）；每个会话各调各的，互不影响 */
export function resizeTerminal(
  sid: string,
  cols: number,
  rows: number,
  projectId?: string,
): TerminalSessionInfo {
  const session = requireSession(sid, projectId);
  assertTerminalSize(cols, rows); // Q125：resize 同样卡上限（原先 1e7 静默失效、会话信息还记成 1e7）
  session.pty.resize(cols, rows);
  session.cols = cols;
  session.rows = rows;
  return toInfo(session);
}

/** kill 后 PTY 仍未退出的兜底等待时长：超时即强制清理（会话表必须释放，DELETE 不能挂死） */
const CLOSE_FORCE_TIMEOUT_MS = 3000;

/**
 * 关闭会话：kill PTY 并等待 onExit 收退出码（资源回收、不留僵尸，DoD④）。
 * 幂等：已退出/不存在的 sid 直接返回 null（不报错）。
 * 带 projectId 时跨项目的 sid 同样返回 null（E1：B 项目关不掉 A 项目的会话）。
 *
 * 挂死兜底（2026-09-18 审计修复）：kill 后 PTY 赖着不退时，旧实现会永远等下去——
 * DELETE /api/terminal/:sid 也就永久挂起。现在 kill 后只等 CLOSE_FORCE_TIMEOUT_MS，
 * 超时即强制清理（forceCleanupTerminal）：会话表必须释放，不能挂。强制清理路径
 * exitCode 定 -1（真实退出码等不到了），note 里带"强制清理"字样供响应端识别。
 */
export function closeTerminal(
  sid: string,
  projectId?: string,
): Promise<{ exitCode: number; note?: string } | null> {
  const session = findSession(sid, projectId);
  if (!session) return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false; // exit 与超时两条路只走一条（Promise 本身只 resolve 一次，这里防重复清理）
    const finish = (result: { exitCode: number; note?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const onExit = ({ exitCode }: { exitCode: number }) => {
      session.exitListeners.delete(onExit);
      finish({ exitCode }); // 正常路径：onExit 收到真实退出码
    };
    const timer = setTimeout(() => {
      if (settled) return;
      session.exitListeners.delete(onExit); // 先摘掉自己，别让强制清理的合成退出事件再触发一次
      forceCleanupTerminal(session);
      finish({
        exitCode: -1,
        note: `kill 后 ${CLOSE_FORCE_TIMEOUT_MS / 1000}s 未退出，已强制清理（taskkill 兜底 + 会话表移除）`,
      });
    }, CLOSE_FORCE_TIMEOUT_MS);
    session.exitListeners.add(onExit);
    try {
      session.pty.kill();
    } catch {
      // kill 本身抛错（进程已死但 onExit 尚未送达等）：不等超时，直接强制清理收口
      session.exitListeners.delete(onExit);
      forceCleanupTerminal(session);
      finish({ exitCode: -1, note: "强制清理：pty.kill() 抛错，已直接收口" });
    }
  });
}

/**
 * 强制清理（closeTerminal 超时兜底）：进程杀不退也得把会话收掉。
 * Windows 下 `taskkill /PID <pid> /T /F` 树杀（node-pty 的 pid 是宿主进程树根），
 * 其他平台 SIGKILL；随后按 onExit 同一口径收尾——合成退出事件通知订阅者（SSE 收流，不留悬挂）、
 * 落掉待落盘命令（close 幂等）、清监听器、从会话表删除（对 PTY 句柄只剩本 session 对象的引用，
 * 摘除后即可被 GC）。兜底杀失败也不追（进程可能已被别人收走），会话表释放才是硬语义。
 * 晚到的真 onExit 再跑一遍创建时的清理逻辑也无害（全是幂等操作）。
 */
function forceCleanupTerminal(session: TerminalSession): void {
  if (os.platform() === "win32") {
    try {
      spawnProcess("taskkill", ["/PID", String(session.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      })
        .on("error", () => {}) // taskkill 不在（罕见）：进程只能留给 OS 收，不再追
        .unref(); // 不让兜底子进程拖住本进程退出
    } catch {
      // 同上
    }
  } else {
    try {
      process.kill(session.pid, "SIGKILL");
    } catch {
      // 已死/权限不足：不追
    }
  }
  session.exited = true;
  session.exitCode = -1;
  for (const listener of session.exitListeners) {
    try {
      listener({ exitCode: -1 }); // 合成退出：让 SSE 等订阅者正常收流
    } catch {
      // 单个订阅者炸了不连累清理
    }
  }
  session.history.close(); // E3：待落盘命令照样落，不留半条
  session.dataListeners.clear();
  session.exitListeners.clear();
  sessions.delete(session.id);
}

/** 查会话（不存在/跨项目指定时返回 undefined，不抛） */
export function getTerminalSession(
  sid: string,
  projectId?: string,
): TerminalSessionInfo | undefined {
  const session = findSession(sid, projectId);
  return session ? toInfo(session) : undefined;
}

/**
 * 列当前存活会话（E1：GET /api/terminal/sessions?project_id=）。
 * projectId 省略时列全部项目（排查用）；顺序 = 创建顺序（Map 插入序），前端按此建 pane 顺序。
 * 会话退出即从 Map 摘除，所以这里列出的都是还活着的。
 */
export function listTerminalSessions(projectId?: string): TerminalSessionInfo[] {
  const out: TerminalSessionInfo[] = [];
  for (const session of sessions.values()) {
    if (projectId === undefined || session.projectId === projectId) out.push(toInfo(session));
  }
  return out;
}

/** 订阅输出流；返回退订函数。会话不存在（或不在指定项目里）抛 SESSION_NOT_FOUND */
export function onTerminalData(
  sid: string,
  listener: (data: string) => void,
  projectId?: string,
): () => void {
  const session = requireSession(sid, projectId);
  session.dataListeners.add(listener);
  return () => {
    session.dataListeners.delete(listener);
  };
}

/** 订阅退出事件；返回退订函数。会话不存在（或不在指定项目里）抛 SESSION_NOT_FOUND */
export function onTerminalExit(
  sid: string,
  listener: (info: { exitCode: number }) => void,
  projectId?: string,
): () => void {
  const session = requireSession(sid, projectId);
  session.exitListeners.add(listener);
  return () => {
    session.exitListeners.delete(listener);
  };
}

/** 当前存活会话数（验证/排查用） */
export function terminalSessionCount(): number {
  return sessions.size;
}

/**
 * 杀掉某项目的**全部**终端会话（2026-09-18 审计补，DELETE /api/projects/:id 的资源回收用）：
 * 此前删项目只删注册表记录——PTY 还开着该项目的 shell（幽灵会话 + 进程泄漏）。
 * 逐个走 closeTerminal（kill + 等退出码，自带 3s 强制清理兜底）；返回真正关掉的个数。
 * 项目没有会话时返回 0（幂等）；单个会话关闭异常不中断其余会话的回收。
 */
export async function closeProjectTerminals(projectId: string): Promise<number> {
  const sids = listTerminalSessions(projectId).map((s) => s.id);
  let closed = 0;
  for (const sid of sids) {
    const result = await closeTerminal(sid, projectId).catch(() => null);
    if (result !== null) closed += 1;
  }
  return closed;
}

/**
 * 杀掉**全部**项目的终端会话（2026-09-18 审计 Q22 补，优雅退出路径用）：
 * 此前进程退出只记写模式收尾，PTY 里的 shell 全靠壳的 `taskkill /T` 树杀或 OS 兜住——
 * 服务端自己退出（Ctrl+C / 信号）时这些子进程没人收。逐个走 closeTerminal（kill + 等退出码 +
 * 3s 强制清理兜底），单会话异常不中断其余；返回真正关掉的个数（没有会话时 0，幂等）。
 */
export async function closeAllTerminals(): Promise<number> {
  const sids = listTerminalSessions().map((s) => s.id);
  let closed = 0;
  for (const sid of sids) {
    const result = await closeTerminal(sid).catch(() => null);
    if (result !== null) closed += 1;
  }
  return closed;
}
