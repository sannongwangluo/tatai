// G2 验证脚本（用 tsx 跑）：HTTP 层断言七步时间线两个数据源口径一致（progress.history ↔ gate.jsonl）。
// 用法：pnpm verify:g2（自带临时 TATAI_HOME 与临时项目目录，不碰真实注册表与真实项目）
// 覆盖点（PLAN.md G2 DoD 与施工图）：
//   ② 三态与 gate.jsonl 实际记录一致：history 里每个非 pending 步的 result/at/note
//      必须等于 gate.jsonl 中该步最后一行；pending 步在 gate.jsonl 中无记录
//   ③ 每步记录带时间戳与 note（点开展示的数据就是这两个字段）
//   ④ 换一个项目后时间线数据随之切换（两项目数据互不相同、互不串）
//   另：pass 推进 current_step、reject 停留本步（时间线当前步标记的数据源）
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { GATE_STEPS, type GateLine, type Progress } from "../src/server/workstation";

const PORT = 8796;
const BASE = `http://localhost:${PORT}`;

const ok = (cond: boolean, label: string) => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (!cond) process.exitCode = 1;
};

// ── 准备临时数据目录与两个临时项目（不碰真实三个项目）──
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-g2-verify-"));
const dataDir = path.join(tmpBase, "home");
const projA = path.join(tmpBase, "g2-proj-a");
const projB = path.join(tmpBase, "g2-proj-b");
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(projA);
fs.mkdirSync(projB);
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
    { version: 1, projects: [regEntry("g2-proj-a", projA), regEntry("g2-proj-b", projB)] },
    null,
    2,
  ),
  "utf8",
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

// ── 前端同口径的两个 HTTP 客户端（与 src/ui/api.ts 同一路由/解析方式）──
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

async function httpPostGate(
  id: string,
  input: { step: string; result: "pass" | "reject"; note?: string },
): Promise<Progress> {
  const res = await fetch(`${BASE}/api/projects/${id}/gate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = (await res.json()) as { ok: boolean; progress: Progress };
  if (!body.ok) throw new Error(`POST gate 失败: ${JSON.stringify(body)}`);
  return body.progress;
}

try {
  await waitUp();
  console.log(`[verify] server up at ${BASE} (TATAI_HOME=${dataDir})`);

  // ── 初始：七步全 pending，gate.jsonl 为空 ──
  const p0 = await httpGetProgress("g2-proj-a");
  ok(
    p0.gate.current_step === "kickoff" &&
      p0.gate.history.length === 7 &&
      p0.gate.history.every((h, i) => h.step === GATE_STEPS[i].id && h.result === "pending"),
    "初始：GET progress 七步全 pending、current_step=kickoff（时间线全灰 + 当前步标记的数据源）",
  );
  ok((await httpGetGateLines("g2-proj-a")).length === 0, "初始：GET gate.jsonl 为空（无记录可看）");

  // ── 经 HTTP 写三条转移：kickoff pass、requirement pass、design reject ──
  await httpPostGate("g2-proj-a", { step: "kickoff", result: "pass", note: "立项确认" });
  await httpPostGate("g2-proj-a", { step: "requirement", result: "pass", note: "需求冻结" });
  const afterReject = await httpPostGate("g2-proj-a", {
    step: "design",
    result: "reject",
    note: "架构图方案复审中",
  });
  ok(
    afterReject.gate.current_step === "design",
    "reject 后 current_step 停留在 design（时间线当前步标记不前进）",
  );

  // ── 核心：两视图（progress.history ↔ gate.jsonl）数据口径一致 ──
  const progress = await httpGetProgress("g2-proj-a");
  const lines = await httpGetGateLines("g2-proj-a");
  ok(lines.length === 3, "gate.jsonl 共 3 行（两次 pass + 一次 reject，只追加）");
  ok(
    lines.map((l) => [l.step, l.result]).join("|") ===
      "kickoff,pass|requirement,pass|design,reject",
    "gate.jsonl 行序 == 转移发生顺序（流水即审计证据）",
  );

  let consistent = true;
  for (const h of progress.gate.history) {
    const stepLines = lines.filter((l) => l.step === h.step);
    if (h.result === "pending") {
      if (stepLines.length !== 0 || h.at !== null || h.note !== null) consistent = false;
    } else {
      const last = stepLines[stepLines.length - 1];
      if (!last || last.result !== h.result || last.ts !== h.at || last.note !== h.note) {
        consistent = false;
      }
    }
  }
  ok(consistent, "口径一致：history 每个非 pending 步 == gate.jsonl 该步最后一行；pending 步无 jsonl 记录");
  ok(
    progress.gate.history.filter((h) => h.result === "pass").length === 2 &&
      progress.gate.history.filter((h) => h.result === "reject").length === 1 &&
      progress.gate.history.filter((h) => h.result === "pending").length === 4,
    "三态计数：2 绿（pass）+ 1 红（reject）+ 4 灰（pending），与 jsonl 记录逐节点对得上",
  );

  // ── DoD③ 记录字段：每个非 pending 步带时间戳与 note（点开展示的就是它们）──
  const kickoff = progress.gate.history[0];
  ok(
    typeof kickoff.at === "string" && kickoff.note === "立项确认",
    "DoD③ kickoff 记录带时间戳 + note（立项确认）",
  );
  const design = progress.gate.history.find((h) => h.step === "design")!;
  const designLine = lines.find((l) => l.step === "design")!;
  ok(
    design.result === "reject" &&
      design.at === designLine.ts &&
      design.note === "架构图方案复审中" &&
      designLine.by === "user",
    "DoD③ design 打回记录：history.at == jsonl.ts、note 一致、by=user",
  );

  // ── 同一步重复转移：history 保留最新，jsonl 两条都在（展示层口径 = jsonl 该步最后一行）──
  await httpPostGate("g2-proj-a", { step: "design", result: "pass", note: "复审通过" });
  const p2 = await httpGetProgress("g2-proj-a");
  const l2 = await httpGetGateLines("g2-proj-a");
  const designLines = l2.filter((l) => l.step === "design");
  const designNow = p2.gate.history.find((h) => h.step === "design")!;
  ok(
    designLines.length === 2 &&
      designNow.result === "pass" &&
      designNow.note === "复审通过" &&
      designNow.at === designLines[1].ts &&
      p2.gate.current_step === "tasks",
    "同一步先 reject 后 pass：jsonl 两条都在（红→绿留痕），history 为最新 pass，current_step 推进到 tasks",
  );

  // ── DoD④ 换项目：g2-proj-b 的时间线数据独立（全 pending），不受 g2-proj-a 影响 ──
  const pb = await httpGetProgress("g2-proj-b");
  const lb = await httpGetGateLines("g2-proj-b");
  ok(
    pb.gate.current_step === "kickoff" &&
      pb.gate.history.every((h) => h.result === "pending") &&
      lb.length === 0,
    "DoD④ 换项目：g2-proj-b 时间线全 pending、jsonl 为空（与 g2-proj-a 的 2绿1红 互不串）",
  );
  const pa2 = await httpGetProgress("g2-proj-a");
  ok(
    pa2.gate.history.filter((h) => h.result !== "pending").length === 3,
    "DoD④ 切回 g2-proj-a：三条记录仍在（切项目不丢数据）",
  );
} finally {
  child.kill();
  fs.rmSync(tmpBase, { recursive: true, force: true });
}

console.log(process.exitCode ? "[verify] 存在 FAIL" : "[verify] 全部 PASS");
