// 构建身份推导（P0 / 卡 V09-45；docs/agent-optimization-20261006.md §4.2、§4.3、§4.4）。
// 构建期专用：算 server / ui 两组**显式构建输入集**的内容指纹，再推 `release_id` / `build_id`，
// 并把结果交给构建器 `define` 内联进产物（`src/shared/buildIdentity.ts` 在运行期只读那份内嵌常量）。
//
// 与既有链的关系（§4.5，不另造第二套判据）：
//   · 全树 `sourceFingerprint`（`scripts/lib/sourceFingerprint.ts`）**保持原用途**，本文件**不**复用它
//     充当身份输入指纹——全树 SKIP_DIRS 不含 `resources`，会把 `src-tauri/resources/server/` 这个
//     自指产物吃进指纹（§4.2 硬要求）。
//   · 产物侧继续用 `buildOutputManifest`（`scripts/lib/buildOutputManifest.ts`），身份只是**关联**上去。
//
// 红线：
//   · 输入集**只写一处**（下面的 INPUT_SETS），显式排除一切输出与身份自身生成物（避免自指）。
//   · 第三方模块按**锁文件与工具链**归属，不按源码清单判——`node_modules/` 下的模块与 Node 内建
//     一律排除在"清单外源码"判定之外（Codex 对 P0 的纠正：不能把 node_modules 全误判成漂移）。
//   · 序列化复用唯一纯原语 `src/shared/stableJson.ts`（不改写第二份近似实现）。
//   · 读不出的工具链版本如实写 "unknown"，**不编**。
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stableStringify } from "../../src/shared/stableJson";
import { APP_VERSION } from "../../src/shared/version";
import { narrowKnownIdentity } from "../../src/shared/buildIdentity";
import type {
  BuildComponent,
  BuildIdentityBundle,
  BundlerVersions,
  KnownBuildIdentity,
  ToolchainIdentity,
} from "../../src/shared/buildIdentity";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** 构建器 `define` 注入的标识符名（与 `src/shared/buildIdentity.ts` 的 declare 同名，只此一处） */
export const BUILD_IDENTITY_DEFINE = "__TATAI_BUILD_IDENTITY__";

// ───────────────────────── 显式构建输入集（只写一处） ─────────────────────────
//
// 覆盖要求（§4.2）：部件的**实际共享依赖** + **静态资源** + **构建配置与工具链输入**。
// 共享依赖（`src/shared/**`、被两侧实际引用的 `src/arch/**`）同时进两边集合——以构建实际模块图核对
// （`detectInputDrift` 在构建后把真实打进产物的模块清单与本清单逐条比对，清单悄悄过期不会变假绿）。

interface InputSetSpec {
  component: BuildComponent;
  /** 纳入模式：`dir/**` 表示整棵子树；不带 `*` 的按精确相对路径 */
  include: readonly string[];
}

export const INPUT_SETS: Record<BuildComponent, InputSetSpec> = {
  server: {
    component: "server",
    include: [
      "src/server/**",
      "src/mcp/**",
      "src/shared/**",
      "src/arch/**",
      // 以下三个 UI 源文件被**服务端/MCP 侧真实引入**（vite SSR 构建的模块图核对结果，
      // 见 `src/mcp/tools/getArch.ts:23-24` → `src/ui/arch/projectGraph.ts:27-28` → `./provenance`），
      // 因此进 server 输入集。**不是**把整个 `src/ui/**` 拉进来——清单只收真正打进产物的仓库内模块，
      // 这个耦合将来变化时由构建后的漂移检测点名（不静默过期）。
      "src/ui/arch/projectGraph.ts",
      "src/ui/arch/provenance.ts",
      "src/ui/arch/statusColor.ts",
      // 静态资源：vite SSR 构建同样按默认 publicDir 把 `public/**` 拷进后端产物（实测产物根有
      // tatai-favicon.svg / tatai-mark.svg），所以它也是后端构建输入。
      "public/**",
      "scripts/build-server.ts",
      "scripts/lib/buildIdentity.ts",
      "package.json",
      "pnpm-lock.yaml",
      "tsconfig.json",
      "src-tauri/tauri.conf.json",
    ],
  },
  ui: {
    component: "ui",
    include: [
      "src/ui/**",
      "src/shared/**",
      "src/arch/**",
      "index.html",
      "public/**",
      "vite.config.ts",
      "package.json",
      "pnpm-lock.yaml",
      "tsconfig.json",
      "src-tauri/tauri.conf.json",
    ],
  },
};

/** 显式排除：一切**输出**（自指风险）+ 版本控制/私有/缓存噪音。判据只写这一处。 */
const EXCLUDED_PATH_PREFIXES: readonly string[] = [
  "dist/",
  "src-tauri/target/",
  "src-tauri/resources/", // 含 resources/server/**（随包后端产物）——自指反例，§4.2 硬要求
  "audit/",
];

/** 任意层级都排除的目录段（node_modules 可能在深层） */
const EXCLUDED_DIR_SEGMENTS: readonly string[] = ["node_modules", ".git", ".工作台", "audit", "__pycache__", "dist"];

/** 身份自身生成物（本批走 define 内联、不落文件；名字预排以防将来引入自指） */
const IDENTITY_ARTIFACT_RE = /(?:^|\/)[^/]*build-identity[^/]*\.json$/;

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

/** 该相对路径是否被显式排除（输出/私有/缓存/身份生成物） */
export function isExcludedPath(rel: string): boolean {
  const r = toPosix(rel).replace(/^\.\//, "");
  if (EXCLUDED_PATH_PREFIXES.some((p) => r === p.slice(0, -1) || r.startsWith(p))) return true;
  if (r.split("/").some((seg) => EXCLUDED_DIR_SEGMENTS.includes(seg))) return true;
  if (IDENTITY_ARTIFACT_RE.test(r)) return true;
  return false;
}

/** 该相对路径是否落在某部件的显式输入集内 */
export function isInputPath(component: BuildComponent, rel: string): boolean {
  const r = toPosix(rel).replace(/^\.\//, "");
  if (isExcludedPath(r)) return false;
  return INPUT_SETS[component].include.some((pat) =>
    pat.endsWith("/**") ? r.startsWith(pat.slice(0, -2)) : r === pat,
  );
}

export interface InputFileEntry {
  path: string;
  sha256: string;
  bytes: number;
}

export interface ComponentInputs {
  component: BuildComponent;
  /** 相对路径 + 文件字节的确定性 sha256（与 Git ref 无关：只 commit 不动内容 ⇒ 不变） */
  fingerprint: string;
  file_count: number;
  /** 清单自身的哈希（相对路径 + 每文件 sha256，定序）——绑定记录用它关联"输入清单" */
  manifest_sha256: string;
  files: InputFileEntry[];
  /** 清单里点名但当前不在场的路径（如实带出，不静默） */
  missing_includes: string[];
}

/** 列出某部件输入集里的全部文件（相对路径，已排除输出/私有/缓存） */
export function listInputFiles(component: BuildComponent, root: string): { files: string[]; missing: string[] } {
  const spec = INPUT_SETS[component];
  const out = new Set<string>();
  const missing: string[] = [];
  for (const pat of spec.include) {
    if (pat.endsWith("/**")) {
      const dirRel = pat.slice(0, -3);
      const dirAbs = path.join(root, dirRel);
      if (!fs.existsSync(dirAbs)) {
        missing.push(pat);
        continue;
      }
      const walk = (dir: string): void => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
          const abs = path.join(dir, e.name);
          const rel = toPosix(path.relative(root, abs));
          if (isExcludedPath(rel)) continue;
          if (e.isDirectory()) walk(abs);
          else if (e.isFile() || e.isSymbolicLink()) out.add(rel);
        }
      };
      walk(dirAbs);
    } else {
      const abs = path.join(root, pat);
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) out.add(toPosix(pat));
      else missing.push(pat);
    }
  }
  return { files: [...out].sort(), missing };
}

/** 算某部件的输入指纹（内容哈希）与清单哈希 */
export function computeComponentInputs(component: BuildComponent, root: string): ComponentInputs {
  const { files, missing } = listInputFiles(component, root);
  const entries: InputFileEntry[] = [];
  const h = crypto.createHash("sha256");
  for (const rel of files) {
    const bytes = fs.readFileSync(path.join(root, rel));
    h.update(rel, "utf8");
    h.update(bytes);
    entries.push({ path: rel, sha256: crypto.createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length });
  }
  const mh = crypto.createHash("sha256");
  for (const e of entries) mh.update(`${e.path}\n${e.sha256}\n`, "utf8");
  return {
    component,
    fingerprint: h.digest("hex"),
    file_count: entries.length,
    manifest_sha256: mh.digest("hex"),
    files: entries,
    missing_includes: missing,
  };
}

// ───────────────────────── 清单漂移检测（构建后，§4.2） ─────────────────────────

export interface DriftReport {
  component: BuildComponent;
  ok: boolean;
  /** 打进产物的**仓库内**源码模块（去重、定序） */
  repo_modules: string[];
  /** 仓库内、但在显式清单之外的模块 ⇒ 漂移（**FAIL**，不静默放行） */
  outside: string[];
  /** 解析到输出目录（dist/、resources/server/…）的仓库内模块 ⇒ 输出自指（**FAIL**） */
  output_self_reference: string[];
  /** 仓库外的绝对源文件/软链真实目标，且**不在本仓依赖树**里 ⇒ 未声明外部源码（**FAIL**，
   *  除非经 `declaredExternal` 显式声明并做内容绑定）——不能因为"在 root 外"就静默当第三方放行 */
  external_undeclared: string[];
  /** 经 `declaredExternal` 显式声明、且已做内容绑定的外部源（绝对路径，定序） */
  external_declared: string[];
  /** 显式声明外部源的逐文件内容哈希（路径 → sha256；读不出写 "unreadable"） */
  declared_external_hashes: Record<string, string>;
  /** 被排除在"清单外源码"判定之外的**本仓依赖树**内第三方/内建模块数（按锁文件与工具链归属，§4.2） */
  external_modules: number;
  /** 非文件路径标识（node 内建、虚拟模块等）数 */
  non_path_ids: number;
}

/** 本仓可以承载依赖的 node_modules 根：逻辑路径与（junction/symlink 下的）真实路径各记一个，
 *  以免把经 junction 解析出的第三方路径误判成"仓库外源码"。 */
function nodeModulesRoots(root: string): string[] {
  const roots = [path.resolve(root, "node_modules")];
  try {
    const real = fs.realpathSync(path.join(root, "node_modules"));
    if (!roots.includes(real)) roots.push(real);
  } catch {
    /* 没有 node_modules 也照常判（此处只影响分类，不影响命中） */
  }
  return roots;
}

function isWithin(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export interface DriftOptions {
  /** 显式声明的外部源（绝对路径或目录前缀）：声明即接受，并对精确文件做内容绑定。
   *  不声明则一律判 `external_undeclared`（FAIL）——"在 root 外"本身不是放行理由。 */
  declaredExternal?: readonly string[];
}

/**
 * 把"实际打进产物的模块清单"与显式输入集比对。
 * 判定：仓库内模块出现在清单外 ⇒ FAIL；仓库外**非本仓依赖**的绝对源 ⇒ FAIL（未声明外部源码）；
 * `node_modules/`（本仓依赖树内）与 Node 内建不计入清单外判定。
 */
export function detectInputDrift(
  component: BuildComponent,
  moduleIds: readonly unknown[],
  root: string,
  opts: DriftOptions = {},
): DriftReport {
  const declared = (opts.declaredExternal ?? []).map((p) => toPosix(p));
  const nmRoots = nodeModulesRoots(root);
  const repoModules = new Set<string>();
  const outside = new Set<string>();
  const selfRef = new Set<string>();
  const undeclared = new Set<string>();
  const declaredHit = new Set<string>();
  const declaredHashes: Record<string, string> = {};
  let external = 0;
  let nonPath = 0;
  for (const raw of moduleIds) {
    const id = typeof raw === "string" ? raw : "";
    if (id === "" || id.startsWith("\0")) {
      nonPath++;
      continue;
    }
    const clean = id.split("?")[0].split("#")[0];
    if (!path.isAbsolute(clean)) {
      // 裸模块名（node:fs、vite、\0virtual）——不是仓库内源文件
      nonPath++;
      continue;
    }
    const norm = toPosix(clean);
    // ① 显式声明的外部源：接受，并做内容绑定（覆盖"外部源码也打进包"的合法场景）
    if (declared.some((d) => norm === d || (d !== "" && norm.startsWith(`${d.replace(/\/$/, "")}/`)))) {
      declaredHit.add(norm);
      if (!(norm in declaredHashes)) {
        try {
          declaredHashes[norm] = crypto.createHash("sha256").update(fs.readFileSync(clean)).digest("hex");
        } catch {
          declaredHashes[norm] = "unreadable";
        }
      }
      continue;
    }
    // ② 本仓依赖树内的 node_modules：按锁文件与工具链归属，判第三方（不误判）
    if (isRepoDependency(clean, nmRoots)) {
      external++;
      continue;
    }
    // ③ 别的 node_modules（不在本仓依赖树里）：归属不可证明 ⇒ 未声明外部源
    if (norm.includes("/node_modules/")) {
      undeclared.add(norm);
      continue;
    }
    // ④ 仓库外、非依赖的绝对源（含软链真实目标落在仓外的**源码**）⇒ 未声明外部源，不静默跳过
    const rel = toPosix(path.relative(root, clean));
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      undeclared.add(norm);
      continue;
    }
    if (EXCLUDED_DIR_SEGMENTS.includes(rel.split("/")[0]) || EXCLUDED_PATH_PREFIXES.some((p) => rel.startsWith(p))) {
      // 仓库内、但位于输出目录：绝不应出现在构建输入模块图里（自指）
      selfRef.add(rel);
      continue;
    }
    repoModules.add(rel);
    if (!isInputPath(component, rel)) outside.add(rel);
  }
  return {
    component,
    ok: outside.size === 0 && selfRef.size === 0 && undeclared.size === 0,
    repo_modules: [...repoModules].sort(),
    outside: [...outside].sort(),
    output_self_reference: [...selfRef].sort(),
    external_undeclared: [...undeclared].sort(),
    external_declared: [...declaredHit].sort(),
    declared_external_hashes: declaredHashes,
    external_modules: external,
    non_path_ids: nonPath,
  };
}

/** 某个绝对模块路径是否落在本仓依赖树（任一 node_modules 根）之下。 */
function isRepoDependency(clean: string, nmRoots: readonly string[]): boolean {
  if (!toPosix(clean).includes("/node_modules/")) return false;
  const abs = path.resolve(clean);
  return nmRoots.some((r) => isWithin(abs, path.resolve(r)));
}

// ───────────────────────── 工具链身份（§4.1、§4.3；Codex 对 P0 的纠正） ─────────────────────────
//
// 「编译目标」与「打包器版本」必须是**实际生效**的事实，不是可以被环境变量随手改掉的纯标签：
//   · server 目标 = `scripts/build-server.ts` 传给 vite 的 `build.target`（同一个常量驱动，标签即开关）；
//   · ui 目标     = `vite.config.ts` 传给 vite 的 `build.target`（同上）；
//   · 打包器版本   = 从已安装依赖解析（vite 从仓库根，rollup/esbuild 从 vite 自身），读不出写 unknown。
// 因此"同源码 + 同锁文件、但实际编译目标/打包器不同"必然得到不同的 release_id。

/** 后端（SSR）编译目标：与 `build-server.ts` 的 `build.target` 同源。 */
export const SERVER_BUILD_TARGET = "node20";
/** 前端编译目标：与 `vite.config.ts` 的 `build.target` 同源。
 *  取 vite 7 的默认值字面量——显式声明成同一个值，行为与"不设"逐字等价，但标签不再是"猜的默认"。 */
export const UI_BUILD_TARGET = "baseline-widely-available";

/**
 * pnpm 版本：**不调用 pnpm**（现场有非标准隐式安装包装，`pnpm exec` 会触发准备/写 node_modules）。
 * 只读 `node_modules/.modules.yaml` 的 `packageManager` 字段（安装器自己写下的实际版本）；
 * 读不出再退回 `npm_config_user_agent`；仍读不出如实写 "unknown"。
 */
export function detectPnpmVersion(root: string): string {
  const modulesYaml = path.join(root, "node_modules", ".modules.yaml");
  try {
    if (fs.existsSync(modulesYaml)) {
      const raw = fs.readFileSync(modulesYaml, "utf8");
      const m = /"packageManager"\s*:\s*"pnpm@([^"]+)"/.exec(raw) ?? /packageManager:\s*pnpm@(\S+)/.exec(raw);
      if (m) return m[1];
    }
  } catch {
    /* 读不出 → 继续退回 */
  }
  const ua = process.env.npm_config_user_agent ?? "";
  const m = /pnpm\/(\S+)/.exec(ua);
  return m ? m[1] : "unknown";
}

/** 从某个包自身解析依赖版本（vite 的 rollup/esbuild 是它的运行时依赖，不在仓库根）。读不出写 unknown。 */
function versionOf(req: NodeJS.Require, pkg: string): string {
  try {
    return (JSON.parse(fs.readFileSync(req.resolve(`${pkg}/package.json`), "utf8")) as { version?: string }).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

/** 实际参与编译的打包器版本：vite 从仓库根解析，rollup/esbuild 从 vite 自身解析。读不出如实 unknown。 */
export function detectBundlerVersions(root: string = REPO_ROOT): BundlerVersions {
  const unknown: BundlerVersions = { vite: "unknown", rollup: "unknown", esbuild: "unknown" };
  let rootReq: NodeJS.Require;
  try {
    rootReq = createRequire(path.join(root, "package.json"));
    rootReq.resolve("vite/package.json");
  } catch {
    return unknown;
  }
  const vite = versionOf(rootReq, "vite");
  try {
    const viteReq = createRequire(rootReq.resolve("vite/package.json"));
    return { vite, rollup: versionOf(viteReq, "rollup"), esbuild: versionOf(viteReq, "esbuild") };
  } catch {
    return { ...unknown, vite };
  }
}

/** 工具链身份：构建环境 + 两部件实际编译目标 + 实际打包器版本（进 release_id）。 */
export function toolchainIdentity(root: string = REPO_ROOT): ToolchainIdentity {
  return {
    node: process.version,
    pnpm: detectPnpmVersion(root),
    platform: process.platform,
    arch: process.arch,
    targets: { server: SERVER_BUILD_TARGET, ui: UI_BUILD_TARGET },
    bundler: detectBundlerVersions(root),
  };
}

// ───────────────────────── release_id / build_id（§4.3） ─────────────────────────

function sha256(s: string): string {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

/** release_id = sha256(canonical_json([APP_VERSION, server_input_fp, ui_input_fp, toolchain])) */
export function computeReleaseId(
  serverInputFp: string,
  uiInputFp: string,
  toolchain: ToolchainIdentity,
  appVersion: string = APP_VERSION,
): string {
  return sha256(stableStringify([appVersion, serverInputFp, uiInputFp, toolchain]));
}

/** build_id = sha256(canonical_json([release_id, component])) */
export function computeBuildId(releaseId: string, component: BuildComponent): string {
  return sha256(stableStringify([releaseId, component]));
}

export interface IdentityDerivation {
  app_version: string;
  toolchain: ToolchainIdentity;
  server_input_fingerprint: string;
  ui_input_fingerprint: string;
  release_id: string;
  build_id: Record<BuildComponent, string>;
  /** 两部件共同的内嵌身份束（构建器 define 的取值） */
  identities: BuildIdentityBundle;
}

/**
 * 推导一次构建的整份身份。
 * `builtAt` 可注入（验证脚本用）；缺省取当前时刻。`built_at` **只标时间**，不参与 release_id/build_id。
 */
export function deriveIdentity(
  root: string,
  opts: {
    builtAt?: Partial<Record<BuildComponent, string>>;
    appVersion?: string;
    /** 冻结的输入（构建期优先用它，保证同一次构建的两部件拿到同一份指纹） */
    inputs?: FrozenInputs;
  } = {},
): IdentityDerivation {
  const inputs =
    opts.inputs ??
    ({
      server_input_fingerprint: computeComponentInputs("server", root).fingerprint,
      ui_input_fingerprint: computeComponentInputs("ui", root).fingerprint,
      toolchain: toolchainIdentity(root),
    } satisfies FrozenInputs);
  const toolchain = inputs.toolchain;
  const appVersion = opts.appVersion ?? APP_VERSION;
  const releaseId = computeReleaseId(inputs.server_input_fingerprint, inputs.ui_input_fingerprint, toolchain, appVersion);
  const mk = (component: BuildComponent, inputFp: string): KnownBuildIdentity => ({
    schema_version: 1,
    component,
    embedded: true,
    release_id: releaseId,
    build_id: computeBuildId(releaseId, component),
    source_input_fingerprint: inputFp,
    built_at: opts.builtAt?.[component] ?? new Date().toISOString(),
    toolchain,
  });
  const server = mk("server", inputs.server_input_fingerprint);
  const ui = mk("ui", inputs.ui_input_fingerprint);
  return {
    app_version: appVersion,
    toolchain,
    server_input_fingerprint: inputs.server_input_fingerprint,
    ui_input_fingerprint: inputs.ui_input_fingerprint,
    release_id: releaseId,
    build_id: { server: server.build_id, ui: ui.build_id },
    identities: { server, ui },
  };
}

/** 构建器 `define` 的取值（JSON 文本；vite/rollup 编译期把标识符替换成它） */
export function buildDefineValue(identities: BuildIdentityBundle): string {
  return JSON.stringify(identities);
}

/** `define` 配置片段（vite.config.ts 与 scripts/build-server.ts 共用一份组装） */
export function buildDefineConfig(identities: BuildIdentityBundle): Record<string, string> {
  return { [BUILD_IDENTITY_DEFINE]: buildDefineValue(identities) };
}

// ───────────────────────── 冻结 → 构建 → 重核（§4.2 末段） ─────────────────────────

export const FROZEN_ENV = {
  serverInputFp: "TATAI_BUILD_FROZEN_SERVER_INPUT_FP",
  uiInputFp: "TATAI_BUILD_FROZEN_UI_INPUT_FP",
  toolchain: "TATAI_BUILD_FROZEN_TOOLCHAIN",
} as const;

export interface FrozenInputs {
  server_input_fingerprint: string;
  ui_input_fingerprint: string;
  toolchain: ToolchainIdentity;
}

/** 冻结当前输入（取一次指纹 + 工具链），供子进程与构建后复核共用 */
export function freezeInputs(root: string = REPO_ROOT): FrozenInputs {
  return {
    server_input_fingerprint: computeComponentInputs("server", root).fingerprint,
    ui_input_fingerprint: computeComponentInputs("ui", root).fingerprint,
    toolchain: toolchainIdentity(root),
  };
}

/** 冻结值 → 传给子进程的环境变量（构建期子进程据此固定同一份输入，不各自现算一遍） */
export function frozenEnv(frozen: FrozenInputs): Record<string, string> {
  return {
    [FROZEN_ENV.serverInputFp]: frozen.server_input_fingerprint,
    [FROZEN_ENV.uiInputFp]: frozen.ui_input_fingerprint,
    [FROZEN_ENV.toolchain]: JSON.stringify(frozen.toolchain),
  };
}

export interface ReconciledInputs {
  /** 现算的输入（未冻结时即权威值） */
  current: FrozenInputs;
  /** 环境里带着冻结值时：现算与冻结是否一致 */
  drifted: boolean;
  /** 不一致的逐条原因（空数组表示一致或未冻结） */
  reasons: string[];
  /** 权威值：带冻结值的取冻结值（构建期不应被中途改动影响），否则取现算值 */
  effective: FrozenInputs;
}

/**
 * 构建期解析输入：有冻结值就以冻结值为准，并**核实现算值未漂移**（不一致 ⇒ `drifted:true`，
 * 调用方**必须 FAIL**，不静默放行）。没有冻结值（`pnpm build:server` / `vite build` 单跑）则现算。
 */
export function reconcileInputs(root: string = REPO_ROOT, env: NodeJS.ProcessEnv = process.env): ReconciledInputs {
  const current = freezeInputs(root);
  const envServer = env[FROZEN_ENV.serverInputFp];
  const envUi = env[FROZEN_ENV.uiInputFp];
  const envToolchain = env[FROZEN_ENV.toolchain];
  if (envServer === undefined && envUi === undefined && envToolchain === undefined) {
    return { current, drifted: false, reasons: [], effective: current };
  }
  const reasons: string[] = [];
  let toolchain: ToolchainIdentity | null = null;
  if (envToolchain !== undefined) {
    try {
      toolchain = JSON.parse(envToolchain) as ToolchainIdentity;
    } catch {
      reasons.push(`冻结的工具链身份不是合法 JSON（${FROZEN_ENV.toolchain}）`);
    }
  }
  const effective: FrozenInputs = {
    server_input_fingerprint: envServer ?? current.server_input_fingerprint,
    ui_input_fingerprint: envUi ?? current.ui_input_fingerprint,
    toolchain: toolchain ?? current.toolchain,
  };
  if (envServer !== undefined && envServer !== current.server_input_fingerprint) {
    reasons.push(
      `server 构建输入在构建期漂移：冻结 ${envServer.slice(0, 16)}… ≠ 现算 ${current.server_input_fingerprint.slice(0, 16)}…`,
    );
  }
  if (envUi !== undefined && envUi !== current.ui_input_fingerprint) {
    reasons.push(
      `ui 构建输入在构建期漂移：冻结 ${envUi.slice(0, 16)}… ≠ 现算 ${current.ui_input_fingerprint.slice(0, 16)}…`,
    );
  }
  if (toolchain !== null && stableStringify(toolchain) !== stableStringify(current.toolchain)) {
    reasons.push(`工具链身份在构建期漂移：冻结 ${stableStringify(toolchain)} ≠ 现算 ${stableStringify(current.toolchain)}`);
  }
  return { current, drifted: reasons.length > 0, reasons, effective };
}

// ───────────────────────── 落档：写进构建戳/绑定记录的"身份 + 输入清单"字段（§4.5） ─────────────────────────

export interface IdentityStampFields {
  release_id: string;
  build_id: Record<BuildComponent, string>;
  server_input_fingerprint: string;
  ui_input_fingerprint: string;
  server_input_file_count: number;
  ui_input_file_count: number;
  server_input_manifest_sha256: string;
  ui_input_manifest_sha256: string;
  toolchain: ToolchainIdentity;
}

/**
 * 按**当前工作树**算一份可落档的身份字段（构建戳 / 绑定记录共用）。
 * 用在构建尾部：此时树应已冻结（包 bind 与 tauri:build 会拿它与构建期推导值对账，不一致即判红）。
 */
export function identityStampFields(root: string = REPO_ROOT, appVersion: string = APP_VERSION): IdentityStampFields {
  const server = computeComponentInputs("server", root);
  const ui = computeComponentInputs("ui", root);
  const toolchain = toolchainIdentity(root);
  const releaseId = computeReleaseId(server.fingerprint, ui.fingerprint, toolchain, appVersion);
  return {
    release_id: releaseId,
    build_id: { server: computeBuildId(releaseId, "server"), ui: computeBuildId(releaseId, "ui") },
    server_input_fingerprint: server.fingerprint,
    ui_input_fingerprint: ui.fingerprint,
    server_input_file_count: server.file_count,
    ui_input_file_count: ui.file_count,
    server_input_manifest_sha256: server.manifest_sha256,
    ui_input_manifest_sha256: ui.manifest_sha256,
    toolchain,
  };
}

// ───────────────────────── 读回：从产物目录里的入口文件反查内嵌身份（只读、可选） ─────────────────────────

/**
 * 把打包器打印出来的对象字面量读回对象：先按严格 JSON 试；失败时只对**属性名**补引号再试。
 * 身份对象的取值全是字符串/数字/布尔（打包器一律带引号或按字面量打印），故这个宽容化只可能碰到键名；
 * 仍读不出就返回 null（读不出就当读不出，**不**猜）。
 */
function parseObjectLiteral(slice: string): Record<string, unknown> | null {
  // 候选形态：① 严格 JSON（define 的原始文本）；② 打包器重新打印（键去引号、冒号后空格）；
  // 两者都可能被**压缩**版把布尔打印成 `!0`/`!1`（生产前端产物就是这种）。取值全是字符串/数字/布尔，
  // 故只做这些形态归一，读不出仍然返回 null（读不出就当读不出，不猜）。
  const candidates = [slice, slice.replace(/([{,]\s*)([A-Za-z_$][A-Za-z0-9_$]*)(\s*:)/g, '$1"$2"$3')];
  for (const cand of candidates) {
    const normalized = cand
      .replace(/([:,[{]\s*)!0(?=\s*[,}\]])/g, "$1true")
      .replace(/([:,[{]\s*)!1(?=\s*[,}\]])/g, "$1false");
    try {
      return JSON.parse(normalized) as Record<string, unknown>;
    } catch {
      /* 试下一个候选形态 */
    }
  }
  return null;
}

/**
 * 从构建出的 JS 文本里取内嵌身份（发布阶段/验证用只读抽查）。
 * **不是**运行期读口：活进程的身份只来自启动时载入的常量（§4.4），这里只用于离线核对产物内容。
 */
export function extractEmbeddedIdentity(jsText: string): BuildIdentityBundle | null {
  // define 的值先被默认的 JSON 文本给出，但打包器会把它当表达式**重新打印**（键多半不再带引号、
  // 冒号后带空格），所以这里既认 `{"server":{…` 也认 `{ server: { …`。定位用正则，取整段做括号配平。
  const located = /\{\s*(?:"server"|server)\s*:\s*\{\s*(?:"schema_version"|schema_version)\s*:/.exec(jsText);
  if (located === null) return null;
  const start = located.index;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < jsText.length; i++) {
    const ch = jsText[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const slice = jsText.slice(start, i + 1);
        const raw = parseObjectLiteral(slice);
        if (raw === null) return null;
        // 逐部件按共享判据收窄：字段不合法就当读不出（不猜、不补）
        const server = narrowKnownIdentity("server", raw.server);
        const ui = narrowKnownIdentity("ui", raw.ui);
        return server !== null && ui !== null ? { server, ui } : null;
      }
    }
  }
  return null;
}

// ───────────────────────── 产物内嵌身份读回与校验（§4.5；Codex 对 P0 的纠正 5/7） ─────────────────────────
//
// 「构建前置推导出身份」**不等于**「产物里真的有这份身份」。写戳/写绑定之前必须从**真实产物**里把内嵌
// 身份读回来逐字段核对，否则"编译没跑到/产物是旧批/批次混用"都能被一句自述盖过去。

export interface ArtifactIdentityHit {
  bundle: BuildIdentityBundle;
  /** 命中的产物文件（相对被扫目录） */
  file: string;
  /** 被扫过的 .js 文件数（含未命中的） */
  scanned: number;
}

/** 扫一个产物目录里的全部 .js（递归，排除 node_modules），取**第一份**可解析的内嵌身份。
 *  身份可能落在经地码分包的共享 chunk（`assets/*.js`）而不是入口文件，故必须递归扫。 */
export function scanArtifactIdentity(dir: string): ArtifactIdentityHit | null {
  if (!fs.existsSync(dir)) return null;
  const jsFiles: string[] = [];
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === "node_modules") continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".js")) jsFiles.push(p);
    }
  };
  walk(dir);
  for (const f of jsFiles) {
    const found = extractEmbeddedIdentity(fs.readFileSync(f, "utf8"));
    if (found !== null) return { bundle: found, file: toPosix(path.relative(dir, f)), scanned: jsFiles.length };
  }
  return null;
}

export interface ArtifactDirs {
  server: string;
  ui: string;
}

/** 两部件产物目录（可用环境变量隔离，与 build-server / vite 的覆盖口径一致）：
 *  server = TATAI_BUILD_SERVER_OUT ?? src-tauri/resources/server；ui = dist。 */
export function artifactDirs(root: string = REPO_ROOT): ArtifactDirs {
  return {
    server: process.env.TATAI_BUILD_SERVER_OUT
      ? path.resolve(process.env.TATAI_BUILD_SERVER_OUT)
      : path.join(root, "src-tauri", "resources", "server"),
    ui: path.join(root, "dist"),
  };
}

/** 期望的部件身份（戳/绑定记录的字段子集，或构建期推导结果）。 */
export interface DesiredIdentity {
  release_id: string;
  build_id: Record<BuildComponent, string>;
  server_input_fingerprint: string;
  ui_input_fingerprint: string;
}

export interface ArtifactIdentityVerdict {
  ok: boolean;
  problems: string[];
  server: ArtifactIdentityHit | null;
  ui: ArtifactIdentityHit | null;
  dirs: ArtifactDirs;
}

/** 逐字段核对：产物里读回的 `identity` 是否就是 `desired` 描述的那一次构建。 */
function diffIdentity(
  where: string,
  actual: KnownBuildIdentity,
  component: BuildComponent,
  desired: DesiredIdentity,
): string[] {
  const problems: string[] = [];
  const wantInputFp = component === "server" ? desired.server_input_fingerprint : desired.ui_input_fingerprint;
  if (actual.release_id !== desired.release_id) {
    problems.push(
      `${where}：内嵌 release_id ${actual.release_id.slice(0, 12)}… ≠ 期望 ${desired.release_id.slice(0, 12)}…（产物不是这批构建）`,
    );
  }
  if (actual.build_id !== desired.build_id[component]) {
    problems.push(`${where}：内嵌 build_id ${actual.build_id.slice(0, 12)}… ≠ 期望 ${desired.build_id[component].slice(0, 12)}…`);
  }
  if (actual.source_input_fingerprint !== wantInputFp) {
    problems.push(
      `${where}：内嵌输入指纹 ${actual.source_input_fingerprint.slice(0, 12)}… ≠ 期望 ${wantInputFp.slice(0, 12)}…（输入清单没对上）`,
    );
  }
  return problems;
}

/**
 * 从**真实产物**读回内嵌身份并逐字段核对（写戳/写绑定前的硬门禁）。
 * 不给到产物、或产物里读不出身份、或任一部件的 release/build/输入指纹对不上 ⇒ `ok:false`（点名原因）。
 * 两个产物目录里读回的身份还必须**互相一致**（server 产物里的 ui 段 === ui 产物里的 ui 段），
 * 这样"server 用 X 批、ui 用 Y 批"的**混合产物**会被拒（不能只凭"戳与源码一致"就接受）。
 */
export function checkArtifactIdentity(
  root: string,
  desired: DesiredIdentity,
  opts: { dirs?: Partial<ArtifactDirs>; requireServer?: boolean; requireUi?: boolean } = {},
): ArtifactIdentityVerdict {
  const dirs = { ...artifactDirs(root), ...opts.dirs };
  const requireServer = opts.requireServer ?? true;
  const requireUi = opts.requireUi ?? true;
  const server = scanArtifactIdentity(dirs.server);
  const ui = scanArtifactIdentity(dirs.ui);
  const problems: string[] = [];
  if (requireServer && server === null) {
    problems.push(`后端产物未采到内嵌构建身份（${path.relative(root, dirs.server) || dirs.server}）：拒绝在未采到实际 bundler 输出时写身份`);
  }
  if (requireUi && ui === null) {
    problems.push(`前端产物未采到内嵌构建身份（${path.relative(root, dirs.ui) || dirs.ui}）：拒绝在未采到实际 bundler 输出时写身份`);
  }
  if (server !== null) {
    problems.push(...diffIdentity(`server 产物（${server.file}）`, server.bundle.server, "server", desired));
    problems.push(...diffIdentity(`server 产物里的 ui 段（${server.file}）`, server.bundle.ui, "ui", desired));
  }
  if (ui !== null) {
    problems.push(...diffIdentity(`ui 产物（${ui.file}）`, ui.bundle.ui, "ui", desired));
    problems.push(...diffIdentity(`ui 产物里的 server 段（${ui.file}）`, ui.bundle.server, "server", desired));
  }
  if (server !== null && ui !== null && server.bundle.ui.release_id !== ui.bundle.ui.release_id) {
    problems.push(
      `混合产物：server 产物内嵌的 ui release ${server.bundle.ui.release_id.slice(0, 12)}… ≠ ui 产物内嵌的 ui release ${ui.bundle.ui.release_id.slice(0, 12)}…（两批产物混装，拒绝）`,
    );
  }
  return { ok: problems.length === 0, problems, server, ui, dirs };
}
