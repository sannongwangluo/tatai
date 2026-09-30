// V09-04 产物-源码绑定共享函数（附录 E.3.3-1：验产物 ⇒ 产物内容哈希 + 同源构建证据）。
// 调用方：`scripts/package-bind.ts`（打包尾写绑定记录）、`scripts/verify-v09-04.ts`（复核）、
// `scripts/lib/buildStamp.ts`（构建尾取指纹写构建戳）。
// 判据只此一处——两处各写一套就会分叉。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
// 安装包文件名带产品版本号（Tatai_<ver>_x64-*）；版本号唯一来源见 src/shared/version.ts
import { APP_VERSION } from "../../src/shared/version";

/** 不参与指纹的目录（产物/私有/版本控制噪音，以及**确定的可再生缓存**）。
 *  2026-09-26（V09-18／附录 E.17，GPT-6 裁定 10）新增 `__pycache__`：Python 字节码缓存是**可再生**
 *  产物（由对应 .py 源机械再生成，删了随时重建），不是源码也不是构建输入——它进出工作树不应改变
 *  源码绑定（判据变更留痕：只收窄到这类确定的生成缓存；真实源码与构建输入的绑定一字未放宽）。
 *  反例（verify-v09-18 ⑥）：删除并重建 `__pycache__` ⇒ 指纹不变；修改真实源码 ⇒ 指纹必变。 */
const SKIP_DIRS = new Set(["node_modules", "target", "dist", ".git", ".工作台", "audit", "__pycache__"]);

/** 源码内容指纹：工作树实际构建输入（相对路径 + 文件字节）的单一 sha256。
 *  绑的是**内容**不是 Git ref——只 commit 不动内容，指纹不变（V09-04 ③b 反例）。 */
export function sourceFingerprint(root: string): { fingerprint: string; file_count: number } {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.isDirectory() && SKIP_DIRS.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else files.push(path.relative(root, abs).split(path.sep).join("/"));
    }
  };
  walk(root);
  files.sort();
  const h = crypto.createHash("sha256");
  for (const rel of files) {
    h.update(rel, "utf8");
    h.update(fs.readFileSync(path.join(root, rel)));
  }
  return { fingerprint: h.digest("hex"), file_count: files.length };
}

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
