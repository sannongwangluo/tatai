// B2 / V09-52 验证脚本（tsx 跑）：功能清单契约、唯一义务派生、稳定 check 身份、HTTP/MCP 只读读口。
// 用法：node --import tsx scripts/verify-feature-ledger.ts
//
// 自带隔离环境：临时 `TATAI_HOME` + `os.tmpdir()` 下的夹具项目，**不碰**任何真实项目/账本/生产服务
// （绝不连真实 8787）。**反例优先**：每一类要求都配一条"会失败"的负例（拒绝假绿、拒绝混版、
// 拒绝按位置继承、拒绝任意 hex 蒙混、拒绝盲信调用方 map、拒绝整页 422 掩盖……），再验正例。
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { WorkService } from "../src/server/work/service";
import { collectProjectFacts, eventsSnapshotOf } from "../src/server/work/statusProjection";
import { addProject } from "../src/server/registry";
import { buildSectionIndex, activateBaseline, readBaselineLog, sha256Hex } from "../src/server/work/documents";
import { importTaskDefinitions } from "../src/server/work/plan";
import { submitDefinitionImports } from "../src/server/work/tasks";
import { registerRequirement } from "../src/server/work/requirements";
import { putEvidence } from "../src/server/work/evidence";
import type { FeatureItem } from "../src/shared/coverageTypes";
import { TOOLS } from "../src/mcp/tools/index";
import { featureLedgerTool } from "../src/mcp/tools/featureLedger";
import {
  parseFeatureDeclaration,
  parsePlanFeatureMap,
  parseReviewRef,
  buildFeatureItems,
  sectionsOf,
} from "../src/server/work/coverageModel";
import {
  stableCheckDefinitionsOf,
  resolveCheckIdentity,
  checkDefinitionFingerprint,
  independenceRequiredOf,
  mappingFromDefinitionHistory,
  validateCheckIdentityMapping,
  applyCheckIdentities,
  deriveObligations,
  scopeVersionOf,
  evidenceStateOfProjection,
} from "../src/server/work/obligations";
import {
  readFeatureLedger,
  parseFeatureLedgerParams,
  packageRevisionOf,
  encodeCursor,
  decodeCursor,
} from "../src/server/work/featureLedger";

let pass = 0;
let fail = 0;
const ok = (cond: boolean, label: string, detail?: unknown): void => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (cond) pass++;
  else {
    fail++;
    process.exitCode = 1;
    if (detail !== undefined) console.log(`[verify]   现场：${JSON.stringify(detail).slice(0, 1400)}`);
  }
};
const section = (t: string): void => console.log(`\n[verify] ═══ ${t}`);
const sha256 = (b: string | Buffer): string => crypto.createHash("sha256").update(b).digest("hex");
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-b2-fl-"));
const dataDir = path.join(tmpBase, "home");
fs.mkdirSync(dataDir, { recursive: true });
process.env.TATAI_HOME = dataDir;
const service = new WorkService({ dataDir });
const write = (f: string, text: string): void => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text, "utf8");
};
function treeHashes(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    if (!fs.existsSync(d)) return;
    for (const name of fs.readdirSync(d).sort()) {
      const abs = path.join(d, name);
      if (fs.statSync(abs).isDirectory()) walk(abs);
      else out[path.relative(dir, abs).replace(/\\/g, "/")] = sha256(fs.readFileSync(abs));
    }
  };
  walk(dir);
  return out;
}
const submitter = { submit: (c: unknown) => service.submit(c) };
const CODE_REV = sha256("fixture-code-rev");

/** 记一条检查证据（第二档：method + 证据哈希，作者自检；binding=code、verifies=code） */
const recordCheck = (
  projectId: string,
  taskId: string,
  checkId: string,
  result: "pass" | "fail",
  key: string,
): void => {
  recordCheckWith(projectId, taskId, checkId, result, key, CODE_REV, sha256(`evidence:${key}`));
};

/** 同上，但显式给绑定的 code 修订与证据哈希（源清单用例要绑**清单指纹**） */
const recordCheckWith = (
  projectId: string,
  taskId: string,
  checkId: string,
  result: "pass" | "fail",
  key: string,
  codeRevision: string,
  evidenceSha256: string,
): void => {
  service.submit({
    schema_version: 2,
    project_id: projectId,
    change_id: "chg-b2",
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
          evidence_sha256: evidenceSha256,
          scope: [],
          verifies: "code",
        },
      ],
    },
  });
};

const registerRequirementFor = (
  projectId: string,
  rid: string,
  status: "explicit" | "inferred" | "unconfirmed" = "explicit",
): void => {
  registerRequirement(submitter as never, {
    project_id: projectId,
    requirement_id: rid,
    change_id: "chg-b2",
    actor_id: "fixture",
    role: "designer",
    source: { kind: "user", ref: "夹具用户 2026-10-07" },
    problem: `夹具需求 ${rid}`,
    users: [],
    success_scenarios: [],
    exclusions: [],
    priority: "P1",
    status,
  });
};

// 声明表构造（八列齐全）
const DECL_HEAD = [
  "| 功能 ID | 人话功能名 | 需求 ID | 设计章节 | 本期范围（scope_id） | 覆盖结论 | 依据/缺口（review） | 使用结果与场景 |",
  "| --- | --- | --- | --- | --- | --- | --- | --- |",
];

// ═══════════════════ ① 声明区解析严格性（反例优先） ═══════════════════
section("① 声明区解析：八列齐全/围栏排除/缺列/重复 ID/悬空需求/章节定位不到/普通表不吸收");

const FENCE_EXAMPLE = [
  "# 设计",
  "```text",
  "#### 功能清单声明（示例）",
  DECL_HEAD[0],
  DECL_HEAD[1],
  "| cap-example | 示例 | req-x | §3.5 | 未定 | 部分 | x | y |",
  "```",
].join("\n");
{
  const r = parseFeatureDeclaration(FENCE_EXAMPLE, { known_requirement_ids: new Set() });
  ok(!r.found && r.features.length === 0, "①a 围栏内的同形表**不被吸收**（示例不是声明区）", r);
}

const DECL_OK = [
  "# 设计",
  "",
  "### 3.5 目标章节",
  "",
  "正文。",
  "",
  "#### 功能清单声明（正式）",
  "",
  DECL_HEAD[0],
  DECL_HEAD[1],
  "| cap-a | 功能 A | req-a | §3.5 | cap-a | 待审 | reviewer=; ref=DESIGN.md#3.5; section_sha256=abc; gap=未施工 | 场景 A |",
  "",
].join("\n");
{
  const r = parseFeatureDeclaration(DECL_OK, { known_requirement_ids: new Set(["req-a"]) });
  ok(r.found && r.features.length === 1 && r.issues.length === 0, "①b 完整八列 + 已登记需求 + 可定位章节 ⇒ 吸收，零问题", r.issues);
}
{
  const bad = DECL_OK.replace("| 使用结果与场景 |", "| 别的列 |");
  const r = parseFeatureDeclaration(bad, { known_requirement_ids: new Set(["req-a"]) });
  ok(r.issues.some((i) => i.code === "COLUMNS_MISSING"), "①c 缺列 ⇒ COLUMNS_MISSING（不吸收）", r.issues);
}
{
  const bad = DECL_OK.replace(
    "| cap-a | 功能 A | req-a | §3.5 | cap-a | 待审 | reviewer=; ref=DESIGN.md#3.5; section_sha256=abc; gap=未施工 | 场景 A |",
    "| cap-a | 功能 A | req-a | §3.5 | cap-a | 待审 | reviewer=; ref=DESIGN.md#3.5; section_sha256=abc; gap=x | 场景 A |\n| cap-a | 重复 | req-a | §3.5 | cap-a | 待审 | reviewer=; ref=DESIGN.md#3.5; section_sha256=abc; gap=x | y |",
  );
  const r = parseFeatureDeclaration(bad, { known_requirement_ids: new Set(["req-a"]) });
  ok(r.issues.some((i) => i.code === "DUPLICATE_FEATURE_ID"), "①d 重复功能 ID ⇒ DUPLICATE_FEATURE_ID", r.issues);
}
{
  const r = parseFeatureDeclaration(DECL_OK, { known_requirement_ids: new Set() });
  ok(r.issues.some((i) => i.code === "DANGLING_REQUIREMENT"), "①e 悬空正式需求 ⇒ DANGLING_REQUIREMENT", r.issues);
}
{
  const plain = ["# 设计", "", "| 功能 | 说明 |", "| --- | --- |", "| x | y |"].join("\n");
  const r = parseFeatureDeclaration(plain, { known_requirement_ids: new Set() });
  ok(!r.found, "①g 普通业务表不被吸收（无精确标题）", r);
}

// ═══════════════════ ② PLAN 功能映射表 ═══════════════════
section("② PLAN 功能→任务/检查/集成映射（稳定 ID 形式）");
const PLAN_MAP = [
  "# 施工图",
  "",
  "| 功能 ID | 人话功能名 | 承接卡 | 必需检查 | 集成检查 | 结果状态 |",
  "| --- | --- | --- | --- | --- | --- |",
  "| cap-a | 功能 A | V-1、V-2 | chk-v-1-01、chk-v-2-01 | int-a-01 | 未验 |",
  "",
].join("\n");
{
  const r = parsePlanFeatureMap(PLAN_MAP);
  ok(
    r.found && r.rows.length === 1 && r.rows[0].task_ids.length === 2 && r.rows[0].required_check_ids.length === 2 && r.issues.length === 0,
    "②a 功能映射表解析（2 卡 / 2 必需检查 / 1 集成）",
    r,
  );
  const rb = parsePlanFeatureMap(PLAN_MAP.replace("chk-v-1-01、chk-v-2-01", "第一条检查、第二条"));
  ok(rb.issues.some((i) => i.code === "REVIEW_MALFORMED"), "②b 必需检查列非稳定 ID ⇒ 报错", rb.issues);
}

// ═══════════════════ ③ check 稳定身份（单元级：重排保持 / 改语义不继承 / 盲信 map 被拒） ═══════════════════
section("③ check 稳定键 + 定义指纹 + 显式映射（单元级反例）");
const defOf = (checks: string[], revisions?: Record<string, number>) => ({
  task_id: "V-1",
  stable_key: "v-1",
  change_id: null,
  requirement_ids: null,
  plan_revision: null,
  design_revision: null,
  base_commit: null,
  goal: "g",
  dependency_ids: [],
  dependency_notes: [],
  dependency_evidence: [],
  inputs: null,
  allowed_paths: [],
  forbidden: null,
  acceptance: { checks: checks.map((text, i) => ({ text, checked: false, line: i + 1 })), deliverables: null },
  risk: null,
  deliverables: null,
  owner_role: null,
  priority: null,
  revision: revisions?.["V-1"] ?? 1,
  design_refs: [],
  evidence_requirement: null,
  section_lines: null,
  row_line: 1,
});
{
  const d1 = stableCheckDefinitionsOf(defOf(["**chk-v-1-02 第二条**", "**chk-v-1-01 第一条 非作者复核**"]) as never);
  const d2 = stableCheckDefinitionsOf(defOf(["**chk-v-1-01 第一条 非作者复核**", "**chk-v-1-02 第二条**"]) as never);
  const m1 = new Map(d1.map((d) => [d.check_id, d.definition_fingerprint]));
  const m2 = new Map(d2.map((d) => [d.check_id, d.definition_fingerprint]));
  ok(d1[0].check_id === "chk-v-1-02" && d1[0].stable, "③a 前缀稳定键被识别为 check_id（含 ** 加粗）", d1.map((d) => d.check_id));
  ok(m1.get("chk-v-1-01") === m2.get("chk-v-1-01"), "③b **重排不改变**指纹（同语义身份安全保持）", { a: m1.get("chk-v-1-01"), b: m2.get("chk-v-1-01") });
  const d3 = stableCheckDefinitionsOf(defOf(["**chk-v-1-01 第一条（改了语义）非作者复核**"]) as never);
  ok(m1.get("chk-v-1-01") !== d3[0].definition_fingerprint, "③c 改语义 ⇒ 指纹变");
  ok(
    d1[0].independence_required === false && d1[1].independence_required === true,
    "③d 独审义务由显式文本标记判（非作者）",
    d1.map((d) => d.independence_required),
  );
  // ③d′ **真实存量文本**的正反例（PLAN 实存句式，逐条照抄）：不得把"业务概念"误判成独审义务，
  // 也不得把"本项由非作者复核"这种明确要求漏掉（§2.7／§5.8）。
  {
    const required = [
      "⑧ **非作者独立审计**：由**非本卡作者**的另一执行者做独立审计，带覆盖/未覆盖矩阵…本卡作者自检**不得**代替它。",
      "非作者复核完成；未测项如实记录，不代签用户验收。",
      "第一条 非作者复核",
      "本项须由非作者独立复测（[独立复核] 标记亦可）",
    ];
    const notRequired = [
      "实现结果提交、自检、独立审计、修复待复测和人工接受的分离记录；severity 根据用户后果、finding 去重/误报/未证实与关闭规则明确。",
      "…「独立审计记录数仍为 227、无一被判整批失效」两条对照；pnpm verify:v09-01 全 PASS…",
      "V06-02 的正式独立复测留给非作者审计人，本卡不代做。",
      "反例＝任一条静态边来源失效 ⇒ 阻断逐条点名该边 id；缺证/失效的阻断效力不降低。",
    ];
    const badReq = required.filter((t) => !independenceRequiredOf(t));
    const badNot = notRequired.filter((t) => independenceRequiredOf(t));
    ok(badReq.length === 0 && badNot.length === 0, "③d′ 独审义务：真实存量语句正例齐全、业务概念不误判", { badReq, badNot });
  }
  const d = stableCheckDefinitionsOf(defOf(["**chk-v-1-01 第一条**"]) as never);
  const noMap = resolveCheckIdentity("V-1::check:0", d, {});
  ok(noMap.check_id === null, "③e 位置型旧身份**无显式映射** ⇒ 不继承（身份未知）", noMap);
  const legacy = stableCheckDefinitionsOf(defOf(["第一条（无前缀）"]) as never);
  ok(legacy[0].check_id === "V-1::check:0" && !legacy[0].stable, "③g 无前缀 ⇒ 位置型 id（既有项目向后兼容）", legacy[0]);
}
{
  // 从**不可变定义历史**推导映射：旧位置文本与当前同一检查（补齐 chk- 前缀）逐字相同 ⇒ 成立
  const current = stableCheckDefinitionsOf(defOf(["**chk-v-1-01 第一条**", "**chk-v-1-02 第二条**"]) as never);
  const hist = mappingFromDefinitionHistory({ "V-1": current }, [
    { task_id: "V-1", source_ref: "plan-revisions/old.md", definition: defOf(["第一条", "第二条"]) as never },
  ]);
  const table = Object.fromEntries(hist.mapping.map((e) => [e.legacy_position_id, e.stable_check_id]));
  ok(table["V-1::check:0"] === "chk-v-1-01" && table["V-1::check:1"] === "chk-v-1-02", "③h 定义历史按**身份化文本**推导显式映射", hist.mapping);
  const reordered = stableCheckDefinitionsOf(defOf(["**chk-v-1-01 第一条**"]) as never);
  const histReorder = mappingFromDefinitionHistory({ "V-1": reordered }, [
    { task_id: "V-1", source_ref: "plan-revisions/old.md", definition: defOf(["另一条完全不同的检查", "第一条"]) as never },
  ]);
  ok(
    histReorder.mapping.some((e) => e.legacy_position_id === "V-1::check:1" && e.stable_check_id === "chk-v-1-01"),
    "③i 重排后按**文本**认身份：旧 check:1 才映射到 chk-v-1-01（不是按位置）",
    histReorder.mapping,
  );
  const changed = stableCheckDefinitionsOf(defOf(["**chk-v-1-01 第一条（语义已改）**"]) as never);
  const histChanged = mappingFromDefinitionHistory({ "V-1": changed }, [
    { task_id: "V-1", source_ref: "plan-revisions/old.md", definition: defOf(["第一条"]) as never },
  ]);
  ok(histChanged.mapping.length === 0, "③j **同位置换语义** ⇒ 没有映射（不继承旧通过）", histChanged.mapping);
  // ③j′ `source_ref` 必须是**可取回的正式来源**（不能随便填一个字符串就放行）
  {
    const cur = stableCheckDefinitionsOf(defOf(["**chk-v-1-01 第一条**"]) as never);
    const mkEntry = (source_ref: string) => ({
      task_id: "V-1",
      legacy_position_id: "V-1::check:0",
      stable_check_id: "chk-v-1-01",
      definition_fingerprint: cur[0].definition_fingerprint,
      source_ref,
    });
    const okRef = "plan-revisions/" + "a".repeat(64) + ".md#V-1";
    const good = validateCheckIdentityMapping([mkEntry(okRef)], { "V-1": cur }, {
      source_readable: (r) => r === okRef,
    });
    const bad = validateCheckIdentityMapping([mkEntry("plan-revisions/随便.md#V-1")], { "V-1": cur }, {
      source_readable: (r) => r === okRef,
    });
    ok(
      good.accepted.length === 1 && bad.accepted.length === 0 && bad.rejected.length === 1,
      "③j′ 来源可取回 ⇒ 采信；来源取不回（随便填）⇒ 拒（不拿字符串冒充真实性）",
      { good: good.accepted.length, bad: bad.rejected.map((r) => r.reason) },
    );
  }
  // 调用方直传的裸 mapping 不可采信（没有定义指纹）：validateCheckIdentityMapping 拒
  const bare = validateCheckIdentityMapping(
    [
      {
        task_id: "V-1",
        legacy_position_id: "V-1::check:0",
        stable_check_id: "chk-v-1-01",
        definition_fingerprint: "0000000000000000000000000000000000000000000000000000000000000000",
        source_ref: "（调用方直传）",
      },
    ],
    { "V-1": current },
  );
  ok(bare.accepted.length === 0 && bare.rejected.length === 1, "③k 指纹对不上的显式映射被拒（不盲信调用方）", bare.rejected);
}

// ═══════════════════ ④ 参数严格验证 + 游标/包版本 ═══════════════════
section("④ 参数全契约严格验证 + 游标绑定包版本 + 包版本绑源读数");
{
  ok("ok" in (parseFeatureLedgerParams({ nope: 1 }) as object), "④a 未知参数 ⇒ 400 INVALID_INPUT");
  ok("ok" in (parseFeatureLedgerParams({ limit: 0 }) as object), "④b limit=0 ⇒ 400");
  ok("ok" in (parseFeatureLedgerParams({ limit: 201 }) as object), "④c limit=201 ⇒ 400");
  const good = parseFeatureLedgerParams({ scope: "current", limit: "10" });
  ok(!("ok" in (good as object)) && (good as { limit?: number }).limit === 10, "④d 合法参数通过（limit 字符串→整数）");
  const base = { design: "d", plan: "p", plan_definition: "pd", ledger_last_seq: 3, scope_id: null, scope_revision: "s", artifact_ref: null };
  const pr = packageRevisionOf({ ...base, source_readings: "r1" });
  const pr2 = packageRevisionOf({ ...base, source_readings: "r1", ledger_last_seq: 4 });
  ok(pr !== pr2 && pr.length === 64, "④e package_revision 对事实变化敏感且稳定");
  const prArtifact = packageRevisionOf({ ...base, source_readings: "r1", artifact_ref: "artifact:x" });
  ok(prArtifact !== pr, "④g package_revision 绑产物选择（换 artifact_ref ⇒ 换包版本、旧游标失效）");
  const prRead = packageRevisionOf({ ...base, source_readings: "r2" });
  ok(prRead !== pr, "④h package_revision **绑本范围源读数**（相关源码变而无新事件 ⇒ 包版本变，旧游标 409）", { pr, prRead });
  const c = encodeCursor({ v: 1, package_revision: pr, offset: 10 });
  ok(decodeCursor(c)?.offset === 10, "④f 游标往返");
}
{
  // ref 形态解析：任意 64hex 只是"形态像"，真实存在性由 readFeatureLedger 核
  ok(parseReviewRef("DESIGN.md#3.5").kind === "section", "④i ref `<路径>#<锚点>` 解析为 section");
  ok(parseReviewRef("a".repeat(64)).kind === "evidence", "④j 64hex 解析为 evidence（存在性另核）");
  ok(parseReviewRef("DESIGN.md").kind === "none", "④k 没有 `#` 的非哈希 ref ⇒ none（不猜）");
  ok(parseReviewRef("/etc/passwd#3.5").kind === "none", "④l 绝对路径 ref ⇒ none");
  ok(parseReviewRef("../../x.md#3.5").kind === "none", "④m `..` 路径 ref ⇒ none");
}

// ═══════════════════ ⑤ 端到端夹具（四维 / 功能集成 / 局部范围 / 未归属） ═══════════════════
section("⑤ 端到端夹具：功能范围用显式 required/integration 检查、未归属可见、局部检查不拖累");

const PID = "fl-fixture";
const root = path.join(tmpBase, PID);
fs.mkdirSync(path.join(root, ".工作台"), { recursive: true });

const planText = [
  "# 夹具施工图",
  "",
  "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |",
  "| --- | --- | --- | --- | --- |",
  "| V-1 | todo | 功能 A 实现 |  | 证据齐 |",
  "| V-2 | todo | 功能 A 收尾 | V-1 | 证据齐 |",
  "",
  "### V-1 功能 A 实现",
  "",
  "**设计依据**：§3.5。**依赖**：无。**文件责任**：`src/a.ts`。",
  "",
  "- [ ] **chk-v-1-01 功能 A 达标**",
  "- [ ] **chk-v-1-02 功能 A 非作者复核**",
  "- [ ] **chk-v-1-99 同一张卡里但**不属于本功能**的检查",
  "",
  "### V-2 功能 A 收尾",
  "",
  "**设计依据**：§3.5。**依赖**：V-1。**文件责任**：`src/b.ts`。",
  "",
  "- [ ] **chk-v-2-01 收尾达标**",
  "",
  "| 功能 ID | 人话功能名 | 承接卡 | 必需检查 | 集成检查 | 结果状态 |",
  "| --- | --- | --- | --- | --- | --- |",
  "| cap-a | 功能 A | V-1、V-2 | chk-v-1-01、chk-v-2-01 | int-a-01 | 未验 |",
  "",
  "## 集成检查要求",
  "",
  "| 对象 ID | 检查 ID | 说明 | 必需性 |",
  "| --- | --- | --- | --- |",
  "| cap-a | int-a-01 | 端到端集成 | 必需 |",
  "",
].join("\n");

const designText = [
  "# 夹具设计书",
  "",
  "### 3.5 功能清单章节",
  "",
  "正文。",
  "",
  "#### 功能清单声明（夹具）",
  "",
  DECL_HEAD[0],
  DECL_HEAD[1],
  "| cap-a | 功能 A | req-a | §3.5 | cap-a | 待审 | reviewer=; ref=DESIGN.md#3.5; section_sha256=SECT; gap=未施工 | 场景 A |",
  "| cap-b | 功能 B（施工图还没有映射行） | req-b | §3.5 | cap-b | 待审 | reviewer=; ref=DESIGN.md#3.5; section_sha256=SECT; gap=未映射 | 场景 B |",
  "",
].join("\n");
write(path.join(root, ".工作台", "plan.md"), planText);
write(path.join(root, ".工作台", "design.md"), designText);
addProject({ id: PID, name: "夹具", path: root, kind: "backend" }, dataDir);
registerRequirementFor(PID, "req-a");
registerRequirementFor(PID, "req-b");
registerRequirementFor(PID, "req-unmapped");

const imported = importTaskDefinitions(planText, { plan_revision: sha256(planText) });
submitDefinitionImports(service, {
  project_id: PID,
  change_id: "chg-b2",
  actor_id: "fixture",
  role: "coordinator",
  definitions: imported.definitions,
});
// 设计基线（review 四条件之一）：先按当前 design 激活，再用真实章节 hash 回填后重激活
activateBaseline(PID, { approved_by: "user", approval_basis: "夹具审定", approval_kind: "user_confirmed" }, dataDir);
const sect35 = sectionsOf(designText).find((s) => s.title.startsWith("3.5 "))!;
const designWithHash = designText.replace(/section_sha256=SECT/g, `section_sha256=${sect35.sha256}`);
write(path.join(root, ".工作台", "design.md"), designWithHash);
activateBaseline(PID, { approved_by: "user", approval_basis: "夹具审定2", approval_kind: "user_confirmed" }, dataDir);

const ledgerBefore = treeHashes(path.join(root, ".工作台"));
const res = readFeatureLedger(PID, dataDir, {}, { project_exists: () => true, code_revision: CODE_REV });
ok(res.ok && res.status === 200, "⑤a 读口返回 200 ok", res);
if (res.ok) {
  const L = res.ledger;
  const cap = L.items.find((i) => i.item_id === "cap-a");
  const capB = L.items.find((i) => i.item_id === "cap-b");
  ok(cap !== undefined, "⑤b 声明功能可见（cap-a）");
  ok(cap?.implementation.state === "no_run_record", "⑤c 无运行记录 ⇒ implementation.state=no_run_record（**不写「未实现」**）", cap?.implementation);
  ok(cap?.verification.display_status !== "verified", "⑤d 空/未验 ⇒ verification 不绿（绿只取 verification）", cap?.verification);
  ok(cap?.design_coverage.state === "待审", "⑤e reviewer 为空 ⇒ design_coverage=待审（不得自签「已核对」）", cap?.design_coverage);
  ok(cap?.user_acceptance.state === "pending", "⑤f 用户接受与设计审定不合并（pending）", cap?.user_acceptance);
  ok(capB !== undefined && capB.design_coverage.state !== "已核对", "⑤g **施工图缺映射**的功能仍可见（未归属，不整页 422、不假绿）", {
    item: capB?.item_id,
    unmapped: capB?.provenance.unmapped,
  });
  ok(
    L.items.some((i) => i.item_id === "pending:req-unmapped"),
    "⑤h 已登记未映射需求 ⇒ pending:<requirement_id> 可见",
    L.items.map((i) => i.item_id),
  );
  ok(
    L.coverage.mapped_count + L.coverage.pending_count === L.coverage.registered_requirement_count &&
      L.coverage.registered_requirement_count === 3,
    "⑤i 成员账目闭合（mapped+pending=registered=3）",
    L.coverage,
  );
  ok(L.paging.complete === true && L.coverage.source_complete === true, "⑤j 分页与来源完整性分开且此处均为 true");
  ok(
    L.package_revision.length === 64 && L.scope_revision.startsWith("srev-"),
    "⑤k 包版本 64hex / 范围版本为**统一算法**（成员＋检查定义指纹 `srev-…`，与六图同值）",
    { package_revision: L.package_revision, scope_revision: L.scope_revision },
  );
  ok(
    L.document_selection.mode === "active" && L.document_selection.baseline_id !== null,
    "⑤l 缺省 document=active ⇒ 读**已批准基线快照**（如实回报基线 id）",
    L.document_selection,
  );
  const withArt = readFeatureLedger(PID, dataDir, { artifact_ref: "a".repeat(64) }, { project_exists: () => true, code_revision: CODE_REV });
  ok(
    !withArt.ok && withArt.status === 422,
    "⑤m 未登记的产物引用 ⇒ 422（artifact_ref **不是**只 echo：取不到就失败）",
    withArt,
  );
}
const ledgerAfter = treeHashes(path.join(root, ".工作台"));
ok(JSON.stringify(ledgerBefore) === JSON.stringify(ledgerAfter), "⑤n **零副作用**：读口调用前后 .工作台 逐字节不变");

// 需求为空的项目（另建）⇒ source_complete=false / not_derived
{
  const PID2 = "fl-empty";
  const root2 = path.join(tmpBase, PID2);
  fs.mkdirSync(path.join(root2, ".工作台"), { recursive: true });
  write(
    path.join(root2, ".工作台", "design.md"),
    `# 空\n\n#### 功能清单声明\n\n${DECL_HEAD[0]}\n${DECL_HEAD[1]}\n`,
  );
  addProject({ id: PID2, name: "空", path: root2, kind: "backend" }, dataDir);
  const r2 = readFeatureLedger(PID2, dataDir, {}, { project_exists: () => true });
  ok(r2.ok && (r2.ledger.state === "not_derived" || r2.ledger.coverage.source_complete === false), "⑤o 空需求 ⇒ not_derived 或 source_complete=false（**不报完整**）", r2.ok ? r2.ledger.state : r2);
}

// ═══════════════════ ⑤′ 已登记待确认候选：未映射 ∧ unconfirmed 单列，不混正式待映射 ═══════════════════
section("⑤′ 已登记待确认候选（unconfirmed 未映射）：单列、待确认、分母守恒、不带正式未映射标记");
{
  const CAND = "fl-cand";
  const cRoot = path.join(tmpBase, CAND);
  fs.mkdirSync(path.join(cRoot, ".工作台"), { recursive: true });
  write(
    path.join(cRoot, ".工作台", "design.md"),
    [
      "# 夹具设计书",
      "",
      "### 5.1 功能章节",
      "",
      "正文。",
      "",
      "#### 功能清单声明（夹具）",
      "",
      DECL_HEAD[0],
      DECL_HEAD[1],
      "| cap-x | 功能 X | req-x | §5.1 | cap-x | 待审 | reviewer=; ref=DESIGN.md#5.1; section_sha256=SECT; gap=未施工 | 场景 X |",
      "",
    ].join("\n"),
  );
  const candPlan = [
    "# 夹具施工图",
    "",
    "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |",
    "| --- | --- | --- | --- | --- |",
    "| V-1 | todo | 功能 X |  | 证据齐 |",
    "",
    "### V-1 功能 X",
    "",
    "**设计依据**：§5.1。**依赖**：无。**文件责任**：`src/x.ts`。",
    "",
    "- [ ] **chk-v-1-01 功能 X 达标**",
    "",
    "| 功能 ID | 人话功能名 | 承接卡 | 必需检查 | 集成检查 | 结果状态 |",
    "| --- | --- | --- | --- | --- |",
    "| cap-x | 功能 X | V-1 | chk-v-1-01 | int-x-01 | 未验 |",
    "",
  ].join("\n");
  write(path.join(cRoot, ".工作台", "plan.md"), candPlan);
  addProject({ id: CAND, name: "候选夹具", path: cRoot, kind: "backend" }, dataDir);
  registerRequirementFor(CAND, "req-x");
  registerRequirementFor(CAND, "req-cand", "unconfirmed");
  submitDefinitionImports(service, {
    project_id: CAND,
    change_id: "chg-b2",
    actor_id: "fixture",
    role: "coordinator",
    definitions: importTaskDefinitions(candPlan, { plan_revision: sha256(candPlan) }).definitions,
  });
  // 生效基线：`document=active` 才读得到已批准快照，`source_complete` 才可能为 true（否则 unexamined 会有 baseline 项）
  activateBaseline(CAND, { approved_by: "user", approval_basis: "夹具审定", approval_kind: "user_confirmed" }, dataDir);
  const r = readFeatureLedger(CAND, dataDir, {}, { project_exists: () => true });
  ok(r.ok && r.status === 200, "⑤′a 读口返回 200 ok", r);
  if (r.ok) {
    const L = r.ledger;
    const cand = L.items.find((i) => i.item_id === "pending:req-cand");
    ok(cand?.provenance.extraction === "registered_candidate", "⑤′b 未映射 unconfirmed ⇒ 已登记待确认候选", cand?.provenance);
    ok((cand?.display_name ?? "").includes("已登记待确认") && !(cand?.display_name ?? "").includes("未登记"), "⑤′b′ 名称标明「已登记待确认」，不写「未登记」", cand?.display_name);
    ok(
      cand?.requirement_refs[0]?.certainty === "待确认" && cand?.requirement_refs[0]?.requirement_id === "req-cand" && (cand?.requirement_refs[0]?.source_ref ?? "") !== "",
      "⑤′c certainty=待确认 且保留 requirement_id 与来源",
      cand?.requirement_refs,
    );
    ok(
      L.coverage.registered_requirement_count === 2 &&
        L.coverage.mapped_count === 1 &&
        L.coverage.pending_count === 0 &&
        L.coverage.registered_candidate_count === 1 &&
        L.coverage.formal_requirement_count === 1,
      "⑤′d 分母守恒：registered=2 / mapped=1 / pending=0 / 候选=1 / formal=1",
      L.coverage,
    );
    ok(L.coverage.source_complete === true, "⑤′e 守恒成立 ⇒ 来源仍判读齐");
    ok((cand?.provenance.unmapped ?? []).length === 0, "⑤′f 候选不带正式未映射标记", cand?.provenance);
    ok(
      (L.delivery?.counts.registered_candidates ?? -1) === 1 &&
        L.delivery?.counts.formal_requirements === 1 &&
        (L.delivery?.blockers ?? []).every((b) => b.kind !== "unmapped_requirement"),
      "⑤′g 交付读数同源：候选 1 / 正式分母 1 / 无 unmapped_requirement 阻断",
      L.delivery,
    );
  }
}

// ═══════════════════ ⑥ 功能范围判绿（显式检查集合 / 集成 / 局部不拖累 / 范围 null） ═══════════════════
section("⑥ 功能范围判绿：显式 required/integration 检查、集成缺失不绿、同卡其他检查不拖累");

const GREEN = "fl-green";
const gRoot = path.join(tmpBase, GREEN);
fs.mkdirSync(path.join(gRoot, ".工作台"), { recursive: true });
const gPlan = [
  "# 施工图",
  "",
  "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |",
  "| --- | --- | --- | --- | --- |",
  "| V-1 | todo | 功能 G |  | 证据齐 |",
  "",
  "### V-1 功能 G",
  "",
  "**设计依据**：§3.5。**依赖**：无。**文件责任**：`src/g.ts`。",
  "",
  "- [ ] **chk-v-1-01 达标**",
  "- [ ] **chk-v-1-99 同一张卡里但**不属于功能 G** 的检查**",
  "",
  "| 功能 ID | 人话功能名 | 承接卡 | 必需检查 | 集成检查 | 结果状态 |",
  "| --- | --- | --- | --- | --- | --- |",
  "| cap-g | 功能 G | V-1 | chk-v-1-01 | int-g-01 | 未验 |",
  "",
  "## 集成检查要求",
  "",
  "| 对象 ID | 检查 ID | 说明 | 必需性 |",
  "| --- | --- | --- | --- |",
  "| cap-g | int-g-01 | 端到端集成 | 必需 |",
  "",
].join("\n");
const gDesign = [
  "# 设计书",
  "",
  "### 3.5 目标章节",
  "",
  "正文。",
  "",
  "#### 功能清单声明（夹具）",
  "",
  DECL_HEAD[0],
  DECL_HEAD[1],
  "| cap-g | 功能 G | req-g | §3.5 | cap-g | 待审 | reviewer=; ref=DESIGN.md#3.5; section_sha256=SECT; gap=x | 场景 |",
  "",
].join("\n");
write(path.join(gRoot, ".工作台", "plan.md"), gPlan);
write(path.join(gRoot, ".工作台", "design.md"), gDesign);
addProject({ id: GREEN, name: "绿夹具", path: gRoot, kind: "backend" }, dataDir);
registerRequirementFor(GREEN, "req-g");
submitDefinitionImports(service, {
  project_id: GREEN,
  change_id: "chg-b2",
  actor_id: "fixture",
  role: "coordinator",
  definitions: importTaskDefinitions(gPlan, { plan_revision: sha256(gPlan) }).definitions,
});
activateBaseline(GREEN, { approved_by: "user", approval_basis: "夹具审定", approval_kind: "user_confirmed" }, dataDir);
const gSect = sectionsOf(gDesign).find((s) => s.title.startsWith("3.5 "))!;
write(path.join(gRoot, ".工作台", "design.md"), gDesign.replace("section_sha256=SECT", `section_sha256=${gSect.sha256}`));
activateBaseline(GREEN, { approved_by: "user", approval_basis: "夹具审定2", approval_kind: "user_confirmed" }, dataDir);

// 只过 chk-v-1-01（int-g-01 故意先不记）；同卡另一条 chk-v-1-99 记成**失败**
recordCheck(GREEN, "V-1", "chk-v-1-01", "pass", "g-01");
recordCheck(GREEN, "V-1", "chk-v-1-99", "fail", "g-99");
{
  const r = readFeatureLedger(GREEN, dataDir, { document: "current" }, { project_exists: () => true, code_revision: CODE_REV });
  const cap = r.ok ? r.ledger.items.find((i) => i.item_id === "cap-g") : undefined;
  if (cap === undefined) {
    ok(false, "⑥ 功能范围项缺失（cap-g）", r);
  } else {
    ok(cap.verification.display_status !== "verified", "⑥a **缺集成检查证据** ⇒ 功能不绿（子项全绿不等于集成通过）", cap.verification);
    ok(
      cap.verification.missing.some((m) => m.includes("int-g-01")),
      "⑥b 集成检查缺口**逐条点名**",
      cap.verification.missing,
    );
    ok(
      !cap.verification.missing.some((m) => m.includes("chk-v-1-99")),
      "⑥c **同一张卡里不属于本功能**的失败检查**不拖累**本功能（局部范围如实）",
      cap.verification.missing,
    );
  }
}
// 补上集成检查证据 ⇒ 功能绿；同一张卡的 chk-v-1-99 仍是失败，但不在本范围
// （集成检查证据按**能力对象 id**归属：`task_id = cap-g`，与模块集成检查同一口径）
recordCheck(GREEN, "cap-g", "int-g-01", "pass", "g-int");
{
  const r = readFeatureLedger(GREEN, dataDir, { document: "current" }, { project_exists: () => true, code_revision: CODE_REV });
  const cap = r.ok ? r.ledger.items.find((i) => i.item_id === "cap-g") : undefined;
  if (cap === undefined) {
    ok(false, "⑥ 功能范围项缺失（cap-g）", r);
  } else {
    ok(cap.verification.display_status === "verified", "⑥d 必需检查 + 集成检查都有有效通过证据 ⇒ 功能 verified（同一份 projectStatuses 判据）", cap.verification);
    ok(
      cap.verification.required_count === 2,
      "⑥e required_count 只数**本范围**声明的检查（1 必需 + 1 集成），不数整卡",
      { required: cap.verification.required_count },
    );
  }
}
// 唯一义务层直接给出**集成检查逐项有效状态**（B5 的 DEPENDENCY-REQUEST #1 消费形状；判据不变）
{
  const facts = collectProjectFacts(GREEN, dataDir, { code_revision: CODE_REV });
  const rows = parsePlanFeatureMap(gPlan).rows;
  const d = deriveObligations({
    project_id: GREEN,
    data_dir: dataDir,
    facts,
    events: eventsSnapshotOf(GREEN, dataDir).events,
    features: rows.map((r) => ({
      feature_id: r.feature_id,
      task_ids: r.task_ids,
      required_check_ids: r.required_check_ids,
      integration_check_ids: r.integration_check_ids,
      scope_id: r.feature_id,
      mapped: true,
    })),
    plan_mapping_approved: true,
  });
  const ie = d.features["cap-g"]?.integration_evidence ?? [];
  ok(
    ie.length === 1 && ie[0].check_id === "int-g-01" && ie[0].state === "passed" && ie[0].required,
    "⑥g 唯一义务层直出集成检查逐项有效状态（stable check_id + effective；六图/工作包可同一份消费）",
    ie,
  );
}

// 范围列为 null 的声明 ⇒ 不给通过结论
{
  const NULL_SCOPE = "fl-nullscope";
  const nRoot = path.join(tmpBase, NULL_SCOPE);
  fs.mkdirSync(path.join(nRoot, ".工作台"), { recursive: true });
  write(path.join(nRoot, ".工作台", "plan.md"), gPlan);
  write(
    path.join(nRoot, ".工作台", "design.md"),
    [
      "# 设计书",
      "",
      "### 3.5 目标章节",
      "",
      "正文。",
      "",
      "#### 功能清单声明（夹具）",
      "",
      DECL_HEAD[0],
      DECL_HEAD[1],
      "| cap-g | 功能 G | req-g | §3.5 | null | 待审 | reviewer=; ref=DESIGN.md#3.5; section_sha256=SECT; gap=x | 场景 |",
      "",
    ].join("\n"),
  );
  addProject({ id: NULL_SCOPE, name: "范围未定", path: nRoot, kind: "backend" }, dataDir);
  registerRequirementFor(NULL_SCOPE, "req-g");
  submitDefinitionImports(service, {
    project_id: NULL_SCOPE,
    change_id: "chg-b2",
    actor_id: "fixture",
    role: "coordinator",
    definitions: importTaskDefinitions(gPlan, { plan_revision: sha256(gPlan) }).definitions,
  });
  recordCheck(NULL_SCOPE, "V-1", "chk-v-1-01", "pass", "n-01");
  recordCheck(NULL_SCOPE, "cap-g", "int-g-01", "pass", "n-int");
  const r = readFeatureLedger(NULL_SCOPE, dataDir, { document: "current" }, { project_exists: () => true, code_revision: CODE_REV });
  const cap = r.ok ? r.ledger.items.find((i) => i.item_id === "cap-g") : undefined;
  ok(
    r.ok && cap !== undefined && cap.scope_id === null && cap.verification.display_status !== "verified",
    "⑥f 「本期范围」=null ⇒ **不给通过结论**（即使检查都过）",
    cap?.verification,
  );
}

// ═══════════════════ ⑦ check 身份**进事实通路**（端到端：旧位置证据按显式映射被采信） ═══════════════════
section("⑦ 稳定身份进事实通路：旧位置证据（映射成立）被采信；无映射/语义变则不继承");

const IDENT = "fl-identity";
const iRoot = path.join(tmpBase, IDENT);
fs.mkdirSync(path.join(iRoot, ".工作台"), { recursive: true });
const oldPlan = [
  "# 施工图（旧版：位置型检查）",
  "",
  "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |",
  "| --- | --- | --- | --- | --- |",
  "| V-9 | todo | 身份夹具 |  | 证据齐 |",
  "",
  "### V-9 身份夹具",
  "",
  "**设计依据**：§3.5。**依赖**：无。**文件责任**：`src/i.ts`。",
  "",
  "- [ ] 第一条检查",
  "- [ ] 第二条检查",
  "",
].join("\n");
write(path.join(iRoot, ".工作台", "plan.md"), oldPlan);
write(path.join(iRoot, ".工作台", "design.md"), "# 设计书\n\n### 3.5 目标章节\n\n正文。\n");
addProject({ id: IDENT, name: "身份夹具", path: iRoot, kind: "backend" }, dataDir);
// rev1（位置型）+ 激活基线（把旧施工图存成不可变快照，作为**可读正式来源**）
submitDefinitionImports(service, {
  project_id: IDENT,
  change_id: "chg-b2",
  actor_id: "fixture",
  role: "coordinator",
  definitions: importTaskDefinitions(oldPlan, { plan_revision: sha256(oldPlan) }).definitions,
});
activateBaseline(IDENT, { approved_by: "user", approval_basis: "旧版审定", approval_kind: "user_confirmed" }, dataDir);
// 旧位置身份的证据（本轮真正出现在账本里的 check_id）
recordCheck(IDENT, "V-9", "V-9::check:0", "pass", "i-old-0");
{
  // rev2：同一张卡改成稳定键（同一检查，只是补了 chk- 前缀）
  const newPlan = oldPlan
    .replace("第一条检查", "**chk-v-9-01 第一条检查**")
    .replace("第二条检查", "**chk-v-9-02 第二条检查**")
    .replace("| V-9 | todo | 身份夹具 |", "| V-9 | todo | 身份夹具 |");
  write(path.join(iRoot, ".工作台", "plan.md"), newPlan);
  submitDefinitionImports(service, {
    project_id: IDENT,
    change_id: "chg-b2",
    actor_id: "fixture",
    role: "coordinator",
    expected_revisions: { "V-9": 1 },
    definitions: importTaskDefinitions(newPlan, { plan_revision: sha256(newPlan), revisions: { "V-9": 2 } }).definitions,
  });
  const facts = collectProjectFacts(IDENT, dataDir, { code_revision: CODE_REV });
  const derived = deriveObligations({
    project_id: IDENT,
    data_dir: dataDir,
    facts,
    events: eventsSnapshotOf(IDENT, dataDir).events,
    features: [],
  });
  const recorded = derived.checks.find((c) => c.check_id === "chk-v-9-01");
  ok(recorded !== undefined, "⑦a 旧位置证据经**显式映射**改写成稳定键，进了投影的检查记录", derived.checks.map((c) => c.check_id));
  const proj = derived.projection.by_id["V-9"];
  ok(proj?.passed_count === 1, "⑦b 该稳定键要求被这条旧证据满足（旧位置同不可变定义继续可用）", {
    passed: proj?.passed_count,
    missing: proj?.missing,
  });
  // 无映射：把历史快照移走后映射推导拿不到来源 ⇒ 不继承
  const snap = path.join(iRoot, ".工作台", "plan-revisions");
  const backup = fs.mkdtempSync(path.join(tmpBase, "rev-backup-"));
  for (const f of fs.readdirSync(snap)) fs.renameSync(path.join(snap, f), path.join(backup, f));
  const derived2 = deriveObligations({
    project_id: IDENT,
    data_dir: dataDir,
    facts: collectProjectFacts(IDENT, dataDir, { code_revision: CODE_REV }),
    events: eventsSnapshotOf(IDENT, dataDir).events,
    features: [],
  });
  ok(
    derived2.checks.every((c) => c.check_id !== "chk-v-9-01") && derived2.projection.by_id["V-9"]?.passed_count === 0,
    "⑦c 没有可读映射来源 ⇒ 旧位置证据**不继承**（身份未知，不给要求背书）",
    derived2.check_identity.unknown,
  );
  for (const f of fs.readdirSync(backup)) fs.renameSync(path.join(backup, f), path.join(snap, f));
}
{
  // 同 code revision + 验收定义变更（改语义）⇒ 旧证据不继承
  const changed = oldPlan
    .replace("第一条检查", "**chk-v-9-01 第一条检查（语义已改）**")
    .replace("第二条检查", "**chk-v-9-02 第二条检查**");
  write(path.join(iRoot, ".工作台", "plan.md"), changed);
  submitDefinitionImports(service, {
    project_id: IDENT,
    change_id: "chg-b2",
    actor_id: "fixture",
    role: "coordinator",
    expected_revisions: { "V-9": 2 },
    definitions: importTaskDefinitions(changed, { plan_revision: sha256(changed), revisions: { "V-9": 3 } }).definitions,
  });
  const facts = collectProjectFacts(IDENT, dataDir, { code_revision: CODE_REV });
  const derived = deriveObligations({
    project_id: IDENT,
    data_dir: dataDir,
    facts,
    events: eventsSnapshotOf(IDENT, dataDir).events,
    features: [],
  });
  ok(
    derived.projection.by_id["V-9"]?.passed_count === 0,
    "⑦d **同 code revision 下验收定义变更** ⇒ 旧证据不继承（凭指纹不凭位置）",
    { passed: derived.projection.by_id["V-9"]?.passed_count, unknown: derived.check_identity.unknown.length },
  );
}

// ═══════════════════ ⑧ document=active / 历史 / 漂移（不许混版） ═══════════════════
section("⑧ 版本一致性：active 读基线快照、草稿漂移如实标注、历史无快照 ⇒ 未知");
{
  const activeRead = readFeatureLedger(PID, dataDir, { document: "active" }, { project_exists: () => true, code_revision: CODE_REV });
  ok(
    activeRead.ok && activeRead.ledger.document_selection.mode === "active" && activeRead.ledger.document_selection.drift === null,
    "⑧a document=active 且无漂移 ⇒ 读基线快照、drift=null",
    activeRead.ok ? activeRead.ledger.document_selection : activeRead,
  );
  // 现行草稿漂移：改 design 但不激活基线
  const drifted = designWithHash.replace("| cap-a | 功能 A |", "| cap-a | 功能 A（草稿已改） |");
  write(path.join(root, ".工作台", "design.md"), drifted);
  const cur = readFeatureLedger(PID, dataDir, { document: "current" }, { project_exists: () => true, code_revision: CODE_REV });
  ok(cur.ok && cur.ledger.document_selection.drift !== null, "⑧b document=current 草稿漂移 ⇒ 如实点名（不假装现行=基线）", cur.ok ? cur.ledger.document_selection : cur);
  ok(
    cur.ok && cur.ledger.items.every((i) => i.design_coverage.state !== "已核对"),
    "⑧c 漂移草稿**不得**判「已核对」（覆盖不得自动推断）",
    cur.ok ? cur.ledger.items.map((i) => [i.item_id, i.design_coverage.state]) : cur,
  );
  const act2 = readFeatureLedger(PID, dataDir, { document: "active" }, { project_exists: () => true, code_revision: CODE_REV });
  ok(
    act2.ok && act2.ledger.document_selection.drift !== null && act2.ledger.document_selection.mode === "active",
    "⑧d 漂移时 document=active 仍读**已批准快照**并点名漂移",
    act2.ok ? act2.ledger.document_selection : act2,
  );
  // 历史修订：拿 active 的设计修订去读 ⇒ 能重建（材料在）；造一个不存在的修订 ⇒ not_derived
  const hist = act2.ok
    ? readFeatureLedger(PID, dataDir, { document: act2.ledger.document_selection.design_revision ?? "?" }, { project_exists: () => true, code_revision: CODE_REV })
    : act2;
  ok(hist.ok && hist.ledger.state === "ok" && hist.ledger.document_selection.mode === "revision", "⑧e 有材料的**历史修订实际重建**（不永久占位）", hist.ok ? hist.ledger.document_selection : hist);
  const missing = readFeatureLedger(PID, dataDir, { document: "f".repeat(64) }, { project_exists: () => true, code_revision: CODE_REV });
  ok(
    missing.ok && missing.ledger.state === "not_derived" && (missing.ledger.reason ?? "").includes("无法重建"),
    "⑧f 无快照的历史修订 ⇒ 200 not_derived（**明示未知**，不套当前通过）",
    missing.ok ? { state: missing.ledger.state, reason: missing.ledger.reason } : missing,
  );
  // 恢复 design，避免影响后面的用例
  write(path.join(root, ".工作台", "design.md"), designWithHash);
}

// ═══════════════════ ⑨ 覆盖真实性（ref/hash 不能蒙混） ═══════════════════
section("⑨ 设计覆盖：ref 必须真能定位、hash 必须匹配 ref 指定主章节");
{
  const COV = "fl-coverage";
  const cRoot = path.join(tmpBase, COV);
  fs.mkdirSync(path.join(cRoot, ".工作台"), { recursive: true });
  const sec2 = ["### 3.5 主章节", "", "主章节正文。", "", "### 4.2 另一章节", "", "另一章节正文。", ""].join("\n");
  const hash35 = buildSectionIndex(`# 设计\n\n${sec2}`).find((s) => s.title.startsWith("3.5 "))!.sha256;
  const rows = (ref: string, hash: string) =>
    [
      "| 功能 ID | 人话功能名 | 需求 ID | 设计章节 | 本期范围（scope_id） | 覆盖结论 | 依据/缺口（review） | 使用结果与场景 |",
      "| --- | --- | --- | --- | --- | --- | --- | --- |",
      `| cap-c | 覆盖夹具 | req-c | §3.5、§4.2 | cap-c | 已核对 | reviewer=审1; ref=${ref}; section_sha256=${hash}; gap= | 场景 |`,
      "",
    ].join("\n");
  const mkDesign = (ref: string, hash: string): string =>
    `# 设计\n\n${sec2}#### 功能清单声明（夹具）\n\n${rows(ref, hash)}`;
  write(path.join(cRoot, ".工作台", "plan.md"), gPlan);
  write(path.join(cRoot, ".工作台", "design.md"), mkDesign("DESIGN.md#3.5", hash35));
  addProject({ id: COV, name: "覆盖夹具", path: cRoot, kind: "backend" }, dataDir);
  registerRequirementFor(COV, "req-c");
  submitDefinitionImports(service, {
    project_id: COV,
    change_id: "chg-b2",
    actor_id: "fixture",
    role: "coordinator",
    definitions: importTaskDefinitions(gPlan, { plan_revision: sha256(gPlan) }).definitions,
  });
  // 设计源是 .工作台/design.md（缺省口径），review.ref 写 DESIGN.md#3.5 ⇒ 该文件**不存在** ⇒ 不可定位
  activateBaseline(COV, { approved_by: "user", approval_basis: "审定", approval_kind: "user_confirmed" }, dataDir);
  const r1 = readFeatureLedger(COV, dataDir, { document: "current" }, { project_exists: () => true, code_revision: CODE_REV });
  const c1 = r1.ok ? r1.ledger.items.find((i) => i.item_id === "cap-c") : undefined;
  ok(c1 !== undefined && c1.design_coverage.state !== "已核对", "⑨a ref 指向**不存在的文件** ⇒ 不判「已核对」", c1?.design_coverage);

  // ref 指向真实文件（.工作台/design.md）+ 主章节 hash 正确 ⇒ 可「已核对」
  write(path.join(cRoot, ".工作台", "design.md"), mkDesign(".工作台/design.md#3.5", hash35));
  activateBaseline(COV, { approved_by: "user", approval_basis: "审定2", approval_kind: "user_confirmed" }, dataDir);
  const r2 = readFeatureLedger(COV, dataDir, { document: "current" }, { project_exists: () => true, code_revision: CODE_REV });
  const c2 = r2.ok ? r2.ledger.items.find((i) => i.item_id === "cap-c") : undefined;
  ok(c2?.design_coverage.state === "已核对" && c2.design_coverage.review.verified, "⑨b ref 可定位 + hash 匹配 ref 主章节 + 基线已批准 ⇒ 「已核对」", c2?.design_coverage);

  // hash 拿**另一章节**（§4.2）凑数 ⇒ ref 指 §3.5，主章节 hash 不匹配 ⇒ 源变待复核
  const hash42 = buildSectionIndex(`# 设计\n\n${sec2}`).find((s) => s.title.startsWith("4.2 "))!.sha256;
  write(path.join(cRoot, ".工作台", "design.md"), mkDesign(".工作台/design.md#3.5", hash42));
  activateBaseline(COV, { approved_by: "user", approval_basis: "审定3", approval_kind: "user_confirmed" }, dataDir);
  const r3 = readFeatureLedger(COV, dataDir, { document: "current" }, { project_exists: () => true, code_revision: CODE_REV });
  const c3 = r3.ok ? r3.ledger.items.find((i) => i.item_id === "cap-c") : undefined;
  ok(c3 !== undefined && c3.design_coverage.state === "源变待复核", "⑨c hash 拿**别的章节**凑数 ⇒ 不算「已核对」（源变待复核）", c3?.design_coverage);

  // 任意 64hex（证据库里没有）⇒ 不判「已核对」
  write(path.join(cRoot, ".工作台", "design.md"), mkDesign("f".repeat(64), hash35));
  activateBaseline(COV, { approved_by: "user", approval_basis: "审定4", approval_kind: "user_confirmed" }, dataDir);
  const r4 = readFeatureLedger(COV, dataDir, { document: "current" }, { project_exists: () => true, code_revision: CODE_REV });
  const c4 = r4.ok ? r4.ledger.items.find((i) => i.item_id === "cap-c") : undefined;
  ok(c4 !== undefined && c4.design_coverage.state !== "已核对", "⑨d 任意 64hex（证据库里取不到）⇒ 不判「已核对」", c4?.design_coverage);
}

// ═══════════════════ ⑨′ 主章节归属（同根缺陷定向：ref 主章节必须属于声明的「设计章节」集合） ═══════════════════
// 缺陷（独审 probe-counterexamples CE-2/CE-3 复现）：声明 §3.5 而 ref=DESIGN.md#4.2、section_sha256=§4.2 现值时，
// 旧逻辑只比 ref 那一节 ⇒ 仍报「已核对」（声明节与哈希节可以不一致而不被发现）。修法：被审主章节必须
// **就是**本功能「设计章节」列声明集合中的一节（按解析后的精确章节身份，不靠标题包含/近似）；建立不了
// 主章节归属（声明节未定位 / ref 在别处定位不到 / ref 是证据哈希）时如实「待审」，不放行。
section("⑨′ 覆盖真实性定向：ref 主章节属于声明的章节集合才可「已核对」；无关节/未定位/证据哈希不放行");
{
  const covBody = ["# 设计", "", "### 3.5 主章节", "", "主章节正文。", "", "### 4.2 另一章节", "", "另一章节正文。", ""].join("\n");
  const covSections = sectionsOf(covBody);
  const covHash = (anchor: string): string => {
    const s = covSections.find((x) => x.title.startsWith(anchor + " "));
    if (s === undefined) throw new Error(`夹具章节 ${anchor} 没定位到`);
    return s.sha256;
  };
  const covDesign = (sectionsCell: string, review: string): string =>
    [
      covBody.replace(/\n$/, ""),
      "",
      "#### 功能清单声明（夹具）",
      "",
      DECL_HEAD[0],
      DECL_HEAD[1],
      `| cap-cov | 覆盖定向功能 |  | ${sectionsCell} | cap-cov | 已核对 | ${review} | 场景 |`,
      "",
    ].join("\n");
  const covBuild = (sectionsCell: string, review: string, o: { approved?: boolean; evidence?: boolean } = {}) =>
    buildFeatureItems({
      design_text: covDesign(sectionsCell, review),
      plan_text: null,
      plan_map: { found: false, rows: [], issues: [] },
      requirements: { requirements: {} } as never,
      feature_status: {},
      feature_acceptance: {},
      feature_has_run: {},
      feature_run_basis: {},
      task_fingerprints: {},
      sections: covSections,
      design_rel_path: "DESIGN.md",
      sections_of_file: (rel) => (rel === "DESIGN.md" ? covSections : null),
      evidence_exists: () => o.evidence ?? true,
      design_baseline_approved: o.approved ?? true,
      design_baseline_note: "夹具基线",
      source_revision: { design: "d".repeat(64), plan: null, plan_definition: null },
      ledger_last_seq: 0,
      scope_revision: "srev-cov",
      unregistered_candidates: [],
      pending_decisions: [],
      evidence_state_of: () => "missing",
    });
  const covOf = (r: ReturnType<typeof covBuild>) => r.items.find((i) => i.item_id === "cap-cov");

  // 正控制（真实 7 行合法形态：多声明章节，主章节在集合内、hash 一致、基线已批准）⇒ 已核对
  const pos = covBuild("§3.5、§4.2", `reviewer=审; ref=DESIGN.md#3.5; section_sha256=${covHash("3.5")}; gap=`);
  ok(
    covOf(pos)?.design_coverage.state === "已核对" && covOf(pos)?.design_coverage.review.verified === true,
    "⑨′a 正控制：多声明章节、主章节（ref §3.5）在集合内 + hash 一致 + 基线已批准 ⇒ 已核对",
    covOf(pos)?.design_coverage,
  );

  // 正控制：声明/ref 仅**语法**不同（`3.5` ↔ `§3.5`）但定位到同一节 ⇒ 仍已核对（按解析后章节身份，不按字面）
  const syn = covBuild("3.5", `reviewer=审; ref=DESIGN.md#§3.5; section_sha256=${covHash("3.5")}; gap=`);
  ok(
    covOf(syn)?.design_coverage.state === "已核对",
    "⑨′b 声明「3.5」/ ref「DESIGN.md#§3.5」语法不同但同一节 ⇒ 已核对（不靠字面包含）",
    covOf(syn)?.design_coverage,
  );

  // 负控制（原 CE-2 复现）：声明 §3.5，ref=DESIGN.md#4.2，section_sha256=§4.2 现值 ⇒ 待审，不借无关章节哈希
  const wrong = covBuild("§3.5", `reviewer=审; ref=DESIGN.md#4.2; section_sha256=${covHash("4.2")}; gap=`);
  ok(
    covOf(wrong)?.design_coverage.state === "待审",
    "⑨′c 负控制：ref 主章节（§4.2）不属于声明章节（§3.5）⇒ 待审（不借无关章节的哈希通过）",
    covOf(wrong)?.design_coverage,
  );
  ok(
    (covOf(wrong)?.design_coverage.review.unmet ?? "").includes("不属于本功能"),
    "⑨′c′ unmet 明确点名「不属于本功能声明的章节」",
    covOf(wrong)?.design_coverage.review.unmet,
  );

  // 负控制：声明章节定位不到（§9.9 不存在）⇒ 建立不了主章节归属 ⇒ 不得已核对（并报 SECTION_UNRESOLVED）
  const unres = covBuild("§9.9", `reviewer=审; ref=DESIGN.md#3.5; section_sha256=${covHash("3.5")}; gap=`);
  ok(
    covOf(unres) !== undefined &&
      covOf(unres)?.design_coverage.state !== "已核对" &&
      unres.issues.some((i) => i.code === "SECTION_UNRESOLVED"),
    "⑨′d 负控制：声明章节§9.9定位不到 ⇒ 不放行（且点名 SECTION_UNRESOLVED）",
    { state: covOf(unres)?.design_coverage.state, issues: unres.issues },
  );

  // 负控制：主章节**确属声明集合**、但 section_sha256 与现值不符（被声明主节源变）⇒ 源变待复核（保留原判据）
  const drift = covBuild("§3.5", `reviewer=审; ref=DESIGN.md#3.5; section_sha256=${"e".repeat(64)}; gap=`);
  ok(
    covOf(drift)?.design_coverage.state === "源变待复核",
    "⑨′e 负控制：主章节属声明集合但 hash 不符 ⇒ 源变待复核（未被此次修复改判据）",
    covOf(drift)?.design_coverage,
  );

  // 负控制：ref 指向**别的文档**（sections_of_file 返回 null）⇒ 建不了主章节归属 ⇒ 不得已核对
  const ext = covBuild("§3.5", `reviewer=审; ref=.工作台/other.md#3.5; section_sha256=${covHash("3.5")}; gap=`);
  ok(
    covOf(ext)?.design_coverage.state !== "已核对",
    "⑨′f 负控制：ref 在外部文档（定位不到）⇒ 不得「已核对」",
    covOf(ext)?.design_coverage,
  );

  // 证据哈希 ref 的**合法形态保留**（ref_kind=evidence、refOk 走证据存在性）但建立不了主章节 ⇒ 不判已核对
  const ev = covBuild("§3.5", `reviewer=审; ref=${"a".repeat(64)}; section_sha256=${covHash("3.5")}; gap=`, {
    evidence: true,
  });
  ok(
    covOf(ev)?.design_coverage.review.ref_kind === "evidence" && covOf(ev)?.design_coverage.state !== "已核对",
    "⑨′g 证据哈希 ref：形态与 ref_kind=evidence 保留，但建立不了声明主章节 ⇒ 不判「已核对」",
    covOf(ev)?.design_coverage,
  );

  // 负控制：ref 主章节在集合内、hash 也一致，但**基线未批准** ⇒ 仍待审（四条件之基线条件未被削弱）
  const noBase = covBuild("§3.5", `reviewer=审; ref=DESIGN.md#3.5; section_sha256=${covHash("3.5")}; gap=`, {
    approved: false,
  });
  ok(
    covOf(noBase)?.design_coverage.state === "待审",
    "⑨′h 负控制：基线未批准当前所读版本 ⇒ 待审（复算四条件之基线条件未被削弱）",
    covOf(noBase)?.design_coverage,
  );
}

// ═══════════════════ ⑩ 用户接受按范围（单卡 accepted ≠ 多卡功能 accepted） ═══════════════════
section("⑩ 用户接受按**范围**真实采信（单卡 ≠ 多卡；gate_ref 与判词对应）");
{
  const gate = (taskId: string, decision: string, key: string): void => {
    service.submit({
      schema_version: 2,
      project_id: PID,
      change_id: "chg-b2",
      actor_id: "fixture-user",
      role: "user",
      entity_id: `acceptance:${key}`,
      type: "audit.human_acceptance_recorded",
      expected_revision: null,
      idempotency_key: `audit.human_acceptance_recorded:${key}`,
      payload: {
        task_id: taskId,
        batch_id: null,
        decision,
        scenario_refs: [],
        baseline: { baseline_id: null, design_revision: null, plan_revision: null },
        evidence_refs: [],
        accepted_by: "fixture-user",
      },
    });
  };
  // cap-a 的成员是 V-1、V-2；只接受 V-1
  gate("V-1", "accept", "acc-v1");
  const r = readFeatureLedger(PID, dataDir, { document: "current" }, { project_exists: () => true, code_revision: CODE_REV });
  const cap = r.ok ? r.ledger.items.find((i) => i.item_id === "cap-a") : undefined;
  ok(cap?.user_acceptance.state === "pending", "⑩a 只有**单卡** accepted ⇒ 多卡功能仍 pending", cap?.user_acceptance);
  ok(cap?.user_acceptance.accepted_tasks.join("、") === "V-1", "⑩b 如实列出哪些成员已有 Gate", cap?.user_acceptance);
  gate("V-2", "accept", "acc-v2");
  const r2 = readFeatureLedger(PID, dataDir, { document: "current" }, { project_exists: () => true, code_revision: CODE_REV });
  const cap2 = r2.ok ? r2.ledger.items.find((i) => i.item_id === "cap-a") : undefined;
  ok(cap2?.user_acceptance.state === "accepted", "⑩c 成员全部 accepted ⇒ 功能 accepted", cap2?.user_acceptance);
  ok(
    cap2?.user_acceptance.gate_ref !== null &&
      (cap2?.user_acceptance.gate_ref ?? "").includes("acc-v1") &&
      (cap2?.user_acceptance.gate_ref ?? "").includes("acc-v2"),
    "⑩d gate_ref **与判词对应**（带真正支撑它的记录，不是「随便第一条」）",
    cap2?.user_acceptance,
  );
}

// ═══════════════════ ⑪ 错误语义（400/404/409/422/503） ═══════════════════
section("⑪ 错误语义：400 / 404 / 409 / 422 / 503（读失败不返回空成功）");
{
  const bad = readFeatureLedger(PID, dataDir, parseFeatureLedgerParams({ limit: 0 }) as never, { project_exists: () => true });
  ok(!bad.ok && bad.status === 400, "⑪a limit 越界 ⇒ 400（parse 已拦，此处直传）", bad);
  const nf = readFeatureLedger("nope", dataDir, {}, { project_exists: () => false });
  ok(!nf.ok && nf.status === 404 && nf.code === "PROJECT_NOT_FOUND", "⑪b 项目不存在 ⇒ 404");
  const pr = packageRevisionOf({ design: "x", plan: "y", plan_definition: null, ledger_last_seq: 1, scope_id: null, scope_revision: "s", artifact_ref: null, source_readings: "z" });
  const rc = readFeatureLedger(PID, dataDir, { expected_revision: pr }, { project_exists: () => true });
  ok(!rc.ok && rc.status === 409 && rc.code === "REVISION_CHANGED", "⑪c expected_revision 不符 ⇒ 409 REVISION_CHANGED", rc);
  const rc2 = readFeatureLedger(PID, dataDir, { cursor: encodeCursor({ v: 1, package_revision: pr, offset: 1 }) }, { project_exists: () => true });
  ok(!rc2.ok && rc2.status === 409, "⑪d 游标跨包版本 ⇒ 409（不静默返回跨版本数据）", rc2);
  // 声明区缺列 ⇒ 422
  const PID3 = "fl-bad-decl";
  const root3 = path.join(tmpBase, PID3);
  fs.mkdirSync(path.join(root3, ".工作台"), { recursive: true });
  write(path.join(root3, ".工作台", "design.md"), "# 坏\n\n#### 功能清单声明\n\n| 功能 ID | 人话功能名 |\n| --- | --- |\n| cap-a | A |\n");
  addProject({ id: PID3, name: "坏", path: root3, kind: "backend" }, dataDir);
  const r3 = readFeatureLedger(PID3, dataDir, {}, { project_exists: () => true });
  ok(!r3.ok && r3.status === 422 && r3.code === "SOURCE_INVALID", "⑪e 声明区缺列 ⇒ 422 SOURCE_INVALID（**不返回空成功**）", r3);
  // 图纸源是**目录** ⇒ 读图纸抛错 ⇒ 503（且不返回空成功）
  const PID4 = "fl-unreadable";
  const root4 = path.join(tmpBase, PID4);
  fs.mkdirSync(path.join(root4, ".工作台", "design.md"), { recursive: true });
  addProject({ id: PID4, name: "读不动", path: root4, kind: "backend" }, dataDir);
  const r4 = readFeatureLedger(PID4, dataDir, { document: "current" }, { project_exists: () => true });
  ok(!r4.ok && r4.status === 503 && r4.code === "SOURCE_UNAVAILABLE", "⑪f 来源读失败 ⇒ 503 SOURCE_UNAVAILABLE（**不回空成功**）", r4);
}

// ═══════════════════ ⑫ MCP 工具面 ═══════════════════
section("⑫ MCP feature_ledger 注册与等价");
{
  ok(TOOLS.some((t) => t.name === "feature_ledger"), "⑫a 注册表含 feature_ledger");
  const r = await featureLedgerTool.handler({ project_id: PID, scope: "current" });
  const parsed = JSON.parse(r.content[0].text) as { ok: boolean; ledger?: { package_revision: string; items: unknown[] } };
  const direct = readFeatureLedger(PID, dataDir, { scope: "current" }, { project_exists: (id) => id === PID });
  ok(
    parsed.ok === true && direct.ok === true && parsed.ledger?.package_revision === direct.ledger.package_revision,
    "⑫b MCP 与直接调用**同底层**（package_revision 一致）",
  );
  const bad = await featureLedgerTool.handler({ project_id: PID, bogus: 1 });
  ok(bad.isError === true, "⑫c MCP 严格参数：未知键 ⇒ isError");
}

// ═══════════════════ ⑬ HTTP 读口（真实服务，隔离端口/数据目录） ═══════════════════
section("⑬ HTTP GET /api/projects/:id/feature-ledger（隔离端口，绝不用真实 8787）");
{
  const { spawn } = await import("node:child_process");
  const net = await import("node:net");
  const PORT = await new Promise<number | null>((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(null));
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const p = typeof addr === "object" && addr !== null ? addr.port : null;
      srv.close(() => resolve(p));
    });
  });
  if (PORT === null) {
    ok(false, "⑬ 拿不到空闲端口：不拿任何既有监听跑验证（绝不碰真实 8787）");
  } else {
    const BASE = `http://127.0.0.1:${PORT}`;
    const proc = spawn(process.execPath, ["--import", "tsx", path.join("src", "server", "index.ts")], {
      env: { ...process.env, TATAI_HOME: dataDir, TATAI_PORT: String(PORT) },
      stdio: ["ignore", "pipe", "pipe"],
      cwd: REPO_ROOT,
    });
    const waitUp = async (): Promise<boolean> => {
      for (let i = 0; i < 100; i++) {
        try {
          const r = await fetch(`${BASE}/health`);
          if (r.ok) return true;
        } catch {
          /* 还没起来 */
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      return false;
    };
    const up = await waitUp();
    ok(up, `⑬a 隔离服务启动（TATAI_HOME=临时夹具、TATAI_PORT=${PORT} 动态空闲端口）`);
    if (up) {
      const r = await fetch(`${BASE}/api/projects/${PID}/feature-ledger?scope=current&limit=50`);
      const body = (await r.json()) as { ok: boolean; ledger?: { package_revision: string; items: Array<{ item_id: string }> } };
      const direct = readFeatureLedger(PID, dataDir, { scope: "current", limit: 50 }, { project_exists: (id) => id === PID });
      ok(r.status === 200 && body.ok === true, "⑬b GET 返回 200 ok");
      ok(
        direct.ok && body.ledger?.package_revision === direct.ledger.package_revision,
        "⑬c HTTP 与直接派生**同底层同结果**（package_revision 一致）",
      );
      ok(
        (body.ledger?.items ?? []).some((i) => i.item_id === "pending:req-unmapped"),
        "⑬d HTTP 响应里未映射需求可见（pending:<requirement_id>）",
      );
      const rBad = await fetch(`${BASE}/api/projects/${PID}/feature-ledger?limit=0`);
      ok(rBad.status === 400, "⑬e HTTP 参数越界 ⇒ 400");
      const r404 = await fetch(`${BASE}/api/projects/no-such/feature-ledger`);
      ok(r404.status === 404, "⑬f 项目不存在 ⇒ 404", { status: r404.status, body: (await r404.text()).slice(0, 300) });
      const rArt = await fetch(`${BASE}/api/projects/${PID}/feature-ledger?artifact_ref=${"b".repeat(64)}`);
      ok(rArt.status === 422, "⑬g HTTP 未登记产物引用 ⇒ 422（与直接调用同判据）");
      const r503 = await fetch(`${BASE}/api/projects/fl-unreadable/feature-ledger?document=current`);
      ok(r503.status === 503, "⑬h HTTP 来源读失败 ⇒ 503（不回空成功）");
      const before = treeHashes(path.join(root, ".工作台"));
      await fetch(`${BASE}/api/projects/${PID}/feature-ledger`);
      ok(JSON.stringify(before) === JSON.stringify(treeHashes(path.join(root, ".工作台"))), "⑬i HTTP 读口零写入");
    }
    proc.kill();
    await new Promise((r) => setTimeout(r, 200));
  }
}

// ═══════════════════ ⑭ 包版本绑**源读数**（相关源码变而无新事件 ⇒ 旧包/游标 409） ═══════════════════
section("⑭ package_revision 绑本范围源读数：相关源码变（无新事件）⇒ 包版本变、旧游标 409；无关文件不连坐");
{
  const SRC = "fl-src";
  const sRoot = path.join(tmpBase, SRC);
  fs.mkdirSync(path.join(sRoot, ".工作台"), { recursive: true });
  const sPlan = [
    "# 施工图",
    "",
    "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |",
    "| --- | --- | --- | --- | --- |",
    "| V-1 | todo | 源读数夹具 |  | 证据齐 |",
    "",
    "### V-1 源读数夹具",
    "",
    "**设计依据**：§1。**依赖**：无。**文件责任**：`src/s.ts`。",
    "",
    "- [ ] **chk-v-1-01 源读数达标**",
    "",
  ].join("\n");
  write(path.join(sRoot, ".工作台", "plan.md"), sPlan);
  write(
    path.join(sRoot, ".工作台", "design.md"),
    [
      "# 设计书",
      "",
      "## 1 目标",
      "",
      "源读数夹具。",
      "",
      "#### 功能清单声明（夹具）",
      "",
      DECL_HEAD[0],
      DECL_HEAD[1],
      "| cap-s | 源读数功能 | req-s | §1 | cap-s | 待审 | reviewer=; ref=DESIGN.md#1; section_sha256=x; gap=x | 场景 |",
      "",
    ].join("\n"),
  );
  write(path.join(sRoot, "src", "s.ts"), "export const s = 1;\n");
  addProject({ id: SRC, name: "源读数夹具", path: sRoot, kind: "backend" }, dataDir);
  registerRequirementFor(SRC, "req-s");
  submitDefinitionImports(service, {
    project_id: SRC,
    change_id: "chg-b2",
    actor_id: "fixture",
    role: "coordinator",
    definitions: importTaskDefinitions(sPlan, { plan_revision: sha256(sPlan) }).definitions,
  });
  const sWork = path.join(sRoot, ".工作台");
  const blob = putEvidence(path.join(sWork, "work"), {
    content: "源清单夹具",
    kind: "source_manifest",
    summary: "V-1 源清单",
    created_by: "fixture",
    role: "executor",
    binding: { revision_kind: "code", revision: sha256("placeholder") },
    source_manifest: [{ path: "src/s.ts" }],
  });
  const manifestFp = blob.source_manifest?.fingerprint ?? "";
  recordCheckWith(SRC, "V-1", "chk-v-1-01", "pass", "s-01", manifestFp, blob.sha256);
  const r1 = readFeatureLedger(SRC, dataDir, { document: "current" }, { project_exists: () => true, code_revision: manifestFp });
  const pkg1 = r1.ok ? r1.ledger.package_revision : "";
  ok(r1.ok && pkg1.length === 64, "⑭a 夹具读口 200 且拿到包版本", r1.ok ? r1.ledger.package_revision_basis : r1);
  // 无关文件变动（不在任何清单里）⇒ 包版本不变（不连坐）
  write(path.join(sRoot, "src", "unrelated.ts"), "export const u = 1;\n");
  const r2 = readFeatureLedger(SRC, dataDir, { document: "current" }, { project_exists: () => true, code_revision: manifestFp });
  ok(r2.ok && r2.ledger.package_revision === pkg1, "⑭b **无关文件**变动 ⇒ 包版本不变（不连坐）", {
    a: pkg1,
    b: r2.ok ? r2.ledger.package_revision : r2,
  });
  // 相关源码变动（在清单里）+ **不产生任何事件** ⇒ 源读数变 ⇒ 包版本变、旧游标 409
  write(path.join(sRoot, "src", "s.ts"), "export const s = 2;\n");
  const r3 = readFeatureLedger(SRC, dataDir, { document: "current" }, { project_exists: () => true, code_revision: manifestFp });
  ok(r3.ok && r3.ledger.package_revision !== pkg1, "⑭c 相关源码变（**无新事件**）⇒ 包版本变（源读数进包版本身份）", {
    a: pkg1,
    b: r3.ok ? r3.ledger.package_revision : r3,
  });
  const stale = readFeatureLedger(
    SRC,
    dataDir,
    { document: "current", cursor: encodeCursor({ v: 1, package_revision: pkg1, offset: 0 }) },
    { project_exists: () => true, code_revision: manifestFp },
  );
  ok(!stale.ok && stale.status === 409, "⑭d 相关源码变后**旧游标 409**（不静默返回跨版本数据）", stale);
}

// ═══════════════════ ⑮ 记录级定义绑定（真实事件）：旧 pass → 定义变（无代码变）⇒ 当前非 pass ═══════════════════
section("⑮ 逐条 check 的真实定义绑定（record_ref→seq→当时不可变定义）＋ 旧位置重排／不连坐");

{
  const BIND = "fl-binding";
  const bRoot = path.join(tmpBase, BIND);
  fs.mkdirSync(path.join(bRoot, ".工作台"), { recursive: true });
  const d1Plan = [
    "# 施工图（绑定夹具 D1）",
    "",
    "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |",
    "| --- | --- | --- | --- | --- |",
    "| V-D | todo | 定义绑定夹具 |  | 证据齐 |",
    "| V-E | todo | 不连坐夹具 |  | 证据齐 |",
    "",
    "### V-D 定义绑定夹具",
    "",
    "**设计依据**：§3.5。**依赖**：无。**文件责任**：`src/d.ts`。",
    "",
    "- [ ] **chk-v-d-01 甲项**",
    "",
    "### V-E 不连坐夹具",
    "",
    "**设计依据**：§3.5。**依赖**：无。**文件责任**：`src/e.ts`。",
    "",
    "- [ ] **chk-v-e-01 戊项**",
    "",
  ].join("\n");
  write(path.join(bRoot, ".工作台", "plan.md"), d1Plan);
  write(path.join(bRoot, ".工作台", "design.md"), "# 设计书\n\n### 3.5 目标章节\n\n正文。\n");
  addProject({ id: BIND, name: "定义绑定夹具", path: bRoot, kind: "backend" }, dataDir);
  submitDefinitionImports(service, {
    project_id: BIND,
    change_id: "chg-import",
    actor_id: "fixture",
    role: "coordinator",
    definitions: importTaskDefinitions(d1Plan, { plan_revision: sha256(d1Plan) }).definitions,
  });
  // D1 的不可变快照（记录时点的定义来源）——**先**存快照，再记检查
  activateBaseline(BIND, { approved_by: "user", approval_basis: "D1 审定", approval_kind: "user_confirmed" }, dataDir);
  recordCheck(BIND, "V-D", "chk-v-d-01", "pass", "b-d-01");
  recordCheck(BIND, "V-E", "chk-v-e-01", "pass", "b-e-01");
  // D2：**同 stableID 改语义**（chk-v-d-01 正文变），V-E 一字不改；code binding 不变（仍是 CODE_REV）
  const d2Plan = d1Plan.replace("**chk-v-d-01 甲项**", "**chk-v-d-01 甲项（语义已改）**");
  write(path.join(bRoot, ".工作台", "plan.md"), d2Plan);
  submitDefinitionImports(service, {
    project_id: BIND,
    change_id: "chg-import2",
    actor_id: "fixture",
    role: "coordinator",
    expected_revisions: { "V-D": 1 },
    definitions: importTaskDefinitions(d2Plan, { plan_revision: sha256(d2Plan), revisions: { "V-D": 2 } }).definitions.filter((d) => d.task_id === "V-D"),
  });

  const facts = collectProjectFacts(BIND, dataDir, { code_revision: CODE_REV });
  const events = eventsSnapshotOf(BIND, dataDir).events;
  const withoutEvents = deriveObligations({ project_id: BIND, data_dir: dataDir, facts, features: [] });
  const withEvents = deriveObligations({ project_id: BIND, data_dir: dataDir, facts, events, features: [] });

  ok(
    withoutEvents.projection.by_id["V-D"]?.passed_count === 1,
    "⑮a 反例基线（不带事件）：同 stableID 改了语义、code binding 不变 ⇒ 旧投影**仍判通过**（这就是要堵的洞）",
    { passed: withoutEvents.projection.by_id["V-D"]?.passed_count },
  );
  ok(
    withEvents.projection.by_id["V-D"]?.passed_count === 0,
    "⑮b **带事件** ⇒ 记录时点定义（D1）与当前定义（D2）语义不一致 ⇒ 该记录失效、当前非 pass",
    {
      passed: withEvents.projection.by_id["V-D"]?.passed_count,
      missing: withEvents.projection.by_id["V-D"]?.missing,
      bindings: withEvents.check_identity.definition_bindings,
    },
  );
  const vd = withEvents.check_identity.definition_bindings.find((b) => b.check_id === "chk-v-d-01");
  ok(
    vd?.verdict === "changed" && (vd.reason ?? "").includes("检查正文已改") && vd.record_seq !== null,
    "⑮c 定义绑定读数：verdict=changed、原因点名「检查正文已改」、带记录账本 seq（可追溯）",
    vd,
  );
  ok(
    withEvents.projection.by_id["V-E"]?.passed_count === 1 &&
      withEvents.check_identity.definition_bindings.find((b) => b.check_id === "chk-v-e-01")?.verdict === "match",
    "⑮d **别的卡定义变不连坐**：V-E 同定义 ⇒ 记录仍有效（match、仍通过）",
    withEvents.projection.by_id["V-E"]?.passed_count,
  );
}

{
  // 旧位置重排：position id 不变、该位置的内容变了 ⇒ 失效；同批里未被重排的卡不受影响。
  const REORD = "fl-reorder";
  const rRoot = path.join(tmpBase, REORD);
  fs.mkdirSync(path.join(rRoot, ".工作台"), { recursive: true });
  const p1 = [
    "# 施工图（重排夹具 P1）",
    "",
    "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |",
    "| --- | --- | --- | --- | --- |",
    "| V-R | todo | 重排夹具 |  | 证据齐 |",
    "| V-S | todo | 未重排夹具 |  | 证据齐 |",
    "",
    "### V-R 重排夹具",
    "",
    "**设计依据**：§3.5。**依赖**：无。**文件责任**：`src/r.ts`。",
    "",
    "- [ ] 甲项",
    "- [ ] 乙项",
    "",
    "### V-S 未重排夹具",
    "",
    "**设计依据**：§3.5。**依赖**：无。**文件责任**：`src/s.ts`。",
    "",
    "- [ ] 丙项",
    "",
  ].join("\n");
  write(path.join(rRoot, ".工作台", "plan.md"), p1);
  write(path.join(rRoot, ".工作台", "design.md"), "# 设计书\n\n### 3.5 目标章节\n\n正文。\n");
  addProject({ id: REORD, name: "重排夹具", path: rRoot, kind: "backend" }, dataDir);
  submitDefinitionImports(service, {
    project_id: REORD,
    change_id: "chg-import3",
    actor_id: "fixture",
    role: "coordinator",
    definitions: importTaskDefinitions(p1, { plan_revision: sha256(p1) }).definitions,
  });
  activateBaseline(REORD, { approved_by: "user", approval_basis: "P1 审定", approval_kind: "user_confirmed" }, dataDir);
  recordCheck(REORD, "V-R", "V-R::check:0", "pass", "r-0");
  recordCheck(REORD, "V-S", "V-S::check:0", "pass", "s-0");
  const p2 = p1.replace("- [ ] 甲项\n- [ ] 乙项", "- [ ] 乙项\n- [ ] 甲项");
  write(path.join(rRoot, ".工作台", "plan.md"), p2);
  submitDefinitionImports(service, {
    project_id: REORD,
    change_id: "chg-import4",
    actor_id: "fixture",
    role: "coordinator",
    expected_revisions: { "V-R": 1 },
    definitions: importTaskDefinitions(p2, { plan_revision: sha256(p2), revisions: { "V-R": 2 } }).definitions.filter((d) => d.task_id === "V-R"),
  });
  const facts = collectProjectFacts(REORD, dataDir, { code_revision: CODE_REV });
  const events = eventsSnapshotOf(REORD, dataDir).events;
  const noEv = deriveObligations({ project_id: REORD, data_dir: dataDir, facts, features: [] });
  const ev = deriveObligations({ project_id: REORD, data_dir: dataDir, facts, events, features: [] });
  ok(
    noEv.projection.by_id["V-R"]?.passed_count === 1,
    "⑮e 反例基线（不带事件）：旧位置重排后位置 id 仍存在 ⇒ 旧投影**仍判通过**",
    { passed: noEv.projection.by_id["V-R"]?.passed_count },
  );
  ok(
    ev.projection.by_id["V-R"]?.passed_count === 0,
    "⑮f **带事件** ⇒ 位置 0 当时是「甲项」、当前是「乙项」⇒ 该记录失效、当前非 pass（旧位置重排不得继承）",
    { passed: ev.projection.by_id["V-R"]?.passed_count, bindings: ev.check_identity.definition_bindings },
  );
  ok(
    ev.projection.by_id["V-S"]?.passed_count === 1,
    "⑮g 同批未被重排的卡不受影响（V-S 仍通过）",
    ev.projection.by_id["V-S"]?.passed_count,
  );
}

// ═══════════════════ ⑯ 产物选择：真的解析到某一版并据此收窄证据（不是 echo 字符串） ═══════════════════
section("⑯ 产物选择：唯一绑定 ⇒ 按绑定收窄本次采信；不同绑定不互相借结论；绑不定 ⇒ 明示未知");

{
  const ART = "fl-artifact";
  const aRoot = path.join(tmpBase, ART);
  fs.mkdirSync(path.join(aRoot, ".工作台"), { recursive: true });
  const aPlan = [
    "# 施工图",
    "",
    "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |",
    "| --- | --- | --- | --- | --- |",
    "| V-1 | todo | 功能 A |  | 证据齐 |",
    "",
    "### V-1 功能 A",
    "",
    "**设计依据**：§3.5。**依赖**：无。**文件责任**：`src/a.ts`。",
    "",
    "- [ ] **chk-art-01 达标**",
    "",
    "| 功能 ID | 人话功能名 | 承接卡 | 必需检查 | 集成检查 | 结果状态 |",
    "| --- | --- | --- | --- | --- | --- |",
    "| cap-art | 功能 A | V-1 | chk-art-01 | int-art-01 | 未验 |",
    "",
    "## 集成检查要求",
    "",
    "| 对象 ID | 检查 ID | 说明 | 必需性 |",
    "| --- | --- | --- | --- |",
    "| cap-art | int-art-01 | 端到端集成 | 必需 |",
    "",
  ].join("\n");
  write(path.join(aRoot, ".工作台", "plan.md"), aPlan);
  write(path.join(aRoot, ".工作台", "design.md"), "# 设计书\n\n### 3.5 目标章节\n\n正文。\n");
  addProject({ id: ART, name: "产物夹具", path: aRoot, kind: "backend" }, dataDir);
  registerRequirementFor(ART, "req-a");
  submitDefinitionImports(service, {
    project_id: ART,
    change_id: "chg-art",
    actor_id: "fixture",
    role: "coordinator",
    definitions: importTaskDefinitions(aPlan, { plan_revision: sha256(aPlan) }).definitions,
  });
  activateBaseline(ART, { approved_by: "user", approval_basis: "夹具审定", approval_kind: "user_confirmed" }, dataDir);
  const aDesignRaw = fs.readFileSync(path.join(aRoot, ".工作台", "design.md"), "utf8");
  const aSect = sectionsOf(aDesignRaw).find((s) => s.title.startsWith("3.5 "))!;
  write(
    path.join(aRoot, ".工作台", "design.md"),
    `# 设计书\n\n### 3.5 目标章节\n\n正文。\n\n#### 功能清单声明（夹具）\n\n${DECL_HEAD[0]}\n${DECL_HEAD[1]}\n| cap-art | 功能 A | req-a | §3.5 | cap-art | 待审 | reviewer=r; ref=DESIGN.md#3.5; section_sha256=${aSect.sha256}; gap=x | 场景 |\n`,
  );
  activateBaseline(ART, { approved_by: "user", approval_basis: "夹具审定2", approval_kind: "user_confirmed" }, dataDir);

  const REV_A = sha256("artifact-rev-A");
  const REV_B = sha256("artifact-rev-B");
  const REV_C = sha256("artifact-rev-C");
  const aWork = path.join(aRoot, ".工作台", "work");
  const blobOf = (label: string, rev: string): string =>
    putEvidence(aWork, {
      content: `产物夹具证据 ${label}`,
      kind: "self_check",
      summary: label,
      created_by: "fixture",
      role: "executor",
      binding: { revision_kind: "code", revision: rev },
    }).sha256;
  const eA = blobOf("产物 A（revA）", REV_A);
  const eB = blobOf("产物 B（revB）", REV_B);
  const eI = blobOf("集成证据（revB）", REV_B);
  const eOrphan = blobOf("无人引用的产物", REV_B);
  // 同一条检查的两个**不同绑定产物**：A 失败、B 通过
  recordCheckWith(ART, "V-1", "chk-art-01", "fail", "a-fail", REV_A, eA);
  recordCheckWith(ART, "V-1", "chk-art-01", "pass", "a-pass", REV_B, eB);
  recordCheckWith(ART, "cap-art", "int-art-01", "pass", "a-int", REV_B, eI);

  const capOf = (r: ReturnType<typeof readFeatureLedger>): FeatureItem | undefined =>
    r.ok ? r.ledger.items.find((i) => i.item_id === "cap-art") : undefined;
  const base = readFeatureLedger(ART, dataDir, { document: "current" }, { project_exists: () => true, code_revision: REV_B });
  ok(capOf(base)?.verification.display_status === "verified", "⑯a 不选产物：按当前 code 修订（revB）判 ⇒ verified", capOf(base)?.verification);

  const selA = readFeatureLedger(
    ART,
    dataDir,
    { document: "current", artifact_ref: eA },
    { project_exists: () => true, code_revision: REV_B },
  );
  ok(
    selA.ok && selA.ledger.artifact_selection?.bound_revision === REV_A && selA.ledger.artifact_selection?.revision_kind === "code",
    "⑯b 产物 A 解析到**唯一绑定**（code:revA）＋列出支撑记录",
    selA.ok ? selA.ledger.artifact_selection : selA,
  );
  ok(
    selA.ok && capOf(selA)?.verification.display_status !== "verified",
    "⑯c **选 A（失败产物）不得得到 B 的通过**：只采信绑到 revA 的检查 ⇒ 不绿",
    capOf(selA)?.verification,
  );

  const selB = readFeatureLedger(
    ART,
    dataDir,
    { document: "current", artifact_ref: eB },
    { project_exists: () => true, code_revision: REV_B },
  );
  ok(
    selB.ok && selB.ledger.artifact_selection?.bound_revision === REV_B && capOf(selB)?.verification.display_status === "verified",
    "⑯d 选 B（通过产物）⇒ 只采信绑到 revB 的检查 ⇒ verified（A/B 不互相借结论）",
    selB.ok ? { sel: selB.ledger.artifact_selection, v: capOf(selB)?.verification } : selB,
  );

  const orphan = readFeatureLedger(
    ART,
    dataDir,
    { document: "current", artifact_ref: eOrphan },
    { project_exists: () => true, code_revision: REV_B },
  );
  ok(
    orphan.ok && orphan.ledger.state === "not_derived" && (orphan.ledger.reason ?? "").includes("无法唯一绑定"),
    "⑯e 已登记但**没有检查记录引用**的产物 ⇒ 200 not_derived 明示未知（不借当前所有检查/验收）",
    orphan.ok ? { state: orphan.ledger.state, reason: orphan.ledger.reason, artifact: orphan.ledger.artifact_selection } : orphan,
  );

  const laterC = readFeatureLedger(
    ART,
    dataDir,
    { document: "current", artifact_ref: eA },
    { project_exists: () => true, code_revision: REV_C },
  );
  ok(
    laterC.ok && laterC.ledger.artifact_selection?.bound_revision === REV_A && capOf(laterC)?.verification.display_status !== "verified",
    "⑯f **当前源码后来变成 revC 也不回改历史产物 A 的当时绑定**（binding 是记录时声明，不是现值）",
    laterC.ok ? laterC.ledger.artifact_selection : laterC,
  );

  const unregistered = readFeatureLedger(
    ART,
    dataDir,
    { document: "current", artifact_ref: "b".repeat(64) },
    { project_exists: () => true, code_revision: REV_B },
  );
  ok(!unregistered.ok && unregistered.status === 422, "⑯g 未登记的产物引用仍是 422（登记是前置，不是绑定）", unregistered);

  const reorderDiff = readFeatureLedger(
    ART,
    dataDir,
    { document: "current", artifact_ref: eB },
    { project_exists: () => true, code_revision: REV_B },
  );
  ok(
    reorderDiff.ok && reorderDiff.ledger.package_revision !== (base.ok ? base.ledger.package_revision : ""),
    "⑯h 换产物选择 ⇒ 换包版本身份（旧游标失效）",
    { a: base.ok ? base.ledger.package_revision : base, b: reorderDiff.ok ? reorderDiff.ledger.package_revision : reorderDiff },
  );
}

// ═══════════════════ ⑰ 历史版本重建：扫全流水找配套、事件裁到当时、歧义明示不猜 ═══════════════════
section("⑰ 历史／被取代版本：配套材料齐 ⇒ 实际重建且**不借当前结果**；同设计多施工图 ⇒ 歧义明示");

{
  const HIST = "fl-hist";
  const hRoot = path.join(tmpBase, HIST);
  fs.mkdirSync(path.join(hRoot, ".工作台"), { recursive: true });
  const d1 = "# 设计书\n\n### 3.5 目标章节\n\n正文。\n";
  const p1 = [
    "# 施工图（H1）",
    "",
    "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |",
    "| --- | --- | --- | --- | --- |",
    "| V-1 | todo | 历史夹具 |  | 证据齐 |",
    "",
    "### V-1 历史夹具",
    "",
    "**设计依据**：§3.5。**依赖**：无。**文件责任**：`src/h.ts`。",
    "",
    "- [ ] **chk-h-01 达标**",
    "",
    "| 功能 ID | 人话功能名 | 承接卡 | 必需检查 | 集成检查 | 结果状态 |",
    "| --- | --- | --- | --- | --- | --- |",
    "| cap-h | 历史功能 | V-1 | chk-h-01 |  | 未验 |",
    "",
  ].join("\n");
  write(path.join(hRoot, ".工作台", "design.md"), d1);
  write(path.join(hRoot, ".工作台", "plan.md"), p1);
  addProject({ id: HIST, name: "历史夹具", path: hRoot, kind: "backend" }, dataDir);
  registerRequirementFor(HIST, "req-h");
  const hSect1 = sectionsOf(d1).find((s) => s.title.startsWith("3.5 "))!;
  const d1Decl = `# 设计书\n\n### 3.5 目标章节\n\n正文。\n\n#### 功能清单声明（夹具）\n\n${DECL_HEAD[0]}\n${DECL_HEAD[1]}\n| cap-h | 历史功能 | req-h | §3.5 | cap-h | 待审 | reviewer=r; ref=DESIGN.md#3.5; section_sha256=${hSect1.sha256}; gap=x | 场景 |\n`;
  write(path.join(hRoot, ".工作台", "design.md"), d1Decl);
  submitDefinitionImports(service, {
    project_id: HIST,
    change_id: "chg-hist-1",
    actor_id: "fixture",
    role: "coordinator",
    definitions: importTaskDefinitions(p1, { plan_revision: sha256(p1) }).definitions,
  });
  activateBaseline(HIST, { approved_by: "user", approval_basis: "H1 审定", approval_kind: "user_confirmed" }, dataDir);
  const D1_SHA = sha256Hex(d1Decl);
  recordCheck(HIST, "V-1", "chk-h-01", "pass", "h-01");
  // 版本前进：设计改（hash 变）＋ 施工图改 ⇒ 新基线；此后的事件不属于 H1 的在效窗口
  const d2Decl = d1Decl.replace("正文。", "正文（二代）。");
  const p2 = p1.replace("**chk-h-01 达标**", "**chk-h-01 达标**").replace("# 施工图（H1）", "# 施工图（H2）");
  write(path.join(hRoot, ".工作台", "design.md"), d2Decl);
  write(path.join(hRoot, ".工作台", "plan.md"), p2);
  submitDefinitionImports(service, {
    project_id: HIST,
    change_id: "chg-hist-2",
    actor_id: "fixture",
    role: "coordinator",
    expected_revisions: { "V-1": 1 },
    definitions: importTaskDefinitions(p2, { plan_revision: sha256(p2), revisions: { "V-1": 2 } }).definitions.filter(
      (d) => d.task_id === "V-1",
    ),
  });
  activateBaseline(HIST, { approved_by: "user", approval_basis: "H2 审定", approval_kind: "user_confirmed" }, dataDir);
  registerRequirementFor(HIST, "req-h2"); // **晚于 H1 在效窗口**：H1 读数不得看见它

  const cur = readFeatureLedger(HIST, dataDir, { document: "current" }, { project_exists: () => true, code_revision: CODE_REV });
  ok(
    cur.ok && cur.ledger.coverage.registered_requirement_count === 2,
    "⑰a 现行读数看得到后来登记的第二条需求（registered=2）",
    cur.ok ? cur.ledger.coverage : cur,
  );
  const hist = readFeatureLedger(
    HIST,
    dataDir,
    { document: D1_SHA },
    { project_exists: () => true, code_revision: CODE_REV },
  );
  ok(
    hist.ok && hist.ledger.state === "ok" && hist.ledger.document_selection.mode === "revision",
    "⑰b 有配套材料的旧版**实际重建**（mode=revision；不永久占位）",
    hist.ok ? hist.ledger.document_selection : hist,
  );
  ok(
    hist.ok && hist.ledger.coverage.registered_requirement_count === 1,
    "⑰c 历史读数**按当时裁事件**：看不到 H1 之后登记的需求（不借当前结果）",
    hist.ok ? { coverage: hist.ledger.coverage, basis: hist.ledger.package_revision_basis } : hist,
  );
  ok(
    hist.ok && hist.ledger.package_revision_basis.some((b) => b.startsWith("history_cut_events:")),
    "⑰d 包版本显式带历史裁切读数（可核对本次读的是哪一段事实）",
    hist.ok ? hist.ledger.package_revision_basis : hist,
  );
}

{
  // 同设计哈希 + 不同施工图 ⇒ 歧义，明示候选、不猜
  const AMB = "fl-amb";
  const mRoot = path.join(tmpBase, AMB);
  fs.mkdirSync(path.join(mRoot, ".工作台"), { recursive: true });
  const dOnly = "# 设计书\n\n### 3.5 目标章节\n\n正文。\n";
  const mkPlan = (tag: string): string =>
    [
      `# 施工图（${tag}）`,
      "",
      "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |",
      "| --- | --- | --- | --- | --- |",
      "| V-1 | todo | 歧义夹具 |  | 证据齐 |",
      "",
      "### V-1 歧义夹具",
      "",
      "**设计依据**：§3.5。**依赖**：无。**文件责任**：`src/m.ts`。",
      "",
      "- [ ] **chk-m-01 达标**",
      "",
    ].join("\n");
  write(path.join(mRoot, ".工作台", "design.md"), dOnly);
  write(path.join(mRoot, ".工作台", "plan.md"), mkPlan("M1"));
  addProject({ id: AMB, name: "歧义夹具", path: mRoot, kind: "backend" }, dataDir);
  submitDefinitionImports(service, {
    project_id: AMB,
    change_id: "chg-amb-1",
    actor_id: "fixture",
    role: "coordinator",
    definitions: importTaskDefinitions(mkPlan("M1"), { plan_revision: sha256(mkPlan("M1")) }).definitions,
  });
  activateBaseline(AMB, { approved_by: "user", approval_basis: "M1 审定", approval_kind: "user_confirmed" }, dataDir);
  write(path.join(mRoot, ".工作台", "plan.md"), mkPlan("M2"));
  submitDefinitionImports(service, {
    project_id: AMB,
    change_id: "chg-amb-2",
    actor_id: "fixture",
    role: "coordinator",
    expected_revisions: { "V-1": 1 },
    definitions: importTaskDefinitions(mkPlan("M2"), { plan_revision: sha256(mkPlan("M2")), revisions: { "V-1": 2 } }).definitions.filter(
      (d) => d.task_id === "V-1",
    ),
  });
  activateBaseline(AMB, { approved_by: "user", approval_basis: "M2 审定", approval_kind: "user_confirmed" }, dataDir);
  const amb = readFeatureLedger(AMB, dataDir, { document: sha256Hex(dOnly) }, { project_exists: () => true, code_revision: CODE_REV });
  ok(
    amb.ok && amb.ledger.state === "not_derived" && (amb.ledger.reason ?? "").includes("多条不同施工图"),
    "⑰e 同设计哈希配**多条不同施工图** ⇒ not_derived 明示候选（不猜第一条）",
    amb.ok ? { state: amb.ledger.state, reason: amb.ledger.reason } : amb,
  );
  const ambReleases = readBaselineLog(AMB, dataDir);
  ok(
    ambReleases.baselines.length >= 2 && ambReleases.corrupt.length === 0,
    "⑰f 歧义读**真的扫了整条基线流水**（readBaselineLog，不只生效基线）",
    ambReleases.baselines.map((b) => b.baseline_id),
  );
}

// ═══════════════════ ⑱ 逐 item 指纹与自身 scope（WATCH 11:58 A/B） ═══════════════════
section("⑱ 逐卡定义指纹（递归稳定序列化）＋ 逐 item 自身 scope_revision");
{
  const FPA = "fl-fpA";
  const fpRoot = path.join(tmpBase, FPA);
  fs.mkdirSync(path.join(fpRoot, ".工作台"), { recursive: true });
  const fpPlan = (v1text: string, order: "ab" | "ba"): string =>
    [
      "# 施工图",
      "",
      "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |",
      "| --- | --- | --- | --- | --- |",
      "| V-1 | todo | 甲卡 |  | 证据齐 |",
      "| V-2 | todo | 乙卡 |  | 证据齐 |",
      "",
      "### V-1 甲卡",
      "",
      "**设计依据**：§1。**依赖**：无。**文件责任**：`src/f1.ts`。",
      "",
      ...(order === "ab"
        ? [`- [ ] **chk-f-01 ${v1text}**`, "- [ ] **chk-f-02 甲卡第二项**"]
        : ["- [ ] **chk-f-02 甲卡第二项**", `- [ ] **chk-f-01 ${v1text}**`]),
      "",
      "### V-2 乙卡",
      "",
      "**设计依据**：§1。**依赖**：无。**文件责任**：`src/f2.ts`。",
      "",
      "- [ ] **chk-f-03 乙卡第一项**",
      "- [ ] **chk-f-04 乙卡第二项**",
      "",
      "| 功能 ID | 人话功能名 | 承接卡 | 必需检查 | 集成检查 | 结果状态 |",
      "| --- | --- | --- | --- | --- | --- |",
      "| cap-fa | 甲功能 | V-1 | chk-f-01、chk-f-02 | int-fa-01 | 未验 |",
      "| cap-fb | 乙功能 | V-2 | chk-f-03、chk-f-04 | int-fb-01 | 未验 |",
      "",
      "## 集成检查要求",
      "",
      "| 对象 ID | 检查 ID | 说明 | 必需性 |",
      "| --- | --- | --- | --- |",
      "| cap-fa | int-fa-01 | 甲集成 | 必需 |",
      "| cap-fb | int-fb-01 | 乙集成 | 必需 |",
      "",
    ].join("\n");
  const fpDesign = [
    "# 设计书",
    "",
    "## 1 目标",
    "",
    "正文。",
    "",
    "#### 功能清单声明（夹具）",
    "",
    DECL_HEAD[0],
    DECL_HEAD[1],
    "| cap-fa | 甲功能 | req-fa | §1 | cap-fa | 待审 | reviewer=; ref=DESIGN.md#1; section_sha256=x; gap=x | 场景 |",
    "| cap-fb | 乙功能 | req-fb | §1 | cap-fb | 待审 | reviewer=; ref=DESIGN.md#1; section_sha256=x; gap=x | 场景 |",
    "",
  ].join("\n");
  write(path.join(fpRoot, ".工作台", "plan.md"), fpPlan("甲项", "ab"));
  write(path.join(fpRoot, ".工作台", "design.md"), fpDesign);
  addProject({ id: FPA, name: "指纹夹具", path: fpRoot, kind: "backend" }, dataDir);
  registerRequirementFor(FPA, "req-fa");
  registerRequirementFor(FPA, "req-fb");
  submitDefinitionImports(service, {
    project_id: FPA, change_id: "chg-fp1", actor_id: "fixture", role: "coordinator",
    definitions: importTaskDefinitions(fpPlan("甲项", "ab"), { plan_revision: sha256(fpPlan("甲项", "ab")) }).definitions,
  });
  const fpOf = (fid: string, tid: string): string | undefined => {
    const r = readFeatureLedger(FPA, dataDir, { document: "current" }, { project_exists: () => true, code_revision: CODE_REV });
    if (!r.ok) return undefined;
    const it = r.ledger.items.find((i) => i.item_id === fid);
    return it?.task_refs.find((t) => t.task_id === tid)?.definition_fingerprint;
  };
  const readItems = () => {
    const r = readFeatureLedger(FPA, dataDir, { document: "current" }, { project_exists: () => true, code_revision: CODE_REV });
    return r.ok ? r.ledger.items : [];
  };
  const fpV1a = fpOf("cap-fa", "V-1");
  const fpV2a = fpOf("cap-fa", "V-2");
  ok(
    typeof fpV1a === "string" && fpV1a.length === 64 && fpV1a !== fpV2a,
    "⑱a **同数量、不同定义**的两张卡 ⇒ 逐卡指纹不同（不是所有数组对象都变 {}，WATCH 11:58 A）",
    { V1: fpV1a, V2: fpV2a },
  );
  // 重排（同文本、交换顺序）⇒ 指纹不变
  write(path.join(fpRoot, ".工作台", "plan.md"), fpPlan("甲项", "ba"));
  submitDefinitionImports(service, {
    project_id: FPA, change_id: "chg-fp2", actor_id: "fixture", role: "coordinator",
    expected_revisions: { "V-1": 1 },
    definitions: importTaskDefinitions(fpPlan("甲项", "ba"), { plan_revision: sha256(fpPlan("甲项", "ba")), revisions: { "V-1": 2 } }).definitions.filter((d) => d.task_id === "V-1"),
  });
  ok(fpOf("cap-fa", "V-1") === fpV1a, "⑱b **重排不改指纹**（同定义语义身份安全保持）", { before: fpV1a, after: fpOf("cap-fa", "V-1") });
  // 同 stableID 改文本（数量不变）⇒ 指纹必变；别的卡不连坐
  write(path.join(fpRoot, ".工作台", "plan.md"), fpPlan("甲项（语义已改）", "ab"));
  submitDefinitionImports(service, {
    project_id: FPA, change_id: "chg-fp3", actor_id: "fixture", role: "coordinator",
    expected_revisions: { "V-1": 2 },
    definitions: importTaskDefinitions(fpPlan("甲项（语义已改）", "ab"), { plan_revision: sha256(fpPlan("甲项（语义已改）", "ab")), revisions: { "V-1": 3 } }).definitions.filter((d) => d.task_id === "V-1"),
  });
  ok(fpOf("cap-fa", "V-1") !== fpV1a, "⑱c **同 stableID 改语义（数量不变）⇒ 指纹必变**", { before: fpV1a, after: fpOf("cap-fa", "V-1") });
  ok(fpOf("cap-fa", "V-2") === fpV2a, "⑱d 别的卡定义变**不连坐**（V-2 指纹不变）", { before: fpV2a, after: fpOf("cap-fa", "V-2") });
  // B：逐 item 自身 scope_revision（默认无 scope 过滤下逐条不同，且等于唯一算法 scopeVersionOf）
  const items = readItems();
  const fa = items.find((i) => i.item_id === "cap-fa");
  const fb = items.find((i) => i.item_id === "cap-fb");
  ok(fa !== undefined && fb !== undefined && fa.scope_revision !== fb.scope_revision, "⑱e 默认多 feature：逐 item 自身 scope_revision 不同（不共享整清单版本，WATCH 11:58 B）", {
    fa: fa?.scope_revision,
    fb: fb?.scope_revision,
  });
  const fFacts = collectProjectFacts(FPA, dataDir, { code_revision: CODE_REV });
  const fObs = deriveObligations({ project_id: FPA, data_dir: dataDir, facts: fFacts, events: eventsSnapshotOf(FPA, dataDir).events, features: [] });
  const expectFa = scopeVersionOf({
    scope_id: "cap-fa", member_task_ids: ["V-1"], required_check_ids: ["chk-f-01", "chk-f-02"], integration_check_ids: ["int-fa-01"], task_checks: fObs.task_checks,
  }).scope_revision;
  ok(fa?.scope_revision === expectFa, "⑱f item.scope_revision = 唯一算法 scopeVersionOf(该功能自身 scope)（与六图/HTTP 同值口径）", { item: fa?.scope_revision, expect: expectFa });
}

// ═══════════════════ ⑲ 历史选版采**该版批准基线**（WATCH 11:58 C） ═══════════════════
section("⑲ 历史选版：旧 A 通过 / 当前 B 失败；以所选版本已批准基线核映射");
{
  const HM = "fl-histmap";
  const hmRoot = path.join(tmpBase, HM);
  fs.mkdirSync(path.join(hmRoot, ".工作台"), { recursive: true });
  const hmPlan = (tag: string): string =>
    [
      `# 施工图（${tag}）`,
      "",
      "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |",
      "| --- | --- | --- | --- | --- |",
      "| V-1 | todo | 映射夹具 |  | 证据齐 |",
      "",
      "### V-1 映射夹具",
      "",
      "**设计依据**：§1。**依赖**：无。**文件责任**：`src/hm.ts`。",
      "",
      "- [ ] **chk-hm-01 达标**",
      "",
      "| 功能 ID | 人话功能名 | 承接卡 | 必需检查 | 集成检查 | 结果状态 |",
      "| --- | --- | --- | --- | --- | --- |",
      "| cap-hm | 映射功能 | V-1 | chk-hm-01 | int-hm-01 | 未验 |",
      "",
      "## 集成检查要求",
      "",
      "| 对象 ID | 检查 ID | 说明 | 必需性 |",
      "| --- | --- | --- | --- |",
      "| cap-hm | int-hm-01 | 集成 | 必需 |",
      "",
    ].join("\n");
  const hmDesign = (body: string): string =>
    [
      "# 设计书",
      "",
      "## 1 目标",
      "",
      body,
      "",
      "#### 功能清单声明（夹具）",
      "",
      DECL_HEAD[0],
      DECL_HEAD[1],
      "| cap-hm | 映射功能 | req-hm | §1 | cap-hm | 待审 | reviewer=; ref=DESIGN.md#1; section_sha256=x; gap=x | 场景 |",
      "",
    ].join("\n");
  const designA = hmDesign("正文 A。");
  write(path.join(hmRoot, ".工作台", "design.md"), designA);
  write(path.join(hmRoot, ".工作台", "plan.md"), hmPlan("A"));
  addProject({ id: HM, name: "映射夹具", path: hmRoot, kind: "backend" }, dataDir);
  registerRequirementFor(HM, "req-hm");
  submitDefinitionImports(service, {
    project_id: HM, change_id: "chg-hm1", actor_id: "fixture", role: "coordinator",
    definitions: importTaskDefinitions(hmPlan("A"), { plan_revision: sha256(hmPlan("A")) }).definitions,
  });
  activateBaseline(HM, { approved_by: "user", approval_basis: "A 审定", approval_kind: "user_confirmed" }, dataDir);
  recordCheck(HM, "V-1", "chk-hm-01", "pass", "hm-01");
  recordCheck(HM, "cap-hm", "int-hm-01", "pass", "hm-int");
  const designASha = sha256Hex(designA);
  const planASha = sha256(hmPlan("A"));
  const rA = readFeatureLedger(HM, dataDir, { document: "active" }, { project_exists: () => true, code_revision: CODE_REV });
  ok(
    rA.ok && rA.ledger.items.find((i) => i.item_id === "cap-hm")?.verification.display_status === "verified",
    "⑲a 旧 A（已批准基线）**当时通过**（正例）",
    rA.ok ? rA.ledger.items.find((i) => i.item_id === "cap-hm")?.verification : rA,
  );
  // 版本前进到 B：设计/施工图都改，**但不激活** ⇒ 当前 B 未获批准、旧 A 仍是已批准历史
  write(path.join(hmRoot, ".工作台", "design.md"), hmDesign("正文 B。"));
  write(path.join(hmRoot, ".工作台", "plan.md"), hmPlan("B"));
  submitDefinitionImports(service, {
    project_id: HM, change_id: "chg-hm2", actor_id: "fixture", role: "coordinator",
    expected_revisions: { "V-1": 1 },
    definitions: importTaskDefinitions(hmPlan("B"), { plan_revision: sha256(hmPlan("B")), revisions: { "V-1": 2 } }).definitions.filter((d) => d.task_id === "V-1"),
  });
  const rB = readFeatureLedger(HM, dataDir, { document: "current" }, { project_exists: () => true, code_revision: CODE_REV });
  ok(
    rB.ok && rB.ledger.items.find((i) => i.item_id === "cap-hm")?.verification.display_status !== "verified",
    "⑲b 当前 B（未激活）**未获批准 ⇒ 不绿**（反例；不得把旧 A 的批准借给它）",
    rB.ok ? rB.ledger.items.find((i) => i.item_id === "cap-hm")?.verification : rB,
  );
  const rHist = readFeatureLedger(HM, dataDir, { document: designASha }, { project_exists: () => true, code_revision: CODE_REV });
  const histItem = rHist.ok ? rHist.ledger.items.find((i) => i.item_id === "cap-hm") : undefined;
  ok(
    rHist.ok && rHist.ledger.document_selection.mode === "revision" && histItem?.verification.display_status === "verified",
    "⑲c 选择历史 A ⇒ **仍按 A 当时的已批准基线**判 green（不借当前、也不被当前拒，WATCH 11:58 C）",
    rHist.ok ? { sel: rHist.ledger.document_selection, v: histItem?.verification } : rHist,
  );
  ok(
    rHist.ok && rHist.ledger.document_selection.plan_revision === planASha,
    "⑲d 历史 A 的施工图修订 = A 那版（显式历史，不混当前 B）",
    rHist.ok ? rHist.ledger.document_selection : rHist,
  );
}

// ═══════════════════ ⑳ 历史选版：非版本化来源不冒充历史（WATCH 11:58 D） ═══════════════════
section("⑳ 历史选版：待决/未登记候选来源不可重建 ⇒ 明示时态，不把现在的伪称历史");
{
  const HM2 = "fl-histcard";
  const hRoot2 = path.join(tmpBase, HM2);
  fs.mkdirSync(path.join(hRoot2, ".工作台"), { recursive: true });
  const hPlan = [
    "# 施工图",
    "",
    "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |",
    "| --- | --- | --- | --- | --- |",
    "| V-1 | todo | 历史来源夹具 |  | 证据齐 |",
    "",
    "### V-1 历史来源夹具",
    "",
    "**设计依据**：§1。**依赖**：无。**文件责任**：`src/hc.ts`。",
    "",
    "- [ ] **chk-hc-01 达标**",
    "",
  ].join("\n");
  const hDesign = ["# 设计书", "", "## 1 目标", "", "正文 A。", "", "#### 功能清单声明（夹具）", "", DECL_HEAD[0], DECL_HEAD[1],
    "| cap-hc | 历史来源功能 | req-hc | §1 | cap-hc | 待审 | reviewer=; ref=DESIGN.md#1; section_sha256=x; gap=x | 场景 |", ""].join("\n");
  write(path.join(hRoot2, ".工作台", "design.md"), hDesign);
  write(path.join(hRoot2, ".工作台", "plan.md"), hPlan);
  addProject({ id: HM2, name: "历史来源夹具", path: hRoot2, kind: "backend" }, dataDir);
  registerRequirementFor(HM2, "req-hc");
  submitDefinitionImports(service, {
    project_id: HM2, change_id: "chg-hc1", actor_id: "fixture", role: "coordinator",
    definitions: importTaskDefinitions(hPlan, { plan_revision: sha256(hPlan) }).definitions,
  });
  activateBaseline(HM2, { approved_by: "user", approval_basis: "A 审定", approval_kind: "user_confirmed" }, dataDir);
  const hDesignSha = sha256Hex(hDesign);
  // 版本前进（新基线），再补一条**当前**待议/待决（非版本化）来源
  write(path.join(hRoot2, ".工作台", "design.md"), hDesign.replace("正文 A。", "正文 B。"));
  activateBaseline(HM2, { approved_by: "user", approval_basis: "B 审定", approval_kind: "user_confirmed" }, dataDir);
  write(path.join(hRoot2, ".工作台", "design.discuss.md"), "# 待议\n\n- `讨论项-现行` 现行待决：是否纳入\n");
  const cur = readFeatureLedger(HM2, dataDir, { document: "current" }, { project_exists: () => true, code_revision: CODE_REV });
  ok(
    cur.ok && (cur.ledger.coverage.unregistered_candidate_count > 0 || cur.ledger.items.some((i) => i.pending_decisions.length > 0)),
    "⑳a 现行读数看得到当前待议/未登记候选（前置）",
    cur.ok ? { cand: cur.ledger.coverage.unregistered_candidate_count } : cur,
  );
  const hist = readFeatureLedger(HM2, dataDir, { document: hDesignSha }, { project_exists: () => true, code_revision: CODE_REV });
  const histItems = hist.ok ? hist.ledger.items : [];
  ok(
    hist.ok && histItems.every((i) => i.pending_decisions.length === 0) && hist.ledger.coverage.unregistered_candidate_count === 0,
    "⑳b 历史读数**不把现在的待决/补充伪称历史**（历史快照无这些来源 ⇒ 空，而非当前值）",
    hist.ok ? { cand: hist.ledger.coverage.unregistered_candidate_count } : hist,
  );
  ok(
    hist.ok &&
      hist.ledger.coverage.unexamined_sources.some(
        (u) => (u.ref.includes("discuss") || u.ref.includes("intent")) && /历史/.test(u.reason),
      ),
    "⑳c 无法重建的历史来源**明示时态/未读范围**（unexamined 点名，不静默当空）",
    hist.ok ? hist.ledger.coverage.unexamined_sources : hist,
  );
}

// ═══════════════════ ㉑ 稳定键定义 + 旧位置记录：复用「记录时点不可变定义」的 match（真实 V09-51 形态） ═══════════════════
section("㉑ 定义含 stable 键、记录仍是位置型 id：按**记录时点不可变定义**复用旧证据（真实 V09-51 形态）");
{
  const KC = "fl-stablekey";
  const kRoot = path.join(tmpBase, KC);
  fs.mkdirSync(path.join(kRoot, ".工作台"), { recursive: true });
  // 定义**从一开始**就带 stable 键（chk-*），但账本记录写的是**位置型** check_id（旧 parser 形态）
  const k1 = [
    "# 施工图（稳定键旧位置夹具 K1）",
    "",
    "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |",
    "| --- | --- | --- | --- | --- |",
    "| V-K | todo | 稳定键夹具 |  | 证据齐 |",
    "",
    "### V-K 稳定键夹具",
    "",
    "**设计依据**：§3.5。**依赖**：无。**文件责任**：`src/k.ts`。",
    "",
    "- [ ] **chk-v-k-01 甲项**",
    "- [ ] **chk-v-k-02 乙项**",
    "",
  ].join("\n");
  write(path.join(kRoot, ".工作台", "plan.md"), k1);
  write(path.join(kRoot, ".工作台", "design.md"), "# 设计书\n\n### 3.5 目标章节\n\n正文。\n");
  addProject({ id: KC, name: "稳定键夹具", path: kRoot, kind: "backend" }, dataDir);
  submitDefinitionImports(service, {
    project_id: KC,
    change_id: "chg-k1",
    actor_id: "fixture",
    role: "coordinator",
    definitions: importTaskDefinitions(k1, { plan_revision: sha256(k1) }).definitions,
  });
  activateBaseline(KC, { approved_by: "user", approval_basis: "K1 审定", approval_kind: "user_confirmed" }, dataDir);
  // 旧 parser 形态：定义正文带 stable 键，记录却写位置型 id（"<卡>::check:N"）——**没有**位置型历史定义
  recordCheck(KC, "V-K", "V-K::check:0", "pass", "k-0");
  recordCheck(KC, "V-K", "V-K::check:1", "pass", "k-1");
  const deriveK = () =>
    deriveObligations({
      project_id: KC,
      data_dir: dataDir,
      facts: collectProjectFacts(KC, dataDir, { code_revision: CODE_REV }),
      events: eventsSnapshotOf(KC, dataDir).events,
      features: [],
    });
  {
    const d = deriveK();
    ok(
      d.checks.some((c) => c.check_id === "chk-v-k-01") && d.checks.some((c) => c.check_id === "chk-v-k-02"),
      "㉑a 旧位置记录按**记录时点不可变定义**映射到稳定键并进投影（不因定义一开始就带 stable 键而丢）",
      d.checks.map((c) => c.check_id),
    );
    ok(
      d.projection.by_id["V-K"]?.passed_count === 2,
      "㉑b 稳定键要求被旧位置证据满足（同定义、同语义 ⇒ 复用，不是「没有任何检查记录」）",
      { passed: d.projection.by_id["V-K"]?.passed_count, missing: d.projection.by_id["V-K"]?.missing },
    );
    ok(
      d.check_identity.mapping_rejected.length === 0,
      "㉑c 传了 events ⇒ **不**误报「未传 events」（WATCH 12:16 修误导 missing_reason）",
      d.check_identity.mapping_rejected.map((r) => r.reason),
    );
  }
  {
    // 负例 1：快照取不回 ⇒ 绑定 unknown ⇒ 不继承
    const snap = path.join(kRoot, ".工作台", "plan-revisions");
    const backup = fs.mkdtempSync(path.join(tmpBase, "k-rev-backup-"));
    for (const f of fs.readdirSync(snap)) fs.renameSync(path.join(snap, f), path.join(backup, f));
    const d = deriveK();
    ok(
      !d.checks.some((c) => c.check_id === "chk-v-k-01") && d.projection.by_id["V-K"]?.passed_count === 0,
      "㉑d **快照取不回 ⇒ 不继承**（身份未知，不给要求背书）",
      d.check_identity.unknown.map((u) => u.reason),
    );
    for (const f of fs.readdirSync(backup)) fs.renameSync(path.join(backup, f), path.join(snap, f));
  }
  {
    // 负例 2：同位置改语义（rev2 改 chk-v-k-01 正文）⇒ changed ⇒ 不继承；未改的 check:1 仍有效
    const k2 = k1.replace("**chk-v-k-01 甲项**", "**chk-v-k-01 甲项（语义已改）**");
    write(path.join(kRoot, ".工作台", "plan.md"), k2);
    submitDefinitionImports(service, {
      project_id: KC,
      change_id: "chg-k2",
      actor_id: "fixture",
      role: "coordinator",
      expected_revisions: { "V-K": 1 },
      definitions: importTaskDefinitions(k2, { plan_revision: sha256(k2), revisions: { "V-K": 2 } }).definitions,
    });
    const d = deriveK();
    ok(
      !d.checks.some((c) => c.check_id === "chk-v-k-01") &&
        d.projection.by_id["V-K"]?.passed_count === 1 &&
        d.check_identity.definition_bindings.some((b) => b.verdict === "changed"),
      "㉑e **同位置改语义 ⇒ 该记录失效**（重排错位/同 ID 改义务不继承；未改的 check:1 仍有效）",
      {
        checks: d.checks.filter((c) => c.object_id === "V-K").map((c) => c.check_id),
        passed: d.projection.by_id["V-K"]?.passed_count,
      },
    );
  }
}

// ═══════════════════ ㉒ scope 源变化边界：同卡两功能、改 B 独有源不连坐 A ═══════════════════
section("㉒ scope 源变化边界：同卡两功能两组检查 ⇒ 改 B 独有源不连坐 A；共享/自有源变 A 仍失效");
{
  const SB = "fl-scope-bound";
  const sRoot = path.join(tmpBase, SB);
  fs.mkdirSync(path.join(sRoot, ".工作台"), { recursive: true });
  const sbPlan = [
    "# 施工图",
    "",
    "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |",
    "| --- | --- | --- | --- | --- |",
    "| V-T | todo | 同卡两功能 |  | 证据齐 |",
    "",
    "### V-T 同卡两功能",
    "",
    "**设计依据**：§3.5。**依赖**：无。**文件责任**：`src/t.ts`。",
    "",
    "- [ ] **chk-v-t-01 甲功能检查**",
    "- [ ] **chk-v-t-02 乙功能检查**",
    "",
    "| 功能 ID | 人话功能名 | 承接卡 | 必需检查 | 集成检查 | 结果状态 |",
    "| --- | --- | --- | --- | --- | --- |",
    "| cap-p | 甲功能 | V-T | chk-v-t-01 | int-p-01 | 未验 |",
    "| cap-q | 乙功能 | V-T | chk-v-t-02 | int-q-01 | 未验 |",
    "",
    "## 集成检查要求",
    "",
    "| 对象 ID | 检查 ID | 说明 | 必需性 |",
    "| --- | --- | --- | --- |",
    "| cap-p | int-p-01 | 甲功能集成 | 必需 |",
    "| cap-q | int-q-01 | 乙功能集成 | 必需 |",
    "",
  ].join("\n");
  const sbDesign = [
    "# 设计书",
    "",
    "### 3.5 目标章节",
    "",
    "正文。",
    "",
    "#### 功能清单声明（夹具）",
    "",
    DECL_HEAD[0],
    DECL_HEAD[1],
    "| cap-p | 甲功能 | req-p | §3.5 | cap-p | 待审 | reviewer=; ref=DESIGN.md#3.5; section_sha256=SECT; gap=x | 场景 |",
    "| cap-q | 乙功能 | req-q | §3.5 | cap-q | 待审 | reviewer=; ref=DESIGN.md#3.5; section_sha256=SECT; gap=x | 场景 |",
    "",
  ].join("\n");
  write(path.join(sRoot, ".工作台", "plan.md"), sbPlan);
  write(path.join(sRoot, ".工作台", "design.md"), sbDesign);
  write(path.join(sRoot, "src", "p.ts"), "export const p = 1;\n");
  write(path.join(sRoot, "src", "q.ts"), "export const q = 1;\n");
  write(path.join(sRoot, "src", "common.ts"), "export const common = 1;\n");
  addProject({ id: SB, name: "范围边界夹具", path: sRoot, kind: "backend" }, dataDir);
  registerRequirementFor(SB, "req-p");
  registerRequirementFor(SB, "req-q");
  submitDefinitionImports(service, {
    project_id: SB,
    change_id: "chg-sb",
    actor_id: "fixture",
    role: "coordinator",
    definitions: importTaskDefinitions(sbPlan, { plan_revision: sha256(sbPlan) }).definitions,
  });
  activateBaseline(SB, { approved_by: "user", approval_basis: "SB 审定", approval_kind: "user_confirmed" }, dataDir);
  const sbSect = sectionsOf(sbDesign).find((s) => s.title.startsWith("3.5 "))!;
  write(path.join(sRoot, ".工作台", "design.md"), sbDesign.replace(/section_sha256=SECT/g, `section_sha256=${sbSect.sha256}`));
  activateBaseline(SB, { approved_by: "user", approval_basis: "SB 审定2", approval_kind: "user_confirmed" }, dataDir);

  const sWork = path.join(sRoot, ".工作台");
  const mkManifest = (content: string, paths: string[], summary: string) =>
    putEvidence(path.join(sWork, "work"), {
      content,
      kind: "source_manifest",
      summary,
      created_by: "fixture",
      role: "executor",
      binding: { revision_kind: "code", revision: sha256("placeholder") },
      source_manifest: paths.map((p) => ({ path: p })),
    });
  const evP = mkManifest("P 源清单", ["src/p.ts", "src/common.ts"], "cap-p 源清单");
  const evQ = mkManifest("Q 源清单", ["src/q.ts", "src/common.ts"], "cap-q 源清单");
  const fpP = evP.source_manifest?.fingerprint ?? "";
  const fpQ = evQ.source_manifest?.fingerprint ?? "";
  // 必需检查绑各自清单指纹；集成检查绑 code 修订（无源清单，走 code 修订口径）
  recordCheckWith(SB, "V-T", "chk-v-t-01", "pass", "t-p", fpP, evP.sha256);
  recordCheckWith(SB, "V-T", "chk-v-t-02", "pass", "t-q", fpQ, evQ.sha256);
  recordCheck(SB, "cap-p", "int-p-01", "pass", "t-ip");
  recordCheck(SB, "cap-q", "int-q-01", "pass", "t-iq");

  const readP = (params: Record<string, unknown> = {}) =>
    readFeatureLedger(SB, dataDir, { document: "current", scope: "cap-p", ...params }, { project_exists: () => true, code_revision: CODE_REV });
  const itemP = (r: ReturnType<typeof readFeatureLedger>) =>
    r.ok ? r.ledger.items.find((i) => i.item_id === "cap-p") : undefined;
  const disp = (r: ReturnType<typeof readFeatureLedger>) => itemP(r)?.verification.display_status;

  const r0 = readP();
  const pkg0 = r0.ok ? r0.ledger.package_revision : "";
  ok(r0.ok && pkg0.length === 64 && disp(r0) === "verified", "㉒a 前置：cap-p 必需+集成检查齐且源清单有效 ⇒ verified", {
    display: disp(r0),
    pkg: pkg0,
  });

  // 改 **B（cap-q）独有源** ⇒ A 的包版本/显示/expected_revision/游标都不应变
  write(path.join(sRoot, "src", "q.ts"), "export const q = 2;\n");
  const r1 = readP();
  ok(
    r1.ok && r1.ledger.package_revision === pkg0 && disp(r1) === "verified",
    "㉒b 改**同卡另一功能独有源** ⇒ 本功能包版本/显示**不连坐**（scope 按声明的 required/integration 取）",
    { before: pkg0, after: r1.ok ? r1.ledger.package_revision : r1, display: disp(r1) },
  );
  const r1expected = readP({ expected_revision: pkg0 });
  ok(r1expected.ok, "㉒c 改 B 独有源后，带 A 原 expected_revision 重读**仍 200**（未误报 REVISION_CHANGED）", r1expected);
  const r1cursor = readP({ cursor: encodeCursor({ v: 1, package_revision: pkg0, offset: 0 }) });
  ok(r1cursor.ok, "㉒c′ 改 B 独有源后，旧**游标**仍可取（未被连坐判 409）", r1cursor);

  // 改**共享源**（common.ts）⇒ A 仍失效（相关源命中）
  write(path.join(sRoot, "src", "common.ts"), "export const common = 2;\n");
  const r2 = readP();
  ok(
    r2.ok && r2.ledger.package_revision !== pkg0 && disp(r2) !== "verified",
    "㉒d **共享源变** ⇒ 本功能包版本变、显示转待验证（相关源命中才失效）",
    { pkg: r2.ok ? r2.ledger.package_revision : r2, display: disp(r2) },
  );
  const r2stale = readP({ expected_revision: pkg0 });
  ok(!r2stale.ok && r2stale.status === 409, "㉒d′ 共享源变后 A 原包版本 409（不静默返回跨版本数据）", r2stale);

  // 改 A 自己声明覆盖的源 ⇒ 包版本变（对照）
  write(path.join(sRoot, "src", "p.ts"), "export const p = 2;\n");
  const r3 = readP();
  ok(r3.ok && r3.ledger.package_revision !== pkg0, "㉒e 改 A 自己声明覆盖的源 ⇒ 包版本变（相关源命中）", {
    pkg: r3.ok ? r3.ledger.package_revision : r3,
  });
}

// ═══════════════════ 收尾 ═══════════════════
if (process.env.TATAI_KEEP_TMP !== "1") {
  try {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响结论 */
  }
}
console.log(`\n[verify] 合计 PASS=${pass} FAIL=${fail}（隔离 TATAI_HOME=${dataDir}，不碰真实项目/账本）`);
if (fail > 0) process.exitCode = 1;
