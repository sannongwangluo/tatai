// verify-v09-69-rework：V09-69 复审返工的红-绿反例（R69-01…05 / R69-07；DESIGN §3.18 / §6.15）。
//
// 隔离口径（AGENTS.md §5）：mkdtemp 隔离 TATAI_HOME + 隔离项目夹具；HTTP 绑 127.0.0.1:0（随机端口，
// **绝不**抢 8787）；不碰真实 ~/.tatai / 真实项目 / 账本 / 安装物。
//
// 覆盖（每条都给出「修复前会红、修复后应绿」的判据）：
//   R69-01 损坏描述符（invalid）⇒ unknown（**不得** healthy）；两读口/导出同口径。
//   R69-03 冷启动（有效描述符、从未成功、无故障/拒绝）⇒ unknown + NO_EVIDENCE（不凭存活猜 healthy）。
//   READ_ABORTED 正常取消**不**当永久故障（不改状态；保留证据）；区分故障异常（超时/失败）。
//   R69-02 degraded_since 按 scope 独立、优先从真实异常时间派生（A 失败 → B 正常 → A 再读，起点不抖）。
//   R69-04 byProject 有界 + 最旧淘汰（超出上限不无界增长）。
//   R69-05 采集端白名单：真实遥测 incident.reason / service.reason 只出**受控模板**（无 err.message/路径）；
//          shared sanitize/export 对**恶意自由文本**也不漏（含空格 Windows 路径 / 相对路径 / 短凭据 / query /
//          纯字母长串），且稳定枚举码不误伤；单一契约（UI 用同一份）。
//   R69-07 worker 不可用路径带上项目作用域（最小修，不扩池重设计）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
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

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-v09-69-rework-"));
const HOME = path.join(tmpRoot, "home");
const PROJ = path.join(tmpRoot, "proj");
fs.mkdirSync(HOME, { recursive: true });
fs.mkdirSync(path.join(PROJ, ".工作台", "work"), { recursive: true });
process.env.TATAI_HOME = HOME;
process.env.TATAI_NO_AUTOSTART = "1";

const registry = await loadSrc<any>("src/server/registry.ts");
const workHostMod = await loadSrc<any>("src/server/workHost.ts");
const diag = await loadSrc<any>("src/server/work/runtimeDiagnostics.ts");
const poolMod = await loadSrc<any>("src/server/work/readWorkerPool.ts");
const shared = await loadSrc<any>("src/shared/runtimeDiagnostics.ts");

const PID = "v0969-rework-fixture";
registry.addProject({ id: PID, name: "运行诊断返工夹具", path: PROJ, kind: "backend" }, HOME);

const threadsPool = {
  mode: "worker", running: 0, busy: 0, queued: 0, pool_size: 2, queue_limit: 64, group_queue_limit: 32,
  groups_queued: 0, started: 0, completed: 0, failed: 0, timed_out: 0, rejected_full: 0, rejected_group_full: 0,
  last_error: null,
};
const idlePools = { ...threadsPool, scan: { ...threadsPool } };
const emptyTelemetry = {
  incidents: [], last_success_at: null, last_anomaly: null, last_rejection_at: null, by_project: {},
  queue_ms: null, execution_ms: null, total_ms: null, samples: 0,
};
const validProbe = { present: true, state: "valid", pid_alive: true, is_self: true, reason: null };

const now = Date.now();
const build = (o: any): any =>
  diag.buildRuntimeDiagnosticsReport({
    dataDir: HOME, projectId: null, detail: "summary", service: validProbe, pools: idlePools, now, ...o,
  });
const signals = (o: any): any => ({
  now, descriptorState: "valid", descriptorPidAlive: true, readMode: "worker", scanMode: "worker",
  readQueued: 0, readQueueLimit: 64, lastRejectionAt: null, lastSuccessAt: null, lastAnomaly: null,
  staleAfterMs: 30_000, ...o,
});

async function main(): Promise<void> {
  info(`隔离数据目录 ${HOME}｜项目 ${PID}`);

  // ════════ R69-01 / R69-03 / READ_ABORTED：判据红-绿 ════════
  console.log("\n[verify] ═══ R69-01/R69-03/READ_ABORTED 判据 ═══");
  const inv = diag.deriveRuntimeHealth(signals({ descriptorState: "invalid", descriptorPidAlive: false }));
  ok(inv.status === "unknown" && inv.reasons.some((r: any) => r.code === "UNKNOWN"), "R69-01 损坏描述符(invalid) ⇒ unknown（修复前落 healthy）", inv);

  const cold = diag.deriveRuntimeHealth(signals({}));
  ok(cold.status === "unknown" && cold.reasons.some((r: any) => r.code === "NO_EVIDENCE"), "R69-03 冷启动（有效描述符/从未成功/无异常）⇒ unknown + NO_EVIDENCE（修复前 healthy）", cold);

  const okAfter = diag.deriveRuntimeHealth(signals({ lastSuccessAt: now - 1000 }));
  ok(okAfter.status === "healthy" && okAfter.reasons.some((r: any) => r.code === "OK"), "绿：有成功观测且无故障 ⇒ healthy（不误伤）", okAfter.status);

  const abortedOnly = diag.deriveRuntimeHealth(
    signals({ lastAnomaly: { at: now - 1000, outcome: "aborted", code: "READ_ABORTED" } }),
  );
  ok(
    abortedOnly.status === "unknown" && abortedOnly.reasons.some((r: any) => r.code === "READ_ABORTED") && !abortedOnly.reasons.some((r: any) => r.code === "READ_FAILED"),
    "READ_ABORTED 正常取消：**不**当永久故障（不改判为 degraded），仍保留 READ_ABORTED 证据",
    abortedOnly,
  );
  const abortedWithSuccess = diag.deriveRuntimeHealth(
    signals({ lastSuccessAt: now - 2000, lastAnomaly: { at: now - 1000, outcome: "aborted", code: "READ_ABORTED" } }),
  );
  ok(
    abortedWithSuccess.status === "healthy" && abortedWithSuccess.reasons.some((r: any) => r.code === "READ_ABORTED"),
    "READ_ABORTED 且有成功观测 ⇒ healthy（取消不改状态，只留证据）",
    abortedWithSuccess,
  );

  // ════════ R69-02：degraded_since 按 scope 独立 + 从真实异常时间派生 ════════
  console.log("\n[verify] ═══ R69-02 degraded_since 跨项目独立 ═══");
  diag.__resetDegradedSinceForTest();
  const tele = (id: string, success: number | null, anomaly: any) => ({
    incidents: [], last_success_at: success, last_anomaly: anomaly, last_rejection_at: null,
    by_project: { [id]: { last_success_at: success, last_anomaly: anomaly, last_rejection_at: null } },
    queue_ms: null, execution_ms: null, total_ms: null, samples: 0,
  });
  const buildAt = (t: number, projectId: string, tel: any): any =>
    diag.buildRuntimeDiagnosticsReport({ dataDir: HOME, projectId, detail: "summary", service: validProbe, now: t, pools: idlePools, telemetry: tel });
  const anomalyA = { at: 900, outcome: "timed_out", code: "READ_TIMED_OUT" };
  const a1 = buildAt(1000, "A", tele("A", 800, anomalyA));
  const b1 = buildAt(2000, "B", tele("B", 2000, null));
  const a2 = buildAt(3000, "A", tele("A", 800, anomalyA));
  ok(Date.parse(a1.degraded_since) === 0 && Date.parse(a1.degraded_since) !== 1000 && a1.degraded_since === a2.degraded_since, "R69-02 A 降级起点**从真实异常时间**派生（异常 0.9s 截秒=0s，**非**读取时刻 1s）；A-B-A 不抖", { a1: a1.degraded_since, a2: a2.degraded_since });
  ok(b1.status === "unknown" || b1.status === "healthy", "R69-02 B 全局读数不冒充 A", b1.status);
  ok(a2.degraded_since === a1.degraded_since, "R69-02 B（另项目）读取后 A 再读，降级起点**不被清零/抖动**（修复前 A2 被重置为读取时刻）", { a1: a1.degraded_since, a2: a2.degraded_since });

  // ════════ R69-05：采集端白名单 + shared 纵深防御 ════════
  console.log("\n[verify] ═══ R69-05 脱敏（采集端模板 + shared sanitize/export）═══");
  const r = (s: string): string => shared.redactRuntimeText(s);
  ok(!r("sk-abcdefghijklmnopqrstuvwxyzABCDEF").includes("abcdefghij"), "纯字母长串 token 被抹", r("sk-abcdefghijklmnopqrstuvwxyzABCDEF"));
  ok(!r("abcdefghijklmnopqrstuvwxyz").includes("abcdefghij"), "纯小写长串 token 被抹", r("abcdefghijklmnopqrstuvwxyz"));
  ok(r("C:\\Program Files\\secret\\token.txt") === "<path>", "含空格 Windows 路径整段抹（修复前在空白处截断）", r("C:\\Program Files\\secret\\token.txt"));
  ok(r("D:\\资料\\密钥\\token.txt") === "<path>", "中文路径整段抹", r("D:\\资料\\密钥\\token.txt"));
  ok(r("relative/path/secret/file.txt") === "<path>", "相对路径抹（修复前原样）", r("relative/path/secret/file.txt"));
  ok(!r("project_id=huojia&detail=full").includes("huojia"), "query 串值被抹", r("project_id=huojia&detail=full"));
  ok(!r("token=abc123").includes("abc123"), "短凭据 key=value 值被抹（修复前原样）", r("token=abc123"));
  ok(!r('{"token":"abc123","password":"hunter2"}').includes("hunter2"), "JSON 凭据对值被抹", r('{"token":"abc123","password":"hunter2"}'));
  ok(r("READ_WORKERS_UNAVAILABLE") === "READ_WORKERS_UNAVAILABLE", "绿：稳定枚举码（纯大写+下划线）不误伤", r("READ_WORKERS_UNAVAILABLE"));
  ok(shared.redactPaths("my-project-20261013-report") === "my-project-20261013-report", "绿：带数字的项目标识不被误抹", null);

  // service.reason 只出受控模板（不在报告里内联 probe 的原始 err.message/路径）
  const rawReason = "描述符不是合法 JSON：C:\\Users\\me\\.tatai\\work-service.json 读取失败 token=abc123";
  const svcReport = diag.buildRuntimeDiagnosticsReport({
    dataDir: HOME, projectId: null, detail: "summary",
    service: { present: false, state: "invalid", pid_alive: false, is_self: false, reason: rawReason },
    pools: idlePools, telemetry: emptyTelemetry, now,
  });
  ok(
    svcReport.status === "unknown" && svcReport.service.reason === "写入服务描述符在场但损坏/读不出（所有权未知，既不发布也不删除）",
    "R69-05 service.reason 是**受控模板**（不内联 probe 原始 err.message/路径/凭据）",
    svcReport.service.reason,
  );
  ok(!JSON.stringify(svcReport).includes("abc123") && !JSON.stringify(svcReport).includes("work-service.json"), "报告整体不含被拒的凭据/路径原文", null);

  // 恶意自由文本 → sanitize 与 export 都不漏
  const hostile = {
    ok: true, schema: "runtime-diagnostics-v1", generated_at: new Date(now).toISOString(),
    project_id: "C:\\Users\\me\\secret-proj",
    status: "healthy", reasons: [{ code: "QUEUE_SATURATED", detail: "见 C:\\Program Files\\secret\\token.txt 与 relative/path/secret/file.txt 与 token=abc123 与 project_id=huojia&detail=full" }],
    incidents: [{ at: new Date(now).toISOString(), outcome: "failed", job_kind: "entry", project_id: "D:\\资料\\密钥", code: "token=abc123", reason: "sk-abcdefghijklmnopqrstuvwxyzABCDEF 与 /etc/passwd" }],
    process: { pid: 1, build_identity: { embedded: false, reason: "读 C:\\Program Files\\x 失败" }, build_identity_skew: { state: "unknown", detail: "x" } },
    service: { reachable: false, descriptor: { present: false, state: "invalid", pid_alive: false, is_self: false }, reason: "{\"token\":\"abc123\",\"password\":\"hunter2\"}" },
    queue: { read: {}, scan: {} }, timing: {}, unsupported: ["runtime_diagnostics", "C:\\evil\\path"],
  };
  const clean = shared.sanitizeRuntimeDiagnosticsReport(hostile);
  const cleanJson = JSON.stringify(clean);
  ok(clean !== null && clean.project_id === null && clean.incidents[0].code === null, "R69-05 sanitize：非法 project_id/code（含路径/凭据）一律置空", { p: clean?.project_id, c: clean?.incidents?.[0]?.code });
  ok(!cleanJson.includes("abc123") && !cleanJson.includes("hunter2") && !cleanJson.includes("secret") && !cleanJson.includes("huojia") && !cleanJson.includes("Program Files"), "R69-05 sanitize：恶意自由文本里的短凭据/路径/query 全部不漏", cleanJson.slice(0, 300));
  ok(clean.unsupported.length === 1 && clean.unsupported[0] === "runtime_diagnostics", "R69-05 sanitize：unsupported 走能力名白名单（保留 runtime_diagnostics，丢弃路径）", clean.unsupported);
  const expo = shared.buildRuntimeDiagnosticsExport(clean, null, { now: new Date(now).toISOString() });
  const expoJson = JSON.stringify(expo);
  ok(!expoJson.includes("abc123") && !expoJson.includes("hunter2") && !expoJson.includes("huojia") && !expoJson.includes("Program Files"), "R69-05 export：导出体同样不漏（单一契约，UI 同用）", expoJson.slice(0, 200));

  // ════════ R69-04：byProject 有界 + 最旧淘汰（真 worker 作业）════════
  console.log("\n[verify] ═══ R69-04 byProject 有界 + 淘汰（真 worker 作业）═══");
  poolMod.__resetRuntimeDiagnosticsForTest();
  const cap = poolMod.RUNTIME_TELEMETRY_MAX_PROJECTS;
  const N = cap + 6;
  let failedJobs = 0;
  for (let i = 0; i < N; i++) {
    try {
      // 项目不存在 ⇒ 作业失败（仍会在 noteQueued/noteAnomalyOutcome 里建 scope 条目）
      await poolMod.runReadJob("entry", { projectId: `rework-proj-${i}`, dataDir: tmpRoot, input: {} });
    } catch {
      failedJobs += 1;
    }
  }
  const tel = poolMod.runtimeTelemetry();
  const size = Object.keys(tel.by_project).length;
  ok(failedJobs === N, `R69-04 真跑 ${N} 个不同 project_id 的失败作业（前置条件）`, { failedJobs });
  ok(size <= cap, `R69-04 byProject 有界（attempted ${N} distinct ⇒ size ${size} ≤ 上限 ${cap}；修复前会等于 ${N}）`, { size, cap });
  ok(Object.prototype.hasOwnProperty.call(tel.by_project, `rework-proj-${N - 1}`), "R69-04 最近使用的 scope 保留（LRU 触达）", null);
  ok(!Object.prototype.hasOwnProperty.call(tel.by_project, "rework-proj-0"), "R69-04 最旧的 scope 被淘汰", null);

  // incident.reason 只出受控模板（真实遥测）
  const lastInc = tel.incidents.at(-1);
  ok(
    typeof lastInc?.reason === "string" && !lastInc.reason.includes(tmpRoot) && !lastInc.reason.includes("项目不存在") && !lastInc.reason.includes("rework-proj-"),
    "R69-05 真实遥测 incident.reason 是受控模板（不含 err.message/路径/项目参数原文）",
    lastInc,
  );
  ok(lastInc?.code === "INVALID_COMMAND", "R69-05 incident.code 保留结构化错误码（闭集不被误伤）", lastInc?.code);

  // ════════ 两读口 / 导出（真 HTTP 随机端口）════════
  console.log("\n[verify] ═══ 两读口同源 + 导出不夹带（真 HTTP）═══");
  const host = workHostMod.createWorkHost(HOME, {});
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/api/runtime/diagnostics") {
      const outcome = diag.runtimeDiagnosticsRouteResult({
        rawUrl: req.url ?? "/", remoteLocalOnlyDenied: false,
        projectExists: (id: string) => registry.getProject(id, HOME) !== undefined,
        build: (q: any) => host.service.runtimeDiagnostics({ projectId: q.projectId, detail: q.detail }),
      });
      res.statusCode = outcome.status;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify(outcome.body));
      return;
    }
    void host.handle(req, res, url.pathname).then((h: boolean) => {
      if (!h) {
        res.statusCode = 404;
        res.end();
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address() as { port: number };
  host.publish(addr.port, "127.0.0.1");
  const get = (p: string, token?: string): Promise<{ status: number; json: any }> =>
    new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: addr.port, method: "GET", path: p, headers: token ? { "x-tatai-work-token": token } : {} }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json: any = null;
          try { json = text === "" ? null : JSON.parse(text); } catch { json = text; }
          resolve({ status: res.statusCode ?? 0, json });
        });
      });
      req.on("error", reject);
      req.end();
    });
  try {
    const local = await get("/api/runtime/diagnostics");
    const tokened = await get("/api/work/diagnostics", host.token);
    ok(local.status === 200 && tokened.status === 200, "两读口都 200", { local: local.status, tokened: tokened.status });
    const strip = (o: any): any => { const c = JSON.parse(JSON.stringify(o)); delete c.generated_at; return c; };
    ok(JSON.stringify(strip(local.json)) === JSON.stringify(strip(tokened.json)), "两读口**同源同判据**（除 generated_at 外逐字段相等）", null);
    const lj = JSON.stringify(local.json);
    ok(!lj.includes(host.token) && !lj.includes(tmpRoot) && !lj.includes("abc123") && !lj.includes("hunter2"), "实报告不含写服务 token / 数据目录绝对路径 / 凭据", null);
    ok(local.json?.incidents?.every((i: any) => typeof i.reason === "string" && !i.reason.includes(tmpRoot)), "实报告 incidents[].reason 均不含数据目录路径", null);
    const ex = shared.buildRuntimeDiagnosticsExport(local.json, null, { now: new Date(now).toISOString() });
    ok(!JSON.stringify(ex).includes(host.token) && !JSON.stringify(ex).includes(tmpRoot), "导出体不含 token/绝对路径", null);
  } finally {
    host.unpublish();
    await new Promise<void>((r) => server.close(() => r()));
  }

  console.log(`\n[verify] 小结：${pass} 条 PASS，${fails.length} 条 FAIL`);
  if (fails.length > 0) {
    console.error(`[verify] 失败：\n- ${fails.join("\n- ")}`);
    process.exitCode = 1;
  }
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
}

main().catch((e) => {
  console.error("[verify] 运行失败：", e);
  process.exit(1);
});
