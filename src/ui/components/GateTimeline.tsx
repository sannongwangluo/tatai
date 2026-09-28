// G2 七步时间线视图（DESIGN.md §3.4）：横向 7 步 Gate 节点，三态着色（已过绿/打回红/待定灰），
// 当前步有视觉标记，点击节点展开该步记录（note + 时间戳）。
// 数据源：GET :id/progress（§2.3.2）+ GET :id/gate.jsonl（§2.3.3），切项目即重取。
// G3 人手点过关/打回（§5.2：只有人能触发转移）：过关只对【当前步】；打回可选任意步（含已过
// 的历史步，2026-09-19 主人拍板——历史步打回后 current_step 拉回该步、其后步重置待定）。
// by 固定 "user"；打回 note 必填；当前步是 deliver 时提供「迭代回需求」入口（§5.1，回第 ② 步重走）。
// 权限红线：MCP 工具（M 系卡）没有任何改 Gate 的接口（§5.2 / §6.3 工具清单无 gate 写入工具），
// 转移只能从这里由人点出来。
import { useEffect, useState } from "react";
// GATE_STEPS 的**值**从浏览器安全的 src/shared/gateSteps.ts 取（2026-09-20 构建回归修复：
// 从 server/workstation 值导入会把 node:child_process 拉进前端包）；Gate 数据类型仍走 type-only 导入。
import { GATE_STEPS } from "../../shared/gateSteps";
import type { GateLine, GateStepResult, Progress } from "../../server/workstation";
import { ReconcileCats } from "../arch/ReconcileCats";
import { countMatchedByVia } from "../arch/reconcileClass";
import {
  getGateLines,
  getProgress,
  postGateBack,
  postGateTransition,
  type GateReconcile,
  type ProjectItem,
} from "../api";

/** 三态着色（§3.4）：pass 绿 / reject 红 / pending 灰 */
const NODE_COLOR: Record<GateStepResult, string> = {
  pass: "bg-green-600 border-green-500",
  reject: "bg-red-600 border-red-500",
  pending: "bg-neutral-700 border-neutral-600",
};

/** 三态中文名 */
const RESULT_LABEL: Record<GateStepResult, string> = {
  pass: "已过",
  reject: "打回",
  pending: "待定",
};

const RESULT_TEXT_COLOR: Record<GateStepResult, string> = {
  pass: "text-green-400",
  reject: "text-red-400",
  pending: "text-neutral-500",
};

export function GateTimeline({ project }: { project: ProjectItem }) {
  const [progress, setProgress] = useState<Progress | null>(null);
  const [lines, setLines] = useState<GateLine[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  // 展开的节点（点同一个节点收起）；只控制详情面板，不触发任何写操作
  const [expandedStep, setExpandedStep] = useState<string | null>(null);
  // G3 操作态：当前动作（过关/打回）与 note 输入、迭代确认态、提交中与错误
  const [action, setAction] = useState<"pass" | "reject" | null>(null);
  // 打回目标步（2026-09-19 主人拍板：任意步可打回，含已过的历史步）；过关仍只对当前步
  const [rejectTarget, setRejectTarget] = useState<string | null>(null);
  const [noteInput, setNoteInput] = useState("");
  const [iterating, setIterating] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  /** Q38（2026-09-18 审计）：本次过关/打回触发的对账结果（服务端每次都跑一次并随响应带回
   *  "作为过关参考之一"）。此前客户端把它整段丢掉，A5 对账结果在决策现场不可见。 */
  const [gateReconcile, setGateReconcile] = useState<GateReconcile | null>(null);
  /** V09-08 ③：过关现场的对账也按**分类分计**（同一份共享判据与词表；错误态没有分类 ⇒ 空表） */
  const gateOnlyInCode = gateReconcile !== null && !("error" in gateReconcile) ? gateReconcile.only_in_code : [];
  const gateMatchedByVia = countMatchedByVia(
    gateReconcile !== null && !("error" in gateReconcile) ? gateReconcile.matched : [],
  );

  // 切项目联动（G2 DoD④）：project.id 一变就重取两个数据源，并收起已展开的详情与操作态
  useEffect(() => {
    let stale = false;
    setProgress(null);
    setLines([]);
    setLoadError(null);
    setExpandedStep(null);
    setAction(null);
    setNoteInput("");
    setIterating(false);
    setActionError(null);
    setGateReconcile(null);
    Promise.all([getProgress(project.id), getGateLines(project.id)])
      .then(([p, l]) => {
        if (stale) return;
        setProgress(p);
        setLines(l);
      })
      .catch((e: Error) => {
        if (!stale) setLoadError(e.message);
      });
    return () => {
      stale = true;
    };
  }, [project.id]);

  // G3：操作后即时刷新——重新拉 progress + gate.jsonl（界面状态与落盘文件一致）
  async function reload() {
    const [p, l] = await Promise.all([getProgress(project.id), getGateLines(project.id)]);
    setProgress(p);
    setLines(l);
  }

  // G3：提交过关/打回（by 固定 user，见 api.ts；后端另有同样强制，双保险）。
  // 过关只对当前步；打回可选任意步（默认当前步，2026-09-19 主人拍板——含已过的历史步）
  async function submitAction() {
    if (!progress || !action) return;
    setSubmitting(true);
    setActionError(null);
    try {
      const step =
        action === "reject" && rejectTarget !== null ? rejectTarget : progress.gate.current_step;
      const { reconcile } = await postGateTransition(project.id, {
        step,
        result: action,
        note: noteInput.trim() === "" ? null : noteInput.trim(),
      });
      setGateReconcile(reconcile); // Q38：本次过关/打回的对账结果上屏（过关参考之一，§4.5）
      setAction(null);
      setNoteInput("");
      setRejectTarget(null);
      await reload();
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  // G3：迭代回「需求」步（§5.1：回第 ② 步重走，不是回设计或开发）
  async function submitIterate() {
    setSubmitting(true);
    setActionError(null);
    try {
      await postGateBack(project.id);
      setIterating(false);
      await reload();
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  if (loadError) {
    return (
      <div className="mx-auto w-full max-w-3xl p-8">
        <p className="text-sm text-red-400">Gate 时间线加载失败：{loadError}</p>
      </div>
    );
  }
  if (!progress) {
    return (
      <div className="mx-auto w-full max-w-3xl p-8">
        <p className="text-sm text-neutral-500">加载 Gate 时间线…</p>
      </div>
    );
  }

  const currentStep = progress.gate.current_step;
  const currentName = GATE_STEPS.find((s) => s.id === currentStep)?.name ?? currentStep;
  const expanded = expandedStep
    ? progress.gate.history.find((h) => h.step === expandedStep) ?? null
    : null;
  const expandedLines = expandedStep ? lines.filter((l) => l.step === expandedStep) : [];

  return (
    <div data-gate-timeline className="mx-auto w-full max-w-4xl space-y-6 p-8">
      <header className="flex items-baseline gap-3">
        <h2 className="text-lg font-semibold">{project.name} · Gate 时间线</h2>
        <span data-gate-current className="text-xs text-neutral-500">
          当前步：<span className="text-sky-400">{currentName}（{currentStep}）</span>
        </span>
      </header>

      {/* ── 横向七步（§3.4）：连线垫底，节点按 GATE_STEPS 顺序横排 ── */}
      <div className="relative">
        <div className="absolute left-[7%] right-[7%] top-8 h-0.5 bg-neutral-800" />
        <div className="relative grid grid-cols-7">
          {GATE_STEPS.map((s) => {
            const h = progress.gate.history.find((h) => h.step === s.id);
            const result = h?.result ?? "pending";
            const isCurrent = s.id === currentStep;
            const isExpanded = s.id === expandedStep;
            return (
              <div key={s.id} className="flex flex-col items-center gap-1">
                {/* 当前步标记行（固定高度占位，未当前步时布局不跳） */}
                <span className="h-4 text-[10px] leading-4 text-sky-400">
                  {isCurrent ? "▼ 当前" : ""}
                </span>
                <button
                  type="button"
                  data-step={s.id}
                  data-result={result}
                  data-current={isCurrent ? "true" : "false"}
                  onClick={() => setExpandedStep(isExpanded ? null : s.id)}
                  title={`${s.name}（${RESULT_LABEL[result]}）—— 点开看记录`}
                  className={`h-8 w-8 rounded-full border-2 ${NODE_COLOR[result]} ${
                    isCurrent ? "ring-2 ring-sky-400 ring-offset-2 ring-offset-neutral-950" : ""
                  } ${isExpanded ? "outline outline-1 outline-neutral-400" : ""}`}
                />
                <span className="text-xs text-neutral-300">{s.name}</span>
                <span className={`text-[10px] ${RESULT_TEXT_COLOR[result]}`}>
                  {RESULT_LABEL[result]}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── G3 操作区（§5.2：只有人能触发转移，by 固定 user）：只对当前步给「过关」「打回」── */}
      <section
        data-gate-actions
        className="rounded border border-neutral-800 bg-neutral-900/60 p-4"
      >
        <p className="text-xs text-neutral-400">
          当前步「{currentName}」验收（§5.2：只有人能触发转移，agent 经 MCP 无法改 Gate）。
          过关只对当前步；打回可选任意步（含已过的历史步——2026-09-19 主人拍板）。
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          <button
            type="button"
            data-gate-action="pass"
            onClick={() => {
              setAction("pass");
              setNoteInput("");
              setIterating(false);
              setActionError(null);
            }}
            className="rounded bg-green-700 px-3 py-1 text-xs text-neutral-100 hover:bg-green-600"
          >
            过关
          </button>
          <button
            type="button"
            data-gate-action="reject"
            onClick={() => {
              setAction("reject");
              setRejectTarget(progress.gate.current_step);
              setNoteInput("");
              setIterating(false);
              setActionError(null);
            }}
            className="rounded bg-red-800 px-3 py-1 text-xs text-neutral-100 hover:bg-red-700"
          >
            打回
          </button>
          {/* §5.1 迭代入口：仅当前步是交付/运维（deliver）时出现 */}
          {currentStep === "deliver" && (
            <button
              type="button"
              data-gate-iterate
              onClick={() => {
                setIterating(true);
                setAction(null);
                setActionError(null);
              }}
              className="rounded border border-amber-700 px-3 py-1 text-xs text-amber-300 hover:bg-amber-900/40"
            >
              迭代回需求
            </button>
          )}
        </div>

        {/* 过关/打回表单：note 过关可选、打回必填（打回必须说明理由）；
            打回可选目标步（任意步可打回——历史步打回后从该步重走、其后步重置待定） */}
        {action && (
          <div className="mt-3 space-y-2 border-t border-neutral-800 pt-3">
            {action === "reject" && (
              <div className="flex flex-wrap items-center gap-2">
                <label htmlFor="gate-reject-target" className="text-xs text-neutral-400">
                  打回目标步：
                </label>
                <select
                  id="gate-reject-target"
                  data-gate-reject-target
                  value={rejectTarget ?? progress.gate.current_step}
                  onChange={(e) => setRejectTarget(e.target.value)}
                  className="rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-xs text-neutral-200"
                >
                  {GATE_STEPS.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}（{s.id}）
                      {s.id === progress.gate.current_step ? " · 当前步" : ""}
                    </option>
                  ))}
                </select>
                {rejectTarget !== null && rejectTarget !== progress.gate.current_step && (
                  <span className="text-[10px] text-amber-300">
                    历史步打回：current_step 拉回该步，其后各步重置为待定（gate.jsonl 流水照常留痕）
                  </span>
                )}
              </div>
            )}
            <textarea
              data-gate-note
              value={noteInput}
              onChange={(e) => setNoteInput(e.target.value)}
              rows={2}
              placeholder={
                action === "reject" ? "打回理由（必填）" : "note（可选）：本次验收结论"
              }
              className="w-full rounded border border-neutral-700 bg-neutral-950 p-2 text-xs text-neutral-200 placeholder:text-neutral-600"
            />
            {action === "reject" && noteInput.trim() === "" && (
              <p className="text-[10px] text-red-400">打回必须填写理由（§5.2：reject 留痕必须可读）</p>
            )}
            <div className="flex gap-2">
              <button
                type="button"
                data-gate-confirm
                disabled={submitting || (action === "reject" && noteInput.trim() === "")}
                onClick={submitAction}
                className={`rounded px-3 py-1 text-xs text-neutral-100 disabled:cursor-not-allowed disabled:opacity-40 ${
                  action === "pass"
                    ? "bg-green-700 hover:bg-green-600"
                    : "bg-red-800 hover:bg-red-700"
                }`}
              >
                {submitting ? "提交中…" : `确认${action === "pass" ? "过关" : "打回"}`}
              </button>
              <button
                type="button"
                data-gate-cancel
                onClick={() => {
                  setAction(null);
                  setActionError(null);
                }}
                className="rounded border border-neutral-700 px-3 py-1 text-xs text-neutral-400 hover:bg-neutral-800"
              >
                取消
              </button>
            </div>
          </div>
        )}

        {/* 迭代确认（§5.1）：回第 ② 步需求重走，需求及其后各步重置为待定 */}
        {iterating && (
          <div className="mt-3 space-y-2 border-t border-neutral-800 pt-3">
            <p className="text-xs text-amber-200">
              迭代回「需求」步（§5.1）：交付后发现问题，回第 ② 步重走——「需求」及其后各步将重置为待定，gate.jsonl 历史行不动。
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                data-gate-iterate-confirm
                disabled={submitting}
                onClick={submitIterate}
                className="rounded bg-amber-700 px-3 py-1 text-xs text-neutral-100 hover:bg-amber-600 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {submitting ? "提交中…" : "确认迭代"}
              </button>
              <button
                type="button"
                onClick={() => setIterating(false)}
                className="rounded border border-neutral-700 px-3 py-1 text-xs text-neutral-400 hover:bg-neutral-800"
              >
                取消
              </button>
            </div>
          </div>
        )}
        {actionError && <p className="mt-2 text-xs text-red-400">{actionError}</p>}

        {/* Q38（2026-09-18 审计）：本次过关/打回触发的对账结果——服务端每次都跑一次并随响应带回
            （"作为过关参考之一"），此前客户端整段丢掉，结果只在架构图页签可见（与 Gate 视图互斥）。
            这里就在**过关现场**给出汇总；完整差异清单仍在架构图的对账面板（同一份 reconcile-last.json）。
            V09-08 ③（附录 E.7 裁定④）：这里也**按分类分计、分别命名**——只有「真差异」才是对账差，
            口径边界（范围外/结构性目录）各用自己的词；口径与三图面板同一份共享判据。 */}
        {gateReconcile && (
          <div
            data-gate-reconcile
            className="mt-3 border-t border-neutral-800 pt-2 text-[11px] text-neutral-400"
          >
            {"error" in gateReconcile ? (
              <p data-gate-reconcile-error={gateReconcile.error} className="text-amber-300">
                本次过关已自动对账，但对账自己失败了（不阻断 Gate，§4.5）：{gateReconcile.error}
              </p>
            ) : (
              <>
                <p>
                  本次过关已自动对账（{gateReconcile.generated_at.slice(0, 19).replace("T", " ")} ·{" "}
                  {gateReconcile.trigger}）：设计书有代码没有{" "}
                  <span className="text-yellow-300">{gateReconcile.only_in_design.length}</span> 项 ·
                  代码有设计书没有{" "}
                  <span className="text-neutral-200">{gateReconcile.only_in_code.length}</span> 项 · 一致{" "}
                  {gateReconcile.matched.length} 项
                  <span className="text-neutral-600">
                    （差异是信号，不是错误 §4.5；完整清单在架构图页签的对账面板）
                  </span>
                </p>
                {/* 分类分计（与三图面板同一份词表、同一份渲染组件；口径句也一起带上） */}
                <ReconcileCats entries={gateOnlyInCode} anchor="data-gate-reconcile-cats" />
                <p className="mt-0.5 text-neutral-600" data-gate-reconcile-via>
                  配对依据：实现落点 {gateMatchedByVia.implementation} 项 · 章节落点未证实{" "}
                  {gateMatchedByVia.locator_unverified} 项（不继承状态色） · 名字信号{" "}
                  {gateMatchedByVia.name_signal} 项（文本匹配，待核实）
                </p>
              </>
            )}
          </div>
        )}
      </section>

      {/* ── 节点详情（§3.4：每个 Gate 留带时间戳的记录，点开看 note）── */}
      {expanded && expandedStep && (
        <section className="rounded border border-neutral-800 bg-neutral-900/60 p-4">
          <h3 className="mb-2 text-sm font-semibold">
            {GATE_STEPS.find((s) => s.id === expandedStep)?.name}（{expandedStep}）·{" "}
            <span className={RESULT_TEXT_COLOR[expanded.result]}>
              {RESULT_LABEL[expanded.result]}
            </span>
          </h3>
          <dl className="space-y-1 text-xs">
            <div className="flex gap-2">
              <dt className="w-16 shrink-0 text-neutral-500">时间戳</dt>
              <dd className="text-neutral-300">{expanded.at ?? "—（尚无记录）"}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-16 shrink-0 text-neutral-500">note</dt>
              <dd className="min-w-0 break-all text-neutral-300">
                {expanded.note ?? "—（尚无记录）"}
              </dd>
            </div>
          </dl>
          {/* gate.jsonl 流水（§2.3.3，只追加的审计证据）：该步全部历史行 */}
          {expandedLines.length > 0 && (
            <div className="mt-3 border-t border-neutral-800 pt-2">
              <p className="mb-1 text-[10px] text-neutral-500">
                gate.jsonl 流水（{expandedLines.length} 条）
              </p>
              <ul className="space-y-1 text-xs">
                {expandedLines.map((l, i) => (
                  <li key={i} className="flex flex-wrap gap-x-2 text-neutral-400">
                    <span className="text-neutral-500">{l.ts}</span>
                    <span className={RESULT_TEXT_COLOR[l.result]}>
                      {RESULT_LABEL[l.result]}
                    </span>
                    <span>by {l.by}</span>
                    {l.note && <span className="break-all text-neutral-300">{l.note}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      <p className="text-xs text-neutral-600">
        数据源：progress.json（§2.3.2）+ gate.jsonl（§2.3.3）。过关 / 打回只能由人点（§5.2，by
        固定 user）；MCP 工具清单（§6.3）没有 gate 写入工具，agent 无法触发转移。
      </p>
    </div>
  );
}
