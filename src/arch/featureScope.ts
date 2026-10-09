// V09-55（协作闭环 B5）：**范围（scope）成员账目的唯一枚举出处** ＋ 喂给唯一义务层的
// **canonical 输入装配**与**投影适配**。
//
// 背景（诊断反例，2026-10-07 `COORDINATOR-CHECKS.json`）：同一能力对象在六图里出现**不同主状态**
// （功能全景 `verified` vs 系统架构 `pending_verification`，跨项目另有 `blocked` vs `unmapped`）。
// 根因有两条，都在「各视图各算一份业务状态」：
//   ① **成员账目按视图各建**：功能全景成员 = 声明关系（design_interface＋task_design_ref）；
//      系统架构另外把「能力 ← task_design_ref ← 任务 → implementation_map(observed) → 代码模块」
//      的二级派生并进成员；于是同一能力的成员集合不同。
//   ② **能力层各写一份绿公式**：能力节点的显示状态在 UI 里按「成员全绿 ＋ 集成数组」自算一套——
//      这**不是** canonical（DESIGN §2.6「一个事实、一次派生」）。本文件此前的 `scopeStatusOf`
//      就是这种第二份业务判定，**已撤掉**。
//
// 本文件现在的职责（严格区分「枚举/装配」与「判定」）：
//   · **枚举**（本文件唯一负责）：范围成员从**正式关系**（design_interface／task_design_ref ＋
//     observed 的 implementation_map 二级派生）确定性枚举，视图无关；成员账目/版本指纹在此。
//   · **装配**（本文件唯一负责）：把蓝图正式输入与施工图声明装配成 canonical `StatusObjectInput`
//     （object_kind = capability，children = 成员对象），交给**唯一义务层**判。
//   · **适配**（本文件唯一负责）：把 canonical `StatusProjection` **原样**读成上屏读数
//     （`ScopeReadout`）——**不判绿、不封顶、不另写优先级**。
//
// 业务状态（绿/红/橙/未知）**只**由 `src/server/work/statusProjection.ts#projectStatuses`
// （唯一义务层 `deriveObligations` 的判据）给出；本文件不 import 它的**值**（只作类型引用），
// 也不 import 任何带 fs 的模块，保持零 React / 零 IO、可被服务端读口与 UI 共用。

import { DISPLAY_STATUS_KEYS, type DisplayStatusKey } from "../ui/arch/statusColor";
import type { StatusObjectInput } from "../server/work/statusProjection";

// ═══════════════════════ ① 成员账目（视图无关，唯一枚举口径） ═══════════════════════

/** 成员归属的**正式来源**：只有这三类关系产生范围成员，导航/目录等中性对象不产生义务（§3.2） */
export type ScopeMemberVia = "design_interface" | "task_design_ref" | "implementation_map";

export type ScopeMemberKind = "task" | "module" | "code" | "other";

/** 最小关系形状（结构化入参：不 import 蓝图模块，避免 `blueprint.ts → projectGraph.ts` 的运行期环） */
export interface ScopeEdgeLike {
  source: string;
  target: string;
  kind: string;
  certainty?: string;
}

export interface ScopeNodeLike {
  id: string;
  kind: string;
  name?: string;
}

export interface ScopeBlueprintLike {
  nodes: readonly ScopeNodeLike[];
  edges: readonly ScopeEdgeLike[];
}

export interface ScopeMemberEntry {
  id: string;
  kind: ScopeMemberKind;
  /** 该成员由哪些正式关系归属进来（有序、去重）；二级派生会同时带 `task_design_ref` 与 `implementation_map` */
  via: ScopeMemberVia[];
}

/** 成员账目版本指纹的输入之一：本范围**检查定义**的稳定引用（`scope_revision` 必须含它，§2.5.1/§2.9） */
export interface ScopeCheckDefinitionRef {
  check_id: string;
  /** 该检查定义的不可变指纹（重排不变、改语义即变；拿不到定义时 null 如实标注） */
  definition_fingerprint?: string | null;
  /** 归属：必需检查 / 集成检查 / 其它 */
  role?: "required" | "integration" | "other";
}

export interface ScopeLedger {
  scope_id: string;
  /**
   * 成员账目 ＋ **检查定义**的版本指纹（成员集合/归属关系/检查定义任一变化即变；不是时间戳）。
   * 同 `scope_id` + 同 `scope_revision` + 同包版本 ⇒ 六图必须给同一成员账目与同一主状态。
   */
  scope_revision: string;
  members: ScopeMemberEntry[];
  /** 成员 id（升序，便于六图逐 id 对账） */
  member_ids: string[];
  /** 参与版本指纹的检查定义（升序；没给 = 空） */
  checks: ScopeCheckDefinitionRef[];
}

/** 稳定 ID → 成员种类（只看前缀，不看名字；导航对象落 `other`） */
export function scopeMemberKindOf(id: string): ScopeMemberKind {
  if (id.startsWith("plan:task:")) return "task";
  if (id.startsWith("plan:code:")) return "code";
  if (id.startsWith("plan:mod:")) return "module";
  return "other";
}

/** 极简确定性指纹（FNV-1a 32 位十六进制）：不引 node:crypto，UI/服务端/脚本都能跑 */
function fnv1aHex(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** 成员账目 + 检查定义的确定性版本指纹（升序归一，重排不变） */
export function scopeRevisionOf(input: {
  scope_id: string;
  members: readonly ScopeMemberEntry[];
  checks?: readonly ScopeCheckDefinitionRef[];
}): string {
  const members = [...input.members]
    .map((m) => [m.id, [...m.via].sort()])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  const checks = [...(input.checks ?? [])]
    .map((c) => [c.check_id, c.definition_fingerprint ?? null, c.role ?? "other"])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return `srev-${fnv1aHex(JSON.stringify([input.scope_id, members, checks]))}`;
}

const pushVia = (map: Record<string, ScopeMemberVia[]>, member: string, via: ScopeMemberVia): void => {
  const list = map[member] ?? [];
  if (!list.includes(via)) list.push(via);
  map[member] = list;
};

/**
 * 范围成员账目（逐能力）：成员 = 声明归属（design_interface／task_design_ref）＋ 实测二级派生
 * （observed 的 implementation_map 经 task_design_ref 归到能力）。
 *
 * 这条路**与视图无关**：功能全景、系统架构与三张技术详情图都读同一份，成员集合不再随视图变化。
 * 二级派生带 `certainty === "observed"` 才计入（附录 D：只认可复算的路径事实，模型线索边不给归属）。
 */
export function capabilityMemberViaOf(
  edges: readonly ScopeEdgeLike[],
  capabilityIds: ReadonlySet<string>,
): Record<string, Record<string, ScopeMemberVia[]>> {
  const out: Record<string, Record<string, ScopeMemberVia[]>> = {};
  const bucket = (cap: string): Record<string, ScopeMemberVia[]> => (out[cap] ??= {});
  const tasksByCap = new Map<string, string[]>();

  for (const e of edges) {
    if (e.kind === "design_interface" && capabilityIds.has(e.source)) {
      pushVia(bucket(e.source), e.target, "design_interface");
    }
    if (e.kind === "task_design_ref" && capabilityIds.has(e.target)) {
      pushVia(bucket(e.target), e.source, "task_design_ref");
      const list = tasksByCap.get(e.target) ?? [];
      if (!list.includes(e.source)) list.push(e.source);
      tasksByCap.set(e.target, list);
    }
  }
  // 二级派生：能力 ← task_design_ref ← 任务 → implementation_map(observed) → 代码模块
  for (const e of edges) {
    if (e.kind !== "implementation_map" || e.certainty !== "observed") continue;
    if (!e.target.startsWith("plan:code:")) continue;
    for (const [cap, tasks] of tasksByCap) {
      if (!tasks.includes(e.source)) continue;
      pushVia(bucket(cap), e.target, "implementation_map");
    }
  }
  return out;
}

/**
 * 声明成员（**不含**二级派生）：`design_interface`（能力→模块）＋ `task_design_ref`（任务→能力）。
 * 这是来源/证据标注与蓝图对账沿用的口径（`provenance.ts#capabilityMembersOf` 直接复用本函数，
 * 保证「声明成员」也只有一处实现）。范围主状态用 `capabilityMemberViaOf`（声明＋派生）。
 */
export function capabilityDeclaredMemberViaOf(
  edges: readonly ScopeEdgeLike[],
  capabilityIds: ReadonlySet<string>,
): Record<string, Record<string, ScopeMemberVia[]>> {
  const out: Record<string, Record<string, ScopeMemberVia[]>> = {};
  const bucket = (cap: string): Record<string, ScopeMemberVia[]> => (out[cap] ??= {});
  for (const e of edges) {
    if (e.kind === "design_interface" && capabilityIds.has(e.source)) {
      pushVia(bucket(e.source), e.target, "design_interface");
    }
    if (e.kind === "task_design_ref" && capabilityIds.has(e.target)) {
      pushVia(bucket(e.target), e.source, "task_design_ref");
    }
  }
  return out;
}

/** 声明成员 id 列表（升序）——`capabilityMembersOf` 的同一份口径 */
export function capabilityDeclaredMembersOf(
  edges: readonly ScopeEdgeLike[],
  capabilityIds: ReadonlySet<string>,
): Record<string, string[]> {
  const via = capabilityDeclaredMemberViaOf(edges, capabilityIds);
  const out: Record<string, string[]> = {};
  for (const [cap, map] of Object.entries(via)) out[cap] = Object.keys(map).sort();
  return out;
}

const capabilityIdsOf = (bp: ScopeBlueprintLike): Set<string> =>
  new Set(bp.nodes.filter((n) => n.kind === "capability").map((n) => n.id));

/**
 * 全部范围（能力）的成员账目，键 = 稳定 `scope_id`（能力节点 id，如 `plan:cap:08`）。
 * 没有成员的能力也在表里（空成员如实留空，供上层「不空集判绿」与缺口点名）。
 *
 * `checkDefinitionOf`：可选，逐范围给出该范围的检查定义引用，参与 `scope_revision`
 * （§2.5.1：`scope_revision` 记录**成员与检查定义的版本**，不是仅拓扑指纹）。
 */
export function scopeMemberLedgerOf(
  bp: ScopeBlueprintLike,
  opts: { checkDefinitionOf?: (scopeId: string) => readonly ScopeCheckDefinitionRef[] } = {},
): Record<string, ScopeLedger> {
  const capabilityIds = capabilityIdsOf(bp);
  const via = capabilityMemberViaOf(bp.edges, capabilityIds);
  const out: Record<string, ScopeLedger> = {};
  for (const cap of bp.nodes.filter((n) => n.kind === "capability")) {
    const map = via[cap.id] ?? {};
    const members: ScopeMemberEntry[] = Object.keys(map)
      .sort()
      .map((id) => ({ id, kind: scopeMemberKindOf(id), via: [...map[id]].sort() as ScopeMemberVia[] }));
    const checks = [...(opts.checkDefinitionOf?.(cap.id) ?? [])];
    out[cap.id] = {
      scope_id: cap.id,
      scope_revision: scopeRevisionOf({ scope_id: cap.id, members, checks }),
      members,
      member_ids: members.map((m) => m.id),
      checks,
    };
  }
  return out;
}

/** 一个范围的成员 id（升序）；范围不在表里或没有成员时返回空数组（**不猜**） */
export function scopeMemberIdsOf(bp: ScopeBlueprintLike, scopeId: string): string[] {
  return scopeMemberLedgerOf(bp)[scopeId]?.member_ids ?? [];
}

// ═══════════════════════ ② canonical 输入装配（交给唯一义务层判） ═══════════════════════

/** 该范围自身集成检查要求的一项（来自施工图**版本化验收定义**或显式覆盖；不是调用方临时声明） */
export interface ScopeIntegrationRequirement {
  check_id: string;
  label: string;
  required?: boolean;
}

/** 集成检查要求的来源与版本（canonical `StatusObjectInput` 的可解释性字段） */
export interface ScopeIntegrationSource {
  source: "plan" | "override" | "none";
  revision: string | null;
  /** 有声明但当前**不能据此判绿**的原因（如「声明未被有效基线批准」） */
  blocked_reason: string | null;
}

/**
 * 成员稳定 id → canonical 投影对象 id：任务 = 卡号本人；代码模块 = `module:<模块 id>`；
 * 声明模块（`plan:mod:*`）没有 canonical 对象 ⇒ `null`（如实返回，不硬凑）。
 */
export function canonicalObjectIdOfMember(memberId: string): string | null {
  if (memberId.startsWith("plan:task:")) return memberId.slice("plan:task:".length);
  if (memberId.startsWith("plan:code:")) return `module:${memberId.slice("plan:code:".length)}`;
  return null;
}

export interface ScopeStatusObjectInputPlan {
  blueprint: ScopeBlueprintLike;
  /**
   * 本范围的成员对象 id → 它是否**真的**在 canonical 对象表里（存在才作必需子项）。
   * `null` ⇒ 该成员没有可判对象（如实不进子项、不改判据；成员仍在账目里可见）。
   */
  memberObjectIn: (objectId: string) => boolean;
  /** 该范围自身的集成检查要求；缺省 = 没有要求（canonical 因此判不了绿，不空集判绿） */
  integrationOf?: (scopeId: string) => readonly ScopeIntegrationRequirement[];
  /** 集成检查要求的来源与版本；缺省 = `none` */
  integrationSourceOf?: (scopeId: string) => ScopeIntegrationSource;
  /** 逐范围的检查定义引用（进 `scope_revision`） */
  checkDefinitionOf?: (scopeId: string) => readonly ScopeCheckDefinitionRef[];
}

/**
 * 把蓝图正式关系装配成 canonical `StatusObjectInput`（object_kind = `capability`）：
 * `children_ids` = 成员的 canonical 对象（任务/代码模块）；**自身集成检查**照施工图声明给；
 * 成员全被过滤/没有成员 ⇒ `unmapped`（canonical 不空集判绿）。
 *
 * **本函数不判任何状态**——绿/红/橙/未知一律由 `projectStatuses` 按同一份判据给出。
 */
export function scopeStatusObjectsOf(plan: ScopeStatusObjectInputPlan): StatusObjectInput[] {
  const ledger = scopeMemberLedgerOf(plan.blueprint, { ...(plan.checkDefinitionOf ? { checkDefinitionOf: plan.checkDefinitionOf } : {}) });
  const out: StatusObjectInput[] = [];
  for (const n of plan.blueprint.nodes) {
    if (n.kind !== "capability") continue;
    const children = (ledger[n.id]?.member_ids ?? [])
      .map((m) => canonicalObjectIdOfMember(m))
      .filter((id): id is string => id !== null && plan.memberObjectIn(id))
      .sort();
    const integration = [...(plan.integrationOf?.(n.id) ?? [])];
    const src = plan.integrationSourceOf?.(n.id) ?? { source: "none" as const, revision: null, blocked_reason: null };
    out.push({
      object_id: n.id,
      object_kind: "capability",
      label: n.name ?? n.id,
      children_ids: children,
      integration_checks: integration.map((c) => ({ check_id: c.check_id, label: c.label, required: c.required ?? true })),
      integration_checks_source: src.source,
      integration_checks_revision: src.revision,
      integration_checks_blocked_reason: src.blocked_reason,
      // 成员一个都没进 canonical 对象表 ⇒ 如实「未映射」，不空集判绿（§4.2）
      ...(children.length === 0 ? { unmapped: true } : {}),
    });
  }
  return out;
}

// ═══════════════════════ ③ canonical 投影 → 上屏读数（只读适配，不判定） ═══════════════════════

/** canonical `StatusProjection` 中本文件要读的字段子集（结构化，避免 UI 侧拖入服务端值依赖） */
export interface CanonicalScopeProjection {
  object_id: string;
  display_status: DisplayStatusKey | null;
  display_status_label?: string | null;
  mapping: "mapped" | "unmapped";
  reasons?: readonly { code: string; text: string }[];
  missing?: readonly { check_id: string; label: string; why: string }[];
  required_count?: number;
  passed_count?: number;
  missing_count?: number;
}

export interface ScopeReadout {
  scope_id: string;
  /** 本读口**有没有**拿到该范围的 canonical 义务层投影：false = 未接入/旧客户端，按未知处理 */
  available: boolean;
  mapping: "mapped" | "unmapped" | null;
  /** canonical 主状态；null = 不着完成色（未映射/未知） */
  display: DisplayStatusKey | null;
  basis: string;
  /** 逐条缺口（canonical `missing` 原样摘录，不另算） */
  gaps: string[];
  member_ids: string[];
  scope_revision: string;
}

/**
 * canonical 投影 → 上屏读数（**只读适配**）：状态原样取 `display_status`，口径句取 canonical `reasons`，
 * 缺口取 canonical `missing`。**不判绿、不封顶、不重排优先级**。
 *
 * `p` 为 null ⇒ `available:false`、`display:null`：本读口没有该范围的 canonical 投影
 * （旧客户端/尚未接入），**按未知处理，绝不退回本地汇总造绿**（B5 复审口径）。
 */
export function scopeReadoutOf(
  p: CanonicalScopeProjection | null | undefined,
  ledger: ScopeLedger | undefined,
): ScopeReadout {
  const member_ids = ledger?.member_ids ?? [];
  const scope_revision = ledger?.scope_revision ?? "";
  if (p === null || p === undefined) {
    return {
      scope_id: ledger?.scope_id ?? "",
      available: false,
      mapping: null,
      display: null,
      basis:
        "本读口没有该范围的 canonical 义务层投影（deriveObligations/projectStatuses）：按**未知**处理——" +
        "不退回本地按成员汇总造绿（§2.6「一个事实、一次派生」；unsupported/unknown）",
      gaps: [],
      member_ids,
      scope_revision,
    };
  }
  const gaps = (p.missing ?? []).map((m) => `${m.label}：${m.why}`);
  if (p.mapping === "unmapped" && gaps.length === 0) gaps.push("未映射：没有任务/验收映射，不空集判绿（§4.2）");
  const reasonText = (p.reasons ?? []).map((r) => r.text).join("；");
  const basis =
    `范围主状态取自唯一义务层 canonical 投影（对象 ${p.object_id}）：` +
    `${p.display_status_label ?? p.display_status ?? "未映射/未知"}` +
    (reasonText === "" ? "" : `——${reasonText}`) +
    (p.required_count === undefined ? "" : `（必需 ${p.passed_count ?? 0}/${p.required_count} 通过，缺 ${p.missing_count ?? gaps.length}）`);
  return {
    scope_id: p.object_id,
    available: true,
    mapping: p.mapping,
    display: p.display_status,
    basis,
    gaps,
    member_ids,
    scope_revision,
  };
}

/** 优先级比较（§4.2 顺序）：纯比较函数，供模块层等既有汇总复用；**不判范围状态** */
export const worseDisplayStatus = (a: DisplayStatusKey, b: DisplayStatusKey): DisplayStatusKey =>
  (DISPLAY_STATUS_KEYS as readonly string[]).indexOf(a) <= (DISPLAY_STATUS_KEYS as readonly string[]).indexOf(b) ? a : b;

/** 只读口径句（上屏 / 读口 / 验证脚本共用，不各写一套） */
export const SCOPE_LEDGER_NOTE =
  "成员账目 = 声明归属（design_interface／task_design_ref）＋ 实测二级派生（observed implementation_map 经 " +
  "task_design_ref）；同一 scope_id＋scope_revision 下六图共用同一份账目与同一主状态，只改布局不改结论";

export const SCOPE_STATUS_RULE_NOTE =
  "范围主状态**只在唯一义务层**（deriveObligations/projectStatuses）判定：失败集成 ⇒ blocked（不是橙封顶）、" +
  "缺必需输入 ⇒ unknown/missing、成员全绿但缺自身集成检查证据 ⇒ 不给绿；六图只作只读适配" +
  "（本层不另写绿公式；§2.6／§4.2）";
