// 发布包核验的统一判据（§4.5「不另造第二套」；§6.14 第 3/8 段的包身份实测复用同一份）。
//
// 从 `scripts/package-bind.ts` 的内联门禁**最小抽出**：构建尾绑定（`pnpm package:bind`）与运行时试用提升
// （`src/server/work/workspaceBuildBinding.ts` 经本模块）**调用同一个函数**，判据只此一处——两处各写一遍
// 必然分叉（"绑定记录签了字、提升侧却用另一套口径"）。本模块只做**编排**：各步判据仍是既有 helper
// （`buildIdentity` / `buildOutputManifest` / `buildStamp`），不复制、不改写它们的算法。
import type { BuildComponent } from "../../src/shared/buildIdentity";
import type { ArtifactIdentityVerdict } from "./buildIdentity";
import { artifactDirs, checkArtifactIdentity } from "./buildIdentity";
import type { ArtifactEntry, ReferencedOutputs, ReleaseCoverage, ReleaseScope } from "./buildOutputManifest";
import { buildOutputManifest, collectReferencedOutputs, outputManifestFingerprint, releaseCoverage } from "./buildOutputManifest";
import type { StampVerdict } from "./buildStamp";
import { evaluateBuildStamps } from "./buildStamp";

/** 期望的发布身份（构建尾＝现算身份；试用提升＝冻结记录里的身份） */
export interface ReleasePackageExpectation {
  release_id: string;
  build_id: Record<BuildComponent, string>;
  server_input_fingerprint: string;
  ui_input_fingerprint: string;
}

export interface ReleasePackageVerdict {
  ok: boolean;
  /** 全部不通过原因（逐条点名，不合并成一句） */
  problems: string[];
  /** ① 构建戳在场且一致、且戳指纹＝当前实测 */
  stamps: StampVerdict;
  /** ①′ 戳里的构建身份段与期望逐项相符 */
  stamp_identity_problems: string[];
  /** ①‴ 当前输出与构建期冻结的完整输出清单逐字节一致 */
  output_manifest: { ok: boolean; problems: string[]; sha256: string; file_count: number; excluded: string[] };
  /** ①‴ 真实产物内嵌身份逐字段相符（含两产物不混批） */
  artifact: ArtifactIdentityVerdict;
  /** ①″ 发布必需部件齐全 */
  coverage: ReleaseCoverage;
  /** ①⁗ 入口引用的产物闭包完整且在冻结构建清单里 */
  closure: ReferencedOutputs;
  /** 本次实际算出的构建输出清单（调用方复用，不再重扫一遍目录） */
  manifest: { entries: ArtifactEntry[]; manifest_sha256: string };
}

export interface ReleasePackageOptions {
  /** 发布作用域：`full`（默认，含 exe/NSIS/MSI）或 `server-only`（显式作用域，不冒充整包） */
  scope?: ReleaseScope;
  /** 产品版本号（拼安装器文件名）；缺省用宿主版本 */
  appVersion?: string;
  /** 两部件产物目录覆盖（隔离夹具用；缺省 `artifactDirs(root)`） */
  dirs?: { server?: string; ui?: string };
}

/**
 * 对一个**已构建的根目录**做完整发布核验（构建尾与试用提升共用）。
 * `expected` 是"这批产物应当是哪一次构建"的判据：构建尾＝现算身份，提升＝冻结记录里的身份。
 * 任一步不通过即 `ok:false` 且逐条点名；**不合并、不放行**。
 */
export function evaluateReleasePackage(
  root: string,
  expected: ReleasePackageExpectation,
  opts: ReleasePackageOptions = {},
): ReleasePackageVerdict {
  const scope = opts.scope ?? "full";
  const dirs = { ...artifactDirs(root), ...opts.dirs };
  const problems: string[] = [];

  // ① 构建戳：两处在场、一致、且戳指纹＝当前实测（不跑构建就没有戳）
  const stamps = evaluateBuildStamps(root);
  for (const r of stamps.reasons) problems.push(r);

  // ①′ 戳里的构建身份段与期望逐项相符（构建后输入漂移/戳被改都拒）
  const stampIdentityProblems: string[] = [];
  const stampIdentity = stamps.dist?.build_identity;
  if (stamps.dist !== null && stampIdentity === undefined) {
    stampIdentityProblems.push("构建戳里没有构建身份段（build_identity）——这批产物不是带构建身份的构建链做出来的，拒绝");
  } else if (stampIdentity !== undefined) {
    const short = (s: string): string => s.slice(0, 12);
    if (stampIdentity.release_id !== expected.release_id) {
      stampIdentityProblems.push(
        `构建身份与期望不一致：戳 release ${short(stampIdentity.release_id)}… ≠ 期望 ${short(expected.release_id)}…（构建后输入已漂移，或戳被人改过）`,
      );
    }
    if (stampIdentity.build_id.server !== expected.build_id.server || stampIdentity.build_id.ui !== expected.build_id.ui) {
      stampIdentityProblems.push("戳的 build_id 与期望不符（server/ui 至少一项对不上）");
    }
    if (stampIdentity.server_input_fingerprint !== expected.server_input_fingerprint) {
      stampIdentityProblems.push(
        `戳的 server 输入指纹与期望不符（戳 ${short(stampIdentity.server_input_fingerprint)}… ≠ 期望 ${short(expected.server_input_fingerprint)}…）`,
      );
    }
    if (stampIdentity.ui_input_fingerprint !== expected.ui_input_fingerprint) {
      stampIdentityProblems.push(
        `戳的 ui 输入指纹与期望不符（戳 ${short(stampIdentity.ui_input_fingerprint)}… ≠ 期望 ${short(expected.ui_input_fingerprint)}…）`,
      );
    }
  }
  problems.push(...stampIdentityProblems);

  // ①‴ 当前输出与**构建期在构建尾部冻结**的完整输出清单逐字节一致（旧分片换字节/旧壳被替换都拒）
  const frozenOutput = outputManifestFingerprint(root, undefined, opts.appVersion);
  const outputProblems: string[] = [];
  const stampOutput = stampIdentity?.output_manifest_sha256;
  if (stampOutput === undefined) {
    outputProblems.push("戳里没有冻结构建输出清单（output_manifest_sha256）——旧戳可读，但不冒称支持发布完整性，拒绝");
  } else if (stampOutput !== frozenOutput.sha256) {
    outputProblems.push(
      `输出与构建期冻结清单不一致：戳 ${stampOutput.slice(0, 12)}… ≠ 现算 ${frozenOutput.sha256.slice(0, 12)}…（某个产物/旧分片/旧壳/安装器被换过或缺失）`,
    );
  }
  problems.push(...outputProblems);

  // ①‴ 从**真实产物**读回内嵌身份并逐字段核对（两部件混批在此被拒）
  const artifact = checkArtifactIdentity(root, expected, { dirs });
  problems.push(...artifact.problems);

  // ①″ 发布完整性（缺一即拒）
  const manifest = buildOutputManifest(root, opts.appVersion);
  const coverage = releaseCoverage(manifest.entries, { scope, appVersion: opts.appVersion });
  if (!coverage.ok) problems.push(`发布不完整，缺必需部件：${coverage.missing.join(", ")}`);

  // ①⁗ 引用闭包：入口实际引用的 chunk/CSS/资源必须在场且在冻结构建清单里
  const closure = collectReferencedOutputs(root, { scope, manifestPaths: manifest.entries.map((e) => e.path), dirs });
  if (!closure.ok) {
    for (const p of closure.missing) problems.push(`引用的产物缺失：${p}`);
    for (const p of closure.not_in_manifest) problems.push(`引用的产物不在冻结构建清单里：${p}`);
    for (const p of closure.errors) problems.push(`读产物失败：${p}`);
  }

  return {
    ok: problems.length === 0,
    problems,
    stamps,
    stamp_identity_problems: stampIdentityProblems,
    output_manifest: {
      ok: outputProblems.length === 0,
      problems: outputProblems,
      sha256: frozenOutput.sha256,
      file_count: frozenOutput.file_count,
      excluded: frozenOutput.excluded,
    },
    artifact,
    coverage,
    closure,
    manifest,
  };
}
