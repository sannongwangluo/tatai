// P1：跨项目汇总口径定版（DESIGN.md §12.1 未决项 #5、§3.1 左栏「项目管理」、§3.10 实况口径）。
//
// 裁定一句话：**按「项目一行」是唯一的数据口径（Gate 不跨项目合并）；「按 Gate 步」只是同一批行的
// 分组渲染，不新增字段、不新读数据源。** 两者各自回答什么、什么时候用，见 SUMMARY_SCOPES。
//
// 为什么不做「一个总 Gate」：见 GATE_MERGE_RULE.reasons——Gate 是单项目的阶段状态机（§5.1 七步 /
// §5.2 三态），current_step 可跳步、可迭代回需求、可被打回；多个项目的 current_step 之间没有共同
// 时间轴，取最小/最大/众数都只是「选一个代表值」，不是总 Gate。更要命的是它会造出第二套 gate 语义，
// 与单项目实况（`src/server/live.ts` 的 gate 字段）分叉——那就是 §3.2「两套数据必然不同步」的同型错误。
//
// 与单项目实况的口径一致（不造第二套语义）是本卡的硬要求，落成三件事：
//   1) 行的 gate / task_counts 字段类型直接取 `LiveSnapshot` 的字段类型（见下方 type-only import），
//      形状一旦分叉 `pnpm typecheck` 直接红，不靠注释自觉；
//   2) last_activity_at 与 live.ts 的 last_event_at 同一算法（三源取最大、一律 Date.parse 成毫秒比）；
//   3) 缺文件（progress.json 不存在）不在这里另立合成口径，一律沿用实况层那一条（PROGRESS_ABSENT_RULE）。
//
// 红线：本文件是**纯口径模块**——零 React、零 HTTP 路由、零文件 IO、不落盘、不建目录。
// 服务端合成层（P2）负责读文件后调 summarizeProject；浏览器侧（P2 跨项目视图）直接 import 本文件的
// 常量与纯函数，前后端共用同一份排序键与字段定义（P2 DoD② 的「逐条对照」就对着这里，不许另写一份）。

import { GATE_STEPS, type ModuleRecord, type ModuleStatus, type Progress, type TaskRecord } from "./workstation";
import type { LiveSnapshot } from "./live";
import type { ProjectRecord } from "./registry";

// ───────────────────────────── 三个口径的适用范围（DoD① 落点） ─────────────────────────────

/** 汇总口径键：项目一行（数据口径）/ 按 Gate 步分桶（同一批行的分组渲染） */
export type SummaryScope = "PROJECT_ROW" | "GATE_STEP_GROUP";

export interface SummaryScopeSpec {
  key: SummaryScope;
  /** 显示名 */
  label: string;
  /** 这个口径回答的问题 */
  question: string;
  /** 数据单位 */
  unit: string;
  /** 适用场景（DoD① 明确要求写清） */
  when: string;
  /** 落地卡 */
  landed_in: string;
  /** 是否新增字段口径（并存 ≠ 两套口径的判据） */
  adds_field: boolean;
  /** 是否新增数据源 */
  adds_data_source: boolean;
}

/** 并存的两种口径（第三种「合并成总 Gate」见 GATE_MERGE_RULE，明确不做） */
export const SUMMARY_SCOPES: Readonly<Record<SummaryScope, SummaryScopeSpec>> = {
  PROJECT_ROW: {
    key: "PROJECT_ROW",
    label: "按项目一行",
    question: "一屏里每个项目各是什么状况——谁卡住了、谁在动、谁刚有动静",
    unit: "项目（一个项目一行，行 = ProjectSummaryRow）",
    when: "日常巡检的第一视图（跨项目视图默认排列，也是 §3.1 左栏项目列表的单位）：先看有没有 blocked，再看谁在动、谁最近有动静；要追问某个项目就点进它的单项目 Tab（Gate 时间线 / 实况）。项目数 ≤ 十几个时一屏够看。",
    landed_in: "P2 跨项目视图",
    adds_field: false,
    adds_data_source: false,
  },
  GATE_STEP_GROUP: {
    key: "GATE_STEP_GROUP",
    label: "按 Gate 步分桶",
    question: "现在几个项目停在哪一步——同一步上有没有积压",
    unit: "Gate 步（把上面那批项目行按行的 gate.current_step 原值分桶）",
    when: "阶段盘点与推进时用（例如「今天要把三个项目都推到任务拆解步」）：看同一阶段上堆了几个项目、掉队的是哪个。**只是同一批行的分组渲染**——分组键取行里已有的 gate.current_step，不新增字段、不新读数据源、不产生第二种「当前步」。项目数多到一屏排不下、或想按阶段批量看时切到这个分组。",
    landed_in: "P2 跨项目视图（可选分组）",
    adds_field: false,
    adds_data_source: false,
  },
};

/** 口径单位常量：数据口径的唯一行单位（U1/后续卡要指向「同一条口径」时引用它） */
export const SUMMARY_UNIT = "one_row_per_project" as const;

// ─────────────────────────── 多项目 Gate 不合并的理由（DoD 落点） ───────────────────────────

/**
 * 跨项目 Gate 合并裁定：**不做**。不是「暂缓」——是没有可解释的运算，做了就是错。
 * 「一步棋」式的需求由 GATE_STEP_GROUP 分组满足：分组保留每个项目的身份（谁在哪一步），
 * 合并丢掉身份只剩一个数。合计数还会掩盖异常：五个项目里一个红，总步数照样显示「平均在开发步」。
 */
export const GATE_MERGE_RULE = {
  /** 合并口径：无 */
  merged: false,
  /** Gate 数据的单位：永远跟着项目走 */
  unit: "per_project",
  /** 合并会分叉的对象：单项目实况的 gate 字段（同一份 progress.json 的第二种读法） */
  conflicts_with: "src/server/live.ts#getLive → gate",
  /** 替代方案：一步棋的需求走分组，不走合并 */
  alternative: "GATE_STEP_GROUP",
  reasons: [
    // ① 无共同时间轴：Gate 是单项目阶段状态机（§5.1/§5.2），不是全局进度条
    "Gate 是单项目的阶段状态机（§5.1 七步 + §5.2 三态），current_step 可跳步、可迭代回需求步、可被打回；多个项目的 current_step 之间没有共同时间轴，取 min/max/众数都只是「选一个代表值」，不是总 Gate——项目一改步，总数就变，用户读到的不是项目状态而是噪音。",
    // ② 造第二套语义：与单项目实况分叉，违反「不造第二套语义」的红线
    "「总 Gate」在 live.ts 里没有对应物，落地必须另写一套推导：跨项目视图显示的总数与单项目 Tab 显示的当前步对不上，用户就得开始怀疑哪个是真的（§3.2「两套数据必然不同步」的同型错误）。",
    // ③ 需求不匹配：用户要的是「哪架飞机有问题」，不是「平均进度」
    "唯一用户价值是「哪架飞机有问题」（§1.1「看得见项目全貌」），价值来自异常可见（blocked / 静止 / 掉队）——这靠「每项目一行 + 异常优先排序」就能给；一个合计数反而把异常平均掉。",
    // ④ 合并丢信息，分组不丢
    "真要「一步棋」的总览，正确做法是分组而不是合并：分组保留每个项目的身份与状态（谁在哪一步、几个堆在同一步），合并只剩一个数。",
  ],
} as const;

// ───────────────────────────────── 行的字段口径 ─────────────────────────────────

/** 行的 Gate 字段：**逐字段等同** live.ts 的 gate（type-only 取形，编译期强制同形） */
export type GateSummary = LiveSnapshot["gate"];

/** 行的任务计数：**逐字段等同** live.ts 的 task_counts（同上） */
export type TaskStatusCounts = LiveSnapshot["task_counts"];

/** 模块四色计数（§4.2 模块级四色 + total；模块明细不进行） */
export interface ModuleStatusCounts {
  todo: number;
  doing: number;
  done: number;
  issue: number;
  total: number;
}

/** 项目级最严重色：四色里按严重度取「最靠前的一个」；无模块 → null（不是灰，是「没有数据」） */
export type ProjectSeverity = ModuleStatus | null;

/**
 * 严重度顺序（severityOf 的唯一依据）：红 > 黄 > 灰 > 绿。
 * 红 = 有问题（必须有人出手）；黄 = 在动；灰 = 没开始且没信号；绿 = 完成。
 * 这是 P1 **新增的项目级归约**（§4.2 只定义了模块级四色，§3.1 只说了左栏有「状态点」没定色）。
 * 只用于展示取色与读数的第一眼，**不参与 SORT_RULE**（排序键只认 blocked/doing/最近活动）。
 */
export const SEVERITY_ORDER: readonly ModuleStatus[] = ["issue", "doing", "todo", "done"];

export interface RowFieldSpec {
  /** 行上的字段名（ProjectSummaryRow 的键，点号表示嵌套） */
  field: string;
  /** 这个字段回答什么 */
  meaning: string;
  /** 数据来源 */
  source: string;
  /** 口径（怎么算出来的） */
  rule: string;
  /** 是否参与排序键 */
  in_sort_key: boolean;
}

/** 行的字段定义表（P2 逐字段对着它填，不许加未登记的字段） */
export const ROW_FIELDS: readonly RowFieldSpec[] = [
  {
    field: "project_id / name / kind / self_managed",
    meaning: "这一行是谁",
    source: "全局注册表 registry.json（§2.3.1）",
    rule: "原样直取，不做加工；kind 供「页面预览 Tab 有无」等既有判定复用（§3.2）",
    in_sort_key: false,
  },
  {
    field: "gate.current_step / gate.step_name / gate.result",
    meaning: "Gate 当前步与三态（三态 = pending/pass/reject）",
    source: "progress.json 的 gate（§2.3.2）",
    rule: "与 live.ts 的 gate **逐字段同一口径**：current_step 直取 progress.gate.current_step；step_name 查 GATE_STEPS（取不到就回落原 id）；result 取 gate.history 里该步那一条的 result，查不到按 pending。progress.json 不存在时按 PROGRESS_ABSENT_RULE 走初始态（第一步 + pending）",
    in_sort_key: false,
  },
  {
    field: "module_status_counts",
    meaning: "模块四色各有几个（灰/黄/绿/红 + total）",
    source: "progress.json 的 modules[].status",
    rule: "计数，不重算：模块状态已是 §5.3 任务→模块汇总的产物（`workstation.ts#rollupModuleStatus` 落盘），这里重算一遍就是第二套语义。modules 为空 → 五项全 0",
    in_sort_key: false,
  },
  {
    field: "severity",
    meaning: "项目级最严重色（左栏状态点的取色依据）",
    source: "由 module_status_counts 归约（本卡新增，见 SEVERITY_ORDER）",
    rule: "按 SEVERITY_ORDER 取第一个出现过的色；无模块 → null。空项目（0 模块）不冒充灰",
    in_sort_key: false,
  },
  {
    field: "task_counts",
    meaning: "任务四态各几个（todo/doing/done/blocked）",
    source: "v2 事件投影（.工作台/work/events.jsonl；未迁移项目退回 tasks.json，§2.6）",
    rule: "与 live.ts 的 task_counts **同口径**：对全量任务按 status 计数。保留它的理由：模块汇总会漏掉「module_id 为空 / 模块未登记」的任务（§5.3 汇总跳过这两类），而「有没有 agent 在干活 / 有没有卡住」必须直接看任务",
    in_sort_key: true,
  },
  {
    field: "last_activity_at",
    meaning: "最近活动时间（行里唯一的活跃度字段）",
    source: "三个源的尾值：changes.jsonl 最后一行 ts / gate.jsonl 最后一行 ts / tasks.json 最大 updated_at",
    rule: "三源取最大，比较一律 Date.parse 成毫秒（本地 ISO 带偏移直接字符串比会跨时区比错，H2 踩过）。与 live.ts 的 last_event_at 等值——那边是三源合并后取 top-1，且 changes 只读最新 50 条，最大值必在窗口内。三源全空 → null",
    in_sort_key: true,
  },
];

/** 明确不进行的字段及理由（防止 P2 顺手把行撑宽、或把 live 的展示逻辑抄一份） */
export const ROW_EXCLUDED_FIELDS: readonly { field: string; reason: string }[] = [
  {
    field: "stage（「开发进行中」那类大字文案）",
    reason: "那是单项目实况的展示层推导（live.ts#deriveStage，按「Gate 步 + 有无 doing 任务」拼文案），不是结构化字段。行位窄也放不下；P2 若要显示，必须由单项目 /live 提供（或另立卡把推导抽成共用函数），不许在跨项目视图里再推一遍",
  },
  {
    field: "current_task（当前 doing 任务）",
    reason: "行位窄，且「最近在干什么」是点进单项目实况才要看的信息（§3.10）",
  },
  {
    field: "last_change_at / last_task_report_at（M3 activity 的两分口径）",
    reason: "M3 的「改了文件没汇报」对照是单项目视图的眼睛（§12.2 风险 4），行里只保留合并后的 last_activity_at；要用两分口径就调 M3 同一份实现（GET /api/projects/:id/activity），不在这里再算一遍",
  },
  {
    field: "path / registry.last_opened_at / gate.history 全量 / modules 明细",
    reason: "path 与 last_opened_at 不参与排行的「要不要我出手」，进了只会诱导另立排序；history 与 modules 明细属单项目页（Gate 时间线 / 架构图），行只带汇总",
  },
];

// ───────────────────────────────── 排序口径 ─────────────────────────────────

/**
 * 排序桶（升序）：只回答「要不要我出手」和「还活着吗」两个问题。
 * 依据：blocked 是任务四态里唯一硬信号（agent 明说被卡住）；doing 次之（有人在动，等就行）；
 * 其余（全 todo / 全 done）都不需要出手，靠最近活动时间区分鲜陈。
 */
export const SORT_BUCKETS = [
  { order: 0, label: "有卡住的", when: "task_counts.blocked > 0" },
  { order: 1, label: "在做的", when: "blocked === 0 且 doing > 0" },
  { order: 2, label: "静止的", when: "blocked === 0 且 doing === 0" },
] as const;

/** 排序键（照此顺序施加，全部可执行；compareProjectRows 是唯一实现） */
export const SORT_RULE = {
  /** 三级键，顺序换不得 */
  key_order: [
    "sort_bucket_asc（0 有卡住的 > 1 在做的 > 2 静止的）",
    "last_activity_desc（Date.parse 毫秒比较，null 排最后）",
    "project_id_asc（同分兜底，保证稳定序、刷新不跳动）",
  ],
  /** 最后一级兜底 */
  tie_breaker: "project_id 字典序升序",
  /** 明确不进排序键的字段 */
  not_in_key: ["gate.result", "severity", "registry.last_opened_at", "kind"],
  not_in_key_reason:
    "Gate 三态不进键：打回/过关本身就是「刚有人操作过」，已体现在 last_activity_at 上，重复计入等于同一事实计两次，还会让列表因验收动作整列跳动。severity 不进键：它是四色的展示归约，排序键只认任务态（blocked/doing）+ 活跃度，两个键混用会出现「红但已完工」压住「黄但在动」的怪序。last_opened_at 不进键：那是「人点开过没」不是「项目动了没」。kind 与排行无关。",
} as const;

/**
 * 排序桶：0 = 有 blocked（唯一需要人立刻出手的硬信号）；1 = 有 doing；2 = 其余。
 * @param row 汇总行
 */
export function sortBucketOf(row: ProjectSummaryRow): number {
  if (row.task_counts.blocked > 0) return 0;
  if (row.task_counts.doing > 0) return 1;
  return 2;
}

/** 时间字符串 → 毫秒；空值/解析失败一律 null（并按「无活动」排最后） */
function parseMs(ts: string | null): number | null {
  if (ts === null || ts === "") return null;
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? null : ms;
}

/** 三源取最大活动时间（返回入选的那个原字符串；并列取先出现者；全空 → null） */
export function latestActivityAt(times: readonly (string | null)[]): string | null {
  let best: string | null = null;
  let bestMs: number | null = null;
  for (const ts of times) {
    const ms = parseMs(ts);
    if (ms === null) continue;
    if (bestMs === null || ms > bestMs) {
      bestMs = ms;
      best = ts;
    }
  }
  return best;
}

/** 排序比较器（SORT_RULE 的唯一实现）：桶升序 → 最近活动倒序 → project_id 升序 */
export function compareProjectRows(a: ProjectSummaryRow, b: ProjectSummaryRow): number {
  const bucket = sortBucketOf(a) - sortBucketOf(b);
  if (bucket !== 0) return bucket;
  const ta = parseMs(a.last_activity_at);
  const tb = parseMs(b.last_activity_at);
  if (ta !== tb) {
    if (ta === null) return 1; // 无活动排最后
    if (tb === null) return -1;
    return tb - ta; // 最近活动倒序
  }
  return a.project_id < b.project_id ? -1 : a.project_id > b.project_id ? 1 : 0;
}

/** 排序（不改入参；调用方拿返回值渲染） */
export function sortProjectRows(rows: readonly ProjectSummaryRow[]): ProjectSummaryRow[] {
  return [...rows].sort(compareProjectRows);
}

// ───────────────────────────── 汇总函数与结构 ─────────────────────────────

/**
 * 缺文件口径登记：progress.json 不存在时按「七步全 pending、current_step = 第一步」的初始态合成读取。
 * **不在本文件另立一套合成**——P2 落地时把 `src/server/live.ts#readProgressReadonly` 的同一口径复用
 * （该函数当前未导出，导出属 P2 卡的一行改动；本卡不擅自动 V1 已定版文件，故此处只登记出处）。
 */
export const PROGRESS_ABSENT_RULE = "src/server/live.ts#readProgressReadonly" as const;

/** 汇总一行的输入（服务端合成层读文件后按此结构喂进来；本层不碰文件系统） */
export interface ProjectSummaryInput {
  /** 注册表记录（§2.3.1；只用到 id/name/kind，self_managed 可选） */
  project: Pick<ProjectRecord, "id" | "name" | "kind"> & { self_managed?: boolean };
  /** progress.json 内容（gate + modules）；缺文件按 PROGRESS_ABSENT_RULE 合成后再传 */
  progress: Pick<Progress, "gate" | "modules">;
  /** tasks.json 的任务列表（§2.3.4） */
  tasks: readonly TaskRecord[];
  /** gate.jsonl 最后一行的时间；无文件/无行 → null */
  latest_gate_ts: string | null;
  /** changes.jsonl 最后一行的时间；无文件/无行 → null */
  latest_change_ts: string | null;
}

/** 跨项目视图的一行（数据口径的唯一单位，字段定义见 ROW_FIELDS） */
export interface ProjectSummaryRow {
  project_id: string;
  name: string;
  kind: ProjectRecord["kind"];
  self_managed: boolean;
  gate: GateSummary;
  module_status_counts: ModuleStatusCounts;
  severity: ProjectSeverity;
  task_counts: TaskStatusCounts;
  last_activity_at: string | null;
}

/** 模块四色计数（不重算状态，只数 progress.json 里已有的值） */
export function countModuleStatuses(modules: readonly ModuleRecord[]): ModuleStatusCounts {
  const counts: ModuleStatusCounts = { todo: 0, doing: 0, done: 0, issue: 0, total: modules.length };
  for (const m of modules) counts[m.status]++;
  return counts;
}

/** 项目级最严重色：按 SEVERITY_ORDER 取第一个出现过的；无模块 → null */
export function severityOf(modules: readonly ModuleRecord[]): ProjectSeverity {
  const present = new Set(modules.map((m) => m.status));
  for (const s of SEVERITY_ORDER) if (present.has(s)) return s;
  return null;
}

/** 任务四态计数（与 live.ts 的 task_counts 同口径） */
export function countTaskStatuses(tasks: readonly TaskRecord[]): TaskStatusCounts {
  const counts: TaskStatusCounts = { todo: 0, doing: 0, done: 0, blocked: 0 };
  for (const t of tasks) counts[t.status]++;
  return counts;
}

/** Gate 当前步 + 三态（与 live.ts 的 gate 同口径：history 查不到 → pending） */
export function gateSummaryOf(progress: Pick<Progress, "gate">): GateSummary {
  const current = progress.gate.current_step;
  const entry = progress.gate.history.find((h) => h.step === current);
  const name = GATE_STEPS.find((s) => s.id === current)?.name ?? current;
  return { current_step: current, step_name: name, result: entry?.result ?? "pending" };
}

/** 汇总一个项目为一行（纯函数：只读入参，不排序） */
export function summarizeProject(input: ProjectSummaryInput): ProjectSummaryRow {
  const modules = input.progress.modules;
  return {
    project_id: input.project.id,
    name: input.project.name,
    kind: input.project.kind,
    self_managed: input.project.self_managed === true,
    gate: gateSummaryOf(input.progress),
    module_status_counts: countModuleStatuses(modules),
    severity: severityOf(modules),
    task_counts: countTaskStatuses(input.tasks),
    last_activity_at: latestActivityAt([
      input.latest_change_ts,
      input.latest_gate_ts,
      ...input.tasks.map((t) => t.updated_at),
    ]),
  };
}

/** 汇总多个项目并按 SORT_RULE 排好序（跨项目视图直接渲染这个返回值） */
export function summarizeProjects(inputs: readonly ProjectSummaryInput[]): ProjectSummaryRow[] {
  return sortProjectRows(inputs.map(summarizeProject));
}

// ─────────────────────── 按 Gate 步分桶（分组渲染，不是第二套数据） ───────────────────────

export interface GateStepGroup {
  step: string;
  step_name: string;
  /** GATE_STEPS 的声明顺序（§5.1 七步）；落在表外的 step 兜底排在末尾 */
  order: number;
  /** 停在这一步的项目行（**同一批行对象**，不拷贝、不新增字段、不重排） */
  rows: ProjectSummaryRow[];
}

/**
 * 把项目行按 gate.current_step 分桶（GATE_STEP_GROUP 口径的唯一实现）。
 * 分组键取行里已有的 gate.current_step 原值，因此不新增字段、不新读数据源；
 * 组内保持传入顺序（传 sortProjectRows 的结果就得到「同一步里有卡住的排前面」）。
 * @param rows 项目行（通常先过 sortProjectRows）
 * @param includeEmptySteps 是否保留没人停留的步（阶段盘点想看到「0 个项目的步」时传 true）
 */
export function groupRowsByGateStep(
  rows: readonly ProjectSummaryRow[],
  includeEmptySteps = false,
): GateStepGroup[] {
  const groups = new Map<string, GateStepGroup>();
  if (includeEmptySteps) {
    GATE_STEPS.forEach((s, order) => {
      groups.set(s.id, { step: s.id, step_name: s.name, order, rows: [] });
    });
  }
  for (const row of rows) {
    const step = row.gate.current_step;
    let g = groups.get(step);
    if (!g) {
      // 表外 step 兜底：progress.json 的校验层已限定 step 必在 GATE_STEPS 内（workstation#validateProgress），
      // 此处只为结构完整，不假设不会有怪值
      const idx = GATE_STEPS.findIndex((s) => s.id === step);
      g = {
        step,
        step_name: idx >= 0 ? GATE_STEPS[idx].name : step,
        order: idx >= 0 ? idx : GATE_STEPS.length,
        rows: [],
      };
      groups.set(step, g);
    }
    g.rows.push(row);
  }
  return [...groups.values()].sort((a, b) => a.order - b.order);
}

// ─────────────────────── 与单项目实况的口径对照（P2 DoD② 的对照表） ───────────────────────

/**
 * 汇总字段 ↔ 单项目实况字段的对照表：P2 落地时逐条核对，并在 P2 的流水里贴核对结果。
 * 值为单项目侧的对应物；括注说明差异（差异必须为零，或写明理由）。
 */
export const LIVE_CONSISTENCY_MAP = {
  "gate.current_step": "live.gate.current_step（同一 progress.json 同一字段）",
  "gate.step_name": "live.gate.step_name（两侧同查 GATE_STEPS，取不到同回落原 id）",
  "gate.result": "live.gate.result（同取 history[current_step].result，查不到同按 pending）",
  "task_counts.todo/doing/done/blocked": "live.task_counts.*（V08-01 起同为 v2 事件投影按兼容四态计数，类型同形）",
  "last_activity_at": "live.last_event_at（同算法：changes 尾行 + gate 尾行 + tasks 最大 updated_at 取最大，同 Date.parse 成毫秒比较）",
  "module_status_counts": "（live 无对应物：实况给的是项目级 stage/actor，模块四色只出现在架构图与 Gate 视图；本行直接数 progress.json 的 modules[].status，不重算）",
  "severity": "（live 无对应物：本卡新增的项目级归约，SEVERITY_ORDER 是唯一依据，已登记 DESIGN.md 附录 B 待议）",
  "actor / stage / current_task / events": "（不进汇总行：分属单项目实况的展示层，见 ROW_EXCLUDED_FIELDS）",
} as const;
