// verify-v09-37-sync-timeout：V09-37 BLOCK-2 同步只读的「一次根因修复」专项回归。
//
// 覆盖（与 BLOCK-2 的最小方案对齐）：
//   A. 默认预算常量 = 10_000ms（同步 + 入口），显式 timeoutMs 仍可覆盖。
//   B. 真实 HTTP 慢 6s 请求在**默认 10s 预算**内成功（量到实际耗时）。
//   C. 真实 HTTP >10s（11.5s）请求在默认预算处**明确超时**：抛结构化 WorkError、**不重复 fallback**（第二个端点零命中）。
//   D. 404 兼容：第一个端点 404、第二个端点 6s → 成功；两次共用同一 10s deadline（总耗时 < 10s）。
//   E/F. 共享 deadline 覆盖「请求 + body + 兼容 endpoint 回退」：显式短预算下，回退端点也被同 deadline 掐断。
//   G. 5xx 结构化错误码不丢（放进 detail.host_code/host_http_status，不重复 fallback）。
//   H. 无效响应（非 JSON）→ 结构化错误，不重复 fallback。
//   I/J. 入口读口对齐 10s：慢 1.5s 成功；慢 2s+ 显式短预算 → 结构化 HOST_READ_TIMEOUT（不是 unreachable）。
//   I2/J2/J3（2026-10-13 收尾）：入口读口 200 非法/不完整 body → 明确 HOST_READ_INVALID（**不**退化成
//      unreachable 让调用链本地重算）；非 2xx 与 200 的 **body 读取**被 deadline 掐断 → 统一 HOST_READ_TIMEOUT。
//      与此前入口 404 既有语义无关，不改。
//   K/L. hostSyncView：宿主超时抛结构化错误、**不本地重算**；宿主不可达仍保留既有 fail-closed 本地兼容。
//   M/N/O. HTTP 路由：正常 close 无错误 incidents；**提前断开**取消**本请求**的只读作业（worker 释放、不完成），
//          且不影响并行另一请求；旧 `/api/projects/:id/sync-status` 同样贯通取消。
//   P. T37-01（真实 HTTP 反例）：旧 project 读口**嵌套**错误信封 {ok:false,error:{code,message,detail}} 保留原始
//      结构化码（HEALTH_UNSTABLE 不再丢成 HTTP_503）与嵌套 detail（issues），且只回退一次。
//   Q. T37-01：非 2xx 响应 **body 读取**被 deadline 掐断 → 统一 HOST_READ_TIMEOUT 分类（不退化成 HTTP 错误码）。
//
// 隔离（AGENTS.md §5）：mkdtemp 隔离 TATAI_HOME + 假宿主/真实宿主 HTTP 绑 127.0.0.1:0（随机端口，**绝不**抢 8787）；
// 夹具 worker 写标记到隔离 tmp；跑完 terminate worker、关服务器、删夹具。不碰真实 ~/.tatai / 真实项目 / 真实账本。
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
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-v0937-to-"));
process.env.TATAI_HOME = path.join(tmpRoot, "home");
process.env.TATAI_NO_AUTOSTART = "1";
process.env.TATAI_READ_WORKER_POOL = "2";

const serviceMod = await loadSrc<any>("src/server/work/service.ts");
const syncHostMod = await loadSrc<any>("src/mcp/tools/syncHost.ts");
const registryMod = await loadSrc<any>("src/server/registry.ts");
const typesMod = await loadSrc<any>("src/server/work/types.ts");
const syncHttpMod = await loadSrc<any>("src/server/work/syncHttp.ts");
const poolMod = await loadSrc<any>("src/server/work/readWorkerPool.ts");

const HDR = serviceMod.WORK_TOKEN_HEADER as string;
const SCHEMA = typesMod.SCHEMA_VERSION as number;

// ── 假宿主（客户端读口用）：按端点返回可配置的延迟/状态/体 ──
interface Behavior {
  status?: number;
  delayMs?: number;
  /** headers 先发、body 延后这么久再写（验证"非 2xx 响应 body 读取被 deadline 掐断"的分类） */
  bodyDelayMs?: number;
  body?: unknown;
  raw?: string;
}
let workB: Behavior = {};
let projB: Behavior = {};
let entryB: Behavior = {};
let workHits = 0;
let projHits = 0;
let entryHits = 0;
const resetHits = (): void => {
  workHits = 0;
  projHits = 0;
  entryHits = 0;
};
const resetBehaviors = (): void => {
  workB = {};
  projB = {};
  entryB = {};
};

const fakeHost = http.createServer(async (req, res) => {
  const p = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
  let b: Behavior;
  if (p === "/api/work/sync/status") {
    workHits += 1;
    b = workB;
  } else if (p === "/api/work/entry") {
    entryHits += 1;
    b = entryB;
  } else if (/^\/api\/projects\/[^/]+\/sync-status$/.test(p)) {
    projHits += 1;
    b = projB;
  } else {
    res.writeHead(404, { "content-type": "application/json" });
    res.end("{}");
    return;
  }
  if (b.delayMs !== undefined && b.delayMs > 0) await sleep(b.delayMs);
  const status = b.status ?? 200;
  const text = b.raw !== undefined ? b.raw : JSON.stringify(b.body ?? {});
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  // headers 先发、body 延后：用于验证非 2xx 响应"body 读取被 deadline 掐断"→ 统一 HOST_READ_TIMEOUT。
  if (b.bodyDelayMs !== undefined && b.bodyDelayMs > 0) {
    res.flushHeaders();
    await sleep(b.bodyDelayMs);
  }
  res.end(text);
});
await new Promise<void>((r) => fakeHost.listen(0, "127.0.0.1", r));
const fakePort = (fakeHost.address() as { port: number }).port;

const clientHome = path.join(tmpRoot, "clientHome");
fs.mkdirSync(clientHome, { recursive: true });
serviceMod.writeServiceDescriptor(clientHome, {
  schema_version: SCHEMA,
  pid: process.pid,
  host: "127.0.0.1",
  port: fakePort,
  token: "fake-token",
  started_at: new Date().toISOString(),
  url: `http://127.0.0.1:${fakePort}`,
});

const SYNC_OK = { ok: true, sync: { configured: false, overall: "not_configured" }, discovery_issues: [] };
const ENTRY_OK = { ok: true, entry: { project: "x", next_action: "complete" } };

const workError = (e: unknown): any => e; // 便于断言字段

const c = (m: string): void => console.log(`[verify] ── ${m}`);
c("A 默认预算常量");
ok(serviceMod.SYNC_READ_TIMEOUT_MS === 10_000, "A1 SYNC_READ_TIMEOUT_MS=10000", { got: serviceMod.SYNC_READ_TIMEOUT_MS });
ok(serviceMod.ENTRY_READ_TIMEOUT_MS === 10_000, "A2 ENTRY_READ_TIMEOUT_MS=10000", { got: serviceMod.ENTRY_READ_TIMEOUT_MS });
{
  const cli = new serviceMod.WorkServiceClient({ dataDir: clientHome });
  const src = fs.readFileSync(path.join(REPO_ROOT, "src/server/work/service.ts"), "utf8");
  ok(/syncTimeoutMs\s*\?\?\s*opts\.timeoutMs\s*\?\?\s*SYNC_READ_TIMEOUT_MS/.test(src), "A3 同步预算＝syncTimeoutMs ?? 显式 timeoutMs ?? 10s（显式 timeoutMs 仍可覆盖）");
  void cli;
}

c("B 默认 10s 预算：真实 HTTP 慢 6s 成功");
{
  resetHits();
  resetBehaviors();
  workB = { status: 200, delayMs: 6000, body: SYNC_OK };
  const cli = new serviceMod.WorkServiceClient({ dataDir: clientHome });
  const t0 = Date.now();
  const r = await cli.readSyncStatusRemote("P");
  const ms = Date.now() - t0;
  ok(r !== null && r.report?.overall === "not_configured", "B1 慢 6s 请求在默认预算内成功返回", { got: r === null ? null : r.report?.overall, ms });
  ok(ms >= 5500 && ms < 10_000, "B2 实际耗时落在 6s 量级且 < 10s 预算", { ms });
  ok(workHits === 1 && projHits === 0, "B3 只打第一个端点（成功不 fallback）", { workHits, projHits });
}

c("C 默认 10s 预算：真实 HTTP >10s（11.5s）明确超时、不重复 fallback");
{
  resetHits();
  resetBehaviors();
  workB = { status: 200, delayMs: 11_500, body: SYNC_OK };
  const cli = new serviceMod.WorkServiceClient({ dataDir: clientHome });
  const t0 = Date.now();
  let threw: unknown = null;
  try {
    await cli.readSyncStatusRemote("P");
  } catch (e) {
    threw = e;
  }
  const ms = Date.now() - t0;
  ok(threw !== null && typesMod.isWorkError(threw), "C1 >10s 明确抛结构化 WorkError", { threw: String(threw) });
  ok(threw !== null && (workError(threw).message as string).includes("预算"), "C2 错误信息说明超预算（不本地重算）", { message: workError(threw)?.message });
  ok(ms >= 9_000 && ms < 11_500, "C3 在默认 10s 预算处掐断（未等满 11.5s）", { ms });
  ok(workHits === 1 && projHits === 0, "C4 超时不重复派生到兼容 endpoint", { workHits, projHits });
}

c("D 404 兼容：first=404 → 第二个端点 6s 成功；两次共用同一 10s deadline");
{
  resetHits();
  resetBehaviors();
  workB = { status: 404, delayMs: 0, body: { code: "NOT_FOUND" } };
  projB = { status: 200, delayMs: 6000, body: SYNC_OK };
  const cli = new serviceMod.WorkServiceClient({ dataDir: clientHome });
  const t0 = Date.now();
  const r = await cli.readSyncStatusRemote("P");
  const ms = Date.now() - t0;
  ok(r !== null && r.report?.overall === "not_configured", "D1 404 后回退旧 endpoint 成功", { got: r === null ? null : r.report?.overall });
  ok(workHits === 1 && projHits === 1, "D2 两端点各命中一次", { workHits, projHits });
  ok(ms >= 5500 && ms < 10_000, "D3 总耗时 < 10s（两次共用同一 deadline）", { ms });
}

c("E/F 共享 deadline：显式短预算同时掐断回退端点");
{
  resetHits();
  resetBehaviors();
  workB = { status: 200, delayMs: 5000, body: SYNC_OK };
  const cli = new serviceMod.WorkServiceClient({ dataDir: clientHome });
  const t0 = Date.now();
  let threw: unknown = null;
  try {
    await cli.readSyncStatusRemote("P", { timeoutMs: 1500 });
  } catch (e) {
    threw = e;
  }
  const ms = Date.now() - t0;
  ok(threw !== null && typesMod.isWorkError(threw), "E1 显式 timeoutMs 覆盖默认预算", { ms });
  ok(ms >= 1200 && ms < 3000, "E2 在显式 1.5s 预算掐断", { ms });
  ok(workHits === 1 && projHits === 0, "E3 超时不 fallback", { workHits, projHits });

  resetHits();
  resetBehaviors();
  workB = { status: 404, delayMs: 0, body: { code: "NOT_FOUND" } };
  projB = { status: 200, delayMs: 5000, body: SYNC_OK };
  const t1 = Date.now();
  let threw2: unknown = null;
  try {
    await cli.readSyncStatusRemote("P", { timeoutMs: 1500 });
  } catch (e) {
    threw2 = e;
  }
  const ms2 = Date.now() - t1;
  ok(threw2 !== null && typesMod.isWorkError(threw2), "F1 回退端点也被同一 deadline 掐断", { ms2 });
  ok(ms2 >= 1200 && ms2 < 3000, "F2 总耗时仍受同一 1.5s 预算约束", { ms2 });
  ok(projHits === 1, "F3 回退端点在调用中（deadline 覆盖它）", { projHits });
}

c("G 5xx：结构化错误码不丢、不重复 fallback");
{
  resetHits();
  resetBehaviors();
  workB = { status: 503, delayMs: 0, body: { code: "HEALTH_UNSTABLE", message: "宿主健康抖动", detail: { issues: ["x"] } } };
  const cli = new serviceMod.WorkServiceClient({ dataDir: clientHome });
  let threw: any = null;
  try {
    await cli.readSyncStatusRemote("P", { timeoutMs: 1500 });
  } catch (e) {
    threw = e;
  }
  ok(threw !== null && typesMod.isWorkError(threw), "G1 5xx 抛结构化 WorkError", { threw: String(threw) });
  ok(threw?.detail?.host_code === "HEALTH_UNSTABLE", "G2 宿主错误码保留在 detail.host_code", { detail: threw?.detail });
  ok(workHits === 1 && projHits === 0, "G3 5xx 不重复 fallback", { workHits, projHits });
}

c("P T37-01：旧路由嵌套错误信封 {ok:false,error:{code,message,detail}} 保留原始结构化码与明细");
{
  resetHits();
  resetBehaviors();
  // 真实 HTTP 反例：首路由 404（唯一回退信号）→ 旧 project 读口 503 返回**嵌套** error 信封。
  // 修复前：只按顶层解析 ⇒ 码丢成 HTTP_503、issues 丢失；修复后：保留 HEALTH_UNSTABLE 与 detail.issues。
  workB = { status: 404, delayMs: 0, body: { code: "NOT_FOUND" } };
  projB = {
    status: 503,
    delayMs: 0,
    body: { ok: false, error: { code: "HEALTH_UNSTABLE", message: "宿主健康抖动", detail: { issues: ["f-1"] } } },
  };
  const cli = new serviceMod.WorkServiceClient({ dataDir: clientHome });
  let threw: any = null;
  try {
    await cli.readSyncStatusRemote("P", { timeoutMs: 1500 });
  } catch (e) {
    threw = e;
  }
  ok(threw !== null && typesMod.isWorkError(threw), "P1 旧路由嵌套错误 → 抛结构化 WorkError", { threw: String(threw) });
  ok(threw?.detail?.host_code === "HEALTH_UNSTABLE", "P2 原始码 HEALTH_UNSTABLE 保留（不再丢成 HTTP_503）", { detail: threw?.detail });
  ok(Array.isArray(threw?.detail?.issues) && threw.detail.issues[0] === "f-1", "P3 嵌套 detail（issues）一并保留", { detail: threw?.detail });
  ok(workHits === 1 && projHits === 1, "P4 仅回退一次（不重复派生）", { workHits, projHits });
}

c("Q T37-01：非 2xx 响应 body 读取被 deadline 掐断 → 统一 HOST_READ_TIMEOUT 分类");
{
  resetHits();
  resetBehaviors();
  // headers 先回、body 3s 后才写；1.2s 预算内读 body 被 abort ⇒ 应报 HOST_READ_TIMEOUT，而不是 HTTP_503。
  workB = { status: 503, delayMs: 0, bodyDelayMs: 3000, body: { code: "SOMETHING" } };
  const cli = new serviceMod.WorkServiceClient({ dataDir: clientHome });
  const t0 = Date.now();
  let threw: any = null;
  try {
    await cli.readSyncStatusRemote("P", { timeoutMs: 1200 });
  } catch (e) {
    threw = e;
  }
  const ms = Date.now() - t0;
  ok(threw !== null && typesMod.isWorkError(threw), "Q1 非 2xx body 读取超预算 → 抛结构化 WorkError", { threw: String(threw) });
  ok(threw?.detail?.host_code === "HOST_READ_TIMEOUT", "Q2 统一分类为 HOST_READ_TIMEOUT（不是 HTTP_503）", { detail: threw?.detail });
  ok(ms >= 900 && ms < 3000, "Q3 在 1.2s 预算处掐断（未等满 body 3s）", { ms });
  ok(workHits === 1 && projHits === 0, "Q4 body 超时不重复 fallback", { workHits, projHits });
}

c("H 无效响应（非 JSON）→ 结构化错误，不重复 fallback");
{
  resetHits();
  resetBehaviors();
  workB = { status: 200, delayMs: 0, raw: "this is not json" };
  const cli = new serviceMod.WorkServiceClient({ dataDir: clientHome });
  let threw: any = null;
  try {
    await cli.readSyncStatusRemote("P", { timeoutMs: 1500 });
  } catch (e) {
    threw = e;
  }
  ok(threw !== null && typesMod.isWorkError(threw), "H1 无效响应抛结构化错误", { threw: String(threw) });
  ok(workHits === 1 && projHits === 0, "H2 无效响应不重复 fallback", { workHits, projHits });
}

c("I/J 入口读口：慢 1.5s 成功、超预算结构化 HOST_READ_TIMEOUT");
{
  resetHits();
  resetBehaviors();
  entryB = { status: 200, delayMs: 1500, body: ENTRY_OK };
  const r = await serviceMod.fetchHostEntryResult(clientHome, { project_id: "P", role: "executor" }, { timeoutMs: 3000 });
  ok(r.kind === "ok" && r.view?.ok === true, "I1 入口慢 1.5s 在预算内成功", { kind: r.kind });

  resetHits();
  resetBehaviors();
  entryB = { status: 200, delayMs: 5000, body: ENTRY_OK };
  const r2 = await serviceMod.fetchHostEntryResult(clientHome, { project_id: "P", role: "executor" }, { timeoutMs: 1200 });
  ok(r2.kind === "error" && r2.code === "HOST_READ_TIMEOUT", "J1 入口超预算 → 结构化 error（不是 unreachable）", { kind: r2.kind, code: r2.code });
}

c("I2/J2/J3 入口读口：200 非法/不完整 body → HOST_READ_INVALID；body 读取超预算 → HOST_READ_TIMEOUT（均不回退本地重算）");
{
  // 200 但**非 JSON**：明确读失败（修复前退化成 unreachable ⇒ 调用链本地重算）
  resetHits();
  resetBehaviors();
  entryB = { status: 200, delayMs: 0, raw: "this is not json" };
  const r = await serviceMod.fetchHostEntryResult(clientHome, { project_id: "P", role: "executor" }, { timeoutMs: 1500 });
  ok(r.kind === "error" && r.code === "HOST_READ_INVALID", "I2 入口 200 非 JSON → HOST_READ_INVALID（不是 unreachable）", { kind: r.kind, code: r.code });
  ok(entryHits === 1, "I2b 非法响应不重复派生（不回退）", { entryHits });

  // 200 但 body **不完整**（缺 entry）：同口径明确读失败
  resetHits();
  resetBehaviors();
  entryB = { status: 200, delayMs: 0, body: { ok: true } };
  const r2 = await serviceMod.fetchHostEntryResult(clientHome, { project_id: "P", role: "executor" }, { timeoutMs: 1500 });
  ok(r2.kind === "error" && r2.code === "HOST_READ_INVALID", "I2c 入口 200 不完整 body（缺 entry）→ HOST_READ_INVALID", { kind: r2.kind, code: r2.code });

  // hostEntryView：明确错误非空、host_reachable=true（调用方**不**回退本地路径重算）
  const view = await syncHostMod.hostEntryView("P", clientHome, { role: "executor" });
  ok(
    view.view === null && view.host_reachable === true && view.error?.code === "HOST_READ_INVALID",
    "I2d hostEntryView 把「200 非法/不完整」当**明确错误**（不是「不可达」静默回退本地）",
    { reachable: view.host_reachable, err: view.error?.code },
  );

  // 非 2xx 的 **body 读取**被 deadline 掐断 → 统一 HOST_READ_TIMEOUT（不退化成 HTTP_503）
  resetHits();
  resetBehaviors();
  entryB = { status: 503, delayMs: 0, bodyDelayMs: 3000, body: { code: "SOMETHING" } };
  const t0 = Date.now();
  const r3 = await serviceMod.fetchHostEntryResult(clientHome, { project_id: "P", role: "executor" }, { timeoutMs: 1200 });
  const ms = Date.now() - t0;
  ok(r3.kind === "error" && r3.code === "HOST_READ_TIMEOUT", "J2 非 2xx body 读取超预算 → 统一 HOST_READ_TIMEOUT（不是 HTTP_503）", { kind: r3.kind, code: r3.code });
  ok(ms >= 900 && ms < 3000, "J2b 在 1.2s 预算处掐断（未等满 body 3s）", { ms });

  // 200 的 **body 读取**被 deadline 掐断 → 同一分类（不是 invalid/unreachable）
  resetHits();
  resetBehaviors();
  entryB = { status: 200, delayMs: 0, bodyDelayMs: 3000, body: ENTRY_OK };
  const t1 = Date.now();
  const r4 = await serviceMod.fetchHostEntryResult(clientHome, { project_id: "P", role: "executor" }, { timeoutMs: 1200 });
  const ms2 = Date.now() - t1;
  ok(r4.kind === "error" && r4.code === "HOST_READ_TIMEOUT", "J3 200 body 读取超预算 → 统一 HOST_READ_TIMEOUT", { kind: r4.kind, code: r4.code });
  ok(ms2 >= 900 && ms2 < 3000, "J3b 在 1.2s 预算处掐断", { ms2 });
}

c("K/L hostSyncView：超时抛结构化（不本地重算）；不可达保留 fail-closed 兼容");
{
  const timeoutWork = {
    readSyncStatusRemote: async () => {
      throw new typesMod.WorkError("SERVICE_UNAVAILABLE", "宿主同步只读读口在 10000ms 预算内未返回");
    },
  };
  let threw: unknown = null;
  try {
    await syncHostMod.hostSyncView("P", clientHome, timeoutWork);
  } catch (e) {
    threw = e;
  }
  ok(threw !== null, "K1 宿主超时时 hostSyncView 抛错（不返回本地重算的报告）", { threw: String(threw) });

  // L：宿主不可达（null）→ 既有 fail-closed 本地兼容（需要已注册项目）
  const localProj = path.join(tmpRoot, "proj-L");
  fs.mkdirSync(path.join(localProj, ".工作台", "work"), { recursive: true });
  registryMod.addProject({ id: "P-L", name: "本地兼容夹具", path: localProj, kind: "backend" }, clientHome);
  const nullWork = { readSyncStatusRemote: async () => null };
  const view = await syncHostMod.hostSyncView("P-L", clientHome, nullWork);
  ok(view.host_reachable === false && view.report !== undefined, "L1 宿主不可达 → fail-closed 本地报告（既有兼容保留）", { reachable: view.host_reachable });
}

// ═══ 第二部分：HTTP 路由取消贯通（真实宿主 + 夹具 worker）═══
c("M/N/O HTTP 路由取消贯通");
const workerCtl = path.join(tmpRoot, "workerctl");
fs.mkdirSync(workerCtl, { recursive: true });
const fakeWorkerPath = path.join(tmpRoot, "fake-read-worker.mjs");
fs.writeFileSync(
  fakeWorkerPath,
  [
    'import fs from "node:fs";',
    'import path from "node:path";',
    'import { parentPort } from "node:worker_threads";',
    'const dir = process.env.TATAI_TEST_WORKER_DIR || "";',
    'parentPort.on("message", (msg) => {',
    '  const id = msg && msg.id;',
    '  let delay = 0;',
    '  try { delay = Number(fs.readFileSync(path.join(dir, "delay.json"), "utf8")) || 0; } catch {}',
    '  try { fs.writeFileSync(path.join(dir, "start-" + id + ".json"), JSON.stringify({ kind: msg.kind })); } catch {}',
    '  setTimeout(() => {',
    '    try { fs.writeFileSync(path.join(dir, "finish-" + id + ".json"), "{}"); } catch {}',
    '    parentPort.postMessage({ id, ok: true, result: { configured: false, overall: "not_configured" } });',
    '  }, delay);',
    '});',
    '',
  ].join("\n"),
);
process.env.TATAI_READ_WORKER_ENTRY = fakeWorkerPath;
process.env.TATAI_TEST_WORKER_DIR = workerCtl;
const setDelay = (ms: number): void => fs.writeFileSync(path.join(workerCtl, "delay.json"), String(ms));
const clearMarkers = (): void => {
  for (const f of fs.readdirSync(workerCtl)) if (f !== "delay.json") fs.rmSync(path.join(workerCtl, f));
};
const markerCounts = (): { start: number; finish: number } => {
  const files = fs.readdirSync(workerCtl);
  return { start: files.filter((f) => f.startsWith("start-")).length, finish: files.filter((f) => f.startsWith("finish-")).length };
};

const routeHome = path.join(tmpRoot, "routeHome");
fs.mkdirSync(routeHome, { recursive: true });
const service = new serviceMod.WorkService({ dataDir: routeHome });
const routeToken = "route-token";
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
  if (syncHttpMod.handleSyncStatusRoute(req, res, pathname, routeHome)) return;
  void serviceMod.handleWorkRequest(req, res, { service, token: routeToken, pathname }).then((handled: boolean) => {
    if (!handled) {
      res.writeHead(404);
      res.end();
    }
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const routePort = (server.address() as { port: number }).port;
serviceMod.writeServiceDescriptor(routeHome, {
  schema_version: SCHEMA,
  pid: process.pid,
  host: "127.0.0.1",
  port: routePort,
  token: routeToken,
  started_at: new Date().toISOString(),
  url: `http://127.0.0.1:${routePort}`,
});
for (const id of ["RT-A", "RT-B"]) {
  const d = path.join(tmpRoot, `proj-${id}`);
  fs.mkdirSync(path.join(d, ".工作台", "work"), { recursive: true });
  registryMod.addProject({ id, name: id, path: d, kind: "backend" }, routeHome);
}

interface Res {
  status: number;
  json: any;
}
const get = (p: string, token?: string): Promise<Res> =>
  new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: routePort, method: "GET", path: p, headers: token ? { [HDR]: token } : {} },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (x: Buffer) => chunks.push(x));
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
    req.end();
  });

// M：正常请求 → 200、worker 完成、无错误 incidents
poolMod.__resetRuntimeDiagnosticsForTest();
setDelay(0);
clearMarkers();
{
  const r = await get(`/api/work/sync/status?project_id=RT-A`, routeToken);
  await sleep(200);
  const mc = markerCounts();
  ok(r.status === 200 && r.json?.ok === true, "M1 正常请求 200", { status: r.status });
  ok(mc.start === 1 && mc.finish === 1, "M2 正常请求的 worker 完成（写 finish 标记）", mc);
  ok(poolMod.runtimeTelemetry().incidents.length === 0, "M3 正常 close 无错误 incidents", { incidents: poolMod.runtimeTelemetry().incidents.length });
}

// N：提前断开取消本请求作业，不影响并行另一请求
setDelay(3500);
clearMarkers();
poolMod.__resetRuntimeDiagnosticsForTest();
{
  const req = http.request({ host: "127.0.0.1", port: routePort, method: "GET", path: `/api/work/sync/status?project_id=RT-A`, headers: { [HDR]: routeToken } }, () => {});
  req.on("error", () => {});
  req.end();
  await sleep(900);
  req.destroy(); // 客户端提前断开
  const parallel = await get(`/api/work/sync/status?project_id=RT-B`, routeToken);
  await sleep(400);
  const mc = markerCounts();
  ok(parallel.status === 200 && parallel.json?.ok === true, "N1 并行另一请求成功（不受取消影响）", { status: parallel.status });
  ok(mc.start === 2, "N2 两个作业都启动（start=2）", mc);
  ok(mc.finish === 1, "N3 被取消的作业未完成（worker 已释放，仅并行请求 finish）", mc);
  const inc = poolMod.runtimeTelemetry().incidents;
  ok(inc.some((i: any) => i.outcome === "aborted" && i.code === "READ_JOB_ABORTED"), "N4 断开产生 aborted 事件（signal 已贯通到 worker 池）", { incidents: inc.map((i: any) => i.code) });
}

// O：旧 /api/projects/:id/sync-status 同样贯通取消
setDelay(3500);
clearMarkers();
poolMod.__resetRuntimeDiagnosticsForTest();
{
  const req = http.request({ host: "127.0.0.1", port: routePort, method: "GET", path: `/api/projects/RT-A/sync-status` }, () => {});
  req.on("error", () => {});
  req.end();
  await sleep(900);
  req.destroy();
  await sleep(3300);
  const mc = markerCounts();
  ok(mc.start === 1 && mc.finish === 0, "O1 旧项目读口提前断开 → 该作业被取消（无 finish）", mc);
  const inc = poolMod.runtimeTelemetry().incidents;
  ok(inc.some((i: any) => i.outcome === "aborted"), "O2 旧读口断开也产生 aborted 事件", { incidents: inc.map((i: any) => i.code) });
}

// ── 收尾 ──
try {
  await poolMod.stopReadWorkers();
} catch {
  /* ignore */
}
await new Promise<void>((r) => server.close(() => r()));
await new Promise<void>((r) => fakeHost.close(() => r()));
if (process.env.TATAI_KEEP_TMP !== "1") {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

console.log(`[verify] ── 汇总`);
info(`PASS ${pass} / FAIL ${fails.length}`);
if (fails.length > 0) {
  for (const f of fails) info(`FAIL: ${f}`);
  process.exit(1);
}
