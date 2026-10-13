// 工作区/候选来源的**宿主接线**（V09-64 集成；DESIGN.md §6.14 第 5/6/8 段）。
//
// 为什么单开一个接线文件：`evidence.ts` / `documents.ts` **不静态 import** `workspaces.ts` / `workspaceGuard.ts`
// （否则与 `workstation.ts` 成环）。它们暴露注入点，由**唯一宿主启动处**把真实解析器接上——桌面服务与独立
// daemon 都经 `createWorkHost` 启动，所以这一处接线即两种宿主同源。
//
// 归一判据（**同一版本才可读**，§6.14 第 3/5 段）：
//   · 证据作用域（workspace_id + 记录时根）解析到**当前同一版本**可读的根：目录在 → 原根；已按规则回收但
//     来源可达/快照在 → `resolveCandidateSource` 的可再生缓存根；篡改/取不回 → null（**不回落开发目录兜底**）。
import fs from "node:fs";
import path from "node:path";
import { projectRootOfWorkDir } from "./sourceEvidence";
import { projectWorkDir } from "../workstation";
import {
  readWorkspaces,
  resolveCurrentDevRoot,
  resolveFrozenCandidateSource,
  setPromotionVerifier,
  type PromotionVerification,
  type PromotionVerifierInput,
  type WorkspaceProjection,
} from "./workspaces";
import { collectProjectFacts, applyFrozenPlanSnapshot, verifyTaskOnCandidate } from "./statusProjection";
import { independenceRequiredOf } from "./obligations";
import { verifyPackageAtPromotion } from "./workspaceBuildBinding";
import { setEvidenceWorkspaceResolver, setEvidenceScopeRootResolver } from "./evidence";
import { setCurrentDevRootResolver, setDocumentWriteGuard } from "./documents";
import { assertHostedWriteAllowed } from "./workspaceGuard";
import { memoizedForDerivation, withDerivationScope } from "./derivationScope";

/**
 * 解析一个工作区 id / 记录根到**当前同一版本**可读的根（不可用 → root=null + 原因）。
 *
 * 2026-10-09 性能修复：把**完整解析结果**纳入**既有的一次同步派生 memo**（key 覆盖三参）。事由见
 * `scopeRootOfUnscoped` 顶部注释——一条证据一次解析，而 `checksWithSourceManifests` 对**每条证据**都
 * 调这里；几百条证据 × 每次现读整份冻结候选源（实测 595 文件 / 0.69s / 4925 IO / 18.8MB）＝
 * feature_ledger / entry 超时。这里只复用**同一次派生内、同一输入**的完整结论：作用域 `finally` 一到
 * 即整体丢弃、**跨请求绝不缓存**（下一次调用照旧真实核验，源一变下一个请求立刻看见）；作用域外
 * `memoizedForDerivation` 直接现算——不引入本修复时的行为逐字不变。**返回/来源/损坏与跨项目判据一字不改**，
 * 也不把失效证据自动变绿（解析不出仍是 root=null + 原因）。
 */
function scopeRootOf(
  workDir: string,
  workspaceId: string | null,
  recordedRoot: string | null,
): { root: string | null; reason: string | null } {
  return memoizedForDerivation("workspaces:scope-root", `${workDir}\u0000${workspaceId ?? ""}\u0000${recordedRoot ?? ""}`, () =>
    scopeRootOfUnscoped(workDir, workspaceId, recordedRoot),
  );
}

function scopeRootOfUnscoped(
  workDir: string,
  workspaceId: string | null,
  recordedRoot: string | null,
): { root: string | null; reason: string | null } {
  if (workspaceId !== null && workspaceId !== "") {
    let projection: WorkspaceProjection;
    try {
      projection = readWorkspaces(workDir);
    } catch (e) {
      return { root: null, reason: `读工作区事件失败：${(e as Error).message}` };
    }
    const rec = projection.workspaces[workspaceId];
    if (rec === undefined) {
      // 派生 :main 不落事件：按锚点根（当前开发根）解析；找不到就明确未知，不猜
      if (workspaceId.endsWith(":main")) {
        const anchor = projectRootOfWorkDir(workDir);
        return fs.existsSync(anchor) ? { root: path.resolve(anchor), reason: null } : { root: null, reason: `主开发目录不在盘：${anchor}` };
      }
      return { root: null, reason: `工作区不属本项目或不存在：${workspaceId}` };
    }
    // **已回收（retired）不等于版本废弃**：目录回收后仍从可达提交/中央快照按**同版**解析（§6.14 第 5/10 段）。
    // 只记状态、不因 retired 直接丢版本——找不到可读来源时下面的 fetchxistsSync/候选解析会如实报未知。
    if (rec.freeze !== null) {
      const read = resolveFrozenCandidateSource(workDir, rec);
      if (read.ref !== null) {
        const res = read.resolution;
        if (res === null) return { root: null, reason: read.blocked_reason ?? "候选来源解析不出" };
        if ((res.status === "present" || res.status === "recovered") && res.root !== null) return { root: res.root, reason: null };
        return { root: null, reason: `候选来源不可用（status=${res.status}）：${res.problems.map((p) => p.code).join("/") || "未知"}` };
      }
      if (read.corrupt) return { root: null, reason: read.blocked_reason ?? "候选引用损坏（不按旧口径回落工作区根）" };
    }
    if (rec.derived) {
      const anchor = projectRootOfWorkDir(workDir);
      return fs.existsSync(anchor) ? { root: path.resolve(anchor), reason: null } : { root: null, reason: `主开发目录不在盘：${anchor}` };
    }
    if (fs.existsSync(rec.root)) return { root: rec.root, reason: null };
    return { root: null, reason: rec.status === "retired" ? `工作区已回收且来源不可还原：${rec.root}` : `工作区根不在盘：${rec.root}` };
  }
  if (recordedRoot !== null && recordedRoot !== "") {
    if (fs.existsSync(recordedRoot)) return { root: path.resolve(recordedRoot), reason: null };
    return { root: null, reason: `记录的工作区根不在盘：${recordedRoot}` };
  }
  return { root: null, reason: "证据没有工作区作用域" };
}

/**
 * 试用提升前的**已验版本**宿主判据（§6.14 第 8 段）：宿主自行读中央事实派生——候选绑定的配套版本
 * （DESIGN/PLAN 内容哈希）齐备、其 `task_ids` 每个任务在**候选源根**下技术验证 + 非作者独立审查
 * 均当前有效通过，**并且**该交付所需的**包身份**由宿主从候选根的**真实产物**实测、与冻结记录逐项相符。
 * **不接受调用方自报 basis/measured**；非包交付的项目合理放行（`not_applicable`），但**不能靠省略字段降级**。
 * 判据与 Git 收尾**同一份**（`statusProjection.verifyTaskOnCandidate` + 冻结 PLAN 快照重建定义；
 * 包身份实测走 `workspaceBuildBinding.verifyPackageAtPromotion`）。
 */
function verifyPromotion(input: PromotionVerifierInput): PromotionVerification {
  // 2026-10-09：把本函数**整段同步只读判据**收进一次派生作用域。此前 `collectProjectFacts` 自带作用域、
  // 出了它就丢，随后的逐任务源清单现读复核（`checksWithSourceManifests` 对**每条证据**解析一次证据作用域 →
  // `scopeRootOf`）、冻结 PLAN 快照、包身份实测各自现算——K 个被验任务 × C 条检查把**同一候选根**解析 K×C 遍。
  // 作用域内同输入只读结果复用一次；`finally` 一到整体丢弃（**跨请求/跨 mutation 不缓存**）。
  // **不包任何写入**：本函数只读账本/候选源/真实产物并返回结论；指针写入在调用方（`pointTrialWorkspace`）
  // 的提交阶段才发生，不在本作用域内。判据、返回字段一字不改。
  return withDerivationScope(() => verifyPromotionInScope(input));
}

function verifyPromotionInScope(input: PromotionVerifierInput): PromotionVerification {
  const reasons: string[] = [];
  const vb = input.version_binding;
  const dataDir = input.data_dir ?? "";
  const docsOk = vb.design_sha256 !== null && vb.plan_sha256 !== null;
  if (!docsOk) reasons.push("候选未绑定同一版本的 DESIGN/PLAN 内容哈希（配套版本材料不全）");
  // 包身份**实测**（不再用 `package_ok = docsOk` 顶替）：宿主从候选根现算构建输入 + 实测真实产物，
  // 与冻结记录逐项相符才放行；无构建链的普通项目合理 not_applicable（package_ok=true 表示"无需/已实测相符"）。
  const pkg = verifyPackageAtPromotion({ root: input.root, frozen: vb.build_identity });
  const packageOk = pkg.ok;
  if (!packageOk) for (const r of pkg.reasons) reasons.push(r);
  if (input.task_ids.length === 0) reasons.push("候选未绑定任何被验任务（task_ids 为空）：无法证明是已验版本");
  let technical = false;
  let audit = false;
  if (input.task_ids.length > 0) {
    let facts = collectProjectFacts(input.project_id, dataDir);
    const scoped = applyFrozenPlanSnapshot(facts, input.project_id, dataDir, vb.plan_sha256);
    facts = scoped.facts;
    if (!scoped.status.applied && scoped.status.plan_revision !== null) reasons.push(scoped.status.reason ?? "候选绑定的 PLAN 快照读不回");
    const workDir = projectWorkDir(input.project_id, dataDir);
    const per = input.task_ids.map((id) => verifyTaskOnCandidate(facts, { candidateRoot: input.root, workDir, taskId: id, independenceRequired: independenceRequiredOf }));
    technical = per.length > 0 && per.every((v) => v.technical_verified);
    audit = per.length > 0 && per.every((v) => v.independent_audit_passed);
    for (const v of per) if (v.reason !== null) reasons.push(v.reason);
  }
  return {
    verified: docsOk && input.task_ids.length > 0 && technical && audit && packageOk,
    technical_verified: technical,
    independent_audit_passed: audit,
    package_ok: packageOk,
    reasons,
  };
}

/**
 * 安装**只读**工作区来源解析接线（幂等；**无 IO**：安装本身不读盘/不写盘，解析器在被调用时才读）。
 *
 * 为什么单列：**每一个真实（只读）进程组合根都要接这一份**——桌面后端、独立 daemon 经 `createWorkHost`
 * 启动，而独立 stdio MCP 进程（`src/mcp/index.ts`）**不建写入服务**也同样直读图纸/入口。若只靠
 * 「启动 writer 才装」，MCP 自己的只读进程就拿不到当前开发根的注入 → 再退回锚点旧口径（读到错版本）。
 * 所以把「解析器注入」与「试用提升验证器/文档写守卫」拆开：前者任何进程都要装，后者只写宿主装。
 */
export function installWorkspaceReadWiring(): void {
  setEvidenceWorkspaceResolver((workDir, id) => scopeRootOf(workDir, id, null).root);
  setEvidenceScopeRootResolver((workDir, scope) => scopeRootOf(workDir, scope.workspace_id, scope.workspace_root));
  setCurrentDevRootResolver((projectId, dataDir) => resolveCurrentDevRoot(projectId, dataDir));
}

/**
 * 安装工作区/候选来源宿主接线（幂等；由 `createWorkHost` 启动处调用一次）。
 * = 只读解析接线 + `point_trial` 的宿主验证器 + 托管文档写守卫（写面专属）。
 * 只注入解析器/判据，不改任何判据语义、安装本身不写盘。
 */
export function installWorkspaceHostWiring(): void {
  installWorkspaceReadWiring();
  setPromotionVerifier(verifyPromotion);
  setDocumentWriteGuard((input) =>
    assertHostedWriteAllowed({
      projectId: input.projectId,
      dataDir: input.dataDir,
      workspaceId: null,
      targetRoot: input.targetRoot,
      kind: "document",
    }),
  );
}

/** 便捷导出：给测试/其它入口按同一判据解析（不注册全局） */
export { scopeRootOf };

/** 供测试在不再需要时复位（生产不使用） */
export function resetWorkspaceHostWiring(): void {
  setEvidenceWorkspaceResolver(null);
  setEvidenceScopeRootResolver(null);
  setCurrentDevRootResolver(null);
  setPromotionVerifier(null);
  setDocumentWriteGuard(null);
}
