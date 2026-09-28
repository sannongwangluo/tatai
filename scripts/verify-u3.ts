// U3 验证脚本（用 tsx 跑）：安装包产物验证（PLAN.md 三期 U3 / DESIGN.md §11.3、§7.3）。
// 用法：pnpm verify:u3
//
// 覆盖点（对 U3 DoD 逐条）：
//   ① 产出在不在、多大（DoD① 的前置）：NSIS / MSI / release exe 三件，实测字节 + sha256
//   ② 体积组成拆分（DoD②）：主程序 exe / 随包 server 资源（再按原生件、JS 打包产物、语法描述分）/ 图标 /
//      安装器自身开销——**逐个实测**，并对着 3–10MB 目标给出结论
//   ③ 安装包载荷逐条核对（DoD① 的"装进去的是不是这些"）：7z 列出 NSIS 载荷、MSI 载荷解开求和，
//      与磁盘上的源文件一一对账；**含"exe 静态导入的 DLL 必须随包"这条回归护栏**（U3 实测踩过的坑）
//   ④ WebView2 运行时处置（DoD②）：随不随包、没运行时的机器会怎样、引导器行为——全部落在生成态脚本证据上
//   ⑤ 权限口径（DoD④）：谁需要管理员、谁不需要，逐个包给源码级证据
//   ⑥ 路径与残留口径（DoD①④）：README 里的安装路径 vs 安装器实际口径；卸载会不会碰用户数据目录
//   ⑦ 真装记录复述（若有）：`.工作台/verify/u3-install-record.txt` 里的冷启动数值与残留结论
//
// 分工（与 verify:u1 / verify:u2 同口径）：
//   - 本脚本只读产物、读生成态脚本（installer.nsi / main.wxs）、解包对账，**不跑 tauri build、不动本机安装状态**；
//   - 真装 / 真跑 / 冷启动 / 真卸这类动本机状态的证据由人工跑一次：
//     `npx tsx .工作台/verify/u3-install-run.ts`（一次性脚本，gitignore）→ `.工作台/verify/u3-install-record.txt`；
//   - 7-Zip 不在时相关对账如实 SKIP（不假装跑过）。
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
// V09-04：产物-源码绑定判据只此一处（`scripts/lib/sourceFingerprint.ts`）——此处只消费，
// 不另写一套（`package-bind.ts` 与 `verify-v09-04.ts` 用的是同一份）。
import { sourceFingerprint } from "./lib/sourceFingerprint";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TAURI_DIR = path.join(REPO_ROOT, "src-tauri");
const RELEASE_DIR = path.join(TAURI_DIR, "target", "release");
const BUNDLE_NSIS = path.join(RELEASE_DIR, "bundle", "nsis", "Tatai_0.1.0_x64-setup.exe");
const BUNDLE_MSI = path.join(RELEASE_DIR, "bundle", "msi", "Tatai_0.1.0_x64_en-US.msi");
const RELEASE_EXE = path.join(RELEASE_DIR, "tatai.exe");
const RES_SERVER = path.join(TAURI_DIR, "resources", "server");
const RES_LOADER = path.join(TAURI_DIR, "resources", "WebView2Loader.dll");
const NSI = path.join(RELEASE_DIR, "nsis", "x64", "installer.nsi");
const WXS = path.join(RELEASE_DIR, "wix", "x64", "main.wxs");
const DIST_DIR = path.join(REPO_ROOT, "dist");
const ICONS_DIR = path.join(TAURI_DIR, "icons");
const RECORD = path.join(REPO_ROOT, ".工作台", "verify", "u3-install-record.txt");
const SIZE_BUDGET_MAX = 10 * 1024 * 1024;
const SIZE_BUDGET_MIN = 3 * 1024 * 1024;
const WEBVIEW2_RUNTIME_GUID = "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";

const ok = (cond: boolean, label: string) => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (!cond) process.exitCode = 1;
};
const read = (p: string) => fs.readFileSync(p, "utf8");
const bytes = (n: number) => `${n} B`;
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(3)} MB`;
const pct = (part: number, whole: number) => `${((part / whole) * 100).toFixed(1)}%`;
const sha256 = (p: string) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");

/** 递归列出目录：相对路径（/ 分隔）→ 字节数 */
function walk(dir: string, prefix = "", into = new Map<string, number>()): Map<string, number> {
  if (!fs.existsSync(dir)) return into;
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const abs = path.join(dir, e.name);
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) walk(abs, rel, into);
    else if (e.isFile()) into.set(rel, fs.statSync(abs).size);
  }
  return into;
}
const sum = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);

function sevenZip(): string | null {
  for (const p of ["C:\\Program Files\\7-Zip\\7z.exe", "C:\\Program Files (x86)\\7-Zip\\7z.exe", "7z"]) {
    try {
      execFileSync(p, ["i"], { stdio: "ignore" });
      return p;
    } catch {
      /* 试下一个 */
    }
  }
  return null;
}
const SEVEN_ZIP = sevenZip();
/** 7z 列表：条目名（原样，含 $PLUGINSDIR\ 前缀）→ 字节。解不开返回 null */
function listArchive(file: string): Map<string, number> | null {
  if (!SEVEN_ZIP) return null;
  try {
    const out = execFileSync(SEVEN_ZIP, ["l", "-slt", file], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const lines = out.split(/\r?\n/);
    const sep = lines.findIndex((l) => /^-{10,}$/.test(l.trim()));
    const body = sep === -1 ? lines : lines.slice(sep + 1);
    const map = new Map<string, number>();
    let name: string | null = null;
    for (const line of body) {
      if (line.startsWith("Path = ")) name = line.slice(7);
      else if (line.startsWith("Size = ") && name !== null) {
        // 末条偶尔是空的（7z 的 NSIS 解析器不给这个字段）——老老实实记成 NaN，别当 0 用
        const raw = line.slice(7).trim();
        map.set(name, raw === "" ? Number.NaN : Number(raw));
        name = null;
      }
    }
    return map;
  } catch {
    return null;
  }
}
/** 解包到临时目录再求和（MSI 载荷逐条实测，不信任何列表） */
function extractAndSum(file: string): { total: number; files: number } | null {
  if (!SEVEN_ZIP) return null;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "u3-msi-"));
  try {
    execFileSync(SEVEN_ZIP, ["x", "-y", `-o${tmp}`, file], { stdio: "ignore", maxBuffer: 64 * 1024 * 1024 });
    const m = walk(tmp);
    return { total: sum(m), files: m.size };
  } catch {
    return null;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
function ps(script: string): string {
  try {
    return execFileSync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${script}`],
      { encoding: "utf8" },
    ).trim();
  } catch {
    return "";
  }
}

// ───────────────────────── ① 产物在位与实测字节 ─────────────────────────

console.log("① 产物在位与实测字节（ls 口径，不许估算）");
for (const [label, p] of [
  ["NSIS 安装包", BUNDLE_NSIS],
  ["MSI 安装包", BUNDLE_MSI],
  ["壳二进制（tauri build 产出）", RELEASE_EXE],
] as const) {
  const exists = fs.existsSync(p);
  ok(exists, `${label} 在位：${path.relative(REPO_ROOT, p)}`);
  if (!exists) continue;
  const size = fs.statSync(p).size;
  console.log(`        ${label}：${bytes(size)}（${mb(size)}）｜sha256 ${sha256(p)}`);
}
if (!fs.existsSync(BUNDLE_NSIS) || !fs.existsSync(BUNDLE_MSI)) {
  console.log("\n[verify] 安装包不在：先跑 `pnpm tauri:build`（本脚本不替你构建）");
  console.log(`[verify] 完成：有 FAIL，见上`);
  process.exit(1);
}

// ───────────────────────── ①′ 产物-源码绑定（V09-04 卡面：verify-u3 补产物-源码绑定断言） ─────────────────────────

console.log("\n①′ 产物-源码绑定：这几件包是**当前源码内容**打的（附录 E.3.3-1：绑内容，不拿 Git HEAD 冒充）");
const BINDING_FILE = process.env.V0904_BIND_OUT
  ? path.join(process.env.V0904_BIND_OUT, "binding.json")
  : path.join(REPO_ROOT, ".工作台", "evidence", "V09-04", "1", "binding.json");
const BOUND_ARTIFACTS: [string, string][] = [
  ["壳二进制", "src-tauri/target/release/tatai.exe"],
  ["NSIS 安装包", "src-tauri/target/release/bundle/nsis/Tatai_0.1.0_x64-setup.exe"],
  ["MSI 安装包", "src-tauri/target/release/bundle/msi/Tatai_0.1.0_x64_en-US.msi"],
];
if (!fs.existsSync(BINDING_FILE)) {
  // 判据不放宽：包存在 + 载荷对得上 ≠ 包是"当前源码"打的——缺绑定记录就是不可判定，如实红。
  ok(false, `①′ 产物-源码绑定记录不在（${path.relative(REPO_ROOT, BINDING_FILE)}）——构建尾部要先跑 \`pnpm package:bind\``);
} else {
  const binding = JSON.parse(read(BINDING_FILE)) as {
    bound_at: string;
    source_fingerprint: string;
    source_file_count: number;
    manifest_sha256: string;
    artifacts: { path: string; sha256: string; bytes: number }[];
  };
  const fp = sourceFingerprint(REPO_ROOT);
  ok(
    fp.fingerprint === binding.source_fingerprint && fp.file_count === binding.source_file_count,
    `①′ 绑定记录的源码内容指纹 == 当前工作树实测（${fp.fingerprint.slice(0, 16)}… / ${fp.file_count} 文件，bound_at=${binding.bound_at}）`,
  );
  for (const [label, rel] of BOUND_ARTIFACTS) {
    const abs = path.join(REPO_ROOT, rel);
    const rec = binding.artifacts.find((a) => a.path === rel);
    const size = fs.existsSync(abs) ? fs.statSync(abs).size : 0;
    const hash = fs.existsSync(abs) ? sha256(abs) : "";
    ok(
      rec !== undefined && rec.sha256 === hash && rec.bytes === size,
      `①′ ${label} 与绑定记录逐项相符（${mb(size)}，sha256 ${hash.slice(0, 12)}…）——包被换过此处必红`,
    );
  }
}

// ───────────────────────── ② 体积组成拆分（DoD② 三件套之一） ─────────────────────────

console.log("\n② 体积组成拆分（磁盘实测）：两个包装出来的是同一批文件，分开算");
const server = walk(RES_SERVER);
const dist = walk(DIST_DIR);
const icons = walk(ICONS_DIR);
const serverTotal = sum(server);
const distTotal = sum(dist);
const iconsTotal = sum(icons);
const exeSize = fs.statSync(RELEASE_EXE).size;

// 随包 server 资源内部再分四类：原生件 / JS 打包产物 / 语法描述 JSON / 其余（加载器与包元数据）
const NATIVE = /\.(node|dll|exe)$/i;
const SYNTAX = /node-types\.json$/i;
const BUNDLED = /^(index\.js|mcp\.js|assets\/.*\.js)$/;
const groups = { 原生二进制: 0, JS打包产物: 0, 语法描述JSON: 0, 其余: 0 };
for (const [rel, size] of server) {
  if (NATIVE.test(rel)) groups.原生二进制 += size;
  else if (SYNTAX.test(rel)) groups.语法描述JSON += size;
  else if (BUNDLED.test(rel)) groups.JS打包产物 += size;
  else groups.其余 += size;
}
console.log(`        主程序壳 tatai.exe（Rust 壳 + 内嵌前端 dist + 图标资源）：${bytes(exeSize)}（${mb(exeSize)}）`);
console.log(`        随包 server/ 资源：${server.size} 个文件 / ${bytes(serverTotal)}（${mb(serverTotal)}）——装到 <安装目录>\\server\\`);
for (const [k, v] of Object.entries(groups)) console.log(`          · ${k}：${bytes(v)}（占 server/ 的 ${pct(v, serverTotal)}）`);
console.log(`        前端 dist（原始 ${bytes(distTotal)}，由 Tauri 以 brotli 内嵌进上面那个 exe，不单独落盘）：${dist.size} 个文件`);
for (const [rel, size] of dist) console.log(`          · ${rel}：${bytes(size)}`);
console.log(`        图标源文件（icons/，进 exe 资源的那几个）：${icons.size} 个文件 / ${bytes(iconsTotal)}`);
ok(
  sum(new Map(Object.entries(groups))) === serverTotal,
  `② server/ 四个分类求和 == 实测总数（${bytes(serverTotal)}）——拆分不漏不重`,
);
ok(server.size > 0 && fs.existsSync(path.join(RES_SERVER, "index.js")) && fs.existsSync(path.join(RES_SERVER, "mcp.js")), "② 随包 server/ 有内容且两个入口在位（空目录会让拆分数字失去意义）");
ok(fs.existsSync(path.join(DIST_DIR, "index.html")), "② 前端 dist 产物在位（它会被 Tauri 内嵌进 exe，不单独落盘）");

// 安装器自身开销：NSIS 载荷里除 exe 与 server/ 之外的条目
const nsisPayload = listArchive(BUNDLE_NSIS);
const nsisTotal = fs.statSync(BUNDLE_NSIS).size;
// 7z 的 NSIS 解析器偶尔不给末条的 Size 字段（实测：server/package.json）——记成 NaN，求和时跳过并如实说明
const nsisUnknown = nsisPayload ? [...nsisPayload].filter(([, s]) => Number.isNaN(s)).map(([n]) => n) : [];
const nsisEntryBytes = (name: string) => {
  const v = nsisPayload?.get(name);
  return v === undefined || Number.isNaN(v) ? 0 : v;
};
let nsisStubAndPlugins = 0;
let nsisPayloadTotal = 0;
if (nsisPayload) {
  nsisStubAndPlugins = [...nsisPayload].filter(([n]) => n.startsWith("$PLUGINSDIR")).reduce((a, [, s]) => a + (Number.isNaN(s) ? 0 : s), 0);
  nsisPayloadTotal = [...nsisPayload].reduce((a, [, s]) => a + (Number.isNaN(s) ? 0 : s), 0);
}
console.log(
  `        NSIS 安装包 ${bytes(nsisTotal)}（${mb(nsisTotal)}）：解压后载荷 ${nsisPayload ? `${bytes(nsisPayloadTotal)}（${nsisPayload.size} 条目${nsisUnknown.length ? `，其中 ${nsisUnknown.length} 条 7z 未给大小：${nsisUnknown.join("、")}` : ""}）` : "（7z 缺，未解）"}`,
);
if (nsisPayload) {
  const payloadServer = [...nsisPayload].filter(([n]) => n.startsWith("server\\")).reduce((a, [, s]) => a + (Number.isNaN(s) ? 0 : s), 0);
  console.log(
    `          载荷 = tatai.exe ${bytes(nsisEntryBytes("tatai.exe"))} + server/ ${bytes(payloadServer)} + WebView2Loader.dll ${bytes(nsisEntryBytes("WebView2Loader.dll"))} + NSIS 插件与向导图 ${bytes(nsisStubAndPlugins)}`,
  );
}
const msiPayload = extractAndSum(BUNDLE_MSI);
console.log(`        MSI 安装包 ${bytes(fs.statSync(BUNDLE_MSI).size)}（${mb(fs.statSync(BUNDLE_MSI).size)}）：解包后载荷 ${msiPayload ? `${bytes(msiPayload.total)} / ${msiPayload.files} 个文件` : "（7z 缺，未解）"}`);

// 体积目标结论：以**安装包**为准（NSIS 是主推通道）
const nsisSize = nsisTotal;
console.log(`        体积目标 3–10MB（PLAN.md U3 DoD②）对着 **安装包本体** 判：NSIS ${mb(nsisSize)} / MSI ${mb(fs.statSync(BUNDLE_MSI).size)}`);
ok(nsisSize <= SIZE_BUDGET_MAX, `② NSIS 安装包 ${mb(nsisSize)} ≤ 上限 10MB`);
ok(
  fs.statSync(BUNDLE_MSI).size <= SIZE_BUDGET_MAX,
  `② MSI 安装包 ${mb(fs.statSync(BUNDLE_MSI).size)} ≤ 上限 10MB`,
);
console.log(
  `        是否落在 3–10MB 级：${nsisSize >= SIZE_BUDGET_MIN ? "是（≥3MB，两个包都在 3–10MB 级）" : `NSIS 低于 3MB 下沿（${mb(nsisSize)}）——这是"更小"，不是超标；上限才是红线，下沿只是量级参照`}`,
);

// ───────────────────────── ③ 载荷逐条核对（装进去的到底是不是这些） ─────────────────────────

console.log("\n③ 安装包载荷逐条核对（7z 解包对账）");
const loaderOnDisk = fs.existsSync(RES_LOADER) ? fs.statSync(RES_LOADER).size : 0;
ok(loaderOnDisk > 0, `③ 随包资源里有 WebView2Loader.dll（${bytes(loaderOnDisk)}）——壳静态导入它，缺了就起不来`);
const exeImportsLoader = fs.readFileSync(RELEASE_EXE).includes(Buffer.from("WebView2Loader.dll"));
ok(exeImportsLoader, "③ 壳二进制确实静态导入 WebView2Loader.dll（源码级印证：它是运行期硬依赖，不是可选件）");
if (nsisPayload) {
  const asNsis = (rel: string) => `server\\${rel.replace(/\//g, "\\")}`;
  const missing = [...server.keys()].filter((rel) => !nsisPayload.has(asNsis(rel)));
  ok(missing.length === 0, `③ NSIS 载荷把 server/ 的 ${server.size} 个文件全带上了（缺 ${missing.length} 个：${missing.slice(0, 5).join("、") || "无"}）`);
  const mismatched = [...server].filter(([rel, size]) => {
    const got = nsisPayload.get(asNsis(rel));
    return got !== undefined && !Number.isNaN(got) && got !== size;
  });
  ok(
    mismatched.length === 0,
    `③ NSIS 载荷里 server/ 每个文件字节数与源一致（不符 ${mismatched.length} 个：${mismatched.map(([r]) => r).join("、") || "无"}；` +
      `${nsisUnknown.length} 条 7z 没给大小已按"未测"处理：${nsisUnknown.map((n) => n.replace(/^server\\/, "")).join("、") || "无"}）`,
  );
  ok(nsisPayload.get("tatai.exe") === exeSize, `③ NSIS 载荷里的 tatai.exe ${bytes(nsisPayload.get("tatai.exe") ?? 0)} == release 产出 ${bytes(exeSize)}`);
  ok(
    (nsisPayload.get("WebView2Loader.dll") ?? 0) > 0,
    "③ NSIS 载荷里有 WebView2Loader.dll（U3 实测踩过的坑：tauri 的 NSIS 打包器在 target 不以 -gnu 结尾时会漏掉它，" +
      "装出来的 exe 直接 STATUS_DLL_NOT_FOUND；现由 bundle.resources 兜住）",
  );
  const webviewArtifacts = [...nsisPayload.keys()].filter((n) => /MicrosoftEdgeWebview2Setup|MicrosoftEdgeWebView2RuntimeInstaller/i.test(n));
  ok(webviewArtifacts.length === 0, `③ NSIS 载荷里没有 WebView2 运行时/引导器（随包分发的只有我们自己的文件）：${webviewArtifacts.join("、") || "无"}`);
  const dataLeaks = [...nsisPayload.keys()].filter((n) => /(^|[\\/])(registry\.json|agents\.json|progress\.json|logs[\\/])/.test(n));
  ok(dataLeaks.length === 0, `③ NSIS 载荷里没有用户数据文件（注册表/进度/日志一个都不进安装包）：${dataLeaks.join("、") || "无"}`);
} else {
  console.log("[verify] SKIP ③ NSIS 载荷逐条核对：没找到 7-Zip（装一个或用 `7z l` 人工核对）");
}
if (msiPayload) {
  const expected = exeSize + loaderOnDisk + serverTotal;
  ok(
    msiPayload.total === expected,
    `③ MSI 载荷 ${bytes(msiPayload.total)} == exe ${bytes(exeSize)} + WebView2Loader.dll ${bytes(loaderOnDisk)} + server/ ${bytes(serverTotal)}`,
  );
} else {
  console.log("[verify] SKIP ③ MSI 载荷求和：没找到 7-Zip");
}

// ───────────────────────── ④ WebView2 运行时处置（DoD② 逐条） ─────────────────────────

console.log("\n④ WebView2 运行时怎么处置（DoD②：随不随包、没运行时的机器会怎样）");
const tauriConf = JSON.parse(read(path.join(TAURI_DIR, "tauri.conf.json"))) as {
  bundle: { windows?: { webviewInstallMode?: unknown; nsis?: { installMode?: string } } };
};
ok(
  tauriConf.bundle.windows?.webviewInstallMode === undefined,
  "④ tauri.conf.json 没设 webviewInstallMode → 走 Tauri 缺省 downloadBootstrapper（不随包，装的时候按需下载）",
);
const nsi = read(NSI);
ok(/!define INSTALLWEBVIEW2MODE "downloadBootstrapper"/.test(nsi), "④ 生成态 NSIS 脚本：INSTALLWEBVIEW2MODE = downloadBootstrapper");
ok(/!define WEBVIEW2INSTALLERPATH ""/.test(nsi) && /!define WEBVIEW2BOOTSTRAPPERPATH ""/.test(nsi), "④ 生成态 NSIS 脚本：离线安装器与引导器路径都为空 → 安装包内没有 WebView2 安装器文件");
ok(
  nsi.includes("https://go.microsoft.com/fwlink/p/?LinkId=2124703"),
  "④ 缺运行时的机器上，NSIS 安装器去微软官方短链下引导器（联网下载，不是随包）",
);
ok(
  /ReadRegStr \$4 HKLM "SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients/.test(nsi),
  "④ NSIS 安装器先查注册表判断运行时在不在（在就跳过整段，不重复下载/安装）",
);
const wxs = read(WXS);
ok(
  /DownloadAndInvokeBootstrapper/.test(wxs) && wxs.includes("https://go.microsoft.com/fwlink/p/?LinkId=2124703"),
  "④ MSI 侧同口径：缺运行时由 DownloadAndInvokeBootstrapper 自定义动作联网拉同一个引导器",
);
const wv2Version = ps(`-join (Get-ItemProperty 'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\${WEBVIEW2_RUNTIME_GUID}' -EA SilentlyContinue).pv`);
console.log(`        本机 WebView2 运行时（系统级，HKLM）：${wv2Version || "（读不到）"}——所以本机的"真装"走的是"已装即跳过"分支，`);
console.log(`        下载分支只能靠上面生成态脚本证据 + 官方短链，没法在本机实测（如实声明，不假装跑过）`);

// ───────────────────────── ⑤ 权限口径（DoD④） ─────────────────────────

console.log("\n⑤ 权限口径：谁要管理员、谁不要（DoD④）");
ok(/!define INSTALLMODE "currentUser"/.test(nsi), `⑤ NSIS 安装模式 = currentUser（${(nsi.match(/!define INSTALLMODE "(\w+)"/) ?? [])[1]}）`);
ok(/RequestExecutionLevel user/.test(nsi), "⑤ NSIS 安装器 RequestExecutionLevel = user（不写管理员清单，装的时候不弹 UAC）");
ok(
  /!else if "\$\{INSTALLMODE\}" == "currentUser"[\s\S]{0,200}StrCpy \$INSTDIR "\$LOCALAPPDATA\\\$\{PRODUCTNAME\}"/.test(nsi),
  "⑤ NSIS 缺省安装目录 = $LOCALAPPDATA\\Tatai（用户级目录，不是 Program Files）",
);
ok(/DeleteRegKey HKCU "\$\{UNINSTKEY\}"/.test(nsi), "⑤ NSIS 卸载时删的是 HKCU 卸载项（用户级登记，不动 HKLM）");
const exeManifest = /requestedExecutionLevel level="([a-zA-Z]+)"/.exec(fs.readFileSync(RELEASE_EXE).toString("latin1"));
ok(
  exeManifest?.[1] === "asInvoker",
  `⑤ 壳自身清单 requestedExecutionLevel = ${exeManifest?.[1] ?? "（读不到）"}（asInvoker：跑起来不提权）`,
);
ok(
  /InstallScope="perMachine"/.test(wxs),
  "⑤ MSI 是 perMachine（Tauri 的 wix 模板缺省，装到 Program Files，需要管理员）——DoD④ 的落点在 NSIS 通道；" +
    "要用户级 MSI 得改 wix 模板，属计划外，已登记 PROGRESS 待指令",
);

// ───────────────────────── ⑥ 路径与残留口径 ─────────────────────────

console.log("\n⑥ 路径与残留口径（DoD①④：路径对不对、卸载碰不碰用户数据）");
const readmeRoot = read(path.join(REPO_ROOT, "README.md"));
const readmeTauri = read(path.join(TAURI_DIR, "README.md"));
const mcpPathClaim = "%LOCALAPPDATA%\\Tatai\\server\\mcp.js";
// README 里的 JSON 片段是转义写法（`\\Tatai`），比对前先把双反斜杠压成单反斜杠
const hasClaim = (text: string) => text.replace(/\\\\/g, "\\").includes(mcpPathClaim);
ok(hasClaim(readmeRoot), `⑥ 根 README 写的 MCP 入口路径 == ${mcpPathClaim}`);
ok(hasClaim(readmeTauri), `⑥ src-tauri/README.md 写的 MCP 入口路径 == ${mcpPathClaim}`);
ok(
  /StrCpy \$INSTDIR "\$LOCALAPPDATA\\\$\{PRODUCTNAME\}"/.test(nsi) && /!define PRODUCTNAME "Tatai"/.test(nsi),
  "⑥ 安装器实际口径 %LOCALAPPDATA%\\Tatai == README 里那句（真装记录见 .工作台/verify/u3-install-record.txt）",
);
const uninstallSection = nsi.slice(nsi.indexOf("Section Uninstall"));
ok(
  !/\.tatai|TATAI_HOME/i.test(uninstallSection),
  "⑥ 卸载段一个字都不碰全局数据目录（~/.tatai 或 TATAI_HOME）：用户数据保留是设计口径，删了才是 bug",
);
ok(
  /\$\{If\} \$DeleteAppDataCheckboxState = 1[\s\S]{0,600}RmDir \/r "\$LOCALAPPDATA\\\$\{BUNDLEID\}"/.test(nsi),
  "⑥ 卸载段唯一会删的用户目录是 WebView2 自己的缓存（$LOCALAPPDATA\\com.sannongwangluo.tatai，只有勾了\"删除应用数据\"才删）",
);

// ───────────────────────── ⑦ 真装记录复述（有则复述，无则如实 SKIP） ─────────────────────────

console.log("\n⑦ 真装 / 冷启动 / 真卸记录（人工跑一次，本脚本只复述）");
if (!fs.existsSync(RECORD)) {
  console.log(
    "[verify] SKIP ⑦ 没有真装记录：跑 `npx tsx .工作台/verify/u3-install-run.ts`（静默装 → 冷启动 3 次 → 静默卸 → 残留比对）",
  );
} else {
  const rec = read(RECORD);
  const runs = [...rec.matchAll(/第 (\d) 次（进程冷启动）：\/health 200 @ (\d+|null) ms｜窗口可交互 @ (\d+|null) ms｜界面见「塔台」@ (\d+|null) ms/g)];
  ok(runs.length >= 3, `⑦ 真装记录里有 ${runs.length} 次冷启动实测（要求 ≥3）`);
  for (const r of runs) {
    console.log(`        第 ${r[1]} 次：/health 200 @ ${r[2]} ms｜窗口可交互 @ ${r[3]} ms｜界面见项目 @ ${r[4]} ms`);
  }
  ok(
    runs.length > 0 && runs.every((r) => r[2] !== "null" && r[3] !== "null"),
    "⑦ 每次冷启动都真拿到了 /health 200 与窗口可交互（null = 那次没起来）",
  );
  const leftovers = /卸载后安装目录 .*：存在？(false|true)｜残留 (\d+) 文件/.exec(rec);
  ok(leftovers?.[1] === "false" || leftovers?.[2] === "0", `⑦ 卸载后安装目录清干净（${leftovers ? `残留 ${leftovers[2]} 文件` : "记录里没找到该行"}）`);
  const dataKept = /全局数据目录（用户数据，.*）：安装前 (\d+) 文件 → 卸载后 (\d+) 文件/.exec(rec);
  ok(
    Boolean(dataKept) && Number(dataKept![2]) >= Number(dataKept![1]),
    `⑦ 卸载后全局数据目录保留（安装前 ${dataKept?.[1] ?? "?"} → 卸载后 ${dataKept?.[2] ?? "?"} 个文件）`,
  );
}

console.log(
  "\n[verify] 手动那半边（GUI 与装/卸，本脚本不跑）：`npx tsx .工作台/verify/u3-install-run.ts`" +
    " → 静默装 NSIS → 以实际安装路径真跑（冷启动计时）→ 静默卸 → 残留比对；原始记录落 .工作台/verify/u3-install-record.txt。",
);
console.log(`\n[verify] 完成：${process.exitCode === 1 ? "有 FAIL，见上" : "全部 PASS"}`);
