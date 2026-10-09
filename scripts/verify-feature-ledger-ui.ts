// B6/V09-56 界面验证的**夹具项目**构造器（隔离）。
//
// 用法：node --import tsx scripts/verify-feature-ledger-ui.ts --home <TATAI_HOME> --root <夹具根>
// 行为：在 <夹具根>/<projectId>/ 下造 7 个场景项目，写进 <home> 的注册表，stdout 打印一行 JSON
//       `{"home":..., "root":..., "projects":{...}}` 供驱动脚本（verify-feature-ledger-ui.py）读取。
//
// 隔离红线：**只写 --home/--root 指定的隔离目录**，不碰任何真实项目 / 真实 ~/.tatai / 真实 8787。
// 场景（对应 PLAN V09-56 覆盖面）：
//   A 缺设计            ui-missing-design：已登记需求未映射 ⇒ design_coverage=缺失
//   B 设计已审无运行     ui-approved-no-run：声明已核对（reviewer+章节 hash+基线批准）＋无运行记录
//   C 提交缺 check       ui-submitted：任务结果已提交、必需检查缺失
//   D 有效验证通过       ui-verified：必需检查 + 集成检查都有有效通过证据；另记一条用户接受
//   E 相关源变保留历史   ui-source-change：设计章节改动 ⇒ 源变待复核；旧基线仍在历史里
//   F 用户 pending       ui-user-pending：多成员任务、无用户接受 ⇒ user_acceptance=pending
//   G 共享 scope         ui-shared-scope：两个功能共用一个 change 级 scope_id
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { WorkService } from "../src/server/work/service";
import { addProject } from "../src/server/registry";
import { activateBaseline, buildSectionIndex, sha256Hex } from "../src/server/work/documents";
import { importTaskDefinitions } from "../src/server/work/plan";
import { submitDefinitionImports } from "../src/server/work/tasks";
import { claimTask, submitTaskResult } from "../src/server/work/claims";
import { registerRequirement } from "../src/server/work/requirements";
import { submitHumanAcceptance } from "../src/server/work/audit";
import { putEvidence } from "../src/server/work/evidence";
import { projectWorkDir } from "../src/server/workstation";
import type { DocumentSection } from "../src/server/work/documents";

const SCHEMA_VERSION = 2;

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}
const HOME = arg("home");
const ROOT = arg("root");
if (HOME === null || ROOT === null) {
  console.error("用法：node --import tsx scripts/verify-feature-ledger-ui.ts --home <TATAI_HOME> --root <夹具根>");
  process.exit(2);
}
process.env.TATAI_HOME = HOME;
fs.mkdirSync(HOME, { recursive: true });
fs.mkdirSync(ROOT, { recursive: true });
const service = new WorkService({ dataDir: HOME });
const submitter = { submit: (c: unknown) => service.submit(c) };
const CODE_REV = sha256Hex("ui-fixture-code-rev");

const write = (f: string, text: string): void => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text, "utf8");
};

const DECL_HEAD = [
  "| 功能 ID | 人话功能名 | 需求 ID | 设计章节 | 本期范围（scope_id） | 覆盖结论 | 依据/缺口（review） | 使用结果与场景 |",
  "| --- | --- | --- | --- | --- | --- | --- | --- |",
];

function registerRequirementFor(projectId: string, rid: string, change = "chg-ui"): void {
  registerRequirement(submitter as never, {
    project_id: projectId,
    requirement_id: rid,
    change_id: change,
    actor_id: "fixture",
    role: "designer",
    source: { kind: "user", ref: "夹具用户 2026-10-07" },
    problem: `夹具需求 ${rid}：让用户看懂这个功能做什么`,
    users: [],
    success_scenarios: ["夹具场景：人一眼看懂并点回原文"],
    exclusions: [],
    priority: "P1",
    status: "explicit",
  });
}

/**
 * 记一条检查证据（作者自检）。
 * binding/verifies 默认绑 `code`；HTTP 读口的 `code_revision` 缺省为 null（B2 契约：只有调用方显式给才有值），
 * 所以要让检查在**真 HTTP** 下可复核，夹具把证据绑到**设计修订**（HTTP 下 design 修订是可核对的现值）。
 */
function recordCheck(
  projectId: string,
  taskId: string,
  checkId: string,
  result: "pass" | "fail",
  key: string,
  binding: { revision_kind: "code" | "design" | "plan"; revision: string } = { revision_kind: "code", revision: CODE_REV },
): void {
  service.submit({
    schema_version: SCHEMA_VERSION,
    project_id: projectId,
    change_id: "chg-ui",
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
      binding,
      record_method: "夹具自检（跑定向命令后按输出判）",
      checks: [
        {
          check_id: checkId,
          method: "夹具定向检查",
          command: null,
          exit_code: null,
          output_ref: null,
          evidence_sha256: sha256Hex(`evidence:${key}`),
          scope: [],
          verifies: binding.revision_kind === "code" ? "code" : "document",
        },
      ],
    },
  });
}

/**
 * 落一份**源清单**证据（`kind=source_manifest`）：服务端现读项目根内这些路径算内容哈希，
 * 返回内容寻址 id 与清单指纹。**这才是「验的是功能代码」的可核对来源**——检查绑到这个指纹上，
 * 读侧每次现读复核；覆盖的源码一变，绑定的检查就失效（Codex 复审 7）。
 */
function putSourceManifestEvidence(
  projectId: string,
  files: string[],
): { evidence_id: string; fingerprint: string } {
  const blob = putEvidence(projectWorkDir(projectId, HOME as string), {
    kind: "source_manifest",
    source_manifest: { files },
    // 正文留空：服务端会用清单本体生成可读正文（清单是这类证据的正文）
    content: "",
    summary: `夹具源清单：${files.join("、")}`,
    created_by: "fixture-author",
    role: "executor",
    // 载体自报绑定：读侧只核**来源类**（code）是否与检查绑定同类，不比 revision 字面值
    binding: { revision_kind: "code", revision: sha256Hex(`fixture-source:${files.join("|")}`) },
  });
  if (blob.source_manifest === null) throw new Error(`夹具源清单没落下来：${files.join("、")}`);
  return { evidence_id: blob.evidence_id, fingerprint: blob.source_manifest.fingerprint };
}

/**
 * 记一条**机械检查**证据：绑 `code:<源清单指纹>` + 真实源清单证据哈希 + 命令/退出码，
 * `verifies=code`。真 HTTP 读口下这条检查会被现读复核（覆盖源变 → 待复验），与设计/施工图无关
 * ——不是拿 document 绑定冒充功能代码验证。
 */
function recordSourceManifestCheck(
  projectId: string,
  taskId: string,
  checkId: string,
  key: string,
  manifest: { evidence_id: string; fingerprint: string },
): void {
  service.submit({
    schema_version: SCHEMA_VERSION,
    project_id: projectId,
    change_id: "chg-ui",
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
      conclusion: "pass",
      binding: { revision_kind: "code", revision: manifest.fingerprint },
      record_method: "夹具机械检查：跑定向命令后按输出与源清单现读结论判",
      checks: [
        {
          check_id: checkId,
          method: "机械检查（源清单覆盖的源码现读复核）",
          command: "node --test fixture-check",
          exit_code: 0,
          output_ref: null,
          evidence_sha256: manifest.evidence_id,
          scope: [],
          verifies: "code",
        },
      ],
    },
  });
}

/** 落一份夹具证据正文，返回内容寻址 id（供结果提交的 evidence_refs 指向真实存在的证据） */
function putFixtureEvidence(projectId: string, key: string): string {
  const blob = putEvidence(projectWorkDir(projectId, HOME as string), {
    kind: "submission",
    content: `夹具交付证据 ${key}`,
    summary: `夹具交付证据 ${key}`,
    created_by: "fixture-executor",
    role: "executor",
    binding: { revision_kind: "code", revision: CODE_REV },
  });
  return blob.evidence_id;
}

/** 记一条「任务结果已提交」：走**真实**认领 + 结果提交（写服务的五查全过，不伪造事件） */
async function recordResultSubmitted(projectId: string, taskId: string, key: string): Promise<void> {
  const claim = await claimTask(
    {
      project_id: projectId,
      task_id: taskId,
      role: "executor",
      owner_id: "fixture-executor",
      change_id: "chg-ui",
    },
    submitter as never,
    HOME as string,
  );
  if (!claim.ok) throw new Error(`夹具认领失败：${claim.code} ${claim.message}`);
  const res = await submitTaskResult(
    {
      project_id: projectId,
      task_id: taskId,
      role: "executor",
      owner_id: "fixture-executor",
      change_id: "chg-ui",
      claim_token: claim.claim.claim_token,
      expected_revision: claim.claim.entity_revision,
      deliverables: ["夹具交付物：功能 C"],
      evidence_refs: [putFixtureEvidence(projectId, key)],
      verification: [{ command: "fixture check", exit_code: 0, output_ref: null }],
      untested: [],
      known_issues: [],
    },
    { submitter: submitter as never },
    HOME as string,
  );
  if (!res.ok) throw new Error(`夹具结果提交失败：${res.code} ${res.message}`);
}

function sectionOf(text: string, anchor: string): DocumentSection {
  const s = buildSectionIndex(text).find(
    (x) => x.title.startsWith(`${anchor} `) || x.title === anchor || x.title.startsWith(`${anchor}　`),
  );
  if (s === undefined) throw new Error(`夹具设计书里找不到章节 ${anchor}`);
  return s;
}

interface Scenario {
  id: string;
  label: string;
  root: string;
  note: string;
}

const projects: Record<string, Scenario> = {};

function mkProject(id: string, name: string): string {
  const root = path.join(ROOT as string, id);
  fs.mkdirSync(path.join(root, ".工作台"), { recursive: true });
  addProject({ id, name, path: root, kind: "backend" }, HOME as string);
  return root;
}

// ── A 缺设计：声明区在，但已登记需求未映射（design_coverage=缺失） ──
{
  const id = "ui-missing-design";
  const planText = [
    "# 夹具施工图",
    "",
    "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |",
    "| --- | --- | --- | --- | --- |",
    "| V-1 | todo | 功能 A 实现 |  | 证据齐 |",
    "",
    "### V-1 功能 A 实现",
    "",
    "**设计依据**：§3.5。**依赖**：无。**文件责任**：`src/a.ts`。",
    "",
    "- [ ] **chk-v-1-01 功能 A 达标**",
    "",
    "| 功能 ID | 人话功能名 | 承接卡 | 必需检查 | 集成检查 | 结果状态 |",
    "| --- | --- | --- | --- | --- | --- |",
    "| cap-a | 功能 A | V-1 | chk-v-1-01 |  | 未验 |",
    "",
  ].join("\n");
  buildApprovedFixture(id, "缺设计夹具", planText, [
    "| cap-a | 功能 A（设计覆盖待补） | req-a | §3.5 | cap-a | 缺失 | reviewer=; ref=.工作台/design.md#3.5; section_sha256=; gap=设计正文尚未写清这个功能 | 场景 A |",
  ]);
  registerRequirementFor(id, "req-a");
  // 设计里没写、施工图也没映射的已登记需求 ⇒ pending:req-orphan（design_coverage=缺失；不隐藏）
  registerRequirementFor(id, "req-orphan");
  activateBaseline(id, { approved_by: "user", approval_basis: "夹具审定2", approval_kind: "user_confirmed" }, HOME as string);
  projects.A = {
    id,
    label: "A 缺设计（需求未映射）",
    root: path.join(ROOT, id),
    note: "cap-a design_coverage=缺失；已登记需求 req-orphan 未映射 ⇒ pending:req-orphan（design_coverage=缺失）",
  };
}

// ── A' 无设计书：连声明区都没有（真 HTTP 下 422 TABLE_MISSING，界面须如实报「缺设计·待补」而非空成功） ──
{
  const id = "ui-no-design";
  const root = mkProject(id, "无设计书夹具");
  registerRequirementFor(id, "req-no-design");
  projects["A2"] = {
    id,
    label: "A2 无设计书（声明区缺失）",
    root,
    note: "无 design.md ⇒ feature-ledger 422 SOURCE_INVALID（TABLE_MISSING）；界面须显式报缺、不假空成功",
  };
}

/** B 风格：设计声明已核对（reviewer + 真实章节 hash + 已批准基线），给定 plan 文本与声明行 */
function buildApprovedFixture(
  id: string,
  name: string,
  planText: string,
  declRows: string[],
  opts?: { sectionBody?: string },
): { root: string; designText: string; designSha: string } {
  const root = mkProject(id, name);
  // 设计书：声明表放**独立章节**（2.5.2），被引用的功能章节（3.5）是纯正文——
  // 这样 3.5 的章节 hash 不含声明表本身（防自指），可稳定复算。
  const SECTION_BODY = opts?.sectionBody ?? "本功能让人一眼看懂它做什么，并能点回原文。";
  const head = [
    "# 夹具设计书",
    "",
    "### 2.5.2 功能清单声明（夹具）",
    "",
    DECL_HEAD[0],
    DECL_HEAD[1],
    ...declRows,
    "",
    "### 3.5 目标章节",
    "",
    SECTION_BODY,
    "",
  ];
  const placeholder = head.join("\n");
  const sect = sectionOf(placeholder, "3.5");
  const designText = placeholder.replace(/SECTION_HASH/g, sect.sha256);
  const planWithFile = planText;
  write(path.join(root, ".工作台", "plan.md"), planWithFile);
  write(path.join(root, ".工作台", "design.md"), designText);
  submitDefinitionImports(service, {
    project_id: id,
    change_id: "chg-ui",
    actor_id: "fixture",
    role: "coordinator",
    definitions: importTaskDefinitions(planWithFile, { plan_revision: sha256Hex(planWithFile) }).definitions,
  });
  activateBaseline(id, { approved_by: "user", approval_basis: "夹具审定", approval_kind: "user_confirmed" }, HOME as string);
  return { root, designText, designSha: sha256Hex(designText) };
}

// ── A3 设计章节定位不到的引用（声明的「设计章节」列指向不存在的 §9.9）：界面须显式报 unresolved、不猜近似标题 ──
{
  const id = "ui-unresolved-ref";
  const planText = [
    "# 夹具施工图",
    "",
    "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |",
    "| --- | --- | --- | --- | --- |",
    "| V-1 | todo | 功能 U 实现 |  | 证据齐 |",
    "",
    "### V-1 功能 U 实现",
    "",
    "**设计依据**：§9.9。**依赖**：无。**文件责任**：`src/u.ts`。",
    "",
    "- [ ] **chk-v-1-01 功能 U 达标**",
    "",
    "| 功能 ID | 人话功能名 | 承接卡 | 必需检查 | 集成检查 | 结果状态 |",
    "| --- | --- | --- | --- | --- | --- |",
    "| cap-u | 功能 U | V-1 | chk-v-1-01 |  | 未验 |",
    "",
  ].join("\n");
  buildApprovedFixture(id, "章节定位不到夹具", planText, [
    "| cap-u | 功能 U（设计章节引用定位不到） | req-u | §9.9 | cap-u | 待审 | reviewer=fixture-reviewer; ref=.工作台/design.md#3.5; section_sha256=SECTION_HASH; gap= | 场景 U |",
  ]);
  registerRequirementFor(id, "req-u");
  activateBaseline(id, { approved_by: "user", approval_basis: "夹具审定2", approval_kind: "user_confirmed" }, HOME as string);
  projects["A3"] = {
    id,
    label: "A3 设计章节定位不到",
    root: path.join(ROOT, id),
    note: "声明的「设计章节」= §9.9 不存在 ⇒ design_section_refs[].status=unresolved（界面显式报，不猜近似标题）",
  };
}

// ── B 设计已审无运行 ──
{
  const id = "ui-approved-no-run";
  const planText = [
    "# 夹具施工图",
    "",
    "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |",
    "| --- | --- | --- | --- | --- |",
    "| V-1 | todo | 功能 B 实现 |  | 证据齐 |",
    "",
    "### V-1 功能 B 实现",
    "",
    "**设计依据**：§3.5。**依赖**：无。**文件责任**：`src/b.ts`。",
    "",
    "- [ ] **chk-v-1-01 功能 B 达标**",
    "",
    "| 功能 ID | 人话功能名 | 承接卡 | 必需检查 | 集成检查 | 结果状态 |",
    "| --- | --- | --- | --- | --- | --- |",
    "| cap-b | 功能 B | V-1 | chk-v-1-01 |  | 未验 |",
    "",
  ].join("\n");
  buildApprovedFixture(id, "已审无运行夹具", planText, [
    "| cap-b | 功能 B（已审设计，尚无运行） | req-b | §3.5 | cap-b | 已核对 | reviewer=fixture-reviewer; ref=.工作台/design.md#3.5; section_sha256=SECTION_HASH; gap= | 场景 B |",
  ]);
  registerRequirementFor(id, "req-b");
  // 重新激活基线：先写 design（含真实 hash），需求登记后再激活，避免悬空需求影响声明吸收
  activateBaseline(id, { approved_by: "user", approval_basis: "夹具审定2", approval_kind: "user_confirmed" }, HOME as string);
  projects.B = { id, label: "B 设计已审无运行", root: path.join(ROOT, id), note: "cap-b 已核对、无运行记录、检查未过" };
}

// ── C 提交缺 check ──
{
  const id = "ui-submitted";
  const planText = [
    "# 夹具施工图",
    "",
    "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |",
    "| --- | --- | --- | --- | --- |",
    "| V-1 | todo | 功能 C 实现 |  | 证据齐 |",
    "",
    "### V-1 功能 C 实现",
    "",
    "**设计依据**：§3.5。**依赖**：无。**文件责任**：`src/c.ts`。",
    "",
    "- [ ] **chk-v-1-01 功能 C 达标**",
    "- [ ] **chk-v-1-02 功能 C 非作者复核**",
    "",
    "| 功能 ID | 人话功能名 | 承接卡 | 必需检查 | 集成检查 | 结果状态 |",
    "| --- | --- | --- | --- | --- | --- |",
    "| cap-c | 功能 C | V-1 | chk-v-1-01 |  | 未验 |",
    "",
  ].join("\n");
  buildApprovedFixture(id, "提交缺检查夹具", planText, [
    "| cap-c | 功能 C（已提交结果，检查不全） | req-c | §3.5 | cap-c | 已核对 | reviewer=fixture-reviewer; ref=.工作台/design.md#3.5; section_sha256=SECTION_HASH; gap= | 场景 C |",
  ]);
  registerRequirementFor(id, "req-c");
  activateBaseline(id, { approved_by: "user", approval_basis: "夹具审定2", approval_kind: "user_confirmed" }, HOME as string);
  await recordResultSubmitted(id, "V-1", "c-submit");
  projects.C = { id, label: "C 提交缺 check", root: path.join(ROOT, id), note: "V-1 结果已提交，chk-v-1-01 未有有效证据" };
}

// ── D 有效验证通过（+ 一条用户接受） ──
// **真实来源**：检查绑 `code:<源清单指纹>`，源清单由服务端现读 `src/verified-feature.ts` 算哈希。
// 真 HTTP 读口据此现读复核：覆盖源一变 → 该检查失效（待复验）；清单外的无关文件变化不连坐。
{
  const id = "ui-verified";
  const planText = [
    "# 夹具施工图",
    "",
    "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |",
    "| --- | --- | --- | --- | --- |",
    "| V-1 | todo | 功能 D 实现 |  | 证据齐 |",
    "",
    "### V-1 功能 D 实现",
    "",
    "**设计依据**：§3.5。**依赖**：无。**文件责任**：`src/d.ts`。",
    "",
    "- [ ] **chk-v-1-01 功能 D 达标**",
    "",
    "| 功能 ID | 人话功能名 | 承接卡 | 必需检查 | 集成检查 | 结果状态 |",
    "| --- | --- | --- | --- | --- | --- |",
    "| cap-d | 功能 D | V-1 | chk-v-1-01 | int-d-01 | 未验 |",
    "",
    "## 集成检查要求",
    "",
    "| 对象 ID | 检查 ID | 说明 | 必需性 |",
    "| --- | --- | --- | --- |",
    "| cap-d | int-d-01 | 端到端集成 | 必需 |",
    "",
  ].join("\n");
  buildApprovedFixture(id, "有效验证夹具", planText, [
    "| cap-d | 功能 D（必需检查与集成检查都有有效通过证据） | req-d | §3.5 | cap-d | 已核对 | reviewer=fixture-reviewer; ref=.工作台/design.md#3.5; section_sha256=SECTION_HASH; gap= | 场景 D |",
  ]);
  registerRequirementFor(id, "req-d");
  activateBaseline(id, { approved_by: "user", approval_basis: "夹具审定2", approval_kind: "user_confirmed" }, HOME as string);
  // 功能 D 的真源码（进了源清单）+ 一个**无关**文件（不进清单）
  write(path.join(ROOT as string, id, "src", "verified-feature.ts"), "export const verifiedFeature = 1;\n");
  write(path.join(ROOT as string, id, "src", "unrelated-note.ts"), "export const unrelated = 'unrelated';\n");
  const dManifest = putSourceManifestEvidence(id, ["src/verified-feature.ts"]);
  recordSourceManifestCheck(id, "V-1", "chk-v-1-01", "d-01", dManifest);
  recordSourceManifestCheck(id, "cap-d", "int-d-01", "d-int", dManifest);
  submitHumanAcceptance(submitter as never, {
    project_id: id,
    change_id: "chg-ui",
    actor_id: "fixture-user",
    role: "user",
    record_id: "acc-d-1",
    decision: "accept",
    task_id: "V-1",
    accepted_by: "fixture-user（夹具模拟，非真人验收）",
    note: "夹具模拟用户接受；不是真实人验收记录",
  });
  projects.D = { id, label: "D 有效验证通过", root: path.join(ROOT, id), note: "cap-d verified；V-1 有一条夹具用户接受" };
}

// ── E 相关源变保留历史 ──
{
  const id = "ui-source-change";
  const planText = [
    "# 夹具施工图",
    "",
    "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |",
    "| --- | --- | --- | --- | --- |",
    "| V-1 | todo | 功能 E 实现 |  | 证据齐 |",
    "",
    "### V-1 功能 E 实现",
    "",
    "**设计依据**：§3.5。**依赖**：无。**文件责任**：`src/e.ts`。",
    "",
    "- [ ] **chk-v-1-01 功能 E 达标**",
    "",
    "| 功能 ID | 人话功能名 | 承接卡 | 必需检查 | 集成检查 | 结果状态 |",
    "| --- | --- | --- | --- | --- | --- |",
    "| cap-e | 功能 E | V-1 | chk-v-1-01 |  | 未验 |",
    "",
  ].join("\n");
  const { designText } = buildApprovedFixture(id, "源变夹具", planText, [
    "| cap-e | 功能 E（设计已核对，之后章节被改） | req-e | §3.5 | cap-e | 已核对 | reviewer=fixture-reviewer; ref=.工作台/design.md#3.5; section_sha256=SECTION_HASH; gap= | 场景 E |",
  ]);
  registerRequirementFor(id, "req-e");
  activateBaseline(id, { approved_by: "user", approval_basis: "夹具审定2", approval_kind: "user_confirmed" }, HOME as string);
  // 相关源变：改被引用的功能章节（现读章节 hash 与声明里的 section_sha256 不再一致）
  const drifted = designText.replace(
    "本功能让人一眼看懂它做什么，并能点回原文。",
    "本功能让人一眼看懂它做什么，并能点回原文。（本章节已被改动——源变）",
  );
  write(path.join(ROOT as string, id, ".工作台", "design.md"), drifted);
  // 再激活一条基线（覆盖改动后的设计）⇒ 旧基线成为「历史已替代」，历史里可查当时版本
  activateBaseline(id, { approved_by: "codex", approval_basis: "夹具再审定（源变后）", approval_kind: "delegated_technical_review" }, HOME as string);
  projects.E = {
    id,
    label: "E 相关源变保留历史",
    root: path.join(ROOT, id),
    note: "章节 3.5 改动 ⇒ design_coverage=源变待复核；baseline_history 含被替代的旧基线（可查当时版本）",
  };
}

// ── F 用户 pending（多成员任务、无用户接受） ──
{
  const id = "ui-user-pending";
  const planText = [
    "# 夹具施工图",
    "",
    "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |",
    "| --- | --- | --- | --- | --- |",
    "| V-1 | todo | 功能 F 第一步 |  | 证据齐 |",
    "| V-2 | todo | 功能 F 第二步 | V-1 | 证据齐 |",
    "",
    "### V-1 功能 F 第一步",
    "",
    "**设计依据**：§3.5。**依赖**：无。**文件责任**：`src/f1.ts`。",
    "",
    "- [ ] **chk-v-1-01 第一步达标**",
    "",
    "### V-2 功能 F 第二步",
    "",
    "**设计依据**：§3.5。**依赖**：V-1。**文件责任**：`src/f2.ts`。",
    "",
    "- [ ] **chk-v-2-01 第二步达标**",
    "",
    "| 功能 ID | 人话功能名 | 承接卡 | 必需检查 | 集成检查 | 结果状态 |",
    "| --- | --- | --- | --- | --- | --- |",
    "| cap-f | 功能 F | V-1、V-2 | chk-v-1-01、chk-v-2-01 | int-f-01 | 未验 |",
    "",
    "## 集成检查要求",
    "",
    "| 对象 ID | 检查 ID | 说明 | 必需性 |",
    "| --- | --- | --- | --- |",
    "| cap-f | int-f-01 | 端到端集成 | 必需 |",
    "",
  ].join("\n");
  buildApprovedFixture(id, "用户待决夹具", planText, [
    "| cap-f | 功能 F（两个成员任务，都还没用户接受） | req-f | §3.5 | cap-f | 已核对 | reviewer=fixture-reviewer; ref=.工作台/design.md#3.5; section_sha256=SECTION_HASH; gap= | 场景 F |",
  ]);
  registerRequirementFor(id, "req-f");
  activateBaseline(id, { approved_by: "user", approval_basis: "夹具审定2", approval_kind: "user_confirmed" }, HOME as string);
  // 两个成员的检查都走**真实源清单**（code 绑定）：验证真通过、但没人接受 ⇒ 才轮到用户决定
  write(path.join(ROOT as string, id, "src", "feature-f.ts"), "export const featureF = 1;\n");
  const fManifest = putSourceManifestEvidence(id, ["src/feature-f.ts"]);
  recordSourceManifestCheck(id, "V-1", "chk-v-1-01", "f-01", fManifest);
  recordSourceManifestCheck(id, "V-2", "chk-v-2-01", "f-02", fManifest);
  recordSourceManifestCheck(id, "cap-f", "int-f-01", "f-int", fManifest);
  projects.F = { id, label: "F 用户 pending", root: path.join(ROOT, id), note: "cap-f 两成员（部分检查已过），无用户 Gate ⇒ user_acceptance=pending" };
}

// ── G 共享 scope：两个功能共用一个 change 级 scope_id ──
{
  const id = "ui-shared-scope";
  const planText = [
    "# 夹具施工图",
    "",
    "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |",
    "| --- | --- | --- | --- | --- |",
    "| V-1 | todo | 共享范围功能一 |  | 证据齐 |",
    "| V-2 | todo | 共享范围功能二 |  | 证据齐 |",
    "",
    "### V-1 共享范围功能一",
    "",
    "**设计依据**：§3.5。**依赖**：无。**文件责任**：`src/g1.ts`。",
    "",
    "- [ ] **chk-v-1-01 功能一达标**",
    "",
    "### V-2 共享范围功能二",
    "",
    "**设计依据**：§3.5。**依赖**：无。**文件责任**：`src/g2.ts`。",
    "",
    "- [ ] **chk-v-2-01 功能二达标**",
    "",
    "| 功能 ID | 人话功能名 | 承接卡 | 必需检查 | 集成检查 | 结果状态 |",
    "| --- | --- | --- | --- | --- | --- |",
    "| cap-g1 | 共享范围功能一 | V-1 | chk-v-1-01 |  | 未验 |",
    "| cap-g2 | 共享范围功能二 | V-2 | chk-v-2-01 |  | 未验 |",
    "",
  ].join("\n");
  buildApprovedFixture(id, "共享范围夹具", planText, [
    "| cap-g1 | 共享范围功能一 | req-g1 | §3.5 | chg-ui-shared | 已核对 | reviewer=fixture-reviewer; ref=.工作台/design.md#3.5; section_sha256=SECTION_HASH; gap= | 场景 G1 |",
    "| cap-g2 | 共享范围功能二 | req-g2 | §3.5 | chg-ui-shared | 已核对 | reviewer=fixture-reviewer; ref=.工作台/design.md#3.5; section_sha256=SECTION_HASH; gap= | 场景 G2 |",
  ]);
  registerRequirementFor(id, "req-g1");
  registerRequirementFor(id, "req-g2");
  activateBaseline(id, { approved_by: "user", approval_basis: "夹具审定2", approval_kind: "user_confirmed" }, HOME as string);
  projects.G = { id, label: "G 共享 scope", root: path.join(ROOT, id), note: "cap-g1/cap-g2 共用 scope_id=chg-ui-shared" };
}

// ── H 多页功能（> 读口默认页大小 50）：真实 cursor 续读 / 合并 / 版本变拒绝旧页 ──
{
  const id = "ui-many-items";
  const N = 120;
  const declRows: string[] = [];
  const mapRows: string[] = [];
  const taskBlocks: string[] = [];
  const cardRows: string[] = [];
  for (let i = 1; i <= N; i++) {
    const n = String(i).padStart(3, "0");
    const cap = `cap-m${n}`;
    const task = `V-${i}`;
    const req = i === 1 ? "req-m001" : `req-m${n}`;
    declRows.push(
      `| ${cap} | 功能 M${n}（分页夹具） | ${req} | §3.5 | cap-many | 待审 | reviewer=; ref=.工作台/design.md#3.5; section_sha256=; gap=分页夹具（本行只为铺够页数） | 场景 M${n} |`,
    );
    mapRows.push(`| ${cap} | 功能 M${n} | ${task} | chk-m${n} |  | 未验 |`);
    cardRows.push(`| ${task} | todo | 功能 M${n} 实现 |  | 证据齐 |`);
    taskBlocks.push(
      `### ${task} 功能 M${n} 实现`,
      "",
      `**设计依据**：§3.5。**依赖**：无。**文件责任**：\`src/m${n}.ts\`。`,
      "",
      `- [ ] **chk-m${n} 功能 M${n} 达标**`,
      "",
    );
  }
  const planText = [
    "# 夹具施工图",
    "",
    "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |",
    "| --- | --- | --- | --- | --- |",
    ...cardRows,
    "",
    ...taskBlocks,
    "| 功能 ID | 人话功能名 | 承接卡 | 必需检查 | 集成检查 | 结果状态 |",
    "| --- | --- | --- | --- | --- | --- |",
    ...mapRows,
    "",
  ].join("\n");
  buildApprovedFixture(id, "多页夹具", planText, declRows);
  // 声明区引用的需求必须**已登记**（悬空正式需求会整页 422）：逐条登记
  for (let i = 1; i <= N; i++) registerRequirementFor(id, `req-m${String(i).padStart(3, "0")}`);
  activateBaseline(id, { approved_by: "user", approval_basis: "夹具审定2", approval_kind: "user_confirmed" }, HOME as string);
  projects.H = {
    id,
    label: `H 多页功能（${N} 项）`,
    root: path.join(ROOT, id),
    note: `声明 ${N} 项功能 > 读口默认页大小 50：真实 cursor 续读、已载/未载读数、版本变拒绝旧页`,
  };
  (projects.H as Scenario & { items: number }).items = N;
}

// ── J 密度夹具（Codex R2 复审回归）：第一页就有一屏以上的「需要你看一眼」+ 同一份待议重复挂多功能 ──
// 真实 R2 现场：第一页 50 项、37 项要人看、20 条待议重复挂在 7 个功能上（求和张成 140）。
// 这里刻意造：12 个已声明功能（覆盖结论=待审 ⇒ 只因待决而进「需要你看一眼」）各挂同一份 20 条待议，
// 外加 50 条已登记但未映射的需求（design_coverage=缺失 ⇒ 异常项）。合计 62 项 > 默认页大小 50 ⇒ 分页未完成。
{
  const id = "ui-dense-attention";
  const DECIDED = 12;
  const UNMAPPED = 50;
  const DECISIONS = 20;
  const pack = (n: number): string => String(n).padStart(3, "0");
  const declRows: string[] = [];
  const mapRows: string[] = [];
  const cardRows: string[] = [];
  const taskBlocks: string[] = [];
  for (let i = 1; i <= DECIDED; i++) {
    const cap = `cap-j${pack(i)}`;
    const task = `VJ-${i}`;
    const req = `req-j${pack(i)}`;
    declRows.push(
      `| ${cap} | 功能 J${pack(i)}（密度夹具） | ${req} | §3.5 | cap-j-shared | 待审 | reviewer=; ref=.工作台/design.md#3.5; section_sha256=; gap=密度夹具：本行只为铺够待注意项 | 场景 J${pack(i)} |`,
    );
    mapRows.push(`| ${cap} | 功能 J${pack(i)} | ${task} | chk-j${pack(i)} |  | 未验 |`);
    cardRows.push(`| ${task} | todo | 功能 J${pack(i)} 实现 |  | 证据齐 |`);
    taskBlocks.push(
      `### ${task} 功能 J${pack(i)} 实现`,
      "",
      `**设计依据**：§3.5。**依赖**：无。**文件责任**：\`src/j${pack(i)}.ts\`。`,
      "",
      `- [ ] **chk-j${pack(i)} 功能 J${pack(i)} 达标**`,
      "",
    );
  }
  const planText = [
    "# 夹具施工图",
    "",
    "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |",
    "| --- | --- | --- | --- | --- |",
    ...cardRows,
    "",
    ...taskBlocks,
    "| 功能 ID | 人话功能名 | 承接卡 | 必需检查 | 集成检查 | 结果状态 |",
    "| --- | --- | --- | --- | --- | --- |",
    ...mapRows,
    "",
  ].join("\n");
  buildApprovedFixture(id, "密度夹具", planText, declRows);
  // 声明区引用的 12 条需求必须已登记；另外 50 条**已登记但未映射** ⇒ pending:req-jNNN（缺失）
  for (let i = 1; i <= DECIDED + UNMAPPED; i++) registerRequirementFor(id, `req-j${pack(i)}`);
  activateBaseline(id, { approved_by: "user", approval_basis: "夹具审定2", approval_kind: "user_confirmed" }, HOME as string);
  // 20 条待议：读口按 `discuss#L<行号>` 给稳定身份，并**逐功能重复挂载**（真实链路就是这样）
  const discussLines = ["# 待议记录", "", "> 夹具待议：只为验证同一待决挂多功能时的计数口径。", ""];
  for (let i = 1; i <= DECISIONS; i++) {
    discussLines.push(`- \`2026-10-07\` 密度夹具待议 ${pack(i)}：这一条同时影响多个功能，计数只应算一次。`);
    discussLines.push("");
  }
  write(path.join(ROOT as string, id, ".工作台", "design.discuss.md"), discussLines.join("\n"));
  projects.J = {
    id,
    label: `J 密度夹具（${DECIDED + UNMAPPED} 项 / 待议 ${DECISIONS} 条重复挂载）`,
    root: path.join(ROOT, id),
    note: `第一页 50 项：${DECIDED} 项因待决 + 38 项因缺设计进入「需要你看一眼」（合计 50）；同一份 ${DECISIONS} 条待议被逐功能重复挂载（求和张成 ${DECIDED * DECISIONS}，去重应得 ${DECISIONS}）`,
  };
  (projects.J as Scenario & { dense: unknown }).dense = {
    declared: DECIDED,
    unmapped: UNMAPPED,
    decisions: DECISIONS,
    items: DECIDED + UNMAPPED,
  };
}

// ── I 标题定位（重复标题 / 强调 / 同名前缀 / h1–h6）：行号必须来自 Markdown AST ──
{
  const id = "ui-headings";
  const root = mkProject(id, "标题定位夹具");
  const lines = [
    "# 夹具设计书（标题定位）",
    "",
    "### 3.5 目标章节",
    "",
    "正文甲。",
    "",
    "### 3.5 目标章节",
    "",
    "正文乙。",
    "",
    "### 3.5 **强调**目标",
    "",
    "正文丙。",
    "",
    "#### 3.5 目标章节",
    "",
    "四级正文。",
    "",
    "##### 五级 3.5 章节",
    "",
    "五级正文。",
    "",
    "###### 六级 3.5 章节",
    "",
    "六级正文。",
    "",
  ];
  const text = lines.join("\n");
  write(path.join(root, ".工作台", "design.md"), text);
  // 独立（不依赖 mdast）算一遍每个 `#` 级标题的 1 起行号：测试拿它当**期望值**核 DOM
  const headings: { level: number; line: number; text: string }[] = [];
  lines.forEach((ln, i) => {
    const m = /^(#{1,6})\s+(.*\S)\s*$/.exec(ln);
    if (m) headings.push({ level: m[1].length, line: i + 1, text: m[2].replace(/\*\*/g, "").trim() });
  });
  projects.I = {
    id,
    label: "I 标题定位（重复/强调/前缀/h1–h6）",
    root,
    note: "正文标题 id 必须等于该标题在源文本里的真实行号（design-h-<line>），不按标题文字近似匹配",
  };
  (projects.I as Scenario & { headings: typeof headings }).headings = headings;
}

console.log(
  JSON.stringify(
    {
      home: HOME,
      root: ROOT,
      code_revision: CODE_REV,
      projects: Object.fromEntries(
        Object.entries(projects).map(([k, v]) => [k, { id: v.id, label: v.label, root: v.root, note: v.note }]),
      ),
      // 供驱动脚本构测试用的**期望值**（不参与渲染，只用于断言）
      expectations: {
        D: {
          project_id: projects.D.id,
          manifest_files: ["src/verified-feature.ts"],
          unrelated_file: "src/unrelated-note.ts",
          manifest_file_abs: path.join(ROOT as string, projects.D.id, "src", "verified-feature.ts"),
          unrelated_file_abs: path.join(ROOT as string, projects.D.id, "src", "unrelated-note.ts"),
        },
        H: { project_id: projects.H.id, items: 120, page_size: 50 },
        I: { project_id: projects.I.id, headings: (projects.I as Scenario & { headings: unknown }).headings },
        J: {
          project_id: projects.J.id,
          page_size: 50,
          ...(projects.J as Scenario & { dense: { declared: number; unmapped: number; decisions: number; items: number } }).dense,
        },
      },
    },
    null,
    2,
  ),
);
