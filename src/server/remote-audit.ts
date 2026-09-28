// ═══════════════════════════════════════════════════════════════════════════════════
// 三期 S3：远程访问审计日志（PLAN.md S3 卡 DoD②；红线依据 DESIGN.md §10.2 私人数据隔离）。
//
// ██ 落点：全局数据目录，绝不进项目、绝不进仓库 ██
// `<全局数据目录>/logs/remote-audit.jsonl`（DESIGN.md §8.1 第一层全局层；全局数据目录 = `TATAI_HOME` > 缺省 `~/.tatai/`），
// 与 U2 的 `backend.log` 同一层、同一目录名（`backendLog.LOG_DIR_NAME` 是目录名的唯一出处，本文件不另写一份）。
// **明确不许**落进任何被纳管项目的 `.工作台/`、不许落进 repo——审计记录在这里是"谁在什么时候访问了这台机器"，
// 一旦写进项目就等于把访问记录本身变成了泄漏源（PLAN S3「跑偏点」）。防线两层：
//   ① 路径只由 `resolveDataDir()` 拼出来（不接受调用方传任意路径）；
//   ② 构造时若发现目标落在 repo 内（`repoRoot` 由调用方给 = 进程 cwd）直接抛 `AuditPathError` 拒绝启动
//      ——TATAI_HOME 被误设成 repo 里某个目录时，宁可不启动，也不把访问记录写进仓库。
//
// ██ 记什么 ██
// 非回环来源的每一次远程请求（放行与拒绝都记）：`ts / 来源 IP / 方法 / 路径 / 结果码 / 拒绝码或动作 /
// 会话指纹`。**口令原文一律不记**：指纹走 `auth.ts#tokenFingerprint`（sha256 前 12 位，单向），
// 拒绝时连指纹都没有（凭据不对就不该被记成"哪个凭据"），只记凭据**种类**（token/session/none）。
// 路径只记归一后的 path（去 query）——query 里可能有检索词，那是内容不是访问足迹。
//
// ██ 三种 actor（PLAN S3：服务端自身副作用要与远程写请求分开记）██
//   · `remote`      —— 非回环来源的远程请求（放行/拒绝各一条）
//   · `local`       —— 本机（回环 / 主机命令行）触发的状态变更：写模式开/关标记、进程启停
//   · `server-init` —— 服务端**自己**产生的副作用（如读 progress 时缺文件自动初始化建了文件）：
//                      它既不是远程写请求，也不是用户动作，所以单列 actor，并用 `on_behalf_of`
//                      说明是哪个来源的请求把它带出来的。
//
// ██ 增长控制 ██
// 只追加；单文件超 `AUDIT_MAX_BYTES` 时滚动成 `.1`（旧的依次后移，最多留 `AUDIT_MAX_ARCHIVES` 份归档，
// 与 backendLog/E3 历史的滚动同一手法，只是这里多留几份——访问足迹的窗口比排障日志更值钱；仍不引日志框架）。
// 文件按 0600 建、目录 0700（口径与 auth.json 一致，
// 见 `permissionHint()`；Windows 上 chmod 只动只读位，真实保护取决于该用户 profile 目录 ACL）。
// ═══════════════════════════════════════════════════════════════════════════════════
import fs from "node:fs";
import path from "node:path";
import { LOG_DIR_NAME } from "./backendLog";
import { SESSION_ID_PREFIX, TOKEN_LENGTH, isInsideRepo } from "./auth";
import { sanitizeErrorMessage } from "./redact";
import { nowIso } from "./time";

/** 审计日志文件名（`<全局数据目录>/logs/remote-audit.jsonl`） */
export const AUDIT_FILE_NAME = "remote-audit.jsonl";
/** 单文件滚动阈值（超过即滚动成 `.1`，最多留 AUDIT_MAX_ARCHIVES 份归档） */
export const AUDIT_MAX_BYTES = 2 * 1024 * 1024;
export const AUDIT_MAX_ARCHIVES = 3;

/** 一行审计记录是谁产生的（见文件头"三种 actor"） */
export type AuditActor = "remote" | "local" | "server-init";

/**
 * 一行审计记录的"动作"字段（拒绝码在 `code`，动作在 `action`，二者合起来就是 DoD② 要的
 * "结果码 / 拒绝码或动作"）：
 *   read/write/session/public —— 已放行的远程请求按性质分类
 *   rejected                  —— 被放行口拦下的远程请求（`code` 给具体拒绝码）
 *   side-effect               —— 服务端自身副作用（actor=server-init）
 *   write-mode-on/off         —— 写模式时间段边界（actor=local，`source` 说谁翻的）
 *   server-start/stop         —— 进程启停（审计文件自身的生命周期标记）
 */
export type AuditAction =
  | "read"
  | "write"
  | "session"
  | "public"
  | "rejected"
  | "side-effect"
  | "write-mode-on"
  | "write-mode-off"
  | "server-start"
  | "server-stop";

/** 一行审计记录（jsonl 一行 = 一次可追溯的访问足迹） */
export interface RemoteAuditLine {
  ts: string;
  actor: AuditActor;
  action: AuditAction;
  /** 来源 IP（真实地址；对外贴证据时用 `maskIpForReport` 打码） */
  ip: string | null;
  method: string | null;
  /** 归一后的请求路径（去 query） */
  path: string | null;
  /** HTTP 结果码（拒绝时为拒绝码对应的状态码） */
  status: number | null;
  /** 拒绝码（放行/状态变更时为 null） */
  code: string | null;
  /** 会话/口令指纹（sha256 前 12 位；**口令原文永不入日志**） */
  fingerprint: string | null;
  /** 凭据种类：token / session / none（只记种类，不记内容） */
  credential: "token" | "session" | "none" | null;
  /** 路径里认出来的项目 id（/api/projects/:id/... 时给出；便于按项目圈访问足迹） */
  project_id: string | null;
  /** 写模式边界/进程启停的来源（`startup:env` / `cli` / `shutdown`），其余为 null */
  source: string | null;
  /** server-init 行专用：这次副作用是替谁做的（remote = 远程请求带出来的） */
  on_behalf_of?: AuditActor;
  /** server-init 行专用：这次建了哪些文件（项目内相对路径，不写本机绝对路径） */
  files?: string[];
  /** 补充说明（人读；不放敏感内容） */
  note?: string | null;
}

/** 审计落点被红线拦下（落在 repo 内）时抛它，调用方启动期 fail-fast */
export class AuditPathError extends Error {
  readonly file: string;
  constructor(file: string, repoRoot: string) {
    super(
      `审计日志落点被拒：${file} 落在仓库/项目内（repoRoot=${repoRoot}）——` +
        "审计记录绝不进仓库（PLAN S3 跑偏点：把访问记录变成泄漏源）。请把 TATAI_HOME 指到项目外。",
    );
    this.name = "AuditPathError";
    this.file = file;
  }
}

/** 审计文件路径（唯一拼法；只由全局数据目录派生） */
export function auditFilePath(dataDir: string): string {
  return path.join(dataDir, LOG_DIR_NAME, AUDIT_FILE_NAME);
}

/**
 * 对外贴证据用的 IP 打码（PLAN S3 验收："贴真实行（IP 打码为 `192.168.x.x`）"）：
 * 局域网 IPv4 只留前两段，IPv6 只留前两段。**只用于打印**——落盘的是真实地址（排查要用）。
 */
export function maskIpForReport(ip: string | null | undefined): string {
  if (typeof ip !== "string" || ip === "") return "(未知)";
  const mapped = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  if (mapped === "::1" || mapped === "127.0.0.1" || mapped === "localhost") return mapped === "localhost" ? "127.0.0.1" : mapped;
  const v4 = mapped.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) return `${v4[1]}.${v4[2]}.x.x`;
  const seg = mapped.split(":");
  return seg.length > 1 ? `${seg[0]}:${seg[1]}:x::x` : mapped;
}

/**
 * 滚动：当前文件超阈值时归档成 `.1`（旧的依次后移，最老的一份删掉）——
 * **后移必须从最老往新做**：先把 `.{N-1}` 挪到 `.{N}`……再把 `.1` 挪到 `.2`，最后当前文件 → `.1`。
 * 少了"`.1` → `.2`"这一步，第二次滚动就会把上一份 `.1` 直接覆盖掉（实测过的坑：归档只留一份）。
 */
function rotateIfNeeded(file: string, maxBytes: number, maxArchives: number): void {
  if (!fs.existsSync(file)) return;
  if (fs.statSync(file).size < maxBytes) return;
  const oldest = `${file}.${maxArchives}`;
  if (fs.existsSync(oldest)) fs.rmSync(oldest, { force: true });
  for (let i = maxArchives - 1; i >= 1; i--) {
    const from = `${file}.${i}`;
    if (fs.existsSync(from)) fs.renameSync(from, `${file}.${i + 1}`);
  }
  fs.renameSync(file, `${file}.1`);
}

/**
 * 审计日志（只追加）。构造不做任何 I/O（默认关闭远程时连目录都不建）；第一次 `record` 才落盘。
 * 落盘失败**不阻断服务**（审计是旁路，见 `record`），但失败本身要能看见（Q54）：累计次数与最近原因
 * 由 `health()` 给出，`GET /health` 一并回出来——不再只有 stderr 那一行。
 */
export class RemoteAuditLog {
  readonly dataDir: string;
  readonly dir: string;
  readonly file: string;
  private readonly clock: () => Date;
  private readonly maxBytes: number;
  /** 落盘失败累计次数（Q54：审计缺口的结构化出口，"写不进去"不再只有 stderr 一行） */
  private failedWrites = 0;
  /** 最近一次落盘失败的原因（已过消息级脱敏：`/health` 可能被远程读到） */
  private lastWriteError: string | null = null;

  constructor(opts: { dataDir: string; repoRoot?: string | null; now?: () => Date; maxBytes?: number }) {
    this.dataDir = opts.dataDir;
    this.dir = path.join(opts.dataDir, LOG_DIR_NAME);
    this.file = auditFilePath(opts.dataDir);
    this.clock = opts.now ?? (() => new Date());
    this.maxBytes = opts.maxBytes ?? AUDIT_MAX_BYTES;
    // 红线：审计记录绝不落进 repo / 项目（构造期就拦，不给"先写再发现"的机会）
    if (opts.repoRoot && isInsideRepo(this.file, opts.repoRoot)) {
      throw new AuditPathError(this.file, opts.repoRoot);
    }
  }

  filePath(): string {
    return this.file;
  }

  /**
   * 追加一行；返回落盘的那行（ts 未给则补当前时间）。落盘失败不影响服务本体（审计是旁路）。
   *
   * Q54（2026-09-18 审计）：此前失败只 `console.error` 一行就照常返回，调用方又一律不看返回值——
   * 远程访问足迹的缺口**只存在于 stderr**（打包态再被抄进 backend.log），没有任何结构化出口。
   * 现在失败会累加 `failedWrites` 并记下最近原因，`health()` / `GET /health` 可见；服务照常继续
   * （"旁路"这个口径不变：审计写不进去不该把后端带走，但它必须**看得见**，不能静默）。
   */
  record(line: Omit<RemoteAuditLine, "ts"> & { ts?: string }): RemoteAuditLine {
    const full: RemoteAuditLine = { ts: line.ts ?? nowIso(), ...line } as RemoteAuditLine;
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      try {
        fs.chmodSync(this.dir, 0o700);
      } catch {
        // Windows 上 chmod 能力有限，不因此阻断（权限提示见 permissionHint）
      }
      rotateIfNeeded(this.file, this.maxBytes, AUDIT_MAX_ARCHIVES);
      fs.appendFileSync(this.file, JSON.stringify(full) + "\n", { encoding: "utf8", mode: 0o600 });
      try {
        fs.chmodSync(this.file, 0o600);
      } catch {
        // 同上
      }
    } catch (e) {
      // 消息过脱敏：本函数的结果会经 `/health` 出网，fs 级异常的原文里常带本机绝对路径
      const reason = sanitizeErrorMessage((e as Error).message);
      this.failedWrites += 1;
      this.lastWriteError = reason;
      console.error(
        `[remote-audit] 审计落盘失败（旁路，不阻断服务；累计 ${this.failedWrites} 次，/health 可见）：${reason}`,
      );
    }
    return full;
  }

  /** 审计落盘健康度（Q54 的结构化出口：调用方不看 `record()` 返回值也能查到缺口） */
  health(): { file: string; failed_writes: number; last_error: string | null } {
    return { file: this.file, failed_writes: this.failedWrites, last_error: this.lastWriteError };
  }

  /** 读最后 N 行（验证脚本/人工排查用；坏行跳过不抛） */
  tail(limit = 50): RemoteAuditLine[] {
    if (!fs.existsSync(this.file)) return [];
    const lines = fs.readFileSync(this.file, "utf8").split(/\r?\n/).filter((l) => l.trim() !== "");
    const out: RemoteAuditLine[] = [];
    for (const raw of lines.slice(-limit)) {
      try {
        out.push(JSON.parse(raw) as RemoteAuditLine);
      } catch {
        // 坏行跳过：审计读取不该因为一行损坏而整体失败
      }
    }
    return out;
  }

  /** 权限提示文案（口径与 auth.json 的 permissionHint 一致：0600 + 目录 0700） */
  permissionHint(): string {
    if (process.platform === "win32") {
      return (
        `${this.file} 按 0600 写（目录 0700）；Windows 上 chmod 只动只读位，真实保护取决于用户 profile ` +
        "目录 ACL（逐用户隔离；共享/多用户机器请自行收紧该目录权限）"
      );
    }
    return `${this.file} 按 0600（目录 0700）落盘：仅本用户可读`;
  }
}

/**
 * 远程访问足迹的"动作"分类（放行的请求按性质分档，写进审计 action 字段）。
 * 会话生命周期两条路径单列 `session`，其余按读/写方法分读与写。
 */
export function actionOfRequest(pathName: string, method: string): AuditAction {
  if (pathName === "/api/remote/login" || pathName === "/api/remote/logout") return "session";
  if (pathName === "/" || pathName === "/remote") return "public";
  const m = method.toUpperCase();
  return m === "GET" || m === "HEAD" || m === "OPTIONS" ? "read" : "write";
}

/**
 * 从请求路径里认项目 id（`/api/projects/:id/...`；认不出为 null）。
 *
 * Q121（2026-09-19 审计）：原先是裸 `decodeURIComponent`——畸形百分号编码（一条 `%`、`%ZZ`）
 * 抛 `URIError`，而本函数的三处调用点都在**审计落盘**的实参求值期（放行口拒绝支、放行支的
 * `res.on("finish")` 回调）：拒绝支在求值期抛 → 审计零痕迹且响应被顶层收成 500（本该 401）；
 * `finish` 回调里抛 → 直达 `uncaughtException` → 整进程 exit(1)。一枚只读 token 打一条
 * `/api/projects/%/…` 就能远程打停后端。审计字段只是"顺带记一下项目 id"，
 * 认不出就写 null——绝不为它抛异常。
 */
export function projectIdOfPath(pathName: string | null | undefined): string | null {
  if (typeof pathName !== "string") return null;
  const m = pathName.match(/^\/api\/projects\/([^/?]+)(?:\/|$)/);
  if (!m || m[1] === "") return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
}

/** 凭据种类（只看前缀，不看内容：口令原文永不入日志）。
 *  Q137（2026-09-19 审计）：口径补一条"先排除口令"——口令恒 43 字符（`TOKEN_LENGTH`）、会话恒 24 字符；
 *  旧版 `generateToken` 可能签发过 `s_` 开头的口令（那种凭据放行口按口令路径走），
 *  这里要与实际分流一致，不能只凭前缀就记成 session。 */
export function credentialKindOf(credential: string | null | undefined): "token" | "session" | "none" {
  if (typeof credential !== "string" || credential === "") return "none";
  if (credential.length === TOKEN_LENGTH) return "token";
  return credential.startsWith(SESSION_ID_PREFIX) ? "session" : "token";
}
