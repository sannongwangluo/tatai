// V06-02 验证脚本（PLAN.md V06-02，DESIGN.md §2.6 / §2.9 / §3.5）：两份图纸的版本与审定。
// 用法：pnpm verify:v06-02（或 node --import tsx scripts/verify-v06-02.ts）
//
// 自带隔离环境：临时 TATAI_HOME + 临时项目目录（os.tmpdir() 下），**不碰**三个真实项目的 `.工作台/`；
// 塔台自身的 repo 根 DESIGN.md / PLAN.md 只**读**（源解析夹具），全程不改一个字节（脚本首尾哈希对照）；
// 收尾清理自己创建的临时目录（TATAI_KEEP_TMP=1 可保留现场）。
//
// 覆盖点（PLAN V06-02 检查项 1–3 逐条）：
//   ① 唯一当前源：塔台根文档 / 普通项目私有文档 / 已登记其他相对路径三种夹具；
//      拒绝路径穿越（`../`）、绝对路径、软链（联接点）逃逸，且错误说清是哪一种。
//   ② 读原文 + 章节差异 + 不可变历史 + 双版本激活；重复 id / 悬空依赖 / 循环依赖 / 缺验收内容拒绝激活；
//      源变化使旧草稿比较失效（VERSION_CONFLICT）；任一份缺失不能激活；旧有效基线保留到新基线成功为止。
//   ③ 无 Git 提交的图纸仍能按哈希恢复、历史不可改（不回写 + 改动被检出）、技术审定不写用户 Gate、
//      并发改稿不覆盖（真两个进程）、§3.5 现有 read_design 兼容读回不退化；四条新路由登记进 remote-routes.ts。
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setProjectDocumentPaths } from "../src/server/registry";
import { designPath, readDesign } from "../src/server/workstation";
import { WorkError } from "../src/server/work/types";
import {
  activateBaseline,
  activeBaseline,
  baselinesPath,
  diffRevisionsByHash,
  loadDocument,
  preserveDocumentRevision,
  recoverRevision,
  resolveDocumentSource,
  revisionObjectRel,
  sha256Hex,
} from "../src/server/work/documents";
import { parsePlanTable, validatePlanTasks } from "../src/server/work/planValidate";

const PORT = 8802;
const REPO = process.cwd();
const REPO_DESIGN = path.join(REPO, "DESIGN.md");
const REPO_PLAN = path.join(REPO, "PLAN.md");

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
const info = (msg: string) => console.log(`[verify] ${msg}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 取一次调用抛出的 WorkError（返回 null = 没抛，或抛的不是 WorkError） */
function workError(fn: () => unknown): WorkError | null {
  try {
    fn();
    return null;
  } catch (e) {
    if (e instanceof WorkError) return e;
    console.log(`[verify]   （非 WorkError 抛出：${(e as Error).message}）`);
    return null;
  }
}
const reasonOf = (e: WorkError | null): unknown => e?.detail?.reason;
const issuesOf = (e: WorkError | null): { problem: string; ids: string[] }[] =>
  (e?.detail?.issues as { problem: string; ids: string[] }[] | undefined) ?? [];

// ── 隔离环境 ──
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-v0602-verify-"));
const dataDir = path.join(tmpBase, "home");
const outsideDir = path.join(tmpBase, "outside");
const plainRoot = path.join(tmpBase, "plain");
const regRoot = path.join(tmpBase, "reg");
const escRoot = path.join(tmpBase, "esc");
const selfRoot = path.join(tmpBase, "self");
const userRoot = path.join(tmpBase, "userok");
const workbench = (root: string) => path.join(root, ".工作台");
const mkdirp = (dir: string) => fs.mkdirSync(dir, { recursive: true });
const write = (file: string, text: string) => {
  mkdirp(path.dirname(file));
  fs.writeFileSync(file, text, "utf8");
};
const read = (file: string) => fs.readFileSync(file, "utf8");

for (const dir of [dataDir, outsideDir, plainRoot, regRoot, escRoot, selfRoot, userRoot]) mkdirp(dir);
mkdirp(workbench(plainRoot));
mkdirp(workbench(regRoot));
mkdirp(workbench(escRoot));

const record = (id: string, name: string, dir: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  path: dir,
  kind: "backend",
  registered_at: "2026-09-20T00:00:00+08:00",
  last_opened_at: "2026-09-20T00:00:00+08:00",
  ...extra,
});
const TATAI_RECORD = record("tatai", "塔台（repo 根夹具，只读）", REPO, { self_managed: true });
const OTHER_RECORDS = [
  record("plain", "普通项目", plainRoot),
  record("reg", "登记了其他相对路径的项目", regRoot),
  record("esc", "软链逃逸夹具", escRoot),
  record("self", "临时自举项目", selfRoot, { self_managed: true }),
  record("userok", "用户确认夹具", userRoot),
];
const writeRegistry = (records: unknown[]) =>
  write(path.join(dataDir, "registry.json"), JSON.stringify({ version: 1, projects: records }, null, 2));
writeRegistry([TATAI_RECORD, ...OTHER_RECORDS]);

// ── 图纸夹具 ──

const DESIGN_V1 = [
  "# 普通项目设计书",
  "",
  "## 1 概述",
  "目标：验证唯一当前源。",
  "",
  "## 2 方案",
  "方案 A：走 `.工作台/design.md`。",
  "",
  "## 3 废弃章节",
  "这一节在下一版里会被删掉。",
  "",
].join("\n");

const DESIGN_V2 = [
  "# 普通项目设计书",
  "",
  "## 1 概述",
  "目标：验证唯一当前源。",
  "",
  "## 2 方案",
  "方案 B：改稿后仍然只认这一份当前源。",
  "",
  "## 4 新增章节",
  "并发改稿不得被旧草稿覆盖。",
  "",
].join("\n");

/** 施工图夹具：先放一张**历史表**（表头不含「依赖」），再放真正的施工卡表 */
const planDoc = (rows: string[]): string =>
  [
    "# 普通项目施工图",
    "",
    "## v1 当前施工入口",
    "",
    "一些说明文字（不是表格）。",
    "",
    "## 历史审计项（旧表，表头不含「依赖」，不该被当成施工定义）",
    "",
    "| 原登记 | v0.6 去向 / 责任卡 | 启动与验收口径 |",
    "| --- | --- | --- |",
    "| Q25 | 随 V06-06 复核 | 历史表不该被吃进任务定义 |",
    "| Q71、Q213 | 随 V06-01 复核 | 同上 |",
    "",
    "## 当前任务",
    "",
    "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");

const VALID_ROWS = [
  "| T-1 | todo | 打地基 |  | `pnpm test` 通过 |",
  "| T-2 | todo | 砌墙 | T-1 | 验收清单勾完 |",
  "| T-3 | todo | 上梁 | T-1、T-2 | 现场照片 |",
  "| T-4 | todo | 收尾 | T-1、T-2,T-3/T-2 T-1 | 交付包归档 |",
];
const PLAN_V1 = planDoc(VALID_ROWS);
const PLAN_TABLE_LINE = 16; // 历史卡数（V06 时代），不动

write(path.join(workbench(plainRoot), "design.md"), DESIGN_V1);
write(path.join(workbench(plainRoot), "plan.md"), PLAN_V1);

// reg 项目：登记 docs/ 下的相对路径；另放一份 .工作台/design.md 作"诱饵"——
// 「唯一当前源」意味着登记生效后**不读**缺省那份（不合并、不自动复制成两份现行稿）。
write(path.join(regRoot, "docs", "design.md"), "# 登记路径设计书\n\n## 1 只有这份是当前源\n");
write(path.join(regRoot, "docs", "plan.md"), planDoc(VALID_ROWS));
write(path.join(workbench(regRoot), "design.md"), "# 诱饵设计书（缺省路径，登记生效后不该被读）\n");

// esc 项目：项目根内一个联接点指向项目根外
const escapeLink = path.join(escRoot, "escape");
write(path.join(outsideDir, "plan.md"), "# 项目根外的施工图\n");
write(path.join(workbench(escRoot), "design.md"), "# esc 设计书\n");
let symlinkKind = "";
try {
  fs.symlinkSync(outsideDir, escapeLink, "junction");
  symlinkKind = "junction";
} catch {
  try {
    fs.symlinkSync(outsideDir, escapeLink, "dir");
    symlinkKind = "dir-symlink";
  } catch (e) {
    symlinkKind = `(创建失败: ${(e as Error).message})`;
  }
}

// self 项目（临时自举根）：塔台自身口径 = 根 DESIGN.md + PLAN.md
write(path.join(selfRoot, "DESIGN.md"), "# 临时自举设计书\n\n## 1 概述\n自举根的设计书。\n");
write(path.join(selfRoot, "PLAN.md"), planDoc(VALID_ROWS));

// userok 项目：用户确认（by=user + user_confirmed）的合法形态，与 plain 隔离，避免污染基线流水
write(path.join(workbench(userRoot), "design.md"), "# 用户确认夹具设计书\n\n## 1 概述\n用户确认那条路没焊死。\n");
write(path.join(workbench(userRoot), "plan.md"), planDoc(VALID_ROWS));

// ── ① 唯一当前源 ──
console.log("");
info("═══ ① 唯一当前源（三种夹具 + 越界拒绝） ═══");

const repoDesignBefore = fs.readFileSync(REPO_DESIGN);
const repoPlanBefore = fs.readFileSync(REPO_PLAN);

const tataiDesignSrc = resolveDocumentSource("tatai", "design", dataDir);
ok(
  tataiDesignSrc.origin === "tatai_root" &&
    tataiDesignSrc.rel_path === "DESIGN.md" &&
    path.resolve(tataiDesignSrc.abs_path) === path.resolve(REPO_DESIGN),
  `① 塔台根文档：设计书源 = 根 DESIGN.md（origin=${tataiDesignSrc.origin}）`,
);
ok(
  resolveDocumentSource("tatai", "plan", dataDir).rel_path === "PLAN.md",
  "① 塔台根文档：施工图源 = 根 PLAN.md",
);
const tataiDesign = loadDocument("tatai", "design", dataDir)!;
ok(
  sha256Hex(repoDesignBefore) === tataiDesign.revision.content_sha256 &&
    tataiDesign.revision.bytes === repoDesignBefore.length,
  `① 塔台设计书读的就是根文档字节（sha256 ${tataiDesign.revision.content_sha256.slice(0, 12)}…，${tataiDesign.revision.bytes} B）`,
);
ok(
  tataiDesign.revision.sections.length > 50 &&
    tataiDesign.revision.sections.some((s) => s.path.includes("2.6 权威数据与派生内容")),
  `① 塔台设计书建出章节索引（${tataiDesign.revision.sections.length} 节，含 §2.6）`,
);
ok(
  tataiDesign.revision.definition_sha256 !== tataiDesign.revision.content_sha256 &&
    sha256Hex(tataiDesign.text.slice(0, tataiDesign.text.indexOf("## 附录 B：待议记录"))) ===
      tataiDesign.revision.definition_sha256,
  "① 设计定义哈希 = 正文（不含附录 B 待议区）；内容哈希 = 全文逐字节",
);

const plainSrc = resolveDocumentSource("plain", "design", dataDir);
ok(
  plainSrc.origin === "default" && plainSrc.rel_path === ".工作台/design.md",
  `① 普通项目私有文档：缺省源 = .工作台/design.md（origin=${plainSrc.origin}）`,
);
ok(
  resolveDocumentSource("plain", "plan", dataDir).rel_path === ".工作台/plan.md",
  "① 普通项目私有文档：缺省施工图源 = .工作台/plan.md",
);

ok(
  setProjectDocumentPaths("reg", { design_path: "docs/design.md", plan_path: "docs/plan.md" }, dataDir),
  "① 登记其他相对路径：setProjectDocumentPaths 写入注册表（登记入口可用）",
);
const regSrc = resolveDocumentSource("reg", "design", dataDir);
ok(
  regSrc.origin === "registered" && regSrc.rel_path === "docs/design.md",
  `① 已登记其他相对路径：设计书源 = docs/design.md（origin=${regSrc.origin}）`,
);
ok(
  loadDocument("reg", "design", dataDir)!.text.includes("登记路径设计书"),
  "① 唯一当前源：读的是登记那份",
);
ok(
  !loadDocument("reg", "design", dataDir)!.text.includes("诱饵"),
  "① 唯一当前源：登记生效后不读缺省的 .工作台/design.md（没有第二份现行稿）",
);

ok(
  setProjectDocumentPaths("tatai", { design_path: "docs/never-used.md" }, dataDir),
  "① 塔台登记字段可写（下面断言它对塔台自身不生效）",
);
ok(
  resolveDocumentSource("tatai", "design", dataDir).rel_path === "DESIGN.md" &&
    resolveDocumentSource("tatai", "design", dataDir).origin === "tatai_root",
  "① 塔台自身固定读根 DESIGN.md：登记字段不覆盖（§2.9「塔台自身固定读取」）",
);

let registerReject = "(没有抛错)";
try {
  setProjectDocumentPaths("reg", { design_path: "../outside/design.md" }, dataDir);
} catch (e) {
  registerReject = (e as Error).message;
}
ok(registerReject.includes(".."), `① 登记时拒绝 ../ 穿越（${registerReject}）`);
let absoluteReject = "(没有抛错)";
try {
  setProjectDocumentPaths("reg", { plan_path: "D:/tmp/plan.md" }, dataDir);
} catch (e) {
  absoluteReject = (e as Error).message;
}
ok(absoluteReject.includes("绝对路径"), `① 登记时拒绝绝对路径（${absoluteReject}）`);
ok(
  resolveDocumentSource("reg", "design", dataDir).rel_path === "docs/design.md",
  "① 被拒的登记没有落盘（合法登记仍是 docs/design.md）",
);

// 手改注册表（真实越界写法）→ 解析时拦下
const badHome = path.join(tmpBase, "bad-home");
mkdirp(badHome);
write(
  path.join(badHome, "registry.json"),
  JSON.stringify({
    version: 1,
    projects: [
      record("bad-abs", "绝对路径", escRoot, { design_path: "C:/Windows/win.ini" }),
      record("bad-up", "上一级", escRoot, { plan_path: "../outside/plan.md" }),
    ],
  }),
);
const absErr = workError(() => resolveDocumentSource("bad-abs", "design", badHome));
ok(
  absErr?.code === "INVALID_COMMAND" && reasonOf(absErr) === "absolute_path",
  `① 绝对路径被拒（code=${String(absErr?.code)}, reason=${String(reasonOf(absErr))}）`,
);
const upErr = workError(() => resolveDocumentSource("bad-up", "plan", badHome));
ok(
  upErr?.code === "INVALID_COMMAND" && reasonOf(upErr) === "parent_traversal",
  `① ../ 路径穿越被拒（code=${String(upErr?.code)}, reason=${String(reasonOf(upErr))}）`,
);

if (symlinkKind === "junction" || symlinkKind === "dir-symlink") {
  ok(
    setProjectDocumentPaths("esc", { plan_path: "escape/plan.md" }, dataDir),
    `① 软链夹具就位（${symlinkKind}：项目根内 escape → 项目根外；登记本身合法）`,
  );
  const escErr = workError(() => resolveDocumentSource("esc", "plan", dataDir));
  ok(
    escErr?.code === "INVALID_COMMAND" && reasonOf(escErr) === "symlink_escape",
    `① 软链指向项目根外被拒（code=${String(escErr?.code)}, reason=${String(reasonOf(escErr))}）`,
  );
  ok(
    workError(() => loadDocument("esc", "plan", dataDir))?.code === "INVALID_COMMAND",
    "① 读取路径同样被拦（不是只在解析入口拒）",
  );
} else {
  ok(false, `① 无法建立软链夹具：${symlinkKind}`);
}
ok(
  resolveDocumentSource("esc", "design", dataDir).rel_path === ".工作台/design.md",
  "① 同一项目里合法的设计书源不受影响（逐份角色文档各判各的）",
);

// ── ② 读原文 / 章节差异 / 不可变历史 / 双版本激活 ──
console.log("");
info("═══ ② 修订、章节差异与双版本激活 ═══");

const plainDesignV1 = loadDocument("plain", "design", dataDir)!;
ok(
  plainDesignV1.revision.content_sha256 === sha256Hex(DESIGN_V1) &&
    plainDesignV1.revision.lines === DESIGN_V1.replace(/\n$/, "").split("\n").length,
  `② 读原文：内容哈希 = 原文逐字节（${plainDesignV1.revision.content_sha256.slice(0, 12)}…，${plainDesignV1.revision.lines} 行）`,
);
const plainPlanV1 = loadDocument("plain", "plan", dataDir)!;
const plainTable = parsePlanTable(plainPlanV1.text)!;
ok(
  plainTable.start_line === PLAN_TABLE_LINE && plainTable.rows.length === 4,
  `② 施工卡表定位与行数（起始行 ${plainTable.start_line}，${plainTable.rows.length} 行）`,
);
ok(
  !plainTable.rows.some((r) => r.id.startsWith("Q")) && plainTable.rows[0].id === "T-1",
  "② 只吃第一张合格表：前面的历史表（表头不含「依赖」）没被误吃",
);
ok(
  JSON.stringify(plainTable.rows[3].dependencies) ===
    JSON.stringify(["T-1", "T-2", "T-3", "T-2", "T-1"]) &&
    plainTable.rows[0].dependencies.length === 0,
  `② 依赖列按 、,，/空白 切分（T-4 → ${JSON.stringify(plainTable.rows[3].dependencies)}；空单元格 = 无依赖）`,
);
ok(
  validatePlanTasks(plainTable.rows).length === 0 &&
    plainPlanV1.revision.definition_sha256 ===
      sha256Hex(
        JSON.stringify(plainTable.rows.map((r) => [r.id, r.goal, r.dependencies, r.evidence])),
      ),
  "② 合法施工图无结构问题；定义哈希只覆盖卡号/交付目标/依赖/完成证据",
);
// §2.9：派生状态不进定义哈希——把手写文件的状态列改掉，定义哈希必须不变
const statusFlipped = PLAN_V1.replace("| T-1 | todo |", "| T-1 | done |");
write(path.join(workbench(plainRoot), "plan.md"), statusFlipped);
const flippedLoaded = loadDocument("plain", "plan", dataDir)!;
ok(
  flippedLoaded.revision.content_sha256 !== plainPlanV1.revision.content_sha256 &&
    flippedLoaded.revision.definition_sha256 === plainPlanV1.revision.definition_sha256,
  "② 派生状态（状态列）变化：内容哈希变、定义哈希不变（§2.9）",
);
write(path.join(workbench(plainRoot), "plan.md"), PLAN_V1);

// 章节差异：先把 v1 存成不可变历史（否则"上一版原文"取不回，差异比较就是空中楼阁）
const preserveV1 = preserveDocumentRevision("plain", "design", dataDir);
write(path.join(workbench(plainRoot), "design.md"), DESIGN_V2);
const plainDesignV2 = loadDocument("plain", "design", dataDir)!;
ok(
  preserveV1.recovery.ref === revisionObjectRel("design", plainDesignV1.revision.content_sha256),
  "② 旧修订先落不可变历史（差异比较的前提：上一版原文取得到）",
);
const diff = diffRevisionsByHash(
  "plain",
  "design",
  plainDesignV1.revision.content_sha256,
  plainDesignV2.revision.content_sha256,
  dataDir,
);
ok(
  diff.counts.added === 1 && diff.counts.removed === 1 && diff.counts.changed === 1 && !diff.identical,
  `② 章节差异：新增 ${diff.counts.added} / 删除 ${diff.counts.removed} / 改动 ${diff.counts.changed}（${diff.changed
    .map((c) => `${c.change}:${c.path.split(" / ").at(-1)}`)
    .join("、")}）`,
);
ok(
  diff.changed.some((c) => c.change === "added" && c.path.endsWith("4 新增章节")) &&
    diff.changed.some((c) => c.change === "removed" && c.path.endsWith("3 废弃章节")) &&
    diff.changed.some((c) => c.change === "changed" && c.path.endsWith("2 方案")),
  "② 差异落在正确的章节上（新增/删除/改动各命中预期标题）",
);
const sameDiff = diffRevisionsByHash(
  "plain",
  "design",
  plainDesignV2.revision.content_sha256,
  plainDesignV2.revision.content_sha256,
  dataDir,
);
ok(sameDiff.identical && sameDiff.changed.length === 0, "② 同一修订自比 = 逐字节相同（无差异）");

// 不可变历史（该夹具项目没有 Git 仓库）
const preserveFirst = preserveDocumentRevision("plain", "design", dataDir);
const designObjRel = revisionObjectRel("design", plainDesignV2.revision.content_sha256);
ok(
  preserveFirst.recovery.kind === "immutable_copy" &&
    preserveFirst.recovery.ref === designObjRel &&
    fs.existsSync(path.join(plainRoot, designObjRel)),
  `② 无 Git 提交的图纸：落不可变副本（${designObjRel}）`,
);
ok(read(path.join(plainRoot, designObjRel)) === DESIGN_V2, "② 不可变副本内容与原文逐字节一致");
const objStatBefore = fs.statSync(path.join(plainRoot, designObjRel));
const preserveAgain = preserveDocumentRevision("plain", "design", dataDir);
const objStatAfter = fs.statSync(path.join(plainRoot, designObjRel));
ok(
  preserveAgain.recovery.ref === preserveFirst.recovery.ref &&
    objStatAfter.mtimeMs === objStatBefore.mtimeMs &&
    objStatAfter.size === objStatBefore.size,
  "② 历史不可改（不回写）：重复保存不动已有历史对象（mtime/大小不变）",
);
const recovered = recoverRevision(plainRoot, preserveFirst.recovery);
ok(
  recovered.bytes.equals(Buffer.from(DESIGN_V2, "utf8")) &&
    sha256Hex(recovered.bytes) === preserveFirst.recovery.sha256,
  "② 按恢复位置取回原文并复核哈希（无 Git 提交也能按哈希恢复）",
);
const designObjAbs = path.join(plainRoot, designObjRel);
const objOriginal = read(designObjAbs);
fs.writeFileSync(designObjAbs, `${DESIGN_V2}\n（被人手改过）\n`, "utf8");
const tampered = workError(() => recoverRevision(plainRoot, preserveFirst.recovery));
ok(
  tampered?.detail?.reason === "revision_object_tampered",
  `② 历史对象被改动即被检出（reason=${String(tampered?.detail?.reason)}），不把改过的内容当原修订`,
);
ok(
  workError(() => preserveDocumentRevision("plain", "design", dataDir))?.detail?.reason ===
    "revision_object_tampered",
  "② 保存路径同样拒绝在改过的历史对象上继续（不静默覆盖）",
);
fs.writeFileSync(designObjAbs, objOriginal, "utf8");

const planPreserve = preserveDocumentRevision("plain", "plan", dataDir);
ok(
  planPreserve.recovery.ref === revisionObjectRel("plan", plainPlanV1.revision.definition_sha256) &&
    read(path.join(plainRoot, planPreserve.recovery.ref)) === PLAN_V1,
  `② 施工图历史按定义哈希命名（${planPreserve.recovery.ref}），存的是施工定义原文`,
);
ok(
  planPreserve.recovery.sha256 === plainPlanV1.revision.content_sha256 &&
    planPreserve.recovery.key === plainPlanV1.revision.definition_sha256,
  "② 恢复记录同时带内容哈希（校验位）与定义哈希（文件名键）",
);
ok(
  !/unlink/.test(read(path.join(REPO, "src", "server", "work", "documents.ts"))) &&
    !/rmSync\((?!tmp)/.test(read(path.join(REPO, "src", "server", "work", "documents.ts"))),
  "② 源码级：documents.ts 没有任何 unlink，且 rmSync 只用于清理自己的临时文件（历史对象只增不改、无删除接口）",
);

// 结构问题四种 → 拒绝激活
const setPlan = (rows: string[]) => write(path.join(workbench(plainRoot), "plan.md"), planDoc(rows));
/** 当前修订的"草稿标识"（缺一份图纸时只带在场那份——上面的缺失校验会先拒） */
const expectedNow = () => {
  const d = loadDocument("plain", "design", dataDir);
  const p = loadDocument("plain", "plan", dataDir);
  return {
    ...(d === null ? {} : { design_source_path: d.source.rel_path, design_content_sha256: d.revision.content_sha256 }),
    ...(p === null ? {} : { plan_source_path: p.source.rel_path, plan_definition_sha256: p.revision.definition_sha256 }),
  };
};
const approve = {
  approved_by: "gpt-6",
  approval_basis: "用户已委派 GPT-6 的技术设计职责（DESIGN.md §2.9）",
  approval_kind: "delegated_technical_review" as const,
};
const baselines = baselinesPath("plain", dataDir);

setPlan(["| T-1 | todo | 打地基 |  | 证据一 |", "| T-1 | todo | 重复的卡号 | T-1 | 证据二 |"]);
const dupErr = workError(() => activateBaseline("plain", { ...approve, expected: expectedNow() }, dataDir));
ok(
  dupErr?.code === "INVALID_COMMAND" &&
    issuesOf(dupErr).some((i) => i.problem === "duplicate_id" && i.ids.includes("T-1")),
  "② 卡号重复 → 拒绝激活并点名 id（T-1）",
);
setPlan(["| T-1 | todo | 打地基 |  | 证据一 |", "| T-2 | todo | 砌墙 | T-9 | 证据二 |"]);
const danglingErr = workError(() => activateBaseline("plain", { ...approve, expected: expectedNow() }, dataDir));
ok(
  danglingErr?.code === "INVALID_COMMAND" &&
    issuesOf(danglingErr).some((i) => i.problem === "dangling_dependency" && i.ids.includes("T-9")),
  "② 依赖悬空 → 拒绝激活并点名缺失 id（T-9）",
);
setPlan([
  "| T-1 | todo | 打地基 | T-2 | 证据一 |",
  "| T-2 | todo | 砌墙 | T-3 | 证据二 |",
  "| T-3 | todo | 上梁 | T-1 | 证据三 |",
]);
const cycleErr = workError(() => activateBaseline("plain", { ...approve, expected: expectedNow() }, dataDir));
const cycleIssue = issuesOf(cycleErr).find((i) => i.problem === "dependency_cycle");
ok(
  cycleErr?.code === "INVALID_COMMAND" && cycleIssue !== undefined && cycleIssue.ids.length === 3,
  `② 依赖成环 → 拒绝激活（环上 ${cycleIssue?.ids.join("、") ?? "?"}）`,
);
setPlan(["| T-1 | todo |  |  | 证据一 |", "| T-2 | todo | 砌墙 | T-1 |  |"]);
const missErr = workError(() => activateBaseline("plain", { ...approve, expected: expectedNow() }, dataDir));
ok(
  missErr?.code === "INVALID_COMMAND" &&
    issuesOf(missErr).some(
      (i) => i.problem === "missing_acceptance" && i.ids.includes("T-1") && i.ids.includes("T-2"),
    ),
  "② 缺验收内容（交付目标/完成证据为空）→ 拒绝激活并点名 id",
);
ok(!fs.existsSync(baselines), "② 四次拒绝激活都没写下 baselines.jsonl（一个字节不写）");

// 任一份缺失不能激活
setPlan(VALID_ROWS);
fs.rmSync(path.join(workbench(plainRoot), "plan.md"), { force: true });
const noPlanErr = workError(() => activateBaseline("plain", { ...approve, expected: expectedNow() }, dataDir));
ok(
  noPlanErr?.code === "INVALID_COMMAND" &&
    JSON.stringify(noPlanErr.detail.missing) === JSON.stringify(["plan"]),
  `② 施工图缺失 → 拒绝激活（missing=${JSON.stringify(noPlanErr?.detail.missing)}）`,
);
setPlan(VALID_ROWS);
fs.rmSync(path.join(workbench(plainRoot), "design.md"), { force: true });
const noDesignErr = workError(() => activateBaseline("plain", { ...approve, expected: expectedNow() }, dataDir));
ok(
  noDesignErr?.code === "INVALID_COMMAND" &&
    JSON.stringify(noDesignErr.detail.missing) === JSON.stringify(["design"]),
  `② 设计书缺失 → 拒绝激活（missing=${JSON.stringify(noDesignErr?.detail.missing)}）`,
);
write(path.join(workbench(plainRoot), "design.md"), DESIGN_V2);

// 源变化使旧草稿比较失效
const draftExpected = {
  ...expectedNow(),
  design_content_sha256: plainDesignV2.revision.content_sha256,
};
write(
  path.join(workbench(plainRoot), "design.md"),
  `${DESIGN_V2}\n## 5 审定期间又改了一节\n（审定者手上的草稿随之失效）\n`,
);
const conflictErr = workError(() => activateBaseline("plain", { ...approve, expected: draftExpected }, dataDir));
ok(
  conflictErr?.code === "VERSION_CONFLICT" &&
    JSON.stringify(conflictErr.detail.changed).includes("design_content_sha256"),
  `② 源在审定中改变 → VERSION_CONFLICT（changed=${JSON.stringify(conflictErr?.detail.changed)}）`,
);
ok(!fs.existsSync(baselines), "② 版本冲突不留痕：baselines.jsonl 仍未创建");

// 审定红线：技术审定不得伪造成用户 Gate
const gateFile = path.join(workbench(plainRoot), "gate.jsonl");
const fakeGate = workError(() =>
  activateBaseline("plain", { ...approve, approved_by: "user", expected: expectedNow() }, dataDir),
);
ok(
  fakeGate?.code === "INVALID_COMMAND" && fakeGate.message.includes("Gate"),
  `② 技术审定不得伪造成用户 Gate（approved_by=user + delegated → 拒绝）`,
);
ok(
  workError(() =>
    activateBaseline(
      "plain",
      {
        approved_by: "gpt-6",
        approval_basis: "",
        approval_kind: "delegated_technical_review",
      },
      dataDir,
    ),
  )?.message.includes("无审定依据") === true,
  "② 无审定依据（approval_basis 为空）→ 拒绝激活",
);
const userOk = activateBaseline(
  "userok",
  {
    approved_by: "user",
    approval_basis: "用户当面确认（DESIGN.md §2.9）",
    approval_kind: "user_confirmed",
  },
  dataDir,
);
ok(
  userOk.created &&
    userOk.baseline.approved_by === "user" &&
    userOk.baseline.approval_kind === "user_confirmed" &&
    userOk.baseline.supersedes === null,
  `② 用户确认（approved_by=user + user_confirmed）是合法形态（口子没焊死；${userOk.baseline.baseline_id}）`,
);
ok(!fs.existsSync(gateFile), "② 上述激活尝试一个 gate.jsonl 都没创建（审定流程不写 Gate）");

// 成功激活 + 幂等 + 旧基线保留
const first = activateBaseline("plain", { ...approve, expected: expectedNow() }, dataDir);
const afterFirstBytes = fs.readFileSync(baselines);
ok(
  first.created && first.baseline.supersedes === null && first.baseline.baseline_id.startsWith("bl-"),
  `② 首条基线激活成功（${first.baseline.baseline_id}）`,
);
ok(
  first.baseline.approved_by === "gpt-6" &&
    first.baseline.approval_kind === "delegated_technical_review" &&
    first.baseline.approval_basis.includes("委派") &&
    first.baseline.active_at.length > 0,
  `② 基线记全字段 + 如实标注审定来源（approved_by=${first.baseline.approved_by}，kind=${first.baseline.approval_kind}）`,
);
ok(
  first.baseline.design_revision.recovery.kind === "immutable_copy" && !fs.existsSync(gateFile),
  "② 基线引用不可变恢复位置；gate.jsonl 仍不存在（技术审定不写用户 Gate）",
);
const again = activateBaseline("plain", { ...approve, expected: expectedNow() }, dataDir);
ok(
  !again.created &&
    again.baseline.baseline_id === first.baseline.baseline_id &&
    activeBaseline("plain", dataDir)?.baseline_id === first.baseline.baseline_id,
  "② 同一对修订重复激活：返回原基线、不重复追加（幂等）",
);
ok(
  fs.readFileSync(baselines).equals(afterFirstBytes),
  "② baselines.jsonl 逐字节未变（幂等真的没写第二个字节）",
);

// 新基线失败 → 旧有效基线照旧生效
setPlan(["| T-1 | todo | 打地基 | T-404 | 证据一 |"]);
const blockedErr = workError(() => activateBaseline("plain", { ...approve, expected: expectedNow() }, dataDir));
ok(
  blockedErr?.code === "INVALID_COMMAND" &&
    fs.readFileSync(baselines).equals(afterFirstBytes) &&
    activeBaseline("plain", dataDir)?.baseline_id === first.baseline.baseline_id,
  "② 新基线失败（悬空依赖）→ 旧有效基线逐字节保留、仍是生效基线",
);

// 合法的新定义 → 新基线生效，旧基线仍留在流水里
setPlan(VALID_ROWS.map((r) => r.replace("打地基", "打地基（第二版）")));
const second = activateBaseline("plain", { ...approve, expected: expectedNow() }, dataDir);
const twoLines = read(baselines).trim().split("\n");
ok(
  second.created && twoLines.length === 2 && second.baseline.supersedes === first.baseline.baseline_id,
  `② 新基线成功后才切换（${second.baseline.baseline_id} ← 取代 ${String(second.baseline.supersedes)}）`,
);
ok(
  twoLines[0] === JSON.stringify(first.baseline) &&
    activeBaseline("plain", dataDir)?.baseline_id === second.baseline.baseline_id,
  "② 旧基线行逐字节不动；生效基线 = 流水最后一条",
);
ok(
  second.baseline.plan_revision.definition_sha256 !== first.baseline.plan_revision.definition_sha256,
  "② 施工定义变化被如实反映（定义哈希不同）",
);

// 塔台自身 PLAN 的现状：如实登记（不作为本卡验收项，也不为塔台自身激活基线）
const tataiPlan = loadDocument("tatai", "plan", dataDir)!;
const tataiIssues = validatePlanTasks(tataiPlan.tasks, tataiPlan.table_found);
// 点名登记断言**定向更新（V09-05，2026-09-24）**；判据未放宽——行数仍是"恰好等于当前施工图的卡数"：
//   旧期望 29（16 历史＋V07-01~04＋V08-01~06＋三期 1 的 U1/U2/U3）｜
//   依据：v0.9 健康修复批次按用户 2026-09-24 授权在第一张当前任务表末段增补 **V09-01…V09-09 九行**
//   （卡行状态一律 `todo`；设计判据见 DESIGN 附录 E；改动范围见 PLAN 文末「本轮改了什么（如实）」段）｜
//   新期望 38（＝29 ＋ V09 九卡）｜保留意图：塔台自身 PLAN 能被解析、行依赖仍认得出、
//   且**数量恰好**（多一行少一行都红）——不是删掉这条断言、也不是放宽成 `>=`｜
//   沿革：V08-05 时 27→28、V08-06 时 28→29，V09-05 时 29→38（同类"行数钉死"点名的既有口径不变）｜
//   本批更新前实测 96 PASS / 1 FAIL（红的就是这一条）。复跑读数见 PROGRESS 的 V09-05 流水。
//   定向更新（V09-10，2026-09-24，沿用同一条沿革）：**新期望 39（＝38 ＋ V09-10）**｜依据：v0.9 批次按用户
//   2026-09-24 返工流程裁定（原文存档 `.工作台/handoff/2026-09-24-返工流程裁定.md`，设计落点 DESIGN 附录 F）
//   在第一张当前任务表末段增补 V09-10 一行（返工流程卡）｜保留意图同上（数量恰好，不放宽成 >=）；
//   上一段 V09-05 留痕按既有惯例原文保留（verify:v09-05 ⑥ 对这段留痕有点名断言）。
// 定向更新（V09-05 返工 attempt 3，2026-09-24，沿用同一条沿革）：**新期望 44**｜依据：第 4 稿按用户
//   2026-09-24 第 2 轮澄清在第一张当前任务表末段新增 V09-11…V09-16 六行（39→45），第 5 稿按 Codex 定向复审
//   移除 V09-15 一行（45→44；逐条见 DESIGN 附录 G/G.4 与 PLAN v0.9 入口「机械影响」段第 1 条——该段已预告
//   本断言必红并要求点名定向更新）｜旧期望 39｜新期望 44（项目自身解析器实测，非估算）｜
//   保留意图同上（数量恰好、多一行少一行都红，不放宽成 >=）｜本批更新前实测 96 PASS / 1 FAIL（红的就是这一条）。
// 定向更新（V09-17，2026-09-25，沿用同一条沿革）：**新期望 45（＝44 ＋ V09-17）**｜依据：PLAN 第 6 稿
//   按用户 2026-09-25 会话逐条转达的 GPT-6 复审裁定（落实索引 DESIGN 附录 E.15；需求 req-2026-09-25-r1
//   已经正规入口登记，账本 seq 1460）在第一张当前任务表末段增补 V09-17 一行（关系边来源/映射证据判据落地）｜
//   旧期望 44｜新期望 45（项目自身解析器实测 45 行，非估算）｜
//   保留意图同上（数量恰好、多一行少一行都红，不放宽成 >=）｜PLAN 第 6 稿「机械影响」段已预告本断言必红。
// 定向更新（V09-18，2026-09-26，沿用同一条沿革）：**新期望 46（＝45 ＋ V09-18）**｜依据：PLAN 第 7 稿
//   按非作者独立复审（independent-graph-slimdown-review-20260926）与用户转达的 GPT-6 裁定 11 条
//   （落实索引 DESIGN 附录 E.17；需求 req-2026-09-26-r1 已经正规入口登记，账本 seq 1985；批次
//   change-20260926-7a6e179f）在第一张当前任务表末段增补 V09-18 一行（提案线索化/能力分类/P11 逐靶点/
//   指纹排除/勘误集中返工卡）｜旧期望 45｜新期望 46（项目自身解析器实测 46 行，非估算）｜
//   保留意图同上（数量恰好、多一行少一行都红，不放宽成 >=）｜PLAN 第 7 稿「机械影响」段已预告本断言必红。
// 定向更新（V09-19，2026-09-26，沿用同一条沿革）：**新期望 47（＝46 ＋ V09-19）**｜依据：PLAN 第 8 稿
//   按 V09-18 非作者独立复审（independent-v0918-review-20260926）R-1／R-2／R-3 与用户指令「Agent 通过 MCP
//   直接读取六张图完整当前状态」（落实索引 DESIGN 附录 E.18；需求 req-2026-09-26-r2 已经正规入口登记，
//   账本 seq 2222；批次 change-20260926-v09-19）在第一张当前任务表末段增补 V09-19 一行（R-1/R-2/R-3 返工
//   ＋六图读口卡）｜旧期望 46｜新期望 47（项目自身解析器实测 47 行，非估算）｜
//   保留意图同上（数量恰好、多一行少一行都红，不放宽成 >=）｜PLAN 第 8 稿「机械影响」段已预告本断言必红。
// 定向更新（V09-20，2026-09-26，沿用同一条沿革）：**新期望 48（＝47 ＋ V09-20）**｜依据：PLAN 第 9 稿
//   按用户 2026-09-26 会话指令「六图界面修复合并轮：信息区简短默认态＋按需详情、详情展开不压画布、
//   下钻控件可达性」（落实索引 DESIGN 附录 E.19；需求 req-2026-09-26-r4 已经正规入口登记，账本 seq 2424；
//   批次 change-20260926-v0920-ui，seq 2425）在第一张当前任务表末段增补 V09-20 一行（六图界面修复卡）｜
//   旧期望 47｜新期望 48（项目自身解析器实测 48 行，非估算）｜
//   保留意图同上（数量恰好、多一行少一行都红，不放宽成 >=）｜PLAN 第 9 稿「机械影响」段已预告本断言必红。
// 定向更新（V09-21，2026-09-27，沿用同一条沿革）：**新期望 49（＝48 ＋ V09-21）**｜依据：PLAN 第 10 稿
//   按 Cloud Code 协调员 2026-09-27 任务书（依据非作者终审 final-closure-20260927 缺陷登记 F-A…F-K；
//   需求 req-2026-09-27-r1 已经正规入口登记，账本 seq 2716；批次 change-20260927-v0921-rework，
//   seq 2717）在第一张当前任务表末段增补 V09-21 一行（全项目收口返工轮 R1–R8）｜
//   旧期望 48｜新期望 49（项目自身解析器实测 49 行，非估算）｜
//   保留意图同上（数量恰好、多一行少一行都红，不放宽成 >=）｜PLAN 第 10 稿「机械影响」段已预告本断言必红。
// 定向更新（V09-22，2026-09-28，沿用同一条沿革）：**新期望 50（＝49 ＋ V09-22）**｜依据：PLAN 第 11 稿
//   按用户 2026-09-28 会话指令「六图聚合节点全量可查看」（施工任务书 .工作台/handoff/2026-09-28-V0922-全量可查看-施工任务书.md；
//   需求 req-2026-09-28-r1 已经正规入口登记，账本 seq 3026；批次 change-20260928-d7982446，seq 3025）
//   在第一张当前任务表末段增补 V09-22 一行（通用全量可查看卡）｜
//   旧期望 49｜新期望 50（项目自身解析器实测 50 行，非估算）｜
//   保留意图同上（数量恰好、多一行少一行都红，不放宽成 >=）｜PLAN 第 11 稿「机械影响」段已预告本断言必红。
// 定向更新（V09-23…V09-25，2026-09-30，沿用同一条沿革）：**新期望 53（＝50 ＋ V09-23/V09-24/V09-25）**｜
//   依据：PLAN 按用户 2026-09-30 会话指令「同步证据发现与完整性验收」（原话与授权见 PLAN 文末
//   「同步证据发现与完整性验收（2026-09-30 用户授权增量）」段；需求 req-2026-09-30-sync-evidence
//   已经正规入口登记，账本 seq 3077…3084）在第一张当前任务表追加 V09-23/V09-24/V09-25 三行（同步契约
//   与自动发现／同步状态界面／同步机制集成终审）｜
//   旧期望 50｜新期望 53（项目自身解析器实测 53 行，非估算）｜
//   本轮范围核验（确认原 50 卡定义没被本轮顺手改）：git diff 对 PLAN.md 只有 101 行插入、**0 行删除**
//   （V09-23…V09-25 三行卡行 ＋ 需求映射一行 ＋ 文末增量段 97 行），既有 50 行卡定义与历史行一字未动；
//   PLAN 文末增量段自述「其余旧卡定义与历史行保持」。取证与全文见本轮 test-alignment 报告。
//   保留意图同上（数量恰好、多一行少一行都红，不放宽成 >=）。
// 定向更新（V09-26…V09-29，2026-10-02，沿用同一条沿革）：**新期望 57（＝53 ＋ V09-26/V09-27/V09-28/V09-29）**｜
//   依据：PLAN 按用户 2026-10-02 指令「按正常流程把正向功能全部补足（逆向落稿暂缓）」（原话与授权见 PLAN 文末
//   「正向闭环补足（2026-10-02 用户授权增量）」段；需求 req-2026-10-02-forward-loop 已经正规入口登记，账本 seq 3097；
//   批次 change-20261002-forward-loop，seq 3098）在第一张当前任务表追加四行（自动同步/上报入口/成套图纸入口/
//   集成终审）｜旧期望 53｜新期望 57（项目自身解析器实测 57 行，非估算）｜
//   本轮范围核验：PLAN.md 本轮为**纯增量**（V09-26…V09-29 四行卡行 ＋ 需求映射一行 ＋ 文末增量段），既有 53 行
//   卡定义与历史行未删改｜保留意图同上（数量恰好、多一行少一行都红，不放宽成 >=）。
// 定向更新（V09-30…V09-39，2026-10-03，沿用同一条沿革）：**新期望 67（＝57 ＋ V09-30…V09-39 十行）**｜
//   依据：PLAN 按用户 2026-10-03 指令「统一优化…」（依据 DESIGN §6.8 与 docs/unified-optimization-contract.md
//   U1–U6）在第一张当前任务表追加十行（请求内事实共享与计量／同版接续与派生复用／施工图按卡取材／完整版本续读与
//   寿命／接续前置事实说明／深层结构MCP下钻／界面共享取数与明确新鲜度／后台派生与有界公平调度／内容验证与持久增量
//   读取／持久说明索引与交接覆盖）｜旧期望 57｜新期望 67（项目自身解析器实测 67 行，非估算）｜
//   本轮范围核验：PLAN.md 本轮为纯增量（十行卡行 ＋ 需求映射与文末增量段），既有 57 行卡定义与历史行未删改｜
//   保留意图同上（数量恰好、多一行少一行都红，不放宽成 >=）。
ok(
  tataiPlan.tasks.some((t) => t.id === "V06-02" && t.dependencies.includes("V06-01")) &&
    tataiPlan.tasks.length === 67,
  `② 塔台 PLAN 解析出 ${tataiPlan.tasks.length} 行施工卡（16 历史＋V07-01~04＋V08-01~06＋三期 1 的 U1/U2/U3＋v0.9 的 V09-01~14 与 V09-16/V09-17/V09-18/V09-19/V09-20/V09-21/V09-22/V09-23/V09-24/V09-25＋正向闭环的 V09-26/V09-27/V09-28/V09-29＋统一优化的 V09-30~V09-39），V06-02 行依赖 = V06-01`,
);
ok(
  tataiIssues.every((i) => i.problem !== "dependency_cycle" && i.problem !== "missing_acceptance"),
  "② 塔台 PLAN 无成环、无缺验收内容",
);
info(
  `② 现场如实记录：塔台自身 PLAN 的结构校验结果 = ${
    tataiIssues.length === 0 ? "通过" : tataiIssues.map((i) => i.problem).join("、")
  }`,
);
if (tataiIssues.some((i) => i.problem === "dangling_dependency")) {
  info(
    "   说明：塔台 PLAN 里 DES-V06 / DES-V06-CLARIFY / V06-01 三行的依赖列写的是自然语言" +
      "（用户本轮授权 / 用户转述 DeepSeek 审读问题 / 施工授权），按本卡「依赖的 id 不在本表内即悬空」" +
      "的口径会被判悬空依赖。本卡因此**不为塔台自身激活基线**（只验源解析与解析结果）；" +
      "非卡号依赖（外部授权/前置条件）的正式位置留给 V06-03 的完整定义解析。",
  );
}

// ── ③ 并发改稿 / 恢复 / 兼容读回 / 路由登记 ──
console.log("");
info("═══ ③ 并发改稿、恢复、兼容读回与路由登记 ═══");

const beforeConcurrent = read(baselines);
const designBeforeConcurrent = read(path.join(workbench(plainRoot), "design.md"));
const staleWriter = spawnWriter("stale-A", "stale");
const readyFile = path.join(dataDir, "ready-stale-A");
for (let i = 0; i < 200 && !fs.existsSync(readyFile); i++) await sleep(50);
ok(fs.existsSync(readyFile), "③ 并发夹具：第二个进程已读走**改稿前**的草稿哈希");
const newSection = "\n## 9 主进程改稿\n主进程在另一个进程持旧哈希期间改了这一节。\n";
write(path.join(workbench(plainRoot), "design.md"), `${designBeforeConcurrent}${newSection}`);
const winner = activateBaseline("plain", { ...approve, expected: expectedNow() }, dataDir);
ok(winner.created, `③ 主进程改稿后激活成功（${winner.baseline.baseline_id}）`);
write(path.join(dataDir, "go-stale-A"), "go");
const staleExit = await waitFor(staleWriter);
const afterConcurrent = read(baselines);
const afterLines = afterConcurrent.trim().split("\n");
ok(
  staleExit.code === 0 && staleExit.stdout.includes("VERSION_CONFLICT"),
  `③ 并发改稿不覆盖：旧草稿持有者被 VERSION_CONFLICT 拒绝（exit=${String(staleExit.code)}，${staleExit.stdout.trim().split("\n").at(-1) ?? ""}）`,
);
ok(
  afterConcurrent.startsWith(beforeConcurrent) && afterLines.length === 3,
  `③ 只追加了胜者的那一行（共 ${afterLines.length} 行；旧内容逐字节未变）`,
);
ok(
  afterLines[0] === JSON.stringify(first.baseline) && afterLines[1] === JSON.stringify(second.baseline),
  "③ 旧的两条基线一字未动（并发失败方没有覆盖任何历史）",
);
ok(
  read(path.join(workbench(plainRoot), "design.md")).endsWith(newSection) &&
    loadDocument("plain", "design", dataDir)!.revision.content_sha256 ===
      winner.baseline.design_revision.content_sha256,
  "③ 源文件内容与胜者基线一致（失败方没有回写/截断源文件）",
);
ok(
  fs.readdirSync(path.join(workbench(plainRoot), "design-revisions")).every((f) => !f.endsWith(".tmp")),
  "③ 不可变历史目录没有临时文件残骸",
);

// 两个进程同时激活同一对修订：按本设计，激活只能绑定"当前源"这一对修订，
// 所以两个进程的期望是同一对——都成功、只留一条记录、都拿到生效基线（跨进程幂等，不重复追加）。
const linesBeforeIdem = afterLines.length;
const idemBytesBefore = fs.readFileSync(baselines);
const idemJsonBefore = read(baselines);
const w1 = spawnWriter("cur-1", "current");
const w2 = spawnWriter("cur-2", "current");
// 两个子进程必须先各自挂上 exit 监听再等：`[await waitFor(w1), await waitFor(w2)]`
// 会在第一个 await 处挂起，第二个的监听来不及挂——对方先退出就永远收不到 exit（复现过 1/5）。
const pending1 = waitFor(w1);
const pending2 = waitFor(w2);
const [r1, r2] = [await pending1, await pending2];
const idemLines = read(baselines).trim().split("\n");
const idemIds = [r1.stdout, r2.stdout]
  .map((s) => /baseline=(bl-[0-9a-f-]+)/.exec(s)?.[1] ?? "")
  .filter((s) => s !== "");
ok(
  r1.code === 0 && r2.code === 0,
  `③ 两进程同时激活同一对修订都成功（exit=${String(r1.code)}/${String(r2.code)}）`,
);
ok(
  idemLines.length === linesBeforeIdem &&
    new Set(idemIds).size === 1 &&
    idemIds[0] === winner.baseline.baseline_id &&
    fs.readFileSync(baselines).equals(idemBytesBefore) &&
    read(baselines) === idemJsonBefore,
  `③ 并发同对修订不重复追加（仍是 ${idemLines.length} 行、字节不变），两边都拿到生效基线 ${idemIds[0]}`,
);

// §3.5 现有 read_design 兼容读回不退化
ok(
  fs.readFileSync(REPO_DESIGN).equals(repoDesignBefore) &&
    fs.readFileSync(REPO_PLAN).equals(repoPlanBefore),
  "③ 全程没有改塔台 repo 根 DESIGN.md / PLAN.md 一个字节（附录 B 字节不变）",
);
const compatTatai = readDesign("tatai", dataDir);
ok(
  compatTatai.exists === true &&
    compatTatai.content === repoDesignBefore.toString("utf8") &&
    path.resolve(compatTatai.source) === path.resolve(REPO_DESIGN) &&
    designPath("tatai", dataDir) === REPO_DESIGN,
  "③ §3.5 read_design 兼容读回不退化：塔台仍读根 DESIGN.md 全文（内容逐字节相同）",
);
const compatPlain = readDesign("plain", dataDir);
ok(
  compatPlain.exists === true &&
    compatPlain.content === read(path.join(workbench(plainRoot), "design.md")) &&
    path.resolve(compatPlain.source) === path.resolve(path.join(workbench(plainRoot), "design.md")),
  "③ read_design 对普通项目仍读 .工作台/design.md（缺省口径不变）",
);
const compatReg = readDesign("reg", dataDir);
ok(
  compatReg.exists === true && compatReg.content.includes("登记路径设计书"),
  "③ read_design 对已登记相对路径的项目读登记那份（新口径接上，老行为不破）",
);
let forgedId = "(没有抛错)";
try {
  designPath("..\\..\\Windows", dataDir);
} catch (e) {
  forgedId = (e as Error).message;
}
ok(forgedId.includes("项目不存在"), `③ 伪造项目 id 仍被 PROJECT_NOT_FOUND 拦下（${forgedId}）`);

const routesSrc = read(path.join(REPO, "src", "server", "remote-routes.ts"));
for (const p of [
  "/api/projects/:id/documents",
  "/api/projects/:id/documents/diff",
  "/api/projects/:id/documents/preserve",
  "/api/projects/:id/documents/activate",
]) {
  ok(routesSrc.includes(`path: "${p}"`), `③ 新路由登记进 remote-routes.ts：${p}`);
}

// ── ④ 真服务端到端 ──
console.log("");
info("═══ ④ 真服务进程端到端（只读路由 + 写入路由） ═══");

// 起服务前把 `tatai` 那条记录从夹具注册表里摘掉：服务启动会清扫已登记项目的原子写残骸，
// 不该让这条"指向 repo 根的只读夹具"进入清扫范围（塔台 repo 一个字节都不该被本脚本碰到）。
// 注意按**当前**注册表过滤（登记过的 design_path/plan_path 要原样留着）。
const registryNow = JSON.parse(read(path.join(dataDir, "registry.json"))) as {
  version: number;
  projects: { id: string }[];
};
writeRegistry(registryNow.projects.filter((p) => p.id !== "tatai"));
await assertPortFree(PORT);
const child = spawnServer({ TATAI_HOME: dataDir, TATAI_PORT: String(PORT) });
await waitUpOn(PORT);
const api = async (url: string, init?: RequestInit) => {
  const r = await fetch(`http://127.0.0.1:${PORT}${url}`, init);
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};
const postJson = (url: string, body: unknown) =>
  api(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const docRes = await api("/api/projects/plain/documents");
const docBody = docRes.body.documents as {
  design: { source_path: string; content_sha256: string; sections: unknown[] };
  plan: { source_path: string };
  plan_structure: { task_count: number; issues: unknown[] } | null;
  baseline: { active: { baseline_id: string } | null; count: number };
};
ok(
  docRes.status === 200 &&
    docBody.design.source_path === ".工作台/design.md" &&
    docBody.design.content_sha256 === loadDocument("plain", "design", dataDir)!.revision.content_sha256,
  "④ GET /documents：当前源与修订哈希与本地读一致",
);
ok(
  docBody.plan_structure?.task_count === 4 &&
    docBody.plan_structure.issues.length === 0 &&
    docBody.baseline.active?.baseline_id === activeBaseline("plain", dataDir)?.baseline_id,
  `④ GET /documents：施工卡 ${String(docBody.plan_structure?.task_count)} 行、结构无问题、生效基线一致`,
);
const docJson = JSON.stringify(docRes.body);
ok(
  !docJson.includes(plainRoot) && !docJson.includes(tmpBase) && !/[A-Za-z]:[\\/]/.test(docJson),
  "④ 响应里没有本机绝对路径（只回项目根内相对路径）",
);

const regDoc = await api("/api/projects/reg/documents");
const regBody = regDoc.body.documents as { design: { origin: string; source_path: string } };
ok(
  regDoc.status === 200 && regBody.design.origin === "registered" && regBody.design.source_path === "docs/design.md",
  "④ GET /documents：已登记相对路径的项目经 HTTP 也认登记那份",
);
const selfDoc = await api("/api/projects/self/documents");
const selfBody = selfDoc.body.documents as { design: { origin: string; source_path: string } };
ok(
  selfBody.design.origin === "tatai_root" && selfBody.design.source_path === "DESIGN.md",
  "④ GET /documents：自举项目（塔台口径）经 HTTP 认根 DESIGN.md",
);

const diffRes = await api(
  `/api/projects/plain/documents/diff?kind=design&from=${first.baseline.design_revision.content_sha256}&to=${
    winner.baseline.design_revision.content_sha256
  }`,
);
const httpDiff = diffRes.body.diff as
  | { identical: boolean; counts: { added: number; changed: number } }
  | undefined;
ok(diffRes.status === 200 && httpDiff !== undefined, `④ GET /documents/diff：跨修订章节差异可用（${diffRes.status}）`);
ok(
  httpDiff !== undefined && !httpDiff.identical && httpDiff.counts.added === 1 && httpDiff.counts.changed === 0,
  `④ GET /documents/diff 结果与本地一致（新增 ${String(httpDiff?.counts.added)} / 改动 ${String(httpDiff?.counts.changed)}）`,
);
const badDiff = await api("/api/projects/plain/documents/diff?kind=design&from=zz&to=yy");
ok(
  badDiff.status === 400 && (badDiff.body.error as { code: string }).code === "INVALID_INPUT",
  "④ 非法 from/to → 400 INVALID_INPUT（不猜、不做近似比较）",
);

const preserveRes = await postJson("/api/projects/reg/documents/preserve", { kind: "plan" });
ok(
  preserveRes.status === 200 &&
    (preserveRes.body.result as { recovery: { kind: string } }).recovery.kind === "immutable_copy",
  "④ POST /documents/preserve：写入路由可用（落不可变副本）",
);
const activateRes = await postJson("/api/projects/reg/documents/activate", {
  approved_by: "gpt-6",
  approval_basis: "用户已委派的技术设计职责（§2.9）",
  approval_kind: "delegated_technical_review",
});
ok(
  activateRes.status === 200 &&
    (activateRes.body.baseline as { approved_by: string }).approved_by === "gpt-6",
  `④ POST /documents/activate：HTTP 激活成功（${
    (activateRes.body.baseline as { baseline_id: string }).baseline_id
  }）`,
);
const fakeGateHttp = await postJson("/api/projects/reg/documents/activate", {
  approved_by: "user",
  approval_basis: "技术审定冒充用户",
  approval_kind: "delegated_technical_review",
});
ok(
  fakeGateHttp.status === 400 &&
    (fakeGateHttp.body.error as { code: string }).code === "INVALID_COMMAND" &&
    (fakeGateHttp.body.error as { message: string }).message.includes("Gate"),
  "④ HTTP 层同样拒绝「技术审定伪造成用户 Gate」（400 INVALID_COMMAND）",
);
ok(
  !fs.existsSync(path.join(workbench(regRoot), "gate.jsonl")),
  "④ 经 HTTP 激活也没有写 gate.jsonl（Gate 只有人能点）",
);

const compatHttp = await api("/api/projects/plain/design");
ok(
  compatHttp.status === 200 &&
    (compatHttp.body.design as { content: string }).content ===
      read(path.join(workbench(plainRoot), "design.md")),
  "④ GET /design（read_design 的同源读口）内容一致——兼容读回不退化",
);
const unknownDoc = await api("/api/projects/no-such-project/documents");
ok(
  unknownDoc.status === 400 &&
    (unknownDoc.body.error as { message: string }).message.includes("项目不存在"),
  `④ 未登记项目 → 明确报「项目不存在」（${unknownDoc.status}）`,
);

await stopChild(child);

console.log("");
console.log(`[verify] 结果：${passCount} PASS / ${failCount} FAIL`);
if (process.env.TATAI_KEEP_TMP !== "1") {
  fs.rmSync(tmpBase, { recursive: true, force: true });
  console.log("[verify] 已清理隔离夹具目录（TATAI_KEEP_TMP=1 可保留现场）");
} else {
  console.log(`[verify] 保留现场：${tmpBase}`);
}

// ── 辅助 ──

function spawnWriter(tag: string, mode: string): ChildProcess {
  const proc = spawn(
    process.execPath,
    ["--import", "tsx", path.join("scripts", "verify-v06-02-writer.ts"), tag, dataDir, "plain", mode],
    { cwd: REPO, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] },
  );
  spawned.push(proc);
  return proc;
}

function waitFor(
  proc: ChildProcess,
  timeoutMs = 60_000,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let done = false;
    const startedAt = Date.now();
    const finish = (code: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    };
    // 子进程卡住时不许把验证脚本挂死：超时就杀掉并如实报出来（exit=null → 断言 FAIL）
    const timer = setTimeout(() => {
      const alive = proc.exitCode === null && proc.signalCode === null;
      console.error(
        `[verify] 子进程 pid=${String(proc.pid)} 在 ${timeoutMs}ms 内没有退出（alive=${String(alive)}）` +
          `stdout=${JSON.stringify(stdout.slice(-400))} stderr=${JSON.stringify(stderr.slice(-400))}`,
      );
      try {
        proc.kill("SIGKILL");
      } catch {
        // 已经没了
      }
      finish(null);
    }, timeoutMs);
    proc.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
    proc.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    proc.once("exit", (code) => finish(code));
    proc.once("error", (e: Error) => {
      console.error(`[verify] 子进程 pid=${String(proc.pid)} 失败于 ${Date.now() - startedAt}ms：${e.message}`);
      finish(null);
    });
  });
}

// 补修包 E：本脚本的激活只验 HTTP 路由与"技术审定冒充用户 Gate"的拒绝口径，不验自动链 →
// 注 `TATAI_SEMANTIC_AUTO=0`（docs/work-v2-contract.md §18.5）关掉激活后的后台模型调用。
function spawnServer(env: Record<string, string>): ChildProcess {
  const proc = spawn(process.execPath, ["--import", "tsx", path.join("src", "server", "index.ts")], {
    cwd: REPO,
    env: { ...process.env, ...env, TATAI_SEMANTIC_AUTO: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  spawned.push(proc);
  proc.stdout.on("data", (d: Buffer) => {
    if (process.env.TATAI_VERBOSE === "1") process.stdout.write(`[server] ${d.toString()}`);
  });
  proc.stderr.on("data", (d: Buffer) => process.stderr.write(`[server] ${d.toString()}`));
  return proc;
}

async function waitUpOn(port: number): Promise<void> {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok) return;
    } catch {
      // 还没起来
    }
    await sleep(250);
  }
  throw new Error(`后端 ${port} 端口 15 秒内未就绪`);
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

async function assertPortFree(port: number): Promise<void> {
  if (await portListening(port)) {
    console.error(`[verify] 后端起不来：端口 ${port} 被占用，先清理残留进程`);
    process.exit(1);
  }
}

async function stopChild(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null) return;
  proc.kill("SIGKILL");
  for (let i = 0; i < 40; i++) {
    if (proc.exitCode !== null) break;
    await sleep(100);
  }
}
