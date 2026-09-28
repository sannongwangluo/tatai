// 聊天工具调用验证（2026-09-19 试用增强二期，tsx 跑）。两部分：
//   A（不调 API，确定性断言安全护栏与执行器本身）：
//     ① search_code 命中项目内文件、跳过 node_modules；② read_file 正常读、拒绝绝对路径/
//     `..` 穿越/不存在；③ get_arch 未解析空态；④ 未知工具/坏 JSON/坏项目都以可读错误回执，不抛。
//     ⑤ list_files 列清单（2026-09-19 试用反馈补：模型此前摸不到文件清单）——
//       列出真实文件、跳过 node_modules 诱饵、子目录收窄、越界形态拒绝；
//     ⑥ read_files 批量读（2026-09-19 试用反馈补：此前只能一个文件一个文件读）——
//       多文件各成段、越界路径段内注明、超 10 个拒绝、非数组拒绝。
//   B（HTTP + 本地合成网关桩，批3 T26；走隔离 TATAI_HOME 后端子进程）：
//     ⑦ 桩回 read_files 工具轮真读 src/app.ts，再把工具结果里的命中行原文回喂给终答——断言：
//       SSE 出现 tool 事件 ≥1、终答含暗记与文件名（只有真读到夹具文件才答得出，桩不编答案）；
//       ⑧ 会话读回仍恰好 user+assistant 两行——工具轮次不落盘（§2.3.6 口径不变）。
//   C（本地合成网关桩，进程内直调；2026-09-19 试用反馈：输出上限与自动续写）：
//     ⑨ 桩回 finish_reason=length 的截断流（截断被看见，不再静默）；
//     ⑩ 桩逐段吐被截断的长文 → runChatTurn 自动断点续写拼出远超单段上限的连贯全文，
//       续满仍截断时末尾如实标记。
//   T26：B/C 段**不依赖真实 DEEPSEEK_API_KEY**（调用被 TATAI_DEEPSEEK_BASE_URL 接管到本地桩）；
//   另加"拔桩阴性"——桩主动 close 后再发消息必须如实报错，不冒充成功。
// ████ 红线 ████ 本脚本把密钥与基址都钉在本地 127.0.0.1 合成桩上，绝不触真网关；
// 绝不打印密钥原文（只报是否存在）。
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { addProject } from "../src/server/registry";
import { executeChatTool, safeResolve } from "../src/server/chatTools";
import { runChatTurn } from "../src/server/chatTurn";
import { chatStreamEvents, CONTINUE_MAX } from "../src/server/flash";
import { startMockGateway, sseText, sseToolCalls, writeSse, type MockGateway } from "./lib/mockGateway";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8799;
const BASE = `http://localhost:${PORT}`;
const PROJ = "chattools-proj";
/** 文件暗记：只存在于真实文件里（背景材料/设计书都没有），模型必须用工具读到它 */
const MARKER = "蓝鲸-暗记-77";

const ok = (cond: boolean, label: string) => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (!cond) process.exitCode = 1;
};

// ████ 红线 ████ 密钥与基址都钉在本地合成桩上：本进程与子进程都不触真网关；密钥原文绝不打印。
// T26：与环境里有没有真 DEEPSEEK_API_KEY 无关——`env -u` 与假密钥两种情况下都照常走桩。
const STUB_KEY = "fixture-key-not-a-real-secret";
process.env.DEEPSEEK_API_KEY = STUB_KEY;
/** 合成桩端口：默认 0（127.0.0.1 上系统分配动态端口）。仅测试钩子可钉一个**被占**端口，制造"桩起不来"跑受阻分支。 */
const STUB_PORT = Number(process.env.TATAI_VERIFY_STUB_PORT ?? 0) || 0;

/** 读一条 SSE 响应到结束：正文 / 工具事件名 / 错误事件 / 是否 [DONE] 收尾（⑦ 与拔桩阴性共用同一解析口径） */
async function readSse(res: Response): Promise<{
  text: string;
  toolNames: string[];
  errors: string[];
  done: boolean;
}> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let text = "";
  const toolNames: string[] = [];
  const errors: string[] = [];
  let done = false;
  for (;;) {
    const { done: end, value } = await reader.read();
    if (end) break;
    buf += dec.decode(value, { stream: true });
    let sep: number;
    while ((sep = buf.indexOf("\n\n")) !== -1) {
      const event = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      for (const line of event.split("\n")) {
        const t = line.trim();
        if (t === "data: [DONE]") done = true;
        if (!t.startsWith("data: ") || t === "data: [DONE]") continue;
        const p = JSON.parse(t.slice(6)) as {
          delta?: string;
          error?: string;
          tool?: { name: string; summary: string };
        };
        if (typeof p.delta === "string") text += p.delta;
        if (typeof p.error === "string") errors.push(p.error);
        if (p.tool) toolNames.push(p.tool.name);
      }
    }
  }
  return { text, toolNames, errors, done };
}

// 临时数据目录 + 临时项目目录（不碰真实 TATAI_HOME 与真实项目）
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-chattools-verify-"));
const dataDir = path.join(tmpBase, "home");
const projDir = path.join(tmpBase, "proj");
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(path.join(projDir, "src"), { recursive: true });
fs.writeFileSync(path.join(projDir, "package.json"), '{"name":"chattools-verify-proj"}\n', "utf8");
fs.writeFileSync(
  path.join(projDir, "src", "app.ts"),
  [
    "// 临时验证文件：暗记在下一行",
    `export const SECRET = "${MARKER}";`,
    "export function hello(): string { return SECRET; }",
    "",
  ].join("\n"),
  "utf8",
);
// 依赖垃圾里的诱饵：search_code 必须跳过 node_modules
fs.mkdirSync(path.join(projDir, "node_modules", "junk-pkg"), { recursive: true });
fs.writeFileSync(
  path.join(projDir, "node_modules", "junk-pkg", "index.js"),
  `const DECOY = "${MARKER}"; // 不应被搜到\n`,
  "utf8",
);
// 项目根外的诱饵文件：read_file 的穿越形态必须够不着它
const outside = path.join(tmpBase, "外面-不该被读到.txt");
fs.writeFileSync(outside, "项目根外的内容，读到就是越界\n", "utf8");

addProject({ id: PROJ, name: "工具调用验证项目", path: projDir, kind: "backend" }, dataDir);
// 执行器里的 getProject 走默认数据目录解析（TATAI_HOME 环境变量），A 部分先指过去
process.env.TATAI_HOME = dataDir;

// ── A：安全护栏与执行器（确定性，不调 API）──────────────────────────
console.log("[verify] ── A① search_code：命中真实文件、跳过 node_modules ──");
const aSearch = executeChatTool(PROJ, "search_code", JSON.stringify({ query: MARKER }));
ok(aSearch.result.includes("src/app.ts:"), "A① 搜索命中 src/app.ts（带行号）");
ok(!aSearch.result.includes("node_modules"), "A① 搜索跳过 node_modules（诱饵未命中）");
ok(aSearch.result.includes(MARKER), "A① 命中行原文带回（含暗记）");

const aDecoy = executeChatTool(PROJ, "search_code", JSON.stringify({ query: "不该被搜到" }));
ok(aDecoy.result.includes("没有命中"), "A① 依赖垃圾里的关键字搜不到（跳过生效）");

console.log("[verify] ── A② read_file：正常读 + 穿越/绝对路径/不存在全拒绝 ──");
const aRead = executeChatTool(PROJ, "read_file", JSON.stringify({ path: "src/app.ts" }));
ok(aRead.result.includes(MARKER) && aRead.result.includes("hello"), "A② 读到真实文件内容");
const escapes = [
  path.join(tmpBase, "外面-不该被读到.txt"), // 绝对路径
  "../外面-不该被读到.txt", // 相对穿越
  "..\\外面-不该被读到.txt", // 反斜杠穿越
  "src/../../外面-不该被读到.txt", // 中段穿越
  "src/\0../..", // 空字节
];
for (const esc of escapes) {
  const r = executeChatTool(PROJ, "read_file", JSON.stringify({ path: esc }));
  ok(
    r.result.startsWith("拒绝：") || r.result.includes("文件不存在"),
    `A② 越界形态被拒：${JSON.stringify(esc)}`,
  );
  ok(!r.result.includes("项目根外的内容"), "A② 根外文件内容绝不出现在任何回执里");
}
ok(safeResolve(projDir, "src/app.ts") !== null, "A② 合法相对路径通过 safeResolve");
ok(safeResolve(projDir, "../x") === null, "A② safeResolve 拒 .. ");
ok(safeResolve(projDir, "C:\\Windows\\system.ini") === null, "A② safeResolve 拒绝对路径");
const aMissing = executeChatTool(PROJ, "read_file", JSON.stringify({ path: "不存在.ts" }));
ok(aMissing.result.includes("文件不存在"), "A② 不存在的文件如实回执");

console.log("[verify] ── A③/A④ get_arch 空态 + 错误回执不抛 ──");
const aArch = executeChatTool(PROJ, "get_arch", "{}");
ok(aArch.result.includes("还没解析过"), "A③ 未解析项目返回空态说明");
const aUnknown = executeChatTool(PROJ, "拍脑袋的工具", "{}");
ok(aUnknown.result.includes("没有这个工具"), "A④ 未知工具可读回执");
const aBadJson = executeChatTool(PROJ, "read_file", "{不是json");
ok(aBadJson.result.includes("参数不是合法 JSON"), "A④ 坏 JSON 参数可读回执");
const aBadProj = executeChatTool("不存在的项目", "read_file", '{"path":"x"}');
ok(aBadProj.result.includes("工具执行失败"), "A④ 坏项目可读回执（不抛）");

console.log("[verify] ── A⑤ list_files：清单看得见、垃圾跳过、越界拒绝 ──");
const aList = executeChatTool(PROJ, "list_files", "{}");
ok(aList.result.includes("src/app.ts"), "A⑤ 清单列出 src/app.ts（相对项目根路径）");
ok(aList.result.includes("package.json"), "A⑤ 清单列出根上 package.json");
ok(
  !aList.result.includes("junk-pkg"),
  "A⑤ 清单跳过 node_modules（诱饵文件 junk-pkg 不出现在清单里）",
);
const aListSub = executeChatTool(PROJ, "list_files", '{"path":"src"}');
ok(
  aListSub.result.includes("src/app.ts") && !aListSub.result.includes("package.json"),
  "A⑤ 子目录收窄：path=src 只列 src 下的（路径仍是项目根相对）",
);
for (const esc of ["..", "../外面", "C:\\Windows"]) {
  const r = executeChatTool(PROJ, "list_files", JSON.stringify({ path: esc }));
  ok(r.result.startsWith("拒绝："), `A⑤ list_files 越界形态被拒：${JSON.stringify(esc)}`);
}
const aListMissing = executeChatTool(PROJ, "list_files", '{"path":"没有这个目录"}');
ok(aListMissing.result.includes("目录不存在"), "A⑤ 不存在的目录如实回执");

console.log("[verify] ── A⑥ read_files：批量读 + 越界段内注明 + 上限护栏 ──");
const aBatch = executeChatTool(
  PROJ,
  "read_files",
  JSON.stringify({ paths: ["package.json", "src/app.ts", "不存在.ts", "../外面-不该被读到.txt"] }),
);
ok(
  aBatch.result.includes("===== package.json =====") && aBatch.result.includes("chattools-verify-proj"),
  "A⑥ 第 1 个文件成段读回",
);
ok(
  aBatch.result.includes("===== src/app.ts =====") && aBatch.result.includes(MARKER),
  "A⑥ 第 2 个文件成段读回（含暗记）",
);
ok(
  aBatch.result.includes("===== 不存在.ts =====") && aBatch.result.includes("文件不存在"),
  "A⑥ 读不了的文件段内注明原因（不中断整批）",
);
ok(
  !aBatch.result.includes("项目根外的内容"),
  "A⑥ 根外文件内容绝不出现在批量回执里（穿越路径段内被拒）",
);
const aBatchOver = executeChatTool(
  PROJ,
  "read_files",
  JSON.stringify({ paths: Array.from({ length: 11 }, (_, i) => `f${i}.ts`) }),
);
ok(aBatchOver.result.includes("一次最多批量读 10 个"), "A⑥ 超 10 个文件整批拒绝（提示分批）");
const aBatchNotArr = executeChatTool(PROJ, "read_files", '{"paths":"src/app.ts"}');
ok(aBatchNotArr.result.includes("paths 必须是字符串数组"), "A⑥ 非数组形态拒绝");
const aBatchEmpty = executeChatTool(PROJ, "read_files", '{"paths":[]}');
ok(aBatchEmpty.result.includes("至少要有一个"), "A⑥ 空数组拒绝");

// ── C：输出上限与自动续写（本地合成网关桩，进程内直调；不再真调、不依赖真实密钥）──────────
// T25 ③：段落受阻计数（C 的 SKIP 与下面 B 的 SKIP 都算）——收尾据此定退出码 3；有 FAIL 仍优先 1。
let skippedSections = 0;

console.log("[verify] ── C 段：本地合成网关桩（127.0.0.1:0，绝不触真网关）──");
// 第 1 通给 C⑨（一小段 + finish=length）；其后每通给 C⑩ 一段被截断的长文（逼续写循环逐段接着拼）
const C_SEG =
  "天空之所以是蓝色，是因为阳光里的短波蓝光被大气分子散射得比红光强得多——瑞利散射强度与波长四次方成反比；" +
  "太阳低垂时光线穿过更厚的大气，蓝光几乎散射殆尽、剩下红橙色的长波，这就是朝霞与晚霞的由来。";
let cStub: MockGateway | null = null;
try {
  cStub = await startMockGateway(
    (res, call) => {
      if (call.index === 0) writeSse(res, sseText("一\n二\n三\n", "length"));
      else writeSse(res, sseText(C_SEG, "length"));
    },
    { port: STUB_PORT },
  );
} catch (e) {
  skippedSections += 1;
  console.log(`[verify] SKIP C：合成网关桩未就绪（${(e as Error).message}）——C⑨/C⑩ 未跑，不计为 PASS`);
}
if (cStub !== null) {
  const cgw = cStub;
  try {
    console.log("[verify] ── C⑨ finish 事件：截断不再静默 ──");
    const finishes: (string | null)[] = [];
    let text9 = "";
    // 模型档位参数照旧传（chat + effort 空串）：本节测的是 finish=length 的截断机制与续写循环，
    // 不是思考预算语义；合成桩按帧回 length，与真上调参无关。
    for await (const ev of chatStreamEvents(
      [{ role: "user", content: "从 1 逐个数到 30，每行一个数，只输出数字，别的什么都不要。" }],
      { model: "deepseek-chat", reasoningEffort: "", maxTokens: 16, baseURL: cgw.url },
    )) {
      if (ev.type === "delta") text9 += ev.text;
      else if (ev.type === "finish") finishes.push(ev.reason);
    }
    ok(finishes.length === 1 && finishes[0] === "length", "C⑨ 合成流 finish 事件恰好一个、reason=length");
    ok(text9.trim().length > 0, "C⑨ 截断前正文照常流出");

    console.log("[verify] ── C⑩ runChatTurn 自动续写：断点接出远超单段上限的全文 ──");
    // 探针任务仍是长文写作（不点工具）：合成桩每段都回 length，逼续写循环一路接到 CONTINUE_MAX
    let full10 = "";
    let toolEvents10 = 0;
    for await (const ev of runChatTurn(
      PROJ,
      [
        { role: "system", content: "你是长文写作助手，只写正文，绝不调用任何工具。" },
        {
          role: "user",
          content:
            "写一篇 3000 字以上的科普长文《为什么天空是蓝色的》，从标题开始按顺序一路写到底，" +
            "中途绝不省略、绝不写「后文略」。",
        },
      ],
      { model: "deepseek-chat", reasoningEffort: "", maxTokens: 64, baseURL: cgw.url },
    )) {
      if (ev.type === "delta") full10 += ev.text;
      else toolEvents10++;
    }
    console.log(`[verify]   续写全文 ${full10.length} 字；工具事件 ${toolEvents10} 个；模型调用 ${cgw.calls.length} 次`);
    ok(toolEvents10 === 0, "C⑩ 纯文本路径没点工具（写作任务不碰七只手）");
    ok(
      full10.length >= 350,
      "C⑩ 续写拼出的全文远超单段上限（合成桩每段约 110 字，证明断点续上而非只发一段）",
    );
    ok(
      full10.trimEnd().endsWith("再发一句「继续」可让它接着写。）"),
      "C⑩ 续满 4 次仍截断 → 末尾如实标记（用户可再发「继续」）",
    );
    // T26 新增：续写循环确实逐轮追加（C⑨ 1 通 + C⑩ 初始 1 通 + 续写 CONTINUE_MAX 通，全打到本地桩）
    ok(
      cgw.calls.length === 1 + 1 + CONTINUE_MAX,
      `C⑩ 初始 1 + 续写 ${CONTINUE_MAX} = ${CONTINUE_MAX + 1} 次模型调用（含 C⑨ 共 ${cgw.calls.length} 次）`,
    );
  } finally {
    await cgw.close();
  }
}

// ── B：真调 E2E（HTTP + 隔离后端子进程）────────────────────────────
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

// ── B：HTTP + 本地合成网关桩（工具真执行 → 工具结果回喂 → 终答引用命中行原文）────
console.log("[verify] ── B 段：HTTP + 本地合成网关桩（127.0.0.1:0，绝不触真网关）──");
let bStub: MockGateway | null = null;
try {
  bStub = await startMockGateway(
    (res, call) => {
      if (call.index === 0) {
        // 工具轮：模型点名 read_files 读真实夹具文件（src/app.ts）
        writeSse(
          res,
          sseToolCalls([
            { id: "call_rf", name: "read_files", arguments: JSON.stringify({ paths: ["src/app.ts"] }) },
          ]),
        );
      } else {
        // 终答：只把工具真实结果里的命中行原文引出来——桩不编答案，没真读到就答不出
        const tm = call.messages.find((m) => m.role === "tool") as { content?: unknown } | undefined;
        const content = typeof tm?.content === "string" ? tm.content : "";
        const line = content.split(/\r?\n/).find((l) => l.includes(MARKER)) ?? "";
        writeSse(
          res,
          sseText(
            line === ""
              ? "未读到暗记（工具结果里没有命中行）。"
              : `找到暗记所在行：${line}（文件 src/app.ts）。该文件里 SECRET 由 hello() 引用。`,
            "stop",
          ),
        );
      }
    },
    { port: STUB_PORT },
  );
} catch (e) {
  skippedSections += 1;
  console.log(
    `[verify] SKIP B：合成网关桩未就绪（${(e as Error).message}）——B 部分未跑（A 部分已跑完），不计为 PASS，汇总不得称全绿`,
  );
}
if (bStub !== null) {
  const gw = bStub; // 非空别名（断言与 finally 里都用它，避免 TS 的空值收窄在闭包里失效）
  console.log(`[verify] 前置：模型调用接管到本地合成桩 ${gw.url}（密钥为桩内假值，原文不打印）`);
  let child: ChildProcess | undefined;
  try {
    await assertPortFree(PORT);
    const proc = spawn(
      process.execPath,
      ["--import", "tsx", path.join("src", "server", "index.ts")],
      {
        env: {
          ...process.env,
          TATAI_HOME: dataDir,
          TATAI_PORT: String(PORT),
          // 产品钩子（已核存在）：flash.ts:97-102 env>config>默认、:176 opts.baseURL??resolveBaseUrl
          TATAI_DEEPSEEK_BASE_URL: gw.url,
          // 密钥钉桩内假值：与外部环境 DEEPSEEK_API_KEY 无关（env -u 与假密钥都走桩）
          DEEPSEEK_API_KEY: STUB_KEY,
        },
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

    // ── ⑦ 只有读了真实文件才答得出 ──
    const r0 = await fetch(`${BASE}/api/projects/${PROJ}/chat/sessions`, { method: "POST" });
    const j0 = (await r0.json()) as { session_id?: string };
    if (!j0.session_id) throw new Error(`创建会话失败: ${JSON.stringify(j0)}`);
    const sid = j0.session_id;

    console.log("[verify] ── ⑦ messages（工具轮必须真读到夹具文件）──");
    const res = await fetch(`${BASE}/api/projects/${PROJ}/chat/sessions/${sid}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content:
          `用工具找出这个项目里藏着暗记「${MARKER}」的文件与行号，` +
          "引用命中行原文，并说明该文件里 SECRET 变量被谁引用。不查工具不准猜。",
      }),
    });
    ok(
      res.status === 200 && (res.headers.get("content-type") ?? "").includes("text/event-stream"),
      "⑦ POST messages → 200 + text/event-stream",
    );
    const sse = await readSse(res);
    const full = sse.text;
    console.log(`[verify]   工具事件 ${sse.toolNames.length} 个；回答（${full.length} 字）：${full.slice(0, 220)}`);
    ok(sse.errors.length === 0, "⑦ SSE 无 error 事件");
    ok(sse.toolNames.length >= 1, "⑦ SSE 出现 tool 活动事件（模型真的点了工具）");
    ok(full.includes(MARKER), "⑦ 终答含暗记（工具结果进了终答）");
    ok(full.includes("src/app.ts"), "⑦ 终答指名文件 src/app.ts");
    // ── T26 新增：role:tool 回传链路 + 工具结果确含命中行（只有真读到才答得出）──
    const round2 = gw.calls[1];
    ok(gw.calls.length === 2, `⑦ 工具轮 + 终答 = 2 次模型调用，全部打到本地桩（实际 ${gw.calls.length}）`);
    ok(
      round2 !== undefined && round2.messages.some((m) => m.role === "tool"),
      '⑦ 桩收到下一轮请求里含工具结果行（role:"tool"——工具真实回传链路通）',
    );
    const toolMsg = round2?.messages.find((m) => m.role === "tool") as { content?: unknown } | undefined;
    ok(
      typeof toolMsg?.content === "string" &&
        toolMsg.content.includes(MARKER) &&
        toolMsg.content.includes("src/app.ts"),
      "⑦ 回传的工具结果带真实命中行原文（工具真读了夹具文件，不是桩自答）",
    );

    // ── ⑧ 落盘口径：工具轮次不进 jsonl ──
    const rb = await fetch(`${BASE}/api/projects/${PROJ}/chat/sessions/${sid}`);
    const jb = (await rb.json()) as { messages?: { role: string }[] };
    const roles = (jb.messages ?? []).map((m) => m.role);
    ok(
      rb.status === 200 &&
        roles.length === 2 &&
        roles[0] === "user" &&
        roles[1] === "assistant" &&
        !roles.includes("tool") &&
        !roles.includes("system"),
      `⑧ 读回 = user+assistant 两行、无 tool/system 行（实际：${JSON.stringify(roles)}）`,
    );

    // ── 拔桩阴性（T26 新增）：桩主动 close 后发消息 → SSE/HTTP 如实报错，不冒充成功 ──
    console.log("[verify] ── 拔桩阴性：桩主动 close 后再发消息 → 如实报错（不冒充成功）──");
    const rn = await fetch(`${BASE}/api/projects/${PROJ}/chat/sessions`, { method: "POST" });
    const jn = (await rn.json()) as { session_id?: string };
    if (!jn.session_id) throw new Error(`创建会话失败: ${JSON.stringify(jn)}`);
    await gw.close(); // 主动拔桩：模型出口没了
    const negRes = await fetch(`${BASE}/api/projects/${PROJ}/chat/sessions/${jn.session_id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "拔桩后随便问一句，看它怎么收场。" }),
    });
    const neg = await readSse(negRes);
    console.log(`[verify]   拔桩后：error 事件 ${neg.errors.length} 个；错误原文：${neg.errors[0] ?? "(无)"}`);
    ok(neg.errors.length >= 1, "拔桩阴性：桩没了 → SSE 出现 error 事件（如实报错，不沉默、不假绿）");
    ok(!neg.done, "拔桩阴性：没有 data: [DONE]（不冒充成功收尾）");
    ok(neg.text.trim() === "", "拔桩阴性：没有伪造正文冒充成功回答");
  } finally {
    if (child && !child.killed) child.kill();
    await new Promise((r) => setTimeout(r, 300));
    await gw.close();
  }
}
try {
  fs.rmSync(tmpBase, { recursive: true, force: true });
} catch {
  /* Windows 下文件偶被占用，残留 tmp 目录无害 */
}
// T25 ③：收尾结论行 + 退出码（照 scripts/lib/fixtures.ts finish() 口径）：
// 有 FAIL → 1 优先（SKIP 不吞 A 部分真实 FAIL）；无 FAIL 但有段落 SKIP（含上面的 SKIP C）→ 3（没跑全）；全跑全过 → 0。
if (process.exitCode === 1) {
  console.log("[verify] 结果: FAIL（上面有 FAIL 行）");
} else if (skippedSections > 0) {
  console.log(`[verify] 结果: 没跑全（${skippedSections} 段 SKIP，见上面 SKIP 行）——退出码 3，别当全过`);
  process.exitCode = 3;
} else {
  console.log("[verify] 结果: 全部 PASS");
}
console.log("[verify] done");
