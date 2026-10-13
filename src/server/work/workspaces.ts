// 项目工作目录与交付候选：登记、投影、写口守卫（PLAN V09-63/V09-65；DESIGN.md §6.13／§6.14）。
//
// 定位与红线（逐条对 §6.14 读）：
//   · **单一事实源**：工作区与候选只记**事件**（`workspace.registered` 等）与**只读投影**，写仍经唯一写口
//     （`service.ts` 文件锁）；本模块**不**自己追加事件，只提供折叠/读、命令计划与守卫判据。
//   · **复用身份**：项目身份仍是 `ProjectRecord.id`；主开发目录由 `<project_id>:main` **派生**、不重复保存；
//     `ProjectRecord.path` 始终是项目与唯一账本/工作台的定位锚点，**工作区指针不改它**。
//   · **不另造第二套**：候选不复制可写 `.工作台/`、不为候选另发项目身份；被验源码身份复用内容指纹思路。
//   · **锁内 CAS/闭键/幂等/角色**：判据只在唯一写入服务文件锁内执行（`assertWorkspaceWriteCommand`），
//     直连通用写口手写 `workspace.*` 也不能旁路；对象命令层（下面各 op）只是**劝告性预查 + 计划命令**。
//   · **载明未知**：源解析、候选索引、来源提交读不回时如实记 null／标未知，**不猜**（§6.6）。
//
// 作用域：`docs/work-v2-contract.md` 记录 v2 信封口径；本模块只登记 `workspace.*` 词表与实体前缀。
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { getProject, listProjects } from "../registry";
import { projectWorkDir } from "../workstation";
import { SCHEMA_VERSION, WorkError, isWorkError, type WorkEvent, type WorkReceipt, type WorkErrorCode } from "./types";
import { loadEvents, replayEvents } from "./eventStore";
import { memoizedForDerivation } from "./derivationScope";
import {
  candidateHasFatalProblems,
  inspectCandidateSource,
  parseCandidateIndexRef,
  persistCandidateIndex,
  preserveCandidateSource,
  readCandidateIndex,
  readCandidateRecovery,
  resolveCandidateSource,
} from "./candidateSource";
import { activeBaseline, loadDocument, preserveRevision } from "./documents";
import { deriveWorkspaceBuildBinding } from "./workspaceBuildBinding";
import { isToolchainIdentity } from "../../shared/buildIdentity";
import type {
  CandidateIndex,
  CandidateIndexRef,
  CandidateRecovery,
  CandidateResolution,
  CandidateVersionBinding,
} from "../../shared/candidateIndexTypes";
import type { WorkSubmitter } from "./tasks";
import {
  WORKSPACE_COORDINATOR_ROLES,
  WORKSPACE_KINDS,
  WORKSPACE_KIND_LABELS,
  WORKSPACE_SOURCE_KINDS,
  WORKSPACE_WRITE_ROLES,
  type WorkspaceFailure,
  type WorkspaceFailureCode,
  type WorkspaceFreeze,
  type WorkspaceKind,
  type WorkspaceDevResolution,
  type WorkspaceOutcome,
  type WorkspacePointer,
  type WorkspaceRecord,
  type WorkspaceSourceKind,
  type WorkspaceBuildBinding,
  type WorkspaceVersionBinding,
  type WorkspaceView,
} from "../../shared/workspaceTypes";

// ── 事件词表与实体前缀（登记面见 `types.ts` 的 `REGISTERED_EVENT_TYPES`） ──

export const WORKSPACE_EVENT_TYPES = [
  "workspace.registered",
  "workspace.updated",
  "workspace.frozen",
  "workspace.retired",
  "workspace.pointed",
] as const;
export type WorkspaceEventType = (typeof WORKSPACE_EVENT_TYPES)[number];

const WORKSPACE_ENTITY_PREFIX = "workspace:";
const POINTER_ENTITY_PREFIX = "workspace-pointer:";

export const workspaceEntityId = (workspaceId: string): string => `${WORKSPACE_ENTITY_PREFIX}${workspaceId}`;
export const workspaceIdOfEntity = (entityId: string): string | null =>
  entityId.startsWith(WORKSPACE_ENTITY_PREFIX) ? entityId.slice(WORKSPACE_ENTITY_PREFIX.length) : null;
export const workspacePointerEntityId = (projectId: string): string => `${POINTER_ENTITY_PREFIX}${projectId}`;
export const pointerProjectIdOfEntity = (entityId: string): string | null =>
  entityId.startsWith(POINTER_ENTITY_PREFIX) ? entityId.slice(POINTER_ENTITY_PREFIX.length) : null;

/** 主开发目录的派生 id（`<project_id>:main`；不重复保存、不 freeze/retire） */
export const mainWorkspaceId = (projectId: string): string => `${projectId}:main`;

/** 工作区 id 形态：非空白、不含路径分隔符（允许冒号，缓存目录名要用哈希，见 §6.14 第 4 段） */
export const WORKSPACE_ID_RE = /^[^\s/\\]{1,120}$/;

const WS_KINDS = new Set<string>(WORKSPACE_KINDS);
const WS_SOURCE_KINDS = new Set<string>(WORKSPACE_SOURCE_KINDS);
const WS_WRITE_ROLES = new Set<string>(WORKSPACE_WRITE_ROLES);
const WS_COORD_ROLES = new Set<string>(WORKSPACE_COORDINATOR_ROLES);

// ── 事件 payload 闭键（多一个键都拒；§6.14 第 2 段 op 表「必填」列） ──

export const WORKSPACE_REGISTERED_KEYS = [
  "kind",
  "purpose",
  "root",
  "source_kind",
  "source_commit",
  "source_ref",
  "content_fingerprint",
  "owner_role",
  "task_ids",
] as const;
export const WORKSPACE_UPDATED_KEYS = [
  "purpose",
  "source_kind",
  "source_commit",
  "source_ref",
  "content_fingerprint",
  "task_ids",
  "owner_role",
] as const;
export const WORKSPACE_FROZEN_KEYS = [
  "content_fingerprint",
  "included_uncommitted",
  "declared_paths",
  "candidate_index_revision",
  "source_commit",
  "version_binding",
  "declared_package",
  "index_evidence_id",
  "recovery_evidence_id",
] as const;
export const WORKSPACE_RETIRED_KEYS = ["reason", "reachability"] as const;
export const WORKSPACE_POINTED_KEYS = [
  "current_dev_workspace_id",
  "current_trial_workspace_id",
  "basis",
] as const;
const VERSION_BINDING_KEYS = ["design_sha256", "plan_sha256", "baseline_id", "ledger_last_seq", "requirement_cursor", "build_identity"] as const;

// ── 投影（纯派生：删掉可全量重放） ──

export interface WorkspaceProjection {
  /** 已登记的工作区（不含派生 `:main`；`workspace_id` → 记录） */
  workspaces: Record<string, WorkspaceRecord>;
  /** 项目级指针（无 `workspace.pointed` 事件时为 null） */
  pointer: WorkspacePointer | null;
  last_seq: number;
  /** 事件里出现但不算工作区/指针实体的实体，如实报出便于排查 */
  ignored_entities: string[];
}

function badEvent(message: string, detail: Record<string, unknown> = {}): never {
  throw new WorkError("EVENT_INVALID", `工作区事件不合法：${message}`, detail);
}

function badCommand(message: string, detail: Record<string, unknown> = {}): never {
  throw new WorkError("INVALID_COMMAND", `工作区命令不合法：${message}`, detail);
}

/** 命令侧 / 事件侧共用字段读取：读侧坏数据报 EVENT_INVALID，写侧报 INVALID_COMMAND */
function fail(code: WorkErrorCode, message: string, detail: Record<string, unknown>): never {
  if (code === "EVENT_INVALID") badEvent(message, detail);
  badCommand(message, detail);
}

function assertClosedKeys(
  payload: Record<string, unknown>,
  allowed: readonly string[],
  code: WorkErrorCode,
  where: string,
): void {
  const extra = Object.keys(payload).filter((k) => !allowed.includes(k));
  if (extra.length === 0) return;
  fail(
    code,
    `工作区事件 payload 只收这些键（${allowed.join(" / ")}），多出来的键一律拒：${extra.join("、")}`,
    { where, extra, allowed },
  );
}

function readStr(payload: Record<string, unknown>, key: string, code: WorkErrorCode, where: string): string {
  const v = payload[key];
  if (typeof v !== "string" || v.trim() === "") fail(code, `${key} 必须是非空字符串`, { where, key, got: v });
  return (v as string).trim();
}

function readStrOrNull(payload: Record<string, unknown>, key: string, code: WorkErrorCode, where: string): string | null {
  const v = payload[key];
  if (v === undefined) return null;
  if (v === null) return null;
  if (typeof v !== "string" || v.trim() === "") fail(code, `${key} 给定时必须是非空字符串或 null`, { where, key, got: v });
  return (v as string).trim();
}

function readStrList(payload: Record<string, unknown>, key: string, code: WorkErrorCode, where: string): string[] {
  const v = payload[key];
  if (!Array.isArray(v)) fail(code, `${key} 必须是字符串数组`, { where, key, got: v });
  const out: string[] = [];
  for (const item of v as unknown[]) {
    if (typeof item !== "string" || item.trim() === "") fail(code, `${key} 的每一项都必须是非空字符串`, { where, key, item });
    out.push((item as string).trim());
  }
  return out;
}

function readKind(payload: Record<string, unknown>, code: WorkErrorCode, where: string): WorkspaceKind {
  const v = payload.kind;
  if (typeof v !== "string" || !WS_KINDS.has(v)) {
    fail(code, `kind 必须是 ${WORKSPACE_KINDS.join("/")} 之一（${WORKSPACE_KIND_LABELS.dev}等）`, { where, kind: v });
  }
  return v as WorkspaceKind;
}

function readSourceKind(payload: Record<string, unknown>, code: WorkErrorCode, where: string): WorkspaceSourceKind {
  const v = payload.source_kind;
  if (typeof v !== "string" || !WS_SOURCE_KINDS.has(v)) {
    fail(code, `source_kind 必须是 ${WORKSPACE_SOURCE_KINDS.join("/")} 之一`, { where, source_kind: v });
  }
  return v as WorkspaceSourceKind;
}

/** 路径守卫（§6.14 第 2 段 failure 口径）：必须绝对路径；规范绝对路径；不得落在 `.工作台` 私有目录里 */
export interface RootValidation {
  ok: boolean;
  canonical: string | null;
  failures: string[];
}
export function validateWorkspaceRoot(root: string): RootValidation {
  const failures: string[] = [];
  if (typeof root !== "string" || root.trim() === "") {
    return { ok: false, canonical: null, failures: ["root 缺省或为空"] };
  }
  const raw = root.trim();
  if (!path.isAbsolute(raw)) {
    failures.push(`工作区路径必须是绝对路径：${raw}`);
    return { ok: false, canonical: null, failures };
  }
  const canonical = path.resolve(raw);
  // 源目录/唯一中央工作台分离：不得是 `.工作台` 私有目录本身，也不得落在它里面
  const segs = canonical.split(/[\\/]+/);
  if (segs.includes(".工作台")) {
    failures.push(`工作区根不得是私有 .工作台 目录（源目录与唯一中央工作台分离，DESIGN.md §6.14）：${canonical}`);
  }
  return { ok: failures.length === 0, canonical: failures.length === 0 ? canonical : null, failures };
}

function emptyRecord(workspaceId: string): WorkspaceRecord {
  return {
    workspace_id: workspaceId,
    kind: "dev",
    purpose: "",
    root: "",
    source_kind: "directory",
    source_commit: null,
    source_ref: null,
    content_fingerprint: null,
    status: "preparing",
    owner_role: null,
    task_ids: [],
    derived: false,
    freeze: null,
    revision: 0,
    seq: 0,
    updated_at: "",
    last_actor: "",
  };
}

/**
 * 收窄冻结记录里的**构建包身份**（§6.14 第 3/8 段）。合法形态：`delivery_kind` 是闭集值、`basis` 非空串；
 * `package` 时 `release_id`／`build_id`／两部件输入指纹必须是非空串；`not_applicable` 时这些必须是 null。
 * 半截/自相矛盾即拒（**不接受**"缺字段当通过"）。
 */
function readBuildBinding(raw: unknown, code: WorkErrorCode, where: string): WorkspaceBuildBinding | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) fail(code, `version_binding.build_identity 必须是对象或 null`, { where, got: raw });
  const b = raw as Record<string, unknown>;
  const kind = b.delivery_kind;
  if (kind !== "package" && kind !== "not_applicable") {
    fail(code, `version_binding.build_identity.delivery_kind 必须是 package/not_applicable（收到 ${JSON.stringify(kind)}）`, { where, got: kind });
  }
  const basis = b.basis;
  if (typeof basis !== "string" || basis.trim() === "") fail(code, `version_binding.build_identity.basis 必须是非空串`, { where, got: basis });
  const strOrNull = (key: string): string | null => {
    const v = b[key];
    if (v === undefined || v === null) return null;
    if (typeof v !== "string" || v === "") fail(code, `version_binding.build_identity.${key} 必须是非空串或 null`, { where, key, got: v });
    return v;
  };
  const intOrNull = (key: string): number | null => {
    const v = b[key];
    if (v === undefined || v === null) return null;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) fail(code, `version_binding.build_identity.${key} 必须是 >=0 的整数或 null`, { where, key, got: v });
    return v;
  };
  const rawBuildId = b.build_id;
  let buildId: { server: string; ui: string } | null = null;
  if (rawBuildId !== undefined && rawBuildId !== null) {
    if (typeof rawBuildId !== "object" || Array.isArray(rawBuildId)) fail(code, `version_binding.build_identity.build_id 必须是对象或 null`, { where });
    const bi = rawBuildId as Record<string, unknown>;
    if (typeof bi.server !== "string" || bi.server === "" || typeof bi.ui !== "string" || bi.ui === "") {
      fail(code, `version_binding.build_identity.build_id 必须带非空 server/ui`, { where, got: rawBuildId });
    }
    buildId = { server: bi.server, ui: bi.ui };
  }
  const releaseId = strOrNull("release_id");
  const serverFp = strOrNull("server_input_fingerprint");
  const uiFp = strOrNull("ui_input_fingerprint");
  const toolchain = b.toolchain === undefined || b.toolchain === null ? null : (b.toolchain as WorkspaceBuildBinding["toolchain"]);
  if (toolchain !== null && !isToolchainIdentity(toolchain)) {
    fail(code, `version_binding.build_identity.toolchain 形状不合法（缺字段/类型错）`, { where });
  }
  if (kind === "package" && (releaseId === null || buildId === null || serverFp === null || uiFp === null || toolchain === null)) {
    fail(code, `version_binding.build_identity.delivery_kind=package 时 release_id/build_id/输入指纹/toolchain 都必须在场`, { where });
  }
  if (kind === "not_applicable" && (releaseId !== null || buildId !== null || serverFp !== null || uiFp !== null)) {
    fail(code, `version_binding.build_identity.delivery_kind=not_applicable 时不得带构建身份字段`, { where });
  }
  return {
    delivery_kind: kind,
    basis: basis.trim(),
    release_id: releaseId,
    build_id: buildId,
    server_input_fingerprint: serverFp,
    ui_input_fingerprint: uiFp,
    server_input_manifest_sha256: strOrNull("server_input_manifest_sha256"),
    ui_input_manifest_sha256: strOrNull("ui_input_manifest_sha256"),
    server_input_file_count: intOrNull("server_input_file_count"),
    ui_input_file_count: intOrNull("ui_input_file_count"),
    toolchain,
  };
}

function readVersionBinding(payload: Record<string, unknown>, code: WorkErrorCode, where: string): WorkspaceVersionBinding {
  const v = payload.version_binding;
  if (v === undefined || v === null) {
    return { design_sha256: null, plan_sha256: null, baseline_id: null, ledger_last_seq: null, requirement_cursor: null, build_identity: null };
  }
  if (typeof v !== "object" || Array.isArray(v)) fail(code, `version_binding 必须是对象`, { where, got: v });
  const raw = v as Record<string, unknown>;
  const extra = Object.keys(raw).filter((k) => !(VERSION_BINDING_KEYS as readonly string[]).includes(k));
  if (extra.length > 0) fail(code, `version_binding 只收 ${VERSION_BINDING_KEYS.join(" / ")}，多出来的拒：${extra.join("、")}`, { where, extra });
  const seq = raw.ledger_last_seq;
  if (seq !== undefined && seq !== null && (typeof seq !== "number" || !Number.isInteger(seq) || seq < 0)) {
    fail(code, `version_binding.ledger_last_seq 必须是 >=0 的整数或 null`, { where, got: seq });
  }
  return {
    design_sha256: readStrOrNull(raw, "design_sha256", code, where),
    plan_sha256: readStrOrNull(raw, "plan_sha256", code, where),
    baseline_id: readStrOrNull(raw, "baseline_id", code, where),
    ledger_last_seq: seq === undefined || seq === null ? null : (seq as number),
    requirement_cursor: readStrOrNull(raw, "requirement_cursor", code, where),
    build_identity: readBuildBinding(raw.build_identity, code, where),
  };
}

/**
 * 从事件重放工作区对象（纯函数）。口径：
 *   · `workspace.registered` 首次出现，之后 `updated`／`frozen`／`retired` 推进同一实体；
 *   · `workspace.pointed` 只作用于 `workspace-pointer:<project>` 实体；
 *   · 未知的 `workspace.*` 类型**点名报错**，不静默跳过；坏实体 id 报错。
 */
export function foldWorkspaces(events: readonly WorkEvent[], opts: { projectId?: string } = {}): WorkspaceProjection {
  const { last_seq } = replayEvents([...events]);
  const workspaces: Record<string, WorkspaceRecord> = {};
  let pointer: WorkspacePointer | null = null;
  const ignored = new Set<string>();

  for (const e of events) {
    const isWorkspace = e.type.startsWith("workspace.") && e.type !== "workspace.pointed";
    const isPointer = e.type === "workspace.pointed";
    if (!isWorkspace && !isPointer) {
      const wid = workspaceIdOfEntity(e.entity_id);
      const pid = pointerProjectIdOfEntity(e.entity_id);
      if (wid !== null || pid !== null) {
        badEvent(`工作区实体 ${e.entity_id} 用了未知事件类型 ${JSON.stringify(e.type)}`, { event_id: e.event_id, type: e.type });
      } else {
        ignored.add(e.entity_id);
      }
      continue;
    }
    if (!(WORKSPACE_EVENT_TYPES as readonly string[]).includes(e.type)) {
      badEvent(`未知工作区事件类型 ${JSON.stringify(e.type)}（事件 ${e.event_id}）`, { event_id: e.event_id, type: e.type });
    }
    if (isPointer) {
      const pid = pointerProjectIdOfEntity(e.entity_id);
      if (pid === null || pid === "") badEvent(`workspace.pointed 的实体必须是 workspace-pointer:<project>（事件 ${e.event_id}）`, { event_id: e.event_id, entity_id: e.entity_id });
      if (opts.projectId !== undefined && pid !== opts.projectId) {
        badEvent(`workspace.pointed 的项目（${pid}）与本次读取的项目（${opts.projectId}）不符（事件 ${e.event_id}）`, { event_id: e.event_id });
      }
      assertClosedKeys(e.payload, WORKSPACE_POINTED_KEYS, "EVENT_INVALID", `事件 ${e.event_id}`);
      // 指针是**逐字段补丁**：只改事件里**显式给出**的那个字段，**保留另一半**（select_dev 不该清掉
      // 试用指针、point_trial 不该清掉开发指针）。显式给 null 才是清空。
      const hasDev = Object.prototype.hasOwnProperty.call(e.payload, "current_dev_workspace_id");
      const hasTrial = Object.prototype.hasOwnProperty.call(e.payload, "current_trial_workspace_id");
      const snapshot = pointer as WorkspacePointer | null;
      const devPrev: string | null = snapshot === null ? null : snapshot.current_dev_workspace_id;
      const trialPrev: string | null = snapshot === null ? null : snapshot.current_trial_workspace_id;
      const devValue: string | null = hasDev ? readStrOrNull(e.payload, "current_dev_workspace_id", "EVENT_INVALID", `事件 ${e.event_id}`) : devPrev;
      const trialValue: string | null = hasTrial ? readStrOrNull(e.payload, "current_trial_workspace_id", "EVENT_INVALID", `事件 ${e.event_id}`) : trialPrev;
      pointer = {
        project_id: pid,
        current_dev_workspace_id: devValue,
        current_trial_workspace_id: trialValue,
        revision: e.entity_revision,
        seq: e.seq,
        updated_at: e.received_at,
        last_actor: e.actor_id,
      };
      continue;
    }
    const workspaceId = workspaceIdOfEntity(e.entity_id);
    if (workspaceId === null || workspaceId === "") {
      badEvent(`工作区事件的实体必须是 workspace:<workspace_id>（事件 ${e.event_id}）`, { event_id: e.event_id, entity_id: e.entity_id });
    }
    const where = `事件 ${e.event_id}`;
    const prev = workspaces[workspaceId];
    const type = e.type as WorkspaceEventType;
    if (type === "workspace.registered") {
      if (prev !== undefined) badEvent(`工作区 ${workspaceId} 重复注册（事件 ${e.event_id}）——注册一次，之后走 updated`, { event_id: e.event_id, workspace_id: workspaceId });
      assertClosedKeys(e.payload, WORKSPACE_REGISTERED_KEYS, "EVENT_INVALID", where);
      const kind = readKind(e.payload, "EVENT_INVALID", where);
      const sourceKind = readSourceKind(e.payload, "EVENT_INVALID", where);
      const root = readStr(e.payload, "root", "EVENT_INVALID", where);
      const rootCheck = validateWorkspaceRoot(root);
      if (!rootCheck.ok) badEvent(`工作区 root 不合法：${rootCheck.failures.join("；")}`, { event_id: e.event_id, workspace_id: workspaceId, failures: rootCheck.failures });
      workspaces[workspaceId] = {
        ...emptyRecord(workspaceId),
        kind,
        purpose: readStr(e.payload, "purpose", "EVENT_INVALID", where),
        root: rootCheck.canonical!,
        source_kind: sourceKind,
        source_commit: readStrOrNull(e.payload, "source_commit", "EVENT_INVALID", where),
        source_ref: readStrOrNull(e.payload, "source_ref", "EVENT_INVALID", where),
        content_fingerprint: readStrOrNull(e.payload, "content_fingerprint", "EVENT_INVALID", where),
        owner_role: readStrOrNull(e.payload, "owner_role", "EVENT_INVALID", where),
        task_ids: e.payload.task_ids === undefined ? [] : readStrList(e.payload, "task_ids", "EVENT_INVALID", where),
        revision: e.entity_revision,
        seq: e.seq,
        updated_at: e.received_at,
        last_actor: e.actor_id,
      };
      continue;
    }
    if (prev === undefined) badEvent(`工作区 ${workspaceId} 的首条事件是 ${type}——必须先 workspace.registered`, { event_id: e.event_id, workspace_id: workspaceId });
    const next: WorkspaceRecord = {
      ...prev,
      revision: e.entity_revision,
      seq: e.seq,
      updated_at: e.received_at,
      last_actor: e.actor_id,
    };
    if (type === "workspace.updated") {
      assertClosedKeys(e.payload, WORKSPACE_UPDATED_KEYS, "EVENT_INVALID", where);
      let touched = 0;
      if (e.payload.purpose !== undefined) { next.purpose = readStr(e.payload, "purpose", "EVENT_INVALID", where); touched += 1; }
      if (e.payload.source_kind !== undefined) { next.source_kind = readSourceKind(e.payload, "EVENT_INVALID", where); touched += 1; }
      if (e.payload.source_commit !== undefined) { next.source_commit = readStrOrNull(e.payload, "source_commit", "EVENT_INVALID", where); touched += 1; }
      if (e.payload.source_ref !== undefined) { next.source_ref = readStrOrNull(e.payload, "source_ref", "EVENT_INVALID", where); touched += 1; }
      if (e.payload.content_fingerprint !== undefined) { next.content_fingerprint = readStrOrNull(e.payload, "content_fingerprint", "EVENT_INVALID", where); touched += 1; }
      if (e.payload.owner_role !== undefined) { next.owner_role = readStrOrNull(e.payload, "owner_role", "EVENT_INVALID", where); touched += 1; }
      if (e.payload.task_ids !== undefined) { next.task_ids = readStrList(e.payload, "task_ids", "EVENT_INVALID", where); touched += 1; }
      if (touched === 0) badEvent(`workspace.updated 至少要改一个字段（事件 ${e.event_id}）`, { event_id: e.event_id });
    } else if (type === "workspace.frozen") {
      assertClosedKeys(e.payload, WORKSPACE_FROZEN_KEYS, "EVENT_INVALID", where);
      if (prev.status === "retired") badEvent(`已回收工作区 ${workspaceId} 不能再冻结（事件 ${e.event_id}）`, { event_id: e.event_id });
      const freeze: WorkspaceFreeze = {
        frozen_at: e.received_at,
        frozen_by: e.actor_id,
        content_fingerprint: readStr(e.payload, "content_fingerprint", "EVENT_INVALID", where),
        included_uncommitted: e.payload.included_uncommitted === true,
        declared_paths: readStrList(e.payload, "declared_paths", "EVENT_INVALID", where),
        candidate_index_revision: readStrOrNull(e.payload, "candidate_index_revision", "EVENT_INVALID", where),
        index_evidence_id: readStrOrNull(e.payload, "index_evidence_id", "EVENT_INVALID", where),
        recovery_evidence_id: readStrOrNull(e.payload, "recovery_evidence_id", "EVENT_INVALID", where),
        source_commit: readStrOrNull(e.payload, "source_commit", "EVENT_INVALID", where),
        version_binding: readVersionBinding(e.payload, "EVENT_INVALID", where),
      };
      next.status = "frozen";
      next.freeze = freeze;
      next.content_fingerprint = freeze.content_fingerprint;
      if (freeze.source_commit !== null) next.source_commit = freeze.source_commit;
    } else if (type === "workspace.retired") {
      assertClosedKeys(e.payload, WORKSPACE_RETIRED_KEYS, "EVENT_INVALID", where);
      const reason = readStr(e.payload, "reason", "EVENT_INVALID", where);
      const reachability = readStr(e.payload, "reachability", "EVENT_INVALID", where);
      next.status = "retired";
      // 回收不删唯一来源，也不仅凭状态声称物理目录已清理：把可达性说明如实记进记录
      next.purpose = next.purpose === "" ? `[已回收] ${reason}（可达性：${reachability}）` : next.purpose;
    }
    workspaces[workspaceId] = next;
  }

  return { workspaces, pointer, last_seq, ignored_entities: [...ignored].sort() };
}

/** 从磁盘事件文件读并折叠工作区（读路径；中段损坏会抛，不吞） */
export function readWorkspaces(workDir: string, events?: readonly WorkEvent[]): WorkspaceProjection {
  // 传了快照 ⇒ 纯内存折叠（调用方已现读）；没传 ⇒ 现读盘。**一次同步派生内按 workDir 复用同一份现读折叠**：
  // 同一请求里「当前开发根解析、交付候选读数、工作包、宿主证据解析器」各自各折叠一遍就是各读一遍账本
  // （真实镜像 50MB 级）。作用域 `finally` 一到即丢、**跨请求不缓存**——下一次调用照旧现读，新事件立刻可见。
  if (events !== undefined) return foldWorkspaces(events);
  return memoizedForDerivation("workspaces:projection", workDir, () => foldWorkspaces(loadEvents(workDir).events));
}

/** 派生主开发工作区记录（`<project_id>:main`；不来自事件，不可 freeze/retire 改写 ProjectRecord.path） */
export function mainWorkspaceRecord(projectId: string, anchorRoot: string): WorkspaceRecord {
  const canonical = validateWorkspaceRoot(anchorRoot).canonical ?? path.resolve(anchorRoot);
  return {
    ...emptyRecord(mainWorkspaceId(projectId)),
    kind: "dev",
    purpose: "项目主开发目录（由 ProjectRecord.path 派生，不重复保存）",
    root: canonical,
    source_kind: "directory",
    derived: true,
    status: "preparing",
  };
}

/**
 * 只读派生视图（`manage_workspace(op=read/list)` 的返回体）：含派生 `:main`，解析当前开发根。
 * 缺省（无指针/无记录）＝ `:main` 派生口径继续可用（旧项目逐字段兼容，§6.14 第 10 段）。
 */
export function readWorkspacesForProject(projectId: string, dataDir?: string): WorkspaceView {
  const project = getProject(projectId, dataDir);
  if (!project) throw new WorkError("INVALID_COMMAND", `项目不存在: ${projectId}`, { project_id: projectId });
  const workDir = projectWorkDir(projectId, dataDir);
  const projection = readWorkspaces(workDir);
  const main = mainWorkspaceRecord(projectId, project.path);
  const pointer: WorkspacePointer =
    projection.pointer ?? {
      project_id: projectId,
      current_dev_workspace_id: null,
      current_trial_workspace_id: null,
      revision: 0,
      seq: 0,
      updated_at: "",
      last_actor: "",
    };
  const all: WorkspaceRecord[] = [main, ...Object.values(projection.workspaces)];
  all.sort((a, b) => (a.workspace_id < b.workspace_id ? -1 : a.workspace_id > b.workspace_id ? 1 : 0));
  return {
    project_id: projectId,
    anchor_root: path.resolve(project.path),
    pointer,
    workspaces: all,
    current_dev: resolveDevFromProjection(projectId, project.path, projection, pointer),
  };
}

export function resolveDevFromProjection(
  projectId: string,
  anchorRoot: string,
  projection: WorkspaceProjection,
  pointer: WorkspacePointer,
): WorkspaceDevResolution {
  const anchor = path.resolve(anchorRoot);
  const id = pointer.current_dev_workspace_id;
  // 只有**完全没有登记开发指针**（null/空）才允许 legacy 默认走派生 :main。
  if (id === null || id === "") {
    return { workspace_id: mainWorkspaceId(projectId), root: anchor, source: "main" };
  }
  // 显式指向派生 :main 等价于“切回主开发目录”，仍算显式指针（不是坏指针）。
  if (id === mainWorkspaceId(projectId)) {
    return { workspace_id: id, root: anchor, source: "main" };
  }
  const rec = projection.workspaces[id];
  if (rec === undefined) {
    return {
      workspace_id: id,
      root: null,
      source: "blocked",
      blocked_reason: `显式开发指针指向的工作区不存在：${id}（有显式指针就不静默回落 :main；请 select_dev 切走或修登记）`,
    };
  }
  if (rec.status === "retired") {
    return {
      workspace_id: id,
      root: null,
      source: "blocked",
      blocked_reason: `显式开发指针指向的工作区已回收：${id}（不静默回落 :main；请 select_dev 切走）`,
    };
  }
  return { workspace_id: id, root: rec.root, source: "pointer" };
}

/**
 * **规范开发根解析器**（canonical root resolver）：当前开发工作区根。
 * **不依赖 `documents.ts`／`featureLedger.ts`**（避免循环依赖）——只读注册表 + 工作区事件。
 * 口径（§6.14 第 2 段）：**只有完全无登记**才回退派生 `:main`；**有显式指针却坏**（不存在/已回收）
 * 返回 `source="blocked"` 且 `root=null`，**绝不静默改目录**。
 */
export function resolveCurrentDevRoot(projectId: string, dataDir?: string): WorkspaceDevResolution {
  // **同一请求内只读一次**（2026-10-09 组合根接缝）：一次只读派生里常要解析多遍当前开发根——
  // 设计/施工图源（design + plan）、入口的 `context_manifest.workspace`、工作包、宿主证据解析器、
  // Git 预览各自各调一次就是各读一遍账本（真实镜像 50MB 级）。同一派生内账本内容不会变，故按
  // (project, dataDir) 复用**同一份现读结论**：判据一字不改、返回对象与各读各的逐字段相同。
  // 作用域 `finally` 一到整体丢弃，**跨请求一律不缓存**——下一次调用照旧现读现算，新指针/新事件立刻可见。
  return memoizedForDerivation("workspaces:current-dev-root", `${projectId}\u0000${dataDir ?? ""}`, () =>
    resolveCurrentDevRootUnscoped(projectId, dataDir),
  );
}

function resolveCurrentDevRootUnscoped(projectId: string, dataDir?: string): WorkspaceDevResolution {
  const project = getProject(projectId, dataDir);
  if (!project) throw new WorkError("INVALID_COMMAND", `项目不存在: ${projectId}`, { project_id: projectId });
  const workDir = projectWorkDir(projectId, dataDir);
  const projection = readWorkspaces(workDir);
  const pointer = projection.pointer;
  if (pointer === null) return { workspace_id: mainWorkspaceId(projectId), root: path.resolve(project.path), source: "main" };
  return resolveDevFromProjection(projectId, project.path, projection, pointer);
}

/** 当前试用候选的解析结果：`blocked`＝有显式试用指针但目标坏（不静默当无指针） */
export interface TrialResolution {
  status: "none" | "ok" | "blocked";
  record: WorkspaceRecord | null;
  reason: string | null;
}

/**
 * 解析当前试用候选（DESIGN §6.14 第 8 段）。`none`＝未提升任何固定试用版（按旧行为读 `:main`）；
 * `ok`＝指针指向的已冻结候选；`blocked`＝**有显式试用指针但目标不存在/未冻结/失效**——如实报，
 * **不回退当“无指针”**（否则等于悄悄改交付版本）。
 */
export function resolveCurrentTrialState(projectId: string, dataDir?: string): TrialResolution {
  const project = getProject(projectId, dataDir);
  if (!project) throw new WorkError("INVALID_COMMAND", `项目不存在: ${projectId}`, { project_id: projectId });
  const projection = readWorkspaces(projectWorkDir(projectId, dataDir));
  const id = projection.pointer?.current_trial_workspace_id ?? null;
  if (id === null || id === "") return { status: "none", record: null, reason: null };
  const rec = projection.workspaces[id];
  if (rec === undefined) {
    return { status: "blocked", record: null, reason: `显式试用指针指向的工作区不存在：${id}（不静默当未提升）` };
  }
  if (rec.status === "retired") {
    return { status: "blocked", record: null, reason: `显式试用指针指向的工作区已回收：${id}（不静默当未提升）` };
  }
  if (rec.status !== "frozen") {
    return { status: "blocked", record: null, reason: `显式试用指针指向的工作区未冻结（当前 ${rec.status}）：${id}` };
  }
  if (rec.freeze === null) {
    return { status: "blocked", record: null, reason: `显式试用指针指向的工作区缺少冻结记录：${id}` };
  }
  return { status: "ok", record: rec, reason: null };
}

/** 当前试用候选（`ok` 时给记录；`none`/`blocked` 均为 null，需区分请用 `resolveCurrentTrialState`） */
export function resolveCurrentTrial(projectId: string, dataDir?: string): WorkspaceRecord | null {
  return resolveCurrentTrialState(projectId, dataDir).record;
}

// ── 源检查器（内容指纹）：默认实现 + 可注入更强实现（candidateSource 模块接线用） ──

export interface WorkspaceSourceInspection {
  ok: boolean;
  content_fingerprint: string | null;
  failures: string[];
  /** 完整候选索引（宿主冻结/保全用；默认检查器给出，注入的简化检查器可为 null） */
  index?: CandidateIndex | null;
}

/**
 * 源检查器接口。**候选核心索引（candidate-index-v1）由 `candidateSource.ts` 提供**——
 * 该模块未接线时用下面的默认实现（显式排除 `.git` 任意形态与私有/依赖/构建目录）。
 * 锁内重核（`assertWorkspaceWriteCommand`）与 `point_trial` 宿主实测都走**同一个**检查器，
 * 调用方自报的 measured 值不被采信。
 */
export interface WorkspaceSourceInspector {
  inspect(input: { root: string; declared_paths: string[]; included_uncommitted: boolean }): WorkspaceSourceInspection;
}

/**
 * 默认源检查器：走 V09-64 的候选核心（`candidateSource.ts`，`candidate-index-v1`）。
 * **只有一份枚举实现**——`inspectCandidateSource`（tracked ∪ 非 ignored untracked、固定排除段、
 * 有界、软链真拒）。冻结/试用提升的宿主实测与锁内重核都用它，调用方自报的 measured 不被采信。
 * 注入点 `setWorkspaceSourceInspector` 留给测试/后续更强实现（重复登记以后一次为准）。
 */
function defaultInspect(input: { root: string; declared_paths: string[]; included_uncommitted: boolean }): WorkspaceSourceInspection {
  const index = inspectCandidateSource({
    root: input.root,
    included_uncommitted: input.included_uncommitted,
    declared_paths: input.declared_paths,
  });
  if (candidateHasFatalProblems(index)) {
    return {
      ok: false,
      content_fingerprint: null,
      failures: index.problems.map((p) => `${p.code}${p.path === null ? "" : `(${p.path})`}: ${p.message}`),
      index,
    };
  }
  return { ok: true, content_fingerprint: index.content_fingerprint, failures: [], index };
}

let sourceInspector: WorkspaceSourceInspector = { inspect: defaultInspect };

/** 登记更强的源检查器（candidateSource 模块接线点；重复登记以后一次为准） */
export function setWorkspaceSourceInspector(inspector: WorkspaceSourceInspector): void {
  sourceInspector = inspector;
}
export function getWorkspaceSourceInspector(): WorkspaceSourceInspector {
  return sourceInspector;
}

// ── 冻结配套版本绑定（宿主现读，不采信客户端自报；只在写入服务文件锁内调用） ──

export interface HostVersionBinding {
  design_sha256: string | null;
  plan_sha256: string | null;
  baseline_id: string | null;
  failures: string[];
}

/**
 * 宿主现读配套版本绑定（DESIGN §6.14 第 3 段）：现读 `DESIGN.md`／`PLAN.md` 的内容 sha256，并经既有
 * `preserveRevision` 存进不可变修订库（`design-revisions/`／`plan-revisions/`）；现读**真实生效基线** id。
 * 图纸正文读不到即 `failures` 点名（冻结侧据此拒绝，不接受客户端 null/伪造哈希顶替）。
 */
export function hostVersionBinding(projectId: string, dataDir?: string): HostVersionBinding {
  const failures: string[] = [];
  let designSha: string | null = null;
  let planSha: string | null = null;
  const design = loadDocument(projectId, "design", dataDir);
  if (design === null) {
    failures.push("DESIGN 正文读不到（工作区没有可绑定的设计正文）");
  } else {
    designSha = design.revision.content_sha256;
    try {
      preserveRevision(design, { projectId, dataDir });
    } catch (e) {
      failures.push(`DESIGN 不可变保全失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const plan = loadDocument(projectId, "plan", dataDir);
  if (plan === null) {
    failures.push("PLAN 正文读不到（工作区没有可绑定的施工正文）");
  } else {
    planSha = plan.revision.content_sha256;
    try {
      preserveRevision(plan, { projectId, dataDir });
    } catch (e) {
      failures.push(`PLAN 不可变保全失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const baseline = activeBaseline(projectId, dataDir);
  return { design_sha256: designSha, plan_sha256: planSha, baseline_id: baseline?.baseline_id ?? null, failures };
}

// ── 写口守卫（唯一写入服务文件锁内执行；直连通用写口也不能旁路） ──

export interface WorkspaceWriteGuardInput {
  events: readonly WorkEvent[];
  cmd: { project_id: string; entity_id: string; type: string; role: string; actor_id: string; payload?: Record<string, unknown> };
  workDir: string;
  dataDir?: string;
}

function rejectGuard(reason: WorkspaceFailureCode, message: string, detail: Record<string, unknown> = {}): never {
  throw new WorkError("INVALID_COMMAND", `${message}（本次命令没有写入任何字节）`, { reason, ...detail });
}

const TYPE_TO_OP: Readonly<Record<string, string>> = {
  "workspace.registered": "register",
  "workspace.updated": "update",
  "workspace.frozen": "freeze",
  "workspace.retired": "retire",
  "workspace.pointed": "select_dev/point_trial",
};

/**
 * **锁内工作区写命令守卫**（§6.14 第 2/6/10 段）：形状、闭键、角色、实体-类型匹配、状态迁移、
 * 路径边界、CAS（由服务通用版本检查）、冻结源重核与指针目标校验。任何不合法一律拒绝且**零字节**。
 * 判据与对象命令层**同一份**（同一函数被 `service.ts` 与 `workspaces.<op>` 调用/引用）。
 */
export function assertWorkspaceWriteCommand(input: WorkspaceWriteGuardInput): { payload?: Record<string, unknown> } | undefined {
  const { cmd } = input;
  if (!cmd.type.startsWith("workspace.")) return;
  if (!(WORKSPACE_EVENT_TYPES as readonly string[]).includes(cmd.type)) {
    rejectGuard("INVALID_COMMAND", `未知工作区事件类型 ${JSON.stringify(cmd.type)}`, { type: cmd.type });
  }
  const op = TYPE_TO_OP[cmd.type];
  if (!WS_WRITE_ROLES.has(cmd.role)) {
    rejectGuard("WORKSPACE_ROLE_FORBIDDEN", `工作区写命令按 op=${op} 允许角色 ${WORKSPACE_WRITE_ROLES.join("/")}（收到 role=${JSON.stringify(cmd.role)}）`, { role: cmd.role, op });
  }
  const coordinatorOnly = cmd.type === "workspace.retired" || cmd.type === "workspace.pointed";
  if (coordinatorOnly && !WS_COORD_ROLES.has(cmd.role)) {
    rejectGuard("WORKSPACE_ROLE_FORBIDDEN", `${op} 只允许协调者/设计者执行（收到 role=${JSON.stringify(cmd.role)}）`, { role: cmd.role, op });
  }

  const projection = foldWorkspaces(input.events, { projectId: cmd.project_id });
  // **浅拷贝**：命令经 HTTP 写路径是**深冻结**的（service.freezeDeep），就地改 `cmd.payload` 会抛
  // "Cannot assign to read only property"；判据改在副本上算，定型后的 payload 由本函数返回给写入服务。
  const payload: Record<string, unknown> = { ...(cmd.payload ?? {}) };

  if (cmd.type === "workspace.pointed") {
    const pid = pointerProjectIdOfEntity(cmd.entity_id);
    if (pid !== cmd.project_id) rejectGuard("WORKSPACE_MISMATCH", `workspace.pointed 的实体项目与命令项目不符（实体 ${cmd.entity_id}，命令 ${cmd.project_id}）`, { entity_id: cmd.entity_id });
    assertClosedKeys(payload, WORKSPACE_POINTED_KEYS, "INVALID_COMMAND", `命令 ${cmd.type}`);
    const hasDev = Object.prototype.hasOwnProperty.call(payload, "current_dev_workspace_id");
    const hasTrial = Object.prototype.hasOwnProperty.call(payload, "current_trial_workspace_id");
    if (!hasDev && !hasTrial) rejectGuard("INVALID_COMMAND", "workspace.pointed 至少要改一个指针（current_dev_workspace_id / current_trial_workspace_id）");
    const devId = hasDev ? readStrOrNull(payload, "current_dev_workspace_id", "INVALID_COMMAND", cmd.type) : null;
    const trialId = hasTrial ? readStrOrNull(payload, "current_trial_workspace_id", "INVALID_COMMAND", cmd.type) : null;
    if (devId !== null) {
      const devRec = assertKnownWorkspace(input, projection, devId, { allowMain: true, allowRetired: false });
      // select_dev 的目标必须是**合法的 preparing dev**（§6.14 第 2 段）：不能把 trial/candidate 或已冻结/已回收工作区当开发根。
      if (!devRec.derived) {
        if (devRec.kind !== "dev") {
          rejectGuard("WORKSPACE_MISMATCH", `select_dev 的目标必须是 dev 工作区（${devId} 的 kind=${devRec.kind}）`, { workspace_id: devId, kind: devRec.kind });
        }
        if (devRec.status !== "preparing") {
          rejectGuard("WORKSPACE_MISMATCH", `select_dev 的目标必须是 preparing 状态（${devId} 当前 ${devRec.status}）：冻结/已回收候选不能当开发根`, { workspace_id: devId, status: devRec.status });
        }
      }
    }
    if (trialId !== null) {
      const rec = assertKnownWorkspace(input, projection, trialId, { allowMain: false, allowRetired: false });
      if (rec.status !== "frozen") {
        rejectGuard("WORKSPACE_NOT_FROZEN", `point_trial 的目标必须是**已冻结**的候选/试用工作区（${trialId} 当前状态 ${rec.status}）`, { workspace_id: trialId, status: rec.status });
      }
      assertFrozenStillIntact(input, rec);
    }
    return;
  }

  // 工作区实体类事件
  const workspaceId = workspaceIdOfEntity(cmd.entity_id);
  if (workspaceId === null || workspaceId === "") rejectGuard("WORKSPACE_UNKNOWN", `工作区事件的实体必须是 workspace:<workspace_id>（收到 ${JSON.stringify(cmd.entity_id)}）`, { entity_id: cmd.entity_id });
  if (!WORKSPACE_ID_RE.test(workspaceId)) rejectGuard("WORKSPACE_UNKNOWN", `工作区 id 形态不合法：${JSON.stringify(workspaceId)}`, { workspace_id: workspaceId });
  if (workspaceId === mainWorkspaceId(cmd.project_id)) {
    rejectGuard("WORKSPACE_MISMATCH", `主开发目录 ${workspaceId} 由 ProjectRecord.path 派生、不重复登记，也不可 freeze/retire（DESIGN.md §6.14 第 1/2 段）`, { workspace_id: workspaceId });
  }
  const prev = projection.workspaces[workspaceId];

  if (cmd.type === "workspace.registered") {
    if (prev !== undefined) rejectGuard("VERSION_CONFLICT", `工作区 ${workspaceId} 已存在（注册是新建，重复登记请用 update）`, { workspace_id: workspaceId, current_revision: prev.revision });
    assertClosedKeys(payload, WORKSPACE_REGISTERED_KEYS, "INVALID_COMMAND", `命令 ${cmd.type}`);
    readKind(payload, "INVALID_COMMAND", cmd.type);
    readSourceKind(payload, "INVALID_COMMAND", cmd.type);
    const rootCheck = validateWorkspaceRoot(readStr(payload, "root", "INVALID_COMMAND", cmd.type));
    if (!rootCheck.ok) rejectGuard("WORKSPACE_ROOT_INVALID", `工作区 root 不合法：${rootCheck.failures.join("；")}`, { failures: rootCheck.failures });
    readStr(payload, "purpose", "INVALID_COMMAND", cmd.type);
    if (payload.source_commit !== undefined && payload.source_commit !== null) readStr(payload, "source_commit", "INVALID_COMMAND", cmd.type);
    if (payload.task_ids !== undefined) readStrList(payload, "task_ids", "INVALID_COMMAND", cmd.type);
    assertExecutorTaskBinding(input, payload);
    return;
  }

  if (prev === undefined) rejectGuard("WORKSPACE_UNKNOWN", `工作区 ${workspaceId} 尚未登记（先 register）`, { workspace_id: workspaceId });

  if (cmd.type === "workspace.updated") {
    assertClosedKeys(payload, WORKSPACE_UPDATED_KEYS, "INVALID_COMMAND", `命令 ${cmd.type}`);
    if (Object.keys(payload).length === 0) rejectGuard("INVALID_COMMAND", "workspace.updated 至少要改一个字段");
    // 对 frozen 改来源 → CANDIDATE_FROZEN（改用途/task_ids/owner 仍可；§6.14 op 表）
    const touchesSource = ["source_kind", "source_commit", "source_ref", "content_fingerprint"].some((k) => payload[k] !== undefined);
    if (prev.status === "frozen" && touchesSource) {
      rejectGuard("CANDIDATE_FROZEN", `工作区 ${workspaceId} 已冻结：冻结后不得改写来源（要改请从它派生新准备区，DESIGN.md §6.13 第 3 段）`, { workspace_id: workspaceId });
    }
    if (prev.status === "retired") rejectGuard("CANDIDATE_FROZEN", `工作区 ${workspaceId} 已回收，不能再更新`, { workspace_id: workspaceId });
    if (payload.source_kind !== undefined) readSourceKind(payload, "INVALID_COMMAND", cmd.type);
    if (payload.purpose !== undefined) readStr(payload, "purpose", "INVALID_COMMAND", cmd.type);
    if (payload.task_ids !== undefined) readStrList(payload, "task_ids", "INVALID_COMMAND", cmd.type);
    assertExecutorTaskBinding(input, payload);
    return;
  }

  if (cmd.type === "workspace.frozen") {
    assertClosedKeys(payload, WORKSPACE_FROZEN_KEYS, "INVALID_COMMAND", `命令 ${cmd.type}`);
    if (prev.status === "retired") rejectGuard("CANDIDATE_FROZEN", `工作区 ${workspaceId} 已回收，不能冻结`, { workspace_id: workspaceId });
    const declaredFp = readStr(payload, "content_fingerprint", "INVALID_COMMAND", cmd.type);
    if (prev.status === "frozen") {
      // 幂等：同内容重复冻结返回既有；否则拒（冻结后要改请派生新准备区）
      const same = prev.freeze !== null && prev.freeze.content_fingerprint === declaredFp;
      if (!same) rejectGuard("CANDIDATE_FROZEN", `工作区 ${workspaceId} 已冻结且内容不同：要从它派生新准备区再冻结（DESIGN.md §6.13 第 3 段）`, { workspace_id: workspaceId });
    }
    const includedUncommitted = payload.included_uncommitted === true;
    const declaredPaths = readStrList(payload, "declared_paths", "INVALID_COMMAND", cmd.type);
    if (includedUncommitted && declaredPaths.length === 0) {
      rejectGuard("FREEZE_MISSING_DECLARED", "冻结声明纳入未提交内容（included_uncommitted=true）却没有 declared_paths：遗漏声明项拒绝冻结", { workspace_id: workspaceId });
    }
    const sourceCommit = readStrOrNull(payload, "source_commit", "INVALID_COMMAND", cmd.type) ?? prev.source_commit;
    if (sourceCommit !== null && declaredFp === sourceCommit) {
      rejectGuard("FREEZE_SOURCE_UNRESOLVED", "content_fingerprint 与 source_commit 相同：疑似以 HEAD 顶替实际内容，拒绝冻结", { workspace_id: workspaceId });
    }
    const declaredBinding = readVersionBinding(payload, "INVALID_COMMAND", cmd.type);
    // 构建包身份由**宿主实测**（§6.14 第 3/8 段）：不接受调用方提供，也不接受自报 measured。
    if (declaredBinding.build_identity !== null) {
      rejectGuard("INVALID_COMMAND", "version_binding.build_identity 由宿主实测（§6.14 第 3 段），不接受调用方提供", { workspace_id: workspaceId });
    }
    if (payload.declared_package !== undefined && typeof payload.declared_package !== "boolean") {
      rejectGuard("INVALID_COMMAND", `declared_package 必须是布尔（收到 ${JSON.stringify(payload.declared_package)}）`, { workspace_id: workspaceId });
    }
    const declaredPackage = payload.declared_package === true;

    // ① 宿主实测源目录：现读内容指纹 + **完整候选索引**（不采信调用方自报的 measured）
    const inspection = sourceInspector.inspect({ root: prev.root, declared_paths: declaredPaths, included_uncommitted: includedUncommitted });
    if (!inspection.ok || inspection.content_fingerprint === null) {
      rejectGuard("FREEZE_SOURCE_UNRESOLVED", `冻结源解析不了：${inspection.failures.join("；") || "检查器未给出内容指纹"}`, { workspace_id: workspaceId, failures: inspection.failures });
    }
    if (inspection.content_fingerprint !== declaredFp) {
      rejectGuard("FREEZE_SOURCE_UNRESOLVED", `冻结声明的 content_fingerprint 与源目录现读不符（声明 ${declaredFp.slice(0, 12)}…，现读 ${inspection.content_fingerprint.slice(0, 12)}…）：锁内重核不通过`, { workspace_id: workspaceId });
    }

    // ② 宿主**现读**不可变 DESIGN/PLAN 内容哈希 + 真实 active baseline（不采信客户端自报 null/伪造）
    const host = hostVersionBinding(cmd.project_id, input.dataDir);
    if (host.design_sha256 === null || host.plan_sha256 === null) {
      rejectGuard(
        "FREEZE_SOURCE_UNRESOLVED",
        `冻结必须绑定同一候选的 DESIGN/PLAN 不可变正文：宿主现读失败——${host.failures.join("；") || "缺图纸正文"}（不能用 null 冒充配套版本）`,
        { workspace_id: workspaceId, failures: host.failures },
      );
    }
    if (declaredBinding.design_sha256 !== null && declaredBinding.design_sha256 !== host.design_sha256) {
      rejectGuard("VERSION_CONFLICT", `冻结声明的 DESIGN 哈希与宿主现读不符（声明 ${declaredBinding.design_sha256.slice(0, 12)}…，现读 ${host.design_sha256!.slice(0, 12)}…）：拒绝冻结`, { workspace_id: workspaceId });
    }
    if (declaredBinding.plan_sha256 !== null && declaredBinding.plan_sha256 !== host.plan_sha256) {
      rejectGuard("VERSION_CONFLICT", `冻结声明的 PLAN 哈希与宿主现读不符（声明 ${declaredBinding.plan_sha256.slice(0, 12)}…，现读 ${host.plan_sha256!.slice(0, 12)}…）：拒绝冻结`, { workspace_id: workspaceId });
    }
    if (declaredBinding.baseline_id !== null && declaredBinding.baseline_id !== host.baseline_id) {
      rejectGuard("VERSION_CONFLICT", `冻结声明的 baseline_id（${declaredBinding.baseline_id}）与当前生效基线（${host.baseline_id ?? "无"}）不符：拒绝冻结`, { workspace_id: workspaceId });
    }

    // ③ 宿主**实测**构建包身份（§6.14 第 3 段；复用 §6.10 既有构建链，只判构建输入，不要求产物已存在）。
    //    **放在证据/索引保全之前**：这一条不通过就直接拒，不留下任何索引/恢复证据副作用（"零字节"含无旁写）。
    //    `declared_package=true` 但根没有受支持构建链 ⇒ `PACKAGE_IDENTITY_UNSUPPORTED`（不假称已测）；
    //    根**含**构建链时自动绑定，**不因请求省略字段降成非包**。
    const derived = deriveWorkspaceBuildBinding(prev.root, { declaredPackage });
    if (derived.ok === false) {
      rejectGuard(derived.code, derived.message, { workspace_id: workspaceId, ...derived.detail });
    }

    // ④ 由**唯一宿主**经既有内容寻址证据保全候选索引与不可从提交还原的原字节；payload 只存**紧凑引用**
    //   （统一 `CandidateIndexRef`：读侧据 `candidate_index_revision` 取回并核内容指纹，见 parseCandidateIndexRef）。
    const index = inspection.index ?? null;
    let indexRef: CandidateIndexRef | null = null;
    if (index !== null) {
      const candidateBinding: CandidateVersionBinding = {
        design_sha256: host.design_sha256,
        plan_sha256: host.plan_sha256,
        baseline_id: host.baseline_id,
        ledger_last_seq: declaredBinding.ledger_last_seq ?? 0,
      };
      let recovery: CandidateRecovery;
      try {
        recovery = preserveCandidateSource({
          root: prev.root,
          work_dir: input.workDir,
          index,
          actor_id: cmd.actor_id,
          role: cmd.role,
          version_binding: candidateBinding,
        });
      } catch (e) {
        rejectGuard("CANDIDATE_INVALID", `候选来源保全失败（先验证再写不通过）：${e instanceof Error ? e.message : String(e)}`, { workspace_id: workspaceId });
      }
      try {
        indexRef = persistCandidateIndex(input.workDir, index, {
          actor_id: cmd.actor_id,
          role: cmd.role,
          version_binding: candidateBinding,
          recovery,
        });
      } catch (e) {
        rejectGuard("CANDIDATE_INVALID", `候选索引引用落库失败：${e instanceof Error ? e.message : String(e)}`, { workspace_id: workspaceId });
      }
    }

    const buildBinding = derived.ok === true ? derived.binding : null;
    if (buildBinding === null) rejectGuard("PACKAGE_IDENTITY_UNSUPPORTED", "构建包身份实测未产生结论", { workspace_id: workspaceId });

    // ⑤ 宿主定稿 payload：覆盖配套版本为**现读值**，只存引用（索引本体不进事件，守 64KiB）
    payload.candidate_index_revision = indexRef !== null ? JSON.stringify(indexRef) : declaredFp;
    payload.version_binding = {
      design_sha256: host.design_sha256,
      plan_sha256: host.plan_sha256,
      baseline_id: host.baseline_id,
      ledger_last_seq: declaredBinding.ledger_last_seq,
      requirement_cursor: declaredBinding.requirement_cursor,
      build_identity: buildBinding,
    };
    payload.index_evidence_id = indexRef?.index_evidence_id ?? null;
    payload.recovery_evidence_id = indexRef?.recovery_evidence_id ?? null;
    // 定型 payload 由**返回值**交给写入服务（不改冻结的命令对象）
    return { payload };
  }

  if (cmd.type === "workspace.retired") {
    assertClosedKeys(payload, WORKSPACE_RETIRED_KEYS, "INVALID_COMMAND", `命令 ${cmd.type}`);
    readStr(payload, "reason", "INVALID_COMMAND", cmd.type);
    readStr(payload, "reachability", "INVALID_COMMAND", cmd.type);
    if (prev.status === "retired") rejectGuard("VERSION_CONFLICT", `工作区 ${workspaceId} 已回收，重复回收无意义`, { workspace_id: workspaceId });
    // ① 当前活指针不能被静默回收（§6.14 第 2 段：先显式切走，否则拒绝）
    const pointer = projection.pointer;
    if (pointer !== null && pointer.current_dev_workspace_id === workspaceId) {
      rejectGuard("RETIRE_PRECONDITION_UNMET", `工作区 ${workspaceId} 是**当前开发指针**指向的工作区：先 select_dev 显式切走再回收（不允许活指针被静默转回 :main）`, { workspace_id: workspaceId, pointer: "current_dev" });
    }
    if (pointer !== null && pointer.current_trial_workspace_id === workspaceId) {
      rejectGuard("RETIRE_PRECONDITION_UNMET", `工作区 ${workspaceId} 是**当前试用指针**指向的工作区：先 point_trial 显式切走再回收（不允许交付版本被静默改写）`, { workspace_id: workspaceId, pointer: "current_trial" });
    }
    // ② 宿主**实际核**恢复可达性（不接受调用方自报的 reachability 字符串作证明）
    const reach = checkRetireRecoverability(prev);
    if (!reach.recoverable) {
      rejectGuard("RETIRE_PRECONDITION_UNMET", `回收前提不成立：宿主实测不可还原——${reach.detail}（reachability 字段只是说明，不作证明）`, { workspace_id: workspaceId, basis: reach.basis, detail: reach.detail });
    }
    return;
  }
}

/**
 * executor 的写 op 必须带**本任务的真实授权**（§6.14 op 表「executor（须带本任务 task_id）」）。
 * 「只带一个 task_id 字段」不算授权：这里用**账本里的真实认领**核实——actor 必须**当前持有**该任务的认领
 * （`task.claimed` 的最新记录 owner_id == actor_id，且之后没有 release/`task.reopened` 使其中止）。
 */
function executorHoldsTask(events: readonly WorkEvent[], taskId: string, actorId: string): boolean {
  const entity = `task:${taskId}`;
  let owner: string | null = null;
  for (const e of events) {
    if (e.entity_id !== entity) continue;
    if (e.type === "task.claimed") {
      owner = typeof e.payload.owner_id === "string" && e.payload.owner_id !== "" ? e.payload.owner_id : null;
    } else if (e.type === "task.reopened") {
      owner = null;
    } else if (e.type === "task.status_changed" && e.payload.claim_released === true) {
      owner = null;
    }
  }
  return owner !== null && owner === actorId;
}

function assertExecutorTaskBinding(input: WorkspaceWriteGuardInput, payload: Record<string, unknown>): void {
  const { cmd } = input;
  if (cmd.role !== "executor") return;
  const ids = Array.isArray(payload.task_ids) ? (payload.task_ids as unknown[]).filter((x): x is string => typeof x === "string" && x.trim() !== "") : [];
  const single = typeof payload.task_id === "string" && payload.task_id.trim() !== "" ? [payload.task_id] : [];
  const taskIds = [...ids, ...single];
  if (taskIds.length === 0) {
    rejectGuard("WORKSPACE_ROLE_FORBIDDEN", "executor 登记/改写工作区必须带本任务 task_id（任务绑定），否则拒绝", { role: cmd.role });
  }
  for (const tid of taskIds) {
    if (!executorHoldsTask(input.events, tid, cmd.actor_id)) {
      rejectGuard(
        "WORKSPACE_ROLE_FORBIDDEN",
        `executor 登记/改写工作区必须以**自己当前持有的真实认领**为凭据：任务 ${tid} 未被 ${JSON.stringify(cmd.actor_id)} 持有（只带 task_id 字段不算授权）`,
        { role: cmd.role, task_id: tid, actor_id: cmd.actor_id },
      );
    }
  }
}

function assertKnownWorkspace(
  input: WorkspaceWriteGuardInput,
  projection: WorkspaceProjection,
  workspaceId: string,
  opts: { allowMain: boolean; allowRetired: boolean },
): WorkspaceRecord {
  if (opts.allowMain && workspaceId === mainWorkspaceId(input.cmd.project_id)) {
    const project = getProject(input.cmd.project_id, input.dataDir);
    if (!project) rejectGuard("WORKSPACE_UNKNOWN", `项目不存在：${input.cmd.project_id}`, { project_id: input.cmd.project_id });
    return mainWorkspaceRecord(input.cmd.project_id, project.path);
  }
  const rec = projection.workspaces[workspaceId];
  if (rec === undefined) rejectGuard("WORKSPACE_UNKNOWN", `工作区不存在或不属本项目：${workspaceId}`, { workspace_id: workspaceId });
  if (!opts.allowRetired && rec.status === "retired") rejectGuard("WORKSPACE_UNKNOWN", `工作区 ${workspaceId} 已回收`, { workspace_id: workspaceId });
  return rec;
}

/**
 * 回收前提的**宿主实测**（§6.14 第 2 段 / §6.13 第 6 段）：不能只凭调用方写的 reachability 字符串。
 * 口径：源目录仍在且（有冻结指纹时）现读指纹相符＝可就地还原；否则 Git 来源提交**可达**＝可从提交只读还原；
 * 两者都不成立＝不可还原、拒绝回收。**不删唯一来源、不声称物理目录已清理**（只记状态）。
 */
export interface RetireRecoverability {
  recoverable: boolean;
  basis: "present" | "git_commit" | "none";
  detail: string;
}

function gitCommitReachable(root: string, commit: string): boolean {
  try {
    execFileSync("git", ["-C", root, "cat-file", "-e", `${commit}^{commit}`], {
      stdio: ["ignore", "ignore", "ignore"],
      timeout: 15_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return true;
  } catch {
    return false;
  }
}

export function checkRetireRecoverability(rec: WorkspaceRecord): RetireRecoverability {
  let dirPresent = false;
  try {
    dirPresent = fs.existsSync(rec.root) && fs.statSync(rec.root).isDirectory();
  } catch {
    dirPresent = false;
  }
  if (dirPresent) {
    if (rec.freeze !== null) {
      const inspection = sourceInspector.inspect({
        root: rec.root,
        declared_paths: rec.freeze.declared_paths,
        included_uncommitted: rec.freeze.included_uncommitted,
      });
      if (inspection.ok && inspection.content_fingerprint === rec.freeze.content_fingerprint) {
        return { recoverable: true, basis: "present", detail: `源目录在场且内容指纹与冻结记录一致（${rec.content_fingerprint?.slice(0, 12) ?? "?"}…）` };
      }
      return {
        recoverable: false,
        basis: "none",
        detail: "源目录在场但内容指纹与冻结记录不符：不能把“现场在”当可取回证据（先查明来源再回收）",
      };
    }
    return { recoverable: true, basis: "present", detail: "源目录在场（preparing，未冻结；以现场目录为可还原来源）" };
  }
  // 目录不在：只有 Git 来源提交可达才可还原（非 Git 快照库未接线时如实不可还原）
  const commit = rec.freeze?.source_commit ?? rec.source_commit;
  if (commit !== null && commit !== "") {
    if (gitCommitReachable(rec.root, commit)) {
      return { recoverable: true, basis: "git_commit", detail: `源目录不在，但来源提交 ${commit.slice(0, 12)}… 在仓库可达（可从提交只读还原）` };
    }
  }
  return { recoverable: false, basis: "none", detail: "源目录不在、来源提交不可达或未给出：无法还原完整所验源码，拒绝回收" };
}

/** 冻结候选读侧结果：据紧凑引用取回完整索引/恢复材料后，用 `resolveCandidateSource` 落地到可用来源根 */
export interface FrozenCandidateRead {
  ref: CandidateIndexRef | null;
  index: CandidateIndex | null;
  recovery: CandidateRecovery | null;
  resolution: CandidateResolution | null;
  blocked_reason: string | null;
  /**
   * true = 冻结记录自称**新格式**（带索引/恢复证据引用）但统一引用解析不出/损坏。
   * 这类候选**不得**按旧口径回落 `rec.root`（那会把损坏当成 legacy 成功）；调用方须按不可用/未知处理。
   */
  corrupt: boolean;
}

/** 旧格式冻结的 `candidate_index_revision`：null 或一颗裸内容指纹（64hex）——不是统一 `CandidateIndexRef` JSON */
function isLegacyFreezeRef(text: string | null | undefined): boolean {
  return text === null || text === undefined || /^[0-9a-f]{64}$/.test(text.trim());
}

/**
 * 读冻结候选（V09-64；§6.14 第 3/5 段）：据 `rec.freeze.candidate_index_revision` 的**统一紧凑引用**
 * 取回完整索引与恢复材料（内容寻址、核指纹），再用 `resolveCandidateSource` 落地到**可用来源根**
 * （present 原目录 / recovered 可再生缓存 / tampered / unknown）。旧格式（无合法引用）→ 三者为 null，
 * 调用方按旧口径用 `rec.root`（逐字段兼容）；**但新格式冻结（带索引证据）的引用损坏** ⇒ `corrupt=true`，
 * 不得回落 `rec.root`。
 */
export function resolveFrozenCandidateSource(workDir: string, rec: WorkspaceRecord): FrozenCandidateRead {
  if (rec.freeze === null) return { ref: null, index: null, recovery: null, resolution: null, blocked_reason: `工作区 ${rec.workspace_id} 没有冻结记录`, corrupt: false };
  const ref = parseCandidateIndexRef(rec.freeze.candidate_index_revision);
  if (ref === null) {
    // 判"新格式损坏"还是"旧格式无引用"：带索引/恢复证据引用、或 candidate_index_revision 既不是 null
    // 也不是一颗裸指纹 ⇒ 新格式（其统一引用解析不出即损坏），**不能**回落 rec.root 当 legacy 成功。
    const declaresIndex =
      rec.freeze.index_evidence_id !== null ||
      rec.freeze.recovery_evidence_id !== null ||
      !isLegacyFreezeRef(rec.freeze.candidate_index_revision);
    if (declaresIndex) {
      return {
        ref: null,
        index: null,
        recovery: null,
        resolution: null,
        corrupt: true,
        blocked_reason: `冻结记录的候选引用损坏/不可解析（新格式但统一引用缺失或格式错）：不按旧口径回落工作区根（如实标失效）`,
      };
    }
    return { ref: null, index: null, recovery: null, resolution: null, blocked_reason: null, corrupt: false };
  }
  let index: CandidateIndex;
  try {
    index = readCandidateIndex(workDir, ref);
  } catch (e) {
    return { ref, index: null, recovery: null, resolution: null, corrupt: false, blocked_reason: `候选索引取不回/核指纹不符：${e instanceof Error ? e.message : String(e)}` };
  }
  let recovery: CandidateRecovery | null = null;
  if (ref.recovery_evidence_id !== null) {
    try {
      recovery = readCandidateRecovery(workDir, {
        version: ref.version,
        index_fingerprint: ref.index_fingerprint,
        recovery_evidence_id: ref.recovery_evidence_id,
        raw_count: 0,
        refused_count: 0,
        complete: true,
        ref_bytes: 0,
      });
    } catch {
      recovery = null;
    }
  }
  const resolution = resolveCandidateSource({
    root: rec.root,
    work_dir: workDir,
    index,
    source_commit: rec.freeze.source_commit ?? rec.source_commit,
    git_repository: index.git_repository,
    recovery,
  });
  return { ref, index, recovery, resolution, blocked_reason: null, corrupt: false };
}

/** 指针提升前的宿主实测：源目录/完整候选与冻结记录**逐项相符**（否则 PROMOTION_UNVERIFIED，保留旧指针） */
/** 试用提升前的**已验版本**判据输入（宿主实测；不接受调用方自报 basis 充当验收） */
export interface PromotionVerifierInput {
  project_id: string;
  data_dir?: string;
  workspace_id: string;
  /** 候选**实际可用根**（present 原目录 / recovered 可再生缓存） */
  root: string;
  task_ids: string[];
  content_fingerprint: string;
  version_binding: WorkspaceVersionBinding;
}
/** 试用提升前的**已验版本**判据结果（宿主读真实账本派生；缺一即 PROMOTION_UNVERIFIED） */
export interface PromotionVerification {
  verified: boolean;
  technical_verified: boolean;
  independent_audit_passed: boolean;
  /** 该交付所需的配套材料/包身份是否齐备（非包交付的项目合理放行，但不得以自报 basis 顶替） */
  package_ok: boolean;
  reasons: string[];
}
export type PromotionVerifier = (input: PromotionVerifierInput) => PromotionVerification;

/**
 * 试用提升验证器（由**唯一宿主**在 `hostWiring` 安装）：宿主自行读中央事实派生"该候选是否已验版本"
 * （技术验证 + 非作者独立审查 + 该交付所需配套材料）。未接线 ⇒ 视为未证（fail-closed，拒绝提升）。
 */
let promotionVerifier: PromotionVerifier | null = null;
export function setPromotionVerifier(fn: PromotionVerifier | null): void {
  promotionVerifier = fn;
}

/** 指针提升前的宿主实测：源目录/完整候选与冻结记录**逐项相符** + **已验版本**判据（否则 PROMOTION_UNVERIFIED，保留旧指针） */
export function assertFrozenStillIntact(input: { cmd: { project_id: string }; dataDir?: string; workDir?: string }, rec: WorkspaceRecord): void {
  if (rec.freeze === null) rejectGuard("PROMOTION_UNVERIFIED", `工作区 ${rec.workspace_id} 没有冻结记录，不能作为试用根`, { workspace_id: rec.workspace_id });
  const inspection = sourceInspector.inspect({
    root: rec.root,
    declared_paths: rec.freeze.declared_paths,
    included_uncommitted: rec.freeze.included_uncommitted,
  });
  if (!inspection.ok || inspection.content_fingerprint === null) {
    rejectGuard("PROMOTION_UNVERIFIED", `试用提升失败：候选源目录取不回（${inspection.failures.join("；") || "未知"}）；旧指针保留`, { workspace_id: rec.workspace_id, failures: inspection.failures });
  }
  if (inspection.content_fingerprint !== rec.freeze.content_fingerprint) {
    rejectGuard("PROMOTION_UNVERIFIED", `试用提升失败：宿主实测内容指纹与冻结记录不符（实测 ${inspection.content_fingerprint.slice(0, 12)}…，冻结 ${rec.freeze.content_fingerprint.slice(0, 12)}…）；旧指针保留`, { workspace_id: rec.workspace_id });
  }
  // 完整候选索引/配套身份也须逐项相符（有统一引用时）：篡改目录不得借"根在"通过提升。
  // **新格式引用损坏**（corrupt）不得按旧口径回落 rec.root —— 如实拒绝。
  let effectiveRoot = rec.root;
  const workDir = input.workDir ?? (input.dataDir !== undefined ? projectWorkDir(input.cmd.project_id, input.dataDir) : undefined);
  if (workDir !== undefined && workDir !== "") {
    const read = resolveFrozenCandidateSource(workDir, rec);
    if (read.ref !== null) {
      const res = read.resolution;
      if (res === null || (res.status !== "present" && res.status !== "recovered")) {
        rejectGuard(
          "PROMOTION_UNVERIFIED",
          `试用提升失败：完整候选来源不可用（status=${res?.status ?? "unknown"}${read.blocked_reason === null ? "" : `；${read.blocked_reason}`}）；旧指针保留`,
          { workspace_id: rec.workspace_id, status: res?.status ?? "unknown" },
        );
      }
      if (res.content_fingerprint !== null && res.content_fingerprint !== rec.freeze.content_fingerprint) {
        rejectGuard("PROMOTION_UNVERIFIED", `试用提升失败：完整候选现读指纹与冻结记录不符（现读 ${res.content_fingerprint.slice(0, 12)}…）；旧指针保留`, { workspace_id: rec.workspace_id });
      }
      if (res.root !== null) effectiveRoot = res.root;
    } else if (read.corrupt) {
      rejectGuard("PROMOTION_UNVERIFIED", `试用提升失败：${read.blocked_reason ?? "冻结候选引用损坏"}；旧指针保留`, { workspace_id: rec.workspace_id });
    }
  }

  // §6.14 第 8 段：试用目录只接**已验版本**——宿主自行实测技术验证 + 非作者独立审查 + 配套材料，
  // **不接受调用者自报 basis 充当验收**（未接线验证器 = 未证，fail-closed）。
  const verification: PromotionVerification =
    promotionVerifier === null
      ? {
          verified: false,
          technical_verified: false,
          independent_audit_passed: false,
          package_ok: false,
          reasons: ["宿主未接线试用提升验证器（本进程不是唯一写宿主）：无法实测候选是否为已验版本"],
        }
      : promotionVerifier({
          project_id: input.cmd.project_id,
          data_dir: input.dataDir,
          workspace_id: rec.workspace_id,
          root: effectiveRoot,
          task_ids: rec.task_ids,
          content_fingerprint: rec.freeze.content_fingerprint,
          version_binding: rec.freeze.version_binding,
        });
  if (!verification.verified) {
    rejectGuard(
      "PROMOTION_UNVERIFIED",
      `试用提升失败：候选未通过宿主实测的「已验版本」判据（${verification.reasons.filter((r) => r !== "").join("；") || "未证"}）；旧指针保留`,
      {
        workspace_id: rec.workspace_id,
        technical_verified: verification.technical_verified,
        independent_audit_passed: verification.independent_audit_passed,
        package_ok: verification.package_ok,
      },
    );
  }
}

// ── 命令层（劝告性预查 + 计划命令；真正的原子拒绝在写口锁内） ──

export interface WorkspaceReadSource {
  read: () => WorkspaceProjection;
}
export type WorkspaceSubmitter = WorkSubmitter & Partial<WorkspaceReadSource>;

function projectionOf(submitter: WorkspaceSubmitter): WorkspaceProjection {
  const reader = submitter.read;
  if (typeof reader !== "function") {
    throw new WorkError("INVALID_COMMAND", "提交者没有给出工作区读侧（submitter.read）：读写都要先读当前版本", { reason: "missing_workspace_reader" });
  }
  return reader();
}

function failureOf(
  code: WorkspaceFailureCode,
  message: string,
  projectId: string,
  workDir: string,
  extra: { failures?: string[]; detail?: Record<string, unknown> } = {},
): WorkspaceFailure {
  return {
    ok: false,
    code,
    reason: code,
    message,
    failures: extra.failures ?? [message],
    read_again: `重新读状态：manage_workspace(op=read, project_id=${projectId})；事件文件 ${path.join(workDir, "events.jsonl")}`,
    detail: extra.detail ?? {},
  };
}

/** 把锁内拒绝（WorkError，detail.reason 是稳定码）翻译成调用层结局 */
function translateWorkError(e: unknown, projectId: string, workDir: string): WorkspaceFailure | null {
  if (!isWorkError(e)) return null;
  const reason = typeof e.detail?.reason === "string" ? (e.detail.reason as WorkspaceFailureCode) : e.code;
  const failures = Array.isArray(e.detail?.failures) ? (e.detail.failures as string[]) : [e.message];
  return failureOf(reason, e.message, projectId, workDir, { failures, detail: e.detail });
}

function workspaceEventIdempotencyKey(
  projectId: string,
  workspaceId: string,
  type: WorkspaceEventType,
  nextRevision: number,
  changeId: string,
): string {
  return `${workspaceId}:${type}:${nextRevision}:${changeId}`;
}

function pointerIdempotencyKey(projectId: string, nextRevision: number, changeId: string): string {
  return `workspace-pointer:${projectId}:${nextRevision}:${changeId}`;
}

function submitWorkspaceEvent(
  submitter: WorkspaceSubmitter,
  args: {
    project_id: string;
    workspace_id: string;
    change_id: string;
    actor_id: string;
    role: string;
    type: WorkspaceEventType;
    expected_revision: number | null;
    payload: Record<string, unknown>;
    occurred_at?: string;
  },
): WorkReceipt {
  return submitter.submit({
    schema_version: SCHEMA_VERSION,
    project_id: args.project_id,
    change_id: args.change_id,
    entity_id: workspaceEntityId(args.workspace_id),
    expected_revision: args.expected_revision,
    type: args.type,
    actor_id: args.actor_id,
    role: args.role,
    idempotency_key: workspaceEventIdempotencyKey(args.project_id, args.workspace_id, args.type, (args.expected_revision ?? 0) + 1, args.change_id),
    ...(args.occurred_at === undefined ? {} : { occurred_at: args.occurred_at }),
    payload: args.payload,
  });
}

/** 命令层公共信封入参键（多一个都拒） */
const ENVELOPE_KEYS = ["project_id", "workspace_id", "change_id", "actor_id", "role", "occurred_at"] as const;

function assertCommandKeys(input: object, allowed: readonly string[], where: string): void {
  const extra = Object.keys(input).filter((k) => !allowed.includes(k));
  if (extra.length === 0) return;
  badCommand(`${where} 的入参只收这些键（${allowed.join(" / ")}），多出来的键一律拒：${extra.join("、")}`, { extra, allowed, where });
}

export interface RegisterWorkspaceInput {
  project_id: string;
  workspace_id: string;
  change_id: string;
  actor_id: string;
  role: string;
  kind: WorkspaceKind;
  purpose: string;
  root: string;
  source_kind: WorkspaceSourceKind;
  source_commit?: string | null;
  source_ref?: string | null;
  content_fingerprint?: string | null;
  owner_role?: string | null;
  task_ids?: string[];
  occurred_at?: string;
}
const REGISTER_KEYS = [...ENVELOPE_KEYS, "kind", "purpose", "root", "source_kind", "source_commit", "source_ref", "content_fingerprint", "owner_role", "task_ids"] as const;

/**
 * 登记一个工作区（首条 `workspace.registered`）。幂等：同输入（同 root+kind+source）重复登记返回既有记录，
 * 不产生第二个候选。锁内同判据（`assertWorkspaceWriteCommand`）。
 */
export function registerWorkspace(submitter: WorkspaceSubmitter, input: RegisterWorkspaceInput): WorkspaceOutcome<{ receipt: WorkReceipt; duplicate: boolean }> {
  assertCommandKeys(input, REGISTER_KEYS, `登记工作区 ${input.workspace_id}`);
  if (!WORKSPACE_ID_RE.test(input.workspace_id)) {
    return failureOf("WORKSPACE_UNKNOWN", `工作区 id 形态不合法：${JSON.stringify(input.workspace_id)}`, input.project_id, "", {});
  }
  if (!WS_WRITE_ROLES.has(input.role)) return failureOf("WORKSPACE_ROLE_FORBIDDEN", `登记工作区不允许角色 ${JSON.stringify(input.role)}`, input.project_id, "");
  if (input.role === "executor" && (input.task_ids === undefined || input.task_ids.length === 0)) {
    return failureOf("WORKSPACE_ROLE_FORBIDDEN", "executor 登记工作区必须带本任务 task_id（task_ids 至少一条）", input.project_id, "");
  }
  const rootCheck = validateWorkspaceRoot(input.root);
  if (!rootCheck.ok) return failureOf("WORKSPACE_ROOT_INVALID", `工作区 root 不合法：${rootCheck.failures.join("；")}`, input.project_id, "", { failures: rootCheck.failures, detail: { root: input.root } });
  if (!WS_KINDS.has(input.kind)) return failureOf("INVALID_COMMAND", `kind 不合法：${JSON.stringify(input.kind)}`, input.project_id, "");
  if (!WS_SOURCE_KINDS.has(input.source_kind)) return failureOf("INVALID_COMMAND", `source_kind 不合法：${JSON.stringify(input.source_kind)}`, input.project_id, "");

  const current = projectionOf(submitter);
  // 幂等：同 root + kind + source_kind + source_commit + content_fingerprint 的**在场**既有工作区
  // （已回收的不算——回收后再登记同路径应新建，不静默复活旧 id）
  for (const rec of Object.values(current.workspaces)) {
    if (rec.status === "retired") continue;
    if (
      rec.root === rootCheck.canonical &&
      rec.kind === input.kind &&
      rec.source_kind === input.source_kind &&
      (rec.source_commit ?? null) === (input.source_commit ?? null) &&
      (rec.content_fingerprint ?? null) === (input.content_fingerprint ?? null)
    ) {
      return { ok: true, duplicate: true, receipt: duplicateReceipt(rec) };
    }
  }
  if (current.workspaces[input.workspace_id] !== undefined) {
    return failureOf("VERSION_CONFLICT", `工作区 ${input.workspace_id} 已存在（重复 id，内容不同）`, input.project_id, "");
  }

  const payload: Record<string, unknown> = {
    kind: input.kind,
    purpose: input.purpose,
    root: rootCheck.canonical,
    source_kind: input.source_kind,
    ...(input.source_commit === undefined ? {} : { source_commit: input.source_commit }),
    ...(input.source_ref === undefined ? {} : { source_ref: input.source_ref }),
    ...(input.content_fingerprint === undefined ? {} : { content_fingerprint: input.content_fingerprint }),
    ...(input.owner_role === undefined ? {} : { owner_role: input.owner_role }),
    ...(input.task_ids === undefined ? {} : { task_ids: input.task_ids }),
  };
  try {
    const receipt = submitWorkspaceEvent(submitter, {
      ...input,
      type: "workspace.registered",
      expected_revision: null,
      payload,
    });
    return { ok: true, receipt, duplicate: receipt.duplicate };
  } catch (e) {
    const t = translateWorkError(e, input.project_id, "");
    if (t !== null) return t;
    throw e;
  }
}

export interface UpdateWorkspaceInput {
  project_id: string;
  workspace_id: string;
  change_id: string;
  actor_id: string;
  role: string;
  expected_revision: number;
  fields: Record<string, unknown>;
  occurred_at?: string;
}
const UPDATE_KEYS = [...ENVELOPE_KEYS, "expected_revision", "fields"] as const;

/** 改用途/来源/`task_ids`（§6.14 op 表）。稳定 id 不变；CAS 由 `expected_revision` 保证。 */
export function updateWorkspace(submitter: WorkspaceSubmitter, input: UpdateWorkspaceInput): WorkspaceOutcome<{ receipt: WorkReceipt }> {
  assertCommandKeys(input, UPDATE_KEYS, `更新工作区 ${input.workspace_id}`);
  const current = projectionOf(submitter);
  const rec = current.workspaces[input.workspace_id];
  if (rec === undefined) return failureOf("WORKSPACE_UNKNOWN", `工作区不存在：${input.workspace_id}`, input.project_id, "");
  if (rec.revision !== input.expected_revision) {
    return failureOf("VERSION_CONFLICT", `更新工作区 ${input.workspace_id} 版本冲突：声明 ${input.expected_revision}，当前 ${rec.revision}`, input.project_id, "");
  }
  const allowed = new Set<string>(WORKSPACE_UPDATED_KEYS);
  const extra = Object.keys(input.fields).filter((k) => !allowed.has(k));
  if (extra.length > 0) return failureOf("INVALID_COMMAND", `update 的 fields 只收 ${[...allowed].join(" / ")}，多出来的拒：${extra.join("、")}`, input.project_id, "");
  if (Object.keys(input.fields).length === 0) return failureOf("INVALID_COMMAND", "update 至少要改一个字段", input.project_id, "");
  if (input.role === "executor" && input.fields.task_ids === undefined) {
    return failureOf("WORKSPACE_ROLE_FORBIDDEN", "executor 更新工作区必须带本任务 task_ids（任务绑定）", input.project_id, "");
  }
  try {
    const receipt = submitWorkspaceEvent(submitter, {
      ...input,
      type: "workspace.updated",
      expected_revision: rec.revision,
      payload: input.fields,
    });
    return { ok: true, receipt };
  } catch (e) {
    const t = translateWorkError(e, input.project_id, "");
    if (t !== null) return t;
    throw e;
  }
}

export interface FreezeWorkspaceInput {
  project_id: string;
  workspace_id: string;
  change_id: string;
  actor_id: string;
  role: string;
  expected_revision: number;
  /** 未提交内容是否纳入候选（**必须显式声明**） */
  included_uncommitted: boolean;
  /** 声明纳入的路径（`included_uncommitted` 为真时至少一条） */
  declared_paths: string[];
  /** 来源提交（Git 项目；非 Git 省略） */
  source_commit?: string | null;
  /** 候选索引版本指针（candidateSource 模块给出；未接线时省略） */
  candidate_index_revision?: string | null;
  /** 配套版本绑定（§6.14 第 3 段；缺省各字段记 null＝未知） */
  version_binding?: Partial<WorkspaceVersionBinding>;
  /** 调用方**显式声明**本候选是构建包交付（§6.14 第 3 段；只增加严格性：声明了却没有受支持构建链 ⇒ 明确拒） */
  declared_package?: boolean;
  occurred_at?: string;
}
const FREEZE_KEYS = [...ENVELOPE_KEYS, "expected_revision", "included_uncommitted", "declared_paths", "source_commit", "candidate_index_revision", "version_binding", "declared_package"] as const;

/**
 * 冻结工作区（`preparing`→`frozen`）：固定**完整实际输入**并绑定配套版本。
 * 源目录由**宿主实测**内容指纹（不采信调用方 measured）；锁内再做一次同一份重核。
 */
export function freezeWorkspace(submitter: WorkspaceSubmitter, input: FreezeWorkspaceInput): WorkspaceOutcome<{ receipt: WorkReceipt }> {
  assertCommandKeys(input, FREEZE_KEYS, `冻结工作区 ${input.workspace_id}`);
  const current = projectionOf(submitter);
  const rec = current.workspaces[input.workspace_id];
  if (rec === undefined) return failureOf("WORKSPACE_UNKNOWN", `工作区不存在：${input.workspace_id}`, input.project_id, "");
  if (rec.revision !== input.expected_revision) {
    return failureOf("VERSION_CONFLICT", `冻结工作区 ${input.workspace_id} 版本冲突：声明 ${input.expected_revision}，当前 ${rec.revision}`, input.project_id, "");
  }
  if (rec.status === "retired") return failureOf("CANDIDATE_FROZEN", `工作区 ${input.workspace_id} 已回收，不能冻结`, input.project_id, "");
  if (input.included_uncommitted && input.declared_paths.length === 0) {
    return failureOf("FREEZE_MISSING_DECLARED", "声明纳入未提交内容却没有 declared_paths：遗漏声明项拒绝冻结", input.project_id, "", { detail: { workspace_id: input.workspace_id } });
  }
  const sourceCommit = input.source_commit === undefined ? rec.source_commit : input.source_commit ?? null;
  // 宿主实测：内容指纹由源目录现读算出，不用调用方自报
  const inspection = sourceInspector.inspect({ root: rec.root, declared_paths: input.declared_paths, included_uncommitted: input.included_uncommitted });
  if (!inspection.ok || inspection.content_fingerprint === null) {
    return failureOf("FREEZE_SOURCE_UNRESOLVED", `冻结源解析不了：${inspection.failures.join("；") || "检查器未给出内容指纹"}`, input.project_id, "", { failures: inspection.failures, detail: { workspace_id: input.workspace_id, root: rec.root } });
  }
  if (sourceCommit !== null && inspection.content_fingerprint === sourceCommit) {
    return failureOf("FREEZE_SOURCE_UNRESOLVED", "内容指纹与 source_commit 相同：疑似以 HEAD 顶替实际内容，拒绝冻结", input.project_id, "", { detail: { workspace_id: input.workspace_id } });
  }
  // 宿主实测构建包身份（§6.14 第 3 段）：这里做**劝告性预查**，真正定稿在锁内守卫（同一判据）。
  // 冻结只判构建**输入**，不要求产物已存在（先冻结后构建）。
  const preDerived = deriveWorkspaceBuildBinding(rec.root, { declaredPackage: input.declared_package === true });
  if (preDerived.ok === false) {
    return failureOf(preDerived.code, preDerived.message, input.project_id, "", { detail: { workspace_id: input.workspace_id, ...preDerived.detail } });
  }
  const binding: WorkspaceVersionBinding = {
    design_sha256: input.version_binding?.design_sha256 ?? null,
    plan_sha256: input.version_binding?.plan_sha256 ?? null,
    baseline_id: input.version_binding?.baseline_id ?? null,
    ledger_last_seq: input.version_binding?.ledger_last_seq ?? current.last_seq,
    requirement_cursor: input.version_binding?.requirement_cursor ?? null,
    // 构建包身份由**宿主实测**（锁内守卫按同一判据现算并定稿）：这里只做预查，**不把值塞进 payload**
    // ——调用方提供的 build_identity 会被锁内守卫明确拒（§6.14 第 3 段「不接受自报」）。
    build_identity: null,
  };
  const payload: Record<string, unknown> = {
    content_fingerprint: inspection.content_fingerprint,
    included_uncommitted: input.included_uncommitted,
    declared_paths: input.declared_paths,
    ...(input.candidate_index_revision === undefined ? {} : { candidate_index_revision: input.candidate_index_revision }),
    ...(sourceCommit === null ? {} : { source_commit: sourceCommit }),
    ...(input.declared_package === undefined ? {} : { declared_package: input.declared_package }),
    version_binding: binding,
  };
  try {
    const receipt = submitWorkspaceEvent(submitter, { ...input, type: "workspace.frozen", expected_revision: rec.revision, payload });
    return { ok: true, receipt };
  } catch (e) {
    const t = translateWorkError(e, input.project_id, "");
    if (t !== null) return t;
    throw e;
  }
}

export interface RetireWorkspaceInput {
  project_id: string;
  workspace_id: string;
  change_id: string;
  actor_id: string;
  role: string;
  expected_revision: number;
  reason: string;
  /** 回收前提证据（可达性：提交可还原 / 快照库在；只记状态，不声称物理目录已清理） */
  reachability: string;
  occurred_at?: string;
}
const RETIRE_KEYS = [...ENVELOPE_KEYS, "expected_revision", "reason", "reachability"] as const;

/** 回收工作区（`preparing`/`frozen`→`retired`）。只记状态，不声称物理目录已清理。 */
export function retireWorkspace(submitter: WorkspaceSubmitter, input: RetireWorkspaceInput): WorkspaceOutcome<{ receipt: WorkReceipt }> {
  assertCommandKeys(input, RETIRE_KEYS, `回收工作区 ${input.workspace_id}`);
  if (!WS_COORD_ROLES.has(input.role)) return failureOf("WORKSPACE_ROLE_FORBIDDEN", `回收只允许协调者/设计者执行（收到 ${JSON.stringify(input.role)}）`, input.project_id, "");
  const current = projectionOf(submitter);
  const rec = current.workspaces[input.workspace_id];
  if (rec === undefined) return failureOf("WORKSPACE_UNKNOWN", `工作区不存在：${input.workspace_id}`, input.project_id, "");
  if (rec.revision !== input.expected_revision) return failureOf("VERSION_CONFLICT", `回收工作区 ${input.workspace_id} 版本冲突：声明 ${input.expected_revision}，当前 ${rec.revision}`, input.project_id, "");
  if (input.reason.trim() === "" || input.reachability.trim() === "") {
    return failureOf("RETIRE_PRECONDITION_UNMET", "回收必须给 reason 与 reachability（可达性说明）：不出具前提不回收", input.project_id, "", { detail: { workspace_id: input.workspace_id } });
  }
  if (current.pointer?.current_dev_workspace_id === input.workspace_id) {
    return failureOf("RETIRE_PRECONDITION_UNMET", `工作区 ${input.workspace_id} 是当前开发指针：先 select_dev 显式切走再回收`, input.project_id, "", { detail: { workspace_id: input.workspace_id, pointer: "current_dev" } });
  }
  if (current.pointer?.current_trial_workspace_id === input.workspace_id) {
    return failureOf("RETIRE_PRECONDITION_UNMET", `工作区 ${input.workspace_id} 是当前试用指针：先 point_trial 显式切走再回收`, input.project_id, "", { detail: { workspace_id: input.workspace_id, pointer: "current_trial" } });
  }
  const reach = checkRetireRecoverability(rec);
  if (!reach.recoverable) {
    return failureOf("RETIRE_PRECONDITION_UNMET", `回收前提不成立：宿主实测不可还原——${reach.detail}`, input.project_id, "", { detail: { workspace_id: input.workspace_id, basis: reach.basis, detail: reach.detail } });
  }
  try {
    const receipt = submitWorkspaceEvent(submitter, { ...input, type: "workspace.retired", expected_revision: rec.revision, payload: { reason: input.reason.trim(), reachability: input.reachability.trim() } });
    return { ok: true, receipt };
  } catch (e) {
    const t = translateWorkError(e, input.project_id, "");
    if (t !== null) return t;
    throw e;
  }
}

export interface PointerInput {
  project_id: string;
  change_id: string;
  actor_id: string;
  role: string;
  expected_revision: number;
  current_dev_workspace_id?: string | null;
  current_trial_workspace_id?: string | null;
  basis?: string;
  occurred_at?: string;
}
const POINTER_KEYS = ["project_id", "change_id", "actor_id", "role", "expected_revision", "current_dev_workspace_id", "current_trial_workspace_id", "basis", "occurred_at"] as const;

function submitPointer(submitter: WorkspaceSubmitter, input: PointerInput, payload: Record<string, unknown>): WorkReceipt {
  return submitter.submit({
    schema_version: SCHEMA_VERSION,
    project_id: input.project_id,
    change_id: input.change_id,
    entity_id: workspacePointerEntityId(input.project_id),
    expected_revision: input.expected_revision,
    type: "workspace.pointed",
    actor_id: input.actor_id,
    role: input.role,
    idempotency_key: pointerIdempotencyKey(input.project_id, input.expected_revision + 1, input.change_id),
    ...(input.occurred_at === undefined ? {} : { occurred_at: input.occurred_at }),
    payload,
  });
}

/** 改**当前开发工作区**指针（coordinator/designer）。目标必须属本项目（含派生 `:main`）。 */
export function selectDevWorkspace(submitter: WorkspaceSubmitter, input: PointerInput & { workspace_id: string }): WorkspaceOutcome<{ receipt: WorkReceipt }> {
  assertCommandKeys(input, [...POINTER_KEYS, "workspace_id"], `选择开发工作区 ${input.workspace_id}`);
  if (!WS_COORD_ROLES.has(input.role)) return failureOf("WORKSPACE_ROLE_FORBIDDEN", `select_dev 只允许协调者/设计者执行（收到 ${JSON.stringify(input.role)}）`, input.project_id, "");
  const current = projectionOf(submitter);
  const pointer = current.pointer;
  if ((pointer?.revision ?? 0) !== input.expected_revision) {
    return failureOf("VERSION_CONFLICT", `select_dev 指针版本冲突：声明 ${input.expected_revision}，当前 ${pointer?.revision ?? 0}`, input.project_id, "");
  }
  if (input.workspace_id !== mainWorkspaceId(input.project_id)) {
    const rec = current.workspaces[input.workspace_id];
    if (rec === undefined) return failureOf("WORKSPACE_UNKNOWN", `目标工作区不属本项目或不存在：${input.workspace_id}`, input.project_id, "");
    if (rec.status === "retired") return failureOf("WORKSPACE_UNKNOWN", `目标工作区 ${input.workspace_id} 已回收`, input.project_id, "");
    if (rec.kind !== "dev") return failureOf("WORKSPACE_MISMATCH", `select_dev 的目标必须是 dev 工作区（${input.workspace_id} 的 kind=${rec.kind}）`, input.project_id, "");
    if (rec.status !== "preparing") return failureOf("WORKSPACE_MISMATCH", `select_dev 的目标必须是 preparing 状态（${input.workspace_id} 当前 ${rec.status}）`, input.project_id, "");
  }
  try {
    const receipt = submitPointer(submitter, input, { current_dev_workspace_id: input.workspace_id, ...(input.basis === undefined ? {} : { basis: input.basis }) });
    return { ok: true, receipt };
  } catch (e) {
    const t = translateWorkError(e, input.project_id, "");
    if (t !== null) return t;
    throw e;
  }
}

/** 试用提升（promotion）：把已冻结候选/试用工作区提升为**当前试用候选**指针。宿主自行实测指纹。 */
export function pointTrialWorkspace(submitter: WorkspaceSubmitter, input: PointerInput & { workspace_id: string }): WorkspaceOutcome<{ receipt: WorkReceipt }> {
  assertCommandKeys(input, [...POINTER_KEYS, "workspace_id"], `提升试用候选 ${input.workspace_id}`);
  if (!WS_COORD_ROLES.has(input.role)) return failureOf("WORKSPACE_ROLE_FORBIDDEN", `point_trial 只允许协调者/设计者执行（收到 ${JSON.stringify(input.role)}）`, input.project_id, "");
  const current = projectionOf(submitter);
  const pointer = current.pointer;
  if ((pointer?.revision ?? 0) !== input.expected_revision) {
    return failureOf("VERSION_CONFLICT", `point_trial 指针版本冲突：声明 ${input.expected_revision}，当前 ${pointer?.revision ?? 0}`, input.project_id, "");
  }
  const rec = current.workspaces[input.workspace_id];
  if (rec === undefined) return failureOf("WORKSPACE_UNKNOWN", `试用目标不属本项目或不存在：${input.workspace_id}`, input.project_id, "");
  if (rec.status !== "frozen") return failureOf("WORKSPACE_NOT_FROZEN", `试用目标必须是已冻结的候选/试用工作区（${input.workspace_id} 当前 ${rec.status}）`, input.project_id, "");
  if (rec.freeze === null) return failureOf("PROMOTION_UNVERIFIED", `工作区 ${input.workspace_id} 没有冻结记录`, input.project_id, "");
  // 宿主自行实测（不采信调用方自报 measured）
  const inspection = sourceInspector.inspect({ root: rec.root, declared_paths: rec.freeze.declared_paths, included_uncommitted: rec.freeze.included_uncommitted });
  if (!inspection.ok || inspection.content_fingerprint === null || inspection.content_fingerprint !== rec.freeze.content_fingerprint) {
    return failureOf("PROMOTION_UNVERIFIED", `试用提升失败：宿主实测指纹与冻结记录不符（${inspection.failures.join("；") || "指纹不符"}）；旧指针保留`, input.project_id, "", { detail: { workspace_id: input.workspace_id } });
  }
  try {
    const receipt = submitPointer(submitter, input, { current_trial_workspace_id: input.workspace_id, ...(input.basis === undefined ? {} : { basis: input.basis }) });
    return { ok: true, receipt };
  } catch (e) {
    const t = translateWorkError(e, input.project_id, "");
    if (t !== null) return t;
    throw e;
  }
}

// ── 认领/托管写守卫复用入口（暴露给 claims / 其它托管写口） ──

export interface WorkspaceTargetCheck {
  ok: boolean;
  code?: WorkspaceFailureCode;
  message?: string;
  workspace?: WorkspaceRecord;
}

/** 认领前校验：目标工作区必须存在、属本项目、未回收（`workspace_id` 为 null 时按 `:main` 派生口径放行） */
export function checkWorkspaceForClaim(projectId: string, dataDir: string | undefined, workspaceId: string | null): WorkspaceTargetCheck {
  if (workspaceId === null || workspaceId === "") return { ok: true };
  if (workspaceId === mainWorkspaceId(projectId)) return { ok: true };
  const projection = readWorkspaces(projectWorkDir(projectId, dataDir));
  const rec = projection.workspaces[workspaceId];
  if (rec === undefined) return { ok: false, code: "WORKSPACE_UNKNOWN", message: `目标工作区不属本项目或不存在：${workspaceId}` };
  if (rec.status === "retired") return { ok: false, code: "WORKSPACE_UNKNOWN", message: `目标工作区 ${workspaceId} 已回收` };
  return { ok: true, workspace: rec };
}

/** 托管写口:被写目标根是否落在某个**冻结候选源目录**里（是则拒绝改写冻结源码；中央证据写不在此列） */
export function findFrozenWorkspaceForRoot(projectId: string, dataDir: string | undefined, targetRoot: string): WorkspaceRecord | null {
  let canonical: string;
  try {
    canonical = path.resolve(targetRoot);
  } catch {
    return null;
  }
  const projection = readWorkspaces(projectWorkDir(projectId, dataDir));
  for (const rec of Object.values(projection.workspaces)) {
    if (rec.status !== "frozen") continue;
    if (canonical === rec.root || canonical.startsWith(rec.root + path.sep)) return rec;
  }
  return null;
}

// ── 测试/集成辅助 ──

/** 列出所有纳管项目 id（守卫默认口径用；不需要时可省略） */
export function knownProjectIds(dataDir?: string): string[] {
  return listProjects(dataDir).map((p) => p.id);
}

function duplicateReceipt(rec: WorkspaceRecord): WorkReceipt {
  return {
    ok: true,
    event_id: "<duplicate-返回既有>",
    seq: rec.seq,
    entity_revision: rec.revision,
    received_at: rec.updated_at,
    duplicate: true,
    projection: { state: "applied" },
  };
}
