// C1 验证脚本（用 tsx 跑）：真调 DeepSeek API（OpenAI 兼容协议，密钥来自本机
// DEEPSEEK_API_KEY 环境变量）验证 Flash 流式客户端 + HTTP 管道（PLAN.md C1 DoD）。
// 覆盖点：
//   ① 真调一次流式：逐 chunk 打印递增证据（chunk 序号 + 累积字数 + 到达毫秒）
//   ② chat() 非流式封装真调一次（收集全文）
//   ③ 错误路径：假 key 真调一次 → 捕获可读 401 错误，且错误文本不含密钥原文；
//      超时路径：timeoutMs 调极小 → 捕获可读超时错误
//   ④ 密钥自查：git status --porcelain 原样打印 + grep 密钥前缀 src/ scripts/ 零命中
//   ⑤ HTTP 层：起真实后端子进程，POST /api/flash/chat 逐行读 SSE（带到达毫秒），
//      以及"未配密钥"子进程 → SSE error 事件可读、空 messages → 400
// ████ 红线 ████ 本脚本绝不打印密钥原文（只打印是否存在/长度）；假 key 用不含真实
// 密钥前缀模式的占位串（前缀模式在脚本里动态拼接，避免脚本自身被 grep 命中）。
import { execSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chat, chatStream, resolveApiKey } from "../src/server/flash";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8795;
const PORT_NOKEY = 8797;
const BASE = `http://localhost:${PORT}`;
const BASE_NOKEY = `http://localhost:${PORT_NOKEY}`;

const ok = (cond: boolean, label: string) => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (!cond) process.exitCode = 1;
};

// ── 前置：密钥已配置（只报存在与长度，绝不打印原文）──
const REAL_KEY = process.env.DEEPSEEK_API_KEY?.trim() ?? "";
if (!REAL_KEY) {
  console.log("[verify] FAIL 前置：DEEPSEEK_API_KEY 环境变量未配置，无法真调");
  process.exit(1);
}
console.log(`[verify] 前置：DEEPSEEK_API_KEY 已配置（长度 ${REAL_KEY.length}，原文不打印）`);
ok(resolveApiKey() === REAL_KEY, "密钥读取：resolveApiKey() 命中环境变量（与 env 一致）");

// 临时数据目录（不碰真实 TATAI_HOME）
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-c1-verify-"));
const dataDir = path.join(tmpBase, "home");
fs.mkdirSync(dataDir, { recursive: true });

async function spawnServer(port: number, withKey: boolean): Promise<ChildProcess> {
  await assertPortFree(port); // 端口已被占：立刻失败，不拿占用者的服务跑验证
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TATAI_HOME: dataDir,
    TATAI_PORT: String(port),
  };
  if (!withKey) delete env.DEEPSEEK_API_KEY; // 无密钥子进程：验证可读错误，且 config.json 也不存在
  const child = spawn(
    process.execPath,
    ["--import", "tsx", path.join("src", "server", "index.ts")],
    { env, stdio: ["ignore", "pipe", "pipe"], cwd: REPO_ROOT },
  );
  child.stderr.on("data", (d: Buffer) => process.stderr.write(`[server:${port}] ${d}`));
  watchChild(child, port, () => upPorts.has(port)); // 子进程早退（EADDRINUSE）立刻报错退出
  return child;
}

async function waitUp(base: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${base}/health`);
      if (r.ok) {
        upPorts.add(Number(new URL(base).port));
        return;
      }
    } catch {
      // 还没起来，继续等
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`后端 ${base} 10 秒内未就绪`);
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

let child: ChildProcess | undefined;
let childNoKey: ChildProcess | undefined;
try {
  // ── ① 流式真调：逐 chunk 打印递增证据 ──
  console.log("[verify] ── ① chatStream 真调：「用三句话介绍 tree-sitter」──");
  const t0 = Date.now();
  let acc = "";
  let n = 0;
  for await (const delta of chatStream(
    [{ role: "user", content: "用三句话介绍 tree-sitter" }],
    { model: "deepseek-chat" }, // model 可配置项显式传一次
  )) {
    n += 1;
    acc += delta;
    console.log(
      `[verify]   chunk #${n}（+${delta.length} 字，累计 ${acc.length} 字，${Date.now() - t0}ms）: ${JSON.stringify(delta.length > 40 ? delta.slice(0, 40) + "…" : delta)}`,
    );
  }
  ok(n >= 3, `流式：收到 ${n} 个 chunk（>=3，逐 chunk 递增证据见上）`);
  ok(acc.length > 50, `流式：全文累计 ${acc.length} 字（非空长文）`);
  console.log(`[verify]   流式全文：${acc}`);

  // ── ② chat() 非流式封装真调 ──
  console.log("[verify] ── ② chat() 非流式封装真调 ──");
  const full = await chat([{ role: "user", content: "只回答一个数字：1+1 等于几？" }]);
  console.log(`[verify]   chat() 返回（${full.length} 字）: ${JSON.stringify(full)}`);
  ok(typeof full === "string" && full.length > 0 && full.includes("2"), "chat()：一次收齐全文，内容含答案");

  // ── ③ 错误路径：假 key → 可读 401，错误文本不含密钥原文 ──
  console.log("[verify] ── ③ 错误路径 ──");
  const FAKE_KEY = "c1-verify-fake-key-0000"; // 占位假 key：故意不含真实密钥前缀模式
  try {
    await chat([{ role: "user", content: "hi" }], { apiKey: FAKE_KEY });
    ok(false, "错误路径：假 key 调用被捕获（实际: 未抛错）");
  } catch (e) {
    const msg = (e as Error).message;
    console.log(`[verify]   捕获错误原文: ${msg}`);
    ok(/HTTP 401/.test(msg), "错误路径：假 key → 可读 HTTP 401 错误");
    ok(
      !msg.includes(FAKE_KEY) && !msg.includes(REAL_KEY),
      "错误路径：401 错误文本不含密钥原文（真假 key 均不出现）",
    );
  }
  // 超时路径：timeoutMs 调到 1ms，必触发超时（真调，网络往返远大于 1ms）
  try {
    await chat([{ role: "user", content: "hi" }], { timeoutMs: 1 });
    ok(false, "错误路径：1ms 超时被捕获（实际: 未抛错）");
  } catch (e) {
    const msg = (e as Error).message;
    console.log(`[verify]   捕获错误原文: ${msg}`);
    ok(msg.includes("超时"), "错误路径：timeoutMs=1 → 可读超时错误，不吞异常");
    ok(!msg.includes(REAL_KEY), "错误路径：超时错误文本不含密钥原文");
  }

  // ── ④ 密钥自查：git status + grep 密钥前缀零命中 ──
  console.log("[verify] ── ④ 密钥自查 ──");
  const gitStatus = execSync("git status --porcelain", { cwd: REPO_ROOT }).toString();
  console.log("[verify]   git status --porcelain 输出：");
  for (const line of gitStatus.trimEnd().split("\n")) console.log(`[verify]     ${line}`);
  ok(
    !gitStatus.split("\n").some((l) => {
      const file = l.slice(3); // 去掉两位状态码 + 空格
      return file.includes(".工作台/") || file === "config.json" || file.endsWith("/config.json");
    }),
    "密钥自查：git status 无 .工作台/ 与 config.json 条目（tsconfig.json 等不算）",
  );
  // 密钥形态 = 前缀 + 16 位以上连续字母数字（真实 DeepSeek key 为 sk- + 32 位十六进制）。
  // 只 grep 裸前缀会误伤 data-task-count 之类普通子串（一期审计 2026-09-18 实际踩过）。
  const keyPattern = "s" + "k-" + "[A-Za-z0-9]{16,}"; // 动态拼接：避免本脚本自身被 grep 命中
  let grepHits = "";
  try {
    grepHits = execSync(`grep -riE "${keyPattern}" src/ scripts/`, { cwd: REPO_ROOT }).toString();
  } catch (e) {
    if ((e as { status?: number }).status !== 1) throw e; // 1 = 零命中
  }
  ok(grepHits.trim() === "", "密钥自查：grep -riE 密钥形态（前缀+16 位串）src/ scripts/ 零命中");

  // ── ⑤ HTTP 层：起真实后端，POST /api/flash/chat 逐行读 SSE ──
  console.log("[verify] ── ⑤ HTTP 层流式 ──");
  child = await spawnServer(PORT, true);
  await waitUp(BASE);
  console.log(`[verify] server up at ${BASE}（TATAI_HOME=${dataDir}）`);

  // 空 messages → 400 INVALID_INPUT
  const badRes = await fetch(`${BASE}/api/flash/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages: [] }),
  });
  const badBody = (await badRes.json()) as { error?: { code?: string } };
  ok(
    badRes.status === 400 && badBody.error?.code === "INVALID_INPUT",
    "HTTP：空 messages → 400 INVALID_INPUT",
  );

  // 真调 SSE：逐行读，带到达毫秒（真流式证据）
  const ht0 = Date.now();
  const sseRes = await fetch(`${BASE}/api/flash/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      messages: [{ role: "user", content: "用一句话介绍什么是 SSE" }],
    }),
  });
  ok(
    sseRes.status === 200 &&
      (sseRes.headers.get("content-type") ?? "").includes("text/event-stream"),
    "HTTP：POST /api/flash/chat → 200 + content-type text/event-stream",
  );
  const reader = sseRes.body!.getReader();
  const decoder = new TextDecoder();
  let sseBuf = "";
  let deltaLines = 0;
  let doneSeen = false;
  let httpAcc = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    sseBuf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = sseBuf.indexOf("\n")) !== -1) {
      const line = sseBuf.slice(0, nl).trim();
      sseBuf = sseBuf.slice(nl + 1);
      if (!line) continue;
      console.log(`[verify]   SSE 行（${Date.now() - ht0}ms）: ${line.length > 90 ? line.slice(0, 90) + "…" : line}`);
      if (line === "data: [DONE]") doneSeen = true;
      else if (line.startsWith("data: ")) {
        const payload = JSON.parse(line.slice(6)) as { delta?: string; error?: string };
        if (typeof payload.delta === "string") {
          deltaLines += 1;
          httpAcc += payload.delta;
        }
        ok(payload.error === undefined, `HTTP：SSE 流中无 error 事件（实际: ${payload.error ?? "无"}）`);
      }
    }
  }
  ok(deltaLines >= 2, `HTTP：SSE 逐行流出 ${deltaLines} 个 delta 事件（真流式，到达毫秒见上）`);
  ok(doneSeen, "HTTP：SSE 以 data: [DONE] 正常收尾");
  ok(httpAcc.length > 10, `HTTP：SSE 全文累计 ${httpAcc.length} 字`);
  console.log(`[verify]   SSE 全文：${httpAcc}`);

  // 无密钥子进程 → SSE error 事件可读（密钥缺失不吞异常、不泄密钥）
  childNoKey = await spawnServer(PORT_NOKEY, false);
  await waitUp(BASE_NOKEY);
  const noKeyRes = await fetch(`${BASE_NOKEY}/api/flash/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
  });
  const noKeyText = await noKeyRes.text();
  console.log(`[verify]   无密钥 SSE 响应原文: ${noKeyText.trim()}`);
  ok(
    noKeyText.includes("未配置 DeepSeek 密钥") && !noKeyText.includes(REAL_KEY),
    "HTTP：未配密钥 → SSE error 事件可读（提示配置方法，不含密钥材料）",
  );
} finally {
  child?.kill();
  childNoKey?.kill();
  fs.rmSync(tmpBase, { recursive: true, force: true });
}

console.log(process.exitCode ? "[verify] 存在 FAIL" : "[verify] 全部 PASS");
