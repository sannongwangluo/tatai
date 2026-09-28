// `pnpm tauri:build` 的包装器（V09-04 防伪：把「构建尾部写戳 + 立刻绑定」变成机制强制，不靠自觉）。
//
// 顺序：
//   ⓪ 开工先清旧戳：构建中途失败就不留戳，「旧戳+被部分覆盖的产物」混合状态在绑定处必然判红。
//   ① 真实构建：pnpm exec tauri build（beforeBuildCommand = pnpm build && pnpm build:server；cargo 出 exe；打 NSIS/MSI）
//      —— 非零退出则整脚本同码退出，**不写戳、不绑定**（失败的构建不产生任何绑定证据）。
//   ② 构建全部完成之后：writeBuildStamp 取此时的工作树指纹，同一内容写 dist/ 与 src-tauri/target/release/ 两处戳。
//   ③ 立刻执行 package:bind 同等逻辑（等同 pnpm package:bind）——它会强制校验戳，戳不新鲜就拒绝写 binding.json。
//
// 于是「改源码 → 只跑 package:bind」必然拿不到新鲜戳而拒绝；`pnpm verify:v09-04` 也会因戳与现场不符判红。
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { STAMP_REL, clearBuildStamps, writeBuildStamp } from "./lib/buildStamp";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Windows 下 pnpm 是 .cmd 垫片，必须经 shell 解析；写成单条命令串避免 Node 24 的 args+shell 弃用告警。 */
const run = (cmd: string): number => {
  const r = spawnSync(cmd, { cwd: ROOT, stdio: "inherit", shell: true });
  if (r.error) {
    console.error(`[stamp] 无法执行「${cmd}」：${r.error.message}`);
    return 1;
  }
  return r.status ?? 1;
};

console.log("[stamp] ⓪ 清旧构建戳（失败构建不得留下可绑定的戳）");
clearBuildStamps(ROOT);

console.log("[stamp] ① pnpm exec tauri build");
const buildCode = run("pnpm exec tauri build");
if (buildCode !== 0) {
  console.error(`[stamp] 构建失败（退出码 ${buildCode}）——不写构建戳、不绑定`);
  process.exit(buildCode);
}

console.log("[stamp] ② 写构建戳（构建全部完成后的工作树指纹）");
const stamp = writeBuildStamp(ROOT);
console.log(`[stamp] 指纹 ${stamp.source_fingerprint.slice(0, 16)}…（${stamp.source_file_count} 文件）@ ${stamp.built_at}`);
console.log(`[stamp] 落两处：${STAMP_REL.dist}、${STAMP_REL.release}`);

console.log("[stamp] ③ 立刻绑定（package:bind，强制校验戳）");
const bindCode = run("pnpm package:bind");
if (bindCode !== 0) {
  console.error(`[stamp] 绑定失败（退出码 ${bindCode}）——戳已写，请按上面原因处置后重跑（不要手工改戳）`);
  process.exit(bindCode);
}
console.log("[stamp] tauri:build 完成：产物已与本次构建输入绑定");
