// V06-05：规划图的**程序侧结构校验**（PLAN.md V06-05，DESIGN.md §4.1 / §4.2 / §4.5）。
//
// 为什么单独一个文件、而不是让生成方自己说"没问题"：DESIGN §4.1 把这条划死了——
// 「结构合法不证明语义正确……新增的无出处关系标待核实，冲突项交设计角色，**不让模型自行审定自己的新架构**」。
// 所以模型只提供整理结果（节点 / 关系 / 出处），能不能发布由本文件按程序可判的规则裁定：
//   ① 基线仍有效（没有生效基线、或生成后基线换了 → 不许发布）；
//   ② ID 唯一；
//   ③ 关系端点存在（悬空端点 = 图已经烂了）；
//   ④ 任务依赖无环；
//   ⑤ 来源可定位（设计章节标题路径 / 卡号 / 静态模块 id），且版本哈希对得上（失效来源点名）；
//   ⑥ 覆盖完整性与上限（总数必须与真实输入一致，缺报"被省略了多少"不许发布）；
//   ⑦ 完成色 / 进度字段泄漏（§4.2：模型不能写颜色当作进度）。
//
// 两类结论：
//   · blocking —— 一条都不许发布（保留上次有效图，原因带出）；
//   · review   —— 照常发布，但如实带出，并按 §4.5 指定**谁来处理**：
//                 无出处关系标待核实；代码存在却无规划关联 → 交设计角色核实（程序不自行删代码、不补造需求）。
// 本文件是**纯函数 + 零 IO**：输入是已经算好的 Blueprint 与上下文，不读盘、不调模型，
// 因此验证脚本可以用手写的不合法 Blueprint 逐条钉住每个判据（不需要构造坏文件）。
import type {
  Blueprint,
  BlueprintCoverageSide,
  BlueprintEdge,
  BlueprintNode,
  BlueprintSourceRef,
} from "./blueprint";
import { isAppendixScopedSection } from "./blueprint";

/** 校验用的上限（与生成侧同一份数值，由调用方从 blueprint.ts 带过来，本文件不另定数值） */
export interface BlueprintLimits {
  max_nodes: number;
  max_edges: number;
}

/** 校验上下文：真实输入长什么样（蓝图必须与它对得上，对不上就是"覆盖不实"） */
export interface BlueprintContext {
  /** 当前生效基线的 id（null = 项目还没有生效基线） */
  active_baseline_id: string | null;
  design: {
    /** 项目根内相对路径 */
    path: string;
    content_sha256: string;
    sections: { path: string; sha256: string }[];
  } | null;
  plan: {
    path: string;
    /** 整份施工图**定义哈希**（§2.9）；2026-09-27 起只用来识别"legacy 整份引用"，
     *  不再是 plan_task 来源的比对基准（基准换成 `task_hashes` 里的单卡哈希）。 */
    definition_sha256: string;
    task_ids: string[];
    /** 卡号 → 该卡**单卡定义哈希**（`shared/planCardHash.ts#taskDefinitionHash`；plan_task 来源的比对基准） */
    task_hashes: Record<string, string>;
  } | null;
  code: {
    /** 静态解析层现有的模块（modules.json；未解析过就是空数组） */
    modules: { id: string; path: string }[];
  };
  limits: BlueprintLimits;
}

export type BlueprintBlockingCode =
  | "baseline_missing"
  | "baseline_changed"
  | "duplicate_id"
  | "dangling_endpoint"
  | "task_dependency_cycle"
  | "source_unlocatable"
  | "source_hash_stale"
  | "coverage_inconsistent"
  | "limit_exceeded"
  | "omission_unreported"
  | "status_field_leak"
  | "capability_class_table_broken";

export type BlueprintReviewCode =
  | "unverified_relation"
  | "unsourced_node"
  | "code_not_in_plan"
  | "code_ref_missing"
  | "plan_not_in_code"
  | "related_id_missing";

/** 谁该接手这条问题（§4.5：程序不自行删代码/补造需求） */
export type BlueprintHandoff = "design_role" | "executor_role" | "user" | null;

export interface BlueprintFinding {
  code: BlueprintBlockingCode | BlueprintReviewCode;
  severity: "blocking" | "review";
  /** 点名的对象 id（空数组 = 与具体对象无关） */
  ids: string[];
  /** 一行可读说明 */
  detail: string;
  /** 建议接手方（review 项按 §4.5 指定；blocking 项为 null = 生成/程序自己修） */
  handoff: BlueprintHandoff;
}

export interface BlueprintValidation {
  /** 无 blocking 问题（可发布的前提之一） */
  ok: boolean;
  /** 无 blocking 且没有未处理的基线冲突 → 可以发布派生图 */
  publishable: boolean;
  blocking: BlueprintFinding[];
  review: BlueprintFinding[];
  counts: {
    nodes: number;
    edges: number;
    duplicate_ids: number;
    dangling_endpoints: number;
    cycles: number;
    unlocatable_refs: number;
    stale_refs: number;
  };
}

/**
 * 完成色 / 进度一类字段名（§4.2「界面不提供人工涂色入口，模型也不能写颜色当作进度」）。
 * 出现即判 blocking：模型整理结果过一遍 sanitizeModelProposal 早该被摘掉，这里是不许发布的兜底。
 */
export const STATUS_FORBIDDEN_KEYS: readonly string[] = [
  "status",
  "state",
  "color",
  "colour",
  "status_color",
  "progress_color",
  "progress",
  "percent",
  "percentage",
  "percent_done",
  "done",
  "completed",
  "completion",
  "finished",
  "finish",
  "task_status",
  "completion_status",
];

/** 对象里有没有完成色/进度字段（只在运行期判；类型层面本就不该有） */
export function forbiddenStatusKeysIn(value: unknown, path = "$"): string[] {
  const hits: string[] = [];
  const walk = (v: unknown, p: string): void => {
    if (v === null || typeof v !== "object") return;
    if (Array.isArray(v)) {
      v.forEach((item, i) => walk(item, `${p}[${i}]`));
      return;
    }
    for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
      if (STATUS_FORBIDDEN_KEYS.includes(k)) hits.push(`${p}.${k}`);
      walk(child, `${p}.${k}`);
    }
  };
  walk(value, path);
  return hits;
}

// ── 来源引用 ──

// ── 规划 ↔ 代码的稳定关联 ──

/** 规划对象与实测代码模块之间的关联视图（生成侧、对账侧、校验侧共用同一口径） */
export interface CodeLinkage {
  /** 代码模块专属节点 id（出处**全部**是 code_module 且有至少一条）：由生成侧按模块 id 造出 */
  code_node_ids: ReadonlySet<string>;
  /** 代码模块节点 id → 静态模块 id */
  code_node_modules: ReadonlyMap<string, string>;
  /** **已建立关联**的模块 id：有一条关系把它与非代码节点连起来，或非代码节点上引用了它 */
  linked_module_ids: ReadonlySet<string>;
}

/**
 * 算出"哪些代码模块真的与规划对象建立了关联"（DESIGN §4.1「实际映射用稳定关系连接，
 * 不能把目录名相同当作已完成」）。
 *
 * 判据只有两条，都不看名字：
 *   ① 非代码节点（能力/模块/任务/概念）的出处里出现了该模块 id；
 *   ② 一条关系把它与非代码节点连起来（方向不限：施工图文件责任给的是任务→模块）。
 * 只有代码节点自己引用了自己**不算**关联——否则每个模块天生就"已映射"，§4.5 的"待归属"永远为空。
 */
export function codeLinkageOf(bp: { nodes: BlueprintNode[]; edges: BlueprintEdge[] }): CodeLinkage {
  const code_node_modules = new Map<string, string>();
  for (const n of bp.nodes) {
    if (n.source_refs.length > 0 && n.source_refs.every((r) => r.kind === "code_module")) {
      code_node_modules.set(n.id, n.source_refs[0].locator);
    }
  }
  const linked = new Set<string>();
  for (const n of bp.nodes) {
    if (code_node_modules.has(n.id)) continue;
    for (const r of n.source_refs) if (r.kind === "code_module") linked.add(r.locator);
  }
  for (const e of bp.edges) {
    const fromCode = code_node_modules.get(e.source);
    const toCode = code_node_modules.get(e.target);
    if (fromCode !== undefined && toCode === undefined) linked.add(fromCode);
    if (toCode !== undefined && fromCode === undefined) linked.add(toCode);
  }
  return { code_node_ids: new Set(code_node_modules.keys()), code_node_modules, linked_module_ids: linked };
}

/** 一条来源引用能不能定位（kind 各自的定位口径见 BlueprintSourceRef 注释）。
 *  V09-13：**导出**给来源与证据标注复用（`archProvenanceModelOf`）——来源复算只有这一处实现，
 *  标注层不另写一套"来源还在不在"的判断。 */
export function sourceRefLocateOf(
  ref: BlueprintSourceRef,
  ctx: BlueprintContext,
): { located: boolean; stale: boolean; note?: string } {
  if (ref.kind === "design_section") {
    if (ctx.design === null) return { located: false, stale: false };
    if (ref.path !== ctx.design.path) return { located: false, stale: false };
    const sec = ctx.design.sections.find((s) => s.path === ref.locator);
    if (sec === undefined) return { located: false, stale: false };
    return { located: true, stale: ref.sha256 !== null && ref.sha256 !== sec.sha256 };
  }
  if (ref.kind === "plan_task") {
    if (ctx.plan === null) return { located: false, stale: false };
    if (ref.path !== ctx.plan.path) return { located: false, stale: false };
    // 定位口径不变：卡号不在当前施工图里 = 来源消失（维持"定位不到 = 失效"的现行口径）
    if (!ctx.plan.task_ids.includes(ref.locator)) return { located: false, stale: false };
    if (ref.sha256 === null) return { located: true, stale: false };
    const cardHash = ctx.plan.task_hashes[ref.locator];
    // 拿不到本卡哈希（旧调用方没带 task_hashes）→ 不新增假阳性，按"定位到、未失效"放行
    if (cardHash === undefined) return { located: true, stale: false };
    if (ref.sha256 === cardHash) return { located: true, stale: false };
    // 2026-09-27 分段化：旧生成物里 plan_task 引用带的是**整份**定义哈希——它当然不等于单卡哈希，
    // 但也不代表来源失效。识别的唯一判据：这个旧值仍等于当前整份定义哈希。命中即按单卡口径复核
    // 通过（卡还在、整份定义也没变），不算 stale，理由带出；既不放行真正对不上的旧值，也不误杀全图。
    if (ref.sha256 === ctx.plan.definition_sha256) {
      return { located: true, stale: false, note: "legacy 整份引用，按单卡口径复核通过" };
    }
    return { located: true, stale: true };
  }
  // code_module：静态解析层才有；id 对不上 = 来源不存在（待归属，不阻断发布，见调用处）
  return { located: ctx.code.modules.some((m) => m.id === ref.locator), stale: false };
}

// ── 依赖环 ──

/**
 * 任务依赖成环检测（DFS 染色）。只吃 `task_dependency` 关系——其他关系（设计接口、实现映射）
 * 是有向无环之外的语义，不参与"施工先后"判据（DESIGN §3.2：施工依赖是可多前置的有向依赖图）。
 */
function findDependencyCycle(edges: BlueprintEdge[], nodeIds: ReadonlySet<string>): string[] | null {
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    if (e.kind !== "task_dependency") continue;
    if (!nodeIds.has(e.source) || !nodeIds.has(e.target)) continue;
    const arr = adj.get(e.source) ?? [];
    arr.push(e.target);
    adj.set(e.source, arr);
  }
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const visit = (id: string): string[] | null => {
    state.set(id, 1);
    stack.push(id);
    for (const next of adj.get(id) ?? []) {
      const s = state.get(next) ?? 0;
      if (s === 1) {
        const at = stack.indexOf(next);
        return [...stack.slice(at), next];
      }
      if (s === 0) {
        const found = visit(next);
        if (found !== null) return found;
      }
    }
    state.set(id, 2);
    stack.pop();
    return null;
  };
  for (const id of adj.keys()) {
    if ((state.get(id) ?? 0) === 0) {
      const found = visit(id);
      if (found !== null) return found;
    }
  }
  return null;
}

// ── 覆盖 ──

/** 覆盖口径自洽：mapped + unmapped 必须正好等于 total（缺报 = 拿空集冒充全覆盖） */
function coverageSideProblems(
  side: BlueprintCoverageSide,
  expectedTotal: number,
  label: string,
): string | null {
  if (side.mapped + side.unmapped.length !== side.total) {
    return `${label}：mapped(${side.mapped}) + unmapped(${side.unmapped.length}) ≠ total(${side.total})——覆盖账目自相矛盾`;
  }
  if (side.total !== expectedTotal) {
    return `${label}：total(${side.total}) ≠ 真实输入条数(${expectedTotal})——蓝图与来源对不上`;
  }
  return null;
}

// ── 主校验 ──

/**
 * 结构校验（DESIGN §4.1 六条 + §4.2 配色红线）。判据全部写在上面的小函数与下面逐条注释里，
 * 不靠"看结果像不像"；返回 blocking / review 两类，发布与否由调用方按 `publishable` 决定。
 */
export function validateBlueprint(bp: Blueprint, ctx: BlueprintContext): BlueprintValidation {
  const blocking: BlueprintFinding[] = [];
  const review: BlueprintFinding[] = [];
  const bad = (code: BlueprintBlockingCode, ids: string[], detail: string): void => {
    blocking.push({ code, severity: "blocking", ids, detail, handoff: null });
  };
  const note = (code: BlueprintReviewCode, ids: string[], detail: string, handoff: BlueprintHandoff): void => {
    review.push({ code, severity: "review", ids, detail, handoff });
  };

  // ① 基线仍有效：没有生效基线、或本图不是当前生效基线派生的，都不许发布（§2.9 / §4.1）
  if (ctx.active_baseline_id === null) {
    bad(
      "baseline_missing",
      [],
      "项目还没有生效基线（成套图纸未审定激活）：规划图只能作草稿预览，不发布（DESIGN §2.9 / §4.4）",
    );
  } else if (bp.baseline_id !== ctx.active_baseline_id) {
    bad(
      "baseline_changed",
      [],
      `生成后基线已变（本图基于 ${bp.baseline_id ?? "无基线"}，当前生效 ${ctx.active_baseline_id}）：` +
        "过时结果不得覆盖新图，需按新基线重建后再发布（DESIGN §4.1 / §4.4）",
    );
  }

  // ② ID 唯一
  const ids = new Set<string>();
  const dupes: string[] = [];
  for (const n of bp.nodes) {
    if (ids.has(n.id)) dupes.push(n.id);
    ids.add(n.id);
  }
  if (dupes.length > 0) {
    bad("duplicate_id", [...new Set(dupes)], `节点 id 重复：${[...new Set(dupes)].join("、")}（id 是图关联的身份，必须唯一）`);
  }

  // ③ 端点存在
  const dangling: string[] = [];
  for (const e of bp.edges) {
    if (!ids.has(e.source)) dangling.push(`${e.source}→${e.target}(源)`);
    if (!ids.has(e.target)) dangling.push(`${e.source}→${e.target}(靶)`);
  }
  if (dangling.length > 0) {
    bad("dangling_endpoint", dangling, `关系端点不存在：${dangling.slice(0, 8).join("、")}${dangling.length > 8 ? ` 等 ${dangling.length} 处` : ""}`);
  }

  // ④ 任务依赖无环
  const cycle = findDependencyCycle(bp.edges, ids);
  if (cycle !== null) {
    bad("task_dependency_cycle", cycle, `任务依赖成环：${cycle.join(" → ")}（§2.9：有循环依赖的基线不可激活，图也不许发布）`);
  }

  // ⑤ 来源可定位 + 失效来源点名
  const unlocatable: string[] = [];
  const stale: string[] = [];
  const codeRefMissing: string[] = [];
  const scanRefs = (owner: string, refs: BlueprintSourceRef[]): void => {
    for (const ref of refs) {
      const { located, stale: isStale } = sourceRefLocateOf(ref, ctx);
      if (!located) {
        if (ref.kind === "code_module") codeRefMissing.push(`${owner}:${ref.locator}`);
        else unlocatable.push(`${owner}:${ref.kind}/${ref.locator}`);
        continue;
      }
      if (isStale) stale.push(`${owner}:${ref.locator}`);
    }
  };
  for (const n of bp.nodes) scanRefs(`节点 ${n.id}`, n.source_refs);
  for (const e of bp.edges) scanRefs(`关系 ${e.source}→${e.target}`, e.source_refs);
  if (unlocatable.length > 0) {
    bad(
      "source_unlocatable",
      unlocatable,
      `来源定位不到（设计章节标题路径 / 卡号对不上审定材料）：${unlocatable.slice(0, 8).join("、")}` +
        `${unlocatable.length > 8 ? ` 等 ${unlocatable.length} 处` : ""}（§4.1：来源可定位是发布前提）`,
    );
  }
  if (stale.length > 0) {
    bad(
      "source_hash_stale",
      stale,
      `来源版本已失效（引用时哈希 ≠ 当前哈希）：${stale.slice(0, 8).join("、")}` +
        `${stale.length > 8 ? ` 等 ${stale.length} 处` : ""}（§4.2：版本变化触发复核，不许拿旧出处当现行）`,
    );
  }
  if (codeRefMissing.length > 0) {
    note(
      "code_ref_missing",
      codeRefMissing,
      `关系引用了解析层不存在的模块 id：${codeRefMissing.slice(0, 8).join("、")}——按"待归属"如实带出，程序不自行删代码/改设计`,
      "design_role",
    );
  }

  // ⑥ 覆盖完整性与上限
  const coverageProblems: string[] = [];
  // 设计侧基数＝非附录章节（与生成侧 `assembleBlueprint` 同一个 `isAppendixScopedSection` 判据，
  // 2026-09-25 终审返工：附录章节不产生规划对象，不计入「应覆盖」基数；两侧同基数才谈得上对账）
  const designTotal = (ctx.design?.sections ?? []).filter((s) => !isAppendixScopedSection(s)).length;
  const planTotal = ctx.plan?.task_ids.length ?? 0;
  const codeTotal = ctx.code.modules.length;
  for (const [side, total, label] of [
    [bp.coverage.design_sections, designTotal, "设计章节"],
    [bp.coverage.plan_tasks, planTotal, "施工任务"],
    [bp.coverage.code_modules, codeTotal, "代码模块"],
  ] as const) {
    const p = coverageSideProblems(side, total, label);
    if (p !== null) coverageProblems.push(p);
  }
  if (bp.coverage.nodes_kept !== bp.nodes.length) {
    coverageProblems.push(`nodes_kept(${bp.coverage.nodes_kept}) ≠ 实际节点数(${bp.nodes.length})`);
  }
  if (bp.coverage.edges_kept !== bp.edges.length) {
    coverageProblems.push(`edges_kept(${bp.coverage.edges_kept}) ≠ 实际关系数(${bp.edges.length})`);
  }
  if (coverageProblems.length > 0) {
    bad("coverage_inconsistent", [], `覆盖账目与真实输入对不上：${coverageProblems.join("；")}`);
  }
  if (bp.nodes.length > ctx.limits.max_nodes || bp.edges.length > ctx.limits.max_edges) {
    bad(
      "limit_exceeded",
      [],
      `超出规划图上限（节点 ${bp.nodes.length}/${ctx.limits.max_nodes}、关系 ${bp.edges.length}/${ctx.limits.max_edges}）：` +
        "必须在生成侧按上限聚合，而不是把超量图直接发布（§4.3 第 1 招）",
    );
  }
  // 省略范围必须如实：少收了东西就得在 omitted 里说清楚，否则等于默认宣称"这就是全部"
  const omissionKinds = new Set(bp.omitted.map((o) => o.kind));
  const mustReport: string[] = [];
  if (bp.coverage.nodes_total > bp.nodes.length && !omissionKinds.has("node_cap")) mustReport.push("node_cap");
  if (bp.coverage.edges_total > bp.edges.length && !omissionKinds.has("edge_cap")) mustReport.push("edge_cap");
  for (const side of [bp.coverage.design_sections, bp.coverage.plan_tasks, bp.coverage.code_modules]) {
    if (side.unmapped.length > 0 && !omissionKinds.has("unmapped")) mustReport.push("unmapped");
  }
  if (mustReport.length > 0) {
    bad(
      "omission_unreported",
      [...new Set(mustReport)],
      `省略范围没报（缺 omitted 条目：${[...new Set(mustReport)].join("、")}）：缺失就说缺失，不许拿空集冒充全覆盖（§4.1）`,
    );
  }

  // ⑦ 完成色/进度字段泄漏（模型不能写颜色当进度）
  const leaks = [
    ...forbiddenStatusKeysIn(bp.nodes, "nodes"),
    ...forbiddenStatusKeysIn(bp.edges, "edges"),
  ];
  if (leaks.length > 0) {
    bad("status_field_leak", leaks, `规划数据里出现完成色/进度字段：${leaks.slice(0, 6).join("、")}（§4.2：不由模型写颜色）`);
  }

  // ⑦′ 能力分类声明表（§3.2，R-1/B 类返工 2026-09-26）：表**存在但损坏**（缺章／重复矛盾／坏行／
  // 章节对不上／多表）⇒ 分类不完整或自相矛盾，绝不静默按功能能力发布——按「旧有效图/更新失败」
  // 规则阻断发布（保留上次有效图、原因带出），界面因此不给出误导性的绿色或「可请求验收」。
  const classIssues = (bp.capability_classes?.issues ?? []).filter((i) => i.blocking);
  if (classIssues.length > 0) {
    bad(
      "capability_class_table_broken",
      classIssues.map((i) => (i.chapter === null ? i.kind : `§${i.chapter}`)),
      `能力分类声明表损坏 ${classIssues.length} 项（${classIssues
        .slice(0, 6)
        .map((i) => `§${i.chapter ?? "—"} ${i.kind}`)
        .join("、")}）：分类不完整或自相矛盾，不许按功能能力静默发布（§3.2／§3.3／§4.4）`,
    );
  }

  // ── review 项（照常发布，如实带出 + 指定接手方）──
  for (const e of bp.edges) {
    if (e.certainty === "unverified" || e.source_refs.length === 0) {
      note(
        "unverified_relation",
        [`${e.source}→${e.target}`],
        `关系 ${e.source}→${e.target}（${e.kind}）没有可定位出处：标待核实，不当作已审定架构（§4.1）`,
        "design_role",
      );
    }
  }
  for (const n of bp.nodes) {
    if (n.source_refs.length === 0) {
      note("unsourced_node", [n.id], `节点 ${n.id}（${n.kind}）没有可定位出处：标待核实（§4.1）`, "design_role");
    }
  }

  // 代码存在但没有规划关联 → "待归属"（§4.5：不能仅凭"设计有、代码没有"一律报警，也不能悄悄当已覆盖）
  // 判据与生成侧同一份实现（codeLinkageOf）：只有代码节点自己引用自己**不算**关联
  const linkage = codeLinkageOf(bp);
  const orphanCode = ctx.code.modules.filter((m) => !linkage.linked_module_ids.has(m.id)).map((m) => m.id);
  if (orphanCode.length > 0) {
    note(
      "code_not_in_plan",
      orphanCode,
      `代码里有 ${orphanCode.length} 个模块没有任何规划关联（待归属）：是既有能力、遗漏设计还是偏离，由设计/执行角色核实，程序不自行删代码（§4.5）`,
      "design_role",
    );
  }
  // 规划有、代码没有 → 正常的灰色待建项，不是报警（§4.5），只标注谁去建
  const plannedNoCode = bp.nodes
    .filter((n) => n.kind === "module" || n.kind === "capability")
    .filter((n) => !n.source_refs.some((r) => r.kind === "code_module"))
    .filter((n) => !bp.edges.some((e) => (e.source === n.id || e.target === n.id) && e.source_refs.some((r) => r.kind === "code_module")))
    .map((n) => n.id);
  if (plannedNoCode.length > 0) {
    note(
      "plan_not_in_code",
      plannedNoCode,
      `${plannedNoCode.length} 个规划对象在代码里还没有对应实现（灰色待建项，不是报警）：按施工依赖推进（§4.5）`,
      "executor_role",
    );
  }
  // related_ids 指向不存在的节点
  const missingRelated: string[] = [];
  for (const n of bp.nodes) {
    for (const r of n.related_ids) if (!ids.has(r)) missingRelated.push(`${n.id}→${r}`);
  }
  if (missingRelated.length > 0) {
    note(
      "related_id_missing",
      missingRelated,
      `related_ids 指向不存在的节点：${missingRelated.slice(0, 8).join("、")}（生成侧应丢弃这类引用）`,
      null,
    );
  }

  return {
    ok: blocking.length === 0,
    publishable: blocking.length === 0,
    blocking,
    review,
    counts: {
      nodes: bp.nodes.length,
      edges: bp.edges.length,
      duplicate_ids: dupes.length,
      dangling_endpoints: dangling.length,
      cycles: cycle === null ? 0 : 1,
      unlocatable_refs: unlocatable.length,
      stale_refs: stale.length,
    },
  };
}

/** 节点/关系集合的最小可读摘要（回执与验证脚本共用，避免各自拼一套） */
export function blueprintDigestOf(nodes: BlueprintNode[], edges: BlueprintEdge[]): string {
  return `${nodes.length} 节点 / ${edges.length} 关系`;
}
