// ═══════════════════════════════════════════════════════════════════════════════════
// 三期 S3：远程写模式的**运行期**状态（PLAN.md S3 卡 DoD①③）。
//
// 为什么要有这一层：S1 的双开关（`TATAI_REMOTE_WRITE` + 确认语 `TATAI_REMOTE_WRITE_CONFIRM`）是**启动期**口径，
// 只给得起"开"；而 DoD③ 要求"关闭写模式后所有写接口**立刻**失效"，跑偏点更写明"关闭后仍能写（需重启才生效）
// 直接打回"——于是写模式必须是**可运行期翻转**的状态，且翻转立即对下一个请求生效。
//
// ██ 状态怎么表达（两个乘数，缺一不可）██
//   · `armed`（启动期是否给了双开关）—— 来自 `remote-config.ts` 的 `cfg.writeEnabled`，进程内不变。
//     **运行期永远不能把没 armed 的机器打开写模式**（红线④：写模式必须显式开启，且要人亲手给确认语）。
//   · `<全局数据目录>/remote/write-mode.json` 开关文件 —— 运行期状态载体：
//       `{kind:"tatai-remote-write-mode", version:1, enabled:bool, at:ISO, by:string}`
//     为什么用**文件**而不是 HTTP 接口：主机与远程设备在同一条 HTTP 面上无法区分——服务只绑局域网 IP 时，
//     本机发出的请求来源也是那个局域网 IP（不是回环），"主机专属接口"根本立不住。而**主机文件系统**是天然的
//     信任边界：能写这个文件的进程本来就能改这台机器上的任何东西。远程设备碰不到它，所以远程**不可能自己开**写模式。
//   · 生效值 `enabled = armed && 开关文件.enabled`——文件只能"关得更严"，永远不能突破 armed（红线④不可绕过）。
//     文件**缺失/损坏 → 一律按「关」算**（fail-closed，Q94）：文件是运行期的唯一事实载体，读不出来就先当
//     关着、并在快照里如实报出原因（`stateFileError`），要开得重新 `remote:write on --confirm …`。
//     此前是"回落到启动期口径 = armed"——armed=true 时那等于**无提示地继续放行**（fail-open：
//     用户以为关了、文件坏掉又打开），与本文件"文件只能关得更严"的承诺自相矛盾。
//
// ██ 立刻失效怎么做到 ██
// 放行口每个请求调一次 `enabled()`：它对比开关文件的 `mtimeMs + size`，变了才重读（一次 `statSync`，微秒级）。
// 所以 `pnpm remote:write off` 之后**下一个**写请求就吃 403 `REMOTE_READ_ONLY`，不需要重启、不需要重连。
//
// ██ 二次确认（DoD①）██
//   · 启动期开：两道开关 + 逐字确认语（S1 口径，`resolveRemoteConfig` 里 fail-fast）；
//   · 运行期重新打开：`setEnabled(true)` 同样要求逐字确认语（CLI 用 `--confirm "我确认开启远程写模式"`），
//     并且必须在 armed 的进程里——**没有"顺手打开"的路径**；
//   · 关闭不要确认语：往安全方向走的动作不该设门槛（要关还被拦，用户就会去改环境变量重启，那正是跑偏点）。
//
// ██ 时段标记（DoD①）██
// 每一次真实翻转都在审计里留一条 `write-mode-on` / `write-mode-off`（带时间戳与来源 `by`），
// 于是"写模式时间段"就是审计文件里这些边界行圈出来的区间——事后可倒查某次写请求落在哪个时段。
// ═══════════════════════════════════════════════════════════════════════════════════
import fs from "node:fs";
import path from "node:path";
import { REMOTE_DATA_SUBDIR, WRITE_CONFIRM_PHRASE, WRITE_MODE_SWITCHES } from "./remote-config";
import type { RemoteAuditLog } from "./remote-audit";
import { nowIso, toIso } from "./time";

/** 开关文件名（与 auth.json 同目录：`<全局数据目录>/remote/`） */
export const WRITE_MODE_STATE_FILE = "write-mode.json";

/** 开关文件读不出来时的两种原因（Q94：如实回报，不静默回落到启动期口径） */
const STATE_FILE_MISSING = "开关文件不存在（本次进程没写过它，或被删掉了）";
const STATE_FILE_MALFORMED = "开关文件损坏/形状不对";

export interface WriteModeFile {
  kind: "tatai-remote-write-mode";
  version: 1;
  enabled: boolean;
  at: string;
  /** 谁翻的：`startup:env` / `cli` / `shutdown` */
  by: string;
}

export interface WriteModeSnapshot {
  /** 启动期双开关是否给了（没给 = 运行期永远打不开） */
  armed: boolean;
  /** 当前生效值（= armed && 开关文件里明确写着 enabled:true） */
  enabled: boolean;
  /** 当前状态起点（开关文件的 `at`；文件读不出来时 = 启动时刻） */
  since: string;
  /** 当前状态来源（`startup:env` / `cli` / `shutdown` / `state-file-unreadable`…） */
  source: string;
  stateFile: string;
  /**
   * 开关文件读不出来的原因（Q94：缺失/损坏/形状不对）；`null` = 文件正常。
   * 非 null 时 `enabled` 一律为 false（fail-closed），调用方/CLI 据此把"文件不在了"这件事说清楚。
   */
  stateFileError: string | null;
}

export type WriteModeError = "WRITE_MODE_NOT_ARMED" | "WRITE_CONFIRM_REQUIRED";

export type WriteModeResult =
  | { ok: true; changed: boolean; snapshot: WriteModeSnapshot }
  | { ok: false; code: WriteModeError; message: string };

/** 开关文件路径（与口令文件同目录，全局数据目录内） */
export function writeModeStatePath(dataDir: string): string {
  return path.join(dataDir, REMOTE_DATA_SUBDIR, WRITE_MODE_STATE_FILE);
}

/** 运行期翻写模式要逐字给的确认语（与启动期同一个常量，别处不再写第二份） */
export function writeModeConfirmHint(): string {
  return `运行期打开写模式要逐字给出确认语：--confirm "${WRITE_CONFIRM_PHRASE}"`;
}

/** 打开写模式的完整前置条件（启动日志 / CLI 提示共用一段话） */
export function writeModeArmHint(): string {
  return `写模式要两道开关都齐：${WRITE_MODE_SWITCHES.join(" + ")}（确认语逐字）`;
}

/**
 * 写模式运行期控制器。构造不做 I/O；`applyStartup()` 落启动期口径并记审计标记。
 */
export class WriteModeController {
  readonly dataDir: string;
  readonly stateFile: string;
  /** 启动期双开关是否给了（进程内不变；运行期只能关、不能凭空开） */
  readonly armed: boolean;
  private readonly startupEnabled: boolean;
  private readonly audit: RemoteAuditLog | null;
  private readonly clock: () => Date;
  private fileState: WriteModeFile | null;
  private fileStamp: string | null = null;
  /** 当前缓存对应的"读不出来原因"（与 fileStamp 同生命周期；Q94） */
  private fileError: string | null = null;
  /** 已就"开关文件读不出来"告警过一次的原因（只在状态变化时打一行，不按请求刷屏） */
  private reportedError: string | null = null;

  constructor(opts: {
    dataDir: string;
    startupEnabled: boolean;
    audit?: RemoteAuditLog | null;
    now?: () => Date;
  }) {
    this.dataDir = opts.dataDir;
    this.stateFile = writeModeStatePath(opts.dataDir);
    this.armed = opts.startupEnabled;
    this.startupEnabled = opts.startupEnabled;
    this.audit = opts.audit ?? null;
    this.clock = opts.now ?? (() => new Date());
    this.fileState = null;
  }

  /**
   * 读开关文件。返回内容 + **读不出来的原因**（Q94）：文件不存在、JSON 坏、形状不对都算"读不出来"，
   * 一律给 `file: null` + 具体原因（不再悄悄回落到启动期口径）。
   */
  private readStateFile(): { file: WriteModeFile | null; error: string | null } {
    if (!fs.existsSync(this.stateFile)) {
      this.fileStamp = null;
      this.fileState = null;
      this.fileError = STATE_FILE_MISSING;
      return { file: null, error: this.fileError };
    }
    const stat = fs.statSync(this.stateFile);
    const stamp = `${stat.mtimeMs}:${stat.size}`;
    if (stamp === this.fileStamp) return { file: this.fileState, error: this.fileError };
    this.fileStamp = stamp;
    try {
      const raw = JSON.parse(fs.readFileSync(this.stateFile, "utf8")) as WriteModeFile;
      if (raw && raw.kind === "tatai-remote-write-mode" && typeof raw.enabled === "boolean") {
        this.fileState = raw;
        this.fileError = null;
      } else {
        // 坏文件不猜：不沿用、不覆盖，按"读不出来"如实报（Q94）
        this.fileState = null;
        this.fileError = STATE_FILE_MALFORMED;
      }
    } catch {
      this.fileState = null;
      this.fileError = STATE_FILE_MALFORMED;
    }
    return { file: this.fileState, error: this.fileError };
  }

  /** 当前快照（每次调用一次 stat，变了才重读——这就是"立刻失效"的实现） */
  snapshot(): WriteModeSnapshot {
    const { file, error } = this.readStateFile();
    // Q94（2026-09-18 审计）：**缺失/坏文件一律按「关」算**（fail-closed）。此前回落启动期 armed 口径，
    // armed=true 时就是无提示地继续放行——"用户以为关了、文件坏掉又打开"，方向是 fail-open。
    // 现在只认文件里明确写的 `enabled:true`；文件读不出来就先当关着（要开得重新 `remote:write on`）。
    const fileEnabled = file !== null && file.enabled;
    if (this.armed && error !== this.reportedError) {
      this.reportedError = error;
      if (error) {
        console.error(
          `[write-mode] ⚠ ${error}（${this.stateFile}）：写模式按「关」算（fail-closed）` +
            "——要开得重新 `pnpm remote:write on --confirm \"我确认开启远程写模式\"`",
        );
      } else {
        console.log("[write-mode] 开关文件恢复可读，写模式口径回到文件事实");
      }
    }
    return {
      armed: this.armed,
      enabled: this.armed && fileEnabled,
      since: file ? file.at : this.startupAt(),
      source: file ? file.by : "state-file-unreadable",
      stateFile: this.stateFile,
      stateFileError: error,
    };
  }

  /** 当前生效值（放行口每请求调一次；微秒级的 stat，无读文件开销） */
  enabled(): boolean {
    return this.snapshot().enabled;
  }

  private startupAt(): string {
    // 没有开关文件时，状态起点就是"本次进程启动给的那个口径"；用当前时间不可靠，故记进程启动时刻
    return PROCESS_STARTED_AT;
  }

  private writeStateFile(enabled: boolean, by: string): WriteModeFile {
    const file: WriteModeFile = {
      kind: "tatai-remote-write-mode",
      version: 1,
      enabled,
      at: toIso(this.clock()),
      by,
    };
    const dir = path.dirname(this.stateFile);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      // Windows 上 chmod 能力有限，不因此阻断
    }
    const tmp = `${this.stateFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(file, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, this.stateFile);
    try {
      fs.chmodSync(this.stateFile, 0o600);
    } catch {
      // 同上
    }
    // Q82（2026-09-18 审计）：这里原先是 rename 之后**再 stat 一次**、拿它的 mtime/size 当缓存戳
    // （`fileStamp`）+ 把自己刚写的对象当缓存值（`fileState`）。rename 与 stat 之间若有别的写者落盘
    // （`pnpm remote:write off` 那个 CLI 进程，或主机上另一条命令），缓存里就存下"**别人的**戳 +
    // **自己的**内容"：此后 stamp 永远命中，服务端再也不重读那个文件——写模式可能**关不掉**
    // （安全方向 fail-open）。
    // 改法：不自封戳，直接让缓存失效——下一次 `snapshot()` 走一次真实 stat + 读盘，读到什么就是什么
    // （别人写过就以别人为准）。代价是紧接着那次多读一个小文件（微秒级）。
    this.fileStamp = null;
    this.fileState = null;
    return file;
  }

  /**
   * 启动期应用一次：把启动口径落成开关文件（覆盖上一轮残留，避免"上轮开着这轮没开却仍能写"），
   * 并在审计里记写模式时段边界（DoD①："开启/关闭各记一条，带时间戳与来源"）。
   */
  applyStartup(): WriteModeSnapshot {
    const file = this.writeStateFile(this.startupEnabled, "startup:env");
    this.audit?.record({
      actor: "local",
      action: this.startupEnabled ? "write-mode-on" : "write-mode-off",
      ip: "127.0.0.1",
      method: null,
      path: null,
      status: null,
      code: null,
      fingerprint: null,
      credential: null,
      project_id: null,
      source: "startup:env",
      note: this.startupEnabled
        ? `写模式时段起点：启动期双开关已给（${WRITE_MODE_SWITCHES.join(" + ")}），非回环来源可发起写请求`
        : "写模式未开启（默认只读）：本次进程内远程来源只放行读方法",
    });
    return { ...this.snapshot(), since: file.at, source: file.by };
  }

  /**
   * 运行期翻转。`enabled:true` 要 armed + 逐字确认语；`false` 不要确认语（往安全方向不设门槛）。
   * 开关文件里的值没变时不重复写标记（时段边界只在真实翻转处留痕）。
   */
  setEnabled(enabled: boolean, opts: { by: string; confirm?: string | null }): WriteModeResult {
    if (enabled && !this.armed) {
      return {
        ok: false,
        code: "WRITE_MODE_NOT_ARMED",
        message:
          `运行期打不开写模式：本次进程**启动期没有给双开关**（${writeModeArmHint()}）——` +
          "写模式的红线是「显式开启」，不能由运行期补票（见 remote-config.ts 红线④）",
      };
    }
    if (enabled && (opts.confirm ?? "").trim() !== WRITE_CONFIRM_PHRASE) {
      return {
        ok: false,
        code: "WRITE_CONFIRM_REQUIRED",
        message: `运行期打不开写模式：缺二次确认——${writeModeConfirmHint()}`,
      };
    }
    const before = this.snapshot();
    // Q126（2026-09-19 审计）：判"值没变"必须看**开关文件里写的那个值**，不能看 `before.enabled`
    // （= armed && 文件值）——armed 是**进程级**乘数，两个进程可以不同：服务带双开关起来
    // （armed=true、文件 enabled=true），主机上另开一个终端跑 `pnpm remote:write off`，那个 CLI 进程
    // 自己没有环境变量（armed=false）→ `before.enabled` 算出来恰好也是 false，与目标值相同 →
    // 早退不落盘 → CLI 打印"本来就是关的"，而**服务端继续放行远程写**（安全方向 fail-open，且全静默）。
    // 文件是运行期状态的唯一载体，就按它判：文件说 true、目标 false 就必须落盘。
    const fileEnabled = this.fileState !== null && this.fileState.enabled;
    if (fileEnabled === enabled) {
      return { ok: true, changed: false, snapshot: before };
    }
    const file = this.writeStateFile(enabled, opts.by);
    this.audit?.record({
      actor: "local",
      action: enabled ? "write-mode-on" : "write-mode-off",
      ip: "127.0.0.1",
      method: null,
      path: null,
      status: null,
      code: null,
      fingerprint: null,
      credential: null,
      project_id: null,
      source: opts.by,
      note: enabled
        ? `写模式时段起点：运行期显式打开（来源 ${opts.by}），非回环来源可发起写请求`
        : `写模式时段终点：运行期关闭（来源 ${opts.by}），写接口立即失效——下一个写请求即 403 REMOTE_READ_ONLY`,
    });
    return { ok: true, changed: true, snapshot: { ...this.snapshot(), since: file.at, source: opts.by } };
  }

  /** 进程退出时收尾：写模式时段终点（当时开着才记）+ 进程停标记 */
  closeOnShutdown(why = "shutdown"): void {
    const snap = this.snapshot();
    if (snap.enabled) {
      this.writeStateFile(false, why);
      this.audit?.record({
        actor: "local",
        action: "write-mode-off",
        ip: "127.0.0.1",
        method: null,
        path: null,
        status: null,
        code: null,
        fingerprint: null,
        credential: null,
        project_id: null,
        source: why,
        note: `写模式时段终点：进程退出（${why}）`,
      });
    }
    this.audit?.record({
      actor: "local",
      action: "server-stop",
      ip: "127.0.0.1",
      method: null,
      path: null,
      status: null,
      code: null,
      fingerprint: null,
      credential: null,
      project_id: null,
      source: why,
      note: "塔台后端进程退出（写模式时段到此为止）",
    });
  }
}

/** 进程启动时刻（无开关文件时用它当状态起点，别用"当前时间"糊） */
const PROCESS_STARTED_AT = nowIso();
