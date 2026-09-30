// V09-23 组合边界返工 C · 专项验证（先红后绿；DESIGN.md §2.10；docs/sync-evidence-contract.md）。
//
// 三个组合缺口（codex-first-review.md 第 12/13/14 条）：
//   ① **跨进程**：MCP stdio 是另一个进程，不能拿本进程空内存的 `syncRuntimeHealth` 冒充"后台无故障"。
//      本脚本起**真正 daemon 子进程 + 真正 stdio MCP 子进程**：注入"宿主发现上限"后，MCP 的
//      read_sync_status / project_entry 与宿主 HTTP 读口必须**都**非 pass/阻断；复原后恢复。
//      —— 不允许只在同一进程函数里注入假跨进程（那样证明不了 stdio 另进程读得到宿主健康）。
//   ② **锁内图源有界覆盖**：锁外 prepare 过后损坏 modules.json / 改 graph-update.json（baseline id 不变），
//      锁内 assert 必须拒且零字节；复原→通过。图源探针须实读 canonical builder 的实际输入身份。
//   ③ **认领锁边界**：非续约 task.claimed 的同步门禁改为「锁外独立评估 + 锁内真实有界快照校验」——
//      锁内不得再跑 sixGraphsOf 全量（spy 锁内调用 0）；锁外 prepare 后改实际目标 → 锁内拒。
//   小修 13：`putEvidence` 无 task_definitions 时绑定 `interface`＝**同步契约内容哈希**（不是任意 source.sha 假标 plan）。
//
// 隔离口径（AGENTS.md §5）：mkdtemp 夹具 + 隔离 TATAI_HOME + localhost + 真子进程 daemon/stdio MCP；
// 45s 内有界等待；finally 清子进程；不打印 token；不碰真实 ~/.tatai / 真实项目与账本 / 不接网关 / 不调模型。
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
const mkdirp = (d: string): void => { fs.mkdirSync(d, { recursive: true }); };
const write = (f: string, t: string): void => { mkdirp(path.dirname(f)); fs.writeFileSync(f, t, "utf8"); };
const writeJson = (f: string, v: unknown): void => write(f, `${JSON.stringify(v, null, 2)}\n`);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");
const MCP_ENTRY = path.join(SRC, "mcp", "index.ts");
const DAEMON_ENTRY = path.join(SRC, "server", "work", "daemon.ts");
const loadSrc = async <T>(rel: string): Promise<T> => (await import(pathToFileURL(path.join(SRC, rel)).href)) as T;

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-sync-procb-"));

interface McpClient {
  child: ChildProcess;
  handshake: () => Promise<void>;
  callRaw: (name: string, args: Record<string, unknown>) => Promise<{ text: string; isError: boolean }>;
  callJson: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  kill: () => void;
  stderr: () => string;
}

function cleanEnv(home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("TATAI_")) delete env[k];
  env.TATAI_HOME = home;
  return { ...env, ...extra };
}

function spawnMcp(home: string, label: string): McpClient {
  const env = cleanEnv(home, { TATAI_NO_AUTOSTART: "1" });
  const child = spawn(process.execPath, ["--import", "tsx", MCP_ENTRY], { cwd: ROOT, env });
  let stderrBuf = "";
  child.stderr?.on("data", (d: Buffer) => (stderrBuf += d.toString("utf8")));
  let buf = "";
  const pending = new Map<number, (m: RpcMsg) => void>();
  let idc = 0;
  const send = (method: string, params: unknown): Promise<RpcMsg> =>
    new Promise((resolve, reject) => {
      const id = ++idc;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${label} MCP 超时：${method}`)); }, 45_000);
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
    child,
    handshake: async () => {
      const init = await send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: label, version: "1.0" } });
      notify("notifications/initialized", {});
      ok(init.error === undefined && typeof init.result?.serverInfo?.name === "string", `${label}：MCP stdio 子进程握手成功`);
    },
    callRaw,
    callJson: async (name, args) => {
      const r = await callRaw(name, args);
      if (r.isError) throw new Error(`${name} isError：${r.text.slice(0, 300)}`);
      return JSON.parse(r.text) as unknown;
    },
    kill: () => { try { if (child.exitCode === null) child.kill(); } catch { /* 已退出 */ } },
    stderr: () => stderrBuf,
  };
}

interface RpcMsg { id?: number; result?: { content?: { text?: string }[]; isError?: boolean; serverInfo?: { name?: string } }; error?: unknown }

async function main(): Promise<void> {
  info(`同步组合边界返工 C · 专项验证（${process.platform} · node ${process.version}）`);
  info(`  夹具根 ${tmpBase}`);

  const syncMod = await loadSrc<typeof import("../src/server/work/sync")>("server/work/sync.ts");
  const serviceMod = await loadSrc<typeof import("../src/server/work/service")>("server/work/service.ts");
  const syncHttpMod = await loadSrc<typeof import("../src/server/work/syncHttp")>("server/work/syncHttp.ts");
  const eventStoreMod = await loadSrc<typeof import("../src/server/work/eventStore")>("server/work/eventStore.ts");
  const evidenceMod = await loadSrc<typeof import("../src/server/work/evidence")>("server/work/evidence.ts");
  const registryMod = await loadSrc<typeof import("../src/server/registry")>("server/registry.ts");
  const typesMod = await loadSrc<typeof import("../src/server/work/types")>("server/work/types.ts");
  const syncProbeMod = await loadSrc<typeof import("../src/server/work/syncProbe")>("server/work/syncProbe.ts");
  type WorkCommand = import("../src/server/work/types").WorkCommand;

  // ════════════════════════════════════════════════════════════════════════════
  // 夹具一：真正 daemon 宿主 + 真正 stdio MCP（缺口① 跨进程）
  // ════════════════════════════════════════════════════════════════════════════
  const home1 = path.join(tmpBase, "home-daemon");
  const root1 = path.join(tmpBase, "proj-xproc");
  const PID1 = "procx";
  mkdirp(home1);
  mkdirp(path.join(root1, ".工作台", "work", "sync-inbox"));
  write(path.join(root1, "AGENTS.md"), "# 跨进程夹具规则\n\n1. 先读总图。\n");
  write(path.join(root1, "reports", "result.md"), "跨进程夹具：本批次引用的真实 artifact。\n");
  const AGENTS1 = path.join(root1, "AGENTS.md");
  const RESULT1 = path.join(root1, "reports", "result.md");
  const INBOX1 = path.join(root1, ".工作台", "work", "sync-inbox");
  const registryMod1 = path.join(home1, "registry.json");
  registryMod.addProject({ id: PID1, name: "跨进程夹具", path: root1, kind: "backend" }, home1);

  let daemon: ChildProcess | null = null;
  let mcp1: McpClient | null = null;

  const descriptorOf = (home: string): { host: string; port: number; token: string; pid: number } | null => {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(home, "work-service.json"), "utf8")) as { host: string; port: number; token: string; pid: number };
      if (typeof d?.port !== "number" || typeof d.host !== "string" || typeof d.token !== "string") return null;
      return d;
    } catch { return null; }
  };
  const waitDescriptor = async (home: string, timeoutMs: number): Promise<{ host: string; port: number; token: string; pid: number } | null> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const d = descriptorOf(home);
      if (d !== null) return d;
      if (Date.now() > deadline) return null;
      await sleep(200);
    }
  };
  const httpJson = (host: string, port: number, p: string, token?: string): Promise<{ status: number; json: unknown }> =>
    new Promise((resolve, reject) => {
      const headers: Record<string, string> = {};
      if (token !== undefined) headers[serviceMod.WORK_TOKEN_HEADER] = token;
      const req = http.request({ host, port, path: p, method: "GET", headers }, (res) => {
        let t = "";
        res.on("data", (c: Buffer) => (t += c.toString("utf8")));
        res.on("end", () => { let j: unknown = {}; try { j = JSON.parse(t); } catch { j = { raw: t }; } resolve({ status: res.statusCode ?? 0, json: j }); });
      });
      req.on("error", reject);
      req.setTimeout(10_000, () => req.destroy(new Error("http 超时")));
      req.end();
    });

  const runs: [string, () => Promise<void>][] = [];
  const sec = (label: string, fn: () => Promise<void>): void => { runs.push([label, fn]); };

  sec("0. 夹具一：真正 daemon 宿主 + 真正 stdio MCP", async () => {
    daemon = spawn(process.execPath, ["--import", "tsx", DAEMON_ENTRY], { cwd: ROOT, env: cleanEnv(home1), windowsHide: true });
    let dlog = "";
    daemon.stdout?.on("data", (d: Buffer) => (dlog += d.toString("utf8")));
    daemon.stderr?.on("data", (d: Buffer) => (dlog += d.toString("utf8")));
    const desc = await waitDescriptor(home1, 20_000);
    ok(desc !== null && typeof desc.pid === "number", "0-1 真正 daemon 宿主绑定并发布描述符（独立进程）", { got: desc !== null, daemon_pid: daemon.pid, desc_pid: desc?.pid, log: dlog.slice(-300) });
    if (desc === null) throw new Error("daemon 未发布描述符");
    ok(desc.pid === daemon.pid, "0-2 描述符属于 daemon 本进程（唯一写者）", { desc_pid: desc.pid, child_pid: daemon.pid });
    mcp1 = spawnMcp(home1, "0");
    await mcp1.handshake();
    // 登记契约（经 MCP → daemon 唯一写口）后交证据并扫描
    const contract = {
      schema_version: 1,
      batch_id: "b-xproc",
      project_id: PID1,
      title: "跨进程边界批次",
      sources: [{ path: "AGENTS.md", sha256: sha256File(AGENTS1) }],
      items: [{ id: "fh", label: "规则文件", required: true, check: { type: "file_hash", path: "AGENTS.md", sha256: sha256File(AGENTS1) } }],
      blocks_entry: true,
    };
    const reg = await mcp1.callRaw("register_sync_contract", { project_id: PID1, role: "designer", change_id: "change-none", contract });
    ok(reg.isError === false, "0-3 经 MCP 登记契约成功（写入 daemon 唯一写口）", { text: reg.text.slice(0, 200) });
    const csha = (JSON.parse(reg.text) as { contract_sha256: string }).contract_sha256;
    const pkg = {
      schema_version: 1,
      batch_id: "b-xproc",
      project_id: PID1,
      contract_sha256: csha,
      completed: true,
      items: [{ id: "fh", result: "passed", artifacts: [{ path: "reports/result.md", sha256: sha256File(RESULT1) }] }],
    };
    mkdirp(INBOX1);
    const tmp = path.join(INBOX1, `.b-xproc.evidence.json.tmp-${crypto.randomBytes(3).toString("hex")}`);
    fs.writeFileSync(tmp, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
    fs.renameSync(tmp, path.join(INBOX1, "b-xproc.evidence.json"));
    const scan = await mcp1.callRaw("scan_sync_evidence", { project_id: PID1, role: "coordinator" });
    ok(scan.isError === false, "0-4 经 MCP 请求宿主扫描成功", { text: scan.text.slice(0, 200) });
  });

  sec("1. 缺口①（红→绿）：宿主发现故障必须被 MCP/entry/HTTP 跨进程读到", async () => {
    const desc = descriptorOf(home1);
    ok(desc !== null, "1-0 拿到 daemon 描述符（HTTP 读口用）");
    if (desc === null || mcp1 === null) return;

    // 基线：既有 pass 合同（三路一致通过）
    const baselineHttp = await httpJson(desc.host, desc.port, `/api/work/sync/status?project_id=${PID1}`, desc.token);
    const baselineReport = (baselineHttp.json as { sync?: { overall?: string } }).sync;
    ok(baselineHttp.status === 200 && baselineReport?.overall === "passed", "1-1a 宿主 HTTP 读口（GET /api/work/sync/status）返回 pass 合同", { status: baselineHttp.status, overall: baselineReport?.overall });
    const baselineRead = (await mcp1.callJson("read_sync_status", { project_id: PID1 })) as { overall?: string };
    ok(baselineRead.overall === "passed", "1-1b MCP read_sync_status → passed", { overall: baselineRead.overall });
    const baselineEntry = (await mcp1.callJson("project_entry", { project_id: PID1, role: "executor" })) as { sync_summary?: { blocked?: boolean } };
    ok(baselineEntry.sync_summary?.blocked === false, "1-1c MCP project_entry → sync_summary.blocked=false", { sync_summary: baselineEntry.sync_summary });

    // 注入：宿主项目数超上限（全局发现故障，只存在于 daemon 进程内存）
    const dummyDirs: string[] = [];
    const toAdd: { id: string; name: string; path: string; kind: "backend" }[] = [];
    for (let i = 0; i < 64; i++) {
      const id = `dummy-${i}`;
      const p = path.join(tmpBase, `dummy-proj-${i}`);
      mkdirp(path.join(p, ".工作台", "work", "sync-inbox"));
      dummyDirs.push(p);
      toAdd.push({ id, name: `占位项目 ${i}`, path: p, kind: "backend" });
    }
    for (const d of toAdd) registryMod.addProject(d, home1);
    await sleep(4_000); // 有界等待 daemon 轮询（2s 周期 + 注册表防抖）

    const failHttp = await httpJson(desc.host, desc.port, `/api/work/sync/status?project_id=${PID1}`, desc.token);
    const failReport = (failHttp.json as { sync?: { overall?: string; scan_error?: string | null } }).sync;
    ok(failHttp.status === 200 && failReport?.overall !== undefined && failReport.overall !== "passed", "1-2a 注入宿主发现故障 → 宿主 HTTP 读口非 pass（跨进程读同一份 report）", { status: failHttp.status, overall: failReport?.overall, scan_error: failReport?.scan_error });

    const failRead = (await mcp1.callJson("read_sync_status", { project_id: PID1 })) as { overall?: string; scan_error?: string | null };
    ok(failRead.overall !== undefined && failRead.overall !== "passed", "1-2b MCP read_sync_status 从宿主读到同一故障（非 pass，不丢故障当 pass）", { overall: failRead.overall, scan_error: String(failRead.scan_error ?? "").slice(0, 160) });

    const failEntry = (await mcp1.callJson("project_entry", { project_id: PID1, role: "executor" })) as { sync_summary?: { blocked?: boolean; overall?: string } };
    ok(failEntry.sync_summary?.blocked === true, "1-2c MCP project_entry：有现行阻断契约 → sync_summary.blocked=true（fail-closed）", { sync_summary: failEntry.sync_summary });

    // 复原：撤掉超上限的占位项目 → daemon 清全局故障 → 三路恢复
    const reg = registryMod.readRegistry(home1);
    reg.projects = reg.projects.filter((p) => p.id === PID1);
    registryMod.writeRegistry(reg, home1);
    await sleep(4_000);

    const backHttp = await httpJson(desc.host, desc.port, `/api/work/sync/status?project_id=${PID1}`, desc.token);
    ok((backHttp.json as { sync?: { overall?: string } }).sync?.overall === "passed", "1-3a 复原 → 宿主 HTTP 读口恢复 passed", { overall: (backHttp.json as { sync?: { overall?: string } }).sync?.overall });
    const backRead = (await mcp1.callJson("read_sync_status", { project_id: PID1 })) as { overall?: string };
    ok(backRead.overall === "passed", "1-3b 复原 → MCP read_sync_status 恢复 passed", { overall: backRead.overall });
    const backEntry = (await mcp1.callJson("project_entry", { project_id: PID1, role: "executor" })) as { sync_summary?: { blocked?: boolean } };
    ok(backEntry.sync_summary?.blocked === false, "1-3c 复原 → MCP project_entry sync_summary.blocked=false", { sync_summary: backEntry.sync_summary });
    void dummyDirs;
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 夹具二：进程内唯一写服务（缺口② 图源有界覆盖 / 缺口③ 认领锁边界 / 小修13 绑定）
  // ════════════════════════════════════════════════════════════════════════════
  const home2 = path.join(tmpBase, "home-lock");
  const root2 = path.join(tmpBase, "proj-lock");
  const PID2 = "projlock";
  const workDir2 = path.join(root2, ".工作台", "work");
  const inbox2 = path.join(workDir2, "sync-inbox");
  mkdirp(home2);
  mkdirp(inbox2);
  write(path.join(root2, "AGENTS.md"), "# 锁边界夹具规则\n\n1. 锁内只做有界复核。\n");
  write(path.join(root2, "reports", "result.md"), "锁边界夹具：本批次引用的真实 artifact。\n");
  writeJson(path.join(root2, ".工作台", "arch", "modules.json"), {
    version: 1,
    generated_at: "2026-09-30T00:00:00.000Z",
    budget_exhausted: false,
    modules: [{ id: "src", name: "", path: "src", file_count: 1, loc: 0, deps: [] }],
  });
  registryMod.addProject({ id: PID2, name: "锁边界夹具", path: root2, kind: "backend" }, home2);
  const service2 = new serviceMod.WorkService({ dataDir: home2 });
  const captured: WorkCommand[] = [];
  const submitter2 = {
    submit: (c: unknown): ReturnType<typeof service2.submit> => {
      const cmd = c as WorkCommand;
      if (cmd.type === "sync.evidence_checked") captured.push(cmd);
      return service2.submit(c);
    },
  };
  const AGENTS2 = path.join(root2, "AGENTS.md");
  const contract2 = {
    schema_version: 1,
    batch_id: "b-lock",
    project_id: PID2,
    title: "锁边界批次",
    sources: [{ path: "AGENTS.md", sha256: sha256File(AGENTS2) }],
    items: [
      { id: "fh", label: "规则文件", required: true, check: { type: "file_hash", path: "AGENTS.md", sha256: sha256File(AGENTS2) } },
      // 非必需 graph_full：其 actual（图源输入身份）参与指纹，但不影响总体 pass（无需真发布图）
      { id: "g", label: "图源输入", required: false, check: { type: "graph_full", expected_baseline_id: "bl-not-needed" } },
    ],
    blocks_entry: true,
  };

  sec("2. 缺口②（红→绿）：锁内图源探针覆盖 canonical builder 的实际输入（modules / graph-update）", async () => {
    submitter2.submit(syncMod.buildRegisterContractCommand({ projectId: PID2, changeId: "change-none", actorId: "fx", role: "designer", contract: contract2, expectedRevision: null }));
    const csha = syncMod.existingContractSha(PID2, home2, "b-lock") ?? "";
    const pkg = {
      schema_version: 1,
      batch_id: "b-lock",
      project_id: PID2,
      contract_sha256: csha,
      completed: true,
      items: [
        { id: "fh", result: "passed", artifacts: [{ path: "reports/result.md", sha256: sha256File(path.join(root2, "reports", "result.md")) }] },
        { id: "g", result: "passed", artifacts: [{ path: "reports/result.md", sha256: sha256File(path.join(root2, "reports", "result.md")) }] },
      ],
    };
    write(path.join(inbox2, "b-lock.evidence.json"), `${JSON.stringify(pkg, null, 2)}\n`);
    const outcome = await syncMod.scanSyncProject({ projectId: PID2, dataDir: home2, submitter: submitter2 });
    const cmd = captured.at(-1);
    ok(cmd !== undefined, "2-0 走真实扫描拿到一条 sync.evidence_checked 命令", { verdict: outcome.report.overall });
    if (cmd === undefined) return;

    const events = (): readonly import("../src/server/work/types").WorkEvent[] => eventStoreMod.loadEvents(workDir2).events;
    const prep = syncMod.prepareSyncEvidenceCheck({ cmd, dataDir: home2, workDir: workDir2 });
    ok(typeof prep.source_fingerprint === "string" && prep.source_fingerprint.length === 64, "2-1 锁外独立预评估成功（有界源指纹）");

    // 反例：prepare 过后损坏 modules.json（图输入身份，baseline id 不变）
    const modPath = path.join(root2, ".工作台", "arch", "modules.json");
    writeJson(modPath, { version: 1, generated_at: "2026-09-30T00:00:00.000Z", budget_exhausted: false, modules: [{ id: "src-TAMPERED", name: "", path: "src", file_count: 9, loc: 0, deps: [] }] });
    let threw = false;
    let thrownMsg = "";
    try { syncMod.assertSyncEvidenceWriteCommand({ events: events(), cmd, dataDir: home2, workDir: workDir2, prep }); }
    catch (e) { threw = true; thrownMsg = e instanceof Error ? e.message : String(e); }
    ok(threw, "2-2 锁外 prepare 后损坏 modules.json → 锁内 assert 拒（零字节）", { threw, msg: thrownMsg.slice(0, 200) });

    // 复原 modules → 同一 prep 复核通过
    writeJson(modPath, { version: 1, generated_at: "2026-09-30T00:00:00.000Z", budget_exhausted: false, modules: [{ id: "src", name: "", path: "src", file_count: 1, loc: 0, deps: [] }] });
    let threw2 = false;
    try { syncMod.assertSyncEvidenceWriteCommand({ events: events(), cmd, dataDir: home2, workDir: workDir2, prep }); }
    catch (e) { threw2 = true; }
    ok(!threw2, "2-3 复原图输入 → 锁内复核重新通过");

    // 反例二：改 graph-update.json（图更新状态也是 canonical builder 输入）——先在 GU1 状态下扫描出匹配命令，
    // 再 prepare，再改成 GU2，锁内按当前实际事实重算应拒（baseline id 不变）。
    const guPath = path.join(root2, ".工作台", "arch", "graph-update.json");
    writeJson(guPath, { state: "updating", scope: "full", reason: "夹具：锁外 prepare 前状态", updated_at: "2026-09-30T00:00:00.000Z" });
    await syncMod.scanSyncProject({ projectId: PID2, dataDir: home2, submitter: submitter2 });
    const cmdGu = captured.at(-1);
    ok(cmdGu !== undefined, "2-4a 在 graph-update=updating 状态下扫描出匹配命令", { entity: cmdGu?.entity_id });
    if (cmdGu === undefined) return;
    const prepGu = syncMod.prepareSyncEvidenceCheck({ cmd: cmdGu, dataDir: home2, workDir: workDir2 });
    writeJson(guPath, { state: "failed", scope: "full", reason: "夹具：改成另一状态", updated_at: "2026-09-30T00:00:01.000Z" });
    let threwGu = false;
    try { syncMod.assertSyncEvidenceWriteCommand({ events: events(), cmd: cmdGu, dataDir: home2, workDir: workDir2, prep: prepGu }); }
    catch { threwGu = true; }
    ok(threwGu, "2-4b 锁外 prepare 后改 graph-update.json → 锁内 assert 拒", { threw: threwGu });
    fs.rmSync(guPath, { force: true });

    // 重复扫描零新增事件（指纹不含自己 sync 事件序号/时间/墙钟）
    const before = eventStoreMod.loadEvents(workDir2).events.filter((e) => e.type.startsWith("sync.")).length;
    await syncMod.scanSyncProject({ projectId: PID2, dataDir: home2, submitter: submitter2 });
    await syncMod.scanSyncProject({ projectId: PID2, dataDir: home2, submitter: submitter2 });
    const after = eventStoreMod.loadEvents(workDir2).events.filter((e) => e.type.startsWith("sync.")).length;
    ok(after === before, "2-5 连续扫描零新增 sync 事件（指纹不含自身序号/墙钟）", { before, after });
  });

  sec("3. 缺口③（红→绿）：非续约 task.claimed 锁外独立评估 + 锁内有界快照复核（锁内不跑全量图）", async () => {
    const claimCmd: WorkCommand = {
      schema_version: 2,
      project_id: PID2,
      change_id: "change-none",
      entity_id: "task:T-lock",
      expected_revision: null,
      type: "task.claimed",
      actor_id: "fx",
      role: "executor",
      idempotency_key: "lock-claim-1",
      payload: { run_id: "r1", attempt_id: "a1", owner_id: "fx", claim_token: "tok", lease_expires_at: new Date(Date.now() + 3.6e6).toISOString() },
    };
    const prepFn = (syncMod as unknown as { prepareClaimSyncGate?: (a: { cmd: WorkCommand; dataDir: string; workDir: string }) => { blocked: boolean; source_fingerprint: string } }).prepareClaimSyncGate;
    const assertFn = (syncMod as unknown as { assertClaimSyncGate?: (a: { events: readonly import("../src/server/work/types").WorkEvent[]; cmd: WorkCommand; dataDir: string; workDir: string; prep: { blocked: boolean; source_fingerprint: string } }) => void }).assertClaimSyncGate;
    ok(typeof prepFn === "function" && typeof assertFn === "function", "3-0 认领同步门禁有「锁外 prepare + 锁内 assert」两个入口（缺一则缺口未闭合）");
    if (typeof prepFn !== "function" || typeof assertFn !== "function") return;

    const origFull = syncProbeMod.syncGraphProbe();
    const origSource = syncProbeMod.syncGraphSourceProbe();
    let fullCalls = 0;
    let sourceCalls = 0;
    syncProbeMod.registerSyncGraphProbe((p, d) => { fullCalls += 1; return (origFull as NonNullable<typeof origFull>)(p, d); });
    syncProbeMod.registerSyncGraphSourceProbe((p, d) => { sourceCalls += 1; return (origSource as NonNullable<typeof origSource>)(p, d); });
    try {
      fullCalls = 0;
      const prep = prepFn({ cmd: claimCmd, dataDir: home2, workDir: workDir2 });
      ok(fullCalls >= 1, "3-1 锁外独立评估（含全量图）被调", { fullCalls, blocked: prep.blocked });
      fullCalls = 0;
      sourceCalls = 0;
      assertFn({ events: eventStoreMod.loadEvents(workDir2).events, cmd: claimCmd, dataDir: home2, workDir: workDir2, prep });
      ok(fullCalls === 0, "3-2 锁内复核 0 次全量六图构建（只用有界图源探针）", { fullCalls });
      ok(sourceCalls >= 1, "3-3 锁内用有界图源探针复算指纹", { sourceCalls });

      // 反例：锁外 prepare 后改实际图输入 → 锁内拒
      const modPath = path.join(root2, ".工作台", "arch", "modules.json");
      const modBackup = fs.readFileSync(modPath, "utf8");
      writeJson(modPath, { version: 1, generated_at: "2026-09-30T00:00:00.000Z", budget_exhausted: false, modules: [{ id: "src-CHANGED", name: "", path: "src", file_count: 2, loc: 0, deps: [] }] });
      let threw = false;
      let msg = "";
      try { assertFn({ events: eventStoreMod.loadEvents(workDir2).events, cmd: claimCmd, dataDir: home2, workDir: workDir2, prep }); }
      catch (e) { threw = true; msg = e instanceof Error ? e.message : String(e); }
      ok(threw, "3-4 锁外 prepare 后改实际目标（图输入）→ 锁内拒（不覆盖活锁）", { threw, msg: msg.slice(0, 160) });
      write(modPath, modBackup);
      let threw2 = false;
      try { assertFn({ events: eventStoreMod.loadEvents(workDir2).events, cmd: claimCmd, dataDir: home2, workDir: workDir2, prep }); } catch { threw2 = true; }
      ok(!threw2, "3-5 复原 → 锁内复核重新通过");

      // 真实直连提交：全量图探针只在锁外预评估调用（锁内 0）
      fullCalls = 0;
      sourceCalls = 0;
      try {
        service2.submit({ ...claimCmd, idempotency_key: "lock-claim-2", payload: { ...claimCmd.payload, claim_token: "tok2" } });
        ok(fullCalls === 1, "3-6 真实直连 task.claimed：全量图探针恰在锁外预评估被调 1 次（锁内 0）", { fullCalls, sourceCalls });
      } catch (e) {
        ok(false, "3-6 真实直连 task.claimed 提交（应成功）", { error: e instanceof Error ? e.message : String(e) });
      }
    } finally {
      if (origFull !== null) syncProbeMod.registerSyncGraphProbe(origFull);
      if (origSource !== null) syncProbeMod.registerSyncGraphSourceProbe(origSource);
    }
  });

  sec("4. 小修13（红→绿）：putEvidence 无 task_definitions → interface＝同步契约内容哈希", async () => {
    const csha = syncMod.existingContractSha(PID2, home2, "b-lock") ?? "";
    const manifest = evidenceMod.evidenceManifest(workDir2);
    const blob = manifest.find((e) => e.summary.includes("b-lock"));
    ok(blob !== undefined, "4-0 找到 b-lock 证据包落库记录", { summaries: manifest.map((e) => e.summary.slice(0, 40)) });
    ok(blob?.binding?.revision_kind === "interface", "4-1 无 task_definitions → binding.revision_kind=interface（不是假标 plan）", { binding: blob?.binding });
    ok(blob?.binding?.revision === csha, "4-2 binding.revision＝本同步契约内容哈希（interface 指同步契约）", { binding: blob?.binding, expected: csha });
  });

  sec("5. 桌面宿主读口退回（index.ts 未转发 work 面时的只读项目读口）", async () => {
    // 模拟桌面 8787：只挂 /api/projects/:id/sync-status（不挂 /api/work/sync/status）——
    // read-only reader 必须先试 work 读口失败后**退回**该只读项目读口，才拿得到宿主同一份 report。
    const onlyProject = http.createServer((req, res) => {
      const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      if (syncHttpMod.handleSyncStatusRoute(req, res, pathname, home2)) return;
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: "NOT_FOUND" }));
    });
    await new Promise<void>((resolve) => onlyProject.listen(0, "127.0.0.1", resolve));
    const bound = onlyProject.address() as { port: number };
    serviceMod.writeServiceDescriptor(home2, { schema_version: typesMod.SCHEMA_VERSION, pid: process.pid, host: "127.0.0.1", port: bound.port, token: "unused-token", started_at: new Date().toISOString(), url: `http://127.0.0.1:${bound.port}` });
    try {
      const client = new serviceMod.WorkServiceClient({ dataDir: home2, autostart: false, timeoutMs: 3_000 });
      const remote = await client.readSyncStatusRemote(PID2);
      const live = syncMod.readSyncStatus(PID2, home2);
      ok(remote !== null && remote.report.configured === live.configured && remote.report.overall === live.overall, "5-1 work 读口不可用时退回只读项目读口，拿到同一份 report", { got: remote === null ? null : remote.report.overall, live: live.overall });
      ok(remote !== null && Array.isArray(remote.discovery_issues), "5-2 退回路径也带回后台发现错误（同源）", { issues: remote?.discovery_issues?.length });
    } finally {
      serviceMod.removeServiceDescriptor(home2);
      await new Promise<void>((resolve) => onlyProject.close(() => resolve()));
    }
  });

  // ═══ 跑全部段 ═══
  for (const [name, fn] of runs) {
    console.log(`[verify] ── ${name}`);
    try { await fn(); } catch (e) { ok(false, `${name}：段内异常`, { error: e instanceof Error ? e.message : String(e) }); }
  }

  // ═══ 收尾：finally 清子进程（失败也清）═══
  const mcpChild = mcp1 as McpClient | null;
  const daemonChild = daemon as ChildProcess | null;
  try { mcpChild?.kill(); } catch { /* ignore */ }
  try { if (daemonChild !== null && daemonChild.exitCode === null) daemonChild.kill("SIGTERM"); } catch { /* ignore */ }
  await sleep(500);
  try { if (daemonChild !== null && daemonChild.exitCode === null) daemonChild.kill("SIGKILL"); } catch { /* ignore */ }
  void registryMod1;
  if (process.env.TATAI_KEEP_TMP !== "1") {
    try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  console.log("[verify] ── 汇总");
  info(`PASS ${passCount} / FAIL ${failCount}`);
}

main().catch((e: unknown) => {
  console.error(`[verify] FAIL 脚本异常：${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  process.exitCode = 1;
});
