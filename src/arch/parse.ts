import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
// 原生依赖只取类型（`import type` 编译期抹除，不留运行时绑定）：加载改到首次真解析时按需 require，
// 见 loadNative()——顶层静态 import 会把"加载失败"提前成启动期进程崩溃。
import type Parser from "tree-sitter";
import { getProject } from "../server/registry";
import { WsError } from "../server/workstation";
import { isJunkDir, JUNK_DIR_SEGMENTS } from "./config";

// 顶层模块静态解析（A1，DESIGN.md §4.1 混合管线第一层）：
// tree-sitter 真解析真实目录/模块骨架（Python + JS/TS 统一处理，毫秒级、零幻觉），
// 产出 .工作台/arch/modules.json 供 A2 Flash 起名（name 字段留空）与 A3 React Flow 渲染。
// §12.1 未决项 #2 选型结论：node binding（tree-sitter npm 包 + 语言包，win32-x64 prebuild
// 免构建；web-tree-sitter 0.27 与 tree-sitter-wasms 的 grammar WASM ABI 不匹配，小样即败）。
// 红线：纯静态解析，LLM 全程不参与（§4.1）；只读被解析项目，唯一写口是 modules.json。
// 顶层模块语义（§3.3；2026-09-29 修订，六图完整读取轮）：不足 MIN_MODULES 按二级目录细分补；
// **超过 15 个不再有损合并**——旧 mergeOverflow 把超出候选压成「其他」桶发生在采集落盘层，
// 违反 §3.3「聚合不得吃掉可达性」（原始对象丢失、full 不可恢复）。现在采集层保留全部候选与
// 稳定身份，5–15 上限只在概览投影层（shared-graph.ts 的概览档上限）施加；旧「其他」桶数据
// 由 legacyAggregationOf 如实识别（读侧标注、重跑解析可展开）。

/** 忽略目录段名：与 chat 工具（搜索/列清单）共用 config.ts#JUNK_DIR_SEGMENTS 这**同一份清单**
 *  （2026-09-19 主人拍板：A1 收集与 chat 搜索跳同一批通用垃圾目录，含 .tatai/Python 缓存段/
 *  *.egg-info 后缀——isJunkDir 一并判）。A4 子树展开复用同一口径。
 *  H4 补的四段（`.tmp`/`tmp`/`temp`/`cache`）仍在清单内：现场项目的病根目录就在 `.tmp`
 *  （实测一棵子树 12 286 文件 / 28 883 目录），漏了会让解析/扫描把临时产物当模块内容。
 *  旧名 IGNORED_SEGMENTS 保留导出，expand.ts / verify-n2 沿用不破。 */
export const IGNORED_SEGMENTS: ReadonlySet<string> = JUNK_DIR_SEGMENTS;

/** 顶层模块数量下限（§3.3：不足时按二级目录细分补）
 *  MIN_MODULES 导出的唯一目的：V09-12 的触发范围判据要问"当前模块数是否还在**会细分**的区间内"
 *  （`<MIN_MODULES` 时候选还要按二级/更深目录细分，新增深层目录就可能改变划分）——
 *  判据必须与划分本体用**同一个数**，不许在触发侧再写一遍。
 *  上限侧（旧 MAX_MODULES=15）2026-09-29 起不再在采集层设卡：候选超 15 照常落盘，
 *  防爆炸由概览投影层的节点上限（config.ts 的 MAX_NODES，同一数值 15）施加。 */
export const MIN_MODULES = 5;
/** 参与 import 解析的源码扩展名 → 语言（A4 子树展开复用） */
export const SOURCE_EXTS: ReadonlyMap<string, "python" | "typescript" | "tsx" | "javascript"> = new Map([
  [".py", "python"],
  [".ts", "typescript"],
  [".tsx", "tsx"],
  [".js", "javascript"],
  [".jsx", "javascript"],
  [".mjs", "javascript"],
  [".cjs", "javascript"],
]);
/** 单文件解析上限：超过视为生成物/数据文件，跳过解析（仍计 file_count） */
const MAX_PARSE_BYTES = 512 * 1024;
/** JS/TS 相对 import 解析时尝试的扩展名与索引文件 */
const JS_RESOLVE_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

export interface ModuleDep {
  /** 目标模块 id */
  to: string;
  /** 聚合 import 条数（§4.3 第 3 招边权重的底层数据） */
  weight: number;
}

export interface ArchModule {
  /** 稳定 id：路径 slug（"src/server" → "src-server"；根散文件 "root"；
   *  路径含非 ASCII 时补原路径 sha1 短后缀，防中文目录名塌成同一个 id） */
  id: string;
  /** 人话名留空，A2 Flash 起名填 */
  name: string;
  /** 相对项目根路径（正斜杠；根散文件为 "."）。旧落盘件可能有「其他:…」聚合桶（见 legacyAggregationOf） */
  path: string;
  file_count: number;
  /** 源码行数（仅统计被解析的源码文件） */
  loc: number;
  deps: ModuleDep[];
}

export interface ArchModulesFile {
  version: 1;
  generated_at: string;
  modules: ArchModule[];
  /** Q133：本份模块集是否因遍历/解析预算到点提前收工（true = 只含已扫到的部分，不是全量）。
   *  缺席 = 产自还没写这个标记的旧版本落盘件，**完整性未知**——读侧不许当成"扫完了"。
   *  落盘带标记是为了让残缺模块集刷新/重启后仍被认出（渲染层见 shared-graph.ts 的
   *  `SharedGraph.budget_exhausted`；内存里的同一口径在 ParseResult.stats）。 */
  budget_exhausted?: boolean;
}

/** 解析统计（运行期口径：落盘件只留 budget_exhausted 一个标记，明细在 HTTP 响应里） */
export interface ArchParseStats {
  source_files: number;
  skipped_large: number;
  skipped_unreadable: number;
  parse_failed: number;
  imports: number;
  budget_exhausted: boolean;
}

export interface ParseResult {
  file: ArchModulesFile;
  /** 落盘绝对路径 */
  source: string;
  /** 全量耗时（含遍历/IO） */
  duration_ms: number;
  /** tree-sitter 解析阶段耗时（毫秒级口径：不含遍历与 IO） */
  parse_ms: number;
  /** 统计：源码文件数 / 跳过大文件数 / 读失败数 / 解析失败数 / 提取 import 条数 /
   *  是否因遍历-解析预算提前收工（结果不完整） */
  stats: ArchParseStats;
}

const toRel = (root: string, abs: string) =>
  path.relative(root, abs).split(path.sep).join("/");

/** 路径 slug（模块稳定 id）：正斜杠 → "-"，只留 [0-9A-Za-z_-]，空则 "root"。
 *  非 ASCII 字符（中文目录名）会被整段替换成 "-"：不同路径会塌成同一个 id（「第二大脑」「源码」
 *  与根散文件全成 "root"，「audit/操作卡.md」「audit/审计总则.md」全成 "audit-md"），而 id 是
 *  React Flow 的节点键、必须唯一（shared-graph.ts 口径）→ 原路径含非 ASCII 时补原路径 sha1
 *  前 8 位后缀，保证不同路径得到不同 id；纯 ASCII 路径一字不变（id 保持稳定，不动已锚定的图谱）。 */
const SLUG_HASH_LEN = 8;

export function slugify(relPath: string): string {
  if (relPath === "." || relPath === "") return "root";
  const slug = relPath
    .split("/")
    .join("-")
    .replace(/[^0-9A-Za-z_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  const base = slug === "" ? "root" : slug;
  if (!/[^\x00-\x7F]/.test(relPath)) return base;
  return `${base}-${crypto.createHash("sha1").update(relPath).digest("hex").slice(0, SLUG_HASH_LEN)}`;
}

/** 遍历预算（文件数 + 耗时双闸门）：readdir 与 tree-sitter parse 单步都没法中途打断，闸门只保证
 *  "到点不再开新活"；不完整由 stats.budget_exhausted 显式标出。同步 parseDirectory 与后台
 *  parseDirectoryAsync（HTTP 全量入口，DESIGN §11.8 起分片让出事件循环、可取消）共用这份常量。 */
export const WALK_LIMITS = { maxFiles: 50_000, maxMs: 120_000 } as const;
// 2026-10-04 实测依据（用户授权的最小修法）：示例项目整目录 21 226 文件，仅枚举 469 ms 就走完，旧的
// 20 000 文件上限先于 120 s 时间上限到点 → budget_exhausted=true（模块图残缺），故 maxFiles 提到 50 000。
// 上限按 DESIGN §11.8／§12.1-3 依失败回执与实测调节；超限仍如实标记残缺，不跳过证据目录。

export interface WalkBudget {
  /** 单次遍历的文件条目硬上限 */
  maxFiles: number;
  /** 单次遍历的耗时闸门（毫秒） */
  maxMs: number;
}

export interface WalkedFiles {
  files: string[];
  /** 预算耗尽提前收工（true = 清单不完整） */
  truncated: boolean;
}

/** 迭代式遍历（不递归、不跟随符号链接）——带预算的有界版：生产路径（A1/A4）走这条 */
export function boundedWalk(root: string, budget: WalkBudget = WALK_LIMITS): WalkedFiles {
  const files: string[] = [];
  const deadline = Date.now() + budget.maxMs;
  const overBudget = () => files.length >= budget.maxFiles || Date.now() > deadline;
  const stack: string[] = [root];
  while (stack.length > 0) {
    if (overBudget()) return { files, truncated: true };
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // 无权限/损坏目录跳过，不炸整个解析
    }
    for (const e of entries) {
      if (overBudget()) return { files, truncated: true }; // 单目录上万条目也要卡得住（不只按目录判）
      if (e.isDirectory()) {
        if (isJunkDir(e.name)) continue; // 共享清单 + *.egg-info 后缀（config.ts 同一份口径）
        stack.push(path.join(dir, e.name));
        continue;
      }
      if (e.isSymbolicLink() || !e.isFile()) continue;
      files.push(toRel(root, path.join(dir, e.name)));
    }
  }
  return { files, truncated: false };
}

/** 无预算全量遍历：只给"旧口径对照"用（验证脚本算整枝文件数与耗时），生产路径一律走 boundedWalk */
export function walkFiles(root: string): string[] {
  return boundedWalk(root, { maxFiles: Number.POSITIVE_INFINITY, maxMs: Number.POSITIVE_INFINITY }).files;
}

/** 原生依赖（tree-sitter 本体 + Python/TS 语言包）的运行时形状：只用到这些成员 */
interface NativeTreeSitter {
  Parser: new () => Parser;
  /** 语言 → grammar（js/jsx 用 tsx grammar：TS 是 JS 超集，统一一把） */
  languages: Record<"python" | "typescript" | "tsx" | "javascript", Parser.Language>;
  /** tree-sitter 0.25.1 的 `module.exports` 就是 Parser 构造器、`Query` 挂在其上（`module.exports.Query`）。
   *  别的绑定/旧版本可能没有这个成员 → 声明为可选，缺了就**明确回退**原全树 DFS（见 collectImportStatements），
   *  不把"Query 建不起来"当成"这个文件没有 import"。 */
  Query?: new (language: Parser.Language, source: string) => Parser.Query;
}

const requireNative = createRequire(import.meta.url);
let nativeModules: NativeTreeSitter | null = null;

/** tree-sitter 本体与语言包懒加载（顶层静态 import → 按需 require）：
 *  这三个原生模块原本在文件顶部静态 import，而后端入口 src/server/index.ts 静态 import 本模块——
 *  `.node` 加载失败（缺文件 / 平台错配 / ABI 不匹配）发生在任何模块体语句之前，
 *  `process.on("uncaughtException")` 还没注册，进程直接死（整个后端没了）。
 *  改成首次真解析时按需加载：失败只退化成 A1/A4 的"解析失败"，后端其余功能照常。 */
function loadNative(): NativeTreeSitter {
  if (nativeModules) return nativeModules;
  const P = requireNative("tree-sitter") as new () => Parser;
  const python = requireNative("tree-sitter-python") as Parser.Language;
  const ts = requireNative("tree-sitter-typescript") as {
    typescript: Parser.Language;
    tsx: Parser.Language;
  };
  nativeModules = {
    Parser: P,
    Query: (P as { Query?: NativeTreeSitter["Query"] }).Query,
    languages: { python, typescript: ts.typescript, tsx: ts.tsx, javascript: ts.tsx },
  };
  return nativeModules;
}

/** tree-sitter 解析器：按语言各一个，懒建复用 */
const parsers = new Map<string, Parser>();
/** 建不起来的语言（原生包缺 .node / grammar ABI 不匹配）：失败一次就记下来，不每个文件重复试 */
const brokenLangs = new Set<string>();

/** 取该语言的解析器；建不起来（含原生包加载失败）返回 null = 本文件按"解析失败"跳过，不炸整个项目 */
function parserFor(lang: "python" | "typescript" | "tsx" | "javascript"): Parser | null {
  const hit = parsers.get(lang);
  if (hit) return hit;
  if (brokenLangs.has(lang)) return null;
  try {
    const native = loadNative();
    const p = new native.Parser();
    p.setLanguage(native.languages[lang]);
    parsers.set(lang, p);
    return p;
  } catch {
    brokenLangs.add(lang);
    return null;
  }
}

/** 在子树里收集指定类型的节点（迭代，不递归） */
function collect(node: Parser.SyntaxNode, types: ReadonlySet<string>): Parser.SyntaxNode[] {
  const out: Parser.SyntaxNode[] = [];
  const stack: Parser.SyntaxNode[] = [node];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (types.has(n.type)) out.push(n);
    for (let i = n.namedChildCount - 1; i >= 0; i--) stack.push(n.namedChild(i)!);
  }
  return out;
}

// ── import 语句收集：原生 query 快路径（P5 有界解析热路径优化，2026-10-06）────────────────────
// 事由（设计依据见 DESIGN.md §11.8）：真实全量采集 ~25–31 s 里约 72% 不在原生
// tree-sitter parse，而在 `collect()` —— 它把整棵树的每个 namedChild 都 marshal 成 JS 节点包装
// （`namedChildCount` + 逐 `namedChild(i)` 两次跨界，乘以每个节点），只为挑出 import/export/
// call 三类语句。改成 tree-sitter 原生 query：游标在 C 侧走树，只有**命中的**节点回 JS。
//
// 口径不变（这三条是硬约束）：目标节点类型与旧 `collect` 的集合**逐字相同**、仍是**全树递归**
// （函数体/类体/try 块里嵌套的 import 与 require 照收，不做顶层剪枝）、返回顺序仍是旧 DFS 的
// 文档序（pre-order）。query 不可用/构建失败（旧绑定无 `Query`、grammar 认不出某个节点类型）时
// **明确回退**到上面那趟全树 DFS `collect()`——回退是完整的，不是"少收几条"。

/** import 提取要匹配的节点类型（与旧 collect 调用的集合是同一份：改一处即两处一致） */
const PY_IMPORT_NODE_TYPES = ["import_statement", "import_from_statement"] as const;
const JS_IMPORT_NODE_TYPES = ["import_statement", "export_statement", "call_expression"] as const;

/** 节点类型集合 → S-expression query（每个类型一条模式，捕获名统一 @stmt） */
const querySourceOf = (types: readonly string[]): string => types.map((t) => `(${t}) @stmt`).join("\n");

/** 语言 → query（懒建复用；query 可跨树共享）。与 parsers 同一套"建不起来就记住"策略。 */
const importQueries = new Map<string, Parser.Query>();
const brokenImportQueries = new Set<string>();

/** 取该语言收集 import 语句用的 query；建不起来返回 null（调用方回退完整 DFS，不静默少结果） */
function importQueryFor(
  lang: "python" | "typescript" | "tsx" | "javascript",
  types: readonly string[],
): Parser.Query | null {
  const hit = importQueries.get(lang);
  if (hit) return hit;
  if (brokenImportQueries.has(lang)) return null;
  try {
    const native = loadNative();
    const Q = native.Query;
    if (typeof Q !== "function") {
      brokenImportQueries.add(lang);
      return null;
    }
    const q = new Q(native.languages[lang], querySourceOf(types));
    importQueries.set(lang, q);
    return q;
  } catch {
    brokenImportQueries.add(lang);
    return null;
  }
}

/** 收集目标类型的语句节点，顺序与旧全树 DFS 完全一致（pre-order 文档序）。
 *  快路径 = 原生 query 游标：captures 本身就是"按出现顺序"，这里再按 (start 升, end 降) 做一次
 *  稳定排序作为确定性保险——该比较器对树节点**恰好等于** pre-order DFS 顺序（祖先 start ≤ 后代且
 *  end ≥ 后代，故同 start 时祖先在前；兄弟区间互不重叠，按 start 即文档序）。
 *  回退路径 = 旧 collect()，逐节点结果与快路径相同（P5 等价 oracle 已逐文件核过）。
 *  **三条收口都必须是完整回退，且都不许把部分结果当完整结果发布**：
 *    ① Query 建不起来（旧绑定无 `Query`／grammar 不认节点类型）→ 回退；
 *    ② Query 建起来了但**执行期抛错**（原生游标异常）→ 丢弃半截 out、回退；
 *       （旧实现在同一输入本可成功，不能因此把文件虚报 parse_error、更不能让整次解析失败）
 *    ③ 执行成功但原生游标**自报 match 数被上限截断**（`didExceedMatchLimit()`）→ 那是**部分结果**，
 *       同样丢弃、回退；该读数必须**紧接 captures** 取，不能被下一次共享游标调用覆盖。
 *       （tree-sitter 0.25.1 默认 matchLimit=UINT32_MAX、本模式集实测不截断，这里是完整性保险，
 *       不引入"更大上限"之类的替代手段，也不为将来可能的变化新增缓存/计数/协议。）
 *  执行期失败**不**把该语言永久判死：异常可能只对某棵树发生，故按次回退、后续文件仍可继续用 query
 *  （与 `parserFor` 的"失败一次就记住"不同——那里记的是加载/grammar 这类进程级不可恢复失败）。 */
function collectImportStatements(
  root: Parser.SyntaxNode,
  lang: "python" | "typescript" | "tsx" | "javascript",
  types: readonly string[],
): Parser.SyntaxNode[] {
  const query = importQueryFor(lang, types);
  if (query) {
    try {
      const out: Parser.SyntaxNode[] = [];
      for (const cap of query.captures(root)) {
        if (cap.name === "stmt") out.push(cap.node);
      }
      // 游标自报被截断 ⇒ 上面的 out 只是前缀，丢弃并回退，不"装完整"（读数紧接 captures，见上 ③）
      if (typeof query.didExceedMatchLimit !== "function" || !query.didExceedMatchLimit()) {
        out.sort((a, b) => a.startIndex - b.startIndex || b.endIndex - a.endIndex);
        return out;
      }
    } catch {
      // 执行期抛错：整段丢弃（不保留半截 out），落到下面的完整 DFS 回退
    }
  }
  return collect(root, new Set(types)); // 明确回退真实原 DFS（不是空数组）
}

/** 只读诊断：各语言能否构造原生 Query；不表示某次文件解析实际使用了哪条路径。
 *  执行失败或超限仍可能按次回退；完整性由结果等价验证，产品路径不读此诊断。 */
export function importCollectionMode(): {
  langs: Record<string, "query" | "dfs_fallback">;
} {
  const langs: Record<string, "query" | "dfs_fallback"> = {};
  for (const lang of ["python", "typescript", "tsx", "javascript"] as const) {
    const types = lang === "python" ? PY_IMPORT_NODE_TYPES : JS_IMPORT_NODE_TYPES;
    langs[lang] = importQueryFor(lang, types) ? "query" : "dfs_fallback";
  }
  return { langs };
}

/** Python：import x.y / import x as a / from x.y import z / from . import z / from ..m import z。
 *  返回模块路径片段数组（点分层级展开）；相对 import 带 leadingDots 层级数。 */
function extractPythonImports(root: Parser.SyntaxNode): { parts: string[]; leadingDots: number }[] {
  const out: { parts: string[]; leadingDots: number }[] = [];
  for (const stmt of collectImportStatements(root, "python", PY_IMPORT_NODE_TYPES)) {
    if (stmt.type === "import_statement") {
      for (const name of collect(stmt, new Set(["dotted_name"]))) {
        out.push({ parts: name.text.split("."), leadingDots: 0 });
      }
      continue;
    }
    // import_from_statement：module 字段是 dotted_name 或 relative_import
    const mod = stmt.childForFieldName("module_name");
    if (!mod) continue;
    let dots = 0;
    let dotted: Parser.SyntaxNode | null = mod;
    if (mod.type === "relative_import") {
      const prefix = mod.namedChildren.find((c) => c.type === "import_prefix");
      dots = prefix ? (prefix.text.match(/\./g) ?? []).length : 1;
      dotted = mod.namedChildren.find((c) => c.type === "dotted_name") ?? null;
    }
    if (dotted) out.push({ parts: dotted.text.split("."), leadingDots: dots });
    else if (dots > 0) out.push({ parts: [], leadingDots: dots }); // from . import x
  }
  return out;
}

/** JS/TS：import ... from "..." / export ... from "..." / require("...") / import("...")。
 *  返回 specifier 原文（只相对路径参与依赖边）。 */
function extractJsImports(
  root: Parser.SyntaxNode,
  lang: "typescript" | "tsx" | "javascript",
): string[] {
  const specs: string[] = [];
  for (const n of collectImportStatements(root, lang, JS_IMPORT_NODE_TYPES)) {
    if (n.type === "import_statement" || n.type === "export_statement") {
      const source = n.childForFieldName("source");
      if (source && source.type === "string") {
        const frag = source.namedChildren.find((c) => c.type === "string_fragment");
        if (frag) specs.push(frag.text);
      }
      continue;
    }
    // call_expression：require("x") 或 import("x")
    const fn = n.childForFieldName("function");
    if (!fn) continue;
    const isRequire = fn.type === "identifier" && fn.text === "require";
    const isDynamicImport = fn.type === "import";
    if (!isRequire && !isDynamicImport) continue;
    const args = n.childForFieldName("arguments");
    const str = args?.namedChildren.find((c) => c.type === "string");
    const frag = str?.namedChildren.find((c) => c.type === "string_fragment");
    if (frag) specs.push(frag.text);
  }
  return specs;
}

/** 单文件被跳过的原因：大文件是**策略性跳过**（生成物/数据），读失败与解析失败是**故障**——
 *  三者必须可区分，否则 IO/权限问题会被伪装成"跳过大文件"（Q53）。 */
export type ImportSkipReason = "too_large" | "unreadable" | "parse_error";

/** 单文件 import 解析结果（A4 子树展开复用） */
export interface FileImports {
  /** 解析出的项目内目标文件（已确认存在于源码集合）；skip 非 null 时恒空 */
  targets: string[];
  /** 该源码文件行数；skip 非 null 时恒 0（没读/没解析，loc 就不该算进来） */
  loc: number;
  /** null = 真解析过（targets/loc 有效）；否则 = 跳过原因（调用方按原因分别记账） */
  skip: ImportSkipReason | null;
}

/** 单文件 import 解析；源码集合 sourceSet 用于确认目标在项目内。
 *  pyImportRoots：Python 绝对 import 的包根候选（"" = 项目根；src-layout 加 "src"）。
 *  A4 子树展开复用：sourceSet 传全项目文件名集合（只走文件名不算解析），调用方只喂子树内文件。
 *  不抛错：读不到/解析不了都按 skip 原因返回（大文件、IO 失败、解析器失败三态可区分）。 */
export function parseFileImports(
  root: string,
  rel: string,
  lang: "python" | "typescript" | "tsx" | "javascript",
  sourceSet: ReadonlySet<string>,
  pyImportRoots: readonly string[],
): FileImports {
  return parseImportsWith(root, rel, lang, (candidate) => sourceSet.has(candidate), pyImportRoots);
}

/**
 * 单文件 import 的**廉价探针**（V09-12 触发范围判据：`src/server/work/graphRefresh.ts` 用它判"这条
 * 源码变化是否改了跨模块依赖"）。与 `parseFileImports` **共用同一段解析本体**（`parseImportsWith`）：
 * specifier 提取、相对路径归一、候选扩展名、包根候选全部一份口径，只有"目标是否在项目内"的确认方式不同——
 * 真解析拿全项目源码集合（预扫描/遍历得来）确认，探针按**文件存在**确认，因此**不遍历全项目**（探针必须廉价：
 * 它跑在每次文件事件上，不能为了判一条变化去扫整棵树）。
 *
 * 代价如实登记：探针的确认比真解析**宽**（例如"src 下有 .py 才认 src-layout"这条按目录存在近似，
 * 被忽略目录里的文件也算存在）→ 探针可能多认出一条目标。方向是安全的：多认 = 多触发一轮**有界**重解析，
 * 少认才会漏掉真实依赖变化。`null` = 不是源码扩展名（不参与依赖判据）。
 */
export function probeFileImports(root: string, rel: string): FileImports | null {
  const lang = SOURCE_EXTS.get(path.posix.extname(rel).toLowerCase());
  if (lang === undefined) return null;
  // 包根候选与 prepareSources 同口径的**近似**：真解析按"遍历到的源码里有没有 src/*.py"判 src-layout
  const pyImportRoots: string[] = [""];
  try {
    if (fs.statSync(path.join(root, "src")).isDirectory()) pyImportRoots.push("src");
  } catch {
    // 没有 src/ 就只有一个包根（与真解析的缺省一致）
  }
  return parseImportsWith(
    root,
    rel,
    lang,
    (candidate) => {
      try {
        return fs.statSync(path.join(root, ...candidate.split("/"))).isFile();
      } catch {
        return false;
      }
    },
    pyImportRoots,
  );
}

/** 解析本体：`confirm(candidate)` 决定"这个候选目标是否算项目内目标"（真解析=源码集合，探针=文件存在） */
function parseImportsWith(
  root: string,
  rel: string,
  lang: "python" | "typescript" | "tsx" | "javascript",
  confirm: (candidate: string) => boolean,
  pyImportRoots: readonly string[],
): FileImports {
  const skip = (reason: ImportSkipReason): FileImports => ({ targets: [], loc: 0, skip: reason });
  const abs = path.join(root, ...rel.split("/"));
  let text: string;
  try {
    const stat = fs.statSync(abs);
    if (stat.size > MAX_PARSE_BYTES) return skip("too_large"); // 大文件跳过（生成物/数据）
    text = fs.readFileSync(abs, "utf8");
  } catch {
    return skip("unreadable"); // EACCES / EBUSY / 遍历后被删：故障，不许混进"跳过大文件"
  }
  const loc = text.split("\n").length;
  // 解析器隔离：语言包/grammar 出错时只丢这一个文件（调用方按"解析失败"记账），不让整个项目解析全灭
  const parser = parserFor(lang);
  if (!parser) return skip("parse_error");
  let tree: Parser.Tree;
  try {
    tree = parser.parse(text);
  } catch {
    return skip("parse_error");
  }
  const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
  // 权重口径 = import 语句条数：同一条语句只记一个目标（第一个命中的候选），
  // 不同语句指向同一文件各记一条（import a.b + from a.b import x → 权重 2）
  const targets: string[] = [];
  const addTarget = (candidates: string[]) => {
    const hit = candidates.find((c) => confirm(c));
    if (hit) targets.push(hit);
  };
  if (lang === "python") {
    for (const imp of extractPythonImports(tree.rootNode)) {
      if (imp.leadingDots > 0) {
        // 相对 import：leadingDots=1 表当前包（本文件所在目录）
        const baseParts = dir === "" ? [] : dir.split("/");
        const up = imp.leadingDots - 1;
        if (up > baseParts.length) continue; // 相对到项目根外，跳过
        const modPath = [...baseParts.slice(0, baseParts.length - up), ...imp.parts].join("/");
        if (modPath === "") continue;
        addTarget([`${modPath}.py`, `${modPath}/__init__.py`]);
        continue;
      }
      // 绝对 import：按包根候选试（项目根 + src-layout 的 src/），一条语句只记首个命中
      const modPath = imp.parts.join("/");
      if (modPath === "") continue;
      addTarget(
        pyImportRoots.flatMap((base) => {
          const full = base === "" ? modPath : `${base}/${modPath}`;
          return [`${full}.py`, `${full}/__init__.py`];
        }),
      );
    }
  } else {
    for (const spec of extractJsImports(tree.rootNode, lang)) {
      if (!spec.startsWith("./") && !spec.startsWith("../")) continue; // 包名/裸路径不算项目内依赖
      const resolved = path.posix.normalize(path.posix.join(dir === "" ? "." : dir, spec));
      if (resolved.startsWith("..")) continue; // 跳出项目根
      addTarget([
        ...JS_RESOLVE_EXTS.map((e) => resolved + e),
        ...JS_RESOLVE_EXTS.map((e) => `${resolved}/index${e}`),
      ]);
    }
  }
  // 自引用不算边（同一语句解析回本文件时剔除）
  return { targets: targets.filter((t) => t !== rel), loc, skip: null };
}

/** 候选模块：一段路径（顶层目录或细分后的二级目录）+ 根散文件 */
interface Candidate {
  /** 路径前缀（posix；"." 表根散文件） */
  prefix: string;
  files: string[];
}

/** 按"顶层目录 + 文件归属"聚候选；不足 MIN_MODULES 时反复把最大目录按二级目录细分补 */
function buildCandidates(files: string[]): Candidate[] {
  const topDirs = new Map<string, string[]>();
  const rootFiles: string[] = [];
  for (const f of files) {
    if (f.includes("/")) {
      const top = f.slice(0, f.indexOf("/"));
      const arr = topDirs.get(top) ?? [];
      arr.push(f);
      topDirs.set(top, arr);
    } else {
      rootFiles.push(f);
    }
  }
  let candidates: Candidate[] = [...topDirs.entries()]
    .map(([prefix, fs2]) => ({ prefix, files: fs2 }))
    .sort((a, b) => b.files.length - a.files.length || a.prefix.localeCompare(b.prefix));
  if (rootFiles.length > 0) candidates.push({ prefix: ".", files: rootFiles });
  // 少于下限：把文件最多的候选按二级目录细分（细分不出新块即停，防死循环）
  while (candidates.length < MIN_MODULES) {
    const idx = candidates.findIndex(
      (c) => c.prefix !== "." && c.files.some((f) => f.slice(c.prefix.length + 1).includes("/")),
    );
    if (idx === -1) break;
    const target = candidates[idx];
    const subs = new Map<string, string[]>();
    const direct: string[] = [];
    for (const f of target.files) {
      const rest = f.slice(target.prefix.length + 1);
      if (rest.includes("/")) {
        const sub = rest.slice(0, rest.indexOf("/"));
        const key = `${target.prefix}/${sub}`;
        const arr = subs.get(key) ?? [];
        arr.push(f);
        subs.set(key, arr);
      } else {
        direct.push(f);
      }
    }
    if (subs.size === 0) break;
    const next: Candidate[] = [...subs.entries()]
      .map(([prefix, fs2]) => ({ prefix, files: fs2 }))
      .sort((a, b) => b.files.length - a.files.length || a.prefix.localeCompare(b.prefix));
    if (direct.length > 0) next.push({ prefix: target.prefix, files: direct });
    candidates.splice(idx, 1, ...next);
    candidates.sort((a, b) => b.files.length - a.files.length || a.prefix.localeCompare(b.prefix));
  }
  return candidates;
}

/** 旧版有损合并的读侧识别（2026-09-29 六图完整读取轮；同日返工 F3 修正判据）：
 *  旧 mergeOverflow（已删）把超过 15 个的候选压成一个聚合模块落盘。**真实旧落盘形状**（git 历史核实）：
 *  `id:"other"`、`path:"docs,scripts,tests,…"（逗号前缀列表）——「其他:」前缀只在旧内存候选里、从不落盘；
 *  且触发条件是候选 >15、保留 14、其余全并一桶 ⇒ 桶内前缀**必 ≥2**。新版解析 path 恒为单段真实前缀、
 *  id＝slugify(path)（含逗号的目录名 slug 后不再是 "other"；CJK 路径带哈希后缀），因此单段 path
 *  （含真实存在的 other/ 目录）不是旧桶，不误报。这类数据**原始对象不可拆回**（文件归属还在、模块身份没了），
 *  读侧不许默认它完整。处置＝重跑解析（POST /arch/parse）即按新版展开为全部真实候选；不重跑就按现状如实呈现＋标注。 */
export interface LegacyAggregationInfo {
  has_legacy_other: boolean;
  /** 被压进「其他」桶的原始候选（目录前缀）数；无桶为 0 */
  merged_prefixes: number;
}

export function legacyAggregationOf(arch: ArchModulesFile | undefined): LegacyAggregationInfo {
  if (arch === undefined) return { has_legacy_other: false, merged_prefixes: 0 };
  for (const m of arch.modules) {
    // 人工/夹具变体：path 直接带「其他:」前缀（旧内存候选形状；真实落盘不带，读侧一并兼容）
    if (m.path.startsWith("其他:")) {
      const prefixes = m.path.slice(3).split(",").filter((p) => p !== "");
      return { has_legacy_other: true, merged_prefixes: Math.max(1, prefixes.length) };
    }
    // 真实旧落盘：id="other" 且 path 为 ≥2 段逗号列表（新版解析产不出这种形状）
    if (m.id === "other") {
      const segments = m.path.split(",").filter((p) => p !== "");
      if (segments.length >= 2) return { has_legacy_other: true, merged_prefixes: segments.length };
    }
  }
  return { has_legacy_other: false, merged_prefixes: 0 };
}

/** 遍历后的解析准备：源码文件集合 + Python 包根候选（同步/异步两条执行路共用，口径一处） */
interface ParsePrep {
  sourceFiles: string[];
  sourceSet: Set<string>;
  pyImportRoots: string[];
}

function prepareSources(files: string[]): ParsePrep {
  const sourceFiles = files.filter((f) => SOURCE_EXTS.has(path.posix.extname(f).toLowerCase()));
  const sourceSet = new Set(sourceFiles);
  // Python 绝对 import 的包根候选：项目根 + src-layout（src/ 下有 .py 即认定）
  const pyImportRoots: string[] = [""];
  if (sourceFiles.some((f) => f.startsWith("src/") && f.endsWith(".py"))) pyImportRoots.push("src");
  return { sourceFiles, sourceSet, pyImportRoots };
}

/** 装配输入：遍历 + 逐文件 import 解析的中段产物（同步 parseDirectory 与后台 parseDirectoryAsync
 *  共用这**同一份装配**——两条路的产出口径只有一处，不会各算一遍） */
interface ParseAssemblyInput {
  files: string[];
  perFile: Map<string, FileImports>;
  sourceFileCount: number;
  budgetExhausted: boolean;
  skippedLarge: number;
  skippedUnreadable: number;
  parseFailed: number;
  importCount: number;
  parseMs: number;
  t0: number;
}

/** 装配：模块划分（不足下限细分补；**超出不合并**——2026-09-29 起，候选全量落盘，
 *  防爆炸由概览投影层施加）→ 文件→模块 id → 依赖边聚合（权重 = import 条数，§4.3 第 3 招）。
 *  Q133：到点收工的标记随模块集一起落盘（不然刷新/重启后没人知道这份是残缺的）；
 *  标记与 stats 同源同一个 budgetExhausted，不许两处各算一遍。 */
function assembleParseResult(input: ParseAssemblyInput): Omit<ParseResult, "source"> {
  const candidates = buildCandidates(input.files);
  // 文件 → 模块 id（文件在候选收集时就按前缀归属，这里逐文件登记）
  const moduleOf = new Map<string, string>();
  const modules: ArchModule[] = candidates.map((c) => {
    const id = slugify(c.prefix);
    for (const f of c.files) moduleOf.set(f, id);
    return {
      id,
      name: "", // A2 Flash 起名填
      path: c.prefix,
      file_count: c.files.length,
      loc: 0,
      deps: [],
    };
  });
  const byId = new Map(modules.map((m) => [m.id, m]));

  // ── 依赖边聚合：文件间 import → 模块间边（权重 = import 条数，§4.3 第 3 招）──
  const edgeWeight = new Map<string, number>(); // "from>to"
  for (const [rel, imp] of input.perFile) {
    const fromId = moduleOf.get(rel);
    if (!fromId) continue;
    const m = byId.get(fromId)!;
    m.loc += imp.loc;
    for (const target of imp.targets) {
      const toId = moduleOf.get(target);
      if (!toId || toId === fromId) continue; // 模块内边不画（顶层只画模块间）
      const key = `${fromId}>${toId}`;
      edgeWeight.set(key, (edgeWeight.get(key) ?? 0) + 1);
    }
  }
  for (const [key, weight] of [...edgeWeight.entries()].sort()) {
    const [from, to] = key.split(">");
    byId.get(from)!.deps.push({ to, weight });
  }

  return {
    file: { version: 1, generated_at: new Date().toISOString(), modules, budget_exhausted: input.budgetExhausted },
    duration_ms: Date.now() - input.t0,
    parse_ms: Math.round(input.parseMs * 100) / 100,
    stats: {
      source_files: input.sourceFileCount,
      skipped_large: input.skippedLarge,
      /** 读失败的源码文件数（IO/权限/被占用）：与 skipped_large 分开，不许伪装成策略性跳过 */
      skipped_unreadable: input.skippedUnreadable,
      /** 解析失败的源码文件数（parser/grammar 异常，见 parserFor 的隔离兜底） */
      parse_failed: input.parseFailed,
      imports: input.importCount,
      budget_exhausted: input.budgetExhausted,
    },
  };
}

/**
 * 扫目录本体（核心，与项目 id 解耦，便于对任意目录验证）。
 * 全程只读；不写 modules.json（落盘是 parseProject 的事，临时目录验证不产文件）。
 * **同步执行**：脚本与既有同步调用方（A1 验证、A4 按范围下钻）走这条；HTTP 全量解析正式入口
 * 走文件末的后台 run（parseDirectoryAsync + startParseProjectRun，DESIGN §11.8），产物口径两处一致。
 */
export function parseDirectory(root: string): Omit<ParseResult, "source"> {
  const t0 = Date.now();
  const deadline = t0 + WALK_LIMITS.maxMs;
  const abs = path.resolve(root);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    throw new WsError("INVALID_INPUT", `目录不存在或不是目录: ${abs}`);
  }
  const walked = boundedWalk(abs, { maxFiles: WALK_LIMITS.maxFiles, maxMs: deadline - Date.now() });
  const files = walked.files;
  let budgetExhausted = walked.truncated;
  const prep = prepareSources(files);

  // ── 解析阶段（毫秒级口径的计时对象：只算 tree-sitter parse + import 提取）──
  let parseMs = 0;
  let skippedLarge = 0;
  let skippedUnreadable = 0;
  let parseFailed = 0;
  let importCount = 0;
  const perFile = new Map<string, FileImports>();
  for (const rel of prep.sourceFiles) {
    if (Date.now() > deadline) {
      budgetExhausted = true; // 预算到点：不再解析后续文件（已解析的照常出图，缺口由 stats 标出）
      break;
    }
    const lang = SOURCE_EXTS.get(path.posix.extname(rel).toLowerCase())!;
    const p0 = performance.now();
    const result = parseFileImports(abs, rel, lang, prep.sourceSet, prep.pyImportRoots);
    parseMs += performance.now() - p0;
    if (result.skip) {
      // 三种跳过分开记账：大文件是策略，读失败/解析失败是故障（不许混成一笔"跳过大文件"）
      if (result.skip === "too_large") skippedLarge++;
      else if (result.skip === "unreadable") skippedUnreadable++;
      else parseFailed++;
      continue;
    }
    perFile.set(rel, result);
    importCount += result.targets.length;
  }
  return assembleParseResult({
    files,
    perFile,
    sourceFileCount: prep.sourceFiles.length,
    budgetExhausted,
    skippedLarge,
    skippedUnreadable,
    parseFailed,
    importCount,
    parseMs,
    t0,
  });
}

const modulesJsonPath = (root: string) => path.join(root, ".工作台", "arch", "modules.json");

/** 原子写 JSON：先写临时文件再 rename，防半截文件（与 workstation.writeJsonAtomic 同一惯例） */
function writeJsonAtomic(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);
}

/**
 * modules.json 的**内容稳定落盘**（2026-10-05 六图/同步修复）：
 *
 * 事由：`generated_at` 每轮重解析都取 nowIso，**语义内容完全没变**的一轮也会把整文件字节换掉。
 * 同步证据契约允许把派生文件按**整文件 sha256** 绑定为 artifact（docs/sync-evidence-contract.md），
 * 于是「健康的图刷新」持续把已通过的同步批次打回 invalid、接续反复 blocked
 * （实测 demo-project-stage-v2-20261004 一天内 invalid↔passed 翻转十余次）。
 *
 * 修法：**语义内容不变就不重写**——新产物与现有落盘件各剥掉 `generated_at` 后逐字节相等时，
 * 保留旧文件原字节（旧时间戳一并保留），文件哈希与快照输入（graphInputSha 读的就是这份文件）都稳定；
 * 内容真变了照常原子覆盖（真实漂移仍被同步侧识别——校验一个不放松，syncChecks.ts 不动）。
 * 读不出现有件/现有件损坏（形状校验失败）时按「内容变了」处理照常覆盖，不因旧件坏而不写。
 */
function writeModulesStable(file: string, next: ArchModulesFile): void {
  const stripVolatile = (v: ArchModulesFile): string => {
    const { generated_at: _dropped, ...rest } = v;
    return JSON.stringify(rest);
  };
  try {
    const existing = JSON.parse(fs.readFileSync(file, "utf8")) as ArchModulesFile;
    if (stripVolatile(existing) === stripVolatile(next)) return; // 语义没变：不重写，保住旧字节/旧哈希
  } catch {
    // 没有旧件/旧件读不出：视为内容变了，走正常覆盖
  }
  writeJsonAtomic(file, next);
}

/** 按注册表项目 id 解析并落盘 `.工作台/arch/modules.json`（**同步契约**：验证脚本与既有同步调用方
 *  的入口；HTTP `POST /arch/parse` 正式入口已转后台可取消 run——见文件末 startParseProjectRun，
 *  取消/失败不落盘的语义只有后台路有保证，这里的口径仍是"跑完即原子覆盖"。路径只走注册表） */
export function parseProject(projectId: string, dataDir?: string): ParseResult {
  const project = getProject(projectId, dataDir);
  if (!project) {
    throw new WsError("PROJECT_NOT_FOUND", `项目不存在: ${projectId}`);
  }
  const result = parseDirectory(project.path);
  const source = modulesJsonPath(project.path);
  writeModulesStable(source, result.file);
  return { ...result, source };
}

/** modules.json 落盘件的运行时结构校验（2026-09-29 定向收尾 R1）：盘上文件可能被外部改坏——
 *  合法 JSON 但结构不对（modules:null／缺 modules／模块缺 path／path:null），而读侧的
 *  legacyAggregationOf / buildSharedGraphFrom / graphRefresh.modulePathsOf 都直接摸
 *  arch.modules 与逐模块的 id/path/deps，形状不对就是 TypeError 级炸整个读口。
 *  在读取边界做必要校验（只校验读侧会真摸的字段）：坏了抛 WsError(INVALID_INPUT) 并带
 *  可定位的具体原因，调用方的既有异常保护照旧各自降级——sixGraphs 降级 collection=unknown、
 *  graphRefresh 按 null 缓存。只吞异常继续跑、还把完整性标 complete 的做法不算修复。 */
function validateArchShape(parsed: unknown): asserts parsed is ArchModulesFile {
  const bad = (detail: string): WsError => new WsError("INVALID_INPUT", `modules.json 损坏: ${detail}`);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw bad("顶层不是对象");
  const modules = (parsed as { modules?: unknown }).modules;
  if (!Array.isArray(modules)) {
    throw bad(`modules 不是数组（${modules === undefined ? "缺席" : `实际是 ${modules === null ? "null" : typeof modules}`}）`);
  }
  modules.forEach((m, i) => {
    if (typeof m !== "object" || m === null || Array.isArray(m)) throw bad(`第 ${i} 个模块不是对象`);
    const mm = m as { id?: unknown; path?: unknown; deps?: unknown };
    if (typeof mm.id !== "string") throw bad(`第 ${i} 个模块 id 不是字符串`);
    if (typeof mm.path !== "string") throw bad(`第 ${i} 个模块 path 不是字符串`);
    if (!Array.isArray(mm.deps)) throw bad(`第 ${i} 个模块 deps 不是数组`);
  });
}

/** 读已落盘的 modules.json；不存在返回 {exists:false}（200 空态，不是错误）。
 *  2026-09-29 定向收尾 R3：budget_exhausted 只认布尔——非布尔标记（"true"、1 等）不回显
 *  （回显就是违反 ArchModulesFile.budget_exhausted?: boolean 的接口类型），读取边界剥掉该键、
 *  另立 budget_marker_invalid 标记；读侧（sixGraphs 的顶层 collection）据此判「未知」并记原因，
 *  不落进 complete 分支。合法布尔与「旧件无标记」两态语义不变（预算耗尽 vs 分页取完依旧独立）。 */
export function readModules(
  projectId: string,
  dataDir?: string,
): { exists: boolean; source?: string; arch?: ArchModulesFile; budget_marker_invalid?: true } {
  const project = getProject(projectId, dataDir);
  if (!project) {
    throw new WsError("PROJECT_NOT_FOUND", `项目不存在: ${projectId}`);
  }
  const source = modulesJsonPath(project.path);
  if (!fs.existsSync(source)) return { exists: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(source, "utf8"));
  } catch (e) {
    throw new WsError("INVALID_INPUT", `modules.json 损坏: ${(e as Error).message}`);
  }
  validateArchShape(parsed);
  const marker = parsed.budget_exhausted;
  if (marker === undefined || typeof marker === "boolean") {
    return { exists: true, source, arch: parsed };
  }
  const arch: ArchModulesFile = { ...parsed };
  delete (arch as { budget_exhausted?: unknown }).budget_exhausted;
  return { exists: true, source, arch, budget_marker_invalid: true };
}

// ══════════════════════════════════════════════════════════════════════════════
// 后台可取消的全量解析（DESIGN.md §11.8「全量扫描放后台且可取消；前台按范围读取」，
// 批3终审 T19）：POST /api/projects/:id/arch/parse 的正式执行形态。
//
// 旧形态（实测旧红，证据 .工作台/t19-evidence/probe-old-result.json）：HTTP 回调里同步
// parseProject，四千文件夹具把事件循环冻结 ~3s（/health 最大延迟 3431ms、SSE 首帧 2963ms、
// 无任何取消口、客户端断开服务端仍覆盖写）。新形态：
//   · 遍历按目录、解析按片（PARSE_YIELD_FILES 个文件或 ≥PARSE_YIELD_MS 毫秒）协作式让出
//     事件循环（scanner.ts atCheckpoint 同一手法），前台请求不再阻塞事件循环；
//   · 每项目**单飞**：进行中重复 POST 直接挂到同一个 run（deduplicated），不另起——
//     同时只有一个写者，旧 run 不可能覆盖新 run 的结果；
//   · 取消/失败**不落盘**：部分结果丢弃，旧 modules.json 原样保留（可能已过期，如实可查）；
//     只有跑完的结果（含 budget_exhausted 如实标记，不冒充完整）才走原子写口；
//   · 同步 parseDirectory/parseProject 契约不变（脚本与 A4 按范围下钻继续用）。
// ══════════════════════════════════════════════════════════════════════════════

/** 解析让出节奏：逐文件解析每过这么多文件、或距上次让出超过这么多毫秒，就让出一次事件循环并查取消 */
const PARSE_YIELD_FILES = 32;
const PARSE_YIELD_MS = 10;

/** 后台解析进度（run 状态查询与取消回执共用同一形状） */
export interface ParseRunProgress {
  phase: "walking" | "parsing";
  walked_files: number;
  parsed_files: number;
  /** 源码文件总数（遍历完成后才知道；walking 阶段为 null） */
  source_files: number | null;
}

/** 安全检查点注入（验证用；产品 HTTP 路径不传）——让"取消"发生在确定位置，不靠 sleep 竞态 */
export interface ParseHooks {
  /** 检查点观测：每个让出点调一次（仅观测，不改语义） */
  onCheckpoint?: (progress: ParseRunProgress) => void;
  /** 检查点判定：返回 true 请求停止（与进程内取消标记取或） */
  shouldCancel?: (progress: ParseRunProgress) => boolean;
}

/** 运行态：取消标记 + 钩子（runner 与异步执行体共享同一份） */
interface ParseRuntime {
  cancelRequested: boolean;
  hooks?: ParseHooks;
}

export type ParseRunStatus = "running" | "done" | "cancelled" | "failed";

/** 成功结果（与旧同步 POST /arch/parse 应答的 result 同形状，UI/脚本契约不变） */
export interface ParseRunResult {
  source: string;
  module_count: number;
  duration_ms: number;
  parse_ms: number;
  stats: ArchParseStats;
}

/** 一次后台解析 run 的可查询现场（进程内；重启即失——落盘事实以 modules.json 为准，状态只是执行现场） */
export interface ParseRun {
  id: string;
  project_id: string;
  status: ParseRunStatus;
  started_at: string;
  finished_at: string | null;
  progress: ParseRunProgress;
  /** status=done 时的结果；其余状态为 null（cancelled/failed 没有结果，不冒充） */
  result: ParseRunResult | null;
  error_code: string | null;
  error: string | null;
}

/** 取消回执（DELETE /api/projects/:id/arch/parse 的应答体；形状对齐 ScanCancelReceipt） */
export interface ParseCancelReceipt {
  /** 是否真取消了一次**进行中**的解析 */
  cancelled: boolean;
  project_id: string;
  /** 被取消的 run；没有进行中的解析时为 null */
  run_id: string | null;
  /** 请求取消时的位置/已完成量；没有进行中的解析时为 null */
  progress: ParseRunProgress | null;
  /** 是否丢弃了未完成的部分结果（cancelled=true 时恒 true） */
  partial: boolean;
  note: string;
}

export interface ParseRunHandle {
  run: ParseRun;
  /** 终态承诺：永远 resolve、不 reject；终态看 run.status（done/cancelled/failed） */
  done: Promise<ParseRun>;
  /** true = 命中同项目进行中 run（单飞去重），本次没有另起 */
  deduplicated: boolean;
}

/** 安全检查点（scanner.ts atCheckpoint 同一手法）：观测 → **真让出一次事件循环** → 判定取消。
 *  让出是必须的：HTTP DELETE 的取消回调只在事件循环空转时才能落地，下一个检查点即命中停手。 */
async function atParseCheckpoint(rt: ParseRuntime, progress: ParseRunProgress): Promise<boolean> {
  rt.hooks?.onCheckpoint?.({ ...progress });
  await new Promise<void>((resolve) => setImmediate(resolve));
  return rt.cancelRequested || rt.hooks?.shouldCancel?.({ ...progress }) === true;
}

/** boundedWalk 的异步版：同一预算口径（WALK_LIMITS），每个目录边界让出一次事件循环并查取消。
 *  取消返回 cancelled:true（清单直接丢弃）；截断/错误的口径与同步版一致。 */
async function boundedWalkAsync(
  root: string,
  budget: WalkBudget,
  rt: ParseRuntime,
  progress: ParseRunProgress,
): Promise<{ files: string[]; truncated: boolean; cancelled: boolean }> {
  const files: string[] = [];
  const deadline = Date.now() + budget.maxMs;
  const overBudget = () => files.length >= budget.maxFiles || Date.now() > deadline;
  const stack: string[] = [root];
  while (stack.length > 0) {
    progress.walked_files = files.length;
    if (await atParseCheckpoint(rt, progress)) return { files, truncated: false, cancelled: true };
    if (overBudget()) return { files, truncated: true, cancelled: false };
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // 无权限/损坏目录跳过，不炸整个解析
    }
    for (const e of entries) {
      if (overBudget()) return { files, truncated: true, cancelled: false };
      if (e.isDirectory()) {
        if (isJunkDir(e.name)) continue;
        stack.push(path.join(dir, e.name));
        continue;
      }
      if (e.isSymbolicLink() || !e.isFile()) continue;
      files.push(toRel(root, path.join(dir, e.name)));
    }
  }
  return { files, truncated: false, cancelled: false };
}

/** parseDirectory 的后台异步版：同一预算、同一装配、同一产出口径；区别只在执行形态——
 *  遍历按目录、解析按片让出事件循环并查取消。取消返回 { cancelled:true }（runner 据此不落盘）；
 *  抛错口径与同步版一致（如目录不存在 INVALID_INPUT）。 */
async function parseDirectoryAsync(
  root: string,
  rt: ParseRuntime,
  progress: ParseRunProgress,
): Promise<{ cancelled: true } | { cancelled: false; result: Omit<ParseResult, "source"> }> {
  const t0 = Date.now();
  const deadline = t0 + WALK_LIMITS.maxMs;
  const abs = path.resolve(root);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    throw new WsError("INVALID_INPUT", `目录不存在或不是目录: ${abs}`);
  }
  progress.phase = "walking";
  const walked = await boundedWalkAsync(abs, { maxFiles: WALK_LIMITS.maxFiles, maxMs: deadline - Date.now() }, rt, progress);
  if (walked.cancelled) return { cancelled: true };
  const files = walked.files;
  let budgetExhausted = walked.truncated;
  const prep = prepareSources(files);
  progress.phase = "parsing";
  progress.source_files = prep.sourceFiles.length;

  let parseMs = 0;
  let skippedLarge = 0;
  let skippedUnreadable = 0;
  let parseFailed = 0;
  let importCount = 0;
  let sinceYield = 0;
  let lastYield = Date.now();
  const perFile = new Map<string, FileImports>();
  for (const rel of prep.sourceFiles) {
    if (Date.now() > deadline) {
      budgetExhausted = true; // 与同步版同一口径：到点不再开新活，缺口由 stats 标出
      break;
    }
    const lang = SOURCE_EXTS.get(path.posix.extname(rel).toLowerCase())!;
    const p0 = performance.now();
    const result = parseFileImports(abs, rel, lang, prep.sourceSet, prep.pyImportRoots);
    parseMs += performance.now() - p0;
    if (result.skip) {
      if (result.skip === "too_large") skippedLarge++;
      else if (result.skip === "unreadable") skippedUnreadable++;
      else parseFailed++;
    } else {
      perFile.set(rel, result);
      importCount += result.targets.length;
    }
    progress.parsed_files += 1;
    sinceYield += 1;
    if (sinceYield >= PARSE_YIELD_FILES || Date.now() - lastYield >= PARSE_YIELD_MS) {
      if (await atParseCheckpoint(rt, progress)) return { cancelled: true };
      sinceYield = 0;
      lastYield = Date.now();
    }
  }
  return {
    cancelled: false,
    result: assembleParseResult({
      files,
      perFile,
      sourceFileCount: prep.sourceFiles.length,
      budgetExhausted,
      skippedLarge,
      skippedUnreadable,
      parseFailed,
      importCount,
      parseMs,
      t0,
    }),
  };
}

/** 进行中 run 的登记表（进程内，每项目至多一个＝单飞）与每项目最近一次 run 的留存（供状态查询） */
interface ActiveParseRun {
  run: ParseRun;
  rt: ParseRuntime;
  done: Promise<ParseRun>;
}
const activeParseRuns = new Map<string, ActiveParseRun>();
const lastParseRuns = new Map<string, ParseRun>();

/**
 * 启动（或挂上）某项目的后台解析 run——`POST /api/projects/:id/arch/parse` 的执行入口。
 * 单飞：同项目已有进行中 run 时**不另起**，直接返回既有 run 的句柄（deduplicated:true）——
 * 同时只有一个写者、且只有跑完才写，旧 run 覆盖新结果的事故在结构上不可能发生。
 * 取消（rt.cancelRequested）在下一个安全检查点生效：部分结果丢弃、modules.json 不动；
 * 失败同理不落盘，错误如实记进 run（error_code/error）。项目不存在抛 PROJECT_NOT_FOUND（同步，与旧口径一致）。
 */
export function startParseProjectRun(projectId: string, dataDir?: string, hooks?: ParseHooks): ParseRunHandle {
  const project = getProject(projectId, dataDir);
  if (!project) {
    throw new WsError("PROJECT_NOT_FOUND", `项目不存在: ${projectId}`);
  }
  const active = activeParseRuns.get(project.id);
  if (active) return { run: active.run, done: active.done, deduplicated: true };
  const run: ParseRun = {
    id: crypto.randomUUID(),
    project_id: project.id,
    status: "running",
    started_at: new Date().toISOString(),
    finished_at: null,
    progress: { phase: "walking", walked_files: 0, parsed_files: 0, source_files: null },
    result: null,
    error_code: null,
    error: null,
  };
  const rt: ParseRuntime = { cancelRequested: false, hooks };
  let settle!: (r: ParseRun) => void;
  const done = new Promise<ParseRun>((resolve) => {
    settle = resolve;
  });
  activeParseRuns.set(project.id, { run, rt, done });
  void (async () => {
    try {
      const outcome = await parseDirectoryAsync(project.path, rt, run.progress);
      if (outcome.cancelled) {
        // 取消不落盘：部分结果丢弃，旧 modules.json 原样保留（可能已过期——如实，不冒充最新）
        run.status = "cancelled";
      } else {
        const source = modulesJsonPath(project.path);
        writeModulesStable(source, outcome.result.file);
        run.status = "done";
        run.result = {
          source,
          module_count: outcome.result.file.modules.length,
          duration_ms: outcome.result.duration_ms,
          parse_ms: outcome.result.parse_ms,
          stats: outcome.result.stats,
        };
      }
    } catch (e) {
      // 失败不落盘：旧 modules.json 原样保留；错误如实带回（HTTP 侧按既有 wsFail 口径出 4xx/5xx）
      run.status = "failed";
      run.error_code = e instanceof WsError ? e.code : "INTERNAL";
      run.error = (e as Error)?.message ?? String(e);
    } finally {
      run.finished_at = new Date().toISOString();
      activeParseRuns.delete(project.id);
      lastParseRuns.set(project.id, run);
      settle(run);
    }
  })();
  return { run, done, deduplicated: false };
}

/**
 * 请求取消某项目**进行中**的解析（`DELETE /api/projects/:id/arch/parse` 的入口）。
 * 没有进行中的解析时如实回 `cancelled:false` 加原因，不报错；项目不存在按既有口径抛 PROJECT_NOT_FOUND。
 * 取消在下一个安全检查点生效（遍历按目录、解析按片），生效前的一小片工作是诚实的既定边界。
 */
export function requestParseCancel(projectId: string, dataDir?: string): ParseCancelReceipt {
  const project = getProject(projectId, dataDir);
  if (!project) {
    throw new WsError("PROJECT_NOT_FOUND", `项目不存在: ${projectId}`);
  }
  const active = activeParseRuns.get(project.id);
  if (!active) {
    return {
      cancelled: false,
      project_id: project.id,
      run_id: null,
      progress: null,
      partial: false,
      note: "该项目当前没有进行中的解析（无需取消）",
    };
  }
  active.rt.cancelRequested = true;
  return {
    cancelled: true,
    project_id: project.id,
    run_id: active.run.id,
    progress: { ...active.run.progress },
    partial: true,
    note: "已请求取消：解析在下一个安全检查点停止，部分结果不写入 modules.json，沿用上次完整落盘状态（可能已过期）",
  };
}

/** 查某项目解析 run 的现场：进行中优先，否则最近一次（done/cancelled/failed），都没有返回 null。
 *  项目不存在抛 PROJECT_NOT_FOUND（与读路由同口径）。 */
export function getParseRunStatus(projectId: string, dataDir?: string): ParseRun | null {
  const project = getProject(projectId, dataDir);
  if (!project) {
    throw new WsError("PROJECT_NOT_FOUND", `项目不存在: ${projectId}`);
  }
  return activeParseRuns.get(project.id)?.run ?? lastParseRuns.get(project.id) ?? null;
}
