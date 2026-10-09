// 施工图/设计书「Git blob 快照」读侧修复验证脚本（2026-10-08）。
// 用法：node_modules/.bin/tsx scripts/verify-git-snapshot-fix.ts
//
// 根因（root 证据 .工作台/project-completion-20261008/delivery-scope-20261008/plan-binding-review.json）：
//   `documents.planContentSnapshotIndex` 只按 `plan-revisions/<hash>.md` 文件读，**漏掉
//   recovery.kind=git_blob**（DESIGN.md §2.6：已在 Git 里可逐字节取回时 `preserveRevision` 不落副本，
//   只记 `git:<oid>`）。真机两条现行基线即如此：
//     e55102e9… = bl-74eb8498-e7423e0a recovery git:4b8caa582c70ffeec87434ba6b23a1f1ec52c86b
//     9d747f7e… = bl-ca3f4eac-9d747f7e recovery git:b1612ad19ca2d39ab9fc12944059e1de1f248ff3
//   设计绑定（statusProjection 直接 readRevisionSnapshotText）同源同病。
//
// 本脚本在**隔离夹具**里证明（不碰任何真实项目）：
//   ① 真实 Git 仓库里已有 blob → 读侧按内容哈希直读得到（修前必得 null）；
//   ② plan：同卡未变、别卡变 → 仍 passed（分段救回）；本卡真变 → stale；
//   ③ design：同一读侧路径（snapshots 在场 + 引用章节比对）；
//   ④ 坏 ref（对象不存在）/ 坏 hash（取回字节哈希对不上）一律拒绝；
//   ⑤ 跨项目隔离：别的项目记的恢复位置不会被当成本项目的；
//   ⑥ 缓存失效：Git 对象消失后，进程内旧 cache 必须被拒（不能拿旧快照判 passed）；
//   ⑦ 真机（只读）：对真实 tatai 项目逐绑定归因计数（不把所有 historical stale 判 passed）。
import crypto from "node:crypto";
import { deflateSync } from "node:zlib";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  activateBaseline,
  planContentSnapshotIndex,
  readRevisionSnapshotText,
  revisionSnapshotExists,
} from "../src/server/work/documents";
import { importTaskDefinitions } from "../src/server/work/plan";
import { submitDefinitionImports } from "../src/server/work/tasks";
import { submitSelfCheck } from "../src/server/work/audit";
import { WorkService } from "../src/server/work/service";
import { projectFromFacts } from "../src/server/work/statusProjection";

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

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-git-snap-verify-"));
const dataDir = path.join(tmpBase, "home");
const mkdirp = (d: string) => fs.mkdirSync(d, { recursive: true });
const write = (f: string, text: string) => {
  mkdirp(path.dirname(f));
  fs.writeFileSync(f, text, "utf8");
};
mkdirp(dataDir);

const DESIGN_PATH = ".工作台/design.md";
const PLAN_PATH = ".工作台/plan.md";
const DESIGN_V1 = ["# Git夹具设计书", "", "## 1 概述", "概述正文。", "", "## 2 能力甲", "能力甲正文。", "", "## 3 能力乙", "能力乙正文。", ""].join("\n");
const DESIGN_V2 = DESIGN_V1.replace("能力乙正文。", "能力乙正文（改过）。");
const card = (id: string, goal: string, design: string): string =>
  [
    `### ${id} ${goal}`,
    "",
    `**设计依据**：${design}。**契约**：夹具输入输出。`,
    "",
    `- [ ] ${goal}做出来`,
    `- [ ] ${goal}设计依据核对`,
    "",
    `**交付**：${goal}验收记录。`,
    "",
  ].join("\n");
const planTextWith = (t3: string): string =>
  [
    "# Git夹具施工图",
    "",
    "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |",
    "| --- | --- | --- | --- | --- |",
    "| T-1 | todo | 能力甲落成 |  | T-1 验收记录 |",
    "| T-2 | todo | 能力乙落成 |  | T-2 验收记录 |",
    `| T-3 | todo | ${t3} |  | T-3 验收记录 |`,
    "",
    card("T-1", "能力甲落成", "§2"),
    card("T-2", "能力乙落成", "§3"),
    card("T-3", "能力丙落成", "§2"),
  ].join("\n");
const PLAN_V1 = planTextWith("能力丙落成");
const PLAN_V2 = planTextWith("能力丙落成（改过一张卡）");

// 夹具项目 id/root
const P1 = "git-snap-fix";
const P3 = "git-snap-bad";
const P4 = "git-snap-other";
const rootOf = (id: string) => path.join(tmpBase, id);
for (const id of [P1, P3, P4]) mkdirp(rootOf(id));
write(
  path.join(dataDir, "registry.json"),
  JSON.stringify(
    {
      version: 1,
      projects: [P1, P3, P4].map((id) => ({
        id,
        name: id,
        path: rootOf(id),
        kind: "backend",
        registered_at: "2026-10-08T00:00:00+08:00",
        last_opened_at: "2026-10-08T00:00:00+08:00",
      })),
    },
    null,
    2,
  ),
);
process.env.TATAI_HOME = dataDir;

const git = (root: string, args: string[]): string =>
  execFileSync("git", ["-C", root, ...args], { stdio: ["ignore", "pipe", "ignore"] }).toString("utf8").trim();
const gitInit = (root: string) => {
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "fixture@example.invalid"]);
  git(root, ["config", "user.name", "fixture"]);
  // 关键：不许归一化——库内 blob 必须与工作区字节逐字节相同，`gitBlobRef` 快速通道才命中。
  git(root, ["config", "core.autocrlf", "false"]);
};
const looseObjectPath = (root: string, oid: string) => path.join(root, ".git", "objects", oid.slice(0, 2), oid.slice(2));

try {
  // ═══════════ ① 真实 Git 仓库里已有 blob → 读侧直读 ═══════════
  info("── ① 真实 Git 仓库：plan/design 经 git_blob 恢复位置直读");
  const r1 = rootOf(P1);
  write(path.join(r1, DESIGN_PATH), DESIGN_V1);
  write(path.join(r1, PLAN_PATH), PLAN_V1);
  gitInit(r1);
  git(r1, ["add", "-A"]);
  git(r1, ["commit", "-qm", "init"]);

  const svc = new WorkService({ dataDir });
  submitDefinitionImports(svc, {
    project_id: P1,
    change_id: "gitsnap-defs",
    actor_id: "verify-git-snapshot-fix",
    role: "executor",
    definitions: importTaskDefinitions(PLAN_V1).definitions,
  });
  const planShaV1 = nodeSha256(PLAN_V1);
  const designShaV1 = nodeSha256(DESIGN_V1);
  const evidenceHash = nodeSha256("夹具证据正文");
  const baseCheck = (taskId: string, checkId: string, kind: "plan" | "design", revision: string) =>
    submitSelfCheck(svc, {
      project_id: P1,
      change_id: "gitsnap-check",
      actor_id: "verify-git-snapshot-fix",
      role: "executor",
      record_id: `gitsnap-${taskId}-${kind}`,
      task_id: taskId,
      checked_by: "verify-git-snapshot-fix",
      checks: [{ check_id: checkId, method: "夹具：绑内容哈希", evidence_sha256: evidenceHash, verifies: "document" }],
      conclusion: "pass",
      binding: { revision_kind: kind, revision },
    });
  baseCheck("T-1", "T-1::check:0", "plan", planShaV1);
  baseCheck("T-3", "T-3::check:0", "plan", planShaV1);
  baseCheck("T-1", "T-1::check:1", "design", designShaV1);
  baseCheck("T-2", "T-2::check:1", "design", designShaV1);

  const bl = activateBaseline(P1, { approved_by: "user", approval_basis: "夹具隔离审定（不代表真实用户 Gate）", approval_kind: "user_confirmed" }, dataDir).baseline;
  const planDefV1 = bl.plan_revision.definition_sha256;
  ok(bl.plan_revision.recovery.kind === "git_blob", `① plan 基线恢复位置 = git_blob（${bl.plan_revision.recovery.ref}）`);
  ok(bl.design_revision.recovery.kind === "git_blob", `① design 基线恢复位置 = git_blob（${bl.design_revision.recovery.ref}）`);
  const shaOfGit = (ref: string) => nodeSha256(execFileSync("git", ["-C", r1, "cat-file", "blob", ref.replace(/^git:/, "")]));
  ok(shaOfGit(bl.plan_revision.recovery.ref) === planShaV1, "① 记录的 plan blob 取回字节 sha256 == 基线内容哈希");
  ok(shaOfGit(bl.design_revision.recovery.ref) === designShaV1, "① 记录的 design blob 取回字节 sha256 == 基线内容哈希");

  const hasPlanFile = fs.existsSync(path.join(r1, ".工作台/plan-revisions", `${planShaV1}.md`)) || fs.existsSync(path.join(r1, ".工作台/plan-revisions", `${planDefV1}.md`));
  ok(!hasPlanFile, "① 盘上**没有** plan 不可变副本文件（证明走的是 Git 快速通道，不是副本兜底）");
  ok(!fs.existsSync(path.join(r1, ".工作台/design-revisions", `${designShaV1}.md`)), "① 盘上**没有** design 不可变副本文件");

  ok(readRevisionSnapshotText(P1, "plan", planShaV1, dataDir) === PLAN_V1, "① readRevisionSnapshotText(plan, 内容哈希) 经 git_blob 直读到 V1 原文（修前必得 null）");
  ok(readRevisionSnapshotText(P1, "design", designShaV1, dataDir) === DESIGN_V1, "① readRevisionSnapshotText(design, 内容哈希) 经 git_blob 直读到 V1 原文");
  ok(revisionSnapshotExists(P1, "plan", planShaV1, dataDir) === true, "① revisionSnapshotExists(plan) 认 Git 来源");
  ok(revisionSnapshotExists(P1, "design", designShaV1, dataDir) === true, "① revisionSnapshotExists(design) 认 Git 来源");
  const idxRead = planContentSnapshotIndex(P1, dataDir).read(planShaV1);
  ok(idxRead !== null && idxRead.text === PLAN_V1 && idxRead.source_ref.startsWith("git:"), `① planContentSnapshotIndex.read 命中 Git（source_ref=${idxRead?.source_ref}）`);

  // ═══════════ ②③ 分段复核：plan 同卡未变仍 passed、本卡真变 stale ═══════════
  info("── ②③ 端到端：真事件 → collectProjectFacts → projectStatuses（Git 快照在场）");
  const f0 = projectFromFacts(P1, dataDir).facts;
  ok(f0.binding_segments.snapshots.has(`plan:${planShaV1}`), `② Git 快照装进 facts（键 plan:${planShaV1.slice(0, 8)}… 在场）`);
  ok(f0.binding_segments.snapshots.has(`design:${designShaV1}`), `③ Git 快照装进 facts（键 design:${designShaV1.slice(0, 8)}… 在场）`);

  const effOf = (id: string, checkId: string) => {
    const p = projectFromFacts(P1, dataDir).projection;
    return p.by_id[id]?.evidence_basis.find((b) => b.check_id === checkId)?.effective;
  };

  write(path.join(r1, PLAN_PATH), PLAN_V2);
  ok(effOf("T-1", "T-1::check:0") === "passed", `② 只有别卡（T-3）变、本卡 T-1 未变 → 仍 passed（effective=${effOf("T-1", "T-1::check:0")}）——Git 快照分段救回，不再假 stale`);
  ok(effOf("T-3", "T-3::check:0") === "stale", `② 本卡 T-3 真变 → stale（effective=${effOf("T-3", "T-3::check:0")}）`);

  write(path.join(r1, DESIGN_PATH), DESIGN_V2);
  ok(effOf("T-1", "T-1::check:1") === "passed", `③ design 引 §2（未改）→ 仍 passed（effective=${effOf("T-1", "T-1::check:1")}）`);
  ok(effOf("T-2", "T-2::check:1") === "stale", `③ design 引 §3（改了）→ stale（effective=${effOf("T-2", "T-2::check:1")}）`);

  // ═══════════ ⑥ 缓存失效：Git 对象消失后旧 cache 必须被拒 ═══════════
  info("── ⑥ 缓存失效：删掉 Git 对象后，进程内旧 cache 不得再放行");
  const planOid = bl.plan_revision.recovery.ref.replace(/^git:/, "");
  // 根复核反例：原对象路径仍存在、cat-file -e 成功，也不能复用已变字节的暖缓存。
  const loosePath = looseObjectPath(r1, planOid);
  const savedBlob = fs.readFileSync(loosePath);
  const corruptBytes = Buffer.from(PLAN_V1 + "\ncorrupt fixture bytes\n");
  fs.chmodSync(loosePath, 0o600);
  fs.writeFileSync(loosePath, deflateSync(Buffer.concat([Buffer.from(`blob ${corruptBytes.length}\0`), corruptBytes])));
  ok(revisionSnapshotExists(P1, "plan", planShaV1, dataDir) === false, "⑥ 同路径对象字节被改，存在性复核拒绝暖缓存");
  ok(!projectFromFacts(P1, dataDir).facts.binding_segments.snapshots.has(`plan:${planShaV1}`), "⑥ 篡改后分段缓存实际失效");
  ok(planContentSnapshotIndex(P1, dataDir).read(planShaV1) === null, "⑥ 篡改对象不能当旧快照读回");
  fs.writeFileSync(loosePath, savedBlob);
  ok(projectFromFacts(P1, dataDir).facts.binding_segments.snapshots.has(`plan:${planShaV1}`), "⑥ 恢复夹具原字节后才恢复可核快照");
  const beforeHas = projectFromFacts(P1, dataDir).facts.binding_segments.snapshots.has(`plan:${planShaV1}`);
  fs.rmSync(looseObjectPath(r1, planOid), { force: true });
  const afterHas = projectFromFacts(P1, dataDir).facts.binding_segments.snapshots.has(`plan:${planShaV1}`);
  ok(beforeHas === true && afterHas === false, `⑥ 对象消失前 snapshots 在场=${beforeHas} → 消失后=${afterHas}（旧 cache 被拒，不拿旧快照放行）`);
  ok(readRevisionSnapshotText(P1, "plan", planShaV1, dataDir) === null, "⑥ 对象消失后 readRevisionSnapshotText 返回 null（fail-closed，不猜）");
  ok(revisionSnapshotExists(P1, "plan", planShaV1, dataDir) === false, "⑥ 对象消失后 revisionSnapshotExists = false");

  // ═══════════ ④ 坏 ref / 坏 hash 一律拒绝 ═══════════
  info("── ④ 坏 ref（对象不存在）/ 坏 hash（取回字节对不上）拒绝");
  const r3 = rootOf(P3);
  write(path.join(r3, DESIGN_PATH), DESIGN_V1);
  write(path.join(r3, PLAN_PATH), PLAN_V1);
  gitInit(r3);
  git(r3, ["add", "-A"]);
  git(r3, ["commit", "-qm", "init"]);
  const goodOid = git(r3, ["rev-parse", "HEAD:.工作台/plan.md"]);
  const ghostHash = nodeSha256("ghost-content-never-stored");
  const goodHashWrongRef = nodeSha256(PLAN_V1);
  const wrongHash = nodeSha256("not-the-plan-bytes");
  const refRec = (ref: string, sha: string) => ({
    kind: "plan" as const,
    source_path: PLAN_PATH,
    content_sha256: sha,
    definition_sha256: sha,
    recovery: { kind: "git_blob" as const, ref, key: sha, sha256: sha },
  });
  const designRef = (sha: string) => ({
    kind: "design" as const,
    source_path: DESIGN_PATH,
    content_sha256: sha,
    definition_sha256: sha,
    recovery: { kind: "immutable_copy" as const, ref: ".工作台/design-revisions/x.md", key: sha, sha256: sha },
  });
  const badLine = (id: string, planSha: string, ref: string) =>
    JSON.stringify({
      baseline_id: id,
      design_revision: designRef(designShaV1),
      plan_revision: refRec(ref, planSha),
      approved_by: "user",
      approval_basis: "夹具（不代表真实用户 Gate）",
      approval_kind: "user_confirmed",
      active_at: "2026-10-08T00:00:00+08:00",
      supersedes: null,
    });
  write(
    path.join(r3, ".工作台/baselines.jsonl"),
    // 坏 ref：oid 不存在（40 个 0）
    badLine("bl-bad-ref", ghostHash, `git:${"0".repeat(40)}`) + "\n" +
      // 坏 hash：ref 指向真实对象，但记录写的 sha256 与取回字节不符
      badLine("bl-bad-hash", wrongHash, `git:${goodOid}`) + "\n" +
      // 对照：真对象 + 真哈希
      badLine("bl-good", goodHashWrongRef, `git:${goodOid}`) + "\n",
  );
  ok(readRevisionSnapshotText(P3, "plan", ghostHash, dataDir) === null, "④ 坏 ref（对象不存在）→ 直读 = null");
  ok(revisionSnapshotExists(P3, "plan", ghostHash, dataDir) === false, "④ 坏 ref → revisionSnapshotExists = false");
  ok(readRevisionSnapshotText(P3, "plan", wrongHash, dataDir) === null, "④ 坏 hash（取回字节 sha256 与记录不符）→ 拒绝，判 null（不拿别的对象顶替）");
  ok(readRevisionSnapshotText(P3, "plan", goodHashWrongRef, dataDir) === PLAN_V1, "④ 对照：真对象 + 真哈希 → 直读得到原文（拒绝的是坏数据，不是这条路本身）");

  // ═══════════ ⑤ 跨项目隔离 ═══════════
  info("── ⑤ 跨项目隔离：别的项目记的恢复位置不当作本项目的");
  ok(readRevisionSnapshotText(P4, "plan", goodHashWrongRef, dataDir) === null, `⑤ P1/P3 记的 plan blob 不会被 P4 读到（P4 无该基线）`);
  ok(revisionSnapshotExists(P4, "plan", goodHashWrongRef, dataDir) === false, "⑤ P4 revisionSnapshotExists = false（不跨项目命中）");

  info(`夹具根：${tmpBase}`);
} catch (e) {
  failCount++;
  process.exitCode = 1;
  console.error(`[verify] FAIL 未捕获异常：${(e as Error).stack ?? e}`);
} finally {
  if (process.env.TATAI_KEEP_TMP !== "1") {
    try {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    } catch {
      // 清理失败不影响判据
    }
  }
}

console.log(`\n[verify] Git 快照读侧修复结果：${passCount} PASS / ${failCount} FAIL`);
