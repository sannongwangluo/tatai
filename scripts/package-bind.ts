// V09-04 打包尾部的绑定步骤（PLAN.md V09-04 ②③／附录 E.3.3-1）：
// 构建完成后立刻写「产物 ↔ 源码」绑定记录——源码内容指纹（工作树实测，含未提交变更）＋
// 构建输出清单哈希（dist/**、resources/server/**、release exe、NSIS、MSI 各自 sha256 与体积）。
//
// P0/V09-45 增量（§4.5：在既有链上**关联**身份与输入清单，不另造第二套判据）：
//   · 绑定记录新增 `build_identity`（release/build_id、两部件输入指纹与清单哈希、工具链）；
//   · 新增 `input_manifest`（两组显式构建输入集的**逐文件**清单，相对路径 + sha256）——
//     于是"这批产物出自哪份输入"可复核，而不是只有一句自述；
//   · 写盘前多两道阻断：戳里的身份与**当前工作树现算**的身份必须一致（构建后漂移即拒绝）；
//     发布必需部件缺一即拒绝（缺分片的发布被拒，§4.7 / A0-4）。
//
// 写盘**之前**强制校验构建戳（scripts/lib/buildStamp.ts）：两处戳在场且一致、且戳指纹等于当前实测指纹。
// 任一条不满足就打印 FAIL 原因并 exit 1，**不写 binding.json**——于是「不跑构建、只重跑 package:bind，
// 把旧安装包和当前源码指纹重新写上」这条刷绿路被堵死。正常路径只有一条：pnpm tauri:build
// （scripts/tauri-build.ts 在构建尾部写戳并立刻调本脚本）。
// 用法：pnpm package:bind（必须在同一次构建的尾巴上跑；verify:v09-04 复核它）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { STAMP_REL } from "./lib/buildStamp";
import { computeComponentInputs, identityStampFields } from "./lib/buildIdentity";
import { evaluateReleasePackage } from "./lib/packageVerdict";
import { sourceFingerprint } from "./lib/sourceFingerprint";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.V0904_BIND_OUT ?? path.join(ROOT, ".工作台", "evidence", "V09-04", "1");

// ① 写盘前拦截：整份发布核验**只走同一份判据**（`lib/packageVerdict.ts`，运行时试用提升也调它）。
// 它覆盖：构建戳新鲜度、戳里的构建身份与现算身份相符、输出与构建期冻结清单逐字节一致、
// 真实产物的内嵌身份逐字段相符、发布完整性（缺分片即拒）与引用闭包。任一步不通过即拒绝写 binding.json。
const fields = identityStampFields(ROOT);
const verdict = evaluateReleasePackage(
  ROOT,
  {
    release_id: fields.release_id,
    build_id: fields.build_id,
    server_input_fingerprint: fields.server_input_fingerprint,
    ui_input_fingerprint: fields.ui_input_fingerprint,
  },
  { scope: "full" },
);

if (!verdict.ok) {
  console.error("[bind] FAIL 拒绝写 binding.json——发布核验未通过：");
  for (const r of verdict.problems) console.error(`[bind]   FAIL ${r}`);
  console.error("[bind] 正确做法：重跑 pnpm tauri:build（构建尾部自动写戳并绑定）；不要手工补戳或改戳");
  process.exit(1);
}

const dist = verdict.stamps.dist!;
console.log(`[bind] PASS 构建戳在场且一致（dist/ 与 release/ 同内容，built_at=${dist.built_at}）`);
console.log(`[bind] PASS 戳指纹 === 当前实测（${verdict.stamps.current.fingerprint.slice(0, 16)}… / ${verdict.stamps.current.file_count} 文件）`);
console.log(`[bind] PASS 构建身份与当前输入一致（release ${fields.release_id.slice(0, 12)}…）`);
console.log(`[bind] PASS 输出与构建期冻结清单逐字节一致（${verdict.output_manifest.file_count} 项产物，排除戳自身落点）`);
console.log(
  `[bind] PASS 产物内嵌身份逐字段相符（server ${verdict.artifact.server?.file} / ui ${verdict.artifact.ui?.file}；` +
    `扫 ${verdict.artifact.server?.scanned ?? 0}+${verdict.artifact.ui?.scanned ?? 0} 个 js）`,
);
console.log(`[bind] PASS 发布必需部件齐全（整包 full，${verdict.coverage.present.length} 项）`);
console.log(
  `[bind] PASS 引用闭包完整（入口 ${verdict.closure.entries.length} 个 → 引用 ${verdict.closure.referenced.length} 项产物，均在场且在清单内）`,
);

// 下面写绑定记录用的现场数据都取自**同一次核验**（不再重扫目录）
const fp = sourceFingerprint(ROOT);
const manifest = verdict.manifest;
const artifact = verdict.artifact;
const coverage = verdict.coverage;
const closure = verdict.closure;
const frozenOutput = verdict.output_manifest;

const record = {
  version: 1,
  bound_at: new Date().toISOString(),
  source_fingerprint: fp.fingerprint,
  source_file_count: fp.file_count,
  manifest_sha256: manifest.manifest_sha256,
  build_stamp: verdict.stamps.dist,
  build_identity: fields,
  input_manifest: {
    note: "两组显式构建输入集的逐文件清单（相对路径 + sha256，定序）——判据唯一定义在 scripts/lib/buildIdentity.ts",
    server: computeComponentInputs("server", ROOT),
    ui: computeComponentInputs("ui", ROOT),
  },
  release_coverage: coverage,
  artifact_identity: {
    note: "写绑定前从真实产物读回的内嵌身份（文件名 + release/build），已逐字段核对",
    server_artifact: artifact.server?.file ?? null,
    ui_artifact: artifact.ui?.file ?? null,
    server_release_id: artifact.server?.bundle.server.release_id ?? null,
    ui_release_id: artifact.ui?.bundle.ui.release_id ?? null,
  },
  release_closure: {
    note: "入口文件内容解析出的引用闭包（不是重扫目录）：引用项均在冻结构建清单里",
    entries: closure.entries,
    referenced_count: closure.referenced.length,
    referenced: closure.referenced,
  },
  output_manifest: {
    note: "构建尾部冻结、并在此逐字节复核的完整输出清单（排除戳自身落点）；与戳里的 output_manifest_sha256 一致才写 binding.json",
    sha256: frozenOutput.sha256,
    file_count: frozenOutput.file_count,
    excluded: frozenOutput.excluded,
  },
  artifacts: manifest.entries,
  source_tree: {
    root: ROOT,
    // Codex 纠正 6：工作树的 `.git` 是指针**文件**（内容 `gitdir: …` 计入源码指纹），主仓的 `.git`
    // 是**目录**（在 sourceFingerprint 的跳过集内，不计入）。故隔离工作树的指纹与主仓本就不同——
    // 如实记录，不在部署后手改戳掩盖。
    git_entry: fs.existsSync(path.join(ROOT, ".git"))
      ? fs.statSync(path.join(ROOT, ".git")).isDirectory()
        ? "directory"
        : "worktree-file"
      : "absent",
    note: "源码指纹按工作树实际文件内容计算（含工作树 .git 指针文件的内容）；主仓 .git 目录本身不计入——两者差异是现场事实，不隐藏",
  },
  note: `绑定依据＝本次构建写下的构建戳（${STAMP_REL.dist} 与 ${STAMP_REL.release} 同内容）＋内容指纹＋构建输出清单＋**真实产物的内嵌身份**＋发布完整性/引用闭包＋部件输入清单；不拿 Git HEAD 冒充（工作树可有未提交变更；git 辅助信息见 verify:v09-04 的如实标注）`,
};
fs.mkdirSync(OUT_DIR, { recursive: true });
const out = path.join(OUT_DIR, "binding.json");
fs.writeFileSync(out, JSON.stringify(record, null, 2) + "\n");
console.log(`[bind] 源码指纹 ${fp.fingerprint.slice(0, 16)}…（${fp.file_count} 文件）`);
console.log(`[bind] 清单哈希 ${manifest.manifest_sha256.slice(0, 16)}…（${manifest.entries.length} 项产物）`);
console.log(
  `[bind] 构建身份 release ${fields.release_id.slice(0, 12)}… / build server ${fields.build_id.server.slice(0, 12)}… ui ${fields.build_id.ui.slice(0, 12)}…；输入清单 server ${record.input_manifest.server.file_count} / ui ${record.input_manifest.ui.file_count} 文件`,
);
console.log(`[bind] 绑定记录 ${path.relative(ROOT, out)}`);
