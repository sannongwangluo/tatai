// P2 验证脚本（tsx 跑）：跨项目汇总接口的口径逐条对照 + 只读红线 + 性能（PLAN.md P2 卡 DoD②/④）。
//
// 用法：pnpm verify:p2
//
// 覆盖点：
//   ① DoD②（硬要求）把 P1 `src/server/projects-summary.ts` 的 ROW_FIELDS / SORT_RULE /
//      SEVERITY_ORDER / LIVE_CONSISTENCY_MAP **逐条**对着 `GET /api/summary/projects` 的实际返回核一遍，
//      每条打印 `P1 对照物｜实测`；外加**源码级断言**：汇总函数调用点唯一（只有 src/server/summary.ts 调 P1），
//      且 summary.ts 复用 live.ts#readProgressReadonly（不另写第二套「缺文件合成」）；
//   ② 只读红线：临时项目 .工作台 全量哈希快照 + 真实项目关键文件指纹，调用前后零变化（不发监听、不 touch 注册表）；
//   ③ 分桶口径：groups 是同一批行的分组渲染（步序 = GATE_STEPS 声明序，组内保持 rows 顺序）；
//   ④ DoD④：真实项目同屏耗时（TATAI_REAL_HOME 指定真实数据目录；只读、只打印耗时与条数，不打印任何内容）。
//
// 环境：全部 fixture 数据现造在 os.tmpdir() 里，用独立 TATAI_HOME 起临时后端，动态端口 + /health 探活；
// 不碰真实注册表、不碰任何真实项目的文件（真实段也只读）。跑完杀进程、清临时目录。

import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { addProject, resolveDataDir } from "../src/server/registry";
import { GATE_STEPS } from "../src/server/workstation";
import {
  LIVE_CONSISTENCY_MAP,
  ROW_EXCLUDED_FIELDS,
  ROW_FIELDS,
  SEVERITY_ORDER,
  SORT_BUCKETS,
  SORT_RULE,
} from "../src/server/projects-summary";
import type { ProjectSummaryRow } from "../src/server/projects-summary";
import type { ProjectsSummaryPayload } from "../src/server/summary";
import type { LiveSnapshot } from "../src/server/live";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const ok = (cond: boolean, label: string) => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (!cond) process.exitCode = 1;
};
const info = (label: string) => console.log(`[verify] ---- ${label}`);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ───────────────────────────── 动态端口 + 子进程管理 ─────────────────────────────

/** 动态端口：向系统要一个空闲端口（listen(0) 拿端口后关掉），不用固定端口占别人的服务 */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

function portListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: "127.0.0.1" });
    const done = (busy: boolean) => {
      sock.destroy();
      resolve(busy);
    };
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
    sock.setTimeout(1000, () => done(false));
  });
}

interface Server {
  proc: ChildProcess;
  base: string;
  up: boolean;
}

/** 起后端（动态端口 + 独立数据目录）+ /health 探活；子进程提前退出立刻报错，不赌运气 */
async function startServer(dataDir: string, tag: string): Promise<Server> {
  const port = await freePort();
  if (await portListening(port)) throw new Error(`动态端口 ${port} 拿到手就被占了，重跑`);
  const proc = spawn(
    process.execPath,
    ["--import", "tsx", path.join("src", "server", "index.ts")],
    {
      env: { ...process.env, TATAI_HOME: dataDir, TATAI_PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
      cwd: REPO_ROOT,
    },
  );
  const base = `http://127.0.0.1:${port}`;
  const state: Server = { proc, base, up: false };
  proc.stderr?.on("data", (d: Buffer) => process.stderr.write(`[${tag}] ${d}`));
  proc.on("error", (e) => {
    console.error(`[verify] ${tag} 子进程起不来：${e.message}`);
    process.exit(1);
  });
  proc.once("exit", (code) => {
    if (state.up) return; // 脚本自己收尾杀的
    console.error(`[verify] ${tag} 后端在就绪前退出（code=${code}），先清理残留进程`);
    process.exit(1);
  });
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${base}/health`);
      if (r.ok) {
        state.up = true;
        console.log(`[verify] ${tag} 后端就绪：${base}（TATAI_HOME=${dataDir}）`);
        return state;
      }
    } catch {
      // 还没起来，继续探
    }
    await sleep(200);
  }
  proc.kill();
  throw new Error(`${tag} 后端 12 秒内未就绪`);
}

async function api(base: string, method: string, rawPath: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}${rawPath}`, { method });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

// ───────────────────────────── 只读快照工具 ─────────────────────────────

const sha256 = (p: string) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");

/** 目录全量文件哈希快照（临时 fixture 用：文件少，全量哈希最硬） */
function snapshotTree(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.set(path.relative(dir, p).split(path.sep).join("/"), sha256(p));
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

/** 定点指纹（真实项目用：只碰汇总层可能触达的那几个文件，不动 3.8G 的项目数据目录） */
function fingerprint(paths: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of paths) {
    if (!fs.existsSync(p)) {
      out.set(p, "absent");
      continue;
    }
    const st = fs.statSync(p);
    out.set(p, st.size <= 2 * 1024 * 1024 ? `sha256:${sha256(p)}` : `size=${st.size};mtime=${st.mtimeMs}`);
  }
  return out;
}

function diffMaps(before: Map<string, string>, after: Map<string, string>): string[] {
  const diffs: string[] = [];
  for (const k of new Set([...before.keys(), ...after.keys()])) {
    if (before.get(k) !== after.get(k)) diffs.push(`${k}: ${before.get(k)} → ${after.get(k)}`);
  }
  return diffs;
}

// ───────────────────────────── fixture：六个临时项目 ─────────────────────────────

const TS = {
  blockedTask: "2026-09-18T08:00:00+08:00",
  doneTask: "2026-09-18T09:00:00+08:00",
  blockedGate: "2026-09-18T07:00:00+08:00",
  blockedChange: "2026-09-18T06:00:00+08:00",
  doingTaskA: "2026-09-18T05:00:00+08:00",
  doingTaskB: "2026-09-18T04:00:00+08:00",
  utcChange: "2026-09-17T20:30:00Z", // = 2026-09-18T04:30+08：字符串比较会排到 fresh 后面（跨时区坑，H2 踩过）
  freshChangeNew: "2026-09-18T03:00:00+08:00",
  freshChangeOld: "2026-09-18T02:00:00+08:00",
} as const;

/** progress.json（history 七步齐全，validateProgress 要求） */
function progressJson(
  currentStep: string,
  modules: readonly { id: string; name: string; status: string }[],
  results: Readonly<Record<string, "pass" | "reject">> = {},
): string {
  return JSON.stringify(
    {
      version: 1,
      gate: {
        current_step: currentStep,
        history: GATE_STEPS.map((s) => ({
          step: s.id,
          result: results[s.id] ?? "pending",
          at: results[s.id] ? TS.blockedGate : null,
          note: null,
        })),
      },
      modules,
    },
    null,
    2,
  );
}

function tasksJson(
  rows: readonly [string, string, string, string, string][] // id,title,module_id,status,updated_at
): string {
  return JSON.stringify(
    {
      version: 1,
      tasks: rows.map(([id, title, module_id, status, updated_at]) => ({
        id,
        title,
        module_id,
        status,
        reporter: "Kimi Code",
        updated_at,
      })),
    },
    null,
    2,
  );
}

const gateLinesJsonl = (...tsList: string[]) =>
  tsList.map((ts) => JSON.stringify({ ts, step: "requirement", result: "reject", by: "user", note: "测试" })).join("\n") + "\n";

const changeLinesJsonl = (...tsList: string[]) =>
  tsList
    .map((ts) => JSON.stringify({ ts, path: "src/x.ts", action: "modify", size_delta: 1 }))
    .join("\n") + "\n";

interface Fixture {
  id: string;
  name: string;
  kind: "backend" | "frontend" | "fullstack" | "static";
  files: Record<string, string>;
}

/** 六个 fixture：覆盖三个排序桶、四色归约、空项目（无 progress）、跨时区时间比较、并列兜底 */
const FIXTURES: readonly Fixture[] = [
  {
    id: "p2-blocked",
    name: "甲乙（有卡住的）",
    kind: "backend",
    files: {
      ".工作台/progress.json": progressJson(
        "requirement",
        [
          { id: "m1", name: "模块一", status: "issue" },
          { id: "m2", name: "模块二", status: "done" },
        ],
        { requirement: "reject" },
      ),
      ".工作台/tasks.json": tasksJson([
        ["t1", "卡住的任务", "m1", "blocked", TS.blockedTask],
        ["t2", "完成的任务", "m2", "done", TS.doneTask],
      ]),
      ".工作台/gate.jsonl": gateLinesJsonl(TS.blockedGate),
      ".工作台/changes.jsonl": changeLinesJsonl(TS.blockedChange),
    },
  },
  {
    id: "p2-doing",
    name: "丙丁（在做的）",
    kind: "frontend",
    files: {
      ".工作台/progress.json": progressJson("develop", [
        { id: "m1", name: "模块一", status: "doing" },
        { id: "m2", name: "模块二", status: "todo" },
        { id: "m3", name: "模块三", status: "done" },
      ]),
      ".工作台/tasks.json": tasksJson([
        ["t1", "在做的任务", "m1", "doing", TS.doingTaskA],
        ["t2", "待办任务", "m2", "todo", TS.doingTaskB],
      ]),
    },
  },
  {
    // 红（issue）+ 打回（reject）+ 没任务：排序桶仍是 2（静止的）——用来证 severity / gate.result 不进排序键
    id: "p2-utc",
    name: "戊己（红但静止）",
    kind: "fullstack",
    files: {
      ".工作台/progress.json": progressJson(
        "develop",
        [
          { id: "m1", name: "模块一", status: "issue" },
          { id: "m2", name: "模块二", status: "doing" },
        ],
        { develop: "reject" },
      ),
      ".工作台/changes.jsonl": changeLinesJsonl(TS.utcChange),
    },
  },
  {
    // 无 progress.json：缺文件按初始态合成（第一步 + pending），模块 0 个 → severity 必须是 null 而不是灰
    id: "p2-fresh",
    name: "庚辛（缺 progress）",
    kind: "static",
    files: {
      ".工作台/changes.jsonl": changeLinesJsonl(TS.freshChangeOld, TS.freshChangeNew),
    },
  },
  { id: "p2-quiet-b", name: "壬癸（全空 B）", kind: "backend", files: {} },
  { id: "p2-quiet-c", name: "子丑（全空 C）", kind: "backend", files: {} },
];

/** 手写期望值（**不由 P1 推导**，否则就是自己验自己）：排序桶 / 严重度 / 计数 / Gate / 活动时间 */
const EXPECT: Record<
  string,
  {
    bucket: number;
    severity: string | null;
    modules: { todo: number; doing: number; done: number; issue: number; total: number };
    tasks: { todo: number; doing: number; done: number; blocked: number };
    gate: { current_step: string; step_name: string; result: string };
    activity: string | null;
    why: string;
  }
> = {
  "p2-blocked": {
    bucket: 0,
    severity: "issue",
    modules: { todo: 0, doing: 0, done: 1, issue: 1, total: 2 },
    tasks: { todo: 0, doing: 0, done: 1, blocked: 1 },
    gate: { current_step: "requirement", step_name: "需求", result: "reject" },
    activity: TS.doneTask,
    why: "blocked=1 → 桶 0；issue 压过 done；三源最大 = 完成任务的 updated_at",
  },
  "p2-doing": {
    bucket: 1,
    severity: "doing",
    modules: { todo: 1, doing: 1, done: 1, issue: 0, total: 3 },
    tasks: { todo: 1, doing: 1, done: 0, blocked: 0 },
    gate: { current_step: "develop", step_name: "开发", result: "pending" },
    activity: TS.doingTaskA,
    why: "blocked=0 且 doing=1 → 桶 1；无issue → doing 是最严重色；无 gate/changes，最大 updated_at",
  },
  "p2-utc": {
    bucket: 2,
    severity: "issue",
    modules: { todo: 0, doing: 1, done: 0, issue: 1, total: 2 },
    tasks: { todo: 0, doing: 0, done: 0, blocked: 0 },
    gate: { current_step: "develop", step_name: "开发", result: "reject" },
    activity: TS.utcChange,
    why: "无任务 → 桶 2（红 + 打回都不进排序键）；changes 是 UTC 写法，需按毫秒比才排对",
  },
  "p2-fresh": {
    bucket: 2,
    severity: null,
    modules: { todo: 0, doing: 0, done: 0, issue: 0, total: 0 },
    tasks: { todo: 0, doing: 0, done: 0, blocked: 0 },
    gate: { current_step: "kickoff", step_name: "立项", result: "pending" },
    activity: TS.freshChangeNew,
    why: "缺 progress.json → 初始态（第一步 pending）；无模块 → severity null（不冒充灰）；changes 两行取最新",
  },
  "p2-quiet-b": {
    bucket: 2,
    severity: null,
    modules: { todo: 0, doing: 0, done: 0, issue: 0, total: 0 },
    tasks: { todo: 0, doing: 0, done: 0, blocked: 0 },
    gate: { current_step: "kickoff", step_name: "立项", result: "pending" },
    activity: null,
    why: "四个源全无 → 活动时间 null（排最后）",
  },
  "p2-quiet-c": {
    bucket: 2,
    severity: null,
    modules: { todo: 0, doing: 0, done: 0, issue: 0, total: 0 },
    tasks: { todo: 0, doing: 0, done: 0, blocked: 0 },
    gate: { current_step: "kickoff", step_name: "立项", result: "pending" },
    activity: null,
    why: "同 quiet-b，用于验并列按 project_id 升序兜底",
  },
};

/** 期望行序（照 SORT_RULE 三级键手推）：桶升序 → 最近活动倒序（null 最后）→ project_id 升序 */
const EXPECTED_ORDER = ["p2-blocked", "p2-doing", "p2-utc", "p2-fresh", "p2-quiet-b", "p2-quiet-c"];

/** 期望分桶：步序 = GATE_STEPS 声明序，空步也列（服务端 includeEmptySteps:true） */
const EXPECTED_GROUPS: readonly { step: string; ids: string[] }[] = [
  { step: "kickoff", ids: ["p2-fresh", "p2-quiet-b", "p2-quiet-c"] },
  { step: "requirement", ids: ["p2-blocked"] },
  { step: "design", ids: [] },
  { step: "tasks", ids: [] },
  { step: "develop", ids: ["p2-doing", "p2-utc"] },
  { step: "verify", ids: [] },
  { step: "deliver", ids: [] },
];

// ───────────────────────────── 主流程 ─────────────────────────────

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-p2-verify-"));
const dataDir = path.join(tmpBase, "home");
fs.mkdirSync(dataDir, { recursive: true });

const projDirs = new Map<string, string>();
for (const f of FIXTURES) {
  const dir = path.join(tmpBase, f.id);
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(f.files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, "utf8");
  }
  addProject({ id: f.id, name: f.name, path: dir, kind: f.kind }, dataDir);
  projDirs.set(f.id, dir);
}

let tmpServer: Server | undefined;
let realServer: Server | undefined;

try {
  // ═══════════════════ 第 1 段：口径逐条对照（临时 fixture） ═══════════════════
  tmpServer = await startServer(dataDir, "临时");
  const base = tmpServer.base;

  const beforeTree = new Map<string, string>();
  for (const [id, dir] of projDirs) for (const [k, v] of snapshotTree(path.join(dir, ".工作台"))) beforeTree.set(`${id}/${k}`, v);
  const beforeRegistry = sha256(path.join(dataDir, "registry.json"));

  info("DoD②-a：ROW_FIELDS 逐条对照（P1 字段定义表 vs 实际返回行）");
  const first = await api(base, "GET", "/api/summary/projects");
  ok(first.status === 200 && first.body.ok === true, `GET /api/summary/projects → 200 ok:true（实际: ${first.status}）`);
  const summary = first.body.summary as ProjectsSummaryPayload;
  const rows = summary.rows;
  ok(Array.isArray(rows) && rows.length === FIXTURES.length, `行数 = 登记项目数 ${FIXTURES.length}（实际: ${rows.length}）`);
  ok(summary.errors.length === 0, `读失败项目 0 个（实际: ${JSON.stringify(summary.errors)}）`);

  const ALLOWED_ROW_KEYS = ["project_id", "name", "kind", "self_managed", "gate", "module_status_counts", "severity", "task_counts", "last_activity_at"];
  let fieldsPass = true;
  for (const spec of ROW_FIELDS) {
    const paths = spec.field.split(" / ");
    let hit = "";
    let miss = "";
    for (const p of paths) {
      const v = valueAt(rows[0], p);
      const present = v !== undefined;
      if (!present) miss += `${p} `;
      hit += `${p}=${JSON.stringify(v)} `;
    }
    const pass = miss === "";
    fieldsPass = fieldsPass && pass;
    console.log(`[verify] ${pass ? "PASS" : "FAIL"} 对照 ROW_FIELDS「${spec.field}」`);
    console.log(`[verify]        口径: ${spec.rule}`);
    console.log(`[verify]        来源: ${spec.source}｜进排序键: ${spec.in_sort_key ? "是" : "否"}`);
    console.log(`[verify]        实测(第 1 行): ${hit.trim()}${miss ? `｜缺: ${miss.trim()}` : ""}`);
  }
  ok(fieldsPass, `ROW_FIELDS ${ROW_FIELDS.length} 条字段在返回行上全部落地`);

  const extraKeys = allRowKeys(rows).filter((k) => !ALLOWED_ROW_KEYS.includes(k));
  ok(extraKeys.length === 0, `行的字段集合 = ROW_FIELDS 定义的那几个，无未登记字段（多出: ${JSON.stringify(extraKeys)}）`);
  ok(
    ALLOWED_ROW_KEYS.every((k) => allRowKeys(rows).includes(k)),
    `ROW_FIELDS 的顶层字段一个不少（实际: ${JSON.stringify(allRowKeys(rows))}）`,
  );
  ok(
    keysOf(rows[0].gate) === "current_step,step_name,result" &&
      keysOf(rows[0].module_status_counts) === "todo,doing,done,issue,total" &&
      keysOf(rows[0].task_counts) === "todo,doing,done,blocked",
    "嵌套字段形状与 P1 定义同形（gate / module_status_counts / task_counts 的子键）",
  );
  console.log(`[verify]        实测(第 1 行) 子键: gate=${keysOf(rows[0].gate)}｜模块=${keysOf(rows[0].module_status_counts)}｜任务=${keysOf(rows[0].task_counts)}`);

  const FORBIDDEN = ["stage", "current_task", "path", "last_opened_at", "last_change_at", "last_task_report_at", "history", "modules", "events", "actor"];
  const leaked = allRowKeys(rows).filter((k) => FORBIDDEN.includes(k));
  ok(leaked.length === 0, `ROW_EXCLUDED_FIELDS 明确不进行的字段没被顺手加回来（漏进来: ${JSON.stringify(leaked)}）`);
  console.log(`[verify]        P1 明确不进行的字段（${ROW_EXCLUDED_FIELDS.length} 条，原文口径）:`);
  for (const e of ROW_EXCLUDED_FIELDS) console.log(`[verify]          · ${e.field} —— ${e.reason.slice(0, 60)}…`);

  info("DoD②-b：SORT_RULE 逐条对照（三级键 + 明确不进键的字段）");
  const order = rows.map((r) => r.project_id);
  ok(
    order.join(",") === EXPECTED_ORDER.join(","),
    `排序键① 桶升序 ② 最近活动倒序(null 最后) ③ project_id 升序 → 顺序 ${order.join(" > ")}（期望 ${EXPECTED_ORDER.join(" > ")}）`,
  );
  ok(
    rows.every((r) => r.task_counts.blocked > 0 === (EXPECT[r.project_id].bucket === 0)),
    `桶 0（有卡住的）落在最前：${rows[0].project_id}[blocked=${rows[0].task_counts.blocked}] > ${rows[1].project_id}[doing=${rows[1].task_counts.doing}]`,
  );
  console.log(`[verify]        P1 桶定义（SORT_BUCKETS）: ${SORT_BUCKETS.map((b) => `${b.order}=${b.label}(${b.when})`).join("｜")}`);
  console.log(`[verify]        P1 键序（SORT_RULE.key_order）: ${SORT_RULE.key_order.join(" → ")}`);
  console.log(`[verify]        P1 末级兜底: ${SORT_RULE.tie_breaker}`);
  const sameBucketPairs: string[] = [];
  let bucketPass = true;
  for (let i = 1; i < rows.length; i++) {
    const a = EXPECT[rows[i - 1].project_id];
    const b = EXPECT[rows[i].project_id];
    if (a.bucket !== b.bucket) continue;
    const idA = rows[i - 1].project_id;
    const idB = rows[i].project_id;
    const ta = ms(rows[i - 1].last_activity_at);
    const tb = ms(rows[i].last_activity_at);
    // 键②：最近活动倒序、无活动排最后；键③：时间相同（含都无活动）按 project_id 升序兜底
    let pass: boolean;
    if (ta === null) pass = tb === null && idA < idB;
    else if (tb === null) pass = true; // 有活动排在无活动之前
    else pass = ta > tb || (ta === tb && idA < idB);
    sameBucketPairs.push(`${idA}[${rows[i - 1].last_activity_at ?? "无活动"}] vs ${idB}[${rows[i].last_activity_at ?? "无活动"}] → ${pass ? "OK" : "错序"}`);
    bucketPass = bucketPass && pass;
  }
  ok(
    bucketPass,
    `同桶内最近活动倒序（null 最后、并列按 id 升序兜底）：${sameBucketPairs.join("；")}`,
  );
  ok(
    rows[2].project_id === "p2-utc" && rows[3].project_id === "p2-fresh",
    `跨时区比较按毫秒：UTC 写法 ${TS.utcChange}(=04:30+08) 排在 ${TS.freshChangeNew} 之前（字符串比较会反过来）`,
  );
  ok(
    rows[4].project_id === "p2-quiet-b" && rows[5].project_id === "p2-quiet-c",
    `两个无活动项目按 project_id 升序兜底：${rows[4].project_id} > ${rows[5].project_id}`,
  );
  // 反证：severity / gate.result 若进了键，顺序会变
  const bySeverity = [...rows].sort(
    (x, y) => SEVERITY_ORDER.indexOf(x.severity as never) - SEVERITY_ORDER.indexOf(y.severity as never),
  );
  ok(
    bySeverity.map((r) => r.project_id).join(",") !== order.join(","),
    `severity 不进键（反证：按 SEVERITY_ORDER 排会得到 ${bySeverity.map((r) => r.project_id).join(" > ")}，与实测顺序不同）`,
  );
  ok(
    rows.findIndex((r) => r.project_id === "p2-utc") > rows.findIndex((r) => r.project_id === "p2-doing"),
    `gate.result=reject / severity=issue 的 p2-utc 仍排在 doing 桶之后（打回与色都不进排序键）`,
  );

  info("DoD②-c：SEVERITY_ORDER 逐条对照（四色归约 = issue > doing > todo > done，无模块 null）");
  console.log(`[verify]        P1 SEVERITY_ORDER: ${SEVERITY_ORDER.join(" > ")}`);
  for (const row of rows) {
    const exp = EXPECT[row.project_id];
    const pass = row.severity === exp.severity;
    console.log(
      `[verify] ${pass ? "PASS" : "FAIL"} 对照 severity(${row.project_id})｜P1 对照物=按 ${SEVERITY_ORDER.join(">")} 取第一个出现的色｜实测=${String(row.severity)}｜期望=${String(exp.severity)}（${exp.why}）`,
    );
    if (!pass) process.exitCode = 1;
  }
  ok(
    rows.find((r) => r.project_id === "p2-fresh")!.severity === null,
    `空项目（0 模块）severity = null 而不是 todo/灰（不冒充灰）`,
  );
  ok(
    rows.find((r) => r.project_id === "p2-blocked")!.severity === "issue" &&
      rows.find((r) => r.project_id === "p2-doing")!.severity === "doing",
    `issue 压过 done、doing 压过 todo/done（归约顺序生效）`,
  );

  info("DoD②-d：LIVE_CONSISTENCY_MAP 逐条对照（与单项目实况 GET /live 同源同值）");
  const lives = new Map<string, LiveSnapshot>();
  for (const f of FIXTURES) {
    const r = await api(base, "GET", `/api/projects/${encodeURIComponent(f.id)}/live`);
    lives.set(f.id, r.body.live as LiveSnapshot);
  }
  const liveCases: { key: keyof typeof LIVE_CONSISTENCY_MAP; run: (row: ProjectSummaryRow, live: LiveSnapshot) => { want: string; got: string; pass: boolean } }[] = [
    {
      key: "gate.current_step",
      run: (row, live) => ({ want: live.gate.current_step, got: row.gate.current_step, pass: row.gate.current_step === live.gate.current_step }),
    },
    {
      key: "gate.step_name",
      run: (row, live) => ({ want: live.gate.step_name, got: row.gate.step_name, pass: row.gate.step_name === live.gate.step_name }),
    },
    {
      key: "gate.result",
      run: (row, live) => ({ want: live.gate.result, got: row.gate.result, pass: row.gate.result === live.gate.result }),
    },
    {
      key: "task_counts.todo/doing/done/blocked",
      run: (row, live) => {
        const want = `${live.task_counts.todo}/${live.task_counts.doing}/${live.task_counts.done}/${live.task_counts.blocked}`;
        const got = `${row.task_counts.todo}/${row.task_counts.doing}/${row.task_counts.done}/${row.task_counts.blocked}`;
        return { want, got, pass: want === got };
      },
    },
    {
      key: "last_activity_at",
      run: (row, live) => ({ want: String(live.last_event_at), got: String(row.last_activity_at), pass: row.last_activity_at === live.last_event_at }),
    },
    {
      key: "module_status_counts",
      run: (row) => {
        const exp = EXPECT[row.project_id].modules;
        const got = row.module_status_counts;
        const pass =
          exp.todo === got.todo && exp.doing === got.doing && exp.done === got.done && exp.issue === got.issue && exp.total === got.total;
        return { want: `fixture 独立计数 ${exp.todo}/${exp.doing}/${exp.done}/${exp.issue}/共${exp.total}`, got: `${got.todo}/${got.doing}/${got.done}/${got.issue}/共${got.total}`, pass };
      },
    },
    {
      key: "severity",
      run: (row) => {
        const exp = EXPECT[row.project_id].severity;
        return { want: `fixture 独立归约 ${String(exp)}`, got: String(row.severity), pass: row.severity === exp };
      },
    },
    {
      key: "actor / stage / current_task / events",
      run: (row) => ({
        want: "不进汇总行（单项目实况展示层）",
        got: FORBIDDEN.filter((k) => k in row).join(",") || "行上没有这些字段",
        pass: !["actor", "stage", "current_task", "events"].some((k) => k in row),
      }),
    },
  ];
  const mapKeys = Object.keys(LIVE_CONSISTENCY_MAP);
  ok(
    liveCases.length === mapKeys.length && mapKeys.every((k) => liveCases.some((c) => c.key === k)),
    `对照覆盖 LIVE_CONSISTENCY_MAP 全部 ${mapKeys.length} 条（逐条都有对照结果）`,
  );
  for (const c of liveCases) {
    console.log(`[verify]        对照物(P1 登记): ${LIVE_CONSISTENCY_MAP[c.key]}`);
    let allPass = true;
    for (const row of rows) {
      const r = c.run(row, lives.get(row.project_id)!);
      allPass = allPass && r.pass;
      console.log(`[verify] ${r.pass ? "PASS" : "FAIL"} 对照 ${c.key} [${row.project_id}]｜对照物=${r.want}｜实测=${r.got}`);
    }
    ok(allPass, `LIVE_CONSISTENCY_MAP「${c.key}」：${rows.length} 个项目逐项一致`);
  }

  info("DoD②-e：源码级断言（汇总实现唯一、import P1、复用实况层缺文件口径）");
  const srcFiles = listFiles(path.join(REPO_ROOT, "src"), /\.(ts|tsx)$/);
  const readSrc = (rel: string) => fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
  const summarySrc = readSrc("src/server/summary.ts");
  ok(
    /from "\.\/projects-summary"/.test(summarySrc) && /\bsummarizeProjects\(/.test(summarySrc) && /\bgroupRowsByGateStep\(/.test(summarySrc),
    `src/server/summary.ts import 了 P1 模块并调用 summarizeProjects / groupRowsByGateStep`,
  );
  ok(
    /import \{[^}]*readProgressReadonly[^}]*\} from "\.\/live"/.test(summarySrc),
    `src/server/summary.ts 复用 live.ts#readProgressReadonly（缺文件合成只有一套，见 P1 PROGRESS_ABSENT_RULE）`,
  );
  const P1_API = [
    "summarizeProject",
    "summarizeProjects",
    "sortProjectRows",
    "compareProjectRows",
    "sortBucketOf",
    "groupRowsByGateStep",
    "severityOf",
    "countModuleStatuses",
    "countTaskStatuses",
    "gateSummaryOf",
    "latestActivityAt",
  ];
  const callSites = new Map<string, string[]>();
  for (const file of srcFiles) {
    const text = fs.readFileSync(file, "utf8");
    const rel = path.relative(REPO_ROOT, file).split(path.sep).join("/");
    for (const fn of P1_API) {
      const re = new RegExp(`\\b${fn}\\s*\\(`, "g");
      const n = (text.match(re) ?? []).length - (rel === "src/server/projects-summary.ts" ? 1 : 0);
      if (n > 0) callSites.set(rel, [...(callSites.get(rel) ?? []), `${fn}×${n}`]);
    }
  }
  const callers = [...callSites.keys()].filter((f) => f !== "src/server/projects-summary.ts");
  ok(callers.length === 1 && callers[0] === "src/server/summary.ts", `P1 汇总函数的调用点唯一 = src/server/summary.ts（实际: ${JSON.stringify(callers)}）`);
  for (const [f, list] of callSites) console.log(`[verify]        调用点 ${f}: ${list.join(" ")}`);
  const readonlyDefs = srcFiles.filter((f) => {
    const t = fs.readFileSync(f, "utf8");
    // 只认「定义」与「import 复用」两种形态（P1 注释里提到它是文档引用，不算第二套实现）
    return /export function readProgressReadonly/.test(t) || /import \{[^}]*readProgressReadonly[^}]*\} from/.test(t);
  });
  const readonlyFiles = readonlyDefs.map((f) => path.relative(REPO_ROOT, f).split(path.sep).join("/")).sort();
  ok(
    readonlyFiles.join(",") === "src/server/chatContext.ts,src/server/live.ts,src/server/summary.ts",
    `readProgressReadonly 只有定义方 live.ts + 复用方 summary.ts / chatContext.ts，没有第二套缺文件合成（实际: ${readonlyFiles.join(",")}）`,
  );
  const crossSrc = readSrc("src/ui/projects/CrossProjectView.tsx");
  ok(!/\.sort\(/.test(crossSrc), `跨项目视图自身不排序（无 .sort(），序由服务端 P1 compareProjectRows 给`);
  ok(
    /import type \{[^}]*\} from "\.\.\/\.\.\/server\/projects-summary"/.test(crossSrc) && !/^import \{[^}]*\} from "\.\.\/\.\.\/server\/projects-summary"/m.test(crossSrc),
    `跨项目视图只 type-only import P1（值 import 会把 node:fs 链拖进前端包，同 F2 拆 shared-graph 的理由）`,
  );

  info("分桶口径：groups = 同一批行的分组渲染（步序 / 组内顺序 / 空步）");
  ok(
    summary.groups.map((g) => g.step).join(",") === EXPECTED_GROUPS.map((g) => g.step).join(","),
    `分桶步序 = GATE_STEPS 声明序 ${EXPECTED_GROUPS.map((g) => g.step).join(" > ")}（空步也列，共 ${summary.groups.length} 步）`,
  );
  for (const g of summary.groups) {
    const exp = EXPECTED_GROUPS.find((x) => x.step === g.step)!;
    const got = g.rows.map((r) => r.project_id);
    const pass = got.join(",") === exp.ids.join(",");
    const expName = GATE_STEPS.find((s) => s.id === g.step)!.name;
    console.log(
      `[verify] ${pass ? "PASS" : "FAIL"} 对照分组「${g.step_name}(${g.step})」｜期望 ${exp.ids.join(",") || "（空）"}｜实测 ${got.join(",") || "（空）"}｜step_name 期望=${expName}`,
    );
    if (!pass || g.step_name !== expName) process.exitCode = 1;
  }
  const flat = summary.groups.flatMap((g) => g.rows.map((r) => r.project_id));
  ok(
    flat.length === rows.length && new Set(flat).size === rows.length,
    `分桶不重不漏：分组里共 ${flat.length} 行 = 行总数 ${rows.length}（同一批行，未新增数据源）`,
  );
  ok(
    summary.default_scope === "PROJECT_ROW" && Object.keys(summary.scopes).join(",") === "PROJECT_ROW,GATE_STEP_GROUP",
    `口径元数据来自 P1 SUMMARY_SCOPES：默认 ${summary.default_scope}，可选 ${Object.keys(summary.scopes).join(" / ")}`,
  );

  info("只读红线：临时项目 .工作台 全量哈希 + 注册表 前后零变化");
  for (let i = 0; i < 10; i++) await api(base, "GET", "/api/summary/projects");
  const afterTree = new Map<string, string>();
  for (const [id, dir] of projDirs) for (const [k, v] of snapshotTree(path.join(dir, ".工作台"))) afterTree.set(`${id}/${k}`, v);
  const treeDiffs = diffMaps(beforeTree, afterTree);
  ok(treeDiffs.length === 0, `跨项目汇总连调 10 次：${projDirs.size} 个项目的 .工作台 文件哈希零变化（${beforeTree.size} 个文件）`);
  if (treeDiffs.length > 0) for (const d of treeDiffs) console.log(`[verify]        差异 ${d}`);
  ok(sha256(path.join(dataDir, "registry.json")) === beforeRegistry, "注册表 registry.json 零变化（不发监听、不写 last_opened_at）");
  const watch = await api(base, "GET", "/api/watch");
  ok((watch.body.watching as string[]).length === 0, `没为汇总接口挂文件监听（watching=${JSON.stringify(watch.body.watching)}）`);

  tmpServer.proc.kill();
  tmpServer = undefined;
  await sleep(400);

  // ═══════════════════ 第 2 段：真实项目同屏耗时 + 只读指纹（DoD④） ═══════════════════
  const realHome = process.env.TATAI_REAL_HOME?.trim() || resolveDataDir();
  const realRegistry = path.join(realHome, "registry.json");
  info(`DoD④ 真实项目同屏耗时（只读；真实数据目录 = ${realHome}）`);
  if (!fs.existsSync(realRegistry)) {
    console.log(`[verify] ---- 跳过：${realRegistry} 不存在（设 TATAI_REAL_HOME 指向真实数据目录可跑这一段）`);
  } else {
    realServer = await startServer(realHome, "真实");
    const rb = realServer.base;
    const realProjects = JSON.parse(fs.readFileSync(realRegistry, "utf8")).projects as { id: string; path: string }[];
    const realPaths = realProjects.flatMap((p) => [
      path.join(p.path, ".工作台", "progress.json"),
      path.join(p.path, ".工作台", "tasks.json"),
      path.join(p.path, ".工作台", "gate.jsonl"),
      path.join(p.path, ".工作台", "changes.jsonl"),
    ]);
    const beforeReal = fingerprint([...realPaths, realRegistry]);
    await api(rb, "GET", "/api/summary/projects"); // 预热（首次读文件计入 page cache 之外的开销）
    const timings: number[] = [];
    let payloadLen = 0;
    let realRowCount = 0;
    for (let i = 0; i < 7; i++) {
      const t0 = performance.now();
      const r = await fetch(`${rb}/api/summary/projects`);
      const text = await r.text();
      timings.push(performance.now() - t0);
      const body = JSON.parse(text) as { summary: ProjectsSummaryPayload };
      payloadLen = text.length;
      realRowCount = body.summary.rows.length;
      if (i === 0) {
        console.log(
          `[verify]        真实项目 ${realRowCount} 个（${body.summary.rows.map((x) => x.project_id).join(", ")}），分桶 ${body.summary.groups.length} 步，响应 ${payloadLen} 字节`,
        );
        console.log(
          `[verify]        首屏行序: ${body.summary.rows.map((x) => `${x.name}[${x.gate.step_name}/${x.severity ?? "无模块"}/blocked=${x.task_counts.blocked},doing=${x.task_counts.doing}]`).join(" > ")}`,
        );
      }
    }
    const sorted = [...timings].sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)];
    console.log(`[verify]        逐次耗时(ms): ${timings.map((t) => t.toFixed(1)).join(", ")}`);
    ok(
      med < 200,
      `DoD④ 真实项目同屏汇总耗时：${realRowCount} 个项目 / 响应 ${payloadLen} 字节 → min ${sorted[0].toFixed(1)} / 中位 ${med.toFixed(1)} / max ${sorted[sorted.length - 1].toFixed(1)} ms（阈值 200ms；瓶颈=逐项目读 4 个小文件的串行 IO）`,
    );
    const afterReal = fingerprint([...realPaths, realRegistry]);
    const realDiffs = diffMaps(beforeReal, afterReal);
    ok(
      realDiffs.length === 0,
      `真实数据只读：${realPaths.length} 个关键文件（各项目 progress/tasks/gate.jsonl/changes.jsonl）+ registry.json 指纹前后零变化`,
    );
    if (realDiffs.length > 0) for (const d of realDiffs) console.log(`[verify]        差异 ${d}`);
    realServer.proc.kill();
    realServer = undefined;
    await sleep(400);
  }
} finally {
  tmpServer?.proc.kill();
  realServer?.proc.kill();
  fs.rmSync(tmpBase, { recursive: true, force: true });
}

console.log(process.exitCode ? "[verify] 存在 FAIL" : "[verify] 全部 PASS");

// ───────────────────────────── 小工具 ─────────────────────────────

function valueAt(obj: unknown, dotted: string): unknown {
  return dotted.split(".").reduce<unknown>(
    (acc, k) => (acc === null || acc === undefined ? undefined : (acc as Record<string, unknown>)[k]),
    obj,
  );
}

function keysOf(obj: object): string {
  return Object.keys(obj).join(",");
}

function allRowKeys(rows: readonly ProjectSummaryRow[]): string[] {
  return rows.length === 0 ? [] : Object.keys(rows[0]);
}

function ms(ts: string | null): number | null {
  if (ts === null) return null;
  const v = Date.parse(ts);
  return Number.isNaN(v) ? null : v;
}

function listFiles(dir: string, re: RegExp): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p, re));
    else if (re.test(e.name)) out.push(p);
  }
  return out;
}
