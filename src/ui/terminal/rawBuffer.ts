// E2 增量（2026-09-18 Q44 审计修复）：终端 pane「原始输出缓冲」的上限与截断规则。
//
// 背景：`TerminalPane.tsx` 的 `rawRef` 累积本 pane 收到的 SSE 原始字节（「导出原始输出」导的就是它，
// 与着色路径完全无关）。此前它只增不减——一个 pane 一份、每项目最多 8 份
// （`TerminalView.tsx` 的 MAX_PANES_PER_PROJECT），长会话（日志洪峰 / `yes`）能把渲染进程常驻内存
// 顶到几百 MB。本模块给出「超限就丢最前面一段」的唯一口径，纯函数、零 import（同 logColor.ts 的风格）。
//
// 上限怎么取的：2 MiB 字符 ≈ 4 MB 内存/ pane（8 pane 上限 ≈ 32 MB），与后端终端历史
// （`terminalHistory.ts` 的 MAX_HISTORY_BYTES = 5 MB）同量级；导出一次人类会看的会话尾巴够用。
//
// **代价如实记**：`PLAN.md` E2 DoD③ 要求「可导出无颜色纯文本且与源输出一致 / 做字节级对照」——
// 上限之下的会话仍逐字节一致，超过上限后导出的是「最后保留的那段」，不是整场会话。
// 这是为内存封顶做的取舍：界面（`data-terminal-raw-truncated`）与导出按钮标题都会标出丢了多少钱，
// 不静默丢数据。要「整场会话逐字节」就得把上限调大或落盘，属设计取舍，见 Q44 条目的终审说明。

/** 缓冲上限（UTF-16 字符数）：超过它就按 {@link trimRawBuffer} 截断 */
export const RAW_BUFFER_MAX_CHARS = 2 * 1024 * 1024;

/** 截断后保留的尾巴长度（= 上限的一半，留一半余量：免得每来一块输出都截一次） */
export const RAW_BUFFER_KEEP_CHARS = RAW_BUFFER_MAX_CHARS / 2;

/**
 * 超上限就砍掉最前面一段：返回截断后的文本与被砍掉的字符数（没超就原样返回、`dropped` = 0）。
 * 单调性（不凭空造字节、不乱序）：`raw.slice(0, dropped) + text === raw`，即 `text` 恒为原串的**后缀**。
 */
export function trimRawBuffer(raw: string): { text: string; dropped: number } {
  if (raw.length <= RAW_BUFFER_MAX_CHARS) return { text: raw, dropped: 0 };
  let cut = raw.length - RAW_BUFFER_KEEP_CHARS;
  // 落点撞上代理对的后半个（emoji 等单字符两码元）就往后挪一个，别劈出孤立代理项
  const code = raw.charCodeAt(cut);
  if (code >= 0xdc00 && code <= 0xdfff) cut += 1;
  return { text: raw.slice(cut), dropped: cut };
}
