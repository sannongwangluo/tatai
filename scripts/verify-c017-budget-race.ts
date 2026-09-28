// C-017 批3终审补修验证：项目预算门禁上收到唯一写入服务的文件锁（写入边界原子「检查—保留」）。
// 用法：npx tsx scripts/verify-c017-budget-race.ts（或 pnpm exec tsx scripts/verify-c017-budget-race.ts）
//
// 终审反例（临时核验/塔台批3终审-20260921/adversarial/probe1-budget-race.ts 与
// contracts/c017-budget-boundary.probe.ts，旧实现上均复现）指出两条越限通道：
//   ① claimTask 的预算预查是 check-then-act：真实 HTTP 客户端边界上两个并发认领都读到 usage=0，双双越过 max=1；
//   ② 直连通用写口（WorkService.submit / POST /api/work/command）手写 task.claimed 可整体旁路预算检查。
//
// 修复（service.ts submit ②′，与 claims/budget 共口径）后，本脚本在**同一真实链路**
// （WorkServiceClient → 回环 HTTP → 真实 WorkService 文件锁）上断言新契约：
//   · 顺序与并发均最多 1 张认领成功；败者拿 BUDGET_EXHAUSTED（引 §5.7、如实报剩余 0）；
//   · 竞态败者的留证由写入边界在锁内落 budget.blocked（恰 1 条；claimTask 重试同键不刷屏）；
//   · 通用写口绕过同样被门禁拒（INVALID_COMMAND + detail.reason=budget_exhausted），被拒认领零字节；
//   · 幂等（同键同内容→原回执、同键异内容→IDEMPOTENCY_CONFLICT）、版本冲突先于预算、
//     renew 不受门禁、事件重放不变量（seq/revision 连续、幂等键唯一）全部不退化。
//
// C017 回炉（伪造续约绕过，批3后续独立复审发现）：上一轮 ②′ 只凭 payload.claim_action 自报
// 区分 claim/renew——持 token 的调用者给从未认领的任务手写 task.claimed+claim_action:"renew"
// 即可整体绕过 max_task_claims（反例：临时核验/c017-renew回炉-20260921/out/probe-before.txt，
// 修复前 3/3 ACCEPTED、用量不涨）。本轮在写入边界先核实再放行（verifyRenewClaimEvent 凭锁内
// 事件现场：当前有效认领 + 持有者 token/身份 + 任务状态 + 新租约），新增第 ⑤ 节断言：
//   · 伪造续约（从未认领/已释放/已交付、token 错、owner 错、actor 错、无定义任务、非任务实体）
//     一律 INVALID_COMMAND + detail.reason=renew_not_verified，零字节、不落 budget.blocked、计数不涨；
//   · 真实续约（renewClaim 与手写但字段全对的持有者续约）在预算耗尽下仍通过，计数不多算；
//   · claim_action 拼写变体按首次认领处理（budget_exhausted 拒）；countTaskClaims 对伪造输入
//     按认领计、对合法历史逐条一致（历史口径稳定）；并发与幂等断言不受影响。
//
// 隔离：mkdtemp 夹具 + 本进程 127.0.0.1 随机端口临时 HTTP；不接真网关、不碰真实项目与用户实例；收尾整棵删。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import {
  WorkService,
  WorkServiceClient,
  handleWorkRequest,
  writeServiceDescriptor,
  removeServiceDescriptor,
} from "../src/server/work/service";
import { importPlanChecked } from "../src/server/work/references";
import { claimTask, readClaimEvents, releaseClaim, renewClaim } from "../src/server/work/claims";
import { readTaskStates, submitDefinitionImports } from "../src/server/work/tasks";
import { FORGED_RENEW_DETAIL_REASON, budgetEntityId, countTaskClaims } from "../src/server/work/budget";
import { buildSnapshot, loadEvents } from "../src/server/work/eventStore";
import { NO_CHANGE_ID, SCHEMA_VERSION, WorkError, isWorkError, type WorkEvent, type WorkReceipt } from "../src/server/work/types";

let passCount = 0;
let failCount = 0;
const ok = (cond: boolean, label: string, detail?: unknown): void => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (cond) passCount++;
  else {
    failCount++;
    process.exitCode = 1;
    if (detail !== undefined) console.log(`[verify]   现场：${JSON.stringify(detail).slice(0, 1400)}`);
  }
};
const info = (msg: string): void => console.log(`[verify] ${msg}`);
const nowMs = (): string => new Date().toISOString();

// ── 隔离夹具（临时目录；收尾整棵删）──
const base = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-c017-verify-"));
const dataDir = path.join(base, "home");
fs.mkdirSync(dataDir, { recursive: true });
process.env.TATAI_HOME = dataDir;

const SEQ = "c017v-seq"; // 顺序对照
const RACE = "c017v-race"; // barrier 并发
const DIRECT = "c017v-direct"; // 通用写口绕过
const PROJECTS = [SEQ, RACE, DIRECT];
const FORGED = "c017v-forged"; // C017 回炉：伪造续约（独立施工图 4 张卡，预算上限 2）
const rootOf = (id: string): string => path.join(base, id);
const workOf = (id: string): string => path.join(rootOf(id), ".工作台", "work");

const planMd = [
  "# C017 补修验证施工图",
  "",
  "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |",
  "| --- | --- | --- | --- | --- |",
  "| T-A | todo | 甲事 |  | 甲证据 |",
  "| T-B | todo | 乙事 |  | 乙证据 |",
  "",
  "### T-A 甲事",
  "",
  "**契约**：输入甲，输出乙。",
  "",
  "- [ ] 甲完成",
  "",
  "**交付**：记录。",
  "",
  "### T-B 乙事",
  "",
  "**契约**：输入丙，输出丁。",
  "",
  "- [ ] 乙完成",
  "",
  "**交付**：记录。",
  "",
].join("\n");

for (const id of PROJECTS) {
  fs.mkdirSync(workOf(id), { recursive: true });
  fs.writeFileSync(path.join(rootOf(id), ".工作台", "plan.md"), planMd);
  fs.writeFileSync(path.join(rootOf(id), ".工作台", "design.md"), "# C017 补修验证设计书\n");
  fs.writeFileSync(path.join(workOf(id), "budget.json"), JSON.stringify({ max_task_claims: 1, near_threshold_ratio: 0.8 }));
}
// 回炉夹具：4 张无依赖卡（T-A 持有者、T-D 用于交付后伪造、T-B/T-C 从未认领），上限 2 —
// 两张真认领恰好顶满，伪造续约的拒绝因此与"预算是否耗尽"无关也能区分开
const planMdForged = [
  "# C017 回炉验证施工图",
  "",
  "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |",
  "| --- | --- | --- | --- | --- |",
  "| T-A | todo | 甲事 |  | 甲证据 |",
  "| T-B | todo | 乙事 |  | 乙证据 |",
  "| T-C | todo | 丙事 |  | 丙证据 |",
  "| T-D | todo | 丁事 |  | 丁证据 |",
  "",
  ...["T-A", "T-B", "T-C", "T-D"].flatMap((t) => [`### ${t} 事`, "", "**契约**：输入甲，输出乙。", "", `- [ ] ${t}完成`, "", "**交付**：记录。", ""]),
].join("\n");
fs.mkdirSync(workOf(FORGED), { recursive: true });
fs.writeFileSync(path.join(rootOf(FORGED), ".工作台", "plan.md"), planMdForged);
fs.writeFileSync(path.join(rootOf(FORGED), ".工作台", "design.md"), "# C017 回炉验证设计书\n");
fs.writeFileSync(path.join(workOf(FORGED), "budget.json"), JSON.stringify({ max_task_claims: 2, near_threshold_ratio: 0.8 }));
fs.writeFileSync(
  path.join(dataDir, "registry.json"),
  JSON.stringify({
    version: 1,
    projects: [...PROJECTS, FORGED].map((id) => ({
      id,
      name: id,
      path: rootOf(id),
      kind: "backend",
      registered_at: "2026-09-21T00:00:00+08:00",
    })),
  }),
);

const service = new WorkService({ dataDir });
const syncSubmitter = { submit: (c: unknown) => service.submit(c) };
const claimVia = (
  projectId: string,
  taskId: string,
  owner: string,
  submitter: { submit: (c: unknown) => WorkReceipt | Promise<WorkReceipt> },
) => claimTask({ project_id: projectId, task_id: taskId, role: "executor", owner_id: owner, change_id: NO_CHANGE_ID }, submitter, dataDir);
const isOk = (r: unknown): r is { ok: true } => (r as { ok: boolean }).ok === true;
const blockedOf = (id: string) => readClaimEvents(workOf(id)).filter((e) => e.type === "budget.blocked");
const usageOf = (id: string) => countTaskClaims(readClaimEvents(workOf(id)));
/** 直连通用写口手写一条 task.claimed（绕过 claimTask 的全部预查） */
const rawClaimCommand = (projectId: string, taskId: string, expectedRevision: number | null, key: string, action: "claim" | "renew" = "claim") => ({
  schema_version: SCHEMA_VERSION,
  project_id: projectId,
  change_id: NO_CHANGE_ID,
  entity_id: `task:${taskId}`,
  expected_revision: expectedRevision,
  type: "task.claimed",
  actor_id: "raw-writer",
  role: "executor",
  idempotency_key: key,
  payload: {
    claim_action: action,
    owner_id: "raw-writer",
    owner_role: "executor",
    run_id: `run-${taskId}-raw`,
    attempt_id: `att-${taskId}-raw`,
    attempt: 1,
    claim_token: `clm-raw-${taskId}`,
    lease_expires_at: new Date(Date.now() + 900_000).toISOString(),
    workspace: `.工作台/runs/${taskId}/att-raw`,
    takeover_basis: null,
  },
});
const submitErr = (fn: () => unknown): { code: string; message: string; detail: Record<string, unknown> } => {
  try {
    fn();
    return { code: "", message: "", detail: {} };
  } catch (e) {
    return {
      code: isWorkError(e) ? e.code : "THROWN",
      message: e instanceof Error ? e.message : String(e),
      detail: isWorkError(e) ? (e.detail as Record<string, unknown>) : {},
    };
  }
};

async function main(): Promise<void> {
  info("C-017 批3终审补修：写入边界原子预算门禁（并发 / 绕过 / 留证 / 幂等 / 重放）");
  info(`  夹具：home=${dataDir}（临时）`);

  // ── 真实 WorkService + 本进程内回环 HTTP + 真实 WorkServiceClient（与探针同链路） ──
  const token = crypto.randomBytes(18).toString("base64url");
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    void handleWorkRequest(req, res, { service, token, pathname }).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  writeServiceDescriptor(dataDir, {
    schema_version: SCHEMA_VERSION,
    pid: process.pid,
    host: "127.0.0.1",
    port,
    token,
    started_at: nowMs(),
    url: `http://127.0.0.1:${port}`,
  });
  const client = new WorkServiceClient({ dataDir });
  const availability = await client.probe();
  ok(availability.available, "0 环境：隔离 WorkServiceClient 探活可用（否则是环境错误，不算产品结论）", {
    port,
    reason: availability.reason,
  });

  for (const id of PROJECTS) {
    submitDefinitionImports(syncSubmitter, {
      project_id: id,
      change_id: NO_CHANGE_ID,
      actor_id: "fixture",
      role: "coordinator",
      definitions: importPlanChecked(planMd, workOf(id)).definitions,
    });
  }
  submitDefinitionImports(syncSubmitter, {
    project_id: FORGED,
    change_id: NO_CHANGE_ID,
    actor_id: "fixture",
    role: "coordinator",
    definitions: importPlanChecked(planMdForged, workOf(FORGED)).definitions,
  });
  ok(
    PROJECTS.every((id) => readClaimEvents(workOf(id)).filter((e) => e.type === "task.definition_imported").length === 2),
    "0b 环境：三项目各导入 2 张任务定义（T-A/T-B，无依赖），budget.json 均为 max_task_claims=1",
  );

  // ═══ ① 顺序对照（名义路径契约不退化）：第 1 张成功，第 2 张 BUDGET_EXHAUSTED + 1 条留证 ═══
  info("── ① 顺序对照：预查路径的拒绝与留证保持原样");
  const s1 = await claimVia(SEQ, "T-A", "seq-owner-1", client);
  const s2 = await claimVia(SEQ, "T-B", "seq-owner-2", client);
  ok(
    isOk(s1) && !isOk(s2) && (s2 as { code?: string }).code === "BUDGET_EXHAUSTED",
    "①-1 顺序：第 1 张认领成功，第 2 张被 BUDGET_EXHAUSTED 明确拒绝",
    { s1: isOk(s1), s2code: (s2 as { code?: string }).code },
  );
  ok(
    usageOf(SEQ) === 1 && blockedOf(SEQ).length === 1 && String(blockedOf(SEQ)[0]?.payload.task_id) === "T-B",
    "①-2 顺序：claimed 计数停在 1（=上限），预查路径落 1 条 budget.blocked（task_id=T-B）",
    { usage: usageOf(SEQ), blocked: blockedOf(SEQ).map((e) => e.payload) },
  );

  // ═══ ② 竞态（终审反例的核心构造）：barrier 双方到提交点再放行，提交仍走真实 HTTP/WorkService ═══
  info("── ② 竞态：两个并发认领都读过预算再提交——修复后最多 1 个成功");
  const barrierLog: string[] = [];
  let arrived = 0;
  let releaseGate!: () => void;
  let failGate!: (e: Error) => void;
  const gate = new Promise<void>((res, rej) => {
    releaseGate = res;
    failGate = rej;
  });
  const gateTimer = setTimeout(() => failGate(new Error("barrier 超时：第二方未到提交点（环境问题，不算产品结论）")), 10_000);
  const barrierSubmitter = (name: string) => ({
    submit: async (c: unknown): Promise<WorkReceipt> => {
      barrierLog.push(`${nowMs()} ${name} 到达提交点（其 claimTask 的预算预查必然更早完成）`);
      arrived += 1;
      if (arrived === 2) {
        clearTimeout(gateTimer);
        barrierLog.push(`${nowMs()} barrier 放行：双方都已读过预算、都已到提交点`);
        releaseGate();
      }
      await gate;
      barrierLog.push(`${nowMs()} ${name} 放行后发起真实 HTTP 提交`);
      return client.submit(c); // 真实 WorkServiceClient → 回环 HTTP → 真实 WorkService.submit（文件锁串行）
    },
  });
  const [r1, r2] = await Promise.all([
    claimVia(RACE, "T-A", "racer-1", barrierSubmitter("racer-1(T-A)")),
    claimVia(RACE, "T-B", "racer-2", barrierSubmitter("racer-2(T-B)")),
  ]);
  const winners = [r1, r2].filter(isOk);
  const loser = [r1, r2].find((r) => !isOk(r)) as { code?: string; message?: string; failures?: string[] } | undefined;
  const loserTask = isOk(r1) ? "T-B" : "T-A";
  const loserOwner = isOk(r1) ? "racer-2" : "racer-1";
  ok(
    barrierLog.filter((l) => l.includes("到达提交点")).length === 2 && barrierLog.some((l) => l.includes("barrier 放行")),
    "②-0 竞态时序：barrier 日志证明双方都先到提交点、后放行（两个预算预查都在任何提交落盘之前）",
    barrierLog,
  );
  ok(
    winners.length === 1 && loser !== undefined && loser.code === "BUDGET_EXHAUSTED",
    "②-1 竞态：恰 1 个认领成功，败者被 BUDGET_EXHAUSTED 明确拒绝（旧实现两个都成功）",
    { r1: isOk(r1), r2: isOk(r2), loserCode: loser?.code ?? null },
  );
  ok(
    loser !== undefined && String(loser.message).includes("5.7") && String(loser.message).includes("剩余可认领 0 次"),
    "②-2 竞态败者消息引 §5.7 且如实报剩余 0 次（与顺序拒绝同口径）",
    { message: loser?.message ?? null },
  );
  ok(
    usageOf(RACE) === 1,
    "②-3 竞态：项目级 claimed 计数 = 1 ≤ 上限 1（预算约束在并发下成立；旧实现为 2）",
    { usage: usageOf(RACE), max: 1 },
  );
  const raceBlocked = blockedOf(RACE);
  ok(
    raceBlocked.length === 1 &&
      raceBlocked[0]?.entity_id === budgetEntityId(RACE) &&
      String(raceBlocked[0]?.payload.task_id) === loserTask &&
      Number(raceBlocked[0]?.payload.usage) === 1 &&
      Number(raceBlocked[0]?.payload.max) === 1 &&
      String(raceBlocked[0]?.actor_id) === loserOwner,
    "②-4 竞态：写入边界在锁内恰落 1 条 budget.blocked（项目级实体；task=败者卡、usage=1/max=1、actor=败者）",
    raceBlocked.map((e) => ({ entity_id: e.entity_id, actor_id: e.actor_id, payload: e.payload })),
  );
  // 败者原样重试（同 task/owner）：预查命中已 exhausted；同键留证已存在 → 不刷屏、仍明确拒绝
  const retry = await claimVia(RACE, loserTask, loserOwner, client);
  ok(
    !isOk(retry) && (retry as { code?: string }).code === "BUDGET_EXHAUSTED" && blockedOf(RACE).length === 1 && usageOf(RACE) === 1,
    "②-5 败者重试：仍 BUDGET_EXHAUSTED；budget.blocked 不重复落（仍 1 条）、claimed 仍 1（幂等不刷屏）",
    { code: (retry as { code?: string }).code, blocked: blockedOf(RACE).length, usage: usageOf(RACE) },
  );

  // ═══ ③ 通用写口绕过（C017-1 疑点）：直连 service.submit 手写 task.claimed ═══
  info("── ③ 通用写口：绕过 claimTask 的直连提交同样被写入边界门禁");
  const revA = readTaskStates(workOf(DIRECT)).states["T-A"]?.revision ?? null;
  const bypass1 = rawClaimCommand(DIRECT, "T-A", revA, "c017v-raw-claim-1");
  const b1 = service.submit(bypass1);
  ok(b1.ok === true && usageOf(DIRECT) === 1, "③-1 直连手写第 1 张认领（usage 0<1）：正常落盘（门禁不误伤）", {
    ok: b1.ok,
    usage: usageOf(DIRECT),
  });
  const b1dup = service.submit(bypass1);
  ok(
    b1dup.ok === true && b1dup.duplicate === true && b1dup.event_id === b1.event_id && usageOf(DIRECT) === 1,
    "③-2 幂等不退化：同键同内容重发（此刻用量已=上限）仍返回原回执，不产生第二次效果",
    { duplicate: b1dup.duplicate, usage: usageOf(DIRECT) },
  );
  const conflict = submitErr(() => service.submit({ ...bypass1, payload: { ...bypass1.payload, attempt: 2 } }));
  ok(
    conflict.code === "IDEMPOTENCY_CONFLICT",
    "③-3 幂等不退化：同键异内容仍被 IDEMPOTENCY_CONFLICT 明确拒绝",
    conflict,
  );
  const revB = readTaskStates(workOf(DIRECT)).states["T-B"]?.revision ?? null;
  const bypass2 = rawClaimCommand(DIRECT, "T-B", revB, "c017v-raw-claim-2");
  const b2err = submitErr(() => service.submit(bypass2));
  ok(
    b2err.code === "INVALID_COMMAND" &&
      b2err.detail.reason === "budget_exhausted" &&
      Number(b2err.detail.usage) === 1 &&
      Number(b2err.detail.max) === 1 &&
      typeof b2err.detail.blocked_event_seq === "number",
    "③-4 绕过被挡：直连手写第 2 张认领被预算门禁拒（INVALID_COMMAND + detail.reason=budget_exhausted，带 usage/max/留证序号）",
    b2err,
  );
  const directEvents = readClaimEvents(workOf(DIRECT));
  ok(
    !directEvents.some((e) => e.type === "task.claimed" && e.entity_id === "task:T-B") && usageOf(DIRECT) === 1,
    "③-5 被拒的绕过认领零字节：事件流里没有 T-B 的 task.claimed，计数仍 1",
    { usage: usageOf(DIRECT) },
  );
  const directBlocked = blockedOf(DIRECT);
  ok(
    directBlocked.length === 1 &&
      String(directBlocked[0]?.payload.task_id) === "T-B" &&
      Number(directBlocked[0]?.payload.usage) === 1 &&
      Number(directBlocked[0]?.payload.max) === 1 &&
      directBlocked[0]?.change_id === NO_CHANGE_ID,
    "③-6 绕过拒绝同样留证：写入边界落 1 条 budget.blocked（task_id=T-B、usage=1/max=1、change-none）",
    directBlocked.map((e) => ({ entity_id: e.entity_id, payload: e.payload })),
  );
  const b2retry = submitErr(() => service.submit(bypass2));
  ok(
    b2retry.code === "INVALID_COMMAND" &&
      b2retry.detail.reason === "budget_exhausted" &&
      b2retry.detail.blocked_event_seq === null &&
      blockedOf(DIRECT).length === 1,
    "③-7 同一绕过命令重发：仍被拒；留证幂等去重（blocked_event_seq=null，不刷屏，仍 1 条）",
    { ...b2retry, blocked: blockedOf(DIRECT).length },
  );
  const staleErr = submitErr(() => service.submit(rawClaimCommand(DIRECT, "T-B", 999, "c017v-raw-claim-3")));
  ok(
    staleErr.code === "VERSION_CONFLICT",
    "③-8 版本语义不退化且优先：声明过期 expected_revision 的认领仍拿 VERSION_CONFLICT（不是预算错）",
    staleErr,
  );
  const revA2 = readTaskStates(workOf(DIRECT)).states["T-A"]?.revision ?? null;
  const renewRaw = service.submit(rawClaimCommand(DIRECT, "T-A", revA2, "c017v-raw-renew-1", "renew"));
  ok(
    renewRaw.ok === true && usageOf(DIRECT) === 1,
    "③-9 renew 不受门禁：手写但字段与事件现场一致的持有者续约经核实放行（与 countTaskClaims 同口径不多算），项目到顶仍能续约",
    { ok: renewRaw.ok, usage: usageOf(DIRECT) },
  );
  const snapDirect = service.readSnapshot(DIRECT);
  ok(
    snapDirect.snapshot !== null && snapDirect.snapshot.last_seq === readClaimEvents(workOf(DIRECT)).length && snapDirect.stale === false,
    "③-10 留证事件投影同步跟上：快照 last_seq 与事件数一致且不标陈旧",
    { last_seq: snapDirect.snapshot?.last_seq ?? null, events: readClaimEvents(workOf(DIRECT)).length, stale: snapDirect.stale },
  );

  // ═══ ④ 事件重放不变量（修复不破坏重放）：seq/revision 连续、幂等键唯一、可重建 ═══
  info("── ④ 重放：三项目事件流全量重放 + repair 重建，结构不变量全部成立");
  for (const id of PROJECTS) {
    const { events } = loadEvents(workOf(id));
    let replayError: string | null = null;
    try {
      buildSnapshot(id, events, null);
    } catch (e) {
      replayError = e instanceof WorkError ? `${e.code}: ${e.message}` : String(e);
    }
    const repaired = service.repair(id);
    ok(
      replayError === null && repaired.snapshot !== null && repaired.snapshot.last_seq === events.length,
      `④ 重放 ${id}：全量重放无结构违例（seq 连续/revision 连续/幂等键唯一），repair 重建到 last_seq=${events.length}`,
      { replayError, last_seq: repaired.snapshot?.last_seq ?? null, events: events.length },
    );
  }

  // ═══ ⑤ C017 回炉：伪造续约封口（写入边界先核实再放行，不凭 payload 自报 claim_action） ═══
  info("── ⑤ 伪造续约：从未认领/身份不符/已释放/已交付/无定义/非任务实体一律拒且零字节；真实续约照常");
  const submitErrA = async (fn: () => Promise<unknown>): Promise<{ code: string; message: string; detail: Record<string, unknown> }> => {
    try {
      await fn();
      return { code: "", message: "", detail: {} };
    } catch (e) {
      return {
        code: isWorkError(e) ? e.code : "THROWN",
        message: e instanceof Error ? e.message : String(e),
        detail: isWorkError(e) ? (e.detail as Record<string, unknown>) : {},
      };
    }
  };
  const claimedCountOf = (entityId: string) =>
    readClaimEvents(workOf(FORGED)).filter((e) => e.type === "task.claimed" && e.entity_id === entityId).length;
  /** 手写一条"自称续约"的命令（token/owner/actor/action/lease 全部可指定；默认全伪造） */
  const rawRenewCmd = (args: {
    taskId: string;
    rev: number | null;
    key: string;
    actor: string;
    owner: string;
    token: string;
    entity?: string;
    action?: unknown;
    lease?: unknown;
  }) => ({
    schema_version: SCHEMA_VERSION,
    project_id: FORGED,
    change_id: NO_CHANGE_ID,
    entity_id: args.entity ?? `task:${args.taskId}`,
    expected_revision: args.rev,
    type: "task.claimed",
    actor_id: args.actor,
    role: "executor",
    idempotency_key: args.key,
    payload: {
      claim_action: args.action === undefined ? "renew" : args.action,
      owner_id: args.owner,
      owner_role: "executor",
      run_id: `run-${args.taskId}-raw`,
      attempt_id: `att-${args.taskId}-raw`,
      attempt: 1,
      claim_token: args.token,
      lease_expires_at: args.lease === undefined ? new Date(Date.now() + 900_000).toISOString() : args.lease,
      workspace: `.工作台/runs/${args.taskId}/att-raw`,
      takeover_basis: null,
    },
  });
  const revOf = (taskId: string) => readTaskStates(workOf(FORGED)).states[taskId]?.revision ?? null;

  // ⑤-0 两张真认领恰好顶满上限 2（之后所有伪造拒绝都发生在 exhausted 下：伪造拒绝与预算拒绝分得开）
  const f1 = await claimTask({ project_id: FORGED, task_id: "T-A", role: "executor", owner_id: "holder-a", change_id: NO_CHANGE_ID }, client, dataDir);
  const f2 = await claimTask({ project_id: FORGED, task_id: "T-D", role: "executor", owner_id: "holder-d", change_id: NO_CHANGE_ID }, client, dataDir);
  ok(
    isOk(f1) && isOk(f2) && usageOf(FORGED) === 2,
    "⑤-0 环境：T-A(holder-a)/T-D(holder-d) 真认领成功，用量 2 = 上限（exhausted）",
    { f1: isOk(f1), f2: isOk(f2), usage: usageOf(FORGED) },
  );
  const holderAToken = readTaskStates(workOf(FORGED)).states["T-A"]?.claim_token ?? "";
  const holderDToken = readTaskStates(workOf(FORGED)).states["T-D"]?.claim_token ?? "";
  ok(holderAToken !== "" && holderDToken !== "", "⑤-0b 环境：取到两张卡的当前认领 token（真实续约与身份变体的前提）");

  // ⑤-1 从未被认领的任务：伪造 renew 被拒（renew_not_verified），零字节、不落 budget.blocked、计数不涨
  const neverB = await submitErrA(() => client.submit(rawRenewCmd({ taskId: "T-B", rev: revOf("T-B"), key: "c017v-frg-tb-1", actor: "mallory", owner: "mallory", token: "clm-forged-T-B" })));
  const neverC = await submitErrA(() => client.submit(rawRenewCmd({ taskId: "T-C", rev: revOf("T-C"), key: "c017v-frg-tc-1", actor: "mallory", owner: "mallory", token: "clm-forged-T-C" })));
  ok(
    neverB.code === "INVALID_COMMAND" &&
      neverB.detail.reason === FORGED_RENEW_DETAIL_REASON &&
      String((neverB.detail.failures as string[])?.[0]).includes("没有有效认领") &&
      neverC.code === "INVALID_COMMAND" &&
      neverC.detail.reason === FORGED_RENEW_DETAIL_REASON &&
      claimedCountOf("task:T-B") === 0 &&
      claimedCountOf("task:T-C") === 0 &&
      usageOf(FORGED) === 2 &&
      blockedOf(FORGED).length === 0,
    "⑤-1 伪造 renew 投从未认领的 T-B/T-C：renew_not_verified 拒（点名没有有效认领）、零 task.claimed 落盘、计数不涨、不落 budget.blocked（伪造拒绝与预算拒绝分清）",
    { neverB, neverC, usage: usageOf(FORGED), blocked: blockedOf(FORGED).length },
  );
  const neverBRetry = await submitErrA(() => client.submit(rawRenewCmd({ taskId: "T-B", rev: revOf("T-B"), key: "c017v-frg-tb-1", actor: "mallory", owner: "mallory", token: "clm-forged-T-B" })));
  ok(
    neverBRetry.code === "INVALID_COMMAND" &&
      neverBRetry.detail.reason === FORGED_RENEW_DETAIL_REASON &&
      claimedCountOf("task:T-B") === 0 &&
      usageOf(FORGED) === 2,
    "⑤-1b 同一伪造命令重发：仍被拒、仍零字节（被拒命令不产生任何幂等/留证痕迹）",
    neverBRetry,
  );

  // ⑤-2 身份三项逐项核验（T-A 是 holder-a 的有效认领；预算已 exhausted，伪造拒绝与预算无关）
  const wrongTok = await submitErrA(() => client.submit(rawRenewCmd({ taskId: "T-A", rev: revOf("T-A"), key: "c017v-frg-ta-wrongtok", actor: "holder-a", owner: "holder-a", token: "clm-WRONG" })));
  const wrongOwner = await submitErrA(() => client.submit(rawRenewCmd({ taskId: "T-A", rev: revOf("T-A"), key: "c017v-frg-ta-wrongowner", actor: "holder-a", owner: "mallory", token: holderAToken })));
  const wrongActor = await submitErrA(() => client.submit(rawRenewCmd({ taskId: "T-A", rev: revOf("T-A"), key: "c017v-frg-ta-wrongactor", actor: "mallory", owner: "holder-a", token: holderAToken })));
  ok(
    wrongTok.code === "INVALID_COMMAND" &&
      wrongTok.detail.reason === FORGED_RENEW_DETAIL_REASON &&
      (wrongTok.detail.failures as string[])?.some((f) => f.includes("token 不一致")) === true &&
      wrongOwner.detail.reason === FORGED_RENEW_DETAIL_REASON &&
      (wrongOwner.detail.failures as string[])?.some((f) => f.includes("owner_id")) === true &&
      wrongActor.detail.reason === FORGED_RENEW_DETAIL_REASON &&
      (wrongActor.detail.failures as string[])?.some((f) => f.includes("actor_id")) === true &&
      claimedCountOf("task:T-A") === 1 &&
      usageOf(FORGED) === 2,
    "⑤-2 身份核验逐项：token 错/owner 错/actor 错各自点名拒绝（只有持有者能续自己那一次认领，§6.5），T-A 仍只有最初 1 条认领",
    { wrongTok, wrongOwner, wrongActor },
  );

  // ⑤-3 真实 renewClaim：已有合法认领时在预算耗尽下仍续约成功，计数不多算、租约延长
  const leaseBefore = readTaskStates(workOf(FORGED)).states["T-A"]?.lease_expires_at ?? "";
  const realRenew = await renewClaim(
    { project_id: FORGED, task_id: "T-A", role: "executor", owner_id: "holder-a", change_id: NO_CHANGE_ID, claim_token: holderAToken, expected_revision: revOf("T-A") ?? 0 },
    client,
    dataDir,
  );
  ok(
    isOk(realRenew) &&
      usageOf(FORGED) === 2 &&
      claimedCountOf("task:T-A") === 2 &&
      String((realRenew as { claim?: { lease_expires_at?: string } }).claim?.lease_expires_at ?? "") > leaseBefore,
    "⑤-3 真实 renewClaim 在预算耗尽下续约通过（用量仍 2、租约延长、落 1 条 claim_action=renew）",
    { ok: isOk(realRenew), usage: usageOf(FORGED), leaseBefore, leaseAfter: (realRenew as { claim?: { lease_expires_at?: string } }).claim?.lease_expires_at ?? null },
  );

  // ⑤-4 手写但字段与事件现场全对的持有者续约（不经 renewClaim）：核实放行——边界认事实不认调用库
  const rawGenuine = await client.submit(rawRenewCmd({ taskId: "T-A", rev: revOf("T-A"), key: "c017v-frg-ta-genuine", actor: "holder-a", owner: "holder-a", token: holderAToken }));
  ok(
    rawGenuine.ok === true && usageOf(FORGED) === 2 && claimedCountOf("task:T-A") === 3,
    "⑤-4 手写真实续约（token/owner/actor 与现场一致）同样放行：核实的是事实不是调用库；计数仍不多算",
    { ok: rawGenuine.ok, usage: usageOf(FORGED) },
  );

  // ⑤-5 释放之后旧 token 的"续约"：边界按"没有有效认领"拒；renewClaim 自身契约不变（NOT_CLAIMABLE）
  const rel = await releaseClaim(
    { project_id: FORGED, task_id: "T-A", role: "executor", owner_id: "holder-a", change_id: NO_CHANGE_ID, claim_token: holderAToken, expected_revision: revOf("T-A") ?? 0 },
    client,
    dataDir,
  );
  const afterRelease = await submitErrA(() => client.submit(rawRenewCmd({ taskId: "T-A", rev: revOf("T-A"), key: "c017v-frg-ta-afterrelease", actor: "holder-a", owner: "holder-a", token: holderAToken })));
  const renewAfterRelease = await renewClaim(
    { project_id: FORGED, task_id: "T-A", role: "executor", owner_id: "holder-a", change_id: NO_CHANGE_ID, claim_token: holderAToken, expected_revision: revOf("T-A") ?? 0 },
    client,
    dataDir,
  );
  ok(
    isOk(rel) &&
      afterRelease.code === "INVALID_COMMAND" &&
      afterRelease.detail.reason === FORGED_RENEW_DETAIL_REASON &&
      (afterRelease.detail.failures as string[])?.some((f) => f.includes("没有有效认领")) === true &&
      !isOk(renewAfterRelease) &&
      (renewAfterRelease as { code?: string }).code === "NOT_CLAIMABLE" &&
      claimedCountOf("task:T-A") === 3 &&
      usageOf(FORGED) === 2,
    "⑤-5 释放后：旧 token 的手写 renew 被边界按'没有有效认领'拒（零字节）；renewClaim 仍按自身契约 NOT_CLAIMABLE；release/claim 历史口径稳定（usage 2）",
    { rel: isOk(rel), afterRelease, renewClaimCode: (renewAfterRelease as { code?: string }).code },
  );

  // ⑤-6 已交付任务的"续约"：事件状态核验（result_submitted 后没有进行中认领可续）
  const resultReceipt = await client.submit({
    schema_version: SCHEMA_VERSION,
    project_id: FORGED,
    change_id: NO_CHANGE_ID,
    entity_id: "task:T-D",
    expected_revision: revOf("T-D"),
    type: "task.result_submitted",
    actor_id: "holder-d",
    role: "executor",
    idempotency_key: "c017v-frg-td-result",
    payload: {
      claim_token: holderDToken,
      owner_id: "holder-d",
      owner_role: "executor",
      run_id: "run-T-D-1",
      attempt_id: "att-T-D-1",
      deliverables: [],
      evidence_refs: [],
      verification: [],
      untested: [],
      known_issues: [],
      diff_ref: null,
      result_revision: null,
      meaning: "执行者已提交结果；不表示审计通过或人工验收接受",
    },
  });
  const afterResult = await submitErrA(() => client.submit(rawRenewCmd({ taskId: "T-D", rev: revOf("T-D"), key: "c017v-frg-td-afterresult", actor: "holder-d", owner: "holder-d", token: holderDToken })));
  const renewAfterResult = await renewClaim(
    { project_id: FORGED, task_id: "T-D", role: "executor", owner_id: "holder-d", change_id: NO_CHANGE_ID, claim_token: holderDToken, expected_revision: revOf("T-D") ?? 0 },
    client,
    dataDir,
  );
  ok(
    resultReceipt.ok === true &&
      afterResult.code === "INVALID_COMMAND" &&
      afterResult.detail.reason === FORGED_RENEW_DETAIL_REASON &&
      (afterResult.detail.failures as string[])?.some((f) => f.includes("不是认领/执行中")) === true &&
      !isOk(renewAfterResult) &&
      (renewAfterResult as { code?: string }).code === "NOT_CLAIMABLE" &&
      claimedCountOf("task:T-D") === 1 &&
      usageOf(FORGED) === 2,
    "⑤-6 交付后：任务状态 result_submitted 的手写 renew 被边界按'不是认领/执行中'拒（零字节）；renewClaim 契约不变",
    { result: resultReceipt.ok, afterResult, renewClaimCode: (renewAfterResult as { code?: string }).code },
  );

  // ⑤-7/⑤-8 从未导入定义的任务 / 非任务实体：存在性与实体形态核验（修复前两者都能落盘，见 probe-before.txt）
  const noDef = await submitErrA(() => client.submit(rawRenewCmd({ taskId: "T-Z", rev: 0, key: "c017v-frg-tz-1", actor: "mallory", owner: "mallory", token: "clm-forged-T-Z" })));
  const notTask = await submitErrA(() => client.submit(rawRenewCmd({ taskId: "x", rev: 0, key: "c017v-frg-note-1", actor: "mallory", owner: "mallory", token: "clm-forged-x", entity: "note:x" })));
  ok(
    noDef.code === "INVALID_COMMAND" &&
      noDef.detail.reason === FORGED_RENEW_DETAIL_REASON &&
      claimedCountOf("task:T-Z") === 0 &&
      notTask.code === "INVALID_COMMAND" &&
      notTask.detail.reason === FORGED_RENEW_DETAIL_REASON &&
      (notTask.detail.failures as string[])?.some((f) => f.includes("实体必须是 task:")) === true &&
      claimedCountOf("note:x") === 0 &&
      usageOf(FORGED) === 2,
    "⑤-7/⑤-8 无定义任务 T-Z 与非任务实体 note:x 的自报 renew 均被 renew_not_verified 拒（零字节、计数不涨）",
    { noDef, notTask },
  );

  // ⑤-9 claim_action 拼写变体按首次认领处理（精确匹配 "renew" 才进入续约核实）：落到预算门禁
  const variant1 = await submitErrA(() => client.submit(rawRenewCmd({ taskId: "T-B", rev: revOf("T-B"), key: "c017v-frg-tb-variant-cap", actor: "case-writer", owner: "case-writer", token: "clm-case-b", action: "Renew" })));
  const variant2 = await submitErrA(() => client.submit(rawRenewCmd({ taskId: "T-C", rev: revOf("T-C"), key: "c017v-frg-tc-variant-space", actor: "case-writer", owner: "case-writer", token: "clm-case-c", action: "renew " })));
  ok(
    variant1.code === "INVALID_COMMAND" &&
      variant1.detail.reason === "budget_exhausted" &&
      variant2.code === "INVALID_COMMAND" &&
      variant2.detail.reason === "budget_exhausted" &&
      claimedCountOf("task:T-B") === 0 &&
      claimedCountOf("task:T-C") === 0 &&
      blockedOf(FORGED).length === 2 &&
      usageOf(FORGED) === 2,
    '⑤-9 claim_action 变体（"Renew"/"renew "）不当续约：按首次认领进预算门禁，budget_exhausted 拒并各落 1 条留证（恰 2 条）',
    { variant1, variant2, blocked: blockedOf(FORGED).length },
  );

  // ⑤-10 countTaskClaims 流式核实：合法历史逐条一致（口径稳定），伪造输入按认领计（fail-safe）
  let synSeq = 0;
  const synEv = (entityId: string, type: string, payload: Record<string, unknown>): WorkEvent => {
    synSeq += 1;
    return {
      schema_version: SCHEMA_VERSION,
      event_id: `syn-${synSeq}`,
      project_id: "syn",
      change_id: NO_CHANGE_ID,
      entity_id: entityId,
      entity_revision: synSeq,
      seq: synSeq,
      type,
      actor_id: "syn",
      role: "executor",
      occurred_at: "2026-09-21T00:00:00+08:00",
      received_at: "2026-09-21T00:00:00+08:00",
      idempotency_key: `syn-${synSeq}`,
      payload,
    };
  };
  const claimP = (tok: string): Record<string, unknown> => ({ claim_action: "claim", owner_id: "h", claim_token: tok, lease_expires_at: "2026-09-21T01:00:00+08:00" });
  const renewP = (tok: string): Record<string, unknown> => ({ claim_action: "renew", owner_id: "h", claim_token: tok, lease_expires_at: "2026-09-21T02:00:00+08:00" });
  const countCases: { label: string; events: WorkEvent[]; want: number }[] = [
    { label: "真续约不多算", events: [synEv("task:T-1", "task.claimed", claimP("tok1")), synEv("task:T-1", "task.claimed", renewP("tok1"))], want: 1 },
    { label: "执行中（executing）真续约不多算", events: [synEv("task:T-1", "task.claimed", claimP("tok1")), synEv("task:T-1", "task.status_changed", { status: "executing" }), synEv("task:T-1", "task.claimed", renewP("tok1"))], want: 1 },
    { label: "从未认领的伪造 renew 按认领计", events: [synEv("task:T-1", "task.claimed", claimP("tok1")), synEv("task:T-2", "task.claimed", renewP("tok2"))], want: 2 },
    { label: "token 不符的伪造 renew 按认领计", events: [synEv("task:T-1", "task.claimed", claimP("tok1")), synEv("task:T-1", "task.claimed", renewP("tokWRONG"))], want: 2 },
    { label: "释放后的 renew 按认领计", events: [synEv("task:T-1", "task.claimed", claimP("tok1")), synEv("task:T-1", "task.status_changed", { status: "ready", claim_released: true }), synEv("task:T-1", "task.claimed", renewP("tok1"))], want: 2 },
    { label: "交付后的 renew 按认领计", events: [synEv("task:T-1", "task.claimed", claimP("tok1")), synEv("task:T-1", "task.result_submitted", {}), synEv("task:T-1", "task.claimed", renewP("tok1"))], want: 2 },
    { label: "非任务实体的自报 renew 按认领计", events: [synEv("note:x", "task.claimed", renewP("tok1"))], want: 1 },
  ];
  const countBad = countCases.filter((c) => countTaskClaims(c.events) !== c.want);
  ok(
    countBad.length === 0,
    "⑤-10 countTaskClaims 流式核实：真续约（claimed/executing）不多算；伪造（无认领/token 错/已释放/已交付/非任务实体）按认领计",
    countBad.map((c) => ({ label: c.label, got: countTaskClaims(c.events), want: c.want })),
  );

  // ⑤-11 回炉项目重放：伪造拒绝零字节 ⇒ 事件流只有真认领/真续约/释放/交付/留证，结构不变量成立
  {
    const { events } = loadEvents(workOf(FORGED));
    let replayError: string | null = null;
    try {
      buildSnapshot(FORGED, events, null);
    } catch (e) {
      replayError = e instanceof WorkError ? `${e.code}: ${e.message}` : String(e);
    }
    const repaired = service.repair(FORGED);
    ok(
      replayError === null &&
        repaired.snapshot !== null &&
        repaired.snapshot.last_seq === events.length &&
        usageOf(FORGED) === 2 &&
        events.filter((e) => e.type === "task.claimed").length === 4 &&
        !events.some((e) => e.type === "task.claimed" && ["task:T-B", "task:T-C", "task:T-Z", "note:x"].includes(e.entity_id)),
      `⑤-11 重放 ${FORGED}：伪造尝试零字节（task.claimed 恰 4 条＝T-A claim/双 renew + T-D claim），usage 2，重放/repair 结构不变量成立（last_seq=${events.length}）`,
      { replayError, last_seq: repaired.snapshot?.last_seq ?? null, events: events.length, usage: usageOf(FORGED) },
    );
  }

  // ── 收尾（只关临时 HTTP、摘服务描述符、删夹具） ──
  removeServiceDescriptor(dataDir);
  await new Promise<void>((resolve) => server.close(() => resolve()));
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
      removeServiceDescriptor(dataDir);
      fs.rmSync(base, { recursive: true, force: true });
    } catch {
      // 清理失败不改结论
    }
    process.exitCode = 1;
  });
