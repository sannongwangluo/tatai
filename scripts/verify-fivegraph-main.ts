// 功能全景 + 系统架构（本轮 Kimi Flash 负责的两张主视图）定向回归：`pnpm exec tsx scripts/verify-fivegraph-main.ts`
//
// 覆盖三件事（判据来源逐条写在断言里，不另立口径）：
//   ① **成员账目 ≠ 视图成员名单**：成员资格的**来源**只有唯一账目一处（`featureScope.scopeMemberLedgerOf`），
//      而**本视图的成员 kind 仍由视图口径定**（`PROJECT_VIEWS[view].member_kinds`，DESIGN §3.2 表格第三列：
//      功能全景＝模块＋任务、系统架构＝模块）。成员还必须是蓝图节点（画不出来、点不开的不算"已经在分组里"）。
//   ② **账目恒等式（不许静默丢关系）**：本视图声明的关系逐条归入 `edges`／`intra_relations`／`unresolved_relations`
//      三桶之一；落空成因按 `UnresolvedEndpointReason` 分类，**合理折叠/分类排除与真实缺口分开**（§3.2／§3.3／§4.5）。
//   ③ **真实蓝图对账**：架构分组不再混进任务成员；功能全景的能力节点有设计出处；design_interface 逐条有归类；
//      与 P11 画布缺口判据（`canvasMembershipGapsOf`）同一份事实。
//
// 隔离口径（本脚本自己守）：真实 `.工作台` **一个字节都不写**——只读蓝图，首尾各取一次 sha256（变了就 FAIL）。
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { readBlueprint, type Blueprint, type BlueprintEdge, type BlueprintNode } from "../src/arch/blueprint";
import { capabilityMemberViaOf, scopeMemberLedgerOf } from "../src/arch/featureScope";
import {
  PROJECT_VIEWS,
  buildViewModel,
  canvasMembershipGapsOf,
  UNRESOLVED_REAL_GAP_REASONS,
  unresolvedRelationsNoteOf,
  type ProjectViewKind,
  type ProjectViewModel,
  type UnresolvedRelation,
} from "../src/ui/arch/projectGraph";
import { DELIVERY_REQUESTABLE_CONCLUSION, type DeliveryReadout } from "../src/ui/arch/provenance";
import { GraphAttentionBar, UnresolvedRelationsPanel, attentionCountsOf } from "../src/ui/arch/ProvenancePanel";

let pass = 0;
let fail = 0;
let skip = 0;
const ok = (cond: boolean, label: string): void => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (cond) pass++;
  else {
    fail++;
    process.exitCode = 1;
  }
};
const info = (m: string): void => console.log(`[verify]   ${m}`);
const skipped = (m: string): void => {
  console.log(`[verify] SKIP ${m}`);
  skip++;
};
const section = (t: string): void => console.log(`\n[verify] ── ${t}`);
const sha256File = (f: string): string | null =>
  fs.existsSync(f) ? crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex") : null;

// ───────────────────────────── 真实数据段（只读） ─────────────────────────────

const REAL_DATA_DIR =
  (process.env.TATAI_HOME ?? "").trim() !== "" ? process.env.TATAI_HOME!.trim() : path.join(os.homedir(), ".tatai");
const realProjectPath = ((): string | null => {
  try {
    const reg = JSON.parse(fs.readFileSync(path.join(REAL_DATA_DIR, "registry.json"), "utf8")) as {
      projects?: { id?: unknown; path?: unknown }[];
    };
    const hit = (reg.projects ?? []).find((p) => p.id === "tatai");
    return typeof hit?.path === "string" ? hit.path : null;
  } catch {
    return null;
  }
})();
const realBlueprintFile =
  realProjectPath === null ? null : path.join(realProjectPath, ".工作台", "arch", "blueprint.json");
const realHashBefore = realBlueprintFile === null ? null : sha256File(realBlueprintFile);
info(`真实数据目录：${REAL_DATA_DIR}`);
info(`真实项目根：${realProjectPath ?? "（本机取不到 tatai 注册项）"}`);
info(`真实蓝图：${realBlueprintFile ?? "n/a"}；sha256（前）：${realHashBefore?.slice(0, 16) ?? "n/a"}`);

function readRealBlueprint(): Blueprint | null {
  try {
    return readBlueprint("tatai", REAL_DATA_DIR);
  } catch {
    return null;
  }
}

// ───────────────────────────── 夹具 ─────────────────────────────

const ref = (locator: string) => ({
  kind: "design_section" as const,
  path: "fixture.md",
  locator,
  sha256: locator.padEnd(64, "0").slice(0, 64),
});
const fnode = (id: string, kind: BlueprintNode["kind"], name: string): BlueprintNode => ({
  id,
  kind,
  name,
  source_refs: [ref(id)],
  related_ids: [],
});
const fedge = (
  source: string,
  target: string,
  kind: BlueprintEdge["kind"],
  certainty: BlueprintEdge["certainty"] = kind === "implementation_map" ? "observed" : "declared",
): BlueprintEdge => ({ source, target, kind, source_refs: [ref(`${source}->${target}`)], certainty });
const fblueprint = (
  nodes: BlueprintNode[],
  edges: BlueprintEdge[],
  capability_classes?: Blueprint["capability_classes"],
): Blueprint => ({
  version: 1,
  baseline_id: "bl-fivegraph-main",
  generator_version: "v06-05.1",
  generated_at: "2026-10-08T00:00:00+08:00",
  source_manifest: [],
  nodes,
  edges,
  ...(capability_classes === undefined ? {} : { capability_classes }),
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
  publish: { published: true, reason: null, validated_at: "2026-10-08T00:00:01+08:00" },
  based_on: {
    model_key: "mk",
    full_key: "fk",
    design_content_sha256: "design-v1",
    plan_definition_sha256: "plan-v1",
    semantic: false,
  },
});
const kindOf = (bp: Blueprint, id: string): string => bp.nodes.find((n) => n.id === id)?.kind ?? "(缺节点)";

/** 三桶归类（与产品模型同一份输出，不另写一套解析）：每条本视图关系恰好落一桶 */
function bucketOf(
  model: ProjectViewModel,
  bp: Blueprint,
  view: ProjectViewKind,
): { total: number; edges: number; intra: number; unresolved: number; missing: string[] } {
  const kinds = new Set<string>(PROJECT_VIEWS[view].edge_kinds);
  const edgeIds = new Set(model.edges.map((e) => e.id));
  const intraIds = new Set(model.intra_relations.map((e) => e.id));
  const unresIds = new Set(model.unresolved_relations.map((e) => e.id));
  let total = 0;
  let edges = 0;
  let intra = 0;
  let unresolved = 0;
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const e of bp.edges) {
    if (!kinds.has(e.kind)) continue;
    total++;
    const id = `${e.source}>${e.target}:${e.kind}`;
    if (seen.has(id)) continue; // 同 id 的多条蓝图关系会被去重成一条可见线，计数只算一次（与 `seen` 同口径）
    seen.add(id);
    if (edgeIds.has(id)) edges++;
    else if (intraIds.has(id)) intra++;
    else if (unresIds.has(id)) unresolved++;
    else missing.push(id);
  }
  return { total, edges, intra, unresolved, missing };
}

// ══════════════════ ① 成员账目 ≠ 视图成员名单（夹具正反例） ══════════════════

section("① 成员账目（唯一来源）与视图成员名单（`member_kinds`）分开：架构只列模块、功能列模块＋任务");
{
  ok(
    PROJECT_VIEWS.functional.member_kinds.join(",") === "module,task" &&
      PROJECT_VIEWS.architecture.member_kinds.join(",") === "module" &&
      PROJECT_VIEWS.construction.member_kinds.length === 0,
    "三视图成员 kind 声明未动（功能＝module+task、架构＝module、施工依赖＝不分组）——本轮修的是实现按它过滤，不改声明",
  );
  // 夹具：cap:01 的成员账目含 声明模块 mod:a ＋ 任务 T-1（task_design_ref）＋ 派生代码模块 src-x（observed 实现映射）
  //       另有一条**只有声明映射**的 orphan（declared 不派生归属）与一条指向**不做节点**的 ghost 的关系
  const bp = fblueprint(
    [
      fnode("plan:cap:01", "capability", "1. 甲"),
      fnode("plan:mod:a", "module", "声明模块 a"),
      fnode("plan:code:src-x", "module", "src-x"),
      fnode("plan:task:T-1", "task", "T-1"),
      fnode("plan:code:orphan", "module", "orphan"),
    ],
    [
      fedge("plan:cap:01", "plan:mod:a", "design_interface"),
      fedge("plan:task:T-1", "plan:cap:01", "task_design_ref"),
      fedge("plan:task:T-1", "plan:code:src-x", "implementation_map"),
      fedge("plan:task:T-1", "plan:code:orphan", "implementation_map", "declared"),
      fedge("plan:task:T-1", "plan:code:ghost", "implementation_map"), // 靶点不做节点
    ],
  );
  const ledger = scopeMemberLedgerOf(bp);
  const via = capabilityMemberViaOf(bp.edges, new Set(["plan:cap:01"]));
  info(`夹具账目 cap:01 = ${(ledger["plan:cap:01"]?.member_ids ?? []).join("、")}（via：${JSON.stringify(via["plan:cap:01"])}）`);
  info("口径说明：成员账目由 `featureScope` 一处枚举（声明归属 ＋ observed 实现映射的二级派生）——下面用行为断言它的性质，不用固定名单自证");
  ok(
    (via["plan:cap:01"]?.["plan:task:T-1"] ?? []).includes("task_design_ref") &&
      (via["plan:cap:01"]?.["plan:code:src-x"] ?? []).includes("implementation_map") &&
      via["plan:cap:01"]?.["plan:code:orphan"] === undefined &&
      via["plan:cap:01"]?.["plan:code:ghost"] !== undefined,
    "成员账目视图无关且只认 observed 派生：T-1（声明）与 src-x（实测派生）在场；declared 的 orphan **不**派生归属；ghost 有边就如实进账（能不能画出来是另一回事）",
  );

  const f = buildViewModel({ view: "functional", blueprint: bp, projection: {} });
  const a = buildViewModel({ view: "architecture", blueprint: bp, projection: {} });
  const fmembers = f.groups.find((g) => g.key === "plan:cap:01")?.members ?? [];
  const amembers = a.groups.find((g) => g.key === "plan:cap:01")?.members ?? [];
  info(`功能全景 cap:01 成员 = ${fmembers.join("、")}`);
  info(`系统架构 cap:01 成员 = ${amembers.join("、")}`);
  ok(
    fmembers.join(",") === "plan:mod:a,plan:code:src-x,plan:task:T-1",
    `功能全景成员＝账目 ∩ {module,task} ∩ 蓝图节点，顺序＝蓝图节点顺序（${fmembers.join("、")}）`,
  );
  ok(
    amembers.join(",") === "plan:mod:a,plan:code:src-x",
    `系统架构成员＝账目 ∩ {module}（**任务不进架构分组**，§3.2 表格第三列：架构回答「由哪些模块协作实现」；${amembers.join("、")}）`,
  );
  ok(
    a.groups.every((g) => g.members.every((m) => (PROJECT_VIEWS.architecture.member_kinds as readonly string[]).includes(kindOf(bp, m)))),
    "架构视图**任何**分组的成员都只含本视图 member_kinds 的节点 kind（成员名单不再混进任务）",
  );
  ok(
    a.groups.every((g) => g.members.every((m) => bp.nodes.some((n) => n.id === m))),
    "架构视图分组成员**全部是蓝图节点**（画不出来、点不开的成员不当成「已经在分组里」）",
  );
  // ghost：端点不在蓝图节点集里 ⇒ 真实缺口（不许被"归属账目"悄悄收编成一个正常关系）
  const ghostGap = a.unresolved_relations.find((r) => r.missing_id === "plan:code:ghost");
  ok(
    ghostGap !== undefined &&
      ghostGap.reason === "missing_node" &&
      ghostGap.unresolved_end === "target" &&
      UNRESOLVED_REAL_GAP_REASONS.includes(ghostGap.reason) &&
      a.groups.every((g) => !g.members.includes("plan:code:ghost")),
    `有边但节点缺席的靶点进 unresolved_relations 并按 missing_node 点名（${ghostGap?.id ?? "缺"}；` +
      "归属账目里有它、画布上却没有它 ⇒ 不当成「已经在分组里」）",
  );
}

// ══════════════════ ② 账目恒等式 + 落空成因分类（四类反例） ══════════════════

section("② 账目恒等式：一条关系要么有归类、要么被点名；落空成因分「合理折叠/分类排除」与「真实缺口」");
{
  // (a) folded_group：16 个能力 ⇒ 概览折叠，靶点落在被折叠分组里
  const nodes: BlueprintNode[] = [];
  const edges: BlueprintEdge[] = [];
  for (let i = 1; i <= 16; i++) {
    const n = String(i).padStart(2, "0");
    nodes.push(fnode(`plan:cap:${n}`, "capability", `${i}. 能力${i}`));
    nodes.push(fnode(`plan:mod:${n}`, "module", `模块${n}`));
    edges.push(fedge(`plan:cap:${n}`, `plan:mod:${n}`, "design_interface"));
  }
  nodes.push(fnode("plan:task:T-1", "task", "T-1"));
  edges.push(fedge("plan:task:T-1", "plan:cap:01", "task_design_ref"));
  edges.push(fedge("plan:task:T-1", "plan:mod:16", "implementation_map"));
  const bpFold = fblueprint(nodes, edges);
  const vmFold = buildViewModel({ view: "architecture", blueprint: bpFold, projection: {} });
  const folded = vmFold.unresolved_relations.filter((r) => r.reason === "folded_group");
  ok(
    vmFold.aggregate_node !== null &&
      folded.length === 1 &&
      folded[0].missing_id === "plan:mod:16" &&
      UNRESOLVED_REAL_GAP_REASONS.includes(folded[0].reason) === false,
    `合理折叠如实归类为 folded_group 且**不计入真实缺口**（靶点 ${folded[0]?.missing_id ?? "缺"}；显示全部/展开后可见，§3.3）`,
  );
  const bFold = bucketOf(vmFold, bpFold, "architecture");
  ok(
    bFold.missing.length === 0 && bFold.total === bFold.edges + bFold.intra + bFold.unresolved,
    `折叠夹具三桶恒等式：total=${bFold.total} = 可见线 ${bFold.edges} + 同组 ${bFold.intra} + 落空 ${bFold.unresolved}（无未归类）`,
  );

  // (b) governance_excluded：功能全景排除设计/治理章节 ⇒ 其关系落空但**不是**缺口。
  //     反例要点：`T-2` 的**唯一**归属是治理章节（它自己没有可见归属）——这一条曾被错判成 `folded_group`
  //     （那会把它说成"折叠起来、点开就能看见"，而它在功能全景里根本不该出现），必须按分类口径归类。
  const bpGov = fblueprint(
    [
      fnode("plan:cap:01", "capability", "1. 项目概述"),
      fnode("plan:cap:02", "capability", "2. 核心概念"),
      fnode("plan:task:T-1", "task", "T-1"),
      fnode("plan:task:T-2", "task", "T-2 只引治理章节"),
    ],
    [
      fedge("plan:task:T-1", "plan:cap:01", "task_design_ref"),
      fedge("plan:task:T-1", "plan:cap:02", "task_design_ref"),
      fedge("plan:task:T-2", "plan:cap:01", "task_design_ref"),
    ],
    { declared: true, by_capability: { "plan:cap:01": "governance", "plan:cap:02": "functional" }, note: "fixture" },
  );
  const vmGov = buildViewModel({ view: "functional", blueprint: bpGov, projection: {} });
  ok(
    vmGov.unresolved_relations.length === 2 &&
      vmGov.unresolved_relations.every((r) => r.reason === "governance_excluded") &&
      vmGov.unresolved_relations.some((r) => r.missing_id === "plan:cap:01") &&
      vmGov.unresolved_relations.some((r) => r.missing_id === "plan:task:T-2") &&
      UNRESOLVED_REAL_GAP_REASONS.includes("governance_excluded") === false,
    `分类排除（含**只**归属治理章节的任务，${vmGov.unresolved_relations.map((r) => r.missing_id).join("、")}）如实归类为 governance_excluded、` +
      "**不计入真实缺口**，也**不**被误写成「折叠后可见」（§3.2 能力分类声明）",
  );

  // (c) no_ownership：任务无 task_design_ref（无能力归属）⇒ 真实缺口、逐条点名
  const bpOrphan = fblueprint(
    [fnode("plan:cap:01", "capability", "1. 甲"), fnode("plan:code:root", "module", "root"), fnode("plan:task:DES-X", "task", "DES-X")],
    [fedge("plan:cap:01", "plan:code:root", "design_interface"), fedge("plan:task:DES-X", "plan:code:root", "implementation_map")],
  );
  const vmOrphan = buildViewModel({ view: "architecture", blueprint: bpOrphan, projection: {} });
  const orphan = vmOrphan.unresolved_relations;
  ok(
    orphan.length === 1 &&
      orphan[0].reason === "no_ownership" &&
      orphan[0].unresolved_end === "source" &&
      orphan[0].missing_id === "plan:task:DES-X" &&
      UNRESOLVED_REAL_GAP_REASONS.includes("no_ownership"),
    `无归属端点（任务没有能力归属）如实归类为 no_ownership 并**计入真实缺口**（${orphan[0]?.missing_id ?? "缺"}；§4.5 待归属）`,
  );
  const noteOrphan = unresolvedRelationsNoteOf(orphan);
  ok(
    noteOrphan.includes("真实缺口") && noteOrphan.includes("plan:task:DES-X") && noteOrphan.includes("待归属"),
    "口径句逐条点名并标【真实缺口】——不把真实缺口混进「合理结果」里（§3.2／§4.5）",
  );

  // (d) missing_node：端点不在蓝图节点集里 ⇒ 真实缺口
  const bpMiss = fblueprint(
    [fnode("plan:cap:01", "capability", "1. 甲"), fnode("plan:code:root", "module", "root")],
    [fedge("plan:task:GHOST", "plan:code:root", "implementation_map")],
  );
  const vmMiss = buildViewModel({ view: "architecture", blueprint: bpMiss, projection: {} });
  ok(
    vmMiss.unresolved_relations.length === 1 && vmMiss.unresolved_relations[0].reason === "missing_node",
    `端点不在蓝图节点集里如实归类为 missing_node（${vmMiss.unresolved_relations[0]?.missing_id ?? "缺"}）`,
  );

  // (e) 正例：有归属的靶点照常画得出跨组线（不许为了"恒等式好看"把线丢掉）
  const bpCross = fblueprint(
    [
      fnode("plan:cap:01", "capability", "1. 甲"),
      fnode("plan:cap:02", "capability", "2. 乙"),
      fnode("plan:mod:d", "module", "模块 d"),
      fnode("plan:task:T-9", "task", "T-9"),
    ],
    [
      fedge("plan:cap:02", "plan:mod:d", "design_interface"),
      fedge("plan:task:T-9", "plan:cap:01", "task_design_ref"),
      fedge("plan:task:T-9", "plan:mod:d", "implementation_map"),
    ],
  );
  const vmCross = buildViewModel({ view: "architecture", blueprint: bpCross, projection: {} });
  ok(
    vmCross.edges.some((e) => e.id === "plan:cap:01>plan:cap:02:implementation_map") &&
      vmCross.unresolved_relations.length === 0 &&
      vmCross.edges.every((e) => vmCross.nodes.some((n) => n.id === e.from) && vmCross.nodes.some((n) => n.id === e.to)),
    "正例：两端有归属的实测映射照常画成跨组线（没悬空、没落空）——账目恒等式不靠丢线凑数",
  );
}

// ══════════════════ ③ 真实蓝图对账（只读） ══════════════════

section("③ 真实塔台蓝图：成员 kind、归类恒等式、能力来源、P11 画布缺口");
const realBp = realProjectPath === null ? null : readRealBlueprint();
if (realBp === null) {
  skipped("取不到真实 tatai 蓝图（registry 无 tatai 项或尚未派生过蓝图）——③ 整段 SKIP；①② 夹具段照跑");
} else {
  const capIds = new Set(realBp.nodes.filter((n) => n.kind === "capability").map((n) => n.id));
  info(`真实蓝图：${realBp.nodes.length} 节点 / ${realBp.edges.length} 边；基线 ${realBp.baseline_id}`);
  const functional = buildViewModel({ view: "functional", blueprint: realBp, projection: {} });
  const architecture = buildViewModel({ view: "architecture", blueprint: realBp, projection: {} });

  // ③-1 架构分组成员只有模块；功能全景成员是模块或任务
  ok(
    architecture.groups.every((g) =>
      g.members.every((m) => realBp.nodes.find((n) => n.id === m)?.kind === "module"),
    ) && architecture.groups.some((g) => g.members.length > 0),
    `系统架构 ${architecture.groups.length} 个分组的成员**全部是模块**（不再混进任务；"哪些模块协作实现"才读得出来）`,
  );
  ok(
    functional.groups.every((g) =>
      g.members.every((m) => ["module", "task"].includes(realBp.nodes.find((n) => n.id === m)?.kind ?? "")),
    ),
    "功能全景分组成员是模块或任务（两 kind 都在本视图 member_kinds 里）",
  );
  // ③-2 账目恒等式（两视图）
  for (const view of ["functional", "architecture"] as ProjectViewKind[]) {
    const model = view === "functional" ? functional : architecture;
    const b = bucketOf(model, realBp, view);
    ok(
      b.missing.length === 0 && b.total === b.edges + b.intra + b.unresolved,
      `真实蓝图 ${view}：${b.total} 条本视图关系逐条有归类（可见线 ${b.edges} + 同组 ${b.intra} + 落空 ${b.unresolved}；未归类 ${b.missing.length} 条）`,
    );
    const note = unresolvedRelationsNoteOf(model.unresolved_relations);
    ok(
      model.unresolved_relations.length === 0 || model.notes.some((n) => n.includes("关系未画出")),
      `真实蓝图 ${view}：落空关系在口径句里逐条点名（${model.unresolved_relations.length} 条）——不静默丢关系`,
    );
    if (model.unresolved_relations.length > 0) info(note.replace(/\n/g, " / ").slice(0, 400));
  }
  // ③-3 架构落空的两条：成因是"任务无能力归属"（真实缺口），逐条点名
  const archRealGaps = architecture.unresolved_relations.filter((r) => UNRESOLVED_REAL_GAP_REASONS.includes(r.reason));
  ok(
    archRealGaps.every((r) => r.reason === "no_ownership" && r.unresolved_end === "source") &&
      archRealGaps.every((r) => archRealGaps.filter((x) => x.missing_id === r.missing_id).length >= 1),
    `系统架构的真实缺口逐条可点名（${archRealGaps.map((r) => r.missing_id).filter((v, i, a) => a.indexOf(v) === i).join("、") || "无"}）：` +
      "无能力归属的任务（没有 task_design_ref）的实测映射在本视图落空——如实报缺，不当成「已归类」",
  );
  // ③-4 功能全景的能力节点都有设计出处与功能分类；且**不擅自合并**新功能身份（§2.5.1 别名边界）
  const fc = functional.nodes.filter((n) => n.kind === "capability");
  ok(
    fc.length > 0 &&
      fc.every((n) => n.capability_class === "functional") &&
      fc.every((n) => n.sources.some((s) => s.kind === "design_section" && /DESIGN\.md$/.test(s.path))),
    `功能全景 ${fc.length} 个能力节点**都有设计书出处**（design_section→DESIGN.md）且分类＝功能能力（治理章节不在本视图，§3.2 声明表）`,
  );
  const graphIdSpace = [
    ...new Set([
      ...realBp.nodes.map((n) => n.id),
      ...realBp.edges.flatMap((e) => [e.source, e.target]),
    ]),
  ];
  ok(
    fc.every((n) => n.id.startsWith("plan:cap:")) && !graphIdSpace.some((id) => id.startsWith("cap-loop-")),
    "图像身份空间＝`plan:cap:*`：新功能清单的 `cap-loop-*` **不被自动并进来**（§2.5.1「互不映射、互不涂绿」，别名边界属另一次设计裁定）",
  );
  // ③-5 design_interface（职责/归属映射）逐条有归类、带出处；架构建组节点全在本次画布上
  const di = realBp.edges.filter((e) => e.kind === "design_interface");
  const diIds = new Set(di.map((e) => `${e.source}>${e.target}:${e.kind}`));
  const classified = new Set([
    ...architecture.edges.map((e) => e.id),
    ...architecture.intra_relations.map((e) => e.id),
    ...architecture.unresolved_relations.map((e) => e.id),
  ]);
  ok(
    di.length > 0 && [...diIds].every((id) => classified.has(id)),
    `系统架构里 ${di.length} 条 design_interface 逐条有归类（可见线/同组关系/落空三桶之一）——归属映射不是"看不见"`,
  );
  ok(
    architecture.intra_relations.every(
      (e) => e.sources.length > 0 && e.group_key !== undefined && architecture.nodes.some((n) => n.id === e.group_key),
    ),
    `架构 ${architecture.intra_relations.length} 条同组关系逐条带出处、且落在本次画出的分组节点上（§3.2 同组关系可见性）`,
  );
  // ③-6 P11 画布缺口（与 canvasMembershipGapsOf 同一份事实）
  const gaps = canvasMembershipGapsOf({ blueprint: realBp, projection: {} });
  ok(
    gaps.length === 0,
    `真实蓝图 P11 复算 0 缺口（功能全景逐任务、系统架构逐模块靶点、聚合可达、未归属端点四侧全过；红则逐条：${gaps
      .map((g) => `${g.capability_id}/${g.view}`)
      .join("、")}）`,
  );
}

// ══════════════════ ④ 隔离自证 ══════════════════

section("④ 隔离自证：真实 .工作台 零写入");
const realHashAfter = realBlueprintFile === null ? null : sha256File(realBlueprintFile);
ok(
  realHashBefore === null || realHashBefore === realHashAfter,
  `真实蓝图首尾 sha256 一致（${realHashAfter?.slice(0, 16) ?? "n/a"}）——本脚本只读，没写真实 .工作台`,
);

// ══════════════════ ⑤ 「关系未画出」的人可见入口（UI 落地） ══════════════════
//
// 第一阶段遗漏项（REPORT §3.2 自述）：「unresolved_relations 只在 data-* 与 notes 前 6 条里可见」——
// 对人不可逐条到达。本段钉住补齐后的真实入口（判据仍只有一份：`UNRESOLVED_REAL_GAP_REASONS`）：
//   · 真实缺口（no_ownership／missing_node）⇒ 唯一 `GraphAttentionBar` 出现并给计数，完整名单在其按需详情里；
//   · 合理结果（folded_group／governance_excluded）**不计入异常**，但经工具条入口仍逐条可达（不藏掉）；
//   · 逐条给 ID／端点／成因／出处；能跳可见对象就给按钮、没有就给**原因文本**（不做假跳转）；
//   · 不传这份账的旧调用者行为一字不变（可选 prop，最小接口）。
section("⑤ 「关系未画出」的人可见入口：真实缺口进信息栏计数、合理结果经工具条入口仍可达");
{
  const src = (locator: string) => ({ kind: "design_section" as const, path: "DESIGN.md", locator, sha256: "0".repeat(64) });
  const urel = (o: {
    source: string;
    target: string;
    kind: UnresolvedRelation["kind"];
    end: "source" | "target";
    missing: string;
    reason: UnresolvedRelation["reason"];
  }): UnresolvedRelation => ({
    id: `${o.source}>${o.target}:${o.kind}`,
    kind: o.kind,
    certainty: "declared",
    source: o.source,
    target: o.target,
    unresolved_end: o.end,
    missing_id: o.missing,
    reason: o.reason,
    sources: [src(`${o.source}->${o.target}`)],
  });
  // 两类真实缺口 + 两类合理结果，一次把四个成因都覆盖
  const gapNoOwn = urel({ source: "plan:task:DES-V06", target: "plan:code:root", kind: "implementation_map", end: "source", missing: "plan:task:DES-V06", reason: "no_ownership" });
  const gapMissNode = urel({ source: "plan:cap:01", target: "plan:code:ghost", kind: "implementation_map", end: "target", missing: "plan:code:ghost", reason: "missing_node" });
  const folded = urel({ source: "plan:cap:01", target: "plan:mod:16", kind: "implementation_map", end: "target", missing: "plan:mod:16", reason: "folded_group" });
  const gov = urel({ source: "plan:cap:11", target: "plan:mod:11.1-01", kind: "design_interface", end: "source", missing: "plan:cap:11", reason: "governance_excluded" });
  const gapsOnly = [gapNoOwn, gapMissNode];
  const reasonableOnly = [folded, gov];
  const all = [...gapsOnly, ...reasonableOnly];

  const healthy: DeliveryReadout = {
    verdict: "requestable",
    conclusion: DELIVERY_REQUESTABLE_CONCLUSION,
    deliverable_allowed: true,
    user_accepted: false,
    reasons: [],
    user_pending: [],
    counts: {
      objects: 3, unmapped: 0, verified: 3, verified_source_mapping: 0, verified_functional: 3, user_pending: 0,
      unverified: 0, missing: 0, invalidated: 0, capability_functional: 2, capability_governance: 0, capability_unclassified: 0,
    },
    note: "fixture",
  };

  // (1) 判据：真实缺口计入异常；合理结果与「不传」都不改变健康态（旧调用者不受影响）
  const cGaps = attentionCountsOf(healthy, [], [], gapsOnly);
  ok(
    cGaps.any === true && cGaps.unresolved_gaps.total === 2 && cGaps.unresolved_gaps.no_ownership === 1 && cGaps.unresolved_gaps.missing_node === 1,
    `真实缺口计入信息栏异常并分类计数（no_ownership ${cGaps.unresolved_gaps.no_ownership} / missing_node ${cGaps.unresolved_gaps.missing_node}）——机械关系缺口，不改交付判词`,
  );
  const cReasonable = attentionCountsOf(healthy, [], [], reasonableOnly);
  ok(
    cReasonable.any === false && cReasonable.unresolved_gaps.total === 0,
    "合理折叠/分类排除**不计入**异常：只有合理结果时信息栏仍是健康态、不占常驻行（§3.3 合理折叠／§3.2 分类排除）",
  );
  const cLegacy = attentionCountsOf(healthy, [], []);
  ok(
    cLegacy.any === false && cLegacy.unresolved_gaps.total === 0,
    "不传 unresolved（技术三图/思维导图等旧调用点）行为一字不变——可选 prop，最小接口不破坏旧调用者",
  );

  // (2) 渲染：真实缺口 ⇒ 恰好一条合并栏 + 默认行给计数；完整名单（含合理结果）在其按需详情里逐条在场
  const attr = (v: string): string => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
  const html = renderToStaticMarkup(
    React.createElement(GraphAttentionBar, {
      delivery: healthy,
      unresolvedRelations: all,
      resolveUnresolvedTarget: (id: string) => (id === "plan:code:root" ? "root 模块" : null),
      onOpenUnresolvedTarget: () => undefined,
      anchor: "project-architecture",
    }),
  );
  ok(
    (html.match(/<summary/g) ?? []).length === 1 && html.includes('data-graph-info-rows="1"'),
    "真实缺口存在 ⇒ 六图信息栏出现且**恰好一条**合并栏（不另加常驻条）",
  );
  ok(
    html.includes('data-graph-info-unresolved-gaps-brief="2"') && /关系未画出\s*2\s*条/.test(html),
    "默认行给真实缺口计数（不默认堆长清单：完整名单只在按需详情里）",
  );
  ok(
    all.every((r) => html.includes(`data-unresolved-relation="${attr(r.id)}"`)) &&
      all.every((r) => html.includes(`data-unresolved-relation-reason="${r.reason}"`)) &&
      all.every((r) => html.includes(`data-unresolved-relation-missing="${attr(r.missing_id)}"`)) &&
      all.every((r) => html.includes(`data-unresolved-relation-sources="1"`)),
    `完整名单逐条在场（${all.length} 条：ID／成因／落空端／出处都带）——含**合理结果**两条，不只真实缺口`,
  );
  ok(
    html.includes('data-unresolved-relation-real-gap="1"') && html.includes('data-unresolved-relation-real-gap="0"') &&
      html.includes('data-unresolved-relation-class="real_gap"') && html.includes('data-unresolved-relation-class="reasonable"'),
    "真实缺口与合理结果逐条**分开标注**（不把机械关系缺口涂成业务失败、也不把合理结果说成缺口）",
  );
  ok(
    html.includes(`data-unresolved-relation-open="${attr("plan:code:root")}"`) &&
      html.includes(`data-unresolved-relation-no-target="${attr("plan:task:DES-V06")}"`),
    "能跳可见对象时给按钮、没有可见对象时给**原因文本**（不假跳转）",
  );

  // (3) 合理结果单独渲染（工具条入口用的就是这同一个组件）：仍然逐条可达、不藏掉
  const reasonableHtml = renderToStaticMarkup(
    React.createElement(UnresolvedRelationsPanel, { relations: reasonableOnly, anchor: "project-functional" }),
  );
  ok(
    reasonableHtml.includes('data-unresolved-relations-count="2"') &&
      reasonableHtml.includes('data-unresolved-relations-gaps="0"') &&
      reasonableOnly.every((r) => reasonableHtml.includes(`data-unresolved-relation="${attr(r.id)}"`)),
    "只有合理结果时，完整名单经同一组件仍逐条可达（gaps=0、不冒充缺口，§3.3「隐藏≠没有」）",
  );

  // (4) 源码级：工具条入口 + 同一份组件接入信息栏详情（不各写一套）
  const pgv = fs.readFileSync(path.join(process.cwd(), "src/ui/arch/ProjectGraphView.tsx"), "utf8");
  ok(
    pgv.includes("data-project-unresolved-entry") &&
      pgv.includes("data-project-unresolved-panel") &&
      pgv.includes("<UnresolvedRelationsPanel") &&
      pgv.includes("unresolvedRelations={model?.unresolved_relations ?? []}"),
    "主视图工具条有「关系未画出」入口（点开才展开），且把**同一份**分账接进 GraphAttentionBar 详情（不各写一套）",
  );
}

console.log(`\n[verify] verify-fivegraph-main 结果：${pass} PASS / ${fail} FAIL / ${skip} SKIP（exit ${fail === 0 ? 0 : 1}）`);
process.exit(fail === 0 ? 0 : 1);
