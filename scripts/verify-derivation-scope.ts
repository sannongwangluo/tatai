// 一次「现读派生」内的只读重算消除（2026-10-07 运行时阻塞修复）——行为/边界/性能回归。
//
// 被钉住的性质（每一条都直接对应真机现场或 root 反例测到的浪费/缺陷）：
//   ① **一次派生内同一份只读输入只读一次**：`loadDocument`（图纸源读+解析+修订）、
//      `importTaskDefinitions`（纯解析）、`readRevisionSnapshotText`（不可变修订对象读+核哈希）、
//      `verifySourceManifest`（清单逐文件读+哈希 + git 忽略探针）在**一次** `withDerivationScope` 内
//      对同一输入只做一次；真机现场一次六图派生里同一份 466 KB 修订对象被读+核哈希 944 次、
//      当前 PLAN 被解析 18 次、每个源文件被读+哈希约 30 次、git 探针多次。
//   ② **没有作用域时行为逐字不变**：作用域外同一输入读几次就是几次（老路径/写路径/单测路径不受影响）。
//   ③ **不跨请求缓存**：连续两次派生各自现读现算，两次之间改了图纸源，第二次立刻看见（含**同尺寸且
//      保留 mtime** 的内容变化）——没有 TTL、没有全局 stat/mtime 缓存。
//   ④ **结果与"各读各的"逐字段相同 + 返回深独立副本**：复用得到的返回值与作用域外现算深比较一致；
//      `importTaskDefinitions` 的 definitions/report、`loadDocument` 的 revision/tasks 都在调用方之间
//      不共享（改它不串味、不改记忆）。
//   ⑤ **选项键稳定且完整**（root 反例）：`revisions`/`requirement_ids` 这类**嵌套**选项必须进键；
//      不同选项不能撞同一记忆；数组顺序保持、对象键递归排序。
//   ⑥ **不可变副本核对哈希的是盘上原始字节**（root 反例）：合法 UTF-8 与"同解码文本、非法字节"的
//      篡改摘要不同——后者必须判不命中（不能用 UTF-8 解码后的文本哈希糊过去）。
//   ⑦ **作用域可嵌套、抛错也整批丢弃**：内层复用外层记忆；最外层退出（正常或异常）后记忆归零、深度归零。
//
// 隔离口径（AGENTS.md §5）：夹具一律在系统 tmp 下 `tatai-derivation-reuse-` 前缀目录里自建自清，
//   绝不碰真实注册表/真实项目/任何生产数据；不 build、不起服务、不跑模型。
//
// 运行：node --import tsx scripts/verify-derivation-scope.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { loadDocument, readRevisionSnapshotText, PLAN_REVISIONS_DIR } from "../src/server/work/documents";
import { importTaskDefinitions } from "../src/server/work/plan";
import { verifySourceManifest, buildSourceManifest } from "../src/server/work/sourceEvidence";
import {
  withDerivationScope,
  inDerivationScope,
  derivationScopeStats,
} from "../src/server/work/derivationScope";

const fails: string[] = [];
const skips: string[] = [];
let pass = 0;
function ok(cond: boolean, label: string): void {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fails.push(label);
    console.log(`  ✗ ${label}`);
  }
}
function eq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-derivation-reuse-"));
const dataDir = path.join(tmpRoot, "home");
const projectRoot = path.join(tmpRoot, "proj");
const workbench = path.join(projectRoot, ".工作台");
const rawByteRoot = path.join(tmpRoot, "rawbyte");
const rawByteWorkbench = path.join(rawByteRoot, ".工作台");
const twinARoot = path.join(tmpRoot, "twin-a");
const twinBRoot = path.join(tmpRoot, "twin-b");

/** 读调用计数（按绝对路径；测完还原） */
const readCount = new Map<string, number>();
const origReadFileSync = fs.readFileSync;
function installReadCounter(): void {
  (fs as unknown as { readFileSync: typeof fs.readFileSync }).readFileSync = function (
    p: fs.PathOrFileDescriptor,
    ...rest: unknown[]
  ) {
    const key = String(p);
    readCount.set(key, (readCount.get(key) ?? 0) + 1);
    return (origReadFileSync as unknown as (...a: unknown[]) => unknown).call(fs, p, ...rest) as never;
  } as typeof fs.readFileSync;
}
function uninstallReadCounter(): void {
  (fs as unknown as { readFileSync: typeof fs.readFileSync }).readFileSync = origReadFileSync;
}
function readsOf(p: string): number {
  return readCount.get(p) ?? 0;
}

/** 造一份像样的施工图正文（若干张卡 + 定义区 + 状态段），量级接近真机（~20 万字符） */
function planText(cardCount: number, marker: string): string {
  const head = [
    "# 施工图（回归夹具）",
    "",
    `> 夹具标记：${marker}`,
    "",
    "## 卡表",
    "",
    "| 卡号 | 交付目标 | 依赖 | 完成证据 |",
    "| --- | --- | --- | --- |",
  ];
  const rows: string[] = [];
  for (let i = 1; i <= cardCount; i++) {
    rows.push(`| V99-${i} | 交付第 ${i} 项能力（${marker}） | — | 单测与现场读数 |`);
  }
  const bodies: string[] = [];
  for (let i = 1; i <= cardCount; i++) {
    bodies.push(
      `### V99-${i} 卡 ${i}`,
      "",
      `**交付目标**：第 ${i} 项能力完成并可核。`,
      `**允许改动路径**：\`src/part${i}/\``,
      `**禁止改动**：\`.工作台/\``,
      `**风险**：低。`,
      "",
      `**完成证据**：第 ${i} 项的现场读数（${marker}）。`,
      "",
      "- [ ] 单测通过",
      "- [ ] 现场读数留档",
      "",
      `**状态**：todo（夹具初始态）`,
      "",
    );
  }
  return [...head, ...rows, "", ...bodies].join("\n");
}

function writeFixturePlan(marker: string, cardCount: number): { abs: string; text: string } {
  const text = planText(cardCount, marker);
  const abs = path.join(workbench, "plan.md");
  fs.writeFileSync(abs, text, "utf8");
  return { abs, text };
}

function writeFixtureDesign(marker: string): { abs: string; text: string } {
  const text = `# 设计书（回归夹具）\n\n> 夹具标记：${marker}\n\n## 1 目标\n\n只用于验证"一次派生内只读重算消除"。\n`;
  const abs = path.join(workbench, "design.md");
  fs.writeFileSync(abs, text, "utf8");
  return { abs, text };
}

function sha256(s: string): string {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}
function sha256Bytes(b: Buffer): string {
  return crypto.createHash("sha256").update(b).digest("hex");
}
function registry(projects: Record<string, string>): string {
  return JSON.stringify(
    {
      version: 1,
      projects: Object.entries(projects).map(([id, root]) => ({
        id,
        name: id,
        path: root,
        kind: "fullstack",
        self_managed: id === "rawbyte",
        registered_at: "2026-10-07T00:00:00+08:00",
        last_opened_at: "2026-10-07T00:00:00+08:00",
      })),
    },
    null,
    2,
  );
}

try {
  fs.mkdirSync(path.join(workbench, "work"), { recursive: true });
  fs.mkdirSync(path.join(rawByteWorkbench, "design-revisions"), { recursive: true });
  fs.mkdirSync(path.join(twinARoot, ".工作台"), { recursive: true });
  fs.mkdirSync(path.join(twinBRoot, ".工作台"), { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  const plan = writeFixturePlan("A", 60);
  const design = writeFixtureDesign("A");
  // rawbyte：self_managed=true → 源为 repo 根 DESIGN.md（与 root 反例夹具同口径）
  const rawBytesValid = Buffer.concat([Buffer.from("# Design\n"), Buffer.from([0xef, 0xbf, 0xbd]), Buffer.from("\n")]);
  const rawBytesTampered = Buffer.concat([Buffer.from("# Design\n"), Buffer.from([0x80]), Buffer.from("\n")]);
  fs.writeFileSync(path.join(rawByteRoot, "DESIGN.md"), rawBytesValid);
  // twin-a / twin-b：同相对路径的图纸源，内容不同——验证跨项目键不串味
  fs.writeFileSync(path.join(twinARoot, ".工作台", "plan.md"), planText(3, "TWIN-A"));
  fs.writeFileSync(path.join(twinBRoot, ".工作台", "plan.md"), planText(3, "TWIN-B"));
  fs.writeFileSync(
    path.join(dataDir, "registry.json"),
    registry({ fx: projectRoot, rawbyte: rawByteRoot, twina: twinARoot, twinb: twinBRoot }),
    "utf8",
  );
  // 源清单登记的源文件（供 verifySourceManifest 复核用）
  const srcDir = path.join(projectRoot, "src");
  fs.mkdirSync(srcDir, { recursive: true });
  const srcFiles: { rel: string; abs: string; text: string }[] = [];
  for (let i = 0; i < 12; i++) {
    const rel = `src/part${i}.ts`;
    const text = `export const part${i} = ${i};\n`;
    const abs = path.join(projectRoot, rel);
    fs.writeFileSync(abs, text, "utf8");
    srcFiles.push({ rel, abs, text });
  }

  console.log(`\n[1] 作用域外：读几次就是几次（默认路径逐字不变）`);
  installReadCounter();
  readCount.clear();
  loadDocument("fx", "plan", dataDir);
  loadDocument("fx", "plan", dataDir);
  uninstallReadCounter();
  ok(readsOf(plan.abs) === 2, `作用域外两次 loadDocument → 图纸源被读 2 次（实际 ${readsOf(plan.abs)}）`);

  console.log(`\n[2] 一次派生内：同一份只读输入只读一次`);
  installReadCounter();
  readCount.clear();
  const inScope = withDerivationScope(() => {
    const a = loadDocument("fx", "plan", dataDir);
    const b = loadDocument("fx", "plan", dataDir);
    const c = loadDocument("fx", "design", dataDir);
    const d = loadDocument("fx", "design", dataDir);
    return { a, b, c, d };
  });
  uninstallReadCounter();
  ok(readsOf(plan.abs) === 1, `一次派生内两次 loadDocument(plan) → 图纸源只读 1 次（实际 ${readsOf(plan.abs)}）`);
  ok(readsOf(design.abs) === 1, `一次派生内两次 loadDocument(design) → 图纸源只读 1 次（实际 ${readsOf(design.abs)}）`);
  ok(inScope.a?.text === inScope.b?.text, "同派生内两次读到的正文逐字相同");
  ok(inScope.a?.revision.content_sha256 === sha256(plan.text), "修订内容哈希与现算一致（判据未改）");

  console.log(`\n[3] 结果与"各读各的"逐字段相同 + revision/tasks 是深独立副本（改它不串味、不改记忆）`);
  const alonePlan = loadDocument("fx", "plan", dataDir);
  const aloneDesign = loadDocument("fx", "design", dataDir);
  ok(eq(inScope.a?.revision, alonePlan?.revision), "plan 修订（含章节索引/恢复位置核查）与作用域外逐字段一致");
  ok(eq(inScope.c?.revision, aloneDesign?.revision), "design 修订与作用域外逐字段一致");
  ok(eq(inScope.a?.tasks, alonePlan?.tasks), "任务行与作用域外一致");
  ok(inScope.a?.tasks !== inScope.b?.tasks, "同一派生内两次返回的任务行数组是**独立副本**");
  ok(inScope.a?.revision !== inScope.b?.revision, "同一派生内两次返回的 revision 是**独立对象**");
  const mutateTarget = withDerivationScope(() => {
    const first = loadDocument("fx", "plan", dataDir);
    const snapshotGoal = first?.tasks[0]?.goal ?? "";
    const snapshotTitle = first?.revision.sections[0]?.title ?? "";
    if (first !== null && first.tasks[0] !== undefined) first.tasks[0].goal = "caller-mutation";
    if (first !== null && first.revision.sections[0] !== undefined) {
      first.revision.sections[0].title = "caller-tampered-section";
    }
    const second = loadDocument("fx", "plan", dataDir);
    return {
      snapshotGoal,
      secondGoal: second?.tasks[0]?.goal ?? "",
      snapshotTitle,
      secondTitle: second?.revision.sections[0]?.title ?? "",
    };
  });
  ok(
    mutateTarget.secondGoal === mutateTarget.snapshotGoal &&
      mutateTarget.secondTitle === mutateTarget.snapshotTitle &&
      !mutateTarget.secondTitle.includes("caller-tampered"),
    "改调用方拿到的 tasks/revision 不回写记忆：同派生下次读到原值",
  );

  console.log(`\n[4] 纯解析（importTaskDefinitions）：一次派生内同一正文+同选项只解析一次，结果一致`);
  const defs1 = importTaskDefinitions(plan.text);
  const defs2 = importTaskDefinitions(plan.text);
  ok(eq(defs1.definitions, defs2.definitions), "同选项两次解析结果逐字段一致");
  ok(defs1.definitions.length === 60, `解析出全部 60 张卡（实际 ${defs1.definitions.length}）`);
  const statsAfterParse = withDerivationScope(() => {
    importTaskDefinitions(plan.text);
    importTaskDefinitions(plan.text);
    importTaskDefinitions(plan.text, { change_id: "batch-x" });
    return derivationScopeStats();
  });
  ok(statsAfterParse.entries >= 2, `一次派生内 3 次解析只落 2 条记忆（同选项 1 条 + 不同选项 1 条），实际 ${statsAfterParse.entries}`);

  console.log(`\n[4b] 选项键稳定且完整：嵌套 revisions/requirement_ids 必须进键（root 反例）`);
  const nested = withDerivationScope(() => {
    const a = importTaskDefinitions(plan.text, { revisions: { "V99-1": 1 }, requirement_ids: { "V99-1": ["req-a"] } });
    const b = importTaskDefinitions(plan.text, { revisions: { "V99-1": 2 }, requirement_ids: { "V99-1": ["req-b"] } });
    const c = importTaskDefinitions(plan.text, { revisions: { "V99-1": 1 }, requirement_ids: { "V99-1": ["req-a"] } });
    return {
      first_revision: a.definitions[0]?.revision,
      second_revision: b.definitions[0]?.revision,
      second_requirements: b.definitions[0]?.requirement_ids,
      third_revision: c.definitions[0]?.revision,
      third_requirements: c.definitions[0]?.requirement_ids,
    };
  });
  ok(nested.first_revision === 1 && nested.second_revision === 2, `嵌套 revisions 进键：第二次返回修订 2（实际 ${nested.second_revision}）`);
  ok(eq(nested.second_requirements, ["req-b"]), `嵌套 requirement_ids 进键：第二次返回 req-b（实际 ${JSON.stringify(nested.second_requirements)}）`);
  ok(nested.third_revision === 1 && eq(nested.third_requirements, ["req-a"]), "选项回到第一组即命中第一组记忆（键完整）");
  const orderKey = withDerivationScope(() => {
    importTaskDefinitions(plan.text, { revisions: { "V99-1": 1, "V99-2": 1 } });
    const first = derivationScopeStats().entries;
    importTaskDefinitions(plan.text, { revisions: { "V99-2": 1, "V99-1": 1 } }); // 插入顺序不同、内容相同
    const second = derivationScopeStats().entries;
    importTaskDefinitions(plan.text, { requirement_ids: { "V99-1": ["a", "b"] } });
    const third = derivationScopeStats().entries;
    importTaskDefinitions(plan.text, { requirement_ids: { "V99-1": ["b", "a"] } }); // 数组顺序不同 ⇒ 另算
    const fourth = derivationScopeStats().entries;
    return { second, third, fourth };
  });
  ok(orderKey.second === 1, `对象键递归排序：插入顺序不同但内容相同 ⇒ 命中同一记忆（实际 ${orderKey.second}）`);
  ok(orderKey.third === 2 && orderKey.fourth === 3, `数组保持原序：requirement_ids 数组顺序不同即另算（实际 ${orderKey.third}→${orderKey.fourth}）`);

  console.log(`\n[4c] 返回深独立副本：改 definitions[0] 的嵌套字段/数组、改 report 都不串味（root 反例）`);
  const noAlias = withDerivationScope(() => {
    const a = importTaskDefinitions(plan.text, { revisions: { "V99-1": 1 }, requirement_ids: { "V99-1": ["req-a"] } });
    const originalGoal = a.definitions[0]?.goal ?? "";
    if (a.definitions[0] !== undefined) a.definitions[0].goal = "caller-mutation";
    if (a.definitions[0] !== undefined) a.definitions[0].requirement_ids?.push("caller-injected");
    if (a.report.tasks[0] !== undefined) a.report.tasks[0].missing_fields.push("caller-injected");
    const c = importTaskDefinitions(plan.text, { revisions: { "V99-1": 1 }, requirement_ids: { "V99-1": ["req-a"] } });
    return {
      originalGoal,
      third_goal: c.definitions[0]?.goal ?? "",
      third_requirements: c.definitions[0]?.requirement_ids ?? [],
      third_report: c.report.tasks[0]?.missing_fields ?? [],
    };
  });
  ok(noAlias.third_goal === noAlias.originalGoal, `改 definitions[0].goal 不泄漏到下一次（实际 "${noAlias.third_goal}"）`);
  ok(eq(noAlias.third_requirements, ["req-a"]), `改 definitions[0].requirement_ids 不泄漏（实际 ${JSON.stringify(noAlias.third_requirements)}）`);
  ok(!noAlias.third_report.includes("caller-injected"), "改 report.tasks[0].missing_fields 不泄漏（report 也深独立）");

  console.log(`\n[5] 不可变修订对象：一次派生内同一对象只读一次（真机现场同一份被读 944 次）`);
  const revDir = path.join(workbench, PLAN_REVISIONS_DIR);
  fs.mkdirSync(revDir, { recursive: true });
  const revText = plan.text + "\n（历史不可变对象）\n";
  const revHash = sha256(revText);
  const revAbs = path.join(revDir, `${revHash}.md`);
  fs.writeFileSync(revAbs, revText, "utf8");
  installReadCounter();
  readCount.clear();
  withDerivationScope(() => {
    for (let i = 0; i < 20; i++) readRevisionSnapshotText("fx", "plan", revHash, dataDir);
  });
  uninstallReadCounter();
  ok(readsOf(revAbs) === 1, `一次派生内 20 次读同一修订对象 → 盘上只读 1 次（实际 ${readsOf(revAbs)}）`);
  installReadCounter();
  readCount.clear();
  for (let i = 0; i < 3; i++) readRevisionSnapshotText("fx", "plan", revHash, dataDir);
  uninstallReadCounter();
  ok(readsOf(revAbs) === 3, `作用域外 3 次读 → 读 3 次（默认路径不变，实际 ${readsOf(revAbs)}）`);

  console.log(`\n[5b] 不可变副本核对哈希的是**原始字节**：同解码文本的非法字节篡改必须判不命中（root 反例）`);
  const validSha = sha256Bytes(rawBytesValid);
  const tamperedSha = sha256Bytes(rawBytesTampered);
  const decodedValid = rawBytesValid.toString("utf8");
  const decodedTampered = rawBytesTampered.toString("utf8");
  ok(decodedValid === decodedTampered, "夹具前提：合法字节与非法字节**解码后文本相同**（替换字符）");
  ok(validSha !== tamperedSha && sha256(decodedTampered) === sha256(decodedValid), "夹具前提：两者原始字节摘要不同、但解码文本摘要相同");
  const rawSnapshot = path.join(rawByteWorkbench, "design-revisions", `${validSha}.md`);
  fs.writeFileSync(rawSnapshot, rawBytesValid);
  const baselineRecovery = loadDocument("rawbyte", "design", dataDir)?.revision.recovery;
  ok(baselineRecovery?.kind === "immutable_copy", `合法快照：恢复位置判为 immutable_copy（实际 ${baselineRecovery?.kind ?? "null"}）`);
  fs.writeFileSync(rawSnapshot, rawBytesTampered);
  const tamperedRecovery = loadDocument("rawbyte", "design", dataDir)?.revision.recovery;
  ok(tamperedRecovery === null, `篡改成同解码文本的非法字节：恢复位置判 null（旧实现按原始字节即拒绝；实际 ${JSON.stringify(tamperedRecovery)}）`);
  fs.rmSync(rawSnapshot, { force: true });
  const missingRecovery = loadDocument("rawbyte", "design", dataDir)?.revision.recovery;
  ok(missingRecovery === null, "快照缺失：恢复位置判 null（fail-closed）");
  // 原始字节哈希复用：一次派生内重复 loadDocument 只读一次快照
  fs.writeFileSync(rawSnapshot, rawBytesValid);
  installReadCounter();
  readCount.clear();
  withDerivationScope(() => {
    loadDocument("rawbyte", "design", dataDir);
    loadDocument("rawbyte", "design", dataDir);
    loadDocument("rawbyte", "design", dataDir);
  });
  uninstallReadCounter();
  ok(readsOf(rawSnapshot) <= 2, `一次派生内多次 loadDocument：同一快照读取被复用（实际 ${readsOf(rawSnapshot)}，最多 2 次=正文+原始字节）`);

  console.log(`\n[6] 源清单复核：一次派生内同一份清单只核一次（含 git 忽略探针）`);
  const manifest = buildSourceManifest(projectRoot, srcFiles.map((f) => ({ path: f.rel, sha256: sha256(f.text) })));
  installReadCounter();
  readCount.clear();
  const v1 = withDerivationScope(() => [
    verifySourceManifest(projectRoot, manifest),
    verifySourceManifest(projectRoot, manifest),
  ]);
  uninstallReadCounter();
  ok(
    srcFiles.every((f) => readsOf(f.abs) === 1),
    `一次派生内复核两次 → 每个源文件只读 1 次（实际 ${srcFiles.map((f) => readsOf(f.abs)).join(",")}）`,
  );
  ok(eq(v1[0], v1[1]), "两次复核结论逐字段一致");
  ok(v1[0] !== v1[1] && v1[0]?.changed !== v1[1]?.changed, "两次复核返回独立对象/独立数组");

  console.log(`\n[6b] 源变化不得被复用掩盖：同尺寸且保留 mtime 也要在**下一次派生**判 invalidated`);
  const changed = srcFiles[3]!;
  const st = fs.statSync(changed.abs);
  const sameSizeText = changed.text.replace(/[0-9]/, (d) => String((Number(d) + 1) % 10)); // 同样长度、内容不同
  fs.writeFileSync(changed.abs, sameSizeText, "utf8");
  fs.utimesSync(changed.abs, st.atime, st.mtime); // 保留 mtime
  const sameSizeOk = fs.statSync(changed.abs).size === Buffer.byteLength(changed.text, "utf8");
  const v2 = withDerivationScope(() => verifySourceManifest(projectRoot, manifest));
  ok(
    sameSizeOk && v2.status === "invalidated" && v2.changed.includes(changed.rel),
    `同尺寸+保留 mtime 的内容变化：下一次派生判 invalidated（${v2.status}；尺寸相等=${sameSizeOk}）`,
  );
  // 作用域内：变化前已核过 → 同一派生仍复用（同一快照语义）
  const withinScope = withDerivationScope(() => {
    const again = verifySourceManifest(projectRoot, manifest);
    return again.status;
  });
  ok(withinScope === "invalidated", "同一份清单在**新派生**里照旧重核（不沿用旧绿）");
  fs.writeFileSync(changed.abs, changed.text, "utf8");
  fs.utimesSync(changed.abs, st.atime, st.mtime);
  const v3 = withDerivationScope(() => verifySourceManifest(projectRoot, manifest));
  ok(v3.status === "valid", "改回原内容后新一次派生判 valid（每次派生现核，不沿用上次）");

  console.log(`\n[6c] 跨项目键：同相对路径的清单/图纸在**不同项目根**下不串味`);
  const twinAFile = path.join(twinARoot, "src", "part0.ts");
  const twinBFile = path.join(twinBRoot, "src", "part0.ts");
  fs.mkdirSync(path.dirname(twinAFile), { recursive: true });
  fs.mkdirSync(path.dirname(twinBFile), { recursive: true });
  const twinAText = "export const part0 = 'A';\n";
  const twinBText = "export const part0 = 'B';\n";
  fs.writeFileSync(twinAFile, twinAText, "utf8");
  fs.writeFileSync(twinBFile, twinBText, "utf8");
  const twinAManifest = buildSourceManifest(twinARoot, [{ path: "src/part0.ts", sha256: sha256(twinAText) }]);
  const twinBManifest = buildSourceManifest(twinBRoot, [{ path: "src/part0.ts", sha256: sha256(twinBText) }]);
  const crossProject = withDerivationScope(() => ({
    a: verifySourceManifest(twinARoot, twinAManifest),
    b: verifySourceManifest(twinBRoot, twinBManifest),
    docA: loadDocument("twina", "plan", dataDir)?.text ?? "",
    docB: loadDocument("twinb", "plan", dataDir)?.text ?? "",
  }));
  ok(
    crossProject.a.status === "valid" && crossProject.b.status === "valid" && crossProject.docA.includes("TWIN-A") && crossProject.docB.includes("TWIN-B"),
    "同相对路径、不同项目根：各读各的、结论各自正确（键含项目根）",
  );

  console.log(`\n[7] 作用域不跨派生：两次派生之间改源，第二次立刻看见（含同尺寸+保留 mtime）`);
  const before = withDerivationScope(() => loadDocument("fx", "plan", dataDir)?.revision.content_sha256 ?? null);
  const planB = writeFixturePlan("B", 60);
  const after = withDerivationScope(() => loadDocument("fx", "plan", dataDir)?.revision.content_sha256 ?? null);
  ok(before === sha256(plan.text) && after === sha256(planB.text) && before !== after, "两次派生之间改图纸源 → 第二次派生的内容哈希立刻变（无 TTL/无陈旧窗口）");
  const seenText = withDerivationScope(() => loadDocument("fx", "plan", dataDir)?.text ?? "");
  ok(seenText.includes("夹具标记：B"), "第二次派生读到的是新正文（不丢源变化）");
  // 同尺寸 + 保留 mtime 的改动：不能用 mtime/size 缓存
  const planBstat = fs.statSync(planB.abs);
  const planCSameSize = planB.text.replace("夹具标记：B", "夹具标记：C"); // 同长度替换
  fs.writeFileSync(planB.abs, planCSameSize, "utf8");
  fs.utimesSync(planB.abs, planBstat.atime, planBstat.mtime);
  const afterSameSize = withDerivationScope(() => loadDocument("fx", "plan", dataDir)?.revision.content_sha256 ?? null);
  ok(
    afterSameSize === sha256(planCSameSize) && afterSameSize !== after,
    "同尺寸+保留 mtime 的内容改动：下一次派生立刻看见（没有全局 stat/mtime 缓存）",
  );

  console.log(`\n[8] 作用域可嵌套、退出（含抛错）即整批丢弃`);
  ok(inDerivationScope() === false, "当前不在派生作用域里");
  const nestedScope = withDerivationScope(() => {
    const outer = withDerivationScope(() => {
      importTaskDefinitions(planCSameSize);
      return derivationScopeStats().entries;
    });
    const inner = derivationScopeStats().entries;
    return { outer, inner };
  });
  ok(nestedScope.outer >= 1 && nestedScope.inner === nestedScope.outer, "嵌套派生复用同一批记忆（内层不新开、不清空）");
  ok(derivationScopeStats().entries === 0 && inDerivationScope() === false, "退出后记忆整批丢弃、作用域不再活跃");

  // 异常路径：最外层抛错也必须整批丢弃
  let threw = false;
  try {
    withDerivationScope(() => {
      importTaskDefinitions(planCSameSize);
      throw new Error("boom");
    });
  } catch {
    threw = true;
  }
  ok(
    threw && inDerivationScope() === false && derivationScopeStats().entries === 0,
    "作用域内抛错：finally 整批丢弃、深度归零（不留半套记忆）",
  );
  // 嵌套内层抛错：外层仍活跃、记忆保留，最外层退出才清
  const innerThrow = withDerivationScope(() => {
    importTaskDefinitions(planCSameSize);
    try {
      withDerivationScope(() => {
        importTaskDefinitions(planCSameSize);
        throw new Error("inner");
      });
    } catch {
      /* 吞掉，模拟外层继续 */
    }
    return { active: inDerivationScope(), entries: derivationScopeStats().entries };
  });
  ok(
    innerThrow.active && innerThrow.entries >= 1 && inDerivationScope() === false && derivationScopeStats().entries === 0,
    "嵌套内层抛错：外层仍活跃、记忆保留；最外层退出才整批丢弃",
  );
} catch (e) {
  fails.push(`夹具/执行异常：${(e as Error).message}`);
  console.log(`  ✗ 夹具/执行异常：${(e as Error).stack}`);
} finally {
  uninstallReadCounter();
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    skips.push(`夹具目录未能删除（${tmpRoot}）`);
  }
}

console.log(`\n[verify] 小结：PASS ${pass}，FAIL ${fails.length}${skips.length > 0 ? `，SKIP ${skips.length}` : ""}`);
if (fails.length > 0) {
  console.log("[verify] FAIL 明细：\n  - " + fails.join("\n  - "));
  process.exitCode = 1;
} else if (skips.length > 0) {
  console.log("[verify] 结果: 全部 PASS（有 SKIP）");
  process.exitCode = 3;
} else {
  console.log("[verify] 结果: 全部 PASS");
}
