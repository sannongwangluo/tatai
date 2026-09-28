import fs from "node:fs";
import path from "node:path";
import { appendJsonlLine, warnCorruptLinesThrottled } from "./lineStream";
import { withFileLock } from "./fileLock";
import { getProject } from "./registry";
import { nowIso } from "./time";
// V06-02：`.工作台/` 目录名与两份图纸的**唯一当前源**解析（含登记路径与越界拒绝）都收在 work/documents.ts，
// 本层只接上入口——设计书的读写路径口径仍在这里（readDesign/appendDesign/appendDiscuss 都走 designPath）。
import { WORKBENCH_DIRNAME, resolveDocumentSource } from "./work/documents";
// V06-03：v1 写口的"新格式拒写"闸门与兼容投影读口。判据/文案都收在 work/tasks.ts（leaf 模块），
// 本层只调用——这样 workstation ↔ work/tasks 不成环，也不会把 v2 逻辑塞进这个数据层。
import { readCompatTasksProjection, readTaskStates, v1TaskWriteGate, v1StatusOf, TASK_STATUS_LABELS, type TaskExecutionStatus } from "./work/tasks";
// V06-02 构建回归修复（2026-09-20）：GATE_STEPS 的**常量本体**挪到浏览器安全的 `src/shared/gateSteps.ts`
// （UI 的 DesignView/GateTimeline 需要它的值，而本模块的依赖链 work/documents → node:child_process
// 进不了浏览器包）。这里只做再导出与自用 import，形状/取值与既有导入点全不变。
import { GATE_STEPS, type GateStep } from "../shared/gateSteps";

// 工作台数据读写层（G1）：单一模块管各项目 `.工作台/` 下的 progress.json / gate.jsonl / tasks.json。
// M2 的 MCP 工具（read_progress / update_progress / report_task_status / list_tasks）直接复用本层，
// 全仓不许出现第二套存储（PLAN.md G1 DoD⑤）。
//
// 路径安全红线：本层所有公开函数只接受项目 id，项目根路径一律从注册表取（registry.getProject），
// 不接受前端/调用方直接传路径——防止越权读写任意目录。

// ── 七步生命周期（DESIGN.md §5.1）：常量本体在 `src/shared/gateSteps.ts`，此处原样再导出 ──
// 再导出的理由：GATE_STEPS/GateStep 是服务端各层与 G1/G2/G3/L3/P2 脚本既有的公开导入点，
// 换位置但不换身份——`import { GATE_STEPS } from "./workstation"` 照旧拿到同一个绑定。
export { GATE_STEPS, type GateStep } from "../shared/gateSteps";

const GATE_STEP_IDS: readonly string[] = GATE_STEPS.map((s) => s.id);

/** Gate 单步结果三值（DESIGN.md §2.3.2） */
export type GateStepResult = "pass" | "reject" | "pending";
export const GATE_STEP_RESULTS: readonly GateStepResult[] = [
  "pass",
  "reject",
  "pending",
];

/** 模块状态四值（DESIGN.md §2.3.2 四色表，架构图着色直接读这里） */
export type ModuleStatus = "todo" | "doing" | "done" | "issue";
export const MODULE_STATUSES: readonly ModuleStatus[] = [
  "todo",
  "doing",
  "done",
  "issue",
];

/** 任务状态四值（DESIGN.md §5.3，agent 经 MCP 自报） */
export type TaskStatus = "todo" | "doing" | "done" | "blocked";
export const TASK_STATUSES: readonly TaskStatus[] = [
  "todo",
  "doing",
  "done",
  "blocked",
];

/** progress.json 结构（DESIGN.md §2.3.2） */
export interface GateHistoryEntry {
  step: string;
  result: GateStepResult;
  at: string | null;
  note: string | null;
}

export interface ModuleRecord {
  id: string;
  name: string;
  status: ModuleStatus;
}

export interface Progress {
  version: 1;
  gate: {
    current_step: string;
    history: GateHistoryEntry[];
  };
  modules: ModuleRecord[];
}

/** gate.jsonl 一行（DESIGN.md §2.3.3） */
export interface GateLine {
  ts: string;
  step: string;
  result: "pass" | "reject";
  by: string;
  note: string | null;
}

/** tasks.json 结构（DESIGN.md §2.3.4） */
export interface TaskRecord {
  id: string;
  title: string;
  module_id: string;
  status: TaskStatus;
  reporter: string;
  updated_at: string;
  /** 可选备注（2026-09-19 主人拍板：report_task_status 的 note 落盘留痕；缺省不写、再报不传保留旧值） */
  note?: string;
}

export interface TasksFile {
  version: 1;
  tasks: TaskRecord[];
  /**
   * V06-03：v2 兼容投影标记（值为 `work/events.jsonl`）。存在即表示这份台账是**派生投影**，
   * 事实在 `.工作台/work/events.jsonl`；v1 写口据此拒写，不静默按 v1 覆盖。
   */
  projection_of?: string;
  /** 投影覆盖到的提交序号（可重建的派生位） */
  last_seq?: number;
}

/** 结构化错误：HTTP 层按 code 映射状态码，不抛裸栈 */
export class WsError extends Error {
  code:
    | "PROJECT_NOT_FOUND"
    | "PROGRESS_INVALID"
    | "INVALID_STEP"
    | "INVALID_RESULT"
    | "INVALID_MODULE_STATUS"
    | "MODULE_NOT_FOUND"
    | "MODULE_EXISTS"
    | "INVALID_TASK_STATUS"
    | "TASK_NOT_FOUND"
    | "TASK_EXISTS"
    | "NOT_CURRENT_STEP"
    | "GATE_JSONL_CORRUPT"
    | "SESSION_NOT_FOUND"
    | "CHAT_JSONL_CORRUPT"
    | "CHANGES_JSONL_CORRUPT"
    // H4：同时在听的项目数达上限（防"打开一堆项目"把服务拖住）
    | "WATCH_LIMIT_REACHED"
    // E1：一个项目的终端会话数达上限（多终端分屏防"开一堆终端"把宿主机拖住）
    | "SESSION_LIMIT_REACHED"
    // Q26：目标文件在"读—写"之间被外部进程/编辑器改过，塔台不覆盖别人的改动
    | "CONFLICT"
    // Q63：全局 agents.json 损坏（读侧报可操作错误、写侧留档重建）
    | "AGENTS_JSON_CORRUPT"
    // Q64：待读改写的文本不是 UTF-8（UTF-16/二进制）——拒绝，不猜编码、不动文件
    | "TEXT_ENCODING_UNSUPPORTED"
    // 2026-09-19 试用增强三期：架构图聊天补全层 supplement.json 损坏（读侧可操作报错：
    // 让聊天 replace 重写或删文件；渲染路径吞掉它照常出解析层全量）
    | "ARCH_SUPPLEMENT_CORRUPT"
    // 2026-09-20 批2 T11（DESIGN §3.2 / 判词 R1-ZS-003）：replace 要移除的补全概念仍被引用
    // （还有效补全边、聊天动作回执或变更记录指向它）——拒绝整次写入，正式删除须走变更记录路径
    | "ARCH_SUPPLEMENT_REFERENCED"
    // 同卡：被引用核对的引用源（chat-actions.jsonl / chat-changes.jsonl）读不动或非法 JSON——
    // fail-closed，不按"无引用"放行
    | "ARCH_SUPPLEMENT_REF_UNREADABLE"
    | "INVALID_INPUT"
    // V06-03：项目已迁移到 v2 事实，旧写工具缺版本/认领参数——拒绝绕写，返回升级要求
    | "WRITE_UPGRADE_REQUIRED";
  constructor(code: WsError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

const WORKBENCH_DIR = WORKBENCH_DIRNAME;
const PROGRESS_FILE = "progress.json";
const GATE_JSONL_FILE = "gate.jsonl";
const TASKS_FILE = "tasks.json";
const DISCUSS_FILE = "design.discuss.md";
/** 塔台自身例外：待议记录本体 = repo 根 DESIGN.md 附录 B（自举例外，无 .工作台 副本，AGENTS.md §4） */
const TATAI_APPENDIX_B_HEADING = "## 附录 B：待议记录";
/** 附录 B 空态占位符：首条待议追加时替换占位（这是唯一被允许的"替换"，其余一律纯追加） */
const APPENDIX_B_PLACEHOLDER = "_（暂无）_";

/** 项目 id → `<项目根>/.工作台/`；项目不在注册表时抛 PROJECT_NOT_FOUND（路径只走注册表） */
export function workstationDir(projectId: string, dataDir?: string): string {
  const project = getProject(projectId, dataDir);
  if (!project) {
    throw new WsError("PROJECT_NOT_FOUND", `项目不存在: ${projectId}`);
  }
  return path.join(project.path, WORKBENCH_DIR);
}

/**
 * 项目 v2 事实目录 `<项目根>/.工作台/work/`（PLAN.md V06-01，DESIGN.md §2.6）。
 * 事件文件与快照都在这里：`events.jsonl` 是唯一事实源，`state.json` 是可重建投影。
 * 与 workstationDir 同一红线：路径只走注册表，不接受调用方传路径。
 */
export function projectWorkDir(projectId: string, dataDir?: string): string {
  return path.join(workstationDir(projectId, dataDir), "work");
}

function progressPath(projectId: string, dataDir?: string): string {
  return path.join(workstationDir(projectId, dataDir), PROGRESS_FILE);
}

function gateJsonlPath(projectId: string, dataDir?: string): string {
  return path.join(workstationDir(projectId, dataDir), GATE_JSONL_FILE);
}

function tasksPath(projectId: string, dataDir?: string): string {
  return path.join(workstationDir(projectId, dataDir), TASKS_FILE);
}

/** 原子写 JSON：先写临时文件再 rename，防半截文件（与 registry.writeRegistry 同惯例） */
function writeJsonAtomic(file: string, data: unknown): void {
  writeTextAtomic(file, JSON.stringify(data, null, 2) + "\n");
}

/**
 * 读"要追加写回的文本"（Q64，2026-09-18 审计）。
 *
 * 为什么：design.md / DESIGN.md / design.discuss.md / 项目 AGENTS.md 都是**外部也会改**的文本文件，
 * 此前一律 `fs.readFileSync(file, "utf8")`。UTF-16LE（记事本"Unicode"存法、PowerShell 5.1 的
 * `Out-File` 默认）被按 UTF-8 解成乱码（ASCII 字节后面跟一个 NUL），再"读全文 → 追加 → 整份写回"
 * 就把用户文件**不可逆地毁掉**；写后的"原文前缀逐字节还在"断言也拦不住——断言两侧都是同一份解码后
 * 的字符串，乱码自洽。
 *
 * 口径（不猜、不改）：只认 UTF-8 文本；三条廉价检查任一不过就**拒绝写入并说清怎么办**，
 * 一个字都不动那个文件。UTF-8 BOM 仍然按既有行为原样保留（解码出来的字符串带 U+FEFF，写回即还原）。
 *
 * 残留：真正会被"记事本 Unicode / Out-File 默认"产出 UTF-16LE 的是被纳管项目里用户手写的文件
 * （AGENTS.md 最典型）；塔台自建的 design.md / design.discuss.md 是 UTF-8，只有手改才触发。
 */
const ENCODING_PROBE_BYTES = 8192;

export function readTextForAppend(file: string, what: string): string {
  const buf = fs.readFileSync(file);
  const b0 = buf[0];
  const b1 = buf[1];
  if ((b0 === 0xff && b1 === 0xfe) || (b0 === 0xfe && b1 === 0xff)) {
    throw new WsError(
      "TEXT_ENCODING_UNSUPPORTED",
      `${what} 是 UTF-16 编码（带 BOM）：塔台只按 UTF-8 追加，硬读会把整个文件变成乱码且不可逆。` +
        "请先用编辑器转成 UTF-8（记事本「另存为」→ 编码选 UTF-8）再重试",
    );
  }
  const head = buf.subarray(0, Math.min(buf.length, ENCODING_PROBE_BYTES));
  if (head.includes(0)) {
    throw new WsError(
      "TEXT_ENCODING_UNSUPPORTED",
      `${what} 不像 UTF-8 文本（前 ${ENCODING_PROBE_BYTES} 字节里出现 NUL，典型的 UTF-16 无 BOM 或二进制文件）：` +
        "塔台不猜编码、不动这个文件，请先转成 UTF-8 再重试",
    );
  }
  const text = buf.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(buf)) {
    throw new WsError(
      "TEXT_ENCODING_UNSUPPORTED",
      `${what} 不是合法 UTF-8（解码再编码不能还原原字节）：塔台不猜编码、不动这个文件，请先转成 UTF-8 再重试`,
    );
  }
  return text;
}

/**
 * 外部改写检测（Q26，2026-09-18 审计）：写回**之前**复核磁盘上的文件还是不是"我们读到的那一份"。
 *
 * 此前"读全文 → 改 → 整份 rename 写回"没有任何前置比对：外部编辑器（用户手改 design.md /
 * design.discuss.md / 项目 AGENTS.md）落在「读之后、rename 之前」时，写回会把外部编辑**静默吞掉**
 * ——而且写在之后的"原文前缀逐字节还在"断言**必然通过**（newText 本来就是拿旧 oldText 拼的），
 * 连报错都没有。现在把比对移到写之前：磁盘 ≠ 读到的原文 → 抛 CONFLICT，一个字都不写。
 *
 * `expected`：`null` = 读的时候文件**还不存在**（本次是新建）；字符串 = 当时读到的全文。
 * 残留窗口（如实记）：比对与 renameSync 之间仍有微秒级间隙——外部编辑器不是塔台进程、不会来抢锁，
 * 所以这是"把静默覆盖变成会报错"，不是数学意义上的无窗口。
 */
function assertNoExternalEdit(file: string, expected: string | null, what: string): void {
  const onDisk = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  if (onDisk !== expected) {
    throw new WsError(
      "CONFLICT",
      `${what} 在本次读取之后被别的进程/编辑器改过，塔台不覆盖别人的改动：请重新读取后再提交`,
    );
  }
}

/** 原子写文本：先写临时文件再 rename（与 writeJsonAtomic 同一惯例）
 *  `expectOnDisk` 见 assertNoExternalEdit：给了就先复核磁盘现状再落盘（Q26） */
function writeTextAtomic(file: string, text: string, expectOnDisk?: string | null): void {
  if (expectOnDisk !== undefined) assertNoExternalEdit(file, expectOnDisk, path.basename(file));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, file);
}

// ── progress.json（DESIGN.md §2.3.2）──

function initialProgress(): Progress {
  return {
    version: 1,
    gate: {
      // current_step 指向七步第一步；history 七步全 pending
      current_step: GATE_STEPS[0].id,
      history: GATE_STEPS.map((s) => ({
        step: s.id,
        result: "pending",
        at: null,
        note: null,
      })),
    },
    modules: [],
  };
}

function assertStep(step: string): void {
  if (!GATE_STEP_IDS.includes(step)) {
    throw new WsError(
      "INVALID_STEP",
      `非法 step: ${JSON.stringify(step)}，只接受 ${GATE_STEP_IDS.join("/")}`,
    );
  }
}

function assertGateResult(result: string): asserts result is GateStepResult {
  if (!GATE_STEP_RESULTS.includes(result as GateStepResult)) {
    throw new WsError(
      "INVALID_RESULT",
      `非法 gate result: ${JSON.stringify(result)}，只接受 ${GATE_STEP_RESULTS.join("/")}`,
    );
  }
}

function assertModuleStatus(status: string): asserts status is ModuleStatus {
  if (!MODULE_STATUSES.includes(status as ModuleStatus)) {
    throw new WsError(
      "INVALID_MODULE_STATUS",
      `非法模块状态: ${JSON.stringify(status)}，只接受 ${MODULE_STATUSES.join("/")}（DESIGN.md §2.3.2）`,
    );
  }
}

function assertTaskStatus(status: string): asserts status is TaskStatus {
  if (!TASK_STATUSES.includes(status as TaskStatus)) {
    throw new WsError(
      "INVALID_TASK_STATUS",
      `非法任务状态: ${JSON.stringify(status)}，只接受 ${TASK_STATUSES.join("/")}（DESIGN.md §5.3）`,
    );
  }
}

const isStrOrNull = (v: unknown): v is string | null =>
  typeof v === "string" || v === null;

/** 严格校验 progress.json 结构（DESIGN.md §2.3.2）；不合法抛 PROGRESS_INVALID */
export function validateProgress(raw: unknown): Progress {
  const bad = (msg: string): never => {
    throw new WsError("PROGRESS_INVALID", `progress.json 结构不合法: ${msg}`);
  };
  if (typeof raw !== "object" || raw === null) bad("顶层必须是对象");
  const p = raw as Progress;
  if (p.version !== 1) bad(`不支持的 version: ${(p as { version?: unknown }).version}`);
  if (typeof p.gate !== "object" || p.gate === null) bad("缺 gate 对象");
  assertStep(p.gate.current_step);
  if (!Array.isArray(p.gate.history)) bad("gate.history 必须是数组");
  for (const h of p.gate.history) {
    if (typeof h !== "object" || h === null) bad("history 条目必须是对象");
    assertStep(h.step);
    assertGateResult(h.result);
    if (!isStrOrNull(h.at)) bad(`history[${h.step}].at 必须是字符串或 null`);
    if (!isStrOrNull(h.note)) bad(`history[${h.step}].note 必须是字符串或 null`);
  }
  if (!Array.isArray(p.modules)) bad("modules 必须是数组");
  for (const m of p.modules) {
    if (typeof m !== "object" || m === null) bad("modules 条目必须是对象");
    if (typeof m.id !== "string" || m.id === "") bad("modules 条目缺 id");
    if (typeof m.name !== "string" || m.name === "") bad(`模块 ${m.id} 缺 name`);
    assertModuleStatus(m.status);
  }
  return p;
}

/**
 * 初始化：项目没有 `.工作台/progress.json` 时建目录 + 写初始 progress.json
 * （current_step 指向七步第一步，history 七步全 pending）。幂等：已存在不覆盖。
 * 返回 true = 本次新建，false = 已存在。
 */
export function initWorkstation(projectId: string, dataDir?: string): boolean {
  const file = progressPath(projectId, dataDir);
  if (fs.existsSync(file)) return false;
  writeJsonAtomic(file, initialProgress());
  return true;
}

/** 读 progress.json 并校验结构；文件不存在时先初始化（幂等）再读 */
export function readProgress(projectId: string, dataDir?: string): Progress {
  initWorkstation(projectId, dataDir);
  const text = fs.readFileSync(progressPath(projectId, dataDir), "utf8");
  try {
    return validateProgress(JSON.parse(text));
  } catch (e) {
    if (e instanceof WsError) throw e;
    throw new WsError(
      "PROGRESS_INVALID",
      `progress.json 不是合法 JSON: ${(e as Error).message}`,
    );
  }
}

/**
 * 读 progress.json，并把"这次真的建了文件"如实报出来（S3 审计用）。
 *
 * 为什么要单开一个函数：`GET /progress` 是**读接口**，却会因为缺文件而落一份初始 progress.json——
 * 这是**服务端自己的副作用**，不是远程写请求（远程那边发的是 GET，被只读红线放行）。
 * PLAN S3 要求两者在审计里分开记（`actor: server-init` vs `actor: remote`），
 * 所以要把"建了没建"这个事实从本层如实带出来，而不是让调用方去猜或去 stat 第二遍。
 * 返回 `initialized` = 本次新建的文件名（项目内相对信息，不写本机绝对路径）。
 */
export function readProgressReportingInit(
  projectId: string,
  dataDir?: string,
): { progress: Progress; initialized: string[] } {
  const file = progressPath(projectId, dataDir);
  const initialized = fs.existsSync(file) ? [] : [path.basename(file)];
  return { progress: readProgress(projectId, dataDir), initialized };
}

function writeProgress(
  projectId: string,
  progress: Progress,
  dataDir?: string,
): void {
  writeJsonAtomic(progressPath(projectId, dataDir), progress);
}

/** 新增模块；id 已存在时报错，status 缺省 todo（非法四值报错）
 *  Q23：读—改—写进 progress.json 的跨进程锁（HTTP 侧与各 agent 的 MCP 进程同写这份文件）
 *  V06-03（2026-09-22 批外缺陷补齐）：与 `setModuleStatus` 挂**同款** v1 写闸门——此前只闸了"改四色"，
 *  "建模块"这条口子还留着，已迁移项目仍能经 `POST /projects/:id/modules` 往 progress.json 写 v1 事实，
 *  与 §2.6「模块状态区是兼容投影」及本文件 461 行的口径自相矛盾。未迁移项目行为逐字不变。 */
export function addModule(
  projectId: string,
  input: { id: string; name: string; status?: ModuleStatus },
  dataDir?: string,
): ModuleRecord {
  const status = input.status ?? "todo";
  assertModuleStatus(status);
  if (typeof input.id !== "string" || input.id.trim() === "") {
    throw new WsError("INVALID_INPUT", "模块 id 不能为空");
  }
  return withFileLock(progressPath(projectId, dataDir), () => {
    assertV1TaskWriteAllowed(projectId, dataDir, "addModule（新增模块台账）");
    const progress = readProgress(projectId, dataDir);
    if (progress.modules.some((m) => m.id === input.id)) {
      throw new WsError("MODULE_EXISTS", `模块 id 已存在: ${input.id}`);
    }
    const record: ModuleRecord = {
      id: input.id,
      name: (input.name ?? input.id).trim() || input.id,
      status,
    };
    progress.modules.push(record);
    writeProgress(projectId, progress, dataDir);
    return record;
  });
}

/** 更新模块状态；非法四值报错，模块不存在报错（Q23：读—改—写进 progress.json 跨进程锁）
 *  V06-03：已迁移项目拒写（旧写工具没有版本/认领参数，不能再靠 v1 路径改状态；见 work/tasks.ts）。
 *  闸门只读判据，对未迁移项目零副作用——`update_progress` 的既有行为逐字不变。 */
export function setModuleStatus(
  projectId: string,
  moduleId: string,
  status: ModuleStatus,
  dataDir?: string,
): Progress {
  assertModuleStatus(status);
  return withFileLock(progressPath(projectId, dataDir), () => {
    assertV1TaskWriteAllowed(projectId, dataDir, "setModuleStatus（update_progress 模块四色）");
    const progress = readProgress(projectId, dataDir);
    const m = progress.modules.find((m) => m.id === moduleId);
    if (!m) {
      throw new WsError("MODULE_NOT_FOUND", `模块不存在: ${moduleId}`);
    }
    m.status = status;
    writeProgress(projectId, progress, dataDir);
    return progress;
  });
}

// ── gate.jsonl（DESIGN.md §2.3.3）──
//
// ████████████████████████████ 红线 ████████████████████████████
// gate.jsonl 只追加（append），本层【不提供任何修改/删除历史行的接口】。
// 流水即审计证据，写错只能再追加一条新记录纠正，永不回改。
// ███████████████████████████████████████████████████████████████

function appendGateLine(
  projectId: string,
  line: GateLine,
  dataDir?: string,
): void {
  const file = gateJsonlPath(projectId, dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Q136（2026-09-19 审计）：走 `appendJsonlLine`——文件尾部若留着半截行（上次写到一半被 kill），
  // 裸 appendFileSync 会把新记录粘在残尾后面变坏行（新记录跟着丢）。封口口径见 lineStream.ts。
  appendJsonlLine(file, JSON.stringify(line));
}

/**
 * 读 gate.jsonl 全部记录；文件不存在返回空数组。
 *
 * Q136（2026-09-19 审计）：此前是"任一行损坏即整份拒读"（抛 `GATE_JSONL_CORRUPT` 带行号），而写侧
 * 是裸 `appendFileSync`——落盘写到一半被 kill 留下的半截行会**永远**留在文件里（追加只往后写），
 * 于是该项目从此"实况面板/Gate 时间线整块 400"（`live.ts` 裸调本函数：一行坏 = 整面板打不开），
 * 且全仓没有任何修复入口。现与 changes.jsonl 的 Q32 口径对齐：**跳过坏行、其余照常读出**，
 * 并做限频告警（gate 被 live 5s 轮询，不节流会刷屏）。读路径只读不修（不为修文件写盘）。
 */
export function readGateLines(projectId: string, dataDir?: string): GateLine[] {
  const file = gateJsonlPath(projectId, dataDir);
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  const out: GateLine[] = [];
  let bad = 0;
  let firstBad = "";
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i].trim();
    if (text === "") continue;
    const where = `gate.jsonl 第 ${i + 1} 行`;
    let parsed: GateLine | null = null;
    let reason = "";
    try {
      const raw = JSON.parse(text) as GateLine;
      if (
        typeof raw !== "object" ||
        raw === null ||
        typeof raw.ts !== "string" ||
        typeof raw.step !== "string" ||
        (raw.result !== "pass" && raw.result !== "reject") ||
        typeof raw.by !== "string" ||
        !isStrOrNull(raw.note)
      ) {
        reason = `${where} 字段不符合 DESIGN.md §2.3.3（ts/step/result/by/note）`;
      } else {
        parsed = raw;
      }
    } catch {
      reason = `${where} 不是合法 JSON`;
    }
    if (parsed === null) {
      bad++; // 坏行跳过（Q136）：不因为一行半截就让实况面板整体 400
      if (firstBad === "") firstBad = reason;
      continue;
    }
    out.push(parsed);
  }
  if (bad > 0) {
    warnCorruptLinesThrottled(
      `gate:${projectId}`,
      `[workstation] 项目 ${projectId} gate.jsonl 有 ${bad} 行坏行（首处：${firstBad}）——已跳过这些行、其余照常读出；` +
        "最常见成因是落盘写到一半被 kill 留下的半截行（读路径只读不修）",
    );
  }
  return out;
}

/**
 * 写一次 gate 转移（DESIGN.md §5.2：只有人能触发 pass/reject）：
 * 同步更新 progress.json 的 history 对应步 + current_step 推进/停留，并追加一行 gate.jsonl。
 * - pass：current_step 推进到下一步（已是最后一步则停在本步）
 * - reject：current_step 停留在被打回步，且 note 必填（打回必须说明理由）
 *
 * 权限口径（G3，§5.2）：
 * - by 固定 "user"——Gate 是"人对阶段成果的验收"，只有人能点；by 非 "user" 一律拒绝。
 * - pass 只对 current_step（顺序推进，别让步乱跳）；对其他步 pass 报 NOT_CURRENT_STEP。
 * - reject 任意步可打回，含已过的历史步（2026-09-19 主人拍板，收口附录 B G3 待议——
 *   §5.2 状态机图本就允许 passed --user:reject--> rejected）：打回时 current_step 拉回该步、
 *   其后各步重置 pending（与 setCurrentStep 迭代重置同款语义）；打回当前步时"其后"为空，
 *   行为与旧口径逐字相同。
 * - MCP 工具（M 系卡）【不会有】任何改 Gate 的接口：§5.2 只有人能触发转移，
 *   §6.3 工具清单里没有 gate 写入工具，本函数只服务 UI 的人手点击。
 */
export function recordGateTransition(
  projectId: string,
  input: { step: string; result: "pass" | "reject"; note?: string | null; by?: string },
  dataDir?: string,
): Progress {
  assertStep(input.step);
  if (input.result !== "pass" && input.result !== "reject") {
    throw new WsError(
      "INVALID_RESULT",
      `gate 转移 result 只接受 pass/reject（pending 是初始态，不是转移结果）: ${JSON.stringify(input.result)}`,
    );
  }
  const by = input.by ?? "user";
  if (by !== "user") {
    throw new WsError(
      "INVALID_INPUT",
      `gate 转移只有人能触发（§5.2），by 只接受 "user": ${JSON.stringify(input.by)}`,
    );
  }
  const note = input.note ?? null;
  if (input.result === "reject" && (note === null || note.trim() === "")) {
    throw new WsError("INVALID_INPUT", "打回必须填写 note 说明理由（§5.2：reject 留痕必须可读）");
  }
  // Q23：读 progress → 改 history/current_step → 写 progress + 追加 gate.jsonl 整段进跨进程锁，
  // 防两个 Gate 操作（UI 点击 / MCP 进程）在同一份 progress.json 上互相覆盖。
  // Q30(b)：progress.json 与 gate.jsonl 是跨文件双写、无事务——writeProgress 成功而 appendGateLine
  // 失败（磁盘满/被独占）时此前会留下"current_step 已推进、审计行缺失"的哑状态。现在留一份写前原文，
  // 追加失败就把 progress.json 回滚回原样再抛（补偿），保证两者不会各说各话。
  return withFileLock(progressPath(projectId, dataDir), () => {
    const progress = readProgress(projectId, dataDir);
    const entry = progress.gate.history.find((h) => h.step === input.step);
    if (!entry) {
      throw new WsError(
        "INVALID_STEP",
        `progress.json 的 history 中没有该步: ${input.step}`,
      );
    }
    const idx = GATE_STEP_IDS.indexOf(input.step);
    if (input.result === "pass" && input.step !== progress.gate.current_step) {
      throw new WsError(
        "NOT_CURRENT_STEP",
        `过关只能对当前步（${progress.gate.current_step}）触发（打回不限步），收到: ${input.step}`,
      );
    }
    const now = nowIso();
    entry.result = input.result;
    entry.at = now;
    entry.note = note;

    if (input.result === "pass") {
      progress.gate.current_step = GATE_STEP_IDS[Math.min(idx + 1, GATE_STEP_IDS.length - 1)];
    } else {
      // 打回历史步：其后各步重置 pending（该步本身刚置 reject，不重置）
      for (const h of progress.gate.history) {
        if (GATE_STEP_IDS.indexOf(h.step) > idx) {
          h.result = "pending";
          h.at = null;
          h.note = null;
        }
      }
      progress.gate.current_step = input.step;
    }
    const progressFile = progressPath(projectId, dataDir);
    const restorePoint = fs.readFileSync(progressFile, "utf8"); // readProgress 刚保证了它存在
    writeProgress(projectId, progress, dataDir);

    try {
      appendGateLine(
        projectId,
        { ts: now, step: input.step, result: input.result, by, note },
        dataDir,
      );
    } catch (e) {
      try {
        writeTextAtomic(progressFile, restorePoint);
      } catch {
        // 回滚也写不进去（同一个磁盘问题）：保留原错误往上抛，调用方看到的是"这一步没成"
      }
      throw e;
    }
    return progress;
  });
}

/**
 * 迭代回某一步（DESIGN.md §5.1：交付后发现问题回到「需求」步重走）：
 * current_step 指向目标步，目标步及其后所有步的 history 重置为 pending。
 * 本函数不写 gate.jsonl（留痕由 G3 的过关/打回动作负责）。
 */
export function setCurrentStep(
  projectId: string,
  step: string,
  dataDir?: string,
): Progress {
  assertStep(step);
  // Q23：读—改—写进 progress.json 跨进程锁
  return withFileLock(progressPath(projectId, dataDir), () => {
    const progress = readProgress(projectId, dataDir);
    const idx = GATE_STEP_IDS.indexOf(step);
    for (const h of progress.gate.history) {
      if (GATE_STEP_IDS.indexOf(h.step) >= idx) {
        h.result = "pending";
        h.at = null;
        h.note = null;
      }
    }
    progress.gate.current_step = step;
    writeProgress(projectId, progress, dataDir);
    return progress;
  });
}

// ── design.md（DESIGN.md §2.2 / §3.5：设计书视图只读展示）──
//
// ████████████████████████████ 红线 ████████████████████████████
// 设计书只有两条笔（§3.5）：① Flash 聊天里点「落稿」写入 design.md；
// ② Max 在 Kimi K3 Max 窗口审改。施工 agent / 执行 agent 两者都不是。
// 本层的写口【只有 appendDesign 一个】（落稿笔，D3 卡），对被纳管项目与塔台自身
// 都开放（2026-09-19 主人拍板解锁塔台落稿，收口附录 B D3 待议——原 TATAI_DESIGN_LOCKED
// 拒绝已废）：塔台落稿落点在 repo 根 DESIGN.md「附录 B」标题之前，不是文件末尾。
// 除落稿笔外【不提供任何其他写设计书的接口】；agent 发现偏差只能往
// design.discuss.md 追加待议记录（提疑权，D2 卡），改不改由人和 Max 决定。
// 落稿写入同样遵守"不点就绝不写"（§3.6）：聊天过程不触发本层任何写函数。
// ███████████████████████████████████████████████████████████████

/** 设计书读取结果；exists:false = 该项目还没有设计书（正常空态，不是错误） */
export type DesignDoc =
  | { exists: true; content: string; source: string }
  | { exists: false };

/**
 * 设计书路径口径（D1；V06-02 起接上"唯一当前源"解析）：
 * - 塔台自身（self_managed 或 id=="tatai"）→ `<项目根>/DESIGN.md`（AGENTS.md §7 塔台自身例外，
 *   不存在"读哪份"的歧义；登记字段对塔台不生效——"固定"就是不接受覆盖）；
 * - 其他被纳管项目 → 注册表登记的项目根内相对路径（`design_path`），缺省 `<项目根>/.工作台/design.md`
 *   （DESIGN.md §2.2 / §2.9 唯一事实源）。
 * 项目 id 一律经注册表解析（getProject），不接受调用方传路径——伪造 id 在这里就被 PROJECT_NOT_FOUND 拦下。
 * 登记的路径越出项目根（`../`、绝对路径、软链逃逸）由 `resolveDocumentSource` 明确拒绝（INVALID_COMMAND）。
 */
export function designPath(projectId: string, dataDir?: string): string {
  const project = getProject(projectId, dataDir);
  if (!project) {
    throw new WsError("PROJECT_NOT_FOUND", `项目不存在: ${projectId}`);
  }
  return resolveDocumentSource(projectId, "design", dataDir).abs_path;
}

/** 读设计书全文；文件不存在返回 { exists: false }，不报错崩溃 */
export function readDesign(projectId: string, dataDir?: string): DesignDoc {
  const file = designPath(projectId, dataDir);
  if (!fs.existsSync(file)) return { exists: false };
  return { exists: true, content: fs.readFileSync(file, "utf8"), source: file };
}

// ── 落稿笔（D3，§3.5/§3.6）：聊天 → design.md 的唯一写口 ──

/** 落稿追加回执：落盘文件 + 写入前/后行数（行数证据直接进流水与前端回执） */
export interface DesignAppendResult {
  source: string;
  lines_before: number;
  lines_after: number;
}

/** 新建 design.md 时的标题头（templates/.工作台.example/design.md 同口径） */
function designFileHeader(projectName: string): string {
  return [
    `# ${projectName} 设计稿`,
    "",
    "> 设计书（唯一事实源）。由落稿流程填充（§3.5：只有 Flash 落稿 / Max 审改两条笔）。",
    "",
  ].join("\n");
}

/**
 * 落稿（D3）：把【用户确认后的草稿】写入 design.md。
 * - 被纳管项目：追加到 design.md 末尾；无 design.md 时先建带标题头的文件
 *   （templates/.工作台.example 同口径），再追加。
 * - 塔台自身（self_managed 或 id=="tatai"）同样开放（2026-09-19 主人拍板解锁，原
 *   TATAI_DESIGN_LOCKED 拒绝已废）：落点在 repo 根 DESIGN.md「附录 B」标题**之前**，
 *   不是文件末尾——待议区按设计居文末，且设计书页正文展示自附录 B 起截断（§3.5），
 *   末尾追加的内容在界面上永远看不见。插入点与展示截断点用同一个附录 B 标题标记，口径单一。
 * - 写入方式："读全文 → 定位插入点 → 原子写回 → 前后段逐字节复核"（防吞行，与 appendDiscuss
 *   同惯例）；另断言插入段本身与传入 content 逐字节一致（DoD④：落稿内容 == 确认内容）。
 * - content 原样落盘：只补首尾换行衔接，不做任何提炼/改写——
 *   提炼发生在草稿阶段（flash 生成草稿 → 用户可编辑 → 确认），本函数收到的就是定稿。
 */
export function appendDesign(
  projectId: string,
  content: string,
  dataDir?: string,
): DesignAppendResult {
  if (typeof content !== "string" || content.trim() === "") {
    throw new WsError("INVALID_INPUT", "落稿内容不能为空");
  }
  const project = getProject(projectId, dataDir);
  if (!project) {
    throw new WsError("PROJECT_NOT_FOUND", `项目不存在: ${projectId}`);
  }
  const file = designPath(projectId, dataDir);
  const countLines = (t: string) => (t === "" ? 0 : t.replace(/\n+$/, "").split("\n").length);

  // ── 塔台自身：插入到 DESIGN.md 附录 B 标题之前（2026-09-19 主人拍板解锁）──
  if (project.self_managed === true || project.id === "tatai") {
    if (!fs.existsSync(file)) {
      // 不给塔台走"建带标题头的新文件"通用分支：新建的文件没有附录 B 区，
      // 待议记录（appendDiscuss/readDiscuss 的自举例外本体）会随之失效
      throw new WsError(
        "INVALID_INPUT",
        `塔台 DESIGN.md 不存在（${file}）——塔台设计书事实源缺失，落稿无从落点`,
      );
    }
    const oldText = readTextForAppend(file, "DESIGN.md");
    const insertAt = appendixBRange(oldText).start;
    const tailNl = content.endsWith("\n") ? "" : "\n";
    const newText = oldText.slice(0, insertAt) + content + tailNl + oldText.slice(insertAt);
    // Q26：写之前先确认磁盘还是"我们读到的那一份"，外部编辑器在读到写之间改过就报错不动文件
    writeTextAtomic(file, newText, oldText);
    // 防吞行断言（读盘复核，不是信内存）：插入点前后两段原文逐字节不动，插入段 == content
    const onDisk = fs.readFileSync(file, "utf8");
    if (onDisk !== newText) {
      throw new WsError(
        "INVALID_INPUT",
        "DESIGN.md 落稿红线 violation：写回后与预期不一致（疑似吞行）",
      );
    }
    if (onDisk.slice(insertAt, insertAt + content.length) !== content) {
      throw new WsError(
        "INVALID_INPUT",
        "DESIGN.md 落稿红线 violation：插入段与确认草稿不一致（DoD④ 落稿内容 == 确认内容）",
      );
    }
    return {
      source: file,
      lines_before: countLines(oldText),
      lines_after: countLines(onDisk),
    };
  }

  // ── 被纳管项目：末尾追加（原 D3 口径不变）──
  const existed = fs.existsSync(file);
  const oldText = existed ? readTextForAppend(file, "design.md") : designFileHeader(project.name);
  const joinNl = oldText.length > 0 && !oldText.endsWith("\n") ? "\n" : "";
  const tailNl = content.endsWith("\n") ? "" : "\n";
  const newText = oldText + joinNl + content + tailNl;
  // Q26：写之前先确认磁盘还是"我们读到的那一份"，外部编辑器在读到写之间改过就报错不动文件
  writeTextAtomic(file, newText, existed ? oldText : null);
  // 防吞行断言（读盘复核，不是信内存）：原文前缀逐字节不动，追加段与 content 逐字节一致
  const onDisk = fs.readFileSync(file, "utf8");
  if (onDisk !== newText || !onDisk.startsWith(oldText)) {
    throw new WsError(
      "INVALID_INPUT",
      "design.md 落稿红线 violation：写回后原文前缀与写前不一致（疑似吞行）",
    );
  }
  const contentStart = oldText.length + joinNl.length;
  if (onDisk.slice(contentStart, contentStart + content.length) !== content) {
    throw new WsError(
      "INVALID_INPUT",
      "design.md 落稿红线 violation：追加段与确认草稿不一致（DoD④ 落稿内容 == 确认内容）",
    );
  }
  return {
    source: file,
    lines_before: countLines(oldText),
    lines_after: countLines(onDisk),
  };
}

// ── design.discuss.md（DESIGN.md §3.5 / §6.3：待议记录，提疑权；D2 卡）──
//
// ████████████████████████████ 红线 ████████████████████████████
// 待议记录【只追加】：本层【不提供任何修改/删除已有待议条目的函数】，也不许
// 后来者在这里补——提疑权是"提"不是"改"（§6.3 硬性权限约束）。写错只能再追加
// 一条新记录纠正，永不回改。唯一的"替换"例外：附录 B 空态占位符 `_（暂无）_`
// 在首条追加时被替换（G3 已用掉该例外，此后一律纯追加）。
// ███████████████████████████████████████████████████████████████
//
// 口径（AGENTS.md §4 + DESIGN.md §3.5）：
// - 被纳管项目 → `<项目根>/.工作台/design.discuss.md`（不存在则创建带标题头的文件）；
// - 塔台自身 → repo 根 `DESIGN.md` 附录 B 区追加一条（自举例外，无 .工作台 副本）。
// 写入方式一律"读全文 → 末尾追加 → 原子写回"，并断言写回后原文前缀逐字节等于
// 写前（防吞行——本仓库 PROGRESS.md 踩过两次的坑）。
// 条目格式：`- \`YYYY-MM-DD\` <内容>`（日期前缀由本层补，调用方只给内容）。

/** 待议记录读取结果；exists:false = 该项目还没有待议记录（正常空态，不是错误） */
export type DiscussDoc =
  | { exists: true; content: string; source: string; count: number }
  | { exists: false };

/** appendDiscuss 的写入回执：落盘文件、行号、追加进去的整行原文 */
export interface DiscussAppendResult {
  source: string;
  line: number;
  entry: string;
}

/** 待议条目行判定：`- \`日期\` …` 开头的列表行（UI 标黄与 count 共用此口径） */
const DISCUSS_ENTRY_RE = /^- `/;

function countDiscussEntries(content: string): number {
  return content.split(/\r?\n/).filter((l) => DISCUSS_ENTRY_RE.test(l)).length;
}

/** 塔台自身例外判定（与 designPath 同一口径：self_managed 或 id=="tatai"） */
function isTataiProject(projectId: string, dataDir?: string): boolean {
  const project = getProject(projectId, dataDir);
  if (!project) {
    throw new WsError("PROJECT_NOT_FOUND", `项目不存在: ${projectId}`);
  }
  return project.self_managed === true || project.id === "tatai";
}

function discussPath(projectId: string, dataDir?: string): string {
  return path.join(workstationDir(projectId, dataDir), DISCUSS_FILE);
}

/** 新建 design.discuss.md 时的标题头（templates/.工作台.example 同口径） */
function discussFileHeader(): string {
  return [
    "# 待议记录",
    "",
    "> 执行 agent 只能追加到这里；改不改由人决定（DESIGN.md §3.5 提疑权）。",
    "",
  ].join("\n");
}

/** 在 DESIGN.md 全文中定位附录 B 区段 [start, end)：start=标题行偏移，end=下一个二级标题或文末 */
function appendixBRange(text: string): { start: number; end: number } {
  const start = text.indexOf(TATAI_APPENDIX_B_HEADING);
  if (start === -1) {
    throw new WsError(
      "INVALID_INPUT",
      `DESIGN.md 缺少「${TATAI_APPENDIX_B_HEADING}」区，塔台待议记录无处追加（附录 B 是自举例外的本体）`,
    );
  }
  const next = text.indexOf("\n## ", start + TATAI_APPENDIX_B_HEADING.length);
  return { start, end: next === -1 ? text.length : next + 1 };
}

/**
 * 读待议记录全文：
 * - 塔台自身 → 抽取 repo 根 DESIGN.md 附录 B 区段（含标题行与口径说明，逐字节原文）；
 * - 其他项目 → 读 `<项目根>/.工作台/design.discuss.md` 全文；不存在返回 { exists: false }。
 * count = 待议条目行数（`- \`` 开头的行），供 UI 标黄徽标用。
 */
export function readDiscuss(projectId: string, dataDir?: string): DiscussDoc {
  if (isTataiProject(projectId, dataDir)) {
    const file = designPath(projectId, dataDir);
    if (!fs.existsSync(file)) return { exists: false };
    const text = fs.readFileSync(file, "utf8");
    const { start, end } = appendixBRange(text);
    const content = text.slice(start, end).replace(/\s+$/, "") + "\n";
    return { exists: true, content, source: file, count: countDiscussEntries(content) };
  }
  const file = discussPath(projectId, dataDir);
  if (!fs.existsSync(file)) return { exists: false };
  const content = fs.readFileSync(file, "utf8");
  return { exists: true, content, source: file, count: countDiscussEntries(content) };
}

/**
 * 追加一条待议记录（提疑权，§3.5/§6.3）：
 * - content 只收内容本体，日期前缀 `- \`YYYY-MM-DD\` ` 由本层补；内部换行折叠为空格
 *   （待议一条一行，防注入伪造条目行）；
 * - 被纳管项目：文件不存在则先建带标题头的文件，再末尾追加；
 * - 塔台自身：定位 DESIGN.md 附录 B 标题与区段末尾，【只在末尾追加新行，不动任何已有字符】；
 *   区段里还是 `_（暂无）_` 占位时替换占位为首条（唯一被允许的替换）。
 * 红线见本区段头注释：只追加，永不修改/删除已有条目。
 */
export function appendDiscuss(
  projectId: string,
  content: string,
  dataDir?: string,
): DiscussAppendResult {
  if (typeof content !== "string" || content.trim() === "") {
    throw new WsError("INVALID_INPUT", "待议内容不能为空");
  }
  const text = content.trim().replace(/\s*\r?\n\s*/g, " ");
  const entry = `- \`${nowIso().slice(0, 10)}\` ${text}`;

  if (isTataiProject(projectId, dataDir)) {
    // ── 塔台自身例外：追加到 repo 根 DESIGN.md 附录 B 区 ──
    const file = designPath(projectId, dataDir);
    const oldText = readTextForAppend(file, "DESIGN.md");
    const { start, end } = appendixBRange(oldText);
    const section = oldText.slice(start, end);
    let newText: string;
    let prefixEnd: number; // 插入点：该偏移之前的原文必须逐字节不动
    const phIdx = section.indexOf(APPENDIX_B_PLACEHOLDER);
    if (phIdx !== -1) {
      // 首条：替换空态占位符（唯一被允许的替换；占位符之外的所有字符原样保留）
      const abs = start + phIdx;
      prefixEnd = abs;
      newText =
        oldText.slice(0, abs) + entry + oldText.slice(abs + APPENDIX_B_PLACEHOLDER.length);
    } else {
      // 纯追加：插到区段末尾（文末或下一个二级标题前），已有条目逐字节不动
      const needsNl = end > 0 && oldText[end - 1] !== "\n";
      prefixEnd = end;
      newText =
        oldText.slice(0, end) + (needsNl ? "\n" : "") + entry + "\n" + oldText.slice(end);
    }
    writeTextAtomic(file, newText, oldText);
    // 防吞行断言（读盘复核，不是信内存）：插入点之前的原文必须逐字节原样还在
    const onDisk = fs.readFileSync(file, "utf8");
    if (onDisk !== newText) {
      throw new WsError("INVALID_INPUT", "DESIGN.md 写回校验失败：磁盘内容与预期不一致");
    }
    if (!onDisk.startsWith(oldText.slice(0, prefixEnd))) {
      throw new WsError("INVALID_INPUT", "DESIGN.md 追加红线 violation：插入点之前的原文被改动");
    }
    const line = onDisk.slice(0, onDisk.indexOf(entry)).split("\n").length;
    return { source: file, line, entry };
  }

  // ── 被纳管项目：追加到 <项目根>/.工作台/design.discuss.md ──
  const file = discussPath(projectId, dataDir);
  const existed = fs.existsSync(file);
  const oldText = existed
    ? readTextForAppend(file, "design.discuss.md")
    : discussFileHeader();
  const needsNl = oldText.length > 0 && !oldText.endsWith("\n");
  const newText = oldText + (needsNl ? "\n" : "") + entry + "\n";
  // Q26：写之前先确认磁盘还是"我们读到的那一份"（外部编辑器改过就报错不动文件）
  writeTextAtomic(file, newText, existed ? oldText : null);
  // 防吞行断言（读盘复核）：写回后原文前缀必须逐字节等于写前
  const onDisk = fs.readFileSync(file, "utf8");
  if (onDisk !== newText || !onDisk.startsWith(oldText)) {
    throw new WsError(
      "INVALID_INPUT",
      "design.discuss.md 追加红线 violation：写回后原文前缀与写前不一致（疑似吞行）",
    );
  }
  return { source: file, line: onDisk.trimEnd().split("\n").length, entry };
}

// ── tasks.json（DESIGN.md §2.3.4；任务状态由 agent 经 MCP 自报，§5.3）──

function validateTask(raw: unknown, ctx: string): TaskRecord {
  const t = raw as TaskRecord;
  if (
    typeof t !== "object" ||
    t === null ||
    typeof t.id !== "string" ||
    t.id === "" ||
    typeof t.title !== "string" ||
    typeof t.module_id !== "string" ||
    typeof t.reporter !== "string" ||
    typeof t.updated_at !== "string" ||
    !(t.note === undefined || typeof t.note === "string")
  ) {
    throw new WsError(
      "INVALID_INPUT",
      `${ctx}: 任务字段不符合 DESIGN.md §2.3.4（id/title/module_id/status/reporter/updated_at/note?）`,
    );
  }
  assertTaskStatus(t.status);
  return t;
}

/** 读 tasks.json；文件不存在返回空表（version:1, tasks:[]），结构不合法抛错 */
export function readTasks(projectId: string, dataDir?: string): TasksFile {
  const file = tasksPath(projectId, dataDir);
  if (!fs.existsSync(file)) return { version: 1, tasks: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new WsError(
      "INVALID_INPUT",
      `tasks.json 不是合法 JSON: ${(e as Error).message}`,
    );
  }
  const tf = raw as TasksFile;
  if (typeof tf !== "object" || tf === null || tf.version !== 1) {
    throw new WsError("INVALID_INPUT", "tasks.json 顶层必须是 { version: 1, tasks: [] }");
  }
  if (!Array.isArray(tf.tasks)) {
    throw new WsError("INVALID_INPUT", "tasks.json 的 tasks 必须是数组");
  }
  for (const t of tf.tasks) validateTask(t, "tasks.json");
  return tf;
}

function writeTasks(projectId: string, tf: TasksFile, dataDir?: string): void {
  writeJsonAtomic(tasksPath(projectId, dataDir), tf);
}

/**
 * v1 写闸门（V06-03）：未迁移项目原样放行（`addTask` / `setTaskStatus` 的行为**逐字不变**）；
 * 已迁移项目（`.工作台/tasks.json` 是 v2 事件的兼容投影，或 `work/events.jsonl` 在场）
 * 抛 `WRITE_UPGRADE_REQUIRED`，把"缺哪些 v2 字段、该走哪条写入路径"一次说清。
 *
 * 为什么闸门放在这一层：v1 任务状态有两个写口（HTTP `POST /tasks/:id/status` 与 MCP
 * `report_task_status`），它们都收敛到 `addTask` / `setTaskStatus`，闸门挂在这两个入口
 * 就不会出现"某个写口漏掉"。判据本体在 `work/tasks.ts`（不解析 JSON、不落盘，故对
 * 未迁移项目零副作用）。
 */
function assertV1TaskWriteAllowed(
  projectId: string,
  dataDir: string | undefined,
  what: string,
  parsed?: TasksFile,
): void {
  const gate = v1TaskWriteGate({
    work_dir: projectWorkDir(projectId, dataDir),
    tasks_file: tasksPath(projectId, dataDir),
    ...(parsed === undefined ? {} : { tasks_file_raw: parsed }),
    what,
  });
  if (!gate.allowed) throw new WsError("WRITE_UPGRADE_REQUIRED", gate.message);
}

/**
 * 读兼容投影信息（V06-03；V09-08 ⑤ 改口径）：文件是 v2 投影时返回它的标记与流水序号，供读接口如实说明
 * "这份 tasks.json 是派生投影、不是事实源"；不是投影/读不动都返回 null（读路径不因此报错）。
 *
 * **V09-08 ⑤（附录 E.6 第 1 条）**：`last_seq` 必须与本次给出的**任务行同源**——行是 v2 事件投影时，
 * `last_seq` 取同一事件账本的末序号；旧 compat 文件自己的序号另报 `compat_snapshot_seq` 并标
 * `stale=true`（**绝不把旧 seq 冒充实时任务行版本**，报告 02 G-06 的"元数据在说谎"就是这个）。
 * 未迁移项目（`readCompatTasksProjection` 返回 null）整条为 null ⇒ 旧读口回执逐字不变。
 */
export interface TasksProjectionInfo {
  projection_of: string;
  /** 与本次返回的任务行**同源**的版本号（v2 行＝事件账本末序号；整份退回 v1＝旧文件序号） */
  last_seq: number | null;
  /** `last_seq` 的来源（照实说，别让调用方猜） */
  last_seq_source: "v2_events" | "v1_compat_file";
  /** 任务行整体来自哪里（与 `readTaskLedger().source` 同一取值） */
  source_ledger: TaskLedger["source"];
  status_semantics: string;
  /** 旧 compat 文件自己记录的序号（**不是**实时任务行版本） */
  compat_snapshot_seq: number;
  /** 旧文件是否落后于它该反映的事实（`compat_snapshot_seq !== last_seq`） */
  stale: boolean;
  /** 口径一句话（界面与读口共用） */
  note: string;
}

export const TASKS_PROJECTION_NOTE =
  "任务行与 last_seq 同源（v2 事件账本）；compat_snapshot_seq 是旧 tasks.json 快照自己的序号，不冒充实时版本。";

/** 项目是否已迁移（读侧判据：台账带 v2 投影标记，或 `work/events.jsonl` 在场）——
 *  与 `work/migrate.ts#isMigratedProject` 同一判据；就地复写是因为 migrate.ts 反向 import 本文件。 */
function isMigratedProjectHere(projectId: string, dataDir?: string): boolean {
  try {
    if (readCompatTasksProjection(tasksPath(projectId, dataDir)) !== null) return true;
  } catch {
    // 台账读不动时按事件文件判（与 migrate 同口径）
  }
  return fs.existsSync(path.join(projectWorkDir(projectId, dataDir), "events.jsonl"));
}

/** v1 模块四色的**兼容读数**标记（V09-08 ⑤；未迁移项目返回 null ⇒ 回执逐字不变） */
export function progressCompatInfo(
  projectId: string,
  dataDir?: string,
): { source: "v1_compat_progress"; note: string } | null {
  if (!isMigratedProjectHere(projectId, dataDir)) return null;
  return {
    source: "v1_compat_progress",
    note:
      "这里的 modules 是 `progress.json` 的 v1 四色**兼容读数**（自报进度），不是 v2 状态；" +
      "项目已迁移到 v2，模块/能力的现行状态由证据派生（见状态投影的 display_status），读口不得拿它充数。",
  };
}

export function tasksProjectionInfo(projectId: string, dataDir?: string): TasksProjectionInfo | null {
  let projection: ReturnType<typeof readCompatTasksProjection> = null;
  try {
    projection = readCompatTasksProjection(tasksPath(projectId, dataDir));
  } catch {
    return null;
  }
  if (projection === null) return null;
  const ledger = readTaskLedger(projectId, dataDir);
  const fromEvents = ledger.last_seq !== null;
  const lastSeq = ledger.last_seq ?? projection.last_seq;
  return {
    projection_of: projection.projection_of,
    last_seq: lastSeq,
    last_seq_source: fromEvents ? "v2_events" : "v1_compat_file",
    source_ledger: ledger.source,
    status_semantics: projection.status_semantics,
    compat_snapshot_seq: projection.last_seq,
    stale: projection.last_seq !== lastSeq,
    note: TASKS_PROJECTION_NOTE,
  };
}

/** 新增任务；id 重复报错，初始状态缺省 todo，updated_at 落当前时间
 *  Q23：tasks.json 的读—改—写进跨进程锁（HTTP 的 POST tasks 与 MCP 的 report_task_status 同写它）；
 *  锁只圈 RMW 这一段，随后的 rollupModuleStatus 自己锁 progress.json——两把锁不嵌套。
 *  Q30(a)：写 tasks.json **之前**先读一遍 progress.json——此前 tasks 落盘后才 rollup，
 *  而 rollup 对坏 progress.json 硬抛（PROGRESS_INVALID），结果是"任务已进库、模块四色没跟进"
 *  且没有任何补偿。挪到写之前：progress 坏就整笔失败，磁盘一个字都没动。 */
export function addTask(
  projectId: string,
  input: {
    id: string;
    title: string;
    module_id: string;
    reporter: string;
    status?: TaskStatus;
    note?: string;
  },
  dataDir?: string,
): TaskRecord {
  const record = withFileLock(tasksPath(projectId, dataDir), () => {
    const tf = readTasks(projectId, dataDir);
    assertV1TaskWriteAllowed(projectId, dataDir, "addTask（新增任务台账）", tf); // V06-03 闸门
    if (tf.tasks.some((t) => t.id === input.id)) {
      throw new WsError("TASK_EXISTS", `任务 id 已存在: ${input.id}`);
    }
    const status = input.status ?? "todo";
    assertTaskStatus(status);
    if (typeof input.id !== "string" || input.id.trim() === "") {
      throw new WsError("INVALID_INPUT", "任务 id 不能为空");
    }
    const record: TaskRecord = {
      id: input.id,
      title: input.title,
      module_id: input.module_id,
      status,
      reporter: input.reporter,
      updated_at: nowIso(),
      ...(typeof input.note === "string" && input.note !== ""
        ? { note: input.note }
        : {}),
    };
    validateTask(record, "addTask");
    readProgress(projectId, dataDir); // Q30(a)：进度表读得动才允许写任务（失败即整笔不写）
    tf.tasks.push(record);
    writeTasks(projectId, tf, dataDir);
    return record;
  });
  rollupModuleStatus(projectId, record.module_id, dataDir);
  return record;
}

/** 改任务状态（§5.3 四值）；任务不存在报错，顺带刷新 updated_at，并按 §5.3 汇总所属模块四色
 *  note（可选）：非空字符串则覆盖旧备注；不传/空串保留旧值（2026-09-19 主人拍板留痕口径）
 *  Q23：同 addTask，tasks.json 的读—改—写进跨进程锁，锁不与 progress.json 的锁嵌套。
 *  Q30(a)：同 addTask，写 tasks.json 之前先读一遍 progress.json（坏文件就整笔不写）。 */
export function setTaskStatus(
  projectId: string,
  taskId: string,
  status: TaskStatus,
  dataDir?: string,
  note?: string,
): TaskRecord {
  assertTaskStatus(status);
  const t = withFileLock(tasksPath(projectId, dataDir), () => {
    const tf = readTasks(projectId, dataDir);
    assertV1TaskWriteAllowed(projectId, dataDir, "setTaskStatus（任务状态自报）", tf); // V06-03 闸门
    const t = tf.tasks.find((t) => t.id === taskId);
    if (!t) {
      throw new WsError("TASK_NOT_FOUND", `任务不存在: ${taskId}`);
    }
    t.status = status;
    t.updated_at = nowIso();
    if (typeof note === "string" && note !== "") {
      t.note = note;
    }
    readProgress(projectId, dataDir); // Q30(a)：进度表读得动才允许写任务
    writeTasks(projectId, tf, dataDir);
    return t;
  });
  rollupModuleStatus(projectId, t.module_id, dataDir);
  return t;
}

// ── 任务 → 模块状态汇总（M3，DESIGN.md §5.3：任务挂在模块上，任务状态【汇总】出模块四色）──
// 汇总规则：有任一 blocked → issue；有任一 doing → doing；全 done → done；全 todo → todo；
// todo+done 混合（无 doing/blocked）视为进行中 → doing。
// 空模块（无任务）保持原状态不动；module_id 为空串或模块未在 progress.json 登记时跳过汇总
// （不拦任务自报——任务先报、模块后建档是合法顺序）。
// 挂钩口径：只在任务状态写入的统一入口（本层 addTask / setTaskStatus）里调，
// MCP report_task_status 与 HTTP POST tasks/:tid/status 都走这两个入口，不散在两处。
export function rollupModuleStatus(
  projectId: string,
  moduleId: string,
  dataDir?: string,
): Progress {
  // Q23：从"读 progress"到"按任务汇总写回"整段进 progress.json 的跨进程锁——
  // 否则并发的一次模块状态写入会被本次汇总基于**旧表**算出的结果覆盖。
  return withFileLock(progressPath(projectId, dataDir), () => {
    const progress = readProgress(projectId, dataDir);
    const m = progress.modules.find((m) => m.id === moduleId);
    if (moduleId === "" || !m) return progress;
    const tasks = readTasks(projectId, dataDir).tasks.filter(
      (t) => t.module_id === moduleId,
    );
    if (tasks.length === 0) return progress; // 空模块保持原状态不动
    const status: ModuleStatus = tasks.some((t) => t.status === "blocked")
      ? "issue"
      : tasks.some((t) => t.status === "doing")
        ? "doing"
        : tasks.every((t) => t.status === "done")
          ? "done"
          : tasks.every((t) => t.status === "todo")
            ? "todo"
            : "doing"; // todo+done 混合：有未动的也有完成的，模块在做
    if (m.status !== status) {
      m.status = status;
      writeProgress(projectId, progress, dataDir);
    }
    return progress;
  });
}

/** 列举任务（§2.3.4 原样返回） */
export function listTasks(projectId: string, dataDir?: string): TaskLedgerRow[] {
  return readTaskLedger(projectId, dataDir).rows;
}

/** 任务状态行的**唯一读口径**（V08-01；2026-09-23 修缺陷 f-c7d3ec36339dc919）：v2 事件优先，
 *  **v2 投影里没有事实、但 v1 台账里有的行如实回退并逐行标来源**（不整体吞掉用户台账），
 *  项目连 v2 事件都没有时整份退回 v1。
 *  v1 的 `status` 只是兼容四态（最弱含义：done ＝ 执行者已提交结果，不代表验收）；
 *  `v2_status`/`v2_status_label` 是 §5.4 的七态原文，界面据此如实显示"结果已提交"而不是"已完成"。 */
export interface TaskLedgerRow extends TaskRecord {
  /** v2 执行状态（没有 v2 事实的行 / 未迁移项目为 null） */
  v2_status: TaskExecutionStatus | null;
  /** v2 状态的中文标签（如「结果已提交」；没有 v2 事实的行 / 未迁移项目为 null） */
  v2_status_label: string | null;
  /** **这一行**的事实来源：`v2_events`＝v2 事件投影；`v1_file`＝v1 兼容台账回退行 */
  ledger_source: "v2_events" | "v1_file";
}

export interface TaskLedger {
  rows: TaskLedgerRow[];
  /**
   * 这一份是从哪读出来的：
   *   · `v2_events` ＝ 每个任务事实都来自 v2 事件投影；
   *   · `v1_file` ＝ 整份来自 v1 兼容台账（项目还没有 v2 事件，或 v2 投影里**一条任务事实都没有**）；
   *   · `v2_events+v1_fallback` ＝ v2 事件为主，**另有若干行只有 v1 台账有**（如实回退，不吞掉）。
   */
  source: "v2_events" | "v1_file" | "v2_events+v1_fallback";
  /** 事件账本末序号（整份退回 v1 时为 null——那时任务行不是从事件读出来的） */
  last_seq: number | null;
  /** 由 v1 台账回退补上的任务 id（空数组＝没有回退行） */
  v1_fallback_ids: string[];
}

/**
 * 读任务状态账（V08-01 状态区 v2 派生）：**以 v2 事件投影为准**（DESIGN §2.6
 * 「不在 PLAN、tasks.json、聊天摘要里各存一套可独立修改的任务状态」），
 * 但**不把「有 events.jsonl」当成「任务已迁移到 v2」**（2026-09-23 缺陷 f-c7d3ec36339dc919）：
 *   · 项目还没有 `events.jsonl` → 整份退回 v1 台账（`source=v1_file`）；
 *   · 有 `events.jsonl`、但 v2 投影里**一条 `task:*` 事实都没有**（例如只写过审计记录）→ 同样整份退回 v1；
 *   · v2 有部分事实 → v2 行 + 「只有 v1 有」的行**并回**（`source=v2_events+v1_fallback`，另给 `v1_fallback_ids`）。
 * `title`/`module_id`/`note` 沿用旧台账里人填的值（不丢用户数据），v2 侧没有这些字段。
 */
export function readTaskLedger(projectId: string, dataDir?: string): TaskLedger {
  const workDir = projectWorkDir(projectId, dataDir);
  const file = readTasks(projectId, dataDir);
  const v1Rows: TaskLedgerRow[] = file.tasks.map((t) => ({
    ...t,
    v2_status: null,
    v2_status_label: null,
    ledger_source: "v1_file" as const,
  }));
  const v1Only = (): TaskLedger => ({ rows: v1Rows, source: "v1_file", last_seq: null, v1_fallback_ids: v1Rows.map((r) => r.id) });
  if (!fs.existsSync(path.join(workDir, "events.jsonl"))) return v1Only();

  const { states, last_seq } = readTaskStates(workDir);
  const byId = new Map(file.tasks.map((t) => [t.id, t]));
  const v2Rows: TaskLedgerRow[] = Object.values(states)
    .sort((a, b) => a.task_id.localeCompare(b.task_id))
    .map((s) => {
      const prev = byId.get(s.task_id);
      const row: TaskLedgerRow = {
        id: s.task_id,
        title: prev?.title ?? s.task_id,
        module_id: prev?.module_id ?? "",
        reporter: s.last_actor === "" ? "unknown" : s.last_actor,
        updated_at: s.updated_at,
        status: v1StatusOf(s.status),
        v2_status: s.status,
        v2_status_label: TASK_STATUS_LABELS[s.status],
        ledger_source: "v2_events",
      };
      if (prev?.note !== undefined) row.note = prev.note;
      return row;
    });
  // 有事件文件但 v2 里没有任何任务事实 ⇒ 那不是"任务已迁移"，整份退回 v1（不把台账吞成空账）
  if (v2Rows.length === 0) return v1Only();

  const inV2 = new Set(v2Rows.map((r) => r.id));
  const fallback = v1Rows.filter((r) => !inV2.has(r.id));
  const rows = [...v2Rows, ...fallback].sort((a, b) => a.id.localeCompare(b.id));
  return {
    rows,
    source: fallback.length === 0 ? "v2_events" : "v2_events+v1_fallback",
    last_seq,
    v1_fallback_ids: fallback.map((r) => r.id),
  };
}
