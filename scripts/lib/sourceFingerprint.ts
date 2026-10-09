// V09-04 产物-源码绑定共享函数（附录 E.3.3-1：验产物 ⇒ 产物内容哈希 + 同源构建证据）。
// 调用方：`scripts/package-bind.ts`（打包尾写绑定记录）、`scripts/verify-v09-04.ts`（复核）、
// `scripts/lib/buildStamp.ts`（构建尾取指纹写构建戳）。
// 判据只此一处——两处各写一套就会分叉。
//
// P0/V09-45 说明：本文件的**全树 sourceFingerprint 判据一字未改**（§4.5「保持原用途不变」）——
// 构建**身份**另走显式输入集（`scripts/lib/buildIdentity.ts`），**不得**拿全树指纹冒充身份输入指纹
// （§4.2 硬要求：全树 SKIP_DIRS 不含 `resources`，会把 `src-tauri/resources/server` 的自指产物吃进去）。
// 构建输出清单已抽到 `scripts/lib/buildOutputManifest.ts`（本文件只做再导出，既有导入路径不变）。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export { buildOutputManifest, type ArtifactEntry } from "./buildOutputManifest";

/** 不参与指纹的目录（产物/私有/版本控制噪音，以及**确定的可再生缓存**）。
 *  2026-09-26（V09-18／附录 E.17，GPT-6 裁定 10）新增 `__pycache__`：Python 字节码缓存是**可再生**
 *  产物（由对应 .py 源机械再生成，删了随时重建），不是源码也不是构建输入——它进出工作树不应改变
 *  源码绑定（判据变更留痕：只收窄到这类确定的生成缓存；真实源码与构建输入的绑定一字未放宽）。
 *  反例（verify-v09-18 ⑥）：删除并重建 `__pycache__` ⇒ 指纹不变；修改真实源码 ⇒ 指纹必变。 */
const SKIP_DIRS = new Set(["node_modules", "target", "dist", ".git", ".工作台", "audit", "__pycache__"]);

/** 源码内容指纹：工作树实际构建输入（相对路径 + 文件字节）的单一 sha256。
 *  绑的是**内容**不是 Git ref——只 commit 不动内容，指纹不变（V09-04 ③b 反例）。
 *
 *  P0/V09-45 修正（Codex 对 P0 的纠正 6）：**不通用跟随目录链接**。
 *  旧实现（P0 前）遇到 Windows 目录 junction/symlink 时 `Dirent.isDirectory()` 为 false ⇒ 被当普通文件
 *  readFileSync → EISDIR 直接抛（现场触发：验证工作树根放了 `node_modules` junction，`verify:v09-04` 崩在此）。
 *  最小修正：**只**让名字已在 SKIP_DIRS 里的目录链接按同义跳过（`node_modules` junction 与真
 *  `node_modules` 目录同样不参与指纹）；其余目录链接**明确拒绝**（抛错），不递归跟随——否则可能扫到
 *  仓库外、或沿链接成环无限递归。真目录/真文件的收录规则**一字未变**（全树实际内容规则不缩小）。
 *
 *  工作树 `.git` 是**文件**（`gitdir: …` 指针），主仓 `.git` 是**目录**（在 SKIP_DIRS 里被跳过）：
 *  这一差异使"隔离工作树指纹"与"主仓指纹"本就不同——绑定记录据此如实说明，**不**在部署后手工改戳掩盖。 */
export function sourceFingerprint(root: string): { fingerprint: string; file_count: number } {
  const files: string[] = [];
  const linkTargetIsDir = (abs: string): boolean => {
    try {
      return fs.statSync(abs).isDirectory();
    } catch {
      return false; // 断链：当文件处理（交给读文件那步如实报错），不静默吞掉
    }
  };
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(dir, e.name);
      const rel = path.relative(root, abs).split(path.sep).join("/");
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        walk(abs);
        continue;
      }
      if (e.isSymbolicLink() && linkTargetIsDir(abs)) {
        if (SKIP_DIRS.has(e.name)) continue; // 与真目录同义跳过（现场 node_modules junction）
        throw new Error(
          `sourceFingerprint：拒绝跟随未在跳过集内的目录链接 ${rel}（不通用跟随，避免扫到仓库外或沿链接成环）`,
        );
      }
      files.push(rel);
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
