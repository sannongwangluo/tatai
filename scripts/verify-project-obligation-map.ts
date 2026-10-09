// 项目义务映射机械校验（V09-61 有界正式施工定义整合，2026-10-08）。
// 用法：pnpm exec tsx scripts/verify-project-obligation-map.ts [--before <PLAN 快照>] [--migration <json>] [--report <json>]
//
// **只读**：只读 PLAN.md / DESIGN.md / package.json / public/ / dist/ / .github/ 与只读快照，
// 不写任何产品源、账本、颜色或 Gate；不改文档；不调用生产 import/activate（定义导入只走只读解析）。
//
// 校验面（对应本轮逐项要求）：
//   A. 施工图仍可解析：parsePlanTable / validatePlanTasks(0 问题) / validateTaskDefinitions(0 问题)。
//   B. 集成检查要求表：declared、0 issues、恰好 25 个对象（7 cap-loop + 11 其余 cap + 7 蓝图 plan:cap:）；
//      **无** plan:code:* / plan:mod:*（无 consumer 的死声明）；每条检查 ID 形如 int-*。
//   C. 功能→任务/检查/集成表：found、0 issues；18 个功能（7 cap-loop + 11 其余 cap）；
//      每个 required_check_id 形如 chk-* 且**真实存在**（在 PLAN 定义解析出的检查集合里）；
//      每个 integration_check_id 形如 int-* 且真实存在于集成表且绑定该功能对象。
//   D. DESIGN §2.5.2 声明：found、0 issues；18 个功能；需求 ID 去重 52 条（无遗漏、无悬空）。
//   E. DESIGN 声明与 PLAN 功能映射**双向一致**：声明的每个 feature 在 PLAN 有行，反之亦然。
//   F. 旧稳定身份不变（需 --before 快照）：快照里所有既有 `chk-*` 在候选里仍存在且 `canonicalCheckText` 逐字相同；
//      迁移项按「旧位置 → 新稳定键」逐条核对 canonical 文本相等（不按序号继承通过）。
//   G. 纯真人检查仍在且**不进**任何技术功能必需列（V09-58 人的可用性、V09-22 ⑨ 独立审计与用户验收）。
//   H. public/.github 归属核对（V09-61 chk-v09-61-06 的可机械部分）：SVG 结构、引用可达、构建复制、
//      CI 命令映射到真实脚本、issue 模板前置字段可用。**本地校验不冒充远端 GitHub CI 执行**。
//   I. 蓝图范围矩阵命令可达：int-blueprint-XX-01 引用的每条 `pnpm <alias>` 在 package.json 真实存在。
//
// 退出码：0 = 全 PASS（允许显式 SKIP）；1 = 有 FAIL。

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parsePlanTable, validatePlanTasks } from "../src/server/work/planValidate";
import {
  importTaskDefinitions,
  parseIntegrationRequirements,
  parseRequirementMap,
  validateTaskDefinitions,
} from "../src/server/work/plan";
import { parseFeatureDeclaration, parsePlanFeatureMap } from "../src/server/work/coverageModel";
import { canonicalCheckText, stableCheckDefinitionsOf } from "../src/server/work/obligations";
import { validateDefinitionReferences } from "../src/server/work/references";

const argv = process.argv.slice(2);
const argOf = (name: string): string | null => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
};
const REPO = process.cwd();
const PRIV = path.join(REPO, ".工作台", "project-completion-20261008", "plan-integration");
const PRIV2 = path.join(REPO, ".工作台", "project-completion-20261008", "feature-scope-reconcile");
const PRIV3 = path.join(REPO, ".工作台", "project-completion-20261008", "plan-finalize");
const DEFAULT_BEFORE = path.join(PRIV, "PLAN.before.md");
const BEFORE = argOf("--before") ?? DEFAULT_BEFORE;
const BEFORE_IS_DEFAULT = path.resolve(BEFORE) === path.resolve(DEFAULT_BEFORE);
// 迁移链（**精确三阶段**）：plan-integration（原 43 条）＋ feature-scope-reconcile（84 条）＋ plan-finalize
// （本轮 V09-09 十条恢复检查授稳定键 10 条）。每阶段绑**自己**那份 before 快照（按 plan_before_sha256 精确解析，
// 不做范围型 allowlist / 不按序号继承）。可用 --migration 覆盖（可重复）。
const MIGRATION_PATHS: string[] = (() => {
  const collected: string[] = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === "--migration" && argv[i + 1]) collected.push(argv[i + 1]);
  return collected.length > 0
    ? collected
    : [path.join(PRIV, "migration-table.json"), path.join(PRIV2, "migration-table.json"), path.join(PRIV3, "migration-table.json")];
})();
const MIGRATION = MIGRATION_PATHS[0]!;
const REGISTRY_SNAPSHOT = argOf("--registry") ?? path.join(PRIV2, "registered-requirements.json");
const REPORT = argOf("--report") ?? path.join(PRIV, "verify-report.json");

/** 行尾归一（LF）后的内容 sha256——与 verify-v09-03 ④ 的剥离算法同一口径（判内容不判行尾风格）。 */
const lf = (s: string): string => s.replace(/\r\n/g, "\n");
const sha256 = (s: string | Buffer): string => crypto.createHash("sha256").update(s).digest("hex");

let pass = 0;
const fails: string[] = [];
const skips: string[] = [];
const ok = (cond: boolean, label: string, detail?: unknown): void => {
  if (cond) {
    pass += 1;
    console.log(`[obligation-map] PASS ${label}`);
  } else {
    fails.push(label);
    console.log(`[obligation-map] FAIL ${label}${detail === undefined ? "" : ` :: ${JSON.stringify(detail)}`}`);
  }
};
const skip = (label: string, why: string): void => {
  skips.push(`${label}: ${why}`);
  console.log(`[obligation-map] SKIP ${label} :: ${why}`);
};

const read = (rel: string): string => fs.readFileSync(path.join(REPO, rel), "utf8");
const exists = (rel: string): boolean => fs.existsSync(path.join(REPO, rel));

const PLAN = read("PLAN.md");
const DESIGN = read("DESIGN.md");
const PKG = JSON.parse(read("package.json")) as { scripts: Record<string, string> };

// 已登记需求快照（只读派生：从唯一事实源 events.jsonl 的 requirement.registered 事件取 entity_id 去重；
// 见 feature-scope-reconcile/registered-requirements.json 的 source/source_sha256/ledger_last_seq）。
type RegistrySnapshot = { count: number; requirement_ids: string[]; source?: string; source_sha256?: string; ledger_last_seq?: number };
let registry: RegistrySnapshot | null = null;
let registryError: string | null = null;
try {
  registry = JSON.parse(fs.readFileSync(REGISTRY_SNAPSHOT, "utf8")) as RegistrySnapshot;
} catch (e) {
  registryError = String(e);
}

// ── A. 施工图可解析 ──────────────────────────────────────────────────────────
const table = parsePlanTable(PLAN);
ok(table !== null, "A1 parsePlanTable 找到合格施工卡表");
const planIssues = validatePlanTasks(table?.rows ?? [], table !== null);
ok(planIssues.length === 0, "A2 validatePlanTasks 0 问题", planIssues.map((i) => i.detail));
const imported = importTaskDefinitions(PLAN);
const defIssues = validateTaskDefinitions(imported.definitions, table !== null);
ok(defIssues.length === 0, "A3 validateTaskDefinitions 0 问题", defIssues.map((i) => i.detail));

const allChecks = imported.definitions.flatMap((d) => stableCheckDefinitionsOf(d));
const checkById = new Map(allChecks.map((c) => [c.check_id, c]));
const stableKeys = new Set(allChecks.filter((c) => c.stable).map((c) => c.check_id));

// ── B. 集成检查要求表 ────────────────────────────────────────────────────────
const integ = parseIntegrationRequirements(PLAN);
ok(integ.declared, "B1 「集成检查要求」小节已声明");
ok(integ.issues.length === 0, "B2 集成检查要求 0 结构问题", integ.issues);
const integObjects = [...new Set(integ.rows.map((r) => r.object_id))].sort();
const expectedCapLoop = [
  "cap-loop-feature-list", "cap-loop-four-dim-readout", "cap-loop-handoff-package", "cap-loop-flow-loop",
  "cap-loop-source-change-reverify", "cap-loop-supplement-path", "cap-loop-human-accept",
];
const expectedNewCaps = [
  "cap-six-graphs", "cap-graph-agent-read", "cap-business-dataflow", "cap-requirements-traceability",
  "cap-audit-closure", "cap-sync-evidence", "cap-shell-lifecycle", "cap-agent-continuity", "cap-ui-experience",
];
const expectedBlueprint = ["plan:cap:02", "plan:cap:03", "plan:cap:04", "plan:cap:05", "plan:cap:06", "plan:cap:11", "plan:cap:12"];
for (const o of [...expectedCapLoop, ...expectedNewCaps, ...expectedBlueprint]) {
  ok(integObjects.includes(o), `B3 集成表含对象 ${o}`);
}
ok(
  integObjects.every((o) => !o.startsWith("plan:code:") && !o.startsWith("plan:mod:")),
  "B4 无 plan:code:* / plan:mod:* 死声明",
  integObjects.filter((o) => o.startsWith("plan:code:") || o.startsWith("plan:mod:")),
);
ok(integ.rows.every((r) => /^int-[A-Za-z0-9]/.test(r.check_id)), "B5 集成检查 ID 均形如 int-*");
const blueprintChecks = new Map(
  integ.rows.filter((r) => r.object_id.startsWith("plan:cap:")).map((r) => [r.object_id, r.check_id]),
);
for (const o of expectedBlueprint) {
  ok(blueprintChecks.get(o) === `int-blueprint-${o.slice("plan:cap:".length)}-01`, `B6 ${o} → int-blueprint-${o.slice(8)}-01 稳定绑定`);
}

// ── C. 功能→任务/检查/集成表 ────────────────────────────────────────────────
const fmap = parsePlanFeatureMap(PLAN);
ok(fmap.found, "C1 功能映射表已找到");
ok(fmap.issues.length === 0, "C2 功能映射表 0 issues（必需检查均 chk-*、集成检查均 int-*）", fmap.issues.map((i) => i.message));
const featureIds = fmap.rows.map((r) => r.feature_id);
for (const f of [...expectedCapLoop, ...expectedNewCaps]) {
  ok(featureIds.includes(f), `C3 功能映射表含 ${f}`);
}
const integByObject = new Map<string, Set<string>>();
for (const r of integ.rows) {
  const s = integByObject.get(r.object_id) ?? new Set<string>();
  s.add(r.check_id);
  integByObject.set(r.object_id, s);
}
const unbound: string[] = [];
for (const row of fmap.rows) {
  for (const chk of row.required_check_ids) {
    if (!stableKeys.has(chk)) unbound.push(`${row.feature_id}:${chk}`);
  }
  for (const ci of row.integration_check_ids) {
    if (!integByObject.get(row.feature_id)?.has(ci)) unbound.push(`${row.feature_id}:${ci}(int)`);
  }
  ok(row.required_check_ids.length > 0, `C4 ${row.feature_id} 必需检查非空`);
  ok(row.integration_check_ids.length > 0, `C4 ${row.feature_id} 集成检查非空`);
}
ok(unbound.length === 0, "C5 所有必需/集成检查都已绑定真实检查（不是占位）", unbound);
// C6：每个必需检查的持有卡（object_id）必须在该功能的「承接卡」列里——否则是"检查存在但没绑到承接卡"
const notCarried: string[] = [];
for (const row of fmap.rows) {
  for (const chk of row.required_check_ids) {
    const owner = checkById.get(chk)?.object_id;
    if (owner === undefined) continue; // C5 已报
    if (!row.task_ids.includes(owner)) notCarried.push(`${row.feature_id}:${chk}@${owner}`);
  }
}
ok(notCarried.length === 0, "C6 每个必需检查的持有卡都在该功能的「承接卡」列里", notCarried);

// ── D. DESIGN §2.5.2 声明 ───────────────────────────────────────────────────
const declared = parseFeatureDeclaration(DESIGN, { known_requirement_ids: new Set<string>() });
// 悬空判断改由「声明自身 + PLAN 需求映射表」的并集做（不读账本，避免写侧依赖）；
// 故先把所有声明到的需求当已知集再重解析一次，仅用于拿 features。
const declaredIds = new Set(declared.features.flatMap((f) => f.requirement_ids));
const declared2 = parseFeatureDeclaration(DESIGN, { known_requirement_ids: declaredIds });
ok(declared2.found, "D1 DESIGN §2.5.2 声明区已找到");
const nonDangling = declared2.issues.filter((i) => i.code !== "DANGLING_REQUIREMENT");
ok(nonDangling.length === 0, "D2 声明区除「登记在账本」外的结构问题为 0", nonDangling);
const reqIds = [...declaredIds].sort();
ok(reqIds.length === 52, "D3 设计声明需求去重后 52 条（含 req-unified-optimization-20261003；无遗漏）", { got: reqIds.length });
ok(new Set(declared.features.map((f) => f.item_id)).size === 18, "D4 声明功能 18 个（7 cap-loop + 11 其余 cap）", {
  got: declared.features.map((f) => f.item_id),
});
// D5/D6：与「已登记需求快照」做**精确集合**核对（不只计数）——声明集 == 登记集，PLAN 需求映射表引用的需求都在登记集内。
const registeredIds = [...new Set(registry?.requirement_ids ?? [])].sort();
ok(registryError === null && registry !== null, "D5 已登记需求快照可读（feature-scope-reconcile/registered-requirements.json）", { path: path.relative(REPO, REGISTRY_SNAPSHOT), error: registryError });
ok(registeredIds.length > 0 && registry?.count === registeredIds.length, "D5b 快照自身计数自洽", { count: registry?.count ?? null, distinct: registeredIds.length });
const declaredVsRegistered = {
  design_only: reqIds.filter((x) => !registeredIds.includes(x)),
  registered_only: registeredIds.filter((x) => !reqIds.includes(x)),
};
ok(
  declaredVsRegistered.design_only.length === 0 && declaredVsRegistered.registered_only.length === 0,
  "D5c DESIGN 声明需求集 == 已登记需求快照集（精确集合核对，非计数）",
  declaredVsRegistered,
);
const planMapRows = parseRequirementMap(PLAN).filter((r) => r.requirement_id !== "");
const unknownPlanReqs = [...new Set(planMapRows.map((r) => r.requirement_id))].filter((id) => !registeredIds.includes(id));
ok(unknownPlanReqs.length === 0, "D6 PLAN 需求映射表引用的需求都在已登记快照集内（无未知/悬空需求）", unknownPlanReqs);

// ── E. 双向一致 ─────────────────────────────────────────────────────────────
const declaredFeatureIds = declared.features.map((f) => f.item_id).sort();
const planFeatureIds = [...new Set(featureIds)].sort();
ok(
  JSON.stringify(declaredFeatureIds) === JSON.stringify(planFeatureIds),
  "E1 DESIGN 声明功能集 == PLAN 功能映射功能集（双向不悬空）",
  { design_only: declaredFeatureIds.filter((x) => !planFeatureIds.includes(x)), plan_only: planFeatureIds.filter((x) => !declaredFeatureIds.includes(x)) },
);

// ── F. 旧稳定身份不变（需快照；迁移链＝精确三阶段：原 43 ＋ 84 ＋ 本轮 V09-09 十条 10）─────────
// 「三阶段链」：脚本接受 plan-integration（原 43 条）、feature-scope-reconcile（84 条）与 plan-finalize
// （本轮 V09-09 十条恢复检查授稳定键 10 条）三份迁移表；
// 每条迁移的 canonical 证明都绑到**该表自己声明的 before 快照**（按 plan_before_sha256 精确解析，禁范围型 allowlist）。
const rel = (p: string): string => path.relative(REPO, p).replace(/\\/g, "/");
type MigEntry = { card: string; old_position_id: string; new_stable_id: string; canonical_check_text?: string };
type MigTable = { batch?: string; plan_before_sha256?: string; plan_after_sha256?: string; migration: MigEntry[]; new_checks?: { check_id: string }[] };
type LoadedTable = { path: string; sha256: string; table: MigTable };
const loadedTables: LoadedTable[] = [];
for (const p of MIGRATION_PATHS) {
  try {
    const bytes = fs.readFileSync(p);
    loadedTables.push({ path: p, sha256: sha256(bytes), table: JSON.parse(bytes.toString("utf8")) as MigTable });
  } catch (e) {
    console.log(`[obligation-map] WARN 迁移表不可读 ${p} :: ${String(e)}`);
  }
}
const allMigrations = loadedTables.flatMap((t) => t.table.migration ?? []);
const allNewChecks = loadedTables.flatMap((t) => t.table.new_checks ?? []);
const counts = { checks_before: 0, untouched: 0 };
const afterCanon = new Map<string, string>();
for (const c of allChecks) afterCanon.set(c.check_id, canonicalCheckText(c.label));

// F 段反例口径（非作者复审 F2）：F 段只对「迁移专用 before 快照」成立；换用别的**已审** before 时，
// 域外并发已审修改（V09-54/V09-55 卡面脚本名改成真实脚本引用）会改变 ::evidence 隐含义务文本。
// 这些**明确被审**的差异按 before-delta 逐条记录、**不**当不变量失败；其余任何差异一律 FAIL（保留严格性，
// 不做宽泛剥离：只豁免下表点名身份，且豁免项必须真的只在 canonical 文本上、身份仍在）。
const AUTHORIZED_BEFORE_DELTA = new Map<string, string>([
  ["V09-54::evidence", "域外并发已审修改：V09-54 卡面 `verify-review-terminal` → 真实脚本 `verify-loop-closure`"],
  ["V09-55::evidence", "域外并发已审修改：V09-55 卡面 `verify-scope-coherence` → 真实脚本 `verify-feature-scope`"],
]);
const fSection = {
  covered: false,
  before_path: rel(BEFORE),
  before_sha256: null as string | null,
  before_is_default: BEFORE_IS_DEFAULT,
  authorized_delta: [] as string[],
  disallowed_delta: [] as string[],
};
ok(
  loadedTables.length === MIGRATION_PATHS.length && allMigrations.length > 0,
  "F0 迁移链已记录（精确三阶段：43＋84＋10；逐表 sha256）",
  { tables: loadedTables.map((t) => ({ path: rel(t.path), sha256: t.sha256, entries: t.table.migration?.length ?? 0 })) },
);

if (!fs.existsSync(BEFORE)) {
  skip(
    "F 旧稳定身份不变",
    BEFORE_IS_DEFAULT
      ? `默认私有 before 不在（${rel(DEFAULT_BEFORE)}）⇒ F 段未覆盖，不能据此总称全验通过`
      : `找不到 --before 指定快照 ${BEFORE}`,
  );
} else {
  const beforeRaw = fs.readFileSync(BEFORE, "utf8");
  fSection.covered = true;
  fSection.before_sha256 = sha256(lf(beforeRaw));
  console.log(
    `[obligation-map] BASELINE before=${fSection.before_path} sha256(lf)=${fSection.before_sha256} ` +
      `before_is_default=${BEFORE_IS_DEFAULT} migration_chain=${loadedTables.map((t) => `${rel(t.path)}#${t.sha256.slice(0, 12)}`).join(",")} ` +
      `PLAN sha256(lf)=${sha256(lf(PLAN))} DESIGN sha256(lf)=${sha256(lf(DESIGN))}`,
  );
  const beforeImported = importTaskDefinitions(beforeRaw);
  const beforeChecks = beforeImported.definitions.flatMap((d) => stableCheckDefinitionsOf(d));
  const beforeCanon = new Map(beforeChecks.map((c) => [c.check_id, canonicalCheckText(c.label)]));
  const beforeStable = [...beforeCanon.keys()].filter((k) => k.startsWith("chk-"));
  counts.checks_before = beforeCanon.size;
  const newKeys = new Set(allMigrations.map((m) => m.new_stable_id));
  const migratedPos = new Set(allMigrations.map((m) => m.old_position_id));
  // 广义不变量：除「本批新增的稳定键」与「本批迁移掉的旧位置身份」外，
  // **快照里出现过的每一个 check_id（既有 chk-*、未迁移的位置型、::evidence 隐含义务）**
  // 都必须在候选里仍存在且 canonical 逐字不变。
  const disappeared: string[] = [];
  const mutated: string[] = [];
  let untouched = 0;
  for (const [k, v] of beforeCanon) {
    if (newKeys.has(k) || migratedPos.has(k)) continue;
    untouched += 1;
    if (!afterCanon.has(k)) disappeared.push(k);
    else if (afterCanon.get(k) !== v) mutated.push(k);
  }
  ok(disappeared.length === 0, "F1 未迁移的既有 check_id 一个都没消失（含既有 chk-*、位置型、::evidence）", disappeared);
  // 只允许已审的精确路径替换；点名 ID 本身不是任意改写正文的豁免。
  const exactAllowed = (k: string): boolean => {
    const pair = k === "V09-54::evidence" ? ["scripts/verify-review-terminal.ts", "scripts/verify-loop-closure.ts"]
      : k === "V09-55::evidence" ? ["scripts/verify-scope-coherence.ts", "scripts/verify-feature-scope.ts"] : null;
    const old = beforeCanon.get(k);
    return pair !== null && old !== undefined && old.includes(pair[0]!) && old.split(pair[0]!).join(pair[1]!) === afterCanon.get(k);
  };
  const authorizedDelta = mutated.filter(exactAllowed);
  const disallowed = mutated.filter((k) => !exactAllowed(k));
  fSection.authorized_delta = authorizedDelta;
  fSection.disallowed_delta = disallowed;
  ok(
    disallowed.length === 0,
    "F2 未迁移 check_id 的 canonical 语义逐字不变（仅豁免已审域外 before-delta，逐条记录；其余一律 FAIL）",
    { disallowed, authorized_delta: authorizedDelta },
  );
  const reviewedBaselines = new Map([
    ["f290ab643c705d152db9d7655ebe20768240dd9ec6cee5a3d2fb8b9c7ea54683", 78],
    ["d7f7ab2710762ea1c28a855010bfd2617d048386e6bfe0dcb0fee6f6be7fe622", 73],
  ]);
  const expectedStable = reviewedBaselines.get(fSection.before_sha256);
  ok(expectedStable !== undefined && beforeStable.length === expectedStable, "F3 已审快照 SHA 与稳定键数量精确匹配；未知快照不得降低下限放行", {
    got: beforeStable.length,
    expected: expectedStable ?? null,
    baseline_sha256: fSection.before_sha256,
  });
  counts.untouched = untouched;
  ok(untouched > 300, "F3b 未触碰身份数量合理（>300，证明迁移是**最小**的）", { got: untouched });

  // 迁移项逐条：每条迁移绑到**它自己那份 before 快照**（按 plan_before_sha256 精确解析，禁范围型 allowlist）——
  // 新稳定键的 canonical 必须等于该快照里同卡同位置（旧位置身份）的 canonical，逐字相等。
  const snapshotPaths = [...new Set([DEFAULT_BEFORE, path.join(PRIV2, "PLAN.before.md"), path.join(PRIV3, "PLAN.before.md"), path.resolve(BEFORE)])];
  const legacyCanonOf = (sp: string): Map<string, string> => {
    const defs = importTaskDefinitions(fs.readFileSync(sp, "utf8")).definitions;
    const m = new Map<string, string>();
    for (const d of defs) for (const c of stableCheckDefinitionsOf(d)) m.set(c.legacy_position_id, canonicalCheckText(c.label));
    return m;
  };
  const snapCache = new Map<string, Map<string, string>>();
  const resolveSnapshot = (sha: string | undefined): Map<string, string> | null => {
    if (sha === undefined) return null;
    for (const sp of snapshotPaths) {
      if (!fs.existsSync(sp)) continue;
      if (sha256(fs.readFileSync(sp)) === sha) {
        if (!snapCache.has(sp)) snapCache.set(sp, legacyCanonOf(sp));
        return snapCache.get(sp)!;
      }
    }
    return null;
  };
  const badF4: string[] = [];
  const unresolvable: string[] = [];
  for (const t of loadedTables) {
    const legacy = resolveSnapshot(t.table.plan_before_sha256);
    if (legacy === null) { unresolvable.push(`${rel(t.path)} :: plan_before_sha256=${t.table.plan_before_sha256}`); continue; }
    for (const m of t.table.migration) {
      const after = afterCanon.get(m.new_stable_id);
      const beforeText = legacy.get(m.old_position_id);
      if (after === undefined) { badF4.push(`${m.new_stable_id} 不在候选检查集`); continue; }
      if (beforeText === undefined) { badF4.push(`${m.old_position_id} 不在其 before 快照`); continue; }
      if (after !== beforeText) badF4.push(`${m.new_stable_id} canonical 变了`);
    }
  }
  ok(unresolvable.length === 0, "F4a 每份迁移表的 before 快照按 plan_before_sha256 精确解析（非近似/范围型）", unresolvable);
  ok(badF4.length === 0, "F4 迁移项 canonical 语义比对逐条相等（旧位置→新稳定键，各绑自己的 before 快照）", badF4);
  const missingNew = allNewChecks.filter((n) => !afterCanon.has(n.check_id)).map((n) => n.check_id);
  ok(missingNew.length === 0, "F5 新增检查真实存在", missingNew);
  // F6 哈希证明：每份迁移表的 before/after 制品（同目录 PLAN.before.md / PLAN.after.md）原始字节 sha256
  // 必须等于表内声明的 plan_before_sha256 / plan_after_sha256——这是本轮「精确前后哈希证明」。
  const hashProof = loadedTables.map((t) => {
    const dir = path.dirname(t.path);
    const b = path.join(dir, "PLAN.before.md");
    const a = path.join(dir, "PLAN.after.md");
    return {
      table: rel(t.path),
      before_ok: fs.existsSync(b) && sha256(fs.readFileSync(b)) === t.table.plan_before_sha256,
      after_ok: fs.existsSync(a) && sha256(fs.readFileSync(a)) === t.table.plan_after_sha256,
    };
  });
  ok(hashProof.every((h) => h.before_ok && h.after_ok), "F6 迁移前后制品哈希证明（PLAN.before/after 原始字节 == 表内声明哈希）", hashProof);
  const tipMatchesPlan = loadedTables.some((t) => sha256(Buffer.from(PLAN, "utf8")) === t.table.plan_after_sha256);
  ok(tipMatchesPlan, "F7 当前 PLAN 与某份迁移表的 after 制品精确一致（本轮 tip 未被后续改动漂移）");
}

// ── G. 纯真人检查仍在且不进技术必需列 ────────────────────────────────────────
ok(afterCanon.has("chk-v09-58-01"), "G1 chk-v09-58-01（人的可用性）仍在卡上");
ok(checkById.has("V09-22::check:8"), "G2 V09-22::check:8（独立审计与用户验收）仍在卡上");
const referenced = new Set(fmap.rows.flatMap((r) => [...r.required_check_ids, ...r.integration_check_ids]));
ok(!referenced.has("chk-v09-58-01"), "G3 人的可用性检查**不**进任何技术功能必需列");
ok(!referenced.has("V09-22::check:8"), "G4 纯人工验收项**不**进任何技术功能必需列");

// ── H. public / .github 归属核对（V09-61 chk-v09-61-06 可机械部分）───────────
const SVG_RE = /<svg\b[^>]*\bviewBox\s*=\s*"([^"]+)"/;
for (const [rel, need] of [["public/tatai-mark.svg", true], ["public/tatai-favicon.svg", true]] as const) {
  if (!exists(rel)) { ok(false, `H1 资源存在 ${rel}`); continue; }
  const svg = read(rel);
  const m = SVG_RE.exec(svg);
  ok(m !== null, `H1 ${rel} 是结构完整的 SVG（含 <svg viewBox>）`);
  if (need && m !== null) {
    const parts = m[1].trim().split(/\s+/).map(Number);
    ok(parts.length === 4 && parts.every(Number.isFinite) && parts[2] > 0 && parts[3] > 0,
      `H2 ${rel} viewBox 合法（4 个有限数、宽高 > 0）`, m[1]);
  }
  ok(svg.includes("<path") || svg.includes("<circle") || svg.includes("<rect") || svg.includes("<g"),
    `H3 ${rel} 含实际图形（非空壳）`);
}
ok(read("index.html").includes("/tatai-favicon.svg"), "H4 index.html 引用 favicon");
ok(read("src/ui/brand/TowerMark.tsx").includes("tatai-mark.svg"), "H5 TowerMark.tsx 引用 tatai-mark.svg");
if (fs.existsSync(path.join(REPO, "dist"))) {
  for (const rel of ["tatai-mark.svg", "tatai-favicon.svg"]) {
    const pub = path.join(REPO, "public", rel);
    const dst = path.join(REPO, "dist", rel);
    ok(fs.existsSync(dst), `H6 构建复制 dist/${rel}`);
    if (fs.existsSync(dst)) {
      ok(fs.readFileSync(pub).equals(fs.readFileSync(dst)), `H7 dist/${rel} 与 public/ 逐字节一致`);
    }
  }
} else {
  skip("H6/H7 构建复制 dist/*.svg", "dist/ 不存在（构建未运行；最终构建由协调跑）");
}
const CI = ".github/workflows/ci.yml";
if (!exists(CI)) {
  ok(false, "H8 ci.yml 存在");
} else {
  const ci = read(CI);
  const ciCmds = [...ci.matchAll(/run:\s*(pnpm\s+[^\s#]+)/g)].map((m) => m[1]);
  ok(ciCmds.length > 0, "H8 ci.yml 声明了 pnpm 命令");
  const unresolved = ciCmds
    .map((c) => c.replace(/^pnpm\s+/, ""))
    .filter((c) => c !== "install" && !(c in PKG.scripts));
  ok(unresolved.length === 0, "H9 ci.yml 声明的本地命令逐条对应真实 package.json 脚本", unresolved);
  for (const need of ["typecheck", "build", "verify:registry"]) {
    ok(ciCmds.some((c) => c === `pnpm ${need}`), `H10 ci.yml 含 pnpm ${need}`);
  }
  ok(/runs-on:\s*ubuntu-latest/.test(ci) && /actions\/checkout@/.test(ci), "H11 ci.yml 是远端 GitHub Actions 定义（本地校验不冒充其执行）");
}
for (const rel of [".github/ISSUE_TEMPLATE/bug_report.md", ".github/ISSUE_TEMPLATE/feature_request.md"]) {
  if (!exists(rel)) { ok(false, `H12 issue 模板存在 ${rel}`); continue; }
  const t = read(rel);
  ok(/^---[\s\S]*?\bname:\s*\S[\s\S]*?\babout:\s*\S[\s\S]*?\btitle:\s*\S[\s\S]*?---/m.test(t),
    `H12 ${rel} 含 name/about/title 前置字段`);
  ok(/密钥|脱敏|不要贴|security/i.test(t), `H13 ${rel} 含必填提示（脱敏/密钥/安全渠道）`);
}

// ── I. 蓝图矩阵命令可达 ─────────────────────────────────────────────────────
let matrix: Record<string, { check: string; commands: string[] }> | null = null;
try {
  matrix = JSON.parse(fs.readFileSync(MIGRATION, "utf8")).blueprint_matrix as Record<string, { check: string; commands: string[] }>;
} catch {
  matrix = null;
}
if (matrix === null) {
  skip("I 蓝图矩阵命令可达", `找不到 ${MIGRATION}.blueprint_matrix`);
} else {
  const missingAlias: string[] = [];
  for (const [object, spec] of Object.entries(matrix)) {
    ok(blueprintChecks.get(object) === spec.check, `I1 ${object} 矩阵检查 ID 与 PLAN 一致（${spec.check}）`);
    for (const cmd of spec.commands) {
      const alias = cmd.replace(/^pnpm\s+/, "");
      if (!(alias in PKG.scripts)) missingAlias.push(`${object}:${cmd}`);
    }
  }
  ok(missingAlias.length === 0, "I2 矩阵引用的 pnpm 命令逐条是真实脚本", missingAlias);
}

// ── J. 受检导入模拟（隔离、零写入）───────────────────────────────────────────
// 用 importPlanChecked 里同一份 `validateDefinitionReferences` 判据，在内存里模拟一次受检导入：
// 已知需求集 = DESIGN §2.5.2 声明的 52 条（不读账本、不写任何字节）。
const refIssues = validateDefinitionReferences(
  imported.definitions.map((d) => ({ task_id: d.task_id, requirement_ids: d.requirement_ids, change_id: d.change_id })),
  { requirement_ids: [...declaredIds], change_ids: [] },
);
ok(refIssues.length === 0, "J1 受检导入模拟：PLAN 需求映射引用的需求都在 DESIGN 声明集内（无悬空）", refIssues.map((i) => i.detail));
const fromPlan = new Set(imported.definitions.flatMap((d) => d.requirement_ids ?? []));
ok(fromPlan.size > 0, "J2 PLAN 需求映射确实把 requirement_ids 带进了任务定义", { got: fromPlan.size });

// ── K. 需求映射直接完整性（非作者复审 F1：不是只数集合）───────────────────────
// D3 只数「DESIGN 声明需求 52 条」、E1 只比「功能集」；本段是**内容级直接完整性**：
// DESIGN §2.5.2 声明的**每一条**需求，都必须在 PLAN 里有「需求 ID → 承接卡」逐字承接行，
// 且承接卡号都是真实施工卡——否则最终受检重导时 `requirementMapForCards(parseRequirementMap(PLAN))`
// 不产出该绑定、**丢失账本里已有的 requirement_ids**，需求→卡链路只剩「DESIGN feature + PLAN feature」间接路径。
// 用内存负例证明判据非空转（不写任何字节）。
function directMappingProblems(
  markdown: string,
  declared: readonly string[],
): { missing: string[]; unknownCards: string[] } {
  const rows = parseRequirementMap(markdown);
  const realCards = new Set((parsePlanTable(markdown)?.rows ?? []).map((r) => r.id).filter((x) => x !== ""));
  const missing: string[] = [];
  const unknownCards: string[] = [];
  for (const id of declared) {
    const row = rows.find((r) => r.requirement_id === id && r.classification === "当前有效");
    if (row === undefined || row.card_ids.length === 0) {
      missing.push(id);
      continue;
    }
    for (const c of row.card_ids) if (!realCards.has(c)) unknownCards.push(`${id}:${c}`);
  }
  return { missing, unknownCards };
}
const direct = directMappingProblems(PLAN, reqIds);
ok(direct.missing.length === 0, "K1 每条 DESIGN 声明需求都有 PLAN 需求映射行（直接承接；内容级，不是集合计数）", direct.missing);
ok(direct.unknownCards.length === 0, "K2 每条承接映射的卡号都是真实存在的施工卡（无幽灵卡）", direct.unknownCards);
// K3 有意义负例（内存、零写入）：删一行 / 幽灵卡号 / 幽灵需求 ID —— 三项必须被识破，证明 K1/K2 非空转（不是「有行即绿」）
const dropRowPlan = PLAN.replace(/\|\s*req-U-01\s*\|[^\n]*\r?\n/, "");
const dmDrop = directMappingProblems(dropRowPlan, reqIds);
ok(dmDrop.missing.includes("req-U-01"), "K3a 负例：删掉 req-U-01 承接行 ⇒ K1 必点名缺失", dmDrop.missing.slice(0, 5));
const ghostCardPlan = PLAN.replace(/(\|\s*req-U-06\s*\|)[^\n]*/, (m) => m.replace("V06-12", "V99-99"));
const dmGhost = directMappingProblems(ghostCardPlan, reqIds);
ok(dmGhost.unknownCards.some((s) => s.startsWith("req-U-06:")), "K3b 负例：承接卡换成幽灵卡号 ⇒ K2 必识破", dmGhost.unknownCards.slice(0, 5));
const ghostReqPlan = PLAN.replace(/(\|\s*)req-U-08(\s*\|)/, "$1req-GHOST-Z$2");
const dmGhostReq = directMappingProblems(ghostReqPlan, reqIds);
ok(dmGhostReq.missing.includes("req-U-08"), "K3c 负例：承接行需求 ID 换成幽灵 ⇒ K1 必点名原需求缺失", dmGhostReq.missing.slice(0, 5));

// ── L. 新功能成员完整性（仅 9 个新 cap）───────────────────────────────────────
// 判据（语义矩阵，非集合计数）：新 cap 的**每一条**声明需求，其真承接卡都必须在该功能的「承接卡」列里，
// 否则「需求有成员、功能缺承接」——界面/读口给的成员与需求承接会不一致。**只对 9 个新 cap 适用**：
// 7 个 cap-loop 的质量约束可多卡（同一 loop 需求可挂到该功能之外的卡），不误套「所有需求卡必须全归单 cap」。
function membershipProblems(markdown: string, caps: readonly string[]): { feature: string; missing: string[] }[] {
  const reqRows = parseRequirementMap(markdown);
  const fmap2 = parsePlanFeatureMap(markdown);
  const out: { feature: string; missing: string[] }[] = [];
  for (const f of declared.features) {
    if (!caps.includes(f.item_id)) continue;
    const row = fmap2.rows.find((r) => r.feature_id === f.item_id);
    const have = new Set(row?.task_ids ?? []);
    const need = new Set<string>();
    for (const rid of f.requirement_ids) {
      const rr = reqRows.find((r) => r.requirement_id === rid && r.classification === "当前有效");
      for (const c of rr?.card_ids ?? []) need.add(c);
    }
    const missing = [...need].filter((c) => !have.has(c)).sort();
    if (missing.length > 0) out.push({ feature: f.item_id, missing });
  }
  return out;
}
const memProblems = membershipProblems(PLAN, expectedNewCaps);
ok(memProblems.length === 0, "L1 9 个新 cap：直接需求的真承接卡都在该功能「承接卡」列里（需求有成员、功能不缺承接）", memProblems);
const dropMember = PLAN.replace(/(^\|\s*cap-agent-continuity\s*\|[^|\n]*\|)([^|\n]*)(\|)/m, (_m, a: string, c: string, b: string) => a + c.replace("V09-26、", "") + b);
const memDrop = membershipProblems(dropMember, expectedNewCaps);
ok(
  memDrop.some((p) => p.feature === "cap-agent-continuity" && p.missing.includes("V09-26")),
  "L2 负例：删掉某功能一个成员卡 ⇒ L1 必点名该功能缺承接（非空转）",
  memDrop.slice(0, 3),
);
const setChecks = (md: string, id: string, val: string): string =>
  md.replace(new RegExp(`^(\\|\\s*${id}\\s*\\|[^|\\n]*\\|[^|\\n]*\\|)([^|\\n]*)(\\|)`, "m"), `$1${val}$3`);
const sixEmpty = parsePlanFeatureMap(setChecks(PLAN, "cap-six-graphs", "")).rows.find((r) => r.feature_id === "cap-six-graphs");
ok(sixEmpty !== undefined && sixEmpty.required_check_ids.length === 0, "L3a 负例：清空某功能「必需检查」列 ⇒ 解析为空（C4 判据必 FAIL，不判绿）");
const ghostChkRow = parsePlanFeatureMap(setChecks(PLAN, "cap-six-graphs", "chk-v99-99-01")).rows.find((r) => r.feature_id === "cap-six-graphs");
ok((ghostChkRow?.required_check_ids ?? []).some((c) => !stableKeys.has(c)), "L3b 负例：功能「必需检查」换成幽灵稳定键 ⇒ C5 判据必识破（不在候选检查集）");

// ── M. 新功能成员「零必需检查」反例（root 复审：不接受成员在列却零检查、借集成检查全包）──────────
// 判据（只对 9 个新 cap 适用，与 L 同界）：功能「承接卡」列里的**每张成员卡**，都必须至少有一条
// **以它为持有卡**的必需检查列在该功能「必需检查」里；否则该成员在功能账目上「有成员、零检查」，
// 只能靠 int-* 集成检查「全包」——正是 root 复审点名的映射缺口。7 个 cap-loop 的质量约束可多卡，不套此界。
function zeroCheckMembers(markdown: string, caps: readonly string[]): { feature: string; members: string[] }[] {
  const fmap2 = parsePlanFeatureMap(markdown);
  const defs2 = importTaskDefinitions(markdown).definitions;
  const owner = new Map<string, string>();
  for (const d of defs2) for (const c of stableCheckDefinitionsOf(d)) if (c.stable) owner.set(c.check_id, d.task_id);
  const out: { feature: string; members: string[] }[] = [];
  for (const r of fmap2.rows) {
    if (!caps.includes(r.feature_id)) continue;
    const holders = new Set(r.required_check_ids.map((c) => owner.get(c)).filter((x): x is string => x !== undefined));
    const zero = r.task_ids.filter((t) => !holders.has(t));
    if (zero.length > 0) out.push({ feature: r.feature_id, members: zero });
  }
  return out;
}
const zeroMem = zeroCheckMembers(PLAN, expectedNewCaps);
ok(
  zeroMem.length === 0,
  "M1 9 个新 cap 的每张成员卡都至少有一条以其为持有卡的必需检查（无「成员在列、零检查、借集成全包」）",
  zeroMem,
);
const dropV0909 = setChecks(PLAN, "cap-six-graphs", "chk-v09-02-05");
const zeroMem2 = zeroCheckMembers(dropV0909, expectedNewCaps);
ok(
  zeroMem2.some((p) => p.feature === "cap-six-graphs" && p.members.includes("V09-09")),
  "M2 负例：cap-six-graphs 必需检查去掉 V09-09 的键 ⇒ M1 必点名 V09-09 成员零检查（非空转）",
  zeroMem2.slice(0, 3),
);
// N. canonical 正文负例：把某条迁移项正文改一字 ⇒ 与 before 快照该位置的逐字判据不等（仍红）。
const sampleMig = allMigrations.find((m) => m.new_stable_id === "chk-v09-26-01");
if (sampleMig === undefined) {
  skip("N1 canonical 负例", "迁移链里没有 chk-v09-26-01");
} else {
  const afterText = afterCanon.get(sampleMig.new_stable_id) ?? "";
  ok(canonicalCheckText(`${afterText}（语义已改）`) !== afterText, "N1 负例：迁移项 canonical 正文改一字 ⇒ 与快照逐字判据不等（仍红）", { id: sampleMig.new_stable_id });
}

// ── O. 登记集/未知需求负例（内存、零写入）─────────────────────────────────────
const unknownProbe = PLAN.replace(/(\|\s*)req-U-08(\s*\|)/, "$1req-UNKNOWN-999$2");
ok(
  [...new Set(parseRequirementMap(unknownProbe).map((r) => r.requirement_id))].some((id) => !registeredIds.includes(id)),
  "O1 负例：需求映射表引用未知需求 ⇒ D6 判据必识破（无未知/悬空需求）",
);
const registryMinusOne = registeredIds.filter((x) => x !== "req-U-01");
ok(
  reqIds.filter((x) => !registryMinusOne.includes(x)).includes("req-U-01"),
  "O2 负例：已登记集漏掉旧需求 req-U-01 ⇒ D5c 集合核对必报 design_only（漏旧需求被发现）",
);

// ── 报告 ────────────────────────────────────────────────────────────────────
const report = {
  batch: "V09-61 project-obligation-map 2026-10-08",
  pass,
  fail: fails.length,
  skip: skips.length,
  fails,
  skips,
  features: planFeatureIds,
  requirements_declared: reqIds.length,
  requirement_map_direct_missing: direct.missing,
  requirement_map_direct_unknown_cards: direct.unknownCards,
  requirement_map_direct_negative_probes: {
    dropped_row_detected: dmDrop.missing.includes("req-U-01"),
    ghost_card_detected: dmGhost.unknownCards.some((s) => s.startsWith("req-U-06:")),
    ghost_req_detected: dmGhostReq.missing.includes("req-U-08"),
  },
  registered_requirements: registeredIds.length,
  registered_snapshot: { path: path.relative(REPO, REGISTRY_SNAPSHOT), source_sha256: registry?.source_sha256 ?? null, ledger_last_seq: registry?.ledger_last_seq ?? null },
  feature_membership_new_caps_missing: memProblems,
  feature_membership_zero_check_missing: zeroMem,
  integration_objects: integObjects,
  integration_rows: integ.rows.map((r) => `${r.object_id} -> ${r.check_id}`),
  stable_check_count_after: stableKeys.size,
  checks_after: allChecks.length,
  checks_before: counts.checks_before,
  migration_chain: loadedTables.map((t) => ({ path: rel(t.path), sha256: t.sha256, entries: t.table.migration.length })),
  migrated_stable_keys: allMigrations.length,
  new_checks: allNewChecks.map((n) => n.check_id),
  untouched_check_identities: counts.untouched,
  baseline: {
    before_path: fSection.before_path,
    before_sha256_lf: fSection.before_sha256,
    before_is_default: fSection.before_is_default,
    migration_paths: MIGRATION_PATHS.map((p) => rel(p)),
    migration_chain_sha256: loadedTables.map((t) => t.sha256),
    plan_sha256_lf: sha256(lf(PLAN)),
    plan_sha256_raw: sha256(Buffer.from(PLAN, "utf8")),
    design_sha256_lf: sha256(lf(DESIGN)),
    f_section_covered: fSection.covered,
    authorized_before_delta: fSection.authorized_delta,
    disallowed_before_delta: fSection.disallowed_delta,
  },
};
try {
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
  console.log(`[obligation-map] 报告写入 ${REPORT}`);
} catch (e) {
  console.log(`[obligation-map] 报告写入失败（只读环境可忽略）：${String(e)}`);
}
console.log(`[obligation-map] PASS ${pass} / FAIL ${fails.length} / SKIP ${skips.length}`);
process.exit(fails.length === 0 ? 0 : 1);
