// V09-70（DESIGN §3.18/§6.15；PLAN V09-70「文件责任」）。
//
// 把监看状态机（`runtimeDiagnosticsMonitor.ts`）装配成**单一模块级实例**，并把界面两处
// （全局轻量异常提示 `RuntimeHealthHint` 与专用诊断页 `RuntimeDiagnosticsView`）接到同一份状态上：
//   · 读口固定为本地只读 `GET /api/runtime/diagnostics`（不索要 work token，§6.15）；
//   · 返回体经共享 `sanitizeRuntimeDiagnosticsReport` 重建（typed allowlist），前端不另写字段/判据；
//   · 读失败的分类只用于"要不要退避重试"：**没连上**才退避，**旧宿主/未接入**明报支持缺位，
//     其余（含 503 按 reason）如实报出、按常规监看节奏继续，**不**一律当成服务已死；
//   · 客户端观测旁路接到 `sharedRead` 的唯一裸 fetch 出口上——只读统计，**不采集** URL/query/token/正文，
//     且**排除**运行诊断读口本身（避免诊断请求自我递归，§3.18）。
//
// 两处消费者各自 `useSyncExternalStore` 订阅**同一个实例**：所以"任一瞬间至多一笔在途""5 秒一次"
// 对全界面只有一份口径；App 不为此包一层会重渲染整棵工作区的 Provider（各消费者只重渲染自己）。

import { useEffect, useMemo, useSyncExternalStore } from "react";
import {
  getDiagnostics,
  isBackendUnreachable,
  type DiagnosticsParams,
} from "./api";
import { setSharedReadObserver } from "./sharedRead";
import {
  buildRuntimeDiagnosticsExport,
  type RuntimeClientObservation,
  type RuntimeDiagnosticsReport,
} from "../shared/runtimeDiagnostics";
import {
  RuntimeDiagnosticsMonitor,
  browserMonitorEnv,
  type ClientObservation,
  type RuntimeDiagnosticsDigest,
  type RuntimeDiagnosticsMonitorState,
  type RuntimeReadErrorClass,
} from "./runtimeDiagnosticsMonitor";

/** 读失败分类（只决定是否退避重试；**不**把超时/503 一律当成不可达）。 */
function classifyError(message: string): RuntimeReadErrorClass {
  if (/\[UNSUPPORTED\]|unsupported/i.test(message)) return "unsupported";
  if (isBackendUnreachable(message)) return "unreachable";
  return "business";
}

/** 报告摘要：状态（单一判据来自后端同源报告）+ 用于恢复核验的时间与宿主身份。 */
function digestOf(report: RuntimeDiagnosticsReport): RuntimeDiagnosticsDigest {
  return {
    status: report.status,
    generated_at: report.generated_at,
    host_id: `${report.process.pid ?? "?"}:${report.process.release_id ?? "unknown"}`,
  };
}

let singleton: RuntimeDiagnosticsMonitor<RuntimeDiagnosticsReport> | null = null;

/** 取（必要时创建）**单一**监看实例；界面所有消费者共用这一份。 */
export function getRuntimeDiagnosticsMonitor(): RuntimeDiagnosticsMonitor<RuntimeDiagnosticsReport> {
  if (singleton === null) {
    const created = new RuntimeDiagnosticsMonitor<RuntimeDiagnosticsReport>({
      env: browserMonitorEnv(),
      fetchReport: (ctx: { projectId: string | null; signal: AbortSignal }) =>
        getDiagnostics({ projectId: ctx.projectId, signal: ctx.signal } as DiagnosticsParams),
      digest: digestOf,
      classifyError,
    });
    // 客户端观测旁路：只并入"读失败/慢读"，且诊断读口自身已在 monitor 内排除。
    setSharedReadObserver((event) => created.observeRead(event));
    singleton = created;
  }
  return singleton;
}

/** 把界面侧的客户端观测聚合折算成共享契约里的 `client_observation`（导出用；无失败/慢读则为 null）。 */
function clientObservationOf(obs: ClientObservation, nowIso: string): RuntimeClientObservation | null {
  if (obs.failures === 0 && obs.slow === 0) return null;
  const at = obs.last_failure_at === null ? nowIso : new Date(obs.last_failure_at).toISOString();
  const windowSec = Math.round(obs.window_ms / 1000);
  return {
    kind: "client_observation",
    at,
    state: "unknown",
    reason:
      `本页读取：最近 ${windowSec} 秒内 ${obs.failures} 次读取失败、${obs.slow} 次慢读` +
      `（前端到后端的本机网络观测，不是后端运行遥测；不含 URL/query/token/正文）`,
  };
}

/** 构造脱敏导出文件（`runtime-diagnostics-report v1`）；无报告读数时返回 null（不导出空壳）。 */
export function buildRuntimeDiagnosticsExportFile(
  state: RuntimeDiagnosticsMonitorState<RuntimeDiagnosticsReport>,
): { filename: string; text: string } | null {
  const report = state.report;
  if (report === null) return null;
  const nowIso = new Date().toISOString();
  const body = buildRuntimeDiagnosticsExport(report, clientObservationOf(state.client_observation, nowIso), { now: nowIso });
  const stamp = (report.generated_at === "" ? nowIso : report.generated_at).replace(/[:.]/g, "-");
  return { filename: `runtime-diagnostics-${stamp}.json`, text: JSON.stringify(body, null, 2) };
}

export interface RuntimeDiagnosticsBinding {
  state: RuntimeDiagnosticsMonitorState<RuntimeDiagnosticsReport>;
  /** 手动「重试」：重算退避预算并立即再读一轮（焦点/online 同一入口） */
  retry: () => void;
  /** 构造脱敏导出体（含客户端观测）；无报告时 null */
  buildExport: () => { filename: string; text: string } | null;
}

/**
 * 订阅**单一**监看实例（项目 id 非 null 时主视图可见 ⇒ 每 5 秒轻量监看）。
 * 多个消费者各自订阅同一实例、只重渲染自己；`setContext` 幂等（同项目重复调用即返回）。
 */
export function useRuntimeDiagnostics(projectId: string | null): RuntimeDiagnosticsBinding {
  const monitor = getRuntimeDiagnosticsMonitor();
  const state = useSyncExternalStore(monitor.subscribe, monitor.getSnapshot, monitor.getSnapshot);
  useEffect(() => {
    monitor.setContext(projectId);
  }, [monitor, projectId]);
  return useMemo<RuntimeDiagnosticsBinding>(
    () => ({
      state,
      retry: () => monitor.retryNow(),
      buildExport: () => buildRuntimeDiagnosticsExportFile(monitor.getSnapshot()),
    }),
    [monitor, state],
  );
}
