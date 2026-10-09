// 阶段必读指针（`.工作台/work/stage-reads.json`）的**机械生成与校验**（V09-42；docs/efficiency-20261004.md 第 2 条）。
//
// 它干什么：读一份**显式配置模板**（只写"哪些原文、哪一节、kind、why、preferred_task_id"），
// **现读每个来源的当前正文**算出 sha256/revision，组装出合法指针；`--write` 时按 **CAS** 原子写盘。
//
// 它**不**干什么（与调用方的边界）：
//   · 不推断任务、不推断授权、不读事件账本、不决定下一个动作——任务与授权是另一个入口的事；
//   · 不自动接受来源漂移、**不自行刷新旧漂移文件**：`--check` 只校验不写盘；`--write` 必须显式给出
//     期望的旧文件版本（`--expected-sha256`，首次创建写 `absent`），对不上就拒写；
//   · 不删除旧必需项、不改其它任何文件。
//
// ── 并发与原子性（协作写者）──
//   `--write` 先取**独占锁**（`<目标>.lock`，`open(..., "wx")`）再写，协作写者之间串行：
//     取不到锁（EEXIST）→ 直接拒写、**绝不自动删别人的锁**（锁持有者可能正写到一半）；
//     锁内**重读**目标旧版本做 CAS，写临时文件后**临近 rename 再核一次**来源 validate 与旧 hash，
//     两者任一变了就放弃改名——**原文件保持不变**、只清掉自己的临时文件；finally 释放自己的锁。
//   **边界（如实声明）**：本锁只对"走本脚本的协作写者"生效。**非协作的手写**（人/别的工具直接改
//     `stage-reads.json`）不受此锁保护，本脚本**不承诺**与它们的原子 CAS——那种情况靠"写前重核 +
//     临近 rename 再核"尽量收窄，但**不是**数据库级事务保证。同样，进程崩溃会留下死锁文件，
//     本脚本**不自动清理**（无法证明持有者已退出）；确认锁持有者已退出后由人核实并手动删除。
//
// 用法：
//   pnpm tsx scripts/prepare-stage-reads.ts --project-root <项目根> --config <模板.json>            # 默认 --check，只校验
//   pnpm tsx scripts/prepare-stage-reads.ts --project-root <项目根> --config <模板.json> \
//       --write --expected-sha256 <当前 stage-reads.json 的 sha256 | absent>                      # 原子写 + CAS
//
// 模板（顶层闭键）：schema_version(1|2)、preferred_task_id、generated_from、entries
//   · generated_from[]  : { path, section? }        —— 不给 section = 整文件；给 = 该 Markdown 章节子树
//   · entries[]         : { path, kind, why, section?, pin_revision? }
//       pin_revision（**仅 v2**，可选 boolean，默认 true）：true = 生成物绑定该条目的 revision
//       （当前整文件/章节哈希）；false = **显式省略**产物 revision——该条目只核路径存在/安全/可解码/
//       章节可唯一定位，不核内容哈希，用于动态当前进度/导航这类实时必读（只追加进度不该重新冻结整份文档）。
//   · generated_from **不允许** pin_revision：来源 sha256 始终必填（稳定规则/授权/技术决定继续绑定）。
//   · 模板里**不许**出现 sha256 / revision（哈希一律现读来源生成，手写值只会被拒）。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { findDuplicateKey, STAGE_READS_REL, STAGE_READS_SCHEMA_VERSION, STAGE_READS_SCHEMA_VERSION_V2, stageReadTargetDigest, validateStageReadsObject } from "../src/server/work/stageReads";
import { resolveProjectRelative } from "../src/server/work/documents";
import { sectionSelectorProblem } from "../src/shared/materialSection";

export interface PrepareOptions {
  projectRoot: string;
  configPath: string;
  write: boolean;
  /** `--write` 必填；`absent` = 目标文件当前不存在；否则必须是目标文件当前字节的 sha256 */
  expectedSha256: string | null;
}

export interface PrepareOutcome {
  code: number;
  lines: string[];
  wrote: boolean;
  /** 写盘/生成的指针内容 sha256；未生成成功为 null */
  target_sha256: string | null;
  /** 生成出的合法指针（校验通过时） */
  generated: unknown | null;
}

const sha256Hex = (data: string | Buffer): string => crypto.createHash("sha256").update(data).digest("hex");
const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const unknownKeys = (obj: Record<string, unknown>, allowed: readonly string[]): string[] => Object.keys(obj).filter((k) => !allowed.includes(k));

const TOP_KEYS = ["schema_version", "preferred_task_id", "generated_from", "entries"];

/** 模板解析结果（坏模板一律致命，不猜） */
type TemplateParse =
  | {
      ok: true;
      schema_version: number;
      preferred_task_id: string | null;
      sources: { path: string; section: string | null }[];
      entries: { path: string; kind: string; why: string; section: string | null; pin_revision: boolean }[];
    }
  | { ok: false; reason: string };

function parseTemplate(raw: unknown, rawText: string): TemplateParse {
  const dup = findDuplicateKey(rawText);
  if (dup !== null) return { ok: false, reason: `模板有重复字段「${dup}」：同一对象的键不许写两次` };
  if (!isPlainObject(raw)) return { ok: false, reason: "模板顶层必须是 JSON 对象" };
  const extra = unknownKeys(raw, TOP_KEYS);
  if (extra.length > 0) return { ok: false, reason: `模板顶层有未知字段：${extra.join("、")}（只认 ${TOP_KEYS.join("/")}）` };
  const version = raw.schema_version;
  if (version !== STAGE_READS_SCHEMA_VERSION && version !== STAGE_READS_SCHEMA_VERSION_V2) {
    return { ok: false, reason: `模板 schema_version 必须是 ${STAGE_READS_SCHEMA_VERSION} 或 ${STAGE_READS_SCHEMA_VERSION_V2}，收到 ${JSON.stringify(version)}` };
  }
  const isV2 = version === STAGE_READS_SCHEMA_VERSION_V2;
  const srcKeys = isV2 ? ["path", "section"] : ["path"];
  const entryKeys = isV2 ? ["path", "kind", "why", "section", "pin_revision"] : ["path", "kind", "why"];
  const takeSection = (item: Record<string, unknown>, where: string): { ok: true; section: string | null } | { ok: false; reason: string } => {
    if (item.section === undefined) return { ok: true, section: null };
    const p = sectionSelectorProblem(item.section);
    if (p !== null) return { ok: false, reason: `${where} 的 ${p}` };
    return { ok: true, section: (item.section as string).trim() };
  };
  const text = (v: unknown, where: string): { ok: true; value: string } | { ok: false; reason: string } =>
    typeof v === "string" && v.trim() !== "" ? { ok: true, value: v.trim() } : { ok: false, reason: `${where} 必须是非空字符串，收到 ${JSON.stringify(v)}` };

  let preferred: string | null = null;
  if (raw.preferred_task_id !== undefined && raw.preferred_task_id !== null) {
    const t = text(raw.preferred_task_id, "preferred_task_id");
    if (!t.ok) return { ok: false, reason: t.reason };
    preferred = t.value;
  }

  if (!Array.isArray(raw.generated_from) || raw.generated_from.length === 0) return { ok: false, reason: "generated_from 必须是非空数组" };
  const sources: { path: string; section: string | null }[] = [];
  for (const item of raw.generated_from) {
    if (!isPlainObject(item)) return { ok: false, reason: "generated_from 的每一项必须是对象" };
    const ex = unknownKeys(item, srcKeys);
    if (ex.length > 0) {
      return { ok: false, reason: `generated_from 条目有未知字段：${ex.join("、")}（模板里不许手写 sha256；哈希现读来源生成${isV2 ? "" : "；v1 模板只认 path"}）` };
    }
    const p = text(item.path, "generated_from.path");
    if (!p.ok) return { ok: false, reason: p.reason };
    const s = takeSection(item, `generated_from 的 ${p.value}`);
    if (!s.ok) return { ok: false, reason: s.reason };
    sources.push({ path: p.value, section: s.section });
  }

  if (!Array.isArray(raw.entries) || raw.entries.length === 0) return { ok: false, reason: "entries 必须是非空数组" };
  const entries: { path: string; kind: string; why: string; section: string | null; pin_revision: boolean }[] = [];
  for (const item of raw.entries) {
    if (!isPlainObject(item)) return { ok: false, reason: "entries 的每一项必须是对象" };
    const ex = unknownKeys(item, entryKeys);
    if (ex.length > 0) {
      return { ok: false, reason: `entries 条目有未知字段：${ex.join("、")}（模板里不许手写 revision；哈希现读来源生成${isV2 ? "" : "；v1 模板只认 path/kind/why"}）` };
    }
    const p = text(item.path, "entries.path");
    if (!p.ok) return { ok: false, reason: p.reason };
    const k = text(item.kind, `entries(${p.value}).kind`);
    if (!k.ok) return { ok: false, reason: k.reason };
    const w = text(item.why, `entries(${p.value}).why`);
    if (!w.ok) return { ok: false, reason: w.reason };
    const s = takeSection(item, `entries 的 ${p.value}`);
    if (!s.ok) return { ok: false, reason: s.reason };
    let pin = true;
    if (item.pin_revision !== undefined) {
      // 仅 v2 允许（v1 由 unknownKeys 先拦）；必须是布尔，默认 true。
      if (typeof item.pin_revision !== "boolean") {
        return { ok: false, reason: `entries(${p.value}).pin_revision 必须是 true/false，收到 ${JSON.stringify(item.pin_revision)}（省略=默认绑定 revision）` };
      }
      pin = item.pin_revision;
    }
    entries.push({ path: p.value, kind: k.value, why: w.value, section: s.section, pin_revision: pin });
  }
  return { ok: true, schema_version: version, preferred_task_id: preferred, sources, entries };
}

/** 现读来源生成 hash/revision，组装指针对象（不含任何手写哈希）。 */
function buildPointer(tpl: Extract<TemplateParse, { ok: true }>, root: string): { ok: true; pointer: Record<string, unknown> } | { ok: false; reason: string } {
  // 同一次生成内按 (绝对路径, section) 复用同次摘要：同一文件被来源与条目同时点名时不重复读盘。
  const digestCache = new Map<string, ReturnType<typeof stageReadTargetDigest>>();
  const digestOf = (abs: string, section: string | null): ReturnType<typeof stageReadTargetDigest> => {
    const key = `${abs}\u0000${section ?? ""}`;
    const hit = digestCache.get(key);
    if (hit !== undefined) return hit;
    const d = stageReadTargetDigest(abs, section);
    digestCache.set(key, d);
    return d;
  };
  const generated_from: Record<string, unknown>[] = [];
  for (const s of tpl.sources) {
    const guard = resolveProjectRelative(root, s.path);
    if (!guard.ok) return { ok: false, reason: `generated_from 的来源 ${s.path} 路径不合法（${guard.reason}）` };
    if (!fs.existsSync(guard.abs)) return { ok: false, reason: `generated_from 的来源 ${s.path} 不存在` };
    const dig = digestOf(guard.abs, s.section);
    if (!dig.ok) return { ok: false, reason: `generated_from 的来源 ${s.path} ${dig.reason}` };
    const row: Record<string, unknown> = { path: s.path, sha256: dig.sha256 };
    if (s.section !== null) row.section = s.section;
    generated_from.push(row);
  }
  const entries: Record<string, unknown>[] = [];
  for (const e of tpl.entries) {
    const guard = resolveProjectRelative(root, e.path);
    if (!guard.ok) return { ok: false, reason: `entries 的 ${e.path} 路径不合法（${guard.reason}）` };
    if (!fs.existsSync(guard.abs)) return { ok: false, reason: `entries 的 ${e.path} 不存在` };
    const dig = digestOf(guard.abs, e.section);
    if (!dig.ok) return { ok: false, reason: `entries 的 ${e.path} ${dig.reason}` };
    const row: Record<string, unknown> = { path: e.path, kind: e.kind, why: e.why };
    if (e.pin_revision) row.revision = dig.sha256;
    if (e.section !== null) row.section = e.section;
    entries.push(row);
  }
  return { ok: true, pointer: { schema_version: tpl.schema_version, generated_from, entries, preferred_task_id: tpl.preferred_task_id } };
}

/** 目标指针文件的项目根内绝对路径（经软链逃逸判定） */
function targetAbs(root: string): { ok: true; abs: string } | { ok: false; reason: string } {
  const guard = resolveProjectRelative(root, STAGE_READS_REL);
  return guard.ok ? { ok: true, abs: guard.abs } : { ok: false, reason: guard.reason };
}

/** 协作写者独占锁的项目根内绝对路径（= 目标路径 + `.lock`；仅对走本脚本的写者生效）。 */
export function stageReadsLockAbs(projectRoot: string): { ok: true; abs: string } | { ok: false; reason: string } {
  const tgt = targetAbs(path.resolve(projectRoot));
  return tgt.ok ? { ok: true, abs: `${tgt.abs}.lock` } : tgt;
}

export function runPrepareStageReads(opts: PrepareOptions): PrepareOutcome {
  const lines: string[] = [];
  const root = path.resolve(opts.projectRoot);
  if (!fs.existsSync(opts.configPath)) return { code: 1, lines: [`模板不存在：${opts.configPath}`], wrote: false, target_sha256: null, generated: null };
  let raw: unknown;
  const rawText = fs.readFileSync(opts.configPath, "utf8");
  try {
    raw = JSON.parse(rawText);
  } catch (e) {
    return { code: 1, lines: [`模板不是合法 JSON：${e instanceof Error ? e.message : String(e)}`], wrote: false, target_sha256: null, generated: null };
  }
  const tpl = parseTemplate(raw, rawText);
  if (!tpl.ok) return { code: 1, lines: [`模板不合法：${tpl.reason}`], wrote: false, target_sha256: null, generated: null };

  const built = buildPointer(tpl, root);
  if (!built.ok) return { code: 1, lines: [`无法生成：${built.reason}`], wrote: false, target_sha256: null, generated: null };

  // 生成物必须能过同一份校验（与 loadStageReads 同判据）——不合法就绝不写盘。
  const validated = validateStageReadsObject(built.pointer, root);
  if (validated.status !== "ok") {
    const why = validated.status === "invalid" ? validated.reasons.join("；") : "校验返回 absent（不应发生）";
    return { code: 1, lines: [`生成物未通过校验（不写盘）：${why}`], wrote: false, target_sha256: null, generated: null };
  }

  const serialized = `${JSON.stringify(built.pointer, null, 2)}\n`;
  const digest = sha256Hex(Buffer.from(serialized, "utf8"));
  const tgt = targetAbs(root);
  if (!tgt.ok) return { code: 1, lines: [`目标路径不合法：${tgt.reason}`], wrote: false, target_sha256: digest, generated: built.pointer };

  const current = fs.existsSync(tgt.abs) ? sha256Hex(fs.readFileSync(tgt.abs)) : "absent";

  if (!opts.write) {
    // ── --check：只校验，不写盘 ──
    lines.push(`[check] 生成物校验通过，目标 ${STAGE_READS_REL}`);
    lines.push(`[check] 目标当前版本：${current === "absent" ? "absent（不存在）" : current}`);
    lines.push(`[check] 生成版本：${digest}`);
    if (current === digest) return { code: 0, lines, wrote: false, target_sha256: digest, generated: built.pointer };
    if (current === "absent") {
      lines.push("[check] 目标不存在：校验通过（要创建请用 --write --expected-sha256 absent）");
      return { code: 0, lines, wrote: false, target_sha256: digest, generated: built.pointer };
    }
    lines.push("[check] 当前指针与模板生成的指针不一致（check 不写盘；不自行刷新旧漂移文件）。要更新请用 --write --expected-sha256 " + current);
    return { code: 2, lines, wrote: false, target_sha256: digest, generated: built.pointer };
  }

  // ── --write：独占锁 + CAS + 原子写（协作写者串行；非协作手写不受锁保护，见文件头边界） ──
  if (opts.expectedSha256 === null || opts.expectedSha256.trim() === "") {
    return { code: 1, lines: ["--write 必须显式给 --expected-sha256（首次创建写 absent）：不自动接受漂移"], wrote: false, target_sha256: digest, generated: built.pointer };
  }
  const expected = opts.expectedSha256.trim().toLowerCase() === "absent" ? "absent" : opts.expectedSha256.trim().toLowerCase();
  const targetCurrent = (): string => (fs.existsSync(tgt.abs) ? sha256Hex(fs.readFileSync(tgt.abs)) : "absent");
  // 锁文件与临时文件同目录，先把目录建出来（不触碰任何已有文件）。
  fs.mkdirSync(path.dirname(tgt.abs), { recursive: true });
  const lockAbs = `${tgt.abs}.lock`;
  let lockFd: number | null = null;
  try {
    lockFd = fs.openSync(lockAbs, "wx");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      return {
        code: 1,
        lines: [`独占锁已被占用（${path.basename(lockAbs)}）：另一个协作写者正在进行。拒写，**不自动删别人的锁**；确认锁持有者已退出后再人工核实并删除。`],
        wrote: false,
        target_sha256: digest,
        generated: built.pointer,
      };
    }
    return { code: 1, lines: [`无法取独占锁（${code ?? "?"}）：${e instanceof Error ? e.message : String(e)}`], wrote: false, target_sha256: digest, generated: built.pointer };
  }
  try {
    try {
      fs.writeFileSync(lockFd, `pid=${process.pid}\nat=${new Date().toISOString()}\n`, "utf8");
    } catch {
      /* 锁内容仅作诊断，写不上不影响锁语义 */
    }
    // ── 锁内重查旧版本（CAS 的真正判定点；不在锁外做 check-then-act） ──
    const lockedCurrent = targetCurrent();
    if (lockedCurrent !== expected) {
      return {
        code: 1,
        lines: [`CAS 失败（锁内复核）：期望旧版本 ${expected}，当前实际 ${lockedCurrent}——目标可能已被改过/或你拿的是旧版本；拒写，不刷新旧漂移文件`],
        wrote: false,
        target_sha256: digest,
        generated: built.pointer,
      };
    }
    if (lockedCurrent === digest) {
      lines.push(`[write] 目标已是最新（${digest}），无需改写`);
      return { code: 0, lines, wrote: false, target_sha256: digest, generated: built.pointer };
    }
    const tmp = path.join(path.dirname(tgt.abs), `.${path.basename(tgt.abs)}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`);
    try {
      fs.writeFileSync(tmp, serialized, { encoding: "utf8" });
      // ── 临近 rename：再核来源 validate 与旧 hash（来源/目标在本次写入期间变过就放弃，保留原文件） ──
      const rebuilt = buildPointer(tpl, root);
      if (!rebuilt.ok) throw new Error(`来源在写入前失效：${rebuilt.reason}（保留原文件）`);
      const revalidated = validateStageReadsObject(rebuilt.pointer, root);
      if (revalidated.status !== "ok") {
        throw new Error(`来源在写入前未通过校验：${revalidated.status === "invalid" ? revalidated.reasons.join("；") : revalidated.status}（保留原文件）`);
      }
      const rebuiltDigest = sha256Hex(Buffer.from(`${JSON.stringify(rebuilt.pointer, null, 2)}\n`, "utf8"));
      if (rebuiltDigest !== digest) {
        throw new Error(`来源在写入前变了（生成 ${digest.slice(0, 12)}… → 现读 ${rebuiltDigest.slice(0, 12)}…）：放弃改写、保留原文件，请重新以新版本重试`);
      }
      const preRenameCurrent = targetCurrent();
      if (preRenameCurrent !== expected) {
        throw new Error(`临近改名时目标已变成 ${preRenameCurrent}（期望 ${expected}）：放弃改写、保留原文件`);
      }
      fs.renameSync(tmp, tgt.abs);
    } catch (e) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* 清理失败不改判定 */
      }
      return { code: 1, lines: [`原子写失败：${e instanceof Error ? e.message : String(e)}`], wrote: false, target_sha256: digest, generated: built.pointer };
    }
    lines.push(`[write] 已原子写入 ${STAGE_READS_REL}（旧版本 ${lockedCurrent} → 新版本 ${digest}）`);
    return { code: 0, lines, wrote: true, target_sha256: digest, generated: built.pointer };
  } finally {
    if (lockFd !== null) {
      try {
        fs.closeSync(lockFd);
      } catch {
        /* 关不上不影响判定 */
      }
    }
    // 只删**自己创建**的锁：别人的锁在取锁失败分支里根本没拿到 fd，走不到这里。
    try {
      fs.rmSync(lockAbs, { force: true });
    } catch {
      /* 删不掉锁文件不改变本次写判定（下次可能 EEXIST，如实拒绝） */
    }
  }
}

function usage(): string {
  return [
    "用法：tsx scripts/prepare-stage-reads.ts --project-root <项目根> --config <模板.json> [--write --expected-sha256 <sha256|absent>]",
    "默认 --check：只校验、不写盘。--write：CAS（--expected-sha256 必填）后原子写。",
  ].join("\n");
}

export function main(argv: string[]): number {
  const args = argv.slice(2);
  let projectRoot = process.cwd();
  let configPath: string | null = null;
  let write = false;
  let expectedSha256: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--project-root") projectRoot = args[++i] ?? projectRoot;
    else if (a === "--config") configPath = args[++i] ?? null;
    else if (a === "--write") write = true;
    else if (a === "--check") write = false;
    else if (a === "--expected-sha256") expectedSha256 = args[++i] ?? null;
    else if (a === "--help" || a === "-h") {
      process.stdout.write(`${usage()}\n`);
      return 0;
    } else {
      process.stderr.write(`未知参数：${a}\n${usage()}\n`);
      return 1;
    }
  }
  if (configPath === null) {
    process.stderr.write(`缺 --config\n${usage()}\n`);
    return 1;
  }
  const out = runPrepareStageReads({ projectRoot, configPath, write, expectedSha256 });
  for (const l of out.lines) (out.code === 0 ? process.stdout : process.stderr).write(`${l}\n`);
  return out.code;
}

// 直接执行时才跑 CLI（被 verify 脚本 import 时不自动执行）
if (process.argv[1] !== undefined && /[\\/]prepare-stage-reads\.ts$/.test(process.argv[1])) {
  process.exit(main(process.argv));
}
