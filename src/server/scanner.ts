import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { getProject } from "./registry";
import { JUNK_DIR_RANDOM_TEMP_RE } from "../arch/config";
import { sanitizeErrorMessage } from "./redact";
import { WsError } from "./workstation";

const execFileAsync = promisify(execFile);

// 项目扫描器（B1，逆向落稿第一卡，DESIGN.md §9.1/§9.3）：
// 扫老项目产出结构化摘要，供 B3 Flash 起草设计书雏形直接消费（TS 类型导出）。
// 口径（§9.3）：不问用户"这项目是干嘛的"——先自己扫；忽略 node_modules/.git/dist 等噪音；
// 大目录不卡死（单目录超 MAX_FILES_PER_DIR 截断并标记）。
// 红线：全程只读被扫项目目录，一个字都不写进去；git 命令只跑只读子命令（log / rev-list --count）。
//
// Q131（2026-09-19 审计）：git 调用此前是同步 `execFileSync`（每次超时 10s，两次串行），
// 跑在 HTTP 请求线程里 = 事件循环整体停摆（SSE ping、UI 轮询全停），最坏 20s。现在**请求路径走
// 异步版**（`scanProjectAsync` / `scanDirectoryAsync`：git 用 `execFile` + promise，不占事件循环，
// 超时口径照旧 GIT_TIMEOUT_MS），另一条（`scanProject` / `scanDirectory`）供单元级用例直接调用，
// 两条路共用同一份输出解析，口径只写一遍。
//
// 批3 T17（2026-09-20 审计，判词 TPL-10 §4.1）：**遍历异步分批让出**——树遍历在每个目录安全检查点
// `setImmediate` 让出一次事件循环（见 `atCheckpoint`），排队的取消回调/HTTP 请求能在遍历**中**被服务，
// 不再要等遍历全走完。此改动的连带：上面四条入口现在**都是 async、返回 Promise**（`scanDirectory` 的 git
// 仍是同步 `scanGit`，单元级用例口径不变，变的只是"遍历不再一口气跑完、每目录让一次"）。

/**
 * 遍历预算（Q42，2026-09-18 审计）：本扫描器现扫现返跑在请求处理里（`GET /api/projects/:id/scan`
 * 结果不缓存），此前只有"单目录文件数"一条闸门，目录数与总条目数都不设限——扫一个巨兽项目
 * 会把整个事件循环堵住。这里补上与 watcher 有界预扫描（`watcher.ts` 的 SCAN_MAX_*）等价的三条闸门：
 * 总条目 / 单目录文件数 / 墙钟；任一超限立即停手，并把原因如实带回响应（不静默缩小扫描范围）。
 * 批3 T17：遍历改成每目录让出一次事件循环后，墙钟闸门计的是**累计**墙钟（含让出间隙），口径不变。
 */
export interface ScanLimits {
  /** 总条目上限（文件 + 目录；忽略段不计） */
  MAX_ENTRIES: number;
  /** 单目录文件数上限：超此数在该目录截断并标记 */
  MAX_FILES_PER_DIR: number;
  /** 墙钟上限（ms）：超时即停手，不长时间占着事件循环 */
  MAX_MS: number;
}

/**
 * 条目可用环境变量 `TATAI_SCAN_<项名>` 覆盖（如 `TATAI_SCAN_MAX_ENTRIES=2000`）。
 * 与 `TATAI_WATCH_*` 同一目的：让验证能把闸门**收紧**以真实触发截断路径，或给极端环境运维调参；
 * 不设时行为与默认口径一致（无效值一律回落到默认值）。
 */
function limitOf(name: keyof ScanLimits, fallback: number): number {
  const raw = process.env[`TATAI_SCAN_${name}`]?.trim();
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const SCAN_LIMITS: ScanLimits = {
  MAX_ENTRIES: limitOf("MAX_ENTRIES", 20_000),
  MAX_FILES_PER_DIR: limitOf("MAX_FILES_PER_DIR", 5_000),
  MAX_MS: limitOf("MAX_MS", 1_500),
};

const MAX_DOCS_ENTRIES = 50; // docs 清单上限
const README_EXCERPT_CHARS = 2000; // README 摘要限长
const GIT_LOG_COUNT = 20; // git log 取最近 N 条
const GIT_TIMEOUT_MS = 10_000; // git 子进程超时，防仓库异常卡死扫描

/** 忽略目录段名（与 watcher 同一口径，§12.2 风险 3 + 扫描噪音；H4 补的四段 `.tmp`/`tmp`/`temp`/`cache`
 *  不许漏：现场项目的病根目录就是 `.tmp`，漏了会把临时产物算进 total_files 与模块划分） */
const IGNORED_SEGMENTS: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  "dist",
  ".工作台",
  "build",
  "out",
  "target",
  "coverage",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  "__pycache__",
  ".venv",
  "venv",
  // H4 补：高翻转/临时/缓存类目录段（与 watcher.ts 逐字同一份）
  ".tmp",
  "tmp",
  "temp",
  "cache",
]);

/** 文件树规模摘要 */
export interface TreeSummary {
  /** 忽略噪音后的总文件数 */
  total_files: number;
  /** 按扩展名 top10（小写扩展名，无扩展名记 "(none)"） */
  by_extension: { ext: string; count: number }[];
  /** 最深目录深度（根为 0） */
  max_depth: number;
  /** 顶层目录清单（每个顶层目录的文件数；顶层散文件记 "(root)"） */
  top_dirs: { name: string; files: number }[];
  /** 是否有目录因超 MAX_FILES_PER_DIR 被截断，或因预算提前停手 */
  truncated: boolean;
  /** 被截断的目录（相对路径） */
  truncated_dirs: string[];
  /** 是否因总条目/耗时预算提前停手（Q42） */
  budget_exhausted: boolean;
  /** 提前停手的原因（如 "总条目 20000 超上限"）；未触发为 null */
  budget_reason: string | null;
}

export interface ReadmeSummary {
  /** 相对项目根路径（正斜杠） */
  path: string;
  /** 首个 markdown 标题（无标题取首个非空行） */
  title: string;
  /** 前 N 段摘要，限 README_EXCERPT_CHARS 字符 */
  excerpt: string;
  /** excerpt 是否被限长截断 */
  truncated: boolean;
}

export interface DocEntry {
  /** 相对项目根路径（正斜杠） */
  path: string;
  /** 首个 markdown 标题行（去掉 # 前缀；无标题为 null） */
  title: string | null;
}

export interface GitSummary {
  /** 项目根是否有 .git */
  has_git: boolean;
  /** 最近提交时间（ISO，git log 第一条的 %ad）；无提交/无 git 为 null */
  last_commit_at: string | null;
  /** 近 30 天提交数（按取回的最近 GIT_LOG_COUNT 条内统计） */
  commits_last_30d: number;
  /** 总提交数（git rev-list --count HEAD；统计失败为 null） */
  total_commits: number | null;
  /** 最近提交摘要（"%h %ad %s" 原文行，最多 GIT_LOG_COUNT 条） */
  recent_commits: string[];
  /** git 不可用/仓库异常时的说明；正常为 null */
  note: string | null;
}

export interface ManifestSummary {
  /** package.json：存在性 + name/description/scripts 名/deps 名列表 */
  package_json: {
    exists: boolean;
    name: string | null;
    description: string | null;
    scripts: string[];
    dependencies: string[];
  } | null;
  /** pyproject.toml：存在性 + name/description（粗略正则解析，不引 toml 依赖） */
  pyproject_toml: { exists: boolean; name: string | null; description: string | null } | null;
  /** 其他关键清单/配置文件的存在性 */
  others: { name: string; exists: boolean }[];
}

/** 扫描结果（B3 起草雏形的输入） */
export interface ProjectScan {
  project_id: string | null;
  root: string;
  scanned_at: string;
  duration_ms: number;
  tree: TreeSummary;
  readme: ReadmeSummary | null;
  docs: DocEntry[];
  git: GitSummary;
  manifests: ManifestSummary;
  /** 批2 T12（判词 R1-ZS-004）：本次扫描在安全检查点被取消。为 true 时下面是**未完成的部分结果**，
   *  HTTP 侧只回取消回执、不把这半截结果出网（本扫描器不落盘，故不留半截产物） */
  cancelled?: boolean;
  /** 取消时停在哪个安全检查点（仅 cancelled=true 时有值） */
  progress?: ScanProgress;
}

// ── 批2 T12（2026-09-20 审计轮，判词 R1-ZS-004）：全量扫描的进程内取消链路 ──────────────────
// DESIGN §11.8「全量扫描放后台且可取消」。B1 扫描器（`GET /api/projects/:id/scan` 现扫现返、结果不
// 缓存）此前**没有任何取消信号**：另一个请求想中途叫停只能等它自己跑完（只有 SCAN_LIMITS.MAX_MS 兜底），
// 判词据此认定 V06-14 ④-5「后台全量扫描可取消」名不副实（那条断言实际打的是 `DELETE /watch`＝停文件监听，
// 与扫描取消是两回事）。这里补一条**进程内**取消登记（扫描由服务端单进程发起，不需要跨进程信号）：
//   · 扫描期间按 projectId 登记一条"现场"（进度 + 取消标记），扫描结束即注销（不留脏标记/死锁）；
//   · 遍历在**安全检查点**（每处理完一个目录）查取消标记，命中即停止遍历、丢弃未完成的部分结果；
//   · 取消不写半截结果（本扫描器本就不落盘），沿用上一次完整落盘状态（如 arch 的 modules.json，可能已过期）；
//   · 取消后同一项目可再次正常扫描。
// 单进程注记（批3 T17 改）：遍历本体现在是**协作式让出的异步分批**——每个目录安全检查点 `setImmediate`
// 让出一次事件循环，HTTP `DELETE …/scan` 或排队中的 `setImmediate` 取消回调能在**遍历中**被处理，不再只
// 挂在 git 子进程 await 上；确定性验证仍可走 `ScanHooks` 的检查点注入（见下），不靠 sleep 竞态。

/** 扫描进度（安全检查点粒度：按已处理完的目录数计） */
export interface ScanProgress {
  /** 已完成的安全检查点数（处理完的目录数，根目录算 1 个） */
  dirs_done: number;
  /** 遍历到的条目数（文件 + 目录；忽略段不计，与 `scanTree` 的 entriesSeen 同口径） */
  entries_seen: number;
  /** 最近处理完的安全检查点（相对项目根；根目录记 "."） */
  last_dir: string;
}

/** 取消回执（`DELETE /api/projects/:id/scan` 的应答体；扫描侧取消也带同形字段） */
export interface ScanCancelReceipt {
  /** 是否真取消了一次**进行中**的扫描 */
  cancelled: boolean;
  project_id: string;
  /** 进行中扫描的位置/已完成量；没有进行中的扫描时为 null */
  progress: ScanProgress | null;
  /** 是否丢弃了未完成的部分结果（cancelled=true 时恒 true） */
  partial: boolean;
  /** 人读说明（没有进行中的扫描时说清原因，不报错） */
  note: string;
}

/** 安全检查点注入（验证与调用方可选；产品 HTTP 路径不传）——让"取消"能在确定的位置发生，不靠 sleep 竞态 */
export interface ScanHooks {
  /** 检查点观测：每处理完一个安全检查点（目录）调一次（仅观测，不改语义） */
  onCheckpoint?: (progress: ScanProgress) => void;
  /** 检查点判定：返回 true 表示请求停止（与进程内取消标记取或） */
  shouldCancel?: (progress: ScanProgress) => boolean;
}

/** 一次扫描的运行现场（进程内；按项目 id 归组，是同项目活动 run 数组里的一项） */
interface ScanRun {
  cancel_requested: boolean;
  progress: ScanProgress;
}

/**
 * 进行中扫描的登记表（进程内；扫描结束即注销，防脏标记/死锁）。
 * 批3 T18（R1-ZS-R2-001，判词 TPL-10 §4.2）：此前是 `Map<string, ScanRun>`——同项目重叠时**后进覆盖先进**，
 * 先结束的那个再无条件 delete 整个键，于是"旧扫描结束会注销新扫描"（终审探针第 4 案：第二个扫描还没结束，
 * 取消却回"没有进行中的扫描"）。改成按 projectId 存**栈**：begin 压栈返回 run 身份、end 按**对象身份**只移除
 * 自己、数组空才删键；取消定向打到栈顶（最新）那个 run。允许同项目重叠，不做单飞拒绝。
 */
const activeScanRuns = new Map<string, ScanRun[]>();

/** 登记扫描现场（projectId 为 null＝目录级扫描，不介入取消登记）；返回该 run 身份供注销/定向取消 */
function beginScanRun(projectId: string | null): ScanRun | null {
  if (projectId === null) return null;
  const run: ScanRun = {
    cancel_requested: false,
    progress: { dirs_done: 0, entries_seen: 0, last_dir: "." },
  };
  const runs = activeScanRuns.get(projectId);
  if (runs) runs.push(run); // 批3 T18：同项目允许重叠，压栈保留全部活动 run
  else activeScanRuns.set(projectId, [run]);
  return run;
}

/** 注销扫描现场（批3 T18：按**对象身份**只移除自己——旧 run 结束不得注销新 run；数组空才删键；幂等） */
function endScanRun(projectId: string | null, run: ScanRun | null): void {
  if (projectId === null || run === null) return;
  const runs = activeScanRuns.get(projectId);
  if (!runs) return;
  const i = runs.indexOf(run);
  if (i >= 0) runs.splice(i, 1);
  if (runs.length === 0) activeScanRuns.delete(projectId);
}

/**
 * 请求取消某项目**进行中**的扫描（HTTP `DELETE /api/projects/:id/scan` 的入口）。
 * 没有进行中的扫描时如实回 `cancelled:false` 加原因，不报错；项目不存在仍按既有口径抛 PROJECT_NOT_FOUND。
 * 批3 T18：同项目重叠时定向取消**最新**（数组末尾）那个活动 run，回执形状与文案一个字不改。
 */
export function requestScanCancel(projectId: string, dataDir?: string): ScanCancelReceipt {
  const project = getProject(projectId, dataDir);
  if (!project) {
    throw new WsError("PROJECT_NOT_FOUND", `项目不存在: ${projectId}`);
  }
  const runs = activeScanRuns.get(project.id);
  const run = runs?.[runs.length - 1]; // 批3 T18：栈顶＝最新登记的 run；数组空即"没有进行中的扫描"
  if (!run) {
    return {
      cancelled: false,
      project_id: project.id,
      progress: null,
      partial: false,
      note: "该项目当前没有进行中的扫描（无需取消）",
    };
  }
  run.cancel_requested = true;
  return {
    cancelled: true,
    project_id: project.id,
    progress: { ...run.progress },
    partial: true,
    note: "已请求取消：遍历在下一个安全检查点停止，部分结果未写入，沿用上次完整落盘状态（可能已过期）",
  };
}

/** 遍历运行态（同步/异步两条路共用；把取消标记与检查点钩子串起来） */
interface ScanRuntime {
  run: ScanRun | null;
  hooks?: ScanHooks;
  /** 是否因取消而停在安全检查点 */
  cancelled: boolean;
}

/**
 * 安全检查点：刷新进度 → 观测 → **协作式让出事件循环** → 判定是否停止（进程内取消标记与注入判定取或）。
 * 批3 T17（2026-09-20 审计，判词 TPL-10 §4.1）：此前只查布尔不让出——排队的 `setImmediate` 取消回调
 * （HTTP `DELETE …/scan` 走同一登记表也同理）要等遍历**全部走完**才可能执行，探针实测 81 个检查点全跑完
 * 后才回"当前没有进行中的扫描"。现在每个目录安全检查点真让出一次，让取消回调/HTTP 请求能在遍历**中**落地，
 * 下一个检查点即命中停手。
 */
async function atCheckpoint(rt: ScanRuntime, dirRel: string, entriesSeen: number, dirsDone: number): Promise<boolean> {
  const progress: ScanProgress = { dirs_done: dirsDone, entries_seen: entriesSeen, last_dir: dirRel };
  if (rt.run) rt.run.progress = progress;
  rt.hooks?.onCheckpoint?.(progress);
  // 批3 T17：真让出一次事件循环——观测钩子刚排队的取消回调（setImmediate 等）在这里跑起来，再做判定
  await new Promise<void>((resolve) => setImmediate(resolve));
  if (rt.run?.cancel_requested === true || rt.hooks?.shouldCancel?.(progress) === true) {
    rt.cancelled = true;
    return true;
  }
  return false;
}

const toRel = (root: string, abs: string) =>
  path.relative(root, abs).split(path.sep).join("/");

/** 迭代式遍历（不递归、不跟随符号链接），产出树规模摘要。Q42：三条预算闸门任一超限即停手并如实回报。
 *  批2 T12：在每个目录边界（安全检查点）查取消标记，命中即停手（`rt.cancelled=true`，半截计数不再增长）。
 *  批3 T17：改成 async——每目录安全检查点 `await` 让出一次事件循环（见 `atCheckpoint`），取消回调可在遍历中执行。 */
async function scanTree(root: string, rt: ScanRuntime): Promise<TreeSummary> {
  const t0 = Date.now();
  const extCount = new Map<string, number>();
  const topDirCount = new Map<string, number>();
  const truncatedDirs: string[] = [];
  let total = 0;
  let maxDepth = 0;
  let entriesSeen = 0; // 文件 + 目录（忽略段不计）
  let dirsDone = 0; // 批2 T12：已处理完的安全检查点（目录）数
  let budgetReason: string | null = null;
  // 栈元素：[绝对路径, 深度]
  const stack: [string, number][] = [[root, 0]];
  while (stack.length > 0) {
    // Q42：总条目闸门先于 readdir——巨目录下 readdirSync 本身就是一次长阻塞，不能等它返回再判
    if (entriesSeen >= SCAN_LIMITS.MAX_ENTRIES) {
      budgetReason = `总条目 ${entriesSeen} 超上限 ${SCAN_LIMITS.MAX_ENTRIES}（文件树只统计到截断点）`;
      break;
    }
    if (Date.now() - t0 >= SCAN_LIMITS.MAX_MS) {
      budgetReason = `耗时 ${Date.now() - t0}ms 超上限 ${SCAN_LIMITS.MAX_MS}ms（文件树只统计到截断点）`;
      break;
    }
    const [dir, depth] = stack.pop()!;
    // 批2 T12：安全检查点——目录边界先查取消（在 readdir 这类长阻塞之前），命中即停手
    // 批3 T17：检查点是 async（内部让出一次事件循环），必须 await
    if (await atCheckpoint(rt, toRel(root, dir) || ".", entriesSeen, dirsDone)) break;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // 无权限/损坏目录跳过，不炸整个扫描
    }
    let dirFiles = 0;
    let dirTruncated = false;
    for (const e of entries) {
      if (e.isDirectory()) {
        if (IGNORED_SEGMENTS.has(e.name) || JUNK_DIR_RANDOM_TEMP_RE.test(e.name)) continue;
        entriesSeen++;
        stack.push([path.join(dir, e.name), depth + 1]);
        continue;
      }
      if (e.isSymbolicLink()) continue; // 不跟随符号链接，防环路
      if (!e.isFile()) continue; // 特殊文件不计
      if (dirFiles >= SCAN_LIMITS.MAX_FILES_PER_DIR) {
        dirTruncated = true;
        continue;
      }
      dirFiles++;
      entriesSeen++;
      total++;
      if (depth > maxDepth) maxDepth = depth;
      const ext = path.extname(e.name).toLowerCase() || "(none)";
      extCount.set(ext, (extCount.get(ext) ?? 0) + 1);
      const top = depth === 0 ? "(root)" : toRel(root, dir).split("/")[0];
      topDirCount.set(top, (topDirCount.get(top) ?? 0) + 1);
    }
    if (dirTruncated) truncatedDirs.push(toRel(root, dir) || ".");
    dirsDone++;
  }
  const by_extension = [...extCount.entries()]
    .map(([ext, count]) => ({ ext, count }))
    .sort((a, b) => b.count - a.count || a.ext.localeCompare(b.ext))
    .slice(0, 10);
  const top_dirs = [...topDirCount.entries()]
    .map(([name, files]) => ({ name, files }))
    .sort((a, b) => b.files - a.files || a.name.localeCompare(b.name));
  return {
    total_files: total,
    by_extension,
    max_depth: maxDepth,
    top_dirs,
    truncated: truncatedDirs.length > 0 || budgetReason !== null,
    truncated_dirs: truncatedDirs,
    budget_exhausted: budgetReason !== null,
    budget_reason: budgetReason,
  };
}

/** 提取 markdown/文本标题：首个 `# ` 标题，无则首个非空行（限长） */
function extractTitle(text: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t === "") continue;
    const m = t.match(/^#+\s+(.*)$/);
    return (m ? m[1] : t).trim().slice(0, 200);
  }
  return null;
}

/** 找 README（项目根一级，readme*.md/txt 等，大小写不敏感），取标题与前 N 段摘要 */
function scanReadme(root: string): ReadmeSummary | null {
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return null;
  }
  const found = names
    .filter((n) => /^readme(\.[a-z0-9]+)?$/i.test(n) && !/\.(png|jpg|gif|pdf)$/i.test(n))
    .sort((a, b) => a.localeCompare(b))[0];
  if (!found) return null;
  const abs = path.join(root, found);
  try {
    if (!fs.statSync(abs).isFile()) return null;
    // 多读一点再切，保证"前 N 段"在限长内尽量完整
    const text = fs.readFileSync(abs, "utf8");
    const truncated = text.length > README_EXCERPT_CHARS;
    const excerpt = truncated ? text.slice(0, README_EXCERPT_CHARS) : text;
    return {
      path: found,
      title: extractTitle(text) ?? "(无标题)",
      excerpt,
      truncated,
    };
  } catch {
    return null;
  }
}

/** docs 清单：docs/ 目录（递归，忽略噪音）+ 根级 *.md；每条带标题行 */
function scanDocs(root: string): DocEntry[] {
  const out: DocEntry[] = [];
  const pushDoc = (abs: string) => {
    if (out.length >= MAX_DOCS_ENTRIES) return;
    let title: string | null = null;
    try {
      // 标题只读开头一段，避免为标题读整个大文件
      const fd = fs.openSync(abs, "r");
      try {
        const buf = Buffer.alloc(8192);
        const n = fs.readSync(fd, buf, 0, 8192, 0);
        title = extractTitle(buf.subarray(0, n).toString("utf8"));
      } finally {
        // Q27（2026-09-18 审计）：closeSync 必须挂 finally——此前它与 readSync 同在 try 内，
        // readSync 抛错（Windows 独占/EBUSY 等）就直接跳到下面那个 catch，fd（number 型 raw fd，
        // 没有 GC 兜底）永久泄漏。写法与 global-changes.ts 的"开—读—finally 关"一致。
        fs.closeSync(fd);
      }
    } catch {
      // 读不了也给路径，标题留 null
    }
    out.push({ path: toRel(root, abs), title });
  };
  // 根级 *.md（含 README 也列——docs 清单是全量文档清单）
  // Q132（2026-09-19 审计）：此前一个大 try 罩住整个 for——任一名字 `statSync` 抛错（坏软链、
  // 枚举后被删）即整体跳出，**排序其后的全部根级 .md 被静默吞掉**（探针：broken.md 之后的 z.md 消失），
  // 静默少条目直接污染起草证据。现在与 pushDoc 同口径：逐文件 try，坏的那个跳过、其余照列。
  let rootNames: string[] = [];
  try {
    rootNames = fs.readdirSync(root).sort();
  } catch {
    // 根目录读不了 → 后面 docs/ 也大概率读不了，各自 try 住
  }
  for (const n of rootNames) {
    if (out.length >= MAX_DOCS_ENTRIES) break;
    if (!/\.md$/i.test(n)) continue;
    const abs = path.join(root, n);
    try {
      if (fs.statSync(abs).isFile()) pushDoc(abs);
    } catch {
      // 单个名字 stat 不到：跳过它，其后的根级 .md 照常列出（Q132）
    }
  }
  // docs/ 目录递归
  const docsDir = path.join(root, "docs");
  if (fs.existsSync(docsDir) && fs.statSync(docsDir).isDirectory()) {
    const stack: string[] = [docsDir];
    while (stack.length > 0 && out.length < MAX_DOCS_ENTRIES) {
      const dir = stack.pop()!;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (out.length >= MAX_DOCS_ENTRIES) break;
        if (e.isDirectory()) {
          if (!IGNORED_SEGMENTS.has(e.name) && !JUNK_DIR_RANDOM_TEMP_RE.test(e.name)) stack.push(path.join(dir, e.name));
        } else if (e.isFile() && /\.(md|txt)$/i.test(e.name)) {
          pushDoc(path.join(dir, e.name));
        }
      }
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * git 失败文案（Q123，2026-09-19 审计）：execFileSync 的报错原文里有**项目根绝对路径**
 * （`Command failed: git -C D:\tatai log …`），而这条 note 跟着 `GET /api/projects/:id/scan` 的
 * **200 响应体**出网——`withoutLocalPaths` 只按"整个值本身是不是绝对路径"裁（首字符锚定 + ≤260 字符），
 * 「git log 失败: 」开头的形态漏裁，远程只读客户端直接拿到本机目录结构。这里在源头把项目根换成
 * `<项目根>`（POSIX 主机同样覆盖——`sanitizeErrorMessage` 只管盘符/UNC），再兜一遍消息级脱敏
 * （git 自身安装路径一类）。
 */
function gitFailNote(root: string, e: unknown): string {
  const first = ((e as Error).message ?? String(e)).split("\n")[0];
  return `git log 失败: ${sanitizeErrorMessage(first.split(root).join("<项目根>"))}`;
}

/** git 活跃度：只读子命令（log / rev-list --count），超时 GIT_TIMEOUT_MS，无 .git 明确标记 */
function emptyGitSummary(): GitSummary {
  return {
    has_git: false,
    last_commit_at: null,
    commits_last_30d: 0,
    total_commits: null,
    recent_commits: [],
    note: null,
  };
}

const GIT_LOG_ARGS = ["log", `-${GIT_LOG_COUNT}`, "--date=iso", "--pretty=format:%h %ad %s"];

/** git log 输出 → 活跃度摘要（同步/异步两条路共用，解析口径只写一遍） */
function summarizeGitLog(logText: string, total: number | null): GitSummary {
  const lines = logText === "" ? [] : logText.split(/\r?\n/);
  const last = lines[0]?.match(/^\S+ (\S+ \S+ \S+) /);
  const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
  let recent30 = 0;
  for (const line of lines) {
    const m = line.match(/^\S+ (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{4}) /);
    if (m && new Date(m[1].replace(/ ([+-])(\d{2})(\d{2})$/, " $1$2:$3")).getTime() >= cutoff) {
      recent30++;
    }
  }
  return {
    has_git: true,
    last_commit_at: last ? last[1] : null,
    commits_last_30d: recent30,
    total_commits: total,
    recent_commits: lines,
    note: null,
  };
}

/** 同步 git log（`scanGit` 用；调用方在请求线程里时要走 `scanGitAsync`） */
function scanGit(root: string): GitSummary {
  const empty = emptyGitSummary();
  if (!fs.existsSync(path.join(root, ".git"))) return empty;
  const run = (args: string[]): string =>
    execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    }).trim();
  let logText: string;
  try {
    logText = run([...GIT_LOG_ARGS]);
  } catch (e) {
    return { ...empty, has_git: true, note: gitFailNote(root, e) };
  }
  let total: number | null = null;
  try {
    total = Number(run(["rev-list", "--count", "HEAD"]));
    if (!Number.isFinite(total)) total = null;
  } catch {
    // 空仓库/异常时总数留 null，log 行数本身就是活跃度信号
  }
  return summarizeGitLog(logText, total);
}

/**
 * 异步 git log（Q131：请求路径用，**不占事件循环**）。
 * 超时口径与同步版相同（GIT_TIMEOUT_MS，execFile 到点杀子进程）；失败文案与同步版同一份（`gitFailNote`）。
 */
async function scanGitAsync(root: string): Promise<GitSummary> {
  const empty = emptyGitSummary();
  if (!fs.existsSync(path.join(root, ".git"))) return empty;
  const run = async (args: string[]): Promise<string> => {
    const { stdout } = await execFileAsync("git", ["-C", root, ...args], {
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
    });
    return stdout.trim();
  };
  let logText: string;
  try {
    logText = await run([...GIT_LOG_ARGS]);
  } catch (e) {
    return { ...empty, has_git: true, note: gitFailNote(root, e) };
  }
  let total: number | null = null;
  try {
    total = Number(await run(["rev-list", "--count", "HEAD"]));
    if (!Number.isFinite(total)) total = null;
  } catch {
    // 同上：总数留 null
  }
  return summarizeGitLog(logText, total);
}

/** 关键清单文件摘要 */
function scanManifests(root: string): ManifestSummary {
  const pkgFile = path.join(root, "package.json");
  let packageJson: ManifestSummary["package_json"] = null;
  if (fs.existsSync(pkgFile)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
      packageJson = {
        exists: true,
        name: typeof pkg.name === "string" ? pkg.name : null,
        description: typeof pkg.description === "string" ? pkg.description : null,
        scripts: Object.keys(pkg.scripts ?? {}),
        dependencies: [
          ...Object.keys(pkg.dependencies ?? {}),
          ...Object.keys(pkg.devDependencies ?? {}),
        ],
      };
    } catch {
      packageJson = { exists: true, name: null, description: null, scripts: [], dependencies: [] };
    }
  }
  const pyFile = path.join(root, "pyproject.toml");
  let pyproject: ManifestSummary["pyproject_toml"] = null;
  if (fs.existsSync(pyFile)) {
    let name: string | null = null;
    let description: string | null = null;
    try {
      const text = fs.readFileSync(pyFile, "utf8");
      name = text.match(/^name\s*=\s*"([^"]+)"/m)?.[1] ?? null;
      description = text.match(/^description\s*=\s*"([^"]+)"/m)?.[1] ?? null;
    } catch {
      // 存在但读不了，exists 仍为 true
    }
    pyproject = { exists: true, name, description };
  }
  const otherNames = [
    "astro.config.mjs",
    "astro.config.ts",
    "astro.config.js",
    "requirements.txt",
    "setup.py",
    "Cargo.toml",
    "go.mod",
    "vite.config.ts",
    "tsconfig.json",
  ];
  return {
    package_json: packageJson,
    pyproject_toml: pyproject,
    others: otherNames.map((n) => ({ name: n, exists: fs.existsSync(path.join(root, n)) })),
  };
}

/** 项目根存在性校验（同步/异步两条路共用；不存在/不是目录抛 INVALID_INPUT） */
function assertScanRoot(abs: string): void {
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    throw new WsError("INVALID_INPUT", `目录不存在或不是目录: ${abs}`);
  }
}

/**
 * 扫目录本体（核心，与项目 id 解耦，便于对任意目录验证）。
 * 全程只读。返回值即 B3 起草雏形的输入。
 * **git 走同步 execFileSync**——请求路径请用下面的 `scanDirectoryAsync`（Q131：同步版会冻结事件循环）。
 * 批2 T12：projectId 非空时登记取消现场，扫描结束（含取消/抛错）即注销；hooks 供检查点注入（可选）。
 * 批3 T17：**遍历异步分批让出，git 仍同步**——本函数因此是 async、返回 Promise（调用点要 await）。
 */
export async function scanDirectory(root: string, projectId: string | null = null, hooks?: ScanHooks): Promise<ProjectScan> {
  const t0 = Date.now();
  const abs = path.resolve(root);
  assertScanRoot(abs);
  const rt: ScanRuntime = { run: beginScanRun(projectId), hooks, cancelled: false };
  try {
    // 批3 T17：assembleScan 现在 async，必须 `return await`——直接 `return` 会让 finally 在遍历结束前就注销现场
    return await assembleScan(abs, projectId, scanGit(abs), t0, rt);
  } finally {
    endScanRun(projectId, rt.run); // 批2 T12 + 批3 T18：无论正常/取消/抛错都注销，按对象身份只注销自己
  }
}

/** 目录级非 git 部分（文件树/README/docs/清单；受 SCAN_LIMITS 约束；批3 T17：async——文件树遍历每目录让出）。
 *  批2 T12：文件树遍历命中取消检查点即停手——丢弃未完成的部分结果（README/docs/清单不再读取），
 *  只把"停在哪 → 进度"如实带回（HTTP 侧据此回取消回执，不写半截产物）。 */
async function assembleScan(
  abs: string,
  projectId: string | null,
  git: GitSummary,
  t0: number,
  rt: ScanRuntime,
): Promise<ProjectScan> {
  const tree = await scanTree(abs, rt);
  if (rt.cancelled) {
    return {
      project_id: projectId,
      root: abs,
      scanned_at: new Date().toISOString(),
      duration_ms: Date.now() - t0,
      tree,
      readme: null,
      docs: [],
      git,
      manifests: { package_json: null, pyproject_toml: null, others: [] },
      cancelled: true,
      progress: rt.run ? { ...rt.run.progress } : undefined,
    };
  }
  const scan: ProjectScan = {
    project_id: projectId,
    root: abs,
    scanned_at: new Date().toISOString(),
    duration_ms: 0,
    tree,
    readme: scanReadme(abs),
    docs: scanDocs(abs),
    git,
    manifests: scanManifests(abs),
  };
  scan.duration_ms = Date.now() - t0;
  return scan;
}

/**
 * 异步版扫目录（Q131）：git 走 `execFile` + promise，**不冻结事件循环**（HTTP 请求线程用这条）。
 * 其余部分与另一条（`scanDirectory`）逐字同一份实现与同一份 SCAN_LIMITS 预算。
 * 批2 T12：git await 期间可能已收到取消——进树遍历后第一个安全检查点即命中，如实停手。
 * 批3 T17：遍历本体也每目录让出一次事件循环，取消回调可在遍历中执行、不必只等 git await。
 */
export async function scanDirectoryAsync(
  root: string,
  projectId: string | null = null,
  hooks?: ScanHooks,
): Promise<ProjectScan> {
  const t0 = Date.now();
  const abs = path.resolve(root);
  assertScanRoot(abs);
  const rt: ScanRuntime = { run: beginScanRun(projectId), hooks, cancelled: false };
  try {
    // 批3 T17：assembleScan 现在 async，必须 `return await`（否则 finally 提前注销现场）
    return await assembleScan(abs, projectId, await scanGitAsync(abs), t0, rt);
  } finally {
    endScanRun(projectId, rt.run); // 批3 T18：按对象身份只注销自己，旧 run 结束不得注销新 run
  }
}

/** 按注册表项目 id 扫描（HTTP 路由入口；路径只走注册表，与 watcher/workstation 同一红线）。
 *  批3 T17：遍历异步分批让出后本函数也返回 Promise（调用点要 await）。 */
export async function scanProject(projectId: string, dataDir?: string, hooks?: ScanHooks): Promise<ProjectScan> {
  const project = getProject(projectId, dataDir);
  if (!project) {
    throw new WsError("PROJECT_NOT_FOUND", `项目不存在: ${projectId}`);
  }
  return scanDirectory(project.path, project.id, hooks);
}

/** 按项目 id 扫描的异步版（Q131：HTTP 路由与起草链路用这条；阻塞口径见文件头） */
export async function scanProjectAsync(
  projectId: string,
  dataDir?: string,
  hooks?: ScanHooks,
): Promise<ProjectScan> {
  const project = getProject(projectId, dataDir);
  if (!project) {
    throw new WsError("PROJECT_NOT_FOUND", `项目不存在: ${projectId}`);
  }
  return scanDirectoryAsync(project.path, project.id, hooks);
}
