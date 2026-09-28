// V06-08 验收页（DESIGN.md §3.7 / §3.10 / §3.14、§5.8）：待验收区 + 有效场景证据 + 用户接受/退回。
//
// 口径（每条对应原文一句）：
//   · 「待验收区聚合场景、检查结果、限制与退回原因」（§3.10）→ 每项一张卡：定义里的验收检查项、
//     真实状态与原因、限制/未测项、上一条验收记录。
//   · 「有效场景证据」（§5.6：源变了旧证据不再有效）→ 证据逐条标 **有效 / 已失效**，
//     失效的仍显示（保留历史），但不参与"看起来通过了"。
//   · 「前端项目的结果给可打开的实际运行入口；没有可用入口就明确"尚不可体验"」（§3.7）→
//     服务端没有"运行入口"登记字段，因此如实给"尚不可体验"；**唯一**会渲染成链接的，是项目
//     自己在验收记录里登记过的 http(s) 场景（其余一律纯文本，绝不跑任意协议、绝不执行外部命令）。
//   · 「最终体验接受仍由用户本人记录」（§3.14/§5.8）→ 接受/退回按钮是本页唯一的写动作，
//     写入的是**用户**身份的 v2 人工验收事件；界面文案不把"执行者已提交"说成"已验收"。
import { useEffect, useMemo, useRef, useState } from "react";
import {
  getAcceptance,
  postAcceptance,
  type AcceptancePayload,
  type AcceptanceTaskView,
  type ProjectItem,
  type RuntimeEntryView,
} from "../api";
import { openResultEntry } from "../result-entry";
import { GateTimeline } from "./GateTimeline";

/** 状态词（服务端给 label；这里只做兜底，不在前端造状态） */
const ACCEPT_LABEL: Record<string, string> = {
  pending: "待验收（没有用户验收记录）",
  accepted: "用户已接受",
  rejected: "用户已退回",
  accepted_known_limit: "用户接受已知限制",
};

const ACCEPT_TONE: Record<string, string> = {
  pending: "border-amber-600/50 bg-amber-950/30 text-amber-200",
  accepted: "border-emerald-700/50 bg-emerald-950/30 text-emerald-200",
  rejected: "border-red-600/50 bg-red-950/30 text-red-200",
  accepted_known_limit: "border-sky-700/50 bg-sky-950/30 text-sky-200",
};

type Decision = "accept" | "reject" | "accept_known_limit";

export function AcceptanceView({ project }: { project: ProjectItem }) {
  const [data, setData] = useState<AcceptancePayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const [busyTask, setBusyTask] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [showStage, setShowStage] = useState(false);
  // 受控打开的回执（拒绝打开时说明原因；**不**在打开失败时假装打开成功）
  const [openNotice, setOpenNotice] = useState<Record<string, string>>({});
  const projectIdRef = useRef(project.id);
  projectIdRef.current = project.id;
  const notesRef = useRef(notes);
  notesRef.current = notes;

  useEffect(() => {
    const id = project.id;
    setData(null);
    setLoadError(null);
    setActionError(null);
    getAcceptance(id)
      .then((d) => {
        if (projectIdRef.current !== id) return;
        setData(d);
      })
      .catch((e: Error) => {
        if (projectIdRef.current !== id) return;
        setLoadError(e.message);
      });
  }, [project.id, reloadTick]);

  // 待验收优先：默认把"待验收"的排前面（列表顺序是派生的，不是另一个状态源）
  const ordered = useMemo(() => {
    if (data === null) return [];
    const rank = (t: AcceptanceTaskView) => (t.acceptance === "pending" ? 0 : t.acceptance === "rejected" ? 1 : 2);
    return [...data.tasks].sort((a, b) => rank(a) - rank(b) || a.task_id.localeCompare(b.task_id));
  }, [data]);

  const submit = async (task: AcceptanceTaskView, decision: Decision) => {
    if (busyTask !== null) return;
    setBusyTask(task.task_id);
    setActionError(null);
    try {
      const scenarioRefs = task.scenarios.map((s) => s.ref);
      const evidenceRefs = task.evidence.filter((e) => e.effective).map((e) => e.evidence_id);
      await postAcceptance(project.id, {
        decision,
        task_id: task.task_id,
        scenario_refs: scenarioRefs,
        evidence_refs: evidenceRefs,
        note: (notesRef.current[task.task_id] ?? "").trim() === "" ? null : notesRef.current[task.task_id].trim(),
      });
      setReloadTick((t) => t + 1);
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusyTask(null);
    }
  };

  // 受控打开（§3.7）：只走 `result-entry.ts` 的协议白名单 + 壳内 opener/浏览器降级；
  // 拒绝打开时如实上屏原因，**不**伪造"已打开"，也**不**顺手写任何验收记录（打开 ≠ 接受，§5.8）。
  const openEntry = (entry: RuntimeEntryView) => {
    const plan = openResultEntry(entry.url);
    setOpenNotice((n) => ({
      ...n,
      [entry.source_record_id + "|" + entry.scenario]: plan.open
        ? plan.via === "shell_browser"
          ? "已交系统浏览器打开（壳内受控打开）"
          : "已在新标签页打开（浏览器降级：地址栏由你自己掌控）"
        : (plan.reason ?? "这个地址不会打开"),
    }));
  };

  if (loadError !== null) {
    return (
      <div className="w-full p-8" data-acceptance-view data-acceptance-load-error>
        <p className="text-sm text-red-400">验收区加载失败：{loadError}</p>
        <button
          data-acceptance-retry
          onClick={() => setReloadTick((t) => t + 1)}
          className="mt-2 rounded border border-red-500/40 px-2 py-1 text-xs text-red-300 hover:bg-red-500/20"
        >
          重试
        </button>
      </div>
    );
  }
  if (data === null) {
    return (
      <div className="w-full p-8" data-acceptance-view data-acceptance-loading>
        <p className="text-sm text-neutral-500">加载验收区…</p>
      </div>
    );
  }

  return (
    <div className="w-full space-y-4 p-4" data-acceptance-view>
      <header className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-neutral-400">
        <h2 className="text-sm font-semibold text-neutral-100">待验收区</h2>
        <span data-acceptance-counts>
          待验收 <b data-acceptance-pending-count>{data.counts.pending}</b> · 已接受{" "}
          <b data-acceptance-accepted-count>{data.counts.accepted}</b> · 已退回{" "}
          <b data-acceptance-rejected-count>{data.counts.rejected}</b> · 接受已知限制{" "}
          <b>{data.counts.accepted_known_limit}</b>
        </span>
        <span className="text-neutral-500">{data.basis}</span>
        <button
          data-acceptance-stage-toggle
          onClick={() => setShowStage((v) => !v)}
          className="rounded border border-neutral-700 px-2 py-0.5 text-[11px] text-neutral-300 hover:bg-neutral-800"
        >
          {showStage ? "收起阶段摘要" : "展开阶段摘要（用户 Gate）"}
        </button>
      </header>

      {/* §3.7：可体验运行入口来自**成果登记**（谁在什么时候登记、对应哪批成果与哪版、现在还有效吗），
          与用户是否已提交验收记录**无关**——所以用户还没接受时这里也照样有入口（补修 F ③）。
          没有入口就明写"尚不可体验"；登记过但探测失败/过期的，**逐条说明状态**，不静默消失（补修 F ⑤）。 */}
      <section
        data-runtime-entries
        data-runtime-entry-summary-kind={data.runtime_entry_summary.kind}
        className="rounded border border-neutral-800 bg-neutral-900/40 p-3 text-xs"
      >
        <h3 className="flex flex-wrap items-center gap-2 font-semibold text-neutral-200">
          可体验运行入口（§3.7）
          <span
            data-runtime-entry-summary-label
            className={`rounded px-1.5 py-0.5 text-[11px] ${
              data.runtime_entry_summary.kind === "available"
                ? "bg-emerald-950/60 text-emerald-200"
                : data.runtime_entry_summary.kind === "stale"
                  ? "bg-amber-950/60 text-amber-200"
                  : "bg-neutral-950/60 text-neutral-400"
            }`}
          >
            {data.runtime_entry_summary.label}
          </span>
          <span className="text-[11px] font-normal text-neutral-500">
            打开入口 ≠ 用户接受（§5.8，接受/退回在下面的待验收区里单独记）
          </span>
        </h3>
        <p data-runtime-entry-summary-note className="mt-1 text-[11px] text-neutral-400">
          {data.runtime_entry_summary.note}
        </p>
        {data.runtime_entries.length === 0 ? (
          <p data-runtime-entry-empty className="mt-1 text-[11px] text-neutral-500">
            尚不可体验：还没有成果登记过可打开的运行入口。
          </p>
        ) : (
          <ul data-runtime-entry-list className="mt-2 space-y-1">
            {data.runtime_entries.map((e) => {
              const key = e.source_record_id + "|" + e.scenario;
              return (
                <li
                  key={key}
                  data-runtime-entry={key}
                  data-runtime-entry-state={e.state}
                  data-runtime-entry-revision-state={e.revision_state}
                  data-runtime-entry-openable={e.openable ? "1" : "0"}
                  className="rounded border border-neutral-800 bg-neutral-950/40 px-2 py-1"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span data-runtime-entry-scenario className="font-semibold text-neutral-100">
                      {e.scenario}
                    </span>
                    <span data-runtime-entry-url className="font-mono text-[11px] text-sky-300">
                      {e.url}
                    </span>
                    <span
                      data-runtime-entry-status
                      className={`rounded px-1.5 py-0.5 text-[11px] ${
                        e.state === "openable"
                          ? "bg-emerald-950/60 text-emerald-200"
                          : e.state === "reverify_due"
                            ? "bg-sky-950/60 text-sky-200"
                            : "bg-amber-950/60 text-amber-200"
                      }`}
                    >
                      {e.state_label}
                    </span>
                    {e.openable ? (
                      <button
                        data-runtime-entry-open
                        onClick={() => openEntry(e)}
                        className="rounded border border-sky-700/60 px-2 py-0.5 text-[11px] text-sky-300 hover:bg-sky-900/40"
                      >
                        打开入口
                      </button>
                    ) : (
                      <span data-runtime-entry-blocked className="text-[11px] text-amber-200">
                        当前不可打开（不是"尚不可体验"：这条是登记过的入口）
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 flex flex-wrap gap-x-3 text-[11px] text-neutral-500">
                    <span data-runtime-entry-source>
                      {e.source_kind === "submission" ? "来源成果" : "来源结果回报"} {e.source_record_id}
                      {e.source_revision === null
                        ? "（这条登记没声明版本）"
                        : ` · ${e.source_revision_kind ?? "修订"} ${e.source_revision}`}
                    </span>
                    <span data-runtime-entry-submitter>登记人 {e.source_submitted_by}</span>
                    <span data-runtime-entry-registered-at>登记时间 {e.registered_at}</span>
                    <span data-runtime-entry-verified-at>验证时间 {e.verified_at}</span>
                    <span
                      data-runtime-entry-revision
                      className={e.revision_state === "outdated" ? "text-amber-200" : undefined}
                    >
                      版本：{e.revision_label}
                    </span>
                  </div>
                  {e.reason !== null && (
                    <p data-runtime-entry-reason className="mt-0.5 text-[11px] text-amber-200">
                      不可用原因：{e.reason}
                    </p>
                  )}
                  {openNotice[key] !== undefined && (
                    <p data-runtime-entry-open-notice className="mt-0.5 text-[11px] text-neutral-300">
                      {openNotice[key]}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* §3.4：阶段摘要置于实况与验收页；用户 Gate 与人工验收是两件事，分开呈现 */}
      {showStage && (
        <section data-acceptance-stage className="rounded border border-neutral-800 bg-neutral-900/40 p-3">
          <h3 className="mb-2 text-xs font-semibold text-neutral-300">阶段摘要（用户 Gate，§3.4）</h3>
          <StageSummary project={project} />
        </section>
      )}

      {actionError !== null && (
        <p data-acceptance-action-error className="rounded border border-red-600/40 bg-red-950/30 px-3 py-2 text-xs text-red-300">
          验收记录没写进去：{actionError}
        </p>
      )}

      {data.tasks.length === 0 && (
        <p data-acceptance-empty className="rounded border border-neutral-800 bg-neutral-900/60 px-3 py-2 text-xs text-neutral-500">
          还没有任何任务进入运行状态，因此没有可验收项（这不是"全部通过"）。
        </p>
      )}

      <ul className="space-y-3">
        {ordered.map((t) => (
          <li
            key={t.task_id}
            data-acceptance-task={t.task_id}
            data-acceptance-state={t.acceptance}
            className={`rounded border px-3 py-3 text-xs ${ACCEPT_TONE[t.acceptance] ?? "border-neutral-800 bg-neutral-900/60"}`}
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-sm font-semibold" data-acceptance-task-id>
                {t.task_id}
              </span>
              <span className="min-w-0 flex-1 truncate text-neutral-100">{t.goal}</span>
              <span data-acceptance-state-label className="rounded bg-neutral-950/50 px-1.5 py-0.5 text-[11px]">
                {ACCEPT_LABEL[t.acceptance] ?? t.acceptance}
              </span>
              <span data-acceptance-execution className="rounded bg-neutral-950/50 px-1.5 py-0.5 text-[11px]">
                执行：{t.execution_label ?? "无运行状态"}
              </span>
              {t.display_status_label !== null && (
                <span data-acceptance-display className="rounded bg-neutral-950/50 px-1.5 py-0.5 text-[11px]">
                  {t.display_status_label}
                </span>
              )}
            </div>

            {/* 真实状态原因 + 缺项：未知不显成功（这里是"为什么还不是通过"的可读原因） */}
            {t.reasons.length > 0 && (
              <ul data-acceptance-reasons className="mt-1 space-y-0.5 text-[11px] text-neutral-300">
                {t.reasons.map((r) => (
                  <li key={r.code}>· {r.text}</li>
                ))}
              </ul>
            )}
            {t.missing.length > 0 && (
              <p data-acceptance-missing className="mt-1 text-[11px] text-amber-200">
                缺项：{t.missing.map((m) => m.label).join("；")}
              </p>
            )}

            {/* 有效场景证据（失效的仍列出，但标明不作数） */}
            <div className="mt-2 space-y-1">
              <h4 className="text-[11px] font-semibold text-neutral-400">有效场景证据</h4>
              {t.evidence.length === 0 ? (
                <p data-acceptance-no-evidence className="text-[11px] text-neutral-500">
                  没有绑定任何证据（没有证据的"通过"不算通过，§5.5）
                </p>
              ) : (
                <ul data-acceptance-evidence className="space-y-0.5 text-[11px]">
                  {t.evidence.map((e) => (
                    <li key={e.evidence_id} data-acceptance-evidence-item={e.evidence_id}
                        data-acceptance-evidence-effective={e.effective ? "1" : "0"}>
                      <span className={e.effective ? "text-emerald-300" : "text-neutral-500 line-through"}>
                        [{e.effective ? "有效" : "已失效"}]
                      </span>{" "}
                      <span className="text-neutral-300">{e.summary}</span>{" "}
                      <span className="font-mono text-neutral-500">
                        {e.evidence_id.slice(0, 10)}…{e.recovery_path === null ? "" : ` @ ${e.recovery_path}`}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* 场景：**用户验收记录里**登记的场景引用（补修 F ③ 之后，可体验入口以页首的「可体验运行入口」
                为准；这里保留历史口径，只有 http(s) 的渲染成链接、其余按可读文本给，判据一字未动） */}
            <div className="mt-2 space-y-1">
              <h4 className="text-[11px] font-semibold text-neutral-400">验收记录里登记的场景</h4>
              {t.scenarios.length === 0 ? (
                <p data-acceptance-no-scenario className="text-[11px] text-neutral-500">
                  还没有登记任何验收场景
                </p>
              ) : (
                <ul data-acceptance-scenarios className="space-y-0.5 text-[11px]">
                  {t.scenarios.map((s) => (
                    <li key={s.ref} data-acceptance-scenario={s.ref} data-acceptance-scenario-kind={s.kind}>
                      {s.url === null ? (
                        <span className="text-neutral-300">{s.ref}</span>
                      ) : (
                        <a
                          data-result-link={s.url}
                          href={s.url}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="text-sky-400 underline"
                        >
                          {s.ref}
                        </a>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              <p
                data-acceptance-result-entry
                data-acceptance-result-entry-kind={t.result_entry.kind}
                className="text-[11px] text-neutral-500"
              >
                {t.result_entry.note}
              </p>
            </div>

            {/* 纯后端可读场景：输入 / 期望 / 实际 / 证据（不把模拟输出当实际运行） */}
            <div data-acceptance-readable className="mt-2 rounded border border-neutral-800 bg-neutral-950/50 p-2 text-[11px]">
              <h4 className="font-semibold text-neutral-400">可读场景（纯后端：输入/期望/实际/证据）</h4>
              <dl className="mt-1 space-y-0.5">
                <div className="flex gap-2">
                  <dt className="w-10 shrink-0 text-neutral-500">输入</dt>
                  <dd data-acceptance-input className="min-w-0 break-all text-neutral-300">
                    {t.readable_scenario.input}
                  </dd>
                </div>
                <div className="flex gap-2">
                  <dt className="w-10 shrink-0 text-neutral-500">期望</dt>
                  <dd data-acceptance-expected className="min-w-0 text-neutral-300">
                    {t.readable_scenario.expected}
                  </dd>
                </div>
                <div className="flex gap-2">
                  <dt className="w-10 shrink-0 text-neutral-500">实际</dt>
                  <dd data-acceptance-actual className="min-w-0 text-neutral-300">
                    {t.readable_scenario.actual}
                  </dd>
                </div>
                <div className="flex gap-2">
                  <dt className="w-10 shrink-0 text-neutral-500">证据</dt>
                  <dd data-acceptance-evidence-text className="min-w-0 text-neutral-300">
                    {t.readable_scenario.evidence}
                  </dd>
                </div>
              </dl>
            </div>

            {/* 限制与未测项（§3.10：待验收区聚合限制与退回原因） */}
            {t.submission !== null &&
              (t.submission.untested.length > 0 || t.submission.known_issues.length > 0) && (
                <div data-acceptance-limits className="mt-2 text-[11px] text-amber-200">
                  {t.submission.untested.length > 0 && (
                    <p>
                      未测项：{t.submission.untested.map((u) => `${u.item}（${u.reason}）`).join("；")}
                    </p>
                  )}
                  {t.submission.known_issues.length > 0 && (
                    <p>已知问题：{t.submission.known_issues.join("；")}</p>
                  )}
                </div>
              )}

            {/* 上一条验收记录 + 退回原因 */}
            {t.latest_acceptance !== null && (
              <p data-acceptance-last-record className="mt-2 text-[11px] text-neutral-400">
                最近一条验收记录：{t.latest_acceptance.decision} · by {t.latest_acceptance.accepted_by} ·{" "}
                {t.latest_acceptance.at}
                {t.latest_acceptance.note === null ? "" : ` · 原因/说明：${t.latest_acceptance.note}`}
              </p>
            )}

            {/* 用户接受 / 退回（本页唯一写动作；§5.8 只接受真实用户身份） */}
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <input
                data-acceptance-note={t.task_id}
                value={notes[t.task_id] ?? ""}
                onChange={(e) => setNotes((n) => ({ ...n, [t.task_id]: e.target.value }))}
                placeholder="验收说明／退回原因（可留空，但退回建议写清）"
                className="min-w-40 flex-1 rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-[11px] text-neutral-200 placeholder:text-neutral-600"
              />
              <button
                data-acceptance-accept={t.task_id}
                disabled={busyTask !== null}
                onClick={() => void submit(t, "accept")}
                className="rounded bg-emerald-700 px-2.5 py-1 text-[11px] font-semibold text-neutral-950 hover:bg-emerald-600 disabled:opacity-40"
              >
                接受
              </button>
              <button
                data-acceptance-reject={t.task_id}
                disabled={busyTask !== null}
                onClick={() => void submit(t, "reject")}
                className="rounded bg-red-700 px-2.5 py-1 text-[11px] font-semibold text-neutral-950 hover:bg-red-600 disabled:opacity-40"
              >
                退回
              </button>
              <button
                data-acceptance-accept-limit={t.task_id}
                disabled={busyTask !== null}
                onClick={() => void submit(t, "accept_known_limit")}
                className="rounded border border-neutral-700 px-2.5 py-1 text-[11px] text-neutral-300 hover:bg-neutral-800 disabled:opacity-40"
              >
                接受已知限制
              </button>
            </div>
          </li>
        ))}
      </ul>

      <section data-acceptance-manifest className="rounded border border-neutral-800 bg-neutral-900/40 p-3 text-xs">
        <h3 className="font-semibold text-neutral-300">证据清单（全部 {data.evidence_manifest.length} 条）</h3>
        {data.evidence_manifest.length === 0 ? (
          <p className="mt-1 text-[11px] text-neutral-500">还没有任何证据正文</p>
        ) : (
          <ul className="mt-1 space-y-0.5 text-[11px] text-neutral-400">
            {data.evidence_manifest.map((m) => (
              <li key={m.evidence_id} data-acceptance-manifest-item={m.evidence_id}>
                {m.kind} · {m.summary} · {m.recovery_path}
                {m.intact ? "" : "（内容哈希对不上，已标损坏）"}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/** 阶段摘要（§3.4）：复用 GateTimeline（用户 Gate 与人工验收分开记录，不互相代签） */
function StageSummary({ project }: { project: ProjectItem }) {
  return <GateTimeline project={project} />;
}
