// V06-01 补修包 B 验证（PLAN.md「补修分包（GPT-6 裁定，2026-09-20）」B 行）：
// **带偏移的 ISO 串不能直接排序/比较**——凡按「发生时间」比的地方解析成真实时刻再比；
// 权威事件重放仍按**服务端提交序号** `seq`，不得被客户端时间重排。
//
// 用法：pnpm verify:v06-01-b
//
// 自带隔离环境：临时 `TATAI_HOME` + 临时项目目录，不碰真实注册表与三个真实项目；
// 收尾清理自己创建的临时目录（`TATAI_KEEP_TMP=1` 可保留现场）。
//
// 覆盖点：
//   ① 表驱动（`src/server/time.ts` 的 `parseIsoMs`/`compareIsoTime`/`latestByTime`）：
//      正偏移 vs 负偏移 vs Z、跨日、同一瞬时的不同表示（判同刻）、毫秒、同时间（次级序稳定可复现）、
//      非法/缺失（不得当最新、不得当有效），并**反例自证**字面序会选错；
//   ② 服务端提交序号：`occurred_at` 与 `seq` 相反时重放仍按 `seq`（对调时间串结果不变），
//      `seq` 有洞仍抛 `EVENT_INVALID`；
//   ③ 真实调用点逐个点名（含真后端 HTTP）：
//      `collectProjectFacts` 取「最近一次提交的 code 修订」、`acceptanceDimensionOf` 取最新验收、
//      `evaluateProjectEntry` 取最新批次验收 / 最新待议、`planRecovery` 取最新检查点、
//      `livenessOf` 取最后信号、`foldExecutions` 按 seq 重放、
//      `pickCheckRecords` 同档取最新、`GET /api/projects/:id/activity` 的 `last_task_report_at`。
import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { addProject } from "../src/server/registry";
import { compareIsoTime, latestByTime, parseIsoMs } from "../src/server/time";
import { WorkService } from "../src/server/work/service";
import { loadEvents, replayEvents } from "../src/server/work/eventStore";
import { WorkError, type WorkCommand, type WorkEvent } from "../src/server/work/types";
import { foldAuditRecords, submitHumanAcceptance, submitSubmission } from "../src/server/work/audit";
import {
  acceptanceDimensionOf,
  collectProjectFacts,
  pickCheckRecords,
  type CheckInput,
} from "../src/server/work/statusProjection";
import { evaluateProjectEntry } from "../src/server/work/entry";
import { activateBaseline } from "../src/server/work/documents";
import { claimTask } from "../src/server/work/claims";
import { submitDefinitionImports, submitTaskStatus, type WorkSubmitter } from "../src/server/work/tasks";
import { importTaskDefinitions } from "../src/server/work/plan";
import { listTasks, projectWorkDir, readTaskLedger } from "../src/server/workstation";
import {
  foldExecutions,
  livenessOf,
  planRecovery,
  recordCheckpoint,
  recordHeartbeat,
  recordStarted,
  recordStartRequested,
  type ExecutionProbe,
  type ExecutionTarget,
} from "../src/server/work/executionReceipts";

// ── 本脚本起的后端端口（不与其它套件重号；占用即明确报错，不硬闯） ──
const PORT = 8846;
const BASE = `http://127.0.0.1:${PORT}`;
const CHG = "chg-v0601b";
const ROLE = "coordinator";
const OWNER = "v0601b-fixture-owner";

// ── 夹具用的两个「跨偏移」时刻（同一条判据的正反两面） ──
//
// 这两个串**相对"此刻"推**，不写绝对时刻：`requested_at`/`started_at`/`received_at` 是产品钟
// 在跑的时候写的（= 真实此刻），只要夹具的两个时刻落在"此后"，无论哪天跑、哪个时区跑，
// "真实最晚"都是夹具指定的那条。故意造成：
//   · LITERAL_BIGGER：真实**更早**、字面**更大**（带 +08:00，字面钟点比另一条大 6 小时）
//   · REAL_LATER    ：真实**更晚**、字面**更小**（UTC Z 写法）
// 若把两者写反（或本机钟跳到夹具时刻之后），下面的 F0 自检会先红——夹具不会悄悄失效。
const FX_BASE = Date.now();
/** 用固定偏移渲染某个毫秒时刻（`HH:mm:ss.sss+08:00` 形态；与产品钟同形） */
const isoOffset = (ms: number, offsetHours: number): string => {
  const shifted = new Date(ms + offsetHours * 3600_000).toISOString();
  const sign = offsetHours >= 0 ? "+" : "-";
  const abs = Math.abs(offsetHours);
  return `${shifted.slice(0, 23)}${sign}${String(abs).padStart(2, "0")}:00`;
};
const LITERAL_BIGGER = isoOffset(FX_BASE + 3600_000, 8); // 真实 此刻+1h
const REAL_LATER = new Date(FX_BASE + 3 * 3600_000).toISOString(); // 真实 此刻+3h
/** 与 REAL_LATER 同一瞬时的另一种写法（-05:00），用来验「同一瞬时判同刻」 */
const SAME_INSTANT_NEG = isoOffset(FX_BASE + 3 * 3600_000, -5);
const NOW = new Date(FX_BASE + 4 * 3600_000).toISOString();
/** ③-11 换一对时刻用：同样「真实更晚但字面更小」，且与第一对不同值（排除缓存/巧合） */
const FX_SWAP_LITERAL_BIGGER = isoOffset(FX_BASE + 3 * 3600_000, 8); // 真实 此刻+3h
const FX_SWAP_REAL_LATER = new Date(FX_BASE + 4 * 3600_000).toISOString(); // 真实 此刻+4h
const ILLEGAL_TIME = "不是时间";

let passCount = 0;
let failCount = 0;
const ok = (cond: boolean, label: string) => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (cond) passCount++;
  else {
    failCount++;
    process.exitCode = 1;
  }
};
const info = (msg: string): void => console.log(`[verify]   ${msg}`);
const sha256 = (text: string): string => crypto.createHash("sha256").update(text).digest("hex");

// ── 隔离环境 ──
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-v0601b-verify-"));
const dataDir = path.join(tmpBase, "home");
fs.mkdirSync(dataDir, { recursive: true });
process.env.TATAI_HOME = dataDir;
const service = new WorkService({ dataDir });
const submitter: WorkSubmitter = { submit: (c: WorkCommand) => service.submit(c) };

function write(f: string, text: string): void {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text, "utf8");
}

/** 施工图（表 + 卡正文；字段标签走既有口径）：只要一张卡，够激活基线用 */
function planText(title: string, cards: { id: string; goal: string }[]): string {
  const lines = [
    `# ${title}`,
    "",
    "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const c of cards) lines.push(`| ${c.id} | todo | ${c.goal} |  | ${c.id} 的完成证据 |`);
  lines.push("");
  for (const c of cards) {
    lines.push(`### ${c.id} ${c.goal}`, "");
    lines.push(`**设计依据**：§2。**依赖**：无。**文件责任**：\`src/${c.id.toLowerCase()}.ts\`。`, "");
    lines.push(`- [ ] ${c.id} 的验收检查项一`, "");
  }
  return lines.join("\n");
}

/** 设计书（带编号 level-2 章节） */
function designText(title: string): string {
  return (
    `# ${title}\n\n> 夹具设计书（V06-01 补修包 B 隔离验证用；不是任何真实项目的设计）。\n\n` +
    "## 1 目标\n\n夹具目标一句话。\n\n" +
    "## 2 导入能力\n\n- 模块：src（导入实现）\n\n" +
    "## 3 导出能力\n\n- 模块：src（导出实现）\n"
  );
}

interface Fixture {
  id: string;
  root: string;
  workDir: string;
  plan: string;
}

function writeTasksJson(projectId: string, rows: { id: string; updated_at: string }[]): void {
  write(
    path.join(tmpBase, projectId, ".工作台", "tasks.json"),
    JSON.stringify(
      {
        version: 1,
        tasks: rows.map((r) => ({
          id: r.id,
          title: `夹具任务 ${r.id}`,
          module_id: "m1",
          status: "todo",
          reporter: "fixture",
          updated_at: r.updated_at,
        })),
      },
      null,
      2,
    ) + "\n",
  );
}

function makeFixture(id: string, opts: { tasksJson?: boolean; withDocs?: boolean } = {}): Fixture {
  const root = path.join(tmpBase, id);
  const workbench = path.join(root, ".工作台");
  fs.mkdirSync(workbench, { recursive: true });
  const plan = planText(`夹具·${id} 施工图`, [{ id: "T-1", goal: "夹具目标" }]);
  if (opts.withDocs !== false) {
    write(path.join(workbench, "design.md"), designText(`夹具·${id} 设计书`));
    write(path.join(workbench, "plan.md"), plan);
  }
  if (opts.tasksJson === true) {
    writeTasksJson(id, [
      { id: "T-report-1", updated_at: LITERAL_BIGGER },
      { id: "T-report-2", updated_at: REAL_LATER },
    ]);
  }
  addProject({ id, name: `夹具 ${id}`, path: root, kind: "backend" }, dataDir);
  return { id, root, workDir: projectWorkDir(id, dataDir), plan };
}

function approveBaseline(fx: Fixture): string {
  return activateBaseline(
    fx.id,
    {
      approved_by: "v0601b-fixture-design-role",
      approval_basis: "V06-01 补修包 B 夹具审定",
      approval_kind: "delegated_technical_review",
    },
    dataDir,
  ).baseline.baseline_id;
}

const eventsOf = (fx: Fixture): WorkEvent[] => loadEvents(fx.workDir).events;
const auditOf = (fx: Fixture) => foldAuditRecords(eventsOf(fx));

// ══════════════════════════════════════════════════════════════════════════
// ① 表驱动：时间串比较口径
// ══════════════════════════════════════════════════════════════════════════
console.log("[verify] ═══ ① 表驱动：时间串比较口径（src/server/time.ts） ═══");

// F0 夹具自检：③ 用的那对跨偏移时刻确实「真实更晚但字面更小」，否则后面所有结论都不成立
ok(
  LITERAL_BIGGER > REAL_LATER && compareIsoTime(LITERAL_BIGGER, REAL_LATER) < 0,
  `F0 夹具自检：③ 用的跨偏移对是「真实更晚但字面更小」（${LITERAL_BIGGER} > ${REAL_LATER} 字面；真实后者更晚）`,
);
ok(
  compareIsoTime(SAME_INSTANT_NEG, REAL_LATER) === 0,
  `F0 夹具自检：${SAME_INSTANT_NEG} 与 ${REAL_LATER} 是同一瞬时`,
);

const parseCases: [string, string | null | undefined, number | null][] = [
  ["本地正偏移 +08:00", "2026-09-20T09:00:00+08:00", Date.parse("2026-09-20T09:00:00+08:00")],
  ["UTC Z", "2026-09-20T02:00:00Z", Date.parse("2026-09-20T02:00:00Z")],
  ["负偏移 -05:00", "2026-09-19T21:00:00-05:00", Date.parse("2026-09-19T21:00:00-05:00")],
  ["带毫秒", "2026-09-20T10:00:00.500Z", Date.parse("2026-09-20T10:00:00.500Z")],
  ["毫秒 + 偏移", "2026-09-20T18:00:00.5+08:00", Date.parse("2026-09-20T18:00:00.5+08:00")],
  ["空串", "", null],
  ["null", null, null],
  ["undefined", undefined, null],
  ["纯空白", "   ", null],
  ["半截串", "2026-09-20T", null],
  ["非时间文本", ILLEGAL_TIME, null],
  ["越界月日", "2026-13-45T99:99:99Z", null],
];
for (const [label, raw, want] of parseCases) {
  ok(parseIsoMs(raw) === want, `①-1 parseIsoMs（${label}）→ ${want === null ? "null（非法/缺失）" : String(want)}`);
}

// ①-2 正负偏移 / Z 混排按真实时刻升序；同一组数据的字典序与之不同（反例自证）
const mixed = [
  "2026-09-21T02:00:00.500Z", // 最晚
  "2026-09-20T21:00:00-05:00", // 02:00Z（与下一条同刻）
  "2026-09-20T09:00:00+08:00", // 01:00Z（最早）
  "2026-09-21T02:00:00Z", // 02:00Z
];
const wantOrder = [
  "2026-09-20T09:00:00+08:00",
  "2026-09-20T21:00:00-05:00",
  "2026-09-21T02:00:00Z",
  "2026-09-21T02:00:00.500Z",
];
const rising = [...mixed].sort(compareIsoTime);
const literalOrder = [...mixed].sort();
ok(
  JSON.stringify(rising) === JSON.stringify(wantOrder),
  `①-2 正/负偏移与 Z 混排按**真实时刻**升序（${rising.join(" | ")}）`,
);
info(`①-2 对照组（同一组数据用默认字典序）：${literalOrder.join(" | ")}`);
ok(
  JSON.stringify(literalOrder) !== JSON.stringify(rising),
  "①-2 反例自证：同一组数据的字典序次序与真实时刻序**不同**（判据有区分力）",
);

// ①-3 裁定原例：2026-09-20T09:00:00+08:00 实际早于 2026-09-20T02:00:00Z
const earlyByReal = "2026-09-20T09:00:00+08:00";
const laterByReal = "2026-09-20T02:00:00Z";
ok(
  compareIsoTime(earlyByReal, laterByReal) < 0,
  "①-3 真实时刻：2026-09-20T09:00:00+08:00 **早于** 2026-09-20T02:00:00Z（比较为负）",
);
ok(
  earlyByReal > laterByReal,
  "①-3 反例自证：这两个串的**字面序**恰好相反（字典序会说 +08:00 那条更晚）",
);

// ①-4 同一瞬时的不同表示 → 判同刻（比较为 0）
const sameInstantPairs: [string, string][] = [
  ["2026-09-20T10:00:00Z", "2026-09-20T18:00:00+08:00"],
  ["2026-09-20T21:00:00-05:00", "2026-09-21T02:00:00Z"],
];
for (const [a, b] of sameInstantPairs) {
  ok(compareIsoTime(a, b) === 0, `①-4 同一瞬时的不同表示判同刻：${a} ≡ ${b}（比较为 0）`);
}

// ①-5 跨日：真实更晚的那条字面更小（反向再来一组）
const crossDayPairs: [string, string, "later" | "earlier"][] = [
  ["2026-09-19T23:00:00-05:00", "2026-09-20T03:00:00Z", "later"], // 前者真实 09-20T04:00Z
  ["2026-09-20T07:00:00+08:00", "2026-09-19T23:30:00Z", "earlier"], // 前者真实 09-19T23:00Z
];
for (const [a, b, which] of crossDayPairs) {
  const cmp = compareIsoTime(a, b);
  ok(
    (which === "later" ? cmp > 0 : cmp < 0) && (which === "later" ? a < b : a > b),
    `①-5 跨日：${a} 真实${which === "later" ? "更晚" : "更早"}而字面${which === "later" ? "更小" : "更大"}（比较 ${cmp}）`,
  );
}

// ①-6 毫秒
ok(
  compareIsoTime("2026-09-20T10:00:00.500Z", "2026-09-20T10:00:00Z") > 0,
  "①-6 毫秒参与比较：…10:00:00.500Z 晚于 …10:00:00Z",
);
ok(
  compareIsoTime("2026-09-20T18:00:00.5+08:00", "2026-09-20T10:00:00.500Z") === 0,
  "①-6 毫秒 + 不同偏移仍判同刻：…18:00:00.5+08:00 ≡ …10:00:00.500Z",
);

// ①-7 同时间：次级序明确、稳定、可复现
const tied = [
  { id: "a", at: "2026-09-20T10:00:00Z" },
  { id: "b", at: "2026-09-20T10:00:00Z" },
  { id: "c", at: "2026-09-20T09:00:00Z" },
];
const tieRuns = [0, 1, 2].map(() => latestByTime(tied, (x) => x.at)?.id ?? "null");
ok(
  tieRuns.join(",") === "b,b,b",
  `①-7 同刻并列的次级序明确且可复现：取输入顺序里更靠后的一条（三次都是 ${tieRuns.join("/")}）`,
);
ok(
  latestByTime([...tied].reverse(), (x) => x.at)?.id === "a",
  "①-7 定序跟着数组（事实）顺序走：整体反序 → 取反序里更靠后的 a（不是随机结果）",
);
ok(
  [...tied].sort((x, y) => compareIsoTime(x.at, y.at)).at(-1)?.id === "b",
  "①-7 稳定排序取末位与 latestByTime 同结论（两处口径一致，不存在两套次级序）",
);
ok(
  latestByTime(
    [
      { id: "x", at: "2026-09-20T10:00:00Z" },
      { id: "y", at: "2026-09-20T18:00:00+08:00" },
    ],
    (v) => v.at,
  )?.id === "y",
  "①-7 同刻的两种写法仍算一次并列（取靠后的 y，不因字面大小翻盘）",
);

// ①-8 非法 / 缺失
const dirty = [ILLEGAL_TIME, "2026-09-20T02:00:00Z", "", "2026-09-20T01:00:00Z"];
const dirtySorted = [...dirty].sort(compareIsoTime);
ok(
  dirtySorted.at(-1) === "2026-09-20T02:00:00Z",
  `①-8 非法/缺失在升序里排最前 → 取最新永远取不到它（取到 ${dirtySorted.at(-1)}）`,
);
ok(
  [...dirty].sort().at(-1) === ILLEGAL_TIME,
  "①-8 反例自证：同一组数据按字典序取最新会取到非法串（正是本包要消除的行为）",
);
ok(
  latestByTime([{ id: "bad", at: ILLEGAL_TIME }], (x) => x.at) === null,
  "①-8 全都解析不出来 → null（不凭空指定一条当最新）",
);
ok(
  latestByTime(
    [
      { id: "bad", at: ILLEGAL_TIME },
      { id: "good", at: "2026-09-20T01:00:00Z" },
    ],
    (x) => x.at,
  )?.id === "good",
  "①-8 坏串不参与比较、也不把整组判成未知：仍取到唯一合法的那条",
);
ok(latestByTime([], (x: { at: string }) => x.at) === null, "①-8 空集合 → null");
ok(
  latestByTime(
    [
      { id: "noAt" },
      { id: "ok", at: "2026-09-20T01:00:00Z" },
    ] as { id: string; at?: string }[],
    (x) => x.at,
  )?.id === "ok",
  "①-8 缺字段（undefined）与非法串同处理：不参与比较",
);

// ①-9 取最晚只返回原对象、不改字段
const probeObj = { at: "2026-09-20T01:00:00Z", note: "原样" };
const pickedObj = latestByTime([probeObj], (x) => x.at);
ok(pickedObj === probeObj && probeObj.note === "原样", "①-9 latestByTime 返回原对象引用（不改字段、不复制出第二份事实）");

// ══════════════════════════════════════════════════════════════════════════
// ② 服务端提交序号：事件重放仍按 seq
// ══════════════════════════════════════════════════════════════════════════
console.log("[verify] ═══ ② 服务端提交序号：事件重放仍按 seq，与客户端时间无关 ═══");

const fxSeq = makeFixture("fx-seq", { withDocs: false });
const probeCmd = (entityId: string, revision: number, occurredAt: string, step: string): WorkCommand => ({
  schema_version: 2,
  project_id: fxSeq.id,
  change_id: CHG,
  entity_id: entityId,
  expected_revision: revision === 1 ? null : revision - 1,
  type: "verify.time_order_probe",
  actor_id: "v0601b-fixture",
  role: "executor",
  occurred_at: occurredAt,
  idempotency_key: `${entityId}:${revision}`,
  payload: { step },
});
// A 组：seq 顺序与真实时间顺序**相反**（seq 1 的 occurred_at 反而最晚）
service.submit(probeCmd("probe:seq-a", 1, "2026-09-21T20:00:00Z", "first"));
service.submit(probeCmd("probe:seq-a", 2, "2026-09-21T01:00:00+08:00", "second"));
// B 组：把两条事件的时间串**对调**（若重放按时间排，结论就会跟着翻）
service.submit(probeCmd("probe:seq-b", 1, "2026-09-21T01:00:00+08:00", "first"));
service.submit(probeCmd("probe:seq-b", 2, "2026-09-21T20:00:00Z", "second"));

const seqEvents = eventsOf(fxSeq);
const replayed = replayEvents(seqEvents);
const stepOf = (id: string): unknown =>
  (replayed.entities[id]?.payload as Record<string, unknown> | undefined)?.step;
ok(replayed.last_seq === 4 && seqEvents.length === 4, `②-1 4 条事件连续重放：last_seq=${replayed.last_seq}`);
ok(
  stepOf("probe:seq-a") === "second",
  "②-2 seq 与真实时间相反时，重放取**高 seq** 的那条（probe:seq-a → second，不是按时间会得到的 first）",
);
ok(
  stepOf("probe:seq-b") === "second",
  "②-2 把两条事件的 occurred_at 对调后，重放结论**不变**（probe:seq-b → second）：重放与客户端时间无关",
);
const aEvents = seqEvents.filter((e) => e.entity_id === "probe:seq-a");
const latestByClientTime = [...aEvents].sort((x, y) => compareIsoTime(x.occurred_at, y.occurred_at)).at(-1);
ok(
  (latestByClientTime?.payload as Record<string, unknown> | undefined)?.step === "first" &&
    stepOf("probe:seq-a") === "second",
  "②-2 反例自证：同一实体的两条事件按**客户端时间**排会选到 first，重放却给 second —— 两者确实不同",
);
ok(
  replayed.entities["probe:seq-a"]?.updated_at === seqEvents[1]?.received_at,
  "②-2 实体时间戳取服务端 received_at（不是客户端 occurred_at）",
);

// ②-3 seq 有洞仍必须暴露（重放没有被改成「按时间排、忽略洞」）
let holeCode = "(没有抛错)";
try {
  replayEvents([seqEvents[0]!, seqEvents[2]!, seqEvents[3]!]);
} catch (e) {
  holeCode = e instanceof WorkError ? e.code : `(非 WorkError: ${(e as Error).message})`;
}
ok(holeCode === "EVENT_INVALID", `②-3 seq 有洞仍抛 EVENT_INVALID（${holeCode}）：重放的结构不变量没被改动`);

// ══════════════════════════════════════════════════════════════════════════
// ③ 真实调用点
// ══════════════════════════════════════════════════════════════════════════
console.log("[verify] ═══ ③ 真实调用点：每个站点都构造了「真实更晚但字面更小」的一对 ═══");

// ── C1 statusProjection：取「最近一次提交的 code 修订」 ──
const fxLatest = makeFixture("fx-latest", { tasksJson: true });
submitSubmission(submitter, {
  project_id: fxLatest.id,
  change_id: CHG,
  actor_id: "fixture-executor",
  role: "executor",
  occurred_at: LITERAL_BIGGER,
  record_id: "sub-literal-bigger",
  goal: "夹具：字面更大的那次提交",
  submitted_by: "fixture-executor",
  binding: { revision_kind: "code", revision: "code-literal-bigger" },
});
submitSubmission(submitter, {
  project_id: fxLatest.id,
  change_id: CHG,
  actor_id: "fixture-executor",
  role: "executor",
  occurred_at: REAL_LATER,
  record_id: "sub-real-later",
  goal: "夹具：真实更晚的那次提交",
  submitted_by: "fixture-executor",
  binding: { revision_kind: "code", revision: "code-real-later" },
});
submitSubmission(submitter, {
  project_id: fxLatest.id,
  change_id: CHG,
  actor_id: "fixture-executor",
  role: "executor",
  occurred_at: ILLEGAL_TIME,
  record_id: "sub-illegal-time",
  goal: "夹具：时间串非法的提交",
  submitted_by: "fixture-executor",
  binding: { revision_kind: "code", revision: "code-illegal-time" },
});
const factsLatest = collectProjectFacts(fxLatest.id, dataDir);
const literalPick = Object.values(auditOf(fxLatest).submissions)
  .filter((s) => s.binding?.revision_kind === "code")
  .sort((a, b) => a.at.localeCompare(b.at))
  .at(-1)?.binding?.revision;
// 定向更新（V09-29／契约 F4，2026-10-08 共同夹具修复批）：产品读口**默认** `revisions.code = null`
//   （= "当前源码未知，代码检查一律待复核"；自报值不再当"当前代码版本"），自报的「最近一次 code 绑定修订」
//   移到 `revisions.code_declared`（statusProjection.ts:2006-2007 / :2141 latestCodeBindingRevision）。
//   ③-1 判据因此从 `revisions.code` 改锚到 `revisions.code_declared`——**判据不放宽**：仍是"真实时刻最晚
//   的那次绑定"，且仍要求"字典序取最新会拿到时间非法的那条"这一反例自证（时间偏移目标照旧被测）。
ok(
  factsLatest.revisions.code_declared === "code-real-later",
  `③-1 revisions.code_declared = 真实时刻最晚的那次提交所绑定的版本（${factsLatest.revisions.code_declared}）`,
);
ok(
  literalPick === "code-illegal-time" && factsLatest.revisions.code_declared !== literalPick,
  `③-1 反例自证：字典序取最新会拿到时间非法的 ${literalPick}；实现给的是 ${factsLatest.revisions.code_declared}`,
);

// ── C1b 全为非法 → 拿不到当前版本（null，fail-closed） ──
const fxBad = makeFixture("fx-bad", { withDocs: false });
submitSubmission(submitter, {
  project_id: fxBad.id,
  change_id: CHG,
  actor_id: "fixture-executor",
  role: "executor",
  occurred_at: ILLEGAL_TIME,
  record_id: "sub-only-illegal",
  goal: "夹具：唯一一次提交，时间串非法",
  submitted_by: "fixture-executor",
  binding: { revision_kind: "code", revision: "code-only-illegal" },
});
// 同上（V09-29／F4 定向更新）：全非法 ⇒ `code_declared` 也是 null（fail-closed）——
//   改锚到 code_declared 后这条才真正在测"解析不出就不当当前版本"，而非恒 null 的空转。
ok(
  collectProjectFacts(fxBad.id, dataDir).revisions.code_declared === null,
  "③-2 提交时间全都解析不出来 → revisions.code_declared = null（不把一个非法时间当成当前版本）",
);

// ── C2 acceptances 取最新（真实调用点 acceptanceDimensionOf，记录来自真实事件流） ──
submitHumanAcceptance(submitter, {
  project_id: fxLatest.id,
  change_id: CHG,
  actor_id: "fixture-user",
  role: "user",
  occurred_at: LITERAL_BIGGER,
  record_id: "acc-literal-bigger",
  decision: "reject",
  task_id: "T-1",
  accepted_by: "夹具用户",
  note: "字面更大（真实更早）",
});
submitHumanAcceptance(submitter, {
  project_id: fxLatest.id,
  change_id: CHG,
  actor_id: "fixture-user",
  role: "user",
  occurred_at: REAL_LATER,
  record_id: "acc-real-later",
  decision: "accept",
  task_id: "T-1",
  accepted_by: "夹具用户",
  note: "真实更晚（字面更小）",
});
const accRecords = Object.values(auditOf(fxLatest).acceptances);
ok(
  acceptanceDimensionOf(accRecords) === "accepted" &&
    acceptanceDimensionOf(accRecords, { task_id: "T-1" }) === "accepted",
  "③-3 验收维度取**真实时刻**最新的一条（accept，不是字面序会取的 reject）",
);
ok(
  accRecords.length === 2,
  `③-3 夹具自检：两条验收确实都落进了审计记录（${accRecords.map((r) => r.record_id).join("、")}）`,
);

// ── C2b 全为非法时间 → 不判「已接受」（fail-closed → pending） ──
submitHumanAcceptance(submitter, {
  project_id: fxBad.id,
  change_id: CHG,
  actor_id: "fixture-user",
  role: "user",
  occurred_at: ILLEGAL_TIME,
  record_id: "acc-only-illegal",
  decision: "accept",
  task_id: "T-1",
  accepted_by: "夹具用户",
});
ok(
  acceptanceDimensionOf(Object.values(auditOf(fxBad).acceptances)) === "pending",
  "③-4 验收时间全都解析不出来 → pending（不拿一条时间非法的记录判已接受）",
);

// ── C3 entry 取最新 acceptance（批次层） ──
const fxBatch = makeFixture("fx-batch");
approveBaseline(fxBatch);
for (const [recordId, at, note] of [
  ["acc-batch-literal-bigger", LITERAL_BIGGER, "字面更大的那次退回"],
  ["acc-batch-real-later", REAL_LATER, "真实更晚的那次退回"],
] as const) {
  submitHumanAcceptance(submitter, {
    project_id: fxBatch.id,
    change_id: CHG,
    actor_id: "fixture-user",
    role: "user",
    occurred_at: at,
    record_id: recordId,
    decision: "reject",
    task_id: null,
    accepted_by: "夹具用户",
    note,
  });
}
const entryBatch = evaluateProjectEntry({ project_id: fxBatch.id, role: ROLE }, { dataDir, now: NOW });
const batchReason = entryBatch.reasons.find((r) => r.code === "user_rejected_batch")?.text ?? "";
ok(
  entryBatch.next_action === "await_decision" &&
    batchReason.includes("acc-batch-real-later") &&
    batchReason.includes("真实更晚的那次退回"),
  `③-5 入口的批次退回取**真实时刻**最新那条（${batchReason.slice(0, 60)}…）`,
);
ok(
  !batchReason.includes("acc-batch-literal-bigger"),
  "③-5 且没有把字面序更大的那条当成最近一次批次退回",
);

// ── C4 entry 取最新待议（decisions.jsonl 里两条同 ref 的 proposed） ──
const fxDec = makeFixture("fx-dec");
approveBaseline(fxDec);
const decRef = { source: ".工作台/design.discuss.md", index: 1, content_sha256: sha256("夹具待议原文") };
const decLine = (decisionId: string, at: string, reason: string): string =>
  JSON.stringify({
    decision_id: decisionId,
    discussion_ref: decRef,
    action: "proposed",
    reason,
    decided_by: "v0601b-fixture",
    role: "coordinator",
    related: { baseline_id: null, design_revision: null, plan_revision: null, task_id: null },
    supersedes: null,
    applicable: { design_revision: null, plan_revision: null },
    at,
  });
write(
  path.join(fxDec.workDir, "decisions.jsonl"),
  [
    decLine("dec-literal-bigger", LITERAL_BIGGER, "字面更大"),
    decLine("dec-real-later", REAL_LATER, "真实更晚"),
  ].join("\n") + "\n",
);
const entryDec = evaluateProjectEntry({ project_id: fxDec.id, role: ROLE }, { dataDir, now: NOW });
const decReason = entryDec.reasons.find((r) => r.code === "await_decision_pending")?.text ?? "";
ok(
  entryDec.next_action === "await_decision" &&
    decReason.includes("dec-real-later") &&
    !decReason.includes("dec-literal-bigger"),
  `③-6 入口的「待议处置」取**真实时刻**最新那条（${decReason.slice(0, 60)}…）`,
);

// ── C5 executionReceipts：取最新检查点 / 最后信号 ──
const fxExec = makeFixture("fx-exec");
const defs = importTaskDefinitions(fxExec.plan, { plan_revision: sha256(fxExec.plan) }).definitions;
submitDefinitionImports(service, {
  project_id: fxExec.id,
  change_id: CHG,
  actor_id: "fixture-executor",
  role: "executor",
  definitions: defs,
});
const ws = path.join(fxExec.root, ".工作台", "runs", "T-1", "att-1");
const claimed = await claimTask(
  { project_id: fxExec.id, task_id: "T-1", role: ROLE, owner_id: OWNER, change_id: CHG, workspace: ws },
  submitter,
  dataDir,
);
if (!claimed.ok) throw new Error(`夹具缺陷：领取 fx-exec/T-1 失败：${claimed.code} ${claimed.message}`);
const execTarget: ExecutionTarget = {
  project_id: fxExec.id,
  execution_id: "ex-T-1-att-1",
  task_id: "T-1",
  run_id: claimed.claim.run_id,
  attempt_id: claimed.claim.attempt_id,
  attempt: claimed.claim.attempt,
  coordinator_id: OWNER,
  claim_token: claimed.claim.claim_token,
  owner_id: OWNER,
  owner_role: ROLE,
  change_id: CHG,
  workspace: ws,
  client_id: "kimi-code",
};
const startedReq = await recordStartRequested(
  { ...execTarget, goal: "夹具隔离执行", argv_digest: "sha256:fixture-argv", template_source: "夹具", timeout_ms: 600000 },
  submitter,
  dataDir,
);
if (!startedReq.ok) throw new Error(`夹具缺陷：启动请求失败：${startedReq.code} ${startedReq.message}`);
const startedRes = await recordStarted(
  { ...execTarget, client_version: "0.41.0", pid: 4242, argv_digest: "sha256:fixture-argv" },
  submitter,
  dataDir,
);
if (!startedRes.ok) throw new Error(`夹具缺陷：启动确认失败：${startedRes.code} ${startedRes.message}`);

for (const [at, note] of [
  [LITERAL_BIGGER, "早的心跳（字面更大）"],
  [REAL_LATER, "晚的心跳（字面更小）"],
] as const) {
  const hb = await recordHeartbeat({ ...execTarget, observed_at: at, note }, submitter, dataDir);
  if (!hb.ok) throw new Error(`夹具缺陷：心跳失败：${hb.code} ${hb.message}`);
}
const recAfterBeats = foldExecutions(eventsOf(fxExec)).find((r) => r.execution_id === "ex-T-1-att-1") ?? null;
const live = recAfterBeats === null ? null : livenessOf(recAfterBeats, NOW);
ok(
  live?.last_signal_at === REAL_LATER,
  `③-7 判活的「最后信号」取**真实时刻**最晚的那条（${live?.last_signal_at}，字面序会取 ${LITERAL_BIGGER}）`,
);

for (const [at, note] of [
  [LITERAL_BIGGER, "先的检查点（字面更大）"],
  [REAL_LATER, "后的检查点（字面更小）"],
] as const) {
  const cp = await recordCheckpoint({ ...execTarget, observed_at: at, note, artifacts: ["夹具成果"] }, submitter, dataDir);
  if (!cp.ok) throw new Error(`夹具缺陷：检查点失败：${cp.code} ${cp.message}`);
}
const probe: ExecutionProbe = {
  process: () => ({ state: "gone", checked_by: "夹具探针", evidence: ["夹具：进程已不存在"] }),
  workspace: () => ({ exists: true, dirty: false, changed_files: [], head: null, errors: [] }),
  effect: (effect) => ({
    effect_id: effect.effect_id,
    status: "unverifiable",
    result_ref: null,
    checked_by: "夹具探针",
    evidence: "夹具：不查外部效果",
  }),
};
const recovery = await planRecovery({ project_id: fxExec.id, execution_id: "ex-T-1-att-1", probe, dataDir, now: NOW });
const plan = recovery.ok ? recovery.plan : null;
ok(
  plan?.last_checkpoint?.note === "后的检查点（字面更小）" && plan?.last_checkpoint?.at === REAL_LATER,
  `③-8 恢复第一步的「最后检查点」取**真实时刻**最晚的那条（${plan?.last_checkpoint?.note ?? "无"}）`,
);

// 执行回执的折叠同样按 seq：把事件数组整体反序，结论不变
const execEvents = eventsOf(fxExec);
const cpNotes = (rs: ReturnType<typeof foldExecutions>): string =>
  (rs.find((r) => r.execution_id === "ex-T-1-att-1")?.checkpoints ?? []).map((c) => c.note).join(" / ");
const foldedForward = cpNotes(foldExecutions(execEvents));
const foldedReversed = cpNotes(foldExecutions([...execEvents].reverse()));
ok(
  foldedForward === foldedReversed && foldedForward.includes("先的检查点"),
  `③-9 foldExecutions 按 seq 折叠（事件数组反序结果一致：${foldedReversed}）`,
);

// ── C6 pickCheckRecords 同档取最新 ──
const mkCheck = (over: Partial<CheckInput> & Pick<CheckInput, "at" | "result">): CheckInput => ({
  check_id: "chk-1",
  object_id: "T-1",
  actor_id: "fixture",
  role: "executor",
  independence: "author_self",
  binding: { revision_kind: "code", revision: "code-1" },
  evidence_sha256: null,
  ...over,
});
const pickedSelf = pickCheckRecords([
  mkCheck({ at: LITERAL_BIGGER, result: "passed" }),
  mkCheck({ at: REAL_LATER, result: "failed" }),
]).get("chk-1");
ok(pickedSelf?.result === "failed", `③-10 同一 check_id 同档取**真实时刻**最新（${pickedSelf?.result}）`);

const pickedWithIllegal = pickCheckRecords([
  mkCheck({ at: REAL_LATER, result: "failed" }),
  mkCheck({ at: ILLEGAL_TIME, result: "passed" }),
]).get("chk-1");
ok(
  pickedWithIllegal?.result === "failed",
  "③-10 时间非法的检查记录抢不走已有结论（不因为写在后面就被当成最新）",
);
const pickedIndependent = pickCheckRecords([
  mkCheck({ at: REAL_LATER, result: "passed" }),
  mkCheck({ at: "2026-09-21T00:00:00Z", result: "failed", independence: "independent", actor_id: "auditor" }),
]).get("chk-1");
ok(
  pickedIndependent?.independence === "independent",
  "③-10 独立审计仍优先于作者自检（换比较器没有把更强的一条挤掉）",
);
// 有效独立性（附录 E.3.4）：被降级的「独立」记录不享受独立优先——
// ① actor 是作者换壳写法（大小写差异）⇒ 降为 author_self，同档取最新（fresh 作者自检上屏）；
// ② 声明与作者同一会话 ⇒ 降为 author_self；
// ③ 真独立（他人、不同会话）即使更旧仍然优先（防作者用新自检埋掉独立结论）。
const authorSet = new Set(["Kimi Code"]);
const degradedCase = pickCheckRecords(
  [
    mkCheck({ at: "2026-09-23T21:10:00+08:00", result: "passed", independence: "independent", actor_id: "kimi-code" }),
    mkCheck({ at: "2026-09-25T11:25:53+08:00", result: "passed", actor_id: "Kimi Code" }),
  ],
  authorSet,
).get("chk-1");
ok(
  degradedCase?.actor_id === "Kimi Code",
  `③-10 换壳作者（kimi-code≈Kimi Code）的「独立」记录降级 ⇒ fresh 作者自检按同档最新上屏（选中 ${degradedCase?.actor_id}）`,
);
const degradedSession = pickCheckRecords(
  [
    mkCheck({
      at: "2026-09-23T21:10:00+08:00",
      result: "passed",
      independence: "independent",
      actor_id: "someone-else",
      audit_independence: { record_id: "r-x", same_session_as_author: true, read_author_summary_first: false, one_hash_per_record: false },
    }),
    mkCheck({ at: "2026-09-25T11:25:53+08:00", result: "passed", actor_id: "Kimi Code" }),
  ],
  authorSet,
).get("chk-1");
ok(
  degradedSession?.actor_id === "Kimi Code",
  `③-10 同会话声明的「独立」记录降级（E.3.4-3）⇒ fresh 作者自检上屏（选中 ${degradedSession?.actor_id}）`,
);
const trueIndependent = pickCheckRecords(
  [
    mkCheck({ at: "2026-09-25T11:25:53+08:00", result: "passed", actor_id: "Kimi Code" }),
    mkCheck({ at: "2026-09-21T00:00:00Z", result: "failed", independence: "independent", actor_id: "auditor" }),
  ],
  authorSet,
).get("chk-1");
ok(
  trueIndependent?.actor_id === "auditor",
  `③-10 真独立（非作者、不同会话）不受降级影响，仍优先于更新的作者自检（选中 ${trueIndependent?.actor_id}）`,
);
// 现行语义（传 revisions；§5.6 复验路径）：
// ④ 陈旧独立「通过」（stale）让位给当前有效的作者复验（质量维仍如实给 mechanical 档）；
// ⑤ 但独立的**失败**结论永远压住一切（失败不随源漂移失效，作者不许用新自检埋掉独立否决）。
const revCurrent = { code: "code-1", plan: "plan-1", design: null, interface: null } as never;
const freshAuthorWins = pickCheckRecords(
  [
    mkCheck({
      at: "2026-09-23T21:10:00+08:00",
      result: "passed",
      independence: "independent",
      actor_id: "auditor",
      binding: { revision_kind: "code", revision: "code-old" },
      evidence_sha256: "e".repeat(64),
      method: "m",
    }),
    mkCheck({ at: "2026-09-25T11:25:53+08:00", result: "passed", actor_id: "Kimi Code", evidence_sha256: "f".repeat(64), method: "m" }),
  ],
  authorSet,
  revCurrent,
).get("chk-1");
ok(
  freshAuthorWins?.actor_id === "Kimi Code",
  `③-10 陈旧独立「通过」让位给当前有效的作者复验（选中 ${freshAuthorWins?.actor_id}；独立旧绿保留在历史）`,
);
const independentFailSticks = pickCheckRecords(
  [
    mkCheck({
      at: "2026-09-21T00:00:00Z",
      result: "failed",
      independence: "independent",
      actor_id: "auditor",
      binding: { revision_kind: "code", revision: "code-old" },
      evidence_sha256: "e".repeat(64),
      method: "m",
    }),
    mkCheck({ at: "2026-09-25T11:25:53+08:00", result: "passed", actor_id: "Kimi Code", evidence_sha256: "f".repeat(64), method: "m" }),
  ],
  authorSet,
  revCurrent,
).get("chk-1");
ok(
  independentFailSticks?.actor_id === "auditor",
  `③-10 独立失败永不埋：陈旧与否都压住后来的作者「通过」（选中 ${independentFailSticks?.actor_id}）`,
);

// ── C7 index.ts：真后端的 reportTimes（GET /api/projects/:id/activity） ──
const spawned: ChildProcess[] = [];
process.on("exit", () => {
  for (const proc of spawned) {
    try {
      if (proc.exitCode === null) proc.kill("SIGKILL");
    } catch {
      // 已经没了
    }
  }
});
const portListening = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const sock = net.connect({ port, host: "127.0.0.1" });
    const done = (busy: boolean) => {
      sock.destroy();
      resolve(busy);
    };
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
    sock.setTimeout(1000, () => done(false));
  });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function activityOf(
  projectId: string,
): Promise<{ last_change_at: string | null; last_task_report_at: string | null } | null> {
  const r = await fetch(`${BASE}/api/projects/${encodeURIComponent(projectId)}/activity`);
  const body = (await r.json()) as {
    ok?: boolean;
    activity?: { last_change_at: string | null; last_task_report_at: string | null };
  };
  return r.ok && body.ok === true && body.activity !== undefined ? body.activity : null;
}

const busy = await portListening(PORT);
ok(!busy, `③-11 端口 ${PORT} 空闲（被占用会撞出假失败，先确认没有别套件在跑）`);
if (!busy) {
  const server = spawn(process.execPath, ["--import", "tsx", path.join("src", "server", "index.ts")], {
    cwd: process.cwd(),
    env: { ...process.env, TATAI_HOME: dataDir, TATAI_PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  spawned.push(server);
  server.stdout.on("data", (d: Buffer) => {
    if (process.env.TATAI_VERBOSE === "1") process.stdout.write(`[server] ${d.toString()}`);
  });
  server.stderr.on("data", (d: Buffer) => process.stderr.write(`[server] ${d.toString()}`));
  let up = false;
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) {
        up = true;
        break;
      }
    } catch {
      // 还没起来
    }
    await sleep(250);
  }
  ok(up, `③-11 后端在 ${BASE} 就绪`);
  if (up) {
    const first = await activityOf(fxLatest.id);
    ok(
      first?.last_task_report_at === REAL_LATER && first?.last_change_at === null,
      `③-11 GET /activity 的 last_task_report_at 取**真实时刻**最晚的 updated_at（${first?.last_task_report_at}）`,
    );
    // 换成另一对时刻（真实最晚的那条仍然字面更小）→ 结论跟着换，且仍按真实时刻走（排除缓存/巧合）
    writeTasksJson(fxLatest.id, [
      { id: "T-report-1", updated_at: FX_SWAP_LITERAL_BIGGER },
      { id: "T-report-2", updated_at: FX_SWAP_REAL_LATER },
    ]);
    const swapped = await activityOf(fxLatest.id);
    ok(
      swapped?.last_task_report_at === FX_SWAP_REAL_LATER,
      `③-11 换成另一对时刻后结论跟着换（${swapped?.last_task_report_at}）：判据确实按真实时刻走，不是缓存或巧合`,
    );
    // 全部为非法时间 → null（不把非法值当最近上报）
    writeTasksJson(fxLatest.id, [
      { id: "T-report-1", updated_at: ILLEGAL_TIME },
      { id: "T-report-2", updated_at: "" },
    ]);
    const illegal = await activityOf(fxLatest.id);
    ok(
      illegal !== null && illegal.last_task_report_at === null,
      `③-11 上报时间全都解析不出来 → last_task_report_at = null（现场 ${JSON.stringify(illegal)}）`,
    );
  }
  if (server.exitCode === null) server.kill("SIGKILL");
}

// ══════════════════════════════════════════════════════════════════════════
// ③-12 任务账读口径：v1 台账 + 无关 v2 事件不得被整体吞掉
//      （缺陷 f-c7d3ec36339dc919 的回归断言；现场：readTaskLedger 以「events.jsonl 是否存在」
//       为唯一开关，项目写过任意一条 v2 事件就整份改走 v2 投影，v1 里存在而 v2 没有 task:* 事实的
//       任务行整体消失 → listTasks 返回 []、/activity.last_task_report_at = null）
// ══════════════════════════════════════════════════════════════════════════
console.log("[verify] ═══ ③-12 任务账读口径：v1 台账 + 无关 v2 事件（缺陷 f-c7d3ec36339dc919） ═══");
{
  const fxLedger = makeFixture("fx-ledger", { tasksJson: true });

  // (1) 只有 v1 台账（项目还没有任何 v2 事件）→ 如实退回 v1
  const led0 = readTaskLedger(fxLedger.id, dataDir);
  ok(
    led0.source === "v1_file" && led0.rows.length === 2 && led0.rows.every((r) => r.ledger_source === "v1_file" && r.v2_status === null),
    `③-12 只有 v1 台账（无 v2 事件）：source=${led0.source} rows=${led0.rows.length}，每行标 ledger_source=v1_file`,
  );

  // (2) 只写一条**无关**的 v2 事件（审计记录，不是 task:*）→ v1 台账不得整体消失
  submitSubmission(submitter, {
    project_id: fxLedger.id,
    change_id: CHG,
    actor_id: "fixture-auditor",
    role: "executor",
    record_id: "sub-unrelated-1",
    goal: "一条与任务台账无关的结果提交记录",
    submitted_by: "fixture-auditor",
  });
  const led1 = readTaskLedger(fxLedger.id, dataDir);
  const idsOf = (rs: { id: string }[]) => rs.map((r) => r.id).join(",");
  ok(
    led1.rows.length === 2 && idsOf(led1.rows) === "T-report-1,T-report-2" && led1.source === "v1_file",
    `③-12 写过无关 v2 事件后 v1 台账**不得整体消失**（source=${led1.source} rows=${led1.rows.length} ids=${idsOf(led1.rows)}）`,
  );
  const listed = listTasks(fxLedger.id, dataDir);
  ok(listed.length === 2, `③-12 listTasks 同样不得空集（实际 ${listed.length} 行）`);

  // (3) 混合：v2 只有另一张卡的事实（卡 T-1 不在 v1 台账里）→ 两边都要在，逐行标来源
  const defsLedger = importTaskDefinitions(fxLedger.plan, { plan_revision: sha256(fxLedger.plan) }).definitions;
  submitDefinitionImports(submitter, {
    project_id: fxLedger.id,
    change_id: CHG,
    actor_id: "fixture-executor",
    role: "executor",
    definitions: defsLedger,
  });
  submitTaskStatus(submitter, {
    project_id: fxLedger.id,
    task_id: "T-1",
    change_id: CHG,
    actor_id: "fixture-executor",
    role: "executor",
    expected_revision: 1,
    status: "executing",
  });
  const led2 = readTaskLedger(fxLedger.id, dataDir);
  const t1 = led2.rows.find((r) => r.id === "T-1");
  const rep1 = led2.rows.find((r) => r.id === "T-report-1");
  ok(
    led2.rows.length === 3 && led2.source === "v2_events+v1_fallback" &&
      t1?.v2_status === "executing" && t1?.ledger_source === "v2_events" &&
      rep1?.v2_status === null && rep1?.ledger_source === "v1_file",
    `③-12 混合账：v2 事实 + v1 回退行**都在**（source=${led2.source} rows=${led2.rows.length}：${
      led2.rows.map((r) => `${r.id}/${r.ledger_source}`).join("、")
    }）`,
  );

  // (4) 同一张卡两边都有 → v2 状态为准，v1 里人填的 title/module_id/note 不丢
  writeTasksJson(fxLedger.id, [
    { id: "T-1", updated_at: REAL_LATER },
    { id: "T-report-1", updated_at: LITERAL_BIGGER },
    { id: "T-report-2", updated_at: REAL_LATER },
  ]);
  const led3 = readTaskLedger(fxLedger.id, dataDir);
  const t1b = led3.rows.find((r) => r.id === "T-1");
  ok(
    led3.rows.length === 3 && t1b?.v2_status === "executing" && t1b?.title === "夹具任务 T-1" && t1b?.module_id === "m1" &&
      t1b?.ledger_source === "v2_events" && (led3.v1_fallback_ids ?? []).join(",") === "T-report-1,T-report-2",
    `③-12 同一张卡两边都有：v2 状态为准、v1 人填字段保留（status=${t1b?.v2_status} title=${t1b?.title} module=${t1b?.module_id}；回退行=${(led3.v1_fallback_ids ?? []).join(",")}）`,
  );
}

// ══════════════════════════════════════════════════════════════════════════
console.log("[verify] ═══ 收尾 ═══");
if (process.env.TATAI_KEEP_TMP === "1") {
  info(`保留现场：${tmpBase}`);
} else {
  fs.rmSync(tmpBase, { recursive: true, force: true });
  info(`夹具已清理：${path.basename(tmpBase)}`);
}
console.log(`[verify] 汇总：${passCount} PASS / ${failCount} FAIL`);
