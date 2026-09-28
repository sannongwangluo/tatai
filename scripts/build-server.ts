// U2：把后端打包成「随包分发」的产物（PLAN.md 三期 U2 / DESIGN.md §8.1）。
// 用法：pnpm build:server（tauri.conf.json 的 beforeBuildCommand 里也调它，见 src-tauri/README.md）
//
// 产出目录 = src-tauri/resources/server/，经 tauri.conf.json 的 bundle.resources
// （{"resources/server": "server"}）落到运行时 <resource_dir>/server/，正是 backend.rs 找的路径。
// 目录内容（四件）：
//   ① index.js  —— 后端入口（vite SSR 打成单文件 ESM，含全部纯 JS 依赖）
//   ② mcp.js    —— MCP stdio 入口（agent 主动拉起的那个进程，DESIGN.md §6.1）
//   ③ node_modules/ —— 只放**原生模块**（.node / .dll / .exe 不能进 bundle）：node-pty 的 PTY 与
//      tree-sitter 系的语法解析器；按显式白名单拷，只拷本平台子集（本卡只出 Windows 包）
//   ④ THIRD-PARTY-NOTICES.txt —— 随包第三方声明（L2 卡补：MIT / Apache-2.0 要求再分发时保留
//      版权与许可声明；载荷里原先一个 licen* 文件都没有，见 docs/LICENSE-AUDIT.md §5.4）。
//      内容按**实际打进包里的依赖树**自动生成，要点 + 指向仓库内审计文档，不塞 1355 行全文。
//   另写 package.json（{"type":"module"}）——产物目录在仓库外没有任何 package.json，
//   不写这一行 Node 会把 index.js 当 CJS 解析，一启动就报 "Cannot use import statement outside a module"。
//
// ═══ node 运行时口径（U2 明确选择，不是静默假设）═══
// 随包产物**依赖系统 PATH 里的 node**（>= 20），不把 node.exe 打进安装包。理由：
//   ① 体积：node.exe 单文件 ~80MB，远超 U3 卡 3–10MB 的体积目标（10 倍级），打进去等于把目标作废；
//   ② 用户画像：本工具的用途就是「看着本机跑 agent / Node 项目」，目标机器上必然有 node；
//   ③ 失败可诊断：backend.rs 打包分支找不到 node 时打印明确报错并照常开窗，不静默假装服务起来了；
//   ④ 留后路：若 U3 判定必须随包，只要把 node.exe 放进 resources/ 并把 backend.rs 打包分支的
//      program 从 "node" 换成 <resource_dir>/node.exe —— 本脚本与路径解析都不用改。
//
// ═══ 为什么用 vite 而不是新引 esbuild/rollup ═══
// 仓库已有 vite（前端构建器，devDependencies）；vite 的 SSR 构建就是「rollup + esbuild 打 node 包」，
// 用它零新依赖（AGENTS.md §2 第 4 条：不引入本仓库没在用的工具链）。
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(REPO_ROOT, "src-tauri", "resources", "server");

/** 目标平台（本卡只出 Windows 包，U3 卡负责安装包；跨平台包另开卡） */
const PLATFORM = `${process.platform}-${process.arch}`;

/**
 * 必须走 node_modules 的原生依赖（不能进 bundle：.node/.dll/.exe 是二进制，
 * 且 node-pty 用 `prebuilds/${platform}-${arch}` 运行时拼路径加载）。
 * 白名单 = 只拷运行时真正需要的文件（原包里的 C 源码 / *.pdb 调试符号 / 测试文件都不拷）。
 */
interface NativeDep {
  name: string;
  /** 相对包根的路径（文件或目录），缺一不可 */
  paths: string[];
  /** 需要一起拷进来的运行时依赖（包名；pnpm 的 store 布局下它们是同级 symlink，
   * 所以一律用 createRequire 从包根解析真实路径，不拼 node_modules/<name> 的路径） */
  nested?: string[];
}

const NATIVE_DEPS: NativeDep[] = [
  {
    name: "node-pty",
    // lib/ = JS 半边；prebuilds/<platform> 里只取运行时用到的（ptx.node/winpty*/conpty*），*.pdb 是调试符号不拷
    paths: ["package.json", "lib", `prebuilds/${PLATFORM}`],
  },
  {
    name: "tree-sitter",
    paths: ["package.json", "index.js", `prebuilds/${PLATFORM}`],
    nested: ["node-gyp-build"],
  },
  {
    name: "tree-sitter-typescript",
    // bindings/node = 加载器（node-gyp-build）；typescript/src + tsx/src 的 node-types.json 供 nodeTypeInfo
    paths: [
      "package.json",
      "bindings/node",
      `prebuilds/${PLATFORM}`,
      "typescript/src/node-types.json",
      "tsx/src/node-types.json",
    ],
    nested: ["node-gyp-build"],
  },
  {
    name: "tree-sitter-python",
    paths: ["package.json", "bindings/node", `prebuilds/${PLATFORM}`],
    nested: ["node-gyp-build"],
  },
];

/** 原生依赖里不拷的文件（调试符号与 C 源码）：pdb 体积是 .node 的 20 倍，拷了纯属浪费 */
const NATIVE_SKIP = /\.pdb$|\.test\.js$|_test\.js$|\.map$|\.cc$/;

const ok = (cond: boolean, label: string) => {
  console.log(`[build-server] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (!cond) process.exitCode = 1;
};

function copyFiltered(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    // .bin/ 是给构建工具用的命令垫片（node-gyp-build 的 npm bin），运行时用不到
    if (entry.name === ".bin" || NATIVE_SKIP.test(entry.name)) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyFiltered(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
    else if (entry.isSymbolicLink()) fs.copyFileSync(fs.realpathSync(from), to);
  }
}

function dirSize(dir: string): number {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) total += dirSize(abs);
    else if (entry.isFile()) total += fs.statSync(abs).size;
  }
  return total;
}

/** 相对 OUT_DIR 的布局清单（人看的一行一文件 + 总字节） */
function manifest(dir: string, prefix = ""): { rel: string; bytes: number }[] {
  const out: { rel: string; bytes: number }[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const abs = path.join(dir, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...manifest(abs, rel));
    else out.push({ rel, bytes: fs.statSync(abs).size });
  }
  return out;
}

// ───────────────────────── 随包第三方声明（L2 卡：MIT / Apache 的"保留声明"义务落点） ─────────────────────────

/** 打进包的第三方组件（一个 npm 包一条） */
interface BundledPackage {
  name: string;
  version: string;
  license: string;
  /** 包内许可原文里的版权行（MIT/ISC 要求随包保留的就是这一句） */
  copyright: string;
  /** 包内许可原文文件名（LICENSE / COPYING / …；没有就空） */
  licenseFile: string;
}

/** 从"包含 package.json 的最近祖先目录"读包身份：pnpm 的 .pnpm/<pkg>@<ver>/node_modules/<name>/ 布局一律适用 */
function packageOfModule(moduleId: string): { name: string; version: string; dir: string } | null {
  let dir = path.dirname(moduleId);
  for (let i = 0; i < 12 && dir.length > REPO_ROOT.length; i++) {
    const pj = path.join(dir, "package.json");
    if (fs.existsSync(pj)) {
      try {
        const meta = JSON.parse(fs.readFileSync(pj, "utf8")) as { name?: string; version?: string };
        if (meta.name) return { name: meta.name, version: meta.version ?? "?", dir };
      } catch {
        return null;
      }
    }
    dir = path.dirname(dir);
  }
  return null;
}

const LICENSE_FILE_NAMES = ["LICENSE", "LICENSE.md", "LICENSE.txt", "LICENCE", "COPYING", "COPYING.md", "LICENSE-MIT"];

function copyrightOf(pkgDir: string): { copyright: string; licenseFile: string } {
  for (const file of LICENSE_FILE_NAMES) {
    const abs = path.join(pkgDir, file);
    if (!fs.existsSync(abs)) continue;
    const lines = fs
      .readFileSync(abs, "utf8")
      .split(/\r?\n/)
      .map((l) => l.replace(/[（(]c[）)]/gi, "(c)").trim())
      .filter((l) => /^copyright\s*(\(c\)|©|\d)/i.test(l) && l.length < 200);
    return { copyright: lines.slice(0, 2).join(" / ") || `（原文见 ${file}，无独立版权行）`, licenseFile: file };
  }
  return { copyright: "（包内无许可原文——处置记录见 docs/LICENSE-AUDIT.md）", licenseFile: "" };
}

/** 扫产物 chunk 的 module 清单，反推"真有代码躺在包里的第三方包"（不按 package.json 抄清单） */
function bundledPackages(built: { modules?: Record<string, unknown> }[]): BundledPackage[] {
  const dirs = new Map<string, string>();
  for (const chunk of built) {
    if (!chunk.modules) continue;
    for (const moduleId of Object.keys(chunk.modules)) {
      if (!/[\\/]node_modules[\\/]/.test(moduleId)) continue;
      const pkg = packageOfModule(moduleId);
      if (pkg) dirs.set(pkg.name, pkg.dir);
    }
  }
  return [...dirs.entries()]
    .map(([name, dir]) => {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as {
        version?: string;
        license?: string | { type?: string };
      };
      const license =
        typeof meta.license === "string" ? meta.license : meta.license?.type ?? "（package.json 无 license 字段）";
      const { copyright, licenseFile } = copyrightOf(dir);
      return { name, version: meta.version ?? "?", license, copyright, licenseFile };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** 随包原生二进制（②节的拷贝白名单）：不内联，但同样随包分发，声明要一并给 */
const NATIVE_NOTICES: { component: string; license: string; copyright: string; where: string }[] = [
  {
    component: "node-pty（PTY 绑定：pty.node / conpty.node / conpty_console_list.node）",
    license: "MIT",
    copyright: "Copyright (c) 2012-2015, Christopher Jeffrey / Copyright (c) 2016, Daniel Imms",
    where: "node-pty/LICENSE 段一、段二",
  },
  {
    component: "Microsoft ConPTY（conpty/conpty.dll、conpty/OpenConsole.exe，经 node-pty 预编译包随包）",
    license: "MIT",
    copyright: "Copyright (c) 2018 - present Microsoft Corporation. All rights reserved.",
    where: "node-pty/LICENSE 段三（node-pty 把微软 ConPTY 的 MIT 声明放在自己的 LICENSE 里）",
  },
  {
    component: "winpty（winpty.dll、winpty-agent.exe，经 node-pty 预编译包随包）",
    license: "MIT",
    copyright: "Copyright (c) 2011-2016 Ryan Prichard",
    where: "node-pty/deps/winpty/LICENSE",
  },
  {
    component: "tree-sitter / tree-sitter-typescript / tree-sitter-python（语法解析原生模块）",
    license: "MIT",
    copyright:
      "Copyright (c) 2014 maxbrunsfeld / Copyright (c) 2016 Max Brunsfeld / Copyright (c) 2017 Max Brunsfeld",
    where: "各包目录内的 LICENSE",
  },
  {
    component: "node-gyp-build（原生模块加载器）",
    license: "MIT",
    copyright: "Copyright (c) 2017 Mathias Buus",
    where: "node-gyp-build/LICENSE",
  },
];

const MIT_TEXT = `MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy of this software
and associated documentation files (the "Software"), to deal in the Software without
restriction, including without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the
Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or
substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING
BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`;

/** 生成随包第三方声明（要点 + 指向仓库内审计文档，不把 1355 行审计全文塞进包） */
function buildThirdPartyNotices(built: { modules?: Record<string, unknown> }[]): string {
  const packages = bundledPackages(built);
  const L: string[] = [];
  const rule = (s = "─") => L.push(s.repeat(72));
  L.push("塔台（Tatai）随包第三方声明");
  L.push("THIRD-PARTY NOTICES");
  L.push("=".repeat(72));
  L.push("");
  L.push("本文件由仓库内 scripts/build-server.ts 在 `pnpm build:server`（`pnpm tauri:build` 会先跑它）");
  L.push("时按**实际打进包里的依赖树**自动生成，随安装包一起分发：一路列清本包里含哪些第三方");
  L.push("组件、各自适用什么许可、声明原文在哪。");
  L.push("");
  L.push(`生成时间：${new Date().toISOString()}`);
  L.push("");
  L.push("为什么有这个文件：MIT / Apache-2.0 等许可要求**再分发时保留版权与许可声明**。此前安装包");
  L.push("载荷里一个 licen*/notice 文件都没有（口径缺口见仓库内 docs/LICENSE-AUDIT.md §5.4）。");
  L.push("");
  L.push("完整审计在哪：**仓库内 docs/LICENSE-AUDIT.md** —— npm 实际安装面 409 个包 + Rust Cargo.lock");
  L.push("全量 430 个 crate 逐个打开许可原文核对，含原文路径与关键句摘录。");
  L.push("塔台自身许可：GNU AGPL-3.0（仓库根 LICENSE）。");
  L.push("");
  rule();
  L.push(`一、内联进 server/index.js 与 server/mcp.js 的 npm 包（共 ${packages.length} 个）`);
  rule();
  L.push("");
  L.push("口径：vite SSR 构建把除 Node 内置模块与下节原生模块以外的全部依赖内联成单文件，以下包的");
  L.push("代码原样躺在包内 server/index.js、server/mcp.js 里。");
  L.push("");
  for (const p of packages) {
    L.push(`· ${p.name}@${p.version} — ${p.license}`);
    L.push(`  版权声明：${p.copyright}`);
    L.push(`  原文位置：${p.licenseFile ? `包内 ${p.licenseFile}（node_modules/${p.name}/）` : "包内无原文，见审计文档"}`);
  }
  L.push("");
  rule();
  L.push("二、随包的原生二进制与非内联组件（拷在 server/node_modules/ 下）");
  rule();
  L.push("");
  for (const n of NATIVE_NOTICES) {
    L.push(`· ${n.component}`);
    L.push(`  许可：${n.license}`);
    L.push(`  版权声明：${n.copyright}`);
    L.push(`  原文位置：${n.where}`);
  }
  L.push("");
  rule();
  L.push("三、许可全文");
  rule();
  L.push("");
  L.push("下面这份 MIT 全文适用于第一、二两节里标注 MIT 的全部组件（各自的版权行见上）。");
  L.push("");
  L.push(MIT_TEXT);
  L.push("");
  L.push("其余许可族（ISC / Apache-2.0 / BSD-2-Clause / BSD-3-Clause / MPL-2.0 / Unicode-3.0 等）的全文");
  L.push("不在本文件重复：本包涉及的每一个包与 crate 的许可族、原文路径与关键句摘录，逐条列在仓库内");
  L.push("docs/LICENSE-AUDIT.md（附录 A / B / G）。");
  L.push("");
  rule();
  L.push("四、WebView2Loader.dll（Microsoft）");
  rule();
  L.push("");
  L.push("桌面壳的安装目录里含微软的 WebView2Loader.dll（来自 webview2-com-sys crate，由");
  L.push("src-tauri/build.rs 摆进 resources/ 后随包，用于加载 Evergreen 版 WebView2 运行时；WebView2");
  L.push("运行时本体不随包，缺运行时由安装器联网拉微软官方引导器）。");
  L.push("");
  L.push("该 DLL 不在第一节的 npm 清单里，也**不随包附带微软许可条款文本**——再分发依据是微软官方");
  L.push("分发文档：");
  L.push("  https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution");
  L.push("  该文「Files to ship with the app」节原文：");
  L.push('  "The WebView2Loader code needs to be shipped with the app. This can be done by');
  L.push("   statically linking WebView2Loader.lib into the app binaries, or by including the");
  L.push('   WebView2Loader.dll that matches the app\'s architecture."');
  L.push("");
  L.push("WebView2 运行时与 SDK 的许可条款（Microsoft Software License Terms）见微软官方页面：");
  L.push("  https://learn.microsoft.com/en-us/microsoft-edge/webview2/");
  L.push("");
  L.push("本项目的审计把这一项登记为「证据缺口」：目前只有官方文档允许分发的原文 + DLL 自带版权");
  L.push("串，包内没有微软软件许可条款文本（见 docs/LICENSE-AUDIT.md §5.1 / §7.3）。");
  L.push("");
  return L.join("\n");
}

// ───────────────────────── ① 打包后端（vite SSR，单文件 ESM） ─────────────────────────

fs.rmSync(OUT_DIR, { recursive: true, force: true });

const externals = NATIVE_DEPS.map((d) => d.name);
console.log(`[build-server] 打包后端：vite SSR → ${path.relative(REPO_ROOT, OUT_DIR)}（external: ${externals.join(", ")}）`);

const result = await build({
  // 不读仓库根的 vite.config.ts：那份配置挂的是前端插件（react/tailwind），与后端无关
  configFile: false,
  root: REPO_ROOT,
  logLevel: "warn",
  build: {
    ssr: true,
    outDir: OUT_DIR,
    emptyOutDir: false,
    target: "node20",
    minify: false,
    sourcemap: false,
    reportCompressedSize: false,
    rollupOptions: {
      input: {
        index: path.join(REPO_ROOT, "src", "server", "index.ts"),
        mcp: path.join(REPO_ROOT, "src", "mcp", "index.ts"),
        "write-service": path.join(REPO_ROOT, "src", "server", "work", "daemon.ts"),
      },
      external: externals,
      output: { entryFileNames: "[name].js", format: "es" },
    },
  },
  ssr: { noExternal: true, external: externals },
});

const built = (Array.isArray(result) ? result : [result]).flatMap((r) => ("output" in r ? r.output : []));
const chunks = built.filter((c) => c.type === "chunk");
const emitted = chunks.map((c) => path.basename(c.fileName));
console.log(`[build-server] vite 产出 chunk：${emitted.join(", ")}`);
ok(fs.existsSync(path.join(OUT_DIR, "index.js")), "① 后端入口 index.js 产出");
ok(fs.existsSync(path.join(OUT_DIR, "mcp.js")), "① MCP 入口 mcp.js 产出");
ok(fs.existsSync(path.join(OUT_DIR, "write-service.js")), "① 独立写入服务入口 write-service.js 产出（V07-01，MCP 自愈按需拉起的就是它）");

// ───────────────────────── ② 原生依赖按白名单落地 ─────────────────────────

const NM = path.join(OUT_DIR, "node_modules");
for (const dep of NATIVE_DEPS) {
  const pkgRoot = path.join(REPO_ROOT, "node_modules", dep.name);
  if (!fs.existsSync(pkgRoot)) {
    ok(false, `② 原生依赖 ${dep.name} 不在 node_modules（请先 pnpm install）`);
    continue;
  }
  const dest = path.join(NM, dep.name);
  for (const rel of dep.paths) {
    const from = path.join(pkgRoot, rel);
    if (!fs.existsSync(from)) {
      ok(false, `② ${dep.name}/${rel} 不存在（原生依赖不全会到运行时才炸）`);
      continue;
    }
    const to = path.join(dest, rel);
    if (fs.statSync(from).isDirectory()) copyFiltered(from, to);
    else {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
    }
  }
  for (const nested of dep.nested ?? []) {
    // pnpm 的 store 布局里运行时依赖是**同级** symlink（不在 <pkg>/node_modules 下），
    // 所以用 createRequire 从包根解析，再取真实路径；落地到产物 node_modules 根（Node 向上查找自会命中）
    let real: string;
    try {
      const req = createRequire(path.join(pkgRoot, "package.json"));
      real = fs.realpathSync(path.dirname(req.resolve(`${nested}/package.json`)));
    } catch (e) {
      ok(false, `② ${dep.name} 的运行时依赖 ${nested} 解析不到：${(e as Error).message}`);
      continue;
    }
    copyFiltered(real, path.join(NM, nested));
  }
  console.log(`[build-server] 原生依赖落地 node_modules/${dep.name}（${dep.paths.length} 项 + ${dep.nested?.length ?? 0} 嵌套）`);
}
ok(fs.existsSync(path.join(NM, "node-pty", "prebuilds", PLATFORM, "pty.node")), `② node-pty 原生件在位（prebuilds/${PLATFORM}/pty.node）`);
ok(fs.existsSync(path.join(NM, "tree-sitter", "prebuilds", PLATFORM, "tree-sitter.node")), `② tree-sitter 原生件在位（prebuilds/${PLATFORM}/tree-sitter.node）`);

// ───────────────────────── ③ 产物目录的 ESM 标记 + 布局核对 ─────────────────────────

fs.writeFileSync(
  path.join(OUT_DIR, "package.json"),
  JSON.stringify({ name: "tatai-server", private: true, type: "module" }, null, 2) + "\n",
  "utf8",
);
ok(
  JSON.parse(fs.readFileSync(path.join(OUT_DIR, "package.json"), "utf8")).type === "module",
  "③ 产物目录写了 package.json 的 type=module（否则 Node 按 CJS 解析 index.js 直接报错）",
);

// ───────────────────────── ④ 随包第三方声明（MIT / Apache 的"保留声明"义务） ─────────────────────────

const notices = buildThirdPartyNotices(chunks);
const noticesPath = path.join(OUT_DIR, "THIRD-PARTY-NOTICES.txt");
// 带 BOM：这份 txt 会跟安装包落到用户机器上，BOM 保证 Windows 记事本按 UTF-8 打开中文不乱码
fs.writeFileSync(noticesPath, "\ufeff" + notices, "utf8");
const noticesPackages = bundledPackages(chunks);
ok(fs.existsSync(noticesPath), `④ 随包第三方声明写出（内联 npm 包 ${noticesPackages.length} 个逐条列名）`);
ok(
  notices.includes("docs/LICENSE-AUDIT.md") && notices.includes("WebView2Loader.dll"),
  "④ 声明里给出了完整审计入口与 WebView2 条款落点（不是只列包名）",
);
const notMit = noticesPackages.filter((p) => !/MIT|Apache|BSD|ISC|Unlicense|Python-2\.0|MPL|Unicode|Zlib|CC-BY/i.test(p.license));
ok(notMit.length === 0, `④ 内联包的许可字段全部可识别（未识别的：${notMit.map((p) => p.name).join(", ") || "无"}）`);

const files = manifest(OUT_DIR);
const total = dirSize(OUT_DIR);
console.log(`[build-server] 布局核对（${files.length} 个文件，合计 ${(total / 1024 / 1024).toFixed(2)} MB）：`);
for (const f of files) console.log(`[build-server]   ${f.rel}  ${f.bytes} B`);
ok(
  files.some((f) => f.rel === "index.js") &&
    files.some((f) => f.rel === "mcp.js") &&
    files.some((f) => f.rel === "write-service.js"),
  "③ 布局核对：三个入口都在包内根目录（backend.rs 找的 server/index.js、MCP 的 mcp.js、自愈拉起的 write-service.js）",
);
console.log(`\n[build-server] 完成：${process.exitCode === 1 ? "有 FAIL，见上" : "全部 PASS"}`);
