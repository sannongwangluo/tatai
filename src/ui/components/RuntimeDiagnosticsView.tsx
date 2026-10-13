// V09-70（DESIGN §3.18「运行诊断页」、§3.11「默认简短、按需详情」、§6.15 读口；PLAN V09-70）。
//
// 专用运行诊断页：沿现有维护诊断入口（辅助入口 `AUX_NAV`，与终端并列），把"塔台现在是否正常运行"
// 以**只读**方式讲清楚——**服务 / 队列 / 近况 / 测得时长**，用**人话**，缺项**如实说"没测到"**（不编数），
// 不暴露源码术语。**运行健康与交付绿分开**（§3.16/§3.18）：本页只看运行证据，不代替交付结论。
//
// 硬口径（逐条守 §3.18/§6.15）：
//   · 状态词表 `healthy/degraded/unavailable/unknown` 用共享契约的中文标签，**不另造判据与颜色语义**；
//   · **超时≠服务已死、503 按 reason 区分**由后端报告承担（这里是显示层）；本页对读失败只如实呈现，
//     前端自身网络失败以**客户端观测**单列（不伪装成后端报告）；
//   · 只读：不写账本、不触发重算、不自愈（导出/重试都只读）；
//   · 窄窗可读、可键盘操作：真实 `<button>`/`<details>`，布局 flex-wrap + 内部滚动限高。
//
// F01（默认不误导）：当前读取失败（`error !== null`）时状态落 `unknown`，页面**不用**上次 healthy 的绿/正常
// 标签；仍保留的历史报告另行**明确标为"上次读数（旧）"**，并说明"只有真正新鲜的成功读取才恢复当前状态"。
import { useState, type ReactNode } from "react";
import {
  runtimeHealthStateLabel,
  type RuntimeAgeState,
  type RuntimeDiagnosticsReport,
  type RuntimeHealthState,
  type RuntimeIncident,
  type RuntimeJobKind,
  type RuntimeQueueReadout,
  type RuntimeTiming,
  type RuntimeTimingStat,
} from "../../shared/runtimeDiagnostics";
import type { RuntimeDiagnosticsMonitorState } from "../runtimeDiagnosticsMonitor";
import { useRuntimeDiagnostics } from "../useRuntimeDiagnostics";

/** 状态色（沿用既有视觉语言；不新增视觉系统）。 */
export const RUNTIME_STATUS_TONE: Readonly<Record<RuntimeHealthState, string>> = {
  healthy: "border-emerald-700/60 bg-emerald-950/30 text-emerald-200",
  degraded: "border-amber-700/60 bg-amber-950/30 text-amber-200",
  unavailable: "border-red-700/60 bg-red-950/30 text-red-200",
  unknown: "border-neutral-600 bg-neutral-800/60 text-neutral-300",
};

const STATUS_DOT: Readonly<Record<RuntimeHealthState, string>> = {
  healthy: "bg-emerald-400",
  degraded: "bg-amber-400",
  unavailable: "bg-red-400",
  unknown: "bg-neutral-500",
};

const AGE_LABEL: Readonly<Record<RuntimeAgeState, string>> = {
  fresh: "较新",
  stale: "该重新看一眼（不自动判失效）",
  unknown: "无成功观测",
};

const JOB_KIND_LABEL: Readonly<Record<RuntimeJobKind, string>> = {
  entry: "接续入口",
  sync_status: "同步对账",
  sync_scan: "同步扫描",
  sync_prep: "同步准备",
  arch_blueprint: "架构图纸",
  arch_render: "架构渲染",
  feature_ledger: "功能清单",
};

const OUTCOME_LABEL: Readonly<Record<RuntimeIncident["outcome"], string>> = {
  failed: "失败",
  timed_out: "超时",
  aborted: "取消",
  rejected_full: "队列满被拒",
  rejected_group_full: "组队列满被拒",
  unavailable: "部件不可用",
};

const QUEUE_MODE_LABEL: Readonly<Record<RuntimeQueueReadout["mode"], string>> = {
  worker: "独立线程",
  local: "主线程内",
  unavailable: "不可用",
  unknown: "未知",
};

/** 一句人话总述（供页面顶部与全局轻量提示共用）。 */
export function runtimeHeadline(state: RuntimeDiagnosticsMonitorState<RuntimeDiagnosticsReport>): string {
  if (!state.supported) return state.unsupported_reason ?? "后端未提供运行诊断读口";
  if (state.phase === "grace" && !state.grace_expired) return "正在获取运行状态…";
  if (state.error !== null) return state.error;
  const reason = state.report?.reasons[0]?.detail;
  if (reason !== undefined && reason !== "") return reason;
  if (state.report === null) return "还没读到达标的运行读数（不显示为正常）";
  return runtimeHealthStateLabel(state.status);
}

export function fmtTime(iso: string | null | undefined): string {
  if (iso === null || iso === undefined || iso === "") return "—";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function fmtAgeMs(ms: number | null): string {
  if (ms === null) return "未知";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)}min`;
}

function fmtStat(stat: RuntimeTimingStat | null): string {
  if (stat === null) return "没测到（不编数）";
  return `均 ${stat.avg_ms}ms ／ ${stat.min_ms}–${stat.max_ms}ms ／ ${stat.count} 次`;
}

function queueLine(q: RuntimeQueueReadout): string {
  return (
    `${QUEUE_MODE_LABEL[q.mode]}｜在处理 ${q.busy}｜排队 ${q.queued}${q.queue_limit > 0 ? `/${q.queue_limit}` : ""}` +
    `｜超时 ${q.timeouts}｜队列满被拒 ${q.rejected_full}` +
    (q.group_queue_limit > 0 ? `｜组队列 ${q.groups_queued}/${q.group_queue_limit}` : "")
  );
}

function downloadTextFile(filename: string, text: string): void {
  const blob = new Blob([text], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function StatusChip({ state }: { state: RuntimeHealthState }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded border px-2 py-0.5 text-xs ${RUNTIME_STATUS_TONE[state]}`}>
      <span className={`inline-block h-2 w-2 rounded-full ${STATUS_DOT[state]}`} aria-hidden="true" />
      <span data-runtime-health={state}>{runtimeHealthStateLabel(state)}</span>
    </span>
  );
}

function Section({ title, children, testid }: { title: string; children: ReactNode; testid?: string }) {
  return (
    <section data-diagnostics-section={testid ?? title} className="rounded border border-neutral-800 bg-neutral-950/40 p-3">
      <h3 className="mb-1.5 text-xs font-semibold text-neutral-300">{title}</h3>
      <div className="space-y-1 text-[11px] leading-relaxed text-neutral-400">{children}</div>
    </section>
  );
}

export function RuntimeDiagnosticsView({ project }: { project: { id: string } }) {
  const { state, retry, buildExport } = useRuntimeDiagnostics(project.id);
  const [exportNote, setExportNote] = useState<string | null>(null);
  const report = state.report;
  // F01：当前读取失败但仍有历史报告 ⇒ 报告是**旧读数**（当前状态是 unknown，不冒充满/绿）。
  const stale = report !== null && state.error !== null;

  const onExport = (): void => {
    const out = buildExport();
    if (out === null) {
      setExportNote("还没有可导出的读数——本次尚未成功读取，导出空壳没有意义。");
      return;
    }
    downloadTextFile(out.filename, out.text);
    setExportNote(
      `已导出脱敏报告 ${out.filename}（typed allowlist：只含枚举/计数/时间/身份；不含正文/query/token/路径；只读，不写账本）。`,
    );
  };

  const phaseNote = ((): string => {
    if (!state.supported) return "未接入：本宿主没有运行诊断读口";
    switch (state.phase) {
      case "paused":
        return "监看已暂停（没有可见的主视图时不再主动读取）";
      case "grace":
        return state.grace_expired ? "持续未知：运行读数还没拿到" : "正在获取（冷启动宽限内，先不报故障）";
      case "retrying":
        return `连接不上，退避重连中（已第 ${state.attempts} 次，最多 6 次）`;
      case "stopped":
        return "监看已停止（重试次数用尽；可用「重试」再触发一轮）";
      default:
        return state.in_flight ? "监看中（每 5 秒一次）·本次读取在途" : "监看中（每 5 秒一次）";
    }
  })();

  return (
    <div
      data-diagnostics-page
      data-runtime-health={state.status}
      data-runtime-phase={state.phase}
      data-runtime-supported={state.supported ? "1" : "0"}
      data-runtime-in-flight={state.in_flight ? "1" : "0"}
      data-runtime-last-success={report?.last_success?.at ?? ""}
      data-runtime-stale={report?.age_state ?? "unknown"}
      data-runtime-client-failures={String(state.client_observation.failures)}
      data-runtime-has-report={report === null ? "0" : "1"}
      data-diagnostics-report-stale={stale ? "1" : "0"}
      className="flex min-h-0 flex-1 flex-col overflow-y-auto p-3 text-neutral-300"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <StatusChip state={state.status} />
        <span data-runtime-headline className="min-w-0 text-xs text-neutral-400">
          {runtimeHeadline(state)}
        </span>
        <span data-runtime-phase-note className="text-[11px] text-neutral-500">
          {phaseNote}
        </span>
        <div className="ml-auto flex gap-1.5">
          <button
            type="button"
            data-diagnostics-retry
            onClick={retry}
            className="rounded border border-neutral-600 px-2 py-0.5 text-[11px] text-neutral-300 hover:bg-neutral-800"
            title="只读重读一次运行诊断（重算退避预算，不重启后端、不拉起写服务）"
          >
            重试
          </button>
          <button
            type="button"
            data-diagnostics-export
            onClick={onExport}
            className="rounded border border-neutral-600 px-2 py-0.5 text-[11px] text-neutral-300 hover:bg-neutral-800"
            title="把服务端已脱敏的读数导出为 runtime-diagnostics-report v1（只读）"
          >
            导出脱敏报告
          </button>
        </div>
      </div>

      {!state.supported && (
        <p data-diagnostics-unsupported className="mt-2 rounded border border-amber-700/60 bg-amber-950/20 px-3 py-2 text-[11px] text-amber-200">
          后端未提供运行诊断读口（旧宿主或路由未登记）——这里明报未接入，不用别的绿状态代替，也不假装有数据。
        </p>
      )}

      {stale && (
        <p data-diagnostics-stale-report className="mt-2 rounded border border-amber-700/60 bg-amber-950/20 px-3 py-2 text-[11px] text-amber-200">
          当前读数读取失败：{state.error}。下方是上次成功读数（{fmtTime(report?.generated_at ?? null)}），
          已标为旧读数，不代表当前状态；只有真正新鲜的成功读取才恢复当前状态（不猜服务已死）。
        </p>
      )}

      <p className="mt-1 text-[11px] text-neutral-500">
        本页只看运行证据（塔台此刻跑得怎么样）；与交付总览的交付绿分开读数、互不代替。超时只表示这次没读到、
        不等于服务已死；读池排队满也只表示该次读取被拒，不等于不可达。
      </p>

      {exportNote !== null && (
        <p data-diagnostics-export-note className="mt-1 text-[11px] text-neutral-400">
          {exportNote}
        </p>
      )}

      <div className="mt-2 grid grid-cols-1 gap-2 lg:grid-cols-2">
        <Section title="概览" testid="overview">
          <div>
            {stale ? "上次读数（旧）生成于：" : "本次读数生成于："}
            <span data-diagnostics-generated>{fmtTime(report?.generated_at ?? null)}</span>
          </div>
          <div>
            最近一次成功：
            {report?.last_success === null || report === null ? (
              <span data-diagnostics-no-last-success>没有成功观测过（不猜为正常）</span>
            ) : (
              <span>
                <span data-diagnostics-last-success>{fmtTime(report.last_success.at)}</span>
                （{fmtAgeMs(report.last_success.age_ms)} 前）
              </span>
            )}
          </div>
          <div>
            新鲜度：<span data-diagnostics-age-state>{report?.age_state ?? "unknown"}</span>
            （{AGE_LABEL[report?.age_state ?? "unknown"]}；阈值 {report?.stale_after_ms ?? 30000}ms —— 只表示"该再看一眼"）
          </div>
          {report?.degraded_since != null && <div>降级起于：{fmtTime(report.degraded_since)}</div>}
          {report !== null && report.reasons.length > 0 && (
            <ul data-diagnostics-reasons className="list-disc pl-4">
              {report.reasons.map((r, i) => (
                <li key={i}>
                  {r.detail} <code className="text-neutral-600">（{r.code}{r.subject !== null ? `／${r.subject}` : ""}）</code>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="服务" testid="service">
          <div>
            进程身份：pid <span data-diagnostics-pid>{report?.process.pid ?? "未知"}</span>
            ｜release <code>{report?.process.release_id ?? "未知"}</code>
          </div>
          <div>
            写服务：{report === null ? "未知" : report.service.reachable ? "可达" : "不可达"}
            ｜描述符 {report === null ? "未知" : report.service.descriptor.present ? `在场（${report.service.descriptor.state}）` : "缺失"}
            {report !== null && report.service.reason !== null ? `｜${report.service.reason}` : ""}
          </div>
          <div>
            构建身份偏斜：
            <span data-diagnostics-skew>{report?.process.build_identity_skew.state ?? "unknown"}</span>——{report?.process.build_identity_skew.detail ?? "无法比较"}
          </div>
        </Section>

        <Section title="队列" testid="queue">
          <div data-diagnostics-queue-read>读池：{report === null ? "未知" : queueLine(report.queue.read)}</div>
          <div data-diagnostics-queue-scan>扫描池：{report === null ? "未知" : queueLine(report.queue.scan)}</div>
        </Section>

        <Section title="测得时长" testid="timing">
          <TimingRow label="排队" timing={report?.timing ?? null} pick={(t) => t.queue_ms} attr="queue" />
          <TimingRow label="执行" timing={report?.timing ?? null} pick={(t) => t.execution_ms} attr="execution" />
          <TimingRow label="合计" timing={report?.timing ?? null} pick={(t) => t.total_ms} attr="total" />
          <div className="text-neutral-600">样本数：{report === null ? "未知" : report.timing.samples}（没有样本就如实说没测到，不编数值）</div>
        </Section>

        <Section title="近况（近期异常，有界）" testid="incidents">
          {report === null ? (
            <div>还没有读数。</div>
          ) : report.incidents.length === 0 ? (
            <div data-diagnostics-incidents-empty>近期没有异常记录。</div>
          ) : (
            <ul data-diagnostics-incidents className="space-y-1">
              {report.incidents.map((it, i) => (
                <li key={i} data-diagnostics-incident={it.outcome} className="rounded border border-neutral-800 px-2 py-1">
                  <span className="text-neutral-500">{fmtTime(it.at)}</span>{" ｜ "}
                  <span className="text-amber-300">{OUTCOME_LABEL[it.outcome]}</span>
                  {it.job_kind !== null && <> ｜ {JOB_KIND_LABEL[it.job_kind]}</>}
                  {" ｜ "}
                  {it.reason}
                  {(it.queue_ms !== null || it.execution_ms !== null) && (
                    <span className="text-neutral-600">
                      {" ｜ "}排队 {it.queue_ms ?? "?"}ms／执行 {it.execution_ms ?? "?"}ms
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="本页读取（客户端观测）" testid="client">
          <div data-diagnostics-client-observation>
            {state.client_observation.failures === 0 && state.client_observation.slow === 0
              ? "最近没有本页读取失败或明显变慢。"
              : `最近 ${Math.round(state.client_observation.window_ms / 1000)} 秒内：读取失败 ${
                  state.client_observation.failures
                } 次、慢读 ${state.client_observation.slow} 次。`}
          </div>
          {state.client_observation.last_failure_at !== null && (
            <div className="text-neutral-500">
              最近一次失败：{fmtTime(new Date(state.client_observation.last_failure_at).toISOString())}
              {state.client_observation.last_failure_status !== null
                ? `（HTTP ${state.client_observation.last_failure_status}）`
                : "（网络层）"}
            </div>
          )}
          <div className="text-neutral-600">
            这是前端到后端的本机网络观测（只统计成败与耗时，不含 URL/query/token/正文），不是后端运行遥测——
            分开列，避免把"这页没读到"误读成"服务队列有问题"。
          </div>
        </Section>
      </div>

      {state.recovery !== null && (
        <p data-diagnostics-recovery className="mt-2 rounded border border-neutral-700 bg-neutral-900/40 px-3 py-1.5 text-[11px] text-neutral-300">
          重连恢复核对：{state.recovery.detail}（故障前 generated_at {fmtTime(state.recovery.previous_generated_at)} → 本次{" "}
          {fmtTime(state.recovery.generated_at)}）
        </p>
      )}

      {report !== null && report.unsupported.length > 0 && (
        <p data-diagnostics-unsupported-gaps className="mt-2 text-[11px] text-amber-300">
          报告标注的不支持项：{report.unsupported.join("、")}（不猜成正常）
        </p>
      )}
    </div>
  );
}

function TimingRow({
  label,
  timing,
  pick,
  attr,
}: {
  label: string;
  timing: RuntimeTiming | null;
  pick: (t: RuntimeTiming) => RuntimeTimingStat | null;
  attr: string;
}) {
  const stat = timing === null ? null : pick(timing);
  return (
    <div data-diagnostics-timing={attr}>
      {label}耗时：<span data-diagnostics-timing-value={attr}>{fmtStat(stat)}</span>
    </div>
  );
}

export default RuntimeDiagnosticsView;
