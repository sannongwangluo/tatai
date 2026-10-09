// 运行时负载阻塞修复（W=<维护者工作树>，2026-10-07）——行为/边界回归。
//
// 触发（独立负载验收，E/runtime-load-acceptance）：设计页每 5s 轮询的重读口此前在**主线程内联**跑
// 一次 2–7s 的现读派生，主线程事件循环被占住——同为主线程服务的 `/api/work/health`（预算 2500ms）
// 与 `/api/work/entry`（预算 8000ms）请求排队超预算（实测 health 8/11、entry 4/5 超）。
//
// 被钉住的性质（每条都对应一个实际改动与其风险）：
//   ① 功能清单**根入口**跑在**一次**派生作用域里：整条读路径（快照选择 + 事实 + 义务 + 检查）的
//      `readFileSync` 一律发生在 `inDerivationScope()===true` 的作用域内，且同一文件一次请求内不被反复重读。
//   ② 作用域**不跨请求**：两次读口之间改图纸源，第二次读口的 `source_revision` 立刻变（无 TTL、无陈旧窗口）。
//   ③ 清单载体读取在一次派生内只读一次、**跨派生重读**（证据正文不可变；下一个请求照旧现读，源变即见）。
//   ④ 功能清单**只读 worker 作业**：worker 路径与直接调用 canonical 逐字段相同；worker 基础设施不可用 ⇒
//      **明确结构化失败**，绝不静默回退主线程长算。
//   ⑤ 只读入口的**必要源前后复核**不被作用域吞掉：`computeEntryView` 期间仍存在**作用域外**的图纸源现读
//      （作用域只覆盖同一次派生里的重复现读，不改「计算期间源变过」的判据）。
//
// 隔离口径（AGENTS.md §5）：夹具一律在系统 tmp 下 `tatai-runtime-load-` 前缀目录里自建自清，
//   不碰真实注册表/真实项目/生产数据；不 build、不起服务、不调模型。
//
// 运行：node --import tsx scripts/verify-runtime-load-fix.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { readFeatureLedger } from "../src/server/work/featureLedger";
import { readManifestCarrier, verifySourceManifest, buildSourceManifest } from "../src/server/work/sourceEvidence";
import { evidenceBlobPath } from "../src/server/work/evidence";
import { withDerivationScope, inDerivationScope } from "../src/server/work/derivationScope";
import { runReadJob, describeReadJobError, ReadWorkersUnavailable, __resetReadWorkerPoolForTest } from "../src/server/work/readWorkerPool";
import { computeEntryView } from "../src/server/work/readJobs";

const fails: string[] = [];
const skips: string[] = [];
let pass = 0;
function ok(cond: boolean, label: string): void {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fails.push(label);
    console.log(`  ✗ ${label}`);
  }
}
const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const sha256 = (s: string): string => crypto.createHash("sha256").update(s, "utf8").digest("hex");

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-runtime-load-"));
const dataDir = path.join(tmpRoot, "home");
const projectRoot = path.join(tmpRoot, "proj");
const workbench = path.join(projectRoot, ".工作台");
const workDir = path.join(workbench, "work");

/** 读计数插桩：记调用次数，并记下每次读取时的 `inDerivationScope()`（证明读发生在哪个作用域里）。 */
const readCount = new Map<string, number>();
const readsOutsideScope: string[] = [];
const origReadFileSync = fs.readFileSync;
function installReadCounter(): void {
  (fs as unknown as { readFileSync: typeof fs.readFileSync }).readFileSync = function (
    p: fs.PathOrFileDescriptor,
    ...rest: unknown[]
  ) {
    const key = String(p);
    readCount.set(key, (readCount.get(key) ?? 0) + 1);
    if (!inDerivationScope()) readsOutsideScope.push(key);
    return (origReadFileSync as unknown as (...a: unknown[]) => unknown).call(fs, p, ...rest) as never;
  } as typeof fs.readFileSync;
}
function uninstallReadCounter(): void {
  (fs as unknown as { readFileSync: typeof fs.readFileSync }).readFileSync = origReadFileSync;
}
const readsOf = (p: string): number => readCount.get(p) ?? 0;

function planText(marker: string): string {
  // 卡表 + 逐卡正文 + 状态段 + 功能映射表：足够让读口走完整的「快照→事实→义务→检查」路径。
  return [
    "# 施工图（运行时负载夹具）",
    "",
    `> 夹具标记：${marker}`,
    "",
    "## 卡表",
    "",
    "| 卡号 | 交付目标 | 依赖 | 完成证据 |",
    "| --- | --- | --- | --- |",
    "| V99-1 | 夹具能力一 | — | 单测与现场读数 |",
    "| V99-2 | 夹具能力二 | V99-1 | 单测与现场读数 |",
    "",
    "### V99-1 卡 1",
    "",
    "**交付目标**：夹具能力一完成并可核。",
    "**允许改动路径**：`src/part1/`",
    "**完成证据**：第 1 项的现场读数。",
    "",
    "- [ ] 单测通过",
    "",
    "**状态**：todo（夹具初始态）",
    "",
    "### V99-2 卡 2",
    "",
    "**交付目标**：夹具能力二完成并可核。",
    "**允许改动路径**：`src/part2/`",
    "**完成证据**：第 2 项的现场读数。",
    "",
    "- [ ] 单测通过",
    "",
    "**状态**：todo（夹具初始态）",
    "",
    "## 功能映射",
    "",
    "| 功能 ID | 人话功能名 | 承接卡 | 必需检查 | 集成检查 |",
    "| --- | --- | --- | --- | --- |",
    "| fx-one | 夹具能力一 | V99-1 | chk-1 |  |",
    "| fx-two | 夹具能力二 | V99-2 | chk-2 |  |",
    "",
  ].join("\n");
}
function designText(marker: string): string {
  return [
    "# 设计书（运行时负载夹具）",
    "",
    `> 夹具标记：${marker}`,
    "",
    "## 3 功能",
    "",
    "### 3.5 目标章节",
    "",
    "只用于验证「运行时负载修复」的读口行为。",
    "",
    "#### 功能清单声明（夹具）",
    "",
    "| 功能 ID | 人话功能名 | 需求 ID | 设计章节 | 本期范围（scope_id） | 覆盖结论 | 依据/缺口（review） | 使用结果与场景 |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    "| fx-one | 夹具能力一 |  | §3.5 | null | 待审 | gap=未施工 | 场景一 |",
    "| fx-two | 夹具能力二 |  | §3.5 | null | 待审 | gap=未施工 | 场景二 |",
    "",
  ].join("\n");
}
function registry(projects: Record<string, string>): string {
  return JSON.stringify(
    {
      version: 1,
      projects: Object.entries(projects).map(([id, root]) => ({
        id,
        name: id,
        path: root,
        kind: "fullstack",
        self_managed: false,
        registered_at: "2026-10-07T00:00:00+08:00",
        last_opened_at: "2026-10-07T00:00:00+08:00",
      })),
    },
    null,
    2,
  );
}

const flResult = (r: ReturnType<typeof readFeatureLedger>): string => JSON.stringify(r);

try {
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  const plan = { abs: path.join(workbench, "plan.md"), text: planText("A") };
  const design = { abs: path.join(workbench, "design.md"), text: designText("A") };
  fs.writeFileSync(plan.abs, plan.text, "utf8");
  fs.writeFileSync(design.abs, design.text, "utf8");
  fs.writeFileSync(path.join(dataDir, "registry.json"), registry({ fx: projectRoot }), "utf8");
  // 源清单要复核的源文件
  const srcFiles: { rel: string; abs: string; text: string }[] = [];
  for (let i = 0; i < 8; i++) {
    const rel = `src/part${i}.ts`;
    const text = `export const part${i} = ${i};\n`;
    const abs = path.join(projectRoot, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text, "utf8");
    srcFiles.push({ rel, abs, text });
  }
  // 一份带源清单的证据正文（内容寻址：文件名=sha256(content)），供 readManifestCarrier 用。
  const manifest = buildSourceManifest(projectRoot, srcFiles.map((f) => ({ path: f.rel, sha256: sha256(f.text) })));
  const content = JSON.stringify({ kind: "source_manifest", content_sha256: "", bytes: 0, source_manifest: manifest, binding: { revision_kind: "code", revision: manifest.fingerprint } });
  const contentSha = sha256(content);
  const blob = evidenceBlobPath(workDir, contentSha);
  fs.mkdirSync(path.dirname(blob), { recursive: true });
  fs.writeFileSync(blob, JSON.stringify({ kind: "source_manifest", content, content_sha256: contentSha, bytes: Buffer.byteLength(content, "utf8"), source_manifest: manifest, binding: { revision_kind: "code", revision: manifest.fingerprint } }), "utf8");

  console.log(`\n[1] 功能清单根入口：整条读路径的现读都发生在**一次**派生作用域内`);
  const outsideBefore = readsOutsideScope.length;
  installReadCounter();
  readCount.clear();
  const r1 = readFeatureLedger("fx", dataDir, { document: "current" }, { project_exists: () => true });
  uninstallReadCounter();
  const outsideNow = readsOutsideScope.slice(outsideBefore);
  ok("ok" in r1 && r1.ok === true, "读口返回 ok（夹具可派生出功能清单）");
  const totalReads = [...readCount.values()].reduce((a, b) => a + b, 0);
  ok(totalReads > 0, `本次读口确实读盘（${totalReads} 次 readFileSync）`);
  ok(outsideNow.length === 0, `根入口把整条读路径收进作用域：作用域外的现读 = 0（实际 ${outsideNow.length}${outsideNow.length ? "，例如 " + outsideNow.slice(0, 3).join("、") : ""}）`);
  const maxReads = Math.max(0, ...readCount.values());
  ok(maxReads <= 3, `同一文件在**一次**请求内最多被读 ${maxReads} 次（无反复重读；此前真机现场同一份修订被读 50 次）`);

  console.log(`\n[2] 作用域不跨请求：两次读口之间改源，第二次立刻看见`);
  const r2a = readFeatureLedger("fx", dataDir, { document: "current" }, { project_exists: () => true });
  const newPlan = planText("B");
  fs.writeFileSync(plan.abs, newPlan, "utf8");
  const r2b = readFeatureLedger("fx", dataDir, { document: "current" }, { project_exists: () => true });
  fs.writeFileSync(plan.abs, plan.text, "utf8");
  const revA = "ok" in r2a && r2a.ok ? r2a.ledger.source_revision.plan : null;
  const revB = "ok" in r2b && r2b.ok ? r2b.ledger.source_revision.plan : null;
  ok(revA !== null && revB !== null && revA !== revB, `改图纸源 → 下一次读口的 source_revision.plan 立刻变（${String(revA).slice(0, 12)} → ${String(revB).slice(0, 12)}）`);
  ok(revB === sha256(newPlan), "新读口读到的就是新正文的哈希（无 TTL/无陈旧窗口）");

  console.log(`\n[3] 清单载体：一次派生内只读一次，跨派生重读（内容寻址正文不可变）`);
  installReadCounter();
  readCount.clear();
  const carriers = withDerivationScope(() => [readManifestCarrier(blob), readManifestCarrier(blob), readManifestCarrier(blob)]);
  uninstallReadCounter();
  ok(readsOf(blob) === 1, `一次派生内 3 次读同一载体 → 盘上读 1 次（实际 ${readsOf(blob)}）`);
  ok(eq(carriers[0], carriers[1]) && eq(carriers[1], carriers[2]), "三次返回的载体逐字段一致（判据未改）");
  installReadCounter();
  readCount.clear();
  withDerivationScope(() => readManifestCarrier(blob));
  withDerivationScope(() => readManifestCarrier(blob));
  uninstallReadCounter();
  ok(readsOf(blob) === 2, `两次**不同**派生各读一次 → 共 2 次（跨请求不缓存；实际 ${readsOf(blob)}）`);
  // 载体正文被改（内容地址对不上）→ 下一次派生判 intact:false（不采信）
  fs.writeFileSync(
    blob,
    JSON.stringify({
      kind: "source_manifest",
      content: content + " ",
      content_sha256: contentSha,
      bytes: Buffer.byteLength(content, "utf8"),
      source_manifest: manifest,
      binding: { revision_kind: "code", revision: manifest.fingerprint },
    }),
    "utf8",
  );
  const tampered = withDerivationScope(() => readManifestCarrier(blob));
  ok(tampered !== null && tampered.intact === false, `载体正文被改：下一次派生判 intact=false（实际 ${tampered === null ? "null" : tampered.intact}）`);
  fs.writeFileSync(blob, JSON.stringify({ kind: "source_manifest", content, content_sha256: contentSha, bytes: Buffer.byteLength(content, "utf8"), source_manifest: manifest, binding: { revision_kind: "code", revision: manifest.fingerprint } }), "utf8");

  console.log(`\n[3b] 载体返回**深独立副本**：同一派生里一处深改不泄露给其他检查（root 反例，E/runtime-root-carrier-alias）`);
  const withinScope = withDerivationScope(() => {
    const a = readManifestCarrier(blob);
    if (a === null) throw new Error("fixture carrier missing");
    const originalRev = a.binding === null ? null : a.binding.revision;
    // 直接对**真实载体**就地深改：嵌套对象（binding）、数组元素（manifest.files[0]）、标量（intact）
    a.binding!.revision = "MUTATED";
    a.manifest.files[0]!.path = "MUTATED";
    a.intact = false;
    const b = readManifestCarrier(blob);
    return {
      sameObject: a === b,
      originalRev,
      rev: b === null ? null : (b.binding?.revision ?? null),
      path: b === null ? null : b.manifest.files[0]!.path,
      intact: b === null ? null : b.intact,
    };
  });
  ok(withinScope.sameObject === false, "同一派生里两次读返回**不同对象**（不是共享可变记忆对象）");
  ok(withinScope.rev === withinScope.originalRev, `前后两次读的 binding.revision 独立（前一次就地改成 MUTATED 不泄露；实际 ${withinScope.rev}）`);
  ok(withinScope.path === srcFiles[0]!.rel, `前后两次读的 manifest.files[0].path 独立（实际 ${withinScope.path}，期望 ${srcFiles[0]!.rel}）`);
  ok(withinScope.intact === true, `前后两次读的 intact 独立（实际 ${withinScope.intact}）`);

  console.log(`\n[3c] 下一次 scope 重新读现场：就地深改不跨派生残留；正文被改 → 损坏判定 intact=false`);
  const nextScope = withDerivationScope(() => readManifestCarrier(blob));
  ok(
    nextScope !== null && nextScope.intact === true && nextScope.binding?.revision === manifest.fingerprint,
    `下一个 scope 重新从盘上读：不受前一次派生内就地改动影响（intact=${nextScope?.intact}，binding.revision=${nextScope?.binding?.revision}）`,
  );
  const blobValid = fs.readFileSync(blob, "utf8");
  fs.writeFileSync(blob, JSON.stringify({ kind: "source_manifest", content: content + " ", content_sha256: contentSha, bytes: Buffer.byteLength(content, "utf8"), source_manifest: manifest, binding: { revision_kind: "code", revision: manifest.fingerprint } }), "utf8");
  const damagedNext = withDerivationScope(() => readManifestCarrier(blob));
  ok(damagedNext !== null && damagedNext.intact === false, `下一个 scope 重新做损坏判定：正文被改 → intact=false（实际 ${damagedNext === null ? "null" : damagedNext.intact}）`);
  fs.writeFileSync(blob, blobValid, "utf8");

  console.log(`\n[4] 功能清单只读 worker 作业：与直接调用逐字段相同 + 运行期间目录零写入`);
  const direct = readFeatureLedger("fx", dataDir, { document: "current" }, { project_exists: () => true });
  // worker 运行期间项目目录逐字节不变（读写边界：纯只读）
  const treeSha = (root: string): string => {
    const acc: string[] = [];
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.isFile()) acc.push(`${path.relative(root, p)}:${crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex")}`);
      }
    };
    walk(root);
    return crypto.createHash("sha256").update(acc.join("\n")).digest("hex");
  };
  const treeBefore = treeSha(projectRoot);
  let viaWorker: unknown = null;
  let workerErr: unknown = null;
  try {
    viaWorker = await runReadJob("feature_ledger", { projectId: "fx", dataDir, params: { document: "current" }, projectExists: true });
  } catch (e) {
    workerErr = e;
  }
  const treeAfter = treeSha(projectRoot);
  ok(workerErr === null, `worker 作业成功返回（错误：${workerErr instanceof Error ? workerErr.message : String(workerErr)}）`);
  ok(treeBefore === treeAfter, "worker 运行期间项目目录逐字节不变（只读作业零写入）");
  const canon = (v: unknown) => JSON.stringify(v, (k, val) => (k === "generated_at" ? "<ts>" : val));
  ok(canon(viaWorker) === canon(direct), "worker 路径与直接调用的功能清单 canonical 逐字段相同");

  console.log(`\n[4b] worker 基础设施不可用：明确结构化失败，**不**静默回退主线程`);
  const badEntry = path.join(tmpRoot, "not-a-worker-entry.txt");
  fs.writeFileSync(badEntry, "this is not a worker entry\n", "utf8");
  const prevEntry = process.env.TATAI_READ_WORKER_ENTRY;
  process.env.TATAI_READ_WORKER_ENTRY = badEntry;
  __resetReadWorkerPoolForTest();
  let infraErr: unknown = null;
  let infraResolved = false;
  try {
    const v = await runReadJob("feature_ledger", { projectId: "fx", dataDir, params: { document: "current" }, projectExists: true });
    infraResolved = v !== undefined && v !== null;
  } catch (e) {
    infraErr = e;
  }
  if (prevEntry === undefined) delete process.env.TATAI_READ_WORKER_ENTRY;
  else process.env.TATAI_READ_WORKER_ENTRY = prevEntry;
  __resetReadWorkerPoolForTest();
  const infraDesc = infraErr === null ? null : describeReadJobError(infraErr);
  ok(!infraResolved, "worker 起不来时作业**不**返回本地结果（没有静默回退主线程）");
  ok(infraErr !== null, `worker 不可用 ⇒ 作业**拒绝**（实际 ${infraErr === null ? "竟返回值" : "抛错"}）`);
  ok(
    infraDesc !== null && typeof infraDesc.code === "string" && infraDesc.code !== "",
    `失败带结构化 code（实际 ${infraDesc?.code ?? "无"}）`,
  );
  ok(
    infraDesc !== null && infraDesc.httpStatus >= 500,
    `失败映射到 5xx（不冒充成功；实际 ${infraDesc?.httpStatus ?? "—"}）`,
  );
  // 基础设施类错误的文档化映射（读口按此把 worker 故障如实回成 503 可重试）
  ok(describeReadJobError(new ReadWorkersUnavailable("x")).code === "READ_WORKERS_UNAVAILABLE", "describeReadJobError 保留结构化 code（不压成通用码）");
  ok(describeReadJobError(new ReadWorkersUnavailable("x")).httpStatus === 503, "READ_WORKERS_UNAVAILABLE → 503（可重试）");

  console.log(`\n[5] 只读入口：必要源**前后复核**不被作用域吞掉（作用域外仍有图纸源现读）`);
  const outsideBeforeEntry = readsOutsideScope.length;
  installReadCounter();
  readCount.clear();
  let entryOk = false;
  try {
    const view = computeEntryView({ projectId: "fx", dataDir, input: { project_id: "fx", role: "executor" }, workPackage: true }) as { ok?: boolean };
    entryOk = view?.ok === true;
  } catch (e) {
    entryOk = false;
    console.log(`    （computeEntryView 抛错：${(e as Error).message}）`);
  }
  uninstallReadCounter();
  const outsideEntry = readsOutsideScope.slice(outsideBeforeEntry);
  ok(entryOk, "computeEntryView 返回 ok（夹具可派生入口视图）");
  const designReadsOutside = outsideEntry.filter((p) => p === design.abs || p === plan.abs).length;
  ok(
    designReadsOutside > 0,
    `入口计算期间存在**作用域外**的图纸源现读（实际 ${designReadsOutside} 次；作用域只复用同一次派生里的重复现读，不改前后复核判据）`,
  );
  const planReadsEntry = readsOf(plan.abs) + readsOf(design.abs);
  ok(planReadsEntry > 0, `入口计算确实读了图纸源（${planReadsEntry} 次）`);

  console.log(`\n[6] 源清单复核在作用域外照旧逐文件现读（不因根入口包了作用域被复用掩盖）`);
  const vBefore = withDerivationScope(() => verifySourceManifest(projectRoot, manifest));
  const target = srcFiles[2]!;
  const st = fs.statSync(target.abs);
  const sameSize = target.text.replace(/[0-9]/, (d) => String((Number(d) + 1) % 10));
  fs.writeFileSync(target.abs, sameSize, "utf8");
  fs.utimesSync(target.abs, st.atime, st.mtime);
  const vAfter = withDerivationScope(() => verifySourceManifest(projectRoot, manifest));
  ok(vBefore.status === "valid", `夹具前提：改动前清单纯 valid（实际 ${vBefore.status}）`);
  ok(vAfter.status === "invalidated" && vAfter.changed.includes(target.rel), `同尺寸+保留 mtime 改动：下一次派生判 invalidated（实际 ${vAfter.status}）`);
  fs.writeFileSync(target.abs, target.text, "utf8");
  fs.utimesSync(target.abs, st.atime, st.mtime);

  void flResult;
} catch (e) {
  fails.push(`夹具/执行异常：${(e as Error).message}`);
  console.log(`  ✗ 夹具/执行异常：${(e as Error).stack}`);
} finally {
  uninstallReadCounter();
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    skips.push(`夹具目录未能删除（${tmpRoot}）`);
  }
}

console.log(`\n[verify] 小结：PASS ${pass}，FAIL ${fails.length}${skips.length > 0 ? `，SKIP ${skips.length}` : ""}`);
if (fails.length > 0) {
  console.log("[verify] FAIL 明细：\n  - " + fails.join("\n  - "));
  process.exitCode = 1;
} else if (skips.length > 0) {
  console.log("[verify] 结果: 全部 PASS（有 SKIP）");
  process.exitCode = 3;
} else {
  console.log("[verify] 结果: 全部 PASS");
}
