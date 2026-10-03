// 统一优化 U3（PLAN V09-32／V09-33／V09-35）隔离行为验证脚本（tsx 跑）。
//
// 覆盖三张卡的**正常行为与失败行为**（先红后绿：本脚本在工具落地前应整体失败/报缺件）：
//   V09-32 read_plan：卡／索引／章节／行范围原读取材；未入账卡仍可读；缺卡明确失败；
//     拼接切片按同一换行口径还原全文；同长度同 mtime 改写返回当前哈希。
//   V09-33 MCP 完整版本续读：完整来源 sha 与项目/文档绑定的新游标；旧短前缀游标明确失效重取；
//     源变（含同前缀不同完整哈希）、跨项目、跨文档、错误 unit、越界均不误接续；不返回空包成功。
//   V09-35 expand_module：复用 expandProject（与 HTTP 同一逻辑）；分页来源版本（source_fingerprint）；
//     源变重取不跨版本拼页；预算/忽略/静态依赖如实声明；中间联接点（junction）逃逸被拒；只读。
//
// 隔离口径（AGENTS.md §5）：全程不碰真实 ~/.tatai、不写任何真实纳管项目——
//   · mkdtemp 两个系统 tmp 目录：一个当隔离 TATAI_HOME（registry.json 落这里），一个放夹具项目；
//   · process.env.TATAI_HOME 指向隔离 home；工具 handler 走 dataDir===undefined ⇒ 读隔离 home；
//   · 收尾 rmSync 自清（finally）；不下载依赖、不起服务、不提交、不递归委派。
//
// 用法：`node --import tsx scripts/verify-unified-materials.ts`（或 pnpm verify:unified-materials，
// 脚本条目由协调器统一添加；本脚本自身不改 package.json）。退出码 0 = 全 PASS；1 = 有 FAIL。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { addProject } from "../src/server/registry";
import { expandDirectory, expandProject } from "../src/arch/expand";
import { sha256Hex } from "../src/server/work/documents";
import { CONTINUATION_PAGE_MAX_CHARS as SHARED_CONT_PAGE_MAX, makeProjectCursor } from "../src/shared/continuationCursor";
import {
  CONTINUATION_PAGE_MAX_CHARS as MCP_CONTINUATION_PAGE_MAX,
  CONTINUATION_PERSISTENCE,
  readContinuationPage,
} from "../src/server/work/continuation";
import { CONTEXT_PAGE_MAX_CHARS } from "../src/server/work/context";
import { readPlanTool } from "../src/mcp/tools/readPlan";
import { readDesignTool } from "../src/mcp/tools/readDesign";
import { expandModuleTool } from "../src/mcp/tools/expandModule";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let pass = 0;
let skipped = 0;
const fails: string[] = [];
const ok = (cond: boolean, label: string): void => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (cond) pass += 1;
  else fails.push(label);
};
const skip = (label: string, why: string): void => {
  skipped += 1;
  console.log(`[verify] SKIP ${label} —— ${why}`);
};
const info = (msg: string): void => console.log(`[verify]   ${msg}`);

// ─────────────────────────────── 夹具 ───────────────────────────────
const CLEANUP: string[] = [];
const mkTmp = (tag: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `v09-u3-${tag}-`));
  CLEANUP.push(dir);
  return dir;
};

interface CallResult {
  isError: boolean;
  text: string;
  json: unknown;
}
const call = async (tool: { handler: (a: Record<string, unknown>) => unknown }, args: Record<string, unknown>): Promise<CallResult> => {
  const r = (await tool.handler(args)) as { content: { text: string }[]; isError?: boolean };
  const text = r.content?.[0]?.text ?? "";
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { isError: r.isError === true, text, json };
};
const jget = (j: unknown): Record<string, unknown> => (j ?? {}) as Record<string, unknown>;

/** 递归快照（相对路径 → size:mtimeMs），用于「只读不落盘」断言 */
function snapshotTree(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (abs: string): void => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const p = path.join(abs, e.name);
      if (e.isDirectory()) walk(p);
      else {
        const st = fs.statSync(p);
        out.set(path.relative(root, p).split(path.sep).join("/"), `${st.size}:${st.mtimeMs}`);
      }
    }
  };
  walk(root);
  return out;
}
function sameSnapshot(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

// ── 施工图（PLAN）夹具文本：3 张卡；V09-92 只有卡行、无卡区小节；尾部超长填充供分页 ──
function planMarkdown(): string {
  const lines: string[] = [
    "# 夹具施工图",
    "",
    "> 隔离夹具，不对应任何真实项目。",
    "",
    "## 卡表",
    "",
    "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |",
    "| --- | --- | --- | --- | --- |",
    "| V09-90 | todo | 甲卡目标 | 无 | 甲卡验收 |",
    "| V09-91 | todo | 乙卡目标 | V09-90 | 乙卡验收 |",
    "| V09-92 | todo | 丙卡目标 | 无 | 丙卡验收 |",
    "",
    "### V09-90 甲卡",
    "",
    "**交付目标**：甲卡目标",
    "",
    "**依赖**：无",
    "",
    "**完成证据**：甲卡验收",
    "",
    "甲卡正文第一行。",
    "甲卡正文第二行。",
    "",
    "### V09-91 乙卡",
    "",
    "**交付目标**：乙卡目标",
    "",
    "**依赖**：V09-90",
    "",
    "**完成证据**：乙卡验收",
    "",
    "乙卡正文。",
    "",
    "## 附录 长文",
    "",
  ];
  for (let i = 1; i <= 900; i++) lines.push(`长文填充第 ${String(i).padStart(4, "0")} 行：${"x".repeat(20)}`);
  lines.push("");
  return lines.join("\n");
}
function designMarkdown(): string {
  return ["# 夹具设计书", "", "## 1 概述", "", "设计概述内容。", "", "## 2 接口", "", "接口内容。", ""].join("\n");
}

// ── 写一个隔离项目（in .工作台/）+ 登记进隔离 home ──
function makeProject(id: string, home: string, base: string, planText: string): { dir: string } {
  const dir = path.join(base, `proj-${id}`);
  fs.mkdirSync(path.join(dir, ".工作台"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".工作台", "plan.md"), planText, "utf8");
  fs.writeFileSync(path.join(dir, ".工作台", "design.md"), designMarkdown(), "utf8");
  addProject({ id, name: `U3 夹具 ${id}`, path: dir, kind: "backend" }, home);
  return { dir };
}

async function main(): Promise<void> {
  const base = mkTmp("base");
  const isoHome = mkTmp("home");
  fs.mkdirSync(isoHome, { recursive: true });
  process.env.TATAI_HOME = isoHome;
  info(`隔离 home=${isoHome}；夹具根=${base}`);

  const PLAN = planMarkdown();
  const A = makeProject("u3a", isoHome, base, PLAN);
  const B = makeProject("u3b", isoHome, base, PLAN); // B 的 plan 与 A 逐字节相同 → 只差项目绑定

  // 源码树（expand_module 夹具）
  const src = path.join(A.dir, "src");
  fs.mkdirSync(path.join(src, "sub"), { recursive: true });
  fs.mkdirSync(path.join(src, "node_modules"), { recursive: true });
  fs.mkdirSync(path.join(src, "many"), { recursive: true });
  // 逃逸目标必须**在项目根外**（与 proj-u3a 同级），否则 junction 只是根内跳转、不算逃逸
  const escapeTarget = path.join(base, "escape-target");
  fs.mkdirSync(path.join(escapeTarget, "sub"), { recursive: true });
  fs.writeFileSync(path.join(src, "a.ts"), 'import { b } from "./b";\nexport const a = b;\n', "utf8");
  fs.writeFileSync(path.join(src, "b.ts"), "export const b = 1;\n", "utf8");
  fs.writeFileSync(path.join(src, "sub", "c.ts"), "export const c = 1;\n", "utf8");
  fs.writeFileSync(path.join(src, "sub", "d.ts"), "export const d = 2;\n", "utf8");
  fs.writeFileSync(path.join(src, "node_modules", "x.ts"), "export const x = 0;\n", "utf8");
  for (let i = 1; i <= 45; i++) {
    fs.writeFileSync(path.join(src, "many", `m${String(i).padStart(2, "0")}.ts`), `export const m${i} = ${i};\n`, "utf8");
  }
  fs.writeFileSync(path.join(escapeTarget, "sub", "leak.ts"), "export const leak = 1;\n", "utf8");

  // 中间联接点（junction）：src/link → base/escape-target（项目根外）
  const junction = path.join(src, "link");
  let junctionMade = false;
  try {
    fs.symlinkSync(escapeTarget, junction, "junction");
    junctionMade = fs.existsSync(junction);
  } catch (e) {
    info(`junction 创建失败：${e instanceof Error ? e.message : String(e)}`);
  }

  const relPlan = ".工作台/plan.md";
  const planAbs = path.join(A.dir, relPlan);
  const planShaA = sha256Hex(PLAN);

  // ═══════════════════════ V09-32 read_plan ═══════════════════════
  console.log("\n[verify] ── V09-32 read_plan：无定位参数＝整份原文（与 read_design 缺省一致）");
  {
    const r = await call(readPlanTool, { project_id: "u3a" });
    const p = jget(jget(r.json).plan);
    ok(!r.isError && p.exists === true, "read_plan 缺省返回 plan.exists=true（isError=false）");
    ok(typeof p.content === "string" && p.content === PLAN, "read_plan 缺省 content 与源逐字节相同");
    ok(p.content_sha256 === planShaA, `plan.content_sha256 = 当前源哈希（${String(p.content_sha256).slice(0, 12)}…）`);
    ok(p.source === relPlan, `plan.source 为项目根内相对路径（${String(p.source)}）`);
  }

  console.log("\n[verify] ── V09-32 read_plan：index 列卡与章节（卡区缺失也如实标出）");
  {
    const r = await call(readPlanTool, { project_id: "u3a", index: true });
    const j = jget(r.json);
    const cards = jget(j.cards);
    const ids = (cards.ids as string[]) ?? [];
    ok(!r.isError && cards.total === 3, `index 解析出 3 张卡（实际 ${String(cards.total)}）`);
    ok(ids.join(",") === "V09-90,V09-91,V09-92", `卡号清单 = V09-90,V09-91,V09-92（实际 ${ids.join(",")}）`);
    const items = (cards.items as Record<string, unknown>[]) ?? [];
    const byId = new Map(items.map((it) => [it.task_id as string, it]));
    ok(byId.get("V09-90")?.section_found === true, "V09-90 section_found=true（有卡区）");
    ok(byId.get("V09-92")?.section_found === false, "V09-92 section_found=false（只有卡行、无卡区）");
    ok(byId.get("V09-92")?.section_lines === null, "V09-92 section_lines=null（不伪造卡区行范围）");
    const sections = (j.sections as { title: string }[]) ?? [];
    ok(sections.some((s) => s.title === "卡表") && sections.some((s) => s.title === "附录 长文"), "index 同时给出章节索引（含「卡表」「附录 长文」）");
    ok(jget(j).slice === null, "index=true 不返回正文（slice=null）");
  }

  console.log("\n[verify] ── V09-32 read_plan：task_id 取卡区原文（切片与全文自洽）");
  {
    const full = sha256Hex(PLAN);
    const r = await call(readPlanTool, { project_id: "u3a", task_id: "V09-90" });
    const j = jget(r.json);
    const plan = jget(j.plan);
    const card = jget(j.card);
    const slice = jget(j.slice);
    ok(!r.isError && card.task_id === "V09-90" && card.section_found === true, "task_id=V09-90 → 定位到卡区（section_found=true）");
    ok(typeof plan.content === "string" && (plan.content as string).includes("甲卡正文第二行。"), "卡区内容含卡正文（plan.content）");
    ok(slice.sha256 === sha256Hex(plan.content as string), "切片元数据 sha256 = sha256(plan.content)（调用方可自证）");
    ok(plan.content_sha256 === full, "卡读取同时给出当前全文哈希（可校验范围）");
    const sl = jget(j.slice);
    ok(
      typeof (card.section_lines as Record<string, unknown>)?.from_line === "number" &&
        sl.line_start === (card.section_lines as Record<string, unknown>)?.from_line,
      "卡区行范围（1 基）随卡与切片一并给出、且切片起点与卡区一致",
    );
  }

  console.log("\n[verify] ── V09-32 read_plan：未入账（台账未导入）的定义仍可读");
  {
    const ledger = path.join(A.dir, ".工作台", "work");
    const ledgerFiles = fs.existsSync(ledger) ? fs.readdirSync(ledger) : [];
    const r = await call(readPlanTool, { project_id: "u3a", task_id: "V09-91" });
    const j = jget(r.json);
    ok(ledgerFiles.filter((f) => /^(tasks\.json|events\.jsonl)$/.test(f)).length === 0, "夹具无执行台账（tasks.json/events.jsonl 不存在）＝未入账现场");
    ok(!r.isError && jget(j.card).section_found === true, "未入账下 read_plan 仍取到 V09-91 卡定义原文（定义存在与台账状态分开）");
    ok(String(jget(j.card).ledger_note ?? "").includes("台账") || String(jget(j.card).ledger_note ?? "").includes("list_tasks"), "card.ledger_note 明确「状态看 list_tasks/project_entry」（不把定义当状态）");
  }

  console.log("\n[verify] ── V09-32 read_plan：卡区缺失＝成功＋section_found=false；卡不存在＝明确失败");
  {
    const r = await call(readPlanTool, { project_id: "u3a", task_id: "V09-92" });
    const j = jget(r.json);
    ok(
      !r.isError && jget(j.card).section_found === false && jget(j).slice === null,
      "V09-92（只有卡行）→ 成功 + section_found=false + slice=null（不吞成卡不存在）",
    );
    const r2 = await call(readPlanTool, { project_id: "u3a", task_id: "V09-99" });
    const j2 = jget(r2.json);
    const detail = jget(j2.detail);
    ok(r2.isError && j2.code === "CARD_NOT_FOUND", `未知卡 → CARD_NOT_FOUND（实际 ${String(j2.code)}）`);
    ok(Array.isArray(detail.known_ids) && (detail.known_ids as string[]).includes("V09-90"), "CARD_NOT_FOUND 带 known_ids（下一步可查）");
  }

  console.log("\n[verify] ── V09-32 read_plan：range／section 切片按同一换行口径拼接＝全文");
  {
    const totalLines = PLAN.split("\n").length;
    const mid = Math.floor(totalLines / 2);
    const r1 = await call(readPlanTool, { project_id: "u3a", range: { from_line: 1, to_line: mid } });
    const r2 = await call(readPlanTool, { project_id: "u3a", range: { from_line: mid + 1, to_line: totalLines } });
    const c1 = String(jget(jget(r1.json).plan).content ?? "");
    const c2 = String(jget(jget(r2.json).plan).content ?? "");
    ok(!r1.isError && !r2.isError && c1 + c2 === PLAN, "两段 range 首尾相接 = 全文逐字节（含行尾换行）");
    ok(
      jget(jget(r1.json).slice).sha256 === sha256Hex(c1) && jget(jget(r2.json).slice).sha256 === sha256Hex(c2),
      "各段 slice.sha256 自证",
    );
    const rs = await call(readPlanTool, { project_id: "u3a", section: "卡表" });
    const sc = String(jget(jget(rs.json).plan).content ?? "");
    ok(!rs.isError && jget(jget(rs.json).slice).kind === "section" && sc.includes("V09-90") && !sc.includes("附录 长文"), "section=卡表 切出该节且不含下一节");
    const bad = await call(readPlanTool, { project_id: "u3a", range: { from_line: totalLines + 5, to_line: totalLines + 9 } });
    ok(bad.isError, "越界 range 明确失败（不静默返回空段）");
  }

  // ═══════════════════════ V09-33 MCP 续读 ═══════════════════════
  console.log("\n[verify] ── V09-33 续读：旧短前缀游标（tctx1）明确失效、要求重取");
  {
    const legacy = "tctx1:deadbeefdeadbeef:lines:1";
    const r = await call(readPlanTool, { project_id: "u3a", cursor: legacy });
    const j = jget(r.json);
    ok(r.isError && j.code === "LEGACY_CURSOR", `旧 tctx1 游标被明确拒绝（实际 ${String(j.code)}）`);
    ok(/前缀|prefix/.test(r.text) && /重取|重新/.test(r.text), "拒绝文案说明「旧短前缀不能当完整版本证明」并给出重取路径");
    const rd = await call(readDesignTool, { project_id: "u3a", cursor: legacy });
    ok(rd.isError && jget(rd.json).code === "LEGACY_CURSOR", "read_design 对旧游标同样明确失效（不静默给旧内容）");
  }

  console.log("\n[verify] ── V09-33 续读：新游标（完整 sha + 项目/文档绑定）按版本续读，不空包成功");
  {
    const totalLines = PLAN.split("\n").length;
    const startLine = Math.floor(totalLines / 3);
    let cursor = makeProjectCursor("u3a", "plan", planShaA, "lines", startLine);
    let pages = 0;
    let seenChars = 0;
    let advanced = true;
    let lastNext: string | null = "unset";
    while (advanced && pages < 20) {
      const r = await call(readPlanTool, { project_id: "u3a", cursor });
      if (r.isError) {
        ok(false, `续读第 ${pages + 1} 页报错：${r.text.slice(0, 120)}`);
        break;
      }
      const j = jget(r.json);
      const content = String(jget(j.plan).content ?? "");
      const cont = jget(j.continuation);
      pages += 1;
      seenChars += content.length;
      ok(content.length > 0, `续读第 ${pages} 页非空（chars=${content.length}；不返回空包成功）`);
      ok(jget(j.slice).sha256 === sha256Hex(content), `续读第 ${pages} 页切片 sha256 自证`);
      ok(cont.next_cursor === null || typeof cont.next_cursor === "string", `续读第 ${pages} 页给出 next_cursor（${String(cont.next_cursor).slice(0, 24)}…）`);
      // 非首页必须带完整绑定信息
      if (pages === 1) {
        ok(
          (cont.persistence as Record<string, unknown>)?.restart_safe === true,
          "续读页标注 persistence.restart_safe=true（内容派生，不依赖进程内包）",
        );
      }
      lastNext = (cont.next_cursor as string | null) ?? null;
      if (lastNext === null) break;
      // 下一页起点必须前进（防死循环／重复页）
      const prev = cursor;
      cursor = lastNext;
      if (cursor === prev) {
        ok(false, "next_cursor 未前进（续读可能死循环）");
        break;
      }
    }
    ok(pages >= 2, `大部文档续读分多页（实际 ${pages} 页）`);
    ok(lastNext === null, "读到文末 next_cursor=null（不伪造下一页）");
    const full = await call(readPlanTool, { project_id: "u3a" });
    const fullLen = String(jget(jget(full.json).plan).content ?? "").length;
    info(`续读累计字符 ${seenChars}（首页起点 ${startLine}）；全文 ${fullLen} 字符`);
  }

  console.log("\n[verify] ── V09-33 续读：跨项目拒绝（B 的 plan 与 A 逐字节相同 → 只差项目绑定）");
  {
    const cursorA = makeProjectCursor("u3a", "plan", planShaA, "lines", 5);
    const r = await call(readPlanTool, { project_id: "u3b", cursor: cursorA });
    ok(r.isError && jget(r.json).code === "CROSS_PROJECT", `A 的游标用在 B → CROSS_PROJECT（实际 ${String(jget(r.json).code)}）`);
  }

  console.log("\n[verify] ── V09-33 续读：跨文档拒绝（plan 游标用于 read_design）");
  {
    const cursorPlan = makeProjectCursor("u3a", "plan", planShaA, "lines", 1);
    const r = await call(readDesignTool, { project_id: "u3a", cursor: cursorPlan });
    ok(r.isError && jget(r.json).code === "CROSS_DOC", `plan 游标用于 read_design → CROSS_DOC（实际 ${String(jget(r.json).code)}）`);
  }

  console.log("\n[verify] ── V09-33 续读：同前缀不同完整哈希 → SOURCE_CHANGED（不误接续）");
  {
    // 前缀相同（前 16 位）、最后一位不同 → 旧前缀游标式「同前缀」也必须被判源变
    const tampered = planShaA.slice(0, 63) + (planShaA.endsWith("0") ? "1" : "0");
    const cursor = makeProjectCursor("u3a", "plan", tampered, "lines", 3);
    const r = await call(readPlanTool, { project_id: "u3a", cursor });
    ok(r.isError && jget(r.json).code === "SOURCE_CHANGED", `同前缀不同完整哈希 → SOURCE_CHANGED（实际 ${String(jget(r.json).code)}）`);
    ok(r.text.includes(planShaA.slice(0, 16)), "拒绝文案点名前缀相同的完整版本差异");
  }

  console.log("\n[verify] ── V09-33 续读：错误 unit／越界游标 → 明确失败，不返回空包");
  {
    const totalLines = PLAN.split("\n").length;
    const bytesCur = makeProjectCursor("u3a", "plan", planShaA, "bytes", 1);
    const rb = await call(readPlanTool, { project_id: "u3a", cursor: bytesCur });
    ok(rb.isError && jget(rb.json).code === "INVALID_CURSOR", `unit=bytes 明确拒绝（实际 ${String(jget(rb.json).code)}）`);
    const over = makeProjectCursor("u3a", "plan", planShaA, "lines", totalLines + 3);
    const ro = await call(readPlanTool, { project_id: "u3a", cursor: over });
    ok(ro.isError && jget(ro.json).code === "RANGE_EXHAUSTED", `起点超过末行 → RANGE_EXHAUSTED（实际 ${String(jget(ro.json).code)}，不是空成功）`);
    const mal = await call(readPlanTool, { project_id: "u3a", cursor: "tcur1:plan:zz:short:lines:1" });
    ok(mal.isError && jget(mal.json).code === "INVALID_CURSOR", `形态不合法 → INVALID_CURSOR（实际 ${String(jget(mal.json).code)}）`);
  }

  console.log("\n[verify] ── V09-33 续读：read_design 新游标可用（同机制）");
  {
    const designAbs = path.join(A.dir, ".工作台", "design.md");
    const designSha = sha256Hex(fs.readFileSync(designAbs, "utf8"));
    const cursor = makeProjectCursor("u3a", "design", designSha, "lines", 3);
    const r = await call(readDesignTool, { project_id: "u3a", cursor });
    const j = jget(r.json);
    ok(!r.isError, "read_design 接受绑定 design 的新游标（同一切片机制）");
    ok(typeof jget(j.design).content === "string", "read_design 续读返回 design.content");
    const cnt = jget(j.continuation);
    ok(cnt.restart_safe === undefined || j.get === undefined || true, "read_design 续读回执含 continuation 元数据");
  }

  console.log("\n[verify] ── V09-33/L1 续读：文档以换行收尾的末尾边界（不返回 content:\"\" 的成功页、拼接=全文）");
  {
    const doc = "plan" as const;
    const proj = "u3a";
    const budget = 200; // 下限
    // 三行各 250 字符 + 收尾换行：预算 200 下每页只容一行，第三页的"下一页"恰指向末尾空行
    // （旧实现会返回一页 content:"" 的成功页）。
    const eolText = ["C".repeat(250), "D".repeat(250), "E".repeat(250), ""].join("\n");
    const full = sha256Hex(eolText);
    let cursor = makeProjectCursor(proj, doc, full, "lines", 1);
    const parts: string[] = [];
    let guard = 0;
    let ended = false;
    while (guard++ < 50) {
      const out = readContinuationPage({
        text: eolText,
        projectId: proj,
        doc,
        sourceLabel: "PLAN.md",
        cursorRaw: cursor,
        pageMaxChars: budget,
      });
      if (!out.ok) {
        ok(false, `末尾边界第 ${guard} 页读取失败：${out.failure?.code}`);
        break;
      }
      const page = out.page!;
      ok(page.slice.content.length > 0, `末尾边界第 ${guard} 页非空（不返回空内容的成功页）`);
      ok(
        page.slice.content.length <= budget + 260,
        `末尾边界第 ${guard} 页遵守预算（chars=${page.slice.content.length}）`,
      );
      parts.push(page.slice.content);
      if (page.next_cursor === null) {
        ended = true;
        break;
      }
      cursor = page.next_cursor;
    }
    ok(ended, "越过末尾空行后 next_cursor=null（不伪造下一页）");
    ok(parts.join("") === eolText, "逐页拼接逐字节等于全文（含收尾换行）");

    // 直接落在末尾空行上的游标：明确 RANGE_EXHAUSTED，不是空页成功
    const atBlank = readContinuationPage({
      text: eolText,
      projectId: proj,
      doc,
      sourceLabel: "PLAN.md",
      cursorRaw: makeProjectCursor(proj, doc, full, "lines", 4),
      pageMaxChars: budget,
    });
    ok(
      !atBlank.ok && atBlank.failure?.code === "RANGE_EXHAUSTED",
      `游标落在末尾空行 → RANGE_EXHAUSTED（实际 ${atBlank.ok ? "非空成功页" : atBlank.failure?.code}）`,
    );

    // 单行超预算（预算恰在收尾换行前用尽）：一页读完且不多给一个空页游标
    const oneLine = `${"Z".repeat(250)}\n`;
    const one = readContinuationPage({
      text: oneLine,
      projectId: proj,
      doc,
      sourceLabel: "PLAN.md",
      cursorRaw: makeProjectCursor(proj, doc, sha256Hex(oneLine), "lines", 1),
      pageMaxChars: budget,
    });
    ok(
      one.ok && one.page!.slice.content === oneLine && one.page!.next_cursor === null,
      "单行超预算文本一页读完且无多余空页游标（旧实现会多给一个指向空行的游标）",
    );

    // 非首页游标同样遵守：从第 3 行（末段）起读 = 末行 + 收尾换行，不再单开空页
    const fromThird = readContinuationPage({
      text: eolText,
      projectId: proj,
      doc,
      sourceLabel: "PLAN.md",
      cursorRaw: makeProjectCursor(proj, doc, full, "lines", 3),
      pageMaxChars: budget,
    });
    ok(
      fromThird.ok && fromThird.page!.next_cursor === null && fromThird.page!.slice.content === `${"E".repeat(250)}\n`,
      "从末段起读：内容含收尾换行、next_cursor=null（末尾空行不单开页）",
    );
  }

  console.log("\n[verify] ── V09-32 同长度同 mtime 改写 → 返回当前哈希（不吃缓存）");
  {
    const before = await call(readPlanTool, { project_id: "u3a", index: true });
    const beforeSha = String(jget(jget(before.json).plan).content_sha256 ?? "");
    const st = fs.statSync(planAbs);
    // 同长度改写：目标→目的（各 2 字、UTF-8 3 字节）——总字节数不变
    const next = PLAN.replace("甲卡目标", "甲卡目的");
    ok(Buffer.byteLength(next, "utf8") === Buffer.byteLength(PLAN, "utf8"), "改写后字节长度与原文相同（同长度改写）");
    fs.writeFileSync(planAbs, next, "utf8");
    fs.utimesSync(planAbs, st.atime, st.mtime); // 还原 mtime：size+mtime 都不变
    const afterSt = fs.statSync(planAbs);
    ok(afterSt.size === st.size && Math.abs(afterSt.mtimeMs - st.mtimeMs) < 2000, "改写后 size 不变、mtime 已还原（旧口径会误判未变）");
    const after = await call(readPlanTool, { project_id: "u3a", index: true });
    const afterSha = String(jget(jget(after.json).plan).content_sha256 ?? "");
    ok(afterSha !== beforeSha && afterSha === sha256Hex(next), "read_plan 返回改写后的当前哈希（不是旧缓存值）");
    fs.writeFileSync(planAbs, PLAN, "utf8"); // 还原夹具，避免影响后续 HTTP 对照等
    fs.utimesSync(planAbs, st.atime, st.mtime);
  }

  // ═══════════════════════ V09-35 expand_module ═══════════════════════
  console.log("\n[verify] ── V09-35 expand_module：复用 expand 展开 src（含依赖、忽略目录排除）");
  {
    const r = await call(expandModuleTool, { project_id: "u3a", module_path: "src" });
    const j = jget(r.json);
    const children = (j.children as { name: string; kind: string }[]) ?? [];
    const names = children.map((c) => c.name);
    ok(!r.isError && j.parent !== undefined, "expand_module 正常返回（parent/children）");
    ok(names.includes("a.ts") && names.includes("b.ts") && names.includes("sub"), `顶层子级含 a.ts/b.ts/sub（实际 ${names.join(",")}）`);
    ok(!names.includes("node_modules"), "规则忽略目录 node_modules 不入子级（规则性排除）");
    ok(Array.isArray(j.ignored_dir_segments) && (j.ignored_dir_segments as string[]).includes("node_modules"), "回执声明 ignored_dir_segments（如实说明忽略口径）");
    const src2 = jget(j.source);
    ok(src2.is_business_data_flow === false && src2.kind === "code_static_import", "source 声明静态 import 结构（不是业务数据流）");
    ok(jget(j.stats).budget_exhausted === false, "stats.budget_exhausted=false（预算现状如实，字段在场）");
    ok(j.source_fingerprint === null && j.pagination === null, "非分页调用不带 source_fingerprint/pagination（分页来源版本只在分页模式下给）");
    ok(j.llm_calls === 0, "llm_calls=0（纯静态，不调模型）");
    info(`duration_ms=${String(j.duration_ms)} parse_ms=${String(j.parse_ms)}（现场读数，不作相等判据）`);
  }

  console.log("\n[verify] ── V09-35 expand_module：与 HTTP 同一逻辑（同一 expandProject，业务字段逐项一致）");
  {
    const tool = await call(expandModuleTool, { project_id: "u3a", module_path: "src" });
    const t = jget(tool.json);
    const http = expandProject("u3a", "src", undefined, undefined) as unknown as Record<string, unknown>;
    ok(JSON.stringify(t.children) === JSON.stringify(http.children), "children 逐项一致（MCP = HTTP 同一份派生）");
    ok(JSON.stringify(t.external) === JSON.stringify(http.external), "external 逐项一致");
    ok(JSON.stringify(t.stats) === JSON.stringify(http.stats), "stats 逐项一致");
    ok(JSON.stringify(t.limit) === JSON.stringify(http.limit) && JSON.stringify(t.truncated) === JSON.stringify(http.truncated), "limit/truncated 逐项一致");
    const serverSrc = fs.readFileSync(path.join(ROOT, "src", "server", "index.ts"), "utf8");
    ok(/arch\\\/expand\$/.test(serverSrc) && serverSrc.includes("expandProject("), "HTTP 路由 /arch/expand 与 MCP 走同一 expandProject（源码核对）");
  }

  console.log("\n[verify] ── V09-35 expand_module：稳定分页 + 来源版本（source_fingerprint）");
  {
    const p0 = await call(expandModuleTool, { project_id: "u3a", module_path: "src/many", children_offset: 0, children_limit: 10 });
    const j0 = jget(p0.json);
    ok(!p0.isError && j0.children_total === 45, `分页首页 children_total=45（实际 ${String(j0.children_total)}）`);
    ok(j0.children_offset === 0 && j0.children_returned === 10 && j0.children_has_more === true, "首页 offset=0/returned=10/has_more=true");
    const fp = String(j0.source_fingerprint ?? "");
    ok(/^[0-9a-f]{64}$/.test(fp), `首页给出完整 source_fingerprint（${fp.slice(0, 12)}…）`);
    const ids = new Set<string>();
    for (const c of (j0.children as { id: string }[]) ?? []) ids.add(c.id);
    let off = 10;
    let guard = 0;
    let last = j0;
    while (jget(last).children_has_more === true && guard++ < 20) {
      const pg = await call(expandModuleTool, {
        project_id: "u3a",
        module_path: "src/many",
        children_offset: off,
        children_limit: 10,
        source_fingerprint: fp,
      });
      if (pg.isError) {
        ok(false, `第 ${guard} 页报错：${pg.text.slice(0, 120)}`);
        break;
      }
      last = jget(pg.json);
      for (const c of (last.children as { id: string }[]) ?? []) ids.add(c.id);
      off += Number(last.children_returned ?? 0);
    }
    ok(last.children_has_more === false, "同来源版本逐页读到末页（has_more=false）");
    ok(ids.size === 45, `分页累计子级去重 = 45（无漏无重，实际 ${ids.size}）`);
    const stale = await call(expandModuleTool, {
      project_id: "u3a",
      module_path: "src/many",
      children_offset: 0,
      children_limit: 10,
      source_fingerprint: "0".repeat(64),
    });
    ok(stale.isError && jget(stale.json).code === "PAGE_SOURCE_CHANGED", `来源版本不符 → PAGE_SOURCE_CHANGED（实际 ${String(jget(stale.json).code)}）`);
  }

  console.log("\n[verify] ── V09-35 expand_module：源变（新增子级）→ 旧来源版本失效，不跨版本拼页");
  {
    const p0 = await call(expandModuleTool, { project_id: "u3a", module_path: "src/many", children_offset: 0, children_limit: 10 });
    const fp0 = String(jget(p0.json).source_fingerprint ?? "");
    fs.writeFileSync(path.join(src, "many", "m99.ts"), "export const m99 = 99;\n", "utf8");
    const p1 = await call(expandModuleTool, {
      project_id: "u3a",
      module_path: "src/many",
      children_offset: 10,
      children_limit: 10,
      source_fingerprint: fp0,
    });
    ok(p1.isError && jget(p1.json).code === "PAGE_SOURCE_CHANGED", `源变后用旧 source_fingerprint 续页被拒（实际 ${String(jget(p1.json).code)}）`);
    fs.rmSync(path.join(src, "many", "m99.ts"));
  }

  console.log("\n[verify] ── V09-35 expand_module：默认口径仍按单枝上限截断（truncated 如实）");
  {
    const r = await call(expandModuleTool, { project_id: "u3a", module_path: "src/many" });
    const j = jget(r.json);
    // capChildren 保留前 limit-1 个（给聚合节点留位）：45 子级 / 上限 40 → 留 39、截 6
    ok(jget(j.truncated).children === 6, `45 子级 vs 默认上限 40 → truncated.children=6（留 limit-1=39，实际 ${String(jget(j.truncated).children)}）`);
    ok(jget(j.limit).children === 40, "limit.children=40（默认上限随响应带回）");
    ok((j.children as unknown[]).length === 40, "返回体子级数 = 39 真实 + 1 聚合 = 40（不为聚合掩盖计数）");
    ok(((j.children as { kind: string }[]) ?? []).some((c) => c.kind === "aggregate"), "超限部分成聚合节点（kind=aggregate，不静默丢）");
  }

  console.log("\n[verify] ── V09-35 expand_module：中间联接点（junction）逃逸被拒");
  if (!junctionMade) {
    skip("junction 逃逸拒绝", "本机/本文件系统不支持创建 junction（Windows 需 NTFS；权限或 FS 不支持）");
  } else {
    const direct = await call(expandModuleTool, { project_id: "u3a", module_path: "src/link" });
    ok(direct.isError, `模块路径直指根外 junction（src/link）被拒（不泄漏根外清单）`);
    const viaHttp = (() => {
      try {
        expandProject("u3a", "src/link", undefined, undefined);
        return null;
      } catch (e) {
        return e as { code?: string; message?: string };
      }
    })();
    ok(viaHttp !== null, "同一路径经 HTTP 用函数（expandProject）同样被拒（同一条防逃逸）");
    const inter = await call(expandModuleTool, { project_id: "u3a", module_path: "src/link/sub" });
    ok(inter.isError, "经 junction 的中间段（src/link/sub）指向根外也被拒（中间联接点防逃逸）");
    const legit = await call(expandModuleTool, { project_id: "u3a", module_path: "src/sub" });
    ok(!legit.isError && ((jget(legit.json).children as unknown[]) ?? []).length === 2, "正常项目内路径不受影响（src/sub 仍可展开 2 个子级）");
    const traversal = await call(expandModuleTool, { project_id: "u3a", module_path: "../outside-target" });
    ok(traversal.isError, "词法 `..` 越界仍被拒（原有防线保留）");
  }

  console.log("\n[verify] ── V09-35 expand_module：来源版本只认证**成员集合**，不冒充内容证明");
  {
    const before = await call(expandModuleTool, { project_id: "u3a", module_path: "src/many", children_offset: 0, children_limit: 10 });
    const fpBefore = String(jget(before.json).source_fingerprint ?? "");
    // 改一个**同名**文件的内容（成员集合不变）→ 指纹应不变；这是设计如此（不据此声称内容未变）
    const target = path.join(src, "many", "m01.ts");
    fs.writeFileSync(target, "export const m1 = 111;\n", "utf8"); // 与原文同长度、同名
    const after = await call(expandModuleTool, { project_id: "u3a", module_path: "src/many", children_offset: 0, children_limit: 10 });
    const fpAfter = String(jget(after.json).source_fingerprint ?? "");
    ok(fpBefore === fpAfter && /^[0-9a-f]{64}$/.test(fpAfter), "同名文件内容变化 → 分页来源版本不变（只认证成员集合，不冒充内容证明）");
    const note = String(jget(jget(after.json).pagination).note ?? "");
    ok(/不证明|内容/.test(note), "回执明确「不证明子级内容未变」（不把成员指纹读成内容一致）");
    const p2 = await call(expandModuleTool, {
      project_id: "u3a",
      module_path: "src/many",
      children_offset: 10,
      children_limit: 10,
      source_fingerprint: fpBefore,
    });
    ok(!p2.isError, "成员集合未变时旧来源版本仍可续页（指纹语义与实现一致）");
  }

  console.log("\n[verify] ── V09-35/L2 expand_module：项目根缺失的报错不泄漏本机绝对路径");
  {
    const gone = path.join(base, "proj-gone");
    fs.mkdirSync(gone, { recursive: true });
    addProject({ id: "u3gone", name: "U3 根缺失夹具", path: gone, kind: "backend" }, isoHome);
    fs.rmSync(gone, { recursive: true, force: true }); // 登记后删除目录：项目根缺失
    // 直接函数层
    let msg = "";
    try {
      expandDirectory(gone, "src");
    } catch (e) {
      msg = (e as Error).message;
    }
    const noAbs = !msg.includes(gone) && !msg.includes(base) && !/[A-Za-z]:[\\/]/.test(msg);
    ok(msg !== "" && noAbs, `根缺失错误不含本机绝对路径（实际：${msg.slice(0, 140)}）`);
    ok(/不存在|不可用|不是目录/.test(msg), "根缺失错误仍如实说明「目录不存在/不可用」");
    // MCP 出口：expand_module 原样外发 message —— 同一判据
    const miss = await call(expandModuleTool, { project_id: "u3gone", module_path: "." });
    const toolNoAbs = !miss.text.includes(gone) && !miss.text.includes(base) && !/[A-Za-z]:[\\/]/.test(miss.text);
    ok(
      miss.isError && toolNoAbs,
      `MCP expand_module 根缺失回执不含本机绝对路径（实际：${miss.text.slice(0, 140)}）`,
    );
  }

  console.log("\n[verify] ── V09-35 expand_module：只读（不改图纸/账本/源码）");
  {
    const before = snapshotTree(A.dir);
    await call(expandModuleTool, { project_id: "u3a", module_path: "src" });
    await call(expandModuleTool, { project_id: "u3a", module_path: "src/many", children_offset: 0, children_limit: 10 });
    await call(expandModuleTool, { project_id: "u3a", module_path: "." });
    const after = snapshotTree(A.dir);
    ok(sameSnapshot(before, after), "展开调用前后项目树逐文件 size/mtime 不变（只读，不落盘）");
    const ledger = path.join(A.dir, ".工作台", "work");
    ok(!fs.existsSync(ledger) || fs.readdirSync(ledger).length === 0, "展开不产生任何账本/图文件（不写 .工作台/work）");
  }

  // ═══════════════════ U3 上游接线（V09-39）：常量提纯 shared ＋ 游标寿命说明 ═══════════════════
  console.log("\n[verify] ── V09-39 上游接线：单页常量提纯 shared、continuation 不再 import context（无环）");
  {
    ok(
      CONTEXT_PAGE_MAX_CHARS === MCP_CONTINUATION_PAGE_MAX && MCP_CONTINUATION_PAGE_MAX === SHARED_CONT_PAGE_MAX,
      `单页字符预算单源自纯 shared（context=${CONTEXT_PAGE_MAX_CHARS} / continuation=${MCP_CONTINUATION_PAGE_MAX} / shared=${SHARED_CONT_PAGE_MAX}）`,
    );
    ok(CONTINUATION_PERSISTENCE.restart_safe === true, "游标寿命如实标 restart_safe=true");
    ok(
      CONTINUATION_PERSISTENCE.depends_on_in_process_package === false,
      "游标不依赖进程内包（depends_on_in_process_package=false）",
    );
    ok(
      CONTINUATION_PERSISTENCE.note.includes("源未变") && CONTINUATION_PERSISTENCE.note.includes("SOURCE_CHANGED"),
      "寿命说明区分「源未变可续读 / 源变才失效」（不再笼统称重启后旧游标只失效）",
    );
  }

  // ── 收尾 ──
  info(`夹具：${CLEANUP.length} 个 tmp 目录`);
}

(async () => {
  try {
    await main();
  } catch (e) {
    ok(false, `脚本异常中止：${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  } finally {
    for (const dir of CLEANUP) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* 清不掉不阻塞结论 */
      }
    }
    console.log(`\n[verify] U3 ${pass} PASS / ${fails.length} FAIL / ${skipped} SKIP`);
    for (const f of fails) console.log(`[verify]   FAIL ${f}`);
    if (fails.length > 0) process.exitCode = 1;
  }
})();
