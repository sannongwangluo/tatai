// S1 验证脚本（用 tsx 跑）：安全红线逐条对照 + 鉴权拒绝路径 + 默认零暴露 + 绑定证据。
// 用法：pnpm verify:s1
//
// 覆盖点（逐条对 PLAN.md S1 卡 DoD）：
//   ① DoD① 红线逐条对照代码常量：直接调 `remote-config.ts` 的 `checkRedlines()`（不是复述文档，
//      而是对常量与解析函数实跑一遍），并加源码级护栏（先鉴权后路由的顺序、CSPRNG、定时比较、无 Math.random）。
//   ② DoD② 三条拒绝路径：无 token / 错误 token / 过期 token——**单元级**（注入时钟，确定性）+ 
//      **HTTP 级**（真起服务、真发请求到局域网地址，看真实状态码与错误码），并把服务端拒绝日志一并贴出。
//      另加：正确 token 在只读模式下读通过 / 写被 403 REMOTE_READ_ONLY 拦下 / 写模式双开关放行。
//   ③ DoD③ 红线口径落 PROGRESS + DESIGN 附录 B：本脚本只负责把"代码里怎么落的"变成可贴的证据
//      （红线标题、常量名、DESIGN 章节、实跑结论），流水与附录 B 由本卡落盘步骤完成。
//   ④ DoD④ 默认零暴露：默认配置起服务 → 服务自己的绑定日志 + `netstat -ano` 原始行，证明
//      **只有 127.0.0.1 在 LISTENING**；再从局域网地址连一次，必须连不上；且默认关闭时不生成任何 token 文件。
//      另证伪：`TATAI_HOST=0.0.0.0` 与公网 IP 一律被拒（exit 1 + 明确错误码），只有显式危险开关才放行且有醒目警告。
//
// 端口策略（照 verify-p3/p2/n1 写法）：**不碰任何既有监听**——每个服务用动态空闲端口，起前探活、
// 起后盯子进程早退；开头末尾各探一次 8787/5173（只记录，不杀别人的进程）。
// 环境隔离：子进程 env 里先**清掉**所有 TATAI_REMOTE*/TATAI_HOST 变量再按用例注入——本脚本结论不许
// 继承调用者 shell 里的残留配置。
// 隐私（AGENTS.md §5/§6）：临时 TATAI_HOME 与夹具全在 os.tmpdir()；口令是脚本现场签发的夹具口令，
// 输出里只打指纹（sha256 前 12 位）不打原文。
import { execSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import nodeHttp from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AuthService,
  DEV_ORIGIN,
  SHELL_ORIGINS,
  TOKEN_LENGTH,
  TOKEN_PATTERN,
  TRUSTED_BROWSER_ORIGINS,
  credentialFromHeader,
  generateToken,
  guardRemoteRequest,
  isInsideRepo,
  isReadMethod,
  permissionHint,
  readTokenRecord,
  tokenFingerprint,
  tokenPathIn,
  writeTokenRecord,
} from "../src/server/auth";
import {
  REMOTE_ENABLE_ENV,
  REMOTE_HOST_ENV,
  REMOTE_TOKEN_TTL_ENV,
  REMOTE_WILDCARD_ENV,
  REMOTE_WRITE_CONFIRM_ENV,
  REMOTE_WRITE_ENV,
  WRITE_CONFIRM_PHRASE,
  RemoteConfigError,
  assertBindHostnameSafe,
  checkRedlines,
  classifyBindHost,
  isLoopbackAddress,
  isPrivateAddress,
  lanAddresses,
  resolveRemoteConfig,
  setHostnameResolverForTest,
  tokenFilePath,
} from "../src/server/remote-config";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_ENTRY = path.join("src", "server", "index.ts");

const ok = (cond: boolean, label: string) => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (!cond) process.exitCode = 1;
};
const info = (label: string) => console.log(`[verify] ---- ${label}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ───────────────────────────── 端口 / 进程 ─────────────────────────────

function portListening(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host });
    const done = (busy: boolean) => {
      sock.destroy();
      resolve(busy);
    };
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
    sock.setTimeout(1000, () => done(false));
  });
}

async function pickFreePort(host = "127.0.0.1"): Promise<number> {
  for (let i = 0; i < 5; i++) {
    const port = await new Promise<number>((resolve, reject) => {
      const srv = net.createServer();
      srv.once("error", reject);
      srv.listen(0, host, () => {
        const addr = srv.address();
        const p = typeof addr === "object" && addr ? addr.port : 0;
        srv.close(() => resolve(p));
      });
    });
    if (port > 0 && !(await portListening(port, host))) return port;
  }
  throw new Error("分配不到空闲端口（连续 5 次都被抢）");
}

const intentionalStop = new Set<number>();

function killTree(child: ChildProcess, port?: number): void {
  if (port) intentionalStop.add(port);
  if (!child.pid) return;
  if (process.platform === "win32") {
    try {
      execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore" });
    } catch {
      // 已退出则忽略
    }
  } else {
    child.kill();
  }
}

/** 子进程 env：先清干净 S1 相关变量，再按用例注入（结论不许继承调用者 shell 的残留） */
function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of [
    REMOTE_ENABLE_ENV,
    REMOTE_HOST_ENV,
    REMOTE_WRITE_ENV,
    REMOTE_WRITE_CONFIRM_ENV,
    REMOTE_WILDCARD_ENV,
    REMOTE_TOKEN_TTL_ENV,
    "TATAI_REMOTE_SESSION_TTL_MINUTES",
    "TATAI_LOG_TO_FILE",
  ]) {
    delete env[k];
  }
  return { ...env, ...extra };
}

interface Svc {
  proc: ChildProcess;
  port: number;
  host: string;
  base: string;
  output: () => string;
  exitCode: () => number | null;
}

async function startServer(
  label: string,
  host: string,
  env: Record<string, string>,
  opts: { waitNeedle?: string; timeoutMs?: number } = {},
): Promise<Svc> {
  const port = await pickFreePort(host);
  const child = spawn(process.execPath, ["--import", "tsx", SERVER_ENTRY], {
    cwd: REPO_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: cleanEnv({ TATAI_PORT: String(port), ...env }),
  });
  let buf = "";
  const collect = (d: Buffer) => {
    buf += d.toString();
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  child.once("exit", (code) => {
    if (!intentionalStop.has(port) && code !== 0) {
      console.error(`[verify] ${label}（端口 ${port}）意外退出：code=${code}`);
    }
  });
  const svc: Svc = {
    proc: child,
    port,
    host,
    base: `http://${host}:${port}`,
    output: () => buf,
    exitCode: () => child.exitCode,
  };
  const needle = opts.waitNeedle ?? `listening on http://${host}:${port}`;
  const deadline = Date.now() + (opts.timeoutMs ?? 60_000);
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${label} 启动即退出（code=${child.exitCode}）：\n${buf}`);
    if (buf.includes(needle) && (await portListening(port, host))) return svc;
    await sleep(150);
  }
  killTree(child, port);
  throw new Error(`${label} 未就绪（等 "${needle}" 超时）：\n${buf}`);
}

/** 起一个**预期被红线拒掉**的服务：等它自己退出，返回退出码与输出 */
async function startExpectReject(
  label: string,
  env: Record<string, string>,
  timeoutMs = 30_000,
): Promise<{ code: number | null; out: string }> {
  const port = await pickFreePort();
  const child = spawn(process.execPath, ["--import", "tsx", SERVER_ENTRY], {
    cwd: REPO_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: cleanEnv({ TATAI_PORT: String(port), ...env }),
  });
  let buf = "";
  child.stdout?.on("data", (d: Buffer) => (buf += d.toString()));
  child.stderr?.on("data", (d: Buffer) => (buf += d.toString()));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && child.exitCode === null) await sleep(100);
  if (child.exitCode === null) {
    killTree(child, port);
    return { code: null, out: buf };
  }
  intentionalStop.add(port);
  return { code: child.exitCode, out: buf };
}

/** netstat 里监听某端口的原始行（Windows：netstat -ano；其余平台：lsof/ss 兜底不实现，如实 SKIP） */
function netstatListeners(port: number): { raw: string; local: string }[] {
  if (process.platform !== "win32") return [];
  const out = execSync("netstat -ano", { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const rows: { raw: string; local: string }[] = [];
  for (const line of out.split(/\r?\n/)) {
    if (!line.includes("LISTENING")) continue;
    const cols = line.trim().split(/\s+/);
    if (cols.length < 4) continue;
    const local = cols[1];
    const cut = local.lastIndexOf(":");
    if (cut < 0 || Number(local.slice(cut + 1)) !== port) continue;
    rows.push({ raw: line.trim(), local });
  }
  return rows;
}

/** netstat local 列 → 纯地址（去掉 [ ] 与端口） */
function localAddressOf(local: string): string {
  const cut = local.lastIndexOf(":");
  return local.slice(0, cut).replace(/^\[|\]$/g, "");
}

// ───────────────────────────── HTTP 助手 ─────────────────────────────

interface HttpResult {
  status: number;
  body: { ok?: boolean; error?: { code?: string; message?: string } } & Record<string, unknown>;
  text: string;
}

async function http(
  base: string,
  pathName: string,
  opts: { method?: string; token?: string | null; body?: unknown } = {},
): Promise<HttpResult> {
  const headers: Record<string, string> = {};
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${base}${pathName}`, {
    method: opts.method ?? "GET",
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    signal: AbortSignal.timeout(8000),
  });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { raw: text };
  }
  return { status: res.status, body: body as HttpResult["body"], text };
}

const codeOf = (r: HttpResult) => r.body.error?.code ?? "(无 error.code)";

/**
 * F1 专用裸 HTTP 探针（node:http 直连）：fetch 的禁止头名单改不了 Origin/Host，
 * 而 F1 闸看的恰是这两个真实头——这里按需伪造，断言放行口在真头到达时的行为。
 * hostOverride 不传时用 `127.0.0.1:<port>`（正常同机访问形态）；
 * connectHost 是 TCP 层实际连的地址（远程服务只绑局域网 IP 时传该 IP）。
 */
function rawHttp(
  port: number,
  pathName: string,
  headers: Record<string, string>,
  method: "GET" | "POST" = "GET",
  body = "",
  hostOverride?: string,
  connectHost = "127.0.0.1",
): Promise<{ status: number; code: string; text: string }> {
  return new Promise((resolve, reject) => {
    const req = nodeHttp.request(
      {
        host: connectHost,
        port,
        method,
        path: pathName,
        headers: { host: hostOverride ?? `127.0.0.1:${port}`, ...headers },
      },
      (res) => {
        let buf = "";
        res.on("data", (c: Buffer) => (buf += c.toString()));
        res.on("end", () => {
          let code = "(无 error.code)";
          try {
            const parsed = JSON.parse(buf) as { error?: { code?: string } };
            if (parsed.error?.code) code = parsed.error.code;
          } catch {
            // 非 JSON 响应：code 保持 "(无 error.code)"
          }
          resolve({ status: res.statusCode ?? 0, code, text: buf });
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(8000, () => req.destroy(new Error("rawHttp 超时")));
    if (body !== "") req.write(body);
    req.end();
  });
}

// ───────────────────────────── 仓库口令自查 ─────────────────────────────

const SCAN_SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".工作台",
  "dist",
  "target",
  "resources",
  "gen",
]);

/** 工作区全仓扫一遍：有没有文件含这枚口令原文 / 有没有叫 auth.json 的口令文件 */
function scanRepoForSecret(secret: string): { files: number; hits: string[]; tokenNamedFiles: string[] } {
  const hits: string[] = [];
  const tokenNamedFiles: string[] = [];
  let files = 0;
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (SCAN_SKIP_DIRS.has(e.name)) continue;
        walk(path.join(dir, e.name));
        continue;
      }
      const full = path.join(dir, e.name);
      const rel = path.relative(REPO_ROOT, full).replace(/\\/g, "/");
      if (/auth\.json$/.test(e.name)) tokenNamedFiles.push(rel);
      let size = 0;
      try {
        size = fs.statSync(full).size;
      } catch {
        continue;
      }
      if (size > 1024 * 1024) continue; // 文本自查，>1MB 的产物跳过（不假装扫过二进制）
      files++;
      try {
        if (fs.readFileSync(full, "utf8").includes(secret)) hits.push(rel);
      } catch {
        // 二进制/编码不认：跳过（口令是 ASCII，命中一定发生在可读的文本里）
      }
    }
  };
  walk(REPO_ROOT);
  return { files, hits, tokenNamedFiles };
}

// ───────────────────────────── 主流程 ─────────────────────────────

async function main(): Promise<void> {
  console.log("[verify] S1 安全红线定版 + 鉴权：红线对照 / 拒绝路径 / 默认零暴露 / 绑定证据");
  console.log(
    `[verify]   node ${process.version} · ${process.platform} · repo ${REPO_ROOT}`,
  );
  const fixedBefore = { v: await portListening(8787), d: await portListening(5173) };
  console.log(
    `[verify]   8787 ${fixedBefore.v ? "有人监听（别人的，不碰）" : "空闲"} · 5173 ${fixedBefore.d ? "有人监听（别人的，不碰）" : "空闲"}`,
  );

  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-s1-verify-"));
  const lanAll = lanAddresses();
  const lanIp = lanAll[0]?.address ?? null;
  console.log(
    `[verify]   本机局域网地址：${lanAll.map((a) => `${a.address}(${a.iface})`).join("、") || "（无，远程段降级为回环）"}`,
  );
  const lanHost = lanIp ?? "127.0.0.1";
  const lanLess = lanIp === null;
  if (lanLess) {
    console.log("[verify]   ⚠ 本机没有非内部 IPv4：远程段改用回环地址起服务（HTTP 级只读/写门槛会退化为本机放行），真实局域网段 SKIP");
  }

  const live: Svc[] = [];
  try {
    // ═══════════════ ① DoD①：六条红线逐条对照代码常量 ═══════════════
    info("① DoD①：红线逐条对照代码常量（remote-config.ts 活体自查，不是复述文档）");
    const checks = checkRedlines();
    for (const c of checks) {
      ok(c.pass, `① [${c.id}] ${c.title} ｜ 锚点 ${c.anchor} ｜ 依据 ${c.design} ｜ 实测 ${c.detail}`);
    }
    console.log(
      `[verify]   红线条数：代码自查表 ${checks.length} 条，全部通过 ${checks.every((c) => c.pass)}`,
    );

    info("① 源码级护栏（红线不能只靠运行期一跑）");
    const readSrc = (rel: string) => fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
    // 看**代码**而不是注释：说明"为什么不用 Math.random"的注释里会出现这个词，剥掉注释再查才拦得住真的裸随机
    const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    const authSrc = readSrc("src/server/auth.ts");
    const authCode = stripComments(authSrc);
    const cfgSrc = readSrc("src/server/remote-config.ts");
    const indexSrc = readSrc("src/server/index.ts");
    ok(
      authCode.includes("randomBytes(") && !authCode.includes("Math.random"),
      "① auth.ts 代码里用 crypto.randomBytes、不出现 Math.random（注释里提到不算）",
    );
    ok(authSrc.includes("timingSafeEqual"), "① auth.ts 口令比对走 timingSafeEqual（不用 === 裸比）");
    ok(authSrc.includes("expires_at") && authSrc.includes("EXPIRED_TOKEN"), "① auth.ts 有到期时间与过期拒绝码（EXPIRED_TOKEN）");
    ok(
      authSrc.includes("REMOTE_DATA_SUBDIR") && !authSrc.includes("REPO_ROOT"),
      "① auth.ts 的口令落点来自 global 数据目录（remote/ 子目录），代码里没有任何 repo 内落点",
    );
    const guardIdx = indexSrc.indexOf("guardRemoteRequest(remoteConfig");
    const routeIdx = indexSrc.indexOf('req.url?.match(/^\\/api\\/projects');
    const corsIdx = indexSrc.indexOf("applyShellCors(req, res)");
    ok(
      guardIdx > 0 && routeIdx > 0 && guardIdx < routeIdx && guardIdx < corsIdx,
      `① index.ts 里鉴权口在路由与 CORS 之前（guard@${guardIdx} < 路由@${routeIdx}、< CORS@${corsIdx}）——顺序即红线`,
    );
    ok(
      cfgSrc.includes("REMOTE_DEFAULT_ENABLED = false") &&
        cfgSrc.includes("PUBLIC_INTERNET_SUPPORTED = false") &&
        cfgSrc.includes("REMOTE_REQUIRES_TOKEN = true") &&
        cfgSrc.includes('REMOTE_DEFAULT_HOST = "127.0.0.1"'),
      "① 四个红线常量字面量都在 remote-config.ts（默认关闭 / 必须 token / 不面向公网 / 默认回环）",
    );

    // ═══════════════ ② DoD②：鉴权模块单测（含三条拒绝路径） ═══════════════
    info("② DoD②：鉴权模块单测（CLI 级，注入时钟）");
    const homeUnit = path.join(tmpBase, "home-unit");
    fs.mkdirSync(homeUnit, { recursive: true });
    let clockNow = new Date("2026-09-18T10:00:00+08:00");
    const authUnit = new AuthService({
      dataDir: homeUnit,
      tokenTtlMs: 60_000, // 1 分钟
      sessionTtlMs: 5 * 60_000, // 5 分钟
      now: () => clockNow,
    });

    const minted = authUnit.ensureToken();
    const token = minted.record.token;
    console.log(`[verify]   夹具口令：长度 ${token.length} 字符 · 指纹 ${tokenFingerprint(token)} · 到期 ${minted.record.expires_at}`);
    ok(minted.created && TOKEN_PATTERN.test(token) && token.length === TOKEN_LENGTH, `② 口令形态：${TOKEN_LENGTH} 字符 base64url（实测 ${token.length}，正则命中 ${TOKEN_PATTERN.test(token)}）`);
    ok(fs.existsSync(tokenPathIn(homeUnit)), `② 口令落盘位置：${tokenPathIn(homeUnit)}`);
    const mode = fs.statSync(tokenPathIn(homeUnit)).mode & 0o777;
    console.log(
      `[verify]   文件权限位 0o${mode.toString(8)}（POSIX 下 0o600；Windows 上 chmod 只动只读位）· 提示：${permissionHint(homeUnit)}`,
    );
    ok(permissionHint(homeUnit).includes("0600"), "② 权限提示在位（0600 + Windows ACL 说明，不假装 chmod 就是 ACL）");
    ok(authUnit.ensureToken().created === false && authUnit.load()?.token === token, "② 已有口令时 ensureToken 不重复签发（幂等）");
    const uniq = new Set(Array.from({ length: 500 }, () => generateToken()));
    ok(uniq.size === 500, `② 随机源可用性：连签 500 枚无重复（实测唯一 ${uniq.size}）`);

    // 三条拒绝路径（单元级）
    const noToken = authUnit.verifyToken(undefined);
    const badToken = authUnit.verifyToken(generateToken());
    ok(noToken.ok === false && noToken.reason === "NO_TOKEN", `② 拒绝路径①：无 token → ${noToken.ok ? "放过（错！）" : noToken.reason}`);
    ok(badToken.ok === false && badToken.reason === "BAD_TOKEN", `② 拒绝路径②：错误 token → ${badToken.ok ? "放过（错！）" : badToken.reason}`);
    ok(authUnit.verifyToken(token).ok === true, "② 正确 token → 通过（对照组）");
    clockNow = new Date(clockNow.getTime() + 61_000); // 越过 1 分钟 TTL
    const expired = authUnit.verifyToken(token);
    ok(expired.ok === false && expired.reason === "EXPIRED_TOKEN", `② 拒绝路径③：过期 token（时钟 +61s）→ ${expired.ok ? "放过（错！）" : expired.reason}`);
    clockNow = new Date("2026-09-18T10:00:00+08:00"); // 时钟回拨，继续下面的用例

    // 会话与登出
    const session = authUnit.createSession(token, "192.168.1.99");
    ok(authUnit.verifySession(session.session_id).ok === true, `② 会话签发与校验：${session.session_id.slice(0, 6)}…（${session.session_id.length} 字符，指纹 ${session.token_fingerprint}）`);
    ok(authUnit.authorize(session.session_id).ok === true, "② 会话可直接当凭据用（Authorization 里 `s_` 前缀走会话）");
    ok(authUnit.logout(session.session_id) === true && authUnit.verifySession(session.session_id).ok === false, "② 登出：logout 后同一会话立刻失效");
    ok(authUnit.logout(session.session_id) === false, "② 登出幂等：再登出返回 false（不报错）");
    const s2 = authUnit.createSession(token);
    clockNow = new Date(clockNow.getTime() + 6 * 60_000); // 越过会话 TTL
    const s2v = authUnit.verifySession(s2.session_id);
    ok(s2v.ok === false && s2v.reason === "SESSION_EXPIRED", `② 会话到期自动失效 → ${s2v.ok ? "放过（错！）" : s2v.reason}`);
    ok(authUnit.listSessions().length === 0, "② 过期会话被清理（listSessions 不再返回它）");
    clockNow = new Date("2026-09-18T10:00:00+08:00");
    const s3 = authUnit.createSession(token);
    const rotated = authUnit.rotateToken();
    ok(
      authUnit.verifyToken(token).ok === false &&
        authUnit.verifyToken(rotated.token).ok === true &&
        authUnit.verifySession(s3.session_id).ok === false,
      "② 轮换：旧口令立刻失效、新口令可用、既有会话一并作废",
    );

    // 头解析 / 只读方法 / 地址判定
    ok(
      credentialFromHeader("Bearer abc") === "abc" &&
        credentialFromHeader("  bearer   abc  ") === "abc" &&
        credentialFromHeader("abc") === "abc" &&
        credentialFromHeader("") === null &&
        credentialFromHeader(undefined) === null,
      "② Authorization 解析：`Bearer x` / 裸 x 都认，空值 → null",
    );
    ok(
      isReadMethod("GET") && isReadMethod("head") && isReadMethod("OPTIONS") && !isReadMethod("POST") && !isReadMethod("PUT") && !isReadMethod("DELETE"),
      "② 只读方法集合 = GET/HEAD/OPTIONS；POST/PUT/DELETE 一律按写处理",
    );
    ok(
      isLoopbackAddress("127.0.0.1") &&
        isLoopbackAddress("127.8.8.8") &&
        isLoopbackAddress("::1") &&
        isLoopbackAddress("::ffff:127.0.0.1") &&
        !isLoopbackAddress("192.168.1.50") &&
        !isLoopbackAddress("8.8.8.8") &&
        !isLoopbackAddress("::ffff:192.168.1.50"),
      "② 回环判定：127.0.0.0/8、::1、IPv4-mapped 都算回环；局域网/公网地址不算",
    );
    ok(
      isPrivateAddress("192.168.1.50") &&
        isPrivateAddress("10.0.0.7") &&
        isPrivateAddress("172.16.3.4") &&
        isPrivateAddress("172.31.255.254") &&
        !isPrivateAddress("172.32.0.1") &&
        !isPrivateAddress("8.8.8.8"),
      "② 局域网判定：10/8、172.16-31/12、192.168/16 命中；172.32 与公网不命中",
    );

    // 放行口（单元级，覆盖"非回环"分支，绕开"本机无局域网 IP"的环境限制）
    info("② 放行口单元表：本机 / 无 token / 错 token / 过期 / 只读拦写 / 写模式放行");
    const cfgRemote = resolveRemoteConfig({ [REMOTE_ENABLE_ENV]: "1", [REMOTE_HOST_ENV]: "192.168.1.9" });
    const cfgRemoteWrite = resolveRemoteConfig({
      [REMOTE_ENABLE_ENV]: "1",
      [REMOTE_HOST_ENV]: "192.168.1.9",
      [REMOTE_WRITE_ENV]: "1",
      [REMOTE_WRITE_CONFIRM_ENV]: WRITE_CONFIRM_PHRASE,
    });
    const cfgOff = resolveRemoteConfig({});
    // 独立实例（上面那枚已轮换，这里重新签发一枚干净的）
    const homeGuard = path.join(tmpBase, "home-guard");
    fs.mkdirSync(homeGuard, { recursive: true });
    const authGuard = new AuthService({ dataDir: homeGuard, tokenTtlMs: 60_000, sessionTtlMs: 60_000, now: () => clockNow });
    const gTok = authGuard.ensureToken().record.token;
    const gLocal = guardRemoteRequest(cfgRemote, authGuard, { remoteAddress: "127.0.0.1", method: "POST", authorization: null });
    ok(gLocal.ok === true && gLocal.remote === false, "② 本机回环 POST 无 token → 放行（本机 = 桌面 UI 信任域，行为与 S1 之前一致）");
    const gDisabled = guardRemoteRequest(cfgOff, null, { remoteAddress: "192.168.1.50", method: "GET", authorization: gTok });
    ok(gDisabled.ok === false && gDisabled.code === "REMOTE_DISABLED" && gDisabled.status === 403, `② 远程没开但来了非回环请求 → 403 REMOTE_DISABLED（实得 ${gDisabled.ok ? "放行（错！）" : `${gDisabled.status} ${gDisabled.code}`}）`);
    const gNone = guardRemoteRequest(cfgRemote, authGuard, { remoteAddress: "192.168.1.50", method: "GET", authorization: null });
    ok(gNone.ok === false && gNone.code === "NO_TOKEN" && gNone.status === 401, `② 非回环无 token → 401 NO_TOKEN（实得 ${gNone.ok ? "放行（错！）" : `${gNone.status} ${gNone.code}`}）`);
    const gBad = guardRemoteRequest(cfgRemote, authGuard, { remoteAddress: "192.168.1.50", method: "GET", authorization: `Bearer ${generateToken()}` });
    ok(gBad.ok === false && gBad.code === "BAD_TOKEN" && gBad.status === 401, `② 非回环错误 token → 401 BAD_TOKEN（实得 ${gBad.ok ? "放行（错！）" : `${gBad.status} ${gBad.code}`}）`);
    const gOk = guardRemoteRequest(cfgRemote, authGuard, { remoteAddress: "192.168.1.50", method: "GET", authorization: `Bearer ${gTok}` });
    ok(gOk.ok === true && gOk.remote === true, `② 非回环正确 token + 读方法 → 放行（指纹 ${gOk.ok ? gOk.fingerprint : "-"}）`);
    const gWrite = guardRemoteRequest(cfgRemote, authGuard, { remoteAddress: "192.168.1.50", method: "POST", authorization: `Bearer ${gTok}` });
    ok(gWrite.ok === false && gWrite.code === "REMOTE_READ_ONLY" && gWrite.status === 403, `② 非回环正确 token + 写方法 + 只读默认 → 403 REMOTE_READ_ONLY（实得 ${gWrite.ok ? "放行（错！）" : `${gWrite.status} ${gWrite.code}`}）`);
    const gWriteOk = guardRemoteRequest(cfgRemoteWrite, authGuard, { remoteAddress: "192.168.1.50", method: "POST", authorization: `Bearer ${gTok}` });
    ok(gWriteOk.ok === true, "② 写模式（双开关都给）下同一写请求 → 放行（对照组）");
    const gSession = authGuard.createSession(gTok, "192.168.1.50");
    const gSess = guardRemoteRequest(cfgRemote, authGuard, { remoteAddress: "192.168.1.50", method: "GET", authorization: `Bearer ${gSession.session_id}` });
    ok(gSess.ok === true, "② 会话当凭据放行；logout 后同一凭据 → 401 SESSION_INVALID");
    authGuard.logout(gSession.session_id);
    const gSess2 = guardRemoteRequest(cfgRemote, authGuard, { remoteAddress: "192.168.1.50", method: "GET", authorization: `Bearer ${gSession.session_id}` });
    ok(gSess2.ok === false && gSess2.code === "SESSION_INVALID", `② 登出后凭据失效（实得 ${gSess2.ok ? "放行（错！）" : `${gSess2.status} ${gSess2.code}`}）`);

    // ── F1（2026-09-18 审计）Origin/Host 两道闸（单元级；回环与远程来源都过闸）──
    // 审计结论：回环来源在放行口直接放行，浏览器可用 text/plain 正文对写接口做 CSRF，
    // DNS rebinding 还能把响应变同源可读。两道闸只拦"带不合法 Origin"与"Host 不合法"，
    // 无 Origin/Host 的非浏览器客户端（curl / MCP stdio 转发 / 健康探测）零影响。
    ok(
      SHELL_ORIGINS.length === 3 && (TRUSTED_BROWSER_ORIGINS as readonly string[]).includes(DEV_ORIGIN),
      `② F1：白名单常量单一出处（壳 ${SHELL_ORIGINS.length} 件套 + dev ${DEV_ORIGIN}）`,
    );
    const gOriginBad = guardRemoteRequest(cfgRemote, authGuard, { remoteAddress: "127.0.0.1", method: "POST", authorization: null, origin: "http://attacker.example" });
    ok(!gOriginBad.ok && gOriginBad.code === "ORIGIN_FORBIDDEN" && gOriginBad.status === 403, `② F1：回环 POST 带恶意 Origin → 403 ORIGIN_FORBIDDEN（实得 ${gOriginBad.ok ? "放行（错！）" : `${gOriginBad.status} ${gOriginBad.code}`}）`);
    const gOriginShell = guardRemoteRequest(cfgRemote, authGuard, { remoteAddress: "127.0.0.1", method: "POST", authorization: null, origin: SHELL_ORIGINS[0] });
    ok(gOriginShell.ok === true, `② F1：同一请求带壳 origin（${SHELL_ORIGINS[0]}）→ 放行`);
    const gOriginDyn = guardRemoteRequest(cfgRemote, authGuard, { remoteAddress: "127.0.0.1", method: "POST", authorization: null, origin: "http://localhost:51999" });
    ok(gOriginDyn.ok === true, "② F1：回环主机任意口 origin（端口卫生：开发/验证动态口起 vite 的真实形态）→ 放行");
    const gOriginNearMiss = guardRemoteRequest(cfgRemote, authGuard, { remoteAddress: "127.0.0.1", method: "POST", authorization: null, origin: "http://localhost.evil.example" });
    ok(!gOriginNearMiss.ok && gOriginNearMiss.code === "ORIGIN_FORBIDDEN", `② F1：近似域名 localhost.evil.example 进不了白名单（实得 ${gOriginNearMiss.ok ? "放行（错！）" : gOriginNearMiss.code}）`);
    const gOriginNull = guardRemoteRequest(cfgRemote, authGuard, { remoteAddress: "127.0.0.1", method: "POST", authorization: null, origin: "null" });
    ok(!gOriginNull.ok && gOriginNull.code === "ORIGIN_FORBIDDEN", `② F1：沙箱 iframe 可造的 Origin:null → 拒（实得 ${gOriginNull.ok ? "放行（错！）" : gOriginNull.code}）`);
    const gOriginRead = guardRemoteRequest(cfgRemote, authGuard, { remoteAddress: "127.0.0.1", method: "GET", authorization: null, origin: "http://attacker.example" });
    ok(gOriginRead.ok === true, "② F1：读方法带任意 Origin → 不归 Origin 闸管（读面不靠 Origin，靠 token/只读口径）");
    const gHostBad = guardRemoteRequest(cfgRemote, authGuard, { remoteAddress: "127.0.0.1", method: "GET", authorization: null, host: "rebind.attacker.example:8787" });
    ok(!gHostBad.ok && gHostBad.code === "HOST_FORBIDDEN" && gHostBad.status === 403, `② F1：Host 是 rebinding 域名 → 403 HOST_FORBIDDEN（实得 ${gHostBad.ok ? "放行（错！）" : `${gHostBad.status} ${gHostBad.code}`}）`);
    const gHostLoop = guardRemoteRequest(cfgRemote, authGuard, { remoteAddress: "192.168.1.50", method: "GET", authorization: `Bearer ${gTok}`, host: "localhost:8787" });
    ok(gHostLoop.ok === true, "② F1：Host=localhost[:口] 合法（远程来源也认回环名）");
    const gHostBind = guardRemoteRequest(cfgRemote, authGuard, { remoteAddress: "192.168.1.50", method: "GET", authorization: `Bearer ${gTok}`, host: "192.168.1.9:8787" });
    ok(gHostBind.ok === true, "② F1：Host=显式配置的绑定地址（192.168.1.9）→ 合法");
    const gHostOther = guardRemoteRequest(cfgRemote, authGuard, { remoteAddress: "192.168.1.50", method: "GET", authorization: `Bearer ${gTok}`, host: "192.168.1.99:8787" });
    ok(!gHostOther.ok && gHostOther.code === "HOST_FORBIDDEN", `② F1：Host=别的局域网 IP（非绑定地址）→ 拒（实得 ${gHostOther.ok ? "放行（错！）" : gHostOther.code}）`);
    const gNoHeaders = guardRemoteRequest(cfgRemote, authGuard, { remoteAddress: "127.0.0.1", method: "POST", authorization: null });
    ok(gNoHeaders.ok === true, "② F1：不带 Origin/Host 字段的调用（curl / MCP 转发 / 健康探测形态）→ 行为与闸前逐字一致");
    const gLoginSame = guardRemoteRequest(cfgRemote, authGuard, { remoteAddress: "192.168.1.50", method: "POST", authorization: `Bearer ${gTok}`, path: "/api/remote/login", origin: "http://192.168.1.9:8787", host: "192.168.1.9:8787" });
    ok(gLoginSame.ok === true, "② F1：远程登录页同源 POST /api/remote/login → 放行（登录页是同源 fetch，语义没修死）");
    const gLoginCross = guardRemoteRequest(cfgRemote, authGuard, { remoteAddress: "192.168.1.50", method: "POST", authorization: `Bearer ${gTok}`, path: "/api/remote/login", origin: "http://attacker.example" });
    ok(!gLoginCross.ok && gLoginCross.code === "ORIGIN_FORBIDDEN", `② F1：跨源表单打登录口 → 拒（实得 ${gLoginCross.ok ? "放行（错！）" : gLoginCross.code}）`);

    // ═══════════════ ③ DoD④：默认配置零暴露 ═══════════════
    info("③ DoD④：默认配置启动 → 只有本机回环在监听（服务自身绑定日志 + netstat 原始行）");
    const homeDefault = path.join(tmpBase, "home-default");
    fs.mkdirSync(homeDefault, { recursive: true });
    const def = await startServer("默认服务", "127.0.0.1", { TATAI_HOME: homeDefault });
    live.push(def);
    const defLog = def.output();
    console.log("[verify]   服务自身绑定日志：");
    for (const line of defLog.split(/\r?\n/).filter((l) => l.startsWith("[tatai-server]"))) {
      console.log(`[verify]     ${line}`);
    }
    ok(
      defLog.includes(`listening on http://127.0.0.1:${def.port} (仅本机)`),
      `③ 绑定日志：listening on http://127.0.0.1:${def.port} (仅本机)`,
    );
    ok(defLog.includes("远程访问未开启（默认关闭）"), "③ 启动日志明说远程未开启（默认关闭）");
    const defRows = netstatListeners(def.port);
    console.log(`[verify]   netstat -ano | (localhost:${def.port}) 原始行：`);
    for (const r of defRows) console.log(`[verify]     ${r.raw}`);
    ok(defRows.length >= 1, `③ netstat 找到 ${defRows.length} 条该端口的监听行（0 条说明证据缺失）`);
    ok(
      defRows.every((r) => isLoopbackAddress(localAddressOf(r.local))),
      `③ **每一条监听行都是回环地址**（实测 ${defRows.map((r) => localAddressOf(r.local)).join("、")}）——没有任何非本机地址在 LISTENING`,
    );
    const health = await http(def.base, "/health");
    ok(health.status === 200 && health.body.ok === true, `③ 本机访问 /health → ${health.status}（默认配置下本机照常可用，S1 不破坏既有本地链路）`);

    // ── F1（2026-09-18 审计）HTTP 级 Origin/Host 闸（默认回环服务也在管辖内）──
    // fetch 的禁止头名单改不了 Origin/Host，用 rawHttp（node:http 裸连）伪造真实头。
    const f1Bad = await rawHttp(def.port, "/api/projects/nope/tasks", { origin: "http://attacker.example", "content-type": "text/plain" }, "POST", "{}");
    ok(f1Bad.status === 403 && f1Bad.code === "ORIGIN_FORBIDDEN", `③ F1：text/plain 正文 + 恶意 Origin 的 CSRF POST → 403 ORIGIN_FORBIDDEN（实得 ${f1Bad.status} ${f1Bad.code}）`);
    const f1Shell = await rawHttp(def.port, "/api/projects/nope/tasks", { origin: SHELL_ORIGINS[0], "content-type": "application/json" }, "POST", "{}");
    ok(f1Shell.status === 404 && f1Shell.code === "PROJECT_NOT_FOUND", `③ F1：壳 origin 同一 POST → 过闸到业务层（${f1Shell.status} ${f1Shell.code}，不是 403）`);
    const f1Dyn = await rawHttp(def.port, "/api/projects/nope/tasks", { origin: "http://localhost:51999", "content-type": "application/json" }, "POST", "{}");
    ok(f1Dyn.status === 404, `③ F1：回环动态口 origin（vite 代理 changeOrigin 后的真实形态）→ 过闸到业务层（${f1Dyn.status}）`);
    const f1Host = await rawHttp(def.port, "/health", {}, "GET", "", "rebind.attacker.example");
    ok(f1Host.status === 403 && f1Host.code === "HOST_FORBIDDEN", `③ F1：Host=rebind.attacker.example 的 GET /health → 403 HOST_FORBIDDEN（DNS rebinding 防线；实得 ${f1Host.status} ${f1Host.code}）`);
    const f1Plain = await rawHttp(def.port, "/health", {});
    ok(f1Plain.status === 200, `③ F1：无 Origin 的 GET /health（curl / 健康探测形态）→ ${f1Plain.status}（非浏览器客户端零影响）`);
    // 从局域网地址再连一次：默认配置下必须连不上
    if (lanLess) {
      console.log("[verify]   ③ 局域网侧连通性：SKIP（本机没有非内部 IPv4）");
    } else {
      let lanRefused = false;
      let lanDetail = "";
      try {
        const r = await fetch(`http://${lanIp}:${def.port}/health`, { signal: AbortSignal.timeout(3000) });
        lanDetail = `竟然连上了：HTTP ${r.status}`;
      } catch (e) {
        lanRefused = true;
        lanDetail = (e as Error).cause ? String((e as Error).cause) : (e as Error).message;
      }
      ok(lanRefused, `③ 从局域网地址 http://${lanIp}:${def.port}/health 连 → 连不上（${lanDetail.slice(0, 90)}）`);
    }
    ok(
      !fs.existsSync(path.join(homeDefault, "remote")),
      "③ 默认关闭时**零 token 文件**（不开远程就不生成任何口令；口径见启动日志）",
    );

    // ═══════════════ ④ 开启远程（局域网 host）：HTTP 级三条拒绝路径 + 只读核心 ═══════════════
    info("④ 开启远程 + 只绑局域网 + 真实 HTTP 三条拒绝路径");
    const homeRemote = path.join(tmpBase, "home-remote");
    fs.mkdirSync(homeRemote, { recursive: true });
    const authFix = new AuthService({ dataDir: homeRemote, tokenTtlMs: 24 * 60 * 60 * 1000, sessionTtlMs: 60_000 });
    const remoteToken = authFix.ensureToken().record.token;
    console.log(`[verify]   夹具口令指纹 ${tokenFingerprint(remoteToken)}（原文不外打）`);
    const rem = await startServer("远程服务", lanHost, {
      TATAI_HOME: homeRemote,
      [REMOTE_ENABLE_ENV]: "1",
      [REMOTE_HOST_ENV]: lanHost,
    });
    live.push(rem);
    for (const line of rem.output().split(/\r?\n/).filter((l) => l.startsWith("[tatai-server]") || l.includes("[remote]"))) {
      console.log(`[verify]     ${line}`);
    }
    ok(rem.output().includes(`listening on http://${lanHost}:${rem.port}`), `④ 绑定日志：${lanHost}:${rem.port}`);
    ok(rem.output().includes("安全口径:"), "④ 启动日志逐条打出红线生效口径（reasons）");
    const remRows = netstatListeners(rem.port);
    console.log(`[verify]   netstat 原始行（绑局域网）：`);
    for (const r of remRows) console.log(`[verify]     ${r.raw}`);
    ok(
      remRows.some((r) => localAddressOf(r.local) === lanHost) && remRows.every((r) => localAddressOf(r.local) === lanHost || isLoopbackAddress(localAddressOf(r.local))),
      `④ 监听地址恰是显式给的 host ${lanHost}（实测 ${remRows.map((r) => localAddressOf(r.local)).join("、")}）`,
    );
    ok(
      !remRows.some((r) => localAddressOf(r.local) === "0.0.0.0" || localAddressOf(r.local) === "::"),
      "④ 没有一条监听行是通配地址（0.0.0.0 / :: 都没出现）",
    );

    const t1 = await http(rem.base, "/health");
    ok(t1.status === 401 && codeOf(t1) === "NO_TOKEN", `④ 拒绝路径① HTTP 无 token → ${t1.status} ${codeOf(t1)}`);
    const t2 = await http(rem.base, "/health", { token: generateToken() });
    ok(t2.status === 401 && codeOf(t2) === "BAD_TOKEN", `④ 拒绝路径② HTTP 错误 token → ${t2.status} ${codeOf(t2)}`);
    const t3 = await http(rem.base, "/health", { token: remoteToken });
    ok(t3.status === 200 && t3.body.ok === true, `④ 对照组 HTTP 正确 token → ${t3.status}（读通过）`);
    const t4 = await http(rem.base, "/api/projects/nope/tasks", { method: "POST", token: remoteToken, body: { id: "x", title: "x", module_id: "m", reporter: "r" } });
    ok(t4.status === 403 && codeOf(t4) === "REMOTE_READ_ONLY", `④ 只读为核心：写方法 POST + 正确 token → ${t4.status} ${codeOf(t4)}`);
    const t5 = await http(rem.base, "/api/summary/projects", { token: remoteToken });
    ok(t5.status === 200, `④ 只读方法经 token 放行（GET /api/summary/projects → ${t5.status}）`);
    const t5b = await http(rem.base, "/api/projects");
    ok(t5b.status === 401 && codeOf(t5b) === "NO_TOKEN", `④ 无 token 的读请求同样被拒（GET /api/projects → ${t5b.status} ${codeOf(t5b)}）`);

    // ── F1（2026-09-18 审计）HTTP 级 Origin/Host 闸（远程来源同样过闸；登录页语义不修死）──
    // rem 只绑局域网 IP：TCP 层连 lanHost（connectHost），Host/Origin 头按各自用例伪造。
    const f1rLogin = await rawHttp(rem.port, "/api/remote/login", { origin: `http://${lanHost}:${rem.port}`, authorization: `Bearer ${remoteToken}`, "content-type": "application/json" }, "POST", "{}", `${lanHost}:${rem.port}`, lanHost);
    ok(f1rLogin.status === 200, `④ F1：远程登录页同源 POST /api/remote/login → ${f1rLogin.status}（登录页是同源 fetch，没修死）`);
    const f1rCross = await rawHttp(rem.port, "/api/remote/login", { origin: "http://attacker.example", authorization: `Bearer ${remoteToken}`, "content-type": "application/json" }, "POST", "{}", `${lanHost}:${rem.port}`, lanHost);
    ok(f1rCross.status === 403 && f1rCross.code === "ORIGIN_FORBIDDEN", `④ F1：跨源表单打登录口 → ${f1rCross.status} ${f1rCross.code}`);
    const f1rHost = await rawHttp(rem.port, "/health", { authorization: `Bearer ${remoteToken}` }, "GET", "", "rebind.attacker.example", lanHost);
    ok(f1rHost.status === 403 && f1rHost.code === "HOST_FORBIDDEN", `④ F1：远程来源 + 非法 Host → ${f1rHost.status} ${f1rHost.code}（Host 闸对远程也生效）`);

    // 过期 token：把夹具口令文件改成"已过期"（服务端每次校验都重读文件）
    const stale = readTokenRecord(homeRemote)!;
    writeTokenRecord(homeRemote, { ...stale, expires_at: new Date(Date.now() - 60_000).toISOString() });
    const t6 = await http(rem.base, "/health", { token: remoteToken });
    ok(t6.status === 401 && codeOf(t6) === "EXPIRED_TOKEN", `④ 拒绝路径③ HTTP 过期 token → ${t6.status} ${codeOf(t6)}`);
    console.log("[verify]   服务端拒绝日志（[remote] 行；S3 起同一批拒绝另有审计流水 actor=remote/action=rejected，见 pnpm verify:s3）：");
    for (const line of rem.output().split(/\r?\n/).filter((l) => l.includes("[remote]"))) {
      console.log(`[verify]     ${line}`);
    }
    killTree(rem.proc, rem.port);
    await sleep(500);

    // 真·TTL 到点（不靠改文件，靠真实时钟走完 TTL）
    const homeTtl = path.join(tmpBase, "home-ttl");
    fs.mkdirSync(homeTtl, { recursive: true });
    const ttlMinutes = 0.08; // 4.8s
    const ttlSvc = await startServer("短 TTL 服务", lanHost, {
      TATAI_HOME: homeTtl,
      [REMOTE_ENABLE_ENV]: "1",
      [REMOTE_HOST_ENV]: lanHost,
      [REMOTE_TOKEN_TTL_ENV]: String(ttlMinutes),
    });
    live.push(ttlSvc);
    const shortToken = readTokenRecord(homeTtl)!.token;
    const s1r = await http(ttlSvc.base, "/health", { token: shortToken });
    await sleep(Math.round(ttlMinutes * 60_000) + 900);
    const s2r = await http(ttlSvc.base, "/health", { token: shortToken });
    console.log(
      `[verify]   TTL=${ttlMinutes} 分钟：刚到点 ${s1r.status} → 到点后 ${s2r.status} ${codeOf(s2r)}`,
    );
    ok(
      s1r.status === 200 && s2r.status === 401 && codeOf(s2r) === "EXPIRED_TOKEN",
      `④ TTL 真到点即失效（${ttlMinutes} 分钟配置 → 到期前 ${s1r.status}、到期后 ${s2r.status} ${codeOf(s2r)}）`,
    );
    killTree(ttlSvc.proc, ttlSvc.port);
    await sleep(400);

    // 写模式：双开关都给了，同一写请求不再被只读拦下（用"不过门就 403、过门后 404 项目不存在"区分）
    const homeWrite = path.join(tmpBase, "home-write");
    fs.mkdirSync(homeWrite, { recursive: true });
    const writeToken = new AuthService({ dataDir: homeWrite, tokenTtlMs: 3_600_000, sessionTtlMs: 60_000 })
      .ensureToken().record.token;
    const wr = await startServer("写模式服务", lanHost, {
      TATAI_HOME: homeWrite,
      [REMOTE_ENABLE_ENV]: "1",
      [REMOTE_HOST_ENV]: lanHost,
      [REMOTE_WRITE_ENV]: "1",
      [REMOTE_WRITE_CONFIRM_ENV]: WRITE_CONFIRM_PHRASE,
    });
    live.push(wr);
    ok(wr.output().includes("远程写模式已开启"), "④ 写模式启动日志有醒目警告（危险口径不静默）");
    const w1 = await http(wr.base, "/api/projects/nope/tasks", { method: "POST", token: writeToken, body: { id: "x", title: "x", module_id: "m", reporter: "r" } });
    ok(w1.status === 404 && codeOf(w1) === "PROJECT_NOT_FOUND", `④ 写模式放行写请求（过了门 → ${w1.status} ${codeOf(w1)}，不是 403 REMOTE_READ_ONLY）`);
    killTree(wr.proc, wr.port);
    await sleep(400);

    // ═══════════════ ⑤ 红线②/⑥：0.0.0.0、公网 IP、未开远程的非回环 host 一律拒 ═══════════════
    info("⑤ 危险 host 逐条证伪：拒得明确（exit 1 + 错误码），危险开关才放行且有警告");
    const caseWild = await startExpectReject("TATAI_HOST=0.0.0.0（未开远程）", { [REMOTE_HOST_ENV]: "0.0.0.0" });
    console.log(`[verify]   exit=${caseWild.code}`);
    for (const l of caseWild.out.split(/\r?\n/).filter((l) => l.includes("红线"))) console.log(`[verify]     ${l}`);
    ok(
      caseWild.code === 1 && caseWild.out.includes("WILDCARD_FORBIDDEN") && caseWild.out.includes("通配地址"),
      `⑤ TATAI_HOST=0.0.0.0 → 拒绝启动 exit=${caseWild.code}（WILDCARD_FORBIDDEN）`,
    );
    const caseWild2 = await startExpectReject("TATAI_HOST=0.0.0.0（开了远程，无危险开关）", {
      [REMOTE_ENABLE_ENV]: "1",
      [REMOTE_HOST_ENV]: "0.0.0.0",
    });
    ok(caseWild2.code === 1 && caseWild2.out.includes("WILDCARD_FORBIDDEN"), `⑤ 开了远程也一样拒（exit=${caseWild2.code}）——0.0.0.0 不是"开远程"的合法目标`);
    const casePublic = await startExpectReject("TATAI_HOST=8.8.8.8（公网）", {
      [REMOTE_ENABLE_ENV]: "1",
      [REMOTE_HOST_ENV]: "8.8.8.8",
    });
    ok(
      casePublic.code === 1 && casePublic.out.includes("PUBLIC_HOST_FORBIDDEN") && casePublic.out.includes("无 TLS"),
      `⑤ 公网 IP → 拒绝启动 exit=${casePublic.code}（PUBLIC_HOST_FORBIDDEN，附"不推荐公网直连"理由）`,
    );
    const caseNoRemote = await startExpectReject("TATAI_HOST=局域网 IP（未开远程）", { [REMOTE_HOST_ENV]: lanHost });
    ok(caseNoRemote.code === 1 && caseNoRemote.out.includes("HOST_REQUIRES_REMOTE"), `⑤ 非回环 host 但没开远程 → 拒绝启动 exit=${caseNoRemote.code}（HOST_REQUIRES_REMOTE）`);
    const caseWriteNoConfirm = await startExpectReject("写模式只给了一半开关", {
      [REMOTE_ENABLE_ENV]: "1",
      [REMOTE_HOST_ENV]: lanHost,
      [REMOTE_WRITE_ENV]: "1",
    });
    ok(
      caseWriteNoConfirm.code === 1 && caseWriteNoConfirm.out.includes("WRITE_CONFIRM_REQUIRED"),
      `⑤ 写模式缺二次确认 → 拒绝启动 exit=${caseWriteNoConfirm.code}（WRITE_CONFIRM_REQUIRED）`,
    );
    const caseBadFlag = await startExpectReject("TATAI_REMOTE=yes（含义不明）", { [REMOTE_ENABLE_ENV]: "yes" });
    ok(caseBadFlag.code === 1 && caseBadFlag.out.includes("REMOTE_FLAG_INVALID"), `⑤ 开关写法不明确（yes）→ 拒绝启动 exit=${caseBadFlag.code}（不猜用户想开还是想关）`);

    // ── F2（2026-09-18 审计）主机名/数字形式 IPv4 绑定的公网红线 ──────────────────────
    // 审计发现：TATAI_HOST=<主机名> 此前只给警告就放行——主机名解析到公网 A 记录等于绕过红线⑥；
    // 数字形式 IPv4（134744072 = 8.8.8.8）此前被当主机名，同样绕过。两条都收口：
    // 数字形式在 resolveRemoteConfig 同步路径归一后同码拒启动（真进程起一遍）；
    // 主机名的 DNS 判定脚本环境不依赖真实 DNS——用 remote-config 的可注入 resolve 钩子
    // （setHostnameResolverForTest）伪造解析结果，断言拒启动判定本身（手段在此注明）。
    const caseNumericPublic = await startExpectReject("TATAI_HOST=134744072（数字形式公网 = 8.8.8.8）", {
      [REMOTE_ENABLE_ENV]: "1",
      [REMOTE_HOST_ENV]: "134744072",
    });
    ok(
      caseNumericPublic.code === 1 && caseNumericPublic.out.includes("PUBLIC_HOST_FORBIDDEN"),
      `⑤ F2：数字形式公网 IP → 归一后同码拒启动 exit=${caseNumericPublic.code}（PUBLIC_HOST_FORBIDDEN，与点分写法同路径）`,
    );
    ok(
      classifyBindHost("3232235521") === "lan" && classifyBindHost("134744072") === "public",
      `⑤ F2：数字形式归一后正确分类（3232235521→192.168.1.1=lan · 134744072→8.8.8.8=public）`,
    );
    setHostnameResolverForTest(async () => ["203.0.113.10"]);
    let hostPublic = "";
    try {
      await assertBindHostnameSafe("rebind.example");
    } catch (e) {
      hostPublic = e instanceof RemoteConfigError ? e.code : "非 RemoteConfigError";
    }
    ok(
      hostPublic === "PUBLIC_HOST_FORBIDDEN",
      `⑤ F2：主机名解析出公网 A 记录（注入 resolve 钩子伪造，不做真实 DNS）→ PUBLIC_HOST_FORBIDDEN 拒启动（实得 ${hostPublic || "放行（错！）"}）`,
    );
    setHostnameResolverForTest(async () => ["192.168.1.5", "fd00::9"]);
    const safePrivate = await assertBindHostnameSafe("intranet.example");
    ok(
      safePrivate.resolved.join(",") === "192.168.1.5,fd00::9",
      `⑤ F2：解析全内网（IPv4 私网 + IPv6 ULA）→ 放行并返回解析证据（${safePrivate.resolved.join("、")}）`,
    );
    setHostnameResolverForTest(async () => {
      throw new Error("模拟 ENOTFOUND");
    });
    const safeNone = await assertBindHostnameSafe("nxdomain.example");
    ok(
      safeNone.resolved.length === 0,
      "⑤ F2：解析失败/无记录 → 不抛（维持仅警告口径，不新增拒绝路径）",
    );
    setHostnameResolverForTest(null);

    // 危险开关显式打开：能起，但日志醒目告警 + netstat 证明真的绑了通配地址
    info("⑤ 危险开关 TATAI_REMOTE_ALLOW_WILDCARD=1：明示风险后才允许绑 0.0.0.0");
    const homeWild = path.join(tmpBase, "home-wild");
    fs.mkdirSync(homeWild, { recursive: true });
    const wildSvc = await startServer(
      "通配服务（危险开关）",
      "0.0.0.0",
      {
        TATAI_HOME: homeWild,
        [REMOTE_ENABLE_ENV]: "1",
        [REMOTE_HOST_ENV]: "0.0.0.0",
        [REMOTE_WILDCARD_ENV]: "1",
      },
      { waitNeedle: "listening on http://0.0.0.0:" },
    );
    live.push(wildSvc);
    for (const l of wildSvc.output().split(/\r?\n/).filter((l) => l.includes("⚠"))) console.log(`[verify]     ${l}`);
    ok(wildSvc.output().includes("危险开关"), "⑤ 危险开关生效时日志有醒目 ⚠ 警告（放行是明示的，不是默认的）");
    const wildRows = netstatListeners(wildSvc.port);
    for (const r of wildRows) console.log(`[verify]     ${r.raw}`);
    ok(
      wildRows.some((r) => ["0.0.0.0", "::"].includes(localAddressOf(r.local))),
      `⑤ 危险开关下才真的绑通配地址（实测 ${wildRows.map((r) => localAddressOf(r.local)).join("、")}）——默认路径永远到不了这里`,
    );
    const wNoToken = await http("http://127.0.0.1:" + wildSvc.port, "/health");
    ok(wNoToken.status === 200, "⑤ 通配绑定下本机访问仍免 token（回环例外不变）");
    killTree(wildSvc.proc, wildSvc.port);
    await sleep(400);

    // ═══════════════ ⑥ 红线自查：token 不进仓库 ═══════════════
    info("⑥ 红线自查：口令文件不在 repo 内、仓库里没有口令原文");
    const tokenFiles = [tokenPathIn(homeRemote), tokenFilePath(homeRemote)];
    ok(new Set(tokenFiles).size === 1, `⑥ 口令路径口径唯一（auth.tokenPathIn ≡ remote-config.tokenFilePath → ${tokenFiles[0]}）`);
    ok(!isInsideRepo(tokenFiles[0], REPO_ROOT), `⑥ 口令文件不在 repo 内（${path.relative(REPO_ROOT, tokenFiles[0])}）`);
    ok(isInsideRepo(path.join(REPO_ROOT, ".工作台", "x.json"), REPO_ROOT), "⑥ 反向自检：repo 内路径会被判为「在 repo 内」（判定函数不是永远返回 false）");
    let gitGrepOut = "";
    try {
      gitGrepOut = execSync(`git grep -F -- "${remoteToken}"`, { cwd: REPO_ROOT, encoding: "utf8" });
    } catch (e) {
      gitGrepOut = `（无匹配：${(e as { status?: number }).status ?? "?"}）`;
    }
    ok(gitGrepOut.startsWith("（无匹配"), `⑥ 夹具口令在 git 跟踪的文件里零出现：${gitGrepOut.trim().slice(0, 60)}`);
    // 更强的口径：`git grep` 只看已跟踪文件，而本仓此刻有大量未提交/未跟踪目录——再对工作区真扫一遍
    // （跳过 node_modules/.工作台/dist/.git/构建产物），口令原文在工作区任何一份文件里出现都算泄露。
    const scan = scanRepoForSecret(remoteToken);
    ok(
      scan.hits.length === 0,
      `⑥ 工作区全仓扫描：口令原文零出现（扫了 ${scan.files} 个文本文件，命中 ${scan.hits.length} 个：${scan.hits.join("、") || "无"}）`,
    );
    const tokenNamed = scan.tokenNamedFiles;
    ok(
      tokenNamed.length === 0,
      `⑥ 工作区里没有 auth.json 这类口令文件（命中：${tokenNamed.join("、") || "无"}）`,
    );
    const status = execSync("git status --porcelain", { cwd: REPO_ROOT, encoding: "utf8" });
    const leaked = status.split(/\r?\n/).filter((l) => /auth\.json|\.tatai\/remote/i.test(l));
    ok(leaked.length === 0, `⑥ git status 里没有口令类文件（匹配行：${leaked.join(" | ") || "无"}）`);
    ok(fs.readFileSync(path.join(REPO_ROOT, ".gitignore"), "utf8").includes(".工作台/"), "⑥ .gitignore 仍含 .工作台/（repo 只出代码 + 空模板，依据 §8.2/§8.3）");
    const fixturePathShown = path.relative(REPO_ROOT, tokenFiles[0]).replace(/\\/g, "/");
    ok(
      path.isAbsolute(fixturePathShown) || fixturePathShown.startsWith(".."),
      `⑥ 夹具数据目录在 repo 外（跨盘时 path.relative 直接给绝对路径，同样算"在外面"：${fixturePathShown.slice(0, 40)}…）`,
    );

    // ═══════════════ 收尾 ═══════════════
    info("⑦ 收尾：进程杀净 / 端口释放 / 8787+5173 仍是别人的");
    for (const svc of live) {
      killTree(svc.proc, svc.port);
    }
    await sleep(800);
    for (const svc of live) {
      ok(!(await portListening(svc.port, svc.host)), `⑦ 端口 ${svc.port}（${svc.host}）已释放`);
    }
    const fixedAfter = { v: await portListening(8787), d: await portListening(5173) };
    ok(
      fixedAfter.v === fixedBefore.v && fixedAfter.d === fixedBefore.d,
      `⑦ 8787/5173 状态与开跑前一致（${fixedBefore.v}→${fixedAfter.v} / ${fixedBefore.d}→${fixedAfter.d}）——没碰别人的监听`,
    );
  } finally {
    for (const svc of live) killTree(svc.proc, svc.port);
    await sleep(500);
    fs.rmSync(tmpBase, { recursive: true, force: true });
    console.log(`[verify]   临时数据目录已清理：${tmpBase}`);
  }

  console.log(
    `\n[verify] ── S1 结论：${process.exitCode ? "存在 FAIL，见上方逐条" : "全部 PASS"}`,
  );
}

main().catch((e: Error) => {
  console.error("[verify] 脚本异常：", e);
  process.exitCode = 1;
});
