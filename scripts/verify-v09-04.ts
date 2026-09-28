// V09-04 打包物刷新与产物-源码绑定（PLAN.md V09-04；DESIGN.md §11.3/§11.8、附录 E.3.3/E.3.5）。
// 用法：pnpm verify:v09-04
//
// 判据（绑定用**内容**，不用 Git ref——附录 E.3.3-1）：
//   ① 三件产物在场且非零（release exe、NSIS、MSI）；
//   ② 绑定记录在场（`package:bind` 在构建尾部写入）；记录里的**源码内容指纹**与当前工作树实测一致
//     （改一个源文件就必须红）；**构建输出清单哈希**与盘上产物一致（产物被替换/回退就必须红）；
//   ②b 构建戳（build stamp，防伪机制）：`dist/build-stamp.json` 与 `src-tauri/target/release/build-stamp.json`
//     两处在场且内容一致、指纹 === 绑定记录指纹 === 当前实测；戳本身是产物清单的一项（篡戳必破清单哈希）；
//     绑定记录内嵌的 `build_stamp` 与盘上戳一致。
//     —— 戳只能由 `pnpm tauri:build` 在构建尾部写下（scripts/tauri-build.ts），
//       所以「不跑构建、只重跑 package:bind 把旧产物按当前源码重新绑定」拿不到戳：绑定会被拒、这里判红。
//   ③ Git 信息只作辅助标注（如实打印 HEAD/工作树是否干净），**不参与判绿**——
//     「只 commit 不动内容 ⇒ 不红」由指纹算法构造保证（它不读 Git；见 sourceFingerprint.ts）。
// 反例证据（红跑）在 `.工作台/evidence/V09-04/1/`：改 UI 文件→红、回退产物→红、复原则绿；
// 缺戳/戳过期→红见 `.工作台/evidence/V09-04/stamp-mechanism/`。
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateBuildStamps, STAMP_REL, stampsEqual, type BuildStamp } from "./lib/buildStamp";
import { buildOutputManifest, sourceFingerprint } from "./lib/sourceFingerprint";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIND = process.env.V0904_BIND_OUT
  ? path.join(process.env.V0904_BIND_OUT, "binding.json")
  : path.join(ROOT, ".工作台", "evidence", "V09-04", "1", "binding.json");

let pass = 0;
const fails: string[] = [];
const ok = (cond: boolean, label: string): void => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (cond) pass++;
  else fails.push(label);
};

const ART = {
  exe: "src-tauri/target/release/tatai.exe",
  nsis: "src-tauri/target/release/bundle/nsis/Tatai_0.1.0_x64-setup.exe",
  msi: "src-tauri/target/release/bundle/msi/Tatai_0.1.0_x64_en-US.msi",
};

console.log("[verify] ═══ ① 三件产物在场 ═══");
for (const [name, rel] of Object.entries(ART)) {
  const abs = path.join(ROOT, rel);
  const size = fs.existsSync(abs) ? fs.statSync(abs).size : 0;
  ok(size > 100_000, `① ${name} 在场且非零（${(size / 1024 / 1024).toFixed(3)} MB）`);
}

console.log("[verify] ═══ ② 绑定记录与当前现场一致 ═══");
const verdict = evaluateBuildStamps(ROOT);
ok(
  verdict.dist !== null && verdict.release !== null,
  `② 两处构建戳在场（${STAMP_REL.dist}、${STAMP_REL.release}）——不跑 pnpm tauri:build 就没有戳`,
);
ok(verdict.stamps_identical, "② 两处构建戳内容一致（两处都在场时才可能成立）");
if (!fs.existsSync(BIND)) {
  ok(false, `② 绑定记录不存在（${path.relative(ROOT, BIND)}）——构建尾部必须先跑 pnpm package:bind`);
} else {
  const binding = JSON.parse(fs.readFileSync(BIND, "utf8")) as {
    bound_at: string;
    source_fingerprint: string;
    source_file_count: number;
    manifest_sha256: string;
    build_stamp?: BuildStamp;
    artifacts: { path: string; sha256: string; bytes: number }[];
  };
  ok(
    typeof binding.bound_at === "string" && binding.bound_at !== "" && !Number.isNaN(Date.parse(binding.bound_at)),
    `② 绑定记录带真实时刻（bound_at=${binding.bound_at}）`,
  );
  const fp = sourceFingerprint(ROOT);
  ok(
    fp.fingerprint === binding.source_fingerprint && fp.file_count === binding.source_file_count,
    `② 源码内容指纹一致（${fp.fingerprint.slice(0, 16)}… / ${fp.file_count} 文件）——改任一源文件此处必红`,
  );
  ok(
    verdict.current_match && verdict.dist !== null && binding.source_fingerprint === verdict.dist.source_fingerprint,
    `② 构建戳指纹 === 绑定记录指纹 === 当前实测（${verdict.dist ? verdict.dist.source_fingerprint.slice(0, 16) + "…" : "无戳"}）——旧产物按当前源码重新绑定此处必红`,
  );
  const manifest = buildOutputManifest(ROOT);
  ok(
    manifest.manifest_sha256 === binding.manifest_sha256,
    `② 构建输出清单哈希一致（${manifest.manifest_sha256.slice(0, 16)}… / ${manifest.entries.length} 项）——产物被换此处必红`,
  );
  ok(
    manifest.entries.some((e) => e.path === STAMP_REL.dist),
    `② 构建戳在产物清单里（${STAMP_REL.dist}）——戳是产物的一部分，篡戳必破清单哈希`,
  );
  ok(
    binding.build_stamp !== undefined && verdict.dist !== null && stampsEqual(binding.build_stamp, verdict.dist),
    "② 绑定记录内嵌的 build_stamp 与盘上戳一致",
  );
  for (const rel of Object.values(ART)) {
    const rec = binding.artifacts.find((a) => a.path === rel);
    const now = manifest.entries.find((a) => a.path === rel);
    ok(
      rec !== undefined && now !== undefined && rec.sha256 === now.sha256 && rec.bytes === now.bytes,
      `② 产物逐项相符：${path.basename(rel)}（${now ? (now.bytes / 1024 / 1024).toFixed(3) : "?"} MB）`,
    );
  }
}

console.log("[verify] ═══ ③ Git 只作辅助标注（不参与判绿） ═══");
try {
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" }).trim() !== "";
  console.log(`[verify]   辅助标注：HEAD=${head.slice(0, 12)}… 工作树${dirty ? "有" : "无"}未提交变更（不判绿）`);
  ok(true, "③ Git 辅助标注已如实打印");
} catch {
  console.log("[verify]   辅助标注：git 不可用（不影响判绿）");
  ok(true, "③ Git 辅助标注降级为不可用说明");
}

console.log(`\n[verify] V09-04：PASS ${pass} / FAIL ${fails.length}`);
if (fails.length > 0) {
  for (const f of fails) console.log(`[verify]   FAIL ${f}`);
  process.exit(1);
}
console.log("[verify] 全部 PASS");
