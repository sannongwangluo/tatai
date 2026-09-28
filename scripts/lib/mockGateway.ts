// 合成网关桩（批3 T26）：验证脚本共用的本地 SSE 网关夹具，从 verify-chat-continue.ts#startMockGateway
// 提炼（那份原件按 T26 边界不动，继续自带一份；本文件供 chat-arch-write / chat-tools 两脚本复用）。
//
// 用途：在 127.0.0.1 上起一个 OpenAI 兼容的 `POST /v1/chat/completions` SSE 桩当"模型网关"，
// 由产品既有验证钩子把模型调用接管过来（flash.ts#chatStreamEvents 的 opts.baseURL，或
// TATAI_DEEPSEEK_BASE_URL 环境变量）——被断言的仍是产品那条消费路径（SSE 解析 / 工具循环 /
// 截断续写 / 落盘回执），夹具只替换"上游吐什么"：确定性、零真网关、零网速依赖、可复跑。
//
// ████ 红线 ████ 桩只绑 127.0.0.1:0（系统分配动态端口，不碰任何真实服务端口）；桩不打印、
// 不回显任何密钥原文（请求头一律不落日志）。密钥由脚本自己钉成本地假值并把基址指到本桩，
// 与外部环境变量无关——`env -u DEEPSEEK_API_KEY` 与假密钥两种情况下都照常走桩。
//
// TATAI_VERIFY_STUB_PORT：测试钩子——默认 0（动态端口，正常跑不动它）。给一个**已被占用**的
// 端口即可制造"桩起不来"（EADDRINUSE），用于验证失败分支（受阻态 exit 3，不得假绿）。
import http from "node:http";
import type { FlashRoundMessage } from "../../src/server/flash";

/** 桩收到的一次模型调用（按到达顺序编号；body/messages 供断言"回传链路"用） */
export interface MockCall {
  /** 第几次模型调用（0 起） */
  index: number;
  path: string;
  body: Record<string, unknown>;
  messages: FlashRoundMessage[];
}

/** 每次请求交 handler 写响应（可流式可掐断，也可主动报错） */
export type MockHandler = (res: http.ServerResponse, call: MockCall) => void;

export interface MockGateway {
  url: string;
  calls: MockCall[];
  /** 幂等（重复 close 不抛）：便于"主动拔桩"的阴性用例后再走统一收尾 */
  close: () => Promise<void>;
}

/**
 * 起一个 SSE 桩；监听 127.0.0.1 上 `opts.port`（默认 0，由系统分配）。
 * 端口起不来（被占等）时 Promise reject，交调用方走"受阻态"分支（不冒充成功）。
 */
export function startMockGateway(handler: MockHandler, opts: { port?: number } = {}): Promise<MockGateway> {
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
    server.listen(opts.port ?? 0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      let closed = false;
      resolve({
        url: `http://127.0.0.1:${port}`,
        calls,
        close: () =>
          new Promise<void>((r) => {
            if (closed) {
              r();
              return;
            }
            closed = true;
            server.close(() => r());
          }),
      });
    });
  });
}

export const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache",
};

/** 一帧 SSE（OpenAI 兼容：`data: {...}\n\n`） */
export const sseFrame = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;

/** 一段纯文本流：正文增量 + finish_reason + [DONE]（OpenAI 兼容 SSE 形态） */
export const sseText = (text: string, finish: string): string =>
  sseFrame({ choices: [{ delta: { content: text }, finish_reason: null }] }) +
  sseFrame({ choices: [{ delta: {}, finish_reason: finish }] }) +
  "data: [DONE]\n\n";

/** 模型点名的工具调用（OpenAI 兼容流式协议：一句 delta 带 tool_calls + finish_reason=tool_calls） */
export const sseToolCalls = (calls: { id: string; name: string; arguments: string }[], finish = "tool_calls"): string =>
  sseFrame({
    choices: [
      {
        delta: {
          tool_calls: calls.map((c, i) => ({
            index: i,
            id: c.id,
            function: { name: c.name, arguments: c.arguments },
          })),
        },
        finish_reason: null,
      },
    ],
  }) +
  sseFrame({ choices: [{ delta: {}, finish_reason: finish }] }) +
  "data: [DONE]\n\n";

/** 一次回完（非流式分块也走这个：状态 200 + SSE 头 + 整段 body） */
export const writeSse = (res: http.ServerResponse, payload: string): void => {
  res.writeHead(200, SSE_HEADERS);
  res.end(payload);
};
