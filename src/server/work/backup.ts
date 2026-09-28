// 私有事实的一致性备份与隔离恢复（PLAN.md V06-14，DESIGN.md §8.5）。
//
// 口径（§8.5 原文，逐条落到下面的实现）：
//   · **可丢的是缓存与视图；不能丢的是意图、有效决定、任务/执行历史、检查点、验收和证据**。
//     所以本模块的**事实清单**是显式分类的（`classifyFact`）：派生数据（`work/state.json`、
//     投影失败标记、`arch/**` 视图）按角色 `derived` 单独登记，**不参与一致性判据**——
//     它们丢了能重建，丢了不算丢事实。
//   · **备份使用事件提交边界**：记录各事实源版本、截止序号、内容哈希及证据清单，
//     避免拼接出不同时间点的半份项目。落点见 `BackupManifest`：
//     事实源版本（`schema_version` + 每源的 `version`）、截止提交序号（`cutoff_seq`）、
//     图纸历史（`documents`）、证据内容哈希与恢复位置（`evidence`）。
//   · **恢复到隔离目录验证**可重放、设计来源可定位、证据哈希相符，**再由用户决定是否替换**；
//     本模块**不自动替换**任何真实数据（`restoreBackup` 返回 `replace_requires_user: true`，
//     原项目一个字节都不写）。
//   · **不能把复制半份目录当通过**：`verifyBackup` 对"没有清单的裸目录副本"、
//     "跨时刻拼接出来的半份"、"缺证据正文"一律判不合格（`ok: false` + 逐条失败原因），
//     只有"某个事件提交序号的一致切片"才可能通过。
//
// 复用（**不另造一套存储**）：
//   · 事件与快照：`eventStore.ts` 的 `loadEvents` / `replayEvents` / `buildSnapshot` / `writeSnapshot`；
//   · 图纸历史：`documents.ts` 的 `readBaselineLog` / `recoverRevision` / `revisionObjectRel`；
//   · 证据正文：`evidence.ts` 的 `evidenceManifest` / `readEvidence` / `evidenceBlobPath`。
//
// 路径红线：项目根与 `.工作台/` **只从注册表取**（`getProject` / `projectWorkbenchDir`），
// 不接受调用方传路径；备份落点默认在塔台数据目录（`<dataDir>/backups/<project_id>/<backup_id>/`），
// 也可由调用方显式指定（§8.5「用户选择私有备份位置与保留策略」）。
import fs from "node:fs";
import path from "node:path";
import { withFileLock } from "../fileLock";
import { getProject, resolveDataDir } from "../registry";
import { nowIso } from "../time";
import {
  BASELINES_FILE,
  DESIGN_REVISIONS_DIR,
  PLAN_REVISIONS_DIR,
  WORKBENCH_DIRNAME,
  projectWorkbenchDir,
  readBaselineLog,
  recoverRevision,
  revisionObjectRel,
  sha256Hex,
  type DocumentKind,
  type DocumentRecovery,
} from "./documents";
import {
  EVIDENCE_DIRNAME,
  evidenceBlobPath,
  evidenceDir,
  evidenceManifest,
  readEvidence,
  type EvidenceManifestEntry,
} from "./evidence";
import {
  EVENTS_FILE,
  PROJECTION_ERROR_FILE,
  STATE_FILE,
  buildSnapshot,
  eventsPath,
  loadEvents,
  replayEvents,
  writeSnapshot,
} from "./eventStore";
import { SCHEMA_VERSION, WorkError, type WorkEvent } from "./types";

export const BACKUP_FORMAT_VERSION = 1;
export const BACKUP_MANIFEST_FILE = "backup-manifest.json";
/** 镜像目录名：`<backup_id>/workbench/` = `<项目根>/.工作台/` 的内容 */
export const BACKUP_WORKBENCH_DIR = "workbench";

// ── 事实分类（§8.5：哪些丢了算丢事实，哪些是可重建的缓存/视图）──

export type BackupSourceRole =
  /** 事实：v2 事件、恢复留痕、隔离现场、续读检查点等（在 `work/` 下且不在派生名单里） */
  | "fact"
  /** 图纸历史：基线流水与不可变修订副本 */
  | "document_history"
  /** 证据正文（内容寻址，不可变） */
  | "evidence"
  /** 派生：缓存与视图（可重建，不参与一致性判据） */
  | "derived"
  /** 归档类：聊天与运行日志（§8.5「可按策略归档」，本卡默认一并备份并如实标注） */
  | "log"
  /** 旧面私有事实（v1 的 tasks.json / progress.json / 图纸源 / 讨论……）：仍备份，但没有 v2 事件边界 */
  | "legacy_fact";

export type SkipReason = "atomic_tmp" | "lock" | "nested_backup";

export interface BackupSourceEntry {
  /** 备份内相对 `workbench/` 的 POSIX 路径（= 项目内相对路径去掉 `.工作台/`） */
  rel_path: string;
  role: BackupSourceRole;
  sha256: string;
  bytes: number;
  /**
   * 该事实源自己的**版本号**：
   *   · `work/events.jsonl` → 截止提交序号（与 `cutoff_seq` 同一值，字符串形态）
   *   · `baselines.jsonl` → 末条基线 id
   *   · 其余 → 内容 sha256（内容寻址型事实源，内容即版本）
   */
  version: string;
  /**
   * 该源**没有** v2 事件提交边界（旧面私有事实与归档类）。
   * 这类源只能记"捕获时刻的内容哈希"——本模块**如实标注**，不假装它们也在同一序号上。
   */
  no_event_boundary?: true;
}

export interface BackupRevisionEntry {
  kind: DocumentKind;
  source_path: string;
  content_sha256: string;
  definition_sha256: string;
  bytes: number;
  /** 备份内恢复位置（`kind=immutable_copy`；`ref` 仍是**项目根内相对**形态，与已交付口径一致） */
  recovery: DocumentRecovery;
  /** 原项目里的恢复位置（可能是 `git:<oid>`——备份把它**物化**成不可变副本，不再依赖项目 Git） */
  original_recovery: DocumentRecovery;
}

export interface BackupDocumentEntry {
  baseline_id: string;
  active_at: string;
  approved_by: string;
  approval_basis: string;
  approval_kind: string;
  supersedes: string | null;
  design: BackupRevisionEntry;
  plan: BackupRevisionEntry;
}

export interface BackupEvidenceEntry {
  evidence_id: string;
  sha256: string;
  bytes: number;
  /** 项目内相对恢复位置（`.工作台/work/evidence/<sha256>.json`） */
  recovery_path: string;
  kind: string;
  summary: string;
  /** 被截止序号以内的事件引用过（引用闭包里的那一批） */
  referenced_by_events: boolean;
}

export interface BackupManifest {
  backup_format: number;
  /** 事实源版本（事件 schema 版本） */
  schema_version: number;
  project_id: string;
  taken_at: string;
  /** **事件提交边界**：本备份覆盖的最后一条事件序号（无事件为 0） */
  cutoff_seq: number;
  event_count: number;
  /** 当前生效基线 id（图纸历史的头；无基线为 null） */
  active_baseline_id: string | null;
  /** 镜像目录名（自描述；恢复时按它找 `.工作台/` 的内容） */
  workbench_dir: string;
  /** 全部文件的清册（含派生——派生按角色排除在一致性判据之外，但不从备份里消失） */
  sources: BackupSourceEntry[];
  /** 派生（可丢、可重建）的相对路径清单 */
  derived: string[];
  /** 跳过的原子写残骸/锁文件（如实登记，不静默） */
  skipped: { rel_path: string; reason: SkipReason }[];
  documents: BackupDocumentEntry[];
  evidence: BackupEvidenceEntry[];
  /** 捕获时如实记下的问题（例如源里被事件引用但**没有正文**的证据）——非空即"这份源本身已不完整" */
  warnings: string[];
}

// ── 路径 ──

export const backupRoot = (dataDir: string, projectId: string): string =>
  path.join(dataDir, "backups", projectId);

export const backupDirOf = (dataDir: string, projectId: string, backupId: string): string =>
  path.join(backupRoot(dataDir, projectId), backupId);

export const backupWorkbenchDir = (backupDir: string): string =>
  path.join(backupDir, BACKUP_WORKBENCH_DIR);

/** `<项目根>/.工作台/` 内相对路径 → 备份 `workbench/` 内相对路径（去掉 `.工作台/` 前缀） */
export function toBackupRel(projectRootRel: string): string {
  const norm = projectRootRel.replace(/\\/g, "/");
  const prefix = `${WORKBENCH_DIRNAME}/`;
  return norm.startsWith(prefix) ? norm.slice(prefix.length) : norm;
}

/** 备份 `workbench/` 内相对路径 → `<项目根>/.工作台/` 内相对路径 */
export function toProjectRel(backupRel: string): string {
  const norm = backupRel.replace(/\\/g, "/");
  const prefix = `${WORKBENCH_DIRNAME}/`;
  return norm.startsWith(prefix) ? norm : prefix + norm;
}

// ── 事实分类 ──

/** 事实分类（§8.5 的核心判断；`skip` = 不进备份） */
function classifyFact(rel: string): BackupSourceRole | { skip: SkipReason } {
  const norm = rel.replace(/\\/g, "/");
  const name = norm.slice(norm.lastIndexOf("/") + 1);
  if (/\.\d+(\.\d+)?\.tmp$/.test(name)) return { skip: "atomic_tmp" };
  if (name.endsWith(".lock")) return { skip: "lock" };
  if (norm.startsWith("backups/")) return { skip: "nested_backup" };

  // 派生：缓存与视图（可重建 → 不参与一致性判据）
  if (norm === `work/${STATE_FILE}`) return "derived";
  if (norm === `work/${PROJECTION_ERROR_FILE}`) return "derived";
  if (norm.startsWith("arch/")) return "derived";

  // 事实
  if (norm.startsWith(`work/${EVIDENCE_DIRNAME}/`)) return "evidence";
  if (norm.startsWith("work/")) return "fact";
  if (norm === BASELINES_FILE) return "document_history";
  if (norm.startsWith(`${DESIGN_REVISIONS_DIR}/`) || norm.startsWith(`${PLAN_REVISIONS_DIR}/`)) {
    return "document_history";
  }

  // 归档类（聊天、运行日志：§8.5 可按策略归档，本卡默认备份并标注）
  if (norm.startsWith("logs/") || norm.startsWith("chat/")) return "log";

  // 其余私有事实（v1 面：tasks.json / progress.json / gate.jsonl / 图纸源 / 讨论 / 决定……）
  return "legacy_fact";
}

interface WalkedFile {
  abs: string;
  rel: string;
}

function walkAll(root: string): WalkedFile[] {
  const out: WalkedFile[] = [];
  const walk = (dir: string, rel: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(dir, e.name);
      const childRel = rel === "" ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) walk(abs, childRel);
      else if (e.isFile()) out.push({ abs, rel: childRel });
    }
  };
  if (fs.existsSync(root)) walk(root, "");
  return out;
}

// ── 事件里引用的证据 id（引用闭包）──

const SHA_RE = /^[0-9a-f]{64}$/;

/** 递归挑出 payload 里"看起来是证据引用"的字符串（键名含 evidence） */
function evidenceRefsIn(value: unknown, out: Set<string>, keyHasEvidence: boolean): void {
  if (Array.isArray(value)) {
    for (const v of value) evidenceRefsIn(v, out, keyHasEvidence);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      evidenceRefsIn(v, out, /evidence/i.test(k));
    }
    return;
  }
  if (typeof value === "string" && keyHasEvidence && SHA_RE.test(value)) out.add(value);
}

/** 全部事件里引用的证据 id（键名含 evidence 的 64 位十六进制值） */
export function evidenceRefsOfEvents(events: readonly WorkEvent[]): string[] {
  const out = new Set<string>();
  for (const e of events) evidenceRefsIn(e.payload, out, false);
  return [...out].sort();
}

// ── 捕获 ──

export interface CreateBackupOptions {
  dataDir?: string;
  /** 备份落点父目录（默认 `<dataDir>/backups/<project_id>`）；§8.5「用户选择私有备份位置」 */
  destRoot?: string;
  /** 备份 id（默认按截止序号 + 时间戳生成）；同名目录已存在即拒绝覆盖 */
  backupId?: string;
  /** 覆盖"现在"（验证脚本用固定时钟） */
  now?: string;
}

function bad(message: string, detail: Record<string, unknown> = {}): never {
  throw new WorkError("INVALID_COMMAND", message, detail);
}

function copyInto(srcAbs: string, destAbs: string): void {
  fs.mkdirSync(path.dirname(destAbs), { recursive: true });
  fs.copyFileSync(srcAbs, destAbs);
}

/**
 * 在**事件提交边界**上创建一份一致备份。
 *
 * 一致性怎么保证（本函数的三条硬做法）：
 *   ① 全程持 `events.jsonl` 的文件锁（与唯一写入服务 `WorkService.submit` 同一把锁）——
 *      捕获期间没有事件能被追加进去，读到的 `last_seq` 就是这份备份的截止序号；
 *   ② 有半截尾行（上次写入被打断的现场）时**拒绝备份**：那份事件文件还不是一个收敛的切片，
 *      先在写入路径/显式 recover 里隔离干净再来；
 *   ③ 证据与图纸修订**内容寻址且不可变**，按"截止序号以内事件引用到的闭包"物化进备份：
 *      `git_blob` 形态的修订被**物化**成不可变副本，备份因此不依赖原项目的 Git 还能不能取回。
 *
 * 不写回原项目一个字节；备份落在项目之外（默认塔台数据目录）。
 */
export function createProjectBackup(projectId: string, opts: CreateBackupOptions = {}): BackupManifest {
  const dataDir = opts.dataDir ?? resolveDataDir();
  const project = getProject(projectId, dataDir);
  if (!project) bad(`项目不存在：${projectId}`, { project_id: projectId });
  const projectRoot = project.path;
  const workbench = projectWorkbenchDir(projectId, dataDir);
  const workDir = path.join(workbench, "work");
  const takenAt = opts.now ?? nowIso();

  return withFileLock(eventsPath(workDir), () => {
    // ① 事件：读全文 → 重放 → 截止序号（锁内，不被并发追加打断）
    const loaded = fs.existsSync(eventsPath(workDir)) ? loadEvents(workDir) : { events: [], tail: null };
    if (loaded.tail !== null) {
      bad(
        `事件文件有半截尾行（第 ${loaded.tail.line} 行，${loaded.tail.reason}）：这不是一个收敛的提交边界，` +
          "先在写入路径或显式恢复里把它隔离/截断，再创建备份——不把半份现场当一致切片",
        { file: EVENTS_FILE, line: loaded.tail.line, reason: "partial_tail" },
      );
    }
    const events = loaded.events;
    const { last_seq } = replayEvents(events);

    // ② 基线流水（图纸历史）：坏行即拒绝（在坏链上做备份 = 备份一份读不出来的历史）
    const baselineLog = readBaselineLog(projectId, dataDir);
    if (baselineLog.corrupt.length > 0) {
      bad(
        `基线流水有坏行（第 ${baselineLog.corrupt.map((c) => c.line).join("、")} 行）：` +
          "先在坏链上处理，再创建备份——不把读不出来的图纸历史当已备份",
        { corrupt: baselineLog.corrupt, reason: "baseline_log_corrupt" },
      );
    }

    // ③ 证据清册（源侧现状）
    const sourceEvidence: EvidenceManifestEntry[] = fs.existsSync(evidenceDir(workDir))
      ? evidenceManifest(workDir)
      : [];
    const bySha = new Set(sourceEvidence.map((e) => e.evidence_id));
    const referenced = evidenceRefsOfEvents(events);

    const warnings: string[] = [];
    for (const sha of referenced) {
      if (!bySha.has(sha)) {
        warnings.push(
          `事件引用的证据正文在源里就不存在：${sha}（引用方在截止序号 ${last_seq} 以内）——` +
            "按 §8.5「损坏或丢失的证据标缺失」，这份备份被标为不完整",
        );
      }
    }

    const backupId =
      opts.backupId ?? `b-${String(last_seq).padStart(8, "0")}-${takenAt.replace(/[:.]/g, "-")}`;
    const destRoot = opts.destRoot ?? backupRoot(dataDir, projectId);
    const destDir = path.join(destRoot, backupId);
    if (fs.existsSync(destDir)) {
      bad(`备份目录已存在，不覆盖：${destDir}`, { backup_dir: destDir, reason: "backup_exists" });
    }
    const destWorkbench = backupWorkbenchDir(destDir);
    const destWorkDir = path.join(destWorkbench, "work");
    fs.mkdirSync(destWorkbench, { recursive: true });

    const sources: BackupSourceEntry[] = [];
    const skipped: { rel_path: string; reason: SkipReason }[] = [];

    // ④ 逐文件镜像 `.工作台/`（派生的照抄，但按角色排除出一致性判据）
    for (const f of walkAll(workbench)) {
      const role = classifyFact(f.rel);
      if (typeof role === "object") {
        skipped.push({ rel_path: f.rel, reason: role.skip });
        continue;
      }
      const destAbs = path.join(destWorkbench, f.rel);
      copyInto(f.abs, destAbs);
      const bytes = fs.readFileSync(destAbs);
      const version =
        f.rel === `work/${EVENTS_FILE}`
          ? String(last_seq)
          : f.rel === BASELINES_FILE
            ? (baselineLog.baselines.at(-1)?.baseline_id ?? "")
            : sha256Hex(bytes);
      const entry: BackupSourceEntry = {
        rel_path: f.rel,
        role,
        sha256: sha256Hex(bytes),
        bytes: bytes.length,
        version,
      };
      if (role === "legacy_fact" || role === "log") entry.no_event_boundary = true;
      sources.push(entry);
    }

    // ⑤ 图纸历史：每条基线的两份修订**物化**进备份（git_blob 也落成不可变副本）
    const documents: BackupDocumentEntry[] = [];
    for (const b of baselineLog.baselines) {
      const design = materializeRevision(projectRoot, destWorkbench, "design", b.design_revision);
      const plan = materializeRevision(projectRoot, destWorkbench, "plan", b.plan_revision);
      documents.push({
        baseline_id: b.baseline_id,
        active_at: b.active_at,
        approved_by: b.approved_by,
        approval_basis: b.approval_basis,
        approval_kind: b.approval_kind,
        supersedes: b.supersedes,
        design,
        plan,
      });
    }
    for (const d of documents) {
      for (const rev of [d.design, d.plan]) {
        const relInBackup = toBackupRel(rev.recovery.ref);
        if (!sources.some((s) => s.rel_path === relInBackup)) {
          const bytes = fs.readFileSync(path.join(destWorkbench, relInBackup));
          sources.push({
            rel_path: relInBackup,
            role: "document_history",
            sha256: sha256Hex(bytes),
            bytes: bytes.length,
            version: rev.recovery.sha256,
          });
        }
      }
    }

    // ⑥ 证据清单（内容寻址、不可变；被截止序号以内事件引用到的那些是闭包里的必存项）
    const evidence: BackupEvidenceEntry[] = [];
    for (const e of sourceEvidence) {
      const relInBackup = `work/${EVIDENCE_DIRNAME}/${e.evidence_id}.json`;
      const destAbs = path.join(destWorkbench, relInBackup);
      if (!fs.existsSync(destAbs)) copyInto(evidenceBlobPath(workDir, e.evidence_id), destAbs);
      const back = readEvidence(destWorkDir, e.evidence_id);
      evidence.push({
        evidence_id: back.evidence_id,
        sha256: back.sha256,
        bytes: back.bytes,
        recovery_path: back.recovery_path,
        kind: back.kind,
        summary: back.summary,
        referenced_by_events: referenced.includes(e.evidence_id),
      });
      if (!sources.some((s) => s.rel_path === relInBackup)) {
        const bytes = fs.readFileSync(destAbs);
        sources.push({
          rel_path: relInBackup,
          role: "evidence",
          sha256: sha256Hex(bytes),
          bytes: bytes.length,
          version: back.sha256,
        });
      }
    }

    const manifest: BackupManifest = {
      backup_format: BACKUP_FORMAT_VERSION,
      schema_version: SCHEMA_VERSION,
      project_id: projectId,
      taken_at: takenAt,
      cutoff_seq: last_seq,
      event_count: events.length,
      active_baseline_id: baselineLog.baselines.at(-1)?.baseline_id ?? null,
      workbench_dir: BACKUP_WORKBENCH_DIR,
      sources: sources.sort((a, b) => a.rel_path.localeCompare(b.rel_path)),
      derived: sources.filter((s) => s.role === "derived").map((s) => s.rel_path),
      skipped,
      documents,
      evidence: evidence.sort((a, b) => a.evidence_id.localeCompare(b.evidence_id)),
      warnings,
    };
    fs.writeFileSync(
      path.join(destDir, BACKUP_MANIFEST_FILE),
      JSON.stringify(manifest, null, 2) + "\n",
      "utf8",
    );
    return manifest;
  });
}

/**
 * 恢复位置 → 本类图纸的**规范**不可变对象键（64 位十六进制小写），不是规范形状就返回 null。
 *
 * `baselines.jsonl` 是磁盘上的事实文件，`recovery.ref` 只是记录里的一个字符串（`readBaselineLog`
 * 只校验它是非空字符串，不管形状）——形状不对就不能拿去拼落点，否则备份会被写到备份目录之外。
 * 只接受 `<项目根>/.工作台/<kind>-revisions/<64 位十六进制>.md`，并核对 `recovery.key` 与文件名相符：
 *   · 设计书：文件名 = `content_sha256`（对象名本来就是内容哈希，§2.6）；
 *   · 施工图：文件名 = `definition_sha256`（§2.6 主名）或 `content_sha256`
 *     （同一定义哈希下的另一份正文，见 `documents.ts` 的 `revisionObjectCandidates`）。
 * 过检后由调用方**按白名单重建路径**（只留这 64 位十六进制），记录里的路径字符一个都进不了落点。
 */
function immutableObjectKeyOf(
  kind: DocumentKind,
  ref: { recovery: DocumentRecovery; content_sha256: string; definition_sha256: string },
): string | null {
  const norm = ref.recovery.ref.replace(/\\/g, "/");
  const dir = kind === "design" ? DESIGN_REVISIONS_DIR : PLAN_REVISIONS_DIR;
  const prefix = `${WORKBENCH_DIRNAME}/${dir}/`;
  if (!norm.startsWith(prefix)) return null;
  const name = norm.slice(prefix.length);
  if (!/^[0-9a-f]{64}\.md$/.test(name)) return null;
  const key = name.slice(0, -3);
  if (ref.recovery.key !== key) return null;
  const allowed = kind === "design" ? [ref.content_sha256] : [ref.definition_sha256, ref.content_sha256];
  return allowed.includes(key) ? key : null;
}

/** 把一份基线引用的修订物化进备份（git_blob → 不可变副本，逐字节复核） */
function materializeRevision(
  projectRoot: string,
  destWorkbench: string,
  kind: DocumentKind,
  ref: {
    recovery: DocumentRecovery;
    source_path: string;
    content_sha256: string;
    definition_sha256: string;
  },
): BackupRevisionEntry {
  // 落点跟着**记录里的恢复位置**走：不可变副本在哪，备份里就复制到哪（恢复端按 ref.ref 取原文，
  // 位置一挪就对不上）。恢复位置先过规范形状校验，再按白名单重建；git_blob 没有项目内路径，按哈希推。
  const key = kind === "design" ? ref.content_sha256 : ref.definition_sha256;
  let rel: string;
  if (ref.recovery.kind === "immutable_copy") {
    const objectKey = immutableObjectKeyOf(kind, ref);
    if (objectKey === null) {
      bad(
        `基线记的修订恢复位置不是本类图纸的规范不可变对象（${ref.recovery.ref}）：只接受 ` +
          `${WORKBENCH_DIRNAME}/${kind === "design" ? DESIGN_REVISIONS_DIR : PLAN_REVISIONS_DIR}/` +
          "<64 位十六进制>.md 且 key 与文件名相符——不拿一个来路不明的路径去拼备份落点",
        { ref: ref.recovery.ref, kind, reason: "revision_object_ref_invalid" },
      );
    }
    rel = revisionObjectRel(kind, objectKey);
  } else {
    rel = revisionObjectRel(kind, key);
  }
  const destAbs = path.join(destWorkbench, toBackupRel(rel));

  let bytes: Buffer;
  if (ref.recovery.kind === "immutable_copy") {
    const srcAbs = path.join(projectRoot, rel);
    if (!fs.existsSync(srcAbs)) {
      bad(
        `基线引用的不可变修订副本不在项目里（${ref.recovery.ref}）：先把原文取回来再备份，` +
          "不产生一份「基线指向取不回的原文」的备份",
        { ref: ref.recovery.ref, reason: "revision_object_missing" },
      );
    }
    fs.mkdirSync(path.dirname(destAbs), { recursive: true });
    fs.copyFileSync(srcAbs, destAbs);
    bytes = fs.readFileSync(destAbs);
  } else {
    // git_blob：用已交付的取回接口读出来，在备份里落成不可变副本（备份不依赖原项目 Git）
    bytes = recoverRevision(projectRoot, ref.recovery).bytes;
    fs.mkdirSync(path.dirname(destAbs), { recursive: true });
    fs.writeFileSync(destAbs, bytes);
  }
  if (sha256Hex(bytes) !== ref.content_sha256) {
    bad(`物化后的修订内容与基线记录不一致（${rel}）`, {
      ref: rel,
      reason: "revision_materialize_mismatch",
    });
  }
  return {
    kind,
    source_path: ref.source_path,
    content_sha256: ref.content_sha256,
    definition_sha256: ref.definition_sha256,
    bytes: bytes.length,
    recovery: { kind: "immutable_copy", ref: rel, key, sha256: ref.content_sha256 },
    original_recovery: ref.recovery,
  };
}

// ── 核验 ──

export interface BackupCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface BackupVerification {
  ok: boolean;
  backup_dir: string;
  manifest: BackupManifest | null;
  checks: BackupCheck[];
  failures: { code: string; message: string }[];
  /** 通过核验时给出的一致切片摘要：截止序号 */
  cutoff_seq: number | null;
  fact_count: number;
  derived_count: number;
  evidence_count: number;
  document_count: number;
}

function readManifest(backupDir: string): BackupManifest {
  const file = path.join(backupDir, BACKUP_MANIFEST_FILE);
  if (!fs.existsSync(file)) {
    throw new WorkError(
      "INVALID_COMMAND",
      `这不是一份备份：缺 ${BACKUP_MANIFEST_FILE}（只有清单 + 各事实源版本哈希才能证明"某个提交序号的一致切片"）。` +
        "裸目录副本**不构成**通过的备份（§8.5：不能把复制半份目录当通过）",
      { backup_dir: backupDir, reason: "manifest_missing" },
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new WorkError("INVALID_COMMAND", `备份清单不是合法 JSON：${(e as Error).message}`, {
      backup_dir: backupDir,
      reason: "manifest_invalid",
    });
  }
  const m = raw as BackupManifest;
  if (
    m?.backup_format !== BACKUP_FORMAT_VERSION ||
    typeof m.cutoff_seq !== "number" ||
    !Array.isArray(m.sources)
  ) {
    throw new WorkError("INVALID_COMMAND", "备份清单格式不符（backup_format / cutoff_seq / sources）", {
      backup_dir: backupDir,
      reason: "manifest_invalid",
    });
  }
  return m;
}

/**
 * 核验一份备份是不是"某个提交序号的一致切片"。
 *
 * 八条判据（每条独立可复现，失败原因逐条给出）：
 *   ① 清单存在且可解析（裸目录副本在这里就被判不合格）；
 *   ② 清单里每份文件的 sha256/字节数与实物相符（**损坏**在这里暴露）；
 *   ③ 反向：备份里的事实类文件都在清单里（"事后塞进来一份"在这里暴露）；
 *   ④ 事件可重放、无半截尾行，重放出的 `last_seq` **等于**清单记的 `cutoff_seq`（**跨时刻拼接**在这里暴露）；
 *   ⑤ 证据引用闭合：事件引用到的证据正文都在且哈希相符（**缺证据**在这里暴露，不把缺失当空列表）；
 *   ⑥ 图纸历史闭合：每份基线的两份修订都能在备份内按恢复位置取回且哈希相符（**旧基线缺历史**在这里暴露）；
 *   ⑦ 缓存可重建：由事件重放出快照成功、`last_seq` 一致（派生数据可重建，事实不依赖它）；
 *   ⑧ 捕获时记下的警告为空（源本身就不完整时不静默通过）。
 */
export function verifyBackup(backupDir: string): BackupVerification {
  const checks: BackupCheck[] = [];
  const failures: { code: string; message: string }[] = [];
  const check = (name: string, ok: boolean, detail: string, code?: string): void => {
    checks.push({ name, ok, detail });
    if (!ok) failures.push({ code: code ?? name, message: detail });
  };
  const empty: BackupVerification = {
    ok: false,
    backup_dir: backupDir,
    manifest: null,
    checks,
    failures,
    cutoff_seq: null,
    fact_count: 0,
    derived_count: 0,
    evidence_count: 0,
    document_count: 0,
  };

  let manifest: BackupManifest;
  try {
    manifest = readManifest(backupDir);
    check(
      "①清单可解析",
      true,
      `backup_format=${manifest.backup_format} cutoff_seq=${manifest.cutoff_seq} schema_version=${manifest.schema_version}`,
    );
  } catch (e) {
    check("①清单可解析", false, (e as Error).message, "MANIFEST_INVALID");
    return empty;
  }

  const workbench = backupWorkbenchDir(backupDir);
  const workDirInBackup = path.join(workbench, "work");

  // ② 清单 ↔ 实物（损坏、被改写）
  const hashFailures: string[] = [];
  for (const s of manifest.sources) {
    const abs = path.join(workbench, s.rel_path);
    if (!fs.existsSync(abs)) {
      hashFailures.push(`${s.rel_path}：清单里有、备份里没有`);
      continue;
    }
    const bytes = fs.readFileSync(abs);
    const got = sha256Hex(bytes);
    if (got !== s.sha256 || bytes.length !== s.bytes) {
      hashFailures.push(
        `${s.rel_path}：sha256/字节数与清单不符（清单 ${s.sha256.slice(0, 12)}…/${s.bytes}B，实物 ${got.slice(0, 12)}…/${bytes.length}B）`,
      );
    }
  }
  check(
    "②清单哈希与实物相符",
    hashFailures.length === 0,
    hashFailures.length === 0
      ? `${manifest.sources.length} 份文件逐份相符`
      : hashFailures.slice(0, 6).join("；"),
    "MANIFEST_HASH_MISMATCH",
  );

  // ③ 备份里的事实类文件都在清单里（跨时刻"多塞一份"）
  const listed = new Set(manifest.sources.map((s) => s.rel_path));
  const unlisted: string[] = [];
  if (fs.existsSync(workDirInBackup)) {
    for (const f of walkAll(workDirInBackup)) {
      const rel = `work/${f.rel}`;
      const role = classifyFact(rel);
      if (typeof role === "object" || role === "derived" || role === "evidence") continue;
      if (!listed.has(rel)) unlisted.push(rel);
    }
  }
  for (const rel of [BASELINES_FILE]) {
    if (fs.existsSync(path.join(workbench, rel)) && !listed.has(rel)) unlisted.push(rel);
  }
  for (const dir of [DESIGN_REVISIONS_DIR, PLAN_REVISIONS_DIR]) {
    for (const f of walkAll(path.join(workbench, dir))) {
      const rel = `${dir}/${f.rel}`;
      if (!listed.has(rel)) unlisted.push(rel);
    }
  }
  for (const f of walkAll(path.join(workbench, "work", EVIDENCE_DIRNAME))) {
    const rel = `work/${EVIDENCE_DIRNAME}/${f.rel}`;
    if (!listed.has(rel)) unlisted.push(rel);
  }
  check(
    "③事实类文件都在清单里",
    unlisted.length === 0,
    unlisted.length === 0 ? "无未登记的事实文件" : `未登记：${unlisted.slice(0, 6).join("、")}`,
    "UNLISTED_FACT_FILE",
  );

  // ④ 事件重放 + 截止序号一致
  let replayOk = true;
  let replayDetail = "";
  let lastSeq = 0;
  let events: WorkEvent[] = [];
  try {
    if (manifest.cutoff_seq > 0 && !fs.existsSync(path.join(workDirInBackup, EVENTS_FILE))) {
      replayOk = false;
      replayDetail = `清单记的截止序号是 ${manifest.cutoff_seq}，但备份里没有 work/${EVENTS_FILE}`;
    } else {
      const loaded = fs.existsSync(path.join(workDirInBackup, EVENTS_FILE))
        ? loadEvents(workDirInBackup)
        : { events: [] as WorkEvent[], tail: null };
      if (loaded.tail !== null) {
        replayOk = false;
        replayDetail = `事件文件有半截尾行（第 ${loaded.tail.line} 行）——不是一个收敛的提交边界`;
      } else {
        events = loaded.events;
        lastSeq = replayEvents(events).last_seq;
        if (lastSeq !== manifest.cutoff_seq) {
          replayOk = false;
          replayDetail =
            `重放得到的 last_seq=${lastSeq} ≠ 清单记的 cutoff_seq=${manifest.cutoff_seq}` +
            "——这是一份**跨时刻拼接**的半份备份（事件取自另一个时间点）";
        } else if (events.length !== manifest.event_count) {
          replayOk = false;
          replayDetail = `事件条数 ${events.length} ≠ 清单记的 ${manifest.event_count}`;
        } else {
          replayDetail = `重放通过：${events.length} 条事件，last_seq=${lastSeq} = cutoff_seq`;
        }
      }
    }
  } catch (e) {
    replayOk = false;
    replayDetail = `事件重放失败：${(e as Error).message}`;
  }
  check("④事件可重放且截止序号一致", replayOk, replayDetail, "CUTOFF_MISMATCH");

  // ⑤ 证据引用闭合
  const evidenceFailures: string[] = [];
  const referenced = evidenceRefsOfEvents(events);
  const listedEvidence = new Set(manifest.evidence.map((e) => e.evidence_id));
  for (const sha of referenced) {
    if (!listedEvidence.has(sha)) {
      evidenceFailures.push(`事件引用的证据 ${sha} 不在备份的证据清单里`);
    }
  }
  for (const e of manifest.evidence) {
    try {
      const blob = readEvidence(workDirInBackup, e.evidence_id);
      if (blob.sha256 !== e.sha256) {
        evidenceFailures.push(`${e.evidence_id}：读回的 sha256 与清单不符`);
      }
    } catch (err) {
      evidenceFailures.push(`清单登记的证据 ${e.evidence_id} 读不出来：${(err as Error).message}`);
    }
  }
  check(
    "⑤证据引用闭合且哈希相符",
    evidenceFailures.length === 0,
    evidenceFailures.length === 0
      ? `事件引用 ${referenced.length} 份、清单登记 ${manifest.evidence.length} 份，全部哈希相符`
      : evidenceFailures.slice(0, 6).join("；"),
    "EVIDENCE_MISSING",
  );

  // ⑥ 图纸历史闭合
  const docFailures: string[] = [];
  const baselinesFile = path.join(workbench, BASELINES_FILE);
  if (manifest.documents.length > 0 && !fs.existsSync(baselinesFile)) {
    docFailures.push(`清单记了 ${manifest.documents.length} 条基线，但备份里没有 ${BASELINES_FILE}`);
  } else if (fs.existsSync(baselinesFile)) {
    const ids = fs
      .readFileSync(baselinesFile, "utf8")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l !== "")
      .map((l) => {
        try {
          return (JSON.parse(l) as { baseline_id?: string }).baseline_id ?? "";
        } catch {
          return "<坏行>";
        }
      });
    const listedIds = manifest.documents.map((d) => d.baseline_id);
    for (const id of ids) {
      if (!listedIds.includes(id)) docFailures.push(`基线流水里的 ${id} 不在清单的图纸历史里`);
    }
    const lastId = ids.at(-1) ?? null;
    if (lastId !== manifest.active_baseline_id) {
      docFailures.push(
        `基线流水末条是 ${lastId}，清单记的生效基线是 ${manifest.active_baseline_id}` +
          "——图纸历史来自另一个时间点",
      );
    }
  }
  for (const d of manifest.documents) {
    for (const rev of [d.design, d.plan]) {
      const abs = path.join(workbench, toBackupRel(rev.recovery.ref));
      if (!fs.existsSync(abs)) {
        docFailures.push(`基线 ${d.baseline_id} 的 ${rev.kind} 修订恢复位置不存在：${rev.recovery.ref}`);
        continue;
      }
      const got = sha256Hex(fs.readFileSync(abs));
      if (got !== rev.recovery.sha256) {
        docFailures.push(
          `基线 ${d.baseline_id} 的 ${rev.kind} 修订与恢复位置不符（期望 ${rev.recovery.sha256.slice(0, 12)}…，实际 ${got.slice(0, 12)}…）`,
        );
      }
    }
  }
  check(
    "⑥图纸历史闭合（基线 ↔ 修订恢复位置）",
    docFailures.length === 0,
    docFailures.length === 0
      ? `${manifest.documents.length} 条基线、${manifest.documents.length * 2} 份修订原文可定位且哈希相符`
      : docFailures.slice(0, 6).join("；"),
    "BASELINE_REVISION_MISSING",
  );

  // ⑦ 缓存可重建
  let cacheOk = false;
  let cacheDetail = "";
  try {
    const snapshot = buildSnapshot(manifest.project_id, events, null, "1970-01-01T00:00:00.000Z");
    cacheOk = snapshot.last_seq === manifest.cutoff_seq;
    cacheDetail = cacheOk
      ? `由事件重放出的快照 last_seq=${snapshot.last_seq}、实体 ${Object.keys(snapshot.entities).length} 个——派生的 ${STATE_FILE} 可由事实重建`
      : `重放快照 last_seq=${snapshot.last_seq} ≠ ${manifest.cutoff_seq}`;
  } catch (e) {
    cacheDetail = `缓存重建失败：${(e as Error).message}`;
  }
  check("⑦缓存可由事件重建", cacheOk, cacheDetail, "CACHE_NOT_REBUILDABLE");

  // ⑧ 捕获时的警告（源侧本身就缺证据）——不静默通过
  check(
    "⑧捕获时无未解决警告",
    manifest.warnings.length === 0,
    manifest.warnings.length === 0 ? "无" : manifest.warnings.slice(0, 6).join("；"),
    "CAPTURE_WARNING",
  );

  const ok = failures.length === 0;
  return {
    ok,
    backup_dir: backupDir,
    manifest,
    checks,
    failures: ok ? [] : failures,
    cutoff_seq: ok ? manifest.cutoff_seq : null,
    fact_count: manifest.sources.filter((s) => s.role === "fact" || s.role === "legacy_fact").length,
    derived_count: manifest.derived.length,
    evidence_count: manifest.evidence.length,
    document_count: manifest.documents.length,
  };
}

// ── 恢复（只在隔离目录；不自动替换真实数据）──

export interface RestoreReport {
  ok: boolean;
  backup_dir: string;
  /** 隔离恢复目录（被当成一个独立的"项目根"用） */
  dest_root: string;
  cutoff_seq: number;
  verification: BackupVerification;
  /** 恢复后的逐项核验（前置的切片核验 + R1–R4） */
  checks: BackupCheck[];
  failures: { code: string; message: string }[];
  /** 恢复出的事实（供人工核对） */
  facts: {
    events_replayed: number;
    entities: number;
    documents_recovered: { baseline_id: string; kind: DocumentKind; sha256: string; bytes: number }[];
    evidence_hash_checked: { evidence_id: string; sha256: string; bytes: number }[];
    cache_rebuilt: { last_seq: number; entities: number; state_path: string };
  } | null;
  /** 本模块**不**替换真实数据：是否替换由用户决定（§8.5） */
  replace_requires_user: true;
  replaced: false;
}

/**
 * 把一份备份恢复到**隔离目录**并核验（不碰原项目一个字节）。
 *
 * 恢复 = 核验一致切片 → 复制到隔离目录 → 逐项复核：
 *   · **原文可定位**（R1）：每条基线的设计/施工修订按恢复位置取回，哈希相符；
 *   · **证据哈希相符**（R2）：每份证据正文读回并复核内容地址；
 *   · **事件可重放**（R3）：重放得到与清单一致的 `cutoff_seq`；
 *   · **缓存可重建**（R4）：在隔离目录里由事件重建 `state.json`（派生数据，事实不依赖它）。
 * 之后**由用户决定是否替换**当前数据；本函数返回 `replaced: false`。
 */
export function restoreBackup(backupDir: string, destRoot: string): RestoreReport {
  const checks: BackupCheck[] = [];
  const failures: { code: string; message: string }[] = [];
  const verification = verifyBackup(backupDir);
  checks.push(...verification.checks);
  failures.push(...verification.failures);
  const add = (name: string, ok: boolean, detail: string, code = name): void => {
    checks.push({ name, ok, detail });
    if (!ok) failures.push({ code, message: detail });
  };
  const fail = (detail: string, code: string): RestoreReport => ({
    ok: false,
    backup_dir: backupDir,
    dest_root: destRoot,
    cutoff_seq: verification.manifest?.cutoff_seq ?? 0,
    verification,
    checks,
    failures: [...failures, { code, message: detail }],
    facts: null,
    replace_requires_user: true,
    replaced: false,
  });

  const manifest = verification.manifest;
  if (manifest === null || !verification.ok) {
    return fail("备份未通过一致性核验，恢复中止（不把不合格的切片恢复成现场）", "RESTORE_SOURCE_INVALID");
  }
  if (fs.existsSync(destRoot)) {
    add("恢复目标", false, `恢复目标已存在，不覆盖：${destRoot}`, "DEST_EXISTS");
    return fail(`恢复目标已存在，不覆盖：${destRoot}`, "DEST_EXISTS");
  }

  fs.mkdirSync(destRoot, { recursive: true });
  fs.cpSync(backupWorkbenchDir(backupDir), path.join(destRoot, WORKBENCH_DIRNAME), { recursive: true });
  add(
    "复制到隔离目录",
    true,
    `恢复出 ${path.join(destRoot, WORKBENCH_DIRNAME)}（原项目未被写入一个字节）`,
  );
  const restoredWorkDir = path.join(destRoot, WORKBENCH_DIRNAME, "work");

  // R1 原文可定位
  const documentsRecovered: { baseline_id: string; kind: DocumentKind; sha256: string; bytes: number }[] = [];
  const docFailures: string[] = [];
  for (const d of manifest.documents) {
    for (const rev of [d.design, d.plan]) {
      try {
        const got = recoverRevision(destRoot, rev.recovery);
        const sha = sha256Hex(got.bytes);
        if (sha !== rev.recovery.sha256) {
          docFailures.push(`${d.baseline_id}/${rev.kind} 取回的原文哈希不符`);
          continue;
        }
        documentsRecovered.push({
          baseline_id: d.baseline_id,
          kind: rev.kind,
          sha256: sha,
          bytes: got.bytes.length,
        });
      } catch (e) {
        docFailures.push(`${d.baseline_id}/${rev.kind} 取不回原文：${(e as Error).message}`);
      }
    }
  }
  add(
    "R1原文可定位（设计/施工修订按恢复位置取回）",
    docFailures.length === 0,
    docFailures.length === 0
      ? `${documentsRecovered.length} 份修订原文取回且哈希相符`
      : docFailures.slice(0, 4).join("；"),
    "RESTORE_DOCUMENT_UNRECOVERABLE",
  );

  // R2 证据哈希相符
  const evidenceChecked: { evidence_id: string; sha256: string; bytes: number }[] = [];
  const evFailures: string[] = [];
  for (const e of manifest.evidence) {
    try {
      const blob = readEvidence(restoredWorkDir, e.evidence_id);
      if (blob.sha256 !== e.sha256) {
        evFailures.push(`${e.evidence_id} 内容地址不符`);
        continue;
      }
      evidenceChecked.push({ evidence_id: blob.evidence_id, sha256: blob.sha256, bytes: blob.bytes });
    } catch (err) {
      evFailures.push(`${e.evidence_id} 读不出来：${(err as Error).message}`);
    }
  }
  add(
    "R2证据哈希相符",
    evFailures.length === 0,
    evFailures.length === 0 ? `${evidenceChecked.length} 份证据正文复核通过` : evFailures.slice(0, 4).join("；"),
    "RESTORE_EVIDENCE_MISMATCH",
  );

  // R3 事件重放 + R4 缓存重建（在隔离目录里真写 state.json）
  let replayed = 0;
  let entities = 0;
  let cacheRebuilt = { last_seq: 0, entities: 0, state_path: path.join(restoredWorkDir, STATE_FILE) };
  try {
    const loaded = loadEvents(restoredWorkDir);
    const r = replayEvents(loaded.events);
    replayed = loaded.events.length;
    entities = Object.keys(r.entities).length;
    add(
      "R3事件可重放",
      r.last_seq === manifest.cutoff_seq,
      `重放 ${replayed} 条事件 → last_seq=${r.last_seq}（清单 ${manifest.cutoff_seq}），实体 ${entities} 个`,
      "RESTORE_REPLAY_MISMATCH",
    );
    const snapshot = buildSnapshot(manifest.project_id, loaded.events, null);
    writeSnapshot(restoredWorkDir, snapshot);
    const back = JSON.parse(fs.readFileSync(path.join(restoredWorkDir, STATE_FILE), "utf8")) as {
      last_seq: number;
      entities: Record<string, unknown>;
    };
    cacheRebuilt = {
      last_seq: back.last_seq,
      entities: Object.keys(back.entities).length,
      state_path: path.join(restoredWorkDir, STATE_FILE),
    };
    add(
      "R4缓存可由事件重建",
      back.last_seq === manifest.cutoff_seq && Object.keys(back.entities).length === entities,
      `隔离目录里重建 ${STATE_FILE}：last_seq=${back.last_seq}、实体 ${Object.keys(back.entities).length} 个（事实不依赖缓存）`,
      "RESTORE_CACHE_NOT_REBUILT",
    );
  } catch (e) {
    add("R3事件可重放", false, `重放失败：${(e as Error).message}`, "RESTORE_REPLAY_FAILED");
    add("R4缓存可由事件重建", false, "事件都重放不了，缓存无从重建", "RESTORE_CACHE_NOT_REBUILT");
  }

  const ok = failures.length === 0;
  return {
    ok,
    backup_dir: backupDir,
    dest_root: destRoot,
    cutoff_seq: manifest.cutoff_seq,
    verification,
    checks,
    failures: ok ? [] : failures,
    facts: {
      events_replayed: replayed,
      entities,
      documents_recovered: documentsRecovered,
      evidence_hash_checked: evidenceChecked,
      cache_rebuilt: cacheRebuilt,
    },
    replace_requires_user: true,
    replaced: false,
  };
}

// ── 与"当前项目"对照（恢复旧备份前先看清落后多少；只读）──

export interface BackupComparison {
  backup_cutoff_seq: number;
  live_last_seq: number | null;
  /** 当前项目领先备份多少个提交（0 = 同一提交边界；null = 当前事件读不出来） */
  live_ahead: number | null;
  backup_baseline_id: string | null;
  live_baseline_id: string | null;
  baseline_changed: boolean;
  /** 当前图纸源是否已经不再是备份里那份（旧基线场景） */
  source_changed: boolean;
  note: string;
}

/** 只读对照：备份 vs 当前项目（不写任何东西；恢复决策由用户做） */
export function compareBackupToLive(
  backupDir: string,
  projectId: string,
  dataDir?: string,
): BackupComparison {
  const manifest = readManifest(backupDir);
  const workDir = path.join(projectWorkbenchDir(projectId, dataDir), "work");
  let liveLastSeq: number | null = null;
  try {
    liveLastSeq = replayEvents(loadEvents(workDir).events).last_seq;
  } catch {
    liveLastSeq = null;
  }
  const liveBaseline = readBaselineLog(projectId, dataDir).baselines.at(-1) ?? null;
  const backupActive =
    manifest.documents.find((d) => d.baseline_id === manifest.active_baseline_id) ?? null;
  const sourceChanged =
    backupActive === null
      ? false
      : liveBaseline === null
        ? true
        : liveBaseline.design_revision.content_sha256 !== backupActive.design.content_sha256 ||
          liveBaseline.plan_revision.definition_sha256 !== backupActive.plan.definition_sha256;
  const liveAhead = liveLastSeq === null ? null : liveLastSeq - manifest.cutoff_seq;
  const note =
    liveAhead === null
      ? "当前项目的事件读不出来（现场未收敛），恢复前先核对现场"
      : liveAhead > 0
        ? `当前项目领先备份 ${liveAhead} 个提交：恢复这份备份会**丢掉这 ${liveAhead} 个提交**，是否替换由用户决定（本模块不自动替换）`
        : liveAhead === 0
          ? "当前项目与备份在同一提交边界上"
          : `备份领先当前 ${-liveAhead} 个提交（当前项目曾是回滚过的现场）：恢复前先核实现场`;
  return {
    backup_cutoff_seq: manifest.cutoff_seq,
    live_last_seq: liveLastSeq,
    live_ahead: liveAhead,
    backup_baseline_id: manifest.active_baseline_id,
    live_baseline_id: liveBaseline?.baseline_id ?? null,
    baseline_changed: (liveBaseline?.baseline_id ?? null) !== manifest.active_baseline_id,
    source_changed: sourceChanged,
    note,
  };
}

// ── 列举与占用 ──

export interface BackupListEntry {
  backup_id: string;
  dir: string;
  manifest: BackupManifest | null;
  error: string | null;
}

/** 列举某项目的备份（读不出来/清单坏了如实报出，不当不存在） */
export function listProjectBackups(projectId: string, dataDir?: string): BackupListEntry[] {
  const root = backupRoot(dataDir ?? resolveDataDir(), projectId);
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const dir = path.join(root, e.name);
      try {
        return { backup_id: e.name, dir, manifest: readManifest(dir), error: null };
      } catch (err) {
        return { backup_id: e.name, dir, manifest: null, error: (err as Error).message };
      }
    })
    .sort((a, b) => b.backup_id.localeCompare(a.backup_id));
}

/** 备份目录的字节数与文件数 */
export function backupDiskUsage(backupDir: string): { total_bytes: number; files: number } {
  let total = 0;
  let files = 0;
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.isFile()) {
        files++;
        total += fs.statSync(abs).size;
      }
    }
  };
  if (fs.existsSync(backupDir)) walk(backupDir);
  return { total_bytes: total, files };
}
