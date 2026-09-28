// C1：DeepSeek V4.1 Flash 流式客户端（DESIGN.md §3.6 Flash 聊天）。
// DeepSeek API 是 OpenAI 兼容协议：POST {baseURL}/v1/chat/completions，stream:true 走 SSE。
// 默认走本机网关 cc-glm-router（见 DEFAULT_BASE_URL 注释）；model 与 baseURL 都是可配置项。
//
// ████████████████████████████ 红线 ████████████████████████████
// 密钥绝不进仓库、绝不进日志：只从 DEEPSEEK_API_KEY 环境变量或全局数据目录
// config.json（TATAI_HOME 覆盖，文件不进仓库）读取；本模块任何错误信息都不得
// 携带密钥原文或 Authorization 头内容（错误消息只拼 HTTP 状态码与响应体）。
// ███████████████████████████████████████████████████████████████
//
// 不引 openai sdk 等清单外依赖：SSE 用 Node 18+ 内置 fetch + ReadableStream 逐行解析。
import fs from "node:fs";
import path from "node:path";
import { resolveDataDir } from "./registry";
import { sanitizeErrorMessage } from "./redact";

/** 聊天消息（OpenAI 兼容格式；C2 落盘的 role/content 口径与 §2.3.6 一致） */
export interface FlashMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** 可调项：model/baseURL/密钥/超时都有默认值，上层按需覆盖 */
export interface FlashOptions {
  /** 模型 id，默认 deepseek-chat（"DeepSeek V4.1 Flash" 的产品模型） */
  model?: string;
  /** API 基址，默认 https://api.deepseek.com */
  baseURL?: string;
  /** 显式密钥；不传则走 resolveApiKey() 环境变量 > config.json 的口径 */
  apiKey?: string;
  /** 空闲超时毫秒（每收到一块新数据重置），默认 60000；超时抛可读错误，不吞异常 */
  timeoutMs?: number;
  /** 采样温度，可选。走默认网关时**无效**——网关强制注入 0.2（统一调温）；仅直连官方 API
   *  （baseURL 覆盖）时生效。默认不传（Kimi Code 对齐口径：靠思考档稳输出） */
  temperature?: number;
  /** 思考档位（Kimi Code 对齐：thinkingEffort high）。默认 high；传 "low" 可调低，传空串 "" 可省略该参数 */
  reasoningEffort?: "high" | "medium" | "low" | "";
  /** 单次请求输出上限（max_tokens），默认 8192；截断（finish_reason=length）由上层续写兜底 */
  maxTokens?: number;
}

/** 默认模型 id（导出供 C2 落盘 assistant 行 model 字段与调用方缺省口径对齐）。
 *  2026-09-19 Kimi Code 对齐（主人裁定）：deepseek-chat 与 deepseek-flash 同后端，
 *  区别只在思考开关——chat 思考关（探针实测 reasoning 0 字），flash 默认思考开。
 *  Kimi Code 里 V4.1 Flash 表现稳靠的就是"正式 ID + 思考档"；塔台此前用 deepseek-chat
 *  等于关着脑子跑，同 prompt 三次三个性格。全机其余工具已统一 deepseek-flash（Kimi Code
 *  定版），此处对齐。 */
export const DEFAULT_MODEL = "deepseek-flash";
/** 默认 API 基址：本机网关 cc-glm-router（2026-09-19 主人拍板 DeepSeek 统一走网关）。
 *  网关的 OpenAI 通路把请求透传到 api.deepseek.com，凭据（authorization 头）原样转发
 *  （仍用 DEEPSEEK_API_KEY），并**强制注入 temperature=0.2**（网关侧统一调温，只改网关
 *  proxy.js 的 INJECT_TEMPERATURE 一个数）。直连官方 API 可用 TATAI_DEEPSEEK_BASE_URL
 *  环境变量或 config.json deepseek_base_url 覆盖回 https://api.deepseek.com。 */
const DEFAULT_BASE_URL = "http://127.0.0.1:3456";
// 空闲口径（2026-09-19 试用反馈）：原来对整条流挂 60s 总超时，逆向落稿这类几分钟的长回答
// 会被中途掐断；改为每收到一块新数据就重置——只要模型还在吐字就不算超时，真断流 60s 才报。
const DEFAULT_TIMEOUT_MS = 60_000;
// 单次请求输出上限（2026-09-19 试用反馈）：不传 max_tokens 时 API 按自家默认截断且无从感知，
// 显式拉满并把 finish_reason 透出来，截断交给上层续写（chatTurn / chatWithContinue）兜底。
// 注意服务端口径（2026-09-19 实测）：max_tokens **含思考 token**（completion_tokens_details.
// reasoning_tokens 计入）——默认思考开时思考先扣预算，剩多少才给正文；预算小会被思考吃光出
// 0 字正文。8192 档位下思考 + 正文都够用，真顶满则触发 finish=length 走上层续写兜底。
const DEFAULT_MAX_TOKENS = 8192;

/** 全局数据目录 config.json 里密钥字段名（文件在 TATAI_HOME/~.tatai 下，不进仓库） */
const CONFIG_KEY_FIELD = "deepseek_api_key";
/** 同文件里基址字段名（覆盖默认网关，指回官方 API 或别的中转用） */
const CONFIG_BASE_FIELD = "deepseek_base_url";

/**
 * 密钥读取口径：DEEPSEEK_API_KEY 环境变量 > 全局数据目录 config.json 的
 * deepseek_api_key 字段。两者都没有时抛可读错误（消息里不含任何密钥材料）。
 */
export function resolveApiKey(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.DEEPSEEK_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  const configFile = path.join(resolveDataDir(env), "config.json");
  if (fs.existsSync(configFile)) {
    try {
      const raw = JSON.parse(fs.readFileSync(configFile, "utf8")) as Record<string, unknown>;
      const fromFile = typeof raw[CONFIG_KEY_FIELD] === "string" ? raw[CONFIG_KEY_FIELD].trim() : "";
      if (fromFile) return fromFile;
    } catch (e) {
      // F5（2026-09-18 审计）：configFile 是全局数据目录下的本机绝对路径，错误消息会经
      // SSE/HTTP 回显给调用方——先过消息级脱敏（盘符/UNC → <path>），不递本机目录结构
      throw new Error(
        `Flash 密钥配置 ${sanitizeErrorMessage(configFile)} 不是合法 JSON：${(e as Error).message}`,
      );
    }
  }
  throw new Error(
    `未配置 DeepSeek 密钥：请设 DEEPSEEK_API_KEY 环境变量，或在 ${sanitizeErrorMessage(configFile)} 写 {"${CONFIG_KEY_FIELD}": "..."}`,
  );
}

/**
 * API 基址读取口径：TATAI_DEEPSEEK_BASE_URL 环境变量 > 全局数据目录 config.json 的
 * deepseek_base_url 字段 > 默认本机网关（见 DEFAULT_BASE_URL 注释）。坏 config 文件只影响
 * 基址覆盖（缺省走网关）——坏文件本身由 resolveApiKey 那边如实报错，这里不重复抛。
 */
export function resolveBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.TATAI_DEEPSEEK_BASE_URL?.trim();
  if (fromEnv) return fromEnv;
  const configFile = path.join(resolveDataDir(env), "config.json");
  if (fs.existsSync(configFile)) {
    try {
      const raw = JSON.parse(fs.readFileSync(configFile, "utf8")) as Record<string, unknown>;
      const fromFile = typeof raw[CONFIG_BASE_FIELD] === "string" ? raw[CONFIG_BASE_FIELD].trim() : "";
      if (fromFile) return fromFile;
    } catch {
      // 有意吞掉：基址缺省即可用，密钥问题让 resolveApiKey 报
    }
  }
  return DEFAULT_BASE_URL;
}

interface SseDeltaChunk {
  choices?: {
    delta?: {
      content?: string | null;
      // 工具调用增量（OpenAI 兼容流式协议）：按 index 分片累积——id/name 只在首片出现，
      // arguments 字符串逐片拼接（模型边想边吐参数 JSON，收齐才可解析）
      tool_calls?: {
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }[];
    };
    finish_reason?: string | null;
  }[];
}

// ── 2026-09-19 试用增强二期：工具调用的类型（主人裁定"现在就做全量"）──────────────
// OpenAI 兼容协议的三种消息形态：普通消息（FlashMessage）/ 模型发起的工具调用（assistant 行
// 带 tool_calls）/ 工具执行结果（tool 行带 tool_call_id）。工具轮次的这些行只活在当次请求循环里，
// 不落盘进会话 jsonl（§2.3.6 口径不变）。

/** 工具定义（发给模型的说明书：名字/用途/参数 JSON Schema） */
export interface ToolSpec {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

/** 工具轮次消息：FlashMessage 超集（普通调用方传 FlashMessage 照常兼容） */
export type FlashRoundMessage =
  | FlashMessage
  | {
      role: "assistant";
      content: string | null;
      tool_calls: { id: string; type: "function"; function: { name: string; arguments: string } }[];
    }
  | { role: "tool"; tool_call_id: string; content: string };

/** 流式事件：文本增量（照旧逐 token）｜模型点名的工具调用（本轮流结束时收齐一次性产出）｜
 *  本轮流结束（reason 取 finish_reason：length=被截断，stop=自然收尾；上层据此决定要不要续写） */
export type FlashEvent =
  | { type: "delta"; text: string }
  | { type: "tool_calls"; calls: { id: string; name: string; arguments: string }[] }
  | { type: "finish"; reason: string | null };

/**
 * 流式聊天（事件版，chatStream 的超集）：逐 chunk 产出 delta 文本与收齐的工具调用。
 * 传 tools 时模型可以点名调工具（事件 tool_calls）；不传 tools 行为与纯文本聊天逐字相同。
 * 这是 A2 起名 / C3 聊天 UI / B3 逆向落稿 / 聊天工具循环共用的统一流式消费方式。
 * 错误一律抛出可读 Error：HTTP 非 2xx 带状态码 + 响应体摘要；网络/超时带原因；不吞异常。
 */
export async function* chatStreamEvents(
  messages: FlashRoundMessage[],
  opts: FlashOptions & { tools?: ToolSpec[] } = {},
): AsyncIterable<FlashEvent> {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error("chatStreamEvents: messages 不能为空数组");
  }
  const apiKey = opts.apiKey ?? resolveApiKey();
  const model = opts.model ?? DEFAULT_MODEL;
  const baseURL = (opts.baseURL ?? resolveBaseUrl()).replace(/\/+$/, "");
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  const reasoningEffort = opts.reasoningEffort ?? "high";

  // 空闲超时：每收到一块新数据 kick() 重置；长回答只要还在吐字就不会被掐断
  const controller = new AbortController();
  let timer = setTimeout(
    () => controller.abort(new Error(`Flash API 空闲超时（${timeoutMs}ms 没有新数据）`)),
    timeoutMs,
  );
  const kick = () => {
    clearTimeout(timer);
    timer = setTimeout(
      () => controller.abort(new Error(`Flash API 空闲超时（${timeoutMs}ms 没有新数据）`)),
      timeoutMs,
    );
  };

  let res: Response;
  try {
    // 路径带 /v1 前缀：网关 OpenAI 通路按 /v1/chat/completions 精确匹配（防误伤同机
    // Claude Code 在用的 /v1/messages Anthropic 通路）；DeepSeek 官方 API 两种路径都认
    res = await fetch(`${baseURL}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        max_tokens: maxTokens,
        ...(typeof opts.temperature === "number" ? { temperature: opts.temperature } : {}),
        // 思考档：deepseek-flash 默认思考开，这里显式钉 high（与 Kimi Code thinkingEffort:high 对齐；
        // 传空串 "" 可显式省略）。思考增量（reasoning_content）不出现在 delta.content 里，
        // 流式解析天然只透传正文，不用剥。
        ...(reasoningEffort !== "" ? { reasoning_effort: reasoningEffort } : {}),
        ...(opts.tools ? { tools: opts.tools } : {}),
      }),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    // abort 超时与网络错误分开说；都不含密钥材料
    if (controller.signal.aborted) {
      throw new Error(`Flash API 请求超时（${timeoutMs}ms 无响应）：${baseURL}/v1/chat/completions`);
    }
    throw new Error(`Flash API 网络错误：${(e as Error).message}`);
  }
  kick(); // 响应头到了算一次"有动静"，重新计空闲窗口

  if (!res.ok || !res.body) {
    clearTimeout(timer);
    // HTTP 非 2xx（401/429/500…）：读出响应体拼可读错误；响应体是服务端错误描述，不含我方密钥
    const bodyText = (await res.text().catch(() => "")).slice(0, 500);
    throw new Error(`Flash API HTTP ${res.status}：${bodyText || res.statusText}`);
  }

  // SSE 逐行解析：缓冲字节流 → 按行切 → data: 行取 JSON → choices[0].delta；
  // data: [DONE] 终止。忽略空行与注释行（: 开头）。
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  // 本轮流最后见到的 finish_reason（"length"=被截断，"stop"=自然收尾）：结束时以 finish 事件透出
  let lastFinish: string | null = null;
  // 工具调用按 index 累积（跨 chunk 拼参数）；流结束时收齐一次性作为 tool_calls 事件产出
  const toolAcc = new Map<number, { id: string; name: string; arguments: string }>();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      kick(); // 有新数据：重置空闲计时窗口
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") {
          const calls = [...toolAcc.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v).filter((c) => c.name !== "");
          if (calls.length > 0) yield { type: "tool_calls", calls };
          yield { type: "finish", reason: lastFinish };
          return;
        }
        let chunk: SseDeltaChunk;
        try {
          chunk = JSON.parse(payload) as SseDeltaChunk;
        } catch {
          continue; // 心跳/非 JSON 行跳过，不中断流
        }
        const choice = chunk.choices?.[0];
        const delta = choice?.delta;
        const text = delta?.content;
        if (typeof text === "string" && text !== "") yield { type: "delta", text };
        if (typeof choice?.finish_reason === "string" && choice.finish_reason !== "") {
          lastFinish = choice.finish_reason;
        }
        if (Array.isArray(delta?.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const slot = toolAcc.get(tc.index) ?? { id: "", name: "", arguments: "" };
            if (tc.id) slot.id = tc.id;
            if (tc.function?.name) slot.name = tc.function.name;
            if (tc.function?.arguments) slot.arguments += tc.function.arguments;
            toolAcc.set(tc.index, slot);
          }
        }
      }
    }
    // 服务端没发 [DONE] 就断流（异常场景）：工具调用若已收齐也如实产出，不静默丢
    const calls = [...toolAcc.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v).filter((c) => c.name !== "");
    if (calls.length > 0) yield { type: "tool_calls", calls };
    yield { type: "finish", reason: lastFinish };
  } catch (e) {
    if (controller.signal.aborted) {
      throw new Error(`Flash API 流式空闲超时（${timeoutMs}ms 没有新数据）`);
    }
    throw new Error(`Flash API 流式读取中断：${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
}

/**
 * 流式聊天：返回 AsyncIterable<string>，逐 chunk 产出 delta 文本，上层 for await 即可消费。
 * chatStreamEvents 的纯文本视图（只透传 delta 事件）——不传 tools 时工具事件本来就不会发生。
 * 这是 A2 起名 / C3 聊天 UI / B3 逆向落稿共用的统一流式消费方式（PLAN.md C1 DoD④）。
 */
export async function* chatStream(
  messages: FlashMessage[],
  opts: FlashOptions = {},
): AsyncIterable<string> {
  for await (const ev of chatStreamEvents(messages, opts)) {
    if (ev.type === "delta") yield ev.text;
  }
}

/**
 * 非流式便捷封装：收集 chatStream 全文一次返回。供不需要逐 token 的调用方（如 A2 起名）用。
 */
export async function chat(messages: FlashMessage[], opts: FlashOptions = {}): Promise<string> {
  let full = "";
  for await (const delta of chatStream(messages, opts)) full += delta;
  return full;
}

// ── 2026-09-19 试用反馈：输出上限自动续写 ─────────────────────────────────────
// 单次请求 max_tokens 拉满仍可能被截断（finish_reason=length），逆向落稿/落稿草稿这类
// 长输出场景高发。三个消费口（chatTurn 流式循环 / 落稿草稿提炼 / 逆向起草）共用同一份口径：
// 断点续写指令 + 次数上限 + 续满仍截断的如实标记。续写只发生在当次请求循环里，不落任何盘。

/** 续写指令：从中断处接着写，不重复、不重新开头、不解释 */
export const CONTINUE_PROMPT =
  "（上一段输出因长度限制被截断。请从中断处继续写下去：不要重复已写内容、不要重新开头、" +
  "不要说明或道歉，直接接着写。）";
/** 一回合最多续写次数（初次输出之外再续 4 次） */
export const CONTINUE_MAX = 4;
/** 续满仍被截断时的如实标记（拼在全文末尾，用户再发「继续」可手动接着要） */
export const TRUNCATED_TAIL =
  "\n\n（已达本回合连续输出上限，回答在此被截断；再发一句「继续」可让它接着写。）";

/**
 * 带自动续写的一次性聊天（chat 的续写版）：流完全文后若 finish_reason=length 且还有
 * 续写预算，就把已出的半截当 assistant 行、追加一句续写指令再要一段，拼成完整全文返回；
 * 续满仍截断则在末尾如实标记。供落稿草稿提炼 / 逆向起草这类一次性长输出用（流式聊天走 chatTurn）。
 */
export async function chatWithContinue(
  messages: FlashMessage[],
  opts: FlashOptions = {},
): Promise<string> {
  const round = [...messages];
  let full = "";
  for (let attempt = 0; ; attempt++) {
    let roundText = "";
    let finish: string | null = null;
    for await (const ev of chatStreamEvents(round, opts)) {
      if (ev.type === "delta") roundText += ev.text;
      else if (ev.type === "finish") finish = ev.reason;
      // tool_calls 不会发生（本函数不传 tools）
    }
    full += roundText;
    if (finish !== "length") return full;
    if (attempt >= CONTINUE_MAX) return full + TRUNCATED_TAIL;
    round.push({ role: "assistant", content: roundText }, { role: "user", content: CONTINUE_PROMPT });
  }
}

// ── V06-05：结构化整理入口（**新增**，不改上面任何既有函数的语义/参数口径）────────────────────
// DESIGN §4.1 的规划图派生要让内置 DeepSeek「整理能力/模块/关系及出处」，产出是**严格 JSON**。
// 与既有三个口子的关系：本函数只是 `chatWithContinue` 的一层薄封装——同一份流式实现、同一份
// 截断/续写口径（长 JSON 被 max_tokens 截断时照样自动续写、续满照样如实标截断），不另起一套调用协议。
// 因此 `chatStreamEvents` / `chatStream` / `chat` 的签名、请求体（max_tokens / reasoning_effort /
// 无 tools 时的行为）与错误口径**一个字节都没动**（verify:chat-tools 的 C⑨/C⑩ 直接调它，不受影响）。
//
// 为什么要有这一步而不是让调用方自己 JSON.parse：模型的输出常带 ```json 围栏、前后解说或
// 半截 JSON。这里做两件事：① 括号配平地把**第一个完整 JSON 值**抠出来（尊重字符串与转义）；
// ② 抠不出来就如实返回 error（调用方据此走"模型失败/格式不合 → 保留旧图"这一支），不吞、不猜。

/** 结构化整理的结果：全文原样带回 + 从全文里抠出的第一个完整 JSON 值 */
export interface StructuredChatResult {
  /** 模型全文（续写拼好的；长度上限由调用方自己管） */
  text: string;
  /** 第一个完整 JSON 值（对象或数组）；抠不出来为 null */
  json: unknown | null;
  /** 抠不出来时的可读原因（json 非 null 时为 null） */
  error: string | null;
}

/**
 * 从一段文本里抠出第一个**括号配平的**完整 JSON 值（对象 `{}` 或数组 `[]`）。
 * 扫描时跟踪字符串态与转义，因此 JSON 里的 `}`/`]` 不会被误判为结束；围栏与解说文字自然被跳过。
 */
export function extractJsonValue(text: string): { json: unknown | null; error: string | null } {
  const start = (() => {
    const a = text.indexOf("{");
    const b = text.indexOf("[");
    if (a === -1) return b;
    if (b === -1) return a;
    return Math.min(a, b);
  })();
  if (start === -1) return { json: null, error: "输出里没有 JSON 值（既没有 { 也没有 [）" };
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        const slice = text.slice(start, i + 1);
        try {
          return { json: JSON.parse(slice) as unknown, error: null };
        } catch (e) {
          return { json: null, error: `抠出的 JSON 片段不合法：${(e as Error).message}` };
        }
      }
    }
  }
  return { json: null, error: `${open} 没有配平的结束符（被截断或是半截 JSON）` };
}

/**
 * 结构化整理调用入口：走 `chatWithContinue` 流完全文，再把 JSON 抠出来。
 * 错误口径与既有口子一致：网络/HTTP/超时抛可读 Error（不吞）；JSON 抠不出**不抛**，
 * 用 `error` 字段如实回报（"模型答了但答得不是 JSON" 与 "模型没答上来" 是两回事，调用方要分得开）。
 */
export async function chatStructuredJson(
  messages: FlashMessage[],
  opts: FlashOptions = {},
): Promise<StructuredChatResult> {
  const text = await chatWithContinue(messages, opts);
  const { json, error } = extractJsonValue(text);
  return { text, json, error };
}
