// V06-01 验证脚本（PLAN.md V06-01，DESIGN.md §2.6 / §6.5）：事实写入服务与版本协议。
// 用法：pnpm verify:v06-01
//
// 自带隔离环境：临时 TATAI_HOME + 临时项目目录，不碰真实注册表与三个真实项目；
// 收尾清理自己创建的临时目录（V06 口径：合成夹具谁建谁回收，TATAI_KEEP_TMP=1 可保留现场）。
//
// 覆盖点（PLAN V06-01 检查项 1–3 逐条）：
//   ① schema/校验/错误格式：非法命令五种形态全部 INVALID_COMMAND 且**不留痕**；
//      幂等同内容（返回原回执、不产生第二次效果）、同键异内容（明确拒绝）、
//      双写者版本冲突（附当前版本、当前序号与差异入口）。
//   ② 校验→持久化→回执→投影：重放得到相同状态；seq 有洞必须暴露；
//      故障注入覆盖"已提交但快照失败"、残缺尾行（隔离+留痕+截回，不粘行）、
//      中间损坏（必须暴露，不吞）；服务离线（写拒绝 + 旧快照可读并标陈旧）。
//   ③ 真服务进程端到端：描述符发现、回环令牌、跨进程幂等与版本冲突、两进程并发序号无洞、
//      杀服务后离线降级、故障注入下 repair 面可用。
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createWorkHost } from "../src/server/workHost";
import {
  WorkService,
  WorkServiceClient,
  WORK_TOKEN_HEADER,
  readServiceDescriptor,
} from "../src/server/work/service";
import { WorkError, type WorkCommand } from "../src/server/work/types";
import {
  eventsPath,
  loadEvents,
  projectionErrorPath,
  quarantineDir,
  readSnapshotFromDisk,
  recoveryPath,
} from "../src/server/work/eventStore";

const PORT = 8796;
const BASE = `http://127.0.0.1:${PORT}`;
const REPO = process.cwd();

// 起过的服务子进程都记下来，脚本异常退出（用例抛错 / 等就绪超时）时兜底杀掉——
// 不给下一次运行留"端口被占用"的残局（Windows 上父进程被强杀不会带走子进程树）。
// 注意必须声明在**用例之前**：文件尾部还有 top-level await 之后的代码，那时才初始化就太晚了。
const spawnedServers: ChildProcess[] = [];
process.on("exit", () => {
  for (const proc of spawnedServers) {
    try {
      if (proc.exitCode === null) proc.kill("SIGKILL");
    } catch {
      // 进程已经没了：忽略
    }
  }
});

let passCount = 0;
let failCount = 0;
const ok = (cond: boolean, label: string) => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (cond) passCount++;
  else {
    failCount++;
    process.exitCode = 1;
  }
};

const NO_THROW = "(没有抛错)";
function codeOf(fn: () => unknown): string {
  try {
    fn();
    return NO_THROW;
  } catch (e) {
    return e instanceof WorkError ? e.code : `(非 WorkError: ${(e as Error).message})`;
  }
}
async function asyncCodeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return NO_THROW;
  } catch (e) {
    return e instanceof WorkError ? e.code : `(非 WorkError: ${(e as Error).message})`;
  }
}

const readLines = (file: string): string[] =>
  fs.existsSync(file) ? fs.readFileSync(file, "utf8").split(/\r?\n/).filter((l) => l.trim() !== "") : [];
const lineCount = (file: string): number => readLines(file).length;

// ── 隔离环境 ──
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-v0601-verify-"));
const dataDir = path.join(tmpBase, "home");
const projDir = path.join(tmpBase, "proj");
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(projDir, { recursive: true });
const registryOf = (id: string, name: string, dir: string): string =>
  JSON.stringify(
    {
      version: 1,
      projects: [
        {
          id,
          name,
          path: dir,
          kind: "backend",
          registered_at: "2026-09-20T00:00:00+08:00",
          last_opened_at: "2026-09-20T00:00:00+08:00",
        },
      ],
    },
    null,
    2,
  );
fs.writeFileSync(path.join(dataDir, "registry.json"), registryOf("v06-proj", "V06 临时项目", projDir), "utf8");

const workDir = path.join(projDir, ".工作台", "work");
const eventsFile = eventsPath(workDir);
const service = new WorkService({ dataDir });

function cmd(over: Partial<WorkCommand> = {}): WorkCommand {
  return {
    schema_version: 2,
    project_id: "v06-proj",
    change_id: "chg-v06-01",
    entity_id: "task-001",
    expected_revision: null,
    type: "task.created",
    actor_id: "verify",
    role: "executor",
    idempotency_key: `k-${Math.random().toString(36).slice(2, 10)}`,
    payload: { title: "第一条" },
    ...over,
  };
}

console.log("[verify] ═══ ① 协议与校验 ═══");

const invalidCases: Array<[string, unknown]> = [
  ["缺 project_id", { ...cmd(), project_id: undefined }],
  ["schema_version 不对", { ...cmd(), schema_version: 1 }],
  ["expected_revision 为负", { ...cmd(), expected_revision: -1 }],
  ["payload 超上限", { ...cmd(), payload: { blob: "x".repeat(70 * 1024) } }],
  ["type 形态非法", { ...cmd(), type: "Task Created" }],
];
for (const [label, bad] of invalidCases) {
  ok(codeOf(() => service.submit(bad)) === "INVALID_COMMAND", `A1 非法命令（${label}）→ INVALID_COMMAND`);
}
ok(!fs.existsSync(eventsFile), "A1 非法命令不留痕：事件文件根本没被创建");

const c2 = cmd();
const r2a = service.submit(c2);
const r2b = service.submit(c2);
ok(r2a.ok === true && r2a.duplicate === false, "A2 首次提交：duplicate=false");
ok(
  r2b.duplicate === true && r2b.event_id === r2a.event_id && r2b.seq === r2a.seq,
  "A2 同键同内容重发：返回原回执（同 event_id/seq），不产生第二次效果",
);
ok(lineCount(eventsFile) === 1, `A2 事件文件仍只有 1 行（实际 ${lineCount(eventsFile)}）`);

ok(
  codeOf(() => service.submit({ ...c2, payload: { title: "换了内容的同键" } })) === "IDEMPOTENCY_CONFLICT",
  "A3 同键异内容 → IDEMPOTENCY_CONFLICT",
);
ok(lineCount(eventsFile) === 1, "A3 冲突不留痕：事件文件仍是 1 行");

const r4 = service.submit(cmd({ idempotency_key: "k-double-1", expected_revision: 1 }));
ok(
  r4.entity_revision === 2 && r4.seq === 2,
  `A4 写入者甲提交成功（revision=${r4.entity_revision}, seq=${r4.seq}）`,
);
let conflict: WorkError | null = null;
try {
  service.submit(cmd({ idempotency_key: "k-double-2", expected_revision: 1 }));
} catch (e) {
  conflict = e as WorkError;
}
ok(conflict?.code === "VERSION_CONFLICT", "A4 写入者乙拿同一旧版本提交 → VERSION_CONFLICT");
ok(
  conflict?.detail.current_revision === 2 &&
    typeof conflict?.detail.current_seq === "number" &&
    typeof conflict?.detail.diff_from_seq === "number",
  `A4 冲突回执带当前版本/序号/差异入口（current_revision=${String(conflict?.detail.current_revision)}, ` +
    `current_seq=${String(conflict?.detail.current_seq)}, diff_from_seq=${String(conflict?.detail.diff_from_seq)}）`,
);
ok(lineCount(eventsFile) === 2, "A4 冲突不留痕：事件文件仍是 2 行");

console.log("[verify] ═══ ② 持久化、重放与故障现场 ═══");

const snapBefore = readSnapshotFromDisk(workDir);
fs.rmSync(path.join(workDir, "state.json"), { force: true });
const rebuilt = service.repair("v06-proj");
ok(rebuilt.snapshot !== null && rebuilt.stale === false, "B1 删掉快照后 repair 可重建，且重建后不再陈旧");
ok(
  JSON.stringify(rebuilt.snapshot?.entities) === JSON.stringify(snapBefore?.entities) &&
    rebuilt.snapshot?.last_seq === snapBefore?.last_seq,
  `B1 重放得到相同状态（last_seq=${rebuilt.snapshot?.last_seq}）`,
);

// B1b seq 有洞 = 丢过完整事件：必须暴露，不当正常状态读
const gapHome = path.join(tmpBase, "gap-home");
const gapProj = path.join(tmpBase, "gap-proj");
fs.mkdirSync(gapHome, { recursive: true });
fs.mkdirSync(gapProj, { recursive: true });
fs.writeFileSync(path.join(gapHome, "registry.json"), registryOf("gap-proj", "洞项目", gapProj), "utf8");
const gapEvents = readLines(eventsFile).map((l, i) => {
  const e = JSON.parse(l) as { seq: number };
  if (i > 0) e.seq += 5; // 从第二条起跳号：制造序号洞（丢过完整事件）
  return JSON.stringify(e);
});
fs.mkdirSync(path.join(gapProj, ".工作台", "work"), { recursive: true });
fs.writeFileSync(path.join(gapProj, ".工作台", "work", "events.jsonl"), gapEvents.join("\n") + "\n", "utf8");
const gapCode = codeOf(() => new WorkService({ dataDir: gapHome }).readSnapshot("gap-proj"));
ok(gapCode === "EVENT_INVALID", `B1b seq 有洞 → EVENT_INVALID 暴露（实际 ${gapCode}），不当正常状态读`);

// B2 残缺尾行
const rawBefore = fs.readFileSync(eventsFile, "utf8");
fs.appendFileSync(eventsFile, '{"schema_version":2,"event_id":"半截', "utf8");
const loaded = loadEvents(workDir);
ok(loaded.tail !== null && loaded.events.length === 2, "B2 半截尾行：读侧报出 tail，前面两条完整事件照常读出");
ok(
  codeOf(() => service.submit(cmd({ entity_id: "task-002", expected_revision: 0 }))) === NO_THROW,
  "B2 带着半截尾继续写入：不粘行、不崩",
);
const quarantined = fs.existsSync(quarantineDir(workDir)) ? fs.readdirSync(quarantineDir(workDir)) : [];
ok(quarantined.length === 1, `B2 半截原文被隔离到 quarantine/（${quarantined.length} 份）`);
ok(
  quarantined.length === 1 &&
    fs
      .readFileSync(path.join(quarantineDir(workDir), quarantined[0]), "utf8")
      .includes('"event_id":"半截'),
  "B2 隔离副本保留半截原始字节（sha256 记在 recovery.jsonl）",
);
ok(
  fs.existsSync(recoveryPath(workDir)) &&
    fs.readFileSync(recoveryPath(workDir), "utf8").includes("tail_quarantined"),
  "B2 recovery.jsonl 留痕（隔离动作不静默）",
);
ok(fs.readFileSync(eventsFile, "utf8").startsWith(rawBefore), "B2 截回只截掉半行：既有完整事件逐字节不变");
ok(loadEvents(workDir).tail === null, "B2 隔离后事件文件不再有半截尾");

// B3 中段损坏必须暴露
const linesNow = readLines(eventsFile);
const corrupted = [...linesNow];
corrupted[1] = '{"schema_version":2,"event_id":"坏行在中间"';
fs.writeFileSync(eventsFile, corrupted.join("\n") + "\n", "utf8");
let middleErr: WorkError | null = null;
try {
  loadEvents(workDir);
} catch (e) {
  middleErr = e as WorkError;
}
ok(middleErr?.code === "MIDDLE_CORRUPT", "B3 中段坏行 → MIDDLE_CORRUPT（不静默跳过）");
ok(
  middleErr?.detail.line === 2 && typeof middleErr?.detail.reason === "string",
  `B3 报出位置与原因（line=${String(middleErr?.detail.line)}）`,
);
ok(
  codeOf(() => service.submit(cmd({ entity_id: "task-003", expected_revision: 0 }))) === "MIDDLE_CORRUPT",
  "B3 写入路径同样被拦住（带病不写）",
);
fs.writeFileSync(eventsFile, linesNow.join("\n") + "\n", "utf8"); // 复原现场

// B4 已提交但快照失败（故障注入）
const faultHome = path.join(tmpBase, "fault-home");
fs.mkdirSync(faultHome, { recursive: true });
fs.copyFileSync(path.join(dataDir, "registry.json"), path.join(faultHome, "registry.json"));
const faultService = new WorkService({ dataDir: faultHome, faults: { snapshot: "throw" } });
const linesBeforeFault = lineCount(eventsFile);
const r4b = faultService.submit(cmd({ entity_id: "task-f", expected_revision: 0 }));
ok(r4b.ok === true && r4b.projection.state === "failed", "B4 投影失败不回滚：回执仍成立，但如实标 projection=failed");
ok(lineCount(eventsFile) === linesBeforeFault + 1, "B4 事件确实已落盘（不因为投影失败而回退事实）");
const faultRead = faultService.readSnapshot("v06-proj");
ok(
  faultRead.stale === true && faultRead.stale_reason === "projection_failed",
  `B4 读快照如实标陈旧（stale_reason=${faultRead.stale_reason}）`,
);
ok(fs.existsSync(projectionErrorPath(workDir)), "B4 projection-error.json 记录失败原因（供修复入口识别）");
const repaired = faultService.repair("v06-proj");
ok(
  repaired.stale === false && !fs.existsSync(projectionErrorPath(workDir)),
  "B4 repair 以事件为源重建快照后，陈旧标记与失败标记一起清掉",
);

console.log("[verify] ═══ ③ 离线降级与真服务端到端 ═══");

const offlineHome = path.join(tmpBase, "offline-home");
fs.mkdirSync(offlineHome, { recursive: true });
fs.copyFileSync(path.join(dataDir, "registry.json"), path.join(offlineHome, "registry.json"));
// V07-01：autostart 显式关——离线降级语义验证的是“不本地代写”，自愈由 D3b 单独覆盖
const offlineClient = new WorkServiceClient({ dataDir: offlineHome, autostart: false });
const linesBeforeOffline = lineCount(eventsFile);
ok(
  (await asyncCodeOf(() => offlineClient.submit(cmd({ entity_id: "task-x" })))) === "SERVICE_UNAVAILABLE",
  "C0 服务不在 → 写入 SERVICE_UNAVAILABLE（不自己写文件）",
);
ok(lineCount(eventsFile) === linesBeforeOffline, "C0 离线写入不留痕（事件文件行数不变）");
const offlineSnap = await offlineClient.snapshot("v06-proj");
ok(
  offlineSnap.snapshot !== null && offlineSnap.stale === true && offlineSnap.stale_reason === "service_not_running",
  `C0 离线读：最后一份快照仍可读，但标记陈旧（${offlineSnap.stale_reason}）`,
);
const noSnapClient = new WorkServiceClient({ dataDir: path.join(tmpBase, "empty-home") });
const noSnap = await noSnapClient.snapshot("v06-proj");
ok(noSnap.snapshot === null && noSnap.stale === true, "C0 连快照都没有 → 返回未知（不假装是空状态/完成）");

await assertPortFree(PORT);
const child = spawnServer({ TATAI_HOME: dataDir, TATAI_PORT: String(PORT) });
await waitUpOn(PORT);
const desc = readServiceDescriptor(dataDir);
ok(desc !== null && desc.port === PORT, `D1 绑上之后发布描述符（port=${desc?.port}）`);
const onlineClient = new WorkServiceClient({ dataDir });
const probe = await onlineClient.probe();
ok(probe.available === true, `D1 客户端按描述符发现服务（${probe.reason ?? "ok"}）`);
const noToken = await fetch(`${BASE}/api/work/health`);
ok(noToken.status === 401, `D1 无令牌访问写入面 → 401（实际 ${noToken.status}）`);
const httpCmd = cmd({ entity_id: "task-http", expected_revision: 0 });
const onlineReceipt = await onlineClient.submit(httpCmd);
ok(onlineReceipt.ok === true, `D1 经 HTTP 提交成功（seq=${onlineReceipt.seq}）`);
const dupHttp = await onlineClient.submit(httpCmd);
ok(
  dupHttp.duplicate === true && dupHttp.event_id === onlineReceipt.event_id,
  "D1 同一命令重发 → 原回执（幂等跨进程有效，不产生第二次效果）",
);
const dupHttp3 = await onlineClient.submit({ ...httpCmd });
ok(
  dupHttp3.duplicate === true && dupHttp3.seq === onlineReceipt.seq,
  "D1 第三次重发仍是原回执（seq 不变）",
);

const seqBeforeConcurrency = lineCount(eventsFile);
await runConcurrentWriters(dataDir);
const seqs = loadEvents(workDir).events.map((e) => e.seq);
const contiguous = seqs.every((s, i) => s === i + 1);
ok(
  seqs.length === seqBeforeConcurrency + 20 && new Set(seqs).size === seqs.length && contiguous,
  `D2 两个子进程并发提交 20 条：序号唯一、连续、无洞（共 ${seqs.length} 条，最大 ${seqs[seqs.length - 1]}）`,
);

await stopChild(child);
const afterKill = await onlineClient.probe();
ok(afterKill.available === false, `D3 服务停掉后探活失败（${afterKill.reason}）`);
// 先读快照再试写：提交会触发自愈清掉死描述符，先读保证"描述符在但服务死"的陈旧口径被原样覆盖
const staleSnap = await onlineClient.snapshot("v06-proj");
ok(
  staleSnap.snapshot !== null && staleSnap.stale === true && staleSnap.stale_reason === "service_unavailable",
  `D3 离线读仍是最后一份快照 + 陈旧标记（${staleSnap.stale_reason}）`,
);
// V07-01 起自愈是默认行为，D3 断言口径随之分两半：关闸客户端证"绝不本地代写"不变量；默认客户端证自愈复活
const noHealClient = new WorkServiceClient({ dataDir, autostart: false });
ok(
  (await asyncCodeOf(() => noHealClient.submit(cmd({ entity_id: "task-dead" })))) === "SERVICE_UNAVAILABLE",
  "D3 关自愈闸：服务停掉后写入仍报 SERVICE_UNAVAILABLE（不本地代写不变量）",
);
const revivedReceipt = await onlineClient.submit(cmd({ entity_id: "task-revived" }));
ok(revivedReceipt.ok === true, `D3b 开闸自愈：按需拉起独立写入服务后写入成功（seq=${revivedReceipt.seq}）`);
const revivedDesc = readServiceDescriptor(dataDir);
ok(
  revivedDesc !== null && revivedDesc.port !== PORT,
  "D3b 复活的是独立 daemon（随机端口，不是被杀的子进程端口）",
);

const host = createWorkHost(dataDir);
host.publish(12345, "127.0.0.1");
ok(readServiceDescriptor(dataDir)?.port === 12345, "D4 publish 写入描述符（含 host/port/token）");
host.unpublish();
ok(readServiceDescriptor(dataDir) === null, "D4 unpublish 撤销描述符（客户端此后报'服务未启动'而非指向死端口）");

const faultPort = PORT + 1;
await assertPortFree(faultPort);
const faultChild = spawnServer({
  TATAI_HOME: dataDir,
  TATAI_PORT: String(faultPort),
  TATAI_WORK_FAULT_SNAPSHOT: "1",
});
await waitUpOn(faultPort);
const faultClient = new WorkServiceClient({ dataDir });
const faultReceipt = await faultClient.submit(cmd({ entity_id: "task-fault-http", expected_revision: 0 }));
ok(faultReceipt.projection.state === "failed", "D5 故障注入下投影失败仍如实回执（产品路径不受影响）");
const repairToken = readServiceDescriptor(dataDir)?.token ?? "";
const repairRes = await fetch(`http://127.0.0.1:${faultPort}/api/work/repair`, {
  method: "POST",
  headers: { "content-type": "application/json", [WORK_TOKEN_HEADER]: repairToken },
  body: JSON.stringify({ project_id: "v06-proj" }),
});
const repairBody = (await repairRes.json()) as { stale?: boolean };
ok(repairRes.ok && repairBody.stale === false, "D5 repair 面重建快照后不再陈旧");
await stopChild(faultChild);

console.log("[verify] ═══ ④ 边界与登记 ═══");

const contract = fs.readFileSync(path.join(REPO, "docs", "work-v2-contract.md"), "utf8");
for (const code of [
  "INVALID_COMMAND",
  "VERSION_CONFLICT",
  "IDEMPOTENCY_CONFLICT",
  "SERVICE_UNAVAILABLE",
  "PROJECTION_FAILED",
  "MIDDLE_CORRUPT",
  "EVENT_INVALID",
  "TAIL_QUARANTINED",
]) {
  ok(contract.includes(code), `E1 契约文档登记错误码 ${code}`);
}
ok(contract.includes("怎么恢复"), "E1 契约文档给出每个错误的恢复办法");

const routes = fs.readFileSync(path.join(REPO, "src", "server", "remote-routes.ts"), "utf8");
for (const p of ["/api/work/command", "/api/work/repair", "/api/work/health", "/api/work/snapshot"]) {
  ok(routes.includes(`path: "${p}"`), `E2 work 路由登记进 remote-routes.ts：${p}`);
}

ok(
  ["src/mcp/server.ts", "src/mcp/tools/reportTaskStatus.ts"].every(
    (f) => !fs.readFileSync(path.join(REPO, f), "utf8").includes("appendEventDurable"),
  ),
  "E3 MCP 侧不直接追加事件（写入只走转接客户端）",
);

console.log(`[verify] 结果：${passCount} PASS / ${failCount} FAIL`);
if (process.env.TATAI_KEEP_TMP !== "1") {
  const leftover = readServiceDescriptor(dataDir);
  if (leftover !== null) {
    try {
      process.kill(leftover.pid);
      await new Promise((r) => setTimeout(r, 300));
    } catch {
      /* 已死则跳过 */
    }
  }
  fs.rmSync(tmpBase, { recursive: true, force: true });
  console.log("[verify] 已清理隔离夹具目录（TATAI_KEEP_TMP=1 可保留现场）");
} else {
  console.log(`[verify] 保留现场：${tmpBase}`);
}

// ── 辅助 ──

function spawnServer(env: Record<string, string>): ChildProcess {
  const proc = spawn(process.execPath, ["--import", "tsx", path.join("src", "server", "index.ts")], {
    cwd: REPO,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  spawnedServers.push(proc);
  proc.stdout.on("data", (d: Buffer) => {
    const text = d.toString();
    if (process.env.TATAI_VERBOSE === "1") process.stdout.write(`[server] ${text}`);
  });
  proc.stderr.on("data", (d: Buffer) => process.stderr.write(`[server] ${d}`));
  return proc;
}

async function waitUpOn(port: number): Promise<void> {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok) return;
    } catch {
      // 还没起来
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`后端 ${port} 端口 15 秒内未就绪`);
}

function portListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: "127.0.0.1" });
    const done = (busy: boolean) => {
      sock.destroy();
      resolve(busy);
    };
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
    sock.setTimeout(1000, () => done(false));
  });
}

async function assertPortFree(port: number): Promise<void> {
  if (await portListening(port)) {
    console.error(`[verify] 后端起不来：端口 ${port} 被占用，先清理残留进程`);
    process.exit(1);
  }
}

async function stopChild(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null) return;
  proc.kill("SIGKILL");
  for (let i = 0; i < 40; i++) {
    if (proc.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** 两个子进程并发提交（各 10 条不同实体），用来验证唯一写入者的序号无重号无洞 */
async function runConcurrentWriters(home: string): Promise<void> {
  const writer = path.join(REPO, "scripts", "verify-v06-01-writer.ts");
  const spawnWriter = (tag: string) =>
    new Promise<void>((resolve) => {
      const p = spawn(process.execPath, ["--import", "tsx", writer, tag], {
        cwd: REPO,
        env: { ...process.env, TATAI_HOME: home },
        stdio: ["ignore", "ignore", "pipe"],
      });
      p.stderr.on("data", (d: Buffer) => process.stderr.write(`[writer-${tag}] ${d}`));
      p.once("exit", () => resolve());
    });
  await Promise.all([spawnWriter("A"), spawnWriter("B")]);
}
