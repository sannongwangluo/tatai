// V09-50 验证（P5 有界解析热路径优化：import 语句收集改 tree-sitter 原生 query；PLAN V09-50、DESIGN §11.8）。
//
// 默认**自包含**：合成夹具 + 手工推导期望 + 嵌套/回退反例 + 真实故障注入，不读任何外部仓库、不扫私有项目、
// 不需要旧实现副本。临时件一律落 os.tmpdir()，不污染被构建源码树（脚本本身只读地 import 本仓库 src）。
//
// 判据：
//   ① 合成夹具（Python/TS/TSX/JS）：真实绑定下必须走原生 query（不是偷偷回退），逐文件 FileImports 与
//      **手工推导期望**一致；parseDirectory 的 modules/stats/budget 语义字段与期望路径一致。
//   ② 红反例（结果层）：确认"只扫顶层语句"的朴素剪枝会漏掉函数体/类体里的 import —— 手工期望的条数
//      严格多于顶层剪枝结果，且新旧结果都不是顶层剪枝结果（证明这个坑真实存在、且本轮没掉进去）。
//   ③ 故障注入回退（子进程隔离，逐种模式）：Query **构造期抛错**、门面**不暴露 Query**、Query
//      **执行期抛错**（captures 抛）、执行成功但**自报被 matchLimit 截断**（部分结果）四种情况下，仍必须
//      **完整回退**旧全树 DFS：不抛错、逐文件 FileImports 与真实 query 路径逐值相同、parseDirectory 语义
//      相同——**不得把旧实现本可成功的文件变成 parse_error，也不得把部分结果当完整结果发布**。
//      （构造失败/缺 Query 属进程级不可恢复，会被负缓存记为 dfs_fallback；执行期失败按次回退、不毒化缓存。）
//   ④ 跳过节流：大文件（>512KiB）按 too_large、遍历后读不到的条目按 unreadable（两态不许混账）。
//
// 用法（绝对 node/tsx，见仓库 docs/development.md）：
//   node <abs tsx cli.mjs> scripts/verify-v09-50.ts
// 可选外部等价 oracle（**都必须显式给**，缺就如实报错、不静默当绿；不默认扫描任何私有目录）：
//   --baseline-module <abs path/to/parse.ts>   冻结旧实现副本（本轮 before 的逐字节副本）
//   --dataset <dir>                            外部数据集副本（如 P5 fixtures/p5-dataset）
//   --extra-root <dir>                         额外只读根（可重复；如大项目源码树）
//   --out <file>                               证据 JSON 落盘路径（默认 os.tmpdir()）
//   --tmp <dir>                                临时目录（默认 os.tmpdir()/p5-v09-50-<pid>）
// 只调 --dataset / --extra-root 而没给 --baseline-module ⇒ **退出码 2**（"缺必需显式输入"，不是跳过）。
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import Module from "node:module";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const HERE = path.dirname(SELF);
const ROOT = path.resolve(HERE, "..");
const TSX_CLI = process.env.P5_TSX_CLI ?? path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");

type Lang = "python" | "typescript" | "tsx" | "javascript";
interface FileImportsLike {
  targets: string[];
  loc: number;
  skip: string | null;
}
interface Subject {
  SOURCE_EXTS: ReadonlyMap<string, Lang>;
  boundedWalk(root: string, limits: { maxFiles: number; maxMs: number }): { files: string[] };
  parseFileImports(
    root: string,
    rel: string,
    lang: Lang,
    sourceSet: ReadonlySet<string>,
    pyImportRoots: readonly string[],
  ): FileImportsLike;
  parseDirectory(root: string): { file: { modules: unknown[]; budget_exhausted?: boolean; version?: string }; stats: unknown; duration_ms?: unknown; parse_ms?: unknown };
  importCollectionMode(): { langs: Record<string, "query" | "dfs_fallback"> };
}

// ══════════════════════════════════════════════════════════════════════════
// 合成夹具（与作者 P5 oracle 同一套真实边界；期望值在下方手工推导，不取自实现）
// ══════════════════════════════════════════════════════════════════════════
const PY_MAIN = `# 中文注释里的 import fake_module 不该算依赖
import os, sys
import json as _json
from . import helper
from .deep import helper as h2
from ..web import nothing_unused

说明 = "from . import helper  # 字符串里的 import 字样不算"


def outer():
    from .util import calc
    import collections

    def inner():
        from .deep.helper import deep_calc
        return deep_calc

    import json
    return inner


class C:
    import re

    def m(self):
        from .util import other
        return other
`;

const TS_INDEX = `import { a } from "./nested";
export { b } from "./nested";
export * from "./side-effect";
import * as all from "../app/util";
import "./legacy";
const x = require("./legacy");

// import { fake } from "./commented-out";
/* export { alsoFake } from "./also-fake"; */
const s = "require('./fake')";
const t = 'import "./fake"';

async function f() {
  const { d } = await import("./nested");
  const name = "./nested";
  await import(name);
  await import(\`./legacy\`);
  return require("../app/util");
}

export const z = 1;
`;

const TSX_COMP = `import React from "react";
import { helper } from "./nested";

export const C = () => (
  <div title={"import './fake.ts'"}>
    {require("./legacy")}
    <span>{"export {x} from './also-fake'"}</span>
  </div>
);
`;

const TS_BROKEN = `import { a } from "./nested
const = = =
function f( {
  import("./legacy")
}
`;

const FIXTURE_FILES: Record<string, string> = {
  "src/app/__init__.py": "from . import util\n",
  "src/app/main.py": PY_MAIN,
  "src/app/helper.py": "import logging\n",
  "src/app/util.py": "import functools\n",
  "src/app/util.ts": "export const u = 1;\n",
  "src/app/deep/__init__.py": "",
  "src/app/deep/helper.py": "from ..util import calc\n",
  "src/web/index.ts": TS_INDEX,
  "src/web/component.tsx": TSX_COMP,
  "src/web/broken.ts": TS_BROKEN,
  "src/web/nested.tsx": "export const n = 1;\n",
  "src/web/legacy.js": "module.exports = {};\n",
  "src/web/side-effect.ts": "export const se = 1;\n",
  "src/web/commented-out.ts": "export const co = 1;\n",
  "src/web/also-fake.ts": "export const af = 1;\n",
  "src/web/fake.ts": "export const fk = 1;\n",
  "src/web/deep/deepest.ts": 'import { u } from "../../app/util";\n',
};

// ── 手工推导期望 ────────────────────────────────────────────────────────────
// main.py（src/app/main.py）逐条 import 语句 → 目标（旧实现既有语义，P5 不改）：
//   `from . import helper`      : relative dots=1、无 dotted ⇒ modPath="src/app" ⇒ __init__.py 命中
//   `from .deep import helper`  : modPath="src/app/deep" ⇒ deep/__init__.py
//   `from ..web import ...`     : modPath="src/web" ⇒ 无 web.py / web/__init__.py ⇒ 无边
//   `from .util import calc`    : 函数体（嵌套）⇒ src/app/util.py
//   `from .deep.helper import …`: 内层函数（更深嵌套）⇒ src/app/deep/helper.py
//   `from .util import other`   : 类方法体（嵌套）⇒ src/app/util.py
//   `import os/sys/json/collections/re` : 非项目内 ⇒ 无边
// 语句的 pre-order 文档序 = 源码顺序 ⇒ 期望 5 条（其中 3 条只在函数体/类体内部）：
const EXPECT_MAIN_PY = [
  "src/app/__init__.py",
  "src/app/deep/__init__.py",
  "src/app/util.py",
  "src/app/deep/helper.py",
  "src/app/util.py",
];
/** "只扫顶层语句"的朴素剪枝：只剩本文件最外两层语句 ⇒ 只有前 2 条（这就是要证伪的坑） */
const EXPECT_MAIN_PY_TOPLEVEL_ONLY = ["src/app/__init__.py", "src/app/deep/__init__.py"];
// index.ts（src/web/index.ts）：import/export/re-export/静态 import/require + 函数体 await import/require
//   注释与字符串里的 "import"/"require" 字样不算；await import(name)/模板串不算（specifier 非 string）
const EXPECT_INDEX_TS = [
  "src/web/nested.tsx",
  "src/web/nested.tsx",
  "src/web/side-effect.ts",
  "src/app/util.ts",
  "src/web/legacy.js",
  "src/web/legacy.js",
  "src/web/nested.tsx",
  "src/app/util.ts",
];
const EXPECT_COMP_TSX = ["src/web/nested.tsx", "src/web/legacy.js"];

// ══════════════════════════════════════════════════════════════════════════
// 子进程：注入门面故障 → 跑夹具 → 输出 JSON
// ══════════════════════════════════════════════════════════════════════════
async function runChild(): Promise<void> {
  const mode = process.env.P5_V09_50_MODE ?? "ok";
  const subjectPath = process.env.P5_V09_50_SUBJECT ?? path.join(ROOT, "src", "arch", "parse.ts");
  const fixture = process.env.P5_V09_50_FIXTURE ?? path.join(os.tmpdir(), "p5-v09-50-fixture");
  installQueryShim(mode, subjectPath);
  const subject = (await import(pathToFileURL(subjectPath).href)) as unknown as Subject;

  const walked = subject.boundedWalk(fixture, { maxFiles: 1_000_000, maxMs: 60_000 }).files;
  const sourceFiles = walked.filter((f) => subject.SOURCE_EXTS.has(path.posix.extname(f).toLowerCase()));
  const sourceSet = new Set(sourceFiles);
  const pyImportRoots: string[] = [""];
  if (sourceFiles.some((f) => f.startsWith("src/") && f.endsWith(".py"))) pyImportRoots.push("src");

  const out: Record<string, unknown> = { mode, subject: subjectPath, mode_before: subject.importCollectionMode().langs };
  const perFile: Record<string, unknown> = {};
  const skipped: Record<string, string[]> = {};
  const threw: { rel: string; error: string }[] = [];
  for (const rel of sourceFiles) {
    const lang = subject.SOURCE_EXTS.get(path.posix.extname(rel).toLowerCase())!;
    try {
      const r = subject.parseFileImports(fixture, rel, lang, sourceSet, pyImportRoots);
      perFile[rel] = r;
      if (r.skip) (skipped[r.skip] ??= []).push(rel);
    } catch (e) {
      threw.push({ rel, error: `${(e as Error).name}: ${(e as Error).message}` });
    }
  }
  out.per_file = perFile;
  out.skip = skipped;
  out.threw = threw;

  // 读不动：遍历后文件被删（与"跳过大文件"必须分开记账）
  const ur = path.join(fixture, "unreadable");
  fs.rmSync(ur, { recursive: true, force: true });
  fs.mkdirSync(ur, { recursive: true });
  fs.writeFileSync(path.join(ur, "gone.ts"), 'import "./x";\n', "utf8");
  const urWalk = subject.boundedWalk(ur, { maxFiles: 100, maxMs: 5_000 }).files;
  fs.rmSync(path.join(ur, "gone.ts"), { force: true });
  try {
    out.unreadable = subject.parseFileImports(ur, urWalk[0], "typescript", new Set(urWalk), [""]);
  } catch (e) {
    out.unreadable = { threw: `${(e as Error).name}: ${(e as Error).message}` };
  }

  // parseDirectory 语义投影（排除 generated_at/duration_ms/parse_ms 三个非语义/计时字段）
  try {
    const r = subject.parseDirectory(fixture);
    out.dir = {
      modules: r.file.modules,
      budget_exhausted: r.file.budget_exhausted ?? null,
      version: r.file.version ?? null,
      stats: r.stats,
      duration_ms: typeof r.duration_ms,
      parse_ms: typeof r.parse_ms,
    };
  } catch (e) {
    out.dir = { threw: `${(e as Error).name}: ${(e as Error).message}` };
  }
  out.mode_after = subject.importCollectionMode().langs;
  process.stdout.write(`\n@@P5-V09-50-JSON@@${JSON.stringify(out)}\n`);
}

/** 只替换原生门面里的 `Query`：Parser / grammar 全部仍是真实绑定，故障只发生在 query 这一层。
 *  tree-sitter 按**被测模块自身**的解析路径取（与它运行时 loadNative 的 createRequire 同源），
 *  这样脚本放哪都不改被测实现真正加载的那个原生包。 */
function installQueryShim(mode: string, subjectPath: string): void {
  const req = createRequire(subjectPath);
  const real = req("tree-sitter") as { Query: new (...args: unknown[]) => { captures(...a: unknown[]): unknown[] } };
  const RealQuery = real.Query;
  class ThrowingCapturesQuery extends RealQuery {
    captures(): never {
      throw new Error("p5-v09-50 fixture: query.captures() failed at execution time");
    }
  }
  // 执行成功但**只给一条捕获**，且**自报被 matchLimit 截断**：模拟"原生游标有界截断=部分结果"的真实机制
  class TruncatingReportedQuery extends RealQuery {
    captures(...args: unknown[]): unknown[] {
      return super.captures(...args).slice(0, 1);
    }
    didExceedMatchLimit(): boolean {
      return true;
    }
  }
  class ThrowingConstructQuery {
    constructor() {
      throw new Error("p5-v09-50 fixture: query construction failed");
    }
  }
  const queryFor = (): unknown => {
    switch (mode) {
      case "throw_construct":
        return ThrowingConstructQuery;
      case "no_query":
        return undefined;
      case "ok":
        return RealQuery;
      case "truncate_reported":
        return TruncatingReportedQuery;
      case "throw_captures":
      default:
        return ThrowingCapturesQuery;
    }
  };
  const shim = new Proxy(real, {
    get(t, p, r) {
      if (p === "Query") return queryFor();
      return Reflect.get(t, p, r);
    },
    has(t, p) {
      if (p === "Query") return queryFor() !== undefined;
      return Reflect.has(t, p);
    },
  });
  const M = Module as unknown as { _load: (this: unknown, request: string, parent: unknown, isMain: boolean) => unknown };
  const orig = M._load;
  M._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
    if (request === "tree-sitter") return shim;
    return orig.call(this, request, parent, isMain);
  };
}

// ══════════════════════════════════════════════════════════════════════════
// 父进程：建夹具 → 跑各模式 → 断言 → （可选）外部 oracle 等价
// ══════════════════════════════════════════════════════════════════════════
async function runParent(): Promise<void> {
  const argv = process.argv.slice(2);
  const arg = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    const a = argv.find((x) => x === `--${name}` || x.startsWith(`--${name}=`));
    if (!a) return undefined;
    return a.includes("=") ? a.slice(a.indexOf("=") + 1) : argv[i + 1];
  };
  const argAll = (name: string): string[] => {
    const out: string[] = [];
    argv.forEach((a, i) => {
      if (a === `--${name}`) out.push(argv[i + 1]);
      else if (a.startsWith(`--${name}=`)) out.push(a.slice(`--${name}=`.length));
    });
    return out;
  };

  const SUBJECT = process.env.P5_V09_50_SUBJECT ?? path.join(ROOT, "src", "arch", "parse.ts");
  const TMPROOT = path.resolve(arg("tmp") ?? path.join(os.tmpdir(), `p5-v09-50-${process.pid}`));
  const DATASET = arg("dataset");
  const EXTRA_ROOTS = argAll("extra-root");
  const BASELINE_MODULE = arg("baseline-module");
  const OUT = path.resolve(arg("out") ?? path.join(TMPROOT, "verify-v09-50.json"));
  const FIXTURE = path.join(TMPROOT, "fixture");

  // 缺必需显式输入 ⇒ 如实报错，不当"跳过"、不当"全绿"
  if ((DATASET || EXTRA_ROOTS.length > 0) && !BASELINE_MODULE) {
    console.error("[v09-50] 用法错误：给了 --dataset/--extra-root 就必须同时给 --baseline-module（冻结旧实现副本）；" +
      "缺基线就无法做等价比对——这里如实报错退出，不静默跳过检查。");
    process.exit(2);
  }
  if (BASELINE_MODULE && !fs.existsSync(BASELINE_MODULE)) {
    console.error(`[v09-50] 用法错误：--baseline-module 不存在：${BASELINE_MODULE}`);
    process.exit(2);
  }

  const FAILED: string[] = [];
  const ok = (cond: boolean, label: string): void => {
    console.log(`[v09-50] ${cond ? "PASS" : "FAIL"} ${label}`);
    if (!cond) {
      FAILED.push(label);
      process.exitCode = 1;
    }
  };
  const j = (v: unknown): string => JSON.stringify(v);

  // 1) 夹具
  fs.rmSync(TMPROOT, { recursive: true, force: true });
  for (const [rel, text] of Object.entries(FIXTURE_FILES)) {
    const abs = path.join(FIXTURE, ...rel.split("/"));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text, "utf8");
  }
  fs.writeFileSync(path.join(FIXTURE, "src/web/bigdata.py"), Buffer.alloc(600 * 1024, "x").toString("utf8") + "\nimport os\n");

  const report: Record<string, unknown> = {
    kind: "verify_v09_50_parse_collect",
    at: new Date().toISOString(),
    subject: SUBJECT,
    self_contained: !BASELINE_MODULE,
  };

  // 2) 逐模式子进程（每模式独立进程：模块级 query 缓存/坏态互不串味）
  const modes = ["ok", "throw_captures", "throw_construct", "no_query", "truncate_reported"];
  const results: Record<string, any> = {};
  for (const mode of modes) {
    const res = spawnSync(process.execPath, [TSX_CLI, SELF], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 128 * 1024 * 1024,
      env: {
        ...process.env,
        TEMP: TMPROOT,
        TMP: TMPROOT,
        P5_V09_50_CHILD: "1",
        P5_V09_50_MODE: mode,
        P5_V09_50_SUBJECT: SUBJECT,
        P5_V09_50_FIXTURE: FIXTURE,
      },
    });
    const marker = "@@P5-V09-50-JSON@@";
    const line = (res.stdout ?? "").split(/\r?\n/).find((l) => l.startsWith(marker));
    if (!line) {
      console.error(`[v09-50] 子进程模式 ${mode} 未产出结果（exit=${res.status}）\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
      process.exit(3);
    }
    results[mode] = JSON.parse(line.slice(marker.length));
  }
  report.modes = results;

  const okRun = results.ok;
  // 3) 真实绑定下必须走 query（不是偷偷回退）
  ok(
    ["python", "typescript", "tsx", "javascript"].every((l) => okRun.mode_before[l] === "query"),
    `真实绑定下 import 收集走原生 query（${j(okRun.mode_before)}）`,
  );
  ok(okRun.threw.length === 0, `真实绑定：${Object.keys(okRun.per_file).length} 个源文件解析零抛错（抛错 ${okRun.threw.length}）`);

  // 4) 手工期望
  const pf = okRun.per_file as Record<string, FileImportsLike>;
  ok(j(pf["src/app/main.py"]?.targets) === j(EXPECT_MAIN_PY), `手工期望：main.py targets 逐条一致（${j(pf["src/app/main.py"]?.targets)}）`);
  ok(j(pf["src/web/index.ts"]?.targets) === j(EXPECT_INDEX_TS), `手工期望：index.ts targets 逐条一致（${j(pf["src/web/index.ts"]?.targets)}）`);
  ok(j(pf["src/web/component.tsx"]?.targets) === j(EXPECT_COMP_TSX), `手工期望：component.tsx targets 逐条一致（${j(pf["src/web/component.tsx"]?.targets)}）`);

  // 5) 红反例（结果层）：嵌套 import 真的会多出边，顶层剪枝拿不到
  const nestedOnly = EXPECT_MAIN_PY.length - EXPECT_MAIN_PY_TOPLEVEL_ONLY.length;
  ok(
    j(pf["src/app/main.py"]?.targets) !== j(EXPECT_MAIN_PY_TOPLEVEL_ONLY) && nestedOnly === 3,
    `红反例（结果层）：main.py 的 ${EXPECT_MAIN_PY.length} 条边里有 ${nestedOnly} 条只在函数体/类体内部，顶层剪枝会少（顶层剪枝=${j(EXPECT_MAIN_PY_TOPLEVEL_ONLY)}）`,
  );

  // 6) 故障注入：Query 构造失败 / 不可用 / 执行期抛错 / 自报截断，都必须完整回退、逐值等于真实 query 路径
  const faultModes = ["throw_captures", "throw_construct", "no_query", "truncate_reported"];
  // 构造失败/门面缺 Query 的语言会被负缓存记为 dfs_fallback（进程级不可恢复）；执行期失败按次回退、不毒化缓存
  const constructionFailed = new Set(["throw_construct", "no_query"]);
  for (const mode of faultModes) {
    const r = results[mode];
    ok(r.threw.length === 0, `${mode}：不抛错（抛出 ${r.threw.length} 个文件；${j(r.threw.slice(0, 2))}）`);
    const diffs = Object.keys(pf).filter((rel) => j(pf[rel]) !== j(r.per_file[rel]));
    ok(diffs.length === 0, `${mode}：逐文件 FileImports 与真实 query 路径相同（差异 ${diffs.length}）`);
    ok(j(r.dir) === j(okRun.dir), `${mode}：parseDirectory modules/stats/budget 语义与真实 query 路径相同`);
    if (constructionFailed.has(mode)) {
      const langStates = Object.values(r.mode_after as Record<string, string>);
      ok(langStates.every((s) => s === "dfs_fallback"), `${mode}：自报确实走了完整 DFS 回退、没把回退冒充 query（${j(r.mode_after)}）`);
    } else {
      // 构造仍可用 ⇒ 自报仍是 query（执行期失败按次回退、不把语言永久判死）；回退证据由"不抛错且逐值相等"给出
      const langStates = Object.values(r.mode_after as Record<string, string>);
      ok(langStates.every((s) => s === "query"), `${mode}：执行期故障不毒化缓存、后续仍可用 query（自报 ${j(r.mode_after)}）`);
    }
  }

  // 7) 跳过节流：大文件与读不动分账
  ok(j(okRun.skip.too_large) === j(["src/web/bigdata.py"]), `大文件按 too_large 跳过（${j(okRun.skip.too_large)}）`);
  ok(okRun.unreadable?.skip === "unreadable", `遍历后读不到按 unreadable 记（${j(okRun.unreadable)}）`);
  for (const mode of faultModes) {
    ok(j(results[mode].unreadable) === j(okRun.unreadable), `${mode}：读不动一态与真实绑定一致`);
  }

  // 8) 可选外部等价 oracle（冻结旧实现 vs 当前实现；显式给输入才跑）
  if (BASELINE_MODULE) {
    const baseline = (await import(pathToFileURL(BASELINE_MODULE).href)) as unknown as Subject;
    const subject = (await import(pathToFileURL(SUBJECT).href)) as unknown as Subject;
    const roots: [string, string][] = [];
    if (DATASET) roots.push(["dataset", path.resolve(DATASET)]);
    EXTRA_ROOTS.forEach((r, i) => roots.push([`extra_${i}`, path.resolve(r)]));
    const external: Record<string, unknown> = {};
    for (const [label, root] of roots) {
      if (!fs.existsSync(root)) {
        console.error(`[v09-50] 外部根不存在（显式输入有误，如实报错）：${label} = ${root}`);
        process.exit(2);
      }
      const walked = subject.boundedWalk(root, { maxFiles: Number.POSITIVE_INFINITY, maxMs: Number.POSITIVE_INFINITY }).files;
      const srcFiles = walked.filter((f) => subject.SOURCE_EXTS.has(path.posix.extname(f).toLowerCase()));
      const srcSet = new Set(srcFiles);
      const pyRoots: string[] = [""];
      if (srcFiles.some((f) => f.startsWith("src/") && f.endsWith(".py"))) pyRoots.push("src");
      const diffs: { rel: string; base: unknown; subject: unknown }[] = [];
      let targets = 0;
      for (const rel of srcFiles) {
        const lang = subject.SOURCE_EXTS.get(path.posix.extname(rel).toLowerCase())!;
        const a = baseline.parseFileImports(root, rel, lang, srcSet, pyRoots);
        const b = subject.parseFileImports(root, rel, lang, srcSet, pyRoots);
        targets += a.targets.length;
        if (j(a) !== j(b)) diffs.push({ rel, base: a, subject: b });
      }
      // parseDirectory 的语义字段（parseDirectory 本身不写盘：写口是 writeModulesStable，见 parse.ts）
      const da = semanticDir(baseline.parseDirectory(root));
      const db = semanticDir(subject.parseDirectory(root));
      external[label] = { root, source_files: srcFiles.length, targets_total: targets, file_diffs: diffs.length, file_diff_sample: diffs.slice(0, 3), dir_equal: j(da) === j(db) };
      ok(diffs.length === 0, `${label}:${path.basename(root)}：冻结旧实现 vs 当前实现逐文件 FileImports 相同（${srcFiles.length} 源 / 差异 ${diffs.length}）`);
      ok(j(da) === j(db), `${label}:${path.basename(root)}：parseDirectory modules/stats/budget 语义相同`);
    }
    report.external = external;
  }

  report.failed = FAILED;
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(report, null, 1));
  console.log(`[v09-50] 证据 → ${OUT}`);
  console.log(`[v09-50] ${FAILED.length === 0 ? "ALL PASS" : `FAILED: ${j(FAILED)}`}`);
}

function semanticDir(r: { file: { modules: unknown[]; budget_exhausted?: boolean; version?: string }; stats: unknown; duration_ms?: unknown; parse_ms?: unknown }): unknown {
  return {
    modules: r.file.modules,
    budget_exhausted: r.file.budget_exhausted ?? null,
    version: r.file.version ?? null,
    stats: r.stats,
    duration_ms: typeof r.duration_ms,
    parse_ms: typeof r.parse_ms,
  };
}

// ── 入口（放文件末尾：上面的常量/类型必须先初始化，故不能提到顶部）───────────────────────────
if (process.env.P5_V09_50_CHILD === "1") {
  await runChild();
} else {
  await runParent();
}
