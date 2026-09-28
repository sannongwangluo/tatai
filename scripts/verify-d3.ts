// D3 验证脚本（用 tsx 跑）：HTTP + 逻辑层断言落稿流程（聊天 → design.md，§3.5/§3.6）。
// 用法：pnpm verify:d3（自带临时 TATAI_HOME 与临时项目目录，不碰真实注册表与真实项目；
// 唯一例外：注册一个指向本 repo 根的 "tatai" 记录，验证塔台自身落稿——落点在 DESIGN.md
// 附录 B 标题之前（2026-09-19 主人拍板解锁，原 TATAI_DESIGN_LOCKED 拒绝已废），
// 每次验证后立即逐字节还原，脚本收尾再对基线快照断言）
// 覆盖点（PLAN.md D3 DoD 与施工图）：
//   ① POST design/append 写入一段 → design.md 真实新增（打印写入前/后行数）；
//      再写一段 → 行数累加且前段原文未动（diff 证据：新内容 == 旧内容 + 新段）
//   ② 不点就绝不写：发消息（真调 flash 走完整 SSE）/读会话/切会话后，design.md 仍不存在
//   ③ 空 content → 400 INVALID_INPUT 且不污染文件；伪造 id → 404 PROJECT_NOT_FOUND
//   ④ 落稿段与确认的 content 逐字节一致（DoD④：落稿内容 == 确认内容）
//   ⑤ 塔台自身调 append → 200，内容插在 DESIGN.md 附录 B 标题之前（逐字节重组一致），
//      验证后立即逐字节还原（真实 repo 文件不留测试内容）
//   ⑥ POST design/draft 真调 flash 生成草稿（贴耗时与草稿片段）；
//      伪造 sid 400 / 不存在 sid 404 / 空会话 400 / draft 不落盘
//   ⑦ 红线回归：PUT/DELETE /design 404、POST /design 本体 404（D1 只读红线不破）
// ████ 红线 ████ 本脚本绝不打印密钥原文（只报是否存在）。
import { execSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendMessage, createSession } from "../src/server/chat";
import { addProject } from "../src/server/registry";
import { nowIso } from "../src/server/time";
import { appendDesign, WsError } from "../src/server/workstation";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DESIGN_FILE = path.join(REPO_ROOT, "DESIGN.md");
/** 塔台落稿插入点标记（与 workstation.ts 的 TATAI_APPENDIX_B_HEADING 同一原文） */
const APPENDIX_B_HEADING = "## 附录 B：待议记录";
const PORT = 8796;
const BASE = `http://localhost:${PORT}`;

const ok = (cond: boolean, label: string) => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (!cond) process.exitCode = 1;
};

// ── 前置：密钥已配置（draft 提炼与"不点就绝不写"的消息流要真调 flash）──
if (!process.env.DEEPSEEK_API_KEY?.trim()) {
  console.log("[verify] FAIL 前置：DEEPSEEK_API_KEY 环境变量未配置，无法真调");
  process.exit(1);
}
console.log("[verify] 前置：DEEPSEEK_API_KEY 已配置（原文不打印）");

// ── 临时数据目录与三个临时项目（不碰真实注册表与真实项目）──
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-d3-verify-"));
const dataDir = path.join(tmpBase, "home");
const projDir = path.join(tmpBase, "d3-proj"); // 落稿主项目
const projDir2 = path.join(tmpBase, "d3-proj2"); // "不点就绝不写"项目
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(projDir);
fs.mkdirSync(projDir2);
addProject({ id: "d3-proj", name: "D3 验证项目", path: projDir, kind: "backend" }, dataDir);
addProject({ id: "d3-proj2", name: "D3 不点就绝不写项目", path: projDir2, kind: "backend" }, dataDir);
// 塔台自身例外：id=="tatai" 指向本 repo 根（self_managed），验证塔台落稿解锁（插附录 B 前）
addProject(
  { id: "tatai", name: "塔台", path: REPO_ROOT, kind: "fullstack", self_managed: true },
  dataDir,
);

// ── 塔台 DESIGN.md 基线快照（落稿验证的还原对照：跑完必须与开跑前逐字节一致）──
const designBaseline = fs.readFileSync(DESIGN_FILE, "utf8");
const gitDiffBaseline = execSync("git diff -- DESIGN.md", { cwd: REPO_ROOT }).toString();
console.log(`[verify] 基线：DESIGN.md ${designBaseline.length} 字符（塔台落稿验证的还原对照）`);

const designFile = path.join(projDir, ".工作台", "design.md");
const designFile2 = path.join(projDir2, ".工作台", "design.md");
const countLines = (t: string) => (t === "" ? 0 : t.replace(/\n+$/, "").split("\n").length);

// ══ 逻辑层（直接调 workstation 层，不起服务）══
console.log("[verify] ── 逻辑层：appendDesign ──");

// 塔台自身：落稿解锁（2026-09-19 主人拍板）——插到 DESIGN.md 附录 B 标题之前，
// 逐字节断言后立即还原（真实 repo 文件，绝不留测试内容）
{
  const seg = "## 塔台落稿验证段（逻辑层）\n\n- 插入点在附录 B 标题之前；验证结束逐字节还原。\n";
  const r = appendDesign("tatai", seg, dataDir);
  const after = fs.readFileSync(DESIGN_FILE, "utf8");
  const idxB = designBaseline.indexOf(APPENDIX_B_HEADING);
  ok(idxB > 0, "逻辑层：基线 DESIGN.md 能定位附录 B 标题（插入点存在）");
  ok(
    after === designBaseline.slice(0, idxB) + seg + designBaseline.slice(idxB),
    "逻辑层：塔台落稿插在附录 B 标题之前（前段+插入段+后段逐字节重组一致）",
  );
  ok(
    r.lines_after === r.lines_before + countLines(seg),
    "逻辑层：塔台落稿回执行数 = 写前行数 + 插入段行数",
  );
  fs.writeFileSync(DESIGN_FILE, designBaseline, "utf8"); // 立即还原
  ok(
    fs.readFileSync(DESIGN_FILE, "utf8") === designBaseline,
    "逻辑层：验证后 DESIGN.md 已逐字节还原",
  );
}

// 空内容 / 伪造 id
for (const bad of ["", "   "]) {
  try {
    appendDesign("d3-proj", bad, dataDir);
    ok(false, `逻辑层：空 content 被拒（实际: 未抛错, content=${JSON.stringify(bad)}）`);
  } catch (e) {
    ok(
      e instanceof WsError && e.code === "INVALID_INPUT",
      `逻辑层：空 content → INVALID_INPUT（content=${JSON.stringify(bad)}）`,
    );
  }
}
try {
  appendDesign("..\\..\\Windows", "## 越权落稿", dataDir);
  ok(false, "逻辑层：伪造 id 落稿被拒（实际: 未抛错）");
} catch (e) {
  ok(
    e instanceof WsError && e.code === "PROJECT_NOT_FOUND",
    "逻辑层：伪造 id → PROJECT_NOT_FOUND（路径只走注册表）",
  );
}
ok(!fs.existsSync(designFile), "逻辑层：被拒的调用没有创建 design.md");

// ══ 起真实后端子进程（临时 TATAI_HOME + 独立端口）══
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

interface ApiResp {
  status: number;
  body: {
    ok?: boolean;
    draft?: string;
    model?: string;
    result?: { source: string; lines_before: number; lines_after: number };
    error?: { code: string; message: string };
  };
}

async function httpPost(rawPath: string, payload: unknown): Promise<ApiResp> {
  const res = await fetch(`${BASE}${rawPath}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
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

  // ── 造会话消息（模拟一次设计讨论；user/assistant 两行，直接落 jsonl）──
  const sid = createSession("d3-proj", dataDir);
  appendMessage("d3-proj", sid, {
    role: "user",
    content: "设计书的数据流向图和模块方框图怎么区分？",
    ts: nowIso(),
  }, dataDir);
  appendMessage("d3-proj", sid, {
    role: "assistant",
    content: "两图节点集合相同，边集合按方向过滤/着色；数据只保留一份，两个视图是两种渲染。",
    ts: nowIso(),
    model: "deepseek-chat",
  }, dataDir);
  ok(!fs.existsSync(designFile), "② 造会话消息后 design.md 仍不存在（聊天本身零写入）");

  // ── ⑥ draft：真调 flash 提炼草稿（只生成，不落盘）──
  console.log("[verify] ── ⑥ POST design/draft 真调 flash ──");
  const t0 = Date.now();
  const draftResp = await httpPost(`/api/projects/d3-proj/design/draft`, { session_id: sid });
  const draftMs = Date.now() - t0;
  ok(
    draftResp.status === 200 && typeof draftResp.body.draft === "string" && draftResp.body.draft.trim() !== "",
    `⑥ draft 真调成功（200，${draftMs}ms，model=${draftResp.body.model}）`,
  );
  const draft = draftResp.body.draft ?? "";
  console.log(`[verify]   草稿 ${draft.length} 字，首 120 字: ${JSON.stringify(draft.slice(0, 120))}`);
  ok(
    !fs.existsSync(designFile),
    "⑥ draft 只生成不落盘（design.md 仍不存在——不点就绝不写，草稿阶段也不算点）",
  );

  // draft 错误路径：伪造 sid / 不存在 sid / 空会话
  const forgedSid = await httpPost(`/api/projects/d3-proj/design/draft`, { session_id: "..%2Fx" });
  ok(
    forgedSid.status === 400 && forgedSid.body.error?.code === "INVALID_INPUT",
    "⑥ draft 伪造 sid → 400 INVALID_INPUT（路径穿越拦截）",
  );
  const noSid = await httpPost(`/api/projects/d3-proj/design/draft`, { session_id: "nosuchsid123" });
  ok(
    noSid.status === 404 && noSid.body.error?.code === "SESSION_NOT_FOUND",
    "⑥ draft 不存在 sid → 404 SESSION_NOT_FOUND",
  );
  const emptySid = createSession("d3-proj", dataDir);
  const emptyDraft = await httpPost(`/api/projects/d3-proj/design/draft`, { session_id: emptySid });
  ok(
    emptyDraft.status === 400 && emptyDraft.body.error?.code === "INVALID_INPUT",
    "⑥ draft 空会话 → 400 INVALID_INPUT（无可提炼的讨论）",
  );

  // ── ① HTTP append 第一段：design.md 真实新增（创建带标题头的文件 + 追加）──
  console.log("[verify] ── ① POST design/append 第一段 ──");
  const segA = draft; // 落稿内容 = 确认的草稿（这里草稿未经编辑，DoD④ 对照 UI 层的"编辑后确认"路径）
  const a1 = await httpPost(`/api/projects/d3-proj/design/append`, { content: segA });
  ok(a1.status === 200 && a1.body.ok === true, "① append 第一段 → 200");
  const disk1 = fs.readFileSync(designFile, "utf8");
  console.log(
    `[verify]   写入前 ${a1.body.result?.lines_before} 行 → 写入后 ${a1.body.result?.lines_after} 行（回执）`,
  );
  console.log(`[verify]   cat design.md 实际行数: ${countLines(disk1)}（写入前文件不存在 = 0 行）`);
  ok(fs.existsSync(designFile), "① design.md 已创建");
  ok(disk1.startsWith("# D3 验证项目 设计稿\n"), "① 新建文件带标题头（# <项目名> 设计稿）");
  ok(disk1.includes(segA), "① 落稿段已落盘");
  ok(
    countLines(disk1) === a1.body.result?.lines_after,
    "① 回执行数与 cat design.md 实际行数一致",
  );
  // DoD④：落稿段与确认的 content 逐字节一致（定位追加起点逐字节比对）
  const headerEnd = disk1.indexOf(segA);
  ok(
    headerEnd > 0 && disk1.slice(headerEnd, headerEnd + segA.length) === segA,
    "④ 落稿段与确认的 content 逐字节一致（不加工、不全量倾倒聊天记录）",
  );
  ok(
    !disk1.includes("设计书的数据流向图和模块方框图怎么区分？"),
    "④ design.md 不含聊天记录原文（落稿的是提炼后的草稿，不是聊天倾倒）",
  );

  // ── ① 再写第二段：行数累加且前段原文未动（diff 证据）──
  console.log("[verify] ── ① POST design/append 第二段 ──");
  const segB = "## 落稿口径补充\n\n- 落稿动作本身是人工筛选，确认才写（§3.6）。";
  const a2 = await httpPost(`/api/projects/d3-proj/design/append`, { content: segB });
  ok(a2.status === 200 && a2.body.ok === true, "① append 第二段 → 200");
  const disk2 = fs.readFileSync(designFile, "utf8");
  console.log(
    `[verify]   写入前 ${a2.body.result?.lines_before} 行 → 写入后 ${a2.body.result?.lines_after} 行（回执）`,
  );
  console.log(`[verify]   diff 证据：新内容 == 旧内容 + 第二段 + "\\n" → ${disk2 === disk1 + segB + "\n"}`);
  ok(
    disk2 === disk1 + segB + "\n" && disk2.startsWith(disk1),
    "① 第二段落稿后行数累加且前段原文逐字节未动（diff = 纯追加）",
  );
  ok(
    disk2.slice(disk1.length, disk1.length + segB.length) === segB,
    "④ 第二段与确认的 content 逐字节一致",
  );

  // ── ③ 空 content / 伪造 id ──
  const emptyAppend = await httpPost(`/api/projects/d3-proj/design/append`, { content: "   " });
  ok(
    emptyAppend.status === 400 && emptyAppend.body.error?.code === "INVALID_INPUT",
    "③ 空 content → 400 INVALID_INPUT",
  );
  ok(
    fs.readFileSync(designFile, "utf8") === disk2,
    "③ 被拒的空落稿没有污染文件（与两次落稿后逐字节一致）",
  );
  const forgedAppend = await httpPost(`/api/projects/${"..%2F..%2FWindows"}/design/append`, {
    content: "## 越权落稿",
  });
  ok(
    forgedAppend.status === 404 && forgedAppend.body.error?.code === "PROJECT_NOT_FOUND",
    "③ 伪造 id → 404 PROJECT_NOT_FOUND",
  );

  // ── ⑤ 塔台自身落稿（2026-09-19 主人拍板解锁）：插到 DESIGN.md 附录 B 标题之前 ──
  console.log("[verify] ── ⑤ 塔台自身 append（附录 B 前插入，验证后还原）──");
  const tataiSeg = "## 塔台落稿验证段（HTTP）\n\n- 插入点在附录 B 标题之前；验证结束逐字节还原。\n";
  const tataiAppend = await httpPost(`/api/projects/tatai/design/append`, {
    content: tataiSeg,
  });
  ok(
    tataiAppend.status === 200 && tataiAppend.body.ok === true,
    `⑤ 塔台自身 append → 200（实际: ${tataiAppend.status} ${tataiAppend.body.error?.code ?? ""}）`,
  );
  const tataiAfter = fs.readFileSync(DESIGN_FILE, "utf8");
  const idxB2 = designBaseline.indexOf(APPENDIX_B_HEADING);
  ok(
    tataiAfter === designBaseline.slice(0, idxB2) + tataiSeg + designBaseline.slice(idxB2),
    "⑤ 插入位置正确：附录 B 标题之前逐字节重组一致（HTTP 层与逻辑层同口径）",
  );
  console.log(
    `[verify]   写入前 ${tataiAppend.body.result?.lines_before} 行 → 写入后 ${tataiAppend.body.result?.lines_after} 行（回执）`,
  );
  // 还原真实 repo 文件，并确认 git diff 回到开跑前基线
  fs.writeFileSync(DESIGN_FILE, designBaseline, "utf8");
  ok(
    fs.readFileSync(DESIGN_FILE, "utf8") === designBaseline &&
      execSync("git diff -- DESIGN.md", { cwd: REPO_ROOT }).toString() === gitDiffBaseline,
    "⑤ 还原后 DESIGN.md 逐字节回到基线、git diff 与开跑前一致",
  );

  // ── ② 不点就绝不写：发消息（真调完整 SSE）/读会话/切会话，全程 design.md 不存在 ──
  console.log("[verify] ── ② 不点就绝不写（真调 flash 走完整消息流）──");
  const sid2Resp = await fetch(`${BASE}/api/projects/d3-proj2/chat/sessions`, { method: "POST" });
  const sid2 = ((await sid2Resp.json()) as { session_id: string }).session_id;
  const msgRes = await fetch(`${BASE}/api/projects/d3-proj2/chat/sessions/${sid2}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "只回答两个字：收到" }),
  });
  ok(
    msgRes.status === 200 && (msgRes.headers.get("content-type") ?? "").includes("text/event-stream"),
    "② 发消息 → 200 SSE（真调 flash）",
  );
  // 消费完整 SSE 流到 [DONE]
  const reader = msgRes.body!.getReader();
  const dec = new TextDecoder();
  let sseBuf = "";
  let sseDone = false;
  let sseError: string | null = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    sseBuf += dec.decode(value, { stream: true });
    if (sseBuf.includes("data: [DONE]")) sseDone = true;
    const m = sseBuf.match(/"error"\s*:\s*"([^"]+)"/);
    if (m) sseError = m[1];
  }
  ok(sseDone && sseError === null, `② SSE 收齐 [DONE] 且无 error 事件（error=${sseError}）`);
  // 读回会话 + 切会话（再建一个并读回）
  const readBack = await fetch(`${BASE}/api/projects/d3-proj2/chat/sessions/${sid2}`);
  const readBackBody = (await readBack.json()) as { messages?: unknown[] };
  ok(
    readBack.status === 200 && Array.isArray(readBackBody.messages) && readBackBody.messages.length === 2,
    "② 读回会话 = user+assistant 两行",
  );
  const sid2bResp = await fetch(`${BASE}/api/projects/d3-proj2/chat/sessions`, { method: "POST" });
  const sid2b = ((await sid2bResp.json()) as { session_id: string }).session_id;
  const readBack2 = await fetch(`${BASE}/api/projects/d3-proj2/chat/sessions/${sid2b}`);
  ok(readBack2.status === 200, "② 切到第二个会话读回正常");
  const listResp = await fetch(`${BASE}/api/projects/d3-proj2/chat/sessions`);
  const listBody = (await listResp.json()) as { sessions?: unknown[] };
  ok(
    listResp.status === 200 && Array.isArray(listBody.sessions) && listBody.sessions.length === 2,
    "② 会话列表 = 2 条（切会话动作发生）",
  );
  ok(
    !fs.existsSync(designFile2),
    "② 发消息/收流/读回/切会话全程后 design.md 仍不存在（不点就绝不写，§3.6）",
  );

  // ── ⑦ 红线回归：PUT/DELETE /design 404、POST /design 本体 404 ──
  for (const method of ["PUT", "DELETE", "PATCH"]) {
    const r = await fetch(`${BASE}/api/projects/d3-proj/design`, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "试图篡改" }),
    });
    await r.text();
    ok(r.status === 404, `⑦ ${method} /api/projects/:id/design → 404（无编辑/删除设计书接口）`);
  }
  const postBare = await httpPost(`/api/projects/d3-proj/design`, { content: "试图绕过落稿笔" });
  ok(postBare.status === 404, "⑦ POST /api/projects/:id/design（裸路径）→ 404（唯一写口只有 /design/append）");
} finally {
  child?.kill();
  fs.rmSync(tmpBase, { recursive: true, force: true });
  // 兜底断言：无论成败，塔台 DESIGN.md 必须与开跑前逐字节一致
  if (fs.readFileSync(DESIGN_FILE, "utf8") !== designBaseline) {
    console.log("[verify] FAIL 兜底：DESIGN.md 在验证过程中被改动且未还原（塔台落稿还原失守）");
    process.exitCode = 1;
  }
}

console.log(process.exitCode ? "[verify] 存在 FAIL" : "[verify] 全部 PASS");
