// P1 / V09-46 定向行为验证：接续材料按任务精确取材（docs/agent-optimization-20261006.md §5，
// coordinator-decisions.md P1 纠正优先）。
//
// 覆盖（先红后绿）：
//   A 严格解析入口（src/shared/designRefStrict.ts，纯函数）
//     A1 逐个显式编号：单个/多个（§2.6/§2.7）/范围（§2.6–§2.9 必须含全部中间成员，不能只取首尾）
//     A2 唯一精确匹配：缺失=missing、重名/祖先链重复=ambiguous，都不选第一个
//     A3 范围不能证明完整展开（成员缺一个 / 前后前缀不同）⇒ 整条 unresolved，不取首个命中
//     A4 附录不降级：附录 E.9 缺失子节必须 unresolved，**不得**回落到“附录 E”大标题；
//        只有 token 本身只给字母（附录 E）才命中大标题 —— 那是显式目标
//     A5 围栏感知：围栏里的 `## 9.9 假节` 不是章节，§9.9 必须 missing
//     A6 旧判据一字不改：resolveDesignRef 仍 first-match / 仍降父节（对照，证明并存且用途分开）
//     A7 非章节类 token（需求 ID／报告／AGENTS／外部 .md／.工作台/）不进章节解析
//   B 入口 required_reads 集成（evaluateProjectEntry，只读）
//     B1 多引用逐条：§2.6–§2.9 → 4 条（path+section+派生 range），不整篇读取
//     B2 去重与不丢段：同文件多段必读都在；unresolved 无 section 的条目按 source_ref 去重，两条失败引用都在
//     B3 unresolved 语义：缺引用/歧义/围栏伪标题 ⇒ unresolved + 原始引用 source_ref + 补取去向
//     B4 purpose 分类：卡区/解析到的章节=required_content；整份设计书在有解析引用时=trace_reference，
//        无解析引用时=required_content；基线/账本=trace_reference；续接现场/同步证据=resume_context
//     B5 整份设计书入口始终保留
//     B6 章节外改动 ⇒ 定位与哈希不变；前节插入行 ⇒ range 现算平移；章节内改动 ⇒ 该条哈希变化（须重取）
//     B7 兼容与不变量：旧字段语义不变；“有 section ⟺ revision 是该章节子树哈希”
//     B8 恢复上下文：现有 run/workspace/checkpoint 指针明确；心跳缺失/无执行回执**不**断言进程已停
//     B9 只读红线：events.jsonl 逐字节不变、无 task.claimed、无新业务事件
//   C P1 复核返工（`P1-coordinator-review.md` 第 1–6 条）
//     C1 严格编号边界：`2.6abc`／`2.60`／`E.5x` 不被当近似标题命中（`§2.6`／`附录 E.5` 仍唯一命中真节）
//     C2 超大数字有限终止：安全整数外/负值的编号与范围 ⇒ malformed，且**在带硬超时的子进程内**验证，主进程绝不被挂住
//     C3 显式 § 右端不当条目：`§2.6–§3` ⇒ unresolved（malformed）；只有「连字符族＋右端不带 §＋层级更浅」才是条目语法
//     C4 附录连字符条目与真实章节语法区分：存在 `G-2` 标题 ⇒ 命中它而**不退**「附录 G」；不存在才落回
//     C5 混合引用：`DESIGN §2.6（见 docs/foo.md）` 保留明确设计节；`docs/…md §5` 仍作外部追溯
//     C6 完整标题路径：整条路径/末级标题唯一精确匹配；认不出的设计引用 ⇒ unresolved（不当外部追溯而少读）
//     C7 最强必读合并：任务节引用＋阶段整文件、任务卡范围＋阶段完整 PLAN ⇒ 保留更强 purpose 与完整范围＋全部理由
//     C8（集成复核第 1 条）输入 token 合法边界：非法后缀（§2.6abc／附录 E.5x／范围尾随后缀）不得截短命中已知节 ⇒ unresolved
//     C9（集成复核第 2 条）未知完整标题路径/未知依据进设计解析（⇒ unresolved），只有机械明确外部才 trace；同卡两类都在
//     C10（集成修正同因组合反例）合法子目标不得使含非法显式编号的整条引用被错判 resolved：`§2.6 / §2.9abc`、
//         `§2.6 – §2.9abc`（分隔符前空格）、`附录 E.5 / 附录 E.6x` 整条 unresolved 且非法项逐条报出；合法组合不误伤
//     C11（最终集成裸续列收口）**已支持语法**（裸续列）下的未知子目标必须显式 unresolved：`附录 E.5、E.7x`
//         的非法续列项 `E.7x`（无 `附录` 前缀）逐条报出，合法 `E.5` 不得把它掩盖成整条 resolved；合法裸续列
//         （`附录 E.5、E.6`）与正文英文单词（`附录 E.5 见 Excel 表`）不误伤
//
// 用法（绝对路径，禁用 pnpm exec / pnpm install）：
//   D:/tatai/node_modules/.bin/tsx.cmd scripts/verify-agent-materials.ts
// 夹具走 os.tmpdir() 的临时 TATAI_HOME + 临时项目根，收尾清理；不碰任何真实项目/.工作台。
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseMarkdownSections, findSection, findSectionInParsed, markdownSectionDigest, type MarkdownSectionNode } from "../src/shared/materialSection";
import { resolveDesignRef } from "../src/shared/designRef";
import {
  resolveDesignRefStrict,
  hasDesignSectionSyntax,
  isDesignRefToken,
  namesDesignBook,
  type StrictRefTarget,
} from "../src/shared/designRefStrict";
import { evaluateProjectEntry, type ProjectEntry, type RequiredRead } from "../src/server/work/entry";
import { addProject } from "../src/server/registry";
import { projectWorkDir } from "../src/server/workstation";
import { activateBaseline } from "../src/server/work/documents";
import { importTaskDefinitions } from "../src/server/work/plan";
import { WorkService } from "../src/server/work/service";
import { readTaskStates, submitDefinitionImports } from "../src/server/work/tasks";
import { claimTask } from "../src/server/work/claims";
import { saveCheckpoint, type ResumeCheckpoint } from "../src/server/work/context";

// ── 断言与日志 ──
let passCount = 0;
const fails: string[] = [];
function ok(cond: boolean, label: string, detail?: unknown): void {
  if (cond) {
    passCount += 1;
    console.log(`[verify] PASS ${label}`);
  } else {
    fails.push(label);
    console.log(`[verify] FAIL ${label}`);
    if (detail !== undefined) console.log(`[verify]   现场：${JSON.stringify(detail).slice(0, 1600)}`);
  }
}
const info = (m: string): void => console.log(`[verify] ${m}`);
const sha256 = (d: string | Buffer): string => crypto.createHash("sha256").update(d).digest("hex");
const SELF_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SELF_PATH), "..");

// ── 夹具设计书（固定行号，章节判据按硬编码期望钉死） ──
const D1_LINES = [
  "# AM 设计书", // 1
  "", // 2
  "## 1 概述", // 3
  "", // 4
  "概述正文。", // 5
  "", // 6
  "## 2 核心", // 7
  "", // 8
  "核心正文。", // 9
  "", // 10
  "### 2.6 甲", // 11
  "", // 12
  "甲正文。", // 13
  "", // 14
  "### 2.7 乙", // 15
  "", // 16
  "乙正文。", // 17
  "", // 18
  "### 2.8 丙", // 19
  "", // 20
  "丙正文。", // 21
  "", // 22
  "### 2.9 丁", // 23
  "", // 24
  "丁正文。", // 25
  "", // 26
  "## 附录 E：现行边界", // 27
  "", // 28
  "### E.5 六图", // 29
  "", // 30
  "六图正文。", // 31
  "", // 32
  "### E.6 一并一源", // 33
  "", // 34
  "一并一源正文。", // 35
  "", // 36
  "## 9 末章", // 37
  "", // 38
  "```markdown", // 39
  "## 9.9 围栏假节", // 40
  "```", // 41
  "", // 42
  "## 12 遗留风险", // 43
  "", // 44
  "### 12.1 已决与待决", // 45
  "", // 46
  "已决正文。", // 47
  "", // 48
  "### 12.2 必须防住", // 49
  "", // 50
  "防住正文。", // 51
];
const D1 = D1_LINES.join("\n");
/** 重名标题夹具：2.8 出现两次（同名同级）→ 无法唯一定位 */
const D2_LINES = [
  "# AM 设计书",
  "",
  "## 2 核心",
  "",
  "核心正文。",
  "",
  "### 2.8 丙",
  "",
  "丙正文。",
  "",
  "### 2.8 丙",
  "",
  "丙二号正文。",
];
const D2 = D2_LINES.join("\n");
/** 边界/附录连字符夹具（P1 复核 C1/C3/C4）：近似标题（2.6abc/2.60/E.5x）、附录连字符标题（G-2）、附录条目子号（C.5-1） */
const D3_LINES = [
  "# AM 边界书", // 1
  "", // 2
  "## 2 核心", // 3
  "", // 4
  "### 2.6 甲", // 5
  "", // 6
  "### 2.6abc 假节", // 7
  "", // 8
  "### 2.60 假节", // 9
  "", // 10
  "## 12 遗留风险", // 11
  "", // 12
  "### 12.1 已决与待决", // 13
  "", // 14
  "## 附录 C：收尾", // 15
  "", // 16
  "### C.5 v0.7 轮", // 17
  "", // 18
  "## 附录 E：现行边界", // 19
  "", // 20
  "### E.5 六图", // 21
  "", // 22
  "### E.5x 假节", // 23
  "", // 24
  "## 附录 G：修订记录", // 25
  "", // 26
  "### G-2 本轮未做的事", // 27
  "", // 28
];
const D3 = D3_LINES.join("\n");

const parsed1 = parseMarkdownSections(D1);
const sections1: MarkdownSectionNode[] = parsed1.ok ? parsed1.sections : [];
const parsed3 = parseMarkdownSections(D3);
const sections3: MarkdownSectionNode[] = parsed3.ok ? parsed3.sections : [];
const strict = (tok: string, sections: MarkdownSectionNode[] = sections1) => resolveDesignRefStrict(tok, sections);
const resolvedPaths = (targets: StrictRefTarget[]): string[] =>
  targets.filter((t): t is Extract<StrictRefTarget, { resolution: "resolved" }> => t.resolution === "resolved").map((t) => t.path);
const unresolvedReasonOf = (targets: StrictRefTarget[]): string | null => {
  const t = targets[0];
  return t !== undefined && t.resolution === "unresolved" ? t.reason : null;
};

// ── A1/A2/A3/A4/A5/A6/A7：严格解析入口 ──
function scenarioStrictResolver(): void {
  info("── A 严格解析入口（designRefStrict） ──");
  ok(parsed1.ok, "A0 夹具设计书解析成功");

  // A1 单个
  const one = strict("§2.7");
  ok(
    one.resolution === "resolved" && resolvedPaths(one.targets).join(",") === "AM 设计书 / 2 核心 / 2.7 乙",
    "A1 单个编号 §2.7 唯一精确命中（完整标题路径）",
    one,
  );

  // A1 多个（/ 连接）
  const multi = strict("§2.6/§2.7");
  ok(
    multi.resolution === "resolved" && multi.targets.length === 2 && resolvedPaths(multi.targets).join(",") ===
      "AM 设计书 / 2 核心 / 2.6 甲,AM 设计书 / 2 核心 / 2.7 乙",
    "A1 多编号 §2.6/§2.7 逐条解析（不是只取第一个）",
    multi,
  );

  // A1 范围：必须含全部中间成员
  const range = strict("§2.6–§2.9");
  ok(
    range.resolution === "resolved" &&
      range.targets.length === 4 &&
      resolvedPaths(range.targets).join(",") ===
        "AM 设计书 / 2 核心 / 2.6 甲,AM 设计书 / 2 核心 / 2.7 乙,AM 设计书 / 2 核心 / 2.8 丙,AM 设计书 / 2 核心 / 2.9 丁",
    "A1 范围 §2.6–§2.9 含全部中间成员 2.7/2.8（旧 first-match 只给 2.6）",
    range,
  );
  const r27 = range.targets.find((t) => t.resolution === "resolved" && t.path.endsWith("2.7 乙"));
  ok(
    r27 !== undefined && r27.resolution === "resolved" && r27.line_start === 15 && r27.line_end === 18 && r27.sha256 === sha256(D1_LINES.slice(14, 18).join("\n")),
    "A1 范围成员带当前版本路径+行范围+子树哈希（2.7 = 行 15–18）",
    r27,
  );

  // A3 范围不能证明完整展开：成员缺一个 ⇒ 整条 unresolved
  const gapRange = strict("§2.6–§2.11");
  ok(
    gapRange.resolution === "unresolved" &&
      gapRange.targets.length === 1 &&
      unresolvedReasonOf(gapRange.targets) === "missing",
    "A3 范围有缺成员（2.10/2.11 不存在）⇒ 整条 unresolved，不静默只取首尾",
    gapRange,
  );
  const badRange = strict("§2.6–§12.9");
  ok(
    badRange.resolution === "unresolved" && badRange.targets.length === 1 && unresolvedReasonOf(badRange.targets) === "malformed",
    "A3 范围前后前缀不同（2.x–12.x）无法证明完整展开 ⇒ malformed，不猜",
    badRange,
  );

  // A5 围栏：围栏里的伪标题不成节
  ok(!sections1.some((s) => s.title.includes("围栏假节")), "A5 围栏里的 `## 9.9 围栏假节` 没有被解析成章节");
  const fenced = strict("§9.9");
  ok(
    fenced.resolution === "unresolved" && fenced.targets.length === 1 && unresolvedReasonOf(fenced.targets) === "missing",
    "A5 引用围栏里的伪标题 ⇒ missing（围栏感知，不误配）",
    fenced,
  );

  // A2 重名 ⇒ ambiguous（不选第一个）
  const dupParsed = parseMarkdownSections(D2);
  const dupSecs: MarkdownSectionNode[] = dupParsed.ok ? dupParsed.sections : [];
  const dup = resolveDesignRefStrict("§2.8", dupSecs);
  ok(
    dup.resolution === "unresolved" && dup.targets.length === 1 && unresolvedReasonOf(dup.targets) === "ambiguous",
    "A2 同名同级重复 ⇒ ambiguous（不选第一个）",
    dup,
  );
  const dupGated = findSectionInParsed(dupSecs, "AM 设计书 / 2 核心 / 2.8 丙");
  ok(dupGated.ok === false && dupGated.kind === "duplicate", "A2 唯一性闸：完整标题路径重复 ⇒ duplicate", dupGated);

  // A4 附录不降级
  const app5 = strict("附录 E.5");
  ok(
    app5.resolution === "resolved" && resolvedPaths(app5.targets).join(",") === "AM 设计书 / 附录 E：现行边界 / E.5 六图",
    "A4 附录子节 附录 E.5 命中该子节",
    app5,
  );
  const appMissing = strict("附录 E.9");
  ok(
    appMissing.resolution === "unresolved" && appMissing.targets.length === 1 && unresolvedReasonOf(appMissing.targets) === "missing",
    "A4 附录缺失子节 附录 E.9 ⇒ unresolved（**不得**降级到“附录 E”大标题）",
    appMissing,
  );
  const oldDowngrade = resolveDesignRef("附录 E.9", sections1);
  ok(
    oldDowngrade !== -1 && sections1[oldDowngrade]?.title.startsWith("附录 E"),
    "A4 对照：旧 resolveDesignRef(附录 E.9) 仍降级命中“附录 E”大标题（旧判据一字不改，两套并存、用途分开）",
    { oldIndex: oldDowngrade, oldTitle: oldDowngrade === -1 ? null : sections1[oldDowngrade]?.title },
  );
  const appHead = strict("附录 E");
  ok(
    appHead.resolution === "resolved" && resolvedPaths(appHead.targets).join(",") === "AM 设计书 / 附录 E：现行边界",
    "A4 只给字母（附录 E）⇒ 命中大标题（显式目标，不是回退）",
    appHead,
  );
  const appMulti = strict("附录 E.5／E.6");
  ok(
    appMulti.resolution === "resolved" && appMulti.targets.length === 2 && resolvedPaths(appMulti.targets).join(",") ===
      "AM 设计书 / 附录 E：现行边界 / E.5 六图,AM 设计书 / 附录 E：现行边界 / E.6 一并一源",
    "A4 一个 token 里两个附录编号（附录 E.5／E.6）逐条解析",
    appMulti,
  );

  // 连字符条目落回所属子节（§12.1-12 = 12.1 的第 12 条）
  const itemSuffix = strict("§12.1-12");
  ok(
    itemSuffix.resolution === "resolved" && itemSuffix.targets.length === 1 && resolvedPaths(itemSuffix.targets)[0]?.endsWith("12.1 已决与待决"),
    "A1 连字符条目 §12.1-12 落回所属子节 12.1（不当成区间）",
    itemSuffix,
  );

  // A6 旧判据对照：范围只取第一个命中
  const oldRange = resolveDesignRef("§2.6–§2.9", sections1);
  ok(
    oldRange !== -1 && sections1[oldRange]?.title.startsWith("2.6"),
    "A6 对照：旧 resolveDesignRef(§2.6–§2.9) 仍只取第一个命中 2.6（不满足精确取材，故另立严格入口）",
    { oldIndex: oldRange, oldTitle: oldRange === -1 ? null : sections1[oldRange]?.title },
  );

  // findSection 行为不变（复用同一判据）
  const fsOk = findSection(D1, "AM 设计书 / 2 核心 / 2.8 丙");
  ok(fsOk.ok && fsOk.section.title === "2.8 丙", "A6 findSection 行为不变（复用 findSectionInParsed 后仍能唯一定位）");
  const fsDup = findSection(D2, "AM 设计书 / 2 核心 / 2.8 丙");
  ok(fsDup.ok === false && fsDup.kind === "duplicate", "A6 findSection 对重复路径仍拒绝（判据只有一处）");

  // A7 非章节类 token 分类
  const nonSection = [
    "报告 08 P1-1／P1-2",
    "报告 00 优化方案 §7／P4／P5",
    "AGENTS §1（迁移前人工对齐）",
    "docs/agent-optimization-20261006.md §5",
    "docs/sync-evidence-contract.md 全文",
    "需求＝`req-2026-09-25-r1`",
    "裁定稿本＝`.工作台/handoff/x.md`",
  ];
  ok(nonSection.every((t) => hasDesignSectionSyntax(t) === false), "A7 非设计章节引用（报告/需求/AGENTS/外部 .md/.工作台）不进章节解析", nonSection.filter((t) => hasDesignSectionSyntax(t) !== false));
  const sectionLike = ["§2.6–§2.9", "DESIGN §6.7", "DESIGN.md **附录 D**（模块/能力「验证通过」的判据）", "附录 E.5／E.6", "§12.1-12"];
  ok(sectionLike.every((t) => hasDesignSectionSyntax(t) === true), "A7 设计章节引用（§N / 附录 X）进严格解析", sectionLike.filter((t) => hasDesignSectionSyntax(t) !== true));
}

// ── 入口夹具 ──
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-v0946-verify-"));
const dataDir = path.join(tmpBase, "home");
fs.mkdirSync(dataDir, { recursive: true });
process.env.TATAI_HOME = dataDir;
const service = new WorkService({ dataDir });
const CHG = "chg-v0946";
const executor = "kimi-code";
const CONTINUABLE = { can_read: true, can_continue: true };

interface Card {
  id: string;
  goal: string;
  dep?: string;
  designRefs?: string | null;
  paths?: string[];
  checks?: string[];
  priority?: string;
}

function planText(title: string, cards: Card[]): string {
  const lines = [`# ${title}`, "", "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |", "| --- | --- | --- | --- | --- |"];
  for (const c of cards) lines.push(`| ${c.id} | todo | ${c.goal} | ${c.dep ?? ""} | ${c.id} 的完成证据 |`);
  lines.push("");
  for (const c of cards) {
    const parts: string[] = [];
    if (c.designRefs !== null && c.designRefs !== undefined) parts.push(`**设计依据**：${c.designRefs}`);
    parts.push(`**依赖**：${c.dep ?? "无"}`);
    parts.push(`**文件责任**：${(c.paths ?? [`src/${c.id.toLowerCase()}.ts`]).map((p) => `\`${p}\``).join("、")}`);
    if (c.priority !== undefined) parts.push(`**优先级**：${c.priority}`);
    lines.push(`### ${c.id} ${c.goal}`, "", `${parts.join("。")}。`, "");
    for (const chk of c.checks ?? [`${c.goal} 达标`]) lines.push(`- [ ] ${chk}`);
    lines.push("");
  }
  return lines.join("\n");
}

interface Fixture {
  id: string;
  root: string;
  workDir: string;
}

function writeDesign(fx: Fixture, text: string): void {
  fs.writeFileSync(path.join(fx.root, ".工作台", "design.md"), text, "utf8");
}

interface StageEntrySpec {
  path: string;
  kind: string;
  why: string;
  section?: string;
  revision?: string;
}
interface StageSourceSpec {
  path: string;
  sha256: string;
  section?: string;
}
/** 写一份合法 v2 阶段必读指针（`.工作台/work/stage-reads.json`；来源/条目哈希都按当前文件核） */
function writeStageReads(fx: Fixture, entries: StageEntrySpec[], sources: StageSourceSpec[]): void {
  const obj = { schema_version: 2, generated_from: sources, entries, preferred_task_id: null };
  fs.writeFileSync(path.join(fx.workDir, "stage-reads.json"), `${JSON.stringify(obj, null, 2)}\n`, "utf8");
}
const wholeFileSha = (p: string): string => sha256(fs.readFileSync(p));

function reactivate(fx: Fixture): void {
  activateBaseline(fx.id, { approved_by: "user", approval_basis: "P1 夹具复审激活", approval_kind: "user_confirmed" }, dataDir);
}

function makeFixture(id: string, designMd: string, cards: Card[]): Fixture {
  const root = path.join(tmpBase, id);
  fs.mkdirSync(path.join(root, ".工作台"), { recursive: true });
  fs.writeFileSync(path.join(root, ".工作台", "design.md"), designMd, "utf8");
  const plan = planText(`${id} 施工图`, cards);
  fs.writeFileSync(path.join(root, ".工作台", "plan.md"), plan, "utf8");
  addProject({ id, name: `P1 夹具 ${id}`, path: root, kind: "backend" }, dataDir);
  const imported = importTaskDefinitions(plan, { plan_revision: sha256(plan) });
  activateBaseline(id, { approved_by: "user", approval_basis: "P1 夹具审定", approval_kind: "user_confirmed" }, dataDir);
  if (cards.length > 0) {
    submitDefinitionImports(service, { project_id: id, change_id: CHG, actor_id: executor, role: "executor", definitions: imported.definitions });
  }
  return { id, root, workDir: projectWorkDir(id, dataDir) };
}

const entryOf = (fx: Fixture, extra: Record<string, unknown> = {}): ProjectEntry =>
  evaluateProjectEntry({ project_id: fx.id, role: "executor", client_capabilities: CONTINUABLE, ...extra }, { dataDir });
const designReadsOf = (e: ProjectEntry): RequiredRead[] => e.required_reads.filter((r) => r.kind === "design");
const readsByRef = (e: ProjectEntry, ref: string): RequiredRead[] => e.required_reads.filter((r) => r.source_ref === ref);
const eventsHash = (fx: Fixture): string => {
  const f = path.join(fx.workDir, "events.jsonl");
  return fs.existsSync(f) ? sha256(fs.readFileSync(f)) : "<none>";
};

// ── B1/B2/B5/B7/B9：多引用逐条 + 去重 + 整份保留 + 不变量 + 只读 ──
function scenarioMultiRef(): void {
  info("── B1/B2/B5/B7/B9 多引用逐条、去重不丢段、整份设计书保留、只读 ──");
  const fx = makeFixture("am-range", D1, [{ id: "T-RANGE", goal: "按范围取材", designRefs: "§2.6–§2.9" }]);
  const before = eventsHash(fx);
  const e = entryOf(fx);
  ok(e.next_action === "claim_task", `B0 现场可领取（next_action=${e.next_action}）`, e.reasons.map((r) => r.code));

  const refs = readsByRef(e, "§2.6–§2.9");
  ok(refs.length === 4, `B1 范围 §2.6–§2.9 逐条输出 4 条（实测 ${refs.length}）`, refs);
  ok(
    refs.every((r) => r.kind === "design" && r.resolution === "resolved" && r.purpose === "required_content" && r.section !== undefined && r.range !== null && typeof r.revision === "string"),
    "B1 每条带 kind/section/派生 range/revision，resolution=resolved，purpose=required_content",
    refs,
  );
  const s27 = refs.find((r) => r.section === "AM 设计书 / 2 核心 / 2.7 乙");
  ok(
    s27 !== undefined && s27.range?.start === 15 && s27.range?.end === 18 && s27.revision === sha256(D1_LINES.slice(14, 18).join("\n")),
    "B1 条目 2.7 带当前行范围 15–18 与该子树哈希（path+range 直接读回，不整篇读取）",
    s27,
  );
  ok(
    refs.every((r) => {
      const d = markdownSectionDigest(Buffer.from(D1, "utf8"), r.section as string);
      return d.ok && d.sha256 === r.revision;
    }),
    "B7 不变量：有 section 的条目 revision 就是该章节子树哈希（materialSection 同一口径）",
  );
  ok(refs.every((r) => r.section !== undefined && r.section.includes(" / ")), "B1 section 是完整标题路径（materialSection 口径，供绑定定位，不转传 read_design 的 section 参数）");

  const book = designReadsOf(e).find((r) => r.path === ".工作台/design.md" && r.section === undefined && r.source_ref === undefined);
  ok(book !== undefined && book.purpose === "trace_reference", "B5 整份设计书入口始终保留；有解析到的设计引用时 purpose=trace_reference", book);

  const plan = e.required_reads.find((r) => r.kind === "plan");
  ok(plan !== undefined && plan.purpose === "required_content" && plan.range != null, "B4 施工图卡区条目 purpose=required_content 且带卡区行范围", plan);
  const base = e.required_reads.find((r) => r.kind === "baseline");
  ok(base !== undefined && base.purpose === "trace_reference", "B4 生效基线条目 purpose=trace_reference", base);
  const facts = e.required_reads.find((r) => r.kind === "task_facts");
  ok(facts !== undefined && facts.purpose === "trace_reference", "B4 事件账本条目 purpose=trace_reference", facts);

  // B2 同文件多段必读都在（path 可重复，只按 (path, section) 去重）
  const sameFile = e.required_reads.filter((r) => r.path === ".工作台/design.md");
  ok(sameFile.length >= 5 && new Set(sameFile.map((r) => r.section ?? "<whole>")).size === sameFile.length, "B2 同文件多段必读逐条都在（允许 path 重复，仅相同 (path, section) 去重）", sameFile.map((r) => r.section ?? "<whole>"));

  // B9 只读红线
  entryOf(fx);
  entryOf(fx, { resume_hint: "T-RANGE" });
  ok(eventsHash(fx) === before, "B9 入口只读：多次 project_entry 后 events.jsonl 逐字节不变", { before, after: eventsHash(fx) });
}

// ── B2/B3：失败引用按 source_ref 去重、不漏第二条 ──
function scenarioUnresolved(): void {
  info("── B2/B3 无 section 的失败引用按 source_ref 去重、不漏第二条 ──");
  const fx = makeFixture("am-dupfail", D1, [{ id: "T-DUPFAIL", goal: "两条都定位不到", designRefs: "§9.9、§8.8" }]);
  const e = entryOf(fx);
  const r999 = readsByRef(e, "§9.9");
  const r888 = readsByRef(e, "§8.8");
  ok(
    r999.length === 1 && r888.length === 1 && r999[0]?.resolution === "unresolved" && r888[0]?.resolution === "unresolved",
    "B2 两条无 section 的失败引用都在（按 source_ref 并入去重键，第二条不被吞）",
    e.required_reads.filter((r) => r.kind === "design"),
  );
  ok(
    r999[0]?.section === undefined && typeof r999[0]?.resolution_detail === "string" && (r999[0]?.resolution_detail ?? "").length > 0,
    "B3 unresolved 条目无 section、带 resolution_detail 原因（不猜近似标题）",
    r999[0],
  );
  const book = designReadsOf(e).find((r) => r.section === undefined && r.source_ref === undefined);
  ok(book !== undefined && book.purpose === "required_content", "B5 全部引用未解析时整份设计书 purpose 仍为 required_content（入口不丢）", book);

  const fx2 = makeFixture("am-amb", D2, [{ id: "T-AMB", goal: "重名标题", designRefs: "§2.8" }]);
  const e2 = entryOf(fx2);
  const amb = readsByRef(e2, "§2.8");
  ok(amb.length === 1 && amb[0]?.resolution === "unresolved" && (amb[0]?.resolution_detail ?? "").includes("歧义"), "B3 重名标题 ⇒ unresolved（原因=歧义）", amb[0]);
}

// ── B4：无设计引用时整份设计书 = required_content ──
function scenarioNoRefs(): void {
  info("── B4 无设计引用：整份设计书 required_content ──");
  const fx = makeFixture("am-noref", D1, [{ id: "T-NOREF", goal: "无设计引用", designRefs: null }]);
  const e = entryOf(fx);
  const book = designReadsOf(e).find((r) => r.section === undefined);
  ok(book !== undefined && book.purpose === "required_content" && designReadsOf(e).length === 1, "B4 无设计引用 ⇒ 只有整份设计书一条，purpose=required_content", designReadsOf(e));

  const fx2 = makeFixture("am-emptyref", D1, [{ id: "T-EMPTY", goal: "空依据", designRefs: "无" }]);
  const e2 = entryOf(fx2);
  ok(
    designReadsOf(e2).length === 1 && designReadsOf(e2)[0]?.source_ref === undefined,
    "B4 卡面「设计依据：无」不造空引用条目（不编造指针）",
    designReadsOf(e2),
  );
}

// ── B4b：非设计章节引用 → trace_reference 原始引用条目 ──
function scenarioTraceRefs(): void {
  info("── B4b 非章节引用（审计报告／外部文档）→ trace_reference 原始引用条目 ──");
  const fx = makeFixture("am-trace", D1, [
    { id: "T-TRACE", goal: "混合依据", designRefs: "§2.6–§2.9、报告 08 P1-1／P1-2、docs/agent-optimization-20261006.md §5" },
  ]);
  const e = entryOf(fx);
  const rep = readsByRef(e, "报告 08 P1-1／P1-2");
  const ext = readsByRef(e, "docs/agent-optimization-20261006.md §5");
  ok(
    rep.length === 1 && rep[0]?.purpose === "trace_reference" && rep[0]?.section === undefined && rep[0]?.resolution === undefined,
    "B4b 审计报告引用 → trace_reference 条目带原始引用，不做章节解析（无 section、无 resolution）",
    rep,
  );
  ok(
    ext.length === 1 && ext[0]?.purpose === "trace_reference" && ext[0]?.section === undefined,
    "B4b 外部文档引用（docs/…md §5）→ trace_reference（不误当设计书 §5）",
    ext,
  );
  ok(readsByRef(e, "§2.6–§2.9").length === 4, "B4b 同一条设计依据行里，章节引用仍逐条解析为 required_content", readsByRef(e, "§2.6–§2.9").length);
}

// ── C1：严格编号边界（近似标题不得当成功） ──
function scenarioStrictBoundary(): void {
  info("── C1 严格编号边界：2.6abc／2.60／E.5x 不被当近似标题命中 ──");
  ok(parsed3.ok, "C1 边界夹具解析成功");
  const s26 = strict("§2.6", sections3);
  ok(
    s26.resolution === "resolved" && resolvedPaths(s26.targets).join(",") === "AM 边界书 / 2 核心 / 2.6 甲",
    "C1 §2.6 只命中真节「2.6 甲」（不命中 2.6abc／2.60 假节）",
    s26,
  );
  const e5 = strict("附录 E.5", sections3);
  ok(
    e5.resolution === "resolved" && resolvedPaths(e5.targets).join(",") === "AM 边界书 / 附录 E：现行边界 / E.5 六图",
    "C1 附录 E.5 只命中真节「E.5 六图」（不命中 E.5x 假节）",
    e5,
  );
  // 假节若被当近似标题命中，候选会变成 2 个 ⇒ ambiguous；这里逐条确认真节是唯一候选
  ok(
    sections3.filter((s) => /^2\.6(?![\dA-Za-z])(?!\.\d)/.test(s.title)).length === 1,
    "C1 编号边界判据在章节树上唯一命中真节（假节被 (?![0-9A-Za-z]) 挡住）",
    sections3.filter((s) => s.title.startsWith("2.6")).map((s) => s.title),
  );
}

// ── C2：超大数字有限终止（子进程 + 硬超时；绝不挂住主测试进程） ──
const HUGE_CASES = [
  "§9007199254740992–§9007199254740992",
  "§9007199254740993–§9007199254740993",
  "§99999999999999999999–§99999999999999999999",
  "§9007199254740992",
  "§2.6–§9007199254740992",
];
/** 只做「安全整数外的编号不进循环」这一件事；由父进程以子进程＋硬超时跑，回归时也不会无界挂起 */
function hugeProbe(): void {
  for (const t of HUGE_CASES) {
    const r = resolveDesignRefStrict(t, sections1);
    const bad = r.resolution === "unresolved" && r.targets.length > 0 && r.targets.every((x) => x.resolution === "unresolved");
    console.log(`[verify] ${bad ? "PASS" : "FAIL"} huge:${t}`);
    if (!bad) process.exitCode = 1;
  }
}
function scenarioHugeTermination(): void {
  info("── C2 超大数字有限终止（子进程 + 硬超时） ──");
  const r = spawnSync(process.execPath, ["--import", "tsx", SELF_PATH], {
    cwd: REPO_ROOT,
    env: { ...process.env, V0946_ONLY: "huge" },
    encoding: "utf8",
    timeout: 30000,
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  ok(
    r.status === 0 && r.error === undefined && !out.includes("FAIL huge:") && out.includes("PASS huge:"),
    "C2 超大数字引用在带硬超时的子进程内有限终止（无无界循环/挂起、无 FAIL）",
    { status: r.status, signal: r.signal, error: r.error?.message, tail: out.slice(-700) },
  );
}

// ── C3：显式 § 右端不当条目号；只有明确条目语法才读所属子节 ──
function scenarioSectionRangeAndItem(): void {
  info("── C3 范围右端显式 § / 条目语法边界 ──");
  const bad = strict("§2.6–§3", sections3);
  ok(
    bad.resolution === "unresolved" && bad.targets.length === 1 && unresolvedReasonOf(bad.targets) === "malformed",
    "C3 §2.6–§3 右端是显式章节 ⇒ unresolved（不因右端少层级就吞成条目、不静默只取 2.6）",
    bad,
  );
  const enDash = strict("§2.6–12", sections3);
  ok(
    enDash.resolution === "unresolved" && unresolvedReasonOf(enDash.targets) === "malformed",
    "C3 §2.6–12（范围符不是连字符族）⇒ unresolved（只有明确条目语法才读所属子节）",
    enDash,
  );
  const item = strict("§12.1-12", sections3);
  ok(
    item.resolution === "resolved" && resolvedPaths(item.targets).join(",") === "AM 边界书 / 12 遗留风险 / 12.1 已决与待决",
    "C3 §12.1-12（连字符＋右端不带 §＋层级更浅）⇒ 条目号，落回 12.1",
    item,
  );
  const range = strict("§2.6–§2.9", sections1);
  ok(range.resolution === "resolved" && range.targets.length === 4, "C3 同层级的 §2.6–§2.9 仍是完整展开的范围（4 条）", range);
}

// ── C4：附录连字符条目与真实章节语法区分 ──
function scenarioAppendixHyphen(): void {
  info("── C4 附录连字符条目：存在同名标题不得退大标题 ──");
  const g2 = strict("附录 G-2", sections3);
  ok(
    g2.resolution === "resolved" && resolvedPaths(g2.targets).join(",") === "AM 边界书 / 附录 G：修订记录 / G-2 本轮未做的事",
    "C4 附录 G-2 存在 G-2 标题 ⇒ 命中它，**不退**「附录 G」大标题",
    g2,
  );
  const gHead = strict("附录 G", sections3);
  ok(
    gHead.resolution === "resolved" && resolvedPaths(gHead.targets).join(",") === "AM 边界书 / 附录 G：修订记录",
    "C4 只给字母的 附录 G 仍命中大标题（显式目标）",
    gHead,
  );
  const noItem = strict("附录 E-9", sections3);
  ok(
    noItem.resolution === "resolved" && resolvedPaths(noItem.targets).join(",") === "AM 边界书 / 附录 E：现行边界",
    "C4 无 E-9 标题时 附录 E-9 才落回「附录 E」大标题（存在才挡，不存在才落）",
    noItem,
  );
  const c51 = strict("附录 C.5-1", sections3);
  ok(
    c51.resolution === "resolved" && resolvedPaths(c51.targets).join(",") === "AM 边界书 / 附录 C：收尾 / C.5 v0.7 轮",
    "C4 附录 C.5-1 无同名连字符标题 ⇒ 落回所属子节 C.5（条目级无独立标题）",
    c51,
  );
}

// ── C5：混合引用 / 外部文档分类边界 ──
function scenarioMixedRefs(): void {
  info("── C5 混合引用：明确设计节与外部文档同现时保留设计部分 ──");
  ok(hasDesignSectionSyntax("DESIGN §2.6（见 docs/foo.md）"), "C5 「DESIGN §2.6（见 docs/foo.md）」含显式设计节 ⇒ 进设计章节解析（不整体降为追溯）");
  ok(hasDesignSectionSyntax("§9.9（见 docs/foo.md）"), "C5 「§9.9（见 docs/foo.md）」显式 § 在外部文档之前 ⇒ 仍按设计节解析");
  ok(!hasDesignSectionSyntax("docs/agent-optimization-20261006.md §5"), "C5 外部 .md 在前 ⇒ §5 属于该外部文档，不作设计章节解析");
  ok(!hasDesignSectionSyntax("AGENTS §1（迁移前人工对齐）"), "C5 AGENTS §1 ⇒ 非设计引用");
  ok(!hasDesignSectionSyntax("报告 00 优化方案 §7／P4／P5"), "C5 报告 §7 ⇒ 非设计引用");
  ok(isDesignRefToken("DESIGN §2.6（见 docs/foo.md）", sections1) && !isDesignRefToken("docs/agent-optimization-20261006.md §5", sections1), "C5 isDesignRefToken 与分类判据一致");

  const fx = makeFixture("am-mixed", D1, [
    { id: "T-MIXED", goal: "混合依据", designRefs: "DESIGN §2.6（见 docs/foo.md）、docs/agent-optimization-20261006.md §5" },
  ]);
  const e = entryOf(fx);
  const design = readsByRef(e, "DESIGN §2.6（见 docs/foo.md）");
  ok(
    design.length === 1 && design[0]?.purpose === "required_content" && design[0]?.resolution === "resolved" && design[0]?.section === "AM 设计书 / 2 核心 / 2.6 甲",
    "C5 混合引用仍精确解析出设计节 §2.6（required_content + resolved，不静默遗漏必读）",
    design,
  );
  const ext = readsByRef(e, "docs/agent-optimization-20261006.md §5");
  ok(ext.length === 1 && ext[0]?.purpose === "trace_reference", "C5 同行的外部文档引用仍作 trace_reference", ext);
}

// ── C6：完整标题路径引用 / 认不出的设计引用不得当外部追溯 ──
function scenarioTitlePath(): void {
  info("── C6 完整标题路径唯一精确匹配；认不出的设计引用 ⇒ unresolved ──");
  const full = strict("AM 设计书 / 2 核心 / 2.7 乙");
  ok(
    full.resolution === "resolved" && resolvedPaths(full.targets).join(",") === "AM 设计书 / 2 核心 / 2.7 乙",
    "C6 整条完整标题路径唯一精确匹配（不只支持 §编号）",
    full,
  );
  const leaf = strict("设计书 2.7 乙");
  ok(
    leaf.resolution === "resolved" && resolvedPaths(leaf.targets).join(",") === "AM 设计书 / 2 核心 / 2.7 乙",
    "C6 末级标题（去掉设计书字样）唯一命中 ⇒ resolved",
    leaf,
  );
  const unknown = strict("DESIGN.md 不存在的章节名");
  ok(
    unknown.resolution === "unresolved" && unknown.targets.length === 1 && unresolvedReasonOf(unknown.targets) === "malformed",
    "C6 指名设计书却认不出章节 ⇒ unresolved（不静默当外部追溯而少读）",
    unknown,
  );
  ok(namesDesignBook("DESIGN.md 不存在的章节名") && !isDesignRefToken("第三方说明.txt 全文", sections1), "C6 指名设计书即进解析；纯外部文档不进");
  ok(
    resolveDesignRefStrict("AM 设计书 / 2 核心 / 2.8 丙", sections3).resolution === "unresolved",
    "C6 完整标题路径命中不到即 unresolved（不硬凑近似标题）",
  );

  const fx = makeFixture("am-titlepath", D1, [
    { id: "T-TITLE", goal: "标题路径取材", designRefs: "AM 设计书 / 2 核心 / 2.7 乙、DESIGN.md 不存在的章节名" },
  ]);
  const e = entryOf(fx);
  const byPath = e.required_reads.find((r) => r.source_ref === "AM 设计书 / 2 核心 / 2.7 乙");
  ok(
    byPath !== undefined && byPath.purpose === "required_content" && byPath.resolution === "resolved" && byPath.section === "AM 设计书 / 2 核心 / 2.7 乙" && byPath.range?.start === 15,
    "C6 入口把完整标题路径引用落成 required_content + section + range",
    byPath,
  );
  const unknownEntry = e.required_reads.find((r) => r.source_ref === "DESIGN.md 不存在的章节名");
  ok(
    unknownEntry !== undefined && unknownEntry.purpose === "required_content" && unknownEntry.resolution === "unresolved",
    "C6 认不出的设计引用在入口是 required_content + unresolved（不是 trace_reference 少读）",
    unknownEntry,
  );
}

// ── C8（集成复核第 1 条）：引用 token 的输入合法边界（非法后缀不得截短命中已知节） ──
function scenarioTokenSuffixBoundary(): void {
  info("── C8 输入 token 合法边界：§2.6abc / 附录 E.5x / 范围尾随后缀都不得截短命中已知节 ──");
  const malformed = (tok: string): boolean => {
    const r = strict(tok, sections3);
    return r.resolution === "unresolved" && r.targets.length === 1 && unresolvedReasonOf(r.targets) === "malformed";
  };
  const badTokens = ["§2.6abc", "附录 E.5x", "§2.6–§2.9abc", "附录 E.5-1x"];
  for (const tok of badTokens) {
    ok(malformed(tok), `C8 「${tok}」⇒ unresolved(malformed)，**不**截短成 §2.6／附录 E.5 命中已知节`, strict(tok, sections3));
  }
  // 合法引用与「编号后中文解释」兼容不受影响
  const s26 = strict("§2.6", sections3);
  const e5 = strict("附录 E.5", sections3);
  ok(
    s26.resolution === "resolved" && resolvedPaths(s26.targets).join(",") === "AM 边界书 / 2 核心 / 2.6 甲" &&
      e5.resolution === "resolved" && resolvedPaths(e5.targets).join(",") === "AM 边界书 / 附录 E：现行边界 / E.5 六图",
    "C8 合法 §2.6／附录 E.5 仍唯一命中真节（合法边界与中文解释兼容不受影响）",
    { s26, e5 },
  );
  // 入口：非法后缀引用是 required_content + unresolved（不静默省略、也不冒充已解析）
  const fx = makeFixture("am-c8", D1, [{ id: "T-C8", goal: "非法后缀", designRefs: "§2.6abc" }]);
  const e = entryOf(fx);
  const reads = readsByRef(e, "§2.6abc");
  ok(
    reads.length === 1 && reads[0]?.purpose === "required_content" && reads[0]?.resolution === "unresolved" && reads[0]?.section === undefined,
    "C8 非法后缀引用在入口是 required_content + unresolved（无 section，不冒充已解析节）",
    reads,
  );
}

// ── C9（集成复核第 2 条）：未知完整标题路径/未知依据按设计引用解析，只有机械外部才 trace ──
function scenarioUnknownRefClassification(): void {
  info("── C9 未知完整标题路径/未知依据进设计解析（不静默当外部），机械外部才 trace ──");
  ok(isDesignRefToken("根标题 / 核心 / 缺失子标题", sections1), "C9 明确完整标题路径形态（含 ` / `）即使认不出也进设计解析");
  ok(isDesignRefToken("某处未知依据", sections1), "C9 未知依据不得被当外部（进解析 ⇒ unresolved）");
  ok(!isDesignRefToken("第三方说明.txt 全文", sections1), "C9 机械明确外部文档（.txt）作追溯指针");
  ok(!isDesignRefToken("docs/agent-optimization-20261006.md §5", sections1), "C9 外部 .md 前置章节编号作追溯指针");
  const unknown = resolveDesignRefStrict("根标题 / 核心 / 缺失子标题", sections1);
  ok(
    unknown.resolution === "unresolved" && unknown.targets.length === 1 && unresolvedReasonOf(unknown.targets) === "malformed",
    "C9 认不出的完整标题路径 ⇒ unresolved(malformed)（不猜近似标题）",
    unknown,
  );
  // 同一卡：一个已解析节 + 一个不存在完整标题路径 —— 两条都在（后者不因前者解析成功而被省成外部）
  const fx = makeFixture("am-c9", D1, [{ id: "T-C9", goal: "混合未知", designRefs: "§2.6、根标题 / 核心 / 缺失子标题" }]);
  const e = entryOf(fx);
  const resolvedOne = readsByRef(e, "§2.6");
  const unresolvedOne = readsByRef(e, "根标题 / 核心 / 缺失子标题");
  ok(
    resolvedOne.length === 1 && resolvedOne[0]?.purpose === "required_content" && resolvedOne[0]?.resolution === "resolved" && resolvedOne[0]?.section === "AM 设计书 / 2 核心 / 2.6 甲",
    "C9 同卡已解析节在入口是 required_content + resolved",
    resolvedOne,
  );
  ok(
    unresolvedOne.length === 1 && unresolvedOne[0]?.purpose === "required_content" && unresolvedOne[0]?.resolution === "unresolved",
    "C9 同卡认不出的完整标题路径在入口是 required_content + unresolved（不是 trace_reference、不被省略）",
    unresolvedOne,
  );
}

// ── C10（集成修正同因组合反例）：合法+非法子目标同现 ⇒ 整条不得错误 resolved ──
function scenarioCombinedBoundary(): void {
  info("── C10 组合边界：合法子目标不得使含非法显式编号的整条引用被错判 resolved ──");
  const c1 = strict("§2.6 / §2.9abc", sections1);
  ok(
    c1.resolution === "unresolved" &&
      resolvedPaths(c1.targets).includes("AM 设计书 / 2 核心 / 2.6 甲") &&
      c1.targets.some((t) => t.resolution === "unresolved" && t.token_part.includes("2.9")),
    "C10 「§2.6 / §2.9abc」：合法 §2.6 仍在，非法 §2.9abc 明确 unresolved（不丢显式编号、不使整条 resolved）",
    c1,
  );
  const c2 = strict("§2.6 – §2.9abc", sections1);
  ok(
    c2.resolution === "unresolved" &&
      c2.targets.every((t) => t.resolution === "unresolved") &&
      c2.targets.some((t) => t.token_part.includes("2.9")),
    "C10 「§2.6 – §2.9abc」（分隔符前有空格）：不回退截短命中 §2.6，整条 unresolved",
    c2,
  );
  const c3 = strict("附录 E.5 / 附录 E.6x", sections1);
  ok(
    c3.resolution === "unresolved" &&
      resolvedPaths(c3.targets).includes("AM 设计书 / 附录 E：现行边界 / E.5 六图") &&
      c3.targets.some((t) => t.resolution === "unresolved" && t.token_part.includes("E.6")),
    "C10 「附录 E.5 / 附录 E.6x」：合法 E.5 仍在，非法 E.6x 明确 unresolved",
    c3,
  );
  const ok1 = strict("§2.6 / §2.9", sections1);
  ok(
    ok1.resolution === "resolved" &&
      ok1.targets.length === 2 &&
      resolvedPaths(ok1.targets).join(",") === "AM 设计书 / 2 核心 / 2.6 甲,AM 设计书 / 2 核心 / 2.9 丁",
    "C10 对照：「§2.6 / §2.9」全合法 ⇒ 仍逐条 resolved（两段都不丢）",
    ok1,
  );
  const ok2 = strict("附录 E.5 / 附录 E.6", sections1);
  ok(
    ok2.resolution === "resolved" && ok2.targets.length === 2,
    "C10 对照：「附录 E.5 / 附录 E.6」全合法 ⇒ 仍逐条 resolved",
    ok2,
  );
  const spaced = strict("§2.6 – §2.9", sections1);
  ok(
    spaced.resolution === "resolved" && spaced.targets.length === 4,
    "C10 对照：「§2.6 – §2.9」（带空格的范围）仍完整展开 4 条（分隔符前空格不误伤合法范围）",
    spaced,
  );
}

// ── C11（最终集成裸续列收口）：已支持语法下的未知子目标必须显式 unresolved ──
function scenarioBareContinuation(): void {
  info("── C11 裸续列：附录标记后的非法续列项不得被合法项掩盖 ──");
  // 裸续列（`附录 E.5、E.7x` 的 `E.7x` 无 `附录` 前缀）本就是解析器已支持的语法；这里只补「认不出的续列项」。
  const bad = strict("附录 E.5、E.7x", sections1);
  ok(
    bad.resolution === "unresolved" &&
      resolvedPaths(bad.targets).includes("AM 设计书 / 附录 E：现行边界 / E.5 六图") &&
      bad.targets.some((t) => t.resolution === "unresolved" && t.token_part.includes("E.7x")),
    "C11 「附录 E.5、E.7x」：合法 E.5 仍在，非法裸续列 E.7x 明确 unresolved（不丢、不使整条 resolved）",
    bad,
  );
  const badRange = strict("附录 E.5、E.7x、E.8", sections1);
  ok(
    badRange.resolution === "unresolved" &&
      badRange.targets.some((t) => t.resolution === "unresolved" && t.token_part.includes("E.7x")) &&
      badRange.targets.some((t) => t.resolution === "unresolved" && t.token_part.includes("E.8")),
    "C11 多段：「附录 E.5、E.7x、E.8」的 E.7x 与缺失的 E.8 都逐条 unresolved，合法 E.5 仍在",
    badRange,
  );
  const okLegal = strict("附录 E.5、E.6", sections1);
  ok(
    okLegal.resolution === "resolved" &&
      okLegal.targets.length === 2 &&
      resolvedPaths(okLegal.targets).join(",") === "AM 设计书 / 附录 E：现行边界 / E.5 六图,AM 设计书 / 附录 E：现行边界 / E.6 一并一源",
    "C11 对照：合法裸续列「附录 E.5、E.6」仍逐条 resolved（两段都不丢，不误伤已支持语法）",
    okLegal,
  );
  const okWord = strict("附录 E.5 见 Excel 表", sections1);
  ok(
    okWord.resolution === "resolved" && okWord.targets.length === 1,
    "C11 对照：正文英文单词（「附录 E.5 见 Excel 表」的 Excel）不被误判为续列编号 ⇒ 仍 resolved",
    okWord,
  );
}

// ── C7：同目标合并保留更强 purpose/完整范围与来源理由 ──
function scenarioStrongerMerge(): void {
  info("── C7 最强必读合并：任务节引用＋阶段整文件、任务卡范围＋阶段完整 PLAN ──");
  // C7a 任务解析到设计子节（整份设计书降为 trace_reference）＋阶段明确要求同文件全文
  const fx = makeFixture("am-merge-design", D1, [{ id: "T-MERGED", goal: "阶段要读整份设计书", designRefs: "§2.6–§2.9" }]);
  const designFile = path.join(fx.root, ".工作台", "design.md");
  const stageWhy = "本阶段必读设计书全文（P1 复核夹具）";
  writeStageReads(
    fx,
    [{ path: ".工作台/design.md", kind: "design", why: stageWhy, revision: wholeFileSha(designFile) }],
    [{ path: ".工作台/design.md", sha256: wholeFileSha(designFile) }],
  );
  const e = entryOf(fx);
  const bookEntries = e.required_reads.filter(
    (r) => r.kind === "design" && r.path === ".工作台/design.md" && r.section === undefined && r.source_ref === undefined,
  );
  const book = bookEntries[0];
  ok(bookEntries.length === 1, "C7a 整份设计书入口合并后仍只有一条（同目标不重复列）", bookEntries);
  ok(book?.purpose === "required_content", "C7a 阶段要求同文件全文 ⇒ 合并为 required_content（不被较早的 trace_reference 吞掉）", book);
  ok((book?.why ?? "").includes(stageWhy) && (book?.why ?? "").includes("设计书原文"), "C7a 合并保留全部来源理由（设计书原文＋阶段必读理由）", book?.why);
  ok(readsByRef(e, "§2.6–§2.9").length === 4, "C7a 任务的设计引用仍逐条在（合并不丢段）", readsByRef(e, "§2.6–§2.9").length);

  // C7b 任务卡只给卡区范围（窄）＋阶段要求完整 PLAN
  const fx2 = makeFixture("am-merge-plan", D1, [{ id: "T-MERGEP", goal: "阶段要读完整施工图", designRefs: "§2.6–§2.9" }]);
  const planFile = path.join(fx2.root, ".工作台", "plan.md");
  const planStageWhy = "本阶段必读完整施工图（P1 复核夹具）";
  writeStageReads(
    fx2,
    [{ path: ".工作台/plan.md", kind: "plan", why: planStageWhy, revision: wholeFileSha(planFile) }],
    [{ path: ".工作台/plan.md", sha256: wholeFileSha(planFile) }],
  );
  const e2 = entryOf(fx2);
  const plans = e2.required_reads.filter((r) => r.kind === "plan" && r.path === ".工作台/plan.md");
  const plan = plans[0];
  ok(plans.length === 1, "C7b 施工图条目合并后仍只有一条", plans);
  ok(plan?.purpose === "required_content", "C7b 施工图条目 purpose=required_content", plan);
  ok(plan !== undefined && plan.range === null, "C7b 任务卡窄范围被阶段完整 PLAN 合并为整文件范围（窄范围不得覆盖完整范围）", plan?.range);
  ok((plan?.why ?? "").includes(planStageWhy) && (plan?.why ?? "").includes("卡区原文"), "C7b 合并保留全部来源理由（卡区原文＋阶段整文件理由）", plan?.why);
}

// ── B6：章节外改动 / 位置移动 / 章节内改动 ──
function scenarioDrift(): void {
  info("── B6 章节外改动→不变；前节插入→range 平移；章节内改动→哈希变 ──");
  const fx = makeFixture("am-drift", D1, [{ id: "T-RANGE", goal: "按范围取材", designRefs: "§2.6–§2.9" }]);
  const sectionOf = (ref: string): RequiredRead | undefined => readsByRef(entryOf(fx), ref).find((r) => r.section?.endsWith("2.7 乙"));
  const r0 = sectionOf("§2.6–§2.9");
  ok(r0 !== undefined && r0.range?.start === 15 && r0.range?.end === 18, "B6 基准：2.7 = 行 15–18", r0);

  // 章节外改动（甲正文，属 2.6）
  writeDesign(fx, D1.replace("甲正文。", "甲正文改（章节外）。"));
  reactivate(fx);
  const r1 = sectionOf("§2.6–§2.9");
  ok(r1 !== undefined && r1.revision === r0?.revision && r1.range?.start === 15 && r1.range?.end === 18, "B6 章节外（2.6 内）改动 ⇒ 2.7 定位与哈希不变", { r0: r0?.revision, r1: r1?.revision });
  const r26 = readsByRef(entryOf(fx), "§2.6–§2.9").find((r) => r.section?.endsWith("2.6 甲"));
  ok(r26?.revision !== undefined && r26.revision !== sha256(D1_LINES.slice(10, 14).join("\n")), "B6 同次改动命中的 2.6 条目哈希随之变化（须重取）", r26?.revision);

  // 前节插入行（在 1 概述正文后插一行）→ 章节内容不变，range 现算平移
  writeDesign(fx, D1.replace("概述正文。", "概述正文。\n\n插入的一行。"));
  reactivate(fx);
  const r2 = sectionOf("§2.6–§2.9");
  ok(r2 !== undefined && r2.revision === r0?.revision && r2.range?.start === 17 && r2.range?.end === 20, "B6 前节插入两行 ⇒ 2.7 内容哈希不变、range 现算平移到 17–20（不保存旧行号）", r2);

  // 章节内改动
  writeDesign(fx, D1.replace("乙正文。", "乙正文改（章节内）。"));
  reactivate(fx);
  const r3 = sectionOf("§2.6–§2.9");
  ok(r3 !== undefined && r3.revision !== r0?.revision && r3.section === r0?.section, "B6 章节内改动 ⇒ 该条声明失效（同一 section、哈希已变，须重取）", { r0: r0?.revision, r3: r3?.revision });
}

// ── B8：恢复上下文（run/workspace/checkpoint 指针；无心跳不断言停机） ──
async function scenarioResume(): Promise<void> {
  info("── B8 恢复上下文：run/workspace/checkpoint 指针明确，无心跳不断言停机 ──");
  const fx = makeFixture("am-resume", D1, [{ id: "T-RUN", goal: "恢复现场", designRefs: "§2.6–§2.9" }]);
  const rev = readTaskStates(fx.workDir).states["T-RUN"]?.revision ?? null;
  const outcome = await claimTask(
    { project_id: fx.id, task_id: "T-RUN", role: "executor", owner_id: executor, change_id: CHG, expected_revision: rev },
    service,
    dataDir,
  );
  ok(outcome.ok === true, "B8 前置：真实认领成功（建立未结束 run）", outcome);

  const ckpt: ResumeCheckpoint = {
    schema_version: 1,
    checkpoint_id: "ckpt-v0946",
    project_id: fx.id,
    created_at: new Date().toISOString(),
    package_id: "pkg-v0946",
    design_revision: null,
    plan_revision: null,
    reason: "interrupted",
    detail: "P1 验证用检查点",
    confirmed_sources: [],
    pending_paths: [],
    resume_position: null,
  };
  ok(saveCheckpoint(fx.id, ckpt, dataDir), "B8 前置：检查点落盘成功");

  const e = entryOf(fx);
  ok(e.next_action === "resume_task", `B8 有未结束 run ⇒ resume_task（实测 ${e.next_action}）`, e.reasons.map((r) => r.code));
  const run = e.current_runs[0];
  ok(
    run !== undefined && run.workspace !== "" && run.lease_expires_at !== "" && run.owner_id === executor,
    "B8 明确现有 run 的 workspace/所有权/租约指针",
    run,
  );
  ok(
    run !== undefined && run.run_site.state !== "confirmed_stopped" && run.run_site.confirmation === null,
    "B8 无执行心跳/无回执 ⇒ 不断言进程已停（state≠confirmed_stopped 且无停止依据）",
    run?.run_site,
  );
  const cp = e.required_reads.find((r) => r.kind === "checkpoint");
  ok(cp !== undefined && cp.path === ".工作台/work/context-resume.json" && cp.purpose === "resume_context", "B8 中断续接现场条目 purpose=resume_context", cp);
  ok(readsByRef(e, "§2.6–§2.9").length === 4, "B8 resume 现场仍带任务的设计引用条目（不因恢复而丢必读）", readsByRef(e, "§2.6–§2.9").length);
}

// ── 收尾 ──
async function main(): Promise<void> {
  // 子进程只跑超大数字探针（父进程以硬超时跑它，回归也不会挂住主测试进程）
  if (process.env.V0946_ONLY === "huge") {
    hugeProbe();
    return;
  }
  scenarioStrictResolver();
  scenarioMultiRef();
  scenarioUnresolved();
  scenarioNoRefs();
  scenarioTraceRefs();
  scenarioStrictBoundary();
  scenarioHugeTermination();
  scenarioSectionRangeAndItem();
  scenarioAppendixHyphen();
  scenarioMixedRefs();
  scenarioTitlePath();
  scenarioTokenSuffixBoundary();
  scenarioUnknownRefClassification();
  scenarioCombinedBoundary();
  scenarioBareContinuation();
  scenarioStrongerMerge();
  scenarioDrift();
  await scenarioResume();

  console.log(`\n[verify] P1/V09-46 结果：${passCount} PASS / ${fails.length} FAIL`);
  if (fails.length > 0) {
    console.log(`[verify] FAIL 清单：${fails.join(" | ")}`);
    process.exitCode = 1;
  } else {
    console.log("[verify] 全部 PASS");
  }
}

main()
  .catch((e) => {
    console.error(`[verify] 异常：${e instanceof Error ? e.stack : String(e)}`);
    process.exitCode = 1;
    ok(false, `验证中断：${e instanceof Error ? e.message : String(e)}`);
  })
  .finally(() => {
    if (process.env.TATAI_KEEP_TMP === "1") info(`保留现场：${tmpBase}`);
    else fs.rmSync(tmpBase, { recursive: true, force: true });
  });
