// ═══════════════════════════════════════════════════════════════════════════════════
// 三期 S1：远程访问安全红线定版（PLAN.md S1 卡；DESIGN.md §1.4「本期不做远程/手机端」= 解锁前的
// 非目标、§10.2「私人数据隔离」= 红线依据、§8.1 三层数据 = 数据落点）。
//
// 本文件是红线的**唯一事实源**：九条红线各落成下面一个常量（不是只写在文档里），
// 启动时由 `resolveRemoteConfig()` 逐条执行——违反即拒绝启动，不给"先连上再说"的余地。
// （①②③④⑤⑥ 是 S1 定版的六条；⑦「聊天全文默认不外泄」是 S2 DoD④ 追加的；⑧「终端历史/终端输出」
// 与 ⑨「记忆检索」是 S3 追加的两条。后三条同文件同口径，都属"私人数据默认不出本机"，
// 见 DESIGN.md §10.2。）
// 写法依据 PLAN S1「跑偏点」：本卡先证伪（默认关闭 + 拒绝路径）再谈放开。
//
//   ① 默认关闭     REMOTE_DEFAULT_ENABLED = false        —— 未显式开启时零监听外部接口
//   ② 只绑局域网   BIND_HOST_POLICY / isLoopback / isPrivateAddress —— 0.0.0.0 默认硬拒
//   ③ 只读为核心   REMOTE_DEFAULT_READ_ONLY = true       —— 远程默认只放行 GET/HEAD/OPTIONS
//   ④ 写要显式开   WRITE_MODE_SWITCHES / WRITE_CONFIRM_PHRASE —— 开关 + 二次确认口令，两者缺一即拒
//   ⑤ 必须 token   REMOTE_REQUIRES_TOKEN = true          —— 无 token 不放行任何远程请求（见 auth.ts）
//   ⑥ 不面向公网   PUBLIC_INTERNET_SUPPORTED = false     —— 公网 IP 一律拒绑，附理由常量
//   ⑦ 聊天不外泄   REMOTE_DEFAULT_CHAT_EXPOSED = false   —— S2 DoD④：聊天全文默认不下发（`TATAI_REMOTE_CHAT=1` 才开）
//   ⑧ 终端不外泄   REMOTE_DEFAULT_TERMINAL_EXPOSED = false —— S3：终端历史/终端输出默认不下发（`TATAI_REMOTE_TERMINAL=1` 才开）
//   ⑨ 记忆不外泄   REMOTE_DEFAULT_MEMORY_EXPOSED = false —— S3：记忆检索默认不下发（`TATAI_REMOTE_MEMORY=1` 才开）
//
// 口径变更（解锁 §1.4 的"本期不做远程"）已按 AGENTS.md §4 登记 DESIGN.md 附录 B，正文一字未动。
// ═══════════════════════════════════════════════════════════════════════════════════
import { promises as dnsPromises } from "node:dns";
import os from "node:os";
import path from "node:path";

/** ① 默认关闭远程：未显式置位时零外部监听（本机回环不算"外部"，见 `isLoopbackAddress`）。 */
export const REMOTE_DEFAULT_ENABLED = false as const;

/** ③ 只读为核心模式：远程开启后默认只放行读方法，写方法要 ④ 双开关才过。 */
export const REMOTE_DEFAULT_READ_ONLY = true as const;

/** ⑤ 必须 token 鉴权：任何非回环来源的请求都要过 auth.ts；无 token 一律不放行。 */
export const REMOTE_REQUIRES_TOKEN = true as const;

/** ⑥ 不面向公网（DESIGN.md §10.2）：公网 IP 字面量一律拒绑，也不提供"允许公网"的开关。 */
export const PUBLIC_INTERNET_SUPPORTED = false as const;

/**
 * ⑥ 附带的理由常量（DoD④「文档写明不推荐公网直连及理由」）。
 * 公网直连的问题：塔台服务是明文 HTTP（无 TLS）、单 token 静态口令（无二因子，只有按来源的粗粒度
 * 请求限流）、且接口集合里有终端 PTY 与文件写入——一旦端口被扫到，等于把本机 shell 挂在公网上。
 * 要走外网请自己套一层（VPN / Tailscale / 反代 + TLS + 额外认证），塔台不替用户兜底。
 * （2026-09-18 审计 Q73：措辞里的"无频率限制"已过期——只读远程现按来源限流，见 auth.ts ⑬。）
 */
export const PUBLIC_INTERNET_REASON =
  "塔台不面向公网直连：无 TLS（明文 HTTP）、单静态 token（无二因子，仅按来源的粗粒度请求限流）、" +
  "接口含终端 PTY 与文件写入——公网暴露等于把本机 shell 挂在网上。要外网访问请自行套 VPN/反代+TLS。";

/** ② 默认绑回环：不设 TATAI_HOST 时就是它（绝不默认 0.0.0.0）。 */
export const REMOTE_DEFAULT_HOST = "127.0.0.1";

/** 绑定地址环境变量（沿用 R1 起的名字，含义在本卡收紧）。 */
export const REMOTE_HOST_ENV = "TATAI_HOST";
/** ① 总开关：仅接受 1/true（"yes" 之类不认，避免"以为开了其实没开"）。 */
export const REMOTE_ENABLE_ENV = "TATAI_REMOTE";
/** ② 危险开关：显式允许绑通配地址（默认拒；开了会有醒目警告，且仍然只该在受控网络里用）。 */
export const REMOTE_WILDCARD_ENV = "TATAI_REMOTE_ALLOW_WILDCARD";
/** ④ 写模式两道开关之二：写开关本身。 */
export const REMOTE_WRITE_ENV = "TATAI_REMOTE_WRITE";
/** ④ 写模式两道开关之一：二次确认口令（语义 = 用户在命令行里亲手敲了一遍确认语）。 */
export const REMOTE_WRITE_CONFIRM_ENV = "TATAI_REMOTE_WRITE_CONFIRM";
/** ④ 确认语原文（写模式必须逐字给出，走"人显式确认"而不是一个容易被脚本顺手置位的布尔）。 */
export const WRITE_CONFIRM_PHRASE = "我确认开启远程写模式";
/** token 有效期（分钟，可小数）与远程会话有效期（分钟，可小数）。 */
export const REMOTE_TOKEN_TTL_ENV = "TATAI_REMOTE_TOKEN_TTL_MINUTES";
export const REMOTE_SESSION_TTL_ENV = "TATAI_REMOTE_SESSION_TTL_MINUTES";
/** S2 ⑦ 聊天全文开关：默认关（不外泄），只有显式置位才允许远程读聊天。 */
export const REMOTE_CHAT_ENV = "TATAI_REMOTE_CHAT";
export const REMOTE_DEFAULT_CHAT_EXPOSED = false as const;
/**
 * S3 ⑧ 终端开关：默认关（不外泄）。终端历史（E3 的 `terminal-history.jsonl`）里是用户敲过的**命令原文**
 * （E3 已过滤口令类形态，但仍是"这台机器上执行过什么"），终端输出流更是外壳日志本身——二者与聊天同级，
 * 属私人数据（DESIGN.md §10.2），所以默认不下发，只有主机上显式置位才放开。
 * 本卡把这件"终端历史远程可读性"明确表态：**默认不可读**，写进红线常量并由 `pnpm verify:s3` 验证。
 */
export const REMOTE_TERMINAL_ENV = "TATAI_REMOTE_TERMINAL";
export const REMOTE_DEFAULT_TERMINAL_EXPOSED = false as const;
/**
 * S3 ⑨ 记忆检索开关：默认关（不外泄）。`GET /api/projects/:id/memory` 的返回是**用户记忆库里的原文**
 * （用户自己的记忆条目），S3 的敏感面扫描在真实记忆上扫出过"本机绝对路径"命中——它与聊天原文同类
 * （都是用户私人文字，见 DESIGN.md §10.2），所以同样默认不下发，主机上显式置位才放开。
 * 本卡登记：这是 S3 扫描**扫出来的**口子（S2 遗留同类面），按"私人数据默认不出本机"的口径就地收口。
 */
export const REMOTE_MEMORY_ENV = "TATAI_REMOTE_MEMORY";
export const REMOTE_DEFAULT_MEMORY_EXPOSED = false as const;

/** ④ 两道开关（代码里的显式清单，验证脚本按它逐条对照）。 */
export const WRITE_MODE_SWITCHES = [REMOTE_WRITE_ENV, REMOTE_WRITE_CONFIRM_ENV] as const;

/** 未配置时的有效期：token 24 小时、会话 30 分钟（会话短、口令长——日常设备记住口令，会话按需续）。 */
export const DEFAULT_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000;
/** 有效期上限（离谱的 TTL 等于没 TTL）。 */
export const MAX_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/** 远程数据落点：全局数据目录下的子目录（DESIGN.md §8.1 全局层，绝不落在 repo 或项目里）。 */
export const REMOTE_DATA_SUBDIR = "remote";
export const TOKEN_FILE_NAME = "auth.json";

/** 通配地址字面量（② 默认硬拒的那一类）。 */
export const WILDCARD_HOSTS = ["0.0.0.0", "::", "*"] as const;

/** 读方法（③ 只读模式放行的集合）；其余方法一律按"写"处理。 */
export const READ_ONLY_METHODS = ["GET", "HEAD", "OPTIONS"] as const;

export type RemoteErrorCode =
  | "REMOTE_FLAG_INVALID"
  | "HOST_REQUIRES_REMOTE"
  | "WILDCARD_FORBIDDEN"
  | "PUBLIC_HOST_FORBIDDEN"
  | "WRITE_WITHOUT_REMOTE"
  | "WRITE_CONFIRM_REQUIRED"
  | "TTL_INVALID";

/** 配置违规：启动期抛出 → main 打印并 exit(1)（不静默降级、不"先起来再说"）。 */
export class RemoteConfigError extends Error {
  readonly code: RemoteErrorCode;
  readonly hint: string;
  constructor(code: RemoteErrorCode, message: string, hint: string) {
    super(message);
    this.name = "RemoteConfigError";
    this.code = code;
    this.hint = hint;
  }
}

export type HostKind = "loopback" | "lan" | "wildcard" | "public" | "hostname";

export interface RemoteConfig {
  enabled: boolean;
  writeEnabled: boolean;
  /** ⑦ 聊天全文是否对远程下发（默认 false；DoD④）*/
  chatExposed: boolean;
  /** ⑧ 终端历史/输出是否对远程下发（默认 false；S3 表态）*/
  terminalExposed: boolean;
  /** ⑨ 记忆检索是否对远程下发（默认 false；S3 扫描发现的口子，就地收口）*/
  memoryExposed: boolean;
  /** 用户给的原始 host 字面量（已 trim） */
  host: string;
  /** 实际 bind 的地址（本卡里与 host 相同；单列避免将来改口径时调用方跟着改） */
  bindHost: string;
  hostKind: HostKind;
  tokenTtlMs: number;
  sessionTtlMs: number;
  /** 生效口径说明（启动日志逐条打出来，作为"红线怎么落的"证据） */
  reasons: string[];
  /** 危险开关的显式警告（空 = 没开任何危险开关） */
  warnings: string[];
}

function stripMapped(addr: string): string {
  const lower = addr.trim().toLowerCase();
  return lower.startsWith("::ffff:") ? lower.slice("::ffff:".length) : lower;
}

/**
 * 回环判定：127.0.0.0/8、::1、IPv4-mapped 形式。
 * **本函数不认 `localhost`**（Q14，2026-09-18 审计）：那是主机名不是地址字面量，本函数只看 IP 形态；
 * 于是 `TATAI_HOST=localhost` 归 `hostname`、未开远程即 `HOST_REQUIRES_REMOTE` 拒启动——方向是更严
 * （fail-closed），不是漏判。需要连主机名一起认的地方自行补判（`auth.ts` 的 Host/Origin 两道闸就是
 * `name === "localhost" || isLoopbackAddress(name)`）；本注释此前误把 localhost 写进判定范围，已订正。
 */
export function isLoopbackAddress(addr: string | undefined | null): boolean {
  if (typeof addr !== "string") return false;
  const a = stripMapped(addr);
  if (a === "" || a === "localhost") return false;
  if (a === "::1" || a === "0:0:0:0:0:0:0:1") return true;
  const v4 = a.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  return v4 !== null && v4[1] === "127";
}

/** 局域网/链路本地判定：10/8、172.16/12、192.168/16、169.254/16、fc00::/7、fe80::/10。 */
export function isPrivateAddress(addr: string): boolean {
  const a = stripMapped(addr);
  const v4 = a.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [o1, o2] = [Number(v4[1]), Number(v4[2])];
    if (o1 === 10) return true;
    if (o1 === 172 && o2 >= 16 && o2 <= 31) return true;
    if (o1 === 192 && o2 === 168) return true;
    if (o1 === 169 && o2 === 254) return true;
    return false;
  }
  return a.startsWith("fc") || a.startsWith("fd") || a.startsWith("fe8") || a.startsWith("fe9") ||
    a.startsWith("fea") || a.startsWith("feb");
}

/**
 * F2（2026-09-18 审计）：数字形式 IPv4 归一——`3232235521` 这种纯十进制 32 位写法
 * （ inet_aton 历史语法，Windows 的 URL/参数解析认它）不是点分四段，此前会被
 * `classifyBindHost` 当成"主机名"只给一条警告。这里归一成点分四段再判定：
 * 数字形式公网地址（如 `134744072` = 8.8.8.8）从此与 IP 字面量**同路径同错误码**拒启动。
 * 也让 `server.listen` 拿到它能直接 bind 的形式（listen 不认纯数字串，会当主机名走 DNS）。
 */
export function normalizeIpLiteral(host: string): string {
  const h = host.trim();
  if (/^\d{1,10}$/.test(h)) {
    const n = Number(h);
    if (n > 0 && n <= 0xffffffff) {
      return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
    }
  }
  return h;
}

/** ② 绑定地址分类（本文件里所有 host 判断都走它，口径只此一份；入口先做数字形式归一）。 */
export function classifyBindHost(host: string): HostKind {
  const h = normalizeIpLiteral(host).toLowerCase();
  if ((WILDCARD_HOSTS as readonly string[]).includes(h)) return "wildcard";
  if (isLoopbackAddress(h)) return "loopback";
  if (isPrivateAddress(h)) return "lan";
  if (isIpLiteral(h)) return "public";
  return "hostname";
}

/** IP 字面量判定（auth.ts 的 Host 头闸也用它：通配模式下"只认 IP 字面量形态的 Host"）。 */
export function isIpLiteral(host: string): boolean {
  if (/^(\d{1,3})(\.\d{1,3}){3}$/.test(host)) return true;
  return host.includes(":") && /^[0-9a-f:]+$/.test(host);
}

/**
 * 该地址字面量是不是"公网可达"（Q20，2026-09-18 审计）。
 * 用于 **listen 之后** 的绑后复检：`server.address()` 给的可能是 IPv4-mapped 形态
 * （`::ffff:203.0.113.10`），先按既有口径剥前缀再与 `classifyBindHost` 同一条 public 判定——
 * 口径只此一份，不在调用方另写一遍。
 */
export function isPublicBindAddress(addr: string | undefined | null): boolean {
  if (typeof addr !== "string" || addr.trim() === "") return false;
  return classifyBindHost(stripMapped(addr)) === "public";
}

function parseFlag(name: string, raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  const v = raw.trim().toLowerCase();
  if (v === "" || v === "0" || v === "false") return false;
  if (v === "1" || v === "true") return true;
  throw new RemoteConfigError(
    "REMOTE_FLAG_INVALID",
    `${name} 只接受 1/true（开）或 0/false（关），收到: ${JSON.stringify(raw)}`,
    `${name} 写法不明确时一律拒绝启动——不猜用户想开还是想关`,
  );
}

function parseTtlMs(name: string, raw: string | undefined, fallbackMs: number, maxMs: number): number {
  if (raw === undefined || raw.trim() === "") return fallbackMs;
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new RemoteConfigError(
      "TTL_INVALID",
      `${name} 必须是正数（分钟，可小数），收到: ${JSON.stringify(raw)}`,
      "有效期必须有限且为正——不提供「永不过期」的取值",
    );
  }
  const ms = minutes * 60_000;
  if (ms > maxMs) {
    throw new RemoteConfigError(
      "TTL_INVALID",
      `${name} 超过上限 ${maxMs / 60_000} 分钟（收到 ${minutes} 分钟）`,
      "过长的有效期等于没有有效期，按上限截住",
    );
  }
  return ms;
}

/**
 * 解析并校验远程配置：违反红线直接 throw（启动期 fail-fast）。
 * 默认参数（无任何环境变量）= ③ 默认关闭 + 默认回环 —— 与"未开启远程"逐字等价的零暴露态。
 */
export function resolveRemoteConfig(env: NodeJS.ProcessEnv = process.env): RemoteConfig {
  const reasons: string[] = [];
  const warnings: string[] = [];

  const enabled = parseFlag(REMOTE_ENABLE_ENV, env[REMOTE_ENABLE_ENV], REMOTE_DEFAULT_ENABLED);
  const hostRaw = (env[REMOTE_HOST_ENV] ?? "").trim();
  // F2：数字形式 IPv4 先归一（3232235521 → 192.168.1.1），后续判定与 listen 拿到的都是点分四段
  const rawHost = normalizeIpLiteral(hostRaw) || REMOTE_DEFAULT_HOST;
  if (rawHost !== hostRaw && hostRaw !== "") {
    warnings.push(
      `⚠ ${REMOTE_HOST_ENV}=${hostRaw} 是数字形式 IPv4，已归一为 ${rawHost} 再做红线判定（公网 → 同码拒启动）`,
    );
  }
  const hostKind = classifyBindHost(rawHost);

  // ── ② 绑定地址红线：回环永远允许；其余一律要求"先显式开启远程" ──
  if (hostKind === "wildcard") {
    const allowed = parseFlag(REMOTE_WILDCARD_ENV, env[REMOTE_WILDCARD_ENV], false);
    if (!allowed) {
      throw new RemoteConfigError(
        "WILDCARD_FORBIDDEN",
        `${REMOTE_HOST_ENV}=${rawHost} 被拒绝：塔台绝不绑通配地址（0.0.0.0/:: 在所有网卡上暴露，` +
          "等于公网裸奔）。要挂局域网请填具体局域网 IP。",
        `确认要绑通配地址再加危险开关 ${REMOTE_WILDCARD_ENV}=1，并自担暴露风险（见 ${PUBLIC_INTERNET_REASON}）`,
      );
    }
    if (!enabled) {
      throw new RemoteConfigError(
        "HOST_REQUIRES_REMOTE",
        `${REMOTE_HOST_ENV}=${rawHost} 需要先显式开启远程（${REMOTE_ENABLE_ENV}=1）`,
        "默认关闭是红线①：没开远程时只允许回环地址",
      );
    }
    warnings.push(
      `⚠ 已启用危险开关 ${REMOTE_WILDCARD_ENV}=1，正在监听通配地址 ${rawHost}（所有网卡可达）`,
    );
  } else if (hostKind !== "loopback") {
    if (!enabled) {
      throw new RemoteConfigError(
        "HOST_REQUIRES_REMOTE",
        `${REMOTE_HOST_ENV}=${rawHost}（非回环）需要先显式开启远程（${REMOTE_ENABLE_ENV}=1）——` +
          "默认关闭时只允许绑 127.0.0.1。",
        `要局域网访问：${REMOTE_ENABLE_ENV}=1 ${REMOTE_HOST_ENV}=<本机局域网 IP>，并配好 token`,
      );
    }
    if (hostKind === "public") {
      throw new RemoteConfigError(
        "PUBLIC_HOST_FORBIDDEN",
        `${REMOTE_HOST_ENV}=${rawHost} 是公网地址，塔台不面向公网（PUBLIC_INTERNET_SUPPORTED=false）。` +
          PUBLIC_INTERNET_REASON,
        "请填本机局域网 IP（192.168.x.x / 10.x.x.x / 172.16-31.x.x）；要外网访问自行套 VPN 或反代+TLS",
      );
    }
    if (hostKind === "hostname") {
      warnings.push(
        `⚠ ${REMOTE_HOST_ENV}=${rawHost} 是主机名：启动链路会做一次 DNS 解析（解析出公网地址即拒启动，` +
          "见 assertBindHostnameSafe）；解析失败则按既有口径放行——显式 host 的可达范围仍由用户负责",
      );
    }
  }

  // ── ③ 只读为核心 + ④ 写模式双开关 ──
  const writeFlag = parseFlag(REMOTE_WRITE_ENV, env[REMOTE_WRITE_ENV], false);
  const confirmRaw = (env[REMOTE_WRITE_CONFIRM_ENV] ?? "").trim();
  let writeEnabled = false;
  if (writeFlag) {
    if (!enabled) {
      throw new RemoteConfigError(
        "WRITE_WITHOUT_REMOTE",
        `${REMOTE_WRITE_ENV}=1 但远程没开（${REMOTE_ENABLE_ENV} 未置位）`,
        "写模式是远程的附加开关；先把远程开起来再谈写",
      );
    }
    if (confirmRaw !== WRITE_CONFIRM_PHRASE) {
      throw new RemoteConfigError(
        "WRITE_CONFIRM_REQUIRED",
        `${REMOTE_WRITE_ENV}=1 还缺二次确认：${REMOTE_WRITE_CONFIRM_ENV} 必须逐字等于 ${JSON.stringify(WRITE_CONFIRM_PHRASE)}`,
        `写模式两道开关（${WRITE_MODE_SWITCHES.join(" + ")}）缺一即拒——确认语要人亲手敲，避免脚本顺手置位`,
      );
    }
    writeEnabled = true;
    warnings.push(
      `⚠ 远程写模式已开启（${WRITE_MODE_SWITCHES.join(" + ")} 都给了）：非回环来源可发起写请求，请自行控制网络范围`,
    );
  }
  if (!writeEnabled) {
    reasons.push("只读为核心模式：远程来源只放行 " + READ_ONLY_METHODS.join("/"));
  }

  // ── ⑦ 聊天全文默认不外泄（S2 DoD④）──
  const chatExposed = parseFlag(REMOTE_CHAT_ENV, env[REMOTE_CHAT_ENV], REMOTE_DEFAULT_CHAT_EXPOSED);
  if (chatExposed) {
    warnings.push(
      `⚠ 远程聊天读取已开启（${REMOTE_CHAT_ENV}=1）：非回环来源可读聊天会话列表与全文，请自行确认网络范围与口令不外传`,
    );
  } else {
    reasons.push(`聊天全文不下发远程（默认；要开须显式置位 ${REMOTE_CHAT_ENV}=1）`);
  }

  // ── ⑧ 终端历史/输出默认不外泄（S3：终端历史远程可读性的明确表态）──
  const terminalExposed = parseFlag(REMOTE_TERMINAL_ENV, env[REMOTE_TERMINAL_ENV], REMOTE_DEFAULT_TERMINAL_EXPOSED);
  if (terminalExposed) {
    warnings.push(
      `⚠ 远程终端读取已开启（${REMOTE_TERMINAL_ENV}=1）：非回环来源可读命令历史与终端输出流，` +
        "等于把这台机器的外壳日志发到局域网上，请自行确认网络范围与口令不外传",
    );
  } else {
    reasons.push(`终端历史与终端输出不下发远程（默认；要开须显式置位 ${REMOTE_TERMINAL_ENV}=1）`);
  }

  // ── ⑨ 记忆检索默认不外泄（S3 敏感面扫描扫出来的口子）──
  const memoryExposed = parseFlag(REMOTE_MEMORY_ENV, env[REMOTE_MEMORY_ENV], REMOTE_DEFAULT_MEMORY_EXPOSED);
  if (memoryExposed) {
    warnings.push(
      `⚠ 远程记忆检索已开启（${REMOTE_MEMORY_ENV}=1）：非回环来源可读记忆原文（可能含本机路径与私人笔记），` +
        "请自行确认网络范围与口令不外传",
    );
  } else {
    reasons.push(`记忆检索不下发远程（默认；要开须显式置位 ${REMOTE_MEMORY_ENV}=1）`);
  }

  const tokenTtlMs = parseTtlMs(REMOTE_TOKEN_TTL_ENV, env[REMOTE_TOKEN_TTL_ENV], DEFAULT_TOKEN_TTL_MS, MAX_TOKEN_TTL_MS);
  const sessionTtlMs = parseTtlMs(
    REMOTE_SESSION_TTL_ENV,
    env[REMOTE_SESSION_TTL_ENV],
    DEFAULT_SESSION_TTL_MS,
    MAX_SESSION_TTL_MS,
  );

  if (!enabled) {
    reasons.push(
      `远程默认关闭（${REMOTE_ENABLE_ENV} 未置位）：只绑 ${rawHost}，不监听任何外部接口、不生成 token 文件`,
    );
  } else if (hostKind === "loopback") {
    reasons.push(
      `远程开关已开但只绑回环 ${rawHost}：外部设备仍连不上（等于没外露），token 鉴权在位`,
    );
  } else {
    reasons.push(
      `远程已开启：绑 ${rawHost}（${hostKind}），非回环来源一律要 token（${REMOTE_ENABLE_ENV}=1 ${REMOTE_HOST_ENV}=<局域网 IP>）`,
    );
  }
  reasons.push(`token 有效期 ${Math.round(tokenTtlMs / 60_000)} 分钟；会话有效期 ${Math.round(sessionTtlMs / 60_000)} 分钟`);

  return {
    enabled,
    writeEnabled,
    chatExposed,
    terminalExposed,
    memoryExposed,
    host: rawHost,
    bindHost: rawHost,
    hostKind,
    tokenTtlMs,
    sessionTtlMs,
    reasons,
    warnings,
  };
}

/** token 文件路径（全局数据目录下；DESIGN.md §8.1 全局层，不进任何项目、不进 repo）。 */
export function tokenFilePath(dataDir: string): string {
  return path.join(dataDir, REMOTE_DATA_SUBDIR, TOKEN_FILE_NAME);
}

// ── F2（2026-09-18 审计）：主机名绑定的 DNS 红线 ──────────────────────────────────────
// 审计发现：`TATAI_HOST=<主机名>` 此前只给一条警告就放行——主机名解析到公网 A 记录时，
// 等于绕过"公网 IP 拒绑"红线（红线⑥）绕道进门。这里在 listen 之前补一次解析，
// 逐个地址过 `classifyBindHost` 的既有公网判定：公网 → 与 IP 字面量**同路径同错误码**
// （PUBLIC_HOST_FORBIDDEN）拒启动；解析失败/无记录 → 维持"仅警告"口径（不新增拒绝路径）。
// `resolveRemoteConfig` 是同步的（checkRedlines/CLI/验证脚本都依赖这一点），所以这一步
// 单独做成异步函数，由 index.ts 启动链路在 listen 前调用。

/** 主机名解析器（可注入：验证脚本离线断言用它，不依赖真实 DNS） */
export type HostnameResolver = (hostname: string) => Promise<string[]>;

let hostnameResolverHook: HostnameResolver | null = null;

/** 注入/清空解析器钩子（验证脚本专用：注入后 assertBindHostnameSafe 走它，不动真实 DNS） */
export function setHostnameResolverForTest(fn: HostnameResolver | null): void {
  hostnameResolverHook = fn;
}

/** 缺省解析：A + AAAA 各查一遍，失败按"无记录"处理（空数组，不抛——维持仅警告口径） */
async function resolveHostDefault(hostname: string): Promise<string[]> {
  const [v4, v6] = await Promise.all([
    dnsPromises.resolve4(hostname).catch(() => [] as string[]),
    dnsPromises.resolve6(hostname).catch(() => [] as string[]),
  ]);
  return [...v4, ...v6];
}

/**
 * 主机名绑定安全断言：解析结果逐一过公网判定，命中公网即抛 `PUBLIC_HOST_FORBIDDEN`
 * （与 IP 字面量同一条拒绝路径）。返回实际解析到的地址（供启动日志打印证据）。
 */
export async function assertBindHostnameSafe(
  hostname: string,
  opts: { resolve?: HostnameResolver } = {},
): Promise<{ resolved: string[] }> {
  const resolve = opts.resolve ?? hostnameResolverHook ?? resolveHostDefault;
  // 解析器抛错（网络不可用/DNS 拒答等）按"无记录"处理——维持仅警告口径，不新增拒绝路径
  const addresses = await Promise.resolve(resolve(hostname)).catch(() => [] as string[]);
  const publicOnes = addresses.filter((a) => classifyBindHost(a) === "public");
  if (publicOnes.length > 0) {
    throw new RemoteConfigError(
      "PUBLIC_HOST_FORBIDDEN",
      `${REMOTE_HOST_ENV}=${hostname} 是主机名，DNS 解析出公网地址 ${publicOnes.join("、")}，` +
        `塔台不面向公网（PUBLIC_INTERNET_SUPPORTED=false）。${PUBLIC_INTERNET_REASON}`,
      "请填本机局域网 IP（192.168.x.x / 10.x.x.x / 172.16-31.x.x），或让该主机名只解析到内网地址",
    );
  }
  return { resolved: addresses };
}

/** 本机局域网 IPv4 地址（服务启动日志用；也是验证脚本挑 bind 地址的来源）。 */
export function lanAddresses(): { iface: string; address: string }[] {
  const out: { iface: string; address: string }[] = [];
  for (const [iface, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) out.push({ iface, address: a.address });
    }
  }
  return out;
}

// ── 红线自查（验证脚本 DoD① 的"逐条对照代码常量"表就调它，不另写一份口径）──

export interface RedlineCheck {
  id: string;
  title: string;
  anchor: string;
  design: string;
  pass: boolean;
  detail: string;
}

function throwsCode(fn: () => unknown, code: RemoteErrorCode): string | null {
  try {
    fn();
    return null;
  } catch (e) {
    if (e instanceof RemoteConfigError) {
      return e.code === code ? code : `期望 ${code}，实得 ${e.code}`;
    }
    return `期望 ${code}，实得非 RemoteConfigError: ${(e as Error).message}`;
  }
}

/**
 * 逐条检查九条红线是否真的落在代码里（活体检查：不是复述文档，而是对常量与解析函数实跑一遍）。
 * 返回结果供 `scripts/verify-s1.ts` / `scripts/verify-s2.ts` 打印对照表。
 */
export function checkRedlines(): RedlineCheck[] {
  const base: RemoteConfig = resolveRemoteConfig({});
  const remoteOnly = resolveRemoteConfig({ [REMOTE_ENABLE_ENV]: "1", [REMOTE_HOST_ENV]: "192.168.1.9" });
  const checks: RedlineCheck[] = [
    {
      id: "R1",
      title: "默认关闭远程",
      anchor: "REMOTE_DEFAULT_ENABLED=false + resolveRemoteConfig({}).enabled",
      design: "DESIGN.md §1.4（本期不做远程）",
      pass: REMOTE_DEFAULT_ENABLED === false && base.enabled === false && base.bindHost === REMOTE_DEFAULT_HOST,
      detail: `默认 enabled=${base.enabled}，bindHost=${base.bindHost}`,
    },
    {
      id: "R2",
      title: "仅绑局域网地址（绝不 0.0.0.0）",
      anchor: "classifyBindHost / WILDCARD_HOSTS / REMOTE_WILDCARD_ENV（默认拒）",
      design: "DESIGN.md §1.4 / §10.2",
      pass:
        throwsCode(() => resolveRemoteConfig({ [REMOTE_HOST_ENV]: "0.0.0.0" }), "WILDCARD_FORBIDDEN") ===
          "WILDCARD_FORBIDDEN" &&
        throwsCode(
          () => resolveRemoteConfig({ [REMOTE_HOST_ENV]: "192.168.1.9" }),
          "HOST_REQUIRES_REMOTE",
        ) === "HOST_REQUIRES_REMOTE" &&
        remoteOnly.hostKind === "lan",
      detail:
        `0.0.0.0 默认拒（${throwsCode(() => resolveRemoteConfig({ [REMOTE_HOST_ENV]: "0.0.0.0" }), "WILDCARD_FORBIDDEN")}）；` +
        `非回环未开远程拒（${throwsCode(() => resolveRemoteConfig({ [REMOTE_HOST_ENV]: "192.168.1.9" }), "HOST_REQUIRES_REMOTE")}）；` +
        `开启后 192.168.1.9 → ${remoteOnly.hostKind}`,
    },
    {
      id: "R3",
      title: "只读为核心模式",
      anchor: `REMOTE_DEFAULT_READ_ONLY=true + READ_ONLY_METHODS=${READ_ONLY_METHODS.join("/")}`,
      design: "DESIGN.md §1.4 / PLAN S2（写接口逐个拒绝）",
      pass: REMOTE_DEFAULT_READ_ONLY === true && remoteOnly.writeEnabled === false && READ_ONLY_METHODS.length === 3,
      detail: `远程开启但未给写开关时 writeEnabled=${remoteOnly.writeEnabled}`,
    },
    {
      id: "R4",
      title: "写模式必须显式开启（双开关 + 二次确认）",
      anchor: `${WRITE_MODE_SWITCHES.join(" + ")}（确认语逐字比对）`,
      design: "DESIGN.md §10.2 / PLAN S3（写模式二次确认）",
      pass:
        throwsCode(() => resolveRemoteConfig({ [REMOTE_ENABLE_ENV]: "1", [REMOTE_WRITE_ENV]: "1" }), "WRITE_CONFIRM_REQUIRED") ===
          "WRITE_CONFIRM_REQUIRED" &&
        resolveRemoteConfig({
          [REMOTE_ENABLE_ENV]: "1",
          [REMOTE_WRITE_ENV]: "1",
          [REMOTE_WRITE_CONFIRM_ENV]: WRITE_CONFIRM_PHRASE,
        }).writeEnabled === true,
      detail:
        `只给写开关 → ${throwsCode(() => resolveRemoteConfig({ [REMOTE_ENABLE_ENV]: "1", [REMOTE_WRITE_ENV]: "1" }), "WRITE_CONFIRM_REQUIRED")}；` +
        "两道开关都给 → writeEnabled=true",
    },
    {
      id: "R5",
      title: "必须 token 鉴权（无 token 不放行远程）",
      anchor: "REMOTE_REQUIRES_TOKEN=true + auth.ts（TOKEN_BYTES/随机源/TTL/会话）",
      design: "DESIGN.md §10.2",
      pass: REMOTE_REQUIRES_TOKEN === true && base.tokenTtlMs > 0 && base.sessionTtlMs > 0,
      detail: `requiresToken=${REMOTE_REQUIRES_TOKEN}，token TTL ${base.tokenTtlMs / 60_000} 分钟、会话 TTL ${base.sessionTtlMs / 60_000} 分钟`,
    },
    {
      id: "R6",
      title: "不面向公网",
      anchor: "PUBLIC_INTERNET_SUPPORTED=false + PUBLIC_INTERNET_REASON",
      design: "DESIGN.md §10.2",
      pass:
        PUBLIC_INTERNET_SUPPORTED === false &&
        throwsCode(
          () => resolveRemoteConfig({ [REMOTE_ENABLE_ENV]: "1", [REMOTE_HOST_ENV]: "8.8.8.8" }),
          "PUBLIC_HOST_FORBIDDEN",
        ) === "PUBLIC_HOST_FORBIDDEN" &&
        PUBLIC_INTERNET_REASON.includes("无 TLS"),
      detail: `公网 IP 8.8.8.8 → ${throwsCode(() => resolveRemoteConfig({ [REMOTE_ENABLE_ENV]: "1", [REMOTE_HOST_ENV]: "8.8.8.8" }), "PUBLIC_HOST_FORBIDDEN")}；理由 ${PUBLIC_INTERNET_REASON.length} 字`,
    },
    {
      id: "R7",
      title: "聊天全文默认不外泄",
      anchor: `REMOTE_DEFAULT_CHAT_EXPOSED=false + ${REMOTE_CHAT_ENV}（显式置位才开）`,
      design: "DESIGN.md §10.2 / PLAN S2 DoD④",
      pass:
        REMOTE_DEFAULT_CHAT_EXPOSED === false &&
        base.chatExposed === false &&
        remoteOnly.chatExposed === false &&
        resolveRemoteConfig({ [REMOTE_ENABLE_ENV]: "1", [REMOTE_HOST_ENV]: "192.168.1.9", [REMOTE_CHAT_ENV]: "1" })
          .chatExposed === true,
      detail: `默认 chatExposed=${base.chatExposed}；开远程不给聊天开关=${remoteOnly.chatExposed}；显式给了=${resolveRemoteConfig({ [REMOTE_ENABLE_ENV]: "1", [REMOTE_HOST_ENV]: "192.168.1.9", [REMOTE_CHAT_ENV]: "1" }).chatExposed}`,
    },
    {
      id: "R8",
      title: "终端历史/终端输出默认不外泄",
      anchor: `REMOTE_DEFAULT_TERMINAL_EXPOSED=false + ${REMOTE_TERMINAL_ENV}（显式置位才开）`,
      design: "DESIGN.md §10.2 / PLAN S3（终端历史远程可读性表态）",
      pass:
        REMOTE_DEFAULT_TERMINAL_EXPOSED === false &&
        base.terminalExposed === false &&
        remoteOnly.terminalExposed === false &&
        resolveRemoteConfig({ [REMOTE_ENABLE_ENV]: "1", [REMOTE_HOST_ENV]: "192.168.1.9", [REMOTE_TERMINAL_ENV]: "1" })
          .terminalExposed === true,
      detail: `默认 terminalExposed=${base.terminalExposed}；开远程不给终端开关=${remoteOnly.terminalExposed}；显式给了=${resolveRemoteConfig({ [REMOTE_ENABLE_ENV]: "1", [REMOTE_HOST_ENV]: "192.168.1.9", [REMOTE_TERMINAL_ENV]: "1" }).terminalExposed}`,
    },
    {
      id: "R9",
      title: "记忆检索默认不外泄",
      anchor: `REMOTE_DEFAULT_MEMORY_EXPOSED=false + ${REMOTE_MEMORY_ENV}（显式置位才开）`,
      design: "DESIGN.md §10.2 / PLAN S3（敏感面扫描扫出来的口子）",
      pass:
        REMOTE_DEFAULT_MEMORY_EXPOSED === false &&
        base.memoryExposed === false &&
        remoteOnly.memoryExposed === false &&
        resolveRemoteConfig({ [REMOTE_ENABLE_ENV]: "1", [REMOTE_HOST_ENV]: "192.168.1.9", [REMOTE_MEMORY_ENV]: "1" })
          .memoryExposed === true,
      detail: `默认 memoryExposed=${base.memoryExposed}；开远程不给记忆开关=${remoteOnly.memoryExposed}；显式给了=${resolveRemoteConfig({ [REMOTE_ENABLE_ENV]: "1", [REMOTE_HOST_ENV]: "192.168.1.9", [REMOTE_MEMORY_ENV]: "1" }).memoryExposed}`,
    },
  ];
  return checks;
}
