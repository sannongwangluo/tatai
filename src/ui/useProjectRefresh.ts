// V09-26（PLAN.md V09-26；docs/forward-progress-contract.md F2）：正向工作面**统一自动对账**的
// 公共刷新机制。F2 的原文要求：
//   · 施工、验收、设计/待议、项目信息、顶部阶段/当前卡/版本、待决事项、Gate、技术图状态色与
//     数据流目标证据层都要自动重新取数；默认**可见页面 5 秒对账**，回前台立即补拉；
//   · 同一加载器不得并发堆积；**即使只变文档 / Gate / 证据而账本序号不变**，也要最终追平
//     ——所以判据不能只看 `task_last_seq`；
//   · 后台刷新保留最后成功数据与输入，失败显示陈旧/原因/最近成功时间，恢复后自行清除；
//   · 换项目、卸载和晚到旧请求不能串数据或回退。
//
// 实现沿革：V09-28 的 DesignView 需要消费本接口，施工时在此落过一版**变更侦测**实现
// （读 `GET /live` 的 `task_last_seq`+`last_event_at`+`graph_update` 指纹，变了才 `token++`）。
// V09-26（本卡）把它收敛为**周期对账**：指纹侦测覆盖不到"只改 Gate/证据文件、账本序号不动"，
// 而 F2 明确要求「默认可见页面 5 秒对账」「不要只监听 task_last_seq」。签名与语义保持兼容，
// DesignView 直接消费不变；本文件归 V09-26 维护。
//
// 本模块只做两件事，**不碰后端、不新开 SSE**，只复用现有只读读口：
//
//   ① `useProjectRefresh(projectId, options?)` —— 返回**单调递增的数字 token**。它按可见性门控的
//      对账周期自增（缺省 5000ms），并在挂载、回前台、网络恢复时立即 +1。调用页把 token 放进
//      自己的加载 effect 依赖即可（"任一失效信号前进就重取"）。
//
//   ② `useBoundedReloader(key, run)` —— 调用页加载器的**严格有界在途**外壳。同一 key 内在途期间再
//      触发只记一笔，回来后再补一次（**同一 key 不 abort**，所以慢响应不会被每轮对账永远丢弃，
//      F2 红线）；key 变化（换项目）或卸载时 **abort 在途网络**，任一瞬间至多一笔有效在途请求
//      ——多次快速切换不会堆积。`run` 收到一个 `AbortSignal`：透传给读口 + `signal.aborted`
//      作落地前判据（旧项目/旧代回包一律丢弃，A→B→A 也不会回退）。
import { useCallback, useEffect, useRef, useState } from "react";
import { invalidateSharedReads } from "./sharedRead";

/** 默认对账间隔：F2「默认可见页面 5 秒对账」（技术图的 4s 轮询保持原语义，不并入）。 */
export const PROJECT_REFRESH_INTERVAL_MS = 5000;
/** 同义别名（V09-26 起的命名；两个名字都导出，避免消费者各自造一个常量）。 */
export const PROJECT_PAGE_POLL_MS = PROJECT_REFRESH_INTERVAL_MS;

export interface ProjectRefreshOptions {
  /** 对账周期（毫秒）；缺省 5000（F2 口径） */
  intervalMs?: number;
}

/**
 * 正向工作面公共刷新 token。
 *
 * 触发点（F2）：挂载 +1、每个可见对账周期 +1、`visibilitychange` 回前台 +1、`online` 恢复 +1。
 * 隐藏页签不对账（省掉无谓请求）；定时器在卸载/换项目时清掉，token 不自减、不回退。
 */
export function useProjectRefresh(projectId: string, options?: ProjectRefreshOptions): number {
  const intervalMs = options?.intervalMs ?? PROJECT_REFRESH_INTERVAL_MS;
  const [token, setToken] = useState(0);
  useEffect(() => {
    if (projectId === "") return;
    let stopped = false;
    const bump = (): void => {
      if (!stopped) setToken((t) => t + 1);
    };
    // 挂载即登记一轮对账：只依赖 token 的调用页也能拿到首发（依赖 [projectId, token] 的页面
    // 在挂载时本就会跑一次 effect，多出来的这一跳由下面的有界在途合并，不会并发堆积）。
    bump();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") bump();
    }, intervalMs);
    const onVisibility = (): void => {
      if (document.visibilityState === "visible") {
        // 已知失效（V09-38 复审）：回前台后重新取数，**不得**并入后台期间发出的旧在途请求。
        invalidateSharedReads();
        bump();
      }
    };
    const onOnline = (): void => {
      invalidateSharedReads(); // 在线恢复同理：网络恢复前的在途读不算"当前版本"
      bump();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("online", onOnline);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("online", onOnline);
    };
  }, [projectId, intervalMs]);
  return token;
}

/**
 * 有界在途的加载器外壳。返回的函数是稳定引用（可安全放进 effect 依赖）。
 *
 *   · **同一 key（同一项目）**：至多一个在途请求；在途期间再触发只记一笔，回来后再补一次
 *     ——不并发堆积，慢响应也不会被每轮对账反复取消（F2 红线："不能自动刷新导致慢响应永远被丢弃"）。
 *   · **key 变了（换项目）**：作废旧代**并 abort 在途网络**（旧回包即使到达也不会落地），允许新项目
 *     **立即**开读，不必等旧项目那笔慢响应回来。任一瞬间至多一笔有效在途请求，多次快速切换不会堆积。
 *   · **卸载**：abort 在途、作废 pending，卸载后不再补跑（"卸载不继续 pending"）。
 *
 * `run` 通过 ref 取最新一份（换项目后自动用新闭包），并**接收一个 `AbortSignal`**：调用页应
 *   ① 把它透传给 `api.ts` 的读口（真正中止网络），② 在 `.then` / `.catch` 里用 `signal.aborted`
 *   判断回包是否已作废。**同一个 key 内不会 abort**，所以慢响应最终一定会落地显示（F2 红线）。
 */
export function useBoundedReloader(
  key: string,
  run: (signal: AbortSignal) => void | Promise<void>,
): () => void {
  const runRef = useRef(run);
  runRef.current = run;
  const keyRef = useRef(key);
  const genRef = useRef(0);
  const inFlightRef = useRef(false);
  const pendingRef = useRef(false);
  const controllerRef = useRef<AbortController | null>(null);
  const aliveRef = useRef(true);
  const selfRef = useRef<() => void>(() => {});
  const fire = useCallback((): void => {
    if (!aliveRef.current) return;
    if (inFlightRef.current) {
      pendingRef.current = true; // 在途：不并发堆积，回来后再补一次（慢响应因此不会被丢弃）
      return;
    }
    inFlightRef.current = true;
    const gen = ++genRef.current;
    const controller = new AbortController();
    controllerRef.current = controller;
    let result: void | Promise<void>;
    try {
      result = runRef.current(controller.signal);
    } catch {
      result = undefined;
    }
    Promise.resolve(result)
      .catch(() => undefined)
      .finally(() => {
        if (gen !== genRef.current) return; // 已被换项目/卸载作废：在途标记交给新代管
        inFlightRef.current = false;
        controllerRef.current = null;
        if (pendingRef.current) {
          pendingRef.current = false;
          selfRef.current();
        }
      });
  }, []);
  selfRef.current = fire;
  // 卸载：中止在途网络 + 作废 pending，之后不再补跑（StrictMode 重挂载会把 alive 置回）
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      genRef.current += 1;
      controllerRef.current?.abort();
      controllerRef.current = null;
      inFlightRef.current = false;
      pendingRef.current = false;
    };
  }, []);
  return useCallback((): void => {
    if (keyRef.current !== key) {
      keyRef.current = key;
      genRef.current += 1; // 作废旧代：旧回包落地前一律丢弃（A→B→A 也不会把旧 A 写进新 A）
      controllerRef.current?.abort(); // 中止旧项目的在途网络，多次切换不堆积（严格有界）
      controllerRef.current = null;
      inFlightRef.current = false; // 新项目立即开读，不等旧项目慢响应
      pendingRef.current = false;
    }
    fire();
  }, [key, fire]);
}
