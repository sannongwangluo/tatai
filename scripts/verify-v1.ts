// V1 验证脚本（用 tsx 跑）：实况聚合层 HTTP 全链路验证（PLAN.md V1 DoD①/④/⑤）。
// 用法：pnpm verify:v1（自带临时 TATAI_HOME 与临时项目目录，不碰真实注册表与真实项目）
// 覆盖点：
//   ① 制造一个 doing 任务 → GET /live 返回当前阶段/干活 agent/当前卡/最近动作带时间戳
//   ④ 状态区数据：任务四态计数 + Gate 当前步与三态
//   ②（HTTP 侧）开监听后改文件 → GET /live 动作流出现该变更（UI 无刷新上屏见 .工作台/verify/v1_ui_verify.py）
//   ⑤ 只读自查：/live 调用前后对项目 .工作台 目录做文件哈希快照比对，零变化
//   附：伪造 id → 404 PROJECT_NOT_FOUND；三源合并按 ts 倒序
import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { addProject } from "../src/server/registry";
import type { LiveSnapshot } from "../src/server/live";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8798;
const BASE = `http://localhost:${PORT}`;

const ok = (cond: boolean, label: string) => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (!cond) process.exitCode = 1;
};

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-v1-verify-"));
const dataDir = path.join(tmpBase, "home");
const projDir = path.join(tmpBase, "v1-proj");
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(path.join(projDir, "src"), { recursive: true });
addProject({ id: "v1-proj", name: "V1 验证项目", path: projDir, kind: "backend" }, dataDir);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
    await sleep(200);
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

async function api(method: string, rawPath: string, body?: unknown) {
  const res = await fetch(`${BASE}${rawPath}`, {
    method,
    ...(body !== undefined
      ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
      : {}),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** .工作台 目录全量文件哈希快照（只读自查用：相对路径 → sha256） */
function snapshotWorkbench(): Map<string, string> {
  const dir = path.join(projDir, ".工作台");
  const out = new Map<string, string>();
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        const rel = path.relative(dir, p).split(path.sep).join("/");
        out.set(rel, crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex"));
      }
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

let child: ChildProcess | undefined;
try {
  await assertPortFree(PORT); // 端口已被占：立刻失败，不拿占用者的服务跑验证
  const proc = spawn(
    process.execPath,
    ["--import", "tsx", path.join("src", "server", "index.ts")],
    {
      env: { ...process.env, TATAI_HOME: dataDir, TATAI_PORT: String(PORT) },
      stdio: ["ignore", "pipe", "pipe"],
      cwd: REPO_ROOT,
    },
  );
  child = proc;
  proc.stderr?.on("data", (d: Buffer) => process.stderr.write(`[server] ${d}`));
  watchChild(proc, PORT, () => upPorts.has(PORT)); // 子进程早退（EADDRINUSE）立刻报错退出
  await waitUp();
  console.log(`[verify] server up at ${BASE}（TATAI_HOME=${dataDir}）`);

  // ── 伪造 id → 404 ──
  const bad = await api("GET", "/api/projects/nosuchproj/live");
  const badErr = bad.body.error as { code?: string } | undefined;
  ok(
    bad.status === 404 && badErr?.code === "PROJECT_NOT_FOUND",
    `伪造 id 调 /live → 404 PROJECT_NOT_FOUND（实际: ${bad.status} ${badErr?.code}）`,
  );

  // ── 造数据：模块 + 三个任务（done/doing/todo），doing 任务 reporter=Kimi Code ──
  await api("POST", "/api/projects/v1-proj/modules", { id: "m1", name: "实况模块" });
  await api("POST", "/api/projects/v1-proj/tasks", {
    id: "V1-a", title: "已完成卡", module_id: "m1", reporter: "Codex", status: "done",
  });
  await api("POST", "/api/projects/v1-proj/tasks", {
    id: "V1-b", title: "进行中卡", module_id: "m1", reporter: "Kimi Code", status: "doing",
  });
  await api("POST", "/api/projects/v1-proj/tasks", {
    id: "V1-c", title: "待办卡", module_id: "m1", reporter: "Kimi Code",
  });
  // Gate 过「立项」→ current_step 推进到 requirement
  const gate = await api("POST", "/api/projects/v1-proj/gate", { step: "kickoff", result: "pass" });
  ok(gate.status === 200, `Gate 立项过关 → 200（实际: ${gate.status}）`);

  // ── 开监听改文件 → 变更进动作流 ──
  await api("POST", "/api/projects/v1-proj/watch");
  await sleep(2000); // 等初始扫描 ready
  fs.writeFileSync(path.join(projDir, "src", "v1-live-check.txt"), "live", "utf8");
  await sleep(1500); // awf 防抖 + 落流水

  // ── ⑤ 只读自查：快照 → 连调 /live 五次 → 再快照比对 ──
  const before = snapshotWorkbench();
  let live!: LiveSnapshot;
  for (let i = 0; i < 5; i++) {
    const r = await api("GET", "/api/projects/v1-proj/live");
    ok(r.status === 200 && r.body.ok === true, `GET /live 第 ${i + 1} 次 → 200`);
    live = r.body.live as LiveSnapshot;
  }
  const after = snapshotWorkbench();
  const sameKeys =
    before.size === after.size && [...before.keys()].every((k) => after.has(k));
  const sameHash = sameKeys && [...before.entries()].every(([k, v]) => after.get(k) === v);
  ok(
    sameHash,
    `⑤ 只读自查：/live 连调 5 次前后 .工作台 快照零变化（文件数 ${before.size} → ${after.size}）`,
  );
  if (!sameHash) {
    for (const k of new Set([...before.keys(), ...after.keys()])) {
      if (before.get(k) !== after.get(k)) {
        console.log(`[verify]   差异文件: ${k}`);
      }
    }
  }

  // ── ① 当前阶段 / 干活 agent / 当前卡 / 最近动作带时间戳 ──
  ok(live.stage.includes("需求"), `① 当前阶段含 Gate 步名（实际: ${live.stage}）`);
  ok(
    live.actor.kind === "agent" && live.actor.name === "Kimi Code",
    `① 干活 agent = doing 任务 reporter（实际: ${live.actor.kind}/${live.actor.name}）`,
  );
  ok(
    live.current_task !== null && live.current_task.id === "V1-b",
    `① 当前卡 = V1-b（实际: ${live.current_task?.id ?? "null"}）`,
  );
  ok(
    live.last_event_at !== null && live.events.length > 0 &&
      live.events.every((e) => typeof e.ts === "string" && typeof e.text === "string" &&
        (e.kind === "change" || e.kind === "gate" || e.kind === "task")),
    `① 动作流每条带 ts/kind/text（共 ${live.events.length} 条，last_event_at=${live.last_event_at}）`,
  );

  // ── ② HTTP 侧：文件变更进动作流 ──
  ok(
    live.events.some((e) => e.kind === "change" && e.text.includes("v1-live-check.txt")),
    `② 文件变更进动作流（changes 源合并）`,
  );
  ok(
    live.events.some((e) => e.kind === "gate" && e.text.includes("立项")),
    `② Gate 过关进动作流（gate 源合并）`,
  );
  ok(
    live.events.some((e) => e.kind === "task" && e.text.includes("V1-b")),
    `② 任务自报进动作流（tasks 源合并）`,
  );
  // ts 倒序（Date.parse 毫秒口径，H2 踩过的字符串比较坑）
  const ms = live.events.map((e) => Date.parse(e.ts));
  ok(
    ms.every((v, i) => i === 0 || ms[i - 1] >= v),
    `② 动作流按 ts 倒序（前 3 条: ${live.events.slice(0, 3).map((e) => e.kind).join(",")}）`,
  );

  // ── ④ 状态区数据：四态计数 + Gate 当前步三态 ──
  ok(
    live.task_counts.todo === 1 && live.task_counts.doing === 1 &&
      live.task_counts.done === 1 && live.task_counts.blocked === 0,
    `④ 任务四态计数 1/1/1/0（实际: ${JSON.stringify(live.task_counts)}）`,
  );
  ok(
    live.gate.current_step === "requirement" && live.gate.step_name === "需求" &&
      live.gate.result === "pending",
    `④ Gate 当前步 = 需求/pending（实际: ${live.gate.current_step}/${live.gate.step_name}/${live.gate.result}）`,
  );

  // ── doing 任务 done 掉 → 球回到用户这边 ──
  await api("POST", "/api/projects/v1-proj/tasks/V1-b/status", { status: "done" });
  const r2 = await api("GET", "/api/projects/v1-proj/live");
  const live2 = r2.body.live as LiveSnapshot;
  ok(
    live2.actor.kind === "user" && live2.current_task === null,
    `无 doing 任务 → 球在用户这边（实际: ${live2.actor.kind}）`,
  );
} finally {
  child?.kill();
  fs.rmSync(tmpBase, { recursive: true, force: true });
}

console.log(process.exitCode ? "[verify] 存在 FAIL" : "[verify] 全部 PASS");
