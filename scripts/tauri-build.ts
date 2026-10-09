// `pnpm tauri:build` 的包装器（V09-04 防伪：把「构建尾部写戳 + 立刻绑定」变成机制强制，不靠自觉）。
//
// 顺序：
//   ⓪ 开工先清旧戳：构建中途失败就不留戳，「旧戳+被部分覆盖的产物」混合状态在绑定处必然判红。
//   ⓪′ P0/V09-45：**构建前冻结构建输入**（server/ui 两组显式输入集指纹 + 工具链），把冻结值经环境
//      变量传给子构建（`pnpm tauri build` → beforeBuildCommand → `pnpm build` / `pnpm build:server`）。
//      两个子构建据此推**同一份 release_id**；任一处现算与冻结不符即 FAIL，不构建、不出产物。
//   ① 真实构建：pnpm exec tauri build（beforeBuildCommand = pnpm build && pnpm build:server；cargo 出 exe；打 NSIS/MSI）
//      —— 非零退出则整脚本同码退出，**不写戳、不绑定**（失败的构建不产生任何绑定证据）。
//   ② 构建全部完成之后：**先复核冻结输入未漂移**（同一判据），再 writeBuildStamp 取此时的工作树指纹，
//      并把部件身份 + 输入清单关联一并写进戳；同一内容写 dist/ 与 src-tauri/target/release/ 两处戳。
//   ③ 立刻执行 package:bind 同等逻辑（等同 pnpm package:bind）——它会强制校验戳，戳不新鲜或身份对不上就拒绝写 binding.json。
//
// 于是「改源码 → 只跑 package:bind」必然拿不到新鲜戳而拒绝；`pnpm verify:v09-04` 也会因戳与现场不符判红。
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { STAMP_REL, clearBuildStamps, writeBuildStamp, type StampBuildIdentity } from "./lib/buildStamp";
import { outputManifestFingerprint } from "./lib/buildOutputManifest";
import {
  checkArtifactIdentity,
  deriveIdentity,
  freezeInputs,
  frozenEnv,
  identityStampFields,
  reconcileInputs,
} from "./lib/buildIdentity";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Windows 下 pnpm 是 .cmd 垫片，必须经 shell 解析；写成单条命令串避免 Node 24 的 args+shell 弃用告警。 */
const run = (cmd: string, env: NodeJS.ProcessEnv = process.env): number => {
  const r = spawnSync(cmd, { cwd: ROOT, stdio: "inherit", shell: true, env });
  if (r.error) {
    console.error(`[stamp] 无法执行「${cmd}」：${r.error.message}`);
    return 1;
  }
  return r.status ?? 1;
};

console.log("[stamp] ⓪ 清旧构建戳（失败构建不得留下可绑定的戳）");
clearBuildStamps(ROOT);

console.log("[stamp] ⓪′ 冻结构建输入（P0/V09-45：两部件据此推同一份 release_id）");
const frozen = freezeInputs(ROOT);
const derivation = deriveIdentity(ROOT, { inputs: frozen });
console.log(
  `[stamp] release ${derivation.release_id.slice(0, 12)}…（server 输入 ${frozen.server_input_fingerprint.slice(0, 12)}… / ui 输入 ${frozen.ui_input_fingerprint.slice(0, 12)}…；工具链 ${frozen.toolchain.node}/${frozen.toolchain.pnpm}，目标 server ${frozen.toolchain.targets.server} / ui ${frozen.toolchain.targets.ui}，vite ${frozen.toolchain.bundler.vite}）`,
);
const childEnv = { ...process.env, ...frozenEnv(frozen) };

console.log("[stamp] ① pnpm exec tauri build");
const buildCode = run("pnpm exec tauri build", childEnv);
if (buildCode !== 0) {
  console.error(`[stamp] 构建失败（退出码 ${buildCode}）——不写构建戳、不绑定`);
  process.exit(buildCode);
}

console.log("[stamp] ② 复核冻结输入未漂移，再写构建戳（构建全部完成后的工作树指纹）");
// 显式把**本次冻结值**传进来核（不放任 env 缺失时 drift 恒 false）：核的就是传给子构建的同一输入集。
const after = reconcileInputs(ROOT, childEnv);
if (after.drifted) {
  for (const r of after.reasons) console.error(`[stamp] FAIL ${r}`);
  console.error("[stamp] 构建期间输入发生漂移——产物与冻结输入不再对应，拒绝写戳/绑定（不静默放行）");
  process.exit(1);
}

console.log("[stamp] ②′ 从**真实产物**读回内嵌身份并逐字段核对（未采到实际 bundler 输出不得写戳）");
const artifact = checkArtifactIdentity(ROOT, {
  release_id: derivation.release_id,
  build_id: derivation.build_id,
  server_input_fingerprint: derivation.server_input_fingerprint,
  ui_input_fingerprint: derivation.ui_input_fingerprint,
});
if (!artifact.ok) {
  for (const p of artifact.problems) console.error(`[stamp] FAIL ${p}`);
  console.error("[stamp] 产物内嵌身份与本次构建不符/读不出——拒绝写戳（不能只凭推导身份冒充产物已加载该身份）");
  process.exit(1);
}
console.log(
  `[stamp] PASS 产物内嵌身份已核对：server ${artifact.server?.file} / ui ${artifact.ui?.file}` +
    `（release ${derivation.release_id.slice(0, 12)}…；扫 ${artifact.server?.scanned ?? 0}+${artifact.ui?.scanned ?? 0} 个 js）`,
);

const inputFields = identityStampFields(ROOT);
if (inputFields.release_id !== derivation.release_id) {
  console.error(
    `[stamp] FAIL 构建后身份与构建前不一致：${inputFields.release_id.slice(0, 12)}… ≠ ${derivation.release_id.slice(0, 12)}…`,
  );
  process.exit(1);
}
// P0/V09-45 集成复核 1：在**成功构建的尾部**冻结**完整输出清单**（含 exe/NSIS/MSI 与所有 JS/CSS/资源），
// 写进戳；package:bind 之后只拿它与当前盘上输出逐字节对账——不重新扫目录再签字。
const outputFp = outputManifestFingerprint(ROOT);
const fields: StampBuildIdentity = {
  ...inputFields,
  output_manifest_sha256: outputFp.sha256,
  output_file_count: outputFp.file_count,
};
console.log(
  `[stamp] PASS 冻结构建输出清单 ${outputFp.sha256.slice(0, 16)}…（${outputFp.file_count} 项产物，排除戳自身落点）`,
);
const stamp = writeBuildStamp(ROOT, fields);
console.log(`[stamp] 指纹 ${stamp.source_fingerprint.slice(0, 16)}…（${stamp.source_file_count} 文件）@ ${stamp.built_at}`);
console.log(
  `[stamp] 身份 release ${fields.release_id.slice(0, 12)}… / build server ${fields.build_id.server.slice(0, 12)}… ui ${fields.build_id.ui.slice(0, 12)}…`,
);
console.log(`[stamp] 落两处：${STAMP_REL.dist}、${STAMP_REL.release}`);

console.log("[stamp] ③ 立刻绑定（package:bind，强制校验戳）");
const bindCode = run("pnpm package:bind");
if (bindCode !== 0) {
  console.error(`[stamp] 绑定失败（退出码 ${bindCode}）——戳已写，请按上面原因处置后重跑（不要手工改戳）`);
  process.exit(bindCode);
}
console.log("[stamp] tauri:build 完成：产物已与本次构建输入绑定");
