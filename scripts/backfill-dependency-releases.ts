// backfill-dependency-releases：为 89 条依赖边批量登记「前置释放检查」。
//
// 背景（2026-09-27）：补证清单 `D:\tmp\tmp-backfill-inventory.json` 的 89 条依赖边全橙——从未登记
// 前置释放检查。本脚本对每边**现算** `dependencyRelease`（前置达标才 released），
// 逐边登记 `audit.self_check_recorded`（check_id 对齐清单 `<A->B>::prerequisite`）：
//   · released=true  → conclusion=pass（verifies=document，绑定当前 plan 内容哈希）；
//   · released=false → conclusion=fail（如实带 reasons，**不写 pass**）。
// 证据＝该边的 `dependencyRelease` 输出（released/reasons/caveats）落库算 sha256（走 evidence.ts）。
//
// 先例：`scripts/backfill-tatai-v07-03.ts`（WorkServiceClient + 自定义幂等键前缀）；
// 投影侧组装照 `src/server/work/entry.ts#projectWithReleases`（pass1 = 不带 release 的投影，
// 逐边 `dependencyRelease` 后再让边带上结论）。写口仍是唯一写入服务，**不自己写事实文件**。
//
// 用法（默认 dry-run，不改 package.json）：
//   pnpm exec tsx scripts/backfill-dependency-releases.ts                 # --dry-run
//   pnpm exec tsx scripts/backfill-dependency-releases.ts --apply         # 真跑真写
//   pnpm exec tsx scripts/backfill-dependency-releases.ts --only V09-16   # 只处理涉该 task 的边
//
// 运行前提：前置任务需先完成补证（`backfill-reverify-tasks.ts --apply`）才会 released=true；
// 若前置仍 pending_verification/evidence_invalid，dry-run 会预警并建议先跑交付物一。
//
// ⚠ 与任务卡的口径差异（已在最终报告显式登记）：卡面要求未释放的边记 `conclusion=blocked`，
//    但 `SelfCheckInput.conclusion` 只接受 `pass|fail`，且折叠层把非 `fail` 一律折成 `pass`
//    （`audit.ts:570`）——用 `blocked` 会被静默读成通过。本脚本未释放一律记 `fail`（唯一如实取值）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getProject, resolveDataDir } from "../src/server/registry";
import { projectWorkDir } from "../src/server/workstation";
import { loadDocument } from "../src/server/work/documents";
import { WorkServiceClient } from "../src/server/work/service";
import { auditEntityId } from "../src/server/work/audit";
import { putEvidence } from "../src/server/work/evidence";
import { SCHEMA_VERSION, type WorkReceipt } from "../src/server/work/types";
import {
  acceptanceDimensionOf,
  checksFromAudit,
  collectProjectFacts,
  dependencyRelease,
  objectsFromFacts,
  projectStatuses,
  type DependencyRelease,
  type StatusProjection,
} from "../src/server/work/statusProjection";

// ── 常量 ──

const PROJECT_ID = "tatai";
const INVENTORY_PATH = process.env.TATAI_BACKFILL_INVENTORY ?? path.join(os.tmpdir(), "tatai-backfill-inventory.json");
const RESULT_PATH = process.env.TATAI_BACKFILL_EDGES_RESULT ?? path.join(os.tmpdir(), "tatai-backfill-edges-result.json");
const BACKFILL_TAG = "prereq-backfill-20260927";
const IDEM_PREFIX = "backfill-20260927:";
const roundTag = (round: number): string => (round === 1 ? BACKFILL_TAG : `${BACKFILL_TAG}-r${round}`);
const CHANGE_ID = "change-20260927-backfill";
const BACKFILL_ACTOR = "claude-code";
/** reasons 摘要长度上限（进汇总 JSON，不截证据正文） */
const REASON_CAP = 300;

// ── 清单形态 ──

interface InventoryEdge {
  object_id: string;
  from_task: string;
  to_task: string;
  missing_check_ids: string[];
}
interface Inventory {
  project: string;
  tasks: { object_id: string; label: string }[];
  edges: InventoryEdge[];
}

// ── 参数 ──

interface Args {
  apply: boolean;
  only: string | null;
  /** 2026-09-28 补：第几轮补证（同边重跑用新轮号换新幂等键/实体号，第 1 轮保持原样） */
  round: number;
}
function parseArgs(argv: string[]): Args {
  let apply = false;
  let only: string | null = null;
  let round = 1;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") apply = false;
    else if (a === "--apply") apply = true;
    else if (a === "--only") {
      only = argv[++i] ?? null;
      if (only === null || only.trim() === "") throw new Error("--only 需要一个 task_id");
    } else if (a === "--round") {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1 || n > 99) throw new Error("--round 需要 1-99 的整数");
      round = n;
    } else throw new Error(`未知参数：${a}（支持 --dry-run/--apply/--only <task_id>/--round <n>）`);
  }
  return { apply, only, round };
}

// ── 现算每边的依赖释放（照 entry.ts#projectWithReleases 的 pass1 调用方式） ──

function computeReleases(
  projectId: string,
  dataDir: string,
  edges: InventoryEdge[],
): { releases: Record<string, DependencyRelease>; pass1: ReturnType<typeof projectStatuses> } {
  const facts = collectProjectFacts(projectId, dataDir);
  const acceptances = Object.values(facts.audit.acceptances);
  const withAcceptance = (objs: ReturnType<typeof objectsFromFacts>) =>
    objs.map((o) => ({
      ...o,
      acceptance: o.object_kind === "task" ? acceptanceDimensionOf(acceptances, { task_id: o.object_id }) : ("pending" as const),
    }));
  const pass1 = projectStatuses({
    objects: withAcceptance(objectsFromFacts(projectId, dataDir, facts)),
    findings: facts.findings,
    checks: checksFromAudit(facts.audit),
    source_revision: facts.revisions,
  });
  const releases: Record<string, DependencyRelease> = {};
  for (const e of edges) {
    const prerequisite: StatusProjection | undefined = pass1.by_id[e.from_task];
    const def = facts.definitions.find((d) => d.task_id === e.to_task);
    const evidenceRequirement = def?.dependency_evidence.find((d) => d.dependency_id === e.from_task)?.evidence ?? null;
    releases[e.object_id] = prerequisite
      ? dependencyRelease({ prerequisite_id: e.from_task, prerequisite, evidence_requirement: evidenceRequirement })
      : {
          prerequisite_id: e.from_task,
          released: false,
          self_reported_only: false,
          reasons: [`前置 ${e.from_task} 在投影里缺失（定义未导入/状态缺失），无法判释放`],
          caveats: [],
        };
  }
  return { releases, pass1 };
}

/** 前置是否仍带"补证未完成"信号（dry-run 预警用） */
function prereqUnfinished(p: StatusProjection | undefined): string | null {
  if (p === undefined) return "前置不在投影里";
  if (p.display_status === "pending_verification") return "前置仍为「结果待验证」（橙）";
  if (p.quality === "evidence_invalid") return "前置证据版本已失效（源变了）";
  if (p.quality === "unverified") return "前置必需验收未全过";
  if (p.freshness === "impact_unknown" || p.freshness === "unreadable") return `前置证据有效性待查（freshness=${p.freshness}）`;
  return null;
}

// ── 记录提交（唯一写入服务） ──

interface PlannedEdgeRecord {
  edge_id: string;
  record_id: string;
  record_entity_id: string;
  check: Record<string, unknown>;
  conclusion: "pass" | "fail";
}

/**
 * 提交一条边的释放检查记录。payload 与 `audit.ts#submitSelfCheck` 对齐（`task_id` 用**边对象 id**，
 * 使投影把它归到边对象的 `check_id` 上）；幂等键用任务卡前缀 `backfill-20260927:`。
 */
async function submitEdgeRecord(
  client: WorkServiceClient,
  rec: PlannedEdgeRecord,
  binding: { revision_kind: "plan"; revision: string },
  idempotencyKey: string,
): Promise<WorkReceipt> {
  return client.submit({
    schema_version: SCHEMA_VERSION,
    project_id: PROJECT_ID,
    change_id: CHANGE_ID,
    entity_id: auditEntityId("audit.self_check_recorded", rec.record_id),
    expected_revision: null,
    type: "audit.self_check_recorded",
    actor_id: BACKFILL_ACTOR,
    role: "executor",
    idempotency_key: idempotencyKey,
    payload: {
      task_id: rec.edge_id,
      round: 1,
      checked_by: BACKFILL_ACTOR,
      checks: [rec.check],
      conclusion: rec.conclusion,
      binding,
      coverage: [],
      method_limits: [],
      independence: "author_self",
    },
  });
}

// ── 主流程 ──

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const dataDir = resolveDataDir();
  if (getProject(PROJECT_ID, dataDir) === undefined) throw new Error(`${PROJECT_ID} 未注册（dataDir=${dataDir}）`);
  const workDir = projectWorkDir(PROJECT_ID, dataDir);

  const inventory = JSON.parse(fs.readFileSync(INVENTORY_PATH, "utf8")) as Inventory;
  if (inventory.project !== PROJECT_ID) throw new Error(`清单 project=${inventory.project}，不是 ${PROJECT_ID}`);

  const plan = loadDocument(PROJECT_ID, "plan", dataDir);
  if (plan === null) throw new Error("读不到 PLAN.md 文档修订，无法绑定 plan 哈希");
  const planHash = plan.revision.content_sha256;
  const binding = { revision_kind: "plan" as const, revision: planHash };

  let edges = inventory.edges;
  if (args.only !== null) {
    edges = edges.filter((e) => e.object_id === args.only || e.from_task === args.only || e.to_task === args.only);
    if (edges.length === 0) throw new Error(`--only ${args.only} 不匹配任何边（按边 id / from_task / to_task 过滤）`);
  }

  const { releases, pass1 } = computeReleases(PROJECT_ID, dataDir, edges);

  console.log(`== 依赖边释放补证（${args.apply ? "APPLY 真跑真写" : "DRY-RUN 只打印"}）`);
  console.log(`   项目=${PROJECT_ID}  dataDir=${dataDir}  清单=${INVENTORY_PATH}`);
  console.log(`   当前 plan 内容哈希=${planHash}`);
  console.log(`   边总数=${inventory.edges.length}  本次处理=${edges.length}`);

  // 前置预警：列表里任一边的前置仍带补证未完成信号
  const warned = new Map<string, string>();
  for (const e of edges) {
    const why = prereqUnfinished(pass1.by_id[e.from_task]);
    if (why !== null) warned.set(e.from_task, why);
  }
  if (warned.size > 0) {
    console.log("== [预警] 以下前置任务的补证尚未完成（released 多为 false）——建议先跑交付物一");
    for (const [id, why] of [...warned.entries()].sort()) {
      const cnt = edges.filter((e) => e.from_task === id).length;
      console.log(`   ${id}（涉 ${cnt} 条边）：${why}`);
    }
  }

  // 释放结果概览（top 前置按边数）
  const releasedCount = edges.filter((e) => releases[e.object_id]?.released).length;
  console.log(`== 释放结果：released=${releasedCount} / 未释放=${edges.length - releasedCount}`);
  const byPredCount = new Map<string, number>();
  for (const e of edges) byPredCount.set(e.from_task, (byPredCount.get(e.from_task) ?? 0) + 1);
  const topPred = [...byPredCount.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5);
  console.log("== top 前置（按涉及边数）");
  for (const [id, n] of topPred) {
    console.log(`   ${id}: ${n} 条（${warned.has(id) ? "前置补证未完成" : "前置已达标"}）`);
  }

  interface EdgeResult {
    edge: string;
    released: boolean;
    reasons: string;
    written_record: string | null;
  }
  const results: EdgeResult[] = [];

  if (!args.apply) {
    for (const e of edges) {
      const rel = releases[e.object_id]!;
      results.push({
        edge: e.object_id,
        released: rel.released,
        reasons: rel.reasons.join("；").slice(0, REASON_CAP),
        written_record: rel.released ? `check:${e.object_id}:${BACKFILL_TAG}` : `check:${e.object_id}:${BACKFILL_TAG}（fail）`,
      });
    }
    console.log("== DRY-RUN 结束：未跑命令、未写事件库（仅落本汇总文件）");
  } else {
    const client = new WorkServiceClient({ dataDir, timeoutMs: 15_000 });
    for (const e of edges) {
      const rel = releases[e.object_id]!;
      const conclusion: "pass" | "fail" = rel.released ? "pass" : "fail";
      // 证据正文＝该边的 dependencyRelease 输出（released/reasons/caveats）
      const content = JSON.stringify(
        { edge: e.object_id, from_task: e.from_task, to_task: e.to_task, release: rel, binding },
        null,
        2,
      );
      const blob = putEvidence(workDir, {
        content,
        kind: "self_check",
        summary: `${e.object_id} 前置释放复算（released=${rel.released}）`,
        created_by: BACKFILL_ACTOR,
        role: "executor",
        binding,
      });
      const check: Record<string, unknown> = {
        check_id: `${e.object_id}::prerequisite`,
        method:
          `依赖释放复算：${rel.released ? "前置已达标，释放" : "前置未达标，不释放"}` +
          (rel.reasons.length > 0 ? `（${rel.reasons.join("；")}）` : ""),
        command: null,
        exit_code: null,
        output_ref: blob.recovery_path,
        evidence_sha256: blob.sha256,
        verifies: "document",
      };
      const rec: PlannedEdgeRecord = {
        edge_id: e.object_id,
        record_id: `${e.object_id}:${roundTag(args.round)}`,
        record_entity_id: auditEntityId("audit.self_check_recorded", `${e.object_id}:${roundTag(args.round)}`),
        check,
        conclusion,
      };
      const idemKey = args.round === 1 ? `${IDEM_PREFIX}edge:${e.object_id}:prereq` : `${IDEM_PREFIX}edge:${e.object_id}:r${args.round}:prereq`;
      const receipt = await submitEdgeRecord(client, rec, binding, idemKey);
      console.log(
        `   ${e.object_id} released=${rel.released} conclusion=${conclusion} → seq=${receipt.seq}` +
          `${receipt.duplicate ? "（幂等命中）" : ""}`,
      );
      results.push({
        edge: e.object_id,
        released: rel.released,
        reasons: rel.reasons.join("；").slice(0, REASON_CAP),
        written_record: rec.record_entity_id,
      });
    }
  }

  const out = {
    generated_at: new Date().toISOString(),
    mode: args.apply ? "apply" : "dry_run",
    project: PROJECT_ID,
    data_dir: dataDir,
    plan_revision: planHash,
    inventory: INVENTORY_PATH,
    prereq_warnings: [...warned.entries()].map(([id, why]) => ({ predecessor: id, why })),
    summary: { released: releasedCount, blocked: edges.length - releasedCount, total: edges.length },
    edges: results,
  };
  fs.mkdirSync(path.dirname(RESULT_PATH), { recursive: true });
  fs.writeFileSync(RESULT_PATH, JSON.stringify(out, null, 2) + "\n", "utf8");
  console.log(`== 汇总已落 ${RESULT_PATH}（${results.length} 条边）`);
  if (!args.apply) console.log("   提示：前置补证完成后再以 --apply 真跑真写。");
}

main().catch((e) => {
  console.error("backfill-dependency-releases 失败：", e instanceof Error ? e.message : e);
  process.exit(1);
});
