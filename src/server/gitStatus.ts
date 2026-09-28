// ═══════════════════════════════════════════════════════════════════════════════════
// V06-12 Git 保存版本提醒：**只读** Git 探测 + 提醒派生（DESIGN.md §3.15 / §8.5 / §3.9；PLAN.md V06-12）。
//
// §3.15 逐句落到本文件：
//   · 「本地提交成功、远端同步与私有事实备份分开」→ 三段各答一件事：`head`（实际 HEAD 与工作树）、
//     `tracking_observation`（**只读**的最近已知跟踪状态 + 观测时间）、`private_backup_known`
//     （`.工作台/` 是否已备份）。
//   · 「远端仅显示最近已知跟踪状态及时间，不做隐式 fetch、联网、认证或推送，无法确认标未知」
//     → 远端段只读**本地引用**（`origin/main` 这类 remote-tracking ref 就是上一次 fetch 的遗留事实），
//       探测里根本没有 fetch/pull/push 这类子命令可跑；对不上就是 `unknown`。
//   · 「不自动执行 git add/commit/push，不修改 Git 配置或工作树」→ 全部命令走 `runGitReadOnly`，
//       子命令必须在只读白名单里，写子命令一律抛 `E_GIT_WRITE_FORBIDDEN`；argv 是**固定数组**，
//       一律 `execFile('git', argv)`（无 shell），任何进 argv 的动态片段（分支名/上游名）先过形状校验。
//   · 「不是仓库时明确未使用 Git，不擅自初始化」→ `repository.is_repository=false` + `note`，
//       探测里没有 `git init` 这条路。
//   · 「`.工作台/` 通常被忽略，其聊天、任务和证据不能因为代码提交就显示已备份」→ `private_backup_known`
//       把「Git 忽略了这个目录」「代码已提交」当**事实**报出来，而 `backed_up` 只可能是 `unknown`
//       （`backup_flow_available` 回答的是**另一个问题**：这台机器上有没有显式备份/恢复流程）。
//       V09-06 起该流程**已交付** ⇒ `backup_flow_available: true`；但**入口可用不等于已经备份过**，
//       所以 `backed_up` 仍然只报 `unknown`（谁也不能拿"有入口""进了 Git"当已备份）。
//   · 「只读探测失败不当作干净」→ 探测失败时 `staged/modified/untracked/conflicted` 是 **null 而不是
//       空数组**（空数组＝"确实干净"，null＝"不知道"），`error` 如实带码与原因。
//
// ██ 踩过的坑（必须记住，不许改回去）██
//   裸跑 `git status` **会写 `.git/index`**：git 会顺手把刷新后的 stat 缓存写回索引文件（实测
//   `.git/index` 的 mtime 与 md5 都变了）。本卡的红线是"探测前后 HEAD/索引/工作树一个字节都没变"，
//   所以每条命令都带全局 `--no-optional-locks`，并且子进程 env 里置 `GIT_OPTIONAL_LOCKS=0`（双保险，
//   老版本 git 只认环境变量）；实测两者任一即可让索引零写入。
//
// 本文件分两段：**A. 只读探测**（`inspectGitStatus`，输出契约就是 PLAN 点名的那些字段）
// 与 **B. 提醒派生**（`changeFingerprint` / `buildVersionReminder`，把探测结果 + 项目自己的成果
// 事实折成界面直接渲染的一份数据）。B 不新增第三个文件是刻意的：卡面「文件责任」只给了
// `src/server/gitStatus.ts` 与 `src/ui/components/VersionReminder.tsx`，把派生塞进 `server/index.ts`
// 才是真的跑偏（约定明说"避免继续把业务塞进 server/index.ts"）。
//
// ██████████ 补修包 D（2026-09-20，主责 V06-12，复用 V06-09 的证据有效性规则）██████████
// GPT-6 裁定：「`changed_files` 与改动路径相交只说明**可能有关**；证据在册且哈希完整只说明
// **证据可取回且未损坏**；两者都不能证明**检查通过**」。旧实现的两处判定（`relatedOutcomes`
// 的"有相关提交＋至少一条完整证据" = 通过；`buildVersionReminder` 的"工作树干净"直接 = 通过）
// 已删掉，改为按下面六条口径判（落在 `assessBatchVerification`，输出 `ReminderVerification`）：
//   ① **说清声明范围**：哪批成果（candidate submissions）/ 哪些路径（`declared.paths`）/
//      哪些必需检查（`declared.required_checks`，来自任务定义，**不空集判绿**）；
//   ② 通过要有**真实通过结果**（检查记录的 `result === "passed"`）+ **覆盖声明范围**
//      （`coverage.covered_paths ⊇ declared.paths`）+ 证据**完整且当前有效**（在册且哈希复核通过）
//      + **无未收口阻断**（`blockers` 空）；
//   ③ **绑定当前实际内容版本（含未提交改动）**：`contentVersionOf()` 按**文件内容**现算指纹，
//      检查记录的 `binding`（`revision_kind: "code"`）必须等于**它声明范围**的当前内容指纹 ——
//      文件名相同、HEAD 相同、或"最近一次成果提交"都**不算**覆盖（同路径再改一次 → 指纹变 → 撤销通过）；
//   ④ **只覆盖部分改动**时状态是 `partially_covered`：输出已覆盖与未验证范围，不宣称整批通过；
//   ⑤ **自检 / 独立审计 / 用户接受分开记**（`records` 三段）：检查通过**不得**扩写成"已验收"；
//   ⑥ **工作树干净只表示"没有待保存改动"**：干净树的验证状态走同一条判定（对最近一次成果算），
//      **没有验证证据就是 `unverified`**，不再直接写"已通过必要检查"。
// 判定依据逐条随输出带出（`checks[]`：记录来源 `record_ref` / 复核结论 / 绑定版本 / 当前内容版本 /
// 独立性 / 证据哈希），人能顺着追到原文与证据。
// ═══════════════════════════════════════════════════════════════════════════════════
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { nowIso, parseIsoMs, compareIsoTime } from "./time";
// `.工作台/` 目录名的唯一来源（§2.2 / §8.1）；不在本文件再写一份字面量
import { WORKBENCH_DIRNAME } from "./work/documents";
import type { RevisionKind } from "./work/evidence";
// 补修 D：**复用 V06-09 的证据有效性规则**（`checkEffectiveness`：绑定修订 ≠ 当前修订 → 撤销通过）
// 与检查记录形态（`CheckInput`，来自 `checksFromAudit`），不另造一套平行判据。
import { checkEffectiveness, type CheckInput } from "./work/statusProjection";

/** 单条只读命令的超时（毫秒）：探测不许把关不上的仓库拖死请求 */
export const GIT_PROBE_TIMEOUT_MS = 8000;
/** 命令输出上限（`git status -z` 在大仓库上可能很大；超了如实报错，不悄悄截断后当完整） */
export const GIT_PROBE_MAX_BUFFER = 32 * 1024 * 1024;

// ───────────────────────────── A-1 只读白名单与固定 argv ─────────────────────────────

/** 允许出现的 git 子命令（**只有这些**；每个都无写状态语义） */
export const GIT_READ_ONLY_SUBCOMMANDS = [
  "status",
  "rev-parse",
  "rev-list",
  "for-each-ref",
  "check-ignore",
  "ls-files",
] as const;

export type GitReadOnlySubcommand = (typeof GIT_READ_ONLY_SUBCOMMANDS)[number];

/**
 * 明令禁止的子命令（运行期只要出现在 argv 里就抛错）。
 * 这份清单是**运行期闸门**，不是"扫源码找字符串"——源码里当然会出现这些词（就在这个数组里），
 * 所以验证脚本查的是 argv 而不是裸文本（见 `scripts/verify-v06-12.ts` 段②）。
 * `symbolic-ref` 也在列：带一个 ref 参数就是**写**，读分支名的活儿由 `rev-parse` 干。
 */
export const GIT_WRITE_SUBCOMMANDS = [
  "add",
  "commit",
  "push",
  "pull",
  "fetch",
  "checkout",
  "switch",
  "restore",
  "reset",
  "rm",
  "mv",
  "stash",
  "init",
  "config",
  "clean",
  "merge",
  "rebase",
  "cherry-pick",
  "revert",
  "tag",
  "branch",
  "symbolic-ref",
  "update-index",
  "update-ref",
  "write-tree",
  "commit-tree",
  "read-tree",
  "apply",
  "am",
  "gc",
  "prune",
  "worktree",
  "remote",
  "submodule",
  "reflog",
  "replace",
  "filter-branch",
  "fast-import",
] as const;

/** 探测失败/被闸门拒绝时抛它（路由层按 code 回结构化错误） */
export class GitProbeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "GitProbeError";
    this.code = code;
  }
}

/**
 * 固定 argv 清单（**本模块唯一允许跑的命令全集**）。`<…>` 是占位符：运行期由 `gitArgv…()` 填
 * 真实值，且填进去的片段先过 `assertSafeGitToken`（不以 `-` 开头、无控制字符），防"数据被当选项"。
 */
export interface GitReadOnlyCommand {
  id: string;
  subcommand: GitReadOnlySubcommand;
  argv: readonly string[];
  note: string;
}

export const GIT_READ_ONLY_COMMANDS: readonly GitReadOnlyCommand[] = [
  {
    id: "inside-work-tree",
    subcommand: "rev-parse",
    argv: ["--no-optional-locks", "rev-parse", "--is-inside-work-tree"],
    note: "这个目录在不在 Git 工作树里（不是仓库时的唯一判据，探测里没有 git init）",
  },
  {
    id: "toplevel",
    subcommand: "rev-parse",
    argv: ["--no-optional-locks", "rev-parse", "--show-toplevel"],
    note: "工作树根（后续命令一律在根上跑，路径口径才是仓库根相对、不受 status.relativePaths 影响）",
  },
  {
    id: "head",
    subcommand: "rev-parse",
    argv: ["--no-optional-locks", "rev-parse", "--verify", "--quiet", "HEAD"],
    note: "实际 HEAD 提交；空仓库（unborn）如实取不到",
  },
  {
    id: "head-ref",
    subcommand: "rev-parse",
    argv: ["--no-optional-locks", "rev-parse", "--abbrev-ref", "HEAD"],
    note: "当前分支名；游离头回 `HEAD`，空仓库回 `HEAD` 且退出码非 0",
  },
  {
    id: "status",
    subcommand: "status",
    argv: ["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all"],
    note: "暂存/未暂存/未跟踪/冲突的机器可读清单（-z：路径原样给，空格与中文不会被转义或切断）",
  },
  {
    id: "upstream",
    subcommand: "for-each-ref",
    argv: ["--no-optional-locks", "for-each-ref", "--format=%(upstream:short)", "refs/heads/<branch>"],
    note: "本地分支配置的上游名（空输出＝没有上游；只读本地配置与引用，不联网）",
  },
  {
    id: "ahead-behind",
    subcommand: "rev-list",
    argv: ["--no-optional-locks", "rev-list", "--left-right", "--count", "<upstream>...HEAD"],
    note: "相对本地记录的远端引用差几个提交（左=落后/右=领先）；不 fetch，结论只基于本地引用",
  },
  {
    id: "workbench-ignored",
    subcommand: "ls-files",
    argv: ["--no-optional-locks", "ls-files", "--others", "--ignored", "--exclude-standard", "-z", "--", "<dir>/"],
    note: "`.工作台/` 下被忽略的文件清单（读忽略语义的只读方式；忽略≠已备份）",
  },
  {
    id: "workbench-tracked",
    subcommand: "ls-files",
    argv: ["--no-optional-locks", "ls-files", "-z", "--", "<dir>/"],
    note: "`.工作台/` 下已被 Git 跟踪的文件清单（正常应为空）",
  },
  {
    id: "workbench-check-ignore",
    subcommand: "check-ignore",
    argv: ["--no-optional-locks", "check-ignore", "-q", "--", "<dir>/"],
    note: "`.工作台/` 是否命中忽略规则（退出码 0=被忽略、1=没被忽略、其它=探测失败）",
  },
];

/** 动态片段进 argv 前的形状校验：不许以 `-` 开头（防当选项）、不许有空白与控制字符 */
export function assertSafeGitToken(token: string, what: string): string {
  if (token === "" || token.startsWith("-") || /[\0\r\n\s]/.test(token)) {
    throw new GitProbeError("E_GIT_PROBE_ARGS", `不允许把 ${what} 当命令片段：${JSON.stringify(token)}`);
  }
  return token;
}

/**
 * 运行期闸门：argv 必须是固定形态（全局只读开关 + 白名单子命令 + 非写子命令）。
 * 抛错而不是"兜住继续跑"——拼错命令要炸在调用点上，不能悄悄换一个跑。
 * 判定顺序：**先认写子命令**（那时错误码最具体，直接告诉你"这是写操作"），再看白名单。
 */
export function assertReadOnlyGitArgv(argv: readonly string[]): void {
  if (argv.length < 2) {
    throw new GitProbeError("E_GIT_PROBE_ARGS", `argv 太短：${JSON.stringify(argv)}`);
  }
  if (argv[0] !== "--no-optional-locks") {
    throw new GitProbeError(
      "E_GIT_PROBE_ARGS",
      `只读探测必须带全局 --no-optional-locks（否则 git status 会写 .git/index）：${JSON.stringify(argv)}`,
    );
  }
  const sub = argv[1];
  if ((GIT_WRITE_SUBCOMMANDS as readonly string[]).includes(sub)) {
    throw new GitProbeError("E_GIT_WRITE_FORBIDDEN", `只读探测里出现写子命令：${JSON.stringify(sub)}`);
  }
  if (!(GIT_READ_ONLY_SUBCOMMANDS as readonly string[]).includes(sub)) {
    throw new GitProbeError("E_GIT_PROBE_ARGS", `子命令不在只读白名单里：${JSON.stringify(sub)}`);
  }
  for (const arg of argv.slice(2)) {
    if ((GIT_WRITE_SUBCOMMANDS as readonly string[]).includes(arg)) {
      throw new GitProbeError("E_GIT_WRITE_FORBIDDEN", `只读探测里出现写子命令：${JSON.stringify(arg)}`);
    }
  }
}

export interface GitRunResult {
  /** 进程是否正常退出（exit code 0） */
  ok: boolean;
  /** 退出码（进程起不来时为 null） */
  status: number | null;
  stdout: string;
  stderr: string;
  /** 进程起不来（找不到 git / 目录不存在）时的原因 */
  spawn_error: string | null;
}

/** 跑一条**只读** git 命令：固定 argv + 无 shell + 只读锁关闭 + 超时 */
export function runGitReadOnly(cwd: string, argv: readonly string[]): Promise<GitRunResult> {
  assertReadOnlyGitArgv(argv);
  return new Promise((resolve) => {
    execFile(
      "git",
      [...argv],
      {
        cwd,
        timeout: GIT_PROBE_TIMEOUT_MS,
        maxBuffer: GIT_PROBE_MAX_BUFFER,
        windowsHide: true,
        encoding: "utf8",
        // 双保险：老版本 git 不认 `--no-optional-locks`，但认这个环境变量（`status` 的索引刷新写入
        // 归它管）；另外关掉交互式凭据提示——探测不该弹任何东西。
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat" },
      },
      (err, stdout, stderr) => {
        if (err === null) {
          resolve({ ok: true, status: 0, stdout, stderr, spawn_error: null });
          return;
        }
        const e = err as NodeJS.ErrnoException & { code?: unknown; stdout?: string; stderr?: string };
        const exitCode = typeof e.code === "number" ? e.code : null;
        resolve({
          ok: false,
          status: exitCode,
          stdout: typeof e.stdout === "string" ? e.stdout : stdout,
          stderr: typeof e.stderr === "string" ? e.stderr : stderr,
          spawn_error: exitCode === null ? e.message : null,
        });
      },
    );
  });
}

// 固定 argv 的取用点（动态片段一律经 assertSafeGitToken）
const argvOf = (id: string): readonly string[] => {
  const found = GIT_READ_ONLY_COMMANDS.find((c) => c.id === id);
  if (found === undefined) throw new GitProbeError("E_GIT_PROBE_ARGS", `没有这条只读命令：${id}`);
  return found.argv;
};

export const gitArgvInsideWorkTree = (): string[] => [...argvOf("inside-work-tree")];
export const gitArgvTopLevel = (): string[] => [...argvOf("toplevel")];
export const gitArgvHead = (): string[] => [...argvOf("head")];
export const gitArgvHeadRef = (): string[] => [...argvOf("head-ref")];
export const gitArgvStatus = (): string[] => [...argvOf("status")];
export const gitArgvWorkbenchIgnored = (dir: string = WORKBENCH_DIRNAME): string[] => [
  ...argvOf("workbench-ignored").slice(0, -1),
  `${assertSafeGitToken(dir, "目录名")}/`,
];
export const gitArgvWorkbenchTracked = (dir: string = WORKBENCH_DIRNAME): string[] => [
  ...argvOf("workbench-tracked").slice(0, -1),
  `${assertSafeGitToken(dir, "目录名")}/`,
];
export const gitArgvWorkbenchCheckIgnore = (dir: string = WORKBENCH_DIRNAME): string[] => [
  ...argvOf("workbench-check-ignore").slice(0, -1),
  `${assertSafeGitToken(dir, "目录名")}/`,
];
export const gitArgvUpstream = (branch: string): string[] => [
  ...argvOf("upstream").slice(0, -1),
  `refs/heads/${assertSafeGitToken(branch, "分支名")}`,
];
export const gitArgvAheadBehind = (upstream: string): string[] => [
  ...argvOf("ahead-behind").slice(0, -1),
  `${assertSafeGitToken(upstream, "上游名")}...HEAD`,
];

// ───────────────────────────── A-2 `git status --porcelain=v1 -z` 解析 ─────────────────────────────

export interface StatusBuckets {
  /** 索引相对 HEAD 有改动（`X` 位非空） */
  staged: string[];
  /** 工作树相对索引有改动（`Y` 位非空） */
  modified: string[];
  /** 未跟踪（`??`） */
  untracked: string[];
  /** 冲突/未合并（`AA/DD/AU/UA/DU/UD/UU`） */
  conflicted: string[];
}

/** `-z` 记录里 XY 两位的取值 → 冲突态（§3.15「检查……冲突」；merge/rebase 冲突就落在这些码上） */
const CONFLICT_CODES = new Set(["AA", "DD", "AU", "UA", "DU", "UD", "UU"]);

/**
 * 解析 `git status --porcelain=v1 -z`。
 *
 * 为什么必须 `-z`：非 -z 形态会把含特殊字符的路径**加引号并转义**（中文变八进制、空格变 `\"…\"`），
 * 再拿出去就跟文件系统上的名字对不上；`-z` 的路径是原样字节，空格/中文/换行都不会被切断。
 * `-z` 下改名/复制记录是 `XY 新路径\0旧路径\0`（没有 `->`），所以 R/C 要多消费一格。
 */
export function parsePorcelainV1Z(stdout: string): StatusBuckets {
  const out: StatusBuckets = { staged: [], modified: [], untracked: [], conflicted: [] };
  const records = stdout.split("\0");
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    if (rec === "") continue;
    const xy = rec.slice(0, 2);
    const file = rec.slice(3);
    if (xy === "??") {
      out.untracked.push(file);
      continue;
    }
    if (xy === "!!") continue; // 本探测不请求 --ignored，出现也归"忽略"，不进任何"改动"桶
    if (CONFLICT_CODES.has(xy)) {
      out.conflicted.push(file);
      continue;
    }
    // 改名/复制：多一格是原路径（我们只关心"现在叫这个名字"的新路径，但要把它吃掉，
    // 否则原路径会被当成下一条记录解析出鬼来）
    if (xy.includes("R") || xy.includes("C")) i++;
    if (xy[0] !== " ") out.staged.push(file);
    if (xy[1] !== " ") out.modified.push(file);
  }
  return out;
}

// ───────────────────────────── A-3 输出契约（PLAN 点名的那几个字段，一字不多） ─────────────────────────────

export interface GitRepositoryObservation {
  /** 是不是 Git 工作树（false = §3.15「明确未使用 Git」，探测里没有初始化这条路） */
  is_repository: boolean;
  /** 工作树根（绝对路径；不是仓库时为 null） */
  root: string | null;
  /** 相对项目根的工作树位置（`"."` = 项目根就是工作树根；子目录项目会给出相对路径） */
  relative_to_project: string | null;
  /** 路径口径说明（所有路径都是**工作树根相对**，不受 status.relativePaths 配置影响） */
  path_base: "worktree_root" | "unknown";
  note: string;
}

export interface GitHeadObservation {
  /** 实际 HEAD 提交（unborn 时为 null） */
  commit: string | null;
  /** 短 sha（7 位；commit 为 null 时也是 null） */
  short: string | null;
  /** 当前分支名；游离头为 null（detached=true）、unborn 为 null（unborn=true） */
  branch: string | null;
  /** 游离头（HEAD 直接指向提交） */
  detached: boolean;
  /** 空仓库：还没有任何提交（HEAD 指不到东西） */
  unborn: boolean;
  note: string;
}

/**
 * 远端**只在本地已知范围内**作答：读的是本地 remote-tracking 引用（上次 fetch 留下来的事实），
 * 不联网、不认证、不推送。确认不了就 `unknown`。
 */
export interface GitTrackingObservation {
  upstream: string | null;
  state: "no_upstream" | "up_to_date" | "ahead" | "behind" | "diverged" | "unknown";
  ahead: number | null;
  behind: number | null;
  /** 观测时间（= 本次探测时间；读数来自本地引用，不是"刚刚联网核实过"） */
  observed_at: string;
  /** 结论依据：只有本地引用 */
  basis: "local_refs_only";
  /** 是否做过隐式 fetch（恒为 false，且探测里没有 fetch 这条路） */
  fetched: false;
  note: string;
}

/**
 * 「本机显式备份/恢复流程」的现状（V09-06 起**已交付**）。
 *
 * 这两句是**能力**与**事实**的分界，四处报同一件事的地方都引用它，避免各写一遍走形：
 *   · 能力：这台机器上有没有显式备份/恢复流程 → 有（V09-06 的产品入口：项目信息页可创建一致备份、
 *     只在事件提交边界上取一致切片、只恢复到隔离目录；一致切片语义复用 V06-14）；
 *   · 事实：`.工作台/` 到底备份过没有 → **不知道**（本模块只读 Git 探测，没有读备份账目的资格）。
 * 「有入口」既不能推出"已备份"，也不能被"代码提交了"顶替。
 */
const BACKUP_FLOW_NOTE =
  "本机显式备份/恢复流程已交付（V09-06：在「项目信息」页可创建一致备份并恢复到隔离目录，" +
  "一致切片语义复用 V06-14）——但入口可用不等于这份私有事实已被备份";

/**
 * `.工作台/` 是否已备份。**只可能是 `unknown`**：本模块只读 Git 探测，推断不出"备份过没有"——
 * 入口在不在（`backup_flow_available`，V09-06 起为 `true`）与"这份私有事实是否真被备份过"是两件事。
 * 这里能做的是把三条常被混淆的事实分开摆出来——「Git 忽略了这个目录」「代码已保存为本地版本」
 * 「本机有备份入口」——它们都不等于「私有事实已备份」。
 */
export interface GitPrivateBackupObservation {
  workbench_dir: string;
  /** `.工作台/` 目录在不在盘上 */
  exists: boolean;
  /** 是否命中 Git 忽略规则（null = 探测失败/不是仓库） */
  ignored_by_git: boolean | null;
  /** 被忽略的文件数（读忽略范围的只读方式；null = 探测失败） */
  ignored_file_count: number | null;
  /** 已被 Git 跟踪的文件数（正常为 0；非 0 是"私有事实进了版本库"的硬事实） */
  tracked_file_count: number | null;
  /** 代码是否已保存为本地 Git 版本（HEAD 与工作树一致） */
  code_committed: boolean | null;
  /** 私有事实是否已备份——**只有 unknown**（不伪造已备份） */
  backed_up: "unknown";
  /** 本机显式备份/恢复流程是否可用：**V09-06 起恒为 true**（入口已交付；它不等于"已经备份过"） */
  backup_flow_available: true;
  reason: string;
}

export interface GitProbeFailure {
  code: string;
  message: string;
  /** 失败时跑的是哪条只读命令（给排查用） */
  command_id: string | null;
}

/** `inspectGitStatus` 的返回体 = PLAN 点名的契约字段（探测成功/失败都长这样，字段不增不减） */
export interface GitStatusReport {
  repository: GitRepositoryObservation;
  detected_at: string;
  head: GitHeadObservation;
  /** 以下四桶：**null = 没探测成功（不知道）**，`[]` = 确实干净——两者不许合并 */
  staged: string[] | null;
  modified: string[] | null;
  untracked: string[] | null;
  conflicted: string[] | null;
  tracking_observation: GitTrackingObservation;
  private_backup_known: GitPrivateBackupObservation;
  /** 只读探测失败如实报错（§3.15「只读探测失败不当作干净」）；没失败就是 null */
  error: GitProbeFailure | null;
}

// ───────────────────────────── A-4 探测实现 ─────────────────────────────

const firstLine = (s: string): string => s.split(/\r?\n/).find((l) => l.trim() !== "")?.trim() ?? "";

/** 四桶里"有改动"的文件数（同一个路径同时暂存与未暂存时算两次，与桶各自的语义一致） */
export const dirtyCountOf = (b: StatusBuckets): number =>
  b.staged.length + b.modified.length + b.untracked.length + b.conflicted.length;

function privateBackupUnknown(reason: string, exists: boolean): GitPrivateBackupObservation {
  return {
    workbench_dir: WORKBENCH_DIRNAME,
    exists,
    ignored_by_git: null,
    ignored_file_count: null,
    tracked_file_count: null,
    code_committed: null,
    backed_up: "unknown",
    backup_flow_available: true,
    reason,
  };
}

function trackingUnknown(observedAt: string, note: string): GitTrackingObservation {
  return {
    upstream: null,
    state: "unknown",
    ahead: null,
    behind: null,
    observed_at: observedAt,
    basis: "local_refs_only",
    fetched: false,
    note,
  };
}

/**
 * 探测某个**项目目录**的 Git 状态（只读）。`projectPath` 一律由调用方从注册表取（§2.3.1：路径只走注册表）。
 * 不是仓库、空仓库、探测失败都是**如实的一条结论**，不是异常路径。
 */
export async function inspectGitStatus(projectPath: string): Promise<GitStatusReport> {
  const detectedAt = nowIso();
  const emptyHead: GitHeadObservation = {
    commit: null,
    short: null,
    branch: null,
    detached: false,
    unborn: false,
    note: "未探测（不是 Git 工作树或探测失败）",
  };
  const notRepo = (note: string): GitStatusReport => ({
    repository: {
      is_repository: false,
      root: null,
      relative_to_project: null,
      path_base: "unknown",
      note,
    },
    detected_at: detectedAt,
    head: emptyHead,
    staged: null,
    modified: null,
    untracked: null,
    conflicted: null,
    tracking_observation: trackingUnknown(detectedAt, "不是 Git 仓库，没有跟踪状态可谈（本卡不擅自 git init）"),
    private_backup_known: privateBackupUnknown(
      `项目未使用 Git：\`.工作台/\` 是否已备份无法由 Git 推断；${BACKUP_FLOW_NOTE}`,
      false,
    ),
    error: null,
  });

  const workbenchAbs = path.join(projectPath, WORKBENCH_DIRNAME);
  const workbenchExists = fs.existsSync(workbenchAbs);

  // ① 是不是工作树（判据只有这一条，没有 git init）
  const inside = await runGitReadOnly(projectPath, gitArgvInsideWorkTree());
  if (inside.spawn_error !== null) {
    return {
      ...notRepo("探测失败：跑不起 git"),
      private_backup_known: privateBackupUnknown(`git 跑不起来：${inside.spawn_error}`, workbenchExists),
      error: { code: "GIT_UNAVAILABLE", message: inside.spawn_error, command_id: "inside-work-tree" },
    };
  }
  if (inside.stdout.trim() !== "true") {
    // 「不是仓库」与「探测失败」必须分开：前者是正常状态（未使用 Git），后者是 error
    const failed = inside.status !== 0 && firstLine(inside.stderr) !== "";
    if (failed && !/not a git repository/i.test(inside.stderr)) {
      return {
        ...notRepo("探测失败：无法确认这个目录的 Git 状态"),
        private_backup_known: privateBackupUnknown(`Git 状态探测失败：${firstLine(inside.stderr)}`, workbenchExists),
        error: { code: "GIT_PROBE_FAILED", message: firstLine(inside.stderr), command_id: "inside-work-tree" },
      };
    }
    return notRepo("未使用 Git（不是 Git 工作树）——本卡不擅自初始化仓库，也不代它建 .gitignore");
  }

  // ② 工作树根（后续命令都在根上跑：路径口径 = 工作树根相对，且与 cwd 无关地稳定）
  const top = await runGitReadOnly(projectPath, gitArgvTopLevel());
  const root = top.ok ? firstLine(top.stdout) : projectPath;
  const rootResolved = root === "" ? projectPath : path.resolve(root);
  const rel = path.relative(rootResolved, path.resolve(projectPath));
  const relativeToProject = rel === "" ? "." : rel.replace(/\\/g, "/");

  // ③ HEAD（提交 + 分支/游离态）
  const headRes = await runGitReadOnly(rootResolved, gitArgvHead());
  const refRes = await runGitReadOnly(rootResolved, gitArgvHeadRef());
  const commit = headRes.ok && headRes.stdout.trim() !== "" ? headRes.stdout.trim() : null;
  const abbrev = refRes.stdout.trim();
  const unborn = commit === null;
  const branchRef = refRes.ok && abbrev !== "" && abbrev !== "HEAD" ? abbrev : null;
  const detached = !unborn && branchRef === null;
  const head: GitHeadObservation = {
    commit,
    short: commit === null ? null : commit.slice(0, 7),
    branch: branchRef,
    detached,
    unborn,
    note:
      unborn
        ? "空仓库：HEAD 还没有指向任何提交（工作树里的文件都是未跟踪）"
        : detached
          ? "游离头（detached HEAD）：没有当前分支，也谈不上上游"
          : `当前分支 ${branchRef}`,
  };

  // ④ 工作树四态（-z 解析；失败时四桶 null，绝不当"干净"）
  const st = await runGitReadOnly(rootResolved, gitArgvStatus());
  let buckets: StatusBuckets | null = null;
  let error: GitProbeFailure | null = null;
  if (st.ok) {
    buckets = parsePorcelainV1Z(st.stdout);
  } else {
    error = {
      code: "GIT_STATUS_FAILED",
      message: firstLine(st.stderr) || st.spawn_error || "git status 失败",
      command_id: "status",
    };
  }

  // ⑤ 远端：只读本地引用（没有上游就明说，绝不断言远端同步状态）
  let tracking: GitTrackingObservation;
  if (unborn) {
    tracking = trackingUnknown(detectedAt, "空仓库还没有提交，没有跟踪状态");
  } else if (detached) {
    tracking = {
      upstream: null,
      state: "no_upstream",
      ahead: null,
      behind: null,
      observed_at: detectedAt,
      basis: "local_refs_only",
      fetched: false,
      note: "游离头没有上游跟踪：本地提交是否已保存只看 HEAD 与工作树，不断言远端同步状态",
    };
  } else if (branchRef === null) {
    tracking = trackingUnknown(detectedAt, "取不到当前分支名，无法判断跟踪状态");
  } else {
    // 分支名/上游名都来自 git 自己的输出（不是请求或模型给的文本），仍先过形状校验；万一形态不合法，
    // 只把跟踪状态降为 unknown，**不让整个探测炸掉**（局部失败不牵连 HEAD 与工作树结论）
    let up: GitRunResult;
    try {
      up = await runGitReadOnly(rootResolved, gitArgvUpstream(branchRef));
    } catch (e) {
      up = { ok: false, status: null, stdout: "", stderr: (e as Error).message, spawn_error: null };
    }
    const upstream = up.ok ? up.stdout.trim() : "";
    if (!up.ok) {
      tracking = trackingUnknown(detectedAt, `读上游配置失败：${firstLine(up.stderr) || up.spawn_error || "未知原因"}`);
    } else if (upstream === "") {
      tracking = {
        upstream: null,
        state: "no_upstream",
        ahead: null,
        behind: null,
        observed_at: detectedAt,
        basis: "local_refs_only",
        fetched: false,
        note: "没有配置上游分支：**不断言远端同步状态**；本地提交是否已保存只按 HEAD 与工作树判断",
      };
    } else {
      let ab: GitRunResult;
      try {
        ab = await runGitReadOnly(rootResolved, gitArgvAheadBehind(upstream));
      } catch (e) {
        ab = { ok: false, status: null, stdout: "", stderr: (e as Error).message, spawn_error: null };
      }
      const nums = ab.ok ? ab.stdout.trim().split(/\s+/).map((n) => Number(n)) : [];
      if (ab.ok && nums.length === 2 && nums.every((n) => Number.isFinite(n))) {
        const [behind, ahead] = nums;
        const state: GitTrackingObservation["state"] =
          ahead > 0 && behind > 0 ? "diverged" : ahead > 0 ? "ahead" : behind > 0 ? "behind" : "up_to_date";
        tracking = {
          upstream,
          state,
          ahead,
          behind,
          observed_at: detectedAt,
          basis: "local_refs_only",
          fetched: false,
          note:
            state === "up_to_date"
              ? `本地记录的 ${upstream} 与 HEAD 一致（**未联网核实**：这是上次 fetch 留下的本地引用，不代表远端此刻的样子）`
              : `相对本地记录的 ${upstream}：领先 ${ahead} / 落后 ${behind}（未联网核实）`,
        };
      } else {
        tracking = trackingUnknown(
          detectedAt,
          `算不出本地领先/落后：${firstLine(ab.stderr) || ab.spawn_error || "输出无法解析"}`,
        );
      }
    }
  }

  // ⑥ `.工作台/` 与私有事实备份（忽略≠已备份；代码提交≠私有事实备份）
  const checkIgnore = await runGitReadOnly(rootResolved, gitArgvWorkbenchCheckIgnore());
  const ignoredByGit = checkIgnore.status === 0 ? true : checkIgnore.status === 1 ? false : null;
  const ignoredFiles = await runGitReadOnly(rootResolved, gitArgvWorkbenchIgnored());
  const trackedFiles = await runGitReadOnly(rootResolved, gitArgvWorkbenchTracked());
  const countZ = (r: GitRunResult): number | null =>
    r.ok ? r.stdout.split("\0").filter((s) => s !== "").length : null;
  const ignoredFileCount = countZ(ignoredFiles);
  const trackedFileCount = countZ(trackedFiles);
  const dirtyCount = buckets === null ? null : dirtyCountOf(buckets);
  const codeCommitted = dirtyCount === null ? null : dirtyCount === 0;
  const ignoredFact =
    ignoredByGit === null
      ? "忽略关系探测失败（如实标未知）"
      : ignoredByGit
        ? `\`.工作台/\` 命中 Git 忽略规则（忽略文件 ${ignoredFileCount ?? "未知"} 个）——代码提交不会把它带走`
        : "`.工作台/` 没有被 Git 忽略：它可能在索引/工作树里可见，但仍不等于已备份";
  const privateBackup: GitPrivateBackupObservation = {
    workbench_dir: WORKBENCH_DIRNAME,
    exists: workbenchExists,
    ignored_by_git: ignoredByGit,
    ignored_file_count: ignoredFileCount,
    tracked_file_count: trackedFileCount,
    code_committed: codeCommitted,
    backed_up: "unknown",
    backup_flow_available: true,
    reason:
      `${ignoredFact}；代码${codeCommitted === null ? "是否已提交未知" : codeCommitted ? "已保存为本地 Git 版本" : "仍有未保存改动"}` +
      `；而\`.工作台/\` 里的聊天/任务/证据是否已备份无法由 Git 推断——${BACKUP_FLOW_NOTE}，故这里仍只报 unknown`,
  };

  return {
    repository: {
      is_repository: true,
      root: rootResolved,
      relative_to_project: relativeToProject,
      path_base: "worktree_root",
      note:
        relativeToProject === "."
          ? "项目根就是 Git 工作树根"
          : `项目是工作树的子目录（${relativeToProject}）：下列路径都是**工作树根相对**，不是项目根相对`,
    },
    detected_at: detectedAt,
    head,
    staged: buckets === null ? null : buckets.staged,
    modified: buckets === null ? null : buckets.modified,
    untracked: buckets === null ? null : buckets.untracked,
    conflicted: buckets === null ? null : buckets.conflicted,
    tracking_observation: tracking,
    private_backup_known: privateBackup,
    error,
  };
}

// ───────────────────────────── B 提醒派生（界面只渲染，不自己推状态） ─────────────────────────────

export interface ReminderFileEntry {
  path: string;
  kind: "staged" | "modified" | "untracked" | "conflicted";
  /** 该路径是否落在**本项目**根内（工作树根与项目根不同的时候要能分开看） */
  in_project: boolean;
}

export interface VersionReminderPayload {
  /** 变更指纹：同一批改动 = 同一枚指纹（「稍后提醒」按它生效，见 VersionReminder.tsx） */
  change_fingerprint: string | null;
  /** 变更摘要（一句人话） */
  summary: string;
  /** 这批改动是不是"还没有保存为本地 Git 版本" */
  local_commit: {
    state: "saved" | "unsaved" | "unknown";
    label: string;
    head_short: string | null;
    branch: string | null;
  };
  /** 文件范围（去重、按 暂存→未暂存→未跟踪→冲突 排序；超限如实给截断数与总数） */
  file_scope: {
    files: ReminderFileEntry[];
    total: number;
    omitted: number;
    by_kind: { staged: number; modified: number; untracked: number; conflicted: number };
  };
  /** 最后检测时间（= 探测时间） */
  last_detected_at: string;
  /** 远端：只显示最近已知跟踪状态及观测时间 */
  remote: {
    state: GitTrackingObservation["state"];
    label: string;
    upstream: string | null;
    ahead: number | null;
    behind: number | null;
    observed_at: string;
    basis: "local_refs_only";
    fetched: false;
  };
  /**
   * 私有事实备份：`backed_up` **永远 unknown**（本模块推断不出"备份过没有"）；
   * `backup_flow_available` 是**能力**位（V09-06 起为 true：入口已交付），界面据此说明
   * "入口在哪、入口可用 ≠ 已备份"。
   */
  private_facts: { backed_up: "unknown"; backup_flow_available: boolean; label: string };
  /**
   * 成果口径：**这批成果算不算通过**。
   * 状态五态（补修 D）：`checks_passed` / `partially_covered` / `unverified` / `blocked` / `unknown`；
   * `detail` 是判定依据（声明范围 / 覆盖与未验证范围 / 逐条检查 / 版本绑定 / 三类记录分开），
   * 界面与整理说明据此回答"凭什么、覆盖了什么、没覆盖什么"。
   */
  verification: {
    state: VerificationState;
    label: string;
    /** 提醒来源关联的成果 ID（审计提交记录 id） */
    related_submission_ids: string[];
    /** 关联成果挂的证据 ID（内容寻址哈希） */
    related_evidence_ids: string[];
    related_task_ids: string[];
    /** 判定依据（未使用 Git / 探测失败时为 null：无从判断就不编一份依据出来） */
    detail: ReminderVerification | null;
  };
  /** 探测失败如实带出（界面必须显示"未知"，不许画成干净） */
  probe_error: GitProbeFailure | null;
  /** 是不是仓库（false → 界面明说"未使用 Git"） */
  is_repository: boolean;
  /** 复制给执行 Agent 的整理说明（纯文本，不含任何自动执行指令） */
  agent_note: string;
}

/** 文件范围列举上限（超了给总数 + 省略量，不假装列全） */
export const REMINDER_FILE_LIMIT = 200;

const normPath = (p: string): string => p.replace(/\\/g, "/").replace(/^\.\//, "");

/**
 * 变更指纹：同一批改动给同一枚指纹（HEAD + 四桶路径，路径排序后内容寻址）。
 * 只要提交、改动集合或任一桶归属变了，指纹就变——「稍后提醒」因此**不会吞掉新成果**。
 * 探测没成功（四桶任一为 null）时返回 null（没有可信的"这批改动"）。
 */
export function changeFingerprint(status: GitStatusReport): string | null {
  if (status.staged === null || status.modified === null || status.untracked === null || status.conflicted === null) {
    return null;
  }
  const payload = JSON.stringify({
    root: status.repository.root,
    head: status.head.commit,
    staged: [...status.staged].map(normPath).sort(),
    modified: [...status.modified].map(normPath).sort(),
    untracked: [...status.untracked].map(normPath).sort(),
    conflicted: [...status.conflicted].map(normPath).sort(),
  });
  // 用与证据同一套内容寻址（sha256），不引第三方哈希库
  return sha256Of(payload);
}

function sha256Of(data: string | Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

// ───────────────── B-1 内容版本：绑定「当前实际内容」（含未提交改动） ─────────────────

/**
 * 内容版本口径的单一出处。改这里就是改"什么算同一版"——所有指纹都带这枚标签。
 */
export const CONTENT_VERSION_BASIS = "content-v1";
/** 单条路径进指纹的内容上限（超了如实标 oversized，**整份指纹降为 null**，不假装算过） */
export const REMINDER_CONTENT_MAX_FILE_BYTES = 8 * 1024 * 1024;
/** 一次判定的内容总量上限（同上：超了就取不到版本，不据此判通过） */
export const REMINDER_CONTENT_MAX_TOTAL_BYTES = 64 * 1024 * 1024;

export interface ContentVersionEntry {
  path: string;
  /** 盘上有没有这个路径 */
  present: boolean;
  bytes: number;
  /** 内容哈希；`present=false` 或取不到内容时为 null */
  sha256: string | null;
  /** 路径被拒（绝对路径 / 越出工作树 / 含 `..` / 不是普通文件）：**不读盘**，也不假装读过 */
  rejected: boolean;
  /** 超过单条上限：内容不进指纹（两侧同一判据） */
  oversized: boolean;
}

export interface ContentVersion {
  basis: string;
  /** HEAD（只作记录，**不参与指纹**：提交不改内容，内容没变就还是同一版） */
  head: string | null;
  /** 声明范围（归一化、去重、排序后的路径） */
  paths: string[];
  entries: ContentVersionEntry[];
  /** 内容指纹；`null` = 算不出来（根未知 / 范围为空 / 有被拒或超限的路径）→ 不据此判通过 */
  fingerprint: string | null;
  note: string;
}

/**
 * 算**声明的这些路径在当前盘上的内容**的版本指纹（只读；不改任何文件）。
 *
 * 为什么必须按内容：补修 D ③ —— 「不能凭文件名相同、HEAD 相同或'最近一次成果提交'就认为
 * 旧检查覆盖现在的文件」。同路径再改一次内容 → 指纹必变 → 旧证据立刻对不上。
 * `head` 与提交动作都不进指纹：内容没变就是同一版（提交只是把同一份内容登记进版本库）。
 * 两侧（写检查记录的产出方 / 读提醒的判定方）都调本函数，判据同一份实现。
 */
export function contentVersionOf(
  root: string | null | undefined,
  paths: readonly string[],
  opts: { head?: string | null } = {},
): ContentVersion {
  const head = opts.head ?? null;
  const norm = [...new Set(paths.map(normPath).filter((p) => p !== ""))].sort();
  const base: ContentVersion = {
    basis: CONTENT_VERSION_BASIS,
    head,
    paths: norm,
    entries: [],
    fingerprint: null,
    note: "",
  };
  if (root === null || root === undefined || root === "") {
    return { ...base, note: "工作树根未知：拿不到盘上的内容，无法绑定内容版本（不据此判通过）" };
  }
  if (norm.length === 0) {
    return { ...base, note: "没有声明任何路径：范围为空，没有可比对的版本（不据此判通过）" };
  }
  const rootAbs = path.resolve(root);
  const entries: ContentVersionEntry[] = [];
  let unreadable = 0;
  let bytes = 0;
  for (const p of norm) {
    const abs = path.resolve(rootAbs, p);
    const inside = abs === rootAbs || abs.startsWith(rootAbs + path.sep);
    if (!inside || path.isAbsolute(p) || p.split("/").includes("..")) {
      entries.push({ path: p, present: false, bytes: 0, sha256: null, rejected: true, oversized: false });
      unreadable++;
      continue;
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
    } catch {
      // 文件不在盘上（删了/还没建）：这是**内容的一部分**（"这里现在没有东西"），进指纹
      entries.push({ path: p, present: false, bytes: 0, sha256: null, rejected: false, oversized: false });
      continue;
    }
    if (!stat.isFile()) {
      entries.push({ path: p, present: true, bytes: 0, sha256: null, rejected: true, oversized: false });
      unreadable++;
      continue;
    }
    if (stat.size > REMINDER_CONTENT_MAX_FILE_BYTES || bytes + stat.size > REMINDER_CONTENT_MAX_TOTAL_BYTES) {
      entries.push({ path: p, present: true, bytes: stat.size, sha256: null, rejected: false, oversized: true });
      bytes += stat.size;
      unreadable++;
      continue;
    }
    let buf: Buffer;
    try {
      buf = fs.readFileSync(abs);
    } catch {
      entries.push({ path: p, present: true, bytes: stat.size, sha256: null, rejected: true, oversized: false });
      unreadable++;
      continue;
    }
    bytes += buf.length;
    entries.push({ path: p, present: true, bytes: buf.length, sha256: sha256Of(buf), rejected: false, oversized: false });
  }
  const payload = JSON.stringify({
    basis: CONTENT_VERSION_BASIS,
    entries: entries.map((e) => [e.path, e.present, e.rejected, e.oversized, e.sha256]),
  });
  return {
    ...base,
    entries,
    fingerprint: unreadable === 0 ? sha256Of(payload) : null,
    note:
      unreadable === 0
        ? `${CONTENT_VERSION_BASIS}：按声明范围里 ${entries.length} 条路径的**当前内容**取指纹` +
          `（含未提交改动；HEAD 只作记录、不参与指纹）`
        : `声明范围里有 ${unreadable} 条路径的内容取不到（被拒/超限/不是普通文件）：` +
          `不据此绑定版本，也不据此判通过`,
  };
}

// ───────────────── B-2 「这批成果算不算通过」的判定（补修 D 六条口径） ─────────────────

export interface ReminderSubmissionFacts {
  record_id: string;
  task_id: string | null;
  changed_files: string[];
  evidence_refs: string[];
  at: string;
  /** 执行者（用来把"自检"与"独立审计"分清：作者自己的记录不算独立） */
  submitted_by?: string;
}

/**
 * 影响该结论的未收口阻断（缺陷 / 未解决冲突等）。
 * 关系判据（保守，fail-closed）：**没有声明范围算影响**；声明了范围而与这批改动/任务无交集才算无关。
 */
export interface ReminderBlockerFacts {
  blocker_id: string;
  kind: "finding" | "conflict" | "other";
  severity?: string | null;
  must_block?: boolean;
  /** 缺陷状态（`work/evidence.ts#FINDING_STATUSES` 口径）；缺省按"未收口"处理 */
  status?: string;
  /** 影响对象稳定 ID */
  object_id?: string | null;
  /** 影响的路径（**缺省 = 未声明范围，按影响处理**） */
  paths?: string[];
  note?: string | null;
}

export interface ReminderOutcomeFacts {
  /** 审计提交记录（`work/audit.ts#readAuditRecords(...).submissions`） */
  submissions: ReminderSubmissionFacts[];
  /** 证据清单（`work/evidence.ts#evidenceManifest`）：用来判"这个成果的证据还在不在、坏没坏" */
  evidence: { evidence_id: string; intact: boolean }[];
  /** 检查记录（自检/独立审计 → `work/statusProjection.ts#checksFromAudit`）；缺省 = 没有任何检查记录 */
  checks?: readonly CheckInput[];
  /**
   * 任务定义里的必需检查（`work/statusProjection.ts#requiredChecksFromDefinitions`）。
   * **缺省 = 清单未知 → 不空集判绿**（V06-09 同一口径）。
   */
  required_checks_by_task?: Record<string, { check_id: string; label: string }[]>;
  /** 用户接受记录（单独记一段；**检查通过不得扩写成"已验收"**） */
  acceptances?: readonly {
    record_id: string;
    task_id: string | null;
    decision: "accept" | "reject" | "accept_known_limit" | string;
    at: string;
  }[];
  /** 影响该结论的未收口阻断 */
  blockers?: readonly ReminderBlockerFacts[];
}

/** 「这批成果算不算通过」的四维判定 + 六态 */
export type VerificationState =
  /** 六条口径全部满足 */
  | "checks_passed"
  /** 有真实通过结果，但只覆盖部分改动 / 必需检查不齐（**不宣称整批通过**） */
  | "partially_covered"
  /** 没有覆盖当前内容版本的真实通过结果（从未检查 / 版本不匹配 / 证据失效） */
  | "unverified"
  /** 有未收口阻断（失败记录仍在册 / 必须拦截的缺陷）→ 不能算通过 */
  | "blocked"
  /** 不是仓库 / 只读探测失败：无从判断（不当作通过） */
  | "unknown";

/** 一条检查依据（人能顺着它追到记录、版本与证据） */
export interface VerificationCheckBasis {
  /** 记录来源（事件实体，如 `check:<record_id>`）；测试直接构造的检查为 null */
  record_ref: string | null;
  check_id: string;
  task_id: string | null;
  /** 记录里声明的结果（原始值，未复核） */
  result: "passed" | "failed";
  /** 复核后的有效性（复用 V06-09 `checkEffectiveness`；证据不在册也在这里撤销通过） */
  effective: "passed" | "failed" | "stale" | "unknown";
  why: string;
  independence: "author_self" | "independent";
  actor_id: string;
  at: string;
  /** 这条记录声明的覆盖范围（路径） */
  scope: string[];
  evidence_sha256: string | null;
  /** 被测版本：记录里绑定的修订（最常是 `code` + 内容指纹） */
  bound_revision: { revision_kind: RevisionKind; revision: string } | null;
  /** 复核基准：该范围**当前内容版本**的指纹（拿不到 → null） */
  current_content_version: string | null;
}

export interface ReminderVerification {
  state: VerificationState;
  label: string;
  /** ① 声明范围：哪批成果 / 哪些路径 / 哪些必需检查 */
  declared: {
    batch: "dirty_batch" | "latest_outcomes" | "none";
    submission_ids: string[];
    task_ids: string[];
    /** 声明范围的完整路径集（= changed_paths ∪ outcome_paths） */
    paths: string[];
    /** 工作树里现在确实改了的路径（现场） */
    changed_paths: string[];
    /** 这批成果自己声明交付的路径（提交记录的 `changed_files`） */
    outcome_paths: string[];
    required_checks: { check_id: string; label: string; task_id: string }[];
    required_checks_source: "task_definitions" | "unknown";
    required_checks_note: string;
  };
  /** ④ 覆盖范围：已覆盖 vs 未验证（不宣称整批通过） */
  coverage: { covered_paths: string[]; uncovered_paths: string[]; complete: boolean };
  /** 每条检查的依据（含转 stale/unknown 的，不因状态变化而消失） */
  checks: VerificationCheckBasis[];
  /** 缺什么（必需检查缺哪项、为什么） */
  missing_checks: { check_id: string; label: string | null; task_id: string | null; why: string }[];
  /** ② 未收口阻断（非空即不能算通过） */
  blockers: { blocker_id: string; kind: string; why: string }[];
  /** ③ 版本绑定：当前实际内容版本 + 每个被检查范围的当前版本 */
  version: {
    basis: string;
    head: string | null;
    change_fingerprint: string | null;
    by_scope: { paths: string[]; fingerprint: string | null; note: string }[];
    note: string;
  };
  /** ⑤ 三类记录分开（自检 / 独立审计 / 用户接受） */
  records: {
    self_checks: string[];
    independent_audits: string[];
    user_acceptances: string[];
    note: string;
  };
  /** 口径说明（判定不是"看感觉"：本字段写清依据哪六条） */
  basis_note: string;
}

export const VERIFICATION_BASIS_NOTE =
  "判定口径（补修 D，GPT-6 裁定）：①说清声明范围（哪批成果/哪些路径/哪些必需检查）；" +
  "②真实通过结果 + 覆盖声明范围 + 证据完整且当前有效 + 无未收口阻断；" +
  "③绑定当前实际内容版本（含未提交改动）——文件名相同、HEAD 相同、'最近一次成果提交'都不算覆盖；" +
  "④只覆盖部分改动时显示已覆盖与未验证范围，不宣称整批通过；" +
  "⑤自检/独立审计/用户接受分开记，检查通过不扩写成已验收；" +
  "⑥工作树干净只表示没有待保存改动，验证状态另算，没有验证证据时不显示通过";

const VERIFICATION_RECORDS_NOTE =
  "自检（作者自己跑，`independence: author_self`）/ 独立审计（审计者 ≠ 作者）/ 用户接受（只有真实用户身份能给）" +
  "三类分开记：**检查通过 ≠ 独立审计通过 ≠ 用户已验收**（工作台不代用户签收）";

/** 复核通过不需要理由；复核不通过却给不出理由，就等于没说清（这里兜一句实话，不留空串） */
const whyOrUnknown = (why: string): string => (why.trim() === "" ? "没有给出复核理由（不据此判通过）" : why);

export interface AssessBatchOptions {
  /** 工作树根（内容版本按它现算）；拿不到 = 无法绑定内容版本 */
  repository_root?: string | null;
  head?: string | null;
  change_fingerprint?: string | null;
}

/**
 * 「这批成果算不算通过」的判定（补修 D 的全部口径都落在这里）。
 *
 * 输入全是**事实**（提交记录 / 检查记录 / 证据清单 / 任务定义的必需检查 / 用户接受 / 未收口阻断 +
 * 当前盘上的内容）；输出能回答"凭什么、覆盖了什么、没覆盖什么"。
 * 不默认通过：任何一条口径缺证据 → 状态降级，并把缺口逐条写出来。
 */
export function assessBatchVerification(
  dirtyPaths: readonly string[],
  facts: ReminderOutcomeFacts,
  opts: AssessBatchOptions = {},
): ReminderVerification {
  const root = opts.repository_root ?? null;
  const dirty = new Set(dirtyPaths.map(normPath).filter((p) => p !== ""));

  // ── 声明范围之一：哪批成果 ──
  // 工作树有改动 → 与本批改动路径**相交**的成果提交（相交只表示"可能有关"，不代表通过）；
  // 工作树干净 → 没有"这批改动"可对，取事实里**最近一次成果提交**当讨论对象
  //（版本绑定仍按**当前内容**现算，所以"最近一次提交"这个身份不影响 ③ 的严格性）。
  let candidates: ReminderSubmissionFacts[] = [];
  let batch: ReminderVerification["declared"]["batch"] = "none";
  if (dirty.size > 0) {
    candidates = facts.submissions.filter((s) => s.changed_files.map(normPath).some((f) => dirty.has(f)));
    if (candidates.length > 0) batch = "dirty_batch";
  } else {
    let latestMs: number | null = null;
    for (const s of facts.submissions) {
      const ms = parseIsoMs(s.at);
      if (ms === null) continue; // 时间非法/缺失不参与"最近"的比较（不按字面钟点猜）
      if (latestMs === null || ms > latestMs) latestMs = ms;
    }
    if (latestMs !== null) {
      candidates = facts.submissions.filter((s) => parseIsoMs(s.at) === latestMs);
      batch = "latest_outcomes";
    }
  }
  const submissionIds = [...new Set(candidates.map((s) => s.record_id))].sort();
  const taskIds = [...new Set(candidates.map((s) => s.task_id).filter((t): t is string => t !== null))].sort();
  // 声明范围之三：**哪些路径**
  // 两来源合起来才是"这批改动"的完整范围（④：只覆盖部分改动时不宣称整批通过）：
  //   · `changed_paths`  = 工作树里现在**确实改了**的路径（不是成果声明出来的，而是现场）；
  //   · `outcome_paths`  = 这批成果**自己声明**交付的路径（提交记录的 `changed_files`）。
  // 只有两边都覆盖到，才谈得上"这批改动的检查通过"；成果没说、但现场改了的路径，一律进"未验证范围"。
  // 路径口径 = 工作树根相对（与 `git status -z` 一致；项目是工作树子目录时两边前缀不同，这里按既有
  // 口径直接比对，不做前缀改写——那属于另一个待收口的问题，不在本包范围）。
  const changedPaths = [...dirty].sort();
  const outcomePaths = [
    ...new Set(candidates.flatMap((s) => s.changed_files.map(normPath).filter((p) => p !== ""))),
  ].sort();
  const declaredPaths = [...new Set([...changedPaths, ...outcomePaths])].sort();

  // ── 声明范围之二：哪些必需检查（来自任务定义；缺清单 = 不空集判绿） ──
  const required: { check_id: string; label: string; task_id: string }[] = [];
  let requiredSource: "task_definitions" | "unknown" = "unknown";
  let requiredNote: string;
  const reqMap = facts.required_checks_by_task;
  if (taskIds.length === 0) {
    requiredNote = "这批成果没有关联任务：拿不到「必需检查」清单，不空集判绿";
  } else if (reqMap === undefined) {
    requiredNote = "没有给出任务定义：必需检查清单未知，不空集判绿";
  } else {
    const noDef = taskIds.filter((t) => reqMap[t] === undefined);
    for (const t of taskIds) for (const r of reqMap[t] ?? []) required.push({ ...r, task_id: t });
    if (noDef.length > 0) {
      requiredNote = `任务 ${noDef.join("、")} 没有任务定义：必需检查清单不全，不空集判绿`;
    } else if (required.length === 0) {
      requiredNote = `任务定义（${taskIds.join("、")}）里没有必需检查项：清单为空，不空集判绿`;
    } else {
      requiredSource = "task_definitions";
      requiredNote = `必需检查清单来自任务定义（${required.length} 项，覆盖 ${taskIds.length} 个任务）`;
    }
  }

  // ── ② 检查记录逐条复核（真实通过结果 / 覆盖范围 / 证据在册 / 版本绑定） ──
  const intact = new Set(facts.evidence.filter((e) => e.intact).map((e) => e.evidence_id));
  const authorIds = new Set(
    candidates.map((s) => s.submitted_by).filter((x): x is string => typeof x === "string" && x !== ""),
  );
  const allChecks = facts.checks ?? [];
  /** 检查记录归属的任务（`CheckInput.object_id` 就是记录里的 `task_id`；模块级记录是 `module:<id>`） */
  const checkTaskOf = (c: CheckInput): string | null => (c.object_id === "" ? null : c.object_id);
  const relevant = allChecks.filter((c) => {
    const scope = (c.scope ?? []).map(normPath);
    const t = checkTaskOf(c);
    if (t !== null && taskIds.includes(t)) return true;
    if (scope.some((p) => dirty.has(p) || declaredPaths.includes(p))) return true;
    return false;
  });
  const scopeCache = new Map<string, ContentVersion>();
  const versionOf = (scope: readonly string[]): ContentVersion => {
    const key = [...scope].sort().join("\n");
    const hit = scopeCache.get(key);
    if (hit !== undefined) return hit;
    const v = contentVersionOf(root, scope, { head: opts.head ?? null });
    scopeCache.set(key, v);
    return v;
  };

  const checks: VerificationCheckBasis[] = relevant.map((c) => {
    const scope = [...new Set((c.scope ?? []).map(normPath).filter((p) => p !== ""))].sort();
    const binding = c.binding ?? null;
    // 独立性复核口径与 `checkEffectiveness` 同一套：作者自己的记录一律降为 `author_self`
    const independence: VerificationCheckBasis["independence"] =
      c.actor_id !== "" && authorIds.has(c.actor_id) ? "author_self" : c.independence;
    const base = {
      record_ref: c.record_ref ?? null,
      check_id: c.check_id,
      task_id: checkTaskOf(c),
      result: c.result,
      actor_id: c.actor_id,
      at: c.at,
      scope,
      evidence_sha256: c.evidence_sha256,
      bound_revision:
        binding === null ? null : { revision_kind: binding.revision_kind, revision: binding.revision },
      independence,
    };
    const unknown = (why: string, current: string | null): VerificationCheckBasis => ({
      ...base,
      effective: "unknown",
      why,
      current_content_version: current,
    });
    if (scope.length === 0) {
      return unknown(
        "这条检查没有声明覆盖范围：说不清它覆盖哪些路径，不据此判通过（补修 D ①）",
        null,
      );
    }
    const current = versionOf(scope);
    if (current.fingerprint === null) {
      return unknown(`覆盖范围的当前内容取不到：无法绑定内容版本（${current.note}）`, null);
    }
    if (c.evidence_sha256 === null) {
      return unknown("这条检查说通过但没给证据哈希：没证据的通过不算通过（结果已提交 ≠ 验证通过）", current.fingerprint);
    }
    if (!intact.has(c.evidence_sha256)) {
      return unknown(
        `证据 ${c.evidence_sha256.slice(0, 12)}… 不在册或已损坏：证据失效 → 撤销「通过」`,
        current.fingerprint,
      );
    }
    if (binding === null || binding.revision_kind !== "code") {
      const kindTxt =
        binding === null ? "（记录没有绑定任何修订）" : `${binding.revision_kind}:${binding.revision === "" ? "（空）" : `${binding.revision.slice(0, 12)}…`}`;
      return unknown(
        `这条检查绑的是 ${kindTxt}，不是代码内容版本：` +
          "提醒按当前实际内容（含未提交改动）核对，绑其他版本无法复核 → 不据此判通过",
        current.fingerprint,
      );
    }
    // 复用 V06-09 的证据有效性规则：绑定修订 ≠ 当前修订 → 旧绿转待验证（下面的"当前修订"
    // 就是**该记录自己声明范围**的当前内容版本指纹：同路径内容再改一次，这里必然不相等）
    const eff = checkEffectiveness({ ...c, scope }, { code: current.fingerprint }, authorIds);
    return {
      ...base,
      independence: eff.effective_independence,
      effective: eff.effective,
      // 复核通过不需要理由（`why` 留空）；复核不通过/转 stale/无法复核必须说清为什么
      why: eff.effective === "passed" ? "" : whyOrUnknown(eff.why),
      current_content_version: current.fingerprint,
    };
  });

  const passedChecks = checks.filter((c) => c.effective === "passed");
  const coveredPaths = [...new Set(passedChecks.flatMap((c) => c.scope))].sort();
  const uncoveredPaths = declaredPaths.filter((p) => !coveredPaths.includes(p));
  const coverageComplete = declaredPaths.length > 0 && uncoveredPaths.length === 0;

  // ── ② 未收口阻断（失败记录仍在册也算"已确认问题"） ──
  const CLOSEDISH = new Set(["closed", "false_positive", "duplicate", "accepted_risk"]);
  const blockers: { blocker_id: string; kind: string; why: string }[] = [];
  for (const b of facts.blockers ?? []) {
    if (b.status !== undefined && CLOSEDISH.has(b.status)) continue;
    const paths = (b.paths ?? []).map(normPath).filter((p) => p !== "");
    if (paths.length > 0 && !paths.some((p) => dirty.has(p) || declaredPaths.includes(p))) continue;
    const objId = b.object_id ?? null;
    if (objId !== null && taskIds.length > 0 && !taskIds.includes(objId)) continue;
    blockers.push({
      blocker_id: b.blocker_id,
      kind: b.kind,
      why:
        (b.must_block === true ? "必须拦截" : "已确认") +
        (b.severity != null && b.severity !== "" ? `（${b.severity}）` : "") +
        (b.status !== undefined ? `，状态 ${b.status}` : "，状态未声明（按未收口处理）") +
        (paths.length > 0 ? `，影响 ${paths.length} 条路径` : "，未声明影响范围（按影响处理）") +
        (b.note != null && b.note !== "" ? `：${b.note}` : ""),
    });
  }
  blockers.sort((a, b) => a.blocker_id.localeCompare(b.blocker_id));
  // 失败记录仍在册：**没有**被"同一条检查、更晚、且绑定当前内容版本又覆盖同一范围"的通过记录取代时，
  // 就是未收口阻断（审计事件只追加：修复后能否复测通过，要靠**同一条检查**的新记录来证明；
  // 别的检查在同一批路径上通过、或旧记录早于失败，都不算"已复测通过"）
  const allFailed = checks.filter((c) => c.result === "failed");
  const isSuperseded = (f: VerificationCheckBasis): boolean =>
    passedChecks.some(
      (p) =>
        p.check_id === f.check_id &&
        compareIsoTime(p.at, f.at) >= 0 &&
        (f.scope.length === 0 ? false : f.scope.every((s) => p.scope.includes(s))),
    );
  const failedRecords = allFailed.filter((f) => !isSuperseded(f));
  const supersededFailures = allFailed.filter((f) => isSuperseded(f));

  // ── 缺口：必需检查缺哪项 ──
  const missingChecks: ReminderVerification["missing_checks"] = [];
  for (const r of required) {
    if (passedChecks.some((c) => c.check_id === r.check_id)) continue;
    const seen = checks.find((c) => c.check_id === r.check_id);
    missingChecks.push({
      check_id: r.check_id,
      label: r.label,
      task_id: r.task_id,
      why:
        seen === undefined
          ? "没有覆盖当前内容版本的真实通过结果：没有任何检查记录（缺哪项说哪项）"
          : `有记录但复核不通过：${seen.why}`,
    });
  }
  for (const p of uncoveredPaths) {
    missingChecks.push({
      check_id: `path:${p}`,
      label: p,
      task_id: null,
      why: "这个路径在本批改动里，但没有任何真实通过结果覆盖它（未验证范围）",
    });
  }

  // ── 记录区分（⑤） ──
  // 用户接受只列**属于这批成果**的（任务对得上）或没有挂任务的记录：别人的验收记录不能拿来给这批背书，
  // 也不能让人误读成"这批已验收"（检查通过 ≠ 已验收）。
  const batchAcceptances = (facts.acceptances ?? []).filter(
    (a) => a.task_id === null || taskIds.includes(a.task_id),
  );
  const records = {
    self_checks: [...new Set(checks.filter((c) => c.independence === "author_self").map((c) => c.check_id))].sort(),
    independent_audits: [...new Set(checks.filter((c) => c.independence === "independent").map((c) => c.check_id))].sort(),
    user_acceptances: [...new Set(batchAcceptances.map((a) => a.record_id))].sort(),
    note: VERIFICATION_RECORDS_NOTE,
  };

  const withinVersion = root === null ? "none" : checks.some((c) => c.current_content_version === null) ? "unknown" : "all_readable";
  const version: ReminderVerification["version"] = {
    basis: CONTENT_VERSION_BASIS,
    head: opts.head ?? null,
    change_fingerprint: opts.change_fingerprint ?? null,
    by_scope: [...scopeCache.entries()].map(([, v]) => ({ paths: [...v.paths], fingerprint: v.fingerprint, note: v.note })),
    note:
      root === null
        ? "工作树根未知（不是仓库/探测失败）：算不出当前内容版本 → 不据此判通过"
        : withinVersion === "unknown"
          ? "有的被检查范围取不到当前内容（被拒/超限）：那些检查不据此判通过"
          : "每条检查都用它自己声明范围的当前内容版本复核：绑定版本 ≠ 当前内容 → 旧证据过期（含未提交改动）",
  };

  // ── 状态决策（顺序 = 口径的强度：有阻断先阻断；没有证据就未验证；覆盖不全最多"部分覆盖"） ──
  let state: VerificationState;
  let label: string;
  if (candidates.length === 0) {
    // ⑥ 工作树干净 ≠ 验证过；这批改动没有对应成果提交也照实说
    state = "unverified";
    label =
      dirty.size > 0
        ? "这批改动未验证：还没有找到与之对应、且证据在册的成果提交——它是未保存改动，不是稳定成果"
        : "未验证：没有任何成果提交可对（也没有检查记录）——工作树干净只表示「没有待保存改动」，不代表验证过";
  } else if (blockers.length > 0 || failedRecords.length > 0) {
    state = "blocked";
    label =
      `这批成果（${submissionIds.join("、")}）不能算通过：` +
      [
        failedRecords.length > 0
          ? `失败检查记录仍在册且没有被「绑定当前内容版本 + 覆盖同一范围」的通过记录取代（${failedRecords
              .map((c) => c.check_id)
              .join("、")}）`
          : null,
        blockers.length > 0
          ? `有影响该结论的未收口阻断（${blockers.map((b) => b.blocker_id).join("、")}）`
          : null,
      ]
        .filter((x): x is string => x !== null)
        .join("；") +
      "——先收口再谈通过（不拿「有提交动作」当通过）";
  } else if (declaredPaths.length === 0) {
    state = "unverified";
    label =
      `这批成果（${submissionIds.join("、")}）未验证：成果提交没有声明改动路径（changed_files 为空）` +
      "——说不清要覆盖哪些路径，不据此判通过";
  } else if (passedChecks.length === 0) {
    state = "unverified";
    label =
      `这批成果（${submissionIds.join("、")}）未验证：没有覆盖当前内容版本的真实通过结果` +
      `——${missingChecks.length > 0 ? missingChecks[0].why : "本批改动没有任何检查记录"}；它是未保存改动，不是稳定成果`;
  } else if (!coverageComplete || requiredSource !== "task_definitions" || missingChecks.length > 0) {
    state = "partially_covered";
    label =
      `只覆盖部分改动，不宣称整批通过：已覆盖 ${coveredPaths.length} 条路径` +
      `（${coveredPaths.slice(0, 5).join("、")}${coveredPaths.length > 5 ? "…" : ""}）、` +
      `未验证 ${uncoveredPaths.length} 条` +
      `（${uncoveredPaths.slice(0, 5).join("、")}${uncoveredPaths.length > 5 ? "…" : ""}）；` +
      (requiredSource === "task_definitions" ? "" : `${requiredNote}；`) +
      `缺 ${missingChecks.length} 项（${missingChecks.slice(0, 3).map((m) => m.check_id).join("、")}${missingChecks.length > 3 ? "…" : ""}）`;
  } else {
    state = "checks_passed";
    const fp = passedChecks[0]?.current_content_version ?? null;
    label =
      `这批成果（成果 ${submissionIds.join("、")}；任务 ${taskIds.join("、")}）已通过必要检查：` +
      `声明范围 ${declaredPaths.length} 条路径全部有真实通过结果（${passedChecks.map((c) => c.check_id).join("、")}），` +
      `证据在册且当前有效，均绑定当前内容版本 ${fp === null ? "（无）" : `${fp.slice(0, 8)}…`}（含未提交改动）；` +
      `自检 ${records.self_checks.length} 条 / 独立审计 ${records.independent_audits.length} 条；` +
      `检查通过 ≠ 已验收（用户接受记录：${records.user_acceptances.length === 0 ? "无" : records.user_acceptances.join("、")}）；` +
      (supersededFailures.length > 0
        ? `曾有的失败记录（${supersededFailures.map((c) => c.check_id).join("、")}）已被同范围的当前通过记录取代；`
        : "") +
      (dirty.size > 0 ? `工作树仍有改动（${dirty.size} 个文件未保存为本地 Git 版本）。` : "工作树干净（没有待保存改动）。");
  }

  return {
    state,
    label,
    declared: {
      batch,
      submission_ids: submissionIds,
      task_ids: taskIds,
      paths: declaredPaths,
      changed_paths: changedPaths,
      outcome_paths: outcomePaths,
      required_checks: required,
      required_checks_source: requiredSource,
      required_checks_note: requiredNote,
    },
    coverage: { covered_paths: coveredPaths, uncovered_paths: uncoveredPaths, complete: coverageComplete },
    checks,
    missing_checks: missingChecks,
    blockers,
    version,
    records,
    basis_note: VERIFICATION_BASIS_NOTE,
  };
}

/**
 * 从审计/证据事实里挑出与这批改动相关的成果，并给出「算不算通过」的判定。
 *
 * 旧的 `checks_passed: boolean`（"有相关成果提交 + 至少一条证据在册"）**已删除**：
 * 那条判据只说明"可能有关"与"证据可取回"，不能证明检查通过（补修 D）。现在只看
 * `verification.state`，且它只在六条口径全部满足时才是 `checks_passed`。
 */
export function relatedOutcomes(
  dirtyPaths: string[],
  facts: ReminderOutcomeFacts,
  opts: AssessBatchOptions = {},
): {
  submission_ids: string[];
  evidence_ids: string[];
  task_ids: string[];
  verification: ReminderVerification;
} {
  const verification = assessBatchVerification(dirtyPaths, facts, opts);
  // 关联证据：本批成果挂的证据 + 真实通过结果引用的证据（都给出来，界面/整理说明据此追溯）
  const evidenceIds = [
    ...new Set([
      ...verification.declared.submission_ids.flatMap(
        (id) => facts.submissions.find((s) => s.record_id === id)?.evidence_refs ?? [],
      ),
      ...verification.checks.filter((c) => c.effective === "passed").map((c) => c.evidence_sha256 ?? ""),
    ]),
  ].filter((x) => x !== "");
  return {
    submission_ids: verification.declared.submission_ids,
    evidence_ids: evidenceIds.sort(),
    task_ids: verification.declared.task_ids,
    verification,
  };
}

const TRACKING_LABELS: Record<GitTrackingObservation["state"], string> = {
  no_upstream: "无上游：不断言远端同步状态（只说本地保存）",
  up_to_date: "与本地记录的远端引用一致（未联网核实）",
  ahead: "领先本地记录的远端引用",
  behind: "落后本地记录的远端引用",
  diverged: "与本地记录的远端引用分叉",
  unknown: "跟踪状态未知",
};

const briefList = (xs: readonly string[], limit = 6): string =>
  xs.length === 0 ? "（无）" : `${xs.slice(0, limit).join("、")}${xs.length > limit ? `…（共 ${xs.length}）` : ""}`;

/**
 * 判定的**依据**（进「复制给执行 Agent 的整理说明」）：声明范围 / 覆盖与未验证范围 /
 * 逐条检查的来源与复核 / 版本绑定 / 三类记录分开。人能顺着这些行追到记录、证据与版本。
 */
export function verificationNoteLines(v: ReminderVerification): string[] {
  const lines: string[] = [];
  lines.push(`- ${v.basis_note}`);
  lines.push(
    `- 声明范围：成果 ${briefList(v.declared.submission_ids)}；任务 ${briefList(v.declared.task_ids)}；` +
      `路径 ${v.declared.paths.length} 条（现场改动 ${briefList(v.declared.changed_paths)}；成果声明 ${briefList(v.declared.outcome_paths)}）`,
  );
  lines.push(
    `- 必需检查（${v.declared.required_checks_source}）：${briefList(v.declared.required_checks.map((c) => c.check_id))}` +
      `——${v.declared.required_checks_note}`,
  );
  lines.push(
    `- 覆盖：已覆盖 ${v.coverage.covered_paths.length} 条（${briefList(v.coverage.covered_paths)}）；` +
      `**未验证** ${v.coverage.uncovered_paths.length} 条（${briefList(v.coverage.uncovered_paths)}）；` +
      `${v.coverage.complete ? "覆盖完整" : "**不宣称整批通过**"}`,
  );
  lines.push(
    `- 版本绑定（${v.version.basis}）：HEAD ${v.version.head === null ? "（空仓库/未知）" : `${v.version.head.slice(0, 12)}…`}；` +
      `变更指纹 ${v.version.change_fingerprint === null ? "未知" : `${v.version.change_fingerprint.slice(0, 12)}…`}；${v.version.note}`,
  );
  for (const s of v.version.by_scope) {
    lines.push(`    · 范围 ${briefList(s.paths, 3)} → 当前内容版本 ${s.fingerprint === null ? "取不到" : `${s.fingerprint.slice(0, 16)}…`}`);
  }
  if (v.checks.length === 0) {
    lines.push("- 检查依据：（没有任何与本批改动相关的检查记录）");
  } else {
    lines.push("- 检查依据（记录 → 复核结论）：");
    for (const c of v.checks) {
      lines.push(
        `    · ${c.check_id} ← ${c.record_ref ?? "（测试直接构造，无事件记录）"}｜声明结果 ${c.result}｜复核 ${c.effective}` +
          `｜${c.independence === "independent" ? "独立审计" : "作者自检"}（${c.actor_id || "未记名"}）` +
          `｜绑定 ${c.bound_revision === null ? "（未绑定）" : `${c.bound_revision.revision_kind}:${c.bound_revision.revision.slice(0, 12)}…`}` +
          `｜当前内容版本 ${c.current_content_version === null ? "取不到" : `${c.current_content_version.slice(0, 12)}…`}` +
          `｜证据 ${c.evidence_sha256 === null ? "（无）" : `${c.evidence_sha256.slice(0, 12)}…`}` +
          `｜范围 ${briefList(c.scope, 3)}` +
          (c.effective === "passed" ? "" : `｜为什么不算通过：${c.why}`),
      );
    }
  }
  lines.push(
    v.missing_checks.length === 0
      ? "- 缺口：无"
      : `- 缺口 ${v.missing_checks.length} 项：` +
          v.missing_checks.map((m) => `${m.check_id}（${m.why}）`).join("；"),
  );
  lines.push(
    v.blockers.length === 0
      ? "- 未收口阻断：无"
      : `- 未收口阻断（非空即不能算通过）：${v.blockers.map((b) => `${b.blocker_id}：${b.why}`).join("；")}`,
  );
  lines.push(
    `- 记录区分：自检 ${briefList(v.records.self_checks)}；独立审计 ${briefList(v.records.independent_audits)}；` +
      `用户接受 ${briefList(v.records.user_acceptances)}——${v.records.note}`,
  );
  return lines;
}

/** 折成一枚提醒（界面只渲染这份数据；判断全在这里做完） */
export function buildVersionReminder(
  status: GitStatusReport,
  facts: ReminderOutcomeFacts,
  opts: { project_name?: string } = {},
): VersionReminderPayload {
  const hasBuckets =
    status.staged !== null && status.modified !== null && status.untracked !== null && status.conflicted !== null;
  const entries: ReminderFileEntry[] = [];
  if (hasBuckets) {
    const seen = new Set<string>();
    const projectRootRel = status.repository.relative_to_project;
    const inProject = (p: string): boolean => {
      const n = normPath(p);
      if (projectRootRel === null || projectRootRel === ".") return true;
      return n === projectRootRel || n.startsWith(`${projectRootRel}/`);
    };
    const push = (list: string[] | null, kind: ReminderFileEntry["kind"]): void => {
      for (const raw of list ?? []) {
        const p = normPath(raw);
        const key = `${kind}:${p}`;
        if (seen.has(key)) continue;
        seen.add(key);
        entries.push({ path: p, kind, in_project: inProject(p) });
      }
    };
    push(status.staged, "staged");
    push(status.modified, "modified");
    push(status.untracked, "untracked");
    push(status.conflicted, "conflicted");
  }
  const byKind = {
    staged: status.staged?.length ?? 0,
    modified: status.modified?.length ?? 0,
    untracked: status.untracked?.length ?? 0,
    conflicted: status.conflicted?.length ?? 0,
  };
  const total = byKind.staged + byKind.modified + byKind.untracked + byKind.conflicted;
  const dirtyPaths = [...new Set(entries.map((e) => e.path))];
  const fingerprint = changeFingerprint(status);
  // 判定要吃"当前实际内容"（补修 D ③）：把工作树根与 HEAD 一起交给判定，内容版本按盘上现算
  const related = relatedOutcomes(dirtyPaths, facts, {
    repository_root: status.repository.root,
    head: status.head.commit,
    change_fingerprint: fingerprint,
  });

  const localCommit = ((): VersionReminderPayload["local_commit"] => {
    if (!status.repository.is_repository) {
      return {
        state: "unknown",
        label: "未使用 Git：没有本地 Git 版本可谈（本卡不擅自初始化仓库）",
        head_short: null,
        branch: null,
      };
    }
    if (!hasBuckets) {
      return { state: "unknown", label: "工作树状态未知（只读探测失败，不能当作干净）", head_short: status.head.short, branch: status.head.branch };
    }
    if (total === 0) {
      return {
        state: "saved",
        label: `工作树与 HEAD 一致（本地已保存为 ${status.head.short ?? "（空仓库）"}${status.head.branch ? ` · ${status.head.branch}` : ""}）`,
        head_short: status.head.short,
        branch: status.head.branch,
      };
    }
    return {
      state: "unsaved",
      label: `这批改动还没有保存为本地 Git 版本（HEAD ${status.head.short ?? "（空仓库）"}${status.head.branch ? ` · ${status.head.branch}` : ""}，${total} 个文件有改动）`,
      head_short: status.head.short,
      branch: status.head.branch,
    };
  })();

  // 成果口径（补修 D）：不再有"有相关提交 + 证据在册"或"工作树干净"这两条直通通过的分支。
  // 不是仓库 / 探测失败 → unknown（无从判断，不编依据）；其余一律走同一条判定 `assessBatchVerification`：
  // 工作树干净时判定的对象是**最近一次成果提交**，且工作树干净这件事本身只说"没有待保存改动"。
  const verification: VersionReminderPayload["verification"] = !status.repository.is_repository
    ? {
        state: "unknown",
        label: "未使用 Git：这批改动有没有通过检查无从由 Git 判断（不显示为已保存）",
        related_submission_ids: [],
        related_evidence_ids: [],
        related_task_ids: [],
        detail: null,
      }
    : !hasBuckets
      ? {
          state: "unknown",
          label: "探测失败：这批改动有没有通过检查无从判断（不显示为干净、也不算稳定成果）",
          related_submission_ids: [],
          related_evidence_ids: [],
          related_task_ids: [],
          detail: null,
        }
      : {
          state: related.verification.state,
          label:
            related.verification.label +
            (total === 0 && related.verification.state === "unverified"
              ? "（工作树干净 = 没有待保存改动；验证状态另算）"
              : ""),
          related_submission_ids: related.submission_ids,
          related_evidence_ids: related.evidence_ids,
          related_task_ids: related.task_ids,
          detail: related.verification,
        };

  const remote = {
    state: status.tracking_observation.state,
    label: TRACKING_LABELS[status.tracking_observation.state],
    upstream: status.tracking_observation.upstream,
    ahead: status.tracking_observation.ahead,
    behind: status.tracking_observation.behind,
    observed_at: status.tracking_observation.observed_at,
    basis: "local_refs_only" as const,
    fetched: false as const,
  };

  const summary = !status.repository.is_repository
    ? `未使用 Git：${status.repository.note}`
    : !hasBuckets
      ? "只读探测失败：工作树状态未知（不当作干净）"
      : total === 0
        ? `工作树干净：与 HEAD ${status.head.short ?? "（空仓库）"} 一致`
        : `${total} 个文件有改动（暂存 ${byKind.staged} / 未暂存 ${byKind.modified} / 未跟踪 ${byKind.untracked} / 冲突 ${byKind.conflicted}）`;

  const shown = entries.slice(0, REMINDER_FILE_LIMIT);
  const agentNote = [
    `【塔台只读探测】${opts.project_name ?? ""} 本地 Git 保存版本提醒`,
    `- 检测时间：${status.detected_at}`,
    `- HEAD：${status.head.short ?? "（空仓库/未知）"}${status.head.branch ? ` · 分支 ${status.head.branch}` : status.head.detached ? " · 游离头" : ""}`,
    `- 变更摘要：${summary}`,
    fingerprint === null ? "- 变更指纹：未知（探测失败）" : `- 变更指纹：${fingerprint}`,
    `- 远端：${remote.label}（上游 ${remote.upstream ?? "无"}；观测时间 ${remote.observed_at}；只读本地引用、未联网）`,
    `- 私有事实：\`.工作台/\` 备份状态未知（Git 忽略 ≠ 已备份）；本机显式备份/恢复入口已交付（${BACKUP_FLOW_NOTE}）`,
    `- 成果口径（${verification.state}）：${verification.label}`,
    ...(verification.detail === null ? ["  （不是仓库 / 探测失败：无从判断，不编依据）"] : verificationNoteLines(verification.detail)),
    "- 文件范围（工作树根相对）：",
    ...(shown.length === 0
      ? ["  （无）"]
      : shown.map((e) => `  [${e.kind}] ${e.path}${e.in_project ? "" : "（不在本项目根内）"}`)),
    ...(entries.length > shown.length ? [`  …另有 ${entries.length - shown.length} 个未列出（共 ${entries.length}）`] : []),
    "",
    "请按项目惯例整理这批改动：先跑该卡要求的检查命令并保留输出，再决定是否提交为本地 Git 版本。",
    "塔台**没有**替你执行任何 Git 写操作，也没有 fetch/推送；`.工作台/` 属于私有事实，不要提交进公开仓库。",
  ].join("\n");

  return {
    change_fingerprint: fingerprint,
    summary,
    local_commit: localCommit,
    file_scope: {
      files: shown,
      total: entries.length,
      omitted: Math.max(0, entries.length - shown.length),
      by_kind: byKind,
    },
    last_detected_at: status.detected_at,
    remote,
    private_facts: {
      backed_up: "unknown",
      backup_flow_available: status.private_backup_known.backup_flow_available,
      label: status.private_backup_known.reason,
    },
    verification,
    probe_error: status.error,
    is_repository: status.repository.is_repository,
    agent_note: agentNote,
  };
}
