// V09-45（DESIGN §6.10）：界面诊断——显示**本界面自身**的构建身份，并与**运行时后端**身份对照偏斜。
//
// 后端不是跟窗口一起就绪的：壳按设计**先开窗**、`/health` 探活放后台线程，所以首读落空是**常态**
// 而不是异常——面板必须能自己恢复，不靠刷新页面（页面上没有"重启窗口"这回事）。
//
// 口径（逐条守 §4.4/§6.10）：
//   · 自身身份取自**编译期内联的常量**（`resolveBuildIdentity("ui")`）；dev 直跑没有内联值 ⇒ 如实 unknown。
//   · 后端身份取自 `GET /health` 的 `build_identity`（同一后端的只读读口）；读不到 ⇒ unknown + 原因。
//   · 偏斜三态：`same_release` / `skew`（点名两个部件与 release_id 前 12 位）/ `unknown`（任一侧未内嵌，
//     **不得**判"一致"）——判据唯一来源是 `src/shared/buildIdentity.ts#compareBuildIdentities`。
//   · 这里**不**读盘上的 build-stamp 冒充进程身份：那份戳回答的是"产物出自哪次构建运行"。
//   · **失败即未知**：读失败（后端未起/已退出）时把后端身份清成 unknown，**不把上一次成功冒充当前
//     运行后端**；下一次成功读回时清掉旧错误（重连换了包也就据此刷新偏斜判定）。
//
// 启动恢复（§4.4「有界与去重」；复用既有机制，不新队列、不加全局轮询、不启动宿主/模型）：
//   · 复用 `isBackendUnreachable`（api.ts 既有判据）区分"根本没连上后端"与业务错误——只有前者自动重试
//     （业务错误重试没有意义，反而盖住真实原因）；
//   · 复用 `useBoundedReloader`（useProjectRefresh.ts 既有机制）保证**任一瞬间至多一笔在途**：
//     在途期间再触发只补一次、卸载即 abort、换代作废旧回包——重复触发不叠加并发；
//   · **有界退避**：首读失败后 400ms 起、每次 ×2、封顶 6s，**总自动重试次数另有上限**——次数用尽
//     即停，不永久轮询；成功**立刻清掉**已排定的定时器（成功即停，稳态零请求）；
//   · 网络恢复 / 回前台（`online`、`visibilitychange`——`useProjectRefresh` 用的同一组既有恢复信号）
//     与用户「重试 / 刷新身份」入口都只是**再触发一次**同一加载器、并重新起算重试预算；读的仍是同一个
//     只读读口，叠加由上面的有界在途外壳挡住；
//   · 展开详情**限高内部滚动**（§3.11「展开详情不吃掉画布」）：左栏项目区不被这块新增面板压成 0 高。
import { useCallback, useEffect, useRef, useState } from "react";
import { getHealth, isBackendUnreachable } from "../api";
import { useBoundedReloader } from "../useProjectRefresh";
import { compareBuildIdentities, resolveBuildIdentity, type BuildIdentity, type SkewState } from "../../shared/buildIdentity";

/** 自身身份是编译期内联的常量：整个页面生命周期内不变，不进状态。 */
const UI_IDENTITY = resolveBuildIdentity("ui");

/** 启动恢复退避口径（毫秒）：400ms 起、每次 ×2、封顶 6s。
 *  **总自动重试次数另有上限**——退避封顶 ≠ 有限次；次数用尽即停，不永久轮询。
 *  实测后端冷启动 ~1.2s ⇒ 通常 1–2 次就恢复，上限给了足够的余量。 */
const RETRY_BASE_MS = 400;
const RETRY_MAX_MS = 6000;
const RETRY_MAX_ATTEMPTS = 6;
function retryDelayMs(attempt: number): number {
  return Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_MAX_MS);
}

/** 后端身份缺席/读不到时的未知态（原因照实写，不猜）。 */
function unknownServer(reason: string): BuildIdentity {
  return { schema_version: 1, component: "server", embedded: false, reason };
}

const SKEW_LABEL: Record<SkewState, string> = {
  same_release: "同一版本",
  skew: "版本错配",
  unknown: "未知（不判一致）",
};

const SKEW_TONE: Record<SkewState, string> = {
  same_release: "border-emerald-700/60 bg-emerald-950/30 text-emerald-200",
  skew: "border-red-800/60 bg-red-950/30 text-red-200",
  unknown: "border-neutral-600 bg-neutral-800/60 text-neutral-400",
};

function identityValue(id: BuildIdentity): string {
  return id.embedded ? `release ${id.release_id.slice(0, 12)}… / build ${id.build_id.slice(0, 12)}…` : `未内嵌：${id.reason}`;
}

function IdentityLine({ label, id }: { label: string; id: BuildIdentity }) {
  return (
    <p className="text-neutral-400" data-build-identity-line={id.component}>
      <span className="text-neutral-300">{label}</span>｜{identityValue(id)}
      {id.embedded && (
        <>
          ｜输入 {id.source_input_fingerprint.slice(0, 12)}…｜构建于 {id.built_at}｜
          {id.toolchain.node}/{id.toolchain.pnpm}｜目标 server {id.toolchain.targets.server} / ui {id.toolchain.targets.ui}｜vite {id.toolchain.bundler.vite}
        </>
      )}
    </p>
  );
}

export function BuildIdentityPanel() {
  const [server, setServer] = useState<BuildIdentity | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 每次"再读一次"的序号：首次挂载、退避到时、连接恢复信号、用户手动重试都只是把它 +1 */
  const [retryTick, setRetryTick] = useState(0);
  /** 已用掉的自动重试次数（0 起算）；成功或手动/信号重触发都退回 0 */
  const failCountRef = useRef(0);
  /** 已排定但未触发的退避定时器；成功与重触发都要显式清掉（否则成功之后旧定时器还会多读一次） */
  const timerRef = useRef<number | null>(null);

  const clearTimer = useCallback((): void => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  /** 有界退避：只在"根本没连上后端"时排下一次；**次数用尽即停**（不永久轮询） */
  const scheduleRetry = useCallback((): void => {
    clearTimer();
    if (failCountRef.current >= RETRY_MAX_ATTEMPTS) return;
    const attempt = failCountRef.current;
    failCountRef.current = attempt + 1;
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      setRetryTick((t) => t + 1);
    }, retryDelayMs(attempt));
  }, [clearTimer]);

  const load = useCallback((signal: AbortSignal): Promise<void> => {
    return getHealth({ signal })
      .then((h) => {
        if (signal.aborted) return; // 卸载/换代：这份回包作废
        clearTimer(); // 成功即停：清掉已排定的退避定时器（提前成功后不再被旧定时器多读一次）
        failCountRef.current = 0;
        setError(null); // 后续成功清旧错误
        setServer(h.build_identity ?? unknownServer("后端 /health 未回构建身份（旧后端或源码直跑）"));
      })
      .catch((e: Error) => {
        if (signal.aborted || e.name === "AbortError") return; // 取消不算失败
        setServer(null); // 失败即未知：不把上一次成功冒充当前运行后端
        setError(e.message);
        if (isBackendUnreachable(e.message)) scheduleRetry();
      });
  }, [clearTimer, scheduleRetry]);
  // 复用 F2 的有界在途外壳：同一 key 至多一笔在途、在途再触发只补一次、卸载 abort、换代作废旧回包
  const reload = useBoundedReloader("build-identity", load);

  useEffect(() => {
    reload();
  }, [reload, retryTick]);

  /** 用户「重试 / 刷新身份」与连接恢复信号共用：清旧定时器 + 重新起算重试预算 + 再读一次 */
  const restart = useCallback((): void => {
    clearTimer();
    failCountRef.current = 0;
    setRetryTick((t) => t + 1);
  }, [clearTimer]);

  // 复用既有的"连接恢复"信号（useProjectRefresh 用的同一组 online / 回前台）：**始终注册**——
  // 连上之后后台换了包，online / 回前台也能刷新偏斜判定；每个信号只触发**一次受控读取**，
  // "不叠加"由 load 外面的有界在途外壳保证（同一瞬至多一笔在途，在途再触发只补一次）。
  useEffect(() => {
    const onVisibility = (): void => {
      if (document.visibilityState === "visible") restart();
    };
    window.addEventListener("online", restart);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("online", restart);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [restart]);

  // 卸载：清掉未触发的退避定时器（在途请求由 useBoundedReloader 的卸载 abort 收拾）
  useEffect(() => clearTimer, [clearTimer]);

  const failed = error !== null;
  const serverIdentity = server ?? unknownServer(failed ? `读后端身份失败：${error}` : "尚未取到");
  const verdict = compareBuildIdentities(UI_IDENTITY, serverIdentity);
  const state = failed ? "failed" : server === null ? "loading" : "ok";

  return (
    <details
      data-build-identity-panel
      data-build-identity-state={state}
      data-build-skew={verdict.state}
      data-build-identity-ui={UI_IDENTITY.embedded ? UI_IDENTITY.release_id : "unknown"}
      data-build-identity-server={server !== null && server.embedded ? server.release_id : "unknown"}
      className="px-2 text-[11px] text-neutral-400"
      title="运行部件构建身份：本界面（ui）与运行时后端（server）是否同一批构建"
    >
      <summary className="cursor-pointer select-none">
        构建身份
        <span className={`ml-1 rounded border px-1.5 py-0.5 text-[10px] ${SKEW_TONE[verdict.state]}`} data-build-skew-badge>
          {SKEW_LABEL[verdict.state]}
        </span>
      </summary>
      {/* 展开详情**限高内部滚动**（§3.11「展开详情不吃掉画布」）：左栏项目区不被这块面板压成 0 高 */}
      <div
        data-build-identity-detail
        className="mt-1 max-h-[min(24vh,200px)] space-y-0.5 overflow-y-auto"
      >
        <IdentityLine label="本界面（ui）" id={UI_IDENTITY} />
        <IdentityLine label="运行时后端（server，/health）" id={serverIdentity} />
        <p data-build-skew-detail className="text-neutral-300">
          {verdict.detail}
        </p>
        {failed && <p data-build-identity-error className="text-red-300">读后端身份出错：{error}</p>}
        <p className="text-neutral-500">
          身份取自启动时载入的<strong className="font-semibold text-neutral-400">内嵌常量</strong>
          （构建期 define 内联），不是每次请求读盘上的 build-stamp——后者只说明"产物出自哪次构建运行"，
          不能冒充"本进程加载的是它"。
        </p>
        <p className="text-neutral-500">
          后端未就绪时自动重连（有界退避、次数用尽即停）；网络恢复 / 回前台与下面这个按钮都会再读一次，
          重连换了包可点它刷新偏斜判定。
        </p>
      </div>
      {/* 重试按钮位于详情滚动区外；矮窗口可通过页脚滚动到达。 */}
      <p className="mt-1 text-neutral-500">
        <button
          type="button"
          data-build-identity-retry
          onClick={restart}
          className="rounded border border-neutral-600 px-1.5 py-0.5 text-[10px] text-neutral-300 hover:bg-neutral-800"
        >
          重试 / 刷新身份
        </button>
      </p>
    </details>
  );
}
