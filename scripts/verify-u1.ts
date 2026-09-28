// U1 验证脚本（用 tsx 跑）：Tauri 壳接入（PLAN.md 三期 U1 / DESIGN.md §11.3）。
// 用法：pnpm verify:u1
// 覆盖点（对 U1 DoD 逐条）：
//   ① 产物与配置对齐：vite 产物存在，且 tauri.conf.json 的 frontendDist 真指向它（DoD①）
//   ② 前端只有一份：全前端 45 处 HTTP 全走 apiFetch；src-tauri 里零业务 UI、零自定义命令（DoD① 红线）
//   ③ 本地服务生命周期：按 backend.rs 的**等价命令**真起后端 → /health 200 → 按 backend.rs 的
//      kill 策略 taskkill /T /F 回收 → tasklist 断言零残留（DoD② 的证据）
//   ④ 壳内 origin 的 CORS：白名单内带 ACAO、陌生 origin 不带（DoD① 的前提：壳里前端要真能拿到数据）
//   ⑤ 权限最小：capabilities = core:default + 一条只放 http/https 的 opener:allow-open-url
//      （Q224：站外链接交系统浏览器），无 shell:*（U1 不授予进程调起能力）
//   ⑥ 端口口径四方一致：backend.rs / 后端缺省 / 前端壳内基址 / vite 代理
//   ⑦ 工具链：本机是否具备 Rust + linker（不具备就如实报 blocked 的原因，不假装跑过）
//   ⑧ 仓库卫生：.gitignore 含 target/gen；工具链装在项目外（仓库里不出现 cargo/mingw 产物）
//
// 注：这里**不跑** tauri dev / tauri build（GUI 与长构建不放进验证脚本，命令与结果另记 PROGRESS）。
import { spawn, execSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TAURI_DIR = path.join(REPO_ROOT, "src-tauri");

const ok = (cond: boolean, label: string) => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (!cond) process.exitCode = 1;
};
const read = (p: string) => fs.readFileSync(p, "utf8");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function tryExec(cmd: string): string | null {
  try {
    return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

// ───────────────────────── ① 产物与配置对齐（DoD①） ─────────────────────────

console.log("\n[verify] ── ① 产物与配置对齐：壳加载的就是 vite 的那份产物");

const distIndex = path.join(REPO_ROOT, "dist", "index.html");
ok(fs.existsSync(distIndex), `① vite 产物存在：${path.relative(REPO_ROOT, distIndex)}（pnpm build 的产出）`);

const confPath = path.join(TAURI_DIR, "tauri.conf.json");
const confRaw = read(confPath);
let conf: Record<string, unknown> | null = null;
try {
  conf = JSON.parse(confRaw) as Record<string, unknown>;
  ok(true, `① tauri.conf.json JSON 合法（${confRaw.length} 字节，JSON.parse 通过）`);
} catch (e) {
  ok(false, `① tauri.conf.json JSON 非法：${(e as Error).message}`);
}

if (conf) {
  const build = (conf.build ?? {}) as Record<string, unknown>;
  const frontendDist = String(build.frontendDist ?? "");
  const distAbs = path.resolve(TAURI_DIR, frontendDist);
  ok(
    frontendDist !== "" && fs.existsSync(path.join(distAbs, "index.html")),
    `① frontendDist=${frontendDist} → ${distAbs}（含 index.html，不是另建一套 UI 的目录）`,
  );
  ok(build.devUrl === "http://localhost:5173", `① devUrl=${String(build.devUrl)}（vite 5173，HMR 即 DoD③）`);
  // Q225（第二轮审计）：dev 侧同样要先产出 resources/server——bundle.resources 无条件声明它，
  // 干净克隆里缺了就是 `resource path 'resources\server' doesn't exist` 起不来，
  // 故 beforeDevCommand 从 "pnpm dev" 变成 "pnpm build:server && pnpm dev"——这里只断言"前端那一步仍在"
  ok(
    typeof build.beforeDevCommand === "string" &&
      build.beforeDevCommand.split("&&").map((s) => s.trim()).includes("pnpm dev"),
    `① beforeDevCommand=${String(build.beforeDevCommand)}（含 pnpm dev，前端仍由 vite 出）`,
  );
  // U2 起 beforeBuildCommand 多了一步 pnpm build:server（产出随包后端到 src-tauri/resources/server，
  // 经 bundle.resources 打进包）——这里只断言"前端产物那一步仍在"，随包布局的核对归 verify:u2
  ok(
    typeof build.beforeBuildCommand === "string" &&
      build.beforeBuildCommand.split("&&").map((s) => s.trim()).includes("pnpm build"),
    `① beforeBuildCommand=${String(build.beforeBuildCommand)}（含 pnpm build，前端产物仍由 vite 出）`,
  );
  ok(conf.productName === "Tatai" && typeof conf.identifier === "string", `① productName=${String(conf.productName)} / identifier=${String(conf.identifier)}`);

  const bundle = (conf.bundle ?? {}) as Record<string, unknown>;
  const targets = (bundle.targets ?? []) as string[];
  ok(
    bundle.active === true && targets.includes("nsis") && targets.includes("msi"),
    `① bundle：active=${String(bundle.active)}，Windows 目标=${targets.join("/")}`,
  );
  const icons = (bundle.icon ?? []) as string[];
  const missingIcons = icons.filter((i) => !fs.existsSync(path.join(TAURI_DIR, i)));
  ok(icons.length > 0 && missingIcons.length === 0, `① bundle.icon ${icons.length} 个文件全部存在（缺 ${missingIcons.length}）`);
}

// vite 端口与 devUrl 同口径（各写各的，最容易飘的一处）
const viteSrc = read(path.join(REPO_ROOT, "vite.config.ts"));
const vitePort = /const UI_PORT = (\d+)/.exec(viteSrc)?.[1];
ok(vitePort === "5173" && /strictPort:\s*true/.test(viteSrc), `① vite dev 端口 const UI_PORT=${vitePort} + strictPort（不许偷偷换端口导致壳白屏）`);

// ───────────────────────── ② 前端只有一份（DoD① 红线） ─────────────────────────

console.log("\n[verify] ── ② 前端只有一份：HTTP 出口唯一，壳里没有第二套界面");

const apiSrc = read(path.join(REPO_ROOT, "src", "ui", "api.ts"));
const bareFetch = [...apiSrc.matchAll(/(?<!api)fetch\(/g)].length; // apiFetch( 里的 fetch( 被排除
const callSites = [...apiSrc.matchAll(/await apiFetch\(/g)].length;
// 不变量断言（2026-09-20 R1-B-002）：api.ts 内除 apiFetch 实现外零裸 fetch，导出的请求调用全部经 apiFetch。
// 调用点计数只作诊断输出、不作判据——避免"每加一个接口都要回来改断言"的过期断言反复复发。
ok(
  bareFetch === 1 && callSites > 0,
  `② src/ui/api.ts：除 apiFetch 实现外零裸 fetch、请求全走 apiFetch（裸 ${bareFetch} 处；经 apiFetch 的调用点 ${callSites} 处，仅诊断）`,
);

const envSrc = read(path.join(REPO_ROOT, "src", "ui", "tauri-env.ts"));
// Q224 后前端多了一个 Tauri JS 依赖（@tauri-apps/plugin-opener，只在 src/ui/external-link.ts 里用），
// 这条断言的范围是**探测层自己**：tauri-env.ts 仍是零依赖的极薄一层，不许它去引 Tauri API。
ok(
  /__TAURI_INTERNALS__/.test(envSrc) && !/from\s+"@tauri-apps/.test(envSrc),
  "② 壳内探测极薄：只认 Tauri 注入的 __TAURI_INTERNALS__（探测层自身不引 Tauri JS API；站外链接的 opener 依赖单独在 external-link.ts）",
);
ok(
  /if \(!isTauriShell\(\)\) return "";[\s\S]{0,80}?if \(import\.meta\.env\.DEV\) return "";/.test(envSrc) &&
    /runtimeApiOrigin\(\) \?\? SHELL_API_ORIGIN/.test(envSrc),
  "② 基址口径：非壳内/dev 走相对路径（vite 代理，与浏览器同路），只有打包态才指向壳拉起的后端绝对地址（优先壳注入的实际端口）",
);

const rsFiles = fs.readdirSync(path.join(TAURI_DIR, "src")).filter((f) => f.endsWith(".rs"));
const rsSrc = rsFiles.map((f) => read(path.join(TAURI_DIR, "src", f))).join("\n");
const uiFilesInTauri: string[] = [];
const walk = (dir: string) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "target" || e.name === "gen" || e.name === "icons") continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) walk(abs);
    else if (/\.(tsx|jsx|html|css)$/.test(e.name)) uiFilesInTauri.push(path.relative(REPO_ROOT, abs));
  }
};
walk(TAURI_DIR);
ok(
  uiFilesInTauri.length === 0 && !/generate_handler|tauri::command/.test(rsSrc),
  `② src-tauri 里零 UI 文件（.tsx/.jsx/.html/.css 共 ${uiFilesInTauri.length} 个）、零自定义命令（壳只开窗 + 管进程）`,
);

// ───────────────────── ③ 本地服务生命周期（DoD② 的真实证据） ─────────────────────

console.log("\n[verify] ── ③ 本地服务生命周期：按 backend.rs 的等价命令拉起 → 探活 → 回收 → 断言无残留");

const backendSrc = read(path.join(TAURI_DIR, "src", "backend.rs"));
// 从 Rust 源码里取值，保证"等价脚本"跟壳里跑的是同一条命令、同一套 kill 策略
const devScript = /pnpm_args\(&\["([^"]+)"\]\)/.exec(backendSrc)?.[1];
const rustPort = /DEFAULT_PORT: u16 = (\d+)/.exec(backendSrc)?.[1];
// V09-14 定向更新（2026-09-25，判据不放宽）：壳的收口原语从 `backend.rs` 挪进了同目录的
// 新模块 `proc_tree.rs`（真壳与验证用壳替身 `src-tauri/shell-sim` 编同一份，不另写一套），
// 所以"源码里必须有 taskkill /T /F 这一手"的**取证范围**从单文件扩到 `src-tauri/src/*.rs`
// 全部文件；断言内容（taskkill + /T + /F 与 `RunEvent::ExitRequested|Exit` 的接线）逐字未改。
// 旧期望：`/taskkill…\/T…\/F/` 只对 backend.rs 命中；依据：backend.rs 曾是唯一收口实现处；
// 新期望：对 `src/*.rs` 全体命中；保留意图：壳必须真有整棵树 kill 的兜底，且退出事件接着它。
const shellSrcAll = fs
  .readdirSync(path.join(TAURI_DIR, "src"))
  .filter((f) => f.endsWith(".rs"))
  .map((f) => read(path.join(TAURI_DIR, "src", f)))
  .join("\n");
const killTree =
  /taskkill[\s\S]{0,400}?"\/T"[\s\S]{0,200}?"\/F"/.test(shellSrcAll) &&
  /RunEvent::ExitRequested/.test(read(path.join(TAURI_DIR, "src", "main.rs")));

ok(devScript === "dev:server", `③ backend.rs dev 拉起口径 = pnpm ${devScript}（与仓库既有 dev:server 脚本同一条配方）`);
ok(rustPort === "8787", `③ backend.rs DEFAULT_PORT=${rustPort}`);
ok(
  killTree,
  "③ 回收策略：RunEvent::ExitRequested|Exit → taskkill /PID <pid> /T /F（整棵树）+ Drop 兜底" +
    "（V09-14 起该原语在 src/proc_tree.rs，取证范围＝src-tauri/src/*.rs 全体）",
);

function nodePids(): Set<number> {
  const out = tryExec('tasklist /FI "IMAGENAME eq node.exe" /FO CSV /NH') ?? "";
  const set = new Set<number>();
  for (const line of out.split(/\r?\n/)) {
    const m = /^"node\.exe","(\d+)"/i.exec(line.trim());
    if (m) set.add(Number(m[1]));
  }
  return set;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

function request(
  port: number,
  pathname: string,
  method = "GET",
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: pathname, method, headers, timeout: 3000 }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("timeout", () => req.destroy(new Error("超时")));
    req.on("error", reject);
    req.end();
  });
}

// 临时 TATAI_HOME：只差这一项（壳里用真实 home），避免验证碰真实注册表
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-u1-verify-"));
const port = await freePort();
const before = nodePids();
let child: ChildProcess | null = null;
let spawnLog = "";

try {
  // 等价于 backend.rs：program=cmd，args=["/C","pnpm","dev:server"]，cwd=仓库根，env TATAI_PORT
  child = spawn("cmd", ["/C", "pnpm", devScript!], {
    cwd: REPO_ROOT,
    env: { ...process.env, TATAI_HOME: tmpHome, TATAI_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (c) => (spawnLog += String(c)));
  child.stderr?.on("data", (c) => (spawnLog += String(c)));
  const shellPid = child.pid!;

  let health: { status: number; body: string } | null = null;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await request(port, "/health");
      if (r.status === 200) {
        health = { status: r.status, body: r.body };
        break;
      }
    } catch {
      /* 还没起来 */
    }
    await sleep(250);
  }
  ok(health?.status === 200, `③ 拉起的服务真的活了：GET http://127.0.0.1:${port}/health → ${health?.status ?? "连不上"} ${health?.body ?? ""}`);

  const spawned = [...nodePids()].filter((p) => !before.has(p));
  ok(spawned.length > 0, `③ 子进程树真存在：新 node.exe pid = ${spawned.join("/")}（tsx watch 会再套一层，所以是树不是单进程）`);
  ok(spawned.length >= 2, `③ 进程树深度 ≥2（${spawned.length} 个 node），这正是必须 taskkill /T 而不是只 kill 直接子进程的理由`);

  // ── ④ 壳内 origin 的 CORS ──
  const shellOrigin = "http://tauri.localhost";
  const withOrigin = await request(port, "/health", "GET", { Origin: shellOrigin });
  ok(
    withOrigin.headers["access-control-allow-origin"] === shellOrigin,
    `④ 壳内 origin 放行：GET /health（Origin: ${shellOrigin}）→ ACAO=${String(withOrigin.headers["access-control-allow-origin"])}`,
  );
  const preflight = await request(port, "/api/agents", "OPTIONS", {
    Origin: shellOrigin,
    "Access-Control-Request-Method": "GET",
  });
  ok(
    preflight.status === 204 && preflight.headers["access-control-allow-origin"] === shellOrigin,
    `④ 预检通过：OPTIONS /api/agents → ${preflight.status}，ACAO=${String(preflight.headers["access-control-allow-origin"])}`,
  );
  const evil = await request(port, "/health", "GET", { Origin: "http://evil.example" });
  ok(evil.headers["access-control-allow-origin"] === undefined, "④ 陌生 origin 不放行（窄白名单，不是 *）");
  const noOrigin = await request(port, "/health");
  ok(noOrigin.headers["access-control-allow-origin"] === undefined, "④ 无 Origin 的普通请求不受影响（浏览器里行为不变）");

  // ── 回收：与 backend.rs 同一条 kill 策略 ──
  execSync(`taskkill /PID ${shellPid} /T /F`, { stdio: ["ignore", "pipe", "ignore"] });
  await sleep(1500);

  const survivors = [...nodePids()].filter((p) => spawned.includes(p));
  ok(survivors.length === 0, `③ 回收：taskkill /PID ${shellPid} /T /F 后，${spawned.length} 个 node pid 在 tasklist 全部查不到（残留 ${survivors.join("/") || "无"}）`);

  let refused = false;
  try {
    await request(port, "/health");
  } catch {
    refused = true;
  }
  ok(refused, `③ 回收后端口 ${port} 不再响应（服务真死了，不是只剩空壳）`);

  const tail = spawnLog.trim().split(/\r?\n/).slice(-4);
  ok(tail.length > 0, `③ 子进程输出可回收（stdout/stderr 走管道转发，壳里同样能看到后端日志）：${tail.join(" ｜ ")}`);
} finally {
  if (child && child.exitCode === null) {
    try {
      execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      /* 已经死了 */
    }
  }
  fs.rmSync(tmpHome, { recursive: true, force: true });
}

// ───────────────────────── ⑤ 权限最小（capabilities） ─────────────────────────

console.log("\n[verify] ── ⑤ 权限最小：核心权限 + 一条限定范围的 opener（Q224），不授予 shell:*");

const capDir = path.join(TAURI_DIR, "capabilities");
const capFiles = fs.readdirSync(capDir).filter((f) => f.endsWith(".json"));
type ScopedPerm = { identifier: string; allow?: { url?: string }[] };
const caps = capFiles.map((f) => JSON.parse(read(path.join(capDir, f))) as { identifier: string; windows: string[]; permissions: (string | ScopedPerm)[] });
const allPerms = caps.flatMap((c) => c.permissions ?? []);
const plainPerms = allPerms.filter((p): p is string => typeof p === "string");
const scopedPerms = allPerms.filter((p): p is ScopedPerm => typeof p !== "string");
// Q224（2026-09-19 二轮审计）：壳内点站外链接此前整窗被 WebView2 导航走，处置是交系统浏览器打开
// （opener 插件）。这里随之由"只有 core:default"改为"core:default + **一条窄到 http/https 的**
// opener 授权"：不放行 opener:default（会连 open-path / reveal-item-in-dir / mailto: / tel: 一起给），
// 也不放行任何 shell:* / 进程调起能力——壳仍然不从前端调进程，那两条红线一条没松。
const openerUrls = scopedPerms.flatMap((p) => (p.allow ?? []).map((a) => a.url ?? ""));
ok(
  capFiles.length === 1 &&
    plainPerms.length === 2 &&
    plainPerms.includes("core:default") &&
    plainPerms.includes("dialog:allow-open") &&
    scopedPerms.length === 1 &&
    scopedPerms[0].identifier === "opener:allow-open-url" &&
    openerUrls.length === 2 &&
    openerUrls.every((u) => u === "https://*" || u === "http://*"),
  `⑤ capabilities/${capFiles.join("/")} 的权限 = ${plainPerms.join(",")} + ${scopedPerms.map((p) => `${p.identifier}(${openerUrls.join("|")})`).join(",")}（核心权限 + dialog 只放原生目录选择 + 只放 http/https 的站外打开；零 shell:* ——壳不从前端调进程）`,
);
const winLabels = conf ? ((conf.app as Record<string, unknown>)?.windows as { label: string }[]) ?? [] : [];
ok(
  caps.every((c) => c.windows.length === 1 && c.windows[0] === "main") &&
    winLabels.length === 1 &&
    winLabels[0]?.label === "main",
  `⑤ 能力只挂 main 窗口，且 conf 里恰好一个窗口：${winLabels.map((w) => w.label).join(",")}`,
);

// ───────────────────────── ⑥ 端口口径四方一致 ─────────────────────────

console.log("\n[verify] ── ⑥ 端口口径：壳 / 后端 / 前端 / vite 代理 四处同值");

const serverSrc = read(path.join(REPO_ROOT, "src", "server", "index.ts"));
const serverPort = /process\.env\.TATAI_PORT \?\? (\d+)/.exec(serverSrc)?.[1];
const shellOriginInUi = /SHELL_API_ORIGIN = "(http:\/\/127\.0\.0\.1:(\d+))"/.exec(envSrc);
const viteProxyPort = /TATAI_DEV_API_PORT[\s\S]{0,120}?\?\? "(\d+)"/.exec(viteSrc)?.[1];
const ports = [rustPort, serverPort, shellOriginInUi?.[2], viteProxyPort];
ok(
  ports.every((p) => p === "8787"),
  `⑥ backend.rs=${rustPort} / server 缺省=${serverPort} / 前端壳内基址=${shellOriginInUi?.[2]} / vite 代理=${viteProxyPort} —— 全等于 8787`,
);

// Q36：端口覆盖必须是**双向**的——Rust 认 TATAI_PORT，壳内前端与 CSP 也得认同一个实际端口，
// 否则带自定义端口启动即白屏（前端打 8787、CSP 也拦掉别的端口）。护栏落在四段源码上：
const apiBaseInUi = /runtimeApiOrigin\(\)/.test(envSrc) && /__TATAI_API_ORIGIN__/.test(envSrc);
const rustInjects = /__TATAI_API_ORIGIN__/.test(backendSrc) && /pub fn api_origin_init_script/.test(backendSrc);
const mainWiresIt = /append_invoke_initialization_script\(backend::api_origin_init_script\(\)\)/.test(
  read(path.join(TAURI_DIR, "src", "main.rs")),
);
const cspConf = JSON.parse(confRaw) as { app: { security: { csp: string; devCsp: string } } };
const cspAllowsAnyLoopbackPort = [cspConf.app.security.csp, cspConf.app.security.devCsp].every(
  (c) => /connect-src[^;]*http:\/\/127\.0\.0\.1:\*/.test(c) && /connect-src[^;]*ws:\/\/127\.0\.0\.1:\*/.test(c),
);
ok(
  apiBaseInUi && rustInjects && mainWiresIt && cspAllowsAnyLoopbackPort,
  `⑥ 端口覆盖双向：前端读壳注入的实际地址=${apiBaseInUi} / Rust 注入=${rustInjects} / main.rs 接线=${mainWiresIt} / ` +
    `CSP 放行回环任意端口=${cspAllowsAnyLoopbackPort}（TATAI_PORT 覆盖时前端与 CSP 不再写死 8787）`,
);

// ───────────────────────── ⑦ 工具链现状（如实报） ─────────────────────────

console.log("\n[verify] ── ⑦ 工具链：本机 Rust + linker 是否具备（不具备则记 blocked 的原因）");

const cargoHome = path.join(os.homedir(), ".cargo", "bin", "cargo.exe");
const cargoVer = fs.existsSync(cargoHome) ? tryExec(`"${cargoHome}" --version`) : null;
ok(cargoVer !== null, `⑦ Rust 工具链：${cargoVer ?? "未装"}（按用户安装，未改系统 PATH）`);
const cargoToml = read(path.join(TAURI_DIR, "Cargo.toml"));
ok(/tauri-build = \{ version = "2"/.test(cargoToml) && /tauri = \{ version = "2"/.test(cargoToml), "⑦ Cargo.toml 声明 tauri/tauri-build v2");
ok(
  /windows_subsystem = "windows"/.test(read(path.join(TAURI_DIR, "src", "main.rs"))),
  "⑦ release 构建不带控制台窗口（debug 保留控制台看后端日志）",
);
console.log(
  "[verify] ⑦ 窗口与安装包本脚本不跑（GUI/长构建），命令：pnpm tauri:dev / pnpm tauri:build；" +
    "结果记 PROGRESS.md（工具链缺失时按 blocked 记，不许当 done）",
);

// ───────────────────────── ⑧ 仓库卫生 ─────────────────────────

console.log("\n[verify] ── ⑧ 仓库卫生：构建产物不进 git，工具链在项目外");

const gitignore = read(path.join(REPO_ROOT, ".gitignore"));
ok(
  /src-tauri\/target\//.test(gitignore) && /src-tauri\/gen\//.test(gitignore),
  "⑧ .gitignore 含 src-tauri/target/ 与 src-tauri/gen/（构建产物不进仓库）",
);
const tauriTree = fs.readdirSync(TAURI_DIR).sort();
ok(
  fs.existsSync(path.join(REPO_ROOT, "src-tauri", "README.md")),
  `⑧ 产物目录约定与进程口径写在 src-tauri/README.md（U1 产出项）；src-tauri/ 顶层 = ${tauriTree.join(", ")}`,
);

console.log(`\n[verify] 完成：${process.exitCode === 1 ? "有 FAIL，见上" : "全部 PASS"}`);
