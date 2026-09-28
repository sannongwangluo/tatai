// P3 全局变更流（PLAN P3 卡；`DESIGN.md` §2.3.5 字段不变 / §11.2 二期「全局变更流」）。
//
// 一句话：把各项目 `<项目根>/.工作台/changes.jsonl` 合并成**一条**时间倒序的全局流，供跨项目视图查看。
//
// ███ 字段口径（DoD①）：§2.3.5 的 ts/path/action/size_delta 一字不改，只**追加**两个字段 ███
//   project_id / project_name —— 来自注册表（不是流水文件里的字段，所以不会和 §2.3.5 打架）。
//   行类型 `GlobalChangeLine extends ChangeLine`，前端两处流水（H3 单项目 / P3 全局）共用同一个行渲染器
//   （src/ui/components/ChangesView.tsx），字段渲染只有一份（DoD④）。
//
// ███ 性能口径（DoD③；PLAN P3 跑偏点「全量读进内存再排序」是红线）███
// readChanges 那套「readFileSync 全量 + reverse」在单项目几千行上够用，项目一多就是"把 N 个项目的
// 10 万行读成对象再 sort"。本模块一律走**窗口读**：
//   1) 倒读行流（iterLinesDescending）：每个文件从尾部按 64KB 块往前读、块内按 \n 切行，产出一条
//      「最新在前」的原始行流。内存与块同阶（64KB），与文件大小无关；行按 \n 字节边界切、整行整行地
//      decode，UTF-8 多字节字符不会被块边界劈成半个（中文路径安全）。
//   2) K 路归并（最大堆）：N 条"各自已倒序"的行流做全局排序。要第 1 页 200 行就只解析 200 多行
//      （每个项目最多再多解析 1 行做比较），不会顺带把没要的行解析成对象。
//   3) total 走**流式行计数**（countLines：只数换行字节、不解析 JSON、O(1) 内存），是**精确值**不是
//      估算；计数结果按 (size, mtimeMs) 缓存——changes.jsonl 只追加，size 一变即失效，重复翻页不再读盘。
//   4) offset 是**顺流丢弃**：要 offset=95000 就得真的流过那 9.5 万行（内存不变，I/O 变多）。UI 是
//      「加载更多」逐页追加，不存在深翻页，因此不为此提前建索引。
//   5) limit 有上下限（缺省 200 / 上限 2000）：`?limit=` 要 10 万行就等于要"全读进内存"，一律明示拒绝
//      （400 INVALID_INPUT），不静默截断。
//
// ███ 排序口径（DoD① 的"按时间倒序"）███
// 主键 ts 倒序（一律 Date.parse 成毫秒再比：changes 的 ts 是本地 ISO 带偏移，字符串直比会跨时区比错，
// H2 踩过）；同刻按 project_id 升序（跨项目确定序）；同项目同刻按"文件里更靠后的那条在前"（倒读流的
// 自然顺序）。ts 解析不出来的行按 -Infinity 排在最后（不倒挂、不抛）。
// 归并的正确性前提：**每个项目的 changes.jsonl 自身按 ts 非降序追加**（watcher 落盘即 nowIso() 顺序）。
//
// ███ 坏行口径 ███
// 行校验复用 watcher#parseChangeLine（唯一一份）。撞到坏行时**摘除该项目**并把它的行数从 total 扣掉，
// 同时登记进响应的 `errors[]`——坏文件不许让一屏全黑（P2 同一条），但也不静默跳过（errors 里明说）。
// 注意窗口读是惰性的：坏行只在归并**读到它**时才被发现（浅窗口可能扫不到深处的坏行），
// 这是"只读窗口"的固有取舍，已登记进 PROGRESS。

import fs from "node:fs";
import path from "node:path";
import { getProject, listProjects, type ProjectRecord } from "./registry";
import { parseChangeLine, MAX_CHANGE_LINE_BYTES, type ChangeLine } from "./watcher";
import { WsError } from "./workstation";
import { sanitizeErrorMessage } from "./redact";

/** changes.jsonl 一行 + P3 追加的归属字段（DoD①：每条标明所属项目；既有三字段原样） */
export interface GlobalChangeLine extends ChangeLine {
  project_id: string;
  project_name: string;
}

/** 缺省每页条数（与 H3 前端 PAGE_SIZE 同值：两处流水都按 200 一页加载） */
export const GLOBAL_CHANGES_DEFAULT_LIMIT = 200;
/**
 * 每页上限（硬闸门，超了明示拒绝）：全局流的成本是 limit × 行宽，
 * 不设上限就等于允许"一次把 10 万行读进内存"——正是本卡跑偏点要防的事。
 */
export const GLOBAL_CHANGES_MAX_LIMIT = 2000;

/** 倒读块大小：一次性从文件尾读这么多字节来切行（内存与块同阶，与文件大小无关） */
const CHUNK_BYTES = 64 * 1024;
/**
 * 单行字节上限（Q97，2026-09-18 审计；Q134 起**数值挪到 `watcher.ts` 单一出处**）：
 * 倒读要靠 `head` 把"上一块开头的残缺行"攒起来，`head` 的长度 = 当前行的长度——块里找不到 `\n`
 * 就整块不切，于是行长无上限时内存随行无界增长。姊妹实现 `watcher.iterTailLines` 也要同一条闸，
 * 两个数值曾各写一份（Q134 指出这正是"只修一处"的温床），现统一用 `MAX_CHANGE_LINE_BYTES`。
 * 正常流水一行 ~百字节（watcher 自己写的），1 MiB 已极宽松；超了按坏文件口径处理（见下面抛错处）。
 */
/** 换行字节 */
const LF = 0x0a;

export interface GlobalChangesQuery {
  limit?: number;
  offset?: number;
  /** 可选：只合并这一项目的流水（DoD② 的单项目过滤） */
  projectId?: string;
}

/** 某个项目读失败（文件损坏等）——响应的顶层字段，**不是行字段**（不加宽 GlobalChangeLine） */
export interface GlobalChangesError {
  project_id: string;
  message: string;
}

export interface GlobalChangesStats {
  /** 本请求服务端总耗时（ms） */
  ms: number;
  /** 数总行数耗时（ms；命中缓存时≈0——这是翻页比首屏快的直接原因） */
  count_ms: number;
  /** 归并窗口耗时（ms） */
  merge_ms: number;
  /** 参与归并的数据源数（= 有 changes.jsonl 的项目数；没变更过的项目不占数据源） */
  sources: number;
  /** 命中行数缓存的源数 */
  cached_sources: number;
  /** total 的口径标识：本卡是**精确行数**，不是估算（口径见文件头第 3 条） */
  total_kind: "exact_line_count";
}

export interface GlobalChangesResult {
  /** 窗口内的行（时间倒序，最新在前） */
  changes: GlobalChangeLine[];
  /** 合并后的总条数（精确；被摘除的项目已扣除） */
  total: number;
  /** 读失败的项目（有内容就上屏警告条；不静默丢） */
  errors: GlobalChangesError[];
  stats: GlobalChangesStats;
}

// ───────────────────────────── 倒读行流 + 流式计数 ─────────────────────────────

/** 项目流水的绝对路径（口径与 watcher#changesJsonlPath 一致：`<项目根>/.工作台/changes.jsonl`） */
function changesFileOf(root: string): string {
  return path.join(root, ".工作台", "changes.jsonl");
}

/**
 * 从文件尾部按块往前读，产出**最新在前**的原始行（不含尾部的换行）。惰性生成器：
 * 只在调用方 `.next()` 时才读下一块，故"只看第一页"就只读一块多一点，与文件总大小无关。
 * 切行按 `\n` 字节边界（`lastIndexOf`），每行都是完整字节段才 decode —— UTF-8 多字节字符安全。
 *
 * Q97：内存与块同阶的前提是"行长有界"。`head` 攒的就是当前行，一旦某行超过 `MAX_CHANGE_LINE_BYTES`
 * （正常流水不可能，只有外部程序/手工写坏才会），就抛 `CHANGES_JSONL_CORRUPT` 让消费端按坏文件
 * 口径摘除该项目——不为了读一行把内存涨到行长度。抛错时 fd 仍由本函数的 finally 关掉。
 * （姊妹实现 `watcher.iterTailLines` 走的是另一条处置：丢掉超长行继续读，两处差异见各自注释。）
 */
function* iterLinesDescending(file: string): Generator<string> {
  const fd = fs.openSync(file, "r");
  try {
    let pos = fs.fstatSync(fd).size;
    let head = Buffer.alloc(0); // 上一块开头的残缺行，与下一块拼起来
    while (pos > 0) {
      const len = Math.min(CHUNK_BYTES, pos);
      const start = pos - len;
      const buf = Buffer.allocUnsafe(len);
      fs.readSync(fd, buf, 0, len, start);
      pos = start;
      const combined = head.length > 0 ? Buffer.concat([buf, head]) : buf;
      let end = combined.length;
      const lines: string[] = [];
      while (end > 0) {
        const idx = combined.lastIndexOf(LF, end - 1);
        if (idx < 0) break;
        lines.push(combined.subarray(idx + 1, end).toString("utf8"));
        end = idx;
      }
      head = Buffer.from(combined.subarray(0, end));
      if (head.length > MAX_CHANGE_LINE_BYTES) {
        throw new WsError(
          "CHANGES_JSONL_CORRUPT",
          `changes.jsonl 有一行超过 ${MAX_CHANGE_LINE_BYTES} 字节上限（倒读缓冲只保证与行长有界）：${file}`,
        );
      }
      for (const line of lines) yield line; // 本块攒下的行（块内已是最新在前）
    }
    if (head.length > 0) yield head.toString("utf8"); // 首行没有换行收尾的情形
  } finally {
    fs.closeSync(fd);
  }
}

/** 行数缓存：键为文件路径，值为 (size, mtimeMs) 与当时数到的行数（只缓存总数，窗口内容永远现读） */
interface CountCacheEntry {
  size: number;
  mtimeMs: number;
  lines: number;
}
const countCache = new Map<string, CountCacheEntry>();
/** 缓存条目上限（项目增删会留旧键；超了整体清空，不做 LRU——这是个位数项目量的表） */
const COUNT_CACHE_MAX = 500;

/** 数文件里有多少行（O(1) 内存：只扫换行字节，不解析、不切数组） */
function countLinesUncached(file: string, size: number): number {
  if (size === 0) return 0;
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.allocUnsafe(CHUNK_BYTES);
    let lines = 0;
    let endsWithLf = false;
    for (;;) {
      const n = fs.readSync(fd, buf, 0, CHUNK_BYTES, null);
      if (n <= 0) break;
      for (let i = 0; i < n; i++) if (buf[i] === LF) lines++;
      endsWithLf = buf[n - 1] === LF;
    }
    return endsWithLf ? lines : lines + 1; // 末行没有换行收尾也算一行
  } finally {
    fs.closeSync(fd);
  }
}

/** 带缓存的行数（口径：按换行计——watcher 每行都以 \n 收尾、不写空行，故等于流水行数） */
function countLines(file: string, size: number, mtimeMs: number): { lines: number; cached: boolean } {
  const hit = countCache.get(file);
  if (hit && hit.size === size && hit.mtimeMs === mtimeMs) {
    return { lines: hit.lines, cached: true };
  }
  const lines = countLinesUncached(file, size);
  if (countCache.size >= COUNT_CACHE_MAX) countCache.clear();
  countCache.set(file, { size, mtimeMs, lines });
  return { lines, cached: false };
}

// ───────────────────────────── K 路归并 ─────────────────────────────

/** 一个项目的数据源：一条"已倒序"的行流 + 归并用的队头 */
interface Source {
  project: ProjectRecord;
  /** 倒序行流（惰性） */
  iter: Iterator<string>;
  /** 队头（已解析、未出队）；null = 该源已耗尽或被摘除 */
  head: GlobalChangeLine | null;
  /** 队头的自增序号：ts 与 project_id 都相同时"先拉到的在前"（同项目内 = 文件里更靠后的） */
  headSeq: number;
  /** 下一个自增序号 */
  seq: number;
  /** 已成功解析的行数（含被 offset 跳过的）——摘除本源时用它把 total 扣准 */
  pulled: number;
  /** 本文件总行数（流式计数） */
  count: number;
}

/** ts → 毫秒；解析不出来的按 -Infinity（排最后，不倒挂、不抛） */
function tsMs(ts: string): number {
  const n = Date.parse(ts);
  return Number.isFinite(n) ? n : -Infinity;
}

/** 归并顺序（true = a 先出队 = a 更新）：ts 倒序 → project_id 升序 → 源内序号升序 */
function newerFirst(a: Source, b: Source): boolean {
  const ta = tsMs(a.head!.ts);
  const tb = tsMs(b.head!.ts);
  if (ta !== tb) return ta > tb;
  if (a.project.id !== b.project.id) return a.project.id < b.project.id;
  return a.headSeq < b.headSeq;
}

/**
 * 手写最大堆（零依赖，与仓内"不引清单外框架"一致）：只装 N 个源（N = 项目数，个位数），
 * 不需要工业级实现；比较函数就是上面那条归并顺序。
 */
class SourceHeap {
  private items: Source[] = [];

  get size(): number {
    return this.items.length;
  }

  push(item: Source): void {
    const items = this.items;
    items.push(item);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!newerFirst(items[i], items[parent])) break;
      [items[i], items[parent]] = [items[parent], items[i]];
      i = parent;
    }
  }

  /** 弹出"最新"的源（堆顶）；空堆返回 null */
  pop(): Source | null {
    const items = this.items;
    if (items.length === 0) return null;
    const top = items[0];
    const last = items.pop()!;
    if (items.length > 0) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let best = i;
        if (l < items.length && newerFirst(items[l], items[best])) best = l;
        if (r < items.length && newerFirst(items[r], items[best])) best = r;
        if (best === i) break;
        [items[i], items[best]] = [items[best], items[i]];
        i = best;
      }
    }
    return top;
  }
}

/** 归并过程中会被改动的两份状态（total 要按摘除的源扣、errors 要累积） */
interface MergeContext {
  total: number;
  errors: GlobalChangesError[];
}

/** 拉该源的下一条到队头；返回 false = 没有队头（耗尽或被摘除） */
function advance(ctx: MergeContext, src: Source): boolean {
  for (;;) {
    let next: IteratorResult<string>;
    try {
      next = src.iter.next();
    } catch (e) {
      // Q97（2026-09-18 审计）：行流自己抛错（超长行 → CHANGES_JSONL_CORRUPT，或读盘中途失败）——
      // 与坏行同一处置：摘除该项目、把它还没贡献给窗口的行数从 total 扣掉、登记进 errors[]，
      // 不让"一个坏文件"把整屏全局流带崩。message 过消息级脱敏（可能含本机绝对路径）。
      ctx.total -= src.count - src.pulled;
      ctx.errors.push({
        project_id: src.project.id,
        message: sanitizeErrorMessage((e as Error).message),
      });
      src.head = null;
      return false;
    }
    if (next.done) {
      src.head = null;
      return false;
    }
    const text = next.value.trim();
    if (text === "") continue; // 空行不算行（与 readChanges 的 trim() === "" 跳过分口径一致）
    try {
      const parsed = parseChangeLine(
        text,
        `${src.project.id} changes.jsonl 倒序第 ${src.pulled + 1} 行`,
      );
      src.head = { ...parsed, project_id: src.project.id, project_name: src.project.name };
      src.headSeq = src.seq++;
      src.pulled++;
      return true;
    } catch (e) {
      // 坏行：摘除本源（不静默跳过），并把它还没贡献给窗口的行数从 total 扣掉，
      // 保证 total 恒等于"从 offset 0 一路翻下去能拿到的总条数"
      // Q68（2026-09-18 审计）：与 summary.ts 同一处口径——这条 message 会经 `GET /api/changes/all`
      // 出网（前端渲染"N 个项目读失败"），过一遍消息级脱敏（fs 级异常原文可能带本机绝对路径）。
      ctx.total -= src.count - src.pulled;
      ctx.errors.push({ project_id: src.project.id, message: sanitizeErrorMessage((e as Error).message) });
      src.head = null;
      return false;
    }
  }
}

/**
 * 合并各项目 changes.jsonl 成一条时间倒序的全局流（DoD①②③）。
 * 只解析窗口要用到的行：`offset` 之前的行顺流丢弃，凑够 `limit` 立即停手。
 */
export function queryGlobalChanges(query: GlobalChangesQuery = {}): GlobalChangesResult {
  const t0 = Date.now();
  const limit = query.limit ?? GLOBAL_CHANGES_DEFAULT_LIMIT;
  if (!Number.isFinite(limit) || limit < 0) {
    throw new WsError("INVALID_INPUT", `limit 必须是非负数字: ${JSON.stringify(query.limit)}`);
  }
  if (limit > GLOBAL_CHANGES_MAX_LIMIT) {
    throw new WsError(
      "INVALID_INPUT",
      `limit ${limit} 超过全局变更流上限 ${GLOBAL_CHANGES_MAX_LIMIT}（全局流是窗口读，一次要更多行就等于把全部流水读进内存）`,
    );
  }
  const offset = query.offset ?? 0;
  if (!Number.isFinite(offset) || offset < 0) {
    throw new WsError("INVALID_INPUT", `offset 必须是非负数字: ${JSON.stringify(query.offset)}`);
  }

  // 候选项目：给了 project_id 就只这一个（DoD② 的过滤口径：从**候选集**就缩小，不是读完全部再筛）；
  // 没给就取全部已登记项目。
  let projects: ProjectRecord[];
  if (query.projectId !== undefined && query.projectId !== "") {
    const one = getProject(query.projectId);
    if (!one) throw new WsError("PROJECT_NOT_FOUND", `项目不存在: ${query.projectId}`);
    projects = [one];
  } else {
    projects = listProjects();
  }

  const tCount = Date.now();
  const ctx: MergeContext = { total: 0, errors: [] };
  const sources: Source[] = [];
  let cachedSources = 0;
  for (const project of projects) {
    const file = changesFileOf(project.path);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        continue; // 还没变更过（没有 changes.jsonl）= 正常空态，不是错误
      }
      // Q93（2026-09-18 审计）：EACCES/EPERM/EBUSY/EIO…此前与 ENOENT 同一处理——`continue` 一走了之，
      // 于是该项目**静默**从全局流里消失（total 不加、sources 不列、errors 里也没有它）。
      // 现在按"读失败"如实登记（与坏行路径同一个出口），前端会显示"N 个项目读失败"。
      const code = (e as NodeJS.ErrnoException).code ?? "";
      ctx.errors.push({
        project_id: project.id,
        message: `changes.jsonl 读不到（${code || "未知错误"}）: ${sanitizeErrorMessage((e as Error).message)}`,
      });
      continue;
    }
    const counted = countLines(file, stat.size, stat.mtimeMs);
    if (counted.cached) cachedSources++;
    ctx.total += counted.lines;
    sources.push({
      project,
      iter: iterLinesDescending(file),
      head: null,
      headSeq: 0,
      seq: 0,
      pulled: 0,
      count: counted.lines,
    });
  }
  const countMs = Date.now() - tCount;

  const tMerge = Date.now();
  const heap = new SourceHeap();
  const out: GlobalChangeLine[] = [];
  let seen = 0; // 全局窗口序号（含被 offset 跳过的）
  try {
    for (const src of sources) {
      if (advance(ctx, src)) heap.push(src);
    }
    while (heap.size > 0) {
      const src = heap.pop()!;
      const line = src.head!;
      const index = seen++;
      if (index >= offset) {
        out.push(line);
        if (out.length >= limit) break; // 收满即停：不再往后解析任何行
      }
      if (advance(ctx, src)) heap.push(src);
    }
  } finally {
    // Q45（2026-09-18 审计）：任何提前退出（上面的 break、坏行摘除、抛异常）都要把每个源的行流收掉——
    // `iterLinesDescending` 的 fd 关在生成器自己的 finally 里，只有调 `.return()`（或读到 `.done`）
    // 才会跑；此前 break 直接跳出 while，每个"还有剩余行的源"各挂一个未关的 raw fd（无 GC 兜底），
    // 每次请求泄漏"有流水的项目数"个。未启动过的生成器没有 fd，`.return()` 是安全的空操作。
    for (const src of sources) src.iter.return?.();
  }
  const mergeMs = Date.now() - tMerge;

  return {
    changes: out,
    total: ctx.total,
    errors: ctx.errors,
    stats: {
      ms: Date.now() - t0,
      count_ms: countMs,
      merge_ms: mergeMs,
      sources: sources.length,
      cached_sources: cachedSources,
      total_kind: "exact_line_count",
    },
  };
}
