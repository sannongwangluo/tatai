// 持久项目说明索引与交接覆盖（PLAN.md V09-39；DESIGN.md §6.8；docs/unified-optimization-contract.md U5/U5.1）。
//
// 本模块实现「Agent 编写的项目说明文档」这一**待审说明层**（不是设计、不是事件、不是验收事实）：
//   · 载体是项目根内 `docs/project-notes.json`（`PROJECT_NOTES_REL`）；**不让 Agent 另建事实库**，
//     不改六图颜色/状态/Gate；它只是可重建的**导航索引**，不是新设计权威；
//   · 每个条目有稳定 id、职责、接口、约束、有限来源 {path, sha256}、关系声明、task_ids/tests/evidence 引用；
//   · 读（read/impact/coverage）**只读零副作用**；写（upsert/remove）经**唯一宿主**（projectIndexHost），
//     本模块自身不做跨进程写仲裁——它只是宿主内被调用的同一份实现；
//   · 增量 upsert/remove **只改指定项**、其它条目语义不重写；完整文件 hash 做 **CAS**（`withFileLock` 锁内核对）＋原子写；
//   · **未知字段 / 重复 id / 超条目·字节 / 路径 `..`·绝对 / 最终＋中间 junction 逃逸 / 凭据路径** 一律拒；
//   · 来源在**写下时**现读核对完整 hash（声明的 sha 与当前不符即拒，不许编造当前哈希）；读侧现读复核：
//     内容变＝stale、路径消失＝missing、取不到＝unreadable；源删除/移动**不删源**、只在读侧如实标 stale/missing；
//   · **保持 id 的显式 upsert** 处理路径迁移（不凭同名猜测）；同 schema 文档不存在＝明确空索引（不能据此推断没有影响）；
//     项目已有**异 schema** 同名文档时明确冲突、**不可覆盖**；
//   · **Agent 声明默认待审**：带 evidence 字段也不能把声明升格为 verified（本模块的 `verification` 恒为 `declared`）。
//
// 关系与证据口径（U5）：关系没有独立证据时只标 `declared`；impact 的「代码引用」只带**来源新鲜度**
// （`source_current`：来源当前存在且哈希相符），它**不**等于声明的关系已验证；**未声明 ≠ 无影响**
// （query 命中不到任何条目时 coverage=unknown，不推断「没有影响」）。
//
// 来源读取机制（2026-10-03 复审返工）：read/impact/coverage 与写侧来源校验**共用同一次查询的**
// `SourceReadSession`——按**规范路径**复用已取字节/哈希、并共享文件数与字节预算（`PROJECT_INDEX_READ_LIMITS`）；
// 超预算明确 `unknown`/补取，绝不当成内容相符；写锁内重新建立会话现读当前来源，缓存**不跨请求**留存。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getProject } from "../registry";
import { withFileLock } from "../fileLock";
import { resolveProjectRelative, sha256Hex } from "./documents";
import {
  isForbiddenManifestPath,
  isSha256Hex,
  resolveInsideProject,
  MAX_SOURCE_MANIFEST_FILE_BYTES,
} from "./sourceEvidence";
import { WorkError } from "./types";

/** 说明文档的项目根内相对路径（U5.1 固定载体） */
export const PROJECT_NOTES_REL = "docs/project-notes.json";
/** 说明文档 schema 版本 */
export const PROJECT_NOTES_SCHEMA_VERSION = 1 as const;
/** 顶层 `doc` 标识（异 schema 同名文档据此判冲突） */
export const PROJECT_NOTES_DOC = "project-notes";

/** 有界预算（超限如实拒，不做全盘/大文件处理） */
export const PROJECT_INDEX_LIMITS = {
  max_entries: 500,
  max_file_bytes: 2 * 1024 * 1024,
  max_sources_per_entry: 64,
  max_relations_per_entry: 64,
  max_list_items: 64,
  max_string_len: 4000,
} as const;

/**
 * 一次查询内**共享**的来源读取预算（文件数 + 字节总量）。同一次 read/impact/coverage/写校验里，
 * 同一个规范路径只读一次（复用已取字节/哈希），不同路径才占预算；超预算明确 `unknown`/补取，
 * **绝不当成内容相符**。缺省值可被调用方按需收紧（测试/受控轻读），收紧只影响本机制，不放松拒收判据。
 */
export const PROJECT_INDEX_READ_LIMITS = {
  max_files: 2048,
  max_bytes: 64 * 1024 * 1024,
} as const;

/** 调用方可收紧的来源读取预算（缺省用 {@link PROJECT_INDEX_READ_LIMITS}） */
export interface ProjectIndexReadLimits {
  max_files?: number;
  max_bytes?: number;
}

// ── 类型 ──

export interface ProjectNoteSource {
  path: string;
  sha256: string;
}
export interface ProjectNoteRelation {
  to: string;
  kind: string | null;
  note: string | null;
}
export interface ProjectNote {
  id: string;
  responsibility: string;
  paths: string[];
  interfaces: string[];
  constraints: string[];
  relations: ProjectNoteRelation[];
  sources: ProjectNoteSource[];
  task_ids: string[];
  tests: string[];
  evidence_refs: string[];
  declared_by: string | null;
}
export interface ProjectNotesDocument {
  schema_version: number;
  doc: string;
  notes: ProjectNote[];
}

/**
 * 来源现读状态：`ok`（当前存在且哈希相符）/ `stale`（内容已变）/ `missing`（不在盘上）/
 * `unreadable`（越界/凭据/超单文件上限/非普通文件/读失败）/ `unknown`（本次查询来源读取**预算用尽**，
 * 未取到当前内容——按未知待补取，**不当作内容相符**）。
 */
export type NoteSourceStatus = "ok" | "stale" | "missing" | "unreadable" | "unknown";
export interface NoteSourceView {
  path: string;
  declared_sha256: string;
  exists: boolean;
  current_sha256: string | null;
  status: NoteSourceStatus;
  reason: string | null;
}
export interface NoteRelationView {
  to: string;
  kind: string | null;
  note: string | null;
  /** 关系没有独立证据时只标 Agent 声明，不自动晋升为已验证（U5） */
  status: "declared";
}
export interface NoteEntryView {
  id: string;
  responsibility: string;
  paths: string[];
  interfaces: string[];
  constraints: string[];
  relations: NoteRelationView[];
  sources: NoteSourceView[];
  task_ids: string[];
  tests: string[];
  evidence_refs: string[];
  declared_by: string | null;
  /** Agent 声明默认待审：带 evidence 字段也不能冒充 verified */
  verification: { status: "declared"; verified: false; note: string };
  stale: boolean;
  missing_sources: string[];
}

export interface NotesFileInfo {
  rel_path: string;
  exists: boolean;
  schema_ok: boolean;
  conflict: { code: string; message: string } | null;
  version_sha256: string | null;
  entry_count: number;
}

export interface ProjectNotesReadResult {
  project_id: string;
  notes_file: NotesFileInfo;
  filters: { path: string | null; task_id: string | null; id: string | null };
  summary: {
    total_entries: number;
    returned: number;
    stale_entries: number;
    missing_sources: number;
    truncated: boolean;
  };
  entries: NoteEntryView[];
  note: string;
}

export interface ProjectIndexImpactResult {
  project_id: string;
  query: { path: string | null; task_id: string | null; id: string | null };
  matched_entries: { id: string; responsibility: string; match: string }[];
  declared_relations: NoteRelationView[];
  code_references: {
    path: string;
    declared_sha256: string;
    current_sha256: string | null;
    status: NoteSourceStatus;
    /**
     * 只表示「**来源文件当前存在且哈希相符**」——**不**表示声明的引用/关系已验证。
     * 命名刻意不叫 `evidenced`/`verified`：它只是来源新鲜度，不是关系存在的证明（关系仍是 Agent 声明待审）。
     */
    source_current: boolean;
    /** 引用默认待审：Agent 声明，不因来源当前相符而升级为已验证 */
    verification: "declared";
    note: string;
  }[];
  coverage: { status: "empty_index" | "declared_partial" | "unknown"; note: string };
  unknown: string[];
  disclaimers: string[];
}

export interface ProjectIndexCoverageResult {
  project_id: string;
  query: { path: string | null; task_id: string | null; id: string | null };
  required: { id: string; responsibility: string; paths: string[]; sources: { path: string; status: NoteSourceStatus }[] }[];
  returned: {
    notes_file_rel: string;
    exists: boolean;
    schema_ok: boolean;
    version_sha256: string | null;
    entry_count: number;
    entries_returned: number;
    scope: "index_only";
  };
  omissions: { kind: "source_stale" | "source_missing" | "source_unreadable" | "source_unknown" | "original_text_not_read" | "entry_not_included"; ref: string; detail: string }[];
  supplementary: { tool: string; how: string }[];
  disclaimers: string[];
}

export interface ProjectIndexWriteResult {
  ok: true;
  project_id: string;
  file_sha256: string;
  entry_count: number;
  created: string[];
  updated: string[];
  removed: string[];
  not_found: string[];
}

// ── 纯校验（路径词法 / schema） ──

/**
 * 说明文档里路径的**词法**归一化：拒绝空串、绝对路径、盘符、UNC、`..`、NUL。
 * （联接点/软链逃逸是 IO 层的事，见 `readSourceView`/写侧 `readManifestFile`。）
 */
export function normalizeNoteRelPath(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new WorkError("INVALID_COMMAND", `说明文档里的路径必须是字符串（收到 ${JSON.stringify(raw)}）`, { path: raw });
  }
  const text = raw.trim();
  if (text === "") throw new WorkError("INVALID_COMMAND", "说明文档里有空路径");
  const unified = text.replace(/\\/g, "/");
  if (unified.startsWith("/")) throw new WorkError("INVALID_COMMAND", `说明文档路径必须是项目内相对路径，不能是绝对路径：${raw}`, { path: raw });
  if (/^[a-zA-Z]:/.test(unified)) throw new WorkError("INVALID_COMMAND", `说明文档路径不能带盘符：${raw}`, { path: raw });
  if (unified.startsWith("//")) throw new WorkError("INVALID_COMMAND", `说明文档路径不能是 UNC 路径：${raw}`, { path: raw });
  const parts = unified.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.length === 0) throw new WorkError("INVALID_COMMAND", `说明文档路径归一化后为空：${raw}`, { path: raw });
  for (const p of parts) {
    if (p === "..") throw new WorkError("INVALID_COMMAND", `说明文档路径含 .. 上跳（越界一律拒）：${raw}`, { path: raw });
    if (p.includes("\0")) throw new WorkError("INVALID_COMMAND", `说明文档路径含 NUL：${raw}`, { path: raw });
  }
  return parts.join("/");
}

const NOTE_KEYS = new Set([
  "id",
  "responsibility",
  "paths",
  "interfaces",
  "constraints",
  "relations",
  "sources",
  "task_ids",
  "tests",
  "evidence_refs",
  "declared_by",
]);
const TOP_KEYS = new Set(["schema_version", "doc", "notes"]);

function asObject(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WorkError("INVALID_COMMAND", `${what}必须是 JSON 对象（收到 ${Array.isArray(value) ? "array" : typeof value}）`);
  }
  return value as Record<string, unknown>;
}
function unknownKeys(obj: Record<string, unknown>, allowed: Set<string>, what: string): string[] {
  return Object.keys(obj).filter((k) => !allowed.has(k));
}
function strField(value: unknown, what: string, opts: { allowEmpty?: boolean; max?: number } = {}): string {
  if (typeof value !== "string") throw new WorkError("INVALID_COMMAND", `${what}必须是字符串（收到 ${typeof value}）`);
  const max = opts.max ?? PROJECT_INDEX_LIMITS.max_string_len;
  if (value.length > max) throw new WorkError("INVALID_COMMAND", `${what}超过长度上限 ${max}（实际 ${value.length}）`);
  if (!opts.allowEmpty && value.trim() === "") throw new WorkError("INVALID_COMMAND", `${what}不能为空`);
  return value;
}
function strList(value: unknown, what: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new WorkError("INVALID_COMMAND", `${what}必须是字符串数组`);
  if (value.length > PROJECT_INDEX_LIMITS.max_list_items) {
    throw new WorkError("INVALID_COMMAND", `${what}条目过多（上限 ${PROJECT_INDEX_LIMITS.max_list_items}，实际 ${value.length}）`);
  }
  return value.map((v, i) => strField(v, `${what}[${i}]`, { allowEmpty: true }));
}

function validateNote(value: unknown, where: string): ProjectNote {
  const raw = asObject(value, `${where} 的条目`);
  const extra = unknownKeys(raw, NOTE_KEYS, `${where} 的条目`);
  if (extra.length > 0) throw new WorkError("INVALID_COMMAND", `${where} 的条目含未知字段：${extra.join("、")}`, { extra });
  const id = strField(raw.id, `${where}.id`);
  const responsibility = raw.responsibility === undefined ? "" : strField(raw.responsibility, `${where}.responsibility`, { allowEmpty: true });

  const paths = (raw.paths === undefined ? [] : strList(raw.paths, `${where}.paths`)).map((p) => normalizeNoteRelPath(p));
  const interfaces = strList(raw.interfaces, `${where}.interfaces`);
  const constraints = strList(raw.constraints, `${where}.constraints`);
  const task_ids = strList(raw.task_ids, `${where}.task_ids`);
  const tests = strList(raw.tests, `${where}.tests`);
  const evidence_refs = strList(raw.evidence_refs, `${where}.evidence_refs`);

  const relationsRaw = raw.relations === undefined || raw.relations === null ? [] : raw.relations;
  if (!Array.isArray(relationsRaw)) throw new WorkError("INVALID_COMMAND", `${where}.relations 必须是数组`);
  if (relationsRaw.length > PROJECT_INDEX_LIMITS.max_relations_per_entry) {
    throw new WorkError("INVALID_COMMAND", `${where}.relations 条目过多（上限 ${PROJECT_INDEX_LIMITS.max_relations_per_entry}）`);
  }
  const relations: ProjectNoteRelation[] = relationsRaw.map((r, i) => {
    const obj = asObject(r, `${where}.relations[${i}]`);
    const ex = unknownKeys(obj, new Set(["to", "kind", "note"]), `${where}.relations[${i}]`);
    if (ex.length > 0) throw new WorkError("INVALID_COMMAND", `${where}.relations[${i}] 含未知字段：${ex.join("、")}`, { extra: ex });
    return {
      to: strField(obj.to, `${where}.relations[${i}].to`),
      kind: obj.kind === undefined || obj.kind === null ? null : strField(obj.kind, `${where}.relations[${i}].kind`),
      note: obj.note === undefined || obj.note === null ? null : strField(obj.note, `${where}.relations[${i}].note`, { allowEmpty: true }),
    };
  });

  const sourcesRaw = raw.sources === undefined || raw.sources === null ? [] : raw.sources;
  if (!Array.isArray(sourcesRaw)) throw new WorkError("INVALID_COMMAND", `${where}.sources 必须是数组`);
  if (sourcesRaw.length > PROJECT_INDEX_LIMITS.max_sources_per_entry) {
    throw new WorkError("INVALID_COMMAND", `${where}.sources 条目过多（上限 ${PROJECT_INDEX_LIMITS.max_sources_per_entry}）`);
  }
  const seenSources = new Set<string>();
  const sources: ProjectNoteSource[] = sourcesRaw.map((s, i) => {
    const obj = asObject(s, `${where}.sources[${i}]`);
    const ex = unknownKeys(obj, new Set(["path", "sha256"]), `${where}.sources[${i}]`);
    if (ex.length > 0) throw new WorkError("INVALID_COMMAND", `${where}.sources[${i}] 含未知字段：${ex.join("、")}`, { extra: ex });
    const p = normalizeNoteRelPath(obj.path);
    if (seenSources.has(p)) throw new WorkError("INVALID_COMMAND", `${where}.sources 里同一路径重复：${p}`, { path: p });
    seenSources.add(p);
    if (!isSha256Hex(obj.sha256)) {
      throw new WorkError("INVALID_COMMAND", `${where}.sources[${i}].sha256 必须是 64 位小写十六进制：${p}`, { path: p, sha256: obj.sha256 });
    }
    return { path: p, sha256: obj.sha256 };
  });

  const declared_by = raw.declared_by === undefined || raw.declared_by === null ? null : strField(raw.declared_by, `${where}.declared_by`, { allowEmpty: true });

  return { id, responsibility, paths, interfaces, constraints, relations, sources, task_ids, tests, evidence_refs, declared_by };
}

/** 严格校验一份说明文档（未知字段/重复 id/超条目·超长/路径不合法一律拒）。 */
export function validateProjectNotesDocument(value: unknown): ProjectNotesDocument {
  const raw = asObject(value, "project-notes 文档");
  const extra = unknownKeys(raw, TOP_KEYS, "project-notes 文档");
  if (extra.length > 0) {
    throw new WorkError("INVALID_COMMAND", `project-notes 文档含未知顶层字段：${extra.join("、")}`, { extra });
  }
  if (raw.schema_version !== PROJECT_NOTES_SCHEMA_VERSION) {
    throw new WorkError(
      "INVALID_COMMAND",
      `project-notes schema_version 必须是 ${PROJECT_NOTES_SCHEMA_VERSION}（收到 ${JSON.stringify(raw.schema_version)}）：异 schema 同名文档不可覆盖`,
      { schema_version: raw.schema_version },
    );
  }
  if (raw.doc !== PROJECT_NOTES_DOC) {
    throw new WorkError("INVALID_COMMAND", `project-notes 顶层 doc 必须是 ${JSON.stringify(PROJECT_NOTES_DOC)}（收到 ${JSON.stringify(raw.doc)}）`, { doc: raw.doc });
  }
  const notesRaw = raw.notes === undefined || raw.notes === null ? [] : raw.notes;
  if (!Array.isArray(notesRaw)) throw new WorkError("INVALID_COMMAND", "project-notes.notes 必须是数组");
  if (notesRaw.length > PROJECT_INDEX_LIMITS.max_entries) {
    throw new WorkError("INVALID_COMMAND", `说明条目过多（上限 ${PROJECT_INDEX_LIMITS.max_entries}，实际 ${notesRaw.length}）`, { count: notesRaw.length });
  }
  const notes: ProjectNote[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < notesRaw.length; i++) {
    const n = validateNote(notesRaw[i], `notes[${i}]`);
    if (seen.has(n.id)) throw new WorkError("INVALID_COMMAND", `说明条目 id 重复：${n.id}`, { id: n.id });
    seen.add(n.id);
    notes.push(n);
  }
  return { schema_version: PROJECT_NOTES_SCHEMA_VERSION, doc: PROJECT_NOTES_DOC, notes };
}

export function emptyProjectNotesDocument(): ProjectNotesDocument {
  return { schema_version: PROJECT_NOTES_SCHEMA_VERSION, doc: PROJECT_NOTES_DOC, notes: [] };
}

// ── 路径解析 / 文件读写 ──

interface NotesTarget {
  project_id: string;
  root: string;
  abs: string;
  rel: string;
}

function resolveNotesTarget(projectId: string, dataDir?: string): NotesTarget {
  const project = getProject(projectId, dataDir);
  if (!project) throw new WorkError("INVALID_COMMAND", `项目不存在: ${projectId}`, { project_id: projectId });
  const root = path.resolve(project.path);
  const res = resolveProjectRelative(root, PROJECT_NOTES_REL);
  if (!res.ok) {
    throw new WorkError(
      "EVIDENCE_INVALID",
      `说明文件路径不合法或经联接点/软链逃出项目根（${res.reason}）：${PROJECT_NOTES_REL}`,
      { rel_path: PROJECT_NOTES_REL, reason: res.reason },
    );
  }
  return { project_id: projectId, root, abs: res.abs, rel: res.rel_path };
}

interface RawFile {
  exists: boolean;
  bytes: Buffer | null;
  sha: string | null;
}
function readRawFile(abs: string): RawFile {
  try {
    const st = fs.lstatSync(abs);
    if (!st.isFile()) return { exists: false, bytes: null, sha: null };
    const bytes = fs.readFileSync(abs);
    return { exists: true, bytes, sha: sha256Hex(bytes) };
  } catch {
    return { exists: false, bytes: null, sha: null };
  }
}

function tryParseDocument(bytes: Buffer): { doc: ProjectNotesDocument | null; conflict: { code: string; message: string } | null } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch (e) {
    return { doc: null, conflict: { code: "INVALID_JSON", message: `说明文件不是合法 JSON：${(e as Error).message}` } };
  }
  const obj = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  if (obj === null || obj.schema_version !== PROJECT_NOTES_SCHEMA_VERSION || obj.doc !== PROJECT_NOTES_DOC) {
    return {
      doc: null,
      conflict: {
        code: "SCHEMA_CONFLICT",
        message:
          `同名文档 ${PROJECT_NOTES_REL} 不是本 schema（schema_version=${JSON.stringify(obj?.schema_version)}，doc=${JSON.stringify(obj?.doc)}）：` +
          "异 schema 同名文档不可覆盖、也不按本 schema 解析",
      },
    };
  }
  try {
    return { doc: validateProjectNotesDocument(obj), conflict: null };
  } catch (e) {
    return { doc: null, conflict: { code: "INVALID_DOCUMENT", message: e instanceof Error ? e.message : String(e) } };
  }
}

function notesFileInfoOf(target: NotesTarget, raw: RawFile, parsed: ReturnType<typeof tryParseDocument>): NotesFileInfo {
  return {
    rel_path: target.rel,
    exists: raw.exists,
    schema_ok: !raw.exists || parsed.conflict === null,
    conflict: parsed.conflict,
    version_sha256: raw.sha,
    entry_count: parsed.doc?.notes.length ?? 0,
  };
}

/** 只读：说明文件的存在性/版本/条目数（供上下文包等轻量取材；不抛，异常转成 schema_ok=false）。 */
export function projectNotesFileInfo(projectId: string, dataDir?: string): NotesFileInfo & { readonly project_id: string } {
  let target: NotesTarget;
  try {
    target = resolveNotesTarget(projectId, dataDir);
  } catch {
    return {
      project_id: projectId,
      rel_path: PROJECT_NOTES_REL,
      exists: false,
      schema_ok: false,
      conflict: { code: "UNSAFE_PATH", message: "说明文件路径不合法或经联接点逃出项目根" },
      version_sha256: null,
      entry_count: 0,
    };
  }
  const raw = readRawFile(target.abs);
  const parsed = raw.exists && raw.bytes !== null ? tryParseDocument(raw.bytes) : { doc: null, conflict: null };
  return { project_id: projectId, ...notesFileInfoOf(target, raw, parsed) };
}

// ── 读：来源现读复核（ok/stale/missing/unreadable/unknown） ──
//
// 一次查询（read/impact/coverage 或一次写校验）建立**一个** `SourceReadSession`：按**规范路径**复用已取字节
// 与哈希、共享文件数与字节预算。这样才能避免「100 条说明指向同一份来源 → 同一份文件被读 100 次」这类重复放
// 大，也才能对真实的大库给出有界行为（超预算 → unknown/补取，不冒充内容相符）。

type SourceReadResult =
  | { kind: "read"; sha256: string; bytes: number }
  | { kind: "missing" }
  | { kind: "unreadable"; reason: string }
  | { kind: "budget"; reason: string };

interface SourceReadSession {
  root: string;
  limits: { max_files: number; max_bytes: number };
  files: number;
  bytes: number;
  exceeded: boolean;
  cache: Map<string, SourceReadResult>;
}

function newSourceReadSession(root: string, over?: ProjectIndexReadLimits): SourceReadSession {
  return {
    root,
    limits: {
      max_files: over?.max_files ?? PROJECT_INDEX_READ_LIMITS.max_files,
      max_bytes: over?.max_bytes ?? PROJECT_INDEX_READ_LIMITS.max_bytes,
    },
    files: 0,
    bytes: 0,
    exceeded: false,
    cache: new Map(),
  };
}

/** 按**规范路径**取当前来源（同一次查询内复用；缓存不跨请求留存）。 */
function readCanonicalSource(session: SourceReadSession, rel: string): SourceReadResult {
  const hit = session.cache.get(rel);
  if (hit !== undefined) return hit;
  const res = readSourceUncached(session, rel);
  session.cache.set(rel, res);
  return res;
}

function readSourceUncached(session: SourceReadSession, rel: string): SourceReadResult {
  if (isForbiddenManifestPath(rel)) {
    return { kind: "unreadable", reason: "凭据/忽略路径不收集、不读取（DESIGN §6.8／契约 U5）" };
  }
  const rawAbs = path.resolve(session.root, rel);
  let st: fs.Stats;
  try {
    st = fs.lstatSync(rawAbs);
  } catch {
    return { kind: "missing" };
  }
  try {
    resolveInsideProject(session.root, rel); // 最终＋中间 junction/软链逃逸一律 unreadable
  } catch (e) {
    return { kind: "unreadable", reason: e instanceof Error ? e.message : String(e) };
  }
  if (!st.isFile()) return { kind: "unreadable", reason: "不是普通文件" };
  if (st.size > MAX_SOURCE_MANIFEST_FILE_BYTES) {
    return { kind: "unreadable", reason: `超过单文件上限 ${MAX_SOURCE_MANIFEST_FILE_BYTES} 字节` };
  }
  // 共享预算：已用尽/将超限 → 明确 unknown + 补取，不读、不冒充内容相符
  if (
    session.exceeded ||
    session.files + 1 > session.limits.max_files ||
    session.bytes + st.size > session.limits.max_bytes
  ) {
    session.exceeded = true;
    return {
      kind: "budget",
      reason:
        `本次查询的来源读取预算已用尽（已读 ${session.files} 文件 / ${session.bytes} 字节；上限 ` +
        `${session.limits.max_files} 文件 / ${session.limits.max_bytes} 字节）：本项按 unknown 处理，` +
        "**不当作内容相符**；补取入口见 project_index op=read / read_design / read_plan / expand_module",
    };
  }
  let buf: Buffer;
  try {
    buf = fs.readFileSync(rawAbs);
  } catch (e) {
    return { kind: "unreadable", reason: e instanceof Error ? e.message : String(e) };
  }
  session.files += 1;
  session.bytes += buf.length;
  return { kind: "read", sha256: sha256Hex(buf), bytes: buf.length };
}

function readSourceView(session: SourceReadSession, src: ProjectNoteSource): NoteSourceView {
  let rel: string;
  try {
    rel = normalizeNoteRelPath(src.path);
  } catch (e) {
    return { path: src.path, declared_sha256: src.sha256, exists: false, current_sha256: null, status: "unreadable", reason: e instanceof Error ? e.message : String(e) };
  }
  const base = { path: rel, declared_sha256: src.sha256 };
  // 凭据/忽略路径：**词法**拒收，不落盘、不算存在（与原行为一致；写侧另有同名拒收）
  if (isForbiddenManifestPath(rel)) {
    return { ...base, exists: false, current_sha256: null, status: "unreadable", reason: "凭据/忽略路径不收集、不读取（DESIGN §6.8／契约 U5）" };
  }
  const r = readCanonicalSource(session, rel);
  switch (r.kind) {
    case "missing":
      return { ...base, exists: false, current_sha256: null, status: "missing", reason: "当前不在盘上（删了/移走了）" };
    case "unreadable":
      return { ...base, exists: true, current_sha256: null, status: "unreadable", reason: r.reason };
    case "budget":
      return { ...base, exists: true, current_sha256: null, status: "unknown", reason: r.reason };
    case "read":
      return r.sha256 === src.sha256
        ? { ...base, exists: true, current_sha256: r.sha256, status: "ok", reason: null }
        : { ...base, exists: true, current_sha256: r.sha256, status: "stale", reason: `内容与声明不符（声明 ${src.sha256.slice(0, 12)}…，当前 ${r.sha256.slice(0, 12)}…）` };
  }
}

const DECLARED_VERIFICATION = {
  status: "declared" as const,
  verified: false as const,
  note: "Agent 声明默认待审：条目自带 evidence 字段也不据此升格为已验证；独立验证不在本索引内完成（DESIGN §6.8／契约 U5）",
};

function entryViewOf(session: SourceReadSession, note: ProjectNote): NoteEntryView {
  const sources = note.sources.map((s) => readSourceView(session, s));
  return {
    id: note.id,
    responsibility: note.responsibility,
    paths: [...note.paths],
    interfaces: [...note.interfaces],
    constraints: [...note.constraints],
    relations: note.relations.map((r) => ({ to: r.to, kind: r.kind, note: r.note, status: "declared" as const })),
    sources,
    task_ids: [...note.task_ids],
    tests: [...note.tests],
    evidence_refs: [...note.evidence_refs],
    declared_by: note.declared_by,
    verification: { ...DECLARED_VERIFICATION },
    stale: sources.some((s) => s.status !== "ok"),
    missing_sources: sources.filter((s) => s.status === "missing").map((s) => s.path),
  };
}

// ── 匹配 / 过滤 ──

interface NotesQuery {
  path: string | null;
  task_id: string | null;
  id: string | null;
}
function queryOf(opts: { path?: string; task_id?: string; id?: string }): NotesQuery {
  const p = typeof opts.path === "string" && opts.path.trim() !== "" ? normalizeNoteRelPath(opts.path) : null;
  const t = typeof opts.task_id === "string" && opts.task_id.trim() !== "" ? opts.task_id.trim() : null;
  const i = typeof opts.id === "string" && opts.id.trim() !== "" ? opts.id.trim() : null;
  return { path: p, task_id: t, id: i };
}
function matchesQuery(note: ProjectNote, q: NotesQuery): { matched: boolean; via: string } {
  if (q.id !== null) return note.id === q.id ? { matched: true, via: "id" } : { matched: false, via: "" };
  if (q.task_id !== null) {
    return note.task_ids.includes(q.task_id) ? { matched: true, via: "task_id" } : { matched: false, via: "" };
  }
  if (q.path !== null) {
    const p = q.path;
    const pathHit = note.paths.some((np) => np === p || np === p.replace(/\/+$/, "") || p.startsWith(np + "/") || np.startsWith(p + "/"));
    const srcHit = note.sources.some((s) => s.path === p);
    if (pathHit || srcHit) return { matched: true, via: pathHit ? "path" : "source" };
    return { matched: false, via: "" };
  }
  return { matched: true, via: "all" };
}

interface LoadedNotes {
  target: NotesTarget;
  raw: RawFile;
  parsed: ReturnType<typeof tryParseDocument>;
  info: NotesFileInfo;
}

function loadNotes(projectId: string, dataDir?: string): LoadedNotes {
  const target = resolveNotesTarget(projectId, dataDir); // 读时路径不合法照样抛（调用方按 code 报）
  const raw = readRawFile(target.abs);
  const parsed = raw.exists && raw.bytes !== null ? tryParseDocument(raw.bytes) : { doc: null, conflict: null };
  return { target, raw, parsed, info: notesFileInfoOf(target, raw, parsed) };
}

// ── 读口：read ──

export interface ReadNotesOptions {
  dataDir?: string;
  path?: string;
  task_id?: string;
  id?: string;
  limit?: number;
  /** 可收紧本次查询的来源读取预算（缺省 PROJECT_INDEX_READ_LIMITS）；只影响读取边界，不放松拒收判据 */
  readLimits?: ProjectIndexReadLimits;
}

export function readProjectNotesIndex(projectId: string, opts: ReadNotesOptions = {}): ProjectNotesReadResult {
  let loaded: LoadedNotes;
  try {
    loaded = loadNotes(projectId, opts.dataDir);
  } catch (e) {
    // 路径本身不合法/逃逸：如实报冲突，不读项目外内容
    const conflict = { code: "UNSAFE_PATH", message: e instanceof Error ? e.message : String(e) };
    return {
      project_id: projectId,
      notes_file: { rel_path: PROJECT_NOTES_REL, exists: false, schema_ok: false, conflict, version_sha256: null, entry_count: 0 },
      filters: { path: typeof opts.path === "string" ? opts.path : null, task_id: opts.task_id ?? null, id: opts.id ?? null },
      summary: { total_entries: 0, returned: 0, stale_entries: 0, missing_sources: 0, truncated: false },
      entries: [],
      note: "说明文件路径不安全或经联接点逃出项目根：未读取任何项目外内容",
    };
  }
  const q = (() => {
    try {
      return queryOf(opts);
    } catch {
      return { path: null, task_id: null, id: null } as NotesQuery;
    }
  })();
  const doc = loaded.parsed.doc;
  const all = doc?.notes ?? [];
  const limit = Math.max(1, Math.min(PROJECT_INDEX_LIMITS.max_entries, opts.limit ?? PROJECT_INDEX_LIMITS.max_entries));
  const matched = all.filter((n) => matchesQuery(n, q).matched);
  const returned = matched.slice(0, limit);
  const session = newSourceReadSession(loaded.target.root, opts.readLimits);
  const entries = returned.map((n) => entryViewOf(session, n));
  const note = !loaded.info.exists
    ? "项目没有 docs/project-notes.json（明确空索引）：**不能据此推断没有影响**——索引是 Agent 后补的导航，不是全覆盖声明"
    : loaded.info.conflict !== null
      ? `说明文件存在但不是本 schema / 不可解析（${loaded.info.conflict.code}）：不按本 schema 解析，也不覆盖；请人工处置`
      : `只给索引摘要与来源状态；源的原文需按路径自行取回（送达不等于理解或验收）`;
  return {
    project_id: projectId,
    notes_file: loaded.info,
    filters: { path: q.path, task_id: q.task_id, id: q.id },
    summary: {
      total_entries: all.length,
      returned: entries.length,
      stale_entries: entries.filter((e) => e.stale).length,
      missing_sources: entries.reduce((n, e) => n + e.missing_sources.length, 0),
      truncated: matched.length > entries.length,
    },
    entries,
    note,
  };
}

const IMPACT_DISCLAIMERS = [
  "未声明 ≠ 无影响：本清单只反映已登记的 Agent 声明关系，不覆盖未声明的耦合（必要源码核验仍由 Agent 完成）",
  "关系与条目默认待审（declared）；代码引用只给来源新鲜度 source_current（来源当前存在且哈希相符），**不证明**声明的引用/关系已验证",
  "本索引不是设计、事件或验收事实，不改六图颜色/状态/Gate",
];

// ── 读口：impact ──

export interface ImpactOptions {
  dataDir?: string;
  path?: string;
  task_id?: string;
  id?: string;
  /** 可收紧本次查询的来源读取预算（缺省 PROJECT_INDEX_READ_LIMITS） */
  readLimits?: ProjectIndexReadLimits;
}

export function projectIndexImpact(projectId: string, opts: ImpactOptions = {}): ProjectIndexImpactResult {
  const loaded = loadNotes(projectId, opts.dataDir);
  const q = queryOf(opts);
  const all = loaded.parsed.doc?.notes ?? [];
  const matched: { note: ProjectNote; via: string }[] = [];
  for (const n of all) {
    const m = matchesQuery(n, q);
    if (m.matched && m.via !== "all") matched.push({ note: n, via: m.via });
  }
  const matchedIds = new Set(matched.map((m) => m.note.id));

  // 显式声明关系：命中条目作为 from 的关系，以及别的条目指向命中条目（to）的关系
  const declared_relations: NoteRelationView[] = [];
  for (const n of all) {
    for (const r of n.relations) {
      if (matchedIds.has(n.id) || matchedIds.has(r.to)) {
        declared_relations.push({ to: r.to, kind: r.kind, note: r.note, status: "declared" });
      }
    }
  }

  // 代码引用：只来自命中条目的来源；source_current 只在当前实际存在且哈希相符时为 true
  //（它只说明来源新鲜度，**不**说明声明的引用/关系已验证——关系仍是 Agent 声明待审）
  const code_references: ProjectIndexImpactResult["code_references"] = [];
  const session = newSourceReadSession(loaded.target.root, opts.readLimits);
  const seenRef = new Set<string>();
  for (const m of matched) {
    for (const s of m.note.sources) {
      if (seenRef.has(s.path)) continue;
      seenRef.add(s.path);
      const view = readSourceView(session, s);
      code_references.push({
        path: view.path,
        declared_sha256: s.sha256,
        current_sha256: view.current_sha256,
        status: view.status,
        source_current: view.status === "ok",
        verification: "declared",
        note:
          view.status === "ok"
            ? "来源当前存在且哈希相符（source_current=true）；这只是来源新鲜度，不证明声明的引用/关系已成立"
            : view.reason ?? "来源当前未构成可用参照（不证明引用关系）",
      });
    }
  }

  const coverage: ProjectIndexImpactResult["coverage"] =
    !loaded.info.exists || all.length === 0
      ? { status: "empty_index", note: "没有说明索引：**不能推断无影响**（未声明 ≠ 无影响）" }
      : matched.length === 0
        ? { status: "unknown", note: `没有任何条目声明命中该查询（未声明 ≠ 无影响）；索引共 ${all.length} 条，未覆盖范围需按路径/任务再取` }
        : { status: "declared_partial", note: `命中 ${matched.length} 条 Agent 声明；这只是声明范围，不代表完整影响面（未声明 ≠ 无影响）` };

  const unknown: string[] = [];
  if (matched.length === 0 && all.length > 0) unknown.push("查询范围内没有任何已登记声明（可能是漏登记，也可能确实无关系——需源码核验）");
  for (const ref of code_references) if (!ref.source_current) unknown.push(`来源当前未构成可用参照：${ref.path}（${ref.status}）`);

  return {
    project_id: projectId,
    query: { path: q.path, task_id: q.task_id, id: q.id },
    matched_entries: matched.map((m) => ({ id: m.note.id, responsibility: m.note.responsibility, match: m.via })),
    declared_relations,
    code_references,
    coverage,
    unknown,
    disclaimers: [...IMPACT_DISCLAIMERS],
  };
}

// ── 读口：coverage（交接覆盖） ──

const COVERAGE_SUPPLEMENTARY = [
  { tool: "read_plan", how: "按卡号/章节/行范围取施工图原文（project_index 只给索引，不给原文）" },
  { tool: "read_design", how: "按章节/行范围/续读游标取设计书原文" },
  { tool: "expand_module", how: "就地展开模块取直接子级与静态 import 依赖（结构线索，不是业务数据流）" },
  { tool: "project_index op=read detail=true", how: "按 id/path/task_id 取某条说明的完整索引字段" },
];
const COVERAGE_DISCLAIMERS = [
  "交接清单送达 ≠ 理解 ≠ 验收：本清单只证明本次返回的说明索引范围，不代替读者核验",
  "未取原文/未读源码的范围一律不宣称 covered",
  "索引是 Agent 后补的导航，缺失不等于没有影响；用户 Gate 不由 Agent 代签",
];

export interface CoverageOptions {
  dataDir?: string;
  path?: string;
  task_id?: string;
  id?: string;
  /** 可收紧本次查询的来源读取预算（缺省 PROJECT_INDEX_READ_LIMITS） */
  readLimits?: ProjectIndexReadLimits;
}

export function projectIndexCoverage(projectId: string, opts: CoverageOptions = {}): ProjectIndexCoverageResult {
  const loaded = loadNotes(projectId, opts.dataDir);
  const q = queryOf(opts);
  const all = loaded.parsed.doc?.notes ?? [];
  const scoped = all.filter((n) => matchesQuery(n, q).matched);

  const required: ProjectIndexCoverageResult["required"] = [];
  const omissions: ProjectIndexCoverageResult["omissions"] = [];
  const session = newSourceReadSession(loaded.target.root, opts.readLimits);
  for (const n of scoped) {
    const sourceViews = n.sources.map((s) => ({ path: s.path, status: readSourceView(session, s).status }));
    required.push({ id: n.id, responsibility: n.responsibility, paths: [...n.paths], sources: sourceViews });
    for (const sv of sourceViews) {
      if (sv.status === "stale") omissions.push({ kind: "source_stale", ref: sv.path, detail: `来源内容已变（声明与当前不符）：${sv.path}` });
      else if (sv.status === "missing") omissions.push({ kind: "source_missing", ref: sv.path, detail: `来源已不在盘上：${sv.path}` });
      else if (sv.status === "unreadable") omissions.push({ kind: "source_unreadable", ref: sv.path, detail: `来源取不到内容（越界/凭据/超限等）：${sv.path}` });
      else if (sv.status === "unknown") omissions.push({ kind: "source_unknown", ref: sv.path, detail: `本次查询来源读取预算用尽，未取到当前内容（按 unknown，不冒充内容相符）：${sv.path}；补取入口见 supplementary` });
    }
    for (const p of n.paths) omissions.push({ kind: "original_text_not_read", ref: p, detail: `只给了索引条目 ${n.id}，未取 ${p} 的原文（未读源码不宣称 covered）` });
  }
  if (all.length > scoped.length) {
    omissions.push({ kind: "entry_not_included", ref: "*", detail: `索引共 ${all.length} 条，本次查询只纳入 ${scoped.length} 条（其余未纳入交接范围）` });
  }

  return {
    project_id: projectId,
    query: { path: q.path, task_id: q.task_id, id: q.id },
    required,
    returned: {
      notes_file_rel: loaded.info.rel_path,
      exists: loaded.info.exists,
      schema_ok: loaded.info.schema_ok,
      version_sha256: loaded.info.version_sha256,
      entry_count: all.length,
      entries_returned: scoped.length,
      scope: "index_only",
    },
    omissions,
    supplementary: COVERAGE_SUPPLEMENTARY.map((s) => ({ ...s })),
    disclaimers: [...COVERAGE_DISCLAIMERS],
  };
}

// ── 写口：upsert / remove（经唯一宿主调用；本实现自身在宿主内） ──

export interface UpsertNotesInput {
  expected_file_sha256: string | null;
  entries: unknown[];
  declared_by?: string;
  /** 可收紧本次写校验的来源读取预算（缺省 PROJECT_INDEX_READ_LIMITS） */
  readLimits?: ProjectIndexReadLimits;
}
export interface RemoveNotesInput {
  expected_file_sha256: string | null;
  ids: string[];
}

function normalizeExpected(v: unknown): string | null {
  if (v === undefined || v === null || v === "") return null;
  if (!isSha256Hex(v)) {
    throw new WorkError("INVALID_COMMAND", `expected_file_sha256 必须是 64 位小写十六进制或 null（收到 ${JSON.stringify(v)}）`, { expected: v });
  }
  return v;
}

/**
 * 写侧：来源当前完整 hash 校验（存在、是普通文件、非凭据、非逃逸、sha 相符）。
 * 用**同一次写请求的** `SourceReadSession`（按规范路径复用、共享预算）；调用点在 `withFileLock` 锁内，
 * 因此每次写都会**重新**现读当前来源——**不跨请求**复用旧结果。
 */
function verifySourcesAtWrite(session: SourceReadSession, note: ProjectNote): void {
  for (const s of note.sources) {
    if (isForbiddenManifestPath(s.path)) {
      throw new WorkError("INVALID_COMMAND", `说明来源不收凭据/忽略目录下的路径（DESIGN §6.8／契约 U5）：${s.path}`, { path: s.path });
    }
    const r = readCanonicalSource(session, s.path);
    if (r.kind !== "read") {
      const why = r.kind === "missing" ? "当前不在盘上" : r.reason;
      throw new WorkError("INVALID_COMMAND", `说明来源取不到当前内容（越界/软链/超限/不存在/预算用尽）：${s.path}（${why}）`, { path: s.path });
    }
    if (r.sha256 !== s.sha256) {
      throw new WorkError(
        "INVALID_COMMAND",
        `说明来源声明的 sha256 与当前内容不符（不许编造当前哈希）：${s.path}（声明 ${s.sha256.slice(0, 12)}…，实读 ${r.sha256.slice(0, 12)}…）`,
        { path: s.path, declared_sha256: s.sha256, actual_sha256: r.sha256 },
      );
    }
  }
}

function atomicWrite(abs: string, bytes: Buffer): void {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  try {
    fs.writeFileSync(tmp, bytes);
    fs.renameSync(tmp, abs);
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* 清理失败不掩盖原错误 */
    }
    throw e;
  }
}

function serialize(doc: ProjectNotesDocument): Buffer {
  const bytes = Buffer.from(JSON.stringify(doc, null, 2) + "\n", "utf8");
  if (bytes.length > PROJECT_INDEX_LIMITS.max_file_bytes) {
    throw new WorkError("INVALID_COMMAND", `说明文档超过字节上限 ${PROJECT_INDEX_LIMITS.max_file_bytes}（实际 ${bytes.length}）`, { bytes: bytes.length });
  }
  return bytes;
}

export function upsertProjectNotes(projectId: string, input: UpsertNotesInput, dataDir?: string): ProjectIndexWriteResult {
  const target = resolveNotesTarget(projectId, dataDir);
  const expected = normalizeExpected(input.expected_file_sha256);
  if (!Array.isArray(input.entries) || input.entries.length === 0) {
    throw new WorkError("INVALID_COMMAND", "upsert 需要非空的 entries 数组（增量 upsert 只维护指定条目）", { field: "entries" });
  }
  const declaredBy = typeof input.declared_by === "string" ? input.declared_by.trim() : undefined;
  return withFileLock(target.abs, () => {
    const raw = readRawFile(target.abs);
    let doc: ProjectNotesDocument;
    if (raw.exists) {
      if (expected !== raw.sha) {
        throw new WorkError("VERSION_CONFLICT", `说明文件版本不符（CAS 拒绝）：expected=${expected ?? "null"}，当前=${raw.sha}`, { expected_file_sha256: expected, current_file_sha256: raw.sha });
      }
      const parsed = tryParseDocument(raw.bytes!);
      if (parsed.conflict !== null || parsed.doc === null) {
        throw new WorkError("INVALID_COMMAND", `同名文档不可覆盖：${parsed.conflict?.message ?? "不可解析"}`, { code: parsed.conflict?.code });
      }
      doc = parsed.doc;
    } else {
      if (expected !== null) {
        throw new WorkError("VERSION_CONFLICT", `说明文件不存在，但 expected_file_sha256 非 null（CAS 拒绝）：expected=${expected}`, { expected_file_sha256: expected });
      }
      doc = emptyProjectNotesDocument();
    }

    // 先把待 upsert 条目按同一 schema 校验（含重复 id / 未知字段 / 路径 / 上限）
    const incoming = validateProjectNotesDocument({
      schema_version: PROJECT_NOTES_SCHEMA_VERSION,
      doc: PROJECT_NOTES_DOC,
      notes: input.entries,
    }).notes;
    // 锁内建立来源读取会话：现读当前来源（同路径复用、共享预算），不跨请求留存
    const session = newSourceReadSession(target.root, input.readLimits);
    for (const n of incoming) {
      if (n.declared_by === null && declaredBy !== undefined && declaredBy !== "") n.declared_by = declaredBy;
      verifySourcesAtWrite(session, n);
    }

    const byId = new Map(doc.notes.map((n) => [n.id, n]));
    const created: string[] = [];
    const updated: string[] = [];
    for (const n of incoming) {
      if (byId.has(n.id)) updated.push(n.id);
      else created.push(n.id);
      byId.set(n.id, n);
    }
    // 合并后重校验（合并可能触发 id 冲突/超上限）
    const merged = validateProjectNotesDocument({
      schema_version: PROJECT_NOTES_SCHEMA_VERSION,
      doc: PROJECT_NOTES_DOC,
      notes: [...byId.values()],
    });
    const bytes = serialize(merged);
    atomicWrite(target.abs, bytes);
    return {
      ok: true as const,
      project_id: projectId,
      file_sha256: sha256Hex(bytes),
      entry_count: merged.notes.length,
      created,
      updated,
      removed: [],
      not_found: [],
    };
  });
}

export function removeProjectNotes(projectId: string, input: RemoveNotesInput, dataDir?: string): ProjectIndexWriteResult {
  const target = resolveNotesTarget(projectId, dataDir);
  const expected = normalizeExpected(input.expected_file_sha256);
  if (!Array.isArray(input.ids) || input.ids.length === 0) {
    throw new WorkError("INVALID_COMMAND", "remove 需要非空的 ids 数组（删除说明是显式动作，不猜）", { field: "ids" });
  }
  const ids = input.ids.map((v) => (typeof v === "string" ? v.trim() : ""));
  if (ids.some((v) => v === "")) throw new WorkError("INVALID_COMMAND", "remove 的 ids 里有空 id", { ids: input.ids });
  return withFileLock(target.abs, () => {
    const raw = readRawFile(target.abs);
    if (!raw.exists) {
      throw new WorkError("INVALID_COMMAND", `说明文件不存在，无从删除：${PROJECT_NOTES_REL}`, { rel_path: PROJECT_NOTES_REL });
    }
    if (expected !== raw.sha) {
      throw new WorkError("VERSION_CONFLICT", `说明文件版本不符（CAS 拒绝）：expected=${expected ?? "null"}，当前=${raw.sha}`, { expected_file_sha256: expected, current_file_sha256: raw.sha });
    }
    const parsed = tryParseDocument(raw.bytes!);
    if (parsed.conflict !== null || parsed.doc === null) {
      throw new WorkError("INVALID_COMMAND", `同名文档不可处置：${parsed.conflict?.message ?? "不可解析"}`, { code: parsed.conflict?.code });
    }
    const set = new Set(ids);
    const removed = parsed.doc.notes.filter((n) => set.has(n.id)).map((n) => n.id);
    const not_found = ids.filter((id) => !removed.includes(id));
    const notes = parsed.doc.notes.filter((n) => !set.has(n.id));
    const merged = validateProjectNotesDocument({ schema_version: PROJECT_NOTES_SCHEMA_VERSION, doc: PROJECT_NOTES_DOC, notes });
    const bytes = serialize(merged);
    atomicWrite(target.abs, bytes);
    return {
      ok: true as const,
      project_id: projectId,
      file_sha256: sha256Hex(bytes),
      entry_count: merged.notes.length,
      created: [],
      updated: [],
      removed,
      not_found,
    };
  });
}
