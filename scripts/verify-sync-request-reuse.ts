// V09-23 性能补正 · 「同一次同步状态读取内六图只构建一次」专项回归（先红后绿）。
//
// 背景（2026-10-02 根因诊断）：`readSyncStatus` 对**每个历史批次**各跑一次完整 `sixGraphsOf`，
// 一次读取 31 次全量图构建、8–9 秒，超过客户端 5 秒预算 → 接续被 fail-closed 阻断。
// 补正只复用**同一次调用内相同真实图输入**的构建结果，不改任何判据、不跳历史批次、不跨请求缓存。
//
// 本脚本验证的边界（全部围绕上面的补正，不新增业务判据）：
//   A 同调用多次检查 → 只构建一次；仍逐批保留全部检查与各自的期望基线比较（含被取代的历史批次）
//   B 新调用必重读（无跨请求持久缓存）
//   C 调用内图输入文件变化 → 失效重算，不把旧图贴新指纹
//   D 调用内设计文档变化 → 失效重算
//   E 调用内业务事件账本变化 → 失效重算
//   F 源身份不可核实（图输入有界读取异常）→ 不复用、也不判通过（宁可慢也不贴错图）
//   G graphSourceOnly（锁内）不调用全量 `sixGraphsOf`，且图项 actual 与全量模式逐字段一致
//   H hostSyncView 不可达分支：已配置 fail-closed 且**只构造一次**；未配置旧项目保持 not_configured
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
const normalize = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(normalize)
    : v !== null && typeof v === "object"
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([k]) => k !== "checked_at").map(([k, x]) => [k, normalize(x)]))
      : v;
const eq = (a: unknown, b: unknown): boolean => JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");
const loadSrc = async <T>(rel: string): Promise<T> => (await import(pathToFileURL(path.join(SRC, rel)).href)) as T;

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-sync-reuse-"));
const dataDir = path.join(tmpBase, "home");
const root = path.join(tmpBase, "proj-reuse");
const workDir = path.join(root, ".工作台", "work");
const inbox = path.join(workDir, "sync-inbox");
const archDir = path.join(root, ".工作台", "arch");
const oldRoot = path.join(tmpBase, "proj-reuse-old");
const PID = "reusefx";
const OLDPID = "reusefx-old";
const CHG = "chg-reuse";

const SOURCE_REL = "reports/result.md";
const SOURCE_ABS = path.join(root, SOURCE_REL);
const MODULES_ABS = path.join(archDir, "modules.json");
const DESIGN_ABS = path.join(root, ".工作台", "design.md");
const PLAN_ABS = path.join(root, ".工作台", "plan.md");

interface Card { id: string; goal: string; role: string }
const planText = (title: string, cards: Card[]): string => {
  const L = [`# ${title}`, "", "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |", "| --- | --- | --- | --- | --- |"];
  for (const c of cards) L.push(`| ${c.id} | todo | ${c.goal} |  | ${c.id} 的完成证据 |`);
  L.push("");
  for (const c of cards) L.push(`### ${c.id} ${c.goal}`, "", `**设计依据**：§1。**依赖**：无。**文件责任**：\`src/${c.id.toLowerCase()}.ts\`。**责任角色**：${c.role}。`, "", `- [ ] ${c.goal} 达标`, "");
  return L.join("\n");
};

async function main(): Promise<void> {
  info(`同步状态请求内六图复用 · 专项回归（${process.platform} · node ${process.version}）`);
  info(`  夹具根 ${tmpBase}（隔离 dataDir ${dataDir}）`);

  const registryMod = await loadSrc<typeof import("../src/server/registry")>("server/registry.ts");
  const serviceMod = await loadSrc<typeof import("../src/server/work/service")>("server/work/service.ts");
  const syncMod = await loadSrc<typeof import("../src/server/work/sync")>("server/work/sync.ts");
  const contractMod = await loadSrc<typeof import("../src/server/work/syncContract")>("server/work/syncContract.ts");
  const checksMod = await loadSrc<typeof import("../src/server/work/syncChecks")>("server/work/syncChecks.ts");
  const eventStoreMod = await loadSrc<typeof import("../src/server/work/eventStore")>("server/work/eventStore.ts");
  const tasksMod = await loadSrc<typeof import("../src/server/work/tasks")>("server/work/tasks.ts");
  const referencesMod = await loadSrc<typeof import("../src/server/work/references")>("server/work/references.ts");
  const probeMod = await loadSrc<typeof import("../src/server/work/syncProbe")>("server/work/syncProbe.ts");
  await loadSrc<typeof import("../src/server/work/syncGraph")>("server/work/syncGraph.ts");
  const syncHostMod = await loadSrc<typeof import("../src/mcp/tools/syncHost")>("mcp/tools/syncHost.ts");
  type FrozenContract = ReturnType<typeof contractMod.validateSyncContract>;

  // ═══ 0. 夹具（隔离 dataDir；真实文件、真实契约、真实收件目录）═══
  mkdirp(dataDir);
  mkdirp(root);
  mkdirp(oldRoot);
  mkdirp(inbox);
  write(SOURCE_ABS, "同步请求内复用夹具：真实 artifact。\n");
  writeJson(MODULES_ABS, { version: 1, generated_at: "2026-10-02T00:00:00.000Z", budget_exhausted: false, modules: [{ id: "src", path: "src", file_count: 1, loc: 0, deps: [] }] });
  write(DESIGN_ABS, "# 复用夹具设计书\n\n## 1 目标\n\n夹具设计正文。\n");
  const PLAN_TEXT = planText("复用夹具施工图", [{ id: "T-1", goal: "夹具卡一", role: "executor" }]);
  write(PLAN_ABS, PLAN_TEXT);

  registryMod.addProject({ id: PID, name: "请求内复用夹具", path: root, kind: "backend" }, dataDir);
  registryMod.addProject({ id: OLDPID, name: "无同步配置夹具", path: oldRoot, kind: "backend" }, dataDir);

  const service = new serviceMod.WorkService({ dataDir });
  const submitter = { submit: (c: unknown) => service.submit(c) };
  tasksMod.submitDefinitionImports(submitter, { project_id: PID, change_id: CHG, actor_id: "fixture", role: "coordinator", definitions: referencesMod.importPlanChecked(PLAN_TEXT, workDir).definitions });

  const frozen = new Map<string, FrozenContract>();
  const regSeq = new Map<string, number>();
  const postEvidence = (batchId: string, contractSha: string): void => {
    const pkg = {
      schema_version: 1,
      batch_id: batchId,
      project_id: PID,
      contract_sha256: contractSha,
      completed: true,
      items: [{ id: "graph", result: "passed", artifacts: [{ path: SOURCE_REL, sha256: sha256(fs.readFileSync(SOURCE_ABS)) }] }],
    };
    const tmp = path.join(inbox, `.${batchId}.evidence.json.tmp`);
    fs.writeFileSync(tmp, `${JSON.stringify(pkg, null, 2)}\n`);
    fs.renameSync(tmp, path.join(inbox, `${batchId}.evidence.json`));
  };
  const register = (batchId: string, expectedBaseline: string, extra: Record<string, unknown> = {}): void => {
    const raw = {
      schema_version: 1,
      batch_id: batchId,
      project_id: PID,
      title: `批次 ${batchId}`,
      sources: [{ path: SOURCE_REL, sha256: sha256(fs.readFileSync(SOURCE_ABS)) }],
      items: [{ id: "graph", label: "六图同快照取齐", required: true, check: { type: "graph_full", expected_baseline_id: expectedBaseline } }],
      blocks_entry: false,
      ...extra,
    };
    const contract = contractMod.validateSyncContract(raw);
    const cmd = syncMod.buildRegisterContractCommand({ projectId: PID, changeId: CHG, actorId: "fixture", role: "coordinator", contract, expectedRevision: null });
    const receipt = service.submit(cmd);
    if (!receipt.ok || receipt.projection.state !== "applied") throw new Error(`登记 ${batchId} 失败：${JSON.stringify(receipt).slice(0, 300)}`);
    frozen.set(batchId, contract);
    regSeq.set(batchId, receipt.seq);
    postEvidence(batchId, contractMod.syncContractSha256(contract));
  };

  // 6 个批次（r6 取代 r1：历史批次保留、active=false）；r3 给出**不同**的期望基线以证明逐批比较没被合并
  register("r1", "b-fixture-1");
  register("r2", "b-fixture-1");
  register("r3", "b-distinct");
  register("r4", "b-fixture-1");
  register("r5", "b-fixture-1");
  register("r6", "b-fixture-1", { supersedes: "r1" });
  info(`  契约与证据就位：6 批（r6 supersedes r1），收件目录 ${inbox}`);

  // 业务事件（非 sync.*）行：E 段用它造「调用内业务事件账本变化」（真实事件信封，只改序号/版本）
  const rawEvents = fs.readFileSync(eventStoreMod.eventsPath(workDir), "utf8");
  const businessLine = rawEvents.split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as Record<string, unknown>).find((e) => !String(e.type).startsWith("sync."));
  ok(businessLine !== undefined, "0 夹具含真实业务事件行（E 段前置）");
  const lastSeq = Math.max(...rawEvents.split("\n").filter((l) => l.trim() !== "").map((l) => Number((JSON.parse(l) as { seq: number }).seq)));
  const restoreEvents = (): void => write(eventStoreMod.eventsPath(workDir), rawEvents);

  // ═══ 计数包装：真实六图探针（canonical builder）的构建次数 ═══
  const realProbe = probeMod.syncGraphProbe();
  if (realProbe === null) throw new Error("六图探针未注册（syncGraph 未加载）——夹具前置失败");
  let graphCalls = 0;
  let afterBuild: ((n: number) => void) | null = null;
  probeMod.registerSyncGraphProbe((pid, dd) => {
    graphCalls += 1;
    const result = realProbe(pid, dd);
    afterBuild?.(graphCalls);
    return result;
  });

  // ═══ A 同调用多次检查 → 一次构建；保留全部批次与逐批期望基线比较 ═══
  graphCalls = 0;
  afterBuild = null;
  const tA = performance.now();
  const reportA = syncMod.readSyncStatus(PID, dataDir);
  const msA = performance.now() - tA;
  ok(reportA.batches.length === 6, "A-1 保留全部批次（含被取代的历史批次 r1）", { got: reportA.batches.length });
  ok(reportA.batches.find((b) => b.batch_id === "r1")?.active === false && reportA.batches.find((b) => b.batch_id === "r6")?.active === true, "A-2 被取代批次 active=false、后继 active=true");
  const activeA = reportA.batches.filter((b) => b.active);
  ok(
    activeA.every((b) => b.items.length === 1 && typeof b.items[0].verdict === "string" && b.items[0].actual !== null),
    "A-3 每个**现行**批次的检查都真跑过（逐项有 verdict 与 actual）",
    reportA.batches.map((b) => [b.batch_id, b.active, b.items[0]?.verdict]),
  );
  const r1Rep = reportA.batches.find((b) => b.batch_id === "r1");
  ok(
    r1Rep?.historical === true && r1Rep?.active === false && r1Rep.items.every((i) => i.actual === null) && r1Rep.verified_at === null,
    "A-3b 被取代的历史批次改走账本回执（不实时求值；无回执即未核验、actual=null）",
    { verdict: r1Rep?.verdict, verified_at: r1Rep?.verified_at },
  );
  ok(
    reportA.batches.find((b) => b.batch_id === "r3")?.items[0].expected !== null &&
      (reportA.batches.find((b) => b.batch_id === "r3")?.items[0].expected as { expected_baseline_id?: string } | undefined)?.expected_baseline_id === "b-distinct",
    "A-4 逐批保留各自的期望基线比较（r3=b-distinct，未被合并/覆盖）",
    reportA.batches.find((b) => b.batch_id === "r3")?.items[0].expected,
  );
  ok(graphCalls === 1, "A-5 同一次调用内相同真实图输入只构建一次 sixGraphsOf", { graphCalls, ms: Math.round(msA) });
  info(`  A 段：6 批共 ${graphCalls} 次构建，耗时 ${Math.round(msA)} ms（未补正时为 6 次）`);

  // ═══ B 新调用必重读（无跨请求持久缓存）═══
  graphCalls = 0;
  const reportB = syncMod.readSyncStatus(PID, dataDir);
  ok(graphCalls === 1, "B-1 新调用必重读（不复用上一次调用的构建）", { graphCalls });
  ok(eq(reportB, reportA), "B-2 两次调用结果等价（忽略 checked_at 等本次核对时间）");

  // ═══ C 调用内图输入文件变化 → 失效重算 ═══
  const modulesBefore = fs.readFileSync(MODULES_ABS);
  graphCalls = 0;
  afterBuild = (n) => { if (n === 1) writeJson(MODULES_ABS, { version: 1, generated_at: "2026-10-02T00:00:00.000Z", budget_exhausted: false, modules: [{ id: "src", path: "src", file_count: 2, loc: 0, deps: [] }, { id: "lib", path: "lib", file_count: 1, loc: 0, deps: [] }] }); };
  const reportC = syncMod.readSyncStatus(PID, dataDir);
  afterBuild = null;
  ok(graphCalls === 2, "C-1 调用内图输入文件变化 → 缓存失效、重算", { graphCalls });
  const c2 = reportC.batches.find((b) => b.batch_id === "r2")?.items[0].actual as { graph_inputs?: { modules?: string } } | undefined;
  const c3 = reportC.batches.find((b) => b.batch_id === "r3")?.items[0].actual as { graph_inputs?: { modules?: string } } | undefined;
  ok(
    c2 != null && c3 != null && c2.graph_inputs?.modules !== c3.graph_inputs?.modules,
    "C-2 变化前/后**现行**批次的 actual 各反映自己的真实输入（不把旧图贴新指纹）",
    { before: c2?.graph_inputs?.modules, after: c3?.graph_inputs?.modules },
  );
  const r2C = reportC.batches.find((b) => b.batch_id === "r2");
  ok(
    r2C?.verdict !== "passed" && (r2C?.items[0]?.reasons ?? []).some((r) => /构建期间/.test(r)),
    "C-3 构建期间图输入改变 → 该批次**明确过期**（不是只 miss 缓存仍照常返回旧结果）",
    { verdict: r2C?.verdict, reasons: r2C?.items[0]?.reasons },
  );
  write(MODULES_ABS, modulesBefore);

  // ═══ D 调用内设计文档变化 → 失效重算 ═══
  const designBefore = fs.readFileSync(DESIGN_ABS);
  graphCalls = 0;
  afterBuild = (n) => { if (n === 1) fs.appendFileSync(DESIGN_ABS, "\n补充：夹具设计变化。\n"); };
  const reportD = syncMod.readSyncStatus(PID, dataDir);
  afterBuild = null;
  ok(graphCalls === 2, "D-1 调用内设计文档（基线来源）变化 → 缓存失效、重算", { graphCalls });
  const d2 = reportD.batches.find((b) => b.batch_id === "r2")?.items[0].actual as { design_revision?: string | null } | undefined;
  const d3 = reportD.batches.find((b) => b.batch_id === "r3")?.items[0].actual as { design_revision?: string | null } | undefined;
  ok(
    d2 != null && d3 != null && d2.design_revision !== d3.design_revision,
    "D-2 变化前/后**现行**批次的 design_revision 不同",
    { before: d2?.design_revision, after: d3?.design_revision },
  );
  write(DESIGN_ABS, designBefore);

  // ═══ E 调用内业务事件账本变化 → 失效重算 ═══
  graphCalls = 0;
  afterBuild = (n) => {
    if (n !== 1 || businessLine === undefined) return;
    const bumped = { ...businessLine, seq: lastSeq + 1, entity_revision: Number(businessLine.entity_revision) + 1, event_id: crypto.randomUUID(), idempotency_key: `fixture-bump-${crypto.randomBytes(4).toString("hex")}`, occurred_at: new Date().toISOString(), received_at: new Date().toISOString() };
    fs.appendFileSync(eventStoreMod.eventsPath(workDir), `${JSON.stringify(bumped)}\n`);
  };
  const reportE = syncMod.readSyncStatus(PID, dataDir);
  afterBuild = null;
  ok(graphCalls === 2, "E-1 调用内业务事件账本变化 → 缓存失效、重算", { graphCalls });
  ok(reportE.batches.length === 6, "E-2 变化后仍逐批保留全部检查", { got: reportE.batches.length });
  const r2E = reportE.batches.find((b) => b.batch_id === "r2");
  ok(
    r2E?.verdict !== "passed" && (r2E?.items[0]?.reasons ?? []).some((r) => /构建期间/.test(r)),
    "E-5 构建期间业务事件账本变化 → 该批次**明确过期**（不把旧事件快照配新身份判 passed）",
    { verdict: r2E?.verdict, reasons: r2E?.items[0]?.reasons },
  );
  restoreEvents();

  // 复审反例：同长度改写并恢复 mtime，仍须按内容失效。
  const eventFile = eventStoreMod.eventsPath(workDir);
  const fixedTime = new Date("2026-10-02T00:00:00.000Z");
  fs.utimesSync(eventFile, fixedTime, fixedTime);
  const changedEvents = rawEvents.replace('"fixture"', '"fixturE"');
  ok(changedEvents !== rawEvents && Buffer.byteLength(changedEvents) === Buffer.byteLength(rawEvents), "E-3 同长度业务事实改写夹具成立");
  graphCalls = 0;
  afterBuild = (n) => { if (n === 1) { write(eventFile, changedEvents); fs.utimesSync(eventFile, fixedTime, fixedTime); } };
  syncMod.readSyncStatus(PID, dataDir);
  afterBuild = null;
  ok(graphCalls === 2, "E-4 同长度且mtime不变的业务事件改写仍触发重建", { graphCalls });
  restoreEvents();

  // ═══ F 源身份不可核实（图输入有界读取异常）→ 不复用、不判通过 ═══
  fs.rmSync(MODULES_ABS, { force: true });
  fs.mkdirSync(MODULES_ABS, { recursive: true });
  graphCalls = 0;
  const reportF = syncMod.readSyncStatus(PID, dataDir);
  const activeF = reportF.batches.filter((b) => b.active).length;
  ok(graphCalls === activeF, "F-1 源身份不可核实（图输入非常规文件）→ 不复用，逐现行批次真建（历史批次不走实时求值）", { graphCalls, activeF });
  ok(
    reportF.batches.filter((b) => b.active).every((b) => b.items[0].verdict !== "passed"),
    "F-2 图输入读取异常绝不当通过",
    reportF.batches.map((b) => [b.batch_id, b.active, b.items[0].verdict]),
  );
  fs.rmdirSync(MODULES_ABS);
  write(MODULES_ABS, modulesBefore);

  // ═══ G 锁内有界路径（graphSourceOnly）不跑全量，且 actual 与全量逐字段一致 ═══
  graphCalls = 0;
  const lockCtx = {
    projectId: PID,
    projectRoot: root,
    workDir,
    dataDir,
    events: eventStoreMod.loadEvents(workDir).events,
    graphProbe: probeMod.syncGraphProbe(),
    graphSourceProbe: probeMod.syncGraphSourceProbe(),
    graphSourceOnly: true,
    byteBudget: { limit: contractMod.SYNC_LOCK_REVIEW_MAX_BYTES, used: 0 },
  };
  const r2Contract = frozen.get("r2");
  if (r2Contract === undefined) throw new Error("夹具缺 r2 契约");
  const sourceOnlyEval = checksMod.evaluateBatch(r2Contract, regSeq.get("r2") ?? 1, { path: `.工作台/work/sync-inbox/r2.evidence.json`, abs: path.join(inbox, "r2.evidence.json") }, lockCtx as never);
  ok(graphCalls === 0, "G-1 graphSourceOnly 不调用全量 sixGraphsOf", { graphCalls });
  ok(
    eq(sourceOnlyEval.items[0].actual, reportA.batches.find((b) => b.batch_id === "r2")?.items[0].actual),
    "G-2 锁内有界图项 actual 与全量模式逐字段一致（现行批次）",
    { sourceOnly: sourceOnlyEval.items[0].actual, full: reportA.batches.find((b) => b.batch_id === "r2")?.items[0].actual },
  );

  // ═══ H hostSyncView 不可达分支：已配置 fail-closed 且只构造一次；未配置保持 not_configured ═══
  const unreachableWork = { readSyncStatusRemote: async () => null } as never;
  graphCalls = 0;
  const view = await syncHostMod.hostSyncView(PID, dataDir, unreachableWork);
  ok(graphCalls === 1, "H-1 宿主不可达且已配置：同源一次构造（只一次六图构建）", { graphCalls });
  ok(view.host_reachable === false && view.discovery_issues.length === 1 && view.discovery_issues[0].includes("无法核对唯一宿主后台发现健康"), "H-2 合成 fail-closed 发现错误只有一条", view.discovery_issues);
  ok(view.report.configured === true && view.report.overall !== "passed", "H-3 已配置项目 fail-closed（overall 非 passed）", { overall: view.report.overall });
  const expectedH = syncMod.readSyncStatus(PID, dataDir, { discoveryIssues: view.discovery_issues });
  ok(eq(view.report, expectedH), "H-4 一次构造的报告与「明确 issue 注入」语义逐字段一致");
  ok(view.report.batches.length === 6, "H-5 不可达时仍保留全部批次", { got: view.report.batches.length });
  const viewOld = await syncHostMod.hostSyncView(OLDPID, dataDir, unreachableWork);
  ok(viewOld.report.configured === false && viewOld.report.overall === "not_configured", "H-6 未配置旧项目保持 not_configured", { overall: viewOld.report.overall });
  ok(viewOld.report.batches.length === 0 && viewOld.report.scan_error === null && viewOld.discovery_issues.length === 0, "H-7 未配置旧项目零影响（无合成发现错误、无 scan_error）", { scan_error: viewOld.report.scan_error });

  info(`\n[verify] 结果：PASS ${passCount} · FAIL ${failCount}`);
  if (failCount === 0) info("[verify] 全部通过：request-reuse 专项回归");
}

void main().catch((e) => {
  console.error(`[verify] 夹具/脚本异常：${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  process.exitCode = 1;
});
