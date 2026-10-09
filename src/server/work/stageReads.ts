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
import { markdownSectionDigest, sectionSelectorProblem } from "../../shared/materialSection";

/** 配置文件（项目根内相对路径；与 `.工作台/work/budget.json` 同层同类） */
export const STAGE_READS_FILE = "stage-reads.json";
export const STAGE_READS_REL = `.工作台/work/${STAGE_READS_FILE}`;

/** v1：唯一认的 schema 版本；v1 的条目/来源只能整文件哈希（逐字节，逐条严格如旧）。 */
export const STAGE_READS_SCHEMA_VERSION = 1;
/** v2（V09-42）：`generated_from`/`entries` 可显式点名 Markdown 章节，哈希覆盖标题及子树。 */
export const STAGE_READS_SCHEMA_VERSION_V2 = 2;
/** 两个版本都认；转格式仍要显式（不认识的值一律拒，不靠猜）。 */
export const STAGE_READS_SCHEMA_VERSIONS = [STAGE_READS_SCHEMA_VERSION, STAGE_READS_SCHEMA_VERSION_V2] as const;

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
  /**
   * v2 可选：完整标题路径（Markdown 章节）。给了就对该章节「标题行 + 全部后代」算 `sha256`；
   * 不给 = 整文件原始字节（v1 口径）。本节哈希口径见 shared/materialSection.ts。
   */
  section?: string;
}

export interface StageReadEntry {
  /** 项目根内相对路径 */
  path: string;
  kind: StageReadKind;
  why: string;
  /** 可选：生成时的内容 sha256；给了就必须等于当前值（无 section=整文件字节；有 section=章节子树） */
  revision: string | null;
  /** v2 可选：完整标题路径（Markdown 章节）；语义同 `StageReadSource.section` */
  section?: string;
  /**
   * **派生字段，不是指针 JSON 里的键**（指针里写 `range` 一律按未知字段拒）：该章节在**当前**文档里的
   * 起止行（1 基闭区间，标题行 → 子树末行），随当前解析现算、不保存行号——供执行方按 `path`+`range`
   * 原样读回标题与整棵子树（章节外插入行只改行号、不改内容）。
   */
  range?: { start: number; end: number };
}

export type StageReadsLoad =
  | { status: "absent" }
  | { status: "invalid"; reasons: string[] }
  | {
      status: "ok";
      /** 生效的 schema 版本（1=整文件；2=可点名章节） */
      schema_version: number;
      rel_path: string;
      generated_from: StageReadSource[];
      entries: StageReadEntry[];
      preferred_task_id: string | null;
    };

const SHA256_RE = /^[0-9a-f]{64}$/;
const TOP_KEYS = ["schema_version", "generated_from", "entries", "preferred_task_id"];
const ENTRY_KEYS = ["path", "kind", "why", "revision"];
const SOURCE_KEYS = ["path", "sha256"];
/** v2 才允许的额外键（v1 里出现就是未知字段，逐条严格如旧） */
const ENTRY_KEYS_V2 = ["path", "kind", "why", "revision", "section"];
const SOURCE_KEYS_V2 = ["path", "sha256", "section"];

const invalid = (why: string): StageReadsLoad => ({
  status: "invalid",
  reasons: [`${STAGE_READS_REL} 不可用：${why}`],
});

/**
 * 目标文件的当前摘要。无 section = 整文件原始字节；有 section = 该 Markdown 章节子树（见 materialSection.ts）。
 * `range`（仅 section 时非 null）= 该章节在**当前**文档里的起止行（1 基闭区间，标题行 → 子树末行）——
 * 让它成为执行方按 `path`+`range` 直接读回标题与整棵子树的**派生**定位，而不是把 `section` 转传给
 * `read_design`/`read_plan` 那套另一口径的分段参数。
 */
export type StageReadTargetDigest =
  | { ok: true; sha256: string; range: { start: number; end: number } | null }
  | { ok: false; reason: string };

/**
 * 现读目标并算摘要——**不缓存、不看 mtime**：正文改一个字节（哪怕 mtime 被还原）哈希就变。
 * 读不到/非文件/超上限/非文本/章节缺失或重复都返回明确原因（调用方按 fail-closed 拒）。
 */
export function stageReadTargetDigest(abs: string, section: string | null): StageReadTargetDigest {
  let st: fs.Stats;
  try {
    st = fs.statSync(abs);
  } catch (e) {
    return { ok: false, reason: `读不到（${e instanceof Error ? e.message : String(e)}）` };
  }
  if (!st.isFile()) return { ok: false, reason: "不是常规文件（目录/设备文件都不算必读原文）" };
  if (st.size > STAGE_READS_MAX_FILE_BYTES) return { ok: false, reason: `超过读取上限 ${STAGE_READS_MAX_FILE_BYTES} 字节` };
  let buf: Buffer;
  try {
    buf = fs.readFileSync(abs);
  } catch (e) {
    return { ok: false, reason: `读不到（${e instanceof Error ? e.message : String(e)}）` };
  }
  if (section === null) return { ok: true, sha256: crypto.createHash("sha256").update(buf).digest("hex"), range: null };
  const d = markdownSectionDigest(buf, section);
  if (!d.ok) return { ok: false, reason: `章节 ${JSON.stringify(section)} 不可用：${d.reason}` };
  return { ok: true, sha256: d.sha256, range: { start: d.section.line_start, end: d.section.line_end } };
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
 * 校验一份**已解析**的阶段必读指针对象（`loadStageReads` 与机械生成脚本共用同一判据——一事一源）。
 * - `rawText` 给了就加重复键检查（脚本自校验时没有原文可传）；
 * - v1 判据与旧实现逐条同款；v2 在来源/条目上多认一个可选 `section`（完整标题路径，见 materialSection.ts）。
 */
export function validateStageReadsObject(raw: unknown, projectRoot: string, rawText?: string): StageReadsLoad {
  const root = path.resolve(projectRoot);
  if (rawText !== undefined) {
    const dupKey = findDuplicateKey(rawText);
    if (dupKey !== null) return invalid(`有重复字段「${dupKey}」：同一对象的键不许写两次`);
  }
  if (!isPlainObject(raw)) return invalid("顶层必须是 JSON 对象");
  const extraTop = unknownKeys(raw, TOP_KEYS);
  if (extraTop.length > 0) return invalid(`顶层有未知字段：${extraTop.join("、")}（只认 ${TOP_KEYS.join("/")}）`);
  const version = raw.schema_version;
  if (version !== STAGE_READS_SCHEMA_VERSION && version !== STAGE_READS_SCHEMA_VERSION_V2) {
    return invalid(`schema_version 必须是 ${STAGE_READS_SCHEMA_VERSIONS.join(" 或 ")}，收到 ${JSON.stringify(version)}`);
  }
  const isV2 = version === STAGE_READS_SCHEMA_VERSION_V2;
  const entryKeys = isV2 ? ENTRY_KEYS_V2 : ENTRY_KEYS;
  const sourceKeys = isV2 ? SOURCE_KEYS_V2 : SOURCE_KEYS;

  // 同一次 load 内按 (绝对路径, section) 复用同次摘要：来源与条目指向同一文件同一节时**不重复读盘**。
  // 每次 load 都是新缓存（现读现算），不跨调用缓存——正文改过仍照哈希判失效。
  const digestCache = new Map<string, StageReadTargetDigest>();
  const digestOf = (abs: string, section: string | null): StageReadTargetDigest => {
    const key = `${abs}\u0000${section ?? ""}`;
    const hit = digestCache.get(key);
    if (hit !== undefined) return hit;
    const d = stageReadTargetDigest(abs, section);
    digestCache.set(key, d);
    return d;
  };

  /** 取可选 section：非 v2 不允许（由 unknownKeys 先拦）；非法类型/控制字符/超长一律拒。 */
  const sectionOf = (item: Record<string, unknown>, where: string): { ok: true; section: string | null } | { ok: false; reason: string } => {
    if (item.section === undefined) return { ok: true, section: null };
    const problem = sectionSelectorProblem(item.section);
    if (problem !== null) return { ok: false, reason: `${where} 的 ${problem}` };
    return { ok: true, section: (item.section as string).trim() };
  };

  // ── 来源声明：逐条核对"生成时的哈希"与"当前内容"（有 section 就核对章节子树） ──
  if (!Array.isArray(raw.generated_from) || raw.generated_from.length === 0) {
    return invalid("generated_from 必须是非空数组（列明本指针由哪些原文派生）");
  }
  const sources: StageReadSource[] = [];
  const seenSources = new Set<string>();
  for (const item of raw.generated_from) {
    if (!isPlainObject(item)) return invalid("generated_from 的每一项必须是对象");
    const extra = unknownKeys(item, sourceKeys);
    if (extra.length > 0) {
      return invalid(
        `generated_from 条目有未知字段：${extra.join("、")}${isV2 ? "" : "（v1 条目只认 path/sha256；要点名 Markdown 章节需 schema_version=2）"}`,
      );
    }
    if (typeof item.path !== "string" || item.path.trim() === "") {
      return invalid(`generated_from 的 path 必须是非空字符串，收到 ${JSON.stringify(item.path)}`);
    }
    if (typeof item.sha256 !== "string" || !SHA256_RE.test(item.sha256)) {
      return invalid(`generated_from 的 sha256 必须是 64 位小写十六进制，收到 ${JSON.stringify(item.sha256)}`);
    }
    const rel = item.path.trim();
    const sec = sectionOf(item, `generated_from 的 ${rel}`);
    if (!sec.ok) return invalid(sec.reason);
    const key = `${rel}\u0000${sec.section ?? ""}`;
    if (seenSources.has(key)) {
      return invalid(`generated_from 里 ${rel}${sec.section === null ? "" : `（章节 ${JSON.stringify(sec.section)}）`} 出现了两次（重复字段）`);
    }
    seenSources.add(key);
    const guard = resolveProjectRelative(root, rel);
    if (!guard.ok) {
      return invalid(`generated_from 的来源 ${rel} 路径不合法（${guard.reason}）`);
    }
    if (!fs.existsSync(guard.abs)) {
      return invalid(`generated_from 的来源 ${rel} 不存在：来源缺失就拒发，不按旧口径派活`);
    }
    const dig = digestOf(guard.abs, sec.section);
    if (!dig.ok) return invalid(`generated_from 的来源 ${rel} ${dig.reason}（不能当作合法来源）`);
    if (dig.sha256 !== item.sha256) {
      const scope = sec.section === null ? "" : `（章节 ${JSON.stringify(sec.section)}）`;
      return invalid(
        `generated_from 的来源 ${rel}${scope} 已漂移：生成时 sha256=${item.sha256.slice(0, 12)}…，当前=${dig.sha256.slice(0, 12)}…（来源改过就拒发，指针要重新生成）`,
      );
    }
    const out: StageReadSource = { path: rel, sha256: item.sha256 };
    if (sec.section !== null) out.section = sec.section;
    sources.push(out);
  }

  // ── 必读条目：路径安全/存在/哈希、kind 白名单、why 必填、重复拒绝（重复按 path+section） ──
  if (!Array.isArray(raw.entries) || raw.entries.length === 0) {
    return invalid("entries 必须是非空数组（这一阶段的必读原文逐条列出）");
  }
  const entries: StageReadEntry[] = [];
  const seenEntries = new Set<string>();
  for (const item of raw.entries) {
    if (!isPlainObject(item)) return invalid("entries 的每一项必须是对象");
    const extra = unknownKeys(item, entryKeys);
    if (extra.length > 0) {
      return invalid(
        `entries 条目有未知字段：${extra.join("、")}${isV2 ? "" : "（v1 条目只认 path/kind/why/revision；要点名 Markdown 章节需 schema_version=2）"}`,
      );
    }
    if (typeof item.path !== "string" || item.path.trim() === "") {
      return invalid(`entries 的 path 必须是非空字符串，收到 ${JSON.stringify(item.path)}`);
    }
    const rel = item.path.trim();
    const sec = sectionOf(item, `entries 的 ${rel}`);
    if (!sec.ok) return invalid(sec.reason);
    const key = `${rel}\u0000${sec.section ?? ""}`;
    if (seenEntries.has(key)) {
      return invalid(`entries 里 ${rel}${sec.section === null ? "" : `（章节 ${JSON.stringify(sec.section)}）`} 出现了两次（重复字段）`);
    }
    seenEntries.add(key);
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
    const dig = digestOf(guard.abs, sec.section);
    if (!dig.ok) return invalid(`entries 的 ${rel} ${dig.reason}（不能当作必读原文）`);
    if (revision !== null && revision !== dig.sha256) {
      const scope = sec.section === null ? "" : `（章节 ${JSON.stringify(sec.section)}）`;
      return invalid(
        `entries 的 ${rel}${scope} 已漂移：声明 revision=${revision.slice(0, 12)}…，当前=${dig.sha256.slice(0, 12)}…（来源改过就拒发）`,
      );
    }
    const out: StageReadEntry = { path: rel, kind: item.kind as StageReadKind, why: item.why.trim(), revision };
    if (sec.section !== null) {
      out.section = sec.section;
      // 派生携带 range（不写回指针 JSON）：供执行方按 path+range 原样读标题+整棵子树。
      if (dig.range !== null) out.range = dig.range;
    }
    entries.push(out);
  }

  // ── 优选卡（可选；只是候选内的提示，不构成授权） ──
  let preferred: string | null = null;
  if (raw.preferred_task_id !== undefined && raw.preferred_task_id !== null) {
    if (typeof raw.preferred_task_id !== "string" || raw.preferred_task_id.trim() === "") {
      return invalid(`preferred_task_id 给了就必须是非空字符串，收到 ${JSON.stringify(raw.preferred_task_id)}`);
    }
    preferred = raw.preferred_task_id.trim();
  }

  return {
    status: "ok",
    schema_version: version as number,
    rel_path: STAGE_READS_REL,
    generated_from: sources,
    entries,
    preferred_task_id: preferred,
  };
}

/**
 * 读并校验 `<项目根>/.工作台/work/stage-reads.json`（只读，不抛错）。
 * - 文件不存在 → `absent`（老项目完全兼容；**不**加"缺文件"理由）；
 * - 文件存在但不合法 → `invalid`（入口据此 `blocked`，绝不静默派活）；
 * - 合法 → `ok`（每条来源/条目的哈希都已经与当前内容核对过；v2 的 section 按章节子树核对）。
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
  return validateStageReadsObject(raw, root, text);
}
