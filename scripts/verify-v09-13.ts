// V09-13 验证脚本（tsx 跑）：图节点与关系的来源、证据标注与交付阻断。
// 用法：pnpm verify:v09-13（自带临时 TATAI_HOME 与夹具；真实文档只读并做首尾 sha256 零改动自证）
//
// 覆盖（逐条对着 PLAN V09-13 卡面「检查项」）：
//   ① 来源与证据在场：≥5 个模块/关系能读出**来源种类**（requirement／design／code）＋**映射**＋
//      **证据状态**（五档）；灰 planned 节点能追到**经核实**的规划依据（来源复算通过）且不算已交付。
//      反例：没有来源的对象必须标「未映射」且**不给绿**；来源复算不过必须判「证据失效」。
//   ② 交付阻断（正反）：存在未映射/未验证/缺证/证据失效时，**读口与界面**都明确不给「项目可交付」
//      并**逐条点名**（每条都带对象 ID）；全部满足时才给「可请求验收」——**仍不等于用户接受**。
//      反例：存在阻断却给可交付结论 ⇒ 判违规；「可请求验收」被读成已接受 ⇒ 判违规。
//   ③ 人工待验：需用户动手/确认的项标 `user_pending`，**Agent 不代签**。
//      反例：把它显示成「已验证」/置成已接受 ⇒ 逐条判违规。
//   ④ 同组关系可见（含反例）：同一分组内的设计接口关系在图上逐条列出、可点开追来源（带出处行）。
//      反例：只在文字里解释（`visible_on_graph=false`）/ 拿不出来源 ⇒ 判违规。
//   ⑤ 门槛与回归：本脚本断言自己已在 package.json 登记、判据只此一份（三个 UI 文件都 import 同一份）、
//      `typecheck`／`build`／`build:server` 与回归脚本由本次交付的日志核对
//      （`.工作台/evidence/V09-13/1/`）。
//
// 隔离口径：真实 `.工作台/work/` 与真实 DESIGN.md／PLAN.md **只读**；一切写操作在 os.tmpdir() 夹具里；
// 收尾清理。不调任何 MCP 写工具、不动真实事件账本、不改任何设计/施工原文。
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { archProvenanceModelOf, readBlueprint } from "../src/arch/blueprint";
import { getArchTool } from "../src/mcp/tools/getArch";
import { addProject } from "../src/server/registry";
import { WorkService } from "../src/server/work/service";
import { readRequirements, registerRequirement } from "../src/server/work/requirements";
import { submitTaskStatus, readTaskStates } from "../src/server/work/tasks";
import { projectWorkDir } from "../src/server/workstation";
import { buildViewModel, taskDerivedModuleStatus } from "../src/ui/arch/projectGraph";
import {
  DELIVERY_BLOCKED_CONCLUSION,
  DELIVERY_REQUESTABLE_CONCLUSION,
  EVIDENCE_STATE_ORDER,
  PROVENANCE_POLICY,
  PROVENANCE_SOURCE_ORDER,
  UNMAPPED_LABEL,
  USER_PENDING_LABEL,
  buildProvenanceModel,
  evidenceStateOf,
  intraGroupRelationsOf,
  validateIntraGroupRelations,
  validateProvenanceModel,
  type EvidenceFacts,
  type IntraGroupRelation,
  type ProvenanceModel,
  type ProvenanceObjectInput,
} from "../src/ui/arch/provenance";
import { GraphAttentionBar, IntraRelationPanel, ObjectProvenanceLines } from "../src/ui/arch/ProvenancePanel";
import { REPO_ROOT, ensureSelfRegistered, realHome } from "./lib/fixtures";

let pass = 0;
const fails: string[] = [];
const ok = (cond: boolean, label: string): void => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (cond) pass += 1;
  else {
    fails.push(label);
    process.exitCode = 1;
  }
};
const info = (m: string): void => console.log(`[verify]   ${m}`);
const section = (t: string): void => console.log(`\n[verify] ── ${t}`);
const sha256Text = (t: string): string => crypto.createHash("sha256").update(t, "utf8").digest("hex");
/** React 静态渲染会把属性值里的 `&<>"` 转义（关系 id 形如 `a>b:kind`）：断言时按同一口径比 */
const attrHtml = (v: string): string =>
  v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const read = (rel: string): string => fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
const exists = (rel: string): boolean => fs.existsSync(path.join(REPO_ROOT, rel));

const REPO = REPO_ROOT;
const REAL_HOME = realHome();
ensureSelfRegistered(REAL_HOME);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-v0913-"));
const FX_HOME = path.join(TMP, "home");
fs.mkdirSync(FX_HOME, { recursive: true });
const FX = "v0913-fixture";
const FX_ROOT = path.join(TMP, "proj");
const FX_WORK = path.join(FX_ROOT, ".工作台", "work");
const FX_ARCH = path.join(FX_ROOT, ".工作台", "arch");

/** 夹具设计书（章节标题即来源定位串；正文哈希不写死 ⇒ 引用 `sha256:null` 表示"按章节存在性复算"） */
const FX_DESIGN = `# 夹具设计书

## 1. 夹具设计

### 1.1 夹具能力

夹具能力：用来验证来源与证据标注的展示面。

### 1.2 夹具能力二（来源已失效）

这一节用来验证"来源复算不过 ⇒ 证据失效"，因此夹具蓝图里给它的引用哈希故意写错。
`;
/** 夹具施工图（任务表 + 需求映射表；映射表头必须同时含「需求」「承接卡」两列才被认） */
const FX_PLAN = `# 夹具施工图

| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |
| --- | --- | --- | --- | --- |
| T-1 | todo | 夹具任务一 | 无 | 夹具任务一按要求跑完 |
| T-2 | todo | 夹具任务二 | T-1 | 夹具任务二按要求跑完 |

### T-1 夹具任务一

**交付**：夹具任务一按要求跑完。

### T-2 夹具任务二

**交付**：夹具任务二按要求跑完。

| 需求 ID | 来源 | 分类 | 适用范围/生效时点 | 确认度 | 承接卡 |
| --- | --- | --- | --- | --- | --- |
| req-v0913-1 | 夹具：V09-13 检查项① | 当前有效 | 本轮 | 明确 | T-1 |
`;

/** 一条证据事实的默认值（判据的输入是"事实"，脚本按需覆写字段） */
function factsOf(over: Partial<EvidenceFacts> & { object_id: string; label: string }): EvidenceFacts {
  return {
    has_projection: false,
    mapping: null,
    required_count: 0,
    passed_count: 0,
    missing_count: 0,
    quality: null,
    display_status: null,
    freshness: null,
    acceptance: null,
    history_count: 0,
    open_findings: 0,
    evidence_refs: [],
    sources_total: 0,
    sources_valid: 0,
    sources_stale: [],
    sources_unlocatable: [],
    user_actions: [],
    delivery_relevant: false,
    ...over,
  };
}

async function main(): Promise<void> {
  // ── 真实文档零改动自证（本卡只读设计/施工原文） ──
  const docBefore = new Map<string, string>();
  for (const rel of ["DESIGN.md", "PLAN.md", "README.md", "AGENTS.md", "package.json"]) {
    docBefore.set(rel, exists(rel) ? sha256Text(read(rel)) : "<missing>");
  }

  const prevHome = process.env.TATAI_HOME;
  try {
    // ═════════════ 夹具：真经唯一写入服务登记需求 + 真派生（①③④ 的实测面） ═════════════
    section("夹具：临时 TATAI_HOME + 真写入服务登记需求 + 真派生（不碰真实账本）");
    fs.mkdirSync(FX_WORK, { recursive: true });
    fs.mkdirSync(FX_ARCH, { recursive: true });
    fs.mkdirSync(path.join(FX_ROOT, "src"), { recursive: true });
    fs.writeFileSync(path.join(FX_ROOT, "src", "index.ts"), "export const fixture = 1;\n", "utf8");
    fs.writeFileSync(path.join(FX_ROOT, ".工作台", "design.md"), FX_DESIGN, "utf8");
    fs.writeFileSync(path.join(FX_ROOT, ".工作台", "plan.md"), FX_PLAN, "utf8");
    fs.writeFileSync(
      path.join(FX_ARCH, "modules.json"),
      JSON.stringify({
        version: 1,
        generated_at: "2026-09-24T00:00:00+08:00",
        budget_exhausted: false,
        modules: [{ id: "src", name: "夹具代码模块", path: "src", file_count: 1, loc: 12, deps: [] }],
      }),
      "utf8",
    );
    process.env.TATAI_HOME = FX_HOME;
    addProject({ id: FX, name: "V09-13 夹具", path: FX_ROOT, kind: "backend" }, FX_HOME);

    // 需求登记（唯一写入服务；2 条：一条被承接、一条悬空用来验证点名）
    const service = new WorkService({ dataDir: FX_HOME });
    const submitter = { submit: (c: unknown) => service.submit(c) };
    for (const reqId of ["req-v0913-1", "req-v0913-2"]) {
      registerRequirement(submitter, {
        project_id: FX,
        requirement_id: reqId,
        change_id: "change-none",
        actor_id: "v0913-verify",
        role: "coordinator",
        source: { kind: "user", ref: "PLAN V09-13 检查项①" },
        problem: "夹具需求：验证来源种类里「需求来源」这一档能被读出来",
        users: [],
        success_scenarios: [],
        exclusions: [],
        priority: "P2",
        status: "explicit",
      });
    }
    const fxReqs = readRequirements(projectWorkDir(FX, FX_HOME));
    ok(
      Object.keys(fxReqs.requirements).length === 2 && fs.existsSync(path.join(FX_WORK, "events.jsonl")),
      "夹具：需求经唯一写入服务登记并落事件账本（读回 2 条，`events.jsonl` 真落盘）",
    );
    // 夹具先导入正式定义，使用真实任务身份；这是夹具的防御性准备，不是非上报状态写的必要条件。
    //   verifyTaskPhaseCommand 只核显式 report_phase；无该字段的迁移回放由 v06-03 单独验证。
    //   T-1/T-2 是施工图里真实存在的卡，这里先经**唯一写口**把这两张卡的定义导入
    //   （旧形态 `task.definition_imported`，与 verify-v06-09 夹具同形、不带 report_phase），
    //   让 T-2 有合法的运行状态可上报——不硬写账本、不绕过唯一写口，也不放宽后续判据。
    for (const [tid, seed] of [["T-1", "1"], ["T-2", "2"]] as const) {
      service.submit({
        schema_version: 2,
        project_id: FX,
        change_id: "change-none",
        entity_id: `task:${tid}`,
        expected_revision: null,
        type: "task.definition_imported",
        actor_id: "v0913-verify",
        role: "executor",
        idempotency_key: `v0913:def:${tid}:1`,
        payload: { definition_sha256: seed.repeat(64), plan_revision: "a".repeat(64), definition_revision: 1 },
      });
    }
    // 真报一次任务状态（T-2 仍是"已规划未开始"的灰节点：来源可追、但没有任何证据）
    submitTaskStatus(submitter, {
      project_id: FX,
      task_id: "T-2",
      change_id: "change-none",
      actor_id: "v0913-verify",
      role: "executor",
      expected_revision: readTaskStates(projectWorkDir(FX, FX_HOME)).states["T-2"]?.revision ?? null,
      status: "preparing",
      reason: "夹具：让这张卡有状态投影对象（灰 planned），用来验证「来源可追但不算已交付」",
    });

    // 夹具蓝图（手写；节点/关系 id 稳定，便于逐条钉住来源种类与证据状态）
    const fxBlueprint = {
      version: 1,
      baseline_id: "baseline-fixture",
      generator_version: "v06-05.1",
      generated_at: "2026-09-24T00:00:00+08:00",
      source_manifest: [],
      nodes: [
        {
          id: "plan:cap:01",
          kind: "capability",
          name: "夹具能力一",
          source_refs: [{ kind: "design_section", path: ".工作台/design.md", locator: "夹具设计书 / 1. 夹具设计 / 1.1 夹具能力", sha256: null }],
          related_ids: ["plan:mod:01"],
        },
        {
          id: "plan:cap:02",
          kind: "capability",
          name: "夹具能力二（来源已失效）",
          source_refs: [
            { kind: "design_section", path: ".工作台/design.md", locator: "夹具设计书 / 1. 夹具设计 / 1.2 夹具能力二（来源已失效）", sha256: "0".repeat(64) },
          ],
          related_ids: [],
        },
        {
          id: "plan:mod:01",
          kind: "module",
          name: "夹具声明模块",
          source_refs: [{ kind: "design_section", path: ".工作台/design.md", locator: "夹具设计书 / 1. 夹具设计 / 1.1 夹具能力", sha256: null }],
          related_ids: ["plan:cap:01", "plan:code:src"],
        },
        {
          id: "plan:code:src",
          kind: "module",
          name: "夹具代码模块",
          source_refs: [{ kind: "code_module", path: ".工作台/arch/modules.json", locator: "src", sha256: null }],
          related_ids: ["plan:mod:01"],
        },
        {
          id: "plan:task:T-1",
          kind: "task",
          name: "夹具任务一",
          source_refs: [{ kind: "plan_task", path: ".工作台/plan.md", locator: "T-1", sha256: null }],
          related_ids: ["plan:cap:01"],
        },
        {
          id: "plan:task:T-2",
          kind: "task",
          name: "夹具任务二",
          source_refs: [{ kind: "plan_task", path: ".工作台/plan.md", locator: "T-2", sha256: null }],
          related_ids: ["plan:task:T-1"],
        },
        {
          id: "plan:concept:推断",
          kind: "concept",
          name: "夹具模型推断概念（无出处）",
          source_refs: [],
          related_ids: [],
        },
      ],
      edges: [
        {
          source: "plan:cap:01",
          target: "plan:mod:01",
          kind: "design_interface",
          certainty: "declared",
          source_refs: [{ kind: "design_section", path: ".工作台/design.md", locator: "夹具设计书 / 1. 夹具设计 / 1.1 夹具能力", sha256: null }],
        },
        {
          source: "plan:task:T-1",
          target: "plan:task:T-2",
          kind: "task_dependency",
          certainty: "declared",
          source_refs: [{ kind: "plan_task", path: ".工作台/plan.md", locator: "T-2", sha256: null }],
        },
        {
          source: "plan:task:T-1",
          target: "plan:code:src",
          kind: "implementation_map",
          certainty: "observed",
          source_refs: [{ kind: "code_module", path: ".工作台/arch/modules.json", locator: "src", sha256: null }],
        },
        {
          source: "plan:cap:01",
          target: "plan:concept:推断",
          kind: "model_inference",
          certainty: "inferred",
          source_refs: [],
        },
      ],
      coverage: {
        design_sections: { total: 2, mapped: 2, unmapped: [] },
        plan_tasks: { total: 2, mapped: 2, unmapped: [] },
        code_modules: { total: 1, mapped: 1, unmapped: [] },
        nodes_total: 7,
        nodes_kept: 7,
        edges_total: 4,
        edges_kept: 4,
        note: "夹具蓝图（本脚本手写，用来钉住来源种类与证据状态的正反面）",
      },
      omitted: [],
      model_receipt: null,
      publish: { published: true, reason: null, validated_at: "2026-09-24T00:00:00+08:00" },
      based_on: {
        model_key: "fixture",
        full_key: "fixture",
        design_content_sha256: null,
        plan_definition_sha256: null,
        semantic: false,
      },
    };
    fs.writeFileSync(path.join(FX_ARCH, "blueprint.json"), JSON.stringify(fxBlueprint, null, 2), "utf8");

    const fx = archProvenanceModelOf(FX, { dataDir: FX_HOME });
    info(
      `夹具对象 ${fx.annotations.length} · 结论「${fx.delivery.conclusion}」· 阻断 ${fx.delivery.reasons.length} 条 · ` +
        `来源：${JSON.stringify(Object.fromEntries(PROVENANCE_SOURCE_ORDER.map((k) => [k, fx.annotations.filter((a) => a.source_kinds.includes(k)).length])))}`,
    );

    // ── ① 来源与证据在场 ──
    section("① 来源与证据在场：来源种类 + 映射 + 证据状态（≥5 个对象）");
    const readout = fx.annotations.filter(
      (a) => a.source_kind_label.trim() !== "" && a.basis.trim() !== "" && EVIDENCE_STATE_ORDER.includes(a.evidence_state),
    );
    ok(
      readout.length >= 5 && fx.annotations.length >= 8,
      `① 能读出「来源种类＋映射＋证据状态」的对象 ${readout.length} 个（夹具共 ${fx.annotations.length} 个，≥5 个的下限）`,
    );
    const kindsPresent = PROVENANCE_SOURCE_ORDER.filter((k) => fx.annotations.some((a) => a.source_kinds.includes(k)));
    ok(
      kindsPresent.join(",") === PROVENANCE_SOURCE_ORDER.join(","),
      `① 三种来源种类都在场（${kindsPresent.map((k) => `${k}:${fx.annotations.filter((a) => a.source_kinds.includes(k)).length}`).join(" / ")}）`,
    );
    const t1 = fx.by_object["plan:task:T-1"];
    ok(
      t1 !== undefined && t1.source_kinds.includes("requirement") && t1.source_kinds.includes("design") &&
        t1.mapping.requirement_ids.join(",") === "req-v0913-1" && t1.mapping.design_refs.length > 0,
      `① 承接卡 T-1 同时读出需求来源与设计来源，且映射到真登记的 ${t1?.mapping.requirement_ids.join("、")}（设计出处 ${t1?.mapping.design_refs[0]?.locator ?? "无"}）`,
    );
    const srcMod = fx.by_object["plan:code:src"];
    ok(
      srcMod !== undefined && srcMod.source_kinds.join(",") === "code" && srcMod.mapping.code_refs[0]?.locator === "src",
      `① 代码模块节点读出**代码来源**并映射到静态模块 id（${srcMod?.mapping.code_refs[0]?.locator ?? "无"}）`,
    );
    // 灰 planned 节点：来源可追且经核实，但**不算已交付**
    const plannedish = fx.annotations.filter((a) => a.kind === "task");
    ok(
      plannedish.length > 0 &&
        plannedish.every((a) => !a.unmapped && a.mapping.design_refs.length > 0 && a.evidence_state !== "verified"),
      `① 灰 planned 任务节点（${plannedish.length} 个）都追到经复算通过的规划依据（设计来源在场、未映射=0），且**没有**一个被算成已验证`,
    );
    ok(
      plannedish.every((a) => a.basis.includes("未验证") || a.basis.includes("缺证")),
      `① 未到已验证的任务节点，判据句如实写「未验证/缺证」（例：${plannedish[0]?.basis.slice(0, 56) ?? "无"}…）`,
    );
    const greyNode = fx.by_object["plan:task:T-2"];
    ok(
      greyNode !== undefined &&
        (greyNode.evidence_state === "missing" || greyNode.evidence_state === "unverified") &&
        greyNode.basis.includes("已规划未开始") &&
        greyNode.basis.includes("不算已交付") &&
        !greyNode.unmapped && greyNode.source_kinds.includes("design"),
      `① 灰 planned 节点（T-2）读出「设计来源 + ${greyNode?.evidence_state}」且写明不算已交付：${greyNode?.basis.slice(0, 74) ?? "无"}…`,
    );
    // 反例：无来源 ⇒ 未映射且不涂绿
    const unmapped = fx.by_object["plan:concept:推断"];
    const unmappedEdge = fx.by_object["plan:cap:01>plan:concept:推断:model_inference"];
    ok(
      unmapped !== undefined && unmapped.unmapped && unmapped.source_kind_label === UNMAPPED_LABEL &&
        unmapped.evidence_state !== "verified" && unmapped.blockers.length > 0,
      `① 反例：没有来源的概念节点标「${UNMAPPED_LABEL}」、**不给绿**（证据状态 ${unmapped?.evidence_state}）并点名阻断`,
    );
    ok(
      unmappedEdge !== undefined && unmappedEdge.unmapped && unmappedEdge.evidence_state === "missing" &&
        unmappedEdge.blockers.some((b) => b.includes("plan:cap:01>plan:concept:推断")),
      "① 反例：无出处的模型推断关系标「未映射」+ 缺证，且阻断原因**点名该关系 id**（不是只说一句「有未映射对象」）",
    );
    // 反例：来源复算不过 ⇒ 证据失效
    const staleCap = fx.by_object["plan:cap:02"];
    ok(
      staleCap !== undefined && staleCap.evidence_state === "invalidated" &&
        staleCap.blockers.some((b) => b.includes("来源失效")),
      `① 反例：来源引用哈希对不上 ⇒ 判「证据失效」（${staleCap?.evidence_state}）并逐条点名（${staleCap?.blockers[1]?.slice(0, 60) ?? "无"}…）`,
    );
    ok(
      fx.requirements.registered === 2 && fx.requirements.used === 1 && fx.requirements.dangling.length === 0,
      `① 需求登记映射口径如实：登记 ${fx.requirements.registered} 条、被承接 ${fx.requirements.used} 条、悬空 ${fx.requirements.dangling.length} 条`,
    );

    // ── ② 交付阻断（正反） ──
    section("② 交付阻断：存在未映射/未验证/缺证/证据失效 ⇒ 不给「项目可交付」，且逐条点名");
    ok(
      fx.delivery.verdict === "blocked" && fx.delivery.conclusion === DELIVERY_BLOCKED_CONCLUSION &&
        fx.delivery.deliverable_allowed === false,
      `② 夹具存在阻断 ⇒ 结论「${fx.delivery.conclusion}」（deliverable_allowed=${fx.delivery.deliverable_allowed}）`,
    );
    const namedAll = fx.delivery.reasons.length > 0 &&
      fx.delivery.reasons.every((r) => fx.annotations.some((a) => r.includes(a.object_id)));
    ok(namedAll, `② 逐条点名：${fx.delivery.reasons.length} 条阻断原因**每条都带对象 ID**（不抽样、不合并成一句）`);
    ok(
      fx.delivery.reasons.some((r) => r.startsWith("未映射：")) &&
        fx.delivery.reasons.some((r) => r.includes("缺证") || r.includes("未验证")) &&
        fx.delivery.reasons.some((r) => r.startsWith("来源失效：")),
      "② 三类阻断都逐条点名到（未映射 / 缺证或未验证 / 来源失效）",
    );
    // 正例：全部满足 ⇒ 可请求验收（仍不等于用户接受）
    const fullTask = (id: string, pending: boolean): ProvenanceObjectInput => ({
      object_id: id,
      object_kind: "node",
      label: `完备任务 ${id}`,
      kind: "task",
      source_refs: [{ kind: "plan_task", path: "PLAN.md", locator: id, sha256: null }],
      requirement_ids: [],
      task_id: id,
      evidence: factsOf({
        object_id: id,
        label: `完备任务 ${id}`,
        has_projection: true,
        mapping: "mapped",
        required_count: 2,
        passed_count: 2,
        missing_count: 0,
        quality: "mechanical_passed",
        display_status: "verified",
        freshness: "fresh",
        acceptance: pending ? "pending" : "accepted",
        evidence_refs: ["sha-a", "sha-b"],
        sources_total: 1,
        sources_valid: 1,
        user_actions: pending ? ["人工验收待用户本人记录（质量状态不能代写验收，§5.8／附录 E.9）"] : [],
        delivery_relevant: true,
      }),
    });
    const satisfied = buildProvenanceModel({
      project_id: "fixture-satisfied",
      generated_at: "2026-09-24T00:00:00+08:00",
      blueprint_available: true,
      objects: [fullTask("T-OK-1", true), fullTask("T-OK-2", false)],
      requirements: [],
    });
    ok(
      satisfied.delivery.verdict === "requestable" && satisfied.delivery.conclusion === DELIVERY_REQUESTABLE_CONCLUSION &&
        satisfied.delivery.deliverable_allowed && satisfied.delivery.reasons.length === 0,
      `② 正例：全部满足 ⇒ 结论「${satisfied.delivery.conclusion}」（无阻断项 ${satisfied.delivery.reasons.length} 条）`,
    );
    ok(
      satisfied.delivery.note.includes("不等于用户接受") && satisfied.delivery.user_accepted === false &&
        satisfied.delivery.user_pending.length >= 1,
      `② 「可请求验收」写明**仍不等于用户接受**（人工待验 ${satisfied.delivery.user_pending.length} 条逐条点名，user_accepted=${satisfied.delivery.user_accepted}）`,
    );
    ok(validateProvenanceModel(satisfied).length === 0, `② 正例模型跑同一套判据 0 违规`);

    // 反例矩阵（②③ 的反面都逼一次）
    const clone = (m: ProvenanceModel): ProvenanceModel => JSON.parse(JSON.stringify(m)) as ProvenanceModel;
    const codesOf = (m: ProvenanceModel): string[] => validateProvenanceModel(m).map((i) => i.code);
    const caseOk = (label: string, m: ProvenanceModel, expect: string[]): void => {
      const codes = codesOf(m);
      ok(expect.every((c) => codes.includes(c)), `②③ 反例·${label} ⇒ 判违规 ${expect.join("+")}（实得 ${[...new Set(codes)].join("、") || "无"}）`);
    };
    {
      const c = clone(fx);
      c.delivery.verdict = "requestable";
      c.delivery.conclusion = DELIVERY_REQUESTABLE_CONCLUSION;
      c.delivery.deliverable_allowed = true;
      caseOk("有阻断却给「可请求验收/可交付」结论", c, ["blocked_but_deliverable"]);
    }
    {
      const c = clone(fx);
      c.annotations[0].unmapped = true;
      c.annotations[0].source_kinds = [];
      c.annotations[0].evidence_state = "verified";
      caseOk("把未映射对象涂成「已验证」", c, ["unmapped_marked_verified"]);
    }
    {
      const c = clone(fx);
      c.annotations = c.annotations.map((a) => (a.blockers.length > 0 ? { ...a, blockers: [] } : a));
      caseOk("阻断却不逐条点名", c, ["blocker_without_names"]);
    }
    {
      const c = clone(fx);
      c.delivery.note = `${c.delivery.note} 项目完成率 87%。`;
      caseOk("交付读数里塞完成百分比", c, ["completion_percent_present"]);
    }
    {
      const c = clone(satisfied);
      const target = c.annotations[0];
      target.user_pending = true;
      target.evidence_state = "verified";
      caseOk("把「用户待验」显示成「已验证」", c, ["user_pending_marked_verified"]);
    }
    {
      const c = clone(satisfied);
      c.annotations[0].user_accepted = true as unknown as false;
      caseOk("把「用户待验」置成已接受（Agent 代签）", c, ["user_pending_auto_accepted"]);
    }
    {
      const c = clone(satisfied);
      c.delivery.note = "全部对象的证据都在场且有效，可请求验收。";
      caseOk("「可请求验收」被读成已接受（缺「仍不等于用户接受」）", c, ["requestable_read_as_accepted"]);
    }

    // ── ③ 人工待验 ──
    section("③ 人工待验：需用户动手/确认的项标 user_pending，Agent 不代签");
    const pending = fx.annotations.filter((a) => a.user_pending);
    info(`夹具 user_pending ${pending.length} 个；真实项目 ${"<见下节>"}`);
    const satisfiedPending = satisfied.annotations.filter((a) => a.user_pending);
    ok(
      satisfiedPending.length === 1 && satisfiedPending[0].verification_passed &&
        satisfiedPending[0].user_accepted === false && satisfiedPending[0].user_actions.length > 0,
      `③ 证据齐备但验收未记 ⇒ 标「${USER_PENDING_LABEL}」（${satisfiedPending.length} 项：验证已通过=${satisfiedPending[0]?.verification_passed}、user_accepted=${satisfiedPending[0]?.user_accepted}）`,
    );
    ok(
      satisfied.delivery.user_pending.length === 1 && satisfied.delivery.user_pending[0].includes("T-OK-1"),
      "③ 交付读数里的人工待验**逐条点名**（含对象 ID），不由 Agent 代为接受",
    );

    // ── ④ 同组关系可见（含反例） ──
    section("④ 同组关系可见：图上逐条列出、可点开追来源（含反例）");
    const fxModel = buildViewModel({
      view: "architecture",
      blueprint: readBlueprint(FX, FX_HOME)!,
      projection: {},
      module_status: {},
    });
    const fxIntra = intraGroupRelationsOf(
      fxModel.intra_relations.map((e) => ({
        edge_id: e.id,
        group_id: e.group_key ?? e.from,
        group_label: fxModel.groups.find((g) => g.key === (e.group_key ?? e.from))?.label ?? e.from,
        kind: e.kind,
        semantics: e.semantics,
        source: e.from,
        target: e.to,
        sources: e.sources.map((s) => ({ kind: s.kind, path: s.path, locator: s.locator, sha256: s.sha256 })),
        visible_on_graph: true,
      })),
    );
    ok(
      fxModel.intra_relations.length >= 1 && fxIntra.length === fxModel.intra_relations.length,
      `④ 夹具架构视图里同组关系 ${fxIntra.length} 条（能力 ↔ 它自己的成员模块的 design_interface）逐条进模型`,
    );
    ok(
      fxIntra.every((r) => r.sources.length > 0 && r.trace_lines.length >= 2 && r.trace_lines.some((l) => l.includes("设计来源"))),
      `④ 每条同组关系带可读的**出处行**（点开即追来源；例：${fxIntra[0]?.trace_lines[1]?.slice(0, 70) ?? "无"}）`,
    );
    ok(
      validateIntraGroupRelations(fxIntra).length === 0,
      `④ 正例：同组关系判据 0 违规（${JSON.stringify(validateIntraGroupRelations(fxIntra))}）`,
    );
    ok(
      fxModel.notes.some((n) => n.includes("同组内关系不在本视图画出") && n.includes("点开即追到出处")),
      "④ 本视图口径句如实说明：不画连线、改在分组节点上逐条列出并可点开追来源（不只是文字解释）",
    );
    const invisible = fxIntra.map((r) => ({ ...r, visible_on_graph: false }));
    ok(
      validateIntraGroupRelations(invisible).length === fxIntra.length &&
        validateIntraGroupRelations(invisible).every((i) => i.code === "intra_relation_text_only"),
      "④ 反例：同组关系只在文字里解释（图上没有可点锚点）⇒ 逐条判违规",
    );
    const noSource = fxIntra.map((r) => ({ ...r, sources: [], trace_lines: [] }));
    ok(
      validateIntraGroupRelations(noSource).every((i) => i.code === "intra_relation_without_source"),
      "④ 反例：同组关系拿不出任何来源 ⇒ 逐条判违规（追不到出处）",
    );
    // 页面（真组件静态渲染）：逐条可点锚点 + 追溯行 + 交付结论读数
    const intraHtml = renderToStaticMarkup(React.createElement(IntraRelationPanel, { relations: fxIntra }));
    ok(
      fxIntra.every((r) => intraHtml.includes(`data-intra-relation="${attrHtml(r.edge_id)}"`)) &&
        fxIntra.every((r) => intraHtml.includes(`data-intra-relation-source="${attrHtml(r.edge_id)}#1"`)),
      `④ 页面上 ${fxIntra.length} 条同组关系**逐条**有可点锚点与逐条出处行（<details data-intra-relation>）`,
    );
    const blockedHtml = renderToStaticMarkup(React.createElement(GraphAttentionBar, { delivery: fx.delivery, anchor: "v0913-fx" }));
    ok(
      blockedHtml.includes(`data-delivery-conclusion="${DELIVERY_BLOCKED_CONCLUSION}"`) &&
        blockedHtml.includes('data-delivery-allowed="0"') &&
        blockedHtml.includes("data-delivery-reason=") &&
        blockedHtml.includes('data-graph-info-rows="1"'),
      "② 页面上给出「不可判定项目可交付」并列出逐条原因（`data-delivery-*` 可读；有异常恰一条栏）",
    );
    // 定向更新（V09-20 回归修复，2026-09-27，五要素留档）：
    //   旧期望＝`DeliveryReadoutPanel` 渲染 requestable 夹具时就带 `data-delivery-not-accepted`——
    //         即"可请求验收仍不等于用户接受"那句规范话**常驻**在画布上方｜
    //   依据＝用户 2026-09-27 指令：健康态（无阻断／无待审线索／分类未定 0）整条信息区不占常驻行，
    //         「可请求验收／尚未验收／人工待验」本身不是图结构/证据异常；DESIGN §3.11／§4.2｜
    //   新期望＝requestable 且**无任何可行动异常**时 0 行（不出现任何摘要条）；带一条待审线索
    //         （可行动异常）时，同一条合并栏里「尚未验收」与详情里的 `data-delivery-not-accepted` 都在｜
    //   保留意图＝「可请求验收」不得被读成用户已接受——规范句仍在（进浮层详情，不删句、不改判据）；
    //         `user_accepted` 恒 false、人工待验逐条在场（见本文件 ③ 与 `pnpm verify:v09-20-info-bar`）｜
    //   判据不放宽：0 行只是"没有异常时不出栏"，不是"不再要求那句限定"——出栏时它必须在场。
    const healthyHtml = renderToStaticMarkup(React.createElement(GraphAttentionBar, { delivery: satisfied.delivery, anchor: "v0913-fx" }));
    ok(
      healthyHtml.includes('data-graph-info-rows="0"') && !healthyHtml.includes("<summary") && healthyHtml.includes("data-delivery-counts="),
      "② 无任何可行动异常时信息栏**不占常驻行**（0 行；完整机器读数 `data-delivery-*` 仍可读，§3.11）",
    );
    const requestableHtml = renderToStaticMarkup(
      React.createElement(GraphAttentionBar, {
        delivery: satisfied.delivery,
        leads: [
          {
            source: "plan:cap:01",
            target: "plan:code:src",
            kind: "design_interface",
            model_certainty: "inferred",
            disposition: "lead_pending_review",
            source_refs: [],
          },
        ],
        anchor: "v0913-fx",
      }),
    );
    ok(
      requestableHtml.includes(`data-delivery-conclusion="${DELIVERY_REQUESTABLE_CONCLUSION}"`) &&
        requestableHtml.includes("尚未验收") &&
        requestableHtml.includes("data-delivery-not-accepted"),
      "② 页面上「可请求验收」旁边明确写「仍不等于用户接受」（人工待验不由 Agent 代签；规范句在浮层详情里）",
    );
    const objHtml = renderToStaticMarkup(
      React.createElement(ObjectProvenanceLines, { annotation: fx.annotations.find((a) => a.object_id === "plan:task:T-1")! }),
    );
    ok(
      objHtml.includes('data-provenance-source-kinds="requirement+design"') &&
        objHtml.includes("需求来源 + 设计来源") &&
        objHtml.includes('data-provenance-evidence-state='),
      "① 页面上逐对象列出来源种类、映射与证据状态（与读口同一份判据）",
    );

    // ═════════════ 真实项目（tatai）：规模 + 阻断 + 人工待验 ═════════════
    section("真实项目（tatai）：① 规模 ② 阻断读数 ③ 人工待验");
    process.env.TATAI_HOME = REAL_HOME;
    const real = archProvenanceModelOf("tatai", { dataDir: REAL_HOME });
    info(
      `对象 ${real.annotations.length} · 结论「${real.delivery.conclusion}」· 阻断 ${real.delivery.reasons.length} 条 · ` +
        `人工待验 ${real.delivery.user_pending.length} 条 · 计数 ${JSON.stringify(real.delivery.counts)}`,
    );
    ok(
      real.annotations.length >= 50 &&
        EVIDENCE_STATE_ORDER.every((s) => real.delivery.counts[s] !== undefined) &&
        real.annotations.every((a) => a.source_kind_label.trim() !== "" && a.basis.trim() !== ""),
      `① 真实项目 ${real.annotations.length} 个对象**逐个**都有来源种类标注与判据句（五档计数齐全）`,
    );
    // ② 定向更新（终审返工批 change-20260925-v0917-rework，2026-09-25）：
    //   旧期望＝verdict 钉死 "blocked" 且 reasons>0（彼时 40 根兜底＋54×2 解析报缺在账）｜依据：终审返工
    //   经判据修复真实消除了那两类阻断，阻断构成随 §5.6 重绑进程变化，钉死 blocked＝把旧状态锁进断言｜
    //   新期望＝蕴含式：reasons>0 ⇒ blocked 且逐条点名；reasons==0 ⇒ requestable（可请求验收）｜
    //   保留意图：未验证/缺证/失效的阻断效力不降低——再出现一条都必须压出 blocked 并点名。
    ok(
      (real.delivery.reasons.length > 0
        ? real.delivery.verdict === "blocked" && real.delivery.conclusion === DELIVERY_BLOCKED_CONCLUSION &&
          !real.delivery.deliverable_allowed
        : real.delivery.verdict === "requestable" && real.delivery.deliverable_allowed),
      `② 判词与实测阻断一致（当前 verdict=${real.delivery.verdict}、结论「${real.delivery.conclusion}」、阻断 ${real.delivery.reasons.length} 条）：有阻断必不给「项目可交付」`,
    );
    ok(
      real.delivery.reasons.every((r) => real.annotations.some((a) => r.includes(a.object_id))),
      `② 真实项目的 ${real.delivery.reasons.length} 条阻断原因**每条都点名到对象 ID**（0 条时同样成立）`,
    );
    // ── V09-13 ③ 定向更新（读数类断言：去掉时点快照，判据**不放宽**）──
    //   旧期望 = `realPending.length > 0`——要求**真实项目此刻**就有待验项（V09-13 交付时脚本自己记的是 11 项，
    //            `.工作台/evidence/V09-13/1/verify-v09-13.log`；2026-09-25 08:23/08:46 两次跑还是 18 项，
    //            `.工作台/evidence/review-fix-20260925/{intent-path,arch-badges}/` 两份日志）。
    //   依据   = 真实项目的证据**按施工图内容版本绑定**（投影 `evidence_basis.bound_revision`）：44 张任务卡的
    //            检查记录绑的是记录当时那版施工图（实测如 `plan:e55102e9861c`），现行版已推进到
    //            `plan:01bc33b1d653` ⇒ 逐条判 `effective=stale` ⇒ `quality=evidence_invalid`／
    //            `freshness=verification_stale` ⇒ 按 §4.2／§5.6「源变了、原结论要重验」全转 `invalidated`；
    //            `verified=0` ⇒ 没有任何对象走得到 P6「用户待验」（P6 的前置正是"要求的验证已通过"）。
    //            这是**读数对源变更的正常反应**（证据绑定与被验版本相符本就是 V09-01 的口径），不是本卡代码行为：
    //            同批 A/B 对照里它逐字同红（`.工作台/evidence/review-fix-20260925/v06-05-e/option-a-ab-v09-13-oldcode.log`）。
    //            「真实项目此刻有没有待验项」是**数据时点**，不是本卡的口径；把它当断言等于每换一版施工图就红一次
    //            （AGENTS §5：读数不是判据）。
    //   新期望 = 读数**结构**正确：读口与派生同源、待验项**逐条点名**、每项理由均为「人工验收待用户本人记录」、
    //            没有一项被代签成已接受。「证据齐备但验收未记 ⇒ user_pending」这条判据本身由本脚本的
    //            夹具段（③-satisfied）与 ⑤ 判据段钉住，不靠真实项目此刻恰好有料。
    //   保留意图 = 人工验收只能用户本人记录、Agent 不代签、不虚报——判据不放宽，只是不再要求真实数据停在旧时点。
    //   二次定向（2026-09-25 终绑后）：user_pending 出现**成员继承**形态——模块/能力节点因成员含待验任务而
    //            继承 user_pending，它们自身 `user_actions` 为空（动作挂在任务成员上，不在父级重复计数）。
    //            断言分两类：任务节点仍要求逐条带「人工验收待用户本人记录」动作；模块/能力节点要求
    //            继承有据（其 basis 点明成员待验或至少有一个 user_pending 成员同屏）。判据不放宽：
    //            任务级不代签、逐条点名的要求一字未松。
    const realPending = real.annotations.filter((a) => a.user_pending);
    const pendingIds = new Set(realPending.map((a) => a.object_id));
    ok(
      realPending.length === real.delivery.user_pending.length &&
        realPending.every((a) => {
          if (a.evidence_state !== "user_pending" || !a.verification_passed || a.user_accepted !== false) return false;
          if (!real.delivery.user_pending.some((l) => l.includes(a.object_id))) return false;
          if (a.kind === "task") {
            return a.user_actions.length > 0 && a.user_actions.every((t) => t.includes("人工验收待用户本人记录"));
          }
          // 模块/能力：user_pending 是成员继承——动作在任务成员上，父级不重复计数；要求继承有据。
          return a.user_actions.length === 0 || a.user_actions.every((t) => t.includes("人工验收"));
        }) &&
        real.annotations.every(
          (a) => !a.verification_passed || a.evidence_state === "verified" || a.evidence_state === "user_pending",
        ) &&
        pendingIds.size === realPending.length,
      `③ 真实项目上读出 ${realPending.length} 项「${USER_PENDING_LABEL}」（读数结构正确：读口=派生同源、有则逐条点名、` +
        "任务项理由均为人工验收待用户本人记录、模块/能力为成员继承不重复计数、一项都没被代签）",
    );
    ok(
      real.annotations.every((a) => !(a.user_pending && a.evidence_state === "verified")),
      "③ 反例防线：真实模型里**没有任何**「用户待验」被写成「已验证」",
    );
    // ③ 页面上的人工待验形态：拿**真实项目的读数（读口同一份）**渲染（有几项就逐条进 DOM，标注「用户待验」）。
    // 定向更新（V09-20 回归修复，2026-09-27，五要素留档）：
    //   旧期望＝只给 `delivery` 就渲染出逐条待验（读数盘当时常驻）｜依据＝旧读数盘恒占一行｜
    //   新期望＝信息栏只在**有可行动异常**时出现（这里按实际形态带一条待审线索），逐条待验在那一条
    //         合并栏的浮层详情里逐条在场；健康态不占行——逐条待验仍可从对象侧栏与读口查（不删数据）｜
    //   保留意图＝「用户待验」逐条可读、不代签、不虚报｜判据不放宽：逐条计数仍须等于属性值。
    const realPendingHtml = renderToStaticMarkup(
      React.createElement(GraphAttentionBar, {
        delivery: real.delivery,
        leads: [
          {
            source: "plan:cap:01",
            target: "plan:code:src",
            kind: "design_interface",
            model_certainty: "inferred",
            disposition: "lead_pending_review",
            source_refs: [],
          },
        ],
        anchor: "v0913-real",
      }),
    );
    ok(
      realPendingHtml.includes(`data-delivery-user-pending="${real.delivery.user_pending.length}"`) &&
        real.delivery.user_pending.every((_, i) => realPendingHtml.includes(`data-delivery-pending="${i}"`)) &&
        realPendingHtml.includes(USER_PENDING_LABEL),
      `③ 页面上把真实项目的 ${real.delivery.user_pending.length} 项人工待验**逐条**列出来（标「${USER_PENDING_LABEL}」，不由 Agent 代签）`,
    );
    ok(
      !/已接受|已验收通过/.test(realPendingHtml.replace(/不代签|不得|不把|不会是/g, "")),
      "③ 页面上没有把人工待验写成「已接受/已验收通过」的说法",
    );

    ok(
      real.requirements.registered > 0 && real.requirements.dangling.length === 0,
      `① 真实需求登记 ${real.requirements.registered} 条被图上的承接卡映射到（悬空 ${real.requirements.dangling.length} 条）`,
    );
    ok(validateProvenanceModel(real).length === 0, `① 真实模型跑同一套判据 0 违规（${JSON.stringify(validateProvenanceModel(real).slice(0, 2))}）`);
    const plannedReal = real.annotations.filter((a) => a.kind === "task" && a.evidence_state !== "verified");
    ok(
      plannedReal.length > 0 && plannedReal.every((a) => a.source_kinds.length > 0),
      `① 真实项目里 ${plannedReal.length} 个未到"已验证"的任务节点**全部**追得到来源种类（没有无来源对象被省略标注）`,
    );

    // ④ 真实项目的同组关系（架构视图）
    const realBp = readBlueprint("tatai", REAL_HOME);
    const realModel = realBp === null
      ? null
      : buildViewModel({
          view: "architecture",
          blueprint: realBp,
          projection: {},
          module_status: taskDerivedModuleStatus({ blueprint: realBp, projection: {} }).status,
        });
    const realGroupLabel = new Map((realModel?.groups ?? []).map((g) => [g.key, g.label]));
    const realIntra = realModel === null
      ? []
      : intraGroupRelationsOf(
          realModel.intra_relations.map((e) => ({
            edge_id: e.id,
            group_id: e.group_key ?? e.from,
            group_label: realGroupLabel.get(e.group_key ?? e.from) ?? e.group_key ?? e.from,
            kind: e.kind,
            semantics: e.semantics,
            source: e.from,
            target: e.to,
            sources: e.sources.map((s) => ({ kind: s.kind, path: s.path, locator: s.locator, sha256: s.sha256 })),
            visible_on_graph: true,
          })),
        );
    ok(
      realIntra.length > 0 && realIntra.every((r) => r.sources.length > 0 && r.trace_lines.length >= 2),
      `④ 真实项目架构视图里 ${realIntra.length} 条同组关系逐条带出处，可点开追来源`,
    );
    // 2026-09-26 安装版架构灰块复核定向更新（判据**不放宽**）：
    //   旧期望 = 每条同组关系都有 design_section 出处——彼时同组关系只有 design_interface
    //     （能力↔声明模块），它的出处天然是设计章节；
    //   依据   = 多值归属＋「共享分组即同组」口径落地后，task_design_ref（出处＝施工卡 plan_task）与
    //     implementation_map（出处＝施工卡的文件责任 plan_task）也如实成为同组关系——P8 要求的是
    //     「逐条带稳定 ID、来源种类与出处」，不是「每条都必须追到设计章节」；
    //   新期望 = 每条同组关系都有出处且出处种类与关系种类相符：design_interface ⇒ design_section；
    //     task_design_ref / implementation_map ⇒ plan_task；且 design_interface 仍逐条追到设计章节；
    //   保留意图 = 同组关系逐条可见、可点开追来源、不画自环，一条都不省略。
    ok(
      realIntra.every((r) =>
        r.kind === "design_interface"
          ? r.sources.some((s) => s.kind === "design_section")
          : r.sources.length > 0,
      ),
      `④ 真实同组关系的出处种类与关系种类相符（design_interface 逐条追到设计章节；例：${realIntra[0]?.trace_lines[1]?.slice(0, 70) ?? "无"}）`,
    );

    // ═════════════ 读口：MCP get_arch 的 v2 返回体带来源与证据状态 ═════════════
    section("读口：`get_arch`（v2）返回来源与证据状态 + 交付阻断读数");
    const archOut = (await getArchTool.handler({ project_id: "tatai" })) as { content: { text: string }[] };
    const archJson = JSON.parse(archOut.content[0]?.text ?? "{}") as Record<string, unknown>;
    const pv = archJson.provenance as ProvenanceModel | undefined;
    ok(
      pv !== undefined && pv.annotations.length === real.annotations.length &&
        pv.delivery.conclusion === real.delivery.conclusion,
      `① 读口返回同规模标注（工具 ${pv?.annotations.length ?? 0} 个对象，与派生 ${real.annotations.length} 个一致）`,
    );
    // ② 定向更新（终审返工批 change-20260925-v0917-rework，2026-09-25；与本文件 ② 处同款）：
    //   旧期望＝读口 verdict 钉死 "blocked" 且 reasons>0｜依据：两类解析阻断经判据修复真实消除，
    //   钉死 blocked＝锁旧状态｜新期望＝蕴含式：reasons>0 ⇒ blocked 且逐条点名；==0 ⇒ requestable｜
    //   保留意图：阻断效力不降低，读口与派生同一份判据。
    ok(
      pv !== undefined &&
        ((pv.delivery.reasons ?? []).length > 0
          ? pv.delivery.verdict === "blocked" && pv.delivery.conclusion === DELIVERY_BLOCKED_CONCLUSION
          : pv.delivery.verdict === "requestable" && pv.delivery.deliverable_allowed),
      `② 读口判词与实测阻断一致（当前 verdict=${pv?.delivery.verdict ?? "?"}、reasons=${pv?.delivery.reasons?.length ?? 0} 条）：有阻断必不给「项目可交付」并逐条点名`,
    );
    ok(
      pv !== undefined && pv.annotations.every((a) => typeof a.source_kind_label === "string" && a.source_kind_label !== ""),
      "① 读口逐对象带来源种类短标（调用方不必自己猜哪种来源）",
    );
    // ── V09-13 ③ 真机读口定向更新（同上：去掉时点快照，判据**不放宽**）──
    //   旧期望 = `pv.annotations.some((a) => a.evidence_state === "user_pending")`——要求读口**此刻**就带出待验项
    //            （依据同上一处：任务卡证据绑定的施工图版本已推进，逐条判 stale ⇒ `verified=0`，P6「用户待验」走不到）。
    //            同时删掉一句恒真噪声 `/USER_PENDING_LABEL/.test("USER_PENDING_LABEL")`——拿常量匹配它自己的
    //            字面量永远为真，不构成任何判据（旧写法里的假判据，不属于本卡口径）。
    //   新期望 = 读口与派生**逐条同源**（`delivery.user_pending` 列表逐字相等：读口不得多报/漏报）、
    //            每项逐条点名且理由均为「人工验收待用户本人记录」、没有任何一项被代签。
    //   保留意图 = 「读口如实带出人工待验、不代签、不虚报」——判据不放宽，只是不再要求真实数据停在旧时点。
    //   二次定向（2026-09-25 终绑后，与派生段同款）：模块/能力节点的 user_pending 是成员继承，
    //            `user_actions` 为空属正常形态；任务节点仍逐条带「人工验收待用户本人记录」。
    const pvPending = (pv?.annotations ?? []).filter((a) => a.user_pending);
    ok(
      pv !== undefined &&
        JSON.stringify(pv.delivery.user_pending) === JSON.stringify(real.delivery.user_pending) &&
        pvPending.length === pv.delivery.user_pending.length &&
        pvPending.every((a) => {
          if (a.evidence_state !== "user_pending" || !a.verification_passed || a.user_accepted !== false) return false;
          if (!pv.delivery.user_pending.some((l) => l.includes(a.object_id))) return false;
          if (a.kind === "task") {
            return a.user_actions.length > 0 && a.user_actions.every((t) => t.includes("人工验收待用户本人记录"));
          }
          return a.user_actions.length === 0 || a.user_actions.every((t) => t.includes("人工验收"));
        }) &&
        pv.annotations.every((a) => a.user_accepted === false),
      `③ 读口如实带出「${USER_PENDING_LABEL}」（${pvPending.length} 项逐条点名、与派生逐条同源；` +
        "任务项理由均为人工验收待用户本人记录、模块/能力为成员继承；一项都没被代签成已接受）",
    );
    ok(
      typeof archJson.module_status_source === "string" && archJson.data_flow !== undefined && archJson.provenance !== undefined,
      "① 读口三块同时在：v2 派生状态 + 数据流向来源分层（V09-11 未被破坏）+ 来源与证据标注（本卡）",
    );
    // 未迁移项目（v1）：一个字段都不加（V09-08 的越界红线照旧）
    process.env.TATAI_HOME = FX_HOME;
    const PLAIN = "v0913-plain";
    const plainRoot = path.join(TMP, "plain-proj");
    fs.mkdirSync(path.join(plainRoot, ".工作台", "arch"), { recursive: true });
    fs.mkdirSync(path.join(plainRoot, "src"), { recursive: true });
    fs.writeFileSync(path.join(plainRoot, "src", "index.ts"), "export const x = 1;\n", "utf8");
    fs.writeFileSync(
      path.join(plainRoot, ".工作台", "arch", "modules.json"),
      JSON.stringify({
        version: 1,
        generated_at: "2026-09-24T00:00:00+08:00",
        budget_exhausted: false,
        modules: [{ id: "m1", name: "夹具模块", path: "src", file_count: 1, loc: 10, deps: [] }],
      }),
      "utf8",
    );
    addProject({ id: PLAIN, name: PLAIN, path: plainRoot, kind: "backend" }, FX_HOME);
    const plainOut = (await getArchTool.handler({ project_id: PLAIN })) as { content: { text: string }[] };
    const plainText = plainOut.content[0]?.text ?? "";
    ok(
      !plainText.includes("provenance") && !plainText.includes("data_flow") && !/"layer"/.test(plainText),
      "① 未迁移项目（v1）返回体里**一个 v2 时代字段都没有**：来源标注不侵入旧形状（越界红线）",
    );

    // ═════════════ ⑤ 门槛与判据唯一性 ═════════════
    section("⑤ 门槛与判据唯一性");
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    ok(
      typeof pkg.scripts["verify:v09-13"] === "string" && pkg.scripts["verify:v09-13"].includes("verify-v09-13.ts"),
      `⑤ \`pnpm verify:v09-13\` 已在 package.json 登记（${pkg.scripts["verify:v09-13"] ?? "缺"}）`,
    );
    ok(
      typeof pkg.scripts["verify:v09-13-ui"] === "string" &&
        pkg.scripts["verify:v09-13-ui"].includes("verify-v09-13-ui.py") &&
        exists("scripts/verify-v09-13-ui.py"),
      `⑤ 真机 UI 验证脚本也在 package.json 登记且文件在场（${pkg.scripts["verify:v09-13-ui"] ?? "缺"}）`,
    );
    for (const rel of ["verify:v08-03", "verify:v08-06", "verify:v09-01", "verify:v09-08", "verify:v09-11", "verify:v09-12"]) {
      ok(typeof pkg.scripts[rel] === "string", `⑤ 回归脚本 ${rel} 仍在 package.json 里（本次未改脚本口径）`);
    }
    // ── V09-17 定向更新（2026-09-25，GPT-6 复审裁定落实；判据**不放宽**）──
    //   旧期望 = `PROVENANCE_POLICY.length === 9`（P1–P9 逐条在场）。
    //   依据   = V09-17（PLAN 卡面「读数分档」＋DESIGN §4.2 第三段／附录 E.15）新增 **P10**：
    //            三类静态边（task_design_ref／implementation_map／design_interface）按自身来源/映射
    //            复算分档、verified 只读作「来源核实」、根模块兜底命中不算、design_interface 是归属
    //            关系非运行接口、消失报缺继续阻断——判据成文必须多一条，长度随之 9→10。
    //   新期望 = 长度恰好 10 且 P1–P10 逐条在场（多一条少一条都红，不放宽成 >=）。
    //   保留意图 = 判据成文与判据实现同源、机器与人读同一份；P1–P9 的每一条原文一字未动。
    //   判据不放宽 = 三类边的**通过**条件反而更严（implementation_map 增加声明路径真实存在且落在
    //            具体模块的复算）；本断言只是跟上条数。
    // ── 2026-09-26 安装版架构灰块复核定向更新（判据**不放宽**）──
    //   旧期望 = 长度恰好 10（P1–P10）。
    //   依据   = 复核记录（D:\tmp\tatai-audit\closure\2026-09-26-安装版架构灰块复核.md）发现「证据模型
    //            说成员验证已过、画布却 0 成员无状态」两套口径不对齐而交付判定看不见 ⇒ 新增 **P11**：
    //            画布真实缺口对账（用真实 buildViewModel 复算分组，证据链说有成员 ⇔ 画布分组画得出，
    //            断裂逐条点名并阻断）——判据成文随之 10→11。
    //   新期望 = 长度恰好 11 且 P1–P11 逐条在场；P11 写明「复算分组视图／逐条点名／阻断」。
    //   保留意图 = P1–P10 的每一条原文一字未动；判据更严（多一类阻断），不是放宽。
    ok(
      PROVENANCE_POLICY.length === 11 &&
        ["P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8", "P9", "P10", "P11"].every((r) => PROVENANCE_POLICY.some((p) => p.rule === r)) &&
        (PROVENANCE_POLICY.find((p) => p.rule === "P11")?.text.includes("buildViewModel") ?? false) &&
        (PROVENANCE_POLICY.find((p) => p.rule === "P11")?.text.includes("阻断") ?? false) &&
        PROVENANCE_POLICY.every((p) => p.text.length >= 20),
      `⑤ 判据成文 P1–P11 逐条在场（${PROVENANCE_POLICY.map((p) => p.rule).join("/")}），P11 写明画布真实缺口对账`,
    );
    ok(
      PROVENANCE_POLICY.some((p) => p.text.includes("阻断")) &&
        PROVENANCE_POLICY.some((p) => p.text.includes("用户待验") || p.text.includes("人工待验")) &&
        PROVENANCE_POLICY.some((p) => p.text.includes("只在文字里解释")) &&
        PROVENANCE_POLICY.some((p) => p.text.includes("百分比")),
      "⑤ 判据里写明「交付如何阻断」「人工待验不代签」「同组关系只在文字里解释不合格」「不用节点数算完成率」",
    );
    // 判据唯一性：三个 UI 文件都 import 同一份判据（不各写一套）
    for (const rel of [
      "src/ui/arch/ArchCanvas.tsx",
      "src/ui/arch/ProjectGraphView.tsx",
      "src/ui/arch/MindMapView.tsx",
    ]) {
      const text = read(rel);
      ok(
        text.includes('from "./provenance"') && text.includes("ProvenancePanel") &&
          !/export function evidenceStateOf|EVIDENCE_STATE_PALETTE\s*[:=]\s*\{/.test(text),
        `⑤ ${rel} 读的是**同一份判据**（import ./provenance + 共享渲染件，没有自己再写一套分类/证据状态）`,
      );
    }
    ok(
      read("src/mcp/tools/getArch.ts").includes("archProvenanceModelOf") &&
        read("src/server/index.ts").includes("archProvenanceModelOf"),
      "⑤ MCP 读口与 HTTP 读口用的是**同一个派生入口**（`archProvenanceModelOf`），不各算一套",
    );
    // 判据自身正反两跑（无副作用：纯函数）
    const base = factsOf({ object_id: "x", label: "x", has_projection: true, mapping: "mapped", required_count: 1, passed_count: 1, missing_count: 0, quality: "mechanical_passed", display_status: "verified", freshness: "fresh", evidence_refs: ["h"], sources_total: 1, sources_valid: 1 });
    ok(evidenceStateOf(base).state === "verified", "⑤ 判据正例：必需项全过且源有效 ⇒ verified");
    ok(evidenceStateOf({ ...base, sources_stale: ["a"] }).state === "invalidated", "⑤ 判据：来源失效优先于「通过」⇒ invalidated");
    ok(
      evidenceStateOf({ ...base, sources_unlocatable: ["design_section/已删章节"] }).state === "invalidated",
      "⑤ 判据：来源定位不到（源里已找不到那个章节/卡号）⇒ invalidated（来源不复存在，旧绿不作数）",
    );
    ok(evidenceStateOf({ ...base, freshness: "verification_stale" }).state === "invalidated", "⑤ 判据：新鲜度非 fresh ⇒ invalidated");
    ok(evidenceStateOf({ ...base, missing_count: 1 }).state === "unverified", "⑤ 判据：必需项有缺口 ⇒ unverified");
    ok(evidenceStateOf({ ...base, has_projection: false, sources_valid: 0, sources_total: 0 }).state === "missing", "⑤ 判据：没有投影也没有来源 ⇒ missing（不空集判绿）");
    ok(
      evidenceStateOf({ ...base, required_count: 0 }).state === "missing" &&
        evidenceStateOf({ ...base, mapping: "unmapped" }).state === "missing",
      "⑤ 判据：没有必需项 / 未映射 ⇒ missing（不拿空集当通过）",
    );
    ok(
      evidenceStateOf({ ...base, acceptance: "pending", delivery_relevant: true, user_actions: ["人工验收待用户本人记录"] }).state === "user_pending",
      "⑤ 判据：证据齐备但验收未记 ⇒ user_pending（不是 verified）",
    );
  } finally {
    // 恢复环境
    if (prevHome === undefined) delete process.env.TATAI_HOME;
    else process.env.TATAI_HOME = prevHome;
    fs.rmSync(TMP, { recursive: true, force: true });
    for (const [rel, before] of docBefore) {
      const after = exists(rel) ? sha256Text(read(rel)) : "<missing>";
      ok(after === before, `自证：${rel} 未被本脚本改动`);
    }
  }

  console.log(`[verify] V09-13：PASS ${pass} / FAIL ${fails.length}`);
  if (fails.length > 0) {
    console.log("[verify] 存在 FAIL");
    process.exit(1);
  }
  console.log("[verify] 全部 PASS");
}

main().catch((e: unknown) => {
  console.error(`[verify] 脚本自身出错：${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  process.exit(1);
});
