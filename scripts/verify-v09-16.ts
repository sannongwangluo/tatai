// V09-16 施工前需求登记、映射与覆盖表建账（PLAN.md V09-16；DESIGN.md §1.5/§2.9/§4.5、附录 E.2/E.9、附录 G-1/G-4）。
// 用法：pnpm verify:v09-16
//
// 覆盖点（卡面 ①–⑤ 逐条真跑）：
//   ① G-1…G-6 全部经正规入口登记、取回真实 ID 且可逐条读回（真实投影）；
//      反例：未登记就写进需求映射表 ⇒ 受检导入 dangling_requirement 拒（夹具）；
//   ② 映射进正式需求映射表并经受检导入：真实 PLAN 的映射表含 6 行真实 ID，
//      且经 importTaskDefinitions 落入承接卡的 requirement_ids（不产生执行事实）；
//   ③ 覆盖表逐条建账、显式列缺口：覆盖 U-01…U-08、已登记 req 条目与 G-1…G-6，
//      G 行逐行带缺口标注（未施工／待对账／未开工／证据未闭合）；U-02 标「当前有效」；
//   ④ 链上缺环如实报缺（反例）：覆盖行缺缺口标注/缺承接卡 ⇒ 机械校验报缺，不静默补全；
//   ⑤ 门槛与回归：真实 PLAN 结构解析 44 行 / 0 问题（v06-02 结构部分不劣化）。
//
// 隔离口径：真实账本与真实 PLAN 只读；夹具走临时 TATAI_HOME（os.tmpdir()）；收尾清理。
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkError } from "../src/server/work/types";
import { readRequirements } from "../src/server/work/requirements";
import {
  importTaskDefinitions,
  parseRequirementMap,
  requirementMapForCards,
} from "../src/server/work/plan";
import { parsePlanTasks, validatePlanTasks } from "../src/server/work/planValidate";
import { importPlanChecked } from "../src/server/work/references";

const REPO = process.cwd();
let passCount = 0;
const failCount: string[] = [];
function ok(cond: boolean, label: string): void {
  if (cond) {
    passCount += 1;
    console.log(`[verify] PASS ${label}`);
  } else {
    failCount.push(label);
    console.log(`[verify] FAIL ${label}`);
  }
}
const sha256Text = (t: string): string => crypto.createHash("sha256").update(t, "utf8").digest("hex");

const G_IDS = ["req-2026-09-24-g1", "req-2026-09-24-g2", "req-2026-09-24-g3", "req-2026-09-24-g4", "req-2026-09-24-g5", "req-2026-09-24-g6"];
/** 每项需求 → 必须承接它的卡（与 PLAN 需求映射表追加行同口径） */
const G_EXPECTED_CARDS: Record<string, string[]> = {
  "req-2026-09-24-g1": ["V09-16"],
  "req-2026-09-24-g2": ["V09-12", "V09-13"],
  "req-2026-09-24-g3": ["V09-11"],
  "req-2026-09-24-g4": ["V09-16", "V09-12", "V09-13"],
  "req-2026-09-24-g5": ["V09-05"],
  "req-2026-09-24-g6": ["V09-14"],
};
const GAP_MARKERS = ["未施工", "待对账", "未开工", "证据未闭合"];

// 定向更新（V09-09 集成复审 H-1，2026-09-25）；判据未放宽——「不得冒充已验收」双向仍成立：
//   旧期望：每行必须带缺口标注或 done/建账记录（建账时实现卡未完工的实况）｜
//   依据：V09-11…V09-14、V09-05、V09-16 已于本轮交付（账本 seq 860–961），覆盖表 G 行由
//   「未施工」转正为「已交付＋独立审计与用户验收未完成」（V09-09 H-1 收口）｜
//   新期望：已交付的行必须**同时**写明「独立审计与用户验收未完成」（或仍带缺口标注）——
//   只写「已交付」不写验收未完成同样判违规（冒充结案）；「一切正常」类照旧判违规｜
//   保留意图：已交付 ≠ 独立审计通过 ≠ 用户验收；缺环/冒充都报缺，不静默补全。
function statusCellHonest(cell: string): boolean {
  if (GAP_MARKERS.some((m) => cell.includes(m))) return true;
  if (cell.includes("done") || cell.includes("建账已完成")) return true;
  if (cell.includes("已交付") && (cell.includes("验收未完成") || cell.includes("验收均未完成"))) return true;
  return false;
}
/** 覆盖表机械校验：一行必须含承接卡非空且带缺口/进展/「已交付但未验收」标注（缺环报缺，不静默补全） */
function coverageRowIssues(row: string): string[] {
  const cells = row.split("|").slice(1, -1).map((c) => c.trim());
  const issues: string[] = [];
  if (cells.length < 6) issues.push("列数不足 6");
  if (cells.length >= 6) {
    if (!cells[3]) issues.push("承接的施工卡为空");
    if (!statusCellHonest(cells[5])) {
      issues.push("证据与状态列既无 done/建账/缺口标注，也不是「已交付＋验收未完成」（冒充结案）");
    }
  }
  return issues;
}

function main(): void {
  const docBefore = new Map<string, string>();
  for (const rel of ["DESIGN.md", "PLAN.md", "PROGRESS.md", "AGENTS.md", "README.md"]) {
    const abs = path.join(REPO, rel);
    docBefore.set(rel, fs.existsSync(abs) ? sha256Text(fs.readFileSync(abs, "utf8")) : "<missing>");
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-v0916-"));
  try {
    // ═══ ① G 项全部经正规入口登记、取回真实 ID（真实投影只读读回） ═══
    console.log("[verify] ═══ ① G-1…G-6 已登记且逐条可读回 ═══");
    const proj = readRequirements(path.join(REPO, ".工作台", "work"));
    for (const id of G_IDS) {
      const r = proj.requirements[id];
      ok(
        !!r && r.status === "explicit" && r.source.kind === "user" && r.source.ref.includes("附录 G") && (r.seq ?? 0) >= 808,
        `① ${id} 已登记可读回（status=explicit／来源 kind=user 且指向附录 G／seq=${r?.seq ?? "无"}）`,
      );
    }

    // 反例（夹具）：未登记就写进需求映射表 ⇒ 受检导入拒
    const home = path.join(tmp, "home");
    fs.mkdirSync(home, { recursive: true });
    process.env.TATAI_HOME = home;
    const workDir = path.join(tmp, "proj", ".工作台", "work");
    fs.mkdirSync(workDir, { recursive: true });
    const ghostPlan = `# 夹具

| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |
| --- | --- | --- | --- | --- |
| T-1 | todo | 甲 | 无 | 甲 |

### T-1 甲

**交付**：甲。

### 需求映射（测试小节）

| 需求 ID | 来源 | 分类 | 适用范围/生效时点 | 确认度 | 承接卡 |
| --- | --- | --- | --- | --- | --- |
| req-GHOST | 未登记 | 当前有效 | 本轮 | 明确 | T-1 |
`;
    let rejected = "";
    try {
      importPlanChecked(ghostPlan, workDir, {});
      ok(false, "① 反例：未登记需求先进映射表 ⇒ 应被 dangling_requirement 拒（居然放行）");
    } catch (e) {
      rejected = e instanceof Error ? e.message : String(e);
      ok(e instanceof WorkError && rejected.includes("req-GHOST"), `① 反例：未登记需求先进映射表 ⇒ 受检导入拒并点名（${(e as WorkError).code}）`);
    }

    // ═══ ② 映射进正式需求映射表并经受检导入读数 ═══
    console.log("[verify] ═══ ② 映射表追加行 → 承接卡 requirement_ids ═══");
    const planNow = fs.readFileSync(path.join(REPO, "PLAN.md"), "utf8");
    const mapRows = parseRequirementMap(planNow);
    const byReq = new Map(mapRows.map((r) => [r.requirement_id, r]));
    for (const id of G_IDS) {
      const row = byReq.get(id);
      ok(
        !!row && row.classification === "当前有效" && G_EXPECTED_CARDS[id].every((c) => row.card_ids.includes(c)),
        `② 映射表含 ${id}（当前有效，承接 ${G_EXPECTED_CARDS[id].join("／")}）`,
      );
    }
    const forCards = requirementMapForCards(mapRows);
    const imported = importTaskDefinitions(planNow, {});
    const defById = new Map(imported.definitions.map((d) => [d.task_id, d]));
    for (const [reqId, cards] of Object.entries(G_EXPECTED_CARDS)) {
      for (const card of cards) {
        ok(
          (forCards.get(card) ?? []).includes(reqId) && (defById.get(card)?.requirement_ids ?? []).includes(reqId),
          `② 受检导入：${card}.requirement_ids 含 ${reqId}（正向/反向都可答）`,
        );
      }
    }

    // ═══ ③ 覆盖表逐条建账、显式列缺口 ═══
    console.log("[verify] ═══ ③ 覆盖表建账与缺口标注 ═══");
    const covIdx = planNow.indexOf("### 需求→设计→任务→验收覆盖表");
    ok(covIdx > 0, "③ 覆盖表小节在场");
    const covText = covIdx > 0 ? planNow.slice(covIdx) : "";
    for (const u of ["U-01", "U-02", "U-03", "U-04", "U-05", "U-06", "U-07", "U-08"]) {
      ok(covText.includes(`| ${u} `), `③ 覆盖表含 ${u} 行`);
    }
    ok(/\| U-02 [^|]*(\|[^|]*){5}当前有效/.test(covText), "③ U-02 行标「当前有效」（核源结论在场）");
    G_IDS.forEach((id, i) => {
      const g = `G-${i + 1}`;
      const rowLine = covText.split("\n").find((l) => l.startsWith(`| **${g} `));
      ok(!!rowLine && rowLine.includes(id) && rowLine.includes("已登记"), `③ ${g} 行带真实需求 ID ${id} 且标「已登记」`);
      ok(
        !!rowLine && (GAP_MARKERS.some((m) => rowLine.includes(m)) || (rowLine.includes("已交付") && rowLine.includes("验收未完成"))),
        `③ ${g} 行显式列缺口或「已交付＋验收未完成」（不冒充结案）`,
      );
    });
    ok(covText.includes("不得读成「项目已交付」") || covText.includes("不得") && covText.includes("项目已交付"), "③ 覆盖表保留「不得读成项目已交付」口径");

    // ═══ ④ 链上缺环如实报缺（反例） ═══
    console.log("[verify] ═══ ④ 缺环报缺（机械校验正反） ═══");
    const goodRow = "| **G-9 示例**（req-x） | 来源 | §1 | **V09-99** | 判据 | 设计已修订；实现**未施工** |";
    ok(coverageRowIssues(goodRow).length === 0, "④ 正例：承接卡非空＋缺口标注 ⇒ 机械校验通过");
    const badRow1 = "| **G-9 示例**（req-x） | 来源 | §1 |  | 判据 | 设计已修订 |";
    const badRow2 = "| **G-9 示例**（req-x） | 来源 | §1 | **V09-99** | 判据 | 一切正常 |";
    const badRow3 = "| **G-9 示例**（req-x） | 来源 | §1 | **V09-99** | 判据 | 已交付 |";
    ok(
      coverageRowIssues(badRow1).some((s) => s.includes("承接的施工卡为空")) &&
        coverageRowIssues(badRow2).some((s) => s.includes("冒充结案")) &&
        coverageRowIssues(badRow3).some((s) => s.includes("冒充结案")),
      "④ 反例：承接卡缺失／无缺口标注／只写「已交付」不写验收未完成 ⇒ 机械校验逐条报缺，不静默补全",
    );
    const realGLines = covText.split("\n").filter((l) => /^\| \*\*G-[1-6] /.test(l));
    ok(
      realGLines.length === 6 && realGLines.every((l) => coverageRowIssues(l).length === 0),
      `④ 真实覆盖表 G-1…G-6 六行逐行过同一机械校验（实测 ${realGLines.length} 行）`,
    );

    // ═══ ⑤ 门槛：真实 PLAN 结构解析不劣化 ═══
    console.log("[verify] ═══ ⑤ 门槛（结构部分） ═══");
    const rows = parsePlanTasks(planNow);
    const issues = validatePlanTasks(rows);
    // 定向更新（V09-17 收口，2026-09-25，与 verify:v06-02 ② 同一条行数沿革）：**新期望 45**。
    //   旧期望 = `rows.length === 44`（第 5 稿移除 V09-15 后的卡数）。
    //   依据   = PLAN 第 6 稿按 GPT-6 四条复审裁定（附录 E.15）在第一张当前任务表末段增补 V09-17 一行；
    //            V09-17 收口步（PLAN 行状态列同步 done）不改卡数，本条在收口批马拉松复跑时实测红（54/1）。
    //   新期望 = 45（解析器实测，非估算；与 verify:v06-02 ② 的 45 同源）。
    //   保留意图 = 行数恰好钉死、多一行少一行都红，不放宽成 >=。
    //   判据不放宽 = 同上，只是跟上第 6 稿的卡数。
    // 定向更新（V09-18，2026-09-26，同一条行数沿革）：**新期望 46**。
    //   旧期望 = 45｜依据 = PLAN 第 7 稿按 GPT-6 裁定 11 条（附录 E.17；批次 change-20260926-7a6e179f）
    //            在第一张当前任务表末段增补 V09-18 一行（该稿「机械影响」段已预告本条必红）｜
    //   新期望 = 46（解析器实测，非估算；与 verify:v06-02 ② 的 46 同源）｜保留意图与判据不放宽同上。
    // 定向更新（V09-19，2026-09-26，同一条行数沿革）：**新期望 47**。
    //   旧期望 = 46｜依据 = PLAN 第 8 稿按 V09-18 非作者复审 R-1／R-2／R-3 与用户指令「Agent 通过 MCP 直接读取
    //             六张图完整当前状态」（附录 E.18；批次 change-20260926-v09-19）在第一张当前任务表末段增补
    //             V09-19 一行（该稿「机械影响」段已预告本条必红）｜
    //   新期望 = 47（解析器实测，非估算；与 verify:v06-02 ② 的 47 同源）｜保留意图与判据不放宽同上。
    // 定向更新（2026-09-28，补证批次复核）：47 → 49——V09-20 回归修复与 V09-21 收口轮各落一卡后
    // 真实 PLAN 的施工卡数前进到 49（与状态投影 49 任务一致）；断言意图=「行数与解析器实测一致」，钉死旧数会把
    // 正常演进误报成红。
    ok(rows.length === 49, `⑤ 真实 PLAN 解析 49 行施工卡（实测 ${rows.length}）`);
    ok(issues.length === 0, `⑤ validatePlanTasks 0 结构问题（实测 ${issues.length}）`);

    // 文档零改动自证
    for (const [rel, before] of docBefore) {
      const abs = path.join(REPO, rel);
      const after = fs.existsSync(abs) ? sha256Text(fs.readFileSync(abs, "utf8")) : "<missing>";
      ok(after === before, `自证：${rel} 未被本脚本改动`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log(`[verify] V09-16：PASS ${passCount} / FAIL ${failCount.length}`);
  if (failCount.length > 0) {
    console.log("[verify] 存在 FAIL");
    process.exit(1);
  }
  console.log("[verify] 全部 PASS");
}

main();
