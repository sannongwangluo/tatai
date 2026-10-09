// V09-62「交付总览」（DESIGN.md §3.16／§3.17；PLAN V09-62）：人的**默认项目入口**。
//
// 这一页只回答一件事：**现在能不能开始人工试用、还差什么**。它复用 `feature_ledger` 的同一份事实
// 快照与只读 `delivery` 摘要（§6.12），**不自己算就绪**——结论直接取服务端 `delivery.state`，界面
// 既不涂色也不提供改状态入口；缺字段/读失败/局部范围一律**不冒充**当前可试用。
//
// 关键分寸（DESIGN §3.16）：
//   · 绿色只在服务端明确 `ready_for_trial` 时出现；刷新失败**保留上次成功内容但撤下**该结论，
//     **全页默认可见文字不得再出现可试用承诺**（旧 summary / 绿读数要么标「上次结果」，要么收进折叠）；
//   · 技术 ID / 证据 ref / 审查者与时间 / 检查编号与哈希默认折叠，展开可核对来源；
//   · 首屏用人话（「Agent审查」），不夹带「只读派生」等实现话术；功能行不带 cap-ID；
//   · 阻断项多时按人话类别合并首屏，完整技术明细折叠**一条不丢**；
//   · 已登记待映射需求与未登记候选**另列**，不混进正式功能分母；
//   · 人的接受单列，Agent 不代签；
//   · 切项目与请求竞争隔离：旧项目的回包不写进新项目的界面（同 `useProjectRefresh` 口径）。
//
// 布局（2026-10-09 用户已批准的有界返工）：正式功能由长文字列表改为**方块网格 + 右侧详情栏**。
// 方块只放忠于原意的短名、一句用途与**分开的**实现/技术验证/Agent审查读数；点方块在右侧看原名、
// 用途、需求/设计覆盖、实现依据、验证/审查记录、缺口、版本与人的接受（技术 ID/哈希/流水号仍折叠）。
// 方块数量来自**实时完整清单**（不硬编码 18），未知不假绿，`role=button` 的整块可键盘选取。
//
// 2026-10-09 有界收敛（Codex 界面复审裁定 + 用户「已实现和通过的要标出来」）：
//   · 首屏再收短——只留一句总体结论 + **一行**紧凑计数（含人的接受计数）。结论原文、完整读数与版本依据、
//     交付核对、人的接受说明都**默认折叠**，但**仍排在卡片之前**（折叠行本身就在首屏，只占一行；不是
//     移到卡片后面）；「还差什么」的逐条明细折叠排在**卡片之后**。卡片网格仍是主工作面；
//   · 卡片用**审定短名 + 一句用途**（精确原文别名表在同目录 `deliveryOverviewDisplay.ts`），
//     表里没有的原文**原样完整显示**，右栏始终保留**原名与原场景**——只动呈现，不动 ID/计数/通过状态；
//   · 读数落字按同源判据分开写：提交且技术验证**当前有效**才叫「已实现」，只是提交过叫「已提交实现」，
//     图上无运行投影叫「暂无实现记录」，证据失效 / 有明确失败检查显式「需要复验」/「有问题」，
//     后端没给审查读数就是「未知」；刷新失败（旧读数）逐张标「（上次）」并撤下绿态；
//   · 关掉详情后网格占满可用宽度；窄屏详情叠到**网格上方**，且**只在用户主动到达**（选卡 / 重开详情 /
//     切到窄屏）时滚进可视区——同项目成功刷新不得抢走用户已经下滑的滚动位置；关闭后焦点回到触发方块（Esc 亦可）。
//
// 类型：`delivery` / `agent_review` / `delivery.integration` 归**共享类型层**
// （`src/shared/coverageTypes.ts`，无 fs 依赖），这里 `import type` 消费，**不再抄一份**；运行时只做
// **必要边界形态检查**——结论齐全**且每项自身形态完整**才算一次可用读数：`scope` 合法、`counts` 的
// 计数齐、`gates` 恰是三类核对（缺行/重复/空集不算）、`version`/`user_acceptance` 字段齐，任一不齐
// 一律降为未知，绝不假 ready（`state: ready` 但 `counts={}` 这类「容器在、内容空」的读数尤其要挡住，
// 否则界面会一边显示「正式功能 0 项」一边照抄绿结论）；旧服务缺字段 ⇒ 明确未知，绝不假绿。
import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import type {
  AgentReview as AgentReviewReadout,
  AgentReviewEvidence,
  DeliveryBlocker as DeliveryBlockerReadout,
  DeliveryGate as DeliveryGateReadout,
  DeliveryIntegrationReadout,
  DeliveryOverview as DeliveryOverviewData,
  FeatureItem,
  FeatureLedger,
} from "../../shared/coverageTypes";
import { getFeatureLedger, type ProjectItem } from "../api";
import { useBoundedReloader, useProjectRefresh } from "../useProjectRefresh";
import type { ViewKey } from "../projectScope";
import {
  acceptanceChip,
  displayCopyOf,
  implementationChip,
  reviewChip,
  verificationChip,
  verificationIsCurrent,
  type ChipDisplay,
} from "./deliveryOverviewDisplay";
import "./DeliveryOverview.css";

// ── 运行时形态归一（只读消费；畸形/部分字段降级成安全值，缺核心结构 = null ⇒ 界面显式未知） ──

function asObject(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function asStringArray(v: unknown): string[] {
  return asArray(v).filter((x): x is string => typeof x === "string");
}
function asNum(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
function isGateState(v: unknown): v is "passed" | "pending" | "unknown" {
  return v === "passed" || v === "pending" || v === "unknown";
}
function isDeliveryState(v: unknown): v is DeliveryOverviewData["state"] {
  return v === "ready_for_trial" || v === "not_ready" || v === "unknown";
}
function isScope(v: unknown): v is DeliveryOverviewData["scope"] {
  return v === "project" || v === "partial" || v === "historical";
}
function isNum(v: unknown): boolean {
  return typeof v === "number" && Number.isFinite(v);
}
function isStrOrNull(v: unknown): boolean {
  return v === null || typeof v === "string";
}

function normEvidence(v: unknown): AgentReviewEvidence[] {
  return asArray(v).flatMap((e) => {
    const o = asObject(e);
    if (o === null || typeof o.check_id !== "string") return [];
    return [
      {
        check_id: o.check_id,
        reviewer: typeof o.reviewer === "string" ? o.reviewer : "",
        at: typeof o.at === "string" ? o.at : "",
        evidence_ref: typeof o.evidence_ref === "string" ? o.evidence_ref : "",
        record_ref: typeof o.record_ref === "string" ? o.record_ref : null,
        notes: asStringArray(o.notes),
      },
    ];
  });
}

/** 结论之外**必要**的两个字段名清单：缺失/不完整即不算一次可用读数（见 `hasDeliveryCore`）。 */
const COUNT_KEYS = [
  "features",
  "design_checked",
  "verified",
  "reviewed",
  "requirements",
  "mapped_requirements",
  "pending_requirements",
  "candidates",
] as const;
const ACCEPTANCE_KEYS = ["pending", "accepted", "rejected", "accepted_known_limit"] as const;
/** 交付核对声明是 PLAN 里固定的三类（§3.16）：缺行/重复/空集都不算一次可用读数。 */
const GATE_IDS = ["coverage", "review", "runtime"] as const;

function hasCountsShape(o: Record<string, unknown> | null): boolean {
  return o !== null && COUNT_KEYS.every((k) => isNum(o[k]));
}
function hasAcceptanceShape(o: Record<string, unknown> | null): boolean {
  return o !== null && ACCEPTANCE_KEYS.every((k) => isNum(o[k]));
}
function hasVersionShape(o: Record<string, unknown> | null): boolean {
  return (
    o !== null &&
    isStrOrNull(o.design_revision) &&
    isStrOrNull(o.plan_revision) &&
    isStrOrNull(o.baseline_id) &&
    isNum(o.ledger_last_seq) &&
    isStrOrNull(o.drift)
  );
}
function isGateShape(v: unknown): boolean {
  const o = asObject(v);
  return (
    o !== null &&
    typeof o.id === "string" &&
    typeof o.label === "string" &&
    isGateState(o.state) &&
    Array.isArray(o.check_ids) &&
    Array.isArray(o.missing) &&
    Array.isArray(o.evidence)
  );
}
/** 三类核对必须各出现且仅出现一次（缺行/重复/空集都不算完整形态）。 */
function hasGatesShape(v: unknown): boolean {
  if (!Array.isArray(v) || v.length !== GATE_IDS.length || !v.every(isGateShape)) return false;
  return GATE_IDS.every((id) => v.filter((g) => (g as { id?: unknown }).id === id).length === 1);
}

/**
 * 必要边界形态检查：一次「可用」读数至少要齐 summary/scope/counts/gates/version/user_acceptance，
 * 且每一项**自身形态完整**（不是只看外层 `typeof === object`）。
 *
 * 为什么要看内层：`state` 只写 ready、而 `counts={}`/`gates=[]`/`version={}` 这类「容器在、内容空」
 * 的读数，会让界面在「正式功能 0 项、验证 0、审查 0」的同时照抄服务端的 ready 绿结论——那是把
 * 「必要字段缺失」冒充成可试用（§3.16「无数据/读失败/旧服务不支持…均不冒充当前可试用」）。所以这里
 * 只做**形态完整性**判据（缺字段/坏形态 ⇒ 未知），**不改交付判据**：结论仍只取 canonical 的 `state`。
 */
function hasDeliveryCore(raw: Record<string, unknown>): boolean {
  return (
    typeof raw.summary === "string" &&
    isScope(raw.scope) &&
    hasCountsShape(asObject(raw.counts)) &&
    hasGatesShape(raw.gates) &&
    hasVersionShape(asObject(raw.version)) &&
    hasAcceptanceShape(asObject(raw.user_acceptance))
  );
}

function readIntegration(v: unknown): DeliveryIntegrationReadout | undefined {
  if (v === undefined || v === null) return undefined;
  const o = asObject(v);
  if (o === null) {
    return { state: "unknown", check_ids: [], missing: ["组合流程验证读数形态不完整，无法确认"], evidence: [] };
  }
  return {
    state: isGateState(o.state) ? o.state : "unknown",
    check_ids: asStringArray(o.check_ids),
    missing: asStringArray(o.missing),
    evidence: normEvidence(o.evidence),
  };
}

/**
 * 读服务端的交付结论；缺字段/形态不足 = null（⇒ 界面显式未知，不假绿）。
 * 这里只做**形态归一与必要的完整性检查**，**不改判据**：结论仍只取 `state`。
 */
export function readDelivery(ledger: FeatureLedger): DeliveryOverviewData | null {
  const raw = asObject((ledger as { delivery?: unknown }).delivery);
  if (raw === null) return null;
  if (!isDeliveryState(raw.state)) return null;
  if (!hasDeliveryCore(raw)) return null;
  const state = raw.state;
  const counts = asObject(raw.counts) ?? {};
  const version = asObject(raw.version) ?? {};
  const acc = asObject(raw.user_acceptance) ?? {};
  const out: DeliveryOverviewData = {
    state,
    summary: raw.summary as string,
    // 到这里 scope 已被 `hasDeliveryCore` 校验为合法枚举，直接采用（不再把非法/缺失静默放大成 project）
    scope: raw.scope as DeliveryOverviewData["scope"],
    counts: {
      features: asNum(counts.features),
      design_checked: asNum(counts.design_checked),
      verified: asNum(counts.verified),
      reviewed: asNum(counts.reviewed),
      requirements: asNum(counts.requirements),
      mapped_requirements: asNum(counts.mapped_requirements),
      pending_requirements: asNum(counts.pending_requirements),
      // 新增两个分母字段：**旧宿主缺字段 ⇒ 不写**（界面显式"未知"，绝不拿 0 冒充"没有候选"）
      ...(isNum(counts.formal_requirements) ? { formal_requirements: asNum(counts.formal_requirements) } : {}),
      ...(isNum(counts.registered_candidates) ? { registered_candidates: asNum(counts.registered_candidates) } : {}),
      candidates: asNum(counts.candidates),
    },
    gates: asArray(raw.gates).flatMap((g): DeliveryGateReadout[] => {
      const o = asObject(g);
      if (o === null || typeof o.id !== "string") return [];
      return [
        {
          id: o.id as DeliveryGateReadout["id"],
          label: typeof o.label === "string" ? o.label : "",
          state: isGateState(o.state) ? o.state : "unknown",
          check_ids: asStringArray(o.check_ids),
          missing: asStringArray(o.missing),
          evidence: normEvidence(o.evidence),
        },
      ];
    }),
    blockers: asArray(raw.blockers).flatMap((b): DeliveryBlockerReadout[] => {
      const o = asObject(b);
      if (o === null || typeof o.message !== "string") return [];
      return [
        {
          kind: typeof o.kind === "string" ? o.kind : "unknown",
          item_id: typeof o.item_id === "string" ? o.item_id : null,
          message: o.message,
        },
      ];
    }),
    version: {
      design_revision: typeof version.design_revision === "string" ? version.design_revision : null,
      plan_revision: typeof version.plan_revision === "string" ? version.plan_revision : null,
      baseline_id: typeof version.baseline_id === "string" ? version.baseline_id : null,
      ledger_last_seq: asNum(version.ledger_last_seq),
      drift: typeof version.drift === "string" ? version.drift : null,
    },
    user_acceptance: {
      pending: asNum(acc.pending),
      accepted: asNum(acc.accepted),
      rejected: asNum(acc.rejected),
      accepted_known_limit: asNum(acc.accepted_known_limit),
    },
  };
  const integration = readIntegration(raw.integration);
  if (integration !== undefined) out.integration = integration;
  return out;
}

/** 读单项的 Agent 审查读数；缺字段/形态不对 = null（原 canonical 证据的只读适配，不另判独立性） */
export function readAgentReview(item: FeatureItem): AgentReviewReadout | null {
  const raw = asObject((item as { agent_review?: unknown }).agent_review);
  if (raw === null) return null;
  if (!isGateState(raw.state)) return null;
  return {
    state: raw.state,
    required_count: asNum(raw.required_count),
    passed_count: asNum(raw.passed_count),
    missing: asStringArray(raw.missing),
    evidence: normEvidence(raw.evidence),
  };
}

// ── 人话标签（不靠颜色；绿色只在服务端明确可试用时出现） ──
// 首屏默认用「Agent审查」，非作者/独立性的说明收进展开详情（U4）。
const GATE_LABEL: Record<string, string> = {
  coverage: "完整功能范围核查",
  review: "Agent审查与问题收口",
  runtime: "运行交付版本核对",
};
const GATE_STATE_LABEL: Record<string, string> = {
  passed: "已通过",
  pending: "未完成",
  unknown: "未知",
};
const EVIDENCE_LABEL: Record<string, string> = {
  verified: "证据有效",
  unverified: "证据未核实",
  missing: "缺证据",
  invalidated: "证据已失效",
  user_pending: "待用户验收",
};
const DESIGN_LABEL: Record<string, string> = {
  已核对: "已核对",
  缺失: "缺设计依据",
  部分: "部分覆盖",
  待审: "待审",
  源变待复核: "相关来源改过，要复验",
  无法判断: "无法判断",
};
/**
 * 阻断类别的人话标签（首屏按类别合并；未知类别落到通用说法）。
 * 键**同时覆盖**后端 `deliveryReadout` 的真实 `kind`（technical_verification / agent_review / design_coverage /
 * gate_* / integration_check / unmapped_requirement / blocking_finding / version / source_incomplete / no_features /
 * scope_* / not_derived）与旧夹具键（保留兼容，不因键名变化显示泛称）。
 */
const BLOCKER_KIND_LABEL: Record<string, string> = {
  // 旧夹具/兼容键（保留）
  missing_verification: "技术验证还没过",
  agent_review_pending: "还没有 Agent 审查记录",
  runtime_unchecked: "运行交付版本还没核对",
  design_gap: "设计覆盖有缺口",
  requirement_unmapped: "需求还没找到功能去向",
  evidence_invalid: "已有证据失效",
  integration_pending: "组合流程还没验证过",
  // 后端 deliveryReadout 的真实阻断类别（buildDeliveryOverview 实际产出）
  technical_verification: "技术验证还没过",
  agent_review: "还没有 Agent 审查记录",
  design_coverage: "设计覆盖有缺口",
  unmapped_requirement: "需求还没找到功能去向",
  blocking_finding: "有未收口的阻断缺陷",
  gate_coverage: "完整功能范围核查还没过",
  gate_review: "Agent 审查与问题收口还没过",
  gate_runtime: "运行交付版本还没核对",
  integration_check: "组合流程验证还没过",
  version: "版本/基线不可采信（未获批准或已漂移）",
  source_incomplete: "来源还没读齐",
  no_features: "还没有正式功能范围",
  scope_partial: "当前只读了局部范围",
  scope_historical: "当前读的是历史快照",
  not_derived: "这个版本还没有可核对的交付数据",
};

function blockerKindLabel(kind: string): string {
  return BLOCKER_KIND_LABEL[kind] ?? "还需要处理的事项";
}

/** 新增分母字段（正式需求/已登记待确认候选）在**旧宿主**里缺字段：显式"未知"，不拿 0 冒充"没有"。 */
function countOrUnknown(n: number | undefined): string {
  return typeof n === "number" ? String(n) : "未知";
}

/** 取一条待映射/候选需求的可回查来源引用（`RequirementRef.source_ref`；缺失返回空串） */
function requirementSourceRef(item: FeatureItem): string {
  return item.requirement_refs[0]?.source_ref ?? "";
}

// ── 方块/详情的状态芯片（色档由 `deliveryOverviewDisplay` 的同源读数适配给出） ──

function Chip({ tone, dim, children }: { tone: ChipDisplay["tone"]; dim: string; children: ReactNode }) {
  return (
    <span className={`tt-dlv-chip tt-dlv-chip-${tone}`} data-dim={dim}>
      {children}
    </span>
  );
}

/** 交付核对的通过读数：刷新失败（旧读数）时不显绿 */
function stateClass(state: string, stale: boolean): string {
  if (state === "passed") return stale ? "tt-dlv-neutral" : "tt-dlv-positive";
  return state === "pending" ? "tt-dlv-warning" : "tt-dlv-neutral";
}

function shortHash(h: string | null): string {
  return h === null || h === "" ? "—" : `${h.slice(0, 12)}…`;
}

/** 分页合并：同 package（cursor 绑定的那一版）下把后页并进来，按 item_id 去重、不丢项 */
function mergePages(prev: FeatureLedger, next: FeatureLedger): FeatureLedger {
  const seen = new Set(prev.items.map((i) => i.item_id));
  const items = [...prev.items];
  for (const it of next.items) {
    if (seen.has(it.item_id)) continue;
    seen.add(it.item_id);
    items.push(it);
  }
  return { ...next, items };
}

function samePackage(a: FeatureLedger, b: FeatureLedger): boolean {
  return a.package_revision === b.package_revision && a.document_selection.requested === b.document_selection.requested;
}

function reviewerNames(ev: AgentReviewEvidence[]): string {
  const names = ev.map((e) => e.reviewer).filter((r) => r !== "");
  return names.length === 0 ? "未署名" : names.join("、");
}

interface ReadError {
  unsupported: boolean;
  message: string;
  status: number | null;
  code: string;
}

export interface DeliveryOverviewProps {
  project: ProjectItem;
  /**
   * 跳到既有页面（设计书 / 实况与验收 / 项目图）；不新增 Tab，只复用现有 setView。
   * 「去验收」要落到**验收子页**（不是实况默认），所以允许带 `liveSub` 预置。
   */
  onNavigate: (view: ViewKey, opts?: { liveSub?: "live" | "acceptance" }) => void;
}

/**
 * 「交付总览」页：首屏结论 + 三类核对 + 组合流程验证 + 阻断 + 功能方块网格（右侧详情）+ 人的接受（单列）。
 * 读口失败/旧服务/局部范围/刷新失败分别说明，都不冒充可试用。
 */
export function DeliveryOverview({ project, onNavigate }: DeliveryOverviewProps) {
  const [ledger, setLedger] = useState<FeatureLedger | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ReadError | null>(null);
  /** 上次成功读数之后刷新失败的原因（有内容但已失效 ⇒ 撤下「可试用」结论） */
  const [staleReason, setStaleReason] = useState<string | null>(null);
  const [pagingBusy, setPagingBusy] = useState(false);
  const [pagingError, setPagingError] = useState<string | null>(null);
  const [pagingNotice, setPagingNotice] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  /** 方块网格的选中项与详情栏是否被关掉（关掉后点方块再开） */
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailClosed, setDetailClosed] = useState(false);
  /**
   * 「用户主动要到达详情」的一次性意图计数：选卡 / 重开详情各 +1（切到窄屏由 `narrow` 变化承担）。
   * 窄屏滚动**只认用户意图**——它不是一个状态台账，也不参与任何数据判据，只是让 effect 能在
   * 「同一张卡再点一次」时重新跑一次，而不必拿整个 `ledger` 对象当触发（那会随周期对账反复触发）。
   */
  const [detailScrollIntent, setDetailScrollIntent] = useState(0);
  /** 窄屏：详情栏叠到**网格上方**（不埋到十几张卡下面），用户选中后要把详情带进可视区 */
  const [narrow, setNarrow] = useState(() => window.matchMedia("(max-width: 1120px)").matches);

  const idRef = useRef(project.id);
  idRef.current = project.id;
  const ledgerRef = useRef<FeatureLedger | null>(null);
  ledgerRef.current = ledger;
  const loadedForRef = useRef<string | null>(null);
  const pagingGenRef = useRef(0);
  const pagingForceResetRef = useRef(false);
  /** 详情栏本体（窄屏选中后滚进可视区用） */
  const paneRef = useRef<HTMLElement>(null);
  /** 触发选中/打开详情的那张方块（关闭详情后焦点要回到它，键盘用户不丢位置） */
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  // 窄屏判定只影响**呈现**（详情栏放哪、选中后滚不滚），不参与任何数据判据
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 1120px)");
    const sync = (): void => setNarrow(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  /** 选中一个方块：记住触发块（关闭详情后焦点回到它），并记一次「要到达详情」的用户意图 */
  const openDetail = useCallback((itemId: string, el: HTMLButtonElement | null): void => {
    triggerRef.current = el;
    setSelectedId(itemId);
    setDetailClosed(false);
    setDetailScrollIntent((t) => t + 1);
  }, []);

  /** 关闭详情：焦点回到触发方块（窄屏还会随之滚回那张卡） */
  const closeDetail = useCallback((): void => {
    setDetailClosed(true);
    const el = triggerRef.current;
    if (el !== null && document.contains(el)) el.focus();
  }, []);

  const load = useCallback((signal: AbortSignal): Promise<void> => {
    const id = project.id;
    if (loadedForRef.current !== id) {
      loadedForRef.current = id;
      setLedger(null);
      setError(null);
      setStaleReason(null);
      setLoading(true);
      setPagingBusy(false);
      setPagingError(null);
      setPagingNotice(null);
      setSelectedId(null);
      setDetailClosed(false);
    }
    return getFeatureLedger(id, { document: "active" }, { signal })
      .then((l) => {
        if (signal.aborted || idRef.current !== id) return;
        pagingGenRef.current += 1; // 第一页落地：在途下一页作废（不拼两版）
        const prev = ledgerRef.current;
        const forceReset = pagingForceResetRef.current;
        pagingForceResetRef.current = false;
        if (!forceReset && prev !== null && prev.items.length > l.items.length && samePackage(prev, l)) {
          // 同一版本的周期对账：保住已载入的后页，**也要保住对应的 paging**
          // （否则「已读齐」会被新第一页的 cursor/complete=false 打回未载齐，游标回退）
          setLedger({ ...l, items: prev.items, paging: prev.paging });
        } else {
          setLedger(l);
        }
        setError(null);
        setStaleReason(null);
        setPagingBusy(false);
      })
      .catch((e: unknown) => {
        if (signal.aborted || idRef.current !== id) return;
        const err = e as { message?: string; status?: number | null; code?: string; unsupported?: boolean };
        const view: ReadError = {
          unsupported: err.unsupported === true,
          message: err.message ?? String(e),
          status: typeof err.status === "number" ? err.status : null,
          code: typeof err.code === "string" ? err.code : "",
        };
        setError(view);
        // 已有成功内容 ⇒ 保留内容但**撤下**当前结论（本次读数已失效）
        if (ledgerRef.current !== null) setStaleReason(view.message);
      })
      .finally(() => {
        if (!signal.aborted) setLoading(false);
      });
  }, [project.id]);

  // 统一周期对账（V09-26/F2）：换项目/回前台/在线恢复都重取；卸载与换项目作废在途回包
  const token = useProjectRefresh(project.id);
  const reload = useBoundedReloader(project.id, load);
  useEffect(() => {
    reload();
  }, [project.id, token, reloadTick, reload]);

  // 窄屏把详情栏带进可视区：**只在用户主动到达时**跳一次——选卡 / 重新打开详情（`detailScrollIntent`）
  // 或切换到窄屏（`narrow` 变化）。**刻意不依赖 `ledger`**：同项目周期对账每轮都会把 `ledger` 换成
  // 一个新对象，拿它当触发会在用户读完详情自行下滑后把人强行拉回详情（2026-10-09 复审回归）。
  // 详情栏不在 DOM 时（窄屏未选中 / 选中项在源刷新后已不存在）不跳。
  useEffect(() => {
    if (!narrow || detailClosed) return;
    paneRef.current?.scrollIntoView({ block: "start" });
  }, [narrow, detailClosed, detailScrollIntent]);

  // Esc 关闭详情（键盘可用）；关闭时焦点回到触发方块，所以只在详情确实可见时挂监听
  useEffect(() => {
    const paneVisible = !detailClosed && ledger !== null && (selectedId !== null || !narrow);
    if (!paneVisible) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") closeDetail();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [detailClosed, ledger, selectedId, narrow, closeDetail]);

  /** 真实续读下一页：cursor 绑 package_revision；版本变了（409）旧页作废、重读第一页，不拼接两版 */
  const loadMore = useCallback((): void => {
    const cur = ledger;
    if (cur === null || cur.paging.complete || pagingBusy) return;
    const cursor = cur.paging.cursor;
    if (cursor === null) return;
    const key = project.id;
    const gen = ++pagingGenRef.current;
    setPagingBusy(true);
    setPagingError(null);
    setPagingNotice(null);
    getFeatureLedger(project.id, { document: "active", cursor, expected_revision: cur.package_revision })
      .then((next) => {
        if (gen !== pagingGenRef.current || idRef.current !== key) return;
        setLedger((prev) => (prev === null ? next : mergePages(prev, next)));
      })
      .catch((e: unknown) => {
        if (gen !== pagingGenRef.current || idRef.current !== key) return;
        const err = e as { message?: string; code?: string };
        if (err.code === "REVISION_CHANGED") {
          // 版本冲突：当前 ledger **立即失效**（不等重读成功才撤就绪），再重读第一页
          setStaleReason(err.message ?? "清单版本已变（409）");
          pagingForceResetRef.current = true;
          setPagingNotice("这份清单的版本已经变了：上一页作废，正在重新读第一页。");
          setReloadTick((t) => t + 1);
          return;
        }
        setPagingError(err.message ?? String(e));
      })
      .finally(() => {
        if (gen === pagingGenRef.current) setPagingBusy(false);
      });
  }, [ledger, pagingBusy, project.id]);

  // ── 结论态：只取服务端 delivery.state；当前读数失效/缺字段/不支持分别如实降级 ──
  const delivery = ledger === null ? null : readDelivery(ledger);
  const withdrawn = staleReason !== null && ledger !== null;
  let state: string;
  if (ledger === null) {
    state = error === null ? "loading" : error.unsupported ? "unsupported" : "error";
  } else if (withdrawn) {
    state = "stale";
  } else if (ledger.state === "not_derived") {
    state = "not_derived";
  } else if (delivery === null) {
    state = "unknown";
  } else {
    state = delivery.state;
  }

  const jump = (
    <div className="tt-dlv-jumps">
      <button type="button" data-delivery-jump-design onClick={() => onNavigate("design")}>去设计书核对设计与需求</button>
      <button type="button" data-delivery-jump-acceptance onClick={() => onNavigate("live", { liveSub: "acceptance" })}>去验收区记录你的接受</button>
      <button type="button" data-delivery-jump-arch onClick={() => onNavigate("arch")}>看项目图（结构诊断，不代表交付结论）</button>
    </div>
  );

  // ── 无内容态：加载中 / 读失败 / 旧服务 / 尚未派生 ──
  if (ledger === null) {
    return (
      <section
        data-delivery-overview
        data-delivery-state={state}
        data-delivery-stale="0"
        className="tt-dlv"
      >
        <h3 className="tt-dlv-title">交付总览</h3>
        <p data-delivery-conclusion className="tt-dlv-conclusion tt-dlv-neutral">
          {state === "loading"
            ? "正在读取交付总览…"
            : state === "unsupported"
              ? "这个后端还没有交付总览这一项（旧服务未接入），暂时无法判断能不能开始人工试用"
              : state === "not_derived"
                ? "这个版本还没有可核对的交付数据"
                : "交付总览暂时读不到"}
        </p>
        {error !== null && (
          <p data-delivery-error className="tt-dlv-error">
            {error.unsupported
              ? "旧服务不识别交付总览读口；这不表示可以试用，也不表示清单为空。"
              : `读取失败：${error.message}${error.status !== null ? `（HTTP ${error.status}${error.code !== "" ? ` · ${error.code}` : ""}）` : ""}`}
            {!error.unsupported && (
              <button type="button" data-delivery-retry onClick={() => setReloadTick((t) => t + 1)} className="tt-dlv-retry">
                重新读取
              </button>
            )}
          </p>
        )}
        {state !== "loading" && jump}
      </section>
    );
  }

  const items = ledger.items;
  // 四类来源**各归各的**（互斥，见 `ProvenanceReadout.extraction`）：只有 `declared` 才进正式功能卡片与分母。
  const candidates = items.filter((i) => i.provenance.extraction === "unregistered_candidate");
  const pendingMapped = items.filter((i) => i.provenance.extraction === "mapped_requirement_pending");
  const registeredCandidates = items.filter((i) => i.provenance.extraction === "registered_candidate");
  const formal = items.filter((i) => i.provenance.extraction === "declared");

  // 详情栏当前展示的项：关掉后为 null；选中项不在当前清单（源刷新后消失）时**不留悬空详情**。
  // 窄屏默认不占位（详情栏放在网格上方，避免首屏看不到卡片）；宽屏默认展示第一项，与参考图一致。
  const activeItem = detailClosed
    ? null
    : selectedId !== null
      ? (formal.find((i) => i.item_id === selectedId) ?? null)
      : narrow
        ? null
        : (formal[0] ?? null);

  // 阻断按人话类别分组（首屏只给合并结论；完整明细折叠一条不丢）
  const blockerGroups = new Map<string, DeliveryBlockerReadout[]>();
  if (delivery !== null) {
    for (const b of delivery.blockers) {
      const list = blockerGroups.get(b.kind) ?? [];
      list.push(b);
      blockerGroups.set(b.kind, list);
    }
  }

  // 组合流程验证：缺字段明确未知（不自己另算 overall 来补）
  const integration: DeliveryIntegrationReadout =
    delivery?.integration ?? {
      state: "unknown",
      check_ids: [],
      missing: ["这个后端还没有提供组合流程验证读数（旧服务），无法确认组合流程是否通过"],
      evidence: [],
    };

  const conclusionText =
    state === "ready_for_trial"
      ? "可以开始人工试用"
      : state === "not_ready"
        ? "还不能开始人工试用"
        : state === "stale"
          ? "刚才刷新失败，暂时无法确认是否可以试用"
          : state === "not_derived"
            ? "这个版本还没有可核对的交付数据"
            : "暂时无法判断能否开始人工试用";
  const conclusionClass =
    state === "ready_for_trial" ? "tt-dlv-positive" : state === "not_ready" ? "tt-dlv-warning" : "tt-dlv-neutral";
  const staleSuffix = withdrawn ? "（上次）" : "";
  const staleMark = withdrawn ? "（上次成功读取的结果，现已失效）" : "";

  return (
    <section
      data-delivery-overview
      data-delivery-state={state}
      data-delivery-stale={withdrawn ? "1" : "0"}
      data-delivery-scope={delivery?.scope ?? "unknown"}
      className="tt-dlv"
    >
      <header className="tt-dlv-head">
        <h3 className="tt-dlv-title">交付总览</h3>
        <span className="tt-dlv-sub">现在能不能交给你试用、还差什么</span>
      </header>

      {/* 首屏只留：一句总体结论 + **一行**紧凑计数（含人的接受计数）；完整读数/核对/依据都在折叠区。 */}
      <div className="tt-dlv-hero">
        <p data-delivery-conclusion className={`tt-dlv-conclusion ${conclusionClass}`}>{conclusionText}</p>
        {delivery !== null && (
          <p data-delivery-counts className="tt-dlv-counts">
            正式功能 {delivery.counts.features} 项 · 设计覆盖 {delivery.counts.design_checked} · 技术验证 {delivery.counts.verified} ·
            Agent审查 {delivery.counts.reviewed} ·{" "}
            <span data-delivery-acceptance className="tt-dlv-accept-line">
              人的接受 待你决定 {delivery.user_acceptance.pending} · 已接受 {delivery.user_acceptance.accepted} · 已退回{" "}
              {delivery.user_acceptance.rejected} · 含已知限制 {delivery.user_acceptance.accepted_known_limit}
            </span>
            {delivery.blockers.length > 0 ? ` · 还差 ${delivery.blockers.length} 项` : ""}
          </p>
        )}
      </div>
      {delivery !== null && delivery.scope !== "project" && (
        <p data-delivery-scope-note className="tt-dlv-warn">
          {delivery.scope === "historical"
            ? "这是历史/已替代范围的读数，不能当作当前全项目的交付结论。"
            : "这是局部范围的读数，不能当作当前全项目的交付结论。"}
        </p>
      )}
      {/* 未知有两种，别混：delivery 缺失（旧服务/字段不全）才提示升级；delivery 齐全但结论未知（新服务对
          新项目的合法未知）不能引导升级、也不能让人自己猜是否已完成。 */}
      {state === "unknown" && (
        <p data-delivery-unknown className="tt-dlv-warn">
          {delivery === null
            ? "这个后端返回了功能清单，但没有可用的交付总览结论（旧服务或字段缺失/不完整）：未知不等于可以试用，请按下面的功能与核对项自行判断，或升级后端。"
            : "交付条件还无法确认，请查看下面的缺项与核对依据。"}
        </p>
      )}
      {withdrawn && (
        <p data-delivery-stale-note className="tt-dlv-warn">
          当前显示的是上次成功读取的结果；刚才这次刷新失败（{staleReason}），已撤下可试用结论，等读取成功后再确认。
          <button type="button" data-delivery-retry onClick={() => setReloadTick((t) => t + 1)} className="tt-dlv-retry">
            重新读取
          </button>
        </p>
      )}
      {delivery !== null && delivery.version.drift !== null && (
        <p data-delivery-drift className="tt-dlv-warn">版本漂移：{delivery.version.drift}</p>
      )}
      {ledger.document_selection.drift !== null && (
        <p data-delivery-doc-drift className="tt-dlv-warn">{ledger.document_selection.drift}</p>
      )}

      {/* ① 完整读数 / 人的接受说明 / 版本身份：默认折叠，一条不丢（首屏只留上面的紧凑计数） */}
      {delivery !== null && (
        <details className="tt-dlv-block tt-dlv-fold" data-delivery-version>
          <summary className="tt-dlv-block-head">
            {withdrawn ? `完整读数与版本依据${staleMark}` : "完整读数与版本依据"}
          </summary>
          <div className="tt-dlv-detail-body">
            <p className="tt-dlv-muted">
              正式功能 {delivery.counts.features} 项 · 设计覆盖已核对 {delivery.counts.design_checked} · 技术验证通过{" "}
              {delivery.counts.verified} · Agent审查通过 {delivery.counts.reviewed} · 已登记需求 {delivery.counts.requirements}（正式{" "}
              {countOrUnknown(delivery.counts.formal_requirements)}：已映射 {delivery.counts.mapped_requirements}、待映射{" "}
              {delivery.counts.pending_requirements}；已登记待确认 {countOrUnknown(delivery.counts.registered_candidates)}，不阻断）· 未登记候选{" "}
              {delivery.counts.candidates}
            </p>
            <p data-delivery-acceptance-note className="tt-dlv-muted">
              人的接受只由你本人在验收区记录：待决定 / 已接受 / 已退回 / 含已知限制分开计，Agent 不代签、不代改。
            </p>
            <div className="tt-dlv-muted">
              设计 {shortHash(delivery.version.design_revision)} · 施工 {shortHash(delivery.version.plan_revision)} · 基线{" "}
              {delivery.version.baseline_id ?? "（未激活）"} · 账本末序号 {delivery.version.ledger_last_seq}
            </div>
            <div className="tt-dlv-muted">读取的文档版本：{ledger.document_selection.mode}（包版本 {shortHash(ledger.package_revision)}）</div>
            <div className="tt-dlv-muted">包版本依据：{ledger.package_revision_basis.join(" / ") || "（无）"}</div>
          </div>
        </details>
      )}

      {/* ② 交付核对（三类）+ 组合流程验证：首屏只给四个状态读数，检查编号/证据/哈希折叠一条不丢 */}
      {delivery !== null && (
        <details data-delivery-gates className="tt-dlv-block tt-dlv-fold">
          <summary className="tt-dlv-block-head">
            {withdrawn ? `交付核对${staleMark}` : "交付核对（三项都要有有效证据）"}
            {delivery.gates.map((g) => (
              <span key={g.id} className="tt-dlv-state-chip">
                {GATE_LABEL[g.id] ?? (g.label !== "" ? g.label : g.id)}：
                <span className={stateClass(g.state, withdrawn)}>
                  {GATE_STATE_LABEL[g.state] ?? g.state}
                </span>
              </span>
            ))}
            <span className="tt-dlv-state-chip">
              组合流程验证：
              <span className={stateClass(integration.state, withdrawn)}>
                {GATE_STATE_LABEL[integration.state] ?? integration.state}
              </span>
            </span>
          </summary>
          <ul className="tt-dlv-list">
            {delivery.gates.map((g) => (
              <li key={g.id} data-delivery-gate={g.id} data-gate-state={g.state} className="tt-dlv-gate">
                <span className="tt-dlv-gate-name">{GATE_LABEL[g.id] ?? (g.label !== "" ? g.label : g.id)}</span>
                <span className={`tt-dlv-state ${stateClass(g.state, withdrawn)}`}>
                  {GATE_STATE_LABEL[g.state] ?? g.state}
                  {staleSuffix}
                </span>
                {g.missing.length > 0 && <span data-gate-missing className="tt-dlv-muted">（{g.missing.join("；")}）</span>}
                {g.evidence.length > 0 && (
                  <details className="tt-dlv-detail">
                    <summary>{g.evidence.length} 条证据（审查者 {reviewerNames(g.evidence)}）</summary>
                    <div className="tt-dlv-detail-body">
                      {g.evidence.map((e, i) => (
                        <div key={`${e.check_id}:${i}`} data-gate-evidence={e.check_id}>
                          {e.check_id} · 审查者 {e.reviewer || "（未署名）"} · {e.at || "（无时间）"} · 证据 {e.evidence_ref}
                          {e.record_ref !== null ? ` · 记录 ${e.record_ref}` : null}
                        </div>
                      ))}
                    </div>
                  </details>
                )}
              </li>
            ))}
            <li data-delivery-integration data-integration-state={integration.state} className="tt-dlv-gate">
              <span className="tt-dlv-gate-name">组合流程验证</span>
              <span className={`tt-dlv-state ${stateClass(integration.state, withdrawn)}`}>
                {GATE_STATE_LABEL[integration.state] ?? integration.state}
                {staleSuffix}
              </span>
              {integration.missing.length > 0 && (
                <span data-integration-missing className="tt-dlv-muted">（{integration.missing.join("；")}）</span>
              )}
              {integration.evidence.length > 0 && (
                <details className="tt-dlv-detail">
                  <summary>{integration.evidence.length} 条证据（审查者 {reviewerNames(integration.evidence)}）</summary>
                  <div className="tt-dlv-detail-body">
                    {integration.evidence.map((e, i) => (
                      <div key={`${e.check_id}:${i}`} data-integration-evidence={e.check_id}>
                        {e.check_id} · 审查者 {e.reviewer || "（未署名）"} · {e.at || "（无时间）"} · 证据 {e.evidence_ref}
                        {e.record_ref !== null ? ` · 记录 ${e.record_ref}` : null}
                      </div>
                    ))}
                  </div>
                </details>
              )}
            </li>
          </ul>
        </details>
      )}

      {/* ③ 阻断原因：首屏只留**一行**人话分类计数；按类别的分组与逐条明细收进折叠，一条不丢 */}
      {delivery !== null && delivery.blockers.length > 0 && (
        <p data-delivery-blockers-summary className="tt-dlv-counts tt-dlv-blockers-line">
          还差 {delivery.blockers.length} 项：
          {[...blockerGroups.entries()].map(([kind, list]) => `${blockerKindLabel(kind)} ${list.length}`).join(" · ")}
          {withdrawn ? "（上次结果）" : ""}
        </p>
      )}

      {/* ④ 正式功能：方块网格 + 右侧详情（页面主工作面，紧随结论与紧凑计数） */}
      <div data-delivery-features className="tt-dlv-block tt-dlv-block-wide">
        <div className="tt-dlv-featurebar">
          <p className="tt-dlv-block-head">正式功能（{formal.length} 项）</p>
          <p className="tt-dlv-muted">点一个方块，看它的用途、依据、验证与验收。</p>
        </div>
        {formal.length === 0 ? (
          <p className="tt-dlv-muted">这个范围还没有可展示的正式功能。</p>
        ) : (
          <div className="tt-dlv-grid-layout" data-detail-open={activeItem === null ? "0" : "1"}>
            <div className="tt-dlv-grid" data-delivery-grid>
              {formal.map((item, index) => (
                <DeliveryCard
                  key={item.item_id}
                  item={item}
                  index={index}
                  stale={withdrawn}
                  selected={activeItem !== null && activeItem.item_id === item.item_id}
                  onSelect={(el) => openDetail(item.item_id, el)}
                />
              ))}
            </div>
            {activeItem !== null && (
              <DeliveryDetailPane
                item={activeItem}
                stale={withdrawn}
                paneRef={paneRef}
                onClose={closeDetail}
              />
            )}
          </div>
        )}
      </div>

      {/* ⑤ 待处理的全部明细：默认折叠、是**唯一**排在卡片之后的折叠区（上面 ① 完整读数与 ② 交付核对
          两个折叠区仍排在卡片**之前**，折叠状态各占一行；首屏只留结论与一行计数，卡片是主工作面） */}
      {delivery !== null && delivery.blockers.length > 0 && (
        <details data-delivery-blockers className="tt-dlv-block tt-dlv-block-warn tt-dlv-fold">
          <summary className="tt-dlv-block-head">
            还差什么：全部 {delivery.blockers.length} 条待处理明细（按类别分组{withdrawn ? "，上次结果" : ""}）
          </summary>
          <ul className="tt-dlv-list">
            {[...blockerGroups.entries()].map(([kind, list]) => (
              <li key={kind} data-delivery-blocker-group={kind} className="tt-dlv-blocker-group">
                <span className="tt-dlv-blocker-tag">{blockerKindLabel(kind)}</span>
                <span className="tt-dlv-muted">{list.length} 项</span>
              </li>
            ))}
          </ul>
          <details className="tt-dlv-detail" data-delivery-blocker-detail>
            <summary>展开全部 {delivery.blockers.length} 项技术明细（一条不丢）</summary>
            <div className="tt-dlv-detail-body">
              <ul className="tt-dlv-list">
                {delivery.blockers.map((b, i) => (
                  <li key={`${b.kind}:${b.item_id ?? ""}:${i}`} data-delivery-blocker={b.kind}>
                    {b.message}
                    {b.item_id !== null ? <span className="tt-dlv-muted">（功能 {b.item_id}）</span> : null}
                  </li>
                ))}
              </ul>
            </div>
          </details>
        </details>
      )}
      {withdrawn && delivery !== null && delivery.summary !== "" && (
        <details className="tt-dlv-detail" data-delivery-prev-summary>
          <summary>上次成功读取时给出的服务端结论（已失效，仅供追溯）</summary>
          <div className="tt-dlv-detail-body">
            <p className="tt-dlv-summary">{delivery.summary}</p>
          </div>
        </details>
      )}
      {!withdrawn && delivery !== null && delivery.summary !== "" && (
        <details className="tt-dlv-detail" data-delivery-summary-fold>
          <summary>服务端结论原文（依据，可追溯）</summary>
          <div className="tt-dlv-detail-body">
            <p data-delivery-summary className="tt-dlv-summary">
              {delivery.summary}
            </p>
          </div>
        </details>
      )}

      {/* ⑥ 已登记待映射需求（另列，不混分母；带数量的折叠区，不占首屏） */}
      <details data-delivery-pending-requirements className="tt-dlv-block tt-dlv-fold">
        <summary className="tt-dlv-block-head">已登记但还没有正式功能去向的需求（{pendingMapped.length} 项）</summary>
        {pendingMapped.length === 0 ? (
          <p className="tt-dlv-muted">（无）</p>
        ) : (
          <ul className="tt-dlv-list">
            {pendingMapped.map((i) => (
              <li key={i.item_id} data-pending-requirement={i.item_id}>
                {i.display_name}：{i.user_description || "（没有人话说明）"}
                <span className="tt-dlv-muted">（{i.item_id}）</span>
              </li>
            ))}
          </ul>
        )}
      </details>

      {/* ⑥′ 已登记待确认候选（未映射 ∧ status=待确认；另列、不混正式功能分母、**不阻断**；带数量的折叠区） */}
      <details data-delivery-registered-candidates className="tt-dlv-block tt-dlv-fold">
        <summary className="tt-dlv-block-head">
          已登记待确认候选（总数 {countOrUnknown(delivery?.counts.registered_candidates)}；单列，不阻断交付）
        </summary>
        {registeredCandidates.length === 0 ? (
          <p className="tt-dlv-muted">
            {delivery?.counts.registered_candidates === undefined
              ? "数量未知：服务未提供这类候选的完整计数。"
              : delivery.counts.registered_candidates === 0 && ledger?.paging.complete
                ? "（无）"
                : "当前页面尚未返回候选明细，请继续加载后查看。"}
          </p>
        ) : (
          <ul className="tt-dlv-list">
            {registeredCandidates.map((i) => (
              <li key={i.item_id} data-registered-candidate={i.item_id}>
                {i.display_name}：{i.user_description || "（没有人话说明）"}
                <span className="tt-dlv-muted">
                  （需求 {i.requirement_refs[0]?.requirement_id ?? i.item_id} · 状态 待确认
                  {requirementSourceRef(i) !== "" ? ` · 来源 ${requirementSourceRef(i)}` : ""}）
                </span>
              </li>
            ))}
          </ul>
        )}
      </details>

      {/* ⑦ 未登记候选（另列，不混分母；带数量的折叠区，不占首屏） */}
      <details data-delivery-candidates className="tt-dlv-block tt-dlv-fold">
        <summary className="tt-dlv-block-head">未登记候选（用户补充/待议，{candidates.length} 项）</summary>
        {candidates.length === 0 ? (
          <p className="tt-dlv-muted">（无）</p>
        ) : (
          <ul className="tt-dlv-list">
            {candidates.map((i) => (
              <li key={i.item_id} data-candidate={i.item_id}>
                {i.display_name}：{i.user_description || "（没有人话说明）"}
                <span className="tt-dlv-muted">（{i.item_id}）</span>
              </li>
            ))}
          </ul>
        )}
      </details>

      {/* ⑧ 分页续读（真实 cursor；pagecomplete ≠ sourcecomplete） */}
      <div data-delivery-paging className="tt-dlv-paging">
        {ledger.paging.complete ? (
          <span data-delivery-paging-complete className="tt-dlv-muted">
            已全部载入 {items.length} 项（是否有来源没读齐，看上面的覆盖率与核对项）。
          </span>
        ) : (
          <>
            <button type="button" data-delivery-load-more disabled={pagingBusy} onClick={loadMore} className="tt-dlv-load-more">
              {pagingBusy ? "正在读取下一页…" : "继续读取下一页"}
            </button>
            <span className="tt-dlv-muted">（本页之后还有没载入的功能）</span>
          </>
        )}
      </div>
      {pagingNotice !== null && (
        <p data-delivery-paging-notice className="tt-dlv-warn">{pagingNotice}</p>
      )}
      {pagingError !== null && (
        <p data-delivery-paging-error className="tt-dlv-error">下一页没读进来（已载入的内容仍在）：{pagingError}</p>
      )}
      {!ledger.coverage.source_complete && (
        <p data-delivery-source-incomplete className="tt-dlv-warn">
          来源没有读齐，先别把这份结论当完整：
          {ledger.coverage.unexamined_sources.length > 0
            ? ledger.coverage.unexamined_sources.map((s) => `${s.ref}（${s.reason}）`).join("；")
            : `已登记需求 ${ledger.coverage.registered_requirement_count} 条`}
        </p>
      )}

      {jump}
    </section>
  );
}

/**
 * 一个功能方块：审定短名 + 一句用途 + **分开的**三类读数（实现／技术验证／Agent审查）。
 * 整块是 `button`（键盘可 Tab/Enter 选取，焦点可见），不靠点小字选中；缺口直接标在方块上。
 * 名称优先用审定别名（精确原文匹配），**表里没有的原文原样完整换行呈现**，不用省略号隐藏范围。
 */
function DeliveryCard({
  item,
  index,
  stale,
  selected,
  onSelect,
}: {
  item: FeatureItem;
  index: number;
  stale: boolean;
  selected: boolean;
  onSelect: (el: HTMLButtonElement | null) => void;
}) {
  const review = readAgentReview(item);
  const dc = item.design_coverage.state;
  const copy = displayCopyOf(item.display_name);
  const name = copy === null ? item.display_name : copy.short;
  const purpose =
    copy !== null
      ? copy.purpose
      : item.scenario !== ""
        ? item.scenario
        : item.user_description !== ""
          ? item.user_description
          : "（还没有用途说明）";
  const readoutVerified = verificationIsCurrent(item.verification);
  const impl = implementationChip(item.implementation.state, readoutVerified, stale);
  const verify = verificationChip(item.verification, stale);
  const reviewState = review === null ? null : review.state;
  const rev = reviewChip(reviewState, stale);
  const gaps = item.verification.missing.length + (review === null ? 0 : review.missing.length) + (item.design_coverage.gap === null || item.design_coverage.gap === "" ? 0 : 1);
  return (
    <button
      type="button"
      data-delivery-feature={item.item_id}
      data-agent-review={reviewState ?? "unknown"}
      data-design-coverage={dc}
      aria-pressed={selected}
      onClick={(e) => onSelect(e.currentTarget)}
      className="tt-dlv-card"
    >
      <span className="tt-dlv-card-index">{String(index + 1).padStart(2, "0")}</span>
      <span data-feature-name className="tt-dlv-card-name">{name}</span>
      <span data-feature-scenario className="tt-dlv-card-scenario">{purpose}</span>
      <span className="tt-dlv-card-chips">
        <Chip tone={impl.tone} dim="implementation">实现：{impl.label}</Chip>
        <Chip tone={verify.tone} dim="verification">技术验证：{verify.label}</Chip>
        <Chip tone={rev.tone} dim="review">Agent审查：{rev.label}</Chip>
        {gaps > 0 && (
          <Chip tone="warn" dim="gap">缺口 {gaps} 项</Chip>
        )}
      </span>
    </button>
  );
}

/**
 * 右侧详情：**原名与原场景完整保留**，加上需求/设计覆盖、实现依据、验证/审查记录、缺口与人的接受。
 * 默认只给人话读数；功能 ID / 需求与设计来源 / 审查者与时间 / 哈希 / 账本序号收进折叠的技术细节，
 * 让人能核对，但不把方块与总览堆成长文字。窄屏时叠到网格上方并由父级滚进可视区。
 */
function DeliveryDetailPane({
  item,
  stale,
  paneRef,
  onClose,
}: {
  item: FeatureItem;
  stale: boolean;
  paneRef: RefObject<HTMLElement>;
  onClose: () => void;
}) {
  const review = readAgentReview(item);
  const dc = item.design_coverage;
  const dcState = DESIGN_LABEL[dc.state] ?? dc.state;
  const readoutVerified = verificationIsCurrent(item.verification);
  const impl = implementationChip(item.implementation.state, readoutVerified, stale);
  const verify = verificationChip(item.verification, stale);
  const purpose = item.scenario !== "" ? `用在：${item.scenario}` : item.user_description !== "" ? item.user_description : "（还没有用途说明）";
  const reviewState = review === null ? null : review.state;
  const rev = reviewChip(reviewState, stale);
  const accept = acceptanceChip(item.user_acceptance.state);
  return (
    <aside
      ref={paneRef}
      className="tt-dlv-pane"
      data-delivery-detail-pane
      data-pane-stale={stale ? "1" : "0"}
      aria-label="所选功能的说明"
    >
      <div className="tt-dlv-pane-head">
        <span className="tt-dlv-pane-eyebrow">你正在了解的功能</span>
        <button type="button" className="tt-dlv-pane-close" data-delivery-detail-close onClick={onClose} aria-label="关闭详情">×</button>
      </div>
      <h3 className="tt-dlv-pane-name" data-detail-name>{item.display_name}</h3>
      <p className="tt-dlv-pane-purpose" data-detail-purpose>{purpose}</p>
      {stale && (
        <p data-detail-stale-note className="tt-dlv-warn">下面是上一次成功读取的读数，刚才这次刷新失败，结论已撤下。</p>
      )}
      <div className="tt-dlv-pane-chips">
        <Chip tone={impl.tone} dim="implementation">实现：{impl.label}</Chip>
        <Chip tone={verify.tone} dim="verification">技术验证：{verify.label}</Chip>
        <Chip tone={rev.tone} dim="review">Agent审查：{rev.label}</Chip>
        <Chip tone={accept.tone} dim="accept">{accept.label}</Chip>
      </div>

      <section className="tt-dlv-pane-sec">
        <h4 className="tt-dlv-pane-sec-label">需求与设计覆盖</h4>
        <p>设计覆盖：{dcState}</p>
        {dc.review.unmet !== null && dc.review.unmet !== "" && <p className="tt-dlv-muted">{dc.review.unmet}</p>}
        {dc.gap !== null && dc.gap !== "" && <p className="tt-dlv-warn">缺口：{dc.gap}</p>}
        <p className="tt-dlv-muted">需求依据 {item.requirement_refs.length} 条 · 设计章节 {item.design_section_refs.length} 处（明细见下方技术细节）</p>
      </section>

      <section className="tt-dlv-pane-sec">
        <h4 className="tt-dlv-pane-sec-label">实现依据</h4>
        <p>{impl.label}{item.implementation.basis !== null ? "（账本有对应运行记录）" : "（还没有运行投影）"}</p>
      </section>

      <section className="tt-dlv-pane-sec">
        <h4 className="tt-dlv-pane-sec-label">技术验证记录</h4>
        <p>
          技术验证：{verify.label}（
          {EVIDENCE_LABEL[item.verification.evidence_state] ?? item.verification.evidence_state}，{item.verification.passed_count}/
          {item.verification.required_count}）
        </p>
        {item.verification.missing.length > 0 && (
          <p data-feature-verify-missing className="tt-dlv-warn">缺口：{item.verification.missing.join("；")}</p>
        )}
      </section>

      <section className="tt-dlv-pane-sec">
        <h4 className="tt-dlv-pane-sec-label">Agent 审查记录</h4>
        <p>
          {review === null
            ? "未知（旧服务未提供审查读数）"
            : `${rev.label}（${review.passed_count}/${review.required_count}）`}
        </p>
        {review !== null && review.missing.length > 0 && (
          <p data-feature-review-missing className="tt-dlv-warn">缺口：{review.missing.join("；")}</p>
        )}
      </section>

      <section className="tt-dlv-pane-sec">
        <h4 className="tt-dlv-pane-sec-label">你的接受</h4>
        <p>{accept.label}</p>
        {item.user_acceptance.unmet !== null && item.user_acceptance.unmet !== "" && (
          <p className="tt-dlv-muted">{item.user_acceptance.unmet}</p>
        )}
      </section>

      <details className="tt-dlv-detail" data-detail-technical>
        <summary>技术细节（功能 ID / 需求与设计来源 / 验证与审查记录 / 版本）</summary>
        <div className="tt-dlv-detail-body">
          <dl className="tt-dlv-dl">
            <dt>功能 ID</dt>
            <dd>{item.item_id}</dd>
            <dt>需求依据</dt>
            <dd>
              {item.requirement_refs.length === 0
                ? "（没有需求依据）"
                : item.requirement_refs.map((r) => (
                    <div key={r.requirement_id}>
                      {r.requirement_id} · {r.certainty} · {r.source_ref}
                    </div>
                  ))}
            </dd>
            <dt>设计章节</dt>
            <dd>
              {item.design_section_refs.length === 0
                ? "（无）"
                : item.design_section_refs.map((s) => (
                    <div key={`${s.anchor}:${s.line}`}>
                      {s.title}（第 {s.line} 行 · {s.status}）
                    </div>
                  ))}
            </dd>
            <dt>实现依据</dt>
            <dd>
              {impl.label} · {item.implementation.basis ?? "（没有运行投影）"}
            </dd>
            <dt>技术验证证据</dt>
            <dd>
              {item.verification.evidence_entry.length === 0
                ? "（无）"
                : item.verification.evidence_entry.map((e) => (
                    <div key={`${e.check_id}:${e.evidence_ref}`}>
                      {e.check_id} · {e.effective} · {e.evidence_ref}
                    </div>
                  ))}
              有效版本 {item.verification.effective_version ?? "（拿不到）"}
            </dd>
            <dt>非作者审查（Agent 审查）</dt>
            <dd>
              {review === null
                ? "（后端未提供审查读数）"
                : review.evidence.length === 0
                  ? "（没有审查证据记录）"
                  : review.evidence.map((e, i) => (
                      <div key={`${e.check_id}:${i}`} data-review-evidence={e.check_id}>
                        {e.check_id} · 审查者 {e.reviewer || "（未署名）"} · {e.at || "（无时间）"} · 证据 {e.evidence_ref}
                        {e.record_ref !== null ? ` · 记录 ${e.record_ref}` : null}
                      </div>
                    ))}
            </dd>
            <dt>你的接受</dt>
            <dd>
              {accept.label} · 成员{" "}
              {item.user_acceptance.scope_tasks.join("、") || "（无）"} · 记录 {item.user_acceptance.gate_ref ?? "—"}
            </dd>
            <dt>来源与派生</dt>
            <dd>
              提取 {item.provenance.extraction} · 派生设计 {shortHash(item.provenance.derivation.design_revision)} · 账本末序号{" "}
              {item.provenance.derivation.ledger_last_seq}
              {item.provenance.unmapped.length > 0 && <div>未映射：{item.provenance.unmapped.join("、")}</div>}
            </dd>
            <dt>本项技术验证</dt>
            <dd>{readoutVerified ? `${verify.label}（最终结论以上方交付总览为准）` : verify.label}</dd>
          </dl>
        </div>
      </details>
    </aside>
  );
}

export default DeliveryOverview;
