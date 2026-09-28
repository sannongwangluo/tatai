// 聊天补全架构图验证（2026-09-19 试用增强三期，tsx 跑）。核心口径：**补全层与解析层分层**。
//   A（确定性，不调 API，直接跑执行器）：① append 写入带 chat: 前缀落盘；② 重复 id 跳过；
//   ③ 无效端点边丢弃、裸名端点自动补前缀；④ 容量上限拒绝不截断；⑤ replace 空集 = 清空；
//   ⑥ check_arch 机械对账（四期补，仍不调 API）：悬空 path / 同 path 重复 / 目录树嫌疑
//     三类清单逐条列出，全干净时总结行含「图与代码对齐」。
//   B（HTTP + 本地合成网关桩，批3 T26）：⑥ POST arch/parse 出解析层 → 桩回 write_arch 工具轮
//     （真实模块 id → 补全概念节点）、工具真执行后桩回终答 → GET arch/render 里该节点带
//     origin:"chat" 且有连边；⑦ **再解析一次（幂等覆盖）补全仍在**——这是"解析层唯一写口不被破"
//     的对账点；⑧ replace 空集删被引用的补全概念 → 整次拒绝、原件不动（批2 T11 守卫，R1-ZS-003
//     口径）；⑨ 会话落盘两行；另加"拔桩阴性"——桩主动 close 后再发消息必须如实报错、不冒充成功。
//     T26 起 B 段**不依赖真实 DEEPSEEK_API_KEY**：调用被 TATAI_DEEPSEEK_BASE_URL 接管到本地桩。
// ████ 红线 ████ 本脚本把密钥与基址都钉在本地 127.0.0.1 合成桩上，绝不触真网关；
// 绝不打印密钥原文（只报是否存在）。
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { addProject } from "../src/server/registry";
import { executeChatTool } from "../src/server/chatTools";
import { buildChatContext } from "../src/server/chatContext";
import { parseProject } from "../src/arch/parse";
import { readSupplement } from "../src/arch/supplement";
import { startMockGateway, sseText, sseToolCalls, writeSse, type MockGateway } from "./lib/mockGateway";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8801;
const BASE = `http://localhost:${PORT}`;
const PROJ = "chatarch-proj";

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

// 临时数据目录 + 临时项目（不碰真实 TATAI_HOME 与真实项目）
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-chatarch-verify-"));
const dataDir = path.join(tmpBase, "home");
const projDir = path.join(tmpBase, "proj");
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(path.join(projDir, "src"), { recursive: true });
fs.writeFileSync(path.join(projDir, "package.json"), '{"name":"chatarch-verify-proj"}\n', "utf8");
fs.writeFileSync(
  path.join(projDir, "src", "main.ts"),
  ['import { util } from "./util";', "export function main(): string { return util(); }", ""].join("\n"),
  "utf8",
);
fs.writeFileSync(
  path.join(projDir, "src", "util.ts"),
  ['export function util(): string { return "u"; }', ""].join("\n"),
  "utf8",
);
addProject({ id: PROJ, name: "补全架构验证项目", path: projDir, kind: "backend" }, dataDir);
process.env.TATAI_HOME = dataDir; // 执行器/读口走默认数据目录解析，指到临时 home

// ── A：执行器确定性断言（项目未解析，走 parsed:false 分支）──────────
console.log("[verify] ── A⓪ 背景能力清单：每条消息都重申四只手（旧会话自愈补丁）──");
const ctx = buildChatContext(PROJ);
ok(
  ctx.includes("write_arch") && ctx.includes("以本清单为准"),
  "A⓪ 聊天背景明示 write_arch 能力且声明以清单为准（压住历史里的旧否认）",
);
// 2026-09-19 试用反馈（工具轮次预算 + 落稿流程指引）：模型撞轮次上限后干问「写到哪个文件」，
// 因为没人告诉它设计书走落稿按钮、它没有写设计书的工具——这两句就是教它正确动作
ok(
  ctx.includes("设计书（design.md）不是你写的") && ctx.includes("点「落稿」按钮"),
  "A⓪ 背景明示落稿流程（被要求改设计书时直接产出条目，不问写到哪个文件）",
);
ok(
  ctx.includes("约 20 轮") && ctx.includes("不要重读"),
  "A⓪ 背景明示轮次预算口径（撞顶后用户发「继续」接着干、新一轮不重读）",
);
// 四期补：三视图核对口径（check_arch 先行 / 概念节点才进补全层 / 不重建目录树）
ok(
  ctx.includes("check_arch") &&
    ctx.includes("对得上") &&
    ctx.includes("不要把目录树/文件清单重建进补全层") &&
    ctx.includes("先用 check_arch 拿机器对账清单"),
  "A⓪ 背景明示三视图核对口径（机器对账先行、补全层只装概念节点）",
);

console.log("[verify] ── A① append 写入：chat: 前缀 + 落盘 ──");
const a1 = executeChatTool(
  PROJ,
  "write_arch",
  JSON.stringify({ nodes: [{ id: "bus", name: "消息总线", blurb: "验证补全" }] }),
);
// 回执形态（四期排版）：首行人话对账单，末行 "receipt:{...}" 单行 JSON——只取末行对象
ok(
  /^补全层写入回执（mode=append）：\+1 节点 \+0 边，总计 1 节点 0 边$/m.test(a1.result),
  "A① 回执首行是人话对账单（mode/新增/总计）",
);
const m1 = /receipt:(\{[^\n]*\})/.exec(a1.result);
const r1 = JSON.parse(m1 ? m1[1] : "{}") as {
  added_nodes: number;
  parsed: boolean;
  total_nodes: number;
};
ok(r1.added_nodes === 1 && r1.total_nodes === 1, "A① 回执：加 1 节点、共 1 节点");
ok(r1.parsed === false, "A① 未解析项目回执 parsed=false（如实说补全要先解析才显示）");
const sup1 = readSupplement(PROJ);
ok(sup1 !== null && sup1.nodes[0]?.id === "chat:bus", "A① 落盘 id 自动补 chat: 前缀");

console.log("[verify] ── A② 重复 id 跳过（含逐条明细）──");
const a2 = executeChatTool(PROJ, "write_arch", JSON.stringify({ nodes: [{ id: "bus", name: "消息总线" }] }));
ok(a2.result.includes('"skipped_duplicate_nodes":1'), "A② 重复 id 计数跳过（不覆盖不报错）");
ok(
  a2.result.includes("- 跳过：想建 chat:bus(消息总线) 与已有 chat:bus(消息总线) 重复：id 相同｜name 相同"),
  "A② 重复明细逐条列出（写明已有节点 id 与撞上的口径）",
);

console.log("[verify] ── A③ 边端点：无效丢弃 / 裸名自动补前缀 / 相近节点建议 ──");
const a3 = executeChatTool(
  PROJ,
  "write_arch",
  JSON.stringify({
    nodes: [{ id: "gateway", name: "网关" }],
    edges: [
      { from: "bus", to: "gateway", note: "裸名引用补全节点" },
      { from: "bus", to: "不存在的模块", note: "应被丢弃" },
      { from: "chat:bus", to: "chat:bus", note: "自环应被丢弃" },
      { from: "gateway", to: "gatewa", note: "拼错端点应给相近建议" },
    ],
  }),
);
ok(a3.result.includes('"added_edges":1'), "A③ 裸名端点自动补前缀，合法边加入");
ok(a3.result.includes('"dropped_invalid_edges":3'), "A③ 无效端点边/自环边/拼错端点边丢弃计数");
ok(
  a3.result.includes("- 丢弃：边 chat:bus→不存在的模块 丢弃：端点 不存在的模块 不存在"),
  "A③ 丢弃明细逐条列出（端点不存在如实写明）",
);
ok(
  a3.result.includes("端点 gatewa 不存在。相近节点：chat:gateway"),
  "A③ 拼错端点给相近节点建议（帮模型自己改对）",
);

console.log("[verify] ── A④ 容量上限：拒绝不截断 ──");
const many = Array.from({ length: 150 }, (_, i) => ({ id: `n${i}`, name: `节点${i}` }));
const a4 = executeChatTool(PROJ, "write_arch", JSON.stringify({ nodes: many }));
ok(a4.result.includes('"capped":true'), "A④ 超上限回执 capped=true");
ok(a4.result.includes('"total_nodes":100'), "A④ 补全层封顶 100 个（不静默继续）");

console.log("[verify] ── A⑤ replace 空集：被引用则整次拒绝（批2 T11 守卫，R1-ZS-003 口径）──");
const a5Before = readSupplement(PROJ);
const a5 = executeChatTool(PROJ, "write_arch", JSON.stringify({ nodes: [], edges: [], mode: "replace" }));
// 旧断言"replace 空集清空补全层"断的是判词已判死的旧行为（R1-ZS-003：被引用概念可被连带清删）；
// 现口径＝A③ 已写入有效边 chat:bus→chat:gateway，replace 空集要删这两个节点 → 写前核引用、整次拒绝、原件不动
ok(
  a5.result.includes("被引用的补全概念不能经 replace 移除") && a5.result.includes("chat:bus"),
  "A⑤ replace 空集删被引用概念 → 拒绝并点名被引用 ID",
);
ok(a5.result.includes("变更记录路径"), "A⑤ 拒绝回执指明正式删除须走变更记录路径");
const a5After = readSupplement(PROJ);
ok(
  a5After !== null &&
    a5Before !== null &&
    a5After.nodes.length === a5Before.nodes.length &&
    a5After.edges.length === a5Before.edges.length,
  "A⑤ 整次拒绝后原件不动（节点/边数与写前一致）",
);

// ── A⑥/A⑦ check_arch 机械对账（不调 API；四期补的第七只只读手）──────────────────
console.log("[verify] ── A⑥ check_arch：悬空 / 重复 / 目录树嫌疑三类清单 ──");
parseProject(PROJ, dataDir); // 解析层就位（B 部分 HTTP 还会幂等再解析一次，不冲突）
// src/sub 建在解析**之后**：解析层模块不含它，补全节点指它就是纯"目录树嫌疑"不是新模块
fs.mkdirSync(path.join(projDir, "src", "sub"), { recursive: true });
fs.writeFileSync(path.join(projDir, "src", "sub", "deep.ts"), "export const deep = 1;\n", "utf8");
// 夹具直写 supplement.json（check_arch 是读侧审计，直写磁盘最贴近真实脏数据形态）
const supFile = path.join(projDir, ".工作台", "arch", "supplement.json");
fs.mkdirSync(path.dirname(supFile), { recursive: true });
fs.writeFileSync(
  supFile,
  JSON.stringify(
    {
      version: 1,
      updated_at: new Date().toISOString(),
      nodes: [
        { id: "chat:ghost", name: "幽灵目录", blurb: "", kind: "mixed", path: "no-such-dir" },
        { id: "chat:twinA", name: "双胞胎甲", blurb: "", kind: "mixed", path: "also-missing" },
        { id: "chat:twinB", name: "双胞胎乙", blurb: "", kind: "mixed", path: "also-missing" },
        { id: "chat:sub", name: "src 子目录", blurb: "", kind: "mixed", path: "src/sub" },
      ],
      edges: [],
    },
    null,
    2,
  ),
  "utf8",
);
const a6 = executeChatTool(PROJ, "check_arch", "{}");
ok(a6.result.includes("悬空 path（图上节点 path 磁盘不存在）"), "A⑥ 悬空 path 有小标题与口径说明");
ok(
  a6.result.includes("chat:ghost") && a6.result.includes("path=no-such-dir"),
  "A⑥ 补全节点 path 指向不存在目录 → 列出悬空",
);
ok(
  a6.result.includes("chat:twinA") && a6.result.includes("chat:twinB") && a6.result.includes("同 path=also-missing"),
  "A⑥ 两个不同 id 同 path → 列出重复（组员 id+origin+path）",
);
ok(
  a6.result.includes("chat:sub") && a6.result.includes("与解析层模块 src 的目录树重叠"),
  "A⑥ 补全节点 path=解析层模块子目录 → 列出目录树嫌疑",
);
ok(!a6.result.includes("图与代码对齐"), "A⑥ 有问题时总结行不写「对齐」");
ok(
  a6.summary === "架构对账：悬空 3/重复 1/目录树嫌疑 1",
  `A⑥ summary 计数（实际：${a6.summary}）`,
);
const aUnknown6 = executeChatTool(PROJ, "拍脑袋的工具", "{}");
ok(
  aUnknown6.result.includes("check_arch"),
  "A⑥ 未知工具回执的可用清单含 check_arch（七只手同步）",
);

console.log("[verify] ── A⑦ check_arch：全干净 → 图与代码对齐 ──");
executeChatTool(PROJ, "write_arch", JSON.stringify({ nodes: [], edges: [], mode: "replace" }));
const a7 = executeChatTool(PROJ, "check_arch", "{}");
ok(a7.result.includes("图与代码对齐"), "A⑦ 三类全空 → 总结行明确写「图与代码对齐」");
ok(
  a7.summary === "架构对账：悬空 0/重复 0/目录树嫌疑 0",
  `A⑦ summary 计数全零（实际：${a7.summary}）`,
);

// ── B：HTTP + 真调（先解析出底图，再让模型补全，再验证"重新解析冲不掉"）────
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
    const why = (await portListening(port)) ? `端口 ${port} 被占用` : `后端进程提前退出（code=${code}）`;
    console.error(`[verify] 后端起不来：${why}`);
    process.exit(1);
  });
}

/** GET /arch/render 的节点/边摘要（合并补全层后的三视图共用数据） */
async function renderSummary(): Promise<{
  nodes: { id: string; name?: string; origin?: string }[];
  edges: { from: string; to: string }[];
}> {
  const r = await fetch(`${BASE}/api/projects/${PROJ}/arch/render`);
  const j = (await r.json()) as {
    render?: {
      graph?: {
        nodes: { id: string; name?: string; origin?: string }[];
        edges: { from: string; to: string }[];
      };
    };
  };
  return { nodes: j.render?.graph?.nodes ?? [], edges: j.render?.graph?.edges ?? [] };
}

/** 读一条 SSE 响应到结束：正文 / 工具事件名 / 错误事件 / 是否 [DONE] 收尾（⑥ 与拔桩阴性共用同一解析口径） */
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

// T25 ③：段落受阻＝打可解析 SKIP 行并计数（收尾据此定退出码 3），消除"FAIL 文本 + exit 0"的混合态。
// T26：B 段改用本地合成网关桩，不再依赖真实 DEEPSEEK_API_KEY；SKIP 只剩"桩起不来"这一种受阻态。
let skippedSections = 0;

console.log("[verify] ── B 段：HTTP + 本地合成网关桩（127.0.0.1:0，绝不触真网关）──");
// 桩要写进 write_arch 的"真实模块 id"：POST arch/parse 后从渲染数据取出，写进闭包变量供桩读
let realModuleId = "";
let stub: MockGateway | null = null;
try {
  stub = await startMockGateway(
    (res, call) => {
      if (call.index === 0) {
        // 工具轮：模型点名 write_arch（补一个概念节点 + 一条 真实模块 → 补全节点 的边）
        const args = JSON.stringify({
          nodes: [{ id: "bus", name: "消息总线", blurb: "聊天补全验证节点" }],
          edges:
            realModuleId === ""
              ? []
              : [{ from: realModuleId, to: "bus", note: "合成桩：真实模块依赖消息总线" }],
        });
        writeSse(res, sseToolCalls([{ id: "call_w_arch", name: "write_arch", arguments: args }]));
      } else {
        writeSse(res, sseText("已用 write_arch 补入概念节点「消息总线」并连了一条边，回执数字见工具结果。", "stop"));
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
if (stub !== null) {
  const gw = stub; // 非空别名（断言与 finally 里都用它，避免 TS 的空值收窄在闭包里失效）
  console.log(`[verify] 前置：模型调用接管到本地合成桩 ${gw.url}（密钥为桩内假值，原文不打印）`);
  let child: ChildProcess | undefined;
  try {
    await assertPortFree(PORT);
    const proc = spawn(process.execPath, ["--import", "tsx", path.join("src", "server", "index.ts")], {
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
    });
    child = proc;
    proc.stderr?.on("data", (d: Buffer) => process.stderr.write(`[server] ${d}`));
    watchChild(proc, PORT, () => upPorts.has(PORT));
    await waitUp();
    upPorts.add(PORT);
    console.log(`[verify] server up at ${BASE}（TATAI_HOME=${dataDir}）`);

    // ── ⑥ 先解析出底图，再让模型补全 ──
    const pr = await fetch(`${BASE}/api/projects/${PROJ}/arch/parse`, { method: "POST" });
    ok(pr.status === 200, "⑥ POST arch/parse → 200（解析层就位）");
    const before = await renderSummary();
    const parsedIds = before.nodes.map((n) => n.id).filter((id) => !id.startsWith("chat:"));
    ok(parsedIds.length > 0, `⑥ 解析层有模块（${parsedIds.join("、")}）`);
    realModuleId = parsedIds[0] ?? ""; // 桩写边时用：从解析结果取真实模块 id（不是桩编的）

    const r0 = await fetch(`${BASE}/api/projects/${PROJ}/chat/sessions`, { method: "POST" });
    const j0 = (await r0.json()) as { session_id?: string };
    if (!j0.session_id) throw new Error(`创建会话失败: ${JSON.stringify(j0)}`);
    const sid = j0.session_id;
    const res = await fetch(`${BASE}/api/projects/${PROJ}/chat/sessions/${sid}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content:
          "用 write_arch 给架构图补一个概念节点：name=「消息总线」，blurb 写「聊天补全验证节点」，" +
          "再补一条从真实解析模块指向它的边（from 用真实模块 id，to 指向消息总线）。做完简述回执数字。",
      }),
    });
    ok(res.status === 200, "⑥ POST messages → 200");
    const sse = await readSse(res);
    const full = sse.text;
    const writeArchEvents = sse.toolNames.filter((n) => n === "write_arch").length;
    console.log(`[verify]   write_arch 事件 ${writeArchEvents} 个；回答（${full.length} 字）：${full.slice(0, 160)}`);
    ok(sse.errors.length === 0, "⑥ SSE 无 error 事件");
    ok(writeArchEvents >= 1, "⑥ 模型真的调了 write_arch");
    // ── T26 新增：role:tool 回传链路（工具真实结果作为 tool 行回喂下一轮请求）──
    const round2 = gw.calls[1];
    ok(gw.calls.length === 2, `⑥ 工具轮 + 终答 = 2 次模型调用，全部打到本地桩（实际 ${gw.calls.length}）`);
    ok(
      round2 !== undefined && round2.messages.some((m) => m.role === "tool"),
      '⑥ 桩收到下一轮请求里含工具结果行（role:"tool"——工具真实回传链路通）',
    );
    const toolMsg = round2?.messages.find((m) => m.role === "tool") as { content?: unknown } | undefined;
    ok(
      typeof toolMsg?.content === "string" && toolMsg.content.includes('"added_nodes":1'),
      "⑥ 回传的工具结果确为 write_arch 真实回执（added_nodes=1，工具真执行过）",
    );

    const after = await renderSummary();
    const chatNodes = after.nodes.filter((n) => n.origin === "chat");
    ok(chatNodes.some((n) => n.name === "消息总线"), "⑥ 渲染里出现「消息总线」且带 origin:chat");
    ok(
      after.edges.some((e) => e.to.startsWith("chat:") && parsedIds.includes(e.from)),
      "⑥ 渲染里有「真实模块 → 补全节点」的边",
    );

    // ── ⑦ 重新解析（幂等覆盖解析层）：补全必须还在 ──
    const pr2 = await fetch(`${BASE}/api/projects/${PROJ}/arch/parse`, { method: "POST" });
    ok(pr2.status === 200, "⑦ 再次 POST arch/parse → 200");
    const survived = await renderSummary();
    ok(
      survived.nodes.some((n) => n.origin === "chat" && n.name === "消息总线"),
      "⑦ 重新解析后补全节点仍在（解析层唯一写口不被破，两层互不冲掉）",
    );

    // ── ⑧ replace 空集删被引用的补全概念 → 整次拒绝、原件不动（批2 T11 守卫，R1-ZS-003 口径）──
    //    旧断言"replace 空集清空补全层"断的是判词已判死的旧行为（R1-ZS-003：被引用概念可被连带清删）；
    //    ⑥ 已写入补全节点且带有效边，replace 空集要删它 → 写前核引用、整次拒绝、原件不动
    //    （正式删除须走变更记录路径，当前代码未实现——拒绝回执如实说明，不伪造已实现）。
    const before8 = await renderSummary();
    const rep8 = executeChatTool(PROJ, "write_arch", JSON.stringify({ nodes: [], edges: [], mode: "replace" }));
    ok(rep8.result.includes("被引用的补全概念不能经 replace 移除"), "⑧ replace 空集删被引用概念 → 拒绝（守卫口径原文）");
    ok(/chat:[^\s（(]+/.test(rep8.result), "⑧ 拒绝回执点名被引用的补全 ID");
    ok(rep8.result.includes("变更记录路径"), "⑧ 拒绝回执指明正式删除须走变更记录路径");
    const after8 = await renderSummary();
    const chatIds8 = (s: { nodes: { id: string; origin?: string }[] }): string[] =>
      s.nodes
        .filter((n) => n.origin === "chat")
        .map((n) => n.id)
        .sort();
    ok(
      chatIds8(after8).length > 0 && JSON.stringify(chatIds8(before8)) === JSON.stringify(chatIds8(after8)),
      "⑧ 整次拒绝后补全层原件不动（chat 节点集合与写前一致，且非空）",
    );

    // ── ⑨ 落盘口径 ──
    const rb = await fetch(`${BASE}/api/projects/${PROJ}/chat/sessions/${sid}`);
    const jb = (await rb.json()) as { messages?: { role: string }[] };
    const roles = (jb.messages ?? []).map((m) => m.role);
    ok(
      rb.status === 200 && roles.length === 2 && roles[0] === "user" && roles[1] === "assistant",
      `⑨ 读回 = user+assistant 两行（实际：${JSON.stringify(roles)}）`,
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
// 有 FAIL → 1 优先（SKIP 不吞 A 部分真实 FAIL）；无 FAIL 但有段落 SKIP → 3（没跑全）；全跑全过 → 0。
if (process.exitCode === 1) {
  console.log("[verify] 结果: FAIL（上面有 FAIL 行）");
} else if (skippedSections > 0) {
  console.log(`[verify] 结果: 没跑全（${skippedSections} 段 SKIP，见上面 SKIP 行）——退出码 3，别当全过`);
  process.exitCode = 3;
} else {
  console.log("[verify] 结果: 全部 PASS");
}
console.log("[verify] done");
