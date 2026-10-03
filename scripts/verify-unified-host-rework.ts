// V09-31/37 复审返工**专项行为**验证（tsx 跑）：契约 U4 的多项目公平 / prep 有界优先 / 有界队列资源 /
// 取消与失败收口 / "worker 不可用不回退主线程长算" / 结构化错误码不吞。
//
// 与 `verify-unified-host-scan.ts` 分工：那个覆盖"扫描真进了线程、写只在唯一主宿主"；本脚本覆盖
// **调度与失败收口**（复审根因三 / M1 / 根因二）。全部断言基于**可观测行为**（作业完成顺序、真实
// HTTP 状态码、对外的拒绝码），不只看类内部状态。
//
// 隔离口径：系统 tmp 前缀 `tatai-unified-host-rework-` 独立数据目录 + 独立项目；收尾自清；HTTP 绑
// 127.0.0.1:0（**绝不**抢 8787）；不 commit、不调模型、不碰真实数据。
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

const tmpParentDir = process.env.TATAI_VERIFY_TMP_ROOT ?? os.tmpdir();
fs.mkdirSync(tmpParentDir, { recursive: true });
const tmpRoot = fs.mkdtempSync(path.join(tmpParentDir, "tatai-unified-host-rework-"));
const HOME = path.join(tmpRoot, "home");
fs.mkdirSync(HOME, { recursive: true });
process.env.TATAI_HOME = HOME;
process.env.TATAI_NO_AUTOSTART = "1";
// 缺省：1 个 worker（便于观测排队/轮转），足够大的队列上限（公平性用例自己控制分组上限）。
process.env.TATAI_READ_WORKER_POOL = "1";
process.env.TATAI_READ_WORKER_QUEUE = "64";
process.env.TATAI_READ_WORKER_GROUP_QUEUE = "64";

const registry = await loadSrc<any>("src/server/registry.ts");
const poolMod = await loadSrc<any>("src/server/work/readWorkerPool.ts");
const serviceMod = await loadSrc<any>("src/server/work/service.ts");
const workHostMod = await loadSrc<any>("src/server/workHost.ts");

const projects = ["A", "B", "C"];
for (const p of projects) {
  const dir = path.join(tmpRoot, "proj-" + p);
  fs.mkdirSync(path.join(dir, ".工作台", "work", "sync-inbox"), { recursive: true });
  registry.addProject({ id: p, name: "夹具 " + p, path: dir, kind: "backend" }, HOME);
}
const HOME_ABS = HOME;

const syncJob = (p: string): Promise<unknown> => poolMod.runReadJob("sync_status", { projectId: p, dataDir: HOME_ABS });
/** 锁外准备（prep）作业：真实 worker 行为，项目维度在 `cmd.project_id` 里（与宿主写路径调用一致） */
const prepJob = (p: string): Promise<unknown> =>
  poolMod.runReadJob("sync_prep", {
    kind: "sync_evidence",
    cmd: { project_id: p },
    dataDir: HOME_ABS,
    workDir: path.join(tmpRoot, "proj-" + p, ".工作台", "work"),
  });
const pushLabel = (order: string[], label: string) => (): void => {
  order.push(label);
};
const settleCode = (pr: Promise<unknown>): Promise<string> =>
  pr.then(
    () => "ok",
    (e: any) => (typeof e?.code === "string" ? e.code : "ERR:" + String(e)),
  );

async function resetPool(env: { queue?: number; group?: number; pool?: number } = {}): Promise<void> {
  if (env.pool !== undefined) process.env.TATAI_READ_WORKER_POOL = String(env.pool);
  if (env.queue !== undefined) process.env.TATAI_READ_WORKER_QUEUE = String(env.queue);
  if (env.group !== undefined) process.env.TATAI_READ_WORKER_GROUP_QUEUE = String(env.group);
  await poolMod.stopReadWorkers().catch(() => {});
  poolMod.__resetReadWorkerPoolForTest();
}

async function main(): Promise<void> {
  info(`隔离数据目录 ${HOME}`);

  // ════════ R1. 多项目公平：A 不断入队，B 仍能完成（项目轮转，不只 FIFO） ════════
  await resetPool({ pool: 1, queue: 64, group: 64 });
  {
    const order: string[] = [];
    const proms: Promise<unknown>[] = [];
    for (let i = 0; i < 20; i++) proms.push(syncJob("A").then(() => order.push("A" + i)));
    const bP = syncJob("B").then(() => order.push("B"));
    await Promise.allSettled([...proms, bP]);
    const bAt = order.indexOf("B");
    ok(order.length === 21 && bAt >= 0 && bAt <= 3, "R1 A 连续入队 20 个后 B 仍在前 4 个里完成（项目轮转，非 FIFO）", { order, bAt });
  }

  // ════════ R2. prep 有界优先：写路径必要核验（锁外准备）先插队，但不独占 ════════
  await resetPool({ pool: 1, queue: 64, group: 64 });
  {
    const order: string[] = [];
    const proms: Promise<unknown>[] = [];
    for (let i = 0; i < 10; i++) proms.push(syncJob("A").then(() => order.push("read")));
    const prep = poolMod
      .runReadJob("sync_prep", { kind: "sync_evidence", cmd: { bogus: true }, dataDir: HOME_ABS, workDir: path.join(tmpRoot, "proj-A", ".工作台", "work") })
      .then(() => order.push("prep"), () => order.push("prep"));
    await Promise.allSettled([...proms, prep]);
    const prepAt = order.indexOf("prep");
    ok(prepAt >= 0 && prepAt <= 2, "R2 锁外准备（prep）有界优先：在前 3 个里被调度（不让读饿死，也不被读饿死）", { order, prepAt });
  }

  // ════════ R3. 有界队列资源：全局满 + 单分组满都**显式拒绝**（不无限排队） ════════
  await resetPool({ pool: 1, queue: 3, group: 1 });
  {
    const a1 = syncJob("A"); // 立即派发（占住唯一 worker）
    const a2 = syncJob("A"); // 排队：A 组 0→1
    const a3 = await settleCode(syncJob("A")); // A 组已满 → 拒（单分组满）
    const b1 = syncJob("B"); // 排队：B 组 0→1
    const b2 = await settleCode(syncJob("B")); // B 组已满 → 拒（单分组满）
    const c1 = syncJob("C"); // 排队：C 组 0→1（全局队列 3，满）
    const d1 = await settleCode(syncJob("D")); // 全局已满 → 拒（全局满）
    const st = poolMod.readWorkerPoolStatus();
    ok(a3 === "READ_QUEUE_FULL" && b2 === "READ_QUEUE_FULL" && d1 === "READ_QUEUE_FULL", "R3a 满则显式拒绝（READ_QUEUE_FULL，不静默丢弃/不无限排队）", { a3, b2, d1 });
    ok(st.rejected_group_full >= 2 && st.rejected_full >= 1 && st.queue_limit === 3 && st.group_queue_limit === 1, "R3b 单分组满与全局满分别计数（有限队列资源可观测）", { rejected_group_full: st.rejected_group_full, rejected_full: st.rejected_full });
    await Promise.allSettled([a1, a2, b1, c1]);
    const st2 = poolMod.readWorkerPoolStatus();
    ok(st2.queued === 0 && st2.busy === 0, "R3c 结算后队列清空（无残留排队）", { queued: st2.queued, busy: st2.busy });
  }

  // ════════ R4. 取消收口：排队中的作业 abort 后即出队拒绝，后续作业照常完成 ════════
  await resetPool({ pool: 1, queue: 64, group: 64 });
  {
    const a1 = syncJob("A"); // 占住 worker
    const ac = new AbortController();
    const a2 = poolMod.runReadJob("sync_status", { projectId: "A", dataDir: HOME_ABS }, { signal: ac.signal });
    const a3 = syncJob("A");
    ac.abort();
    const code = await settleCode(a2);
    const rest = await Promise.allSettled([a1, a3]);
    const ok3 = rest.every((r) => r.status === "fulfilled");
    const after = await settleCode(syncJob("A"));
    ok(code === "READ_JOB_ABORTED" && ok3 && after === "ok", "R4 排队作业 abort → READ_JOB_ABORTED 且队列不堵（后续仍完成）", { code, ok3, after });
  }

  // ════════ R5. postMessage 失败不留下队列：不可克隆参数被拒后，后续作业照常跑 ════════
  await resetPool({ pool: 1, queue: 64, group: 64 });
  {
    const bad = poolMod.runReadJob("sync_status", { projectId: "A", dataDir: HOME_ABS, fn: () => 1 }); // 函数不可克隆
    const code = await settleCode(bad);
    const good = await settleCode(syncJob("A"));
    const st = poolMod.readWorkerPoolStatus();
    ok(code !== "ok" && good === "ok" && st.queued === 0, "R5 不可克隆参数作业被拒后，队列继续泵送（无残留/不卡死）", { code, good, queued: st.queued });
  }

  // ════════ R6. worker 不可用**不回退主线程长算**：扫描路由明确 503（真实 HTTP） ════════
  {
    const host = workHostMod.createWorkHost(HOME, {});
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      void host.handle(req, res, url.pathname).catch(() => {
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end("{}");
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const addr = server.address() as { port: number };
    host.publish(addr.port, "127.0.0.1");
    const request = (method: string, p: string, body?: unknown): Promise<{ status: number; json: any }> =>
      new Promise((resolve, reject) => {
        const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
        const req = http.request(
          { host: "127.0.0.1", port: addr.port, method, path: p, headers: { "x-tatai-work-token": host.token, ...(data ? { "content-type": "application/json", "content-length": data.length } : {}) } },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c: Buffer) => chunks.push(c));
            res.on("end", () => {
              const text = Buffer.concat(chunks).toString("utf8");
              let json: any = null;
              try { json = text === "" ? null : JSON.parse(text); } catch { json = text; }
              resolve({ status: res.statusCode ?? 0, json });
            });
          },
        );
        req.on("error", reject);
        if (data) req.write(data);
        req.end();
      });
    try {
      // 正常：worker 可用，扫描路由能应答（不误报）。
      const before = await request("POST", "/api/work/sync/scan", { project_id: "A", role: "coordinator", actor_id: "fx" });
      ok(before.status === 200, "R6a worker 可用时扫描路由正常应答（200）", { status: before.status });
      // 停池：扫描路由必须**明确 503**（不再偷偷回退主线程长算）。
      await poolMod.stopReadWorkers();
      const stopped = await request("POST", "/api/work/sync/scan", { project_id: "A", role: "coordinator", actor_id: "fx" });
      ok(
        stopped.status === 503 && (stopped.json?.code === "READ_WORKERS_UNAVAILABLE" || stopped.json?.code === "READ_QUEUE_FULL"),
        "R6b worker 不可用时扫描路由明确 503（READ_WORKERS_UNAVAILABLE），不回退主线程（不抢 8787，绑 127.0.0.1:0）",
        { status: stopped.status, body: stopped.json },
      );
      const entry = await request("GET", `/api/work/entry?project_id=A&role=executor`);
      ok(entry.status === 503 && typeof entry.json?.code === "string", "R6c worker 不可用时入口路由明确 503 + 结构化 code（不本地绕过）", { status: entry.status, code: entry.json?.code });
    } finally {
      host.unpublish();
      server.closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
    }
  }

  // ════════ R7. 结构化错误码不吞：describeReadJobError 原样带 code/detail 并映射状态 ════════
  {
    const a = poolMod.describeReadJobError(Object.assign(new Error("源在变"), { code: "SOURCE_CHANGED", detail: { reasons: ["ledger"] } }));
    const b = poolMod.describeReadJobError(Object.assign(new Error("账本抖"), { code: "LEDGER_UNSTABLE", detail: {} }));
    const c = poolMod.describeReadJobError(new Error("裸错"));
    ok(a.code === "SOURCE_CHANGED" && a.httpStatus === 503 && Array.isArray(a.detail.reasons), "R7a SOURCE_CHANGED → 503，detail 原样带出", a);
    ok(b.code === "LEDGER_UNSTABLE" && b.httpStatus === 503, "R7b LEDGER_UNSTABLE → 503（可重试瞬时态）", b);
    ok(c.code === "READ_JOB_FAILED" && c.httpStatus === 500, "R7c 无结构裸错归 READ_JOB_FAILED/500（不假称别码）", c);
  }

  // ════════ R8. M1 源码级核对：index.ts workErrorStatus 把 LEDGER_UNSTABLE 映射 503 ════════
  {
    const src = fs.readFileSync(path.join(REPO_ROOT, "src", "server", "index.ts"), "utf8");
    const m = src.match(/function workErrorStatus\(code: WorkErrorCode\): number \{([\s\S]*?)\n\}/);
    const body = m?.[1] ?? "";
    ok(body.includes('code === "LEDGER_UNSTABLE"') && body.includes("return 503"), "R8 index.ts workErrorStatus 把 LEDGER_UNSTABLE 映射 503（源码核对，独立复核 M1）", { found: body.slice(0, 400) });
  }

  // ════════ R9. 共同机制回归（真实 worker）：prep 有限插队不重置普通轮转 + prep 项目公平 ════════
  // 复现根因：旧 pickNext 每次派 prep 都写 lastGroup，普通轮次被反复重置回 A#prep，于是永远选到 B，C 饿死。
  await resetPool({ pool: 1, queue: 64, group: 64 });
  {
    const order: string[] = [];
    const proms: Promise<unknown>[] = [];
    proms.push(syncJob("A").then(pushLabel(order, "A-read"), pushLabel(order, "A-read")));
    for (let i = 0; i < 12; i++) proms.push(prepJob("A").then(pushLabel(order, "A-prep"), pushLabel(order, "A-prep")));
    for (let i = 0; i < 12; i++) proms.push(syncJob("B").then(pushLabel(order, "B"), pushLabel(order, "B")));
    proms.push(syncJob("C").then(pushLabel(order, "C"), pushLabel(order, "C")));
    await Promise.allSettled(proms);
    const cAt = order.indexOf("C");
    const bAt = order.indexOf("B");
    const prepsBeforeC = order.slice(0, cAt < 0 ? 0 : cAt).filter((x) => x === "A-prep").length;
    let run = 0;
    let maxRun = 0;
    for (const x of order) {
      if (x === "A-prep") {
        run += 1;
        maxRun = Math.max(maxRun, run);
      } else run = 0;
    }
    ok(
      order.length === 26 && cAt >= 0 && cAt <= 10 && prepsBeforeC <= 6 && bAt >= 0 && bAt < cAt,
      "R9a prep 有限插队不重置普通轮转：A 持续 prep + B 连续读时 C 仍在有限轮次内完成（普通轮转 B→C 推进，非永远选 B）",
      { cAt, prepsBeforeC, bAt, order },
    );
    ok(maxRun <= 2, "R9b prep 连续上限实际生效：连续 prep ≤ 2，超过必让出一轮给普通轮次（不空转、不饿死读）", { maxRun, order });
  }

  // ════════ R9c. prep 之间按项目公平 + 三方有界进展（A/B 都有 prep 且 C 有读） ════════
  await resetPool({ pool: 1, queue: 64, group: 64 });
  {
    const order: string[] = [];
    const proms: Promise<unknown>[] = [];
    proms.push(syncJob("A").then(pushLabel(order, "A-read"), pushLabel(order, "A-read")));
    for (let i = 0; i < 12; i++) proms.push(prepJob("A").then(pushLabel(order, "A-prep"), pushLabel(order, "A-prep")));
    proms.push(prepJob("B").then(pushLabel(order, "B-prep"), pushLabel(order, "B-prep")));
    proms.push(syncJob("C").then(pushLabel(order, "C"), pushLabel(order, "C")));
    await Promise.allSettled(proms);
    const bPrepAt = order.indexOf("B-prep");
    const cAt = order.indexOf("C");
    ok(
      bPrepAt >= 0 && bPrepAt <= 3,
      "R9c prep 之间按项目轮转：A 大量 prep 排队时 B 的 prep 仍在最前几个完成（别项目 prep 不被项目饿死）",
      { bPrepAt, order },
    );
    ok(cAt >= 0 && cAt <= 8, "R9d 三方有界进展：A/B 都有 prep 且 C 有读，C 仍在有限轮次内完成", { cAt, order });
  }

  // ════════ R9e. 单一类别（只有 prep）也不空转：全部完成、不返回 undefined 死等 ════════
  await resetPool({ pool: 1, queue: 64, group: 64 });
  {
    const order: string[] = [];
    const proms: Promise<unknown>[] = [];
    for (let i = 0; i < 6; i++) proms.push(prepJob("A").then(pushLabel(order, "A-prep"), pushLabel(order, "A-prep")));
    for (let i = 0; i < 6; i++) proms.push(prepJob("B").then(pushLabel(order, "B-prep"), pushLabel(order, "B-prep")));
    const settled = await Promise.allSettled(proms);
    const done = settled.filter((r) => r.status === "fulfilled").length;
    ok(
      done === 12 && order.length === 12 && order.filter((x) => x === "A-prep").length === 6 && order.filter((x) => x === "B-prep").length === 6,
      "R9e 只有 prep（单一类别）时也全部完成、不空转（prep 类别内仍按项目轮转推进）",
      { done, order },
    );
  }

  // ════════ R10. 失败路径：**池替身** worker（可控 exit/error）验证池机制（不是业务扫描） ════════
  // 说明：下面 `standin-worker.mjs` 是**池替身**——只回一条 `postMessage` 结果或按参数抛错/退出，
  // 用来可控地触发「空闲 worker 退出」「worker error」「postMessage 失败」，**不**跑真实只读扫描，
  // 也**不** terminate 任何外部进程。真实 worker 行为已由 R1–R9 覆盖。
  const standinPath = path.join(tmpRoot, "standin-worker.mjs");
  fs.writeFileSync(
    standinPath,
    [
      'import { parentPort } from "node:worker_threads";',
      'const EXIT_AFTER_REPLY = process.env.TATAI_STANDIN_EXIT_AFTER_REPLY === "1";',
      'parentPort.on("message", (msg) => {',
      '  const args = (msg && msg.args) || {};',
      '  const behavior = (args && args.standIn) || "ok";',
      '  if (behavior === "boom") throw new Error("standin boom");',
      '  parentPort.postMessage({ id: msg.id, ok: true, result: { standin: true, id: msg.id } });',
      '  if (EXIT_AFTER_REPLY) setTimeout(() => process.exit(0), 120);',
      '});',
      "",
    ].join("\n"),
  );

  // R10a：空闲 worker 退出必须从 slots 摘除——后续任务不派到死 worker 上等超时。
  // 保活定时器（ref'd）：回归时"派到死 worker"会让事件循环没有活跃 handle，进程会**静默退出 0**；
  // 有它兜住，回归会被如实判 FAIL（超时拒绝）而不是悄悄"通过"。
  const r10KeepAlive = setInterval(() => {}, 500);
  process.env.TATAI_READ_WORKER_ENTRY = standinPath;
  process.env.TATAI_STANDIN_EXIT_AFTER_REPLY = "1";
  process.env.TATAI_READ_WORKER_TIMEOUT_MS = "3000"; // 若真派到死 worker，会在 3s 超时暴露（正常远早于它返回）
  await resetPool({ pool: 1, queue: 8, group: 8 });
  {
    const j1 = await settleCode(poolMod.runReadJob("sync_status", { standIn: "ok", projectId: "A", dataDir: HOME_ABS }));
    await new Promise<void>((r) => setTimeout(r, 500)); // 让空闲 worker 退出
    const t0 = Date.now();
    const j2 = await settleCode(poolMod.runReadJob("sync_status", { standIn: "ok", projectId: "A", dataDir: HOME_ABS }));
    const dt = Date.now() - t0;
    ok(
      j1 === "ok" && j2 === "ok" && dt < 2500,
      "R10a 空闲 worker 退出后摘槽：后续任务派到新 worker 立即完成（不派到死 worker 白等超时）",
      { j1, j2, dt },
    );
  }

  // R10b：池 stop 时**排队**作业解除 signal 监听（add/remove 配对，不泄漏到调用方的 AbortController）。
  // R10d：postMessage 失败（不可克隆参数）后继续泵送队列，后续作业照常完成（池替身路径也成立）。
  {
    process.env.TATAI_STANDIN_EXIT_AFTER_REPLY = "0";
    const fakeSignal: any = { aborted: false, added: 0, removed: 0, addEventListener() { this.added += 1; }, removeEventListener() { this.removed += 1; } };
    const j1 = poolMod.runReadJob("sync_status", { standIn: "ok", projectId: "A", dataDir: HOME_ABS }); // 占住唯一 worker
    const j1Code = settleCode(j1); // 先挂结算句柄：stop() 会拒绝在途作业，避免未处理拒绝
    const jq = poolMod.runReadJob("sync_status", { standIn: "ok", projectId: "B", dataDir: HOME_ABS }, { signal: fakeSignal }); // 排队
    const jqCode = settleCode(jq);
    await poolMod.stopReadWorkers(); // 排队作业应被拒绝并解除监听
    const code = await jqCode;
    const j1c = await j1Code;
    ok(
      code === "READ_WORKERS_UNAVAILABLE" && fakeSignal.added === 1 && fakeSignal.removed === 1 && j1c === "READ_WORKERS_UNAVAILABLE",
      "R10b 池 stop 时排队作业解除 signal 监听（add/remove 配对；在途作业如实收口，不泄漏）",
      { code, added: fakeSignal.added, removed: fakeSignal.removed, j1: j1c },
    );
    await resetPool({ pool: 1, queue: 8, group: 8 });
    const bad = settleCode(poolMod.runReadJob("sync_status", { standIn: "ok", projectId: "A", dataDir: HOME_ABS, fn: () => 1 })); // 函数不可克隆
    const good = settleCode(poolMod.runReadJob("sync_status", { standIn: "ok", projectId: "A", dataDir: HOME_ABS }));
    const [badCode, goodCode] = await Promise.all([bad, good]);
    ok(badCode !== "ok" && goodCode === "ok", "R10d postMessage 失败后继续泵送队列：坏作业被拒、后续作业照常完成（无残留/不卡死）", { badCode, goodCode });
  }

  // R10c：worker error/exit 只结算**自己的槽位**，不牵连同池其它在途作业（异步 error/exit 不重复影响别 slot）。
  {
    delete process.env.TATAI_STANDIN_EXIT_AFTER_REPLY;
    await resetPool({ pool: 2, queue: 8, group: 8 });
    const [boom, good, other] = await Promise.all([
      settleCode(poolMod.runReadJob("sync_status", { standIn: "boom", projectId: "A", dataDir: HOME_ABS })),
      settleCode(poolMod.runReadJob("sync_status", { standIn: "ok", projectId: "B", dataDir: HOME_ABS })),
      settleCode(poolMod.runReadJob("sync_status", { standIn: "ok", projectId: "C", dataDir: HOME_ABS })),
    ]);
    ok(
      boom !== "ok" && good === "ok" && other === "ok",
      "R10c worker error/exit 只结算自己的槽位：同池其它在途/排队作业照常成功（error 后紧跟 exit 不重复影响别 slot）",
      { boom, good, other },
    );
  }
  // 复原：清掉池替身 override，回到真实 worker 行为。
  delete process.env.TATAI_READ_WORKER_ENTRY;
  delete process.env.TATAI_READ_WORKER_TIMEOUT_MS;
  await resetPool({ pool: 1, queue: 64, group: 64 });
  clearInterval(r10KeepAlive);

  info(`结果：PASS ${pass} / FAIL ${fails.length}`);
  if (fails.length > 0) {
    for (const f of fails) console.log(`[verify] FAIL ${f}`);
    process.exitCode = 1;
  }
  if (process.env.TATAI_KEEP_TMP !== "1") {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

main()
  .catch((e: unknown) => {
    console.error(`[verify] FAIL 脚本异常：${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    process.exitCode = 1;
  })
  .finally(() => {
    void poolMod.stopReadWorkers().catch(() => {});
  });
