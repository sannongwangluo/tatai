// A2 调参定版配置（DESIGN.md §12.1 未决项 #3 收口）：Flash 起名提示词 +
// 渲染 JSON 硬上限具体数值，全部集中在本文件，调参只改这里。
// 数值依据（2026-09-17 对两个真实项目真跑调参：一个 7 模块 5 边、一个 15 模块 33 边，流水见 PROGRESS.md A2）：
// - MAX_NODES=15：与 §3.3 规则 1「顶层 5–15 个人眼抓不住」同一口径，超了必聚合；
// - MAX_EDGES=40：15 节点两两可达 105 边，真实项目模块间边远稀疏（实测 7 模块 5 边、
//   15 模块 33 边），40 足够兜住真实项目又不至于糊成毛线团；
// - MAX_FANOUT=8 / FANOUT_KEEP=5：公共工具节点（被引次数爆高）只留 top-5 入边（§4.3 第 4 招）；
// - NAME_TEMPERATURE=0.3：起名是翻译不是创作，低温求稳（§12.2 风险 2 防名字跳变，
//   与签名缓存双保险）；SAMPLE_FILES=12：给 Flash 的文件名抽样数，够猜语义又不爆提示词。

/** 渲染 JSON 硬上限（§4.3 第 1 招：JSON 层面截断，超出部分不渲染，改聚合节点） */
export const ARCH_LIMITS = {
  /** 顶层渲染节点硬上限（超出合并为「还有 N 个」聚合节点 __more__） */
  MAX_NODES: 15,
  /** A4 下钻层**单枝**子节点硬上限（N2 加；§4.3 第 1 招同一招数用在第二层）：
   *  顶层 15 是"大模块"口径（§3.3 规则 1），下钻层是文件级清单、方块更小、名字更短，
   *  一屏 40 个 ≈ 8×5 仍可读；超了就不是"人看的清单"而是巨枝（归档日志/临时产物目录，
   *  实测一个 1.2 万文件的真实项目里 `.tmp` 有 294 个直接子级），截断 + 聚合掉。
   *  截断在遍历子树**之前**落地：超上限的子级不遍历、不解析、不渲染（§4.3 第 2 招）。 */
  MAX_CHILDREN: 40,
  /** 渲染边硬上限（按权重从高到低截断） */
  MAX_EDGES: 40,
  /** 扇出过滤（§4.3 第 4 招）：入边数超过此值的公共节点只保留 top FANOUT_KEEP 条入边 */
  MAX_FANOUT: 8,
  /** 扇出过滤保留条数 */
  FANOUT_KEEP: 5,
} as const;

/** 聚合节点固定 id（A3 渲染层据 aggregate:true 识别） */
export const MORE_NODE_ID = "__more__";

// ───────────────────── 垃圾目录清单（chat 工具与 A1 解析同一份，2026-09-19 定版） ─────────────────────

/** 通用垃圾目录段名：聊天工具（search_code / list_files 的清单收集）与 A1 静态解析（顶层模块收集）
 *  **共用这一份清单**——两处跳同一批目录，口径只此一处，不再各自维护（旧实现是 chatTools 的
 *  SEARCH_SKIP_DIRS 与 parse 的 IGNORED_SEGMENTS 两份）。收录范围：
 *  - 依赖垃圾（node_modules）与版本库（.git）；
 *  - 构建产物（dist/build/out/target）与覆盖率（coverage）；
 *  - 塔台自管目录（.工作台＝changes.jsonl 所在、.tatai＝全局数据目录）；
 *  - Python 侧缓存（__pycache__/.venv/venv/.pytest_cache/.mypy_cache/.ruff_cache）；
 *  - 前端框架缓存（.next/.nuxt/.turbo/.cache）；
 *  - H4 定版的高翻转/临时/缓存段（.tmp/tmp/temp/cache）：现场项目病根目录就在 .tmp
 *    （实测一棵子树 12 286 文件），watcher.ts/scanner.ts 的清单是本清单的子集、各自未动。
 *  注意：这是**通用**垃圾清单——_briefs/_legacy/logs 这类项目自管目录不在此列（要不要跳待主人拍板）。 */
export const JUNK_DIR_SEGMENTS: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  "dist",
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
  ".工作台",
  ".tatai",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  // H4 补：高翻转/临时/缓存类目录段（原 parse/scanner/watcher 清单里的既有段，合并保留）
  ".tmp",
  "tmp",
  "temp",
  "cache",
]);

/** 目录级垃圾判定（清单与 A1 解析、chat 搜索/列清单共用）：具名黑名单 + 构建元数据后缀（*.egg-info） */
export function isJunkDir(name: string): boolean {
  return JUNK_DIR_SEGMENTS.has(name) || name.endsWith(".egg-info");
}

/** A5 文件级「有变动」点的时间窗（DESIGN.md §4.2 文件级只标一个点）：近 N 小时 changes.jsonl 有记录即标 */
export const CHANGE_DOT_WINDOW_HOURS = 24;

/** 起名 Flash 调用参数（§12.1 未决项 #3：提示词与数值都记录成配置项） */
export const NAME_OPTIONS = {
  /** 采样温度：低温求稳，防名字跳变 */
  temperature: 0.3,
  /** 每模块喂给 Flash 的文件名抽样条数 */
  SAMPLE_FILES: 12,
  /** 单模块起名整体超时毫秒 */
  timeoutMs: 60_000,
} as const;

/** 模块分类枚举：Flash 顺带标的类型，A3 渲染层可据 data/docs 降权展示 */
export const MODULE_KINDS = ["code", "data", "docs", "mixed"] as const;
export type ModuleKind = (typeof MODULE_KINDS)[number];

/** 单模块起名输入（喂进提示词的全部素材） */
export interface NamePromptInput {
  /** 相对项目根路径（如 "src/arch"） */
  path: string;
  file_count: number;
  loc: number;
  /** 依赖邻居模块路径清单（出边方向） */
  deps: string[];
  /** 抽样文件名清单（最多 SAMPLE_FILES 条） */
  sample_files: string[];
}

/**
 * 起名提示词（未决项 #3 定版，2026-09-17）。
 * 红线（§4.1）：Flash 只做翻译——把路径名翻成人话名 + 一句话说明 + 分类；
 * 不做模块发现（模块清单是 tree-sitter 静态解析给的，提示词里明令禁止增删）。
 * 输出严格 JSON，便于确定性解析。
 */
export function buildNameMessages(input: NamePromptInput): { role: "system" | "user"; content: string }[] {
  const system = [
    "你是软件项目的「模块起名员」。给定一个已划分好的模块（顶层目录）的路径、规模与抽样文件名，",
    "把它翻译成中文人话名。你只负责翻译命名，不负责也不允许重新划分模块、增删模块。",
    "严格只输出一行 JSON，不要输出任何其他文字，格式：",
    '{"name":"中文人话名（2~8个字，如 架构图引擎）","blurb":"一句话说明这个模块干什么（≤30字）","kind":"code|data|docs|mixed"}',
    "kind 口径：code=源码模块；data=数据/日志/导入导出物目录；docs=文档资料目录；mixed=说不清或混合。",
  ].join("");
  const user = JSON.stringify({
    模块路径: input.path,
    文件数: input.file_count,
    代码行数: input.loc,
    它依赖的邻居模块: input.deps,
    抽样文件名: input.sample_files,
  });
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}
