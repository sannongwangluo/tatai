// 聊天背景注入验证（2026-09-19 试用增强，tsx 跑）：临时 TATAI_HOME + 临时项目，起真实后端子进程，
// 全程走 HTTP，真调一次 DeepSeek，用「只有读了背景材料才答得出」的暗记断言注入生效：
//   ① 临时项目的设计书里埋暗记标题（葡萄藤-标记-42），进度保持初始态（Gate=requirement）；
//   ② POST messages 问"设计书第二节标题原文 + Gate 当前步 id"——答对 = 背景材料真进了模型请求
//      （盲聊模式下这两问必答错/瞎编）；
//   ③ 读回会话 = 恰好 user + assistant 两行、无 system 行——背景材料只进模型请求，
//      不污染会话 jsonl（落盘口径不变，§2.3.6）。
// ████ 红线 ████ 本脚本绝不打印密钥原文（只报是否存在）。
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { addProject } from "../src/server/registry";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8798;
const BASE = `http://localhost:${PORT}`;
const PROJ = "chatctx-proj";
/** 设计书暗记：只有真把设计书喂进模型请求才答得出来 */
const MARKER = "葡萄藤-标记-42";

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

// 临时数据目录 + 临时项目目录（不碰真实 TATAI_HOME 与真实项目）
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-chatctx-verify-"));
const dataDir = path.join(tmpBase, "home");
const projDir = path.join(tmpBase, "proj");
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(projDir, { recursive: true });
fs.writeFileSync(path.join(projDir, "package.json"), '{"name":"chatctx-verify-proj"}\n', "utf8");
addProject({ id: PROJ, name: "背景注入验证项目", path: projDir, kind: "backend" }, dataDir);
// 埋暗记设计书（非塔台项目的设计书路径 = <项目根>/.工作台/design.md，见 workstation.designPath）
fs.mkdirSync(path.join(projDir, ".工作台"), { recursive: true });
fs.writeFileSync(
  path.join(projDir, ".工作台", "design.md"),
  [
    "# 背景注入验证项目 设计稿",
    "",
    "## 第一节：背景说明",
    "",
    "这个文件只用来验证聊天背景注入。",
    "",
    `## 第二节：${MARKER}`,
    "",
    "暗记所在节。回答问题时必须引用本节标题原文。",
    "",
  ].join("\n"),
  "utf8",
);

async function waitUp(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return;
    } catch {
      // 还没起来，继续等
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("后端 10 秒内未就绪");
}

// ── 端口冲突快速失败（与 verify-c3 同款：不拿占用者的服务跑验证）──
const upPorts = new Set<number>();

function portListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: "127.0.0.1" });
    const done = (busy: boolean) => {
      sock.destroy();
      resolve(busy);
    };
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
    sock.setTimeout(1000, () => done(false));
  });
}

async function assertPortFree(port: number): Promise<void> {
  if (await portListening(port)) {
    console.error(`[verify] 后端起不来：端口 ${port} 被占用，先清理残留进程`);
    process.exit(1);
  }
}

function watchChild(proc: ChildProcess, port: number, isUp: () => boolean): void {
  proc.once("exit", async (code) => {
    if (isUp()) return;
    const why = (await portListening(port))
      ? `端口 ${port} 被占用`
      : `后端进程提前退出（code=${code}）`;
    console.error(`[verify] 后端起不来：${why}，先清理残留进程`);
    process.exit(1);
  });
}

let child: ChildProcess | undefined;
try {
  await assertPortFree(PORT);
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
  watchChild(proc, PORT, () => upPorts.has(PORT));
  await waitUp();
  upPorts.add(PORT);
  console.log(`[verify] server up at ${BASE}（TATAI_HOME=${dataDir}）`);

  // ── ① 创建会话 ──
  const r0 = await fetch(`${BASE}/api/projects/${PROJ}/chat/sessions`, { method: "POST" });
  const j0 = (await r0.json()) as { ok?: boolean; session_id?: string };
  if (!r0.ok || !j0.session_id) throw new Error(`创建会话失败: HTTP ${r0.status} ${JSON.stringify(j0)}`);
  const sid = j0.session_id;
  ok(/^[0-9A-Za-z_-]+$/.test(sid), `① 创建会话 → session_id 合法（${sid}）`);

  // ── ② 真调：问只有读了背景才答得出的问题 ──
  console.log("[verify] ── ② messages 真调（暗记断言：设计书标题 + Gate 当前步）──");
  const res = await fetch(`${BASE}/api/projects/${PROJ}/chat/sessions/${sid}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      content:
        "只根据你拿到的背景材料，用一行回答两个问题，格式：「标题=…；步=…」。" +
        "① 背景材料里设计书『第二节』的标题原文是什么？② Gate 当前步的 id 是什么？",
    }),
  });
  ok(
    res.status === 200 && (res.headers.get("content-type") ?? "").includes("text/event-stream"),
    "② POST messages → 200 + text/event-stream",
  );
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let full = "";
  let errorEvents = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let sep: number;
    while ((sep = buf.indexOf("\n\n")) !== -1) {
      const event = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      for (const line of event.split("\n")) {
        const t = line.trim();
        if (!t.startsWith("data: ") || t === "data: [DONE]") continue;
        const p = JSON.parse(t.slice(6)) as { delta?: string; error?: string };
        if (typeof p.delta === "string") full += p.delta;
        if (typeof p.error === "string") errorEvents++;
      }
    }
  }
  console.log(`[verify]   回答全文（${full.length} 字）：${full.slice(0, 200)}`);
  ok(errorEvents === 0, "② SSE 无 error 事件");
  ok(full.includes(MARKER), `② 回答含设计书暗记「${MARKER}」（背景材料真进了模型请求）`);
  ok(
    /kickoff/i.test(full),
    "② 回答含 Gate 当前步 id=kickoff（初始态首步=立项，进度快照真进了模型请求）",
  );

  // ── ③ 落盘口径不变：读回恰好 user + assistant 两行、无 system 行 ──
  console.log("[verify] ── ③ 会话落盘口径（背景材料不写进 jsonl）──");
  const rb = await fetch(`${BASE}/api/projects/${PROJ}/chat/sessions/${sid}`);
  const jb = (await rb.json()) as { messages?: { role: string; content: string }[] };
  const roles = (jb.messages ?? []).map((m) => m.role);
  ok(
    rb.status === 200 && roles.length === 2 && roles[0] === "user" && roles[1] === "assistant",
    `③ 读回 = user+assistant 两行（实际：${JSON.stringify(roles)}）`,
  );
  ok(
    !(jb.messages ?? []).some((m) => m.role === "system"),
    "③ 没有 system 行落盘（背景只进模型请求，§2.3.6 口径不变）",
  );
} finally {
  if (child && !child.killed) child.kill();
  await new Promise((r) => setTimeout(r, 300));
  try {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  } catch {
    /* Windows 下文件偶被占用，残留 tmp 目录无害 */
  }
}
console.log("[verify] done");
