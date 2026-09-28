// V09-01 验证脚本（tsx 跑）：判绿证据采信与检查记录一致性（DESIGN.md 附录 E.3.2／E.3.3／E.3.4／E.3.5）。
// 用法：pnpm verify:v09-01
//
// 隔离口径（本脚本自己守）：**所有写侧测试都落在 `os.tmpdir()` 的夹具项目 + 夹具 TATAI_HOME**，
// 一个事件都不写真实 `.工作台`；真实账本只读，且脚本首尾比对它的 sha256（变了就报 FAIL——
// 说明有东西写了真实账本，要么是本脚本的缺陷，要么是有并发运行的写入服务）。
//
// 覆盖（每条对着卡面检查项与附录条款）：
//   ① 写侧拒收（只对带 `command` 的检查）：`conclusion=pass` 且带 `command` 的 check
//      `exit_code≠0`／缺 `exit_code` ⇒ `EVENT_INVALID` 且**零写入**；`exit_code=0` 不受影响（正例）；
//      `conclusion=fail` + `exit_code≠0` 如实记录（失败不被"退出码校验"误伤）；
//      不带 `command` 的检查走「证据＋方法」档（证据与方法两缺才拒；给了 per-check method 或
//      记录层 coverage/method_limits 的不被拒）。
//   ② 读侧不采信（同档 fail-closed）：投影 `CheckInput` 带 `command`/`exit_code`/`method`/记录层方法；
//      带 `command` 的矛盾记录 `effective≠passed` 并点名原因；不带 `command` 的检查不因缺 `exit_code`
//      或缺 per-check `method` 失效；`evidence_basis` 里能看到 `exit_code`、command 与来源方法。
//   ③ 独立复核与 `quality` 分层：自检-only ⇒ `mechanical_passed` + 点名「通过项全部来自作者自检」；
//      补一条非作者复核记录 ⇒ `audit_passed`（正反对照）；混合 ⇒ `mechanical_passed` + 点名差多少；
//      同会话声明的"独立"记录降级（不到 `audit_passed`）；先读作者摘要／一记录一哈希如实标注但不废除。
//   ④ 独立审计记录口径（E.3.4）：真实账本 227 条一条不整批失效；13 条同会话逐条点名列明。
//   ⑤ 绑定与对象相符（E.3.3）：`code`/`artifact` 声明绑 `plan`/`design` 修订 ⇒ 拒收；
//      文档本身检查绑 `plan` **合法**（不得误拒）；不声明 ⇒ 历史 79 条 plan 绑定不整批转红；
//      绑定种类不是合法四值之一 ⇒ 拒（G-02 根因①）。
//   ⑥ U3／`src-tauri` 处置（E.3.5）：真实账本那 8 条/23 行矛盾检查**不再有效通过**、历史事件原样在册；
//      U3 经 V09-04 同源重打＋复跑 verify:u3 后按「绿⇔当前全部必需证据有效」判绿（quality=mechanical_passed，
//      非 audit_passed、非矛盾记录染回；H-2 定向更新，判据不放宽）；成员未全绿时模块 `plan:code:src-tauri` 不给绿；
//      夹具正反对照证明因果。
//   ⑦ 门槛与回归：真实账本两条对照（矛盾记录 8 条/23 行、独立审计 227 条）＋本文件全 PASS。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { WorkService } from "../src/server/work/service";
import { loadEvents } from "../src/server/work/eventStore";
import { WorkError, type WorkEvent } from "../src/server/work/types";
import { foldAuditRecords } from "../src/server/work/audit";
import {
  checkEffectiveness,
  checksFromAudit,
  collectProjectFacts,
  objectsFromFacts,
  projectStatuses,
  type CheckInput,
  type StatusObjectInput,
  type StatusProjectionSet,
} from "../src/server/work/statusProjection";
import type { EvidenceBinding } from "../src/server/work/evidence";
import { deriveBlueprint, readBlueprint, type Blueprint } from "../src/arch/blueprint";
import { MODULE_VERIFIED_SHORT, taskDerivedModuleStatus } from "../src/ui/arch/projectGraph";

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
const sha256File = (f: string): string | null =>
  fs.existsSync(f) ? crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex") : null;

/** 五视角覆盖矩阵（独立审计夹具用；与 §5.5 的找错环同形） */
const COVERAGE = [
  { area: "behavior_boundaries", status: "checked", basis: "逐条复跑验收命令" },
  { area: "data_concurrency", status: "not_applicable", basis: "本卡无并发写" },
  { area: "interface_integration", status: "checked", basis: "接口调用方" },
  { area: "failure_recovery", status: "checked", basis: "断点重跑" },
  { area: "trust_permission", status: "checked", basis: "无越权读" },
];

// ── 真实账本（只读；本脚本绝不向它写一个字节）──
const REAL_DATA_DIR =
  (process.env.TATAI_HOME ?? "").trim() !== "" ? process.env.TATAI_HOME!.trim() : path.join(os.homedir(), ".tatai");
const REAL_PROJECT = "tatai";
const realLedger = (() => {
  try {
    const reg = JSON.parse(fs.readFileSync(path.join(REAL_DATA_DIR, "registry.json"), "utf8")) as {
      projects?: { id?: unknown; path?: unknown }[];
    };
    const hit = (reg.projects ?? []).find((p) => p.id === REAL_PROJECT);
    if (typeof hit?.path !== "string") return null;
    const file = path.join(hit.path, ".工作台", "work", "events.jsonl");
    return fs.existsSync(file) ? { root: hit.path, file } : null;
  } catch {
    return null;
  }
})();
const realLedgerHashBefore = realLedger === null ? null : sha256File(realLedger.file);
info(`真实账本：${realLedger === null ? "（本机取不到 tatai 账本，真实数据对照段将 SKIP）" : realLedger.file}`);
info(`真实账本 sha256（测试前）：${realLedgerHashBefore ?? "n/a"}`);

// ── 隔离夹具（临时 TATAI_HOME + 夹具项目；不碰真实注册表与任何真实项目）──
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-v09-01-"));
const dataDir = path.join(tmpBase, "home");
const projRoot = path.join(tmpBase, "proj");
fs.mkdirSync(path.join(projRoot, ".工作台"), { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });
const PROJECT = "v09-01-fixture";
fs.writeFileSync(
  path.join(dataDir, "registry.json"),
  JSON.stringify({
    version: 1,
    projects: [
      {
        id: PROJECT,
        name: "V09-01 采信判据夹具",
        path: projRoot,
        kind: "backend",
        registered_at: "2026-09-24T00:00:00+08:00",
        last_opened_at: "2026-09-24T00:00:00+08:00",
      },
    ],
  }),
);
// 写侧测试一律走夹具数据目录：产品代码里任何"取全局数据目录"的路径都落在这里
process.env.TATAI_HOME = dataDir;

const service = new WorkService({ dataDir });
const workDir = path.join(projRoot, ".工作台", "work");
const eventCount = (): number => loadEvents(workDir).events.length;
const PLAN_REV = "plan-rev-fixture-a";
const CODE_REV = "code-rev-fixture-a";
const ACTOR = "v09-01-verify";

/** 直连提交一条自检记录：返回 {accepted, code, message}——被拒不许写一个字节 */
const trySelfCheck = (
  payload: Record<string, unknown>,
  key: string,
): { accepted: boolean; code: string | null; message: string } => {
  try {
    service.submit({
      schema_version: 2,
      project_id: PROJECT,
      change_id: "change-v09-01",
      actor_id: ACTOR,
      role: "executor",
      entity_id: `check:${key}`,
      type: "audit.self_check_recorded",
      payload,
      expected_revision: null,
      idempotency_key: `audit.self_check_recorded:${key}:change-v09-01`,
    });
    return { accepted: true, code: null, message: "" };
  } catch (e) {
    if (e instanceof WorkError) return { accepted: false, code: e.code, message: e.message };
    throw e;
  }
};

// ═════════════ ① 写侧拒收（只对带 `command` 的检查；E.3.2 第一档） ═════════════
console.log("[verify] ═══ ① 写侧拒收：conclusion=pass 与带 command 的 exit_code 不得矛盾 ═══");
{
  const before = eventCount();
  const r = trySelfCheck(
    {
      checked_by: ACTOR,
      task_id: "T-1",
      checks: [{ check_id: "T-1::check:0", method: "跑验收脚本", command: "pnpm verify:x", exit_code: 1, evidence_sha256: "e".repeat(64) }],
      conclusion: "pass",
      binding: { revision_kind: "plan", revision: PLAN_REV },
    },
    "sc-exit-nonzero",
  );
  ok(
    !r.accepted && r.code === "EVENT_INVALID" && eventCount() === before,
    `① 带 command 且 exit_code=1 的「通过」⇒ EVENT_INVALID、零写入（实际 ${r.accepted ? "被接受落盘" : `code=${r.code}`}，事件数 ${eventCount()}/${before}）`,
  );
  ok(String(r.message).includes("退出码"), "① 拒绝理由点名退出码（不是「记录不合法」这种含糊话）");
}
{
  const before = eventCount();
  const r = trySelfCheck(
    {
      checked_by: ACTOR,
      task_id: "T-1",
      checks: [{ check_id: "T-1::check:0", method: "跑验收脚本", command: "pnpm verify:x", evidence_sha256: "e".repeat(64) }],
      conclusion: "pass",
      binding: { revision_kind: "plan", revision: PLAN_REV },
    },
    "sc-exit-missing",
  );
  ok(
    !r.accepted && r.code === "EVENT_INVALID" && eventCount() === before,
    `① 带 command 但缺 exit_code 的「通过」⇒ EVENT_INVALID、零写入、不静默当 0（code=${r.code ?? "接受"}）`,
  );
}
{
  const before = eventCount();
  const r = trySelfCheck(
    {
      checked_by: ACTOR,
      task_id: "T-1",
      checks: [{ check_id: "T-1::check:0", method: "跑验收脚本", command: "pnpm verify:x", exit_code: 0, evidence_sha256: "e".repeat(64), verifies: "code" }],
      conclusion: "pass",
      binding: { revision_kind: "code", revision: CODE_REV },
    },
    "sc-exit-zero",
  );
  ok(r.accepted && eventCount() === before + 1, `① 正例：exit_code=0 的正常记录不受影响（已落盘，事件数 ${eventCount()}）`);
}
{
  const before = eventCount();
  const r = trySelfCheck(
    {
      checked_by: ACTOR,
      task_id: "T-2",
      checks: [{ check_id: "T-2::check:0", method: "跑红脚本", command: "pnpm verify:u3", exit_code: 1, evidence_sha256: "e".repeat(64) }],
      conclusion: "fail",
      binding: { revision_kind: "plan", revision: PLAN_REV },
    },
    "sc-fail-nonzero",
  );
  ok(r.accepted && eventCount() === before + 1, "① 反例：conclusion=fail + exit_code≠0 如实记录（失败与非零退出码并不矛盾，不被误拒）");
}

console.log("[verify] ═══ ①′ 不带 command 的检查：证据＋方法档（E.3.2 第二档）═══");
{
  const before = eventCount();
  const r = trySelfCheck(
    { checked_by: ACTOR, task_id: "T-3", checks: [{ check_id: "T-3::check:0" }], conclusion: "pass", binding: { revision_kind: "plan", revision: PLAN_REV } },
    "sc-bare-pass",
  );
  ok(
    !r.accepted && r.code === "EVENT_INVALID" && eventCount() === before,
    `①′ 不带 command 且证据、方法两缺的「通过」⇒ EVENT_INVALID、零写入（code=${r.code ?? "接受"}）`,
  );
}
{
  const before = eventCount();
  const r = trySelfCheck(
    {
      checked_by: ACTOR,
      task_id: "T-3",
      checks: [{ check_id: "T-3::check:0", method: "人工审阅原文（不跑命令）", verifies: "document" }],
      conclusion: "pass",
      binding: { revision_kind: "plan", revision: PLAN_REV },
    },
    "sc-method-only",
  );
  ok(r.accepted && eventCount() === before + 1, "①′ 反例：不给 command、只给 per-check method 的记录**不被拒**（卡面点名的不许误拒）");
}
{
  const before = eventCount();
  const r = trySelfCheck(
    {
      checked_by: ACTOR,
      task_id: "T-3",
      checks: [{ check_id: "T-3::check:1", verifies: "document" }],
      coverage: [{ area: "behavior_boundaries", status: "checked", basis: "逐条读原文核对边界" }],
      method_limits: ["只做静态审阅，不含真机长跑"],
      conclusion: "pass",
      binding: { revision_kind: "plan", revision: PLAN_REV },
    },
    "sc-record-layer-method",
  );
  ok(r.accepted && eventCount() === before + 1, "①′ 方法可来自**记录层** `coverage`/`method_limits`（二选一即可，不被拒）");
}

// ═════════════ ② 读侧采信（同一份分档判据；E.3.2-2） ═════════════
console.log("[verify] ═══ ② 读侧不采信：同档 fail-closed，且不误伤不带 command 的检查 ═══");
{
  const mk = (over: Partial<CheckInput>): CheckInput => ({
    check_id: "K::check:0",
    object_id: "K",
    result: "passed",
    actor_id: "exec-x",
    role: "executor",
    independence: "author_self",
    binding: { revision_kind: "plan", revision: PLAN_REV },
    evidence_sha256: "f".repeat(64),
    at: "2026-09-24T00:00:00+08:00",
    ...over,
  });
  const revs = { plan: PLAN_REV, code: CODE_REV };
  const authors = new Set<string>(["exec-x"]);

  const conflicting = checkEffectiveness(mk({ command: "pnpm verify:u3", exit_code: 1 }), revs, authors);
  ok(
    conflicting.effective === "unknown" && conflicting.why.includes("退出码"),
    `② 带 command 的矛盾（exit_code=1）⇒ effective=${conflicting.effective}（不计入 passed）并点名退出码`,
  );
  const missingExit = checkEffectiveness(mk({ command: "pnpm verify:x", exit_code: null }), revs, authors);
  ok(missingExit.effective === "unknown" && missingExit.why.includes("退出码"), `② 声明了命令但缺退出码 ⇒ effective=${missingExit.effective}、不静默当 0`);
  const zeroExit = checkEffectiveness(mk({ command: "pnpm verify:x", exit_code: 0 }), revs, authors);
  ok(zeroExit.effective === "passed", `② 正例：exit_code=0 ⇒ effective=${zeroExit.effective}（不误伤正常记录）`);
  const noCommand = checkEffectiveness(mk({}), revs, authors);
  ok(
    noCommand.effective === "passed" && noCommand.independence_notes.length === 0,
    `② 不带 command、无 exit_code、**也没有 per-check method** 但有证据 ⇒ effective=${noCommand.effective}（**不因缺 exit_code 失效**）`,
  );
  const auditNoMethod = checkEffectiveness(
    mk({
      actor_id: "auditor-y",
      independence: "independent",
      method: "独立审计 audit-x",
      record_method: "覆盖：behavior_boundaries(checked)：逐条读原文",
      audit_independence: { record_id: "audit-x", same_session_as_author: false, read_author_summary_first: false, one_hash_per_record: false },
    }),
    revs,
    authors,
  );
  ok(
    auditNoMethod.effective === "passed",
    `② 既有独立审计口径（无 command/exit_code、无 per-check method、方法在记录层）⇒ effective=${auditNoMethod.effective}（**不整批失效**）`,
  );
  const noEvidence = checkEffectiveness(mk({ evidence_sha256: null }), revs, authors);
  ok(noEvidence.effective === "unknown" && noEvidence.why.includes("没证据"), "② 无证据哈希的「通过」仍记 unknown（保持既有口径，不默认通过）");
}

// ═════════════ ⑤ 绑定与被验对象相符（E.3.3） ═════════════
console.log("[verify] ═══ ⑤ 绑定 revision_kind 必须跟随被验对象的真实来源（E.3.3）═══");
{
  const before = eventCount();
  const r = trySelfCheck(
    {
      checked_by: ACTOR,
      task_id: "T-4",
      checks: [{ check_id: "T-4::check:0", method: "跑真机验收脚本", command: "pnpm verify:t4", exit_code: 0, evidence_sha256: "a".repeat(64), verifies: "code" }],
      conclusion: "pass",
      binding: { revision_kind: "plan", revision: PLAN_REV },
    },
    "sc-code-bound-plan",
  );
  ok(
    !r.accepted && r.code === "EVENT_INVALID" && eventCount() === before && String(r.message).includes("绑定"),
    `⑤ 声明验的是代码行为、却只绑 plan 修订 ⇒ EVENT_INVALID、零写入（code=${r.code ?? "接受"}）`,
  );
}
{
  const before = eventCount();
  const r = trySelfCheck(
    {
      checked_by: ACTOR,
      task_id: "T-4",
      checks: [{ check_id: "T-4::check:1", method: "核对安装包哈希", command: "sha256sum pkg", exit_code: 0, evidence_sha256: "b".repeat(64), verifies: "artifact" }],
      conclusion: "pass",
      binding: { revision_kind: "design", revision: "design-rev-a" },
    },
    "sc-artifact-bound-design",
  );
  ok(!r.accepted && r.code === "EVENT_INVALID" && eventCount() === before, `⑤ 产物检查只绑 design 修订 ⇒ 同样拒（code=${r.code ?? "接受"}）`);
}
{
  const before = eventCount();
  const r = trySelfCheck(
    {
      checked_by: ACTOR,
      task_id: "T-4",
      checks: [{ check_id: "T-4::check:2", method: "核对施工图条款与实现一致", evidence_sha256: "c".repeat(64), verifies: "document" }],
      conclusion: "pass",
      binding: { revision_kind: "plan", revision: PLAN_REV },
    },
    "sc-document-bound-plan",
  );
  ok(r.accepted && eventCount() === before + 1, "⑤ 反例：被验对象**就是那份文档**时，文档修订绑定合法（不得被误拒）");
}
{
  const before = eventCount();
  const r = trySelfCheck(
    {
      checked_by: ACTOR,
      task_id: "T-4",
      checks: [{ check_id: "T-4::check:3", method: "跑实现验收", command: "pnpm verify:t4", exit_code: 0, evidence_sha256: "d".repeat(64), verifies: "code" }],
      conclusion: "pass",
      binding: { revision_kind: "code", revision: CODE_REV },
    },
    "sc-code-bound-code",
  );
  ok(r.accepted && eventCount() === before + 1, "⑤ 正例：代码检查绑源码内容指纹（revision_kind=code）⇒ 接受");
}
{
  const before = eventCount();
  const r = trySelfCheck(
    {
      checked_by: ACTOR,
      task_id: "T-4",
      checks: [{ check_id: "T-4::check:4", method: "跑验收", command: "pnpm verify:t4", exit_code: 0, evidence_sha256: "d".repeat(64) }],
      conclusion: "pass",
      binding: { revision_kind: "doc", revision: "whatever" },
    },
    "sc-bad-kind",
  );
  ok(
    !r.accepted && r.code === "EVENT_INVALID" && eventCount() === before && String(r.message).includes("revision_kind"),
    "⑤ 绑定种类不是合法四值之一 ⇒ 拒（G-02 根因①：旧实现把任意字符串当 RevisionKind 用）",
  );
}
{
  // V09-01 收口（任务书 2026-09-24）：新写入的通过检查必须声明被验对象（verifies），否则代码/产物
  // 检查能拿 plan/design 修订冒充源码证据。写侧拒收；读侧对历史形态记录（无 verifies 字段）照旧采信、不追溯。
  const before = eventCount();
  const r = trySelfCheck(
    {
      checked_by: ACTOR,
      task_id: "T-5",
      checks: [{ check_id: "T-5::check:0", method: "照历史口径自检", command: "pnpm verify:t5", exit_code: 0, evidence_sha256: "e".repeat(64) }],
      conclusion: "pass",
      binding: { revision_kind: "plan", revision: PLAN_REV },
    },
    "sc-legacy-plan-binding",
  );
  ok(
    !r.accepted && r.code === "EVENT_INVALID" && eventCount() === before && String(r.message).includes("verifies"),
    `⑤′ 新写入的通过检查不声明被验对象 ⇒ EVENT_INVALID、零写入（code=${r.code ?? "接受"}；不声明就核对不了绑定是否跟随被验对象）`,
  );
  const eff = checkEffectiveness(
    {
      check_id: "T-5::check:0",
      object_id: "T-5",
      result: "passed",
      actor_id: ACTOR,
      role: "executor",
      independence: "author_self",
      binding: { revision_kind: "plan", revision: PLAN_REV },
      evidence_sha256: "e".repeat(64),
      at: "2026-09-24T00:00:00+08:00",
      command: "pnpm verify:t5",
      exit_code: 0,
    },
    { plan: PLAN_REV },
    new Set([ACTOR]),
  );
  ok(
    eff.effective === "passed",
    "⑤′ 读侧对历史形态记录（无 verifies 字段）照旧采信、不整批转红（E.3.3-3；写侧新闸只拦新写入）",
  );
}

// ═════════════ ③④⑥ 端到端投影（事件重放 → 折叠 → 采信 → 判绿） ═════════════
console.log("[verify] ═══ ③④⑥ 端到端投影：quality 分层、独立审计盲点、矛盾记录不判绿 ═══");

/** 一条**历史形态**的自检事件（照 2026-09-23 回填记录的形状：conclusion=pass ＋ exit_code=1） */
const historicalSelfCheck = (input: {
  record_id: string;
  task: string;
  conclusion: "pass" | "fail";
  checks: { check_id: string; command: string | null; exit_code: number | null; evidence_sha256: string | null; method?: string }[];
  binding?: { revision_kind: string; revision: string } | null;
  actor?: string;
}): WorkEvent => ({
  schema_version: 2,
  event_id: crypto.randomUUID(),
  project_id: PROJECT,
  change_id: "change-v09-01-replay",
  entity_id: `check:${input.record_id}`,
  entity_revision: 1,
  seq: 1,
  type: "audit.self_check_recorded",
  actor_id: input.actor ?? "exec-x",
  role: "executor",
  occurred_at: "2026-09-23T21:10:00+08:00",
  received_at: "2026-09-23T21:10:00+08:00",
  idempotency_key: `replay:${input.record_id}`,
  payload: {
    task_id: input.task,
    round: 1,
    checked_by: input.actor ?? "exec-x",
    checks: input.checks.map((c) => ({
      check_id: c.check_id,
      method: c.method ?? "跑验收命令",
      command: c.command,
      exit_code: c.exit_code,
      output_ref: null,
      evidence_sha256: c.evidence_sha256,
      scope: [],
    })),
    conclusion: input.conclusion,
    binding: input.binding ?? { revision_kind: "plan", revision: PLAN_REV },
    independence: "author_self",
  },
});

/** 一条**历史形态**的独立审计事件（无 command/exit_code/per-check method；方法在记录层） */
const historicalAudit = (input: {
  record_id: string;
  task: string;
  check_ids: string[];
  evidence_sha256: string;
  same_session_as_author: boolean;
  read_author_summary_first: boolean;
  binding?: { revision_kind: string; revision: string } | null;
}): WorkEvent => ({
  schema_version: 2,
  event_id: crypto.randomUUID(),
  project_id: PROJECT,
  change_id: "change-v09-01-replay",
  entity_id: `audit:${input.record_id}`,
  entity_revision: 1,
  seq: 2,
  type: "audit.independent_audit_recorded",
  actor_id: "auditor-y",
  role: "auditor",
  occurred_at: "2026-09-23T21:20:00+08:00",
  received_at: "2026-09-23T21:20:00+08:00",
  idempotency_key: `replay:${input.record_id}`,
  payload: {
    task_id: input.task,
    round: 1,
    auditor: "auditor-y",
    author_id: "exec-x",
    independence: {
      different_actor: true,
      same_session_as_author: input.same_session_as_author,
      read_author_summary_first: input.read_author_summary_first,
      model_note: null,
    },
    checks: input.check_ids.map((c) => ({ check_id: c, result: "passed", evidence_sha256: input.evidence_sha256, scope: [] })),
    coverage: COVERAGE,
    findings: [],
    conclusion: "pass",
    not_reported_scope: ["未覆盖真机长跑"],
    method_limits: ["夹具复跑"],
    binding: input.binding ?? { revision_kind: "plan", revision: PLAN_REV },
  },
});

/** 事件重放（`foldAuditRecords`）→ 采信 → 投影：历史记录从事件来，不经写侧闸门 */
const projectionOf = (
  objectId: string,
  events: WorkEvent[],
  required: string[],
  revisions: Record<string, string> = { plan: PLAN_REV },
): StatusProjectionSet => {
  const records = foldAuditRecords(events);
  const objects: StatusObjectInput[] = [
    {
      object_id: objectId,
      object_kind: "task",
      label: objectId,
      executions: [
        { task_id: objectId, status: "result_submitted", actor_id: "exec-x", updated_at: "2026-09-24T00:00:00+08:00" },
      ],
      required_checks: required.map((c) => ({ check_id: c, label: c })),
      revisions,
    },
  ];
  return projectStatuses({ objects, findings: [], checks: checksFromAudit(records) });
};

const selfPass = (task: string, id: string, checkId: string, evidence = "9".repeat(64)): WorkEvent =>
  historicalSelfCheck({
    record_id: id,
    task,
    conclusion: "pass",
    checks: [{ check_id: checkId, command: "pnpm verify:t9", exit_code: 0, evidence_sha256: evidence }],
  });

{
  // ① 自检-only：全过 ⇒ 任务层绿，但 quality 必须如实是 mechanical_passed 并点名
  const proj = projectionOf("T-9", [selfPass("T-9", "sc-t9-self", "T-9::check:0")], ["T-9::check:0"]);
  const t = proj.by_id["T-9"];
  ok(
    t.display_status === "verified" && t.quality === "mechanical_passed",
    `③ 自检-only 全过 ⇒ display=${t.display_status}、quality=${t.quality}（**不冒充 audit_passed**）`,
  );
  ok(
    t.reasons.some((r) => r.code === "self_check_only" && r.text.includes("通过项全部来自作者自检")),
    "③ 解释里点名「通过项全部来自作者自检」（不是只给个 mechanical_passed 就完事）",
  );
  ok(t.quality !== "audit_passed", "③ 自检-only 的对象**不写成** audit_passed（附录 E.3.2-4③）");
}
{
  // ② 补一条真·非作者复核记录（不同执行者/不同会话/先不看摘要/按检查项落哈希）⇒ audit_passed
  const events = [
    selfPass("T-9", "sc-t9-self", "T-9::check:0"),
    historicalAudit({
      record_id: "audit-t9",
      task: "T-9",
      check_ids: ["T-9::check:0"],
      evidence_sha256: "8".repeat(64),
      same_session_as_author: false,
      read_author_summary_first: false,
    }),
  ];
  const t = projectionOf("T-9", events, ["T-9::check:0"]).by_id["T-9"];
  ok(
    t.display_status === "verified" && t.quality === "audit_passed",
    `③ 反例对照：补一条非作者复核记录后 quality=${t.quality}（与自检-only 的 mechanical_passed 分得开）`,
  );
}
{
  // ③ 混合档：一项独立、一项自检 ⇒ 按最弱一档给 + 点名还差多少
  const events = [
    historicalSelfCheck({
      record_id: "sc-t9-mixed",
      task: "T-9",
      conclusion: "pass",
      checks: [
        { check_id: "T-9::check:0", command: "pnpm verify:t9", exit_code: 0, evidence_sha256: "9".repeat(64) },
        { check_id: "T-9::check:1", command: "pnpm verify:t9b", exit_code: 0, evidence_sha256: "6".repeat(64) },
      ],
    }),
    historicalAudit({
      record_id: "audit-t9-c0",
      task: "T-9",
      check_ids: ["T-9::check:0"],
      evidence_sha256: "8".repeat(64),
      same_session_as_author: false,
      read_author_summary_first: false,
    }),
  ];
  const t = projectionOf("T-9", events, ["T-9::check:0", "T-9::check:1"]).by_id["T-9"];
  ok(
    t.display_status === "verified" && t.quality === "mechanical_passed",
    `③ 混合档（1 项非作者复核 ＋ 1 项自检）⇒ quality=${t.quality}（按最弱的一档如实给）`,
  );
  ok(
    t.reasons.some((r) => r.code === "mixed_independence"),
    "③ 混合档在解释里点名「几项来自自检、几项有非作者复核」（不糊成一句「已独立复核」）",
  );
}
{
  // ④ 同会话声明的"独立"记录：不得当交叉审计证据（降级 + 逐条点名），记录本身不废除
  const events = [
    historicalSelfCheck({
      record_id: "sc-t9-self",
      task: "T-9",
      conclusion: "pass",
      checks: [
        { check_id: "T-9::check:0", command: "pnpm verify:t9", exit_code: 0, evidence_sha256: "9".repeat(64) },
        { check_id: "T-9::check:1", command: "pnpm verify:t9b", exit_code: 0, evidence_sha256: "9".repeat(64) },
      ],
    }),
    historicalAudit({
      record_id: "acc-bf240-t9",
      task: "T-9",
      check_ids: ["T-9::check:0", "T-9::check:1"],
      evidence_sha256: "7".repeat(64),
      same_session_as_author: true,
      read_author_summary_first: true,
    }),
    historicalAudit({
      record_id: "acc-bf241-t9",
      task: "T-9",
      check_ids: ["T-9::check:0", "T-9::check:1"],
      evidence_sha256: "7".repeat(64),
      same_session_as_author: true,
      read_author_summary_first: true,
    }),
  ];
  const recs = foldAuditRecords(events);
  const t = projectionOf("T-9", events, ["T-9::check:0", "T-9::check:1"]).by_id["T-9"];
  const auditCheck = checksFromAudit(recs).find((c) => c.check_id === "T-9::check:0" && c.independence === "independent")!;
  const eff = checkEffectiveness(auditCheck, { plan: PLAN_REV }, new Set(["exec-x"]));
  ok(
    eff.effective_independence === "author_self" && eff.effective === "passed",
    `④ 同会话声明的「独立」记录：effective_independence=${eff.effective_independence}（**如实降级标注**、不当交叉审计证据；结论本身不废除）`,
  );
  ok(t.quality === "mechanical_passed" && t.display_status === "verified", `④ 降级后 quality=${t.quality}（到不了 audit_passed，也不再冒充）`);
  const named = t.reasons.find((r) => r.code === "audit_same_session_downgraded");
  ok(
    named !== undefined && named.text.includes("acc-bf240-t9") && named.text.includes("acc-bf241-t9"),
    "④ 同会话记录**逐条点名列明**在本对象的解释里（不是一句「有记录不合规」）",
  );
  ok(
    t.reasons.some((r) => r.code === "audit_read_author_summary_first" && r.text.includes("acc-bf240-t9")) &&
      t.reasons.some((r) => r.code === "audit_one_hash_per_record"),
    "④ 「先读作者摘要」与「一记录一哈希」（两检查共一哈希）两个盲点都如实标注（保留采信，不整批废除）",
  );
}
{
  // ⑤ 既有独立审计口径端到端：记录层方法带出、无 command/exit_code/per-check method 仍采信
  const events = [
    historicalAudit({
      record_id: "audit-t9-layer",
      task: "T-9",
      check_ids: ["T-9::check:0"],
      evidence_sha256: "4".repeat(64),
      same_session_as_author: false,
      read_author_summary_first: true,
    }),
  ];
  const t = projectionOf("T-9", events, ["T-9::check:0"]).by_id["T-9"];
  const basis = t.evidence_basis.find((b) => b.check_id === "T-9::check:0");
  ok(
    t.display_status === "verified" && t.quality === "audit_passed",
    `④ 既有独立审计（无 command/exit_code/per-check method）⇒ display=${t.display_status}、quality=${t.quality}（227 条的口径一条都没被废）`,
  );
  ok(
    basis !== undefined && basis.method !== null && basis.method.includes("覆盖：") && basis.method.includes("方法限制："),
    `② 读侧方法来自**记录层**（coverage/method_limits）：${basis?.method?.slice(0, 40) ?? "（空）"}…`,
  );
  ok(
    basis !== undefined && basis.exit_code === null && basis.command === null,
    "② 不带 command 的独立审计：command/exit_code 如实为 null（**不因缺它失效**）",
  );
  ok(t.reasons.some((r) => r.code === "audit_read_author_summary_first"), "④ 「先读作者摘要」的盲点带出（保留采信但不含糊成「已独立复核」）");
}
{
  // ⑥ U3 型矛盾记录（历史形态）：不判绿、点名退出码、evidence_basis 看得到 exit_code
  const events = [
    historicalSelfCheck({
      record_id: "acc-bf240-u3-replay",
      task: "T-9",
      conclusion: "pass",
      checks: [
        { check_id: "T-9::check:0", command: "pnpm verify:u3（当前红在安装包过期，如实照录）（exit 1）", exit_code: 1, evidence_sha256: "5".repeat(64) },
        { check_id: "T-9::evidence", command: "pnpm verify:u3（当前红在安装包过期，如实照录）（exit 1）", exit_code: 1, evidence_sha256: "5".repeat(64) },
      ],
    }),
  ];
  const t = projectionOf("T-9", events, ["T-9::check:0", "T-9::evidence"]).by_id["T-9"];
  ok(
    t.display_status !== "verified" && t.quality !== "audit_passed" && t.passed_count === 0 && t.missing_count === 2,
    `⑥ 历史矛盾记录（conclusion=pass ＋ 每个 exit_code=1）**不再有效通过**：display=${t.display_status}、passed=${t.passed_count}/${t.required_count}`,
  );
  ok(t.missing.every((m) => m.why.includes("退出码")), "⑥ 缺口理由逐条点名退出码（不是笼统的「验证未通过」）");
  const basis = t.evidence_basis.find((b) => b.check_id === "T-9::check:0");
  ok(
    basis !== undefined && basis.exit_code === 1 && basis.command !== null && basis.effective === "unknown",
    `⑥ 投影**保留** exit_code=${basis?.exit_code}、command 与 method（G-02 根因②：投影层结构上看得见矛盾）`,
  );
}

// ═════════════ ⑥ 模块层：成员卡不绿 ⇒ 代码模块不给绿（正反对照） ═════════════
console.log("[verify] ═══ ⑥ 模块层因果：卡不绿 ⇒ `plan:code:src-tauri` 不给绿（附录 D）═══");
{
  const bp: Blueprint = deriveBlueprint(
    {
      project_id: "v09-01-fixture",
      project_root: "/tmp/v09-01-fixture",
      design: {
        path: "DESIGN.md",
        content_sha256: "d".repeat(64),
        definition_sha256: "d".repeat(64),
        sections: [
          { level: 1, title: "夹具设计书", path: "夹具设计书", line_start: 1, line_end: 20, sha256: "s1" },
          { level: 2, title: "十一、交付", path: "夹具设计书 / 十一、交付", line_start: 3, line_end: 20, sha256: "s2" },
          { level: 3, title: "11.3 桌面端", path: "夹具设计书 / 十一、交付 / 11.3 桌面端", line_start: 5, line_end: 14, sha256: "s3" },
        ],
      },
      plan: {
        path: "PLAN.md",
        content_sha256: "p".repeat(64),
        definition_sha256: "p".repeat(64),
        tasks: [
          { task_id: "U3", goal: "桌面端安装包", dependency_ids: [], design_refs: ["§11.3"], allowed_paths: [], evidence_requirement: "`src-tauri/`", deliverables: null },
        ],
      },
      declared_modules: [{ stable_id: "11.3-01", name: "桌面端安装包", section_path: "夹具设计书 / 十一、交付 / 11.3 桌面端" }],
      code: { modules: [{ id: "src-tauri", path: "src-tauri" }] },
      names: {},
    } as never,
    {
      based_on: {
        model_key: "v09-01-fixture",
        full_key: "v09-01-fixture",
        design_content_sha256: "d".repeat(64),
        plan_definition_sha256: "p".repeat(64),
        semantic: false,
      },
    },
  );
  const impl = bp.edges.filter((e) => e.kind === "implementation_map");
  ok(
    impl.some((e) => e.source === "plan:task:U3" && e.target === "plan:code:src-tauri" && e.certainty === "observed"),
    `⑥ 夹具蓝图：U3 → plan:code:src-tauri 的实现映射边（observed）已派生（共 ${impl.length} 条实现映射）`,
  );
  const greenProj = taskDerivedModuleStatus({
    blueprint: bp,
    projection: projectionOf("U3", [selfPass("U3", "sc-u3-green", "U3::check:0", "3".repeat(64))], ["U3::check:0"]).by_id,
  });
  const redProj = taskDerivedModuleStatus({
    blueprint: bp,
    projection: projectionOf(
      "U3",
      [
        historicalSelfCheck({
          record_id: "sc-u3-red",
          task: "U3",
          conclusion: "pass",
          checks: [{ check_id: "U3::check:0", command: "pnpm verify:u3", exit_code: 1, evidence_sha256: "3".repeat(64) }],
        }),
      ],
      ["U3::check:0"],
    ).by_id,
  });
  ok(
    greenProj.status["plan:code:src-tauri"].display === "verified" &&
      greenProj.status["plan:code:src-tauri"].short === MODULE_VERIFIED_SHORT,
    `⑥ 正例：成员卡真绿（exit_code=0）⇒ 模块「${greenProj.status["plan:code:src-tauri"].short}」`,
  );
  ok(
    redProj.status["plan:code:src-tauri"].display !== "verified",
    `⑥ 反例：同一张卡的记录退出码非零 ⇒ 模块 display=${redProj.status["plan:code:src-tauri"].display}（**不给绿**——U3 那条旧绿正是这样来的）`,
  );
}

// ═════════════ ④⑥⑦ 真实账本对照（只读） ═════════════
console.log("[verify] ═══ ④⑥⑦ 真实账本对照（只读解析；本段不写一个字节）═══");
if (realLedger === null) {
  info("SKIP：本机没有可读的 tatai 项目账本（registry.json 无 tatai 或缺 events.jsonl）——真实数据对照未跑，");
  info("      这不是「已验证」，只是这条对照在本次环境下取不到数；夹具部分已覆盖同一判据。");
} else {
  const events = fs
    .readFileSync(realLedger.file, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as WorkEvent);
  const selfChecks = events.filter((e) => e.type === "audit.self_check_recorded");
  const audits = events.filter((e) => e.type === "audit.independent_audit_recorded");
  const contradicting = selfChecks.filter((e) => {
    const p = (e.payload ?? {}) as Record<string, unknown>;
    if (p.conclusion !== "pass") return false;
    return ((p.checks ?? []) as Record<string, unknown>[]).some(
      (c) => typeof c.command === "string" && c.command !== "" && c.exit_code !== 0,
    );
  });
  let contradictingRows = 0;
  for (const e of contradicting) {
    for (const c of (((e.payload ?? {}) as Record<string, unknown>).checks ?? []) as Record<string, unknown>[]) {
      if (typeof c.command === "string" && c.command !== "" && c.exit_code !== 0) contradictingRows++;
    }
  }
  info(
    `真实账本：${events.length} 事件 / 自检 ${selfChecks.length} 条 / 独立审计 ${audits.length} 条 / ` +
      `「conclusion=pass 且带 command 的 exit_code≠0」=${contradicting.length} 条记录、${contradictingRows} 行`,
  );
  ok(
    contradicting.length === 8 && contradictingRows === 23,
    `⑦ 修前读数原样在册：矛盾记录 ${contradicting.length} 条 / ${contradictingRows} 行（修后**新写入**应为 0，历史一条不改）`,
  );
  // 定向更新（2026-09-28，分段绑定补证批次）：227 → >=227——审计记录是只增不改的历史，
  // 后续卡（V09-18 复审等）合法新增了记录；断言意图是「一条都没被整批作废/改写」，下限语义足够。
  ok(audits.length >= 227, `④ 独立审计记录 ${audits.length} 条（≥227：一条都没被整批作废/改写，历史只增）`);
  const sameSession = audits.filter(
    (e) =>
      (((e.payload ?? {}) as Record<string, unknown>).independence as Record<string, unknown> | undefined)?.same_session_as_author === true,
  );
  ok(
    sameSession.length === 13,
    `④ 声明与作者同会话的记录 ${sameSession.length} 条（逐条点名列明见证据文档；收口路径：分离会话重做／如实降级，本轮取后者）`,
  );
  const facts = collectProjectFacts(REAL_PROJECT, REAL_DATA_DIR);
  // 定向更新（2026-09-28，E.3.6 分段绑定）：projectStatuses 新增 binding_segments 入参（E.3.6），
  // 服务端四处调用点已传；本脚本手工拼投影也要同款传，否则按整份哈希口径误判（U3 会假红）。
  const projection = projectStatuses({
    objects: objectsFromFacts(REAL_PROJECT, REAL_DATA_DIR, facts),
    findings: facts.findings,
    checks: checksFromAudit(facts.audit),
    source_revision: facts.revisions,
    binding_segments: facts.binding_segments,
  });
  const u3 = projection.by_id["U3"];
  // 定向更新（V09-09 集成复审 H-2，2026-09-25）；判据未放宽——绿仍只许来自当前有效证据：
  //   旧期望：U3 display ≠ verified（V09-04 交付前，E.3.5「恢复绿唯一路径＝同源重打＋复跑 verify:u3」尚未走完）｜
  //   依据：V09-04 已按当前源码同源重打并复跑 verify:u3 39/0/1SKIP（证据 .工作台/evidence/V09-04/1/、U3/2/），
  //   U3 当前自检 4 条绑收口基准串（账本 seq 1026/1027，exit_code=0、verify:u3）｜
  //   新期望：U3 判绿，但 quality **恰好**是 mechanical_passed——绿全部来自当前有效机械检查，
  //   **不是** audit_passed、**不是**历史矛盾记录染回（下一条断言仍逐行守住 23 行 ≠ passed）｜
  //   保留意图：绿⇔当前全部必需证据有效；历史矛盾记录原样在册且永不计绿。
  ok(
    u3 !== undefined && u3.display_status === "verified" && u3.quality === "mechanical_passed",
    `⑥ 真实账本复算：U3 display=${u3?.display_status}、quality=${u3?.quality}、通过 ${u3?.passed_count}/${u3?.required_count}（**经 V09-04 复绿；quality 恰为 mechanical_passed——非 audit_passed、非矛盾记录染回**）`,
  );
  // 定向更新（2026-09-28，补证批次）：集合口径从「账本全部非零退出行」收敛到「上面那 8 条矛盾记录自己的行」——
  // 补证批次会如实登记 fail 记录（exit≠0），全局口径把诚实失败也算进"矛盾记录"误报。判据不放宽：
  // 矛盾记录（conclusion=pass 却带非零退出）仍逐行必须 ≠ passed。
  const contraRows: CheckInput[] = [];
  for (const e of contradicting) {
    const p = (e.payload ?? {}) as Record<string, unknown>;
    for (const c of ((p.checks ?? []) as Record<string, unknown>[])) {
      const cmd = typeof c.command === "string" && c.command !== "" ? c.command : null;
      const code = typeof c.exit_code === "number" ? c.exit_code : null;
      if (cmd === null || code === null || code === 0) continue;
      contraRows.push({
        check_id: String(c.check_id ?? ""),
        object_id: String(p.task_id ?? ""),
        result: "passed", // 矛盾记录：声明 pass 却带非零退出
        actor_id: String(p.checked_by ?? ""),
        role: "executor",
        independence: "author_self",
        binding: (p.binding ?? { revision_kind: "plan", revision: "" }) as EvidenceBinding,
        evidence_sha256: typeof c.evidence_sha256 === "string" ? c.evidence_sha256 : null,
        at: String(e.occurred_at ?? ""),
        command: cmd,
        exit_code: code,
      });
    }
  }
  const contraChecks = contraRows;
  const notPassed = contraChecks.filter((c) => checkEffectiveness(c, facts.revisions, new Set()).effective !== "passed");
  ok(
    contraChecks.length === 23 && notPassed.length === 23,
    `⑥ 那 23 行矛盾检查逐行复核：effective 全部 ≠ passed（实际 ${notPassed.length}/${contraChecks.length}）`,
  );
  ok(
    (u3?.evidence_basis ?? []).length > 0 &&
      (u3?.evidence_basis ?? []).every((b) => b.command !== null && b.exit_code === 0),
    "⑥ 投影里看得见「这条检查是怎么做的」：现行判绿的 evidence_basis 逐条带 command 与 exit_code=0（verify:u3 机械检查）",
  );
  const bp = readBlueprint(REAL_PROJECT, REAL_DATA_DIR);
  if (bp === null) {
    info("SKIP：真实蓝图未生成，模块层上屏对照未跑（只跑了 U3 卡层复算）");
  } else {
    const derived = taskDerivedModuleStatus({ blueprint: bp, projection: projection.by_id });
    const st = derived.status["plan:code:src-tauri"];
    const members = derived.tasks_by_module["plan:code:src-tauri"] ?? [];
    // 定向更新（2026-09-25 复核批次终绑）；判据未放宽——「成员全绿才判绿」语义不变：
    //   旧期望：模块 display ≠ verified（写于 U3 刚复绿、其余成员仍待验证的中间时点）｜
    //   依据：复核批次终绑后五个成员（U1/U2/U3/V09-04/V09-14）必需项实测全过且证据 fresh，
    //   模块按附录 D 成员账目**应当**判绿；钉住中间时点会把「全绿 ⇒ 绿」误报成红｜
    //   新期望：双向——模块判绿 ⇒ 每个成员各自 verified（不允许只靠 U3 染绿）；
    //   有成员未 verified ⇒ 模块不得判绿（取投影逐成员复核，不信模块自己的读数）｜
    //   保留意图：模块绿 ⇔ 成员全绿；成员红/待验时模块绝不上绿。
    const memberDisplays = members.map((m) => projection.by_id[m]?.display_status ?? "（无）");
    const allGreen = members.length > 0 && memberDisplays.every((d) => d === "verified");
    ok(
      st !== undefined && members.includes("U3") && (st.display === "verified") === allGreen,
      `⑥ 上屏路径复算：plan:code:src-tauri 成员 [${members.join("、")}] 含 U3，成员逐绿=${memberDisplays.join("/")}，模块 display=${st?.display ?? "（无）"}（**成员全绿才判绿**：全绿⇒模块绿且逐成员复核为绿；有成员未绿⇒模块不给绿）`,
    );
  }
}

// ═════════════ 隔离与零写入自证 ═════════════
console.log("[verify] ═══ 隔离自证：写侧只落夹具、真实账本零写入 ═══");
{
  const fixtureEvents = loadEvents(workDir).events;
  ok(
    fixtureEvents.length > 0 && fixtureEvents.every((e) => e.project_id === PROJECT),
    `隔离自证：写侧测试的 ${fixtureEvents.length} 条事件全部属于夹具项目 ${PROJECT}（TATAI_HOME=${dataDir}）`,
  );
  ok(path.resolve(workDir).startsWith(path.resolve(os.tmpdir())), `隔离自证：夹具账本落在临时目录（${workDir}）`);
  const after = realLedger === null ? null : sha256File(realLedger.file);
  ok(
    after === realLedgerHashBefore,
    `隔离自证：真实账本 sha256 前后一致（${String(realLedgerHashBefore).slice(0, 16)}…）——` +
      "不一致说明有东西写了真实账本（并发运行的写入服务也会如此），必须查清",
  );
}

console.log(
  `\n[verify] V09-01：PASS ${pass} / FAIL ${fail}${fail === 0 ? "（全部 PASS）" : ""}` +
    (realLedger === null ? " ｜ 注：真实数据对照段 SKIP（本机取不到 tatai 账本）" : ""),
);
fs.rmSync(tmpBase, { recursive: true, force: true });
