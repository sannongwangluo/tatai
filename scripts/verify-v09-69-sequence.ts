// verify-v09-69-sequence：ND1 反例——**真实 pool 生命周期**的成功/失败/超时/取消**连续序列**回归。
//
// 背景（根协调者增量审查 ROOT-SEQUENCE-REVIEW.md，2026-10-13）：既有 rework 复验只用**注入遥测**验证
// 「成功/取消」「成功/超时」等离散输入，未验证真实遥测连续序列。ND1 反例：
//   成功 → 真失败/超时 → 用户普通取消（此后**无新成功**）
// 若普通取消无条件以 aborted 覆盖 lastAnomaly（修复前 `noteAnomaly` 的行为），而 `deriveRuntimeHealth`
// 忽略 `READ_ABORTED`，则真故障被最后取消盖掉 ⇒ **落 healthy**（掩盖已有故障）。
//
// 验收口径（本脚本逐条给出「修复前会红、修复后应绿」判据，全部走**真实 worker 池**生命周期）：
//   ① 成功→失败→取消（无新成功）：**不得** healthy；READ_FAILED 故障保留，取消只作历史（incidents 仍记 aborted）。
//   ② 成功→超时→取消（无新成功）：**不得** healthy；READ_TIMED_OUT 故障保留。
//   ③ 拒绝→取消：拒绝信号不因随后取消丢失（不得 healthy）。
//   ④ 失败→取消→成功：后来的**真实成功**解除故障 ⇒ healthy（不误伤）。
//   ⑤ 跨项目隔离：A 故障未被 B 的取消盖掉；B 的报告不冒充 A 的故障。
//   ⑥ 普通取消仍只作历史：成功→取消（无故障）⇒ healthy + READ_ABORTED 证据（不新增永久故障）。
//   ⑦ 冷启动取消（从未成功）⇒ unknown（不永久故障、不误报 healthy）。
//
// 隔离（AGENTS.md §5）：mkdtemp 隔离 TATAI_HOME + 假 worker（有界）；不碰真实 ~/.tatai / 真实项目 / 账本。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const loadSrc = async <T>(rel: string): Promise<T> => (await import(pathToFileURL(path.join(REPO_ROOT, rel)).href)) as T;

let pass = 0;
const fails: string[] = [];
const ok = (cond: boolean, label: string, detail?: unknown): void => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (cond) pass += 1;
  else {
    fails.push(label);
    if (detail !== undefined) console.log(`[verify]   现场：${JSON.stringify(detail).slice(0, 1200)}`);
  }
};
const info = (m: string): void => console.log(`[verify]   ${m}`);

// ── 隔离环境 + 假 worker（在 import 池模块**之前**设好有界池参数）──
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-v09-69-seq-"));
const HOME = path.join(tmpRoot, "home");
fs.mkdirSync(HOME, { recursive: true });
process.env.TATAI_HOME = HOME;
process.env.TATAI_NO_AUTOSTART = "1";
process.env.TATAI_READ_WORKER_POOL = "1";
process.env.TATAI_READ_WORKER_QUEUE = "1";
process.env.TATAI_READ_WORKER_GROUP_QUEUE = "1";
process.env.TATAI_READ_WORKER_TIMEOUT_MS = "500";

const workerDir = path.join(tmpRoot, "workerctl");
fs.mkdirSync(workerDir, { recursive: true });
const controlPath = path.join(workerDir, "control.json");
const fakeWorkerPath = path.join(tmpRoot, "seq-read-worker.mjs");
fs.writeFileSync(
  fakeWorkerPath,
  [
    'import fs from "node:fs";',
    'import path from "node:path";',
    'import { parentPort } from "node:worker_threads";',
    'const dir = process.env.TATAI_TEST_WORKER_DIR || "";',
    'function control() {',
    '  try { return JSON.parse(fs.readFileSync(path.join(dir, "control.json"), "utf8")); } catch { return {}; }',
    '}',
    'parentPort.on("message", (msg) => {',
    '  const id = msg && msg.id;',
    '  const c = control();',
    '  if (c.behavior === "hang") return; // 不返回：等超时或调用方取消',
    '  const delay = Number(c.delayMs) || 0;',
    '  setTimeout(() => {',
    '    if (c.behavior === "fail") parentPort.postMessage({ id, ok: false, error: { code: c.code || "READ_JOB_FAILED", message: "结构化失败（序列夹具）" } });',
    '    else parentPort.postMessage({ id, ok: true, result: { ok: true } });',
    '  }, delay);',
    '});',
    '',
  ].join("\n"),
);
process.env.TATAI_READ_WORKER_ENTRY = fakeWorkerPath;
process.env.TATAI_TEST_WORKER_DIR = workerDir;

const diag = await loadSrc<any>("src/server/work/runtimeDiagnostics.ts");
const poolMod = await loadSrc<any>("src/server/work/readWorkerPool.ts");

const PID = "v0969-seq-A";
const PID2 = "v0969-seq-B";
const validProbe = { present: true, state: "valid", pid_alive: true, is_self: true, reason: null };

const control = (c: Record<string, unknown>): void => fs.writeFileSync(controlPath, JSON.stringify(c));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const run = (projectId: string, opts: { signal?: AbortSignal } = {}): Promise<unknown> =>
  poolMod.runReadJob("entry", { projectId, dataDir: tmpRoot, input: {} }, opts.signal === undefined ? {} : { signal: opts.signal });

const report = (projectId: string | null): any =>
  diag.buildRuntimeDiagnosticsReport({
    dataDir: tmpRoot,
    projectId,
    detail: "summary",
    service: validProbe,
    now: Date.now(),
    telemetry: poolMod.runtimeTelemetry(),
  });

const reset = (): void => {
  poolMod.__resetRuntimeDiagnosticsForTest();
  diag.__resetDegradedSinceForTest();
};

const succeeded = async (projectId = PID): Promise<void> => {
  control({ behavior: "ok", delayMs: 0 });
  await run(projectId);
};
const failed = async (projectId = PID): Promise<void> => {
  control({ behavior: "fail", delayMs: 0, code: "READ_JOB_FAILED" });
  try {
    await run(projectId);
  } catch {
    /* 预期：结构化失败 */
  }
};
const timedOut = async (projectId = PID): Promise<void> => {
  control({ behavior: "hang" });
  try {
    await run(projectId);
  } catch {
    /* 预期：超时 */
  }
};
const aborted = async (projectId = PID, waitMs = 120): Promise<void> => {
  control({ behavior: "hang" });
  const ac = new AbortController();
  const p = run(projectId, { signal: ac.signal }).catch(() => undefined);
  setTimeout(() => ac.abort(), waitMs);
  await p;
};
const hasReason = (rep: any, code: string): boolean => Array.isArray(rep?.reasons) && rep.reasons.some((r: any) => r.code === code);

async function main(): Promise<void> {
  info(`隔离数据目录 ${HOME}｜假 worker ${fakeWorkerPath}`);

  // ════════ ① 成功 → 失败 → 取消（无新成功）：ND1 主反例 ════════
  console.log("\n[verify] ═══ ① 成功→失败→取消（不得回 healthy）═══");
  reset();
  await succeeded();
  await failed();
  await aborted();
  {
    const tel = poolMod.runtimeTelemetry();
    const pScoped = tel.by_project?.[PID];
    ok(tel.last_anomaly?.code === "READ_FAILED", "① 全局 lastAnomaly 保留真故障 READ_FAILED（不被 aborted 覆盖）", tel.last_anomaly);
    ok(pScoped?.last_anomaly?.code === "READ_FAILED", "① 项目 last_anomaly 保留 READ_FAILED（项目口径一致）", pScoped?.last_anomaly);
    ok(tel.incidents.some((i: any) => i.outcome === "aborted" && i.code === "READ_JOB_ABORTED"), "① 取消仍作历史（incidents 记 aborted）", tel.incidents.map((i: any) => i.code));
    const g = report(null);
    const a = report(PID);
    ok(g.status !== "healthy" && hasReason(g, "READ_FAILED"), "① 全局报告不得 healthy（修复前落 healthy）、保留 READ_FAILED", { status: g.status, reasons: g.reasons.map((r: any) => r.code) });
    ok(a.status !== "healthy" && hasReason(a, "READ_FAILED"), "① 项目报告不得 healthy（修复前落 healthy）、保留 READ_FAILED", { status: a.status, reasons: a.reasons.map((r: any) => r.code) });
  }

  // ════════ ② 成功 → 超时 → 取消（无新成功）════════
  console.log("\n[verify] ═══ ② 成功→超时→取消（不得回 healthy）═══");
  reset();
  await succeeded();
  await timedOut();
  await aborted();
  {
    const tel = poolMod.runtimeTelemetry();
    ok(tel.last_anomaly?.code === "READ_TIMED_OUT", "② 全局 lastAnomaly 保留超时 READ_TIMED_OUT（不被 aborted 覆盖）", tel.last_anomaly);
    ok(tel.incidents.some((i: any) => i.outcome === "aborted"), "② 取消仍作历史", tel.incidents.map((i: any) => i.outcome));
    const a = report(PID);
    ok(a.status !== "healthy" && hasReason(a, "READ_TIMED_OUT"), "② 项目报告不得 healthy、保留 READ_TIMED_OUT", { status: a.status, reasons: a.reasons.map((r: any) => r.code) });
  }

  // ════════ ③ 拒绝 → 取消：拒绝信号不丢 ════════
  console.log("\n[verify] ═══ ③ 拒绝→取消（拒绝信号不丢）═══");
  reset();
  {
    control({ behavior: "hang" });
    const acA = new AbortController();
    const pA = run(PID, { signal: acA.signal }).catch(() => undefined); // 在途，占满池
    const acB = new AbortController();
    const pB = run(PID, { signal: acB.signal }).catch(() => undefined); // 排队（队满）
    let rejected: any = null;
    try {
      await run(PID); // 第三次：队列满 → 显式拒绝
    } catch (e) {
      rejected = e;
    }
    ok(rejected?.code === "READ_QUEUE_FULL", "③ 队列满显式拒绝（有界）", rejected?.code);
    acB.abort(); // 先取消排队中的 B
    acA.abort(); // 再取消在途的 A
    await Promise.all([pA, pB]);
    const tel = poolMod.runtimeTelemetry();
    ok(tel.last_anomaly?.outcome === "rejected_full" || tel.last_anomaly?.outcome === "rejected_group_full", "③ 拒绝信号未被随后取消覆盖（lastAnomaly 仍为拒绝）", tel.last_anomaly);
    const a = report(PID);
    ok(a.status !== "healthy" && hasReason(a, "QUEUE_SATURATED"), "③ 报告不得 healthy（饱和降级）、保留 QUEUE_SATURATED", { status: a.status, reasons: a.reasons.map((r: any) => r.code) });
  }

  // ════════ ④ 失败 → 取消 → 成功：真实成功解除故障 ════════
  console.log("\n[verify] ═══ ④ 失败→取消→成功（成功解除故障）═══");
  reset();
  await succeeded();
  await failed();
  await aborted();
  await succeeded();
  {
    const g = report(null);
    const a = report(PID);
    ok(a.status === "healthy" && !hasReason(a, "READ_FAILED"), "④ 项目报告：后来的真实成功解除故障 ⇒ healthy（不误伤）", { status: a.status, reasons: a.reasons.map((r: any) => r.code) });
    ok(g.status === "healthy", "④ 全局报告：真实成功解除故障 ⇒ healthy", { status: g.status, reasons: g.reasons.map((r: any) => r.code) });
  }

  // ════════ ⑤ 跨项目隔离：A 故障不被 B 的取消盖掉 ════════
  console.log("\n[verify] ═══ ⑤ 跨项目隔离（B 取消不掩盖 A 故障）═══");
  reset();
  await succeeded(PID);
  await failed(PID); // A：未恢复故障
  await aborted(PID2); // B：普通取消（从未成功）
  {
    const tel = poolMod.runtimeTelemetry();
    ok(tel.by_project?.[PID]?.last_anomaly?.code === "READ_FAILED", "⑤ A 项目故障保留（未被 B 的取消盖掉）", tel.by_project?.[PID]?.last_anomaly);
    const a = report(PID);
    ok(a.status !== "healthy" && hasReason(a, "READ_FAILED"), "⑤ A 报告不得 healthy、保留自身 READ_FAILED", { status: a.status, reasons: a.reasons.map((r: any) => r.code) });
    const b = report(PID2);
    ok(!hasReason(b, "READ_FAILED") && b.status === "unknown", "⑤ B 报告不冒充 A 的故障（自身 unknown + 取消证据）", { status: b.status, reasons: b.reasons.map((r: any) => r.code) });
    ok(hasReason(b, "READ_ABORTED"), "⑤ B 报告保留自身 READ_ABORTED 证据", b.reasons.map((r: any) => r.code));
    const g = report(null);
    ok(hasReason(g, "READ_FAILED"), "⑤ 全局报告仍反映 A 的未恢复故障（口径一致）", g.reasons.map((r: any) => r.code));
  }

  // ════════ ⑥ 普通取消仍只作历史：成功→取消 ⇒ healthy ════════
  console.log("\n[verify] ═══ ⑥ 成功→取消（只作历史、不新增永久故障）═══");
  reset();
  await succeeded();
  await aborted();
  {
    const a = report(PID);
    ok(a.status === "healthy" && hasReason(a, "READ_ABORTED"), "⑥ 成功后有取消 ⇒ healthy + READ_ABORTED（取消不改状态）", { status: a.status, reasons: a.reasons.map((r: any) => r.code) });
  }

  // ════════ ⑦ 冷启动取消：从未成功 ⇒ unknown（不永久故障、不误报 healthy）════════
  console.log("\n[verify] ═══ ⑦ 冷启动取消（unknown，不永久故障）═══");
  reset();
  await aborted();
  {
    const a = report(PID);
    ok(a.status === "unknown" && hasReason(a, "READ_ABORTED") && !hasReason(a, "READ_FAILED"), "⑦ 从未成功的取消 ⇒ unknown + READ_ABORTED（不判故障、不猜 healthy）", { status: a.status, reasons: a.reasons.map((r: any) => r.code) });
  }

  console.log(`\n[verify] 小结：${pass} 条 PASS，${fails.length} 条 FAIL`);
  if (fails.length > 0) {
    console.error(`[verify] 失败：\n- ${fails.join("\n- ")}`);
    process.exitCode = 1;
  }
}

main()
  .catch((e) => {
    console.error("[verify] 运行失败：", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await poolMod.stopReadWorkers();
    } catch {
      /* ignore */
    }
    if (process.env.TATAI_KEEP_TMP !== "1") {
      try {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });
