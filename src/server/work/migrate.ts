// v1 → v2 迁移（PLAN.md V06-03，DESIGN.md §2.6 / §5.4 / §8.5）。
//
// 本卡**只服务隔离夹具**（DESIGN.md §2.6 硬口径：真实项目要等 V06-10 的认领/兼容写入口交付并验证通过、
// 且在对应项目授权内才可切换）。所以每个入口都要调用方**显式声明** `isolated: true`；
// 缺这个声明一律拒，错误里说清"真实项目迁移当前不允许，切换前继续 v1 与 §6.6 过渡"。
//
// 五个动作（卡内检查项 2）：
//   preview  —— 列出将发生什么（逐条事件的映射、幂等键、预期版本），**一个字节都不落盘**；
//   backup   —— 迁移前把 `.工作台/` 下的原文件整份备份到 `.工作台/work/migration-backup/<时间戳>/`，
//               并写 `manifest.json`（逐文件字节数 + sha256）；
//   apply    —— 经**唯一写入者** `WorkService` 提交事件（不自己追加事件文件），再写兼容投影
//               `.工作台/tasks.json`（带 `projection_of` 标记与 `last_seq`）；
//   validate —— 备份可用性 + 事件↔台账一致 + 投影标记 + 取消标记，逐条给结论；
//   rollback —— 从备份**逐字节**恢复原文件（连行尾与字段顺序一起还原），把 v2 事件文件移进
//               `work/migration-archived/<时间戳>/`（**不删事实**），此后旧写口重新可用。
//
// 映射口径（§5.4，逐条写在 `V1_STATUS_MAPPING` 里）：
//   未提交的待准备        → todo
//   认领 / 执行中         → doing      → v2 `executing`
//   **已提交结果**        → done       → v2 `result_submitted`（**只到这里，绝不升级成"已交付/已验收"**）
//   阻塞                  → blocked
//   取消                  → 只在原文件带明确取消标记时映射（v1 四态本身没有取消位，不猜）
import fs from "node:fs";
import path from "node:path";
import { nowIso } from "../time";
import { withFileLock } from "../fileLock";
import { resolveDataDir } from "../registry";
import { projectWorkDir, workstationDir } from "../workstation";
import { WorkError } from "./types";
import { WorkService } from "./service";
import { buildSnapshot, eventsPath, loadEvents, readSnapshotFromDisk, writeSnapshot } from "./eventStore";
import { sha256Hex } from "./plan";
import {
  TASK_STATUS_LABELS,
  hasV2ProjectionMarker,
  readTaskStates,
  taskEntityId,
  buildCompatTasksProjection,
  writeCompatTasksProjection,
  type CompatTasksFile,
  type TaskEventType,
  type TaskExecutionStatus,
  type WorkSubmitter,
} from "./tasks";

export const MIGRATION_BACKUP_DIRNAME = "migration-backup";
export const MIGRATION_ARCHIVE_DIRNAME = "migration-archived";
export const MIGRATION_MANIFEST_FILE = "manifest.json";

/** v1 四态 → v2 执行状态（§5.4 的唯一映射表；`done` 的最强含义到此为止） */
export const V1_STATUS_MAPPING: Readonly<
  Record<"todo" | "doing" | "done" | "blocked", { status: TaskExecutionStatus; note: string }>
> = {
  todo: {
    status: "preparing",
    note: "§5.4：未提交的待准备/就绪映射 todo（v1 没有就绪位，只能到「待准备」）",
  },
  doing: {
    status: "executing",
    note: "§5.4：认领/执行中映射 doing（v1 不区分认领与在跑）",
  },
  done: {
    status: "result_submitted",
    note: "§5.4/§2.6：done 只映射成「结果已提交」——不补造审计结论，也不写人工验收",
  },
  blocked: {
    status: "blocked",
    note: "§5.4：阻塞映射 blocked",
  },
};

/** 取消的映射口径（v1 四态没有取消位，只在原文件有明确标记时迁移） */
export const CANCEL_MAPPING_NOTE =
  "v1 四态没有取消位：只有任务条目带明确取消标记（cancelled=true 或 status=\"cancelled\"）才按取消迁移，否则不猜";

/** 迁移一律产出的台账备份（`.工作台/` 下的一层文件；`work/` 目录是 v2 自己的，不进备份清单） */

export interface MigrationOptions {
  /** **必须显式给 true**：声明这是隔离夹具（V06-03 交付时只迁移隔离夹具） */
  isolated?: boolean;
  /**
   * V07-03 真实项目迁移授权：V06-10 的认领/兼容写入口已交付验证，真实切换解锁。
   * 显式声明"这不是夹具，是经用户授权的真实切换"——authorized_by/basis 原样写进备份
   * manifest（留痕可查）。两者与 isolated 至少给一个，缺一概拒。
   */
  real?: { authorized_by: string; basis: string };
}

function assertMigrationScope(what: string, opts: MigrationOptions | undefined): void {
  if (opts?.isolated === true) return;
  const r = opts?.real;
  if (
    r !== undefined &&
    typeof r.authorized_by === "string" && r.authorized_by.trim() !== "" &&
    typeof r.basis === "string" && r.basis.trim() !== ""
  ) {
    return;
  }
  throw new WorkError(
    "INVALID_COMMAND",
    `${what} 拒绝：迁移工具默认只服务隔离夹具。` +
      "真实项目切换 v2（V07-03 解锁）必须显式传 real:{authorized_by,basis}——授权人与依据会写进备份 manifest 留痕；" +
      "确认是隔离夹具请显式传 isolated:true。缺声明一律不动真实项目（DESIGN.md §2.6）",
    { reason: "real_project_migration_not_allowed" },
  );
}

// ── 路径 ──

export const workbenchDirOf = (projectId: string, dataDir?: string): string =>
  workstationDir(projectId, dataDir);
export const migrationRoot = (projectId: string, dataDir?: string): string =>
  path.join(projectWorkDir(projectId, dataDir), MIGRATION_BACKUP_DIRNAME);
export const archiveRoot = (projectId: string, dataDir?: string): string =>
  path.join(projectWorkDir(projectId, dataDir), MIGRATION_ARCHIVE_DIRNAME);
export const tasksFileOf = (projectId: string, dataDir?: string): string =>
  path.join(workbenchDirOf(projectId, dataDir), "tasks.json");

const stamp = (): string => nowIso().replace(/[:.]/g, "-");

/**
 * 时间戳目录名（秒级）：同一秒里连做两次自动备份会撞名，故撞了就加 `-2`、`-3`…后缀。
 * 调用方**显式给了 backupId** 时不走这里——那种情况撞名要硬报错，不能悄悄换目录。
 */
function uniqueStampDir(root: string): string {
  const base = stamp();
  let id = base;
  for (let i = 2; fs.existsSync(path.join(root, id)); i++) id = `${base}-${i}`;
  return id;
}

// ── v1 台账读取（宽容读：迁移要能吃下旧四态 + 明确取消标记，非法结构照样报错） ──

export interface V1TaskSnapshot {
  id: string;
  title: string;
  module_id: string;
  /** 原样保留的 v1 状态值（含非四态的明确取消写法） */
  status: string;
  reporter: string;
  updated_at: string;
  note: string | null;
  /** 明确取消标记（字段或状态值） */
  cancelled: boolean;
  cancelled_reason: string | null;
  /** 原文条目（回滚与投影保留原始字段） */
  raw: Record<string, unknown>;
}

export interface V1Snapshot {
  project_id: string;
  /** `.工作台/` 下的原文件相对名（备份清单） */
  files: { rel: string; bytes: number; sha256: string }[];
  tasks_file_present: boolean;
  progress_file_present: boolean;
  tasks: V1TaskSnapshot[];
  /** tasks.json 原文字节（回滚比对用；不存在为 null） */
  tasks_raw_text: string | null;
  /** 已迁移标记（tasks.json 里带 v2 投影标记） */
  projection_marker: boolean;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** 读 `.工作台/` 里的一层文件清单（目录不进；`work/` 是 v2 自己的，排除） */
function listWorkbenchFiles(dir: string): { rel: string; abs: string }[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => ({ rel: e.name, abs: path.join(dir, e.name) }))
    .sort((a, b) => a.rel.localeCompare(b.rel));
}

export function readV1Snapshot(projectId: string, dataDir?: string): V1Snapshot {
  const bench = workbenchDirOf(projectId, dataDir);
  const files = listWorkbenchFiles(bench).map((f) => {
    const bytes = fs.readFileSync(f.abs);
    return { rel: f.rel, bytes: bytes.length, sha256: sha256Hex(bytes) };
  });
  const tasksAbs = path.join(bench, "tasks.json");
  const present = fs.existsSync(tasksAbs);
  const text = present ? fs.readFileSync(tasksAbs, "utf8") : null;
  const tasks: V1TaskSnapshot[] = [];
  let marker = false;
  if (text !== null) {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (e) {
      throw new WorkError("INVALID_COMMAND", `tasks.json 不是合法 JSON，迁移拒绝动它：${(e as Error).message}`, {
        reason: "v1_tasks_unparsable",
      });
    }
    if (!isObj(raw) || raw.version !== 1 || !Array.isArray(raw.tasks)) {
      throw new WorkError(
        "INVALID_COMMAND",
        "tasks.json 顶层必须是 { version: 1, tasks: [] }——迁移只认 v1 台账（v2 投影请用 rollback 或 validate）",
        { reason: "v1_tasks_shape" },
      );
    }
    marker = hasV2ProjectionMarker(raw);
    for (const t of raw.tasks) {
      if (!isObj(t)) {
        throw new WorkError("INVALID_COMMAND", "tasks.json 里有非对象条目，迁移拒绝继续", {
          reason: "v1_tasks_shape",
        });
      }
      const status = typeof t.status === "string" ? t.status : "";
      const cancelled = t.cancelled === true || status === "cancelled" || status === "取消";
      const reasonRaw = t.cancelled_reason ?? t.cancel_reason;
      tasks.push({
        id: String(t.id ?? ""),
        title: String(t.title ?? ""),
        module_id: String(t.module_id ?? ""),
        status,
        reporter: String(t.reporter ?? "unknown"),
        updated_at: String(t.updated_at ?? ""),
        note: typeof t.note === "string" && t.note !== "" ? t.note : null,
        cancelled,
        cancelled_reason: typeof reasonRaw === "string" && reasonRaw !== "" ? reasonRaw : null,
        raw: t,
      });
    }
  }
  return {
    project_id: projectId,
    files,
    tasks_file_present: present,
    progress_file_present: fs.existsSync(path.join(bench, "progress.json")),
    tasks,
    tasks_raw_text: text,
    projection_marker: marker,
  };
}

/** 项目是不是已经迁移过（读侧判据：台账带投影标记，或 work/events.jsonl 在场） */
export function isMigratedProject(projectId: string, dataDir?: string): boolean {
  try {
    const snap = readV1Snapshot(projectId, dataDir);
    if (snap.projection_marker) return true;
  } catch {
    // 台账读不动时不猜：下面按事件文件判
  }
  return fs.existsSync(eventsPath(projectWorkDir(projectId, dataDir)));
}

// ── 预览 ──

export interface MigrationEventPlan {
  task_id: string;
  entity_id: string;
  type: TaskEventType;
  v1_status: string;
  v2_status: TaskExecutionStatus;
  v2_status_label: string;
  payload: Record<string, unknown>;
  idempotency_key: string;
  expected_revision: number | null;
  /** 为什么这么映射（人话，直接可复核） */
  mapping_note: string;
}

export interface MigrationPreview {
  project_id: string;
  already_migrated: boolean;
  source_files: { rel: string; bytes: number; sha256: string }[];
  /** 将写入的事件（顺序即提交顺序） */
  events: MigrationEventPlan[];
  tasks: { v1: V1TaskSnapshot; status: TaskExecutionStatus | null; event: MigrationEventPlan | null; skip_reason: string | null }[];
  warnings: string[];
  cancel_mapping_note: string;
  mapping: typeof V1_STATUS_MAPPING;
  /** 备份将落到的相对项目根目录（模板；preview 不落盘） */
  backup_dir_rel_template: string;
  /** 迁移不改 progress.json 的口径说明 */
  progress_note: string;
}

/** 一条 v1 任务 → 事件计划（纯函数；preview 与 apply 共用同一口径，避免两套映射） */
function planOne(
  task: V1TaskSnapshot,
  expectedRevision: number | null,
  ctx: { backupRel: string },
): { event: MigrationEventPlan | null; status: TaskExecutionStatus | null; skip_reason: string | null } {
  if (task.id === "") return { event: null, status: null, skip_reason: "任务条目缺 id：不迁移（点名要人工补）" };
  if (task.cancelled) {
    const payload = {
      reason: task.cancelled_reason,
      cancelled: true,
      migrated_from: "v1.tasks.json",
      v1_status: task.status,
      v1_updated_at: task.updated_at,
      v1_reporter: task.reporter,
      migration: { backup: ctx.backupRel },
    };
    return {
      event: {
        task_id: task.id,
        entity_id: taskEntityId(task.id),
        type: "task.cancelled",
        v1_status: task.status,
        v2_status: "cancelled",
        v2_status_label: TASK_STATUS_LABELS.cancelled,
        payload,
        idempotency_key: `v1-migration:${task.id}:cancelled`,
        expected_revision: expectedRevision,
        mapping_note: CANCEL_MAPPING_NOTE,
      },
      status: "cancelled",
      skip_reason: null,
    };
  }
  const mapped = V1_STATUS_MAPPING[task.status as keyof typeof V1_STATUS_MAPPING];
  if (mapped === undefined) {
    return {
      event: null,
      status: null,
      skip_reason: `v1 状态 ${JSON.stringify(task.status)} 不在四态映射表里且没有取消标记：不猜，留给人工对齐（§5.4）`,
    };
  }
  const payload = {
    status: mapped.status,
    migrated_from: "v1.tasks.json",
    v1_status: task.status,
    v1_updated_at: task.updated_at,
    v1_reporter: task.reporter,
    ...(task.note === null ? {} : { note: task.note }),
    migration: { backup: ctx.backupRel },
  };
  return {
    event: {
      task_id: task.id,
      entity_id: taskEntityId(task.id),
      type: "task.status_changed",
      v1_status: task.status,
      v2_status: mapped.status,
      v2_status_label: TASK_STATUS_LABELS[mapped.status],
      payload,
      idempotency_key: `v1-migration:${task.id}:${task.status}`,
      expected_revision: expectedRevision,
      mapping_note: mapped.note,
    },
    status: mapped.status,
    skip_reason: null,
  };
}

/**
 * 预览迁移：列出将发生什么，**不落盘**（不建目录、不写备份、不写事件）。
 * 幂等键是确定性的（`v1-migration:<task>:<v1 状态>`），所以同一份台账 apply 两次不会造出重复状态。
 */
export function previewMigration(
  projectId: string,
  dataDir?: string,
  opts?: MigrationOptions,
): MigrationPreview {
  assertMigrationScope("迁移预览", opts);
  const snap = readV1Snapshot(projectId, dataDir);
  const workDir = projectWorkDir(projectId, dataDir);
  const { events } = loadEvents(workDir);
  const current = readTaskStates(workDir);
  const backupRel = `${path.join(".工作台", "work", MIGRATION_BACKUP_DIRNAME)}/<时间戳>`;

  const warnings: string[] = [];
  if (snap.projection_marker) warnings.push("tasks.json 已经带 v2 投影标记：本项目看起来已迁移过");
  if (!snap.tasks_file_present) warnings.push("没有 tasks.json：没有可迁移的 v1 任务台账（迁移会只写备份清单）");
  if (!snap.progress_file_present) warnings.push("没有 progress.json：备份清单里不会有它");

  const tasks = snap.tasks.map((v1) => {
    const expectedRevision = current.states[v1.id]?.revision ?? null;
    const { event, status, skip_reason } = planOne(v1, expectedRevision, { backupRel });
    return { v1, status, event, skip_reason };
  });
  const planned = tasks.map((t) => t.event).filter((e): e is MigrationEventPlan => e !== null);
  for (const t of tasks) {
    if (t.skip_reason !== null) warnings.push(`${t.v1.id || "(无 id)"}：${t.skip_reason}`);
  }
  if (planned.length !== tasks.length) {
    warnings.push(`有 ${tasks.length - planned.length} 条任务不会被迁移（见上）`);
  }

  return {
    project_id: projectId,
    already_migrated: isMigratedProject(projectId, dataDir),
    source_files: snap.files,
    events: planned,
    tasks,
    warnings,
    cancel_mapping_note: CANCEL_MAPPING_NOTE,
    mapping: V1_STATUS_MAPPING,
    backup_dir_rel_template: backupRel,
    progress_note:
      "progress.json 原样保留并备份：模块四色在迁移后不再由旧工具汇总（v1 写口已拒写），" +
      "自动状态投影按 DESIGN.md §2.6 留给状态投影卡（V06-09），本卡不伪造它",
  };
}

// ── 备份 ──

export interface MigrationBackup {
  backup_id: string;
  /** 相对项目根（如 `.工作台/work/migration-backup/2026-…`） */
  dir_rel: string;
  dir_abs: string;
  files: { rel: string; bytes: number; sha256: string }[];
  created_at: string;
}

export interface BackupManifest {
  schema: "tatai-migration-backup/1";
  project_id: string;
  backup_id: string;
  created_at: string;
  /** 被备份的原文件（逐字节哈希 + 大小） */
  files: { rel: string; bytes: number; sha256: string; copied_to: string }[];
  /** 迁移前已经存在的 v2 事件文件（如有）：也在备份里留一份，回滚时一并还原 */
  events_file: { bytes: number; sha256: string; copied_to: string } | null;
  /** V07-03 真实项目迁移授权留痕（夹具运行为 null） */
  authorization: { authorized_by: string; basis: string } | null;
}

/** 迁移前备份 `.工作台/` 原文件（整份复制 + manifest 逐字节哈希清单） */
export function backupV1Files(
  projectId: string,
  dataDir?: string,
  opts?: MigrationOptions & { backupId?: string },
): MigrationBackup {
  assertMigrationScope("迁移备份", opts);
  const bench = workbenchDirOf(projectId, dataDir);
  const backupId = opts?.backupId ?? uniqueStampDir(migrationRoot(projectId, dataDir));
  const dirAbs = path.join(migrationRoot(projectId, dataDir), backupId);
  if (fs.existsSync(path.join(dirAbs, MIGRATION_MANIFEST_FILE))) {
    throw new WorkError("INVALID_COMMAND", `备份目录已存在：${path.basename(dirAbs)}（换时间戳或换 backupId）`, {
      reason: "backup_exists",
    });
  }
  fs.mkdirSync(dirAbs, { recursive: true });
  const created_at = nowIso();
  const files: BackupManifest["files"] = [];
  for (const f of listWorkbenchFiles(bench)) {
    const bytes = fs.readFileSync(f.abs);
    const dest = path.join(dirAbs, f.rel);
    fs.writeFileSync(dest, bytes); // 逐字节复制（不解析、不重排、不改行尾）
    files.push({
      rel: f.rel,
      bytes: bytes.length,
      sha256: sha256Hex(bytes),
      copied_to: path.join(MIGRATION_BACKUP_DIRNAME, backupId, f.rel).split(path.sep).join("/"),
    });
  }
  const evAbs = eventsPath(projectWorkDir(projectId, dataDir));
  let events_file: BackupManifest["events_file"] = null;
  if (fs.existsSync(evAbs)) {
    const bytes = fs.readFileSync(evAbs);
    const dest = path.join(dirAbs, "work-events.jsonl");
    fs.writeFileSync(dest, bytes);
    events_file = {
      bytes: bytes.length,
      sha256: sha256Hex(bytes),
      copied_to: path.join(MIGRATION_BACKUP_DIRNAME, backupId, "work-events.jsonl").split(path.sep).join("/"),
    };
  }
  const manifest: BackupManifest = {
    schema: "tatai-migration-backup/1",
    project_id: projectId,
    backup_id: backupId,
    created_at,
    files,
    events_file,
    // V07-03：真实项目迁移的授权留痕（isolated 夹具运行为 null）
    authorization:
      opts?.real !== undefined
        ? { authorized_by: opts.real.authorized_by, basis: opts.real.basis }
        : null,
  };
  fs.writeFileSync(
    path.join(dirAbs, MIGRATION_MANIFEST_FILE),
    JSON.stringify(manifest, null, 2) + "\n",
    "utf8",
  );
  return {
    backup_id: backupId,
    dir_rel: path.relative(path.resolve(bench, ".."), dirAbs).split(path.sep).join("/"),
    dir_abs: dirAbs,
    files,
    created_at,
  };
}

/** 读备份 manifest（回滚与校验都要先拿到它；缺/坏一律报错，不猜） */
export function readBackupManifest(projectId: string, backupId: string, dataDir?: string): BackupManifest {
  const file = path.join(migrationRoot(projectId, dataDir), backupId, MIGRATION_MANIFEST_FILE);
  if (!fs.existsSync(file)) {
    throw new WorkError("INVALID_COMMAND", `备份不存在或没有清单：${MIGRATION_BACKUP_DIRNAME}/${backupId}`, {
      reason: "backup_missing",
      backup_id: backupId,
    });
  }
  const manifest = JSON.parse(fs.readFileSync(file, "utf8")) as BackupManifest;
  if (manifest?.schema !== "tatai-migration-backup/1" || !Array.isArray(manifest.files)) {
    throw new WorkError("INVALID_COMMAND", `备份清单结构不合法：${backupId}`, { reason: "backup_manifest_corrupt" });
  }
  return manifest;
}

/** 最近的备份 id（按创建时间排序的最后一条） */
export function latestBackupId(projectId: string, dataDir?: string): string | null {
  const root = migrationRoot(projectId, dataDir);
  if (!fs.existsSync(root)) return null;
  const ids = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  return ids.length === 0 ? null : ids[ids.length - 1];
}

// ── 应用 ──

export interface MigrationResult {
  project_id: string;
  backup: MigrationBackup;
  change_id: string;
  /** 提交给唯一写入者的回执（duplicate=true = 这条事件以前就提交过，本次没有第二次效果） */
  receipts: { task_id: string; event_id: string; seq: number; entity_revision: number; duplicate: boolean }[];
  /** 兼容投影（写回 `.工作台/tasks.json`） */
  projection: CompatTasksFile;
  projection_file: string;
  /** 跳过的 v1 条目（如缺 id / 非四态且无取消标记） */
  skipped: { task_id: string; reason: string }[];
}

/**
 * 应用迁移：
 *   ① 先备份原文件（备份失败就一个字节都不动）；
 *   ② 经唯一写入者提交事件（本函数不自己 append 事件文件）；
 *   ③ 写兼容投影 `.工作台/tasks.json`（带 `projection_of` / `last_seq` 标记）。
 * 事件幂等键是确定性的，重复 apply 只会得到 duplicate 回执，不会重复改状态。
 */
export function applyMigration(
  projectId: string,
  dataDir?: string,
  opts?: MigrationOptions & { submitter?: WorkSubmitter },
): MigrationResult {
  assertMigrationScope("迁移应用", opts);
  const preview = previewMigration(projectId, dataDir, opts);
  if (preview.already_migrated) {
    throw new WorkError(
      "INVALID_COMMAND",
      "本项目已经迁移过（台账带 v2 投影标记或 work/events.jsonl 在场）：迁移不重复执行；" +
        "要回到 v1 请用 rollback",
      { reason: "already_migrated", project_id: projectId },
    );
  }
  const backup = backupV1Files(projectId, dataDir, opts);
  const submitter: WorkSubmitter = opts?.submitter ?? new WorkService({ dataDir: dataDir ?? resolveDataDir() });
  const changeId = `migrate-v1-${projectId}`;
  const backupRel = `${path.join(".工作台", "work", MIGRATION_BACKUP_DIRNAME)}/${backup.backup_id}`;
  const workDir = projectWorkDir(projectId, dataDir);

  const receipts: MigrationResult["receipts"] = [];
  const skipped: { task_id: string; reason: string }[] = [];
  const snapshot = readV1Snapshot(projectId, dataDir);

  // 不在这里套 withFileLock：`WorkService.submit` 自己锁同一个 events.jsonl（该锁不可重入），
  // 唯一写入者的串行保证由它负责。
  for (const v1 of snapshot.tasks) {
    const current = readTaskStates(workDir);
    const expected = current.states[v1.id]?.revision ?? null;
    const { event, skip_reason } = planOne(v1, expected, { backupRel });
    if (event === null) {
      skipped.push({ task_id: v1.id, reason: skip_reason ?? "未迁移" });
      continue;
    }
    const receipt = submitter.submit({
      schema_version: 2,
      project_id: projectId,
      change_id: changeId,
      entity_id: event.entity_id,
      expected_revision: event.expected_revision,
      type: event.type,
      actor_id: v1.reporter || "v1-migration",
      role: "executor",
      idempotency_key: event.idempotency_key,
      ...(v1.updated_at === "" ? {} : { occurred_at: v1.updated_at }),
      payload: event.payload,
    });
    receipts.push({
      task_id: v1.id,
      event_id: receipt.event_id,
      seq: receipt.seq,
      entity_revision: receipt.entity_revision,
      duplicate: receipt.duplicate,
    });
  }

  // ②′ 空台账切换也要落 canonical 快照：validate 的「快照在场」检查对已迁移项目一视同仁——
  //     没有任何事件时 WorkService.submit 一次都不会跑，state.json 就缺位（V07-03 真实空台账实测）
  if (loadEvents(workDir).events.length === 0) {
    withFileLock(eventsPath(workDir), () => {
      writeSnapshot(workDir, buildSnapshot(projectId, [], null));
    });
  }

  // ③ 兼容投影：从事件投影派生，写回 v1 台账位置（显式标记为投影）。
  //    锁 tasks.json（不是 events.jsonl）——这里锁的是"这份派生文件的唯一写者"，不是事实源。
  const projection = withFileLock(tasksFileOf(projectId, dataDir), () => {
    const current = readTaskStates(workDir);
    const built = buildCompatTasksProjection({
      states: current.states,
      previous: snapshot.tasks.length > 0 ? { tasks: snapshot.tasks.map((t) => t.raw) } : null,
      last_seq: current.last_seq,
    });
    writeCompatTasksProjection(tasksFileOf(projectId, dataDir), built);
    return built;
  });

  return {
    project_id: projectId,
    backup,
    change_id: changeId,
    receipts,
    projection,
    projection_file: tasksFileOf(projectId, dataDir),
    skipped,
  };
}

// ── 校验 ──

export interface MigrationCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface MigrationValidation {
  ok: boolean;
  backup_id: string | null;
  checks: MigrationCheck[];
  /** 不通过时的可读结论（点名卡号） */
  problems: string[];
}

/**
 * 校验迁移结果（每条都给可读结论）：
 *   ① 备份清单在场且逐字节对得上（备份能用来回滚）；
 *   ② 事件能重放出状态、且 seq 无洞（由 `replayEvents` 结构不变量保证）；
 *   ③ 事件里的任务集合 == v1 台账里的任务集合；
 *   ④ 每条映射正确（done → 结果已提交，不升级；取消带标记）；
 *   ⑤ 兼容投影带 `projection_of` / `last_seq`，且与事件投影一致（**投影不是事实源**）。
 */
export function validateMigration(
  projectId: string,
  dataDir?: string,
  opts?: MigrationOptions & { backupId?: string },
): MigrationValidation {
  assertMigrationScope("迁移校验", opts);
  const checks: MigrationCheck[] = [];
  const problems: string[] = [];
  const add = (name: string, ok: boolean, detail: string) => {
    checks.push({ name, ok, detail });
    if (!ok) problems.push(`${name}：${detail}`);
  };

  const backupId = opts?.backupId ?? latestBackupId(projectId, dataDir);
  if (backupId === null) {
    add("备份在场", false, "没有任何迁移备份目录（先跑 apply 或 backup）");
    return { ok: false, backup_id: null, checks, problems };
  }
  let manifest: BackupManifest | null = null;
  try {
    manifest = readBackupManifest(projectId, backupId, dataDir);
    add("备份清单在场", true, `backup_id=${backupId}，清单 ${manifest.files.length} 个文件`);
  } catch (e) {
    add("备份清单在场", false, (e as Error).message);
    return { ok: false, backup_id: backupId, checks, problems };
  }

  const backupDir = path.join(migrationRoot(projectId, dataDir), backupId);
  const mismatched: string[] = [];
  for (const f of manifest.files) {
    const file = path.join(backupDir, f.rel);
    if (!fs.existsSync(file)) {
      mismatched.push(`${f.rel}（备份里没有）`);
      continue;
    }
    const bytes = fs.readFileSync(file);
    if (sha256Hex(bytes) !== f.sha256 || bytes.length !== f.bytes) mismatched.push(`${f.rel}（哈希/字节数对不上）`);
  }
  add(
    "备份逐字节可回滚",
    mismatched.length === 0,
    mismatched.length === 0 ? `${manifest.files.length} 个文件哈希一致` : mismatched.join("、"),
  );

  const workDir = projectWorkDir(projectId, dataDir);
  let states: ReturnType<typeof readTaskStates> | null = null;
  try {
    states = readTaskStates(workDir);
    add("事件可重放", true, `last_seq=${states.last_seq}，任务 ${Object.keys(states.states).length} 个`);
  } catch (e) {
    add("事件可重放", false, (e as Error).message);
    return { ok: false, backup_id: backupId, checks, problems };
  }

  const backupTasks = readV1TasksFromBackup(backupDir);
  const eventIds = new Set(Object.keys(states.states));
  const v1Ids = new Set(backupTasks.map((t) => t.id).filter((id) => id !== ""));
  const missing = [...v1Ids].filter((id) => !eventIds.has(id));
  const extra = [...eventIds].filter((id) => !v1Ids.has(id));
  add(
    "任务集合一致",
    missing.length === 0 && extra.length === 0,
    missing.length === 0 && extra.length === 0
      ? `${eventIds.size} 个任务两边一致`
      : `事件缺 ${missing.join("、") || "无"}；事件多 ${extra.join("、") || "无"}`,
  );

  const wrongMapping: string[] = [];
  for (const t of backupTasks) {
    const state = states.states[t.id];
    if (!state) continue;
    if (t.cancelled) {
      if (!state.cancelled) wrongMapping.push(`${t.id}（原文件标了取消，状态里没取消标记）`);
      continue;
    }
    const expect = V1_STATUS_MAPPING[t.status as keyof typeof V1_STATUS_MAPPING];
    if (expect === undefined) continue;
    if (state.status !== expect.status) {
      wrongMapping.push(`${t.id}（v1 ${t.status} → 期望 ${expect.status}，实际 ${state.status}）`);
    }
    if (t.status === "done" && state.status === "result_submitted" && /已验收|已交付/.test(JSON.stringify(state))) {
      wrongMapping.push(`${t.id}（done 被升级成"已交付/已验收"，违反 §5.4）`);
    }
  }
  add(
    "映射口径正确",
    wrongMapping.length === 0,
    wrongMapping.length === 0 ? "每条都按 §5.4 映射（done 只到「结果已提交」）" : wrongMapping.join("；"),
  );

  const projectionFile = tasksFileOf(projectId, dataDir);
  let projectionOk = false;
  let projectionDetail = "tasks.json 不存在（兼容投影没写回去）";
  if (fs.existsSync(projectionFile)) {
    const raw: unknown = JSON.parse(fs.readFileSync(projectionFile, "utf8"));
    const expected = buildCompatTasksProjection({
      states: states.states,
      previous: { tasks: backupTasks.map((t) => t.raw) },
      last_seq: states.last_seq,
      generated_at: (raw as CompatTasksFile | null)?.generated_at,
    });
    const same = JSON.stringify(expected) === JSON.stringify(raw);
    projectionOk = hasV2ProjectionMarker(raw) && same;
    projectionDetail = projectionOk
      ? `带 projection_of 标记，last_seq=${states.last_seq}，与事件投影逐字节一致`
      : hasV2ProjectionMarker(raw)
        ? "投影与事件重放不一致（投影被改过或有第二个写者）"
        : "缺 projection_of 标记（旧写工具会当成 v1 台账覆盖）";
  }
  add("兼容投影一致", projectionOk, projectionDetail);

  const snapshot = readSnapshotFromDisk(workDir);
  add(
    "canonical 快照在场",
    snapshot !== null && snapshot.last_seq === states.last_seq,
    snapshot === null ? "work/state.json 缺失" : `last_seq=${snapshot.last_seq}`,
  );

  return { ok: problems.length === 0, backup_id: backupId, checks, problems };
}

/** 从备份里读回 v1 任务条目（校验用；读不到就抛——校验不能靠当前文件自证） */
function readV1TasksFromBackup(backupDir: string): V1TaskSnapshot[] {
  const file = path.join(backupDir, "tasks.json");
  if (!fs.existsSync(file)) return [];
  const raw: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!isObj(raw) || !Array.isArray(raw.tasks)) {
    throw new WorkError("INVALID_COMMAND", "备份里的 tasks.json 结构不合法", { reason: "backup_manifest_corrupt" });
  }
  return raw.tasks.filter(isObj).map((t) => {
    const status = typeof t.status === "string" ? t.status : "";
    const reasonRaw = t.cancelled_reason ?? t.cancel_reason;
    return {
      id: String(t.id ?? ""),
      title: String(t.title ?? ""),
      module_id: String(t.module_id ?? ""),
      status,
      reporter: String(t.reporter ?? "unknown"),
      updated_at: String(t.updated_at ?? ""),
      note: typeof t.note === "string" && t.note !== "" ? t.note : null,
      cancelled: t.cancelled === true || status === "cancelled" || status === "取消",
      cancelled_reason: typeof reasonRaw === "string" && reasonRaw !== "" ? reasonRaw : null,
      raw: t,
    };
  });
}

// ── 回滚 ──

export interface MigrationRollback {
  project_id: string;
  backup_id: string;
  /** 逐字节还原的原文件（含哈希复核结果） */
  restored: { rel: string; bytes: number; sha256: string; matches_backup: boolean }[];
  /** 被移进归档目录的 v2 事件/快照（**不删**） */
  archived: string[];
  archive_dir_rel: string | null;
  /** 回滚后 v1 写口是否重新可用（台账不再带投影标记且事件文件已移走） */
  v1_writes_allowed: boolean;
}

/**
 * 回滚迁移：从备份**逐字节**还原原文件（连行尾与字段顺序一起还原，不重排 JSON），
 * 再把 v2 的事件/快照移进 `work/migration-archived/<时间戳>/`（保留事实，不删除）。
 * 完成后旧写口恢复可用——这正是"旧程序面对新格式拒写"的逆操作。
 */
export function rollbackMigration(
  projectId: string,
  dataDir?: string,
  opts?: MigrationOptions & { backupId?: string },
): MigrationRollback {
  assertMigrationScope("迁移回滚", opts);
  const backupId = opts?.backupId ?? latestBackupId(projectId, dataDir);
  if (backupId === null) {
    throw new WorkError("INVALID_COMMAND", "没有可用的迁移备份：无法回滚（本工具不允许「清空重来」）", {
      reason: "backup_missing",
    });
  }
  const manifest = readBackupManifest(projectId, backupId, dataDir);
  const backupDir = path.join(migrationRoot(projectId, dataDir), backupId);
  const bench = workbenchDirOf(projectId, dataDir);

  const restored: MigrationRollback["restored"] = [];
  for (const f of manifest.files) {
    const src = path.join(backupDir, f.rel);
    if (!fs.existsSync(src)) {
      throw new WorkError("INVALID_COMMAND", `备份里缺少 ${f.rel}，回滚会丢数据：拒绝执行`, {
        reason: "backup_incomplete",
        file: f.rel,
      });
    }
    const bytes = fs.readFileSync(src);
    if (sha256Hex(bytes) !== f.sha256) {
      throw new WorkError("INVALID_COMMAND", `备份里的 ${f.rel} 哈希对不上：拒绝用坏备份回滚`, {
        reason: "backup_tampered",
        file: f.rel,
      });
    }
    fs.mkdirSync(path.dirname(path.join(bench, f.rel)), { recursive: true });
    fs.writeFileSync(path.join(bench, f.rel), bytes); // 逐字节还原
    const back = fs.readFileSync(path.join(bench, f.rel));
    restored.push({
      rel: f.rel,
      bytes: back.length,
      sha256: sha256Hex(back),
      matches_backup: back.equals(bytes),
    });
  }

  // v2 事实移进归档（不删；删除是不可逆动作，本工具不做）。
  // 注意：备份是在**迁移前**做的，所以它记录的 `events_file` 是"迁移前就已有 v2 事件"那种项目；
  // 有它时回滚要把那份事件文件还原回去（回滚 = 回到迁移前，不是"永远取消 v2"）。
  const workDir = projectWorkDir(projectId, dataDir);
  const archiveDir = path.join(archiveRoot(projectId, dataDir), uniqueStampDir(archiveRoot(projectId, dataDir)));
  const archived: string[] = [];
  for (const name of ["events.jsonl", "state.json", "projection-error.json", "recovery.jsonl"]) {
    const src = path.join(workDir, name);
    if (!fs.existsSync(src)) continue;
    fs.mkdirSync(archiveDir, { recursive: true });
    const dest = path.join(archiveDir, name);
    fs.renameSync(src, dest);
    archived.push(path.join(MIGRATION_ARCHIVE_DIRNAME, path.basename(archiveDir), name).split(path.sep).join("/"));
  }
  if (manifest.events_file !== null) {
    const backed = path.join(backupDir, "work-events.jsonl");
    if (!fs.existsSync(backed)) {
      throw new WorkError("INVALID_COMMAND", "备份清单说有迁移前的 events.jsonl，但备份里没有它：拒绝继续（会丢事实）", {
        reason: "backup_incomplete",
        file: "work-events.jsonl",
      });
    }
    fs.mkdirSync(workDir, { recursive: true });
    fs.writeFileSync(path.join(workDir, "events.jsonl"), fs.readFileSync(backed));
  }

  return {
    project_id: projectId,
    backup_id: backupId,
    restored,
    archived,
    archive_dir_rel: archived.length === 0 ? null : path.join(".工作台", "work", MIGRATION_ARCHIVE_DIRNAME, path.basename(archiveDir)).split(path.sep).join("/"),
    v1_writes_allowed: !fs.existsSync(eventsPath(workDir)) && !readV1Snapshot(projectId, dataDir).projection_marker,
  };
}

// ── 旧写工具的拒写（旧程序面对新格式必须拒写，不能静默按 v1 覆盖） ──
//
// 判据与文案在 `tasks.ts#v1TaskWriteGate`（leaf 模块，workstation 的 v1 写口直接调它，
// 不经过本文件——否则 workstation → migrate → workstation 会成环）。

