// 聊天续写/网关夹具验证（批2 T16，tsx 跑）。判词 R20260920-1 §三⑥ 口径：用确定性的
// **合成流/网关夹具**验证 `finish_reason=length`、自动续写次数、到上限提示、失败处理和写动作
// 不重复；**不得把断言改成"无 length 也通过"**来消除两红。
//
// 机制（与产品路径同一份消费代码，只换上游）：本脚本在 127.0.0.1 上起一个 SSE 桩
// （`POST /v1/chat/completions`）当"模型网关"，由 `runChatTurn` 的既有验证钩子 `opts.baseURL`
// 指过去——被断言的仍是 flash.ts#chatStreamEvents 的 finish 事件与 chatTurn.ts#runChatTurn 的
// 续写循环本身。夹具只替换"上游吐什么"，确定性、零真网关、零网速依赖，可复跑。
//
// 覆盖（与判词⑥逐点对应，标签即原文）：
//   ① finish_reason=length 触发自动续写；② 续写次数累积到上限；
//   ③ 到上限仍截断 → 末尾如实提示；④ 中途失败处理（不吞错、不假成功）；
//   ⑤ 续写回合中写动作（write_arch）不重复执行（幂等）。
// ████ 红线 ████ 本进程把密钥与基址都钉在本地 127.0.0.1 桩上，绝不触真网关；绝不打印密钥原文。
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { addProject } from "../src/server/registry";
import { readSupplement } from "../src/arch/supplement";
import { executeChatTool } from "../src/server/chatTools";
import { runChatTurn, type ChatTurnReceipt } from "../src/server/chatTurn";
import {
  CONTINUE_MAX,
  CONTINUE_PROMPT,
  TRUNCATED_TAIL,
  type FlashRoundMessage,
} from "../src/server/flash";
import { clearCheckpoint } from "../src/server/work/context";

const PROJ = "chat-continue-proj";

const ok = (cond: boolean, label: string) => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (!cond) process.exitCode = 1;
};

// ── 密钥与基址钉在本地桩：任何代码路径都不会走真网关（本进程内覆盖，不打印、不外传原始密钥）──
process.env.DEEPSEEK_API_KEY = "fixture-key-not-a-real-secret";
const useGateway = (url: string): void => {
  process.env.TATAI_DEEPSEEK_BASE_URL = url;
};

// 临时数据目录 + 临时项目（不碰真实 TATAI_HOME 与真实项目）
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-chat-continue-verify-"));
const dataDir = path.join(tmpBase, "home");
const projDir = path.join(tmpBase, "proj");
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(path.join(projDir, "src"), { recursive: true });
fs.writeFileSync(path.join(projDir, "package.json"), '{"name":"chat-continue-verify-proj"}\n', "utf8");
fs.writeFileSync(
  path.join(projDir, "src", "app.ts"),
  ['export function hello(): string { return "hi"; }', ""].join("\n"),
  "utf8",
);
addProject({ id: PROJ, name: "续写夹具验证项目", path: projDir, kind: "backend" }, dataDir);
process.env.TATAI_HOME = dataDir; // 执行器/检查点走默认数据目录解析，指到临时 home

// ── 合成网关夹具（本地 SSE 桩，不依赖真网关）──────────────────────────────

interface MockCall {
  /** 第几次模型调用（0 起） */
  index: number;
  path: string;
  body: Record<string, unknown>;
  messages: FlashRoundMessage[];
}
type MockHandler = (res: http.ServerResponse, call: MockCall) => void;
interface MockGateway {
  url: string;
  calls: MockCall[];
  close: () => Promise<void>;
}

/** 起一个 SSE 桩；每次请求交 handler 写响应（可流式可掐断）。监听端口 0 由系统分配。 */
function startMockGateway(handler: MockHandler): Promise<MockGateway> {
  const calls: MockCall[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d: Buffer) => (raw += d.toString("utf8")));
    req.on("end", () => {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        body = {}; // 夹具不在意坏 JSON
      }
      const messages = Array.isArray(body.messages) ? (body.messages as FlashRoundMessage[]) : [];
      const call: MockCall = { index: calls.length, path: req.url ?? "", body, messages };
      calls.push(call);
      handler(res, call);
    });
  });
  return new Promise<MockGateway>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        calls,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

const SSE_HEADERS = { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" };
const sseFrame = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;
/** 一段纯文本流：正文增量 + finish_reason + [DONE]（OpenAI 兼容 SSE 形态） */
const sseText = (text: string, finish: string): string =>
  sseFrame({ choices: [{ delta: { content: text }, finish_reason: null }] }) +
  sseFrame({ choices: [{ delta: {}, finish_reason: finish }] }) +
  "data: [DONE]\n\n";
const writeSse = (res: http.ServerResponse, payload: string): void => {
  res.writeHead(200, SSE_HEADERS);
  res.end(payload);
};

interface TurnRun {
  text: string;
  toolEvents: { name: string; summary: string }[];
  toolResults: { name: string; summary: string; writes: { path: string; affected_ids: string[] }[] }[];
  receipt: ChatTurnReceipt | null;
  error: Error | null;
}

/** 跑一轮 runChatTurn，收集全文/工具事件/回执/异常（异常不吞，交断言判定） */
async function runTurn(
  messages: FlashRoundMessage[],
  opts: { model: string; baseURL: string },
): Promise<TurnRun> {
  let text = "";
  const toolEvents: { name: string; summary: string }[] = [];
  const toolResults: TurnRun["toolResults"] = [];
  let receipt: ChatTurnReceipt | null = null;
  let error: Error | null = null;
  try {
    for await (const ev of runChatTurn(PROJ, messages, {
      model: opts.model,
      baseURL: opts.baseURL,
      onReceipt: (r) => {
        receipt = r;
      },
      onToolResult: (t) => {
        toolResults.push(t);
      },
    })) {
      if (ev.type === "delta") text += ev.text;
      else toolEvents.push({ name: ev.name, summary: ev.summary });
    }
  } catch (e) {
    error = e as Error;
  }
  return { text, toolEvents, toolResults, receipt, error };
}

/** 全新的一轮消息（runChatTurn 会就地增删，故每次现造） */
const baseMessages = (): FlashRoundMessage[] => [
  { role: "system", content: "夹具：你是长文写作助手，只输出正文，绝不调用任何工具。" },
  { role: "user", content: "写一段长文。" },
];

/** 请求里带续写指令的消息条数（随续写轮次累积） */
const countContinuePrompt = (messages: FlashRoundMessage[]): number =>
  messages.filter((m) => {
    const c = (m as { content?: unknown }).content;
    return typeof c === "string" && c.includes(CONTINUE_PROMPT);
  }).length;

async function main(): Promise<void> {
  // ── ① finish_reason=length 触发自动续写 ──────────────────────────────
  console.log("[verify] ── ① finish_reason=length 触发自动续写（合成流：首段 length、次段 stop）──");
  {
    const gw = await startMockGateway((res, call) => {
      if (call.index === 0) writeSse(res, sseText("第一段正文。", "length"));
      else if (call.index === 1) writeSse(res, sseText("第二段续写。", "stop"));
      else writeSse(res, sseText("（不该发生的多余调用）", "stop"));
    });
    useGateway(gw.url);
    clearCheckpoint(PROJ);
    const r = await runTurn(baseMessages(), { model: "synthetic", baseURL: gw.url });
    console.log(`[verify]   模型调用 ${gw.calls.length} 次；全文 ${r.text.length} 字`);
    ok(r.error === null, "① 收尾正常（无异常）");
    ok(gw.calls.length === 2, `① 截断恰好触发一次续写（模型调用 2 次，实际 ${gw.calls.length}）`);
    ok(
      r.text.includes("第一段正文。") &&
        r.text.includes("第二段续写。") &&
        r.text.indexOf("第一段正文。") < r.text.indexOf("第二段续写。"),
      "① 两段按序拼成连贯全文（续写内容进了正文）",
    );
    ok(gw.calls[1]?.messages.some((m) => m.role === "assistant" && m.content === "第一段正文。") ?? false,
      "① 已出的半截作为 assistant 行回喂（断点续写，不重头）",
    );
    ok(countContinuePrompt(gw.calls[1]?.messages ?? []) === 1, "① 续写请求恰好带 1 条续写指令（CONTINUE_PROMPT）");
    ok(!r.text.includes(TRUNCATED_TAIL), "① 自然收尾（stop）不加截断尾标");
    ok(r.toolEvents.length === 0, "① 纯文本路径没点工具");
    ok(r.receipt !== null && r.receipt.interrupted === false, "① 正常收尾，回执 interrupted=false");
    await gw.close();
  }

  // ── ② 续写次数累积到上限　③ 到上限如实提示 ──────────────────────────
  console.log(`[verify] ── ②③ 续写次数累积到上限（CONTINUE_MAX=${CONTINUE_MAX}）＋续满如实提示 ──`);
  {
    const gw = await startMockGateway((res, call) => writeSse(res, sseText(`续${call.index}。`, "length")));
    useGateway(gw.url);
    clearCheckpoint(PROJ);
    const r = await runTurn(baseMessages(), { model: "synthetic", baseURL: gw.url });
    const prompts = gw.calls.map((c) => countContinuePrompt(c.messages));
    const segments = Array.from({ length: CONTINUE_MAX + 1 }, (_, i) => `续${i}。`).join("");
    console.log(`[verify]   模型调用 ${gw.calls.length} 次；续写指令逐轮 [${prompts.join(", ")}]；全文 ${r.text.length} 字`);
    ok(r.error === null, "② 每轮都收尾正常（无异常）");
    ok(
      gw.calls.length === CONTINUE_MAX + 1,
      `② 续写次数累积到上限（初始 1 + 续写 ${CONTINUE_MAX} = ${CONTINUE_MAX + 1} 次调用，实际 ${gw.calls.length}）`,
    );
    ok(
      prompts.length === CONTINUE_MAX + 1 && prompts.every((n, i) => n === i),
      `② 续写指令数逐轮累加（0…${CONTINUE_MAX}，实际 [${prompts.join(",")}]）`,
    );
    ok(r.text.includes(segments), "② 每轮半截都拼进全文（断点续写不丢字）");
    ok(r.text.includes(TRUNCATED_TAIL), "③ 续满仍截断 → 用 flash.ts#TRUNCATED_TAIL 原文如实提示");
    ok(
      r.text.trimEnd().endsWith("再发一句「继续」可让它接着写。）"),
      "③ 截断尾标落在全文末尾（用户再发「继续」可手动接着要）",
    );
    await gw.close();
  }

  // ── ④ 中途失败处理：HTTP 5xx 与流中途掐断都不吞错、不假成功 ─────────────
  console.log("[verify] ── ④a 上游 HTTP 500 → 如实抛错、留检查点（不吞、不假成功）──");
  {
    const gw = await startMockGateway((res) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "夹具：上游 500" } }));
    });
    useGateway(gw.url);
    clearCheckpoint(PROJ);
    const r = await runTurn(baseMessages(), { model: "synthetic", baseURL: gw.url });
    console.log(`[verify]   抛出错误：${r.error?.message ?? "(无)"}`);
    ok(r.error !== null, "④a HTTP 500 → 如实抛出（不吞错）");
    ok((r.error?.message ?? "").includes("500"), "④a 错误消息带 HTTP 状态码（可定位上游）");
    ok(r.receipt !== null && r.receipt.interrupted === true, "④a 中断留检查点，回执 interrupted=true（不假成功）");
    ok(!r.text.includes(TRUNCATED_TAIL), "④a 失败不当成功收尾（不出现截断尾标）");
    await gw.close();
  }
  console.log("[verify] ── ④b 流中途掐断 → 如实抛错、留检查点（不吞、不假成功）──");
  {
    const gw = await startMockGateway((res) => {
      res.writeHead(200, SSE_HEADERS);
      res.write(sseFrame({ choices: [{ delta: { content: "半截正文……" }, finish_reason: null }] }));
      setTimeout(() => res.destroy(), 50); // 不写 [DONE] 直接掐断连接
    });
    useGateway(gw.url);
    clearCheckpoint(PROJ);
    const r = await runTurn(baseMessages(), { model: "synthetic", baseURL: gw.url });
    console.log(`[verify]   抛出错误：${r.error?.message ?? "(无)"}`);
    ok(r.error !== null, "④b 流中途掐断 → 如实抛出（不吞错）");
    ok((r.error?.message ?? "").includes("Flash API"), "④b 错误来自 Flash 客户端（带可读原因）");
    ok(r.receipt !== null && r.receipt.interrupted === true, "④b 流中断也留检查点，回执 interrupted=true（不假成功）");
    await gw.close();
  }

  // ── ⑤ 续写回合中写动作不重复执行（幂等）──────────────────────────────
  console.log("[verify] ── ⑤ 续写回合中写动作（write_arch）不重复执行（幂等）──");
  {
    const writeArgs = JSON.stringify({ nodes: [{ id: "bus", name: "消息总线", blurb: "夹具补全节点" }] });
    const gw = await startMockGateway((res, call) => {
      if (call.index === 0) {
        // 工具轮：模型点名 write_arch（参数一次性收齐），finish=tool_calls
        writeSse(
          res,
          sseFrame({
            choices: [
              {
                delta: {
                  tool_calls: [{ index: 0, id: "call_w1", function: { name: "write_arch", arguments: writeArgs } }],
                },
                finish_reason: null,
              },
            ],
          }) +
            sseFrame({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }) +
            "data: [DONE]\n\n",
        );
      } else if (call.index === 1) {
        writeSse(res, sseText("正文第一段……", "length")); // 首段被截断 → 触发续写
      } else {
        writeSse(res, sseText("正文第二段……", "stop"));
      }
    });
    useGateway(gw.url);
    clearCheckpoint(PROJ);
    const r = await runTurn(baseMessages(), { model: "synthetic", baseURL: gw.url });
    const writeCalls = r.toolResults.filter((t) => t.name === "write_arch");
    console.log(`[verify]   模型调用 ${gw.calls.length} 次；write_arch 回执 ${writeCalls.length} 次`);
    ok(r.error === null, "⑤ 工具轮 + 续写全程正常（无异常）");
    ok(gw.calls.length === 3, `⑤ 工具轮 + 首段 + 续段 = 3 次模型调用（实际 ${gw.calls.length}）`);
    ok(writeCalls.length === 1, `⑤ write_arch 全程只执行一次（续写回合没有重跑写动作，实际 ${writeCalls.length} 次）`);
    ok(r.toolEvents.some((t) => t.name === "write_arch"), "⑤ 工具活动事件如实透出（前端可提示「正在补全架构图」）");
    const sup = readSupplement(PROJ);
    ok(sup !== null && sup.nodes.length === 1 && sup.nodes[0].id === "chat:bus", "⑤ 补全层恰好一个节点（写动作没有重复落盘）");
    ok(sup !== null && sup.edges.length === 0, "⑤ 补全层没有多余边");
    ok(countContinuePrompt(gw.calls[2]?.messages ?? []) === 1, "⑤ 第三轮确为续写请求（带 1 条 CONTINUE_PROMPT）");
    ok(
      gw.calls[2]?.messages.some((m) => m.role === "tool") ?? false,
      "⑤ 续写请求里带工具结果行（写动作的结果在上下文，不需重跑）",
    );
    ok(r.text.includes("正文第一段") && r.text.includes("正文第二段"), "⑤ 续写正文照常拼出");
    // 幂等对照：同参数再写一次，不新增节点（写动作幂等）
    const again = executeChatTool(PROJ, "write_arch", writeArgs);
    ok(
      again.result.includes('"added_nodes":0') && again.result.includes('"skipped_duplicate_nodes":1'),
      "⑤ 重复 write_arch 幂等：added_nodes=0、skipped_duplicate_nodes=1",
    );
    const sup2 = readSupplement(PROJ);
    ok(sup2 !== null && sup2.nodes.length === 1, "⑤ 重复写入后补全层节点数仍为 1（幂等）");
    await gw.close();
  }
}

try {
  await main();
} finally {
  try {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  } catch {
    /* Windows 下文件偶被占用，残留 tmp 目录无害 */
  }
}
console.log("[verify] done");
