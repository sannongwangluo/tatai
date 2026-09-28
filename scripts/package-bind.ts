// V09-04 打包尾部的绑定步骤（PLAN.md V09-04 ②③／附录 E.3.3-1）：
// 构建完成后立刻写「产物 ↔ 源码」绑定记录——源码内容指纹（工作树实测，含未提交变更）＋
// 构建输出清单哈希（dist/**、resources/server/**、release exe、NSIS、MSI 各自 sha256 与体积）。
//
// 写盘**之前**强制校验构建戳（scripts/lib/buildStamp.ts）：两处戳在场且一致、且戳指纹等于当前实测指纹。
// 任一条不满足就打印 FAIL 原因并 exit 1，**不写 binding.json**——于是「不跑构建、只重跑 package:bind，
// 把旧安装包和当前源码指纹重新写上」这条刷绿路被堵死。正常路径只有一条：pnpm tauri:build
// （scripts/tauri-build.ts 在构建尾部写戳并立刻调本脚本）。
// 用法：pnpm package:bind（必须在同一次构建的尾巴上跑；verify:v09-04 复核它）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateBuildStamps, STAMP_REL } from "./lib/buildStamp";
import { buildOutputManifest, sourceFingerprint } from "./lib/sourceFingerprint";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.V0904_BIND_OUT ?? path.join(ROOT, ".工作台", "evidence", "V09-04", "1");

// ① 写盘前拦截：戳不新鲜就不产生绑定证据（判据与 verify:v09-04 共用，见 lib/buildStamp.ts）
const verdict = evaluateBuildStamps(ROOT);
if (!verdict.ok) {
  console.error("[bind] FAIL 拒绝写 binding.json——构建戳校验未通过：");
  for (const r of verdict.reasons) console.error(`[bind]   FAIL ${r}`);
  console.error("[bind] 正确做法：重跑 pnpm tauri:build（构建尾部自动写戳并绑定）；不要手工补戳或改戳");
  process.exit(1);
}
console.log(`[bind] PASS 构建戳在场且一致（dist/ 与 release/ 同内容，built_at=${verdict.dist!.built_at}）`);
console.log(`[bind] PASS 戳指纹 === 当前实测（${verdict.current.fingerprint.slice(0, 16)}… / ${verdict.current.file_count} 文件）`);

const fp = sourceFingerprint(ROOT);
const manifest = buildOutputManifest(ROOT);
const record = {
  version: 1,
  bound_at: new Date().toISOString(),
  source_fingerprint: fp.fingerprint,
  source_file_count: fp.file_count,
  manifest_sha256: manifest.manifest_sha256,
  build_stamp: verdict.dist,
  artifacts: manifest.entries,
  note: `绑定依据＝本次构建写下的构建戳（${STAMP_REL.dist} 与 ${STAMP_REL.release} 同内容）＋内容指纹＋构建输出清单；不拿 Git HEAD 冒充（工作树可有未提交变更；git 辅助信息见 verify:v09-04 的如实标注）`,
};
fs.mkdirSync(OUT_DIR, { recursive: true });
const out = path.join(OUT_DIR, "binding.json");
fs.writeFileSync(out, JSON.stringify(record, null, 2) + "\n");
console.log(`[bind] 源码指纹 ${fp.fingerprint.slice(0, 16)}…（${fp.file_count} 文件）`);
console.log(`[bind] 清单哈希 ${manifest.manifest_sha256.slice(0, 16)}…（${manifest.entries.length} 项产物）`);
console.log(`[bind] 绑定记录 ${path.relative(ROOT, out)}`);
