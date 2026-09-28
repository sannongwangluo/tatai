// C3 验证脚本（用 tsx 跑）：HTTP 层冒烟（sessions CRUD + messages SSE 与 C2 口径一致，
// 真调 DeepSeek 断言流式多 chunk）+ streamdown LICENSE 原文断言（AGENTS.md §6 /
// DESIGN.md §7.1 标注 Apache-2.0，以原文为准）。
// 临时 TATAI_HOME + 临时项目目录，起真实后端子进程，全程走 HTTP：
//   ① POST sessions 创建 → {session_id}；GET sessions 列表（倒序+摘要）；
//   ② GET sessions/:sid 读回消息数组（初始空）；
//   ③ POST messages → 200 text/event-stream，逐 chunk {"delta"} 多个递增、
//      [DONE] 收尾、无 error 事件；读回 = user+assistant 两行；
//   ④ 第二个会话与第一个互不串（列表 2 条，读回各 2 行）；
//   ⑤ streamdown 的 node_modules LICENSE 原文含 "Apache License"（§7.1 核对）。
// ████ 红线 ████ 本脚本绝不打印密钥原文（只报是否存在）。
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

// ── ⑤ streamdown LICENSE 原文核对（§7.1 标注 Apache-2.0，以包内原文为准）──
console.log("[verify] ── ⑤ streamdown LICENSE 原文 ──");
const sdLicensePath = path.join(REPO_ROOT, "node_modules", "streamdown", "LICENSE");
ok(fs.existsSync(sdLicensePath), "node_modules/streamdown/LICENSE 文件存在");
const sdLicense = fs.readFileSync(sdLicensePath, "utf8");
console.log(
  `[verify]   LICENSE 首段: ${JSON.stringify(sdLicense.split("\n").slice(0, 4).join(" ").trim())}`,
);
ok(
  sdLicense.includes("Apache License") && sdLicense.includes("Version 2.0"),
  "⑤ streamdown LICENSE 原文 = Apache License Version 2.0（与 §7.1 标注一致）",
);

// ── 前置：密钥已配置（只报存在，绝不打印原文）──
if (!process.env.DEEPSEEK_API_KEY?.trim()) {
  console.log("[verify] FAIL 前置：DEEPSEEK_API_KEY 环境变量未配置，无法真调");
  process.exit(1);
}
console.log("[verify] 前置：DEEPSEEK_API_KEY 已配置（原文不打印）");

// 临时数据目录 + 临时项目目录（不碰真实 TATAI_HOME 与真实项目）
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-c3-verify-"));
const dataDir = path.join(tmpBase, "home");
const projDir = path.join(tmpBase, "proj");
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(projDir, { recursive: true });
fs.writeFileSync(path.join(projDir, "package.json"), '{"name":"c3-verify-proj"}\n', "utf8");
addProject({ id: "c3-proj", name: "C3 验证项目", path: projDir, kind: "backend" }, dataDir);

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

async function createSession(): Promise<string> {
  const r = await fetch(`${BASE}/api/projects/c3-proj/chat/sessions`, { method: "POST" });
  const j = (await r.json()) as { ok?: boolean; session_id?: string };
  if (!r.ok || !j.session_id) throw new Error(`创建会话失败: HTTP ${r.status} ${JSON.stringify(j)}`);
  return j.session_id;
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

  // ── ① 创建 + 列表 ──
  console.log("[verify] ── ① sessions 创建与列表 ──");
  const sid1 = await createSession();
  ok(/^[0-9A-Za-z_-]+$/.test(sid1), `① 创建会话 → session_id 合法（${sid1}）`);

  // ── ② 读回空会话 ──
  const getEmpty = await fetch(`${BASE}/api/projects/c3-proj/chat/sessions/${sid1}`);
  const emptyBody = (await getEmpty.json()) as { messages?: unknown[] };
  ok(
    getEmpty.status === 200 && Array.isArray(emptyBody.messages) && emptyBody.messages.length === 0,
    "② GET :sid 新会话读回空消息数组（200）",
  );

  // ── ③ messages SSE：真调，多 chunk 流式 + [DONE] + 无 error ──
  console.log("[verify] ── ③ messages SSE 真调（流式多 chunk 断言）──");
  const t0 = Date.now();
  const res = await fetch(`${BASE}/api/projects/c3-proj/chat/sessions/${sid1}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "用两句话说明什么是 MCP" }),
  });
  ok(
    res.status === 200 && (res.headers.get("content-type") ?? "").includes("text/event-stream"),
    "③ POST messages → 200 + text/event-stream",
  );
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const deltas: { at: number; len: number }[] = [];
  let acc = 0;
  let errorEvents = 0;
  let doneSeen = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    // SSE 事件以空行分隔；不完整事件留在 buf 等下一个 chunk（与前端同口径）
    let sep: number;
    while ((sep = buf.indexOf("\n\n")) !== -1) {
      const event = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      for (const line of event.split("\n")) {
        const t = line.trim();
        if (t === "data: [DONE]") doneSeen = true;
        else if (t.startsWith("data: ")) {
          const p = JSON.parse(t.slice(6)) as { delta?: string; error?: string };
          if (typeof p.delta === "string") {
            acc += p.delta.length;
            deltas.push({ at: Date.now() - t0, len: acc });
          }
          if (typeof p.error === "string") errorEvents += 1;
        }
      }
    }
  }
  console.log(
    `[verify]   delta 事件 ${deltas.length} 条，累计字数递增采样: ` +
      deltas
        .filter((_, i) => i % Math.max(1, Math.floor(deltas.length / 8)) === 0 || i === deltas.length - 1)
        .map((d) => `${d.at}ms=${d.len}字`)
        .join(" → "),
  );
  ok(deltas.length >= 3, `③ 真流式：delta 事件 ≥ 3 条逐 chunk 到达（实际 ${deltas.length} 条）`);
  const strictlyIncreasing = deltas.every((d, i) => i === 0 || d.len > deltas[i - 1].len);
  ok(strictlyIncreasing, "③ 累计字数严格递增（流式逐字输出，非一次性全文）");
  ok(doneSeen, "③ SSE 以 data: [DONE] 收尾");
  ok(errorEvents === 0, "③ SSE 流中无 error 事件");

  const getAfter = await fetch(`${BASE}/api/projects/c3-proj/chat/sessions/${sid1}`);
  const afterBody = (await getAfter.json()) as { messages?: Record<string, unknown>[] };
  ok(
    getAfter.status === 200 &&
      afterBody.messages?.length === 2 &&
      afterBody.messages[0].role === "user" &&
      afterBody.messages[1].role === "assistant",
    "③ 发问后读回 = user + assistant 两行（assistant 行流式收齐后落盘）",
  );
  const assistantLen = String(afterBody.messages?.[1]?.content ?? "").length;
  ok(
    assistantLen === acc,
    `③ assistant 落盘全文长度 == SSE delta 累计（${assistantLen} == ${acc}）`,
  );

  // ── ① 列表：倒序 + 摘要 ──
  const listRes = await fetch(`${BASE}/api/projects/c3-proj/chat/sessions`);
  const listBody = (await listRes.json()) as {
    sessions?: { session_id: string; first_message: string | null; message_count: number }[];
  };
  ok(
    listRes.status === 200 &&
      listBody.sessions?.length === 1 &&
      listBody.sessions[0].session_id === sid1 &&
      listBody.sessions[0].first_message === "用两句话说明什么是 MCP" &&
      listBody.sessions[0].message_count === 2,
    "① 列表：1 条会话，带首条消息摘要与消息数",
  );

  // ── ④ 第二个会话隔离 ──
  console.log("[verify] ── ④ 第二个会话隔离 ──");
  const sid2 = await createSession();
  const res2 = await fetch(`${BASE}/api/projects/c3-proj/chat/sessions/${sid2}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "只回答两个字：你好" }),
  });
  const text2 = await res2.text();
  ok(
    res2.status === 200 && text2.includes("data: [DONE]") && !text2.includes('"error"'),
    "④ 会话2 发问 SSE 正常收尾",
  );
  const list2 = (await (
    await fetch(`${BASE}/api/projects/c3-proj/chat/sessions`)
  ).json()) as { sessions?: { session_id: string }[] };
  ok(
    list2.sessions?.length === 2 &&
      list2.sessions[0].session_id === sid2 &&
      list2.sessions[1].session_id === sid1,
    "④ 列表 2 条按最后写入倒序（新会话在前）",
  );
  const s1msgs = (await (
    await fetch(`${BASE}/api/projects/c3-proj/chat/sessions/${sid1}`)
  ).json()) as { messages?: Record<string, unknown>[] };
  const s2msgs = (await (
    await fetch(`${BASE}/api/projects/c3-proj/chat/sessions/${sid2}`)
  ).json()) as { messages?: Record<string, unknown>[] };
  ok(
    s1msgs.messages?.length === 2 &&
      s2msgs.messages?.length === 2 &&
      String(s2msgs.messages[0].content).includes("你好") &&
      !String(s2msgs.messages[0].content).includes("MCP"),
    "④ 两会话读回各自 2 行，内容互不串",
  );

  // ── 错误口径冒烟：空 content / 不存在会话（与 C2 一致）──
  const rBad = await fetch(`${BASE}/api/projects/c3-proj/chat/sessions/${sid1}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "  " }),
  });
  ok(rBad.status === 400, "空 content → 400 INVALID_INPUT（C2 口径）");
  const r404 = await fetch(`${BASE}/api/projects/c3-proj/chat/sessions/nosuchsid`);
  ok(r404.status === 404, "不存在的 sid → 404 SESSION_NOT_FOUND（C2 口径）");
} finally {
  child?.kill();
  fs.rmSync(tmpBase, { recursive: true, force: true });
}

console.log(process.exitCode ? "[verify] 存在 FAIL" : "[verify] 全部 PASS");
