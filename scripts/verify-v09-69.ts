// verify-v09-69：运行健康只读读口与统一状态模型（V09-69；DESIGN §3.18 / §6.15）。
//
// 隔离口径（AGENTS.md §5）：mkdtemp 隔离 TATAI_HOME + 隔离项目夹具；HTTP 绑 127.0.0.1:0（随机端口，
// **绝不**抢 8787）；不碰真实 ~/.tatai、真实项目与账本、不接网关、不调模型。
//
// 覆盖（与卡面 chk-v09-69-01…06 对齐）：
//   A 真服务随机端口：本地 `/api/runtime/diagnostics`（不索要 work token）与 tokened `/api/work/diagnostics`
//     **同源同判据**（同一 builder；响应体除 generated_at 外逐字段相等）。
//   B token 边界：tokened 读口无/错令牌 401；本地读口不索要令牌。
//   C 输入语义：detail 非法 / 未知参数 / 重复参数 / project_id 空串 / project_id 未注册 ⇒ 400 INVALID_INPUT。
//   D 四态判据（healthy/degraded/unavailable/unknown）+ 超时/503 按 reason + 新鲜度（30s）。
//   E 故障恢复：先失败后成功 → 当前告警清除、incidents 历史保留。
//   F 只读零写入：账本原字节不增长、描述符不变、不新增文件。
//   G 忙时有界：读池忙/饱和时诊断仍按时返回（构造重派生在途）且**不**被重队列堵住。
//   H 脱敏：sanitize typed allowlist 拒未知字段、恶意路径/token 被抹；报告不含写服务 token / 绝对路径。
//   I 远端默认禁止本地维护口：runtimeDiagnosticsRouteResult(remoteLocalOnlyDenied) ⇒ 403 REMOTE_LOCAL_ONLY。
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
    if (detail !== undefined) console.log(`[verify]   现场：${JSON.stringify(detail).slice(0, 1400)}`);
  }
};
const info = (m: string): void => console.log(`[verify]   ${m}`);

// ── 隔离夹具 ──
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-v09-69-"));
const HOME = path.join(tmpRoot, "home"); // 会发布描述符的数据目录
const HOME2 = path.join(tmpRoot, "home2"); // 不发布描述符（模拟不可达）
const PROJ = path.join(tmpRoot, "proj");
fs.mkdirSync(path.join(PROJ, ".工作台", "work"), { recursive: true });
fs.mkdirSync(HOME, { recursive: true });
fs.mkdirSync(HOME2, { recursive: true });
// 先钉住数据目录与"别自愈拉起写者"，再加载任何读 env 的模块。
process.env.TATAI_HOME = HOME;
process.env.TATAI_NO_AUTOSTART = "1";

const registry = await loadSrc<any>("src/server/registry.ts");
const workHostMod = await loadSrc<any>("src/server/workHost.ts");
const wsMod = await loadSrc<any>("src/server/workstation.ts");
const diag = await loadSrc<any>("src/server/work/runtimeDiagnostics.ts");
const poolMod = await loadSrc<any>("src/server/work/readWorkerPool.ts");
const shared = await loadSrc<any>("src/shared/runtimeDiagnostics.ts");

const PID = "v0969-fixture";
registry.addProject({ id: PID, name: "运行诊断夹具", path: PROJ, kind: "backend" }, HOME);
const WORK = wsMod.projectWorkDir(PID, HOME);
const EVENTS = path.join(WORK, "events.jsonl");

const sha = (p: string): string => (fs.existsSync(p) ? fs.readFileSync(p).toString("base64") : "<none>");
const listWorkFiles = (): string[] => {
  const out: string[] = [];
  const walk = (d: string): void => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) walk(abs);
      else out.push(abs);
    }
  };
  walk(WORK);
  return out.sort();
};

// ── HTTP 小工具 ──
interface Res {
  status: number;
  json: any;
}
const request = (port: number, method: string, p: string, opts: { token?: string; body?: unknown } = {}): Promise<Res> =>
  new Promise((resolve, reject) => {
    const data = opts.body === undefined ? null : Buffer.from(JSON.stringify(opts.body));
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path: p,
        headers: {
          ...(opts.token ? { "x-tatai-work-token": opts.token } : {}),
          ...(data ? { "content-type": "application/json", "content-length": data.length } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json: any = null;
          try {
            json = text === "" ? null : JSON.parse(text);
          } catch {
            json = text;
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });

/** 真实宿主 + HTTP 服务（本地 + tokened 两条读口都挂**真实共享实现**） */
async function startHost(dataDir: string): Promise<{ port: number; token: string; close: () => Promise<void> }> {
  const host = workHostMod.createWorkHost(dataDir, {});
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/api/runtime/diagnostics") {
      // 复刻 index.ts 的本地路由：**同一** runtimeDiagnosticsRouteResult（回环来源 remoteLocalOnlyDenied=false）。
      const outcome = diag.runtimeDiagnosticsRouteResult({
        rawUrl: req.url ?? "/",
        remoteLocalOnlyDenied: false,
        projectExists: (id: string) => registry.getProject(id, dataDir) !== undefined,
        build: (q: any) => host.service.runtimeDiagnostics({ projectId: q.projectId, detail: q.detail }),
      });
      res.statusCode = outcome.status;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify(outcome.body));
      return;
    }
    void host.handle(req, res, url.pathname).then((handled: boolean) => {
      if (!handled) {
        res.statusCode = 404;
        res.end();
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address() as { port: number; address: string };
  host.publish(addr.port, "127.0.0.1");
  return {
    port: addr.port,
    token: host.token,
    close: async () => {
      host.unpublish();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

const snapTelemetry = (over: Record<string, unknown> = {}): any => ({
  incidents: [],
  last_success_at: null,
  last_anomaly: null,
  last_rejection_at: null,
  by_project: {},
  queue_ms: null,
  execution_ms: null,
  total_ms: null,
  samples: 0,
  ...over,
});

const poolsWith = (over: Record<string, unknown>): any => {
  const base = poolMod.readWorkerPoolStatus();
  const read = { ...base, ...over };
  delete (read as any).scan;
  return { ...read, scan: { ...base.scan } };
};

async function main(): Promise<void> {
  info(`隔离数据目录 ${HOME}｜项目 ${PID}｜工作树 ${WORK}`);

  poolMod.__resetRuntimeDiagnosticsForTest();
  const A = await startHost(HOME);
  try {
    // ════════ A/B/C：真服务、双读口同源、token 边界、输入语义 ════════
    console.log("\n[verify] ═══ A/B/C 真服务随机端口：双读口同源 / token 边界 / 输入 400 ═══");
    const local = await request(A.port, "GET", "/api/runtime/diagnostics");
    ok(local.status === 200 && local.json?.ok === true, "A 本地读口 200（**不索要 work token**）", local.json);
    ok(local.json?.schema === "runtime-diagnostics-v1" && local.json?.schema_version === 1, "A schema=runtime-diagnostics-v1 / schema_version=1", local.json?.schema);
    ok(local.json?.stale_after_ms === 30000, "A 运行观测短时阈值 stale_after_ms=30000（不套 24h）", local.json?.stale_after_ms);
    ok(
      typeof local.json?.generated_at === "string" &&
        local.json?.process?.pid === process.pid &&
        typeof local.json?.process?.build_identity === "object" &&
        typeof local.json?.process?.build_identity_skew?.state === "string",
      "A 带 generated_at / process(pid/buil_identity/skew)",
      local.json?.process,
    );
    ok(
      local.json?.queue?.read?.mode === "worker" && typeof local.json?.queue?.read?.queued === "number" && typeof local.json?.queue?.scan?.mode === "string",
      "A queue 分 read/scan 两池（复用 readWorkerPoolStatus）",
      local.json?.queue,
    );
    ok(
      local.json?.timing != null && "queue_ms" in local.json.timing && "execution_ms" in local.json.timing && "total_ms" in local.json.timing,
      "A timing 分 queue/execution/total（缺项如实 null）",
      local.json?.timing,
    );
    ok(Array.isArray(local.json?.incidents) && Array.isArray(local.json?.unsupported), "A incidents/unsupported 是数组", null);
    ok(
      local.json?.status === "unknown" && local.json?.reasons?.some((r: any) => r.code === "NO_EVIDENCE"),
      "A 描述符在场且 pid 存活但**尚无成功观测** ⇒ unknown + NO_EVIDENCE（冷启动不凭存活猜 healthy，R69-03）",
      { status: local.json?.status, reasons: local.json?.reasons },
    );

    const noTok = await request(A.port, "GET", "/api/work/diagnostics");
    ok(noTok.status === 401, "B tokened 读口无令牌 ⇒ 401（读写口不放行匿名）", noTok.status);
    const badTok = await request(A.port, "GET", "/api/work/diagnostics", { token: "wrong-token" });
    ok(badTok.status === 401, "B tokened 读口错令牌 ⇒ 401", badTok.status);
    const goodTok = await request(A.port, "GET", "/api/work/diagnostics", { token: A.token });
    ok(goodTok.status === 200 && goodTok.json?.ok === true, "B tokened 读口正确令牌 ⇒ 200", goodTok.status);
    // 同源：除 generated_at 外逐字段相等
    const strip = (o: any): any => {
      const c = JSON.parse(JSON.stringify(o));
      delete c.generated_at;
      return c;
    };
    ok(
      JSON.stringify(strip(local.json)) === JSON.stringify(strip(goodTok.json)),
      "A 双读口**同源同判据**（同一 builder；除 generated_at 外逐字段相等）",
      null,
    );

    const badDetail = await request(A.port, "GET", "/api/work/diagnostics?detail=bogus", { token: A.token });
    ok(badDetail.status === 400 && badDetail.json?.code === "INVALID_INPUT", "C detail 非法 ⇒ 400 INVALID_INPUT", badDetail.json);
    const unknownParam = await request(A.port, "GET", "/api/work/diagnostics?foo=1", { token: A.token });
    ok(unknownParam.status === 400 && unknownParam.json?.code === "INVALID_INPUT", "C 未知参数 ⇒ 400（不静默忽略）", unknownParam.json);
    const dupParam = await request(A.port, "GET", "/api/work/diagnostics?detail=summary&detail=full", { token: A.token });
    ok(dupParam.status === 400, "C 重复参数 ⇒ 400", dupParam.status);
    const emptyProj = await request(A.port, "GET", "/api/work/diagnostics?project_id=", { token: A.token });
    ok(emptyProj.status === 400, "C project_id 空串 ⇒ 400", emptyProj.status);
    const unknownProj = await request(A.port, "GET", "/api/work/diagnostics?project_id=does-not-exist", { token: A.token });
    ok(unknownProj.status === 400 && unknownProj.json?.code === "INVALID_INPUT", "C project_id 未注册 ⇒ 400（不返回空成功）", unknownProj.json);
    const goodProj = await request(A.port, "GET", `/api/work/diagnostics?project_id=${PID}&detail=full`, { token: A.token });
    ok(goodProj.status === 200 && goodProj.json?.project_id === PID && goodProj.json?.detail === "full", "C 合法 project_id/detail ⇒ 200 且回显", goodProj.json?.project_id);

    // 远端默认禁止本地维护口
    const remoteDenied = diag.runtimeDiagnosticsRouteResult({ rawUrl: "/api/runtime/diagnostics", remoteLocalOnlyDenied: true, projectExists: () => true, build: () => ({}) });
    ok(remoteDenied.status === 403 && remoteDenied.body?.code === "REMOTE_LOCAL_ONLY", "I 本地维护口对远程来源 403 REMOTE_LOCAL_ONLY", remoteDenied.body);

    // ════════ A2：读池遥测真跑（worker_threads 真作业 → 遥测/报告如实反映）════════
    console.log("\n[verify] ═══ A2 readWorkerPool 有界内存遥测（真跑一个只读作业）═══");
    try {
      const before = poolMod.runtimeTelemetry();
      await poolMod.runReadJob("sync_status", { projectId: PID, dataDir: HOME, discoveryIssues: [] });
      const after = poolMod.runtimeTelemetry();
      ok(after.last_success_at !== null && after.last_success_at >= (before.last_success_at ?? 0), "A2 真跑一次只读作业后遥测记下 last_success（成功只更新新鲜度）", { last: after.last_success_at });
      ok(after.samples >= before.samples && after.total_ms != null, "A2 遥测记录时延样本（queue/execution/total）", { samples: after.samples, total: after.total_ms });
      const r2 = await request(A.port, "GET", "/api/runtime/diagnostics");
      ok(r2.json?.last_success != null && r2.json?.age_state === "fresh" && r2.json?.status === "healthy", "A2 报告 last_success/age_state=fresh/status=healthy 由真实遥测派生（有成功观测才 healthy）", { last: r2.json?.last_success, age: r2.json?.age_state, s: r2.json?.status });
      ok(r2.json?.timing?.samples >= 1 && r2.json?.timing?.total_ms?.count >= 1, "A2 报告 timing 分 queue/execution/total 且已测到", r2.json?.timing);
    } catch (e) {
      ok(false, "A2 真跑 worker 只读作业失败（遥测无法用 mock 代办）", e instanceof Error ? e.message : String(e));
    }

    // ════════ D：四态判据 + 超时/503 按 reason + 新鲜度 ════════
    console.log("\n[verify] ═══ D 四态判据 / 超时与 503 按 reason / 新鲜度 ═══");
    const now = Date.now();
    const validProbe = { present: true, state: "valid", pid_alive: true, is_self: true, reason: null };
    const idlePools = poolsWith({ mode: "worker", queued: 0, queue_limit: 64, busy: 0 });
    const build = (o: any): any =>
      diag.buildRuntimeDiagnosticsReport({ dataDir: HOME, projectId: null, detail: "summary", service: validProbe, pools: idlePools, now, ...o });

    const healthy = build({ telemetry: snapTelemetry({ last_success_at: now - 1000 }) });
    ok(healthy.status === "healthy" && healthy.age_state === "fresh", "D healthy：全部已测维度 ok 且成功观测新鲜（age_state=fresh）", { s: healthy.status, a: healthy.age_state });

    const timedOut = build({ telemetry: snapTelemetry({ last_success_at: now - 2000, last_anomaly: { at: now - 1000, outcome: "timed_out", code: "READ_TIMED_OUT" } }) });
    ok(timedOut.status === "degraded", "D 超时且有 last_success ⇒ degraded（**不得** unavailable）", { s: timedOut.status, r: timedOut.reasons });

    const neverSuccess = build({ telemetry: snapTelemetry({ last_success_at: null, last_anomaly: { at: now - 1000, outcome: "timed_out", code: "READ_TIMED_OUT" } }) });
    ok(neverSuccess.status === "unknown", "D 超时且从未成功 ⇒ unknown（不猜死机）", { s: neverSuccess.status, r: neverSuccess.reasons });

    const saturated = diag.buildRuntimeDiagnosticsReport({
      dataDir: HOME,
      projectId: null,
      detail: "summary",
      service: validProbe,
      pools: poolsWith({ mode: "worker", queued: 64, queue_limit: 64, busy: 1 }),
      telemetry: snapTelemetry({ last_success_at: now - 1000, last_rejection_at: now - 500 }),
      now,
    });
    ok(saturated.status === "degraded" && saturated.reasons.some((r: any) => r.code === "QUEUE_SATURATED"), "D 饱和（队列满）⇒ degraded + QUEUE_SATURATED（**不得** unavailable）", { s: saturated.status, r: saturated.reasons });

    const missing = diag.buildRuntimeDiagnosticsReport({
      dataDir: HOME,
      projectId: null,
      detail: "summary",
      service: { present: false, state: "missing", pid_alive: false, is_self: false, reason: null },
      pools: idlePools,
      telemetry: snapTelemetry(),
      now,
    });
    ok(missing.status === "unavailable" && missing.reasons.some((r: any) => r.code === "SOURCE_UNAVAILABLE"), "D 描述符缺失（明确不可达）⇒ unavailable", { s: missing.status });

    const dead = diag.buildRuntimeDiagnosticsReport({
      dataDir: HOME,
      projectId: null,
      detail: "summary",
      service: { present: true, state: "valid", pid_alive: false, is_self: false, reason: null },
      pools: idlePools,
      telemetry: snapTelemetry(),
      now,
    });
    ok(dead.status === "unavailable" && dead.reasons.some((r: any) => r.code === "PROCESS_EXITED"), "D 进程已退出 ⇒ unavailable PROCESS_EXITED", { s: dead.status });

    const workersDown = diag.buildRuntimeDiagnosticsReport({
      dataDir: HOME,
      projectId: null,
      detail: "summary",
      service: validProbe,
      pools: poolsWith({ mode: "unavailable" }),
      telemetry: snapTelemetry(),
      now,
    });
    ok(workersDown.status === "unavailable" && workersDown.reasons.some((r: any) => r.code === "READ_WORKERS_UNAVAILABLE"), "D 读池 mode=unavailable ⇒ unavailable READ_WORKERS_UNAVAILABLE", { s: workersDown.status });

    // 新鲜度：stale 不单独降级
    const staleHealthy = build({ telemetry: snapTelemetry({ last_success_at: now - 120_000 }) });
    ok(staleHealthy.age_state === "stale" && staleHealthy.status === "healthy", "D 观测过期（>30s）⇒ age_state=stale 但状态维持 healthy（stale 只作提示，不自动判失效）", { a: staleHealthy.age_state, s: staleHealthy.status });
    ok(diag.ageStateOf(null, now, 30000) === "unknown" && diag.ageStateOf(now - 1000, now, 30000) === "fresh" && diag.ageStateOf(now - 40000, now, 30000) === "stale", "D ageStateOf 三态：unknown/fresh/stale", null);

    // 503 分类（classifyRuntimeFailure）
    ok(shared.classifyRuntimeFailure({ httpStatus: 503, reason: "QUEUE_SATURATED", hasLastSuccess: true }).state === "degraded", "D 503 QUEUE_SATURATED ⇒ degraded（不是 unavailable）", null);
    ok(shared.classifyRuntimeFailure({ httpStatus: 503, reason: "SOURCE_UNAVAILABLE", definiteUnreachable: true }).state === "unavailable", "D 503 SOURCE_UNAVAILABLE + 明确不可达 ⇒ unavailable", null);
    ok(shared.classifyRuntimeFailure({ httpStatus: 503, reason: "SOURCE_UNAVAILABLE", timedOut: true, hasLastSuccess: true }).state === "degraded", "D 503 SOURCE_UNAVAILABLE 仅超时且有 last_success ⇒ degraded", null);
    ok(shared.classifyRuntimeFailure({ httpStatus: 503, reason: "SOURCE_UNAVAILABLE", timedOut: true, hasLastSuccess: false }).state === "unknown", "D 503 SOURCE_UNAVAILABLE 仅超时且从未成功 ⇒ unknown", null);

    // ════════ E：故障恢复（当前告警清除、历史保留）════════
    console.log("\n[verify] ═══ E 故障恢复：告警清除、incidents 历史保留 ═══");
    const failedTele = snapTelemetry({
      last_success_at: null,
      last_anomaly: { at: now - 5000, outcome: "failed", code: "READ_FAILED" },
      incidents: [{ at: new Date(now - 5000).toISOString(), outcome: "failed", job_kind: "entry", project_id: null, code: "READ_FAILED", reason: "worker 只读作业失败", queue_ms: 1, execution_ms: 2, total_ms: 3 }],
    });
    const failed = build({ telemetry: failedTele });
    ok(failed.status === "unknown" && failed.incidents.length === 1, "E 从未成功 + 失败 ⇒ unknown 且 incidents 有历史", { s: failed.status, n: failed.incidents.length });
    const recovered = build({ telemetry: { ...failedTele, last_success_at: now - 100 } });
    ok(recovered.status === "healthy", "E 之后成功一次 ⇒ 当前告警清除（healthy）", { s: recovered.status });
    ok(recovered.incidents.length === 1, "E 恢复后 incidents 历史**保留**（只追加、不因恢复而删）", { n: recovered.incidents.length });

    // ════════ E2：真跑读池的失败→恢复（遥测 + HTTP 端到端）════════
    console.log("\n[verify] ═══ E2 真跑：失败入 incidents → 恢复后告警清除、历史保留 ═══");
    poolMod.__resetRuntimeDiagnosticsForTest();
    try {
      await poolMod.runReadJob("entry", { projectId: "no-such-project", dataDir: HOME, input: { project_id: "no-such-project", role: "executor" } });
      ok(false, "E2 预期失败作业应抛错（夹具项目不存在）");
    } catch {
      /* 预期 */
    }
    const afterFail = poolMod.runtimeTelemetry();
    ok(
      afterFail.incidents.some((i: any) => i.outcome === "failed" && i.job_kind === "entry" && i.project_id === "no-such-project"),
      "E2 真失败作业进 incidents（structured code/job_kind/project_id，非 raw URL/路径/正文）",
      afterFail.incidents.at(-1),
    );
    ok(!JSON.stringify(afterFail.incidents).includes(HOME), "E2 incident 不夹带数据目录绝对路径", null);
    ok(afterFail.incidents.at(-1)?.code === "INVALID_COMMAND", "E2 incident.code 保留结构化错误码（不被脱敏误伤）", afterFail.incidents.at(-1)?.code);
    const failReport = (await request(A.port, "GET", "/api/runtime/diagnostics")).json;
    ok(failReport?.status === "unknown" && failReport?.reasons?.some((r: any) => r.code === "READ_FAILED"), "E2 真失败且从未成功 ⇒ HTTP 报告 unknown + READ_FAILED", { s: failReport?.status });
    // 恢复：真跑一次成功作业
    await poolMod.runReadJob("sync_status", { projectId: PID, dataDir: HOME, discoveryIssues: [] });
    const recReport = (await request(A.port, "GET", "/api/runtime/diagnostics")).json;
    ok(recReport?.status === "healthy" && recReport?.age_state === "fresh", "E2 之后真成功一次 ⇒ HTTP 报告 healthy（当前告警清除）", { s: recReport?.status, a: recReport?.age_state });
    ok((recReport?.incidents?.length ?? 0) >= 1, "E2 恢复后 incidents 历史**保留**（HTTP 报告仍带历史）", { n: recReport?.incidents?.length });

    // ════════ F：只读零写入 ════════
    console.log("\n[verify] ═══ F 只读零写入（账本原字节不增长 / 不新增文件）═══");
    const evBefore = sha(EVENTS);
    const filesBefore = listWorkFiles();
    const descBefore = sha(path.join(HOME, "work-service.json"));
    const calls = await Promise.all(
      Array.from({ length: 5 }, () => request(A.port, "GET", "/api/runtime/diagnostics")),
    );
    const calls2 = await Promise.all(
      Array.from({ length: 5 }, () => request(A.port, "GET", "/api/work/diagnostics", { token: A.token })),
    );
    ok(calls.every((r) => r.status === 200) && calls2.every((r) => r.status === 200), "F 10 次诊断读全部 200", null);
    ok(sha(EVENTS) === evBefore, "F 事件账本原字节不增长（只读零写入）", null);
    ok(sha(path.join(HOME, "work-service.json")) === descBefore, "F 描述符不被改写", null);
    ok(JSON.stringify(listWorkFiles()) === JSON.stringify(filesBefore), "F 工作目录不新增任何文件", { before: filesBefore.length, after: listWorkFiles().length });

    // ════════ G：忙时有界（重派生在途仍响应）════════
    console.log("\n[verify] ═══ G 读池忙时诊断仍响应（不进重派生队列）═══");
    // G1：构造"重派生在途（读池饱和）"现场——**真实 builder + 真实派生**：报告照样产出、状态如实降级，
    //     且构造是主线程 O(有界记录)（不等待池、不排队），用时应在毫秒级。
    const busyPools = poolsWith({ mode: "worker", busy: 2, queued: 64, queue_limit: 64, pool_size: 2 });
    const t0 = Date.now();
    const busyReport = diag.buildRuntimeDiagnosticsReport({
      dataDir: HOME,
      projectId: null,
      detail: "summary",
      service: validProbe,
      pools: busyPools,
      telemetry: snapTelemetry({ last_success_at: Date.now() - 1000 }),
      now: Date.now(),
    });
    const buildMs = Date.now() - t0;
    ok(busyReport.status === "degraded" && busyReport.reasons.some((r: any) => r.code === "QUEUE_SATURATED"), "G 读池饱和（重派生在途）时报告照样产出、状态 degraded（不被堵住）", { s: busyReport.status });
    ok(buildMs < 200, `G 报告构造是主线程有界 O(有界记录)（${buildMs}ms，不等待池/不排队）`, { buildMs });
    // G2：真 HTTP 并发——一批诊断读 + 一批健康读同时打，全部 200（诊断不被重计算队列堵住）。
    const conc = await Promise.all([
      ...Array.from({ length: 12 }, () => request(A.port, "GET", "/api/runtime/diagnostics")),
      ...Array.from({ length: 6 }, () => request(A.port, "GET", "/api/work/health", { token: A.token })),
    ]);
    ok(conc.every((r) => r.status === 200), "G 并发诊断 + 健康口全部 200（重计算在途不堵诊断）", conc.map((r) => r.status).join(","));

    // ════════ H：脱敏 ════════
    console.log("\n[verify] ═══ H 脱敏：typed allowlist / 恶意路径 token ═══");
    ok(shared.redactRuntimeText("见 C:\\Users\\me\\secret\\x.txt 与 D:/a/b/c.json").includes("<path>"), "H redactRuntimeText 抹 Windows 绝对路径", shared.redactRuntimeText("C:\\Users\\me\\x.txt"));
    ok(!shared.redactRuntimeText("C:\\Users\\me\\x.txt").includes("Users"), "H 路径内容不残留", null);
    ok(shared.redactRuntimeText("token=AbCdEf0123456789AbCdEf0123456789").includes("<redacted>"), "H token 样长串被抹", shared.redactRuntimeText("token=AbCdEf0123456789AbCdEf0123456789"));
    ok(shared.redactRuntimeText("READ_WORKERS_UNAVAILABLE") === "READ_WORKERS_UNAVAILABLE", "H 稳定错误码（纯字母 ≥20）不被误抹", null);
    ok(shared.redactPaths("my-project-20261013-report") === "my-project-20261013-report", "H 带数字的项目标识不被误抹（redactPaths 只去路径）", null);
    const hostile = {
      ok: true,
      schema: "runtime-diagnostics-v1",
      generated_at: new Date(now).toISOString(),
      EVIL: "leak",
      status: "healthy",
      reasons: [{ code: "OK", detail: "路径 C:\\Users\\me\\secret.txt 与 /etc/passwd" }],
      incidents: [],
      process: { pid: 1, build_identity: { embedded: false, reason: "读 C:\\secret\\x 失败" }, build_identity_skew: { state: "unknown", detail: "x" } },
      queue: { read: {}, scan: {} },
      timing: {},
      unsupported: [],
    };
    const clean = shared.sanitizeRuntimeDiagnosticsReport(hostile);
    ok(clean !== null && !("EVIL" in clean), "H sanitize 丢弃未知字段（typed allowlist）", clean && Object.keys(clean));
    ok(!JSON.stringify(clean).includes("Users") && JSON.stringify(clean).includes("<path>"), "H sanitize 抹掉 reason 里的绝对路径", clean?.reasons);
    ok(!JSON.stringify(clean).includes("secret"), "H sanitize 结果无路径残留", null);
    const builtJson = JSON.stringify(local.json);
    ok(!builtJson.includes(A.token) && !builtJson.includes(HOME), "H 报告**不含**写服务 token / 数据目录绝对路径", null);
    const exp = shared.buildRuntimeDiagnosticsExport(local.json, null, { now: new Date(now).toISOString() });
    ok(exp.schema === "runtime-diagnostics-report" && exp.redaction.redacted_fields.length > 0 && typeof exp.redaction.note === "string", "H 导出体附 redaction.note / redacted_fields（只读）", { n: exp.redaction.redacted_fields.length });
  } finally {
    await A.close();
  }

  // ════════ D2：不可达宿主（HOME2 未发布描述符）真 HTTP ════════
  console.log("\n[verify] ═══ D2 未发布描述符的宿主：真 HTTP 报 unavailable ═══");
  poolMod.__resetRuntimeDiagnosticsForTest();
  const B = await startHost2(HOME2);
  try {
    const r = await request(B.port, "GET", "/api/runtime/diagnostics");
    ok(r.status === 200 && r.json?.status === "unavailable", "D2 描述符缺失 ⇒ 报告 status=unavailable（200 体，非网络错误）", { s: r.json?.status, r: r.json?.reasons });
    ok(r.json?.reasons?.some((x: any) => x.code === "SOURCE_UNAVAILABLE"), "D2 reasons 点名 SOURCE_UNAVAILABLE", r.json?.reasons);
  } finally {
    await B.close();
  }

  console.log(`\n[verify] 小结：${pass} 条 PASS，${fails.length} 条 FAIL`);
  if (fails.length > 0) {
    console.error(`[verify] 失败：\n- ${fails.join("\n- ")}`);
    process.exitCode = 1;
  }
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

/** HOME2：未发布描述符的宿主（模拟"写服务未起/已退出"） */
async function startHost2(dataDir: string): Promise<{ port: number; close: () => Promise<void> }> {
  const host = workHostMod.createWorkHost(dataDir, {});
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/api/runtime/diagnostics") {
      const outcome = diag.runtimeDiagnosticsRouteResult({
        rawUrl: req.url ?? "/",
        remoteLocalOnlyDenied: false,
        projectExists: () => false,
        build: (q: any) => host.service.runtimeDiagnostics({ projectId: q.projectId, detail: q.detail }),
      });
      res.statusCode = outcome.status;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify(outcome.body));
      return;
    }
    void host.handle(req, res, url.pathname).then((handled: boolean) => {
      if (!handled) {
        res.statusCode = 404;
        res.end();
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address() as { port: number; address: string };
  // **不 publish**（模拟写服务未起/已退出）
  return { port: addr.port, close: async () => new Promise<void>((r) => server.close(() => r())) };
}

main().catch((e) => {
  console.error("[verify] 运行失败：", e);
  process.exit(1);
});
