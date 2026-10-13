// 工作区/候选的**构建包身份**绑定与试用提升实测（DESIGN.md §6.13 第 5 段、§6.14 第 3/8 段；PLAN V09-63/V09-65）。
//
// 解决的产品缺口（impl-final-readout §5 登记的契约缺口）：冻结候选原先只绑 DESIGN/PLAN 正文，
// `point_trial` 的 `package_ok` 实际等于「文档齐备」——**包身份从未被实测**。本模块把 §6.10 既有构建链
// 接进两处：
//   · **冻结**：宿主从候选根**实测**构建**输入**身份（`release_id`／组件输入指纹／工具链），记进
//     `version_binding.build_identity`。**先冻结后构建**成立：这里只要输入，不要求产物已存在。
//   · **试用提升**：宿主从候选根**实测真实产物**（内嵌身份 + 构建戳 + 冻结构建输出清单 + 发布完整性
//     + 引用闭包，判据统一在 `scripts/lib/packageVerdict.ts`），与冻结记录**逐项相符**才放行。
//
// 复用边界（§6.14 第 1 段「不另造第二套」）：算法**只此一处**——`scripts/lib/buildIdentity.ts`（输入集/
// 身份推导/产物内嵌身份读回）、`scripts/lib/buildStamp.ts`（构建戳）、`scripts/lib/buildOutputManifest.ts`
// （输出清单/覆盖/引用闭包）、`scripts/lib/packageVerdict.ts`（同一次发布的核验编排）。本模块**只做接线**：
// 判别根有没有 §6.10 构建链、把身份收窄成共享形状、把实测结果与冻结记录比对。**不改**旧全树口径
// `scripts/lib/sourceFingerprint.ts`（它的 SKIP_DIRS 不含 `resources`，会把自指产物吃进指纹——那是它
// 既有的构建戳语义，未被本批改动）。
//
// 适用性（必须明确，照 §6.14 第 3/8 段读）：
//   · **已有 §6.10 构建链**（塔台自身：`scripts/lib/buildIdentity.ts` + `src/shared/buildIdentity.ts`）
//     ⇒ 宿主自动识别为包交付并绑定，**不能靠省略请求字段降成非包**。
//   · 没有该链、且调用方**未声明**包交付 ⇒ 合理 `not_applicable`（普通项目不额外阻塞）。
//   · 没有该链、但调用方**明确声明**包交付 ⇒ `unsupported`／未知（无受支持身份，**不假称已测**）。
import fs from "node:fs";
import path from "node:path";
import { identityStampFields, type IdentityStampFields } from "../../../scripts/lib/buildIdentity";
import { evaluateReleasePackage, type ReleasePackageVerdict } from "../../../scripts/lib/packageVerdict";
import type { ReleaseScope } from "../../../scripts/lib/buildOutputManifest";
import { APP_VERSION } from "../../shared/version";
import type { WorkspaceBuildBinding } from "../../shared/workspaceTypes";

/** §6.10 构建链的锚点文件（相对候选根）。两个都在 = 该根的构建输入身份由这套显式输入集定义。 */
export const BUILD_CHAIN_ANCHORS = ["scripts/lib/buildIdentity.ts", "src/shared/buildIdentity.ts"] as const;

/** 候选根是否带 §6.10 构建链（宿主实测，不采信调用方自报） */
export function detectBuildChain(root: string): boolean {
  return BUILD_CHAIN_ANCHORS.every((rel) => {
    try {
      return fs.statSync(path.join(root, rel)).isFile();
    } catch {
      return false;
    }
  });
}

/**
 * 候选根自己的产品版本号（构建主体的 `APP_VERSION` 来源是**该根**的 `package.json`，不是宿主进程的）。
 * 读不出退回宿主版本——**不编**（`identityStampFields` 明写"unknown 不编"的同一口径）。
 */
export function candidateAppVersion(root: string): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { version?: unknown };
    if (typeof pkg.version === "string" && pkg.version.trim() !== "") return pkg.version.trim();
  } catch {
    /* 读不出退回宿主版本 */
  }
  return APP_VERSION;
}

export type DeriveBuildBindingResult =
  | { ok: true; binding: WorkspaceBuildBinding }
  | { ok: false; code: "PACKAGE_IDENTITY_UNSUPPORTED"; message: string; detail: Record<string, unknown> };

function notApplicable(basis: string): WorkspaceBuildBinding {
  return {
    delivery_kind: "not_applicable",
    basis,
    release_id: null,
    build_id: null,
    server_input_fingerprint: null,
    ui_input_fingerprint: null,
    server_input_manifest_sha256: null,
    ui_input_manifest_sha256: null,
    server_input_file_count: null,
    ui_input_file_count: null,
    toolchain: null,
  };
}

/** 把一组落档字段收窄成共享的构建包身份（`package`）。 */
function packageBinding(fields: IdentityStampFields, basis: string): WorkspaceBuildBinding {
  return {
    delivery_kind: "package",
    basis,
    release_id: fields.release_id,
    build_id: fields.build_id,
    server_input_fingerprint: fields.server_input_fingerprint,
    ui_input_fingerprint: fields.ui_input_fingerprint,
    server_input_manifest_sha256: fields.server_input_manifest_sha256,
    ui_input_manifest_sha256: fields.ui_input_manifest_sha256,
    server_input_file_count: fields.server_input_file_count,
    ui_input_file_count: fields.ui_input_file_count,
    toolchain: fields.toolchain,
  };
}

/**
 * 宿主**实测**候选根的构建包身份（冻结用）。只判"构建**输入**"，不要求产物存在（先冻结后构建）。
 * `declaredPackage`＝调用方显式声明本候选是构建包交付（只增加严格性：声明了却没有链 ⇒ 明确拒）。
 */
export function deriveWorkspaceBuildBinding(
  root: string,
  opts: { declaredPackage?: boolean } = {},
): DeriveBuildBindingResult {
  const declared = opts.declaredPackage === true;
  const hasChain = detectBuildChain(root);
  if (!hasChain) {
    if (declared) {
      return {
        ok: false,
        code: "PACKAGE_IDENTITY_UNSUPPORTED",
        message:
          `调用方声明本候选是构建包交付，但根目录没有受支持的 §6.10 构建链（缺 ${BUILD_CHAIN_ANCHORS.join(" / ")}）：` +
          `宿主无从实测包身份，明确报 unsupported/未知，不假称已测（DESIGN.md §6.14 第 3/8 段）`,
        detail: { root, anchors: [...BUILD_CHAIN_ANCHORS] },
      };
    }
    return {
      ok: true,
      binding: notApplicable(
        `宿主实测：根目录没有 §6.10 构建链（缺 ${BUILD_CHAIN_ANCHORS.join(" / ")}）且调用方未声明包交付——` +
          `本候选不需要构建包身份（合理 not_applicable，不额外阻塞）`,
      ),
    };
  }
  try {
    const fields = identityStampFields(root, candidateAppVersion(root));
    return {
      ok: true,
      binding: packageBinding(fields, `宿主实测：根含 §6.10 构建链（${BUILD_CHAIN_ANCHORS.join(" + ")}），按既有显式输入集算构建输入身份`),
    };
  } catch (e) {
    return {
      ok: false,
      code: "PACKAGE_IDENTITY_UNSUPPORTED",
      message: `宿主实测该候选根的构建输入身份失败（§6.10）：${e instanceof Error ? e.message : String(e)}——按未知处理，不假称已测`,
      detail: { root },
    };
  }
}

/** 试用提升的包身份实测结论 */
export interface PackagePromotionResult {
  /** 该交付是否需要构建包身份（package 候选 = true；合理 not_applicable = false） */
  applicable: boolean;
  ok: boolean;
  /** 不通过原因（逐条点名；`applicable=false` 且 `ok=true` 时为空） */
  reasons: string[];
}

/**
 * 试用提升前的**真实产物**实测（§6.14 第 8 段）：接受**宿主实测**，不接受调用方自报 measured。
 * `frozen`＝冻结记录的 `version_binding.build_identity`（旧记录为 null）。
 */
export function verifyPackageAtPromotion(input: {
  root: string;
  frozen: WorkspaceBuildBinding | null;
  scope?: ReleaseScope;
  /** 两部件产物目录覆盖（隔离夹具用） */
  dirs?: { server?: string; ui?: string };
}): PackagePromotionResult {
  const { root, frozen } = input;
  const hasChain = detectBuildChain(root);

  // ── 旧记录 / not_applicable：已知包项目缺身份 ⇒ 未知，不得默认真；无链的普通项目 ⇒ 合理放行 ──
  if (frozen === null) {
    if (hasChain) {
      return {
        applicable: true,
        ok: false,
        reasons: [
          "冻结记录没有绑定构建包身份（version_binding.build_identity 缺），而该候选根含 §6.10 构建链：属**已知包项目**，" +
            "缺身份按未知处理，**不得默认真**（DESIGN.md §6.14 第 3/8 段）；请从它派生新准备区并重新冻结以绑定构建输入身份",
        ],
      };
    }
    return { applicable: false, ok: true, reasons: [] };
  }
  if (frozen.delivery_kind === "not_applicable") {
    if (hasChain) {
      return {
        applicable: true,
        ok: false,
        reasons: [
          "冻结时判为 not_applicable，但该候选根**现在**含 §6.10 构建链：构建包身份未被冻结绑定，按未知处理、不默认真" +
            "（不能用省略请求字段把包交付降成非包）",
        ],
      };
    }
    return { applicable: false, ok: true, reasons: [] };
  }

  // ── package：冻结记录必须身份完整；再核现算输入未漂移；最后实测真实产物 ──
  const releaseId = frozen.release_id;
  const buildId = frozen.build_id;
  const serverFp = frozen.server_input_fingerprint;
  const uiFp = frozen.ui_input_fingerprint;
  const missing: string[] = [];
  if (releaseId === null) missing.push("release_id");
  if (buildId === null) missing.push("build_id");
  if (serverFp === null) missing.push("server_input_fingerprint");
  if (uiFp === null) missing.push("ui_input_fingerprint");
  if (releaseId === null || buildId === null || serverFp === null || uiFp === null) {
    return {
      applicable: true,
      ok: false,
      reasons: [`冻结记录标为 package 但构建输入身份不完整（缺 ${missing.join("、")}）：按未知处理，不默认真`],
    };
  }
  const expected = {
    release_id: releaseId,
    build_id: buildId,
    server_input_fingerprint: serverFp,
    ui_input_fingerprint: uiFp,
  };

  let current: IdentityStampFields;
  try {
    current = identityStampFields(root, candidateAppVersion(root));
  } catch (e) {
    return {
      applicable: true,
      ok: false,
      reasons: [`宿主现算该候选根构建输入失败：${e instanceof Error ? e.message : String(e)}——按未知处理，不假称已测`],
    };
  }
  const drift: string[] = [];
  if (current.release_id !== expected.release_id) {
    drift.push(
      `构建输入在冻结后漂移：现算 release ${current.release_id.slice(0, 12)}… ≠ 冻结 ${expected.release_id.slice(0, 12)}…` +
        `（候选源码/构建脚本/锁/工具链已变，不是被冻结的那一版）`,
    );
  }
  if (current.server_input_fingerprint !== expected.server_input_fingerprint) {
    drift.push(`server 构建输入指纹与冻结记录不符（现算 ${current.server_input_fingerprint.slice(0, 12)}…）`);
  }
  if (current.ui_input_fingerprint !== expected.ui_input_fingerprint) {
    drift.push(`ui 构建输入指纹与冻结记录不符（现算 ${current.ui_input_fingerprint.slice(0, 12)}…）`);
  }
  if (drift.length > 0) return { applicable: true, ok: false, reasons: drift };

  let verdict: ReleasePackageVerdict;
  try {
    verdict = evaluateReleasePackage(root, expected, {
      scope: input.scope ?? "full",
      appVersion: candidateAppVersion(root),
      ...(input.dirs === undefined ? {} : { dirs: input.dirs }),
    });
  } catch (e) {
    return {
      applicable: true,
      ok: false,
      reasons: [`宿主实测真实产物失败：${e instanceof Error ? e.message : String(e)}——按未知处理，不假称已测`],
    };
  }
  if (!verdict.ok) return { applicable: true, ok: false, reasons: verdict.problems };
  return { applicable: true, ok: true, reasons: [] };
}
