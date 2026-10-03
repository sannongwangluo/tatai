// V09-31 / V09-37 宿主接入验证（tsx 跑）：唯一宿主**只读入口**一次返回 入口+六图摘要、有界 worker_threads
// 只读派生、健康口不被占住、worker 不写账本、源变不拼旧绿、权限与写口拒伪造，以及 V09-31 复审的入口判据修正。
//
// 隔离口径（AGENTS.md §5）：一律在系统 tmp 下建 `tatai-unified-host-` 前缀的**独立数据目录 + 独立项目**，
// 收尾自清；HTTP 宿主绑 127.0.0.1:0（随机端口，**绝不**抢 8787）；不接真实项目、不写生产数据、不 commit。
//
// 红/绿：本脚本只跑**当前实现**（绿）。红方（改前行为）不另跑一份源码，而是把"复审要求的判据"写成
// **回归守卫**——断言当前实现满足；并用 `read_workers`/计数/字节等**事实探针**证明机制真的换到了 worker。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const loadSrc = async <T>(rel: string): Promise<T> => (await import(pathToFileURL(path.join(REPO_ROOT, rel)).href)) as T;

// ── 结果记账 ──
let pass = 0;
const fails: string[] = [];
let skipped = 0;
const ok = (cond: boolean, label: string, detail?: unknown): void => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (cond) pass += 1;
  else {
    fails.push(label);
    if (detail !== undefined) console.log(`[verify]   现场：${JSON.stringify(detail).slice(0, 1200)}`);
  }
};
const info = (m: string): void => console.log(`[verify]   ${m}`);
const skip = (label: string, why: string): void => {
  skipped += 1;
  console.log(`[verify] SKIP ${label}｜${why}｜不计为 PASS`);
};

// ── 隔离夹具 ──
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-unified-host-"));
const HOME = path.join(tmpRoot, "home"); // 隔离全局数据目录（注册表/描述符/日志）
const PROJ = path.join(tmpRoot, "proj"); // 隔离被纳管项目
fs.mkdirSync(path.join(PROJ, ".工作台", "work"), { recursive: true });
fs.mkdirSync(HOME, { recursive: true });
// 关键：先钉住数据目录与"别自愈拉起写者"，再加载任何读 env 的模块。
process.env.TATAI_HOME = HOME;
process.env.TATAI_NO_AUTOSTART = "1";

const registry = await loadSrc<any>("src/server/registry.ts");
const workHostMod = await loadSrc<any>("src/server/workHost.ts");
const readJobs = await loadSrc<any>("src/server/work/readJobs.ts");
const poolMod = await loadSrc<any>("src/server/work/readWorkerPool.ts");
const serviceMod = await loadSrc<any>("src/server/work/service.ts");
const preconditionsMod = await loadSrc<any>("src/server/work/preconditions.ts");
const storeMod = await loadSrc<any>("src/server/work/eventStore.ts");
const wsMod = await loadSrc<any>("src/server/workstation.ts");
const typesMod = await loadSrc<any>("src/server/work/types.ts");
const projectEntryToolMod = await loadSrc<any>("src/mcp/tools/projectEntry.ts");

const PID = "host-fixture";
registry.addProject({ id: PID, name: "宿主夹具", path: PROJ, kind: "backend" }, HOME);
const WORK = wsMod.projectWorkDir(PID, HOME);
const EVENTS = path.join(WORK, "events.jsonl");

const ev = (seq: number, entityId: string, status: string): unknown => ({
  schema_version: typesMod.SCHEMA_VERSION,
  event_id: `ev-${seq}`,
  project_id: PID,
  change_id: "chg-host",
  entity_id: entityId,
  entity_revision: 1,
  seq,
  type: "task.status_changed",
  actor_id: "fixture-executor",
  role: "executor",
  occurred_at: "2026-10-03T00:00:00+08:00",
  received_at: "2026-10-03T00:00:00+08:00",
  idempotency_key: `idem-${seq}`,
  payload: { status, note: `fixture-${seq}` },
});
storeMod.appendEventDurable(WORK, ev(1, "task:t1", "executing"));

const sha = (p: string): string => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");

// ── HTTP 小工具 ──
interface Res {
  status: number;
  json: any;
}
const request = (port: number, method: string, p: string, opts: { token?: string; body?: unknown } = {}): Promise<Res> =>
  new Promise((resolve, reject) => {
    const data = opts.body === undefined ? null : Buffer.from(JSON.stringify(opts.body));
    const req = http.request(
      { host: "127.0.0.1", port, method, path: p, headers: { ...(opts.token ? { "x-tatai-work-token": opts.token } : {}), ...(data ? { "content-type": "application/json", "content-length": data.length } : {}) } },
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

async function main(): Promise<void> {
  info(`隔离数据目录 ${HOME}｜项目 ${PROJ}｜工作树 ${WORK}`);

  // ════════ A. 开发态（tsx）worker 真跑只读作业 ════════
  {
    const view = await poolMod.runReadJob("entry", { projectId: PID, dataDir: HOME, input: { project_id: PID, role: "executor" } });
    ok(view?.ok === true && view.entry != null, "A 宿主只读入口作业（dev/tsx worker）返回 entry");
    ok(view?.graph_summary != null, "A 同一次调用带出 graph_summary（入口+图摘要一次返回）");
    ok(view?.contract?.version === "v09-31" && view?.versions != null && view?.source != null, "A 结果带 version/rules/source 兼容可选字段");
    const sync = await poolMod.runReadJob("sync_status", { projectId: PID, dataDir: HOME });
    ok(typeof sync?.overall === "string" && sync?.project_id === PID, "A 同步状态只读作业返回同一份 report 契约");
    const st = poolMod.readWorkerPoolStatus();
    info(`worker 池：${JSON.stringify(st)}`);
    ok(st.mode === "worker" && st.started > 0 && st.completed >= 2, "A 作业确实经有界 worker_threads 跑（mode=worker 且 started/completed 计数增长）", st);
  }

  // ════════ B. worker 不写账本（真实字节） ════════
  {
    const before = sha(EVENTS);
    const sizeBefore = fs.statSync(EVENTS).size;
    await poolMod.runReadJob("entry", { projectId: PID, dataDir: HOME, input: { project_id: PID, role: "executor" } });
    await poolMod.runReadJob("sync_status", { projectId: PID, dataDir: HOME });
    const after = sha(EVENTS);
    ok(before === after && sizeBefore === fs.statSync(EVENTS).size, "B 只读作业运行期间账本零增长（真实字节 sha256 与大小都不变）", { before, after });
    // 静态证据只看**真实 import 语句**（不看注释里提到的字样）：
    const importLines = (src: string): string[] =>
      src
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => /^import\b/.test(l) || /\bimport\(/.test(l));
    const workerImports = [
      ...importLines(fs.readFileSync(path.join(REPO_ROOT, "src", "server", "work", "readWorker.ts"), "utf8")),
      ...importLines(fs.readFileSync(path.join(REPO_ROOT, "src", "server", "work", "readJobs.ts"), "utf8")),
    ];
    const writeImports = workerImports.filter((l) => /eventStore|appendEvent|WorkService|\/lineStream|work\/service|\.\/service\b|syncDiscovery/.test(l));
    ok(writeImports.length === 0, "B worker/readJobs 的 import 语句不接任何写路径（静态证据）", { writeImports });
  }

  // ════════ C. 宿主只读 HTTP 端点（真起 HTTP，127.0.0.1:0） ════════
  const host = workHostMod.createWorkHost(HOME, {});
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    void host.handle(req, res, url.pathname).catch((e: unknown) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address() as { port: number; address: string };
  host.publish(addr.port, "127.0.0.1");
  const port = addr.port;
  try {
    const q = `project_id=${PID}&role=executor`;
    const entry = await request(port, "GET", `/api/work/entry?${q}`, { token: host.token });
    ok(entry.status === 200 && entry.json?.ok === true && entry.json?.entry != null && entry.json?.graph_summary != null, "C GET /api/work/entry 200 一次返回入口+图摘要", entry.json);
    ok(entry.json?.source?.events_snapshot === "shared", "C 宿主入口用同一份现读快照贯通入口/图/同步（source.events_snapshot=shared）", entry.json?.source);
    const noToken = await request(port, "GET", `/api/work/entry?${q}`, {});
    ok(noToken.status === 401, "C 无令牌取宿主入口被拒（401：读口不放行匿名）", noToken.status);
    const badMethod = await request(port, "POST", `/api/work/entry?${q}`, { token: host.token, body: {} });
    ok(badMethod.status === 405, "C POST /api/work/entry 不命中（405：入口只读 GET，不吞写方法）", badMethod.status);
    const syncRes = await request(port, "GET", `/api/work/sync/status?${q}`, { token: host.token });
    ok(syncRes.status === 200 && syncRes.json?.ok === true && syncRes.json?.sync != null, "C GET /api/work/sync/status 仍返回同一份 report 契约（走 worker）", syncRes.status);
    const health = await request(port, "GET", "/api/work/health", { token: host.token });
    ok(health.status === 200 && health.json?.read_workers?.mode === "worker", "C 健康口如实报 worker 池状态", health.json?.read_workers);

    // C2：健康口在并发重读下仍响应（冒烟；**不是** SLO）
    const jobs = Array.from({ length: 8 }, () => request(port, "GET", `/api/work/entry?${q}`, { token: host.token }));
    const t0 = Date.now();
    const h2 = await request(port, "GET", "/api/work/health", { token: host.token });
    const hMs = Date.now() - t0;
    const results = await Promise.all(jobs);
    ok(results.every((r) => r.status === 200), "C 8 个并发入口读全部 200（并发只读不互相失败）");
    ok(h2.status === 200 && hMs < 1500, `C 并发重读期间健康口仍快速响应（${hMs}ms；冒烟口径，非生产 SLO）`, { hMs });
  } finally {
    // keep server for the MCP section below? no — restart not needed; we close at the end
  }

  // ════════ D. MCP project_entry：有宿主走宿主入口，无宿主回退本地（fail-closed） ════════
  {
    const args = { project_id: PID, role: "executor" };
    const viaHost = await projectEntryToolMod.projectEntryTool.handler(args, undefined);
    const hostText = viaHost.content?.[0]?.text ?? "";
    const hostOut = JSON.parse(hostText);
    ok(hostOut.next_action != null && hostOut.graph_summary != null, "D 有宿主：MCP 入口返回入口字段+graph_summary");
    ok(hostOut.source?.events_snapshot === "shared" && hostOut.versions != null, "D 有宿主：走了宿主只读入口（带 source/versions 兼容字段）", hostOut.source);
    // V09-31/37 复审 C：入口的版本元数据带**真实账本内容身份**，且带"设计/施工/图输入前后复核"结论。
    ok(
      hostOut.versions?.ledger != null && typeof hostOut.versions.ledger.content_sha256 === "string" && hostOut.versions.ledger.content_sha256.length === 64 && hostOut.versions.ledger.events >= 1,
      "D 有宿主：versions.ledger 带真实账本内容身份（sha256 + 事件数，不是 seq/mtime）",
      hostOut.versions?.ledger,
    );
    ok(hostOut.source?.sources_stable === true && Array.isArray(hostOut.source?.sources_stale_reasons), "D 有宿主：source.sources_stable 前后复核通过（无 stale 原因）", { stable: hostOut.source?.sources_stable, reasons: hostOut.source?.sources_stale_reasons });

    // 撤掉描述符 → 宿主不可达 → 回退本地路径（仍返回完整入口，不假装健康）
    const descPath = path.join(HOME, "work-service.json");
    const saved = fs.existsSync(descPath) ? fs.readFileSync(descPath) : null;
    fs.rmSync(descPath, { force: true });
    const viaLocal = await projectEntryToolMod.projectEntryTool.handler(args, undefined);
    const localOut = JSON.parse(viaLocal.content?.[0]?.text ?? "{}");
    ok(localOut.next_action != null && localOut.graph_summary != null, "D 无宿主：仍返回完整入口+graph_summary（回退本地路径，不假装健康）");
    ok(localOut.source === undefined, "D 无宿主：结果是本地路径（无宿主 source 字段，与宿主路径可区分）", { source: localOut.source });
    if (saved !== null) fs.writeFileSync(descPath, saved);
  }

  // ════════ E. 不跨请求缓存旧绿：追加事件后下一次调用立刻可见 ════════
  {
    const v1 = readJobs.computeEntryView({ projectId: PID, dataDir: HOME, input: { project_id: PID, role: "executor" } });
    storeMod.appendEventDurable(WORK, ev(2, "task:t2", "blocked"));
    const v2 = readJobs.computeEntryView({ projectId: PID, dataDir: HOME, input: { project_id: PID, role: "executor" } });
    const ids1 = v1.entry?.current_change?.task_ids ?? [];
    const ids2 = v2.entry?.current_change?.task_ids ?? [];
    ok(!ids1.includes("t2") && ids2.includes("t2"), "E 追加的新事件在下一次调用立刻可见（不沿用上次快照）", { before: ids1, after: ids2 });
  }

  // ════════ F. 同一份快照共享 vs 本地三次重派生：读盘计数对照 ════════
  {
    const origStat = fs.statSync.bind(fs);
    let target = path.resolve(EVENTS).toLowerCase();
    let count = 0;
    (fs as any).statSync = (p: any, ...rest: any[]) => {
      if (path.resolve(String(p)).toLowerCase() === target) count += 1;
      return (origStat as any)(p, ...rest);
    };
    try {
      count = 0;
      readJobs.computeEntryView({ projectId: PID, dataDir: HOME, input: { project_id: PID, role: "executor" } });
      const sharedCount = count;
      const entryMod = await loadSrc<any>("src/server/work/entry.ts");
      const sixMod = await loadSrc<any>("src/arch/sixGraphs.ts");
      count = 0;
      entryMod.evaluateProjectEntry({ project_id: PID, role: "executor" }, { dataDir: HOME });
      sixMod.graphSummaryOf(PID, { dataDir: HOME });
      const fallbackCount = count;
      info(`账本 statSync 计数：宿主入口（同一快照）${sharedCount} 次 ／ 本地重派生（入口+图各一）${fallbackCount} 次`);
      ok(sharedCount <= fallbackCount, "F 同一快照共享的读盘次数 ≤ 本地重派生（减少重复解析）", { sharedCount, fallbackCount });
    } finally {
      (fs as any).statSync = origStat;
    }
  }

  // ════════ G. V09-31 复审：入口判据修正（纯函数回归守卫） ════════
  {
    const baseFacts = (over: Record<string, unknown>): any => ({
      unreadable: null,
      eventsShared: true,
      eventsSnapshotUnreadable: null,
      baseline: null,
      baselineRevalidate: ["尚未激活成套图纸基线（生效决定为空，不能假设按哪一版干活）"],
      baselineValid: false,
      baselineSourceChanged: false,
      design: null,
      plan: null,
      definitions: [],
      states: {},
      align: { needs_rebind: [], orphan_states: [] },
      syncBlock: null,
      syncBlockUnreadable: null,
      stageReads: { status: "absent" },
      executions_unreadable: null,
      ...over,
    });
    const cap = { effective: "continuable", basis: "fixture", declared: [] };
    const inputOf = (facts: any): any => ({ facts, action: "claim_task", role: "executor", roleClass: "executor", capability: cap, runs: [], chosenTaskId: null });
    const statusOf = (facts: any, id: string): string | undefined =>
      preconditionsMod.preconditionsOf(inputOf(facts)).items.find((it: any) => it.id === id)?.status;

    // G1：syncBlock=null 且**读不出来** → unknown，**不是** not_applicable/not_configured
    ok(
      statusOf(baseFacts({ syncBlock: null, syncBlockUnreadable: "boom" }), "sync.gate") === "unknown",
      "G1 同步现场读不出来 → sync.gate=unknown（不再冒充 not_configured）",
      { got: statusOf(baseFacts({ syncBlock: null, syncBlockUnreadable: "boom" }), "sync.gate") },
    );
    // G2：configured 且未阻断但 overall≠passed → attention，不是 satisfied
    ok(
      statusOf(baseFacts({ syncBlock: { configured: true, blocked: false, overall: "failed", batches: [] } }), "sync.gate") === "attention",
      "G2 已配置、未阻断但 overall≠passed → sync.gate=attention（blocked=false 不等于 passed）",
    );
    ok(
      statusOf(baseFacts({ syncBlock: { configured: true, blocked: false, overall: "passed", batches: [] } }), "sync.gate") === "satisfied",
      "G2b 已配置、未阻断且 overall=passed → satisfied",
    );
    // G3：baselineValid=false 且失效理由**不含**那句中文（保全对象篡改类）→ 仍不是 satisfied
    const tampered = baseFacts({
      baseline: { baseline_id: "b1", approved_by: "u", approval_kind: "k", plan_revision: { content_sha256: "x" } },
      baselineRevalidate: ["不可变历史对象已被改动（design）：内容哈希名下的对象不是这一份正文——真·篡改"],
      baselineValid: false,
    });
    ok(statusOf(tampered, "baseline.active") === "attention", "G3 基线有其它失效理由（非「源变过」）也不标 satisfied（结构化判据，不靠中文 substring）", { got: statusOf(tampered, "baseline.active") });
    // G4：执行现场补取入口不给虚构的 report_execution op=read
    const runItem = preconditionsMod.preconditionsOf({
      ...inputOf(baseFacts({ syncBlock: { configured: true, blocked: false, overall: "passed", batches: [] } })),
      runs: [{ task_id: "t1", lease: "active", run_site: { state: "unknown", note: "n" }, resume_preconditions: ["r"] }],
    }).items.find((it: any) => it.id.startsWith("execution.site"));
    ok(typeof runItem?.fetch === "string" && !runItem.fetch.includes('report_execution {op:"read"'), "G4 执行现场补取入口不出现虚构的 report_execution op=read", { fetch: runItem?.fetch });
    // G5：定义解析缺失不再说成「施工图未入账」
    const defItem = preconditionsMod.preconditionsOf(
      inputOf(baseFacts({ plan: { source: { rel_path: ".工作台/plan.md" }, revision: { content_sha256: "c", definition_sha256: "d" } }, definitions: [] })),
    ).items.find((it: any) => it.id === "definitions.parsed");
    ok(typeof defItem?.detail === "string" && !defItem.detail.includes("施工图未入账"), "G5 定义解析缺失的说明与「账本入账」分开（不再说成施工图未入账）", { detail: defItem?.detail?.slice(0, 120) });
  }

  // ════════ H. 打包态 worker js 路径（有构建产物才跑） ════════
  {
    const built = path.join(REPO_ROOT, "src-tauri", "resources", "server", "read-worker.js");
    if (!fs.existsSync(built)) {
      skip("H 打包态 read-worker.js 路径", `构建产物不在（先跑 pnpm build:server）：${built}`);
    } else {
      const { Worker } = await import("node:worker_threads");
      const w = new Worker(built, { execArgv: [] });
      const ask = (id: number, kind: string, args: unknown): Promise<any> =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`打包态 worker ${kind} 10s 未回`)), 10_000);
          const onMsg = (m: any): void => {
            if (m?.id !== id) return;
            clearTimeout(timer);
            w.off("message", onMsg);
            resolve(m);
          };
          w.on("message", onMsg);
          w.on("error", (e: any) => { clearTimeout(timer); reject(e); });
          w.postMessage({ id, kind, args });
        });
      const reply: any = await ask(7, "sync_status", { projectId: PID, dataDir: HOME });
      // V09-31/37：打包入口同样要认**新增只读作业**（arch_render 与扫描/准备共用同一份 readJobs 分派）。
      const archReply: any = await ask(8, "arch_render", { projectId: PID });
      await w.terminate();
      ok(reply?.ok === true && reply?.result?.project_id === PID, "H 打包态 read-worker.js（纯 node，无 tsx）能跑只读作业并回消息", reply);
      ok(archReply?.ok === true && archReply?.result?.ok === true, "H2 打包态 read-worker.js 认新增 arch_render 作业（新增分派也在包内）", archReply);
    }
  }

  // ════════ I. 排队压力小样本（本地合成，**明确不是 SLO**） ════════
  {
    const samples: number[] = [];
    for (let i = 0; i < 30; i++) {
      const t = Date.now();
      await poolMod.runReadJob("entry", { projectId: PID, dataDir: HOME, input: { project_id: PID, role: "executor" } });
      samples.push(Date.now() - t);
    }
    samples.sort((a, b) => a - b);
    const p = (q: number): number => samples[Math.min(samples.length - 1, Math.floor(q * samples.length))];
    info(`暖样本 30 次宿主入口耗时（本地合成夹具，**非生产 SLO**）：p50=${p(0.5)}ms p95=${p(0.95)}ms max=${samples[samples.length - 1]}ms`);
    ok(samples.length === 30 && samples.every((s) => s >= 0), "I 记录了 30 个暖样本（原始样本见上行；明确不作为 SLO 达标证据）");
  }

  server.close();
  host.unpublish();
  await poolMod.stopReadWorkers();
}

try {
  await main();
} catch (e) {
  fails.push(`脚本异常：${e instanceof Error ? e.message : String(e)}`);
  console.error(e);
} finally {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* 清理尽力而为 */
  }
  console.log(`[verify] 结果：PASS ${pass} / FAIL ${fails.length} / SKIP ${skipped}`);
  if (fails.length > 0) {
    for (const f of fails) console.log(`[verify]   FAIL: ${f}`);
    process.exitCode = 1;
  } else if (skipped > 0) {
    process.exitCode = 3;
  }
}
