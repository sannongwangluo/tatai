// V09-6x 修（2026-10-08）：施工卡「设计依据」里的**外部文档引用**分类修复的独立验证。
//
// 背景（真实现场）：PLAN 的「设计依据」里常引用项目内文档（`docs/loop-closure-20261007.md §2–§4`、
// `docs/agent-optimization-20261006.md §4` 等）。此前 `blueprint.classifyDesignRefToken` 只把
// `AGENTS`／`.工作台/` 当外部文档，`docs/*.md` 一律被当 DESIGN 章节 → `resolveDesignRef` 定位不到 →
// 误报 `unresolved_design_ref` 并阻断交付读数。
//
// 修法（本脚本验证的判据）：分类器新增**存在性注入**——只有「被引用的文档在项目里**实际读到**」才算外部
// 文档（`non_design_ref_external_doc`，信息性、不阻断）；**文件不存在 ⇒ 不认定**，落回 `design_section`，
// 定位不到照旧 `unresolved_design_ref` 报缺并阻断。**不许靠加正则把缺文件一起隐藏**。指名设计书
// （`DESIGN.md`／`设计书`）或施工源（`PLAN.md`）的引用一律继续按章节严格解析。
//
// 2026-10-08 返工（Codex 复审 5 反例全部漏过 → 本脚本补真实正反例并复验）：
//   ① **整词边界**：旧 `EXTERNAL_DOC_PATH_RE` 从 `docs/` 起匹配，会把 `../docs/x.md`、`/docs/x.md`、
//      `D:/docs/x.md` 的前缀静默截掉、当成项目内合法相对路径 ⇒ 现改「从路径词起点起、贪婪取到最后一个
//      已知扩展名 + 左边界定长负向后顾」，安全闸再据**完整原 token** 排除越界/绝对/盘符/上跳。
//   ② **多引用 = 全体满足**：旧 `some` 让「一处存在 + 一处真缺」整条被吞成信息性 external_doc、
//      真缺文件从此不可见；现改 `every`，任一缺文件即整条落 design_section、继续报缺。
//   ③ **权威不可绕过**：`PLAN.md §999 (docs/x.md)` 不得借括号里另一份存在的普通文档被降级；权威
//      `DESIGN.md`/`PLAN.md` 一律继续严格章节解析。
//   ④ **真 realpath 约束**：存在性采集经 `realpathSync` 判定候选仍落在项目根真路径内，symlink/junction
//      逃出项目根的不算项目内来源（不把外部文件当项目内文档）。
//
// 四段：
//   A. 纯分类器正反例（deterministic，零 fs；含整词边界／多引用／权威绕过）；
//   B. 隔离夹具项目：`readBlueprintSources`（真实读盘采集存在性）→ `deriveBlueprint` 全链正反例；
//   C. 真实仓库只读复算：既有文档不再误报、缺文件继续阻断（**只读**：`readBlueprintSources` 不落盘；
//      用隔离 `TATAI_HOME` 登记，不碰生产注册表与运行数据）；
//   D. 真 realpath 约束：目录 junction/symlink 指向项目外 ⇒ 该引用不得进入存在性清单。
//
// 退出码：1 = 有 FAIL；0 = 全 PASS。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { addProject } from "../src/server/registry";
import {
  blueprintCacheKeysOf,
  classifyDesignRefToken,
  deriveBlueprint,
  externalDocPathsIn,
  readBlueprintSources,
} from "../src/arch/blueprint";
import { ensureSelfRegistered } from "./lib/fixtures";

let pass = 0;
const fails: string[] = [];
const ok = (cond: boolean, label: string): void => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (cond) pass += 1;
  else {
    fails.push(label);
    process.exitCode = 1;
  }
};
const info = (m: string): void => console.log(`[verify]   ${m}`);
const section = (t: string): void => console.log(`\n[verify] ── ${t}`);

const unresolvedDetails = (bp: ReturnType<typeof deriveBlueprint>): string[] =>
  bp.omitted.filter((o) => o.kind === "unresolved_design_ref").map((o) => o.detail);

// ───────────────────────── A. 纯分类器（正反例，零 fs） ─────────────────────────
function partA(): void {
  section("A. 分类器正反例（存在性注入；缺失文件不得被隐藏）");
  const exists = (...present: string[]) => (p: string) => present.includes(p);

  ok(
    externalDocPathsIn("`docs/loop-closure-20261007.md` §2–§4").join(",") === "docs/loop-closure-20261007.md" &&
      externalDocPathsIn("docs/sync-evidence-contract.md「必需验收」").join(",") === "docs/sync-evidence-contract.md" &&
      externalDocPathsIn("`replay/FINAL-REPORT.md` §8（真实剖析）").join(",") === "replay/FINAL-REPORT.md",
    "路径抽取：反引号/引号/§语法包裹的文档路径都能取出（docs/*.md、多段路径、根级文件名）",
  );

  ok(
    classifyDesignRefToken("docs/loop-closure-20261007.md", exists("docs/loop-closure-20261007.md")) ===
      "non_design_ref_external_doc" &&
      classifyDesignRefToken("`docs/loop-closure-20261007.md` §2–§4", exists("docs/loop-closure-20261007.md")) ===
        "non_design_ref_external_doc" &&
      classifyDesignRefToken("docs/agent-optimization-20261006.md §4", exists("docs/agent-optimization-20261006.md")) ===
        "non_design_ref_external_doc",
    "正例：**实际存在**的项目文档引用判为外部文档（含带 § 章节的写法）",
  );

  ok(
    classifyDesignRefToken("docs/ghost.md", exists("docs/real.md")) === "design_section" &&
      classifyDesignRefToken("replay/FINAL-REPORT.md §8", exists("docs/real.md")) === "design_section" &&
      classifyDesignRefToken("IMPLEMENTATION-PLAN.md", exists("docs/real.md")) === "design_section",
    "反例（本修的红线）：**不存在的文件**不判外部文档、落回 design_section ⇒ 定位不到继续报缺阻断（不靠正则隐藏缺文件）",
  );

  ok(
    classifyDesignRefToken("DESIGN.md §2.6", () => true) === "design_section" &&
      classifyDesignRefToken("DESIGN §2.6（见 docs/loop-closure-20261007.md）", () => true) === "design_section" &&
      classifyDesignRefToken("PLAN.md", () => true) === "design_section" &&
      classifyDesignRefToken("设计书 §3.5", () => true) === "design_section",
    "权威图纸源：指名 DESIGN.md／设计书／PLAN.md 的引用即使文件存在也**不降为外部文档**，继续按章节严格解析",
  );

  // ── 2026-10-08 返工：Codex 复审 5 反例（此前全部漏过）──
  ok(
    externalDocPathsIn("../docs/exists.md").length === 0 &&
      externalDocPathsIn("D:/docs/exists.md").length === 0 &&
      externalDocPathsIn("/docs/exists.md").length === 0 &&
      externalDocPathsIn("..\\docs\\exists.md").length === 0 &&
      externalDocPathsIn("docs/../secret.md").length === 0 &&
      externalDocPathsIn("http://x.com/a.md").length === 0 &&
      externalDocPathsIn("./docs/exists.md").join(",") === "docs/exists.md" &&
      externalDocPathsIn("`docs/loop-closure-20261007.md` §2–§4").join(",") === "docs/loop-closure-20261007.md",
    "整词边界：`../docs/x.md`／`D:/docs/x.md`／`/docs/x.md`／`..\\docs\\x.md`／`docs/../secret.md`／URL 不得被截成合法后缀 `docs/x.md`（完整原 token 判据）；`./docs/x.md` 仍正常取 `docs/x.md`",
  );
  ok(
    classifyDesignRefToken("../docs/exists.md", exists("docs/exists.md")) === "design_section" &&
      classifyDesignRefToken("D:/docs/exists.md", exists("docs/exists.md")) === "design_section" &&
      classifyDesignRefToken("/docs/exists.md", exists("docs/exists.md")) === "design_section" &&
      classifyDesignRefToken("..\\docs\\exists.md", exists("docs/exists.md")) === "design_section",
    "整词边界（分类）：越界/绝对/盘符路径即便其**同名后缀**文件实际存在，也不得判为项目内外部文档",
  );
  ok(
    externalDocPathsIn("docs/exists.md + docs/missing.md").join(",") === "docs/exists.md,docs/missing.md" &&
      classifyDesignRefToken("docs/exists.md + docs/missing.md", exists("docs/exists.md")) === "design_section",
    "多引用红线：`docs/exists.md + docs/missing.md` 有一处真缺 ⇒ 整条落 design_section（真缺文件不被 some 吞掉、继续报缺）",
  );
  ok(
    ["../missing.md", "/missing.md", "D:/missing.md", "https://host/missing.md"].every((bad) =>
      classifyDesignRefToken(`docs/exists.md + ${bad}`, exists("docs/exists.md")) === "design_section"),
    "合法引用与非法路径混合时，非法项不被预过滤后借另一存在文件放行",
  );
  ok(
    classifyDesignRefToken("docs/a.md + docs/b.md", exists("docs/a.md", "docs/b.md")) ===
      "non_design_ref_external_doc" &&
      classifyDesignRefToken("docs/a.md", exists("docs/a.md")) === "non_design_ref_external_doc",
    "多引用正例：引用**全部存在**且非权威 ⇒ 判为外部文档（every 的正面，未误伤既有存在文档识别）",
  );
  ok(
    classifyDesignRefToken(
      "PLAN.md §999 (docs/exists.md)",
      exists("docs/exists.md", "PLAN.md"),
    ) === "design_section" &&
      classifyDesignRefToken(
        "DESIGN.md §2.6（见 docs/exists.md）",
        exists("docs/exists.md", "DESIGN.md"),
      ) === "design_section",
    "权威绕过红线：`PLAN.md §999 (docs/exists.md)`／`DESIGN.md …（见 docs/exists.md）` 不得因括号里另一份**存在**的普通文档而降为外部追溯（权威 DESIGN/PLAN 继续严格章节解析）",
  );

  ok(
    classifyDesignRefToken("需求＝`req-2099-01-01-r1`（已登记）") === "non_design_ref_requirement" &&
      classifyDesignRefToken("报告 02 G-04／G-05") === "non_design_ref_report" &&
      classifyDesignRefToken("AGENTS §1（迁移前人工对齐）") === "non_design_ref_external_doc" &&
      classifyDesignRefToken("裁定稿本＝`.工作台/handoff/x.md`（") === "non_design_ref_external_doc" &&
      classifyDesignRefToken("§4.2") === "design_section" &&
      classifyDesignRefToken("附录 D") === "design_section",
    "既有语义不变：需求 ID／报告／AGENTS·存档稿本；§ 与附录形态仍按设计章节解析",
  );

  ok(
    classifyDesignRefToken("docs/loop-closure-20261007.md") === "design_section" &&
      classifyDesignRefToken("docs/loop-closure-20261007.md", undefined) === "design_section",
    "兼容：缺省/未注入存在性（纯文本派生、历史重建、旧调用点）时，文档路径仍按旧口径落 design_section",
  );
}

// ───────────────────────── B. 隔离夹具项目全链 ─────────────────────────
const FIXTURE_DESIGN = `# 夹具设计书

## 1. 夹具能力

### 1.1 甲能力

正文甲。

## 附录 D

附录 D 正文。
`;

const FIXTURE_PLAN = `# 夹具施工图

| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |
| --- | --- | --- | --- | --- |
| T-1 | todo | 存在的外部文档引用 | 无 | 跑完 |
| T-2 | todo | 缺失文件与未知章节 | 无 | 跑完 |
| T-3 | todo | 非设计引用类别 | 无 | 跑完 |
| T-4 | todo | 混合多引用（一处存在一处缺失） | 无 | 跑完 |
| T-5 | todo | 权威施工源不得被绕过 | 无 | 跑完 |

### T-1 存在的外部文档引用

**设计依据**：\`docs/real-contract.md\`、\`docs/real-contract.md\` §3、\`docs/real-contract.md\` §2–§4、DESIGN §1.1、§1.1。

### T-2 缺失文件与未知章节

**设计依据**：\`replay/MISSING-REPORT.md\` §8、docs/ghost-doc.md、IMPLEMENTATION-PLAN.md、§9.9。

### T-3 非设计引用类别

**设计依据**：AGENTS §1、需求＝\`req-2099-01-01-r1\`、报告 02 G-04。

### T-4 混合多引用（一处存在一处缺失）

**设计依据**：docs/real-contract.md + docs/ghost-doc.md。

### T-5 权威施工源不得被绕过

**设计依据**：PLAN.md §999（见 docs/real-contract.md）。
`;

function partB(): void {
  section("B. 隔离夹具项目：readBlueprintSources（真实读盘）→ deriveBlueprint 全链正反例");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-dref-"));
  const home = path.join(tmp, "home");
  const root = path.join(tmp, "proj");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(root, ".工作台"), { recursive: true });
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, ".工作台", "design.md"), FIXTURE_DESIGN, "utf8");
  fs.writeFileSync(path.join(root, ".工作台", "plan.md"), FIXTURE_PLAN, "utf8");
  fs.writeFileSync(path.join(root, "docs", "real-contract.md"), "# 真契约\n\n## 3 甲\n\n## 4 乙\n", "utf8");
  // 根级权威施工源占位（存在！用于证明「权威 PLAN.md 不被另一份存在文档绕过」，而非靠文件缺失）
  fs.writeFileSync(path.join(root, "PLAN.md"), "# 夹具根级施工源（权威占位）\n", "utf8");
  // 注意：故意**不**创建 replay/MISSING-REPORT.md、docs/ghost-doc.md、IMPLEMENTATION-PLAN.md
  addProject({ id: "dref-fixture", name: "外部文档夹具", path: root, kind: "fullstack" }, home);

  const src = readBlueprintSources("dref-fixture", home);
  const inv = src.external_doc_paths ?? null;
  ok(
    inv !== null &&
      inv.includes("docs/real-contract.md") &&
      !inv.includes("docs/ghost-doc.md") &&
      !inv.includes("replay/MISSING-REPORT.md") &&
      !inv.includes("IMPLEMENTATION-PLAN.md"),
    `存在性采集：只登记**实际读到**的文档（${JSON.stringify(inv)}）；缺失文件不进清单`,
  );

  const bp = deriveBlueprint(src, { based_on: blueprintCacheKeysOf(src, false) });
  const unresolved = unresolvedDetails(bp);

  ok(
    bp.omitted.some((o) => o.kind === "non_design_ref_external_doc" && o.detail.includes("docs/real-contract.md")),
    "正例：存在的文档引用（T-1）登记为信息性 external_doc（不阻断）",
  );
  ok(
    unresolved.some((d) => d.includes("T-2") && d.includes("replay/MISSING-REPORT.md")) &&
      unresolved.some((d) => d.includes("docs/ghost-doc.md")) &&
      unresolved.some((d) => d.includes("IMPLEMENTATION-PLAN.md")) &&
      unresolved.some((d) => d.includes("§9.9")),
    `反例保留：缺文件（replay/MISSING-REPORT.md／docs/ghost-doc.md／IMPLEMENTATION-PLAN.md）与未知章节（§9.9）仍 unresolved_design_ref 报缺阻断（${unresolved.length} 条）`,
  );
  ok(
    unresolved.some((d) => d.includes("T-4") && d.includes("docs/real-contract.md + docs/ghost-doc.md")) &&
      !bp.omitted.some((o) => o.kind === "non_design_ref_external_doc" && o.detail.includes("docs/ghost-doc.md")),
    "多引用红线（全链）：混合 token（一处存在一处缺失）因真缺而落 design_section、继续 unresolved（不被登记为信息性 external_doc）",
  );
  ok(
    unresolved.some((d) => d.includes("T-5") && d.includes("PLAN.md §999")) &&
      !bp.omitted.some((o) => o.kind === "non_design_ref_external_doc" && o.detail.includes("PLAN.md")),
    "权威绕过红线（全链）：指名 PLAN.md 的引用即使括号里另一份文档**存在**，也不降为 external_doc，继续 unresolved 报缺（权威施工源严格章节解析）",
  );
  // 红线（2026-10-08 返工更新为「全体」口径）：**全部引用都存在且非权威**的 token 才可判 external_doc；
  // 只要有一条 unresolved 是「全体存在且非权威」，那才是误报（应为 external_doc）。混合/权威引用落
  // unresolved 属**正确**报缺，不再计入误报（旧 `.includes("docs/real-contract.md")` 口径会把混合 token
  // 误判为误报——它确实提到存在文档，但不是「纯存在文档」）。
  const invSet = new Set(inv ?? []);
  const authoritative = (p: string): boolean => {
    const base = (p.split("/").pop() ?? "").toLowerCase();
    return base === "design.md" || base === "plan.md";
  };
  const misreported = unresolved.filter((d) => {
    const t = (d.match(/设计依据「([^」]*)」/) ?? [])[1] ?? "";
    const ps = externalDocPathsIn(t);
    return ps.length > 0 && ps.every((p) => invSet.has(p) && !authoritative(p));
  });
  ok(
    misreported.length === 0,
    `红线：**全体引用都存在且非权威**的 token 一条都不进 unresolved_design_ref（纯存在文档不误报；${misreported.length} 条）`,
  );
  ok(
    bp.omitted.some((o) => o.kind === "non_design_ref_requirement" && o.detail.includes("req-2099-01-01-r1")) &&
      bp.omitted.some((o) => o.kind === "non_design_ref_report" && o.detail.includes("报告 02 G-04")) &&
      bp.omitted.some((o) => o.kind === "non_design_ref_external_doc" && o.detail.includes("AGENTS")),
    "非设计引用类别（需求 ID／报告／AGENTS）按真实类别登记，不按设计章节解析",
  );
  const t1DesignEdges = bp.edges.filter((e) => e.source === "plan:task:T-1" && e.kind === "task_design_ref");
  ok(
    t1DesignEdges.length === 1 && t1DesignEdges[0]?.target === "plan:cap:01",
    `正例：真实设计章节引用（DESIGN §1.1／§1.1，同一能力去重）仍正常产生 task_design_ref 边（${t1DesignEdges.length} 条 → ${t1DesignEdges[0]?.target ?? "无"}）`,
  );
  ok(
    !bp.edges.some((e) => e.source === "plan:task:T-1" && e.kind === "task_design_ref" && e.target.includes("docs")),
    "外部文档引用不产生能力边（不是设计章节）",
  );

  fs.rmSync(tmp, { recursive: true, force: true });
}

// ───────────────────────── C. 真实仓库只读复算 ─────────────────────────
function partC(): void {
  section("C. 真实仓库只读复算（隔离 TATAI_HOME，不碰生产注册表/运行数据）");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-dref-real-"));
  try {
    ensureSelfRegistered(home);
    const src = readBlueprintSources("tatai", home);
    const inv = src.external_doc_paths ?? null;
    const existsDoc = "docs/loop-closure-20261007.md";
    ok(
      inv !== null && inv.includes(existsDoc),
      `真实仓库存在性采集：${existsDoc} 等既有文档被读到（共 ${inv?.length ?? 0} 条：${JSON.stringify(inv)}）`,
    );
    ok(
      inv !== null && !inv.includes("replay/FINAL-REPORT.md") && !inv.includes("IMPLEMENTATION-PLAN.md"),
      "真实仓库缺文件（replay/FINAL-REPORT.md／IMPLEMENTATION-PLAN.md）未被登记为存在",
    );
    const bp = deriveBlueprint(src, { based_on: blueprintCacheKeysOf(src, false) });
    const unresolved = unresolvedDetails(bp);
    const unresolvedTokens = unresolved.map((d) => (d.match(/设计依据「([^」]*)」/) ?? [])[1] ?? "");
    const isAuthoritative = (p: string): boolean => {
      const base = (p.split("/").pop() ?? "").toLowerCase();
      return base === "design.md" || base === "plan.md";
    };
    // 红线（不变式，2026-10-08 返工更新为「全体」口径）：一条 unresolved 依据**不得**是「**全部**引用
    // 都存在且非权威」——那种本该被分类为信息性 external_doc。混合引用（一处存在、一处真缺）落
    // unresolved 是**正确**行为，不再计入泄漏（旧 `.some` 口径会把这类正确报缺误判成泄漏）。
    const leaked = unresolvedTokens.filter((t) => {
      const ps = externalDocPathsIn(t);
      return ps.length > 0 && ps.every((p) => (inv ?? []).includes(p) && !isAuthoritative(p));
    });
    ok(leaked.length === 0, `红线不变式：unresolved 依据里 0 条是「全部引用都存在且非权威」（本该 external_doc；泄漏 ${leaked.length} 条）`);
    // 交叉核对（非门禁）：unresolved 里确有引用到**部分**存在文档的混合/权威 token 时，属**正确**报缺——
    // 只如实打印计数，供人工核对（不把它当 FAIL，也不据此放宽）。
    const mixedOrAuthoritative = unresolvedTokens.filter((t) => {
      const ps = externalDocPathsIn(t);
      if (ps.length === 0) return false;
      return ps.some((p) => (inv ?? []).includes(p)) && !ps.every((p) => (inv ?? []).includes(p) && !isAuthoritative(p));
    });
    info(`unresolved 中混合/权威引用（引用到部分存在文档）如实保留：${mixedOrAuthoritative.length} 条`);
    ok(
      bp.omitted.some((o) => o.kind === "non_design_ref_external_doc" && o.detail.includes("docs/")),
      "真实仓库：既有 docs 文档引用已登记为 external_doc（不再误报）",
    );
    info(`真实仓库 unresolved_design_ref 剩余 ${unresolved.length} 条（应＝缺文件＋未知/散文式依据）：`);
    for (const t of unresolvedTokens) info(`  · ${t}`);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// ───────────────────────── D. 真 realpath 约束（symlink/junction 逃出项目根） ─────────────────────────
function partD(): void {
  section("D. 真 realpath 约束：symlink/junction 逃出项目根不得算项目内来源");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-dref-link-"));
  const home = path.join(tmp, "home");
  const root = path.join(tmp, "proj");
  const outside = path.join(tmp, "outside");
  try {
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(path.join(root, ".工作台"), { recursive: true });
    fs.mkdirSync(path.join(root, "docs"), { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(root, ".工作台", "design.md"), FIXTURE_DESIGN, "utf8");
    fs.writeFileSync(path.join(outside, "secret.md"), "# 项目外文件（不得当项目内来源）\n", "utf8");
    fs.writeFileSync(path.join(root, "docs", "inside.md"), "# 项目内真文件\n", "utf8");

    // 目录 junction/symlink：root/docs/escape → <项目外> outside
    const dirLink = path.join(root, "docs", "escape");
    let dirLinkKind: string | null = null;
    try {
      fs.symlinkSync(outside, dirLink, "junction");
      dirLinkKind = "junction(目录)";
    } catch {
      try {
        fs.symlinkSync(outside, dirLink, "dir");
        dirLinkKind = "symlink(目录)";
      } catch {
        dirLinkKind = null;
      }
    }
    // 文件 symlink（权限允许时一并测）：root/docs/flink.md → outside/secret.md
    const fileLinkPath = path.join(root, "docs", "flink.md");
    let fileLink = false;
    try {
      fs.symlinkSync(path.join(outside, "secret.md"), fileLinkPath);
      fileLink = true;
    } catch {
      fileLink = false;
    }

    const refs = [
      "docs/inside.md",
      ...(dirLinkKind !== null ? ["docs/escape/secret.md"] : []),
      ...(fileLink ? ["docs/flink.md"] : []),
    ];
    const plan =
      "# 夹具施工图\n\n| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |\n| --- | --- | --- | --- | --- |\n" +
      "| L-1 | todo | 链接逃逸 | 无 | 跑完 |\n\n### L-1 链接逃逸\n\n**设计依据**：" +
      `${refs.join("、")}。\n`;
    fs.writeFileSync(path.join(root, ".工作台", "plan.md"), plan, "utf8");
    addProject({ id: "dref-link-fixture", name: "软链夹具", path: root, kind: "fullstack" }, home);

    const src = readBlueprintSources("dref-link-fixture", home);
    const inv = src.external_doc_paths ?? [];
    ok(inv.includes("docs/inside.md"), `对照正例：项目内**真文件** docs/inside.md 正常登记（${JSON.stringify(inv)}）`);
    if (dirLinkKind !== null) {
      ok(
        !inv.includes("docs/escape/secret.md"),
        `逃逸红线：经 ${dirLinkKind} \`docs/escape\` 指向项目外的 docs/escape/secret.md **未**被当项目内来源`,
      );
      ok(
        classifyDesignRefToken("docs/escape/secret.md", (p) => inv.includes(p)) === "design_section",
        "逃逸红线（分类）：逃逸路径不计入存在性 ⇒ 该引用落 design_section、不被当外部文档隐藏",
      );
      let statSawFile = false;
      try {
        statSawFile = fs.statSync(path.join(root, "docs", "escape", "secret.md")).isFile();
      } catch {
        statSawFile = false;
      }
      ok(
        statSawFile,
        "旁证：docs/escape/secret.md 经 junction 能被 stat 到是文件（故拒绝理由确为 realpath 越界，而非「文件不存在」）",
      );
    } else {
      info("本机不支持创建目录 junction/symlink（EPERM）——目录逃逸用例跳过（非 FAIL，如实标注）");
    }
    if (fileLink) {
      ok(!inv.includes("docs/flink.md"), "逃逸红线：文件 symlink docs/flink.md 指向项目外**未**被登记");
    } else {
      info("本机不支持创建文件 symlink（EPERM）——文件软链用例跳过（非 FAIL）；目录 junction 用例已覆盖同一 realpath 判据");
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

partA();
partB();
partC();
partD();

console.log(`\n[verify] verify-external-design-refs：PASS ${pass} / FAIL ${fails.length}`);
if (fails.length > 0) {
  console.log("[verify] 存在 FAIL");
  process.exit(1);
}
console.log("[verify] 全部 PASS");
