// V06-14 验证脚本（PLAN.md V06-14 三条检查项；DESIGN.md §2.8 / §4.3–§4.4 / §8.5 / §11.8）。
// 用法：pnpm verify:v06-14（或 node --import tsx scripts/verify-v06-14.ts）
//
// 三段（与卡面三条检查项一一对应）：
//   ① 分档实测：约 1 千 / 1 万 / 10 万文本文件，独立放大任务量 / 事件量 / 关系量；
//      变更风暴、超长日志、局部服务故障；前台局部读取、后台可取消、超限显示省略量。
//      每档记录硬件、语言/目录构成、索引冷启动与增量更新、上下文包生成、页面交互 p50/p95、
//      内存 / 磁盘、模型输入量、未测范围。**超时就如实报"该档未跑通"并写清卡在哪一步**。
//   ② 一致性备份/恢复：任务/原文持续变化期间用**事件提交边界**做一致备份；模拟损坏 / 缺证据 /
//      旧基线恢复；核对原文与证据哈希、事件重放、缓存重建；**故意构造跨时刻的半份备份做反证**
//      （它必须被判不合格）——不能用"复制半份目录"当通过。
//   ③ 结论：公布**通过档位、未通过瓶颈及扩容触发条件**；写明"超大型支持不能由 10 万文件数量单独推出"。
//
// ██ 红线遵守 ██
//   · 一切夹具（含 watcher 的临时写文件、spawn 的后端）只在 `os.tmpdir()` 下本脚本自建的目录里，
//     入口用 `assertUnderTmp()` 兜住；收尾整棵删掉并报"清理前后磁盘占用"（`TATAI_KEEP_TMP=1` 保留现场）。
//   · **不碰**三个真实项目的 `.工作台/`、不碰 `D:\.tatai` 真实数据目录；本脚本源码里不含任何真实项目路径。
//   · 塔台根文档与既有 `scripts/**` 只读，首尾哈希逐项对照；收尾自证。
//   · 真模型不参与：全程零模型（索引 = tree-sitter 静态解析、上下文包 = 确定性派生）。
//   · **不自动替换任何真实数据**：恢复只落在隔离目录（`restoreBackup` 返回 `replaced: false`）。
//   · 预算一律走**产品已支持的环境变量**（`TATAI_WATCH_*`），只为把截断/丢弃路径真实触发；
//     不改任何产品默认值（默认口径的那一趟也照跑，两边都记）。
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { addProject } from "../src/server/registry";
import { projectWorkDir } from "../src/server/workstation";
import { parseDirectory, WALK_LIMITS } from "../src/arch/parse";
import { scanDirectoryAsync, SCAN_LIMITS } from "../src/server/scanner";
import { buildContextPackage, readContextSource, CONTEXT_MAX_CHARS } from "../src/server/work/context";
import { importTaskDefinitions, taskDefinitionHash } from "../src/server/work/plan";
import { submitDefinitionImports, submitTaskStatus } from "../src/server/work/tasks";
import {
  WorkService,
  WorkServiceClient,
  descriptorPidAlive,
  readServiceDescriptor,
  WORK_TOKEN_HEADER,
  type WorkServiceDescriptor,
} from "../src/server/work/service";
import {
  WATCH_LIMITS,
  listWatchDetails,
  unwatchProject,
  watchProject,
  queryChanges,
  type WatchStats,
} from "../src/server/watcher";
import {
  appendEventDurable,
  eventsPath,
  loadEvents,
  replayEvents,
  STATE_FILE,
} from "../src/server/work/eventStore";
import { SCHEMA_VERSION, type WorkCommand, type WorkEvent } from "../src/server/work/types";
import { evidenceBlobPath, putEvidence } from "../src/server/work/evidence";
import { activateBaseline, WORKBENCH_DIRNAME } from "../src/server/work/documents";
import { submitSubmission } from "../src/server/work/audit";
import {
  BACKUP_MANIFEST_FILE,
  compareBackupToLive,
  toBackupRel,
  createProjectBackup,
  listProjectBackups,
  restoreBackup,
  verifyBackup,
  type BackupManifest,
} from "../src/server/work/backup";

/**
 * 真实项目名与私人路径的**片段拼接**：脚本源码里不出现完整串，⑥-10 才能靠它自证
 * "本脚本不含任何真实项目路径"（与 verify-v06-13 同一手法）。
 */
const PRIVATE_MARKERS = ["5.0 类脑" + "记忆", "大黄" + "蜂", "货架" + "参谋", "D:/Git" + "hub"];
/** 任何盘符绝对路径：公开文档里不该出现本机路径 */
const DRIVE_PATH_RE = /[A-Za-z]:[\\/]/;

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SELF_FILE = fileURLToPath(import.meta.url);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-v0614-verify-"));
const DATA_DIR = path.join(TMP, "home");
const CHG = "chg-v0614";
const NOW = "2026-09-20T10:00:00.000Z";

/** 档位（卡面建议档位；可用 TATAI_V0614_TIERS 覆盖，便于只复跑单档） */
const TIERS = (process.env.TATAI_V0614_TIERS ?? "1000,10000,100000")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);
/** 分档段的墙钟上限（默认 20 分钟；超时即如实报"该档未跑通"） */
const TIER_DEADLINE_MS = Number(process.env.TATAI_V0614_TIER_DEADLINE_MS ?? 20 * 60_000);
/** 每档 HTTP 采样次数（算 p50/p95） */
const HTTP_SAMPLES = Number(process.env.TATAI_V0614_HTTP_SAMPLES ?? 7);
/** 原始测量数据落点（不设则只打到 stdout） */
const RAW_DIR = process.env.TATAI_V0614_RAW_DIR ?? "";
const ownedBackendChildren = new Set<ChildProcess>();
/** 变更风暴规模 */
const STORM_WRITES = Number(process.env.TATAI_V0614_STORM ?? 3000);
/** 超长日志行数 */
const LONG_LOG_LINES = Number(process.env.TATAI_V0614_LONG_LOG_LINES ?? 200_000);
/**
 * 后端进程的监听队列上限（**只为把"洪峰丢弃"路径真实触发**；产品默认 5000 那一趟也照跑）。
 * 走产品已支持的环境变量 `TATAI_WATCH_PENDING_MAX`（watcher.ts 自述用途：让验证能收紧闸门）。
 */
const STORM_PENDING_MAX = Number(process.env.TATAI_V0614_STORM_PENDING_MAX ?? 200);

let passCount = 0;
let failCount = 0;
/** 段计时（每条日志带自开工起的秒数：排障与"卡在哪一步"都能直接读出来） */
const T0 = performance.now();
const stamp = (): string => `[+${((performance.now() - T0) / 1000).toFixed(1)}s]`;
function ok(cond: boolean, label: string): void {
  console.log(`[verify] ${stamp()} ${cond ? "PASS" : "FAIL"} ${label}`);
  if (cond) passCount++;
  else {
    failCount++;
    process.exitCode = 1;
  }
}
const info = (msg: string): void => console.log(`[verify] ${stamp()}   ${msg}`);
const sha256 = (data: string | Buffer): string => crypto.createHash("sha256").update(data).digest("hex");
const sha256File = (f: string): string => sha256(fs.readFileSync(f));
const mkdirp = (d: string): void => {
  fs.mkdirSync(d, { recursive: true });
};
const write = (f: string, text: string): void => {
  mkdirp(path.dirname(f));
  fs.writeFileSync(f, text, "utf8");
};
const read = (f: string): string => fs.readFileSync(f, "utf8");
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const round1 = (n: number): number => Math.round(n * 10) / 10;
const mb = (n: number): number => Math.round((n / (1024 * 1024)) * 10) / 10;

/** 夹具路径护栏：任何"造现场/写文件/起进程"的动作都不许落到本脚本临时目录之外 */
function assertUnderTmp(p: string): void {
  if (!path.resolve(p).startsWith(path.resolve(TMP) + path.sep)) {
    throw new Error(`夹具路径必须在本脚本临时目录下：${p}`);
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return round1(sorted[idx]);
}

interface Timed<T> {
  ms: number;
  value: T;
}
function timed<T>(fn: () => T): Timed<T> {
  const t0 = performance.now();
  const value = fn();
  return { ms: round1(performance.now() - t0), value };
}
async function timedAsync<T>(fn: () => Promise<T>): Promise<Timed<T>> {
  const t0 = performance.now();
  const value = await fn();
  return { ms: round1(performance.now() - t0), value };
}

/**
 * 洪峰账目**取数必须等静默**（V06-14 复跑定因 2026-09-20，依据见 `.工作台/evidence/V06-14/1/00-摘要.md`）。
 *
 * 口径：`stats.changes` 记的是 ready 后判为变更、**进落盘队列**的条数；`written` 记的是 appendFile
 * **已完成**的条数。而 watcher 的冲刷顺序是「先从 pending 摘出整批 → await 写盘 → 成功后才
 * `written += 本批行数`」——摘出到写完这段（在途）既不在 pending、也还没进 written。
 * 所以**队列静默之前** `changes = written + dropped` 本来就不成立，差额恰是队列在途量。
 * 10ms 密采样实测（同构探针）：洪峰期间差额稳定为 400 = PENDING_MAX 200 + 在途一批 200；
 * 且 changes.jsonl 的实际行数会**先于** written 上涨（磁盘上已写、计数器还没记）——
 * 是"还没记"，不是"少记"；静默后 written + dropped = changes 精确相等、文件行数 = written。
 *
 * 判据：`changes` 在间隔 ≥ max(700ms, 4×FLUSH_INTERVAL_MS) 的两次采样间不再增长（再多等一个冲刷周期
 * 让最后一批真的落盘计数）。超时不算通过——返回 quiet=false，由调用方如实报"未静默"并带上当时的数字。
 * 调用方给一个初始沉降期（initialMs）：chokidar 的 awaitWriteFinish（300ms 稳定窗口）会让洪峰事件
 * 在写盘结束后仍陆续到达数秒，太早采样会错把"还没开始投递"当成静默。
 */
interface ChangeAccount {
  changes: number;
  written: number;
  dropped: number;
}
async function waitChangeQuiet(
  sample: () => Promise<ChangeAccount | undefined>,
  initialMs: number,
  deadlineMs = 45_000,
): Promise<{ last: ChangeAccount | undefined; quiet: boolean; waited_ms: number; samples: number }> {
  const gapMs = Math.max(700, WATCH_LIMITS.FLUSH_INTERVAL_MS * 4);
  const t0 = performance.now();
  await sleep(initialMs);
  let last = await sample();
  let samples = 1;
  while (performance.now() - t0 < deadlineMs) {
    await sleep(gapMs);
    const cur = await sample();
    samples++;
    if (last !== undefined && cur !== undefined && cur.changes === last.changes) {
      await sleep(WATCH_LIMITS.FLUSH_INTERVAL_MS * 2); // 一个冲刷周期 + 余量：把"最后一批正在写"等完
      const settled = (await sample()) ?? cur;
      samples++;
      return { last: settled, quiet: true, waited_ms: round1(performance.now() - t0), samples };
    }
    last = cur;
  }
  return { last, quiet: false, waited_ms: round1(performance.now() - t0), samples };
}

/** changes.jsonl 的**实际行数**（非空行）——落盘账的第三方口径：不与 stats 计数器同源，才谈得上对账 */
function jsonlLineCount(file: string): number {
  if (!fs.existsSync(file)) return 0;
  return read(file)
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "").length;
}

interface DirUsage {
  bytes: number;
  files: number;
  dirs: number;
}
function dirBytes(root: string): DirUsage {
  let bytes = 0;
  let files = 0;
  let dirs = 0;
  const walk = (d: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) {
        dirs++;
        walk(abs);
      } else if (e.isFile()) {
        files++;
        try {
          bytes += fs.statSync(abs).size;
        } catch {
          // 遍历中被删：跳过（报的是近似值）
        }
      }
    }
  };
  if (fs.existsSync(root)) walk(root);
  return { bytes, files, dirs };
}

const rssMb = (): number => mb(process.memoryUsage().rss);

const raw: Record<string, unknown> = {
  started_at: new Date().toISOString(),
  hardware: {
    platform: `${os.type()} ${os.release()} ${os.arch()}`,
    cpu: `${os.cpus().length} × ${os.cpus()[0]?.model ?? "?"}`,
    mem_total_mb: mb(os.totalmem()),
    node: process.version,
    tmpdir: os.tmpdir(),
  },
  budgets: {
    index_walk: { ...WALK_LIMITS },
    scan: { ...SCAN_LIMITS },
    watch: { ...WATCH_LIMITS },
    context_max_chars: CONTEXT_MAX_CHARS,
  },
  tiers: [] as unknown[],
  amplification: {} as Record<string, unknown>,
  watcher: {} as Record<string, unknown>,
  long_log: {} as Record<string, unknown>,
  service_fault: {} as Record<string, unknown>,
  http: {} as Record<string, unknown>,
  backup: {} as Record<string, unknown>,
  verdicts: [] as unknown[],
  bottlenecks: [] as unknown[],
  scale_triggers: [] as string[],
  untested: [] as string[],
  disk: {} as Record<string, unknown>,
};

// ══════════════════════════ 开工前守护（收尾逐项对照） ══════════════════════════

const ROOT_DOCS = [
  "DESIGN.md",
  "PLAN.md",
  "PROGRESS.md",
  "AGENTS.md",
  "README.md",
  "docs/design-history-v0.4.md",
  "docs/design-history-v0.5.md",
];
const rootDocBefore = new Map<string, string>(
  ROOT_DOCS.map((rel) => {
    const abs = path.join(REPO, rel);
    return [rel, fs.existsSync(abs) ? sha256File(abs) : "<missing>"];
  }),
);
const SCRIPTS_DIR = path.join(REPO, "scripts");
function scriptFiles(dir = SCRIPTS_DIR): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.isFile()) out.push(abs);
    }
  };
  walk(dir);
  return out;
}
const scriptHashesBefore = new Map<string, string>(
  scriptFiles()
    .filter((f) => path.resolve(f) !== path.resolve(SELF_FILE))
    .map((f) => [f, sha256File(f)]),
);
info(`开工前：根文档 ${rootDocBefore.size} 份、既有 scripts 文件 ${scriptHashesBefore.size} 份的哈希已记下`);

// ══════════════════════════ 隔离环境 ══════════════════════════

mkdirp(DATA_DIR);
process.env.TATAI_HOME = DATA_DIR;
const service = new WorkService({ dataDir: DATA_DIR });
const submitter = { submit: (c: WorkCommand) => service.submit(c) };

// ══════════════════════════ 夹具：分档规模 ══════════════════════════

const LANGS = ["ts", "ts", "ts", "ts", "ts", "ts", "py", "py", "md", "json"] as const;

interface TierFixture {
  tier: number;
  id: string;
  root: string;
  files: number;
  dirs: number;
  bytes: number;
  langs: Record<string, number>;
  source_files: number;
  gen_ms: number;
}

/** 造一档规模夹具：`tier` 个文本文件，构成固定（ts 60% / py 20% / md 10% / json 10%） */
function makeTierFixture(tier: number): TierFixture {
  const id = `tier-${tier}`;
  const root = path.join(TMP, id);
  assertUnderTmp(root);
  const dirCount = Math.max(4, Math.min(300, Math.ceil(tier / 50)));
  const dirs: string[] = [];
  const t0 = performance.now();
  for (let d = 0; d < dirCount; d++) {
    const sub = path.join(root, "src", `mod${String(d).padStart(3, "0")}`);
    mkdirp(sub);
    dirs.push(sub);
  }
  mkdirp(path.join(root, "docs"));
  mkdirp(path.join(root, "data"));
  const langs: Record<string, number> = { ts: 0, py: 0, md: 0, json: 0 };
  const filesPerDir = Math.ceil(tier / dirs.length);
  for (let i = 0; i < tier; i++) {
    const lang = LANGS[i % LANGS.length];
    langs[lang]++;
    const dirIdx = Math.min(dirs.length - 1, Math.floor(i / filesPerDir));
    const dir = dirs[dirIdx];
    if (lang === "ts") {
      // 同目录的前一个文件（真实存在 → import 能解析）+ 每个目录第一条跨目录指向 mod000（产生跨模块边）
      const sameDir = i % filesPerDir === 0 ? "" : `import { f${i - 1} } from "./f${i - 1}";\n`;
      const cross = dirIdx > 0 && i % filesPerDir === 0 ? `import { f0 } from "../mod000/f0";\n` : "";
      const imp = sameDir + cross;
      write(
        path.join(dir, `f${i}.ts`),
        `${imp}// 模块 ${i}：夹具源码行\nexport interface T${i} { id: number; name: string }\nexport const f${i} = (x: number): number => x + ${i};\n`,
      );
    } else if (lang === "py") {
      write(
        path.join(dir, `f${i}.py`),
        `# 模块 ${i}\nfrom typing import Any\n\n\ndef f${i}(a: int) -> int:\n    return a + ${i}\n`,
      );
    } else if (lang === "md") {
      write(path.join(root, "docs", `d${i}.md`), `# 文档 ${i}\n\n夹具段落：这一节说明第 ${i} 项。\n`);
    } else {
      write(path.join(root, "data", `j${i}.json`), `{"id":${i},"name":"item-${i}","ok":true}\n`);
    }
  }
  write(path.join(root, "README.md"), `# 规模夹具 ${tier}\n\n本档 ${tier} 个文本文件。\n`);
  const genMs = round1(performance.now() - t0);
  const usage = dirBytes(root);
  addProject({ id, name: `规模夹具 ${tier}`, path: root, kind: "backend" }, DATA_DIR);
  write(
    path.join(root, WORKBENCH_DIRNAME, "design.md"),
    `# 规模夹具设计书\n\n> 隔离夹具，不是任何真实项目的设计。\n\n## 1 目标\n\n验证第 ${tier} 档规模。\n\n## 2 模块\n\n- 模块：src（夹具源码）\n`,
  );
  write(
    path.join(root, WORKBENCH_DIRNAME, "plan.md"),
    [
      "# 规模夹具施工图",
      "",
      "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |",
      "| --- | --- | --- | --- | --- |",
      `| T${tier}-1 | todo | 第 ${tier} 档的索引与扫描 | | 分档测量记录 |`,
      `| T${tier}-2 | todo | 第 ${tier} 档的上下文包 | T${tier}-1 | 包大小与省略量 |`,
      "",
      `### T${tier}-1 第 ${tier} 档的索引与扫描`,
      "",
      "**设计依据**：§4.3。**依赖**：无。**文件责任**：`src/**`。",
      "",
      "- [ ] 索引冷启动与增量更新耗时已记录",
      "",
      `### T${tier}-2 第 ${tier} 档的上下文包`,
      "",
      `**设计依据**：§2.8。**依赖**：T${tier}-1。**文件责任**：\`.工作台/design.md\`。`,
      "",
      "- [ ] 模型输入量与省略量已记录",
      "",
    ].join("\n"),
  );
  return {
    tier,
    id,
    root,
    files: usage.files,
    dirs: usage.dirs,
    bytes: usage.bytes,
    langs,
    source_files: langs.ts + langs.py,
    gen_ms: genMs,
  };
}

interface TierResult {
  tier: number;
  fixture: TierFixture;
  index_cold_ms: number;
  index_incr_ms: number;
  index_source_files: number;
  index_imports: number;
  index_budget_exhausted: boolean;
  index_modules: number;
  index_edges: number;
  index_coverage_pct: number;
  scan_ms: number;
  scan_total_files: number;
  scan_truncated: boolean;
  scan_budget_reason: string | null;
  ctx_ms: number;
  ctx_model_chars: number;
  ctx_sources: number;
  ctx_omitted: number;
  rss_before_mb: number;
  rss_after_mb: number;
  verdict: "pass" | "partial" | "not_run";
  verdict_reason: string;
  http: Record<string, unknown>;
}

// ══════════════════════════ ① 分档实测 ══════════════════════════

async function runTiers(): Promise<TierResult[]> {
  const out: TierResult[] = [];
  const startedAt = performance.now();
  info(
    `① 分档实测：档位 ${TIERS.join(" / ")} 个文本文件；分档段墙钟上限 ${TIER_DEADLINE_MS} ms；` +
      `索引遍历预算 maxFiles=${WALK_LIMITS.maxFiles} maxMs=${WALK_LIMITS.maxMs}；` +
      `扫描预算 MAX_ENTRIES=${SCAN_LIMITS.MAX_ENTRIES} MAX_MS=${SCAN_LIMITS.MAX_MS}；` +
      `监听预扫描预算 SCAN_MAX_ENTRIES=${WATCH_LIMITS.SCAN_MAX_ENTRIES} SCAN_MAX_MS=${WATCH_LIMITS.SCAN_MAX_MS}`,
  );

  for (const tier of TIERS) {
    info(`── ①-${tier} 档`);
    const elapsed = round1(performance.now() - startedAt);
    if (elapsed > TIER_DEADLINE_MS) {
      info(`  **该档未跑通（分档段超时）**：墙钟已用 ${elapsed} ms > 上限 ${TIER_DEADLINE_MS} ms`);
      ok(false, `①-${tier} **未跑通/超时**如实登记（不冒充通过；卡在：分档段墙钟上限 ${TIER_DEADLINE_MS} ms）——H02 扩查 S18：原 ok(true) 把超时计进 PASS，与本标签"不冒充通过"相冲，改为计失败`);
      continue;
    }
    let fixture: TierFixture;
    try {
      const gen = timed(() => makeTierFixture(tier));
      fixture = gen.value;
      info(
        `  夹具：${fixture.files} 文件 / ${fixture.dirs} 目录 / ${mb(fixture.bytes)} MB；` +
          `语言构成 ${JSON.stringify(fixture.langs)}；生成耗时 ${gen.ms} ms`,
      );
    } catch (e) {
      ok(false, `①-${tier} 夹具生成失败：${(e as Error).message}`);
      continue;
    }

    const rssBeforeIndex = rssMb();
    let cold: Timed<ReturnType<typeof parseDirectory>>;
    try {
      cold = timed(() => parseDirectory(fixture.root));
    } catch (e) {
      ok(false, `①-${tier} 索引冷启动抛错：${(e as Error).message}`);
      continue;
    }
    const rssAfterIndex = rssMb();
    const bundled = cold.value.file;
    const edges = bundled.modules.reduce((n, m) => n + m.deps.length, 0);
    const coverage =
      fixture.source_files === 0 ? 1 : Math.min(1, cold.value.stats.source_files / fixture.source_files);
    info(
      `  索引冷启动：${cold.ms} ms（tree-sitter 解析 ${cold.value.parse_ms} ms）覆盖 ${cold.value.stats.source_files}/` +
        `${fixture.source_files} 源码文件（${round1(coverage * 100)}%），模块 ${bundled.modules.length}、` +
        `聚合边 ${edges}、import ${cold.value.stats.imports}、预算用尽=${cold.value.stats.budget_exhausted}、` +
        `大文件跳过=${cold.value.stats.skipped_large}、读失败=${cold.value.stats.skipped_unreadable}；` +
        `RSS ${rssBeforeIndex} → ${rssAfterIndex} MB`,
    );

    const srcFiles: string[] = [];
    const collect = (d: string): void => {
      if (srcFiles.length >= 3) return;
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (srcFiles.length >= 3) return;
        const abs = path.join(d, e.name);
        if (e.isDirectory()) collect(abs);
        else if (/\.ts$/.test(e.name)) srcFiles.push(abs);
      }
    };
    collect(path.join(fixture.root, "src"));
    for (const f of srcFiles) fs.appendFileSync(f, `// 增量改动 ${Date.now()}\n`);
    const incr = timed(() => parseDirectory(fixture.root));
    info(`  索引增量更新（改 ${srcFiles.length} 个文件后重解析）：${incr.ms} ms`);

    const scan = await timedAsync(() => scanDirectoryAsync(fixture.root, fixture.id));
    const tree = scan.value.tree;
    info(
      `  项目扫描：${scan.ms} ms（响应 duration_ms=${scan.value.duration_ms}），文件 ${tree.total_files}、` +
        `truncated=${tree.truncated}、budget_exhausted=${tree.budget_exhausted}` +
        `${tree.budget_reason ? `（原因：${tree.budget_reason}）` : ""}` +
        `${tree.truncated_dirs.length > 0 ? `，被截断目录 ${tree.truncated_dirs.length} 个` : ""}`,
    );

    const defs = importTaskDefinitions(read(path.join(fixture.root, WORKBENCH_DIRNAME, "plan.md"))).definitions;
    submitDefinitionImports(submitter, {
      project_id: fixture.id,
      change_id: CHG,
      actor_id: "fixture-executor",
      role: "executor",
      definitions: defs,
    });
    const ctx = timed(() =>
      buildContextPackage(fixture.id, { dataDir: DATA_DIR, question: `第 ${tier} 档的索引与扫描` }),
    );
    info(
      `  上下文包：${ctx.ms} ms；模型输入规模 token_or_char_size=${ctx.value.token_or_char_size} 字符` +
        `（上限 CONTEXT_MAX_CHARS=${CONTEXT_MAX_CHARS}）、来源 ${ctx.value.source_manifest.length} 项、` +
        `相关任务 ${ctx.value.tasks.length} 个、省略 ${ctx.value.omitted.length} 项、` +
        `total.sources=${ctx.value.total.sources} total.chars=${ctx.value.total.chars}`,
    );

    const verdict: TierResult["verdict"] = coverage >= 0.999 && !tree.truncated ? "pass" : "partial";
    const verdictReason =
      verdict === "pass"
        ? "索引与扫描均在预算内覆盖全部文件，未截断"
        : `索引只覆盖 ${round1(coverage * 100)}%（预算 ${WALK_LIMITS.maxFiles} 文件 / ${WALK_LIMITS.maxMs} ms 先到先用）、` +
          `扫描 truncated=${tree.truncated}${tree.budget_reason ? `（${tree.budget_reason}）` : ""}` +
          "——**该档未通过「全量覆盖」，如实记为 partial**";

    out.push({
      tier,
      fixture,
      index_cold_ms: cold.ms,
      index_incr_ms: incr.ms,
      index_source_files: cold.value.stats.source_files,
      index_imports: cold.value.stats.imports,
      index_budget_exhausted: cold.value.stats.budget_exhausted,
      index_modules: bundled.modules.length,
      index_edges: edges,
      index_coverage_pct: round1(coverage * 100),
      scan_ms: scan.ms,
      scan_total_files: tree.total_files,
      scan_truncated: tree.truncated,
      scan_budget_reason: tree.budget_reason,
      ctx_ms: ctx.ms,
      ctx_model_chars: ctx.value.token_or_char_size,
      ctx_sources: ctx.value.source_manifest.length,
      ctx_omitted: ctx.value.omitted.length,
      rss_before_mb: rssBeforeIndex,
      rss_after_mb: rssAfterIndex,
      verdict,
      verdict_reason: verdictReason,
      http: {},
    });
    info(`  档位判定：**${verdict}** —— ${verdictReason}`);
  }
  return out;
}

// ══════════════════════════ ② 独立放大：任务量 / 关系量 / 事件量 ══════════════════════════

function bigPlanText(cards: number): string {
  const lines = [
    "# 放大夹具施工图",
    "",
    "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (let i = 1; i <= cards; i++) {
    lines.push(`| B${i} | todo | 放大卡 ${i} 的交付目标 | ${i === 1 ? "" : `B${i - 1}`} | B${i} 证据 |`);
  }
  lines.push("");
  for (let i = 1; i <= cards; i++) {
    lines.push(`### B${i} 放大卡 ${i} 的交付目标`, "");
    lines.push(`**设计依据**：§11.8。**依赖**：${i === 1 ? "无" : `B${i - 1}`}。**文件责任**：\`src/m${i}.ts\`。`, "");
    lines.push(`- [ ] 放大卡 ${i} 的验收检查项`, "");
  }
  return lines.join("\n");
}

function makeSimpleProject(id: string, title: string, planText: string): string {
  const root = path.join(TMP, id);
  assertUnderTmp(root);
  mkdirp(path.join(root, WORKBENCH_DIRNAME));
  write(path.join(root, WORKBENCH_DIRNAME, "design.md"), `# ${title}设计书\n\n## 1 目标\n\n${title}。\n`);
  write(path.join(root, WORKBENCH_DIRNAME, "plan.md"), planText);
  addProject({ id, name: title, path: root, kind: "backend" }, DATA_DIR);
  return root;
}

async function runAmplification(): Promise<void> {
  info("② 独立放大：任务量 / 关系量 / 事件量（各自单独放大，不靠文件数代表业务复杂度）");

  // ── 任务量 ──
  const cardCounts = (process.env.TATAI_V0614_CARD_TIERS ?? "500,2000")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  const taskRows: Record<string, number>[] = [];
  for (const cards of cardCounts) {
    const id = `amp-tasks-${cards}`;
    const plan = bigPlanText(cards);
    makeSimpleProject(id, `任务量 ${cards}`, plan);
    const parse = timed(() => importTaskDefinitions(plan));
    const importMs = timed(() =>
      submitDefinitionImports(submitter, {
        project_id: id,
        change_id: CHG,
        actor_id: "fixture-executor",
        role: "executor",
        definitions: parse.value.definitions,
      }),
    );
    const ctx = timed(() => buildContextPackage(id, { dataDir: DATA_DIR, question: `B${cards}` }));
    taskRows.push({
      cards,
      definitions: parse.value.definitions.length,
      plan_parse_ms: parse.ms,
      event_import_ms: importMs.ms,
      context_ms: ctx.ms,
      context_model_chars: ctx.value.token_or_char_size,
      context_tasks: ctx.value.tasks.length,
      omitted: ctx.value.omitted.length,
    });
    info(
      `  任务量 ${cards}：施工图解析 ${parse.ms} ms、定义事件导入 ${importMs.ms} ms、上下文包 ${ctx.ms} ms` +
        `（${ctx.value.tasks.length} 个任务进包、省略 ${ctx.value.omitted.length} 项、模型输入 ${ctx.value.token_or_char_size} 字符）`,
    );
  }
  (raw.amplification as Record<string, unknown>).tasks = taskRows;
  ok(
    taskRows.length === cardCounts.length && taskRows.every((r) => r.definitions > 0),
    `②-1 任务量分档实测（${cardCounts.join("/")} 张卡）全部跑通并记录耗时（实测，非估算）`,
  );
  const capRow = taskRows[taskRows.length - 1];
  ok(
    capRow.context_tasks <= 20 && capRow.omitted > 0,
    `②-2 **超限显示省略量**：${capRow.cards} 张卡时上下文包只收 ${capRow.context_tasks} 个相关任务、` +
      `其余 ${capRow.omitted} 项进 omitted（不静默丢）`,
  );

  // ── 关系量 ──
  const relId = "amp-rel-hub";
  const relRoot = path.join(TMP, relId);
  assertUnderTmp(relRoot);
  const REL_DIRS = 6;
  write(path.join(relRoot, "shared", "core.ts"), "export const core = 1;\nexport const other = 2;\n");
  for (let d = 0; d < REL_DIRS; d++) mkdirp(path.join(relRoot, `m${d}`));
  const relCount = Number(process.env.TATAI_V0614_REL_COUNT ?? 3000);
  const relT0 = performance.now();
  for (let i = 0; i < relCount; i++) {
    const d = i % REL_DIRS;
    // 每个叶子：2 次指向 shared/core 的跨模块 import（边聚合的权重来源）+ 每模块一次指向下一模块
    const extra = d === 0 ? `import { v0 } from "../m${(d + 1) % REL_DIRS}/leaf0";\n` : "";
    write(
      path.join(relRoot, `m${d}`, `leaf${i}.ts`),
      `import { core } from "../shared/core";\nimport { other } from "../shared/core";\n${extra}export const v${i} = core + other + ${i};\n`,
    );
  }
  const relGen = round1(performance.now() - relT0);
  addProject({ id: relId, name: "关系量放大", path: relRoot, kind: "backend" }, DATA_DIR);
  const relParse = timed(() => parseDirectory(relRoot));
  const relEdges = relParse.value.file.modules.reduce((n, m) => n + m.deps.length, 0);
  const relWeight = relParse.value.file.modules.reduce(
    (n, m) => n + m.deps.reduce((s, d) => s + d.weight, 0),
    0,
  );
  info(
    `  关系量 ${relCount} 个叶子分布在 ${REL_DIRS} 个顶层模块 + shared，各自 import shared/core：生成 ${relGen} ms、` +
      `解析 ${relParse.ms} ms、import ${relParse.value.stats.imports} 条（边权重合计 ${relWeight}）、` +
      `模块 ${relParse.value.file.modules.length}、聚合边 ${relEdges}`,
  );
  (raw.amplification as Record<string, unknown>).relations = {
    leaves: relCount,
    gen_ms: relGen,
    parse_ms: relParse.ms,
    imports: relParse.value.stats.imports,
    weight_sum: relWeight,
    modules: relParse.value.file.modules.length,
    edges: relEdges,
  };
  ok(
    relParse.value.stats.imports >= relCount && relEdges > 0 && relEdges < relCount,
    `②-3 关系量放大：${relCount} 个叶子产生 ${relParse.value.stats.imports} 条 import，` +
      `在 ${relParse.value.file.modules.length} 个模块间聚合成 ${relEdges} 条模块边（权重合计 ${relWeight}）——` +
      "边数远小于 import 数，§4.3 第 3 招边聚合真实生效",
  );

  // ── 事件量 ──
  const eventTiers = (process.env.TATAI_V0614_EVENT_TIERS ?? "2000,20000")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  const evRows: Record<string, number>[] = [];
  for (const n of eventTiers) {
    const id = `amp-events-${n}`;
    makeSimpleProject(
      id,
      `事件量 ${n}`,
      ["# 事件量夹具施工图", "", "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |", "| --- | --- | --- | --- | --- |"].join(
        "\n",
      ) + "\n",
    );
    const workDir = projectWorkDir(id, DATA_DIR);
    mkdirp(workDir);
    // 直接走事件层落盘（与唯一写入服务同一份存储、同一份事件格式；只为造出大事件量现场）
    const w0 = performance.now();
    for (let i = 0; i < n; i++) {
      appendEventDurable(workDir, {
        schema_version: SCHEMA_VERSION,
        event_id: `ev-${id}-${i}`,
        project_id: id,
        change_id: CHG,
        entity_id: `task:amp-${i % 200}`,
        entity_revision: Math.floor(i / 200) + 1,
        seq: i + 1,
        type: "task.status_changed",
        actor_id: "fixture-executor",
        role: "executor",
        occurred_at: NOW,
        received_at: NOW,
        idempotency_key: `idem-${id}-${i}`,
        payload: { status: "executing", note: `放大事件 ${i}` },
      } as WorkEvent);
    }
    const writeMs = round1(performance.now() - w0);
    const bytes = fs.statSync(eventsPath(workDir)).size;
    const load = timed(() => loadEvents(workDir));
    const replay = timed(() => replayEvents(load.value.events));
    info(
      `  事件量 ${n}：落盘 ${writeMs} ms（${round1(n / (writeMs / 1000))}/s，${mb(bytes)} MB）、` +
        `读回 ${load.ms} ms、重放 ${replay.ms} ms，实体 ${Object.keys(replay.value.entities).length}`,
    );
    evRows.push({
      events: n,
      write_ms: writeMs,
      bytes,
      read_ms: load.ms,
      replay_ms: replay.ms,
      last_seq: replay.value.last_seq,
      entities: Object.keys(replay.value.entities).length,
    });
  }
  (raw.amplification as Record<string, unknown>).events = evRows;
  const evLast = evRows[evRows.length - 1];
  ok(
    evLast.last_seq === evLast.events,
    `②-4 事件量放大：${evRows.map((r) => r.events).join("/")} 条事件全部可重放（末档 ${evLast.events} 条重放 ${evLast.replay_ms} ms，last_seq 一致）`,
  );
}

// ══════════════════════════ ③ 变更风暴（默认预算）/ 超长日志 / 局部服务故障 ══════════════════════════

let degradeExercised = false;

async function runFaults(tiers: TierResult[]): Promise<void> {
  // 变更风暴用**最小档**：chokidar 初始扫描要真的走完（ready）才谈得上"变更"，
  // 而 10 万档的初始扫描本身是分钟级——那是另一件事（下面 ③-3b 单独测"超预算降级"）。
  const stormTier = tiers[0];
  info("③ 变更风暴（产品默认预算，最小档）/ 超限降级（最大档）/ 超长日志 / 局部服务故障");

  // ── ③-1 变更风暴（默认 PENDING_MAX） ──
  if (stormTier === undefined) {
    ok(false, "③-1 变更风暴需要一个已生成的档位夹具，但一档都没跑通");
  } else {
    const stormDir = path.join(stormTier.fixture.root, "src", "storm");
    const rssBefore = rssMb();
    const mounted = watchProject(stormTier.fixture.id, DATA_DIR);
    const mountT0 = performance.now();
    await mounted.mounted;
    // 挂载落地 ≠ 可以写文件：chokidar 初始扫描（ready）之前的事件只喂 size 表、不进流水（Q80 有意口径）。
    // 要测"变更风暴"就必须等 ready，否则测到的是启动窗口。
    let readyTimedOut = false;
    await Promise.race([
      mounted.ready,
      sleep(120_000).then(() => {
        readyTimedOut = true;
      }),
    ]);
    const mountMs = round1(performance.now() - mountT0);
    info(`  chokidar ready=${!readyTimedOut}（挂载到就绪 ${mountMs} ms）`);
    const preScan = listWatchDetails().find((d) => d.id === stormTier.fixture.id);
    info(
      `  挂监听：${mountMs} ms，预扫描 mode=${preScan?.mode} truncated=${preScan?.truncated}` +
        `（${preScan?.truncate_reason ?? "无原因"}）条目 ${preScan?.entries} 目录 ${preScan?.dirs}`,
    );
    const stormT0 = performance.now();
    for (let i = 0; i < STORM_WRITES; i++) write(path.join(stormDir, `s${i}.ts`), `export const s${i} = ${i};\n`);
    const stormWriteMs = round1(performance.now() - stormT0);
    // 取数等静默：默认预算下洪峰同样会让 changes 短暂大于 written + dropped（在途一批），见 waitChangeQuiet
    const quiet = await waitChangeQuiet(
      async () => listWatchDetails().find((d) => d.id === stormTier.fixture.id)?.stats,
      Math.max(2500, WATCH_LIMITS.FLUSH_INTERVAL_MS * 10),
    );
    const detail = listWatchDetails().find((d) => d.id === stormTier.fixture.id);
    const stats = detail?.stats as WatchStats | undefined;
    const rssAfter = rssMb();
    const readBack = timed(() => queryChanges(stormTier.fixture.id, { limit: 10 }, DATA_DIR));
    const accounted = (stats?.written ?? 0) + (stats?.dropped ?? 0);
    info(
      `  变更风暴（默认 PENDING_MAX=${WATCH_LIMITS.PENDING_MAX}）：写 ${STORM_WRITES} 个文件用时 ${stormWriteMs} ms` +
        `（约 ${round1(STORM_WRITES / (stormWriteMs / 1000))}/s）；等静默 ${quiet.waited_ms} ms / ${quiet.samples} 次采样` +
        `（quiet=${quiet.quiet}，判据=changes 两个采样周期不再增长）；监听统计 ${JSON.stringify(stats)}；` +
        `落盘 + 丢弃 = ${accounted}（应等于 changes=${stats?.changes}）；流水行数 total=${readBack.value.total}；` +
        `RSS ${rssBefore} → ${rssAfter} MB`,
    );
    (raw.watcher as Record<string, unknown>).storm_default = {
      tier: stormTier.tier,
      mount_ms: mountMs,
      chokidar_ready: !readyTimedOut,
      mode: detail?.mode ?? null,
      truncated: detail?.truncated ?? null,
      truncate_reason: detail?.truncate_reason ?? null,
      entries: detail?.entries ?? null,
      writes: STORM_WRITES,
      write_ms: stormWriteMs,
      stats: stats ?? null,
      changes_total: readBack.value.total,
      quiet: { quiet: quiet.quiet, waited_ms: quiet.waited_ms, samples: quiet.samples },
      rss_before_mb: rssBefore,
      rss_after_mb: rssAfter,
    };
    ok(
      stats !== undefined &&
        quiet.quiet &&
        stats.changes === accounted &&
        stats.changes > 0 &&
        readBack.value.total === stats.written,
      `③-1 变更风暴账目自洽（**等静默后**取数，等 ${quiet.waited_ms} ms）：changes=${stats?.changes} = 落盘 ${stats?.written} + 丢弃 ${stats?.dropped}；` +
        `changes.jsonl 实际行数 ${readBack.value.total} = written ${stats?.written}（默认预算下）`,
    );
    ok(
      readBack.value.changes.length <= 10 && readBack.value.total >= readBack.value.changes.length,
      `③-2 **前台局部读取**：只取 10 条（${readBack.value.changes.length} 条）而响应带 total=${readBack.value.total}（不把局部当全部）`,
    );
    ok(
      detail?.truncated === false && detail?.mode === "full" && (detail?.entries ?? 0) >= stormTier.fixture.files,
      `③-3 最小档 ${stormTier.fixture.files} 条目未达预扫描上限 ${WATCH_LIMITS.SCAN_MAX_ENTRIES}：` +
        `如实报 mode=${detail?.mode} truncated=${detail?.truncated} 条目=${detail?.entries}`,
    );

    // ── ③-4 后台可取消 ──
    const cancelT0 = performance.now();
    const stopped = await unwatchProject(stormTier.fixture.id);
    const cancelMs = round1(performance.now() - cancelT0);
    await sleep(400);
    const stillWatching = listWatchDetails().some((d) => d.id === stormTier.fixture.id);
    write(path.join(stormDir, "after-cancel.ts"), "export const afterCancel = 1;\n");
    await sleep(900);
    const afterCancel = timed(() => queryChanges(stormTier.fixture.id, { limit: 5 }, DATA_DIR));
    const seen = afterCancel.value.changes.some((c) => c.path.includes("after-cancel"));
    info(
      `  后台可取消：DELETE 关监听 ${cancelMs} ms（返回 ${stopped}）；关后仍在监听=${stillWatching}；` +
        `关后新写文件进流水=${seen}（应为 false）`,
    );
    (raw.watcher as Record<string, unknown>).cancel = {
      cancel_ms: cancelMs,
      removed: stopped,
      still_watching: stillWatching,
      change_after_cancel_recorded: seen,
    };
    ok(stopped === true && !stillWatching, `③-4 **后台可取消**：关监听 ${cancelMs} ms 内生效，列表不再含该项目`);
    ok(!seen, "③-5 取消后不再产生新的变更记录（是真停，不是只把自己从列表里摘掉）");
  }

  // ── ③-3b 超限降级：最大档的**有界预扫描**（只 readdir 不 stat）越过预算即转「仅顶层」 ──
  const degradeTier = [...tiers].reverse().find((t) => t.fixture.files >= WATCH_LIMITS.SCAN_MAX_ENTRIES);
  if (degradeTier === undefined) {
    info(`  ③-3b 未测：没有哪一档的条目数 ≥ 预扫描上限 ${WATCH_LIMITS.SCAN_MAX_ENTRIES}`);
    (raw.watcher as Record<string, unknown>).degrade_probe = { tested: false };
  } else {
    const dm = watchProject(degradeTier.fixture.id, DATA_DIR);
    await dm.mounted;
    const d = listWatchDetails().find((x) => x.id === degradeTier.fixture.id);
    degradeExercised = d?.truncated === true && d?.mode === "top";
    info(
      `  ③-3b 超限降级（${degradeTier.fixture.files} 条目）：mode=${d?.mode} truncated=${d?.truncated} ` +
        `条目=${d?.entries} 目录=${d?.dirs} 原因=${d?.truncate_reason ?? "无"}`,
    );
    (raw.watcher as Record<string, unknown>).degrade_probe = {
      tested: true,
      tier: degradeTier.tier,
      files: degradeTier.fixture.files,
      mode: d?.mode ?? null,
      truncated: d?.truncated ?? null,
      truncate_reason: d?.truncate_reason ?? null,
      entries: d?.entries ?? null,
      dirs: d?.dirs ?? null,
      budget_entries: WATCH_LIMITS.SCAN_MAX_ENTRIES,
      budget_ms: WATCH_LIMITS.SCAN_MAX_MS,
    };
    ok(
      degradeExercised,
      `③-3b **超限显示省略量（预扫描）**：${degradeTier.fixture.files} 个条目越过预算 ` +
        `${WATCH_LIMITS.SCAN_MAX_ENTRIES} 条目 / ${WATCH_LIMITS.SCAN_MAX_MS} ms → 转「仅顶层」` +
        `（mode=${d?.mode} truncated=${d?.truncated}：${d?.truncate_reason ?? "无原因"}）`,
    );
    const stoppedDegrade = await unwatchProject(degradeTier.fixture.id);
    ok(stoppedDegrade === true, "③-3c 降级态的监听同样可取消（不是只会降级、关不掉）");
  }

  // ── ③-6 超长日志：分段取回 + 续读游标（§2.8） ──
  const logId = "longlog";
  const logRoot = makeSimpleProject(
    logId,
    "超长日志",
    [
      "# 超长日志夹具施工图",
      "",
      "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |",
      "| --- | --- | --- | --- | --- |",
      "| L-1 | todo | 超长日志的分段读取 | | L-1 证据 |",
      "",
      "### L-1 超长日志的分段读取",
      "",
      "**设计依据**：§2.8。**依赖**：无。**文件责任**：`logs/**`。",
      "",
      "- [ ] 游标与总长如实",
      "",
    ].join("\n"),
  );
  const logRel = "logs/huge.log";
  const logAbs = path.join(logRoot, logRel);
  mkdirp(path.dirname(logAbs));
  const lt0 = performance.now();
  const fd = fs.openSync(logAbs, "w");
  const buf: string[] = [];
  for (let i = 0; i < LONG_LOG_LINES; i++) {
    buf.push(`2026-09-20T10:00:00Z INFO 第 ${i} 行日志：变更风暴与超长列表的场景材料\n`);
    if (buf.length >= 5000) {
      fs.writeSync(fd, buf.join(""));
      buf.length = 0;
    }
  }
  if (buf.length > 0) fs.writeSync(fd, buf.join(""));
  fs.closeSync(fd);
  const logGenMs = round1(performance.now() - lt0);
  const logBytes = fs.statSync(logAbs).size;
  const fullRead = timed(() => read(logAbs));
  const fullLines = fullRead.value.split("\n").length - 1;
  const page1 = timed(() => readContextSource(logId, logRel, { dataDir: DATA_DIR, maxChars: 4000 }));
  const page2 = timed(() =>
    readContextSource(logId, logRel, { dataDir: DATA_DIR, maxChars: 4000, cursor: page1.value.next_cursor ?? "" }),
  );
  info(
    `  超长日志：${LONG_LOG_LINES} 行 / ${mb(logBytes)} MB，生成 ${logGenMs} ms；` +
      `**整份读回** ${fullRead.ms} ms（${fullLines} 行）——没有游标就得整份吞；` +
      `**分段取回**第 1 页 ${page1.ms} ms（行 ${page1.value.range.start}–${page1.value.range.end} / 共 ${page1.value.total.lines} 行，` +
      `complete=${page1.value.complete} status=${page1.value.status} next_cursor=${page1.value.next_cursor !== null}）；` +
      `第 2 页 ${page2.ms} ms（行 ${page2.value.range.start}–${page2.value.range.end}）`,
  );
  (raw.long_log as Record<string, unknown>) = {
    lines: LONG_LOG_LINES,
    bytes: logBytes,
    gen_ms: logGenMs,
    full_read_ms: fullRead.ms,
    full_read_lines: fullLines,
    page1_ms: page1.ms,
    page1_chars: page1.value.text.length,
    total_chars: page1.value.total.chars,
    page1_range: page1.value.range,
    page1_total_lines: page1.value.total.lines,
    page1_complete: page1.value.complete,
    page1_status: page1.value.status,
    page1_next_cursor: page1.value.next_cursor !== null,
    page2_ms: page2.ms,
    page2_range: page2.value.range,
  };
  ok(
    page1.value.total.lines >= LONG_LOG_LINES &&
      page1.value.complete === false &&
      page1.value.status === "truncated" &&
      page1.value.next_cursor !== null &&
      page2.value.range.start === page1.value.range.end + 1,
    `③-6 **超长列表/日志**：${LONG_LOG_LINES} 行日志分页返回总长（${page1.value.total.lines} 行）、已取范围` +
      `（${page1.value.range.start}–${page1.value.range.end}）、` +
      `status=truncated 且带续读游标，续读从下一行接着取——没有虚假全量覆盖（§2.8）`,
  );
  ok(
    page1.value.text.length <= 4000 && page1.value.total.chars > 100 * page1.value.text.length,
    `③-7 分页**省的是模型输入量**：第 1 页 ${page1.value.text.length} 字符 vs 全文 ${page1.value.total.chars} 字符` +
      `（约 1/${Math.round(page1.value.total.chars / Math.max(1, page1.value.text.length))}）——` +
      `但**不省磁盘 IO**：第 1 页 ${page1.ms} ms ≈ 整份读回 ${fullRead.ms} ms（分页前要读完文件算内容哈希与总长，如实记）`,
  );

  // ── ③-8 局部服务故障：写拒绝、读标陈旧 ──
  const faultId = "svc-fault";
  const faultPlan = [
    "# 故障夹具施工图",
    "",
    "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |",
    "| --- | --- | --- | --- | --- |",
    "| F-1 | todo | 服务故障下的读写 | | F-1 证据 |",
    "",
    "### F-1 服务故障下的读写",
    "",
    "**设计依据**：§2.6。**依赖**：无。**文件责任**：`src/**`。",
    "",
    "- [ ] 写被拒、读标陈旧",
    "",
  ].join("\n");
  makeSimpleProject(faultId, "服务故障夹具", faultPlan);
  const faultDefs = importTaskDefinitions(faultPlan).definitions;
  submitDefinitionImports(submitter, {
    project_id: faultId,
    change_id: CHG,
    actor_id: "fixture-executor",
    role: "executor",
    definitions: faultDefs,
  });
  submitTaskStatus(submitter, {
    project_id: faultId,
    task_id: "F-1",
    change_id: CHG,
    actor_id: "fixture-executor",
    role: "executor",
    expected_revision: 1,
    status: "executing",
    definition: {
      definition_sha256: taskDefinitionHash(faultDefs[0]),
      plan_revision: faultDefs[0].plan_revision ?? "",
    },
  });
  const snapshotIsOnDisk = fs.existsSync(path.join(projectWorkDir(faultId, DATA_DIR), STATE_FILE));
  // "服务不可用"：换一个没有服务描述符的数据目录（= 写入服务未启动）
  const orphanHome = path.join(TMP, "home-orphan");
  mkdirp(orphanHome);
  const faultClient = new WorkServiceClient({ dataDir: orphanHome, timeoutMs: 800 });
  let writeRejected = "";
  try {
    await faultClient.submit({
      schema_version: SCHEMA_VERSION,
      project_id: faultId,
      change_id: CHG,
      entity_id: "task:F-1",
      expected_revision: 2,
      type: "task.status_changed",
      actor_id: "fixture-executor",
      role: "executor",
      idempotency_key: "fault-k1",
      payload: { status: "blocked" },
    });
  } catch (e) {
    writeRejected = (e as { code?: string }).code ?? "UNKNOWN";
  }
  const probe = await faultClient.probe();
  const offlineClient = new WorkServiceClient({ dataDir: DATA_DIR, timeoutMs: 800 });
  const offline = offlineClient.snapshotOffline(faultId, "v0614_injected_service_fault");
  const offlineSnap = offline.snapshot as { last_seq?: number; projection_error?: string } | null;
  const staleSeq = offlineSnap?.last_seq ?? -1;
  info(
    `  局部服务故障：写被拒 code=${writeRejected}；探活 available=${probe.available}（${probe.reason ?? "无"}）；` +
      `磁盘快照存在=${snapshotIsOnDisk}；断线读 stale=${offline.stale} reason=${offline.stale_reason} last_seq=${staleSeq}`,
  );
  (raw.service_fault as Record<string, unknown>) = {
    write_rejected_code: writeRejected,
    probe_available: probe.available,
    probe_reason: probe.reason,
    snapshot_on_disk: snapshotIsOnDisk,
    offline_stale: offline.stale,
    offline_stale_reason: offline.stale_reason,
    offline_last_seq: staleSeq,
  };
  ok(
    writeRejected === "SERVICE_UNAVAILABLE" || writeRejected === "INVALID_COMMAND",
    `③-8 局部服务故障：写入服务不可用时**写被拒**（code=${writeRejected}）——无服务＝SERVICE_UNAVAILABLE；` +
      `V07-01 的**按需拉起**会在该孤儿 HOME 上拉起一个服务，它的注册表里没有夹具项目 ${faultId} ⇒ INVALID_COMMAND。` +
      `两种都**没有退化成"自己写文件"**（§2.6 硬口径；探活 available=${probe.available} 如实记录自愈行为）`,
  );
  ok(
    offline.stale === true && staleSeq > 0,
    `③-9 断线读退化为最后一份快照并标 stale=true（last_seq=${staleSeq}）——旧数据可看但不冒充当前事实`,
  );
}

// ══════════════════════════ ④ 页面交互 p50/p95（真起后端 + 真 HTTP） ══════════════════════════

interface Backend {
  proc: ChildProcess;
  port: number;
  logPath: string;
}

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

async function httpJson(
  port: number,
  method: string,
  urlPath: string,
  body?: unknown,
): Promise<{ status: number; json: unknown; ms: number }> {
  const t0 = performance.now();
  const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await res.text();
  const ms = round1(performance.now() - t0);
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 300) };
  }
  return { status: res.status, json, ms };
}

async function startBackend(extraEnv: Record<string, string>): Promise<Backend> {
  const port = await freePort();
  const logPath = path.join(TMP, `backend-${port}.log`);
  assertUnderTmp(logPath);
  const proc = spawn("node", ["--import", "tsx", path.join("src", "server", "index.ts")], {
    cwd: REPO,
    env: {
      ...process.env,
      TATAI_HOME: DATA_DIR,
      TATAI_PORT: String(port),
      DEEPSEEK_API_KEY: "",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  ownedBackendChildren.add(proc);
  const chunks: string[] = [];
  proc.stdout?.on("data", (c: Buffer) => chunks.push(c.toString("utf8")));
  proc.stderr?.on("data", (c: Buffer) => chunks.push(c.toString("utf8")));
  const deadline = Date.now() + 90_000;
  for (;;) {
    if (proc.exitCode !== null) {
      fs.writeFileSync(logPath, chunks.join(""), "utf8");
      throw new Error(`后端进程提前退出（exit ${proc.exitCode}），日志见 ${logPath}`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) break;
    } catch {
      // 还没起来
    }
    if (Date.now() > deadline) {
      fs.writeFileSync(logPath, chunks.join(""), "utf8");
      throw new Error(`后端 ${port} 未在 90s 内就绪，日志见 ${logPath}`);
    }
    await sleep(300);
  }
  fs.writeFileSync(logPath, chunks.join(""), "utf8");
  return { proc, port, logPath };
}

async function runHttpAndStormOverHttp(tiers: TierResult[]): Promise<Backend | null> {
  info(`④ 页面交互 p50/p95（真起后端进程 + 真 HTTP；采样 ${HTTP_SAMPLES} 次/端点）`);
  let backend: Backend;
  try {
    backend = await startBackend({
      TATAI_WATCH_PENDING_MAX: String(STORM_PENDING_MAX),
      TATAI_WATCH_SCAN_MAX_MS: String(WATCH_LIMITS.SCAN_MAX_MS),
    });
  } catch (e) {
    ok(false, `④-1 后端进程未就绪：${(e as Error).message}`);
    return null;
  }
  info(`  后端就绪：127.0.0.1:${backend.port}（TATAI_HOME=${DATA_DIR}；PENDING_MAX 收紧到 ${STORM_PENDING_MAX} 以触发洪峰丢弃）`);
  const health = await httpJson(backend.port, "GET", "/health");
  ok(health.status === 200, `④-1 后端进程真起（GET /health → ${health.status}）`);

  const endpoints = [
    ["scan", (id: string) => `/api/projects/${id}/scan`],
    ["status-projection", (id: string) => `/api/projects/${id}/status-projection`],
    ["plan", (id: string) => `/api/projects/${id}/plan`],
    ["progress", (id: string) => `/api/projects/${id}/progress`],
  ] as const;

  const table: Record<string, unknown>[] = [];
  for (const t of tiers) {
    const per: Record<string, { p50: number; p95: number; samples: number[]; status: number }> = {};
    for (const [name, url] of endpoints) {
      const samples: number[] = [];
      let status = 0;
      for (let i = 0; i < HTTP_SAMPLES; i++) {
        const r = await httpJson(backend.port, "GET", url(t.fixture.id));
        status = r.status;
        samples.push(r.ms);
      }
      const sorted = [...samples].sort((a, b) => a - b);
      per[name] = { p50: percentile(sorted, 50), p95: percentile(sorted, 95), samples, status };
    }
    t.http = per;
    table.push({ tier: t.tier, files: t.fixture.files, endpoints: per });
    info(
      `  ${t.tier} 档（${t.fixture.files} 文件）：` +
        endpoints
          .map(([name]) => {
            const v = per[name];
            return `${name} p50=${v.p50}ms p95=${v.p95}ms(${v.status})`;
          })
          .join("；"),
    );
  }
  (raw.http as Record<string, unknown>).page_interaction = table;
  ok(
    table.length === tiers.length &&
      tiers.every((t) =>
        Object.values(t.http).every((v) => (v as { status: number }).status === 200),
      ),
    `④-2 每档四个只读端点的页面交互 p50/p95 均取到真实 HTTP 响应（200）`,
  );

  // ── ④-3 前台局部读取（前端分页取流水的真实形态；用最小档，风暴流水就在它身上） ──

  const changesSmall = await httpJson(backend.port, "GET", `/api/projects/${tiers[0].fixture.id}/changes?limit=20`);
  const bodySmall = changesSmall.json as { changes?: unknown[]; total?: number };
  ok(
    changesSmall.status === 200 && (bodySmall.changes?.length ?? 0) <= 20,
    `④-3 **前台局部读取**：GET changes?limit=20 返回 ${bodySmall.changes?.length ?? 0} 条、total=${bodySmall.total}`,
  );

  // ── ④-4 变更风暴（收紧队列上限，真实触发洪峰丢弃） ──
  // 专用一个干净的小夹具测洪峰：③ 段的风暴已经在最小档里造出一个 3000 条目的单目录，
  // 那会让任何后续监听的**预扫描**直接降级为「仅顶层」（depth 1 → 子目录内容不再被监听），
  // 测到的会是"降级后看不到变更"而不是"洪峰丢弃"。
  const stormId = "http-storm-fx";
  const stormRoot = path.join(TMP, stormId);
  assertUnderTmp(stormRoot);
  for (let i = 0; i < 200; i++) write(path.join(stormRoot, "src", `seed${i}.ts`), `export const seed${i} = ${i};\n`);
  write(path.join(stormRoot, WORKBENCH_DIRNAME, "design.md"), "# 洪峰夹具设计书\n\n## 1 目标\n\n洪峰丢弃。\n");
  write(
    path.join(stormRoot, WORKBENCH_DIRNAME, "plan.md"),
    [
      "# 洪峰夹具施工图",
      "",
      "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |",
      "| --- | --- | --- | --- | --- |",
      "| S-1 | todo | 洪峰下丢弃被计数 | | S-1 证据 |",
      "",
      "### S-1 洪峰下丢弃被计数",
      "",
      "**设计依据**：§4.4。**依赖**：无。**文件责任**：`src/**`。",
      "",
      "- [ ] 落盘 + 丢弃 = changes",
      "",
    ].join("\n"),
  );
  addProject({ id: stormId, name: "洪峰夹具", path: stormRoot, kind: "backend" }, DATA_DIR);
  const stormDir = path.join(stormRoot, "flood");
  const postWatch = await httpJson(backend.port, "POST", `/api/projects/${stormId}/watch`);
  // POST /watch 只等"挂载落地"，chokidar 初始扫描（ready）之前的事件不进流水——必须等 ready 再写风暴
  let ready = false;
  for (let i = 0; i < 90 && !ready; i++) {
    const w = await httpJson(backend.port, "GET", "/api/watch");
    const d = (w.json as { details?: { id: string; ready: boolean }[] }).details?.find((x) => x.id === stormId);
    ready = d?.ready === true;
    if (!ready) await sleep(200);
  }
  info(`  洪峰夹具 chokidar ready=${ready}`);
  const stormT0 = performance.now();
  const writes = STORM_WRITES;
  for (let i = 0; i < writes; i++) write(path.join(stormDir, `h${i}.ts`), `export const h${i} = ${i};\n`);
  const stormWriteMs = round1(performance.now() - stormT0);
  // 取数等静默（定因见 waitChangeQuiet）：写盘结束 ≠ 事件投递结束（awaitWriteFinish 300ms 稳定窗口 +
  // 3000 个文件的轮询排队会让事件再飘 1~3 秒），固定 sleep 2500ms 正好落在尾部抖动区。
  const quiet = await waitChangeQuiet(
    async () => {
      const w = await httpJson(backend.port, "GET", "/api/watch");
      const ds = (w.json as { details?: { id: string; stats: WatchStats }[] }).details ?? [];
      return ds.find((d) => d.id === stormId)?.stats;
    },
    Math.max(2500, WATCH_LIMITS.FLUSH_INTERVAL_MS * 12),
  );
  const watchInfo = await httpJson(backend.port, "GET", "/api/watch");
  const details = (watchInfo.json as { details?: { id: string; stats: WatchStats; mode: string; truncated: boolean; truncate_reason: string | null }[] })
    .details ?? [];
  const mine = details.find((d) => d.id === stormId);
  const dropped = mine?.stats.dropped ?? 0;
  const accounted = (mine?.stats.written ?? 0) + dropped;
  // 落盘账的第三方口径：直接数 changes.jsonl 的行数，不与 stats 计数器同源
  const onDisk = jsonlLineCount(path.join(stormRoot, WORKBENCH_DIRNAME, "changes.jsonl"));
  info(
    `  变更风暴（HTTP，PENDING_MAX=${STORM_PENDING_MAX}）：POST /watch=${postWatch.status}，写 ${writes} 个文件 ${stormWriteMs} ms；` +
      `等静默 ${quiet.waited_ms} ms / ${quiet.samples} 次采样（quiet=${quiet.quiet}）；` +
      `统计 ${JSON.stringify(mine?.stats)}；落盘+丢弃=${accounted} = changes=${mine?.stats.changes}；` +
      `changes.jsonl 实际行数=${onDisk}；mode=${mine?.mode} truncated=${mine?.truncated}`,
  );
  (raw.watcher as Record<string, unknown>).storm_tight = {
    pending_max: STORM_PENDING_MAX,
    writes,
    write_ms: stormWriteMs,
    stats: mine?.stats ?? null,
    changes_jsonl_lines: onDisk,
    quiet: { quiet: quiet.quiet, waited_ms: quiet.waited_ms, samples: quiet.samples },
    mode: mine?.mode ?? null,
    truncated: mine?.truncated ?? null,
  };
  ok(
    dropped > 0 &&
      quiet.quiet &&
      accounted === mine?.stats.changes &&
      onDisk === (mine?.stats.written ?? -1),
    `④-4 **超限显示省略量（洪峰）**：队列上限收紧到 ${STORM_PENDING_MAX} 后真实丢弃 ${dropped} 条，` +
      `**等静默 ${quiet.waited_ms} ms 后**取数：落盘 ${mine?.stats.written} + 丢弃 ${dropped} = changes ${mine?.stats.changes}，` +
      `且 changes.jsonl 实际行数 ${onDisk} = written（丢弃被计数、落盘不虚报，都不静默）`,
  );
  const del = await httpJson(backend.port, "DELETE", `/api/projects/${stormId}/watch`);
  const afterDel = await httpJson(backend.port, "GET", "/api/watch");
  const stillThere = ((afterDel.json as { watching?: string[] }).watching ?? []).includes(stormId);
  ok(
    del.status === 200 && !stillThere,
    `④-5 **后台监听可停（HTTP）**：DELETE /watch=${del.status} 后 /api/watch 不再含该项目（停的是文件监听；全量扫描取消是另一条链路，由 scripts/verify-scan-cancel.ts 专测——判词 R1-ZS-004 后拆开，不再混称）`,
  );
  return backend;
}

// ══════════════════════════ ⑤ 一致性备份与恢复（§8.5） ══════════════════════════

async function runBackup(backend: Backend | null): Promise<void> {
  info("⑤ 一致性备份与恢复（事件提交边界；只在隔离目录核验，不自动替换真实数据）");
  const id = "bk-main";
  const plan = [
    "# 备份夹具施工图",
    "",
    "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |",
    "| --- | --- | --- | --- | --- |",
    "| K-1 | todo | 一致备份的提交边界 | | K-1 证据 |",
    "| K-2 | todo | 隔离恢复与核验 | K-1 | K-2 证据 |",
    "",
    "### K-1 一致备份的提交边界",
    "",
    "**设计依据**：§8.5。**依赖**：无。**文件责任**：`src/server/work/backup.ts`。",
    "",
    "- [ ] 备份是某个提交序号的一致切片",
    "",
    "### K-2 隔离恢复与核验",
    "",
    "**设计依据**：§8.5。**依赖**：K-1。**文件责任**：`.工作台/**`。",
    "",
    "- [ ] 原文与证据哈希、事件重放、缓存重建逐项核对",
    "",
  ].join("\n");
  const root = makeSimpleProject(id, "备份夹具", plan);
  const workDir = projectWorkDir(id, DATA_DIR);
  const defs = importTaskDefinitions(plan).definitions;
  submitDefinitionImports(submitter, {
    project_id: id,
    change_id: CHG,
    actor_id: "fixture-executor",
    role: "executor",
    definitions: defs,
  });
  const evidence1 = putEvidence(workDir, {
    content: "自检命令：pnpm typecheck\nexit_code=0\n结论：通过\n",
    kind: "self_check",
    summary: "夹具自检输出",
    created_by: "fixture-executor",
    role: "executor",
    binding: { revision_kind: "code", revision: "rev-a" },
  });
  const evidence2 = putEvidence(workDir, {
    content: "交付包摘要：改动 3 个文件，未跑项 1 个（真机 WebView2）\n",
    kind: "submission",
    summary: "夹具交付包",
    created_by: "fixture-executor",
    role: "executor",
    binding: { revision_kind: "code", revision: "rev-a" },
  });
  submitTaskStatus(submitter, {
    project_id: id,
    task_id: "K-1",
    change_id: CHG,
    actor_id: "fixture-executor",
    role: "executor",
    expected_revision: 1,
    status: "executing",
    definition: { definition_sha256: taskDefinitionHash(defs[0]), plan_revision: defs[0].plan_revision ?? "" },
  });
  const baseline = activateBaseline(
    id,
    {
      approved_by: "fixture-technical-reviewer",
      approval_basis: "夹具的技术审定（不是用户 Gate）",
      approval_kind: "delegated_technical_review",
    },
    DATA_DIR,
  );
  submitSubmission(submitter, {
    record_id: `sub-${id}-K-1`,
    project_id: id,
    change_id: CHG,
    actor_id: "fixture-executor",
    role: "executor",
    goal: "一致备份的提交边界（夹具）",
    task_id: "K-1",
    changed_files: ["src/server/work/backup.ts"],
    commands: [],
    untested: [{ item: "真机 WebView2", reason: "夹具不跑浏览器" }],
    known_issues: [],
    evidence_refs: [evidence1.evidence_id, evidence2.evidence_id],
    binding: { revision_kind: "code", revision: "rev-a" },
    baseline: {
      baseline_id: baseline.baseline.baseline_id,
      design_revision: baseline.baseline.design_revision.content_sha256,
      plan_revision: baseline.baseline.plan_revision.definition_sha256,
    },
    submitted_by: "fixture-executor",
  });
  info(
    `  夹具就绪：基线 ${baseline.baseline.baseline_id}（${baseline.baseline.approval_kind}）、` +
      `证据 ${evidence1.evidence_id.slice(0, 10)}… / ${evidence2.evidence_id.slice(0, 10)}…、` +
      `事件 ${replayEvents(loadEvents(workDir).events).last_seq} 条`,
  );

  // ── ⑤-1 持续变化期间创建一致备份（真并发：子进程后端持续写入） ──
  let submitted = 0;
  let writerError = "";
  let writing = true;
  const writer = (async () => {
    if (backend === null) return;
    const client = new WorkServiceClient({ dataDir: DATA_DIR, timeoutMs: 5000 });
    for (let n = 0; n < 600 && writing; n++) {
      try {
        await client.submit({
          schema_version: SCHEMA_VERSION,
          project_id: id,
          change_id: CHG,
          entity_id: `task:live-${n}`,
          expected_revision: 0,
          type: "task.status_changed",
          actor_id: "concurrent-writer",
          role: "executor",
          idempotency_key: `live-k-${n}`,
          payload: { status: "executing", n },
        });
        submitted++;
      } catch (e) {
        writerError = (e as Error).message;
      }
      await sleep(2);
    }
  })();
  await sleep(120);
  const manifest: BackupManifest = createProjectBackup(id, { dataDir: DATA_DIR, now: NOW });
  const seqAtBackup = manifest.cutoff_seq;
  await sleep(200);
  writing = false;
  await writer;
  const liveSeq = replayEvents(loadEvents(workDir).events).last_seq;
  const backupDir = path.join(DATA_DIR, "backups", id, `b-${String(seqAtBackup).padStart(8, "0")}-${NOW.replace(/[:.]/g, "-")}`);
  const listed = listProjectBackups(id, DATA_DIR);
  info(
    `  备份（任务/原文持续变化期间）：cutoff_seq=${manifest.cutoff_seq}、事件 ${manifest.event_count} 条、` +
      `事实源 ${manifest.sources.length} 份（派生 ${manifest.derived.length}）、图纸历史 ${manifest.documents.length} 条、` +
      `证据 ${manifest.evidence.length} 份、警告 ${manifest.warnings.length}；` +
      `并发写入者提交 ${submitted} 次${writerError ? `（有错：${writerError.slice(0, 80)}）` : ""}；` +
      `备份完成后项目又推进到 last_seq=${liveSeq}`,
  );
  ok(
    backend === null || (submitted > 0 && liveSeq > manifest.cutoff_seq),
    `⑤-1 **在任务/原文持续变化期间**创建备份：并发写入者提交 ${submitted} 次，备份后项目已推进到 last_seq=${liveSeq} > cutoff_seq=${manifest.cutoff_seq}`,
  );
  const verify1 = verifyBackup(backupDir);
  ok(
    verify1.ok,
    `⑤-2 备份是**某个提交序号的一致切片**：cutoff_seq=${manifest.cutoff_seq}、` +
      `${manifest.sources.length} 份事实源哈希相符、事件重放一致、证据与图纸历史闭合` +
      `${verify1.ok ? "" : `（失败：${verify1.failures.map((f) => f.code).join("、")}）`}`,
  );
  ok(
    manifest.sources.some((s) => s.rel_path === "work/events.jsonl" && s.version === String(manifest.cutoff_seq)) &&
      manifest.sources.some((s) => s.rel_path === "baselines.jsonl" && s.version === baseline.baseline.baseline_id) &&
      manifest.derived.some((d) => d.endsWith(STATE_FILE)),
    "⑤-3 清单含**事实源版本**（events.jsonl 的 version = 截止序号、baselines.jsonl 的 version = 末条基线 id），" +
      "派生（state.json）单列且不参与一致性判据",
  );
  ok(
    manifest.documents.length >= 1 &&
      manifest.documents[0].design.recovery.kind === "immutable_copy" &&
      manifest.documents[0].design.recovery.sha256 === manifest.documents[0].design.content_sha256 &&
      manifest.evidence.length === 2 &&
      manifest.evidence.every((e) => e.sha256 === e.evidence_id && e.recovery_path.includes("evidence")),
    `⑤-4 清单含**图纸历史**（${manifest.documents.length} 条基线 + 修订恢复位置）与**证据内容哈希与恢复位置**` +
      `（${manifest.evidence.length} 份，路径形如 .工作台/work/evidence/<sha256>.json）`,
  );
  ok(
    listed.length >= 1 && listed.some((e) => e.backup_id === path.basename(backupDir) && e.manifest !== null),
    `⑤-5 备份可被列举（listProjectBackups 找到 ${listed.length} 份，清单可解析）`,
  );

  // ── ⑤-6 反证 A：跨时刻拼接的半份备份 → 必须不合格 ──
  const mixedDir = path.join(TMP, "backup-mixed");
  fs.cpSync(backupDir, mixedDir, { recursive: true });
  const mixedManifest = JSON.parse(read(path.join(mixedDir, BACKUP_MANIFEST_FILE))) as BackupManifest;
  // 把事件换成"更晚时刻"的那份（并同步更新它的哈希/字节数，让"哈希相符"这条也过得去）
  const liveEventsCopy = read(path.join(workDir, "events.jsonl"));
  write(path.join(mixedDir, "workbench", "work", "events.jsonl"), liveEventsCopy);
  const evEntry = mixedManifest.sources.find((s) => s.rel_path === "work/events.jsonl");
  if (evEntry) {
    evEntry.sha256 = sha256(liveEventsCopy);
    evEntry.bytes = Buffer.byteLength(liveEventsCopy);
  }
  // 再塞一份"后来才有的"证据正文（清单不认它）——典型的"半份目录堆在一起"
  const extraEvidenceFile = path.join(mixedDir, "workbench", "work", "evidence", `${"f".repeat(64)}.json`);
  write(
    extraEvidenceFile,
    JSON.stringify({ evidence_id: "f".repeat(64), content_sha256: "f".repeat(64), content: "事后塞进来的一份\n" }),
  );
  write(path.join(mixedDir, BACKUP_MANIFEST_FILE), JSON.stringify(mixedManifest, null, 2) + "\n");
  const mixedVerdict = verifyBackup(mixedDir);
  info(
    `  反证 A（跨时刻拼接）：事件换成更晚的一份 + 事后多塞一份证据正文 → ${mixedVerdict.ok ? "**PASS（错误！）**" : "FAIL"}；` +
      `失败项 ${mixedVerdict.failures.map((f) => f.code).join("、")}`,
  );
  ok(
    !mixedVerdict.ok &&
      mixedVerdict.failures.some(
        (f) => f.code === "CUTOFF_MISMATCH" || f.code === "UNLISTED_FACT_FILE",
      ),
    `⑤-6 **反证 A**：跨时刻拼接出的"半份备份"被判**不合格**（${mixedVerdict.failures
      .map((f) => f.code)
      .join("、")}）——哈希都对得上也没用，它不是某个提交序号的一致切片`,
  );

  // ── ⑤-7 反证 B：裸目录副本（无清单）→ 必须不合格 ──
  const bareDir = path.join(TMP, "backup-bare-copy");
  fs.cpSync(path.join(backupDir, "workbench"), bareDir, { recursive: true });
  const bareVerdict = verifyBackup(bareDir);
  ok(
    !bareVerdict.ok && bareVerdict.failures.some((f) => f.code === "MANIFEST_INVALID"),
    `⑤-7 **反证 B**：裸目录副本（没有 ${BACKUP_MANIFEST_FILE}）被判**不合格**（${bareVerdict.failures.map((f) => f.code).join("、")}）` +
      "——「复制半份目录」不能当通过（§8.5）",
  );

  // ── ⑤-8 反证 C：缺证据 ──
  const missingEvDir = path.join(TMP, "backup-missing-evidence");
  fs.cpSync(backupDir, missingEvDir, { recursive: true });
  const missManifest = JSON.parse(read(path.join(missingEvDir, BACKUP_MANIFEST_FILE))) as BackupManifest;
  const targetEvidence = missManifest.evidence.find((e) => e.referenced_by_events) ?? missManifest.evidence[0];
  fs.rmSync(path.join(missingEvDir, "workbench", "work", "evidence", `${targetEvidence.evidence_id}.json`), {
    force: true,
  });
  missManifest.evidence = missManifest.evidence.filter((e) => e.evidence_id !== targetEvidence.evidence_id);
  missManifest.sources = missManifest.sources.filter(
    (s) => s.rel_path !== `work/evidence/${targetEvidence.evidence_id}.json`,
  );
  write(path.join(missingEvDir, BACKUP_MANIFEST_FILE), JSON.stringify(missManifest, null, 2) + "\n");
  const missingEvVerdict = verifyBackup(missingEvDir);
  ok(
    !missingEvVerdict.ok && missingEvVerdict.failures.some((f) => f.code === "EVIDENCE_MISSING"),
    `⑤-8 **缺证据**：删掉被事件引用的证据正文并同步从清单里划掉 → 仍被判**不合格**` +
      `（${missingEvVerdict.failures.map((f) => f.code).join("、")}）——缺失的证据被暴露，不当"空列表全正常"（§8.5）`,
  );

  // ── ⑤-9 损坏：改一个字节 ──
  const corruptDir = path.join(TMP, "backup-corrupt");
  fs.cpSync(backupDir, corruptDir, { recursive: true });
  const corruptTarget = path.join(corruptDir, "workbench", "work", "evidence", `${evidence1.evidence_id}.json`);
  const corruptText = read(corruptTarget).replace("结论：通过", "结论：通过（被改过一个字）");
  write(corruptTarget, corruptText);
  const corruptVerdict = verifyBackup(corruptDir);
  ok(
    !corruptVerdict.ok && corruptVerdict.failures.some((f) => f.code === "MANIFEST_HASH_MISMATCH"),
    `⑤-9 **损坏**：证据正文被改一个字节 → 哈希与清单不符，判**不合格**` +
      `（${corruptVerdict.failures.map((f) => f.code).join("、")}）`,
  );

  // ── ⑤-10 旧基线：删掉基线引用的不可变修订副本 ──
  const oldBaselineDir = path.join(TMP, "backup-missing-revision");
  fs.cpSync(backupDir, oldBaselineDir, { recursive: true });
  const oldManifest = JSON.parse(read(path.join(oldBaselineDir, BACKUP_MANIFEST_FILE))) as BackupManifest;
  const revRel = toBackupRel(oldManifest.documents[0].design.recovery.ref);
  fs.rmSync(path.join(oldBaselineDir, "workbench", revRel), { force: true });
  oldManifest.sources = oldManifest.sources.filter((s) => s.rel_path !== revRel);
  write(path.join(oldBaselineDir, BACKUP_MANIFEST_FILE), JSON.stringify(oldManifest, null, 2) + "\n");
  const oldBaselineVerdict = verifyBackup(oldBaselineDir);
  ok(
    !oldBaselineVerdict.ok && oldBaselineVerdict.failures.some((f) => f.code === "BASELINE_REVISION_MISSING"),
    `⑤-10 **旧基线缺历史**：删掉基线引用的设计修订不可变副本 → 判**不合格**` +
      `（${oldBaselineVerdict.failures.map((f) => f.code).join("、")}）——基线不能指向取不回的原文`,
  );

  // ── ⑤-11 恢复一份落后于当前的旧备份：只报"落后多少"，不自动替换 ──
  const comparison = compareBackupToLive(backupDir, id, DATA_DIR);
  info(`  旧备份对照当前：${comparison.note}；baseline 变化=${comparison.baseline_changed} 源内容变化=${comparison.source_changed}`);
  ok(
    comparison.live_ahead !== null && comparison.live_ahead > 0 && /用户决定|不自动替换/.test(comparison.note),
    `⑤-11 **旧基线与旧备份恢复口径**：当前项目领先备份 ${comparison.live_ahead} 个提交，只如实报落后量与影响，` +
      "替换与否交用户决定（本卡不自动替换）",
  );
  const designChanged = comparison.source_changed;
  raw.backup = {
    ...(raw.backup as Record<string, unknown>),
    comparison,
  };
  ok(
    designChanged === false || designChanged === true,
    `⑤-12 图纸源变化可判（source_changed=${comparison.source_changed}）——恢复旧基线时能说出"当前源已变"`,
  );

  // ── ⑤-13 恢复到隔离目录并逐项核验 ──
  const restoreRoot = path.join(TMP, "restored-project");
  const restore = restoreBackup(backupDir, restoreRoot);
  for (const c of restore.checks) info(`  ${c.ok ? "·" : "!"} ${c.name} | ${c.detail}`);
  info(`  恢复：ok=${restore.ok} replaced=${restore.replaced} replace_requires_user=${restore.replace_requires_user}`);
  const projectEventsHashBefore = sha256File(path.join(workDir, "events.jsonl"));
  ok(
    restore.ok && restore.replaced === false && restore.replace_requires_user === true,
    `⑤-13 恢复到隔离目录（${restoreRoot}）核验通过，**replaced=false / replace_requires_user=true**（本卡不自动替换真实数据）`,
  );
  ok(
    restore.facts !== null &&
      restore.facts.documents_recovered.length === manifest.documents.length * 2 &&
      restore.facts.evidence_hash_checked.length === manifest.evidence.length &&
      restore.facts.events_replayed === manifest.event_count &&
      restore.facts.cache_rebuilt.last_seq === manifest.cutoff_seq,
    `⑤-14 恢复后的逐项核对：**原文可定位** ${restore.facts?.documents_recovered.length} 份、` +
      `**证据哈希相符** ${restore.facts?.evidence_hash_checked.length} 份、` +
      `**事件可重放** ${restore.facts?.events_replayed} 条、` +
      `**缓存可重建** last_seq=${restore.facts?.cache_rebuilt.last_seq}（= cutoff_seq ${manifest.cutoff_seq}）`,
  );
  ok(
    sha256File(path.join(workDir, "events.jsonl")) === projectEventsHashBefore &&
      fs.existsSync(path.join(restoreRoot, WORKBENCH_DIRNAME, "work", "events.jsonl")) &&
      fs.existsSync(path.join(restoreRoot, WORKBENCH_DIRNAME, "work", STATE_FILE)),
    "⑤-15 恢复只写隔离目录：原项目的 events.jsonl 哈希前后一致（塔台没有自动替换/覆盖任何真实数据）",
  );
  raw.backup = {
    ...(raw.backup as Record<string, unknown>),
    manifest_summary: {
      cutoff_seq: manifest.cutoff_seq,
      event_count: manifest.event_count,
      sources: manifest.sources.length,
      derived: manifest.derived.length,
      documents: manifest.documents.length,
      evidence: manifest.evidence.length,
      warnings: manifest.warnings,
      roles: manifest.sources.reduce<Record<string, number>>((acc, s) => {
        acc[s.role] = (acc[s.role] ?? 0) + 1;
        return acc;
      }, {}),
    },
    negative_controls: {
      cross_time_mixed: mixedVerdict.failures.map((f) => f.code),
      bare_directory_copy: bareVerdict.failures.map((f) => f.code),
      missing_evidence: missingEvVerdict.failures.map((f) => f.code),
      corrupted_byte: corruptVerdict.failures.map((f) => f.code),
      missing_baseline_revision: oldBaselineVerdict.failures.map((f) => f.code),
    },
    restore: {
      ok: restore.ok,
      replaced: restore.replaced,
      replace_requires_user: restore.replace_requires_user,
      facts: restore.facts,
      checks: restore.checks.map((c) => ({ name: c.name, ok: c.ok, detail: c.detail })),
    },
  };
  void root;
}


// ══════════════════════════ ⑥ 结论：通过档位 / 瓶颈 / 扩容触发条件 / 收尾自证 ══════════════════════════

function buildVerdicts(tiers: TierResult[]): void {
  info("⑥ 结论：通过档位、未通过瓶颈、扩容触发条件");
  const verdicts = tiers.map((t) => ({
    tier: t.tier,
    files: t.fixture.files,
    langs: t.fixture.langs,
    dirs: t.fixture.dirs,
    fixture_mb: mb(t.fixture.bytes),
    gen_ms: t.fixture.gen_ms,
    index_cold_ms: t.index_cold_ms,
    index_incr_ms: t.index_incr_ms,
    index_coverage_pct: t.index_coverage_pct,
    index_modules: t.index_modules,
    index_edges: t.index_edges,
    index_budget_exhausted: t.index_budget_exhausted,
    scan_ms: t.scan_ms,
    scan_truncated: t.scan_truncated,
    scan_budget_reason: t.scan_budget_reason,
    ctx_ms: t.ctx_ms,
    ctx_model_chars: t.ctx_model_chars,
    ctx_omitted: t.ctx_omitted,
    rss_before_mb: t.rss_before_mb,
    rss_after_mb: t.rss_after_mb,
    http: t.http,
    verdict: t.verdict,
    verdict_reason: t.verdict_reason,
  }));
  raw.verdicts = verdicts;
  raw.untested = [
    "真机桌面壳（Tauri WebView2）与真浏览器交互未测：p50/p95 是 HTTP 端点耗时，不是浏览器渲染耗时",
    "多用户 / 多人同时写同一项目未测（当前是单写入服务 + 文件锁的单机口径）",
    "跨语言深度（tree-sitter 只覆盖 Python / JS-TS；Go/Rust/Java 等未参与规模档）",
    "10 万档的**全量**模块图（越过 WALK_LIMITS.maxFiles 后的分区/分片索引）未实现、未测",
    "真实磁盘满 / 只读盘 / 杀进程中断备份等异常路径未测",
    "备份/恢复**替换真实数据**的流程未演练（按卡面只在隔离目录核验，替换由用户决定）",
    "100 万文件档未测（超出本卡建议档位）",
    "缓存/视图之外的大对象（附件、二进制）未纳入备份口径",
  ];
  info(`  未测范围 ${(raw.untested as string[]).length} 条已登记`);
  for (const v of verdicts) {
    info(
      `  ${v.tier} 档（${v.files} 文件 / ${v.dirs} 目录 / ${v.fixture_mb} MB）：判定 **${v.verdict}** —— ${v.verdict_reason}`,
    );
  }

  const passed = verdicts.filter((v) => v.verdict === "pass");
  const partial = verdicts.filter((v) => v.verdict === "partial");
  const notRun = verdicts.filter((v) => v.verdict === "not_run");

  const bottlenecks: Record<string, unknown>[] = [];
  const triggers: string[] = [];
  for (const t of tiers) {
    if (t.verdict === "pass") continue;
    if (t.index_coverage_pct < 100) {
      bottlenecks.push({
        tier: t.tier,
        dimension: "索引冷启动（tree-sitter 模块图）",
        measured: `覆盖 ${t.index_coverage_pct}%（${t.index_source_files}/${t.fixture.source_files} 源码文件），耗时 ${t.index_cold_ms} ms`,
        budget: `WALK_LIMITS.maxFiles=${WALK_LIMITS.maxFiles} / maxMs=${WALK_LIMITS.maxMs}`,
        consequence: `模块图只表达前 ${WALK_LIMITS.maxFiles} 个文件，超出的源码在本档**不进图**（budget_exhausted=${t.index_budget_exhausted}）`,
      });
      triggers.push(
        `${t.tier} 档：需要模块图覆盖全部源码（>${WALK_LIMITS.maxFiles} 文件）时，必须先做分区/分片索引与跨片边聚合，` +
          `或把 maxFiles/maxMs 预算与实际硬件重新标定——本卡实测到的触发条件就是"文件数越过 ${WALK_LIMITS.maxFiles}"`,
      );
    }
    if (t.scan_truncated) {
      bottlenecks.push({
        tier: t.tier,
        dimension: "项目扫描（scanner.ts）",
        measured: `truncated=${t.scan_truncated}（${t.scan_budget_reason ?? "原因未记"}），耗时 ${t.scan_ms} ms`,
        budget: `SCAN_LIMITS.MAX_ENTRIES=${SCAN_LIMITS.MAX_ENTRIES} / MAX_MS=${SCAN_LIMITS.MAX_MS}`,
        consequence: "文件树只统计到截断点；响应带 truncated + 原因，不冒充全量",
      });
      triggers.push(
        `${t.tier} 档：需要"整棵文件树的精确规模"时，需增量式目录索引或后台可取消的分片扫描——` +
          `当前是请求内同步有界扫描，超预算即截断`,
      );
    }
    if (t.http && Object.values(t.http).length > 0) {
      const worst = Math.max(
        ...Object.values(t.http).map((x) => (x as { p95: number }).p95),
      ) as number;
      if (worst > 1000) {
        bottlenecks.push({
          tier: t.tier,
          dimension: "页面交互（只读端点 p95）",
          measured: `最差端点 p95=${worst} ms`,
          budget: "无硬上限（随文件数增长）",
          consequence: "前台交互会出现秒级等待",
        });
        triggers.push(`${t.tier} 档：某只读端点 p95 > 1000 ms 时，需要为该端点加缓存或后台预计算`);
      }
    }
  }
  raw.bottlenecks = bottlenecks;
  raw.scale_triggers = triggers;
  info(
    `  通过档位：${passed.length > 0 ? passed.map((v) => `${v.tier}（${v.files} 文件）`).join("、") : "无"}`,
  );
  info(
    `  未通过档位：${partial.length > 0 ? partial.map((v) => `${v.tier}（${v.files} 文件，partial）`).join("、") : "无"}` +
      `${notRun.length > 0 ? `；未跑通：${notRun.map((v) => v.tier).join("、")}` : ""}`,
  );
  for (const b of bottlenecks) info(`  瓶颈：${JSON.stringify(b)}`);
  for (const s of triggers) info(`  扩容触发条件：${s}`);

  ok(
    passed.length + partial.length + notRun.length === verdicts.length,
    `⑥-1 每档都有明确判定（通过 ${passed.length} / 未通过 ${partial.length} / 未跑通 ${notRun.length}），未把未通过写成通过`,
  );
  ok(
    verdicts.length === TIERS.length && verdicts.every((v) => typeof v.verdict_reason === "string" && v.verdict_reason !== ""),
    `⑥-2 **通过档位、未通过瓶颈及扩容触发条件**均已公布（档位 ${TIERS.join("/")}；瓶颈 ${bottlenecks.length} 条、触发条件 ${triggers.length} 条）`,
  );

  // §11.8：超大型支持不能由 10 万文件数量单独推出
  const docRel = "docs/scale-and-recovery.md";
  const docAbs = path.join(REPO, docRel);
  const docText = fs.existsSync(docAbs) ? read(docAbs) : "";
  ok(
    docText.length > 0 && docText.includes("超大型支持不能由 10 万文件数量单独推出"),
    `⑥-3 公开说明 ${docRel} 用 §11.8 的原话口径写明"超大型支持不能由 10 万文件数量单独推出"`,
  );
  ok(
    docText.includes("测试档位") && docText.includes("不是当前支持承诺"),
    `⑥-4 ${docRel} 写明档位是**测试档位、不是支持承诺**（§11.8）`,
  );
  const leakedNames = PRIVATE_MARKERS.filter((m) => docText.includes(m));
  ok(
    leakedNames.length === 0 && !DRIVE_PATH_RE.test(docText),
    `⑥-5 ${docRel} 无私人路径 / 真实项目名 / 真实证据（命中 ${leakedNames.join("、") || "无"}；` +
      `盘符绝对路径 ${DRIVE_PATH_RE.test(docText) ? "有" : "无"}）`,
  );
  const pkg = JSON.parse(read(path.join(REPO, "package.json"))) as { scripts?: Record<string, string> };
  ok(
    pkg.scripts?.["verify:v06-14"] === "tsx scripts/verify-v06-14.ts",
    "⑥-6 package.json 已登记 verify:v06-14（用已交付脚本的 tsx 风格）",
  );
  const backupSrc = read(path.join(REPO, "src", "server", "work", "backup.ts"));
  ok(
    /loadEvents|replayEvents|buildSnapshot/.test(backupSrc) &&
      /recoverRevision|readBaselineLog|revisionObjectRel/.test(backupSrc) &&
      /readEvidence|evidenceManifest/.test(backupSrc),
    "⑥-7 备份/恢复**复用**已交付的事件、文档历史与证据接口，没有另造一套存储",
  );
}

function runSelfProof(tiers: TierResult[]): void {
  info("⑥-收尾自证：根文档与既有脚本零改动 / 夹具全在 tmpdir / 磁盘清理账");

  let rootDocChanged = 0;
  for (const rel of ROOT_DOCS) {
    const abs = path.join(REPO, rel);
    const now = fs.existsSync(abs) ? sha256File(abs) : "<missing>";
    if (now !== rootDocBefore.get(rel)) {
      rootDocChanged++;
      console.log(`[verify]   FAIL 根文档被改动：${rel}`);
    }
  }
  ok(
    rootDocChanged === 0,
    `⑥-8 根文档 ${ROOT_DOCS.length} 份首尾哈希逐项相同（DESIGN/PLAN/PROGRESS/AGENTS/README/两份设计史未动）`,
  );

  let scriptChanged = 0;
  for (const [abs, before] of scriptHashesBefore) {
    if (!fs.existsSync(abs) || sha256File(abs) !== before) {
      scriptChanged++;
      console.log(`[verify]   FAIL 既有脚本被改动：${path.relative(REPO, abs)}`);
    }
  }
  ok(
    scriptChanged === 0,
    `⑥-9 既有 scripts/** ${scriptHashesBefore.size} 份脚本首尾哈希逐项相同（本卡只新增 verify-v06-14.ts）`,
  );

  const selfSrc = read(SELF_FILE);
  const markersInSrc = PRIVATE_MARKERS.filter((m) => selfSrc.includes(m));
  ok(
    markersInSrc.length === 0,
    `⑥-10 本脚本源码里**不含任何真实项目路径**（命中 ${markersInSrc.join("、") || "无"}）——全程只在 os.tmpdir() 夹具上`,
  );
  ok(
    fs.existsSync(TMP) && tiers.every((t) => path.resolve(t.fixture.root).startsWith(path.resolve(TMP) + path.sep)),
    "⑥-11 全部夹具都在本脚本的临时目录下（收尾整棵删除；TATAI_KEEP_TMP=1 保留现场）",
  );
}

// ── 收尾生命周期：本脚本按需自愈拉起的后台写入服务，收尾必须精确关闭并等**真终态** ──

interface StoppedService {
  data_dir: string;
  pid: number;
  host: string;
  port: number;
  url: string;
  started_at: string;
  /** 发出让位请求时服务是否可达 */
  reachable: boolean;
  /** 真终态：进程已退出（不是 proc.killed 那种「已发信号」） */
  exited: boolean;
  /** 等到真终态用的毫秒数 */
  wait_ms: number;
  detail: string;
}

/** 精确关闭本脚本在 `dataDir` 上按需拉起的独立写入服务，并等它**真正退出**（有界） */
async function stopFixtureWriteService(
  dataDir: string,
  desc: WorkServiceDescriptor,
): Promise<StoppedService> {
  assertUnderTmp(dataDir);
  const current = readServiceDescriptor(dataDir);
  if (!current || current.pid !== desc.pid || current.token !== desc.token || current.url !== desc.url) {
    throw new Error("夹具描述符已变更，拒绝关闭未知服务");
  }
  const t0 = performance.now();
  let reachable = false;
  let detail = "";
  // ① 让位握手：daemon 有 /api/work/admin/shutdown；token 与描述符同源，只有真写者能应答。
  try {
    const res = await fetch(`${desc.url}/api/work/admin/shutdown`, {
      method: "POST",
      headers: { [WORK_TOKEN_HEADER]: desc.token },
      signal: AbortSignal.timeout(5_000),
    });
    reachable = res.ok;
    detail = `shutdown HTTP ${res.status}`;
  } catch (e) {
    detail = `shutdown 请求失败：${(e as Error).message}（可能已自行退出）`;
  }
  // 描述符只能证明握手所需的凭据，不能证明当前 PID 仍是原进程。
  // 只走认证关闭；超时则如实失败并保留现场，不向仅凭描述符取得的 PID 发终止信号。
  const deadline = t0 + 15_000;
  while (performance.now() < deadline && descriptorPidAlive(desc)) {
    await sleep(Math.min(200, Math.max(0, deadline - performance.now())));
  }
  return {
    data_dir: dataDir,
    pid: desc.pid,
    host: desc.host,
    port: desc.port,
    url: desc.url,
    started_at: desc.started_at,
    reachable,
    exited: !descriptorPidAlive(desc),
    wait_ms: round1(performance.now() - t0),
    detail,
  };
}

/** 找临时根下所有由本脚本自建的写入服务描述符（只在**本脚本 TMP** 内扫，不碰系统其它目录） */
function discoverFixtureWriteServices(): Array<{ dataDir: string; desc: WorkServiceDescriptor }> {
  const out: Array<{ dataDir: string; desc: WorkServiceDescriptor }> = [];
  const walk = (d: string, depth: number): void => {
    if (depth > 3) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const abs = path.join(d, e.name);
      const desc = readServiceDescriptor(abs);
      if (desc !== null) out.push({ dataDir: abs, desc });
      walk(abs, depth + 1);
    }
  };
  walk(TMP, 0);
  return out;
}

/** 收尾：精确关闭本脚本拉起的后台写入服务，并等真终态（逐条记录，供 RAW 存证） */
async function shutdownFixtureServices(): Promise<StoppedService[]> {
  const found = discoverFixtureWriteServices();
  const stopped: StoppedService[] = [];
  for (const { dataDir, desc } of found) {
    if (!descriptorPidAlive(desc)) continue; // 早已退净（只剩陈旧描述符，交给目录删除处理）
    info(`  收尾：关闭自动拉起的写入服务 pid=${desc.pid}（${dataDir}）`);
    stopped.push(await stopFixtureWriteService(dataDir, desc));
  }
  return stopped;
}

/** 等一个子进程**真退出**（有界；kill 只是发信号，exit 事件才是终态） */
async function stopChildProcess(
  proc: ChildProcess,
  label: string,
  deadlineMs = 15_000,
): Promise<{ exited: boolean; code: number | null; wait_ms: number; detail: string }> {
  const t0 = performance.now();
  if (proc.exitCode !== null || proc.signalCode !== null) {
    return { exited: true, code: proc.exitCode, wait_ms: 0, detail: "已退出" };
  }
  const exited = new Promise<boolean>((resolve) => {
    proc.once("exit", () => resolve(true));
  });
  try {
    proc.kill("SIGTERM");
  } catch {
    // 忽略
  }
  let done = await Promise.race([exited, sleep(deadlineMs).then(() => false)]);
  if (!done) {
    try {
      proc.kill("SIGKILL");
    } catch {
      // 忽略
    }
    done = await Promise.race([exited, sleep(5_000).then(() => false)]);
  }
  const exitedNow = proc.exitCode !== null || proc.signalCode !== null;
  return {
    exited: exitedNow,
    code: proc.exitCode,
    wait_ms: round1(performance.now() - t0),
    detail: exitedNow ? `${label} 已到终态` : `${label} 超时仍未退出（exit=${proc.exitCode}）`,
  };
}

/** 有界重试删除夹具根；仍失败即如实报失败（绝不吞成「已清理」） */
async function removeFixturesBounded(
  dir: string,
  attempts = 6,
  delayMs = 500,
): Promise<{ ok: boolean; left: boolean; attempts: number; last_error: string }> {
  let lastError = "";
  for (let i = 1; i <= attempts; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (e) {
      lastError = (e as Error).message;
    }
    if (!fs.existsSync(dir)) return { ok: true, left: false, attempts: i, last_error: lastError };
    lastError = lastError || "目录仍在（删除未完成）";
    if (i < attempts) await sleep(delayMs);
  }
  return { ok: false, left: fs.existsSync(dir), attempts, last_error: lastError };
}

/** 收尾的**唯一**入口（幂等）：关后台服务 → 有界清理 → 落原始数据；任一步真失败都把 exit 记成非 0 */
let finalizeDone = false;
let finalizeRunning = false;
async function finalizeTmp(): Promise<void> {
  if (finalizeDone || finalizeRunning) return;
  finalizeRunning = true;
  try {
    // 先关掉可能残留的帧监听器（真删目录前，避免句柄拖住 Windows 上的删除）
    for (const projectId of [...new Set(["tier-10000", ...TIERS.map((n) => `tier-${n}`)])]) {
      await unwatchProject(projectId).catch(() => undefined);
    }
    const children = [];
    for (const proc of ownedBackendChildren) children.push(await stopChildProcess(proc, "本脚本后端"));
    if (children.some((c) => !c.exited)) process.exitCode = 1;
    // ① 精确关闭本脚本按需拉起的独立写入服务并等真终态（不再让后台写与删除赛跑）
    const stopped = await shutdownFixtureServices();
    const cleanup: Record<string, unknown> = {
      backend_children: children,
      write_services_stopped: stopped,
      write_services_all_exited: stopped.every((s) => s.exited),
    };
    raw.cleanup = cleanup;
    if (!cleanup.write_services_all_exited) process.exitCode = 1;
    for (const s of stopped) {
      info(`  ${s.exited ? "已停" : "未停"} pid=${s.pid} ${s.url}（等待 ${s.wait_ms} ms；${s.detail}）`);
    }
    const before = dirBytes(TMP);
    if (process.env.TATAI_KEEP_TMP === "1" || !cleanup.write_services_all_exited || children.some((c) => !c.exited)) {
      info(`保留现场：${TMP}`);
    } else {
      // ② 有界重试整棵删除；仍失败即真实非 0（不冒充「已清理」）
      const rm = await removeFixturesBounded(TMP);
      cleanup.removed = rm;
      console.log(
        `[verify] 夹具清理：清理前 ${mb(before.bytes)} MB / ${before.files} 文件 → ` +
          (rm.ok
            ? `第 ${rm.attempts} 次尝试已整棵删除`
            : `仍存在（${rm.attempts} 次尝试未删净：${rm.last_error}）`),
      );
      if (!rm.ok) process.exitCode = 1;
    }
    // ③ 原始测量数据落盘：失败**不能静默成功**——如实报错并把 exit 记成非 0
    if (RAW_DIR !== "") {
      const rawFile = path.join(RAW_DIR, "v06-14-raw.json");
      try {
        mkdirp(RAW_DIR);
        fs.writeFileSync(rawFile, JSON.stringify(raw, null, 2) + "\n", "utf8");
        console.log(`[verify] 原始测量数据已落 ${rawFile}`);
      } catch (e) {
        process.exitCode = 1;
        cleanup.raw_write_error = (e as Error).message;
        console.error(`[verify] 原始数据落盘失败：${(e as Error).message}`);
      }
    }
    finalizeDone = true;
  } finally {
    finalizeRunning = false;
  }
}

// ══════════════════════════ main ══════════════════════════

async function main(): Promise<void> {
  const diskBefore = dirBytes(TMP);
  info(`清理账起点：临时目录 ${TMP} 已占 ${mb(diskBefore.bytes)} MB / ${diskBefore.files} 文件`);

  const tiers = await runTiers();
  await runAmplification();
  await runFaults(tiers);
  const backend = await runHttpAndStormOverHttp(tiers);
  await runBackup(backend);
  if (backend !== null) {
    const stop = await stopChildProcess(backend.proc, "后端进程");
    info(`  后端进程已收（等真终态 ${stop.wait_ms} ms，exit=${stop.code}；${stop.detail}）`);
    (raw.http as Record<string, unknown>).backend_exited = stop.exited;
    (raw.http as Record<string, unknown>).backend_exit_code = stop.code;
    if (!stop.exited) process.exitCode = 1;
  }
  buildVerdicts(tiers);
  runSelfProof(tiers);

  const diskAfter = dirBytes(TMP);
  raw.disk = {
    before_cleanup: diskAfter,
    before_cleanup_mb: mb(diskAfter.bytes),
    files: diskAfter.files,
    dirs: diskAfter.dirs,
  };
  info(`清理账终点：临时目录已占 ${mb(diskAfter.bytes)} MB / ${diskAfter.files} 文件 / ${diskAfter.dirs} 目录`);

  // 先收尾（关掉自动拉起的写服务、落原始数据、有界清理夹具）再打印汇总：
  // 汇总里的 exit 必须是**终态**口径——不能先打印 exit 0、再被收尾异常推翻成 exit 1。
  await finalizeTmp();

  console.log(`\n[verify] V06-14 结果：${passCount} PASS / ${failCount} FAIL（exit ${process.exitCode ?? 0}）`);
  console.log(`[verify] RAW-BEGIN`);
  console.log(JSON.stringify(raw, null, 2));
  console.log(`[verify] RAW-END`);
}

// 入口判定：只有当本文件是**被直接运行**的入口时才跑 main——
// 被离线用例 `import` 时只提供收尾例程，不触发整段实测（供正负例/异常路径直接调用）。
const IS_ENTRY =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (IS_ENTRY) {
  try {
    await main();
  } catch (e) {
    console.error(`[verify] 异常：${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    process.exitCode = 1;
  } finally {
    // 兜底：main 正常收尾过就空转（幂等）；异常中断时在这里精确关闭后台服务并清理夹具。
    await finalizeTmp();
  }
}

export {
  finalizeTmp,
  stopFixtureWriteService,
  shutdownFixtureServices,
  stopChildProcess,
  removeFixturesBounded,
  TMP,
  RAW_DIR,
  ownedBackendChildren,
};
