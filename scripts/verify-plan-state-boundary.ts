// V09-61 修复验证：施工定义解析的「派生状态段」判据边界（`src/server/work/plan.ts` 的
// `isStateParagraph` 共同机制）。用法：`pnpm exec tsx scripts/verify-plan-state-boundary.ts`。
//
// 背景（已确认的漏定义机制）：旧判据「段落里出现 `**…状态…：` / `**…备注…：`（含 `.includes()` 子串匹配）
// 就把整段判为派生状态段」会把**不是独立施工备注段**的定义内容一起吞掉——实测 V09-09 的十条检查
// 因正文含 `**文档／状态／蓝图三方同步**：` 整段被剔除（零 checkbox），V06-03/05/10 的「契约对齐登记」与
// V06-13 的「状态口径」段被误剔。修后口径（DESIGN §2.6：派生状态区 = 状态列 + 卡片小节的「施工备注」段 +
// 勾选位）：只有**以状态标签开头且不含勾选位**的**独立**段落才排除。
//
// 本脚本只读：真实 PLAN.md 首尾 sha256 对照（**零写入**），不碰账本/服务；**零模型调用**。
// 覆盖：受控夹具（机制证据，先失败后过）+ 真实 PLAN（V09-09 十条真恢复、改状态措辞仍属定义且改哈希、
// 勾选位/真施工备注内容变化不动定义、引用块与长括注仍排除、被误剔的真实定义已回定义区、逐卡不变量）。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  classifyPlanRegions,
  definitionOnlyText,
  importTaskDefinitions,
  planDefinitionDigest,
} from "../src/server/work/plan";

const REPO = process.cwd();
const PLAN_PATH = path.join(REPO, "PLAN.md");

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
const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

const planBefore = fs.readFileSync(PLAN_PATH, "utf8");
const planHashBefore = sha256(planBefore);

// ── 受控夹具构造器（与 v06-03 同款最小结构：第一张表头含 卡号/依赖/完成证据）──
const planFixture = (rows: string[], cards: string[]): string =>
  [
    "# 夹具施工图",
    "",
    "## 当前施工入口",
    "",
    "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
    "",
    ...cards,
  ].join("\n");

const regionKindOfLine = (map: ReturnType<typeof classifyPlanRegions>, line: number): string[] =>
  map.regions
    .filter((r) => line >= r.line_start && line <= r.line_end)
    .map((r) => r.kind);

const lineOf = (doc: string, needle: string): number => {
  const lines = doc.split(/\r?\n/);
  const idx = lines.findIndex((l) => l.includes(needle));
  return idx + 1;
};

// 夹具里的检查项提取（用 importTaskDefinitions 走真实解析路径）
const checksOf = (doc: string, id: string) => {
  const { definitions } = importTaskDefinitions(doc);
  const def = definitions.find((d) => d.task_id === id);
  return def?.acceptance?.checks ?? [];
};

const STATE_LABELS = ["施工备注", "备注", "状态"];
const normalize = (label: string) => label.replace(/[（(][^\n]*$/, "").trim();

console.log("=".repeat(72));
info("V09-61 派生状态段判据边界验证（plan.ts isStateParagraph 共同机制）");
console.log("=".repeat(72));

// ═══════════════════ ① 受控夹具：机制（先失败后过） ═══════════════════
info("");
info("═══ ① 受控夹具：机制边界 ═══");

// F-1：**纯伪状态表头** 与后续验收条同段 —— 验收条不得被吞。
const fx1 = planFixture(
  ["| F-1 | todo | 伪状态表头 | 用户本轮授权 | 记录 |"],
  [
    "### F-1 伪状态表头",
    "",
    "**设计依据**：§2。",
    "",
    "**状态**：这句话看起来像派生状态段的表头，但它与验收条同段。",
    "- [ ] 验收甲：伪状态表头之后的验收条之一。",
    "- [ ] 验收乙：伪状态表头之后的验收条之二。",
    "",
  ],
);
{
  const checks = checksOf(fx1, "F-1");
  ok(
    checks.length === 2 && checks[0].text.includes("验收甲") && checks[1].text.includes("验收乙"),
    `F-1 纯伪状态表头（**状态**：）+ 同段两条验收 ⇒ 两条都解析（实得 ${checks.length}）`,
  );
}

// F-2：复合加粗标签里含「状态」二字 —— 整段不得被当状态段剔除（V09-09 形状）。
const fx2 = planFixture(
  ["| F-2 | todo | 复合标签 | 用户本轮授权 | 记录 |"],
  [
    "### F-2 复合标签",
    "",
    "**设计依据**：§2。",
    "",
    "- [ ] 甲 **文档／状态／蓝图三方同步**：抽查互相不矛盾。",
    "- [ ] 乙 **备注口径对齐**：备注与状态都要谈。",
    "",
  ],
);
{
  const checks = checksOf(fx2, "F-2");
  ok(
    checks.length === 2 && checks[0].text.includes("文档／状态／蓝图三方同步"),
    `F-2 复合标签（**文档／状态／蓝图三方同步**：/ **备注口径对齐**：）不整段剔除 ⇒ 两条都解析（实得 ${checks.length}）`,
  );
}

// F-3：多行/嵌套列表里的普通「状态」词 —— 不误删（列表行留定义区）。
const fx3 = planFixture(
  ["| F-3 | todo | 列表状态词 | 用户本轮授权 | 记录 |"],
  [
    "### F-3 列表状态词",
    "",
    "**设计依据**：§2。",
    "",
    "- 普通列表项谈「状态」与「备注」，但它不是独立的派生状态段。",
    "  - 嵌套子项也说「状态」。",
    "- [ ] 验收丙：列表里的检查项照常解析。",
    "",
  ],
);
{
  const map = classifyPlanRegions(fx3);
  const listLine = lineOf(fx3, "普通列表项谈");
  const nestedLine = lineOf(fx3, "嵌套子项也说");
  const checkLine = lineOf(fx3, "验收丙");
  const listInState = regionKindOfLine(map, listLine).includes("state");
  const nestedInState = regionKindOfLine(map, nestedLine).includes("state");
  const checks = checksOf(fx3, "F-3");
  ok(
    !listInState && !nestedInState && checks.length === 1 && checks[0].text.includes("验收丙"),
    `F-3 多行/嵌套列表里的普通「状态」词不误删（列表行在定义区、验收条解析：${checks.length}）`,
  );
  ok(
    regionKindOfLine(map, checkLine).includes("definition"),
    "F-3 列表里的检查项行落在定义区（不被状态段吞）",
  );
}

// F-4：真正的独立派生状态段仍排除（长括注 / 引用块 / 引用块加粗 / 纯状态标签）。
const fx4 = planFixture(
  ["| F-4 | todo | 真状态段 | 用户本轮授权 | 记录 |"],
  [
    "### F-4 真状态段",
    "",
    "**设计依据**：§2。",
    "",
    "**施工备注（2026-01-01 交付；证据 `.工作台/evidence/F-4/1/`，流水 PROGRESS 同日条）**：长括注独立段，不进定义。",
    "",
    "> 施工备注（落地时补，卡片内容未改）：引用块独立段，不进定义。",
    "",
    "> **施工备注（2026-09-25 复核批次同步）**：引用块加粗长括注，独立段，不进定义。",
    "",
    "**状态**：todo；独立状态段，不进定义。",
    "",
    "**交付**：定义段照常进定义。",
    "",
  ],
);
{
  const map = classifyPlanRegions(fx4);
  const def = definitionOnlyText(fx4, map);
  const cases: [string, string][] = [
    ["longBold", "**施工备注（2026-01-01 交付"],
    ["quotePlain", "> 施工备注（落地时补"],
    ["quoteBold", "> **施工备注（2026-09-25 复核批次同步）**"],
    ["pureState", "**状态**：todo；独立状态段"],
  ];
  for (const [name, needle] of cases) {
    const line = lineOf(fx4, needle);
    ok(regionKindOfLine(map, line).includes("state"), `F-4.${name} 独立状态段判为派生状态区（${needle.slice(0, 24)}…）`);
  }
  ok(
    !def.includes("长括注独立段") && !def.includes("引用块独立段") && !def.includes("独立状态段，不进定义"),
    "F-4 四个独立状态段的正文都不进 definitionOnlyText",
  );
  ok(def.includes("**交付**：定义段照常进定义。"), "F-4 定义段照常进 definitionOnlyText");
}

// F-5：**状态**：… 与紧跟其后的验收条同段时，段内其余普通行也不被整段剔除（除状态标题外的内容保留）。
const fx5 = planFixture(
  ["| F-5 | todo | 混合段 | 用户本轮授权 | 记录 |"],
  [
    "### F-5 混合段",
    "",
    "- [ ] 验收丁：紧随**状态**：标题之后。",
    "",
  ],
);
{
  const checks = checksOf(fx5, "F-5");
  ok(checks.length === 1 && checks[0].text.includes("验收丁"), `F-5 段首即**状态**：仍解析验收条（实得 ${checks.length}）`);
}

// ═══════════════════ ② 真实 PLAN：V09-09 十条真恢复 ═══════════════════
info("");
info("═══ ② 真实 PLAN.md（V09-09 十条 + 定义哈希判据） ═══");

const real = importTaskDefinitions(planBefore);
const realMap = classifyPlanRegions(planBefore);
const v09_09 = real.definitions.find((d) => d.task_id === "V09-09");
const v0909Checks = v09_09?.acceptance?.checks ?? [];
ok(v0909Checks.length === 10, `V09-09 十条检查全部解析（实得 ${v0909Checks.length}）`);
ok(
  v0909Checks.some((c) => c.text.includes("文档／状态／蓝图三方同步")),
  "V09-09 ⑥「**文档／状态／蓝图三方同步**：」在解析出的检查里（不再整段被剔除）",
);
ok(
  v0909Checks.filter((c) => /^(?:chk-v09-09-\d{2}\s+)?[①②③④⑤⑥⑦⑧⑨⑩]/.test(c.text)).length === 10,
  "V09-09 十条都带 ①–⑩ 序号（无漏条）",
);

// R2：改 V09-09 其中「状态」措辞 ⇒ 仍属定义（仍十条）且定义哈希改变。
const editedState = planBefore.replace(
  "**文档／状态／蓝图三方同步**",
  "**文档／运行状态／蓝图三方同步**",
);
ok(editedState !== planBefore, "R2 变异守卫：V09-09 ⑥ 的「状态」措辞替换确实生效");
{
  const edited = importTaskDefinitions(editedState);
  const checks = edited.definitions.find((d) => d.task_id === "V09-09")?.acceptance?.checks ?? [];
  ok(checks.length === 10, `R2 改「状态」措辞后 V09-09 仍十条（实得 ${checks.length}）`);
  ok(checks.some((c) => c.text.includes("文档／运行状态／蓝图三方同步")), "R2 改动后的正文进了定义（检查项文本已变）");
  ok(
    planDefinitionDigest(editedState) !== planDefinitionDigest(planBefore),
    "R2 改「状态」措辞改变全局定义哈希（定义内容确实变了）",
  );
}

// R3：勾选位变化不改定义。
const toggled = planBefore.replace("- [ ] chk-v09-09-01 ① **六图真实 UI**", "- [x] chk-v09-09-01 ① **六图真实 UI**");
ok(toggled !== planBefore, "R3 变异守卫：V09-09 ① 勾选位替换确实生效");
{
  ok(
    planDefinitionDigest(toggled) === planDefinitionDigest(planBefore),
    "R3 勾选位变化不改定义哈希（勾选位是派生位）",
  );
  // 只比“定义哈希”这一口径（whole TaskDefinition 里含 plan_revision = 整篇文档哈希，勾选位一变它必变）
  const beforeSha = real.report.tasks.find((t) => t.task_id === "V09-09")?.definition_sha256;
  const afterSha = importTaskDefinitions(toggled).report.tasks.find((t) => t.task_id === "V09-09")?.definition_sha256;
  ok(beforeSha === afterSha, "R3 勾选位变化后 V09-09 的单卡定义哈希不变（勾选位不进定义）");
}

// R4：真正的施工备注内容变化不改定义。
const noteLine = planBefore.split(/\r?\n/).find((l) => l.startsWith("**施工备注（2026-09-20 交付；子代理执行、父代理独立复跑验收；证据 `.工作台/evidence/V06-03/")) ?? "";
ok(noteLine !== "", "R4 找到 V06-03 的真实施工备注行");
const noteEdited = planBefore.replace(noteLine, `${noteLine}（夹具改动：备注正文变化。）`);
ok(noteEdited !== planBefore, "R4 变异守卫：施工备注正文替换确实生效");
{
  ok(
    planDefinitionDigest(noteEdited) === planDefinitionDigest(planBefore),
    "R4 真正施工备注内容变化不改定义哈希（备注段是派生状态区）",
  );
}

// R5：被同因误剔的真实定义已回定义区（如实列明）。
{
  const def = definitionOnlyText(planBefore, realMap);
  const restored: [string, string][] = [
    ["V06-03", "契约对齐登记（审计 R20260920-1，C015）"],
    ["V06-05", "契约对齐登记（审计 R20260920-1，C016"],
    ["V06-10", "契约对齐登记（审计 R20260920-1，C017）"],
    ["V06-13", "【2026-09-20 状态口径（第二轮裁定后）】"],
  ];
  for (const [card, needle] of restored) {
    ok(def.includes(needle), `R5 ${card} 被同因误剔的「${needle.slice(0, 20)}…」已回到定义区`);
  }
}

// R6：真实 PLAN 里引用块/长括注的独立施工备注仍排除。
{
  const cases: [string, string][] = [
    ["V09-04", "**施工备注（2026-09-25 复核批次同步）**"],
    ["U2", "> 施工备注（U2 落地时补，卡片内容未改）"],
  ];
  for (const [name, needle] of cases) {
    const line = lineOf(planBefore, needle);
    ok(line > 0 && regionKindOfLine(realMap, line).includes("state"), `R6 真实 ${name} 的独立施工备注段仍判派生状态区`);
  }
}

// R7：逐卡不变量——所有 state 段都以状态标签开头、且不含勾选位行；且没有任何 check 行落在 state 段。
{
  const lines = planBefore.split(/\r?\n/);
  let badState = 0;
  for (const r of realMap.regions) {
    if (r.kind !== "state") continue;
    const text = lines.slice(r.line_start - 1, r.line_end).join("\n");
    const body = text.split("\n").filter((l) => l.trim() !== "");
    const first = body[0] ?? "";
    const stripped = first.replace(/^\s*(?:>\s*)*/, "").replace(/^\s*[-*+]\s+/, "");
    const boldM = /^\*\*([^\n]*?)\*\*\s*[：:]/.exec(stripped);
    const startOk =
      (boldM !== null && STATE_LABELS.includes(normalize(boldM[1]))) ||
      /^\s*(备注|施工备注|状态)\s*(?:[（(][^）)\n]*[）)])?\s*[：:]/.test(first.replace(/^\s*(?:>\s*)+/, ""));
    const hasCheck = text.split("\n").some((l) => /^\s*[-*]\s*\[[xX ]\]/.test(l));
    if (!startOk || hasCheck) badState++;
  }
  ok(badState === 0, `R7 全部 state 段都以状态标签开头且不含勾选位（越界段 ${badState}）`);

  const stateLines = new Set<number>();
  for (const r of realMap.regions) {
    if (r.kind !== "state") continue;
    for (let i = r.line_start; i <= r.line_end; i++) stateLines.add(i);
  }
  let checkInState = 0;
  for (const def of real.definitions) for (const c of def.acceptance?.checks ?? []) if (stateLines.has(c.line)) checkInState++;
  ok(checkInState === 0, `R7 没有任何已解析检查项落在 state 段（越界 ${checkInState}）`);
}

// R8：逐卡明细（真实解析增量）——V09-09 从 0 → 10；总数 394 → 404 → 413（2026-10-09 追加 V09-62 后）。
{
  const total = real.definitions.reduce((a, d) => a + (d.acceptance?.checks.length ?? 0), 0);
  ok(real.definitions.length === 90, `真实 PLAN 解析出 90 张卡（实得 ${real.definitions.length}）`);
  ok(total === 413, `真实 PLAN 解析出的检查项总数 = 413（修前 404；实得 ${total}）`);
}

// ── 只读证明 ──
const planHashAfter = sha256(fs.readFileSync(PLAN_PATH, "utf8"));
ok(planHashBefore === planHashAfter, `PLAN.md 首尾 sha256 一致（零写入）：${planHashAfter.slice(0, 16)}…`);

console.log("");
console.log(`[verify] 结果：${passCount} PASS / ${failCount} FAIL`);
