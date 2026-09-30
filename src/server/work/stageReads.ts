// 项目级「阶段必读指针」的只读支持（DESIGN.md §6.7 的 required_reads 扩展；2026-09-30 有界修正）。
//
// 要解决的问题：`entry.ts#requiredReads` 是硬编码的四处产出（plan/design/baselines/events），
// 项目**当前阶段的必读原文**——项目总图、AGENTS.md、当前交接——不在里面，接续 Agent 拿不到
// 它们，只能靠人反复交代。改 `.工作台/plan.md` / `.工作台/design.md` 会动内容/定义哈希、
// 触发入口 `blocked` 或迫使重激活基线，所以走**另加一个项目级运行配置**这条路（与既有
// `.工作台/work/budget.json` 同层同类）：`<项目根>/.工作台/work/stage-reads.json`。
//
// 三条硬口径：
//   ① **机器派生指针，不是新设计或授权源**：本文件只描述"哪些原文是这一阶段的必读"，不承载
//      任何设计结论、不放行任何任务。缺文件 = 老项目原样兼容（不加 `missing` 理由、不阻断入口）。
//   ② **fail-closed、错误必须显式**：坏 JSON / 字段类型不对 / 来源哈希漂移 / 路径逃逸 —— 一律
//      返回 `invalid`（入口据此 `blocked`），**不静默按旧口径派活**。来源缺失或改过就拒发。
//   ③ **只读**：本模块读文件、算哈希，不写任何东西；不吃注册表以外的调用方路径。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { resolveProjectRelative } from "./documents";

/** 配置文件（项目根内相对路径；与 `.工作台/work/budget.json` 同层同类） */
export const STAGE_READS_FILE = "stage-reads.json";
export const STAGE_READS_REL = `.工作台/work/${STAGE_READS_FILE}`;

/** 唯一认的 schema 版本（别的值一律拒绝——转格式要显式改代码，不靠猜） */
export const STAGE_READS_SCHEMA_VERSION = 1;

/** 指针文件自身的体积上限（机器派生的小文件；超过说明写错了东西） */
export const STAGE_READS_MAX_BYTES = 256 * 1024;
/** 被引用文件参与哈希时的读取上限（证据正文本身上限同量级；更大的文件不该当"必读原文"） */
export const STAGE_READS_MAX_FILE_BYTES = 8 * 1024 * 1024;

/**
 * 条目的 `kind` 取值 = §6.7 `RequiredRead.kind` 的既有联合（**不发明新 enum**）。
 * 本表是这一联合的单一出处，`entry.ts` 的 `RequiredRead.kind` 直接引用它。
 */
export const STAGE_READ_KINDS = [
  "design",
  "plan",
  "baseline",
  "task_facts",
  "evidence",
  "checkpoint",
  "audit",
  "decisions",
] as const;
export type StageReadKind = (typeof STAGE_READ_KINDS)[number];

export interface StageReadSource {
  /** 项目根内相对路径 */
  path: string;
  /** 生成时的内容 sha256（读回时必须等于当前值，否则=来源漂移） */
  sha256: string;
}

export interface StageReadEntry {
  /** 项目根内相对路径 */
  path: string;
  kind: StageReadKind;
  why: string;
  /** 可选：生成时的内容 sha256；给了就必须等于当前值 */
  revision: string | null;
}

export type StageReadsLoad =
  | { status: "absent" }
  | { status: "invalid"; reasons: string[] }
  | {
      status: "ok";
      rel_path: string;
      generated_from: StageReadSource[];
      entries: StageReadEntry[];
      preferred_task_id: string | null;
    };

const SHA256_RE = /^[0-9a-f]{64}$/;
const TOP_KEYS = ["schema_version", "generated_from", "entries", "preferred_task_id"];
const ENTRY_KEYS = ["path", "kind", "why", "revision"];
const SOURCE_KEYS = ["path", "sha256"];

const invalid = (why: string): StageReadsLoad => ({
  status: "invalid",
  reasons: [`${STAGE_READS_REL} 不可用：${why}`],
});

/** 当前内容的 sha256；读不到/超上限返回 null（由调用方按自己的口径报） */
function sha256OfFile(abs: string): string | null {
  try {
    const st = fs.statSync(abs);
    if (!st.isFile() || st.size > STAGE_READS_MAX_FILE_BYTES) return null;
    return crypto.createHash("sha256").update(fs.readFileSync(abs)).digest("hex");
  } catch {
    return null;
  }
}

/**
 * 检出 JSON 文本里的**重复键**（同一对象里同一个键出现两次）。
 * `JSON.parse` 对重复键静默保留最后一个——配置里"写了两次"必须显式拒绝，不许悄悄生效。
 * 键**按 JSON 字符串语义解码后**再比（`"schema_version"` 与 `"\u0073chema_version"` 是同一个键；
 * 只比原文会让转义写法成为绕过口，2026-09-30 按对端探针 `root-stage-review-o7ur1t/` 收口）。
 * 只扫结构、不做语法校验（语法已由先跑的 `JSON.parse` 判过；结构异常时返回 null 交给解析器）。
 */
export function findDuplicateKey(text: string): string | null {
  let i = 0;
  const skipWs = (): void => {
    while (i < text.length && /\s/.test(text[i] as string)) i += 1;
  };
  const readString = (): string => {
    i += 1;
    let out = "";
    while (i < text.length) {
      const ch = text[i] as string;
      if (ch === "\\") {
        const esc = text[i + 1] as string;
        if (esc === "u") {
          const hex = text.slice(i + 2, i + 6);
          const code = Number.parseInt(hex, 16);
          out += Number.isNaN(code) ? `\\u${hex}` : String.fromCharCode(code);
          i += 6;
          continue;
        }
        const escapes: Record<string, string> = {
          '"': '"',
          "\\": "\\",
          "/": "/",
          b: "\b",
          f: "\f",
          n: "\n",
          r: "\r",
          t: "\t",
        };
        out += escapes[esc] ?? esc;
        i += 2;
        continue;
      }
      if (ch === '"') {
        i += 1;
        return out;
      }
      out += ch;
      i += 1;
    }
    return out;
  };
  const scanValue = (label: string): string | null => {
    skipWs();
    const ch = text[i];
    if (ch === '"') {
      readString();
      return null;
    }
    if (ch === "{") {
      i += 1;
      skipWs();
      const seen = new Set<string>();
      if (text[i] === "}") {
        i += 1;
        return null;
      }
      for (;;) {
        skipWs();
        const key = readString();
        if (seen.has(key)) return label === "" ? key : `${label}.${key}`;
        seen.add(key);
        skipWs();
        if (text[i] !== ":") return null;
        i += 1;
        const dup = scanValue(label === "" ? key : `${label}.${key}`);
        if (dup !== null) return dup;
        skipWs();
        if (text[i] === ",") {
          i += 1;
          continue;
        }
        if (text[i] === "}") {
          i += 1;
          return null;
        }
        return null;
      }
    }
    if (ch === "[") {
      i += 1;
      skipWs();
      if (text[i] === "]") {
        i += 1;
        return null;
      }
      let index = 0;
      for (;;) {
        const dup = scanValue(`${label}[${index}]`);
        if (dup !== null) return dup;
        index += 1;
        skipWs();
        if (text[i] === ",") {
          i += 1;
          continue;
        }
        if (text[i] === "]") {
          i += 1;
          return null;
        }
        return null;
      }
    }
    while (i < text.length && !/[,\]}\s]/.test(text[i] as string)) i += 1;
    return null;
  };
  return scanValue("");
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** 顶层/条目对象只认白名单键：多一个键少一个键都拒（不静默忽略写错的字段名） */
function unknownKeys(obj: Record<string, unknown>, allowed: readonly string[]): string[] {
  return Object.keys(obj).filter((k) => !allowed.includes(k));
}

/**
 * 读并校验 `<项目根>/.工作台/work/stage-reads.json`（只读，不抛错）。
 * - 文件不存在 → `absent`（老项目完全兼容；**不**加"缺文件"理由）；
 * - 文件存在但不合法 → `invalid`（入口据此 `blocked`，绝不静默派活）；
 * - 合法 → `ok`（每条来源/条目的哈希都已经与当前内容核对过）。
 */
export function loadStageReads(projectRoot: string): StageReadsLoad {
  const root = path.resolve(projectRoot);
  const resolved = resolveProjectRelative(root, STAGE_READS_REL);
  if (!resolved.ok) {
    return invalid(`指针路径不合法（${resolved.reason}：${STAGE_READS_REL} 必须在项目根内且不经软链逃逸）`);
  }
  const file = resolved.abs;
  if (!fs.existsSync(file)) return { status: "absent" };
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch (e) {
    return invalid(`读不到文件（${e instanceof Error ? e.message : String(e)}）`);
  }
  if (!stat.isFile()) return invalid("不是常规文件（目录/设备文件都不算指针）");
  if (stat.size > STAGE_READS_MAX_BYTES) {
    return invalid(`文件过大（${stat.size} 字节 > 上限 ${STAGE_READS_MAX_BYTES} 字节）`);
  }
  const text = fs.readFileSync(file, "utf8");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return invalid(`不是合法 JSON（${e instanceof Error ? e.message : String(e)}）`);
  }
  const dupKey = findDuplicateKey(text);
  if (dupKey !== null) return invalid(`有重复字段「${dupKey}」：同一对象的键不许写两次`);
  if (!isPlainObject(raw)) return invalid("顶层必须是 JSON 对象");
  const extraTop = unknownKeys(raw, TOP_KEYS);
  if (extraTop.length > 0) return invalid(`顶层有未知字段：${extraTop.join("、")}（只认 ${TOP_KEYS.join("/")}）`);
  if (raw.schema_version !== STAGE_READS_SCHEMA_VERSION) {
    return invalid(`schema_version 必须是 ${STAGE_READS_SCHEMA_VERSION}，收到 ${JSON.stringify(raw.schema_version)}`);
  }

  // ── 来源声明：逐条核对"生成时的哈希"与"当前内容" ──
  if (!Array.isArray(raw.generated_from) || raw.generated_from.length === 0) {
    return invalid("generated_from 必须是非空数组（列明本指针由哪些原文派生）");
  }
  const sources: StageReadSource[] = [];
  const seenSourcePaths = new Set<string>();
  for (const item of raw.generated_from) {
    if (!isPlainObject(item)) return invalid("generated_from 的每一项必须是对象");
    const extra = unknownKeys(item, SOURCE_KEYS);
    if (extra.length > 0) return invalid(`generated_from 条目有未知字段：${extra.join("、")}`);
    if (typeof item.path !== "string" || item.path.trim() === "") {
      return invalid(`generated_from 的 path 必须是非空字符串，收到 ${JSON.stringify(item.path)}`);
    }
    if (typeof item.sha256 !== "string" || !SHA256_RE.test(item.sha256)) {
      return invalid(`generated_from 的 sha256 必须是 64 位小写十六进制，收到 ${JSON.stringify(item.sha256)}`);
    }
    const rel = item.path.trim();
    if (seenSourcePaths.has(rel)) return invalid(`generated_from 里 ${rel} 出现了两次（重复字段）`);
    seenSourcePaths.add(rel);
    const guard = resolveProjectRelative(root, rel);
    if (!guard.ok) {
      return invalid(`generated_from 的来源 ${rel} 路径不合法（${guard.reason}）`);
    }
    if (!fs.existsSync(guard.abs)) {
      return invalid(`generated_from 的来源 ${rel} 不存在：来源缺失就拒发，不按旧口径派活`);
    }
    const actual = sha256OfFile(guard.abs);
    if (actual === null) return invalid(`generated_from 的来源 ${rel} 读不到或过大（不能当作合来源）`);
    if (actual !== item.sha256) {
      return invalid(
        `generated_from 的来源 ${rel} 已漂移：生成时 sha256=${item.sha256.slice(0, 12)}…，当前=${actual.slice(0, 12)}…（来源改过就拒发，指针要重新生成）`,
      );
    }
    sources.push({ path: rel, sha256: item.sha256 });
  }

  // ── 必读条目：路径安全/存在/哈希、kind 白名单、why 必填、path 不重复 ──
  if (!Array.isArray(raw.entries) || raw.entries.length === 0) {
    return invalid("entries 必须是非空数组（这一阶段的必读原文逐条列出）");
  }
  const entries: StageReadEntry[] = [];
  const seenEntryPaths = new Set<string>();
  for (const item of raw.entries) {
    if (!isPlainObject(item)) return invalid("entries 的每一项必须是对象");
    const extra = unknownKeys(item, ENTRY_KEYS);
    if (extra.length > 0) return invalid(`entries 条目有未知字段：${extra.join("、")}`);
    if (typeof item.path !== "string" || item.path.trim() === "") {
      return invalid(`entries 的 path 必须是非空字符串，收到 ${JSON.stringify(item.path)}`);
    }
    const rel = item.path.trim();
    if (seenEntryPaths.has(rel)) return invalid(`entries 里 ${rel} 出现了两次（重复字段）`);
    seenEntryPaths.add(rel);
    if (typeof item.kind !== "string" || !(STAGE_READ_KINDS as readonly string[]).includes(item.kind)) {
      return invalid(
        `entries 的 kind 必须是 ${STAGE_READ_KINDS.join("/")} 之一，收到 ${JSON.stringify(item.kind)}（不发明新枚举）`,
      );
    }
    if (typeof item.why !== "string" || item.why.trim() === "") {
      return invalid(`entries 的 why 必须说清"为什么这一阶段必读它"，收到 ${JSON.stringify(item.why)}`);
    }
    let revision: string | null = null;
    if (item.revision !== undefined) {
      if (typeof item.revision !== "string" || !SHA256_RE.test(item.revision)) {
        return invalid(`entries 的 revision 给了就必须是 64 位小写十六进制，收到 ${JSON.stringify(item.revision)}`);
      }
      revision = item.revision;
    }
    const guard = resolveProjectRelative(root, rel);
    if (!guard.ok) return invalid(`entries 的 ${rel} 路径不合法（${guard.reason}）`);
    if (!fs.existsSync(guard.abs)) {
      return invalid(`entries 的 ${rel} 不存在：必读原文缺失就拒发，不按旧口径派活`);
    }
    const actual = sha256OfFile(guard.abs);
    if (actual === null) return invalid(`entries 的 ${rel} 读不到或过大（不能当作必读原文）`);
    if (revision !== null && revision !== actual) {
      return invalid(
        `entries 的 ${rel} 已漂移：声明 revision=${revision.slice(0, 12)}…，当前=${actual.slice(0, 12)}…（来源改过就拒发）`,
      );
    }
    entries.push({ path: rel, kind: item.kind as StageReadKind, why: item.why.trim(), revision });
  }

  // ── 优选卡（可选；只是候选内的提示，不构成授权） ──
  let preferred: string | null = null;
  if (raw.preferred_task_id !== undefined && raw.preferred_task_id !== null) {
    if (typeof raw.preferred_task_id !== "string" || raw.preferred_task_id.trim() === "") {
      return invalid(`preferred_task_id 给了就必须是非空字符串，收到 ${JSON.stringify(raw.preferred_task_id)}`);
    }
    preferred = raw.preferred_task_id.trim();
  }

  return { status: "ok", rel_path: STAGE_READS_REL, generated_from: sources, entries, preferred_task_id: preferred };
}
