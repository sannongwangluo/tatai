// V09-04 构建戳（build stamp）：把「同一次构建运行」的输入↔产物对应关系钉死。
//
// 语义：戳证明**这些产物出自某一次构建运行，该运行结束时的树状态指纹为 X**。
// 它由 `scripts/tauri-build.ts` 在真实 `tauri build` 成功返回**之后**写入——所以不跑构建就没有戳，
// `scripts/package-bind.ts` 拿不到一致且新鲜的戳就拒绝写 binding.json（旧安装包 + 当前源码的刷绿路被堵死）。
//
// 落点（两处，同一份内容）：
//   - `dist/build-stamp.json`                      （在产物清单里 ⇒ 篡戳会连带破坏清单哈希）
//   - `src-tauri/target/release/build-stamp.json`  （在发布目录里，随产物就地可查）
// 两处都在 `sourceFingerprint` 的跳过集内（dist/ 与 target/），**不会自激**：写戳不改变指纹本身。
// 判据只此一处——`package:bind`（写前拦截）与 `verify:v09-04`（复核）共用 evaluateBuildStamps()，
// 两处各写一套就会分叉。
import fs from "node:fs";
import path from "node:path";
import { sourceFingerprint } from "./sourceFingerprint";
import { stableStringify } from "../../src/shared/stableJson";
import { isToolchainIdentity } from "../../src/shared/buildIdentity";
import type { BuildComponent, ToolchainIdentity } from "../../src/shared/buildIdentity";

/**
 * P0/V09-45：把**部件构建身份**与**输入清单关联**挂到既有构建戳上（§4.5「不另造第二套判据」）。
 * 只增不改：老戳（没有这一段）照旧合法、照旧可比；新戳多回答一句"这批产物实际是哪个 release/build"。
 */
export interface StampBuildIdentity {
  release_id: string;
  build_id: Record<BuildComponent, string>;
  server_input_fingerprint: string;
  ui_input_fingerprint: string;
  server_input_file_count: number;
  ui_input_file_count: number;
  /** 输入清单（相对路径 + 每文件 sha256）的哈希——绑定记录据此关联"输入清单" */
  server_input_manifest_sha256: string;
  ui_input_manifest_sha256: string;
  toolchain: ToolchainIdentity;
  /** P0/V09-45 集成复核 1：构建**尾部冻结**的完整输出清单指纹（排除戳自身落点）——package:bind 拿它
   *  核当前输出是否与构建期逐字节一致（旧分片换字节 / 旧壳·安装器被替换都拒）。老戳可缺此段：
   *  可读、但**不冒称**支持新的发布完整性核对（package:bind 见缺即拒，不当它完整）。 */
  output_manifest_sha256?: string;
  output_file_count?: number;
}

export interface BuildStamp {
  version: 1;
  source_fingerprint: string;
  source_file_count: number;
  built_at: string;
  builder: "tauri-build.ts";
  /** P0 新增（可选：老戳没有这段） */
  build_identity?: StampBuildIdentity;
}

/** 两处戳相对项目根的路径 */
export const STAMP_REL = {
  dist: "dist/build-stamp.json",
  release: "src-tauri/target/release/build-stamp.json",
} as const;

/** 两处戳内容的规范形（比较时用，忽略键序与空白）；身份段在场时**全部字段**纳入比较。
 *  用共享的稳定序列化（键递归排序），不再用原生 JSON.stringify——后者对嵌套对象的键序敏感，
 *  与"忽略键序"的承诺相悖，且旧实现漏比了 file_count / manifest_sha256，改这些字段判不出分叉。 */
function canon(s: BuildStamp): string {
  return stableStringify({
    version: s.version,
    source_fingerprint: s.source_fingerprint,
    source_file_count: s.source_file_count,
    built_at: s.built_at,
    builder: s.builder,
    build_identity:
      s.build_identity === undefined
        ? null
        : {
            release_id: s.build_identity.release_id,
            build_id: s.build_identity.build_id,
            server_input_fingerprint: s.build_identity.server_input_fingerprint,
            ui_input_fingerprint: s.build_identity.ui_input_fingerprint,
            server_input_file_count: s.build_identity.server_input_file_count,
            ui_input_file_count: s.build_identity.ui_input_file_count,
            server_input_manifest_sha256: s.build_identity.server_input_manifest_sha256,
            ui_input_manifest_sha256: s.build_identity.ui_input_manifest_sha256,
            toolchain: s.build_identity.toolchain,
            output_manifest_sha256: s.build_identity.output_manifest_sha256 ?? null,
            output_file_count: s.build_identity.output_file_count ?? null,
          },
  });
}

/** 两个戳是否同一份内容（按字段比对，忽略键序与空白） */
export function stampsEqual(a: BuildStamp, b: BuildStamp): boolean {
  return canon(a) === canon(b);
}

/** 身份段的完整形状校验（导出给验证脚本/绑定链共用同一份，不各写一遍）。
 *  新段的**每一个必需字段**都必须在场且合法："半截身份"宁可判不合法，也不能被当成完整同源。 */
export function isStampBuildIdentity(v: unknown): v is StampBuildIdentity {
  if (typeof v !== "object" || v === null) return false;
  const id = v as Partial<StampBuildIdentity>;
  const nonEmptyStr = (x: unknown): x is string => typeof x === "string" && x !== "";
  const nonNegInt = (x: unknown): x is number => typeof x === "number" && Number.isInteger(x) && x >= 0;
  const buildId = id.build_id as Record<string, unknown> | undefined;
  return (
    nonEmptyStr(id.release_id) &&
    nonEmptyStr(id.server_input_fingerprint) &&
    nonEmptyStr(id.ui_input_fingerprint) &&
    nonNegInt(id.server_input_file_count) &&
    nonNegInt(id.ui_input_file_count) &&
    nonEmptyStr(id.server_input_manifest_sha256) &&
    nonEmptyStr(id.ui_input_manifest_sha256) &&
    typeof buildId === "object" &&
    buildId !== null &&
    nonEmptyStr(buildId.server) &&
    nonEmptyStr(buildId.ui) &&
    isToolchainIdentity(id.toolchain) &&
    // 输出清单段是可选的（老戳没有）——但在场就必须形状完整
    (id.output_manifest_sha256 === undefined || nonEmptyStr(id.output_manifest_sha256)) &&
    (id.output_file_count === undefined || nonNegInt(id.output_file_count))
  );
}

function parseStamp(abs: string): BuildStamp | null {
  if (!fs.existsSync(abs)) return null;
  const raw = JSON.parse(fs.readFileSync(abs, "utf8")) as Partial<BuildStamp>;
  if (
    raw.version !== 1 ||
    typeof raw.source_fingerprint !== "string" ||
    raw.source_fingerprint === "" ||
    typeof raw.source_file_count !== "number" ||
    typeof raw.built_at !== "string" ||
    Number.isNaN(Date.parse(raw.built_at))
  ) {
    throw new Error(`戳字段不合法：${abs}`);
  }
  // P0 身份段是**可选**的：老戳没有它照旧合法；有新段就必须**每个字段都完整合法**
  // （缺字段/字段非法/被篡改成半截都判不合法——不能被当成"完整同源"）。
  if (raw.build_identity !== undefined && !isStampBuildIdentity(raw.build_identity)) {
    throw new Error(`戳的构建身份段不合法（缺字段或字段非法）：${abs}`);
  }
  return raw as BuildStamp;
}

/** 构建开工时清掉旧戳：构建中途失败就不留任何戳，旧产物+新源码的混合状态在 package:bind 处必然判红。 */
export function clearBuildStamps(root: string): void {
  for (const rel of [STAMP_REL.dist, STAMP_REL.release]) {
    const abs = path.join(root, rel);
    if (fs.existsSync(abs)) fs.unlinkSync(abs);
  }
}

/** 取构建全部完成后的工作树指纹，同一份内容写到两处。返回写入的戳。
 *  `identity` 在场时把部件身份与输入清单关联一并写进戳（P0/V09-45）。 */
export function writeBuildStamp(root: string, identity?: StampBuildIdentity): BuildStamp {
  const fp = sourceFingerprint(root);
  const stamp: BuildStamp = {
    version: 1,
    source_fingerprint: fp.fingerprint,
    source_file_count: fp.file_count,
    built_at: new Date().toISOString(),
    builder: "tauri-build.ts",
    ...(identity === undefined ? {} : { build_identity: identity }),
  };
  const body = JSON.stringify(stamp, null, 2) + "\n";
  for (const rel of [STAMP_REL.dist, STAMP_REL.release]) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  return stamp;
}

/** 读两处戳；不存在或读不出来则对应字段为 null，读不出来的原因落在 malformed 里。 */
export function readBuildStamps(root: string): { dist: BuildStamp | null; release: BuildStamp | null; malformed: string[] } {
  const malformed: string[] = [];
  const read = (rel: string): BuildStamp | null => {
    try {
      return parseStamp(path.join(root, rel));
    } catch (e) {
      malformed.push(`${rel}：${(e as Error).message}`);
      return null;
    }
  };
  return { dist: read(STAMP_REL.dist), release: read(STAMP_REL.release), malformed };
}

export interface StampVerdict {
  dist: BuildStamp | null;
  release: BuildStamp | null;
  /** 读不出来的戳（不存在/JSON 损坏/字段不合法） */
  malformed: string[];
  /** 两处戳都在场且内容一致 */
  stamps_identical: boolean;
  /** 戳指纹 === 当前工作树实测指纹（即自本次构建之后源码零改动） */
  current_match: boolean;
  /** 不通过原因（缺戳／戳分叉／戳后源码已改）；空数组表示通过 */
  reasons: string[];
  ok: boolean;
  current: { fingerprint: string; file_count: number };
}

/** 构建戳判据（package:bind 写前拦截与 verify:v09-04 复核共用同一份）。 */
export function evaluateBuildStamps(root: string): StampVerdict {
  const { dist, release, malformed } = readBuildStamps(root);
  const current = sourceFingerprint(root);
  const reasons: string[] = [...malformed];

  if (dist === null) {
    reasons.push(`缺构建戳：${STAMP_REL.dist} 不存在——必须由 pnpm tauri:build 在构建尾部生成，手工补戳不构成构建证据`);
  }
  if (release === null) {
    reasons.push(`缺构建戳：${STAMP_REL.release} 不存在——必须由 pnpm tauri:build 在构建尾部生成`);
  }

  const stamps_identical = dist !== null && release !== null && stampsEqual(dist, release);
  if (dist !== null && release !== null && !stamps_identical) {
    reasons.push(
      `构建戳分叉：两处内容不一致（dist=${dist.source_fingerprint.slice(0, 16)}… / release=${release.source_fingerprint.slice(0, 16)}…）——不是同一次构建写出的`,
    );
  }

  const current_match = dist !== null && release !== null && stamps_identical && dist.source_fingerprint === current.fingerprint;
  if (dist !== null && release !== null && stamps_identical && !current_match) {
    reasons.push(
      `戳后源码已改：戳指纹 ${dist.source_fingerprint.slice(0, 16)}…（${dist.source_file_count} 文件）!== 当前实测 ${current.fingerprint.slice(0, 16)}…（${current.file_count} 文件）——旧产物不能按当前源码重新绑定`,
    );
  }

  return {
    dist,
    release,
    malformed,
    stamps_identical,
    current_match,
    reasons,
    ok: reasons.length === 0,
    current,
  };
}
