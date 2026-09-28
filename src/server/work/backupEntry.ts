// V09-06 私有事实备份/恢复的**产品入口**（PLAN.md V09-06，DESIGN.md §8.5 / §12.2 末行
// 「私有状态被 Git 忽略后丢失」）。
//
// 本模块**不重造备份语义**：一致切片怎么切、清单长什么样、隔离恢复怎么核验、绝不自动替换当前数据，
// 全部复用 `backup.ts` 的 V06-14 实现（`createProjectBackup` / `verifyBackup` / `restoreBackup` /
// `compareBackupToLive` / `listProjectBackups`）。V06-14 缺的不是能力而是**产品入口**，本模块补三件事：
//
//   ① **落点策略**：备份落点由用户选（§8.5「用户选择私有备份位置与保留策略」），所以这是一个
//      "把调用方给的路径拿去写盘"的口子。两条硬约束：
//        · 只接受**本机（回环）来源**给的落点——远程写模式下的客户端不能拿它当"在宿主机任意写目录"的口子；
//        · 落点**不得落在被纳管项目根内**——备份是私有事实的副本，混进项目根会被 Git 看见、被监听/扫描当成产出。
//   ② **同一提交边界的幂等**：备份 id 由「截止序号 + 内容指纹」决定，重复备份返回**同一份**并标
//      `reused:true`（不再造第二份目录）；指纹不同就是另一份切片，各留各的。
//   ③ **异常分类**：损坏 / 权限 / 空间不足 / 目标不可写 / 目标已存在 各自给可分辨的 code 与文案，
//      不许合并成"空态"或一句"备份失败"（本卡检查项④）。
//   ④ **发现（定向返工补）**：落点既然由用户选，清单/详情/恢复就必须能**在用户重新选的那个位置上**
//      找回备份——只认默认落点会让"备份到别处"变成"列表找不到、重启后恢复不了"。做法是让
//      list/detail/restore 都接受 `sourceParent`（同一套位置校验），并在该位置上**逐份按清单归属核验**：
//      别的项目的备份不列、不读、不恢复。**刻意不做私有索引文件**（索引是第二份事实源，会跟盘上内容
//      漂移，还得自己处理并发与重建）；位置由用户再选一次，事实只认盘上那一份清单。
//
// ██ 红线（与 V06-14 逐字一致）██
//   · **不自动替换当前数据**：恢复只落在隔离目录，返回值恒为 `replaced:false` +
//     `replace_requires_user:true`；是否替换由用户决定，本模块**不提供**替换入口。
//   · **不删任何被引用的内容**：本模块只有"新增备份目录"与"新增隔离恢复目录"两种写动作，
//     对原项目一个字节都不写（`assertNoProjectWrite` 的判据见 verify-v09-06）。
//   · **不把 Git 当私有事实备份**：本模块与 `gitStatus.ts` 的 `backup_flow_available` 无语义耦合，
//     也不因为代码进了 Git 就把 `.工作台/` 显示成「已备份」。
import fs from "node:fs";
import path from "node:path";
import { getProject, resolveDataDir } from "../registry";
import {
  BACKUP_FORMAT_VERSION,
  BACKUP_MANIFEST_FILE,
  backupDirOf,
  backupDiskUsage,
  backupRoot,
  compareBackupToLive,
  createProjectBackup,
  listProjectBackups,
  restoreBackup,
  verifyBackup,
  type BackupComparison,
  type BackupListEntry,
  type BackupManifest,
  type BackupVerification,
  type RestoreReport,
} from "./backup";
import { sha256Hex } from "./documents";

// ── 失败码（**调用层**码，不扩写入服务的 `WORK_ERROR_CODES`；与 `executionReceipts.ts` 同一层）──

export type BackupEntryFailureCode =
  /** 备份 id 形状不合法（路径穿越/非法字符） */
  | "BACKUP_ID_INVALID"
  /** 这个项目下没有这份备份 */
  | "BACKUP_NOT_FOUND"
  /** 这个位置上那份备份**属于别的项目**（定了位但归属不对：不读、不恢复） */
  | "BACKUP_PROJECT_MISMATCH"
  /** 备份或恢复目标已存在（不覆盖） */
  | "BACKUP_DEST_EXISTS"
  /** 位置不合法：相对路径 / 落在项目根内 / 远程来源指定的本机位置 */
  | "BACKUP_DEST_FORBIDDEN"
  /** 位置不可用：不存在 / 不是目录 / 落点不可写 / 只读文件系统 */
  | "BACKUP_DEST_NOT_WRITABLE"
  /** 权限不足（EACCES / EPERM） */
  | "BACKUP_PERMISSION_DENIED"
  /** 空间不足（ENOSPC / EDQUOT） */
  | "BACKUP_NO_SPACE"
  /** 备份本身不完整/损坏（清单、哈希、截止序号、证据、图纸历史任一不合） */
  | "BACKUP_SOURCE_CORRUPT"
  /** 隔离恢复写完了但逐项核验没全过（复制的现场不完整，如实报，不静默） */
  | "BACKUP_RESTORE_INCOMPLETE"
  /** 其它 I/O 失败 */
  | "BACKUP_IO_ERROR";

export class BackupEntryError extends Error {
  readonly code: BackupEntryFailureCode;
  readonly detail: Record<string, unknown>;
  constructor(code: BackupEntryFailureCode, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = "BackupEntryError";
    this.code = code;
    this.detail = detail;
  }
}

export function isBackupEntryError(e: unknown): e is BackupEntryError {
  return e instanceof BackupEntryError;
}

/** 失败码 → HTTP 状态：404 没有（含"不属于本项目"）；409 已存在；403 位置/权限；507 空间；400 入参类；500 I/O */
export function backupEntryStatus(code: BackupEntryFailureCode): number {
  if (code === "BACKUP_NOT_FOUND" || code === "BACKUP_PROJECT_MISMATCH") return 404;
  if (code === "BACKUP_DEST_EXISTS") return 409;
  if (code === "BACKUP_DEST_FORBIDDEN" || code === "BACKUP_PERMISSION_DENIED") return 403;
  if (code === "BACKUP_NO_SPACE") return 507;
  if (code === "BACKUP_IO_ERROR" || code === "BACKUP_RESTORE_INCOMPLETE") return 500;
  return 400;
}

// ── 路径策略 ──

/** 归一化（绝对化 + 统一分隔符 + 去掉末尾斜杠）——只用于**比较**，落点仍用 `path.resolve` 的原值 */
function normForCompare(p: string): string {
  const abs = path.resolve(p).replace(/\\/g, "/");
  return abs.length > 1 && abs.endsWith("/") ? abs.slice(0, -1) : abs;
}

/** child 是否就是 parent 或落在 parent 里面（Windows 盘符大小写不敏感，一律小写比） */
function isInside(parent: string, child: string): boolean {
  const p = normForCompare(parent).toLowerCase();
  const c = normForCompare(child).toLowerCase();
  return c === p || c.startsWith(`${p}/`);
}

/** 取真实路径；`native`（系统调用，Windows 上认 junction）不可用时退回 JS 实现；再不行由调用方兜 */
function realpathOrLexical(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return fs.realpathSync(p);
  }
}

/**
 * **真实路径**（用于包含关系判定）：把 symlink / junction 解到它真正指向的地方。
 *
 * 为什么必须有它：`path.resolve` 是**词法**的——`<temp>\link` 词法上在项目根外，真实路径却可能是
 * `<项目根>\.工作台`。只做词法比较，就等于给"私有事实备份被写进项目目录"留了一个后门：
 * 用户选一个项目外的 junction 就能绕过"落点不得在项目根内"（第 3 轮返工缺陷 C）。
 *
 * 尚不存在的路径（落点常常还没建）按"**最近存在的祖先**取 realpath，再把剩余片段接回去"，
 * 于是 junction 下面的子目录也能算对；一路到盘根都不存在 / 取不到真实路径时，退回词法值
 * （宁可退回已知行为，也不因为判不出来就把一个正常位置误拒）。
 */
function realPathForCompare(p: string): string {
  const abs = path.resolve(p);
  const suffix: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      const real = realpathOrLexical(cur);
      return suffix.length === 0 ? real : path.join(real, ...suffix.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return abs; // 一路到盘根都不存在：退回词法值
      suffix.push(path.basename(cur));
      cur = parent;
    }
  }
}

function errnoOf(e: unknown): string {
  const code = (e as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" ? code : "";
}

/**
 * 文件系统 errno → 可分辨的失败码（本卡检查项④：损坏 / 权限 / 空间不足 / 目标不可写各自如实）。
 *
 * 单独导出的理由：权限不足（EACCES/EPERM）与空间不足（ENOSPC/EDQUOT）在一台普通机器上**很难真触发**，
 * 与其编一个"看起来跑过"的假现场，不如把**映射本身**钉成可复现的判据（`pnpm verify:v09-06` 段⑤
 * 用合成 errno 逐条断言），并在证据里如实写"本机未复现真实 EACCES/ENOSPC"。
 */
export function classifyFsFailure(e: unknown, what: string): BackupEntryError {
  const errno = errnoOf(e);
  const tail = `${what}：${(e as Error)?.message ?? String(e)}`;
  if (errno === "EACCES" || errno === "EPERM") {
    return new BackupEntryError("BACKUP_PERMISSION_DENIED", `权限不足，${tail}`, { errno, reason: "permission" });
  }
  if (errno === "ENOSPC" || errno === "EDQUOT") {
    return new BackupEntryError("BACKUP_NO_SPACE", `目标位置空间不足，${tail}`, { errno, reason: "no_space" });
  }
  if (errno === "EEXIST") {
    return new BackupEntryError("BACKUP_DEST_EXISTS", `${what}已存在（不覆盖），${tail}`, { errno, reason: "exists" });
  }
  if (errno === "ENOTDIR" || errno === "EISDIR" || errno === "EROFS" || errno === "ENOENT") {
    return new BackupEntryError("BACKUP_DEST_NOT_WRITABLE", `目标不可写，${tail}`, {
      errno,
      reason: "not_writable",
    });
  }
  return new BackupEntryError("BACKUP_IO_ERROR", `读写失败，${tail}`, { errno: errno || null, reason: "io" });
}

/**
 * 调用方（用户）给的位置 → 绝对路径；`undefined`/`null`/空串 = 用默认位置（返回 null）。
 *
 * 「落点」（备份写在哪）与「来源位置」（从哪找备份）**共用这一套校验**：两者都是"这台机器上的一个目录"，
 * 都只能由坐在这台机器前的人选，都必须绝对、且都不得落在被纳管项目根内。
 *
 * "在项目根内"按**真实路径**判（`realPathForCompare`）：词法上在项目外的 junction/symlink 指向
 * 项目根内时同样拒——否则用户选一个链接就能把私有事实备份写进项目目录（第 3 轮返工缺陷 C）。
 *
 * `allowed=false`（非回环来源）时**任何**自定义位置都拒：远程写模式不能把它变成宿主机任意写口，
 * 远程**读**客户端也不能拿它当"遍历宿主机目录"的口子。
 */
function customRootOf(
  raw: unknown,
  projectRoot: string,
  allowed: boolean,
  what: string,
): string | null {
  if (raw === undefined || raw === null || raw === "") return null;
  if (!allowed) {
    throw new BackupEntryError(
      "BACKUP_DEST_FORBIDDEN",
      `${what}只能由本机（回环）选择：远程来源不能指定宿主机上的位置（DESIGN.md §8.5 / §10.2）`,
      { reason: "remote_supplied_location" },
    );
  }
  if (typeof raw !== "string") {
    throw new BackupEntryError("BACKUP_DEST_FORBIDDEN", `${what}必须是绝对路径字符串`, { reason: "bad_type" });
  }
  const value = raw.trim();
  if (!path.isAbsolute(value)) {
    throw new BackupEntryError("BACKUP_DEST_FORBIDDEN", `${what}必须是**绝对**路径（收到 ${value}）`, {
      reason: "not_absolute",
      value,
    });
  }
  const abs = path.resolve(value);
  // 包含关系用**真实路径**比：项目外的 junction/symlink 指向项目根内，不算"项目外"（缺陷 C）
  const realProject = realPathForCompare(projectRoot);
  const realAbs = realPathForCompare(abs);
  if (isInside(realProject, realAbs)) {
    const viaLink = normForCompare(realAbs) !== normForCompare(abs);
    throw new BackupEntryError(
      "BACKUP_DEST_FORBIDDEN",
      `${what}不得落在被纳管项目根内（${abs}${viaLink ? ` → 真实路径 ${realAbs}` : ""} 在 ${projectRoot} 里）：` +
        "备份是私有事实的副本，放进项目根会被 Git 与扫描看见——换一个项目外的位置" +
        (viaLink ? "（这个路径是个链接/junction，它实际指向项目根内）" : ""),
      { reason: "inside_project", value: abs, real_path: realAbs, project_root: realProject, via_link: viaLink },
    );
  }
  return abs;
}

/** 现有目录 + 可写（不存在/不是目录/只读 → 目标不可写；权限 → 权限不足） */
function assertWritableDir(dir: string, what: string): void {
  let st: fs.Stats;
  try {
    st = fs.statSync(dir);
  } catch {
    throw new BackupEntryError("BACKUP_DEST_NOT_WRITABLE", `${what}不存在：${dir}`, {
      reason: "missing",
      value: dir,
    });
  }
  if (!st.isDirectory()) {
    throw new BackupEntryError("BACKUP_DEST_NOT_WRITABLE", `${what}不是目录（是一个文件）：${dir}`, {
      reason: "not_a_directory",
      value: dir,
    });
  }
  try {
    fs.accessSync(dir, fs.constants.W_OK);
  } catch (e) {
    throw classifyFsFailure(e, `${what}不可写（${dir}）`);
  }
}

const BACKUP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;

/** 备份 id → 盘上目录；形状不对一律拒（不许拿一个来路不明的名字去拼路径） */
export function backupDirOfId(projectId: string, backupId: string, dataDir: string): string {
  if (!BACKUP_ID_RE.test(backupId)) {
    throw new BackupEntryError(
      "BACKUP_ID_INVALID",
      `备份 id 形状不合法：${JSON.stringify(backupId)}（只接受字母数字开头、字母数字与 . _ - 组成的名字）`,
      { reason: "bad_id", value: backupId },
    );
  }
  return backupDirOf(dataDir, projectId, backupId);
}

// ── 位置与归属（定向返工：备份放在用户自选位置时，也要能被找到、且只找到自己的）──

/** 用户选的"来源位置"（从哪找备份）必须是个**已存在的目录**：不存在/不是目录一律照实拒 */
function assertReadableDir(dir: string, what: string): void {
  let st: fs.Stats;
  try {
    st = fs.statSync(dir);
  } catch {
    throw new BackupEntryError("BACKUP_DEST_NOT_WRITABLE", `${what}不存在：${dir}`, { reason: "missing", value: dir });
  }
  if (!st.isDirectory()) {
    throw new BackupEntryError("BACKUP_DEST_NOT_WRITABLE", `${what}不是目录（是一个文件）：${dir}`, {
      reason: "not_a_directory",
      value: dir,
    });
  }
}

/**
 * 只看清单里的 `project_id`，判这个目录里的备份**属于谁**（归属判据，不是核验）。
 *
 * 为什么单独用一个宽松的读法：归属要在"值不值得核验"之前判出来。清单读不出来 / 没有 `project_id`
 * ⇒ 归不了属（返回 null）——在用户手选的任意位置里，这种目录**不许**当成本项目的一份备份
 * （它可能压根不是备份，也可能是别人删了清单的残骸）。
 *
 * 调用方**不要**把两种"归不了属"混成一句：目录里**有**清单文件却读不出来（多半是损坏/半截的一份）
 * 与压根没有清单文件是两件事，界面要分开说（第 3 轮返工缺陷 D）。
 */
export function manifestProjectIdOf(dir: string): string | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, BACKUP_MANIFEST_FILE), "utf8")) as {
      project_id?: unknown;
    };
    return typeof raw?.project_id === "string" && raw.project_id !== "" ? raw.project_id : null;
  } catch {
    return null;
  }
}

export interface ResolvedBackupDir {
  dir: string;
  /** 从哪个父目录里定位到的（默认落点，或用户选的位置） */
  parent: string;
  /** 位置是不是用户选的（true）还是默认落点（false） */
  from_source_parent: boolean;
}

/**
 * 备份 id + （可选的）来源位置 → 盘上那份备份的目录；**读之前先核归属**。
 *
 * 两个入口的判据不同，刻意如此：
 *   · **默认落点** `<dataDir>/backups/<project_id>/`：目录路径本身就把范围钉在这个项目上，
 *     所以"清单读不出来"沿用既有口径（往下走，由核验如实报"这份不合格"），不报成"找不到"；
 *   · **用户自选位置**：这是个任意目录，**必须**先能证明这份备份属于本项目——清单读不出来
 *     （归不了属）就当"这个位置下没有本项目的这份备份"（`BACKUP_NOT_FOUND`）；清单属于**别的项目**
 *     则明确拒绝（`BACKUP_PROJECT_MISMATCH`），绝不读、绝不恢复。
 */
function resolveBackupDirOf(
  projectId: string,
  backupId: string,
  dataDir: string,
  sourceParent: string | null,
): ResolvedBackupDir {
  const defaultParent = backupRoot(dataDir, projectId);
  const fromSource = sourceParent !== null;
  const parent = sourceParent ?? defaultParent;
  const dir = path.join(parent, backupId); // backupId 已过形状校验（不含分隔符，拼不出别的路径）
  let st: fs.Stats | null = null;
  try {
    st = fs.statSync(dir);
  } catch {
    st = null;
  }
  if (st === null || !st.isDirectory()) {
    throw new BackupEntryError(
      "BACKUP_NOT_FOUND",
      fromSource
        ? `这个位置下没有这份备份：${backupId}（位置 ${parent}）`
        : `这个项目下没有这份备份：${backupId}`,
      { reason: "backup_missing", backup_id: backupId, ...(fromSource ? { source_parent: parent } : {}) },
    );
  }
  const owner = manifestProjectIdOf(dir);
  if (owner !== null && owner !== projectId) {
    throw new BackupEntryError(
      "BACKUP_PROJECT_MISMATCH",
      `这份备份属于**别的项目**（清单里的 project_id = ${owner}，本项目是 ${projectId}）：` +
        "备份是各项目自己的私有事实，本入口不读、也不恢复别的项目的备份",
      { reason: "project_mismatch", backup_id: backupId, owner_project_id: owner, requested_project_id: projectId, dir },
    );
  }
  if (fromSource && owner === null) {
    throw new BackupEntryError(
      "BACKUP_NOT_FOUND",
      `这个位置下没有属于本项目的这份备份：${backupId}（位置 ${parent}）——` +
        "它没有可读的备份清单，归不了属（本入口不读来路不明的目录）",
      { reason: "unattributable", backup_id: backupId, source_parent: parent },
    );
  }
  return { dir, parent, from_source_parent: fromSource };
}

/** 来源位置的公共解析：位置校验 + 必须已存在（清单/详情/恢复三条口共用） */
function sourceParentOf(
  raw: unknown,
  projectRoot: string,
  allowed: boolean,
  what: string,
): string | null {
  const abs = customRootOf(raw, projectRoot, allowed, what);
  if (abs !== null) assertReadableDir(abs, what);
  return abs;
}

// ── 清单摘要（界面要"清单可读"：版本 / 截止序号 / 内容哈希 / 证据）──

export interface BackupManifestView {
  backup_format: number;
  schema_version: number;
  project_id: string;
  taken_at: string;
  /** **事件提交边界**：这份备份覆盖的最后一条事件序号 */
  cutoff_seq: number;
  event_count: number;
  active_baseline_id: string | null;
  workbench_dir: string;
  counts: {
    sources: number;
    fact: number;
    legacy_fact: number;
    document_history: number;
    evidence: number;
    derived: number;
    log: number;
    skipped: number;
  };
  /** 逐份内容哈希（清单本体；派生的照收，但按角色另有计数） */
  sources: {
    rel_path: string;
    role: string;
    sha256: string;
    bytes: number;
    version: string;
    no_event_boundary?: true;
  }[];
  derived: string[];
  skipped: { rel_path: string; reason: string }[];
  documents: {
    baseline_id: string;
    active_at: string;
    approved_by: string;
    approval_kind: string;
    design: { content_sha256: string; definition_sha256: string; bytes: number; recovery: string };
    plan: { content_sha256: string; definition_sha256: string; bytes: number; recovery: string };
  }[];
  evidence: {
    evidence_id: string;
    sha256: string;
    bytes: number;
    /** 项目内相对恢复位置（`.工作台/work/evidence/<sha256>.json`） */
    recovery_path: string;
    kind: string;
    summary: string;
    referenced_by_events: boolean;
  }[];
  warnings: string[];
}

export function manifestView(m: BackupManifest): BackupManifestView {
  const byRole = (r: string): number => m.sources.filter((s) => s.role === r).length;
  return {
    backup_format: m.backup_format,
    schema_version: m.schema_version,
    project_id: m.project_id,
    taken_at: m.taken_at,
    cutoff_seq: m.cutoff_seq,
    event_count: m.event_count,
    active_baseline_id: m.active_baseline_id,
    workbench_dir: m.workbench_dir,
    counts: {
      sources: m.sources.length,
      fact: byRole("fact"),
      legacy_fact: byRole("legacy_fact"),
      document_history: byRole("document_history"),
      evidence: byRole("evidence"),
      derived: byRole("derived"),
      log: byRole("log"),
      skipped: m.skipped.length,
    },
    sources: m.sources.map((s) => ({
      rel_path: s.rel_path,
      role: s.role,
      sha256: s.sha256,
      bytes: s.bytes,
      version: s.version,
      ...(s.no_event_boundary === true ? { no_event_boundary: true as const } : {}),
    })),
    derived: m.derived,
    skipped: m.skipped.map((s) => ({ rel_path: s.rel_path, reason: s.reason })),
    documents: m.documents.map((d) => ({
      baseline_id: d.baseline_id,
      active_at: d.active_at,
      approved_by: d.approved_by,
      approval_kind: d.approval_kind,
      design: {
        content_sha256: d.design.content_sha256,
        definition_sha256: d.design.definition_sha256,
        bytes: d.design.bytes,
        recovery: d.design.recovery.ref,
      },
      plan: {
        content_sha256: d.plan.content_sha256,
        definition_sha256: d.plan.definition_sha256,
        bytes: d.plan.bytes,
        recovery: d.plan.recovery.ref,
      },
    })),
    evidence: m.evidence.map((e) => ({
      evidence_id: e.evidence_id,
      sha256: e.sha256,
      bytes: e.bytes,
      recovery_path: e.recovery_path,
      kind: e.kind,
      summary: e.summary,
      referenced_by_events: e.referenced_by_events,
    })),
    warnings: m.warnings,
  };
}

/**
 * 内容指纹：截止序号 + **除派生之外**的全部文件（事实 / 旧面事实 / 图纸历史 / 证据 / 归档类）的
 * (路径, 内容哈希) 有序拼接 + 图纸历史的三元组。
 *
 * 为什么**排除派生**（`state.json` / `projection-error` / `arch/**`）：派生是随时可重建的缓存，
 * 它自己会变（每次投影都会重写）。把它算进指纹，"同一提交边界"就不再幂等了——每点一次备份
 * 都会多出一份。归档类（聊天/日志）**算进指纹**：它不是可重建的缓存，改了就是内容变了，
 * 这时该另存一份，而不是把上一份当成"就是这次的备份"回给你。
 */
export function contentFingerprintOf(m: BackupManifest): string {
  const rows = m.sources
    .filter((s) => s.role !== "derived")
    .map((s) => `${s.rel_path}\t${s.sha256}`)
    .sort();
  const basics = m.documents
    .map((d) => `${d.baseline_id}\t${d.design.content_sha256}\t${d.plan.definition_sha256}`)
    .sort();
  return sha256Hex(
    Buffer.from([`cutoff=${m.cutoff_seq}`, ...rows, "documents", ...basics].join("\n"), "utf8"),
  );
}

// ── 创建 ──

export interface BackupCreateOptions {
  /** 用户选的落点**父目录**（绝对路径，必须已存在且可写）；不传 = `<dataDir>/backups/<project_id>/` */
  destParent?: unknown;
  /** 自定义落点是否被允许（回环来源 = true；远程来源 = false） */
  destParentAllowed?: boolean;
  /** 覆盖"现在"（验证脚本用固定时钟） */
  now?: string;
  dataDir?: string;
}

export interface BackupCreateResult {
  backup_id: string;
  /** 备份目录（本机绝对路径；远程响应该字段会被裁掉） */
  dir: string;
  /** 同一提交边界 + 同一内容指纹的重复备份：返回**已有的那一份**，没有再造一份 */
  reused: boolean;
  /** 落点父目录（本机绝对路径）与其"是不是默认位置" */
  dest_parent: string;
  dest_parent_is_default: boolean;
  content_fingerprint: string;
  manifest: BackupManifestView;
  verification: BackupVerification;
  /** 顺带清掉的过老捕获暂存目录名（如实回报，不静默） */
  staging_swept: string[];
}

/**
 * 创建一份一致备份（幂等：同一提交边界 + 同一内容指纹 → 同一份）。
 *
 * 落点：默认父目录 `<dataDir>/backups/<project_id>/`（没有就建），备份目录名由"截止序号 + 内容指纹"
 * 决定；用户可指定父目录（`destParent`），但只接受本机来源、父目录必须已存在可写、且不得落在项目根内
 * （见 `customRootOf`）。
 */
export function createBackupEntry(projectId: string, opts: BackupCreateOptions = {}): BackupCreateResult {
  const dataDir = opts.dataDir ?? resolveDataDir();
  const project = getProject(projectId, dataDir);
  if (!project) {
    throw new BackupEntryError("BACKUP_NOT_FOUND", `项目不存在：${projectId}`, {
      reason: "project_missing",
      project_id: projectId,
    });
  }
  const custom = customRootOf(
    opts.destParent,
    project.path,
    opts.destParentAllowed !== false,
    "备份位置",
  );
  const destRoot = custom ?? backupRoot(dataDir, projectId);
  if (custom !== null) {
    // 自定义落点必须已经是个可写目录（新建用户手敲的路径不在本卡范围内：宁可让他先建好目录）
    assertWritableDir(destRoot, "备份位置");
  } else {
    try {
      fs.mkdirSync(destRoot, { recursive: true });
    } catch (e) {
      throw classifyFsFailure(e, `建不了默认备份目录（${destRoot}）`);
    }
  }

  const stagingSwept = sweepStaleStaging(destRoot);

  // 幂等键要按"这一刻的提交边界 + 事实内容"算，而这两样只有**真做过一次捕获**才知道
  // （边界由 backup.ts 在事件锁内读出、内容哈希由复制出来的字节算出）。所以捕获先落在
  // 一个暂存名里，算完指纹再**原子改名**到 `b-<截止序号>-<内容指纹前 12 位>`：
  //   · 同一提交边界 + 同一内容 → 同一个名字 → 已在盘上就复用（`reused:true`，不造第二份）；
  //   · 内容变了（只改日志/图纸源这类不产生 v2 事件的私有事实）→ 指纹变 → 名字变 → 另存一份，
  //     不会被"同一个截止序号"错误地当成同一份。
  const stagingId = `.staging-${process.pid}-${Date.now()}`;
  const stagingDir = path.join(destRoot, stagingId);
  let manifest: BackupManifest;
  try {
    manifest = createProjectBackup(projectId, { dataDir, destRoot, now: opts.now, backupId: stagingId });
  } catch (e) {
    throw isBackupEntryError(e) ? e : translateBackupFailure(e, "创建备份失败");
  }
  const fingerprint = contentFingerprintOf(manifest);
  const backupId = `b-${String(manifest.cutoff_seq).padStart(8, "0")}-${fingerprint.slice(0, 12)}`;
  const dir = path.join(destRoot, backupId);

  if (fs.existsSync(dir)) {
    // 同一幂等键已在盘上：核验通过才算"就是这份"，否则如实说不合格（不当成正常复用）
    fs.rmSync(stagingDir, { recursive: true, force: true });
    const existing = verifyBackup(dir);
    if (!existing.ok || existing.manifest === null) {
      throw new BackupEntryError(
        "BACKUP_SOURCE_CORRUPT",
        `同一提交边界上已有一份备份（${backupId}），但它没通过一致性核验——不把它当这份备份：` +
          existing.failures.map((f) => `${f.code}(${f.message})`).join("；"),
        {
          reason: "existing_not_ok",
          backup_id: backupId,
          checks: existing.checks,
          failures: existing.failures,
          staging_swept: stagingSwept,
        },
      );
    }
    return {
      backup_id: backupId,
      dir,
      reused: true,
      dest_parent_is_default: custom === null,
      dest_parent: destRoot,
      content_fingerprint: fingerprint,
      manifest: manifestView(existing.manifest),
      verification: existing,
      staging_swept: stagingSwept,
    };
  }

  try {
    fs.renameSync(stagingDir, dir);
  } catch (e) {
    // 改名失败（例如并发下已有同名的另一份刚落地）：把暂存清掉，按"已存在"重走一遍复用判定
    fs.rmSync(stagingDir, { recursive: true, force: true });
    if (fs.existsSync(dir)) {
      const raced = verifyBackup(dir);
      if (raced.ok && raced.manifest !== null) {
        return {
          backup_id: backupId,
          dir,
          reused: true,
          dest_parent_is_default: custom === null,
          dest_parent: destRoot,
          content_fingerprint: fingerprint,
          manifest: manifestView(raced.manifest),
          verification: raced,
          staging_swept: stagingSwept,
        };
      }
    }
    throw classifyFsFailure(e, `备份落盘失败（${destRoot}）`);
  }
  const verification = verifyBackup(dir);
  return {
    backup_id: backupId,
    dir,
    reused: false,
    dest_parent_is_default: custom === null,
    dest_parent: destRoot,
    content_fingerprint: fingerprint,
    manifest: manifestView(manifest),
    verification,
    staging_swept: stagingSwept,
  };
}

/**
 * 清掉**够老**的捕获暂存目录（`.staging-<pid>-<毫秒>`，1 小时以上）。
 *
 * 为什么能清：暂存目录只在一次捕获请求里活着（复制完就改名），能留到 1 小时外的只有
 * "复制到一半进程被杀"的现场；它不是任何清单/事件引用的对象（备份 id 里从不出现 `.staging-`）。
 * 名字形状先卡死，只动 destRoot 直属的、匹配该形状的目录，其余一个都不碰。
 */
function sweepStaleStaging(destRoot: string): string[] {
  const STALE_MS = 60 * 60 * 1000;
  const swept: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(destRoot, { withFileTypes: true });
  } catch {
    return swept;
  }
  const now = Date.now();
  for (const e of entries) {
    if (!e.isDirectory() || !/^\.staging-\d+-\d+$/.test(e.name)) continue;
    const abs = path.join(destRoot, e.name);
    try {
      if (now - fs.statSync(abs).mtimeMs < STALE_MS) continue;
      fs.rmSync(abs, { recursive: true, force: true });
      swept.push(e.name);
    } catch {
      // 删不掉（被占用/权限）就留着下次再说：清扫失败不能把创建备份带崩
    }
  }
  return swept;
}

/**
 * backup.ts 抛出的 `WorkError`（都是 `INVALID_COMMAND` + `detail.reason`）→ 本模块的可分辨失败码。
 *
 * 口径：源侧本身就不收敛/坏掉（事件半截尾行、基线坏行、引用的证据正文在源里缺失、
 * 修订恢复位置不合形状）⇒ **源损坏**；`backup_exists` ⇒ **已存在**；其余按 I/O。
 */
function translateBackupFailure(e: unknown, what: string): BackupEntryError {
  const detail = ((e as { detail?: Record<string, unknown> })?.detail ?? {}) as Record<string, unknown>;
  const reason = typeof detail.reason === "string" ? detail.reason : "";
  const message = `${what}：${(e as Error)?.message ?? String(e)}`;
  const corrupt = [
    "partial_tail",
    "baseline_log_corrupt",
    "manifest_missing",
    "manifest_invalid",
    "revision_object_ref_invalid",
    "revision_object_missing",
    "revision_materialize_mismatch",
    "DEST_EXISTS",
  ];
  if (reason === "backup_exists") {
    return new BackupEntryError("BACKUP_DEST_EXISTS", message, { reason, ...detail });
  }
  if (corrupt.includes(reason)) {
    const code = reason === "DEST_EXISTS" ? "BACKUP_DEST_EXISTS" : "BACKUP_SOURCE_CORRUPT";
    return new BackupEntryError(code, message, { reason, ...detail });
  }
  if (isBackupEntryError(e)) return e;
  return classifyFsFailure(e, what);
}

// ── 列举 ──

export interface BackupListEntryView {
  backup_id: string;
  dir: string;
  /**
   * 这一条能不能当备份用。
   * **默认落点**：清单可读（沿用既有口径，逐条核验在详情里跑）；
   * **用户选的来源位置**：八条一致性核验通过（在这种任意目录里，"这份到底能不能恢复"才是要看的那件事）。
   * 两种口径由 `verified` 明示，不靠读者猜。
   */
  ok: boolean;
  /** 是否真跑过一致性核验（`null` = 这次没跑：默认落点只读清单，核验走详情） */
  verified: boolean | null;
  manifest: BackupManifestView | null;
  error: string | null;
}

/** 列到了但**没有当成备份**的条目（不静默丢：说清为什么不列） */
export interface BackupListSkipped {
  name: string;
  /**
   * 为什么没把它当成本项目的备份：
   *   · `other_project`：清单可读，但里面的 `project_id` 是别的项目；
   *   · `manifest_unreadable`：目录里**有**备份清单文件却读不出 `project_id`（多半是损坏/写了一半的一份，
   *     第 3 轮返工缺陷 D：这一条要能与"压根不是备份"分开，界面才能如实告警而不是说"这里什么都没有"）；
   *   · `not_a_backup`：连清单文件都没有，归不了属（也不猜它是什么）；
   *   · `not_a_directory`：这个条目本身不是目录。
   */
  reason: "other_project" | "manifest_unreadable" | "not_a_backup" | "not_a_directory";
}

export interface BackupListResult {
  project_id: string;
  /** 这次列的父目录（本机绝对路径）：默认落点，或用户重新选的来源位置 */
  root: string;
  default_root: string;
  /** 列的是不是默认落点（false = 用户选的来源位置） */
  root_is_default: boolean;
  /** 用户选的来源位置（没选就是 null） */
  source_parent: string | null;
  /** 没被当成备份的条目（别的项目的备份 / 归不了属的目录 / 不是目录） */
  skipped: BackupListSkipped[];
  entries: BackupListEntryView[];
}

export interface BackupListOptions {
  /** 用户重新选的**来源位置**（绝对路径，必须已存在且是目录、项目根外、本机来源专属） */
  sourceParent?: unknown;
  sourceParentAllowed?: boolean;
  dataDir?: string;
}

/**
 * 列举某项目的备份（清单坏的逐条如实报出 `ok:false` + 原因，不当作"没有这份备份"）。
 *
 * `sourceParent`：用户上次把备份放在哪，这次就从哪找（返工要修的场景）——
 *   · 不传 = 默认落点 `<dataDir>/backups/<project_id>/`（既有口径逐字不变）；
 *   · 传了 = 在那个位置上按**清单归属**挑出本项目自己的备份（`skipped` 里如实报出跳过了什么），
 *     所以换一个进程（重启）拿着同一个位置照样列得出来。
 */
export function listBackupEntries(
  projectId: string,
  opts: BackupListOptions = {},
): BackupListResult {
  const dataDir = opts.dataDir ?? resolveDataDir();
  const project = getProject(projectId, dataDir);
  if (!project) {
    throw new BackupEntryError("BACKUP_NOT_FOUND", `项目不存在：${projectId}`, {
      reason: "project_missing",
      project_id: projectId,
    });
  }
  const defaultRoot = backupRoot(dataDir, projectId);
  const sourceParent = sourceParentOf(
    opts.sourceParent,
    project.path,
    opts.sourceParentAllowed !== false,
    "备份来源位置",
  );
  const viewOf = (e: BackupListEntry): BackupListEntryView => ({
    backup_id: e.backup_id,
    dir: e.dir,
    ok: e.manifest !== null,
    verified: null,
    manifest: e.manifest === null ? null : manifestView(e.manifest),
    error: e.error,
  });
  if (sourceParent === null) {
    const skipped: BackupListSkipped[] = [];
    const entries = listProjectBackups(projectId, dataDir)
      .filter((e) => {
        const owner = manifestProjectIdOf(e.dir);
        if (owner !== null && owner !== projectId) {
          // 默认落点这一格按构造只放本项目的备份；这里混进别的项目的，就不当成本项目的备份列
          skipped.push({ name: e.backup_id, reason: "other_project" });
          return false;
        }
        return true;
      })
      .map(viewOf);
    return {
      project_id: projectId,
      root: defaultRoot,
      default_root: defaultRoot,
      root_is_default: true,
      source_parent: null,
      skipped,
      entries,
    };
  }

  const skipped: BackupListSkipped[] = [];
  const entries: BackupListEntryView[] = [];
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(sourceParent, { withFileTypes: true });
  } catch (e) {
    // 位置存在且是目录（`assertReadableDir` 已过），但列不出来（权限/被并发删掉）→ 如实分类，不落成 500
    throw classifyFsFailure(e, `列不出备份来源位置（${sourceParent}）`);
  }
  for (const e of dirents) {
    if (!e.isDirectory()) {
      skipped.push({ name: e.name, reason: "not_a_directory" });
      continue;
    }
    if (!BACKUP_ID_RE.test(e.name)) {
      skipped.push({ name: e.name, reason: "not_a_backup" });
      continue;
    }
    const dir = path.join(sourceParent, e.name);
    const owner = manifestProjectIdOf(dir);
    if (owner === null) {
      // 有清单文件却读不出 `project_id` ≠ 压根没有清单：前者多半是**损坏/写了一半**的那一份备份，
      // 如实标出来（缺陷 D），界面才不会把"这里全是坏条目"说成"这里什么都没有"
      skipped.push({
        name: e.name,
        reason: fs.existsSync(path.join(dir, BACKUP_MANIFEST_FILE)) ? "manifest_unreadable" : "not_a_backup",
      });
      continue;
    }
    if (owner !== projectId) {
      skipped.push({ name: e.name, reason: "other_project" });
      continue;
    }
    const verification = verifyBackup(dir);
    entries.push({
      backup_id: e.name,
      dir,
      ok: verification.ok,
      verified: verification.ok,
      manifest: verification.manifest === null ? null : manifestView(verification.manifest),
      error:
        verification.failures.length === 0
          ? null
          : verification.failures.map((f) => `${f.code}(${f.message})`).join("；"),
    });
  }
  entries.sort((a, b) => b.backup_id.localeCompare(a.backup_id));
  return {
    project_id: projectId,
    root: sourceParent,
    default_root: defaultRoot,
    root_is_default: false,
    source_parent: sourceParent,
    skipped: skipped.sort((a, b) => a.name.localeCompare(b.name)),
    entries,
  };
}

// ── 单份：清单 + 核验 + 恢复预览（只读）──

export interface BackupRestorePreview {
  /** 默认隔离恢复位置：父目录（`<dataDir>/restores/<project_id>`） */
  default_dest_parent: string;
  /** 不另选时隔离目录会建在哪（`<default_dest_parent>/<backup_id>`；重名时自动加 `-2`/`-3`…） */
  default_dest_root: string;
  /** 那个默认隔离目录当前已经在盘上（真恢复时会自动换一个可用名，不覆盖） */
  default_dest_exists: boolean;
  /** 恢复前先看清落后多少：当前项目 vs 这份备份（只读对照，不做任何决定） */
  comparison: BackupComparison;
  /** 口径说明：本模块不自动替换 */
  note: string;
}

export interface BackupInspectResult {
  backup_id: string;
  dir: string;
  /** 这份备份是从哪个父目录里定位到的（默认落点，或用户重新选的来源位置） */
  backup_dir_parent: string;
  /** 位置是不是用户选的（false = 默认落点） */
  from_source_parent: boolean;
  manifest: BackupManifestView;
  verification: BackupVerification;
  restore_preview: BackupRestorePreview;
  disk: { total_bytes: number; files: number };
}

/** 默认隔离恢复位置：父目录 `<dataDir>/restores/<project_id>`（隔离目录建在它下面，名 = 备份 id） */
export function defaultRestoreParent(dataDir: string, projectId: string): string {
  return path.join(dataDir, "restores", projectId);
}

export interface BackupInspectOptions {
  /** 用户重新选的**来源位置**（不传 = 默认落点） */
  sourceParent?: unknown;
  sourceParentAllowed?: boolean;
  dataDir?: string;
}

export function inspectBackupEntry(
  projectId: string,
  backupId: string,
  opts: BackupInspectOptions = {},
): BackupInspectResult {
  const dataDir = opts.dataDir ?? resolveDataDir();
  const project = getProject(projectId, dataDir);
  if (!project) {
    throw new BackupEntryError("BACKUP_NOT_FOUND", `项目不存在：${projectId}`, {
      reason: "project_missing",
      project_id: projectId,
    });
  }
  // 备份 id 的形状先卡死（不许拿调用方的名字拼路径），再定位置、再核归属
  backupDirOfId(projectId, backupId, dataDir);
  const sourceParent = sourceParentOf(
    opts.sourceParent,
    project.path,
    opts.sourceParentAllowed !== false,
    "备份来源位置",
  );
  const located = resolveBackupDirOf(projectId, backupId, dataDir, sourceParent);
  const dir = located.dir;
  const verification = verifyBackup(dir);
  if (verification.manifest === null) {
    throw new BackupEntryError(
      "BACKUP_SOURCE_CORRUPT",
      `这份备份的清单读不出来（${backupId}）：` +
        verification.failures.map((f) => `${f.code}(${f.message})`).join("；"),
      { reason: "manifest_unreadable", backup_id: backupId, checks: verification.checks, failures: verification.failures },
    );
  }
  const defParent = defaultRestoreParent(dataDir, projectId);
  const defDest = path.join(defParent, backupId);
  return {
    backup_id: backupId,
    dir,
    backup_dir_parent: located.parent,
    from_source_parent: located.from_source_parent,
    manifest: manifestView(verification.manifest),
    verification,
    restore_preview: {
      default_dest_parent: defParent,
      default_dest_root: defDest,
      default_dest_exists: fs.existsSync(defDest),
      comparison: compareBackupToLive(dir, projectId, dataDir),
      note:
        "恢复只落在**隔离目录**：与原数据并存、原项目一个字节都不写；" +
        "是否用备份替换当前数据由用户本人决定（本入口不提供自动替换）",
    },
    disk: backupDiskUsage(dir),
  };
}

// ── 恢复到隔离目录 ──

export interface BackupRestoreOptions {
  /** 用户选的隔离位置**父目录**（绝对路径，必须已存在且可写）；不传 = `<dataDir>/restores/<project_id>` */
  destParent?: unknown;
  destParentAllowed?: boolean;
  /** 用户重新选的**来源位置**（备份当初放在哪；不传 = 默认落点） */
  sourceParent?: unknown;
  sourceParentAllowed?: boolean;
  dataDir?: string;
}

export interface BackupRestoreResult {
  backup_id: string;
  /** 隔离恢复目录本身（= 父目录 / `<backup_id>`；重名时带 `-2`/`-3`…），本机绝对路径 */
  dest_root: string;
  dest_parent: string;
  dest_parent_is_default: boolean;
  /** 这份备份是从哪个父目录里定位到的（默认落点，或用户重新选的来源位置） */
  backup_dir_parent: string;
  from_source_parent: boolean;
  replaced: false;
  replace_requires_user: true;
  report: RestoreReport;
  disk: { total_bytes: number; files: number };
}

/**
 * 父目录 + 想要的子目录名 → 一个**尚不存在**的隔离目录。
 *
 * 重名时加 `-2`/`-3`…（有界 50）：默认位置与用户手选的位置同一个规则，不会因为
 * "上次恢复过"就把这次顶成 DEST_EXISTS；也**绝不覆盖**任何已存在的目录。
 */
function pickRestoreChild(parent: string, childName: string): string {
  const base = path.join(parent, childName);
  if (!fs.existsSync(base)) return base;
  for (let i = 2; i <= 50; i++) {
    const cand = `${base}-${i}`;
    if (!fs.existsSync(cand)) return cand;
  }
  throw new BackupEntryError("BACKUP_DEST_EXISTS", `隔离目录重名候选用完（${base} 及 -2…-50 都在盘上）`, {
    reason: "dest_children_exhausted",
    value: base,
  });
}

/**
 * 把一份备份恢复到**隔离目录**并核验（不碰原项目一个字节；`replaced` 恒为 false）。
 *
 * 前置：先核验这份备份是不是"某个提交序号的一致切片"，不合格就**中止**（不把坏切片恢复成现场）。
 * 目标：用户可选**父目录**（本机来源、已存在可写、不在项目根内），隔离目录新建在父目录下、名 = 备份 id；
 * 默认父目录 `<dataDir>/restores/<project_id>`。备份本身也可以来自用户重新选的**来源位置**
 * （`sourceParent`：同样只接受本机来源、已存在目录、项目根外，且必须按清单归属证明属于本项目——
 * 别的项目的备份一律不恢复）。
 */
export function restoreBackupEntry(
  projectId: string,
  backupId: string,
  opts: BackupRestoreOptions = {},
): BackupRestoreResult {
  const dataDir = opts.dataDir ?? resolveDataDir();
  const project = getProject(projectId, dataDir);
  if (!project) {
    throw new BackupEntryError("BACKUP_NOT_FOUND", `项目不存在：${projectId}`, {
      reason: "project_missing",
      project_id: projectId,
    });
  }
  backupDirOfId(projectId, backupId, dataDir);
  const sourceParent = sourceParentOf(
    opts.sourceParent,
    project.path,
    opts.sourceParentAllowed !== false,
    "备份来源位置",
  );
  const located = resolveBackupDirOf(projectId, backupId, dataDir, sourceParent);
  const dir = located.dir;
  const custom = customRootOf(
    opts.destParent,
    project.path,
    opts.destParentAllowed !== false,
    "隔离恢复位置",
  );
  const destParent = custom ?? defaultRestoreParent(dataDir, projectId);
  const isDefault = custom === null;
  if (isDefault) {
    try {
      fs.mkdirSync(destParent, { recursive: true });
    } catch (e) {
      throw classifyFsFailure(e, `建不了默认隔离恢复位置（${destParent}）`);
    }
  } else {
    assertWritableDir(destParent, "隔离恢复位置的父目录");
  }
  const destRoot = pickRestoreChild(destParent, backupId);

  let report: RestoreReport;
  try {
    report = restoreBackup(dir, destRoot);
  } catch (e) {
    throw isBackupEntryError(e) ? e : classifyFsFailure(e, `恢复到隔离目录失败（${destRoot}）`);
  }
  if (report.verification.failures.length > 0) {
    throw new BackupEntryError(
      "BACKUP_SOURCE_CORRUPT",
      `这份备份没通过一致性核验，恢复中止：` +
        report.verification.failures.map((f) => `${f.code}(${f.message})`).join("；"),
      { reason: "source_not_ok", backup_id: backupId, checks: report.checks, failures: report.failures },
    );
  }
  if (!report.ok) {
    throw new BackupEntryError(
      "BACKUP_RESTORE_INCOMPLETE",
      `隔离目录写出去了，但逐项核验没全过（现场不完整）：` +
        report.failures.map((f) => `${f.code}(${f.message})`).join("；"),
      { reason: "restore_incomplete", backup_id: backupId, dest_root: destRoot, checks: report.checks, failures: report.failures },
    );
  }
  return {
    backup_id: backupId,
    dest_root: destRoot,
    dest_parent: destParent,
    dest_parent_is_default: isDefault,
    backup_dir_parent: located.parent,
    from_source_parent: located.from_source_parent,
    replaced: false,
    replace_requires_user: true,
    report,
    disk: backupDiskUsage(path.join(destRoot, ".工作台")),
  };
}

// ── 供入口自述（界面/脚本据此知道"哪些是可选参数、默认在哪"）──

export const BACKUP_ENTRY_CONTRACT = {
  backup_format: BACKUP_FORMAT_VERSION,
  routes: {
    list: "GET /api/projects/:id/backups（可选 query: source_parent）",
    create: "POST /api/projects/:id/backups",
    inspect: "GET /api/projects/:id/backups/:backupId（可选 query: source_parent）",
    restore: "POST /api/projects/:id/backups/:backupId/restore",
    mcp: null,
  },
  body_fields: {
    create: "dest_parent（落点父目录，可省；本机来源专属）",
    restore: "dest_parent（隔离位置父目录，可省；本机来源专属）、source_parent（备份当初放在哪，可省）",
  },
  query_fields: {
    list: "source_parent（用户重新选的来源位置；本机来源专属、必须已存在目录、不得在项目根内）",
    inspect: "source_parent（同上）",
  },
  defaults: {
    backup_parent: "<dataDir>/backups/<project_id>/",
    restore_parent: "<dataDir>/restores/<project_id>/",
    restore_dir: "<restore_parent>/<backup_id>（重名自动加 -2/-3…）",
  },
  /** 用户自选位置上的备份靠**清单归属**认领：别的项目的备份不列、不读、不恢复 */
  discovery: {
    by: "source_parent（用户重新选的位置）",
    attribution: "清单里的 project_id 必须等于请求的项目",
    index_file: null,
  },
  /** 明确写死：本入口没有"替换当前数据"的动作 */
  replace_action: null as null,
} as const;
