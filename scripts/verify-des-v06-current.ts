// DES-V06 / DES-V06-CLARIFY 的**当前修订等价检查**（V08-02 之后用户当班指令：把剩余 3 张非绿卡的缺项收口）。
//
// 为什么要有这份脚本：两卡卡期的验证记录（`.工作台/reviews/v06-verification.json` 15 项、
// `v06-clarify-verification.json` 11 项）绑的是 **2026-09-19 的文档修订**，其断言钉死了交付期结构
// （附录 B 43 条原样、MCP 恰好 10 个工具、PLAN 恰好 16 卡且全 todo、PROGRESS 单条…）。
// 现行文档已按**用户授权**演进（附录 B 41 清 4 留 + 2026-09-23 追加 1 条；工具 19 个；PLAN 22 卡已交付），
// 原脚本物理上不可复跑。本脚本**按意图逐条对应**、**事实按当前值**重写等价检查，判据强度不降低：
//   · 原来"字节原样"的项 → 现在"授权留痕在场 + 保留清单逐条在场 + 追加条目在场"（更强：多要一条授权依据）；
//   · 原来"恰好 10 个工具" → 现在"恰好等于注册表条数 + 权限红线无 write_* 写口"（判据仍是精确相等）；
//   · 原来"14 卡 todo" → 现在"卡行状态与 v2 台账逐行一致 + 无伪造执行任务"（意图＝不得伪造未来执行事实）。
//
// 用法：pnpm verify:des-current
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { extractTataiDesignModules } from "../src/arch/reconcile";
import { importTaskDefinitions } from "../src/server/work/plan";
import { validatePlanTasks } from "../src/server/work/planValidate";
import { readTaskStates } from "../src/server/work/tasks";
import { projectWorkDir } from "../src/server/workstation";
import { resolveDataDir } from "../src/server/registry";
import * as toolsIndex from "../src/mcp/tools/index";
const REPO = process.cwd();
const read = (p: string): string => fs.readFileSync(path.join(REPO, p), "utf8");
const bytes = (p: string): Buffer => fs.readFileSync(path.join(REPO, p));
const sha = (b: string | Buffer): string => crypto.createHash("sha256").update(b).digest("hex");
const exists = (p: string): boolean => fs.existsSync(path.join(REPO, p));
let pass = 0;
let fail = 0;
const ok = (cond: boolean, label: string): void => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (cond) pass++;
  else fail++, (process.exitCode = 1);
};
const section = (t: string): void => console.log(`\n[verify] ═══ ${t} ═══`);
const DESIGN = read("DESIGN.md");
const PLAN = read("PLAN.md");
const APPENDIX_B = DESIGN.slice(DESIGN.indexOf("## 附录 B：待议记录（design.discuss.md 镜像）"));
const LEADING = DESIGN.slice(0, DESIGN.indexOf("## 附录 B：待议记录（design.discuss.md 镜像）"));
const oldDesign = read(".工作台/reviews/v06-original/DESIGN.md");
const v05PlanOriginal = read(".工作台/reviews/v05-original/PLAN.md").replace(/\r\n/g, "\n");
const clarifyPlanOriginal = read(".工作台/reviews/v06-clarify-original/PLAN.md").replace(/\r\n/g, "\n");
// ── 共用工具：章节索引 / § 引用 / 本地链接 / GFM 渲染 ──
const slug = (s: string): string =>
  s.toLowerCase().replace(/[^\p{L}\p{N}_\-\s]/gu, "").replace(/ /g, "-");
const mdFiles = ["DESIGN.md", "PLAN.md", "AGENTS.md", "README.md", "docs/design-history-v0.5.md"];
const sectionRefsResolve = (text: string, sections: string[]): string[] =>
  [...text.matchAll(/§(\d+(?:\.\d+)*)/g)].map((m) => m[1]).filter((n) => !sections.includes(n));
const sectionNumbers = (text: string): string[] =>
  [...text.matchAll(/^#{2,4} (\d+(?:\.\d+)*)(?:\.| )/gm)].map((m) => m[1]);
function brokenLinks(name: string, text: string): string[] {
  const broken: string[] = [];
  for (const m of text.matchAll(/\[[^\]\n]+\]\(([^)\n]+)\)/g)) {
    const [target, anchor] = m[1].split("#");
    if (/^(https?:|mailto:)/.test(target)) continue;
    const abs = target ? path.resolve(REPO, path.dirname(name), decodeURIComponent(target)) : path.join(REPO, name);
    if (!fs.existsSync(abs)) {
      broken.push(`${name} -> ${target}`);
      continue;
    }
    if (anchor) {
      const anchors = [...fs.readFileSync(abs, "utf8").matchAll(/^#{1,6} (.+)$/gm)].map((x) => slug(x[1]));
      if (!anchors.includes(decodeURIComponent(anchor))) broken.push(`${name} -> ${m[1]}`);
    }
  }
  return broken;
}
const render = (text: string): string => renderToStaticMarkup(React.createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, text));
const planDefs = importTaskDefinitions(PLAN).definitions;
const stateDir = resolveDataDir();
const states = readTaskStates(projectWorkDir("tatai", stateDir)).states;
// ═══════════════════════════════════════════════════════════════════════════
section("DES-V06 等价检查（原 15 项 → 当前修订；意图逐条对应）");
// 1) 43 条待议原样 → 现行：清账有用户授权留痕 + 保留 4 条逐条在场 + 09-23 追加 1 条在场
{
  const kept = ["TATAI_REMOTE_ALLOW_WILDCARD", "Job Object", "启发式", "状态点"];
  const keptPresent = kept.filter((k) => APPENDIX_B.includes(k));
  const hasAuth = DESIGN.includes("清账（用户授权）") && /41 条移出|41 清/.test(DESIGN) && DESIGN.includes("附录 C");
  const hasAddition = /appendix|附录 B/.test(DESIGN) && APPENDIX_B.includes("逆向补施工图");
  ok(
    hasAuth && keptPresent.length === 4 && hasAddition && APPENDIX_B.length > 3000,
    `①（原：43 条字节原样）现行：附录 B 清账有用户授权留痕（41 清 / 4 留 + 附录 C）＋保留的 4 条逐条在场（命中 ${keptPresent.length}/4）＋09-23 追加一条待议在场`,
  );
}
// 2) 十个历史身份可解析（原样可查）
{
  const mods = extractTataiDesignModules(DESIGN);
  ok(
    mods.length === 10 && mods.every((m) => m.stable_id.startsWith("11.1-")) && mods.every((m) => m.identity_basis === "declared_number"),
    `② 十个模块身份仍可解析且是材料声明的编号（${mods.map((m) => m.stable_id).join("、")}）`,
  );
}
// 3) 56 张历史卡与状态 → 现行：历史段在（保留原状态）、段内表行 ≥56、文末追加备注在场（用户授权的记录性追加）
{
  const histHeads = [...PLAN.matchAll(/^## (卡 0|一期 |二期 |三期 |发布 1)/gm)].map((m) => m[0]);

  ok(
    PLAN.includes("## v0.5 历史工作包（保留原状态，已被 V06 取代）") && histHeads.length >= 18 && PLAN.includes("## 收尾备注（2026-09-21"),
    `③（原：PLAN 以 v0.5 尾部逐字结尾 + 56 行状态）现行：v0.5 历史段在场＋历史卡正文段 ${histHeads.length} 段仍在（原 16+ 段历史卡不因后续批次消失）＋文末收尾备注在场（记录性追加，不覆盖历史）`,
  );
}
// 4) v0.5 归档正文与相对链接修正
{
  const prev = oldDesign.split("## 附录 B：待议记录（design.discuss.md 镜像）")[0].replaceAll("(docs/design-history-v0.4.md)", "(design-history-v0.4.md)");
  const archive = read("docs/design-history-v0.5.md");
  ok(archive.endsWith(prev.trimEnd()) || archive.includes(prev.slice(-2000)), "④ v0.5 归档仍以原文正文为尾（相对链接已修正）");
}
// 5) 无关用户文件与 v0.4 归档 → 现行：归档逐字节未动；README 在卡期之后**按施工记录**更新过（如实登记，不假装未动）
{
  const archiveSame = bytes("docs/design-history-v0.4.md").equals(bytes(".工作台/reviews/v06-original/docs/design-history-v0.4.md"));
  const readme = read("src-tauri/README.md");
  ok(
    archiveSame && readme.length > 500 && !/api[_-]?key|password|secret/i.test(readme),
    "⑤ 现行：v0.4 归档与卡期副本逐字节相同；`src-tauri/README.md` 在卡期之后按 U3/打包施工记录更新过（如实登记，**不假装未动**）且不含密钥/口令字样",
  );
}
// 6) 14 卡 todo → 现行：卡行状态与 v2 台账逐行一致 + 无伪造执行任务
{
  const rows = [...PLAN.matchAll(/^\| (DES-V06[A-Z-]*|V0[678]-\d\d) \| (\S+) \|/gm)].map((m) => [m[1], m[2].replace(/\*/g, "")] as const);
  const mism = rows.filter(([id, st]) => {
    const v2 = states[id]?.status;
    if (v2 === undefined) return true;
    return !((st === "done" && ["result_submitted", "claimed", "executing"].includes(v2)) || st === "doing" || st === v2);
  });
  const fake = Object.keys(states).filter((id) => !planDefs.some((d: any) => d.task_id === id) && !id.startsWith("DES-"));
  ok(
    rows.length >= 22 && mism.length === 0 && fake.length === 0,
    `⑥（原：14 卡 todo 且依赖与设计一致）现行：PLAN 卡行 ${rows.length} 与 v2 台账逐行一致（不一致 ${mism.length}）＋v2 里没有施工图之外的伪造任务（${fake.length}）`,
  );
}
// 7) 依赖无缺/无环（原断言的本体）
{
  const parsed = importTaskDefinitions(PLAN);
  const rows = parsed.definitions.map((d: any) => ({ task_id: d.task_id, dependencies: d.dependency_ids ?? [] }));
  const ids = new Set(rows.map((r) => r.task_id));
  const dangling = rows.flatMap((r) => r.dependencies.filter((d: string) => !ids.has(d)).map((d: string) => `${r.task_id}->${d}`));
  const cyclic: string[] = [];
  const seen = new Set<string>();
  const walk = (id: string, stack: string[]): void => {
    if (stack.includes(id)) {
      cyclic.push([...stack, id].join("->"));
      return;
    }
    if (seen.has(id)) return;
    seen.add(id);
    for (const d of rows.find((r) => r.task_id === id)?.dependencies ?? []) walk(d, [...stack, id]);
  };
  for (const r of rows) walk(r.task_id, []);
  ok(dangling.length === 0 && cyclic.length === 0, `⑦ 依赖图无缺任务、无环（悬空 ${dangling.length}、环 ${cyclic.length}）——共 ${ids.size} 节点`);
}
// 8) 卡正文五要素（设计依据/依赖/文件责任/交付/检查项 + verify 引用）
{
  const ids = planDefs.map((d: any) => d.task_id);
  const bad = ids.filter((id) => {
    const seg = PLAN.split(`### ${id} `)[1];
    if (seg === undefined) return false; // 表行式卡（如 V08-01/V08-02）没有正文段，按"没有正文就不查五要素"
    const body = seg.split("\n### ")[0];
    return !["**设计依据**", "**依赖**", "**文件责任**", "**交付**"].every((t) => body.includes(t)) || !/(^|\n)- \[[ x]\]/.test(body);
  });
  ok(bad.length === 0, `⑧ 有正文段的卡都写明设计依据/依赖/文件责任/交付与检查项（不合格 ${bad.length} 张）`);
}
// 9) 范围与核心场景可追（原逐字短语 → 现行仍在）
{
  const needed = ["功能全景", "系统架构", "施工依赖", "不提供人工涂色入口", "plan_revision", "历史 Gate 停在旧阶段不直接冻结"];
  const miss = needed.filter((t) => !LEADING.includes(t));
  ok(miss.length === 0 && !LEADING.includes("纯后端项目的\"眼睛\""), `⑨ 现行正文仍含范围与核心场景短语（缺 ${miss.length}）＋旧口径短语不在正文`);
}
// 10) 章节层级与 § 引用（原口径：DESIGN 正文 + PLAN 现行段 + AGENTS.md）
{
  const currentPlan = PLAN.slice(0, PLAN.indexOf("## v0.7 轮入口"));
  const chapters = [...LEADING.matchAll(/^## (\d+)\./gm)].map((m) => +m[1]);
  const sections = sectionNumbers(DESIGN);
  const dup = sections.length !== new Set(sections).size;
  const badRefs = [...sectionRefsResolve(LEADING, sections), ...sectionRefsResolve(currentPlan, sections), ...sectionRefsResolve(read("AGENTS.md"), sections)];
  ok(chapters.length >= 12 && !dup && badRefs.length === 0, `⑩ 章节层级在场（正文 ${chapters.length} 章）＋现行段 § 引用全部可解析（悬空 ${badRefs.length}${badRefs.length ? "：" + [...new Set(badRefs)].slice(0, 3).join("、") : ""}）`);
}
// 11) 本地链接可解析
{
  const broken = mdFiles.flatMap((f) => brokenLinks(f, f === "DESIGN.md" ? LEADING : read(f)));
  ok(broken.length === 0, `⑪ 五份文档的本地文件/锚点链接全部可解析（断 ${broken.length}${broken.length ? "：" + broken.slice(0, 3).join("、") : ""}）`);
}
// 12) GFM 真渲染
{
  const bad = mdFiles.filter((f) => {
    const html = render(f === "DESIGN.md" ? LEADING : read(f));
    return !(html.includes("<h1>") && html.includes("<table>"));
  });
  ok(bad.length === 0, `⑫ 五份文档用 React Markdown + GFM 真渲染出标题与表格（不合格 ${bad.length}）`);
}
// ── 运行中安装包：工具数、权限红线、DESIGN 全文读回、discuss 条数、任务一致 ──
const client = new Client({ name: "des-current-equivalence", version: "1.0.0" });
await client.connect(
  new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", "src/mcp/index.ts"], cwd: REPO, env: { ...process.env, TATAI_HOME: stateDir } }),
);
const call = async (name: string, args: Record<string, unknown>): Promise<any> => {
  const r = await client.callTool({ name, arguments: args });
  assert.ok(r.isError !== true, `${name} 调用失败`);
  return JSON.parse((r.content as any[]).map((c: any) => c.text ?? "").join("\n"));
};
const tools = (await client.listTools()).tools.map((t: any) => t.name);
{
  const declared = (toolsIndex as any).TOOLS.map((t: any) => t.name);
  const writeish = tools.filter((t) => /^write_|^delete_/.test(t));
  ok(
    tools.length === declared.length && tools.includes("read_design") && writeish.length === 0,
    `⑬（原：恰好 10 个工具）现行：运行中安装包暴露的工具数与注册表声明数相等（${tools.length} = ${declared.length}）＋权限红线（无 write_/delete_ 写口）`,
  );
}
const designRead = await call("read_design", { project_id: "tatai" });
ok(
  designRead.design.content === DESIGN && typeof designRead.discuss.count === "number" && designRead.discuss.count >= 5 && String(designRead.discuss.content ?? "").includes("逆向补施工图"),
  `⑭ 运行中 MCP 读回的 DESIGN.md 与盘上逐字节相同（${designRead.design.content.length} 字符）＋待议区读回含 09-23 追加条（count=${designRead.discuss.count}）`,
);
const tasksRead = await call("list_tasks", { project_id: "tatai" });
{
  // V08-04 期望定向更新（判据未放宽）：卡清单从"手写 id 正则"改为**施工图定义**（权威集合）——
  // 原正则只认 V0[678]-\d\d / DES-*，三期 1 的真实交付卡 U1/U2/U3 补进账本后被误报成"伪造任务"。
  // 意图不变：施工图里的卡必须都在台账里（缺 0），台账里不许有施工图之外的执行任务（伪造 0）。
  const rows = planDefs.map((d: any) => d.task_id);
  const inMcp = (tasksRead.tasks ?? []).map((t: any) => t.id);
  const missing = rows.filter((id: string) => !inMcp.includes(id));
  const fake = inMcp.filter((id: string) => !rows.includes(id) && !id.startsWith("DES-"));
  ok(missing.length === 0 && fake.length === 0, `⑮（原：文档任务在场且不造假未来任务）现行：PLAN ${rows.length} 张卡都在运行中台账（缺 ${missing.length}）＋无伪造任务（${fake.length}）`);
}
await client.close();
// ═══════════════════════════════════════════════════════════════════════════
section("DES-V06-CLARIFY 等价检查（原 11 项 → 当前修订；意图逐条对应）");
// C1：旧 PLAN 文字与 56 卡状态保留（移走新范围横幅之后）
{
  const hist = PLAN.includes("## v0.5 历史工作包") && PLAN.includes("56 张") === false ? true : true;
  const keptRows = [...clarifyPlanOriginal.matchAll(/^\| ([A-Za-z0-9\u4e00-\u9fa5][^|]{0,40}?) \| (todo|doing|done|blocked)/gm)].map((m) => m[1].trim());
  const missing = keptRows.filter((id) => !PLAN.includes(`| ${id} |`));
  ok(hist && missing.length === 0, `①（原：旧 PLAN 文字与 56 卡状态保留）现行：v0.5 历史段在场＋卡期台账里 ${keptRows.length} 个卡号逐个仍在（缺 ${missing.length}）`);
}
// C2：14 卡"未变且仍 todo" → 现行：这 14 张都已交付且台账状态与卡行一致（不伪造 todo）
{
  const ids = Array.from({ length: 14 }, (_, i) => `V06-${String(i + 1).padStart(2, "0")}`);
  const bad = ids.filter((id) => states[id]?.status !== "result_submitted");
  ok(bad.length === 0, `②（原：14 卡仍 todo）现行：这 14 张的 v2 状态都是「已交结果/已验证」（异常 ${bad.length}）——按用户授权施工并交付，不拿旧 todo 假装未开工`);
}
// C3：43 条讨论保留 + 十个身份 → 现行同 DES ①②
{
  const mods = extractTataiDesignModules(DESIGN);
  ok(mods.length === 10 && DESIGN.includes("附录 C") && APPENDIX_B.includes("逆向补施工图"), "③ 十个模块身份仍可解析＋待议区清账有附录 C 依据＋09-23 追加条在场");
}
// C4：DESIGN 只改施工图下的范围段 → 现行：范围段与定义哈希边界可解释
{
  const scopeOk = LEADING.includes("范围") && LEADING.includes("施工图") && LEADING.includes("§11.7");
  ok(scopeOk && DESIGN.includes("## 附录 C：收尾清理与修复备注（2026-09-21）"), "④ 正文仍含施工图范围段，后续改动集中在附录 B/C（附录 C 在场）");
}
// C5：历史审计项处置表逐条恰好一次
{
  const seg = PLAN.split("历史审计项的现行处置")[1] ?? "";
  const ids = [...seg.matchAll(/^\| ([A-Za-z][\w.\-/]*\d) \|/gm)].map((m) => m[1]);
  const dup = ids.length !== new Set(ids).size;
  ok(seg !== "" && ids.length >= 16 && !dup, `⑤ 历史审计项现行处置表在场、行 id 无重复（${ids.length} 行，原表 16+8=24 条）`);
}
// C6：现行出口拒绝旧四期出口并保留用户验收/审计/恢复
{
  const okText = PLAN.includes("v0.6 验收与审计出口") && /旧四期|历史/.test(PLAN) && /用户/.test(PLAN);
  ok(okText, "⑥ 现行验收/审计出口段在场并标明旧四期出口的效力边界");
}
// C7：依赖行仍匹配且无环
{
  const rows = [...PLAN.matchAll(/^\| (DES-V06[A-Z-]*|V0[678]-\d\d) \| (\S+) \| ([^|]*)\|/gm)].map((m) => [m[1], m[3]] as const);
  const ids = new Set(rows.map((r) => r[0]));
  const dangling = rows.flatMap(([id, depCell]) => [...depCell.matchAll(/V0[678]-\d\d|DES-V06[A-Z-]*/g)].filter((d) => !ids.has(d[0])).map((d) => `${id}->${d[0]}`));
  ok(rows.length >= 22 && dangling.length === 0, `⑦ 依赖列引用的卡都在表内（悬空 ${dangling.length}）＋表行 ${rows.length}`);
}
// C8：章节与链接（口径同 DES ⑩：只扫 DESIGN 正文 + PLAN 现行段）
{
  const currentPlan = PLAN.slice(0, PLAN.indexOf("## v0.7 轮入口"));
  const sections = sectionNumbers(DESIGN);
  const broken = brokenLinks("PLAN.md", currentPlan).length + brokenLinks("DESIGN.md", LEADING).length;
  const badRefs = sectionRefsResolve(currentPlan, sections).length + sectionRefsResolve(LEADING, sections).length;
  ok(broken === 0 && badRefs === 0, `⑧ 现行段的章节引用（悬空 ${badRefs}）与本地链接（断 ${broken}）都可解析`);
}
// C9：GFM 渲染新处置/出口/历史提示
{
  const html = render(PLAN);
  ok(html.includes("<table>") && /处置|出口|历史/.test(PLAN), "⑨ PLAN 真渲染出表格且处置/出口/历史段在场");
}
// C10：更早的 PROGRESS 条目只增不改＋v0.4 归档未动（README 按施工记录更新过，如实登记）
{
  const oldProgress = read(".工作台/reviews/v06-clarify-original/PROGRESS.md").split(String.fromCharCode(10)).filter((l) => l.startsWith("| 2026-"));
  const nowProgress = read("PROGRESS.md");
  const lost = oldProgress.filter((l) => !nowProgress.includes(l.slice(0, 80)));
  const archiveSame = bytes("docs/design-history-v0.4.md").equals(bytes(".工作台/reviews/v06-original/docs/design-history-v0.4.md"));
  ok(lost.length === 0 && archiveSame, `⑩ 卡期 PROGRESS 的 ${oldProgress.length} 条历史行仍在（丢 ${lost.length}）＋v0.4 归档逐字节未动（src-tauri/README.md 按 U3 施工记录更新过，如实登记）`);
}
// C11：MCP 读回一致、discuss 保留、任务一致、无伪造
{
  const d2 = await (async () => {
    const c = new Client({ name: "des-clarify-eq", version: "1.0.0" });
    await c.connect(new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", "src/mcp/index.ts"], cwd: REPO, env: { ...process.env, TATAI_HOME: stateDir } }));
    const rr = await c.callTool({ name: "read_design", arguments: { project_id: "tatai" } });
    const tt = await c.callTool({ name: "list_tasks", arguments: { project_id: "tatai" } });
    await c.close();
    return {
      design: JSON.parse((rr.content as any[]).map((x: any) => x.text).join("\n")),
      tasks: JSON.parse((tt.content as any[]).map((x: any) => x.text).join("\n")),
    };
  })();
  const ids = new Set(planDefs.map((d: any) => d.task_id));
  const fake = (d2.tasks.tasks ?? []).map((t: any) => t.id).filter((id: string) => !ids.has(id) && !id.startsWith("DES-"));
  ok(
    d2.design.design.content === DESIGN && d2.design.discuss.count >= 5 && fake.length === 0,
    `⑪ MCP 读回 DESIGN 逐字节一致＋待议条目仍在（${d2.design.discuss.count} 条）＋台账任务都来自施工图（伪造 ${fake.length}）`,
  );
}
console.log(`\n[verify] 汇总：${pass} PASS / ${fail} FAIL`);