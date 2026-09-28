// backfill-reverify-tasks：把状态投影里「旧记录绑的 plan 哈希已变」的 49 张历史卡按补证清单重验。
//
// 背景（2026-09-27）：补证清单 `D:\tmp\tmp-backfill-inventory.json` 列出 138 个全橙对象——
// 49 张任务（旧记录绑的 plan 整份哈希已变 ⇒ 证据失效）＋89 条依赖边（从未登记前置释放检查）。
// 本脚本只处理 49 张任务：逐卡重跑清单里的 verify 命令（子进程，捕获 exit code 与 stdout/stderr），
// 按**真实结果**登记 `audit.self_check_recorded`（作者自检，`independence=author_self`），绑定
// **当前 plan 内容哈希**（运行时从 documents 现算，不硬编码）。依赖边见 `backfill-dependency-releases.ts`。
//
// 先例：`scripts/backfill-tatai-v07-03.ts`（WorkServiceClient + 自定义幂等键前缀）、
// `scripts/verify-v06-05-e.ts:681` / `verify-v06-09.ts:536`（进程内 `submitSelfCheck` 三件套）。
// 写口仍是唯一写入服务：本脚本经 `WorkServiceClient` 提交，**不自己写事实文件**。
//
// 用法（默认 dry-run，不改 package.json）：
//   pnpm exec tsx scripts/backfill-reverify-tasks.ts                 # --dry-run：只打印计划，不跑命令不写库
//   pnpm exec tsx scripts/backfill-reverify-tasks.ts --apply         # 真跑真写
//   pnpm exec tsx scripts/backfill-reverify-tasks.ts --only V06-01   # 只处理一张卡
//
// 幂等：确定性幂等键前缀 `backfill-20260927:`（见 `backfill-20260927:task:<id>:self-check`），
// 重复运行同键同内容返回原回执、不产生第二次效果。
//
// ⚠ 与任务卡的两处口径差异（已在最终报告显式登记，不自行改口径，仅按现场约束落地）：
//   ① 卡面要求 `checks[].verifies=「重跑 <script> 的真实结果」`，但 `verifies` 是 `audit.ts` 的
//      三值枚举 `document/code/artifact`，不接受自由文本；且写侧闸（`service.ts:248`）要求
//      `verifies` 与 `binding.revision_kind` 相符。本脚本绑定 `plan`（卡面指定）⇒ `verifies` 只能取
//      `document`（`SUBJECT_BINDING_KINDS.document=[design,plan,interface]`）。命令真实结果写进
//      `checks[].method`，`verifies` 取与绑定相符的枚举值。
//   ② 卡面要求非全 0 的 conclusion 用 `blocked`，但 `SelfCheckInput.conclusion` 只接受 `pass|fail`，
//      且折叠层把非 `fail` 一律折成 `pass`（`audit.ts:570`）——用 `blocked` 会被静默读成通过。
//      本脚本非全 0 一律记 `fail`（唯一能如实表达"未通过"的取值）。
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getProject, resolveDataDir } from "../src/server/registry";
import { projectWorkDir } from "../src/server/workstation";
import { loadDocument } from "../src/server/work/documents";
import { WorkServiceClient } from "../src/server/work/service";
import { auditEntityId } from "../src/server/work/audit";
import { putEvidence } from "../src/server/work/evidence";
import { SCHEMA_VERSION, type WorkReceipt } from "../src/server/work/types";

// ── 常量（清单/结果路径按任务卡固定；项目与目录从现场取） ──

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROJECT_ID = "tatai";
/** 补证清单（输入，任务卡指定） */
const INVENTORY_PATH = process.env.TATAI_BACKFILL_INVENTORY ?? "D:/tmp/tmp-backfill-inventory.json";
/** 汇总结果（输出，任务卡指定） */
const RESULT_PATH = process.env.TATAI_BACKFILL_TASKS_RESULT ?? "D:/tmp/tmp-backfill-tasks-result.json";
/** 幂等键前缀与记录 id 后缀（同批补证统一标记） */
const BACKFILL_TAG = "backfill-20260927";
const IDEM_PREFIX = "backfill-20260927:";
/** 2026-09-28 补：轮次后缀——同卡第 N 轮补证用新记录号/新幂等键（第 1 轮保持原样，账本历史键不变） */
const roundTag = (round: number): string => (round === 1 ? BACKFILL_TAG : `${BACKFILL_TAG}-r${round}`);
const roundIdemKey = (id: string, round: number): string =>
  round === 1 ? `${IDEM_PREFIX}task:${id}:self-check` : `${IDEM_PREFIX}task:${id}:r${round}:self-check`;
const CHANGE_ID = "change-20260927-backfill";
const BACKFILL_ACTOR = "claude-code";
/** 单条命令 stdout/stderr 落证据前的截断上限（避免超过证据 8MB 正文上限） */
const STREAM_CAP = 120_000;

// ── 补证清单形态（照 `tmp-backfill-inventory.json` 逐字段声明） ──

interface InventoryTask {
  object_id: string;
  label: string;
  missing_check_ids: string[];
  missing_count: number;
  display_status: string;
  verify_scripts: string[];
  verify_commands: string[];
  script_status: "mapped" | "NO_SCRIPT";
  note?: string;
}
interface InventoryEdge {
  object_id: string;
  from_task: string;
  to_task: string;
  missing_check_ids: string[];
}
interface Inventory {
  generated_at: string;
  project: string;
  source: { plan_revision_current?: string };
  summary: { tasks_no_script_ids?: string[] };
  tasks: InventoryTask[];
  edges: InventoryEdge[];
}

// ── 命令形态与执行 ──

interface CmdSpec {
  /** 人话显示（进汇总/证据） */
  display: string;
  /** 可执行文件与参数 */
  argv: string[];
  /** true = 拼成命令行经 shell 解释（pnpm 的 .cmd 包装器需 shell）；false = 直传（node -e 避免转义） */
  shell: boolean;
}
interface CmdRun {
  display: string;
  exit_code: number;
  stdout: string;
  stderr: string;
}

const truncate = (s: string): string =>
  s.length <= STREAM_CAP ? s : `${s.slice(0, STREAM_CAP)}\n…[截断：原文 ${s.length} 字符，保留前 ${STREAM_CAP}]`;

/** 真跑一条命令，捕获 exit code 与 stdout/stderr（不抛，结果由调用方判）。
 *  2026-09-27 补：单命令超时保护（实测 verify:v06-01 的并发写者子进程可能吊死整晚）——
 *  超时按失败记账（exit 124，理由写 stderr），绝不无限等。上限默认 10 分钟，环境变量 BACKFILL_CMD_TIMEOUT_MS 可覆盖。 */
const CMD_TIMEOUT_MS = Number(process.env.BACKFILL_CMD_TIMEOUT_MS ?? 10 * 60 * 1000);

function runCommand(spec: CmdSpec): CmdRun {
  const res = spec.shell
    ? spawnSync(spec.argv.join(" "), {
        cwd: REPO_ROOT,
        encoding: "utf8",
        shell: true,
        maxBuffer: 256 * 1024 * 1024,
        timeout: CMD_TIMEOUT_MS,
        killSignal: "SIGKILL",
      })
    : spawnSync(spec.argv[0], spec.argv.slice(1), {
        cwd: REPO_ROOT,
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
        timeout: CMD_TIMEOUT_MS,
        killSignal: "SIGKILL",
      });
  const timedOut = res.error !== undefined && (res.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
  const exit = res.error !== undefined ? (timedOut ? 124 : 127) : (res.status ?? 1);
  const stderr =
    (res.stderr ?? "") +
    (timedOut ? `\n[超时] 命令超过 ${Math.round(CMD_TIMEOUT_MS / 1000)}s 未结束，按失败记账（BACKFILL_CMD_TIMEOUT_MS 可调）` : "") +
    (res.error !== undefined && !timedOut ? `\n[spawn error] ${res.error.message}` : "");
  return {
    display: spec.display,
    exit_code: exit,
    stdout: truncate(res.stdout ?? ""),
    stderr: truncate(stderr),
  };
}

/** 清单里的 `pnpm verify:xxx` 文本 → CmdSpec。
 *  2026-09-28 补：优先解析 package.json 后**直调真实命令**（tsx→node --import tsx、python→python），
 *  不再经 pnpm+shell 两层转发——实测该路径会让自派生子进程的验证脚本（v06-01/v06-14 的并发写者）
 *  在 spawnSync 下吊死（孙子进程握着转发管道句柄，主进程退出后 spawnSync 仍等句柄关闭）。
 *  解析不到的直接命令保留原 pnpm+shell 路径（行为兜底）。 */
const PACKAGE_SCRIPTS: Record<string, string> = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")).scripts ?? {};
  } catch {
    return {};
  }
})();

const pnpmSpec = (commandLine: string): CmdSpec => {
  const argv = commandLine.trim().split(/\s+/);
  if (argv[0] === "pnpm" && argv.length === 2) {
    const script = PACKAGE_SCRIPTS[argv[1]];
    if (typeof script === "string" && script.trim() !== "") {
      const parts = script.trim().split(/\s+/);
      if (parts[0] === "tsx") {
        return { display: commandLine, argv: [process.execPath, "--import", "tsx", ...parts.slice(1)], shell: false };
      }
      if (parts[0] === "python") {
        return { display: commandLine, argv: ["python", ...parts.slice(1)], shell: false };
      }
    }
  }
  return { display: commandLine, argv, shell: true };
};
/** NO_SCRIPT 卡的文档核验 → `node -e <code>`（直传，不经 shell，避免 Windows 转义） */
const nodeSpec = (display: string, code: string): CmdSpec => ({ display, argv: ["node", "-e", code], shell: false });

// ── NO_SCRIPT 两卡：脚本里显式列命令，真跑 ──
// 清单里 `script_status=NO_SCRIPT`、`verify_commands=[]`（共 2 张：DES-V06-CLARIFY、V09-21），
// 按卡面口径在本脚本内**显式列出**要跑的命令（不猜、不借别的卡的脚本）。

/**
 * DES-V06-CLARIFY（PLAN.md 卡行：真实产物＝根级 `PLAN.md`「历史审计项处置表／v0.6 验收与审计出口」
 * 与 `DESIGN.md` §11.7；私有验证报告 `.工作台/reviews/v06-clarify-verification.json`）。
 * 按任务卡「最低限度文档核验」= 被引用章节存在且哈希可算 ＋ 声明的事实文件存在性检查，逐条真跑。
 */
const DES_V06_CLARIFY_COMMANDS: CmdSpec[] = [
  nodeSpec(
    "node -e 核 PLAN.md：存在 + sha256 可算 + 含「历史审计项处置表」「验收与审计出口」",
    [
      "const fs=require('fs'),c=require('crypto');",
      "const t=fs.readFileSync('PLAN.md','utf8');",
      "const h=c.createHash('sha256').update(t).digest('hex');",
      "const need=['历史审计项处置表','验收与审计出口'];",
      "const miss=need.filter(s=>!t.includes(s));",
      "if(miss.length){console.error('PLAN.md 缺章节标记：'+miss.join('、'));process.exit(1);}",
      "console.log('PLAN.md sha256='+h+' 章节齐全：'+need.join('、'));",
    ].join(""),
  ),
  nodeSpec(
    "node -e 核 DESIGN.md：存在 + sha256 可算 + 含 §11.7",
    [
      "const fs=require('fs'),c=require('crypto');",
      "const t=fs.readFileSync('DESIGN.md','utf8');",
      "const h=c.createHash('sha256').update(t).digest('hex');",
      "if(!t.includes('11.7')){console.error('DESIGN.md 缺 §11.7');process.exit(1);}",
      "console.log('DESIGN.md sha256='+h+' 含 §11.7');",
    ].join(""),
  ),
  nodeSpec(
    "node -e 核私有验证报告存在性：.工作台/reviews/v06-clarify-verification.json",
    [
      "const fs=require('fs');",
      "const p='.工作台/reviews/v06-clarify-verification.json';",
      "if(!fs.existsSync(p)){console.error('缺事实文件 '+p);process.exit(1);}",
      "const j=JSON.parse(fs.readFileSync(p,'utf8'));",
      "console.log('事实文件在场：'+p+' bytes='+Buffer.byteLength(JSON.stringify(j)));",
    ].join(""),
  ),
];

/**
 * V09-21（PLAN.md 文末卡定义：① R1 的 `pnpm typecheck` + `verify:v09-18/19`；⑨ 冻结后终包门槛列出的
 * 全套复绿命令中的关键判据面：`typecheck/build/build:server`、`v09-20-ui`(R4)、
 * `review-arch-badges-ui`(R3)、`v09-09`/`v09-09-ui`(R5)）。卡面无独立 verify 脚本，命令组按卡面显式列出。
 */
const V09_21_COMMANDS: CmdSpec[] = [
  "pnpm typecheck",
  "pnpm build",
  "pnpm build:server",
  "pnpm verify:v09-18",
  "pnpm verify:v09-19",
  "pnpm verify:v09-20-ui",
  "pnpm verify:review-arch-badges-ui",
  "pnpm verify:v09-09",
  "pnpm verify:v09-09-ui",
].map(pnpmSpec);

const NO_SCRIPT_COMMANDS: Readonly<Record<string, CmdSpec[]>> = {
  "DES-V06-CLARIFY": DES_V06_CLARIFY_COMMANDS,
  "V09-21": V09_21_COMMANDS,
};

// ── 依赖拓扑排序（前置先行；无依赖信息的排前面） ──

/**
 * 按 `edges[]` 对任务做拓扑排序（Kahn），前置先出。
 * 同级（都就绪）时优先「无依赖信息」的卡（不在任何边里出现），再按 id 稳定排序——
 * 满足任务卡「没有依赖信息的排前面」。环（理论不该有）里的余项按 id 追加到末尾并如实标注。
 */
function topoOrder(taskIds: string[], edges: InventoryEdge[]): { order: string[]; cycle: string[] } {
  const inSet = new Set(taskIds);
  const involved = new Set<string>();
  const indeg = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const id of taskIds) indeg.set(id, 0);
  for (const e of edges) {
    if (!inSet.has(e.from_task) || !inSet.has(e.to_task)) continue;
    involved.add(e.from_task);
    involved.add(e.to_task);
    indeg.set(e.to_task, (indeg.get(e.to_task) ?? 0) + 1);
    dependents.set(e.from_task, [...(dependents.get(e.from_task) ?? []), e.to_task]);
  }
  const rank = (id: string): [number, string] => [involved.has(id) ? 1 : 0, id];
  const ready = taskIds.filter((id) => (indeg.get(id) ?? 0) === 0);
  ready.sort((a, b) => {
    const [ra, ia] = rank(a);
    const [rb, ib] = rank(b);
    return ra - rb || ia.localeCompare(ib);
  });
  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const next of dependents.get(id) ?? []) {
      const d = (indeg.get(next) ?? 0) - 1;
      indeg.set(next, d);
      if (d === 0) {
        ready.push(next);
        ready.sort((a, b) => {
          const [ra, ia] = rank(a);
          const [rb, ib] = rank(b);
          return ra - rb || ia.localeCompare(ib);
        });
      }
    }
  }
  const cycle = taskIds.filter((id) => !order.includes(id)).sort();
  return { order: [...order, ...cycle], cycle };
}

// ── 记录提交（唯一写入服务；自定义幂等键前缀按任务卡要求） ──

interface PlannedRecord {
  task_id: string;
  record_id: string;
  record_entity_id: string;
  checks: Record<string, unknown>[];
  conclusion: "pass" | "fail";
}

/**
 * 提交一条 `audit.self_check_recorded`。payload 字段与 `audit.ts#submitSelfCheck` 逐字对齐
 * （task_id/round/checked_by/checks/conclusion/coverage/method_limits/independence=author_self），
 * 但**幂等键用任务卡指定的 `backfill-20260927:` 前缀**——`submitSelfCheck` 内部固定键
 * `${type}:${recordId}:${change_id}`，不接受外部键，故本脚本走底层 `WorkServiceClient.submit`。
 */
async function submitSelfCheckRecord(
  client: WorkServiceClient,
  rec: PlannedRecord,
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
      task_id: rec.task_id,
      round: 1,
      checked_by: BACKFILL_ACTOR,
      checks: rec.checks,
      conclusion: rec.conclusion,
      binding,
      coverage: [],
      method_limits: [],
      independence: "author_self",
    },
  });
}

// ── 命令行参数 ──

interface Args {
  apply: boolean;
  only: string | null;
  /** 2026-09-28 补：第几轮补证——同一卡重跑（如脚本修好后）用新轮号换新幂等键，避免同键异内容被拒 */
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
      if (!Number.isInteger(n) || n < 1 || n > 99) throw new Error("--round 需要 1-99 的整数（第几轮补证）");
      round = n;
    } else throw new Error(`未知参数：${a}（支持 --dry-run/--apply/--only <task_id>/--round <n>）`);
  }
  return { apply, only, round };
}

// ── 主流程 ──

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const dataDir = resolveDataDir();
  if (getProject(PROJECT_ID, dataDir) === undefined) throw new Error(`${PROJECT_ID} 未注册（dataDir=${dataDir}）`);
  const workDir = projectWorkDir(PROJECT_ID, dataDir);

  const inventory = JSON.parse(fs.readFileSync(INVENTORY_PATH, "utf8")) as Inventory;
  if (inventory.project !== PROJECT_ID) throw new Error(`清单 project=${inventory.project}，不是 ${PROJECT_ID}`);

  // 当前 plan 内容哈希：运行时从 documents 现算（不硬编码）
  const plan = loadDocument(PROJECT_ID, "plan", dataDir);
  if (plan === null) throw new Error("读不到 PLAN.md 文档修订，无法绑定 plan 哈希");
  const planHash = plan.revision.content_sha256;
  const binding = { revision_kind: "plan" as const, revision: planHash };

  const warnings: string[] = [];
  if (inventory.source.plan_revision_current !== undefined && inventory.source.plan_revision_current !== planHash) {
    warnings.push(
      `清单记录的 plan_revision_current=${inventory.source.plan_revision_current.slice(0, 12)}… ` +
        `与现算 ${planHash.slice(0, 12)}… 不同：清单生成后 PLAN.md 又变过，绑定按现算值`,
    );
  }

  // 排序：清单里除 NO_SCRIPT 外每卡都有 verify 命令；按拓扑前置先行
  const { order, cycle } = topoOrder(
    inventory.tasks.map((t) => t.object_id),
    inventory.edges,
  );
  if (cycle.length > 0) warnings.push(`依赖图存在环（余项按 id 追加末尾）：${cycle.join("、")}`);

  // 逐卡解析命令（清单 mapped 用 verify_commands；NO_SCRIPT 用脚本内显式命令）
  const commandsOf = (t: InventoryTask): CmdSpec[] => {
    if (t.script_status === "NO_SCRIPT") {
      const cs = NO_SCRIPT_COMMANDS[t.object_id];
      if (cs === undefined) throw new Error(`NO_SCRIPT 卡 ${t.object_id} 没有显式命令定义`);
      return cs;
    }
    return t.verify_commands.map(pnpmSpec);
  };

  const byId = new Map(inventory.tasks.map((t) => [t.object_id, t]));
  let orderList = order;
  if (args.only !== null) {
    if (!byId.has(args.only)) throw new Error(`--only ${args.only} 不在清单任务里`);
    orderList = order.filter((id) => id === args.only);
  }

  // 2026-09-27 补：断点续跑——账本里已有本战役幂等键的卡默认跳过（同键异内容的重提交会被写入服务
  // 按 IDEMPOTENCY_CONFLICT 拒；要重跑某卡用 --only <id> 强制）。--only 模式不启用跳过。
  {
    const eventsPath = path.join(workDir, "events.jsonl"); // projectWorkDir 已含 work 段
    const keyMark = '"idempotency_key":"backfill-20260927:task:';
    const doneIds = new Set<string>();
    if (fs.existsSync(eventsPath)) {
      for (const line of fs.readFileSync(eventsPath, "utf8").split("\n")) {
        const at = line.indexOf(keyMark);
        if (at < 0) continue;
        const rest = line.slice(at + keyMark.length);
        const id = rest.slice(0, rest.indexOf(":")); // 任务 id 到下一个冒号为止（兼容 r2+ 轮次键）
        if (id.length > 0) doneIds.add(id);
      }
    }
    if (args.only === null && doneIds.size > 0) {
      const before = orderList.length;
      orderList = orderList.filter((id) => !doneIds.has(id));
      console.log(`== 断点续跑：账本已有 ${before - orderList.length} 张卡的补证记录，本次跳过（重跑单卡用 --only <id>）`);
    }
  }

  console.log(`== 补证重验计划（${args.apply ? "APPLY 真跑真写" : "DRY-RUN 只打印"}）`);
  console.log(`   项目=${PROJECT_ID}  dataDir=${dataDir}  清单=${INVENTORY_PATH}`);
  console.log(`   当前 plan 内容哈希=${planHash}`);
  console.log(`   任务总数=${inventory.tasks.length}  本次处理=${orderList.length}  依赖边=${inventory.edges.length}（另见 edges 脚本）`);
  for (const w of warnings) console.log(`   [预警] ${w}`);

  console.log("== 执行顺序（拓扑，前置先行；无依赖信息的排前面）——前 5");
  for (const id of orderList.slice(0, 5)) {
    const t = byId.get(id)!;
    const cs = commandsOf(t);
    console.log(`   ${id} [${t.script_status}] ${cs.map((c) => c.display).join(" ; ")}`);
  }
  const noScript = orderList.filter((id) => byId.get(id)!.script_status === "NO_SCRIPT");
  if (noScript.length > 0) {
    console.log("== NO_SCRIPT 卡的显式命令组");
    for (const id of noScript) {
      console.log(`   ${id}：`);
      for (const c of commandsOf(byId.get(id)!)) console.log(`     · ${c.display}`);
    }
  }

  // 预期写入的记录形状（取第一张卡示例）
  if (orderList.length > 0) {
    const sample = byId.get(orderList[0])!;
    console.log("== 预期写入的记录形状（示例，record_id 去掉 `check:` 前缀后即为实体 id 的 record_id 段）");
    console.log(
      JSON.stringify(
        {
          type: "audit.self_check_recorded",
          entity_id: auditEntityId("audit.self_check_recorded", `${sample.object_id}:${roundTag(args.round)}`),
          idempotency_key: roundIdemKey(sample.object_id, args.round),
          payload: {
            task_id: sample.object_id,
            checks: sample.missing_check_ids.map((cid) => ({
              check_id: cid,
              method: "重跑 <script> 的真实结果（整体 exit=…）",
              command: "<该卡命令，&& 连接>",
              exit_code: 0,
              output_ref: ".工作台/work/evidence/<sha256>.json",
              evidence_sha256: "<证据正文 sha256>",
              verifies: "document",
            })),
            conclusion: "pass|fail",
            binding: { revision_kind: "plan", revision: `${planHash.slice(0, 12)}…` },
          },
        },
        null,
        2,
      ),
    );
  }

  // dry-run：到此为止，不跑命令、不写库
  interface TaskResult {
    task_id: string;
    commands: string[];
    exit_codes: number[] | null;
    conclusion: string;
    record_id: string | null;
    evidence_sha256: string | null;
    /** 2026-09-27 补：写入服务拒绝等提交期错误（该卡证据已跑完但没入账；非空 = 需要人工/单卡重跑） */
    submit_error?: string;
  }
  const results: TaskResult[] = [];

  if (!args.apply) {
    for (const id of orderList) {
      const t = byId.get(id)!;
      results.push({
        task_id: id,
        commands: commandsOf(t).map((c) => c.display),
        exit_codes: null,
        conclusion: "planned",
        record_id: auditEntityId("audit.self_check_recorded", `${id}:${roundTag(args.round)}`),
        evidence_sha256: null,
      });
    }
    console.log("== DRY-RUN 结束：未跑任何命令、未写事件库（仅落本汇总文件）");
  } else {
    const client = new WorkServiceClient({ dataDir, timeoutMs: 15_000 });
    for (const id of orderList) {
      const t = byId.get(id)!;
      const specs = commandsOf(t);
      console.log(`── ${id}（${specs.length} 条命令）`);
      const runs = specs.map((s) => {
        const r = runCommand(s);
        console.log(`     ${r.display} → exit ${r.exit_code}`);
        return r;
      });
      const exitCodes = runs.map((r) => r.exit_code);
      const allZero = exitCodes.every((c) => c === 0);
      const conclusion: "pass" | "fail" = allZero ? "pass" : "fail";

      // 证据正文：命令、退出码与原始输出（内容寻址落库，走 evidence.ts 正规函数）
      const content = JSON.stringify(
        {
          object_id: id,
          label: t.label,
          missing_check_ids: t.missing_check_ids,
          script_status: t.script_status,
          commands: runs.map((r) => ({ display: r.display, exit_code: r.exit_code, stdout: r.stdout, stderr: r.stderr })),
          conclusion,
          binding,
        },
        null,
        2,
      );
      const blob = putEvidence(workDir, {
        content,
        kind: "self_check",
        summary: `${id} 补证重验（重跑 ${specs.length} 条命令，整体 exit=${allZero ? 0 : "非 0"}）`,
        created_by: BACKFILL_ACTOR,
        role: "executor",
        binding,
      });

      const commandLine = runs.map((r) => r.display).join(" && ");
      const overallExit = exitCodes.find((c) => c !== 0) ?? 0;
      const checks: Record<string, unknown>[] = t.missing_check_ids.map((cid) => ({
        check_id: cid,
        method: `重跑 ${runs.map((r) => r.display).join("；")} 的真实结果（整体 exit=${overallExit}）`,
        command: commandLine,
        exit_code: overallExit,
        output_ref: blob.recovery_path,
        evidence_sha256: blob.sha256,
        verifies: "document",
      }));
      const rec: PlannedRecord = {
        task_id: id,
        record_id: `${id}:${roundTag(args.round)}`,
        record_entity_id: auditEntityId("audit.self_check_recorded", `${id}:${roundTag(args.round)}`),
        checks,
        conclusion,
      };
      const idemKey = roundIdemKey(id, args.round);
      // 2026-09-27 补：单卡提交失败（含 IDEMPOTENCY_CONFLICT 等一切写入服务拒绝）只记错误并继续，
      // 不再让一张卡拖死整轮（首跑实测：一张卡冲突即整体中断）。
      try {
        const receipt = await submitSelfCheckRecord(client, rec, binding, idemKey);
        console.log(
          `     记录 ${rec.record_entity_id} → seq=${receipt.seq} rev=${receipt.entity_revision}` +
            `${receipt.duplicate ? "（幂等命中）" : ""} evidence=${blob.sha256.slice(0, 12)}…`,
        );
        results.push({
          task_id: id,
          commands: runs.map((r) => r.display),
          exit_codes: exitCodes,
          conclusion,
          record_id: rec.record_entity_id,
          evidence_sha256: blob.sha256,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`     [提交失败·已跳过继续] ${id}: ${msg}`);
        results.push({
          task_id: id,
          commands: runs.map((r) => r.display),
          exit_codes: exitCodes,
          conclusion,
          record_id: rec.record_entity_id,
          evidence_sha256: blob.sha256,
          submit_error: msg,
        });
      }
    }
  }

  const out = {
    generated_at: new Date().toISOString(),
    mode: args.apply ? "apply" : "dry_run",
    project: PROJECT_ID,
    data_dir: dataDir,
    plan_revision: planHash,
    inventory: INVENTORY_PATH,
    order: orderList,
    order_cycle: cycle,
    warnings,
    tasks: results,
  };
  fs.mkdirSync(path.dirname(RESULT_PATH), { recursive: true });
  fs.writeFileSync(RESULT_PATH, JSON.stringify(out, null, 2) + "\n", "utf8");
  console.log(`== 汇总已落 ${RESULT_PATH}（${results.length} 张卡）`);
  if (!args.apply) {
    console.log("   提示：确认计划无误后加 --apply 真跑真写（写库只经唯一写入服务）。");
  }
}

main().catch((e) => {
  console.error("backfill-reverify-tasks 失败：", e instanceof Error ? e.message : e);
  process.exit(1);
});
