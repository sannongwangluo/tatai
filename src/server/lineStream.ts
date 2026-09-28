// Q46（2026-09-18 审计修复）：行式读盘的公共口径——**流式逐行**，不把整份文件读进内存。
//
// 背景：终端历史检索（`terminalHistory.ts`）与聊天会话列表（`chat.ts`）此前都是
// `readFileSync(file, "utf8").split(/\r?\n/)` 再逐行 `JSON.parse`，而检索返回条数（limit）只截
// **结果**、一点也不省读入量——终端历史最多 1 个活跃 + 5 个归档（各 5 MB 上限）≈ 30 MB 文本，
// 解析成对象后内存还要再翻几倍；聊天会话没有单文件上限，更没有会话条数上限。
// 现在这两个消费点改走本模块的逐行流：内存 = 一块 + 一行的残片，与文件总大小无关
// （极端情形——文件里没有任何换行——才退化到整个文件，读块 64 KiB 与 watcher.ts 倒读同量级）。
//
// 为什么顺序读而不是复用 `watcher.ts` 的 `iterTailLines`：那份是**倒读**（服务"最新 N 条"的窗口读），
// 而这里的两个消费点都要**精确的全量计数**（命中总数 / 消息条数），只能从头顺读一遍。
//
// Q136（2026-09-19 审计）起本模块还收了两件"行式 JSONL 的公共口径"：
//   · `appendJsonlLine` —— 追加前先给残尾封口（半截行不会把新记录粘成第二条坏行）；
//   · `warnCorruptLinesThrottled` —— 坏行跳过不是静默跳过（按 key 限频打一条）。
// 三者合起来就是"坏行不拒读、不静默、不自愈（只读路径不写盘）"的一套口径，changes/gate/chat 共用。
import fs from "node:fs";

/** 读块大小（与 watcher.ts 的 TAIL_CHUNK_BYTES 同量级） */
const CHUNK_BYTES = 64 * 1024;
/** 换行字节 */
const LF = 0x0a;

/**
 * 顺序产出文件里的每一行（不含行尾 `\n`；CRLF 的 `\r` 留在行尾，调用方 `trim()` 即可）。
 * 按 `\n` 字节边界切、整行才 decode——UTF-8 多字节字符（中文命令/路径）不会被块边界劈成半个。
 * 文件不存在/读不动时照常抛（由调用方决定是"正常空态"还是错误）。
 */
export function* iterFileLines(file: string): Generator<string> {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const buf = Buffer.allocUnsafe(CHUNK_BYTES);
    let pos = 0;
    let tail = Buffer.alloc(0); // 上一块末尾没换行的残行，与下一块拼起来
    while (pos < size) {
      const n = fs.readSync(fd, buf, 0, Math.min(CHUNK_BYTES, size - pos), pos);
      if (n <= 0) break;
      pos += n;
      const chunk = buf.subarray(0, n);
      const combined = tail.length > 0 ? Buffer.concat([tail, chunk]) : chunk;
      let start = 0;
      for (;;) {
        const idx = combined.indexOf(LF, start);
        if (idx < 0) break;
        yield combined.subarray(start, idx).toString("utf8");
        start = idx + 1;
      }
      tail = Buffer.from(combined.subarray(start));
    }
    if (tail.length > 0) yield tail.toString("utf8"); // 末行没有换行收尾的情形
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * 坏行告警节流表（Q32/Q136 同一口径）：key → 上次告警时间。坏行会一直留在文件里（追加只往后写），
 * 而这些文件都在热轮询里被反复读（live 5s、summary 10s、聊天列表每次刷新）——不限频就是刷屏。
 * 每个 key 一分钟最多一条。
 */
const corruptWarnAt = new Map<string, number>();
export const CORRUPT_WARN_INTERVAL_MS = 60_000;

/** 坏行不是静默跳过：按 key 限频打一条（消息由调用方拼：哪个文件、几行、首处位置） */
export function warnCorruptLinesThrottled(key: string, message: string): void {
  const now = Date.now();
  if (now - (corruptWarnAt.get(key) ?? 0) < CORRUPT_WARN_INTERVAL_MS) return;
  corruptWarnAt.set(key, now);
  console.warn(message);
}

/**
 * 追加一行 JSONL（Q136，2026-09-19 审计）。
 *
 * 为什么不能用裸 `appendFileSync`：文件尾部若留着**半截行**（上次写到一半被 kill），直接追加会把
 * 新记录**粘在残尾后面**——两条一起变成坏行，新记录跟着丢（而残尾永远不会自己消失，于是"每条新记录
 * 都丢"）。这里先补一个换行把残尾**封口**成独立的一行（读侧按坏行跳过，Q32 口径），新行照常成立。
 * 非破坏性：一个字节都不删、不改，只在需要时插一个 `\n`（代价是两次额外系统调用：stat + 读尾字节）。
 */
export function appendJsonlLine(file: string, line: string): void {
  let prefix = "";
  try {
    const size = fs.statSync(file).size;
    if (size > 0) {
      const fd = fs.openSync(file, "r");
      try {
        const last = Buffer.alloc(1);
        fs.readSync(fd, last, 0, 1, size - 1);
        if (last[0] !== LF) prefix = "\n"; // 残尾封口
      } finally {
        fs.closeSync(fd);
      }
    }
  } catch {
    // 读不到尾部（首次创建/并发删除）：按"没有残尾"处理；append 本身会把真实错误抛出来
  }
  fs.appendFileSync(file, prefix + line + "\n", "utf8");
}
