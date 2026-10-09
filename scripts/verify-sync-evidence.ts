// 同步证据发现与完整性验收 · 专项验证（PLAN V09-23；DESIGN.md §2.10；docs/sync-evidence-contract.md）。
//
// ⚠ 本脚本是**先红后绿**里的"先红"：按规范**独立写成**，先在 NOT_IMPLEMENTED 空壳上跑出清楚的
// **行为红**（每段独立跑，抛 NOT_IMPLEMENTED 的段如实记 FAIL 而不是整脚本中断），再照规范重建实现把它转绿。
// 规范来源：docs/sync-evidence-contract.md（含 A/B/D/E/F 新定版）＋ .工作台/verify/sync-evidence-20260930/design-review/findings.md。
//
// 覆盖：A 未配置兼容；B 登记面（闭键/来源实核/幂等/权限）；C supersedes 不得缩小分母；
// D 发现与逐项裁决（passed/missing/failed/半写/坏字段/未知字段/转义同名键/遍历/junction/自引用）；
// E task_states scope_mode（at_registration 历史断言不被未来合法推进阻塞；current 随目标变）；
// F 目标漂移 + 同步指纹自洽 + 并发零重复；G 接续阻断（entry/claim/直连写口/伪造/解阻/复阻）；
// H graph_full 真实 builder + 无递归（collectProjectFacts 不引 sync）；I 后台发现生命周期；
// J HTTP 读口同判据；K MCP 三接口。
//
// 隔离口径（AGENTS.md §5）：mkdtemp 夹具 + 隔离 TATAI_HOME + 本进程回环 HTTP（随机端口）＋
// 独立 stdio MCP 子进程；不碰真实 ~/.tatai、不碰真实项目与账本、不接网关、不调模型；收尾杀子进程 + 删临时目录。
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
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
const sha256 = (d: string | Buffer): string => crypto.createHash("sha256").update(d).digest("hex");
const sha256File = (f: string): string => sha256(fs.readFileSync(f));
const mkdirp = (d: string): void => {
  fs.mkdirSync(d, { recursive: true });
};
const write = (f: string, t: string): void => { mkdirp(path.dirname(f)); fs.writeFileSync(f, t, "utf8"); };
const writeJson = (f: string, v: unknown): void => write(f, `${JSON.stringify(v, null, 2)}\n`);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");
const MCP_ENTRY = path.join(SRC, "mcp", "index.ts");
const loadSrc = async <T>(rel: string): Promise<T> => (await import(pathToFileURL(path.join(SRC, rel)).href)) as T;

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-sync-verify-"));
const dataDir = path.join(tmpBase, "home");
const root = path.join(tmpBase, "proj-sync");
const oldRoot = path.join(tmpBase, "proj-old");
const outsideDir = path.join(tmpBase, "outside");
const workDir = path.join(root, ".工作台", "work");
const inbox = path.join(workDir, "sync-inbox");
const PLAN_REL = ".工作台/plan.md";
const TOTAL_REL = "docs/项目总图.md";
const AGENTS_REL = "AGENTS.md";
const RECEIPT_REL = "receipts/b1.json";
const REPORT_REL = "reports/result.md";
const TOTAL_ABS = path.join(root, "docs", "项目总图.md");
const AGENTS_ABS = path.join(root, "AGENTS.md");
const RECEIPT_ABS = path.join(root, "receipts", "b1.json");
const REPORT_ABS = path.join(root, "reports", "result.md");
const PLAN_ABS = path.join(root, PLAN_REL);
const PID = "syncfx";
const OLDPID = "syncfx-old";
const CHG = "chg-sync";

interface Card { id: string; goal: string; dep?: string; role: string }
const planText = (title: string, cards: Card[]): string => {
  const L = [`# ${title}`, "", "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |", "| --- | --- | --- | --- | --- |"];
  for (const c of cards) L.push(`| ${c.id} | todo | ${c.goal} | ${c.dep ?? ""} | ${c.id} 的完成证据 |`);
  L.push("");
  for (const c of cards) L.push(`### ${c.id} ${c.goal}`, "", `**设计依据**：§1。**依赖**：${c.dep ?? "无"}。**文件责任**：\`src/${c.id.toLowerCase()}.ts\`。**责任角色**：${c.role}。`, "", `- [ ] ${c.goal} 达标`, "");
  return L.join("\n");
};
const CARDS: Card[] = [
  { id: "T-1", goal: "夹具卡一", role: "executor" },
  { id: "T-2", goal: "夹具卡二", dep: "T-1", role: "executor" },
  { id: "T-3", goal: "夹具卡三", role: "executor" },
  { id: "T-4", goal: "夹具设计卡", role: "designer" },
  { id: "T-5", goal: "夹具卡五", role: "executor" },
  { id: "T-6", goal: "夹具卡六", role: "executor" },
];
const PLAN_TEXT = planText("同步证据验证施工图", CARDS);

async function main(): Promise<void> {
  info(`同步证据发现与完整性验收 · 专项验证（${process.platform} · node ${process.version}）`);
  info(`  夹具根 ${tmpBase}（隔离 TATAI_HOME ${dataDir}）`);

  const sixGraphsMod = await loadSrc<typeof import("../src/arch/sixGraphs")>("arch/sixGraphs.ts");
  const syncMod = await loadSrc<typeof import("../src/server/work/sync")>("server/work/sync.ts");
  const syncProbeMod = await loadSrc<typeof import("../src/server/work/syncProbe")>("server/work/syncProbe.ts");
  const syncHealthMod = await loadSrc<typeof import("../src/server/work/syncRuntimeHealth")>("server/work/syncRuntimeHealth.ts");
  const syncDiscoveryMod = await loadSrc<typeof import("../src/server/work/syncDiscovery")>("server/work/syncDiscovery.ts");
  const syncHttpMod = await loadSrc<typeof import("../src/server/work/syncHttp")>("server/work/syncHttp.ts");
  const serviceMod = await loadSrc<typeof import("../src/server/work/service")>("server/work/service.ts");
  const entryMod = await loadSrc<typeof import("../src/server/work/entry")>("server/work/entry.ts");
  const claimsMod = await loadSrc<typeof import("../src/server/work/claims")>("server/work/claims.ts");
  const tasksMod = await loadSrc<typeof import("../src/server/work/tasks")>("server/work/tasks.ts");
  const documentsMod = await loadSrc<typeof import("../src/server/work/documents")>("server/work/documents.ts");
  const referencesMod = await loadSrc<typeof import("../src/server/work/references")>("server/work/references.ts");
  const registryMod = await loadSrc<typeof import("../src/server/registry")>("server/registry.ts");
  const typesMod = await loadSrc<typeof import("../src/server/work/types")>("server/work/types.ts");
  const blueprintMod = await loadSrc<typeof import("../src/arch/blueprint")>("arch/blueprint.ts");
  const eventStoreMod = await loadSrc<typeof import("../src/server/work/eventStore")>("server/work/eventStore.ts");
  type StatusReport = ReturnType<typeof syncMod.readSyncStatus>;

  // ═══ 夹具 ═══
  console.log("[verify] ── 0. 夹具、唯一写入服务与 MCP 面");
  mkdirp(dataDir);
  mkdirp(outsideDir);
  writeJson(path.join(outsideDir, "total.md"), { note: "项目根外文件（遍历/junction 逃逸反例）" });
  write(path.join(root, ".工作台", "design.md"), "# 同步证据验证设计书\n\n## 1 目标\n\n夹具设计正文。\n");
  write(path.join(root, PLAN_REL), PLAN_TEXT);
  write(TOTAL_ABS, "# 夹具项目总图\n\n## 3 当前阶段\n\n夹具总图正文。\n");
  write(AGENTS_ABS, "# 夹具工作规则\n\n1. 开工先读总图。\n");
  writeJson(RECEIPT_ABS, { result: "ok", detail: "夹具回执" });
  write(REPORT_ABS, "夹具报告：本次同步证据包引用的真实 artifact。\n");
  writeJson(path.join(workDir, "stage-reads.json"), {
    schema_version: 1,
    generated_from: [{ path: TOTAL_REL, sha256: sha256File(TOTAL_ABS) }],
    entries: [
      { path: TOTAL_REL, kind: "evidence", why: "总图", revision: sha256File(TOTAL_ABS) },
      { path: AGENTS_REL, kind: "evidence", why: "规则", revision: sha256File(AGENTS_ABS) },
    ],
  });
  const linkPath = path.join(root, "link-out");
  let symlinkReady = false;
  try { fs.symlinkSync(outsideDir, linkPath, "junction"); symlinkReady = true; } catch (e) { info(`  [环境] junction 创建失败：${e instanceof Error ? e.message : String(e)}（junction 反例如实记未跑）`); }
  write(path.join(oldRoot, ".工作台", "design.md"), "# 旧项目设计书\n\n## 1 目标\n\n旧项目正文。\n");
  const oldPlan = planText("旧项目施工图", [{ id: "O-1", goal: "旧卡一", role: "executor" }]);
  write(path.join(oldRoot, PLAN_REL), oldPlan);

  const service = new serviceMod.WorkService({ dataDir });
  // 记录每个批次最近一条 sync.evidence_checked 命令（L 段用它做「锁外独立预评估 / 锁内不跑全量图」的确定性复核）
  const evidenceCmds = new Map<string, any>();
  const submitter = {
    submit: (c: unknown) => {
      const cmd = c as { type?: string; payload?: { batch_id?: string } } | null;
      if (cmd?.type === "sync.evidence_checked" && typeof cmd.payload?.batch_id === "string") evidenceCmds.set(cmd.payload.batch_id, c);
      return service.submit(c);
    },
  };
  const token = crypto.randomBytes(18).toString("base64url");
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (syncHttpMod.handleSyncStatusRoute(req, res, pathname, dataDir)) return;
    void serviceMod.handleWorkRequest(req, res, { service, token, pathname }).then((handled) => { if (!handled) { res.writeHead(404); res.end(); } });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  serviceMod.writeServiceDescriptor(dataDir, { schema_version: typesMod.SCHEMA_VERSION, pid: process.pid, host: "127.0.0.1", port, token, started_at: new Date().toISOString(), url: `http://127.0.0.1:${port}` });
  registryMod.addProject({ id: PID, name: "同步证据夹具", path: root, kind: "backend" }, dataDir);
  registryMod.addProject({ id: OLDPID, name: "旧项目夹具", path: oldRoot, kind: "backend" }, dataDir);
  tasksMod.submitDefinitionImports(submitter, { project_id: PID, change_id: CHG, actor_id: "fixture", role: "coordinator", definitions: referencesMod.importPlanChecked(PLAN_TEXT, workDir).definitions });
  tasksMod.submitDefinitionImports(submitter, { project_id: OLDPID, change_id: CHG, actor_id: "fixture", role: "coordinator", definitions: referencesMod.importPlanChecked(oldPlan, path.join(oldRoot, ".工作台", "work")).definitions });
  documentsMod.activateBaseline(PID, { approved_by: "user", approval_basis: "同步证据夹具审定", approval_kind: "user_confirmed" }, dataDir);
  documentsMod.activateBaseline(OLDPID, { approved_by: "user", approval_basis: "旧项目夹具审定", approval_kind: "user_confirmed" }, dataDir);

  const revOf = (taskId: string): number | null => tasksMod.readTaskStates(workDir).states[taskId]?.revision ?? null;
  // 夹具：`result_submitted` 是**历史/迁移状态**（造"登记前已交付"的现场），不是一次新交付——走**既有状态边界**
  // `task.status_changed` + `payload.status`（`migrate.ts` 把 v1 `done` 折成 `result_submitted` 的同一形态）；
  // `task.result_submitted` 是交付提交事件，只由带合法认领 + 证据的提交写入（P2/V09-47 锁内共享判据），
  // 夹具不冒充交付提交（本项不测试新交付）。
  let fixtureStatusSeq = 0;
  const setStatus = (taskId: string, status: string, reason?: string): void => {
    const expectedRevision = revOf(taskId);
    if (status === "result_submitted") {
      fixtureStatusSeq += 1;
      submitter.submit({
        schema_version: typesMod.SCHEMA_VERSION,
        project_id: PID,
        change_id: CHG,
        entity_id: `task:${taskId}`,
        expected_revision: expectedRevision,
        type: "task.status_changed",
        actor_id: "fixture",
        role: "coordinator",
        idempotency_key: `fixture-hist-status:${taskId}:result_submitted:${expectedRevision}:${fixtureStatusSeq}`,
        payload: { status, ...(reason === undefined ? {} : { reason }) },
      });
      return;
    }
    tasksMod.submitTaskStatus(submitter, { project_id: PID, task_id: taskId, change_id: CHG, actor_id: "fixture", role: "coordinator", expected_revision: expectedRevision, status: status as never, ...(reason === undefined ? {} : { reason }) });
  };
  setStatus("T-1", "result_submitted", "夹具：登记前已交付");
  // 夹具代码层采集（graph_full 正向例：modules.json + budget_exhausted=false ⇒ collection complete）
  writeJson(path.join(root, ".工作台", "arch", "modules.json"), {
    version: 1,
    generated_at: new Date().toISOString(),
    budget_exhausted: false,
    modules: [
      { id: "src", name: "", path: "src", file_count: 2, loc: 0, deps: [{ to: "lib", weight: 1 }] },
      { id: "lib", name: "", path: "lib", file_count: 1, loc: 0, deps: [] },
    ],
  });
  let graphPublished = false;
  try {
    const r = await blueprintMod.rebuildBlueprint(PID, { dataDir, trigger: "baseline_activated" });
    graphPublished = r.publish.published === true;
    info(`  规划图发布：published=${graphPublished}${graphPublished ? "" : `（reason=${r.publish.reason}）`}`);
  } catch (e) { info(`  规划图发布异常（graph_full 正向例如实记未跑）：${e instanceof Error ? e.message : String(e)}`); }

  const eventsOf = () => (fs.existsSync(path.join(workDir, "events.jsonl")) ? eventStoreMod.loadEvents(workDir).events.map((e) => ({ seq: e.seq, type: e.type })) : []);
  const syncEventCount = (): number => eventsOf().filter((e) => e.type.startsWith("sync.")).length;
  const statusOf = (): StatusReport => syncMod.readSyncStatus(PID, dataDir);
  const batchOf = (r: StatusReport, id: string): any => (r.batches as any[]).find((b) => b.batch_id === id);
  const scanOf = () => syncMod.scanSyncProject({ projectId: PID, dataDir, submitter });
  const entryOf = (role: string, extra: Record<string, unknown> = {}): any => entryMod.evaluateProjectEntry({ project_id: PID, role, ...extra } as never, { dataDir });
  const reasonCodes = (e: any): string[] => (e?.reasons ?? []).map((r: any) => r.code);
  const contractSha = (id: string): string => batchOf(statusOf(), id)?.contract_sha256 ?? "";

  const fileHashCheck = (rel: string, abs: string): Record<string, unknown> => ({ type: "file_hash", path: rel, sha256: sha256File(abs) });
  const happyItems = (): any[] => [
    { id: "src", label: "总图来源", required: true, check: fileHashCheck(TOTAL_REL, TOTAL_ABS) },
    { id: "receipt", label: "回执字段", required: true, check: { type: "json_value", path: RECEIPT_REL, pointer: "/result", expected: "ok" } },
    { id: "states", label: "历史任务状态", required: true, check: { type: "task_states", scope_mode: "at_registration", expected: { "T-1": "result_submitted" } } },
    { id: "reads", label: "阶段必读", required: true, check: { type: "required_reads", expected: [{ path: TOTAL_REL }, { path: AGENTS_REL }] } },
  ];
  const mkContract = (batchId: string, items: unknown[], extra: Record<string, unknown> = {}, blocks = false): Record<string, unknown> => ({ schema_version: 1, batch_id: batchId, project_id: PID, title: `批次 ${batchId}`, sources: [{ path: TOTAL_REL, sha256: sha256File(TOTAL_ABS) }], items, blocks_entry: blocks, ...extra });
  const mkEvidence = (batchId: string, csha: string, items: { id: string; result: string; artifacts?: { path: string; sha256: string }[] }[], extra: Record<string, unknown> = {}): Record<string, unknown> => ({ schema_version: 1, batch_id: batchId, project_id: PID, contract_sha256: csha, completed: true, items: items.map((it) => ({ id: it.id, result: it.result, artifacts: it.artifacts ?? [{ path: REPORT_REL, sha256: sha256File(REPORT_ABS) }] })), ...extra });
  const postEvidence = (batchId: string, pkg: unknown): void => {
    const tmp = path.join(inbox, `.${batchId}.evidence.json.tmp-${crypto.randomBytes(3).toString("hex")}`);
    mkdirp(inbox);
    fs.writeFileSync(tmp, typeof pkg === "string" ? pkg : `${JSON.stringify(pkg, null, 2)}\n`);
    fs.renameSync(tmp, path.join(inbox, `${batchId}.evidence.json`));
  };
  const rmEvidence = (batchId: string): void => fs.rmSync(path.join(inbox, `${batchId}.evidence.json`), { force: true });
  const pass4 = () => happyItems().map((it) => ({ id: it.id, result: "passed" }));

  // ── MCP stdio 客户端 ──
  interface RpcMsg { id?: number; result?: { content?: { text?: string }[]; isError?: boolean; serverInfo?: { name?: string }; tools?: { name: string }[] }; error?: unknown }
  const spawnMcp = () => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const k of Object.keys(env)) if (k.startsWith("TATAI_")) delete env[k];
    env.TATAI_HOME = dataDir;
    env.TATAI_NO_AUTOSTART = "1";
    const child: ChildProcess = spawn(process.execPath, ["--import", "tsx", MCP_ENTRY], { cwd: ROOT, env });
    let stderrBuf = "";
    child.stderr?.on("data", (d: Buffer) => (stderrBuf += d.toString("utf8")));
    let buf = "";
    const pending = new Map<number, (m: RpcMsg) => void>();
    let idc = 0;
    const send = (method: string, params: unknown): Promise<RpcMsg> =>
      new Promise((resolve, reject) => {
        const id = ++idc;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP 超时：${method}${stderrBuf === "" ? "" : `（stderr ${stderrBuf.slice(-200)}）`}`)); }, 60_000);
        pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
        child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    const notify = (method: string, params: unknown): void => { child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`); };
    child.stdout?.on("data", (d: Buffer) => {
      buf += d.toString("utf8");
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line === "") continue;
        let msg: RpcMsg;
        try { msg = JSON.parse(line) as RpcMsg; } catch { continue; }
        if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)!(msg); pending.delete(msg.id); }
      }
    });
    const callRaw = async (name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> => {
      const r = await send("tools/call", { name, arguments: args });
      if (r.error !== undefined) return { text: JSON.stringify(r.error), isError: true };
      return { text: r.result?.content?.[0]?.text ?? "", isError: r.result?.isError === true };
    };
    return {
      handshake: async (): Promise<void> => {
        const init = await send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "verify-sync-evidence", version: "1.0" } });
        notify("notifications/initialized", {});
        ok(init.error === undefined && typeof init.result?.serverInfo?.name === "string", "0-1 MCP stdio 子进程握手成功（真实 MCP 面）", { serverInfo: init.result?.serverInfo?.name, stderr: stderrBuf.slice(-200) });
      },
      listTools: async (): Promise<string[]> => (await send("tools/list", {})).result?.tools?.map((t) => t.name) ?? [],
      callRaw,
      callJson: async (name: string, args: Record<string, unknown>): Promise<unknown> => {
        const r = await callRaw(name, args);
        if (r.isError) throw new Error(`${name} isError：${r.text.slice(0, 300)}`);
        return JSON.parse(r.text) as unknown;
      },
      kill: (): void => { try { if (child.exitCode === null) child.kill(); } catch { /* 已退出 */ } },
    };
  };
  const mcp = spawnMcp();
  await mcp.handshake();
  const postCommand = (body: unknown): Promise<{ status: number; json: any }> =>
    new Promise((resolve, reject) => {
      const payload = JSON.stringify(body);
      const req = http.request({ host: "127.0.0.1", port, path: "/api/work/command", method: "POST", headers: { "content-type": "application/json", [serviceMod.WORK_TOKEN_HEADER]: token, "content-length": Buffer.byteLength(payload) } }, (res) => {
        let text = "";
        res.on("data", (c: Buffer) => (text += c.toString("utf8")));
        res.on("end", () => { let json: any = {}; try { json = JSON.parse(text); } catch { json = { raw: text }; } resolve({ status: res.statusCode ?? 0, json }); });
      });
      req.on("error", reject);
      req.end(payload);
    });
  const forgedCommand = (type: string, entityId: string, payload: Record<string, unknown>, idem: string) => ({ schema_version: 2, project_id: PID, change_id: CHG, entity_id: entityId, expected_revision: null, type, actor_id: "forger", role: "executor", idempotency_key: idem, payload });
  const reg = (contract: unknown, role = "designer"): Promise<{ text: string; isError: boolean }> => mcp.callRaw("register_sync_contract", { project_id: PID, role, change_id: CHG, contract });

  // ═══ 分段执行（每段独立，段内异常记 FAIL 而不中断整脚本） ═══
  const runs: [string, () => Promise<void>][] = [];
  const sec = (label: string, fn: () => Promise<void>): void => { runs.push([label, fn]); };

  sec("A. 未配置/旧项目兼容 + 读口 not_configured", async () => {
    const s = statusOf();
    ok(s.configured === false && s.overall === "not_configured" && s.batches.length === 0, "A-1 无契约：configured=false / overall=not_configured / batches=[]", { configured: s.configured, overall: s.overall });
    ok(syncMod.computeSyncBlock(PID, dataDir).blocked === false, "A-2 无契约：computeSyncBlock.blocked=false（老项目零影响）");
    ok(entryOf("executor", { client_capabilities: "continuable" }).next_action === "claim_task", "A-3 无契约：project_entry 照常派活");
    ok(syncMod.readSyncStatus(OLDPID, dataDir).configured === false, "A-4 另一无契约项目：configured=false");
    ok(typesMod.registeredEventTypes().includes("sync.contract_registered") && typesMod.registeredEventTypes().includes("sync.evidence_checked"), "A-5 同步域两事件在登记表");
  });

  sec("B. 契约登记：闭键/来源实核/幂等/权限", async () => {
    const tools = await mcp.listTools();
    ok(["register_sync_contract", "scan_sync_evidence", "read_sync_status"].every((t) => tools.includes(t)), "B-0 MCP 暴露三个规范接口", { tools: tools.filter((t) => t.includes("sync")) });
    const r = await reg(mkContract("b-happy", happyItems()));
    ok(r.isError === false, "B-1 设计角色登记合法契约成功", { text: r.text.slice(0, 240) });
    const n1 = syncEventCount();
    ok(n1 === 1, "B-1b 登记恰产生 1 条 sync 事件", { count: n1 });
    ok((await reg(mkContract("b-happy", happyItems()))).isError === false && syncEventCount() === n1, "B-2 同内容重登记 → 幂等（零新增）", { count: syncEventCount() });
    ok((await reg(mkContract("b-happy", happyItems(), { title: "改了标题" }))).isError === true, "B-3 同 batch_id 改内容 → 拒");
    ok((await reg(mkContract("b-badsrc", happyItems(), { sources: [{ path: TOTAL_REL, sha256: sha256("no") }] }))).isError === true, "B-4 来源哈希漂移 → 登记拒（来源实核）");
    ok((await reg(mkContract("b-esc", happyItems(), { sources: [{ path: "../../outside/total.md", sha256: sha256File(path.join(outsideDir, "total.md")) }] }))).isError === true, "B-5a 来源路径遍历 → 拒");
    ok((await reg(mkContract("b-abs", happyItems(), { sources: [{ path: "C:/Windows/win.ini", sha256: sha256("x") }] }))).isError === true, "B-5b 绝对路径来源 → 拒");
    if (symlinkReady) ok((await reg(mkContract("b-link", happyItems(), { sources: [{ path: "link-out/total.md", sha256: sha256File(path.join(outsideDir, "total.md")) }] }))).isError === true, "B-5c 来源经 junction 逃逸 → 拒");
    else info("  [skip] B-5c junction 逃逸：环境不支持（如实记未跑）");
    ok((await reg(mkContract("b-unknown", happyItems(), { extra_field: 1 }))).isError === true, "B-6a 契约未知字段 → 拒（闭键）");
    ok((await reg('{"schema_version":1,"schema_version":1,"project_id":"syncfx"}')).isError === true, "B-6b 重复键 → 拒");
    ok((await reg('{"schema_version":1,"schema_versio\\u006e":1,"project_id":"syncfx"}')).isError === true, "B-6c 转义同名键 → 拒（JSON 语义解码后判定）");
    ok((await reg(mkContract("b-noreq", [{ id: "x", label: "非必需", required: false, check: fileHashCheck(TOTAL_REL, TOTAL_ABS) }]))).isError === true, "B-7 无必需项 → 拒");
    ok((await reg(mkContract("b-nonauth", happyItems()), "executor")).isError === true && (await reg(mkContract("b-nonauth2", happyItems()), "random")).isError === true, "B-8 非设计/协调器登记 → 拒");
    ok((await reg(mkContract("b-gate", happyItems(), {}, true))).isError === false, "B-9 blocks_entry=true 的门禁批次登记成功");
  });

  sec("C. supersedes：不得减少必需 id / 不得把 blocks_entry 改 false", async () => {
    const defItem = { id: "defs", label: "定义", required: true, check: { type: "task_definitions", source_plan: PLAN_REL, source_sha256: sha256File(PLAN_ABS), compare: { owner_role: true, dependency_ids: true } } };
    await reg(mkContract("b-sup-big", [...happyItems(), defItem]));
    const shrink = await reg(mkContract("b-sup-small", [happyItems()[0]], { supersedes: "b-sup-big" }));
    ok(shrink.isError === true && /states|reads|receipt|defs/.test(shrink.text), "C-1 缩小分母（少必需 id）→ 拒并点名被删项", { text: shrink.text.slice(0, 300) });
    ok((await reg(mkContract("b-gate-off", happyItems(), { supersedes: "b-gate" }, false))).isError === true, "C-2 blocks_entry true→false → 拒");
    ok((await reg(mkContract("b-sup-unk", happyItems(), { supersedes: "nope" }))).isError === true, "C-3 supersedes 指向不存在批次 → 拒");
    ok((await reg(mkContract("b-sup-ok", [...happyItems(), defItem], { supersedes: "b-sup-big" }))).isError === false, "C-4 合法 supersede（保留旧必需 id）→ 接受");
    ok(batchOf(statusOf(), "b-sup-big")?.active === false, "C-4b 被取代批次 active=false", { active: batchOf(statusOf(), "b-sup-big")?.active });
  });

  sec("D. 证据包发现与逐项裁决", async () => {
    const sha = contractSha("b-happy");
    ok(typeof sha === "string" && sha.length === 64, "D-0 读口给出契约冻结哈希", { sha: sha.slice(0, 12) });
    postEvidence("b-happy", mkEvidence("b-happy", sha, pass4()));
    let r = await scanOf();
    let b = batchOf(r.report, "b-happy");
    ok(b?.verdict === "passed" && b.items.every((i: any) => i.verdict === "passed"), "D-1 完整批次自动发现 → 逐项 passed / overall=passed", { verdict: b?.verdict, items: b?.items.map((i: any) => `${i.id}:${i.verdict}`) });
    postEvidence("b-sup-ok", mkEvidence("b-sup-ok", contractSha("b-sup-ok"), pass4().slice(0, 3)));
    r = await scanOf();
    b = batchOf(r.report, "b-sup-ok");
    ok(b?.items.find((i: any) => i.id === "reads")?.verdict === "missing" && b?.verdict !== "passed", "D-2 缺一个必需项 → 该项 missing、总体非 passed", { verdict: b?.verdict });
    write(RECEIPT_ABS, `${JSON.stringify({ result: "changed" })}\n`);
    b = batchOf((await scanOf()).report, "b-happy");
    ok(b?.items.find((i: any) => i.id === "receipt")?.verdict === "failed" && b?.verdict !== "passed", "D-3 实际目标与登记不等 → failed（不只看证据包声明）", { verdict: b?.verdict });
    writeJson(RECEIPT_ABS, { result: "ok", detail: "夹具回执" });
    postEvidence("b-happy", mkEvidence("b-happy", contractSha("b-happy"), pass4(), { completed: false }));
    ok(batchOf((await scanOf()).report, "b-happy")?.verdict !== "passed", "D-4 completed=false → 不放行");
    postEvidence("b-happy", mkEvidence("b-happy", contractSha("b-happy"), pass4()));
    ok(batchOf((await scanOf()).report, "b-happy")?.verdict === "passed", "D-4b 复原完整证据 → 重新 passed");
    const ssha = contractSha("b-sup-ok");
    const cases: [string, unknown][] = [
      ["D-5a 半写/坏 JSON 证据", `{"schema_version":1,"batch_id":"b-sup-ok",`],
      ["D-5b 重复 item_id", mkEvidence("b-sup-ok", ssha, [...pass4(), { id: "src", result: "passed" }])],
      ["D-5c 证据包未知字段", mkEvidence("b-sup-ok", ssha, pass4(), { bogus: 1 })],
      ["D-5d artifact 不存在/哈希不符", mkEvidence("b-sup-ok", ssha, happyItems().map((it) => ({ id: it.id, result: "passed", artifacts: [{ path: "nope/missing.md", sha256: sha256("x") }] })))],
    ];
    for (const [label, pkg] of cases) {
      postEvidence("b-sup-ok", pkg);
      ok(batchOf((await scanOf()).report, "b-sup-ok")?.verdict !== "passed", `${label} → 不放行`);
    }
    const selfRel = ".工作台/work/sync-inbox/self.md";
    write(path.join(root, selfRel), "自称通过的报告\n");
    postEvidence("b-sup-ok", mkEvidence("b-sup-ok", ssha, happyItems().map((it) => ({ id: it.id, result: "passed", artifacts: [{ path: selfRel, sha256: sha256File(path.join(root, selfRel)) }] }))));
    ok(batchOf((await scanOf()).report, "b-sup-ok")?.verdict !== "passed", "D-5e 收件目录内自引用 artifact → 不放行");
    postEvidence("b-unregistered", mkEvidence("b-unregistered", contractSha("b-happy"), pass4()));
    const rr = await scanOf();
    ok(rr.report.unregistered_evidence.some((u: any) => u.batch_id === "b-unregistered"), "D-6 未登记批次的证据 → 显式报告为 unregistered_evidence", { unregistered: rr.report.unregistered_evidence.map((u: any) => u.batch_id) });
    rmEvidence("b-unregistered");
  });

  sec("E. task_states scope_mode（历史断言不被未来合法推进阻塞）", async () => {
    const it = batchOf(statusOf(), "b-happy")?.items.find((i: any) => i.id === "states");
    ok(it !== undefined && typeof (it.actual as any)?.at_seq === "number", "E-0 at_registration 读口给出 at_seq", { actual: it?.actual });
    setStatus("T-1", "ready", "合法 reopen（重组）");
    await scanOf();
    const b = batchOf(statusOf(), "b-happy");
    ok(b?.items.find((i: any) => i.id === "states")?.verdict === "passed" && b?.verdict === "passed", "E-1 登记后合法推进（T-1 reopen）→ 历史断言仍 passed、总体不被拖成 blocked", { verdict: b?.verdict });
    await reg(mkContract("b-current", [{ id: "now", label: "当前状态", required: true, check: { type: "task_states", scope_mode: "current", expected: { "T-6": "preparing" } } }]));
    postEvidence("b-current", mkEvidence("b-current", contractSha("b-current"), [{ id: "now", result: "passed" }]));
    const before = batchOf((await scanOf()).report, "b-current")?.verdict;
    setStatus("T-6", "ready", "夹具：current 目标变化（ready 非续接态，不干扰后续 entry 判据）");
    const after = batchOf((await scanOf()).report, "b-current")?.verdict;
    ok(before === "passed" && after !== "passed", "E-2 current 模式：登记时通过、目标变化后非 passed", { before, after });
  });

  sec("F. 目标漂移、同步指纹自洽、并发零重复", async () => {
    const n = syncEventCount();
    await scanOf();
    await scanOf();
    ok(syncEventCount() === n, "F-1 连续扫描零新增事件（指纹不含自己 sync 事件序号/时间）", { before: n, after: syncEventCount() });
    const p = await Promise.all([scanOf(), scanOf()]);
    ok(p.length === 2, "F-2 并发扫描：完成且不抛", { n: p.length });
    const before = batchOf(statusOf(), "b-happy")?.verdict;
    write(TOTAL_ABS, "# 夹具项目总图（登记后被改）\n\n## 3 当前阶段\n\n改了来源。\n");
    ok(batchOf(statusOf(), "b-happy")?.verdict !== "passed", "F-3 登记来源被改 → 批次非 passed（来源漂移显式 stale）", { before });
    write(TOTAL_ABS, "# 夹具项目总图\n\n## 3 当前阶段\n\n夹具总图正文。\n");
    await scanOf();
    ok(batchOf(statusOf(), "b-happy")?.verdict === "passed", "F-3b 复原来源 → 批次重新 passed");
  });

  sec("G. 接续阻断：entry / claim / 直连写口 / 伪造 / 解阻 / 复阻", async () => {
    rmEvidence("b-gate");
    await scanOf();
    ok(syncMod.computeSyncBlock(PID, dataDir).blocked === true, "G-0 门禁批次缺证 → computeSyncBlock.blocked=true");
    const e = entryOf("executor", { client_capabilities: "continuable" });
    ok(e.next_action === "blocked" && reasonCodes(e).includes("sync_blocked"), "G-1 project_entry：next_action=blocked + sync_blocked 理由", { action: e.next_action, codes: reasonCodes(e) });
    ok(typeof e.sync_summary === "object" && e.sync_summary !== null, "G-1b project_entry 带 sync_summary（响应层拼）", { sync_summary: e.sync_summary });
    ok((e.required_reads ?? []).some((r: any) => String(r.path ?? "").includes("sync-inbox")), "G-1c 阻断时 required_reads 带出证据入口", { reads: (e.required_reads ?? []).map((r: any) => r.path) });
    const claim = await claimsMod.claimTask({ project_id: PID, task_id: "T-3", role: "executor", owner_id: "g1", change_id: CHG }, submitter, dataDir);
    ok((claim as any).ok !== true, "G-2 claimTask：阻断时认领被拒", { code: (claim as any).code });
    const direct = await postCommand({ schema_version: 2, project_id: PID, change_id: CHG, entity_id: "task:T-5", expected_revision: revOf("T-5"), type: "task.claimed", actor_id: "g3", role: "executor", idempotency_key: "g3-claim", payload: { run_id: "r", attempt_id: "a", owner_id: "g3", claim_token: "t", lease_expires_at: new Date(Date.now() + 3.6e6).toISOString() } });
    ok(direct.status !== 200 || direct.json.ok !== true, "G-3 直连 POST /api/work/command 手写 task.claimed：阻断时被拒、零字节", { status: direct.status, code: direct.json.code });
    const bf = batchOf(statusOf(), "b-gate");
    const forged = await postCommand(forgedCommand("sync.evidence_checked", "sync:b-gate", { batch_id: "b-gate", contract_sha256: bf?.contract_sha256 ?? "x", evidence_sha256: sha256("forged"), evidence_path: ".工作台/work/sync-inbox/b-gate.evidence.json", overall: "passed", target_fingerprint: "deadbeef", items: happyItems().map((it) => ({ id: it.id, required: true, verdict: "passed" })) }, "g4-forge"));
    ok(forged.status !== 200 || forged.json.ok !== true, "G-4 直连伪造 sync.evidence_checked（假 passed）→ 拒、零字节", { status: forged.status, code: forged.json.code });
    ok(syncMod.computeSyncBlock(PID, dataDir).blocked === true, "G-4b 伪造后门禁仍 blocked（没被旁路）");
    postEvidence("b-gate", mkEvidence("b-gate", contractSha("b-gate"), pass4()));
    await scanOf();
    ok(syncMod.computeSyncBlock(PID, dataDir).blocked === false, "G-5 补齐证据 → 门禁解阻（blocked=false）");
    const e2 = entryOf("executor", { client_capabilities: "continuable" });
    ok(e2.next_action === "claim_task", "G-5b 解阻后 project_entry 照常派活", { action: e2.next_action, codes: reasonCodes(e2) });
    const claim2 = await claimsMod.claimTask({ project_id: PID, task_id: "T-3", role: "executor", owner_id: "g5", change_id: CHG }, submitter, dataDir);
    ok((claim2 as any).ok === true, "G-5c 解阻后实际认领成功", { code: (claim2 as any).code });
    write(RECEIPT_ABS, `${JSON.stringify({ result: "changed" })}\n`);
    await scanOf();
    ok(syncMod.computeSyncBlock(PID, dataDir).blocked === true, "G-6 通过后改目标 → 重新 blocked（历史 passed ≠ 当前 passed）");
    const claim3 = await claimsMod.claimTask({ project_id: PID, task_id: "T-4", role: "designer", owner_id: "g6", change_id: CHG }, submitter, dataDir);
    ok((claim3 as any).ok !== true, "G-6b 复阻后认领再次被拒");
    writeJson(RECEIPT_ABS, { result: "ok", detail: "夹具回执" });
    await scanOf();
  });

  sec("H. graph_full 真实 builder + collectProjectFacts 不引 sync", async () => {
    const baselineId = entryOf("executor").baseline?.active?.baseline_id ?? "";
    const snap = sixGraphsMod.sixGraphsOf(PID, { dataDir, mode: "full" });
    const graphOk = graphPublished && snap.collection.status === "complete" && snap.anomalies.length === 0 && snap.baseline.baseline_id === baselineId;
    if (graphOk) {
      await reg(mkContract("b-graph-bad", [{ id: "g", label: "图", required: true, check: { type: "graph_full", expected_baseline_id: "bl-not-exist" } }]));
      postEvidence("b-graph-bad", mkEvidence("b-graph-bad", contractSha("b-graph-bad"), [{ id: "g", result: "passed" }]));
      ok(batchOf((await scanOf()).report, "b-graph-bad")?.verdict !== "passed", "H-1 graph_full 期望基线不符 → 非 passed（真实 builder 判定）");
      await reg(mkContract("b-graph-ok", [{ id: "g", label: "图", required: true, check: { type: "graph_full", expected_baseline_id: baselineId } }]));
      postEvidence("b-graph-ok", mkEvidence("b-graph-ok", contractSha("b-graph-ok"), [{ id: "g", result: "passed" }]));
      const b = batchOf((await scanOf()).report, "b-graph-ok");
      const actualStr = JSON.stringify(b?.items?.[0]?.actual ?? {});
      ok(b?.verdict === "passed", "H-1b graph_full 期望基线相符 → passed（六图 canonical builder 全量取齐）", { verdict: b?.verdict, reasons: b?.items?.[0]?.reasons });
      ok(!/\b614\b/.test(actualStr) && !/示例项目|demo-project/.test(actualStr), "H-2 graph_full 状态不写死某项目对象数（actual 无 614/示例项目硬编码）", { actual: actualStr.slice(0, 200) });
    } else {
      await reg(mkContract("b-graph-nopub", [{ id: "g", label: "图", required: true, check: { type: "graph_full", expected_baseline_id: baselineId || "bl-x" } }]));
      postEvidence("b-graph-nopub", mkEvidence("b-graph-nopub", contractSha("b-graph-nopub"), [{ id: "g", result: "passed" }]));
      const b = batchOf((await scanOf()).report, "b-graph-nopub");
      ok(b?.verdict !== "passed", "H-1（夹具图不完整/未发布）graph_full fail-closed → 非 passed（绝不冒充全量）", { verdict: b?.verdict, reasons: b?.items?.[0]?.reasons });
      info(`  [说明] 夹具图 collection=${snap.collection.status} anomalies=${snap.anomalies.length} → graph_full 正向例记未跑（正向依赖真实完整图，属 V09-25 示例项目实测范围）`);
    }
    const sp = fs.readFileSync(path.join(SRC, "server/work/statusProjection.ts"), "utf8");
    ok(!/from\s+"\.[./]*sync"/.test(sp) && !/computeSyncBlock/.test(sp), "H-3 collectProjectFacts（statusProjection.ts）不引 sync（无反向依赖/递归）");
    const started = Date.now();
    let threw = "";
    try {
      for (let i = 0; i < 3; i++) {
        syncMod.readSyncStatus(PID, dataDir);
        entryMod.evaluateProjectEntry({ project_id: PID, role: "executor" } as never, { dataDir });
      }
    } catch (e) {
      threw = e instanceof Error ? e.message : String(e);
    }
    ok(threw === "" && Date.now() - started < 30_000, "H-4 read+entry 互调 0 递归 0 超时", { threw, ms: Date.now() - started });
  });

  sec("I. 后台自动发现：启动扫既有包 / 一个包恰 1 事件 / 连扫 0 新增 / 关闭无残留", async () => {
    rmEvidence("b-happy");
    await scanOf();
    postEvidence("b-happy", mkEvidence("b-happy", contractSha("b-happy"), pass4()));
    syncDiscoveryMod.startSyncDiscovery({ service, dataDir });
    await sleep(1500);
    const st1 = syncDiscoveryMod.syncDiscoveryStatus();
    ok(st1.running === true, "I-1 后台发现在唯一写服务宿主启动（running=true）", { st1 });
    ok(syncEventCount() >= 1, "I-1b 启动扫既有包（未选项目也发现）：至少一条 evidence_checked", { n: syncEventCount() });
    postEvidence("b-sup-new", mkEvidence("b-sup-new", contractSha("b-sup-ok"), pass4()));
    await reg(mkContract("b-disc", happyItems()));
    const beforeNew = syncEventCount();
    postEvidence("b-disc", mkEvidence("b-disc", contractSha("b-disc"), pass4()));
    await sleep(1500);
    ok(syncEventCount() === beforeNew + 1, "I-2 inbox 新增一个已登记批次的包 → 恰 1 条事件（未登记包不产事件）", { before: beforeNew, after: syncEventCount() });
    postEvidence("b-disc", mkEvidence("b-disc", contractSha("b-disc"), pass4()));
    await sleep(1500);
    ok(syncEventCount() === beforeNew + 1, "I-3 重复通知/连扫 → 0 新增事件", { after: syncEventCount() });
    syncDiscoveryMod.stopSyncDiscovery();
    const st2 = syncDiscoveryMod.syncDiscoveryStatus();
    ok(st2.running === false && st2.watchers === 0, "I-4 stopSyncDiscovery：running=false、watchers=0（关闭无监听残留）", { st2 });
    const before2 = syncEventCount();
    postEvidence("b-disc", mkEvidence("b-disc", contractSha("b-disc"), pass4()));
    await sleep(900);
    ok(syncEventCount() === before2, "I-4b 停止后新包不再产事件（监听确已关闭）");
    syncDiscoveryMod.startSyncDiscovery({ service, dataDir });
    await sleep(500);
    ok(syncDiscoveryMod.syncDiscoveryStatus().running === true, "I-5 幂等重启：running=true");
    syncDiscoveryMod.stopSyncDiscovery();
  });

  sec("J. HTTP GET /api/projects/:id/sync-status（只读、同判据）", async () => {
    const httpGet = (p: string): Promise<{ status: number; json: any }> =>
      new Promise((resolve, reject) => {
        http.get({ host: "127.0.0.1", port, path: p }, (res) => {
          let t = "";
          res.on("data", (c: Buffer) => (t += c.toString("utf8")));
          res.on("end", () => { let j: any = {}; try { j = JSON.parse(t); } catch { j = { raw: t }; } resolve({ status: res.statusCode ?? 0, json: j }); });
        }).on("error", reject);
      });
    const r = await httpGet(`/api/projects/${PID}/sync-status`);
    const live = statusOf();
    ok(r.status === 200 && r.json.ok === true && typeof r.json.sync === "object", "J-1 HTTP 读口返回 {ok:true, sync:{…}}", { status: r.status, keys: Object.keys(r.json) });
    ok(r.json.sync?.overall === live.overall && r.json.sync?.configured === live.configured, "J-2 HTTP 与进程内 readSyncStatus 同判据", { http: r.json.sync?.overall, live: live.overall });
    const nothing = await httpGet(`/api/projects/${PID}/nope`);
    ok(nothing.status !== 200 || nothing.json.sync === undefined, "J-3 非 sync-status 路径不被本路由吞掉", { status: nothing.status });
  });

  sec("K. MCP：read_sync_status / scan_sync_evidence", async () => {
    const readJson = (await mcp.callJson("read_sync_status", { project_id: PID })) as any;
    ok(readJson?.overall === statusOf().overall, "K-1 read_sync_status 与进程内读口同判据", { mcp: readJson?.overall, live: statusOf().overall });
    const scanRes = await mcp.callRaw("scan_sync_evidence", { project_id: PID, role: "coordinator" });
    ok(scanRes.isError === false, "K-2 scan_sync_evidence 显式扫描成功（与后台共判据）", { text: scanRes.text.slice(0, 200) });
    const scanRead = (await mcp.callJson("scan_sync_evidence", { project_id: PID, role: "coordinator" })) as any;
    ok(typeof scanRead?.report?.overall === "string", "K-2b scan_sync_evidence 返回同一份 state 契约（report.overall）", { overall: scanRead?.report?.overall });
  });

  sec("L. A 返工回归：真源独立漂移 / 未知额外 item / collection / 晚交包 / 锁边界 / 图基线有效", async () => {
    // 隔离：确保后台发现已停（I 段若异常会留下在途扫描，污染 L-7 的探针计数）；清后台错误汇（I 段真实瞬错不干扰 L）
    try { await syncDiscoveryMod.stopSyncDiscovery(); } catch { /* 未启动 */ }
    syncHealthMod.clearSyncDiscoveryIssues(dataDir);
    await sleep(300);
    // L-1 真正「来源」独立漂移：合同来源**不是任何 check 目标**（弱反例把来源也当 file_hash 目标——不算数）
    const scopeRel = ".工作台/work/scope-a.md";
    const scopeAbs = path.join(root, scopeRel);
    write(scopeAbs, "原始工作范围 A\n");
    await reg(mkContract("b-src-drift", [{ id: "t", label: "目标", required: true, check: fileHashCheck(REPORT_REL, REPORT_ABS) }], { sources: [{ path: scopeRel, sha256: sha256File(scopeAbs) }] }, true));
    postEvidence("b-src-drift", mkEvidence("b-src-drift", contractSha("b-src-drift"), [{ id: "t", result: "passed" }]));
    await scanOf();
    ok(batchOf(statusOf(), "b-src-drift")?.verdict === "passed", "L-1 来源非 check 目标时正向仍 passed");
    write(scopeAbs, "范围在登记后改了\n");
    const drv = batchOf(statusOf(), "b-src-drift")?.verdict;
    ok(drv === "stale", "L-1b 真源独立漂移（非 check 目标）→ stale（不拿弱反例充数）", { verdict: drv });
    ok(syncMod.computeSyncBlock(PID, dataDir).blocked === true, "L-1c 真源独立漂移 → claim 门禁 blocked");
    write(scopeAbs, "原始工作范围 A\n");
    await scanOf();

    // L-2 未知额外 item → 整包 invalid（不只列原因仍判通过）
    const ssha2 = contractSha("b-sup-ok");
    postEvidence("b-sup-ok", mkEvidence("b-sup-ok", ssha2, [...happyItems().map((it) => ({ id: it.id, result: "passed" })), { id: "ghost", result: "passed" }]));
    const gv = batchOf((await scanOf()).report, "b-sup-ok")?.verdict;
    ok(gv === "invalid", "L-2 证据包多出未登记 item → 整包 invalid", { verdict: gv });
    postEvidence("b-sup-ok", mkEvidence("b-sup-ok", ssha2, happyItems().map((it) => ({ id: it.id, result: "passed" }))));
    await scanOf();

    // L-3 collection 未取齐 → read overall 非 passed 且 claim 门禁 blocked（有界，不截断后报通过）
    for (let i = 0; i < 513; i++) write(path.join(inbox, `z-${String(i).padStart(3, "0")}.evidence.json`), "{}");
    const coll = statusOf();
    ok(coll.collection.complete === false && coll.overall !== "passed", "L-3 收件目录超过文件数上限 → collection 未取齐、overall 非 passed", { overall: coll.overall, complete: coll.collection.complete });
    ok(syncMod.computeSyncBlock(PID, dataDir).blocked === true, "L-3b collection 未取齐 → claim 门禁 blocked（不只看单批）");
    for (let i = 0; i < 513; i++) fs.rmSync(path.join(inbox, `z-${String(i).padStart(3, "0")}.evidence.json`), { force: true });
    await scanOf();
    ok(statusOf().collection.complete === true, "L-3c 清掉越界文件后 collection 恢复完整");

    // L-4 已注册项目**晚交包**：后登记契约 + 后交证据被同逻辑发现（后台/显式同判据）
    ok(syncMod.projectHasSyncContract(PID, dataDir) === true, "L-4 已注册项目有契约/inbox → projectHasSyncContract=true（后台增量发现依据）");
    ok(syncMod.projectHasSyncContract(OLDPID, dataDir) === false, "L-4b 无契约无 inbox 的项目 → false（旧项目零影响）");
    const beforeLate = syncEventCount();
    const lateItems = happyItems().filter((it) => it.id !== "states"); // 晚登记：states 的 at_registration 截点已在 T-1 reopen 之后
    await reg(mkContract("b-late", lateItems));
    postEvidence("b-late", mkEvidence("b-late", contractSha("b-late"), lateItems.map((it) => ({ id: it.id, result: "passed" }))));
    await scanOf();
    const lateBatch = batchOf(statusOf(), "b-late");
    ok(syncEventCount() >= beforeLate + 1 && lateBatch?.verdict === "passed", "L-4c 晚登记契约 + 晚交包被同一逻辑发现并通过", { before: beforeLate, after: syncEventCount(), verdict: lateBatch?.verdict, items: lateBatch?.items?.map((i: any) => `${i.id}:${i.verdict}`) });

    // L-6 计算后改目标：重放一条曾正确的命令（新幂等键/当前版本）→ 独立预评估按当前目标拒（零字节）
    postEvidence("b-src-drift", mkEvidence("b-src-drift", contractSha("b-src-drift"), [{ id: "t", result: "passed" }]));
    await scanOf();
    const replayBase = evidenceCmds.get("b-src-drift");
    ok(replayBase !== undefined && replayBase.entity_id === "sync:b-src-drift", "L-6 拿到 b-src-drift 最近一条 sync.evidence_checked 命令（供重放）", { entity: replayBase?.entity_id });
    write(REPORT_ABS, `夹具报告：计算后目标被改。\n`);
    const replay = { ...replayBase, idempotency_key: `${replayBase.idempotency_key}-replay`, expected_revision: syncMod.syncEntityRevision(PID, dataDir, "b-src-drift") };
    const replayRes = await postCommand(replay);
    ok(replayRes.status !== 200 || replayRes.json.ok !== true, "L-6b 计算后改目标 → 重放被独立预评估拒、零字节", { status: replayRes.status, code: replayRes.json.code });
    write(REPORT_ABS, "夹具报告：本次同步证据包引用的真实 artifact。\n");
    await scanOf();

    // L-7 持锁主进程**不跑 sixGraphsOf 全量**：对一个带 graph_full 项的批次，直接提交一条仍正确的命令。
    //     2026-10-03 起（6215779「unify incremental evidence reads」）锁外预评估在**受信 worker 进程**里跑
    //     （service.submitAsync → runReadJob("sync_prep")），全量六图构建恰发生在 worker、不在本进程——
    //     本进程探针计数恒为 0；主进程只剩锁内有界图源探针。worker 确实做了独立全量评估由 L-7b
    //     （声称与独立重算逐项一致才放行）与 L-6b（目标漂移被拒、零字节）共同钉住；若锁内（主进程）
    //     跑了全量图构建，fullCalls 会 ≥1 而失败。
    const graphBaselineId = entryOf("executor").baseline?.active?.baseline_id ?? "bl-none";
    await reg(mkContract("b-graph-probe", [{ id: "g", label: "图探针计数", required: true, check: { type: "graph_full", expected_baseline_id: graphBaselineId } }]));
    postEvidence("b-graph-probe", mkEvidence("b-graph-probe", contractSha("b-graph-probe"), [{ id: "g", result: "passed" }]));
    await scanOf();
    const origFull = syncProbeMod.syncGraphProbe();
    const origSource = syncProbeMod.syncGraphSourceProbe();
    let fullCalls = 0;
    let sourceCalls = 0;
    syncProbeMod.registerSyncGraphProbe((p, d) => { fullCalls += 1; return (origFull as NonNullable<typeof origFull>)(p, d); });
    syncProbeMod.registerSyncGraphSourceProbe((p, d) => { sourceCalls += 1; return (origSource as NonNullable<typeof origSource>)(p, d); });
    const okCmd = evidenceCmds.get("b-graph-probe");
    ok(okCmd !== undefined, "L-7 拿到 b-graph-probe 的命令（带 graph_full 项）", { entity: okCmd?.entity_id });
    fullCalls = 0;
    sourceCalls = 0;
    const okReplay = { ...okCmd, idempotency_key: `${okCmd.idempotency_key}-ok`, expected_revision: syncMod.syncEntityRevision(PID, dataDir, "b-graph-probe") };
    const okRes = await postCommand(okReplay);
    ok(okRes.status === 200 && okRes.json.ok === true, "L-7b 仍正确的命令经直连提交成功（锁外预评估 + 锁内有界复核）", { status: okRes.status, code: okRes.json.code });
    ok(fullCalls === 0, "L-7c 持锁主进程未跑 sixGraphsOf 全量（全量评估已隔离在受信 worker 锁外预评估）", { fullCalls });
    ok(sourceCalls >= 1, "L-7d 锁内有界图源探针被调（图源输入稳定快照复核）", { sourceCalls });
    // 还原探针
    if (origFull !== null) syncProbeMod.registerSyncGraphProbe(origFull);
    if (origSource !== null) syncProbeMod.registerSyncGraphSourceProbe(origSource);

    // L-5 graph_full：旧 baseline_id 相同但设计源变 → 非 passed（实核基线当前有效，不只比 id）
    if (graphPublished) {
      const DESIGN_REL = ".工作台/design.md";
      const designAbs = path.join(root, DESIGN_REL);
      const designBackup = fs.readFileSync(designAbs, "utf8");
      const baselineId = entryOf("executor").baseline?.active?.baseline_id ?? "";
      await reg(mkContract("b-graph-live", [{ id: "g", label: "图", required: true, check: { type: "graph_full", expected_baseline_id: baselineId } }]));
      postEvidence("b-graph-live", mkEvidence("b-graph-live", contractSha("b-graph-live"), [{ id: "g", result: "passed" }]));
      ok(batchOf((await scanOf()).report, "b-graph-live")?.verdict === "passed", "L-5 graph_full 生效基线有效 + 图由它构建 → passed");
      const snapBefore = sixGraphsMod.sixGraphsOf(PID, { dataDir, mode: "full" }).baseline.baseline_id;
      write(designAbs, `${designBackup}\n（设计源在基线后改过——旧 baseline_id 不变但基线已失效）\n`);
      const afterVerdict = batchOf((await scanOf()).report, "b-graph-live")?.verdict;
      const snapAfter = sixGraphsMod.sixGraphsOf(PID, { dataDir, mode: "full" }).baseline.baseline_id;
      ok(snapBefore === snapAfter && afterVerdict !== "passed", "L-5b 旧 baseline_id 未变但设计源变 → graph_full 非 passed（实核基线当前有效）", { snapBefore, snapAfter, afterVerdict });
      write(designAbs, designBackup);
      await scanOf();
    } else {
      info("  [说明] L-5 graph_full 基线有效反例：夹具图未发布，属 V09-25 实测范围（如实记未跑）");
    }

    // L-8 后台发现错误被读口/gate 消费：有现行阻断契约时 fail-closed、清后恢复、旧无配置项目不受影响
    syncHealthMod.reportSyncDiscoveryIssue(dataDir, PID, "夹具：注册表读不出（合成）");
    const hStatus = statusOf();
    ok(hStatus.overall !== "passed" && String(hStatus.scan_error ?? "").includes("注册表读不出"), "L-8 后台发现错误 → 读口 overall 非 passed 且 scan_error 暴露", { overall: hStatus.overall });
    ok(syncMod.computeSyncBlock(PID, dataDir).blocked === true, "L-8b 有现行阻断契约 → claim 门禁 fail-closed（A 消费真实异常）");
    ok(syncMod.computeSyncBlock(OLDPID, dataDir).blocked === false, "L-8c 旧无配置项目不因他项故障被阻断");
    syncHealthMod.clearSyncDiscoveryIssues(dataDir);
    ok(!String(statusOf().scan_error ?? "").includes("注册表读不出"), "L-8d clear 后不再暴露该发现错误（恢复）");
  });

  // ═══ 跑全部段 ═══
  for (const [name, fn] of runs) {
    console.log(`[verify] ── ${name}`);
    try { await fn(); } catch (e) { ok(false, `${name}：段内异常（未实现/内部错）`, { error: e instanceof Error ? e.message : String(e) }); }
  }

  // ═══ 收尾 ═══
  mcp.kill();
  try { syncDiscoveryMod.stopSyncDiscovery(); } catch { /* 未启动 */ }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  try { serviceMod.removeServiceDescriptor(dataDir); } catch { /* 夹具整棵删 */ }
  if (process.env.TATAI_KEEP_TMP !== "1") fs.rmSync(tmpBase, { recursive: true, force: true });
  console.log("[verify] ── 汇总");
  info(`PASS ${passCount} / FAIL ${failCount}`);
}

main().catch((e: unknown) => {
  console.error(`[verify] FAIL 脚本异常：${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  process.exitCode = 1;
});
