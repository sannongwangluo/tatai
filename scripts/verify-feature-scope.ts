// V09-55（协作闭环 B5）六图同源聚合与版本读数统一——回归脚本（node+tsx 跑）：
//   node node_modules/tsx/dist/cli.mjs scripts/verify-feature-scope.ts
//
// 本脚本针对 B5 返工：范围（能力）主状态**只在唯一义务层**（deriveObligations/projectStatuses）判定，
// UI/六图只作**只读适配**；不再有第二份绿公式。覆盖：
//   A. 真项目六图产物逐节点对账（**真跑 sixGraphsOf**，隔离 TATAI_HOME + 只读真实项目数据）：
//      同一 scope ＋ 同一 snapshot 下，功能全景/系统架构/技术三图（方框图/数据流/思维导图）逐 id 同状态；
//      对照诊断快照（COORDINATOR-CHECKS.json）的已知反例（塔台 cap01/07/08/09/10/12、示例项目 cap11）确认差异消失。
//   B. canonical 判据正例：范围 required checks ＋ 自身集成检查**全部通过** ⇒ 确实 verified（绿）。
//   C. canonical 判据反例：集成 failed ⇒ **blocked（不是橙封顶）**；缺集成 ⇒ 不给绿；缺成员 ⇒ 未映射。
//   D. 相关源变 ⇒ 需复验/转待验证；无关源变 ⇒ 不动；定义变 ⇒ scope_revision 变。
//   E. 未接入 canonical 投影 ⇒ 六图/画布如实「未知」，**不退回本地按成员汇总造绿**。
//   F. 成员账目：中性对象不产生成员；模型推断边不给归属；派生成员可追到正式关系。
//   G. 不删对象/不隐藏异常：canonical 投影里的对象与 anomalies 原样保留。
//
// 隔离：自建临时 TATAI_HOME（不写真实 registry）；只 **读** 真实项目数据（sixGraphsOf 只读路径不写盘）；
// 不启动任何服务、不碰 8787、不写真实账本。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sixGraphsOf } from "../src/arch/sixGraphs";
import {
  capabilityDeclaredMembersOf,
  scopeMemberKindOf,
  scopeMemberLedgerOf,
  scopeRevisionOf,
  scopeStatusObjectsOf,
  scopeReadoutOf,
} from "../src/arch/featureScope";
import { projectStatuses, type CheckInput, type StatusObjectInput } from "../src/server/work/statusProjection";
import { scopeVersionOf } from "../src/server/work/obligations";
import {
  buildViewModel,
  canonicalScopeStatusOf,
  taskDerivedModuleStatus,
} from "../src/ui/arch/projectGraph";
import type { Blueprint } from "../src/arch/blueprint";

let pass = 0;
const fails: string[] = [];
const skips: string[] = [];
const ok = (cond: boolean, label: string): void => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (cond) pass += 1;
  else fails.push(label);
};
const skip = (label: string): void => {
  console.log(`[verify] SKIP ${label}`);
  skips.push(label);
};
const section = (t: string): void => console.log(`\n[verify] ── ${t} ──`);

// ══════════════════════ A. 真项目六图逐节点对账 ══════════════════════

section("A. 真项目六图产物逐节点对账（同 snapshot：同一 scope 跨六图同状态）");

const VIEWS = ["functional", "architecture", "module_map", "data_flow", "mind_map"] as const;

/** 从真实 registry 发现项目（只读；读不到就跳过真数据段，不失败） */
function realProjects(): { id: string; path: string; kind: string }[] {
  const home = process.env.TATAI_HOME?.trim() || path.join(os.homedir(), ".tatai");
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(home, "registry.json"), "utf8")) as {
      projects?: { id: string; name: string; path: string; kind: string }[];
    };
    return (raw.projects ?? []).map((p) => ({ id: p.id, path: p.path, kind: p.kind }));
  } catch {
    return [];
  }
}

/** 隔离 TATAI_HOME：把真实项目登记写进临时目录（**不碰真实 registry**），sixGraphsOf 只读真实数据 */
function isolatedHome(projects: { id: string; name?: string; path: string; kind: string }[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b5-scope-"));
  fs.writeFileSync(
    path.join(dir, "registry.json"),
    JSON.stringify({ version: 1, projects: projects.map((p) => ({ ...p, name: p.name ?? p.id })) }, null, 2),
    "utf8",
  );
  return dir;
}

/** 诊断快照已知反例（来自 `COORDINATOR-CHECKS.json`：**旧版**同一 scope 跨图状态不同） */
const DIAGNOSED_DIVERGENCE: Record<string, Record<string, string>> = {
  tatai: {
    "plan:cap:08": "functional=verified|architecture=pending_verification|module_map=verified",
    "plan:cap:09": "functional=verified|architecture=pending_verification|module_map=verified",
    "plan:cap:01": "architecture=pending_verification|module_map=verified",
    "plan:cap:07": "architecture=pending_verification|module_map=verified",
    "plan:cap:10": "architecture=pending_verification|module_map=verified",
    "plan:cap:12": "architecture=pending_verification|module_map=verified",
  },
  "示例项目": { "plan:cap:11": "functional=blocked|architecture=unmapped|module_map=blocked" },
};

/** 图节点的主状态键（`GraphObjectState.status_key`：六态 / `no_status_record` / `unmapped`） */
function nodeStatusOf(graph: unknown, id: string): string | null {
  const g = graph as { nodes?: { id: string; object?: { status_key?: string | null } }[] } | undefined;
  const n = (g?.nodes ?? []).find((x) => x.id === id);
  if (n === undefined) return null;
  return n.object?.status_key ?? null;
}

const projects = realProjects();
const wanted = ["tatai", "示例项目"].filter((id) => projects.some((p) => p.id === id));
if (wanted.length === 0) {
  skip("真项目对账：真实 registry 里没有 tatai/示例项目——真数据段跳过（不把读不到当通过）；机械段仍跑");
} else {
  for (const pid of wanted) {
    const proj = projects.find((p) => p.id === pid)!;
    const home = isolatedHome([{ id: proj.id, name: proj.id, path: proj.path, kind: proj.kind }]);
    let snapshot: ReturnType<typeof sixGraphsOf>;
    try {
      snapshot = sixGraphsOf(pid, { dataDir: home, mode: "full" });
    } catch (e) {
      skip(`${pid}：sixGraphsOf 读取失败（${(e as Error).message}）——不把读不到当通过`);
      fs.rmSync(home, { recursive: true, force: true });
      continue;
    }
    const capIds = Object.keys(snapshot.scope_readouts).filter((id) => id.startsWith("plan:cap:"));
    ok(capIds.length > 0, `${pid}：六图读口带出 scope_readouts（${capIds.length} 个范围，snapshot ${snapshot.snapshot_id}）`);
    ok(Array.isArray(snapshot.anomalies), `${pid}：anomalies 原样保留（${snapshot.anomalies.length} 条，不隐藏异常）`);

    // 逐 scope 跨六图一致：凡在 ≥2 张图出现的同一 id，主状态必须相等
    let checked = 0;
    const diverged: string[] = [];
    for (const cap of capIds) {
      const per = VIEWS.map((v) => ({ v, s: nodeStatusOf(snapshot.graphs[v], cap) })).filter((x) => x.s !== null);
      if (per.length < 2) continue;
      checked += 1;
      const uniq = new Set(per.map((x) => x.s));
      if (uniq.size > 1) diverged.push(`${cap}: ${per.map((x) => `${x.v}=${x.s}`).join("|")}`);
    }
    ok(
      diverged.length === 0,
      `${pid}：${checked} 个跨图出现的范围逐 id 同状态（0 差异${diverged.length === 0 ? "" : `；差异 ${diverged.slice(0, 3).join("；")}`}）`,
    );

    // 对照诊断快照：旧的差异对象现在应一致，且**状态由 canonical 投影给**（不是被折叠/隐藏）
    const diag = DIAGNOSED_DIVERGENCE[pid] ?? {};
    for (const [cap, oldDiff] of Object.entries(diag)) {
      const per = VIEWS.map((v) => nodeStatusOf(snapshot.graphs[v], cap)).filter((s): s is string => s !== null);
      const uniq = [...new Set(per)];
      const ro = snapshot.scope_readouts[cap];
      const canonicalKey = ro === undefined ? null : ro.available ? (ro.display ?? "unmapped") : null;
      ok(
        per.length >= 2 && uniq.length === 1 && ro !== undefined && ro.available && canonicalKey === uniq[0],
        `${pid} ${cap}：诊断差异已消失（旧 ${oldDiff} ⇒ 现全部 ${uniq.join("/")}，且＝canonical ${canonicalKey}）`,
      );
    }
    if (pid === "示例项目") {
      ok(snapshot.scope_readouts["plan:cap:11"]?.available === true, "示例项目 plan:cap:11：canonical 投影可用（不本地另算）");
      ok(
        (snapshot.scope_readouts["plan:cap:11"]?.scope_revision ?? "").length > 0,
        "示例项目 plan:cap:11：scope_revision 由成员＋检查定义派生（非空）",
      );
    }
    if (pid === "tatai") {
      const loopIds = Object.keys(snapshot.scope_readouts).filter((id) => id.startsWith("cap-loop-"));
      ok(
        loopIds.length > 0,
        `塔台：新功能范围（cap-loop-*）在六图读口**真实可读**（${loopIds.length} 个：${loopIds.slice(0, 3).join("、")}…）`,
      );
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// ══════════════════════ 夹具：canonical 判据正/反例 ══════════════════════

section("B/C. canonical 判据正例（集成全过⇒绿）与反例（失败⇒红、缺⇒不给绿）");

const ref = (locator: string) => [{ kind: "design_section" as const, path: "fixture.md", locator, sha256: null }];
const node = (id: string, kind: Blueprint["nodes"][number]["kind"], name: string): Blueprint["nodes"][number] => ({
  id,
  kind,
  name,
  source_refs: ref(id) as never,
  related_ids: [],
});
const edge = (
  source: string,
  target: string,
  kind: Blueprint["edges"][number]["kind"],
  certainty: Blueprint["edges"][number]["certainty"] = "declared",
): Blueprint["edges"][number] => ({ source, target, kind, certainty, source_refs: [] });

function fixtureBlueprint(): Blueprint {
  return {
    version: 1,
    baseline_id: "bl-featurescope",
    generator_version: "verify-feature-scope",
    generated_at: "2026-10-07T00:00:00+08:00",
    source_manifest: [],
    nodes: [
      node("plan:cap:01", "capability", "能力一"),
      node("plan:cap:nav", "capability", "中性章节（无关系）"),
      node("plan:task:TA", "task", "任务 TA"),
      node("plan:code:srcA", "module", "srcA"),
    ],
    edges: [
      edge("plan:task:TA", "plan:cap:01", "task_design_ref"),
      edge("plan:task:TA", "plan:code:srcA", "implementation_map", "observed"),
      edge("plan:cap:01", "plan:code:srcA", "model_inference", "inferred"),
    ],
    coverage: {
      design_sections: { total: 0, mapped: 0, unmapped: [] },
      plan_tasks: { total: 1, mapped: 1, unmapped: [] },
      code_modules: { total: 1, mapped: 1, unmapped: [] },
      nodes_total: 4,
      nodes_kept: 4,
      edges_total: 3,
      edges_kept: 3,
      note: "verify-feature-scope 夹具",
    },
    omitted: [],
    model_receipt: null,
    publish: { published: true, reason: null, validated_at: null },
    based_on: { model_key: "fixture", full_key: "fixture", design_content_sha256: null, plan_definition_sha256: null, semantic: false },
  } as unknown as Blueprint;
}

const REV = { code: "c1", plan: "p1", design: "d1" };

/** 一个范围 + 一个成员任务的 canonical 对象表（判据只在 projectStatuses） */
function canonicalPair(integrationState: "passed" | "failed" | "missing"): {
  objects: StatusObjectInput[];
  checks: CheckInput[];
} {
  const bp = fixtureBlueprint();
  const scopeObjects = scopeStatusObjectsOf({
    blueprint: bp,
    memberObjectIn: (oid) => oid === "TA" || oid === "module:srcA",
    integrationOf: () => [{ check_id: "chk-int-01", label: "跨模块集成检查", required: true }],
    integrationSourceOf: () => ({ source: "plan", revision: "p1", blocked_reason: null }),
  });
  const objects: StatusObjectInput[] = [
    {
      object_id: "TA",
      object_kind: "task",
      label: "任务 TA",
      executions: [{ task_id: "TA", status: "result_submitted", actor_id: "a", updated_at: "2026-10-07T00:00:00+08:00" }],
      required_checks: [{ check_id: "chk-ta-01", label: "卡内检查", required: true }],
      revisions: REV,
    },
    {
      object_id: "module:srcA",
      object_kind: "module",
      label: "srcA",
      children_ids: ["TA"],
      // 父级（模块）也要有自身集成检查证据才可能绿（§4.2：父级全部通过要求子项**及自身集成检查**通过）
      integration_checks: [{ check_id: "chk-int-mod-01", label: "模块自身集成检查", required: true }],
      integration_checks_source: "plan",
      integration_checks_revision: "p1",
      revisions: REV,
    },
    ...scopeObjects,
  ];
  const checks: CheckInput[] = [
    {
      check_id: "chk-ta-01",
      object_id: "TA",
      result: "passed",
      actor_id: "a",
      role: "executor",
      independence: "author_self",
      binding: { revision_kind: "code", revision: "c1" },
      // 读侧口径：没有证据哈希的「通过」不采信（E.3.2-2）——夹具给一个形态合法的证据哈希
      evidence_sha256: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
      method: "夹具：机械检查方法说明",
      at: "2026-10-07T00:00:00+08:00",
    },
  ];
  if (integrationState === "passed" || integrationState === "failed") {
    checks.push({
      check_id: "chk-int-01",
      object_id: "plan:cap:01",
      result: integrationState === "passed" ? "passed" : "failed",
      actor_id: "a",
      role: "executor",
      independence: "author_self",
      binding: { revision_kind: "code", revision: "c1" },
      // 读侧口径：没有证据哈希的「通过」不采信（E.3.2-2）——夹具给一个形态合法的证据哈希
      evidence_sha256: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
      method: "夹具：机械检查方法说明",
      at: "2026-10-07T00:00:00+08:00",
    });
    checks.push({
      check_id: "chk-int-mod-01",
      object_id: "module:srcA",
      result: integrationState === "passed" ? "passed" : "failed",
      actor_id: "a",
      role: "executor",
      independence: "author_self",
      binding: { revision_kind: "code", revision: "c1" },
      // 读侧口径：没有证据哈希的「通过」不采信（E.3.2-2）——夹具给一个形态合法的证据哈希
      evidence_sha256: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
      method: "夹具：机械检查方法说明",
      at: "2026-10-07T00:00:00+08:00",
    });
  }
  return { objects, checks };
}

function judge(integrationState: "passed" | "failed" | "missing") {
  const { objects, checks } = canonicalPair(integrationState);
  return projectStatuses({ objects, findings: [], checks, source_revision: REV }).by_id["plan:cap:01"];
}

{
  const green = judge("passed");
  ok(green.display_status === "verified", `正例：范围 required ＋ 自身集成检查全过 ⇒ verified（实得 ${green.display_status}）`);
  const failed = judge("failed");
  ok(
    failed.display_status === "blocked",
    `反例：集成检查 failed ⇒ **blocked（红，不是橙封顶）**（实得 ${failed.display_status}）`,
  );
  const missing = judge("missing");
  ok(
    missing.display_status !== "verified" && missing.display_status !== "blocked",
    `反例：缺集成检查证据 ⇒ 不给绿也不误判红（实得 ${missing.display_status}；封顶在待验证）`,
  );
  const ro = judge("passed");
  ok(
    scopeReadoutOf(ro, undefined).display === "verified" && scopeReadoutOf(ro, undefined).available === true,
    "读数适配：canonical verified 原样读出，不另算",
  );
  const none = scopeReadoutOf(null, undefined);
  ok(
    none.available === false && none.display === null,
    "未接入 canonical 投影 ⇒ 读数 available:false / display:null（未知，不造绿）",
  );
}

// ══════════════════════ D. 定义/源变 ⇒ 版本与状态 ══════════════════════

section("D. 相关源变需复验；无关源变不动；定义变 ⇒ scope_revision 变");

{
  const bp = fixtureBlueprint();
  const ledger = scopeMemberLedgerOf(bp, {
    checkDefinitionOf: (id) =>
      id === "plan:cap:01" ? [{ check_id: "chk-ta-01", definition_fingerprint: "fp-1", role: "required" }] : [],
  });
  const r1 = ledger["plan:cap:01"].scope_revision;
  const r1b = scopeMemberLedgerOf(fixtureBlueprint(), {
    checkDefinitionOf: () => [{ check_id: "chk-ta-01", definition_fingerprint: "fp-1", role: "required" }],
  })["plan:cap:01"].scope_revision;
  ok(r1 === r1b, `同事实两次派生 scope_revision 逐字节一致（${r1}）`);

  // 检查定义变（指纹变）⇒ scope_revision 变（旧包/旧游标失效）
  const r2 = scopeMemberLedgerOf(fixtureBlueprint(), {
    checkDefinitionOf: () => [{ check_id: "chk-ta-01", definition_fingerprint: "fp-2", role: "required" }],
  })["plan:cap:01"].scope_revision;
  ok(r1 !== r2, `检查定义变（指纹 fp-1→fp-2）⇒ scope_revision 变（${r1} → ${r2}）`);

  // 成员变化 ⇒ revision 变
  const bp2 = fixtureBlueprint();
  bp2.nodes.push(node("plan:task:TB", "task", "任务 TB"));
  bp2.edges.push(edge("plan:task:TB", "plan:cap:01", "task_design_ref"));
  const r3 = scopeMemberLedgerOf(bp2)["plan:cap:01"].scope_revision;
  ok(r3 !== scopeMemberLedgerOf(fixtureBlueprint())["plan:cap:01"].scope_revision, `成员集合变 ⇒ scope_revision 变`);

  // 无关源（模型推断边）不改成员账目 ⇒ revision 不变
  const bp3 = fixtureBlueprint();
  bp3.edges.push(edge("plan:cap:01", "plan:task:TA", "model_inference", "inferred"));
  ok(
    scopeMemberLedgerOf(bp3)["plan:cap:01"].scope_revision === scopeMemberLedgerOf(fixtureBlueprint())["plan:cap:01"].scope_revision,
    "无关源变（模型推断边）不改成员账目 ⇒ scope_revision 不变",
  );

  // 相关源变（代码版本）⇒ canonical 转待验证/需复验，不给绿
  const { objects, checks } = canonicalPair("passed");
  const moved = projectStatuses({
    objects: objects.map((o) => ({ ...o, revisions: { code: "c2" } })),
    findings: [],
    checks,
    source_revision: { code: "c2", plan: "p1", design: "d1" },
  }).by_id["plan:cap:01"];
  ok(moved.display_status !== "verified", `相关源变（code c1→c2）⇒ 需复验、不给绿（实得 ${moved.display_status}）`);

  // 无关源（plan 版本变但对象绑定 code）不动
  const unrelated = projectStatuses({
    objects,
    findings: [],
    checks,
    source_revision: { code: "c1", plan: "p9", design: "d1" },
  }).by_id["plan:cap:01"];
  ok(unrelated.display_status === "verified", `无关源变（plan p1→p9，对象绑 code）⇒ 状态不动（实得 ${unrelated.display_status}）`);

  const rev = scopeRevisionOf({ scope_id: "x", members: [{ id: "plan:task:TA", kind: "task", via: ["task_design_ref"] }] });
  ok(rev.startsWith("srev-"), `scope_revision 形态稳定（${rev}）`);
}

// ══════════════════════ E. 未接入不造绿（UI 只读适配） ══════════════════════

section("E. 未接入 canonical 投影 ⇒ 六图/画布如实未知（不本地按成员汇总造绿）");

{
  ok(
    canonicalScopeStatusOf(null).display === null && canonicalScopeStatusOf(null).unmapped_reason === "no_status_source",
    "canonicalScopeStatusOf(null) ⇒ 未知（no_status_source），不着完成色",
  );
  const bp = fixtureBlueprint();
  const projection = {
    TA: { object_id: "TA", mapping: "mapped", display_status: "verified", display_status_label: "绿" },
  } as never;
  const derivedNoScope = taskDerivedModuleStatus({ blueprint: bp, projection, declared_links: {} });
  ok(
    derivedNoScope.plan_status["plan:cap:01"]?.display === null,
    "技术三图：缺 canonical 范围投影 ⇒ 能力节点为未知（旧实现会按成员汇总成橙/绿——已撤）",
  );
  const vm = buildViewModel({ view: "functional", blueprint: bp, projection });
  const cap = vm.nodes.find((n) => n.id === "plan:cap:01");
  ok(cap !== undefined && cap.status.display === null, "功能全景：缺 canonical 范围投影 ⇒ 能力节点未知，不造绿");
  const vmScoped = buildViewModel({
    view: "functional",
    blueprint: bp,
    projection,
    scope_projection: { "plan:cap:01": { object_id: "plan:cap:01", mapping: "mapped", display_status: "verified" } } as never,
  });
  ok(
    vmScoped.nodes.find((n) => n.id === "plan:cap:01")?.status.display === "verified",
    "功能全景：给了 canonical 范围投影 ⇒ 原样读出 verified（只读适配）",
  );
}

// ══════════════════════ F. 成员账目（正式关系；中性/推断不给归属） ══════════════════════

section("F. 成员账目：正式关系与派生；模型推断/中性对象不产生成员");

{
  const bp = fixtureBlueprint();
  const ledger = scopeMemberLedgerOf(bp);
  ok(
    ledger["plan:cap:01"].member_ids.join(",") === "plan:code:srcA,plan:task:TA",
    `cap:01 成员 = 声明任务 ＋ 实测派生代码模块（${ledger["plan:cap:01"].member_ids.join("、")}）`,
  );
  ok(ledger["plan:cap:nav"].member_ids.length === 0, "中性对象没有成员（导航不制造义务）");
  ok(scopeMemberKindOf("plan:task:TA") === "task" && scopeMemberKindOf("plan:code:srcA") === "code", "成员种类只看稳定 ID 前缀");
  const declared = capabilityDeclaredMembersOf(bp.edges, new Set(["plan:cap:01"]));
  ok(
    declared["plan:cap:01"].join(",") === "plan:task:TA" && !declared["plan:cap:01"].includes("plan:code:srcA"),
    "声明成员口径不含二级派生（来源标注沿用同一份枚举）",
  );
  ok(
    scopeStatusObjectsOf({ blueprint: bp, memberObjectIn: (oid) => oid === "TA" })?.length === 2,
    "canonical 装配：逐能力产出 StatusObjectInput（含中性能力，成员空 ⇒ 未映射）",
  );
}

// ══════════════════════ G. 唯一 scope 版本算法（跨 feature-ledger / 六图 / UI 同值） ══════════════════════

section("G. `scope_revision` 唯一算法：义务层 scopeVersionOf ≡ 蓝图成员账目 scopeMemberLedgerOf");

{
  // 同一 scope（成员 + 检查定义指纹相同）在两条消费路径上必须**同值**：这是"合到同一 helper"的直接对账。
  // 蓝图侧只用 `task_design_ref` 声明关系（与声明区功能范围的成员归属同形），排除 `via` 口径差异。
  const oneTaskBp = {
    nodes: [node("plan:cap:09", "capability", "能力 09"), node("plan:task:TA", "task", "任务 TA")],
    edges: [edge("plan:task:TA", "plan:cap:09", "task_design_ref")],
  };
  const bpLedger = scopeMemberLedgerOf(oneTaskBp, {
    checkDefinitionOf: (id) =>
      id === "plan:cap:09" ? [{ check_id: "chk-ta-01", definition_fingerprint: "fp-1", role: "required" }] : [],
  });
  const viaLedger = bpLedger["plan:cap:09"].scope_revision;
  const defsOf = (fp: string, label: string) => [
    {
      check_id: "chk-ta-01",
      label,
      object_id: "TA",
      required: true,
      independence_required: false,
      stable: true,
      legacy_position_id: "TA::check:0",
      position: 0,
      definition_fingerprint: fp,
    },
  ];
  const viaVersion = scopeVersionOf({
    scope_id: "plan:cap:09",
    member_task_ids: bpLedger["plan:cap:09"].member_ids,
    required_check_ids: ["chk-ta-01"],
    integration_check_ids: [],
    task_checks: { TA: defsOf("fp-1", "**chk-ta-01 达标**") },
  }).scope_revision;
  ok(viaLedger === viaVersion, `六图成员账目与义务层 scopeVersionOf 同 scope **同值**（${viaLedger}）`);

  // 不同 scope ID ⇒ 版本串不同（不 alias 两种范围 ID）
  const elseId = scopeVersionOf({
    scope_id: "cap-loop-x",
    member_task_ids: ["TA"],
    required_check_ids: ["chk-ta-01"],
    integration_check_ids: [],
    task_checks: { TA: defsOf("fp-1", "**chk-ta-01 达标**") },
  }).scope_revision;
  ok(elseId !== viaVersion, "不同 scope_id（plan:cap 与 cap-loop）**不 alias**：版本串不同");

  // 检查定义变（同 ID 改语义 ⇒ 指纹变）⇒ 版本串变；**不能**只带 checkID
  const changed = scopeVersionOf({
    scope_id: "cap-loop-x",
    member_task_ids: ["TA"],
    required_check_ids: ["chk-ta-01"],
    integration_check_ids: [],
    task_checks: { TA: defsOf("fp-2", "**chk-ta-01 达标（语义已改）**") },
  }).scope_revision;
  ok(changed !== elseId, "同 stableID 检查定义变（指纹 fp-1→fp-2）⇒ scope_revision 变（不是只带 checkID）");

  // 定义里查不到这条检查：用 `missing:<id>` 如实标注（不是 null、也不是裸 checkID）——它与"有定义"不同值
  const missing = scopeVersionOf({
    scope_id: "cap-loop-x",
    member_task_ids: ["TA"],
    required_check_ids: ["chk-ta-99"],
    integration_check_ids: [],
    task_checks: { TA: defsOf("fp-1", "**chk-ta-01 达标**") },
  });
  const withDef = scopeVersionOf({
    scope_id: "cap-loop-x",
    member_task_ids: ["TA"],
    required_check_ids: ["chk-ta-99"],
    integration_check_ids: [],
    task_checks: {
      TA: [{ ...defsOf("fp-9", "**chk-ta-99 达标**")[0], check_id: "chk-ta-99" }],
    },
  });
  ok(
    missing.scope_revision !== withDef.scope_revision &&
      missing.checks[0].definition_fingerprint === "missing:chk-ta-99",
    `定义里没有该检查 ⇒ 如实 missing:<id>（不是 null／裸 checkID），且与「有定义」不同值（${missing.checks[0].definition_fingerprint}）`,
  );
}

console.log(`\n[verify] ── V09-55 六图同源聚合（返工） ${pass} PASS / ${fails.length} FAIL / ${skips.length} SKIP ──`);
if (skips.length > 0) for (const s of skips) console.log(`[verify]   SKIP ${s}`);
if (fails.length > 0) {
  for (const f of fails) console.log(`[verify]   FAIL ${f}`);
  process.exitCode = 1;
}
