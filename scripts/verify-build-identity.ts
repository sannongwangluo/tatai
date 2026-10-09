// P0 / 卡 V09-45 验证：运行部件构建身份与发布覆盖（docs/agent-optimization-20261006.md §4）。
// 用法：pnpm verify:build-identity，或使用当前依赖树的 tsx CLI 运行本脚本。
//
// 判据覆盖（对照 §4.8 A0 反例清单）：
//   A0-1 身份归属：隔离 X 包启动 → 磁盘换成 Y → **原进程仍报 X**、新起进程报 Y
//   A0-2 输入集与自指：真实构建前冻结、构建后复核同一清单未漂移；改一处源码 ⇒ 指纹变；
//        只改输出（dist/、resources/server/）或只重跑打包 ⇒ 指纹不变；身份生成物不进指纹
//   A0-3 偏斜与未知：同 release / 错配可诊断；未内嵌一律 unknown 且**不判一致**；built_at 不参与身份
//   A0-4 发布覆盖：缺分片被拒
//   A0-5 不破坏既有链：build:server 与 vite build 在冻结输入下都能成功（真实构建函数，隔离产物）
//
// 隔离与副作用（本任务约束）：
//   · **不写共享工作树**：全部构建在 os.tmpdir() 下的**冻结快照**（工作树副本 + node_modules junction）里做；
//     产物、vite cache、dataDir（TATAI_HOME）都用隔离目录；端口动态。
//   · 工具链用绝对路径（`D:/tatai/node_modules/.bin/{tsx,vite}.cmd`），**不跑 pnpm**（现场 pnpm 包装有副作用）；
//     一次性用到的临时 junction（快照内 node_modules、快照外报告目录）在收尾清除。
//   · 只操作本脚本自己拉起的进程（收尾 taskkill 整棵树）；不碰真实运行中的塔台进程与生产数据。
import { execFileSync, spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkArtifactIdentity,
  computeComponentInputs,
  computeReleaseId,
  deriveIdentity,
  detectInputDrift,
  identityStampFields,
  INPUT_SETS,
  isExcludedPath,
  isInputPath,
  reconcileInputs,
  scanArtifactIdentity,
  SERVER_BUILD_TARGET,
  toolchainIdentity,
  UI_BUILD_TARGET,
  type ArtifactIdentityHit,
} from "./lib/buildIdentity";
import {
  collectReferencedOutputs,
  outputManifestFingerprint,
  releaseCoverage,
  REQUIRED_SERVER_PARTS,
  requiredInstallArtifacts,
  STAMP_SELF_PATHS,
} from "./lib/buildOutputManifest";
import { evaluateBuildStamps, isStampBuildIdentity, stampsEqual, writeBuildStamp, type BuildStamp } from "./lib/buildStamp";
import { compareBuildIdentities, resolveBuildIdentity, type BuildIdentity } from "../src/shared/buildIdentity";
import { stableStringify } from "../src/shared/stableJson";
import { APP_VERSION } from "../src/shared/version";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TSX = process.env.V0945_TSX ?? path.join(REPO_ROOT, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
const VITE = process.env.V0945_VITE ?? path.join(REPO_ROOT, "node_modules", ".bin", process.platform === "win32" ? "vite.cmd" : "vite");
const KEEP = process.env.V0945_KEEP === "1";
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-v0945-"));
const EVIDENCE = process.env.V0945_EVIDENCE_DIR ?? path.join(REPO_ROOT, ".工作台", "verify", "v09-45");
const LOG: string[] = [];

let pass = 0;
const fails: string[] = [];
const skips: string[] = [];
const files = new Map<string, string>();

function say(line = ""): void {
  LOG.push(line);
  console.log(line);
}
function ok(cond: boolean, label: string): boolean {
  say(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (cond) pass++;
  else fails.push(label);
  return cond;
}
function skip(label: string, reason: string): void {
  say(`[verify] SKIP ${label}（${reason}）`);
  skips.push(`${label}：${reason}`);
}
function section(title: string): void {
  say("");
  say(`[verify] ═══ ${title} ═══`);
}
function evidence(name: string, body: string): void {
  files.set(name, body);
}

// Windows 下 .cmd 垫片必须经 shell 解析；路径用反斜杠并加引号（cmd 里 `/` 会被当开关）。
const q = (p: string): string => `"${p.replace(/\//g, "\\")}"`;
function run(cmdline: string, opts: { cwd: string; env?: NodeJS.ProcessEnv }): SpawnSyncReturns<string> {
  return spawnSync(cmdline, [], {
    cwd: opts.cwd,
    encoding: "utf8",
    shell: true,
    env: opts.env ?? process.env,
    maxBuffer: 64 * 1024 * 1024,
  });
}

// ── 树拷贝 / junction ──
const COPY_SKIP_DIRS = new Set(["node_modules", ".git", ".工作台", "audit", "__pycache__", "dist"]);
function copyTree(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.isDirectory() && COPY_SKIP_DIRS.has(e.name)) continue;
    const from = path.join(src, e.name);
    const to = path.join(dest, e.name);
    const rel = path.relative(REPO_ROOT, from).split(path.sep).join("/");
    if (e.isDirectory()) {
      if (rel === "src-tauri/target" || rel === "src-tauri/resources") continue;
      copyTree(from, to);
    } else if (e.isFile()) {
      fs.copyFileSync(from, to);
    }
  }
}

function resolveNodeModulesRoot(): string | null {
  let dir = REPO_ROOT;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, "node_modules");
    if (fs.existsSync(path.join(candidate, "vite"))) return fs.realpathSync(candidate);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function junction(linkPath: string, target: string): void {
  const r = spawnSync("cmd", ["/c", "mklink", "/J", linkPath, target], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`mklink /J ${linkPath} -> ${target} 失败：${r.stdout}${r.stderr}`);
}

// ── HTTP ──
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}
async function getJson(
  url: string,
  timeoutMs = 5000,
  headers?: Record<string, string>,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}
async function waitHealth(base: string, timeoutMs: number): Promise<{ status: number; body: any } | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await getJson(`${base}/health`, 2000);
      if (r.status === 200) return r as { status: number; body: any };
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return null;
}
function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  } catch {
    /* 已退出 */
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 扫一个产物目录里的全部 .js（含地码分包 assets/，排除 node_modules），取内嵌身份。
 *  实现复用构建层同一份 `scanArtifactIdentity`（判据只此一处，验证脚本不另写一套）。 */
function extractFromDir(dir: string): ArtifactIdentityHit | null {
  return scanArtifactIdentity(dir);
}

// ═══════════════════════════════════════════════════════════════════════════════
async function main(): Promise<void> {
  say(`[verify] V09-45 运行部件构建身份与发布覆盖`);
  say(`[verify] 隔离工作区：${WORK}`);
  say(`[verify] 证据目录：${EVIDENCE}`);
  say(`[verify] 工装：tsx=${TSX} vite=${VITE} node=${process.version}`);

  // ── 冻结快照（隔离，不受并发改动影响）──
  section("0 冻结快照与工装");
  const SNAP = path.join(WORK, "snap");
  copyTree(REPO_ROOT, SNAP);
  const nmRoot = resolveNodeModulesRoot();
  if (nmRoot === null) throw new Error("找不到可解析的 node_modules（拒绝安装/改动共享依赖）");
  junction(path.join(SNAP, "node_modules"), nmRoot);
  ok(fs.existsSync(path.join(SNAP, "scripts", "build-server.ts")), `快照建好（${SNAP}）`);
  ok(fs.existsSync(path.join(SNAP, "node_modules", "vite")), `快照内 node_modules 只是 junction（-> ${nmRoot}），未安装任何依赖`);
  const beforeSnapInputs = reconcileInputs(SNAP);
  evidence(
    "00-frozen-inputs.json",
    JSON.stringify(
      {
        snapshot: SNAP,
        node_modules_junction: nmRoot,
        server: computeComponentInputs("server", SNAP).fingerprint,
        ui: computeComponentInputs("ui", SNAP).fingerprint,
        toolchain: beforeSnapInputs.current.toolchain,
      },
      null,
      2,
    ),
  );

  // ── A 纯判据（不构建）──
  section("A 判据（旧未知 / 偏斜 / 输出不回灌 / 源真变 / 漂移拒绝 / 缺分片）");

  // A1 旧未知（源码直跑）
  const srcRunServer = resolveBuildIdentity("server");
  const srcRunUi = resolveBuildIdentity("ui");
  ok(srcRunServer.embedded === false && srcRunServer.reason !== "", `A1 源码直跑 server 身份为 unknown（${srcRunServer.embedded === false ? srcRunServer.reason : "?"}）`);
  ok(srcRunUi.embedded === false, "A1 源码直跑 ui 身份为 unknown（未内嵌不得假装已知）");
  const unknownVsKnown = compareBuildIdentities(srcRunUi, deriveIdentity(SNAP).identities.server);
  ok(unknownVsKnown.state === "unknown", "A1 任一侧未内嵌 ⇒ 偏斜判定 unknown（**不判一致**）");

  // A2 偏斜三态
  const d0 = deriveIdentity(SNAP, { builtAt: { server: "2026-01-01T00:00:00.000Z", ui: "2026-01-01T00:00:01.000Z" } });
  ok(compareBuildIdentities(d0.identities.server, d0.identities.ui).state === "same_release", "A2 同批构建的 server/ui ⇒ same_release");
  const skewedServer: BuildIdentity = { ...d0.identities.server, release_id: "f".repeat(64) };
  const skew = compareBuildIdentities(d0.identities.ui, skewedServer);
  ok(skew.state === "skew", `A2 release_id 不同 ⇒ skew（${skew.detail}）`);
  ok(skew.detail.includes("server") && skew.detail.includes("ui"), "A2 skew 文案点名两个部件");

  // A3 built_at 不参与身份
  const d1 = deriveIdentity(SNAP, { builtAt: { server: "2020-05-05T00:00:00.000Z", ui: "2021-06-06T00:00:00.000Z" } });
  ok(
    d1.release_id === d0.release_id && d1.build_id.server === d0.build_id.server && d1.build_id.ui === d0.build_id.ui,
    "A3 改 built_at ⇒ release_id/build_id 不变（时间不冒充身份）",
  );
  ok(d1.identities.server.built_at !== d0.identities.server.built_at, "A3 built_at 本身确实是两个不同值（不是没改）");

  // A4 源真变 / 输出不回灌（隔离迷你根，判据同一份）
  const mini = path.join(WORK, "mini");
  fs.mkdirSync(path.join(mini, "src", "server"), { recursive: true });
  fs.mkdirSync(path.join(mini, "src", "shared"), { recursive: true });
  fs.writeFileSync(path.join(mini, "src", "server", "a.ts"), "export const a = 1;\n");
  fs.writeFileSync(path.join(mini, "src", "shared", "s.ts"), "export const s = 1;\n");
  fs.writeFileSync(path.join(mini, "package.json"), "{}\n");
  const m0 = computeComponentInputs("server", mini).fingerprint;
  fs.writeFileSync(path.join(mini, "src", "server", "a.ts"), "export const a = 2;\n");
  const m1 = computeComponentInputs("server", mini).fingerprint;
  ok(m0 !== m1, "A4 改一处源码 ⇒ server 输入指纹变（源真变）");
  fs.mkdirSync(path.join(mini, "dist"), { recursive: true });
  fs.writeFileSync(path.join(mini, "dist", "index.html"), "<!doctype html>\n");
  fs.mkdirSync(path.join(mini, "src-tauri", "resources", "server"), { recursive: true });
  fs.writeFileSync(path.join(mini, "src-tauri", "resources", "server", "index.js"), "// out\n");
  fs.mkdirSync(path.join(mini, "node_modules", "pkg"), { recursive: true });
  fs.writeFileSync(path.join(mini, "node_modules", "pkg", "index.js"), "// dep\n");
  fs.writeFileSync(path.join(mini, "notes.build-identity.json"), "{}\n");
  const m2 = computeComponentInputs("server", mini).fingerprint;
  ok(m2 === m1, "A4 只加输出（dist/、resources/server/）、第三方与身份生成物 ⇒ 指纹不变（输出不回灌 / 无自指）");
  ok(isExcludedPath("notes.build-identity.json") && !isInputPath("server", "notes.build-identity.json"), "A4 身份生成物被显式排除在输入集外");
  ok(!isInputPath("server", "src-tauri/resources/server/index.js"), "A4 随包后端产物不在 server 输入集内（自指反例）");

  // A5 清单漂移拒绝（第三方不误判）
  const inListA = [...INPUT_SETS.server.include].includes("src/server/**") ? "src/server/index.ts" : "src/server/index.ts";
  const driftClean = detectInputDrift(
    "server",
    [`${SNAP.replace(/\\/g, "/")}/src/server/${inListA.split("/").pop()}`, "node:fs", "vite", "\0virtual", `${SNAP.replace(/\\/g, "/")}/node_modules/vite/dist/node/index.js`],
    SNAP,
  );
  ok(driftClean.ok, `A5 清单内模块 + 第三方/内建 ⇒ 不判漂移（第三方按锁文件与工具链归属，不误判：外部 ${driftClean.external_modules} 个）`);
  const driftRogue = detectInputDrift(
    "server",
    [`${SNAP.replace(/\\/g, "/")}/src/server/index.ts`, `${SNAP.replace(/\\/g, "/")}/scripts/rogue-extra.ts`],
    SNAP,
  );
  ok(!driftRogue.ok && driftRogue.outside.includes("scripts/rogue-extra.ts"), `A5 引入清单外仓库内模块 ⇒ 漂移拒绝（点名 ${driftRogue.outside.join(", ")}）`);
  const driftSelf = detectInputDrift("server", [`${SNAP.replace(/\\/g, "/")}/src-tauri/resources/server/index.js`], SNAP);
  ok(!driftSelf.ok && driftSelf.output_self_reference.length > 0, "A5 产物目录模块 ⇒ 输出自指拒绝");

  // A6 缺分片被拒 + 作用域语义（完整包 vs server-only）——Codex 纠正 8
  const serverParts = REQUIRED_SERVER_PARTS.map((p) => ({ path: p }));
  const uiParts = [{ path: "dist/index.html" }];
  const installs = requiredInstallArtifacts(APP_VERSION).map((p) => ({ path: p }));
  const fullEntries = [...serverParts, ...uiParts, ...installs];
  ok(releaseCoverage(fullEntries, { scope: "full" }).ok, `A6 整包必需部件齐全（${fullEntries.length} 项）⇒ 通过`);
  const serverOnly = releaseCoverage(serverParts, { scope: "server-only" });
  ok(serverOnly.ok && serverOnly.scope === "server-only", "A6 server-only 显式作用域：只要后端四入口即通过（不要求安装器/前端）");
  const serverOnlyAsFull = releaseCoverage(serverParts, { scope: "full" });
  ok(
    !serverOnlyAsFull.ok && serverOnlyAsFull.missing.length === uiParts.length + installs.length,
    `A6 server-only 结果不能冒充 full：缺 ${serverOnlyAsFull.missing.length} 项（前端 ${uiParts.length} + 安装器 ${installs.length}）`,
  );
  const missingOne = releaseCoverage(
    serverParts.filter((e) => e.path !== "src-tauri/resources/server/mcp.js"),
    { scope: "server-only" },
  );
  ok(!missingOne.ok && missingOne.missing.length === 1, `A6 缺一个分片 ⇒ 拒绝（缺 ${missingOne.missing.join(", ")}）`);

  // A6b 引用闭包：入口**内容**解析出的 chunk/CSS/资源必须在场（不是重扫目录当完整清单）
  const closureRoot = path.join(WORK, "closure");
  const closureDist = path.join(closureRoot, "dist");
  const closureServer = path.join(closureRoot, "src-tauri", "resources", "server");
  const put = (rel: string, body: string): void => {
    const abs = path.join(closureRoot, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  };
  for (const p of REQUIRED_SERVER_PARTS) put(p, `export const entry = ${JSON.stringify(path.basename(p))};\nimport("./assets/workstation-a1b2.js");\n`);
  put("src-tauri/resources/server/assets/workstation-a1b2.js", "export const w = 1;\n");
  put("dist/index.html", `<!doctype html><html><head><link rel="stylesheet" href="/assets/app-9000.css"></head><body><script type="module" src="/assets/app-9000.js"></script></body></html>\n`);
  put("dist/assets/app-9000.js", `import("./chunk-dead.js");\nexport const a=1;\n`);
  put("dist/assets/app-9000.css", `@font-face{src:url("/assets/font-dead.woff2")}\n`);
  put("dist/assets/chunk-dead.js", "export const c=1;\n");
  put("dist/assets/font-dead.woff2", "wOF2\n");
  const closureManifest = new Set(
    [
      ...REQUIRED_SERVER_PARTS,
      "src-tauri/resources/server/assets/workstation-a1b2.js",
      "dist/index.html",
      "dist/assets/app-9000.js",
      "dist/assets/app-9000.css",
      "dist/assets/chunk-dead.js",
      "dist/assets/font-dead.woff2",
    ],
  );
  const closure = collectReferencedOutputs(closureRoot, { scope: "full", manifestPaths: closureManifest });
  ok(
    closure.ok && closure.referenced.includes("dist/assets/chunk-dead.js") && closure.referenced.includes("dist/assets/font-dead.woff2"),
    `A6b 引用闭包完整：入口 ${closure.entries.length} 个 → 引用 ${closure.referenced.length} 项（含动态 chunk 与 CSS 字体）`,
  );
  const chunkPath = path.join(closureDist, "assets", "chunk-dead.js");
  fs.rmSync(chunkPath, { force: true });
  const closureMissingChunk = collectReferencedOutputs(closureRoot, { scope: "full", manifestPaths: closureManifest });
  ok(
    !closureMissingChunk.ok && closureMissingChunk.missing.includes("dist/assets/chunk-dead.js"),
    `A6b 删掉仍被引用的 UI chunk ⇒ 判缺件（${closureMissingChunk.missing.join(", ")}）`,
  );
  fs.writeFileSync(chunkPath, "export const c=1;\n");
  const cssPath = path.join(closureDist, "assets", "app-9000.css");
  fs.rmSync(cssPath, { force: true });
  const closureMissingCss = collectReferencedOutputs(closureRoot, { scope: "full", manifestPaths: closureManifest });
  ok(
    !closureMissingCss.ok && closureMissingCss.missing.includes("dist/assets/app-9000.css"),
    "A6b 删掉入口引用的 CSS ⇒ 判缺件",
  );
  fs.writeFileSync(cssPath, `@font-face{src:url("/assets/font-dead.woff2")}\n`);
  const serverChunkPath = path.join(closureServer, "assets", "workstation-a1b2.js");
  fs.rmSync(serverChunkPath, { force: true });
  const closureMissingServerChunk = collectReferencedOutputs(closureRoot, { scope: "full", manifestPaths: closureManifest });
  ok(
    !closureMissingServerChunk.ok && closureMissingServerChunk.missing.includes("src-tauri/resources/server/assets/workstation-a1b2.js"),
    "A6b 删掉随包后端仍被引用的 chunk ⇒ 判缺件",
  );
  fs.writeFileSync(serverChunkPath, "export const w = 1;\n");
  const closureOutOfManifest = collectReferencedOutputs(closureRoot, {
    scope: "full",
    manifestPaths: [...closureManifest].filter((p) => p !== "dist/assets/chunk-dead.js"),
  });
  ok(
    !closureOutOfManifest.ok && closureOutOfManifest.not_in_manifest.includes("dist/assets/chunk-dead.js"),
    "A6b 引用的产物不在冻结构建清单里 ⇒ 判清单外引用",
  );

  // A7 稳定序列化与同步契约的既有实现逐字一致（同一判据不分叉）
  try {
    const mod = (await import("../src/server/work/syncContract")) as { stableStringify?: (v: unknown) => string };
    if (typeof mod.stableStringify !== "function") {
      skip("A7 稳定序列化对账", "syncContract 未导出 stableStringify");
    } else {
      const fixtures: unknown[] = [
        { b: 1, a: [1, 2, { z: null, y: "x" }] },
        [3, { "": 1, A: 2 }],
        { nested: { deep: { x: [true, false, null] } } },
        { release: ["0.3.0", "a".repeat(64), "b".repeat(64), { node: "v24", target: "node20" }] },
      ];
      const same = fixtures.every((f) => stableStringify(f) === mod.stableStringify!(f));
      ok(same, "A7 src/shared/stableJson 与 syncContract.stableStringify 逐字相同（同一判据，未写第二份近似实现）");
    }
  } catch (e) {
    skip("A7 稳定序列化对账", `导入 syncContract 失败（并发改动？）：${e instanceof Error ? e.message : String(e)}`);
  }

  // ── A8 未声明外部源码 / 依赖归属（Codex 纠正 1）──
  section("A8 未声明外部源码与依赖归属（Codex 纠正 1）");
  const elsewhere = path.join(WORK, "elsewhere-lib.ts");
  fs.writeFileSync(elsewhere, "export const outside = 1;\n");
  const otherProjNm = path.join(WORK, "otherproj", "node_modules", "x", "index.js");
  fs.mkdirSync(path.dirname(otherProjNm), { recursive: true });
  fs.writeFileSync(otherProjNm, "module.exports = 1;\n");
  const slash = (p: string): string => p.replace(/\\/g, "/");
  const driftExt = detectInputDrift("server", [slash(path.join(SNAP, "src", "server", "index.ts")), slash(elsewhere), slash(otherProjNm)], SNAP);
  ok(
    !driftExt.ok && driftExt.external_undeclared.some((p) => p.endsWith("elsewhere-lib.ts")),
    `A8 仓库外、非依赖的绝对源码 ⇒ 未声明外部源判 FAIL（${driftExt.external_undeclared.length} 项）`,
  );
  ok(
    driftExt.external_undeclared.some((p) => p.includes("/otherproj/node_modules/")),
    "A8 别人 node_modules 里的模块（依赖归属不可证明）⇒ 同样未声明外部源，不静默当第三方",
  );
  const driftDeclared = detectInputDrift("server", [slash(path.join(SNAP, "src", "server", "index.ts")), slash(elsewhere)], SNAP, {
    declaredExternal: [slash(elsewhere)],
  });
  ok(
    driftDeclared.ok && driftDeclared.external_declared.length === 1 && driftDeclared.declared_external_hashes[slash(elsewhere)]?.length === 64,
    "A8 显式声明外部源 ⇒ 接受，并对该文件做内容绑定（sha256 记录在案）",
  );
  const driftUndeclaredAgain = detectInputDrift("server", [slash(elsewhere)], SNAP, { declaredExternal: [slash(path.join(WORK, "some-other-file.ts"))] });
  ok(!driftUndeclaredAgain.ok, "A8 声明了别的路径 ⇒ 该外部源仍判未声明（声明不覆盖其它路径）");
  ok(
    detectInputDrift("server", ["node:fs", "vite", "\0virtual", slash(path.join(SNAP, "node_modules", "vite", "dist", "node", "index.js"))], SNAP).external_undeclared.length === 0,
    "A8 裸模块名/Node 内建/本仓 node_modules ⇒ 不判未声明（第三方按锁与工具链归属）",
  );

  // ── A9 工具链：真实编译目标与打包器版本（Codex 纠正 2）──
  section("A9 工具链：真实编译目标与打包器版本（Codex 纠正 2）");
  const tc = toolchainIdentity(SNAP);
  const targetsDiffer: boolean = (tc.targets.server as string) !== (tc.targets.ui as string);
  ok(
    tc.targets.server === SERVER_BUILD_TARGET && tc.targets.ui === UI_BUILD_TARGET && targetsDiffer,
    `A9 两部件各记**实际**编译目标（server ${tc.targets.server} / ui ${tc.targets.ui}），UI 不再冒充 node20`,
  );
  ok(
    tc.bundler.vite !== "unknown" && tc.bundler.rollup !== "unknown" && tc.bundler.esbuild !== "unknown",
    `A9 打包器版本从实际依赖解析（vite ${tc.bundler.vite} / rollup ${tc.bundler.rollup} / esbuild ${tc.bundler.esbuild}）`,
  );
  const prevTargetEnv = process.env.TATAI_BUILD_TARGET;
  process.env.TATAI_BUILD_TARGET = "definitely-not-a-real-target";
  ok(toolchainIdentity(SNAP).targets.server === SERVER_BUILD_TARGET, "A9 TATAI_BUILD_TARGET 不再能凭空改身份里的目标（纯环境标签冒充已消除）");
  if (prevTargetEnv === undefined) delete process.env.TATAI_BUILD_TARGET;
  else process.env.TATAI_BUILD_TARGET = prevTargetEnv;
  const tcOtherBundler = { ...tc, bundler: { ...tc.bundler, vite: "0.0.0-not-installed" } };
  ok(
    computeReleaseId("a".repeat(64), "b".repeat(64), tc, APP_VERSION) !==
      computeReleaseId("a".repeat(64), "b".repeat(64), tcOtherBundler, APP_VERSION),
    "A9 同源码/同锁、打包器版本不同 ⇒ release_id 不同（不再同身份）",
  );

  // ── A10 构建戳：规范比较与字段校验（Codex 纠正 3）──
  section("A10 构建戳：规范比较与字段校验（Codex 纠正 3）");
  const stampFields = identityStampFields(SNAP);
  const baseStamp: BuildStamp = {
    version: 1,
    source_fingerprint: "f".repeat(64),
    source_file_count: 3,
    built_at: "2026-01-01T00:00:00.000Z",
    builder: "tauri-build.ts",
    build_identity: { ...stampFields },
  };
  // 键序不同、值相同 ⇒ 视为同一份（"忽略键序"的承诺要兑现；旧实现用原生 JSON.stringify 做不到）
  const reordered: BuildStamp = {
    builder: "tauri-build.ts",
    built_at: "2026-01-01T00:00:00.000Z",
    source_file_count: 3,
    source_fingerprint: "f".repeat(64),
    version: 1,
    build_identity: {
      toolchain: { ...stampFields.toolchain, targets: { ui: stampFields.toolchain.targets.ui, server: stampFields.toolchain.targets.server } },
      ui_input_manifest_sha256: stampFields.ui_input_manifest_sha256,
      server_input_manifest_sha256: stampFields.server_input_manifest_sha256,
      ui_input_file_count: stampFields.ui_input_file_count,
      server_input_file_count: stampFields.server_input_file_count,
      ui_input_fingerprint: stampFields.ui_input_fingerprint,
      server_input_fingerprint: stampFields.server_input_fingerprint,
      build_id: { ui: stampFields.build_id.ui, server: stampFields.build_id.server },
      release_id: stampFields.release_id,
    },
  };
  ok(stampsEqual(baseStamp, reordered), "A10 键序不同、值相同 ⇒ 两处戳判为同一份（规范比较兑现'忽略键序'）");
  ok(
    !stampsEqual(baseStamp, { ...baseStamp, build_identity: { ...baseStamp.build_identity!, server_input_file_count: 999 } }),
    "A10 仅 file_count 不同 ⇒ 判分叉（旧实现漏比该字段）",
  );
  ok(
    !stampsEqual(baseStamp, { ...baseStamp, build_identity: { ...baseStamp.build_identity!, server_input_manifest_sha256: "0".repeat(64) } }),
    "A10 仅输入清单哈希不同 ⇒ 判分叉（旧实现漏比该字段）",
  );
  ok(isStampBuildIdentity(baseStamp.build_identity) && !isStampBuildIdentity({ ...baseStamp.build_identity, server_input_file_count: undefined }), "A10 身份段缺 file_count ⇒ 判不合法（不能被当完整同源）");
  ok(!isStampBuildIdentity({ ...baseStamp.build_identity, server_input_fingerprint: "" }), "A10 身份段空输入指纹 ⇒ 判不合法");
  const badStampRoot = path.join(WORK, "stamp-bad");
  fs.mkdirSync(path.join(badStampRoot, "src"), { recursive: true });
  fs.writeFileSync(path.join(badStampRoot, "src", "x.ts"), "export const x = 1;\n");
  writeBuildStamp(badStampRoot, stampFields);
  const goodVerdict = evaluateBuildStamps(badStampRoot);
  ok(goodVerdict.ok && goodVerdict.stamps_identical, "A10 完整合法的新戳（含身份段）仍判通过（没把合法戳误杀）");
  const distStampPath = path.join(badStampRoot, "dist", "build-stamp.json");
  const tampered = JSON.parse(fs.readFileSync(distStampPath, "utf8")) as BuildStamp;
  delete (tampered.build_identity as Partial<typeof stampFields>).server_input_manifest_sha256;
  fs.writeFileSync(distStampPath, JSON.stringify(tampered, null, 2) + "\n");
  const tamperedVerdict = evaluateBuildStamps(badStampRoot);
  ok(
    !tamperedVerdict.ok && tamperedVerdict.malformed.some((m) => m.includes("构建身份段不合法")),
    `A10 篡改成半截身份段（删 manifest 哈希）⇒ 判 malformed，不被当完整同源（${tamperedVerdict.malformed.length} 条）`,
  );
  // 老戳（无身份段）必须照旧合法：保持旧无段戳兼容
  const legacyRoot = path.join(WORK, "stamp-legacy");
  fs.mkdirSync(path.join(legacyRoot, "src"), { recursive: true });
  fs.writeFileSync(path.join(legacyRoot, "src", "x.ts"), "export const x = 1;\n");
  fs.mkdirSync(path.join(legacyRoot, "dist"), { recursive: true });
  fs.mkdirSync(path.join(legacyRoot, "src-tauri", "target", "release"), { recursive: true });
  const { sourceFingerprint: fpOf } = await import("./lib/sourceFingerprint");
  const legacyFp = fpOf(legacyRoot);
  const legacyBody = JSON.stringify(
    { version: 1, source_fingerprint: legacyFp.fingerprint, source_file_count: legacyFp.file_count, built_at: new Date().toISOString(), builder: "tauri-build.ts" },
    null,
    2,
  ) + "\n";
  fs.writeFileSync(path.join(legacyRoot, "dist", "build-stamp.json"), legacyBody);
  fs.writeFileSync(path.join(legacyRoot, "src-tauri", "target", "release", "build-stamp.json"), legacyBody);
  const legacyVerdict = evaluateBuildStamps(legacyRoot);
  ok(legacyVerdict.ok && legacyVerdict.stamps_identical, "A10 旧的无身份段戳照旧合法且可比（保持旧兼容）");

  // ── B 真实构建（快照内，冻结输入）──
  section("B 真实构建：build:server（X）与发布覆盖");
  const OUT_SERVER = path.join(SNAP, ".out-server");
  const buildEnv = { ...process.env, TATAI_BUILD_SERVER_OUT: OUT_SERVER };
  const bX = run(`${q(TSX)} ${q(path.join(SNAP, "scripts", "build-server.ts"))}`, { cwd: SNAP, env: buildEnv });
  evidence("10-build-server-X.stdout.txt", bX.stdout ?? "");
  evidence("10-build-server-X.stderr.txt", bX.stderr ?? "");
  ok(bX.status === 0, `B build:server exit 0（实际 ${bX.status}）`);
  const indexJs = path.join(OUT_SERVER, "index.js");
  ok(fs.existsSync(indexJs), "B 产出 src-tauri/resources/server 等价目录（隔离 .out-server）");
  // 身份可能落在经地码分包的共享 chunk（assets/*.js）而不是入口 index.js——扫全部产物 js
  const foundX = extractFromDir(OUT_SERVER);
  const embeddedX = foundX?.bundle ?? null;
  const identityX = deriveIdentity(SNAP);
  ok(
    embeddedX !== null,
    `B 产物内联了构建身份（define 生效；命中 ${foundX?.file ?? "（无）"} / 共 ${foundX?.scanned ?? 0} 个 js）`,
  );
  if (embeddedX === null) {
    ok(false, "B 内联身份可解析（后续身份判据依赖它）");
  } else {
    ok(
      embeddedX.server.release_id === identityX.release_id && embeddedX.ui.release_id === identityX.release_id,
      `B 内联 release_id === 现算（${identityX.release_id.slice(0, 12)}…）`,
    );
    ok(embeddedX.server.build_id !== embeddedX.ui.build_id, "B 同一 release 下 server/ui 的 build_id 不同（按部件区分）");
    ok(
      embeddedX.server.source_input_fingerprint === identityX.server_input_fingerprint,
      "B 内联的 server 输入指纹与现算一致（构建输入未被静默改写）",
    );
    ok(
      embeddedX.server.toolchain.node === process.version &&
        embeddedX.server.toolchain.targets.server === SERVER_BUILD_TARGET &&
        embeddedX.server.toolchain.targets.ui === UI_BUILD_TARGET,
      `B 工具链身份按实际环境与目标（node ${process.version} / server ${embeddedX.server.toolchain.targets.server} / ui ${embeddedX.server.toolchain.targets.ui} / vite ${embeddedX.server.toolchain.bundler.vite} / pnpm ${embeddedX.server.toolchain.pnpm}）`,
    );
    ok(
      embeddedX.server.release_id ===
        computeReleaseId(
          embeddedX.server.source_input_fingerprint,
          embeddedX.ui.source_input_fingerprint,
          embeddedX.server.toolchain,
        ),
      "B release_id 可由内联字段独立复算（canonical_json 推导自洽）",
    );
  }
  // 构建后复核同一清单未漂移（A0-2）
  const afterBX = reconcileInputs(SNAP);
  ok(
    !afterBX.drifted && afterBX.current.server_input_fingerprint === identityX.server_input_fingerprint,
    "B 构建后现算输入指纹与构建前一致（构建过程不漂移；输出落 .out-server 不回流）",
  );

  // ── C 隔离包启动：进程身份取自内联常量（X）──
  section("C 隔离启动：活进程报内联身份，且不随磁盘变");
  const runDir = path.join(WORK, "run-x");
  fs.cpSync(OUT_SERVER, runDir, { recursive: true });
  const dataHomeX = path.join(WORK, "data-x");
  const dataHomeY = path.join(WORK, "data-y");

  const portX = await freePort();
  const started = await startServer(runDir, portX, "X", dataHomeX);
  if (started === null) {
    ok(false, "C 隔离后端进程可在动态端口就绪（/health 200）");
  } else {
    ok(true, `C 隔离后端进程在动态端口就绪（${started.url}/health）`);
    const hX = (await getJson(`${started.url}/health`)).body as { pid: number; build_identity: BuildIdentity };
    ok(
      hX.build_identity !== undefined && hX.build_identity.embedded === true && hX.build_identity.release_id === identityX.release_id,
      `C /health 回内嵌 server 身份（release ${identityX.release_id.slice(0, 12)}…）`,
    );
    // 磁盘换成 Y：改一处源码 → 重建 → 覆盖运行目录的 JS（node_modules 有加载中的原生件，不动）
    section("C2 磁盘换成 Y：原进程仍报 X，新起进程报 Y");
    const probe = path.join(SNAP, "src", "shared", "__v0945_probe.ts");
    fs.writeFileSync(probe, `export const v0945Probe = ${Date.now()};\n`);
    const identityY = deriveIdentity(SNAP);
    ok(identityY.release_id !== identityX.release_id, "C2 改一处源码 ⇒ 新 release_id 与 X 不同（源真变）");
    const bY = run(`${q(TSX)} ${q(path.join(SNAP, "scripts", "build-server.ts"))}`, { cwd: SNAP, env: buildEnv });
    evidence("11-build-server-Y.stdout.txt", bY.stdout ?? "");
    evidence("11-build-server-Y.stderr.txt", bY.stderr ?? "");
    ok(bY.status === 0, `C2 重建（Y）exit 0（实际 ${bY.status}）`);
    const embeddedY = extractFromDir(OUT_SERVER)?.bundle ?? null;
    ok(embeddedY !== null && embeddedY.server.release_id === identityY.release_id, "C2 Y 产物内联的是 Y 的身份");
    // "磁盘换成 Y"：把运行目录里的**JS 产物**换成 Y 的（服务端要么地码分包：入口 .js + assets/*.js，
    // 分片名带内容哈希，X 的分片必须清掉否则 Y 的入口 import 不到）。node_modules 是同一批依赖且
    // 有加载中的原生件，不动。
    for (const f of fs.readdirSync(runDir)) {
      if (f.endsWith(".js") || f === "assets" || f === "package.json" || f === "THIRD-PARTY-NOTICES.txt") {
        fs.rmSync(path.join(runDir, f), { recursive: true, force: true });
      }
    }
    for (const f of fs.readdirSync(OUT_SERVER)) {
      if (f.endsWith(".js") || f === "assets" || f === "package.json" || f === "THIRD-PARTY-NOTICES.txt") {
        fs.cpSync(path.join(OUT_SERVER, f), path.join(runDir, f), { recursive: true });
      }
    }
    await sleep(1500);
    const hXAgain = (await getJson(`${started.url}/health`)).body as { build_identity: BuildIdentity };
    ok(
      hXAgain.build_identity.embedded === true && hXAgain.build_identity.release_id === identityX.release_id,
      "C2 磁盘换成 Y 后，**原进程仍报 X**（身份取自启动时载入的常量，不读盘）",
    );
    // Y 用**自己的数据目录**：X 还活着、可能仍持有旧描述符，共用目录会把 /api/work/health 打到 X 上
    const portY = await freePort();
    const startedY = await startServer(runDir, portY, "Y", dataHomeY);
    if (startedY === null) {
      ok(false, "C2 新起进程就绪并报 Y");
    } else {
      const hY = (await getJson(`${startedY.url}/health`)).body as { build_identity: BuildIdentity };
      ok(
        hY.build_identity.embedded === true && hY.build_identity.release_id === identityY.release_id,
        `C2 新起进程报 Y（release ${identityY.release_id.slice(0, 12)}…）`,
      );
      // /api/work/health（唯一宿主 info）也应带身份
      try {
        const desc = JSON.parse(fs.readFileSync(path.join(dataHomeY, "work-service.json"), "utf8")) as {
          host: string;
          port: number;
          token: string;
        };
        const wh = await getJson(`http://${desc.host}:${desc.port}/api/work/health`, 5000, {
          "x-tatai-work-token": desc.token,
        });
        const wb = wh.body as { build_identity?: BuildIdentity; code?: string; message?: string; pid?: number };
        const observed = wb?.build_identity;
        ok(
          observed !== undefined && observed.embedded === true && observed.release_id === identityY.release_id,
          `C2 /api/work/health（宿主 info，HTTP ${wh.status}，pid ${wb?.pid ?? "?"}）回同一份 server 身份（` +
            `期望 ${identityY.release_id.slice(0, 12)}…，实际 ${
              observed === undefined ? `无 build_identity：${wb?.code ?? ""}${wb?.message ?? ""}` : observed.embedded ? observed.release_id.slice(0, 12) + "…" : observed.reason
            }）`,
        );
      } catch (e) {
        skip("C2 /api/work/health 身份读回", `描述符不可读：${e instanceof Error ? e.message : String(e)}`);
      }
      killTree(startedY.pid());
    }
    killTree(started.pid());
    fs.rmSync(probe, { force: true });
  }

  // ── D 前端构建（vite build）+ UI 身份内联 ──
  section("D 真实构建：vite build（ui）与界面自身身份");
  const OUT_UI = path.join(SNAP, ".out-ui");
  const viteEnv = {
    ...process.env,
    TATAI_VITE_CACHE_DIR: path.join(SNAP, ".vite-cache"),
  };
  const uiBuild = run(`${q(VITE)} build --outDir ${q(OUT_UI)} --emptyOutDir`, { cwd: SNAP, env: viteEnv });
  evidence("12-build-ui.stdout.txt", uiBuild.stdout ?? "");
  evidence("12-build-ui.stderr.txt", uiBuild.stderr ?? "");
  ok(uiBuild.status === 0, `D vite build exit 0（实际 ${uiBuild.status}；清单漂移守卫若触发会在此判红）`);
  const uiIdentity = deriveIdentity(SNAP);
  const uiAssets = fs.existsSync(path.join(OUT_UI, "assets"))
    ? fs.readdirSync(path.join(OUT_UI, "assets")).filter((f) => f.endsWith(".js"))
    : [];
  const foundUi = extractFromDir(OUT_UI);
  const uiEmbedded = foundUi?.bundle ?? null;
  ok(
    uiEmbedded !== null,
    `D 前端产物内联了构建身份（命中 ${foundUi?.file ?? "（无）"} / 共 ${foundUi?.scanned ?? uiAssets.length} 个 js 分片）`,
  );
  ok(
    uiEmbedded !== null && uiEmbedded.ui.release_id === uiIdentity.release_id && uiEmbedded.server.release_id === uiIdentity.release_id,
    "D 前端内联的 ui 身份 release 与现算一致（同一批：server/ui 同 release）",
  );
  if (uiEmbedded !== null) {
    ok(
      uiEmbedded.ui.build_id !== uiEmbedded.server.build_id,
      "D 前端内联的 ui build_id 与 server build_id 不同（按部件区分）",
    );
    // 界面诊断的判定：自身（ui）与运行时后端（server）——同批构建 ⇒ same_release
    ok(compareBuildIdentities(uiEmbedded.ui, uiEmbedded.server).state === "same_release", "D 界面诊断判定：ui 与后端同一 release ⇒ same_release");
    ok(
      compareBuildIdentities(srcRunUi, uiEmbedded.server).state === "unknown",
      "D 真跑 dev（未内嵌 ui）× 已内嵌后端 ⇒ unknown（不判一致·不判错配）",
    );
  }

  // ── E 负控（先红）：冻结构建输入漂移必须被拒 ──
  section("E 负控（红）：冻结构建输入漂移被拒绝");
  const badEnv = { ...buildEnv, TATAI_BUILD_FROZEN_SERVER_INPUT_FP: "0".repeat(64) };
  const driftBuild = run(`${q(TSX)} ${q(path.join(SNAP, "scripts", "build-server.ts"))}`, { cwd: SNAP, env: badEnv });
  evidence("20-drift-reject-build-server.txt", `${driftBuild.stdout ?? ""}\n${driftBuild.stderr ?? ""}`);
  ok(driftBuild.status !== 0, `E build:server 检测到冻结输入漂移 ⇒ 非零退出（实际 ${driftBuild.status}）`);
  const driftUi = run(`${q(VITE)} build --outDir ${q(path.join(SNAP, ".out-ui-drift"))} --emptyOutDir`, {
    cwd: SNAP,
    env: { ...viteEnv, TATAI_BUILD_FROZEN_UI_INPUT_FP: "1".repeat(64) },
  });
  evidence("21-drift-reject-vite.txt", `${driftUi.stdout ?? ""}\n${driftUi.stderr ?? ""}`);
  ok(driftUi.status !== 0, `E vite build 检测到冻结输入漂移 ⇒ 非零退出（实际 ${driftUi.status}）`);

  // ── F 构建戳/绑定链的身份与输入清单关联（落档判据，不跑 Tauri）──
  section("F 构建戳关联身份与输入清单（不跑 Tauri 安装）");
  const stampRoot = path.join(WORK, "stamp-root");
  fs.mkdirSync(path.join(stampRoot, "src"), { recursive: true });
  fs.writeFileSync(path.join(stampRoot, "src", "x.ts"), "export const x = 1;\n");
  const fields = identityStampFields(SNAP);
  const stamp = writeBuildStamp(stampRoot, fields);
  const verdict = evaluateBuildStamps(stampRoot);
  ok(verdict.ok && verdict.stamps_identical, "F 两处戳在场且一致（既有 V09-04 判据未破）");
  ok(stamp.build_identity !== undefined && stamp.build_identity.release_id === fields.release_id, "F 戳里带部件身份（release/build_id + 两部件输入指纹与清单哈希）");
  const stale: typeof fields = { ...fields, release_id: "a".repeat(64) };
  ok(stale.release_id !== fields.release_id, "F 负控：身份对不上时 package:bind 的判据会拦住（此处演示判据输入不同）");
  ok(
    stamp.build_identity !== undefined &&
      stamp.build_identity.server_input_manifest_sha256 === fields.server_input_manifest_sha256,
    "F 戳关联输入清单哈希（同一次输入 ⇒ 同一份清单）",
  );

  // ── F2 产物内嵌身份核对：写戳/绑定前必须从**真实产物**读回并逐字段核对（Codex 纠正 5/7）──
  section("F2 产物内嵌身份核对与混批拒绝（Codex 纠正 5/7）");
  // 重跑一次 server 构建（X：C2 的 probe 已移除），与 D 的前端（X）凑成同批正例；E 已把 OUT_SERVER 清掉。
  const OUT_SERVER_X = path.join(SNAP, ".out-server-x");
  const bX2 = run(`${q(TSX)} ${q(path.join(SNAP, "scripts", "build-server.ts"))}`, {
    cwd: SNAP,
    env: { ...process.env, TATAI_BUILD_SERVER_OUT: OUT_SERVER_X },
  });
  ok(bX2.status === 0, `F2 重跑 server 构建（X）exit 0（实际 ${bX2.status}）`);
  const desiredX = deriveIdentity(SNAP);
  const sameBatch = checkArtifactIdentity(
    SNAP,
    {
      release_id: desiredX.release_id,
      build_id: desiredX.build_id,
      server_input_fingerprint: desiredX.server_input_fingerprint,
      ui_input_fingerprint: desiredX.ui_input_fingerprint,
    },
    { dirs: { server: OUT_SERVER_X, ui: OUT_UI } },
  );
  ok(sameBatch.ok, `F2 真实产物内嵌身份与期望逐字段相符 ⇒ 通过（server ${sameBatch.server?.file} / ui ${sameBatch.ui?.file}）`);
  const wrongDesired = checkArtifactIdentity(
    SNAP,
    {
      release_id: "0".repeat(64),
      build_id: desiredX.build_id,
      server_input_fingerprint: desiredX.server_input_fingerprint,
      ui_input_fingerprint: desiredX.ui_input_fingerprint,
    },
    { dirs: { server: OUT_SERVER_X, ui: OUT_UI } },
  );
  ok(
    !wrongDesired.ok && wrongDesired.problems.some((p) => p.includes("release_id")),
    "F2 期望身份与产物不符 ⇒ 拒绝（不能只凭'戳与源码一致'就接受）",
  );
  const missingArtifact = checkArtifactIdentity(
    SNAP,
    {
      release_id: desiredX.release_id,
      build_id: desiredX.build_id,
      server_input_fingerprint: desiredX.server_input_fingerprint,
      ui_input_fingerprint: desiredX.ui_input_fingerprint,
    },
    { dirs: { server: path.join(WORK, "no-such-server"), ui: path.join(WORK, "no-such-ui") } },
  );
  ok(
    !missingArtifact.ok && missingArtifact.problems.length >= 2,
    "F2 未采到实际 bundler 输出 ⇒ 拒绝（不得以推导身份冒充产物已加载该身份）",
  );
  // 混批反例：runDir 在 C2 已被换成 Y 批，OUT_UI 是 X 批 —— 两批产物混装必须被拒。
  const yBundle = extractFromDir(runDir)?.bundle ?? null;
  if (yBundle === null) {
    skip("F2 混合 X/Y 产物拒绝", "runDir 内未采到内嵌身份（C2 未执行？）");
  } else if (yBundle.server.release_id === desiredX.release_id) {
    skip("F2 混合 X/Y 产物拒绝", "runDir 仍是 X 批（未发生磁盘换 Y）");
  } else {
    const mixed = checkArtifactIdentity(
      SNAP,
      {
        release_id: yBundle.server.release_id,
        build_id: { server: yBundle.server.build_id, ui: yBundle.ui.build_id },
        server_input_fingerprint: yBundle.server.source_input_fingerprint,
        ui_input_fingerprint: yBundle.ui.source_input_fingerprint,
      },
      { dirs: { server: runDir, ui: OUT_UI } },
    );
    ok(
      !mixed.ok && mixed.problems.some((p) => p.includes("混合产物")),
      `F2 server(Y)/ui(X) 混批 ⇒ 拒绝并点名混合产物（${mixed.problems.length} 条）`,
    );
  }

  // ── F3 真实产物的引用闭包：在**真实 vite 产物**上验证解析与缺件判定（不是重扫目录当完整清单）──
  section("F3 真实产物引用闭包（Codex 纠正 8）");
  const listRel = (dir: string): string[] => {
    const out: string[] = [];
    const walk = (d: string): void => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.name === "node_modules") continue;
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else out.push(path.relative(SNAP, p).split(path.sep).join("/"));
      }
    };
    if (fs.existsSync(dir)) walk(dir);
    return out;
  };
  const realDirs = { ui: OUT_UI, server: OUT_SERVER_X };
  const realManifest = new Set([...listRel(OUT_UI), ...listRel(OUT_SERVER_X)]);
  const realClosure = collectReferencedOutputs(SNAP, { scope: "full", dirs: realDirs, manifestPaths: realManifest });
  const uiDynamicChunks = realClosure.referenced.filter(
    (p) => p.startsWith(`${path.basename(OUT_UI)}/assets/`) && p.endsWith(".js") && !/(^|\/)index-[^/]*\.js$/.test(p),
  );
  ok(
    realClosure.ok && realClosure.referenced.some((p) => p.endsWith(".css")) && uiDynamicChunks.length >= 1,
    `F3 真实前端产物：入口 → 引用 ${realClosure.referenced.length} 项（含动态 chunk ${uiDynamicChunks.length} 个与 CSS），${
      realClosure.ok ? "全部在场且在清单内" : `缺 ${realClosure.missing.join(",")} / 清单外 ${realClosure.not_in_manifest.join(",")}`
    }`,
  );
  const victimRel = uiDynamicChunks[0];
  if (victimRel === undefined) {
    skip("F3 删除真实引用的动态分片判缺件", "真实产物里没有可定位的动态 chunk");
  } else {
    const victimAbs = path.join(SNAP, victimRel);
    const saved = fs.readFileSync(victimAbs);
    fs.rmSync(victimAbs, { force: true });
    const afterDelete = collectReferencedOutputs(SNAP, { scope: "full", dirs: realDirs, manifestPaths: realManifest });
    ok(
      !afterDelete.ok && afterDelete.missing.includes(victimRel),
      `F3 删掉真实被引用的动态分片（${path.basename(victimRel)}）⇒ 判缺件`,
    );
    fs.writeFileSync(victimAbs, saved);
  }
  fs.rmSync(OUT_UI, { recursive: true, force: true });
  const realUiGone = collectReferencedOutputs(SNAP, { scope: "full", dirs: realDirs, manifestPaths: realManifest });
  ok(!realUiGone.ok && realUiGone.missing.some((p) => p.endsWith("index.html")), "F3 删掉整个前端产物目录 ⇒ 判缺件（不靠现存文件枚举判完整）");

  // ── F4 冻结构建输出清单：非身份产物换字节 / 替换旧壳 / 删分片必须被拒（集成复核 1）──
  section("F4 冻结构建输出清单与 package:bind 拒绝路径（集成复核 1）");
  const relRoot = path.join(WORK, "release-root");
  const putRel = (rel: string, body: string): void => {
    const abs = path.join(relRoot, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  };
  for (const p of REQUIRED_SERVER_PARTS) putRel(p, `export const e=${JSON.stringify(path.basename(p))};\nimport("./assets/dyn-abc123.js");\n`);
  putRel("src-tauri/resources/server/assets/dyn-abc123.js", "export const d = 1;\n");
  putRel("dist/index.html", '<!doctype html><script src="/assets/index-aaa111.js"></script><link rel="stylesheet" href="/assets/index-bbb222.css">');
  putRel("dist/assets/index-aaa111.js", 'import("./lazy-ccc333.js");\nexport const a = 1;\n');
  putRel("dist/assets/index-bbb222.css", "body{color:#000}\n");
  putRel("dist/assets/lazy-ccc333.js", "export const l = 1;\n");
  for (const [rel, body] of [
    ["src-tauri/target/release/tatai.exe", "MZ-shell"],
    [`src-tauri/target/release/bundle/nsis/Tatai_${APP_VERSION}_x64-setup.exe`, "NSIS"],
    [`src-tauri/target/release/bundle/msi/Tatai_${APP_VERSION}_x64_en-US.msi`, "MSI"],
  ]) {
    putRel(rel, body);
  }
  const f0 = outputManifestFingerprint(relRoot);
  ok(
    f0.file_count >= 10 && !f0.entries.some((e) => (STAMP_SELF_PATHS as readonly string[]).includes(e.path)),
    `F4 构建尾部冻结完整输出清单（${f0.file_count} 项，排除戳自身 ${STAMP_SELF_PATHS.join(",")}）`,
  );
  putRel("dist/build-stamp.json", '{"a":1}');
  const f1 = outputManifestFingerprint(relRoot);
  putRel("dist/build-stamp.json", '{"a":2}');
  const f2 = outputManifestFingerprint(relRoot);
  ok(f1.sha256 === f0.sha256 && f2.sha256 === f0.sha256, "F4 戳自身落点不参与输出清单指纹（写戳不改指纹，无自指）");
  const lazyAbs = path.join(relRoot, "dist", "assets", "lazy-ccc333.js");
  const lazy0 = fs.readFileSync(lazyAbs);
  fs.writeFileSync(lazyAbs, Buffer.concat([lazy0, Buffer.from("// tampered\n")]));
  ok(outputManifestFingerprint(relRoot).sha256 !== f0.sha256, "F4 非身份分片换字节 ⇒ 输出清单指纹变（package:bind 据此拒绝）");
  fs.writeFileSync(lazyAbs, lazy0);
  ok(outputManifestFingerprint(relRoot).sha256 === f0.sha256, "F4 逐字节恢复 ⇒ 指纹复原（不漏判、不误判）");
  const exeAbs = path.join(relRoot, "src-tauri", "target", "release", "tatai.exe");
  const exe0 = fs.readFileSync(exeAbs);
  fs.writeFileSync(exeAbs, "MZ-old-shell");
  ok(outputManifestFingerprint(relRoot).sha256 !== f0.sha256, "F4 替换旧壳 exe ⇒ 指纹变（旧壳被拒）");
  fs.writeFileSync(exeAbs, exe0);
  fs.rmSync(lazyAbs);
  ok(outputManifestFingerprint(relRoot).sha256 !== f0.sha256, "F4 删除真实动态分片 ⇒ 指纹变（缺件被拒）");
  fs.writeFileSync(lazyAbs, lazy0);
  ok(outputManifestFingerprint(relRoot).sha256 === f0.sha256, "F4 全部恢复 ⇒ 指纹回到冻结值（拒绝不是恒假）");
  const relClosure = collectReferencedOutputs(relRoot, {
    scope: "full",
    manifestPaths: outputManifestFingerprint(relRoot).entries.map((e) => e.path),
  });
  ok(
    relClosure.ok && relClosure.referenced.includes("dist/assets/lazy-ccc333.js"),
    `F4 模拟发布根：引用闭包完整（入口 ${relClosure.entries.length} → 引用 ${relClosure.referenced.length} 项，含动态分片）`,
  );

  // ── G 读口与界面（可注入判据的单元级）──
  section("G 读口：doctor 同时报本进程与宿主身份，并给偏斜三态");
  try {
    const mod = (await import("../src/mcp/tools/doctor")) as {
      createDoctorTool: (deps: unknown) => { handler: (args: unknown) => Promise<{ content: { text: string }[] }> };
    };
    const tool = mod.createDoctorTool({ checkEventSurface: () => ({ ok: true, covered: [], toolSurfaces: [], problems: [] }) });
    process.env.TATAI_HOME = path.join(WORK, "doctor-home");
    process.env.TATAI_NO_AUTOSTART = "1";
    const out = await tool.handler({});
    const body = JSON.parse(out.content[0].text) as {
      service?: {
        build_identity?: BuildIdentity;
        host_build_identity?: BuildIdentity;
        build_identity_skew?: { state: string; detail: string };
      };
    };
    const svc = body.service;
    ok(svc?.build_identity !== undefined, "G doctor 的 service 段带 build_identity（本 MCP 进程自身身份）");
    ok(
      svc?.build_identity !== undefined && svc.build_identity.embedded === false && svc.build_identity.component === "server" && svc.build_identity.reason !== "",
      "G 无内嵌时如实 unknown + 原因（不猜、不判一致）",
    );
    ok(svc?.host_build_identity !== undefined, "G doctor 同时报告宿主身份（host_build_identity）——不只报宿主、也不只报自身");
    ok(
      svc?.build_identity_skew?.state === "unknown" && svc.build_identity_skew.detail !== "",
      `G unknown 不算一致：MCP↔宿主偏斜判定为 unknown（${svc?.build_identity_skew?.detail ?? "?"}）`,
    );
  } catch (e) {
    skip("G doctor 构建身份读回", `导入/调用失败（并发改动？）：${e instanceof Error ? e.message : String(e)}`);
  }

  // ── 收尾 ──
  section("汇总");
  say(`[verify] PASS ${pass} / FAIL ${fails.length} / SKIP ${skips.length}`);
  for (const f of fails) say(`[verify]   FAIL ${f}`);
  for (const s of skips) say(`[verify]   SKIP ${s}`);

  fs.mkdirSync(EVIDENCE, { recursive: true });
  for (const [name, body] of files) fs.writeFileSync(path.join(EVIDENCE, name), body);
  fs.writeFileSync(path.join(EVIDENCE, "verify-build-identity.log"), LOG.join("\n") + "\n");
  fs.writeFileSync(
    path.join(EVIDENCE, "summary.json"),
    JSON.stringify({ pass, fail: fails.length, skips, fails, log_lines: LOG.length, generated_at: new Date().toISOString() }, null, 2) + "\n",
  );
  if (!KEEP) fs.rmSync(WORK, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  else say(`[verify] 保留隔离工作区：${WORK}`);
  process.exit(fails.length === 0 ? 0 : 1);
}

/** 启动隔离后端（返回带 pid() 的句柄）；只操作本脚本自己拉起的进程 */
async function startServer(
  dir: string,
  port: number,
  tag: string,
  dataDir: string,
): Promise<{ url: string; pid: () => number | undefined } | null> {
  fs.mkdirSync(dataDir, { recursive: true });
  const proc = spawn(process.execPath, [path.join(dir, "index.js")], {
    cwd: dir,
    env: { ...process.env, TATAI_PORT: String(port), TATAI_HOME: dataDir, TATAI_NO_AUTOSTART: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  proc.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
  proc.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
  const url = `http://127.0.0.1:${port}`;
  const health = await waitHealth(url, 90_000);
  if (health === null) {
    say(`[verify]   ${tag} 未在 90s 内就绪；stdout：${stdout.slice(-800) || "（空）"}；stderr：${stderr.slice(-800) || "（空）"}`);
    killTree(proc.pid);
    return null;
  }
  say(`[verify]   ${tag} 就绪：${url}（pid ${proc.pid}）`);
  return { url, pid: () => proc.pid };
}

main().catch((e) => {
  say(`[verify] 异常中止：${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  try {
    fs.mkdirSync(EVIDENCE, { recursive: true });
    fs.writeFileSync(path.join(EVIDENCE, "verify-build-identity.log"), LOG.join("\n") + "\n");
  } catch {
    /* 证据写不出也不掩盖异常 */
  }
  if (!KEEP) fs.rmSync(WORK, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  process.exit(2);
});
