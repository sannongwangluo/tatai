// G3 验证脚本（用 tsx 跑）：HTTP + 逻辑层断言 gate 转移的权限口径与留痕。
// 用法：pnpm verify:g3（自带临时 TATAI_HOME 与临时项目目录，不碰真实注册表与真实项目）
// 覆盖点（PLAN.md G3 DoD 与施工图）：
//   ① 只有人能触发转移：by 固定 "user"，非 user 被拒（400 INVALID_INPUT）；
//      MCP 工具清单（§6.3）无 gate 写入工具——代码注释口径，无接口可测
//   ② pass 留痕：gate.jsonl 多一行 result:"pass"，ts/step/result/by/note 字段齐
//   ③ reject 留痕 + note 必填：无 note / 空白 note 被拒（400），带 note 才写入
//   ④ 迭代回「需求」（§5.1）：current_step 回 requirement、其后步重置 pending、
//      目标是 design/develop 等非 requirement 时被拒（400）
//   另：pass 只对当前步（非当前步 400 NOT_CURRENT_STEP）；reject 任意步可打回，含已过
//      的历史步（2026-09-19 主人拍板：打回后 current_step 拉回该步、其后步重置 pending）；
//      gate.jsonl 行只增不减
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  GATE_STEPS,
  WsError,
  recordGateTransition,
  type GateLine,
  type Progress,
} from "../src/server/workstation";

const PORT = 8794;
const BASE = `http://localhost:${PORT}`;

const ok = (cond: boolean, label: string) => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (!cond) process.exitCode = 1;
};

// ── 准备临时数据目录与两个临时项目（g3-logic 走逻辑层、g3-proj 走 HTTP，不碰真实项目）──
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-g3-verify-"));
const dataDir = path.join(tmpBase, "home");
const projLogic = path.join(tmpBase, "g3-logic");
const projHttp = path.join(tmpBase, "g3-proj");
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(projLogic);
fs.mkdirSync(projHttp);
const regEntry = (id: string, p: string) => ({
  id,
  name: id,
  path: p,
  kind: "backend",
  registered_at: "2026-09-17T10:00:00+08:00",
  last_opened_at: "2026-09-17T10:00:00+08:00",
});
fs.writeFileSync(
  path.join(dataDir, "registry.json"),
  JSON.stringify(
    { version: 1, projects: [regEntry("g3-logic", projLogic), regEntry("g3-proj", projHttp)] },
    null,
    2,
  ),
  "utf8",
);

function expectWsError(fn: () => unknown, code: WsError["code"], label: string): void {
  try {
    fn();
  } catch (e) {
    ok(e instanceof WsError && e.code === code, `${label}（实际: ${(e as Error).message}）`);
    return;
  }
  ok(false, `${label}（实际: 未抛错）`);
}

// ── 逻辑层（直接调 workstation 层，不起服务）──
// 初始 current_step=kickoff：对非当前步 design 转移必须被拒
expectWsError(
  () => recordGateTransition("g3-logic", { step: "design", result: "pass", note: "x" }, dataDir),
  "NOT_CURRENT_STEP",
  "逻辑层：非当前步转移被拒（NOT_CURRENT_STEP）",
);
expectWsError(
  () => recordGateTransition("g3-logic", { step: "kickoff", result: "reject" }, dataDir),
  "INVALID_INPUT",
  "逻辑层：reject 无 note 被拒（INVALID_INPUT）",
);
expectWsError(
  () =>
    recordGateTransition(
      "g3-logic",
      { step: "kickoff", result: "reject", note: "   " },
      dataDir,
    ),
  "INVALID_INPUT",
  "逻辑层：reject 空白 note 同样被拒（打回必须说明理由）",
);
expectWsError(
  () =>
    recordGateTransition(
      "g3-logic",
      { step: "kickoff", result: "pass", note: "x", by: "kimi-code" },
      dataDir,
    ),
  "INVALID_INPUT",
  '逻辑层：by 非 "user" 被拒（§5.2 只有人能触发转移）',
);
const logicPass = recordGateTransition(
  "g3-logic",
  { step: "kickoff", result: "pass", note: "逻辑层立项确认" },
  dataDir,
);
ok(
  logicPass.gate.current_step === "requirement" && logicPass.gate.history[0].result === "pass",
  "逻辑层：合法 pass 写入成功，current_step 推进到 requirement",
);

// ── 打回已过的历史步（2026-09-19 主人拍板：任意步可打回）──
// kickoff 已过、当前步是 requirement：打回 kickoff → current_step 拉回 kickoff、其后各步重置 pending
const logicRejectBack = recordGateTransition(
  "g3-logic",
  { step: "kickoff", result: "reject", note: "历史步打回（逻辑层验证）" },
  dataDir,
);
ok(
  logicRejectBack.gate.current_step === "kickoff" &&
    logicRejectBack.gate.history[0].result === "reject" &&
    logicRejectBack.gate.history[0].note === "历史步打回（逻辑层验证）" &&
    logicRejectBack.gate.history
      .slice(1)
      .every((h) => h.result === "pending" && h.at === null && h.note === null),
  "逻辑层：打回已过的历史步 kickoff → current_step 拉回该步、其后各步重置 pending（note 留在被打回步）",
);

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

async function httpGetProgress(id: string): Promise<Progress> {
  const res = await fetch(`${BASE}/api/projects/${id}/progress`);
  const body = (await res.json()) as { ok: boolean; progress: Progress };
  if (!body.ok) throw new Error(`GET progress 失败: ${JSON.stringify(body)}`);
  return body.progress;
}

async function httpGetGateLines(id: string): Promise<GateLine[]> {
  const res = await fetch(`${BASE}/api/projects/${id}/gate.jsonl`);
  const text = await res.text();
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as GateLine);
}

interface GateResp {
  status: number;
  body: { ok: boolean; progress?: Progress; error?: { code: string; message: string } };
}

async function httpPostGate(id: string, input: Record<string, unknown>): Promise<GateResp> {
  const res = await fetch(`${BASE}/api/projects/${id}/gate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  return { status: res.status, body: (await res.json()) as GateResp["body"] };
}

async function httpPostGateBack(id: string, step: string): Promise<GateResp> {
  const res = await fetch(`${BASE}/api/projects/${id}/gate/back`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ step }),
  });
  return { status: res.status, body: (await res.json()) as GateResp["body"] };
}

// gate.jsonl 行只增不减：每次断言行数符合预期即同时证明"没减"（行数被逐步盯死）
async function expectLineCount(id: string, n: number, label: string): Promise<GateLine[]> {
  const lines = await httpGetGateLines(id);
  ok(lines.length === n, `${label}（gate.jsonl 行数 == ${n}，只增不减）`);
  return lines;
}

try {
  await waitUp();
  console.log(`[verify] server up at ${BASE} (TATAI_HOME=${dataDir})`);

  const p0 = await httpGetProgress("g3-proj");
  ok(p0.gate.current_step === "kickoff", "初始：current_step=kickoff");
  await expectLineCount("g3-proj", 0, "初始：gate.jsonl 为空");

  // ── 非当前步转移被拒（400 NOT_CURRENT_STEP），jsonl 不变 ──
  const notCurrent = await httpPostGate("g3-proj", { step: "design", result: "pass", note: "x" });
  ok(
    notCurrent.status === 400 && notCurrent.body.error?.code === "NOT_CURRENT_STEP",
    "HTTP：非当前步转移被拒（400 NOT_CURRENT_STEP，别让步乱跳）",
  );
  await expectLineCount("g3-proj", 0, "被拒后 jsonl 未写入");

  // ── by 非 user 被拒（§5.2 只有人能触发转移）──
  const badBy = await httpPostGate("g3-proj", {
    step: "kickoff",
    result: "pass",
    note: "x",
    by: "kimi-code",
  });
  ok(
    badBy.status === 400 && badBy.body.error?.code === "INVALID_INPUT",
    'HTTP：by="kimi-code" 被拒（400，by 只接受 "user"）',
  );
  await expectLineCount("g3-proj", 0, "by 被拒后 jsonl 未写入");

  // ── reject 无 note / 空白 note 被拒（打回必须说明理由）──
  const noNote = await httpPostGate("g3-proj", { step: "kickoff", result: "reject" });
  ok(
    noNote.status === 400 && noNote.body.error?.code === "INVALID_INPUT",
    "HTTP：reject 无 note 被拒（400 INVALID_INPUT）",
  );
  const blankNote = await httpPostGate("g3-proj", {
    step: "kickoff",
    result: "reject",
    note: "   ",
  });
  ok(blankNote.status === 400, "HTTP：reject 空白 note 同样被拒");
  await expectLineCount("g3-proj", 0, "reject 被拒后 jsonl 未写入");
  const stillPending = await httpGetProgress("g3-proj");
  ok(
    stillPending.gate.history[0].result === "pending" &&
      stillPending.gate.current_step === "kickoff",
    "被拒的 reject 不污染 progress（kickoff 仍 pending、当前步未动）",
  );

  // ── DoD② 合法 pass：节点转绿 + current 推进 + jsonl 多一行（贴真实行）──
  const pass1 = await httpPostGate("g3-proj", {
    step: "kickoff",
    result: "pass",
    note: "立项确认：G3 验证录入",
  });
  ok(
    pass1.status === 200 && pass1.body.progress?.gate.current_step === "requirement",
    "HTTP：kickoff pass → 200，current_step 推进到 requirement",
  );
  const lines1 = await expectLineCount("g3-proj", 1, "pass 后 jsonl 1 行");
  const line1 = lines1[0];
  console.log(`[verify] gate.jsonl 第 1 行原文: ${JSON.stringify(line1)}`);
  ok(
    typeof line1.ts === "string" &&
      line1.step === "kickoff" &&
      line1.result === "pass" &&
      line1.by === "user" &&
      line1.note === "立项确认：G3 验证录入",
    "DoD② pass 留痕字段齐全（ts/step/result/by=user/note）",
  );
  const firstLineRaw = JSON.stringify(line1);

  // ── 已过的步也不是当前步：再点同样被拒 ──
  const again = await httpPostGate("g3-proj", { step: "kickoff", result: "pass" });
  ok(
    again.status === 400 && again.body.error?.code === "NOT_CURRENT_STEP",
    "HTTP：已过的 kickoff 再点被拒（仍非当前步）",
  );

  // ── DoD③ 合法 reject：节点转红 + 停留本步 + jsonl 多一行 ──
  const rej = await httpPostGate("g3-proj", {
    step: "requirement",
    result: "reject",
    note: "需求未冻结，打回",
  });
  ok(
    rej.status === 200 && rej.body.progress?.gate.current_step === "requirement",
    "HTTP：requirement reject → 200，current_step 停留本步",
  );
  const lines2 = await expectLineCount("g3-proj", 2, "reject 后 jsonl 2 行");
  const line2 = lines2[1];
  console.log(`[verify] gate.jsonl 第 2 行原文: ${JSON.stringify(line2)}`);
  ok(
    line2.result === "reject" && line2.note === "需求未冻结，打回" && line2.by === "user",
    "DoD③ reject 留痕（result=reject + note + by=user）",
  );
  const pRej = await httpGetProgress("g3-proj");
  const reqEntry = pRej.gate.history.find((h) => h.step === "requirement")!;
  ok(
    reqEntry.result === "reject" && reqEntry.at === line2.ts && reqEntry.note === line2.note,
    "DoD③ history 与 jsonl 口径一致（result/at/note 全等）",
  );

  // ── 一路推到 deliver（末步 pass 后 current 停留 deliver）──
  await httpPostGate("g3-proj", { step: "requirement", result: "pass", note: "需求复审通过" });
  for (const s of ["design", "tasks", "develop", "verify", "deliver"]) {
    const r = await httpPostGate("g3-proj", { step: s, result: "pass", note: `${s} 过关` });
    ok(r.status === 200, `推进：${s} pass → 200`);
  }
  const pDeliver = await httpGetProgress("g3-proj");
  ok(
    pDeliver.gate.current_step === "deliver" &&
      pDeliver.gate.history.every((h) => h.result === "pass"),
    "七步全 pass 后 current_step 停留 deliver（末步不再前进）",
  );
  await expectLineCount("g3-proj", 8, "推到 deliver 后 jsonl 8 行");

  // ── 打回已过的历史步（2026-09-19 主人拍板：任意步可打回，含历史步）──
  const rejBack = await httpPostGate("g3-proj", {
    step: "design",
    result: "reject",
    note: "设计有漏，历史步打回重走",
  });
  ok(
    rejBack.status === 200 && rejBack.body.progress?.gate.current_step === "design",
    "HTTP：打回已过的历史步 design → 200，current_step 拉回 design",
  );
  const pBack = await httpGetProgress("g3-proj");
  const byId = (id: string) => pBack.gate.history.find((h) => h.step === id)!;
  ok(
    byId("design").result === "reject" &&
      byId("design").note === "设计有漏，历史步打回重走" &&
      byId("kickoff").result === "pass" &&
      byId("requirement").result === "pass" &&
      ["tasks", "develop", "verify", "deliver"].every(
        (id) => byId(id).result === "pending" && byId(id).at === null && byId(id).note === null,
      ),
    "HTTP：历史步打回后 design=reject、之前步留痕不动、其后各步重置 pending",
  );
  const lines3 = await expectLineCount("g3-proj", 9, "历史步打回后 jsonl 9 行");
  const line3 = lines3[8];
  console.log(`[verify] gate.jsonl 第 9 行原文: ${JSON.stringify(line3)}`);
  ok(
    line3.step === "design" &&
      line3.result === "reject" &&
      line3.by === "user" &&
      line3.note === "设计有漏，历史步打回重走",
    "历史步打回照常写 gate.jsonl 流水（step/result/by/note 齐全，只增不减）",
  );

  // ── 恢复：design 起重走到 deliver（历史步打回后顺序推进照常）──
  for (const s of ["design", "tasks", "develop", "verify", "deliver"]) {
    const r = await httpPostGate("g3-proj", { step: s, result: "pass", note: `${s} 重过关` });
    ok(r.status === 200, `恢复：${s} pass → 200`);
  }
  const pRecovered = await httpGetProgress("g3-proj");
  ok(
    pRecovered.gate.current_step === "deliver" &&
      pRecovered.gate.history.every((h) => h.result === "pass"),
    "恢复：重走后七步全 pass、current_step 停留 deliver",
  );

  // ── DoD④ 迭代回「需求」（§5.1）：目标是 design/develop 等非 requirement 被拒 ──
  const backDesign = await httpPostGateBack("g3-proj", "design");
  ok(
    backDesign.status === 400 && backDesign.body.error?.code === "INVALID_STEP",
    "HTTP：迭代回 design 被拒（400，§5.1 只能回「需求」）",
  );
  const backDevelop = await httpPostGateBack("g3-proj", "develop");
  ok(backDevelop.status === 400, "HTTP：迭代回 develop 同样被拒");
  const back = await httpPostGateBack("g3-proj", "requirement");
  const bp = back.body.progress;
  ok(
    back.status === 200 &&
      bp?.gate.current_step === "requirement" &&
      bp.gate.history[0].result === "pass" &&
      bp.gate.history
        .filter((h) => GATE_STEPS.findIndex((s) => s.id === h.step) >= 1)
        .every((h) => h.result === "pending" && h.at === null && h.note === null),
    "DoD④ 迭代回需求：current_step=requirement，requirement 起各步重置 pending（kickoff 留痕不动）",
  );
  await expectLineCount("g3-proj", 14, "迭代不写 gate.jsonl（留痕由后续过关/打回负责）");

  // ── gate.jsonl 行只增不减 + 历史行不被改：首行原文与最初一致 ──
  const finalLines = await httpGetGateLines("g3-proj");
  ok(
    JSON.stringify(finalLines[0]) === firstLineRaw,
    "gate.jsonl 首行原文未被修改（历史行永不回改）",
  );
} finally {
  child.kill();
  fs.rmSync(tmpBase, { recursive: true, force: true });
}

console.log(process.exitCode ? "[verify] 存在 FAIL" : "[verify] 全部 PASS");
