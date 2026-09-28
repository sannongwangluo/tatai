// B1 验证脚本（用 tsx 跑）：项目扫描器，覆盖 B1 卡 DoD 四条 + HTTP 全链路。
// 用法：pnpm verify:b1（真实后端项目目录走 TATAI_DIR_BRAIN；塔台自身＝本仓库，无需环境变量）
// 覆盖点：
//   ① 真实后端项目目录扫描：文件树规模/README 摘要/docs 清单/git log 活跃度全有，贴真实片段 + 耗时
//   ② 塔台自身扫描对照（含 git 活跃度）
//   ③ 含 node_modules 假文件的临时项目 → 噪音被忽略
//   ④ 无 README 无 git 的临时项目 → 明确标记不报错
//   ⑤ 超大目录（单目录 6000 假文件）→ 截断标记且不卡死（贴耗时）
//   ⑥ HTTP 全链路：GET /api/projects/:id/scan 真项目 200；伪造 id 404
// 红线自查：扫描前后对真实目录不写任何文件（本脚本只读扫描，无写动作）。
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanDirectory } from "../src/server/scanner";
import { addProject } from "../src/server/registry";
import { finish, realDir, skip } from "./lib/fixtures";
import { SYNTH_HINT, synthEnabled, synthGitProject } from "./lib/synth";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8795;
const BASE = `http://localhost:${PORT}`;

const ok = (cond: boolean, label: string) => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (!cond) process.exitCode = 1;
};

// 真实项目目录一律从环境变量读（脚本不写死作者本机路径）；缺了 → SKIP 那一段，不当 PASS。
// 塔台自身＝本仓库（不需要环境变量）；另一个真实后端项目由 TATAI_DIR_BRAIN 给。
// TATAI_SYNTH=1 且 TATAI_DIR_BRAIN 没给 → 临时目录造授权合成 git 项目，① 段断言原样跑（Q6）
const DIR_BRAIN = realDir("TATAI_DIR_BRAIN") ?? (synthEnabled() ? synthGitProject() : null);
const DIR_TATAI = realDir("TATAI_DIR_TATAI") ?? REPO_ROOT;
const BRAIN_ID = process.env.TATAI_ID_BACKEND ?? "brain-memory";

// ── ① 真实后端项目目录（DoD①④：结构化结果贴片段 + 耗时）──────────
if (!DIR_BRAIN) {
  skip(
    "① 真实后端项目目录扫描（DoD①）",
    `设 TATAI_DIR_BRAIN=<一个已存在的中型后端项目目录>（可选 TATAI_ID_BACKEND=<注册表 id>）后可跑，${SYNTH_HINT}`,
  );
} else {
  console.log(`\n[verify] ── ① 真实后端项目目录: ${DIR_BRAIN}`);
  // 批3 T17（2026-09-20 审计）：scanDirectory 改 async（遍历每目录让出事件循环）——调用点随改 await
  const brain = await scanDirectory(DIR_BRAIN, BRAIN_ID);
  console.log(`[verify] 耗时: ${brain.duration_ms}ms`);
  console.log(
    `[verify] 文件树: total_files=${brain.tree.total_files} max_depth=${brain.tree.max_depth} truncated=${brain.tree.truncated}`,
  );
  console.log(
    `[verify] 扩展名 top10: ${brain.tree.by_extension.map((e) => `${e.ext}×${e.count}`).join(" ")}`,
  );
  console.log(
    `[verify] 顶层目录: ${brain.tree.top_dirs.map((d) => `${d.name}(${d.files})`).join(" ")}`,
  );
  if (brain.readme) {
    console.log(`[verify] README: ${brain.readme.path} 标题: ${brain.readme.title}`);
    console.log("[verify] README 摘要片段（前 300 字符）:");
    console.log(brain.readme.excerpt.slice(0, 300).replace(/^/gm, "  | "));
  } else {
    console.log("[verify] README: 无");
  }
  console.log(`[verify] docs 清单 ${brain.docs.length} 条，前 8 条:`);
  for (const d of brain.docs.slice(0, 8)) {
    console.log(`  | ${d.path} —— ${d.title ?? "(无标题)"}`);
  }
  console.log(
    `[verify] git: has_git=${brain.git.has_git} last_commit_at=${brain.git.last_commit_at} ` +
      `近30天=${brain.git.commits_last_30d} 总数=${brain.git.total_commits}`,
  );
  console.log("[verify] git 最近提交前 5 条:");
  for (const l of brain.git.recent_commits.slice(0, 5)) console.log(`  | ${l}`);
  console.log(
    `[verify] manifests: package_json=${brain.manifests.package_json?.exists ?? false} ` +
      `pyproject=${brain.manifests.pyproject_toml?.exists ?? false} name=${brain.manifests.pyproject_toml?.name ?? "-"}`,
  );
  ok(brain.tree.total_files > 0, `DoD① 真实项目文件树非空（${brain.tree.total_files} 文件）`);
  ok(brain.tree.by_extension.length > 0, "DoD① 扩展名 top10 非空");
  ok(brain.tree.top_dirs.length > 0, "DoD① 顶层目录清单非空");
  ok(brain.readme !== null && brain.readme.excerpt.length > 0, "DoD① README 摘要存在");
  ok(brain.docs.length > 0, `DoD① docs 清单非空（${brain.docs.length} 条）`);
  ok(
    brain.git.has_git && brain.git.last_commit_at !== null && brain.git.recent_commits.length > 0,
    `DoD① git log 活跃度含最近提交时间（${brain.git.last_commit_at}）`,
  );
}

// ── ② 塔台自身对照 ─────────────────────────────────────────────
console.log(`\n[verify] ── ② 塔台自身: ${DIR_TATAI}`);
const self_ = await scanDirectory(DIR_TATAI, "tatai"); // 批3 T17：随 scanner 改 async
console.log(
  `[verify] 耗时: ${self_.duration_ms}ms；total_files=${self_.tree.total_files} ` +
    `max_depth=${self_.tree.max_depth}；git 近30天=${self_.git.commits_last_30d} 总数=${self_.git.total_commits}`,
);
console.log(`[verify] git 最近 1 条: ${self_.git.recent_commits[0] ?? "(无)"}`);
console.log(
  `[verify] package.json: name=${self_.manifests.package_json?.name} scripts=[${self_.manifests.package_json?.scripts.slice(0, 6).join(",")}…]`,
);
ok(self_.git.has_git && self_.git.last_commit_at !== null, "② 塔台 git 活跃度存在");
ok(self_.manifests.package_json?.name === "tatai", "② 塔台 package.json name=tatai");
ok(
  self_.tree.top_dirs.every((d) => d.name !== "node_modules"),
  "② 塔台顶层目录无 node_modules（噪音忽略）",
);

// ── ③ 含 node_modules 假文件的临时项目 → 噪音被忽略 ──────────────
console.log("\n[verify] ── ③ node_modules 噪音忽略");
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-b1-verify-"));
const noiseDir = path.join(tmpBase, "noise-proj");
fs.mkdirSync(path.join(noiseDir, "node_modules", "fake-dep"), { recursive: true });
fs.mkdirSync(path.join(noiseDir, "dist"), { recursive: true });
fs.mkdirSync(path.join(noiseDir, "src"), { recursive: true });
fs.writeFileSync(path.join(noiseDir, "node_modules", "fake-dep", "index.js"), "x", "utf8");
fs.writeFileSync(path.join(noiseDir, "dist", "bundle.js"), "x", "utf8");
fs.writeFileSync(path.join(noiseDir, "src", "main.ts"), "export {}", "utf8");
fs.writeFileSync(path.join(noiseDir, "README.md"), "# 噪音验证项目\n正文一段。", "utf8");
const noise = await scanDirectory(noiseDir); // 批3 T17：随 scanner 改 async
console.log(
  `[verify] 噪音项目: total_files=${noise.tree.total_files} top_dirs=${noise.tree.top_dirs.map((d) => d.name).join(",")}`,
);
ok(noise.tree.total_files === 2, `③ 只有 src/main.ts + README.md 被计入（实际 ${noise.tree.total_files}）`);
ok(
  noise.tree.top_dirs.every((d) => d.name !== "node_modules" && d.name !== "dist"),
  "③ node_modules/dist 未出现在顶层目录清单",
);
ok(noise.git.has_git === false, "③ 无 .git → has_git=false 明确标记");

// ── ④ 无 README 无 git 的临时项目 → 明确标记不报错 ────────────────
console.log("\n[verify] ── ④ 无 README 无 git");
const bareDir = path.join(tmpBase, "bare-proj");
fs.mkdirSync(path.join(bareDir, "lib"), { recursive: true });
fs.writeFileSync(path.join(bareDir, "lib", "a.py"), "pass\n", "utf8");
const bare = await scanDirectory(bareDir); // 批3 T17：随 scanner 改 async
console.log(
  `[verify] bare 项目: readme=${bare.readme === null ? "null" : "有"} has_git=${bare.git.has_git} docs=${bare.docs.length}`,
);
ok(bare.readme === null, "④ 无 README → readme=null 不报错");
ok(bare.git.has_git === false && bare.git.last_commit_at === null, "④ 无 git → 明确标记");
ok(bare.tree.total_files === 1, "④ 文件树正常（1 文件）");

// ── ⑤ 超大目录截断（单目录 6000 假文件）──────────────────────────
console.log("\n[verify] ── ⑤ 超大目录截断");
const bigDir = path.join(tmpBase, "big-proj");
fs.mkdirSync(path.join(bigDir, "many"), { recursive: true });
for (let i = 0; i < 6000; i++) {
  fs.writeFileSync(path.join(bigDir, "many", `f${String(i).padStart(4, "0")}.txt`), "x", "utf8");
}
const t0 = Date.now();
const big = await scanDirectory(bigDir); // 批3 T17：随 scanner 改 async（大目录耗时仍从 t0 计）
const bigMs = Date.now() - t0;
console.log(
  `[verify] 6000 文件目录: total_files=${big.tree.total_files} truncated=${big.tree.truncated} ` +
    `truncated_dirs=${JSON.stringify(big.tree.truncated_dirs)} 耗时=${bigMs}ms`,
);
ok(big.tree.truncated === true, "⑤ 超 5000 截断并标记 truncated");
ok(big.tree.truncated_dirs.some((d) => d === "many"), "⑤ truncated_dirs 含 many");
ok(big.tree.total_files <= 5000, `⑤ 计入文件数 ≤ 5000（实际 ${big.tree.total_files}）`);
ok(bigMs < 10_000, `⑤ 大目录不卡死（耗时 ${bigMs}ms）`);

// ── ⑥ HTTP 全链路 ────────────────────────────────────────────────
console.log("\n[verify] ── ⑥ HTTP 全链路");
const dataDir = path.join(tmpBase, "home");
fs.mkdirSync(dataDir, { recursive: true });
addProject({ id: "noise-proj", name: "噪音验证", path: noiseDir, kind: "backend" }, dataDir);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitUp(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) {
        upPorts.add(PORT);
        return;
      }
    } catch {
      // 还没起来，继续等
    }
    await sleep(200);
  }
  throw new Error("后端 10 秒内未就绪");
}

// ── 端口冲突快速失败（2026-09-18 加）────────────────────────────────
// 端口被残留服务 / 并行会话占用时，子进程 EADDRINUSE 会静默死掉，而 waitUp 会打到占用者身上，
// 导致后续莫名 404 崩溃或对错误数据假通过。这里：起前探端口 → 起后盯早退。
const upPorts = new Set<number>();

function portListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: "127.0.0.1" });
    const done = (busy: boolean) => {
      sock.destroy();
      resolve(busy);
    };
    sock.once("connect", () => done(true)); // 有人监听 = 端口被占
    sock.once("error", () => done(false)); // 拒绝连接 = 端口空闲
    sock.setTimeout(1000, () => done(false));
  });
}

/** 起前预探测：端口已被占用立刻报错退出，不拿别人的服务跑验证 */
async function assertPortFree(port: number): Promise<void> {
  if (await portListening(port)) {
    console.error(`[verify] 后端起不来：端口 ${port} 被占用，先清理残留进程`);
    process.exit(1);
  }
}

/** 起后盯早退：子进程在就绪前退出（典型 EADDRINUSE）立即报错退出，不再继续验证 */
function watchChild(proc: ChildProcess, port: number, isUp: () => boolean): void {
  proc.once("exit", async (code) => {
    if (isUp()) return; // 脚本自己收尾杀的，不算异常
    const why = (await portListening(port))
      ? `端口 ${port} 被占用`
      : `后端进程提前退出（code=${code}）`;
    console.error(`[verify] 后端起不来：${why}，先清理残留进程`);
    process.exit(1);
  });
}

let child: ChildProcess | undefined;
try {
  await assertPortFree(PORT); // 端口已被占：立刻失败，不拿占用者的服务跑验证
  const proc = spawn(
    process.execPath,
    ["--import", "tsx", path.join("src", "server", "index.ts")],
    {
      env: { ...process.env, TATAI_HOME: dataDir, TATAI_PORT: String(PORT) },
      stdio: ["ignore", "pipe", "pipe"],
      cwd: REPO_ROOT,
    },
  );
  child = proc;
  proc.stderr?.on("data", (d: Buffer) => process.stderr.write(`[server] ${d}`));
  watchChild(proc, PORT, () => upPorts.has(PORT)); // 子进程早退（EADDRINUSE）立刻报错退出
  await waitUp();
  console.log(`[verify] server up at ${BASE}（TATAI_HOME=${dataDir}）`);

  const res = await fetch(`${BASE}/api/projects/noise-proj/scan`);
  const body = (await res.json()) as {
    ok: boolean;
    scan: { tree: { total_files: number }; readme: { title: string } | null };
  };
  console.log(
    `[verify] GET scan -> ${res.status} total_files=${body.scan.tree.total_files} readme=${body.scan.readme?.title ?? "null"}`,
  );
  ok(res.status === 200 && body.ok === true, "⑥ GET /api/projects/:id/scan → 200 ok");
  ok(
    body.scan.tree.total_files === 2 && body.scan.readme?.title === "噪音验证项目",
    "⑥ HTTP 扫描结果与直扫一致（噪音被忽略）",
  );

  const bad = await fetch(`${BASE}/api/projects/nosuchproj/scan`);
  const badBody = (await bad.json()) as { error?: { code: string; message: string } };
  console.log(`[verify] 伪造 id -> ${bad.status} ${badBody.error?.code}: ${badBody.error?.message}`);
  ok(
    bad.status === 404 && badBody.error?.code === "PROJECT_NOT_FOUND",
    "⑥ 伪造 id → 404 PROJECT_NOT_FOUND",
  );
} finally {
  child?.kill();
  fs.rmSync(tmpBase, { recursive: true, force: true });
}

finish();
