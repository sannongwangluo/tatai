// E2：日志着色层（DESIGN.md §3.7 二期「日志着色」／PLAN.md E2 卡）。
// 纯函数模块，零依赖、零 UI 依赖：既能被 TerminalPane 用在 SSE → xterm 之间，也能被验证脚本直接 import 断言。
//
// 红线（卡上「跑偏点」，不可越）：**不改写、不吞掉原始字节**。本层对字节流只有一种改动——
// 在命中级别关键词的两侧**插入** SGR 序列（开色 + 前景色复位），其余一切（关键词本身、正文、
// 程序自己发的转义序列）原样按序透传。由此三条不变量成立：
//   ① 关闭着色时 `renderLogChunk(raw, state, false)` 与 `raw` **逐字节相等**（DoD②，对真实 PTY 字节流断言）；
//   ② 开启着色时输出是 raw 的**超序列**（只插不改不吞：剥掉转义后的可见文本与 raw 里剥完的一致，DoD③）；
//   ③ 导出走的是 pane 里另存的原始流（TerminalPane 的 `rawRef`），与着色路径完全无关，逐字节等于源输出。
//
// ANSI 透传优先：程序自己设过颜色（SGR 30-37 / 40-47 / 90-107 / 38 / 48）时，本层在该区间内不再插色，
// 绝不覆盖程序自己的颜色；遇到 `0` / `39` / `49` 复位后本层重新接管。
//
// 跨 chunk：SSE 一条消息不保证切在整行上（实测 `node -e` 的输出会与提示符分几条到达），
// 所以状态里带 `carry`——未收全的转义序列、以及"可能是关键词前缀"的尾巴先扣住，下一条消息拼回来再处理。
// 扣住的字节只存在于**渲染**路径，原始流（rawRef）始终完整、即时；切换开关或流结束调 `flushLogColor` 补吐，一个字节不丢。

/** 一条着色规则：级别 → 颜色 + 关键词表（中英文都收，规则表可调，改这里即可） */
export interface LogColorRule {
  /** 级别名（仅用于说明与验证打点） */
  level: "error" | "warn" | "info" | "debug";
  /** SGR 参数（前景色）：31 红 / 33 黄 / 36 青（蓝绿）/ 90 亮黑（灰） */
  sgr: string;
  /** 关键词（英文大小写不敏感；按"词"匹配，不咬进更长的词里） */
  keywords: string[];
}

/**
 * 级别着色规则表（常量，可调）：
 * 红 = ERROR / FATAL / CRITICAL / 失败 / 错误 / 异常；黄 = WARN / WARNING / 警告；
 * 蓝绿 = INFO / OK / SUCCESS / DONE / 成功 / 完成；灰 = DEBUG / TRACE / VERBOSE / 调试。
 */
export const LOG_COLOR_RULES: readonly LogColorRule[] = [
  {
    level: "error",
    sgr: "31",
    keywords: ["ERROR", "FATAL", "CRITICAL", "FAIL", "FAILED", "FAILURE", "失败", "错误", "异常", "报错"],
  },
  { level: "warn", sgr: "33", keywords: ["WARN", "WARNING", "警告"] },
  { level: "info", sgr: "36", keywords: ["INFO", "OK", "SUCCESS", "DONE", "成功", "完成", "就绪"] },
  { level: "debug", sgr: "90", keywords: ["DEBUG", "TRACE", "VERBOSE", "调试"] },
];

/** 前景色复位（只复位前景色，不动粗体/下划线等程序自己设的属性） */
export const FG_RESET = "\u001b[39m";

const ESC = "\u001b[";
const CHAR_ESC = "\u001b";

const WORD_RE = /[A-Za-z0-9_]/;

/** 关键词 → SGR（英文小写做键；表里有重名时先出现者优先） */
const SGR_OF_KEYWORD = new Map<string, string>();
/** 所有关键词（小写），用于判"尾巴是不是某个关键词的前缀" */
const KEYWORD_PREFIXES: string[] = [];
let MAX_KEYWORD_LEN = 0;
for (const rule of LOG_COLOR_RULES) {
  for (const kw of rule.keywords) {
    const lower = kw.toLowerCase();
    if (!SGR_OF_KEYWORD.has(lower)) SGR_OF_KEYWORD.set(lower, rule.sgr);
    KEYWORD_PREFIXES.push(lower);
    MAX_KEYWORD_LEN = Math.max(MAX_KEYWORD_LEN, kw.length);
  }
}

/** 匹配任意级别关键词的正则（大小写不敏感；左右边界另外逐字判，见 isStandalone） */
const KEYWORD_RE = new RegExp(
  [...SGR_OF_KEYWORD.keys()].sort((a, b) => b.length - a.length).join("|"),
  "gi",
);

/** 着色层的流式状态（每个 pane 一份，见 TerminalPane 的 colorStateRef） */
export interface LogColorState {
  /** 程序自己当前是否设了前景/背景色：为 true 时本层不插色（ANSI 透传优先） */
  sgrColored: boolean;
  /** 跨 chunk 扣住的尾巴（未收全的转义序列 / 可能是关键词前缀的词尾） */
  carry: string;
  /** 已吐出正文的最后一个字符：chunk 边界把词切开时，用来判关键词的左边界 */
  lastChar: string;
}

export function createLogColorState(): LogColorState {
  return { sgrColored: false, carry: "", lastChar: "" };
}

/**
 * 扫描一个转义序列的结束位置（返回结束下标，独占）。
 * 收不全（chunk 切在序列中间）返回 -1，由调用方扣进 carry 等下一片。
 */
function scanEscape(s: string, i: number): number {
  const next = s[i + 1];
  if (next === undefined) return -1;
  if (next === "[") {
    // CSI：参数字节 0x30-0x3F / 中间字节 0x20-0x2F，最后是 0x40-0x7E 的终结字节
    let j = i + 2;
    while (j < s.length && !/[@-~]/.test(s[j])) j++;
    return j < s.length ? j + 1 : -1;
  }
  if (next === "]") {
    // OSC：BEL 或 ESC \ 收尾（窗口标题等）
    let j = i + 2;
    while (j < s.length) {
      if (s[j] === "\u0007") return j + 1;
      if (s[j] === ESC && s[j + 1] === "\\") return j + 2;
      j++;
    }
    return -1;
  }
  return i + 2; // 两字符转义（ESC 7 / ESC 8 / ESC c 之类）
}

/**
 * 更新"程序自己有没有上色"。只认改颜色的参数：
 * 0/39/49 = 复位 → 未上色；30-37 / 40-47 / 90-107 / 38 / 48 = 上了色。
 * 粗体、下划线等不改颜色的属性不影响本层着色。
 */
function applySgr(seq: string, state: LogColorState): void {
  const m = /^\u001b\[([0-9;]*)m$/.exec(seq);
  if (!m) return;
  const params = m[1] === "" ? [0] : m[1].split(";").map((p) => Number(p));
  for (const p of params) {
    if (p === 0 || p === 39 || p === 49) state.sgrColored = false;
    else if (p === 38 || p === 48 || (p >= 30 && p <= 37) || (p >= 40 && p <= 47) || (p >= 90 && p <= 107))
      state.sgrColored = true;
  }
}

/** 关键词是否独立成词：左右两侧都不能紧贴词字符（左侧贴词字符时用 lastChar 判，跨 chunk 也成立） */
function isStandalone(text: string, start: number, len: number, state: LogColorState): boolean {
  const prev = start > 0 ? text[start - 1] : state.lastChar;
  const next = start + len < text.length ? text[start + len] : "";
  return !(prev && WORD_RE.test(prev)) && !(next && WORD_RE.test(next));
}

/** 给一段**纯正文**（不含转义序列）上色；不开色时只记 lastChar，原样返回 */
function paintPlain(text: string, state: LogColorState): string {
  if (!text) return "";
  const last = text[text.length - 1];
  if (state.sgrColored) {
    // ANSI 透传优先：这一段归程序自己的颜色管，本层不动它
    state.lastChar = last;
    return text;
  }
  let out = "";
  let from = 0;
  KEYWORD_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = KEYWORD_RE.exec(text)) !== null) {
    const sgr = SGR_OF_KEYWORD.get(m[0].toLowerCase());
    if (!sgr || !isStandalone(text, m.index, m[0].length, state)) continue;
    out += text.slice(from, m.index) + `${ESC}${sgr}m` + m[0] + FG_RESET;
    from = m.index + m[0].length;
  }
  out += text.slice(from);
  state.lastChar = last;
  return out;
}

/**
 * 尾巴是否要扣住：末尾不超过关键词最长长度的**任意后缀**，只要它是某个关键词的前缀
 * （`ERRO` 是 `ERROR` 的前缀、`失` 是 `失败` 的前缀），就可能跨 chunk 拼成完整关键词，先扣住等下一条消息。
 * 收尾字符不是任何关键词前缀（绝大多数行以 `\n` 结尾）一律不扣，输出不迟滞；
 * 万一真的扣住了，pane 那边有 120ms 空闲补吐兜底（见 TerminalPane 的 carryTimer）。
 */
function tailToCarry(text: string): { head: string; carry: string } {
  const max = Math.min(text.length, MAX_KEYWORD_LEN);
  for (let len = max; len >= 1; len--) {
    const suffix = text.slice(text.length - len).toLowerCase();
    if (KEYWORD_PREFIXES.some((k) => k.startsWith(suffix))) {
      return { head: text.slice(0, text.length - len), carry: text.slice(text.length - len) };
    }
  }
  return { head: text, carry: "" };
}

/**
 * 渲染一片输出（SSE 一条消息 → 写进 xterm 的字节）。
 * `enabled=false` 时返回 `carry + raw`：着色关闭时 carry 必为空（关闭态不产生 carry），
 * 唯一非空的情况是从"开着色"切到"关闭"的那一片——把扣住的尾巴补在最前面，保证一个字节都不丢。
 */
export function renderLogChunk(raw: string, state: LogColorState, enabled: boolean): string {
  if (!enabled) {
    const head = state.carry;
    state.carry = "";
    if (head) state.lastChar = head[head.length - 1];
    return head + raw;
  }
  const src = state.carry + raw;
  state.carry = "";
  let out = "";
  let from = 0;
  let i = 0;
  while (i < src.length) {
    if (src[i] !== CHAR_ESC) {
      i++;
      continue;
    }
    // 转义序列前的正文：后面紧跟序列，不可能是跨 chunk 的关键词前缀，不扣尾巴（扣了会插错位置）
    out += paintPlain(src.slice(from, i), state);
    const end = scanEscape(src, i);
    if (end < 0) {
      state.carry = src.slice(i);
      return out;
    }
    out += src.slice(i, end); // 程序自己的序列原样透传：不吞、不改、不重排
    applySgr(src.slice(i, end), state);
    state.lastChar = ""; // 序列把前后正文隔开了，左边界判定的上下文随之作废
    i = end;
    from = i;
  }
  const tail = src.slice(from);
  const { head, carry } = tailToCarry(tail);
  state.carry = carry;
  out += paintPlain(head, state);
  return out;
}

/** 补吐扣住的尾巴（切换开关 / 流结束 / 120ms 空闲兜底时调），返回该吐出的字节并清空 carry */
export function flushLogColor(state: LogColorState): string {
  const tail = state.carry;
  state.carry = "";
  if (tail) state.lastChar = tail[tail.length - 1];
  return tail;
}

/** 剥掉全部 ANSI 转义序列（验证脚本对"可见文本一致"用；不参与着色与导出） */
export function stripAnsi(text: string): string {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] !== CHAR_ESC) {
      out.push(text[i]);
      i++;
      continue;
    }
    const end = scanEscape(text, i);
    if (end < 0) break; // 尾部残片不算可见文本
    i = end;
  }
  return out.join("");
}
