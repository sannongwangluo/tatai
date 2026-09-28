// V08-05 验证脚本（tsx 跑）：语义整理层的来源引用归一与"逐节点剔除"、横幅的如实分档。
//
// 覆盖（每条对着卡面一条）：
//   ① 归一匹配：精确命中 / 唯一包含命中（排版差异）→ 命中；**歧义**（多个候选）与**认不出** → 剔除该条；
//      `path` 指向别的源 → 剔除；改写后的 locator 用的是**真实锚点原文**。
//   ② 逐节点剔除：模型新增条目"给过出处但一条都留不下" → 连它一起剔除（坏节点出、好节点留）；
//      完全没给出处的条目照旧保留（交校验器标「待核实」）。
//   ②′ **剔除账目必须落进蓝图 omitted**（`ref_normalized`／`ref_dropped`／`model_item_dropped`，点名原文与条数）——
//      2026-09-25 缺陷修复后补的落点断言（此前三条账目是死写、任何输出里都读不到，见该段注释）。
//   ③ 校验强度不变：归一后进图的每条来源仍必须可定位（`validateBlueprint` 一个字没放宽）——
//      剔完还剩不可定位的引用时，发布照样被拒。
//   ④ 横幅三种状态：图已过期 / 图正在更新 / **V08-05 语义层降级（图内容是当前版）**，文案不许假装没事。
//
// 上界：本脚本只做纯函数与夹具断言（零模型、零写盘、不碰真实项目）。
import assert from "node:assert/strict";
import {
  blueprintContextOf,
  canonicalLocator,
  deriveBlueprint,
  mergeProposal,
  normalizeProposalRefs,
  resolveRefLocator,
  sanitizeModelProposal,
} from "../src/arch/blueprint";
import { freshnessOf } from "../src/ui/arch/projectGraph";
import { validateBlueprint } from "../src/arch/blueprintValidate";

let pass = 0;
let fail = 0;
const ok = (cond: boolean, label: string): void => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (cond) pass++;
  else {
    fail++;
    process.exitCode = 1;
  }
};
const info = (m: string): void => console.log(`[verify]   ${m}`);

const SECTIONS = [
  "夹具设计书 v0.1 / 1. 概述",
  "夹具设计书 v0.1 / 1. 概述 / 1.1 目标",
  "夹具设计书 v0.1 / 2. 模块划分",
  "夹具设计书 v0.1 / 10. 开源策略",
];
const TASKS = ["T-1", "T-2"];
const MODULES = [
  { id: "src", path: "src" },
  { id: "docs", path: "docs" },
];
const src = {
  project_id: "fx",
  project_root: "/tmp/fx",
  design: {
    path: "DESIGN.md",
    content_sha256: "d".repeat(64),
    definition_sha256: "d".repeat(64),
    sections: SECTIONS.map((p, i) => ({ level: 2, title: p, path: p, line_start: i + 1, line_end: i + 2, sha256: `s${i}` })),
  },
  plan: {
    path: "PLAN.md",
    content_sha256: "p".repeat(64),
    definition_sha256: "p".repeat(64),
    tasks: TASKS.map((id) => ({ task_id: id, goal: id, dependency_ids: [], design_refs: [], allowed_paths: [], evidence_requirement: null, deliverables: null })),
  },
  declared_modules: [],
  code: { modules: MODULES },
  names: {},
} as never;

const proposal = (nodes: unknown[], edges: unknown[] = []): any => sanitizeModelProposal({ nodes, edges }).proposal;
const ref = (kind: string, locator: string, path: string): any => ({ kind, locator, path });

// ═════════════════════════ ① 归一匹配 ═════════════════════════
console.log("[verify] ═══ ① 来源引用归一：只认精确/唯一包含，歧义与认不出都剔除 ═══");
ok(
  canonicalLocator("  夹具设计书 v0.1  ›  10. 开源策略 ") === "夹具设计书 v0.1 / 10. 开源策略" &&
    canonicalLocator("夹具设计书 v0.1 / 2. 模块划分") === "夹具设计书 v0.1 / 2. 模块划分",
  "排版归一：层级分隔符（›/＞/→/·/|）统一成 ` / `、连续空白折叠、引号去掉——**不改字、不补字**",
);
ok(
  resolveRefLocator("夹具设计书 v0.1 / 2. 模块划分", SECTIONS) === "夹具设计书 v0.1 / 2. 模块划分",
  "精确命中：直接返回**真实锚点原文**",
);
ok(
  resolveRefLocator("夹具设计书 v0.1 › 10. 开源策略", SECTIONS) === "夹具设计书 v0.1 / 10. 开源策略" &&
    resolveRefLocator("10. 开源策略", SECTIONS) === "夹具设计书 v0.1 / 10. 开源策略",
  "排版差异与**唯一包含**命中（用真标题里的唯一片段）→ 归一到真标题",
);
ok(
  resolveRefLocator("1. 概述", SECTIONS) === null,
  "歧义（`1. 概述` 同时命中两个候选）→ **返回 null**，不猜一个",
);
ok(
  resolveRefLocator("塔台（Tata策略", SECTIONS) === null && resolveRefLocator("", SECTIONS) === null,
  "认不出（编造/截断的标题）→ null（不进图）",
);
{
  const p = proposal([
    { id: "plan:cap:10", kind: "capability", name: "开源策略", source_refs: [ref("design_section", "夹具设计书 v0.1 › 10. 开源策略", "DESIGN.md")] },
    { id: "plan:mod:src", kind: "module", name: "源码", source_refs: [ref("code_module", "src", "src")] },
  ]);
  const norm = normalizeProposalRefs(p, src);
  ok(
    norm.normalized === 1 && norm.dropped.length === 0 &&
      norm.proposal.nodes[0].source_refs[0].locator === "夹具设计书 v0.1 / 10. 开源策略",
    `排版差异被归一到真标题（normalized=${norm.normalized}，locator=${norm.proposal.nodes[0].source_refs[0].locator}）`,
  );
}
{
  const bad = "塔台（Tata策略";
  const p = proposal([
    { id: "plan:cap:10", kind: "capability", name: "开源策略", source_refs: [ref("design_section", bad, "DESIGN.md")] },
  ]);
  const norm = normalizeProposalRefs(p, src);
  ok(
    norm.dropped.length === 1 && norm.dropped_nodes === 1 && norm.proposal.nodes.length === 0,
    `认不出的出处被剔除，且"给过出处但一条都没留下"的模型节点**整体剔除**（dropped=${norm.dropped.length}、节点 ${norm.proposal.nodes.length} 个）`,
  );
  info(`  剔除原因：${norm.dropped[0].why}`);
}

// ═════════════════════════ ② 逐节点剔除（坏节点出、好节点留） ═════════════════════════
console.log("[verify] ═══ ② 逐条剔除：坏条目出、同轮其余条目留 ═══");
{
  const p = proposal(
    [
      { id: "plan:cap:10", kind: "capability", name: "坏节点", source_refs: [ref("design_section", "塔台（Tata策略", "DESIGN.md")] },
      { id: "plan:cap:02", kind: "capability", name: "好节点", source_refs: [ref("design_section", "夹具设计书 v0.1 / 2. 模块划分", "DESIGN.md")] },
      { id: "plan:concept:unknown", kind: "concept", name: "无出处概念" },
    ],
    [
      { source: "plan:cap:10", target: "plan:cap:02", kind: "model_inference", certainty: "inferred", source_refs: [ref("design_section", "塔台（Tata策略", "DESIGN.md")] },
      { source: "plan:cap:02", target: "plan:mod:src", kind: "implementation_map", certainty: "inferred", source_refs: [ref("design_section", "夹具设计书 v0.1 / 2. 模块划分", "DESIGN.md")] },
    ],
  );
  const norm = normalizeProposalRefs(p, src);
  const ids = norm.proposal.nodes.map((n: any) => n.id);
  ok(
    !ids.includes("plan:cap:10") && ids.includes("plan:cap:02") && ids.includes("plan:concept:unknown"),
    `坏节点出（plan:cap:10）、好节点留（${ids.join("、")}）——同轮其余条目不受影响`,
  );
  ok(
    norm.dropped_nodes === 1 && norm.dropped_edges === 2 && norm.proposal.edges.length === 0,
    `端点指向被剔除节点的关系一并剔除（dropped_nodes=${norm.dropped_nodes}、dropped_edges=${norm.dropped_edges}、余 ${norm.proposal.edges.length} 条）`,
  );
  ok(
    (norm.proposal.nodes.find((n: any) => n.id === "plan:concept:unknown")?.source_refs.length ?? -1) === 0,
    "完全没给出处的条目照旧保留（交校验器标「待核实」，§4.1 既有口径不变）",
  );
}

// ═════════════════════════ ②′ 剔除账目落进图账目 ═════════════════════════
// 2026-09-25 缺陷修复留痕：
//   旧期望（旧实现）：三条归一账目往 `deriveBlueprint` 里的**外层** `omitted` 数组推，进不进图账目没人断言；
//     实测（探针 `.工作台/evidence/review-fix-20260925/v06-05-e/probe-omitted-ledger.ts`）此前**任何输出里都读不到**——
//     `assembleBlueprint` 内部一进来就 `const omitted = [...omittedIn]`（拷贝），三处 push 推的是被拷贝掉的那个数组，
//     而 `mergeProposal` 又从 `base.omitted` 起算 ⇒ 剔除是死写、图上只有覆盖账目（静默剔除）。
//   依据：`PROGRESS.md` V08-05 行「账目进 `omitted`：`ref_normalized`/`ref_dropped`/`model_item_dropped`」
//     ＋ 本次缺陷修复（`src/arch/blueprint.ts` 三处 push 改写 `blueprint.omitted`）。
//   新期望：归一与逐条剔除必须落进**蓝图自己的 `omitted`**，且账目**点名原文与条数**。
//   保留意图：坏条目不许静默消失——剔了哪一条、为什么剔，在图账目里可查（判据未放宽，只是把落点钉住）。
console.log("[verify] ═══ ②′ 归一/剔除账目必须落进蓝图 omitted（点名原文，不许静默） ═══");
{
  const bad = "塔台（Tata策略";
  const p = proposal([
    { id: "plan:cap:10", kind: "capability", name: "坏节点", source_refs: [ref("design_section", bad, "DESIGN.md")] },
    { id: "plan:cap:02", kind: "capability", name: "好节点", source_refs: [ref("design_section", "夹具设计书 v0.1 › 2. 模块划分", "DESIGN.md")] },
  ]);
  const bp = deriveBlueprint(src, {
    based_on: { model_key: "fx", full_key: "fx", design_content_sha256: "d".repeat(64), plan_definition_sha256: "p".repeat(64), semantic: false },
    proposal: p,
    model_receipt: null,
  });
  const dropped = bp.omitted.find((o) => o.kind === "ref_dropped");
  const itemDropped = bp.omitted.find((o) => o.kind === "model_item_dropped");
  const normalized = bp.omitted.find((o) => o.kind === "ref_normalized");
  ok(
    dropped !== undefined && dropped.count === 1 && dropped.detail.includes(bad) && dropped.detail.includes("plan:cap:10"),
    `逐条剔除账目落进图账目并**点名原文与主体**（${dropped?.detail.slice(0, 72) ?? "（缺）"}…）`,
  );
  ok(
    itemDropped !== undefined && itemDropped.count >= 1 && itemDropped.detail.includes("剔除"),
    `被剔除的模型条目**也记了账**（omitted = ${bp.omitted.map((o) => o.kind).join("/")}）`,
  );
  ok(
    normalized !== undefined && normalized.count === 1,
    `排版归一的那条同样记账（ref_normalized count=${normalized?.count ?? "（缺）"}）`,
  );
  ok(
    !bp.nodes.some((n) => n.id === "plan:cap:10") && bp.nodes.some((n) => n.id === "plan:cap:02"),
    "坏条目不在图上、同轮好条目照常进图（账目与图面一致，不是只写账不剔除）",
  );
}

// ═════════════════════════ ③ 校验强度不变 ═════════════════════════
// 2026-09-26 定向更新（R-2/B 类返工，非作者复审 independent-v0918-review-20260926 §七 R-2）——五要素留档：
//   旧期望（旧实现）：`mergeProposal` 把提案给**既有节点**补的 `source_refs` 直接并入节点账，
//     于是"不经归一就把坏引用塞进合并 ⇒ 校验报 source_unlocatable"这条反证成立（该断言原来就靠这条通道）。
//   依据：审计 probe2 P2 实测（`probes/probe2-leads-boundary.ts`）——提案 refs 直入既有节点 ⇒ 可把正式对象
//     打成 invalidated、阻断交付读数（方向＝变红），违反 §4.1「待审线索不参加交付读数」的字面边界。
//   新期望：提案**节点侧**（自报新节点 / 给既有节点补的出处）与提案边同款只留在待审线索层
//     （`model_node_leads`）：坏引用**根本进不了图**（比"进图后被拒"更强），因此本段反证改为
//     ①结构性断言「坏提案引用不出现在 bp.nodes/bp.edges，只出现在 model_node_leads」＋
//     ②校验器强度**另立反证**：手工构造一份带不可定位设计引用的蓝图，`validateBlueprint` 照样报
//       source_unlocatable 且 publishable=false（判据一个字没放宽）。
//   保留意图：模型的自报出处永远不许变成"进图的来源"；校验器对进图的来源仍必须可定位。
//   判据不放宽：只是把这一段的通道从"合并时注入"改成"结构性不可注入"，并补一条不经提案通道的强度反证。
console.log("[verify] ═══ ③ §4.1 强度不变：进图的每条来源仍必须可定位 ═══");
{
  const base = deriveBlueprint(src, {
    based_on: { model_key: "fx", full_key: "fx", design_content_sha256: "d".repeat(64), plan_definition_sha256: "p".repeat(64), semantic: false },
    proposal: null,
    model_receipt: null,
  });
  const ctx = blueprintContextOf(src);
  const clean = proposal([{ id: "plan:cap:10", kind: "capability", name: "开源策略", source_refs: [ref("design_section", "夹具设计书 v0.1 › 10. 开源策略", "DESIGN.md")] }]);
  const normClean = normalizeProposalRefs(clean, src);
  ok(
    validateBlueprint(mergeProposal(base, normClean.proposal), ctx).blocking.length === 0,
    "归一后的提案能过校验（原有校验器一个字没改）",
  );
  // 反证①（R-2）：不经归一直接把坏引用塞进合并——坏引用**不进图**（结构性挡在待审线索层）
  const bad = "塔台（Tata策略";
  const dirty = proposal([{ id: "plan:cap:10", kind: "capability", name: "开源策略", source_refs: [ref("design_section", bad, "DESIGN.md")] }]);
  const dirtyMerged = mergeProposal(base, dirty);
  const inGraphRefs = [...dirtyMerged.nodes, ...dirtyMerged.edges].flatMap((x: any) =>
    (x.source_refs ?? []).map((r: any) => `${r.kind}/${r.locator}`),
  );
  const leadRefs = (dirtyMerged.model_node_leads ?? []).flatMap((l: any) => l.proposed_source_refs.map((r: any) => `${r.kind}/${r.locator}`));
  ok(
    !inGraphRefs.some((l: string) => l.includes(bad)) &&
      leadRefs.some((l: string) => l.includes(bad)) &&
      dirtyMerged.nodes.length === base.nodes.length,
    "反证①（R-2）：模型给的坏出处**进不了正式图**（节点集与出处逐字不变），只在 `model_node_leads` 里留痕——通道从源头上关掉，比「进图后被拒」更强",
  );
  // 反证②（校验强度）：手工构造带不可定位设计引用的蓝图 ⇒ 校验照样拒（不经提案通道，强度未被"顺手放松"）
  const handBuilt = {
    ...base,
    nodes: base.nodes.map((n) =>
      n.id === base.nodes[0].id ? { ...n, source_refs: [{ kind: "design_section" as const, path: "DESIGN.md", locator: bad, sha256: null }] } : n,
    ),
  };
  const verdict = validateBlueprint(handBuilt, ctx);
  ok(
    verdict.blocking.some((f: any) => f.code === "source_unlocatable") && verdict.publishable === false,
    "反证②：进图的来源只要有不可定位的引用**照样被拒**（source_unlocatable，不可发布）——判据未放宽",
  );
  // 归一后的图里没有不可定位的引用；正式节点集不因提案而变
  const settled = mergeProposal(base, normClean.proposal);
  const locators = settled.nodes.flatMap((n: any) => n.source_refs.map((r: any) => `${r.kind}/${r.locator}`));
  ok(
    locators.every((l: string) => !l.includes(bad)) && settled.nodes.length === base.nodes.length,
    `进图的来源里没有编造标题（现有 ${locators.length} 条引用全部可定位）且正式节点集与派生结果一致（${settled.nodes.length} 个，提案不增节点）`,
  );
}

// ═════════════════════════ ④ 横幅三种状态 ═════════════════════════
console.log("[verify] ═══ ④ 横幅：图已过期 / 图正在更新 / 语义层降级（如实） ═══");
const blueprint = {
  baseline_id: "bl-fx",
  generated_at: "2026-09-23T10:00:00+08:00",
  based_on: { design_content_sha256: "d".repeat(64), full_key: "k1" },
} as never;
const receipt = { attempted_at: "2026-09-23T11:00:00+08:00", cache_key: "k2", published: false, kept_previous: true };
const revisions = { design: "d".repeat(64), plan: "p".repeat(64) };
const baseline = { baseline_id: "bl-fx", design_revision: "d".repeat(64), plan_revision: "p".repeat(64) };
ok(
  freshnessOf({ blueprint, receipt: null, revisions, baseline }).state === "fresh",
  "① 三处一致 + 没有更晚的尝试 → `fresh`（无横幅）",
);
{
  const r = freshnessOf({ blueprint, receipt, revisions: { ...revisions, design: "x".repeat(64) }, baseline });
  ok(
    r.state === "stale" && r.banners[0].startsWith("图已过期") && r.keep_last_valid,
    "② 源变了、图没重画 → `图已过期`（继续显示上次有效图）",
  );
}
{
  const r = freshnessOf({ blueprint, receipt, revisions, baseline, semantic: { semantic_complete: true, scopes: [{ scope: "design", state: "tidied" }] } });
  ok(
    r.state === "updating" && r.banners[0].startsWith("图正在更新") && !r.banners.some((b) => b.includes("语义整理层")),
    "③ 语义层正常、只有更晚的一次非语义尝试没发布 → `图正在更新`（原口径不变）",
  );
}
{
  const semantic = {
    phase: "degraded",
    outcome: "degraded_partial",
    semantic_complete: false,
    missing: [{ scope: "design", reason: "整理结果未通过程序校验，未采用：source_unlocatable：来源定位不到" }],
    scopes: [
      { scope: "design", state: "failed", error: "source_unlocatable" },
      { scope: "plan", state: "failed", error: "source_unlocatable" },
    ],
  };
  const r = freshnessOf({ blueprint, receipt, revisions, baseline, semantic });
  ok(
    r.state === "updating" &&
      r.banners.length === 1 &&
      r.banners[0].includes("图内容是**当前版**") &&
      r.banners[0].includes("语义整理层") &&
      r.banners[0].includes("下次重试") &&
      !r.banners[0].startsWith("图正在更新"),
    `④ 图是当前版 + 语义层降级 → 只出**如实降级**那句（不再是"图正在更新"）：${r.banners[0].slice(0, 60)}…`,
  );
  info(`  降级文案：${r.banners[0]}`);
}
ok(
  freshnessOf({ blueprint, receipt: null, revisions, baseline, semantic: { semantic_complete: true, scopes: [{ scope: "design", state: "tidied" }] } }).state === "fresh",
  "⑤ 语义层已 tidied 且没有更晚尝试 → `fresh`（横幅消失）",
);

assert.ok(true);
console.log(`\n[verify] 汇总：${pass} PASS / ${fail} FAIL`);
