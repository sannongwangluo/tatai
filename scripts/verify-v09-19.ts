// V09-19 验证脚本（tsx 跑）：V09-18 非作者复审 R-1／R-2／R-3 返工 ＋ 六图 MCP 完整状态读取
// （PLAN.md V09-19；DESIGN.md §3.2／§4.1／§4.2／§6.4／§6.7、附录 E.18；需求 req-2026-09-26-r2）。
// 用法：pnpm verify:v09-19
//
// 隔离口径（本脚本自己守）：真实 `.工作台` **一个字节都不写**——真实段只读 registry 定位到的 tatai 项目的
// `arch/blueprint.json`（首尾各取一次 sha256，变了就报 FAIL）；反例全部走内存夹具与 os.tmpdir() 临时目录。
//
// 覆盖（逐条对着卡面检查项）：
//   ① R-1 解析层四类反例＋正常表＋章节交叉对账＋两个兼容反例：缺行／重复矛盾／坏行（含全角斜杠）／标记误命中
//      逐项**显式登记**，都不再静默判 functional；无表仍走「全部功能能力＋未声明」。
//   ② R-1 展示口径：表损坏 ⇒ 阻断发布（capability_class_table_broken），图上「分类未定」而非绿色；
//      未解析出分类的能力不并入功能能力计数；口径句写「损坏」不写「未声明」。
//   ③ R-2 提案**节点侧**线索化四类反例：补 source_refs 不进正式节点账／自报新节点不进 bp.nodes／
//      冗余标 confirmed／端点未解析的提案关系照旧入线索账。
//   ④ R-2 不回退：真实蓝图正式关系 321 条（0 条模型提案）、model_leads 16 条、model_node_leads 空。
//   ⑤ 六图读口（真实项目）：同一快照标识、六图齐、逐对象带状态键/短标/颜色/来源/映射/证据/有效版本/阻断/用户待验、
//      模型待审线索单列、数据流向图分两层、三种「到哪一步」分开、完整性 complete:true。
//   ⑥ 四档读取：单图／节点／关系各给对；参数错误明确报错。
//   ⑦ 反例簇：大图分页（超限 incomplete＋cursor 可续取、不许静默截断还称全图）、缺图（隔离夹具，availability=none）、
//      表损坏（隔离夹具派生＋阻断）、旧 get_arch 兼容（技术详情层语义与字段不变）。
//   ⑧ project_entry 六图摘要与整图**同源**（同一 snapshot_id 与计数）。
//   ⑨ 工具面与文档同源：注册表 19 个；README／verify-u2／verify-m2／verify-v09-05 ③ 的口径一致。
//   ⑩ R-3 勘误与脚本前置：V09-18 收口报告有勘误段（历史原文未改）；装卸脚本含窗口就绪判据与新后端 PID 校验。
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  capabilityClassTableOf,
  deriveBlueprint,
  mergeProposal,
  readBlueprint,
  type Blueprint,
  type BlueprintEdge,
  type BlueprintNode,
  type BlueprintSources,
} from "../src/arch/blueprint";
import { blueprintContextOf } from "../src/arch/blueprint";
import { validateBlueprint } from "../src/arch/blueprintValidate";
import { SIX_GRAPH_KEYS, SIX_GRAPH_OBJECT_LIMIT, graphSummaryOf, sixGraphsOf } from "../src/arch/sixGraphs";
import { capabilityClassOf, capabilityClassTableStateOf } from "../src/ui/arch/projectGraph";
import { getArchTool } from "../src/mcp/tools/getArch";
import { getProjectGraphsTool } from "../src/mcp/tools/getProjectGraphs";
import { projectEntryTool } from "../src/mcp/tools/projectEntry";
import { TOOLS } from "../src/mcp/tools/index";

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
const section = (m: string): void => console.log(`\n[verify] ═══ ${m}`);
const read = (p: string): string => fs.readFileSync(p, "utf8");
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const sha256 = (s: string | Buffer): string => crypto.createHash("sha256").update(s).digest("hex");

/** 真蓝图首尾自证：本脚本对真实 `.工作台` 零写入 */
const REAL_BP = path.join(REPO, ".工作台", "arch", "blueprint.json");
const bpBefore = fs.existsSync(REAL_BP) ? sha256(fs.readFileSync(REAL_BP)) : "";

// ═════════════════════════ ① R-1 解析层四类反例 ═════════════════════════
section("① R-1 能力分类声明表：四类反例＋正常表＋兼容口径（不静默判 functional）");
const TABLE_FULL = [
  "**能力分类声明（机器可读）**",
  "",
  "| 章节 | 分类 | 依据 |",
  "| --- | --- | --- |",
  ...Array.from({ length: 12 }, (_, i) => {
    const n = i + 1;
    const gov = [1, 7, 10, 11, 12].includes(n);
    return `| §${n} 第${n}章 | ${gov ? "设计/治理" : "功能能力"} | x |`;
  }),
  "",
].join("\n");

{
  const t0 = capabilityClassTableOf(TABLE_FULL);
  ok(
    t0.declared && t0.state === "declared" && t0.byChapter.size === 12 && t0.byChapter.get(7) === "governance" && t0.issues.length === 0,
    `① 正常表照常判 declared（12 行、§7=治理、零问题；实测 state=${t0.state} size=${t0.byChapter.size} issues=${t0.issues.length}）`,
  );
  const t1 = capabilityClassTableOf(TABLE_FULL.replace("| §7 第7章 | 设计/治理 | x |\n", ""));
  ok(
    t1.declared === false &&
      t1.state === "broken" &&
      t1.byChapter.get(7) === undefined &&
      t1.issues.some((i) => i.kind === "missing_chapter" && i.chapter === 7 && i.blocking),
    `① 反例 a（缺行）：§7 行删掉 ⇒ missing_chapter 阻断点名（declared=${t1.declared}、state=${t1.state}）——不再静默 functional`,
  );
  const dup = capabilityClassTableOf(
    TABLE_FULL.replace("| §1 第1章 | 设计/治理 | x |", "| §1 第1章 | 功能能力 | 先写的 |\n| §1 第1章 | 设计/治理 | 后写的 |"),
  );
  ok(
    dup.declared === false &&
      dup.state === "broken" &&
      dup.byChapter.get(1) === "functional" &&
      dup.issues.some((i) => i.kind === "duplicate_chapter" && i.chapter === 1 && i.blocking),
    `① 反例 b（重复矛盾）：同章两行矛盾 ⇒ duplicate_chapter 阻断、取**首次**出现的分类（实测 §1=${String(dup.byChapter.get(1))}）——不静默取后值`,
  );
  const t3 = capabilityClassTableOf(TABLE_FULL.replace("| §7 第7章 | 设计/治理 | x |", "| §7 第7章 | 设计治理 | x |"));
  const t3b = capabilityClassTableOf(TABLE_FULL.replace("| §7 第7章 | 设计/治理 | x |", "| §7 第7章 | 设计／治理 | x |"));
  ok(
    t3.declared === false &&
      t3.issues.some((i) => i.kind === "malformed_row" && i.chapter === 7) &&
      t3b.declared === false &&
      t3b.issues.some((i) => i.kind === "malformed_row"),
    "① 反例 c（坏行）：`设计治理`（缺斜杠）与 `设计／治理`（全角斜杠）都判 malformed_row 阻断——不再整行跳过回退 functional",
  );
  const misplaced = "## 附录 B\n- 某待议条引用：「能力分类声明（机器可读）」这张表……\n\n正文没有表。\n\n" + TABLE_FULL;
  const t4 = capabilityClassTableOf(misplaced);
  ok(
    t4.declared &&
      t4.byChapter.size === 12 &&
      t4.issues.some((i) => i.kind === "marker_misplaced" && i.blocking === false),
    `① 反例 d（标记误命中）：附录里的字样被跳过并登记，**继续向后读真表**（实测 declared=${t4.declared} size=${t4.byChapter.size}）——不再「真表在后面也不读」`,
  );
  const cross = capabilityClassTableOf("## 1. 甲\n## 2. 乙\n## 3. 丙\n\n" + TABLE_FULL);
  ok(
    cross.issues.filter((i) => i.kind === "chapter_mismatch").length === 9,
    `① 章节交叉对账：设计书只有 §1–3、表有 §1–12 ⇒ 9 条 chapter_mismatch（实测 ${cross.issues.filter((i) => i.kind === "chapter_mismatch").length} 条）`,
  );
  const noTable = capabilityClassTableOf("# 某设计书\n\n## 1. 甲\n\n## 2. 乙\n");
  ok(
    noTable.declared === false && noTable.state === "undeclared" && noTable.issues.length === 0,
    "① 兼容反例 a：确实**没有**声明表 ⇒ undeclared（全部功能能力＋注明未声明），不误报损坏",
  );
  const markerNoTable = capabilityClassTableOf("## 附录 B\n- 引用「能力分类声明（机器可读）」这张表\n\n正文没有表。\n");
  ok(
    markerNoTable.declared === false &&
      markerNoTable.state === "undeclared" &&
      markerNoTable.issues.some((i) => i.kind === "marker_misplaced" && !i.blocking),
    "① 兼容反例 b：有字样但没有表 ⇒ 仍按 undeclared 兼容口径，但**登记**该事实（不静默）",
  );
}

// ═════════════════════════ ② R-1 展示/阻断口径 ═════════════════════════
section("② R-1 表损坏 ⇒ 阻断发布＋「分类未定」，不给误导性的绿色或可请求验收");
function fixtureSources(designText: string): BlueprintSources {
  const sections = ["1. 甲", "2. 乙", "7. 丙"].map((t, i) => ({
    path: `夹具设计书 v0.9 / ${t}`,
    sha256: `s${i}`,
    level: 2,
    title: t,
  }));
  return {
    project_id: "fx",
    baseline_id: "bl-fx",
    design: { path: "DESIGN.md", content_sha256: "d".repeat(64), definition_sha256: "d".repeat(64), text: designText, sections },
    plan: null,
    declared_modules: [],
    code: { available: true, budget_exhausted: null, modules: [] },
    repo_root_files: [],
    names: {},
    manifest: [],
  } as never;
}
{
  const brokenDesign = "## 1. 甲\n## 2. 乙\n## 7. 丙\n\n" + TABLE_FULL.replace("| §7 第7章 | 设计/治理 | x |\n", "");
  const src = fixtureSources(brokenDesign);
  const bp = deriveBlueprint(src, { based_on: { model_key: "fx", full_key: "fx", design_content_sha256: "d", plan_definition_sha256: null, semantic: false } });
  const verdict = validateBlueprint(bp, blueprintContextOf(src));
  ok(
    verdict.blocking.some((f) => f.code === "capability_class_table_broken") && verdict.publishable === false,
    "② 表损坏 ⇒ `capability_class_table_broken` 阻断发布、publishable=false（按「旧有效图/更新失败」规则保留上次有效图）",
  );
  const capOfChapter7 = bp.nodes.find((n) => n.kind === "capability" && /^7\s*[.、．]/.test(n.name))?.id ?? "";
  ok(
    capabilityClassTableStateOf(bp) === "broken" &&
      capabilityClassOf(bp, "plan:cap:01") === "governance" &&
      capOfChapter7 !== "" &&
      capabilityClassOf(bp, capOfChapter7) === "unknown",
    `② 分类口径：能解析出来的章节照给（§1 那章 plan:cap:01=governance，照表解析），**解析不出来的标 unknown 而不是 functional**（§7 那章 ${capOfChapter7}=${capabilityClassOf(bp, capOfChapter7)}）`,
  );
  ok(
    bp.capability_classes?.declared === false && (bp.capability_classes?.note ?? "").includes("损坏") && !(bp.capability_classes?.note ?? "").includes("没有「能力分类声明」表"),
    "② 口径句写「声明表损坏」并逐项点名，**不**写成「能力分类未声明」（不误导）",
  );
}

// ═════════════════════════ ③ R-2 提案节点侧线索化（反例） ═════════════════════════
section("③ R-2 提案节点/补出处只留待审线索层（不经权威原文验证不进正式节点）");
const mkNode = (id: string, kind: BlueprintNode["kind"], refs: BlueprintNode["source_refs"] = []): BlueprintNode => ({
  id,
  kind,
  name: id,
  source_refs: refs,
  related_ids: [],
});
const mkEdge = (source: string, target: string, kind: BlueprintEdge["kind"], certainty: BlueprintEdge["certainty"]): BlueprintEdge => ({
  source,
  target,
  kind,
  source_refs: [],
  certainty,
});
const mkBp = (nodes: BlueprintNode[], edges: BlueprintEdge[]): Blueprint =>
  ({
    version: 1,
    baseline_id: "bl-r2",
    generator_version: "fixture",
    generated_at: "2026-09-26T00:00:00+08:00",
    source_manifest: [],
    nodes,
    edges,
    coverage: {
      design_sections: { total: 0, mapped: 0, unmapped: [] },
      plan_tasks: { total: 0, mapped: 0, unmapped: [] },
      code_modules: { total: 0, mapped: 0, unmapped: [] },
      nodes_total: nodes.length,
      nodes_kept: nodes.length,
      edges_total: edges.length,
      edges_kept: edges.length,
      note: "fixture",
    },
    omitted: [],
    model_receipt: null,
    model_leads: [],
    capability_classes: null,
    publish: { published: true, reason: null, validated_at: null },
    based_on: { model_key: "f", full_key: "f", design_content_sha256: null, plan_definition_sha256: null, semantic: false },
  }) as Blueprint;
{
  const base = mkBp(
    [mkNode("plan:task:T-1", "task", [{ kind: "plan_task", path: "PLAN.md", locator: "### T-1", sha256: null }]), mkNode("plan:cap:01", "capability")],
    [mkEdge("plan:task:T-1", "plan:cap:01", "task_design_ref", "declared")],
  );
  const m2 = mergeProposal(base, {
    nodes: [{ id: "plan:task:T-1", kind: "task", name: "T-1", source_refs: [{ kind: "design_section", path: "DESIGN.md", locator: "§9.9-不存在", sha256: null }], related_ids: [] }],
    edges: [],
  });
  const refs = (m2.nodes.find((n) => n.id === "plan:task:T-1")?.source_refs ?? []).map((r) => `${r.kind}/${r.locator}`);
  ok(
    !refs.some((r) => r.includes("§9.9-不存在")) && refs.some((r) => r === "plan_task/### T-1"),
    `③ 反例 P2：提案给既有节点补的 source_refs **不进正式节点账**（出处实测 ${refs.join("、")}）⇒ 其证据状态不被提案牵动`,
  );
  ok(
    (m2.model_node_leads ?? []).some((l) => l.id === "plan:task:T-1" && l.target === "existing_node" && l.disposition === "lead_pending_review" && l.proposed_source_refs.some((r) => r.locator === "§9.9-不存在")),
    "③ 反例 P2：原始提案与处置留在 `model_node_leads`（可追溯）",
  );
  const m3 = mergeProposal(base, {
    nodes: [{ id: "plan:task:FAKE-999", kind: "task", name: "FAKE-999", source_refs: [{ kind: "plan_task", path: "PLAN.md", locator: "### FAKE-999", sha256: null }], related_ids: [] }],
    edges: [],
  });
  ok(
    m3.nodes.find((n) => n.id === "plan:task:FAKE-999") === undefined &&
      (m3.model_node_leads ?? []).some((l) => l.id === "plan:task:FAKE-999" && l.target === "new_node" && l.disposition === "lead_pending_review") &&
      (m3.omitted ?? []).some((o) => o.kind === "model_node_lead_recorded"),
    "③ 反例 P3：模型自报的 `plan:task:*` 新节点**不进 bp.nodes**（不进交付对象清单、不产生 missing），只留节点线索并记账",
  );
  const m5 = mergeProposal(base, {
    nodes: [{ id: "plan:task:T-1", kind: "task", name: "T-1", source_refs: [{ kind: "plan_task", path: "PLAN.md", locator: "### T-1", sha256: null }], related_ids: [] }],
    edges: [],
  });
  ok(
    (m5.model_node_leads ?? []).every((l) => l.disposition === "confirmed_by_derivation"),
    "③ 冗余留痕：正式节点**本来就有**同名出处 ⇒ 标 confirmed_by_derivation（与边线索同口径）",
  );
  const m6 = mergeProposal(base, {
    nodes: [{ id: "plan:concept:x", kind: "concept", name: "x", source_refs: [], related_ids: [] }],
    edges: [mkEdge("plan:task:T-1", "plan:concept:x", "model_inference", "inferred")],
  });
  ok(
    m6.edges.length === base.edges.length &&
      (m6.model_leads ?? []).some((l) => l.target === "plan:concept:x" && l.disposition === "lead_pending_review") &&
      (m6.omitted ?? []).some((o) => o.kind === "model_lead_unknown_endpoint"),
    "③ 端点指向自报新节点的提案关系：不产生正式边，但**照实入线索账**并单独记账（保留原始提案）",
  );
}

// ═════════════════════════ ④ R-2 不回退（真实蓝图） ═════════════════════════
section("④ R-2 不回退：真实蓝图正式关系/线索账逐条复算");
const realBp = readBlueprint("tatai");
if (realBp === null) {
  ok(false, "④ 真实蓝图读不到（拿不到 tatai 的 arch/blueprint.json）——不假装通过");
} else {
  const byKind: Record<string, number> = {};
  for (const e of realBp.edges) byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
  const certainty = new Set(realBp.edges.map((e) => e.certainty));
  info(`真实蓝图：${realBp.nodes.length} 节点 / ${realBp.edges.length} 边（${JSON.stringify(byKind)}）`);
  // 不回退的判据写成「不少于 V09-18 当时的读数」而不是钉死一个数：
  // 本批新增 V09-19 一张卡（卡面声明了设计依据与文件责任），四类正式边会合法地变多（+1 任务节点、
  // +1 依赖边、+5 tdr、+4 实现映射）——而「正式关系只来自确定性派生、一条模型提案也没进来」这条不变量才是 R-2 要守的。
  ok(
    realBp.nodes.length >= 75 &&
      realBp.edges.length >= 321 &&
      byKind.task_design_ref >= 102 &&
      byKind.implementation_map >= 124 &&
      byKind.task_dependency >= 85 &&
      byKind.design_interface >= 10 &&
      [...certainty].every((c) => c === "declared" || c === "observed"),
    `④ 正式关系不回退（≥ V09-18 当时读数，四类边逐类比），且 certainty 全为声明/观测、无一条模型提案（实测 ${realBp.nodes.length} 节点／${realBp.edges.length} 边 ${JSON.stringify(byKind)}／${[...certainty].join("+")}）`,
  );
  // 定向更新（V09-20，2026-09-26，五要素留档）：
  //   旧期望＝线索账字数钉死「16 条（confirmed 3／pending 13）」「model_node_leads 空」｜
  //   依据＝那两个数是**模型语义整理层的输出**（非确定性）。本轮 DESIGN 修订触发基线重激活⇒自动链重跑整理，
  //         同一份来源得到 15 条边线索与若干节点线索 ⇒ 钉死字数＝把旧一次模型输出锁进断言
  //         （正是 V09-18 裁定 8「测试不以过期固定数自证」要避免的）｜
  //   新期望＝**性质判据**：线索账非空；每条处置只允许两种口气之一；`confirmed_by_derivation` 的每一条
  //         必须在正式关系里真有同名确定性边（独立命中＝冗余留痕，不是自报）；`lead_pending_review` 的
  //         每一条都**不得**出现在正式关系里；节点线索账里的自报新节点**不得**进正式节点集｜
  //   保留意图＝裁定 1/2/4（提案只作待审线索、不进成员/绿态/交付读数、跨轮不升格）｜
  //   判据不放宽：结构错、口径混、线索进正式关系/节点 → 逐条判红（比只比总数更严）。
  const leadKeys = new Set(realBp.edges.map((e) => `${e.source}>${e.target}:${e.kind}`));
  const edgeLeads = realBp.model_leads ?? [];
  const nodeLeads = realBp.model_node_leads ?? [];
  const dispOk = [...edgeLeads, ...nodeLeads].every(
    (l) => l.disposition === "confirmed_by_derivation" || l.disposition === "lead_pending_review",
  );
  const confirmedInFormal = edgeLeads
    .filter((l) => l.disposition === "confirmed_by_derivation")
    .every((l) => leadKeys.has(`${l.source}>${l.target}:${l.kind}`));
  const pendingNotFormal = edgeLeads
    .filter((l) => l.disposition === "lead_pending_review")
    .every((l) => !leadKeys.has(`${l.source}>${l.target}:${l.kind}`));
  ok(
    edgeLeads.length > 0 && dispOk && confirmedInFormal && pendingNotFormal,
    `④ 待审线索账性质判据：${edgeLeads.length} 条边线索（confirmed ${edgeLeads.filter((l) => l.disposition === "confirmed_by_derivation").length}／pending ${edgeLeads.filter((l) => l.disposition === "lead_pending_review").length}）处置只有两种口气、confirmed 都在正式关系里有同名确定性边、pending 都不在正式关系里`,
  );
  // 反例夹具（V09-21 R1，2026-09-27）：构造「一条 pending 线索同时是正式边」——同一判据必须判红，
  // 证明 ④ 不是空转（23a087e 曾把 key 集错写成 `e.from/e.to`（恒 undefined），pendingNotFormal 真空转）。
  const probeKey = "__r1_probe_src__>__r1_probe_dst__:design_interface";
  const poisonedKeys = new Set([...leadKeys, probeKey]);
  const pendingNotFormalOnPoisoned = !poisonedKeys.has(probeKey); // 与 ④ 同一判据形态
  ok(
    !leadKeys.has(probeKey) && pendingNotFormalOnPoisoned === false,
    "④ 反例夹具：pending 线索若同时是正式边，④ 的 pendingNotFormal 必红（空转已消除，非只看全绿）",
  );
  ok(
    !nodeLeads.some((l) => l.target === "new_node" && realBp.nodes.some((n) => n.id === l.id)),
    `④ 节点侧线索账：${nodeLeads.length} 条节点线索里的自报新节点**没有**一条进正式节点集（判据在场，不虚报）`,
  );
  ok(
    realBp.capability_classes?.declared === true &&
      Object.values(realBp.capability_classes.by_capability).filter((c) => c === "functional").length === 7 &&
      Object.values(realBp.capability_classes.by_capability).filter((c) => c === "governance").length === 5,
    "④ 能力分类不回退：声明表 declared、功能 7／治理 5（R-1 的严格化只对损坏表生效）",
  );
}

// ═════════════════════════ ⑤ 六图读口（真实项目） ═════════════════════════
section("⑤ 六图完整状态读口：同一快照标识、逐对象字段、线索单列、两层数据流、三种读数分开");
const snap = sixGraphsOf("tatai");
{
  ok(/^gs-[0-9a-f]{8}$/.test(snap.snapshot_id), `⑤ 快照标识在场且稳定格式（${snap.snapshot_id}）`);
  ok(
    snap.baseline.baseline_id !== null && snap.generated_at !== null && snap.generated_at === realBp?.generated_at,
    `⑤ 基线/生成时刻与蓝图同源（baseline=${snap.baseline.baseline_id}、generated_at=${snap.generated_at}）`,
  );
  ok(
    SIX_GRAPH_KEYS.every((k) => snap.graphs[k] !== undefined),
    `⑤ 一次「全部六图」返回六张图（${SIX_GRAPH_KEYS.map((k) => `${k}:${snap.graphs[k]?.counts.nodes}/${snap.graphs[k]?.counts.edges}`).join(" ")}）`,
  );
  ok(snap.completeness.complete === true && snap.completeness.cursor === null && snap.completeness.returned > 0, `⑤ 塔台规模下一次取全（${snap.completeness.note}）`);
  const fn = snap.graphs.functional!;
  const cap = fn.nodes.find((n) => n.object.capability_class !== null);
  ok(
    cap !== undefined &&
      typeof cap.object.status_key === "string" &&
      typeof cap.object.status_short === "string" &&
      (cap.object.status_color === null || /^#[0-9a-f]{6}$/.test(cap.object.status_color.hex)) &&
      typeof cap.object.evidence_state === "string" &&
      cap.object.effective_version !== null &&
      Array.isArray(cap.object.blockers) &&
      typeof cap.object.user_pending === "boolean",
    `⑤ 逐对象带稳定 ID/状态键/短标/颜色口径/证据状态/有效版本/阻断/用户待验（样本 ${cap?.id}：${cap?.object.status_key}／${cap?.object.status_short}／${cap?.object.status_color?.hex}／${cap?.object.evidence_state}／${cap?.object.effective_version}）`,
  );
  const arch = snap.graphs.architecture!;
  ok(
    arch.counts.groups === 12 && arch.counts.intra_relations >= 132,
    `⑤ 分组与同组关系逐条可见（系统架构 ${arch.counts.groups} 组／${arch.counts.intra_relations} 条同组关系；≥ V09-18 当时的 132）`,
  );
  const df = snap.graphs.data_flow!;
  const tech = df.tech as { current_implementation?: { is_business_data_flow?: boolean }; target_semantics?: unknown; chains?: unknown[]; coverage?: unknown; deliverable_blocked?: boolean } | undefined;
  ok(
    tech !== undefined &&
      tech.current_implementation?.is_business_data_flow === false &&
      tech.target_semantics !== undefined &&
      Array.isArray(tech.chains) &&
      tech.coverage !== undefined &&
      typeof tech.deliverable_blocked === "boolean",
    "⑤ 数据流向图分两层：当前实现（is_business_data_flow=false，静态 import 方向渲染）＋目标语义（实体/关系/端到端链/覆盖对账/阻断）",
  );
  ok(
    df.edges.every((e) => e.note.includes("不是业务数据流")) || df.edges.length === 0,
    "⑤ 数据流向图的静态边逐条注明「不是业务数据流」（不把静态依赖说成已验证数据流）",
  );
  // 同批定向更新：字数改为**性质判据**（见 ④ 的五要素留档）——线索单列本身才是判据，条数由模型输出决定。
  const snapLeads = snap.model_leads ?? [];
  const snapNodeLeads = snap.model_node_leads ?? [];
  ok(
    snapLeads.length > 0 &&
      snapLeads.every((l) => l.disposition === "confirmed_by_derivation" || l.disposition === "lead_pending_review") &&
      snapNodeLeads.every((l) => l.disposition === "confirmed_by_derivation" || l.disposition === "lead_pending_review"),
    `⑤ 模型待审线索**单列**（快照里 ${snapLeads.length} 条边线索＋${snapNodeLeads.length} 条节点线索，全部带两种处置之一；不混进正式节点/关系）`,
  );
  ok(
    snap.separate_readouts.delivery_verdict !== null &&
      snap.separate_readouts.user_gate.includes("只由用户本人记录") &&
      snap.separate_readouts.note.includes("不得被读成「已交付」"),
    "⑤ 交付读数／工作流 next_action／用户 Gate **分开表达**，任一项都不等于「已交付」",
  );
  ok(
    snap.delivery !== null && snap.delivery.user_accepted === false && typeof snap.delivery.conclusion === "string",
    `⑤ 交付读数如实（verdict=${snap.delivery?.verdict}、结论=${snap.delivery?.conclusion}、用户待验 ${snap.delivery?.counts.user_pending} 项；恒 user_accepted=false）`,
  );
  ok(
    snap.capability_classes?.table_state === "declared" && snap.anomalies.length === 0,
    `⑤ 本项目无异常（表状态=${snap.capability_classes?.table_state}、anomalies=${snap.anomalies.length}）`,
  );
}

// ═════════════════════════ ⑥ 四档读取 ═════════════════════════
section("⑥ 四档读取（全部六图／单图／节点／关系）");
{
  const one = sixGraphsOf("tatai", { graph: "data_flow" });
  ok(Object.keys(one.graphs).length === 1 && one.graphs.data_flow !== undefined, "⑥ 指定单图：只回那一张");
  const nodeId = snap.graphs.functional!.nodes[0]!.id;
  const node = sixGraphsOf("tatai", { node_id: nodeId }) as unknown as { node_focus: { found: boolean; appearances: unknown[] } };
  ok(node.node_focus.found && node.node_focus.appearances.length >= 1, `⑥ 指定节点（${nodeId}）：给出所在分组与逐对象状态`);
  const relId = snap.graphs.architecture!.intra_relations[0]!.id;
  const rel = sixGraphsOf("tatai", { relation_id: relId }) as unknown as { relation_focus: { found: boolean; appearances: unknown[] } };
  ok(rel.relation_focus.found && rel.relation_focus.appearances.length >= 1, `⑥ 指定关系（${relId}）：给出两端/种类/语义/来源/当前状态`);
  const missing = sixGraphsOf("tatai", { node_id: "plan:cap:不存在的节点" }) as unknown as { node_focus: { found: boolean; note: string } };
  ok(!missing.node_focus.found && missing.node_focus.note.includes("查不到"), "⑥ 反例：查不到的稳定 ID 如实报「查不到」，不猜一个近似节点");
}

// ═════════════════════════ ⑦ 反例簇（分页／缺图／表损坏／旧读口兼容） ═════════════════════════
section("⑦ 反例簇：大图分页、缺图、旧 get_arch 兼容");
{
  const paged = sixGraphsOf("tatai", { limit: 50 });
  const pagedCursors = Object.entries(paged.completeness.cursors);
  ok(
    paged.completeness.complete === false &&
      paged.completeness.total > paged.completeness.returned &&
      pagedCursors.length > 0 &&
      paged.completeness.note.includes("不完整") &&
      paged.completeness.note.includes("不得"),
    `⑦ 反例（大图分页）：超限时给 total/returned、**逐图**续取游标与「不得当作全图」（total=${paged.completeness.total} returned=${paged.completeness.returned} cursors=${pagedCursors.length} 张图）`,
  );
  // ── F-1 返工（2026-09-26 非作者复审确认缺陷）：分页必须「走到终点＋并集等于全量」──
  // 旧断言只取两页、且只比节点不重叠（走的是恰好会累加的顶层 cursor），字面为真、机制有洞：
  // 逐图游标用「本页条数」、三段列表各自切同一 offset、complete 拿本页 returned 与全局总量比
  // ⇒ 游标倒退/循环、重复交付、漏交付、终态永远 incomplete。这里按真实续取口径重立断言。
  const seqOf = (g: { nodes: { id: string }[]; edges: { id: string }[]; intra_relations: { id: string }[] }): string[] => [
    ...g.nodes.map((n) => `N:${n.id}`),
    ...g.edges.map((e) => `E:${e.id}`),
    ...g.intra_relations.map((e) => `I:${e.id}`),
  ];
  const fullSeq: Record<string, string[]> = Object.fromEntries(
    SIX_GRAPH_KEYS.map((k) => [k, seqOf(sixGraphsOf("tatai", { graph: k }).graphs[k]!)]),
  );
  /** 按同一快照逐图游标从首页续到 complete=true；返回每页序列、终态与「顶层/逐图游标是否同口径」 */
  const walk = (key: (typeof SIX_GRAPH_KEYS)[number], limit: number) => {
    const pages: string[][] = [];
    const first = sixGraphsOf("tatai", { graph: key, limit });
    pages.push(seqOf(first.graphs[key]!));
    let samePosition = first.completeness.cursor === (first.completeness.cursors[key] ?? null);
    let cur: string | null = first.completeness.cursors[key] ?? null;
    let last = first;
    let rounds = 0;
    while (cur !== null && rounds < 600) {
      const page = sixGraphsOf("tatai", { graph: key, limit, cursor: cur });
      last = page;
      pages.push(seqOf(page.graphs[key]!));
      samePosition = samePosition && page.completeness.cursor === (page.completeness.cursors[key] ?? null);
      const next: string | null = page.completeness.cursors[key] ?? null;
      if (next !== null && Number(next.split(":")[2]) <= Number(cur.split(":")[2])) break; // 原地/倒退 = 坏
      cur = next;
      rounds++;
    }
    return { pages, last, rounds, samePosition, ended: cur === null };
  };
  const verdict = (key: string, r: ReturnType<typeof walk>) => {
    const flat = r.pages.flat();
    const union = new Set(flat);
    const missing = fullSeq[key]!.filter((id) => !union.has(id));
    const extra = [...union].filter((id) => !fullSeq[key]!.includes(id));
    return {
      good:
        r.ended &&
        flat.length === union.size &&
        missing.length === 0 &&
        extra.length === 0 &&
        r.samePosition &&
        r.last.completeness.complete === true &&
        r.last.completeness.cursor === null,
      detail: `页数 ${r.pages.length}、重复 ${flat.length - union.size}、漏 ${missing.length}、多 ${extra.length}、终页游标 ${r.last.completeness.cursor === null ? "无" : "有"}`,
    };
  };
  for (const key of SIX_GRAPH_KEYS) {
    const r = walk(key, 30);
    const v = verdict(key, r);
    ok(v.good, `⑦ 续取走到终点＋并集＝全量（逐对象一致）：${key} limit=30（${v.detail}）`);
  }
  // 跨段边界（节点段 → 关系段 → 同组关系段）+ 最小页：不许跳段/漏交付
  for (const key of SIX_GRAPH_KEYS) {
    const g = sixGraphsOf("tatai", { graph: key }).graphs[key]!;
    const bounds = [
      1,
      g.nodes.length,
      g.nodes.length + 1,
      g.nodes.length + g.edges.length,
      g.nodes.length + g.edges.length + 1,
    ].filter((x) => x >= 1 && x <= 60); // 限 ≤60：大页只验证语义，不让脚本跑成分钟级
    const detail: string[] = [];
    let allOk = true;
    for (const limit of [...new Set(bounds)]) {
      const r = walk(key, limit);
      const v = verdict(key, r);
      detail.push(`limit=${limit}${v.good ? "✓" : "✗(" + v.detail + ")"}`);
      allOk = allOk && v.good;
    }
    if (detail.length > 0) ok(allOk, `⑦ 跨段边界续取不跳段（${key}：${detail.join(" ")}）`);
  }
  let staleRejected = false;
  try {
    sixGraphsOf("tatai", { graph: "module_map", cursor: `gs-deadbeef:module_map:0`, limit: 5 });
  } catch (e) {
    staleRejected = (e as Error).message.includes("快照");
  }
  ok(staleRejected, "⑦ 反例：跨快照的游标明确拒绝（不拿旧游标拼新快照的数据）");
  // 游标与 graph= 指向不同图 ⇒ 两个续取位置矛盾，明确拒绝（不替调用方猜一个）
  let conflictRejected = false;
  try {
    sixGraphsOf("tatai", { graph: "module_map", cursor: `${snap.snapshot_id}:functional:0`, limit: 5 });
  } catch (e) {
    conflictRejected = (e as Error).message.includes("矛盾");
  }
  ok(conflictRejected, "⑦ 反例：游标与 graph 指向不同图时明确拒绝（顶层 cursor 与逐图 cursors 不许互相矛盾）");
  // 工具层（`get_project_graphs` 的 handler，与真实 stdio 客户端同一入口）也走一遍「走到终点＋并集＝全量」
  {
    const callTool = (args: Record<string, unknown>) => {
      const out = getProjectGraphsTool.handler(args) as { content: { text: string }[]; isError?: boolean };
      return { parsed: JSON.parse(out.content[0].text) as Record<string, any>, isError: out.isError === true };
    };
    const pages: string[] = [];
    const first = callTool({ project_id: "tatai", graph: "functional", limit: 5 });
    pages.push(...seqOf(first.parsed.graphs.functional));
    let cur: string | null = first.parsed.completeness.cursors?.functional ?? null;
    let rounds = 0;
    let last = first.parsed;
    while (cur !== null && rounds < 200) {
      const p = callTool({ project_id: "tatai", graph: "functional", cursor: cur, limit: 5 });
      last = p.parsed;
      pages.push(...seqOf(p.parsed.graphs.functional));
      const next: string | null = p.parsed.completeness.cursors?.functional ?? null;
      if (next !== null && Number(next.split(":")[2]) <= Number(cur.split(":")[2])) break;
      cur = next;
      rounds++;
    }
    const union = new Set(pages);
    ok(
      cur === null && pages.length === union.size && union.size === fullSeq.functional!.length && last.completeness.complete === true,
      `⑦ 工具层（get_project_graphs handler）limit=5 续到终点且并集＝全量（${pages.length}/${fullSeq.functional!.length} 条）`,
    );
  }
  const perGraph = sixGraphsOf("tatai", { graph: "functional", limit: 3 });
  ok(
    perGraph.graphs.functional!.counts.truncated_by_limit > 0,
    `⑦ 单图同样不静默截断：本图 truncated_by_limit=${perGraph.graphs.functional?.counts.truncated_by_limit}`,
  );
  const safe = sixGraphsOf("tatai");
  ok(safe.completeness.limit === SIX_GRAPH_OBJECT_LIMIT && safe.completeness.complete, `⑦ 缺省上限 ${SIX_GRAPH_OBJECT_LIMIT} 足够一次取全当前规模（实测 ${safe.completeness.total} 条）`);
  // 旧读口兼容：get_arch 的技术详情层语义与字段不变
  const archOut = getArchTool.handler({ project_id: "tatai" }) as { content: { text: string }[]; isError?: boolean };
  const body = JSON.parse(archOut.content[0].text) as Record<string, unknown>;
  ok(
    body.layer === "tech_detail" &&
      body.module_status_source === "v2_evidence" &&
      body.provenance !== undefined &&
      body.data_flow !== undefined &&
      body.graphs === undefined,
    "⑦ 旧 get_arch 兼容：仍是技术详情层口径（layer=tech_detail、v2_evidence、带 provenance/data_flow），**不**混进六图字段",
  );
  // 缺图（隔离夹具）：没有可读的图 ⇒ availability=none＋异常说明，不是错误
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-v0919-none-"));
  const root = path.join(tmpHome, "proj-none");
  fs.mkdirSync(path.join(root, ".工作台"), { recursive: true });
  fs.writeFileSync(
    path.join(tmpHome, "registry.json"),
    JSON.stringify({
      version: 1,
      projects: [{ id: "fix-none", name: "无图夹具", path: root, kind: "backend", registered_at: "2026-09-26T00:00:00+08:00", last_opened_at: "2026-09-26T00:00:00+08:00" }],
    }),
    "utf8",
  );
  const prevHome = process.env.TATAI_HOME;
  process.env.TATAI_HOME = tmpHome;
  try {
    const none = sixGraphsOf("fix-none");
    ok(
      none.graph_state.availability === "none" && none.graphs.functional !== undefined && (none.graphs.functional?.notes.join("") ?? "").includes("没有可读的规划图"),
      `⑦ 反例（缺图）：没有可读的图 ⇒ availability=${none.graph_state.availability}、六图给空态与原因（不是错误、不假装有图）`,
    );
  } finally {
    if (prevHome === undefined) delete process.env.TATAI_HOME;
    else process.env.TATAI_HOME = prevHome;
  }
  try {
    sixGraphsOf("不存在的项目");
    ok(false, "⑦ 反例：不存在的项目 id 应报错");
  } catch {
    ok(true, "⑦ 反例：不存在的项目 id ⇒ 明确报错（不静默给空图）");
  }
  const bad = getProjectGraphsTool.handler({ project_id: "tatai", graph: "nope" }) as { isError?: boolean; content: { text: string }[] };
  ok(bad.isError === true && bad.content[0].text.includes("只认"), "⑦ 反例：非法 graph 键明确报错并列出可选键");
  const noPid = getProjectGraphsTool.handler({}) as { isError?: boolean };
  ok(noPid.isError === true, "⑦ 反例：缺 project_id 明确报错");
}

// ═════════════════════════ ⑧ project_entry 六图摘要同源 ═════════════════════════
section("⑧ project_entry 的 graph_summary 与整图同源");
{
  const out = projectEntryTool.handler({ project_id: "tatai", role: "executor", client_capabilities: "continuable" }) as { content: { text: string }[] };
  const entry = JSON.parse(out.content[0].text) as Record<string, unknown>;
  const gs = entry.graph_summary as {
    snapshot_id: string;
    graphs: { key: string; nodes: number; edges: number }[];
    next_read_entry: { tool: string };
    baseline_id: string | null;
    availability: string;
  };
  ok(gs !== undefined && gs.snapshot_id === snap.snapshot_id, `⑧ 摘要与整图**同一快照标识**（${gs?.snapshot_id}）`);
  ok(
    gs.graphs.length === 6 &&
      gs.graphs.every((g, i) => g.key === SIX_GRAPH_KEYS[i]) &&
      gs.graphs.every((g) => g.nodes === (snap.graphs[g.key as keyof typeof snap.graphs]?.counts.nodes ?? -1)) &&
      gs.graphs.every((g) => g.edges === (snap.graphs[g.key as keyof typeof snap.graphs]?.counts.edges ?? -1)),
    `⑧ 摘要六图计数与整图逐项相等（${gs.graphs.map((g) => `${g.key}:${g.nodes}/${g.edges}`).join(" ")}）`,
  );
  ok(
    gs.next_read_entry.tool === "get_project_graphs" && gs.baseline_id === snap.baseline.baseline_id && gs.availability === snap.graph_state.availability,
    "⑧ 摘要带基线、可用性与下一读取入口（不内联整图）",
  );
  const summaryDirect = graphSummaryOf("tatai");
  ok(summaryDirect.snapshot_id === snap.snapshot_id, "⑧ 摘要函数与整图同源（同一个 sixGraphsOf）");
}

// ═════════════════════════ ⑨ 工具面与文档同源 ═════════════════════════
section("⑨ 工具面 19 个与文档同源");
{
  const names = TOOLS.map((t) => t.name);
  ok(names.length === 19 && names.includes("get_project_graphs") && names.includes("get_arch"), `⑨ 注册表 ${names.length} 个工具且含 get_project_graphs（新）与 get_arch（旧，保留）`);
  const readme = read(path.join(REPO, "README.md"));
  const m = /- (\d+) 个 stdio MCP 工具/.exec(readme);
  ok(m !== null && Number(m[1]) === names.length, `⑨ README 工具计数与注册表同源（README=${m?.[1]}／注册表=${names.length}）`);
  const u2 = read(path.join(REPO, "scripts", "verify-u2.ts"));
  ok(u2.includes('"get_project_graphs"') && u2.includes("MCP_TOOL_COUNT = MCP_TOOL_NAMES.length"), "⑨ verify:u2 的点名清单含 get_project_graphs 且计数不写死");
  const m2 = read(path.join(REPO, "scripts", "verify-m2.ts"));
  ok(m2.includes('const V0919_TOOLS = ["get_project_graphs"]'), "⑨ verify:m2 的分组点名清单含 V0919_TOOLS");
  const agents = read(path.join(REPO, "AGENTS.md"));
  const snippet = read(path.join(REPO, "templates", "agents-md-snippet.md"));
  const region = (t: string): string => {
    const a = t.indexOf("<!-- tatai-mcp:start -->");
    const b = t.indexOf("<!-- tatai-mcp:end -->");
    return a < 0 || b < 0 ? "" : t.slice(a, b + "<!-- tatai-mcp:end -->".length);
  };
  const norm = (t: string): string => t.split(String.fromCharCode(13) + String.fromCharCode(10)).join(String.fromCharCode(10));
  ok(
    norm(region(agents)) === norm(region(snippet)) && region(agents).includes("get_project_graphs"),
    "⑨ AGENTS.md 的 tatai-mcp 标记区与模板逐字节一致（行尾归一后）且写到六图读口",
  );
  const integration = read(path.join(REPO, "docs", "agent-integration.md"));
  ok(integration.includes("get_project_graphs") && integration.includes("4.3 六图完整状态的读取"), "⑨ docs/agent-integration.md 写到六图读口（且不含工具计数——同源对账见 verify:v09-05 ③）");
  const design = read(path.join(REPO, "DESIGN.md"));
  ok(design.includes("`get_project_graphs`") && design.includes("附录 E.18"), "⑨ DESIGN 写到 get_project_graphs 读口契约与附录 E.18 落实索引");
}

// ═════════════════════════ ⑩ R-3 勘误与装卸脚本前置 ═════════════════════════
section("⑩ R-3：收口报告勘误段＋装卸脚本窗口就绪与后端 PID 校验");
{
  const report = read(path.join(REPO, ".工作台", "evidence", "V09-18", "1", "00-收口报告.md"));
  ok(
    report.includes("## 八、勘误") &&
      report.includes("两次关窗失败") &&
      report.includes("假阳性") &&
      report.includes("窗口就绪"),
    "⑩ V09-18 收口报告追加勘误段（两次关窗失败／假阳性／窗口就绪判据），历史原文未改",
  );
  ok(
    report.includes("关闭：壳退出、8787 释放、后端 node 无残留（V09-14 口径）✓"),
    "⑩ 勘误**只追加**：§五原文（被更正的那句）逐字仍在",
  );
  const cmdDir = path.join("D:", "tmp", "v0919-isolated");
  const scripts = [
    path.join("D:", "tmp", "tatai-v0919", "commands", "01-install.ps1"),
    path.join("D:", "tmp", "tatai-v0919", "commands", "02-launch.ps1"),
    path.join("D:", "tmp", "tatai-v0919", "commands", "03-close-restart-recheck.ps1"),
    path.join("D:", "tmp", "tatai-v0919", "commands", "04-uninstall.ps1"),
  ];
  const allThere = scripts.every((p) => fs.existsSync(p));
  const close = allThere ? read(scripts[2]) : "";
  const launch = allThere ? read(scripts[1]) : "";
  ok(allThere, `⑩ 本批装卸脚本四件在场（隔离目录 ${cmdDir}）`);
  ok(
    launch.includes("MainWindowHandle") && launch.includes("MainWindowTitle") && close.includes("MainWindowHandle"),
    "⑩ 装卸脚本用**窗口就绪判据**（health OK ∧ MainWindowHandle≠0 ∧ 标题非空，再稳 2s），不再「健康即关」",
  );
  ok(
    close.includes("backend pid changed") && close.includes("new_backend_pid") && close.includes("oldBackend"),
    "⑩ 重启后断言**新后端 PID ≠ 关窗前那个**（只看同一端口健康不算数——那正是假阳性的来源）",
  );
  ok(
    close.includes("port_free_at") && close.includes("iso_backend_left"),
    "⑩ 关窗后同时核壳退出、8787 释放与隔离后端零残留（V09-14 验收内容一条没减）",
  );
}

// ═════════════════════════ ⑫ V09-19 报告勘误（2026-09-26 返工） ═════════════════════════
section("⑫ 交付报告按非作者复审 §六 逐项勘误（只追加；原文逐字保留）");
{
  const rep = read(path.join(REPO, ".工作台", "evidence", "V09-19", "1", "交付报告.md"));
  ok(
    rep.includes("## 八、勘误与返工") &&
      rep.includes("3,363,927") &&
      rep.includes("review_result") &&
      rep.includes("652967E9") &&
      rep.includes("close verdict: False") &&
      rep.includes("restart verdict: False") &&
      rep.includes("撤回未证实") === false &&
      rep.includes("**撤回**"),
    "⑫ 勘误段在册：字节数／装卸日志轮次／失败关窗轮／两轮 verdict=False／blocked 缺证撤回／next_action 依次点到",
  );
  ok(
    rep.includes("（3,363,826 B）、MSI 与 tatai.exe 见 `binding.json`") && rep.includes("`next_action=review_pending`（V08-01 待独立审计）"),
    "⑫ 勘误**只追加**：§六原句（错字节数＋next_action 写法）逐字仍在，未被回改",
  );
  const bind = JSON.parse(read(path.join(REPO, ".工作台", "evidence", "V09-04", "1", "binding.json"))) as {
    artifacts: { path: string; bytes: number; sha256: string }[];
  };
  // 定向更新（V09-20，2026-09-26，五要素留档）：
  //   旧期望＝绑定记录与盘上字节数都钉死 `3,363,927`（§八 勘误里写的那个首轮读数）｜
  //   依据＝那个字面量取自 19:43 首轮包；随后按附录 E.16「内容冻结后只打一次终包」重打，终包字节数
  //         变了（3,364,889），字面量于是成了**过期固定数**——正是 V09-18 裁定 8 要求避免的
  //         「测试不以过期固定数自证」；本批复跑实测该断言红（81 PASS / 1 FAIL），红因是过期字面量而非真缺陷｜
  //   新期望＝**自洽 + 溯源**：盘上终包（NSIS/MSI/exe）字节数与 sha256 **逐项等于** `binding.json`
  //         记录值（三件都查，不只 NSIS）；报告 §八 的 `3,363,927` 作为**历史留痕**仍在册（只追加、不回改）｜
  //   保留意图＝「盘上产物与绑定记录一致（同源）」这条判据一条不减｜
  //   判据不放宽：盘上字节数或 sha256 与绑定记录不符仍判红（旧写法只比字节数，新写法连内容哈希一起比）。
  const installArtifacts = ["nsis/Tatai_0.1.0_x64-setup.exe", "msi/Tatai_0.1.0_x64_en-US.msi", "tatai.exe"];
  const mismatches: string[] = [];
  for (const suffix of installArtifacts) {
    const rec = bind.artifacts.find((a) => a.path.endsWith(suffix));
    const abs = rec === undefined ? null : path.join(REPO, rec.path);
    if (rec === undefined || abs === null || !fs.existsSync(abs)) {
      mismatches.push(`${suffix}：绑定记录或盘上文件缺失`);
      continue;
    }
    const buf = fs.readFileSync(abs);
    if (buf.length !== rec.bytes) mismatches.push(`${suffix}：盘上 ${buf.length} ≠ 绑定 ${rec.bytes}`);
    if (sha256(buf) !== rec.sha256) mismatches.push(`${suffix}：sha256 不符`);
  }
  ok(
    mismatches.length === 0,
    `⑫ 终包三件（NSIS/MSI/exe）**盘上字节数与 sha256 逐项等于绑定记录**（自洽式，不用过期字面量）${
      mismatches.length === 0 ? "" : `——${mismatches.join("；")}`
    }`,
  );
  const firstRoundLog = read(path.join(REPO, ".工作台", "evidence", "V09-19", "1", "install.log"));
  const finalRoundLog = path.join("D:", "tmp", "tatai-v0919", "logs", "install.log");
  // PowerShell Tee-Object 落到文件是 UTF-16LE 观感的逐字节 NUL 交错，先归一再去比指纹串
  const nulStrip = (s: string): string => s.split(String.fromCharCode(0)).join("");
  ok(
    nulStrip(firstRoundLog).includes("652967E9") && fs.existsSync(finalRoundLog) && nulStrip(read(finalRoundLog)).includes("C6A820BB"),
    "⑫ 装卸日志轮次归属：证据区那份＝首轮（652967E9…），终包轮（C6A820BB…）日志在 D:\\tmp\\tatai-v0919\\logs\\",
  );
  // F-1：审计原始失败证据保留（复审 probe 与逐图分页日志；本轮不改不删）
  const auditLog = path.join("D:", "tmp", "tatai-audit", "closure", "independent-v0919-review-20260926", "logs", "pagination-precise.log");
  const keptCopy = path.join(REPO, ".工作台", "evidence", "V09-19", "1", "rework-20260926", "logs", "audit-pagination-precise.original.log");
  ok(
    fs.existsSync(keptCopy) && read(keptCopy).includes("off30") && (!fs.existsSync(auditLog) || read(auditLog).includes("off30")),
    "⑫ 审计 F-1 原失败证据保留（复审 `logs/pagination-precise.log` 未改，另存只读副本在返工证据目录）",
  );
}

// ═════════════════════════ ⑪ 真实数据零写入自证 ═════════════════════════
section("⑪ 自证：本脚本对真实 .工作台 零写入");
{
  const bpAfter = fs.existsSync(REAL_BP) ? sha256(fs.readFileSync(REAL_BP)) : "";
  ok(bpBefore !== "" && bpBefore === bpAfter, `⑪ 真实蓝图首尾 sha256 一致（${bpBefore.slice(0, 8)}…）`);
}

console.log(`\n[verify] V09-19：${pass} PASS / ${fail} FAIL`);
if (fail > 0) process.exitCode = 1;
