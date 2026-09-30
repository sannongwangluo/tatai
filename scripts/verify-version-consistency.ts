// 产品版本**四源一致性**与「版本号只从一处读」的回归护栏（发布流程用）。
// 用法：pnpm exec tsx scripts/verify-version-consistency.ts
//      （不在 package.json 里登记 npm 别名——那份文件由发布执行者统一维护，本脚本不自作主张改它）
//
// 为什么要它：产品版本号曾在多处各写一份，bump 时容易漏改（安装器文件名 / MCP 握手 / 界面页脚），
// 根因是版本号在仓库里散着写。
// 现在唯一读取点是 `src/shared/version.ts`（读仓库根 `package.json`；构建期内联，产物运行时不读文件），
// 本脚本对账其余三源：`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`，
// 并把「代码里再写死产品版本号」这条回头路钉住（安装器文件名 / MCP 握手 / 界面页脚）。
// 判据不放宽：任一源不一致，或产品版本又被写成字面量 ⇒ FAIL（退出码 1）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { APP_VERSION } from "../src/shared/version";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");

let pass = 0;
const fails: string[] = [];
const ok = (cond: boolean, label: string): void => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (cond) pass += 1;
  else fails.push(label);
};

console.log("[verify] ═══ ① 四个版本源指向同一版 ═══");
const pkg = JSON.parse(read("package.json")) as { version?: string };
ok(typeof pkg.version === "string" && pkg.version !== "", `package.json 有 version 字段（${pkg.version ?? "缺"}）`);
ok(APP_VERSION === pkg.version, `src/shared/version.ts 的 APP_VERSION == package.json（${APP_VERSION}）`);

const tauri = JSON.parse(read("src-tauri/tauri.conf.json")) as { version?: string };
ok(tauri.version === pkg.version, `tauri.conf.json 的 version == package.json（${tauri.version ?? "缺"}）`);

// Cargo.toml 的 [package] 段在同名依赖之前，取第一处顶层 version 即是本包版本
const cargoVersion = /^version\s*=\s*"([^"]+)"/m.exec(read("src-tauri/Cargo.toml"))?.[1];
ok(cargoVersion === pkg.version, `Cargo.toml [package] 的 version == package.json（${cargoVersion ?? "缺"}）`);

const lockEntry = /^name = "tatai"\r?\nversion = "([^"]+)"/m.exec(read("src-tauri/Cargo.lock"))?.[1];
ok(lockEntry === pkg.version, `Cargo.lock 里 tatai 的 version == package.json（${lockEntry ?? "缺"}）`);

console.log("[verify] ═══ ② 产品版本不再写死在代码里（唯一读取点 src/shared/version.ts） ═══");
const mcpServer = read("src/mcp/server.ts");
ok(
  /version:\s*APP_VERSION/.test(mcpServer) && !/version:\s*"\d+\.\d+\.\d+"/.test(mcpServer),
  "MCP 握手版本取自 APP_VERSION（不再写字面量）",
);
const appTsx = read("src/ui/App.tsx");
ok(
  /Tatai v\{APP_VERSION\}/.test(appTsx) && !/Tatai v\d+\.\d+\.\d+/.test(appTsx),
  "界面页脚版本取自 APP_VERSION（不再写字面量）",
);

/** 源码树里还有没有 `Tatai_<数字版本>_` 这类写死的安装器文件名（历史文档与 audit/ 不在扫描面内） */
const SKIP_DIRS = new Set(["node_modules", "__pycache__", "dist", "target", ".工作台"]);
const hits: string[] = [];
const scan = (dir: string): void => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) scan(path.join(dir, e.name));
      continue;
    }
    if (!/\.(ts|tsx)$/.test(e.name)) continue;
    const text = fs.readFileSync(path.join(dir, e.name), "utf8");
    text.split(/\r?\n/).forEach((line, i) => {
      if (/Tatai_\d+\.\d+\.\d+_/.test(line)) hits.push(`${path.relative(ROOT, path.join(dir, e.name)).replace(/\\/g, "/")}:${i + 1}`);
    });
  }
};
for (const rel of ["src", "scripts"]) scan(path.join(ROOT, rel));
ok(hits.length === 0, `src/ 与 scripts/ 里没有写死的 \`Tatai_<版本>_\` 安装器文件名（命中 ${hits.length} 处${hits.length ? `：${hits.join("、")}` : ""}）`);

console.log(`\n[verify] 版本四源一致性：PASS ${pass} / FAIL ${fails.length}`);
if (fails.length > 0) {
  for (const f of fails) console.log(`[verify]   FAIL ${f}`);
  process.exit(1);
}
console.log("[verify] 全部 PASS");
