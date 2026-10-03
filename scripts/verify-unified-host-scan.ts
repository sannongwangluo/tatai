// V09-31/37 目标二**专项**验证（tsx 跑）：复审 A 健康对账、B worker 池生命周期、D 只读扫描线程 +
// 异步锁外准备、E arch 只读派生入 worker、F 说明索引宿主路由。与 `verify-unified-host.ts` 分工：
// 那个覆盖入口/图/健康读口；本脚本覆盖"后台扫描与锁外准备真进了线程、且写只在唯一主宿主"。
//
// 隔离口径（AGENTS.md §5）：系统 tmp 下 `tatai-unified-host-scan-` 前缀独立数据目录 + 独立项目；收尾自清；
// HTTP 宿主绑 127.0.0.1:0（**绝不**抢 8787）；不接真实项目/生产数据、不 commit、不调模型。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
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

// ── 隔离夹具（先钉 env，再加载读 env 的模块）──
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-unified-host-scan-"));
const HOME = path.join(tmpRoot, "home");
const PROJ = path.join(tmpRoot, "proj");
fs.mkdirSync(path.join(PROJ, ".工作台", "work", "sync-inbox"), { recursive: true });
fs.mkdirSync(HOME, { recursive: true });
process.env.TATAI_HOME = HOME;
process.env.TATAI_NO_AUTOSTART = "1";

const registry = await loadSrc<any>("src/server/registry.ts");
const workHostMod = await loadSrc<any>("src/server/workHost.ts");
const poolMod = await loadSrc<any>("src/server/work/readWorkerPool.ts");
const serviceMod = await loadSrc<any>("src/server/work/service.ts");
const syncMod = await loadSrc<any>("src/server/work/sync.ts");
const contractMod = await loadSrc<any>("src/server/work/syncContract.ts");
const syncDiscoveryMod = await loadSrc<any>("src/server/work/syncDiscovery.ts");
const healthMod = await loadSrc<any>("src/server/work/syncRuntimeHealth.ts");
const archRead = await loadSrc<any>("src/server/work/archReadWorker.ts");

const PID = "scan-fixture";
registry.addProject({ id: PID, name: "扫描夹具", path: PROJ, kind: "backend" }, HOME);

const sha256 = (d: string | Buffer): string => crypto.createHash("sha256").update(d).digest("hex");
const writeFile = (p: string, t: string): void => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, t, "utf8");
};

interface Res { status: number; json: any; ms: number }
const request = (port: number, method: string, p: string, opts: { token?: string; body?: unknown } = {}): Promise<Res> =>
  new Promise((resolve, reject) => {
    const t0 = Date.now();
    const data = opts.body === undefined ? null : Buffer.from(JSON.stringify(opts.body));
    const req = http.request(
      { host: "127.0.0.1", port, method, path: p, headers: { ...(opts.token ? { "x-tatai-work-token": opts.token } : {}), ...(data ? { "content-type": "application/json", "content-length": data.length } : {}) } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json: any = null;
          try { json = text === "" ? null : JSON.parse(text); } catch { json = text; }
          resolve({ status: res.statusCode ?? 0, json, ms: Date.now() - t0 });
        });
      },
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });

const runChild = (scriptPath: string): Promise<{ code: number | null; out: string; ms: number }> =>
  new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, ["--import", "tsx", scriptPath], {
      cwd: REPO_ROOT,
      env: { ...process.env, TATAI_HOME: HOME, TATAI_NO_AUTOSTART: "1" },
      windowsHide: true,
    });
    let out = "";
    child.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { out += d.toString(); });
    const killer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, 30_000);
    child.on("exit", (code) => { clearTimeout(killer); resolve({ code, out, ms: Date.now() - t0 }); });
  });

async function main(): Promise<void> {
  info(`隔离数据目录 ${HOME}｜项目 ${PROJ}`);

  // ════════ A. 健康对账：worker 有独立内存，回包前后按宿主真实汇对齐（有界重算/明确不可用） ════════
  {
    // A1 稳定：readIssues 恒等 → 直接返回，issues 与 value 同源。
    let calls = 0;
    const stable = await healthMod.runWithHostHealth(
      () => ["issue-A"],
      async (issues: string[]) => { calls += 1; return { seen: issues }; },
    );
    ok(stable.value.seen.includes("issue-A") && stable.issues.includes("issue-A") && calls === 1, "A1 健康稳定时一次算完，value 与 issues 同源", { calls, stable });

    // A2 抖动：每轮都变 → 有界重算后抛 HealthUnstable（不把新错误拼到旧结论上）。
    let n = 0;
    let threw: any = null;
    try {
      await healthMod.runWithHostHealth(
        () => [`v${n}`],
        async (issues: string[]) => { n += 1; return { seen: issues }; },
        { maxAttempts: 3 },
      );
    } catch (e) { threw = e; }
    ok(threw !== null && threw.code === "HEALTH_UNSTABLE" && n === 3, "A2 健康持续变化 → 有界 3 轮后抛 HEALTH_UNSTABLE（明确不可用）", { n, code: threw?.code });
  }

  // ── 以真实 HTTP 起唯一宿主（workHost）──
  const host = workHostMod.createWorkHost(HOME, {});
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    void host.handle(req, res, url.pathname).catch((e: unknown) => {
      if (res.headersSent) { res.end(); return; }
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address() as { port: number };
  host.publish(addr.port, "127.0.0.1");
  const port = addr.port;

  try {
    // ════════ A3. 真实 HTTP：登记宿主发现错误 → 报告必须含该错误且非 passed（跨线程同源） ════════
    {
      const marker = "SCAN_FIXTURE_DISCOVERY_FAILURE";
      healthMod.reportSyncDiscoveryIssue(HOME, PID, marker);
      const r = await request(port, "GET", `/api/work/sync/status?project_id=${PID}`, { token: host.token });
      const reportHas = JSON.stringify(r.json?.sync ?? null).includes(marker);
      ok(r.status === 200 && reportHas && r.json?.sync?.overall !== "passed", "A3 宿主发现错误在 worker 算出的报告里（overall 非 passed，不只有信封带错误）", { status: r.status, overall: r.json?.sync?.overall, reportHas });
      healthMod.reportSyncDiscoveryIssue(HOME, PID, null);
    }

    // ════════ F. 说明索引宿主写面（路由转发 + 鉴权 + 只读方法不吞） ════════
    {
      const noToken = await request(port, "POST", "/api/work/project-index/upsert", { body: { project_id: PID, entries: [] } });
      ok(noToken.status === 401, "F1 无令牌 project-index/upsert 被拒（401）", noToken.status);
      const wrongMethod = await request(port, "GET", "/api/work/project-index/upsert", { token: host.token });
      ok(wrongMethod.status === 405, "F2 GET project-index/upsert 不命中（405）", wrongMethod.status);
      const up = await request(port, "POST", "/api/work/project-index/upsert", {
        token: host.token,
        body: { project_id: PID, expected_file_sha256: null, entries: [{ id: "m1", responsibility: "夹具职责", paths: [], sources: [] }] },
      });
      ok(up.status === 200 && up.json?.ok === true, "F3 upsert 经唯一宿主落盘成功（200 ok:true）", { status: up.status, body: up.json });
      const doc = path.join(PROJ, "docs", "project-notes.json");
      ok(fs.existsSync(doc), "F4 说明文档确实写入项目内 docs/project-notes.json", doc);
      const afterSha = (up.json?.file_sha256 ?? up.json?.after_sha256 ?? null) as string | null;
      const rm = await request(port, "POST", "/api/work/project-index/remove", {
        token: host.token,
        body: { project_id: PID, expected_file_sha256: afterSha, ids: ["m1"] },
      });
      ok(rm.status === 200, "F5 remove 走同一宿主面返回 200", { status: rm.status, body: rm.json });
    }

    // ════════ D. 后台扫描：只读计划在**独立扫描池**线程里跑；提交只在唯一主宿主 ════════
    {
      // 造一个已登记的同步契约 + 收件证据包。
      const srcRel = "AGENTS.md";
      writeFile(path.join(PROJ, srcRel), "规则文件内容。\n");
      const tgtRel = "reports/out.md";
      writeFile(path.join(PROJ, tgtRel), "目标内容。\n");
      const contract = contractMod.validateSyncContract({
        schema_version: 1,
        batch_id: "b-scan",
        project_id: PID,
        title: "扫描专项批次",
        sources: [{ path: srcRel, sha256: sha256(fs.readFileSync(path.join(PROJ, srcRel))) }],
        items: [{ id: "fh", label: "规则文件", required: true, check: { type: "file_hash", path: srcRel, sha256: sha256(fs.readFileSync(path.join(PROJ, srcRel))) } }],
        blocks_entry: false,
      });
      const service = host.service;
      const reg = service.submit(syncMod.buildRegisterContractCommand({ projectId: PID, changeId: "change-none", actorId: "fx", role: "designer", contract, expectedRevision: null }));
      ok(reg.ok === true, "D1 同步契约登记成功（主宿主写）", { reg });
      // 证据包用**登记后的真实契约哈希**（`existingContractSha`）——不用命令 payload 猜。
      const csha = syncMod.existingContractSha(PID, HOME, "b-scan") ?? "";
      writeFile(
        path.join(PROJ, ".工作台", "work", "sync-inbox", "b-scan.evidence.json"),
        `${JSON.stringify({ schema_version: 1, batch_id: "b-scan", project_id: PID, contract_sha256: csha, completed: true, items: [{ id: "fh", result: "passed", artifacts: [] }] }, null, 2)}\n`,
      );

      const scanBefore = poolMod.readWorkerPoolStatus().scan;
      const outcome = await syncDiscoveryMod.runSyncScanForRequest({ projectId: PID, dataDir: HOME, submitter: service, actorId: "fx", role: "coordinator" });
      const scanAfter = poolMod.readWorkerPoolStatus().scan;
      ok(scanAfter.mode === "worker" && scanAfter.started > scanBefore.started, "D2 扫描计划确实经**独立扫描池** worker 线程跑（scan.started 增长）", { before: scanBefore, after: scanAfter });
      const entries = (outcome?.entries ?? []) as { batch_id: string; submitted: boolean }[];
      const submitted = entries.some((e) => e.batch_id === "b-scan" && (e.submitted || (e as any).duplicate));
      ok(submitted || (outcome?.report?.configured === true), "D3 扫描经主宿主提交（证据核验事件已写入）", { outcome: outcome?.entries });
      // 账本里确实出现 sync.evidence_checked（写只发生在唯一主宿主）。
      const storeMod = await loadSrc<any>("src/server/work/eventStore.ts");
      const events = storeMod.loadEvents(path.join(PROJ, ".工作台", "work")).events as any[];
      ok(events.some((e) => e.type === "sync.evidence_checked" && e.entity_id === "sync:b-scan"), "D4 唯一主宿主账本出现 sync.evidence_checked 事件", { types: events.map((e) => e.type) });

      // D5 锁外准备走受信 worker：伪造 passed 的直连提交被拒（与同步路径同一判据），且用了 sync_prep 作业。
      const readBefore = poolMod.readWorkerPoolStatus();
      const forged = {
        schema_version: 2,
        project_id: PID,
        change_id: "change-none",
        entity_id: "sync:b-scan",
        expected_revision: 99,
        type: "sync.evidence_checked",
        actor_id: "attacker",
        role: "executor",
        idempotency_key: "forged-1",
        payload: { batch_id: "b-scan", contract_sha256: csha, evidence_sha256: "0".repeat(64), evidence_path: ".工作台/work/sync-inbox/b-scan.evidence.json", overall: "passed", target_fingerprint: "x", items: [] },
      };
      let forgeErr: any = null;
      try { await service.submitAsync(forged); } catch (e) { forgeErr = e; }
      const readAfter = poolMod.readWorkerPoolStatus();
      ok(forgeErr !== null, "D5a 伪造 passed 的 sync.evidence_checked 经 submitAsync 被拒（零字节）", { code: forgeErr?.code, msg: forgeErr?.message?.slice(0, 160) });
      ok(
        readAfter.completed > readBefore.completed || readAfter.failed > readBefore.failed || readAfter.started > readBefore.started,
        "D5b submitAsync 的锁外准备确实经读/准备池 worker 跑（completed/failed/started 任一增长）",
        { before: { completed: readBefore.completed, failed: readBefore.failed, started: readBefore.started }, after: { completed: readAfter.completed, failed: readAfter.failed, started: readAfter.started } },
      );
      // D5c 客户端**不能**自带 prepared 对象绕过锁外准备：命令里塞 `prep`/`_prep` 字段也只当作未知字段校验，
      // 仍按服务自己派发给 worker 的准备判据走；这里断言塞了伪造 prep 的同一命令仍被拒。
      let injectErr: any = null;
      try {
        await service.submitAsync({ ...forged, idempotency_key: "forged-2", _prep: { source_fingerprint: "f".repeat(64) }, prep: { source_fingerprint: "f".repeat(64) } });
      } catch (e) { injectErr = e; }
      ok(injectErr !== null, "D5c 客户端自带伪造 prep 字段不能绕过锁外准备（仍拒）", { code: injectErr?.code, msg: injectErr?.message?.slice(0, 160) });

      // D6 **并发**：真实扫描在飞 + 真实 sync 提交在飞，同时健康口与轻状态口仍能应答（不自证式顺序测量）。
      const b2 = contractMod.validateSyncContract({
        schema_version: 1,
        batch_id: "b-scan2",
        project_id: PID,
        title: "并发批次",
        sources: [{ path: "AGENTS.md", sha256: sha256(fs.readFileSync(path.join(PROJ, "AGENTS.md"))) }],
        items: [{ id: "fh", label: "规则文件", required: true, check: { type: "file_hash", path: "AGENTS.md", sha256: sha256(fs.readFileSync(path.join(PROJ, "AGENTS.md"))) } }],
        blocks_entry: false,
      });
      service.submit(syncMod.buildRegisterContractCommand({ projectId: PID, changeId: "change-none", actorId: "fx", role: "designer", contract: b2, expectedRevision: null }));
      const csha2 = syncMod.existingContractSha(PID, HOME, "b-scan2") ?? "";
      writeFile(
        path.join(PROJ, ".工作台", "work", "sync-inbox", "b-scan2.evidence.json"),
        `${JSON.stringify({ schema_version: 1, batch_id: "b-scan2", project_id: PID, contract_sha256: csha2, completed: true, items: [{ id: "fh", result: "passed", artifacts: [] }] }, null, 2)}\n`,
      );
      const inflightScan = syncDiscoveryMod.runSyncScanForRequest({ projectId: PID, dataDir: HOME, submitter: service, actorId: "fx", role: "coordinator" });
      const healthLat: number[] = [];
      const lightLat: number[] = [];
      const probes: Promise<unknown>[] = [];
      for (let i = 0; i < 6; i++) {
        probes.push(
          request(port, "GET", "/api/work/health", { token: host.token }).then((h) => {
            if (i === 0) ok(h.status === 200 && h.json?.read_workers != null, "D6a 健康口如实报读/扫描 worker 池状态", h.json?.read_workers);
            healthLat.push(h.ms);
          }),
        );
        probes.push(request(port, "GET", `/api/work/sync/status?project_id=${PID}`, { token: host.token }).then((h) => {
          lightLat.push(h.ms);
        }));
      }
      await Promise.all(probes);
      await inflightScan;
      const maxHealth = Math.max(...healthLat, 0);
      const maxLight = Math.max(...lightLat, 0);
      info(`D6 原始样本（扫描在飞期间，ms）：health=${JSON.stringify(healthLat)} sync_status=${JSON.stringify(lightLat)}`);
      ok(healthLat.length === 6 && lightLat.length === 6 && maxHealth < 3000 && maxLight < 5000, "D6b 真实扫描在飞期间并发健康/轻状态读仍能应答（冒烟口径，非生产 SLO）", { healthLat, lightLat, maxHealth, maxLight });
    }

    // ════════ E. arch 只读派生入 worker（与进程内派生逐字一致；UI 不因 worker 而白屏） ════════
    {
      const viaWorker = (await poolMod.runReadJob("arch_render", { projectId: PID })) as any;
      const local = archRead.computeArchRenderRead(PID, false);
      ok(JSON.stringify(viaWorker) === JSON.stringify(local), "E1 arch_render 经 worker 与进程内派生**逐字节一致**（输出不变）");
      const bpWorker = (await poolMod.runReadJob("arch_blueprint", { projectId: PID })) as any;
      ok(bpWorker?.ok === true && bpWorker?.provenance != null && bpWorker?.draft != null, "E2 arch_blueprint 经 worker 返回 blueprint/draft/provenance", { keys: Object.keys(bpWorker ?? {}) });
      const st = poolMod.readWorkerPoolStatus();
      ok(st.mode === "worker" && st.completed > 0, "E3 arch 派生确实经有界 worker 跑（读池 completed 增长）", st);
    }
  } finally {
    // 停 HTTP + worker；只收回自己起的线程。
    try { await poolMod.stopReadWorkers(); } catch { /* ignore */ }
    host.unpublish();
    server.closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
  }

  // ════════ D7. 停机：只读池停后新作业明确拒绝（只收回自己的线程） ════════
  {
    let err: any = null;
    try { await poolMod.runReadJob("sync_status", { projectId: PID, dataDir: HOME }); } catch (e) { err = e; }
    ok(err !== null && err.code === "READ_WORKERS_UNAVAILABLE", "D7 停机后新只读作业明确拒绝（READ_WORKERS_UNAVAILABLE）", { code: err?.code });
  }

  // ════════ B. worker 池生命周期：空闲 unref（不强留进程）、作业期间 ref（await 必须跑完） ════════
  {
    const childDir = path.join(tmpRoot, "children");
    fs.mkdirSync(childDir, { recursive: true });
    const poolUrl = pathToFileURL(path.join(REPO_ROOT, "src", "server", "work", "readWorkerPool.ts")).href;
    // B1：await 一个只读作业，**不**调用 stopReadWorkers —— 作业必须跑完（打印结果），之后空闲线程不得强留进程。
    const b1 = path.join(childDir, "b1.mts");
    fs.writeFileSync(
      b1,
      `import { runReadJob } from ${JSON.stringify(poolUrl)};\n` +
        `const v = await runReadJob("sync_status", { projectId: ${JSON.stringify(PID)}, dataDir: ${JSON.stringify(HOME)} });\n` +
        `process.stdout.write("RESULT:" + (v && typeof (v as any).project_id === "string" ? (v as any).project_id : "?") + "\\n");\n`,
      "utf8",
    );
    const r1 = await runChild(b1);
    info(`B1/B2 子进程原始样本：b1=${r1.ms}ms(code=${r1.code})`);
    ok(r1.code === 0 && r1.out.includes(`RESULT:${PID}`), "B1 直接 await 只读作业：作业跑完（结果打印）且空闲线程不保活进程自动退出（exit 0）", { code: r1.code, out: r1.out.slice(-200), ms: r1.ms });
    // B2：起池但**不**跑作业（导入即退出）——不得因模块加载就常驻。
    const b2 = path.join(childDir, "b2.mts");
    fs.writeFileSync(b2, `import { readWorkerPoolStatus } from ${JSON.stringify(poolUrl)};\nprocess.stdout.write("IDLE:" + readWorkerPoolStatus().mode + "\\n");\n`, "utf8");
    const r2 = await runChild(b2);
    info(`B2 子进程原始样本：b2=${r2.ms}ms(code=${r2.code})`);
    ok(r2.code === 0 && r2.out.includes("IDLE:"), "B2 只加载池不跑作业：进程即刻退出（exit 0，无空闲线程保活）", { code: r2.code, ms: r2.ms });
  }

  info(`结果：PASS ${pass} / FAIL ${fails.length}`);
  if (fails.length > 0) {
    for (const f of fails) console.log(`[verify] FAIL ${f}`);
    process.exitCode = 1;
  }
  if (process.env.TATAI_KEEP_TMP !== "1") {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

main().catch((e: unknown) => {
  console.error(`[verify] FAIL 脚本异常：${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  process.exitCode = 1;
});
