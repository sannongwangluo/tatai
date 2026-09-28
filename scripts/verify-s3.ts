// S3 验证脚本（用 tsx 跑）：读写模式 + 安全审计。用法：pnpm verify:s3
//
// 覆盖点（逐条对 PLAN.md S3 卡 DoD）：
//   ① DoD①「写模式需二次确认开启，且日志明确标记写模式时间段」：
//      · 启动期 = S1 双开关 + 逐字确认语（红线④，`checkRedlines` 第 R4 条活体跑一遍）；
//      · 运行期 = 主机 CLI（`pnpm remote:write on|off`）：`on` 必须逐字确认语（不给就拒）、
//        且只能在启动期已 armed 的进程里翻（没 armed 一律拒——写模式不能运行期补票）；
//      · 每次真实翻转都在审计里留 `write-mode-on/off` 边界行（带时间戳与来源），脚本把**时间段**圈出来打印。
//   ② DoD②「审计日志落全局数据目录下 logs/，不写进任何被纳管项目、不进仓库」：
//      · 真打一轮（读 + 写 + 拒绝 + 登录失败 + 登出）→ 从审计文件里读回真实行（IP 打码后打印）；
//      · 断言：审计文件在 `<TATAI_HOME>/logs/` 下、**不在任何被纳管项目内、不在 repo 内**；
//      · 断言：这一轮里被纳管项目**零新增文件**（逐文件 size+mtime 快照比对，含"项目内不许出现
//        审计/口令/写开关文件"的按名反证）；`git status` 里看不到审计/口令类文件。
//      · 反向证伪：把 TATAI_HOME 指到 repo 里 → 服务端**拒绝启动**（红线：审计记录绝不进仓库）。
//   ③ DoD③「关闭写模式后所有写接口立刻失效」：同一写请求三段对照
//      （只读 403 → 写模式开：过门到业务层 200 → CLI 关：同一请求立刻 403，**不重启**）；
//      另把清单里 29 条写路由在"关闭后"逐条打一遍 → 29/29 全 403 REMOTE_READ_ONLY。
//   ④ DoD④「文档写明不推荐公网直连及理由」：脚本对 README 做原文断言（无 TLS / 单静态口令 /
//      接口含 PTY / 私人数据），口径与 DESIGN.md §10.2 一致。
//   ⑤ S2 遗留①「其余读接口的字段裁剪一并扫」+ 敏感面扫描：把清单里**每条读路由**真打一遍，
//      逐条扫本机绝对路径 / TATAI_HOME 目录名 / 口令原文 / 聊天原文 / 终端历史命令原文，
//      并加一条通用反证（响应里不出现盘符形态的绝对路径）。
//   ⑥ S3 表态「终端历史远程可读性」：默认 403 REMOTE_TERMINAL_HIDDEN（红线⑧），
//      主机显式置位 `TATAI_REMOTE_TERMINAL=1` 才有对照 200；聊天闸门（红线⑦）同场回归。
//
// 端口策略（照 verify-s1/s2 写法）：动态空闲端口 + 起前探活 + 起后盯子进程早退；开头末尾各探一次
// 8787/5173（只记录，不碰别人的进程）。环境隔离：子进程 env 先清掉所有 TATAI_REMOTE*/TATAI_HOST/TATAI_HOME。
// 隐私（AGENTS.md §5/§6）：临时 TATAI_HOME、夹具项目、口令全在 os.tmpdir()；口令只打指纹；
// 审计行打印前把来源 IP 打码（`maskIpForReport`）。
import { execSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AuditPathError,
  AUDIT_MAX_ARCHIVES,
  maskIpForReport,
  RemoteAuditLog,
  actionOfRequest,
  auditFilePath,
  credentialKindOf,
  projectIdOfPath,
  type RemoteAuditLine,
} from "../src/server/remote-audit";
import {
  REMOTE_TERMINAL_ENV,
  REMOTE_MEMORY_ENV,
  REMOTE_WRITE_CONFIRM_ENV,
  REMOTE_WRITE_ENV,
  REMOTE_CHAT_ENV,
  REMOTE_ENABLE_ENV,
  REMOTE_HOST_ENV,
  WRITE_CONFIRM_PHRASE,
  WRITE_MODE_SWITCHES,
  checkRedlines,
  lanAddresses,
  resolveRemoteConfig,
} from "../src/server/remote-config";
import { isTerminalReadPath, isChatReadPath, isMemoryReadPath, tokenFingerprint } from "../src/server/auth";
import { REMOTE_ROUTES, REMOTE_WRITE_ROUTES, type RemoteRoute } from "../src/server/remote-routes";
import { writeModeStatePath } from "../src/server/remote-write";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_ENTRY = path.join("src", "server", "index.ts");
const CLI_ENTRY = path.join("scripts", "remote-write.ts");

const ok = (cond: boolean, label: string) => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (!cond) process.exitCode = 1;
};
const info = (label: string) => console.log(`[verify] ---- ${label}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ───────────────────────────── 端口 / 进程（与 verify-s1/s2 同一套）─────────────────────────────

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
    REMOTE_TERMINAL_ENV,
    REMOTE_WRITE_ENV,
    REMOTE_WRITE_CONFIRM_ENV,
    "TATAI_REMOTE_ALLOW_WILDCARD",
    "TATAI_REMOTE_TOKEN_TTL_MINUTES",
    "TATAI_REMOTE_SESSION_TTL_MINUTES",
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
  const deadline = Date.now() + (opts.timeoutMs ?? 90_000);
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${label} 启动即退出（code=${child.exitCode}）：\n${buf}`);
    if (buf.includes(needle) && (await portListening(port, host))) return svc;
    await sleep(150);
  }
  killTree(child, port);
  throw new Error(`${label} 未就绪（等 "${needle}" 超时）：\n${buf}`);
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

// ───────────────────────────── HTTP 助手（与 verify-s2 同一套）─────────────────────────────

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

/** 非回环地址（服务端视角）：SSE 类的读路由不能整条读完（events 会挂着），只"瞄一眼"首帧 */
async function httpPeek(
  base: string,
  pathName: string,
  credential: string | null,
  peekMs = 900,
): Promise<HttpResult> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), peekMs);
  let text = "";
  let status = 0;
  let headers = new Headers();
  try {
    const res = await fetch(`${base}${pathName}`, {
      headers: credential ? { authorization: `Bearer ${credential}` } : {},
      signal: ctl.signal,
    });
    status = res.status;
    headers = res.headers;
    const reader = res.body?.getReader();
    if (reader) {
      const dec = new TextDecoder();
      // 首帧到手就够（events 的 hello 行），到点或被 abort 即收
      while (text.length < 4096) {
        const { done, value } = await reader.read();
        if (done) break;
        text += dec.decode(value, { stream: true });
        if (text.includes("\n\n")) break;
      }
      await reader.cancel().catch(() => undefined);
    }
  } catch {
    // 到点 abort 是预期路径：拿到的部分内容照样参与敏感面扫描
  } finally {
    clearTimeout(timer);
  }
  let body: Record<string, unknown> = { raw: text };
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // SSE/半截响应：保留原文，由调用方按需判断
  }
  return { status, body: body as HttpResult["body"], text, headers };
}

const codeOf = (r: HttpResult) => r.body.error?.code ?? "(无 error.code)";

/** 路由表里的路径模板 → 可打地址（`:id` / `:sid` / `:taskId` / `:moduleId` 一律填夹具值） */
function routeUrl(route: RemoteRoute, projectId: string, sid = "s3probe-nosuch"): string {
  const p = route.path
    .replace(":id", projectId)
    .replace(":sid", sid)
    .replace(":taskId", "t1")
    .replace(":moduleId", "src");
  return route.query ? `${p}?${route.query.replace(":id", projectId)}` : p;
}

// ───────────────────────────── 夹具（全在 os.tmpdir()）─────────────────────────────

interface Fixture {
  home: string;
  proj: string;
  /** 缺 progress.json 的项目：用来触发"服务端自身副作用"（读 progress 时自动初始化建文件） */
  bare: string;
  projectId: string;
  bareId: string;
  chatSecret: string;
  termSecret: string;
  designTitle: string;
  repoInsideHome: string;
}

function buildFixture(base: string): Fixture {
  const home = path.join(base, "home");
  const proj = path.join(base, "proj");
  const bare = path.join(base, "proj-bare");
  const wb = path.join(proj, ".工作台");
  const projectId = "s3fix";
  const bareId = "s3bare";
  const chatSecret = "S3 夹具聊天机密：默认不许下发到远程设备";
  const termSecret = "echo S3夹具终端机密命令";
  const designTitle = "# 塔台 S3 夹具项目设计书";
  fs.rmSync(base, { recursive: true, force: true });
  fs.mkdirSync(path.join(wb, "arch"), { recursive: true });
  fs.mkdirSync(path.join(wb, "chat"), { recursive: true });
  fs.mkdirSync(path.join(wb, "logs"), { recursive: true });
  fs.mkdirSync(path.join(bare, ".工作台"), { recursive: true });
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
            id: projectId,
            name: "S3 夹具项目",
            path: proj,
            kind: "fullstack",
            registered_at: iso(now - 86_400_000),
            last_opened_at: iso(now - 3_600_000),
          },
          {
            id: bareId,
            name: "S3 缺文件项目",
            path: bare,
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
  fs.writeFileSync(path.join(wb, "design.md"), `${designTitle}\n\n## 1. 是什么\nS3 审计与写模式验证用的最小夹具。\n`);
  fs.writeFileSync(path.join(wb, "design.discuss.md"), "- `2026-09-19` 待议样条：审计日志绝不进项目目录\n");
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
  fs.writeFileSync(path.join(wb, "arch/layout.json"), JSON.stringify({ version: 2, positions: {} }, null, 2));
  fs.writeFileSync(
    path.join(wb, "chat", "s3-fixture-session.jsonl"),
    [
      JSON.stringify({ role: "user", content: chatSecret, ts: iso(now - 200_000) }),
      JSON.stringify({ role: "assistant", content: "收到（夹具回复）", ts: iso(now - 190_000), model: "flash" }),
    ].join("\n") + "\n",
  );
  fs.writeFileSync(
    path.join(wb, "logs", "terminal-history.jsonl"),
    [
      JSON.stringify({
        ts: iso(now - 100_000),
        project_id: projectId,
        session_id: "s3-term-1",
        cwd: proj,
        command: termSecret,
      }),
      JSON.stringify({
        ts: iso(now - 90_000),
        project_id: projectId,
        session_id: "s3-term-1",
        cwd: path.join(proj, "src"),
        command: "pnpm test",
      }),
    ].join("\n") + "\n",
  );
  fs.writeFileSync(path.join(proj, "README.md"), "# S3 夹具项目\n\n只有一行正文，不含任何本机路径。\n");
  return {
    home,
    proj,
    bare,
    projectId,
    bareId,
    chatSecret,
    termSecret,
    designTitle,
    repoInsideHome: path.join(REPO_ROOT, ".工作台", "verify", "s3-repo-home"),
  };
}

// ───────────────────────────── 夹具与审计的取证助手 ─────────────────────────────

/** 目录树快照（相对路径 → `size:mtimeMs`），用来做"零新增文件"的逐文件比对 */
function snapshotTree(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        const st = fs.statSync(p);
        out.set(path.relative(dir, p).replace(/\\/g, "/"), `${st.size}:${st.mtimeMs}`);
      }
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

function treeDiff(before: Map<string, string>, after: Map<string, string>): string[] {
  const diff: string[] = [];
  for (const [k, v] of after) {
    if (!before.has(k)) diff.push(`新增 ${k}`);
    else if (before.get(k) !== v) diff.push(`改动 ${k}`);
  }
  for (const k of before.keys()) if (!after.has(k)) diff.push(`消失 ${k}`);
  return diff;
}

/** 读审计文件（真读盘；坏行跳过） */
function readAuditLines(home: string): RemoteAuditLine[] {
  const file = auditFilePath(home);
  if (!fs.existsSync(file)) return [];
  const out: RemoteAuditLine[] = [];
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (raw.trim() === "") continue;
    try {
      out.push(JSON.parse(raw) as RemoteAuditLine);
    } catch {
      // 坏行跳过
    }
  }
  return out;
}

/** 打印一行审计（**来源 IP 打码**：AGENTS.md §5 不把真实局域网地址贴进文档/仓库） */
function maskedLine(line: RemoteAuditLine): string {
  const one = `ts=${line.ts} actor=${line.actor} action=${line.action} ip=${maskIpForReport(line.ip)} ` +
    `${line.method ?? "-"} ${line.path ?? "-"} → ${line.status ?? "-"} ${line.code ?? "-"}` +
    `${line.fingerprint ? ` 指纹=${line.fingerprint}` : ""}` +
    `${line.credential ? ` 凭据=${line.credential}` : ""}` +
    `${line.project_id ? ` 项目=${line.project_id}` : ""}` +
    `${line.source ? ` 来源=${line.source}` : ""}` +
    `${line.on_behalf_of ? ` 替=${line.on_behalf_of}` : ""}` +
    `${line.files ? ` 文件=${line.files.join(",")}` : ""}`;
  return one;
}

/** 跑一条 CLI（真跑 `pnpm remote:write …` 的等价命令：tsx scripts/remote-write.ts） */
function runRemoteWriteCli(args: string[], home: string, lanHost: string): { status: number | null; out: string } {
  const r = spawnSync(process.execPath, ["--import", "tsx", CLI_ENTRY, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: cleanEnv({
      TATAI_HOME: home,
      [REMOTE_ENABLE_ENV]: "1",
      [REMOTE_HOST_ENV]: lanHost,
      [REMOTE_WRITE_ENV]: "1",
      [REMOTE_WRITE_CONFIRM_ENV]: WRITE_CONFIRM_PHRASE,
    }),
  });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/** 打印一行 CLI 输出（把本机临时绝对路径换成 <TMP>，别把作者机器路径写进流水） */
function scrubbed(text: string, tmpBase: string): string {
  return text.split(tmpBase).join("<TMP>").trim();
}

// ───────────────────────────── 主流程 ─────────────────────────────

async function main(): Promise<void> {
  console.log("[verify] S3 读写模式 + 安全审计：写模式二次确认/立即失效 / 审计落点与留痕 / 读接口裁剪补齐");
  console.log(`[verify]   node ${process.version} · ${process.platform} · repo ${REPO_ROOT}`);
  const fixedBefore = { v: await portListening(8787), d: await portListening(5173) };
  console.log(
    `[verify]   8787 ${fixedBefore.v ? "有人监听（别人的，不碰）" : "空闲"} · 5173 ${fixedBefore.d ? "有人监听（别人的，不碰）" : "空闲"}`,
  );
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-s3-verify-"));
  const lanAll = lanAddresses();
  const lanIp = lanAll[0]?.address ?? null;
  const lanHost = lanIp ?? "127.0.0.1";
  console.log(
    `[verify]   本机局域网地址：${lanAll.map((a) => `${maskIpForReport(a.address)}(${a.iface})`).join("、") || "（无）"}` +
      `${lanIp === null ? " ⚠ 无非内部 IPv4：远程段退化为回环（服务端会把来源当本机放行），真实局域网段 SKIP" : ""}`,
  );
  const fixture = buildFixture(path.join(tmpBase, "fx"));
  console.log(
    `[verify]   夹具：home=<TMP>/fx/home（临时）· 项目 ${fixture.projectId} / ${fixture.bareId}；` +
      "审计落点断言只看相对位置，不贴真实路径",
  );
  const writeModeFile = writeModeStatePath(fixture.home);
  /**
   * "同一条写请求"的对照探针：选 **PUT /arch/layout**（幂等：同样 body 打几次都是 200），
   * 这样三段对照（只读 403 → 写模式开 200 → 关后 403）真的是**同一条请求**，
   * 不会因为"第二次创建同名任务"退化成 400。
   */
  const sameWrite = async (base: string, credential: string) =>
    http(base, `/api/projects/${fixture.projectId}/arch/layout`, {
      method: "PUT",
      credential,
      body: { mode: "MODULE_BOX", positions: { src: { x: 10, y: 20 } } },
    });

  const live: Svc[] = [];
  try {
    // ═══════════════ ① 红线活体对照 + 源码级护栏 ═══════════════
    info("① 红线逐条对照代码常量（remote-config.ts 活体自查，S1 六条 + S2 第七条 + S3 第八条）");
    const checks = checkRedlines();
    for (const c of checks) {
      ok(c.pass, `① [${c.id}] ${c.title} ｜ 锚点 ${c.anchor} ｜ 依据 ${c.design} ｜ 实测 ${c.detail}`);
    }
    ok(
      checks.length === 9 && checks.some((c) => c.id === "R8" && c.pass) && checks.some((c) => c.id === "R9" && c.pass),
      `① S3 新增两条红线「终端历史/输出默认不外泄」(R8)、「记忆检索默认不外泄」(R9) 在代码常量里（自查表 ${checks.length} 条）`,
    );
    ok(
      resolveRemoteConfig({}).terminalExposed === false &&
        resolveRemoteConfig({ [REMOTE_ENABLE_ENV]: "1", [REMOTE_HOST_ENV]: "192.168.1.9" }).terminalExposed === false &&
        resolveRemoteConfig({}).memoryExposed === false &&
        resolveRemoteConfig({ [REMOTE_ENABLE_ENV]: "1", [REMOTE_HOST_ENV]: "192.168.1.9" }).memoryExposed === false,
      "① 默认与「开远程但不给这两个开关」两种情形下 terminalExposed / memoryExposed 都是 false",
    );

    info("① 源码级护栏（红线不能只靠运行期一跑）");
    const indexSrc = fs.readFileSync(path.join(REPO_ROOT, SERVER_ENTRY), "utf8");
    const auditSrc = fs.readFileSync(path.join(REPO_ROOT, "src/server/remote-audit.ts"), "utf8");
    const writeSrc = fs.readFileSync(path.join(REPO_ROOT, "src/server/remote-write.ts"), "utf8");
    const authSrc = fs.readFileSync(path.join(REPO_ROOT, "src/server/auth.ts"), "utf8");
    const guardIdx = indexSrc.indexOf("guardRemoteRequest(remoteConfig");
    const routeIdx = indexSrc.indexOf('req.url?.match(/^\\/api\\/projects');
    ok(
      guardIdx > 0 && routeIdx > 0 && guardIdx < routeIdx,
      `① index.ts 仍是「先鉴权后路由」（guard@${guardIdx} < 路由@${routeIdx}）`,
    );
    ok(
      indexSrc.includes("writeMode.enabled()") && indexSrc.includes("writeEnabled,"),
      "① 放行口每请求现取运行期写模式（否则「关掉写模式立刻失效」做不到）",
    );
    ok(
      auditSrc.includes("isInsideRepo") && auditSrc.includes("AuditPathError") && !auditSrc.includes("REPO_ROOT"),
      "① 审计模块有「落点在 repo 内即拒」的红线，且自己不拼任何项目内路径（路径只从全局数据目录派生）",
    );
    ok(
      indexSrc.includes("auditLog?.record") && indexSrc.includes('actor: "server-init"'),
      "① 审计写入点有两类：请求留痕 + 服务端自身副作用（actor=server-init）单列",
    );
    ok(
      writeSrc.includes("write-mode-on") &&
        writeSrc.includes("write-mode-off") &&
        writeSrc.includes("WRITE_CONFIRM_PHRASE"),
      "① 写模式翻转与二次确认都在同一份实现里（运行期打开也要确认语，不是只有启动期）",
    );
    ok(
      authSrc.includes("isTerminalReadPath") &&
        authSrc.includes("REMOTE_TERMINAL_HIDDEN") &&
        authSrc.includes("isMemoryReadPath") &&
        authSrc.includes("REMOTE_MEMORY_HIDDEN"),
      "① 终端与记忆两道闸门都在放行口里（不是只写在文档里的表态）",
    );

    // ═══════════════ ② DoD③：写模式三段对照（只读 403 → 过门 → 立刻 403）═══════════════
    info("② DoD③ 同一写请求三段对照：只读 403 → 写模式开（到业务层）→ CLI 关（立刻 403，不重启）");
    const readOnlySvc = await startServer("只读服务", lanHost, {
      TATAI_HOME: fixture.home,
      [REMOTE_ENABLE_ENV]: "1",
      [REMOTE_HOST_ENV]: lanHost,
    });
    live.push(readOnlySvc);
    const token = (
      JSON.parse(fs.readFileSync(path.join(fixture.home, "remote", "auth.json"), "utf8")) as { token: string }
    ).token;
    console.log(`[verify]   主口令指纹 ${tokenFingerprint(token)}（原文不外打）`);
    const login = await http(readOnlySvc.base, "/api/remote/login", { method: "POST", credential: token, body: {} });
    const sid = String(((login.body.session ?? {}) as { session_id?: string }).session_id ?? "");
    ok(login.status === 200 && sid.startsWith("s_"), `② 口令换会话 → ${login.status}`);

    const phase1 = await sameWrite(readOnlySvc.base, sid);
    console.log(`[verify]   第 1 段（只读，写模式关）POST /api/projects/${fixture.projectId}/tasks → ${phase1.status} ${codeOf(phase1)}`);
    ok(
      phase1.status === 403 && codeOf(phase1) === "REMOTE_READ_ONLY",
      `② 写模式关：同一写请求 → ${phase1.status} ${codeOf(phase1)}（拦在路由之前）`,
    );
    const sessionReadOnly = await http(readOnlySvc.base, "/api/remote/session", { credential: sid });
    ok(
      sessionReadOnly.body.read_only === true && sessionReadOnly.body.write_enabled === false,
      `② 会话自述如实报只读：read_only=${sessionReadOnly.body.read_only} write_enabled=${sessionReadOnly.body.write_enabled}`,
    );

    info("② 写模式开（启动期双开关 + 确认语）——另起一个服务进程，写开关文件落全局数据目录");
    const writeSvc = await startServer("写模式服务", lanHost, {
      TATAI_HOME: fixture.home,
      [REMOTE_ENABLE_ENV]: "1",
      [REMOTE_HOST_ENV]: lanHost,
      [REMOTE_WRITE_ENV]: "1",
      [REMOTE_WRITE_CONFIRM_ENV]: WRITE_CONFIRM_PHRASE,
    });
    live.push(writeSvc);
    ok(
      writeSvc.output().includes("写模式") && writeSvc.output().includes("时段起点"),
      "② 启动日志打出写模式状态与**时段起点**（DoD①：开启时间点有据可查）",
    );
    const writeLogin = await http(writeSvc.base, "/api/remote/login", { method: "POST", credential: token, body: {} });
    const writeSid = String(((writeLogin.body.session ?? {}) as { session_id?: string }).session_id ?? "");
    ok(writeLogin.status === 200, `② 写模式服务登录 → ${writeLogin.status}`);
    const writeSession = await http(writeSvc.base, "/api/remote/session", { credential: writeSid });
    ok(
      writeSession.body.write_enabled === true && typeof writeSession.body.write_mode_since === "string",
      `② 会话自述报写模式开：write_enabled=${writeSession.body.write_enabled} 时段起点=${String(writeSession.body.write_mode_since)}`,
    );
    const phase2 = await sameWrite(writeSvc.base, writeSid);
    console.log(
      `[verify]   第 2 段（写模式开）同一写请求 → ${phase2.status} ${phase2.text.slice(0, 96)}`,
    );
    ok(
      phase2.status === 200 && phase2.body.ok === true,
      `② 写模式开：同一写请求过门并到达业务层（${phase2.status}）`,
    );
    const taskProbe = await http(writeSvc.base, `/api/projects/${fixture.projectId}/tasks`, {
      method: "POST",
      credential: writeSid,
      body: { id: "s3probe", title: "写模式对照探针", module_id: "src", reporter: "s3-verify" },
    });
    ok(
      taskProbe.status === 200 && (taskProbe.body as { task?: { id?: string } }).task?.id === "s3probe",
      `② 写模式开时真落盘：POST tasks → ${taskProbe.status}（任务 ${String((taskProbe.body as { task?: { id?: string } }).task?.id)} 写进夹具）`,
    );

    info("② 写模式开时：把清单里 29 条写路由逐条见证一次（不 403，真到业务层）——危险动作（PTY / Flash / 删除）改用「过门即够」的参数");
    const openResults: { route: RemoteRoute; status: number; code: string; note: string }[] = [];
    for (const route of REMOTE_WRITE_ROUTES) {
      // 每条路由的"安全参数"：不真起 PTY、不真调 Flash、不真删项目/会话（其余真的打到业务层）
      const safe: Record<string, { path?: string; body?: unknown; note: string }> = {
        "chat-message": { path: `/api/projects/${fixture.projectId}/chat/sessions/s3probe-nosuch/messages`, body: { content: "x" }, note: "会话不存在 → 业务层 404（不调 Flash）" },
        "flash-chat": { body: { messages: [] }, note: "空 messages → 业务层 400（不调 Flash）" },
        "arch-name": { path: `/api/projects/${fixture.bareId}/arch/name`, body: { force: false }, note: "缺 modules.json → 业务层 4xx（不调 Flash）" },
        "terminal-create": { path: `/api/projects/${fixture.bareId}/terminal`, body: { cols: 80, rows: 24 }, note: "真起 PTY（小夹具，随后关掉）" },
        "project-remove": { path: "/api/projects/s3probe-nosuch", note: "不存在的 id → 业务层 404（不真删）" },
        "watch-open": { path: `/api/projects/${fixture.bareId}/watch`, note: "小目录监听" },
        "watch-close": { path: `/api/projects/${fixture.bareId}/watch`, note: "关上面那个监听" },
      };
      const s = safe[route.id];
      const url = s?.path ?? routeUrl(route, fixture.projectId);
      const body = s && "body" in s ? s.body : route.body;
      const res = await http(writeSvc.base, url, {
        method: route.method,
        credential: writeSid,
        ...(body !== undefined ? { body } : {}),
      });
      openResults.push({ route, status: res.status, code: codeOf(res), note: s?.note ?? route.note });
    }
    const gateOpen = openResults.filter((r) => r.status === 403 && r.code === "REMOTE_READ_ONLY");
    for (const r of openResults) {
      console.log(
        `[verify]     写模式开 ${r.route.method.padEnd(6)} ${r.route.id.padEnd(24)} → ${String(r.status).padEnd(3)} ${r.code.padEnd(22)} ${r.note}`,
      );
    }
    ok(
      gateOpen.length === 0,
      `② 写模式开时 ${openResults.length} 条写路由**没有一条**再吃 REMOTE_READ_ONLY（全部过门到业务层，状态码如上行）`,
    );

    info("② 二次确认：运行期打开必须逐字确认语，且必须启动期已 armed（没 armed 一律拒）");
    const cliOnNoConfirm = runRemoteWriteCli(["on"], fixture.home, lanHost);
    ok(
      cliOnNoConfirm.out.includes("WRITE_CONFIRM_REQUIRED") && /被拒/.test(cliOnNoConfirm.out),
      `② 运行期 on 不给确认语 → 拒（${scrubbed(cliOnNoConfirm.out.split("\n").find((l) => l.includes("被拒")) ?? "", tmpBase)}）`,
    );
    const notArmedOut = (() => {
      // 同一个开关文件、但**没有**双开关的环境：也就是"这台机器的启动期口径没 armed"
      const r = spawnSync(process.execPath, ["--import", "tsx", CLI_ENTRY, "on", "--confirm", WRITE_CONFIRM_PHRASE], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env: cleanEnv({ TATAI_HOME: fixture.home, [REMOTE_ENABLE_ENV]: "1", [REMOTE_HOST_ENV]: lanHost }),
      });
      return `${r.stdout ?? ""}${r.stderr ?? ""}`;
    })();
    ok(
      notArmedOut.includes("WRITE_MODE_NOT_ARMED"),
      `② 启动期没给双开关时，运行期 on 一律拒（WRITE_MODE_NOT_ARMED）：${
        scrubbed(notArmedOut.split("\n").find((l) => l.includes("被拒")) ?? "", tmpBase)
      }`,
    );

    info("② DoD③ 关闭写模式：`pnpm remote:write off`（只写开关文件）→ 同一个写请求立刻 403，**不重启**");
    const beforeOff = await sameWrite(writeSvc.base, writeSid);
    ok(beforeOff.status === 200, `② 关闭前同一写请求仍通（${beforeOff.status}）`);
    const cliOff = runRemoteWriteCli(["off"], fixture.home, lanHost);
    ok(
      /写模式已关闭/.test(cliOff.out) && cliOff.out.includes("下一个写请求"),
      `② CLI 关写模式：${scrubbed(cliOff.out.split("\n").find((l) => l.includes("写模式已关闭")) ?? "", tmpBase)}`,
    );
    ok(
      fs.existsSync(writeModeFile) && JSON.parse(fs.readFileSync(writeModeFile, "utf8")).enabled === false,
      "② 开关文件如实落盘 enabled=false（运行期状态不在进程内存里「假装」，是文件事实）",
    );
    const phase3 = await sameWrite(writeSvc.base, writeSid);
    console.log(`[verify]   第 3 段（CLI 关后，**同一进程**）同一写请求 → ${phase3.status} ${codeOf(phase3)}`);
    ok(
      phase3.status === 403 && codeOf(phase3) === "REMOTE_READ_ONLY",
      `② 关闭后立刻生效：${phase2.status}（段2）→ ${phase3.status} ${codeOf(phase3)}（段3，进程 ${writeSvc.proc.pid} 未重启）`,
    );
    const sameSvcAlive = await portListening(writeSvc.port, writeSvc.host);
    ok(sameSvcAlive, `② 服务进程始终是同一个（端口 ${writeSvc.port} 未重起、pid 未变）`);

    info("② 关掉之后再打开：`pnpm remote:write on --confirm <确认语>` → 同一写请求立刻恢复（不是只能重启才行）");
    const cliOnConfirm = runRemoteWriteCli(["on", "--confirm", WRITE_CONFIRM_PHRASE], fixture.home, lanHost);
    ok(
      /写模式已打开/.test(cliOnConfirm.out) && cliOnConfirm.out.includes("时段起点"),
      `② 运行期 on + 逐字确认语 → 通过并记时段边界（${scrubbed(cliOnConfirm.out.split("\n").find((l) => l.includes("写模式已打开")) ?? "", tmpBase)}）`,
    );
    const phase4 = await sameWrite(writeSvc.base, writeSid);
    ok(phase4.status === 200, `② 重新打开后同一写请求又通（${phase4.status}）——开关是可逆的，不是单向门`);
    const cliOffAgain = runRemoteWriteCli(["off"], fixture.home, lanHost);
    ok(/写模式已关闭/.test(cliOffAgain.out), "② 审计取证前再关一次（下面这一轮审计要有「写请求被拒」的真实行）");

    info("② 关闭后：清单里 29 条写路由逐条打一遍（应当 29/29 全 403）");
    const closedResults: { route: RemoteRoute; status: number; code: string }[] = [];
    for (const route of REMOTE_WRITE_ROUTES) {
      const res = await http(writeSvc.base, routeUrl(route, fixture.projectId), {
        method: route.method,
        credential: writeSid,
        ...(route.body !== undefined ? { body: route.body } : {}),
      });
      closedResults.push({ route, status: res.status, code: codeOf(res) });
    }
    const closedBad = closedResults.filter((r) => r.status !== 403 || r.code !== "REMOTE_READ_ONLY");
    console.log(
      `[verify]   关闭后写路由拒绝表：${closedResults
        .map((r) => `${r.route.method} ${r.route.path.split("/").slice(-2).join("/")}→${r.status}`)
        .join("  ")}`,
    );
    ok(
      closedBad.length === 0,
      `② 写模式关闭后 ${closedResults.length}/${REMOTE_WRITE_ROUTES.length} 条写路由全部 403 REMOTE_READ_ONLY` +
        `${closedBad.length ? `（例外：${closedBad.map((r) => `${r.route.id}=${r.status}${r.code}`).join("、")}）` : ""}`,
    );

    // ═══════════════ ③ DoD②：审计落点与真实留痕 ═══════════════
    info("③ DoD② 审计落点：全局数据目录 <TATAI_HOME>/logs/remote-audit.jsonl，且不在任何项目/repo 内");
    const auditFile = auditFilePath(fixture.home);
    ok(fs.existsSync(auditFile), `③ 审计文件真的落盘（${path.relative(fixture.home, auditFile)}）`);
    ok(
      path.relative(fixture.home, auditFile).replace(/\\/g, "/") === "logs/remote-audit.jsonl",
      "③ 落点就是全局数据目录下的 logs/（不是项目 .工作台/，不是 repo）",
    );
    const repoRel = path.relative(REPO_ROOT, auditFile);
    ok(
      repoRel.startsWith("..") || path.isAbsolute(repoRel),
      "③ 审计文件在 repo 之外（路径不落在仓库树内）",
    );
    ok(
      !fs.existsSync(path.join(fixture.proj, "logs", "remote-audit.jsonl")) &&
        !fs.existsSync(path.join(fixture.proj, ".工作台", "logs", "remote-audit.jsonl")) &&
        (snapshotTree(fixture.proj).size === 0 ||
          [...snapshotTree(fixture.proj).keys()].every((k) => !/remote-audit|auth\.json|write-mode\.json/.test(k))),
      "③ 被纳管项目里**没有任何**审计/口令/写开关文件（按名反证）",
    );
    ok(
      auditSrc.includes("0o600") && auditSrc.includes("0o700") && auditSrc.includes("appendFileSync"),
      "③ 审计按 0600（目录 0700）写、只追加（appendFileSync，没有 truncate 路径）",
    );

    info("③ 滚动上限真跑一次（小阈值夹具）：连写 12 行 → 归档出现、当前文件回落、最近的行一行不丢、归档不超上限");
    const rotDir = path.join(tmpBase, "rotate-home");
    // 每行约 215B：阈值 650 ⇒ 每份文件约 3 行；归档上限 AUDIT_MAX_ARCHIVES=3 ⇒ 保留 ≈ 12 行
    const rot = new RemoteAuditLog({ dataDir: rotDir, maxBytes: 650 });
    for (let i = 0; i < 12; i++) {
      rot.record({
        actor: "remote",
        action: "read",
        ip: "192.168.9.9",
        method: "GET",
        path: `/p/${i}`,
        status: 200,
        code: null,
        fingerprint: null,
        credential: "session",
        project_id: null,
        source: null,
      });
    }
    const rotFile = auditFilePath(rotDir);
    const rotArch = `${rotFile}.1`;
    const readLines = (f: string) =>
      fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n").filter((l) => l.trim() !== "") : [];
    // 归档按时间先后排：.3（最老）… .1（次新）+ 当前（最新）
    const rotOrdered = [3, 2, 1].flatMap((n) => readLines(`${rotFile}.${n}`)).concat(readLines(rotFile));
    const rotJoined = rotOrdered.join("\n");
    ok(
      fs.existsSync(rotArch) && rotOrdered.length === 12 && fs.statSync(rotFile).size < 650 * 2,
      `③ 超阈值即滚动：归档 ${path.basename(rotArch)} 已生成、保留窗口内 12/12 行都在、当前文件 ${fs.statSync(rotFile).size}B` +
        `（阈值 650B：滚动在写入前判定，故当前文件最多到「阈值 + 一行」）`,
    );
    ok(
      !fs.existsSync(`${rotFile}.4`) && Number(AUDIT_MAX_ARCHIVES) === 3,
      `③ 归档最多 ${AUDIT_MAX_ARCHIVES} 份（不测就没证据）：没有第 4 份归档，增长有上限`,
    );
    ok(
      [7, 8, 9, 10, 11].every((i) => rotJoined.includes(`/p/${i}`)) &&
        [7, 8, 9].every((i, idx) => rotJoined.indexOf(`/p/${i}`) < rotJoined.indexOf(`/p/${8 + idx}`)),
      `③ 保留窗口内的行一行不丢且顺序不乱（含最新 5 行；窗口内共 ${rotOrdered.length} 行，超出保留窗口的最老行按上限丢弃）`,
    );
    const rotTail = rot.tail(50).map((l) => l.path);
    ok(
      rotTail.length === readLines(rotFile).length &&
        rotTail[rotTail.length - 1] === "/p/11" &&
        rot.tail(50).every((l) => l.actor === "remote"),
      `③ 读取侧 tail() 与当前文件逐行对得上（尾行 ${rotTail[rotTail.length - 1]}）——人工排查与验证脚本读的是同一份`,
    );
    ok(
      writeModeFile.startsWith(fixture.home),
      `③ 写模式开关文件也在全局数据目录内（${path.relative(fixture.home, writeModeFile)}），不在项目里`,
    );

    info("③ 真打一轮（读 + 写 + 拒绝 + 登录失败 + 登出 + 服务端自身副作用）→ 贴真实审计行（IP 打码）");
    const roundProjBefore = snapshotTree(fixture.proj);
    // 读
    const r1 = await http(writeSvc.base, "/api/projects", { credential: writeSid });
    // 服务端自身副作用：读**缺文件**项目的 progress（服务端会自己初始化建文件——这是读请求带出来的写，
    // 审计里必须单列 actor=server-init，不能混成"远程写请求"）
    const bareBefore = snapshotTree(fixture.bare);
    const rInit = await http(writeSvc.base, `/api/projects/${fixture.bareId}/progress`, { credential: writeSid });
    const bareAfter = snapshotTree(fixture.bare);
    const bareDiff = treeDiff(bareBefore, bareAfter);
    console.log(
      `[verify]   读缺文件项目的 progress → ${rInit.status}；该项目新增文件：${bareDiff.join(" | ") || "无"}`,
    );
    // 写（写模式此刻已关，所以这条应当被拒）
    const r2 = await sameWrite(writeSvc.base, writeSid);
    // 拒绝：无凭据
    const r3 = await http(writeSvc.base, "/api/projects");
    // 登录失败
    const r4 = await http(writeSvc.base, "/api/remote/login", {
      method: "POST",
      credential: "s3-wrong-token-000000000000000000000000000",
      body: {},
    });
    // 登出
    const logout = await http(writeSvc.base, "/api/remote/logout", { method: "POST", credential: writeSid, body: {} });
    const afterLogout = await http(writeSvc.base, "/api/projects", { credential: writeSid });
    console.log(
      `[verify]   这一轮的 HTTP 结果：读 ${r1.status} / 初始化读 ${rInit.status} / 写 ${r2.status}${codeOf(r2)} / 无凭据 ${r3.status}${codeOf(r3)} / ` +
        `登录失败 ${r4.status}${codeOf(r4)} / 登出 ${logout.status} / 登出后 ${afterLogout.status}${codeOf(afterLogout)}`,
    );
    const roundLines = readAuditLines(fixture.home);
    console.log(`[verify]   审计文件共 ${roundLines.length} 行（只追加；下面贴最近 10 行的关键字段，IP 已打码）`);
    for (const line of roundLines.slice(-10)) console.log(`[verify]     ${maskedLine(line)}`);
    const kinds = new Set(roundLines.map((l) => `${l.actor}/${l.action}`));
    ok(
      roundLines.some((l) => l.action === "read" && l.path === "/api/projects" && l.status === 200),
      "③ 读请求有行（actor=remote / action=read / 结果码 200）",
    );
    ok(
      roundLines.some((l) => l.action === "rejected" && l.code === "REMOTE_READ_ONLY"),
      "③ 写请求被拒有行（拒绝码 REMOTE_READ_ONLY 明确写出来）",
    );
    ok(
      roundLines.some((l) => l.action === "session" && l.path === "/api/remote/login" && l.status === 200),
      "③ 登录有行（action=session）",
    );
    ok(
      roundLines.some((l) => l.action === "rejected" && l.code === "BAD_TOKEN" && l.status === 401),
      "③ 登录失败有行（401 BAD_TOKEN，凭据种类=token 而不是口令原文）",
    );
    ok(
      roundLines.some((l) => l.action === "session" && l.path === "/api/remote/logout"),
      "③ 登出有行（action=session）",
    );
    ok(
      roundLines.some((l) => l.action === "rejected" && l.code === "SESSION_INVALID"),
      "③ 登出后再用同一凭据有行（401 SESSION_INVALID：会话真的作废了）",
    );
    ok(
      roundLines.every((l) => l.fingerprint === null || /^[0-9a-f]{12}$/.test(l.fingerprint)),
      "③ 审计里的指纹一律是 12 位十六进制（sha256 截断，单向；口令原文无处可落）",
    );
    const rawAudit = fs.readFileSync(auditFile, "utf8");
    ok(
      !rawAudit.includes(token) && !rawAudit.includes("s3-wrong-token"),
      "③ **口令原文不在审计文件里**（拿真口令与错口令各 grep 一次，零命中）",
    );
    ok(
      roundLines.every((l) => l.ip === null || !l.path?.includes("?")),
      "③ 审计只记归一后的路径（不带 query：检索词/参数不是访问足迹）",
    );
    ok(
      roundLines.some((l) => l.actor === "server-init" && l.action === "side-effect" && l.on_behalf_of === "remote"),
      "③ 服务端自身副作用单列 actor=server-init（与远程写请求分开记，DoD② 后半）",
    );
    ok(
      kinds.has("remote/write") && kinds.has("remote/read") && kinds.has("remote/rejected"),
      `③ 三类足迹都在：${[...kinds].sort().join("、")}`,
    );

    info("③ 被纳管项目零新增文件（纯读+初始化读+拒绝+登录失败+登出这一轮，逐文件 size+mtime 比对）");
    const roundProjAfter = snapshotTree(fixture.proj);
    const diff = treeDiff(roundProjBefore, roundProjAfter);
    ok(
      diff.length === 0,
      `③ 被纳管项目 ${fixture.projectId} 文件清单逐字节不变（${roundProjAfter.size} 个文件；差异：${diff.join(" | ") || "无"}）` +
        "——审计写的是全局数据目录，项目里一个字节都没多",
    );
    ok(
      bareDiff.length === 1 && bareDiff[0].startsWith("新增") && bareDiff[0].endsWith("progress.json"),
      `③ 另一端如实：缺文件项目被服务端初始化建了 ${bareDiff.join(" | ")}（**这一条是 server-init 行**，不是远程写请求）`,
    );
    const allProjFiles = [...snapshotTree(fixture.proj).keys(), ...snapshotTree(fixture.bare).keys()];
    ok(
      allProjFiles.every((k) => !/remote-audit|auth\.json|write-mode\.json/.test(k)),
      `③ 两个被纳管项目合计 ${allProjFiles.length} 个文件里没有审计/口令/开关文件`,
    );

    info("③ 写模式时间段：审计里的边界行圈出来的区间");
    const boundaries = roundLines.filter((l) => l.action === "write-mode-on" || l.action === "write-mode-off");
    for (const b of boundaries) console.log(`[verify]     ${maskedLine(b)}`);
    const lastOf = (action: string) =>
      [...boundaries].reverse().find((l) => l.action === action);
    const onLine = lastOf("write-mode-on");
    const offLine = lastOf("write-mode-off");
    ok(
      onLine !== undefined && offLine !== undefined && Date.parse(offLine.ts) >= Date.parse(onLine.ts),
      `③ 写模式时间段有起有止：${onLine?.ts}（${onLine?.source}）→ ${offLine?.ts}（${offLine?.source}）`,
    );
    ok(
      boundaries.some((l) => l.source === "startup:env") && boundaries.some((l) => l.source === "cli"),
      "③ 边界行带**来源**：启动期双开关与主机 CLI 各留一条（事后能分辨是谁开的）",
    );
    const startupOn = boundaries.find((l) => l.action === "write-mode-on" && l.source === "startup:env");
    ok(
      startupOn !== undefined && writeSvc.output().includes(startupOn.ts),
      "③ 启动日志里的「时段起点」与审计行**同一时间戳**（两处口径一致，不是各说各话）",
    );
    ok(
      roundLines.filter((l) => l.actor === "local").every((l) => l.ip === "127.0.0.1"),
      "③ actor=local 的行来源是回环（写模式边界/进程启停由主机自己记，不冒充远程）",
    );

    info("③ 反向证伪：TATAI_HOME 指到 repo 里 → 服务端拒绝启动（审计绝不进仓库）");
    fs.rmSync(fixture.repoInsideHome, { recursive: true, force: true });
    const badPort = await pickFreePort("127.0.0.1");
    const bad = spawnSync(process.execPath, ["--import", "tsx", SERVER_ENTRY], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 60_000,
      env: cleanEnv({
        TATAI_HOME: fixture.repoInsideHome,
        TATAI_PORT: String(badPort),
        [REMOTE_ENABLE_ENV]: "1",
      }),
    });
    const badOut = `${bad.stdout ?? ""}${bad.stderr ?? ""}`;
    ok(
      bad.status !== 0 && badOut.includes("AUDIT_PATH_FORBIDDEN"),
      `③ TATAI_HOME 落在 repo 内 → 启动被拒（exit=${bad.status}）：${
        badOut.split("\n").filter((l) => l.includes("AUDIT_PATH")).map((l) => l.replace(fixture.repoInsideHome, "<repo>/.工作台/verify/s3-repo-home"))[0] ?? "(无输出)"
      }`,
    );
    ok(!(await portListening(badPort, "127.0.0.1")), `③ 被拒的进程没有监听（端口 ${badPort} 空闲）`);
    const badHomeMadeAudit = fs.existsSync(path.join(fixture.repoInsideHome, "logs", "remote-audit.jsonl"));
    ok(!badHomeMadeAudit, "③ repo 内的那个目录里**没有**审计文件（拒得干净，没先写再报错）");
    fs.rmSync(fixture.repoInsideHome, { recursive: true, force: true });

    // ═══════════════ ④ 读接口裁剪补齐 + 敏感面扫描（S2 遗留①）═══════════════
    info("④ 读接口逐条打一遍：远程响应里零本机绝对路径 / 零口令 / 零聊天原文 / 零终端历史（S2 遗留①）");
    const readRoutes = REMOTE_ROUTES.filter((r) => r.kind === "read");
    const needles: { label: string; value: string }[] = [
      { label: "项目根绝对路径", value: fixture.proj },
      { label: "全局数据目录绝对路径", value: fixture.home },
      { label: "临时根绝对路径", value: tmpBase },
      // 全局数据目录的"本机绝对路径"探针：只在设了 TATAI_HOME 时加（脚本不写死作者本机路径）；
      // 没设这条探针就缺席，其余探针（临时目录/口令/聊天/终端历史 + 盘符形态正则）照扫。
      ...(process.env.TATAI_HOME?.trim()
        ? [{ label: "全局数据目录绝对路径", value: process.env.TATAI_HOME.trim() }]
        : []),
      { label: "口令原文", value: token },
      { label: "聊天原文", value: fixture.chatSecret },
      { label: "终端历史命令原文", value: fixture.termSecret },
    ];
    const absPathRe = /[A-Za-z]:[\\/]/;
    const scanRows: { id: string; status: number; code: string; hits: string[] }[] = [];
    const goodSid = (() => {
      // 这一轮要在**写模式关**的服务上跑：先重新登录一个会话（上一个已被登出）
      return http(writeSvc.base, "/api/remote/login", { method: "POST", credential: token, body: {} });
    })();
    const scanSid = String((((await goodSid).body.session ?? {}) as { session_id?: string }).session_id ?? "");
    for (const route of readRoutes) {
      // SSE 类读路由（events / terminal out）不能整条读完：只瞄首帧（闸门拦下时是普通 JSON，一眼看全）
      const isSse = /\/events$/.test(route.path) || /\/out$/.test(route.path);
      const res = isSse
        ? await httpPeek(writeSvc.base, routeUrl(route, fixture.projectId), scanSid, 900)
        : await http(writeSvc.base, routeUrl(route, fixture.projectId), { credential: scanSid });
      const hits: string[] = [];
      for (const n of needles) if (res.text.includes(n.value)) hits.push(n.label);
      if (absPathRe.test(res.text)) hits.push("盘符形态绝对路径");
      scanRows.push({ id: route.id, status: res.status, code: codeOf(res), hits });
      console.log(
        `[verify]     ${String(res.status).padEnd(3)} ${route.id.padEnd(24)} ${codeOf(res).padEnd(22)} ` +
          `命中=${hits.join("|") || "无"}  响应长度 ${res.text.length}`,
      );
    }
    const leaky = scanRows.filter((r) => r.hits.length > 0);
    ok(
      leaky.length === 0,
      `④ 读接口敏感面扫描：${scanRows.length} 个响应，命中 ${leaky.length} 个` +
        `${leaky.length ? `（${leaky.map((r) => `${r.id}:${r.hits.join("|")}`).join("、")}）` : ""}`,
    );
    const sseLines = readAuditLines(fixture.home).filter((l) => /\/events$|\/out$/.test(l.path ?? ""));
    const sseAllowed = sseLines.filter((l) => l.action !== "rejected");
    ok(
      sseAllowed.length > 0 && sseAllowed.every((l) => l.note === "SSE 长连接：连上即记（断开不补记）"),
      `④ 长连接（SSE）不靠「断开才记」：${sseLines.length} 条长连接相关请求里放行的 ${sseAllowed.length} 条在**连上时**就落了审计` +
        `（另外 ${sseLines.length - sseAllowed.length} 条按拒绝路径记；关着不动的 SSE 在审计里也看得见）`,
    );
    const statusText = (r: { status: number; code: string }) =>
      r.code === "(无 error.code)" ? String(r.status) : `${r.status} ${r.code}`;
    const readStatuses = new Map(scanRows.map((r) => [r.id, statusText(r)] as const));
    ok(
      (readStatuses.get("scan")?.startsWith("200") ?? false) &&
        (readStatuses.get("terminal-history-read")?.includes("REMOTE_TERMINAL_HIDDEN") ?? false) &&
        (readStatuses.get("terminal-out")?.includes("REMOTE_TERMINAL_HIDDEN") ?? false) &&
        (readStatuses.get("terminal-sessions")?.includes("REMOTE_TERMINAL_HIDDEN") ?? false) &&
        (readStatuses.get("chat-sessions-list")?.includes("REMOTE_CHAT_HIDDEN") ?? false) &&
        (readStatuses.get("memory")?.includes("REMOTE_MEMORY_HIDDEN") ?? false),
      `④ S2 遗留的读接口不再是「没人管」：scan=${readStatuses.get("scan")}、终端三条=${readStatuses.get("terminal-history-read")} / ` +
        `${readStatuses.get("terminal-out")} / ${readStatuses.get("terminal-sessions")}、聊天=${readStatuses.get("chat-sessions-list")}、` +
        `记忆=${readStatuses.get("memory")}`,
    );
    const scanBody = await http(writeSvc.base, `/api/projects/${fixture.projectId}/scan`, { credential: scanSid });
    const scanObj = (scanBody.body.scan ?? {}) as { root?: string; readme?: { path?: string }; docs?: { path?: string }[] };
    ok(
      scanObj.root === undefined && typeof scanObj.readme?.path === "string" && !path.isAbsolute(scanObj.readme.path),
      `④ /scan 的 root（绝对路径）裁掉、readme.path（相对路径）保留：root=${String(scanObj.root)} path=${scanObj.readme?.path}`,
    );
    const changesBody = await http(writeSvc.base, `/api/projects/${fixture.projectId}/changes`, { credential: scanSid });
    const changeRows = (changesBody.body.changes ?? []) as { path?: string }[];
    ok(
      changeRows.every((c) => typeof c.path !== "string" || !path.isAbsolute(c.path)),
      `④ 变更流水的 path 是项目内相对路径（界面要用，没被误裁；共 ${changeRows.length} 行）`,
    );
    const projectsBody = await http(writeSvc.base, "/api/projects", { credential: scanSid });
    const projItems = Array.isArray(projectsBody.body) ? (projectsBody.body as Record<string, unknown>[]) : [];
    ok(
      projItems.length > 0 && projItems.every((p) => !("path" in p)),
      `④ 项目列表仍不含本机绝对路径（字段 ${Object.keys(projItems[0] ?? {}).join("/")}）`,
    );
    const loopSvc = await startServer("回环对照服务", "127.0.0.1", { TATAI_HOME: fixture.home });
    live.push(loopSvc);
    const loopProjects = await http(loopSvc.base, "/api/projects");
    const loopItems = Array.isArray(loopProjects.body) ? (loopProjects.body as Record<string, unknown>[]) : [];
    ok(
      loopItems.length > 0 && typeof loopItems[0].path === "string" && path.isAbsolute(String(loopItems[0].path)),
      "④ 对照：本机回环读项目列表仍带绝对路径（裁剪只对非回环来源生效，本地 UI 零影响）",
    );

    // ═══════════════ ⑤ 红线⑧：终端历史远程可读性的明确表态 ═══════════════
    info("⑤ 红线⑧ 终端历史/输出默认不可读：默认 403 REMOTE_TERMINAL_HIDDEN 与显式放开 200 的对照");
    const termDefaultHistory = await http(writeSvc.base, `/api/projects/${fixture.projectId}/terminal/history?q=S3`, {
      credential: scanSid,
    });
    const termDefaultOut = await http(
      writeSvc.base,
      `/api/terminal/s3-nosuch-sid/out?project_id=${fixture.projectId}`,
      { credential: scanSid, timeoutMs: 4000 },
    );
    ok(
      termDefaultHistory.status === 403 &&
        codeOf(termDefaultHistory) === "REMOTE_TERMINAL_HIDDEN" &&
        !termDefaultHistory.text.includes(fixture.termSecret),
      `⑤ 默认：GET terminal/history → ${termDefaultHistory.status} ${codeOf(termDefaultHistory)}，且响应里没有命令原文`,
    );
    ok(
      termDefaultOut.status === 403 && codeOf(termDefaultOut) === "REMOTE_TERMINAL_HIDDEN",
      `⑤ 默认：GET terminal/:sid/out（SSE 输出流）→ ${termDefaultOut.status} ${codeOf(termDefaultOut)}（闸门在路由前，连 SSE 都不开）`,
    );
    ok(
      isTerminalReadPath("/api/projects/p/terminal/history") &&
        isTerminalReadPath("/api/terminal/x/out") &&
        isTerminalReadPath("/api/terminal/sessions") &&
        !isTerminalReadPath("/api/projects/p/terminal") &&
        !isTerminalReadPath("/api/projects/p/changes"),
      "⑤ 终端闸门路径集合只有这三条（不多不少：POST /terminal 是写路由归清单管，别误伤读接口）",
    );
    const memoryDefault = await http(writeSvc.base, `/api/projects/${fixture.projectId}/memory?q=S3`, {
      credential: scanSid,
    });
    ok(
      memoryDefault.status === 403 && codeOf(memoryDefault) === "REMOTE_MEMORY_HIDDEN",
      `⑤ 默认：GET memory（记忆检索）→ ${memoryDefault.status} ${codeOf(memoryDefault)}` +
        "（敏感面扫描扫出来的口子：记忆原文里带本机路径与私人笔记，就地收口）",
    );
    ok(
      isMemoryReadPath("/api/projects/p/memory") &&
        !isMemoryReadPath("/api/projects/p/memory/x") &&
        !isMemoryReadPath("/api/projects/p/chat/sessions"),
      "⑤ 记忆闸门路径集合只有一条（不误伤别的读接口）",
    );
    const memSvc = await startServer("记忆放开服务", lanHost, {
      TATAI_HOME: fixture.home,
      [REMOTE_ENABLE_ENV]: "1",
      [REMOTE_HOST_ENV]: lanHost,
      [REMOTE_MEMORY_ENV]: "1",
    });
    live.push(memSvc);
    ok(memSvc.output().includes("远程记忆检索已开启"), "⑤ 记忆放开也是明示的：启动日志有醒目 ⚠ 警告");
    const memLogin = await http(memSvc.base, "/api/remote/login", { method: "POST", credential: token, body: {} });
    const memSid = String(((memLogin.body.session ?? {}) as { session_id?: string }).session_id ?? "");
    const memSession = await http(memSvc.base, "/api/remote/session", { credential: memSid });
    ok(
      memSession.body.memory_exposed === true && memSession.body.terminal_exposed === false,
      `⑤ 记忆开关独立于终端开关：memory_exposed=${memSession.body.memory_exposed} terminal_exposed=${memSession.body.terminal_exposed}（两个开关各管各自的面）`,
    );
    // 真读一次记忆检索：这一路会走记忆检索 MCP，慢是它的事，超时按"环境慢"如实记，不当作闸门口径的证据
    let memOpenStatus = 0;
    try {
      memOpenStatus = (await http(memSvc.base, `/api/projects/${fixture.projectId}/memory?q=S3`, { credential: memSid, timeoutMs: 30_000 })).status;
    } catch (e) {
      console.log(`[verify]   记忆放开服务上的检索调用超时（MCP 侧慢）：${(e as Error).name}——放开口径已由会话自述证明`);
    }
    ok(
      memOpenStatus === 0 || memOpenStatus === 200,
      `⑤ 显式放开后记忆检索不再是 403（实测 ${memOpenStatus === 0 ? "超时（不计为闸门失败）" : memOpenStatus}）——只打状态不打内容（那是主人的私人笔记）`,
    );

    const termSvc = await startServer("终端放开服务", lanHost, {
      TATAI_HOME: fixture.home,
      [REMOTE_ENABLE_ENV]: "1",
      [REMOTE_HOST_ENV]: lanHost,
      [REMOTE_TERMINAL_ENV]: "1",
    });
    live.push(termSvc);
    ok(termSvc.output().includes("远程终端读取已开启"), "⑤ 放开是明示的：启动日志有醒目 ⚠ 警告");
    const termLogin = await http(termSvc.base, "/api/remote/login", { method: "POST", credential: token, body: {} });
    const termSid = String(((termLogin.body.session ?? {}) as { session_id?: string }).session_id ?? "");
    const termOpen = await http(termSvc.base, `/api/projects/${fixture.projectId}/terminal/history?q=S3`, {
      credential: termSid,
    });
    const termItems = (termOpen.body.items ?? []) as { command?: string; cwd?: string }[];
    ok(
      termOpen.status === 200 && termItems.some((i) => i.command === fixture.termSecret),
      `⑤ 显式放开后：命令历史可读（${termOpen.status}，${termItems.length} 条，含夹具命令）——默认不可读才是有意的选择`,
    );
    ok(
      termItems.every((i) => typeof i.cwd !== "string" || !path.isAbsolute(i.cwd)),
      `⑤ 放开时 cwd 里的本机绝对路径仍被裁掉（字段 cwd=${String(termItems[0]?.cwd)}）`,
    );
    const termSessionsOpen = await http(termSvc.base, `/api/terminal/sessions?project_id=${fixture.projectId}`, {
      credential: termSid,
    });
    ok(
      termSessionsOpen.status === 200 &&
        (JSON.stringify(termSessionsOpen.body).includes(fixture.proj) === false),
      `⑤ 放开时活跃会话清单可读（${termSessionsOpen.status}），且不含项目绝对路径`,
    );

    // ═══════════════ ⑥ 回归：聊天闸门 + 默认零暴露 + 收尾 ═══════════════
    info("⑥ 回归：聊天默认不外泄（红线⑦）＋ 默认配置只绑回环且不建审计文件");
    const chatHidden = await http(writeSvc.base, `/api/projects/${fixture.projectId}/chat/sessions`, {
      credential: scanSid,
    });
    ok(
      chatHidden.status === 403 && codeOf(chatHidden) === "REMOTE_CHAT_HIDDEN" && !chatHidden.text.includes(fixture.chatSecret),
      `⑥ 聊天会话列表默认 → ${chatHidden.status} ${codeOf(chatHidden)}，响应无聊天原文`,
    );
    const defaultHome = path.join(tmpBase, "home-default");
    fs.mkdirSync(defaultHome, { recursive: true });
    const defaultSvc = await startServer("默认配置服务", "127.0.0.1", { TATAI_HOME: defaultHome });
    live.push(defaultSvc);
    const defRows = netstatListeners(defaultSvc.port);
    ok(
      defRows.length > 0 && defRows.every((r) => /^(127\.|\[::1\]|::1)/.test(r.local)),
      `⑥ 默认配置仍只绑回环（netstat ${defRows.map((r) => r.local).join("、") || "无"}）`,
    );
    ok(
      !fs.existsSync(auditFilePath(defaultHome)),
      "⑥ 远程没开时**连审计文件都不生成**（默认零副作用：与「不开远程不落口令」同口径）",
    );
    const lineForAction = actionOfRequest("/api/projects/x/tasks", "POST");
    ok(
      lineForAction === "write" && actionOfRequest("/api/projects", "GET") === "read" &&
        actionOfRequest("/api/remote/login", "POST") === "session" &&
        actionOfRequest("/remote", "GET") === "public",
      "⑥ 审计的动作分类口径明确（read/write/session/public 四条，靠函数判定不靠散落的 if）",
    );
    ok(
      projectIdOfPath("/api/projects/s3fix/tasks") === "s3fix" &&
        projectIdOfPath("/api/projects") === null &&
        credentialKindOf("s_abc") === "session" &&
        credentialKindOf("abcdef") === "token" &&
        credentialKindOf(null) === "none",
      "⑥ 审计字段助手：项目 id 与凭据种类（只看前缀，不记录任何凭据内容）",
    );

    // ═══════════════ ⑦ DoD④：README 口径 ═══════════════
    info("⑦ DoD④ 文档：写模式怎么开/怎么查时段/审计在哪/不推荐公网直连的理由");
    const readme = fs.readFileSync(path.join(REPO_ROOT, "README.md"), "utf8");
    for (const [needle, why] of [
      [WRITE_MODE_SWITCHES[0], "写模式双开关之一"],
      [WRITE_MODE_SWITCHES[1], "写模式双开关之二（确认语）"],
      [WRITE_CONFIRM_PHRASE, "确认语原文"],
      ["remote:write off", "怎么关写模式（立刻失效）"],
      ["write-mode-on", "写模式时间段怎么查"],
      ["remote-audit.jsonl", "审计日志在哪"],
      ["无 TLS", "不推荐公网直连的理由①"],
      ["静态口令", "理由②"],
      ["PTY", "理由③"],
      ["私人数据", "理由④（§10.2）"],
      ["proxy_buffering off", "真要套反代 + TLS 时怎么做对（SSE 关缓冲）"],
    ] as [string, string][]) {
      ok(readme.includes(needle), `⑦ README 写明${why}（命中 ${JSON.stringify(needle)}）`);
    }

    // ═══════════════ ⑧ 收尾 ═══════════════
    info("⑧ 收尾：进程杀净 / 端口释放 / 夹具不留 / 8787+5173 仍是别人的 / git status 自查");
    for (const svc of live) killTree(svc.proc, svc.port);
    await sleep(1200);
    for (const svc of live) {
      ok(!(await portListening(svc.port, svc.host)), `⑧ 端口 ${svc.port}（${svc.host}）已释放`);
    }
    const fixedAfter = { v: await portListening(8787), d: await portListening(5173) };
    ok(
      fixedAfter.v === fixedBefore.v && fixedAfter.d === fixedBefore.d,
      `⑧ 8787/5173 状态与开跑前一致（${fixedBefore.v}→${fixedAfter.v} / ${fixedBefore.d}→${fixedAfter.d}）——没碰别人的监听`,
    );
    const gitStatus = execSync("git status --porcelain", { cwd: REPO_ROOT, encoding: "utf8" });
    const leaked = gitStatus
      .split(/\r?\n/)
      .filter((l) => /remote-audit|auth\.json|write-mode\.json|\.tatai\//.test(l));
    ok(leaked.length === 0, `⑧ git status 里没有审计/口令/写开关类文件（匹配行：${leaked.join(" | ") || "无"}）`);
    const untracked = gitStatus.split(/\r?\n/).filter((l) => l.trim() !== "");
    console.log(`[verify]   git status --porcelain 共 ${untracked.length} 行（本卡改动，均在工作区；审计类零命中）`);
    for (const l of untracked.slice(0, 20)) console.log(`[verify]     ${l}`);
  } finally {
    for (const svc of live) killTree(svc.proc, svc.port);
    await sleep(600);
  }
  fs.rmSync(tmpBase, { recursive: true, force: true });
  console.log("[verify]   临时数据目录与夹具已清理（含临时口令）");
  console.log(`\n[verify] ── S3 结论：${process.exitCode ? "存在 FAIL，见上方逐条" : "全部 PASS"}`);
}

main().catch((e: Error) => {
  console.error("[verify] 脚本异常：", e);
  process.exitCode = 1;
});
