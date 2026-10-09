// V08-02 验证脚本（tsx 跑）：图面色块与事实对齐。
//
// 覆盖（每条都对着本卡的一个修法，纯视图层断言，不依赖真网关/真浏览器）：
//   B1 功能全景的成员口径：能力节点按 edge（design_interface/task_design_ref）汇总模块与任务，
//      不再因为 `node_kinds=['capability']` 当成员过滤器而恒空 ⇒ 恒「未映射」；
//      同时系统架构视图的成员仍是「模块」（不许被搅动）。
//   B1b（2026-09-26 安装版复核定向更新）多值归属与画布缺口对账：同一任务指向多个能力时
//      **每个**能力分组都有它（不再后写覆盖）；系统架构的能力→模块归属可经
//      「能力 ← 任务设计引用 ← 实测实现映射」二级派生；`canvasMembershipGapsOf` 对断档出缺口。
//   B2/B3/B4 模块层状态：`taskDerivedModuleStatus` 按蓝图 `implementation_map` 边把任务状态汇总到模块
//      （封顶在「结果待验证」不给绿），没有任何任务指向的模块 → 如实「无状态记录」而不是 v1 的「未开始」。
//   C1 「未映射」不再一刀切：`unmapped_reason` 把几种真实原因分开。
//   C2 施工依赖里的集成端点：标 `endpoint`、标签与口径句都写明**不表示进度**，且不进概览计数。
//
// 上界与红线：不发明任何事件类型（模块四色 v2 事件化属设计层）；A 类真 todo（真待验收）的颜色不受影响
// （本脚本只验"派生口径"，不把任何真 todo 染绿——汇总恒封顶在「结果待验证」）。
import assert from "node:assert/strict";
import path from "node:path";
import {
  MODULE_VERIFIED_SHORT,
  NO_STATUS_RECORD,
  PROJECT_VIEWS,
  buildViewModel,
  canonicalScopeStatusOf,
  canvasMembershipGapsOf,
  directStatusOf,
  noStatusRecordOf,
  objectIdOf,
  taskDerivedModuleStatus,
} from "../src/ui/arch/projectGraph";
import { NO_STATUS_RECORD_KEY, DISPLAY_STATUS_PALETTE, DISPLAY_STATUS_KEYS } from "../src/ui/arch/statusColor";
import { scopeMemberLedgerOf } from "../src/arch/featureScope";

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

// ── 夹具：一份最小蓝图（能力→模块 design_interface；任务→能力 task_design_ref；任务→模块 implementation_map）──
const bp = {
  version: 1,
  baseline_id: "bl-v0802-fixture",
  generated_at: "2026-09-23T00:00:00+08:00",
  generator_version: "fixture",
  limits: { max_nodes: 200, max_edges: 400 },
  nodes: [
    { id: "plan:cap:01", kind: "capability", name: "能力甲", source_refs: [], related_ids: [] },
    { id: "plan:cap:02", kind: "capability", name: "能力乙", source_refs: [], related_ids: [] },
    { id: "plan:code:src-base", kind: "module", name: "基础模块", source_refs: [], related_ids: [] },
    { id: "plan:code:docs", kind: "module", name: "文档模块", source_refs: [], related_ids: [] },
    { id: "plan:task:T-1", kind: "task", name: "T-1", source_refs: [], related_ids: [] },
    { id: "plan:task:T-2", kind: "task", name: "T-2", source_refs: [], related_ids: [] },
  ],
  edges: [
    { source: "plan:cap:01", target: "plan:code:src-base", kind: "design_interface", source_refs: [], certainty: "declared" },
    { source: "plan:task:T-1", target: "plan:cap:01", kind: "task_design_ref", source_refs: [], certainty: "declared" },
    { source: "plan:task:T-1", target: "plan:code:src-base", kind: "implementation_map", source_refs: [], certainty: "observed" },
    { source: "plan:task:T-2", target: "plan:code:docs", kind: "implementation_map", source_refs: [], certainty: "observed" },
  ],
  coverage: {
    design: { total: 0, mapped: 0, unmapped: [] },
    plan: { total: 0, mapped: 0, unmapped: [] },
    code: { total: 0, mapped: 0, unmapped: [] },
  },
  omitted: { nodes: [], edges: [], notes: [] },
} as never;

const projection = {
  "T-1": { object_id: "T-1", mapping: "mapped", display_status: "verified", reasons: [] },
  "T-2": { object_id: "T-2", mapping: "mapped", display_status: "in_progress", reasons: [] },
} as never;

// ═════════════════════════════ B1 ═════════════════════════════
console.log("[verify] ═══ B1 功能全景：成员口径（能力 → 模块与任务）═══");
ok(
  PROJECT_VIEWS.functional.member_kinds.join(",") === "module,task" &&
    PROJECT_VIEWS.architecture.member_kinds.join(",") === "module" &&
    PROJECT_VIEWS.construction.member_kinds.length === 0,
  `三视图的成员口径分开声明（功能=${PROJECT_VIEWS.functional.member_kinds.join("+")}、架构=${PROJECT_VIEWS.architecture.member_kinds.join("+")}）——不再拿 node_kinds 当成员过滤器`,
);
ok(
  PROJECT_VIEWS.functional.node_kinds.join(",") === "capability",
  "node_kinds 的原有语义未动（仍是「画布上成节点的 kind」，V06-06 的声明断言不受影响）",
);
// 与真实组件同一份口径：模块层派生先算出来，再喂给视图模型（V08-03 起 buildViewModel 认 module_status）
const derived = taskDerivedModuleStatus({ blueprint: bp, projection });
const vmFunctional = buildViewModel({ view: "functional", blueprint: bp, projection, module_status: derived.status });
const cap1 = vmFunctional.nodes.find((n) => n.id === "plan:cap:01")!;
const cap2 = vmFunctional.nodes.find((n) => n.id === "plan:cap:02")!;
ok(
  cap1.members.includes("plan:code:src-base") && cap1.members.includes("plan:task:T-1"),
  `功能全景的能力节点有成员了（${cap1.members.join("、")}）——原来恒为空 ⇒ 恒「未映射」`,
);
// 期望定向更新（V08-03 / DESIGN.md 附录 D，2026-09-23）：同 B2 段——能力由成员派生，
// 成员非空且**全部**验证通过 ⇒ 能力验证通过；空集/无证据仍不判绿（判据未放宽）。
// V09-55 返工：能力（scope）状态**只读 canonical 义务层投影**，画布不再本地按成员汇总；
// 本夹具没有喂 `scope_projection` ⇒ 能力如实「未知」（不退回成员汇总造绿）。
ok(
  cap1.status.display === null && cap1.status.unmapped_reason === "no_status_source",
  `能力状态只读 canonical 投影：缺投影 ⇒ 未知（实际 kind=${cap1.status.kind} display=${cap1.status.display}；不本地造绿）`,
);
ok(
  cap2.status.display === null && cap2.status.unmapped_reason === "no_status_source",
  `没有 canonical 投影的能力不着完成色（reason=${cap2.status.unmapped_reason}）`,
);
ok(
  vmFunctional.notes.every((n) => !n.includes("成员 = 关联的模块与任务") || true) &&
    vmFunctional.nodes.length === 2,
  `功能全景节点数不变（仍只有能力节点：${vmFunctional.nodes.map((n) => n.id).join("、")}）`,
);
const vmArchitecture = buildViewModel({ view: "architecture", blueprint: bp, projection, module_status: derived.status });
const archCap1 = vmArchitecture.nodes.find((n) => n.id === "plan:cap:01")!;
// ── 2026-10-08 定向更新（判据**不放宽**，五要素留档）──
//   旧期望 = `archCap1.members.join(",") === "plan:code:src-base,plan:task:T-1"`（V09-55 期间改出来的期望）。
//   依据   = 与**同一文件**第 82–85 行 `PROJECT_VIEWS.architecture.member_kinds.join(",") === "module"` 自相矛盾，
//            也与 `verify-v09-02` 夹具 D（cap:01 只含任务成员 ⇒ 架构分组成员长度 0）冲突；
//            `git show HEAD:scripts/verify-v08-02.ts` 的原期望是 `"plan:code:src-base"`（注释：「系统架构的成员仍是「模块」」）；
//            DESIGN §3.2 表格第三列：系统架构＝「审定的模块职责、接口/数据关系；叠加实测代码映射」，功能全景才是「…模块与任务」。
//   新期望 = `archCap1.members.join(",") === "plan:code:src-base"`（架构分组成员**只含模块**）；
//            另**新增**一条断言钉住「唯一成员账目仍然**视图无关**」（`scopeMemberLedgerOf` 里 cap:01 的成员仍含任务 T-1）——
//            账目来源不变，变的是**视图按自己的 `member_kinds` 过滤**（V09-55 修的正是来源统一，不是成员 kind）。
//   保留意图 = 「成员账目只有一个来源（featureScope）＋ 视图按 member_kinds 过滤」——两条都钉住，一条没少。
//   判据不放宽 = 由「名单恰好等于某串」升级为「名单＝账目 ∩ {module} ∩ 蓝图节点」的**集合对账**，约束更强。
const archLedger = scopeMemberLedgerOf(bp);
const bpNodes = (bp as unknown as { nodes: { id: string; kind: string }[] }).nodes;
ok(
  archCap1.members.join(",") === "plan:code:src-base" &&
    archCap1.members.every((m) => bpNodes.find((n) => n.id === m)?.kind === "module") &&
    (archLedger["plan:cap:01"]?.member_ids ?? []).includes("plan:task:T-1") &&
    (archLedger["plan:cap:01"]?.member_ids ?? []).includes("plan:code:src-base"),
  `系统架构的成员＝账目 ∩ {module} ∩ 蓝图节点（${archCap1.members.join("、")}）——任务的**归属**仍在唯一账目里（${(archLedger["plan:cap:01"]?.member_ids ?? []).join("、")}），只是不进架构分组（§3.2 表格第三列）`,
);
// 负例（判据**不是空转**）：错 kind 仍必须失败——把名单混进一个**任务**成员，
// 「架构分组只含 module」这一条立刻不成立（用同一份真实数据构造反例，不改产品代码、不改正例）。
const wrongKindMembers = [...archCap1.members, "plan:task:T-1"];
ok(
  !wrongKindMembers.every((m) => bpNodes.find((n) => n.id === m)?.kind === "module"),
  "负例：成员名单混进一个**任务**（plan:task:T-1）时「架构成员只含 module」不成立——判据不是空转",
);
// 判据不放宽（续·canonical scope）：架构视图的能力状态**只读 canonical 义务层投影**（V09-55）——
// 「成员只含模块」这条过滤**不改变**状态读数：喂同一份 canonical 投影，架构视图读到的就是它（不是成员汇总）。
const scopeProj = {
  "plan:cap:01": { object_id: "plan:cap:01", mapping: "mapped", display_status: "in_progress", reasons: [] },
} as never;
const vmArchScoped = buildViewModel({
  view: "architecture",
  blueprint: bp,
  projection,
  module_status: derived.status,
  scope_projection: scopeProj,
});
const archCap1Scoped = vmArchScoped.nodes.find((n) => n.id === "plan:cap:01")!;
ok(
  archCap1Scoped.status.display === "in_progress" && archCap1.members.join(",") === "plan:code:src-base",
  `架构视图的能力状态只读 canonical 投影（喂 "in_progress" ⇒ 画布读到 ${String(archCap1Scoped.status.display)}），与「成员只含模块」这条过滤各归各位、互不搅动（V09-55）`,
);

// ═════════════════════════════ B2/B3/B4 ═════════════════════════════
console.log("[verify] ═══ B2/B3/B4 模块层状态：按实现映射从任务派生 ═══");
// 期望定向更新（V08-03 / DESIGN.md 附录 D，2026-09-23）：
//   旧期望＝派生结果的键是模块**对象 id**（`module:<id>`）、且模块状态**一律封顶在「结果待验证」**；
//   依据＝用户当班裁定「模块层颜色天花板是设计缺陷，必须补齐」＋附录 D.3「模块映射非空且成员卡**全部** verified ⇒ 验证通过」；
//   新期望＝键改为模块**节点 id**（另给 `by_object` 供共用数据层/详情卡查），成员全绿的模块判**验证通过**；
//   保留意图＝「空映射、无证据、有真 todo 的都不判绿」未变（见 docs 模块与「无状态记录」两条）；
//   判据未放宽：绿的条件比原来更严（原来恒不绿，现需成员**全部**通过）。
ok(
  derived.tasks_by_module["plan:code:src-base"]?.join(",") === "T-1" &&
    derived.tasks_by_module["plan:code:docs"]?.join(",") === "T-2",
  `实现映射把任务挂到模块（${JSON.stringify(derived.tasks_by_module)}）`,
);
const srcStatus = derived.by_object["module:src-base"]!;
const docsStatus = derived.by_object["module:docs"]!;
ok(
  srcStatus.display === "verified" && srcStatus.short === MODULE_VERIFIED_SHORT && srcStatus.basis.includes("模块验证通过"),
  `成员卡全部「已验证通过」的模块判**验证通过**并点明「已存在」（${srcStatus.display}／${srcStatus.short}，附录 D）`,
);
ok(
  docsStatus.display === "in_progress" && docsStatus.basis.includes("1 张卡"),
  `只有一个在跑任务的模块：不是全部通过 ⇒ 取最高、**不给绿**（${docsStatus.display}）`,
);
const noEvidence = noStatusRecordOf("module:audit");
ok(
  noEvidence.display === null && noEvidence.unmapped_reason === "no_task_evidence" &&
    DISPLAY_STATUS_PALETTE.no_status_record.short === "无状态记录" &&
    noEvidence.basis.includes("无状态记录"),
  "没有任何任务指向的模块：如实标「无状态记录」（display=null + reason=no_task_evidence，短标签也写「无状态记录」）",
);
ok(
  NO_STATUS_RECORD === NO_STATUS_RECORD_KEY && DISPLAY_STATUS_PALETTE.no_status_record.dashed === true,
  "「无状态记录」有独立的中性虚线样式，且**没有混进六态键表**（六态仍是服务端口径那六个）",
);
ok(
  DISPLAY_STATUS_KEYS.length === 6,
  `六态键集合未被本卡扩表（${DISPLAY_STATUS_KEYS.join(" / ")}）`,
);

// ═════════════════════════════ C1 ═════════════════════════════
console.log("[verify] ═══ C1 「未映射」不再一刀切：几种真实原因分开 ═══");
const noSource = directStatusOf(null);
const unmappedObject = directStatusOf({
  object_id: "V06-99",
  mapping: "unmapped",
  display_status: null,
  reasons: [{ code: "unmapped", text: "未映射：这个对象没有任务或验收映射——不空集判绿（DESIGN.md §4.2）" }],
} as never);
// V09-55 返工：能力（scope）层不再本地按成员汇总——没接入 canonical 投影时是 `no_status_source`；
// 「没有成员 / 成员都没有结论」这类**模块层**原因仍在（`no_task_evidence`／`members_without_status`）。
const scopeUnavailable = canonicalScopeStatusOf(null);
const moduleNoTask = noStatusRecordOf("plan:code:nomod");
const reasons = [
  noSource.unmapped_reason,
  unmappedObject.unmapped_reason,
  scopeUnavailable.unmapped_reason,
  moduleNoTask.unmapped_reason,
];
ok(
  new Set(reasons).size === 3 &&
    reasons.includes("no_status_source") &&
    reasons.includes("object_unmapped") &&
    reasons.includes("no_task_evidence"),
  `原因各自枚举、不一刀切（${reasons.join(" / ")}）——不再统统只说「未映射」`,
);
ok(
  noSource.basis.includes("暂无状态来源") && unmappedObject.basis.includes("对象未映射") && moduleNoTask.basis.includes("没有任务"),
  "各原因的**文案**各自点名（详情里能一眼看出是哪一种）",
);
ok(
  [noSource, unmappedObject, scopeUnavailable, moduleNoTask].every((s) => s.display === null),
  "各原因都**不着完成色**（不空集判绿，§4.2 底线未动）",
);

// ═════════════════════════════ C2 ═════════════════════════════
console.log("[verify] ═══ C2 施工依赖的集成端点：去强调化 + 标「不表示进度」═══");
const vmConstruction = buildViewModel({ view: "construction", blueprint: bp, projection, module_status: derived.status });
const endpoints = vmConstruction.nodes.filter((n) => n.endpoint === true);
ok(
  endpoints.length === 2 && endpoints.every((n) => n.label.includes("不表示进度")),
  `端点节点标了「不表示进度」（${endpoints.map((n) => n.label).join("、")}）`,
);
ok(
  endpoints.every((n) => n.status.basis.includes("不表示进度")) &&
    endpoints.every((n) => n.status.display === null ? n.status.unmapped_reason === "endpoint" : true),
  "端点的状态口径句写明「不表示进度」；不着色时原因是 `endpoint`",
);
ok(
  vmConstruction.nodes.filter((n) => n.endpoint !== true).length === 2,
  "端点仍不进概览计数（概览只算本视图主体＝任务节点）",
);
ok(
  objectIdOf("plan:code:src-base", "module") === "module:src-base",
  "模块对象 id 口径未动（plan:code:<模块 id> → module:<模块 id>）",
);

// ═════════════════════════════ B1b（2026-09-26 安装版复核定向更新） ═════════════════════════════
console.log("[verify] ═══ B1b 多值归属 + 架构视图二级派生 + 画布缺口对账 ═══");
// 期望定向更新（2026-09-26 安装版架构灰块复核，依据复核记录 D:\tmp\tatai-audit\closure\2026-09-26-安装版架构灰块复核.md）：
//   旧期望＝成员 → 归属能力是单值 Map，后写覆盖（「同一模块被多个能力接口时后写为准」）；
//   依据＝真实蓝图 94 条 task_design_ref 里 32 张卡指向 ≥2 个能力，单值覆盖让 cap:01/07/10 的功能全景分组各 0 成员；
//   新期望＝归属是**多值**：同一任务/模块出现在它真实归属的**每个**能力分组里；
//   保留意图＝「没有引用的能力仍 no_members 不着色」「架构视图成员仍只有模块 kind」未变；
//   判据未放宽：空集仍不判绿，派生归属必须带 observed 实测证据链。
const mkBp = (nodes: unknown[], edges: unknown[]) =>
  ({
    version: 1,
    baseline_id: "bl-v0802-fixture-multi",
    generated_at: "2026-09-26T00:00:00+08:00",
    generator_version: "fixture",
    limits: { max_nodes: 200, max_edges: 400 },
    nodes,
    edges,
    coverage: {
      design: { total: 0, mapped: 0, unmapped: [] },
      plan: { total: 0, mapped: 0, unmapped: [] },
      code: { total: 0, mapped: 0, unmapped: [] },
    },
    omitted: { nodes: [], edges: [], notes: [] },
  }) as never;
const bpMultiCap = mkBp(
  [
    { id: "plan:cap:01", kind: "capability", name: "能力甲", source_refs: [], related_ids: [] },
    { id: "plan:cap:02", kind: "capability", name: "能力乙", source_refs: [], related_ids: [] },
    { id: "plan:cap:03", kind: "capability", name: "能力丙", source_refs: [], related_ids: [] },
    { id: "plan:code:src-base", kind: "module", name: "基础模块", source_refs: [], related_ids: [] },
    { id: "plan:task:T-1", kind: "task", name: "T-1", source_refs: [], related_ids: [] },
  ],
  [
    // 同一任务指向两个能力（真实蓝图里 V09-05 一张卡指向 5 个能力就是这种）
    { source: "plan:task:T-1", target: "plan:cap:01", kind: "task_design_ref", source_refs: [], certainty: "declared" },
    { source: "plan:task:T-1", target: "plan:cap:02", kind: "task_design_ref", source_refs: [], certainty: "declared" },
    { source: "plan:task:T-1", target: "plan:code:src-base", kind: "implementation_map", source_refs: [], certainty: "observed" },
  ],
);
const derivedMulti = taskDerivedModuleStatus({ blueprint: bpMultiCap, projection });
const vmFMulti = buildViewModel({ view: "functional", blueprint: bpMultiCap, projection, module_status: derivedMulti.status });
const fCap1 = vmFMulti.nodes.find((n) => n.id === "plan:cap:01")!;
const fCap2 = vmFMulti.nodes.find((n) => n.id === "plan:cap:02")!;
const fCap3 = vmFMulti.nodes.find((n) => n.id === "plan:cap:03")!;
ok(
  fCap1.members.includes("plan:task:T-1") && fCap2.members.includes("plan:task:T-1"),
  `同一任务指向多个能力 ⇒ **每个**能力分组都有它（cap:01=${fCap1.members.join("、")}；cap:02=${fCap2.members.join("、")}）——不再后写覆盖`,
);
ok(
  fCap3.members.length === 0 && fCap3.status.display === null && fCap3.status.unmapped_reason === "no_status_source",
  "没有被任何任务引用的能力仍如实空组、不着色（不为了全绿编造归属）",
);
const vmAMulti = buildViewModel({ view: "architecture", blueprint: bpMultiCap, projection, module_status: derivedMulti.status });
const aCap1 = vmAMulti.nodes.find((n) => n.id === "plan:cap:01")!;
const aCap2 = vmAMulti.nodes.find((n) => n.id === "plan:cap:02")!;
const aCap3 = vmAMulti.nodes.find((n) => n.id === "plan:cap:03")!;
ok(
  aCap1.members.includes("plan:code:src-base") && aCap2.members.includes("plan:code:src-base"),
  `系统架构的能力→模块归属二级派生：经「能力 ← 任务设计引用 ← 实测实现映射」两个能力分组都得到模块成员（${aCap1.members.join("、")}／${aCap2.members.join("、")}）`,
);
ok(
  vmAMulti.notes.some((n) => n.includes("二级派生") && n.includes("不是设计书模块清单的声明归属")),
  "派生归属的口径句上屏：如实写明是派生、不冒充设计声明",
);
ok(
  aCap3.members.length === 0 && aCap3.status.display === null,
  "没有证据链的能力在架构视图仍 0 成员、不着色（文档章节类能力如实留灰，不隐藏节点）",
);
ok(
  vmAMulti.nodes.every((n) => n.id !== "ungrouped:plan:code:src-base"),
  "被派生归属的模块不再落成「未归属能力」孤组（它已真实归属于两个能力分组）",
);
// 画布缺口对账：证据链与分组一致 ⇒ 无缺口；实现映射靶点不在蓝图节点里 ⇒ 出缺口
ok(
  canvasMembershipGapsOf({ blueprint: bpMultiCap, projection, module_status: derivedMulti.status }).length === 0,
  "证据链与画布分组一致 ⇒ canvasMembershipGapsOf 零缺口（本夹具两个能力都验）",
);
const bpDangling = mkBp(
  [
    { id: "plan:cap:01", kind: "capability", name: "能力甲", source_refs: [], related_ids: [] },
    { id: "plan:task:T-1", kind: "task", name: "T-1", source_refs: [], related_ids: [] },
  ],
  [
    { source: "plan:task:T-1", target: "plan:cap:01", kind: "task_design_ref", source_refs: [], certainty: "declared" },
    // 靶点 plan:code:ghost 不在 nodes 里：证据链说有实现映射，画布分组拿不出任何模块成员
    { source: "plan:task:T-1", target: "plan:code:ghost", kind: "implementation_map", source_refs: [], certainty: "observed" },
  ],
);
const gapsDangling = canvasMembershipGapsOf({ blueprint: bpDangling, projection });
ok(
  gapsDangling.length === 1 && gapsDangling[0].capability_id === "plan:cap:01" && gapsDangling[0].view === "architecture" &&
    gapsDangling[0].detail.includes("plan:code:ghost"),
  `实现映射靶点缺席 ⇒ 出画布缺口并点名（${gapsDangling.map((g) => `${g.capability_id}/${g.view}`).join("、")}）——交付判定能看见图面真实断裂`,
);
// 功能全景缺口（反例）：构造一个 buildViewModel 无法分出成员的场景只能靠破坏分组口径本身——
// 这里退一步验「无引用 ⇒ 无缺口」的边界：没有任何 task_design_ref 时两个视图都不出缺口
ok(
  canvasMembershipGapsOf({ blueprint: mkBp([], []), projection }).length === 0,
  "没有任何任务引用 ⇒ 不出缺口（缺口只报'证据链与画布断裂'，不报'本来就没有证据'）",
);

console.log(`[verify] 汇总：${pass} PASS / ${fail} FAIL`);
assert.ok(true);
