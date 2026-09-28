// C2 验证脚本（用 tsx 跑）：真调 DeepSeek API 验证聊天记录落盘（PLAN.md C2 DoD）。
// 临时 TATAI_HOME + 临时项目目录，起真实后端子进程，全程走 HTTP：
//   ① 发一条消息 → cat .工作台/chat/<sid>.jsonl 两行，字段符合 §2.3.6
//      （user 行 role/content/ts；assistant 行另含 model）；
//   ② 同项目开第二个会话 → 两个 jsonl 文件互不混；
//   ③ 实时性断言：user 行在 API 响应返回之前就落盘（SSE 流还没结束时读文件已有 user 行）；
//   ④ 读回续接：GET 会话消息数组与落盘一致；第一轮告诉它"记住数字 42"，
//      第二轮（带历史上下文）问"数字是几" → assistant 回答体现记得上下文；
//   ⑤ 伪造 sid 路径穿越（../x、..%2Fx、含斜杠编码）被拒（400，且不产生任何文件）；
//   ⑥ flash 不可用（未配密钥子进程）：user 行照写，失败也落 assistant 失败行（带 error 字段，
//      Q34 定版），SSE 返回可读 error 事件不丢消息。
// ████ 红线 ████ 本脚本绝不打印密钥原文（只报是否存在）。
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_MODEL } from "../src/server/flash";
import { addProject } from "../src/server/registry";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8799;
const PORT_NOKEY = 8798;
const BASE = `http://localhost:${PORT}`;
const BASE_NOKEY = `http://localhost:${PORT_NOKEY}`;

const ok = (cond: boolean, label: string) => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (!cond) process.exitCode = 1;
};

// ── 前置：密钥已配置（只报存在，绝不打印原文）──
if (!process.env.DEEPSEEK_API_KEY?.trim()) {
  console.log("[verify] FAIL 前置：DEEPSEEK_API_KEY 环境变量未配置，无法真调");
  process.exit(1);
}
console.log("[verify] 前置：DEEPSEEK_API_KEY 已配置（原文不打印）");

// 临时数据目录 + 临时项目目录（不碰真实 TATAI_HOME 与真实三项目）
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-c2-verify-"));
const dataDir = path.join(tmpBase, "home");
const projDir = path.join(tmpBase, "proj");
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(projDir, { recursive: true });
fs.writeFileSync(path.join(projDir, "package.json"), '{"name":"c2-verify-proj"}\n', "utf8");
addProject({ id: "c2-proj", name: "C2 验证项目", path: projDir, kind: "backend" }, dataDir);
const CHAT_DIR = path.join(projDir, ".工作台", "chat");

async function spawnServer(port: number, withKey: boolean): Promise<ChildProcess> {
  await assertPortFree(port); // 端口已被占：立刻失败，不拿占用者的服务跑验证
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TATAI_HOME: dataDir,
    TATAI_PORT: String(port),
  };
  if (!withKey) delete env.DEEPSEEK_API_KEY;
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

function readJsonl(file: string): Record<string, unknown>[] {
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/;

async function createSession(base: string): Promise<string> {
  const r = await fetch(`${base}/api/projects/c2-proj/chat/sessions`, { method: "POST" });
  const j = (await r.json()) as { ok?: boolean; session_id?: string };
  if (!r.ok || !j.session_id) throw new Error(`创建会话失败: HTTP ${r.status} ${JSON.stringify(j)}`);
  return j.session_id;
}

let child: ChildProcess | undefined;
let childNoKey: ChildProcess | undefined;
try {
  child = await spawnServer(PORT, true);
  await waitUp(BASE);
  console.log(`[verify] server up at ${BASE}（TATAI_HOME=${dataDir}）`);

  // ── ①③ 发一条消息：实时性断言（流未结束时 user 行已落盘）+ 收齐后两行字段 ──
  console.log("[verify] ── ①③ 第一轮消息：实时落盘 + 两行字段（§2.3.6）──");
  const sid1 = await createSession(BASE);
  console.log(`[verify]   会话1: ${sid1}`);
  ok(/^[0-9A-Za-z_-]+$/.test(sid1), "sessionId 只含文件名安全字符（时间戳+短随机）");
  ok(fs.existsSync(path.join(CHAT_DIR, `${sid1}.jsonl`)), "创建会话即建空 jsonl 文件");

  const t0 = Date.now();
  const res1 = await fetch(`${BASE}/api/projects/c2-proj/chat/sessions/${sid1}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "请记住数字 42，只回复：记住了" }),
  });
  ok(
    res1.status === 200 &&
      (res1.headers.get("content-type") ?? "").includes("text/event-stream"),
    "messages 接口 → 200 + content-type text/event-stream",
  );
  // 实时性断言：SSE 流还没读完（第一个 chunk 刚到）时读文件，user 行必须已落盘
  const reader1 = res1.body!.getReader();
  const firstChunk = await reader1.read();
  ok(!firstChunk.done, "SSE：收到首个 chunk（流进行中）");
  const midLines = readJsonl(path.join(CHAT_DIR, `${sid1}.jsonl`));
  console.log(`[verify]   流进行中读盘（${Date.now() - t0}ms）: ${JSON.stringify(midLines)}`);
  ok(
    midLines.length === 1 &&
      midLines[0].role === "user" &&
      midLines[0].content === "请记住数字 42，只回复：记住了",
    "实时落盘：SSE 流未结束时 user 行已落盘（不是退出才写）",
  );
  // 继续读完流
  const dec = new TextDecoder();
  let sseText = dec.decode(firstChunk.value, { stream: true });
  let acc1 = "";
  for (;;) {
    const { done, value } = await reader1.read();
    if (done) break;
    sseText += dec.decode(value, { stream: true });
  }
  for (const line of sseText.split("\n")) {
    const t = line.trim();
    if (t.startsWith("data: ") && t !== "data: [DONE]") {
      const p = JSON.parse(t.slice(6)) as { delta?: string; error?: string };
      if (typeof p.delta === "string") acc1 += p.delta;
      ok(p.error === undefined, `SSE 流中无 error 事件（实际: ${p.error ?? "无"}）`);
    }
  }
  ok(sseText.includes("data: [DONE]"), "SSE 以 data: [DONE] 正常收尾");
  console.log(`[verify]   assistant 全文（${acc1.length} 字）: ${JSON.stringify(acc1)}`);

  const lines1 = readJsonl(path.join(CHAT_DIR, `${sid1}.jsonl`));
  console.log(`[verify]   cat .工作台/chat/${sid1}.jsonl：`);
  for (const l of lines1) console.log(`[verify]     ${JSON.stringify(l)}`);
  ok(lines1.length === 2, "① 发一条消息后 jsonl 两行（user + assistant）");
  const [u1, a1] = lines1;
  ok(
    u1.role === "user" && typeof u1.content === "string" && TS_RE.test(String(u1.ts)),
    "① user 行字段符合 §2.3.6（role/content/ts 本地ISO带偏移）",
  );
  ok(
    a1.role === "assistant" &&
      a1.content === acc1 &&
      TS_RE.test(String(a1.ts)) &&
      a1.model === DEFAULT_MODEL,
    "① assistant 行字段符合 §2.3.6（另含 model；content = SSE 收齐全文）",
  );

  // ── ② 第二个会话：两个 jsonl 文件互不混 ──
  console.log("[verify] ── ② 第二个会话：两个 jsonl 互不混 ──");
  const sid2 = await createSession(BASE);
  const res2 = await fetch(`${BASE}/api/projects/c2-proj/chat/sessions/${sid2}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "只回答一个数字：1+1 等于几？" }),
  });
  const text2 = await res2.text();
  ok(text2.includes("data: [DONE]") && !text2.includes('"error"'), "会话2 发问 SSE 正常收尾");
  const chatFiles = fs.readdirSync(CHAT_DIR).filter((f) => f.endsWith(".jsonl"));
  console.log(`[verify]   chat/ 目录: ${JSON.stringify(chatFiles)}`);
  ok(
    chatFiles.length === 2 && chatFiles.includes(`${sid1}.jsonl`) && chatFiles.includes(`${sid2}.jsonl`),
    "② 两个会话 → 两个 jsonl 文件",
  );
  const lines2 = readJsonl(path.join(CHAT_DIR, `${sid2}.jsonl`));
  const lines1After = readJsonl(path.join(CHAT_DIR, `${sid1}.jsonl`));
  ok(
    lines2.length === 2 &&
      lines2.every((l) => String(l.content).includes("1+1") || l.role === "assistant") &&
      !lines2.some((l) => String(l.content).includes("42")) &&
      lines1After.length === 2,
    "② 两个 jsonl 内容互不混（会话2 无会话1 的 42 上下文，会话1 未被污染）",
  );

  // ── 列表接口：倒序 + 首条消息摘要 ──
  const listRes = await fetch(`${BASE}/api/projects/c2-proj/chat/sessions`);
  const listBody = (await listRes.json()) as {
    sessions?: { session_id: string; first_message: string | null; message_count: number }[];
  };
  console.log(`[verify]   会话列表: ${JSON.stringify(listBody.sessions)}`);
  ok(
    listRes.status === 200 &&
      listBody.sessions?.length === 2 &&
      listBody.sessions[0].session_id === sid2 &&
      listBody.sessions[1].session_id === sid1,
    "列表：两个会话按最后写入时间倒序（新的在前）",
  );
  ok(
    listBody.sessions?.[1].first_message === "请记住数字 42，只回复：记住了" &&
      listBody.sessions[1].message_count === 2,
    "列表：带首条消息摘要与消息数",
  );

  // ── ④ 读回续接：GET 消息数组与落盘一致；带历史再问，assistant 记得 42 ──
  console.log("[verify] ── ④ 读回续接：历史上下文真调 ──");
  const getRes = await fetch(`${BASE}/api/projects/c2-proj/chat/sessions/${sid1}`);
  const getBody = (await getRes.json()) as { messages?: Record<string, unknown>[] };
  ok(
    getRes.status === 200 &&
      JSON.stringify(getBody.messages) === JSON.stringify(lines1),
    "④ GET 会话：消息数组与落盘 jsonl 逐行一致",
  );
  const res3 = await fetch(`${BASE}/api/projects/c2-proj/chat/sessions/${sid1}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "我刚才让你记的数字是几？只回答数字" }),
  });
  const text3 = await res3.text();
  let acc3 = "";
  for (const line of text3.split("\n")) {
    const t = line.trim();
    if (t.startsWith("data: ") && t !== "data: [DONE]") {
      const p = JSON.parse(t.slice(6)) as { delta?: string };
      if (typeof p.delta === "string") acc3 += p.delta;
    }
  }
  console.log(`[verify]   第二轮 assistant 全文: ${JSON.stringify(acc3)}`);
  ok(acc3.includes("42"), "④ 续接：assistant 回答体现记得上下文（数字 42）");
  const lines1Final = readJsonl(path.join(CHAT_DIR, `${sid1}.jsonl`));
  ok(
    lines1Final.length === 4 &&
      lines1Final[2].role === "user" &&
      lines1Final[3].role === "assistant" &&
      lines1Final[3].content === acc3,
    "④ 第二轮后会话1 jsonl 共 4 行，user/assistant 交替且内容一致",
  );

  // ── ⑤ 伪造 sid 路径穿越被拒 ──
  console.log("[verify] ── ⑤ 路径穿越 ──");
  const traversalCases: { sid: string; note: string }[] = [
    { sid: "..%2F..%2Fx", note: "..%2F..%2Fx（解码后 ../../x）" },
    { sid: "..%2Fx", note: "..%2Fx（解码后 ../x）" },
    { sid: "a%2Fb", note: "a%2Fb（解码后 a/b，含斜杠）" },
    { sid: "a%5Cb", note: "a%5Cb（解码后 a\\b，含反斜杠）" },
    { sid: "a.b", note: "a.b（含点）" },
  ];
  const filesBefore = fs.readdirSync(CHAT_DIR).length;
  for (const c of traversalCases) {
    const r = await fetch(`${BASE}/api/projects/c2-proj/chat/sessions/${c.sid}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "hi" }),
    });
    const j = (await r.json()) as { error?: { code?: string } };
    ok(
      r.status === 400 && j.error?.code === "INVALID_INPUT",
      `⑤ 伪造 sid ${c.note} → 400 INVALID_INPUT`,
    );
  }
  const rGet = await fetch(`${BASE}/api/projects/c2-proj/chat/sessions/..%2F..%2Fx`);
  ok(rGet.status === 400, "⑤ GET 伪造 sid（../../x）同样 400");
  ok(
    fs.readdirSync(CHAT_DIR).length === filesBefore &&
      !fs.existsSync(path.join(projDir, ".工作台", "x.jsonl")) &&
      !fs.existsSync(path.join(tmpBase, "x.jsonl")),
    "⑤ 穿越尝试不产生任何新文件",
  );
  const r404 = await fetch(`${BASE}/api/projects/c2-proj/chat/sessions/nosuchsid`);
  ok(r404.status === 404, "⑤ 合法但不存在的 sid → 404 SESSION_NOT_FOUND");

  // ── ⑥ flash 不可用（未配密钥）：user 行 + assistant 失败行都落盘，SSE 可读 error ──
  console.log("[verify] ── ⑥ flash 不可用：user 行与 assistant 失败行都落盘，SSE 返回可读错误 ──");
  childNoKey = await spawnServer(PORT_NOKEY, false);
  await waitUp(BASE_NOKEY);
  const sidNk = await createSession(BASE_NOKEY);
  const resNk = await fetch(
    `${BASE_NOKEY}/api/projects/c2-proj/chat/sessions/${sidNk}/messages`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "这条消息在 flash 不可用时发出" }),
    },
  );
  const textNk = await resNk.text();
  console.log(`[verify]   无密钥 SSE 响应原文: ${textNk.trim()}`);
  ok(
    textNk.includes('"error"') &&
      textNk.includes("未配置 DeepSeek 密钥") &&
      textNk.includes('"user_message_saved":true'),
    "⑥ flash 不可用 → SSE 可读 error 事件（user_message_saved: true）",
  );
  const linesNk = readJsonl(path.join(CHAT_DIR, `${sidNk}.jsonl`));
  console.log(`[verify]   无密钥会话落盘 ${linesNk.length} 行: ${JSON.stringify(linesNk)}`);
  ok(
    linesNk.length === 2 &&
      linesNk[0].role === "user" &&
      linesNk[0].content === "这条消息在 flash 不可用时发出",
    "⑥ user 行已落盘不丢消息",
  );
  // Q34 定版（2026-09-18 审计）：失败也落一条带 error 的 assistant 行，不再只剩"问了没答"
  const failNk: Record<string, unknown> | undefined = linesNk[1];
  ok(
    failNk?.role === "assistant" &&
      typeof failNk.error === "string" &&
      failNk.error.includes("未配置 DeepSeek 密钥"),
    "⑥ 失败也落 assistant 失败行（带 error 字段，Q34 定版行为）",
  );
} finally {
  child?.kill();
  childNoKey?.kill();
  fs.rmSync(tmpBase, { recursive: true, force: true });
}

console.log(process.exitCode ? "[verify] 存在 FAIL" : "[verify] 全部 PASS");
