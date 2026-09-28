// T2 验证脚本（用 tsx 跑）：终端 Tab 的 HTTP 层冒烟 + 前端 bundle 断言（PLAN.md T2 DoD 支撑）。
// 用法：pnpm verify:t2（自带临时 TATAI_HOME 与临时项目目录，不碰真实注册表与真实项目）
// 覆盖点：
//   ① HTTP 冒烟：建会话 → in 写入 echo → SSE 输出回显（UI 层真敲真回显见 .工作台/verify/t2_ui_verify.py）
//   ② resize → 200 且尺寸更新
//   ③ DELETE 关闭 → PID 在 tasklist 查不到（无僵尸，UI 页签关闭路径同走 DELETE）
//   ④ 前端 bundle 含 xterm（dist/assets/*.js 命中 xterm 标记 + TerminalView 的"进程已退出"文案，
//      证明终端页签真的编进了产物；跑前需 pnpm build）
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { addProject } from "../src/server/registry";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8796;
const BASE = `http://localhost:${PORT}`;

const ok = (cond: boolean, label: string) => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (!cond) process.exitCode = 1;
};

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-t2-verify-"));
const dataDir = path.join(tmpBase, "home");
const projDir = path.join(tmpBase, "t2-proj");
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(projDir, { recursive: true });
addProject({ id: "t2-proj", name: "T2 验证项目", path: projDir, kind: "backend" }, dataDir);

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

function pidAlive(pid: number): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn("tasklist", ["/FI", `PID eq ${pid}`, "/NH"]);
    let out = "";
    p.stdout.on("data", (d: Buffer) => (out += d.toString()));
    p.on("close", () => resolve(out.includes(String(pid))));
    p.on("error", () => resolve(false));
  });
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

  // ── ① HTTP 冒烟：建会话 → 写 echo → SSE 回显 ──
  const created = await api("POST", "/api/projects/t2-proj/terminal", { cols: 100, rows: 30 });
  const session = created.body.session!;
  ok(
    created.status === 200 && typeof session.id === "string" && session.pid > 0,
    `① 建会话 → 200，sid=${session.id}，pid=${session.pid}`,
  );
  ok(
    path.resolve(session.cwd) === path.resolve(projDir),
    `① 会话 cwd 锁在项目根（实际: ${session.cwd}）`,
  );

  // SSE 收输出
  let text = "";
  const sseRes = await fetch(`${BASE}/api/terminal/${encodeURIComponent(session.id)}/out`);
  const reader = sseRes.body!.getReader();
  const dec = new TextDecoder();
  let sseBuf = "";
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        sseBuf += dec.decode(value, { stream: true });
        let sep: number;
        while ((sep = sseBuf.indexOf("\n\n")) !== -1) {
          const block = sseBuf.slice(0, sep);
          sseBuf = sseBuf.slice(sep + 2);
          for (const line of block.split("\n")) {
            if (!line.startsWith("data: ")) continue;
            const ev = JSON.parse(line.slice(6)) as { data?: string };
            if (typeof ev.data === "string") text += ev.data;
          }
        }
      }
    } catch {
      // 收尾杀服务端是正常终态
    }
  })();
  const waitText = async (needle: string): Promise<string> => {
    const t0 = Date.now();
    for (;;) {
      if (text.includes(needle)) return text;
      if (Date.now() - t0 > 15000) {
        throw new Error(`等待超时：输出未含 ${needle}。当前输出:\n${JSON.stringify(text)}`);
      }
      await sleep(100);
    }
  };

  await api("POST", `/api/terminal/${session.id}/in`, { data: "echo t2-http-smoke\r" });
  await waitText("t2-http-smoke");
  // 第一次出现是命令行回显，等输出里出现第二次（命令真实输出）
  const echoOut = await waitText("t2-http-smoke");
  ok(
    echoOut.indexOf("t2-http-smoke") !== echoOut.lastIndexOf("t2-http-smoke"),
    `① echo t2-http-smoke → 命令回显 + 真实输出双现（能看能敲的 HTTP 层证据，摘录: ${JSON.stringify(echoOut.slice(-80))}）`,
  );

  // ── ② resize ──
  const rs = await api("POST", `/api/terminal/${session.id}/resize`, { cols: 120, rows: 40 });
  ok(
    rs.status === 200 && rs.body.session?.cols === 120 && rs.body.session?.rows === 40,
    `② resize → 200 且尺寸更新为 120x40`,
  );

  // ── ③ DELETE 关闭 → 无僵尸 ──
  const pid = session.pid;
  ok(await pidAlive(pid), `③ 关闭前 pid=${pid} 存活（前置条件成立）`);
  const del = await api("DELETE", `/api/terminal/${session.id}`);
  ok(
    del.status === 200 && del.body.removed === true,
    `③ DELETE → removed=true，退出码=${del.body.exit?.exitCode}`,
  );
  await sleep(1000);
  const still = await pidAlive(pid);
  console.log(
    `[verify]   tasklist /FI "PID eq ${pid}" 关闭后: ${still ? "仍存在（FAIL）" : "查不到（无僵尸）"}`,
  );
  ok(!still, `③ 关闭后 pid=${pid} 在 tasklist 查不到（无僵尸进程）`);

  // ── ④ 前端 bundle 含 xterm ──
  const assetsDir = path.join(REPO_ROOT, "dist", "assets");
  ok(fs.existsSync(assetsDir), `④ dist/assets 存在（跑前需 pnpm build）`);
  if (fs.existsSync(assetsDir)) {
    const jsFiles = fs.readdirSync(assetsDir).filter((f) => f.endsWith(".js"));
    const allJs = jsFiles.map((f) => fs.readFileSync(path.join(assetsDir, f), "utf8")).join("\n");
    const cssFiles = fs.readdirSync(assetsDir).filter((f) => f.endsWith(".css"));
    const allCss = cssFiles.map((f) => fs.readFileSync(path.join(assetsDir, f), "utf8")).join("\n");
    ok(/xterm/.test(allJs) || /xterm/.test(allCss), `④ bundle 命中 xterm 标记（js/css 产物）`);
    ok(
      allJs.includes("进程已退出"),
      `④ bundle 含 TerminalView 的「进程已退出」文案（终端页签编进产物）`,
    );
    ok(
      allJs.includes("terminal") && jsFiles.length > 0,
      `④ bundle 含终端页签 key（js 文件数=${jsFiles.length}）`,
    );
  }
} finally {
  child?.kill();
  fs.rmSync(tmpBase, { recursive: true, force: true });
}

console.log(process.exitCode ? "[verify] 存在 FAIL" : "[verify] 全部 PASS");
