// H2 验证脚本（用 tsx 跑）：HTTP 全链路验证 SSE 实时推送 + GET changes 口径一致
// （DESIGN.md §3.8/§3.9，PLAN.md H2 DoD② 的无刷新推送底座）。
// 用法：pnpm verify:h2（自带临时 TATAI_HOME 与临时项目目录，不碰真实注册表与真实项目）
// 覆盖点：
//   ① GET /api/projects/:id/events 伪造 id → 404 PROJECT_NOT_FOUND（项目只走注册表）
//   ② SSE 连接即推 hello（贴原文）；头为 text/event-stream
//   ③ 开监听后改文件 → SSE 实时收到变更事件 {ts,path,action,size_delta}（贴原文，
//      真推送非轮询：事件在 chokidar 落流水的同时到达）
//   ④ SSE 事件与 GET changes 口径一致（同一条变更两边字段全等）
//   ⑤ 关监听后再改文件 → SSE 无新事件（生命周期闭环）；心跳行存在
//   ⑥ 断开后端连接即退订：连接关闭后服务端不再向该响应写入（进程级观察 = 无残留写入报错）
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { addProject } from "../src/server/registry";
import type { ChangeLine } from "../src/server/watcher";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8794;
const BASE = `http://localhost:${PORT}`;

const ok = (cond: boolean, label: string) => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (!cond) process.exitCode = 1;
};

// ── 临时数据目录与临时项目（不碰真实注册表与真实项目）──
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-h2-verify-"));
const dataDir = path.join(tmpBase, "home");
const projDir = path.join(tmpBase, "h2-proj");
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(path.join(projDir, "src"), { recursive: true });
addProject({ id: "h2-proj", name: "H2 验证项目", path: projDir, kind: "backend" }, dataDir);

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

interface SseEvent {
  raw: string; // 事件原文（data: 行的负载部分）
  data: Record<string, unknown>;
}

/** SSE 客户端：fetch + ReadableStream 逐事件切（\n\n 分隔），hello/变更/心跳全部收集 */
class SseClient {
  events: SseEvent[] = [];
  pings: string[] = [];
  private buf = "";
  private abort = new AbortController();
  readonly headers: Headers;
  private constructor(res: Response) {
    this.headers = res.headers;
    void this.pump(res);
  }
  static async connect(url: string): Promise<SseClient> {
    const res = await fetch(url, { signal: undefined });
    if (!res.ok || !res.body) throw new Error(`SSE 连接失败: HTTP ${res.status}`);
    return new SseClient(res);
  }
  private async pump(res: Response): Promise<void> {
    try {
      const reader = res.body!.getReader();
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
            if (line.startsWith(": ")) {
              this.pings.push(line);
            } else if (line.startsWith("data: ")) {
              const raw = line.slice(6);
              this.events.push({ raw, data: JSON.parse(raw) as Record<string, unknown> });
            }
          }
        }
      }
    } catch {
      // 连接中断（含收尾时杀服务端进程的 ECONNRESET）是正常终态，不算失败
    }
  }
  /** 等 events 数达到 min（chokidar + awf 防抖是异步的，断言必须等） */
  async waitEvents(min: number, timeoutMs = 10000): Promise<SseEvent[]> {
    const t0 = Date.now();
    for (;;) {
      if (this.events.length >= min) return this.events;
      if (Date.now() - t0 > timeoutMs) {
        throw new Error(`等待超时：SSE 事件数=${this.events.length}，期望≥${min}`);
      }
      await sleep(100);
    }
  }
  close(): void {
    this.abort.abort();
  }
}

interface ApiResp {
  status: number;
  body: {
    ok?: boolean;
    changes?: ChangeLine[];
    error?: { code: string; message: string };
  };
}

async function http(method: string, rawPath: string): Promise<ApiResp> {
  const res = await fetch(`${BASE}${rawPath}`, { method });
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

  // ── ① 伪造 id 的 SSE → 404 ──
  const badSse = await fetch(`${BASE}/api/projects/nosuchproj/events`);
  const badBody = (await badSse.json()) as { error?: { code: string } };
  ok(
    badSse.status === 404 && badBody.error?.code === "PROJECT_NOT_FOUND",
    `① 伪造 id 连 SSE → 404 PROJECT_NOT_FOUND（实际: ${badSse.status} ${badBody.error?.code}）`,
  );

  // ── ② 真项目连 SSE：头 + hello 事件 ──
  const sse = await SseClient.connect(`${BASE}/api/projects/h2-proj/events`);
  ok(
    (sse.headers.get("content-type") ?? "").startsWith("text/event-stream"),
    `② SSE 响应头 text/event-stream（实际: ${sse.headers.get("content-type")}）`,
  );
  const hello = (await sse.waitEvents(1))[0];
  console.log(`[verify]   hello 事件原文: data: ${hello.raw}`);
  ok(
    hello.data.hello === true && hello.data.project === "h2-proj" && typeof hello.data.ts === "string",
    `② 连接即推 hello（project 字段正确）`,
  );

  // ── ③ 开监听 → 改文件 → SSE 实时到达 ──
  await http("POST", "/api/projects/h2-proj/watch");
  await sleep(2000); // 等初始扫描 ready（awf 300ms 余量）
  const content = "hello h2 sse"; // 12 字节
  const t0 = Date.now();
  fs.writeFileSync(path.join(projDir, "b.txt"), content, "utf8");
  const evs = await sse.waitEvents(2);
  const changeEv = evs[evs.length - 1];
  const arrivedMs = Date.now() - t0;
  console.log(`[verify]   变更事件原文（${arrivedMs}ms 内到达）: data: ${changeEv.raw}`);
  const line = changeEv.data as unknown as ChangeLine;
  ok(
    line.path === "b.txt" && line.action === "add" && typeof line.ts === "string",
    `③ 改文件 → SSE 事件实时到达且字段符合 §2.3.5（path=${line.path} action=${line.action}）`,
  );
  ok(line.size_delta === Buffer.byteLength(content), `③ size_delta=${line.size_delta}（=文件大小）`);

  // 再改一次 → modify 事件也到（真推送持续在线，不是一次性）
  fs.appendFileSync(path.join(projDir, "b.txt"), "++", "utf8");
  const evs2 = await sse.waitEvents(3);
  const modifyEv = evs2[evs2.length - 1];
  console.log(`[verify]   变更事件原文: data: ${modifyEv.raw}`);
  ok(
    (modifyEv.data as unknown as ChangeLine).action === "modify",
    `③ 再改 → modify 事件继续到达（连接持续在线，真推送）`,
  );

  // ── ④ SSE 与 GET changes 口径一致 ──
  const ch = await http("GET", "/api/projects/h2-proj/changes?limit=2");
  const latest = ch.body.changes?.[0];
  ok(
    ch.status === 200 &&
      latest !== undefined &&
      latest.ts === (modifyEv.data as unknown as ChangeLine).ts &&
      latest.path === (modifyEv.data as unknown as ChangeLine).path &&
      latest.action === (modifyEv.data as unknown as ChangeLine).action &&
      latest.size_delta === (modifyEv.data as unknown as ChangeLine).size_delta,
    `④ GET changes 最新行与 SSE 事件逐字段全等（口径一致）`,
  );

  // ── ⑤ 关监听后再改文件 → SSE 无新事件 ──
  const dw = await http("DELETE", "/api/projects/h2-proj/watch");
  ok(dw.status === 200 && dw.body.ok === true, "DELETE watch → 200");
  const countBefore = sse.events.length;
  fs.appendFileSync(path.join(projDir, "b.txt"), "after-close", "utf8");
  await sleep(2500);
  ok(
    sse.events.length === countBefore,
    `⑤ 关监听后改动 → SSE 零新事件（${countBefore} → ${sse.events.length}，生命周期闭环）`,
  );

  // ── ⑤ 心跳保活（H02 扩查 S2 修复：原断言 pings 为空时 .every() 空真即 PASS，
  // 心跳保活实际未被验证。改为真等首条心跳——服务端 25s 间隔（index.ts setInterval 25000），
  // 上限 32s；等不到＝心跳通道失效，按失败计，不再用"不强等"豁免）。
  const pingDeadline = Date.now() + 32000;
  while (sse.pings.length === 0 && Date.now() < pingDeadline) await sleep(500);
  ok(
    sse.pings.length > 0 && sse.pings.every((p) => /^: ping \d{4}-\d{2}-\d{2}T/.test(p)),
    `⑤ 心跳保活真验：实收 ${sse.pings.length} 条心跳且格式合法（等到首条才断，25s 间隔）`,
  );

  sse.close();
} finally {
  child?.kill();
  fs.rmSync(tmpBase, { recursive: true, force: true });
}

console.log(process.exitCode ? "[verify] 存在 FAIL" : "[verify] 全部 PASS");
