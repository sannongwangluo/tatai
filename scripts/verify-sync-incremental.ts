// 同步核验提速 · 增量核验专项回归（先红后绿）。
//
// 背景（2026-10-03 性能修复，用户已批准方向）：`readSyncStatus` 过去对**全部已登记批次**（含已被
// supersede 的历史批次）逐批实时求值——历史批次一个不跳，于是 44 个历史批次 × 目标文件读哈希 ×
// 六图输入身份读取把一次只读核验拖到 8–10 秒，超过客户端预算，把实际开发卡在核验上。
//
// 本脚本验证的**新增语义**与**保留的边界**（不改任何判据、不跳 active 必需范围、不放松 fail-closed）：
//   A  历史批次（active=false）展示**账本最后的有效核验回执**，不是本次实时核验；带 historical/verified_at
//   B  历史批次的目标文件**本次一次都不读**（证明历史不实时求值）；现行批次照读
//   C  历史批次的目标变了/被删，历史结论**不变**（那是历史回执），现行批次立刻变（不拿旧通过顶上）
//   D  历史批次没有有效回执 → verified_at=null 且明确未核验（不冒充通过）
//   E  扫描**只评估 active 批次**：历史批次的证据在收件目录也不新增任何事件
//   F  写前防 supersede 竞态：锁外备好后批次被取代 → 锁内明确拒、**零字节**
//   G  后台发现**不丢通知**：扫描在途时的下一次请求合并成一轮**补跑**，新登记批次不漏
//   H  不变输入重复读取可复用、每次读取的工作量有界；同长度保留 mtime 的目标改写必须立即反映
//
// 隔离口径（AGENTS.md §5）：mkdtemp 夹具 + 隔离 dataDir；不碰真实 ~/.tatai、真实项目与账本、不接网关、不调模型。
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

let passCount = 0;
let failCount = 0;
const ok = (cond: boolean, label: string, detail?: unknown): void => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (cond) passCount += 1;
  else {
    failCount += 1;
    process.exitCode = 1;
    if (detail !== undefined) console.log(`[verify]   现场：${JSON.stringify(detail).slice(0, 1400)}`);
  }
};
const info = (m: string): void => console.log(`[verify] ${m}`);
const sha256 = (d: string | Buffer): string => crypto.createHash("sha256").update(d).digest("hex");
const mkdirp = (d: string): void => { fs.mkdirSync(d, { recursive: true }); };
const write = (f: string, t: string | Buffer): void => { mkdirp(path.dirname(f)); fs.writeFileSync(f, t); };
const writeJson = (f: string, v: unknown): void => write(f, `${JSON.stringify(v, null, 2)}\n`);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");
const loadSrc = async <T>(rel: string): Promise<T> => (await import(pathToFileURL(path.join(SRC, rel)).href)) as T;

// ── 只读量取：读窗口内对 fs.readFileSync 的调用（同进程内同对象；只在本脚本里计时，退出即恢复）──
const realReadFileSync = fs.readFileSync.bind(fs);
let readLog: { p: string; bytes: number }[] = [];
let counting = false;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(fs as any).readFileSync = (p: any, ...args: any[]) => {
  if (counting && typeof p === "string") {
    let size = -1;
    try { size = fs.statSync(p).size; } catch { /* 读不到的路径如实记 -1 */ }
    readLog.push({ p, bytes: size });
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (realReadFileSync as any)(p, ...args);
};
const readsOf = (p: string): number => readLog.filter((r) => r.p === p).length;

const PID = "incr-a";
const PID_RACE = "incr-race";
const PID_LOST = "incr-lost";
const CHG = "chg-incr";

const HIST_COUNT = 8; // 有回执的历史批次 h1..h8（外加无回执的 h0）

async function main(): Promise<void> {
  info(`同步增量核验专项回归（${process.platform} · node ${process.version}）`);
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-sync-incr-"));
  const dataDir = path.join(tmpBase, "home");
  mkdirp(dataDir);
  info(`  夹具根 ${tmpBase}（隔离 dataDir ${dataDir}）`);

  const registryMod = await loadSrc<typeof import("../src/server/registry")>("server/registry.ts");
  const serviceMod = await loadSrc<typeof import("../src/server/work/service")>("server/work/service.ts");
  const syncMod = await loadSrc<typeof import("../src/server/work/sync")>("server/work/sync.ts");
  const contractMod = await loadSrc<typeof import("../src/server/work/syncContract")>("server/work/syncContract.ts");
  const eventStoreMod = await loadSrc<typeof import("../src/server/work/eventStore")>("server/work/eventStore.ts");
  const probeMod = await loadSrc<typeof import("../src/server/work/syncProbe")>("server/work/syncProbe.ts");
  const discoveryMod = await loadSrc<typeof import("../src/server/work/syncDiscovery")>("server/work/syncDiscovery.ts");
  await loadSrc<typeof import("../src/server/work/syncGraph")>("server/work/syncGraph.ts");

  // 计数包装：真实六图探针（canonical builder）的构建次数
  const realProbe = probeMod.syncGraphProbe();
  if (realProbe === null) throw new Error("六图探针未注册（syncGraph 未加载）——夹具前置失败");
  let graphCalls = 0;
  probeMod.registerSyncGraphProbe((pid, dd) => { graphCalls += 1; return realProbe(pid, dd); });

  const project = (id: string, name: string): { root: string; workDir: string; inbox: string } => {
    const root = path.join(tmpBase, id);
    const workDir = path.join(root, ".工作台", "work");
    const inbox = path.join(workDir, "sync-inbox");
    mkdirp(root);
    mkdirp(inbox);
    write(path.join(root, ".工作台", "design.md"), `# ${name} 设计书\n\n## 1 目标\n\n夹具设计正文。\n`);
    write(path.join(root, ".工作台", "plan.md"), `# ${name} 施工图\n\n| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |\n| --- | --- | --- | --- | --- |\n| T-1 | todo | 夹具卡 |  | 证据 |\n\n### T-1 夹具卡\n\n**设计依据**：§1。**依赖**：无。**文件责任**：\`src/t.ts\`。**责任角色**：executor。\n\n- [ ] 达标\n`);
    writeJson(path.join(root, ".工作台", "arch", "modules.json"), { version: 1, generated_at: "2026-10-03T00:00:00.000Z", budget_exhausted: false, modules: [{ id: "src", path: "src", file_count: 1, loc: 0, deps: [] }] });
    registryMod.addProject({ id, name, path: root, kind: "backend" }, dataDir);
    return { root, workDir, inbox };
  };

  const A = project(PID, "增量夹具");
  const SOURCE_REL = "reports/source.md";
  const SOURCE_ABS = path.join(A.root, SOURCE_REL);
  write(SOURCE_ABS, "同步增量夹具：真实来源。\n");

  const HIST_REL = "reports/hist.md";
  const HIST_ABS = path.join(A.root, HIST_REL);
  const ACTIVE_REL = "reports/active.md";
  const ACTIVE_ABS = path.join(A.root, ACTIVE_REL);
  write(HIST_ABS, "历史批次的目标（原样）。\n");
  write(ACTIVE_ABS, "现行批次的目标（原样）。\n");

  const service = new serviceMod.WorkService({ dataDir });
  const submitter = { submit: (c: unknown) => service.submit(c) };

  const item = (targetRel: string): Record<string, unknown>[] => [
    { id: "src", label: "目标文件哈希", required: true, check: { type: "file_hash", path: targetRel, sha256: sha256(fs.readFileSync(path.join(A.root, targetRel))) } },
    { id: "graph", label: "六图同快照取齐（非必需，仅为驱动 canonical builder）", required: false, check: { type: "graph_full", expected_baseline_id: "bl-incr" } },
  ];
  const contractOf = (batchId: string, targetRel: string, extra: Record<string, unknown> = {}): unknown => ({
    schema_version: 1,
    batch_id: batchId,
    project_id: PID,
    title: `批次 ${batchId}`,
    sources: [{ path: SOURCE_REL, sha256: sha256(fs.readFileSync(SOURCE_ABS)) }],
    items: item(targetRel),
    blocks_entry: false,
    ...extra,
  });
  const register = (batchId: string, targetRel: string, extra: Record<string, unknown> = {}): { sha: string; seq: number } => {
    const contract = contractMod.validateSyncContract(contractOf(batchId, targetRel, extra));
    const cmd = syncMod.buildRegisterContractCommand({ projectId: PID, changeId: CHG, actorId: "fixture", role: "coordinator", contract, expectedRevision: null });
    const receipt = service.submit(cmd);
    if (!receipt.ok || receipt.projection.state !== "applied") throw new Error(`登记 ${batchId} 失败：${JSON.stringify(receipt).slice(0, 300)}`);
    return { sha: contractMod.syncContractSha256(contract), seq: receipt.seq };
  };
  const mkArt = (root: string, rel: string): { path: string; sha256: string } => ({ path: rel, sha256: sha256(fs.readFileSync(path.join(root, rel))) });
  const postPkg = (inbox: string, batchId: string, projectId: string, contractSha: string, items: unknown[]): void => {
    const pkg = { schema_version: 1, batch_id: batchId, project_id: projectId, contract_sha256: contractSha, completed: true, items };
    const tmp = path.join(inbox, `.${batchId}.evidence.json.tmp`);
    fs.writeFileSync(tmp, `${JSON.stringify(pkg, null, 2)}\n`);
    fs.renameSync(tmp, path.join(inbox, `${batchId}.evidence.json`));
  };
  /** 两 item（src + 非必需 graph）证据包——A 段夹具用 */
  const postEvidence = (inbox: string, batchId: string, contractSha: string, targetRel: string): void =>
    postPkg(inbox, batchId, PID, contractSha, [
      { id: "src", result: "passed", artifacts: [mkArt(A.root, targetRel)] },
      { id: "graph", result: "passed", artifacts: [mkArt(A.root, SOURCE_REL)] },
    ]);
  /** 单 item（src）证据包——竞态/丢通知夹具用 */
  const postSingle = (inbox: string, root: string, projectId: string, batchId: string, contractSha: string, targetRel: string): void =>
    postPkg(inbox, batchId, projectId, contractSha, [{ id: "src", result: "passed", artifacts: [mkArt(root, targetRel)] }]);
  const scan = (projectId = PID): Promise<unknown> => discoveryMod.requestSyncScan({ projectId, dataDir, submitter });
  const syncEvents = (workDir: string): { seq: number; entity_id: string; type: string }[] =>
    eventStoreMod.loadEvents(workDir).events.filter((e) => e.type.startsWith("sync.")).map((e) => ({ seq: e.seq, entity_id: e.entity_id, type: e.type }));
  const entityEventCount = (workDir: string, entity: string): number => syncEvents(workDir).filter((e) => e.entity_id === entity).length;
  const batchOf = (report: { batches: { batch_id: string }[] }, id: string): any => report.batches.find((b) => b.batch_id === id);

  // ═══ 0. 夹具：h0（无回执历史）← h1 ← … ← h8 ← a1（现行）═══
  // 登记 h0（无证据）→ 立即被 h1 取代 → h0 永远没有核验回执。
  const h0reg = register("h0", HIST_REL);
  for (let i = 1; i <= HIST_COUNT; i++) {
    const prev = i === 1 ? "h0" : `h${i - 1}`;
    const r = register(`h${i}`, HIST_REL, { supersedes: prev });
    postEvidence(A.inbox, `h${i}`, r.sha, HIST_REL);
    await scan();
  }
  const a1 = register("a1", ACTIVE_REL, { supersedes: `h${HIST_COUNT}` });
  postEvidence(A.inbox, "a1", a1.sha, ACTIVE_REL);
  const scanAfterBuild = await scan() as { report: any };
  ok(batchOf(scanAfterBuild.report, "a1")?.verdict === "passed", "0-1 现行批次证据齐全 → passed（夹具前置）", { verdict: batchOf(scanAfterBuild.report, "a1")?.verdict });

  // ═══ A/B 历史批次 = 账本回执；不实时求值（目标一次都不读）═══
  graphCalls = 0;
  readLog = [];
  counting = true;
  const reportA = syncMod.readSyncStatus(PID, dataDir);
  counting = false;
  const h1 = batchOf(reportA, "h1");
  const hist = reportA.batches.filter((b) => b.batch_id.startsWith("h") && b.batch_id !== "h0");
  ok(hist.every((b: any) => b.active === false && b.historical === true), "A-1 被取代批次 active=false 且显式 historical=true", hist.map((b: any) => [b.batch_id, b.active, b.historical]));
  ok(hist.every((b: any) => typeof b.verified_at === "string" && b.verified_at.length > 0), "A-2 历史批次带账本回执核验时间 verified_at", hist.map((b: any) => [b.batch_id, b.verified_at]));
  ok(h1?.verdict === "passed" && h1.items.find((i: any) => i.id === "src")?.verdict === "passed", "A-3 历史批次展示账本最后回执结论（不是本次实时核验）", { verdict: h1?.verdict, items: h1?.items?.map((i: any) => `${i.id}:${i.verdict}`) });
  ok((h1?.items.find((i: any) => i.id === "src")?.reasons ?? []).some((r: string) => /历史回执|已被取代/.test(r)), "A-4 历史批次逐项原因明确标注「历史回执」而非当前有效", h1?.items?.[0]?.reasons);
  ok(readsOf(HIST_ABS) === 0, "B-1 本次读取**没有**读历史批次的目标文件（历史不实时求值）", { histReads: readsOf(HIST_ABS), reads: readLog.filter((r) => r.p.includes("reports")).map((r) => r.p) });
  ok(readsOf(ACTIVE_ABS) >= 1, "B-2 现行批次的目标文件仍被本次读取（不跳 active 必需范围）", { activeReads: readsOf(ACTIVE_ABS) });
  ok(typeof reportA.checked_at === "string" && reportA.overall === "passed", "B-3 现行批次照常实时判定，overall 只看现行", { overall: reportA.overall });

  // ═══ C 历史目标变了/被删，历史结论不变；现行立刻变 ═══
  write(HIST_ABS, "历史批次的目标（登记后被改）。\n");
  write(ACTIVE_ABS, "现行批次的目标（登记后被改）。\n");
  const reportC = syncMod.readSyncStatus(PID, dataDir);
  const h1c = batchOf(reportC, "h1");
  ok(h1c?.verdict === "passed" && h1c?.historical === true, "C-1 历史目标被改 → 历史回执结论不变（历史≠当前）", { verdict: h1c?.verdict });
  ok(batchOf(reportC, "a1")?.verdict !== "passed", "C-2 现行目标被改 → 立刻非 passed（不拿历史通过顶上）", { verdict: batchOf(reportC, "a1")?.verdict });
  fs.rmSync(HIST_ABS, { force: true });
  const reportC2 = syncMod.readSyncStatus(PID, dataDir);
  ok(batchOf(reportC2, "h1")?.verdict === "passed" && batchOf(reportC2, "h1")?.historical === true, "C-3 历史目标被删 → 历史回执结论仍不变");
  ok(batchOf(reportC2, "a1")?.verdict !== "passed", "C-4 现行目标缺失 → 非 passed（fail-closed 保留）");
  write(HIST_ABS, "历史批次的目标（原样）。\n");
  write(ACTIVE_ABS, "现行批次的目标（原样）。\n");
  await scan();

  // ═══ D 无回执历史 → verified_at=null 且明确未核验 ═══
  const h0 = batchOf(syncMod.readSyncStatus(PID, dataDir), "h0");
  ok(h0?.historical === true && h0?.active === false, "D-1 h0 是历史批次", { active: h0?.active, historical: h0?.historical });
  ok(h0?.verified_at === null, "D-2 历史批次无有效回执 → verified_at=null（明确未核验）", { verified_at: h0?.verified_at });
  ok(h0?.verdict !== "passed", "D-3 无回执历史绝不显示为通过", { verdict: h0?.verdict });

  // ═══ E 扫描只评估 active：历史证据在收件目录也不新增事件 ═══
  const beforeE = syncEvents(A.workDir);
  await scan();
  await scan();
  const afterE = syncEvents(A.workDir);
  const histEntities = [...Array(HIST_COUNT + 1).keys()].map((i) => `sync:h${i}`);
  const histBefore = beforeE.filter((e) => histEntities.includes(e.entity_id)).length;
  const histAfter = afterE.filter((e) => histEntities.includes(e.entity_id)).length;
  ok(histAfter === histBefore, "E-1 连续扫描不给历史批次新增事件（历史不再回写）", { histBefore, histAfter });
  ok(afterE.filter((e) => e.type === "sync.evidence_checked" && e.entity_id === "sync:a1").length >= 1, "E-2 现行批次仍照常核验（active 范围不跳）");

  // ═══ F 写前防 supersede 竞态：锁外备好后被取代 → 锁内拒、零字节 ═══
  const R = project(PID_RACE, "竞态夹具");
  const raceSource = "reports/source.md";
  write(path.join(R.root, raceSource), "竞态夹具来源。\n");
  const raceTargetRel = "reports/race.md";
  write(path.join(R.root, raceTargetRel), "竞态目标。\n");
  const regRace = (batchId: string, extra: Record<string, unknown> = {}): { sha: string } => {
    const contract = contractMod.validateSyncContract({
      schema_version: 1, batch_id: batchId, project_id: PID_RACE, title: `批次 ${batchId}`,
      sources: [{ path: raceSource, sha256: sha256(fs.readFileSync(path.join(R.root, raceSource))) }],
      items: [{ id: "src", label: "目标", required: true, check: { type: "file_hash", path: raceTargetRel, sha256: sha256(fs.readFileSync(path.join(R.root, raceTargetRel))) } }],
      blocks_entry: false, ...extra,
    });
    const cmd = syncMod.buildRegisterContractCommand({ projectId: PID_RACE, changeId: CHG, actorId: "fixture", role: "coordinator", contract, expectedRevision: null });
    const receipt = service.submit(cmd);
    if (!receipt.ok || receipt.projection.state !== "applied") throw new Error(`登记 ${batchId} 失败`);
    return { sha: contractMod.syncContractSha256(contract) };
  };
  const r1 = regRace("r1");
  postSingle(R.inbox, R.root, PID_RACE, "r1", r1.sha, raceTargetRel);
  let captured: any = null;
  await discoveryMod.requestSyncScan({ projectId: PID_RACE, dataDir, submitter: { submit: (c: unknown) => { captured = c; throw new Error("capture-only"); } } });
  ok(captured !== null && captured.entity_id === "sync:r1", "F-0 抓到 r1 的证据核验命令（fixture 前置）", { entity: captured?.entity_id });
  const prep = syncMod.prepareSyncEvidenceCheck({ cmd: captured, dataDir, workDir: R.workDir });
  ok(typeof prep.source_fingerprint === "string", "F-1 锁外备好通过（r1 当时 active）");
  regRace("r3", { supersedes: "r1" });
  let rejected = false;
  let rejectReason = "";
  try {
    syncMod.assertSyncEvidenceWriteCommand({ events: eventStoreMod.loadEvents(R.workDir).events, cmd: captured, dataDir, workDir: R.workDir, prep });
  } catch (e) { rejected = true; rejectReason = e instanceof Error ? e.message : String(e); }
  ok(rejected && /取代|supersede|历史/.test(rejectReason), "F-2 批次被取代后锁内写入核实明确拒（不以旧结论顶替）", { rejectReason: rejectReason.slice(0, 200) });
  let submitRejected = false;
  try { const rec = service.submit(captured); submitRejected = rec.ok !== true; } catch { submitRejected = true; }
  ok(submitRejected, "F-3 直连写口提交同样被拒");
  ok(entityEventCount(R.workDir, "sync:r1") === 1, "F-4 零字节：sync:r1 只有登记事件，没有新增核验事件", { count: entityEventCount(R.workDir, "sync:r1") });

  // ═══ G 单飞完成代际有界 + 持续通知不丢 + 本轮错误不被后轮成功掩盖 ═══
  const L = project(PID_LOST, "丢通知夹具");
  const lostSource = "reports/source.md";
  write(path.join(L.root, lostSource), "丢通知夹具来源。\n");
  const lostTargetRel = "reports/lost.md";
  write(path.join(L.root, lostTargetRel), "丢通知目标。\n");
  const regLost = (batchId: string): string => {
    const contract = contractMod.validateSyncContract({
      schema_version: 1, batch_id: batchId, project_id: PID_LOST, title: `批次 ${batchId}`,
      sources: [{ path: lostSource, sha256: sha256(fs.readFileSync(path.join(L.root, lostSource))) }],
      items: [{ id: "src", label: "目标", required: true, check: { type: "file_hash", path: lostTargetRel, sha256: sha256(fs.readFileSync(path.join(L.root, lostTargetRel))) } }],
      blocks_entry: false,
    });
    const cmd = syncMod.buildRegisterContractCommand({ projectId: PID_LOST, changeId: CHG, actorId: "fixture", role: "coordinator", contract, expectedRevision: null });
    const receipt = service.submit(cmd);
    if (!receipt.ok || receipt.projection.state !== "applied") throw new Error(`登记 ${batchId} 失败`);
    return contractMod.syncContractSha256(contract);
  };
  const lostEvidence = (batchId: string, sha: string): void => {
    const pkg = { schema_version: 1, batch_id: batchId, project_id: PID_LOST, contract_sha256: sha, completed: true, items: [{ id: "src", result: "passed", artifacts: [{ path: lostTargetRel, sha256: sha256(fs.readFileSync(path.join(L.root, lostTargetRel))) }] }] };
    write(path.join(L.inbox, `${batchId}.evidence.json`), `${JSON.stringify(pkg, null, 2)}\n`);
  };
  const n1sha = regLost("n1");
  lostEvidence("n1", n1sha);

  const tick = (ms = 25): Promise<void> => new Promise((res) => setTimeout(res, ms));
  const settledFlag = (p: Promise<unknown>): { done: boolean } => {
    const f = { done: false };
    void p.then(() => { f.done = true; }, () => { f.done = true; });
    return f;
  };
  // 闸门 submitter：每轮进入 submit 后阻塞，直到 releaseSubmit()。roundCount = 第几次 submit
  // （每轮只提交一条新证据 → 一轮一次 submit，见下面每轮前新登记一个批次）。
  let roundCount = 0;
  const releases: (() => void)[] = [];
  const enterWaiters: { n: number; resolve: () => void }[] = [];
  const gateSubmitter = {
    submit: async (c: unknown) => {
      roundCount += 1;
      for (const w of [...enterWaiters]) if (roundCount >= w.n) { enterWaiters.splice(enterWaiters.indexOf(w), 1); w.resolve(); }
      await new Promise<void>((res) => releases.push(res));
      return service.submit(c);
    },
  };
  const waitEnter = (n: number): Promise<void> => new Promise<void>((res) => { if (roundCount >= n) res(); else enterWaiters.push({ n, resolve: res }); });
  const releaseSubmit = (): void => { releases.shift()?.(); };
  const scanL = (): Promise<unknown> => discoveryMod.requestSyncScan({ projectId: PID_LOST, dataDir, submitter: gateSubmitter });

  const p1 = scanL();
  await waitEnter(1); // round1 进入 submit（在途）
  const n2sha = regLost("n2"); // 在途中登记新批次
  lostEvidence("n2", n2sha); // 在途中投放新证据（模拟持续通知期间落地的证据）
  const p2 = scanL();
  const p3 = scanL();
  ok(p2 === p3, "G-1 在途期间的多次请求合并进同一「下一轮」（p2===p3）");
  ok(p1 !== p2, "G-2 在途请求**不**复用当前轮的 promise（每轮独立结算，不是无限补跑链）");
  const f1 = settledFlag(p1);
  const f2 = settledFlag(p2);
  await tick();
  ok(!f1.done && !f2.done, "G-3 当前轮在途时两轮都未兑现（前置）", { f1: f1.done, f2: f2.done });
  releaseSubmit(); // round1 完成 → 排定的 round2 启动
  await waitEnter(2); // round2 进入 submit（在途）
  await tick();
  ok(f1.done, "G-4 原请求随**自己那一轮**完成即返回，不等后续补跑轮（完成代际有界）");
  ok(!f2.done, "G-5 覆盖在途请求的下一轮未完成前，其 promise 不提前兑现");
  const n3sha = regLost("n3"); // round2 在途中再登记新批次
  lostEvidence("n3", n3sha);
  const p4 = scanL(); // round2 在途 → 排定 round3
  releaseSubmit(); // round2 完成 → round3 启动
  await waitEnter(3);
  await tick();
  ok(f2.done, "G-6 在途请求随覆盖它的那一轮（round2）完成而返回（连续通知下每请求最多等 2 轮）");
  ok(!settledFlag(p4).done, "G-7 round2 在途期间的新请求等待 round3，不提前兑现（前置）");
  releaseSubmit(); // round3 完成
  await p4;
  await tick();
  ok(entityEventCount(L.workDir, "sync:n1") >= 1, "G-8 原点批次已核验", { n1: entityEventCount(L.workDir, "sync:n1") });
  ok(entityEventCount(L.workDir, "sync:n2") >= 1, "G-9 在途期间新登记批次的证据**不丢**（补跑轮写出核验事件）", { n2: entityEventCount(L.workDir, "sync:n2") });
  ok(entityEventCount(L.workDir, "sync:n3") >= 1, "G-10 持续通知下第二轮的新批次也不丢", { n3: entityEventCount(L.workDir, "sync:n3") });

  // 错误语义：本轮**抛错**时如实抛回本轮请求，**不被后轮成功掩盖**。
  // 用「请求时项目还不存在 → scanSyncProject 在 projectCtx 处 reject」触发 reject 分支；在排定轮启动前
  // 同步把项目登记好，使覆盖它的下一轮成功——旧实现会把下一轮的成功当成第一轮的结果，这里必须不掩盖。
  const ERR2 = "err-race2";
  const pe1 = discoveryMod.requestSyncScan({ projectId: ERR2, dataDir, submitter: service });
  const pe2 = discoveryMod.requestSyncScan({ projectId: ERR2, dataDir, submitter: service }); // 排定下一轮
  const fe1 = settledFlag(pe1);
  let pe1Error = "";
  pe1.catch((e: unknown) => { pe1Error = e instanceof Error ? e.message : String(e); });
  const ER = project(ERR2, "错误语义夹具");
  const eSource = "reports/source.md";
  write(path.join(ER.root, eSource), "错误语义来源。\n");
  const eTargetRel = "reports/e.md";
  write(path.join(ER.root, eTargetRel), "错误语义目标。\n");
  const eContract = contractMod.validateSyncContract({
    schema_version: 1, batch_id: "e1", project_id: ERR2, title: "批次 e1",
    sources: [{ path: eSource, sha256: sha256(fs.readFileSync(path.join(ER.root, eSource))) }],
    items: [{ id: "src", label: "目标", required: true, check: { type: "file_hash", path: eTargetRel, sha256: sha256(fs.readFileSync(path.join(ER.root, eTargetRel))) } }],
    blocks_entry: false,
  });
  {
    const cmd = syncMod.buildRegisterContractCommand({ projectId: ERR2, changeId: CHG, actorId: "fixture", role: "coordinator", contract: eContract, expectedRevision: null });
    const rec = service.submit(cmd);
    if (!rec.ok || rec.projection.state !== "applied") throw new Error("e1 登记失败");
  }
  write(path.join(ER.inbox, "e1.evidence.json"), `${JSON.stringify({ schema_version: 1, batch_id: "e1", project_id: ERR2, contract_sha256: contractMod.syncContractSha256(eContract), completed: true, items: [{ id: "src", result: "passed", artifacts: [{ path: eTargetRel, sha256: sha256(fs.readFileSync(path.join(ER.root, eTargetRel))) }] }] }, null, 2)}\n`);
  const pe2Result = (await pe2) as { report: { project_id: string } };
  await tick();
  ok(fe1.done && /项目不存在/.test(pe1Error), "G-11 本轮抛错**如实抛回本轮请求**，不被后轮成功掩盖", { pe1Error, done: fe1.done });
  ok(pe2Result.report.project_id === ERR2, "G-12 排定的补跑轮照常执行（下一轮成功）");
  ok(entityEventCount(ER.workDir, "sync:e1") >= 1, "G-13 排定的补跑轮写入核验事件（补跑不丢）", { e1: entityEventCount(ER.workDir, "sync:e1") });

  // ═══ H 不变输入重复读取可复用 + 同长度保留 mtime 的目标改写立即反映 ═══
  graphCalls = 0;
  const repH1 = syncMod.readSyncStatus(PID, dataDir);
  const h1Calls = graphCalls;
  graphCalls = 0;
  const repH2 = syncMod.readSyncStatus(PID, dataDir);
  const h2Calls = graphCalls;
  ok(h1Calls <= 1 && h2Calls <= 1, "H-1 每次读取的六图构建次数有界（现行批次不多建）", { h1Calls, h2Calls });
  ok(JSON.stringify(stripTimes(repH1)) === JSON.stringify(stripTimes(repH2)), "H-2 不变输入重复读取结果等价（可复用的稳定读数）");

  // 同长度保留 mtime 的目标改写：现行批次必须立即反映
  const activeBefore = fs.readFileSync(ACTIVE_ABS);
  const sameLen = activeBefore.toString("utf8").replace("原样", "改写");
  ok(Buffer.byteLength(sameLen) === activeBefore.length && sameLen !== activeBefore.toString("utf8"), "H-3 同长度目标改写夹具成立");
  const fixed = new Date("2026-10-03T00:00:00.000Z");
  fs.utimesSync(ACTIVE_ABS, fixed, fixed);
  fs.writeFileSync(ACTIVE_ABS, sameLen);
  fs.utimesSync(ACTIVE_ABS, fixed, fixed);
  ok(batchOf(syncMod.readSyncStatus(PID, dataDir), "a1")?.verdict !== "passed", "H-4 同长度且保留 mtime 的现行目标改写 → 立即非 passed（不按长度/时间戳判定）");
  fs.writeFileSync(ACTIVE_ABS, activeBefore);
  fs.utimesSync(ACTIVE_ABS, fixed, fixed);
  ok(batchOf(syncMod.readSyncStatus(PID, dataDir), "a1")?.verdict === "passed", "H-5 复原目标 → 重新 passed", { verdict: batchOf(syncMod.readSyncStatus(PID, dataDir), "a1")?.verdict });

  // ═══ I 剖析对照：默认增量读 vs `liveHistorical`（＝旧口径对历史批次实时求值）在同一夹具同一输入下的读取量 ═══
  const measure = (live: boolean): { ms: number; histReads: number; ledgerReads: number; bytes: number; report: any } => {
    readLog = [];
    counting = true;
    const t0 = performance.now();
    const report = syncMod.readSyncStatus(PID, dataDir, live ? { liveHistorical: true } : {});
    const ms = performance.now() - t0;
    counting = false;
    return {
      ms,
      histReads: readsOf(HIST_ABS),
      ledgerReads: readLog.filter((r) => r.p.endsWith("events.jsonl")).length,
      bytes: readLog.reduce((a, r) => a + Math.max(0, r.bytes), 0),
      report,
    };
  };
  const inc = measure(false);
  const live = measure(true);
  ok(inc.histReads === 0 && live.histReads > 0, "I-1 增量读**一次都不读**历史批次目标；显式实时复查读（对照可测，不是空断言）", { incHistReads: inc.histReads, liveHistReads: live.histReads });
  ok(inc.bytes < live.bytes, "I-2 同一夹具同一输入：增量读的总读取字节少于实时复查（省下的是历史批次的目标/来源/图输入读取）", { incBytes: inc.bytes, liveBytes: live.bytes });
  ok(
    live.report.batches.find((b: any) => b.batch_id === "h1")?.items?.every((i: any) => i.actual !== null) === true &&
      live.report.batches.find((b: any) => b.batch_id === "h1")?.historical === false,
    "I-3 显式实时复查确实做了实时求值（actual 非空、historical=false）——入口保留且语义自洽",
  );
  const evBeforeLive = syncEvents(A.workDir).length;
  const live2 = measure(true);
  ok(syncEvents(A.workDir).length === evBeforeLive, "I-4 显式实时复查**不回写任何事件**（历史不被改写；receipt 与 live 复核是两件事）");
  const h1live = live2.report.batches.find((b: any) => b.batch_id === "h1");
  ok(
    h1live?.active === false && h1live?.historical === false && h1live?.verified_at === null,
    "I-5 实时复查行：active=false、historical=false、verified_at=null（如实区分回执展示与本次实时核验，UI 按 active 归历史组）",
    { active: h1live?.active, historical: h1live?.historical, verified_at: h1live?.verified_at },
  );
  info(
    `  I 段（夹具 ${HIST_COUNT + 2} 批：1 现行 + ${HIST_COUNT + 1} 历史）：默认 ${Math.round(inc.ms)}ms／读取 ${inc.bytes}B／账本 ${inc.ledgerReads} 次；` +
      `实时复查 ${Math.round(live.ms)}ms／读取 ${live.bytes}B／账本 ${live.ledgerReads} 次（历史目标读 ${inc.histReads} vs ${live.histReads} 次）`,
  );

  // ═══ J 回执校验：缺项/不一致的旧回执不得展示 passed，且历史损坏不升级成报告级阻断 ═══
  const rawAll = fs.readFileSync(eventStoreMod.eventsPath(A.workDir), "utf8");
  const allLines = rawAll.split("\n").filter((l) => l.trim() !== "");
  const parsedAll = allLines.map((l) => JSON.parse(l) as Record<string, unknown>);
  const anyEvidence = parsedAll.find((e) => e.type === "sync.evidence_checked");
  const maxSeq = Math.max(...parsedAll.map((e) => Number(e.seq)));
  if (anyEvidence !== undefined) {
    const nowIso = new Date().toISOString();
    const crafted = {
      ...anyEvidence,
      seq: maxSeq + 1,
      entity_id: "sync:h0",
      entity_revision: 2,
      event_id: crypto.randomUUID(),
      idempotency_key: `crafted-missing-${crypto.randomBytes(4).toString("hex")}`,
      occurred_at: nowIso,
      received_at: nowIso,
      // 结构合法但**缺必需项 src**、overall 却写 passed —— 旧实现会照 overall 展示 passed。
      // target_fingerprint 给合法 64hex，使本用例只暴露「缺项/overall」而不被指纹校验顺带命中（有效前置）。
      payload: { batch_id: "h0", contract_sha256: h0reg.sha, evidence_sha256: null, evidence_path: null, overall: "passed", target_fingerprint: sha256("j-missing-item-target"), items: [{ id: "graph", required: false, verdict: "passed" }] },
    };
    fs.appendFileSync(eventStoreMod.eventsPath(A.workDir), `${JSON.stringify(crafted)}\n`);
    const repJ = syncMod.readSyncStatus(PID, dataDir);
    const h0J = batchOf(repJ, "h0");
    ok(h0J?.historical === true && h0J?.verdict !== "passed", "J-1 缺必需项的旧回执**不展示 passed**（缺项/overall 按契约拒绝）", { verdict: h0J?.verdict });
    ok(h0J?.verified_at === null, "J-2 不可用回执不冒充已核验（verified_at=null）", { verified_at: h0J?.verified_at });
    ok((h0J?.items?.[0]?.reasons ?? []).some((r: string) => /回执不可用|缺|不一致/.test(r)), "J-3 逐项原因说明回执不可用", h0J?.items?.[0]?.reasons);
    ok(batchOf(repJ, "a1")?.verdict === "passed" && repJ.overall === "passed", "J-4 历史回执损坏**不升级成报告级阻断**（当前 active 照常 passed，与认领口径一致）", { overall: repJ.overall, scan_error: repJ.scan_error });
  } else {
    ok(false, "J-0 夹具应含真实 sync.evidence_checked 事件");
  }
  fs.writeFileSync(eventStoreMod.eventsPath(A.workDir), rawAll);

  // ═══ J2 历史回执身份/指纹：实体↔payload 必须一致、target_fingerprint 必须 64 位小写十六进制 ═══
  // 复用 J 的夹具（h0 无回执、h2 有真实 passed 回执）。逐条构造账本事件并读回，覆盖：
  //   · 实体↔payload 身份冲突 → 定位到**已登记**批次（实体槽优先），记坏事实、不静默遗漏；
  //   · payload 指未知/别批 → **不污染**别批真实回执；
  //   · 缺/非法 target_fingerprint → 不可 passed；
  //   · 最后一条坏记录**不退回**更早的绿色；
  //   · 可信记录里 overall=invalid 逐项保留真实结论；
  //   · 历史坏回执只影响展示，当前 active 门禁不新增阻断。
  const rawAllJ2 = fs.readFileSync(eventStoreMod.eventsPath(A.workDir), "utf8");
  const FINGERPRINT = sha256("directed-target-fingerprint");
  const h0ReceiptItems = [
    { id: "src", required: true, verdict: "passed" },
    { id: "graph", required: false, verdict: "passed" },
  ];
  const baseH0Payload = (): Record<string, unknown> => ({
    batch_id: "h0", contract_sha256: h0reg.sha, evidence_sha256: null, evidence_path: null,
    overall: "passed", target_fingerprint: FINGERPRINT, items: h0ReceiptItems,
  });
  const appendReceipt = (entityId: string, payload: Record<string, unknown>): void => {
    const lines = fs.readFileSync(eventStoreMod.eventsPath(A.workDir), "utf8").split("\n").filter((l) => l.trim() !== "");
    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    const maxSeq = Math.max(...parsed.map((e) => Number(e.seq)));
    const prevRev = Math.max(0, ...parsed.filter((e) => e.entity_id === entityId).map((e) => Number(e.entity_revision)));
    const nowIso = new Date().toISOString();
    const ev = {
      ...(anyEvidence as Record<string, unknown>),
      seq: maxSeq + 1, entity_id: entityId, entity_revision: prevRev + 1,
      event_id: crypto.randomUUID(), idempotency_key: `directed-${crypto.randomBytes(6).toString("hex")}`,
      occurred_at: nowIso, received_at: nowIso, payload,
    };
    fs.appendFileSync(eventStoreMod.eventsPath(A.workDir), `${JSON.stringify(ev)}\n`);
  };
  const h0Row = (): any => batchOf(syncMod.readSyncStatus(PID, dataDir), "h0");
  const h0Reason = (): string => (h0Row()?.items?.[0]?.reasons ?? []).join(" ");

  appendReceipt("sync:h0", baseH0Payload());
  ok(h0Row()?.verdict === "passed" && typeof h0Row()?.verified_at === "string", "J2-1 合法历史回执（身份一致、64hex 指纹、逐项合契约）→ passed（夹具前置）", { verdict: h0Row()?.verdict, verified_at: h0Row()?.verified_at });

  // 实体 sync:h0 / payload 指已登记别批 h2：必须按实体定位到 h0 记坏事实，且不污染 h2 的真实回执
  appendReceipt("sync:h0", { ...baseH0Payload(), batch_id: "h2" });
  ok(h0Row()?.verdict !== "passed" && h0Row()?.verified_at === null, "J2-2 实体↔payload 身份冲突 → 本实体行不 passed（坏事实不静默遗漏）", { verdict: h0Row()?.verdict, reason: h0Reason() });
  ok(/身份|不一致/.test(h0Reason()), "J2-3 身份冲突有明确原因（不冒充通过、也不无声丢弃）", h0Reason());
  ok(batchOf(syncMod.readSyncStatus(PID, dataDir), "h2")?.verdict === "passed", "J2-4 payload 指别批**不污染**别批真实回执（h2 仍 passed）", { h2: batchOf(syncMod.readSyncStatus(PID, dataDir), "h2")?.verdict });

  // 实体 sync:h0 / payload 指未知批：不得退化成「无回执(missing)」的静默遗漏，须显式 invalid
  appendReceipt("sync:h0", { ...baseH0Payload(), batch_id: "ghost-directed" });
  ok(h0Row()?.verdict === "invalid", "J2-5 payload 指未知批、实体指已登记批 → 显式 invalid（不静默遗漏成 missing）", { verdict: h0Row()?.verdict, reason: h0Reason() });

  // 缺 / 非法 target_fingerprint → 不可 passed
  appendReceipt("sync:h0", { ...baseH0Payload(), target_fingerprint: undefined });
  ok(h0Row()?.verdict !== "passed", "J2-6 缺 target_fingerprint 的历史回执不得 passed", { verdict: h0Row()?.verdict, reason: h0Reason() });
  appendReceipt("sync:h0", { ...baseH0Payload(), target_fingerprint: "not-a-sha256" });
  ok(h0Row()?.verdict !== "passed" && /target_fingerprint|指纹/.test(h0Reason()), "J2-7 非法 target_fingerprint（非 64hex）的历史回执不得 passed，并点名原因", { verdict: h0Row()?.verdict, reason: h0Reason() });

  // 不得回退更早 passed：先写合法绿，再叠一条坏的（更高 seq）——最后一条坏记录不退回旧绿
  appendReceipt("sync:h0", baseH0Payload());
  const afterGreen = h0Row()?.verdict;
  appendReceipt("sync:h0", { ...baseH0Payload(), items: [{ id: "src", required: true, verdict: "failed" }, { id: "graph", required: false, verdict: "passed" }] });
  ok(afterGreen === "passed" && h0Row()?.verdict !== "passed", "J2-8 最后一条坏回执**不退回**更早的 passed（不留旧绿顶替）", { afterGreen, now: h0Row()?.verdict });

  // 可信记录里 overall=invalid 逐项保留真实历史结论（不因 overall=invalid 就把逐项改判）
  appendReceipt("sync:h0", { ...baseH0Payload(), overall: "invalid" });
  const h0inv = h0Row();
  ok(h0inv?.verdict === "invalid" && h0inv?.items?.find((i: any) => i.id === "src")?.verdict === "passed", "J2-9 可信历史 overall=invalid 保持 invalid，且逐项保留真实结论（src 仍 passed）", { verdict: h0inv?.verdict, src: h0inv?.items?.find((i: any) => i.id === "src")?.verdict });

  ok(batchOf(syncMod.readSyncStatus(PID, dataDir), "a1")?.verdict === "passed" && syncMod.readSyncStatus(PID, dataDir).overall === "passed", "J2-10 历史坏/异形回执**不新增当前门禁**（active a1 与 overall 照常 passed）");
  fs.writeFileSync(eventStoreMod.eventsPath(A.workDir), rawAllJ2);

  // ═══ K 历史增长边界：100 历史 + 1 现行不拖死当前；未知超限仍 fail-closed ═══
  const KD = path.join(tmpBase, "k-home");
  mkdirp(KD);
  const kProject = (dataDir: string, id: string, name: string): { root: string; workDir: string; inbox: string } => {
    const root = path.join(tmpBase, id);
    const workDir = path.join(root, ".工作台", "work");
    const inbox = path.join(workDir, "sync-inbox");
    mkdirp(inbox);
    mkdirp(path.join(root, ".工作台", "arch"));
    write(path.join(root, ".工作台", "design.md"), `# ${name} 设计\n\n## 1 目标\n\n正文\n`);
    write(path.join(root, ".工作台", "plan.md"), `# ${name} 施工\n\n| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |\n| --- | --- | --- | --- | --- |\n| T-1 | todo | 卡 |  | 证据 |\n\n### T-1 卡\n\n**设计依据**：§1。**依赖**：无。**文件责任**：\`src/t.ts\`。**责任角色**：executor。\n\n- [ ] 达标\n`);
    writeJson(path.join(root, ".工作台", "arch", "modules.json"), { version: 1, generated_at: "2026-10-03T00:00:00.000Z", budget_exhausted: false, modules: [{ id: "src", path: "src", file_count: 1, loc: 0, deps: [] }] });
    registryMod.addProject({ id, name, path: root, kind: "backend" }, dataDir);
    return { root, workDir, inbox };
  };
  const KP = kProject(KD, "k-bulk", "批量夹具");
  const Kservice = new serviceMod.WorkService({ dataDir: KD });
  const kTargetRel = "reports/k.md";
  const kSourceRel = "reports/ksrc.md";
  write(path.join(KP.root, kTargetRel), "批量目标。\n");
  write(path.join(KP.root, kSourceRel), "批量来源。\n");
  const kSha = (rel: string): string => sha256(fs.readFileSync(path.join(KP.root, rel)));
  const kRegister = (batchId: string, extra: Record<string, unknown> = {}): string => {
    const contract = contractMod.validateSyncContract({
      schema_version: 1, batch_id: batchId, project_id: "k-bulk", title: `批次 ${batchId}`,
      sources: [{ path: kSourceRel, sha256: kSha(kSourceRel) }],
      items: [{ id: "src", label: "目标", required: true, check: { type: "file_hash", path: kTargetRel, sha256: kSha(kTargetRel) } }],
      blocks_entry: false, ...extra,
    });
    const cmd = syncMod.buildRegisterContractCommand({ projectId: "k-bulk", changeId: CHG, actorId: "fixture", role: "coordinator", contract, expectedRevision: null });
    const rec = Kservice.submit(cmd);
    if (!rec.ok || rec.projection.state !== "applied") throw new Error(`k 登记 ${batchId} 失败`);
    return contractMod.syncContractSha256(contract);
  };
  let kPrev = "";
  for (let i = 1; i <= 100; i++) {
    const id = `h${i}`;
    kRegister(id, kPrev === "" ? {} : { supersedes: kPrev });
    kPrev = id;
    write(path.join(KP.inbox, `${id}.evidence.json`), `{"note":"历史文件 ${i}（不参与当前核验）"}\n`);
  }
  const ka1sha = kRegister("a1", { supersedes: "h100" });
  write(path.join(KP.inbox, "a1.evidence.json"), `${JSON.stringify({ schema_version: 1, batch_id: "a1", project_id: "k-bulk", contract_sha256: ka1sha, completed: true, items: [{ id: "src", result: "passed", artifacts: [{ path: kTargetRel, sha256: kSha(kTargetRel) }] }] }, null, 2)}\n`);
  const repK = syncMod.readSyncStatus("k-bulk", KD);
  ok(repK.collection.complete === true, "K-1 100 历史 + 1 现行：收件范围仍取齐（历史退出当前发现预算，不截断）", { reasons: repK.collection.reasons });
  ok(repK.overall === "passed", "K-2 现行批次照常通过，历史积累不拖死当前", { overall: repK.overall, scan_error: repK.scan_error });
  ok(repK.batches.filter((b) => b.active).length === 1 && repK.batches.length === 101, "K-3 全部批次可见（101），只 1 现行计入结论", { total: repK.batches.length, active: repK.batches.filter((b) => b.active).length });
  // 损坏契约不得用来排除历史：坏 payload → historicalBatchIds 返回 null（不豁免任何文件）
  const kRaw = fs.readFileSync(eventStoreMod.eventsPath(KP.workDir), "utf8");
  const kLines = kRaw.split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as Record<string, unknown>);
  const kLastSeq = Math.max(...kLines.map((e) => Number(e.seq)));
  const kBase = kLines.find((e) => e.type === "sync.contract_registered");
  if (kBase !== undefined) {
    const badEvent = {
      ...kBase,
      seq: kLastSeq + 1,
      entity_id: "sync:badbatch",
      entity_revision: 1,
      event_id: crypto.randomUUID(),
      idempotency_key: `bad-${crypto.randomBytes(4).toString("hex")}`,
      occurred_at: new Date().toISOString(),
      received_at: new Date().toISOString(),
      payload: { schema_version: 1, batch_id: "badbatch", project_id: "k-bulk", title: "坏", sources: [], items: [] },
    };
    fs.appendFileSync(eventStoreMod.eventsPath(KP.workDir), `${JSON.stringify(badEvent)}\n`);
    ok(syncMod.historicalBatchIds("k-bulk", KD) === null, "K-4 契约域坏事实 → historicalBatchIds=null（损坏契约不得用来排除历史出当前预算）");
    fs.writeFileSync(eventStoreMod.eventsPath(KP.workDir), kRaw);
  } else {
    ok(false, "K-4 夹具应含 k 契约登记事件");
  }
  // 后台发现：100 个历史文件不触发 64 上限 fail-closed
  serviceMod.writeServiceDescriptor(KD, { schema_version: 2, pid: process.pid, host: "127.0.0.1", port: 4399, token: "tok-k", started_at: new Date().toISOString(), url: "http://127.0.0.1:4399" });
  discoveryMod.startSyncDiscovery({ service: { submit: (c: unknown) => Kservice.submit(c) }, dataDir: KD, token: "tok-k" });
  for (let i = 0; i < 60 && syncMod.readProjectDiscoveryIssues("k-bulk", KD).some((s) => /超过有界轮询指纹上限/.test(s)); i++) await tick(20);
  const kIssues = syncMod.readProjectDiscoveryIssues("k-bulk", KD);
  ok(!kIssues.some((s) => /超过有界轮询指纹上限/.test(s)), "K-5 100 个历史文件**不**触发发现上限 fail-closed（历史不计入当前发现预算）", kIssues);
  ok(syncMod.readSyncStatus("k-bulk", KD).overall === "passed", "K-6 后台健康不把当前 active 判 incomplete", syncMod.readSyncStatus("k-bulk", KD).scan_error);

  // 未知（未登记）文件超限：仍 fail-closed，不因历史豁免而放行
  const KU = kProject(KD, "k-unknown", "未知夹具");
  const uTargetRel = "reports/u.md";
  const uSourceRel = "reports/usrc.md";
  write(path.join(KU.root, uTargetRel), "未知目标。\n");
  write(path.join(KU.root, uSourceRel), "未知来源。\n");
  const uContract = contractMod.validateSyncContract({
    schema_version: 1, batch_id: "u1", project_id: "k-unknown", title: "未知批次",
    sources: [{ path: uSourceRel, sha256: sha256(fs.readFileSync(path.join(KU.root, uSourceRel))) }],
    items: [{ id: "src", label: "目标", required: true, check: { type: "file_hash", path: uTargetRel, sha256: sha256(fs.readFileSync(path.join(KU.root, uTargetRel))) } }],
    blocks_entry: false,
  });
  {
    const cmd = syncMod.buildRegisterContractCommand({ projectId: "k-unknown", changeId: CHG, actorId: "fixture", role: "coordinator", contract: uContract, expectedRevision: null });
    const rec = Kservice.submit(cmd);
    if (!rec.ok || rec.projection.state !== "applied") throw new Error("u 登记失败");
  }
  write(path.join(KU.inbox, "u1.evidence.json"), `${JSON.stringify({ schema_version: 1, batch_id: "u1", project_id: "k-unknown", contract_sha256: contractMod.syncContractSha256(uContract), completed: true, items: [{ id: "src", result: "passed", artifacts: [{ path: uTargetRel, sha256: sha256(fs.readFileSync(path.join(KU.root, uTargetRel))) }] }] }, null, 2)}\n`);
  for (let i = 1; i <= 65; i++) write(path.join(KU.inbox, `u${i}.evidence.json`), "{}\n");
  for (let i = 0; i < 150 && !syncMod.readProjectDiscoveryIssues("k-unknown", KD).some((s) => /超过有界轮询指纹上限/.test(s)); i++) await tick(20);
  const kuIssues = syncMod.readProjectDiscoveryIssues("k-unknown", KD);
  ok(kuIssues.some((s) => /超过有界轮询指纹上限/.test(s)), "K-7 65 个未知文件仍 fail-closed 报发现上限（未知不享历史豁免，不截断报通过）", kuIssues);
  ok(syncMod.readSyncStatus("k-unknown", KD).overall !== "passed", "K-8 未知超限时当前 active 不判 passed", { overall: syncMod.readSyncStatus("k-unknown", KD).overall });
  await discoveryMod.stopSyncDiscovery();

  // ═══ L 构建期间输入变动 → 明确过期（不把旧事件快照配新身份判 passed；只有1active时也不会没下一批就放行） ═══
  const LP = kProject(KD, "l-graph", "过期夹具");
  const lSrcRel = "reports/source.md";
  write(path.join(LP.root, lSrcRel), "过期来源。\n");
  const lContract = contractMod.validateSyncContract({
    schema_version: 1, batch_id: "l1", project_id: "l-graph", title: "过期批次",
    sources: [{ path: lSrcRel, sha256: sha256(fs.readFileSync(path.join(LP.root, lSrcRel))) }],
    items: [{ id: "graph", label: "六图", required: true, check: { type: "graph_full", expected_baseline_id: "bl-incr" } }],
    blocks_entry: false,
  });
  {
    const cmd = syncMod.buildRegisterContractCommand({ projectId: "l-graph", changeId: CHG, actorId: "fixture", role: "coordinator", contract: lContract, expectedRevision: null });
    const rec = Kservice.submit(cmd);
    if (!rec.ok || rec.projection.state !== "applied") throw new Error("l 登记失败");
  }
  const witness = path.join(LP.root, ".工作台", "arch", "witness.txt");
  write(witness, "w0\n");
  write(path.join(LP.inbox, "l1.evidence.json"), `${JSON.stringify({ schema_version: 1, batch_id: "l1", project_id: "l-graph", contract_sha256: contractMod.syncContractSha256(lContract), completed: true, items: [{ id: "graph", result: "passed", artifacts: [{ path: lSrcRel, sha256: sha256(fs.readFileSync(path.join(LP.root, lSrcRel))) }] }] }, null, 2)}\n`);
  const realSourceProbe = probeMod.syncGraphSourceProbe();
  probeMod.registerSyncGraphSourceProbe(() => ({ ok: true, baseline_id: "bl-incr", baseline_valid: true, design_revision: "d1", plan_revision: "p1", plan_definition_revision: "pd1", graph_inputs: { witness: sha256(fs.readFileSync(witness)) }, graph_input_problems: [], graph_input_verdict: null, reasons: [] }));
  let mutateDuringBuild = true;
  probeMod.registerSyncGraphProbe(() => {
    if (mutateDuringBuild) { mutateDuringBuild = false; write(witness, "w-changed-during-build\n"); }
    return { ok: true, verdict: "passed", baseline_id: "bl-incr", baseline_valid: true, design_revision: "d1", plan_revision: "p1", plan_definition_revision: "pd1", graph_inputs: {}, graph_input_problems: [], availability: "published", update_state: null, collection_status: "complete", complete: true, anomalies: [], reasons: [] };
  });
  const repL = syncMod.readSyncStatus("l-graph", KD);
  const lBatch = batchOf(repL, "l1");
  const lItem = lBatch?.items.find((i: any) => i.id === "graph");
  ok(lItem?.verdict !== "passed" && (lItem?.reasons ?? []).some((r: string) => /构建期间/.test(r)), "L-1 构建期间外部输入改变 → 本轮结果**明确过期**（graph_full 非 passed，不把旧快照配新身份）", { verdict: lItem?.verdict, reasons: lItem?.reasons });
  ok(lBatch?.verdict !== "passed", "L-2 唯一现行批次的结论非 passed（只有 1 active、无下一批触发重算也不放行旧的）", { verdict: lBatch?.verdict });
  probeMod.registerSyncGraphProbe(realProbe);
  if (realSourceProbe !== null) probeMod.registerSyncGraphSourceProbe(realSourceProbe);

  // ═══ M 停机跟踪：stop 等待在途/排队扫描，返回后不再新增写入 ═══
  const KD2 = path.join(tmpBase, "stop-home");
  mkdirp(KD2);
  const SP = kProject(KD2, "stop-proj", "停机夹具");
  const spSourceRel = "reports/source.md";
  const spTargetRel = "reports/t.md";
  write(path.join(SP.root, spSourceRel), "停机来源。\n");
  write(path.join(SP.root, spTargetRel), "停机目标。\n");
  const spService = new serviceMod.WorkService({ dataDir: KD2 });
  const spContract = (batchId: string): ReturnType<typeof contractMod.validateSyncContract> => contractMod.validateSyncContract({
    schema_version: 1, batch_id: batchId, project_id: "stop-proj", title: `批次 ${batchId}`,
    sources: [{ path: spSourceRel, sha256: sha256(fs.readFileSync(path.join(SP.root, spSourceRel))) }],
    items: [{ id: "src", label: "目标", required: true, check: { type: "file_hash", path: spTargetRel, sha256: sha256(fs.readFileSync(path.join(SP.root, spTargetRel))) } }],
    blocks_entry: false,
  });
  const spRegister = (batchId: string): void => {
    const cmd = syncMod.buildRegisterContractCommand({ projectId: "stop-proj", changeId: CHG, actorId: "fixture", role: "coordinator", contract: spContract(batchId), expectedRevision: null });
    const rec = spService.submit(cmd);
    if (!rec.ok || rec.projection.state !== "applied") throw new Error(`stop ${batchId} 登记失败`);
  };
  const spEvidence = (batchId: string): void => {
    write(path.join(SP.inbox, `${batchId}.evidence.json`), `${JSON.stringify({ schema_version: 1, batch_id: batchId, project_id: "stop-proj", contract_sha256: contractMod.syncContractSha256(spContract(batchId)), completed: true, items: [{ id: "src", result: "passed", artifacts: [{ path: spTargetRel, sha256: sha256(fs.readFileSync(path.join(SP.root, spTargetRel))) }] }] }, null, 2)}\n`);
  };
  const evidenceEvents = (wd: string, entity: string): number => syncEvents(wd).filter((e) => e.entity_id === entity && e.type === "sync.evidence_checked").length;
  spRegister("s1"); spEvidence("s1");
  let spFirst = true;
  let spEntered: () => void = () => {};
  const spEnteredP = new Promise<void>((res) => { spEntered = res; });
  let spRelease: () => void = () => {};
  const spGate = new Promise<void>((res) => { spRelease = res; });
  const spSubmitter = {
    submit: async (c: unknown) => {
      if (spFirst) { spFirst = false; spEntered(); await spGate; }
      return spService.submit(c);
    },
  };
  serviceMod.writeServiceDescriptor(KD2, { schema_version: 2, pid: process.pid, host: "127.0.0.1", port: 4400, token: "tok-stop", started_at: new Date().toISOString(), url: "http://127.0.0.1:4400" });
  discoveryMod.startSyncDiscovery({ service: spSubmitter, dataDir: KD2, token: "tok-stop" });
  await spEnteredP; // round1 已进入 submit（在途、被闸门挡住）
  spRegister("s2"); spEvidence("s2"); // 收件目录指纹变化 → 防抖后 fireScan 排定 round2（进入 rt.inflight）
  await tick(3000); // 等轮询(2s)+防抖(0.4s)把 round2 排进在途集合
  const stopP = discoveryMod.stopSyncDiscovery(); // 立即置 stopped，等在途/排队全部收尾
  await tick(150);
  spRelease(); // 放行 round1 → 排定的 round2 启动
  await stopP;
  ok(discoveryMod.syncDiscoveryStatus().running === false, "M-1 stop 返回后后台发现已停（不再新增发现）");
  ok(evidenceEvents(SP.workDir, "sync:s2") >= 1, "M-2 stop **等待了排队的补跑轮**（停机不漏补跑：stop 期间 round2 真正跑完并写入）", { s2: evidenceEvents(SP.workDir, "sync:s2") });
  const spAfterStop = evidenceEvents(SP.workDir, "sync:s1") + evidenceEvents(SP.workDir, "sync:s2");
  await tick(700);
  ok(evidenceEvents(SP.workDir, "sync:s1") + evidenceEvents(SP.workDir, "sync:s2") === spAfterStop, "M-3 stop 返回后不再新增扫描写入（不重启）");

  info(`\n[verify] 结果：PASS ${passCount} · FAIL ${failCount}`);
  if (failCount === 0) info("[verify] 全部通过：sync 增量核验专项回归");
}

function stripTimes(v: any): any {
  if (Array.isArray(v)) return v.map(stripTimes);
  if (v !== null && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (k !== "checked_at" && k !== "verified_at") o[k] = stripTimes(x);
    return o;
  }
  return v;
}

void main().catch((e) => {
  console.error(`[verify] 夹具/脚本异常：${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  process.exitCode = 1;
});
