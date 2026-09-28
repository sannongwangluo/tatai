// backfill-tatai：V07-03 塔台自身历史状态回放。
// 塔台不走通用迁移（events.jsonl 已在场，v2 是活账）——本脚本把 16 张已交付卡的历史事实
// 按PLAN 完成证据列回放成 task.result_submitted（执行者已提交结果；人工验收以 2026-09-20
// Gate 记录为准，不在回放里代签），随后备份 v1 tasks.json 并重写为 v2 兼容投影（list_tasks 同源）。
// 幂等：确定性幂等键，重跑返回原回执不重复生效。
import fs from "node:fs";
import path from "node:path";
import { getProject, resolveDataDir } from "../src/server/registry";
import { projectWorkDir } from "../src/server/workstation";
import { WorkServiceClient } from "../src/server/work/service";
import { readTaskStates, writeCompatTasksProjection, buildCompatTasksProjection } from "../src/server/work/tasks";
import { loadDocument } from "../src/server/work/documents";
import { importTaskDefinitions } from "../src/server/work/plan";
import { MIGRATION_BACKUP_DIRNAME } from "../src/server/work/migrate";

/** 16 张已交付卡：验证命令（历史事实，出处 PLAN 完成证据列）与证据指针 */
const CARDS: Array<{ id: string; command: string; evidence: string; note: string }> = [
  { id: "DES-V06", command: "文档/解析/渲染/真实 MCP 读回 15 项检查", evidence: ".工作台/reviews/v06-verification.json", note: "v0.6 设计/施工图修订（2026-09-20 交付）" },
  { id: "DES-V06-CLARIFY", command: "文档/历史完整性/依赖/解析/渲染/MCP 读回 11 项检查", evidence: ".工作台/reviews/v06-clarify-verification.json", note: "旧审计待办澄清（2026-09-20 交付）" },
  { id: "V06-01", command: "pnpm verify:v06-01（65 PASS / 0 FAIL）", evidence: ".工作台/evidence/V06-01/1/", note: "事实写入与版本协议" },
  { id: "V06-02", command: "pnpm verify:v06-02（97 PASS / 0 FAIL）", evidence: ".工作台/evidence/V06-02/1/", note: "双图纸源与配套基线" },
  { id: "V06-03", command: "pnpm verify:v06-03（97 PASS / 0 FAIL）", evidence: ".工作台/evidence/V06-03/1/", note: "施工定义、任务投影与迁移" },
  { id: "V06-04", command: "pnpm verify:v06-04（73 PASS / 0 FAIL）", evidence: ".工作台/evidence/V06-04/1/", note: "可信上下文与续读" },
  { id: "V06-05", command: "pnpm verify:v06-05（72 PASS / 0 FAIL）", evidence: ".工作台/evidence/V06-05/1/", note: "图纸派生规划关联" },
  { id: "V06-06", command: "pnpm verify:v06-06（113+66 PASS / 0 FAIL）", evidence: ".工作台/evidence/V06-06/1/", note: "三视图交互与自动状态" },
  { id: "V06-07", command: "pnpm verify:v06-07（117+25 PASS / 0 FAIL）", evidence: ".工作台/evidence/V06-07/1/", note: "聊天修订与动作回执" },
  { id: "V06-08", command: "pnpm verify:v06-08（28+74 PASS / 0 FAIL）", evidence: ".工作台/evidence/V06-08/1/", note: "自用主工作面与施工图页" },
  { id: "V06-09", command: "pnpm verify:v06-09（148 PASS / 0 FAIL）", evidence: ".工作台/evidence/V06-09/1/", note: "证据、审计与状态投影" },
  { id: "V06-10", command: "pnpm verify:v06-10（81 PASS / 0 FAIL）", evidence: ".工作台/evidence/V06-10/1/", note: "Agent 入口与下一动作" },
  { id: "V06-11", command: "pnpm verify:v06-11（96 PASS / 0 FAIL＋真实演练）", evidence: ".工作台/evidence/V06-11/1/", note: "外部协调器与恢复" },
  { id: "V06-12", command: "pnpm verify:v06-12（69+68 PASS / 0 FAIL）", evidence: ".工作台/evidence/V06-12/1/", note: "Git 版本提醒" },
  { id: "V06-13", command: "pnpm verify:v06-13（82+55 PASS / 0 FAIL＋用户 Gate 验收）", evidence: ".工作台/evidence/V06-13/1/", note: "塔台自举整体验收（用户 2026-09-20 Gate 通过）" },
  { id: "V06-14", command: "pnpm verify:v06-14（46 PASS / 0 FAIL）", evidence: ".工作台/evidence/V06-14/1/", note: "规模与私有事实恢复" },
];

async function main(): Promise<void> {
  const dataDir = resolveDataDir();
  if (getProject("tatai", dataDir) === undefined) throw new Error("tatai 未注册？");
  const workDir = projectWorkDir("tatai", dataDir);
  const client = new WorkServiceClient({ dataDir, timeoutMs: 8000 });

  // 证据存在性预检（一条缺就停，不带病回放）
  for (const c of CARDS) {
    if (!fs.existsSync(path.join("D:/tatai", c.evidence))) throw new Error(`证据缺失：${c.id} → ${c.evidence}`);
  }

  console.log("== ① 回放 16 张已交付卡 → task.result_submitted");
  for (const c of CARDS) {
    const states = readTaskStates(workDir).states;
    const state = states[c.id];
    if (state === undefined) throw new Error(`${c.id} 没有 v2 状态（定义未导入？）`);
    if (state.status === "result_submitted") {
      console.log(`  ${c.id}: 已是 result_submitted（幂等跳过）`);
      continue;
    }
    const receipt = await client.submit({
      schema_version: 2,
      project_id: "tatai",
      change_id: "change-20260922-v07-round",
      entity_id: `task:${c.id}`,
      type: "task.result_submitted",
      expected_revision: state.revision,
      actor_id: "claude-code",
      role: "coordinator",
      idempotency_key: `v0703-backfill:${c.id}:result:1`,
      payload: {
        deliverables: [`${c.note}（历史交付回放，出处 PLAN 完成证据列）`],
        evidence_refs: [c.evidence],
        verification: [{ command: c.command, exit_code: 0, output_ref: c.evidence }],
        untested: [],
        known_issues: ["历史回放：验收口径以 PLAN 完成证据与 PROGRESS 流水为准；人工验收以 2026-09-20 Gate 记录（gate.jsonl）为准，本回放不代签"],
        diff_ref: null,
        result_revision: null,
        meaning: "执行者已提交结果；不表示审计通过，也不表示人工验收接受（DESIGN.md §5.4）——历史事实回放（V07-03）",
      },
    });
    console.log(`  ${c.id}: seq=${receipt.seq} rev=${receipt.entity_revision}${receipt.duplicate ? "（幂等命中）" : ""}`);
  }

  console.log("== ② 备份 v1 tasks.json 并重写为 v2 兼容投影");
  const tasksFile = path.join(path.dirname(workDir), "tasks.json");
  const backupDir = path.join(workDir, MIGRATION_BACKUP_DIRNAME, `tatai-backfill-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  fs.mkdirSync(backupDir, { recursive: true });
  if (fs.existsSync(tasksFile)) {
    fs.copyFileSync(tasksFile, path.join(backupDir, "tasks.json"));
    console.log(`  已备份 ${tasksFile} → ${path.relative("D:/tatai", path.join(backupDir, "tasks.json"))}`);
  }
  const projection = readTaskStates(workDir);
  const previous = fs.existsSync(tasksFile)
    ? ({
        tasks:
          (JSON.parse(fs.readFileSync(tasksFile, "utf8")) as { tasks?: Array<Record<string, unknown>> }).tasks ?? [],
      } as Parameters<typeof buildCompatTasksProjection>[0]["previous"])
    : null;
  const plan = loadDocument("tatai", "plan", dataDir);
  const definitions = plan === null ? undefined : importTaskDefinitions(plan.text, { plan_revision: plan.revision.content_sha256 }).definitions;
  const built = buildCompatTasksProjection({ states: projection.states, previous, last_seq: projection.last_seq, definitions });
  writeCompatTasksProjection(tasksFile, built);
  console.log(`  投影已写：${built.tasks.length} 张卡，last_seq=${built.last_seq}（list_tasks 自此与事件流同源）`);

  console.log("== ③ 对账（v2 状态 vs PLAN 台账）");
  for (const c of CARDS) {
    const st = readTaskStates(workDir).states[c.id];
    console.log(`  ${c.id}: v2=${st?.status ?? "?"}（台账 done＝结果已提交）`);
  }
  console.log("  DES-V05：属 v0.5 历史段（不在现行施工表），不回放；其 v1 记录已在备份里保留");
}

main().catch((e) => {
  console.error("backfill-tatai 失败：", e instanceof Error ? e.message : e);
  process.exit(1);
});
