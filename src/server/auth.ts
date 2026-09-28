// ═══════════════════════════════════════════════════════════════════════════════════
// 三期 S1：远程访问鉴权模块（PLAN.md S1 卡指定路径；红线依据 DESIGN.md §10.2 私人数据隔离）。
//
// 五条硬口径：
//   ① 随机源与长度：`crypto.randomBytes(32)` → base64url 43 字符（256 bit 熵），**不用 Math.random**
//      （不可预测性靠 CSPRNG，长度与编码都写死成常量，见 TOKEN_BYTES / TOKEN_ENCODING）。
//   ② 必须 token：非回环来源（isLoopbackAddress=false）无 token 不放行——`guardRemoteRequest` 是
//      唯一的放行口，index.ts 在每个请求进路由之前调它（先鉴权再路由，不给"先连上再补"的缝）。
//   ③ 过期：口令（token）与会话（session）各有 TTL，过期即 401；TTL 可配，但下限/上限都卡住
//      （见 remote-config.ts 的 parseTtlMs，不存在"永不过期"）。
//   ④ 会话与登出：口令换会话（`s_` 前缀 id，128 bit），`logout()` 立刻失效，过期自清。
//   ⑤ 存取位置：口令落**全局数据目录** `<dataDir>/remote/auth.json`（DESIGN.md §8.1 全局层），
//      绝不进 repo、不进任何被纳管项目；文件按 0600 建（POSIX 生效；Windows 上 chmod 只动只读位，
//      真实保护取决于该用户 profile 目录的 ACL，见 `permissionHint()`）。
//
// 本机回环（127.0.0.1 / ::1）不算"远程"：与桌面壳同信任域，行为与 S1 之前逐字相同
// （否则 50 余个既有 verify 脚本与本地 UI 全要拿 token，那是另一种失控）。
//
// ── 三期 S2：只读远程模式（PLAN.md S2 卡）在本文件追加的四件事 ──
//   ⑥ 会话生命周期**只开一个口子**：`POST /api/remote/login` 与 `POST /api/remote/logout` 是 POST，
//      若按只读红线一律 403，远程就永远换不到会话、也永远登不出去（DoD③ 直接做不到）。故这两条
//      路径进 `READ_ONLY_EXEMPT_PATHS`：**只放行"方法"这一关，凭据一关一点没松**——login 仍必须带
//      有效口令（无凭据 401 NO_TOKEN、错口令 401 BAD_TOKEN），且两条路径都不碰任何项目数据。
//   ⑦ 登录页本体免凭据：手机连上先得有地方输口令，故 `GET /` 与 `GET /remote` 进 `PUBLIC_PATHS`
//      （只有页面 HTML，零数据；非 GET 与其余路径一律照旧要 token）。**远程未开启时连它一起 403**
//      （REMOTE_DISABLED 判定在前），所以默认关闭时的外部暴露面仍是零。
//   ⑧ 聊天闸门：`TATAI_REMOTE_CHAT=1` 之外，非回环来源读 `.../chat/sessions*` 一律 403
//      REMOTE_CHAT_HIDDEN（S2 DoD④：聊天全文默认不外泄）。
//   ⑨ 口令错误计数与退避：同一来源地址在窗口内错 N 次即 429 LOGIN_THROTTLED（防爆破，轻量内存计数）。
//      只数"给了凭据但不对"的情形——没带头的请求不算猜口令，不该把忘记加头的设备锁在门外。
//
// ── 三期 S3：写模式的运行期状态 + 终端闸门（PLAN.md S3 卡）在本文件追加的两件事 ──
//   ⑩ 终端读路径默认不外泄：`GET .../terminal/history`（命令原文）、`GET /api/terminal/:sid/out`
//      （终端输出流）、`GET /api/terminal/sessions`（活跃会话）一律 403 `REMOTE_TERMINAL_HIDDEN`，
//      除非主机上显式置位 `TATAI_REMOTE_TERMINAL=1`。这是本卡对"终端历史远程可读性"的明确表态：
//      **默认不可读**（红线⑧在 `remote-config.ts`，判定函数 `isTerminalReadPath` 只此一份）。
//      写面（建 PTY / 写 stdin / resize / 关会话 / 清历史）走同一道闸（`isTerminalWritePath`，
//      2026-09-18 审计 Q15 补：原先只吃只读红线，写模式一开等于把 shell 递给远程）。
//   ⑪ 写模式的生效值来自**运行期状态**（`GuardInput.writeEnabled`，由 `remote-write.ts` 提供）：
//      关掉写模式后下一个写请求即 403，不需要重启（DoD③）。缺省仍回落 `cfg.writeEnabled`（启动期口径）。
//   ⑫ 记忆检索默认不外泄：`GET /api/projects/:id/memory` 403 `REMOTE_MEMORY_HIDDEN`——
//      S3 的敏感面扫描在真实记忆原文上扫出过本机绝对路径（用户私人文字，§10.2），就地收口。
// ═══════════════════════════════════════════════════════════════════════════════════
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  READ_ONLY_METHODS,
  REMOTE_CHAT_ENV,
  REMOTE_MEMORY_ENV,
  REMOTE_REQUIRES_TOKEN,
  REMOTE_TERMINAL_ENV,
  REMOTE_DATA_SUBDIR,
  TOKEN_FILE_NAME,
  isIpLiteral,
  isLoopbackAddress,
  type RemoteConfig,
} from "./remote-config";
import { nowIso, toIso, compareIsoTime } from "./time";

/** ① 口令随机源与长度（改这两个数就是改安全强度，别在别处另写一份）。 */
export const TOKEN_BYTES = 32;
export const TOKEN_ENCODING = "base64url" as const;
/** base64url(32 字节) = 43 字符；校验时先卡长度再比内容。 */
export const TOKEN_LENGTH = 43;
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** ④ 会话 id 前缀（一眼区分"口令"与"会话"，同一个 Authorization 头两种都认）。 */
export const SESSION_ID_PREFIX = "s_";
export const SESSION_BYTES = 16;
/**
 * 会话 id 的**形态**（`s_` + base64url(16 字节) = 22 字符）。
 *
 * Q137（2026-09-19 审计）：口令与会话共用**一个** `Authorization` 头，分流只靠 `startsWith("s_")`——
 * 而 `TOKEN_PATTERN` 允许 `_`，`generateToken` 每 4096 枚就有约一枚以 `s_` 开头：那种口令
 * `verifyToken` 通过、`authorize` 却按会话查（恒 `SESSION_NOT_FOUND`），远程客户端拿到
 * "会话不存在"而永远连不上，直到人工轮换。修法两条腿：
 *   ① `generateToken` 不再签发 `s_` 开头的口令（源头杜绝）；
 *   ② 分流改按**形态**判（口令恒 43 字符、会话恒 24 字符，长度不可能撞）——**已经签发到手里的**
 *      那种口令因此也立刻可用，不必等轮换。
 */
export const SESSION_ID_PATTERN = /^s_[A-Za-z0-9_-]{22}$/;

export type TokenRejectReason = "NO_TOKEN" | "BAD_TOKEN" | "EXPIRED_TOKEN";
export type SessionRejectReason = "SESSION_NOT_FOUND" | "SESSION_EXPIRED";
export type AuthReason = TokenRejectReason | SessionRejectReason;

/** 落盘结构（明文口令 + 到期时间；文件本身就是给用户复制的口令载体，0600）。 */
export interface TokenRecord {
  kind: "tatai-remote-token";
  version: 1;
  token: string;
  created_at: string;
  expires_at: string;
  rotated_at: string | null;
}

export interface Session {
  session_id: string;
  /** 口令指纹（sha256 前 12 位十六进制）——审计用，恢复不出原文（S3 审计日志复用） */
  token_fingerprint: string;
  created_at: string;
  expires_at: string;
  last_seen_at: string;
  /** 来源地址（远程设备排查用；不落盘、只在本进程内存里） */
  remote_address: string | null;
}

export type TokenVerdict =
  | { ok: true; record: TokenRecord }
  | { ok: false; reason: TokenRejectReason };

export type SessionVerdict =
  | { ok: true; session: Session }
  | { ok: false; reason: SessionRejectReason };

export type AuthVerdict =
  | { ok: true; via: "token" | "session"; session: Session | null; fingerprint: string }
  | { ok: false; reason: AuthReason };

export class AuthError extends Error {
  readonly code: AuthReason;
  constructor(code: AuthReason, message: string) {
    super(message);
    this.name = "AuthError";
    this.code = code;
  }
}

/** 生成一个口令（32 字节 CSPRNG → base64url 43 字符）。
 *  Q137（2026-09-19 审计）：**不许以 `s_` 开头**——那是会话 id 的前缀，撞上就会被 `authorize` 当会话
 *  查（口令本身有效却恒 `SESSION_NOT_FOUND`）。重抽的期望次数 ≈1.0002（概率 1/4096），代价可忽略。 */
export function generateToken(): string {
  for (;;) {
    const token = crypto.randomBytes(TOKEN_BYTES).toString(TOKEN_ENCODING);
    if (!token.startsWith(SESSION_ID_PREFIX)) return token;
  }
}

/** 生成一个会话 id（`s_` + 16 字节 CSPRNG） */
export function generateSessionId(): string {
  return SESSION_ID_PREFIX + crypto.randomBytes(SESSION_BYTES).toString(TOKEN_ENCODING);
}

/** 口令指纹：sha256 前 12 位十六进制（单向，审计日志只记它，不记原文） */
export function tokenFingerprint(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex").slice(0, 12);
}

/** 定时比较（先 sha256 定长，再 timingSafeEqual；长度不同不早退，避免时序侧信道） */
function sameSecret(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a, "utf8").digest();
  const hb = crypto.createHash("sha256").update(b, "utf8").digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** 造一条口令记录（CLI / 启动期 / 验证脚本共用，避免三处各写一份 expires_at 算法） */
export function newTokenRecord(opts: { ttlMs: number; now?: Date; token?: string }): TokenRecord {
  const now = opts.now ?? new Date();
  return {
    kind: "tatai-remote-token",
    version: 1,
    token: opts.token ?? generateToken(),
    created_at: nowIso(),
    expires_at: toIso(new Date(now.getTime() + opts.ttlMs)),
    rotated_at: null,
  };
}

/** 口令文件路径（= remote-config.tokenFilePath，这里重新导出方便调用方只 import auth） */
export function tokenPathIn(dataDir: string): string {
  return path.join(dataDir, REMOTE_DATA_SUBDIR, TOKEN_FILE_NAME);
}

/** 是否落在 repo 内（红线自查：口令文件不许进仓库） */
export function isInsideRepo(target: string, repoRoot: string): boolean {
  const rel = path.relative(path.resolve(repoRoot), path.resolve(target));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** 写口令文件（原子写 + 0600 + 目录 0700） */
export function writeTokenRecord(dataDir: string, record: TokenRecord): string {
  const file = tokenPathIn(dataDir);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // Windows 上 chmod 能力有限，不因此阻断（权限提示见 permissionHint）
  }
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // 同上
  }
  return file;
}

/**
 * 读口令文件。
 * Q62（2026-09-18 审计）：**文件不存在、读不出、不是合法 JSON 一律返回 null**——原实现是裸
 * `JSON.parse`，语法坏（或 EACCES 之类读失败）抛出的 `SyntaxError` 会一路逃到启动期
 * `uncaughtException`（进程 exit 1）与运行期每个非回环接口 500，与这里注释承诺的"坏文件返回 null"
 * 不符。现在坏文件按"没有可用口令"处理：鉴权侧 fail-closed 回 `BAD_TOKEN`（不猜、不让路），
 * 启动期由 `ensureToken()` 重发一枚新口令覆盖它（取不出可用口令的坏文件没有保留价值）。
 * 能解析但结构不符（kind/token 不对）仍抛 `AuthError`：那是"文件在，但不是塔台的口令文件"，
 * 要如实报错（登录口的 catch 已按 F5 脱敏回显）。
 */
export function readTokenRecord(dataDir: string): TokenRecord | null {
  const file = tokenPathIn(dataDir);
  if (!fs.existsSync(file)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Partial<TokenRecord>;
  if (record.kind !== "tatai-remote-token" || typeof record.token !== "string") {
    throw new AuthError("BAD_TOKEN", `口令文件结构不对: ${file}`);
  }
  return record as TokenRecord;
}

/** 权限提示文案（DoD④「权限提示」；Windows 与 POSIX 分开说，不假装 chmod 在 Windows 上等于 ACL） */
export function permissionHint(dataDir: string): string {
  const file = tokenPathIn(dataDir);
  if (process.platform === "win32") {
    return (
      `${file} 按 0600 写；Windows 上 chmod 只动只读位，真实保护取决于用户 profile 目录 ACL` +
      "（逐用户隔离；共享/多用户机器请自行收紧该目录权限）"
    );
  }
  return `${file} 按 0600（目录 0700）落盘：仅本用户可读`;
}

export interface AuthServiceOptions {
  dataDir: string;
  tokenTtlMs: number;
  sessionTtlMs: number;
  /** 注入时钟（验证脚本用它确定性地造"已过期"，不用真等） */
  now?: () => Date;
  /** ⑨ 口令错误计数：窗口内允许的失败次数（默认 `LOGIN_MAX_FAILURES`） */
  maxFailures?: number;
  /** ⑨ 计数窗口（默认 `LOGIN_FAILURE_WINDOW_MS`）：窗口滑过即清零 */
  failureWindowMs?: number;
  /** ⑨ 超限后的退避时长（默认 `LOGIN_LOCKOUT_MS`） */
  lockoutMs?: number;
  /** ⑬ 请求级限流：窗口内允许的请求数（默认 `REMOTE_RATE_MAX_REQUESTS`） */
  rateMaxRequests?: number;
  /** ⑬ 请求级限流窗口（默认 `REMOTE_RATE_WINDOW_MS`） */
  rateWindowMs?: number;
}

interface FailureRecord {
  count: number;
  windowStart: number;
  lockedUntil: number;
}

/** ⑬ 某来源在窗口内的请求计数 */
interface RequestWindow {
  count: number;
  windowStart: number;
}

/**
 * 按来源地址记的两张表（⑨ 口令失败、⑬ 请求计数）都要有容量上限：键是**完成 TCP 握手的真实来源**
 * （伪造源 IP 不可行），但"很多不同来源各来一次"仍能把表撑大——上限之外的先清窗口已滑过的陈旧条目，
 * 再丢最早建档的（表只影响"计数准不准"，绝不能变成内存增长点）。Q78/Q73（2026-09-18 审计）。
 */
const ADDRESS_TABLE_MAX_ENTRIES = 1024;

/**
 * 鉴权服务：口令（落盘、带 TTL）+ 会话（内存、带 TTL、可登出）+ 口令错误计数（内存，⑨ 防爆破）
 * + 请求级限流计数（内存，⑬ Q73 补）。口令每次校验都重读文件——CLI 轮换后运行中的服务立刻生效。
 */
export class AuthService {
  readonly dataDir: string;
  readonly tokenTtlMs: number;
  readonly sessionTtlMs: number;
  readonly maxFailures: number;
  readonly failureWindowMs: number;
  readonly lockoutMs: number;
  readonly rateMaxRequests: number;
  readonly rateWindowMs: number;
  private readonly clock: () => Date;
  private readonly sessions = new Map<string, Session>();
  /** ⑨ 按来源地址记失败次数（只在本进程内存里，不落盘：重启即清，够挡脚本猜口令） */
  private readonly failures = new Map<string, FailureRecord>();
  /** ⑬ 按来源地址记窗口内请求数（同上：内存、重启即清；Q73 请求级限流） */
  private readonly requests = new Map<string, RequestWindow>();

  constructor(opts: AuthServiceOptions) {
    this.dataDir = opts.dataDir;
    this.tokenTtlMs = opts.tokenTtlMs;
    this.sessionTtlMs = opts.sessionTtlMs;
    this.maxFailures = opts.maxFailures ?? LOGIN_MAX_FAILURES;
    this.failureWindowMs = opts.failureWindowMs ?? LOGIN_FAILURE_WINDOW_MS;
    this.lockoutMs = opts.lockoutMs ?? LOGIN_LOCKOUT_MS;
    this.rateMaxRequests = opts.rateMaxRequests ?? REMOTE_RATE_MAX_REQUESTS;
    this.rateWindowMs = opts.rateWindowMs ?? REMOTE_RATE_WINDOW_MS;
    this.clock = opts.now ?? (() => new Date());
  }

  tokenPath(): string {
    return tokenPathIn(this.dataDir);
  }

  /** 读当前口令记录（不创建）；已过期也如实返回，由调用方判断 */
  load(): TokenRecord | null {
    return readTokenRecord(this.dataDir);
  }

  /**
   * 保证有一枚可用口令：缺失则生成落盘；**已过期则重新生成**（过期口令留着只会让远程静默连不上，
   * 启动期换新并在日志里说明）。返回口令记录与是否新生成。
   */
  ensureToken(): { record: TokenRecord; created: boolean } {
    const existing = this.load();
    if (existing && Date.parse(existing.expires_at) > this.clock().getTime()) {
      return { record: existing, created: false };
    }
    const record = newTokenRecord({ ttlMs: this.tokenTtlMs, now: this.clock() });
    writeTokenRecord(this.dataDir, record);
    return { record, created: true };
  }

  /** 轮换：换一枚新口令（旧口令立刻失效），同时踢掉所有会话 */
  rotateToken(): TokenRecord {
    const record: TokenRecord = {
      ...newTokenRecord({ ttlMs: this.tokenTtlMs, now: this.clock() }),
      rotated_at: toIso(this.clock()),
    };
    writeTokenRecord(this.dataDir, record);
    this.revokeAllSessions();
    return record;
  }

  /** 口令校验：三条拒绝路径（无 token / 错误 token / 过期 token）在此各走一条 */
  verifyToken(token: string | null | undefined): TokenVerdict {
    if (typeof token !== "string" || token.trim() === "") return { ok: false, reason: "NO_TOKEN" };
    const record = this.load();
    if (record === null) return { ok: false, reason: "BAD_TOKEN" };
    if (!sameSecret(record.token, token)) return { ok: false, reason: "BAD_TOKEN" };
    if (Date.parse(record.expires_at) <= this.clock().getTime()) return { ok: false, reason: "EXPIRED_TOKEN" };
    return { ok: true, record };
  }

  /** 口令 → 会话（S2 的登录口用；本卡已有单测覆盖） */
  createSession(token: string | null | undefined, remoteAddress?: string | null): Session {
    const verdict = this.verifyToken(token);
    if (!verdict.ok) throw new AuthError(verdict.reason, `签发会话失败: ${verdict.reason}`);
    const now = this.clock();
    const session: Session = {
      session_id: generateSessionId(),
      token_fingerprint: tokenFingerprint(verdict.record.token),
      created_at: nowIso(),
      expires_at: toIso(new Date(now.getTime() + this.sessionTtlMs)),
      last_seen_at: nowIso(),
      remote_address: remoteAddress ?? null,
    };
    this.purgeExpiredSessions();
    this.sessions.set(session.session_id, session);
    return session;
  }

  verifySession(sessionId: string | null | undefined): SessionVerdict {
    if (typeof sessionId !== "string" || sessionId === "") {
      return { ok: false, reason: "SESSION_NOT_FOUND" };
    }
    const session = this.sessions.get(sessionId);
    if (!session) return { ok: false, reason: "SESSION_NOT_FOUND" };
    if (Date.parse(session.expires_at) <= this.clock().getTime()) {
      this.sessions.delete(sessionId);
      return { ok: false, reason: "SESSION_EXPIRED" };
    }
    session.last_seen_at = nowIso();
    return { ok: true, session };
  }

  /** 登出（幂等：不存在返回 false） */
  logout(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  revokeAllSessions(): number {
    const n = this.sessions.size;
    this.sessions.clear();
    return n;
  }

  listSessions(): Session[] {
    this.purgeExpiredSessions();
    // 倒序（新会话在前）按**真实时刻**比：原来的 `a < b ? 1 : -1` 既比字面钟点、又不是合法比较器
    // （相等时也返回 -1）。
    return [...this.sessions.values()].sort((a, b) => compareIsoTime(b.created_at, a.created_at));
  }

  purgeExpiredSessions(): number {
    const now = this.clock().getTime();
    let n = 0;
    for (const [id, s] of this.sessions) {
      if (Date.parse(s.expires_at) <= now) {
        this.sessions.delete(id);
        n++;
      }
    }
    return n;
  }

  // ── ⑨ 口令错误计数与退避（同一来源地址；只数"给了凭据但不对"，缺头不算猜口令）──

  /** 记一次失败；达到阈值即锁门。返回记录后的状态（失败次数与退避剩余） */
  noteFailure(address: string): ThrottleState {
    const now = this.clock().getTime();
    this.pruneFailures(now);
    const prev = this.failures.get(address);
    const rec: FailureRecord =
      prev && now - prev.windowStart < this.failureWindowMs
        ? prev
        : { count: 0, windowStart: now, lockedUntil: 0 };
    rec.count += 1;
    if (rec.count >= this.maxFailures) {
      rec.lockedUntil = now + this.lockoutMs;
      rec.count = 0;
      rec.windowStart = now;
      this.failures.set(address, rec);
      return { failures: this.maxFailures, locked: true, retryAfterMs: this.lockoutMs, remaining: 0 };
    }
    this.failures.set(address, rec);
    return { failures: rec.count, locked: false, retryAfterMs: 0, remaining: this.maxFailures - rec.count };
  }

  /** 当前退避状态（顺带清掉窗口已滑过的陈旧记录；锁门中报满次数） */
  throttleState(address: string): ThrottleState {
    const now = this.clock().getTime();
    const rec = this.failures.get(address);
    if (!rec) return { failures: 0, locked: false, retryAfterMs: 0, remaining: this.maxFailures };
    if (now - rec.windowStart >= this.failureWindowMs && rec.lockedUntil <= now) {
      this.failures.delete(address);
      return { failures: 0, locked: false, retryAfterMs: 0, remaining: this.maxFailures };
    }
    const locked = rec.lockedUntil > now;
    const failures = locked ? this.maxFailures : rec.count;
    return {
      failures,
      locked,
      retryAfterMs: locked ? rec.lockedUntil - now : 0,
      remaining: Math.max(0, this.maxFailures - failures),
    };
  }

  /** 校验通过即清零（好口令不该被此前的错口令连坐） */
  clearFailures(address: string): void {
    this.failures.delete(address);
  }

  /**
   * 失败计数表封顶（Q78，2026-09-18 审计）：此前的清理是**定向**的——只在"同址再次访问"
   * （`throttleState` 窗口滑过）或"同址成功登录"（`clearFailures`）时删该地址，全表无遍历/定时清理，
   * 于是"大量不同来源地址各来一次"会让它单调增长（每条记录 3 个数值，机制确凿、危害低）。
   * 与⑬请求计数表同一手法、同一个上限（`ADDRESS_TABLE_MAX_ENTRIES`）：先清窗口已滑过且没在锁门的，
   * 仍超上限就丢最早建档的——表只影响"计数准不准"，绝不能变成内存增长点。
   */
  private pruneFailures(now: number): void {
    if (this.failures.size <= ADDRESS_TABLE_MAX_ENTRIES) return;
    for (const [addr, rec] of this.failures) {
      if (now - rec.windowStart >= this.failureWindowMs && rec.lockedUntil <= now) this.failures.delete(addr);
    }
    while (this.failures.size > ADDRESS_TABLE_MAX_ENTRIES) {
      const first = this.failures.keys().next();
      if (first.done) break;
      this.failures.delete(first.value);
    }
  }

  /**
   * ⑬ 记一次请求并判是否超限（放行口对每个**非回环**请求调一次；回环来源不过这道闸，见 Q73 常量注释）。
   * 与⑨同族：窗口内计数，超限即拒并回还要等多久，窗口滑过自动重开。
   */
  noteRequest(address: string): RateState {
    const now = this.clock().getTime();
    this.pruneRequestWindows(now);
    const prev = this.requests.get(address);
    const rec: RequestWindow =
      prev && now - prev.windowStart < this.rateWindowMs ? prev : { count: 0, windowStart: now };
    rec.count += 1;
    this.requests.set(address, rec);
    if (rec.count > this.rateMaxRequests) {
      return { allowed: false, retryAfterMs: rec.windowStart + this.rateWindowMs - now };
    }
    return { allowed: true, retryAfterMs: 0 };
  }

  /** 请求计数表封顶（见 `ADDRESS_TABLE_MAX_ENTRIES`）：先清窗口已滑过的，再丢最早建档的 */
  private pruneRequestWindows(now: number): void {
    if (this.requests.size <= ADDRESS_TABLE_MAX_ENTRIES) return;
    for (const [addr, rec] of this.requests) {
      if (now - rec.windowStart >= this.rateWindowMs) this.requests.delete(addr);
    }
    while (this.requests.size > ADDRESS_TABLE_MAX_ENTRIES) {
      const first = this.requests.keys().next();
      if (first.done) break;
      this.requests.delete(first.value);
    }
  }

  /**
   * 凭据二选一：会话态（`s_` + 22 字符，见 `SESSION_ID_PATTERN`）走会话，其余按口令；两条路都过 TTL。
   * 口令路径**不签发会话**（会话由 `createSession` 显式签发，S2 的登录口调它）——
   * 否则每个远程请求都存一条会话，内存随请求数长。
   */
  authorize(credential: string | null | undefined): AuthVerdict {
    if (typeof credential !== "string" || credential.trim() === "") {
      return { ok: false, reason: "NO_TOKEN" };
    }
    // Q137（2026-09-19 审计）：按**形态**分流，不按前缀——`s_` 开头的 43 字符口令（旧版
    // `generateToken` 约 1/4096 会签发出来，可能已经在用户手里）必须走口令路径，否则
    // `verifyToken` 通过而这里按会话查，恒 SESSION_NOT_FOUND。
    if (SESSION_ID_PATTERN.test(credential)) {
      const verdict = this.verifySession(credential);
      if (!verdict.ok) return { ok: false, reason: verdict.reason };
      return {
        ok: true,
        via: "session",
        session: verdict.session,
        fingerprint: verdict.session.token_fingerprint,
      };
    }
    const verdict = this.verifyToken(credential);
    if (!verdict.ok) return { ok: false, reason: verdict.reason };
    this.purgeExpiredSessions();
    return { ok: true, via: "token", session: null, fingerprint: tokenFingerprint(verdict.record.token) };
  }
}

// ── HTTP 放行口（唯一的门；index.ts 每个请求进路由前调它）────────────────────────────

export type RemoteRejectionCode =
  | "REMOTE_DISABLED"
  | "NO_TOKEN"
  | "BAD_TOKEN"
  | "EXPIRED_TOKEN"
  | "SESSION_INVALID"
  | "SESSION_EXPIRED"
  | "REMOTE_READ_ONLY"
  | "REMOTE_CHAT_HIDDEN"
  | "REMOTE_TERMINAL_HIDDEN"
  | "REMOTE_MEMORY_HIDDEN"
  | "LOGIN_THROTTLED"
  | "RATE_LIMITED"
  | "ORIGIN_FORBIDDEN"
  | "HOST_FORBIDDEN";

/**
 * ⑥ 只读模式下仍放行的写方法路径（**唯一口子**，S2 换会话/登出用）。
 * 放行范围只有"方法"这一关：凭据关一点没松（仍要有效口令或有效会话），且这两条路径只动内存里的会话表、
 * 不碰任何项目数据与文件——所以它们不属于 DoD② 要逐个拒的"写接口"（那张表在 `remote-routes.ts`）。
 */
export const READ_ONLY_EXEMPT_PATHS = ["/api/remote/login", "/api/remote/logout"] as const;

/** ⑦ 免凭据的静态入口（只有登录页 HTML 本体，零数据）：手机连上得先有地方输口令。 */
export const PUBLIC_PATHS = ["/", "/remote"] as const;

/** ⑧ 聊天读路径（会话列表与全文；列表带首条消息摘要，同样算聊天内容）。
 * 末段 `(?:/messages)?` 覆盖 `POST …/sessions/:sid/messages`：发消息会把整段会话历史喂给模型再经
 * SSE 流回，等于读聊天——写模式下没开 TATAI_REMOTE_CHAT 时这里也要拦（fail-closed，2026-09-18 审计补）。 */
const CHAT_READ_PATH_RE = /^\/api\/projects\/[^/]+\/chat\/sessions(?:\/[^/]+(?:\/messages)?)?$/;

/**
 * S3 ⑩ 终端读路径（**命令历史与终端输出**；S2 的写清单一度只挡了写，读侧留着口子）：
 *   · `GET /api/projects/:id/terminal/history` —— E3 落盘的用户命令原文（最敏感的一条）
 *   · `GET /api/terminal/:sid/out`            —— 终端输出流（= 外壳日志本身）
 *   · `GET /api/terminal/sessions`            —— 活跃会话清单（带项目绝对路径 cwd 与 pid）
 * 默认一律 403 `REMOTE_TERMINAL_HIDDEN`（redline ⑧，见 remote-config.ts）；主机上显式置位
 * `TATAI_REMOTE_TERMINAL=1` 才放开。**明确表态**：终端历史远程可读性 = 默认不可读（PLAN S3）。
 */
const TERMINAL_READ_PATHS: readonly RegExp[] = [
  /^\/api\/projects\/[^/]+\/terminal\/history$/,
  /^\/api\/terminal\/[^/]+\/out$/,
  /^\/api\/terminal\/sessions$/,
];

/**
 * ⑩-b 终端**写**路径（2026-09-18 审计 Q15 补，与⑩同一条红线的写面）：
 *   · `POST /api/projects/:id/terminal`      —— 建 PTY 会话（cwd 锁项目根）
 *   · `POST /api/terminal/:sid/in`           —— 往 PTY 写 stdin（远程执行命令的主入口）
 *   · `POST /api/terminal/:sid/resize`       —— 尺寸变更
 *   · `DELETE /api/terminal/:sid`            —— 关会话
 *   · `DELETE /api/projects/:id/terminal/history` —— 清空命令历史
 * 原先这五条只吃"只读红线"（`REMOTE_READ_ONLY`）：写模式一开（双开关 + 逐字确认语）就能远程开一个
 * PTY 盲打任意 shell 命令，而 `/out` 那边被 403 只挡住了**回读**——等于闸门只关了读的那扇门。
 * 口径与读侧完全一致（fail-closed）：默认 403 `REMOTE_TERMINAL_HIDDEN`，主机置
 * `TATAI_REMOTE_TERMINAL=1` 才连写一起放开。只读模式下的拒绝顺序不变（仍先吃 `REMOTE_READ_ONLY`）。
 */
const TERMINAL_WRITE_PATHS: readonly RegExp[] = [
  /^\/api\/projects\/[^/]+\/terminal$/,
  /^\/api\/projects\/[^/]+\/terminal\/history$/,
  /^\/api\/terminal\/[^/]+\/(?:in|resize)$/,
  /^\/api\/terminal\/[^/]+$/,
];

/**
 * S3 ⑪ 记忆检索路径（`GET /api/projects/:id/memory`）：S3 的敏感面扫描在**真实记忆**上扫出过
 * "本机绝对路径"命中（记忆原文里带用户自己的目录），与聊天原文同类（用户私人文字，§10.2），
 * 所以同样默认 403 `REMOTE_MEMORY_HIDDEN`，主机上显式置位 `TATAI_REMOTE_MEMORY=1` 才放开。
 */
const MEMORY_READ_PATH_RE = /^\/api\/projects\/[^/]+\/memory$/;

/** ⑨ 口令错误计数窗口 / 阈值 / 退避时长（轻量：内存计数 + 固定退避，够挡住脚本猜口令） */
export const LOGIN_FAILURE_WINDOW_MS = 5 * 60_000;
export const LOGIN_MAX_FAILURES = 5;
export const LOGIN_LOCKOUT_MS = 60_000;

/**
 * ⑬ 请求级限流窗口与每来源上限（2026-09-18 审计 Q73 补）。
 * 审计发现：全仓**除⑨登录退避外零限流**——持有效凭据的只读远程客户端可以无限打
 * `GET /api/projects/:id/scan`（自述"结果不缓存不落盘"，每请求现扫全树）把后端 CPU 吃满，
 * 而 `remote-config.ts` 的口径里还写着"无频率限制"。这里给非回环来源补一道**按来源地址**的
 * 请求计数闸（与⑨同一手法：内存计数、不落盘、重启即清），超限回 429 `RATE_LIMITED` + retry-after。
 * 档位：10 秒 300 次（= 30 次/秒）。这个数是**量出来的**——`pnpm verify:s3` 的读路由巡检
 * 是"脚本猛敲"的天然样本，实测峰值为 107 次/10 秒（临时插桩量得），故取 3 倍余量：
 * 人手/验收脚本都不会被误伤，而"无限打"变成有界（超出的请求吃 429，且每一次拒绝都进审计）。
 * 这不是精确配额系统，只拦"脚本猛敲"这一类；回环来源（本机桌面 UI）不过这道闸，行为一字不变。
 */
export const REMOTE_RATE_WINDOW_MS = 10_000;
export const REMOTE_RATE_MAX_REQUESTS = 300;

// ── F1（2026-09-18 审计）：回环信任域加固——Origin / Host 两道闸的常量与判定 ──────────────
// 审计发现：回环来源在放行口最前面直接 return，浏览器可以用 text/plain 正文对写接口做 CSRF
// （curl 同源策略管不着浏览器），DNS rebinding 还能把响应变成"同源可读"。两道闸补在放行口：
//   · Origin 闸（非 GET/HEAD/OPTIONS 且带 Origin 时）：只认壳/开发/回环/同源——浏览器对非读方法必带
//     Origin 且伪造不了白名单值；无 Origin 的非浏览器客户端（curl / MCP stdio 转发 / 健康探测 /
//     node fetch）一律不受影响。
//   · Host 闸（带 Host 头时）：只认回环名或显式配置的绑定地址——DNS rebinding 靠"恶意域名解析到
//     127.0.0.1 + Host 是该域名"，域名进不了清单，rebinding 的读响应路径被掐断。

/**
 * 桌面壳 origin 白名单（**与 index.ts 的 applyShellCors 同一份**，单一出处在此）：
 * Tauri v2 在 Windows 上是 http(s)://tauri.localhost，其余平台 tauri://localhost。
 */
export const SHELL_ORIGINS: readonly string[] = [
  "http://tauri.localhost",
  "https://tauri.localhost",
  "tauri://localhost",
];

/** dev 前端 origin（vite 缺省 5173；dev 下 /api 经代理转发，Origin 原样到达后端）。 */
export const DEV_ORIGIN = "http://localhost:5173";

/** Origin 闸的静态白名单：壳三件套 + dev 前端（同源与"回环主机任意口"另行判定，不进这张清单）。 */
export const TRUSTED_BROWSER_ORIGINS: readonly string[] = [...SHELL_ORIGINS, DEV_ORIGIN];

/**
 * 回环浏览器 origin 判定：`http(s)://<回环主机或 localhost>[:任意端口]`。
 * 端口不限的依据（2026-09-18 与并行修复批次对齐）：本仓端口卫生规则要求开发/验证一律动态口
 * （vite 不固定 5173，E 系验证即如此），静态 5173 清单会误杀自家开发链路。安全性不靠端口：
 * Origin 是浏览器伪造不了的发起来源——回环 origin 意味着页面来自**本机上**某个服务
 * （壳 / 开发代理 / 验证脚本），跨站攻击者的页面 origin 是他自己的域，进不了这条判定；
 * 「恶意域名解析到回环」的 rebinding 变体由 Host 闸另拦（域名进不了 Host 清单）。
 * 精确匹配主机名：`localhost.evil.example`、`evil.localhost`、`null`（沙箱 iframe 可造）都不认。
 */
function isLoopbackBrowserOrigin(origin: string): boolean {
  const m = origin.toLowerCase().match(/^https?:\/\/(\[[^\]]+\]|[^/:]+?)(?::\d+)?$/);
  if (!m) return false;
  const host = m[1].startsWith("[") ? m[1].slice(1, -1) : m[1];
  return host === "localhost" || isLoopbackAddress(host);
}

/** Host 头取主机名：去端口、去 IPv6 方括号（`[::1]:8787` → `::1`；`mypc:8787` → `mypc`）。 */
function hostNameOfHostHeader(host: string): string {
  let h = host.trim().toLowerCase();
  if (h.startsWith("[")) {
    const close = h.indexOf("]");
    return close > 0 ? h.slice(1, close) : h.slice(1);
  }
  const cut = h.lastIndexOf(":");
  // 只剥"唯一一个冒号"（那是端口）；裸 IPv6（多个冒号）不是 Host 头合法形态，原样交回环判定
  if (cut > 0 && h.indexOf(":") === cut) h = h.slice(0, cut);
  return h;
}

/**
 * Host 头合法性判定（防 DNS rebinding 的关键闸，回环与远程来源都过）：
 * 合法 = 回环名（127.0.0.1 / localhost / ::1）或**显式配置的绑定地址**；
 * 通配模式（显式危险开关，绑定所有网卡）额外放行"IP 字面量 / localhost 形态的 Host"——
 * 来客可能经任意一个本机 IP 访问，但 DNS rebinding 恰恰靠**域名**当 Host，IP 字面量造不成 rebinding。
 */
function isAllowedHostHeader(host: string | undefined | null, cfg: RemoteConfig): boolean {
  if (typeof host !== "string" || host.trim() === "") return false;
  const name = hostNameOfHostHeader(host);
  if (name === "localhost" || isLoopbackAddress(name)) return true;
  if (cfg.hostKind === "wildcard") return isIpLiteral(name);
  return name === hostNameOfHostHeader(cfg.bindHost);
}

/** 请求路径归一：去掉 query（判定只看路径） */
export function requestPathOf(url: string | undefined | null): string {
  if (typeof url !== "string") return "";
  const cut = url.indexOf("?");
  const p = cut < 0 ? url : url.slice(0, cut);
  return p === "" ? "" : p;
}

export function isPublicPath(pathName: string | undefined | null): boolean {
  return typeof pathName === "string" && (PUBLIC_PATHS as readonly string[]).includes(pathName);
}

export function isReadOnlyExemptPath(pathName: string | undefined | null): boolean {
  return typeof pathName === "string" && (READ_ONLY_EXEMPT_PATHS as readonly string[]).includes(pathName);
}

/** 是否聊天读路径（⑧ 闸门用；判定唯一出处） */
export function isChatReadPath(pathName: string | undefined | null): boolean {
  return typeof pathName === "string" && CHAT_READ_PATH_RE.test(pathName);
}

/** 是否终端读路径（S3 ⑩ 闸门用；判定唯一出处） */
export function isTerminalReadPath(pathName: string | undefined | null): boolean {
  return typeof pathName === "string" && TERMINAL_READ_PATHS.some((re) => re.test(pathName));
}

/** 是否终端写路径（⑩-b 闸门用；与 isTerminalReadPath 同一道闸，只多管写面） */
export function isTerminalWritePath(pathName: string | undefined | null): boolean {
  return typeof pathName === "string" && TERMINAL_WRITE_PATHS.some((re) => re.test(pathName));
}

/** ⑪ 记忆检索默认不外泄（S3 扫描扫出来的口子）：记忆原文是用户私人文字，默认不给远程；
 *  路径形态的常量在下面（`MEMORY_READ_PATH_RE`）。 */

/** ⑪-b 记忆**派生产物**的读路径（Q138，2026-09-19 审计；闸门用，判定唯一出处）。
 *  逆向草稿（`GET /api/projects/:id/design/draft` 读的 `.工作台/design.draft.md`）派生自记忆检索：
 *  `reverseDraft.ts` 把 `memory.results` 摘要塞进提示词，落盘件里还带「- 历史记忆：…」一段。
 *  Q16 当时只给 POST（生成草稿）补了闸，GET（读草稿）漏在闸门外——远程一枚默认只读 token
 *  就能读到记忆派生物。这里与记忆读接口并成同一道闸（见 ⑪ 的拒绝分支）。 */
const MEMORY_DERIVED_READ_PATH_RE = /^\/api\/projects\/[^/]+\/design\/draft$/;

export function isMemoryDerivedReadPath(pathName: string | undefined | null): boolean {
  return typeof pathName === "string" && MEMORY_DERIVED_READ_PATH_RE.test(pathName);
}

/** 是否记忆读路径（S3 ⑪ 闸门用；判定唯一出处） */
export function isMemoryReadPath(pathName: string | undefined | null): boolean {
  return typeof pathName === "string" && MEMORY_READ_PATH_RE.test(pathName);
}

export interface GuardInput {
  remoteAddress: string | undefined | null;
  method: string;
  authorization: string | undefined | null;
  /** 请求路径（不含 query，用 `requestPathOf` 归一）；缺省 = 不做路径类判定（S1 的调用点无需改） */
  path?: string | undefined;
  /**
   * S3：**运行期**写模式生效值（`remote-write.ts#WriteModeController.enabled()`；每请求现取，
   * 所以"关掉写模式立刻失效"不需重启）。缺省 = 用 `cfg.writeEnabled`（启动期口径）——
   * S1/S2 的单元级调用点因此一行都不用改，红线④的下限仍由 `cfg.writeEnabled` 保证。
   */
  writeEnabled?: boolean | undefined;
  /**
   * F1：`Origin` 请求头（浏览器对非 GET/HEAD 必带；缺省 = 非浏览器客户端，Origin 闸直接跳过，
   * S1/S2 既有单元级调用点不用改）。HTTP 层由 index.ts 每请求喂 `req.headers.origin`。
   */
  origin?: string | undefined;
  /**
   * F1：`Host` 请求头（DNS rebinding 防线）。缺省 = 不做 Host 判定（HTTP/1.0 无 Host 的
   * 极旧客户端；浏览器必带 Host，这道闸防的就是浏览器侧攻击，缺席即无攻击面可谈）。
   */
  host?: string | undefined;
}

/** ⑨ 退避状态（同一来源地址） */
export interface ThrottleState {
  failures: number;
  locked: boolean;
  retryAfterMs: number;
  /** 距离锁门还剩几次（未锁时给出，用于 401 消息里的计数提示） */
  remaining: number;
}

/** ⑬ 请求级限流的判定结果（同一来源地址，Q73） */
export interface RateState {
  allowed: boolean;
  /** 被拒时还要等多少毫秒（放行口写进 `retry-after`） */
  retryAfterMs: number;
}

export type GuardResult =
  | { ok: true; remote: boolean; session: Session | null; fingerprint: string | null }
  | {
      ok: false;
      status: 401 | 403 | 429;
      code: RemoteRejectionCode;
      message: string;
      retryAfterMs?: number;
    };

const REJECT_STATUS: Record<AuthReason, { status: 401 | 403; code: RemoteRejectionCode }> = {
  NO_TOKEN: { status: 401, code: "NO_TOKEN" },
  BAD_TOKEN: { status: 401, code: "BAD_TOKEN" },
  EXPIRED_TOKEN: { status: 401, code: "EXPIRED_TOKEN" },
  SESSION_NOT_FOUND: { status: 401, code: "SESSION_INVALID" },
  SESSION_EXPIRED: { status: 401, code: "SESSION_EXPIRED" },
};

/** 口令校验失败原因 → HTTP 状态码与对外错误码（会话自述口复用放行口的同一份口径） */
export function authRejectStatus(reason: AuthReason): { status: 401 | 403; code: RemoteRejectionCode } {
  return REJECT_STATUS[reason];
}

/** 从 Authorization 头取凭据：认 `Bearer <x>`，也认直接填 `<x>`（命令行手填少一层坑） */
export function credentialFromHeader(authorization: string | undefined | null): string | null {
  if (typeof authorization !== "string") return null;
  const raw = authorization.trim();
  if (raw === "") return null;
  const m = raw.match(/^Bearer\s+(.+)$/i);
  return (m ? m[1] : raw).trim();
}

/** 是否读方法（③ 只读模式放行的集合，口径在 remote-config.ts） */
export function isReadMethod(method: string): boolean {
  return (READ_ONLY_METHODS as readonly string[]).includes(method.toUpperCase());
}

/**
 * 远程请求放行判定（除 auth 读口令文件与内存态计数外无 I/O）：
 *   · F1 Host 闸（带 Host 头时，回环与远程都过）：Host 不在清单 → 403 HOST_FORBIDDEN
 *     （DNS rebinding 防线；合法 = 回环名 / 显式绑定地址，通配模式只额外认 IP 字面量形态）
 *   · F1 Origin 闸（非读方法且带 Origin 时，回环与远程都过）：不在壳/开发/回环/同源清单
 *     → 403 ORIGIN_FORBIDDEN（浏览器 CSRF 防线；远程登录页是同源 fetch，同源放行不修死登录页）
 *   · 回环来源 → 放行（本机 = 桌面 UI 的信任域；上面两道 F1 闸已经先过完）
 *   · 非回环 + 远程没开 → 403 REMOTE_DISABLED（本卡之前"缺 host 参数实绑 0.0.0.0"那类事故的兜底）
 *   · 非回环 + GET 静态入口（`/`、`/remote`）→ 放行（⑦ 只有登录页 HTML，零数据）
 *   · 非回环 + 该地址正在退避 → 429 LOGIN_THROTTLED（⑨ 防爆破；带 retry-after）
 *   · 非回环 + 无凭据 → 401 NO_TOKEN（**先鉴权**：写请求没 token 也是 401，不是 403）
 *   · 非回环 + 凭据不对/过期 → 401 BAD_TOKEN / EXPIRED_TOKEN / SESSION_*（并记一次失败）
 *   · 非回环 + 凭据对 + 写方法 + 只读模式 → 403 REMOTE_READ_ONLY（会话生命周期两条路径除外，⑥；
 *     ③ 的"只读"看 `input.writeEnabled`——运行期状态，关掉写模式下一个请求即失效）
 *   · 非回环 + 凭据对 + 聊天读路径 + 未开聊天 → 403 REMOTE_CHAT_HIDDEN（⑧）
 *   · 非回环 + 凭据对 + 终端读路径 + 未开终端 → 403 REMOTE_TERMINAL_HIDDEN（⑩，S3）
 */
export function guardRemoteRequest(
  cfg: RemoteConfig,
  auth: AuthService | null,
  input: GuardInput,
): GuardResult {
  // ── F1（2026-09-18 审计）Host 闸：在回环放行之前——DNS rebinding 的请求恰恰"来自回环"。
  // 只拦"带不合法 Host"这一种：无 Origin 的非浏览器客户端不受影响，Host 缺席（HTTP/1.0）也跳过。
  if (typeof input.host === "string" && input.host.trim() !== "" && !isAllowedHostHeader(input.host, cfg)) {
    return {
      ok: false,
      status: 403,
      code: "HOST_FORBIDDEN",
      message:
        `Host 头不在允许清单（收到 ${JSON.stringify(input.host)}）：本服务只应经 127.0.0.1/localhost/[::1] ` +
        "或显式配置的绑定地址访问——这是 DNS rebinding 防线（DESIGN.md §10.2）",
    };
  }
  // ── F1（2026-09-18 审计）Origin 闸：只管"非读方法且带 Origin"的浏览器请求。
  // 白名单 = 壳 origin（applyShellCors 同一份常量）+ dev 前端 + **回环主机任意口**
  // （isLoopbackBrowserOrigin：端口卫生规则下开发/验证用动态口，见其注释）+ **同源**
  // （`http(s)://<Host>`，覆盖：远程登录页的同源 fetch、本机浏览器直接开 http://localhost:<port>/ 登录）。
  // 远程模式凭据走 Authorization 头（跨站表单带不上自定义头），同源放行即够登录页语义；
  // 套反代 + TLS 的场景请在反代层清空/改写 Origin（如 nginx `proxy_set_header Origin "";`）。
  const originRaw = typeof input.origin === "string" ? input.origin.trim() : "";
  if (originRaw !== "" && !isReadMethod(input.method)) {
    const hostRaw = typeof input.host === "string" ? input.host.trim() : "";
    const sameOrigin =
      hostRaw !== "" && (originRaw === `http://${hostRaw}` || originRaw === `https://${hostRaw}`);
    if (!TRUSTED_BROWSER_ORIGINS.includes(originRaw) && !sameOrigin && !isLoopbackBrowserOrigin(originRaw)) {
      return {
        ok: false,
        status: 403,
        code: "ORIGIN_FORBIDDEN",
        message:
          `Origin 不在浏览器白名单（收到 ${JSON.stringify(originRaw)}）：非 GET/HEAD/OPTIONS 请求只接受 ` +
          "壳/开发/回环/同源 origin（跨站写防线，DESIGN.md §10.2）",
      };
    }
  }
  if (isLoopbackAddress(input.remoteAddress)) {
    return { ok: true, remote: false, session: null, fingerprint: null };
  }
  if (!REMOTE_REQUIRES_TOKEN) {
    // 自我断言：红线⑤只能更严不能更松（常量被改成 false 时在这里炸，而不是悄悄放行）
    throw new Error("鉴权红线被削弱：REMOTE_REQUIRES_TOKEN 必须为 true（DESIGN.md §10.2）");
  }
  if (!cfg.enabled || auth === null) {
    return {
      ok: false,
      status: 403,
      code: "REMOTE_DISABLED",
      message:
        "远程访问未开启（默认关闭：TATAI_REMOTE=1 才对外监听，见 DESIGN.md §1.4 / §10.2）——" +
        `来源 ${input.remoteAddress ?? "?"} 不放行`,
    };
  }
  const path = input.path ?? "";
  // ⑦ 登录页本体：唯一免凭据的路径，且只认 GET（页面里没有一字节的项目数据）
  if (isPublicPath(path) && input.method.toUpperCase() === "GET") {
    return { ok: true, remote: true, session: null, fingerprint: null };
  }
  const address = input.remoteAddress ?? "unknown";
  // ⑬ 请求级限流（Q73，2026-09-18 审计）：除⑨登录退避外全仓原先零限流——一个持有效凭据的
  // 只读远程客户端就能无限打 `GET /api/projects/:id/scan`（不缓存、每请求全树遍历）把 CPU 吃满。
  // 这里按来源地址计数（**只数非回环**：上面的回环分支已 return），超限回 429 RATE_LIMITED。
  const rate = auth.noteRequest(address);
  if (!rate.allowed) {
    return {
      ok: false,
      status: 429,
      code: "RATE_LIMITED",
      message:
        `请求过于频繁：来源 ${address} 在 ${Math.ceil(auth.rateWindowMs / 1000)} 秒内超过 ` +
        `${auth.rateMaxRequests} 次（远程按来源限流，防止无限打扫描这类重接口）`,
      retryAfterMs: rate.retryAfterMs,
    };
  }
  // ⑨ 退避中：连正确凭据也先拒（否则退避拦不住仍在猜的脚本）——只告诉还要等多久
  const throttled = auth.throttleState(address);
  if (throttled.locked) {
    return {
      ok: false,
      status: 429,
      code: "LOGIN_THROTTLED",
      message:
        `口令错误次数过多（${throttled.failures}/${auth.maxFailures}），已退避 ${Math.ceil(
          throttled.retryAfterMs / 1000,
        )} 秒——来源 ${address} 暂时不放行`,
      retryAfterMs: throttled.retryAfterMs,
    };
  }
  const credential = credentialFromHeader(input.authorization);
  const verdict = auth.authorize(credential);
  if (!verdict.ok) {
    const { status, code } = REJECT_STATUS[verdict.reason];
    const base = rejectionMessage(code);
    // ⑨ 只数"给了凭据但不对"的情形（缺头不算猜口令）：计数到阈值的那一次直接 429
    if (REJECT_STATUS_COUNTED.includes(verdict.reason)) {
      const state = auth.noteFailure(address);
      if (state.locked) {
        return {
          ok: false,
          status: 429,
          code: "LOGIN_THROTTLED",
          message: `${base}；且口令错误次数已达 ${state.failures}/${auth.maxFailures}，退避 ${Math.ceil(
            state.retryAfterMs / 1000,
          )} 秒`,
          retryAfterMs: state.retryAfterMs,
        };
      }
      return {
        ok: false,
        status,
        code,
        message: `${base}（计数提示：本地址已错 ${state.failures}/${auth.maxFailures} 次）`,
      };
    }
    return { ok: false, status, code, message: base };
  }
  auth.clearFailures(address);
  const writeEnabled = input.writeEnabled ?? cfg.writeEnabled;
  if (!writeEnabled && !isReadMethod(input.method) && !isReadOnlyExemptPath(path)) {
    return {
      ok: false,
      status: 403,
      code: "REMOTE_READ_ONLY",
      message:
        `远程只读模式：${input.method} 属于写方法，被只读红线拦下（默认只读为核心模式；` +
        "写模式要在启动时显式给两道开关，且运行期关闭后立即失效，见 remote-config.ts 的 WRITE_MODE_SWITCHES）",
    };
  }
  // ⑧ 聊天全文默认不外泄（S2 DoD④）：写方法已在上一关拦下，这里只管读聊天
  // 注：`chat/sessions` 这条路径 GET（读列表）与 POST（建会话）**共用**，闸门只看路径、不分方法——
  // 于是写模式下 POST 建会话也会被这里拦下。这是**有意的 fail-closed**：远程既然读不到聊天，
  // 建一个读不到的会话只会留一份空文件；要连写一起放开就同时给 `TATAI_REMOTE_CHAT=1`（消息里写明）。
  if (!cfg.chatExposed && isChatReadPath(path)) {
    return {
      ok: false,
      status: 403,
      code: "REMOTE_CHAT_HIDDEN",
      message:
        "聊天记录不对远程下发（默认关闭，见 DESIGN.md §10.2）——要在主机上显式置位 " +
        `${REMOTE_CHAT_ENV}=1 重启后才允许远程读；只读远程模式不提供聊天全文` +
        (isReadMethod(input.method) ? "" : "（这条路径的写方法也一并拦下：读不到就不该建）"),
    };
  }
  // ⑩ 终端历史/终端输出默认不外泄（S3 表态）：命令原文与外壳日志与聊天同级，默认不给远程。
  // Q15（2026-09-18 审计）：写面（建 PTY / 写 stdin / resize / 关会话 / 清历史）与读面同一道闸——
  // 读都读不到，更不该让远程往里写（写模式一开就能盲打 shell，见 TERMINAL_WRITE_PATHS 注释）。
  if (!cfg.terminalExposed && (isTerminalReadPath(path) || isTerminalWritePath(path))) {
    return {
      ok: false,
      status: 403,
      code: "REMOTE_TERMINAL_HIDDEN",
      message:
        "终端历史与终端输出不对远程下发（默认关闭：那是这台机器上执行过的命令与外壳日志，见 DESIGN.md §10.2）" +
        `——要在主机上显式置位 ${REMOTE_TERMINAL_ENV}=1 重启后才允许远程读` +
        (isReadMethod(input.method) ? "" : "（终端的写方法同样一并拦下：读不到就不该让远程往里写）"),
    };
  }
  // ⑪ 记忆检索默认不外泄（S3 扫描扫出来的口子）：记忆原文是用户私人文字，默认不给远程。
  // Q138（2026-09-19 审计）：记忆的**派生产物**（逆向草稿）同一道闸——它由记忆检索起草，内容里带
  // 项目文件清单与「历史记忆」段，泄露面与记忆原文同级；Q16 只给 POST 补了闸，GET 读草稿这条漏了。
  if (!cfg.memoryExposed && (isMemoryReadPath(path) || isMemoryDerivedReadPath(path))) {
    return {
      ok: false,
      status: 403,
      code: "REMOTE_MEMORY_HIDDEN",
      message:
        "记忆检索结果不对远程下发（默认关闭：记忆原文里可能有用户自己的路径与私人笔记，见 DESIGN.md §10.2）" +
        "，由记忆起草的逆向草稿同一道闸" +
        `——要在主机上显式置位 ${REMOTE_MEMORY_ENV}=1 重启后才允许远程读`,
    };
  }
  return { ok: true, remote: true, session: verdict.session, fingerprint: verdict.fingerprint };
}

/** 计入退避的失败原因（"给了凭据但不对"四种；NO_TOKEN 不算猜口令） */
const REJECT_STATUS_COUNTED: readonly AuthReason[] = [
  "BAD_TOKEN",
  "EXPIRED_TOKEN",
  "SESSION_NOT_FOUND",
  "SESSION_EXPIRED",
];

function rejectionMessage(code: RemoteRejectionCode): string {
  switch (code) {
    case "NO_TOKEN":
      return "缺少抬头：Authorization: Bearer <token>（远程请求一律要 token，无 token 不放行）";
    case "BAD_TOKEN":
      return "token 无效（不存在或已被轮换）——口令在全局数据目录 <dataDir>/remote/auth.json，别外传";
    case "EXPIRED_TOKEN":
      return "token 已过期（TTL 到期）——在主机上重新签发/轮换后再试";
    case "SESSION_INVALID":
      return "会话不存在或已登出";
    case "SESSION_EXPIRED":
      return "会话已过期（会话有效期到期）——用 token 重新换一个会话";
    default:
      return "拒绝访问";
  }
}
