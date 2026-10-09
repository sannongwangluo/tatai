// D1 设计书只读视图（DESIGN.md §3.5）：react-markdown + remark-gfm 渲染 design.md 全文
// （标题 / 表格 / 代码块正确渲染；表格走 GFM）。
// 数据源：GET :id/design——塔台（self_managed / id=="tatai"）读 repo 根 DESIGN.md（AGENTS.md §7
// 塔台自身例外），其他项目读 <项目根>/.工作台/design.md（§2.2）；切项目即重取。
// D2 待议区（§3.5 提疑权）：设计书页签内显示待议记录——单条标黄（每条独立黄色卡片，
// §12.1 未决项 #4 结论）+ 头部条数徽标；「追加待议」输入框只发内容本体，日期前缀由服务端补。
// 数据源：GET :id/discuss——塔台 = 抽取 repo 根 DESIGN.md 附录 B 区段（自举例外），
// 其他项目 = <项目根>/.工作台/design.discuss.md。
// ████████████████████████████ 红线 ████████████████████████████
// 设计书【只读】：没有 contenteditable、没有任何「编辑设计书」入口（§3.5：设计稿由人或获授权的
// 设计角色落稿/审改，不绑定固定模型）。待议记录【只追加】：本视图没有任何「编辑/删除待议」的接口或
// 按钮——「追加待议」输入框是提疑权入口，不是编辑设计书，也不是编辑已有待议条目。
// ███████████████████████████████████████████████████████████████
import { createElement, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { DiscussDoc } from "../../server/workstation";
// 2026-09-20 构建回归修复：GATE_STEPS 的值 import **不许**走 server 模块——
// 那会把 workstation → work/documents → node:child_process 拉进浏览器包（构建红、dev 页面挂不起来）。
// 浏览器安全的常量本体在 src/shared/gateSteps.ts；对 server 模块只保留类型导入（构建时擦除）。
import { GATE_STEPS } from "../../shared/gateSteps";
import type { ReverseDraftDoc } from "../../server/reverseDraft";
import {
  getActiveBaseline,
  getDesignVersioned,
  getDiscuss,
  getDiscussions,
  getFeatureLedger,
  getReverseDraft,
  getReversePlanDraft,
  postDecision,
  postDesignFinalize,
  postDiscuss,
  postReverseDraft,
  type DesignBaselineHistoryView,
  type DesignReadDoc,
  type DiscussionEntryView,
  type DiscussionsPayload,
  type ProjectItem,
} from "../api";
import type { CoverageDesignSectionRef, FeatureItem, FeatureLedger } from "../../shared/coverageTypes";
import {
  FeatureLedgerView,
  FeatureOverview,
  type FeatureLedgerBundle,
  type FeatureLedgerErrorView,
} from "./FeatureLedgerView";
// V09-28：正向成套图纸入口——基线摘要/保存/激活的 API（本卡新增，走既有 documents 路由的同一份判据）
import {
  getDocumentsSummary,
  postActivateBaseline,
  postPreserveDocument,
  type DocumentsSummary,
} from "../forwardApi";
// V09-28：正向工作面共用的自动重取令牌（契约 F2；本页把 token 加进加载 effect 依赖即自动刷新）
import { useBoundedReloader, useProjectRefresh } from "../useProjectRefresh";

/** 待议处置动作的中文名（与服务端 DECISION_ACTION_LABELS 同口径；前端只渲染不推断状态） */
const DECISION_LABEL: Record<string, string> = {
  none: "待处理",
  proposed: "已提出",
  accepted: "已采纳",
  rejected: "已驳回",
  superseded: "已被替代",
};

/** 实际读到的版本档位 → 人话（`data-design-current-mode` 仍带原始档位，供回归与核对用） */
const VERSION_MODE_LABEL: Record<string, string> = {
  current: "当前草稿",
  active: "已审定基线",
  revision: "历史已替代版本",
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

// ── B6/V09-56：设计正文标题的稳定 id 与反向定位（§3.5）──
// 行号取 **Markdown AST 的 `node.position.start.line`**（就是这一行在源文本里的行号），不按标题文字
// 去章节表里猜（Codex 复审 8）：重复标题（两个 `### 3.5 …`）、标题里带强调（`## **x**`）、
// 同名前缀（`## A` 与 `## A / B`）都会各拿各的真实行号，不再串到首个匹配或找不到。
const HEADING_LEVELS = ["h1", "h2", "h3", "h4", "h5", "h6"] as const;
const HEADING_CLASS: Record<(typeof HEADING_LEVELS)[number], string> = {
  h1: "mt-6 mb-3 text-xl font-bold text-neutral-100",
  h2: "mt-6 mb-2 border-b border-neutral-800 pb-1 text-lg font-semibold text-neutral-100",
  h3: "mt-5 mb-2 text-base font-semibold text-neutral-100",
  h4: "mt-4 mb-1 text-sm font-semibold text-neutral-200",
  h5: "mt-3 mb-1 text-xs font-semibold text-neutral-200",
  h6: "mt-3 mb-1 text-xs font-semibold text-neutral-300",
};

interface MarkdownNodeProps {
  children?: ReactNode;
  /** remark/rehype 带下来的 AST 节点（`position.start.line` = 该标题在源文本里的行号） */
  node?: { position?: { start?: { line?: number } } };
  [k: string]: unknown;
}

function headingLineOf(props: MarkdownNodeProps): number | null {
  const line = props.node?.position?.start?.line;
  return typeof line === "number" && Number.isInteger(line) && line > 0 ? line : null;
}

/** 设计正文专用渲染组件：h1–h6 加稳定 id + 反向定位点击（其余样式与 `mdComponents` 一致）。 */
function makeBodyComponents(onHeading: (line: number) => void, activeLine: number | null): Components {
  const make = (Tag: (typeof HEADING_LEVELS)[number]): Components["h1"] => {
    const Comp = (props: MarkdownNodeProps) => {
      const { children, node, ...rest } = props;
      void node; // 只用来取行号，绝不透传给 DOM
      const line = headingLineOf(props);
      const anchor: Record<string, unknown> =
        line === null
          ? {}
          : {
              id: `design-h-${line}`,
              "data-design-heading": String(line),
              "data-design-heading-level": Tag,
              "data-design-heading-active": activeLine === line ? "1" : "0",
              title: "点这里看这一段承载哪些功能/任务（反向定位）",
              onClick: () => onHeading(line),
            };
      return createElement(Tag, { ...rest, ...anchor, className: HEADING_CLASS[Tag] }, children);
    };
    return Comp as unknown as Components["h1"];
  };
  const out: Record<string, unknown> = { ...mdComponents };
  for (const Tag of HEADING_LEVELS) out[Tag] = make(Tag);
  return out as Components;
}

/**
 * 分页续读的合并：把后一页并进同一份清单（按 `item_id` 去重）。
 * 读口给的是同一 `package_revision` 的下一个 offset 页；版本变了会 409，走不到这里。
 */
function mergeLedgerPages(prev: FeatureLedger, next: FeatureLedger): FeatureLedger {
  const seen = new Set(prev.items.map((i) => i.item_id));
  const merged: FeatureItem[] = [...prev.items, ...next.items.filter((i) => !seen.has(i.item_id))];
  return { ...next, items: merged };
}

/** 设计版本三档（当前草稿／已审定基线／历史已替代；§3.5、§2.9） */
interface VersionOption {
  value: string;
  tier: "current" | "active" | "history";
  label: string;
  note: string;
  disabled: boolean;
}
function versionOptionsOf(doc: DesignReadDoc | null): VersionOption[] {
  const out: VersionOption[] = [
    { value: "current", tier: "current", label: "当前草稿", note: "现行编辑源（未获批准时，覆盖结论不超过「待审」）", disabled: false },
  ];
  const history = doc?.baseline_history ?? [];
  const active = history.find((h) => h.current) ?? null;
  out.push({
    value: "active",
    tier: "active",
    label: "已审定基线",
    note:
      active === null
        ? "还没有生效基线（读不回已批准快照）"
        : `审定者 ${active.approved_by} · ${active.approval_kind === "user_confirmed" ? "用户确认" : "技术审定"} · ${active.active_at}`,
    disabled: active === null,
  });
  for (const h of [...history].filter((x) => !x.current).reverse()) {
    out.push({
      value: h.design_revision.content_sha256,
      tier: "history",
      label: `历史已替代（${h.baseline_id}）`,
      note:
        `当时审定者 ${h.approved_by} · ${h.approval_kind === "user_confirmed" ? "用户确认" : "技术审定"} · ${h.active_at} · ` +
        `快照${h.available ? "可取回" : "读不回（历史状态未知，不套当前结论）"}`,
      disabled: false,
    });
  }
  return out;
}

// ── V09-28：设计页输入的**按项目**现场（§3.14「刷新不丢草稿与动作回执」）──
// 为什么单开一层而不直接 useState：本页接入自动重取（token 前进会触发重取）后，输入必须**按项目**
// 保留、且在后台重取时**不被清掉**。这里按项目 id 分桶，镜像到 sessionStorage（刷新不丢草稿）；
// 切项目各读各的，绝不把 A 项目正在写的待议/处置/审定说明带进 B 项目。
interface DispositionInput {
  reason: string;
  taskId: string;
  designRevision: string;
}
interface InputBucket {
  discuss: string;
  finalizeNote: string;
  approver: string;
  basis: string;
  dispositions: Record<string, DispositionInput>;
  /** B6：设计页所选版本（「当前草稿／已审定基线／历史已替代」）——按项目各存各的 */
  designSelector: string;
  /** B6：反向定位选中的章节标题行（null = 没选） */
  activeSectionLine: number | null;
  /** B6：「我补充一个需求」的未提交草稿——按项目保存，刷新不丢 */
  ledgerSupplement: string;
}
const INPUT_BUCKETS = new Map<string, InputBucket>();
const INPUT_MIRROR_PREFIX = "tatai.design.inputs.";

function emptyBucket(): InputBucket {
  return {
    discuss: "",
    finalizeNote: "",
    approver: "",
    basis: "",
    dispositions: {},
    designSelector: "current",
    activeSectionLine: null,
    ledgerSupplement: "",
  };
}

function bucketOf(projectId: string): InputBucket {
  const hit = INPUT_BUCKETS.get(projectId);
  if (hit !== undefined) return hit;
  let loaded = emptyBucket();
  try {
    const raw = sessionStorage.getItem(`${INPUT_MIRROR_PREFIX}${projectId}`);
    if (raw !== null) loaded = { ...emptyBucket(), ...(JSON.parse(raw) as Partial<InputBucket>) };
  } catch {
    // 存不下就退回纯内存（§3.1：不为存现场把界面搞崩）
  }
  INPUT_BUCKETS.set(projectId, loaded);
  return loaded;
}

function saveBucket(projectId: string, bucket: InputBucket): void {
  INPUT_BUCKETS.set(projectId, bucket);
  try {
    sessionStorage.setItem(`${INPUT_MIRROR_PREFIX}${projectId}`, JSON.stringify(bucket));
  } catch {
    // 同上：尽力而为，绝不让界面因存储异常崩掉
  }
}

function useInputBucket(projectId: string): [InputBucket, (patch: Partial<InputBucket>) => void] {
  const [bucket, setBucket] = useState<InputBucket>(() => bucketOf(projectId));
  useEffect(() => {
    setBucket(bucketOf(projectId));
  }, [projectId]);
  const update = useCallback(
    (patch: Partial<InputBucket>) => {
      setBucket((prev) => {
        const next = { ...prev, ...patch };
        saveBucket(projectId, next);
        return next;
      });
    },
    [projectId],
  );
  return [bucket, update];
}

export function DesignView({ project }: { project: ProjectItem }) {
  // B6/V09-56：`designView` = **所选版本**的设计文档（三档：current/active/<revision>）；
  // 旧 `getDesign` 只读现行草稿、不够用——改为带 `document` query 的同一只读接口（旧 shape 保留）。
  const [designView, setDesignView] = useState<DesignReadDoc | null>(null);
  // B6：功能清单（只读派生读口）+ 它自己的加载/失败现场（失败不能假空成功）
  const [ledger, setLedger] = useState<FeatureLedger | null>(null);
  const [ledgerError, setLedgerError] = useState<FeatureLedgerErrorView | null>(null);
  const [ledgerLoading, setLedgerLoading] = useState(false);
  // B6：**真实分页续读**（cursor + expected_revision）现场：忙/失败/版本已变三槽分开，
  // 失败保留已载内容（不假空成功），版本已变则作废旧页并重读第一页（Codex 复审 1）。
  const [ledgerPagingBusy, setLedgerPagingBusy] = useState(false);
  const [ledgerPagingError, setLedgerPagingError] = useState<string | null>(null);
  const [ledgerPagingNotice, setLedgerPagingNotice] = useState<string | null>(null);
  // B6：「我补充一个需求」——复用只追加的待议写口
  const [supplBusy, setSupplBusy] = useState(false);
  const [supplError, setSupplError] = useState<string | null>(null);
  const [supplNote, setSupplNote] = useState<string | null>(null);
  const [discuss, setDiscuss] = useState<DiscussDoc | null>(null);
  const [reverseDraft, setReverseDraft] = useState<ReverseDraftDoc | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  // B3 逆向落稿（§9）：起草/定版是人触发的动作，busy 与错误独立一槽
  const [revBusy, setRevBusy] = useState(false);
  const [revError, setRevError] = useState<string | null>(null);
  const [gateStep, setGateStep] = useState<string>(GATE_STEPS[0].id);
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

  // V09-28：自动重取令牌（契约 F2）+ 失败保留最后成功数据（§3.14）
  const refreshToken = useProjectRefresh(project.id);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [lastSuccessAt, setLastSuccessAt] = useState<string | null>(null);
  // V09-28：现有成套图纸的审定激活区状态（摘要、保存、激活各自一槽，互不遮蔽）
  const [documents, setDocuments] = useState<DocumentsSummary | null>(null);
  const [documentsError, setDocumentsError] = useState<string | null>(null);
  const [baselineBusy, setBaselineBusy] = useState<null | "preserve-design" | "preserve-plan" | "activate">(null);
  const [baselineError, setBaselineError] = useState<string | null>(null);
  const [baselineNotice, setBaselineNotice] = useState<string | null>(null);
  const [approvalKind, setApprovalKind] = useState<"delegated_technical_review" | "user_confirmed">(
    "delegated_technical_review",
  );
  // V09-28：待议/定版/处置/审定输入按项目分桶——后台自动重取**不触碰**，切项目各读各的
  const [inputs, patchInputs] = useInputBucket(project.id);
  const draft = inputs.discuss;
  const finalizeNote = inputs.finalizeNote;
  const approver = inputs.approver;
  const basis = inputs.basis;
  const setDraft = (v: string): void => patchInputs({ discuss: v });
  const setFinalizeNote = (v: string): void => patchInputs({ finalizeNote: v });
  const setApprover = (v: string): void => patchInputs({ approver: v });
  const setBasis = (v: string): void => patchInputs({ basis: v });
  // B6：设计版本选择与反向定位选中章节——随输入桶**按项目**保存（切项目各读各的、刷新不丢）
  const designSelector: string = inputs.designSelector === "" ? "current" : inputs.designSelector;
  const setDesignSelector = (v: string): void => {
    patchInputs({ designSelector: v });
    // 换版本 = 换这一版的新读数：上一条分页提示/失败不再适用于新版本
    setLedgerPagingNotice(null);
    setLedgerPagingError(null);
  };
  const activeSectionLine: number | null = inputs.activeSectionLine;
  const setActiveSection = (line: number | null): void => patchInputs({ activeSectionLine: line });

  // ── 切项目联动（§3.14「切项目不串数据」）：换项目时旧项目的读数与失败标记**在渲染期**先归零 ──
  // 不放在下面的 load effect 里做：effect 在提交之后才跑，换项目那一次提交会先把
  // 「B 的项目名 + A 的正文 / A 的失败横幅 / A 的『最近成功』时间」画进 DOM（真浏览器 MutationObserver
  // 能采到的至少一帧）。§3.14 要的是「一帧都不带过去」，所以用 React 官方的「prop 变化时在渲染期调整
  // state」写法：立即重渲染，这一帧根本不提交。同一项目内的后台重取不经过这里，仍保留最后成功数据。
  const [stateProjectId, setStateProjectId] = useState(project.id);
  // 「当前项目是否已成功取到数据」的标记：**只在成功后**置成 project.id，换项目归零时清空。
  // 首屏判定（见 load）用它、而不是在 load 开头就置位——否则 dev StrictMode 双挂载把第一遍 abort 掉后，
  // 第二遍会误判成"已有数据"，把**无数据**的首屏失败错记成 refreshError；而 refreshError 只在有正文的
  // 分支渲染，页面就永久停在「加载设计书…」：既不显原因、也没重试入口（无数据必须显式失败）。
  const loadedProjectRef = useRef<string | null>(null);
  // 正向基线动作（保存/激活）的**代际**：换项目或发起新动作都 +1；晚到的旧代回执/错误/finally 一律
  // 丢弃，绝不把 A 的成功/失败提示或忙状态写到 B（A→B→A 的旧 A 回包也按代际丢弃，见下面两个 submit）。
  const baselineGenRef = useRef(0);
  // B6：分页续读的**代际**与「当前项目+版本」键。切项目、换版本、重读第一页都会让在途的
  // 旧页回包作废（不把 A 的第二页写进 B 的清单，也不把旧版本的页并进新版本）。
  const ledgerPagingGenRef = useRef(0);
  const ledgerKeyRef = useRef(`${project.id}\u001f${designSelector}`);
  ledgerKeyRef.current = `${project.id}\u001f${designSelector}`;
  // 当前显示的清单（供后台对账判断「是不是同一版本、要不要保住已载入的后页」）
  const ledgerRef = useRef<FeatureLedger | null>(ledger);
  ledgerRef.current = ledger;
  // 读到过 REVISION_CHANGED：下一轮必须**回到第一页重来**（旧页明确作废），不再沿用已载入的后页
  const ledgerForceResetRef = useRef(false);
  // B6：「我补充一个需求」的**代际**：只有发起提交的那个项目/那一代才能清草稿与回执（Codex 复审 2）。
  const supplementGenRef = useRef(0);
  if (stateProjectId !== project.id) {
    setStateProjectId(project.id);
    setDesignView(null);
    setLedger(null);
    setLedgerError(null);
    setLedgerPagingBusy(false);
    setLedgerPagingError(null);
    setLedgerPagingNotice(null);
    setSupplBusy(false);
    setSupplError(null);
    setSupplNote(null);
    setDiscuss(null);
    setReverseDraft(null);
    setPlanDraft(null);
    setDispositions(null);
    setDecideError(null);
    setDocuments(null);
    setDocumentsError(null);
    setLoadError(null);
    setRefreshError(null);
    setLastSuccessAt(null);
    // 正向基线动作的现场也随项目归零：忙/回执/错误绝不跨项目（§3.14）。
    setBaselineBusy(null);
    setBaselineError(null);
    setBaselineNotice(null);
    // 数据与动作现场都作废 → 首屏判定与动作代际同时重置；旧代回包随后一律丢弃。
    loadedProjectRef.current = null;
    baselineGenRef.current += 1;
    // B6：分页续读与补充提交的在途回包同样作废（切项目后迟到成功/失败都不许落进新项目）。
    ledgerPagingGenRef.current += 1;
    supplementGenRef.current += 1;
  }

  // V09-26：改用**严格有界在途**外壳——同一项目不 abort 在途请求（慢响应最终落地显示），换项目/卸载
  // abort 旧请求并丢弃旧回包（A→B→A 也不会把旧 A 写进新 A）。此前每 5 秒的 stale 闭包会把 >5s 的
  // 慢响应永远作废、并让请求并发堆积。
  const load = useCallback((signal: AbortSignal): Promise<void> => {
    // 换项目后的第一次加载＝该项目的**首屏**：失败要上错误页；已有数据后的对账失败只标陈旧、留旧数据。
    // 归零已在上面的 stateProjectId 块（渲染期）做完，这里只决定"这次失败记到哪个槽"。
    const firstScreen = loadedProjectRef.current !== project.id;
    return Promise.all([
      getDesignVersioned(project.id, designSelector, { signal }),
      getDiscuss(project.id, { signal }),
      getReverseDraft(project.id, { signal }),
      getReversePlanDraft(project.id, { signal }),
      getDiscussions(project.id, { signal }),
      getActiveBaseline(project.id, { signal }),
    ])
      .then(([dv, dis, rd, pd, disp, base]) => {
        if (signal.aborted) return;
        // 成功才登记「本项目已有数据」：此后同项目的对账失败按「陈旧横幅」处理，不再上错误页。
        loadedProjectRef.current = project.id;
        setDesignView(dv);
        setDiscuss(dis);
        setReverseDraft(rd);
        setPlanDraft(pd);
        setDispositions(disp);
        setBaseline(base.active === null ? null : {
          baseline_id: base.active.baseline_id,
          design_revision: base.active.design_revision.content_sha256,
          plan_revision: base.active.plan_revision.content_sha256,
        });
        // V09-26：失败标记**只在成功后清除**（否则每轮对账开头先清、失败再置回，横幅会闪）
        setRefreshError(null);
        // 首屏失败同样要在成功后清：loadError 只在换项目时清过一次，若不在这里清，
        // 一次首屏断线（/design 首次 503）会把此后所有成功的自动重取永久挡在错误页后面
        // ——F2「首屏断线→恢复必须自动显示，不需手刷」在此失效。恢复即清，不需要人点重试。
        setLoadError(null);
        setLastSuccessAt(new Date().toISOString());
      })
      .catch((e: Error) => {
        if (signal.aborted) return;
        // 首屏失败上错误页；已有数据时的刷新失败只标陈旧，保留最后成功数据
        if (firstScreen) setLoadError(e.message);
        else setRefreshError(e.message);
      });
  }, [project.id, designSelector]);
  // key 含 selector：**切版本 = 换 key** ⇒ 有界在途外壳 abort 旧版本在途请求并丢弃旧回包
  // （「异步旧响应不串」）；换项目同理（A→B→A 也不会把旧 A 写进新 A）。
  const reload = useBoundedReloader(`${project.id}\u001f${designSelector}`, load);
  useEffect(() => {
    reload();
  }, [project.id, designSelector, reloadTick, refreshToken, reload]);

  // V09-28：成套图纸摘要单独取——它失败只影响审定区，不拖垮设计书正文/待议的刷新。
  // 换项目归零（documents/documentsError）统一在渲染期的 stateProjectId 块里做，这里不再各清一遍。
  const loadDocs = useCallback((signal: AbortSignal): Promise<void> => {
    return getDocumentsSummary(project.id, { signal })
      .then((d) => {
        if (signal.aborted) return;
        setDocuments(d);
        setDocumentsError(null); // 只在成功后清失败标记（同正文：失败保留原因，不每轮开头先清）
      })
      .catch((e: Error) => {
        if (signal.aborted) return;
        setDocumentsError(e.message);
      });
  }, [project.id]);
  const reloadDocs = useBoundedReloader(project.id, loadDocs);
  useEffect(() => {
    reloadDocs();
  }, [project.id, reloadTick, refreshToken, reloadDocs]);

  // ── B6/V09-56：功能清单只读读口单独取（与正文**同一 selector**、同一刷新节拍）──
  // 失败分「未接入（旧服务）」与「读取失败」两种：都显式上屏，绝不假空成功、不回退写路径。
  const loadLedger = useCallback((signal: AbortSignal): Promise<void> => {
    setLedgerLoading(true);
    return getFeatureLedger(project.id, { document: designSelector }, { signal })
      .then((l) => {
        if (signal.aborted) return;
        ledgerPagingGenRef.current += 1;
        const prev = ledgerRef.current;
        // 第一页落地 = 这一版的新读数：在途下一页一律作废。
        // 但**同一版本**的后台对账（每 5s 一轮）不得把人已经翻出来的后页悄悄丢回第一页
        // （「不隐漏后页」）：包版本一致 ⇒ 已载入的后页仍然有效，保住它们、只刷新结论元数据。
        // 包版本真的变了 ⇒ 回到第一页，并明说旧页作废（不是静默换数据）。
        const forceReset = ledgerForceResetRef.current;
        ledgerForceResetRef.current = false;
        if (!forceReset && prev !== null && prev.items.length > l.items.length) {
          const samePackage =
            prev.package_revision === l.package_revision &&
            prev.document_selection.requested === l.document_selection.requested;
          if (samePackage) {
            setLedger({
              ...prev,
              state: l.state,
              coverage: l.coverage,
              source_revision: l.source_revision,
              package_revision_basis: l.package_revision_basis,
              document_selection: l.document_selection,
              artifact_ref: l.artifact_ref,
              artifact_selection: l.artifact_selection,
              generated_at: l.generated_at,
            });
          } else {
            setLedger(l);
            if (prev.document_selection.requested === l.document_selection.requested) {
              setLedgerPagingNotice("清单内容已更新：已回到第一页（之前载入的后页作废，需要重新读取）。");
            }
          }
        } else {
          setLedger(l);
        }
        setLedgerError(null);
        setLedgerPagingBusy(false);
      })
      .catch((e: unknown) => {
        if (signal.aborted) return;
        const err = e as { message?: string; status?: number | null; code?: string; unsupported?: boolean };
        setLedgerError({
          unsupported: err.unsupported === true,
          message: err.message ?? String(e),
          status: typeof err.status === "number" ? err.status : null,
          code: typeof err.code === "string" ? err.code : "",
        });
      })
      .finally(() => {
        if (!signal.aborted) setLedgerLoading(false);
      });
  }, [project.id, designSelector]);
  const reloadLedger = useBoundedReloader(`${project.id}\u001f${designSelector}\u001fledger`, loadLedger);
  useEffect(() => {
    reloadLedger();
  }, [project.id, designSelector, reloadTick, refreshToken, reloadLedger]);

  // ── B6：**真实续读下一页**（Codex 复审 1）──
  // 用读口给的 `paging.cursor`（绑定 package_revision）+ **第一页的 package_revision** 当
  // `expected_revision`：期间清单版本变了，读口回 409 → 旧页作废、重读第一页，绝不把两版拼一起。
  // 失败保留已载内容并给原因；切项目/换版本时在途旧页按代际丢弃。
  const loadMoreLedger = useCallback((): void => {
    const cur = ledger;
    if (cur === null || cur.paging.complete || ledgerPagingBusy) return;
    const cursor = cur.paging.cursor;
    if (cursor === null) return;
    const key = `${project.id}\u001f${designSelector}`;
    const gen = ++ledgerPagingGenRef.current;
    setLedgerPagingBusy(true);
    setLedgerPagingError(null);
    setLedgerPagingNotice(null);
    getFeatureLedger(project.id, {
      document: designSelector,
      cursor,
      expected_revision: cur.package_revision,
    })
      .then((next) => {
        if (gen !== ledgerPagingGenRef.current || ledgerKeyRef.current !== key) return;
        setLedger((prev) => (prev === null ? next : mergeLedgerPages(prev, next)));
      })
      .catch((e: unknown) => {
        if (gen !== ledgerPagingGenRef.current || ledgerKeyRef.current !== key) return;
        const err = e as { message?: string; status?: number | null; code?: string };
        if (err.code === "REVISION_CHANGED") {
          // 版本已变：旧页不能并进新清单 —— 明确作废，重读第一页（如实告知，不静默拼接）
          ledgerForceResetRef.current = true;
          setLedgerPagingNotice("这份清单的版本已经变了：上一页作废，正在重新读第一页。");
          setReloadTick((t) => t + 1);
          return;
        }
        setLedgerPagingError(err.message ?? String(e));
      })
      .finally(() => {
        if (gen === ledgerPagingGenRef.current) setLedgerPagingBusy(false);
      });
  }, [ledger, ledgerPagingBusy, project.id, designSelector]);

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

  // B6/V09-56：点清单里的设计章节引用 → 精确定位正文（id 由标题行号给出）。
  // 定位不到（ref.status !== "located"，或该行标题不在当前所读版本里）**不猜近似标题**——清单已显式报 unresolved。
  const locateSection = (ref: CoverageDesignSectionRef): void => {
    setActiveSection(ref.line);
    const el = document.getElementById(`design-h-${ref.line}`);
    if (el !== null && typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "start", behavior: "smooth" });
  };

  // B6/V09-56：「我补充一个需求」——复用既有**只追加**写口 POST /discuss（不新建「改功能状态」写 API）。
  // 提交后**不自动采纳**、不改已审定设计；只是把它送进待议，由人或获授权设计角色后续处置。
  //
  // 草稿语义（Codex 复审 2）：**只有提交成功**才清掉**所属项目**的那份草稿；失败原样保留可重试；
  // 而且只清「刚提交的那一段」——发送期间继续编辑的新文案不能跟着被清掉。切项目后迟到的成功/失败
  // 不写当前界面、也不清新项目的草稿（A→B→A 的旧 A 回包按代际丢弃）。
  const submitSupplement = (text: string): void => {
    const content = text.trim();
    if (content === "" || supplBusy) return;
    const ownerProject = project.id;
    const gen = ++supplementGenRef.current;
    setSupplBusy(true);
    setSupplError(null);
    setSupplNote(null);
    postDiscuss(ownerProject, content)
      .then(() => {
        if (gen !== supplementGenRef.current) return; // 迟到旧代：不写当前项目、不动当前草稿
        setSupplNote("已进入待议（只追加）：它不会自动被采纳，也不会改已审定的设计；请在上方「待议记录」查看它的处置去向。");
        // 只清**仍是刚提交那段**的草稿：期间新写的内容保留（用户不会丢字）
        if (bucketOf(ownerProject).ledgerSupplement.trim() === content) {
          patchInputs({ ledgerSupplement: "" });
        }
        setReloadTick((t) => t + 1);
      })
      .catch((e: Error) => {
        if (gen !== supplementGenRef.current) return;
        setSupplError(e.message);
      })
      .finally(() => {
        if (gen === supplementGenRef.current) setSupplBusy(false);
      });
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

  // B3：定版（§9.3：由人或获授权的设计角色触发——本按钮就是人的确认动作）。
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
    designView !== null && !designView.exists ? (
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
          提疑权（§3.5）：只能追加，不能修改/删除已有条目；改不改由人/获授权的设计角色决定
        </span>
      </div>
      {entries.length === 0 ? (
        <p className="text-xs text-neutral-500">暂无待议记录。</p>
      ) : (
        <ul className="space-y-2">
          {entries.map((e) => {
            const impl =
              dispositions === null
                ? null
                : dispositions.implementations[
                    `${e.ref.source}\u001f${e.ref.index}\u001f${e.ref.content_sha256}`
                  ] ?? null;
            const dkey = `${e.ref.source}\u001f${e.ref.index}`;
            // V09-28：处置输入按项目分桶（切项目各读各的、后台重取不清）
            const draftInput: DispositionInput =
              inputs.dispositions[dkey] ?? {
                reason: "",
                taskId: impl?.task_id ?? "",
                designRevision: baseline?.design_revision ?? "",
              };
            return (
              <DiscussEntryCard
                key={`${project.id}:${e.ref.source}#${e.ref.index}`}
                entry={e}
                implementation={impl}
                draft={draftInput}
                onDraftChange={(patch) =>
                  patchInputs({ dispositions: { ...inputs.dispositions, [dkey]: { ...draftInput, ...patch } } })
                }
                busy={deciding !== null}
                deciding={deciding}
                onSubmit={submitDecision}
              />
            );
          })}
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

  // ── V09-28：现有成套图纸的审定激活区（§2.9）──
  // 展示两源当前版本与生效基线；用户不必理解哈希内部细节（短标 + title 全文）。
  const shortSha = (h?: string | null): string => (h === undefined || h === null ? "—" : `${h.slice(0, 12)}…`);
  const baselineMatchesCurrent =
    documents !== null &&
    documents.baseline.active !== null &&
    documents.design.exists &&
    documents.plan.exists &&
    documents.baseline.active.design_revision.content_sha256 === documents.design.content_sha256 &&
    documents.baseline.active.plan_revision.content_sha256 === documents.plan.content_sha256;

  const submitPreserve = async (kind: "design" | "plan"): Promise<void> => {
    if (baselineBusy !== null) return;
    // 代际：本次动作独占一代；换项目（渲染期归零块）或发起新动作都会 +1，之后本代回包一律丢弃。
    const gen = ++baselineGenRef.current;
    setBaselineBusy(kind === "design" ? "preserve-design" : "preserve-plan");
    setBaselineError(null);
    setBaselineNotice(null);
    try {
      const r = await postPreserveDocument(project.id, kind);
      if (gen !== baselineGenRef.current) return; // 晚到旧代成功回执：不写到当前（很可能已是别的）项目
      setBaselineNotice(`${kind === "design" ? "设计书" : "施工图"}已保存为不可变历史（${r.recovery.ref}）。`);
      setReloadTick((t) => t + 1);
    } catch (e) {
      if (gen !== baselineGenRef.current) return; // 晚到旧代错误：同样不写到当前项目
      setBaselineError((e as Error).message);
    } finally {
      // 旧代不得清掉新代（或新项目）的忙状态；换项目时忙状态已由渲染期归零块清掉。
      if (gen === baselineGenRef.current) setBaselineBusy(null);
    }
  };

  const submitActivate = async (): Promise<void> => {
    if (baselineBusy !== null) return;
    const kind = approvalKind;
    const approvedBy = kind === "user_confirmed" ? "user" : approver.trim();
    const basisText = basis.trim();
    if (approvedBy === "") {
      setBaselineError("请填写审定者（谁审定的要如实写）。");
      return;
    }
    if (basisText === "") {
      setBaselineError("请填写审定依据：没有依据的基线不可激活（§2.9）。");
      return;
    }
    const designSha = documents?.design.content_sha256 ?? "";
    const planSha = documents?.plan.content_sha256 ?? "";
    if (documents === null || !documents.design.exists || !documents.plan.exists || designSha === "" || planSha === "") {
      setBaselineError("设计书与施工图要同时在、且都能取到当前版本（半套图纸不能激活）。");
      return;
    }
    // 代际：本次动作独占一代；换项目（渲染期归零块）或发起新动作都会 +1，之后本代回包一律丢弃。
    const gen = ++baselineGenRef.current;
    setBaselineBusy("activate");
    setBaselineError(null);
    setBaselineNotice(null);
    try {
      const r = await postActivateBaseline(project.id, {
        approved_by: approvedBy,
        approval_basis: basisText,
        approval_kind: kind,
        expected: { design_content_sha256: designSha, plan_content_sha256: planSha },
      });
      if (gen !== baselineGenRef.current) return; // 晚到旧代成功回执：不写到当前（很可能已是别的）项目
      setBaselineNotice(
        r.created
          ? `已激活配套基线 ${r.baseline.baseline_id}（${kind === "user_confirmed" ? "用户确认" : "技术审定"}；只写基线，不写用户 Gate）。`
          : `该配套版本已经生效（${r.baseline.baseline_id}），未重复新增。`,
      );
      setReloadTick((t) => t + 1);
    } catch (e) {
      if (gen !== baselineGenRef.current) return; // 晚到旧代错误：同样不写到当前项目
      setBaselineError((e as Error).message);
    } finally {
      // 旧代不得清掉新代（或新项目）的忙状态；换项目时忙状态已由渲染期归零块清掉。
      if (gen === baselineGenRef.current) setBaselineBusy(null);
    }
  };

  const baselineSection = (
    <section
      data-baseline-panel
      className="space-y-3 rounded border border-emerald-700/50 bg-emerald-950/20 p-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-emerald-300">现有成套图纸 · 审定与激活</h3>
        <span className="text-xs text-emerald-200/50">
          §2.9：已有 DESIGN/PLAN 直接审定激活——不调用模型、不要求产生差异、不经过逆向落稿
        </span>
      </div>
      {documents === null ? (
        <p data-baseline-loading className="text-xs text-neutral-500">
          {documentsError === null ? "正在读取两份图纸…" : `读取两份图纸失败：${documentsError}`}
        </p>
      ) : (
        <>
          <div className="grid gap-2 sm:grid-cols-2">
            {([
              ["设计书", documents.design, "design"],
              ["施工图", documents.plan, "plan"],
            ] as const).map(([label, d, kind]) => (
              <div key={kind} data-baseline-source={kind} className="rounded border border-neutral-800 bg-neutral-950/50 p-2 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-neutral-200">{label}</span>
                  <span
                    data-baseline-source-exists={kind}
                    data-exists={d.exists ? "1" : "0"}
                    className={d.exists ? "text-emerald-300" : "text-amber-300"}
                  >
                    {d.exists ? "已就位" : "缺失"}
                  </span>
                </div>
                <div className="mt-1 text-neutral-400">
                  源：<span className="break-all text-neutral-300">{d.source_path ?? "—"}</span>
                </div>
                <div className="text-neutral-400">
                  版本：<span data-baseline-source-version={kind} title={d.content_sha256 ?? ""}>{shortSha(d.content_sha256)}</span>
                </div>
                <button
                  type="button"
                  data-baseline-preserve={kind}
                  disabled={!d.exists || baselineBusy !== null}
                  onClick={() => void submitPreserve(kind)}
                  className="mt-1 rounded border border-neutral-700 px-2 py-0.5 text-[11px] text-neutral-300 hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  保存当前修订为不可变历史
                </button>
              </div>
            ))}
          </div>
          <div
            data-baseline-active={documents.baseline.active === null ? "none" : "present"}
            className="rounded border border-neutral-800 bg-neutral-950/50 p-2 text-xs text-neutral-300"
          >
            {documents.baseline.active === null ? (
              "当前还没有生效基线。"
            ) : (
              <>
                生效基线{" "}
                <span data-baseline-active-id className="font-mono">
                  {documents.baseline.active.baseline_id}
                </span>
                （审定者 {documents.baseline.active.approved_by} ·{" "}
                {documents.baseline.active.approval_kind === "user_confirmed" ? "用户确认" : "技术审定"} ·{" "}
                {documents.baseline.active.active_at}）
                {documents.design.exists && documents.plan.exists && !baselineMatchesCurrent ? (
                  <span data-baseline-drift className="text-amber-300"> · 源已在激活后变化，需重新审定激活</span>
                ) : null}
              </>
            )}
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="space-y-1 text-xs text-neutral-400">
              审定种类
              <select
                data-baseline-kind
                value={approvalKind}
                onChange={(e) => setApprovalKind(e.target.value as "delegated_technical_review" | "user_confirmed")}
                className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-200 focus:border-emerald-500 focus:outline-none"
              >
                <option value="delegated_technical_review">技术审定（用户已委派的设计角色）</option>
                <option value="user_confirmed">用户确认（我本人）</option>
              </select>
            </label>
            <label className="space-y-1 text-xs text-neutral-400">
              审定者
              <input
                data-baseline-approver
                value={approvalKind === "user_confirmed" ? "user" : approver}
                disabled={approvalKind === "user_confirmed"}
                onChange={(e) => setApprover(e.target.value)}
                placeholder="如 codex / gpt-6"
                className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-200 placeholder:text-neutral-600 focus:border-emerald-500 focus:outline-none disabled:opacity-60"
              />
            </label>
          </div>
          <label className="block space-y-1 text-xs text-neutral-400">
            审定依据（必填）
            <textarea
              data-baseline-basis
              rows={2}
              value={basis}
              onChange={(e) => setBasis(e.target.value)}
              placeholder="技术审定请引用可取回的委派/审定依据（用户原话、委派记录或审定记录）"
              className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-200 placeholder:text-neutral-600 focus:border-emerald-500 focus:outline-none"
            />
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              data-baseline-activate
              disabled={baselineBusy !== null || !(documents.design.exists && documents.plan.exists)}
              onClick={() => void submitActivate()}
              className="rounded bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-neutral-950 hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {baselineBusy === "activate" ? "激活中…" : "审定并激活基线"}
            </button>
            <span className="text-xs text-neutral-500">只写配套基线：不写用户 Gate、不自动领取任务</span>
          </div>
          {baselineNotice && (
            <p data-baseline-notice className="text-xs text-emerald-300">
              {baselineNotice}
            </p>
          )}
          {baselineError && (
            <p data-baseline-error className="text-xs text-red-400">
              {baselineError}
            </p>
          )}
        </>
      )}
    </section>
  );

  // ── B6/V09-56：版本三档切换器 + 功能概览 + 功能清单（正文与清单共用同一 selector） ──
  const designVersions = versionOptionsOf(designView);
  const versionSwitcher = (
    <section data-design-version-switch className="space-y-2 rounded border border-neutral-800 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-neutral-200">看哪一版（只读）</h3>
        <span className="text-xs text-neutral-500">
          当前草稿／已审定基线／历史已替代：历史版只读，读不回来就说读不回来。
        </span>
      </div>
      <div className="flex flex-col gap-1">
        {designVersions.map((o) => (
          <label
            key={o.value}
            data-version-option={o.tier}
            data-version-value={o.value}
            className={`flex items-start gap-2 rounded px-2 py-1 text-xs ${
              designSelector === o.value ? "bg-neutral-800 text-neutral-100" : "text-neutral-400"
            }`}
          >
            <input
              type="radio"
              name={`design-version-${project.id}`}
              value={o.value}
              checked={designSelector === o.value}
              disabled={o.disabled}
              onChange={() => setDesignSelector(o.value)}
            />
            <span className="min-w-0">
              <span className="font-semibold">{o.label}</span>
              {o.disabled ? <span className="ml-2 text-neutral-500">（不可用）</span> : null}
              <span className="ml-2 text-neutral-500">{o.note}</span>
            </span>
          </label>
        ))}
      </div>
      {designView?.selection.unreadable !== null && designView?.selection.unreadable !== undefined && (
        <p data-design-version-unreadable className="text-xs text-amber-300">
          该版本读不回：{designView.selection.unreadable}
        </p>
      )}
      {designView?.selection.drift !== null && designView?.selection.drift !== undefined && (
        <p data-design-version-drift className="text-xs text-amber-300">
          {designView.selection.drift}
        </p>
      )}
    </section>
  );
  const bodyComponents = makeBodyComponents(setActiveSection, activeSectionLine);
  // 概览与清单读**同一份**读口状态（不各算一遍；Codex 复审 4/6/7）
  const ledgerBundle: FeatureLedgerBundle = {
    selector: designSelector,
    ledger,
    error: ledgerError,
    loading: ledgerLoading,
    onRetry: () => {
      setLedgerPagingError(null);
      setLedgerPagingNotice(null);
      setReloadTick((t) => t + 1);
    },
    onLoadMore: loadMoreLedger,
    loadMoreBusy: ledgerPagingBusy,
    loadMoreError: ledgerPagingError,
    pagingNotice: ledgerPagingNotice,
    onLocateSection: locateSection,
    activeSectionLine,
    onSupplement: submitSupplement,
    supplementBusy: supplBusy,
    supplementError: supplError,
    supplementNote: supplNote,
    supplementDraft: inputs.ledgerSupplement,
    onSupplementDraftChange: (v) => patchInputs({ ledgerSupplement: v }),
    bodyDesignRevision: designView?.selection.design_revision ?? null,
  };
  const overviewPanel = <FeatureOverview {...ledgerBundle} />;
  const ledgerPanel = <FeatureLedgerView {...ledgerBundle} />;
  // ── 技术材料 / 既有能力：首屏不占位（概览与正文/清单优先），需要时展开 ──
  // 默认 `open`：不藏内容、不改变既有入口的可达性（老回归照旧可点）；人可一键收起。
  const technicalSections = (
    <>
      <details data-design-technical="baseline" open className="tt-design-details">
        <summary data-design-technical-summary="baseline">
          现有成套图纸 · 审定与激活（
          {documents === null
            ? "读取中"
            : documents.baseline.active === null
              ? "还没有生效基线"
              : "已有生效基线"}
          ）
        </summary>
        {baselineSection}
      </details>
      <details data-design-technical="discuss" open className="tt-design-details">
        <summary data-design-technical-summary="discuss">待议记录（{entries.length}）</summary>
        {discussSection}
      </details>
      {reverseSection}
    </>
  );

  if (loadError) {
    return (
      <div className="mx-auto w-full max-w-3xl p-8">
        <p className="text-sm text-red-400">设计书加载失败：{loadError}</p>
        <button
          type="button"
          data-design-retry
          onClick={() => setReloadTick((t) => t + 1)}
          className="mt-2 rounded border border-neutral-700 px-3 py-1 text-xs text-neutral-300 hover:bg-neutral-800"
        >
          重试
        </button>
      </div>
    );
  }
  if (designView === null || !discuss) {
    return (
      <div className="mx-auto w-full max-w-3xl p-8">
        <p className="text-sm text-neutral-500">加载设计书…</p>
      </div>
    );
  }
  if (!designView.exists) {
    return (
      <div className="mx-auto w-full max-w-3xl space-y-4 p-8" data-design-view data-design-missing="1">
        <div className="space-y-2">
          <h2 className="text-lg font-semibold">{project.name} · 设计书</h2>
          <p className="text-sm text-neutral-500">
            {designSelector === "current"
              ? "这个项目还没有设计书。设计稿由会话里人或获授权的设计角色落稿/审改；老项目也可以先让 Agent 起草雏形，人确认后定版。"
              : "所选版本读不回来：如实标未知，不套用当前通过结论。"}
          </p>
        </div>
        {overviewPanel}
        {versionSwitcher}
        {technicalSections}
        {ledgerPanel}
      </div>
    );
  }

  // 塔台自身（自举例外，口径与后端 read_design 相同：self_managed 或 id=="tatai"）：
  // 待议记录本体就是 DESIGN.md 附录 B，顶部待议区已经在显示——正文渲染到附录 B 之前截断，
  // 留一行指引（2026-09-19 主人拍板：底部藏掉只留顶部，同一内容不显示两遍）。
  // 只裁展示：GET /design、MCP read_design、聊天背景注入等数据接口仍返回全文。
  const isSelf = project.self_managed === true || project.id === "tatai";
  const designContent = designView.content ?? "";
  const appendixIdx = isSelf ? designContent.indexOf("\n## 附录 B") : -1;
  const bodyContent =
    appendixIdx > 0
      ? `${designContent.slice(0, appendixIdx)}\n\n> （本页自「附录 B：待议记录」起截断——同一内容已在上方待议区显示，2026-09-19 主人拍板；完整原文见仓库根 DESIGN.md。）\n`
      : designContent;

  return (
    <div className="mx-auto w-full max-w-6xl space-y-4 self-start p-8" data-design-view>
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
          只读副本：设计稿由人或获授权的设计角色落稿/审改 ·
          现在读的是
          <span
            data-design-current-mode={designView.selection.mode}
            className="text-neutral-400"
          >
            {VERSION_MODE_LABEL[designView.selection.mode] ?? designView.selection.mode}
          </span>
          <details className="tt-inline-details">
            <summary>技术信息</summary>
            <span data-design-source className="break-all text-neutral-400">
              来源文件：{designView.source_rel ?? designView.source ?? "—"}
            </span>
          </details>
        </p>
        {refreshError && (
          <p data-design-refresh-error className="text-xs text-amber-300">
            自动刷新失败，显示的是上次成功数据{lastSuccessAt === null ? "" : `（最近成功 ${lastSuccessAt}）`}：{refreshError}
            <button
              type="button"
              data-design-refresh-retry
              onClick={() => setReloadTick((t) => t + 1)}
              className="ml-2 underline"
            >
              重试
            </button>
          </p>
        )}
      </header>
      {/* ① 首屏先说结果：有哪些功能、验证到哪一步、缺什么、下一步归谁 */}
      {overviewPanel}
      {/* ② 版本选择 + 正文与清单并排 */}
      {versionSwitcher}
      <div className="tt-design-columns">
        <article data-design-body className="text-sm leading-6 text-neutral-200">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={bodyComponents}>
            {bodyContent}
          </ReactMarkdown>
        </article>
        {ledgerPanel}
      </div>
      {/* ③ 技术材料与既有能力：保留全部入口，放主区之后，可一键收起 */}
      {technicalSections}
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
  draft,
  onDraftChange,
  busy,
  deciding,
  onSubmit,
}: {
  entry: DiscussionEntryView;
  implementation:
    | { task_id: string; execution_label: string | null; acceptance: string; implemented: boolean; note: string }
    | null;
  /** V09-28：处置输入由父组件按项目分桶持有（后台重取/切项目不丢），本卡受控渲染 */
  draft: DispositionInput;
  onDraftChange: (patch: Partial<DispositionInput>) => void;
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
  const { reason, taskId, designRevision } = draft;
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
            onChange={(ev) => onDraftChange({ reason: ev.target.value })}
            placeholder="处置理由（必填）"
            className="min-w-40 flex-1 rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-[11px] text-neutral-200 placeholder:text-neutral-600"
          />
          <input
            data-discuss-related-task={entry.index}
            value={taskId}
            onChange={(ev) => onDraftChange({ taskId: ev.target.value })}
            placeholder="关联任务卡号（采纳/替代要填）"
            className="w-44 rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-[11px] text-neutral-200 placeholder:text-neutral-600"
          />
          <input
            data-discuss-related-revision={entry.index}
            value={designRevision}
            onChange={(ev) => onDraftChange({ designRevision: ev.target.value })}
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
