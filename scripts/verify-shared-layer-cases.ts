// 共同层反例夹具（B3+B4 收口；**只读诊断，不是门禁**）。
//
// 为什么单独一条：B3+B4 复审暴露的两个问题都在**共享读模型层**（`src/server/work/statusProjection.ts`，
// 属 B2／整合者写域，B3+B4 worker **无权改**）。本脚本把两件事钉成**可复现的最小反例**，供整合者修完
// 重新核验；它自己**不改**任何产品源、不写任何账本、不碰真实项目。
//
//   反例 A（pickCheckRecords）：一条**独立审计判失败**的记录，与一条作者自检通过记录同 check_id 时，
//     现状会挑**作者通过**——独立否决被埋掉。预期（DESIGN §5.6／附录 E.3.4「失败不随源漂移失效、
//     独立失败永远压住」）：独立失败必须当选。
//   反例 B（checkEffectiveness）：同一条失败记录被判成 `unknown` 而不是 `failed`——根因是
//     「当前修订拿不到 ⇒ unknown」那条分支对 `result === "failed"` 也生效（该分支本是为「不默认通过」写的）。
//   反例 C（V06-13 ⑥ 的根因，供对账）：契约 F4 下产品读口默认 `revisions.code = null`
//     （自报值只在 `code_declared`，**不参与**复核），于是**任何**绑 `code` 的检查都拿不到当前值：
//     通过记录判 `unknown`（不默认通过），失败记录**也**判 `unknown`（见反例 B）。这解释了
//     `scripts/verify-v06-13.ts` ⑥ 的 6 项长期失败（冻结基线同样 78/6）。
//
//   **期望口径（2026-10-07 收口修正）**：A、B 是**缺陷**（修复后应 NOT-REPRODUCED）；C 是 F4
//   既定的 **fail-closed 正确行为**（通过但无源清单载体 ⇒ 待复核 ⇒ **应当** REPRODUCED，是一条第
//   三档的**预期负例**，不是缺陷；放宽它才是制造假绿）。故 `--expect=fixed` 判据是：A/B 不得复现、
//   C **必须**复现；任一条不符才 exit 1。
//
// 用法：
//   node <tsx> scripts/verify-shared-layer-cases.ts            → 打印现状快照，永远 exit 0（诊断）
//   node <tsx> scripts/verify-shared-layer-cases.ts --expect=fixed → A/B 缺陷已修且 C 负例仍在；否则 exit 1
import { checkEffectiveness, pickCheckRecords, type CheckInput, type SourceRevisions } from "../src/server/work/statusProjection";

const sha = (c: string): string => c.repeat(64).slice(0, 64);
const authorIds = new Set(["author-1"]);
const T1 = "2026-10-07T09:00:00.000Z";
const T2 = "2026-10-07T09:30:00.000Z";

/** 作者自检通过（带有效源清单载体 ⇒ 现读复核通过 ⇒ effective=passed） */
const authorPassed: CheckInput = {
  check_id: "T-1::c1",
  object_id: "T-1",
  result: "passed",
  actor_id: "author-1",
  role: "executor",
  independence: "author_self",
  binding: { revision_kind: "code", revision: "fp-deadbeef" },
  evidence_sha256: sha("a"),
  at: T1,
  method: "在夹具上跑了该检查对应的验证",
  source_manifest: {
    status: "valid",
    declared_count: 1,
    changed: [],
    missing: [],
    unreadable: [],
    current_fingerprint: "fp-deadbeef",
    reason: "清单覆盖的源码与登记时一致",
  },
};

/** 非作者独立审计判失败（绑 code，但**没有**源清单载体 —— 这正是历史审计记录的常态） */
const auditorFailed: CheckInput = {
  check_id: "T-1::c1",
  object_id: "T-1",
  result: "failed",
  actor_id: "auditor-1",
  role: "auditor",
  independence: "independent",
  binding: { revision_kind: "code", revision: "code-rev-A" },
  evidence_sha256: sha("b"),
  at: T2,
  record_ref: "audit:au-1",
  ledger_seq: 42,
  record_findings: ["find-1"],
};

/** 产品读口默认：`code` 拿不到当前值（契约 F4），自报值只在 code_declared */
const readPathRevisions: SourceRevisions = { design: sha("d"), plan: sha("p"), plan_definition: sha("q"), code: null, code_declared: "code-rev-A" };
/** 对照：显式给了当前代码版本（`projectFromFacts(..., { code_revision })`） */
const withCodeRevision: SourceRevisions = { ...readPathRevisions, code: "code-rev-A" };

// `expect`：`fixed` = 缺陷，修复后应 NOT-REPRODUCED；`negative` = 预期 fail-closed 负例，应 REPRODUCED
const results: { name: string; reproduced: boolean; expect: "fixed" | "negative"; detail: unknown }[] = [];

function caseA(): void {
  const buggy = mapWinner(readPathRevisions);
  const contrast = mapWinner(withCodeRevision);
  const reproduced = buggy.result === "passed" && buggy.actor_id === "author-1";
  results.push({ name: "A pickCheckRecords 作者 passed 盖过独立 failed", reproduced, expect: "fixed", detail: { 产品读口默认: buggy, 显式给code_revision: contrast } });
}

function caseB(): void {
  const eff = checkEffectiveness(auditorFailed, readPathRevisions, authorIds, null);
  const reproduced = eff.effective === "unknown";
  results.push({ name: "B failed 记录因 code=null 被判 unknown（不是 failed）", reproduced, expect: "fixed", detail: { effective: eff.effective, why: eff.why } });
}

function caseC(): void {
  // 同一条「通过」记录（无源清单载体），只改读口给不给当前 code 修订：
  const rec = { ...authorPassed, source_manifest: null, binding: { revision_kind: "code" as const, revision: "code-rev-A" } };
  const viaRead = checkEffectiveness(rec, readPathRevisions, authorIds, null);
  const viaCode = checkEffectiveness(rec, withCodeRevision, authorIds, null);
  const reproduced = viaRead.effective === "unknown" && viaCode.effective === "passed";
  results.push({
    name: "C 产品读口默认 code=null ⇒ 无源清单载体的 code 检查一律 unknown（F4 既定 fail-closed，**预期复现**）",
    reproduced,
    expect: "negative",
    detail: { 产品读口默认: viaRead.effective, 显式给code_revision: viaCode.effective, why: viaRead.why },
  });
}

function mapWinner(rev: SourceRevisions): { result: string; actor_id: string } {
  const picked = pickCheckRecords([authorPassed, auditorFailed], authorIds, rev, null).get("T-1::c1");
  return { result: String(picked?.result ?? "<none>"), actor_id: String(picked?.actor_id ?? "<none>") };
}

caseA();
caseB();
caseC();

console.log("[counterexample] 共享读模型层反例快照（只读诊断；statusProjection.ts 属共享写域，本脚本不改它）");
for (const r of results) {
  const tag = r.expect === "fixed" ? (r.reproduced ? "DEFECT-REPRODUCED" : "NOT-REPRODUCED(ok)") : r.reproduced ? "NEGATIVE-CONFIRMED(ok)" : "NEGATIVE-LOST(defect)";
  console.log(`[counterexample] ${tag} ${r.name}`);
  console.log(`[counterexample]   现场：${JSON.stringify(r.detail)}`);
}
const defects = results.filter((r) => r.expect === "fixed" && r.reproduced);
const lostNegatives = results.filter((r) => r.expect === "negative" && !r.reproduced);
const confirmedNegatives = results.filter((r) => r.expect === "negative" && r.reproduced);
console.log(
  `[counterexample] 小结：A/B 缺陷仍复现 ${defects.length}/${results.filter((r) => r.expect === "fixed").length}（预期 0）；` +
    `C 预期负例已确认 ${confirmedNegatives.length}/${results.filter((r) => r.expect === "negative").length}（预期全确认）`,
);

const expectFixed = process.argv.includes("--expect=fixed");
if (expectFixed && (defects.length > 0 || lostNegatives.length > 0)) {
  console.log(
    "[counterexample] --expect=fixed：A/B 缺陷仍复现，或 F4 预期负例丢失（被放宽）⇒ exit 1",
  );
  process.exit(1);
}
