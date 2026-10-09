// 功能清单只读读口的**装配层**（B2/V09-52；DESIGN.md §6.12）。
//
// 一次请求：同一 revision 的事实快照 → 唯一义务派生（`deriveObligations`）→ 功能清单投影
// （`coverageModel.buildFeatureItems`）→ 分页 + 覆盖摘要 + 错误语义。
//
// **只读红线**（§6.12）：不写事件、不存证、不认领、不触发扫描、不因本路由自愈启动写服务、
// 不调模型。HTTP 路由与 MCP 工具**共用本函数**（同底层、同参数、同错误语义）。
//
// 完整性口径（§6.12，分开表达）：
//   · `paging.complete` 只表示**本次请求范围**的分页已结束；
//   · `coverage.source_complete` 表示来源是否读齐（空需求 / 未读齐 ⇒ false，**不得**报「完整」）。
//
// 版本一致性（§2.9「不许混版」）：
//   · `document=current` 读现行编辑源；`document=active` 读**已批准基线快照**（不是"现行文件恰好
//     被批准过"）；`document=<revision>` 读该修订的不可变快照；
//   · 重建不出对应快照就**如实报未知**（`state=not_derived` + reason + 补取入口），**绝不把当前通过
//     借给历史/基线之外的版本**。

import { createHash } from "node:crypto";
import fs from "node:fs";
import {
  activeBaseline,
  buildSectionIndex,
  loadDocuments,
  projectWorkbenchDir,
  readBaselineLog,
  readRevisionSnapshotText,
  resolveProjectRelative,
  sha256Hex,
  type DocumentSection,
  type ProjectBaseline,
} from "./documents";
import { projectWorkDir, readDiscuss } from "../workstation";
import {
  checksFromFacts,
  collectProjectFacts,
  eventsSnapshotOf,
  findingBlocksObject,
  withPlanSnapshot,
  type CheckInput,
  type ProjectFacts,
} from "./statusProjection";
import { foldRequirements, type RequirementProjection } from "./requirements";
import {
  deriveObligations,
  evidenceStateOfProjection,
  normalizeCheckText,
  scopeVersionOf,
  type FeatureObligationInput,
} from "./obligations";
import {
  buildFeatureItems,
  parseFeatureDeclaration,
  parsePlanFeatureMap,
  sectionsOf,
  type FeatureAcceptanceInput,
  type FeatureScopeStatus,
  type PlanFeatureMapParse,
  type SourceIssue,
} from "./coverageModel";
import { readIntentFile } from "./intent";
import { evidenceBlobPath } from "./evidence";
import { projectRootOfWorkDir } from "./sourceEvidence";
import { withDerivationScope } from "./derivationScope";
import {
  buildDeliveryOverview,
  deliveryIntegrationOf,
  parseDeliveryGateDeclaration,
  resolveDeliveryGates,
  resolveDeliveryIntegration,
  type DeliveryFeatureRead,
} from "./deliveryReadout";
import type { WorkEvent } from "./types";
import type {
  ArtifactBinding,
  FeatureLedger,
  FeatureItem,
  FeatureLedgerDocumentSelection,
  LedgerCoverage,
  LedgerPaging,
  PendingDecision,
  UnexaminedSource,
} from "../../shared/coverageTypes";

// ────────────────────────── 参数（严格验证，§6.12） ──────────────────────────

export const FEATURE_LEDGER_LIMIT_DEFAULT = 50;
export const FEATURE_LEDGER_LIMIT_MAX = 200;

export interface FeatureLedgerParams {
  /** `current` | `<scope_id>`；缺省 current */
  scope?: string;
  /** `current` | `active` | `<revision>`；缺省 active */
  document?: string;
  /** 已登记产物引用；可选 */
  artifact_ref?: string;
  /** 包版本；可选；不符 ⇒ 409 */
  expected_revision?: string;
  /** 分页游标（绑定 package_revision）；可选 */
  cursor?: string;
  /** 1..200；缺省 50 */
  limit?: number;
}

export type FeatureLedgerErrorCode =
  | "INVALID_INPUT"
  | "PROJECT_NOT_FOUND"
  | "REVISION_CHANGED"
  | "SOURCE_INVALID"
  | "SOURCE_UNAVAILABLE";

export interface FeatureLedgerError {
  ok: false;
  status: 400 | 404 | 409 | 422 | 503;
  code: FeatureLedgerErrorCode;
  message: string;
  detail: Record<string, unknown>;
}

export interface FeatureLedgerOk {
  ok: true;
  status: 200;
  ledger: FeatureLedger;
}

export type FeatureLedgerResult = FeatureLedgerOk | FeatureLedgerError;

const fail = (
  code: FeatureLedgerErrorCode,
  status: FeatureLedgerError["status"],
  message: string,
  detail: Record<string, unknown> = {},
): FeatureLedgerError => ({ ok: false, status, code, message, detail });

/** 参数**全契约严格验证**：未知键/类型错/越界一律 400 INVALID_INPUT（不静默忽略） */
export function parseFeatureLedgerParams(raw: Record<string, unknown>): FeatureLedgerParams | FeatureLedgerError {
  const allowed = ["scope", "document", "artifact_ref", "expected_revision", "cursor", "limit"];
  const extra = Object.keys(raw).filter((k) => !allowed.includes(k));
  if (extra.length > 0) {
    return fail("INVALID_INPUT", 400, `未知参数：${extra.join("、")}（只收 ${allowed.join("/")}）`, { extra });
  }
  const str = (k: string): string | undefined | FeatureLedgerError => {
    const v = raw[k];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== "string" || v.trim() === "") {
      return fail("INVALID_INPUT", 400, `参数 ${k} 必须是非空字符串`, { got: v });
    }
    return v.trim();
  };
  const out: FeatureLedgerParams = {};
  for (const k of ["scope", "document", "artifact_ref", "expected_revision", "cursor"] as const) {
    const v = str(k);
    if (v !== undefined && typeof v !== "string") return v;
    if (typeof v === "string") out[k] = v;
  }
  if (raw.limit !== undefined && raw.limit !== null) {
    const n = raw.limit;
    const num = typeof n === "number" ? n : typeof n === "string" ? Number(n) : NaN;
    if (!Number.isInteger(num) || num < 1 || num > FEATURE_LEDGER_LIMIT_MAX) {
      return fail("INVALID_INPUT", 400, `limit 必须是 1..${FEATURE_LEDGER_LIMIT_MAX} 的整数`, { got: n });
    }
    out.limit = num;
  }
  return out;
}

// ────────────────────────── package_revision / 游标 ──────────────────────────

const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");
// 同一事实在不同派生契约下不能跨版本续页；不绑定无关宿主源码。
const FEATURE_LEDGER_DERIVATION_VERSION = "feature-ledger/2";

/**
 * **递归**稳定序列化：对象键排序、数组保序（但元素里的对象也排序）。
 *
 * 为什么不能再用 `JSON.stringify(v, Object.keys(v).sort())`：当 `v` 是**数组**时，
 * 把数组自身的下标 `['0','1',…]` 当 replacer 白名单，会把每个元素对象里的字段
 * （`id`/`fp` 等）全部滤掉 → 变成 `[{},{}]`，于是**同数量、改定义指纹不变**（Codex node 实测）。
 * 递归排序后：正例重排不变、同数量改语义必变（WATCH 11:58 A）。
 */
function canonical(v: unknown): string {
  const norm = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(norm);
    if (x !== null && typeof x === "object") {
      const src = x as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(src).sort()) out[k] = norm(src[k]);
      return out;
    }
    return x;
  };
  return JSON.stringify(norm(v));
}

interface PackageRevisionInputs {
  /** 只由功能清单读口传入；其它共享此函数的读口保持原版本输入。 */
  derivation_version?: string;
  design: string | null;
  plan: string | null;
  plan_definition: string | null;
  ledger_last_seq: number;
  scope_id: string | null;
  scope_revision: string;
  /** 产物选择（DESIGN.md §2.9「同一份设计/范围/产物选择」）：切换 artifact_ref 即换包版本身份，旧游标失效 */
  artifact_ref: string | null;
  /**
   * 本范围所验行为的**源读数**摘要（§5.6「命中判定只认 source_manifest」）。
   * 相关源码改了但没有新事件时，这份读数会变 ⇒ 包版本变 ⇒ 旧游标/`expected_revision` 409；
   * 与范围无关的文件变动不进这份摘要（**不连坐**）。
   * 缺省 `""`：其它消费者（工作包）不传它时行为与接线前一致。
   */
  source_readings?: string;
}

export function packageRevisionOf(i: PackageRevisionInputs): string {
  return sha256(
    canonical({
      derivation_version: i.derivation_version,
      design: i.design,
      plan: i.plan,
      plan_definition: i.plan_definition,
      ledger_last_seq: i.ledger_last_seq,
      scope_id: i.scope_id,
      scope_revision: i.scope_revision,
      artifact_ref: i.artifact_ref,
      source_readings: i.source_readings,
    }),
  );
}

interface CursorBody {
  v: 1;
  package_revision: string;
  offset: number;
}

export function encodeCursor(body: CursorBody): string {
  return Buffer.from(JSON.stringify(body), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): CursorBody | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as CursorBody;
    if (parsed.v !== 1 || typeof parsed.package_revision !== "string" || !Number.isInteger(parsed.offset)) return null;
    return parsed;
  } catch {
    return null;
  }
}

// ────────────────────────── 主入口 ──────────────────────────

/** 项目 → 是否存在（供读口判 404）。缺省实现由调用方注入，避免本模块依赖注册表。 */
export type ProjectExistsFn = (projectId: string) => boolean;

/**
 * 功能清单只读读口的**根入口**。
 *
 * 2026-10-07 运行时负载修复：整次请求跑在**一次同步派生**的只读复用作用域里。此前 `collectProjectFacts`
 * 自带作用域、但作用域随它返回就丢了，随后的 `deriveObligations` / `checksFromFacts` / 快照选择各读各盘——
 * 同一份施工图修订被读+核哈希数十次（实测单元：一次冷读 1335 次 `readFileSync` / 134.5 MB，其中同一份
 * 不可变修订最多被读 50 次）。把整条读路径收进一个作用域后，同一次请求内的重复现读被复用，返回对象与
 * 「各读各的」逐字段相同；作用域 `finally` 一到即整体丢弃，**跨请求一律不缓存**，源一变下一个请求立刻看见。
 * 证据：E/runtime-load-fix/REPORT.md（同数据 before/after），机制与 `collectProjectFacts`/`entry` 同族。
 */
export function readFeatureLedger(
  projectId: string,
  dataDir: string,
  params: FeatureLedgerParams,
  opts: {
    project_exists: ProjectExistsFn;
    code_revision?: string | null;
    pending_decisions?: PendingDecision[];
  },
): FeatureLedgerResult {
  return withDerivationScope(() => readFeatureLedgerInScope(projectId, dataDir, params, opts));
}

function readFeatureLedgerInScope(
  projectId: string,
  dataDir: string,
  params: FeatureLedgerParams,
  opts: {
    project_exists: ProjectExistsFn;
    code_revision?: string | null;
    pending_decisions?: PendingDecision[];
  },
): FeatureLedgerResult {
  if (!opts.project_exists(projectId)) {
    return fail("PROJECT_NOT_FOUND", 404, `项目不存在: ${projectId}`, { project_id: projectId });
  }

  // 读口**自身再校验**一次入参（与 `parseFeatureLedgerParams` 同一份判据）：即使调用方漏了前置 parse、
  // 或把 parse 的错误对象直接传来，越界/未知键/形态错也一律 400——HTTP 与 MCP 同底层同错误语义。
  const revalidated = parseFeatureLedgerParams(params as unknown as Record<string, unknown>);
  if ("ok" in revalidated) return revalidated;
  params = revalidated;

  const want = params.document ?? "active";
  const scope_id = params.scope === undefined || params.scope === "current" ? null : params.scope;

  // ── ① 来源读取：一律包住抛错路径（读失败 ⇒ 503，**不返回空成功**；§6.12） ──
  let snapshot: ReturnType<typeof eventsSnapshotOf>;
  let docs: ReturnType<typeof loadDocuments>;
  try {
    snapshot = eventsSnapshotOf(projectId, dataDir);
    docs = loadDocuments(projectId, dataDir);
  } catch (e) {
    return fail("SOURCE_UNAVAILABLE", 503, `事实来源读取失败：${(e as Error).message}`, {
      next_read: "修好事实来源（事件账本/图纸）后重试；本读口不写、不自愈、不启动写宿主",
      cause: (e as Error).name,
    });
  }
  let facts: ProjectFacts;
  let requirements: RequirementProjection;
  try {
    facts = collectProjectFacts(projectId, dataDir, { code_revision: opts.code_revision ?? null, events: snapshot });
    requirements = foldRequirements(snapshot.events);
  } catch (e) {
    return fail("SOURCE_UNAVAILABLE", 503, `事实来源读取失败：${(e as Error).message}`, {
      next_read: "修好事实来源（事件账本/图纸）后重试；本读口不写、不自愈、不启动写宿主",
      cause: (e as Error).name,
    });
  }

  const unexamined: UnexaminedSource[] = [];
  let active: ProjectBaseline | null = null;
  try {
    active = activeBaseline(projectId, dataDir);
  } catch (e) {
    unexamined.push({
      ref: "baselines.jsonl",
      kind: "baseline",
      reason: `读基线流水失败（${(e as Error).message}）：拿不到生效基线，` +
        "design_coverage 一律不超过「待审」、历史/基线版本无法重建",
    });
  }

  // ── ② 文档选择：current / active（已批准基线快照）/ <revision>（不可变历史快照） ──
  const selection = selectDocuments({
    projectId,
    dataDir,
    want,
    active,
    docs,
    unexamined,
  });
  if (selection.kind === "not_derived") {
    return {
      ok: true,
      status: 200,
      ledger: notDerivedLedger(
        { reason: selection.reason, next_read: selection.next_read },
        { scope_id, artifact_ref: params.artifact_ref ?? null, selection: selection.selection },
      ),
    };
  }
  const sel = selection.sel;

  const { designText, planText, designRev, planRev, planDefinition } = sel;
  const sections = sectionsOf(designText);

  // ── ③ 事实与所选版本对齐（§2.9 不许混版） ──
  //
  // (a) **事件侧**：历史/被取代版本按"当时在效窗口"裁事件重建（审计/任务状态/缺陷/需求都是**当时**的），
  //     不把当前结果借给历史版本。现行 / 生效基线用当下事实——当下事实就是它的证据。
  let scopedFacts = facts;
  let scopedEvents = snapshot.events;
  if (sel.selection.mode === "revision" && planRev !== null) {
    const window = historyWindowEndSeqOf(snapshot.events, planRev);
    if (window.kind === "unknown") {
      return {
        ok: true,
        status: 200,
        ledger: notDerivedLedger(
          {
            reason:
              `历史版本（plan ${short(planRev)}）的事件窗口无法从定义导入事件确定：` +
              "拿不到它当时的事件边界，不能把当前结果借给它（§2.9）",
            next_read: "改用 document=active／current 读取有完整配套材料的版本",
          },
          { scope_id, artifact_ref: params.artifact_ref ?? null, selection: sel.selection },
        ),
      };
    }
    if (window.kind === "seq") {
      scopedEvents = snapshot.events.filter((e) => e.seq < window.seq);
      try {
        scopedFacts = collectProjectFacts(projectId, dataDir, {
          // 历史窗口只裁**事件**；调用方显式给的 code 修订仍沿用以复核 code 绑定（生产读口不给=null）
          code_revision: opts.code_revision ?? null,
          events: { work_dir: snapshot.work_dir, events: scopedEvents },
        });
      } catch (e) {
        return fail("SOURCE_UNAVAILABLE", 503, `历史版本事实重建失败：${(e as Error).message}`, {
          next_read: "修好事实来源后重试；本读口不写、不自愈",
          cause: (e as Error).name,
        });
      }
    }
  }
  // (b) **施工图侧**：所选施工图 ≠ 盘上现行时，用**所选**施工图重建定义 / 集成检查要求 / 分段基准。
  let factsForScope = scopedFacts;
  if (sel.plan_from_snapshot && planText !== null) {
    factsForScope = withPlanSnapshot(scopedFacts, {
      plan_text: planText,
      plan_revision: planRev,
      plan_definition: planDefinition,
    });
  }
  // 需求投影与事件同一份（历史模式用裁过的事件）
  let scopedRequirements = requirements;
  if (scopedEvents !== snapshot.events) {
    try {
      scopedRequirements = foldRequirements(scopedEvents);
    } catch (e) {
      return fail("SOURCE_UNAVAILABLE", 503, `历史版本需求投影失败：${(e as Error).message}`, {
        next_read: "修好事实来源后重试",
        cause: (e as Error).name,
      });
    }
  }

  // ── ③′ 产物选择：解析到**唯一绑定修订**，并按它收窄本次采信的检查记录（不是 echo 字符串） ──
  const evidenceExistsFor = (sha: string): boolean => {
    try {
      return fs.existsSync(evidenceBlobPath(factsForScope.work_dir, sha));
    } catch {
      return false;
    }
  };
  let artifactSelection: ArtifactBinding | null = null;
  let artifactChecks: CheckInput[] | null = null;
  if (params.artifact_ref !== undefined) {
    if (!artifactRegistered(scopedEvents, params.artifact_ref, evidenceExistsFor)) {
      return fail("SOURCE_INVALID", 422, `产物引用未登记：${params.artifact_ref}`, {
        artifact_ref: params.artifact_ref,
        next_read:
          "改用已登记的产物引用（证据正文的内容哈希，或账本里 checkpoint/submission 声明的产物名）；" +
          "本读口不写、不自愈，不会替你登记产物",
      });
    }
    artifactSelection = resolveArtifactBinding(scopedEvents, params.artifact_ref);
    // 已登记但**不能唯一绑定到某一版**：不借当前所有检查/验收给它背书，如实未知（§6.12）。
    if (artifactSelection.bound_revision === null) {
      return {
        ok: true,
        status: 200,
        ledger: notDerivedLedger(
          {
            reason: `产物引用「${params.artifact_ref}」无法唯一绑定到某一版来源：${artifactSelection.unresolved ?? "未知"}`,
            next_read:
              "改用能唯一定位的产物引用（检查记录里 evidence_sha256 命中的证据哈希），" +
              "或先在证据/提交里记录该产物绑定的是哪一版来源",
          },
          { scope_id, artifact_ref: params.artifact_ref, selection: sel.selection, artifact: artifactSelection },
        ),
      };
    }
    // 只采信**绑定到该产物那一版**的检查记录：两个不同绑定的产物不会互相借结论；
    // 当前源码后来改变也不回改这个产物在**当时**的验证结论（binding 是记录时的声明，不是现值）。
    artifactChecks = checksFromFacts(factsForScope).filter(
      (c) => c.binding.revision === artifactSelection!.bound_revision,
    );
  }

  // ── ④ 功能映射 + 逐范围义务（声明区/映射表**各解析一次**，同一事实快照） ──
  const planMap: PlanFeatureMapParse = parsePlanFeatureMap(planText ?? "");
  const declared = parseFeatureDeclaration(designText ?? "", {
    known_requirement_ids: new Set(Object.keys(scopedRequirements.requirements)),
  });
  // 功能映射批准：以**所选版本**的已批准基线为准（WATCH 11:58 C：历史选版不得借当前批准、也不被当前拒）
  const planMappingApproved = sel.plan_mapping_approved;
  const planMappingRevision = sel.plan_mapping_revision;

  const features: FeatureObligationInput[] = declared.features.map((f) => {
    const row = planMap.rows.find((r) => r.feature_id === f.item_id);
    return {
      feature_id: f.item_id,
      task_ids: row?.task_ids ?? [],
      required_check_ids: row?.required_check_ids ?? [],
      integration_check_ids: row?.integration_check_ids ?? [],
      scope_id: f.scope_raw === "null" ? null : f.scope_raw,
      mapped: row !== undefined,
    };
  });

  // 交付总览（§3.16）的两块**声明侧**输入：PLAN「交付核对声明」与 `project:delivery` 集成检查范围。
  const gateDeclaration = parseDeliveryGateDeclaration(planText ?? "");
  const deliveryIntegration = deliveryIntegrationOf(factsForScope);

  const obligations = deriveObligations({
    project_id: projectId,
    data_dir: dataDir,
    facts: factsForScope,
    // 原始事件同一快照：**唯一义务层**据此自己从不可变施工图快照推导 check 身份映射与逐条定义绑定
    events: scopedEvents,
    ...(artifactChecks === null ? {} : { checks: artifactChecks }),
    features,
    plan_mapping_approved: planMappingApproved,
    plan_mapping_revision: planMappingRevision,
    integration_requirements: factsForScope.integration_requirements,
    // `project:delivery` 的集成检查要求并入**同一次** `projectStatuses`（唯一义务层，不另算一套）
    ...(deliveryIntegration.object === null ? {} : { extra_objects: [deliveryIntegration.object] }),
  });

  // 「无运行记录」判定（DESIGN.md §4.2／附录 E.9）：**定义导入不等于运行**。
  const RUN_STATUSES = new Set(["claimed", "executing", "result_submitted", "blocked", "cancelled"]);
  const task_has_run = new Set(
    Object.entries(factsForScope.task_states)
      .filter(([, st]) => st.run_id !== null || st.owner_id !== null || st.attempt !== null || RUN_STATUSES.has(st.status))
      .map(([tid]) => tid),
  );
  const taskFingerprints: Record<string, string> = {};
  for (const [tid, defs] of Object.entries(obligations.task_checks)) {
    // 稳定排序（按 check_id）＋递归稳定序列化：**同数量改定义必变**、**重排不变**（WATCH 11:58 A）。
    const rows = defs
      .map((d) => ({ id: d.check_id, fp: d.definition_fingerprint }))
      .sort((a, b) => a.id.localeCompare(b.id));
    taskFingerprints[tid] = sha256(canonical(rows));
  }
  const featureStatus: Record<string, { projection: (typeof obligations.features)[string]["projection"]; input_gaps: string[] }> = {};
  const featureAcceptance: Record<string, { state: import("../../shared/coverageTypes").AcceptanceDimension; gate_refs: string[]; accepted_tasks: string[]; unmet: string | null }> = {};
  const featureHasRun: Record<string, boolean> = {};
  const featureRunBasis: Record<string, string | null> = {};
  for (const [fid, read] of Object.entries(obligations.features)) {
    featureStatus[fid] = { projection: read.projection, input_gaps: read.input_gaps };
    featureAcceptance[fid] = read.acceptance;
    const f = features.find((x) => x.feature_id === fid);
    const members = (f?.task_ids ?? []).filter((t) => task_has_run.has(t));
    featureHasRun[fid] = members.length > 0;
    featureRunBasis[fid] =
      members.length === 0
        ? null
        : members
            .map((t) => {
              const st = factsForScope.task_states[t];
              return st === undefined ? `${t}:?` : `${t}: ledger seq ${st.seq}（${st.updated_at}）`;
            })
            .join("、");
  }

  // ── ⑤ 章节索引的可读回调（核 review.ref 指的文件是否真实存在） + 证据存在性 ──
  const projectRoot = projectRootOfWorkDir(projectWorkDir(projectId, dataDir));
  const sectionsOfFile = (rel: string): DocumentSection[] | null => {
    const resolved = resolveProjectRelative(projectRoot, rel);
    if (!resolved.ok) return null;
    try {
      if (!fs.existsSync(resolved.abs) || !fs.statSync(resolved.abs).isFile()) return null;
      return buildSectionIndex(fs.readFileSync(resolved.abs, "utf8"));
    } catch {
      return null;
    }
  };
  const evidenceExists = (sha: string): boolean => {
    try {
      return fs.existsSync(evidenceBlobPath(factsForScope.work_dir, sha));
    } catch {
      return false;
    }
  };

  const historical = sel.selection.mode === "revision";
  // 历史不可变快照无法重建这些**非版本化**来源（intent.json / design.discuss.md）：
  // 明示时态与未读范围，**不把现在的补充/待决伪称历史**（WATCH 11:58 D）。
  const candidates = historical ? [] : unregisteredCandidates(projectId, dataDir, unexamined);
  if (historical) {
    unexamined.push({
      ref: "intent.json",
      kind: "intent",
      reason:
        "历史版本（不可变快照）：未登记候选/意图来源不是版本化材料，本次**不读当前文件**，不把现在的补充伪称历史（§2.9／§6.12）",
    });
  }
  const pendingDecisions =
    opts.pending_decisions ??
    (historical ? [] : pendingDecisionsOf(projectId, dataDir, unexamined));
  if (historical && opts.pending_decisions === undefined) {
    unexamined.push({
      ref: "design.discuss.md",
      kind: "pending_decisions",
      reason:
        "历史版本（不可变快照）：待议/待决记录不是版本化材料，本次**不读当前文件**，不把现在的待决伪称历史（§2.9／§6.12）",
    });
  }

  const scopeRevision = scopeVersionOf({
    scope_id: scope_id ?? "",
    member_task_ids: (scope_id === null ? features : features.filter((f) => f.feature_id === scope_id)).flatMap(
      (f) => f.task_ids,
    ),
    required_check_ids: [
      ...new Set(
        (scope_id === null ? features : features.filter((f) => f.feature_id === scope_id)).flatMap(
          (f) => f.required_check_ids,
        ),
      ),
    ],
    integration_check_ids: [
      ...new Set(
        (scope_id === null ? features : features.filter((f) => f.feature_id === scope_id)).flatMap(
          (f) => f.integration_check_ids,
        ),
      ),
    ],
    task_checks: obligations.task_checks,
  }).scope_revision;

  // 逐条功能**自身 scope** 的版本（唯一算法 `scopeVersionOf`；成员＝该功能自己的承接卡与检查）——
  // 与六图 `cap-loop-*` 读数、HTTP status-projection 同值；上面那一份只是本请求范围的**聚合**（WATCH 11:58 B）。
  const scopeRevisionOfFeature = (a: {
    scope_id: string;
    member_task_ids: readonly string[];
    required_check_ids: readonly string[];
    integration_check_ids: readonly string[];
  }): string => scopeVersionOf({ ...a, task_checks: obligations.task_checks }).scope_revision;
  const buildInput = {
    design_text: designText,
    plan_text: planText,
    plan_map: planMap,
    requirements: scopedRequirements,
    feature_status: featureStatus,
    feature_acceptance: featureAcceptance,
    feature_has_run: featureHasRun,
    feature_run_basis: featureRunBasis,
    task_fingerprints: taskFingerprints,
    sections,
    design_rel_path: sel.design_rel_path,
    sections_of_file: sectionsOfFile,
    evidence_exists: evidenceExists,
    design_baseline_approved: sel.design_baseline_approved,
    design_baseline_note: sel.design_baseline_note,
    source_revision: factsForScope.revisions,
    ledger_last_seq: factsForScope.last_seq,
    scope_revision: scopeRevision,
    scope_revision_of: scopeRevisionOfFeature,
    unregistered_candidates: candidates,
    pending_decisions: pendingDecisions,
    evidence_state_of: evidenceStateOfProjection,
  };
  // 交付总览要在**全范围**上算结论再分页（§3.16）：先建一份不过滤的全量，再按 scope 取本页视图。
  const builtAll = buildFeatureItems({ ...buildInput, scope_filter: null });
  const built = scope_id === null ? builtAll : buildFeatureItems({ ...buildInput, scope_filter: { scope_id } });

  // 结构非法 ⇒ 422 SOURCE_INVALID（点名行与原因；**不返回空成功**）。
  // 注意：`PLAN_MAPPING_MISSING` 是"未归属、可见但不可判绿"的**正常状态**，**不**整页 422。
  const fatalIssues = built.issues.filter((i) =>
    [
      "COLUMNS_MISSING",
      "DUPLICATE_FEATURE_ID",
      "DANGLING_REQUIREMENT",
      "SECTION_UNRESOLVED",
      "SCOPE_INVALID",
      "COVERAGE_INVALID",
      "REVIEW_MALFORMED",
      "TABLE_MISSING",
    ].includes(i.code),
  );
  if (fatalIssues.length > 0) {
    return fail("SOURCE_INVALID", 422, "功能清单声明区/来源无法解析（点名行与原因）", {
      issues: fatalIssues.map((i) => ({ code: i.code, line: i.line, message: i.message })),
      next_read: "修好 DESIGN 声明区（八列齐全/唯一功能 ID/已登记需求/可定位章节）后再读",
    });
  }

  // 定义尚未派生 ⇒ not_derived（不等于空项目）
  if (!built.declaration_found && Object.keys(scopedRequirements.requirements).length === 0) {
    return {
      ok: true,
      status: 200,
      ledger: notDerivedLedger(
        {
          reason: "DESIGN 没有功能清单声明区，且需求投影为空：没有可派生的功能定义（不等于空项目）",
          next_read: "先在 DESIGN 正文补功能清单声明区（§2.5.1），或经 manage_requirement 登记需求",
        },
        { scope_id, artifact_ref: params.artifact_ref ?? null, selection: sel.selection },
      ),
    };
  }

  // ── ⑥ 包版本（含本范围所验行为的源读数；无关源变动不连坐） ──
  // 本范围 = 本功能**声明的** required/integration 检查集合（PLAN 映射表给出）；**不**按整卡成员
  // 扩大窗口——否则同一张卡里属于别的功能的检查，其源码一变就把本功能包版本连坐改掉（WATCH 12:21）。
  // 无 scope 过滤（整清单）才用全部检查：整清单可随其任一实际功能范围变化更新，不造假总不变。
  const scopeChecks =
    scope_id === null
      ? obligations.checks
      : obligations.checks.filter((c) => {
          const f = features.find((x) => x.feature_id === scope_id);
          if (f === undefined) return false;
          return (
            f.required_check_ids.includes(c.check_id) || f.integration_check_ids.includes(c.check_id)
          );
        });
  const sourceReadings = sourceReadingsDigest(scopeChecks);
  const package_revision = packageRevisionOf({
    derivation_version: FEATURE_LEDGER_DERIVATION_VERSION,
    design: designRev,
    plan: planRev,
    plan_definition: planDefinition,
    ledger_last_seq: factsForScope.last_seq,
    scope_id,
    scope_revision: scopeRevision,
    artifact_ref: params.artifact_ref ?? null,
    source_readings: sourceReadings,
  });
  // 产物选择已在 ③′ 解析并核过登记（未登记 ⇒ 422；已登记但绑不定 ⇒ not_derived）：
  // 这里只把**唯一绑定修订**并入包版本身份——换产物（换绑定）即换包版本、旧游标失效。

  if (params.expected_revision !== undefined && params.expected_revision !== package_revision) {
    return fail("REVISION_CHANGED", 409, "包版本已过期：事实/定义/源读数已变，请重读", {
      expected_revision: params.expected_revision,
      current_revision: package_revision,
      next_read: "去掉 expected_revision 重取，或按 current_revision 重放",
    });
  }
  let offset = 0;
  if (params.cursor !== undefined) {
    const body = decodeCursor(params.cursor);
    if (body === null) {
      return fail("INVALID_INPUT", 400, "cursor 形态非法（不可解析）", { got: params.cursor });
    }
    if (body.package_revision !== package_revision) {
      return fail("REVISION_CHANGED", 409, "游标绑定的包版本与当前不一致：跨版本数据不静默返回", {
        cursor_package_revision: body.package_revision,
        current_revision: package_revision,
        next_read: "不带 cursor 重新取第一页",
      });
    }
    offset = body.offset;
  }

  const limit = params.limit ?? FEATURE_LEDGER_LIMIT_DEFAULT;
  const items = built.items;
  const page = items.slice(offset, offset + limit);
  const complete = offset + limit >= items.length;
  const paging: LedgerPaging = complete
    ? { complete: true, cursor: null }
    : { complete: false, cursor: encodeCursor({ v: 1, package_revision, offset: offset + limit }) };

  // ── ⑦ 覆盖摘要（与分页分开；分母口径全局，不受 scope 过滤影响） ──
  const registered = Object.keys(scopedRequirements.requirements).length;
  const mappedCount = built.mapped_requirement_ids.size;
  // 未映射需求按登记状态分两类（同一 `buildFeatureItems` 分类，不在这里另判一遍）：待确认候选单列，不混进正式待映射。
  const registeredCandidateCount = builtAll.registered_candidate_ids.size;
  const pendingCount = Math.max(0, registered - mappedCount - registeredCandidateCount);
  const examined = examinedSources({
    designText,
    planText,
    designRev,
    planRev,
    planDefinition,
    selection: sel.selection,
    active,
    eventsRead: true,
    requirementsRead: true,
  });
  const sourceComplete =
    unexamined.length === 0 &&
    registered > 0 &&
    mappedCount + pendingCount + registeredCandidateCount === registered;
  const coverage: LedgerCoverage = {
    examined_sources: examined,
    unexamined_sources: unexamined,
    registered_requirement_count: registered,
    mapped_count: mappedCount,
    pending_count: pendingCount,
    registered_candidate_count: registeredCandidateCount,
    formal_requirement_count: mappedCount + pendingCount,
    unregistered_candidate_count: candidates.length,
    source_complete: sourceComplete,
  };

  // ── ⑦′ 交付总览（§3.16）：同一份事实快照，**全范围**先算结论再分页 ──
  const deliveryScope: "project" | "partial" | "historical" =
    sel.selection.mode === "revision" ? "historical" : scope_id !== null ? "partial" : "project";
  const deliveryFeatures: DeliveryFeatureRead[] = builtAll.items
    .filter((i) => i.provenance.extraction === "declared")
    .map((i) => ({
      item_id: i.item_id,
      design_state: i.design_coverage.state,
      display_status: i.verification.display_status,
      agent_review_state: i.agent_review?.state ?? "unknown",
      acceptance: i.user_acceptance.state,
    }));
  // 只有**正式待映射**（未映射 ∧ 非待确认候选）才进交付阻断；待确认候选单列可见、不阻断（§3.16／§2.5）。
  const pendingRequirementIds = Object.keys(scopedRequirements.requirements)
    .filter((rid) => !builtAll.mapped_requirement_ids.has(rid) && !builtAll.registered_candidate_ids.has(rid))
    .sort();
  const deliveryGates = resolveDeliveryGates({
    declaration: gateDeclaration,
    plan_mapping_approved: planMappingApproved,
    projection: obligations.projection,
    task_checks: obligations.task_checks,
  });
  const deliveryIntegrationResolved = resolveDeliveryIntegration({
    declaration: deliveryIntegration,
    projection: obligations.projection,
  });
  // 全局阻断缺陷：判据与 canonical 逐对象 `blockingProblem` 一致（`findingBlocksObject`＝仍开放 ∧ 非用户接受风险 ∧
  // **必须拦截 ∨ 未证实/风险未排除**，见 statusProjection.ts），**不自造**一套更宽/更窄的拒绝口径（§3.16）。
  const blockingFindings = factsForScope.findings
    .filter((f) => findingBlocksObject(f))
    .map((f) => ({
      finding_id: f.finding_id,
      object_id: f.object_id,
      message: `${f.severity}，${f.status}${f.unverified ? "，未证实/风险未排除" : ""}`,
    }));
  const delivery = buildDeliveryOverview({
    scope: deliveryScope,
    drift: sel.selection.drift,
    design_baseline_approved: sel.design_baseline_approved,
    plan_mapping_approved: planMappingApproved,
    coverage: {
      source_complete: sourceComplete,
      registered_requirement_count: registered,
      mapped_count: mappedCount,
      pending_count: pendingCount,
      registered_candidate_count: registeredCandidateCount,
      unregistered_candidate_count: candidates.length,
      unexamined_sources: unexamined.map((u) => ({ ref: u.ref, reason: u.reason })),
    },
    features: deliveryFeatures,
    pending_requirement_ids: pendingRequirementIds,
    gates: deliveryGates,
    integration: deliveryIntegrationResolved,
    blocking_findings: blockingFindings,
    version: {
      design_revision: sel.selection.design_revision,
      plan_revision: sel.selection.plan_revision,
      baseline_id: sel.selection.baseline_id,
      ledger_last_seq: factsForScope.last_seq,
      drift: sel.selection.drift,
    },
  });

  const packageRevisionBasis = [
    `derivation:${FEATURE_LEDGER_DERIVATION_VERSION}`,
    `design:${designRev ?? "（读不到）"}`,
    `plan:${planRev ?? "（读不到）"}`,
    `plan_definition:${planDefinition ?? "（读不到）"}`,
    `ledger_last_seq:${factsForScope.last_seq}`,
    `scope_revision:${scopeRevision}`,
    `source_readings:${sourceReadings}`,
    `artifact_ref:${params.artifact_ref ?? "（未选）"}`,
    `artifact_bound_revision:${artifactSelection?.bound_revision ?? "（未选/未绑定）"}`,
    ...(scopedEvents === snapshot.events ? [] : [`history_cut_events:${scopedEvents.length}/${snapshot.events.length}`]),
  ];

  const ledger: FeatureLedger = {
    state: "ok",
    scope_id,
    scope_revision: scopeRevision,
    package_revision,
    package_revision_basis: packageRevisionBasis,
    document_selection: sel.selection,
    artifact_ref: params.artifact_ref ?? null,
    artifact_selection: artifactSelection,
    generated_at: new Date().toISOString(),
    source_revision: { design: designRev, plan: planRev, ledger_last_seq: factsForScope.last_seq },
    coverage,
    items: page,
    paging,
    delivery,
  };
  return { ok: true, status: 200, ledger };
}

/** `notDerived` 占位（历史遗留的参数位，不再使用 dataDir） */
// ────────────────────────── 文档选择（不许混版） ──────────────────────────

interface SelectedDocuments {
  designText: string | null;
  planText: string | null;
  designRev: string | null;
  planRev: string | null;
  planDefinition: string | null;
  design_rel_path: string;
  /** 施工图是否来自不可变快照（⇒ 需要按所选施工图重导定义） */
  plan_from_snapshot: boolean;
  design_baseline_approved: boolean;
  design_baseline_note: string | null;
  /**
   * **所选版本**的 PILOT 功能映射是否被「所选那一版的已批准基线」批准（WATCH 11:58 C）。
   * 不能拿当前生效基线去拒一个**合法历史已批准**版本，也不能把当前批准借给历史。
   */
  plan_mapping_approved: boolean;
  /** 支撑上一条的施工图修订（解释用；拿不到 = null） */
  plan_mapping_revision: string | null;
  selection: FeatureLedgerDocumentSelection;
}

/** 选择结果：选中了文档，或"该版本无法重建"（⇒ 200 `state=not_derived` + reason + 补取入口） */
type SelectResult =
  | { kind: "ok"; sel: SelectedDocuments }
  | { kind: "not_derived"; reason: string; next_read: string; selection: FeatureLedgerDocumentSelection };

function selectDocuments(args: {
  projectId: string;
  dataDir: string;
  want: string;
  active: ProjectBaseline | null;
  docs: ReturnType<typeof loadDocuments>;
  unexamined: UnexaminedSource[];
}): SelectResult {
  const { projectId, dataDir, want, active, docs, unexamined } = args;
  const curDesign = docs.design?.text ?? null;
  const curPlan = docs.plan?.text ?? null;
  const curDesignRev = docs.design?.revision.content_sha256 ?? null;
  const curPlanRev = docs.plan?.revision.content_sha256 ?? null;
  const curPlanDef = docs.plan?.revision.definition_sha256 ?? null;
  const designRel = docs.design?.source.rel_path ?? docs.plan?.source.rel_path ?? "DESIGN.md";

  const baseSelection: FeatureLedgerDocumentSelection = {
    requested: want,
    mode: "current",
    design_revision: null,
    plan_revision: null,
    plan_definition: null,
    baseline_id: active?.baseline_id ?? null,
    drift: null,
  };

  if (want === "current") {
    if (curDesign === null) {
      unexamined.push({ ref: "DESIGN.md", kind: "design", reason: "设计原文不存在或读不到：声明区与章节定位拿不到" });
    }
    if (curPlan === null) {
      unexamined.push({ ref: "PLAN.md", kind: "plan", reason: "施工图原文不存在或读不到：功能映射与卡定义拿不到" });
    }
    const matches = active !== null && curDesignRev !== null && active.design_revision.content_sha256 === curDesignRev;
    const drift =
      active === null
        ? "没有生效基线：现行草稿未获批准，design_coverage 一律不超过「待审」"
        : matches
          ? null
          : `现行设计（${short(curDesignRev)}）与已批准基线（${short(active.design_revision.content_sha256)}）不一致：` +
            "正在读现行草稿，不假装它是已批准基线";
    return {
      kind: "ok",
      sel: {
        designText: curDesign,
        planText: curPlan,
        designRev: curDesignRev,
        planRev: curPlanRev,
        planDefinition: curPlanDef,
        design_rel_path: designRel,
        plan_from_snapshot: false,
        design_baseline_approved: matches,
        design_baseline_note: matches ? null : (drift ?? "设计基线未批准当前所读版本"),
        // 功能映射随**当前施工图**：只有生效基线批准的正是这份现行施工图才算批准
        plan_mapping_approved:
          active !== null && curPlanRev !== null && active.plan_revision.content_sha256 === curPlanRev,
        plan_mapping_revision: active?.plan_revision.content_sha256 ?? null,
        selection: {
          ...baseSelection,
          mode: "current",
          design_revision: curDesignRev,
          plan_revision: curPlanRev,
          plan_definition: curPlanDef,
          drift,
        },
      },
    };
  }

  if (want === "active") {
    if (active === null) {
      // 没有生效基线：**按现行草稿读**并如实点名（不假装读到了已批准快照），
      // 这样声明区的结构问题仍然照常 422，不会因为"没有基线"整页退化成未知。
      if (curDesign === null) {
        unexamined.push({ ref: "DESIGN.md", kind: "design", reason: "设计原文不存在或读不到：声明区与章节定位拿不到" });
      }
      if (curPlan === null) {
        unexamined.push({ ref: "PLAN.md", kind: "plan", reason: "施工图原文不存在或读不到：功能映射与卡定义拿不到" });
      }
      unexamined.push({
        ref: "baseline",
        kind: "baseline",
        reason: "没有生效基线：document=active 要求的已批准快照不可得，本次按现行草稿读，design_coverage 一律不超过「待审」",
      });
      return {
        kind: "ok",
        sel: {
          designText: curDesign,
          planText: curPlan,
          designRev: curDesignRev,
          planRev: curPlanRev,
          planDefinition: curPlanDef,
          design_rel_path: designRel,
          plan_from_snapshot: false,
          design_baseline_approved: false,
          design_baseline_note: "没有生效基线",
          plan_mapping_approved: false,
          plan_mapping_revision: null,
          selection: {
            ...baseSelection,
            mode: "current",
            design_revision: curDesignRev,
            plan_revision: curPlanRev,
            plan_definition: curPlanDef,
            drift: "没有生效基线：document=active 的已批准快照不可得，按现行草稿读（未获批准）",
          },
        },
      };
    }
    // 读**基线快照**（不是现行文件）：读不出/哈希对不上 ⇒ 如实未知，不套当前通过结论
    const designSnapshot = readSnapshot(projectId, "design", active.design_revision.content_sha256, dataDir);
    if (designSnapshot === null || designSnapshot.sha256 !== active.design_revision.content_sha256) {
      return {
        kind: "not_derived",
        reason:
          `已批准基线的设计快照（${short(active.design_revision.content_sha256)}）读不到或与基线记录不一致：` +
          "该版本无法重建，不套用当前通过结论（DESIGN.md §2.9／§6.12）",
        next_read: "document=current 读现行草稿；或恢复该修订的不可变快照（.工作台/design-revisions/<hash>.md）后重读",
        selection: {
          ...baseSelection,
          mode: "active",
          baseline_id: active.baseline_id,
          drift: "基线设计快照不可读",
        },
      };
    }
    const planSnapshot = readPlanSnapshotFor(projectId, dataDir, active.plan_revision);
    const planOk = planSnapshot !== null;
    if (!planOk) {
      unexamined.push({
        ref: `plan-revisions/${active.plan_revision.definition_sha256}.md`,
        kind: "plan",
        reason: "已批准基线的施工图快照读不到或与基线记录不一致：功能映射与卡定义拿不到（不套当前施工图）",
      });
    }
    const driftCur =
      curDesignRev !== null && curDesignRev !== active.design_revision.content_sha256
        ? `现行设计（${short(curDesignRev)}）已改；本次读的是已批准快照（${short(active.design_revision.content_sha256)}），不假装现行=基线`
        : null;
    return {
      kind: "ok",
      sel: {
        designText: designSnapshot.text,
        planText: planOk ? planSnapshot.text : null,
        designRev: active.design_revision.content_sha256,
        planRev: planOk ? active.plan_revision.content_sha256 : null,
        planDefinition: planOk ? active.plan_revision.definition_sha256 : null,
        design_rel_path: designRel,
        plan_from_snapshot: true,
        design_baseline_approved: true,
        design_baseline_note: null,
        plan_mapping_approved: planOk,
        plan_mapping_revision: planOk ? active.plan_revision.content_sha256 : null,
        selection: {
          ...baseSelection,
          mode: "active",
          design_revision: active.design_revision.content_sha256,
          plan_revision: planOk ? active.plan_revision.content_sha256 : null,
          plan_definition: planOk ? active.plan_revision.definition_sha256 : null,
          drift: driftCur,
        },
      },
    };
  }

  // 显式历史修订：只认 design 修订（内容哈希）
  const designSnapshot = readSnapshot(projectId, "design", want, dataDir);
  if (designSnapshot === null || designSnapshot.sha256 !== want) {
    return {
      kind: "not_derived",
      reason:
        `请求的历史修订 ${want.slice(0, 12)}… 没有可读的不可变快照（或快照与声明的哈希不一致）：` +
        "历史状态无法重建，不套用当前通过结论（DESIGN.md §6.12）",
      next_read: "document=current 或 document=active 读取现行/基线版本；历史重建需该项目保留对应修订快照",
      selection: {
        ...baseSelection,
        mode: "revision",
        baseline_id: active?.baseline_id ?? null,
        drift: "历史修订快照不可读",
      },
    };
  }
  // 配套施工图：在**整条基线流水**（不只生效基线）里找「设计修订 == 本次请求」的基线。
  // 同一设计修订配多条不同施工图 ⇒ **歧义**，如实点名不猜（WATCH 11:29：「设计hash同但多PLAN基线有歧义」）。
  const pair = findBaselinesForDesign(projectId, dataDir, want, unexamined);
  if (pair.ambiguous.length > 0) {
    return {
      kind: "not_derived",
      reason:
        `历史设计修订 ${want.slice(0, 12)}… 在基线流水里配到**多条不同施工图**（` +
        `${pair.ambiguous.join("、")}）：无法唯一确定本版本的施工图与检查定义，不猜（§2.9 不许混版）`,
      next_read: "改用 document=active（生效基线成对图纸）或 document=current；或先解除该设计修订的基线歧义",
      selection: {
        ...baseSelection,
        mode: "revision",
        baseline_id: pair.baseline?.baseline_id ?? null,
        design_revision: want,
        drift: "历史设计修订在基线流水里配到多条不同施工图",
      },
    };
  }
  const baselineForRev = pair.baseline;
  const planSnapshot =
    baselineForRev === null ? null : readPlanSnapshotFor(projectId, dataDir, baselineForRev.plan_revision);
  const planOk = planSnapshot !== null && baselineForRev !== null;
  if (!planOk) {
    unexamined.push({
      ref: "plan-revisions",
      kind: "plan",
      reason:
        "该历史设计修订没有可定位的配套施工图版本：功能映射与卡定义无法重建（如实未知，不套当前施工图）",
    });
  }
  return {
    kind: "ok",
    sel: {
      designText: designSnapshot.text,
      planText: planOk ? planSnapshot.text : null,
      designRev: want,
      planRev: planOk ? baselineForRev.plan_revision.content_sha256 : null,
      planDefinition: planOk ? baselineForRev.plan_revision.definition_sha256 : null,
      design_rel_path: designRel,
      plan_from_snapshot: true,
      design_baseline_approved: planOk,
      design_baseline_note: planOk ? null : "该历史修订没有可定位的已批准配套版本",
      // 历史选版：以**所选那一版的已批准基线**核映射批准，不借当前批准、也不把合法历史批准抹掉（WATCH 11:58 C）
      plan_mapping_approved: planOk && baselineForRev !== null,
      plan_mapping_revision: baselineForRev?.plan_revision.content_sha256 ?? null,
      selection: {
        ...baseSelection,
        mode: "revision",
        design_revision: want,
        plan_revision: planOk ? baselineForRev.plan_revision.content_sha256 : null,
        plan_definition: planOk ? baselineForRev.plan_revision.definition_sha256 : null,
        drift: "读的是不可变历史快照：只关联当时可取回的映射与证据",
      },
    },
  };
}

/**
 * 被取代版本的事件侧**窗口终点**（不含）：从账本的 `task.definition_imported` 时间线推。
 *
 * 为什么用 seq 而不是基线时间：基线 `active_at` 只有秒级，同一秒内"版本切换"与"切换后的事件"
 * 分不开，按时间裁会把切换后的事件放进历史窗口（实测：同秒 ⇒ 裁切形同虚设）。定义导入事件带
 * 服务端序，是**不可伪造且精确**的边界：
 *   · `unknown` = 该施工图修订**没有任何定义导入事件**（拿不到它当时的事件边界）；
 *   · `none`    = 它之后没有更新的定义导入（⇒ 它就是最新，不裁）；
 *   · `seq`     = 之后第一条**别的**施工图修订的定义导入 seq（窗口 = 所有 `seq < 它` 的事件）。
 */
function historyWindowEndSeqOf(
  events: readonly WorkEvent[],
  planRevision: string,
): { kind: "seq"; seq: number } | { kind: "none" } | { kind: "unknown" } {
  const imports = [...events]
    .filter((e) => e.type === "task.definition_imported")
    .sort((a, b) => a.seq - b.seq);
  const mine = imports.filter((e) => e.payload.plan_revision === planRevision);
  if (mine.length === 0) return { kind: "unknown" };
  const lastIn = mine[mine.length - 1].seq;
  const later = imports.find((e) => e.seq > lastIn && e.payload.plan_revision !== planRevision);
  return later === undefined ? { kind: "none" } : { kind: "seq", seq: later.seq };
}

/** 读某个修订的不可变快照（同时核内容哈希）；读不到/对不上 = null */
function readSnapshot(
  projectId: string,
  kind: "design" | "plan",
  hash: string,
  dataDir: string,
): { text: string; sha256: string } | null {
  try {
    const text = readRevisionSnapshotText(projectId, kind, hash, dataDir);
    if (text === null) return null;
    return { text, sha256: sha256Hex(text) };
  } catch {
    return null;
  }
}

/**
 * 读某基线的**施工图快照**：逐候选（主名定义哈希 → 内容哈希）**核内容哈希**。
 *
 * 为什么不能只读主名：`plan-revisions/<定义 sha256>.md` 存的是该定义哈希下的**第一份**正文；
 * 后续正文变而定义哈希没变（§2.9：记录/检查项改动）时新正文落在 `<内容 sha256>.md`。
 * 只读主名会拿到**旧正文**（甚至和基线记录的 content 哈希对不上），既不 resolve 也不能回退，
 * 于是"同定义哈希、正文已改"的版本读不回来（实测）。这里按候选逐份核 content 哈希，不混版。
 */
function readPlanSnapshotFor(
  projectId: string,
  dataDir: string,
  ref: { definition_sha256: string; content_sha256: string },
): { text: string; sha256: string } | null {
  const seen = new Set<string>();
  for (const h of [ref.definition_sha256, ref.content_sha256]) {
    if (typeof h !== "string" || h === "" || seen.has(h)) continue;
    seen.add(h);
    const s = readSnapshot(projectId, "plan", h, dataDir);
    if (s !== null && s.sha256 === ref.content_sha256) return s;
  }
  return null;
}

/**
 * 找**配套施工图**：在整条基线流水里找「设计修订 == 给定内容哈希」的基线（不只生效基线）。
 *
 * 为什么必须扫全流水而不是只看生效基线：历史重建的对象往往正是**已被取代**的基线——
 * 只看生效基线等于"历史永远重建不出来"（WATCH 11:29 指出的占位行为）。
 * 同一设计哈希配到**多条不同施工图** ⇒ 歧义，逐条点名交回调用方**不猜**。
 * 返回 `in_force_until` = 该基线被下一条取代的时间（事件侧事实的裁切点；它已是最后一条则为 null＝不裁）。
 */
function findBaselinesForDesign(
  projectId: string,
  dataDir: string,
  designSha: string,
  unexamined: UnexaminedSource[],
): { baseline: ProjectBaseline | null; in_force_until: string | null; ambiguous: string[] } {
  let log: ReturnType<typeof readBaselineLog>;
  try {
    log = readBaselineLog(projectId, dataDir);
  } catch (e) {
    unexamined.push({
      ref: "baselines.jsonl",
      kind: "baseline",
      reason: `读基线流水失败（${(e as Error).message}）：历史修订的配套施工图无法定位，按未知处理`,
    });
    return { baseline: null, in_force_until: null, ambiguous: [] };
  }
  if (log.corrupt.length > 0) {
    unexamined.push({
      ref: "baselines.jsonl",
      kind: "baseline",
      reason: `基线流水有 ${log.corrupt.length} 条坏行（第 ${log.corrupt.map((c) => c.line).join("、")} 行）：可能的配套版本可能缺失，不静默当作没有`,
    });
  }
  const indexes = log.baselines
    .map((b, i) => ({ b, i }))
    .filter((x) => x.b.design_revision.content_sha256 === designSha);
  if (indexes.length === 0) return { baseline: null, in_force_until: null, ambiguous: [] };
  const planHashes = [...new Set(indexes.map((x) => x.b.plan_revision.content_sha256))];
  if (planHashes.length > 1) {
    return {
      baseline: indexes[indexes.length - 1].b,
      in_force_until: null,
      ambiguous: planHashes.map((h) => `plan ${h.slice(0, 12)}…`),
    };
  }
  const last = indexes[indexes.length - 1];
  const next = log.baselines[last.i + 1];
  return {
    baseline: last.b,
    in_force_until: next === undefined ? null : next.active_at,
    ambiguous: [],
  };
}

function short(rev: string | null | undefined): string {
  return typeof rev === "string" && rev !== "" ? `${rev.slice(0, 12)}…` : "（未知）";
}

// ────────────────────────── 派生辅助 ──────────────────────────

/**
 * 本范围所验行为的**源读数摘要**（§5.6：命中判定只认 `source_manifest`）。
 * 只收**与本次范围相关**的检查记录（无关文件变动不进这份摘要，不连坐）。
 */
function sourceReadingsDigest(checks: readonly CheckInput[]): string {
  const rows: string[] = [];
  for (const c of checks) {
    const v = c.source_manifest;
    if (v === undefined || v === null) continue;
    rows.push(`${c.object_id}|${c.check_id}|${v.status}|${v.current_fingerprint ?? ""}|${v.changed.join(",")}|${v.missing.join(",")}`);
  }
  rows.sort();
  return sha256(rows.join("\n")).slice(0, 32);
}

/** 产物引用是否**真登记过**：64hex 必须是证据库里的正文；否则必须在账本声明过的产物里出现 */
function artifactRegistered(
  events: readonly WorkEvent[],
  artifactRef: string,
  evidenceExists: (sha: string) => boolean,
): boolean {
  if (/^[0-9a-f]{64}$/.test(artifactRef)) return evidenceExists(artifactRef);
  const seen = new Set<string>();
  const walk = (v: unknown, key: string): void => {
    if (typeof v === "string") {
      if (key === "artifacts" || key === "artifact_ref" || key === "artifact_refs") seen.add(v);
      return;
    }
    if (Array.isArray(v)) {
      for (const item of v) walk(item, key);
      return;
    }
    if (v !== null && typeof v === "object") {
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) walk(val, k);
    }
  };
  for (const e of events) walk(e.payload, "");
  return seen.has(artifactRef);
}

/** 本次真正读到的来源（**只列真读到的**；声明存在但没读到的一律进 `unexamined_sources`） */
function examinedSources(args: {
  designText: string | null;
  planText: string | null;
  designRev: string | null;
  planRev: string | null;
  planDefinition: string | null;
  selection: FeatureLedgerDocumentSelection;
  active: ProjectBaseline | null;
  eventsRead: boolean;
  requirementsRead: boolean;
}): { ref: string; kind: string }[] {
  const out: { ref: string; kind: string }[] = [];
  if (args.eventsRead) out.push({ ref: "events.jsonl", kind: "ledger" });
  if (args.requirementsRead) out.push({ ref: "requirements(events.jsonl)", kind: "requirements" });
  if (args.designText !== null) {
    out.push({ ref: `DESIGN(${short(args.designRev)})`, kind: "design" });
    out.push({ ref: "sections(DESIGN)", kind: "sections" });
  }
  if (args.planText !== null) {
    out.push({ ref: `PLAN(${short(args.planRev)})`, kind: "plan" });
    out.push({ ref: `plan_definition(${short(args.planDefinition)})`, kind: "plan_definition" });
  }
  if (args.selection.mode === "active" && args.active !== null) {
    out.push({ ref: `baseline:${args.active.baseline_id}`, kind: "baseline" });
  }
  return out;
}

/**
 * 待决项（**另列，不与四维混**）：来源＝既有待议记录（`.工作台/design.discuss.md` / 塔台附录 B）。
 * 读不到就如实进 `unexamined_sources`，**不静默当成"没有待决项"**。
 */
function pendingDecisionsOf(
  projectId: string,
  dataDir: string,
  unexamined: UnexaminedSource[],
): PendingDecision[] {
  let doc: ReturnType<typeof readDiscuss>;
  try {
    doc = readDiscuss(projectId, dataDir);
  } catch (e) {
    unexamined.push({
      ref: "design.discuss.md",
      kind: "pending_decisions",
      reason: `待议记录读取失败（${(e as Error).message}）：真实待决项未知，不按空数组呈现`,
    });
    return [];
  }
  if (!doc.exists || doc.content === undefined) return [];
  const out: PendingDecision[] = [];
  doc.content.split(/\r?\n/).forEach((line, i) => {
    const m = /^-\s+`([^`]*)`\s*(.*)$/.exec(line.trim());
    if (m === null) return;
    const text = m[2].trim();
    if (text === "") return;
    out.push({
      decision_id: `discuss#L${i + 1}`,
      question: text,
      impact: "待议：影响范围与处置未定",
      suggestion: "",
      entry: `${doc.source ?? "design.discuss.md"}#L${i + 1}`,
    });
  });
  return out;
}

/**
 * 未登记候选（用户补充）→ 稳定来源定位符摘要（身份**不从中文标题重算**，§2.5.1）。
 * 读不到来源时**不静默空**：进 `unexamined_sources`。
 */
function unregisteredCandidates(
  projectId: string,
  dataDir: string,
  unexamined: UnexaminedSource[],
): { locator_digest: string; display_name: string; source_ref: string }[] {
  const out: { locator_digest: string; display_name: string; source_ref: string }[] = [];
  const seen = new Set<string>();
  const push = (locator: string, text: string): void => {
    const digest = sha256(locator).slice(0, 16);
    if (seen.has(digest)) return;
    seen.add(digest);
    out.push({ locator_digest: digest, display_name: normalizeCheckText(text).slice(0, 80), source_ref: locator });
  };
  try {
    const intent = readIntentFile(projectWorkbenchDir(projectId, dataDir));
    for (const item of intent?.items ?? []) push(`intent.json#${item.id}`, item.text);
  } catch (e) {
    unexamined.push({
      ref: "intent.json",
      kind: "intent",
      reason: `意图文件读取失败（${(e as Error).message}）：未登记候选可能不全，不静默当"没有候选"`,
    });
  }
  try {
    const doc = readDiscuss(projectId, dataDir);
    if (doc.exists && doc.content !== undefined) {
      doc.content.split(/\r?\n/).forEach((line, i) => {
        if (/^\s*-\s*`/.test(line)) push(`design.discuss.md#L${i + 1}`, line.replace(/^\s*-\s*/, ""));
      });
    }
  } catch (e) {
    unexamined.push({
      ref: "design.discuss.md",
      kind: "discuss",
      reason: `待议记录读取失败（${(e as Error).message}）：未登记候选可能不全，不静默当"没有候选"`,
    });
  }
  return out;
}

// ────────────────────────── not_derived ──────────────────────────

function emptySelection(requested: string): FeatureLedgerDocumentSelection {
  return {
    requested,
    mode: "current",
    design_revision: null,
    plan_revision: null,
    plan_definition: null,
    baseline_id: null,
    drift: null,
  };
}

/** 构造 `state=not_derived` 的 **200** 响应体（必带 reason + next_read；不等于空项目） */
function notDerivedLedger(
  info: { reason: string; next_read: string },
  opts: {
    scope_id: string | null;
    artifact_ref: string | null;
    selection: FeatureLedgerDocumentSelection;
    artifact?: ArtifactBinding | null;
  },
): FeatureLedger {
  return {
    state: "not_derived",
    scope_id: opts.scope_id,
    scope_revision: "",
    package_revision: "",
    package_revision_basis: [],
    document_selection: opts.selection,
    artifact_ref: opts.artifact_ref,
    artifact_selection: opts.artifact ?? null,
    generated_at: new Date().toISOString(),
    source_revision: { design: null, plan: null, ledger_last_seq: 0 },
    coverage: {
      examined_sources: [],
      unexamined_sources: [{ ref: "definition", kind: "definition", reason: info.reason }],
      registered_requirement_count: 0,
      mapped_count: 0,
      pending_count: 0,
      // 这里刻意**不给** registered_candidate_count／formal_requirement_count：not_derived 未必没有需求
      // （可能是选版/产物绑定拿不到），给 0 会冒充"没有候选/没有正式需求"——缺字段＝未知，由读侧如实显示。
      unregistered_candidate_count: 0,
      source_complete: false,
    },
    items: [],
    paging: { complete: true, cursor: null },
    delivery: {
      state: "unknown",
      summary: `交付条件尚未核对：${info.reason}`,
      scope: opts.selection.mode === "revision" ? "historical" : opts.scope_id !== null ? "partial" : "project",
      counts: {
        features: 0,
        design_checked: 0,
        verified: 0,
        reviewed: 0,
        requirements: 0,
        mapped_requirements: 0,
        pending_requirements: 0,
        candidates: 0,
      },
      gates: [],
      integration: {
        state: "unknown",
        check_ids: [],
        missing: [`交付条件尚未核对：${info.reason}`],
        evidence: [],
      },
      blockers: [{ kind: "not_derived", item_id: null, message: info.reason }],
      version: {
        design_revision: opts.selection.design_revision,
        plan_revision: opts.selection.plan_revision,
        baseline_id: opts.selection.baseline_id,
        ledger_last_seq: 0,
        drift: opts.selection.drift,
      },
      user_acceptance: { pending: 0, accepted: 0, rejected: 0, accepted_known_limit: 0 },
    },
    reason: info.reason,
    next_read: info.next_read,
  };
}

/**
 * 把产物引用解析到**唯一绑定修订**（§6.12／§2.9）。
 *
 * 判据（只认账本事实，不另建产物注册平台）：
 *   · 候选 = 直接引用该产物的**检查记录**（`checks[].evidence_sha256 === ref`，或 payload 里
 *     artifacts/artifact_ref/artifact_refs 提到该名字的事件）；
 *   · 取这些记录声明的 `binding`（`revision_kind` + `revision`）：
 *       - 恰好一种 ⇒ 唯一绑定；
 *       - 0 种 ⇒ 未绑定（没有可确定版本的证据记录）；
 *       - 多种 ⇒ 歧义（逐条点名，**不猜**第一条）。
 *   · **绝不**用"当前所有检查/验收"给一个绑不定的产物背书。
 */
export function resolveArtifactBinding(events: readonly WorkEvent[], artifactRef: string): ArtifactBinding {
  const candidates: { record_ref: string; revision_kind: string; revision: string }[] = [];
  const mentionsArtifact = (v: unknown, key: string): boolean => {
    if (typeof v === "string") return (key === "artifacts" || key === "artifact_ref" || key === "artifact_refs") && v === artifactRef;
    if (Array.isArray(v)) return v.some((item) => mentionsArtifact(item, key));
    if (v !== null && typeof v === "object") {
      return Object.entries(v as Record<string, unknown>).some(([k, val]) => mentionsArtifact(val, k));
    }
    return false;
  };
  for (const e of [...events].sort((a, b) => a.seq - b.seq)) {
    if (e.type !== "audit.self_check_recorded" && e.type !== "audit.independent_audit_recorded") continue;
    const p: Record<string, unknown> = e.payload ?? {};
    const rawChecks = Array.isArray(p.checks) ? (p.checks as unknown[]) : [];
    const hashHit = rawChecks.some(
      (c) =>
        typeof c === "object" &&
        c !== null &&
        (c as { evidence_sha256?: unknown }).evidence_sha256 === artifactRef,
    );
    if (!hashHit && !mentionsArtifact(p, "")) continue;
    const b = p.binding;
    if (typeof b !== "object" || b === null) continue;
    const kind = (b as { revision_kind?: unknown }).revision_kind;
    const rev = (b as { revision?: unknown }).revision;
    if (typeof kind !== "string" || typeof rev !== "string" || rev === "") continue;
    candidates.push({ record_ref: e.entity_id, revision_kind: kind, revision: rev });
  }
  const distinct = [...new Set(candidates.map((c) => `${c.revision_kind}:${c.revision}`))];
  if (distinct.length === 1) {
    const [kind, ...rest] = distinct[0].split(":");
    return {
      requested: artifactRef,
      bound_revision: rest.join(":"),
      revision_kind: kind as ArtifactBinding["revision_kind"],
      evidence_records: [...new Set(candidates.map((c) => c.record_ref))],
      candidates: [],
      unresolved: null,
    };
  }
  if (distinct.length === 0) {
    return {
      requested: artifactRef,
      bound_revision: null,
      revision_kind: null,
      evidence_records: [],
      candidates: [],
      unresolved:
        "没有任何检查记录引用这个产物（或引用的记录没有绑定声明）：无法确定它验的是哪一版，不借当前结论",
    };
  }
  return {
    requested: artifactRef,
    bound_revision: null,
    revision_kind: null,
    evidence_records: [...new Set(candidates.map((c) => c.record_ref))],
    candidates: distinct,
    unresolved: `该产物被多条检查记录引用、指向**多个不同绑定**（${distinct.join("、")}）：无法唯一确定，不猜`,
  };
}
