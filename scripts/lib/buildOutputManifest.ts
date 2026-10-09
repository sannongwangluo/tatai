// V09-04 构建输出清单（原在 `scripts/lib/sourceFingerprint.ts` 内，P0/V09-45 提出来单独成文件：
// 身份要**关联**在这条既有绑定链上，而不是另造第二套产物核验判据——§4.5）。
//
// 清单语义一字不变：dist/、src-tauri/resources/server/、release exe、NSIS、MSI 各自的 sha256+体积（定序），
// 外加 P0 新增的**发布完整性**判据（缺分片即拒绝，见文件尾）。既有调用方
// （`scripts/package-bind.ts`、`scripts/verify-v09-04.ts`）经 `scripts/lib/sourceFingerprint.ts` 的
// 再导出继续工作，判据只有这一处。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
// 安装包文件名带产品版本号（Tatai_<ver>_x64-*）；版本号唯一来源见 src/shared/version.ts
import { APP_VERSION } from "../../src/shared/version";

export interface ArtifactEntry {
  path: string;
  sha256: string;
  bytes: number;
}

/** 构建输出清单：dist/、src-tauri/resources/server/、release exe、NSIS、MSI 各自的 sha256+体积（定序） */
export function buildOutputManifest(root: string): { entries: ArtifactEntry[]; manifest_sha256: string } {
  const entries: ArtifactEntry[] = [];
  const pushFile = (abs: string, rel: string): void => {
    if (!fs.existsSync(abs)) return;
    entries.push({
      path: rel,
      sha256: crypto.createHash("sha256").update(fs.readFileSync(abs)).digest("hex"),
      bytes: fs.statSync(abs).size,
    });
  };
  const pushDir = (absDir: string, relPrefix: string): void => {
    if (!fs.existsSync(absDir)) return;
    const walk = (dir: string, prefix: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const abs = path.join(dir, e.name);
        const rel = `${prefix}/${e.name}`;
        // 子目录要把自己的名字带进相对路径（V09-04 重打时发现：原实现递归时丢了这一级，
        // `dist/assets/x.js` 与 `src-tauri/resources/server/node_modules/**` 全被压成同名前缀，
        // 61 条产物只算出 49 条唯一路径——哈希仍会变（内容变则条目变），但记录读起来是错的、
        // "删一个同名文件再放一个同内容文件"这类变化也盖不住。判据不放宽：路径必须是真实相对路径。）
        if (e.isDirectory()) walk(abs, rel);
        else pushFile(abs, rel);
      }
    };
    walk(absDir, relPrefix);
  };
  pushDir(path.join(root, "dist"), "dist");
  pushDir(path.join(root, "src-tauri", "resources", "server"), "src-tauri/resources/server");
  pushFile(path.join(root, "src-tauri", "target", "release", "tatai.exe"), "src-tauri/target/release/tatai.exe");
  // 两个安装器文件名由产品版本号拼出（此前写死版本号，bump 时漏改就会悄悄漏收产物）
  const nsisName = `Tatai_${APP_VERSION}_x64-setup.exe`;
  const msiName = `Tatai_${APP_VERSION}_x64_en-US.msi`;
  pushFile(
    path.join(root, "src-tauri", "target", "release", "bundle", "nsis", nsisName),
    `src-tauri/target/release/bundle/nsis/${nsisName}`,
  );
  pushFile(
    path.join(root, "src-tauri", "target", "release", "bundle", "msi", msiName),
    `src-tauri/target/release/bundle/msi/${msiName}`,
  );
  entries.sort((a, b) => a.path.localeCompare(b.path));
  const h = crypto.createHash("sha256");
  for (const e of entries) h.update(`${e.path}\n${e.sha256}\n${e.bytes}\n`, "utf8");
  return { entries, manifest_sha256: h.digest("hex") };
}

/** 构建戳自身落点（在 dist 清单内）：冻结输出清单指纹时必须排除，否则"戳含自身哈希"永远算不出一致值。 */
export const STAMP_SELF_PATHS: readonly string[] = ["dist/build-stamp.json"];

export interface OutputManifestFingerprint {
  /** 排除戳自身落点后，**全部产物**（含 exe/NSIS/MSI、所有 JS/CSS/资源分片）的定序内容哈希 */
  sha256: string;
  file_count: number;
  entries: ArtifactEntry[];
  excluded: string[];
}

/**
 * 构建**尾部冻结**的完整输出清单指纹（复用的就是上面同一份 `buildOutputManifest`，不另造一套）。
 * 它把"这批产物到底有哪些字节"钉死：之后 package:bind 只需拿当前盘上输出与它逐字节对账——
 * **不是**绑定此刻重新扫一遍目录再签字（那样"换掉一个同路径的旧分片/旧壳"会被重新采信）。
 * 排除戳自身落点以避免自指；戳内容本身由两处戳一致性与 build_identity 校验负责。
 */
export function outputManifestFingerprint(
  root: string,
  exclude: readonly string[] = STAMP_SELF_PATHS,
): OutputManifestFingerprint {
  const manifest = buildOutputManifest(root);
  const excludedSet = new Set(exclude);
  const entries = manifest.entries.filter((e) => !excludedSet.has(e.path));
  const h = crypto.createHash("sha256");
  for (const e of entries) h.update(`${e.path}\n${e.sha256}\n${e.bytes}\n`, "utf8");
  return { sha256: h.digest("hex"), file_count: entries.length, entries, excluded: [...excludedSet] };
}

// ───────────────────────── P0/V09-45：发布完整性（「缺分片的发布被拒」，§4.7、A0-4） ─────────────────────────
//
// Codex 对 P0 的纠正 8：仅点名五个入口文件的**存在性**不满足 A0。完整性必须覆盖
//   · 真实构建输出的**完整清单**；且
//   · 各入口所**实际引用**的静态/动态 chunk、CSS、资源都在场并与冻结构建清单一致；
//   · 整包（full）另**必须**有 exe / NSIS / MSI；server-only 是**显式作用域**，不得冒充整包。
// 注意：判据由"入口文件内容里解析出的引用"驱动，**不是**"重新扫一遍目录当作完整清单"——所以
// "删掉一个仍被引用的 chunk / UI JS" 会被判出来。也不硬编码"只能有几个分片"。

/** 随包后端的四个入口（相对项目根） */
export const REQUIRED_SERVER_PARTS: readonly string[] = [
  "src-tauri/resources/server/index.js",
  "src-tauri/resources/server/mcp.js",
  "src-tauri/resources/server/write-service.js",
  "src-tauri/resources/server/read-worker.js",
];

/** 前端入口页（相对项目根） */
export const REQUIRED_UI_PARTS: readonly string[] = ["dist/index.html"];

/** 完整安装包另必需的产物（壳 exe + 两个安装器）；server-only 作用域不含这些 */
export function requiredInstallArtifacts(appVersion: string = APP_VERSION): string[] {
  return [
    "src-tauri/target/release/tatai.exe",
    `src-tauri/target/release/bundle/nsis/Tatai_${appVersion}_x64-setup.exe`,
    `src-tauri/target/release/bundle/msi/Tatai_${appVersion}_x64_en-US.msi`,
  ];
}

/** 旧名（server 四入口 + 前端入口页）保留，便于既有导入点不动；完整判定请用 releaseCoverage 的 scope。 */
export const REQUIRED_RELEASE_PARTS: readonly string[] = [...REQUIRED_SERVER_PARTS, ...REQUIRED_UI_PARTS];

/** 发布作用域：`full` = 整包（含 exe/NSIS/MSI）；`server-only` = 显式声明的仅服务端作用域（不冒充整包）。 */
export type ReleaseScope = "full" | "server-only";

export interface ReleaseCoverage {
  ok: boolean;
  scope: ReleaseScope;
  /** 在清单里的必需部件 */
  present: string[];
  /** 清单里缺的必需部件（按必需表原序） */
  missing: string[];
}

/**
 * 缺分片判定：给定构建输出清单与必需部件表，逐项点名缺谁。
 * `scope: "server-only"` 只要求随包后端四入口；`scope: "full"`（默认）另要求前端入口页与 exe/NSIS/MSI。
 */
export function releaseCoverage(
  entries: readonly { path: string }[],
  opts: { scope?: ReleaseScope; required?: readonly string[]; appVersion?: string } = {},
): ReleaseCoverage {
  const scope = opts.scope ?? "full";
  const required =
    opts.required ??
    (scope === "server-only" ? REQUIRED_SERVER_PARTS : [...REQUIRED_RELEASE_PARTS, ...requiredInstallArtifacts(opts.appVersion)]);
  const have = new Set(entries.map((e) => e.path));
  const present = required.filter((p) => have.has(p));
  const missing = required.filter((p) => !have.has(p));
  return { ok: missing.length === 0, scope, present, missing };
}

// ── 引用闭包：入口文件**实际引用**的产物是否都在场、且都在冻结构建清单里 ──

export interface ReferencedOutputs {
  ok: boolean;
  scope: ReleaseScope;
  /** 被解析的入口文件（相对项目根，定序） */
  entries: string[];
  /** 被引用到的产物（相对项目根，定序） */
  referenced: string[];
  /** 被引用但盘上不存在（缺件） */
  missing: string[];
  /** 盘上存在、但不在冻结构建清单里（清单外引用 ⇒ 判 FAIL） */
  not_in_manifest: string[];
  /** 被引用产物的解析错误（读不动等，如实带出） */
  errors: string[];
}

const LOCAL_ASSET_EXT = /\.(?:js|mjs|cjs|css|png|jpe?g|svg|gif|webp|avif|ico|bmp|woff2?|ttf|otf|eot|mp3|mp4|webm|wasm)$/i;
const LOCAL_EXT_ALT = "(?:js|mjs|cjs|css|png|jpe?g|svg|gif|webp|avif|ico|bmp|woff2?|ttf|otf|eot|mp3|mp4|webm|wasm)";
// 只认**真正的模块引用形态**（动态 import / import…from / export…from / 副作用 import），
// **不**把任意"看起来像路径"的字符串当引用——否则会把运行时文件名（server 模块里 `"./x.js"` 这类
// 字面量、错误消息里的路径）误当构建引用（Codex 集成复核 2）。引用还须以 ./ ../ / assets/ 开头并以
// 产物后缀结尾（排除 node: / 裸包名 / 绝对 URL）。按引号类型分别匹配，避免压缩产物里的撇号错位。
const IMPORT_DYNAMIC = new RegExp(`\\bimport\\s*\\(\\s*["']([^"'\\n]*\\.${LOCAL_EXT_ALT})["']\\s*\\)`, "gi");
const IMPORT_FROM = new RegExp(`\\b(?:import|export)\\b[^;\\n]*?\\bfrom\\s*["']([^"'\\n]*\\.${LOCAL_EXT_ALT})["']`, "gi");
const IMPORT_SIDE_EFFECT = new RegExp(`\\bimport\\s+["']([^"'\\n]*\\.${LOCAL_EXT_ALT})["']`, "gi");

/** html 里的本地 src/href（去 http/data/# 等非文件引用） */
function htmlRefs(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/gi)) {
    const v = m[1].trim();
    if (v === "" || /^(?:[a-z]+:)?\/\//i.test(v) || v.startsWith("data:") || v.startsWith("#") || v.startsWith("mailto:")) continue;
    out.push(v);
  }
  return out;
}

/** JS 文本里的本地**模块引用**（动态 import / import…from / export…from / 副作用 import）。
 *  只认模块引用形态 + 路径形态（`./`、`../`、`/` 或 `assets/` 开头）——不把运行时路径字面量误当引用。 */
function jsRefs(js: string): string[] {
  const out: string[] = [];
  for (const re of [IMPORT_DYNAMIC, IMPORT_FROM, IMPORT_SIDE_EFFECT]) {
    for (const m of js.matchAll(re)) out.push(m[1]);
  }
  return out.filter(
    (v) =>
      !/^(?:[a-z]+:)?\/\//i.test(v) &&
      !v.startsWith("data:") &&
      (v.startsWith("./") || v.startsWith("../") || v.startsWith("/") || v.startsWith("assets/")),
  );
}

/** CSS 文本里的 url(...) 与 @import 引用 */
function cssRefs(css: string): string[] {
  const out: string[] = [];
  for (const m of css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) out.push(m[1].trim());
  for (const m of css.matchAll(/@import\s+(?:url\(\s*)?["']([^"']+)["']/gi)) out.push(m[1].trim());
  return out;
}

/** 把一个引用字面量解析成**相对产物根**的目标（返回 null 表示非本地引用）。 */
function resolveRef(spec: string, refFileDir: string, outRoot: string): string | null {
  const clean = spec.split("?")[0].split("#")[0].trim();
  if (clean === "" || clean.startsWith("\0")) return null;
  if (/^(?:[a-z]+:)?\/\//i.test(clean) || clean.startsWith("data:")) return null;
  const abs = clean.startsWith("/")
    ? path.join(outRoot, clean.replace(/^\/+/, ""))
    : clean.startsWith("./") || clean.startsWith("../")
      ? path.resolve(refFileDir, clean)
      : path.join(outRoot, clean.replace(/^\.\//, ""));
  return abs;
}

/**
 * 从入口文件内容解析出**被引用的产物**并递归跟随后续 chunk。
 * ui 作用域解析 `dist/index.html`（及它引到的 js/css）；server 作用域解析随包后端四个入口 js。
 */
export function collectReferencedOutputs(
  root: string,
  opts: { scope?: ReleaseScope; manifestPaths?: Iterable<string>; dirs?: { server?: string; ui?: string } } = {},
): ReferencedOutputs {
  const scope = opts.scope ?? "full";
  const distDir = opts.dirs?.ui ?? path.join(root, "dist");
  const serverDir = opts.dirs?.server ?? path.join(root, "src-tauri", "resources", "server");
  const manifestPaths = opts.manifestPaths === undefined ? null : new Set(opts.manifestPaths);
  const entries: string[] = [];
  const referenced = new Set<string>();
  const missing = new Set<string>();
  const errors: string[] = [];
  const visited = new Set<string>();
  const rel = (abs: string): string => path.relative(root, abs).split(path.sep).join("/");

  // `outRoot`：绝对式/`assets/` 式引用的解析根（ui=distDir、server=serverDir）——跟随哪棵树就用哪棵当根
  const follow = (abs: string, outRoot: string): void => {
    if (visited.has(abs)) return;
    visited.add(abs);
    const relPath = rel(abs);
    referenced.add(relPath);
    if (!fs.existsSync(abs)) {
      missing.add(relPath);
      return;
    }
    let text: string;
    try {
      text = fs.readFileSync(abs, "utf8");
    } catch (e) {
      errors.push(`${relPath}：${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    const dir = path.dirname(abs);
    const specs = abs.endsWith(".html") ? htmlRefs(text) : abs.endsWith(".css") ? cssRefs(text) : jsRefs(text);
    for (const spec of specs) {
      const target = resolveRef(spec, dir, outRoot);
      if (target === null) continue;
      const targetRel = path.relative(root, target).split(path.sep).join("/");
      if (targetRel.startsWith("..")) continue; // 指向仓外：不是本包产物
      if (!LOCAL_ASSET_EXT.test(targetRel)) continue;
      follow(target, outRoot);
    }
  };

  // 解析入口：入口位置与引用解析根都取自 `dirs`（默认即 dist / src-tauri/resources/server）
  if (scope === "full") {
    const htmlAbs = path.join(distDir, "index.html");
    entries.push(rel(htmlAbs));
    follow(htmlAbs, distDir);
  }
  for (const relEntry of REQUIRED_SERVER_PARTS) {
    const abs = path.join(serverDir, path.basename(relEntry));
    entries.push(rel(abs));
    follow(abs, serverDir);
  }

  const referencedSorted = [...referenced].sort();
  const notInManifest =
    manifestPaths === null ? [] : [...new Set([...referencedSorted].filter((p) => fs.existsSync(path.join(root, p)) && !manifestPaths.has(p)))].sort();
  return {
    ok: missing.size === 0 && notInManifest.length === 0 && errors.length === 0,
    scope,
    entries: entries.sort(),
    referenced: referencedSorted,
    missing: [...missing].sort(),
    not_in_manifest: notInManifest,
    errors,
  };
}
