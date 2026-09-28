// S2 验证脚本（用 tsx 跑）：只读远程模式的接口级验证。用法：pnpm verify:s2
//
// 覆盖点（逐条对 PLAN.md S2 卡 DoD）：
//   ① DoD①「局域网内另一台设备只读查看四样」：**本机没有第二台设备**——用"本机经**真实局域网 IP**
//      + 真实 token 访问"作最强近似（服务端只绑该局域网 IP，所以服务端看到的来源就是非回环，
//      走的就是远程口径），并**额外真开一次 Chromium**（python playwright）把页面点一遍。
//      覆盖与未覆盖在脚本末尾如实打印，不假装有第二台设备。
//   ② DoD②「所有写接口在只读模式下返回拒绝」：按 `src/server/remote-routes.ts` 的路由-方法清单
//      **逐条**打（每个写路由贴返回码与错误码），并做**源码级防漂移对账**（清单提及数 == index.ts
//      里扫出来的 `req.method === "…"` 数，差一条就 FAIL）——新增路由漏登记必然被抓住。
//   ③ DoD③「会话有效期与登出」：口令换会话（HTTP 级）→ 会话到期自动失效（真等 TTL 到点）→
//      登出立刻失效（贴 200 → 401 对照）；另加口令错误计数与退避（429 LOGIN_THROTTLED + retry-after）。
//   ④ DoD④「只传必要数据 / 聊天全文默认不外泄」：聊天读默认 403 REMOTE_CHAT_HIDDEN（两种状态对照：
//      `TATAI_REMOTE_CHAT=1` 才 200），远程读响应里不含本机绝对路径（本机回环对照仍在）。
//   另：S1 口径回归——本机回环仍免 token、默认关闭仍只绑回环、无/错/过期 token 三条路径仍 401、
//   默认配置不生成口令文件。
//
// 端口策略（照 verify-s1/p2/p3 写法）：**不碰任何既有监听**——每个服务用动态空闲端口，起前探活、
// 起后盯子进程早退；开头末尾各探一次 8787/5173（只记录，不杀别人的进程）。
// 环境隔离：子进程 env 里先清掉所有 TATAI_REMOTE*/TATAI_HOST 再按用例注入。
// 隐私（AGENTS.md §5/§6）：临时 TATAI_HOME、夹具项目、口令全在 os.tmpdir()；口令只打指纹不打原文。
import { execSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AuthService,
  LOGIN_FAILURE_WINDOW_MS,
  LOGIN_LOCKOUT_MS,
  LOGIN_MAX_FAILURES,
  PUBLIC_PATHS,
  READ_ONLY_EXEMPT_PATHS,
  SESSION_ID_PREFIX,
  credentialFromHeader,
  generateToken,
  guardRemoteRequest,
  isChatReadPath,
  isPublicPath,
  isReadOnlyExemptPath,
  isReadMethod,
  requestPathOf,
  tokenFingerprint,
  tokenPathIn,
  writeTokenRecord,
  type TokenRecord,
} from "../src/server/auth";
import {
  READ_ONLY_METHODS,
  REMOTE_CHAT_ENV,
  REMOTE_ENABLE_ENV,
  REMOTE_HOST_ENV,
  REMOTE_SESSION_TTL_ENV,
  REMOTE_WRITE_CONFIRM_ENV,
  REMOTE_WRITE_ENV,
  WRITE_CONFIRM_PHRASE,
  READ_ONLY_METHODS as READ_METHODS,
  checkRedlines,
  isLoopbackAddress,
  lanAddresses,
  resolveRemoteConfig,
  tokenFilePath,
} from "../src/server/remote-config";
import {
  REMOTE_PUBLIC_ROUTES,
  REMOTE_ROUTES,
  REMOTE_SESSION_ROUTES,
  REMOTE_WRITE_ROUTES,
  ROUTE_MENTION_EXCLUSIONS,
  routeMentionCounts,
  routeMentionTotal,
  type RemoteRoute,
} from "../src/server/remote-routes";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_ENTRY = path.join("src", "server", "index.ts");

const ok = (cond: boolean, label: string) => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (!cond) process.exitCode = 1;
};
const info = (label: string) => console.log(`[verify] ---- ${label}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** ④ 页面 UI 段是否被跳过（环境性 SKIP 要进结论行与退出码，不能当全过） */
let remoteUiSkipped = false;

/** 从本机 TCP 探测一个已绑定地址是否真可达（短超时；用于"本机连不到自己的局域网地址"这类环境判定） */
function lanSelfReachable(base: string): Promise<boolean> {
  const u = new URL(base);
  return new Promise((resolve) => {
    const sock = net.connect({ host: u.hostname, port: Number(u.port || 80) });
    const done = (v: boolean): void => {
      sock.removeAllListeners();
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(3000);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
  });
}

// ───────────────────────────── 端口 / 进程（与 verify-s1 同一套）─────────────────────────────

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

/** 子进程 env：先清干净远程相关变量，再按用例注入 */
function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of [
    REMOTE_ENABLE_ENV,
    REMOTE_HOST_ENV,
    REMOTE_CHAT_ENV,
    REMOTE_SESSION_TTL_ENV,
    "TATAI_REMOTE_WRITE",
    "TATAI_REMOTE_WRITE_CONFIRM",
    "TATAI_REMOTE_ALLOW_WILDCARD",
    "TATAI_REMOTE_TOKEN_TTL_MINUTES",
    "TATAI_HOME",
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
}

async function startServer(
  label: string,
  host: string,
  env: Record<string, string>,
  opts: { timeoutMs?: number } = {},
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
  };
  const needle = `listening on http://${host}:${port}`;
  // Q5（2026-09-18 审计）：远程模式下口令文件是在 listen 回调里才落的（`ensureToken()` 排在
  // "listening on" 那行日志之后），所以"日志可见 + 端口在听"不等于"auth.json 已可读"——
  // 实测缺口 1–2ms。段⑧ 拿**全新空目录**起服务后立刻读 auth.json，此前会 ENOENT 崩在 fs.readFileSync
  // （偶发竞争）。就绪判据补上"口令文件已落盘"：给了 TATAI_HOME 且开了远程时，文件出现才算就绪。
  const tokenFile =
    env[REMOTE_ENABLE_ENV] === "1" && env.TATAI_HOME ? path.join(env.TATAI_HOME, "remote", "auth.json") : null;
  const deadline = Date.now() + (opts.timeoutMs ?? 90_000);
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${label} 启动即退出（code=${child.exitCode}）：\n${buf}`);
    if (
      buf.includes(needle) &&
      (await portListening(port, host)) &&
      (tokenFile === null || fs.existsSync(tokenFile))
    ) {
      return svc;
    }
    await sleep(150);
  }
  killTree(child, port);
  throw new Error(`${label} 未就绪（等 "${needle}"${tokenFile ? " + 口令文件落盘" : ""} 超时）：\n${buf}`);
}

/** netstat 里监听某端口的原始行（Windows：netstat -ano；其余平台如实 SKIP） */
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

function localAddressOf(local: string): string {
  const cut = local.lastIndexOf(":");
  return local.slice(0, cut).replace(/^\[|\]$/g, "");
}

// ───────────────────────────── HTTP 助手 ─────────────────────────────

interface HttpResult {
  status: number;
  body: { ok?: boolean; error?: { code?: string; message?: string } } & Record<string, unknown>;
  text: string;
  headers: Headers;
}

async function http(
  base: string,
  pathName: string,
  opts: { method?: string; credential?: string | null; body?: unknown; timeoutMs?: number } = {},
): Promise<HttpResult> {
  const headers: Record<string, string> = {};
  if (opts.credential) headers.authorization = `Bearer ${opts.credential}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${base}${pathName}`, {
    method: opts.method ?? "GET",
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 8000),
  });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { raw: text };
  }
  return { status: res.status, body: body as HttpResult["body"], text, headers: res.headers };
}

const codeOf = (r: HttpResult) => r.body.error?.code ?? "(无 error.code)";

/** 路由表里的路径模板 → 可打地址（`:id` / `:sid` / `:taskId` / `:moduleId` 一律填夹具值） */
function routeUrl(route: RemoteRoute, projectId: string): string {
  const p = route.path
    .replace(":id", projectId)
    .replace(":sid", "remote-probe-sid")
    .replace(":taskId", "t1")
    .replace(":moduleId", "src");
  return route.query ? `${p}?${route.query.replace(":id", projectId)}` : p;
}

// ───────────────────────────── 夹具（全在 os.tmpdir()）─────────────────────────────

interface Fixture {
  home: string;
  proj: string;
  projectId: string;
  projectName: string;
  chatSessionId: string;
  chatSecret: string;
  designTitle: string;
  discussEntry: string;
}

function buildFixture(base: string): Fixture {
  const home = path.join(base, "home");
  const proj = path.join(base, "proj");
  const wb = path.join(proj, ".工作台");
  const projectName = "S2 夹具项目";
  const chatSessionId = "s2-fixture-session";
  const chatSecret = "聊聊天的机密内容：默认不许下发到远程设备";
  const designTitle = "# 塔台 S2 夹具项目设计书";
  const discussEntry = "- `2026-09-18` 待议样条：远程只读口径必须逐接口验证";
  fs.rmSync(base, { recursive: true, force: true });
  fs.mkdirSync(path.join(wb, "arch"), { recursive: true });
  fs.mkdirSync(path.join(wb, "chat"), { recursive: true });
  fs.mkdirSync(path.join(wb, "logs"), { recursive: true });
  fs.mkdirSync(path.join(home, "remote"), { recursive: true });
  const iso = (ms: number) => new Date(ms).toISOString();
  const now = Date.now();

  fs.writeFileSync(
    path.join(home, "registry.json"),
    JSON.stringify(
      {
        version: 1,
        projects: [
          {
            id: "s2fix",
            name: projectName,
            path: proj,
            kind: "fullstack",
            registered_at: iso(now - 86_400_000),
            last_opened_at: iso(now - 3_600_000),
          },
        ],
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(path.join(wb, "design.md"), `${designTitle}\n\n## 1. 是什么\n远程只读验证用的最小夹具。\n`);
  fs.writeFileSync(path.join(wb, "design.discuss.md"), `${discussEntry}\n`);
  fs.writeFileSync(
    path.join(wb, "progress.json"),
    JSON.stringify(
      {
        version: 1,
        gate: {
          current_step: "develop",
          history: [{ step: "kickoff", result: "pass", at: iso(now - 500_000), note: null }],
        },
        modules: [
          { id: "src", name: "源码模块", status: "doing" },
          { id: "docs", name: "文档模块", status: "done" },
        ],
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(wb, "gate.jsonl"),
    [
      JSON.stringify({ ts: iso(now - 600_000), step: "kickoff", result: "pass", by: "user", note: null }),
      JSON.stringify({ ts: iso(now - 500_000), step: "requirement", result: "pass", by: "user", note: "夹具样条" }),
    ].join("\n") + "\n",
  );
  fs.writeFileSync(
    path.join(wb, "tasks.json"),
    JSON.stringify(
      {
        version: 1,
        tasks: [
          { id: "t1", title: "夹具任务", module_id: "src", status: "doing", reporter: "agent", updated_at: iso(now) },
        ],
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(wb, "arch/modules.json"),
    JSON.stringify(
      {
        version: 1,
        generated_at: iso(now - 400_000),
        modules: [
          { id: "root", name: "", path: ".", file_count: 1, loc: 10, deps: [{ to: "src", weight: 2 }] },
          { id: "src", name: "", path: "src", file_count: 3, loc: 120, deps: [{ to: "docs", weight: 1 }] },
          { id: "docs", name: "", path: "docs", file_count: 2, loc: 40, deps: [] },
        ],
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(wb, "arch/names.json"),
    JSON.stringify(
      {
        version: 1,
        entries: {
          src: { name: "夹具源码主模块", blurb: "样条", kind: "code", named_at: iso(now - 300_000), signature: "x" },
        },
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(wb, "chat", `${chatSessionId}.jsonl`),
    [
      JSON.stringify({ role: "user", content: chatSecret, ts: iso(now - 200_000) }),
      JSON.stringify({ role: "assistant", content: "收到（夹具回复）", ts: iso(now - 190_000), model: "flash" }),
    ].join("\n") + "\n",
  );
  return { home, proj, projectId: "s2fix", projectName, chatSessionId, chatSecret, designTitle, discussEntry };
}

// ───────────────────────────── 源码级护栏 ─────────────────────────────

const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

/** 源码里所有 `req.method === "X"` 提及（剥注释后按方法计数） */
function scanMethodMentions(code: string): Record<string, number> {
  const counts: Record<string, number> = {};
  const re = /req\.method === "(GET|POST|PUT|DELETE|OPTIONS)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) counts[m[1]] = (counts[m[1]] ?? 0) + 1;
  return counts;
}

/** 锚点比对前把空白折叠（源码里的多行条件 —— 如 /api/changes/all —— 也要能一字比对） */
const normalizeWs = (s: string) => s.replace(/\s+/g, " ").trim();

function countOccurrences(haystack: string, needle: string): number {
  let n = 0;
  let idx = haystack.indexOf(needle);
  while (idx >= 0) {
    n++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return n;
}

/** 源码（剥注释 + 折叠空白）里某锚点的命中次数 */
function anchorHits(code: string, anchor: string): number {
  return countOccurrences(normalizeWs(code), normalizeWs(anchor));
}

/** 内嵌的 python playwright 页面验证脚本（运行时落到临时目录，仓库里只有这一份来源） */
const S2_PAGE_SHOT_PY = "# S2 UI 验证：远程只读页面（真 Chromium 打开局域网地址 → 填口令 → 逐页签读四样 → 登出）\n# 用法：python s2-page-shot.py <baseUrl> <token> <projectId> <projectName> <designNeedle> <chatExposed:0|1> <outDir>\n#\n# 为什么值得单跑一趟浏览器：页面（src/server/remote-page.ts）是 S2 新增的唯一界面，\n# 它的\"能不能用\"必须被真开一次证明——HTTP 层只能证明接口拒绝/放行，证明不了页面把数据画出来了。\n# 浏览器连的就是局域网地址（服务端只绑该地址），所以服务端看到的来源是非回环 → 走的就是远程口径。\nimport sys\n\nfrom playwright.sync_api import sync_playwright\n\nBASE, TOKEN, PID = sys.argv[1], sys.argv[2], sys.argv[3]\nNAME, DESIGN, CHAT, OUT = sys.argv[4], sys.argv[5], sys.argv[6] == \"1\", sys.argv[7]\nfails = []\ntotal = [0]\n\n\ndef ok(cond, label):\n    total[0] += 1\n    print((\"[UI PASS] \" if cond else \"[UI FAIL] \") + label)\n    if not cond:\n        fails.append(label)\n\n\nwith sync_playwright() as p:\n    # --no-proxy-server（2026-09-20 裁定 4）：本机系统代理开着时（ProxyEnable=1 → 127.0.0.1:7897，绕过表里没有 172.20.10.2），\n    # Chromium 会把连**局域网地址**的请求塞给代理、拿回 502 Bad Gateway，于是\"登录页可达且显示登录表单\"这条恒红；\n    # 同一地址 curl 是 200、页面里 id=\"login-card\" 也在。只给这个页面验证用的 Chromium 关代理：\n    # 连的地址、判据与失败退出码一律不变——这是**测试环境**改动，不是产品判据变化。\n    # V08-01（测试欠账 ③）：只给 --no-proxy-server 在本机**不够**——实测仍走系统代理拿回 502（同进程 python 不走代理是 200；换 direct:// 后 Chromium 真拿到 200 并画出 login-card）。地址、判据与失败退出码一律不变，属**测试环境**改动，不是产品判据变化。\n    browser = p.chromium.launch(args=[\"--no-proxy-server\", \"--proxy-server=direct://\", \"--proxy-bypass-list=*\"])\n    page = browser.new_page(viewport={\"width\": 1280, \"height\": 900})\n    page.goto(BASE + \"/\", wait_until=\"load\")\n    ok(page.locator(\"#login-card\").is_visible(), \"登录页可达且显示登录表单（免凭据拿到页面本体）\")\n    ok(DESIGN not in page.inner_text(\"body\"), \"页面本体不含任何项目数据（登录前拿不到一字节内容）\")\n    ok(page.locator(\"#viewer\").is_hidden(), \"未登录时只读视图不显示\")\n\n    # 错口令：先看错误提示有没有把拒绝码摆出来（同时见证远程来源的错误路径）\n    page.fill(\"#token\", \"wrong-token-0000000000000000000000000000000000\")\n    page.click(\"#login\")\n    page.wait_for_timeout(700)\n    msg = page.inner_text(\"#msg\")\n    ok(\"401\" in msg and \"BAD_TOKEN\" in msg, \"浏览器里填错口令 → 页面摆出 401 BAD_TOKEN：\" + msg.strip()[:80])\n\n    # 正确口令换会话\n    page.fill(\"#token\", TOKEN)\n    page.click(\"#login\")\n    page.wait_for_selector(\"#projects li\", timeout=20000)\n    page.wait_for_timeout(600)\n    ok(page.locator(\"#viewer\").is_visible(), \"口令换会话成功 → 只读视图显示\")\n    ok(\"会话剩余\" in page.inner_text(\"#session-info\"), \"会话有效期在页面上可见：\" + page.inner_text(\"#session-info\").strip())\n    ok(NAME in page.inner_text(\"#projects\"), \"项目列表读出来了（GET /api/projects）：\" + page.inner_text(\"#projects\").replace(\"\\n\", \" / \")[:60])\n\n    def tab(label):\n        page.click(\"#tabs button:has-text('%s')\" % label)\n        page.wait_for_timeout(1000)\n        return page.inner_text(\"#panel\")\n\n    ok(DESIGN in page.inner_text(\"#panel\"), \"① 设计书页签：读到设计书全文\")\n    d = tab(\"待议\")\n    ok(\"待议样条\" in d, \"② 待议页签：读到待议记录\")\n    a = tab(\"架构图数据\")\n    ok(\"夹具源码主模块\" in a and \"依赖边\" in a, \"③ 架构图页签：节点名与依赖边都画出来了\")\n    g = tab(\"Gate 时间线\")\n    ok(\"develop\" in g and \"kickoff\" in g, \"④ Gate 时间线页签：当前步与 gate 流水都画出来了\")\n    page.screenshot(path=OUT, full_page=True)\n    print(\"[UI] 截图：\" + OUT)\n\n    tabs = page.inner_text(\"#tabs\")\n    if CHAT:\n        ok(\"聊天\" in tabs, \"聊天开关打开时页签里出现「聊天」\")\n        tab(\"聊天\")\n    else:\n        ok(\"聊天\" not in tabs, \"聊天开关默认关闭时**页面上没有聊天页签**（接口层的 403 另证）\")\n\n    # 登出：回到登录表单\n    page.click(\"#logout\")\n    page.wait_for_timeout(800)\n    ok(page.locator(\"#login-card\").is_visible() and page.locator(\"#viewer\").is_hidden(),\n       \"点「登出」→ 回到登录表单，只读视图关闭\")\n    ok(\"已登出\" in page.inner_text(\"#msg\"), \"登出有明确回执：\" + page.inner_text(\"#msg\").strip()[:70])\n    browser.close()\n\nprint(\"[UI] S2 页面小结：%d 条断言，%d 条 FAIL\" % (total[0], len(fails)))\nsys.exit(1 if fails else 0)\n";

// ───────────────────────────── 主流程 ─────────────────────────────

async function main(): Promise<void> {
  console.log("[verify] S2 只读远程模式：只读四样 / 写接口逐条拒绝 / 会话与登出 / 聊天不外泄");
  console.log(`[verify]   node ${process.version} · ${process.platform} · repo ${REPO_ROOT}`);
  const fixedBefore = { v: await portListening(8787), d: await portListening(5173) };
  console.log(
    `[verify]   8787 ${fixedBefore.v ? "有人监听（别人的，不碰）" : "空闲"} · 5173 ${fixedBefore.d ? "有人监听（别人的，不碰）" : "空闲"}`,
  );
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-s2-verify-"));
  const lanAll = lanAddresses();
  const lanIp = lanAll[0]?.address ?? null;
  console.log(
    `[verify]   本机局域网地址：${lanAll.map((a) => `${a.address}(${a.iface})`).join("、") || "（无）"}`,
  );
  const lanHost = lanIp ?? "127.0.0.1";
  if (lanIp === null) {
    console.log(
      "[verify]   ⚠ 本机没有非内部 IPv4：远程段改用回环地址起服务（服务端会把来源当本机放行），" +
        "**真实局域网段 SKIP**——这部分结论不可当「远程已实测」用",
    );
  }
  const fixture = buildFixture(path.join(tmpBase, "fx"));
  console.log(
    `[verify]   夹具：home=${fixture.home}（临时）· 项目 ${fixture.projectId} · 聊天会话 ${fixture.chatSessionId}`,
  );

  const live: Svc[] = [];
  try {
    // ═══════════════ ① 红线活体对照 + 源码级护栏 ═══════════════
    info("① 红线逐条对照代码常量（remote-config.ts 活体自查，S1 六条 + S2 第七条）");
    const checks = checkRedlines();
    for (const c of checks) {
      ok(c.pass, `① [${c.id}] ${c.title} ｜ 锚点 ${c.anchor} ｜ 依据 ${c.design} ｜ 实测 ${c.detail}`);
    }
    ok(
      checks.some((c) => c.id === "R7" && c.pass),
      "① 第七条红线「聊天全文默认不外泄」在代码常量里（S2 DoD④）",
    );

    info("① 源码级护栏（红线不能只靠运行期一跑）");
    const indexSrc = fs.readFileSync(path.join(REPO_ROOT, SERVER_ENTRY), "utf8");
    const indexCode = stripComments(indexSrc);
    const authSrc = fs.readFileSync(path.join(REPO_ROOT, "src/server/auth.ts"), "utf8");
    const pageSrc = fs.readFileSync(path.join(REPO_ROOT, "src/server/remote-page.ts"), "utf8");
    const guardIdx = indexSrc.indexOf("guardRemoteRequest(remoteConfig");
    const routeIdx = indexSrc.indexOf('req.url?.match(/^\\/api\\/projects');
    ok(
      guardIdx > 0 && routeIdx > 0 && guardIdx < routeIdx,
      `① index.ts 仍是「先鉴权后路由」（guard@${guardIdx} < 路由@${routeIdx}）`,
    );
    ok(
      indexSrc.includes("path: reqPath") && indexSrc.includes("requestPathOf(req.url)"),
      "① 放行口拿到了请求路径（否则聊天闸门/登录页免凭据/会话例外三条都成了死代码）",
    );
    ok(
      (READ_ONLY_METHODS as readonly string[]).includes("GET") && READ_ONLY_METHODS.length === 3,
      `① 只读方法集合口径未动：${READ_METHODS.join("/")}`,
    );
    ok(
      authSrc.includes("READ_ONLY_EXEMPT_PATHS") && authSrc.includes("PUBLIC_PATHS") && authSrc.includes("isChatReadPath"),
      "① auth.ts 里三条 S2 路径判定（会话例外 / 免凭据静态入口 / 聊天读）各有常量与函数",
    );
    ok(
      (pageSrc.match(/method: "POST"/g) ?? []).length === 2 &&
        !pageSrc.includes('method: "PUT"') &&
        !pageSrc.includes('method: "DELETE"'),
      "① 只读页面只发两处 POST（login/logout），没有任何 PUT/DELETE 调用（界面层不可能误写）",
    );
    ok(
      !fs.readFileSync(path.join(REPO_ROOT, "src/ui/api.ts"), "utf8").includes("remote/session") &&
        !fs.readFileSync(path.join(REPO_ROOT, "src/ui/App.tsx"), "utf8").includes("remote/login"),
      "① 桌面/浏览器主界面（src/ui）零改动痕迹：没有第二套业务 UI，远程视图只在服务端一张 HTML 里",
    );

    // ═══════════════ ② 路由-方法清单：与 index.ts 源码对账（防漂移）═══════════════
    info("② 路由-方法清单对账（清单 = remote-routes.ts；真值 = index.ts 源码扫描）");
    // 登记（2026-09-21，C017 用量统计）：本次新增只读路由 GET /api/projects/:id/work/usage，
    // 按 V06-08 先例在 remote-routes.ts 清单里登记 work-usage 一条（期望值 = 清单推导，即"新真实计数"）；
    // 本脚本没有任何硬编码计数可改，判据照旧是「清单提及数 == index.ts 源码扫描数，差一条就 FAIL」，
    // 未放宽、未删除任何既有断言。
    for (const r of REMOTE_ROUTES) {
      for (const a of r.anchors) {
        const n = anchorHits(indexCode, a);
        ok(n === 1, `② 清单锚点唯一 [${r.id}] ${a.slice(0, 64)}${a.length > 64 ? "…" : ""} → 命中 ${n} 次`);
      }
    }
    const scanned = scanMethodMentions(indexCode);
    const expected = routeMentionCounts();
    const exclusionMentions = ROUTE_MENTION_EXCLUSIONS.reduce(
      (n, e) => n + anchorHits(indexCode, e.anchor),
      0,
    );
    const readRoutes = REMOTE_ROUTES.filter((r) => r.kind === "read");
    console.log(
      `[verify]   清单：${REMOTE_ROUTES.length} 条路由（读 ${readRoutes.length} / ` +
        `写 ${REMOTE_WRITE_ROUTES.length} / 会话 ${REMOTE_SESSION_ROUTES.length} / 静态入口 ${REMOTE_PUBLIC_ROUTES.length}），` +
        `提及数 ${routeMentionTotal()}；源码扫出 ${Object.entries(scanned).map(([k, v]) => `${k} ${v}`).join(" · ")}`,
    );
    for (const verb of ["GET", "POST", "PUT", "DELETE"] as const) {
      ok(
        (scanned[verb] ?? 0) === expected[verb],
        `② ${verb} 提及数一致：源码 ${scanned[verb] ?? 0} == 清单 ${expected[verb]}` +
          (verb === "GET" || verb === "POST" ? "（新增路由漏登记会在这里红）" : ""),
      );
    }
    ok(
      (scanned.OPTIONS ?? 0) === exclusionMentions && exclusionMentions >= 1,
      `② 唯一排除项是 CORS 预检（OPTIONS ${scanned.OPTIONS ?? 0} 处 = 排除清单 ${exclusionMentions} 处：${ROUTE_MENTION_EXCLUSIONS[0].reason}）`,
    );
    for (const r of REMOTE_ROUTES) {
      const inAnchors = r.anchors.reduce((n, a) => n + (scanMethodMentions(a)[r.method] ?? 0), 0);
      ok(
        inAnchors === (r.mentions ?? 1),
        `② 条目 [${r.id}] 的提及数与锚点吻合（锚点里 ${r.method} ${inAnchors} 处 = 登记 ${r.mentions ?? 1}）`,
      );
    }
    ok(
      REMOTE_SESSION_ROUTES.filter((r) => !isReadMethod(r.method)).length === READ_ONLY_EXEMPT_PATHS.length &&
        REMOTE_SESSION_ROUTES.filter((r) => !isReadMethod(r.method)).every((r) =>
          (READ_ONLY_EXEMPT_PATHS as readonly string[]).includes(r.path),
        ) &&
        (READ_ONLY_EXEMPT_PATHS as readonly string[]).every((p) => isReadOnlyExemptPath(p)) &&
        !isReadOnlyExemptPath("/api/remote/session"),
      `② 只读豁免只给会话生命周期里的**写方法**（GET /api/remote/session 走读方法关，不需豁免）：清单 ${REMOTE_SESSION_ROUTES.filter((r) => !isReadMethod(r.method))
        .map((r) => `${r.method} ${r.path}`)
        .join("、")} == auth.ts ${READ_ONLY_EXEMPT_PATHS.join("、")}`,
    );
    const publicPaths = REMOTE_PUBLIC_ROUTES.flatMap((r) => [r.path, ...(r.altPaths ?? [])]);
    ok(
      publicPaths.length === PUBLIC_PATHS.length &&
        publicPaths.every((p) => (PUBLIC_PATHS as readonly string[]).includes(p)) &&
        (PUBLIC_PATHS as readonly string[]).every((p) => isPublicPath(p)),
      `② 免凭据静态入口两边一致：清单 ${publicPaths.join("、")} == auth.ts ${PUBLIC_PATHS.join("、")}`,
    );
    const chatReadPathRoutes = REMOTE_ROUTES.filter((r) => r.kind === "read" && isChatReadPath(r.path));
    ok(
      chatReadPathRoutes.length === 2 &&
        chatReadPathRoutes.map((r) => r.id).sort().join(",") === "chat-session-read,chat-sessions-list",
      `② 聊天读路径只有两条且被闸门函数认出来：${chatReadPathRoutes.map((r) => `${r.method} ${r.path}`).join("、")}`,
    );
    console.log("[verify]   写接口拒绝清单（DoD② 的遍历集，共 " + REMOTE_WRITE_ROUTES.length + " 条）：");
    for (const r of REMOTE_WRITE_ROUTES) {
      console.log(`[verify]     ${r.method.padEnd(6)} ${routeUrl(r, fixture.projectId).padEnd(52)} ${r.note}`);
    }

    // ═══════════════ ③ 单元级：会话 / 退避 / 路径判定 ═══════════════
    info("③ 单元级（注入时钟）：会话 TTL / 登出 / 口令错误退避 / 路径判定表");
    let clockNow = new Date("2026-09-18T10:00:00+08:00");
    const unitHome = path.join(tmpBase, "home-unit");
    fs.mkdirSync(unitHome, { recursive: true });
    const authUnit = new AuthService({
      dataDir: unitHome,
      tokenTtlMs: 24 * 60 * 60 * 1000,
      sessionTtlMs: 10 * 60_000,
      now: () => clockNow,
    });
    const unitToken = authUnit.ensureToken().record.token;
    console.log(`[verify]   单元夹具口令指纹 ${tokenFingerprint(unitToken)}（原文不外打）`);
    const s1 = authUnit.createSession(unitToken, "192.168.1.50");
    ok(
      s1.session_id.startsWith(SESSION_ID_PREFIX) && authUnit.verifySession(s1.session_id).ok === true,
      `③ 口令换会话：${s1.session_id.slice(0, 6)}…（${s1.session_id.length} 字符），校验通过`,
    );
    ok(authUnit.logout(s1.session_id) && !authUnit.verifySession(s1.session_id).ok, "③ 登出后同一会话立刻失效（单元级）");
    const s2u = authUnit.createSession(unitToken);
    clockNow = new Date(clockNow.getTime() + 10 * 60_000 + 1000);
    const s2v = authUnit.verifySession(s2u.session_id);
    ok(!s2v.ok && s2v.reason === "SESSION_EXPIRED", `③ 会话到期自动失效（时钟 +10min）→ ${s2v.ok ? "放过（错！）" : s2v.reason}`);
    clockNow = new Date("2026-09-18T10:00:00+08:00");

    const state0 = authUnit.throttleState("10.0.0.9");
    let lastState = state0;
    const seq: string[] = [];
    for (let i = 1; i <= LOGIN_MAX_FAILURES; i++) {
      lastState = authUnit.noteFailure("10.0.0.9");
      seq.push(`${i}次→${lastState.locked ? "锁" : `${lastState.failures}/${LOGIN_MAX_FAILURES}`}`);
    }
    ok(state0.locked === false && state0.failures === 0, "③ 退避计数起点干净（0 次、未锁）");
    ok(
      lastState.locked && lastState.retryAfterMs === LOGIN_LOCKOUT_MS,
      `③ 连错 ${LOGIN_MAX_FAILURES} 次即锁门（序列 ${seq.join(" ")}，退避 ${LOGIN_LOCKOUT_MS / 1000}s）`,
    );
    authUnit.clearFailures("10.0.0.9");
    ok(authUnit.throttleState("10.0.0.9").locked === false, "③ 校验通过即清零（好口令不被此前的错口令连坐）");
    authUnit.noteFailure("10.0.0.10");
    clockNow = new Date(clockNow.getTime() + LOGIN_FAILURE_WINDOW_MS + 1000);
    ok(
      authUnit.throttleState("10.0.0.10").failures === 0,
      `③ 计数窗口滑过自动清零（窗口 ${LOGIN_FAILURE_WINDOW_MS / 60_000} 分钟）`,
    );
    clockNow = new Date("2026-09-18T10:00:00+08:00");

    ok(
      requestPathOf("/api/projects/x/chat/sessions?s=1") === "/api/projects/x/chat/sessions" &&
        requestPathOf(undefined) === "" &&
        isPublicPath("/") && isPublicPath("/remote") && !isPublicPath("/api/projects") &&
        isReadOnlyExemptPath("/api/remote/login") &&
        isChatReadPath("/api/projects/x/chat/sessions") &&
        isChatReadPath("/api/projects/x/chat/sessions/sid") &&
        isChatReadPath("/api/projects/x/chat/sessions/sid/messages") &&
        isReadMethod("GET") && !isReadMethod("POST"),
      "③ 路径判定表：query 剥离 / 登录页 / 会话例外 / 聊天读（含 POST …/messages 发消息路径——" +
        "它把整段会话历史喂给模型再经 SSE 流回，等同读聊天；2026-09-18 审计改判 fail-closed）",
    );

    // 放行口单元表：非回环来源的六种情形（本机回环、登录页、会话例外、聊天闸门、写方法、退避）
    const cfgRo = resolveRemoteConfig({ [REMOTE_ENABLE_ENV]: "1", [REMOTE_HOST_ENV]: "192.168.1.9" });
    const cfgChat = resolveRemoteConfig({
      [REMOTE_ENABLE_ENV]: "1",
      [REMOTE_HOST_ENV]: "192.168.1.9",
      [REMOTE_CHAT_ENV]: "1",
    });
    const gHome = path.join(tmpBase, "home-guard");
    fs.mkdirSync(gHome, { recursive: true });
    const authG = new AuthService({ dataDir: gHome, tokenTtlMs: 60_000, sessionTtlMs: 60_000, now: () => clockNow });
    const gTok = authG.ensureToken().record.token;
    const gSess = authG.createSession(gTok, "192.168.1.50");
    const remote = (method: string, pathName: string, credential: string | null, cfg = cfgRo) =>
      guardRemoteRequest(cfg, authG, {
        remoteAddress: "192.168.1.50",
        method,
        authorization: credential ? `Bearer ${credential}` : null,
        path: pathName,
      });
    const gLoop = guardRemoteRequest(cfgRo, authG, {
      remoteAddress: "127.0.0.1",
      method: "POST",
      authorization: null,
      path: "/api/projects",
    });
    ok(gLoop.ok && gLoop.remote === false, "③ 回环来源（127.0.0.1）POST 无凭据 → 放行（S1 口径未破）");
    const gPage = remote("GET", "/", null);
    ok(gPage.ok, "③ 非回环 GET / 免凭据 → 放行（登录页本体；零数据）");
    const gPagePost = remote("POST", "/", null);
    ok(!gPagePost.ok && gPagePost.code === "NO_TOKEN", `③ 非回环 POST / 仍要凭据 → ${gPagePost.ok ? "放过（错！）" : `${gPagePost.status} ${gPagePost.code}`}`);
    const gLogin = remote("POST", "/api/remote/login", gTok);
    ok(gLogin.ok && gLogin.remote, "③ 非回环 POST /api/remote/login + 有效口令 → 放行（会话例外只放方法关）");
    const gLoginBad = remote("POST", "/api/remote/login", generateToken());
    ok(!gLoginBad.ok && gLoginBad.code === "BAD_TOKEN", `③ 同一路径带错口令 → ${gLoginBad.ok ? "放过（错！）" : `${gLoginBad.status} ${gLoginBad.code}`}（凭据关没松）`);
    const gChat = remote("GET", "/api/projects/x/chat/sessions", gSess.session_id);
    ok(!gChat.ok && gChat.code === "REMOTE_CHAT_HIDDEN", `③ 聊天读默认 → ${gChat.ok ? "放过（错！）" : `${gChat.status} ${gChat.code}`}`);
    const gChatOn = remote("GET", "/api/projects/x/chat/sessions", gSess.session_id, cfgChat);
    ok(gChatOn.ok, "③ 同一路径在 TATAI_REMOTE_CHAT=1 下放行（开关有效，不是永远封死）");
    const gWrite = remote("POST", "/api/projects/x/tasks", gSess.session_id);
    ok(!gWrite.ok && gWrite.code === "REMOTE_READ_ONLY", `③ 写方法 + 有效会话 → ${gWrite.ok ? "放过（错！）" : `${gWrite.status} ${gWrite.code}`}`);
    // 8a（2026-09-18 审计同步）：`POST …/chat/sessions/:sid/messages` 旧断言是"不算聊天读路径"，
    // 按新事实改判——发消息会把整段会话历史喂模型再 SSE 流回，等同读聊天。写模式开 + 聊天关
    // → fail-closed 403 REMOTE_CHAT_HIDDEN（不会先撞 REMOTE_READ_ONLY：写关已过）；
    // TATAI_REMOTE_CHAT=1 → 放行（要连写一起开就得显式给开关，正向对照在此）。
    const cfgWrite = resolveRemoteConfig({
      [REMOTE_ENABLE_ENV]: "1",
      [REMOTE_HOST_ENV]: "192.168.1.9",
      [REMOTE_WRITE_ENV]: "1",
      [REMOTE_WRITE_CONFIRM_ENV]: WRITE_CONFIRM_PHRASE,
    });
    const cfgWriteChat = resolveRemoteConfig({
      [REMOTE_ENABLE_ENV]: "1",
      [REMOTE_HOST_ENV]: "192.168.1.9",
      [REMOTE_WRITE_ENV]: "1",
      [REMOTE_WRITE_CONFIRM_ENV]: WRITE_CONFIRM_PHRASE,
      [REMOTE_CHAT_ENV]: "1",
    });
    const gMsgHidden = remote("POST", "/api/projects/x/chat/sessions/sid/messages", gSess.session_id, cfgWrite);
    ok(
      !gMsgHidden.ok && gMsgHidden.code === "REMOTE_CHAT_HIDDEN",
      `③ 写模式下 POST chat/sessions/:sid/messages（未开聊天）→ ${gMsgHidden.ok ? "放过（错！）" : `${gMsgHidden.status} ${gMsgHidden.code}`}（fail-closed）`,
    );
    const gMsgOpen = remote("POST", "/api/projects/x/chat/sessions/sid/messages", gSess.session_id, cfgWriteChat);
    ok(gMsgOpen.ok, "③ TATAI_REMOTE_CHAT=1 时同一请求放行（开关明示才开，不是永远封死）");
    authG.clearFailures("192.168.1.50");
    for (let i = 0; i < LOGIN_MAX_FAILURES; i++) remote("GET", "/api/projects", generateToken());
    const gThrottled = remote("GET", "/api/projects", gTok);
    ok(
      !gThrottled.ok && gThrottled.code === "LOGIN_THROTTLED" && gThrottled.status === 429 && gThrottled.retryAfterMs === LOGIN_LOCKOUT_MS,
      `③ 退避中连正确口令也先拒 → ${gThrottled.ok ? "放过（错！）" : `${gThrottled.status} ${gThrottled.code}，retry-after ${(gThrottled.retryAfterMs ?? 0) / 1000}s`}`,
    );
    ok(
      credentialFromHeader("Bearer abc") === "abc" && credentialFromHeader("abc") === "abc" && credentialFromHeader("") === null,
      "③ Authorization 解析口径未动（Bearer x / 裸 x / 空）",
    );
    ok(tokenPathIn(fixture.home) === tokenFilePath(fixture.home), "③ 口令路径口径仍唯一（auth ≡ remote-config）");

    // ═══════════════ ④ 主服务：局域网 IP + 只读模式（DoD① 的最强近似）═══════════════
    info(`④ 主服务绑真实局域网 IP ${lanHost} + 只读模式（默认聊天关）`);
    const mainSvc = await startServer("主服务", lanHost, {
      TATAI_HOME: fixture.home,
      [REMOTE_ENABLE_ENV]: "1",
      [REMOTE_HOST_ENV]: lanHost,
    });
    live.push(mainSvc);
    for (const line of mainSvc.output().split(/\r?\n/).filter((l) => l.startsWith("[tatai-server]"))) {
      console.log(`[verify]     ${line}`);
    }
    const mainRows = netstatListeners(mainSvc.port);
    for (const r of mainRows) console.log(`[verify]     netstat: ${r.raw}`);
    ok(
      mainRows.length > 0 && mainRows.every((r) => localAddressOf(r.local) === lanHost),
      `④ 服务只绑显式给的局域网 IP ${lanHost}（实测 ${mainRows.map((r) => localAddressOf(r.local)).join("、")}）——来源一定是非回环`,
    );
    const tokenMain = fs.existsSync(path.join(fixture.home, "remote", "auth.json"))
      ? (JSON.parse(fs.readFileSync(path.join(fixture.home, "remote", "auth.json"), "utf8")) as { token: string }).token
      : (() => {
          throw new Error("主服务没有生成口令文件");
        })();
    console.log(`[verify]   主服务口令指纹 ${tokenFingerprint(tokenMain)}（原文不外打）`);

    // ④-1 登录页本体：免凭据可达，且不含任何数据
    const pageRes = await http(mainSvc.base, "/");
    ok(
      pageRes.status === 200 && pageRes.headers.get("content-type")?.includes("text/html") === true,
      `④ 无凭据 GET /（局域网地址）→ ${pageRes.status} ${pageRes.headers.get("content-type")}`,
    );
    const csp = pageRes.headers.get("content-security-policy") ?? "";
    ok(csp.includes("script-src 'nonce-") && csp.includes("default-src 'none'"), `④ 页面带 nonce CSP：${csp.slice(0, 96)}…`);
    ok(
      !pageRes.text.includes(fixture.designTitle) &&
        !pageRes.text.includes(fixture.chatSecret) &&
        !pageRes.text.includes(fixture.home) &&
        !pageRes.text.includes("registry.json"),
      "④ 页面本体零数据（不含设计书/聊天/数据目录任何一处内容）",
    );
    const altPage = await http(mainSvc.base, "/remote");
    const nonceX = (t: string) => t.replace(/nonce="[^"]+"/g, 'nonce="X"');
    ok(
      altPage.status === 200 && nonceX(altPage.text) === nonceX(pageRes.text),
      "④ /remote 与 / 同一页（除每次现生成的 nonce 外逐字相同）",
    );

    // ④-2 未登录/错口令的拒绝（S1 三条路径的 S2 回归）
    const noToken = await http(mainSvc.base, "/api/projects");
    ok(noToken.status === 401 && codeOf(noToken) === "NO_TOKEN", `④ 无 token 读 → ${noToken.status} ${codeOf(noToken)}`);
    const badToken = await http(mainSvc.base, "/api/projects", { credential: generateToken() });
    ok(
      badToken.status === 401 && codeOf(badToken) === "BAD_TOKEN" && (badToken.body.error?.message ?? "").includes("计数提示"),
      `④ 错 token → ${badToken.status} ${codeOf(badToken)}（带计数提示：${(badToken.body.error?.message ?? "").slice(-28)}）`,
    );
    const noTokenWrite = await http(mainSvc.base, "/api/projects/s2fix/tasks", { method: "POST", body: {} });
    ok(
      noTokenWrite.status === 401 && codeOf(noTokenWrite) === "NO_TOKEN",
      `④ 写请求没 token 也是 401（先鉴权后路由）→ ${noTokenWrite.status} ${codeOf(noTokenWrite)}`,
    );

    // ④-3 口令换会话（DoD③ 前半）
    const loginRes = await http(mainSvc.base, "/api/remote/login", { method: "POST", credential: tokenMain, body: {} });
    const sessionId = String(((loginRes.body.session ?? {}) as { session_id?: string }).session_id ?? "");
    const sessionExpires = String(((loginRes.body.session ?? {}) as { expires_at?: string }).expires_at ?? "");
    ok(
      loginRes.status === 200 && sessionId.startsWith(SESSION_ID_PREFIX),
      `④ 口令换会话 → ${loginRes.status}，session ${sessionId.slice(0, 6)}…，到期 ${sessionExpires}，chat_exposed=${loginRes.body.chat_exposed}`,
    );
    const selfRes = await http(mainSvc.base, "/api/remote/session", { credential: sessionId });
    ok(
      selfRes.status === 200 && selfRes.body.via === "session" && selfRes.body.read_only === true && selfRes.body.chat_exposed === false,
      `④ 会话自述：via=${selfRes.body.via} · read_only=${selfRes.body.read_only} · chat_exposed=${selfRes.body.chat_exposed} · fingerprint=${selfRes.body.fingerprint}`,
    );

    // ④-4 只读四样（DoD① 的数据面）
    const pList = await http(mainSvc.base, "/api/projects", { credential: sessionId });
    const items = Array.isArray(pList.body) ? (pList.body as unknown as Record<string, unknown>[]) : [];
    ok(
      pList.status === 200 && items.length === 1 && items[0].id === fixture.projectId && items[0].name === fixture.projectName,
      `④ 样①项目列表：${pList.status}，${items.length} 个项目（${items.map((i) => i.name).join("、")}）`,
    );
    ok(
      items.every((i) => !("path" in i)),
      `④ 只传必要数据：远程项目列表不含本机绝对路径（字段 ${Object.keys(items[0] ?? {}).join("/")}）`,
    );
    const dRes = await http(mainSvc.base, `/api/projects/${fixture.projectId}/design`, { credential: sessionId });
    const design = (dRes.body.design ?? {}) as { exists?: boolean; content?: string; source?: string };
    ok(
      dRes.status === 200 && design.exists === true && (design.content ?? "").includes(fixture.designTitle) && design.source === undefined,
      `④ 样②设计书：${dRes.status}，含标题「${fixture.designTitle.slice(2, 14)}…」，落盘绝对路径已裁掉（source=${String(design.source)}）`,
    );
    const uRes = await http(mainSvc.base, `/api/projects/${fixture.projectId}/discuss`, { credential: sessionId });
    const discuss = (uRes.body.discuss ?? {}) as { exists?: boolean; content?: string; count?: number; source?: string };
    ok(
      uRes.status === 200 && discuss.exists === true && (discuss.content ?? "").includes("待议样条") && discuss.count === 1 && discuss.source === undefined,
      `④ 样②附待议：${uRes.status}，${discuss.count} 条，含「待议样条」，source 已裁掉`,
    );
    const aRes = await http(mainSvc.base, `/api/projects/${fixture.projectId}/arch/render`, { credential: sessionId });
    const graph = ((aRes.body.render ?? {}) as { graph?: { nodes?: { id: string; name: string; path?: string; status?: string }[]; edges?: unknown[] } }).graph;
    ok(
      aRes.status === 200 && (graph?.nodes ?? []).length === 3 && (graph?.edges ?? []).length === 2 &&
        (graph?.nodes ?? []).some((n) => n.name === "夹具源码主模块") &&
        (graph?.nodes ?? []).every((n) => typeof n.path === "string"),
      `④ 样③架构图数据：${aRes.status}，节点 ${(graph?.nodes ?? []).length} 个（含「夹具源码主模块」）· 边 ${(graph?.edges ?? []).length} 条；节点里的**项目内相对路径**没被误裁（${(graph?.nodes ?? []).map((n) => n.path).join("/")}）`,
    );
    const gRes = await http(mainSvc.base, `/api/projects/${fixture.projectId}/progress`, { credential: sessionId });
    const progress = (gRes.body.progress ?? {}) as { gate?: { current_step?: string }; modules?: { status: string }[] };
    ok(
      gRes.status === 200 && progress.gate?.current_step === "develop" && (progress.modules ?? []).length === 2,
      `④ 样④Gate 时间线（progress）：${gRes.status}，当前步 ${progress.gate?.current_step}，模块 ${(progress.modules ?? []).length} 个`,
    );
    const glRes = await http(mainSvc.base, `/api/projects/${fixture.projectId}/gate.jsonl`, { credential: sessionId });
    const gateLines = glRes.text.split("\n").filter((l) => l.trim() !== "");
    ok(
      glRes.status === 200 && gateLines.length === 2 && gateLines[0].includes("kickoff") && gateLines[1].includes("requirement"),
      `④ 样④Gate 时间线（gate.jsonl）：${glRes.status}，${gateLines.length} 行，首行 ${gateLines[0].slice(0, 58)}…`,
    );
    let absPathLeak: string[] = [];
    for (const [label, res] of [
      ["projects", pList],
      ["design", dRes],
      ["discuss", uRes],
      ["render", aRes],
      ["progress", gRes],
      ["gate.jsonl", glRes],
    ] as [string, HttpResult][]) {
      for (const needle of [fixture.home, fixture.proj, "registry.json", path.join("remote", "auth.json")]) {
        if (res.text.includes(needle)) absPathLeak.push(`${label} 含 ${needle}`);
      }
    }
    ok(absPathLeak.length === 0, `④ 只读四样+项目列表的**原始响应**里零本机绝对路径（扫描 ${6} 个响应，命中 ${absPathLeak.join(" | ") || "无"}）`);

    // ④-5 写接口逐条拒绝（DoD②）
    info(`④ 写接口逐条拒绝（清单 ${REMOTE_WRITE_ROUTES.length} 条，全部用「有效会话 + 只读模式」打一遍）`);
    const writeResults: { route: RemoteRoute; res: HttpResult }[] = [];
    for (const route of REMOTE_WRITE_ROUTES) {
      const res = await http(mainSvc.base, routeUrl(route, fixture.projectId), {
        method: route.method,
        credential: sessionId,
        ...(route.body !== undefined ? { body: route.body } : {}),
      });
      writeResults.push({ route, res });
      const tag = res.status === 403 && codeOf(res) === "REMOTE_READ_ONLY" ? "PASS" : "FAIL";
      console.log(
        `[verify] ${tag} 写接口 ${String(writeResults.length).padStart(2, " ")}/${REMOTE_WRITE_ROUTES.length} ` +
          `${route.method.padEnd(6)} ${routeUrl(route, fixture.projectId).padEnd(52)} → ${res.status} ${codeOf(res)} ｜ ${route.note}`,
      );
      if (tag === "FAIL") process.exitCode = 1;
    }
    ok(
      writeResults.every((w) => w.res.status === 403 && codeOf(w.res) === "REMOTE_READ_ONLY"),
      `④ 写接口逐条拒绝：${writeResults.length}/${REMOTE_WRITE_ROUTES.length} 条全部 403 REMOTE_READ_ONLY（清单数 == index.ts 源码提及数，见段②）`,
    );
    ok(
      REMOTE_WRITE_ROUTES.length + readRoutes.length + REMOTE_SESSION_ROUTES.length + REMOTE_PUBLIC_ROUTES.length ===
        REMOTE_ROUTES.length,
      `④ 清单四类不重不漏：写 ${REMOTE_WRITE_ROUTES.length} + 读 ${readRoutes.length} + 会话 ${REMOTE_SESSION_ROUTES.length} + 静态入口 ${REMOTE_PUBLIC_ROUTES.length} = ${REMOTE_ROUTES.length}`,
    );

    // ④-6 聊天默认不外泄（DoD④）
    const chatList = await http(mainSvc.base, `/api/projects/${fixture.projectId}/chat/sessions`, { credential: sessionId });
    const chatFull = await http(
      mainSvc.base,
      `/api/projects/${fixture.projectId}/chat/sessions/${fixture.chatSessionId}`,
      { credential: sessionId },
    );
    ok(
      chatList.status === 403 && codeOf(chatList) === "REMOTE_CHAT_HIDDEN",
      `④ 聊天会话列表（默认）→ ${chatList.status} ${codeOf(chatList)}：${(chatList.body.error?.message ?? "").slice(0, 46)}…`,
    );
    ok(
      chatFull.status === 403 && codeOf(chatFull) === "REMOTE_CHAT_HIDDEN" && !chatFull.text.includes(fixture.chatSecret),
      `④ 聊天全文（默认）→ ${chatFull.status} ${codeOf(chatFull)}，响应里不含任何聊天原文`,
    );

    // ④-7 登出（DoD③ 后半）：200 → 401 对照
    const logoutBefore = await http(mainSvc.base, "/api/remote/session", { credential: sessionId });
    const logoutRes = await http(mainSvc.base, "/api/remote/logout", { method: "POST", credential: sessionId, body: {} });
    const logoutAfter = await http(mainSvc.base, "/api/remote/session", { credential: sessionId });
    ok(logoutBefore.status === 200, `④ 登出前：同一会话读会话自述 → ${logoutBefore.status}（可用）`);
    ok(logoutRes.status === 200 && logoutRes.body.logged_out === true, `④ 登出 → ${logoutRes.status} ${String(logoutRes.body.note).slice(0, 34)}`);
    ok(
      logoutAfter.status === 401 && codeOf(logoutAfter) === "SESSION_INVALID",
      `④ 登出后：同一会话再读 → ${logoutAfter.status} ${codeOf(logoutAfter)}（200 → 401 对照）`,
    );
    const logoutDead = await http(mainSvc.base, "/api/remote/logout", { method: "POST", credential: sessionId, body: {} });
    ok(
      logoutDead.status === 401 && codeOf(logoutDead) === "SESSION_INVALID",
      `④ 用已失效的会话再登出 → ${logoutDead.status} ${codeOf(logoutDead)}（凭据不可用就登不出去，口径与"先鉴权后路由"一致）`,
    );
    const logoutByToken = await http(mainSvc.base, "/api/remote/logout", {
      method: "POST",
      credential: tokenMain,
      body: {},
    });
    ok(
      logoutByToken.status === 200 && logoutByToken.body.logged_out === false,
      `④ 用口令调登出 → ${logoutByToken.status} logged_out=${logoutByToken.body.logged_out}（口令不是会话，如实回 false 不假装成功）`,
    );
    console.log("[verify]   服务端 [remote] 日志（拒绝与登出逐条留痕；S3 起这些足迹另有审计流水，见 pnpm verify:s3）：");
    for (const line of mainSvc.output().split(/\r?\n/).filter((l) => l.includes("[remote]"))) {
      console.log(`[verify]     ${line}`);
    }

    // ④-8 本机回环仍免 token（S1 口径回归）——主服务只绑局域网 IP，回环另起一个默认配置服务
    info("④ 本机回环回归：默认配置（不置任何远程变量）只绑回环、回环免 token");
    const loopSvc = await startServer("回环服务", "127.0.0.1", { TATAI_HOME: fixture.home });
    live.push(loopSvc);
    const loopRows = netstatListeners(loopSvc.port);
    for (const r of loopRows) console.log(`[verify]     netstat: ${r.raw}`);
    ok(
      loopRows.length > 0 && loopRows.every((r) => isLoopbackAddress(localAddressOf(r.local))),
      `④ 默认配置仍只绑回环（实测 ${loopRows.map((r) => localAddressOf(r.local)).join("、")}）`,
    );
    const loopHealth = await http(loopSvc.base, "/health");
    ok(loopHealth.status === 200 && loopHealth.body.ok === true, `④ 回环 /health 免 token → ${loopHealth.status}（本地体验未破）`);
    ok(
      String(loopHealth.body.data_dir ?? "").length > 0,
      `④ 回环 /health 带 data_dir（本机响应照旧：只对非回环来源裁剪）：${String(loopHealth.body.data_dir).slice(0, 40)}`,
    );
    const loopProjects2 = await http(loopSvc.base, "/api/projects");
    const loopItems = Array.isArray(loopProjects2.body) ? (loopProjects2.body as unknown as Record<string, unknown>[]) : [];
    ok(
      loopProjects2.status === 200 && loopItems.length === 1 && typeof loopItems[0].path === "string",
      "④ 本机读项目列表仍带绝对路径（对照：裁剪只对非回环来源生效，本地 UI 不受影响）",
    );

    // ④-9 真浏览器跑一遍页面（DoD① 的界面面：证明页面真把四样画出来了，不只是接口可用）
    info("④ 真 Browser（Chromium，连局域网地址）打开只读页面 → 填口令 → 逐个页签读四样 → 登出");
    if (lanIp === null) {
      remoteUiSkipped = true;
      console.log("[verify]   ④ UI 段 SKIP：本机没有非内部 IPv4，浏览器段只能连回环（口径会退化成「本机」）");
    } else if (!(await lanSelfReachable(mainSvc.base))) {
      // V08-01（测试欠账 ③）：先证"本机到自己的局域网地址可达"，再开浏览器。
      // 实测本机 WLAN 地址 172.20.10.2 上的服务**连自己都连不上**（同进程 python urllib 直连超时、
      // 绑得上但回不来：防火墙/热点网卡状态），浏览器段必然以 30s 超时收场——这是环境问题，不是页面缺陷。
      // 判据一条不放宽：可达时照旧跑全部断言；不可达时**显式 SKIP 并写明依据**（退出码 3＝没跑全）。
      remoteUiSkipped = true;
      console.log(
        `[verify]   ④ UI 段 SKIP：本机连不到自己的局域网地址（${mainSvc.base} TCP 探测失败）——` +
          "远程页面只能从非回环来源打开，本机不可达时浏览器段无从证明；接口层证据已在上方，页面可用性如实声明为未验证",
      );
    } else {
      const pyScript = path.join(tmpBase, "s2-page-shot.py");
      fs.writeFileSync(pyScript, S2_PAGE_SHOT_PY, "utf8");
      const outDir = fs.existsSync(path.join(REPO_ROOT, ".工作台", "verify"))
        ? path.join(REPO_ROOT, ".工作台", "verify", "s2-viewer.png")
        : path.join(tmpBase, "s2-viewer.png");
      const probe = spawnSync("python", ["-c", "import playwright"], { encoding: "utf8" });
      if (probe.error || probe.status !== 0) {
        remoteUiSkipped = true;
        console.log(
          `[verify]   ④ UI 段 SKIP：python playwright 不可用（${probe.error ? String(probe.error.message) : `exit ${probe.status}`}）——` +
            "接口层证据已在上方，页面可用性本机未验证，如实声明",
        );
      } else {
        const run = spawnSync(
          "python",
          [pyScript, mainSvc.base, tokenMain, fixture.projectId, fixture.projectName, fixture.designTitle, "0", outDir],
          { encoding: "utf8", cwd: tmpBase, maxBuffer: 32 * 1024 * 1024, timeout: 300_000 },
        );
        for (const line of `${run.stdout ?? ""}${run.stderr ?? ""}`.split(/\r?\n/)) {
          if (line.trim() !== "") console.log(`[verify]   ${line}`);
        }
        ok(run.status === 0, `④ 页面 UI 段（真 Chromium）exit=${run.status}；截图 ${path.relative(REPO_ROOT, outDir)}`);
      }
    }

    // ═══════════════ ⑤ 红线①回归：默认配置零暴露（不开远程 → 连口令文件都不生成）═══════════════
    info("⑤ 默认配置（不置任何远程变量）启动 → 只绑回环 + 零口令文件 + 启动日志明说未开启");
    const defaultHome = path.join(tmpBase, "home-default");
    fs.mkdirSync(defaultHome, { recursive: true });
    const defaultSvc = await startServer("默认服务", "127.0.0.1", { TATAI_HOME: defaultHome });
    live.push(defaultSvc);
    const defRows = netstatListeners(defaultSvc.port);
    for (const r of defRows) console.log(`[verify]     netstat: ${r.raw}`);
    ok(
      defRows.length > 0 && defRows.every((r) => isLoopbackAddress(localAddressOf(r.local))) &&
        !defRows.some((r) => ["0.0.0.0", "::"].includes(localAddressOf(r.local))),
      `⑤ 默认配置零外部监听（实测 ${defRows.map((r) => localAddressOf(r.local)).join("、")}）`,
    );
    ok(
      defaultSvc.output().includes("远程访问未开启（默认关闭）") &&
        defaultSvc.output().includes("聊天全文不下发远程（默认"),
      "⑤ 启动日志明说远程未开启 + 聊天默认不下发（口径逐条打屏）",
    );
    ok(
      !fs.existsSync(path.join(defaultHome, "remote")),
      "⑤ 默认关闭时零口令文件（不开远程就不生成任何 token）",
    );

    // ═══════════════ ⑥ DoD④ 对照：TATAI_REMOTE_CHAT=1 → 聊天可读 ═══════════════
    info(`⑥ 聊天开关对照：${REMOTE_CHAT_ENV}=1 才允许远程读聊天（默认 403 已在上方见证）`);
    const chatSvc = await startServer("聊天开启服务", lanHost, {
      TATAI_HOME: fixture.home,
      [REMOTE_ENABLE_ENV]: "1",
      [REMOTE_HOST_ENV]: lanHost,
      [REMOTE_CHAT_ENV]: "1",
    });
    live.push(chatSvc);
    ok(chatSvc.output().includes("远程聊天读取已开启"), "⑥ 启动日志有醒目 ⚠ 警告（放开是明示的，不是默认的）");
    const tokenChat = (JSON.parse(fs.readFileSync(path.join(fixture.home, "remote", "auth.json"), "utf8")) as { token: string })
      .token;
    const chatLogin = await http(chatSvc.base, "/api/remote/login", { method: "POST", credential: tokenChat, body: {} });
    const chatSid = String(((chatLogin.body.session ?? {}) as { session_id?: string }).session_id ?? "");
    ok(chatLogin.status === 200 && chatLogin.body.chat_exposed === true, `⑥ 登录回执里 chat_exposed=${chatLogin.body.chat_exposed}`);
    const chatListOn = await http(chatSvc.base, `/api/projects/${fixture.projectId}/chat/sessions`, { credential: chatSid });
    const chatFullOn = await http(
      chatSvc.base,
      `/api/projects/${fixture.projectId}/chat/sessions/${fixture.chatSessionId}`,
      { credential: chatSid },
    );
    const msgs = (chatFullOn.body.messages ?? []) as { role: string; content: string }[];
    ok(
      chatListOn.status === 200 &&
        Array.isArray(chatListOn.body.sessions) &&
        (chatListOn.body.sessions as { session_id: string }[])[0]?.session_id === fixture.chatSessionId,
      `⑥ 开关打开后会话列表 → ${chatListOn.status}（1 条：${fixture.chatSessionId}）`,
    );
    ok(
      chatFullOn.status === 200 && msgs.length === 2 && msgs[0].content === fixture.chatSecret,
      `⑥ 开关打开后聊天全文 → ${chatFullOn.status}，${msgs.length} 条消息（与夹具原文逐字相等：${msgs[0]?.content === fixture.chatSecret}）`,
    );

    // ═══════════════ ⑦ DoD③：会话有效期真到点（不靠改文件，靠真时钟走完 TTL）═══════════════
    info("⑦ 会话有效期真到点：TATAI_REMOTE_SESSION_TTL_MINUTES=0.05（3s）");
    const ttlSvc = await startServer("短会话服务", lanHost, {
      TATAI_HOME: fixture.home,
      [REMOTE_ENABLE_ENV]: "1",
      [REMOTE_HOST_ENV]: lanHost,
      [REMOTE_SESSION_TTL_ENV]: "0.05",
    });
    live.push(ttlSvc);
    const tokenTtl = (JSON.parse(fs.readFileSync(path.join(fixture.home, "remote", "auth.json"), "utf8")) as { token: string })
      .token;
    const ttlLogin = await http(ttlSvc.base, "/api/remote/login", { method: "POST", credential: tokenTtl, body: {} });
    const ttlSid = String(((ttlLogin.body.session ?? {}) as { session_id?: string }).session_id ?? "");
    const before = await http(ttlSvc.base, "/api/remote/session", { credential: ttlSid });
    await sleep(3200);
    const after = await http(ttlSvc.base, "/api/remote/session", { credential: ttlSid });
    console.log(`[verify]   会话有效期 3s：刚到点 ${before.status} → 到点后 ${after.status} ${codeOf(after)}`);
    ok(
      before.status === 200 && after.status === 401 && codeOf(after) === "SESSION_EXPIRED",
      `⑦ 会话 TTL 真到点即失效（到期前 ${before.status}、到期后 ${after.status} ${codeOf(after)}）`,
    );

    // ═══════════════ ⑧ 防爆破：口令错误 N 次 → 429 + retry-after（HTTP 级）═══════════════
    info(`⑧ 口令错误计数与退避（HTTP 级：连错 ${LOGIN_MAX_FAILURES} 次）`);
    const throttleHome = path.join(tmpBase, "home-throttle");
    fs.mkdirSync(throttleHome, { recursive: true });
    const throttleSvc = await startServer("退避服务", lanHost, {
      TATAI_HOME: throttleHome,
      [REMOTE_ENABLE_ENV]: "1",
      [REMOTE_HOST_ENV]: lanHost,
    });
    live.push(throttleSvc);
    const tokenThrottle = (JSON.parse(fs.readFileSync(path.join(throttleHome, "remote", "auth.json"), "utf8")) as {
      token: string;
    }).token;
    const attempts: string[] = [];
    for (let i = 1; i <= LOGIN_MAX_FAILURES; i++) {
      const r = await http(throttleSvc.base, "/api/projects", { credential: generateToken() });
      attempts.push(`${i}:${r.status}${codeOf(r) === "BAD_TOKEN" ? "" : " " + codeOf(r)}`);
    }
    const locked = await http(throttleSvc.base, "/api/projects", { credential: tokenThrottle });
    console.log(
      `[verify]   连错序列 ${attempts.join(" → ")}；退避中带**正确口令** → ${locked.status} ${codeOf(locked)}（retry-after ${locked.headers.get("retry-after")}s）`,
    );
    ok(
      attempts.slice(0, LOGIN_MAX_FAILURES - 1).every((a) => a.endsWith("401")) &&
        attempts[LOGIN_MAX_FAILURES - 1].includes("429"),
      `⑧ 前 ${LOGIN_MAX_FAILURES - 1} 次错口令 401 BAD_TOKEN（带计数提示），第 ${LOGIN_MAX_FAILURES} 次直接 429`,
    );
    ok(
      locked.status === 429 && codeOf(locked) === "LOGIN_THROTTLED" && locked.headers.get("retry-after") !== null,
      `⑧ 退避中连正确口令也先拒（429 LOGIN_THROTTLED + retry-after=${locked.headers.get("retry-after")}s）`,
    );
    const loginLocked = await http(throttleSvc.base, "/api/remote/login", { method: "POST", credential: tokenThrottle, body: {} });
    ok(
      loginLocked.status === 429 && codeOf(loginLocked) === "LOGIN_THROTTLED",
      `⑧ 退避期间登录口也拒 → ${loginLocked.status} ${codeOf(loginLocked)}（防爆破覆盖全部远程入口）`,
    );

    // ═══════════════ ⑨ S1 回归：过期 token（改口令文件造过期）═══════════════
    info("⑨ S1 回归：过期 token 仍 401 EXPIRED_TOKEN（服务端每次校验都重读口令文件）");
    const stale = JSON.parse(fs.readFileSync(path.join(fixture.home, "remote", "auth.json"), "utf8")) as TokenRecord;
    writeTokenRecord(fixture.home, { ...stale, expires_at: new Date(Date.now() - 60_000).toISOString() });
    const expired = await http(mainSvc.base, "/api/projects", { credential: tokenMain });
    ok(
      expired.status === 401 && codeOf(expired) === "EXPIRED_TOKEN",
      `⑨ 拒绝路径③ HTTP 过期 token → ${expired.status} ${codeOf(expired)}`,
    );

    // ═══════════════ ⑩ 覆盖声明 + 收尾 ═══════════════
    info("⑩ 覆盖与未覆盖（如实声明，不把近似当实测）");
    console.log("[verify]   覆盖：服务端只绑真实局域网 IP（netstat 原始行见上），全部远程请求都经该 IP 发出 →");
    console.log("[verify]          服务端看到的来源是非回环，走的就是远程口径；界面由真 Chromium 在该地址上跑过一遍。");
    console.log("[verify]   未覆盖：**本机没有第二台设备**，没有从另一台机器/手机真发一次请求——");
    console.log("[verify]          「局域网内另一设备真实打开」按最强近似（同机经局域网 IP 访问）声明，不写成已实测远程设备。");
    console.log("[verify]   未覆盖：真机 TLS/反代、跨网段/VPN 场景不在本卡范围（做法与坑写在 README；S3 已把读写模式与审计做完）。");

    info("⑪ 收尾：进程杀净 / 端口释放 / 8787+5173 仍是别人的 / 口令不进仓库");
    for (const svc of live) killTree(svc.proc, svc.port);
    await sleep(900);
    for (const svc of live) {
      ok(!(await portListening(svc.port, svc.host)), `⑪ 端口 ${svc.port}（${svc.host}）已释放`);
    }
    const fixedAfter = { v: await portListening(8787), d: await portListening(5173) };
    ok(
      fixedAfter.v === fixedBefore.v && fixedAfter.d === fixedBefore.d,
      `⑪ 8787/5173 状态与开跑前一致（${fixedBefore.v}→${fixedAfter.v} / ${fixedBefore.d}→${fixedAfter.d}）——没碰别人的监听`,
    );
    const gitStatus = execSync("git status --porcelain", { cwd: REPO_ROOT, encoding: "utf8" });
    const leaked = gitStatus.split(/\r?\n/).filter((l) => /auth\.json|\.tatai\/remote|s2-viewer\.png/i.test(l));
    ok(leaked.length === 0, `⑪ git status 里没有口令/临时截图类文件（匹配行：${leaked.join(" | ") || "无"}）`);
  } finally {
    for (const svc of live) killTree(svc.proc, svc.port);
    await sleep(600);
  }
  fs.rmSync(tmpBase, { recursive: true, force: true });
  console.log(`[verify]   临时数据目录已清理：${tmpBase}`);
  console.log(
    `\n[verify] ── S2 结论：${
      process.exitCode ? "存在 FAIL，见上方逐条" : remoteUiSkipped ? "接口层全部 PASS；④ 页面 UI 段按环境 SKIP（见上方 SKIP 行，退出码 3＝没跑全）" : "全部 PASS"
    }`,
  );
  if (remoteUiSkipped && !process.exitCode) process.exitCode = 3;
}

main().catch((e: Error) => {
  console.error("[verify] 脚本异常：", e);
  process.exitCode = 1;
});
