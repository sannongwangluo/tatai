// C014 收口第三包验证脚本（2026-09-21）：outbox 适配层**生产接入**端到端验收。
// 用法：pnpm verify:c014-outbox-real（自带临时 TATAI_HOME + 夹具项目，不碰真实注册表与任何真实项目；
// 不调真网关——全部事件只进夹具项目的 events.jsonl；TATAI_KEEP_TMP=1 保留现场）
//
// 与隔离级（V06-11/2，stub）的关系：隔离级六条行为证明适配层机制；本脚本证明**接入真实写入服务、
// 真实协调器进程的端到端链**（§5.4 两级验收的第二级）——真实塔台服务进程（spawn src/server/index.ts）、
// 生产适配器 CLI（scripts/outbox/adapter.ts，real 模式）、落账核对直接读夹具项目 events.jsonl 原文。
//
// 合同（C014 卡「生产级端到端链（发起→回执→落账/失败恢复）」+ §5.4 待提交链路六条）：
//   R1 发起→回执→落账：claim --real 走真实发起链（task.claimed + execution.start_requested +
//      execution.started 落账）；beat/checkpoint/deliver 落 execution.*，幂等键是稳定意图键；
//   R2 断网待提交：杀服务 → claim 拒领（exit 1＋claim_reject 落台账＋run-state 无新 run）→
//      新回执留 pending；服务恢复 → recover（新进程）按原键补交，事件不重不丢；
//   R3 应答丢失：HTTP 故障代理丢每个键的首次应答（请求照常到服务端落账）→ 台账 pending →
//      recover 重交拿到**原回执**（duplicate），事件流每条键恰一条；
//   R4 重启恢复：recover 以全新进程凭 home 下持久件完成（进程间零内存态：回执台账＋run-state
//      登记＋service.json；run-state 缺失/撕裂/回退的处置见 R8——不再是"仅凭两件"的旧表述）；
//   R5 效果链：交付物文件真实生成 → deliver 落 effect_declared＋delivered，本地 sha256 核实成立
//      → effect_confirmed（result_ref=sha256:…）；负例：文件缺失 → 不确认、不盲重放、recover 记
//      unresolved（exit 2），补齐文件后 recover 补确认恰一次；
//   R6 幂等重交：recover 连跑第二轮 0 补交 0 确认；同内容 heartbeat 重发不胀台账不胀事件流；
//   R7 结构不变量：seq 1..N 连续、每实体 entity_revision 连续 +1、幂等键全局唯一。
import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ADAPTER = path.join("scripts", "outbox", "adapter.ts");

let passCount = 0;
let failCount = 0;
const ok = (cond: boolean, label: string) => {
  console.log(`[verify-c014] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (cond) passCount++;
  else {
    failCount++;
    process.exitCode = 1;
  }
};
const info = (msg: string) => console.log(`[verify-c014] ${msg}`);

// ── 夹具文本 ──────────────────────────────────────────────────────────
const DESIGN_TEXT = ["# 夹具设计书", "", "## 1 能力", "", "能力甲与能力乙（C014 端到端夹具）。", ""].join("\n");
const PLAN_TEXT = [
  "# 夹具施工图",
  "",
  "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |",
  "| --- | --- | --- | --- | --- |",
  "| T-1 | todo | 能力甲落成 |  | 甲验收记录 |",
  "| T-2 | todo | 能力乙落成 |  | 乙验收记录 |",
  "",
  "### T-1 能力甲落成",
  "",
  "**设计依据**：§1。",
  "",
  "**契约**：输入甲，输出甲的产物。",
  "",
  "**文件责任**：`src/a.ts`。",
  "",
  "- [ ] 甲做出来",
  "",
  "**交付**：甲验收记录。",
  "",
  "### T-2 能力乙落成",
  "",
  "**设计依据**：§1。",
  "",
  "**契约**：输入乙，输出乙的产物。",
  "",
  "**文件责任**：`src/b.ts`。",
  "",
  "- [ ] 乙做出来",
  "",
  "**交付**：乙验收记录。",
  "",
].join("\n");

// ── 进程与 HTTP 工具 ──────────────────────────────────────────────────
const spawned: ChildProcess[] = [];
const stopChild = async (proc: ChildProcess): Promise<void> => {
  if (proc.exitCode !== null) return;
  proc.kill("SIGKILL");
  for (let i = 0; i < 40 && proc.exitCode === null; i += 1) await new Promise((r) => setTimeout(r, 100));
};
process.on("exit", () => {
  for (const p of spawned) {
    try {
      if (p.exitCode === null) p.kill("SIGKILL");
    } catch {
      /* 清理兜底 */
    }
  }
});

async function waitUpOn(port: number): Promise<void> {
  for (let i = 0; i < 60; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok) return;
    } catch {
      /* 未就绪 */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`服务 ${port} 端口 15 秒内未就绪`);
}

async function waitDownOn(port: number): Promise<void> {
  for (let i = 0; i < 60; i += 1) {
    try {
      await fetch(`http://127.0.0.1:${port}/health`);
    } catch {
      return;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`服务 ${port} 端口 15 秒内未停止`);
}

function spawnServer(dataDir: string, port: number): ChildProcess {
  const proc = spawn(process.execPath, ["--import", "tsx", path.join("src", "server", "index.ts")], {
    cwd: REPO,
    env: { ...process.env, TATAI_HOME: dataDir, TATAI_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (process.env.TATAI_VERBOSE === "1") {
    proc.stdout?.on("data", (d: Buffer) => process.stdout.write(`[server:${port}] ${d}`));
  }
  proc.stderr?.on("data", (d: Buffer) => process.stderr.write(`[server:${port}:err] ${d}`));
  spawned.push(proc);
  return proc;
}

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** 适配器 CLI 一律以**独立进程**跑（真实协调器入口；recover 即 R4 新进程恢复） */
function runOutbox(args: string[], extraEnv: Record<string, string> = {}): Promise<CliResult> {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, ["--import", "tsx", ADAPTER, ...args], {
      cwd: REPO,
      env: { ...process.env, ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
    proc.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    proc.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

/** R3 的故障代理：每个幂等键的**首次**提交请求照常转发到真实服务（事件落账），但把应答掐掉 */
function startAckLossProxy(targetUrl: string, droppedKeys: Set<string>): Promise<{ port: number; close: () => void }> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      void (async () => {
        const body = Buffer.concat(chunks).toString("utf8");
        let key = "";
        try {
          key = String(JSON.parse(body).idempotency_key ?? "");
        } catch {
          /* 非 JSON 原样转发 */
        }
        const upstream = await fetch(`${targetUrl}${req.url}`, {
          method: req.method,
          headers: { "content-type": "application/json", "x-tatai-work-token": String(req.headers["x-tatai-work-token"] ?? "") },
          body: req.method === "GET" ? undefined : body,
        });
        const respBody = await upstream.text();
        if (key !== "" && !droppedKeys.has(key)) {
          droppedKeys.add(key); // 已落账（上面已转发成功）但不应答：客户端只见连接被掐
          req.socket.destroy();
          return;
        }
        res.writeHead(upstream.status, { "content-type": "application/json" });
        res.end(respBody);
      })().catch(() => req.socket.destroy());
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ port: typeof addr === "object" && addr !== null ? addr.port : 0, close: () => server.close() });
    });
  });
}

// ── 落账核对工具（直接读夹具项目 events.jsonl 原文） ──────────────────
interface WorkEventLine {
  seq: number;
  entity_id: string;
  entity_revision: number;
  type: string;
  idempotency_key: string;
  actor_id: string;
  role: string;
  payload: Record<string, unknown>;
}

const eventsPathOf = (projDir: string) => path.join(projDir, ".工作台", "work", "events.jsonl");
function readEvents(projDir: string): WorkEventLine[] {
  const f = eventsPathOf(projDir);
  if (!fs.existsSync(f)) return [];
  return fs
    .readFileSync(f, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as WorkEventLine);
}
const ofType = (evs: WorkEventLine[], t: string) => evs.filter((e) => e.type === t);
const ofKey = (evs: WorkEventLine[], k: string) => evs.filter((e) => e.idempotency_key === k);

interface LedgerLine {
  type: string;
  run: string | null;
  status: string;
  idempotency_key: string | null;
  occurred_at: string;
  payload: Record<string, unknown>;
  last_error?: string;
  unresolved_reason?: string;
}
const ledgerPathOf = (home: string) => path.join(home, "pending-receipts.jsonl");
function readLedger(home: string): LedgerLine[] {
  const f = ledgerPathOf(home);
  if (!fs.existsSync(f)) return [];
  return fs
    .readFileSync(f, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as LedgerLine);
}

async function main(): Promise<void> {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-c014-e2e-"));
  const dataDir = path.join(tmpBase, "home");
  const projDir = path.join(tmpBase, "proj");
  const wsDir = path.join(tmpBase, "workspace");
  const outboxHome = path.join(tmpBase, "outbox");
  fs.mkdirSync(path.join(projDir, ".工作台"), { recursive: true });
  fs.mkdirSync(wsDir, { recursive: true });
  fs.mkdirSync(outboxHome, { recursive: true });
  fs.writeFileSync(path.join(projDir, ".工作台", "design.md"), DESIGN_TEXT, "utf8");
  fs.writeFileSync(path.join(projDir, ".工作台", "plan.md"), PLAN_TEXT, "utf8");
  process.env.TATAI_HOME = dataDir;
  delete process.env.OUTBOX_SERVICE_URL;
  delete process.env.OUTBOX_MODE;
  fs.writeFileSync(path.join(outboxHome, "service.json"), JSON.stringify({ mode: "real", data_dir: dataDir }), "utf8");

  const PROJECT = "c014e2e";
  const CHG = "chg-c014-e2e";
  const port1 = 8900 + Math.floor(Math.random() * 90);
  const port2 = port1 + 100;

  // ── 夹具注册＋基线＋任务定义（进程内直写准备现场，drill.ts:301-305 同款） ──
  const { addProject } = await import("../src/server/registry");
  const { activateBaseline } = await import("../src/server/work/documents");
  const { projectWorkDir } = await import("../src/server/workstation");
  const { importPlanChecked } = await import("../src/server/work/references");
  const { submitDefinitionImports } = await import("../src/server/work/tasks");
  const { WorkService } = await import("../src/server/work/service");
  const { NO_CHANGE_ID } = await import("../src/server/work/types");
  addProject({ id: PROJECT, name: "C014 端到端夹具", path: projDir, kind: "backend" }, dataDir);
  activateBaseline(PROJECT, { approved_by: "fixture", approval_basis: "C014 夹具技术审定（非真实用户 Gate）", approval_kind: "delegated_technical_review" }, dataDir);
  const workDir = projectWorkDir(PROJECT, dataDir);
  const svc = new WorkService({ dataDir });
  const defs = importPlanChecked(PLAN_TEXT, workDir).definitions;
  await submitDefinitionImports(
    { submit: (c: unknown) => svc.submit(c as never) },
    { project_id: PROJECT, change_id: NO_CHANGE_ID, actor_id: "fixture", role: "executor", definitions: defs },
  );
  info(`夹具就绪：项目 ${PROJECT}，任务 ${defs.map((d: { task_id: string }) => d.task_id).join("/")}`);

  // ── R1 发起→回执→落账 ──
  info("── R1 真实发起链与回执落账");
  const server1 = spawnServer(dataDir, port1);
  await waitUpOn(port1);
  const claim1 = await runOutbox(["claim", "--home", outboxHome, "--project", PROJECT, "--task", "T-1", "--real", "--workspace", wsDir, "--change", CHG, "--goal", "C014 端到端：能力甲落成"]);
  ok(claim1.code === 0, `R1-1 claim --real 成功（exit ${claim1.code}；${claim1.stderr.trim().slice(0, 120)}）`);
  const run1 = String(JSON.parse(claim1.stdout || "{}").run ?? "");
  const ev1 = readEvents(projDir);
  ok(ofType(ev1, "task.claimed").length === 1 && ofType(ev1, "task.claimed")[0].entity_id === "task:T-1", "R1-2 task.claimed 落账（entity task:T-1）");
  ok(ofType(ev1, "execution.start_requested").length === 1 && ofType(ev1, "execution.started").length === 1, "R1-3 execution.start_requested + started 落账");
  const execEntity = "execution:ex-T-1-att-1";
  ok(ofType(ev1, "execution.started")[0]?.entity_id === execEntity, `R1-4 执行实体 ${execEntity}`);

  const beatAt = "2026-09-21T08:00:00.000Z";
  fs.writeFileSync(path.join(tmpBase, "beat1.json"), JSON.stringify({ observed_at: beatAt, note: "心跳：正在施工" }), "utf8");
  const beat1 = await runOutbox(["beat", "--home", outboxHome, "--run", run1, "--payload-file", path.join(tmpBase, "beat1.json")]);
  ok(beat1.code === 0 && JSON.parse(beat1.stdout || "{}").status === "submitted", `R1-5 heartbeat 提交（${beat1.stdout.trim()}）`);
  const hbKey = `ex-T-1-att-1:execution.heartbeat:${beatAt}`;
  const ev2 = readEvents(projDir);
  ok(ofKey(ev2, hbKey).length === 1, `R1-6 execution.heartbeat 落账，稳定意图键 ${hbKey}`);
  ok(String(ofKey(ev2, hbKey)[0]?.payload.observed_at ?? "") === beatAt, "R1-7 心跳负载保留原观测时间");

  const cpAt = "2026-09-21T08:05:00.000Z";
  fs.writeFileSync(
    path.join(tmpBase, "cp1.json"),
    JSON.stringify({ observed_at: cpAt, note: "检查点：主体已完", artifacts: ["src/a.ts"], worktree: { dirty: true, changed_files: ["src/a.ts"], head: "fixture-head" } }),
    "utf8",
  );
  const cp1 = await runOutbox(["checkpoint", "--home", outboxHome, "--run", run1, "--payload-file", path.join(tmpBase, "cp1.json")]);
  ok(cp1.code === 0 && JSON.parse(cp1.stdout || "{}").status === "submitted", `R1-8 checkpoint 提交（${cp1.stdout.trim()}）`);
  const cpKey = `ex-T-1-att-1:execution.checkpoint:${cpAt}`;
  const ev3 = readEvents(projDir);
  ok(ofKey(ev3, cpKey).length === 1 && (ofKey(ev3, cpKey)[0].payload.worktree as { head?: string })?.head === "fixture-head", "R1-9 execution.checkpoint 落账且 worktree 全量");

  // ── R2 断网待提交 ──
  info("── R2 断网待提交与恢复补交");
  await stopChild(server1);
  await waitDownOn(port1);
  const claimOffline = await runOutbox(["claim", "--home", outboxHome, "--project", PROJECT, "--task", "T-2", "--real", "--workspace", wsDir, "--change", CHG]);
  ok(claimOffline.code === 1, `R2-1 服务不可达 claim 拒领（exit ${claimOffline.code}）`);
  const stAfterOfflineClaim = JSON.parse(fs.readFileSync(path.join(outboxHome, "run-state.json"), "utf8")) as { runs: Record<string, unknown> };
  ok(!Object.keys(stAfterOfflineClaim.runs).some((r) => r.includes("T-2")), "R2-2 拒领未登记新 run");
  ok(readLedger(outboxHome).some((l) => l.type === "claim_reject"), "R2-3 claim_reject 落台账");

  const beat2At = "2026-09-21T08:10:00.000Z";
  fs.writeFileSync(path.join(tmpBase, "beat2.json"), JSON.stringify({ observed_at: beat2At, note: "断线期心跳" }), "utf8");
  const beat2 = await runOutbox(["beat", "--home", outboxHome, "--run", run1, "--payload-file", path.join(tmpBase, "beat2.json")]);
  ok(beat2.code === 0 && JSON.parse(beat2.stdout || "{}").status === "pending", `R2-4 断线心跳留 pending（${beat2.stdout.trim()}）`);
  const cp2At = "2026-09-21T08:15:00.000Z";
  fs.writeFileSync(
    path.join(tmpBase, "cp2.json"),
    JSON.stringify({ observed_at: cp2At, note: "断线期检查点", artifacts: ["src/a.ts"], worktree: { dirty: true, changed_files: ["src/a.ts"], head: "fixture-head-2" } }),
    "utf8",
  );
  const cp2 = await runOutbox(["checkpoint", "--home", outboxHome, "--run", run1, "--payload-file", path.join(tmpBase, "cp2.json")]);
  ok(cp2.code === 0 && JSON.parse(cp2.stdout || "{}").status === "pending", "R2-5 断线检查点留 pending");
  const evBeforeRecover = readEvents(projDir).length;

  const server2 = spawnServer(dataDir, port2);
  await waitUpOn(port2);
  const recover1 = await runOutbox(["recover", "--home", outboxHome]);
  const rep1 = JSON.parse(recover1.stdout || "{}") as { resubmitted?: number; duplicates?: number; unresolved?: number };
  ok(
    recover1.code === 0 && rep1.resubmitted === 4 && rep1.duplicates === 2 && rep1.unresolved === 0,
    `R2-6 recover（新进程）补交：断线期 2 条新落账＋已提交 2 条幂等去重、0 unresolved（${recover1.stdout.trim()}）`,
  );
  const hb2Key = `ex-T-1-att-1:execution.heartbeat:${beat2At}`;
  const cp2Key = `ex-T-1-att-1:execution.checkpoint:${cp2At}`;
  const ev4 = readEvents(projDir);
  ok(ofKey(ev4, hb2Key).length === 1 && ofKey(ev4, cp2Key).length === 1, "R2-7 补交按原观测时间键落账、各恰一条");
  ok(ev4.length === evBeforeRecover + 2, `R2-8 事件流只增两条（${evBeforeRecover}→${ev4.length}），不重不丢`);
  ok(readLedger(outboxHome).filter((l) => l.status === "submitted").length >= 4, "R2-9 台账恢复为 submitted");

  // ── R3 应答丢失 ──
  info("── R3 应答丢失按原键重交");
  const { readServiceDescriptor } = await import("../src/server/work/service");
  const descriptor = readServiceDescriptor(dataDir);
  ok(descriptor !== null && descriptor.port === port2, "R3-0 描述符发现真实服务");
  const dropped = new Set<string>();
  const proxy = await startAckLossProxy(String(descriptor?.url), dropped);
  const beat3At = "2026-09-21T08:20:00.000Z";
  fs.writeFileSync(path.join(tmpBase, "beat3.json"), JSON.stringify({ observed_at: beat3At, note: "应答丢失心跳" }), "utf8");
  const beat3 = await runOutbox(["beat", "--home", outboxHome, "--run", run1, "--payload-file", path.join(tmpBase, "beat3.json")], {
    OUTBOX_SERVICE_URL: `http://127.0.0.1:${proxy.port}`,
  });
  const beat3Status = String(JSON.parse(beat3.stdout || "{}").status ?? "");
  ok(beat3.code === 0 && beat3Status === "pending", `R3-1 应答丢失 → 回执留 pending（${beat3.stdout.trim()}）`);
  const hb3Key = `ex-T-1-att-1:execution.heartbeat:${beat3At}`;
  ok(ofKey(readEvents(projDir), hb3Key).length === 1, "R3-2 服务端其实已落账（请求到达），事件恰一条");
  proxy.close();
  const recover2 = await runOutbox(["recover", "--home", outboxHome]);
  const rep2 = JSON.parse(recover2.stdout || "{}") as { resubmitted?: number; duplicates?: number };
  ok(recover2.code === 0 && (rep2.resubmitted ?? 0) === 5 && (rep2.duplicates ?? 0) === 5, `R3-3 recover 重交全部拿到原回执（5 条 duplicate，含 ack-loss 那条）（${recover2.stdout.trim()}）`);
  ok(ofKey(readEvents(projDir), hb3Key).length === 1, "R3-4 重交后事件流该键仍恰一条（无第二次效果）");

  // ── R5 效果链（正例＋负例＋补确认） ──
  info("── R5 外部效果链");
  const deliverable = path.join(tmpBase, "deliverable-a.txt");
  fs.writeFileSync(deliverable, "能力甲交付物（C014 端到端）", "utf8");
  const deliverableSha = crypto.createHash("sha256").update(fs.readFileSync(deliverable)).digest("hex");
  const dl1At = "2026-09-21T08:25:00.000Z";
  fs.writeFileSync(
    path.join(tmpBase, "deliver1.json"),
    JSON.stringify({
      observed_at: dl1At,
      effect_id: "eff-1",
      verify_method: `file_sha256:${deliverable}:${deliverableSha}`,
      deliverables: [deliverable],
      evidence_refs: ["fixture:deliverable-a"],
      verification: [{ command: "sha256sum deliverable-a.txt", exit_code: 0 }],
      untested: [],
      known_issues: [],
      exit_code: 0,
      note: "能力甲交付",
    }),
    "utf8",
  );
  const dl1 = await runOutbox(["deliver", "--home", outboxHome, "--run", run1, "--payload-file", path.join(tmpBase, "deliver1.json")]);
  ok(dl1.code === 0 && JSON.parse(dl1.stdout || "{}").status === "confirmed", `R5-1 交付＋效果核实 → confirmed（${dl1.stdout.trim()}）`);
  const ev5 = readEvents(projDir);
  ok(ofType(ev5, "execution.effect_declared").some((e) => e.payload.effect_id === "eff-1"), "R5-2 effect_declared 落账（eff-1）");
  ok(ofType(ev5, "execution.delivered").length === 1, "R5-3 execution.delivered 落账");
  const confirmedEff1 = ofType(ev5, "execution.effect_confirmed").filter((e) => e.payload.effect_id === "eff-1");
  ok(confirmedEff1.length === 1 && confirmedEff1[0].payload.result_ref === `sha256:${deliverableSha}`, "R5-4 effect_confirmed 落账且 result_ref=sha256:<实测哈希>");

  // 负例与补确认：verify_method 从一开始就指向**最终真实内容**的哈希（意图不变），只是文件尚未生成——
  // 核实不成立 → 不确认、不盲重放；文件补齐（世界追上意图）→ recover 按原键补确认恰一次（§5.4 原话场景）。
  const claim2 = await runOutbox(["claim", "--home", outboxHome, "--project", PROJECT, "--task", "T-2", "--real", "--workspace", wsDir, "--change", CHG, "--goal", "C014 端到端：能力乙落成"]);
  ok(claim2.code === 0, "R5-5 T-2 claim --real 成功（效果链负例用）");
  const run2 = String(JSON.parse(claim2.stdout || "{}").run ?? "");
  const missingFile = path.join(tmpBase, "deliverable-b.txt");
  const plannedContent = "能力乙交付物（补齐）";
  const plannedSha = crypto.createHash("sha256").update(plannedContent).digest("hex");
  const dl2At = "2026-09-21T08:30:00.000Z";
  fs.writeFileSync(
    path.join(tmpBase, "deliver2.json"),
    JSON.stringify({
      observed_at: dl2At,
      effect_id: "eff-2",
      verify_method: `file_sha256:${missingFile}:${plannedSha}`,
      deliverables: [missingFile],
      evidence_refs: [],
      exit_code: 0,
      note: "能力乙交付（文件尚未生成）",
    }),
    "utf8",
  );
  const dl2 = await runOutbox(["deliver", "--home", outboxHome, "--run", run2, "--payload-file", path.join(tmpBase, "deliver2.json")]);
  ok(dl2.code === 0 && JSON.parse(dl2.stdout || "{}").status === "submitted", `R5-6 效果未生成 → 交付落账但不确认（${dl2.stdout.trim()}）`);
  ok(!ofType(readEvents(projDir), "execution.effect_confirmed").some((e) => e.payload.effect_id === "eff-2"), "R5-7 无 eff-2 的 effect_confirmed（不冒充已生效）");
  const recover3 = await runOutbox(["recover", "--home", outboxHome]);
  const rep3 = JSON.parse(recover3.stdout || "{}") as { unresolved?: number };
  ok(recover3.code === 2 && rep3.unresolved === 1, `R5-8 recover 核实不成立 → unresolved＋exit 2（${recover3.stdout.trim()}）`);
  ok(readLedger(outboxHome).some((l) => l.type === "delivery" && l.status === "unresolved" && String(l.unresolved_reason ?? "").length > 0), "R5-9 台账记 unresolved 与原因（停止盲重放）");
  ok(ofType(readEvents(projDir), "execution.delivered").length === 2, "R5-10 不重放动作（delivered 不因恢复重复落账）");

  fs.writeFileSync(missingFile, plannedContent, "utf8");
  const recover4 = await runOutbox(["recover", "--home", outboxHome]);
  const rep4 = JSON.parse(recover4.stdout || "{}") as { confirmed?: number; unresolved?: number };
  ok(recover4.code === 0 && rep4.confirmed === 1 && rep4.unresolved === 0, `R5-11 文件补齐（世界追上意图）→ recover 按原键补确认（${recover4.stdout.trim()}）`);
  const eff2Confirmed = ofType(readEvents(projDir), "execution.effect_confirmed").filter((e) => e.payload.effect_id === "eff-2");
  ok(eff2Confirmed.length === 1 && eff2Confirmed[0].payload.result_ref === `sha256:${plannedSha}`, "R5-12 eff-2 的 effect_confirmed 补落账恰一次、result_ref 如实");
  ok(ofType(readEvents(projDir), "execution.delivered").length === 2, "R5-13 补确认不重复落 delivered（声明/交付同键去重）");
  const recover5 = await runOutbox(["recover", "--home", outboxHome]);
  const rep5 = JSON.parse(recover5.stdout || "{}") as { resubmitted?: number; confirmed?: number; unresolved?: number };
  ok(
    recover5.code === 0 && (rep5.resubmitted ?? 0) === 5 && (rep5.confirmed ?? 0) === 0 && (rep5.unresolved ?? 0) === 0,
    `R5-14 再 recover：全部幂等去重，0 新确认 0 unresolved（${recover5.stdout.trim()}）`,
  );

  // ── R6 幂等重交 ──
  info("── R6 幂等重交");
  const ledgerBefore = readLedger(outboxHome).length;
  const eventsBefore = readEvents(projDir).length;
  const beat1Again = await runOutbox(["beat", "--home", outboxHome, "--run", run1, "--payload-file", path.join(tmpBase, "beat1.json")]);
  ok(beat1Again.code === 0, "R6-1 同内容 heartbeat 重发（exit 0）");
  ok(readLedger(outboxHome).length === ledgerBefore, "R6-2 台账不胀（同键同内容幂等重发）");
  ok(readEvents(projDir).length === eventsBefore, "R6-3 事件流不胀（服务端按键去重）");
  const beat1ConflictPayload = path.join(tmpBase, "beat1-conflict.json");
  fs.writeFileSync(beat1ConflictPayload, JSON.stringify({ observed_at: beatAt, note: "同键不同内容" }), "utf8");
  const beat1Conflict = await runOutbox(["beat", "--home", outboxHome, "--run", run1, "--payload-file", beat1ConflictPayload]);
  ok(beat1Conflict.code === 2 && beat1Conflict.stderr.includes("幂等键冲突"), "R6-4 同键不同内容被拒并点名冲突");

  // ── R7 结构不变量 ──
  info("── R7 事件流结构不变量");
  const evAll = readEvents(projDir);
  const seqOk = evAll.every((e, i) => e.seq === i + 1);
  ok(seqOk, `R7-1 seq 1..${evAll.length} 连续无洞`);
  const byEntity = new Map<string, number[]>();
  for (const e of evAll) byEntity.set(e.entity_id, [...(byEntity.get(e.entity_id) ?? []), e.entity_revision]);
  const revOk = [...byEntity.values()].every((revs) => revs.every((r, i) => r === i + 1));
  ok(revOk, "R7-2 每实体 entity_revision 连续 +1");
  ok(new Set(evAll.map((e) => e.idempotency_key)).size === evAll.length, "R7-3 幂等键全局唯一（无第二次效果）");
  const typeCounts = ["task.claimed", "execution.start_requested", "execution.started", "execution.heartbeat", "execution.checkpoint", "execution.effect_declared", "execution.delivered", "execution.effect_confirmed"]
    .map((t) => `${t}=${ofType(evAll, t).length}`)
    .join(" ");
  info(`事件流总账：${evAll.length} 条｜${typeCounts}`);

  // ── R8 run-state 缺失/撕裂与 .bak 回退（F-03/F-01，2026-09-21 收口审计）──
  info("── R8 run-state 缺失 → missing_target＋exit 2；撕尾＋完好 .bak → 回退正常");
  const runStatePath = path.join(outboxHome, "run-state.json");
  const runStateGood = fs.readFileSync(runStatePath, "utf8");
  // ① 删 run-state.json：recover 拒绝盲提交（missing_target 逐条计数并点名 run），exit 2，事件零新增
  fs.rmSync(runStatePath);
  const evBeforeMissing = readEvents(projDir).length;
  const recoverMissing = await runOutbox(["recover", "--home", outboxHome]);
  const repMissing = JSON.parse(recoverMissing.stdout || "{}") as { missing_target?: number; missing_target_runs?: string[] };
  ok(
    recoverMissing.code === 2 && repMissing.missing_target === 5 &&
      Array.isArray(repMissing.missing_target_runs) && repMissing.missing_target_runs.includes(run1),
    `R8-1 删 run-state.json → recover 拒绝盲提交：missing_target=5（5 条未完结回执）、点名 run、exit 2（${recoverMissing.stdout.trim()}）`,
  );
  ok(readEvents(projDir).length === evBeforeMissing, "R8-2 缺 ExecutionTarget 时事件流零新增（不盲提交、不冒充恢复成功）");
  // ② 修复登记后恢复照常（missing_target 归零）
  fs.writeFileSync(runStatePath, runStateGood, "utf8");
  const recoverFixed = await runOutbox(["recover", "--home", outboxHome]);
  ok(recoverFixed.code === 0 && (JSON.parse(recoverFixed.stdout || "{}") as { missing_target?: number }).missing_target === 0,
    `R8-3 修复 run-state 后 recover 照常：missing_target=0、exit 0（${recoverFixed.stdout.trim()}）`);
  // ③ 撕尾 run-state + 完好 .bak：回退 .bak，recover 正常（F-01 证据；.bak 含 run1 登记，5 条按原键去重）
  fs.writeFileSync(runStatePath, runStateGood.slice(0, Math.floor(runStateGood.length / 2)), "utf8"); // 半截 JSON＝撕裂
  const recoverBak = await runOutbox(["recover", "--home", outboxHome]);
  const repBak = JSON.parse(recoverBak.stdout || "{}") as { resubmitted?: number; duplicates?: number; missing_target?: number };
  ok(
    recoverBak.code === 0 && repBak.resubmitted === 5 && repBak.duplicates === 5 && repBak.missing_target === 0,
    `R8-4 撕尾 run-state＋完好 .bak → 回退 .bak：5 条按原键去重、missing_target=0、exit 0（${recoverBak.stdout.trim()}）`,
  );
  fs.writeFileSync(runStatePath, runStateGood, "utf8"); // 收尾还原好主文件

  // ── R9 home 级互斥锁（F-02，2026-09-21 收口审计）──
  info("── R9 home 级互斥锁：活 holder 明确拒＋台账零丢失；死 holder 接管");
  const lockPath = path.join(outboxHome, "outbox.lock");
  const ledgerLinesBefore = readLedger(outboxHome);
  const ledgerBytesBefore = fs.readFileSync(ledgerPathOf(outboxHome), "utf8");
  // ① 活 holder（种进本验证进程自己的活 pid，模拟 recover/任意进程持锁期间）→ beat/recover 明确拒
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, acquired_at: new Date().toISOString() }) + "\n", "utf8");
  const beat4At = "2026-09-21T08:40:00.000Z";
  fs.writeFileSync(path.join(tmpBase, "beat4.json"), JSON.stringify({ observed_at: beat4At, note: "锁测试心跳" }), "utf8");
  const beatLocked = await runOutbox(["beat", "--home", outboxHome, "--run", run1, "--payload-file", path.join(tmpBase, "beat4.json")]);
  ok(
    beatLocked.code === 2 && beatLocked.stderr.includes("正持有"),
    `R9-1 持锁期间并发 beat → 明确拒（exit ${beatLocked.code}：${beatLocked.stderr.trim().slice(0, 90)}）`,
  );
  const recoverLocked = await runOutbox(["recover", "--home", outboxHome]);
  ok(recoverLocked.code === 2 && recoverLocked.stderr.includes("正持有"), `R9-2 持锁期间并发 recover → 同样明确拒（exit ${recoverLocked.code}）`);
  ok(fs.readFileSync(ledgerPathOf(outboxHome), "utf8") === ledgerBytesBefore, "R9-3 并发被拒后台账逐字节不变（零丢失零追加）");
  // ② 释放后 beat 照常：两进程台账合并计数对得上（恰 +1 行、既有行全在、新键登记）
  fs.rmSync(lockPath);
  const beatAfter = await runOutbox(["beat", "--home", outboxHome, "--run", run1, "--payload-file", path.join(tmpBase, "beat4.json")]);
  const ledgerAfterBeat = readLedger(outboxHome);
  ok(
    beatAfter.code === 0 && JSON.parse(beatAfter.stdout || "{}").status === "submitted" &&
      ledgerAfterBeat.length === ledgerLinesBefore.length + 1 &&
      ledgerLinesBefore.every((l) => ledgerAfterBeat.some((x) => x.idempotency_key === l.idempotency_key)) &&
      ledgerAfterBeat.some((x) => x.idempotency_key === `${run1}:heartbeat:${beat4At}`),
    `R9-4 锁释放后 beat 照常：台账恰 +1 行、既有 ${ledgerLinesBefore.length} 行全在、新键登记（并发零丢失）（${beatAfter.stdout.trim()}）`,
  );
  // ③ 死 holder（pid 已死）→ 死锁接管，beat 照常，子命令结束锁清走
  const deadProc = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  await new Promise((r) => deadProc.on("exit", r));
  fs.writeFileSync(lockPath, JSON.stringify({ pid: deadProc.pid ?? -1, acquired_at: new Date().toISOString() }) + "\n", "utf8");
  const beat5At = "2026-09-21T08:45:00.000Z";
  fs.writeFileSync(path.join(tmpBase, "beat5.json"), JSON.stringify({ observed_at: beat5At, note: "死锁接管心跳" }), "utf8");
  const beatTakeover = await runOutbox(["beat", "--home", outboxHome, "--run", run1, "--payload-file", path.join(tmpBase, "beat5.json")]);
  ok(
    beatTakeover.code === 0 && JSON.parse(beatTakeover.stdout || "{}").status === "submitted",
    `R9-5 死 holder（pid ${String(deadProc.pid)} 已退出）的锁被接管：beat 照常提交（${beatTakeover.stdout.trim()}）`,
  );
  ok(!fs.existsSync(lockPath), "R9-6 子命令结束锁已释放（finally＋exit 兜底清理生效，不留死锁）");

  // ── 清理 ──
  await stopChild(server2);
  if (process.env.TATAI_KEEP_TMP === "1") {
    info(`临时现场：${tmpBase}`);
  } else {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    info("临时现场：已清理");
  }
}

main()
  .catch((e) => {
    console.error(`[verify-c014] FAIL 未捕获异常：${(e as Error).stack ?? String(e)}`);
    failCount++;
    process.exitCode = 1;
  })
  .finally(() => {
    console.log(`[verify-c014] PASS ${passCount} / FAIL ${failCount}（总计 ${passCount + failCount} 条）`);
  });
