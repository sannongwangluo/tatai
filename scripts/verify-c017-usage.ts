// C017 用量统计（验收组②）验证：GET /api/projects/:id/work/usage 只读端点。
// 用法：pnpm verify:c017-usage（或 npx tsx scripts/verify-c017-usage.ts）
//
// 两组验收互不冒充（PLAN.md 2026-09-21 契约对齐登记 C017）：
//   · 组① 配额节流行为（配置生效、超限拒绝留证、近阈值提示）由既有 verify:budget（37 断言）与
//     verify:c017-budget-race（36 断言）守门——本脚本**不复测认领拒绝本身**，只测组② 用量统计
//     （来源可核对 / 未计量如实标注），两组成员分明。
//   · 本脚本覆盖（卡面 → 断言映射）：
//     ① claim_quota：usage 与**独立复算**的 countTaskClaims（budget.ts 同一函数）逐项目一致；
//        max/remaining/near_threshold 三形态（near / exhausted / 不限）互不冒充；unit/source 逐字常量；
//     ② durations：task.claimed → execution.delivered 配对毫秒与夹具时间戳**精确一致**；
//        真实续约不多算一条 item；未完结如实标「进行中/无来源」且不计毫秒；配不到的 delivered 如实计数；
//     ③ token / cost：value 恰为 null、label 恰为「未计量」、reason 非空说明为什么；
//     ④ 整份应答 JSON 扫描：无「金额/费用/单价/成本/计费」字样（配额数字不被表述为费用）；
//        claim_quota 块没有任何 fee/cost/price/amount 形字段名；
//     ⑤ 只读红线：GET 前后 events.jsonl / budget.json 逐字节不变；完整 claim_token 不外发（只给预览）。
//
// 隔离（AGENTS.md §5）：mkdtemp 夹具 + 独立 TATAI_HOME + 随机端口临时后端子进程；
// 不碰真实 TATAI_HOME/真实项目、不调模型（DEEPSEEK_API_KEY 置空）；收尾杀净子进程、整棵删。
import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { countTaskClaims } from "../src/server/work/budget";
import { loadEvents } from "../src/server/work/eventStore";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── 隔离夹具（临时目录；收尾整棵删）──
const base = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-c017-usage-"));
const dataDir = path.join(base, "home");
fs.mkdirSync(dataDir, { recursive: true });

const NEAR = "c017u-near"; // 4 认领 / 上限 5 / ratio 0.8 → near，剩 1
const FULL = "c017u-full"; // 2 认领 / 上限 2 → exhausted，剩 0（含一条 budget.blocked 留证）
const OPEN = "c017u-open"; // max_task_claims:null → 不限
const EMPTY = "c017u-empty"; // 无 budget.json、无事件流 → 全空如实空态
const WEIRD = "c017u-weird"; // entity_id="foo" 的 task.claimed（通用写口可直写的病态事件）：usage 与 claim_actions 必须同为 1
const PROJECTS = [NEAR, FULL, OPEN, EMPTY, WEIRD];
const rootOf = (id: string): string => path.join(base, id);
const workOf = (id: string): string => path.join(rootOf(id), ".工作台", "work");

const T0 = Date.parse("2026-09-21T02:00:00.000Z");
const at = (msOffset: number): string => new Date(T0 + msOffset).toISOString();

interface EvSpec {
  entity: string;
  rev: number;
  type: string;
  at: string;
  payload?: Record<string, unknown>;
}

/** 手写一行合法事件（seq/entity_revision/idempotency_key 都按重放不变量排好） */
function writeEvents(projectId: string, specs: EvSpec[]): void {
  fs.mkdirSync(workOf(projectId), { recursive: true });
  const lines = specs.map((s, i) =>
    JSON.stringify({
      schema_version: 2,
      event_id: `ev-${projectId}-${i + 1}`,
      project_id: projectId,
      change_id: "chg-fixture",
      entity_id: s.entity,
      entity_revision: s.rev,
      seq: i + 1,
      type: s.type,
      actor_id: "fixture",
      role: "executor",
      occurred_at: s.at,
      received_at: s.at,
      idempotency_key: `fx-${projectId}-${i + 1}`,
      payload: s.payload ?? {},
    }),
  );
  fs.writeFileSync(path.join(workOf(projectId), "events.jsonl"), lines.join("\n") + "\n", "utf8");
}

const claimPayload = (
  token: string,
  owner: string,
  action: "claim" | "renew",
  runId: string,
  attemptId: string,
  attempt: number,
): Record<string, unknown> => ({
  claim_action: action,
  owner_id: owner,
  owner_role: "executor",
  run_id: runId,
  attempt_id: attemptId,
  attempt,
  claim_token: token,
  lease_expires_at: at(3_600_000),
  workspace: path.join(base, "ws"),
  takeover_basis: null,
});

const deliveredPayload = (taskId: string, token: string, runId: string, attemptId: string): Record<string, unknown> => ({
  task_id: taskId,
  run_id: runId,
  attempt_id: attemptId,
  attempt: 1,
  claim_token: token,
  owner_id: "alice",
  coordinator_id: "coord-fixture",
  client_id: "fixture-client",
  model: null,
  effort: null,
  workspace: path.join(base, "ws"),
  parent_execution_id: null,
  parent_run_id: null,
  result_summary: "夹具交付",
});

// 完整 token 值：断言「应答不外发完整凭证」用（预览只给前 8 位）
const TOK_A1 = "tokA1-secret-00000001";
const TOK_D1 = "tokD1-secret-00000002";

// ── NEAR：4 条认领动作（T-A 交付 90000ms / T-B 进行中 / T-C 释放后无来源 / T-D 真实续约后交付 120000ms）──
writeEvents(NEAR, [
  { entity: "task:T-A", rev: 1, type: "task.claimed", at: at(0), payload: claimPayload(TOK_A1, "alice", "claim", "run-1", "a1", 1) },
  { entity: "execution:ex-T-A-a1", rev: 1, type: "execution.delivered", at: at(90_000), payload: deliveredPayload("T-A", TOK_A1, "run-1", "a1") },
  { entity: "task:T-B", rev: 1, type: "task.claimed", at: at(100_000), payload: claimPayload("tokB1-secret-00000003", "bob", "claim", "run-1", "a1", 1) },
  { entity: "task:T-C", rev: 1, type: "task.claimed", at: at(110_000), payload: claimPayload("tokC1-secret-00000004", "carol", "claim", "run-1", "a1", 1) },
  { entity: "task:T-C", rev: 2, type: "task.status_changed", at: at(115_000), payload: { status: "preparing", claim_released: true } },
  { entity: "task:T-D", rev: 1, type: "task.claimed", at: at(120_000), payload: claimPayload(TOK_D1, "dave", "claim", "run-1", "a1", 1) },
  // 真实续约（同 token、状态仍 claimed）：计数与耗时 item 都不多算一条
  { entity: "task:T-D", rev: 2, type: "task.claimed", at: at(180_000), payload: claimPayload(TOK_D1, "dave", "renew", "run-1", "a1", 1) },
  { entity: "execution:ex-T-D-a1", rev: 1, type: "execution.delivered", at: at(240_000), payload: deliveredPayload("T-D", TOK_D1, "run-1", "a1") },
]);
fs.writeFileSync(path.join(workOf(NEAR), "budget.json"), JSON.stringify({ max_task_claims: 5, near_threshold_ratio: 0.8 }));

// ── FULL：2 认领顶满 + 一条 budget.blocked 留证（不影响计数）──
writeEvents(FULL, [
  { entity: "task:T-X", rev: 1, type: "task.claimed", at: at(0), payload: claimPayload("tokX1-secret-00000005", "alice", "claim", "run-1", "a1", 1) },
  { entity: "execution:ex-T-X-a1", rev: 1, type: "execution.delivered", at: at(45_000), payload: deliveredPayload("T-X", "tokX1-secret-00000005", "run-1", "a1") },
  { entity: "task:T-Y", rev: 1, type: "task.claimed", at: at(60_000), payload: claimPayload("tokY1-secret-00000006", "bob", "claim", "run-1", "a1", 1) },
  {
    entity: `budget:${FULL}`,
    rev: 1,
    type: "budget.blocked",
    at: at(61_000),
    payload: { usage: 2, max: 2, task_id: "T-Z", reason: "达到项目预算约束上限（§5.7：达到约束不是省略验证的理由）" },
  },
]);
fs.writeFileSync(path.join(workOf(FULL), "budget.json"), JSON.stringify({ max_task_claims: 2, near_threshold_ratio: 0.8 }));

// ── OPEN：max_task_claims:null（不限）；另造一条配不到认领的 delivered（如实计数，不悄悄丢）──
writeEvents(OPEN, [
  { entity: "task:T-M", rev: 1, type: "task.claimed", at: at(0), payload: claimPayload("tokM1-secret-00000007", "alice", "claim", "run-1", "a1", 1) },
  { entity: "execution:ex-T-M-a1", rev: 1, type: "execution.delivered", at: at(30_000), payload: deliveredPayload("T-M", "tokM1-secret-00000007", "run-1", "a1") },
  { entity: "execution:ex-orphan-a1", rev: 1, type: "execution.delivered", at: at(40_000), payload: deliveredPayload("T-N", "tok-nope-00000008", "run-9", "a1") },
]);
fs.writeFileSync(path.join(workOf(OPEN), "budget.json"), JSON.stringify({ max_task_claims: null }));

// ── EMPTY：只建目录（无 budget.json、无 events.jsonl）──
fs.mkdirSync(workOf(EMPTY), { recursive: true });

// ── WEIRD：一条 entity_id="foo" 的 task.claimed（通用写口直写都能落盘的病态形态）──
// countTaskClaims 照数它（fail-safe），durations 也必须计为一条认领动作（F-04 同口径回归）
writeEvents(WEIRD, [
  { entity: "foo", rev: 1, type: "task.claimed", at: at(0), payload: claimPayload("tokW1-secret-00000009", "wally", "claim", "run-1", "a1", 1) },
]);

for (const id of PROJECTS) {
  fs.writeFileSync(path.join(rootOf(id), ".工作台", "design.md"), `# ${id} 夹具设计书\n`);
}
fs.writeFileSync(
  path.join(dataDir, "registry.json"),
  JSON.stringify({
    version: 1,
    projects: PROJECTS.map((id) => ({
      id,
      name: id,
      path: rootOf(id),
      kind: "backend",
      registered_at: "2026-09-21T00:00:00+08:00",
    })),
  }),
);

// ── 后端子进程（随机端口；DEEPSEEK_API_KEY 置空：本脚本零模型调用）──
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

interface ApiBody {
  ok?: boolean;
  usage?: Record<string, unknown>;
  error?: { code?: string; message?: string };
  [k: string]: unknown;
}

let server: ChildProcess | null = null;
let port = 0;

async function api(pathname: string): Promise<{ status: number; body: ApiBody; raw: string }> {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`);
  const raw = await res.text();
  let body: ApiBody = {};
  try {
    body = JSON.parse(raw) as ApiBody;
  } catch {
    body = { parse_error: raw.slice(0, 200) };
  }
  return { status: res.status, body, raw };
}

const sha256File = (file: string): string => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
/** 禁用字样（卡面：任何字段不得出现金额/费用/单价表述；成本/计费同禁——应答里一个都不许有） */
const BANNED = ["金额", "费用", "单价", "成本", "计费"];
const bannedHits = (raw: string): string[] => BANNED.filter((w) => raw.includes(w));

async function main(): Promise<void> {
  port = await freePort();
  server = spawn("node", ["--import", "tsx", path.join("src", "server", "index.ts")], {
    cwd: REPO,
    env: { ...process.env, TATAI_HOME: dataDir, TATAI_PORT: String(port), DEEPSEEK_API_KEY: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const serverLog: string[] = [];
  server.stdout?.on("data", (d: Buffer) => serverLog.push(d.toString("utf8")));
  server.stderr?.on("data", (d: Buffer) => serverLog.push(d.toString("utf8")));

  // 等 /health 就绪（后端进程早退直接失败并贴日志）
  const deadline = Date.now() + 90_000;
  for (;;) {
    if (server.exitCode !== null) {
      throw new Error(`后端进程早退（exit ${server.exitCode}）：\n${serverLog.join("").slice(-2000)}`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
      if (res.status === 200) break;
    } catch {
      // 未就绪，继续等
    }
    if (Date.now() > deadline) throw new Error(`后端 90s 未就绪：\n${serverLog.join("").slice(-2000)}`);
    await sleep(300);
  }
  info(`后端就绪：http://127.0.0.1:${port}（隔离 TATAI_HOME=${dataDir}）`);

  // 只读红线对照基准：GET 前把 events.jsonl / budget.json 哈希记下来
  const hashBefore = new Map<string, string>();
  for (const id of [NEAR, FULL, OPEN]) {
    hashBefore.set(`${id}:events`, sha256File(path.join(workOf(id), "events.jsonl")));
    hashBefore.set(`${id}:budget`, sha256File(path.join(workOf(id), "budget.json")));
  }

  // ══════════ ① 四个项目端点可达、形态齐全 ══════════
  info("── ① 端点 200 + ok，四个夹具项目（near / exhausted / 不限 / 全空）");
  const resp = new Map<string, { status: number; body: ApiBody; raw: string }>();
  for (const id of PROJECTS) {
    const r = await api(`/api/projects/${encodeURIComponent(id)}/work/usage`);
    resp.set(id, r);
    ok(r.status === 200 && r.body.ok === true && typeof r.body.usage === "object", `① ${id}：GET work/usage → 200 ok`);
  }
  const notFound = await api(`/api/projects/c017u-no-such/work/usage`);
  ok(
    notFound.status === 404 && notFound.body.ok === false && notFound.body.error?.code === "PROJECT_NOT_FOUND",
    `① 不存在的项目 → 404 PROJECT_NOT_FOUND（不假装是空项目）`,
    notFound.body,
  );

  const usageOf = (id: string): Record<string, unknown> => resp.get(id)!.body.usage!;
  const quotaOf = (id: string): Record<string, unknown> => usageOf(id).claim_quota as Record<string, unknown>;
  const durationsOf = (id: string): Record<string, unknown> => usageOf(id).durations as Record<string, unknown>;
  const itemsOf = (id: string): Record<string, unknown>[] => durationsOf(id).items as Record<string, unknown>[];
  const itemOf = (id: string, taskId: string): Record<string, unknown> | undefined =>
    itemsOf(id).find((i) => i.task_id === taskId);

  // ══════════ ② claim_quota：usage 与独立复算的 countTaskClaims 逐项目一致（同一函数对账）══════════
  info("── ② claim_quota.usage == 独立 countTaskClaims(loadEvents(...))（复用同一口径，不另造）");
  const expectedUsage: Record<string, number> = {};
  for (const id of PROJECTS) {
    expectedUsage[id] = countTaskClaims(loadEvents(workOf(id)).events);
  }
  ok(expectedUsage[NEAR] === 4 && expectedUsage[FULL] === 2 && expectedUsage[OPEN] === 1 && expectedUsage[EMPTY] === 0 && expectedUsage[WEIRD] === 1,
    `② 夹具自洽：countTaskClaims 独立复算 = near 4 / full 2 / open 1 / empty 0 / weird 1（非 task: 实体认领照数）`, expectedUsage);
  for (const id of PROJECTS) {
    ok(
      quotaOf(id).usage === expectedUsage[id],
      `② ${id}：端点 usage（${String(quotaOf(id).usage)}）== 事件流独立复算（${expectedUsage[id]}）`,
    );
  }

  // ══════════ ③ claim_quota 三形态互不冒充 ══════════
  info("── ③ 近阈值 / 超限 / 不限三形态（与组①「拒绝行为」无关，只看统计形态如实）");
  ok(
    quotaOf(NEAR).max === 5 && quotaOf(NEAR).remaining === 1 &&
      quotaOf(NEAR).status === "near" && quotaOf(NEAR).near_threshold === true && quotaOf(NEAR).limited === true &&
      (quotaOf(NEAR).note as string).includes("剩余可认领 1 次"),
    `③ near 形态：4/5 → status=near、near_threshold=true、剩余 1（note 如实报剩余）`,
    quotaOf(NEAR),
  );
  ok(
    quotaOf(FULL).max === 2 && quotaOf(FULL).remaining === 0 &&
      quotaOf(FULL).status === "exhausted" && quotaOf(FULL).near_threshold === false && quotaOf(FULL).limited === true &&
      (quotaOf(FULL).note as string).includes("剩余可认领 0 次"),
    `③ exhausted 形态：2/2 → status=exhausted、near_threshold=false、剩余 0（不冒充 near，near 也不冒充它）`,
    quotaOf(FULL),
  );
  ok(
    quotaOf(OPEN).max === null && quotaOf(OPEN).remaining === null &&
      quotaOf(OPEN).status === "ok" && quotaOf(OPEN).near_threshold === false && quotaOf(OPEN).limited === false &&
      (quotaOf(OPEN).note as string).includes("不限"),
    `③ 不限形态：max=null → remaining=null、note 如实「不限」（不编造上限数字）`,
    quotaOf(OPEN),
  );
  ok(
    quotaOf(EMPTY).usage === 0 && quotaOf(EMPTY).max === null && quotaOf(EMPTY).remaining === null,
    `③ 全空项目：无 budget.json → 不限，usage=0（如实空态，不 500）`,
    quotaOf(EMPTY),
  );
  ok(
    quotaOf(NEAR).unit === "认领次数" && quotaOf(NEAR).source === "work 事件流确定性计数（events.jsonl）",
    `③ unit=「认领次数」、source 逐字=「work 事件流确定性计数（events.jsonl）」`,
    { unit: quotaOf(NEAR).unit, source: quotaOf(NEAR).source },
  );
  ok(
    typeof quotaOf(NEAR).meaning === "string" && (quotaOf(NEAR).meaning as string).includes("运营节流") &&
      (quotaOf(NEAR).meaning as string).includes("不代表任何实耗"),
    `③ 口径声明在场：运营节流、不代表任何实耗`,
    quotaOf(NEAR).meaning,
  );

  // ══════════ ④ durations：配对毫秒精确 + 未完结不造假 + 续约不多算 ══════════
  info("── ④ durations：task.claimed → execution.delivered 配对（received_at 之差）");
  ok(
    (durationsOf(NEAR).source as string).includes("received_at") && durationsOf(NEAR).unit === "毫秒",
    `④ durations.source 写明事件时间戳（received_at）依据，unit=毫秒`,
    durationsOf(NEAR).source,
  );
  ok(
    itemsOf(NEAR).length === 4,
    `④ NEAR 恰 4 条 item：T-D 的真实续约不多算一条（与 countTaskClaims 同口径）`,
    itemsOf(NEAR).map((i) => `${String(i.task_id)}@${String(i.claimed_seq)}`),
  );
  const ta = itemOf(NEAR, "T-A");
  ok(
    ta !== undefined && ta.status === "delivered" && ta.duration_ms === 90_000 &&
      ta.claimed_seq === 1 && ta.delivered_seq === 2 &&
      ta.claimed_at === at(0) && ta.delivered_at === at(90_000) && ta.note === null,
    `④ T-A 配对精确：90000ms（认领 seq1 → 交付 seq2，两端 received_at 逐字一致）`,
    ta,
  );
  const tb = itemOf(NEAR, "T-B");
  ok(
    tb !== undefined && tb.status === "in_progress" && tb.duration_ms === null && tb.delivered_seq === null &&
      (tb.status_label as string).includes("进行中"),
    `④ T-B 未完结：status=in_progress、标「进行中」、不计毫秒（不造假）`,
    tb,
  );
  const tc = itemOf(NEAR, "T-C");
  ok(
    tc !== undefined && tc.status === "no_source" && tc.duration_ms === null && tc.delivered_seq === null &&
      (tc.status_label as string).includes("无来源"),
    `④ T-C 认领已释放、无交付回执：status=no_source、标「无来源」、不计毫秒`,
    tc,
  );
  const td = itemOf(NEAR, "T-D");
  ok(
    td !== undefined && td.status === "delivered" && td.duration_ms === 120_000 &&
      td.claimed_seq === 6 && td.delivered_seq === 8,
    `④ T-D 配到首次认领（seq6，续约 seq7 不顶位）：120000ms`,
    td,
  );
  const tx = itemOf(FULL, "T-X");
  ok(tx !== undefined && tx.duration_ms === 45_000 && itemOf(FULL, "T-Y")?.status === "in_progress",
    `④ FULL：T-X 45000ms、T-Y 进行中（budget.blocked 事件不被误当耗时来源）`, [tx, itemOf(FULL, "T-Y")]);
  ok(
    (durationsOf(OPEN).summary as Record<string, unknown>).unpaired_delivered_events === 1,
    `④ 配不到认领的 delivered（孤儿 ex-orphan）如实计数 1，不悄悄丢也不强配`,
    durationsOf(OPEN).summary,
  );
  ok(
    itemsOf(EMPTY).length === 0 &&
      (durationsOf(EMPTY).summary as Record<string, unknown>).claim_actions === 0,
    `④ 全空项目：items 空数组、summary 全 0（如实空态）`,
    durationsOf(EMPTY).summary,
  );
  // F-04 同口径回归（2026-09-21 收口审计）：非 task: 实体上的 task.claimed，配额计数与耗时条数不得漂移
  const weirdItem = itemOf(WEIRD, "foo");
  ok(
    quotaOf(WEIRD).usage === 1 &&
      (durationsOf(WEIRD).summary as Record<string, unknown>).claim_actions === 1 &&
      itemsOf(WEIRD).length === 1 &&
      weirdItem !== undefined &&
      weirdItem.status === "no_source" &&
      weirdItem.duration_ms === null,
    `④ WEIRD：entity_id="foo" 的 task.claimed → claim_quota.usage（${String(quotaOf(WEIRD).usage)}）== claim_actions（${String((durationsOf(WEIRD).summary as Record<string, unknown>).claim_actions)}）== 1，item 记原始实体 id 且不伪造毫秒`,
    { quota: quotaOf(WEIRD).usage, summary: durationsOf(WEIRD).summary, item: weirdItem },
  );
  const invariantBroken = PROJECTS.flatMap((id) =>
    itemsOf(id).filter((i) => (i.duration_ms === null) !== (i.delivered_seq === null) && i.note === null),
  );
  ok(invariantBroken.length === 0, `④ 不变量：无 delivered_seq 却给毫秒、或有配对却说不清原因的条目（全项目扫描）`);

  // ══════════ ⑤ token / cost：恰为「未计量」且 reason 非空 ══════════
  info("── ⑤ Token / 金额：缺可核对来源，显式标「未计量」（不设阈值、不设计价算法）");
  for (const id of PROJECTS) {
    const token = usageOf(id).token as Record<string, unknown>;
    const cost = usageOf(id).cost as Record<string, unknown>;
    ok(
      token.value === null && token.label === "未计量" && typeof token.reason === "string" && (token.reason as string).length > 0 &&
        cost.value === null && cost.label === "未计量" && typeof cost.reason === "string" && (cost.reason as string).length > 0,
      `⑤ ${id}：token/cost 恰为 {value:null, label:"未计量", reason:非空}`,
      { token, cost },
    );
  }
  ok(
    ((usageOf(NEAR).token as Record<string, unknown>).reason as string).includes("可核对的 Token 计数来源") ||
      ((usageOf(NEAR).token as Record<string, unknown>).reason as string).includes("可核对"),
    `⑤ token.reason 如实说明为什么（执行端无可核对来源）`,
    (usageOf(NEAR).token as Record<string, unknown>).reason,
  );
  ok(
    ((usageOf(NEAR).cost as Record<string, unknown>).reason as string).includes("不设阈值") &&
      ((usageOf(NEAR).cost as Record<string, unknown>).reason as string).includes("§1.4"),
    `⑤ cost.reason 如实说明为什么不计量（不设阈值、不设计价算法，§1.4/§5.7）`,
    (usageOf(NEAR).cost as Record<string, unknown>).reason,
  );

  // ══════════ ⑥ 表述巡检：整份应答无费用向字样；配额块无费用形字段名 ══════════
  info("── ⑥ 应答扫描：金额/费用/单价/成本/计费 零命中（配额数字不被表述为费用）");
  for (const id of PROJECTS) {
    ok(bannedHits(resp.get(id)!.raw).length === 0, `⑥ ${id}：整份应答 JSON 无禁用字样`, bannedHits(resp.get(id)!.raw));
  }
  ok(
    Object.keys(quotaOf(NEAR)).every((k) => !/cost|fee|price|amount|money/i.test(k)),
    `⑥ claim_quota 块字段名无 cost/fee/price/amount/money 形（配额与费用不同框）`,
    Object.keys(quotaOf(NEAR)),
  );

  // ══════════ ⑦ 只读红线与凭证边界 ══════════
  info("── ⑦ 只读红线：GET 后事件与配置逐字节不变；完整 claim_token 不外发");
  for (const id of [NEAR, FULL, OPEN]) {
    ok(
      sha256File(path.join(workOf(id), "events.jsonl")) === hashBefore.get(`${id}:events`) &&
        sha256File(path.join(workOf(id), "budget.json")) === hashBefore.get(`${id}:budget`),
      `⑦ ${id}：GET 前后 events.jsonl / budget.json 哈希不变（端点零写入）`,
    );
  }
  ok(
    !resp.get(NEAR)!.raw.includes(TOK_A1) && !resp.get(NEAR)!.raw.includes(TOK_D1) &&
      (ta?.claim_token_preview as string) === `${TOK_A1.slice(0, 8)}…`,
    `⑦ 完整 claim_token 不出现在应答里（只给 8 位预览；完整核对走 claimed_seq）`,
    ta?.claim_token_preview,
  );
  ok(
    typeof usageOf(NEAR).generated_at === "string" && usageOf(NEAR).last_seq === 8 && usageOf(EMPTY).last_seq === 0,
    `⑦ generated_at/last_seq 在场且与事件流一致（NEAR last_seq=8，EMPTY=0）`,
    { generated_at: usageOf(NEAR).generated_at, last_seq: usageOf(NEAR).last_seq },
  );

  info(`合计 PASS ${passCount} / FAIL ${failCount}`);
}

main()
  .catch((e: unknown) => {
    failCount++;
    process.exitCode = 1;
    console.error(`[verify] FAIL 主流程异常：${e instanceof Error ? e.message : String(e)}`);
  })
  .finally(() => {
    if (server !== null && server.exitCode === null) {
      server.kill("SIGKILL");
    }
    try {
      fs.rmSync(base, { recursive: true, force: true });
    } catch {
      console.error(`[verify] 警告：临时目录清理失败 ${base}`);
    }
    if (failCount > 0) console.error(`[verify] 小结：FAIL ${failCount} 条`);
  });
