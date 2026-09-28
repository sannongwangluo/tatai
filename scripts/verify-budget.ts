// T23 / C-017 项目可配置预算约束验证（PLAN.md 批3 T23；DESIGN.md §5.7、TPL-10 §六③）。
// 用法：npx tsx scripts/verify-budget.ts（或 pnpm exec tsx scripts/verify-budget.ts）
//
// 与协调者盲写探针**不同源**：本脚本自建隔离夹具（临时 TATAI_HOME + os.tmpdir() 下的夹具项目，
// 不碰任何真实项目的 `.工作台/`），且**先提交 `task.definition_imported`** 让任务有运行状态
// （探针未走这一步，故探针的认领类断言在其夹具里读不到状态——见最终报告的冲突登记）。
//
// 覆盖点：
//   ① readProjectBudget 三态：无文件→不限；好文件；坏文件两亚型（坏 JSON / 字段类型错），fail-closed。
//   ② checkProjectBudget 全分支：不限 / 充足 / 接近（含 ratio 边界 0.79·0.8）/ 到顶 / 用量超上限；note 报剩余。
//   ③ countTaskClaims 计数口径：只数认领动作，renew/release 不多算。
//   ④ claimTask 集成：near→认领照常且回执(payload)带 budget{usage,max,remaining}；ok/不限→payload 零改动；
//      exhausted→拒（BUDGET_EXHAUSTED）＋先落 budget.blocked 留证（payload 逐字段断言）＋该任务无 claimed；
//      删配置恢复可领；坏配置 fail-closed 拒领。
//   ⑤ renewClaim / releaseClaim 不受预算影响（达到上限后仍能续约、释放）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BUDGET_FILE,
  DEFAULT_NEAR_THRESHOLD_RATIO,
  budgetEntityId,
  checkProjectBudget,
  countTaskClaims,
  readProjectBudget,
} from "../src/server/work/budget";
import { claimTask, readClaimEvents, releaseClaim, renewClaim } from "../src/server/work/claims";
import { importPlanChecked } from "../src/server/work/references";
import { WorkService } from "../src/server/work/service";
import { readTaskStates, submitDefinitionImports } from "../src/server/work/tasks";
import { NO_CHANGE_ID, isWorkError, type WorkEvent } from "../src/server/work/types";

// ── 断言与日志 ──

let passCount = 0;
let failCount = 0;
const ok = (cond: boolean, label: string, detail?: unknown): void => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (cond) passCount++;
  else {
    failCount++;
    process.exitCode = 1;
    if (detail !== undefined) console.log(`[verify]   现场：${JSON.stringify(detail).slice(0, 1200)}`);
  }
};
const info = (msg: string): void => console.log(`[verify] ${msg}`);

// ── 隔离夹具（临时目录；收尾整棵删）──

const base = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-t23-verify-"));
const dataDir = path.join(base, "home");
const root = path.join(base, "proj");
const work = path.join(root, ".工作台", "work");
const budgetPath = path.join(work, BUDGET_FILE);
const projectId = "vb";
fs.mkdirSync(work, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(
  path.join(dataDir, "registry.json"),
  JSON.stringify({
    version: 1,
    projects: [{ id: projectId, name: "预算夹具", path: root, kind: "backend", registered_at: "2026-09-20T00:00:00+08:00" }],
  }),
);
process.env.TATAI_HOME = dataDir;

const cards = ["B-1", "B-2", "B-3", "B-4", "B-5", "B-6", "B-7", "B-8"];
const planMd = [
  "# 预算夹具施工图",
  "",
  "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |",
  "| --- | --- | --- | --- | --- |",
  ...cards.map((c) => `| ${c} | todo | 做${c}事 |  | ${c}证据 |`),
  "",
  ...cards.flatMap((c) => [`### ${c} 做${c}事`, "", "**契约**：输入甲，输出乙。", "", `- [ ] ${c}完成`, "", "**交付**：记录。", ""]),
].join("\n");
fs.writeFileSync(path.join(root, ".工作台", "plan.md"), planMd);
fs.writeFileSync(path.join(root, ".工作台", "design.md"), "# 预算夹具设计书\n");

const service = new WorkService({ dataDir });
const submitter = { submit: (c: unknown) => service.submit(c) };
// 关键差异（探针缺的一步）：先把施工定义落成 task.definition_imported，任务才有可认领的运行状态。
submitDefinitionImports(submitter, {
  project_id: projectId,
  change_id: NO_CHANGE_ID,
  actor_id: "fixture",
  role: "executor",
  definitions: importPlanChecked(planMd, work).definitions,
});

const claim = (taskId: string, owner: string) =>
  claimTask({ project_id: projectId, task_id: taskId, role: "executor", owner_id: owner, change_id: NO_CHANGE_ID }, submitter, dataDir);
const isOk = (r: unknown): r is { ok: true } => (r as { ok: boolean }).ok === true;
const writeBudget = (body: unknown): void => fs.writeFileSync(budgetPath, typeof body === "string" ? body : JSON.stringify(body));
const dropBudget = (): void => fs.rmSync(budgetPath, { force: true });
/** 某张卡当前那条"认领动作"事件（排除 renew） */
const claimEventOf = (events: readonly WorkEvent[], taskId: string): WorkEvent | undefined =>
  events.find((e) => e.type === "task.claimed" && e.entity_id === `task:${taskId}` && e.payload.claim_action !== "renew");
const budgetBlockedEvents = (events: readonly WorkEvent[]): WorkEvent[] => events.filter((e) => e.type === "budget.blocked");

const readErr = (fn: () => unknown): { threw: boolean; code: string; message: string } => {
  try {
    fn();
    return { threw: false, code: "", message: "" };
  } catch (e) {
    return {
      threw: true,
      code: isWorkError(e) ? e.code : "THROWN",
      message: e instanceof Error ? e.message : String(e),
    };
  }
};

async function main(): Promise<void> {
  info(`T23 项目可配置预算约束：${BUDGET_FILE} 三态 / check 全分支 / claimTask 集成 / renew·release 免疫`);
  info(`  夹具：home=${dataDir}（临时）· work=${work}`);

  // ══════════════════════════ ① readProjectBudget 三态 ══════════════════════════
  info("── ① readProjectBudget：无文件 / 好文件 / 坏文件两亚型（fail-closed）");

  const noFile = readProjectBudget(work);
  ok(
    noFile.max_task_claims === null && noFile.near_threshold_ratio === DEFAULT_NEAR_THRESHOLD_RATIO,
    `①-1 无 budget.json → 不限（max_task_claims:null，ratio=${DEFAULT_NEAR_THRESHOLD_RATIO}）`,
    noFile,
  );

  writeBudget({ max_task_claims: 5, near_threshold_ratio: 0.8 });
  const good1 = readProjectBudget(work);
  writeBudget({ max_task_claims: null, near_threshold_ratio: 0.25 });
  const good2 = readProjectBudget(work);
  ok(
    good1.max_task_claims === 5 && good1.near_threshold_ratio === 0.8 && good2.max_task_claims === null && good2.near_threshold_ratio === 0.25,
    "①-2 好文件两份都原样读回（{5,0.8} 与 {null,0.25}）",
    { good1, good2 },
  );

  // 缺 ratio → 按接口注释"默认 0.8"取缺省
  writeBudget({ max_task_claims: 3 });
  const ratioDefault = readProjectBudget(work);
  ok(ratioDefault.near_threshold_ratio === DEFAULT_NEAR_THRESHOLD_RATIO, "①-3 只给 max、缺 ratio → ratio 取缺省 0.8", ratioDefault);

  // 坏 JSON（亚型一）
  writeBudget("{ not json");
  const badJson = readErr(() => readProjectBudget(work));
  ok(
    badJson.threw && badJson.code === "INVALID_COMMAND" && badJson.message.includes(BUDGET_FILE),
    `①-4 坏 JSON → 抛 INVALID_COMMAND 且点名 ${BUDGET_FILE}（不静默当不限）`,
    badJson,
  );

  // 字段类型错（亚型二）：max 各类非法 + ratio 越界
  const badMaxCases: [string, unknown][] = [
    ["0", 0],
    ["负数", -3],
    ["小数", 2.5],
    ["字符串", "5"],
    ["布尔", true],
    ["缺字段", undefined],
  ];
  for (const [name, value] of badMaxCases) {
    writeBudget(value === undefined ? {} : { max_task_claims: value, near_threshold_ratio: 0.8 });
    const r = readErr(() => readProjectBudget(work));
    ok(r.threw && r.code === "INVALID_COMMAND" && r.message.includes("max_task_claims"), `①-5 max_task_claims ${name} → 拒（fail-closed）`, r);
  }
  const badRatioCases: [string, unknown][] = [
    ["0", 0],
    ["超过 1", 1.5],
    ["负数", -0.1],
    ["字符串", "0.8"],
    ["NaN", Number.NaN],
  ];
  for (const [name, value] of badRatioCases) {
    writeBudget({ max_task_claims: 5, near_threshold_ratio: value });
    const r = readErr(() => readProjectBudget(work));
    ok(r.threw && r.code === "INVALID_COMMAND" && r.message.includes("near_threshold_ratio"), `①-6 near_threshold_ratio ${name} → 拒（fail-closed）`, r);
  }
  // 非对象（数组/标量）也拒
  writeBudget("[1,2]");
  const badShape = readErr(() => readProjectBudget(work));
  ok(badShape.threw && badShape.code === "INVALID_COMMAND", "①-7 顶层不是 JSON 对象（数组）→ 拒", badShape);
  dropBudget();

  // ══════════════════════════ ② checkProjectBudget 全分支 ══════════════════════════
  info("── ② checkProjectBudget：不限 / 充足 / 接近 / 到顶 / 超上限；note 必报剩余");

  const unlimited = checkProjectBudget({ max_task_claims: null, near_threshold_ratio: 0.8 }, 999);
  ok(
    unlimited.status === "ok" && unlimited.limited === false && unlimited.max === null && unlimited.remaining === null,
    "②-1 不限 → ok / limited:false / max:null / remaining:null",
    unlimited,
  );

  const okLow = checkProjectBudget({ max_task_claims: 5, near_threshold_ratio: 0.8 }, 3);
  const near = checkProjectBudget({ max_task_claims: 5, near_threshold_ratio: 0.8 }, 4);
  const atTop = checkProjectBudget({ max_task_claims: 5, near_threshold_ratio: 0.8 }, 5);
  const overTop = checkProjectBudget({ max_task_claims: 5, near_threshold_ratio: 0.8 }, 7);
  ok(
    okLow.status === "ok" && okLow.limited === false && okLow.remaining === 2 && near.status === "near" && near.limited === true && near.remaining === 1,
    "②-2 max=5：3/5→ok（剩 2）；4/5=0.8→near（剩 1，limited:true）",
    { okLow, near },
  );
  ok(
    atTop.status === "exhausted" && atTop.limited === true && atTop.remaining === 0 && overTop.status === "exhausted" && overTop.remaining === 0,
    "②-3 5/5→exhausted、7/5（超上限）→exhausted，remaining 都如实报 0（不为负）",
    { atTop, overTop },
  );
  ok(
    String(near.note).includes("1") && String(atTop.note).includes("0") && String(okLow.note).includes("2") && atTop.note.includes("§5.7"),
    "②-4 note 报剩余工作（near 剩 1 / exhausted 剩 0 / ok 剩 2），exhausted 也引 §5.7",
    { near: near.note, atTop: atTop.note, okLow: okLow.note },
  );

  // ratio 边界 0.79 / 0.8：比例恰在阈值两侧翻转
  const b079 = checkProjectBudget({ max_task_claims: 100, near_threshold_ratio: 0.8 }, 79); // 0.79 < 0.8 → ok
  const b080 = checkProjectBudget({ max_task_claims: 100, near_threshold_ratio: 0.8 }, 80); // 0.80 >= 0.8 → near
  const r079 = checkProjectBudget({ max_task_claims: 100, near_threshold_ratio: 0.79 }, 80); // 0.80 >= 0.79 → near
  ok(
    b079.status === "ok" && b080.status === "near" && r079.status === "near",
    "②-5 ratio 边界：0.79<0.8→ok、0.80>=0.8→near、0.80>=0.79→near",
    { b079: b079.status, b080: b080.status, r079: r079.status },
  );

  // ══════════════════════════ ③④ claimTask 集成 ══════════════════════════
  info("── ③④ claimTask 集成：无配置零改动 → 配 max=5 → near 带剩余 → exhausted 拒＋留证 → 删配置恢复");

  const r1 = await claim("B-1", "vb-a"); // usage 0
  const r2 = await claim("B-2", "vb-a"); // usage 1
  let events = readClaimEvents(work);
  ok(
    isOk(r1) && isOk(r2) && events.filter((e) => e.type === "task.claimed").length === 2,
    "③-1 无预算配置 → 不限，连领 2 张全 ok",
    { r1: isOk(r1), r2: isOk(r2) },
  );
  ok(
    events.filter((e) => e.type === "task.claimed").every((e) => !("budget" in e.payload)),
    "③-2 不限路径零改动：task.claimed payload 不带 budget 字段",
    { keys: events.filter((e) => e.type === "task.claimed").map((e) => Object.keys(e.payload)) },
  );

  writeBudget({ max_task_claims: 5, near_threshold_ratio: 0.8 });
  const r3 = await claim("B-3", "vb-b"); // usage 2 → 0.4 ok
  const r4 = await claim("B-4", "vb-b"); // usage 3 → 0.6 ok
  const r5 = await claim("B-5", "vb-b"); // usage 4 → 0.8 near
  const r6 = await claim("B-6", "vb-b"); // usage 5 → exhausted 拒
  events = readClaimEvents(work);
  const nearEv = claimEventOf(events, "B-5");
  const nearBudget = nearEv?.payload.budget as { usage: number; max: number; remaining: number } | undefined;
  ok(
    isOk(r3) && isOk(r4) && isOk(r5) && claimEventOf(events, "B-3") !== undefined && !("budget" in (claimEventOf(events, "B-3")?.payload ?? {})),
    "④-1 充足区（2/5、3/5）认领照常，payload 不带 budget",
    { r3: isOk(r3), r4: isOk(r4) },
  );
  ok(
    isOk(r5) && nearBudget !== undefined && nearBudget.usage === 4 && nearBudget.max === 5 && nearBudget.remaining === 1,
    "④-2 near（4/5）照常认领，task.claimed payload 带 budget{usage:4,max:5,remaining:1}（回执可见剩余工作）",
    { nearBudget: nearBudget ?? null },
  );
  const f6 = r6 as { ok: false; code?: string; message?: string; failures?: string[] };
  ok(
    !isOk(r6) && f6.code === "BUDGET_EXHAUSTED" && String(f6.message).includes("5.7") && String(f6.message).includes("0"),
    "④-3 达到上限 → 拒（BUDGET_EXHAUSTED），消息引 §5.7 且如实报剩余 0 次",
    { code: f6.code, message: f6.message },
  );

  const blocked = budgetBlockedEvents(events);
  const b6Payload = blocked[0]?.payload ?? {};
  ok(
    blocked.length === 1 &&
      Number(b6Payload.usage) === 5 &&
      Number(b6Payload.max) === 5 &&
      String(b6Payload.task_id) === "B-6" &&
      String(b6Payload.reason).includes("项目预算约束上限") &&
      String(b6Payload.reason).includes("5.7"),
    "④-4 拒前已落 budget.blocked 留证：payload 逐字段 {usage:5,max:5,task_id:'B-6',reason 含'项目预算约束上限'+'5.7'}",
    { blocked: blocked.map((e) => e.payload) },
  );
  ok(
    blocked[0]?.entity_id === budgetEntityId(projectId) && blocked[0]?.change_id === NO_CHANGE_ID,
    `④-5 budget.blocked 实体/批次口径：entity_id=${budgetEntityId(projectId)}（项目级）、change_id=${NO_CHANGE_ID}`,
    { entity_id: blocked[0]?.entity_id, change_id: blocked[0]?.change_id },
  );
  ok(
    claimEventOf(events, "B-6") === undefined,
    "④-6 被预算拒的任务 B-6 在事件流里没有 task.claimed（拒得干净）",
    { has: claimEventOf(events, "B-6") !== undefined },
  );

  dropBudget();
  const r6b = await claim("B-6", "vb-c");
  ok(isOk(r6b), "④-7 删除 budget.json → 同任务 B-6 恢复可领（约束随配置，非永久封印）", { ok: isOk(r6b) });

  writeBudget("{ broken");
  const r7 = await claim("B-7", "vb-d").catch((e) => ({ ok: false as const, code: (e as { code?: string }).code ?? "THROWN", message: String((e as Error).message) }));
  ok(!isOk(r7), "④-8 坏 budget.json → 认领路径 fail-closed 拒（不静默当不限）", r7);
  dropBudget();

  // ══════════════════════════ ⑤ 计数口径 + renew/release 免疫 ══════════════════════════
  info("── ⑤ countTaskClaims 口径 ＋ renew/release 不受预算影响");

  const countNow = countTaskClaims(readClaimEvents(work));
  ok(
    countNow === 6 && countNow === readClaimEvents(work).filter((e) => e.type === "task.claimed" && e.payload.claim_action !== "renew").length,
    "⑤-1 countTaskClaims 只数认领动作（B-1..B-6 共 6 次），与流里 claim_action!=='renew' 的条数一致",
    { countNow },
  );

  // 设上限=1：用量(6) 远超上限 → 项目处于 exhausted，但 renew/release 不看预算
  writeBudget({ max_task_claims: 1, near_threshold_ratio: 0.8 });
  const st6 = readTaskStates(work).states["B-6"] ?? null;
  ok(st6 !== null && st6.claim_token !== null, "⑤-2 取到 B-6 的当前认领（token 非空，续约/释放的前提）");
  const renewed = await renewClaim(
    {
      project_id: projectId,
      task_id: "B-6",
      role: "executor",
      owner_id: "vb-c",
      change_id: NO_CHANGE_ID,
      claim_token: st6?.claim_token ?? "",
      expected_revision: st6?.revision ?? 0,
      now: "2026-09-20T10:00:00.000Z",
    },
    submitter,
    dataDir,
  );
  const afterRenew = readClaimEvents(work);
  ok(
    isOk(renewed) && afterRenew.some((e) => e.type === "task.claimed" && e.payload.claim_action === "renew" && e.entity_id === "task:B-6"),
    "⑤-3 项目已达预算上限仍能续约（renewClaim 不查预算）",
    { ok: isOk(renewed) },
  );
  ok(
    countTaskClaims(afterRenew) === 6,
    "⑤-4 续约事件（task.claimed + claim_action:renew）不被 countTaskClaims 多算（仍为 6）",
    { counted: countTaskClaims(afterRenew) },
  );

  const st6b = readTaskStates(work).states["B-6"] ?? null;
  const released = await releaseClaim(
    {
      project_id: projectId,
      task_id: "B-6",
      role: "executor",
      owner_id: "vb-c",
      change_id: NO_CHANGE_ID,
      claim_token: st6b?.claim_token ?? "",
      expected_revision: st6b?.revision ?? 0,
    },
    submitter,
    dataDir,
  );
  const afterRelease = readClaimEvents(work);
  ok(
    isOk(released) &&
      afterRelease.some((e) => e.type === "task.status_changed" && e.payload.claim_released === true && e.entity_id === "task:B-6") &&
      countTaskClaims(afterRelease) === 6,
    "⑤-5 项目已达预算上限仍能释放（releaseClaim 不查预算），释放事件不多算认领（仍为 6）",
    { ok: isOk(released), counted: countTaskClaims(afterRelease) },
  );

  // 释放后再领一张仍被预算挡住（exhausted 仍在）：验证约束对"领取下一任务"持续生效
  const r8 = await claim("B-8", "vb-e");
  const blocked2 = budgetBlockedEvents(readClaimEvents(work));
  ok(
    !isOk(r8) && (r8 as { code?: string }).code === "BUDGET_EXHAUSTED" && blocked2.length === 2 && String(blocked2[1]?.payload.task_id) === "B-8",
    "⑤-6 续约/释放之后，预算对'领取下一任务'仍生效：B-8 再被拒并新增一条 budget.blocked",
    { code: (r8 as { code?: string }).code, blockedCount: blocked2.length },
  );
  dropBudget();

  // ── 收尾 ──
  fs.rmSync(base, { recursive: true, force: true });
  info(`完成：PASS ${passCount} / FAIL ${failCount}`);
}

main()
  .then(() => {
    process.exitCode = failCount > 0 ? 1 : process.exitCode;
  })
  .catch((e) => {
    console.error(`[verify] 未捕获异常：${e instanceof Error ? e.stack : String(e)}`);
    try {
      fs.rmSync(base, { recursive: true, force: true });
    } catch {
      // 清理失败不改结论
    }
    process.exitCode = 1;
  });
