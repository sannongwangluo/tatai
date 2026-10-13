// V09-66 宿主接线：把 `gitFinalize.executeVerifiedLocalCommit` 的**中央事实源**接到真实账本
// （PLAN V09-66；DESIGN.md §6.13 第 7 段、§6.14 第 7/9 段）。
//
// 红线（逐条对 §6.14 第 9 段读）：
//   · **不信任调用方自报**：grant 由宿主读唯一写口/账本后填入；请求不能带 grant／通过布尔／绝对任意 root。
//   · **判据是「存在有效授权记录」**，不因任务转入完成态而失效；据此派生 authorized。
//   · **fail-closed**：技术验证/独立审查/完整改动集合这些判断项，接不到真实判据就给 false/空，
//     **绝不臆造通过**（引擎据此拒绝，不产生副作用）。
//   · **不新建台账、不复制原证据**：收尾关联经既有 `putEvidence` 内容寻址落库（只引用，不复制）。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import { getProject } from "../registry";
import { projectWorkDir } from "../workstation";
import { loadEvents } from "./eventStore";
import { claimRecordsOf } from "./claims";
import { independenceRequiredOf } from "./obligations";
import { resolveFrozenCandidateSource, readWorkspacesForProject } from "./workspaces";
import { putEvidence } from "./evidence";
import {
  collectProjectFacts,
  applyFrozenPlanSnapshot,
  verifyTaskOnCandidate,
  type FrozenPlanScope,
  type ProjectFacts,
  type TaskVerification,
} from "./statusProjection";
import { WORK_TOKEN_HEADER } from "./service";
import { withDerivationScope } from "./derivationScope";
import { WorkError, isWorkError } from "./types";
import { executeVerifiedLocalCommit } from "./gitFinalize";
import type {
  FinalizeAssociation,
  FinalizeChangeEntry,
  FinalizeFactSource,
  FinalizeGrant,
  FinalizeGrantQuery,
  FinalizeIndexEntry,
  FinalizeResult,
} from "./gitFinalize";

/**
 * 宿主可注入的**真实判据探针**（由服务端在接上义务层/证据链时提供；请求侧拿不到）。
 * 未提供 ⇒ 该项 fail-closed（false/空），引擎据此拒绝收尾。
 */
export interface FinalizeHostProbes {
  /** 技术验证**当前通过**且绑定**同一候选指纹**（接义务层/statusProjection 判据） */
  technicalVerified?: (query: FinalizeGrantQuery, candidateFingerprint: string | null) => boolean;
  /** 独立审查（**非作者**）当前通过；返回审查者 id 供「独审者≠作者」判据 */
  independentAudit?: (query: FinalizeGrantQuery, candidateFingerprint: string | null) => { passed: boolean; reviewer_id: string | null };
  /** 该候选相对基准 HEAD 的**完整实际改动集合**（宿主读只读 git）；未接 ⇒ 空 ⇒ 引擎按 MISSING_AUTHORIZED_CHANGE 拒 */
  changes?: (root: string, baseHead: string | null) => FinalizeChangeEntry[];
  /** 任务作者 id（独审者≠作者判据用） */
  taskAuthorId?: (query: FinalizeGrantQuery) => string | null;
}

export interface FinalizeHostOptions {
  dataDir?: string;
  probes?: FinalizeHostProbes;
}

/** 无工作区/未知时的 fail-closed grant（root 空 ⇒ 引擎以 WORKSPACE_ROOT_INVALID 拒，零副作用） */
function unresolvedGrant(query: FinalizeGrantQuery, reason: string): FinalizeGrant {
  return {
    project_id: query.project_id,
    task_id: query.task_id,
    workspace_id: query.workspace_id,
    root: "",
    git_dir: null,
    workspace_kind: "unknown",
    workspace_status: "unknown",
    source_kind: "unknown",
    authorized: false,
    authorization_ref: null,
    technical_verified: false,
    independent_audit_passed: false,
    audit_reviewer_id: null,
    task_author_id: null,
    candidate_kind: "unknown",
    candidate_fingerprint: null,
    candidate_base_head: null,
    candidate_branch: null,
    allow_local_commit: false,
    changes: [],
    evidence_refs: [],
    // 未解析原因随 grant 带出（引擎 detail 里如实标注，不臆造通过）
    ...({ unresolved_reason: reason } as unknown as Partial<FinalizeGrant>),
  };
}

/**
 * 从**真实账本**派生某任务的授权：最新一条认领记录是「当前持有」且未被释放/重开，且
 * 调用方是持有者本人或协调者。返回授权记录引用（事件 id）供关联。
 */
export function resolveTaskAuthorization(
  events: readonly import("./types").WorkEvent[],
  taskId: string,
  actor: { id: string; role: string },
): { authorized: boolean; ref: string | null; owner_id: string | null; owner_role: string | null } {
  const records = claimRecordsOf(events as never)[taskId];
  if (!records || records.length === 0) return { authorized: false, ref: null, owner_id: null, owner_role: null };
  const latest = records[records.length - 1];
  const held = latest.action === "claim" || latest.action === "renew";
  if (!held || latest.owner_id === null) return { authorized: false, ref: latest.event_id, owner_id: null, owner_role: latest.owner_role };
  const authorized = actor.id === latest.owner_id || actor.role === "coordinator";
  return { authorized, ref: latest.event_id, owner_id: latest.owner_id, owner_role: latest.owner_role };
}

// ── 真实判据派生（读中央事实/证据/工作区；探针只作测试覆盖，缺省走真实派生，不再默认 false） ──

function gitBuffer(root: string, args: readonly string[]): { ok: boolean; stdout: Buffer; stderr: string } {
  let res: ReturnType<typeof spawnSync>;
  try {
    res = spawnSync("git", ["-C", root, ...args], {
      encoding: "buffer",
      maxBuffer: 256 * 1024 * 1024,
      timeout: 60_000,
      windowsHide: true,
    });
  } catch (e) {
    return { ok: false, stdout: Buffer.alloc(0), stderr: (e as Error).message };
  }
  const stdout = Buffer.isBuffer(res.stdout) ? res.stdout : Buffer.from(String(res.stdout ?? ""), "utf8");
  const stderr = Buffer.isBuffer(res.stderr) ? res.stderr.toString("utf8") : String(res.stderr ?? "");
  return { ok: res.status === 0, stdout, stderr };
}

function changeEntryOf(root: string, rel: string, status: FinalizeChangeEntry["status"]): FinalizeChangeEntry {
  if (status === "deleted") return { path: rel, status, sha256: null, mode: null, size: null };
  try {
    const abs = path.join(root, ...rel.split("/"));
    const st = fs.statSync(abs);
    const buf = fs.readFileSync(abs);
    return {
      path: rel,
      status,
      sha256: crypto.createHash("sha256").update(buf).digest("hex"),
      mode: (st.mode & 0o111) !== 0 ? "100755" : "100644",
      size: buf.length,
    };
  } catch {
    return { path: rel, status, sha256: null, mode: null, size: null };
  }
}

/**
 * 该候选相对基准 HEAD 的**完整实际改动集合**（tracked 未提交/已暂存改动 + 非 ignored untracked 新增），
 * 读只读 Git；引擎会拿它再对实际 diff 重核，故这里必须给**完整**集合而不是授权路径交集。
 */
function actualChanges(root: string, baseHead: string | null): FinalizeChangeEntry[] {
  const base = baseHead !== null && baseHead !== "" ? baseHead : "HEAD";
  const entries = new Map<string, FinalizeChangeEntry>();
  const ns = gitBuffer(root, ["diff", "--no-renames", "--name-status", "-z", base]);
  if (!ns.ok) throw new Error(`git diff ${base} 失败：${ns.stderr.trim() || "非零退出"}`);
  const tokens = ns.stdout.toString("utf8").split("\0").filter((t) => t !== "");
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const letter = tokens[i];
    const rel = tokens[i + 1];
    const status: FinalizeChangeEntry["status"] = letter.startsWith("A")
      ? "added"
      : letter.startsWith("D")
        ? "deleted"
        : letter.startsWith("T")
          ? "typechange"
          : "modified";
    entries.set(rel, changeEntryOf(root, rel, status));
  }
  const others = gitBuffer(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
  if (others.ok) {
    for (const rel of others.stdout.toString("utf8").split("\0")) {
      if (rel === "" || entries.has(rel)) continue;
      entries.set(rel, changeEntryOf(root, rel, "added"));
    }
  }
  return [...entries.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function taskAuthorIdOf(facts: ProjectFacts, taskId: string): string | null {
  const selfChecks = Object.values(facts.audit.self_checks).filter((s) => s.task_id === taskId);
  if (selfChecks.length > 0) return selfChecks[selfChecks.length - 1].checked_by;
  const st = facts.task_states[taskId];
  return st !== undefined && typeof st.owner_id === "string" ? st.owner_id : null;
}

/** 该任务声明的允许路径是否命中本批**实际变化**之一（命中 ⇒ 该任务属于"实际纳入变化"的授权任务） */
function taskTouchesChanges(facts: ProjectFacts, taskId: string, changes: readonly FinalizeChangeEntry[]): boolean {
  const def = facts.definitions.find((d) => d.task_id === taskId);
  if (def === undefined) return false;
  return changes.some((c) => pathMatchesAllowed(c.path, def.allowed_paths));
}

/** 本批 task_ids 声明允许修改的路径**并集**（不取交集：整体授权变化合并，§6.14 第 9 段）。 */
function allowedPathsFor(facts: ProjectFacts, taskIds: readonly string[]): string[] {
  const defById = new Map(facts.definitions.map((d) => [d.task_id, d]));
  const paths: string[] = [];
  for (const id of taskIds) {
    const def = defById.get(id);
    if (def !== undefined) for (const p of def.allowed_paths) paths.push(p);
  }
  return [...new Set(paths)];
}

function pathMatchesAllowed(rel: string, allowed: readonly string[]): boolean {
  for (const raw of allowed) {
    const a = raw.replace(/\\/g, "/").replace(/^\.\//, "").trim();
    if (a === "") continue;
    if (a.endsWith("/")) {
      if (rel.startsWith(a)) return true;
      continue;
    }
    if (a.includes("*")) {
      const pattern = a
        .split("*")
        .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("[^/]*");
      if (new RegExp(`^${pattern}$`).test(rel)) return true;
      continue;
    }
    if (rel === a) return true;
  }
  return false;
}

/**
 * 构造**真实**事实源：`executeVerifiedLocalCommit` 每次调用都会经它取 grant，再对 grant 重跑资格判据。
 * 安全关键字段（root/kind/status/source/candidate 指纹/基准 HEAD/分支/allow_local_commit）**一律现读账本**，
 * 请求不能覆盖；判断项（技术验证/独立审查/完整改动集合）从**当前真实中央事实/证据/工作区**派生
 * （同一请求内复用一次 `collectProjectFacts` 快照，不每条检查重扫账本）。探针仅作测试覆盖；缺省走真实派生，
 * 派生不出即 fail-closed（false/空）——引擎据此拒绝，零副作用。
 */
export function createFinalizeFactSource(opts: FinalizeHostOptions = {}): FinalizeFactSource {
  const dataDir = opts.dataDir;
  const probes = opts.probes ?? {};
  const factsCache = new Map<string, ProjectFacts | null>();
  const factsOf = (projectId: string): ProjectFacts | null => {
    if (!factsCache.has(projectId)) {
      try {
        factsCache.set(projectId, collectProjectFacts(projectId, dataDir ?? ""));
      } catch {
        factsCache.set(projectId, null);
      }
    }
    return factsCache.get(projectId) ?? null;
  };
  // 性能修复（同根因关联路径补修）：本函数是**同步纯读**派生（读账本/工作区/候选源/证据 + 只读 git，
  // 无 await、无 git 写、无事件 mutation）。整段收进一层**可嵌套**派生作用域，使 K 个被验任务共享同一份
  // 证据作用域解析（同一冻结候选只现读复核一次）——`checksWithSourceManifests` 自带的嵌套作用域复用这一层。
  // 作用域 `finally` 一到整体丢弃：**无 TTL、不跨请求**；判据/返回字段一字不改。
  const resolveFinalizeGrantInScope = (query: FinalizeGrantQuery): FinalizeGrant => {
      const project = getProject(query.project_id, dataDir);
      if (!project) return unresolvedGrant(query, `项目不存在：${query.project_id}`);
      const workDir = projectWorkDir(query.project_id, dataDir);
      const view = readWorkspacesForProject(query.project_id, dataDir);
      const rec = view.workspaces.find((w) => w.workspace_id === query.workspace_id);
      if (rec === undefined) return unresolvedGrant(query, `工作区不属本项目或不存在：${query.workspace_id}`);

      const events = loadEvents(workDir).events;
      const authz = resolveTaskAuthorization(events, query.task_id, query.actor);

      // 候选来源解析（§6.14 第 5 段）：统一紧凑引用 → 现读复核 → 用**实际可用根**（present/recovered）。
      // tampered/unknown ⇒ candidate_kind=unknown（引擎据此拒绝，绝不借旧绿）。
      let root = rec.root;
      let candidateFingerprint: string | null = rec.freeze?.content_fingerprint ?? rec.content_fingerprint ?? null;
      let candidateKind: FinalizeGrant["candidate_kind"] =
        candidateFingerprint === null ? "unknown" : rec.source_kind === "content_snapshot" ? "content_snapshot" : "candidate_index";
      let candidateReason: string | null = null;
      let fullIndex: FinalizeIndexEntry[] | undefined;
      if (rec.freeze !== null) {
        const read = resolveFrozenCandidateSource(workDir, rec);
        if (read.ref !== null) {
          const res = read.resolution;
          if (res !== null && (res.status === "present" || res.status === "recovered") && res.root !== null) {
            root = res.root;
            candidateFingerprint = res.content_fingerprint ?? rec.freeze.content_fingerprint;
            candidateKind = "candidate_index";
            if (read.index !== null) {
              fullIndex = read.index.entries
                .filter((e) => e.state === "present")
                .map((e) => ({ path: e.path, sha256: e.sha256, size: e.bytes, mode: e.mode === 0o100755 ? "100755" : "100644" }));
            }
          } else {
            candidateKind = "unknown";
            candidateFingerprint = null;
            candidateReason = read.blocked_reason ?? `候选来源不可用（status=${res?.status ?? "unknown"}）`;
          }
        } else if (read.corrupt) {
          // 新格式引用损坏：不得按旧口径回落 rec.root（那会把损坏当 legacy 成功）
          candidateKind = "unknown";
          candidateFingerprint = null;
          candidateReason = read.blocked_reason ?? "冻结候选引用损坏";
        }
      }

      const baseHead = rec.freeze?.source_commit ?? rec.source_commit;
      const rawFacts = factsOf(query.project_id);

      // §6.14 第 3 段：对冻结候选的判据一律用**它冻结的 DESIGN/PLAN 版本**（读不可变快照重建卡定义），
      // **不读当前开发目录的最新施工图**——否则下一版开发文档一改，旧候选会拿新定义误借通过。
      let facts: ProjectFacts | null = rawFacts;
      let planScope: FrozenPlanScope | null = null;
      if (rawFacts !== null && rec.freeze !== null) {
        const scoped = applyFrozenPlanSnapshot(rawFacts, query.project_id, dataDir ?? "", rec.freeze.version_binding.plan_sha256);
        facts = scoped.facts;
        planScope = scoped.status;
      }
      // 新冻结必须绑定 PLAN 内容哈希；绑定了却读不回 ⇒ 候选版本无法重建，fail-closed（不拿当前图纸顶替）
      const planUnresolved = planScope !== null && !planScope.applied && planScope.plan_revision !== null;
      const factsUsable = facts !== null && candidateKind === "candidate_index" && !planUnresolved;

      let changes: FinalizeChangeEntry[] = [];
      let changesError: string | null = null;
      if (probes.changes !== undefined) {
        changes = probes.changes(root, baseHead);
      } else if (candidateKind === "candidate_index") {
        try {
          changes = actualChanges(root, baseHead);
        } catch (e) {
          changesError = (e as Error).message;
        }
      }

      const batchTaskIds = [...new Set([...rec.task_ids, query.task_id])];
      const allowed = facts !== null ? allowedPathsFor(facts, batchTaskIds) : [];
      const outOfScope = allowed.length === 0 ? [] : changes.filter((c) => !pathMatchesAllowed(c.path, allowed));
      const changesAuthorized = changesError === null && allowed.length > 0 && outOfScope.length === 0;

      // §6.14 第 9 段：全批**实际纳入变化**对应的授权任务都必须同候选通过技术与独审——
      // 不能拿 T1 的绿替 T2 提交（T2 路径也在本批里，却只核了 query.task_id）。
      const contributing = facts !== null ? batchTaskIds.filter((id) => taskTouchesChanges(facts, id, changes)) : [];
      const effectiveTaskIds = contributing.length > 0 ? contributing : [query.task_id];

      let perTask: TaskVerification[] = [];
      let technical = false;
      let audit: { passed: boolean; reviewer_id: string | null } = { passed: false, reviewer_id: null };
      if (probes.technicalVerified !== undefined) technical = probes.technicalVerified(query, candidateFingerprint);
      else if (factsUsable && facts !== null) {
        perTask = effectiveTaskIds.map((id) => verifyTaskOnCandidate(facts, { candidateRoot: root, workDir, taskId: id, independenceRequired: independenceRequiredOf }));
        technical = perTask.length > 0 && perTask.every((t) => t.technical_verified);
      }
      if (probes.independentAudit !== undefined) audit = probes.independentAudit(query, candidateFingerprint);
      else if (factsUsable && facts !== null) {
        if (perTask.length === 0) perTask = effectiveTaskIds.map((id) => verifyTaskOnCandidate(facts!, { candidateRoot: root, workDir, taskId: id, independenceRequired: independenceRequiredOf }));
        audit = {
          passed: perTask.length > 0 && perTask.every((t) => t.independent_audit_passed),
          reviewer_id: perTask.map((t) => t.reviewer_id).find((r) => r !== null) ?? null,
        };
      }

      // 授权：每个纳入变化的授权任务都要有**当前有效认领**（持有者本人或协调者）。
      const authzPer = effectiveTaskIds.map((id) => ({ task_id: id, ...resolveTaskAuthorization(events, id, query.actor) }));
      const batchAuthorized = authzPer.every((a) => a.authorized);

      const grant: FinalizeGrant = {
        project_id: query.project_id,
        task_id: query.task_id,
        workspace_id: query.workspace_id,
        root,
        git_dir: null,
        workspace_kind: rec.derived ? "dev" : rec.kind,
        workspace_status: rec.derived ? "preparing" : rec.status,
        source_kind: rec.source_kind,
        authorized: authz.authorized && batchAuthorized && changesAuthorized,
        authorization_ref: authz.ref,
        technical_verified: technical,
        independent_audit_passed: audit.passed,
        audit_reviewer_id: audit.reviewer_id,
        task_author_id: facts !== null ? taskAuthorIdOf(facts, query.task_id) : null,
        candidate_kind: candidateKind,
        candidate_fingerprint: candidateFingerprint,
        candidate_base_head: baseHead,
        candidate_branch: rec.source_ref,
        allow_local_commit: rec.source_kind !== "content_snapshot",
        changes,
        ...(fullIndex !== undefined ? { full_index: fullIndex } : {}),
        evidence_refs: [],
        ...({
          authorization_detail: {
            batch_task_ids: batchTaskIds,
            contributing_task_ids: effectiveTaskIds,
            per_task: perTask.map((t) => ({ task_id: t.task_id, technical_verified: t.technical_verified, independent_audit_passed: t.independent_audit_passed, reason: t.reason })),
            authorization_per_task: authzPer.map((a) => ({ task_id: a.task_id, authorized: a.authorized })),
            allowed_paths: allowed,
            out_of_scope: outOfScope.map((c) => c.path),
            changes_error: changesError,
            candidate_reason: candidateReason,
            plan_scope_applied: planScope?.applied ?? null,
            plan_scope_reason: planScope?.reason ?? null,
            facts_available: facts !== null,
          },
        } as unknown as Partial<FinalizeGrant>),
      };
      return grant;
  };
  return {
    resolveFinalizeGrant(query: FinalizeGrantQuery): FinalizeGrant {
      return withDerivationScope(() => resolveFinalizeGrantInScope(query));
    },
  };
}

/**
 * 收尾结果关联（§6.14 第 9 段）：把 commit/输入指纹/证据引用经**既有唯一写口**（`putEvidence`
 * 内容寻址）落库——**不新建追溯台账、不复制原证据**（只引用候选指纹与证据 id）。
 */
export function recordFinalizeAssociation(
  workDir: string,
  association: FinalizeAssociation,
  actor: { id: string; role: string },
): { evidence_id: string } {
  const content = JSON.stringify({ version: "git-finalize-association-v1", ...association });
  const blob = putEvidence(workDir, {
    content,
    kind: "other",
    summary: `本地 Git 收尾关联：${association.commit.slice(0, 12)}…（候选 ${association.candidate_fingerprint.slice(0, 12)}…，基准 ${association.base_head.slice(0, 12)}…）`,
    created_by: actor.id,
    role: actor.role,
    binding: { revision_kind: "code", revision: association.candidate_fingerprint },
  });
  return { evidence_id: blob.evidence_id };
}

// ── 唯一宿主路由：POST /api/work/git/finalize（本地 Git 自动收尾的权威写面） ──

export const FINALIZE_ROUTE = "/api/work/git/finalize";

/**
 * 请求体**只收这些键**：项目/任务/工作区/执行者/提交标题与正文/幂等键。
 * **不接受** `grant`／`allow_local_commit`／`technical_verified`／`expected_root`／任意 `root`——
 * 授权与否、目标根、技术/独审状态一律由宿主读真实账本派生（§6.14 第 9 段）。
 */
const FINALIZE_BODY_KEYS = ["project_id", "task_id", "workspace_id", "actor_id", "role", "subject", "body", "finalize_id"] as const;

export interface FinalizeHostCtx {
  /** 与 `handleWorkRequest` 的 ctx 同形，便于 workHost 同处委派 */
  dataDir: string;
  token: string;
  pathname: string;
  /** write-host 身份闸（描述符 pid + 令牌）；未注入不查 */
  assertWriteOwnership?: () => void;
  /** 接入义务层/证据链后的**真实判决探针**（宿主注入；请求侧拿不到） */
  probes?: FinalizeHostProbes;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (raw === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new WorkError("INVALID_COMMAND", "请求体不是合法 JSON", {});
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new WorkError("INVALID_COMMAND", "请求体必须是 JSON 对象", {});
  }
  return parsed as Record<string, unknown>;
}

/**
 * 处理本地 Git 收尾路由；**返回 false 表示不是本模块路由**（workHost 继续走原 handleWorkRequest）。
 * 与其它 `/api/work/*` 写面同款：先过 token（写者凭据）与 write-host 身份闸，再进真实写路径。
 */
export async function handleFinalizeRequest(req: IncomingMessage, res: ServerResponse, ctx: FinalizeHostCtx): Promise<boolean> {
  if (ctx.pathname !== FINALIZE_ROUTE) return false;
  const method = req.method ?? "GET";
  if (req.headers[WORK_TOKEN_HEADER] !== ctx.token) {
    sendJson(res, 401, { code: "SERVICE_UNAVAILABLE", message: `缺少或错误的 ${WORK_TOKEN_HEADER}：收尾写面只答带描述符凭据的本机调用`, detail: {} });
    return true;
  }
  if (method !== "POST") {
    sendJson(res, 405, { code: "INVALID_COMMAND", message: `收尾写面只接受 POST（收到 ${method}）`, detail: {} });
    return true;
  }
  try {
    ctx.assertWriteOwnership?.();
    const body = await readJsonBody(req);
    const extra = Object.keys(body).filter((k) => !(FINALIZE_BODY_KEYS as readonly string[]).includes(k));
    if (extra.length > 0) {
      sendJson(res, 400, {
        code: "INVALID_COMMAND",
        message: `收尾请求**不得自带** grant／通过布尔／root（授权、目标根、技术/独审状态由宿主读真实账本派生）；多出来的键一律拒：${extra.join("、")}`,
        detail: { extra, allowed: FINALIZE_BODY_KEYS },
      });
      return true;
    }
    const str = (k: string): string => (typeof body[k] === "string" ? (body[k] as string).trim() : "");
    const projectId = str("project_id");
    const taskId = str("task_id");
    const workspaceId = str("workspace_id");
    const subject = str("subject");
    if (projectId === "" || taskId === "" || workspaceId === "") {
      sendJson(res, 400, { code: "INVALID_COMMAND", message: "收尾请求缺 project_id/task_id/workspace_id", detail: {} });
      return true;
    }
    if (subject === "") {
      sendJson(res, 400, { code: "INVALID_COMMAND", message: "收尾请求缺 subject（提交标题）", detail: {} });
      return true;
    }
    const actor = { id: str("actor_id") || "unknown", role: str("role") || "executor" };
    const facts = createFinalizeFactSource({ dataDir: ctx.dataDir, probes: ctx.probes });
    const result: FinalizeResult = await executeVerifiedLocalCommit({
      request: {
        project_id: projectId,
        task_id: taskId,
        workspace_id: workspaceId,
        actor,
        subject,
        ...(typeof body.body === "string" ? { body: body.body } : {}),
        ...(str("finalize_id") === "" ? {} : { finalize_id: str("finalize_id") }),
      },
      facts,
    });
    // 关联经既有 putEvidence 落库（唯一宿主）；committed/reused 都写（重试补回执、不造第二 commit）。
    let associationEvidenceId: string | null = null;
    if (result.association !== null && (result.status === "committed" || result.status === "reused")) {
      try {
        associationEvidenceId = recordFinalizeAssociation(projectWorkDir(projectId, ctx.dataDir), result.association, actor).evidence_id;
      } catch (e) {
        // 提交已产生但回执写失败：如实返回（调用方按 finalize_id 重试可复用并补回执），不谎报成功。
        sendJson(res, 200, { ok: true, result, association_evidence_id: null, association_error: e instanceof Error ? e.message : String(e) });
        return true;
      }
    }
    sendJson(res, 200, { ok: true, result, association_evidence_id: associationEvidenceId });
    return true;
  } catch (e) {
    if (isWorkError(e)) {
      sendJson(res, 503, e.toJSON());
      return true;
    }
    sendJson(res, 500, { code: "INTERNAL_ERROR", message: e instanceof Error ? e.message : String(e), detail: {} });
    return true;
  }
}
