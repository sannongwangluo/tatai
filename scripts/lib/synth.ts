// 授权合成夹具（Q6，`TATAI_SYNTH=1`）：verify-onboard / verify-b1 / verify-f3 / verify-n1 / verify-n2
// 五个脚本里依赖真实项目目录 / 真实项目 id 的断言段，没给环境变量时原本只能 SKIP（exit 3，验收面零覆盖）。
// 主人已授权用合成夹具补绿：开启 `TATAI_SYNTH=1` 且对应真实 env 没给时，在**临时目录**
// （os.tmpdir() 下 mkdtemp，不进仓库）现场造最小夹具，让原断言原样跑；
// 给了真实 env → 走真实目录，行为不变；啥都没给且没开 SYNTH → 维持 SKIP。
//
// 红线：
//   · 夹具全部落在临时目录，不写真实注册表、不碰真实数据目录（TATAI_HOME 被合成接管时指向临时 home）；
//   · 合成 git 仓库的 user.name/email 用中性占位（不留真实身份）；
//   · 各脚本的断言（ok() 清单）一行不动，夹具只负责"把断言需要的世界造出来"。
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProjectKind, ProjectRecord } from "../../src/server/registry";

/** SKIP 提示尾巴：维持 SKIP 的段落在原提示后补这句，告知有授权合成这条路 */
export const SYNTH_HINT = "或设 TATAI_SYNTH=1 用授权合成夹具跑";

export function synthEnabled(): boolean {
  return process.env.TATAI_SYNTH === "1";
}

function mkRoot(tag: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `tatai-synth-${tag}-`));
}

function write(root: string, rel: string, content: string): void {
  const abs = path.join(root, ...rel.split("/"));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

/** 往临时 home 写一份注册表（version:1 口径，与 registry.ts 的 validateRegistry 对齐） */
export function writeSynthRegistry(
  home: string,
  projects: { id: string; name: string; path: string; kind: ProjectKind; self_managed?: boolean }[],
): void {
  fs.mkdirSync(home, { recursive: true });
  const now = new Date().toISOString();
  const registry = {
    version: 1,
    projects: projects.map(
      (p): ProjectRecord => ({ registered_at: now, last_opened_at: now, ...p }),
    ),
  };
  fs.writeFileSync(path.join(home, "registry.json"), JSON.stringify(registry, null, 2), "utf8");
}

// ───────────────────────── verify-onboard：纯后端 + 静态站（DoD② detectKind / DoD④ 接入） ─────────────────────────

/** 纯后端：package.json 只带后端框架依赖（express）→ detectKind = backend（onboard.ts FRONTEND/BACKEND 信号） */
export function synthOnboardBackend(): string {
  const dir = path.join(mkRoot("onboard"), "synth-backend");
  write(
    dir,
    "package.json",
    JSON.stringify(
      { name: "synth-backend", version: "0.0.0", dependencies: { express: "^4.18.0" } },
      null,
      2,
    ) + "\n",
  );
  write(dir, "README.md", "# 授权合成纯后端项目\n\nTATAI_SYNTH=1 夹具，供 verify-onboard。\n");
  write(dir, "src/main.ts", "export {};\n");
  return dir;
}

/** 静态站：astro.config.mjs 是 detectKind 的静态站头等信号 → kind = static */
export function synthOnboardStatic(): string {
  const dir = path.join(mkRoot("onboard"), "synth-static");
  write(dir, "astro.config.mjs", "export default {};\n");
  write(
    dir,
    "package.json",
    JSON.stringify({ name: "synth-static", version: "0.0.0" }, null, 2) + "\n",
  );
  write(dir, "README.md", "# 授权合成静态站\n\nTATAI_SYNTH=1 夹具，供 verify-onboard。\n");
  return dir;
}

// ───────────────────────── verify-b1：带 git 历史的真实形状后端项目（DoD① 扫描断言） ─────────────────────────

/**
 * 合成"中型后端项目"：README + docs/ + 源码 + pyproject + **真 git 仓库**（git init + 三个不同日期提交，
 * 提交身份用中性占位）。verify:b1 ① 的断言（文件树/README 摘要/docs 清单/git 活跃度）逐项有真东西可读。
 */
export function synthGitProject(): string {
  const dir = path.join(mkRoot("b1"), "synth-git-backend");
  write(dir, "README.md", "# 授权合成后端项目\n\n第一段：TATAI_SYNTH=1 夹具，供 verify:b1 真扫。\n\n第二段：README 摘要要非空。\n");
  write(dir, "docs/guide.md", "# 使用指南\n\n怎么跑这个合成项目。\n");
  write(dir, "docs/design.md", "# 设计笔记\n\n为什么这么造。\n");
  write(dir, "src/main.py", "def main():\n    pass\n");
  write(dir, "src/util.py", "def helper():\n    return 1\n");
  write(dir, "pyproject.toml", '[project]\nname = "synth-git-backend"\nversion = "0.0.0"\n');
  const identity = {
    GIT_AUTHOR_NAME: "tatai-synth",
    GIT_AUTHOR_EMAIL: "tatai-synth@localhost",
    GIT_COMMITTER_NAME: "tatai-synth",
    GIT_COMMITTER_EMAIL: "tatai-synth@localhost",
  };
  const git = (args: string[], dates?: { at: string }) =>
    execFileSync("git", args, {
      cwd: dir,
      env: {
        ...process.env,
        ...identity,
        ...(dates ? { GIT_AUTHOR_DATE: dates.at, GIT_COMMITTER_DATE: dates.at } : {}),
      },
      stdio: "ignore",
    });
  git(["init", "-q", "-b", "main"]);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "chore: 合成初始提交"], { at: "2026-08-20T10:00:00+08:00" });
  write(dir, "docs/ops.md", "# 运维手册\n\n怎么守这个合成项目。\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "docs: 补运维手册"], { at: "2026-09-05T10:00:00+08:00" });
  write(dir, "src/api.py", "def handle():\n    return 'ok'\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "feat: 加 api 入口"], { at: "2026-09-18T10:00:00+08:00" });
  return dir;
}

// ───────────────────────── verify-f3：可解析的迷你"塔台形状"项目（7 模块 / 互惠对 1 / 双角色边色） ─────────────────────────

/**
 * 造一个 arch/parse 能解出**确定结构**的项目（逐文件手算过 parse.ts 的 buildCandidates）：
 *   顶层候选 src(9) > root(3) > docs(2) > scripts(1) = 4 < MIN_MODULES(5) → 细分 src →
 *   7 模块：src-server / src-ui / src-arch / src-mcp / docs / scripts / root（全部 ≤ MAX_NODES 15）。
 *   边（依赖方向）：src-ui>src-server(2) · src-server>src-ui(1) ← 互惠对 · scripts>src-server(1) ·
 *   src-arch>src-server(1) · src-server>src-mcp(1)；DATA_FLOW 归并翻转后 4 条，源头蓝（src-mcp）与中继紫俱全，
 *   权重 {3,1,1,1} → 粗细两档。展开 src-server → 4 个文件子级（含 src/server/registry.ts）。
 * .工作台/arch/names.json 预置全部 7 个模块的人话名 → verify-f3 ③ 的起名入口不触发（不打真 LLM）。
 */
export function synthArchProject(root: string, dirName: string): string {
  const dir = path.join(root, dirName);
  write(
    dir,
    "package.json",
    JSON.stringify(
      { name: dirName, version: "0.0.0", dependencies: { react: "^19.0.0", "react-dom": "^19.0.0" } },
      null,
      2,
    ) + "\n",
  );
  write(dir, "README.md", `# ${dirName}\n\nTATAI_SYNTH=1 授权合成夹具项目。\n`);
  write(dir, "tsconfig.json", "{}\n");
  write(dir, "docs/readme.md", "# 文档\n");
  write(dir, "docs/arch.md", "# 架构\n");
  write(dir, "scripts/build.ts", 'import "../src/server/registry";\nexport {};\n');
  write(dir, "src/server/registry.ts", 'import { api } from "../ui/api";\nexport const registry = api;\n');
  write(dir, "src/server/http.ts", 'import { tools } from "../mcp/tools";\nexport const http = tools;\n');
  write(dir, "src/server/store.ts", "export const store = 1;\n");
  write(dir, "src/server/util.ts", "export const util = 1;\n");
  write(dir, "src/ui/api.ts", 'import { registry } from "../server/registry";\nexport const api = registry;\n');
  write(dir, "src/ui/view.tsx", 'import { registry } from "../server/registry";\nexport const view = registry;\n');
  write(dir, "src/arch/parse.ts", 'import { registry } from "../server/registry";\nexport const parse = registry;\n');
  write(dir, "src/arch/render.ts", "export const render = 1;\n");
  write(dir, "src/mcp/tools.ts", "export const tools = 1;\n");
  const names: Record<string, string> = {
    "src-server": "服务端核心",
    "src-ui": "界面层",
    "src-arch": "架构解析",
    "src-mcp": "工具协议层",
    docs: "项目文档",
    scripts: "构建脚本",
    root: "根散文件",
  };
  const entries = Object.fromEntries(
    Object.entries(names).map(([id, name]) => [
      id,
      { name, blurb: "授权合成夹具", kind: "code", named_at: "2026-09-19T00:00:00.000Z", signature: "0000000000000000" },
    ]),
  );
  write(dir, ".工作台/arch/names.json", JSON.stringify({ version: 1, entries }, null, 2) + "\n");
  return dir;
}

/**
 * verify-f3 的合成入口（在脚本顶层 env 读取之前调用）：
 * TATAI_HOME 没给 → 造临时 home + 预置 `tatai` 记录（指向合成塔台形状项目，**不写真实注册表**）；
 * TATAI_DIR_EXTRA / TATAI_REAL_IDS 没给 → 补一个同形状的"另一个项目"（R2 接入段会把它登进临时 home）。
 */
export function applySynthF3(): void {
  if (!synthEnabled()) return;
  const root = mkRoot("f3");
  if (!process.env.TATAI_HOME?.trim()) {
    const home = path.join(root, "home");
    const selfDir = synthArchProject(root, "tatai-synth-self");
    writeSynthRegistry(home, [
      { id: "tatai", name: "合成塔台", path: selfDir, kind: "fullstack", self_managed: true },
    ]);
    process.env.TATAI_HOME = home;
  }
  if (!process.env.TATAI_DIR_EXTRA?.trim()) {
    process.env.TATAI_DIR_EXTRA = synthArchProject(root, "synth-extra");
  }
  if (!process.env.TATAI_REAL_IDS?.trim()) {
    process.env.TATAI_REAL_IDS = path.basename(process.env.TATAI_DIR_EXTRA);
  }
  // names.json 已覆盖全部模块 id，起名入口本就不会触发；再删 key 双保险——即使触发也立刻降级，不打真 LLM
  delete process.env.DEEPSEEK_API_KEY;
  console.log(
    `[verify] TATAI_SYNTH=1：f3 合成夹具就绪（TATAI_HOME=${process.env.TATAI_HOME} · EXTRA=${process.env.TATAI_DIR_EXTRA}）`,
  );
}

// ───────────────────────── verify-n1：思维导图取数/下钻形状（手写 A1 产物 + 目录树） ─────────────────────────

/**
 * 合成"导图项目"：目录树与手写 modules.json 逐条对得上（verify-n1 的 markdown 逐行回查两边读同一份，自洽）。
 * 形状约束（n1 断言逐条反推）：
 *   · mod-a 在数组首位且有直属文件 → UI 段"第一枝"；mod-b 带子目录 sub/（内有文件）→ 三级下钻"模块→子目录→文件"；
 *   · mod-e/sub 让路径带 "/"（其父 mod-e 不是模块，不引嵌套层级）；模块互不为路径前缀（导图初始 depth==2）；
 *   · 模块 id ≠ 项目 id；目录段不命中 IGNORED_SEGMENTS；names.json 全中文名（cjk 断言）。
 */
export function synthMindProject(root: string, dirName: string, names: Record<string, string>): string {
  const dir = path.join(root, dirName);
  write(dir, "mod-a/alpha.ts", "export const alpha = 1;\n");
  write(dir, "mod-a/beta.ts", "export const beta = 1;\n");
  write(dir, "mod-b/gamma.ts", "export const gamma = 1;\n");
  write(dir, "mod-b/sub/writer.ts", "export const writer = 1;\n");
  write(dir, "mod-c/c1.js", "module.exports = {};\n");
  write(dir, "mod-d/d1.ts", "export const d1 = 1;\n");
  write(dir, "mod-e/sub/e1.ts", "export const e1 = 1;\n");
  write(dir, "docs/guide.md", "# 指南\n");
  write(dir, "README.md", `# ${dirName}\n`);
  const modules = [
    { id: "mod-a", name: "", path: "mod-a", file_count: 40, loc: 120, deps: [{ to: "mod-b", weight: 3 }] },
    { id: "mod-b", name: "", path: "mod-b", file_count: 30, loc: 90, deps: [] },
    { id: "mod-c", name: "", path: "mod-c", file_count: 20, loc: 60, deps: [] },
    { id: "mod-d", name: "", path: "mod-d", file_count: 12, loc: 30, deps: [] },
    { id: "mod-e-sub", name: "", path: "mod-e/sub", file_count: 8, loc: 20, deps: [] },
    { id: "docs", name: "", path: "docs", file_count: 5, loc: 0, deps: [] },
    { id: "root", name: "", path: ".", file_count: 3, loc: 5, deps: [] },
  ];
  write(
    dir,
    ".工作台/arch/modules.json",
    JSON.stringify({ version: 1, generated_at: "2026-09-19T00:00:00.000Z", modules, budget_exhausted: false }, null, 2) + "\n",
  );
  const entries = Object.fromEntries(
    modules.map((m) => [
      m.id,
      {
        name: names[m.id] ?? m.id,
        blurb: "授权合成夹具",
        kind: "code",
        named_at: "2026-09-19T00:00:00.000Z",
        signature: "0000000000000000",
      },
    ]),
  );
  write(dir, ".工作台/arch/names.json", JSON.stringify({ version: 1, entries }, null, 2) + "\n");
  return dir;
}

/**
 * verify-n1 的合成入口（脚本顶层 env 读取之前调用）：
 * TATAI_HOME 没给 → 临时 home + 两条记录（`tatai` → 合成甲项目、`synth-b` → 合成乙项目）+ TATAI_REAL_IDS=synth-b。
 */
export function applySynthN1(): void {
  if (!synthEnabled()) return;
  const root = mkRoot("n1");
  if (!process.env.TATAI_HOME?.trim()) {
    const home = path.join(root, "home");
    const pa = synthMindProject(root, "synth-proj-a", {
      "mod-a": "甲核心层",
      "mod-b": "乙处理层",
      "mod-c": "丙服务层",
      "mod-d": "丁适配层",
      "mod-e-sub": "戊子树层",
      docs: "项目文档集",
      root: "根散文件组",
    });
    const pb = synthMindProject(root, "synth-proj-b", {
      "mod-a": "一号车间",
      "mod-b": "二号车间",
      "mod-c": "三号车间",
      "mod-d": "四号车间",
      "mod-e-sub": "五号车间",
      docs: "资料档案室",
      root: "门口杂物间",
    });
    writeSynthRegistry(home, [
      { id: "tatai", name: "合成塔台", path: pa, kind: "fullstack", self_managed: true },
      { id: "synth-b", name: "合成乙项目", path: pb, kind: "backend" },
    ]);
    process.env.TATAI_HOME = home;
    if (!process.env.TATAI_REAL_IDS?.trim()) process.env.TATAI_REAL_IDS = "synth-b";
  }
  console.log(`[verify] TATAI_SYNTH=1：n1 合成夹具就绪（TATAI_HOME=${process.env.TATAI_HOME}）`);
}

// ───────────────────────── verify-n2：巨枝截断形状（tatai 小枝对照 + 两个带巨枝的项目） ─────────────────────────

/**
 * n2 的合成"塔台"：`src` 是小枝对照（直接子级 = ui/ + a.ts + b.ts 共 3 条 ≤ 40，含源码文件）且**不是模块**
 * （TATAI_BRANCHES 锚的 `src/ui` 才是模块——若 src 也是模块，导图会多出一层嵌套，depth==2 挂掉）。
 */
function synthN2Tatai(root: string): string {
  const dir = path.join(root, "synth-n2-tatai");
  write(dir, "src/ui/api.ts", "export const api = 1;\n");
  write(dir, "src/ui/view.ts", "export const view = 1;\n");
  write(dir, "src/ui/store.ts", "export const store = 1;\n");
  write(dir, "src/ui/comp.ts", "export const comp = 1;\n");
  write(dir, "src/ui/util.ts", "export const util = 1;\n");
  write(dir, "src/a.ts", "export const a = 1;\n");
  write(dir, "src/b.ts", "export const b = 1;\n");
  write(dir, "docs/guide.md", "# 指南\n");
  write(dir, "scripts/build.ts", "export {};\n");
  write(dir, "tests/smoke.ts", "export {};\n");
  write(dir, "templates/base.md", "# 模板\n");
  write(dir, "package.json", JSON.stringify({ name: "synth-n2-tatai", version: "0.0.0" }, null, 2) + "\n");
  write(dir, "README.md", "# 合成塔台（n2 夹具）\n");
  const modules = [
    { id: "src-ui", name: "", path: "src/ui", file_count: 5, loc: 50, deps: [] },
    { id: "root", name: "", path: ".", file_count: 2, loc: 5, deps: [] },
    { id: "docs", name: "", path: "docs", file_count: 1, loc: 0, deps: [] },
    { id: "scripts", name: "", path: "scripts", file_count: 1, loc: 0, deps: [] },
    { id: "templates", name: "", path: "templates", file_count: 1, loc: 0, deps: [] },
    { id: "tests", name: "", path: "tests", file_count: 1, loc: 0, deps: [] },
  ];
  write(
    dir,
    ".工作台/arch/modules.json",
    JSON.stringify({ version: 1, generated_at: "2026-09-19T00:00:00.000Z", modules, budget_exhausted: false }, null, 2) + "\n",
  );
  const names: Record<string, string> = {
    "src-ui": "界面层",
    docs: "项目文档",
    scripts: "构建脚本",
    templates: "模板库",
    tests: "测试集",
    root: "根散文件",
  };
  const entries = Object.fromEntries(
    modules.map((m) => [
      m.id,
      { name: names[m.id] ?? m.id, blurb: "授权合成夹具", kind: "code", named_at: "2026-09-19T00:00:00.000Z", signature: "0000000000000000" },
    ]),
  );
  write(dir, ".工作台/arch/names.json", JSON.stringify({ version: 1, entries }, null, 2) + "\n");
  return dir;
}

/**
 * 带巨枝的项目：每个 giantDirs 平铺 100 个 **.log**（非源码扩展名）——直接子级 100 > MAX_CHILDREN 40
 * → 截断 61、留 39 + 聚合节点；保留子树里零源码文件 → BIG_BRANCHES[0] 的 skipped_project_walk=true 成立。
 */
function synthN2GiantProject(root: string, dirName: string, giantDirs: string[]): string {
  const dir = path.join(root, dirName);
  for (const g of giantDirs) {
    for (let i = 0; i < 100; i++) {
      write(dir, `${g}/e${String(i).padStart(3, "0")}.log`, `line ${i}\n`);
    }
  }
  write(dir, "app/main.ts", "export const main = 1;\n");
  write(dir, "docs/note.md", "# 笔记\n");
  write(dir, "package.json", JSON.stringify({ name: dirName, version: "0.0.0" }, null, 2) + "\n");
  write(dir, "README.md", `# ${dirName}（n2 夹具）\n`);
  const giantNames: Record<string, string> = { "giant-a": "巨枝甲", "giant-b": "巨枝乙", logs: "日志仓" };
  const modules = [
    ...giantDirs.map((g) => ({ id: g, name: "", path: g, file_count: 100, loc: 0, deps: [] })),
    { id: "app", name: "", path: "app", file_count: 1, loc: 10, deps: [] },
    { id: "docs", name: "", path: "docs", file_count: 1, loc: 0, deps: [] },
    { id: "root", name: "", path: ".", file_count: 2, loc: 0, deps: [] },
  ];
  write(
    dir,
    ".工作台/arch/modules.json",
    JSON.stringify({ version: 1, generated_at: "2026-09-19T00:00:00.000Z", modules, budget_exhausted: false }, null, 2) + "\n",
  );
  const names: Record<string, string> = { ...giantNames, app: "应用层", docs: "项目文档", root: "根散文件" };
  const entries = Object.fromEntries(
    modules.map((m) => [
      m.id,
      { name: names[m.id] ?? m.id, blurb: "授权合成夹具", kind: "code", named_at: "2026-09-19T00:00:00.000Z", signature: "0000000000000000" },
    ]),
  );
  write(dir, ".工作台/arch/names.json", JSON.stringify({ version: 1, entries }, null, 2) + "\n");
  return dir;
}

/**
 * verify-n2 的合成入口（脚本顶层 env 读取之前调用）：
 * TATAI_HOME 没给 → 临时 home + 三条记录（tatai / synth-big / synth-mid），并补齐
 * TATAI_ID_BIG=synth-big · TATAI_BIG_BRANCHES=giant-a,giant-b · TATAI_ID_MID=synth-mid · TATAI_MID_BRANCHES=logs。
 * （真实 env 给了任意一个就走真实口径，合成不越位。）
 */
export function applySynthN2(): void {
  if (!synthEnabled()) return;
  const root = mkRoot("n2");
  if (!process.env.TATAI_HOME?.trim()) {
    const home = path.join(root, "home");
    const tataiDir = synthN2Tatai(root);
    const bigDir = synthN2GiantProject(root, "synth-big", ["giant-a", "giant-b"]);
    const midDir = synthN2GiantProject(root, "synth-mid", ["logs"]);
    writeSynthRegistry(home, [
      { id: "tatai", name: "合成塔台", path: tataiDir, kind: "fullstack", self_managed: true },
      { id: "synth-big", name: "合成压测项目", path: bigDir, kind: "fullstack" },
      { id: "synth-mid", name: "合成中枝项目", path: midDir, kind: "backend" },
    ]);
    process.env.TATAI_HOME = home;
    if (!process.env.TATAI_ID_BIG?.trim()) process.env.TATAI_ID_BIG = "synth-big";
    if (!process.env.TATAI_BIG_BRANCHES?.trim()) process.env.TATAI_BIG_BRANCHES = "giant-a,giant-b";
    if (!process.env.TATAI_ID_MID?.trim()) process.env.TATAI_ID_MID = "synth-mid";
    if (!process.env.TATAI_MID_BRANCHES?.trim()) process.env.TATAI_MID_BRANCHES = "logs";
  }
  console.log(`[verify] TATAI_SYNTH=1：n2 合成夹具就绪（TATAI_HOME=${process.env.TATAI_HOME}）`);
}
