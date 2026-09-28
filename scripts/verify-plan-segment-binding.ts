// plan 侧证据失效判定**分段化**验证脚本（2026-09-27）。
// 用法：pnpm verify:plan-segment-binding（或 npx tsx scripts/verify-plan-segment-binding.ts）
//
// 要证的事（把"整份文档哈希"细化为"单卡分段哈希"后，改一张卡不再让全图一起失效）：
//   ① 蓝图 plan_task 来源引用现在烙的是**该卡单卡定义哈希**（`shared/planCardHash.ts`），
//      不再是整份 `definition_sha256`；且纯 JS sha256 与 `node:crypto` 取值逐位相同
//      （跨进程指纹不变量——写侧读侧用不同实现算同一个哈希会永远对不上）。
//   ② 改**另一张卡**后重算蓝图：未改卡的 plan_task 引用不 stale、被改卡的 stale；
//      旧生成物里的「整份哈希引用」按 legacy 口径复核通过（不误杀全图），
//      真正对不上的值仍判 stale（不放行）。
//   ③ 投影层 `bindingStale`：任务自检绑**旧整份**哈希 + 只有别的卡变了 → 不 stale（分段复核通过）；
//      本卡变了 → stale；快照缺失 → 回退整份比对 stale；整份口径理由里写明走的是哪条。
//   ④ 依赖边（`A->B`）绑整份哈希、只有无关卡变了 → 不 stale（按 A、B 两张卡分段判）。
//   ⑤ **端到端接线**：真事件（进程内 WorkService 写自检记录）→ `collectProjectFacts` →
//      `projectStatuses`，T-1 的检查在只有别的卡变时仍 passed；T-3 本卡变了 → stale；
//      删掉快照文件 → 回退整份比对 → T-1 也 stale（宁严不松）。
//
// 隔离：`os.tmpdir()` 下的临时 TATAI_HOME + 夹具项目，不碰任何真实项目；收尾全清（`TATAI_KEEP_TMP=1` 保留现场）。
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { blueprintContextOf, blueprintSourcesFromTexts, deriveBlueprint, PLAN_PREFIX } from "../src/arch/blueprint";
import { sourceRefLocateOf } from "../src/arch/blueprintValidate";
import { buildSectionIndex, activateBaseline, designDefinitionText } from "../src/server/work/documents";
import { importTaskDefinitions } from "../src/server/work/plan";
import { taskDefinitionHash, definitionCanonical, sha256Hex as pureSha256Hex } from "../src/shared/planCardHash";
import {
  bindingStale,
  collectProjectFacts,
  projectFromFacts,
  planCardHashesOf,
  designSectionsOf,
  type BindingSegmentFacts,
} from "../src/server/work/statusProjection";
import { submitDefinitionImports } from "../src/server/work/tasks";
import { submitSelfCheck } from "../src/server/work/audit";
import { WorkService } from "../src/server/work/service";
import { projectWorkDir } from "../src/server/workstation";

let passCount = 0;
let failCount = 0;
const ok = (cond: boolean, label: string) => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (cond) passCount++;
  else {
    failCount++;
    process.exitCode = 1;
  }
};
const info = (msg: string) => console.log(`[verify] ${msg}`);
const nodeSha256 = (data: string | Buffer): string => crypto.createHash("sha256").update(data).digest("hex");

// ── 隔离环境与夹具 ──
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-plan-seg-verify-"));
const dataDir = path.join(tmpBase, "home");
const FIX = "plan-seg-fix";
const root = path.join(tmpBase, "proj");
const mkdirp = (d: string) => fs.mkdirSync(d, { recursive: true });
const write = (f: string, text: string) => {
  mkdirp(path.dirname(f));
  fs.writeFileSync(f, text, "utf8");
};
const workbench = path.join(root, ".工作台");
mkdirp(dataDir);
mkdirp(root);
write(
  path.join(dataDir, "registry.json"),
  JSON.stringify(
    {
      version: 1,
      projects: [
        {
          id: FIX,
          name: "plan 分段失效夹具",
          path: root,
          kind: "backend",
          registered_at: "2026-09-27T00:00:00+08:00",
          last_opened_at: "2026-09-27T00:00:00+08:00",
        },
      ],
    },
    null,
    2,
  ),
);
process.env.TATAI_HOME = dataDir;

const DESIGN_PATH = ".工作台/design.md";
const PLAN_PATH = ".工作台/plan.md";

// 设计书：§2 与 §3 两节；V2 只改 §3 正文（用于 design 分段断言）。
const DESIGN_V1 = ["# 分段夹具设计书", "", "## 1 概述", "概述正文。", "", "## 2 能力甲", "能力甲正文。", "", "## 3 能力乙", "能力乙正文。", ""].join("\n");
const DESIGN_V2 = DESIGN_V1.replace("能力乙正文。", "能力乙正文（改过）。");

// 施工图：T-1 / T-2 / T-3 三张独立卡（无依赖，便于"只改一张卡"）。
// section 形态与真实施工卡一致：`### T-x 标题` + 字段段 + `- [ ]` 检查项（读侧据此造 `T-x::check:0`）。
const card = (id: string, goal: string, body: string, design: string): string =>
  [`### ${id} ${goal}`, "", `**设计依据**：${design}。**契约**：${body}。`, "", `- [ ] ${goal}做出来`, "", `**交付**：${goal}验收记录。`, ""].join("\n");
const planTextWith = (goals: { t1: string; t2: string; t3: string }): string =>
  [
    "# 分段夹具施工图",
    "",
    "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |",
    "| --- | --- | --- | --- | --- |",
    `| T-1 | todo | ${goals.t1} |  | T-1 验收记录 |`,
    `| T-2 | todo | ${goals.t2} |  | T-2 验收记录 |`,
    `| T-3 | todo | ${goals.t3} |  | T-3 验收记录 |`,
    "",
    card("T-1", goals.t1, "输入甲，输出甲的产物", "§2"),
    card("T-2", goals.t2, "输入乙，输出乙的产物", "§3"),
    card("T-3", goals.t3, "输入丙，输出丙的产物", "§2"),
  ].join("\n");
const PLAN_V1 = planTextWith({ t1: "能力甲落成", t2: "能力乙落成", t3: "能力丙落成" });
const PLAN_V2 = planTextWith({ t1: "能力甲落成", t2: "能力乙落成", t3: "能力丙落成（改过一张卡）" });

const BASED_ON = { model_key: "fixture", full_key: "fixture", design_content_sha256: "d", plan_definition_sha256: null, semantic: false };
const OPTS = { is_tatai: false, code: { available: false, budget_exhausted: null, modules: [] }, names: {}, repo_root_files: [] as string[] | null };
const sourceOf = (designText: string, planText: string) =>
  blueprintSourcesFromTexts({ baseline_id: null, is_tatai: false, design: { path: DESIGN_PATH, text: designText }, plan: { path: PLAN_PATH, text: planText }, code: OPTS.code, names: OPTS.names, repo_root_files: OPTS.repo_root_files });

const planTaskRefOf = (bp: ReturnType<typeof deriveBlueprint>, taskId: string) => {
  const node = bp.nodes.find((n) => n.id === `${PLAN_PREFIX}task:${taskId}`);
  return node?.source_refs.find((r) => r.kind === "plan_task") ?? null;
};

try {
  // ═══════════ ①-⓪ 哈希不变量：纯 JS sha256 与 node:crypto 逐位相同 ═══════════
  info("── ①-⓪ 单卡哈希实现不变量（shared 纯 JS sha256 == node:crypto）");
  const hashSamples = ["", "a", "abc", "施工卡中文", "x".repeat(55), "y".repeat(56), "z".repeat(64), "w".repeat(4096)];
  ok(
    hashSamples.every((s) => pureSha256Hex(s) === nodeSha256(s)),
    `纯 JS sha256 与 node:crypto 在 ${hashSamples.length} 个样本上逐位相同（含 UTF-8 中文与 55/56/64 字节补位边界）`,
  );

  // ═══════════ ① planRef 烙单卡哈希 ═══════════
  info("── ① plan_task 来源引用烙该卡单卡定义哈希");
  const src1 = sourceOf(DESIGN_V1, PLAN_V1);
  const bp1 = deriveBlueprint(src1, { based_on: BASED_ON, generated_at: "2026-09-27T00:00:00+08:00" });
  const defs1 = importTaskDefinitions(PLAN_V1).definitions;
  const defOf = (id: string) => defs1.find((d) => d.task_id === id)!;
  const refT1 = planTaskRefOf(bp1, "T-1");
  ok(
    refT1 !== null &&
      refT1.sha256 === taskDefinitionHash(defOf("T-1")) &&
      refT1.sha256 === pureSha256Hex(JSON.stringify(definitionCanonical(defOf("T-1")))) &&
      refT1.sha256 === nodeSha256(JSON.stringify(definitionCanonical(defOf("T-1")))),
    `T-1 的 plan_task 引用 sha256 = ${refT1?.sha256?.slice(0, 12)}…（= taskDefinitionHash(T-1)，且 shared 纯 JS 实现与 node:crypto 逐位相同）`,
  );
  ok(
    refT1 !== null && src1.plan !== null && refT1.sha256 !== src1.plan.definition_sha256,
    `烙的不是整份 definition_sha256（引用 ${refT1?.sha256?.slice(0, 12)}… ≠ 整份 ${src1.plan?.definition_sha256?.slice(0, 12)}…）`,
  );

  // ═══════════ ② 改另一张卡 → 只有被改卡的引用 stale ═══════════
  info("── ② 改 T-3 后重算蓝图：T-1/T-2 不 stale，T-3 stale");
  const src2 = sourceOf(DESIGN_V1, PLAN_V2);
  const ctx2 = blueprintContextOf(src2);
  const bp2 = deriveBlueprint(src2, { based_on: BASED_ON, generated_at: "2026-09-27T00:01:00+08:00" });
  const verdictOfOldRef = (taskId: string) => {
    const ref = planTaskRefOf(bp1, taskId)!;
    return sourceRefLocateOf(ref, ctx2);
  };
  const v1 = verdictOfOldRef("T-1");
  const v2 = verdictOfOldRef("T-2");
  const v3 = verdictOfOldRef("T-3");
  ok(v1.located && !v1.stale, `T-1 引用仍有效（located=${v1.located} stale=${v1.stale}）——它没被改`);
  ok(v2.located && !v2.stale, `T-2 引用仍有效（located=${v2.located} stale=${v2.stale}）——它没被改`);
  ok(v3.located && v3.stale, `T-3 引用失效（located=${v3.located} stale=${v3.stale}）——本卡改了`);
  // 重算后的蓝图：未改卡的引用值逐位不变，被改卡的换了值
  const newT1 = planTaskRefOf(bp2, "T-1");
  const oldT1 = planTaskRefOf(bp1, "T-1");
  const newT3 = planTaskRefOf(bp2, "T-3");
  const oldT3 = planTaskRefOf(bp1, "T-3");
  ok(
    newT1?.sha256 === oldT1?.sha256 && newT3?.sha256 !== oldT3?.sha256,
    `重算后：T-1 引用哈希不变、T-3 引用哈希变了（${oldT3?.sha256?.slice(0, 8)}… → ${newT3?.sha256?.slice(0, 8)}…）`,
  );
  // 定位不到仍按失效口径：卡号不在当前施工图
  const ghost = sourceRefLocateOf({ kind: "plan_task", path: PLAN_PATH, locator: "T-404", sha256: oldT1?.sha256 ?? null }, ctx2);
  ok(!ghost.located, "卡号不在当前施工图 → located=false（维持「定位不到=失效」口径）");
  // legacy 整份引用：旧值 == 当前整份定义哈希 → 不误判 stale
  const legacy = sourceRefLocateOf(
    { kind: "plan_task", path: PLAN_PATH, locator: "T-1", sha256: src2.plan?.definition_sha256 ?? null },
    ctx2,
  );
  ok(
    legacy.located && !legacy.stale && (legacy.note ?? "").includes("legacy"),
    `旧生成物的整份哈希引用按 legacy 复核通过（stale=${legacy.stale}，理由="${legacy.note ?? "（无）"}"）`,
  );
  // 真正对不上的值（既不是本卡哈希、也不是整份）仍判 stale
  const bogus = sourceRefLocateOf({ kind: "plan_task", path: PLAN_PATH, locator: "T-1", sha256: "0".repeat(64) }, ctx2);
  ok(bogus.located && bogus.stale, "既非本卡哈希也非整份哈希的旧值仍判 stale（不放行）");

  // ═══════════ ③ 投影层 bindingStale（纯函数） ═══════════
  info("── ③ bindingStale：plan 按本对象卡分段判 stale");
  const shaV1 = nodeSha256(PLAN_V1);
  const segPlan: BindingSegmentFacts = {
    current_plan_cards: planCardHashesOf(PLAN_V2),
    current_design_sections: designSectionsOf(DESIGN_V1),
    snapshots: new Map([[`plan:${shaV1}`, { cards: planCardHashesOf(PLAN_V1) }]]),
    design_refs_of: new Map([
      ["T-1", ["§2"]],
      ["T-2", ["§3"]],
      ["T-3", ["§2"]],
    ]),
  };
  const bindingV1 = { revision_kind: "plan" as const, revision: shaV1 };
  const staleT1 = bindingStale(bindingV1, { current_revision: nodeSha256(PLAN_V2), object_id: "T-1", segments: segPlan });
  const staleT3 = bindingStale(bindingV1, { current_revision: nodeSha256(PLAN_V2), object_id: "T-3", segments: segPlan });
  ok(!staleT1.stale && staleT1.mode === "segment", `T-1 绑旧整份哈希、只有别的卡变了 → 不 stale（mode=${staleT1.mode}）——分段复核通过`);
  ok(staleT3.stale && staleT3.mode === "segment", `T-3 本卡变了 → stale（mode=${staleT3.mode}）`);
  ok(
    staleT3.why.includes("分段") && staleT3.why.includes("T-3") && /[0-9a-f]{8}…/.test(staleT3.why),
    `stale 理由人话且注明分段口径：${staleT3.why}`,
  );
  const noSnapshot = bindingStale(bindingV1, {
    current_revision: nodeSha256(PLAN_V2),
    object_id: "T-1",
    segments: { ...segPlan, snapshots: new Map() },
  });
  ok(noSnapshot.stale && noSnapshot.mode === "whole", `快照缺失 → 回退整份比对 stale（mode=${noSnapshot.mode}）`);
  const moduleObj = bindingStale(bindingV1, { current_revision: nodeSha256(PLAN_V2), object_id: "module:whatever", segments: segPlan });
  ok(moduleObj.mode === "whole", "对象不是卡/依赖边（module:…）→ 回退整份比对");

  // ═══════════ ④ 依赖边 A->B ═══════════
  info("── ④ 依赖边（A->B）按两张卡分段判");
  const edgeVerdict = bindingStale(bindingV1, { current_revision: nodeSha256(PLAN_V2), object_id: "T-1->T-2", segments: segPlan });
  const edgeVerdictHit = bindingStale(bindingV1, { current_revision: nodeSha256(PLAN_V2), object_id: "T-1->T-3", segments: segPlan });
  ok(!edgeVerdict.stale && edgeVerdict.mode === "segment", "T-1->T-2 边、只有无关卡 T-3 变了 → 不 stale");
  ok(edgeVerdictHit.stale && edgeVerdictHit.mode === "segment", "T-1->T-3 边、端点卡 T-3 变了 → stale");

  // ═══════════ ③-设计 分支：按对象的设计引用章节比节哈希 ═══════════
  info("── ③-设计 design 证据按本对象引用的章节分段判");
  const dshaV1 = nodeSha256(DESIGN_V1);
  const segDesign: BindingSegmentFacts = {
    current_plan_cards: planCardHashesOf(PLAN_V1),
    current_design_sections: designSectionsOf(DESIGN_V2),
    snapshots: new Map([[`design:${dshaV1}`, { sections: designSectionsOf(DESIGN_V1) }]]),
    design_refs_of: new Map([
      ["T-1", ["§2"]],
      ["T-2", ["§3"]],
    ]),
  };
  const dBinding = { revision_kind: "design" as const, revision: dshaV1 };
  const dT1 = bindingStale(dBinding, { current_revision: nodeSha256(DESIGN_V2), object_id: "T-1", segments: segDesign });
  const dT2 = bindingStale(dBinding, { current_revision: nodeSha256(DESIGN_V2), object_id: "T-2", segments: segDesign });
  ok(!dT1.stale && dT1.mode === "segment", "T-1 引 §2（未改）→ 不 stale（按引用章节分段）");
  ok(dT2.stale && dT2.mode === "segment", `T-2 引 §3（改了）→ stale（${dT2.why.slice(0, 70)}…）`);

  // ═══════════ ⑤ 端到端接线（真事件 → 投影） ═══════════
  info("── ⑤ 端到端：真自检事件 → collectProjectFacts → projectStatuses");
  write(path.join(workbench, "design.md"), DESIGN_V1);
  write(path.join(workbench, "plan.md"), PLAN_V1);
  const svc = new WorkService({ dataDir });
  submitDefinitionImports(svc, {
    project_id: FIX,
    change_id: "plan-seg-defs",
    actor_id: "verify-plan-segment-binding",
    role: "executor",
    definitions: defs1,
  });
  const shaV1OnDisk = nodeSha256(fs.readFileSync(path.join(workbench, "plan.md"), "utf8"));
  const evidenceHash = nodeSha256("夹具证据正文");
  for (const taskId of ["T-1", "T-3"]) {
    submitSelfCheck(svc, {
      project_id: FIX,
      change_id: "plan-seg-check",
      actor_id: "verify-plan-segment-binding",
      role: "executor",
      record_id: `plan-seg-${taskId}-1`,
      task_id: taskId,
      checked_by: "verify-plan-segment-binding",
      checks: [
        {
          check_id: `${taskId}::check:0`,
          method: "夹具：按本卡定义复核",
          evidence_sha256: evidenceHash,
          verifies: "document",
        },
      ],
      conclusion: "pass",
      binding: { revision_kind: "plan", revision: shaV1OnDisk },
    });
  }
  // 改 T-3（当前源前进），并把 V1 原文落成不可变快照（复核据此分段比对）
  write(path.join(workbench, "plan.md"), PLAN_V2);
  const snapshotRel = path.join(workbench, "plan-revisions", `${shaV1OnDisk}.md`);
  write(snapshotRel, PLAN_V1);

  const { facts: facts5, projection: p5 } = projectFromFacts(FIX, dataDir);
  const effOf = (id: string) => p5.by_id[id]?.evidence_basis.find((b) => b.check_id === `${id}::check:0`)?.effective;
  ok(facts5.binding_segments.snapshots.size === 1, `collectProjectFacts 装到了 1 份快照（plan:${shaV1OnDisk.slice(0, 8)}…）`);
  ok(effOf("T-1") === "passed", `T-1 自检绑旧整份哈希、只有 T-3 变了 → 仍 passed（effective=${effOf("T-1")}）`);
  ok(effOf("T-3") === "stale", `T-3 本卡变了 → stale（effective=${effOf("T-3")}）`);

  // 快照缺失 → 回退整份比对（宁严不松）
  fs.rmSync(snapshotRel);
  const p5b = projectFromFacts(FIX, dataDir).projection;
  const effT1b = p5b.by_id["T-1"]?.evidence_basis.find((b) => b.check_id === "T-1::check:0")?.effective;
  ok(effT1b === "stale", `删掉快照后 → 回退整份比对 → T-1 也 stale（effective=${effT1b}）`);

  // ═══════════ ⑥ 基线激活 + 设计书章节索引（顺带钉住不被改动） ═══════════
  info("── ⑥ 设计/施工稿与基线路径零回归");
  const sec = buildSectionIndex(designDefinitionText(DESIGN_V1));
  ok(sec.some((s) => s.title === "2 能力甲") && sec.some((s) => s.title === "3 能力乙"), `设计书章节索引正常（${sec.length} 节）`);
  const bl = activateBaseline(
    FIX,
    { approved_by: "user", approval_basis: "夹具隔离审定（不代表真实用户 Gate）", approval_kind: "user_confirmed" },
    dataDir,
  );
  ok(bl.created === true && bl.baseline.baseline_id !== "", `夹具基线可激活（created=${bl.created}、advance=${JSON.stringify(bl.advance)}）——本变更不碰写入结构`);
} catch (e) {
  ok(false, `验证中断：${(e as Error).message}`);
  console.error(e);
} finally {
  if (process.env.TATAI_KEEP_TMP === "1") info(`保留现场：${tmpBase}`);
  else {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    info(`夹具已清理：${path.basename(tmpBase)}`);
  }
  console.log(`\n[verify] plan 分段失效结果：${passCount} PASS / ${failCount} FAIL（exit ${process.exitCode ?? 0}）`);
}
