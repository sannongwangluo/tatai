// V09-30 验证脚本（tsx 跑）：六图构建内的**事件账本读取共享**（先红后绿；DESIGN.md §2.6 事件源／§3.3 图更新）。
//
// 施工目标（一条一条对）：
//   ① 同一次真实 `sixGraphsOf` 调用里 `loadEvents` 从 7 次降到 1 次——一次现读快照沿纯读调用链共享；
//   ② 无参调用保留既有现读行为（各调用点各读各的，不依赖共享）；
//   ③ 不同 workDir／不同截点不串（快照带来源身份，来源不一致就回退现读）；
//   ④ **空数组是合法快照**：`{work_dir, events: []}` 直接返回 `[]`，不 fallthrough 再读一遍；
//   ⑤ 图是一致快照：下一次调用立刻见到新事件；**账本损坏照常失败、绝不沿用上次快照**。
//
// 计数口径：`loadEvents` 对**存在且非空**的账本，每次都会调一次 `fs.statSync(events.jsonl)`
//   （`hasPartialTail` 读尾字节前的尺寸检查）。脚本在导入被测模块**之前**给 `fs.statSync` 包一层
//   计数器，并用「直接调 `readTaskStates` 的已知次数」做 1:1 标定（A 段）——计数不是猜的。
//
// 红绿对照：设 `TATAI_GRAPH_REUSE_BEFORE_SRC` 指向"改前源码根"（把本批 7 个文件回退到 HEAD 的副本），
//   脚本会在同一台机、同一份**实时**账本上分别量「改前 / 改后」的次数，并逐字段对账 canonical 结果
//   （剔除本次时刻类字段）。不设则只量当前源码，红绿对照那一段 SKIP。
//
// 隔离口径（AGENTS.md §5）：合成夹具一律放系统 tmp 下 `tatai-graph-reuse-` 前缀目录、收尾自清；
//   真实项目**只读**（sixGraphsOf 全是只读函数，不写盘、不调模型）；不接网关、不碰生产数据。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NOW = "2026-10-03T00:00:00+08:00";

let pass = 0;
const fails: string[] = [];
let skipped = 0;
const ok = (cond: boolean, label: string, detail?: unknown): void => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (cond) pass += 1;
  else {
    fails.push(label);
    if (detail !== undefined) console.log(`[verify]   现场：${JSON.stringify(detail).slice(0, 1200)}`);
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

// ── 计数口径：`fs.statSync(events.jsonl)` 计数（导入被测模块之前装好） ──
const origStatSync = fs.statSync.bind(fs);
let statTarget: string | null = null;
let statCount = 0;
(fs as unknown as Record<string, unknown>).statSync = (p: fs.PathLike, ...rest: unknown[]): unknown => {
  if (statTarget !== null && path.resolve(String(p)).toLowerCase() === statTarget) statCount += 1;
  return (origStatSync as (...a: unknown[]) => unknown)(p, ...rest);
};
const eventsFileOf = (workDir: string): string =>
  path.join(workDir, "events.jsonl").replace(/\\/g, path.sep);

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
  sixGraphsOf: (id: string, opts?: Record<string, unknown>) => any;
  eventsSnapshotOf: (projectId: string, dataDir: string) => any;
  eventsOfSnapshot: (snap: any, workDir: string) => any[];
  collectProjectFacts: (projectId: string, dataDir: string, opts?: unknown) => any;
  readTaskStates: (workDir: string, events?: unknown[]) => any;
  appendEventDurable: (workDir: string, ev: unknown) => void;
  addProject: (rec: Record<string, unknown>, dataDir: string) => unknown;
  projectWorkDir: (projectId: string, dataDir?: string) => string;
  SCHEMA_VERSION: number;
}

async function loadSrcRoot(root: string): Promise<Src> {
  const six = await loadSrc(root, "arch/sixGraphs.ts");
  const sp = await loadSrc(root, "server/work/statusProjection.ts");
  const tasks = await loadSrc(root, "server/work/tasks.ts");
  const store = await loadSrc(root, "server/work/eventStore.ts");
  const types = await loadSrc(root, "server/work/types.ts");
  const registry = await loadSrc(root, "server/registry.ts");
  const ws = await loadSrc(root, "server/workstation.ts");
  return {
    root,
    sixGraphsOf: six.sixGraphsOf,
    eventsSnapshotOf: sp.eventsSnapshotOf,
    eventsOfSnapshot: sp.eventsOfSnapshot,
    collectProjectFacts: sp.collectProjectFacts,
    readTaskStates: tasks.readTaskStates,
    appendEventDurable: store.appendEventDurable,
    addProject: registry.addProject,
    projectWorkDir: ws.projectWorkDir,
    SCHEMA_VERSION: types.SCHEMA_VERSION,
  };
}

const eventOf = (
  S: Src,
  id: string,
  seq: number,
  entityId: string,
  status: string,
): unknown => ({
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
  occurred_at: NOW,
  received_at: NOW,
  idempotency_key: `idem-${id}-${seq}`,
  payload: { status, note: `fixture-${seq}` },
});

/** 深对账（剔除本次时刻类字段）：返回第一处差异路径；全等返回 null */
// 剔除「本次时刻」类字段：一律以 `_at` 结尾的时间戳，外加常见时长/ETA 字段（快照里这些只随时间变）。
const TIME_KEYS = new Set(["eta", "now", "at", "ts", "ms", "duration_ms"]);
const isTimeKey = (k: string): boolean => TIME_KEYS.has(k) || /_at$/.test(k);
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
      if (!ka.includes(k)) return `${p}.${k}: 只在改后存在`;
      if (!kb.includes(k)) return `${p}.${k}: 只在改前存在`;
      const d = firstDiff(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k],
        `${p}.${k}`,
      );
      if (d !== null) return d;
    }
    return null;
  }
  if (typeof a === "number" && typeof b === "number" && (Number.isNaN(a) || Number.isNaN(b))) {
    return Number.isNaN(a) === Number.isNaN(b) ? null : `${p}: NaN 不同`;
  }
  return a === b ? null : `${p}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-graph-reuse-"));
const after = await loadSrcRoot(path.join(REPO_ROOT, "src"));

try {
  // ════════ A. 计数口径标定（证明 statSync 计数 1:1 等于 loadEvents 次数） ════════
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

  // ════════ B. 合成夹具：无蓝图路径（projectWithReleases + readRequirements 两条链） ════════
  const homeB = path.join(tmpRoot, "synth");
  const pidB = "synth";
  mkdirp(homeB);
  after.addProject({ id: pidB, name: "合成夹具", path: path.join(homeB, "proj"), kind: "backend" }, homeB);
  const workB = after.projectWorkDir(pidB, homeB);
  after.appendEventDurable(workB, eventOf(after, pidB, 1, "task:fxA", "executing"));
  {
    const m = measureLoads(workB, () => after.sixGraphsOf(pidB, { dataDir: homeB }));
    ok(m.loads === 1, `B sixGraphsOf（合成夹具）一次调用只读账本 1 次（实测 ${m.loads}）`);
    ok(typeof m.value?.snapshot_id === "string", "B sixGraphsOf 正常返回快照标识（不是抛错）");
  }

  // ════════ C. 下一次调用立刻见到新事件（不沿用上次快照） ════════
  {
    const before = after.collectProjectFacts(pidB, homeB);
    after.appendEventDurable(workB, eventOf(after, pidB, 2, "task:fxB", "blocked"));
    const graphRun = measureLoads(workB, () => after.sixGraphsOf(pidB, { dataDir: homeB }));
    const afterFacts = after.collectProjectFacts(pidB, homeB);
    ok(graphRun.loads === 1, `C 追加事件后再次 sixGraphsOf 仍只读 1 次（实测 ${graphRun.loads}）`);
    ok(
      before.task_states["fxB"] === undefined && afterFacts.task_states["fxB"] !== undefined,
      "C 追加的新事件在下一次调用立刻可见（新实体出现）",
      { before: Object.keys(before.task_states), after: Object.keys(afterFacts.task_states) },
    );
  }

  // ════════ D. 同长度改写：字节数不变、内容变 ⇒ 下一次调用必须看到新内容 ════════
  {
    // 两条事件，实体 id 等长互换 + status 等长互换：整份文件字节长度严格不变。
    const home = path.join(tmpRoot, "sameLen");
    const pid = "sameLen";
    mkdirp(home);
    after.addProject({ id: pid, name: "等长改写", path: path.join(home, "proj"), kind: "backend" }, home);
    const wd = after.projectWorkDir(pid, home);
    after.appendEventDurable(wd, eventOf(after, pid, 1, "task:aaaa", "executing"));
    after.appendEventDurable(wd, eventOf(after, pid, 2, "task:bbbb", "blocked"));
    const file = eventsFileOf(wd);
    const t0 = fs.readFileSync(file, "utf8");
    const t1 = t0.split("task:aaaa").join("task:cccc").split("task:bbbb").join("task:aaaa");
    fs.writeFileSync(file, t1, "utf8");
    const lenSame = Buffer.byteLength(t0) === Buffer.byteLength(t1);
    ok(lenSame && t0 !== t1, "D 等长改写成立（字节数不变、内容变）");
    const fresh = after.collectProjectFacts(pid, home);
    ok(
      fresh.task_states["cccc"] !== undefined && fresh.task_states["bbbb"] === undefined,
      "D 等长改写后下一次调用看到新内容（不按长度/尺寸误判为同一份）",
      { states: Object.keys(fresh.task_states) },
    );
  }

  // ════════ E. 单位契约：来源身份、空数组不 fallthrough、无参兼容、跨项目不串 ════════
  {
    const wdA = after.projectWorkDir(pidB, homeB);
    const home2 = path.join(tmpRoot, "other");
    const pid2 = "other";
    mkdirp(home2);
    after.addProject({ id: pid2, name: "另一个项目", path: path.join(home2, "proj"), kind: "backend" }, home2);
    const wdB = after.projectWorkDir(pid2, home2);
    after.appendEventDurable(wdB, eventOf(after, pid2, 1, "task:other", "executing"));

    // 空数组：来源一致 ⇒ 直接返回 []，期间 0 次读盘
    const emptyRead = measureLoads(wdA, () =>
      after.eventsOfSnapshot({ work_dir: wdA, events: [] }, wdA),
    );
    ok(
      emptyRead.loads === 0 && Array.isArray(emptyRead.value) && emptyRead.value.length === 0,
      "E 空数组快照是合法快照：不 fallthrough 再读一遍（实测读盘 " + emptyRead.loads + " 次）",
    );

    // 跨项目：workDir 不一致 ⇒ 不复用别人的快照，回退现读本项目
    const cross = measureLoads(wdB, () => {
      const snapA = { work_dir: wdA, events: [{ fake: true }] };
      return after.eventsOfSnapshot(snapA, wdB);
    });
    ok(
      cross.loads === 1 && cross.value.length === 1 && cross.value[0].project_id === pid2,
      "E 跨 workDir 不复用：来源不一致就现读本项目账本（不把别的项目的事件当自己的）",
      { loads: cross.loads, ids: cross.value.map((e: any) => e?.project_id) },
    );

    // 无参兼容：不传快照仍现读
    const noArg = measureLoads(wdA, () => after.readTaskStates(wdA));
    ok(
      noArg.loads === 1 && noArg.value.states["fxA"] !== undefined,
      "E 无参调用保留既有现读行为（readTaskStates(workDir) 照常读盘并得状态）",
    );

    // 快照来源一致 ⇒ 复用，零读盘
    const reuse = measureLoads(wdA, () => {
      const snap = after.eventsSnapshotOf(pidB, homeB);
      return after.readTaskStates(wdA, snap.events);
    });
    ok(reuse.loads === 1, `E 现做快照本身读 1 次、随后复用不再读（实测总 ${reuse.loads} 次）`);

    // at_registration 截点：调用方传**截断后的**事件就按截断折叠（seq ≤ at_seq），
    // 不许因为内部"优化"偷偷回读全量——截点视图与全量视图是两种输入，绝不能被共享逻辑串起来。
    const truncSnap = after.eventsSnapshotOf(pidB, homeB);
    const truncated = measureLoads(wdA, () => {
      const cut = truncSnap.events.filter((e: any) => e.seq <= 1);
      return after.readTaskStates(wdA, cut);
    });
    ok(
      truncated.loads === 0 &&
        truncated.value.states["fxA"] !== undefined &&
        truncated.value.states["fxB"] === undefined,
      "E at_registration 截点：传截断事件就按截断折叠（不偷偷读全量、不与全量视图串）",
      { loads: truncated.loads, states: Object.keys(truncated.value.states) },
    );
  }

  // ════════ F. 账本损坏：照常失败、绝不沿用上次快照 ════════
  {
    const home = path.join(tmpRoot, "corrupt");
    const pid = "corrupt";
    mkdirp(home);
    after.addProject({ id: pid, name: "损坏账本", path: path.join(home, "proj"), kind: "backend" }, home);
    const wd = after.projectWorkDir(pid, home);
    after.appendEventDurable(wd, eventOf(after, pid, 1, "task:c1", "executing"));
    after.appendEventDurable(wd, eventOf(after, pid, 2, "task:c2", "executing"));
    const good = after.sixGraphsOf(pid, { dataDir: home });
    ok(good?.anomalies !== undefined, "F 健康账本先跑通一次（作为对照基线）");

    // 中段插一行坏 JSON：账本损坏
    const file = eventsFileOf(wd);
    const lines = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim() !== "");
    fs.writeFileSync(file, [lines[0], '{"broken":', ...lines.slice(1)].join("\n") + "\n", "utf8");

    // 直接读必须抛（不吞）
    let threw = false;
    try {
      after.readTaskStates(wd);
    } catch {
      threw = true;
    }
    ok(threw, "F 损坏账本现读照常抛错（不静默当空状态）");

    // 六图不沿用上次数据、也不崩：如实报异常
    const bad = after.sixGraphsOf(pid, { dataDir: home });
    const anomalyText = JSON.stringify(bad?.anomalies ?? []);
    ok(
      anomalyText.includes("状态投影算不出来"),
      "F 损坏后 sixGraphsOf 如实报「状态投影算不出来」，不沿用上一次的快照",
      { anomalies: bad?.anomalies },
    );
  }

  // ════════ G. 真实项目 + 红绿对照（env 驱动；不设就 SKIP） ════════
  const realHome = process.env.TATAI_GRAPH_REUSE_REAL_HOME?.trim();
  const realId = process.env.TATAI_GRAPH_REUSE_REAL_PROJECT?.trim();
  const beforeSrc = process.env.TATAI_GRAPH_REUSE_BEFORE_SRC?.trim();
  if (realHome === undefined || realHome === "" || realId === undefined || realId === "") {
    skip(
      "G 真实项目实测 + 红绿对照",
      "未设 TATAI_GRAPH_REUSE_REAL_HOME / TATAI_GRAPH_REUSE_REAL_PROJECT",
    );
  } else {
    const realWork = after.projectWorkDir(realId, realHome);
    const realEvents = eventsFileOf(realWork);
    if (!fs.existsSync(realEvents)) {
      skip("G 真实项目实测", `账本不存在：${realEvents}`);
    } else {
      const bytes = fs.statSync(realEvents).size;
      info(`G 真实账本 ${realEvents}（${(bytes / 1048576).toFixed(1)} MB，只读）`);
      const greenRun = measureLoads(realWork, () => after.sixGraphsOf(realId, { dataDir: realHome }));
      ok(
        greenRun.loads === 1,
        `G 改后：真实 sixGraphsOf 一次调用只读账本 1 次（实测 ${greenRun.loads}）`,
      );
      if (beforeSrc === undefined || beforeSrc === "") {
        skip("G 红绿对照", "未设 TATAI_GRAPH_REUSE_BEFORE_SRC（改前源码根）");
      } else {
        const before = await loadSrcRoot(beforeSrc);
        if (before.projectWorkDir(realId, realHome) !== realWork) {
          skip("G 红绿对照", "改前源码根算出的 workDir 与真实项目不一致");
        } else {
          const redRun = measureLoads(realWork, () => before.sixGraphsOf(realId, { dataDir: realHome }));
          ok(
            redRun.loads > 1,
            `G 改前：同一调用读账本 ${redRun.loads} 次（>1，证明这次改的是真瓶颈而非空谈）`,
          );
          const diff = firstDiff(redRun.value, greenRun.value);
          ok(
            diff === null,
            "G canonical 结果改前/改后等价（剔除本次时刻类字段）",
            diff === null ? undefined : { firstDiff: diff },
          );
        }
      }
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
} else if (process.env.TATAI_GRAPH_REUSE_REAL_HOME === undefined || skipped > 0) {
  console.log("[verify] 结果: 有段落 SKIP（真实项目段没跑全）——退出码 3，别当全过");
  process.exitCode = 3;
} else {
  console.log("[verify] 结果: 全部 PASS");
}
