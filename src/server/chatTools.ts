// 2026-09-19 试用增强二期：聊天工具调用（主人裁定"现在就做全量"）。
// 给 Flash 六只**只读**的"手" + 一只**补全写手**，让聊天能读项目真实文件、与架构图对齐：
//   list_files  列项目文件清单（相对项目根逐行一路径；2026-09-19 试用反馈补——此前模型
//               连"项目里有哪些文件"都摸不到，只能靠 search_code 关键字瞎碰）
//   read_file   读项目内一个文本文件（相对项目根路径，截断有上限）
//   read_files  批量读多个文件（2026-09-19 试用反馈补——此前只能一个一个读，通读全量代码太慢）
//   search_code 全项目关键字搜索（跳过 node_modules/.git 等，返回命中文件与行）
//   get_arch    拿架构图全量渲染数据（顶层模块 + 依赖边 + 聊天补全节点；还没解析过会说明）
//   write_arch  补全架构图（三期，主人拍板）：往**独立的补全层**写概念节点/连边——只增不删
//               静态解析层，重新解析冲不掉；口径与上限见 ../arch/supplement.ts
//   check_arch  架构对账（四期，主人拍板）：机械比对磁盘与合并图，出三类问题清单（悬空 path/
//               重复节点/补全层目录树嫌疑）——"核对三视图与代码"先跑它，不靠人眼一个个对
//
// 口径红线：
// - 文件系统只读：list_files / read_file / read_files / search_code 没有任何写/删/执行能力；
//   设计书落稿仍是聊天 → design.md 的唯一写口（§3.6 不变）；write_arch 只写补全层这一个文件。
// - 路径安全：只准读**项目根目录内**的文件——绝对路径、`..` 穿越在拼路径之前就拒绝
//   （与 chat.ts 的 sessionId 校验同一条红线：伪造形态先拦，不靠事后检查）。
// - 上限：单文件字符上限、搜索扫描文件数/命中数/单文件大小上限、架构图 JSON 截断——
//   防一次工具调用把上下文打爆。
// - 错误即回执：工具失败不抛断聊天，把可读错误作为 tool 消息回给模型（它自己会换路子）；
//   错误文本过 sanitizeErrorMessage 脱敏，不递本机绝对路径。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isJunkDir } from "../arch/config";
import { renderGraph } from "../arch/render";
import { applySupplementInput, MAX_SUP_EDGES, MAX_SUP_NODES } from "../arch/supplement";
import { sanitizeErrorMessage } from "./redact";
import { getProject } from "./registry";
import { workstationDir } from "./workstation";
import type { ToolSpec } from "./flash";

/** read_file 单次读回的字符上限（超长截前段并注明总量） */
const READ_FILE_MAX_CHARS = 48_000;
/** search_code 最多扫描的文件数（防超大目录把请求拖死） */
const SEARCH_MAX_FILES = 8_000;
/** search_code 单文件大小上限（超过跳过，不读） */
const SEARCH_MAX_FILE_BYTES = 1_000_000;
/** search_code 默认/最大命中条数 */
const SEARCH_DEFAULT_HITS = 30;
const SEARCH_MAX_HITS = 60;
/** 单行回显的字符上限（长行截断，行号还在） */
const SEARCH_LINE_MAX_CHARS = 160;
/** get_arch JSON 截断上限 */
const ARCH_JSON_MAX_CHARS = 30_000;
/** list_files 最多列出的文件条数（防超大项目把清单打成小作文） */
const LIST_MAX_ENTRIES = 400;
/** read_files 一次批量最多读的文件数 */
const READ_FILES_BATCH_MAX = 10;
/** read_files 整批总字符上限（超了后续文件注明未读，让模型分批） */
const READ_FILES_TOTAL_MAX_CHARS = 96_000;
// 搜索/列清单跳过的目录：与 A1 解析共用 config.ts#isJunkDir 这**同一份清单**
// （2026-09-19 定版：聊天工具与静态解析跳同一批通用垃圾目录——依赖垃圾/构建产物/塔台自管
// 目录/Python 缓存/*.egg-info；起因是实测第二大脑 scripts/__pycache__ 等 140 个 .pyc
// 混进覆盖对账清单，把真代码淹了）。
/** 搜索的最大目录深度 */
const SEARCH_MAX_DEPTH = 15;

// ── 取回回执与续读游标（PLAN.md V06-04，DESIGN.md §2.8）──
//
// 为什么要有回执：覆盖对账曾按"模型点过的路径"记账（noteReadPaths），于是
// **请求过 = 已读全**——批量读里因总量上限被跳过的文件、不存在的文件、二进制文件、
// 只读到前 48000 字的截断文件，全都被算成"已读"。§2.8 的硬口径是
// "读取请求被提交 ≠ 读取成功；成功读了一段 ≠ 全文件读完"，所以工具必须把
// **真正返回了什么范围**作为回执交出去，账本只认回执，不认请求。
//
// 游标（续读位置）绑定源内容哈希：源一变，旧游标取回必须明确报 SOURCE_CHANGED，
// 不能静默给旧内容（§2.8「长文件必须有分段取回与续读游标，返回总长和已取范围」）。

/** 取回范围的计量单位（文本按行分段：续读游标记的是"下一行"） */
export type CoverageUnit = "lines" | "bytes";

/** 一段已取回的范围（1 起、闭区间） */
export interface CoverageRange {
  unit: CoverageUnit;
  start: number;
  end: number;
}

/** 游标前缀（形态固定，解析失败即拒绝，不做模糊兼容） */
export const CURSOR_PREFIX = "tctx1";

export interface SourceCursor {
  /** 源内容哈希前缀（游标绑定的版本） */
  version: string;
  unit: CoverageUnit;
  /** 下一段起点（1 起） */
  start: number;
  raw: string;
}

/** 造一个续读游标：`tctx1:<内容哈希前 16 位>:<单位>:<下一段起点>` */
export function makeCursor(version: string, unit: CoverageUnit, start: number): string {
  return `${CURSOR_PREFIX}:${version.slice(0, 16)}:${unit}:${start}`;
}

/** 解析游标；形态不合法返回 null（调用方给可读回执，工具永不抛） */
export function parseCursor(cursor: string): SourceCursor | null {
  if (typeof cursor !== "string") return null;
  const m = new RegExp(`^${CURSOR_PREFIX}:([0-9a-f]{8,64}):(lines|bytes):(\\d+)$`).exec(cursor.trim());
  if (m === null) return null;
  const start = Number(m[3]);
  if (!Number.isInteger(start) || start < 1) return null;
  return { version: m[1], unit: m[2] as CoverageUnit, start, raw: cursor.trim() };
}

/** 游标是不是绑在当前源版本上（false = 源变了 → SOURCE_CHANGED，不静默给旧内容） */
export function cursorMatchesVersion(cursor: SourceCursor, version: string): boolean {
  return version.startsWith(cursor.version);
}

/** 读一条来源的结果状态（not_read = 被批总量/清单上限挡下，一个字节都没返回） */
export type ReadStatus = "ok" | "truncated" | "binary_excluded" | "failed" | "not_read";

/**
 * 一次文件取回的真实回执——覆盖账本的唯一依据（工具回给模型的那段文本 = `range` 覆盖的行）。
 * `chars` 是本次返回的**源内容**字符数（不含给模型看的那行范围说明），与 `range` 一致。
 */
export interface ReadReceipt {
  /** 项目根内相对路径（POSIX，与清单口径一致） */
  path: string;
  status: ReadStatus;
  /** 失败/截断原因（ok 为 null）；`source_changed` 单列，调用方据此重读 */
  reason: string | null;
  /** 本次真正返回的范围；一个字节都没返回为 null */
  range: CoverageRange | null;
  /** 同一次取回的字节范围（与 range 对应，记账用） */
  byte_range: CoverageRange | null;
  /** 源总长；读不到为 null */
  total: { lines: number; bytes: number; chars: number } | null;
  /** 全文内容哈希（游标版本）；读不到为 null */
  content_sha256: string | null;
  chars: number;
  /** 从本次范围之后继续读的游标；null = 已到末尾或没得续 */
  next_cursor: string | null;
  /** true = 整个文件都在本次回执里（成功读了一段不等于读完） */
  complete: boolean;
}

/** list_files 的清单回执：清单本身被上限截断时必须如实说（§2.8 不得缩小清单冒充全量） */
export interface ListReceipt {
  scope: string;
  returned: number;
  cap: number;
  truncated: boolean;
}

/** 发给模型的七只手的说明书（JSON Schema 参数） */
export const CHAT_TOOLS: ToolSpec[] = [
  {
    type: "function",
    function: {
      name: "list_files",
      description:
        "列出项目内的文件清单——每行一个相对项目根的路径，先摸清项目里有什么文件再精读。" +
        "path 可选：列某个子目录（默认整个项目根）。自动跳过 node_modules/.git/构建产物；" +
        "清单超 400 项截断注明。返回的路径可直接喂给 read_file / read_files。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "相对项目根的子目录（默认项目根，留空即可）" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "读取本项目内一个文本文件的内容。path 是相对项目根的相对路径（如 src/index.ts）。" +
        "超长文件只返回一段并注明总行数与已取范围，同时在回执里给出续读游标（cursor）——" +
        "要接着读就把该游标原样传回 cursor，不要重头再读。二进制文件拒绝读取。" +
        "源内容变了旧游标会明确报 SOURCE_CHANGED（不会静默给旧内容）。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "相对项目根的文件路径" },
          cursor: {
            type: "string",
            description: "续读游标（上一次读取回执里给的那个；留空 = 从头读）",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_files",
      description:
        "批量读多个文本文件：paths 是相对项目根的路径数组，一次最多 10 个。" +
        "单文件超 4.8 万字只返回一段（带总行数与续读游标，可再用 read_file + cursor 接着读）；" +
        "整批总量超 9.6 万字后，剩余文件注明未读（**未读就是没读到，不算已读**，请分批或单独 read_file）。" +
        "每个文件独立成段（===== 路径 ===== 分隔），读不了的文件段内注明原因。适合整目录通读。",
      parameters: {
        type: "object",
        properties: {
          paths: {
            type: "array",
            description: "要读的文件路径列表（相对项目根，最多 10 个）",
            items: { type: "string" },
          },
        },
        required: ["paths"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_code",
      description:
        "在整个项目的文本文件里按关键字（区分大小写的子串）搜索，返回命中的文件与行号。" +
        "自动跳过 node_modules/.git/构建产物。适合先搜再 read_file 精读。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "要搜的关键字（子串匹配）" },
          max: { type: "number", description: "最多返回多少处命中（默认 30，上限 60）" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_arch",
      description:
        "拿本项目架构图的全量渲染数据（顶层模块与依赖边，与「架构图」页签同一份数据，" +
        "已合并聊天补全节点——带 origin:chat 标记）。还没解析过时返回空态说明。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "write_arch",
      description:
        "给架构图（模块方框图/数据流向图/思维导图三视图共用）**补全**节点与连边：适合把你从" +
        "代码/文档里读出来、但静态解析覆盖不到的概念模块（如「消息总线」「外部服务」）补进图里。" +
        "只增不删解析层：静态解析的节点改不了删不了；补全节点 id 自动加 chat: 前缀、图上带 chat 徽标。" +
        "mode=append 追加（默认），mode=replace 整体重写补全层（空 nodes+edges 即清空全部补全）。" +
        "边的端点可引用解析层模块 id 或补全节点 id（补全节点可省略 chat: 前缀）。回执里有计数与丢弃原因。",
      parameters: {
        type: "object",
        properties: {
          nodes: {
            type: "array",
            description: "要补全的节点（最多累计 100 个）",
            items: {
              type: "object",
              properties: {
                id: { type: "string", description: "节点 id（自动补 chat: 前缀）" },
                name: { type: "string", description: "节点人话名（必填）" },
                blurb: { type: "string", description: "一句话说明它是什么/为什么补" },
                kind: { type: "string", description: "code / data / docs / mixed 之一，缺省 mixed" },
                path: { type: "string", description: "对应真实目录时给相对路径（思维导图按它挂层级）；纯概念留空" },
              },
              required: ["name"],
            },
          },
          edges: {
            type: "array",
            description: "要补的依赖边（from=依赖方 to=被依赖方；最多累计 200 条）",
            items: {
              type: "object",
              properties: {
                from: { type: "string" },
                to: { type: "string" },
                note: { type: "string", description: "这条边的一句话依据" },
              },
              required: ["from", "to"],
            },
          },
          mode: { type: "string", description: "append（默认，追加）/ replace（整体重写补全层）" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "check_arch",
      description:
        "机器对账：服务器机械比对磁盘与合并图（解析层+补全层），返回三类清单——悬空 path（图上节点 path" +
        "在磁盘不存在）、重复节点（同 path 或同 name 多节点）、补全层目录树嫌疑（补全节点 path 与解析层模块" +
        " path 相同或为其子路径）。结尾有总结行，三类全空时明确写「图与代码对齐」。被要求核对三视图与代码时" +
        "先跑它拿清单逐条修，不要自己 list_files 对着图一个个看。还没解析过的项目会说明先解析再对账。",
      parameters: { type: "object", properties: {} },
    },
  },
];

/**
 * 路径安全核心：把模型给的相对路径解析到项目根内。绝对路径 / `..` 穿越 / 空字节一律 null
 * （拼路径之前就拒绝，不靠解析完再检查——chat.ts#assertSessionId 同一条红线）。
 */
export function safeResolve(root: string, rel: string): string | null {
  if (typeof rel !== "string" || rel === "" || rel.includes("\0")) return null;
  if (path.isAbsolute(rel) || /^[a-zA-Z]:[\\/]/.test(rel)) return null;
  if (rel.split(/[\\/]/).includes("..")) return null;
  const rootNorm = path.resolve(root);
  const target = path.resolve(rootNorm, rel);
  if (target !== rootNorm && !target.startsWith(rootNorm + path.sep)) return null;
  return target;
}

/** UTF-8 读出来像不像文本：含 NUL 视为二进制（不猜扩展名，内容说了算） */
function looksBinary(text: string): boolean {
  return text.includes("\0");
}

/** 收集文件清单（相对项目根、正斜杠路径）。doListFiles（模型用，400 截断）与覆盖对账
 *  （chatTurn 用，机械核验读没读全，2026-09-19 主人拍板）共用同一条收集逻辑——清单口径只有一份。 */
export function collectFiles(
  root: string,
  rel: string,
  maxEntries: number,
): { files: string[]; truncated: boolean } {
  const base = rel === "" ? path.resolve(root) : safeResolve(root, rel);
  if (base === null) return { files: [], truncated: false };
  const files: string[] = [];
  let truncated = false;
  const walk = (dir: string, depth: number): void => {
    if (truncated || depth > SEARCH_MAX_DEPTH) return;
    let names: fs.Dirent[];
    try {
      names = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // 单目录读不了（权限等）跳过，不中断整个清单
    }
    names.sort((a, b) => a.name.localeCompare(b.name)); // 确定性顺序，两次调用不跳变
    for (const ent of names) {
      if (truncated) return;
      if (isJunkDir(ent.name)) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(full, depth + 1);
      } else if (ent.isFile()) {
        if (files.length >= maxEntries) {
          truncated = true;
          return;
        }
        files.push(path.relative(root, full).replace(/\\/g, "/"));
      }
    }
  };
  walk(base, 0);
  return { files, truncated };
}

/** list_files：从 base 起收集文件清单（相对**项目根**的路径，与 read_file 口径直接对上） */
function doListFiles(root: string, rel: string): { result: string; list: ListReceipt } {
  const scope = rel === "" ? "项目根" : rel;
  const empty = (result: string): { result: string; list: ListReceipt } => ({
    result,
    list: { scope, returned: 0, cap: LIST_MAX_ENTRIES, truncated: false },
  });
  const base = rel === "" ? path.resolve(root) : safeResolve(root, rel);
  if (base === null) {
    return empty(`拒绝：path 必须是项目根内的相对路径（不接受绝对路径或 ..）：${JSON.stringify(rel)}`);
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(base);
  } catch {
    return empty(`目录不存在：${rel}`);
  }
  if (!stat.isDirectory()) return empty(`不是目录（可能是文件）：${rel}`);
  const { files, truncated } = collectFiles(root, rel, LIST_MAX_ENTRIES);
  const list: ListReceipt = { scope, returned: files.length, cap: LIST_MAX_ENTRIES, truncated };
  if (files.length === 0) {
    return { result: `${scope} 下没有可列的文件（依赖垃圾/构建产物已跳过）`, list };
  }
  const head = `${scope} 文件清单（${files.length} 个${truncated ? `，已达上限 ${LIST_MAX_ENTRIES} 截断——清单只是部分，别当作全部` : ""}，已跳过 node_modules/.git/构建产物）：`;
  return { result: `${head}\n${files.join("\n")}`, list };
}

/** 清单条目的相对路径归一（正斜杠、去开头的 ./）——清单/回执/账本共用同一口径 */
export function normalizeRel(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

const sha256Text = (text: string): string =>
  crypto.createHash("sha256").update(text, "utf8").digest("hex");

/** 失败回执（一个字节都没返回）：文本也一并给出，工具永不抛 */
function failedRead(
  path_: string,
  reason: string,
  message: string,
  status: ReadStatus = "failed",
): { text: string; receipt: ReadReceipt } {
  return {
    text: message,
    receipt: {
      path: path_,
      status,
      reason,
      range: null,
      byte_range: null,
      total: null,
      content_sha256: null,
      chars: 0,
      next_cursor: null,
      complete: false,
    },
  };
}

/** read_file 的分段读取参数（cursor 由上一次回执给；maxChars 只给验证脚本收紧预算用） */
export interface ReadFileOptions {
  cursor?: string;
  maxChars?: number;
}

/**
 * 分段读一个文件：返回**真正取到的行范围**与续读游标。
 *
 * 口径（§2.8）：成功读了一段不等于读完——`complete` 只在"从第 1 行读到末行"时为 true；
 * 截断、二进制、失败、被批总量挡下的文件一律 `complete=false`，账本据此判"未读全"。
 */
export function readFilePaged(
  root: string,
  rel: string,
  opts: ReadFileOptions = {},
): { text: string; receipt: ReadReceipt } {
  const maxChars = opts.maxChars ?? READ_FILE_MAX_CHARS;
  const target = safeResolve(root, rel);
  if (target === null) {
    return failedRead(
      rel,
      "invalid_path",
      `拒绝：path 必须是项目根内的相对路径（不接受绝对路径或 ..）：${JSON.stringify(rel)}`,
    );
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(target);
  } catch {
    return failedRead(rel, "missing", `文件不存在：${rel}`);
  }
  if (!stat.isFile()) return failedRead(rel, "not_a_file", `不是文件（可能是目录）：${rel}`);
  let content: string;
  try {
    content = fs.readFileSync(target, "utf8");
  } catch (e) {
    return failedRead(rel, "read_error", `读取失败：${rel}（${sanitizeErrorMessage((e as Error).message)}）`);
  }
  if (looksBinary(content)) {
    return failedRead(rel, "binary", `二进制文件，不读：${rel}`, "binary_excluded");
  }

  const lines = content.split(/\r?\n/);
  const version = sha256Text(content);
  let start = 1;
  if (typeof opts.cursor === "string" && opts.cursor !== "") {
    const cur = parseCursor(opts.cursor);
    if (cur === null) {
      return failedRead(rel, "invalid_cursor", `读取游标不合法：${opts.cursor}（须是 ${CURSOR_PREFIX}:… 形态）`);
    }
    if (!cursorMatchesVersion(cur, version)) {
      return failedRead(
        rel,
        "source_changed",
        `SOURCE_CHANGED：${rel} 的内容已变（游标绑定 ${cur.version}，当前 ${version.slice(0, 16)}），` +
          "旧游标失效——请重新从头读，不要用旧内容继续",
      );
    }
    start = Math.min(Math.max(1, cur.start), lines.length + 1);
  }

  const picked: string[] = [];
  let used = 0;
  let partialLine = false;
  let i = start - 1;
  while (i < lines.length) {
    const line = lines[i];
    const add = line.length + (picked.length > 0 ? 1 : 0);
    if (picked.length > 0 && used + add > maxChars) break;
    if (picked.length === 0 && add > maxChars) {
      // 单行就超预算：截这一行并用 next_cursor 指向下一行（如实标记"该行被截"）
      picked.push(line.slice(0, maxChars));
      used = maxChars;
      partialLine = true;
      i++;
      break;
    }
    picked.push(line);
    used += add;
    i++;
  }

  const end = picked.length === 0 ? start - 1 : start + picked.length - 1;
  const range: CoverageRange | null = picked.length === 0 ? null : { unit: "lines", start, end };
  const prefixBytes = Buffer.byteLength(lines.slice(0, start - 1).join("\n") + (start > 1 ? "\n" : ""), "utf8");
  const takenBytes = Buffer.byteLength(picked.join("\n"), "utf8");
  const nextStart = picked.length === 0 ? start : end + 1;
  const more = nextStart <= lines.length;
  const next_cursor = more ? makeCursor(version, "lines", nextStart) : null;
  const complete = start === 1 && !more && !partialLine;
  const status: ReadStatus = complete ? "ok" : "truncated";
  const receipt: ReadReceipt = {
    path: normalizeRel(rel),
    status,
    reason: complete ? null : partialLine && !more ? "line_truncated" : more ? "more_to_read" : null,
    range,
    byte_range: picked.length === 0 ? null : { unit: "bytes", start: prefixBytes, end: prefixBytes + takenBytes },
    total: { lines: lines.length, bytes: Buffer.byteLength(content, "utf8"), chars: content.length },
    content_sha256: version,
    chars: takenBytes === 0 ? 0 : picked.join("\n").length,
    next_cursor,
    complete,
  };

  if (picked.length === 0) {
    return { text: `（${rel} 第 ${start} 行起没有内容：全文 ${lines.length} 行，已到末尾）`, receipt };
  }
  const body = picked.join("\n");
  if (complete) return { text: body, receipt };
  const head =
    `（${rel}：全文 ${lines.length} 行 / ${content.length} 字；本次返回第 ${start}–${end} 行` +
    `${partialLine && !more ? "，该行超长已截断" : ""}` +
    `${more ? `；续读游标 ${next_cursor}` : "；已到文件末尾"}）`;
  return { text: `${head}\n${body}`, receipt };
}

/** read_files：批量读（每个文件独立成段；总量超限后剩余文件**注明未读且不算已读**） */
export function doReadFiles(
  root: string,
  paths: unknown,
): { text: string; reads: ReadReceipt[] } {
  if (!Array.isArray(paths)) {
    return { text: "拒绝：paths 必须是字符串数组", reads: [] };
  }
  const list = paths.filter((p): p is string => typeof p === "string");
  if (list.length === 0) return { text: "拒绝：paths 至少要有一个文件路径", reads: [] };
  if (list.length > READ_FILES_BATCH_MAX) {
    return {
      text: `拒绝：一次最多批量读 ${READ_FILES_BATCH_MAX} 个文件（收到 ${list.length} 个），请分批`,
      reads: list.map((p) => notReadReceipt(p, "batch_size_rejected")),
    };
  }
  const out: string[] = [];
  const reads: ReadReceipt[] = [];
  let total = 0;
  let overTotal = false;
  for (const p of list) {
    if (overTotal) {
      reads.push(notReadReceipt(p, "batch_total_limit"));
      out.push(`===== ${p} =====\n未读：整批总量已达上限，请单独 read_file 或分批`);
      continue;
    }
    const one = readFilePaged(root, p);
    if (total + one.text.length > READ_FILES_TOTAL_MAX_CHARS) {
      // 本文件**没有**进模型的上下文：账本不得记它已读（旧实现正是在这里记成已读的）
      overTotal = true;
      reads.push(notReadReceipt(p, "batch_total_limit"));
      out.push(`===== ${p} =====\n未读：整批总量已达上限（前文合计 ${total} 字），请单独 read_file 或分批`);
      continue;
    }
    total += one.text.length;
    reads.push(one.receipt);
    out.push(`===== ${p} =====\n${one.text}`);
  }
  return { text: out.join("\n\n"), reads };
}

/** 没读到任何一个字节的回执（批总量/批量上限挡下） */
function notReadReceipt(rel: string, reason: string): ReadReceipt {
  return {
    path: normalizeRel(rel),
    status: "not_read",
    reason,
    range: null,
    byte_range: null,
    total: null,
    content_sha256: null,
    chars: 0,
    next_cursor: null,
    complete: false,
  };
}

function doSearchCode(root: string, query: string, max?: number): string {
  if (typeof query !== "string" || query === "") return "拒绝：query 必须是非空字符串";
  const hitLimit = Math.min(
    typeof max === "number" && max > 0 ? Math.floor(max) : SEARCH_DEFAULT_HITS,
    SEARCH_MAX_HITS,
  );
  const hits: string[] = [];
  let scanned = 0;
  let truncated = false;
  const walk = (dir: string, depth: number): void => {
    if (truncated || depth > SEARCH_MAX_DEPTH) return;
    let names: fs.Dirent[];
    try {
      names = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // 单目录读不了（权限等）跳过，不中断整个搜索
    }
    for (const ent of names) {
      if (truncated) return;
      if (isJunkDir(ent.name)) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(full, depth + 1);
      } else if (ent.isFile()) {
        if (scanned >= SEARCH_MAX_FILES) {
          truncated = true;
          return;
        }
        scanned++;
        let stat: fs.Stats;
        try {
          stat = fs.statSync(full);
        } catch {
          continue;
        }
        if (stat.size > SEARCH_MAX_FILE_BYTES || stat.size === 0) continue;
        let text: string;
        try {
          text = fs.readFileSync(full, "utf8");
        } catch {
          continue;
        }
        if (looksBinary(text)) continue;
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          if (!lines[i].includes(query)) continue;
          const rel = path.relative(root, full).replace(/\\/g, "/");
          const line = lines[i].trim().slice(0, SEARCH_LINE_MAX_CHARS);
          hits.push(`${rel}:${i + 1}: ${line}`);
          if (hits.length >= hitLimit) {
            truncated = true;
            return;
          }
        }
      }
    }
  };
  walk(root, 0);
  const head = `扫描 ${scanned} 个文件，命中 ${hits.length} 处${truncated ? "（已达上限截断）" : ""}：`;
  return hits.length === 0 ? `扫描 ${scanned} 个文件，没有命中「${query}」。` : `${head}\n${hits.join("\n")}`;
}

function doGetArch(projectId: string): string {
  const r = renderGraph(projectId);
  if (!r.exists || !r.graph) {
    return "架构图还没解析过（可在「架构图」页签点解析生成后再来问；补全层可以先写，解析后一并显示）";
  }
  const json = JSON.stringify({
    nodes: r.graph.nodes.map((n) => ({
      id: n.id,
      name: n.name,
      path: n.path,
      ...(n.origin === "chat" ? { origin: "chat" } : {}),
    })),
    edges: r.graph.edges,
  });
  if (json.length > ARCH_JSON_MAX_CHARS) {
    return `（数据超上限截前段，共 ${json.length} 字）\n${json.slice(0, ARCH_JSON_MAX_CHARS)}`;
  }
  return json;
}

/** check_arch 的对账计数（summary 与总结行同源，不许两处各算一遍） */
interface CheckArchCounts {
  /** 悬空 path 条数 */
  dangling: number;
  /** 重复节点组数（同 path 一组 / 同 name 一组） */
  dupGroups: number;
  /** 目录树嫌疑条数 */
  suspect: number;
}

/** check_arch：机械比对磁盘与合并图（只读，不修——修是 write_arch 的事） */
function doCheckArch(projectId: string, root: string): { result: string; counts: CheckArchCounts } {
  const r = renderGraph(projectId);
  if (!r.exists || !r.graph) {
    return {
      result: "还没解析过，先解析再对账（可在「架构图」页签点解析，或 POST arch/parse）。",
      counts: { dangling: 0, dupGroups: 0, suspect: 0 },
    };
  }
  const nodes = r.graph.nodes;
  const origin = (n: (typeof nodes)[number]) => (n.origin === "chat" ? "chat" : "parse");

  // ── 悬空 path：节点 path 非空且项目根内不存在（safeResolve 防穿越；纯概念节点 path 空跳过）──
  const dangling: string[] = [];
  for (const n of nodes) {
    if (n.path === "" || n.aggregate) continue;
    const abs = safeResolve(root, n.path);
    if (abs === null) {
      dangling.push(`- ${n.id}（${n.name}）origin=${origin(n)} path=${n.path}（越出项目根，查不了）`);
    } else if (!fs.existsSync(abs)) {
      dangling.push(`- ${n.id}（${n.name}）origin=${origin(n)} path=${n.path}`);
    }
  }

  // ── 重复节点：path（非空）分组 >1、name 分组 >1，各列组员（id+origin+path）──
  const dupLines: string[] = [];
  let dupGroups = 0;
  const groupsOf = (keyOf: (n: (typeof nodes)[number]) => string, label: string): void => {
    const byKey = new Map<string, typeof nodes>();
    for (const n of nodes) {
      if (n.aggregate) continue;
      const k = keyOf(n);
      if (k === "") continue;
      const arr = byKey.get(k) ?? [];
      arr.push(n);
      byKey.set(k, arr);
    }
    for (const [k, arr] of [...byKey.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))) {
      if (arr.length <= 1) continue;
      dupGroups++;
      for (const n of arr) {
        dupLines.push(`- [同 ${label}=${k}] ${n.id}（${n.name}）origin=${origin(n)} path=${n.path}`);
      }
    }
  };
  groupsOf((n) => n.path, "path");
  groupsOf((n) => n.name, "name");

  // ── 目录树嫌疑：补全节点 path 与解析层模块 path 相同或为其子孙（前缀匹配 + "/" 边界）──
  //  解析层聚合模块 path 是逗号拼接清单（"a,b"），按逗号拆开各算一段
  const parsePaths: string[] = [];
  for (const n of nodes) {
    if (n.origin === "chat" || n.aggregate) continue;
    for (const seg of n.path.split(",")) {
      const p = seg.trim();
      if (p !== "" && p !== ".") parsePaths.push(p);
    }
  }
  const suspect: string[] = [];
  for (const n of nodes) {
    if (n.origin !== "chat" || n.path === "") continue;
    const hit = parsePaths.find((p) => n.path === p || n.path.startsWith(p + "/"));
    if (hit !== undefined) {
      suspect.push(
        `- ${n.id}（${n.name}）origin=chat path=${n.path}（与解析层模块 ${hit} 的目录树重叠——` +
          `文件级细节用图上下钻看，别补进补全层）`,
      );
    }
  }

  const counts: CheckArchCounts = { dangling: dangling.length, dupGroups, suspect: suspect.length };
  const clean = dangling.length === 0 && dupGroups === 0 && suspect.length === 0;
  const lines = [
    `架构对账（合并图 ${nodes.length} 节点 / ${r.graph.edges.length} 边；逐条只报不修）：`,
    `── 悬空 path（图上节点 path 磁盘不存在）：${dangling.length} 个 ──`,
    ...dangling,
    `── 重复节点（同 path 或同 name 多节点）：${dupGroups} 组 ──`,
    ...dupLines,
    `── 补全层目录树嫌疑（补全节点 path 与解析层模块重叠）：${suspect.length} 个 ──`,
    ...suspect,
    clean
      ? "对账结论：悬空 0 / 重复 0 / 目录树嫌疑 0——图与代码对齐。"
      : `对账结论：悬空 ${dangling.length} / 重复 ${dupGroups} 组 / 目录树嫌疑 ${suspect.length}——按上面清单逐条修，修完再跑 check_arch。`,
  ];
  return { result: lines.join("\n"), counts };
}

/** 一次工具调用的执行结果：result 喂回模型；summary 给前端活动提示（SSE tool 事件） */
export interface ChatToolResult {
  result: string;
  summary: string;
  /** 读文件类工具的真实取回回执（覆盖账本只认它，不认"点过什么路径"）；别的工具为 undefined */
  reads?: ReadReceipt[];
  /** list_files 的清单回执（清单被上限截断时必须能看见） */
  list?: ListReceipt;
  /**
   * 写盘类工具的真实写入回执（V06-07：工具动作与结果关联持久化用）。
   * 只读工具一律 undefined——"读了什么"不算"写了什么"。
   */
  writes?: { path: string; affected_ids: string[] }[];
}

/**
 * 执行一次模型点名的工具调用。**任何失败都不抛**——把可读错误作为 result 回给模型，
 * 让它自己决定换路子（问别的文件/换关键字），聊天绝不断掉。
 * 参数 arguments 是模型吐的 JSON 字符串，解析失败同样以错误回执。
 */
export function executeChatTool(projectId: string, name: string, argsJson: string): ChatToolResult {
  try {
    const project = getProject(projectId);
    if (!project) throw new Error(`项目不存在: ${projectId}`);
    const root = project.path;
    let args: Record<string, unknown> = {};
    try {
      args = argsJson.trim() === "" ? {} : (JSON.parse(argsJson) as Record<string, unknown>);
    } catch {
      return { result: `参数不是合法 JSON：${argsJson.slice(0, 200)}`, summary: "参数解析失败" };
    }
    switch (name) {
      case "list_files": {
        // 2026-09-19 试用反馈：模型摸不到文件清单，只能靠搜索关键字瞎碰——补一只列清单的手
        const rel = typeof args.path === "string" ? args.path : "";
        const { result, list } = doListFiles(root, rel);
        return { result, summary: `列文件清单 ${rel === "" ? "（项目根）" : rel}（${result.length} 字）`, list };
      }
      case "read_file": {
        const rel = typeof args.path === "string" ? args.path : "";
        const cursor = typeof args.cursor === "string" ? args.cursor : undefined;
        const { text, receipt } = readFilePaged(root, rel, cursor === undefined ? {} : { cursor });
        const where =
          receipt.range === null
            ? ""
            : `第 ${receipt.range.start}–${receipt.range.end} 行${receipt.complete ? "" : "（未完）"}`;
        return {
          result: text,
          summary: `读文件 ${rel === "" ? "?" : rel}${where === "" ? "" : ` ${where}`}（${text.length} 字）`,
          reads: [receipt],
        };
      }
      case "read_files": {
        // 2026-09-19 试用反馈：只能一个文件一个文件读，通读全量代码太慢——补批量读
        const { text, reads } = doReadFiles(root, args.paths);
        const n = Array.isArray(args.paths) ? args.paths.length : 0;
        const got = reads.filter((r) => r.status === "ok" || r.status === "truncated").length;
        return { result: text, summary: `批量读 ${n} 个文件（真取到 ${got} 个，${text.length} 字）`, reads };
      }
      case "search_code": {
        const result = doSearchCode(
          root,
          typeof args.query === "string" ? args.query : "",
          typeof args.max === "number" ? args.max : undefined,
        );
        return { result, summary: `搜代码「${typeof args.query === "string" ? args.query : "?"}」` };
      }
      case "get_arch": {
        const result = doGetArch(projectId);
        return { result, summary: `看架构图（${result.length} 字）` };
      }
      case "write_arch": {
        // 2026-09-19 试用增强三期：聊天补全架构图（只增不删解析层，口径与上限见 arch/supplement.ts）
        const raw = args as {
          nodes?: { id?: string; name?: string; blurb?: string; kind?: string; path?: string }[];
          edges?: { from?: string; to?: string; note?: string }[];
          mode?: string;
        };
        const receipt = applySupplementInput(projectId, {
          nodes: Array.isArray(raw.nodes) ? raw.nodes : [],
          edges: Array.isArray(raw.edges) ? raw.edges : [],
          mode: raw.mode === "replace" ? "replace" : "append",
        });
        // 回执排版成人话（四期升级）：一行压缩 JSON 模型容易跳读——改多行对账单，
        // 跳过/丢弃逐行列明；末行 receipt:{完整 JSON} 供脚本机械解析（计数口径不变）
        const lines: string[] = [
          `补全层写入回执（mode=${receipt.mode}）：+${receipt.added_nodes} 节点 +${receipt.added_edges} 边，` +
            `总计 ${receipt.total_nodes} 节点 ${receipt.total_edges} 边`,
        ];
        for (const d of receipt.skipped_duplicates_detail) lines.push(`- 跳过：${d}`);
        for (const d of receipt.dropped_edges_detail) lines.push(`- 丢弃：${d}`);
        if (receipt.capped) {
          lines.push(`- 上限：补全层已满（上限 ${MAX_SUP_NODES} 节点 / ${MAX_SUP_EDGES} 边），超限部分本次未写入`);
        }
        lines.push(
          receipt.parsed
            ? "已并入三视图渲染（架构图页签立即可见，chat 徽标）。"
            : "注意：项目还没静态解析过，补全已存盘、解析后才会在图上显示。",
        );
        lines.push(`receipt:${JSON.stringify(receipt)}`);
        return {
          result: lines.join("\n"),
          summary: `补全架构图 +${receipt.added_nodes} 节点 +${receipt.added_edges} 边`,
          // V06-07：写盘类工具的真实写入回执（只写补全层这一个文件；受影响对象 = 本次点名的补全节点 id）
          writes: [
            {
              path: path.relative(root, path.join(workstationDir(projectId), "arch", "supplement.json")).split(path.sep).join("/"),
              affected_ids: (Array.isArray(raw.nodes) ? raw.nodes : [])
                .map((n) => (typeof n?.id === "string" && n.id !== "" ? (n.id.startsWith("chat:") ? n.id : `chat:${n.id}`) : ""))
                .filter((id) => id !== ""),
            },
          ],
        };
      }
      case "check_arch": {
        // 2026-09-19 试用增强四期：架构对账（只读机械比对，"核对三视图与代码"的机器入口）
        const { result, counts } = doCheckArch(projectId, root);
        return {
          result,
          summary: `架构对账：悬空 ${counts.dangling}/重复 ${counts.dupGroups}/目录树嫌疑 ${counts.suspect}`,
        };
      }
      default:
        return {
          result: `没有这个工具：${name}（可用：list_files / read_file / read_files / search_code / get_arch / write_arch / check_arch）`,
          summary: `未知工具 ${name}`,
        };
    }
  } catch (e) {
    const reason = sanitizeErrorMessage((e as Error).message);
    return { result: `工具执行失败：${reason}`, summary: `失败：${reason.slice(0, 80)}` };
  }
}
