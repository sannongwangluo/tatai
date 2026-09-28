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

export interface BuildStamp {
  version: 1;
  source_fingerprint: string;
  source_file_count: number;
  built_at: string;
  builder: "tauri-build.ts";
}

/** 两处戳相对项目根的路径 */
export const STAMP_REL = {
  dist: "dist/build-stamp.json",
  release: "src-tauri/target/release/build-stamp.json",
} as const;

/** 两处戳内容的规范形（比较时用，忽略键序与空白） */
function canon(s: BuildStamp): string {
  return JSON.stringify([s.version, s.source_fingerprint, s.source_file_count, s.built_at, s.builder]);
}

/** 两个戳是否同一份内容（按字段比对，忽略键序与空白） */
export function stampsEqual(a: BuildStamp, b: BuildStamp): boolean {
  return canon(a) === canon(b);
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
  return raw as BuildStamp;
}

/** 构建开工时清掉旧戳：构建中途失败就不留任何戳，旧产物+新源码的混合状态在 package:bind 处必然判红。 */
export function clearBuildStamps(root: string): void {
  for (const rel of [STAMP_REL.dist, STAMP_REL.release]) {
    const abs = path.join(root, rel);
    if (fs.existsSync(abs)) fs.unlinkSync(abs);
  }
}

/** 取构建全部完成后的工作树指纹，同一份内容写到两处。返回写入的戳。 */
export function writeBuildStamp(root: string): BuildStamp {
  const fp = sourceFingerprint(root);
  const stamp: BuildStamp = {
    version: 1,
    source_fingerprint: fp.fingerprint,
    source_file_count: fp.file_count,
    built_at: new Date().toISOString(),
    builder: "tauri-build.ts",
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
