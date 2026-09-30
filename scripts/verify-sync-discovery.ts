// 同步证据「后台发现生命周期」专项验证（PLAN V09-23 返工B；DESIGN.md §2.10；docs/sync-evidence-contract.md）。
//
// ⚠ 本脚本按规范**独立写成、先红后绿**：先在当前候选实现上跑出清楚的**行为红**（每段独立跑，
// 缺模块/缺字段如实记 FAIL 而不整脚本中断），再照规范修实现把它转绿。
//
// 覆盖（B 返工范围：只修后台发现生命周期，不碰 A 的判定/写侧/门禁）：
//   S1 syncRuntimeHealth 组合接口（精确命名/零依赖/不另造账本/null 语义/dataDir 隔离）
//   S2 唯一写服务描述符确认为本 PID 之后才 start（非本 PID 不启动）
//   S3 单飞 key 含规范 dataDir+project（隔离夹具不串；同 dataDir 同项目真单飞）
//   S4 按项目防抖（不是每个 event 新增 timer）+ 重复通知零事件
//   S5 启动扫既有包 / 未选项目也发现 / 晚出现包自动发现（无手动 scan/重启/重新注册）
//   S6 注册表：初始不存在后创建、新增项目、路径变更（旧 watcher 关闭不误写）、注销
//   S7 错误/上限不静默：health 可见（全局与项目级）、修好后清除
//   S8 stop 清 watch/timer 并 await 在途；await stop 后无更多写；restart 无残留
//   S9 真实隔离服务测试：spawn 真 daemon（描述符=本 PID 才扫、未选项目发现、重复通知零事件、退出无残留）
//   S10 stop **真正等到**全部在途扫描终止（超旧 10s 窗口不提前返回、返回后零晚写、零队列残留）
//   S11 收件目录非 ENOENT 读失败（ENOTDIR 真实现场；stat EACCES 确定性注入）→ 显式 health 失败，不用 gone 吞
//   S12 证据文件数 >64（128 个）→ 达到有界轮询上限即显式 fail-closed（不截断后报 passed）
//
// 隔离口径（AGENTS.md §5）：mkdtemp 夹具 + 隔离 TATAI_HOME + 本进程内唯一写服务；不碰真实 ~/.tatai、
// 不碰真实项目与账本、不装不改纳管项目、不打印 token、不调模型/不发外网、不新增依赖；收尾删临时目录。
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
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
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const waitFor = async (cond: () => boolean, ms: number, step = 100): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(step);
  }
  return cond();
};
const sha256 = (d: string | Buffer): string => crypto.createHash("sha256").update(d).digest("hex");
const sha256File = (f: string): string => sha256(fs.readFileSync(f));
const mkdirp = (d: string): void => { fs.mkdirSync(d, { recursive: true }); };
const write = (f: string, t: string): void => { mkdirp(path.dirname(f)); fs.writeFileSync(f, t, "utf8"); };
const writeJson = (f: string, v: unknown): void => write(f, `${JSON.stringify(v, null, 2)}\n`);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");
const DAEMON_ENTRY = path.join(SRC, "server", "work", "daemon.ts");
const loadSrc = async <T>(rel: string): Promise<T> => (await import(pathToFileURL(path.join(SRC, rel)).href)) as T;

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-sync-disc-"));
let homeSeq = 0;
const NEW = (name: string): string => { const d = path.join(tmpBase, "homes", `${name}-${++homeSeq}`); mkdirp(d); return d; };

// ── 夹具：项目根 / 契约 / 证据包 ──

interface Proj { id: string; root: string; workDir: string; inbox: string; proofRel: string; proofAbs: string; targetRel: string; targetAbs: string; parentId: string }

function makeProj(parentId: string, id: string): Proj {
  const root = path.join(tmpBase, "projects", parentId, id);
  const workDir = path.join(root, ".工作台", "work");
  const proofRel = "docs/proof.md";
  const proofAbs = path.join(root, "docs", "proof.md");
  const targetRel = "docs/target.md";
  const targetAbs = path.join(root, "docs", "target.md");
  write(proofAbs, `# 证据材料\n\n夹具原始工作范围文件（字节与项目 id 无关，便于建模"项目搬到新路径"）。\n`);
  write(targetAbs, `# 独立目标\n\n夹具里被 check 直接读取的目标文件（不是契约来源）。\n`);
  return { id, root, workDir, inbox: path.join(workDir, "sync-inbox"), proofRel, proofAbs, targetRel, targetAbs, parentId };
}

const contractFor = (p: Proj, batchId: string, blocks = false): Record<string, unknown> => ({
  schema_version: 1,
  batch_id: batchId,
  project_id: p.id,
  title: `批次 ${batchId}`,
  sources: [{ path: p.proofRel, sha256: sha256File(p.proofAbs) }],
  items: [
    { id: "i1", label: "来源字节", required: true, check: { type: "file_hash", path: p.proofRel, sha256: sha256File(p.proofAbs) } },
    { id: "i2", label: "独立目标字节", required: true, check: { type: "file_hash", path: p.targetRel, sha256: sha256File(p.targetAbs) } },
  ],
  blocks_entry: blocks,
});

const evidenceFor = (p: Proj, batchId: string, contractSha: string, completed = true): Record<string, unknown> => ({
  schema_version: 1,
  batch_id: batchId,
  project_id: p.id,
  contract_sha256: contractSha,
  completed,
  items: [
    { id: "i1", result: "passed", artifacts: [{ path: p.proofRel, sha256: sha256File(p.proofAbs) }] },
    { id: "i2", result: "passed", artifacts: [{ path: p.targetRel, sha256: sha256File(p.targetAbs) }] },
  ],
});

const postEvidence = (p: Proj, batchId: string, pkg: unknown): void => {
  mkdirp(p.inbox);
  const tmp = path.join(p.inbox, `.${batchId}.evidence.json.tmp-${crypto.randomBytes(3).toString("hex")}`);
  fs.writeFileSync(tmp, typeof pkg === "string" ? pkg : `${JSON.stringify(pkg, null, 2)}\n`);
  fs.renameSync(tmp, path.join(p.inbox, `${batchId}.evidence.json`));
};

const projectRecord = (p: Proj): Record<string, unknown> => ({
  id: p.id, name: p.id, path: p.root, kind: "backend",
  registered_at: new Date().toISOString(), last_opened_at: new Date().toISOString(),
});

const writeDescriptor = (dataDir: string, pid: number, port = 59999): void => {
  writeJson(path.join(dataDir, "work-service.json"), {
    schema_version: 2, pid, host: "127.0.0.1", port, token: "fixture-token-not-printed",
    started_at: new Date().toISOString(), url: `http://127.0.0.1:${port}`,
  });
};

const loadEventsOf = (workDir: string): any[] => eventStoreMod.loadEvents(workDir).events;

const SYNC_SUFFIX = ".evidence.json";
const evidenceCheckedCount = (workDir: string): number =>
  loadEventsOf(workDir).filter((e) => e.type === "sync.evidence_checked").length;
const syncEventCount = (workDir: string): number =>
  loadEventsOf(workDir).filter((e) => e.type.startsWith("sync.")).length;
const contractCount = (workDir: string): number =>
  loadEventsOf(workDir).filter((e) => e.type === "sync.contract_registered").length;

// ── 动态载入被测模块（缺文件 = 行为红，不崩整脚本）──
type Mod = Record<string, any>;
const modCache = new Map<string, Mod | Error>();
const load = async (rel: string): Promise<Mod> => {
  const cached = modCache.get(rel);
  if (cached instanceof Error) throw cached;
  if (cached !== undefined) return cached;
  try {
    const m = (await loadSrc(rel)) as Mod;
    modCache.set(rel, m);
    return m;
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    modCache.set(rel, err);
    throw err;
  }
};

let syncMod: Mod = {};
let registryMod: Mod = {};
let serviceMod: Mod = {};
let discoveryMod: Mod = {};
let eventStoreMod: Mod = {};
let healthMod: Mod | null = null;
const loadErrors: string[] = [];
try { syncMod = await load("server/work/sync.ts"); } catch (e) { loadErrors.push(`sync.ts：${(e as Error).message}`); }
try { registryMod = await load("server/registry.ts"); } catch (e) { loadErrors.push(`registry.ts：${(e as Error).message}`); }
try { serviceMod = await load("server/work/service.ts"); } catch (e) { loadErrors.push(`service.ts：${(e as Error).message}`); }
try { eventStoreMod = await load("server/work/eventStore.ts"); } catch (e) { loadErrors.push(`eventStore.ts：${(e as Error).message}`); }
try { discoveryMod = await load("server/work/syncDiscovery.ts"); } catch (e) { loadErrors.push(`syncDiscovery.ts：${(e as Error).message}`); }
try { healthMod = await load("server/work/syncRuntimeHealth.ts"); } catch (e) { loadErrors.push(`syncRuntimeHealth.ts：${(e as Error).message}`); }
if (loadErrors.length > 0) info(`载入错误（如实记 FAIL）：${loadErrors.join("；")}`);

// ── 夹具服务：一个 dataDir 一份 WorkService ──
interface Svc { dataDir: string; service: any; submitter: { submit: (c: unknown) => unknown } }
const mkSvc = (dataDir: string): Svc => {
  const service = new serviceMod.WorkService({ dataDir });
  return { dataDir, service, submitter: { submit: (c: unknown) => service.submit(c) } };
};

const registerContract = async (svc: Svc, p: Proj, contract: Record<string, unknown>): Promise<any> => {
  const batchId = contract.batch_id as string;
  const cmd = syncMod.buildRegisterContractCommand({
    projectId: p.id, changeId: "chg-disc", actorId: "fixture", role: "designer",
    contract, expectedRevision: syncMod.syncEntityRevision(p.id, svc.dataDir),
  });
  const receipt = (await Promise.resolve(svc.submitter.submit(cmd))) as { ok?: boolean } | null | undefined;
  if (receipt?.ok !== true) throw new Error(`登记失败：${JSON.stringify(receipt).slice(0, 300)}`);
  const sha = syncMod.existingContractSha(p.id, svc.dataDir, batchId);
  if (typeof sha !== "string") throw new Error(`登记后取不到契约哈希：${batchId}`);
  return sha;
};

const drain = async (): Promise<void> => {
  try { await discoveryMod.stopSyncDiscovery?.(); } catch { /* 未启动 */ }
};

// ══════════════════════════════════════════════════════════════════════════════
const runs: [string, () => Promise<void>][] = [];
const sec = (label: string, fn: () => Promise<void>): void => { runs.push([label, fn]); };

// ── S1 health 组合接口 ──
sec("S1 syncRuntimeHealth：精确命名/零依赖/null 语义/dataDir 隔离/不另造账本", async () => {
  const srcPath = path.join(SRC, "server", "work", "syncRuntimeHealth.ts");
  ok(fs.existsSync(srcPath), "S1-0 新增 syncRuntimeHealth.ts（零依赖组合接口单源）");
  if (healthMod === null) return;
  const src = fs.readFileSync(srcPath, "utf8");
  const imports = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
  ok(imports.length === 0 || imports.every((i) => i.startsWith("node:")), "S1-1 零业务依赖（只 import node:*，读口不会回穿六图 builder）", { imports });
  ok(
    !/\b(fs\.)?(writeFileSync|appendFileSync|writeFile|appendFile|createWriteStream|rmSync)\s*\(/.test(src),
    "S1-2 不另造账本、不写文件（只保存宿主内发现错误）",
  );
  ok(
    typeof healthMod.reportSyncDiscoveryIssue === "function" &&
      typeof healthMod.readSyncDiscoveryIssues === "function" &&
      typeof healthMod.clearSyncDiscoveryIssues === "function",
    "S1-3 导出精确命名三函数（reportSyncDiscoveryIssue/readSyncDiscoveryIssues/clearSyncDiscoveryIssues）",
    { keys: Object.keys(healthMod).filter((k) => /SyncDiscovery/.test(k)) },
  );

  const dd = NEW("health-home");
  const GLOBAL = "全局：注册表读不出（夹具）";
  const PROJ = "项目 p1：收件目录监听挂不上（夹具）";
  ok(healthMod.readSyncDiscoveryIssues(dd, "p1").length === 0, "S1-4 初始无错误");
  healthMod.reportSyncDiscoveryIssue(dd, null, GLOBAL);
  healthMod.reportSyncDiscoveryIssue(dd, "p1", PROJ);
  const forP1: string[] = healthMod.readSyncDiscoveryIssues(dd, "p1");
  ok(forP1.includes(GLOBAL) && forP1.includes(PROJ), "S1-5 项目读口含全局＋本项目错误", { forP1 });
  ok(
    healthMod.readSyncDiscoveryIssues(dd, "p2").length === 1 && !healthMod.readSyncDiscoveryIssues(dd, "p2").includes(PROJ),
    "S1-6 别的项目不被本项目单独故障牵连（无配置旧项目不因他项目故障受阻）",
  );
  ok(healthMod.readSyncDiscoveryIssues(dd, null).length === 1, "S1-7 projectId=null 只读全局", { global: healthMod.readSyncDiscoveryIssues(dd, null) });
  healthMod.reportSyncDiscoveryIssue(dd, "p1", null);
  const afterClear: string[] = healthMod.readSyncDiscoveryIssues(dd, "p1");
  ok(!afterClear.includes(PROJ) && afterClear.includes(GLOBAL), "S1-8 null issue＝成功重试后清除该项、全局保留", { afterClear });
  const dd2 = NEW("health-home2");
  ok(healthMod.readSyncDiscoveryIssues(dd2, "p1").length === 0, "S1-9 不同 dataDir 相互隔离（夹具不串）");
  healthMod.clearSyncDiscoveryIssues(dd);
  ok(healthMod.readSyncDiscoveryIssues(dd, null).length === 0 && healthMod.readSyncDiscoveryIssues(dd, "p1").length === 0, "S1-10 clearSyncDiscoveryIssues 清空该 dataDir");
});

// ── S2 宿主所有权门槛 ──
sec("S2 描述符确认为本 PID 之后才 start（退位候选不先扫）", async () => {
  if (typeof discoveryMod.startSyncDiscovery !== "function") { ok(false, "S2-0 startSyncDiscovery 可用"); return; }
  const dd = NEW("own-home");
  registryMod.addProject({ id: "own", name: "own", path: NEW("own-root"), kind: "backend" }, dd);
  const svc = mkSvc(dd);
  await drain();
  writeDescriptor(dd, process.pid + 424242);
  discoveryMod.startSyncDiscovery({ service: svc.service, dataDir: dd });
  const st = discoveryMod.syncDiscoveryStatus();
  const foreign = { running: st.running, watchers: st.watchers };
  await drain();
  ok(foreign.running === false && foreign.watchers === 0, "S2-1 描述符 pid 非本进程 → 不启动后台发现（不当第二个写者）", foreign);
  writeDescriptor(dd, process.pid);
  discoveryMod.startSyncDiscovery({ service: svc.service, dataDir: dd });
  const st2 = discoveryMod.syncDiscoveryStatus();
  ok(st2.running === true, "S2-2 描述符 pid=本进程 → 启动", { st2 });
  await drain();
});

// ── S3 单飞 key 含规范 dataDir + project ──
sec("S3 单飞 key＝规范 dataDir+project（夹具不串、同项目真单飞）", async () => {
  if (typeof discoveryMod.runSyncScanForRequest !== "function") { ok(false, "S3-0 runSyncScanForRequest 可用"); return; }
  const ddA = NEW("sf-a");
  const ddB = NEW("sf-b");
  const pA = makeProj("sf-a", "P");
  const pB = makeProj("sf-b", "P");
  registryMod.addProject({ id: "P", name: "P", path: pA.root, kind: "backend" }, ddA);
  registryMod.addProject({ id: "P", name: "P", path: pB.root, kind: "backend" }, ddB);
  const svcA = mkSvc(ddA);
  const svcB = mkSvc(ddB);
  const canonical = path.join(ddA, "sub", ".."); // 规范后仍是 ddA
  const p1 = discoveryMod.runSyncScanForRequest({ projectId: "P", dataDir: ddA, submitter: svcA.submitter });
  const p2 = discoveryMod.runSyncScanForRequest({ projectId: "P", dataDir: ddB, submitter: svcB.submitter });
  const p3 = discoveryMod.runSyncScanForRequest({ projectId: "P", dataDir: canonical, submitter: svcA.submitter });
  ok(p1 !== p2, "S3-1 同 projectId、不同 dataDir → 不共用单飞槽（隔离夹具不串）");
  ok(p1 === p3, "S3-2 同 projectId、等价规范 dataDir（含 ./..） → 共用同一在途（真单飞）");
  await Promise.allSettled([p1, p2, p3]);
});

// ── 共享的长生命周期夹具：项目已有契约＋证据包 ──
const fxExisting = async (): Promise<{ dd: string; svc: Svc; projs: Proj[]; batches: string[] }> => {
  const dd = NEW("fx-existing");
  const projs = [makeProj("fx-existing", "p1")];
  for (const p of projs) registryMod.addProject({ id: p.id, name: p.id, path: p.root, kind: "backend" }, dd);
  const svc = mkSvc(dd);
  const batches = ["b-a", "b-b", "b-c"];
  for (const b of batches) {
    const sha = await registerContract(svc, projs[0], contractFor(projs[0], b));
    postEvidence(projs[0], b, evidenceFor(projs[0], b, sha));
  }
  return { dd, svc, projs, batches };
};

// ── S4 按项目防抖 + 重复通知零事件 ──
sec("S4 按项目防抖（非每 event 一个 timer）＋重复通知零事件", async () => {
  if (typeof discoveryMod.startSyncDiscovery !== "function") { ok(false, "S4-0 startSyncDiscovery 可用"); return; }
  await drain();
  const fx = await fxExisting();
  const p = fx.projs[0];
  writeDescriptor(fx.dd, process.pid);
  discoveryMod.startSyncDiscovery({ service: fx.svc.service, dataDir: fx.dd });
  await waitFor(() => evidenceCheckedCount(p.workDir) >= 3, 8000);

  // 突发：同一项目连续 8 次目录通知（改写不同证据文件）→ 挂起扫描应 ≤1
  for (const b of fx.batches) postEvidence(p, b, evidenceFor(p, b, syncMod.existingContractSha(p.id, fx.dd, b)));
  for (let i = 0; i < 5; i += 1) fs.utimesSync(path.join(p.inbox, `${fx.batches[0]}.evidence.json`), new Date(), new Date());
  const st = discoveryMod.syncDiscoveryStatus();
  const pending = st.pending_scans;
  ok(typeof pending === "number" && pending <= 1, "S4-1 一次突发后挂起扫描 ≤1（按项目替换 timer，不是每 event 新增 timer）", { pending, st });
  ok(typeof st.watched_projects === "number" && st.watched_projects >= 1, "S4-2 状态可见：已挂监听项目数", { st });

  const before = syncEventCount(p.workDir);
  await sleep(1200);
  ok(syncEventCount(p.workDir) === before, "S4-3 重复通知/重复投同一包 → 0 新增事件（幂等键）", { before, after: syncEventCount(p.workDir) });

  // 停掉以便后续段独立
  await drain();
});

// ── S5 启动扫既有包 / 未选项目 / 晚出现的契约（轮询自动发现）──
sec("S5 启动扫既有包、未选项目仍发现、晚出现契约自动发现（无手动 scan/重启/重注册）", async () => {
  if (typeof discoveryMod.startSyncDiscovery !== "function") { ok(false, "S5-0 startSyncDiscovery 可用"); return; }
  await drain();
  const fx = await fxExisting();
  const p = fx.projs[0];
  // 既有包（启动前就在收件目录里）；没有 UI 选中任何项目
  writeDescriptor(fx.dd, process.pid);
  discoveryMod.startSyncDiscovery({ service: fx.svc.service, dataDir: fx.dd });
  const found = await waitFor(() => evidenceCheckedCount(p.workDir) >= 3, 8000);
  ok(found, "S5-1 启动扫既有包（未选项目也发现）", { n: evidenceCheckedCount(p.workDir) });

  // 新项目：登记时既无契约也无收件目录；随后正规登记契约 + 新 inbox
  const dd2 = NEW("fx-late");
  const q = makeProj("fx-late", "late1");
  registryMod.addProject({ id: q.id, name: q.id, path: q.root, kind: "backend" }, dd2);
  const svc2 = mkSvc(dd2);
  await drain();
  writeDescriptor(dd2, process.pid);
  discoveryMod.startSyncDiscovery({ service: svc2.service, dataDir: dd2 });
  await sleep(300);
  ok(syncEventCount(q.workDir) === 0, "S5-2 初始无契约/无 inbox：不产事件");
  const sha = await registerContract(svc2, q, contractFor(q, "b-late"));
  postEvidence(q, "b-late", evidenceFor(q, "b-late", sha));
  const discovered = await waitFor(() => evidenceCheckedCount(q.workDir) >= 1, 8000);
  const types = loadEventsOf(q.workDir).map((e: any) => e.type);
  ok(discovered, "S5-3 既有项目后来登记契约 + 新 inbox → 自动发现并写一次（无手动 scan/重启/重注册）", { n: syncEventCount(q.workDir), types });
  ok(evidenceCheckedCount(q.workDir) === 1, "S5-4 恰写 1 次 evidence_checked（不重复）", { types });
  await drain();
});

// ── S6 注册表生命周期：创建 / 新增 / 路径变更 / 注销 ──
sec("S6 注册表：初始不存在后创建、路径变更旧 watcher 关闭不误写、注销无残留", async () => {
  if (typeof discoveryMod.startSyncDiscovery !== "function") { ok(false, "S6-0 startSyncDiscovery 可用"); return; }
  await drain();
  const pA = makeProj("fx-registry", "pathA");
  const pB = makeProj("fx-registry", "pathB");
  const pOld = { ...pA, id: "rx" };
  const pNew = { ...pB, id: "rx" };
  // 用一个一次性 dataDir 把契约＋证据做好（项目账本在项目根，与 dataDir 无关）
  const ddPrep = NEW("fx-registry-prep");
  const prep = mkSvc(ddPrep);
  registryMod.addProject({ id: "rx", name: "rx", path: pOld.root, kind: "backend" }, ddPrep);
  const shaA = await registerContract(prep, pOld, contractFor(pOld, "b-rx"));
  postEvidence(pOld, "b-rx", evidenceFor(pOld, "b-rx", shaA));
  const beforeA = evidenceCheckedCount(pOld.workDir);
  ok(syncEventCount(pOld.workDir) === 1 && beforeA === 0, "S6-0 起始：契约已登记、证据未核（1 条 sync 事件、0 条核验）", { events: syncEventCount(pOld.workDir), checked: beforeA });
  // 模型「项目整体搬到新路径」：复制整棵 .工作台（同一契约与证据，尚无 evidence_checked）
  fs.cpSync(path.join(pOld.root, ".工作台"), path.join(pNew.root, ".工作台"), { recursive: true });
  const beforeB = evidenceCheckedCount(pNew.workDir);
  // 「注册表初始不存在」：全新 dataDir，只有启动骨架（registry.json 从未存在）
  const dd = NEW("fx-registry");
  const svc = mkSvc(dd);
  writeDescriptor(dd, process.pid);
  ok(!fs.existsSync(path.join(dd, "registry.json")), "S6-0b 起始 dataDir 里没有 registry.json（全新）");
  discoveryMod.startSyncDiscovery({ service: svc.service, dataDir: dd });
  await sleep(400);
  ok(evidenceCheckedCount(pOld.workDir) === beforeA && evidenceCheckedCount(pNew.workDir) === beforeB, "S6-1 注册表初始不存在：启动时无项目可扫（不误扫）", { beforeA, beforeB });

  // 注册表创建（指向 pathA）→ 应自动发现并扫描
  registryMod.addProject({ id: "rx", name: "rx", path: pOld.root, kind: "backend" }, dd);
  const created = await waitFor(() => evidenceCheckedCount(pOld.workDir) > beforeA, 8000);
  ok(created, "S6-2 注册表初始不存在后创建 → 自动发现（不要求重启/重新登记）", { beforeA, afterA: evidenceCheckedCount(pOld.workDir) });

  // 路径变更 pathA → pathB：旧 watcher 关闭，扫描落到 pathB
  const afterA = syncEventCount(pOld.workDir);
  registryMod.writeRegistry({ version: 1, projects: [{ ...projectRecord(pB), id: "rx" }] }, dd);
  const switched = await waitFor(() => evidenceCheckedCount(pNew.workDir) > beforeB, 8000);
  ok(switched, "S6-3 项目路径变更 → 新路径被扫描（watcher 换挂）", { beforeB, afterB: evidenceCheckedCount(pNew.workDir) });
  await sleep(1200);
  ok(syncEventCount(pOld.workDir) === afterA, "S6-4 旧路径不再被写（改路径后旧 watcher 不误写）", { afterA, nowA: syncEventCount(pOld.workDir) });
  const stWatched = discoveryMod.syncDiscoveryStatus();
  ok(stWatched.watched_projects === 1, "S6-5 路径变更不叠加监听（监听项目数仍为 1）", { stWatched });

  // 注销：watcher 关闭，新证据不再产事件
  registryMod.removeProject("rx", dd);
  await waitFor(() => discoveryMod.syncDiscoveryStatus().watched_projects === 0, 6000);
  const stAfter = discoveryMod.syncDiscoveryStatus();
  ok(stAfter.watched_projects === 0, "S6-6 注销项目 → 监听关闭（无泄漏）", { stAfter });
  const afterB2 = syncEventCount(pNew.workDir);
  postEvidence(pNew, "b-rx", evidenceFor(pNew, "b-rx", shaA));
  await sleep(1200);
  ok(syncEventCount(pNew.workDir) === afterB2, "S6-7 注销后新证据不产事件（旧 watcher 确已关闭）", { afterB2, nowB: syncEventCount(pNew.workDir) });
  await drain();
});

// ── S7 错误/上限不静默：health 可见并可清除 ──
sec("S7 发现失败报 health（全局与项目级可见，修好后清除）", async () => {
  if (typeof discoveryMod.startSyncDiscovery !== "function" || healthMod === null) { ok(false, "S7-0 前置模块可用"); return; }
  await drain();
  const dd = NEW("fx-broken");
  const svc = mkSvc(dd);
  write(dd + "/registry.json", "{ 这不是合法 JSON");
  writeDescriptor(dd, process.pid);
  discoveryMod.startSyncDiscovery({ service: svc.service, dataDir: dd });
  const globalSeen = await waitFor(() => healthMod!.readSyncDiscoveryIssues(dd, null).length > 0, 4000);
  ok(globalSeen, "S7-1 注册表读不出 → 全局发现错误可见（不静默 catch）", { issues: healthMod.readSyncDiscoveryIssues(dd, null) });
  ok(discoveryMod.syncDiscoveryStatus().running === true, "S7-2 注册表坏不阻断宿主起来（错误暴露但不破坏其它项目）");
  // 修好注册表 → 下一轮轮询清除全局错误
  registryMod.writeRegistry({ version: 1, projects: [] }, dd);
  const cleared = await waitFor(() => healthMod!.readSyncDiscoveryIssues(dd, null).length === 0, 6000);
  ok(cleared, "S7-3 注册表恢复 → 成功重试后全局错误清除（null issue 语义）", { issues: healthMod.readSyncDiscoveryIssues(dd, null) });
  await drain();

  // 项目级：本领域事件账本中段损坏 → 只报该项目，不牵连其它
  const dd2 = NEW("fx-brokenevents");
  const p = makeProj("fx-brokenevents", "pe");
  registryMod.addProject({ id: p.id, name: p.id, path: p.root, kind: "backend" }, dd2);
  write(p.workDir + "/events.jsonl", `${JSON.stringify({ bad: "not an event" })}\n`);
  const svc2 = mkSvc(dd2);
  writeDescriptor(dd2, process.pid);
  discoveryMod.startSyncDiscovery({ service: svc2.service, dataDir: dd2 });
  const projSeen = await waitFor(() => healthMod!.readSyncDiscoveryIssues(dd2, p.id).length > 0, 4000);
  ok(projSeen, "S7-4 某项目本领域账本损坏 → 该项目发现错误可见", { issues: healthMod.readSyncDiscoveryIssues(dd2, p.id) });
  ok(healthMod.readSyncDiscoveryIssues(dd2, null).length === 0, "S7-5 项目级故障不升级为全局（有配置的项目 fail closed，其它不受影响）");
  await drain();
  // 停在 stop 应清理该宿主发现错误（无残留）
  ok(healthMod.readSyncDiscoveryIssues(dd2, p.id).length === 0, "S7-6 stop 后该宿主发现错误已清理（无残留）", { issues: healthMod.readSyncDiscoveryIssues(dd2, p.id) });
});

// ── S8 stop/restart 语义 ──
sec("S8 stop 清 watch/timer 并 await 在途；await stop 后无更多写；restart 无残留", async () => {
  if (typeof discoveryMod.startSyncDiscovery !== "function") { ok(false, "S8-0 startSyncDiscovery 可用"); return; }
  await drain();
  const fx = await fxExisting();
  const p = fx.projs[0];
  writeDescriptor(fx.dd, process.pid);
  discoveryMod.startSyncDiscovery({ service: fx.svc.service, dataDir: fx.dd });
  await waitFor(() => evidenceCheckedCount(p.workDir) >= 3, 8000);
  const t0 = Date.now();
  await discoveryMod.stopSyncDiscovery();
  ok(Date.now() - t0 < 15000, "S8-1 stop 有界完成（await 在途，不挂住）", { ms: Date.now() - t0 });
  const st = discoveryMod.syncDiscoveryStatus();
  ok(st.running === false && st.watchers === 0 && st.pending_scans === 0 && st.watched_projects === 0, "S8-2 stop 后无残留（watch/timer/项目计数归零）", { st });
  const before = syncEventCount(p.workDir);
  for (const b of fx.batches) postEvidence(p, b, evidenceFor(p, b, syncMod.existingContractSha(p.id, fx.dd, b)));
  fs.utimesSync(path.join(p.inbox, `${fx.batches[0]}.evidence.json`), new Date(), new Date());
  await sleep(1500);
  ok(syncEventCount(p.workDir) === before, "S8-3 await stop 之后无更多写（监听/定时器确已清）", { before, after: syncEventCount(p.workDir) });

  // restart：旧运行的在途/定时器不应误删新队列，重启后仍能扫描变化
  discoveryMod.startSyncDiscovery({ service: fx.svc.service, dataDir: fx.dd });
  await waitFor(() => discoveryMod.syncDiscoveryStatus().running === true, 2000);
  // 改「被 check 直接读取的目标」（不是契约来源）→ verdict 变 → 新幂等键 → 应有新事件
  const beforeChange = evidenceCheckedCount(p.workDir);
  write(p.targetAbs, `# 独立目标（已改）\n\n目标内容变了，逐项判据应随之变化。\n`);
  for (const b of fx.batches) postEvidence(p, b, evidenceFor(p, b, syncMod.existingContractSha(p.id, fx.dd, b)));
  const rescanned = await waitFor(() => evidenceCheckedCount(p.workDir) > beforeChange, 10000);
  ok(rescanned, "S8-4 restart 后仍能扫描新变化（旧 finally 不误删新队列）", { beforeChange, after: evidenceCheckedCount(p.workDir) });
  ok(discoveryMod.syncDiscoveryStatus().running === true, "S8-5 restart 幂等起得来");
  await drain();
});

// ── S9 真实隔离服务：spawn 真 daemon ──
sec("S9 真实隔离服务：描述符=本 PID 才扫、未选项目发现、重复通知零事件、退出无残留", async () => {
  await drain();
  const dd = NEW("svc-home");
  const p = makeProj("svc-home", "svc1");
  registryMod.addProject({ id: p.id, name: p.id, path: p.root, kind: "backend" }, dd);
  const svc = mkSvc(dd);
  const sha = await registerContract(svc, p, contractFor(p, "b-svc"));
  postEvidence(p, "b-svc", evidenceFor(p, "b-svc", sha));
  serviceMod.removeServiceDescriptor(dd); // daemon 自己发布描述符
  const before = evidenceCheckedCount(p.workDir);

  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("TATAI_")) env[k] = v;
  env.TATAI_HOME = dd;
  env.TATAI_NO_AUTOSTART = "1";
  let out = "";
  const child: ChildProcess = spawn(process.execPath, ["--import", "tsx", DAEMON_ENTRY], { cwd: ROOT, env });
  child.stdout?.on("data", (d: Buffer) => (out += d.toString("utf8")));
  child.stderr?.on("data", (d: Buffer) => (out += d.toString("utf8")));
  const exited = { code: null as number | null };
  child.on("exit", (c) => { exited.code = c ?? -1; });

  const descPath = path.join(dd, "work-service.json");
  const published = await waitFor(() => {
    if (!fs.existsSync(descPath)) return false;
    try { return JSON.parse(fs.readFileSync(descPath, "utf8")).pid === child.pid; } catch { return false; }
  }, 20000);
  ok(published, "S9-1 真 daemon 成为唯一写服务并发布描述符（pid=子进程）", { pid: child.pid, out: out.slice(-300) });
  const scanned = await waitFor(() => evidenceCheckedCount(p.workDir) >= before + 1, 15000);
  ok(scanned, "S9-2 daemon 启动扫既有包（未选项目也发现）", { before, after: evidenceCheckedCount(p.workDir), out: out.slice(-300) });
  const after1 = syncEventCount(p.workDir);
  postEvidence(p, "b-svc", evidenceFor(p, "b-svc", sha));
  fs.utimesSync(path.join(p.inbox, "b-svc.evidence.json"), new Date(), new Date());
  await sleep(1500);
  ok(syncEventCount(p.workDir) === after1, "S9-3 重复通知/重复投同一包 → 0 新增事件", { after1, now: syncEventCount(p.workDir) });

  child.kill("SIGTERM");
  const sigGone = await waitFor(() => exited.code !== null, 10000);
  info(`  [说明] Windows 上 SIGTERM 不触发 Node 信号处理器（TerminateProcess），优雅退出改走真实让位握手；本次 SIGTERM exit=${exited.code}`);
  if (!sigGone) {
    // 极少数环境下子进程仍未退出：用让位交接收尾，避免夹具挂住
    try { child.kill(); } catch { /* ignore */ }
    await waitFor(() => exited.code !== null, 5000);
  }
  // 优雅退出走真实让位握手（POST /api/work/admin/shutdown，token 取描述符；不打印）
  const dd2 = NEW("svc-home2");
  const p2 = makeProj("svc-home2", "svc2");
  registryMod.addProject({ id: p2.id, name: p2.id, path: p2.root, kind: "backend" }, dd2);
  const svc2 = mkSvc(dd2);
  const sha2 = await registerContract(svc2, p2, contractFor(p2, "b-svc2"));
  postEvidence(p2, "b-svc2", evidenceFor(p2, "b-svc2", sha2));
  serviceMod.removeServiceDescriptor(dd2);
  let out2 = "";
  const child2: ChildProcess = spawn(process.execPath, ["--import", "tsx", DAEMON_ENTRY], { cwd: ROOT, env: { ...env, TATAI_HOME: dd2 } });
  child2.stdout?.on("data", (d: Buffer) => (out2 += d.toString("utf8")));
  child2.stderr?.on("data", (d: Buffer) => (out2 += d.toString("utf8")));
  const ex2 = { code: null as number | null };
  child2.on("exit", (c) => { ex2.code = c ?? -1; });
  const desc2 = path.join(dd2, "work-service.json");
  const pub2 = await waitFor(() => {
    if (!fs.existsSync(desc2)) return false;
    try { return JSON.parse(fs.readFileSync(desc2, "utf8")).pid === child2.pid; } catch { return false; }
  }, 20000);
  ok(pub2, "S9-4 第二个 daemon 也确认为本 PID 才发布/扫描");
  const d2 = JSON.parse(fs.readFileSync(desc2, "utf8"));
  const bye = await fetch(`http://${d2.host}:${d2.port}/api/work/admin/shutdown`, {
    method: "POST",
    headers: { [serviceMod.WORK_TOKEN_HEADER]: d2.token },
    signal: AbortSignal.timeout(3000),
  }).catch(() => null);
  ok(bye !== null && bye.ok, "S9-5 让位握手被接受（真实优雅退出路径）");
  const gone2 = await waitFor(() => ex2.code !== null, 10000);
  ok(gone2 && ex2.code === 0, "S9-5b 让位后优雅退出 exit=0", { code: ex2.code, out2: out2.slice(-300) });
  const descGone = await waitFor(() => !fs.existsSync(desc2), 5000);
  ok(descGone, "S9-5c 退出撤销描述符（不留死端口的旧地址）");
  try { if (child2.exitCode === null) child2.kill(); } catch { /* ignore */ }
  const after2 = syncEventCount(p2.workDir);
  postEvidence(p2, "b-svc2", evidenceFor(p2, "b-svc2", sha2));
  await sleep(1000);
  ok(syncEventCount(p2.workDir) === after2, "S9-6 退出后不再写（无残留扫描）", { after2, now: syncEventCount(p2.workDir) });
  try { if (child.exitCode === null) child.kill(); } catch { /* ignore */ }
});

// ── S10 stop 真正等到全部在途终止（旧实现 10s Promise.race 会超时假成功、返回后仍晚写）──
sec("S10 stop 真正等待在途扫描终止：超旧 10s 窗口不提前返回、返回后零晚写", async () => {
  if (typeof discoveryMod.startSyncDiscovery !== "function") { ok(false, "S10-0 startSyncDiscovery 可用"); return; }
  await drain();
  const dd = NEW("fx-slowstop");
  const p = makeProj("fx-slowstop", "slow1");
  registryMod.addProject({ id: p.id, name: p.id, path: p.root, kind: "backend" }, dd);
  const svc = mkSvc(dd);
  const sha = await registerContract(svc, p, contractFor(p, "b-slow"));
  postEvidence(p, "b-slow", evidenceFor(p, "b-slow", sha));
  const before = evidenceCheckedCount(p.workDir);

  // 让**第一次**写口调用阻塞在 gate 上：模拟"仍在途、还没写完"的 scan，且真实超过旧 10s 窗口
  let gateOpen = false;
  let releaseGate!: () => void;
  const gate = new Promise<void>((r) => { releaseGate = () => { gateOpen = true; r(); }; });
  let firstSubmitSeen = false;
  const slowSubmitter = {
    submit: (cmd: unknown) => {
      if (!firstSubmitSeen) {
        firstSubmitSeen = true;
        // 释放后再晚 300ms 才真写：让"返回后晚写"在旧实现上清晰可观测（不是采样竞态）
        return gate.then(() => new Promise<void>((r) => setTimeout(r, 300))).then(() => svc.submitter.submit(cmd));
      }
      return svc.submitter.submit(cmd);
    },
  };
  writeDescriptor(dd, process.pid);
  discoveryMod.startSyncDiscovery({ service: slowSubmitter, dataDir: dd });
  const inFlight = await waitFor(() => firstSubmitSeen, 5000);
  ok(inFlight, "S10-1 启动扫描已在途（写口被阻塞、该 scan 尚未完成）", { inFlight, gateOpen });

  let stopSettled = false;
  const stopP = discoveryMod.stopSyncDiscovery().then(() => { stopSettled = true; });
  const OLD_WINDOW_MS = 10_000;
  await sleep(OLD_WINDOW_MS + 1_500);
  ok(!stopSettled, "S10-2 超过旧 10s 窗口 stop 仍未返回（不 Promise.race 超时假成功）", { waited_ms: OLD_WINDOW_MS + 1500, stopSettled });
  ok(
    evidenceCheckedCount(p.workDir) === before,
    "S10-3 在途未终止期间尚未写入（stop 未提前清活跃槽/未假称已停止）",
    { before, now: evidenceCheckedCount(p.workDir) },
  );

  const tRelease = Date.now();
  releaseGate();
  await stopP;
  ok(Date.now() - tRelease < 5000, "S10-4 释放后在途迅速收尾、stop 有界返回（等的是它，不是丢弃）", { ms: Date.now() - tRelease });
  const atReturn = evidenceCheckedCount(p.workDir);
  ok(atReturn === before + 1, "S10-5 被等待的 scan 真写入了（stop 真正等到它收尾）", { before, atReturn });
  const st = discoveryMod.syncDiscoveryStatus();
  ok(st.running === false && st.pending_scans === 0 && st.watched_projects === 0, "S10-6 await stop 后无监听/队列残留", { st });
  await sleep(1_500);
  ok(
    evidenceCheckedCount(p.workDir) === atReturn,
    "S10-7 await stop 返回后零晚写（返回后不得再写）",
    { atReturn, now: evidenceCheckedCount(p.workDir) },
  );
  ok(
    healthMod !== null && healthMod.readSyncDiscoveryIssues(dd, p.id).length === 0,
    "S10-8 在途全部收尾后 stop 才清本宿主发现错误（无残留）",
    { issues: healthMod === null ? null : healthMod.readSyncDiscoveryIssues(dd, p.id) },
  );
  await drain();
});

// ── S11 收件目录非 ENOENT 读失败必须显式 health 失败（不得用 gone 吞权限/IO 异常）──
sec("S11 收件目录非 ENOENT 读失败显式 health 失败（不吞权限/IO 异常）", async () => {
  if (typeof discoveryMod.startSyncDiscovery !== "function" || healthMod === null) { ok(false, "S11-0 前置模块可用"); return; }
  await drain();

  // (a) 真实现场：约定收件目录被一个**常规文件**占住 → readdirSync 抛 ENOTDIR（非 ENOENT）
  const ddA = NEW("fx-inboxfile");
  const pa = makeProj("fx-inboxfile", "if1");
  registryMod.addProject({ id: pa.id, name: pa.id, path: pa.root, kind: "backend" }, ddA);
  const svcA = mkSvc(ddA);
  await registerContract(svcA, pa, contractFor(pa, "b-if"));
  write(pa.inbox, "收件目录位置上放了一个常规文件（夹具 ENOTDIR 现场）\n");
  writeDescriptor(ddA, process.pid);
  discoveryMod.startSyncDiscovery({ service: svcA.service, dataDir: ddA });
  const seenA = await waitFor(() => healthMod!.readSyncDiscoveryIssues(ddA, pa.id).length > 0, 4000);
  ok(seenA, "S11-1 收件目录读不出（ENOTDIR 非 ENOENT）→ 显式发现错误可见（不 silent catch 成空）", { issues: healthMod.readSyncDiscoveryIssues(ddA, pa.id) });
  ok(
    syncMod.readSyncStatus(pa.id, ddA).overall !== "passed",
    "S11-1b 读口 overall 不因读失败停在 passed（fail-closed）",
    { overall: syncMod.readSyncStatus(pa.id, ddA).overall },
  );
  await drain();

  // (b) stat 阶段非 ENOENT 失败：确定性注入 EACCES（权限/IO 异常的等价物）。
  //     旧实现 `catch { parts.push(name + ":gone") }` 会吞成 gone、error=null → 无 health、静默当"没变化"。
  const ddB = NEW("fx-statfail");
  const pb = makeProj("fx-statfail", "sf1");
  registryMod.addProject({ id: pb.id, name: pb.id, path: pb.root, kind: "backend" }, ddB);
  const svcB = mkSvc(ddB);
  const shaB = await registerContract(svcB, pb, contractFor(pb, "b-sf"));
  postEvidence(pb, "b-sf", evidenceFor(pb, "b-sf", shaB));
  const fsAny = fs as any;
  const origStat = fsAny.statSync;
  const inboxAbs = path.resolve(pb.inbox);
  fsAny.statSync = (target: unknown, ...rest: unknown[]) => {
    if (typeof target === "string" && path.resolve(target).startsWith(inboxAbs + path.sep)) {
      throw Object.assign(new Error("EACCES: injected（夹具模拟权限/IO 异常）"), { code: "EACCES" });
    }
    return origStat(target, ...rest);
  };
  try {
    writeDescriptor(ddB, process.pid);
    discoveryMod.startSyncDiscovery({ service: svcB.service, dataDir: ddB });
    const seenB = await waitFor(() => healthMod!.readSyncDiscoveryIssues(ddB, pb.id).length > 0, 5000);
    const issuesB: string[] = healthMod.readSyncDiscoveryIssues(ddB, pb.id);
    ok(seenB, "S11-2 证据文件 stat 非 ENOENT 失败（EACCES）→ 该项目出现显式发现错误", { issues: issuesB });
    ok(
      issuesB.some((s) => /收件目录证据文件 .*判不出/.test(s)),
      "S11-2b **指纹自身**报出「收件目录证据文件 … 判不出」（旧实现 catch 吞成 gone、error=null）",
      { issues: issuesB },
    );
    ok(
      !issuesB.some((s) => /收件目录证据文件 .*gone/.test(s)),
      "S11-2c 不得把权限/IO 异常说成 gone/没证据",
      { issues: issuesB },
    );
  } finally {
    fsAny.statSync = origStat;
  }
  const cleared = await waitFor(() => healthMod!.readSyncDiscoveryIssues(ddB, pb.id).length === 0, 7000);
  ok(cleared, "S11-3 恢复（stat 正常）后成功重试 → 错误清除（null issue 语义）", { issues: healthMod.readSyncDiscoveryIssues(ddB, pb.id) });
  await drain();
});

// ── S12 >64 证据文件：指纹有界但不冒充完整 → 显式 fail-closed（不截断后报通过）──
sec("S12 证据文件数 >64：达到有界轮询上限即显式 fail-closed", async () => {
  if (typeof discoveryMod.startSyncDiscovery !== "function" || healthMod === null) { ok(false, "S12-0 前置模块可用"); return; }
  await drain();
  const dd = NEW("fx-overflow");
  const p = makeProj("fx-overflow", "ov1");
  registryMod.addProject({ id: p.id, name: p.id, path: p.root, kind: "backend" }, dd);
  const svc = mkSvc(dd);
  const sha = await registerContract(svc, p, contractFor(p, "b-ov"));
  postEvidence(p, "b-ov", evidenceFor(p, "b-ov", sha)); // 1 个合法批次（单看会是 passed）
  // 再放 127 个证据后缀文件，凑到 128 个（> 有界轮询上限 64）
  mkdirp(p.inbox);
  for (let i = 0; i < 127; i += 1) {
    write(path.join(p.inbox, `b-extra-${String(i).padStart(3, "0")}.evidence.json`), `{"schema_version":1,"stub":true}\n`);
  }
  const fileCount = fs.readdirSync(p.inbox).filter((n) => n.endsWith(SYNC_SUFFIX)).length;
  ok(fileCount === 128, "S12-0b 夹具确实放了 128 个证据文件（> 旧 64 拦截线）", { fileCount });

  writeDescriptor(dd, process.pid);
  discoveryMod.startSyncDiscovery({ service: svc.service, dataDir: dd });
  const seen = await waitFor(() => healthMod!.readSyncDiscoveryIssues(dd, p.id).length > 0, 5000);
  const issues: string[] = healthMod.readSyncDiscoveryIssues(dd, p.id);
  ok(seen, "S12-1 证据文件数 >64 → 显式发现错误（达到上限报 incomplete 及原因）", { issues });
  ok(
    issues.some((s) => /超过有界轮询指纹上限|有界轮询/.test(s)),
    "S12-1b 错误点名有界轮询上限（不是只带个总数就当没事）",
    { issues },
  );
  const report = syncMod.readSyncStatus(p.id, dd);
  ok(report.overall !== "passed", "S12-2 读口 overall 不因截断指纹停在 passed（fail-closed）", { overall: report.overall, scan_error: report.scan_error });
  ok(
    typeof report.scan_error === "string" && report.scan_error.length > 0,
    "S12-3 scan_error 如实给出原因（不静默）",
    { scan_error: report.scan_error },
  );
  await drain();
});

// ═══ 跑全部段 ═══
for (const [name, fn] of runs) {
  console.log(`[verify] ── ${name}`);
  try { await fn(); } catch (e) { ok(false, `${name}：段内异常`, { error: e instanceof Error ? e.message : String(e) }); }
}

// ═══ 收尾 ═══
await drain();
if (process.env.TATAI_KEEP_TMP !== "1") fs.rmSync(tmpBase, { recursive: true, force: true });
console.log("[verify] ── 汇总");
info(`PASS ${passCount} / FAIL ${failCount}`);
