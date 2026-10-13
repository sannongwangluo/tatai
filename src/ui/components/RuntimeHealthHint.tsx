// V09-70（DESIGN §3.18「主工作面全局轻量异常提示」、§3.11；PLAN V09-70）。
//
// 主工作面**全局**的一行轻量异常提示：任一主视图可见时都显示（不只在诊断页）。默认只报**异常**——
// `healthy` 保持安静（不占常驻行）；`degraded/unavailable/unknown` 与**本页读取失败**默认态**必须可见**：
// 一行可读提示（状态 + 一句原因 + 观测时间 + 「查看诊断」入口）。它订阅**同一个**监看实例（与诊断页共用），
// 所以"任一主视图可见时 5 秒轻量监看"对全界面只有一份口径、至多一笔在途；本组件只重渲染自己。
//
// 它**不改判据、不写颜色**：状态色只是既有视觉语言对同一份后端读数的呈现；运行健康与交付绿分开。
//
// F01（默认不误导）：一旦**当前读取失败**（`error !== null`，含不可达/超时/退避停止），点与标签取**当前**
// `status`（监看状态机此时一律落 `unknown`），**绝不**沿用上次 `healthy` 的绿点与"运行正常"；保留的历史
// 报告只标"上次读数（旧，非当前）"。只有随后一次真正新鲜的成功才恢复绿点/正常标签。
import { useRuntimeDiagnostics } from "../useRuntimeDiagnostics";
import type { RuntimeHealthState } from "../../shared/runtimeDiagnostics";

const HINT_DOT: Readonly<Record<RuntimeHealthState, string>> = {
  healthy: "bg-emerald-400",
  degraded: "bg-amber-400",
  unavailable: "bg-red-400",
  unknown: "bg-neutral-500",
};

const HINT_TEXT: Readonly<Record<RuntimeHealthState, string>> = {
  healthy: "text-emerald-300",
  degraded: "text-amber-300",
  unavailable: "text-red-300",
  unknown: "text-neutral-300",
};

const HINT_LABEL: Readonly<Record<RuntimeHealthState, string>> = {
  healthy: "运行正常",
  degraded: "运行降级",
  unavailable: "运行不可用",
  unknown: "运行状态未知",
};

function fmtClock(ms: number): string {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function RuntimeHealthHint({ projectId, onOpen }: { projectId: string; onOpen: () => void }) {
  const { state, retry } = useRuntimeDiagnostics(projectId);
  const obs = state.client_observation;
  // F01：当前读取失败（`error` 已置）时**不把上次读数当当前状态**——即使上次是 `healthy`，现在也是 unknown；
  // 这份历史读数只作"旧读数"展示，另标 `stale`（不猜宿主死亡、不用绿点冒充当前正常）。
  const stale = state.report !== null && state.error !== null;
  // healthy 且无本页读取异常 ⇒ 安静（不占常驻行）；旧宿主未接入 ⇒ 交给诊断页明报，全局不噪。
  const quiet =
    !state.supported ||
    (state.report !== null &&
      state.status === "healthy" &&
      state.error === null &&
      obs.failures === 0 &&
      obs.slow === 0);
  if (quiet) return null;

  const status = state.status;
  const headline = state.error !== null ? state.error : runtimeHintHeadline(state);

  return (
    <div
      data-runtime-health-hint
      data-runtime-health={status}
      data-runtime-phase={state.phase}
      data-runtime-client-failures={String(obs.failures)}
      data-runtime-hint-stale={stale ? "1" : "0"}
      className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-neutral-800 bg-neutral-900/40 px-3 py-1.5 text-[11px]"
    >
      <span className={`inline-block h-2 w-2 rounded-full ${HINT_DOT[status]}`} aria-hidden="true" />
      <span data-runtime-hint-label className={`font-medium ${HINT_TEXT[status]}`}>
        {HINT_LABEL[status]}
      </span>
      <span data-runtime-hint-headline className="min-w-0 max-w-[60ch] truncate text-neutral-400" title={headline}>
        {headline}
      </span>
      {state.report_at !== null && (
        <span data-runtime-hint-observed className="text-neutral-600">
          {stale ? "上次读数" : "观测"} {fmtClock(state.report_at)}
          {stale ? "（旧，非当前）" : ""}
        </span>
      )}
      {obs.failures > 0 && (
        <span data-runtime-hint-client-failures className="text-amber-300">
          本页读取失败 {obs.failures} 次
        </span>
      )}
      {obs.slow > 0 && <span className="text-amber-300">慢读 {obs.slow} 次</span>}
      <span className="ml-auto flex gap-1.5">
        <button
          type="button"
          data-runtime-hint-retry
          onClick={retry}
          className="rounded border border-neutral-600 px-1.5 py-0.5 text-[10px] text-neutral-300 hover:bg-neutral-800"
          title="只读再读一次运行诊断（重算退避预算）"
        >
          重试
        </button>
        <button
          type="button"
          data-runtime-hint-open
          onClick={onOpen}
          className="rounded border border-neutral-600 px-1.5 py-0.5 text-[10px] text-neutral-200 hover:bg-neutral-800"
          title="打开运行诊断页看详情"
        >
          查看诊断
        </button>
      </span>
    </div>
  );
}

/** 轻量提示用的一句人话（比诊断页更短；复用同一份读数）。 */
function runtimeHintHeadline(state: ReturnType<typeof useRuntimeDiagnostics>["state"]): string {
  if (state.phase === "grace" && !state.grace_expired) return "正在获取运行状态…";
  if (state.report === null) {
    return state.grace_expired ? "持续读不到运行读数（不显示为正常）" : "还没拿到运行读数";
  }
  const reason = state.report.reasons[0]?.detail;
  if (reason !== undefined && reason !== "") return reason;
  return HINT_LABEL[state.status];
}

export default RuntimeHealthHint;
