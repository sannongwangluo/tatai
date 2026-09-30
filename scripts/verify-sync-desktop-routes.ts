// V09-25 终修 · 桌面生产路由缺陷的行为验证（先红后绿；DESIGN.md §2.10 / §6.7；docs/sync-evidence-contract.md）。
//
// 缺陷（根审独立抓到的真机安装版 404）：桌面生产入口 `src/server/index.ts` 只把
// `POST /api/work/{command,repair}` 与 `GET /api/work/{health,snapshot}` 转给唯一写服务宿主，
// **漏了 V09-23 新增的两条**：
//   · `POST /api/work/sync/scan`（MCP scan_sync_evidence 的唯一落点）→ 落进 index.ts 兜底 404；
//   · `GET  /api/work/sync/status`（宿主跨进程只读读口，回带后台发现健康）。
// 后台发现是 23/23 通过，本卡不得削弱它——只补桌面宿主的转发。
//
// 本脚本**独立写成**、先跑出行为红，不比较作者自产摘要：它起的是**真正的桌面源进程**
// （`src/server/index.ts` 子进程，`node --import tsx`），隔离 TATAI_HOME + 随机端口
// （`TATAI_PORT=0`，端口只在描述符里）＋ `TATAI_SYNC_DISCOVERY=0`（关后台发现，让**显式扫描是唯一写者**，
// 断言才有确定性；这是文档化的开关，不是削弱机制）。断言口径：
//   ① 桌面源进程确实以隔离 TATAI_HOME 起（`/health` 的 data_dir 相等）；
//   ② 既有四条 work 转发不回归；
//   ③ 经 `WorkServiceClient` 的 POST scan 返回**成功且已核验**的结果（report.overall=passed、
//      batch/item verdict=passed、submitted=true），不是"没有新增事件"；
//   ④ `GET /api/work/sync/status`（带令牌）只读可用、且**零事件**；
//   ⑤ 重复扫描：先断言**扫描成功**，再断言 sync 事件零增量（404 的"零增量"绝不算成功）；
//   ⑥ 令牌/方法/路径策略不松：无令牌 401、错方法/多段/未知路径仍 404（**不做 `/api/work` 整段透传**）；
//   ⑦ 扫描前的负对照：没有任何 `sync.evidence_checked` 事件（凭据：唯一写者=显式扫描）。
//
// 隔离口径（AGENTS.md §5）：mkdtemp 夹具 + 隔离 TATAI_HOME + 回环随机端口 + 真子进程；
// 收尾只 kill **本脚本自己起的**子进程、删临时目录；不碰真实 ~/.tatai / 真实项目与账本 / 不接网关 /
// 不调模型（模型与凭据类环境变量在 childenv 里删掉）。
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

let passCount = 0;
let failCount = 0;
const observations: Record<string, unknown> = {};
const ok = (cond: boolean, label: string, detail?: unknown): void => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (cond) passCount += 1;
  else {
    failCount += 1;
    process.exitCode = 1;
    if (detail !== undefined) console.log(`[verify]   现场：${JSON.stringify(detail).slice(0, 1600)}`);
  }
};
const info = (m: string): void => console.log(`[verify] ${m}`);
const sha256 = (d: string | Buffer): string => crypto.createHash("sha256").update(d).digest("hex");
const sha256File = (f: string): string => sha256(fs.readFileSync(f));
const mkdirp = (d: string): void => { fs.mkdirSync(d, { recursive: true }); };
const write = (f: string, t: string): void => { mkdirp(path.dirname(f)); fs.writeFileSync(f, t, "utf8"); };
const writeJson = (f: string, v: unknown): void => write(f, `${JSON.stringify(v, null, 2)}\n`);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");
/** 桌面生产入口（本卡只动它；测试起的就是这个源文件） */
const DESKTOP_ENTRY = path.join(SRC, "server", "index.ts");
/** 本卡私有证据落点（不提交；根指令指定） */
const OUT_DIR = path.join(ROOT, ".工作台", "verify", "sync-evidence-20260930", "desktop-route-final");
const loadSrc = async <T>(rel: string): Promise<T> => (await import(pathToFileURL(path.join(SRC, rel)).href)) as T;

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-sync-desktop-route-"));

/**
 * 子进程环境：剥掉全部 `TATAI_*`（再显式给需要的），并删掉模型/凭据类键——本验证不调模型、不接网关。
 */
function cleanEnv(home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k.startsWith("TATAI_")) { delete env[k]; continue; }
    if (/API_?KEY|SECRET|PASSWORD|CREDENTIAL|ACCESS_KEY|_TOKEN$/i.test(k)) delete env[k];
  }
  env.TATAI_HOME = home;
  return { ...env, ...extra };
}

interface HttpResult { status: number; json: unknown; raw: string }

async function main(): Promise<void> {
  info(`桌面生产路由缺陷 · V09-25 终修行为验证（${process.platform} · node ${process.version}）`);
  info(`  夹具根 ${tmpBase}（隔离 TATAI_HOME，端口在描述符里）`);

  const registryMod = await loadSrc<typeof import("../src/server/registry")>("server/registry.ts");
  const serviceMod = await loadSrc<typeof import("../src/server/work/service")>("server/work/service.ts");
  const syncMod = await loadSrc<typeof import("../src/server/work/sync")>("server/work/sync.ts");
  const syncContractMod = await loadSrc<typeof import("../src/server/work/syncContract")>("server/work/syncContract.ts");
  const eventStoreMod = await loadSrc<typeof import("../src/server/work/eventStore")>("server/work/eventStore.ts");
  const TOKEN_HEADER = serviceMod.WORK_TOKEN_HEADER;

  // ── 夹具：一个已注册项目 + 一份可通过的同步契约与证据包 ──
  const home = path.join(tmpBase, "home");
  const root = path.join(tmpBase, "proj-desktop-route");
  const workDir = path.join(root, ".工作台", "work");
  const inbox = path.join(workDir, "sync-inbox");
  const eventsPath = path.join(workDir, "events.jsonl");
  const PID = "desktoproute";
  const BATCH = "b-desktop-route";
  const TOTAL_REL = "docs/项目总图.md";
  const AGENTS_REL = "AGENTS.md";
  const RECEIPT_REL = "receipts/b1.json";
  const REPORT_REL = "reports/result.md";
  const TOTAL_ABS = path.join(root, "docs", "项目总图.md");
  const AGENTS_ABS = path.join(root, "AGENTS.md");
  const RECEIPT_ABS = path.join(root, "receipts", "b1.json");
  const REPORT_ABS = path.join(root, "reports", "result.md");

  mkdirp(home);
  mkdirp(inbox);
  write(path.join(root, ".工作台", "design.md"), "# 桌面路由验证设计书\n\n## 1 目标\n\n夹具正文。\n");
  write(TOTAL_ABS, "# 夹具项目总图\n\n## 3 当前阶段\n\n夹具总图正文。\n");
  write(AGENTS_ABS, "# 夹具工作规则\n\n1. 开工先读总图。\n");
  writeJson(RECEIPT_ABS, { result: "ok", detail: "夹具回执" });
  write(REPORT_ABS, "夹具报告：本批次引用的真实 artifact。\n");
  writeJson(path.join(workDir, "stage-reads.json"), {
    schema_version: 1,
    generated_from: [{ path: TOTAL_REL, sha256: sha256File(TOTAL_ABS) }],
    entries: [
      { path: TOTAL_REL, kind: "evidence", why: "总图", revision: sha256File(TOTAL_ABS) },
      { path: AGENTS_REL, kind: "evidence", why: "规则", revision: sha256File(AGENTS_ABS) },
    ],
  });
  registryMod.addProject({ id: PID, name: "桌面路由夹具", path: root, kind: "backend" }, home);

  const contract: Record<string, unknown> = {
    schema_version: 1,
    batch_id: BATCH,
    project_id: PID,
    title: "桌面路由批次",
    sources: [{ path: TOTAL_REL, sha256: sha256File(TOTAL_ABS) }],
    items: [
      { id: "src", label: "总图来源", required: true, check: { type: "file_hash", path: TOTAL_REL, sha256: sha256File(TOTAL_ABS) } },
      { id: "receipt", label: "回执字段", required: true, check: { type: "json_value", path: RECEIPT_REL, pointer: "/result", expected: "ok" } },
      { id: "reads", label: "阶段必读", required: true, check: { type: "required_reads", expected: [{ path: TOTAL_REL }, { path: AGENTS_REL }] } },
    ],
    blocks_entry: false,
  };
  const csha = syncContractMod.syncContractSha256(syncContractMod.validateSyncContract(contract));
  const artifact = { path: REPORT_REL, sha256: sha256File(REPORT_ABS) };
  const pkg = {
    schema_version: 1,
    batch_id: BATCH,
    project_id: PID,
    contract_sha256: csha,
    completed: true,
    items: [
      { id: "src", result: "passed", artifacts: [artifact] },
      { id: "receipt", result: "passed", artifacts: [artifact] },
      { id: "reads", result: "passed", artifacts: [artifact] },
    ],
  };
  // 收件目录：临时文件写后原子改名（与契约同一写法）
  const tmpInbox = path.join(inbox, `.${BATCH}.evidence.json.tmp-${crypto.randomBytes(3).toString("hex")}`);
  fs.writeFileSync(tmpInbox, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
  fs.renameSync(tmpInbox, path.join(inbox, `${BATCH}.evidence.json`));

  // ── 起真正的桌面源进程 ──
  let child: ChildProcess | null = null;
  let childLog = "";
  const eventsOf = (): readonly { seq: number; type: string }[] =>
    fs.existsSync(eventsPath) ? eventStoreMod.loadEvents(workDir).events.map((e) => ({ seq: e.seq, type: e.type })) : [];
  const syncEvCount = (): number => eventsOf().filter((e) => e.type.startsWith("sync.")).length;
  const evidenceCheckedCount = (): number => eventsOf().filter((e) => e.type === "sync.evidence_checked").length;

  const descriptorOf = (): { host: string; port: number; token: string; pid: number } | null => {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(home, "work-service.json"), "utf8")) as { host?: unknown; port?: unknown; token?: unknown; pid?: unknown };
      if (typeof d?.port !== "number" || typeof d.host !== "string" || typeof d.token !== "string" || typeof d.pid !== "number") return null;
      return { host: d.host, port: d.port, token: d.token, pid: d.pid };
    } catch { return null; }
  };
  const waitDescriptor = async (timeoutMs: number): Promise<{ host: string; port: number; token: string; pid: number } | null> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const d = descriptorOf();
      if (d !== null) return d;
      if (Date.now() > deadline) return null;
      await sleep(200);
    }
  };

  const httpReq = (host: string, port: number, method: string, p: string, opts: { token?: string; body?: unknown } = {}): Promise<HttpResult> =>
    new Promise((resolve, reject) => {
      const headers: Record<string, string> = {};
      if (opts.token !== undefined) headers[TOKEN_HEADER] = opts.token;
      let payload: string | undefined;
      if (opts.body !== undefined) { payload = JSON.stringify(opts.body); headers["content-type"] = "application/json"; }
      const req = http.request({ host, port, path: p, method, headers }, (res) => {
        let t = "";
        res.on("data", (c: Buffer) => (t += c.toString("utf8")));
        res.on("end", () => { let j: unknown = {}; try { j = JSON.parse(t); } catch { j = { raw: t }; } resolve({ status: res.statusCode ?? 0, json: j, raw: t }); });
      });
      req.on("error", reject);
      req.setTimeout(15_000, () => req.destroy(new Error("http 超时")));
      req.end(payload);
    });

  interface ItemLite { id: string; required: boolean; verdict: string; expected?: unknown; actual?: unknown }
  interface BatchLite { batch_id: string; active: boolean; blocks_entry: boolean; verdict: string; items: ItemLite[] }
  interface ReportLite { project_id: string; configured: boolean; overall: string; checked_at?: string; scan_error: string | null; batches: BatchLite[]; uncollection?: unknown }
  interface EntryLite { batch_id: string; submitted: boolean; duplicate: boolean; verdict: string; error: string | null }
  interface OutcomeLite { project_id: string; report: ReportLite; entries: EntryLite[]; scan_error: string | null }

  try {
    mkdirp(OUT_DIR);
    child = spawn(process.execPath, ["--import", "tsx", DESKTOP_ENTRY], {
      cwd: ROOT,
      // TATAI_PORT=0 → 随机端口（只在描述符里）；TATAI_SYNC_DISCOVERY=0 → 关后台发现，显式扫描是唯一写者
      env: cleanEnv(home, { TATAI_PORT: "0", TATAI_SYNC_DISCOVERY: "0" }),
      windowsHide: true,
    });
    child.stdout?.on("data", (d: Buffer) => (childLog += d.toString("utf8")));
    child.stderr?.on("data", (d: Buffer) => (childLog += d.toString("utf8")));

    const desc = await waitDescriptor(40_000);
    ok(desc !== null && child.pid !== undefined && desc.pid === child.pid,
      "0-1 真桌面源进程（src/server/index.ts）绑定并发布描述符（描述符属本进程）",
      { got: desc !== null, child_pid: child.pid, desc_pid: desc?.pid, log: childLog.slice(-400) });
    if (desc === null) throw new Error("桌面源进程未发布描述符");
    observations.descriptor = { host: desc.host, port: desc.port, pid: desc.pid };
    fs.writeFileSync(path.join(OUT_DIR, "desktop-child.log"), childLog, "utf8");

    // 等健康（暴露 start 完成）
    let up = false;
    for (let i = 0; i < 50 && !up; i++) {
      try { const h = await httpReq(desc.host, desc.port, "GET", "/health"); up = h.status === 200; } catch { /* 未就绪 */ }
      if (!up) await sleep(200);
    }
    ok(up, "0-2 桌面源进程可探活（/health 200）");

    // ═══ 1. 隔离证据 + 既有四条 work 转发不回归 ═══
    const health = await httpReq(desc.host, desc.port, "GET", "/health");
    const healthDataDir = (health.json as { data_dir?: string }).data_dir;
    ok(health.status === 200 && typeof healthDataDir === "string" && path.resolve(healthDataDir) === path.resolve(home),
      "1-1 桌面源进程用的是隔离 TATAI_HOME（/health.data_dir == 夹具 home）",
      { status: health.status, data_dir: healthDataDir, home });

    const wh = await httpReq(desc.host, desc.port, "GET", "/api/work/health", { token: desc.token });
    ok(wh.status === 200 && (wh.json as { ok?: boolean }).ok === true, "1-2 既有转发不回归：GET /api/work/health（带令牌）→ 200 ok", { status: wh.status });
    const whNoTok = await httpReq(desc.host, desc.port, "GET", "/api/work/health");
    ok(whNoTok.status === 401, "1-3 写入面仍要描述符令牌：GET /api/work/health（无令牌）→ 401", { status: whNoTok.status, body: whNoTok.json });

    // ═══ 2. 经桌面宿主的既有命令面登记同步契约（写入面既有路径，非本卡改动）═══
    const regCmd = syncMod.buildRegisterContractCommand({
      projectId: PID, changeId: "change-none", actorId: "verify-desktop-routes", role: "coordinator",
      contract, expectedRevision: null,
    });
    const reg = await httpReq(desc.host, desc.port, "POST", "/api/work/command", { token: desc.token, body: regCmd });
    const regReceipt = reg.json as { ok?: boolean; seq?: number; projection?: { state?: string } };
    ok(reg.status === 200 && regReceipt.ok === true && regReceipt.projection?.state === "applied",
      "2-1 经桌面宿主登记同步契约成功（写入面既有路径）", { status: reg.status, receipt: regReceipt });
    observations.registered_seq = regReceipt.seq;

    // 负对照：显式扫描前**没有任何** sync.evidence_checked 事件（后台发现已关，唯一写者=显式扫描）
    ok(evidenceCheckedCount() === 0, "2-2 负对照：扫描前零 sync.evidence_checked 事件（显式扫描是唯一写者）",
      { evidenceChecked: evidenceCheckedCount(), syncEvents: syncEvCount() });

    // 只读项目读口（既有）：证据+契约本身可通过（扫描前就 passed，因为读口现算）
    const projStatus = await httpReq(desc.host, desc.port, "GET", `/api/projects/${PID}/sync-status`);
    const projReport = (projStatus.json as { sync?: ReportLite }).sync;
    ok(projStatus.status === 200 && projReport?.configured === true && projReport.overall === "passed",
      "2-3 既有只读项目读口：契约+证据本身可通过（configured + overall=passed）",
      { status: projStatus.status, configured: projReport?.configured, overall: projReport?.overall });

    // ═══ 3. 缺陷本体（红→绿）：宿主的 sync/status + sync/scan ═══
    // 3-1 只读宿主读口 GET /api/work/sync/status（本卡新增转发；红时=404）
    const workStatus = await httpReq(desc.host, desc.port, "GET", `/api/work/sync/status?project_id=${PID}`, { token: desc.token });
    const workReport = (workStatus.json as { sync?: ReportLite }).sync;
    const workIssues = (workStatus.json as { discovery_issues?: unknown }).discovery_issues;
    ok(workStatus.status === 200 && (workStatus.json as { ok?: boolean }).ok === true &&
      workReport?.configured === true && workReport.overall === "passed" && Array.isArray(workIssues),
      "3-1 桌面宿主 GET /api/work/sync/status（带令牌）→ 200 + 同一份 report + 后台发现健康",
      { status: workStatus.status, body: workStatus.json });

    // 3-1b 只读读口零写：同一 GET 前后 sync 事件零增量
    const statusDeltaBefore = syncEvCount();
    await httpReq(desc.host, desc.port, "GET", `/api/work/sync/status?project_id=${PID}`, { token: desc.token });
    ok(syncEvCount() === statusDeltaBefore, "3-1b 只读读口零写：GET /api/work/sync/status 前后 sync 事件零增量",
      { before: statusDeltaBefore, after: syncEvCount() });

    // 3-2 经 WorkServiceClient 的 POST scan 必须返回**成功且已核验**的结果（红时抛 404）
    const client = new serviceMod.WorkServiceClient({ dataDir: home, autostart: false, timeoutMs: 20_000 });
    let firstOutcome: OutcomeLite | null = null;
    let firstError: string | null = null;
    try { firstOutcome = (await client.scanSyncEvidence(PID, { role: "coordinator" })) as OutcomeLite; }
    catch (e) { firstError = e instanceof Error ? e.message : String(e); }
    const firstEntry = firstOutcome?.entries.find((e) => e.batch_id === BATCH) ?? null;
    const firstBatch = firstOutcome?.report.batches.find((b) => b.batch_id === BATCH) ?? null;
    ok(firstOutcome !== null && firstError === null && firstOutcome.project_id === PID &&
      firstOutcome.report.overall === "passed" && firstEntry !== null && firstEntry.verdict === "passed" &&
      firstEntry.submitted === true && firstBatch !== null && firstBatch.verdict === "passed" &&
      firstBatch.items.every((i) => i.verdict === "passed"),
      "3-2 桌面宿主 POST /api/work/sync/scan（WorkServiceClient）→ 成功且逐项已核验（不是「没有新增事件」）",
      { error: firstError, overall: firstOutcome?.report.overall, entry: firstEntry, items: firstBatch?.items });
    ok(firstEntry !== null && firstBatch !== null && firstBatch.items.length === 3 &&
      firstBatch.items.every((i) => i.expected !== undefined && i.actual !== undefined),
      "3-2b 逐项结论带期望/实际（真读了目标，不是只看作者声明）",
      { items: firstBatch?.items });
    observations.first_scan = { overall: firstOutcome?.report.overall ?? null, entry: firstEntry, error: firstError };

    // 3-3 显式扫描真的写了账：恰好一条 sync.evidence_checked
    ok(evidenceCheckedCount() === 1, "3-3 显式扫描写入恰好一条 sync.evidence_checked（唯一写者=显式扫描）",
      { evidenceChecked: evidenceCheckedCount(), syncEvents: syncEvCount() });

    // ═══ 4. 幂等：先断言扫描**成功**，再断言零事件增量（404 的零增量不算成功）═══
    const before = syncEvCount();
    let secondOutcome: OutcomeLite | null = null;
    let secondError: string | null = null;
    try { secondOutcome = (await client.scanSyncEvidence(PID, { role: "coordinator" })) as OutcomeLite; }
    catch (e) { secondError = e instanceof Error ? e.message : String(e); }
    const secondEntry = secondOutcome?.entries.find((e) => e.batch_id === BATCH) ?? null;
    // 关键顺序：先证明**成功且已核验**（overall/batch/item verdict=passed），再看增量
    const secondSucceeded = secondOutcome !== null && secondError === null &&
      secondOutcome.report.overall === "passed" && secondEntry !== null && secondEntry.verdict === "passed" &&
      secondOutcome.report.batches.find((b) => b.batch_id === BATCH)?.verdict === "passed";
    ok(secondSucceeded, "4-1 重复扫描仍是成功且已核验（先断言成功，避免把 404 的零增量当成功）",
      { error: secondError, overall: secondOutcome?.report.overall, entry: secondEntry });
    ok(secondEntry !== null && secondEntry.duplicate === true && secondEntry.submitted === false,
      "4-2 重复扫描按稳定幂等键回报 duplicate（submitted=false）", { entry: secondEntry });
    const after = syncEvCount();
    ok(secondSucceeded && after === before, "4-3 幂等零事件增量（且已先证成功）：重复扫描前后 sync 事件相等",
      { before, after, secondSucceeded });
    observations.second_scan = { overall: secondOutcome?.report.overall ?? null, entry: secondEntry, delta: after - before, error: secondError };

    // ═══ 5. 令牌 / 方法 / 路径策略不松（不做 /api/work 整段透传）═══
    const scanNoTok = await httpReq(desc.host, desc.port, "POST", "/api/work/sync/scan", { body: { project_id: PID } });
    ok(scanNoTok.status === 401, "5-1 显式扫描仍要描述符令牌：POST /api/work/sync/scan（无令牌）→ 401",
      { status: scanNoTok.status, body: scanNoTok.json });
    const statusNoTok = await httpReq(desc.host, desc.port, "GET", `/api/work/sync/status?project_id=${PID}`);
    ok(statusNoTok.status === 401, "5-2 宿主读口仍要令牌：GET /api/work/sync/status（无令牌）→ 401",
      { status: statusNoTok.status, body: statusNoTok.json });

    const wrongMethod1 = await httpReq(desc.host, desc.port, "GET", "/api/work/sync/scan", { token: desc.token });
    ok(wrongMethod1.status === 404 && (wrongMethod1.json as { error?: { code?: string } }).error?.code === "NOT_FOUND",
      "5-3 只认精确方法/路径：GET /api/work/sync/scan → 404 NOT_FOUND（不透传）",
      { status: wrongMethod1.status, body: wrongMethod1.json });
    const wrongMethod2 = await httpReq(desc.host, desc.port, "POST", "/api/work/sync/status", { token: desc.token, body: { project_id: PID } });
    ok(wrongMethod2.status === 404, "5-4 POST /api/work/sync/status → 404（错方法不透传）", { status: wrongMethod2.status, body: wrongMethod2.json });
    const extraSeg = await httpReq(desc.host, desc.port, "POST", "/api/work/sync/scan/extra", { token: desc.token, body: { project_id: PID } });
    ok(extraSeg.status === 404, "5-5 多段路径 POST /api/work/sync/scan/extra → 404（白名单精确匹配）", { status: extraSeg.status });
    const trailing = await httpReq(desc.host, desc.port, "GET", `/api/work/sync/status/?project_id=${PID}`, { token: desc.token });
    ok(trailing.status === 404, "5-6 尾斜杠 GET /api/work/sync/status/ → 404（不做前缀透传）", { status: trailing.status });
    const unknown = await httpReq(desc.host, desc.port, "GET", "/api/work/whatever", { token: desc.token });
    ok(unknown.status === 404 && (unknown.json as { error?: { code?: string } }).error?.code === "NOT_FOUND",
      "5-7 任意 /api/work/* 仍 404（没有 `/api/work` 整段透传）", { status: unknown.status, body: unknown.json });
    const cmdNoTok = await httpReq(desc.host, desc.port, "POST", "/api/work/command", { body: regCmd });
    ok(cmdNoTok.status === 401, "5-8 既有命令面策略未松：POST /api/work/command（无令牌）→ 401", { status: cmdNoTok.status });

    // 5-9「failed404 绝不算成功」的直接反证：一个必然 404 的写请求前后 sync 事件零增量——
    // 若脚本把"零增量"当成功，本条与 4-1/4-3 的组合就会自相矛盾；这里显式记录该 404 不是成功。
    const before404 = syncEvCount();
    const gone404 = await httpReq(desc.host, desc.port, "DELETE", "/api/work/sync/status", { token: desc.token });
    const after404 = syncEvCount();
    const gone404NotSuccess = gone404.status !== 200; // 先算成布尔，避免与下面的字面量比较被 TS 判为无交集
    ok(gone404NotSuccess && gone404.status === 404 && after404 === before404,
      "5-9 必然 404 的写请求：零增量但**状态非 200**——脚本不把 404 的零增量当成功",
      { status: gone404.status, before: before404, after: after404 });

    fs.writeFileSync(path.join(OUT_DIR, "desktop-child.log"), childLog, "utf8");
  } finally {
    // 收尾：只 kill 本脚本自己起的子进程（有界）
    try {
      if (child !== null && child.exitCode === null) {
        child.kill("SIGTERM");
        for (let i = 0; i < 25 && child.exitCode === null; i++) await sleep(100);
        if (child.exitCode === null) child.kill("SIGKILL");
      }
    } catch { /* 已退出 */ }
    try { serviceMod.removeServiceDescriptor(home); } catch { /* 夹具整棵删 */ }
    observations.pass = passCount;
    observations.fail = failCount;
    try { fs.writeFileSync(path.join(OUT_DIR, "desktop-route-summary.json"), `${JSON.stringify(observations, null, 2)}\n`, "utf8"); } catch { /* 证据写不出不改判定 */ }
    if (process.env.TATAI_KEEP_TMP !== "1") {
      try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  console.log("[verify] ── 汇总");
  info(`PASS ${passCount} / FAIL ${failCount}`);
}

main().catch((e: unknown) => {
  console.error(`[verify] FAIL 脚本异常：${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  process.exitCode = 1;
});
