// T1 验证脚本（用 tsx 跑）：后端 PTY 通道全链路验证（PLAN.md T1 DoD ①-④）。
// 用法：pnpm verify:t1（自带临时 TATAI_HOME 与临时项目目录，不碰真实注册表与真实项目）
// 覆盖点：
//   ① 建会话 → 写 `cd`（cmd 打印当前目录）→ SSE 输出含项目根路径（DoD①，贴输出）
//   ② 连续 echo A / echo B 按序到达且会话不死（DoD② 流式持续交互）
//   ③ 长输出（dir）分块到达（≥2 个 data 事件，流式证据，非一次性吐完）
//   ④ resize 调用 200 且会话尺寸更新（node-pty ConPTY 真 resize）
//   ⑤ DELETE 关闭 → 退出码回收 + PID 在 tasklist 查不到（DoD④ 无僵尸）
//   ⑥ 异常路径：伪造项目 id 建会话 → 404；对不存在 sid 写入 → 404 SESSION_NOT_FOUND
// 说明：本机无 wmic（Windows 11 已弃用），僵尸检查用 tasklist /FI "PID eq N"（等效）。
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { addProject } from "../src/server/registry";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8795;
const BASE = `http://localhost:${PORT}`;

const ok = (cond: boolean, label: string) => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (!cond) process.exitCode = 1;
};

// ── 临时数据目录与临时项目（不碰真实注册表与真实项目）──
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-t1-verify-"));
const dataDir = path.join(tmpBase, "home");
const projDir = path.join(tmpBase, "t1-proj");
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(path.join(projDir, "src"), { recursive: true });
for (let i = 1; i <= 20; i++) {
  fs.writeFileSync(path.join(projDir, `file-${String(i).padStart(2, "0")}.txt`), `x${i}\n`, "utf8");
}
addProject({ id: "t1-proj", name: "T1 验证项目", path: projDir, kind: "backend" }, dataDir);

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

/** 终端 SSE 客户端：收集 data 事件的 payload 文本与退出事件 */
class TerminalSse {
  /** 累计输出文本（所有 data 事件拼接，cmd 回显也在内） */
  text = "";
  chunks = 0;
  exitCode: number | null = null;
  private buf = "";
  private constructor() {
    void this.pump();
  }
  static async connect(sid: string): Promise<TerminalSse> {
    const c = new TerminalSse();
    const res = await fetch(`${BASE}/api/terminal/${encodeURIComponent(sid)}/out`);
    if (!res.ok || !res.body) throw new Error(`SSE 连接失败: HTTP ${res.status}`);
    c.res = res;
    return c;
  }
  private res: Response | undefined;
  private async pump(): Promise<void> {
    // 等 connect 把 res 挂上
    for (let i = 0; i < 100 && !this.res; i++) await sleep(20);
    try {
      const reader = this.res!.body!.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        this.buf += dec.decode(value, { stream: true });
        let sep: number;
        while ((sep = this.buf.indexOf("\n\n")) !== -1) {
          const block = this.buf.slice(0, sep);
          this.buf = this.buf.slice(sep + 2);
          for (const line of block.split("\n")) {
            if (!line.startsWith("data: ")) continue;
            const ev = JSON.parse(line.slice(6)) as {
              data?: string;
              exit?: { exitCode: number };
            };
            if (typeof ev.data === "string") {
              this.text += ev.data;
              this.chunks++;
            }
            if (ev.exit) this.exitCode = ev.exit.exitCode;
          }
        }
      }
    } catch {
      // 连接中断（含收尾杀服务端）是正常终态
    }
  }
  /** 等累计输出满足断言（PTY 输出是异步流，必须等） */
  async waitFor(pred: (text: string) => boolean, timeoutMs = 15000): Promise<string> {
    const t0 = Date.now();
    for (;;) {
      if (pred(this.text)) return this.text;
      if (Date.now() - t0 > timeoutMs) {
        throw new Error(`等待超时：输出未满足断言。当前累计输出:\n${JSON.stringify(this.text)}`);
      }
      await sleep(100);
    }
  }
}

interface ApiResp {
  status: number;
  body: {
    ok?: boolean;
    session?: { id: string; pid: number; cwd: string; cols: number; rows: number };
    removed?: boolean;
    exit?: { exitCode: number } | null;
    error?: { code: string; message: string };
  };
}

async function api(method: string, rawPath: string, body?: unknown): Promise<ApiResp> {
  const res = await fetch(`${BASE}${rawPath}`, {
    method,
    ...(body !== undefined
      ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
      : {}),
  });
  return { status: res.status, body: (await res.json()) as ApiResp["body"] };
}

/** tasklist 查 PID 是否还活着（僵尸检查；本机无 wmic，等效手段） */
function pidAlive(pid: number): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn("tasklist", ["/FI", `PID eq ${pid}`, "/NH"]);
    let out = "";
    p.stdout.on("data", (d: Buffer) => (out += d.toString()));
    p.on("close", () => resolve(out.includes(String(pid))));
    p.on("error", () => resolve(false));
  });
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

  // ── ⑥a 伪造项目 id 建会话 → 404 ──
  const bad = await api("POST", "/api/projects/nosuchproj/terminal", {});
  ok(
    bad.status === 404 && bad.body.error?.code === "PROJECT_NOT_FOUND",
    `⑥ 伪造项目 id 建会话 → 404 PROJECT_NOT_FOUND（实际: ${bad.status} ${bad.body.error?.code}）`,
  );

  // ── 建会话 ──
  const created = await api("POST", "/api/projects/t1-proj/terminal", { cols: 100, rows: 30 });
  const session = created.body.session!;
  ok(
    created.status === 200 && typeof session.id === "string" && session.pid > 0,
    `建会话 → 200，sid=${session.id}，pid=${session.pid}`,
  );
  ok(
    path.resolve(session.cwd) === path.resolve(projDir),
    `会话 cwd 锁在项目根（DoD③，实际: ${session.cwd}，不落全局）`,
  );

  const sse = await TerminalSse.connect(session.id);
  const write = (data: string) => api("POST", `/api/terminal/${session.id}/in`, { data });

  // ── ① cd（cmd 打印当前目录）→ 输出含项目根路径 ──
  await write("cd\r");
  const cdOut = await sse.waitFor((t) => t.toLowerCase().includes(projDir.toLowerCase()));
  console.log(`[verify]   cd 输出摘录: ${JSON.stringify(cdOut.slice(-120))}`);
  ok(true, `① cd 输出含项目根路径 ${projDir}（DoD①，原文见上）`);

  // ── ② 连续两条命令按序到达且会话不死 ──
  await write("echo AAA111\r");
  await sse.waitFor((t) => t.includes("AAA111"));
  await write("echo BBB222\r");
  const both = await sse.waitFor((t) => t.includes("BBB222"));
  ok(
    both.indexOf("AAA111") < both.indexOf("BBB222"),
    `② echo A → echo B 按序到达，会话持续可交互（DoD②）`,
  );

  // ── ③ dir 长输出分块到达（流式证据）──
  const chunksBefore = sse.chunks;
  await write("dir /b\r");
  await sse.waitFor((t) => t.includes("file-20.txt"));
  const dirChunks = sse.chunks - chunksBefore;
  ok(dirChunks >= 2, `③ dir 输出分 ${dirChunks} 个 data 事件到达（≥2，流式非一次性）`);

  // ── ④ resize ──
  const rs = await api("POST", `/api/terminal/${session.id}/resize`, { cols: 132, rows: 43 });
  ok(
    rs.status === 200 && rs.body.session?.cols === 132 && rs.body.session?.rows === 43,
    `④ resize → 200 且尺寸更新为 132x43（node-pty ConPTY 真 resize）`,
  );

  // ── ⑥b 对不存在 sid 写入 → 404 ──
  const noSid = await api("POST", "/api/terminal/t-nosuch/in", { data: "x\r" });
  ok(
    noSid.status === 404 && noSid.body.error?.code === "SESSION_NOT_FOUND",
    `⑥ 不存在 sid 写入 → 404 SESSION_NOT_FOUND（实际: ${noSid.status} ${noSid.body.error?.code}）`,
  );

  // ── ⑤ 关闭会话 → 退出码回收 + PID 查不到（无僵尸）──
  const pid = session.pid;
  ok(await pidAlive(pid), `⑤ 关闭前 pid=${pid} 存活（tasklist 可查，前置条件成立）`);
  const del = await api("DELETE", `/api/terminal/${session.id}`);
  ok(
    del.status === 200 && del.body.removed === true && typeof del.body.exit?.exitCode === "number",
    `⑤ DELETE → removed=true，退出码=${del.body.exit?.exitCode}（exit 事件捕获，资源回收）`,
  );
  await sleep(1000);
  const still = await pidAlive(pid);
  console.log(
    `[verify]   tasklist /FI "PID eq ${pid}" 关闭后查询结果: ${still ? "仍存在（FAIL）" : "查不到（无僵尸）"}`,
  );
  ok(!still, `⑤ 关闭后 pid=${pid} 在 tasklist 查不到（DoD④ 无僵尸进程）`);

  // 幂等：再删一次 → removed:false 不报错
  const del2 = await api("DELETE", `/api/terminal/${session.id}`);
  ok(del2.status === 200 && del2.body.removed === false, `⑤ 重复 DELETE → removed:false（幂等）`);
} finally {
  child?.kill();
  fs.rmSync(tmpBase, { recursive: true, force: true });
}

console.log(process.exitCode ? "[verify] 存在 FAIL" : "[verify] 全部 PASS");
