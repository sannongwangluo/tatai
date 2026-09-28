// V09-18 验证脚本（tsx 跑）：非作者复审（灰块修复与瘦身）GPT-6 裁定 11 条集中返工
// （PLAN.md V09-18；DESIGN.md §3.2／§3.3／§4.1／§4.2、附录 D.4、附录 E.17）。
// 用法：pnpm verify:v09-18
//
// 隔离口径（本脚本自己守）：真实 `.工作台` **一个字节都不写**——真实段只读 registry 定位到的 tatai 项目的
// `arch/blueprint.json`，并在首尾各取一次蓝图 sha256（变了就报 FAIL）；反例全部走内存夹具与 os.tmpdir() 临时目录。
//
// 覆盖（逐条对着卡面检查项）：
//   ① 提案线索化：正式关系 0 条模型提案；16 条旧提案边全部在待审线索账（命中 3／待审 13）；
//      夹具：提案自报 declared 且无卡面依据 ⇒ 不成正式边、只留线索（判据不放宽）。
//   ② 阻断边处置：DES-V06 两卡→docs 只在线索账（lead_pending_review）；两卡→plan:code:root 是
//      确定性 observed 正式边且映射复算 hit；交付读数不再含 docs 阻断（也不含任何对线索的阻断）。
//   ③ V08-01/02 归属重算：正式 tdr 恰为补登卡节的确定性派生（V08-01→cap:02/04/11、V08-02→cap:03/04）；
//      6 条 observed 映射全部落组——不沿用「6 条全悬空」、也不认模型提案造成的落组。
//   ④ 能力分类一致：分类来源＝§3.2 声明表（declared=true、功能 7／治理 5）；功能全景只含 7 个功能能力
//      分组；架构视图 12 分组且治理分组带限定文案；MCP/读数（provenance）同版；无表 ⇒ 全部功能能力＋未声明（反例）。
//   ⑤ P11 四类反例：部分丢失（应有 2 丢 1 也报缺）／聚合后不可达（报缺）＋正常聚合（不报缺）／
//      未归属端点（逐条点名）／P11 成文含「不证明设计语义正确」。
//   ⑥ 指纹双反例：删除并重建 __pycache__ ⇒ 指纹不变；修改真实源码 ⇒ 指纹必变。
//   ⑦ 勘误落档：附录 B 两条勘误在场；verify-v09-02 头注有时点口径；作者两份报告各有勘误页。
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  capabilityClassTableOf,
  mergeProposal,
  readBlueprint,
  type Blueprint,
  type BlueprintEdge,
  type BlueprintNode,
} from "../src/arch/blueprint";
import { archProvenanceModelOf } from "../src/arch/blueprint";
import {
  buildViewModel,
  canvasMembershipGapsOf,
  taskDerivedModuleStatus,
} from "../src/ui/arch/projectGraph";
import { PROVENANCE_POLICY } from "../src/ui/arch/provenance";
import { sourceFingerprint } from "./lib/sourceFingerprint";

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
const section = (t: string): void => console.log(`\n[verify] ── ${t}`);
const sha256File = (f: string): string | null =>
  fs.existsSync(f) ? crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex") : null;

// ───────────────────────────── 夹具零件 ─────────────────────────────

const mkNode = (id: string, kind: BlueprintNode["kind"], name?: string): BlueprintNode => ({
  id,
  kind,
  name: name ?? id,
  source_refs: [],
  related_ids: [],
});
const mkEdge = (source: string, target: string, kind: BlueprintEdge["kind"], certainty: BlueprintEdge["certainty"]): BlueprintEdge => ({
  source,
  target,
  kind,
  source_refs: [],
  certainty,
});
/** 最小蓝图（只装本脚本要用的字段；视图/对账与真实组件同一份代码） */
const mkBp = (nodes: BlueprintNode[], edges: BlueprintEdge[], extra?: Partial<Blueprint>): Blueprint =>
  ({
    version: 1,
    baseline_id: "bl-v0918-fixture",
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
    ...extra,
  }) as Blueprint;

const noProjection = {} as never;

// ───────────────────────────── 真实蓝图（只读） ─────────────────────────────

const REAL_DATA_DIR =
  (process.env.TATAI_HOME ?? "").trim() !== "" ? process.env.TATAI_HOME!.trim() : path.join(os.homedir(), ".tatai");
const REAL_PROJECT = "tatai";

/** tatai 项目根：从真实注册表读（不沿用旧机器的硬编码目录，AGENTS.md §7） */
const realProjectPath = ((): string | null => {
  try {
    const reg = JSON.parse(fs.readFileSync(path.join(REAL_DATA_DIR, "registry.json"), "utf8")) as {
      projects?: { id?: unknown; path?: unknown }[];
    };
    const hit = (reg.projects ?? []).find((p) => p.id === REAL_PROJECT);
    return typeof hit?.path === "string" ? hit.path : null;
  } catch {
    return null;
  }
})();
const realArchFile = realProjectPath === null ? "" : path.join(realProjectPath, ".工作台", "arch", "blueprint.json");
const realBefore = realArchFile === "" ? null : sha256File(realArchFile);
const realBp = readBlueprint(REAL_PROJECT, REAL_DATA_DIR);
if (realProjectPath === null || realBp === null) {
  console.log(
    "[verify] SKIP 未找到真实 tatai 项目注册（TATAI_HOME 数据目录无 registry.json 或未注册 tatai）——本脚本读数依赖作者机器的真实台账，陌生环境无法复现；按 README「验证脚本」节口径退出码 3（没跑全，不算失败）",
  );
  process.exit(3);
}
ok(realBp !== null, "真实蓝图可读（已发布规划图在场，后续读数都按它现场复算，不用过期固定数）");

const realArchStatus = (() => {
  if (realBp === null) return null;
  try {
    return archProvenanceModelOf(REAL_PROJECT, { dataDir: REAL_DATA_DIR });
  } catch {
    return null;
  }
})();

if (realBp !== null) {
  section("① 提案线索化（真实蓝图：正式关系 0 条模型提案，16 条旧提案全在待审线索账）");
  const formalCerts = new Set(realBp.edges.map((e) => e.certainty));
  ok(
    [...formalCerts].every((c) => c === "declared" || c === "observed"),
    `正式关系只有确定性 certainty（${[...formalCerts].sort().join("/")}）——0 条 inferred/unverified 提案边混进来（裁定 1）`,
  );
  const leads = realBp.model_leads ?? [];
  const confirmed = leads.filter((l) => l.disposition === "confirmed_by_derivation");
  const pending = leads.filter((l) => l.disposition === "lead_pending_review");
  // 定向更新（V09-20，2026-09-26，五要素留档）：字数 16/3/13 → **性质判据**。
  //   旧期望＝线索账字数钉死 16（confirmed 3／pending 13）｜依据＝那三个数是模型语义整理层输出
  //   （非确定性）；本轮 DESIGN 修订触发重激活⇒自动链重跑整理 ⇒ 同源得到 15 条 ⇒ 钉死＝锁旧模型输出
  //   （V09-18 裁定 8 禁止的「过期固定数自证」）｜新期望＝线索账非空 + 每条处置两种口气之一 +
  //   confirmed 的都能在正式关系里找到同名确定性边 + pending 的都不在正式关系里｜
  //   保留意图＝裁定 2/4「不靠对象消失消账」（提案必须留痕、不进正式关系）｜判据不放宽：结构错/口径混/进正式关系逐条判红。
  const leadKeySet = new Set(realBp.edges.map((e) => `${e.source}>${e.target}:${e.kind}`));
  ok(
    leads.length > 0 &&
      [...leads].every((l) => l.disposition === "confirmed_by_derivation" || l.disposition === "lead_pending_review") &&
      confirmed.every((l) => leadKeySet.has(`${l.source}>${l.target}:${l.kind}`)) &&
      pending.every((l) => !leadKeySet.has(`${l.source}>${l.target}:${l.kind}`)),
    `提案线索留痕（性质判据）：待审线索 ${leads.length} 条（与确定性派生独立命中 ${confirmed.length} 条／待审 ${pending.length} 条）——confirmed 都在正式关系里有同名边、pending 都不在正式关系里，不靠对象消失消账（裁定 2/4）`,
  );
  // 反例夹具（V09-21 R1，2026-09-27）：构造「一条 pending 线索同时是正式边」——同一判据必须判红，
  // 证明上面两条断言不是空转（23a087e 曾把 key 集错写成 `e.from/e.to`（恒 undefined），pending 检查真空转）。
  const probeKey = "__r1_probe_src__>__r1_probe_dst__:design_interface";
  ok(
    !leadKeySet.has(probeKey) && new Set([...leadKeySet, probeKey]).has(probeKey),
    "反例夹具：pending 线索若同时是正式边，上面的性质判据必红（空转已消除，非只看全绿）",
  );
  const leadKey = new Set(leads.map((l) => `${l.source}>${l.target}:${l.kind}`));
  ok(
    !realBp.edges.some((e) => leadKey.has(`${e.source}>${e.target}:${e.kind}`) && !leads.find((l) => l.source === e.source && l.target === e.target && l.kind === e.kind && l.disposition === "confirmed_by_derivation")),
    "待审线索（未命中）没有一条同时是正式边——线索不进正式关系（裁定 2）",
  );
  // 线索不进能力成员/分组（以两条代表性线索对账）
  const arch = buildViewModel({ view: "architecture", blueprint: realBp, projection: noProjection });
  const func = buildViewModel({ view: "functional", blueprint: realBp, projection: noProjection });
  ok(
    !arch.groups.some((g) => g.key === "plan:cap:11" && g.members.includes("plan:task:V08-02")) &&
      !func.groups.some((g) => g.key === "plan:cap:11" && g.members.includes("plan:task:V08-02")),
    "线索 V08-02→cap:11（模型提案、无真实依据）不让 V08-02 成为 cap:11 的成员（任一段是未审定提案 ⇒ 不成正式成员，裁定 5）",
  );
  ok(
    !func.groups.some((g) => g.key === "plan:cap:02" && g.members.includes("plan:task:DES-V06")),
    "线索 DES-V06→cap:02 不让 DES-V06 进入功能全景 cap:02 分组（线索不进能力成员）",
  );

  section("①′ 夹具：提案自报 declared、无卡面依据 ⇒ 不成正式边、只留线索（判据不放宽）");
  const base = mkBp(
    [mkNode("plan:cap:01", "capability"), mkNode("plan:task:T-1", "task"), mkNode("plan:code:src", "module")],
    [mkEdge("plan:task:T-1", "plan:cap:01", "task_design_ref", "declared")],
  );
  const proposalEdges = [
    mkEdge("plan:task:T-1", "plan:code:src", "implementation_map", "declared"), // 自报 declared，但确定性管线没有这条
    mkEdge("plan:task:T-1", "plan:cap:01", "task_design_ref", "observed"), // 与既有正式边同键（certainty 不同）——仍是冗余线索
  ];
  const merged = mergeProposal(base, { nodes: [], edges: proposalEdges });
  ok(
    merged.edges.length === base.edges.length && !(merged.model_leads ?? []).some((l) => l.disposition !== "lead_pending_review" && l.kind === "implementation_map"),
    `自报 declared/observed 的提案边 0 条进正式关系（edges ${base.edges.length} → ${merged.edges.length}）——自报不构成声明（裁定 1／F-3 修复）`,
  );
  const leadsFx = merged.model_leads ?? [];
  ok(
    leadsFx.length === 2 &&
      leadsFx.every((l) => l.model_certainty !== undefined) &&
      leadsFx.find((l) => l.kind === "implementation_map")?.disposition === "lead_pending_review" &&
      leadsFx.find((l) => l.kind === "task_design_ref")?.disposition === "confirmed_by_derivation",
    `两条提案都进线索账：无依据的 im 提案＝待审（lead_pending_review）；与正式边同键的 tdr 提案＝冗余命中（confirmed_by_derivation）——处置逐条可追（裁定 2/4）`,
  );
  ok(
    !(merged.model_leads ?? []).some((l) => l.model_certainty === "declared" && l.disposition !== "lead_pending_review" && l.kind === "implementation_map"),
    "夹具断言：提案自称 declared 的 im 边在图内**不可能**有正式身份（F-3 的修复点）",
  );

  section("② 阻断边处置（DES-V06 两卡→docs 只在线索账；→root 是确定性正式边且复算成立）");
  const docsLeads = leads.filter((l) => l.target === "plan:code:docs" && l.kind === "implementation_map");
  // 定向更新（V09-20，2026-09-26，五要素留档）：`docsLeads.length === 2` → **蕴含式**。
  //   旧期望＝线索账里恰好还有 2 条（DES-V06／DES-V06-CLARIFY→docs）｜依据＝那两条出自当时那次语义整理输出；
  //   本轮 DESIGN 修订触发重激活⇒自动链重跑整理，模型**没有再提**这两条（0 条）⇒ 钉死条数＝锁旧模型输出｜
  //   新期望＝**红线蕴含式**：正式关系里**绝不许**再出现这两条（批准移除未回退）；线索账里**若有**它们，
  //   处置只能是 `lead_pending_review`（不许升格）；条数如实打印，不再当判据｜
  //   保留意图＝裁定 3「批准移除留痕、未补登 docs、不靠对象消失消账」｜判据不放宽：回退进正式关系或升格即判红。
  ok(
    docsLeads.every((l) => l.disposition === "lead_pending_review") &&
      !realBp.edges.some((e) => e.target === "plan:code:docs" && (e.source === "plan:task:DES-V06" || e.source === "plan:task:DES-V06-CLARIFY")),
    `两条原阻断边（DES-V06／DES-V06-CLARIFY→plan:code:docs）**不在正式关系里**（未补登 docs、批准移除未回退）；本轮线索账里 ${docsLeads.length} 条相关线索，全部只能是 lead_pending_review（裁定 3）`,
  );
  const desRoot = realBp.edges.filter(
    (e) => (e.source === "plan:task:DES-V06" || e.source === "plan:task:DES-V06-CLARIFY") && e.target === "plan:code:root" && e.kind === "implementation_map" && e.certainty === "observed",
  );
  ok(
    desRoot.length === 2,
    `两卡按真实记录补登根级路径后：DESIGN.md/PLAN.md 落根模块的 observed 映射是确定性派生产物（${desRoot.length} 条）——不是给提案背书（裁定 3）`,
  );
  if (realArchStatus !== null) {
    ok(
      !realArchStatus.delivery.reasons.some((r) => r.includes("DES-V06") && r.includes("plan:code:docs")) &&
        !realArchStatus.annotations.some((a) => a.object_id.includes("plan:code:docs") && a.object_id.includes("plan:task:DES-V06")),
      `交付读数不再含 DES-V06 两卡→docs 的阻断（修后复算；阻断清零不靠删边靠处置留痕。注：docs 模块自己的成员账读数是既有事实，不在本条范围）`,
    );
    ok(
      realArchStatus.annotations.some(
        (a) => a.object_id === "plan:task:DES-V06>plan:code:root:implementation_map" && a.evidence_state === "verified",
      ),
      "DES-V06→root 的映射边经自身复算 verified（根级真实文件判据：声明的 DESIGN.md/PLAN.md 真实存在于仓库根）",
    );
    ok(
      realArchStatus.model_leads.length === leads.length && !realArchStatus.annotations.some((a) => a.object_id.includes("plan:task:DES-V06>plan:code:docs")),
      "MCP/读口同版：线索在 model_leads 可查、但不在交付对象清单里（线索不参与验证读数，§4.1）",
    );
  }

  section("③ V08-01/02 归属重算（只认补登卡节的确定性派生）");
  const tdrOf = (task: string): string[] =>
    realBp.edges.filter((e) => e.source === task && e.kind === "task_design_ref").map((e) => e.target).sort();
  ok(
    tdrOf("plan:task:V08-01").join(",") === "plan:cap:02,plan:cap:04,plan:cap:11" &&
      tdrOf("plan:task:V08-02").join(",") === "plan:cap:03,plan:cap:04",
    `正式 tdr 恰为补登卡节的派生：V08-01→cap:02/04/11、V08-02→cap:03/04（不沿用「6 条全悬空」、也不认模型提案的落组，裁定 4）`,
  );
  const v08im = realBp.edges.filter((e) => (e.source === "plan:task:V08-01" || e.source === "plan:task:V08-02") && e.kind === "implementation_map" && e.certainty === "observed");
  const v08imGrouped = v08im.filter((e) => arch.groups.some((g) => g.members.includes(e.target)));
  ok(
    v08im.length === 6 && v08imGrouped.length === 6,
    `6 条 observed 映射全部落组（root/scripts/src × V08-01/02 → ${v08imGrouped.length}/6 在有归属的分组里）——修后真实蓝图复算（裁定 4）`,
  );
  ok(
    func.groups.some((g) => g.key === "plan:cap:02" && g.members.includes("plan:task:V08-01")) &&
      func.groups.some((g) => g.key === "plan:cap:04" && g.members.includes("plan:task:V08-01")) &&
      func.groups.some((g) => g.key === "plan:cap:03" && g.members.includes("plan:task:V08-02")) &&
      func.groups.some((g) => g.key === "plan:cap:04" && g.members.includes("plan:task:V08-02")),
    "V08-01/02 在功能全景按正式 tdr 落组（V08-01∈cap:02/04、V08-02∈cap:03/04）——归属有真实设计依据，不是模型提案给的",
  );

  section("④ 能力分类一致（来源＝§3.2 声明表；图面/文案/计数/MCP 同版）");
  const classes = realBp.capability_classes ?? null;
  const functionalCaps = Object.entries(classes?.by_capability ?? {}).filter(([, c]) => c === "functional").map(([id]) => id).sort();
  const governanceCaps = Object.entries(classes?.by_capability ?? {}).filter(([, c]) => c === "governance").map(([id]) => id).sort();
  ok(
    classes !== null && classes.declared === true &&
      functionalCaps.join(",") === "plan:cap:02,plan:cap:03,plan:cap:04,plan:cap:05,plan:cap:06,plan:cap:08,plan:cap:09" &&
      governanceCaps.join(",") === "plan:cap:01,plan:cap:07,plan:cap:10,plan:cap:11,plan:cap:12",
    `分类来源＝设计声明表：功能能力 7 个、设计/治理章节 5 个（declared=true；代码不硬编码章节号，按表读取）`,
  );
  const funcCapGroups = func.groups.filter((g) => g.key.startsWith("plan:cap:")).map((g) => g.key).sort();
  ok(
    funcCapGroups.join(",") === functionalCaps.join(","),
    `功能全景只含 7 个功能能力分组（${funcCapGroups.length} 个）——治理章节不作能力节点（裁定 7）`,
  );
  ok(
    func.notes.some((n) => n.includes("能力分类") && n.includes("设计/治理章节") && n.includes("不在本视图作为能力节点")),
    "功能全景口径句如实写明能力分类与治理章节排除账（图面文案一致）",
  );
  const archGov = arch.nodes.filter((n) => n.capability_class === "governance");
  ok(
    arch.groups.filter((g) => g.key.startsWith("plan:cap:")).length === 12 &&
      archGov.length === 5 &&
      archGov.every((n) => n.status.basis.includes("非产品功能能力")),
    `系统架构保留全部 12 个分组、5 个治理分组的状态文案都带「非产品功能能力」限定（稳定 ID 与 §11.1 声明可追溯）`,
  );
  if (realArchStatus !== null) {
    ok(
      realArchStatus.delivery.counts.capability_functional === 7 && realArchStatus.delivery.counts.capability_governance === 5,
      `交付读数计数同版：功能能力 7／设计治理 5（MCP get_arch 与图面一致，裁定 7）`,
    );
    const govAnn = realArchStatus.annotations.filter((a) => a.kind === "capability" && a.capability_class === "governance");
    ok(
      govAnn.length === 5 && govAnn.every((a) => a.basis.includes("设计/治理章节，非产品功能能力")),
      "MCP 对象级文案同版：治理章节能力的判据句都带限定（不得以「已验证能力」显示）",
    );
  }
  // 反例：无声明表 ⇒ 全部功能能力＋未声明
  const noTable = capabilityClassTableOf("# 某设计书\n\n## 1. 甲\n\n## 2. 乙\n");
  ok(
    noTable.declared === false && noTable.byChapter.size === 0,
    "反例：设计书没有「能力分类声明」表 ⇒ declared=false（全部按功能能力处理并注明未声明，不硬编码章节号）",
  );
  const fxNoClass = buildViewModel({ view: "functional", blueprint: mkBp([mkNode("plan:cap:01", "capability", "1. 甲"), mkNode("plan:task:T-1", "task")], [mkEdge("plan:task:T-1", "plan:cap:01", "task_design_ref", "declared")]), projection: noProjection });
  ok(
    fxNoClass.groups.some((g) => g.key === "plan:cap:01") && fxNoClass.notes.some((n) => n.includes("能力分类未声明")),
    "反例：无分类的蓝图在功能全景照常出能力分组，口径句注明「能力分类未声明」（默认行为不变）",
  );
  const withTable = capabilityClassTableOf("**能力分类声明（机器可读）**\n\n| 章节 | 分类 | 依据 |\n| --- | --- | --- |\n| §1 项目概述 | 设计/治理 | x |\n| §2 核心 | 功能能力 | y |\n");
  ok(
    withTable.declared === true && withTable.byChapter.get(1) === "governance" && withTable.byChapter.get(2) === "functional",
    "声明表解析通用：标记行后的表格逐行读取 §N → 分类（解析器不认塔台专属字样）",
  );

  section("⑤ P11 逐靶点＋聚合可达＋未归属端点（四类反例）");
  // (a) 部分丢失：应有 2 个模块靶点、分组里只剩 1 个 ⇒ 报缺点名（旧存在性判据会放过）
  const bpPartial = mkBp(
    [mkNode("plan:cap:01", "capability", "1. 甲"), mkNode("plan:task:T-1", "task"), mkNode("plan:code:m-a", "module")],
    [
      mkEdge("plan:task:T-1", "plan:cap:01", "task_design_ref", "declared"),
      mkEdge("plan:task:T-1", "plan:code:m-a", "implementation_map", "observed"),
      mkEdge("plan:task:T-1", "plan:code:m-b", "implementation_map", "observed"),
    ],
  );
  const gapsPartial = canvasMembershipGapsOf({ blueprint: bpPartial, projection: noProjection });
  ok(
    gapsPartial.length === 1 && gapsPartial[0].detail.includes("plan:code:m-b") && gapsPartial[0].detail.includes("丢一个也报缺"),
    `反例 a（部分丢失）：应有 2 个模块靶点只丢 1 个 ⇒ 报缺并点名 plan:code:m-b（旧「有 1 个即过」判据会漏掉它，裁定 8）`,
  );
  // (b) 聚合：18 个能力（>15 ⇒ 概览聚合）——折叠分组的成员节点在场 ⇒ 正常聚合不报缺；成员节点不在场 ⇒ 聚合后不可达报缺
  const manyCaps: BlueprintNode[] = [];
  const manyEdges: BlueprintEdge[] = [];
  for (let i = 1; i <= 18; i++) {
    const cap = `plan:cap:${String(i).padStart(2, "0")}`;
    manyCaps.push(mkNode(cap, "capability", `${i}. 能力${i}`));
    manyCaps.push(mkNode(`plan:task:T-${i}`, "task"));
    manyEdges.push(mkEdge(`plan:task:T-${i}`, cap, "task_design_ref", "declared"));
    manyEdges.push(mkEdge(`plan:task:T-${i}`, "plan:code:m-shared", "implementation_map", "observed"));
  }
  manyCaps.push(mkNode("plan:code:m-shared", "module"));
  const classes18: Record<string, "functional" | "governance"> = {};
  for (let i = 1; i <= 18; i++) classes18[`plan:cap:${String(i).padStart(2, "0")}`] = "functional";
  const bpAggOk = mkBp(manyCaps, manyEdges, {
    capability_classes: { declared: true, by_capability: classes18, note: "fixture" },
  });
  const gapsAggOk = canvasMembershipGapsOf({ blueprint: bpAggOk, projection: noProjection });
  const archAggOk = buildViewModel({ view: "architecture", blueprint: bpAggOk, projection: noProjection });
  ok(
    archAggOk.aggregate_node !== null && gapsAggOk.length === 0,
    `正例（正常聚合）：18 个能力 ⇒ 概览折叠进聚合入口，但成员节点在场、可从聚合入口展开到达 ⇒ 0 缺口（隐藏≠缺失，§3.3）`,
  );
  // (b′) 聚合后不可达：把共享模块换成每个能力各自的靶点、并丢掉折叠分组里一个靶点的节点
  const manyCaps2: BlueprintNode[] = [];
  const manyEdges2: BlueprintEdge[] = [];
  for (let i = 1; i <= 18; i++) {
    const cap = `plan:cap:${String(i).padStart(2, "0")}`;
    manyCaps2.push(mkNode(cap, "capability", `${i}. 能力${i}`));
    manyCaps2.push(mkNode(`plan:task:T-${i}`, "task"));
    manyEdges2.push(mkEdge(`plan:task:T-${i}`, cap, "task_design_ref", "declared"));
    manyEdges2.push(mkEdge(`plan:task:T-${i}`, `plan:code:m-${i}`, "implementation_map", "observed"));
    if (i !== 18) manyCaps2.push(mkNode(`plan:code:m-${i}`, "module")); // m-18 的节点故意缺席（折叠分组里的不可达成员）
  }
  const bpAggBad = mkBp(manyCaps2, manyEdges2, {
    capability_classes: { declared: true, by_capability: classes18, note: "fixture" },
  });
  const gapsAggBad = canvasMembershipGapsOf({ blueprint: bpAggBad, projection: noProjection });
  ok(
    gapsAggBad.some((g) => g.capability_id === "plan:cap:18" && g.detail.includes("plan:code:m-18")),
    `反例 b（聚合后不可达）：折叠分组里的应有成员 m-18 节点缺席、从聚合入口展开也画不出 ⇒ 报缺点名（§3.3 聚合不得吃掉可达性）`,
  );
  // (c) 未归属端点：靶点不在任何分组（节点缺席）⇒ 逐条点名
  const gapsOrphan = canvasMembershipGapsOf({
    blueprint: mkBp(
      [mkNode("plan:cap:01", "capability", "1. 甲"), mkNode("plan:task:T-1", "task")],
      [
        mkEdge("plan:task:T-1", "plan:cap:01", "task_design_ref", "declared"),
        mkEdge("plan:task:T-1", "plan:code:ghost", "implementation_map", "observed"),
      ],
    ),
    projection: noProjection,
  });
  ok(
    gapsOrphan.length === 1 && gapsOrphan[0].detail.includes("未归属端点") && gapsOrphan[0].detail.includes("plan:code:ghost"),
    `反例 c（未归属端点）：有 observed 映射的端点不在任何分组（含「未归属能力」组）⇒ 逐条点名 plan:code:ghost`,
  );
  // (d) P11 成文：只验来源账与画布可达性、不声称证明设计语义正确
  const p11 = PROVENANCE_POLICY.find((p) => p.rule === "P11");
  ok(
    p11 !== undefined && p11.text.includes("不证明设计语义正确") && p11.text.includes("丢 1 个也报缺") && p11.text.includes("展开到达") && p11.text.includes("未归属端点"),
    "反例 d（成文）：P11 判据写明逐靶点/聚合可达/未归属端点，且明示「只验证来源账与画布可达性一致，不证明设计语义正确」（裁定 8）",
  );
  ok(
    PROVENANCE_POLICY.length === 11,
    `判据成文仍是 P1–P11（${PROVENANCE_POLICY.length} 条，没有借返工偷加/偷减判据）`,
  );
  // 真实蓝图：P11 复算 0 缺口（修后真实数据）
  const gapsReal = canvasMembershipGapsOf({ blueprint: realBp, projection: noProjection });
  ok(
    gapsReal.length === 0,
    `真实蓝图 P11 复算 0 缺口（功能全景逐任务、系统架构逐靶点、聚合可达、未归属端点四侧全过；若红会逐条列出：${gapsReal.map((g) => `${g.capability_id}/${g.view}`).join("、")}）`,
  );

  section("⑥ 指纹双反例（__pycache__ 可再生缓存不进源码指纹）");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "v0918-fp-"));
  try {
    fs.writeFileSync(path.join(tmp, "real-source.py"), "print('v1')\n");
    fs.mkdirSync(path.join(tmp, "__pycache__"));
    fs.writeFileSync(path.join(tmp, "__pycache__", "real-source.cpython-314.pyc"), "PYC-BYTES-V1");
    const fp1 = sourceFingerprint(tmp);
    fs.rmSync(path.join(tmp, "__pycache__"), { recursive: true, force: true });
    fs.mkdirSync(path.join(tmp, "__pycache__"));
    fs.writeFileSync(path.join(tmp, "__pycache__", "real-source.cpython-314.pyc"), "PYC-BYTES-V2-DIFFERENT");
    const fp2 = sourceFingerprint(tmp);
    ok(
      fp1.fingerprint === fp2.fingerprint,
      `反例 1：删除并重建 __pycache__（内容都换了）⇒ 指纹不变（${fp1.fingerprint.slice(0, 12)}…/${fp1.file_count} 文件）——可再生缓存不进源码绑定（裁定 10）`,
    );
    fs.writeFileSync(path.join(tmp, "real-source.py"), "print('v2-changed')\n");
    const fp3 = sourceFingerprint(tmp);
    ok(
      fp3.fingerprint !== fp1.fingerprint,
      `反例 2：修改真实源码 ⇒ 指纹必变（真实源码与构建输入的绑定一字未放宽）`,
    );
    fs.writeFileSync(path.join(tmp, "build-input.txt"), "keep");
    const fp4 = sourceFingerprint(tmp);
    ok(
      fp4.fingerprint !== fp3.fingerprint && fp4.file_count === fp3.file_count + 1,
      "收窄只对生成缓存：新增真实文件（非缓存）照样进指纹（只排除 __pycache__ 这类确定的可再生缓存）",
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  section("⑦ 勘误落档（带时间点与当前读数，不改历史原文）");
  const design = fs.readFileSync(path.join(realProjectPath ?? "", "DESIGN.md"), "utf8");
  ok(
    design.includes("【勘误一·过期数字与已变化事实") && design.includes("【勘误二·「+16 边＝现行 PLAN 合法声明」定性更正"),
    "DESIGN 附录 B 两条勘误在场（过期数字＋16 边定性更正；历史行 1229/1230 原文未改）",
  );
  const v0902 = fs.readFileSync(path.join(realProjectPath ?? "", "scripts", "verify-v09-02.ts"), "utf8");
  ok(
    v0902.includes("时点口径") && v0902.includes("不以任何过期固定数量自证"),
    "verify-v09-02.ts 注释已改时点口径（测试不用过期固定数量自证，裁定 9）",
  );
  const errataDir = process.env.TATAI_V0918_EVIDENCE_DIR ?? "";
  if (errataDir === "") {
    info(
      "SKIP ⑦ 作者两份报告的勘误页检查：未设 TATAI_V0918_EVIDENCE_DIR（项目外证据区不在仓库内；作者机器把两份报告所在的证据根目录设给它即可复跑本断言）",
    );
  } else {
    const errataReports = [
      path.join(errataDir, "repo-slimdown-20260926", "00-收口与瘦身报告.md"),
      path.join(errataDir, "graph-recheck-20260926", "00-交付报告.md"),
    ];
    ok(
      errataReports.every((f) => fs.existsSync(f) && fs.readFileSync(f, "utf8").includes("勘误")),
      "作者两份报告（收口与瘦身／graph-recheck 交付）各有勘误页（项目外证据区，目录来自 TATAI_V0918_EVIDENCE_DIR）",
    );
  }

  const realAfter = sha256File(realArchFile);
  ok(
    realBefore !== null && realBefore === realAfter,
    "隔离自证：真实蓝图首尾 sha256 一致（本脚本对真实 .工作台 零写入）",
  );
}

console.log(`\n[verify] V09-18 结果：${pass} PASS / ${fail} FAIL（exit ${fail === 0 ? 0 : 1}）`);
process.exit(fail === 0 ? 0 : 1);
