// A4：逐级下钻的子树解析（DESIGN.md §3.3 规则 2/3 + §4.1 下钻层 + §4.3 第 2 招分层懒加载）。
// 对指定模块路径**就地**扫描直接子级：子目录成子模块节点、文件成文件节点——
// **文件名即名字，LLM 零参与**（§4.1 红线：文件层纯静态，本文件不 import 任何 flash 模块）。
// 懒加载硬约束（§4.3 第 2 招）：tree-sitter 只解析该子树范围内的源码文件；
// 子树外只走文件名清单（判断 import 是否指向子树外），一个字节都不读、不解析。
// 复用 A1 同一把解析器（parse.ts）与同一忽略口径（IGNORED_SEGMENTS），不自己发明轮子。
// N2 加两处降级（都只为巨枝，正常项目不触发）：
//   ① 单枝子级硬上限（§4.3 第 1 招，数值与实现都在共用数据层，本文件只调用）：超上限的子级
//      **在遍历之前**就被截掉 → 不遍历、不解析、不渲染，变成一个聚合节点；
//   ② 全项目文件名清单按需走：一个待解析文件都没有时它零用途（唯一用途是判定 import 目标在不在
//      项目内），此时跳过这趟全目录遍历。
// A1/A4 共用第三处降级（WALK_LIMITS，与 parse.ts 同一口径）：子树遍历与解析都带文件数/耗时预算——
// 保留子级的**整棵子树**原本没有上限（只截了宽度没截深度），万级文件会把请求线程占满；
// 到点收工，缺口由 stats.budget_exhausted 标出（不许当成"这就是全部"）。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { getProject } from "../server/registry";
import { WsError } from "../server/workstation";
import {
  IGNORED_SEGMENTS,
  SOURCE_EXTS,
  WALK_LIMITS,
  boundedWalk,
  parseFileImports,
  slugify,
} from "./parse";
import { capChildren } from "./shared-graph";
import { ARCH_LIMITS, CHANGE_DOT_WINDOW_HOURS } from "./config";

/** 子级节点（子模块=目录 / 文件节点 / 聚合节点） */
export interface ExpandChild {
  /** 稳定 id：相对项目根路径 slug（与 A1 顶层模块同一口径，含非 ASCII 的路径带 sha1 短后缀）；聚合节点为 `<聚合 id>:<父 slug>` */
  id: string;
  /** 文件名/目录名即名字（§4.1：文件层 LLM 不碰，文件名即名字）；聚合节点为「还有 N 个」 */
  name: string;
  /** 相对项目根路径（正斜杠；聚合节点为 ""，不可下钻） */
  path: string;
  /** dir=可继续下钻的子模块；file=文件节点（叶子，无子级）；aggregate=超上限聚合节点（§4.3 第 1 招，叶子） */
  kind: "dir" | "file" | "aggregate";
  /** dir 为子树文件数；file 恒 1；aggregate 恒 0（被截断的枝不遍历，故无文件数） */
  file_count: number;
  /** 源码行数（只统计被解析的源码文件；非源码文件 0） */
  loc: number;
  /** 叶子标记：文件级再往下钻 = 无子级（§3.3 规则 3 的终点）；聚合节点恒 true */
  leaf: boolean;
  /** 指向同级兄弟节点的聚合依赖边（权重 = import 条数，§4.3 第 3 招） */
  deps: { to: string; weight: number }[];
  /** A5 文件级「有变动」点（§4.2）：近 CHANGE_DOT_WINDOW_HOURS 小时 changes.jsonl 有记录才标；仅文件节点 */
  changed_recently?: boolean;
}

/** 指向子树外的依赖（对外边）：只记目标相对路径与权重，前端本期不画，留作对账/验证素材 */
export interface ExpandExternalDep {
  from: string;
  to_path: string;
  weight: number;
}

export interface ExpandResult {
  parent: { id: string; path: string };
  children: ExpandChild[];
  external: ExpandExternalDep[];
  /** 全量耗时（含遍历/IO） */
  duration_ms: number;
  /** tree-sitter 解析阶段耗时（毫秒级口径，同 A1） */
  parse_ms: number;
  /** 红线证据：文件层 LLM 调用次数，恒 0（本模块无任何 LLM 依赖） */
  llm_calls: 0;
  /** 本次生效的子级硬上限与截断量（§4.3 第 1 招；truncated.children = 0 表示没触发上限） */
  limit: { children: number };
  truncated: { children: number };
  /** V09-22 契约 2：传了 `childrenOffset` 时（含 0）给出的**稳定分页**四字段——
   *  子级列表＝排序后全量直接子级的 `[childrenOffset, childrenOffset+childrenLimit)` 窗口，
   *  全是真实子级、**不**为聚合节点保留名额、不带 `__more__`。缺省调用不带这四字段（逐字节不变）。 */
  children_total?: number;
  children_offset?: number;
  children_returned?: number;
  children_has_more?: boolean;
  /** V09-35（契约 U3）：传了 `childrenSource` 的分页调用才带——直接子级**身份清单指纹**
   *  （排序后的 `kind\0name` 的 sha256，完整 64 位）。它只证明"分页窗口的成员集合未变"，
   *  **不**证明子级内容未变（内容证明要靠实际内容核验，mtime/size/seq 都不算，DESIGN §6.8／契约 U1）。
   *  同一指纹下逐页取回无漏无重；指纹变了⇒分页来源版本失效，调用方须从 0 重取（不跨版本拼页）。 */
  children_fingerprint?: string;
  stats: {
    /** 子树内文件总数（截断时只算保留的那部分：被截断的枝不遍历，§4.3 第 2 招） */
    subtree_files: number;
    /** 实际被 tree-sitter 解析的文件清单（懒加载证据：全部落在子树内） */
    parsed_files: string[];
    skipped_large: number;
    /** 读失败的源码文件数（IO/权限/被占用）：与 skipped_large 分开，不许伪装成策略性跳过 */
    skipped_unreadable: number;
    /** 解析失败的源码文件数（parser/grammar 异常） */
    parse_failed: number;
    imports: number;
    /** 因截断而跳过的全项目文件名清单（true = 本次一个 import 都没解析，故不需要它） */
    skipped_project_walk: boolean;
    /** 遍历/解析因预算（文件数或耗时闸门）提前收工：结果不完整，调用方必须与"就是全部"区分 */
    budget_exhausted: boolean;
  };
}

const toRel = (root: string, abs: string) =>
  path.relative(root, abs).split(path.sep).join("/");

/** Windows 上盘符/大小写不敏感：包含判断按平台归一，避免同路径大小写差异造成误判 */
const sameOrInside = (root: string, target: string): boolean => {
  const r = process.platform === "win32" ? root.toLowerCase() : root;
  const t = process.platform === "win32" ? target.toLowerCase() : target;
  return t === r || t.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
};

/**
 * V09-35（契约 U3）：直接子级**身份清单指纹**——分页的「来源版本」。
 * 只吃 `kind`（dir/file）+ 名字，排序后 sha256（完整 64 位）。分页窗口只由"有哪些子级、
 * 是目录还是文件"决定；子级内容变化不动窗口（故**不**声称内容未变）。增/删/改名/换类型 → 指纹变。
 */
export function directChildrenFingerprint(entries: readonly { name: string; kind: "dir" | "file" }[]): string {
  const lines = entries.map((e) => `${e.kind}\u0000${e.name}`).sort();
  return crypto.createHash("sha256").update(lines.join("\n"), "utf8").digest("hex");
}

/** 变动点集合缓存：(文件路径, mtime, size) 未变即同一份内容——changes.jsonl 是追加流水，
 *  只有"又追加了"才会变 size/mtime。A4 每展开一个节点都要这份集合，万行级全量重读纯属重复 IO。 */
let changedCache: { file: string; mtimeMs: number; size: number; set: Set<string> } | null = null;

/**
 * A5 文件级变动点（§4.2 文件级只标一个点）：近 CHANGE_DOT_WINDOW_HOURS 小时
 * changes.jsonl 里有记录的文件相对路径集合。容错解析（坏行跳过）——变动点是提示信号，
 * 不是事实源校验（流水坏行归 H 系卡的 readChanges 管——那边现在也是"跳过坏行 + 限频告警"，Q32）。
 * 结果按 (文件, mtime, size) 缓存复用，同一次展开里的多次调用只读一遍盘。
 */
function recentChangedPaths(root: string): Set<string> {
  const file = path.join(root, ".工作台", "changes.jsonl");
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return new Set(); // 没跑过监听的项目：无变动点（不缓存，下次仍按盘上实况判）
  }
  if (
    changedCache &&
    changedCache.file === file &&
    changedCache.mtimeMs === stat.mtimeMs &&
    changedCache.size === stat.size
  ) {
    return changedCache.set;
  }
  const out = new Set<string>();
  const cutoff = Date.now() - CHANGE_DOT_WINDOW_HOURS * 3600_000;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const text = line.trim();
    if (!text) continue;
    try {
      const l = JSON.parse(text) as { ts?: unknown; path?: unknown };
      if (
        typeof l.ts === "string" &&
        typeof l.path === "string" &&
        Date.parse(l.ts) >= cutoff
      ) {
        out.add(l.path);
      }
    } catch {
      // 坏行跳过，不影响展开
    }
  }
  changedCache = { file, mtimeMs: stat.mtimeMs, size: stat.size, set: out };
  return out;
}

/**
 * 扫目录子树本体（核心，与项目 id 解耦，便于对任意目录验证）。全程只读，不落盘。
 * @param root 项目根（绝对或相对）
 * @param modulePath 相对项目根的模块路径（posix；"." = 根散文件模块，只展开根直属文件）
 * @param opts.childrenLimit 本次生效的单枝子级硬上限（V09-22 全量模式传 RENDER_FULL_LIMITS.MAX_CHILDREN；
 *   缺省走 config.ts 的 ARCH_LIMITS.MAX_CHILDREN，行为与概览默认逐字节相同）。截断仍在遍历子树**之前**
 *   落地；full 时 readdir 本来就全读了，直接子级全量列出，子树遍历仍走 WALK_LIMITS 预算、
 *   budget_exhausted 照实带出。
 * @param opts.childrenOffset V09-22 契约 2：传了它（含 0）即切到**稳定分页**模式——不再截断成「还有 N 个」
 *   聚合节点，而是把排序后全量直接子级按 `[childrenOffset, childrenOffset+childrenLimit)` 开窗，
 *   全是真实子级；返回体额外带 children_total/offset/returned/has_more 四字段。不传（undefined）＝
 *   缺省调用，行为与概览默认逐字节相同（不含这四字段）。
 * @param opts.childrenSource V09-35（契约 U3）：仅分页模式下生效——额外带 `children_fingerprint`
 *   （直接子级身份清单指纹＝分页来源版本）。缺省不传＝HTTP/旧调用输出逐字节不变。
 */
export function expandDirectory(
  root: string,
  modulePath: string,
  opts: { childrenLimit?: number; childrenOffset?: number; childrenSource?: boolean } = {},
): ExpandResult {
  const t0 = Date.now();
  const deadline = t0 + WALK_LIMITS.maxMs;
  const abs = path.resolve(root);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    // L2 复审修正：错误文案不得外发本机绝对根路径（MCP 回执侧没有 HTTP 的 withoutLocalPaths 脱敏）。
    // 只给项目相对信息：调用方能据此知道"项目根不可用"，同时不泄漏磁盘布局。
    throw new WsError("INVALID_INPUT", `目录不存在或不是目录（项目根路径不可用；module_path=${modulePath === "" ? "." : modulePath}）`);
  }
  // 模块路径合法性：posix 相对路径，不许跳出项目根，不许含忽略段。
  // 反斜杠先按分隔符归一：下面的 dirAbs 走 path.join（Windows 上是 win32 语义），会把段内的
  // `..\` 解析掉——只做 posix 校验的话 `src\..\..\..\Windows` 原文不含 "/"，normalize 后原样保留，
  // 校验放行、join 再把它归一成项目根外的目录（A4 路径穿越，能读到任意目录的清单/文件数/import）。
  const raw = modulePath.replace(/\\/g, "/");
  const norm = raw === "." ? "." : path.posix.normalize(raw);
  if (
    norm !== "." &&
    (norm.startsWith("..") || path.posix.isAbsolute(norm) || /^[A-Za-z]:/.test(norm))
  ) {
    throw new WsError("INVALID_INPUT", `模块路径非法: ${modulePath}`);
  }
  if (norm !== "." && norm.split("/").some((seg) => IGNORED_SEGMENTS.has(seg))) {
    throw new WsError("INVALID_INPUT", `模块路径命中忽略段: ${modulePath}`);
  }
  const dirAbs = norm === "." ? abs : path.join(abs, ...norm.split("/"));
  if (!fs.existsSync(dirAbs) || !fs.statSync(dirAbs).isDirectory()) {
    throw new WsError("INVALID_INPUT", `模块路径不是目录: ${modulePath}`);
  }
  // V09-35（契约 U3）中间联接点防逃逸：上面的词法校验只挡 `..`／绝对路径，挡不住
  // `src/link/...` 里 `link` 是指向项目根外的 junction／目录软链——join 出来的 dirAbs 词法上仍在根内。
  // 故对**根**与**目标目录**都取 realpath 后判包含；解析后落在根外一律拒（fail-closed，不泄漏根外清单）。
  try {
    const realRoot = fs.realpathSync(abs);
    const realDir = fs.realpathSync(dirAbs);
    if (!sameOrInside(realRoot, realDir)) {
      throw new WsError(
        "INVALID_INPUT",
        `模块路径经联接点/软链解析后落在项目根外: ${modulePath}（realpath 逃逸，拒绝展开）`,
      );
    }
  } catch (e) {
    if (e instanceof WsError) throw e;
    // realpath 失败＝路径存在性/权限异常：不按"未逃逸"放行
    throw new WsError("INVALID_INPUT", `模块路径无法解析真实路径（fail-closed 拒绝）: ${modulePath}`);
  }

  // ── 直接子级扫描：子目录 → 子模块节点，直属文件 → 文件节点（忽略口径同 A1）──
  const entries = fs
    .readdirSync(dirAbs, { withFileTypes: true })
    .filter((e) => !(e.isDirectory() && IGNORED_SEGMENTS.has(e.name)))
    .sort((a, b) => a.name.localeCompare(b.name));
  // "." 根散文件模块的特殊口径：它的成员只有根直属文件（顶层目录是别的顶层模块，不算子级）
  const directDirs = norm === "." ? [] : entries.filter((e) => e.isDirectory() && !e.isSymbolicLink());
  const directFiles = entries.filter((e) => e.isFile() && !e.isSymbolicLink());
  const allSubtreeSourceFiles = (rel: string) => SOURCE_EXTS.has(path.posix.extname(rel).toLowerCase());

  // ── 子级硬上限（§4.3 第 1 招，第二层落点）：**在遍历子树之前**截断 ──
  // 超上限的子级不遍历、不解析、不渲染（§4.3 第 2 招），改成一个聚合节点。巨枝（归档日志/临时
  // 产物目录，实测 12 286 个文件）的耗时因此从"整枝"降到"保留的前 39 个子级"——这是本卡
  // 极端巨枝的降级表现；截断量与上限随响应带回（limit / truncated，调用方显示"还有 N 个"）。
  // V09-22 契约 2：传了 childrenOffset（含 0）即切**稳定分页**——不再截成「还有 N 个」聚合节点，
  // 而是把排序后全量直接子级按 [offset, offset+limit) 开窗（全是真实子级，逐页可取回上限外的对象）。
  const parentId = slugify(norm);
  const allChildren: fs.Dirent[] = [...directDirs, ...directFiles];
  const childrenLimit = opts.childrenLimit ?? ARCH_LIMITS.MAX_CHILDREN;
  const offsetMode = opts.childrenOffset !== undefined;
  const pageOffset = offsetMode ? Math.max(0, Math.floor(opts.childrenOffset as number)) : 0;
  const capped = offsetMode ? null : capChildren<fs.Dirent>(allChildren, parentId, childrenLimit);
  const windowStart = Math.min(pageOffset, allChildren.length);
  const keptEntries: fs.Dirent[] = offsetMode
    ? allChildren.slice(windowStart, windowStart + childrenLimit)
    : capped!.kept;
  const limitChildren = offsetMode ? childrenLimit : capped!.limit;
  const truncatedChildren = offsetMode
    ? Math.max(0, allChildren.length - (windowStart + keptEntries.length))
    : capped!.dropped;
  const keptDirs = keptEntries.filter((e) => e.isDirectory());
  const keptFiles = keptEntries.filter((e) => !e.isDirectory());

  // ── 子树文件清单（递归，只走文件名）：**直属文件 + 保留的子目录各自的整棵子树** ──
  // 直属文件必须算进来（旧口径 walkFiles(子树根) 本来就把它们算在里头）：漏了它们，展开 src/ui
  // 这样的目录时 api.ts / App.tsx 就不进"待解析"清单，子级间依赖边会凭空消失（N2 实测踩到：
  // verify-a4 的 import 边聚合夹具从 2 条变 0 条）。
  // 遍历带预算（§4.3 第 2 招的兜底闸门）：保留子级的整棵子树原本无上限——巨枝只截了宽度没截深度，
  // 一棵 1.2 万文件的子树照样在请求线程里同步走完 → 到点收工，缺口由 stats.budget_exhausted 标出。
  const walkBudget = (): { maxFiles: number; maxMs: number } => ({
    maxFiles: WALK_LIMITS.maxFiles,
    maxMs: Math.max(0, deadline - Date.now()),
  });
  let budgetExhausted = false;
  const subtreeFiles: string[] = keptFiles.map((f) => toRel(abs, path.join(dirAbs, f.name)));
  for (const d of keptDirs) {
    const rel = toRel(abs, path.join(dirAbs, d.name));
    const walked = boundedWalk(path.join(dirAbs, d.name), walkBudget());
    if (walked.truncated) budgetExhausted = true;
    for (const f of walked.files) subtreeFiles.push(`${rel}/${f}`);
  }

  // ── 待解析源码清单（懒加载核心：只有子树内、且被保留的源码文件会被解析）──
  const subtreeSourceFiles = (norm === "." ? directFiles.map((f) => f.name) : subtreeFiles).filter(
    allSubtreeSourceFiles,
  );
  // 全项目文件名清单（只走文件名、不解析）的唯一用途：在 parseFileImports 里确认 import 目标是不是
  // 项目内源码文件。**一个待解析文件都没有时它零用途**（截断后的巨枝常见这种情形），此时白走一遍
  // 全项目目录是纯开销 → 跳过（语义不变：没有任何 import 需要判定）。这是截断之外的第二个降级点。
  const needProjectFiles = subtreeSourceFiles.length > 0;
  const projectWalked = needProjectFiles ? boundedWalk(abs, walkBudget()) : { files: [], truncated: false };
  const projectFiles = projectWalked.files;
  if (projectWalked.truncated) budgetExhausted = true;
  const projectSourceSet = new Set(
    projectFiles.filter((f) => SOURCE_EXTS.has(path.posix.extname(f).toLowerCase())),
  );
  const pyImportRoots: string[] = [""];
  if (projectFiles.some((f) => f.startsWith("src/") && f.endsWith(".py"))) pyImportRoots.push("src");

  // ── tree-sitter 只解析子树内源码文件（懒加载核心：子树外一个字节不读）──
  const inSubtree = (rel: string) =>
    norm === "." ? !rel.includes("/") : rel === norm || rel.startsWith(norm + "/");
  let parseMs = 0;
  let skippedLarge = 0;
  let skippedUnreadable = 0;
  let parseFailed = 0;
  let importCount = 0;
  const parsedFiles: string[] = [];
  const perFile = new Map<string, { targets: string[]; loc: number }>();
  for (const rel of subtreeSourceFiles) {
    if (Date.now() > deadline) {
      budgetExhausted = true; // 预算到点：不再解析后续文件（已解析的照常出图）
      break;
    }
    const lang = SOURCE_EXTS.get(path.posix.extname(rel).toLowerCase())!;
    const p0 = performance.now();
    const result = parseFileImports(abs, rel, lang, projectSourceSet, pyImportRoots);
    parseMs += performance.now() - p0;
    if (result.skip) {
      // 三种跳过分开记账（与 A1 同一口径）：大文件是策略，读失败/解析失败是故障
      if (result.skip === "too_large") skippedLarge++;
      else if (result.skip === "unreadable") skippedUnreadable++;
      else parseFailed++;
      continue;
    }
    perFile.set(rel, result);
    parsedFiles.push(rel);
    importCount += result.targets.length;
  }

  // ── 组装子级节点 ──
  const children: ExpandChild[] = [];
  const childOfFile = new Map<string, string>(); // 子树内文件 → 直属子级 id
  for (const d of keptDirs) {
    const rel = toRel(abs, path.join(dirAbs, d.name));
    const id = slugify(rel);
    const members = subtreeFiles.filter((f) => f.startsWith(rel + "/"));
    for (const f of members) childOfFile.set(f, id);
    children.push({
      id,
      name: d.name,
      path: rel,
      kind: "dir",
      file_count: members.length,
      loc: 0,
      leaf: false,
      deps: [],
    });
  }
  for (const f of keptFiles) {
    const rel = toRel(abs, path.join(dirAbs, f.name));
    const id = slugify(rel);
    childOfFile.set(rel, id);
    children.push({
      id,
      name: f.name,
      path: rel,
      kind: "file",
      file_count: 1,
      loc: perFile.get(rel)?.loc ?? 0,
      leaf: true,
      deps: [],
    });
  }
  if (capped?.aggregate) {
    // 「还有 N 个」聚合节点（§4.3 第 1 招）：不可下钻、无文件数（被截断的枝不遍历）
    children.push({
      id: capped.aggregate.id,
      name: capped.aggregate.name,
      path: capped.aggregate.path,
      kind: "aggregate",
      file_count: 0,
      loc: 0,
      leaf: true,
      deps: [],
    });
  }
  const byId = new Map(children.map((c) => [c.id, c]));

  // ── A5 文件级变动点：近窗口 changes.jsonl 有记录的文件节点标 changed_recently ──
  const changedPaths = recentChangedPaths(abs);
  for (const c of children) {
    if (c.kind === "file" && changedPaths.has(c.path)) c.changed_recently = true;
  }

  // ── 依赖边：子级间聚合 + 对外边（目标在子树外）──
  const edgeWeight = new Map<string, number>();
  const extWeight = new Map<string, number>();
  for (const [rel, imp] of perFile) {
    const fromId = childOfFile.get(rel);
    if (!fromId) continue;
    byId.get(fromId)!.loc += fromId === slugify(rel) ? 0 : imp.loc; // dir 子级累加 loc（file 已记自身）
    for (const target of imp.targets) {
      if (inSubtree(target)) {
        const toId = childOfFile.get(target);
        if (!toId || toId === fromId) continue; // 子级内部边不画
        const key = `${fromId}>${toId}`;
        edgeWeight.set(key, (edgeWeight.get(key) ?? 0) + 1);
      } else {
        const key = `${fromId}>${target}`;
        extWeight.set(key, (extWeight.get(key) ?? 0) + 1);
      }
    }
  }
  for (const [key, weight] of [...edgeWeight.entries()].sort()) {
    const [from, to] = key.split(">");
    byId.get(from)!.deps.push({ to, weight });
  }
  const external: ExpandExternalDep[] = [...extWeight.entries()]
    .map(([key, weight]) => {
      const [from, to_path] = key.split(">");
      return { from, to_path, weight };
    })
    .sort((a, b) => a.from.localeCompare(b.from) || a.to_path.localeCompare(b.to_path));

  return {
    parent: { id: parentId, path: norm },
    children,
    external,
    duration_ms: Date.now() - t0,
    parse_ms: Math.round(parseMs * 100) / 100,
    llm_calls: 0,
    limit: { children: limitChildren },
    truncated: { children: truncatedChildren },
    // V09-22 契约 2：稳定分页模式额外带四字段（缺省调用一个都不带，逐字节不变）
    ...(offsetMode
      ? {
          children_total: allChildren.length,
          children_offset: pageOffset,
          children_returned: keptEntries.length,
          children_has_more: windowStart + keptEntries.length < allChildren.length,
        }
      : {}),
    // V09-35：仅当显式要求 childrenSource 时带分页来源版本（HTTP/旧调用不带 → 输出逐字节不变）
    ...(offsetMode && opts.childrenSource === true
      ? {
          children_fingerprint: directChildrenFingerprint(
            allChildren.map((e) => ({ name: e.name, kind: e.isDirectory() ? ("dir" as const) : ("file" as const) })),
          ),
        }
      : {}),
    stats: {
      subtree_files: norm === "." ? directFiles.length : subtreeFiles.length,
      parsed_files: parsedFiles,
      skipped_large: skippedLarge,
      skipped_unreadable: skippedUnreadable,
      parse_failed: parseFailed,
      imports: importCount,
      skipped_project_walk: !needProjectFiles,
      budget_exhausted: budgetExhausted,
    },
  };
}

/** 按注册表项目 id 就地展开（HTTP 路由入口；路径只走注册表，不落盘） */
export function expandProject(
  projectId: string,
  modulePath: string,
  dataDir?: string,
  opts?: { childrenLimit?: number; childrenOffset?: number; childrenSource?: boolean },
): ExpandResult {
  const project = getProject(projectId, dataDir);
  if (!project) {
    throw new WsError("PROJECT_NOT_FOUND", `项目不存在: ${projectId}`);
  }
  if (typeof modulePath !== "string" || modulePath === "") {
    throw new WsError("INVALID_INPUT", "module_path 必填（相对项目根的 posix 路径）");
  }
  return expandDirectory(project.path, modulePath, opts);
}
