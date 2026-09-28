// D1 设计书只读视图（DESIGN.md §3.5）：react-markdown + remark-gfm 渲染 design.md 全文
// （标题 / 表格 / 代码块正确渲染；表格走 GFM）。
// 数据源：GET :id/design——塔台（self_managed / id=="tatai"）读 repo 根 DESIGN.md（AGENTS.md §7
// 塔台自身例外），其他项目读 <项目根>/.工作台/design.md（§2.2）；切项目即重取。
// D2 待议区（§3.5 提疑权）：设计书页签内显示待议记录——单条标黄（每条独立黄色卡片，
// §12.1 未决项 #4 结论）+ 头部条数徽标；「追加待议」输入框只发内容本体，日期前缀由服务端补。
// 数据源：GET :id/discuss——塔台 = 抽取 repo 根 DESIGN.md 附录 B 区段（自举例外），
// 其他项目 = <项目根>/.工作台/design.discuss.md。
// ████████████████████████████ 红线 ████████████████████████████
// 设计书【只读】：没有 contenteditable、没有任何「编辑设计书」入口（§3.5：设计书只有两条笔——
// Flash 聊天落稿 / Max 审改）。待议记录【只追加】：本视图没有任何「编辑/删除待议」的接口或
// 按钮——「追加待议」输入框是提疑权入口，不是编辑设计书，也不是编辑已有待议条目。
// ███████████████████████████████████████████████████████████████
import { useEffect, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { DesignDoc, DiscussDoc } from "../../server/workstation";
// 2026-09-20 构建回归修复：GATE_STEPS 的值 import **不许**走 server 模块——
// 那会把 workstation → work/documents → node:child_process 拉进浏览器包（构建红、dev 页面挂不起来）。
// 浏览器安全的常量本体在 src/shared/gateSteps.ts；对 server 模块只保留类型导入（构建时擦除）。
import { GATE_STEPS } from "../../shared/gateSteps";
import type { ReverseDraftDoc } from "../../server/reverseDraft";
import {
  getActiveBaseline,
  getDesign,
  getDiscuss,
  getDiscussions,
  getReverseDraft,
  getReversePlanDraft,
  postDecision,
  postDesignFinalize,
  postDiscuss,
  postReverseDraft,
  type DiscussionEntryView,
  type DiscussionsPayload,
  type ProjectItem,
} from "../api";

/** 待议处置动作的中文名（与服务端 DECISION_ACTION_LABELS 同口径；前端只渲染不推断状态） */
const DECISION_LABEL: Record<string, string> = {
  none: "待处理",
  proposed: "已提出",
  accepted: "已采纳",
  rejected: "已驳回",
  superseded: "已被替代",
};

const DECISION_TONE: Record<string, string> = {
  none: "bg-neutral-800 text-neutral-400",
  proposed: "bg-sky-900/50 text-sky-200",
  accepted: "bg-emerald-900/50 text-emerald-200",
  rejected: "bg-red-900/50 text-red-200",
  superseded: "bg-neutral-700 text-neutral-300",
};

/** 设计书正文与待议条目共用的渲染样式（深色主题；待议条目外层再套黄色卡片） */
const mdComponents: Components = {
  h1: (p) => <h1 className="mt-6 mb-3 text-xl font-bold text-neutral-100" {...p} />,
  h2: (p) => (
    <h2
      className="mt-6 mb-2 border-b border-neutral-800 pb-1 text-lg font-semibold text-neutral-100"
      {...p}
    />
  ),
  h3: (p) => <h3 className="mt-5 mb-2 text-base font-semibold text-neutral-100" {...p} />,
  h4: (p) => <h4 className="mt-4 mb-1 text-sm font-semibold text-neutral-200" {...p} />,
  p: (p) => <p className="my-2" {...p} />,
  ul: (p) => <ul className="my-2 list-disc space-y-1 pl-6" {...p} />,
  ol: (p) => <ol className="my-2 list-decimal space-y-1 pl-6" {...p} />,
  blockquote: (p) => (
    <blockquote
      className="my-2 border-l-2 border-neutral-700 pl-3 text-neutral-400"
      {...p}
    />
  ),
  a: (p) => <a className="text-sky-400 underline" {...p} />,
  table: (p) => (
    <div className="my-3 overflow-x-auto">
      <table className="border-collapse text-xs" {...p} />
    </div>
  ),
  th: (p) => (
    <th
      className="border border-neutral-700 bg-neutral-900 px-2 py-1 text-left font-semibold"
      {...p}
    />
  ),
  td: (p) => <td className="border border-neutral-800 px-2 py-1 align-top" {...p} />,
  pre: (p) => (
    <pre
      className="my-3 overflow-x-auto rounded border border-neutral-800 bg-neutral-900 p-3 text-xs"
      {...p}
    />
  ),
  code: ({ className, children, ...p }) =>
    // react-markdown v10：块级代码一定包在 <pre> 里，行内 code 不带 className
    className ? (
      <code className={`${className} text-neutral-200`} {...p}>
        {children}
      </code>
    ) : (
      <code
        className="rounded bg-neutral-800 px-1 py-0.5 text-xs text-amber-200"
        {...p}
      >
        {children}
      </code>
    ),
  hr: () => <hr className="my-4 border-neutral-800" />,
};

export function DesignView({ project }: { project: ProjectItem }) {
  const [doc, setDoc] = useState<DesignDoc | null>(null);
  const [discuss, setDiscuss] = useState<DiscussDoc | null>(null);
  const [reverseDraft, setReverseDraft] = useState<ReverseDraftDoc | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  // B3 逆向落稿（§9）：起草/定版是人触发的动作，busy 与错误独立一槽
  const [revBusy, setRevBusy] = useState(false);
  const [revError, setRevError] = useState<string | null>(null);
  const [gateStep, setGateStep] = useState<string>(GATE_STEPS[0].id);
  const [finalizeNote, setFinalizeNote] = useState("");
  // V06-07 双文档链：第二份草稿（剩余施工）+ 第二份没生成出来时的如实原因
  const [planDraft, setPlanDraft] = useState<ReverseDraftDoc | null>(null);
  const [planDraftError, setPlanDraftError] = useState<string | null>(null);
  // V06-08 待议处置（§3.5）：条目带 discussion_ref 的派生态 + 处置记录；另取生效基线当"关联修订"的默认值
  const [dispositions, setDispositions] = useState<DiscussionsPayload | null>(null);
  const [baseline, setBaseline] = useState<{ baseline_id: string; design_revision: string; plan_revision: string } | null>(
    null,
  );
  const [decideError, setDecideError] = useState<string | null>(null);
  const [deciding, setDeciding] = useState<string | null>(null);

  // 切项目联动：project.id 一变就重取设计书 + 待议记录 + 逆向草稿（stale 守卫防串数据）；
  // 追加待议/起草/定版成功后 bump reloadTick 走同一条路径刷新（塔台的 DESIGN.md 附录 B 也在正文里，一起重拉）
  useEffect(() => {
    let stale = false;
    setDoc(null);
    setDiscuss(null);
    setReverseDraft(null);
    setPlanDraft(null);
    setDispositions(null);
    setDecideError(null);
    setLoadError(null);
    Promise.all([
      getDesign(project.id),
      getDiscuss(project.id),
      getReverseDraft(project.id),
      getReversePlanDraft(project.id),
      getDiscussions(project.id),
      getActiveBaseline(project.id),
    ])
      .then(([d, dis, rd, pd, disp, base]) => {
        if (!stale) {
          setDoc(d);
          setDiscuss(dis);
          setReverseDraft(rd);
          setPlanDraft(pd);
          setDispositions(disp);
          setBaseline(base.active === null ? null : {
            baseline_id: base.active.baseline_id,
            design_revision: base.active.design_revision.content_sha256,
            plan_revision: base.active.plan_revision.content_sha256,
          });
        }
      })
      .catch((e: Error) => {
        if (!stale) setLoadError(e.message);
      });
    return () => {
      stale = true;
    };
  }, [project.id, reloadTick]);

  // 待议条目 = `- \` 开头的列表行（与后端 countDiscussEntries 同口径）；处置派生态按 discussion_ref 对齐
  const entries: DiscussionEntryView[] =
    dispositions !== null
      ? dispositions.entries
      : discuss?.exists
        ? discuss.content
            .split(/\r?\n/)
            .filter((l) => l.startsWith("- `"))
            .map((text, index) => ({
              index,
              ref: { source: "", index, content_sha256: "" },
              text,
              disposition: {
                status: "none" as const,
                status_label: "待处理",
                decision_id: null,
                decision: null,
                history: [],
              },
            }))
        : [];

  /** 提交一条处置记录（只追加；成功后重取派生态） */
  const submitDecision = async (
    entry: DiscussionEntryView,
    action: "proposed" | "accepted" | "rejected" | "superseded",
    reason: string,
    taskId: string,
    designRevision: string,
  ) => {
    if (deciding !== null) return;
    setDeciding(`${entry.index}:${action}`);
    setDecideError(null);
    try {
      await postDecision(project.id, {
        action,
        discussion_ref: entry.ref,
        reason,
        decided_by: "user",
        related: {
          task_id: taskId.trim() === "" ? null : taskId.trim(),
          design_revision: designRevision.trim() === "" ? null : designRevision.trim(),
          baseline_id: baseline?.baseline_id ?? null,
          plan_revision: baseline?.plan_revision ?? null,
        },
        supersedes: entry.disposition.decision_id,
      });
      setReloadTick((t) => t + 1);
    } catch (e) {
      setDecideError((e as Error).message);
    } finally {
      setDeciding(null);
    }
  };

  const submitAppend = async () => {
    const content = draft.trim();
    if (content === "" || busy) return;
    setBusy(true);
    setPostError(null);
    try {
      await postDiscuss(project.id, content);
      setDraft("");
      setReloadTick((t) => t + 1);
    } catch (e) {
      setPostError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // B3：生成/重生成逆向草稿（§9.2「补全设计书」）：扫描 + 记忆 → Flash 起草四块雏形。
  // 已有 design.md 时后端返回 conflict 不覆盖（DoD⑤），这里把冲突提示原样上屏。
  const [conflictHint, setConflictHint] = useState<string | null>(null);
  const submitReverseDraft = async () => {
    if (revBusy) return;
    setRevBusy(true);
    setRevError(null);
    setConflictHint(null);
    try {
      const result = await postReverseDraft(project.id);
      if (result.conflict) {
        setConflictHint(result.hint);
      } else {
        setGateStep(result.inferred_gate_step);
        // V06-07 双文档链：第二份（剩余施工）草稿没生成出来时如实上屏，不假装两份都成了
        setPlanDraftError(result.plan_draft_error ?? null);
        setReloadTick((t) => t + 1);
      }
    } catch (e) {
      setRevError((e as Error).message);
    } finally {
      setRevBusy(false);
    }
  };

  // B3：定版（§9.3：只能由人/Max 触发——本按钮就是人的确认动作）。
  // gate_step 默认值是草稿的推断初值，人可改选后再点；确认后草稿转正 design.md +
  // Gate 按确认步设置 + 对账钩子落盘（A5 消费）。
  const submitFinalize = async () => {
    if (revBusy) return;
    setRevBusy(true);
    setRevError(null);
    try {
      await postDesignFinalize(project.id, {
        gate_step: gateStep,
        ...(finalizeNote.trim() !== "" ? { note: finalizeNote.trim() } : {}),
      });
      setReloadTick((t) => t + 1);
    } catch (e) {
      setRevError((e as Error).message);
    } finally {
      setRevBusy(false);
    }
  };

  // B3 逆向落稿区：无 design.md 才出现（有设计书的项目起草一律走 conflict，不覆盖）；
  // 草稿存在时显示「草稿待定版」横幅 + 确认 Gate 步下拉 + 定版按钮
  const reverseSection =
    doc && !doc.exists ? (
      <section
        data-reverse-draft
        className="space-y-3 rounded border border-sky-700/50 bg-sky-950/30 p-4"
      >
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold text-sky-300">逆向落稿（补全设计书）</h3>
          <span className="text-xs text-sky-200/50">
            §9.2：扫描 + 历史记忆 → 起草**两份**草稿（设计 + 剩余施工）→ 人/设计角色定版 → 对账自动启动
          </span>
        </div>
        {reverseDraft?.exists ? (
          <>
            <div
              data-reverse-draft-banner
              className="rounded border border-amber-600/40 bg-amber-900/25 px-3 py-2 text-xs text-amber-100"
            >
              草稿待定版：下方是 Flash 起草的雏形（design.draft.md），<strong>不是设计书</strong>。
              确认 Gate 位置（推断初值已预选，§9.3：由人确认）后点「定版」转正。
              逆向**只描述可观测实现**：没有验证证据的既有实现一律标待验证，不自动填绿、本步不动 Gate。
            </div>
            <article
              data-reverse-draft-content
              className="max-h-96 overflow-y-auto rounded border border-neutral-800 bg-neutral-950/60 p-3 text-xs leading-5 text-neutral-300"
            >
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
                {reverseDraft.content}
              </ReactMarkdown>
            </article>
            {/* ── V06-07 双文档链②：剩余施工草稿（plan.draft.md，同样待审定） ── */}
            {planDraft?.exists ? (
              <div data-reverse-plan-draft className="space-y-2">
                <div className="rounded border border-sky-600/40 bg-sky-900/20 px-3 py-2 text-xs text-sky-100">
                  第二份草稿：<strong>剩余施工草稿</strong>（plan.draft.md）——与设计草稿同源（扫描 + 设计雏形），
                  <strong>不是施工图</strong>；无验证证据的既有实现标「待验证」。
                </div>
                <article
                  data-reverse-plan-draft-content
                  className="max-h-80 overflow-y-auto rounded border border-neutral-800 bg-neutral-950/60 p-3 text-xs leading-5 text-neutral-300"
                >
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
                    {planDraft.content}
                  </ReactMarkdown>
                </article>
              </div>
            ) : (
              <p data-reverse-plan-draft-missing className="text-xs text-amber-300">
                第二份草稿（剩余施工）当前没有：{planDraftError ?? "还没起草过"}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <label className="text-xs text-neutral-400" htmlFor="reverse-gate-step">
                确认 Gate 步：
              </label>
              <select
                id="reverse-gate-step"
                data-reverse-gate-select
                value={gateStep}
                onChange={(e) => setGateStep(e.target.value)}
                className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-200 focus:border-sky-500 focus:outline-none"
              >
                {GATE_STEPS.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}（{s.id}）
                  </option>
                ))}
              </select>
              <input
                data-reverse-finalize-note
                value={finalizeNote}
                onChange={(e) => setFinalizeNote(e.target.value)}
                placeholder="定版备注（可选）"
                className="min-w-40 flex-1 rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-200 placeholder:text-neutral-600 focus:border-sky-500 focus:outline-none"
              />
              <button
                type="button"
                data-reverse-finalize
                disabled={revBusy}
                onClick={() => void submitFinalize()}
                className="rounded bg-sky-600 px-3 py-1.5 text-xs font-semibold text-neutral-950 hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-40"
              >
                定版（人确认）
              </button>
              <button
                type="button"
                data-reverse-regenerate
                disabled={revBusy}
                onClick={() => void submitReverseDraft()}
                className="rounded border border-neutral-700 px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-40"
              >
                重新起草
              </button>
            </div>
          </>
        ) : (
          <div className="flex items-center gap-2">
            <button
              type="button"
              data-reverse-generate
              disabled={revBusy}
              onClick={() => void submitReverseDraft()}
              className="rounded bg-sky-600 px-3 py-1.5 text-xs font-semibold text-neutral-950 hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {revBusy ? "起草中（扫描 + 记忆 + Flash）…" : "补全设计书（Flash 起草雏形）"}
            </button>
            <span className="text-xs text-neutral-500">
              不问用户「这项目是干嘛的」——先自己扫（§9.3）
            </span>
          </div>
        )}
        {conflictHint && <p className="text-xs text-amber-300">{conflictHint}</p>}
        {revError && <p className="text-xs text-red-400">{revError}</p>}
      </section>
    ) : null;

  // D2 待议区：单条标黄（每条独立黄色卡片）+ 只追加输入框；无任何编辑/删除入口
  const discussSection = (
    <section
      data-discuss-view
      className="space-y-3 rounded border border-amber-700/50 bg-amber-950/30 p-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-amber-300">待议记录</h3>
        <span
          data-discuss-badge
          className="rounded-full bg-amber-500/25 px-2 py-0.5 text-xs font-semibold text-amber-300"
        >
          {entries.length}
        </span>
        <span className="text-xs text-amber-200/50">
          提疑权（§3.5）：只能追加，不能修改/删除已有条目；改不改由人和 Max 决定
        </span>
      </div>
      {entries.length === 0 ? (
        <p className="text-xs text-neutral-500">暂无待议记录。</p>
      ) : (
        <ul className="space-y-2">
          {entries.map((e) => (
            <DiscussEntryCard
              key={`${e.ref.source}#${e.ref.index}`}
              entry={e}
              implementation={
                dispositions === null
                  ? null
                  : dispositions.implementations[
                      `${e.ref.source}\u001f${e.ref.index}\u001f${e.ref.content_sha256}`
                    ] ?? null
              }
              baselineDesignRevision={baseline?.design_revision ?? ""}
              busy={deciding !== null}
              deciding={deciding}
              onSubmit={submitDecision}
            />
          ))}
        </ul>
      )}
      <form
        className="flex items-start gap-2"
        onSubmit={(ev) => {
          ev.preventDefault();
          void submitAppend();
        }}
      >
        <textarea
          data-discuss-input
          rows={2}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="追加一条待议：问题 … ｜ 依据 … ｜ 建议 …"
          className="flex-1 rounded border border-amber-700/40 bg-neutral-900 px-2 py-1 text-xs text-neutral-200 placeholder:text-neutral-600 focus:border-amber-500 focus:outline-none"
        />
        <button
          type="submit"
          data-discuss-submit
          disabled={busy || draft.trim() === ""}
          className="rounded bg-amber-600 px-3 py-1.5 text-xs font-semibold text-neutral-950 hover:bg-amber-500 disabled:cursor-not-allowed disabled:opacity-40"
        >
          追加待议
        </button>
      </form>
      {postError && <p className="text-xs text-red-400">追加失败：{postError}</p>}
      {decideError && (
        <p data-discuss-decide-error className="text-xs text-red-400">
          处置记录没写进去：{decideError}
        </p>
      )}
    </section>
  );

  if (loadError) {
    return (
      <div className="mx-auto w-full max-w-3xl p-8">
        <p className="text-sm text-red-400">设计书加载失败：{loadError}</p>
      </div>
    );
  }
  if (!doc || !discuss) {
    return (
      <div className="mx-auto w-full max-w-3xl p-8">
        <p className="text-sm text-neutral-500">加载设计书…</p>
      </div>
    );
  }
  if (!doc.exists) {
    return (
      <div className="mx-auto w-full max-w-3xl space-y-4 p-8">
        <div className="space-y-2">
          <h2 className="text-lg font-semibold">{project.name} · 设计书</h2>
          <p className="text-sm text-neutral-500">
            该项目还没有设计书。设计书只有两条笔（§3.5）：Flash 聊天里点「落稿」，或 Max 审改。
            老项目也可以走逆向落稿（§9）：先让 Flash 起草雏形，人确认定版。
          </p>
        </div>
        {reverseSection}
        {discussSection}
      </div>
    );
  }

  // 塔台自身（自举例外，口径与后端 read_design 相同：self_managed 或 id=="tatai"）：
  // 待议记录本体就是 DESIGN.md 附录 B，顶部待议区已经在显示——正文渲染到附录 B 之前截断，
  // 留一行指引（2026-09-19 主人拍板：底部藏掉只留顶部，同一内容不显示两遍）。
  // 只裁展示：GET /design、MCP read_design、聊天背景注入等数据接口仍返回全文。
  const isSelf = project.self_managed === true || project.id === "tatai";
  const appendixIdx = isSelf ? doc.content.indexOf("\n## 附录 B") : -1;
  const bodyContent =
    appendixIdx > 0
      ? `${doc.content.slice(0, appendixIdx)}\n\n> （本页自「附录 B：待议记录」起截断——同一内容已在上方待议区显示，2026-09-19 主人拍板；完整原文见仓库根 DESIGN.md。）\n`
      : doc.content;

  return (
    <div className="mx-auto w-full max-w-4xl space-y-4 self-start p-8" data-design-view>
      <header className="space-y-1">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold">{project.name} · 设计书</h2>
          <span
            data-discuss-badge-header
            className="rounded-full bg-amber-500/25 px-2 py-0.5 text-xs font-semibold text-amber-300"
          >
            待议 {entries.length}
          </span>
        </div>
        <p className="text-xs text-neutral-500">
          只读（§3.5：只有 Flash 落稿 / Max 审改两条笔）· 事实源：
          <span className="break-all text-neutral-400">{doc.source}</span>
        </p>
      </header>
      {discussSection}
      <article className="text-sm leading-6 text-neutral-200">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
          {bodyContent}
        </ReactMarkdown>
      </article>
    </div>
  );
}

/**
 * 一条待议 + 它的处置区（§3.5）。
 *
 * 只做三件事：① 渲染**原文**（逐字节来自待议源，一个字符都不改）；② 显示由 decisions.jsonl
 * 派生的处置状态；③ 提供提出/采纳/驳回/被替代四个**只追加**动作（带理由与关联修订/任务）。
 * 「采纳 ≠ 已实现」在这里落地：采纳后显示关联任务的真实执行状态与用户验收，没验收就明说还没实现。
 */
function DiscussEntryCard({
  entry,
  implementation,
  baselineDesignRevision,
  busy,
  deciding,
  onSubmit,
}: {
  entry: DiscussionEntryView;
  implementation:
    | { task_id: string; execution_label: string | null; acceptance: string; implemented: boolean; note: string }
    | null;
  baselineDesignRevision: string;
  busy: boolean;
  deciding: string | null;
  onSubmit: (
    entry: DiscussionEntryView,
    action: "proposed" | "accepted" | "rejected" | "superseded",
    reason: string,
    taskId: string,
    designRevision: string,
  ) => void;
}) {
  const [reason, setReason] = useState("");
  const [taskId, setTaskId] = useState(implementation?.task_id ?? "");
  const [designRevision, setDesignRevision] = useState(baselineDesignRevision);
  const status = entry.disposition.status;
  const canSubmit = reason.trim() !== "" && !busy;

  return (
    <li
      data-discuss-entry
      data-discuss-index={entry.index}
      data-discuss-state={status}
      className="rounded border border-amber-600/40 bg-amber-900/25 px-3 py-2 text-xs leading-5 text-amber-100"
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
        {entry.text.replace(/^- /, "")}
      </ReactMarkdown>

      {/* 定位引用（discussion_ref 三件套：原源 / 条目序号 / 原内容哈希） */}
      <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-amber-200/60">
        <span data-discuss-state-label className={`rounded px-1.5 py-0.5 ${DECISION_TONE[status] ?? ""}`}>
          {entry.disposition.status_label || DECISION_LABEL[status] || status}
        </span>
        <span data-discuss-ref title={entry.ref.content_sha256}>
          定位：#{entry.ref.index} · {entry.ref.content_sha256.slice(0, 12)}…
        </span>
        {entry.disposition.decision !== null && (
          <span data-discuss-last-decision>
            处理者 {entry.disposition.decision.decided_by} · {entry.disposition.decision.at} · 理由：
            {entry.disposition.decision.reason}
          </span>
        )}
      </div>

      {/* 采纳 ≠ 已实现（§3.5）：关联任务的真实状态与用户验收，没验收就明说 */}
      {implementation !== null && (status === "accepted" || status === "superseded") && (
        <p
          data-discuss-implementation
          data-discuss-implemented={implementation.implemented ? "1" : "0"}
          className={`mt-1 rounded px-2 py-1 text-[11px] ${
            implementation.implemented ? "bg-emerald-900/40 text-emerald-200" : "bg-neutral-900/70 text-amber-200"
          }`}
        >
          {implementation.implemented ? "关联任务已有人工验收" : "采纳不等于已实现"}：{implementation.task_id} ·{" "}
          {implementation.execution_label ?? "无运行状态"} · 用户验收 {implementation.acceptance}
          <span className="block text-amber-200/70">{implementation.note}</span>
        </p>
      )}

      {/* 处置动作（带理由与关联修订/任务；只追加，不改上面那段原文） */}
      <div className="mt-2 space-y-1 rounded bg-neutral-950/40 p-2">
        <div className="flex flex-wrap items-center gap-2">
          <input
            data-discuss-reason={entry.index}
            value={reason}
            onChange={(ev) => setReason(ev.target.value)}
            placeholder="处置理由（必填）"
            className="min-w-40 flex-1 rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-[11px] text-neutral-200 placeholder:text-neutral-600"
          />
          <input
            data-discuss-related-task={entry.index}
            value={taskId}
            onChange={(ev) => setTaskId(ev.target.value)}
            placeholder="关联任务卡号（采纳/替代要填）"
            className="w-44 rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-[11px] text-neutral-200 placeholder:text-neutral-600"
          />
          <input
            data-discuss-related-revision={entry.index}
            value={designRevision}
            onChange={(ev) => setDesignRevision(ev.target.value)}
            placeholder="关联设计修订（可留空）"
            className="w-56 rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-[11px] text-neutral-200 placeholder:text-neutral-600"
          />
        </div>
        <div className="flex flex-wrap gap-1">
          {(
            [
              ["proposed", "提出", "bg-sky-700 hover:bg-sky-600"],
              ["accepted", "采纳", "bg-emerald-700 hover:bg-emerald-600"],
              ["rejected", "驳回", "bg-red-700 hover:bg-red-600"],
              ["superseded", "被替代", "bg-neutral-700 hover:bg-neutral-600"],
            ] as const
          ).map(([action, label, tone]) => (
            <button
              key={action}
              data-discuss-action={action}
              data-discuss-action-index={entry.index}
              disabled={!canSubmit}
              onClick={() => onSubmit(entry, action, reason.trim(), taskId, designRevision)}
              className={`rounded px-2 py-0.5 text-[11px] font-semibold text-neutral-950 disabled:opacity-40 ${tone}`}
            >
              {label}
            </button>
          ))}
          {deciding === `${entry.index}:accepted` && (
            <span data-discuss-deciding className="text-[11px] text-neutral-400">
              写入中…
            </span>
          )}
        </div>
      </div>
    </li>
  );
}
