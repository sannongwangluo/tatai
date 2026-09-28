// E3：终端命令历史（DESIGN.md §3.7 终端视图二期「命令历史检索」、§2.2 `.工作台/logs/` 运行日志位）——
// 本文件是"记录侧 + 检索侧"唯一的一层，服务端独有，前端只能经 HTTP 读/清。
//
// ████ 数据来源红线（PLAN E3 跑偏点） ████
// 历史**只记本人经塔台 pane 敲进去的命令**：唯一输入口是 `pty.ts` 的 `writeTerminal`（= 前端键盘
// 经 POST /in 写进 PTY 的字节），本文件**绝不读 shell 自己的历史文件**（`$HISTFILE` / `.bash_history` /
// PowerShell `ConsoleHost_history.txt` / cmd 的 doskey 历史）——那些文件位置因 shell 而异、还混着别的
// 项目的命令，当数据源既不可靠又是隐私事故。落盘范围因此天然限定在"塔台当前项目 → 本项目的 PTY 会话"。
//
// ████ 落盘位置 ████
// `<项目根>/.工作台/logs/terminal-history.jsonl`（`workstationDir` 解析，路径只走注册表；`.工作台/`
// 在 `.gitignore` 里，不进仓库、不进项目公开目录）。**只追加**：文件超 MAX_HISTORY_BYTES 就滚动成
// 归档文件（terminal-history.<毫秒时间戳>.jsonl），归档最多留 MAX_HISTORY_ARCHIVES 份，永不回改历史行。
// 唯一的"清空"动作是用户显式删本项目历史（`clearTerminalHistory`，前端二次确认，隐私需要给用户删除权）。
//
// ████ 按键流 → 命令（口径写在注释里，也是流水里要说明的） ████
// 前端每敲一个键就一 POST（T2 起就是这样），服务端收到的是**按键流**，不是命令行。本文件把它按
// 「行编辑」重放：可打印字符按光标位置插入、退格/DEL 删、←/→/Home/End 移光标、Ctrl-C 弃行、
// Ctrl-U/Ctrl-K/Ctrl-W 按 cmd 语义清行；回车（\r / \n）即命令行提交。
// 四类**不落盘**情形（宁漏不泄、宁漏不错，跳过只进内存计数、绝不写进历史文件）：
//  ① 敏感形态（命中 SENSITIVE_SHAPES：pass/secret/token/api_key/Bearer/密钥/密码…）——直接跳过；
//  ② 无回显（回车后既没在回显里看到这条命令、本行又没动过光标）——判为密码类无回显输入，跳过；
//  ③ 密码提示词（提交那一刻回显窗口尾部是 `Password:` / `[sudo] password` / `密码：` 这类提示）——跳过；
//  ④ 不可重建（按了 ↑/↓ 召回历史、按了 Tab 补全——shell 会插进我们看不见的文本）——跳过，绝不猜。
// 密码检测的能力边界（如实写在代码里，不吹）：Windows 控制台 `set /p` 其实**会回显**，
// 所以"无回显"这条路只在真无回显的场景（第三方程序关掉 console echo）生效；敏感形态与密码提示词
// 两条是主力防线。
//
// ████ 性能 ████
// 记录在内存里逐键累积，落盘一条一次 `fs.appendFileSync`（命令频率下完全够）；"待落盘队列"在
// **输出静默 ECHO_QUIET_MS 后**统一处理（回显总落后于提交，逐条立刻判会把正常命令误判成无回显——
// 施工冒烟实测踩到过），长命命令由 MAX_PENDING_MS 兜底收口。
// 检索走**流式逐行**（`lineStream.ts` 的 iterFileLines）：内存 = 一块 + 一行的残片，只滚动保留
// 最后 limit 条命中；`total` / 坏行计数仍要精确，所以文件仍从头到尾过一遍（Q46，改前是整仓全量读入
// 再 parse——1 活跃 + 5 归档 ≈ 30 MB 文本，limit 只截结果不省读入量）。归档文件一起读，跨会话/跨滚动都能查到。
import fs from "node:fs";
import path from "node:path";
import { iterFileLines } from "./lineStream";
import { getProject } from "./registry";
import { toIso } from "./time";
import { workstationDir } from "./workstation";

// ── 常量（验证脚本要按同一份口径断言，故 export） ──

/** `.工作台/` 下的运行日志目录（DESIGN.md §2.2） */
export const HISTORY_DIR_NAME = "logs";
/** 活跃历史文件（只追加） */
export const HISTORY_FILE_NAME = "terminal-history.jsonl";
/** 单文件滚动阈值：超过即滚动归档（避免一个项目的历史无限膨胀） */
export const MAX_HISTORY_BYTES = 5 * 1024 * 1024;
/** 归档保留份数：超出按时间丢最旧的（归档只是备份，不是主数据） */
export const MAX_HISTORY_ARCHIVES = 5;
/** 检索默认/最大条数 */
export const DEFAULT_HISTORY_LIMIT = 50;
export const MAX_HISTORY_LIMIT = 500;
/** 回车后等回显/输出的静默窗口：静默这么久就落盘（也用于判"无回显"） */
export const ECHO_QUIET_MS = 150;
/** 待落盘命令最长挂起时间（长命命令不至于一直不落盘） */
export const MAX_PENDING_MS = 10_000;
/** 回显比对窗口上限（字符） */
const ECHO_WINDOW_MAX = 8000;
/** 回显比对时取回显窗口尾部多少字符找密码提示词 */
const PROMPT_TAIL = 240;

/** 一条历史记录（jsonl 一行；`exit_code` 恒无——cmd.exe 不回传单条命令的退出码，不编造） */
export interface TerminalHistoryLine {
  /** 提交时刻（本地 ISO 带时区偏移，与 gate.jsonl 同口径） */
  ts: string;
  project_id: string;
  /** 塔台会话 id（`pty.ts` 生成）；跨会话检索靠它区分来源 */
  session_id: string;
  /** 命令提交时的 cwd（cd 类命令本地尽力跟踪，越出项目根不跟） */
  cwd: string;
  command: string;
  /** 回车 → 本命令最后一段输出的间隔；null = 回车后没有新输出 */
  duration_ms: number | null;
}

/**
 * 敏感形态：命中即**不落盘**（宁可少记几条，也不让密码进历史文件）。
 * 口径：常见密钥/口令/令牌形态 + 中文"密码/口令/密钥"字样。
 *
 * Q72（2026-09-18 审计）：正则过滤永远是启发式，**漏网的命令会明文落盘在项目内**
 * （`.工作台/` 默认 gitignore、远程读默认 403，但本机磁盘上是明文）。核证点名的两类漏网已补：
 *  ① 「URL 里带 user:password@」——`psql "postgres://u:pass@h"`、`redis-cli -u redis://:pw@h`、`git clone https://u:tok@h` 这类
 *     连接串，原来的 `pass(word|wd|phrase)` 命中不了（pass 后面是 `@`）；
 *  ② 「自定义头里放凭据」——`curl -H "X-Cred: abc"`、`-H 'X-Api-Key: …'`、`Cookie:` 这类，头名不在原表里。
 * 仍然**认不出来**的（如实记，属设计取舍，见 03 条目"过滤靠正则是否可接受由人终审"）：
 *  `export FOO=…` 这类"变量名里没有任何敏感词"的赋值、`-u user` 后单问口令、任意的自造字段名——
 *  要覆盖它们只能把规则放宽到"凡是赋值/凡是 -H 都跳"，代价是历史功能基本作废，本批不做。
 */
const SENSITIVE_SHAPES: RegExp[] = [
  /pass(word|wd|phrase)/i,
  /密码|口令|密钥/,
  /secret/i,
  /token/i,
  /api[_-]?key/i,
  /credential/i,
  /private[_-]?key/i,
  /authorization\s*:/i,
  /bearer\s+\S+/i,
  /ssh-keygen/i,
  /BEGIN [A-Z ]*PRIVATE KEY/,
  /\bmysql\b[^\n]*\s-p\S/i,
  /\b(curl|wget)\b[^\n]*\s-u\s+\S+:\S+/i,
  /\b(set|setx|export)\s+\w*(key|token|secret|password)\w*\s*=/i,
  // ① 连接串里的 user:password@（scheme 任意：http(s)/postgres/mysql/redis/mongodb/git…；
  //    用户名可空——`redis://:pw@host`、`mongo://:pw@host` 这种只给口令的形态也算）
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]*:[^\s/@]+@/i,
  // ② 显式带头的请求里放凭据：`curl -H "X-Cred: abc"`、`wget --header='X-Api-Key: …'`、
  //    PowerShell `-Headers @{"X-Api-Key"=…}`——**头名**含敏感词才算（不是"凡是 -H 都跳"）
  /(-h|--header|-headers)\b[^\n]{0,40}?[a-z0-9-]*(cred|auth|key|token|secret|pass|cookie|session)[a-z0-9-]*["']?\s*[:=]/i,
];

/** 密码提示词：回显窗口尾部命中即判为"下一条输入是无回显口令" */
const NO_ECHO_PROMPTS: RegExp[] = [
  /password[^\n]{0,12}[:：]\s*$/i,
  /passphrase[^\n]{0,16}[:：]?\s*$/i,
  /\[sudo\]\s*password/i,
  /password for [^:]{1,64}:/i,
  /请输入密码|密码[:：]\s*$|口令[:：]\s*$/,
];

/** 不落盘原因（内存计数用；只统计，"在哪儿记了一笔"不写进历史文件本身） */
export type SkipReason =
  | "empty"
  | "sensitive_shape"
  | "no_echo"
  | "no_echo_prompt"
  | "unreconstructable"
  | "cleared";

/**
 * 清空代次（Q83，2026-09-18 审计）：`clearTerminalHistory` 每清一次就把该项目的代次 +1。
 * 排队中的命令记着**提交时**的代次，落盘前对不上就丢弃——清空是"从这一刻起重新计数"，
 * 在途命令（回显静默窗口 150ms~10s 里排着的那些）不能落回已清空的文件（改前会落回，界面
 * 提示"已清空"之后新行又冒出来）。进程内单实例即可：清空与落盘都在同一个 Node 进程里。
 */
const clearGenerations = new Map<string, number>();

/** 本项目当前的清空代次（没清过 = 0） */
function clearGenerationOf(projectId: string): number {
  return clearGenerations.get(projectId) ?? 0;
}

/** 最小 ANSI 剥离（只为"回显比对"服务；与 `src/ui/terminal/logColor.ts#stripAnsi` 同思路但独立，
 *  服务端不 import 前端模块——分层不许倒过来）。 */
const ANSI_RE =
  /\u001b\[[0-9;?<>=]*[ -/]*[@-~]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)?|\u001b[@-Z\\-_]/g;

/** 回显比对前先把"屏幕状态"压成可比较的线性文本：剥 ANSI、去控制字符与空白 */
function normalizeForEcho(s: string): string {
  return s
    .replace(ANSI_RE, "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, "");
}

function matchesAny(patterns: RegExp[], text: string): boolean {
  return patterns.some((re) => re.test(text));
}

// ── 路径（只走注册表：项目 id → `<项目根>/.工作台/logs/`） ──

/** 活跃历史文件绝对路径；项目不存在抛 PROJECT_NOT_FOUND */
export function terminalHistoryPath(projectId: string): string {
  return path.join(workstationDir(projectId), HISTORY_DIR_NAME, HISTORY_FILE_NAME);
}

/** 归档文件名前缀（`terminal-history.<ts>.jsonl`） */
const ARCHIVE_RE = /^terminal-history\.\d+\.jsonl$/;

/** 某项目日志目录下全部历史文件（归档在先、活跃在后 = 时间先后） */
export function listTerminalHistoryFiles(projectId: string): {
  active: string;
  archives: string[];
} {
  const dir = path.dirname(terminalHistoryPath(projectId));
  if (!fs.existsSync(dir)) return { active: terminalHistoryPath(projectId), archives: [] };
  const archives = fs
    .readdirSync(dir)
    .filter((f) => ARCHIVE_RE.test(f))
    .sort()
    .map((f) => path.join(dir, f));
  return { active: terminalHistoryPath(projectId), archives };
}

/** 滚动检查：活跃文件超阈值就改名归档，并裁掉最旧的归档（只动归档，不碰历史行内容） */
function rotateIfNeeded(projectId: string): void {
  const { active } = listTerminalHistoryFiles(projectId);
  if (!fs.existsSync(active)) return;
  const size = fs.statSync(active).size;
  if (size < MAX_HISTORY_BYTES) return;
  fs.renameSync(active, path.join(path.dirname(active), `terminal-history.${Date.now()}.jsonl`));
  const { archives } = listTerminalHistoryFiles(projectId);
  const excess = archives.length - MAX_HISTORY_ARCHIVES;
  for (let i = 0; i < excess; i++) fs.rmSync(archives[i], { force: true });
}

/** 追加一行（唯一写入口）。**只追加**：先滚动检查（必要时归档），再 appendFileSync */
export function appendTerminalHistoryLine(projectId: string, line: TerminalHistoryLine): void {
  const file = terminalHistoryPath(projectId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  rotateIfNeeded(projectId);
  fs.appendFileSync(file, JSON.stringify(line) + "\n", "utf8");
}

// ── 检索 / 清空 ──

export interface TerminalHistoryQueryResult {
  items: TerminalHistoryLine[];
  /** 命中的总条数（未截断前） */
  total: number;
  /** 坏行条数（跳过不报错，只计数） */
  corrupt: number;
  /** 相对项目根的活跃文件路径（绝对路径不进 HTTP 响应，界面也不需要） */
  file: string;
}

/**
 * 关键字检索（跨会话、跨 pane，按项目范围）：大小写不敏感的子串匹配，命令与 cwd 都算命中；
 * `q` 为空 = 全量。时间倒序（文件内即写入序，倒过来即最新在前），截断到 limit。
 *
 * Q46（2026-09-18 审计）：此前是"整仓全量读入 + 逐行 parse + filter + reverse + slice"——
 * limit 只截**结果**，读入量与解析出的对象数与文件大小同阶（= 1 活跃 + 5 归档 ≈ 30 MB 文本）。
 * 现在逐行流式扫（`iterFileLines`，内存 = 一块 + 一行的残片），只滚动保留**最后 limit 条命中**
 * （= 倒序后的前 limit 条，与改前的 `[...hit].reverse().slice(0, cap)` 逐条等价）；
 * `total` / `corrupt` 仍要精确，所以文件还是要从头到尾过一遍——省的是内存，不是 CPU。
 */
export function queryTerminalHistory(
  projectId: string,
  q?: string,
  limit?: number,
): TerminalHistoryQueryResult {
  const keyword = (q ?? "").trim().toLowerCase();
  const cap = limit ?? DEFAULT_HISTORY_LIMIT;
  const { active, archives } = listTerminalHistoryFiles(projectId);
  let total = 0;
  let corrupt = 0;
  /** 命中里**最后 cap 条**（升序）；超过就丢最旧的——倒序输出后正好是"最新的 limit 条" */
  const recent: TerminalHistoryLine[] = [];
  for (const file of [...archives, active]) {
    if (!fs.existsSync(file)) continue;
    for (const raw of iterFileLines(file)) {
      const text = raw.trim();
      if (text === "") continue;
      let line: TerminalHistoryLine;
      try {
        const parsed = JSON.parse(text) as TerminalHistoryLine;
        if (
          typeof parsed !== "object" ||
          parsed === null ||
          typeof parsed.ts !== "string" ||
          typeof parsed.command !== "string" ||
          // Q166（2026-09-19 二轮审计）：cwd 也在校验面内——消费点 :269 要对它调 .toLowerCase()，
          // 而 `"cwd":123` 这种坏行此前穿过校验，一到带关键词的检索就抛 TypeError，把整次检索打成
          // 永久 500（击穿的正是下面那句"不因一行坏拖垮整次检索"）。口径与 ts/command 逐字一致：
          // 非 string 且非 undefined（缺失 = 合法可选）记 corrupt 跳过，不拒读整个文件。
          (parsed.cwd !== undefined && typeof parsed.cwd !== "string")
        ) {
          corrupt++;
          continue;
        }
        line = parsed;
      } catch {
        // 半截行（写入过程中被杀）/ 手工改坏：跳过并计数，不因一行坏拖垮整次检索
        corrupt++;
        continue;
      }
      if (
        keyword &&
        !(
          line.command.toLowerCase().includes(keyword) ||
          (line.cwd ?? "").toLowerCase().includes(keyword)
        )
      ) {
        continue;
      }
      total++;
      recent.push(line);
      if (recent.length > cap) recent.shift();
    }
  }
  return {
    items: recent.reverse(), // 时间倒序
    total,
    corrupt,
    // 相对项目根的路径（`.工作台` 这个目录名只在 workstation.ts 里定义一次，这里相对化不复制）
    file: path.relative(getProject(projectId)?.path ?? path.dirname(terminalHistoryPath(projectId)), terminalHistoryPath(projectId)),
  };
}

/**
 * 清空本项目历史（隐私红线：用户必须能删）。
 * 口径：活跃文件**回空态**（截断为 0 字节，文件仍在 = 界面"历史已清空"而不是"文件不见了"），
 * 归档一并删除。返回删除条数与文件数（条数是清空前的计数）。
 *
 * Q83（2026-09-18 审计）：清空与"在途 recorder"此前毫无协同——提交后队列要等输出静默
 * （ECHO_QUIET_MS 150ms ~ MAX_PENDING_MS 10s）才落盘，用户在这个窗口里点清空，排队中的命令
 * 随后就 append 写回刚被清空的文件（界面刚提示"已清空"，刷新又有新行；远程 403 闸门也拦不住本机）。
 * 现在**第一步**就把代次 +1：排队中的命令记着提交时的代次，flush 时对不上即丢弃（计入 skipped.cleared）。
 * 清空本身仍是"截断 + 删归档"，不碰会话、不关 recorder——清空后新敲的命令照常记（代次已更新）。
 */
export function clearTerminalHistory(projectId: string): {
  removed_lines: number;
  removed_files: number;
} {
  const { active, archives } = listTerminalHistoryFiles(projectId);
  const removedLines = fs.existsSync(active)
    ? fs
        .readFileSync(active, "utf8")
        .split(/\r?\n/)
        .filter((l) => l.trim() !== "").length
    : 0;
  // 先换代次、再截断：这一步之后任何在途批次都不会再写回本文件
  clearGenerations.set(projectId, clearGenerationOf(projectId) + 1);
  fs.mkdirSync(path.dirname(active), { recursive: true });
  fs.writeFileSync(active, "", "utf8"); // 回空态：文件仍在、内容为 0 字节
  for (const f of archives) fs.rmSync(f, { force: true });
  return { removed_lines: removedLines, removed_files: archives.length };
}

// ── 按键流 → 命令行（行编辑重放） ──

function isCsiComplete(s: string): boolean {
  if (s.length < 3) return false;
  const last = s.charCodeAt(s.length - 1);
  return last >= 0x40 && last <= 0x7e;
}

function escapeComplete(s: string): boolean {
  if (s.length < 2) return false;
  const second = s[1];
  if (second === "[" || second === "O") return isCsiComplete(s);
  return true; // ESC + 单字节（Alt+键 等）
}

/** 一条待落盘命令（回显要等 shell 吐出来才能判，故先入队、静默后统一处理） */
interface PendingCommand {
  command: string;
  commitAt: number;
  /** 执行这条命令时的 cwd（本条的 `cd` 影响的是下一条，故提交时快照） */
  cwd: string;
  /** 本行动过光标 → 跳过回显比对（终端回显是屏幕状态，线性包含不成立） */
  edited: boolean;
  /** 回车后有没有新输出（决定 duration_ms 是否为 null） */
  seenOutput: boolean;
  /** 提交那一刻的回显窗口尾巴：密码提示词判定用（`Password:` 就是在这一步之前打出来的） */
  promptTail: string;
  /** 提交时的清空代次（Q83）：与 flush 时的代次对不上即丢弃——清空后不再把在途命令写回已清空的文件 */
  generation: number;
}

/** 会话级记录器：一个 PTY 会话一个实例，喂按键流 + 输出流，自己攒行、自己落盘 */
export class TerminalHistoryRecorder {
  private buffer = "";
  private cursor = 0;
  /** 本行用到了"看不见的重建"（↑/↓ 召回、Tab 补全）→ 不落盘 */
  private unreconstructable: string | null = null;
  /** 本行动过光标（←/→/Home/End/DEL）→ 跳过回显比对 */
  private cursorEdited = false;
  private esc = "";
  private echoBuf = "";
  /**
   * 待落盘队列（按提交顺序）。**为什么是队列而不是单条**：前端一敲一 POST，命令可以连着来，
   * 而 shell 的回显总落后于我们的提交——若"下一条命令提交时就把上一条拿去落盘"，上一条的回显
   * 往往还没到，就会把正常命令误判成"无回显"而漏记（施工冒烟实测踩到：连发 6 条只落了 2 条）。
   * 改成：全部入队，**输出静默 ECHO_QUIET_MS 后一起判**——那时这一批的回显都在窗口里了。
   */
  private queue: PendingCommand[] = [];
  private lastOutputAt = 0;
  private quietTimer: ReturnType<typeof setTimeout> | null = null;
  private warned = false;
  /** 内存计数（只统计"跳过了几条、因为什么"，不落盘敏感原文） */
  readonly skipped: Record<SkipReason, number> = {
    empty: 0,
    sensitive_shape: 0,
    no_echo: 0,
    no_echo_prompt: 0,
    unreconstructable: 0,
    cleared: 0,
  };
  readonly recorded = { count: 0 };

  constructor(
    private readonly sessionId: string,
    private readonly projectId: string,
    private cwd: string,
  ) {}

  /** 喂 PTY 输出（只用于：① 回显比对/密码提示词判定；② duration_ms 的结束时刻） */
  feedOutput(data: string): void {
    this.lastOutputAt = Date.now();
    this.echoBuf = (this.echoBuf + data).slice(-ECHO_WINDOW_MAX);
    if (this.queue.length > 0) {
      for (const p of this.queue) p.seenOutput = true;
      this.armQuiet();
    }
  }

  /** 喂键盘输入（`writeTerminal` 的唯一调用点）：按行编辑重放，回车即提交 */
  feedInput(data: string): void {
    for (const ch of data) {
      if (this.esc !== "") {
        this.esc += ch;
        if (this.esc.length > 32 || escapeComplete(this.esc)) {
          this.applyEscape(this.esc);
          this.esc = "";
        }
        continue;
      }
      if (ch === "\u001b") {
        this.esc = "\u001b";
        continue;
      }
      this.applyChar(ch);
    }
  }

  /** 关会话/进程退出前落盘（不留半条命令） */
  close(): void {
    this.flushQueue();
    if (this.quietTimer !== null) clearTimeout(this.quietTimer);
    this.quietTimer = null;
  }

  private resetLine(): void {
    this.buffer = "";
    this.cursor = 0;
    this.unreconstructable = null;
    this.cursorEdited = false;
  }

  private applyChar(ch: string): void {
    const code = ch.charCodeAt(0);
    if (ch === "\r" || ch === "\n") {
      this.commit();
      return;
    }
    if (ch === "\u007f" || ch === "\b") {
      // 退格 / DEL：删光标前一个字符（cmd 与控制台默认语义）
      if (this.cursor > 0) {
        this.buffer = this.buffer.slice(0, this.cursor - 1) + this.buffer.slice(this.cursor);
        this.cursor--;
      }
      return;
    }
    if (ch === "\u0003") {
      this.resetLine(); // Ctrl-C：弃行
      return;
    }
    if (ch === "\u0015") {
      this.buffer = "";
      this.cursor = 0;
      return;
    }
    if (ch === "\u000b") {
      this.buffer = this.buffer.slice(0, this.cursor); // Ctrl-K：删光标后
      return;
    }
    if (ch === "\u0001") {
      this.cursor = 0;
      this.cursorEdited = true;
      return;
    }
    if (ch === "\u0005") {
      this.cursor = this.buffer.length;
      this.cursorEdited = true;
      return;
    }
    if (ch === "\u0017") {
      // Ctrl-W：删光标前一个词（cmd 的 ^W 就是删词）
      const head = this.buffer.slice(0, this.cursor).replace(/\S*\s*$/, "");
      this.buffer = head + this.buffer.slice(this.cursor);
      this.cursor = head.length;
      return;
    }
    if (ch === "\t") {
      this.unreconstructable = "tab_completion"; // shell 补全会插进我们看不见的文本
      return;
    }
    if (code < 0x20) return; // 其余控制键不改行内容（F1…、Ctrl-D 之类）
    this.buffer = this.buffer.slice(0, this.cursor) + ch + this.buffer.slice(this.cursor);
    this.cursor += 1;
  }

  private applyEscape(seq: string): void {
    const s = seq.replace("O", "[");
    switch (s) {
      case "\u001b[D": // ←
        this.cursor = Math.max(0, this.cursor - 1);
        this.cursorEdited = true;
        return;
      case "\u001b[C": // →
        this.cursor = Math.min(this.buffer.length, this.cursor + 1);
        this.cursorEdited = true;
        return;
      case "\u001b[H":
      case "\u001b[1~":
        this.cursor = 0;
        this.cursorEdited = true;
        return;
      case "\u001b[F":
      case "\u001b[4~":
        this.cursor = this.buffer.length;
        this.cursorEdited = true;
        return;
      case "\u001b[3~": // Delete
        if (this.cursor < this.buffer.length) {
          this.buffer = this.buffer.slice(0, this.cursor) + this.buffer.slice(this.cursor + 1);
        }
        this.cursorEdited = true;
        return;
      case "\u001b[A":
      case "\u001b[B":
        // ↑ / ↓ 召回历史：shell 会插进我们看不见的文本，重建不出来 → 本行不落盘
        this.unreconstructable = "history_recall";
        return;
      case "\u001b[200~":
      case "\u001b[201~":
        return; // 括号粘贴的起止标记：粘贴正文照常按字符处理
      default:
        return; // F1…F12 / PageUp 等功能键：不改行内容
    }
  }

  private commit(): void {
    const command = this.buffer;
    const unreconstructable = this.unreconstructable;
    const edited = this.cursorEdited;
    this.resetLine();
    if (unreconstructable !== null) {
      this.skipped.unreconstructable++;
      return;
    }
    if (command.trim() === "") {
      this.skipped.empty++;
      return;
    }
    if (matchesAny(SENSITIVE_SHAPES, command)) {
      this.skipped.sensitive_shape++;
      return;
    }
    const cwdAtCommit = this.cwd;
    this.trackCwd(command);
    this.queue.push({
      command,
      commitAt: Date.now(),
      // cwd 取**执行这条命令时**的目录（本条的 cd 影响的是下一条）
      cwd: cwdAtCommit,
      edited,
      seenOutput: false,
      promptTail: normalizeForEcho(this.echoBuf).slice(-PROMPT_TAIL),
      generation: clearGenerationOf(this.projectId), // Q83：清空之后这批就不作数了
    });
    this.armQuiet();
  }

  /**
   * cwd 尽力跟踪：只认"整条就是 cd/ chdir "且目标路径解析后仍在项目根内；
   * 用到了 shell 变量、通配、多重命令（& | > 等）一律不跟（不猜），越出项目根也不跟。
   */
  private trackCwd(command: string): void {
    const m = /^\s*cd(?:\s+|\s*\/d\s+)?(.+?)\s*$/i.exec(command);
    if (!m) return;
    const arg = m[1].replace(/^"|"$/g, "");
    if (arg === "" || /[&|<>%^*$`]/.test(arg)) return;
    const root = this.projectRoot();
    if (root === null) return;
    const next = path.resolve(this.cwd, arg);
    if (next !== root && !next.startsWith(root + path.sep)) return;
    if (!fs.existsSync(next)) return;
    this.cwd = next;
  }

  private projectRoot(): string | null {
    const project = getProject(this.projectId);
    return project ? project.path : null;
  }

  /** 静默计时：输出每来一段就续一次；逼近 MAX_PENDING_MS 时按剩余时间收口（长命命令不至于不落盘） */
  private armQuiet(): void {
    const oldest = this.queue[0];
    if (!oldest) return;
    const left = Math.max(0, oldest.commitAt + MAX_PENDING_MS - Date.now());
    const delay = Math.min(ECHO_QUIET_MS, left);
    if (this.quietTimer !== null) clearTimeout(this.quietTimer);
    this.quietTimer = setTimeout(() => {
      this.quietTimer = null;
      this.flushQueue();
    }, delay);
    this.quietTimer.unref?.();
  }

  /**
   * 整批落盘判定（三类跳过见文件头注释），**按提交顺序**逐条判：
   *  ① 提交那一刻的回显尾巴里有密码提示词（`Password:` / `[sudo] password` / `密码：`）→ 判为无回显口令，跳过；
   *  ② 没动过光标、且这一批的回显窗口里找不到这条命令 → 无回显（口令类），跳过；
   *  ③ 动过光标的行不做回显比对（终端回显是屏幕状态，线性包含不成立），靠 ① 与敏感形态两条兜。
   */
  private flushQueue(): void {
    const batch = this.queue;
    if (batch.length === 0) return;
    this.queue = [];
    if (this.quietTimer !== null) clearTimeout(this.quietTimer);
    this.quietTimer = null;
    const window = normalizeForEcho(this.echoBuf);
    this.echoBuf = "";
    const generationNow = clearGenerationOf(this.projectId);
    for (const p of batch) {
      // Q83：这批命令提交之后用户清空过历史 → 丢弃（否则会 append 回刚被清空的文件）
      if (p.generation !== generationNow) {
        this.skipped.cleared++;
        continue;
      }
      if (matchesAny(NO_ECHO_PROMPTS, p.promptTail)) {
        this.skipped.no_echo_prompt++;
        continue;
      }
      if (!p.edited && !window.includes(normalizeForEcho(p.command))) {
        this.skipped.no_echo++;
        continue;
      }
      const line: TerminalHistoryLine = {
        ts: toIso(new Date(p.commitAt)),
        project_id: this.projectId,
        session_id: this.sessionId,
        cwd: p.cwd,
        command: p.command,
        duration_ms: p.seenOutput ? Math.max(0, this.lastOutputAt - p.commitAt) : null,
      };
      try {
        appendTerminalHistoryLine(this.projectId, line);
        this.recorded.count++;
      } catch (e) {
        // 落盘失败（目录被删/无权限/磁盘满）绝不拖垮终端通道：打一次警告，之后静默
        if (!this.warned) {
          this.warned = true;
          console.error(`[terminal-history] 项目 ${this.projectId} 历史落盘失败（后续静默）: ${(e as Error).message}`);
        }
      }
    }
  }
}

/** 本地 ISO 串（与 `./time#nowIso` 同格式：带时区偏移，不是 UTC Z 串） */
