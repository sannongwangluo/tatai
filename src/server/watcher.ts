import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { watch, type FSWatcher } from "chokidar";
import { getProject } from "./registry";
import { warnCorruptLinesThrottled } from "./lineStream";
import { sanitizeErrorMessage } from "./redact";
import { nowIso } from "./time";
import { WsError } from "./workstation";
import { JUNK_DIR_RANDOM_TEMP_RE } from "../arch/config";

// 文件监听器（H1）：对项目根挂 chokidar（DESIGN.md §3.9 无刷新更新的驱动源，§7.2 清单内选型，MIT），
// 顺带把文件变更追加成 `<项目根>/.工作台/changes.jsonl`（§2.3.5 变更流水）。
//
// 防失控口径（§12.2 风险 3）：
// 1. 忽略规则：node_modules / .git / dist / .工作台 自身及常见构建产物一律不监听——
//    changes.jsonl 就在 .工作台 里，自监听会"追加 → 触发事件 → 再追加"死循环，必须排除；
// 2. 生命周期：服务启动时【不自动监听任何项目】，只由 HTTP 接口显式开/关
//    （POST/DELETE /api/projects/:id/watch，GET /api/watch 查当前监听中的项目）；
// 3. 监听范围限定项目根内（chokidar 只挂项目根一个入口，不碰根外路径）。
//
// H4 加固（2026-09-18，事由见 PROGRESS 踩坑栏 N2 踩坑①：某真实大项目把后端拖死）：
// 4. 【根因】不跟随联接点（followSymlinks:false）：实测现场项目（14 500 文件 / 29 208 目录，
//    其中 `.tmp` 类临时目录独占 12 286 文件 / 28 883 目录 / 209 个联接点）里既有自指环，
//    也有指向项目外大树（系统目录）的联接点；chokidar 默认跟随 → 扫描跑出项目根、
//    初始扫描永不收敛、事件无限重放、堆内存无界增长（实测 90MB → 760MB+）、事件循环被占满、HTTP 全停。
//    实测数据见 WATCH_LIMITS 注释与 PROGRESS 对应流水。
// 5. 初始扫描限量：挂监听前先跑一趟【读目录不算 size】的有界预扫描，条目数/单目录条目数/耗时
//    任一超预算即转「仅顶层」降级模式（depth 限制）并记录 truncated——不一次性 stat 上万文件；
// 6. 落盘合批 + 队列背压：变更先进内存队列、定时/凑批异步追加（不再每条 appendFileSync 阻塞事件循环），
//    队列超上限直接丢弃并计数（`dropped`），计数经 GET /api/watch 可见；
// 7. EBUSY/EPERM 类监听错误静默降级：只打前几条，其余只进 `errors`/`last_error` 计数，不刷屏。
// 8. 段名忽略只按【项目根内相对路径】判（isIgnoredPath）：chokidar 交给 ignored 的是绝对路径，
//    直接对整条路径做段名匹配会让"项目落在 temp/tmp/cache 类目录下"时整棵树被静默忽略。
//
// Q80（2026-09-18 审计）：启动窗口不再"事后无从发现"。挂监听发起（`started_at`）到 chokidar ready
// （`ready_at`）之间的变更按 H1 有意口径只喂 size 表、不进流水（预扫描那一小段连 watcher 都还没挂上），
// 该窗口吞下的 chokidar 事件现在单列 `stats.events_before_ready`，窗口两端与计数都进 GET /api/watch
// 明细——口径没动（存量文件仍不是"变更"），但"这段窗口里可能漏了什么"从此可按时间与计数自查。
//
// 上述加固都不缩小监听【口径】：H1 的 add/modify/remove 区分、size_delta、忽略四大目录
// CPU 不失控全部照旧（回归见 pnpm verify:h1/h2/h3，本卡自证见 pnpm verify:h4），
// 降级只在预算超限时发生且明示 truncated。
//
// 路径安全红线：本模块只接受项目 id，项目根一律从注册表取（registry.getProject），
// 不接受调用方直接传路径（与 workstation.ts 同一红线）。

/** changes.jsonl 一行（DESIGN.md §2.3.5：ts/path/action/size_delta；remove 是 add/modify 之外的补充） */
export interface ChangeLine {
  ts: string;
  path: string;
  action: "add" | "modify" | "remove";
  size_delta: number | null;
}

const CHANGES_JSONL_FILE = "changes.jsonl";

/**
 * H4 防失控预算（默认值即定版口径；数值来自 2026-09-18 对一个真实大项目的实测，
 * 项目路径与结构见 PROGRESS 该日 H4 流水）：
 * 实测现场 = 项目根 14 500 文件 / 29 208 目录，其中 `.tmp` 类临时目录独占 12 286 文件 / 28 883 目录 / 209 联接点。
 * - SCAN_MAX_* 是【挂监听前】有界预扫描的闸门：只 readdir 不 stat，超任一闸门即转「仅顶层」降级模式，
 *   并把触发原因记进 `truncate_reason`（不静默缩小监听范围）；
 * - PENDING_MAX / FLUSH_BATCH 是落盘队列的背压：超过 PENDING_MAX 直接丢弃并计数（防无限队列），
 *   FLUSH_BATCH 是一次 appendFile 写多少行（合批，不再一条一次同步写）。
 */
export interface WatchLimits {
  /** 预扫描条目上限（文件 + 目录；含忽略段的不计） */
  SCAN_MAX_ENTRIES: number;
  /** 预扫描单目录条目上限——"高翻转巨目录"判据（实测 `.tmp` 单层 294 项、整棵 41 378 项） */
  SCAN_MAX_DIR_ENTRIES: number;
  /** 预扫描墙钟上限（ms）：超时即降级，不长时间占事件循环 */
  SCAN_MAX_MS: number;
  /** 待落盘队列上限：超出的变更丢弃并计数（背压，防内存无界增长） */
  PENDING_MAX: number;
  /** 一次 appendFile 的批量上限（单项目落盘并发上限：同时最多一批在写） */
  FLUSH_BATCH: number;
  /** 落盘合并间隔（ms）：高频事件在窗口内合并成一次追加 */
  FLUSH_INTERVAL_MS: number;
  /** 同时监听的项目数上限（防"打开一堆项目"把服务拖住；超限拒绝并明示） */
  MAX_WATCHING_PROJECTS: number;
  /**
   * size 表条目上限（Q89）：该表按"被监听文件数"增长，此前无上限、无淘汰（只在 unlink 时删一条）。
   * 缺省与预扫描条目上限同值——预扫描放行的项目规模就在这个量级内，挂上监听后新建文件也不该把它
   * 撑得更大。超上限按**入表顺序**淘汰最早的一条，淘汰计数进 `stats.sizes_evicted`（不静默）。
   */
  SIZES_MAX: number;
  /** 同类监听错误（EBUSY/EPERM 等）最多打屏条数，其余只进计数 */
  ERROR_LOG_MAX: number;
}

const LIMIT_DEFAULTS: WatchLimits = {
  SCAN_MAX_ENTRIES: 20_000,
  SCAN_MAX_DIR_ENTRIES: 3_000,
  SCAN_MAX_MS: 1_500,
  PENDING_MAX: 5_000,
  FLUSH_BATCH: 500,
  FLUSH_INTERVAL_MS: 50,
  MAX_WATCHING_PROJECTS: 12,
  SIZES_MAX: 20_000,
  ERROR_LOG_MAX: 3,
};

/**
 * 单项预算可用环境变量 `TATAI_WATCH_<项名>` 覆盖（如 `TATAI_WATCH_PENDING_MAX=50`）。
 * 存在的唯一目的是让验证能把闸门**收紧**以真实触发丢弃/降级路径（`scripts/verify-h4.ts` 用），
 * 或给极端环境运维调参；不设时行为与定版口径逐字节一致（无效值一律回落到默认值）。
 */
function limitOf(name: keyof WatchLimits): number {
  const raw = process.env[`TATAI_WATCH_${name}`];
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : LIMIT_DEFAULTS[name];
}

export const WATCH_LIMITS: WatchLimits = {
  SCAN_MAX_ENTRIES: limitOf("SCAN_MAX_ENTRIES"),
  SCAN_MAX_DIR_ENTRIES: limitOf("SCAN_MAX_DIR_ENTRIES"),
  SCAN_MAX_MS: limitOf("SCAN_MAX_MS"),
  PENDING_MAX: limitOf("PENDING_MAX"),
  FLUSH_BATCH: limitOf("FLUSH_BATCH"),
  FLUSH_INTERVAL_MS: limitOf("FLUSH_INTERVAL_MS"),
  MAX_WATCHING_PROJECTS: limitOf("MAX_WATCHING_PROJECTS"),
  SIZES_MAX: limitOf("SIZES_MAX"),
  ERROR_LOG_MAX: limitOf("ERROR_LOG_MAX"),
};

// ── H2 变更事件订阅钩子（DESIGN.md §3.9 无刷新更新的推送源）──
// watcher 每产出一条变更（落 changes.jsonl 的同时）同步广播给订阅者；
// SSE 路由（GET /api/projects/:id/events）只是消费者之一，后续实况视图（V1）可复用。
export type ChangeListener = (projectId: string, line: ChangeLine) => void;
const changeListeners = new Set<ChangeListener>();

/** 订阅变更事件；返回退订函数。监听器异常被吞掉——推送失败绝不影响监听本体与流水落盘 */
export function onProjectChange(listener: ChangeListener): () => void {
  changeListeners.add(listener);
  return () => {
    changeListeners.delete(listener);
  };
}

function emitChange(projectId: string, line: ChangeLine): void {
  for (const listener of changeListeners) {
    try {
      listener(projectId, line);
    } catch {
      // 单个订阅者炸了不连累其他订阅者与监听本体
    }
  }
}

/**
 * 忽略目录段名（§12.2 风险 3 强制的前四个 + 常见构建产物 + H4 补的高翻转/临时/缓存类）。
 * 按路径【段】匹配（不是后缀匹配）：任何一级目录叫这些名字，整棵子树不监听。
 */
const IGNORED_SEGMENTS: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  "dist",
  ".工作台", // 红线：changes.jsonl 在 .工作台 里，自监听必死循环
  // 常见构建产物（超出口径的宽松补充，目的同为防失控）
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
  // H4 补：高翻转/临时/缓存类目录段——这类目录是"程序的工作区"，变更对用户没有信息量，
  // 却是最容易被系统持续改写、被锁住（EBUSY）的地方。实测现场项目的病根就在 `.tmp`
  //（12 286 文件 / 28 883 目录 / 209 联接点），加进来后同一项目实测只剩 1 190 文件 / 20 目录。
  ".tmp",
  "tmp",
  "temp",
  "cache",
]);

/** 监听模式：full = 全量递归；top = 预算超限后的降级模式（只挂项目根与一级子目录，已记录 truncated） */
export type WatchMode = "full" | "top";

/** 挂监听前的有界预扫描结果（决定 full/top，并作为 truncated 的证据） */
interface ScanResult {
  /** 实际数到的条目数（文件 + 目录，忽略段不计） */
  entries: number;
  /** 实际数到的目录数（不跟随联接点） */
  dirs: number;
  /** 单目录最大条目数（高翻转巨目录判据） */
  maxDirEntries: number;
  truncated: boolean;
  reason: string | null;
}

/** 单项目监听运行计数（GET /api/watch 可见，验证脚本与人工排查共用同一份数字） */
export interface WatchStats {
  /** chokidar 交来的事件总数（含初始扫描期——那批只喂 size 表、不进流水） */
  events: number;
  /**
   * Q80（2026-09-18 审计）：上面 `events` 里 ready **之前**的那批单独计数。
   * 启动窗口（预扫描 + chokidar 初始扫描）内的变更按 H1 有意口径只喂 size 表、不进流水；
   * 只报一个混在一起的 events 时，"这段窗口吞了多少条"事后无从发现——拆出来才看得见。
   * 注意预扫描那一小段连 watcher 都还没挂上，连事件都没有（不进任何计数），
   * 该窗口的边界由 `WatchInfo.started_at` / `ready_at` 给出。
   */
  events_before_ready: number;
  /**
   * ready 后判定为"变更"、**进落盘队列**的事件数。队列抽干后恒有 `changes = written + dropped`；
   * 冲刷途中"已从 pending 摘出、还没落盘"的那批尚未计入 written，读数会短暂差出在途量
   * （不含 pending 时最多一批、含 pending 时最多 PENDING_MAX + 一批），**对账要等队列静默之后**
   * （口径与实测见 scripts/verify-v06-14.ts 的 waitChangeQuiet）。
   */
  changes: number;
  /** 已落 changes.jsonl 的行数 */
  written: number;
  /** 被丢弃的行数（队列背压 + 落盘失败） */
  dropped: number;
  /** 监听错误条数（EBUSY/EPERM 等） */
  errors: number;
  /** Q89：size 表被淘汰的条目数（超 SIZES_MAX 后按入表顺序淘汰；被淘汰路径的 size_delta 记 null） */
  sizes_evicted: number;
  /** 最近一条错误的摘要（不打全栈，防刷屏） */
  last_error: string | null;
}

/** 单项目的监听句柄：chokidar watcher + 已知文件 size 表（算 size_delta 用）+ 落盘队列 */
interface WatchEntry {
  /** 项目根（unwatch 收尾抽干队列时要用，不能只靠调用方再传一次） */
  root: string;
  /** 预扫描期间为 null（还没挂上 chokidar）；预扫描被 unwatch 打断则一直是 null */
  watcher: FSWatcher | null;
  /** rel（正斜杠相对路径）→ 最近一次已知的文件 size；初始扫描与每次事件后刷新
   *  Q89：条目数有上限（WATCH_LIMITS.SIZES_MAX），超限按入表顺序淘汰（见 rememberSize） */
  sizes: Map<string, number | null>;
  ready: boolean;
  resolveReady: () => void;
  /** Q80：挂监听发起时刻（= 启动窗口左端，预扫描从这里开始） */
  startedAt: string;
  /** Q80：chokidar 初始扫描完成时刻（= 启动窗口右端）；未就绪为 null */
  readyAt: string | null;
  /** unwatch 已发生：预扫描/事件回调看到它就不再动作（关得掉、不泄漏） */
  closed: boolean;
  scan: ScanResult | null;
  mode: WatchMode;
  /** 待落盘队列（合批写 changes.jsonl 的缓冲区；上限 = WATCH_LIMITS.PENDING_MAX） */
  pending: ChangeLine[];
  flushTimer: NodeJS.Timeout | null;
  /** 落盘单飞门：同一项目同时只跑一条抽干队列的链（unwatch 靠它等写干净） */
  flushPromise: Promise<void> | null;
  /** .工作台 目录是否已确保存在（省掉每条事件一次 mkdirSync） */
  dirReady: boolean;
  stats: WatchStats;
}

/** 当前监听中的项目（内存态；服务重启即清空，监听一律由 HTTP 显式重开） */
const watching = new Map<string, WatchEntry>();

/** GET /api/watch 的项目级明细（H4：监听模式与计数可见，truncated 不静默） */
export interface WatchInfo {
  id: string;
  mode: WatchMode;
  ready: boolean;
  truncated: boolean;
  truncate_reason: string | null;
  entries: number;
  dirs: number;
  max_dir_entries: number;
  /** Q89：size 表当前条目数（恒 ≤ WATCH_LIMITS.SIZES_MAX；超限即淘汰） */
  size_entries: number;
  /** Q80：启动窗口左端——此刻起的变更在 ready 之前只会进 size 表（跨预扫描与初始扫描两段） */
  started_at: string;
  /** Q80：启动窗口右端（ready 之后的事件才进流水）；未就绪为 null */
  ready_at: string | null;
  stats: WatchStats;
}

export function listWatchDetails(): WatchInfo[] {
  return [...watching.entries()].map(([id, e]) => ({
    id,
    mode: e.mode,
    ready: e.ready,
    truncated: e.scan?.truncated ?? false,
    truncate_reason: e.scan?.reason ?? null,
    entries: e.scan?.entries ?? 0,
    dirs: e.scan?.dirs ?? 0,
    max_dir_entries: e.scan?.maxDirEntries ?? 0,
    size_entries: e.sizes.size,
    started_at: e.startedAt,
    ready_at: e.readyAt,
    stats: { ...e.stats },
  }));
}

function changesJsonlPath(projectRoot: string): string {
  return path.join(projectRoot, ".工作台", CHANGES_JSONL_FILE);
}

/**
 * 忽略判定（H4 修正）：段名黑名单只对【项目根内的相对路径】生效。
 * chokidar 5 交给 ignored 的是**绝对路径**，若直接对整条绝对路径做段名匹配，
 * 项目根的祖先目录会被当成"项目内的段"——项目落在 `<...>\Temp\`、`/tmp/`、`<...>\cache\`
 * 之类目录下时整棵树会被静默忽略（"监听变什么都不监"）。这里先减掉项目根再判段。
 * 根外的路径一律按忽略处理：监听范围严格限定项目根内（H1 DoD④，联接点也不越界）。
 */
/**
 * V09-07（附录 E.8）：段名黑名单**之前**的定点豁免——两个图纸源精确相对路径放行
 * （分隔符归一后比较）：非塔台项目的默认图纸源就是 `.工作台/design.md` / `.工作台/plan.md`，
 * 它们埋在整段忽略的 `.工作台` 里时，"外部 Agent 改了图纸源"这条发现链永远收不到事件。
 * 只放行这两个**文件**；`.工作台` 的其余内容（`work/events.jsonl`、`arch/`、`evidence/` 等
 * 生成物）照旧整段忽略——防自触死循环红线不变。
 */
const WORKBENCH_DOC_EXEMPTIONS: ReadonlySet<string> = new Set([
  ".工作台/design.md",
  ".工作台/plan.md",
]);

/** 导出供回归脚本直测（与 graphRefresh.changeVerdict 同一惯例：判据纯函数、单测直接调） */
export function isIgnoredPath(testPath: string, root: string): boolean {
  const rel = path.relative(root, path.resolve(testPath));
  if (rel === "") return false; // 项目根本体
  if (rel.startsWith("..") || path.isAbsolute(rel)) return true; // 根外
  const posix = rel.split(/[\\/]/).join("/");
  // V09-07：两个图纸源文件精确放行（必须在段名黑名单之前）
  if (WORKBENCH_DOC_EXEMPTIONS.has(posix)) return false;
  // `.工作台` 目录本体不能整段忽略：chokidar 对被忽略的目录**不下钻**，本体 ignored 了，
  // 里面被豁免的两个文件就永远轮不到判定。其余 `.工作台/**` 由下面的段名检查照旧拦下。
  if (posix === ".工作台") return false;
  // 2026-10-05：随机名临时目录（Python tempfile 的 tmp+8 位随机串）与具名段一并忽略——
  // 漏网时测试建删临时目录会持续触发 structure_top 图刷新并反复重写派生文件（现场实锤）。
  return rel.split(/[\\/]/).some((seg) => IGNORED_SEGMENTS.has(seg) || JUNK_DIR_RANDOM_TEMP_RE.test(seg));
}

/**
 * 有界预扫描（H4）：只 readdir、不 stat、不跟随联接点，任一预算超限立即停手并给出原因。
 * 目的不是"数准"，而是【在把事件循环交给 chokidar 之前】先知道这个项目是不是巨兽；
 * 是巨兽就转「仅顶层」降级模式（见 startWatching），绝不一次性 stat 上万文件。
 */
async function boundedScan(root: string): Promise<ScanResult> {
  const t0 = Date.now();
  let entries = 0;
  let dirs = 0;
  let maxDirEntries = 0;
  let truncated = false;
  let reason: string | null = null;
  const queue: string[] = [root];
  for (let head = 0; head < queue.length; head++) {
    let dirents: fs.Dirent[];
    try {
      dirents = await fsp.readdir(queue[head], { withFileTypes: true });
    } catch {
      continue; // 读不动的目录（被占/权限）跳过——预扫描不因为一个目录失败而中断
    }
    let inDir = 0;
    for (const d of dirents) {
      if (IGNORED_SEGMENTS.has(d.name) || JUNK_DIR_RANDOM_TEMP_RE.test(d.name)) continue;
      inDir++;
      entries++;
      // 联接点不跟随（与 chokidar followSymlinks:false 同口径），否则扫描自己会绕进环里
      if (d.isDirectory() && !d.isSymbolicLink()) {
        dirs++;
        queue.push(path.join(queue[head], d.name));
      }
    }
    if (inDir > maxDirEntries) maxDirEntries = inDir;
    if (maxDirEntries >= WATCH_LIMITS.SCAN_MAX_DIR_ENTRIES) {
      truncated = true;
      reason = `单目录条目 ${maxDirEntries} ≥ 上限 ${WATCH_LIMITS.SCAN_MAX_DIR_ENTRIES}`;
      break;
    }
    if (entries >= WATCH_LIMITS.SCAN_MAX_ENTRIES) {
      truncated = true;
      reason = `项目条目 ${entries} ≥ 上限 ${WATCH_LIMITS.SCAN_MAX_ENTRIES}`;
      break;
    }
    if (Date.now() - t0 >= WATCH_LIMITS.SCAN_MAX_MS) {
      truncated = true;
      reason = `预扫描耗时 ≥ 上限 ${WATCH_LIMITS.SCAN_MAX_MS}ms`;
      break;
    }
  }
  return { entries, dirs, maxDirEntries, truncated, reason };
}

/**
 * 更新 size 表（Q89）：条目数有上限（`SIZES_MAX`，缺省与预扫描条目上限同值——预扫描放行的项目规模
 * 就在这个量级内），超上限按**入表顺序**淘汰最早的一条（Map 保持插入顺序；对已存在的键 `set` 不移动
 * 位置，所以淘汰的是"最早登记的那批路径"）。被淘汰路径此后按既有口径记 `size_delta: null`
 *（"拿不到旧值"本来就允许 null），淘汰条数进 `stats.sizes_evicted` 并打屏——不静默。
 */
function rememberSize(entry: WatchEntry, projectId: string, rel: string, size: number | null): void {
  entry.sizes.set(rel, size);
  if (entry.sizes.size <= WATCH_LIMITS.SIZES_MAX) return;
  const oldest = entry.sizes.keys().next();
  if (oldest.done) return;
  entry.sizes.delete(oldest.value);
  entry.stats.sizes_evicted++;
  if (entry.stats.sizes_evicted === 1 || entry.stats.sizes_evicted % 10_000 === 0) {
    console.warn(
      `[watcher] 项目 ${projectId} size 表已达上限 ${WATCH_LIMITS.SIZES_MAX}，开始按入表顺序淘汰` +
        `（累计淘汰 ${entry.stats.sizes_evicted} 条；被淘汰路径的 size_delta 记 null）`,
    );
  }
}

/**
 * 变更入队（H4 背压）：队满直接丢并计数；凑够一批或到点就异步落盘。
 * 落盘成功后才广播（emitChange），保证 SSE 与 GET changes 口径一致（H2 DoD④）。
 * 计数口径：每次入队尝试都记 `changes`；**队列抽干后**恒有 `changes = written + dropped`（落盘账可对）。
 * 注意冲刷途中"已摘出、还没落盘"的那批（drainPending 先 splice 再 await 写盘）不在 written 里，
 * 这几毫秒内读数会短暂差出在途量，不是少记——对账必须等静默（见 WatchStats.changes 注释）。
 */
function enqueueChange(entry: WatchEntry, projectId: string, root: string, line: ChangeLine): void {
  entry.stats.changes++;
  if (entry.pending.length >= WATCH_LIMITS.PENDING_MAX) {
    entry.stats.dropped++;
    if (entry.stats.dropped === 1 || entry.stats.dropped % 1000 === 0) {
      console.warn(
        `[watcher] 项目 ${projectId} 变更洪峰：待落盘队列已满 ${WATCH_LIMITS.PENDING_MAX}，本条起丢弃（累计丢弃 ${entry.stats.dropped}）`,
      );
    }
    return;
  }
  entry.pending.push(line);
  if (entry.pending.length >= WATCH_LIMITS.FLUSH_BATCH) {
    void flushPending(entry, projectId, root);
    return;
  }
  if (!entry.flushTimer) {
    entry.flushTimer = setTimeout(() => {
      void flushPending(entry, projectId, root);
    }, WATCH_LIMITS.FLUSH_INTERVAL_MS);
  }
}

/**
 * 合批异步追加（H4，单飞）：同一项目同时只跑一条抽干队列的链，写失败计入 errors/dropped，不炸监听本体。
 * unwatch 收尾也调它——返回值就是那条链，等它 resolve 就等于"队列写干净了"。
 */
function flushPending(entry: WatchEntry, projectId: string, root: string): Promise<void> {
  if (entry.flushTimer) {
    clearTimeout(entry.flushTimer);
    entry.flushTimer = null;
  }
  if (!entry.flushPromise) {
    entry.flushPromise = drainPending(entry, projectId, root).finally(() => {
      entry.flushPromise = null;
    });
  }
  return entry.flushPromise;
}

/** 抽干队列：一批一批 appendFile（每批 ≤ FLUSH_BATCH 行），写完一批才广播这批 */
async function drainPending(entry: WatchEntry, projectId: string, root: string): Promise<void> {
  const file = changesJsonlPath(root);
  while (entry.pending.length > 0) {
    const batch = entry.pending.splice(0, WATCH_LIMITS.FLUSH_BATCH);
    const text = batch.map((l) => JSON.stringify(l)).join("\n") + "\n";
    try {
      if (!entry.dirReady) {
        await fsp.mkdir(path.dirname(file), { recursive: true });
        entry.dirReady = true;
      }
      await fsp.appendFile(file, text, "utf8");
    } catch (e) {
      entry.dirReady = false; // 目录可能被删了，下一批重建
      entry.stats.dropped += batch.length;
      entry.stats.errors++;
      // F5（2026-09-18 审计）：last_error 经 GET /api/watch 回显给远程，ENOENT 一类消息里的
      // 本机绝对路径先过消息级脱敏（盘符/UNC → <path>）再落 stats
      entry.stats.last_error = sanitizeErrorMessage(`changes.jsonl 写入失败: ${(e as Error).message}`).slice(0, 200);
      if (entry.stats.errors <= WATCH_LIMITS.ERROR_LOG_MAX) {
        console.error(`[watcher] 项目 ${projectId} ${entry.stats.last_error}`);
      }
      continue;
    }
    entry.stats.written += batch.length;
    for (const line of batch) emitChange(projectId, line);
  }
}

/**
 * 开监听（H1）：对项目根挂 chokidar。幂等——已在监听时直接返回现状（already:true）。
 * 返回的 ready 为 Promise：预扫描 + chokidar 初始扫描（chokidar ready）完成后 resolve，
 * 初始扫描期间只登记 size 表、不写流水（存量文件不是"变更"）。
 * H4 起挂载是异步的（先有界预扫描、再决定 full/top 模式），函数本身仍同步返回；
 * 预扫描期间就收到 unwatch 也能正确收场（不留下没人消费的 watcher）。
 *
 * Q51（2026-09-18 审计）：返回的 `mounted`（= 本次挂载这一次尝试的 promise）必须被调用方接住——
 * 此前是 `void startWatching(...)`：抛错既成未处理拒绝，entry 又已经进表（永久占坑、第二次 POST 直接
 * 回 already:true 永不重试），而 HTTP 层恒回 `{watching:true}`，界面完全不知情。现在：
 * 失败即**释放占坑 + 记 last_error + 打屏**，并且失败如实经 `mounted` 的拒绝回给调用方。
 */
export function watchProject(
  projectId: string,
  dataDir?: string,
): {
  watching: boolean;
  already: boolean;
  root: string;
  /** chokidar 初始扫描完成（ready 之后写流水） */
  ready: Promise<void>;
  /** 本次**挂载尝试**的落地：成功 resolve；失败 reject（同时已释放占坑，可重试） */
  mounted: Promise<void>;
} {
  const project = getProject(projectId, dataDir);
  if (!project) {
    throw new WsError("PROJECT_NOT_FOUND", `项目不存在: ${projectId}`);
  }
  const existing = watching.get(projectId);
  if (existing) {
    return {
      watching: true,
      already: true,
      root: project.path,
      ready: Promise.resolve(),
      mounted: Promise.resolve(),
    };
  }
  const root = project.path;
  if (!fs.existsSync(root)) {
    throw new WsError("INVALID_INPUT", `项目目录不存在: ${root}`);
  }
  // 并发上限（H4）：同时在听的项目数封顶，超了拒绝并明示——不让"打开一堆项目"把服务拖住
  if (watching.size >= WATCH_LIMITS.MAX_WATCHING_PROJECTS) {
    console.warn(
      `[watcher] 项目 ${projectId} 开监听被拒：同时在听项目已达上限 ${WATCH_LIMITS.MAX_WATCHING_PROJECTS}`,
    );
    throw new WsError(
      "WATCH_LIMIT_REACHED",
      `同时在听的项目已达上限 ${WATCH_LIMITS.MAX_WATCHING_PROJECTS}，请先关掉不看的项目`,
    );
  }
  let resolveReady!: () => void;
  const readyPromise = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  const entry: WatchEntry = {
    root,
    watcher: null,
    sizes: new Map<string, number | null>(),
    ready: false,
    resolveReady,
    startedAt: nowIso(), // Q80：启动窗口左端
    readyAt: null,
    closed: false,
    scan: null,
    mode: "full",
    pending: [],
    flushTimer: null,
    flushPromise: null,
    dirReady: false,
    stats: {
      events: 0,
      events_before_ready: 0,
      changes: 0,
      written: 0,
      dropped: 0,
      errors: 0,
      sizes_evicted: 0,
      last_error: null,
    },
  };
  watching.set(projectId, entry);
  const mounted = startWatching(entry, projectId, root);
  // Q51：挂载失败不只"记一笔"——先把占坑释放掉（下次 POST 才重试得上），再如实记错/打屏。
  // 这里挂的 catch 同时保证该 promise 不会变成未处理拒绝（调用方另有自己的接法，如 HTTP 层）。
  mounted.catch((e: unknown) => {
    watching.delete(projectId);
    entry.closed = true;
    entry.resolveReady(); // 等 ready 的调用方别悬着
    if (entry.watcher) {
      const watcher = entry.watcher;
      entry.watcher = null;
      void watcher.close().catch(() => {});
    }
    entry.stats.errors++;
    entry.stats.last_error = sanitizeErrorMessage(`挂载监听失败: ${(e as Error).message}`).slice(0, 200);
    console.error(`[watcher] 项目 ${projectId} ${entry.stats.last_error}（已释放占坑，下次开监听会重试）`);
  });
  return { watching: true, already: false, root, ready: readyPromise, mounted };
}

/** 预扫描 → 定模式 → 挂 chokidar → 装事件处理（异步；预扫描被 unwatch 打断则静默收场） */
async function startWatching(entry: WatchEntry, projectId: string, root: string): Promise<void> {
  const scan = await boundedScan(root);
  if (entry.closed) {
    entry.resolveReady();
    return;
  }
  entry.scan = scan;
  entry.mode = scan.truncated ? "top" : "full";
  if (scan.truncated) {
    // 不静默缩小监听范围：模式与原因同时进 console 与 GET /api/watch（truncated / truncate_reason）
    console.warn(
      `[watcher] 项目 ${projectId} 初始扫描超预算（${scan.reason}）→ 降级为仅顶层监听（depth 限制，truncated:true）；已数 ${scan.entries} 项 / ${scan.dirs} 目录`,
    );
  }

  const watcher = watch(root, {
    // cwd 让事件路径直接是项目根相对路径（流水里的 path 字段即 §2.3.5 的相对项目根口径）
    cwd: root,
    ignoreInitial: false, // 初始扫描只喂 size 表（ready 前不写流水）
    ignorePermissionErrors: true,
    // H4 根因修复：不跟随联接点。实测现场项目的临时目录里既有自指环、也有指向项目外大树的联接点，
    // chokidar 默认跟随 → 扫描跑出项目根、初始扫描永不收敛、事件无限重放、内存无界（见文件头 H4 第 4 条）。
    followSymlinks: false,
    // 降级模式：只挂项目根与一级子目录（truncated 已在上方记录）
    ...(entry.mode === "top" ? { depth: 1 } : {}),
    // awaitWriteFinish 防抖：文件 size 稳定后才发事件，避免编辑器写入中途刷出半截 modify
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
    // 忽略判定按【项目根内的相对路径】的段名匹配（见 isIgnoredPath 注释），不是整条绝对路径——
    // chokidar 5 传给 ignored 的是绝对路径，直接用段名匹配会把项目根的祖先目录也算进来
    ignored: (testPath: string) => isIgnoredPath(testPath, root),
  });
  entry.watcher = watcher;
  if (entry.closed) {
    // 预扫描期间被 unwatch：没人再消费这个 watcher，直接关掉（资源回收，不泄漏句柄）
    entry.watcher = null;
    void watcher.close();
    return;
  }

  const toRel = (p: string) => p.split(path.sep).join("/");
  const onError = (err: unknown): void => {
    // H4：EBUSY/EPERM 类监听错误静默降级——前几条打屏，其余只进计数
    //（原实现每条都打，系统持续 EBUSY 时 stderr 会被刷爆）
    const code = (err as NodeJS.ErrnoException).code;
    entry.stats.errors++;
    // F5：同上——监听错误消息里常带被监听文件的绝对路径，脱敏后再进 stats
    entry.stats.last_error = sanitizeErrorMessage(
      `${code ? `${code}: ` : ""}${(err as Error).message}`,
    ).slice(0, 200);
    if (entry.stats.errors <= WATCH_LIMITS.ERROR_LOG_MAX) {
      console.error(
        `[watcher] 项目 ${projectId} 监听错误 #${entry.stats.errors}: ${entry.stats.last_error}`,
      );
    } else if (entry.stats.errors === WATCH_LIMITS.ERROR_LOG_MAX + 1) {
      console.error(
        `[watcher] 项目 ${projectId} 监听错误已达 ${WATCH_LIMITS.ERROR_LOG_MAX} 条，后续只计数不打屏（EBUSY/EPERM 类静默降级，计数见 GET /api/watch）`,
      );
    }
  };

  watcher.on("add", (p, stats) => {
    if (entry.closed) return;
    entry.stats.events++;
    const rel = toRel(p);
    const size = stats ? stats.size : null;
    if (!entry.ready) {
      entry.stats.events_before_ready++; // Q80：启动窗口吞下的那批（只喂 size 表）
      rememberSize(entry, projectId, rel, size);
      return;
    }
    // add 的 size_delta 口径：文件当前大小（从无到有，旧值视为 0；拿不到 stat 记 null）
    rememberSize(entry, projectId, rel, size);
    enqueueChange(entry, projectId, root, {
      ts: nowIso(),
      path: rel,
      action: "add",
      size_delta: size,
    });
  });
  watcher.on("change", (p, stats) => {
    if (entry.closed) return;
    entry.stats.events++;
    if (!entry.ready) {
      entry.stats.events_before_ready++; // Q80：同上
      return;
    }
    const rel = toRel(p);
    const size = stats ? stats.size : null;
    const old = entry.sizes.has(rel) ? entry.sizes.get(rel)! : null;
    // size_delta = 前后 size 差；拿不到旧值（如监听前就缺登记）或新 stat 时记 null
    const delta = old !== null && size !== null ? size - old : null;
    rememberSize(entry, projectId, rel, size);
    enqueueChange(entry, projectId, root, {
      ts: nowIso(),
      path: rel,
      action: "modify",
      size_delta: delta,
    });
  });
  watcher.on("unlink", (p) => {
    if (entry.closed) return;
    entry.stats.events++;
    if (!entry.ready) {
      entry.stats.events_before_ready++; // Q80：同上
      return;
    }
    const rel = toRel(p);
    const old = entry.sizes.has(rel) ? entry.sizes.get(rel)! : null;
    entry.sizes.delete(rel);
    // remove 的 size_delta 口径：-旧大小（拿不到旧值记 null）
    enqueueChange(entry, projectId, root, {
      ts: nowIso(),
      path: rel,
      action: "remove",
      size_delta: old !== null ? -old : null,
    });
  });
  watcher.on("ready", () => {
    entry.ready = true;
    entry.readyAt = nowIso(); // Q80：启动窗口右端
    entry.resolveReady();
  });
  watcher.on("error", onError);
}

/**
 * 关监听（H1）：先把已排队的变更写完、再关 watcher，返回是否真的关掉了（没在监听时返回 false，幂等）。
 * H4 起预扫描期间被关也收场得掉（entry.closed 置位 → startWatching 不挂 watcher），
 * 顺序是「置 closed → 关 watcher → 抽干队列落盘」，保证已收下的变更不丢、句柄/定时器全回收。
 */
export async function unwatchProject(projectId: string): Promise<boolean> {
  const entry = watching.get(projectId);
  if (!entry) return false;
  watching.delete(projectId);
  entry.closed = true;
  entry.resolveReady(); // 没 ready 就被关：别让等 ready 的调用方悬着
  if (entry.watcher) {
    const watcher = entry.watcher;
    entry.watcher = null;
    await watcher.close();
  }
  await flushPending(entry, projectId, entry.root);
  return true;
}

/** 当前监听中的项目 id 列表（GET /api/watch） */
export function listWatching(): string[] {
  return [...watching.keys()];
}

/**
 * 解析一行 changes.jsonl（§2.3.5 字段校验的**唯一出处**，坏行一律 CHANGES_JSONL_CORRUPT 不静默跳过）。
 * 单项目读（readChanges / H3 分页）与 P3 全局归并（global-changes.ts 的倒读行流）共用这一份，
 * 校验口径不复制第二遍；`where` 是出错位置的可读描述（如 `changes.jsonl 第 3 行`、
 * `<项目 id> changes.jsonl 倒序第 3 行`），只影响报错文案。
 * 它只负责"这行坏不坏"；**坏行之后怎么办由调用方定**：global-changes 摘除该项目并把行数从 total 扣掉，
 * readChanges 跳过该行、其余照常读出并告警（Q32）。
 */
export function parseChangeLine(text: string, where: string): ChangeLine {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new WsError("CHANGES_JSONL_CORRUPT", `${where}不是合法 JSON`);
  }
  const l = raw as ChangeLine;
  if (
    typeof l !== "object" ||
    l === null ||
    typeof l.ts !== "string" ||
    typeof l.path !== "string" ||
    (l.action !== "add" && l.action !== "modify" && l.action !== "remove") ||
    !(typeof l.size_delta === "number" || l.size_delta === null)
  ) {
    throw new WsError(
      "CHANGES_JSONL_CORRUPT",
      `${where}字段不符合 DESIGN.md §2.3.5（ts/path/action/size_delta）`,
    );
  }
  return l;
}

/** 倒读块大小（与 global-changes.ts 的窗口读同量级）：从文件尾往前读，内存 = 块 + 要的那几行 */
const TAIL_CHUNK_BYTES = 64 * 1024;
/** 换行字节 */
const LF = 0x0a;

/**
 * 单行字节上限（Q97/Q134，2026-09-19 审计）：**全仓唯一一处数值**。
 * 倒读实现（本文件的 `iterTailLines` 与 `global-changes.ts` 的 `iterLinesDescending`）都要靠 `head`
 * 把"上一块开头的残缺行"攒起来，`head` 的长度 = 当前行长——行长无上限时内存与拷贝量随行无界增长
 * （同构探针：24MiB 单行 → 累计拷贝 ≈9.3GiB / 3.1s / 峰值 24MiB）。正常流水一行 ~百字节，
 * 1 MiB 已极宽松。超限按坏行口径处理（两边各自的处理见调用点注释）。
 */
export const MAX_CHANGE_LINE_BYTES = 1024 * 1024;

/**
 * 只读文件**尾部**：从尾按块往前读、按 `\n` 字节边界切行，产出「最新在前」的原始行流（惰性）。
 * 手法与 global-changes.ts 的 iterLinesDescending 同一份（那边服务 K 路归并）；这里不复用那个导出，
 * 是因为依赖方向相反——global-changes 要用本模块的 parseChangeLine，反向 import 会绕成循环。
 * 切行按字节边界、整行才 decode：UTF-8 多字节（中文路径）不会被块边界劈成半个。
 *
 * Q134（2026-09-19 审计）：`head` 攒的就是当前行，块里找不到 `\n` 就整块不切——**行长必须有上限**，
 * 否则内存/拷贝量随行无界（姊妹实现 global-changes.ts 的 Q97 早已有这条闸，本函数当时漏了）。
 * 超长行按坏行处理：**丢掉已攒的那一段**继续往前读（既不把整行读进内存，也不因为一行坏掉就把
 * 其余流水全丢掉——与 Q32 的"跳过坏行"同一口径），并通过 `onOverlong` 报给调用方计数。
 */
function* iterTailLines(file: string, onOverlong?: (bytes: number) => void): Generator<string> {
  const fd = fs.openSync(file, "r");
  try {
    let pos = fs.fstatSync(fd).size;
    let head = Buffer.alloc(0); // 上一块开头的残缺行，与下一块拼起来
    while (pos > 0) {
      const len = Math.min(TAIL_CHUNK_BYTES, pos);
      const start = pos - len;
      const buf = Buffer.allocUnsafe(len);
      fs.readSync(fd, buf, 0, len, start);
      pos = start;
      const combined = head.length > 0 ? Buffer.concat([buf, head]) : buf;
      let end = combined.length;
      while (end > 0) {
        const idx = combined.lastIndexOf(LF, end - 1);
        if (idx < 0) break;
        yield combined.subarray(idx + 1, end).toString("utf8");
        end = idx;
      }
      head = Buffer.from(combined.subarray(0, end));
      if (head.length > MAX_CHANGE_LINE_BYTES) {
        onOverlong?.(head.length); // 报给调用方（按坏行计数 + 限频告警）
        head = Buffer.alloc(0); // 丢掉这一段：内存有界，继续往前找上一条行的边界
      }
    }
    if (head.length > 0) yield head.toString("utf8"); // 首行没有换行收尾的情形
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * 坏行告警（Q32；节流表已抽到 `lineStream.ts`，与 gate/chat 共用一份口径——Q136）。
 */
function warnCorruptLines(projectId: string, count: number, firstWhere: string): void {
  if (count === 0) return;
  warnCorruptLinesThrottled(
    `changes:${projectId}`,
    `[watcher] 项目 ${projectId} changes.jsonl 有 ${count} 行坏行（首处：${firstWhere}）——已跳过这些行、其余照常读出；` +
      `最常见成因是落盘写到一半被 kill 留下的半截行（读路径只读不修）`,
  );
}

/**
 * 读 changes.jsonl（§3.8：时间倒序，最新在上；limit 截断）。
 * 文件不存在返回空数组（正常空态）。
 *
 * Q32（2026-09-18 审计）：坏行（最常见的是落盘写到一半被 kill 留下的**半截行**）此前会让整份文件
 * 拒读——live / activity / changes 三条路由全变错误响应，而且半截行会永远留在文件里（后续追加都写在
 * 它后面），等于该项目"变更流水永久打不开"。现在改为与仓内既有降级口径一致（terminalHistory 的半截行、
 * expand 的坏行同一手法）：**跳过坏行、其余照常读出**，并按项目做**限频告警**（每项目最多一分钟一条——
 * live 每 5s 轮询一次，不节流会刷屏）。读路径只读不修（live/summary 是只读红线，不许为修文件写盘）。
 *
 * Q28（2026-09-18 审计）：带 limit 的调用（实况 50、跨项目汇总 1——两条热轮询每 5s/10s 各一次）
 * 此前也是**全量 readFileSync + 逐行解析 + reverse 后再 slice**，limit 一点 IO 都不省。
 * 现在带 limit 走 `iterTailLines` 的**尾部窗口读**：从文件尾往前攒，够 limit 条即停手，
 * 读入量与"要几条"同阶、与文件多大无关。代价（与 P3 窗口读同一取舍，已登记）：窗口外深处的坏行
 * 不再被顺带发现——**全量口径仍属 limit 缺省的那条路**（queryChanges 的 total/过滤读必须全过）。
 *
 * Q134（2026-09-19 审计）："与文件多大无关"这句话原先只对**行数**成立，单行长度是另一维——超长行
 * （外部写入/损坏）会让窗口读的内存与拷贝量随行长无界。现在窗口读补上 `MAX_CHANGE_LINE_BYTES`：
 * 超长行按坏行跳过（`head` 攒到上限即丢，内存有界），并计入坏行计数与告警（见 `iterTailLines`）。
 */
export function readChanges(
  projectId: string,
  limit?: number,
  dataDir?: string,
): ChangeLine[] {
  const project = getProject(projectId, dataDir);
  if (!project) {
    throw new WsError("PROJECT_NOT_FOUND", `项目不存在: ${projectId}`);
  }
  const file = changesJsonlPath(project.path);
  if (!fs.existsSync(file)) return [];
  const capped = typeof limit === "number" && limit >= 0;
  if (capped && limit === 0) return []; // 要 0 条：连文件都不开
  const out: ChangeLine[] = [];
  let bad = 0;
  let firstBad = "";
  if (capped) {
    let back = 0; // 从最新往前数第几行（尾部窗口拿不到绝对行号，文案据实写"倒数第 N 行"）
    for (const text of iterTailLines(file, (bytes) => {
      // Q134：超长行（> MAX_CHANGE_LINE_BYTES）已在读侧丢掉，这里只按坏行口径计数 + 告警
      bad++;
      if (firstBad === "") {
        firstBad = `changes.jsonl 有一行超过 ${MAX_CHANGE_LINE_BYTES} 字节上限（已跳过该行，累计 ${bytes} 字节）`;
      }
    })) {
      const t = text.trim();
      if (t === "") continue;
      back++;
      const where = `changes.jsonl 倒数第 ${back} 行`;
      try {
        out.push(parseChangeLine(t, where));
      } catch {
        bad++; // 坏行跳过（Q32）：不因为一行半截就让整份流水打不开
        if (firstBad === "") firstBad = where;
      }
      if (out.length >= limit) break; // 收满即停：不再往前读任何行
    }
    warnCorruptLines(projectId, bad, firstBad);
    return out; // 已是倒序（最新在前），无需 reverse
  }
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i].trim();
    if (text === "") continue;
    const where = `changes.jsonl 第 ${i + 1} 行`;
    try {
      out.push(parseChangeLine(text, where));
    } catch {
      bad++;
      if (firstBad === "") firstBad = where;
    }
  }
  warnCorruptLines(projectId, bad, firstBad);
  out.reverse();
  return out;
}

/** H3 分页/过滤查询参数（GET changes 用；path 为子串过滤，够前端按文件聚合/过滤用） */
export interface ChangesQuery {
  limit?: number;
  offset?: number;
  path?: string;
}

/**
 * H3：分页/过滤读变更流水。在 readChanges 的全量倒序结果上做 path 子串过滤 + offset/limit 切片；
 * total 为过滤后的总条数（前端分页计数用）。几千行量级内存切片足够，不提前优化。
 * Q28（2026-09-18 审计）：total 与 path 过滤都要求"全量过一遍"，所以这里**固定走 limit 缺省的
 * 全量口径**（readChanges(projectId, undefined)），窗口读帮不上忙——只要"最新 N 条、不要 total"
 * 的调用方请直接用 `readChanges(id, N)`（走尾部窗口读），别经过本函数。
 */
export function queryChanges(
  projectId: string,
  query: ChangesQuery = {},
  dataDir?: string,
): { changes: ChangeLine[]; total: number } {
  const all = readChanges(projectId, undefined, dataDir);
  const filtered =
    typeof query.path === "string" && query.path !== ""
      ? all.filter((c) => c.path.includes(query.path!))
      : all;
  const offset = query.offset ?? 0;
  const end = typeof query.limit === "number" ? offset + query.limit : undefined;
  return { changes: filtered.slice(offset, end), total: filtered.length };
}

/** 进程退出前兜底：关掉全部监听（服务进程被 kill 时由操作系统回收，这里是优雅退出路径） */
export async function closeAllWatchers(): Promise<void> {
  const ids = [...watching.keys()];
  await Promise.all(ids.map((id) => unwatchProject(id)));
}
