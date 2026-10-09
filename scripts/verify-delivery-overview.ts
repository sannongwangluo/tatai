// V09-62 后端验证脚本（tsx 跑）：交付总览 `FeatureLedger.delivery` 与逐项 `FeatureItem.agent_review`
// （DESIGN.md §3.16／§3.17）。
// 用法：pnpm exec tsx scripts/verify-delivery-overview.ts
//
// 自带隔离环境：临时 `TATAI_HOME` + `os.tmpdir()` 下的夹具项目，**不碰**任何真实项目/账本/生产服务
// （绝不连真实 8787）。**负例优先、真实行为**：只经 `readFeatureLedger` / MCP 工具的真实调用与真实事件
// 账本判分（不 grep 源码字符串自证）。先证「无声明/缺行/重复/悬空/空/未批准/作者自检/同会话降级/过期/
// 未映射/待审/开放缺陷/局部/历史/漂移」都不能假「可试用」，再证「全条件满足且人工 pending」可进入试用。
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { WorkService, WorkServiceClient, handleWorkRequest, writeServiceDescriptor } from "../src/server/work/service";
import { addProject } from "../src/server/registry";
import { activateBaseline } from "../src/server/work/documents";
import { importTaskDefinitions } from "../src/server/work/plan";
import { submitDefinitionImports } from "../src/server/work/tasks";
import { registerRequirement, setRequirementStatus, readRequirements } from "../src/server/work/requirements";
import { projectWorkDir } from "../src/server/workstation";
import { projectWorkbenchDir } from "../src/server/work/documents";
import { sectionsOf } from "../src/server/work/coverageModel";
import { collectProjectFacts } from "../src/server/work/statusProjection";
import { buildSourceManifest } from "../src/server/work/sourceEvidence";
import { readFeatureLedger, type FeatureLedgerParams, type FeatureLedgerResult } from "../src/server/work/featureLedger";
import { parseDeliveryGateDeclaration } from "../src/server/work/deliveryReadout";
import { featureLedgerTool } from "../src/mcp/tools/featureLedger";
import { recordWorkEvidenceTool } from "../src/mcp/tools/recordWorkEvidence";
import type { McpContext } from "../src/mcp/tools/types";
import type { FeatureLedger } from "../src/shared/coverageTypes";

let pass = 0;
let fail = 0;
const ok = (cond: boolean, label: string, detail?: unknown): void => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (cond) pass++;
  else {
    fail++;
    process.exitCode = 1;
    if (detail !== undefined) console.log(`[verify]   现场：${JSON.stringify(detail).slice(0, 1600)}`);
  }
};
const section = (t: string): void => console.log(`\n[verify] ═══ ${t}`);

const sha256 = (b: string | Buffer): string => crypto.createHash("sha256").update(b).digest("hex");
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-v09-62-"));
const dataDir = path.join(tmpBase, "home");
fs.mkdirSync(dataDir, { recursive: true });
process.env.TATAI_HOME = dataDir;
const service = new WorkService({ dataDir });
const CODE_REV = sha256("dv-code-rev");
const CODE_REV_OLD = sha256("dv-code-rev-OLD");

const write = (f: string, text: string): void => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text, "utf8");
};
const submitter = { submit: (c: unknown) => service.submit(c) };

const registerRequirementFor = (
  projectId: string,
  rid: string,
  status: "explicit" | "inferred" | "unconfirmed" = "explicit",
): void => {
  registerRequirement(submitter as never, {
    project_id: projectId,
    requirement_id: rid,
    change_id: "chg-dv",
    actor_id: "fixture",
    role: "designer",
    source: { kind: "user", ref: "夹具用户 2026-10-09" },
    problem: `夹具需求 ${rid}`,
    users: [],
    success_scenarios: [],
    exclusions: [],
    priority: "P1",
    status,
  });
};

/** 作者自检（`author_self`）：绑定给定代码修订，带证据哈希与方法 */
const recordSelfCheck = (
  projectId: string,
  taskId: string,
  checkId: string,
  result: "pass" | "fail",
  key: string,
  codeRevision: string = CODE_REV,
): void => {
  service.submit({
    schema_version: 2,
    project_id: projectId,
    change_id: "chg-dv",
    actor_id: "fixture-author",
    role: "executor",
    entity_id: `check:${key}`,
    type: "audit.self_check_recorded",
    expected_revision: null,
    idempotency_key: `audit.self_check_recorded:${key}`,
    payload: {
      task_id: taskId,
      round: 1,
      checked_by: "fixture-author",
      conclusion: result === "pass" ? "pass" : "fail",
      binding: { revision_kind: "code", revision: codeRevision },
      record_method: "夹具自检（跑定向命令后按输出判）",
      checks: [
        {
          check_id: checkId,
          method: "夹具定向检查",
          command: null,
          exit_code: null,
          output_ref: null,
          evidence_sha256: sha256(`evidence:${key}`),
          scope: [],
          verifies: "code",
        },
      ],
    },
  });
};

/** 非作者独立审计（`independent`）：可声明与作者同会话以触发降级 */
const recordIndependent = (
  projectId: string,
  taskId: string,
  checkId: string,
  result: "pass" | "fail",
  key: string,
  opts: { sameSession?: boolean; codeRevision?: string; evidence?: string } = {},
): void => {
  service.submit({
    schema_version: 2,
    project_id: projectId,
    change_id: "chg-dv",
    actor_id: "fixture-auditor",
    role: "auditor",
    entity_id: `audit:${key}`,
    type: "audit.independent_audit_recorded",
    expected_revision: null,
    idempotency_key: `audit.independent_audit_recorded:${key}`,
    payload: {
      task_id: taskId,
      round: 1,
      auditor: "fixture-auditor",
      author_id: "fixture-author",
      independence: {
        different_actor: true,
        same_session_as_author: opts.sameSession === true,
        read_author_summary_first: false,
        model_note: null,
      },
      checks: [
        {
          check_id: checkId,
          result: result === "pass" ? "passed" : "failed",
          evidence_sha256: opts.evidence ?? sha256(`ind:${key}`),
          scope: [],
        },
      ],
      coverage: [
        { area: "behavior_boundaries", status: "checked", basis: "夹具逐条核（本次实测）" },
        { area: "data_concurrency", status: "not_applicable", basis: "夹具无并发面" },
        { area: "interface_integration", status: "checked", basis: "夹具核了读口链路" },
        { area: "failure_recovery", status: "unchecked", basis: "夹具未做恢复演练" },
        { area: "trust_permission", status: "not_applicable", basis: "夹具无权限面" },
      ],
      findings: [],
      conclusion: result === "pass" ? "pass" : "fail",
      not_reported_scope: [],
      method_limits: ["夹具复跑"],
      binding: { revision_kind: "code", revision: opts.codeRevision ?? CODE_REV },
    },
  });
};

/** 记录一条缺陷（默认 must_block 的 severity）；`opts.repro` 给复现证据 ⇒ 已证实（confirmed、未证实=false），
 *  不给 ⇒ pending_repro + 未证实（风险未排除）——用于验证 D1 全局阻断口径。 */
type FindingSeverityArg =
  | "blocks_core_goal"
  | "data_loss"
  | "unauthorized_access"
  | "user_visible_defect"
  | "degraded_experience"
  | "cosmetic";
const recordFinding = (
  projectId: string,
  objectId: string,
  key: string,
  severity: FindingSeverityArg = "blocks_core_goal",
  opts: { repro?: string | null; duplicate_of?: string | null } = {},
): void => {
  const repro = opts.repro ?? null;
  service.submit({
    schema_version: 2,
    project_id: projectId,
    change_id: "chg-dv",
    actor_id: "fixture-auditor",
    role: "auditor",
    entity_id: `finding:${key}`,
    type: "finding.opened",
    expected_revision: null,
    idempotency_key: `finding.opened:${key}`,
    payload: {
      severity,
      source: "夹具",
      expected: "无缺陷",
      actual: "发现缺陷",
      object_id: objectId,
      repro,
      evidence_sha256: repro === null ? null : sha256(`repro:${key}`),
      duplicate_of: opts.duplicate_of ?? null,
      dedupe_key: `dk-${key}`,
    },
  });
};

const DECL_HEAD = [
  "| 功能 ID | 人话功能名 | 需求 ID | 设计章节 | 本期范围（scope_id） | 覆盖结论 | 依据/缺口（review） | 使用结果与场景 |",
  "| --- | --- | --- | --- | --- | --- | --- | --- |",
];

/** 用真实证据文件建一个夹具项目：写 plan/design、登记需求、导入定义、激活基线 */
function makeProject(args: {
  id: string;
  plan: string;
  design: (hash: (anchor: string) => string) => string;
  requirements: string[];
  /** 额外登记为 `status=unconfirmed` 的需求（已登记待确认候选夹具用） */
  candidates?: string[];
  baseline: boolean;
}): void {
  const root = path.join(tmpBase, args.id);
  fs.mkdirSync(path.join(root, ".工作台"), { recursive: true });
  addProject({ id: args.id, name: args.id, path: root, kind: "backend" }, dataDir);
  for (const rid of args.requirements) registerRequirementFor(args.id, rid);
  for (const rid of args.candidates ?? []) registerRequirementFor(args.id, rid, "unconfirmed");
  // 章节在声明区之前 ⇒ 其 body 不随声明区占位符变化（先算 hash 再回填，无循环）
  const withPlaceholder = args.design(() => "SECTION_SHA_PLACEHOLDER");
  const secs = sectionsOf(withPlaceholder);
  const hash = (anchor: string): string => {
    const s = secs.find((x) => x.title.startsWith(anchor + " ") || x.title === anchor);
    if (s === undefined) throw new Error(`夹具章节 ${anchor} 未定位到`);
    return s.sha256;
  };
  const finalDesign = args.design(hash);
  // 再核一次：回填后各引用章节的现值必须与写进去的 hash 一致（防循环自证）
  const secs2 = sectionsOf(finalDesign);
  for (const s of secs2) {
    const anchor = s.title.split(" ")[0];
    if (!/^\d+(?:\.\d+)*$/.test(anchor)) continue;
    if (hash(anchor) !== s.sha256) {
      throw new Error(`夹具章节 ${s.title} 回填后 hash 变化（声明区落在了被引用章节内）`);
    }
  }
  write(path.join(root, ".工作台", "plan.md"), args.plan);
  write(path.join(root, ".工作台", "design.md"), finalDesign);
  submitDefinitionImports(service, {
    project_id: args.id,
    change_id: "chg-dv",
    actor_id: "fixture",
    role: "coordinator",
    definitions: importTaskDefinitions(args.plan, { plan_revision: sha256(args.plan) }).definitions,
  });
  if (args.baseline) {
    activateBaseline(args.id, { approved_by: "user", approval_basis: "夹具审定", approval_kind: "user_confirmed" }, dataDir);
  }
}

const readLedger = (
  id: string,
  params: FeatureLedgerParams = {},
  codeRevision: string | null = CODE_REV,
): FeatureLedgerResult => readFeatureLedger(id, dataDir, params, { project_exists: () => true, code_revision: codeRevision });
const ledgerOf = (r: FeatureLedgerResult): FeatureLedger | null => (r.ok ? r.ledger : null);
const itemOf = (L: FeatureLedger | null, id: string) => L?.items.find((i) => i.item_id === id);
const gateOf = (L: FeatureLedger | null, id: string) => L?.delivery?.gates.find((g) => g.id === id);
const blockerKinds = (L: FeatureLedger | null): string[] => (L?.delivery?.blockers ?? []).map((b) => b.kind);

// ═══════════════════ ① 声明解析（单元级：真实函数，负例优先） ═══════════════════
section("① PLAN「交付核对声明」解析：缺表/缺列/缺行/重复/空/非法核对项");
{
  const p = parseDeliveryGateDeclaration("# 空\n\n没有声明表。\n");
  ok(!p.found && p.rows.length === 0, "①a 没有声明表 ⇒ found=false（不猜三行）", p);
  const missingCol = parseDeliveryGateDeclaration(
    ["## 交付核对声明", "", "| 核对项 | 承接卡 |", "| --- | --- |", "| coverage | V09-62 |", ""].join("\n"),
  );
  ok(!missingCol.found, "①b 表头缺「检查 ID」列 ⇒ 不吸收（不靠相似）", missingCol);
  const full = parseDeliveryGateDeclaration(
    [
      "## 交付核对声明",
      "",
      "| 核对项 | 承接卡 | 检查 ID |",
      "| --- | --- | --- |",
      "| coverage | V09-62 | chk-a、chk-b |",
      "| review | V09-62 | chk-c |",
      "| runtime | V09-62 | chk-d |",
      "",
    ].join("\n"),
  );
  ok(
    full.found && full.rows.length === 3 && full.rows[0].check_ids.join(",") === "chk-a,chk-b",
    "①c 三行齐全 + 多检查 ID 逐条切分",
    full,
  );
  const dup = parseDeliveryGateDeclaration(
    [
      "## 交付核对声明",
      "",
      "| 核对项 | 承接卡 | 检查 ID |",
      "| --- | --- | --- |",
      "| coverage | V09-62 | chk-a |",
      "| coverage | V09-62 | chk-b |",
      "",
    ].join("\n"),
  );
  ok(dup.rows.filter((r) => r.gate === "coverage").length === 2, "①d 重复行被如实解析出来（判定层再 fail-closed）", dup);
  const emptyId = parseDeliveryGateDeclaration(
    [
      "## 交付核对声明",
      "",
      "| 核对项 | 承接卡 | 检查 ID |",
      "| --- | --- | --- |",
      "| coverage | V09-62 |  |",
      "| bogus | V09-62 | chk-x |",
      "",
    ].join("\n"),
  );
  ok(
    emptyId.issues.some((m) => m.includes("空集")) && emptyId.issues.some((m) => m.includes("不是")),
    "①e 空检查 ID 与非法核对项都进 issues（不静默）",
    emptyId,
  );
}

// ═══════════════════ ② 无声明 ⇒ 交付条件尚未核对（fail-closed） ═══════════════════
section("② 无「交付核对声明」与「集成检查要求」⇒ unknown、不假就绪");

const PLAN_NO_DECL = [
  "# 施工图",
  "",
  "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |",
  "| --- | --- | --- | --- | --- |",
  "| V-1 | todo | 交付总览 |  | 证据齐 |",
  "",
  "### V-1 交付总览",
  "",
  "**设计依据**：§3.16。**依赖**：无。**文件责任**：`src/d.ts`。",
  "",
  "- [ ] **chk-v-1-01 达标**",
  "",
  "| 功能 ID | 人话功能名 | 承接卡 | 必需检查 | 集成检查 | 结果状态 |",
  "| --- | --- | --- | --- | --- | --- |",
  "| cap-dv | 交付总览 | V-1 | chk-v-1-01 | int-dv-01 | 未验 |",
  "",
].join("\n");
const DESIGN_DV = (h: (a: string) => string): string =>
  [
    "# 设计书",
    "",
    "### 3.16 交付总览",
    "",
    "正文。",
    "",
    "## 功能清单声明（夹具）",
    "",
    DECL_HEAD[0],
    DECL_HEAD[1],
    `| cap-dv | 交付总览 | req-dv | §3.16 | cap-dv | 已核对 | reviewer=审1; ref=.工作台/design.md#3.16; section_sha256=${h("3.16")}; gap= | 场景 |`,
    "",
  ].join("\n");

makeProject({ id: "dv-nodecl", plan: PLAN_NO_DECL, design: DESIGN_DV, requirements: ["req-dv"], baseline: true });
// 让功能本可绿：自检 + 集成检查也过（证明"检查都过"仍不能假就绪）
recordSelfCheck("dv-nodecl", "V-1", "chk-v-1-01", "pass", "nodecl-01");
recordSelfCheck("dv-nodecl", "cap-dv", "int-dv-01", "pass", "nodecl-int");
{
  const L = ledgerOf(readLedger("dv-nodecl"));
  ok(L !== null, "②a 读口返回 ok");
  const d = L?.delivery;
  ok(d !== undefined, "②b 逐响应带 delivery（同源只读）");
  ok(d?.state === "unknown", "②c 无声明 ⇒ 交付条件尚未核对（unknown，不假 ready）", d?.state);
  ok(d?.gates.every((g) => g.state === "unknown") === true, "②d 三类核对均 unknown（无声明）", d?.gates.map((g) => [g.id, g.state]));
  ok(blockerKinds(L).includes("integration_check"), "②e project:delivery 集成检查缺声明也进 blocker", d?.blockers);
  ok(d?.counts.features === 1 && d?.counts.requirements === 1, "②f 计数仍是全范围（feature/需求）", d?.counts);
}

// ═══════════════════ ③ 三类缺 1（分别缺 coverage/review/runtime）⇒ 对应 gate unknown ═══════════════════
section("③ 交付核对声明缺 1 行 ⇒ 该门 unknown，其余照评");

const PLAN_WITH_DECL = (gateRows: string[], integrationRows: string[]): string =>
  [
    "# 施工图",
    "",
    "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |",
    "| --- | --- | --- | --- | --- |",
    "| V-1 | todo | 交付总览 |  | 证据齐 |",
    "",
    "### V-1 交付总览",
    "",
    "**设计依据**：§3.16。**依赖**：无。**文件责任**：`src/d.ts`。",
    "",
    "- [ ] **chk-v-1-01 完整功能范围核查**",
    "- [ ] **chk-v-1-02 交付总览实现达标**",
    "- [ ] **chk-v-1-03 非作者审查与问题收口**",
    "- [ ] **chk-v-1-04 运行交付版本核对**",
    "",
    "| 功能 ID | 人话功能名 | 承接卡 | 必需检查 | 集成检查 | 结果状态 |",
    "| --- | --- | --- | --- | --- | --- |",
    "| cap-dv | 交付总览 | V-1 | chk-v-1-02 | int-dv-01 | 未验 |",
    "",
    "## 交付核对声明",
    "",
    "| 核对项 | 承接卡 | 检查 ID |",
    "| --- | --- | --- |",
    ...gateRows,
    "",
    ...(integrationRows.length === 0
      ? []
      : ["## 集成检查要求", "", "| 对象 ID | 检查 ID | 说明 | 必需性 |", "| --- | --- | --- | --- |", ...integrationRows, ""]),
  ].join("\n");

const GATE_ROWS_ALL = ["| coverage | V-1 | chk-v-1-01 |", "| review | V-1 | chk-v-1-03 |", "| runtime | V-1 | chk-v-1-04 |"];
const INT_ROWS = ["| cap-dv | int-dv-01 | 集成 | 必需 |", "| project:delivery | int-project-delivery-01 | 交付集成 | 必需 |"];

for (const [tag, rows, missingId] of [
  ["coverage", GATE_ROWS_ALL.slice(1), "coverage"],
  ["review", [GATE_ROWS_ALL[0], GATE_ROWS_ALL[2]], "review"],
  ["runtime", GATE_ROWS_ALL.slice(0, 2), "runtime"],
] as const) {
  makeProject({
    id: `dv-miss-${tag}`,
    plan: PLAN_WITH_DECL([...rows], INT_ROWS),
    design: DESIGN_DV,
    requirements: ["req-dv"],
    baseline: true,
  });
  const L = ledgerOf(readLedger(`dv-miss-${tag}`));
  const g = gateOf(L, missingId);
  ok(g?.state === "unknown", `③ 缺 ${missingId} 行 ⇒ 该门 unknown`, g);
  ok(
    L?.delivery?.blockers.some((b) => b.kind === `gate_${missingId}`) === true,
    `③ 缺 ${missingId} 行的原因进 blocker`,
    L?.delivery?.blockers,
  );
}

// ═══════════════════ ④ 重复 / 悬空 / 空 ⇒ fail-closed unknown ═══════════════════
section("④ 重复行 / 悬空检查 ID / 空检查 ID ⇒ 该门 unknown（不猜）");
{
  const dupPlan = PLAN_WITH_DECL([...GATE_ROWS_ALL, "| coverage | V-1 | chk-v-1-02 |"], INT_ROWS);
  makeProject({ id: "dv-dup", plan: dupPlan, design: DESIGN_DV, requirements: ["req-dv"], baseline: true });
  const Ld = ledgerOf(readLedger("dv-dup"));
  ok(gateOf(Ld, "coverage")?.state === "unknown", "④a 重复 coverage 行 ⇒ unknown", gateOf(Ld, "coverage"));

  const dangPlan = PLAN_WITH_DECL(["| coverage | V-1 | chk-does-not-exist |", ...GATE_ROWS_ALL.slice(1)], INT_ROWS);
  makeProject({ id: "dv-dangling", plan: dangPlan, design: DESIGN_DV, requirements: ["req-dv"], baseline: true });
  const Lg = ledgerOf(readLedger("dv-dangling"));
  const cg = gateOf(Lg, "coverage");
  ok(cg?.state === "unknown", "④b 悬空检查 ID（定义里没有）⇒ unknown（不当作待验证）", cg);
  ok(cg?.missing.some((m) => m.includes("悬空")) === true, "④b′ 悬空原因逐条点名", cg?.missing);

  const emptyPlan = PLAN_WITH_DECL(["| coverage | V-1 |  |", ...GATE_ROWS_ALL.slice(1)], INT_ROWS);
  makeProject({ id: "dv-empty", plan: emptyPlan, design: DESIGN_DV, requirements: ["req-dv"], baseline: true });
  const Le = ledgerOf(readLedger("dv-empty"));
  ok(gateOf(Le, "coverage")?.state === "unknown", "④c 空检查 ID ⇒ unknown", gateOf(Le, "coverage"));
}

// ═══════════════════ ⑤ 未批准（无生效基线）⇒ 不据此判绿 ═══════════════════
section("⑤ 未获有效基线批准 ⇒ 三类核对与集成检查都不据此判绿（unknown）");
{
  makeProject({
    id: "dv-unapproved",
    plan: PLAN_WITH_DECL(GATE_ROWS_ALL, INT_ROWS),
    design: DESIGN_DV,
    requirements: ["req-dv"],
    baseline: false,
  });
  // 证据照给（作者自检），证明"有记录"也不因未批准而判绿
  recordSelfCheck("dv-unapproved", "V-1", "chk-v-1-01", "pass", "unapp-01");
  const L = ledgerOf(readLedger("dv-unapproved"));
  ok(L?.delivery?.state === "unknown", "⑤a 无生效基线 ⇒ delivery unknown", L?.delivery?.state);
  ok(L?.delivery?.gates.every((g) => g.state === "unknown") === true, "⑤b 未批准 ⇒ 三类核对 unknown", L?.delivery?.gates);
  ok(blockerKinds(L).includes("version"), "⑤c 未批准/漂移进 version blocker", L?.delivery?.blockers);
}

// ═══════════════════ ⑥ 独立 vs 作者自检 vs 同会话降级 ═══════════════════
section("⑥ agent_review 只认 canonical「有效 ∧ 独立」；作者自检/同会话降级不充作独立审查");
{
  makeProject({
    id: "dv-review",
    plan: PLAN_WITH_DECL(["| review | V-1 | chk-v-1-02 |"], INT_ROWS),
    design: DESIGN_DV,
    requirements: ["req-dv"],
    baseline: true,
  });
  // 作者自检通过
  recordSelfCheck("dv-review", "V-1", "chk-v-1-02", "pass", "rev-self");
  // 集成检查先给独立通过（本组只考察 chk-v-1-02 的独立性）
  recordIndependent("dv-review", "cap-dv", "int-dv-01", "pass", "rev-int");
  {
    const L = ledgerOf(readLedger("dv-review"));
    const it = itemOf(L, "cap-dv");
    ok(it?.agent_review?.state === "pending", "⑥a 只有作者自检 ⇒ agent_review pending", it?.agent_review);
    ok(
      it?.agent_review?.missing.some((m) => m.includes("作者自检")) === true,
      "⑥a′ 作者自检不充当独立证据（逐条点名）",
      it?.agent_review?.missing,
    );
    ok(gateOf(L, "review")?.state === "pending", "⑥a″ review 门 pending（有记录但作者自检）", gateOf(L, "review"));
  }
  // 同会话"独立"记录 ⇒ canonical 降级为 author_self
  recordIndependent("dv-review", "V-1", "chk-v-1-02", "pass", "rev-same", { sameSession: true });
  {
    const L = ledgerOf(readLedger("dv-review"));
    ok(itemOf(L, "cap-dv")?.agent_review?.state === "pending", "⑥b 同会话独立记录被降级 ⇒ 仍 pending", itemOf(L, "cap-dv")?.agent_review);
    ok(gateOf(L, "review")?.state === "pending", "⑥b′ review 门仍 pending", gateOf(L, "review"));
  }
  // 真正的非作者独立记录 ⇒ passed
  recordIndependent("dv-review", "V-1", "chk-v-1-02", "pass", "rev-indep");
  {
    const L = ledgerOf(readLedger("dv-review"));
    const it = itemOf(L, "cap-dv");
    ok(it?.agent_review?.state === "passed", "⑥c 有效独立通过 ⇒ agent_review passed", it?.agent_review);
    ok(
      it?.agent_review?.passed_count === 2 &&
        it?.agent_review?.evidence.some(
          (e) => e.check_id === "chk-v-1-02" && e.reviewer === "fixture-auditor" && e.at !== "" && e.evidence_ref !== "" && e.record_ref !== null,
        ) === true,
      "⑥c′ passed_count 计独立项 + 证据带 reviewer/time/ref",
      it?.agent_review?.evidence,
    );
    ok(gateOf(L, "review")?.state === "passed", "⑥d 有效独立 ⇒ review 门 passed", gateOf(L, "review"));
  }
}

// ═══════════════════ ⑦ 过期：同一事件、当前代码修订变化 ⇒ 撤回结论（现读有效性） ═══════════════════
section("⑦ 证据过期（当前源修订变化，无新事件）⇒ 撤回就绪，不借旧结论");
{
  makeProject({
    id: "dv-stale",
    plan: PLAN_WITH_DECL(GATE_ROWS_ALL, INT_ROWS),
    design: DESIGN_DV,
    requirements: ["req-dv"],
    baseline: true,
  });
  for (const c of ["chk-v-1-01", "chk-v-1-02", "chk-v-1-03", "chk-v-1-04"]) {
    recordIndependent("dv-stale", "V-1", c, "pass", `stale-${c}`);
  }
  recordIndependent("dv-stale", "cap-dv", "int-dv-01", "pass", "stale-int");
  recordIndependent("dv-stale", "project:delivery", "int-project-delivery-01", "pass", "stale-delivery");
  const fresh = ledgerOf(readLedger("dv-stale", {}, CODE_REV));
  ok(fresh?.delivery?.state === "ready_for_trial", "⑦a 前置：全条件满足 + 无人工接受 ⇒ ready_for_trial", fresh?.delivery?.state);
  const stale = ledgerOf(readLedger("dv-stale", {}, CODE_REV_OLD));
  ok(stale?.delivery?.state === "not_ready", "⑦b 换成另一当前代码修订（证据转 stale）⇒ not_ready（不借旧结论）", stale?.delivery?.state);
  ok(
    (stale?.delivery?.counts.verified ?? 1) === 0 && (stale?.delivery?.counts.reviewed ?? 1) === 0,
    "⑦c 过期后验证/审查计数归零",
    stale?.delivery?.counts,
  );
  ok(
    (fresh?.package_revision ?? "") !== "" && fresh?.package_revision === stale?.package_revision,
    "⑦d 同一事件快照 ⇒ 包版本不变（本次差异只来自现读 code 修订；生产默认 code=null）",
    { fresh: fresh?.package_revision, stale: stale?.package_revision },
  );
}

// ═══════════════════ ⑧ 未映射需求 / 待审设计 / 开放阻断缺陷 ⇒ not_ready 且逐条点名 ═══════════════════
section("⑧ 未映射需求 / 设计待审 / 开放阻断缺陷 ⇒ not_ready + blocker 点名");
{
  // 8a 未映射需求
  const PLAN_EXTRA_REQ = PLAN_WITH_DECL(GATE_ROWS_ALL, INT_ROWS);
  makeProject({ id: "dv-unmapped", plan: PLAN_EXTRA_REQ, design: DESIGN_DV, requirements: ["req-dv", "req-loose"], baseline: true });
  for (const c of ["chk-v-1-01", "chk-v-1-02", "chk-v-1-03", "chk-v-1-04"]) recordIndependent("dv-unmapped", "V-1", c, "pass", `um-${c}`);
  recordIndependent("dv-unmapped", "cap-dv", "int-dv-01", "pass", "um-int");
  recordIndependent("dv-unmapped", "project:delivery", "int-project-delivery-01", "pass", "um-delivery");
  const Lum = ledgerOf(readLedger("dv-unmapped"));
  ok(Lum?.delivery?.state === "not_ready", "⑧a 有未映射需求 ⇒ not_ready（登记需求非全有去向）", Lum?.delivery?.state);
  ok(
    Lum?.delivery?.blockers.some((b) => b.kind === "unmapped_requirement" && b.item_id === "pending:req-loose") === true,
    "⑧a′ 未映射需求逐条点名（pending:<requirement_id>）",
    Lum?.delivery?.blockers,
  );
  ok(Lum?.delivery?.counts.pending_requirements === 1 && Lum?.delivery?.counts.mapped_requirements === 1, "⑧a″ 计数分开（已映射/待映射）", Lum?.delivery?.counts);
  ok(Lum?.coverage.source_complete === true, "⑧a‴ 来源仍读齐（未映射不等于来源缺失）");

  // 8b 设计待审（覆盖结论声明「已核对」但 reviewer 为空）
  const DESIGN_PENDING = (h: (a: string) => string): string =>
    [
      "# 设计书",
      "",
      "### 3.16 交付总览",
      "",
      "正文。",
      "",
      "## 功能清单声明（夹具）",
      "",
      DECL_HEAD[0],
      DECL_HEAD[1],
      `| cap-dv | 交付总览 | req-dv | §3.16 | cap-dv | 已核对 | reviewer=; ref=.工作台/design.md#3.16; section_sha256=${h("3.16")}; gap=x | 场景 |`,
      "",
    ].join("\n");
  makeProject({ id: "dv-pending", plan: PLAN_WITH_DECL(GATE_ROWS_ALL, INT_ROWS), design: DESIGN_PENDING, requirements: ["req-dv"], baseline: true });
  for (const c of ["chk-v-1-01", "chk-v-1-02", "chk-v-1-03", "chk-v-1-04"]) recordIndependent("dv-pending", "V-1", c, "pass", `pd-${c}`);
  recordIndependent("dv-pending", "cap-dv", "int-dv-01", "pass", "pd-int");
  recordIndependent("dv-pending", "project:delivery", "int-project-delivery-01", "pass", "pd-delivery");
  const Lp = ledgerOf(readLedger("dv-pending"));
  ok(Lp?.delivery?.state === "not_ready", "⑧b 设计未审 ⇒ not_ready", Lp?.delivery?.state);
  ok(
    Lp?.delivery?.blockers.some((b) => b.kind === "design_coverage" && b.item_id === "cap-dv") === true,
    "⑧b′ 设计未审逐项点名",
    Lp?.delivery?.blockers,
  );

  // 8c 开放阻断缺陷
  makeProject({ id: "dv-finding", plan: PLAN_WITH_DECL(GATE_ROWS_ALL, INT_ROWS), design: DESIGN_DV, requirements: ["req-dv"], baseline: true });
  for (const c of ["chk-v-1-01", "chk-v-1-02", "chk-v-1-03", "chk-v-1-04"]) recordIndependent("dv-finding", "V-1", c, "pass", `fd-${c}`);
  recordIndependent("dv-finding", "cap-dv", "int-dv-01", "pass", "fd-int");
  recordIndependent("dv-finding", "project:delivery", "int-project-delivery-01", "pass", "fd-delivery");
  recordFinding("dv-finding", "V-1", "f-blocker", "blocks_core_goal");
  const Lf = ledgerOf(readLedger("dv-finding"));
  ok(Lf?.delivery?.state === "not_ready", "⑧c 有开放阻断缺陷 ⇒ not_ready", Lf?.delivery?.state);
  ok(
    Lf?.delivery?.blockers.some((b) => b.kind === "blocking_finding" && (b.message ?? "").includes("f-blocker")) === true,
    "⑧c′ 阻断缺陷逐条点名",
    Lf?.delivery?.blockers,
  );
  ok(itemOf(Lf, "cap-dv")?.agent_review?.state !== "passed", "⑧c″ 有开放缺陷 ⇒ 该功能非作者审查不 passed", itemOf(Lf, "cap-dv")?.agent_review);
}

// ═══════════════════ ⑧′ 已登记待确认候选：unconfirmed 未映射单列不阻断；explicit/inferred 仍阻断；已正式映射不降级 ═══════════════════
section("⑧′ 已登记待确认候选（unconfirmed 未映射）：单列不阻断 / 分母守恒 / explicit 仍阻断 / 已正式映射不降级");

/** 改需求登记状态（负例：候选→明确 必须立刻回到正式待映射并阻断）——改状态要先读当前版本，故带读侧闭包 */
const flipRequirementStatus = (projectId: string, rid: string, status: "explicit" | "inferred" | "unconfirmed"): void => {
  setRequirementStatus(
    {
      submit: (c: unknown) => service.submit(c),
      workbenchDir: projectWorkbenchDir(projectId, dataDir),
      read: () => ({ requirements: readRequirements(projectWorkDir(projectId, dataDir)).requirements }),
    } as never,
    {
      project_id: projectId,
      requirement_id: rid,
      change_id: "chg-dv",
      actor_id: "fixture",
      role: "designer",
      status,
      reason: "夹具改登记状态",
    },
  );
};

/** 把该夹具的所有核对都记成非作者独立通过（证明候选以外的条件确实满足） */
const recordAllIndependent = (pid: string, extKey: string): void => {
  for (const c of ["chk-v-1-01", "chk-v-1-02", "chk-v-1-03", "chk-v-1-04"]) recordIndependent(pid, "V-1", c, "pass", `${extKey}-${c}`);
  recordIndependent(pid, "cap-dv", "int-dv-01", "pass", `${extKey}-int`);
  recordIndependent(pid, "project:delivery", "int-project-delivery-01", "pass", `${extKey}-delivery`);
};

{
  // A) 未映射 ∧ unconfirmed ⇒ 已登记待确认候选：单列、有来源、不阻断；其余全绿 ⇒ 仍可试用
  makeProject({ id: "dv-cand", plan: PLAN_WITH_DECL(GATE_ROWS_ALL, INT_ROWS), design: DESIGN_DV, requirements: ["req-dv"], candidates: ["req-r13"], baseline: true });
  recordAllIndependent("dv-cand", "cand");
  const L = ledgerOf(readLedger("dv-cand"));
  const d = L?.delivery;
  ok(d?.state === "ready_for_trial", "⑧′a 未映射 unconfirmed 候选不阻断 ⇒ 其余全绿时仍 ready_for_trial", d);
  ok(!blockerKinds(L).includes("unmapped_requirement") && (d?.blockers.length ?? -1) === 0, "⑧′a′ 候选不进 unmapped_requirement 阻断", d?.blockers);
  ok(
    d?.counts.features === 1 && d?.counts.requirements === 2 && d?.counts.mapped_requirements === 1 && d?.counts.pending_requirements === 0,
    "⑧′b 正式功能/已映射/正式待映射计数分开（待映射不含候选）",
    d?.counts,
  );
  ok(d?.counts.registered_candidates === 1 && d?.counts.formal_requirements === 1, "⑧′b′ 显式给出正式分母 1 与已登记待确认候选 1", d?.counts);
  const dc = d?.counts;
  ok(
    dc !== undefined && dc.mapped_requirements + dc.pending_requirements + (dc.registered_candidates ?? 0) === dc.requirements,
    "⑧′b″ 分母守恒：mapped + pending + registered_candidates = requirements",
    d?.counts,
  );
  ok(
    dc !== undefined && dc.formal_requirements === dc.mapped_requirements + dc.pending_requirements,
    "⑧′b‴ 正式分母 = mapped + pending（不含候选）",
    d?.counts,
  );
  const cand = itemOf(L, "pending:req-r13");
  ok(cand?.provenance.extraction === "registered_candidate", "⑧′c 派生成「已登记待确认候选」类别", cand?.provenance);
  ok(
    cand?.requirement_refs[0]?.requirement_id === "req-r13" && cand?.requirement_refs[0]?.certainty === "待确认" && (cand?.requirement_refs[0]?.source_ref ?? "") !== "",
    "⑧′c′ 保留 requirement_id / 来源 / certainty=待确认",
    cand?.requirement_refs,
  );
  ok((cand?.display_name ?? "").includes("已登记待确认") && !(cand?.display_name ?? "").includes("未登记"), "⑧′c″ 名称标明「已登记待确认」，不写「未登记」", cand?.display_name);
  ok(
    cand?.provenance.extraction !== "unregistered_candidate" && (cand?.provenance.unmapped ?? []).length === 0,
    "⑧′c‴ 不混为未登记候选、不带正式未映射标记",
    cand?.provenance,
  );
  ok(
    L?.coverage.registered_candidate_count === 1 && L?.coverage.pending_count === 0 && L?.coverage.formal_requirement_count === 1 && L?.coverage.source_complete === true,
    "⑧′d 覆盖摘要：registered_candidate_count=1 / pending=0 / formal=1 / 来源仍读齐",
    L?.coverage,
  );
  ok((d?.summary ?? "").includes("已登记待确认候选 1"), "⑧′e 摘要显式说明已登记待确认候选数", d?.summary);
  // 全范围摘要在分页之前算：limit=1 只回 1 项，但计数/结论不变
  const L1 = ledgerOf(readLedger("dv-cand", { limit: 1 }));
  ok(
    JSON.stringify(L1?.delivery?.counts) === JSON.stringify(d?.counts) && L1?.delivery?.state === d?.state,
    "⑧′f 分页不改变全范围计数与结论",
    { one: L1?.delivery?.counts, all: d?.counts },
  );
  // 局部 scope：有界信息，不宣布整项目就绪，但仍如实分账
  const Lp = ledgerOf(readLedger("dv-cand", { scope: "cap-dv" }));
  ok(
    Lp?.delivery?.scope === "partial" && Lp?.delivery?.state === "unknown" && Lp?.coverage.registered_candidate_count === 1,
    "⑧′g 局部读取 ⇒ partial/unknown，但覆盖分账仍如实（候选 1）",
    Lp?.delivery,
  );

  // B) 同一需求由 unconfirmed 改为 explicit ⇒ 立刻回到正式待映射并阻断（不得因曾为候选留白）
  makeProject({ id: "dv-cand-expl", plan: PLAN_WITH_DECL(GATE_ROWS_ALL, INT_ROWS), design: DESIGN_DV, requirements: ["req-dv"], candidates: ["req-r13"], baseline: true });
  recordAllIndependent("dv-cand-expl", "cex");
  const before = ledgerOf(readLedger("dv-cand-expl"));
  ok(before?.delivery?.state === "ready_for_trial", "⑧′h 改状态前：候选不阻断", before?.delivery?.state);
  flipRequirementStatus("dv-cand-expl", "req-r13", "explicit");
  const Lx = ledgerOf(readLedger("dv-cand-expl"));
  ok(Lx?.delivery?.state === "not_ready", "⑧′h′ 改明确后：立即 not_ready（不因曾为候选留白）", Lx?.delivery?.state);
  ok(
    Lx?.delivery?.blockers.some((b) => b.kind === "unmapped_requirement" && b.item_id === "pending:req-r13") === true,
    "⑧′h″ 明确未映射需求逐条点名阻断",
    Lx?.delivery?.blockers,
  );
  ok(
    Lx?.delivery?.counts.pending_requirements === 1 && Lx?.delivery?.counts.registered_candidates === 0 && Lx?.coverage.registered_candidate_count === 0,
    "⑧′h‴ 分类翻转：候选 0、正式待映射 1",
    { counts: Lx?.delivery?.counts, coverage: Lx?.coverage },
  );
  ok(itemOf(Lx, "pending:req-r13")?.provenance.extraction === "mapped_requirement_pending", "⑧′h⁗ 类别翻回正式待映射", itemOf(Lx, "pending:req-r13")?.provenance);
  ok(itemOf(Lx, "pending:req-r13")?.requirement_refs[0]?.certainty === "明确", "⑧′h⁵ certainty 随登记状态变为明确");

  // C) unconfirmed 已被正式声明映射 ⇒ 仍是正式功能，**不降级**为候选
  const DESIGN_CAND_MAPPED = (h: (a: string) => string): string =>
    [
      "# 设计书",
      "",
      "### 3.16 交付总览",
      "",
      "正文。",
      "",
      "## 功能清单声明（夹具）",
      "",
      DECL_HEAD[0],
      DECL_HEAD[1],
      `| cap-dv | 交付总览 | req-dv | §3.16 | cap-dv | 已核对 | reviewer=审1; ref=.工作台/design.md#3.16; section_sha256=${h("3.16")}; gap= | 场景一 |`,
      `| cap-m | 已映射的待确认需求功能 | req-m | §3.16 | cap-m | 已核对 | reviewer=审2; ref=.工作台/design.md#3.16; section_sha256=${h("3.16")}; gap= | 场景二 |`,
      "",
    ].join("\n");
  const PLAN_CAND_MAPPED = PLAN_WITH_DECL(GATE_ROWS_ALL, INT_ROWS).replace(
    "| cap-dv | 交付总览 | V-1 | chk-v-1-02 | int-dv-01 | 未验 |",
    "| cap-dv | 交付总览 | V-1 | chk-v-1-02 | int-dv-01 | 未验 |\n| cap-m | 已映射的待确认需求功能 | V-1 | chk-v-1-01 | int-dv-01 | 未验 |",
  );
  makeProject({ id: "dv-cand-mapped", plan: PLAN_CAND_MAPPED, design: DESIGN_CAND_MAPPED, requirements: ["req-dv"], candidates: ["req-m"], baseline: true });
  recordAllIndependent("dv-cand-mapped", "cma");
  const Lm = ledgerOf(readLedger("dv-cand-mapped"));
  ok(
    Lm?.coverage.mapped_count === 2 && Lm?.coverage.pending_count === 0 && Lm?.coverage.registered_candidate_count === 0,
    "⑧′i 已正式映射的 unconfirmed 需求不降级为候选（mapped=2）",
    Lm?.coverage,
  );
  ok(itemOf(Lm, "pending:req-m") === undefined, "⑧′i′ 已映射需求不生成 pending:<requirement_id> 候选项");
  ok(itemOf(Lm, "cap-m")?.provenance.extraction === "declared", "⑧′i″ 已映射需求仍是正式声明功能");
}

// ═══════════════════ ⑨ 完全通过 + 人工 pending ⇒ 可进入试用；分页/局部/历史/漂移 ═══════════════════
section("⑨ 全条件满足但人工 pending ⇒ ready_for_trial；limit=1 摘要仍取全范围；局部/历史/漂移撤回");

const PLAN_FULL = [
  "# 施工图",
  "",
  "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |",
  "| --- | --- | --- | --- | --- |",
  "| V-1 | todo | 交付总览 |  | 证据齐 |",
  "| V-2 | todo | 第二功能 |  | 证据齐 |",
  "",
  "### V-1 交付总览",
  "",
  "**设计依据**：§3.16。**依赖**：无。**文件责任**：`src/d.ts`。",
  "",
  "- [ ] **chk-v-1-01 完整功能范围核查**",
  "- [ ] **chk-v-1-02 交付总览实现达标**",
  "- [ ] **chk-v-1-03 非作者审查与问题收口**",
  "- [ ] **chk-v-1-04 运行交付版本核对**",
  "",
  "### V-2 第二功能",
  "",
  "**设计依据**：§3.17。**依赖**：无。**文件责任**：`src/t.ts`。",
  "",
  "- [ ] **chk-v-2-01 第二功能达标**",
  "",
  "| 功能 ID | 人话功能名 | 承接卡 | 必需检查 | 集成检查 | 结果状态 |",
  "| --- | --- | --- | --- | --- | --- |",
  "| cap-dv | 交付总览 | V-1 | chk-v-1-02 | int-dv-01 | 未验 |",
  "| cap-second | 第二功能 | V-2 | chk-v-2-01 | int-second-01 | 未验 |",
  "",
  "## 交付核对声明",
  "",
  "| 核对项 | 承接卡 | 检查 ID |",
  "| --- | --- | --- |",
  ...GATE_ROWS_ALL,
  "",
  "## 集成检查要求",
  "",
  "| 对象 ID | 检查 ID | 说明 | 必需性 |",
  "| --- | --- | --- | --- |",
  "| cap-dv | int-dv-01 | 集成 | 必需 |",
  "| cap-second | int-second-01 | 集成 | 必需 |",
  "| project:delivery | int-project-delivery-01 | 交付集成 | 必需 |",
  "",
].join("\n");
const DESIGN_FULL = (h: (a: string) => string): string =>
  [
    "# 设计书",
    "",
    "### 3.16 交付总览",
    "",
    "正文一。",
    "",
    "### 3.17 第二功能",
    "",
    "正文二。",
    "",
    "## 功能清单声明（夹具）",
    "",
    DECL_HEAD[0],
    DECL_HEAD[1],
    `| cap-dv | 交付总览 | req-dv | §3.16 | cap-dv | 已核对 | reviewer=审1; ref=.工作台/design.md#3.16; section_sha256=${h("3.16")}; gap= | 场景一 |`,
    `| cap-second | 第二功能 | req-two | §3.17 | cap-second | 已核对 | reviewer=审2; ref=.工作台/design.md#3.17; section_sha256=${h("3.17")}; gap= | 场景二 |`,
    "",
  ].join("\n");
makeProject({ id: "dv-full", plan: PLAN_FULL, design: DESIGN_FULL, requirements: ["req-dv", "req-two"], baseline: true });
for (const c of ["chk-v-1-01", "chk-v-1-02", "chk-v-1-03", "chk-v-1-04"]) recordIndependent("dv-full", "V-1", c, "pass", `full-${c}`);
recordIndependent("dv-full", "cap-dv", "int-dv-01", "pass", "full-int");
recordIndependent("dv-full", "V-2", "chk-v-2-01", "pass", "full-2-01");
recordIndependent("dv-full", "cap-second", "int-second-01", "pass", "full-int-2");
recordIndependent("dv-full", "project:delivery", "int-project-delivery-01", "pass", "full-delivery");
{
  const L = ledgerOf(readLedger("dv-full"));
  const d = L?.delivery;
  ok(d?.state === "ready_for_trial", "⑨a 全条件满足 + 人工 pending ⇒ ready_for_trial", d);
  ok(d?.scope === "project", "⑨a′ 全范围读取 ⇒ scope=project", d?.scope);
  ok(
    d?.user_acceptance.pending === d?.counts.features && d?.user_acceptance.accepted === 0,
    "⑨b 人工接受单列且 pending（不代签）",
    d?.user_acceptance,
  );
  ok((d?.summary ?? "").includes("人工接受"), "⑨c 摘要人话说明人工接受仍待确认", d?.summary);
  ok(
    d?.gates.every((g) => g.state === "passed") === true && (d?.blockers.length ?? -1) === 0,
    "⑨d 三门 passed、无 blocker",
    { gates: d?.gates.map((g) => [g.id, g.state]), blockers: d?.blockers },
  );
  ok(itemOf(L, "cap-dv")?.agent_review?.state === "passed", "⑨e 逐项 agent_review passed", itemOf(L, "cap-dv")?.agent_review);
  ok(
    d?.gates.every((g) => g.evidence.length > 0 && g.evidence[0].reviewer !== "") === true,
    "⑨f 每门证据带 reviewer/time/ref 供人展开",
    d?.gates.map((g) => g.evidence),
  );

  // limit=1：分页只给 1 项，但摘要按全范围算 —— 仍 ready
  const L1 = ledgerOf(readLedger("dv-full", { limit: 1 }));
  ok(L1?.items.length === 1 && L1?.paging.complete === false, "⑨g limit=1 ⇒ 只回 1 项且分页未结束", { items: L1?.items.length, paging: L1?.paging });
  ok(L1?.delivery?.state === "ready_for_trial", "⑨g′ 首屏数量不改变全范围摘要结论（仍 ready）", L1?.delivery?.state);
  ok(
    JSON.stringify(L1?.delivery?.counts) === JSON.stringify(d?.counts),
    "⑨g″ 分页后 counts 与全范围一致",
    { one: L1?.delivery?.counts, all: d?.counts },
  );

  // 局部 scope：只读一个功能范围 ⇒ 有界信息，不宣布整项目就绪
  const Lp = ledgerOf(readLedger("dv-full", { scope: "cap-dv" }));
  ok(Lp?.delivery?.scope === "partial" && Lp?.delivery?.state === "unknown", "⑨h 局部 scope ⇒ partial + unknown（不冒充整项目）", Lp?.delivery);
  ok(blockerKinds(Lp).includes("scope_partial"), "⑨h′ 局部读取原因进 blocker", Lp?.delivery?.blockers);

  // 漂移：改现行设计但不重新激活 ⇒ current 读数撤回就绪
  const root = path.join(tmpBase, "dv-full");
  const designPath = path.join(root, ".工作台", "design.md");
  const before = fs.readFileSync(designPath, "utf8");
  fs.writeFileSync(designPath, before.replace("正文一。", "正文一（现行草稿已改）。"), "utf8");
  const Ldrift = ledgerOf(readLedger("dv-full", { document: "current" }));
  ok(Ldrift?.delivery?.state === "unknown", "⑨i 现行设计已漂移（未重激活）⇒ unknown，不假 ready", Ldrift?.delivery?.state);
  ok((Ldrift?.document_selection.drift ?? null) !== null, "⑨i′ 漂移如实回报", Ldrift?.document_selection);
  // 仍读 active 的快照：交付结论绑定已批准版本，不把现行草稿混进去
  const Lactive = ledgerOf(readLedger("dv-full"));
  ok(Lactive?.delivery?.scope === "project", "⑨i″ active 读仍是工程范围（不混现行草稿）");
  fs.writeFileSync(designPath, before, "utf8"); // 还原

  // 历史修订：不可变快照 ⇒ historical + unknown（有界信息）
  const designHash = sha256(before);
  const Lhist = ledgerOf(readLedger("dv-full", { document: designHash }));
  ok(Lhist !== null, "⑨j 历史修订可重建（基线成对图纸齐）", Lhist?.document_selection);
  ok(
    Lhist?.delivery?.scope === "historical" && Lhist?.delivery?.state === "unknown",
    "⑨j′ 历史修订 ⇒ historical + unknown（不宣布当前整项目可试用）",
    Lhist?.delivery,
  );
  ok(blockerKinds(Lhist).includes("scope_historical"), "⑨j″ 历史读取原因进 blocker", Lhist?.delivery?.blockers);

  // 无数据/无法重建（不可变快照缺失）⇒ not_derived 也带 unknown 交付读数（不冒充空项目就绪）
  const Lnd = ledgerOf(readLedger("dv-full", { document: "f".repeat(64) }));
  ok(Lnd?.state === "not_derived", "⑨k 请求不存在的修订 ⇒ not_derived", Lnd?.state);
  ok(
    Lnd?.delivery?.state === "unknown" && (Lnd?.delivery?.blockers[0]?.kind ?? "") === "not_derived",
    "⑨k′ not_derived 也带 unknown 交付读数 + 原因",
    Lnd?.delivery,
  );
}

// ═══════════════════ ⑩ MCP 同源（HTTP/MCP 共享同一底层函数） ═══════════════════
section("⑩ MCP feature_ledger 与直接调用同源（delivery / agent_review 逐字段一致）");
{
  // MCP 工具不传 code 修订（生产默认 code=null）⇒ 同口径比较
  const direct = ledgerOf(readLedger("dv-full", {}, null));
  const r = await featureLedgerTool.handler({ project_id: "dv-full" });
  const parsed = JSON.parse(r.content[0].text) as { ok: boolean; ledger?: FeatureLedger };
  ok(parsed.ok === true && parsed.ledger !== undefined, "⑩a MCP 返回 ok+ledger", parsed.ok);
  ok(
    JSON.stringify(parsed.ledger?.delivery) === JSON.stringify(direct?.delivery),
    "⑩b MCP delivery 与直接调用逐字段一致（同源只读）",
  );
  ok(
    JSON.stringify(parsed.ledger?.items.map((i) => i.agent_review)) ===
      JSON.stringify(direct?.items.map((i) => i.agent_review)),
    "⑩c MCP 逐项 agent_review 与直接调用一致",
  );
  ok(parsed.ledger?.package_revision === direct?.package_revision, "⑩d 包版本一致");
}

// ═══════════════════ ⑪ B1 声明解析：段定位/重复/未知行/围栏/稳定键 ⇒ fail-closed ═══════════════════
section("⑪ B1 交付声明解析：段定位/重复/未知行/围栏/稳定键 ⇒ fail-closed（同表头不能冒充）");
{
  const decoy = parseDeliveryGateDeclaration(
    [
      "## 别处的表（同表头，但不在声明段内）",
      "",
      "| 核对项 | 承接卡 | 检查 ID |",
      "| --- | --- | --- |",
      "| coverage | V-1 | chk-v-1-01 |",
      "| review | V-1 | chk-v-1-03 |",
      "| runtime | V-1 | chk-v-1-04 |",
      "",
    ].join("\n"),
  );
  ok(!decoy.found, "⑪a 同表头但不在「交付核对声明」段 ⇒ 不吸收（不靠相似冒充）", decoy);

  const fencedExample = parseDeliveryGateDeclaration(
    [
      "## 交付核对声明",
      "",
      "```md",
      "| 核对项 | 承接卡 | 检查 ID |",
      "| --- | --- | --- |",
      "| coverage | V-1 | chk-v-1-01 |",
      "```",
      "",
    ].join("\n"),
  );
  ok(
    !fencedExample.found && fencedExample.issues.some((m) => m.includes("没有可识别")),
    "⑪b 围栏内示例不算声明表（fail-closed）",
    fencedExample,
  );

  const dupSection = parseDeliveryGateDeclaration(
    [
      "## 交付核对声明",
      "",
      "| 核对项 | 承接卡 | 检查 ID |",
      "| --- | --- | --- |",
      "| coverage | V-1 | chk-v-1-01 |",
      "| review | V-1 | chk-v-1-03 |",
      "| runtime | V-1 | chk-v-1-04 |",
      "",
      "## 交付核对声明",
      "",
      "| 核对项 | 承接卡 | 检查 ID |",
      "| --- | --- | --- |",
      "| coverage | V-1 | chk-v-1-01 |",
      "",
    ].join("\n"),
  );
  ok(dupSection.issues.some((m) => m.includes("重复")), "⑪c 声明段重复 ⇒ issues 点名（不猜）", dupSection);

  const dupTable = parseDeliveryGateDeclaration(
    [
      "## 交付核对声明",
      "",
      "| 核对项 | 承接卡 | 检查 ID |",
      "| --- | --- | --- |",
      "| coverage | V-1 | chk-v-1-01 |",
      "",
      "| 核对项 | 承接卡 | 检查 ID |",
      "| --- | --- | --- |",
      "| review | V-1 | chk-v-1-03 |",
      "| runtime | V-1 | chk-v-1-04 |",
      "",
    ].join("\n"),
  );
  ok(dupTable.issues.some((m) => m.includes("重复")), "⑪d 段内两张同表头表 ⇒ issues 点名（首表不遮后表）", dupTable);

  const badRow = parseDeliveryGateDeclaration(
    [
      "## 交付核对声明",
      "",
      "| 核对项 | 承接卡 | 检查 ID |",
      "| --- | --- | --- |",
      "| coverage | V-1 | chk-v-1-01 |",
      "| review | V-1 | chk-v-1-03 |",
      "| runtime | V-1 | chk-v-1-04 |",
      "| nonsense | V-1 | chk-x |",
      "",
    ].join("\n"),
  );
  ok(badRow.found && badRow.issues.some((m) => m.includes("不是")), "⑪e 未知核对项行进 issues（不静默）", badRow);

  const badKey = parseDeliveryGateDeclaration(
    [
      "## 交付核对声明",
      "",
      "| 核对项 | 承接卡 | 检查 ID |",
      "| --- | --- | --- |",
      "| coverage | V-1 | 这不是稳定键 |",
      "| review | V-1 | chk-v-1-03 |",
      "| runtime | V-1 | chk-v-1-04 |",
      "",
    ].join("\n"),
  );
  ok(badKey.issues.some((m) => m.includes("稳定键")), "⑪f 检查 ID 不是稳定键 ⇒ issues 点名", badKey);
}

// ═══════════════════ ⑫ B1 判定层：结构问题 ⇒ 三类核对整段 unknown ═══════════════════
section("⑫ B1 判定层：完整三行 + 坏行 / 声明段重复 ⇒ 整段 fail-closed（不仍按三行通过）");
{
  // 12a 完整三行 + 一个未知核对项行（证据都齐，证明"检查都过"也不能盖过声明段结构问题）
  const PLAN_BADROW = PLAN_WITH_DECL([...GATE_ROWS_ALL, "| bogus | V-1 | chk-v-1-02 |"], INT_ROWS);
  makeProject({ id: "dv-b1-badrow", plan: PLAN_BADROW, design: DESIGN_DV, requirements: ["req-dv"], baseline: true });
  for (const c of ["chk-v-1-01", "chk-v-1-02", "chk-v-1-03", "chk-v-1-04"]) recordIndependent("dv-b1-badrow", "V-1", c, "pass", `b1br-${c}`);
  recordIndependent("dv-b1-badrow", "cap-dv", "int-dv-01", "pass", "b1br-int");
  recordIndependent("dv-b1-badrow", "project:delivery", "int-project-delivery-01", "pass", "b1br-del");
  {
    const L = ledgerOf(readLedger("dv-b1-badrow"));
    ok(
      L?.delivery?.gates.every((g) => g.state === "unknown") === true,
      "⑫a 完整三行 + 未知行 ⇒ 三类核对整段 unknown（坏行不被忽略）",
      L?.delivery?.gates.map((g) => [g.id, g.state]),
    );
  }

  // 12b 两个完整「交付核对声明」段 ⇒ 异常，不猜第一个
  const PLAN_DUPSECTION = PLAN_WITH_DECL(GATE_ROWS_ALL, INT_ROWS) + "\n## 交付核对声明\n\n| 核对项 | 承接卡 | 检查 ID |\n| --- | --- | --- |\n| coverage | V-1 | chk-v-1-01 |\n";
  makeProject({ id: "dv-b1-dupsection", plan: PLAN_DUPSECTION, design: DESIGN_DV, requirements: ["req-dv"], baseline: true });
  for (const c of ["chk-v-1-01", "chk-v-1-02", "chk-v-1-03", "chk-v-1-04"]) recordIndependent("dv-b1-dupsection", "V-1", c, "pass", `b1ds-${c}`);
  recordIndependent("dv-b1-dupsection", "cap-dv", "int-dv-01", "pass", "b1ds-int");
  recordIndependent("dv-b1-dupsection", "project:delivery", "int-project-delivery-01", "pass", "b1ds-del");
  {
    const L = ledgerOf(readLedger("dv-b1-dupsection"));
    ok(
      L?.delivery?.gates.every((g) => g.state === "unknown") === true,
      "⑫b 声明段重复 ⇒ 三类核对整段 unknown（不默认选旧/第一段）",
      L?.delivery?.gates.map((g) => [g.id, g.state]),
    );
  }
}

// ═══════════════════ ⑬ B2 交付集成：消费 canonical 完整判据（非空必需集成） ═══════════════════
section("⑬ B2 交付集成：消费 canonical 必需性 / 完整判据，不只循环 basis 另判 passed");
{
  const INT_OPTIONAL = [
    "| cap-dv | int-dv-01 | 集成 | 必需 |",
    "| project:delivery | int-project-delivery-01 | 交付集成 | 非必需 |",
  ];
  makeProject({ id: "dv-b2-optional", plan: PLAN_WITH_DECL(GATE_ROWS_ALL, INT_OPTIONAL), design: DESIGN_DV, requirements: ["req-dv"], baseline: true });
  for (const c of ["chk-v-1-01", "chk-v-1-02", "chk-v-1-03", "chk-v-1-04"]) recordIndependent("dv-b2-optional", "V-1", c, "pass", `b2o-${c}`);
  recordIndependent("dv-b2-optional", "cap-dv", "int-dv-01", "pass", "b2o-int");
  recordIndependent("dv-b2-optional", "project:delivery", "int-project-delivery-01", "pass", "b2o-del");
  const L = ledgerOf(readLedger("dv-b2-optional"));
  ok(L?.delivery?.integration !== undefined, "⑬a 交付读数附 integration 字段（成功/失败都可展开）", L?.delivery?.integration);
  ok(
    L?.delivery?.integration?.state === "unknown",
    "⑬b 没有「必需」集成检查 ⇒ 集成不得判通过（消费 canonical 必需性，不只凭有证据）",
    L?.delivery?.integration,
  );
  ok(L?.delivery?.state !== "ready_for_trial", "⑬c 集成条件未成立 ⇒ 不宣布可试用", L?.delivery?.state);
}

// ═══════════════════ ⑭ B3 用户接受风险的缺陷不算全局阻断（与 canonical 一致） ═══════════════════
section("⑭ B3 用户接受风险的缺陷不进全局阻断（不自造更宽的阻断口径）");
{
  makeProject({ id: "dv-b3-accepted", plan: PLAN_WITH_DECL(GATE_ROWS_ALL, INT_ROWS), design: DESIGN_DV, requirements: ["req-dv"], baseline: true });
  for (const c of ["chk-v-1-01", "chk-v-1-02", "chk-v-1-03", "chk-v-1-04"]) recordIndependent("dv-b3-accepted", "V-1", c, "pass", `b3a-${c}`);
  recordIndependent("dv-b3-accepted", "cap-dv", "int-dv-01", "pass", "b3a-int");
  recordIndependent("dv-b3-accepted", "project:delivery", "int-project-delivery-01", "pass", "b3a-del");
  recordFinding("dv-b3-accepted", "V-1", "f-risk", "blocks_core_goal");
  // 用户接受风险：只能由用户给（role=user），Agent 不代签——直接经唯一写服务提交该用户事件
  service.submit({
    schema_version: 2,
    project_id: "dv-b3-accepted",
    change_id: "chg-dv",
    actor_id: "fixture-user",
    role: "user",
    entity_id: "finding:f-risk",
    type: "finding.accepted_risk",
    expected_revision: 1,
    idempotency_key: "finding.accepted_risk:f-risk",
    payload: {
      accepted_by: "夹具用户",
      basis: "夹具：已知限制，用户接受风险",
      scope_revision: "fixture-scope",
      review_condition: "下次会话复查",
    },
  });
  const facts = collectProjectFacts("dv-b3-accepted", dataDir);
  ok(
    facts.findings.find((f) => f.finding_id === "f-risk")?.status === "accepted_risk",
    "⑭0 夹具：缺陷已被用户接受风险（不是在途确认）",
    facts.findings.find((f) => f.finding_id === "f-risk")?.status,
  );
  const L = ledgerOf(readLedger("dv-b3-accepted"));
  ok(
    (L?.delivery?.blockers ?? []).filter((b) => b.kind === "blocking_finding" && b.message.includes("f-risk")).length === 0,
    "⑭a 用户接受风险不产生阻断（与 canonical findingBlocksDelivery 同口径）",
    L?.delivery?.blockers,
  );
  ok(
    (L?.delivery?.integration?.missing ?? []).every((m) => !m.includes("f-risk")),
    "⑭b 交付集成核对也不把接受风险当开放缺陷",
    L?.delivery?.integration?.missing,
  );
}

// ═══════════════════ ⑮ B4 新交付检查的源变进 package_revision（同版分页负例） ═══════════════════
section("⑮ B4 覆盖源变进 package_revision：同版分页游标必须被拒（不静默跨版本）");

/** 起一个隔离的唯一写服务宿主（只为 saveEvidence 落源清单；事件仍走本脚本的 service） */
async function startEvidenceHost(): Promise<{ server: http.Server }> {
  const svc = new WorkService({ dataDir });
  const token = crypto.randomBytes(18).toString("base64url");
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    void handleWorkRequest(req, res, { service: svc, token, pathname }).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  writeServiceDescriptor(dataDir, {
    schema_version: 2,
    pid: process.pid,
    host: "127.0.0.1",
    port,
    token,
    started_at: new Date().toISOString(),
    url: `http://127.0.0.1:${port}`,
  });
  return { server };
}

{
  const SRC_REL = "src/dv-src.ts";
  const SRC_V1 = "export const DVSRC = 'v1';\n";
  const SRC_V2 = "export const DVSRC = 'v2-changed';\n";
  // 与 dv-full 同构的夹具（两功能 ⇒ 分页必然未结束），另加一个被覆盖的源文件
  makeProject({ id: "dv-src", plan: PLAN_FULL, design: DESIGN_FULL, requirements: ["req-dv", "req-two"], baseline: true });
  const projRoot = path.join(tmpBase, "dv-src");
  write(path.join(projRoot, SRC_REL), SRC_V1);

  const host = await startEvidenceHost();
  const client = new WorkServiceClient({ dataDir, autostart: false });
  const ctx: McpContext = { clientName: "verify-dv", work: client };
  const srcSha = sha256(SRC_V1);
  const manifestFp = buildSourceManifest(projRoot, [{ path: SRC_REL, sha256: srcSha }]).fingerprint;
  const storeRes = await recordWorkEvidenceTool.handler(
    {
      op: "store",
      project_id: "dv-src",
      role: "executor",
      kind: "source_manifest",
      summary: "夹具：交付检查的覆盖源清单",
      created_by: "fixture",
      binding: { revision_kind: "code", revision: manifestFp },
      source_manifest: [{ path: SRC_REL, sha256: srcSha }],
    },
    ctx,
  );
  const storeJson = JSON.parse(storeRes.content?.[0]?.text ?? "{}") as { ok?: boolean; evidence?: { sha256?: string } };
  const manifestSha = storeJson.evidence?.sha256 ?? "";
  ok(storeRes.isError !== true && /^[0-9a-f]{64}$/.test(manifestSha), "⑮0 源清单经唯一写服务宿主登记（内容寻址 sha 回执）", storeJson);
  // 让「交付核对声明」引用的承接卡检查**与**交付范围集成检查都带同一覆盖源清单（绑定 code 修订 = 清单指纹）
  recordIndependent("dv-src", "V-1", "chk-v-1-01", "pass", "src-check", { codeRevision: manifestFp, evidence: manifestSha });
  recordIndependent("dv-src", "project:delivery", "int-project-delivery-01", "pass", "src-int-check", { codeRevision: manifestFp, evidence: manifestSha });
  host.server.close();

  const p1 = ledgerOf(readLedger("dv-src", { limit: 1 }));
  const cursor = p1?.paging.cursor ?? null;
  const rev1 = p1?.package_revision ?? "";
  ok(p1?.paging.complete === false && cursor !== null, "⑮a 夹具分页未结束（拿到绑定包版本的游标）", { complete: p1?.paging.complete });

  // 改被覆盖的真实源文件，**不再上报任何事件**——这正是"同版分页中途源变"
  fs.writeFileSync(path.join(projRoot, SRC_REL), SRC_V2, "utf8");

  const staleCursor = readLedger("dv-src", { cursor: cursor ?? "" });
  ok(
    staleCursor.ok === false && (staleCursor as { code?: string }).code === "REVISION_CHANGED",
    "⑮b 覆盖源变了：旧游标（同版分页）被拒（不跨版本静默返回）",
    staleCursor.ok === false ? (staleCursor as { code?: string; message?: string }) : staleCursor,
  );

  const p2 = ledgerOf(readLedger("dv-src"));
  ok((p2?.package_revision ?? "") !== rev1 && rev1 !== "", "⑮c 覆盖源变 ⇒ package_revision 变（新交付检查的源读数确实进版本身份）", {
    rev1,
    rev2: p2?.package_revision,
  });
  ok(
    (p2?.package_revision_basis ?? []).some((b) => b.startsWith("source_readings:") && !b.endsWith("（读不到）")),
    "⑮d 包版本依据含 source_readings（可核对来源清单）",
    p2?.package_revision_basis,
  );
}

// ═══════════════════ ⑯ 旧 feature 字段无业务回归（新 delivery 不改既有判据） ═══════════════════
section("⑯ 旧 feature 字段无业务回归：新增 delivery/agent_review 不改既有定义与状态判据");
{
  // dv-full 已全绿；断言既有字段逐字仍在、且与 §⑨ 同源
  const L = ledgerOf(readLedger("dv-full"));
  const cap = itemOf(L, "cap-dv");
  ok(
    cap?.design_coverage.state === "已核对" &&
      cap?.verification.display_status === "verified" &&
      cap?.user_acceptance.state === "pending" &&
      (cap?.provenance.extraction ?? "") === "declared",
    "⑯a 既有 design_coverage/verification/user_acceptance/provenance 字段判据不变",
    cap && {
      design: cap.design_coverage.state,
      verified: cap.verification.display_status,
      acceptance: cap.user_acceptance.state,
      extraction: cap.provenance.extraction,
    },
  );
  ok(
    cap?.agent_review?.state === "passed" && (cap?.agent_review?.required_count ?? 0) > 0,
    "⑯b 逐项 agent_review 仍是 canonical evidence_basis 只读适配（未新造判据）",
    cap?.agent_review,
  );
  ok(
    L?.coverage.source_complete === true && L?.delivery?.state === "ready_for_trial",
    "⑯c 覆盖读数与交付结论同源（本夹具全范围读齐 + 可试用）",
    { source_complete: L?.coverage.source_complete, delivery: L?.delivery?.state },
  );
}

// ═══════════════ ⑰ D1：全局阻断缺陷口径与 canonical 逐对象 `blockingProblem` 一致 ═══════════════
// 独立审查 D1：非功能成员任务上的「未证实（非 must_block）」缺陷，canonical 逐对象判 blocked，而交付总览的
// 全局阻断原只接 must_block ⇒ 漏接（可能假 ready）。现全局 filter 复用 statusProjection 的
// `findingBlocksObject`（未收口 ∧ 非 accepted_risk ∧（must_block ∨ unverified）），与 canonical 逐对象一致；
// accepted_risk／已关闭／「非 must_block 且非未证实」的开放缺陷仍不误伤（保留原语义）。反例逐条给出。
section("⑰ D1 未证实缺陷也进全局阻断（与 canonical 一致）；accepted_risk/closed/非 must_block 不误伤");
{
  const PLAN_ORPHAN =
    PLAN_WITH_DECL(GATE_ROWS_ALL, INT_ROWS)
      .replace("| V-1 | todo | 交付总览 |  | 证据齐 |", "| V-1 | todo | 交付总览 |  | 证据齐 |\n| V-9 | todo | 旁支卡 |  | 证据齐 |") +
    "\n### V-9 旁支卡\n\n**设计依据**：§3.16。**依赖**：无。**文件责任**：`src/o.ts`。\n\n- [ ] **chk-v-9-01 旁支检查**\n";
  const greenOrphan = (id: string): void => {
    makeProject({ id, plan: PLAN_ORPHAN, design: DESIGN_DV, requirements: ["req-dv"], baseline: true });
    for (const c of ["chk-v-1-01", "chk-v-1-02", "chk-v-1-03", "chk-v-1-04"]) recordIndependent(id, "V-1", c, "pass", `${id}-${c}`);
    recordIndependent(id, "cap-dv", "int-dv-01", "pass", `${id}-int`);
    recordIndependent(id, "project:delivery", "int-project-delivery-01", "pass", `${id}-del`);
  };
  const findingOf = (id: string, key: string) => collectProjectFacts(id, dataDir).findings.find((x) => x.finding_id === key);
  const globalBlockerFor = (L: FeatureLedger | null, key: string): boolean =>
    (L?.delivery?.blockers ?? []).some((b) => b.kind === "blocking_finding" && (b.message ?? "").includes(key));

  // ⑰0 对照：旁支卡（非功能成员）无缺陷 ⇒ 不影响就绪（证明挡住的是缺陷，不是旁支卡本身）
  greenOrphan("dv-d1-control");
  {
    const L = ledgerOf(readLedger("dv-d1-control"));
    ok(L?.delivery?.state === "ready_for_trial", "⑰0 对照：旁支卡无缺陷 ⇒ 仍 ready", L?.delivery?.state);
  }

  // ⑰a 非功能成员任务上的未证实（非 must_block）缺陷 ⇒ 全局接住、不 ready（D1 修复本体）
  greenOrphan("dv-d1-unver");
  recordFinding("dv-d1-unver", "V-9", "f-d1-unver", "user_visible_defect");
  {
    const f = findingOf("dv-d1-unver", "f-d1-unver");
    ok(
      f?.status === "pending_repro" && f?.unverified === true && f?.must_block === false,
      "⑰a0 夹具：pending_repro + 未证实（风险未排除）+ 非 must_block",
      f && { status: f.status, unverified: f.unverified, must_block: f.must_block },
    );
    const L = ledgerOf(readLedger("dv-d1-unver"));
    ok(L?.delivery?.state === "not_ready", "⑰a 非功能成员任务上的未证实缺陷 ⇒ 不 ready（与 canonical 逐对象一致）", L?.delivery?.state);
    ok(globalBlockerFor(L, "f-d1-unver"), "⑰a′ 该缺陷作为全局阻断逐条点名", L?.delivery?.blockers);
  }

  // ⑰b 反例：用户接受风险（即使未证实）⇒ 不阻断（保留 accepted_risk 原语义，不扩大口径）
  greenOrphan("dv-d1-accepted");
  recordFinding("dv-d1-accepted", "V-9", "f-d1-acc", "user_visible_defect");
  service.submit({
    schema_version: 2,
    project_id: "dv-d1-accepted",
    change_id: "chg-dv",
    actor_id: "fixture-user",
    role: "user",
    entity_id: "finding:f-d1-acc",
    type: "finding.accepted_risk",
    expected_revision: 1,
    idempotency_key: "finding.accepted_risk:f-d1-acc",
    payload: {
      accepted_by: "夹具用户",
      basis: "夹具：已知限制，用户接受风险",
      scope_revision: "fixture-scope",
      review_condition: "下次会话复查",
    },
  });
  {
    const L = ledgerOf(readLedger("dv-d1-accepted"));
    ok(!globalBlockerFor(L, "f-d1-acc"), "⑰b 用户接受风险的未证实缺陷不产生全局阻断（与 canonical 一致）", L?.delivery?.blockers);
    ok(L?.delivery?.state === "ready_for_trial", "⑰b′ 接受风险后恢复 ready（旁支卡）", L?.delivery?.state);
  }

  // ⑰c 反例：开放但非 must_block 且非未证实（cosmetic 已证实）⇒ 不阻断
  greenOrphan("dv-d1-minor");
  recordFinding("dv-d1-minor", "V-9", "f-d1-minor", "cosmetic", { repro: "复现步骤：文案错字" });
  {
    const f = findingOf("dv-d1-minor", "f-d1-minor");
    ok(
      f?.status === "confirmed" && f?.unverified === false && f?.must_block === false,
      "⑰c0 夹具：已证实 + 非未证实 + 非 must_block",
      f && { status: f.status, unverified: f.unverified, must_block: f.must_block },
    );
    const L = ledgerOf(readLedger("dv-d1-minor"));
    ok(
      !globalBlockerFor(L, "f-d1-minor") && (L?.delivery?.blockers ?? []).every((b) => b.kind !== "blocking_finding"),
      "⑰c 非 must_block/非未证实的开放缺陷不进全局阻断",
      L?.delivery?.blockers,
    );
    ok(L?.delivery?.state === "ready_for_trial", "⑰c′ 该情形仍 ready", L?.delivery?.state);
  }

  // ⑰d 反例：已关闭的 must_block 缺陷 ⇒ 不阻断（closed 不计，旧口径未放宽）
  greenOrphan("dv-d1-closed");
  recordFinding("dv-d1-closed", "V-9", "f-d1-closed", "blocks_core_goal", { repro: "复现步骤：核心目标失败" });
  {
    const L = ledgerOf(readLedger("dv-d1-closed"));
    ok(L?.delivery?.state === "not_ready", "⑰d0 前置：must_block 开放缺陷（已证实）⇒ not_ready（旧口径未放宽）", L?.delivery?.state);
  }
  service.submit({
    schema_version: 2,
    project_id: "dv-d1-closed",
    change_id: "chg-dv",
    actor_id: "fixture-fixer",
    role: "executor",
    entity_id: "finding:f-d1-closed",
    type: "finding.fix_submitted",
    expected_revision: 1,
    idempotency_key: "finding.fix_submitted:f-d1-closed",
    payload: { fix_revision: "fix-1", fixed_by: "fixture-fixer" },
  });
  service.submit({
    schema_version: 2,
    project_id: "dv-d1-closed",
    change_id: "chg-dv",
    actor_id: "fixture-reviewer",
    role: "auditor",
    entity_id: "finding:f-d1-closed",
    type: "finding.retest_recorded",
    expected_revision: 2,
    idempotency_key: "finding.retest_recorded:f-d1-closed",
    payload: { retested_by: "fixture-reviewer", result: "pass", retest_evidence: sha256("retest:f-d1-closed") },
  });
  {
    const f = findingOf("dv-d1-closed", "f-d1-closed");
    ok(f?.status === "closed", "⑰d1 夹具：缺陷已关闭（独立复测通过）", f && { status: f.status });
    const L = ledgerOf(readLedger("dv-d1-closed"));
    ok(
      !globalBlockerFor(L, "f-d1-closed") && (L?.delivery?.blockers ?? []).every((b) => b.kind !== "blocking_finding"),
      "⑰d 已关闭的缺陷不进全局阻断",
      L?.delivery?.blockers,
    );
    ok(L?.delivery?.state === "ready_for_trial", "⑰d′ 关闭后恢复 ready", L?.delivery?.state);
  }
}

console.log(`\n[verify] 合计 PASS=${pass} FAIL=${fail}（隔离 TATAI_HOME=${dataDir}，不碰真实项目/账本/8787）`);
