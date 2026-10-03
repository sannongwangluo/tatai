// V09-30/V09-31/V09-34 验证脚本（tsx 跑）：`project_entry` 请求内的**同版事实共享**与**前置说明**（先红后绿）。
//
// 施工目标（一条一条对）：
//   ① 一次 `evaluateProjectEntry`（含 gatherFacts 全链）只读事件账本 **1 次**——现读一份快照沿
//      任务/认领/执行/同步核验/投影共享（DESIGN.md §2.6 事件源；契约 U1/U2；诊断 §4①）；
//   ② **消除重复 `collectProjectFacts`**：`projectWithReleases({projectFacts})` 复用已算事实，**0 次读盘**
//      （改前会再算一遍→1 次读盘）；同一输入下与"传 events"的结果逐字段一致；
//   ③ **不跨请求缓存旧绿**：下一次调用立刻见到新事件；账本中段损坏照常 fail-closed（next_action=blocked）；
//   ④ V09-34 前置说明：默认调用**恰好九个字段**（不加 preconditions）；opt-in 时从**同一份已算 facts** 派生说明，
//      每项 `blocking:false`、`advisory_only:true`，且 **next_action/reasons/required_reads 与默认调用逐字一致**。
//
// 计数口径（V09-30「计数校准勿 API 双算」）：`loadEvents` 对**存在且非空**的账本每次调一次
//   `fs.statSync(events.jsonl)`（`hasPartialTail` 读尾字节前的尺寸检查）。脚本在导入被测模块**之前**给
//   `fs.statSync` 包一层计数器，并用「直接调 `readTaskStates` 的已知次数」做 1:1 标定（A 段）——
//   不是拿 openSync/readFileSync/流包装去猜解析次数（那样会把一次读取重复计成多次）。
//
// 红绿对照（env 驱动；不设就 SKIP）：`TATAI_UNIFIED_ENTRY_BEFORE_SRC` 指向"改前源码根"（本批冻结在
//   `<维护者核验目录>/tatai-unified-20261003/source-before`），脚本在同一份**实时**账本上分别量
//   改前/改后的次数并做 canonical 对账（剔除本次时刻类字段）。两侧用**固定对照时钟** `H_CLOCK`（可用
//   `TATAI_UNIFIED_ENTRY_CLOCK` 覆盖）避免租约随系统时钟漂移；并逐条核实、只归一本批另两卡的两处**既定**
//   表现差异——事件账本来源的内容身份（旧 `last_seq:9200` → 新真实完整 sha ＋ 已验证字节）与设计续读游标
//   （旧 `tctx1` 短前缀 → 新 `tcur1` 完整版本）——其余业务字段照旧逐字段比对（见 `reconcileKnownEntryDiffs`）。
//
// 冻结镜像（只读回归；env 或默认路径可读则不写生产）：`TATAI_UNIFIED_ENTRY_REAL_HOME` / `..._REAL_PROJECT`
//   缺省指向性能批的只读镜像 `.../tatai-performance-20261003/benchmark/mirror/data`（项目 `bench-mirror`）。
//
// 隔离口径（AGENTS.md §5）：合成夹具一律放系统 tmp 下 `tatai-unified-entry-` 前缀目录、收尾自清；
//   真实项目与镜像**只读**（evaluateProjectEntry 是只读函数，不写盘、不调模型）；不接网关、不碰生产数据。
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let pass = 0;
const fails: string[] = [];
let skipped = 0;
const ok = (cond: boolean, label: string, detail?: unknown): void => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (cond) pass += 1;
  else {
    fails.push(label);
    if (detail !== undefined) console.log(`[verify]   现场：${JSON.stringify(detail).slice(0, 1600)}`);
  }
};
const info = (m: string): void => console.log(`[verify]   ${m}`);
const skip = (label: string, why: string): void => {
  skipped += 1;
  console.log(`[verify] SKIP ${label}｜${why}｜不计为 PASS`);
};
const mkdirp = (d: string): void => {
  fs.mkdirSync(d, { recursive: true });
};
const write = (p: string, text: string): void => {
  mkdirp(path.dirname(p));
  fs.writeFileSync(p, text, "utf8");
};

// ── 计数口径：`fs.statSync(events.jsonl)` 计数（导入被测模块之前装好） ──
const origStatSync = fs.statSync.bind(fs);
let statTarget: string | null = null;
let statCount = 0;
(fs as unknown as Record<string, unknown>).statSync = (p: fs.PathLike, ...rest: unknown[]): unknown => {
  if (statTarget !== null && path.resolve(String(p)).toLowerCase() === statTarget) statCount += 1;
  return (origStatSync as (...a: unknown[]) => unknown)(p, ...rest);
};
const eventsFileOf = (workDir: string): string => path.join(workDir, "events.jsonl").replace(/\\/g, path.sep);

/** 量一次 `fn`：期间对 `eventsFileOf(workDir)` 的 statSync 次数 = 这一次调用里的 loadEvents 次数 */
function measureLoads<T>(workDir: string, fn: () => T): { value: T; loads: number } {
  statTarget = path.resolve(eventsFileOf(workDir)).toLowerCase();
  statCount = 0;
  try {
    const value = fn();
    return { value, loads: statCount };
  } finally {
    statTarget = null;
  }
}

type AnyMod = Record<string, any>;
const loadSrc = async (root: string, rel: string): Promise<AnyMod> =>
  (await import(pathToFileURL(path.join(root, rel)).href)) as AnyMod;

interface Src {
  root: string;
  evaluateProjectEntry: (input: Record<string, unknown>, opts?: Record<string, unknown>) => any;
  projectWithReleases: (facts: Record<string, unknown>) => any;
  collectProjectFacts: (projectId: string, dataDir: string, opts?: unknown) => any;
  eventsSnapshotOf: (projectId: string, dataDir: string) => any;
  readTaskStates: (workDir: string, events?: unknown[]) => any;
  appendEventDurable: (workDir: string, ev: unknown) => void;
  addProject: (rec: Record<string, unknown>, dataDir: string) => unknown;
  projectWorkDir: (projectId: string, dataDir?: string) => string;
  SCHEMA_VERSION: number;
  PROJECT_ENTRY_RESULT_FIELDS: readonly string[];
}

async function loadSrcRoot(root: string): Promise<Src> {
  const entry = await loadSrc(root, "server/work/entry.ts");
  const sp = await loadSrc(root, "server/work/statusProjection.ts");
  const tasks = await loadSrc(root, "server/work/tasks.ts");
  const store = await loadSrc(root, "server/work/eventStore.ts");
  const types = await loadSrc(root, "server/work/types.ts");
  const registry = await loadSrc(root, "server/registry.ts");
  const ws = await loadSrc(root, "server/workstation.ts");
  return {
    root,
    evaluateProjectEntry: entry.evaluateProjectEntry,
    projectWithReleases: entry.projectWithReleases,
    collectProjectFacts: sp.collectProjectFacts,
    eventsSnapshotOf: sp.eventsSnapshotOf,
    readTaskStates: tasks.readTaskStates,
    appendEventDurable: store.appendEventDurable,
    addProject: registry.addProject,
    projectWorkDir: ws.projectWorkDir,
    SCHEMA_VERSION: types.SCHEMA_VERSION,
    PROJECT_ENTRY_RESULT_FIELDS: entry.PROJECT_ENTRY_RESULT_FIELDS,
  };
}

const eventOf = (S: Src, id: string, seq: number, entityId: string, status: string): unknown => ({
  schema_version: S.SCHEMA_VERSION,
  event_id: `ev-${id}-${seq}`,
  project_id: id,
  change_id: "chg-fixture",
  entity_id: entityId,
  entity_revision: 1,
  seq,
  type: "task.status_changed",
  actor_id: "fixture-executor",
  role: "executor",
  occurred_at: "2026-10-03T00:00:00+08:00",
  received_at: "2026-10-03T00:00:00+08:00",
  idempotency_key: `idem-${id}-${seq}`,
  payload: { status, note: `fixture-${seq}` },
});

// ── 深对账（剔除本次时刻类字段）：返回第一处差异路径；全等返回 null ──
// `package_id` 是上下文包按生成时刻算的内容 id（`ctx-<project>-<hash>`，hash 含 generated_at），
// 属**非语义生成字段**：同一输入两次调用本就不同，按契约「只排除明确的非语义生成时间/耗时字段」排除。
const TIME_KEYS = new Set(["eta", "now", "at", "ts", "ms", "duration_ms", "package_id"]);
const isTimeKey = (k: string): boolean => TIME_KEYS.has(k) || /_at$/.test(k) || /_ms$/.test(k);
function firstDiff(a: unknown, b: unknown, p = "$"): string | null {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return `${p}: 数组形状不同`;
    if (a.length !== b.length) return `${p}: 长度 ${a.length} vs ${b.length}`;
    for (let i = 0; i < a.length; i++) {
      const d = firstDiff(a[i], b[i], `${p}[${i}]`);
      if (d !== null) return d;
    }
    return null;
  }
  if (a !== null && b !== null && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a as Record<string, unknown>).filter((k) => !isTimeKey(k));
    const kb = Object.keys(b as Record<string, unknown>).filter((k) => !isTimeKey(k));
    for (const k of new Set([...ka, ...kb])) {
      if (!ka.includes(k)) return `${p}.${k}: 只在 B 存在`;
      if (!kb.includes(k)) return `${p}.${k}: 只在 A 存在`;
      const d = firstDiff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${p}.${k}`);
      if (d !== null) return d;
    }
    return null;
  }
  if (typeof a === "number" && typeof b === "number" && (Number.isNaN(a) || Number.isNaN(b))) {
    return Number.isNaN(a) === Number.isNaN(b) ? null : `${p}: NaN 不同`;
  }
  return a === b ? null : `${p}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
}

// ── H 段红绿对照的「固定时钟」与「等强兼容判据」 ──
// 固定对照时钟：`now` 参与租约判定，改前/改后两次调用若各取系统时钟，跨越租约到期点就会让 current_runs.lease /
// reasons 文案在本不该变的地方变化。两侧用同一固定时刻即可消除这种偶发差异——**但不忽略**租约字段本身：
// 下面照样逐字段比对，并另有一条专门断言运行现场（含 lease）确实被比到。
const H_CLOCK = (process.env.TATAI_UNIFIED_ENTRY_CLOCK ?? "2026-10-03T10:19:53.000Z").trim();

/** 续读游标 token：新格式 `tcur1:…`（完整 sha ＋ 项目/文档绑定）或旧短前缀 `tctx1:…`（只定位） */
const CURSOR_TOKEN_RE =
  /(tcur1:[a-z]+:[0-9a-f]{16}:[0-9a-f]{64}:(?:lines|bytes):\d+|tctx1:[0-9a-f]{8,64}:(?:lines|bytes):\d+)/;

/**
 * 把红绿两侧**仅**「本批（V09-31/33）另两卡已确认的既定表现差异」逐条核实后归一化，供其后 `firstDiff` 使用。
 *
 * 依据 `integration-final/semantic-diff.json`：差异 12 条恰好 3 角色 × 4 条，其中 `package_id`（非语义生成字段，
 * 已被 `TIME_KEYS` 排除）之外，业务字段差异只有两类：
 *   ① `context_manifest.sources[kind=task_state]` 的 `content_sha256` / `note`——改前拿 `last_seq:<N>` 冒充内容哈希、
 *      note 只说重放到哪；改后给**账本真实完整 sha256**、note 带「已验证 <字节> 字节」；
 *   ② `context_manifest.omitted[…].detail` 的**续读游标**——改前旧短前缀 `tctx1:<16hex>:lines:<N>`，
 *      改后 `tcur1:design:<bind16>:<fullsha64>:lines:<N>`（同一 design 源、同一行范围）。
 *
 * 这里**先逐条断言**差异正是这两种、且新值满足预期（旧 `last_seq:9200`；新 sha **独立复算**等于该账本文件的 sha256、
 * 字节数等于文件大小、且被 note 回指；新游标 fullsha ＝ 同一清单里 design 来源的实际 `content_sha256`、16 位前缀与原
 * 游标一致、单位与起点不变），**再**只把这两处归一化——不是泛化忽略 `content_sha256`/`note`，也不删对照：其余来源字段与
 * 全部业务字段照旧逐字段比对。返回核实不通过的问题清单（空 = 差异确为既定两类，已归一到位）。
 *
 * `expectedLedger`：账本文件**独立复算**出的 `{sha256, bytes}`（调用方现读该文件算得）；为 null 视为无法独立核实，记问题。
 */
function reconcileKnownEntryDiffs(
  redEntry: any,
  greenEntry: any,
  expectedLedger: { sha256: string; bytes: number } | null,
): string[] {
  const problems: string[] = [];
  const rm = redEntry?.context_manifest;
  const gm = greenEntry?.context_manifest;
  if (rm?.sources === undefined || gm?.sources === undefined || !Array.isArray(rm.sources) || !Array.isArray(gm.sources)) {
    return ["context_manifest.sources 缺失或非数组，无法按既定差异判据核实"];
  }

  // ① 事件账本（task_state）来源：旧 last_seq 占位 → 新真实完整 sha + 已验证字节
  const ledgerOf = (m: any): { s: any; i: number }[] =>
    m.sources.map((s: any, i: number) => ({ s, i })).filter((x: { s: any }) => x.s?.kind === "task_state");
  const rLed = ledgerOf(rm);
  const gLed = ledgerOf(gm);
  if (rLed.length !== 1 || gLed.length !== 1 || rLed[0].i !== gLed[0].i) {
    problems.push(`task_state 来源不唯一或不同位（改前 ${rLed.length} 个 / 改后 ${gLed.length} 个）`);
  } else {
    const r = rLed[0].s;
    const g = gLed[0].s;
    if (r.path !== g.path) problems.push(`ledger 来源路径不一致：${r.path} vs ${g.path}`);
    if (r.content_sha256 !== "last_seq:9200") {
      problems.push(`旧 ledger 来源 content_sha256 应为 "last_seq:9200"，实为 ${JSON.stringify(r.content_sha256)}`);
    }
    const sha: unknown = g.content_sha256;
    if (typeof sha !== "string" || !/^[0-9a-f]{64}$/.test(sha)) {
      problems.push(`新 ledger 来源 content_sha256 应为完整 64 位 sha，实为 ${JSON.stringify(sha)}`);
    }
    // 新值必须是**该账本文件真实完整 sha**（独立复算，不是信 note 自报）
    if (expectedLedger === null) {
      problems.push("未能独立复算账本文件 sha256/字节数，无法核实新内容身份");
    } else {
      if (!/^[0-9a-f]{64}$/.test(expectedLedger.sha256)) {
        problems.push(`独立复算的账本 sha256 非 64 位：${expectedLedger.sha256}`);
      }
      if (sha !== expectedLedger.sha256) {
        problems.push(`新 ledger content_sha256 ${String(sha)} ≠ 账本文件实际 sha256 ${expectedLedger.sha256}`);
      }
    }
    const rNote = String(r.note ?? "");
    const gNote = String(g.note ?? "");
    if (rNote !== "任务运行状态投影（重放到 seq 9200）") {
      problems.push(`旧 ledger note 与预期不符：${JSON.stringify(rNote)}`);
    }
    const m = /^任务运行状态投影（重放到 seq 9200）；账本内容身份 sha256=([0-9a-f]{12})…（已验证 (\d+) 字节）$/.exec(gNote);
    if (m === null) {
      problems.push(
        `新 ledger note 未按「重放到 seq 9200；账本内容身份 sha256=<前12位>…（已验证 <字节> 字节）」给出已验证字节来源：${JSON.stringify(gNote)}`,
      );
    } else {
      if (typeof sha === "string" && m[1] !== sha.slice(0, 12)) {
        problems.push(`新 ledger note 回指的 sha 前缀 ${m[1]} ≠ content_sha256 前 12 位 ${sha.slice(0, 12)}`);
      }
      if (!(Number(m[2]) > 0)) problems.push(`新 ledger「已验证字节」非正数：${m[2]}`);
      else if (expectedLedger !== null && Number(m[2]) !== expectedLedger.bytes) {
        problems.push(`新 ledger「已验证字节」${m[2]} ≠ 账本文件实际字节 ${expectedLedger.bytes}`);
      }
    }
    // 归一化该来源的内容身份两处（其余字段照旧比对）
    r.content_sha256 = g.content_sha256 = "<task_state-content-sha256>";
    r.note = g.note = "任务运行状态投影（重放到 seq 9200）";
  }

  // ② 续读游标描述：旧短前缀 → 新完整版本（同一 design 源、同一行范围）
  const rOm = rm.omitted;
  const gOm = gm.omitted;
  if (!Array.isArray(rOm) || !Array.isArray(gOm) || rOm.length !== gOm.length) {
    problems.push(`omitted 形状不一致：${rOm?.length} vs ${gOm?.length}`);
  } else {
    for (let i = 0; i < rOm.length; i++) {
      const r = rOm[i];
      const g = gOm[i];
      const rTok = typeof r?.detail === "string" ? CURSOR_TOKEN_RE.exec(r.detail)?.[0] ?? null : null;
      const gTok = typeof g?.detail === "string" ? CURSOR_TOKEN_RE.exec(g.detail)?.[0] ?? null : null;
      if (rTok === null && gTok === null) continue;
      if (rTok === null || gTok === null) {
        problems.push(`omitted[${i}] 仅一侧带续读游标：${JSON.stringify(r?.detail)} / ${JSON.stringify(g?.detail)}`);
        continue;
      }
      if (r.path !== g.path) problems.push(`omitted[${i}] 路径不一致：${r.path} vs ${g.path}`);
      const rLegacy = /^tctx1:([0-9a-f]{8,64}):(lines|bytes):(\d+)$/.exec(rTok);
      const gModern = /^tcur1:([a-z]+):([0-9a-f]{16}):([0-9a-f]{64}):(lines|bytes):(\d+)$/.exec(gTok);
      if (rLegacy === null) problems.push(`改前游标不是旧短前缀形态：${rTok}`);
      if (gModern === null) problems.push(`改后游标不是新完整版本形态：${gTok}`);
      if (rLegacy !== null && gModern !== null) {
        if (rLegacy[2] !== gModern[4] || rLegacy[3] !== gModern[5]) {
          problems.push(`游标单位/范围起点变了：${rLegacy[2]}:${rLegacy[3]} vs ${gModern[4]}:${gModern[5]}`);
        }
        if (gModern[1] !== "design") problems.push(`新游标 doc 应为 design，实为 ${gModern[1]}`);
        if (gModern[3].slice(0, 16) !== rLegacy[1]) {
          problems.push(`新游标 fullsha 前 16 位 ${gModern[3].slice(0, 16)} ≠ 旧游标短前缀 ${rLegacy[1]}`);
        }
        // 「实际 source 完整 SHA」= 同一清单里该路径的 design 来源 content_sha256（旧侧短前缀同样应指向它）
        const gDesign = gm.sources.find((s: any) => s?.kind === "design" && s?.path === g.path);
        if (gDesign === undefined) problems.push(`清单里找不到 omitted[${i}] 对应的 design 来源：${g.path}`);
        else if (gDesign.content_sha256 !== gModern[3]) {
          problems.push(`新游标 fullsha ${gModern[3]} ≠ design 来源实际 content_sha256 ${gDesign.content_sha256}`);
        }
        const rDesign = rm.sources.find((s: any) => s?.kind === "design" && s?.path === r.path);
        if (rDesign !== undefined && typeof rDesign.content_sha256 === "string" && rDesign.content_sha256.slice(0, 16) !== rLegacy[1]) {
          problems.push(`旧游标短前缀 ${rLegacy[1]} ≠ 旧 design 来源 sha 前 16 位 ${rDesign.content_sha256.slice(0, 16)}`);
        }
        const unit = rLegacy[2];
        const start = rLegacy[3];
        r.detail = String(r.detail).replace(rTok, `<continuation-cursor:${unit}:${start}>`);
        g.detail = String(g.detail).replace(gTok, `<continuation-cursor:${unit}:${start}>`);
      }
    }
  }
  return problems;
}

const planText = (title: string): string =>
  [
    `# ${title}`,
    "",
    "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |",
    "| --- | --- | --- | --- | --- |",
    "| T1 | todo | 夹具卡一 |  | T1 的证据 |",
    "",
    "### T1 夹具卡一",
    "",
    "**设计依据**：§1。**依赖**：无。**文件责任**：`src/t1.ts`。",
    "",
    "- [ ] T1 达标",
    "",
  ].join("\n");

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-unified-entry-"));
const after = await loadSrcRoot(path.join(REPO_ROOT, "src"));

try {
  // ════════ A. 计数口径标定（证明 statSync 计数 1:1 等于 loadEvents 次数，勿 API 双算） ════════
  {
    const home = path.join(tmpRoot, "calib");
    const pid = "calib";
    mkdirp(home);
    after.addProject({ id: pid, name: "标定", path: path.join(home, "proj"), kind: "backend" }, home);
    const workDir = after.projectWorkDir(pid, home);
    after.appendEventDurable(workDir, eventOf(after, pid, 1, "task:calib", "executing"));
    const m = measureLoads(workDir, () => {
      after.readTaskStates(workDir);
      after.readTaskStates(workDir);
      after.readTaskStates(workDir);
    });
    ok(m.loads === 3, `A 计数口径 1:1：直调 readTaskStates ×3 ⇒ 计到 3 次（实测 ${m.loads}）`);
  }

  // ════════ B. 绿：一次 evaluateProjectEntry 只读账本 1 次（合成夹具） ════════
  const homeB = path.join(tmpRoot, "synth");
  const pidB = "synth";
  mkdirp(homeB);
  after.addProject({ id: pidB, name: "合成夹具", path: path.join(homeB, "proj"), kind: "backend" }, homeB);
  const workB = after.projectWorkDir(pidB, homeB);
  after.appendEventDurable(workB, eventOf(after, pidB, 1, "task:t1", "executing"));
  {
    const m = measureLoads(workB, () => after.evaluateProjectEntry({ project_id: pidB, role: "executor" }, { dataDir: homeB }));
    // 1 次＝gatherFacts 的共享快照（本卡范围）；另 1 次＝context 包内 `readTaskStates`（context.ts:1043，
    // 属另一卡写域，本卡禁改 context）。改前诊断实测 ≈11 次；这里只要求 ≤2（未来 context 也接了快照则更少）。
    ok(m.loads <= 2, `B evaluateProjectEntry 一次调用只读账本 ≤2 次（实测 ${m.loads}；改前诊断 ≈11 次）`);
    ok(typeof m.value?.next_action === "string", "B evaluateProjectEntry 正常返回 next_action（不是抛错）");
  }

  // ════════ C. 不跨请求缓存旧绿：下一次调用立刻见到新事件 ════════
  {
    const before = after.evaluateProjectEntry({ project_id: pidB, role: "executor" }, { dataDir: homeB });
    after.appendEventDurable(workB, eventOf(after, pidB, 2, "task:t2", "blocked"));
    const run = measureLoads(workB, () => after.evaluateProjectEntry({ project_id: pidB, role: "executor" }, { dataDir: homeB }));
    const ids = run.value?.current_change?.task_ids ?? [];
    ok(run.loads <= 2, `C 追加事件后再次求值仍只读账本 ≤2 次（实测 ${run.loads}）`);
    ok(
      (before?.current_change?.task_ids ?? []).includes("t2") === false && ids.includes("t2"),
      "C 追加的新事件在下一次调用立刻可见（新任务出现在 current_change.task_ids，不沿用上次快照）",
      { before: before?.current_change?.task_ids, after: ids },
    );
  }

  // ════════ D. V09-30：消除重复 collectProjectFacts（projectWithReleases 复用已算事实 ⇒ 0 次读盘） ════════
  {
    const snap = after.eventsSnapshotOf(pidB, homeB);
    const pf = after.collectProjectFacts(pidB, homeB, { events: snap });
    const reuse = measureLoads(workB, () =>
      after.projectWithReleases({ projectId: pidB, dataDir: homeB, definitions: [], projectFacts: pf }));
    ok(
      reuse.loads === 0,
      `D projectWithReleases 传 projectFacts ⇒ 0 次读盘（复用而不重算 collectProjectFacts；实测 ${reuse.loads}）`,
    );
    const viaEvents = after.projectWithReleases({ projectId: pidB, dataDir: homeB, definitions: [], events: snap });
    const diff = firstDiff(reuse.value, viaEvents);
    ok(diff === null, "D 复用 projectFacts 与传 events 的投影逐字段一致（剔除本次时刻类字段）", diff === null ? undefined : { firstDiff: diff });
  }

  // ════════ E. V09-34：默认九字段；opt-in 前置说明不改 next_action/reasons，且不新增门禁 ════════
  {
    const plain = after.evaluateProjectEntry({ project_id: pidB, role: "executor" }, { dataDir: homeB });
    const keys = Object.keys(plain);
    ok(
      JSON.stringify(keys) === JSON.stringify([...after.PROJECT_ENTRY_RESULT_FIELDS]),
      `E 默认返回**恰好**九字段（不含 preconditions）：${after.PROJECT_ENTRY_RESULT_FIELDS.join("/")}`,
      { keys },
    );
    const withPc = measureLoads(workB, () =>
      after.evaluateProjectEntry({ project_id: pidB, role: "executor" }, { dataDir: homeB, preconditions: true }));
    ok(withPc.value?.preconditions !== undefined, "E opt-in 时带出 preconditions");
    ok(withPc.value?.preconditions?.advisory_only === true, "E preconditions.advisory_only === true（只说明不判）");
    const items: any[] = withPc.value?.preconditions?.items ?? [];
    ok(items.length > 0, `E preconditions 有逐项说明（实测 ${items.length} 项）`);
    ok(items.every((it) => it.blocking === false), "E 每一项 blocking 恒为 false（不新增门禁）");
    ok(
      JSON.stringify(Object.keys(withPc.value)) === JSON.stringify([...after.PROJECT_ENTRY_RESULT_FIELDS, "preconditions"]),
      "E opt-in 只在九字段之外**多**一个 preconditions（顺序稳定）",
      { keys: Object.keys(withPc.value) },
    );
    const noGateChange = firstDiff(
      { next_action: plain.next_action, reasons: plain.reasons, required_reads: plain.required_reads },
      { next_action: withPc.value.next_action, reasons: withPc.value.reasons, required_reads: withPc.value.required_reads },
    );
    ok(noGateChange === null, "E 前置说明不改 next_action/reasons/required_reads（逐字一致）", noGateChange === null ? undefined : { firstDiff: noGateChange });
    ok(withPc.loads <= 2, `E 取前置说明不额外读账本（仍 ≤2 次，与默认一致；实测 ${withPc.loads}）`);
  }

  // ════════ F. V09-34：空工作台但有 PLAN（无基线）——说明准确，现行 await_decision 不变 ════════
  {
    const home = path.join(tmpRoot, "planonly");
    const pid = "planonly";
    const root = path.join(home, "proj");
    // 先登记（此时 dataDir 里只有 registry.json），再写图纸——避免"有运行痕迹但没有 registry.json"被拒。
    after.addProject({ id: pid, name: "有图纸无基线", path: root, kind: "backend" }, home);
    write(path.join(root, ".工作台", "design.md"), `# ${pid} 设计书\n\n## 1 目标\n\n夹具正文。\n`);
    write(path.join(root, ".工作台", "plan.md"), planText(`${pid} 施工图`));
    const res = after.evaluateProjectEntry({ project_id: pid, role: "executor" }, { dataDir: home, preconditions: true });
    ok(res.next_action === "await_decision", `F 无基线 ⇒ 现行 await_decision 不变（实测 ${res.next_action}）`);
    const items: any[] = res?.preconditions?.items ?? [];
    const baseline = items.find((it) => it.kind === "baseline");
    ok(baseline !== undefined && baseline.status === "missing", "F 前置说明如实指出缺生效基线（baseline status=missing）", baseline);
    const src = items.find((it) => it.kind === "source_version");
    ok(src !== undefined && src.status === "satisfied", "F 前置说明如实指出设计/施工图源已在（source_version status=satisfied）", src);
    const defs = items.find((it) => it.kind === "task_definitions");
    ok(defs !== undefined && defs.status === "satisfied", "F 前置说明如实指出卡定义已解析（task_definitions status=satisfied）", defs);
    ok(items.every((it) => it.blocking === false), "F 有 PLAN 无基线的说明同样不新增门禁（每条 blocking=false）");
  }

  // ════════ G. fail-closed：账本中段损坏照常 blocked、不静默跳过 ════════
  {
    const home = path.join(tmpRoot, "corrupt");
    const pid = "corrupt";
    mkdirp(home);
    after.addProject({ id: pid, name: "损坏账本", path: path.join(home, "proj"), kind: "backend" }, home);
    const workDir = after.projectWorkDir(pid, home);
    after.appendEventDurable(workDir, eventOf(after, pid, 1, "task:c1", "executing"));
    after.appendEventDurable(workDir, eventOf(after, pid, 2, "task:c2", "executing"));
    const file = eventsFileOf(workDir);
    const lines = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim() !== "");
    fs.writeFileSync(file, [lines[0], '{"broken":', ...lines.slice(1)].join("\n") + "\n", "utf8");
    let res: any = null;
    let threw = false;
    try {
      res = after.evaluateProjectEntry({ project_id: pid, role: "executor" }, { dataDir: home });
    } catch {
      threw = true;
    }
    ok(!threw && res?.next_action === "blocked", "G 账本中段损坏 ⇒ next_action=blocked（fail-closed，不静默当空状态）", { threw, action: res?.next_action });
    const codes = (res?.reasons ?? []).map((r: any) => r.code);
    ok(codes.includes("facts_unreadable"), "G 损坏理由如实标 facts_unreadable（不伪装成空/可继续）", { codes });
  }

  // ════════ H. 冻结镜像（只读回归）+ 红绿对照（env 驱动；不可读就 SKIP） ════════
  const DEFAULT_MIRROR_HOME = "<维护者核验目录>/tatai-performance-20261003/benchmark/mirror/data";
  const DEFAULT_MIRROR_ID = "bench-mirror";
  const realHome = (process.env.TATAI_UNIFIED_ENTRY_REAL_HOME ?? DEFAULT_MIRROR_HOME).trim();
  const realId = (process.env.TATAI_UNIFIED_ENTRY_REAL_PROJECT ?? DEFAULT_MIRROR_ID).trim();
  const beforeSrc = (process.env.TATAI_UNIFIED_ENTRY_BEFORE_SRC ?? "").trim();
  if (realHome === "" || !fs.existsSync(path.join(realHome, "registry.json"))) {
    skip("H 冻结镜像实测", `镜像不可读：${realHome}/registry.json`);
  } else {
    try {
      const realWork = after.projectWorkDir(realId, realHome);
      const ef = eventsFileOf(realWork);
      if (!fs.existsSync(ef)) {
        skip("H 冻结镜像实测", `账本不存在：${ef}`);
      } else {
        const bytes = fs.statSync(ef).size;
        info(`H 只读冻结镜像账本 ${ef}（${(bytes / 1048576).toFixed(1)} MB）`);
        // 账本文件独立复算（现读）：用来核实“新内容身份”确为该文件的真 sha256/字节数，而不是信 note 自报。
        let expectedLedger: { sha256: string; bytes: number } | null = null;
        try {
          const buf = fs.readFileSync(ef);
          expectedLedger = { sha256: crypto.createHash("sha256").update(buf).digest("hex"), bytes: buf.length };
        } catch {
          expectedLedger = null;
        }
        // 固定对照时钟（见 H_CLOCK 注释）：早晚两次调用用同一 `now`，租约判定不再随系统时钟漂移。
        const green = measureLoads(realWork, () =>
          after.evaluateProjectEntry({ project_id: realId, role: "auditor" }, { dataDir: realHome, now: H_CLOCK }));
        // 镜像上有现行同步契约：除本卡的 1 次共享快照外，还有 3 次来自**本卡写域之外**的独立读
        // （syncChecks.ts:242 批次检查、sixGraphs.ts:739 同步图探针、context.ts:1043 上下文包）；
        // 改前诊断 ≈11 次。这里只要求 ≤4（本卡把 entry 自身的重复读收敛掉），未来他卡接了快照会更少。
        ok(green.loads <= 4, `H 改后：真实镜像 evaluateProjectEntry 只读账本 ≤4 次（实测 ${green.loads}；改前诊断 ≈11）`);
        ok(typeof green.value?.next_action === "string", "H 镜像上正常返回 next_action");
        // 改前源码根既可是仓库根（含 src/），也可是 src/ 本身——两种都给对。
        const beforeSrcRoot =
          fs.existsSync(path.join(beforeSrc, "server", "work", "entry.ts"))
            ? beforeSrc
            : fs.existsSync(path.join(beforeSrc, "src", "server", "work", "entry.ts"))
              ? path.join(beforeSrc, "src")
              : "";
        if (beforeSrc === "" || beforeSrcRoot === "") {
          skip("H 红绿对照", `未设/无效 TATAI_UNIFIED_ENTRY_BEFORE_SRC（改前源码根）：${beforeSrc || "（空）"}`);
        } else {
          const before = await loadSrcRoot(beforeSrcRoot);
          const redWork = before.projectWorkDir(realId, realHome);
          if (redWork !== realWork) {
            skip("H 红绿对照", "改前源码根算出的 workDir 与镜像不一致");
          } else {
            const red = measureLoads(realWork, () =>
              before.evaluateProjectEntry({ project_id: realId, role: "auditor" }, { dataDir: realHome, now: H_CLOCK }));
            ok(red.loads > green.loads, `H 改前：同一镜像读账本 ${red.loads} 次 > 改后 ${green.loads} 次（证明这次改的是真瓶颈）`);
            // 租约/运行现场不被忽略：固定时钟后逐字段比对，且确有 lease 状态被比到（不是空气泡）。
            const runsWithLease = (green.value?.current_runs ?? []).filter((r: any) => typeof r?.lease === "string");
            ok(
              runsWithLease.length > 0 && firstDiff(red.value?.current_runs, green.value?.current_runs) === null,
              `H 运行现场（含 ${runsWithLease.length} 条 run 的 lease 状态）固定对照时钟 ${H_CLOCK} 后逐字段一致`,
            );
            // 本批另两卡改了「账本内容身份」与「续读游标」的既定表现：先逐条核实、再只归一这两处，其余照旧比对。
            const knownDiffs = reconcileKnownEntryDiffs(red.value, green.value, expectedLedger);
            ok(
              knownDiffs.length === 0,
              "H 既定表现差异逐条核实（旧 last_seq:9200 / 新真实账本 sha 独立复算一致＋已验证字节=文件大小 / 新游标完整 sha 与原范围一致）",
              knownDiffs.length > 0 ? { problems: knownDiffs } : undefined,
            );
            const diff = firstDiff(red.value, green.value);
            ok(
              diff === null,
              "H canonical 结果改前/改后等价（剔除本次时刻类字段；仅归一账本来源内容身份与续读游标两处既定差异）",
              diff === null ? undefined : { firstDiff: diff },
            );
            // 改前 projectWithReleases 不识 projectFacts ⇒ 仍会重算 collectProjectFacts（读盘 1 次）
            const pf = after.collectProjectFacts(realId, realHome, { events: after.eventsSnapshotOf(realId, realHome) });
            const redReuse = measureLoads(realWork, () =>
              before.projectWithReleases({ projectId: realId, dataDir: realHome, definitions: [], projectFacts: pf }));
            const greenReuse = measureLoads(realWork, () =>
              after.projectWithReleases({ projectId: realId, dataDir: realHome, definitions: [], projectFacts: pf }));
            ok(
              redReuse.loads > 0 && greenReuse.loads === 0,
              `H 去重复 collectProjectFacts：改前 ${redReuse.loads} 次读盘 / 改后 ${greenReuse.loads} 次（改后 0 才是真复用）`,
            );
          }
        }
      }
    } catch (e) {
      skip("H 冻结镜像实测", `镜像读取抛错（只读探针失败，不计为 PASS）：${e instanceof Error ? e.message : String(e)}`);
    }
  }
} finally {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* 收尾失败不影响结论 */
  }
}

console.log(`\n[verify] 小结：PASS ${pass}，FAIL ${fails.length}，SKIP ${skipped}`);
if (fails.length > 0) {
  console.log("[verify] FAIL 明细：\n  - " + fails.join("\n  - "));
  process.exitCode = 1;
} else if (skipped > 0) {
  console.log("[verify] 结果: 有段落 SKIP（真实镜像/红绿对照没跑全）——退出码 3，别当全过");
  process.exitCode = 3;
} else {
  console.log("[verify] 结果: 全部 PASS");
}
