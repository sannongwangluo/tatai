// G1 验证脚本（用 tsx 跑）：模块层 + HTTP 层覆盖 G1 卡 DoD。
// 用法：pnpm verify:g1（自带临时 TATAI_HOME 与临时项目目录，不碰真实注册表与真实项目）
// 覆盖点（PLAN.md G1 DoD 逐条）：
//   ① 初始化后 progress.json 结构符合 DESIGN.md §2.3.2（version/gate.current_step/history 七步全 pending/modules[]）
//   ② 写一条转移后 gate.jsonl 追加一行且字段符合 §2.3.3（ts/step/result/by/note），progress history 同步
//   ③ 模块状态只接受四值 todo/doing/done/issue，非法值（"wip"）报错
//   ④ history 里既有 pass 也有 pending 时读取结果正确
//   ⑤ tasks.json 结构符合 §2.3.4（id/title/module_id/status/reporter/updated_at）
//   另：HTTP 最小集（progress/gate/gate.jsonl/tasks/modules）+ 路径安全（未知项目 404，不接受前端传路径）
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  addModule,
  addTask,
  GATE_STEPS,
  initWorkstation,
  listTasks,
  readGateLines,
  readProgress,
  recordGateTransition,
  setCurrentStep,
  setModuleStatus,
  setTaskStatus,
  WsError,
} from "../src/server/workstation";

const PORT = 8795;
const BASE = `http://localhost:${PORT}`;

const ok = (cond: boolean, label: string) => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (!cond) process.exitCode = 1;
};

// ── 准备临时数据目录与一个临时项目（不碰真实三个项目）──
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-g1-verify-"));
const dataDir = path.join(tmpBase, "home");
const projDir = path.join(tmpBase, "g1-proj");
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(projDir);
fs.writeFileSync(
  path.join(dataDir, "registry.json"),
  JSON.stringify(
    {
      version: 1,
      projects: [
        {
          id: "g1-proj",
          name: "G1 临时项目",
          path: projDir,
          kind: "backend",
          registered_at: "2026-09-17T10:00:00+08:00",
          last_opened_at: "2026-09-17T10:00:00+08:00",
        },
      ],
    },
    null,
    2,
  ),
  "utf8",
);
const benchDir = path.join(projDir, ".工作台");
const progressFile = path.join(benchDir, "progress.json");
const gateFile = path.join(benchDir, "gate.jsonl");
const tasksFile = path.join(benchDir, "tasks.json");

// ── 起真实后端子进程（临时 TATAI_HOME + 独立端口）──
await assertPortFree(PORT); // 端口已被占：立刻失败，不拿占用者的服务跑验证
const child = spawn(
  process.execPath,
  ["--import", "tsx", path.join("src", "server", "index.ts")],
  {
    env: { ...process.env, TATAI_HOME: dataDir, TATAI_PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
child.stderr.on("data", (d: Buffer) => process.stderr.write(`[server] ${d}`));
watchChild(child, PORT, () => upPorts.has(PORT)); // 子进程早退（EADDRINUSE）立刻报错退出

async function waitUp(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) {
        upPorts.add(PORT);
        return;
      }
    } catch {
      // 还没起来，继续等
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("后端 10 秒内未就绪");
}

// ── 端口冲突快速失败（2026-09-18 加）────────────────────────────────
// 端口被残留服务 / 并行会话占用时，子进程 EADDRINUSE 会静默死掉，而 waitUp 会打到占用者身上，
// 导致后续莫名 404 崩溃或对错误数据假通过。这里：起前探端口 → 起后盯早退。
const upPorts = new Set<number>();

function portListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: "127.0.0.1" });
    const done = (busy: boolean) => {
      sock.destroy();
      resolve(busy);
    };
    sock.once("connect", () => done(true)); // 有人监听 = 端口被占
    sock.once("error", () => done(false)); // 拒绝连接 = 端口空闲
    sock.setTimeout(1000, () => done(false));
  });
}

/** 起前预探测：端口已被占用立刻报错退出，不拿别人的服务跑验证 */
async function assertPortFree(port: number): Promise<void> {
  if (await portListening(port)) {
    console.error(`[verify] 后端起不来：端口 ${port} 被占用，先清理残留进程`);
    process.exit(1);
  }
}

/** 起后盯早退：子进程在就绪前退出（典型 EADDRINUSE）立即报错退出，不再继续验证 */
function watchChild(proc: ChildProcess, port: number, isUp: () => boolean): void {
  proc.once("exit", async (code) => {
    if (isUp()) return; // 脚本自己收尾杀的，不算异常
    const why = (await portListening(port))
      ? `端口 ${port} 被占用`
      : `后端进程提前退出（code=${code}）`;
    console.error(`[verify] 后端起不来：${why}，先清理残留进程`);
    process.exit(1);
  });
}

const expectWsError = (fn: () => unknown, code: WsError["code"], label: string) => {
  try {
    fn();
  } catch (e) {
    const hit = e instanceof WsError && e.code === code;
    console.log(`[verify] 报错信息: ${(e as Error).message}`);
    ok(hit, label);
    return;
  }
  ok(false, `${label}（未抛错）`);
};

try {
  await waitUp();
  console.log(`[verify] server up at ${BASE} (TATAI_HOME=${dataDir})`);

  // ── DoD① 初始化：progress.json 结构符合 §2.3.2 ──
  ok(!fs.existsSync(benchDir), "DoD① 前置：临时项目没有 .工作台/");
  const created = initWorkstation("g1-proj", dataDir);
  ok(created === true && fs.existsSync(progressFile), "DoD① 初始化创建 .工作台/progress.json");
  ok(initWorkstation("g1-proj", dataDir) === false, "DoD① 初始化幂等：已存在不覆盖");
  const init = JSON.parse(fs.readFileSync(progressFile, "utf8"));
  ok(init.version === 1, "DoD① version === 1");
  ok(init.gate?.current_step === "kickoff", "DoD① current_step 指向七步第一步 kickoff");
  ok(
    Array.isArray(init.gate?.history) &&
      init.gate.history.length === 7 &&
      init.gate.history.every(
        (h: { step: string; result: string; at: unknown; note: unknown }, i: number) =>
          h.step === GATE_STEPS[i].id && h.result === "pending" && h.at === null && h.note === null,
      ),
    "DoD① history 七步（kickoff→deliver）全 pending、at/note 为 null",
  );
  ok(Array.isArray(init.modules) && init.modules.length === 0, "DoD① modules 为空数组");
  console.log("[verify] 初始化产物 progress.json:");
  console.log(fs.readFileSync(progressFile, "utf8"));

  // ── DoD② 写一条转移：gate.jsonl 追加一行（§2.3.3）+ progress history 同步 ──
  const after = recordGateTransition(
    "g1-proj",
    { step: "kickoff", result: "pass", note: "立项确认" },
    dataDir,
  );
  ok(
    after.gate.history[0].step === "kickoff" &&
      after.gate.history[0].result === "pass" &&
      typeof after.gate.history[0].at === "string" &&
      after.gate.history[0].note === "立项确认",
    "DoD② progress history[0] 同步为 pass（带时间戳与 note）",
  );
  ok(after.gate.current_step === "requirement", "DoD② pass 后 current_step 推进到 requirement");
  const gateLines = readGateLines("g1-proj", dataDir);
  ok(gateLines.length === 1, "DoD② gate.jsonl 追加一行");
  const gl = gateLines[0];
  ok(
    typeof gl.ts === "string" &&
      gl.step === "kickoff" &&
      gl.result === "pass" &&
      gl.by === "user" &&
      gl.note === "立项确认",
    "DoD② gate.jsonl 行字段符合 §2.3.3（ts/step/result/by/note）",
  );
  console.log("[verify] gate.jsonl 原文:", fs.readFileSync(gateFile, "utf8").trim());
  // 再打回一次 requirement：reject 后 current_step 停留在本步，jsonl 只追加不改历史行
  recordGateTransition("g1-proj", { step: "requirement", result: "reject", note: "需求没想清，打回" }, dataDir);
  const afterReject = readProgress("g1-proj", dataDir);
  ok(
    afterReject.gate.current_step === "requirement" &&
      afterReject.gate.history[1].result === "reject",
    "DoD② reject 后 current_step 回退/停留在被打回步",
  );
  ok(
    readGateLines("g1-proj", dataDir).length === 2 &&
      fs.readFileSync(gateFile, "utf8").trim().split("\n").length === 2,
    "DoD② gate.jsonl 只追加（1→2 行），历史行不被修改",
  );

  // ── DoD④ history 里 pass 与 pending 混合时读取正确 ──
  const mixed = readProgress("g1-proj", dataDir);
  ok(
    mixed.gate.history[0].result === "pass" &&
      mixed.gate.history[2].result === "pending" &&
      mixed.gate.history[6].step === "deliver" &&
      mixed.gate.history[6].result === "pending",
    "DoD④ pass/reject/pending 混合的 history 读取正确（kickoff=pass，design/deliver=pending）",
  );

  // ── DoD③ 模块状态非法值（"wip"）报错 ──
  addModule("g1-proj", { id: "m-arch", name: "架构图引擎" }, dataDir);
  expectWsError(
    () => setModuleStatus("g1-proj", "m-arch", "wip" as never, dataDir),
    "INVALID_MODULE_STATUS",
    "DoD③ 模块状态非法值 wip 报 INVALID_MODULE_STATUS",
  );
  setModuleStatus("g1-proj", "m-arch", "doing", dataDir);
  ok(
    readProgress("g1-proj", dataDir).modules[0].status === "doing",
    "DoD③ 合法四值 doing 写入成功",
  );
  expectWsError(
    () => setModuleStatus("g1-proj", "no-such-module", "done", dataDir),
    "MODULE_NOT_FOUND",
    "DoD③ 不存在的模块报 MODULE_NOT_FOUND",
  );

  // ── 迭代回「需求」步（§5.1）：current_step 回 requirement，其后各步重置 pending ──
  const back = setCurrentStep("g1-proj", "requirement", dataDir);
  ok(
    back.gate.current_step === "requirement" &&
      back.gate.history[0].result === "pass" &&
      back.gate.history.slice(1).every((h) => h.result === "pending" && h.at === null),
    "§5.1 迭代回需求：current_step=requirement，requirement 起各步重置 pending（kickoff 留痕不动）",
  );

  // ── DoD⑤ tasks.json 结构符合 §2.3.4 ──
  const t1 = addTask(
    "g1-proj",
    { id: "t-001", title: "实现 tree-sitter 顶层模块解析", module_id: "m-arch", reporter: "kimi-code" },
    dataDir,
  );
  ok(
    t1.id === "t-001" &&
      t1.title === "实现 tree-sitter 顶层模块解析" &&
      t1.module_id === "m-arch" &&
      t1.status === "todo" &&
      t1.reporter === "kimi-code" &&
      typeof t1.updated_at === "string",
    "DoD⑤ addTask 返回字段符合 §2.3.4（id/title/module_id/status/reporter/updated_at）",
  );
  const tasksOnDisk = JSON.parse(fs.readFileSync(tasksFile, "utf8"));
  ok(
    tasksOnDisk.version === 1 && Array.isArray(tasksOnDisk.tasks) && tasksOnDisk.tasks.length === 1,
    "DoD⑤ tasks.json 落盘为 { version:1, tasks:[...] }",
  );
  const t1b = setTaskStatus("g1-proj", "t-001", "blocked", dataDir);
  ok(
    t1b.status === "blocked" && listTasks("g1-proj", dataDir)[0].status === "blocked",
    "DoD⑤ 任务状态改为 blocked（§5.3 四值）并落盘",
  );
  expectWsError(
    () => setTaskStatus("g1-proj", "t-001", "wip" as never, dataDir),
    "INVALID_TASK_STATUS",
    "DoD⑤ 任务状态非法值 wip 报 INVALID_TASK_STATUS",
  );
  expectWsError(
    () => addTask("g1-proj", { id: "t-001", title: "重复", module_id: "m-arch", reporter: "kimi-code" }, dataDir),
    "TASK_EXISTS",
    "DoD⑤ 任务 id 重复报 TASK_EXISTS",
  );

  // ── 路径安全：未注册项目一律 PROJECT_NOT_FOUND（只走注册表，不接受前端传路径）──
  expectWsError(
    () => readProgress("..\\..\\Windows", dataDir),
    "PROJECT_NOT_FOUND",
    "路径安全：伪造 id 试图越权读任意目录被注册表拦下（PROJECT_NOT_FOUND）",
  );

  // ── HTTP 最小集（供 G2/G3 UI 用）──
  // 换一个干净项目走 HTTP（验证 GET progress 自动初始化）
  fs.mkdirSync(path.join(tmpBase, "g1-http"));
  const reg = JSON.parse(fs.readFileSync(path.join(dataDir, "registry.json"), "utf8"));
  reg.projects.push({
    id: "g1-http",
    name: "G1 HTTP 项目",
    path: path.join(tmpBase, "g1-http"),
    kind: "backend",
    registered_at: "2026-09-17T10:00:00+08:00",
    last_opened_at: "2026-09-17T10:00:00+08:00",
  });
  fs.writeFileSync(path.join(dataDir, "registry.json"), JSON.stringify(reg, null, 2), "utf8");

  const gp = await fetch(`${BASE}/api/projects/g1-http/progress`);
  const gpBody = (await gp.json()) as { ok: boolean; progress?: { gate: { current_step: string; history: unknown[] } } };
  ok(
    gp.status === 200 &&
      gpBody.ok === true &&
      gpBody.progress?.gate.current_step === "kickoff" &&
      gpBody.progress.gate.history.length === 7,
    "HTTP GET /api/projects/:id/progress → 200，缺文件自动初始化（七步 pending）",
  );

  const gateRes = await fetch(`${BASE}/api/projects/g1-http/gate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ step: "kickoff", result: "pass", note: "立项确认" }),
  });
  const gateBody = (await gateRes.json()) as { ok: boolean; progress?: { gate: { current_step: string } } };
  ok(
    gateRes.status === 200 && gateBody.ok === true && gateBody.progress?.gate.current_step === "requirement",
    "HTTP POST /api/projects/:id/gate → 200，current_step 推进到 requirement",
  );

  const jsonlRes = await fetch(`${BASE}/api/projects/g1-http/gate.jsonl`);
  const jsonlText = await jsonlRes.text();
  const jsonlLine = JSON.parse(jsonlText.trim());
  ok(
    jsonlRes.status === 200 &&
      jsonlLine.step === "kickoff" &&
      jsonlLine.result === "pass" &&
      jsonlLine.by === "user" &&
      jsonlLine.note === "立项确认" &&
      typeof jsonlLine.ts === "string",
    "HTTP GET /api/projects/:id/gate.jsonl → 200，ndjson 行字段符合 §2.3.3",
  );

  const badGate = await fetch(`${BASE}/api/projects/g1-http/gate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ step: "oops", result: "pass" }),
  });
  const badGateBody = (await badGate.json()) as { ok: boolean; error?: { code: string } };
  ok(
    badGate.status === 400 && badGateBody.error?.code === "INVALID_STEP",
    "HTTP POST gate 非法 step → 400 INVALID_STEP",
  );

  const noProj = await fetch(`${BASE}/api/projects/no-such/progress`);
  const noProjBody = (await noProj.json()) as { error?: { code: string } };
  ok(
    noProj.status === 404 && noProjBody.error?.code === "PROJECT_NOT_FOUND",
    "HTTP 未知项目 → 404 PROJECT_NOT_FOUND（路径只走注册表）",
  );

  const postTask = await fetch(`${BASE}/api/projects/g1-http/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "t-100", title: "HTTP 加的任务", module_id: "m-x", reporter: "codex" }),
  });
  const postTaskBody = (await postTask.json()) as { ok: boolean; task?: { status: string; reporter: string } };
  ok(
    postTask.status === 200 && postTaskBody.task?.status === "todo" && postTaskBody.task?.reporter === "codex",
    "HTTP POST /api/projects/:id/tasks → 200，缺省状态 todo",
  );
  const stRes = await fetch(`${BASE}/api/projects/g1-http/tasks/t-100/status`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "doing" }),
  });
  ok(stRes.status === 200, "HTTP POST /api/projects/:id/tasks/:taskId/status → 200");
  const listRes = await fetch(`${BASE}/api/projects/g1-http/tasks`);
  const listBody = (await listRes.json()) as { ok: boolean; tasks?: { id: string; status: string }[] };
  ok(
    listRes.status === 200 && listBody.tasks?.length === 1 && listBody.tasks[0].status === "doing",
    "HTTP GET /api/projects/:id/tasks → 200，状态已更新为 doing",
  );

  await fetch(`${BASE}/api/projects/g1-http/modules`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "m-x", name: "HTTP 模块" }),
  });
  const badMod = await fetch(`${BASE}/api/projects/g1-http/modules/m-x/status`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "wip" }),
  });
  const badModBody = (await badMod.json()) as { error?: { code: string } };
  ok(
    badMod.status === 400 && badModBody.error?.code === "INVALID_MODULE_STATUS",
    "HTTP 模块状态非法值 wip → 400 INVALID_MODULE_STATUS（DoD③ HTTP 侧）",
  );
} finally {
  child.kill();
  fs.rmSync(tmpBase, { recursive: true, force: true });
}

console.log(process.exitCode ? "[verify] 存在 FAIL" : "[verify] 全部 PASS");
