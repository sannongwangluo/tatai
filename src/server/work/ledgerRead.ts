// 账本读取的**唯一**流式实现（V09-38 复审修正）：内容验证 + 有界解析缓存 + 合法追加仅解析后缀。
//
// 为什么单独成模块：`eventStore.loadEvents` 与快照层都要建立在同一处读取上，而缓存又需要
// 复用事件对象。若把缓存直接放进 `eventStore.ts`，`eventStore ⇄ 缓存` 就成环。本模块是**纯读取层**，
// 只依赖 node 内建与 `./types`，不 import `eventStore`——循环依赖从结构上不存在。
//
// 硬口径（一条都不能松，对应 DESIGN.md §6.8 / `docs/unified-optimization-contract.md` U1·U2）：
//   · 判"内容未变"只看**本次现读的真实字节摘要**，不看 mtime / size / seq / 监听 / TTL。
//     外部保留长度与 mtime 的原地改写必须被识别（改任何一个字节 → 摘要变 → 缓存前缀不再命中）。
//   · **摘要与事件来自同一次读**：逐行把"完整行"（含行尾 `\n`）的字节喂进 sha256，尾部的半截行字节
//     不参与摘要。因此 `content.prefix_sha256` 恒等于返回事件所覆盖那段的字节摘要——不存在
//     "解析的是这一版、哈希算的是另一版"的错配（旧实现用第二次读 `sha256Range` 补半尾前缀，正是这个隐患）。
//   · 合法追加只重解析后缀；前缀的合法性由**已证明的字节摘要**背书。前缀证明不成立一律全量重读重折。
//   · **有界**：条目数 / 总字节 / 单条字节 / **事件条数** / **单行字节**都有上限；超限不缓存，
//     正确退化为"每次全量"。这里按磁盘字节计预算——解析后的对象内存远大于磁盘字节（见验证脚本的 RSS 实测），
//     所以事件条数上限是真正的内存闸，磁盘字节不是"等于内存"。
//   · **只读不写盘**：纯内存，不新建任何缓存文件（契约 U2）。现场已变时整条缓存可丢弃。
//   · **隔离**：缓存内权威事件对象深冻结，对外给独立数组切片。外部改写返回数组只影响自己的副本，
//     改写事件对象在严格模式下抛错——污染不进缓存。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  WorkError,
  validateWorkEvent,
  type FoldBase,
  type LedgerContentFingerprint,
  type LedgerPrefixProof,
  type WorkEntityState,
  type WorkEvent,
} from "./types";

/** 账本文件名（唯一字面量；`eventStore.EVENTS_FILE` 由它派生） */
export const LEDGER_FILE_NAME = "events.jsonl";
export const ledgerEventsPath = (workDir: string): string => path.join(workDir, LEDGER_FILE_NAME);

const CHUNK_BYTES = 1 << 20; // 1 MiB：一次流式扫描的读块
const LF = 0x0a;
const RAW_KEEP_CHARS = 200;
const EMPTY_SHA256 = crypto.createHash("sha256").digest("hex");
/** 现读出现"文件在扫描期间变化"时的最大重试次数（超过就如实标 file_changing，不缓存） */
const MAX_UNSTABLE_RETRIES = 3;

/** 缓存条目数上限（默认 8：够覆盖本机多项目热读，超出按 LRU 淘汰） */
export let EVENT_READ_CACHE_MAX_ENTRIES = 8;
/**
 * 缓存总字节上限（默认 128 MiB）。**按"账本已验证字节"（磁盘字节）计预算，不等于解析后对象内存**：
 * 实测 52.9 MB 的冻结账本解析后堆内约放大数倍（见 `scripts/verify-unified-incremental.ts` 的 RSS 实测），
 * 真正兜住内存的是下面的**事件条数/单行字节**上限。多个大账本同时命中时可按需要调低本值。
 */
export let EVENT_READ_CACHE_MAX_TOTAL_BYTES = 128 * 1024 * 1024;
/** 单条上限（默认 64 MiB：覆盖约 53 MB 的冻结基准；超过就不缓存，每次全量） */
export let EVENT_READ_CACHE_MAX_ENTRY_BYTES = 64 * 1024 * 1024;
/** 单条事件条数上限（默认 40000：按对象内存兜底；超过就不缓存，避免一条大账本把进程顶爆） */
export let EVENT_READ_CACHE_MAX_ENTRY_EVENTS = 40_000;
/** 单行字节上限（默认 8 MiB：单行超过它说明这份账本不适合进程内缓存，退化为每次全量） */
export let EVENT_READ_CACHE_MAX_LINE_BYTES = 8 * 1024 * 1024;

interface CacheEntry {
  /** 权威事件（深冻结；对外只经切片暴露，保证外部改写污染不进缓存） */
  events: readonly WorkEvent[];
  content: LedgerContentFingerprint;
  /** 该账本的行数（= 已解析/跳过的全部行数） */
  line_count: number;
  bytes: number;
  /** 该账本出现过的最大单行字节（增量读取时与前缀取大） */
  max_line_bytes: number;
  /** 已折叠基线（惰性；只在快照层取用时生成/推进） */
  foldBase: FoldBase | null;
}

/** 进程内缓存；键 = 规范化 workDir。不落盘、不跨进程（契约 U2：只读路径不写新缓存文件）。 */
const cache = new Map<string, CacheEntry>();

export interface EventReadCacheStats {
  entries: number;
  bytes: number;
  max_entries: number;
  max_total_bytes: number;
  max_entry_bytes: number;
  max_entry_events: number;
  max_line_bytes: number;
  /** 累计读取次数与分档 */
  reads: number;
  full_reads: number;
  incremental_reads: number;
  empty_reads: number;
  /** 累计"跳过重解析、直接复用"的事件条数 */
  reused_events: number;
  /** 累计真正 JSON.parse/validate 的事件条数 */
  reparsed_events: number;
  /** 累计流过 sha256 的字节数（证明"每次都核验真实字节"） */
  hashed_bytes: number;
  /** 因内容证明失败而回退全量的次数 */
  fell_back: number;
  /** 因扫描期间文件在变而重试/拒绝缓存的次数 */
  unstable_reads: number;
}
const stats = {
  reads: 0,
  full_reads: 0,
  incremental_reads: 0,
  empty_reads: 0,
  reused_events: 0,
  reparsed_events: 0,
  hashed_bytes: 0,
  fell_back: 0,
  unstable_reads: 0,
};

export interface LedgerRead {
  /**
   * 事件数组（**独立切片**：数组可被调用方自由修改；元素是深冻结的权威对象，
   * 外部无法改写它污染缓存）。语义与 `loadEvents(workDir).events` 完全一致。
   */
  events: WorkEvent[];
  /** 半截尾行（文件未以 `\n` 收尾时的最后一行）；整行收尾时为 null */
  tail: CorruptLine | null;
  /** 本次现读的账本内容身份（每一步都真实算过，不是缓存转述） */
  content: LedgerContentFingerprint;
  origin: "empty" | "full" | "incremental";
  /** 复用前缀里已有的事件条数（本次没有重解析它们） */
  reused_prefix_events: number;
  /** 本次真正 JSON.parse/validate 的事件条数 */
  reparsed_events: number;
  /** 是否因内容证明失败而回退全量 */
  fell_back_to_full: boolean;
  fallback_reason: string | null;
  /** 本次现读算出的前缀字节证明（增量续折用；全量时为 null） */
  prefix_proof: LedgerPrefixProof | null;
  file_bytes: number;
  /** 扫描期间文件被判定为"在变"（重试后仍未稳定）：本次不缓存，结果按最后一次现读如实给出 */
  unstable: boolean;
}

/** 一条读不出来的行（尾行半截或中段损坏），带出错时的行号与原文片段 */
export interface CorruptLine {
  line: number;
  raw: string;
  reason: string;
}

interface ScanParse {
  file_bytes: number;
  ends_with_newline: boolean;
  last_newline_end: number;
  /** sha256(账本字节 [0, last_newline_end))，与本次产出的事件来自同一遍读 */
  prefix_sha256: string;
  /** checkpoint 行边界处的中间摘要（前缀复用证明用）；checkpoint<=0 或未命中为 null */
  checkpoint_digest: string | null;
  /** 只含起始偏移 ≥ checkpoint 的行（= 需要重解析的后缀） */
  events: WorkEvent[];
  tail: CorruptLine | null;
  /** 全文件的行总数（含被跳过的前缀行；全局行号以此为口径） */
  line_count: number;
  max_line_bytes: number;
  /** 扫描期间文件在变（读到的字节数/大小/身份与打开时不一致） */
  unstable: boolean;
}

/**
 * **一遍**流式扫过账本：同时得到 (a) 完整行覆盖的 sha256 前缀摘要、(b) `checkpoint` 偏移处的中间摘要、
 * (c) 行切分与逐行校验（只校验起始偏移 ≥ checkpoint 的行）、(d) 半截尾现场、(e) 扫描期间是否在变。
 *
 * 一次读、同一份字节既产出摘要又产出事件——这就杜绝了"摘要证明的是这一次字节、事件来自另一次读"的错配。
 * `checkpoint` 处必须是行边界；为 0 表示全量校验（无前缀可跳过）。
 */
function scanAndParse(file: string, checkpoint: number): ScanParse {
  const fd = fs.openSync(file, "r");
  try {
    const st = fs.fstatSync(fd);
    const size = st.size;
    const hash = crypto.createHash("sha256");
    const buf = Buffer.allocUnsafe(CHUNK_BYTES);
    let pending = Buffer.alloc(0);
    let pendingStart = 0;
    let pos = 0;
    let lineNo = 0;
    let lastNewlineEnd = 0;
    let lastByte = -1;
    let checkpointDigest: string | null = null;
    let maxLineBytes = 0;
    const events: WorkEvent[] = [];
    const corrupt: CorruptLine[] = [];
    let hashed = 0;

    /** 消费一条完整行（含 `\n`）：先把它的字节并入摘要，再按需解析（前缀行只切不解析） */
    const consumeLine = (lineStartAbs: number, lineEndAbs: number, lineBytes: Buffer): void => {
      const len = lineEndAbs - lineStartAbs;
      if (len > maxLineBytes) maxLineBytes = len;
      hash.update(lineBytes);
      if (checkpoint > 0 && checkpointDigest === null && lineEndAbs >= checkpoint) {
        checkpointDigest = hash.copy().digest("hex");
      }
      lastNewlineEnd = lineEndAbs;
      lineNo += 1;
      if (lineStartAbs < checkpoint) return; // 前缀行：字节摘要已证明其未变，跳过重解析
      const text = lineBytes.toString("utf8").trim();
      if (text === "") return;
      try {
        events.push(validateWorkEvent(JSON.parse(text)));
      } catch (e) {
        corrupt.push({
          line: lineNo,
          raw: text.slice(0, RAW_KEEP_CHARS),
          reason: e instanceof Error ? e.message : String(e),
        });
      }
    };

    while (pos < size) {
      const n = fs.readSync(fd, buf, 0, Math.min(CHUNK_BYTES, size - pos), pos);
      if (n <= 0) break;
      const chunk = buf.subarray(0, n);
      hashed += n;
      // 行切分：pending 为空时直接在当前读块上切（不整块复制）；只在需要跨块拼接时才 concat。
      // 末尾残留一律 `Buffer.from` 脱离共享 buf（下一次 readSync 会覆盖它）。
      const hasPending = pending.length > 0;
      const src = hasPending ? Buffer.concat([pending, chunk]) : chunk;
      const srcStart = hasPending ? pendingStart : pos;
      let consumed = 0;
      for (;;) {
        const idx = src.indexOf(LF, consumed);
        if (idx < 0) break;
        consumeLine(srcStart + consumed, srcStart + idx + 1, src.subarray(consumed, idx + 1));
        consumed = idx + 1;
      }
      if (consumed > 0) {
        pending = Buffer.from(src.subarray(consumed));
        pendingStart = srcStart + consumed;
      } else {
        pending = Buffer.from(src); // 这一块整块都还没凑出行尾（长行跨块）：留到下次拼接
        pendingStart = srcStart;
      }
      lastByte = chunk[n - 1]!;
      pos += n;
    }
    const endsWithNewline = size === 0 || lastByte === LF;

    // 末行没有换行收尾：它是半截尾现场，**不并入摘要**（所以 prefix_sha256 覆盖 [0, lastNewlineEnd)）
    if (pending.length > 0) {
      lineNo += 1;
      if (pending.length > maxLineBytes) maxLineBytes = pending.length;
      if (pendingStart >= checkpoint) {
        const text = pending.toString("utf8").trim();
        if (text !== "") {
          try {
            events.push(validateWorkEvent(JSON.parse(text)));
          } catch (e) {
            corrupt.push({
              line: lineNo,
              raw: text.slice(0, RAW_KEEP_CHARS),
              reason: e instanceof Error ? e.message : String(e),
            });
          }
        }
      }
    }

    // 与 loadEvents 同一口径：只有"最后一行 + 文件未以换行收尾"才是可容忍的半截尾，其余暴露
    let tail: CorruptLine | null = null;
    if (!endsWithNewline && corrupt.length > 0 && corrupt[corrupt.length - 1]!.line === lineNo) {
      tail = corrupt.pop() ?? null;
    }
    if (corrupt.length > 0) {
      const first = corrupt[0]!;
      throw new WorkError(
        "MIDDLE_CORRUPT",
        `事件文件中段损坏，塔台拒绝跳过：${LEDGER_FILE_NAME} 第 ${first.line} 行不是合法事件（${first.reason}）。` +
          `共 ${corrupt.length} 处；请先核对现场再从最后一个完整事件之后重建，不要手工删中间行`,
        { file: LEDGER_FILE_NAME, line: first.line, reason: first.reason, count: corrupt.length },
      );
    }

    // 稳定性：读到末尾后重查大小；再按路径重查身份/大小（应对"读到一半被截断/替换"）
    const stEnd = fs.fstatSync(fd);
    let unstable = pos < size || stEnd.size !== size;
    if (!unstable) {
      try {
        const stNow = fs.statSync(file);
        unstable = stNow.size !== size || stNow.ino !== st.ino || stNow.dev !== st.dev;
      } catch {
        unstable = true; // 读到一半文件没了：按"在变"处理
      }
    }

    stats.hashed_bytes += hashed;
    return {
      file_bytes: size,
      ends_with_newline: endsWithNewline,
      last_newline_end: lastNewlineEnd,
      prefix_sha256: hash.digest("hex"),
      checkpoint_digest: checkpointDigest,
      events,
      tail,
      line_count: lineNo,
      max_line_bytes: maxLineBytes,
      unstable,
    };
  } finally {
    fs.closeSync(fd);
  }
}

/** 深冻结：事件对象（含 payload 嵌套）在缓存里只读——外部改写返回对象会抛错，污染不进权威读取 */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

function evictIfNeeded(): void {
  let total = 0;
  for (const entry of cache.values()) total += entry.bytes;
  while (cache.size > EVENT_READ_CACHE_MAX_ENTRIES || total > EVENT_READ_CACHE_MAX_TOTAL_BYTES) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    const entry = cache.get(oldest);
    if (entry !== undefined) total -= entry.bytes;
    cache.delete(oldest);
  }
}

/**
 * 读账本（内容验证 + 有界解析缓存 + 合法追加仅解析后缀）。
 *
 * 与 `loadEvents` 语义等价：返回同一组事件、同一种半截尾、同一种 `MIDDLE_CORRUPT`。
 * 不同只在**代价**：内容未变或只追加时不再重新解析已有行。
 */
export function readLedger(workDir: string): LedgerRead {
  const file = ledgerEventsPath(workDir);
  const key = path.resolve(workDir);
  stats.reads += 1;

  if (!fs.existsSync(file)) {
    cache.delete(key);
    stats.empty_reads += 1;
    return {
      events: [],
      tail: null,
      content: { file_bytes: 0, verified_bytes: 0, prefix_sha256: EMPTY_SHA256 },
      origin: "empty",
      reused_prefix_events: 0,
      reparsed_events: 0,
      fell_back_to_full: false,
      fallback_reason: null,
      prefix_proof: null,
      file_bytes: 0,
      unstable: false,
    };
  }

  const prev = cache.get(key) ?? null;
  const checkpoint = prev !== null ? prev.content.verified_bytes : 0;

  // 首次读取和前缀失配后的全量回退必须经过同一个稳定性门禁。
  function stableScan(start: number) {
    let attempt = 0;
    let scan = scanAndParse(file, start);
    while (scan.unstable && attempt < MAX_UNSTABLE_RETRIES) {
      attempt += 1;
      // 不稳定现场的偏移不可信：重试一律从 0 全量。
      scan = scanAndParse(file, 0);
    }
    if (scan.unstable) {
      stats.unstable_reads += 1;
      cache.delete(key);
      throw new WorkError(
        "LEDGER_UNSTABLE",
        `读取 ${LEDGER_FILE_NAME} 时文件持续在被改写（短读/并发追加/替换），已重试 ${MAX_UNSTABLE_RETRIES} 次仍未稳定；` +
          "拒绝返回可能混合两个版本的读取结果，请稍后重试或停止写入后再读",
        { file: LEDGER_FILE_NAME, work_dir: key, retries: MAX_UNSTABLE_RETRIES, file_bytes: scan.file_bytes },
      );
    }
    return { scan, attempt };
  }
  const first = stableScan(checkpoint);
  let scan = first.scan;
  const attempt = first.attempt;

  // 只有"第一次尝试、整行收尾、且前缀摘要对上"才允许复用（现场在变已在上面直接拒绝，不会走到这里）
  const canReuse =
    prev !== null &&
    attempt === 0 &&
    scan.ends_with_newline &&
    scan.file_bytes >= checkpoint &&
    (checkpoint === 0
      ? prev!.content.verified_bytes === 0 && prev!.content.prefix_sha256 === EMPTY_SHA256
      : scan.checkpoint_digest !== null && scan.checkpoint_digest === prev!.content.prefix_sha256);

  let origin: "full" | "incremental" = "full";
  let events: WorkEvent[];
  let reused = 0;
  let reparsed: number;
  let fellBack = false;
  let reason: string | null = null;
  let prefixProof: LedgerPrefixProof | null = null;

  if (prev === null) {
    events = scan.events;
    reparsed = scan.events.length;
  } else if (canReuse) {
    origin = "incremental";
    events = [...prev.events, ...scan.events];
    reused = prev.events.length;
    reparsed = scan.events.length;
    prefixProof = {
      prefix_bytes: checkpoint,
      prefix_sha256: prev.content.prefix_sha256,
      file_bytes: scan.file_bytes,
    };
  } else {
    fellBack = true;
    reason =
      attempt > 0
        ? "file_changing"
        : scan.file_bytes < checkpoint
          ? "file_shrank"
          : !scan.ends_with_newline
            ? "missing_trailing_newline"
            : "prefix_mismatch";
    if (attempt === 0) scan = stableScan(0).scan; // 丢掉后缀扫描，重来全量并重新核验稳定性
    events = scan.events;
    reparsed = scan.events.length;
    stats.fell_back += 1;
  }

  const verified_bytes = scan.ends_with_newline ? scan.file_bytes : scan.last_newline_end;
  const content: LedgerContentFingerprint = {
    file_bytes: scan.file_bytes,
    verified_bytes,
    prefix_sha256: scan.prefix_sha256,
  };

  if (origin === "full") stats.full_reads += 1;
  else stats.incremental_reads += 1;
  stats.reused_events += reused;
  stats.reparsed_events += reparsed;

  const prevMaxLine = origin === "incremental" && prev !== null ? prev.max_line_bytes : 0;
  const maxLineBytes = Math.max(prevMaxLine, scan.max_line_bytes);
  const cacheable =
    scan.ends_with_newline &&
    scan.file_bytes <= EVENT_READ_CACHE_MAX_ENTRY_BYTES &&
    events.length <= EVENT_READ_CACHE_MAX_ENTRY_EVENTS &&
    maxLineBytes <= EVENT_READ_CACHE_MAX_LINE_BYTES;

  if (cacheable) {
    const frozenEvents = Object.freeze(events.map((e) => deepFreeze(e))) as readonly WorkEvent[];
    const entry: CacheEntry = {
      events: frozenEvents,
      content,
      line_count: scan.line_count,
      bytes: scan.file_bytes,
      max_line_bytes: maxLineBytes,
      // 增量续折要保住上一版基线；全量重折（含改写/替换）则丢弃旧基线，绝不拿旧内容续折
      foldBase: origin === "incremental" ? (prev?.foldBase ?? null) : null,
    };
    cache.delete(key); // 先删再插：Map 的插入序即 LRU 序
    cache.set(key, entry);
    evictIfNeeded();
    return {
      events: frozenEvents.slice(),
      tail: scan.tail,
      content,
      origin,
      reused_prefix_events: reused,
      reparsed_events: reparsed,
      fell_back_to_full: fellBack,
      fallback_reason: reason,
      prefix_proof: prefixProof,
      file_bytes: scan.file_bytes,
      unstable: false,
    };
  }

  cache.delete(key);
  // 未进缓存：这份事件数组是本进程新建、无人共享，直接交给调用方（无污染风险）
  return {
    events,
    tail: scan.tail,
    content,
    origin,
    reused_prefix_events: reused,
    reparsed_events: reparsed,
    fell_back_to_full: fellBack,
    fallback_reason: reason,
    prefix_proof: prefixProof,
    file_bytes: scan.file_bytes,
    unstable: false,
  };
}

/**
 * 取缓存里该账本的权威事件数组与折叠基线（快照层用）。
 * 返回 null 表示该账本当前未被缓存（超限/半截尾/现场在变）；调用方据此退化为全量。
 */
export function peekLedgerEntry(
  workDir: string,
): { events: readonly WorkEvent[]; foldBase: FoldBase | null; content: LedgerContentFingerprint } | null {
  const entry = cache.get(path.resolve(workDir));
  if (entry === undefined) return null;
  // 事件数组是冻结的（可共享）；折叠基线做**防御性拷贝**——调用方拿到的 entities/Map 是独立副本，
  // 改它碰不到缓存本体，下一次快照因此不会被"上一次取基线时顺手改了什么"污染（V09-38 复审：Map/实体隔离）。
  return { events: entry.events, foldBase: cloneFoldBase(entry.foldBase), content: { ...entry.content } };
}

/** 折叠基线的防御性拷贝（实体新壳；payload 视为不可变沿用引用；幂等键表复制一份） */
function cloneFoldBase(base: FoldBase | null): FoldBase | null {
  if (base === null) return null;
  const entities: Record<string, WorkEntityState> = {};
  for (const key of Object.keys(base.entities)) {
    const e = base.entities[key]!;
    entities[key] = {
      revision: e.revision,
      type: e.type,
      last_event_id: e.last_event_id,
      updated_at: e.updated_at,
      payload: e.payload,
    };
  }
  return {
    content: { ...base.content },
    folded_events: base.folded_events,
    last_seq: base.last_seq,
    last_event_id: base.last_event_id,
    entities,
    seen_keys: new Map(base.seen_keys),
    ...(base.seen_keys_complete === false ? { seen_keys_complete: false } : {}),
  };
}

/** 推进缓存里的折叠基线（只允许由快照层在证明成立后写；不影响任何事实源） */
export function setLedgerFoldBase(workDir: string, base: FoldBase): void {
  const entry = cache.get(path.resolve(workDir));
  if (entry !== undefined) entry.foldBase = base;
}

export function eventReadCacheStats(): EventReadCacheStats {
  let bytes = 0;
  for (const entry of cache.values()) bytes += entry.bytes;
  return {
    entries: cache.size,
    bytes,
    max_entries: EVENT_READ_CACHE_MAX_ENTRIES,
    max_total_bytes: EVENT_READ_CACHE_MAX_TOTAL_BYTES,
    max_entry_bytes: EVENT_READ_CACHE_MAX_ENTRY_BYTES,
    max_entry_events: EVENT_READ_CACHE_MAX_ENTRY_EVENTS,
    max_line_bytes: EVENT_READ_CACHE_MAX_LINE_BYTES,
    ...stats,
  };
}

/** 清空缓存（测试与"现场已变、主动弃用"用；不影响任何事实源） */
export function clearEventReadCache(): void {
  cache.clear();
}

/** 仅供验证脚本调低上限用：证明淘汰与"超上限不缓存"确实生效（不改默认值的动因） */
export function setEventReadCacheLimitsForTest(limits: {
  max_entries?: number;
  max_total_bytes?: number;
  max_entry_bytes?: number;
  max_entry_events?: number;
  max_line_bytes?: number;
}): void {
  if (limits.max_entries !== undefined) EVENT_READ_CACHE_MAX_ENTRIES = limits.max_entries;
  if (limits.max_total_bytes !== undefined) EVENT_READ_CACHE_MAX_TOTAL_BYTES = limits.max_total_bytes;
  if (limits.max_entry_bytes !== undefined) EVENT_READ_CACHE_MAX_ENTRY_BYTES = limits.max_entry_bytes;
  if (limits.max_entry_events !== undefined) EVENT_READ_CACHE_MAX_ENTRY_EVENTS = limits.max_entry_events;
  if (limits.max_line_bytes !== undefined) EVENT_READ_CACHE_MAX_LINE_BYTES = limits.max_line_bytes;
  evictIfNeeded();
}

/** 复位为默认上限（验证脚本收尾用） */
export function resetEventReadCacheLimits(): void {
  EVENT_READ_CACHE_MAX_ENTRIES = 8;
  EVENT_READ_CACHE_MAX_TOTAL_BYTES = 128 * 1024 * 1024;
  EVENT_READ_CACHE_MAX_ENTRY_BYTES = 64 * 1024 * 1024;
  EVENT_READ_CACHE_MAX_ENTRY_EVENTS = 40_000;
  EVENT_READ_CACHE_MAX_LINE_BYTES = 8 * 1024 * 1024;
  evictIfNeeded();
}
