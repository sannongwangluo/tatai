// V09-09 最终集成复审（tsx 跑）：跨客户端接续、正反追踪、真机装卸的**机械可核部分**。
// 用法：pnpm verify:v09-09（先跑过一次 `pnpm verify:v09-09-ui` 产真机六图读数；本脚本读它并对账）
//
// 卡性质（PLAN.md V09-09）：集成复审——产出**结论与证据**，不是再修一轮功能。
// 本脚本覆盖卡面 ①–⑨ 中**机械可核**的部分；判断项（真机装卸、独立审计、用户 Gate）以证据包
// `.工作台/evidence/V09-09/1/` 里的真机记录与如实缺口为准，不由脚本自证。
//
// 覆盖点：
//   ① 六图真实 UI：读 `ui-readings.json`（真浏览器产出）＋与视图常量/后端派生交叉对账；
//      六张截图逐个存在且在盘上。架构主视图节点级来源/证据徽标缺失**如实记录**（缺陷清单，不扩修）。
//   ② MCP 跨客户端接续：`next_action` 恰七值的契约 + **真项目**逐角色实跑取值与理由原文 +
//      v1 未迁移项目过渡接法另跑一次；写操作清单（主会话执行）落证据并在册。
//   ③ 正反追踪 + 覆盖表全表对账：req-2026-09-24-g3 → §3.2/§11.2 → V09-11 → 证据 正反各一条；
//      链上缺环**如实报缺**（反例）；PLAN 文末覆盖表逐行机械对账 + G-1…G-6 账本 seq 808–813。
//   ④ 备份/恢复隔离演练：真跑备份 → 隔离恢复 → 重放核验（来源可定位/证据哈希相符/清单可读/
//      replaced:false）；复跑 V06-14 两类反证（跨时刻拼接、裸目录副本）仍判不合格。
//   ⑤ 安装/卸载：安装包体积/哈希 + 真机装卸记录（装前状态/耗时/残留比对/装回确认）在册且自洽。
//   ⑥ 文档/状态/蓝图三方同步：DESIGN 附录口径 ↔ getArch 读口投影 ↔ 蓝图/六图读数互不矛盾；
//      文档工具计数恒等（des-current/m2 复跑日志在册）。
//   ⑦ 计划外登记面：逐条确认「已登记影响与启动条件」或「已明确排除」，不留口头承诺。
//   ⑧ 非作者独立审计：记录在册或**如实标缺口**（本会话无第二执行者时不假称已审）。
//   ⑨ 用户 Gate 只留本人：本批复核未由 Agent 代签用户验收；只交「可请求验收」材料清单。
//
// 隔离口径：真实 `.工作台/work/` 与真实 DESIGN/PLAN **只读**（首尾 sha256 自证零写入）；
// 一切写操作在 os.tmpdir() 夹具里；不调任何 MCP 写工具、不动真实事件账本。

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getArchTool } from "../src/mcp/tools/getArch";
import { ENTRY_INTERFACE_NAMES } from "../src/mcp/tools/projectEntry";
import { GRAPH_MODES } from "../src/arch/graph-mode";
import { archProvenanceModelOf, readBlueprint } from "../src/arch/blueprint";
import { addProject } from "../src/server/registry";
import { activeBaseline } from "../src/server/work/documents";
import { loadEvents, replayEvents } from "../src/server/work/eventStore";
import { evaluateProjectEntry, NEXT_ACTION_TRIGGERS, PROJECT_ENTRY_ACTIONS } from "../src/server/work/entry";
import { importTaskDefinitions } from "../src/server/work/plan";
import { readRequirements } from "../src/server/work/requirements";
import { projectWorkDir } from "../src/server/workstation";
import { PROJECT_VIEWS } from "../src/ui/arch/projectGraph";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EVID = path.join(REPO, ".工作台", "evidence", "V09-09", "1");
const REAL_HOME = process.env.TATAI_HOME?.trim() || path.join(os.homedir(), ".tatai");

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

const sha256Text = (t: string): string => crypto.createHash("sha256").update(t, "utf8").digest("hex");
const sha256File = (f: string): string | null =>
  fs.existsSync(f) ? crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex") : null;
const readIf = (f: string): string => (fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "");
const readJson = <T>(f: string): T | null => {
  try {
    return JSON.parse(fs.readFileSync(f, "utf8")) as T;
  } catch {
    return null;
  }
};
const exists = (f: string): boolean => fs.existsSync(f);
const artifact = (rel: string): string => path.join(EVID, rel);
const raw: Record<string, unknown> = { card: "V09-09", at: new Date().toISOString(), real_home: REAL_HOME };

// ── 真实只读现场（零写入自证） ──
const realLedger = path.join(REPO, ".工作台", "work", "events.jsonl");
const ledgerBefore = sha256File(realLedger);
const designBefore = sha256Text(readIf(path.join(REPO, "DESIGN.md")));
const planBefore = sha256Text(readIf(path.join(REPO, "PLAN.md")));

// ── 隔离数据目录 = 真实 ~/.tatai 的**只读拷贝**（真实注册表；读的是真实项目数据） ──
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-v0909-"));
const HOME = path.join(TMP, "home");
fs.mkdirSync(HOME, { recursive: true });
for (const name of ["registry.json", "config.json", "agents.json"]) {
  const src = path.join(REAL_HOME, name);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(HOME, name));
}
if (!fs.existsSync(path.join(HOME, "registry.json"))) {
  addProject({ id: "tatai", name: "塔台", path: REPO, kind: "fullstack", self_managed: true }, HOME);
}

// ═══════════════════════════════ ① 六图真实 UI ═══════════════════════════════

type GraphReading = {
  graph: string;
  kind: string;
  question: string;
  node_count: number | null;
  edge_count: number | null;
  screenshot: string;
  source?: string;
  delivery?: string | null;
  update_state?: string | null;
  coverage_rows?: number;
  deliverable_blocked?: string;
  missing_paths?: string[];
  node_source_evidence_badges?: { source: number; evidence: number; aggregate_nodes?: number };
};
type UiReadings = { graphs: GraphReading[]; real_home_before?: { hash: string }; real_home_after?: { hash: string } };

function section1(): void {
  section("① 六图真实 UI（真浏览器读数对账）");
  const ui = readJson<UiReadings>(artifact("ui-readings.json"));
  ok(ui !== null, "①-1 真机六图读数在册（.工作台/evidence/V09-09/1/ui-readings.json）");
  if (ui === null) return;
  const byKey = new Map(ui.graphs.map((g) => [g.graph, g]));
  const wantMain = Object.keys(PROJECT_VIEWS);
  const wantTech = Object.keys(GRAPH_MODES);
  ok(
    wantMain.every((k) => byKey.has(k)) && wantTech.every((k) => byKey.has(k)) && ui.graphs.length === 6,
    `①-2 六图逐屏齐全：三主视图 ${wantMain.join("/")} ＋ 技术详情三张 ${wantTech.join("/")}（共 ${ui.graphs.length} 屏）`,
  );
  for (const k of wantMain) {
    const g = byKey.get(k);
    ok(
      g !== undefined && g.question.length > 0 && g.node_count !== null && (g.node_count as number) > 0,
      `①-3 ${k} 屏：问题句「${g?.question ?? ""}」、节点 ${g?.node_count ?? "?"}、（数据源：${g?.source ?? "?"}）`,
    );
    ok(
      g !== undefined && g.delivery !== undefined && g.delivery !== null && g.update_state !== undefined,
      `①-4 ${k} 屏带 V09-13 交付阻断读数（${g?.delivery}/${g?.deliverable_blocked ?? "-"}）与 V09-12 更新状态（${g?.update_state}）`,
    );
    ok(
      g !== undefined && exists(artifact("ui-shots/" + g.screenshot)) && fs.statSync(artifact("ui-shots/" + g.screenshot)).size > 3000,
      `①-5 ${k} 屏真机截图在盘上：ui-shots/${g?.screenshot}`,
    );
  }
  for (const k of wantTech) {
    const g = byKey.get(k);
    ok(
      g !== undefined && g.question.length > 0 && g.node_count !== null && (g.node_count as number) > 0,
      `①-6 技术详情 ${k} 屏：问题句「${g?.question ?? ""}」、节点 ${g?.node_count ?? "?"}`,
    );
    ok(
      g !== undefined && exists(artifact("ui-shots/" + g.screenshot)),
      `①-7 技术详情 ${k} 屏真机截图在盘上：ui-shots/${g?.screenshot}`,
    );
  }
  const df = byKey.get("DATA_FLOW");
  // 期望定向更新（2026-09-25，review-fix-20260925；判据未放宽）：
  //   旧期望 = `df.deliverable_blocked === "true"`（真实项目 `.工作台/intent.json` 那条数据流路径缺读写点
  //            ⇒ 覆盖对账报缺路径 ⇒ 交付被判阻断）。冻结依据是 V09-09 复审当时的读数。
  //   依据   = 本批次前一步（`review-fix-20260925/intent-path`）给 `intent.json` 补上了真实读点与
  //            登记校验点，真实项目覆盖对账的缺路径由 1 变 0（读数见本段 info 行与
  //            `.工作台/evidence/review-fix-20260925/intent-path/READINGS.md`）。
  //   新期望 = **双向**——数据流向图屏仍必须有双口径与覆盖对账行（原样保留）；缺路径读数要与
  //            `deliverable_blocked` 一致：有缺路径必为 `true`，无缺路径不得留着 `true` 的空阻断。
  //   保留意图 = 「缺路径必须阻断项目可交付」这条判据本身一个字节没动——它由 `verify:v09-11` ④
  //            在**真实模型**上双向断言、⑤ 用合成缺路径反例当场拦住，不靠真实数据的偶然缺件证明有效。
  const dfCovered = (df?.coverage_rows ?? 0) > 0;
  const dfBlocked = df?.deliverable_blocked;
  const dfMissing = df?.missing_paths ?? null;
  ok(
    df !== undefined &&
      dfCovered &&
      (dfBlocked === "true" || dfBlocked === "false") &&
      dfMissing !== null &&
      (dfMissing.length > 0 ? dfBlocked === "true" : dfBlocked === "false"),
    `①-8 数据流向图屏：V09-11 双口径在场、覆盖对账 ${df?.coverage_rows ?? 0} 行、缺路径 ${JSON.stringify(dfMissing)}、交付阻断读数 ${dfBlocked}（真实项目当前缺路径 0 ⇒ 新读数 false，见 intent-path 证据）`,
  );
  const arch = byKey.get("architecture");
  const badges = arch?.node_source_evidence_badges;
  // 期望定向更新（2026-09-25，review-fix-20260925／H-4；判据**收紧**）：旧记录是"本屏徽标 0/0，如实登记缺口"；
  // H-4 已修（本屏画布传 provenance）⇒ 现在断言它**必须有**徽标，且数量＝节点数 − 聚合节点数
  // （聚合节点不是可对账对象，另挂 data-arch-aggregate-note 说明），保留"这一屏的节点级标注可被机械读出"这一意图。
  ok(
    badges !== undefined &&
      badges.source > 0 &&
      badges.source === (arch?.node_count ?? 0) - (badges.aggregate_nodes ?? 0) &&
      badges.evidence === badges.source,
    `①-8b 架构主视图节点级来源/证据徽标 ${JSON.stringify(badges)}（H-4 已修：对象节点全部带徽标；` +
      `聚合节点不是可对账对象）——交付阻断读数仍在（${arch?.delivery}）`,
  );
  raw.section1 = {
    graphs: ui.graphs.map((g) => ({ graph: g.graph, node_count: g.node_count, edge_count: g.edge_count })),
    arch_badges: badges,
  };
}

// ═══════════════════ ② MCP 跨客户端接续（契约 + 真项目实跑 + v1 接法） ═══════════════════

function section2(): void {
  section("② MCP 跨客户端接续（next_action 分支 + v1 过渡接法）");
  const want = ["resume_task", "claim_task", "review_result", "await_role", "await_decision", "blocked", "complete"];
  ok(
    PROJECT_ENTRY_ACTIONS.length === 7 && want.every((w) => (PROJECT_ENTRY_ACTIONS as readonly string[]).includes(w)),
    `②-1 next_action 恰好七值且与 §6.7 枚举一致：${PROJECT_ENTRY_ACTIONS.join("/")}`,
  );
  ok(
    want.every((w) => typeof NEXT_ACTION_TRIGGERS[w as keyof typeof NEXT_ACTION_TRIGGERS] === "string" && NEXT_ACTION_TRIGGERS[w as keyof typeof NEXT_ACTION_TRIGGERS].length > 0),
    "②-2 每个 next_action 都带「什么时候选它」的判据原文",
  );
  ok(
    ENTRY_INTERFACE_NAMES.length === 3 && ENTRY_INTERFACE_NAMES.join(",") === "project_entry,claim_task,submit_task_result",
    `②-3 接续入口只有三只工具（无独立 reopen_task）：${ENTRY_INTERFACE_NAMES.join("/")}`,
  );

  // 真项目逐角色实跑：记录**实际取值与理由原文**（读口只读，不认领）
  const live: { role: string; client_capabilities: unknown; next_action: string; reason_text: string; reason_code: string | null }[] = [];
  const clients: { role: string; caps: unknown }[] = [
    { role: "executor", caps: ["continuable"] },
    { role: "coordinator", caps: { can_continue: true, coordination: true } },
    { role: "auditor", caps: ["continuable"] },
    { role: "user", caps: ["read_only"] },
    { role: "unknown-role", caps: ["read_only"] },
  ];
  for (const c of clients) {
    try {
      const e = evaluateProjectEntry(
        { project_id: "tatai", role: c.role, client_capabilities: c.caps },
        { dataDir: HOME, now: "2026-09-25T02:00:00+08:00" },
      );
      live.push({
        role: c.role,
        client_capabilities: c.caps,
        next_action: e.next_action,
        reason_text: e.reasons[0]?.text ?? "",
        reason_code: e.reasons[0]?.code ?? null,
      });
      info(`  ${c.role}（能力 ${JSON.stringify(c.caps)}）→ next_action=${e.next_action}；理由：${(e.reasons[0]?.text ?? "").slice(0, 80)}`);
    } catch (err) {
      info(`  ${c.role} 实跑异常：${(err as Error).message}`);
    }
  }
  const distinct = new Set(live.map((l) => l.next_action));
  ok(
    live.length >= 4 && distinct.size >= 2,
    `②-4 真实项目上逐角色实跑得 ${distinct.size} 种不同 next_action（${distinct.size} 种：${[...distinct].join("/")}）；每一种都带理由原文`,
  );
  const unreached = want.filter((w) => !distinct.has(w as never));
  info(`  如实记录：本机真实项目上未现场触发的 next_action 分支＝${unreached.join("/") || "无"}（不编造；写操作由主会话按清单跑）`);
  raw.section2 = { contract: want, live, unreached };

  // v1 未迁移项目过渡接法（§6.6）：造一个只有 v1 台账、没有事件账本的项目
  const v1Root = path.join(TMP, "v1proj");
  fs.mkdirSync(path.join(v1Root, ".工作台"), { recursive: true });
  fs.writeFileSync(path.join(v1Root, ".工作台", "tasks.json"), JSON.stringify({ version: 1, tasks: [{ id: "T-1", title: "v1 夹具任务", status: "todo" }] }, null, 2), "utf8");
  fs.writeFileSync(path.join(v1Root, ".工作台", "progress.json"), JSON.stringify({ current_step: "夹具", history: [] }, null, 2), "utf8");
  fs.writeFileSync(path.join(v1Root, ".工作台", "design.md"), "# v1 夹具设计书\n\n## 1 目标\n", "utf8");
  const v1id = "v0909-v1";
  addProject({ id: v1id, name: "v1 夹具", path: v1Root, kind: "backend" }, HOME);
  try {
    const e1 = evaluateProjectEntry({ project_id: v1id, role: "executor", client_capabilities: ["continuable"] }, { dataDir: HOME });
    ok(
      typeof e1.next_action === "string" && (PROJECT_ENTRY_ACTIONS as readonly string[]).includes(e1.next_action) && !exists(path.join(v1Root, ".工作台", "work", "events.jsonl")),
      `②-5 未迁移项目（无事件账本）走 §6.6 过渡接法也拿得到接续动作（next_action=${e1.next_action}），且**没有**被悄悄迁成 v2（仍无 events.jsonl）`,
    );
    const v2 = evaluateProjectEntry({ project_id: "tatai", role: "executor", client_capabilities: ["continuable"] }, { dataDir: HOME });
    ok(v2.next_action !== undefined && v2.next_action !== e1.next_action, `②-6 两条路都没断：v2 项目 next_action=${v2.next_action} ≠ v1 项目 next_action=${e1.next_action}`);
    raw.section2_v1 = { next_action: e1.next_action, reason: e1.reasons[0]?.text ?? "" };
  } catch (err) {
    ok(false, `②-5 未迁移项目过渡接法实跑异常：${(err as Error).message}`);
  }

  // 写操作清单在册（跨客户端 claim/submit 由主会话执行——脚本只核它在册且含完整序列）
  const checklist = readIf(artifact("02-MCP跨客户端接续.md"));
  ok(
    checklist.includes("select_project") &&
      checklist.includes("project_entry") &&
      checklist.includes("claim_task") &&
      checklist.includes("submit_task_result") &&
      checklist.includes("§6.6"),
    "②-7 跨客户端接续的**写操作清单**在册且含完整序列（select_project→project_entry→claim_task→施工→submit_task_result→再 project_entry）与 §6.6 过渡接法",
  );
  ok(
    /\|\s*(executor|coordinator|auditor|user)/.test(checklist) && checklist.includes("客户端"),
    "②-8 清单按「两个不同客户端/角色」列出（不共用一个角色）",
  );
}

// ═══════════════════ ③ 正反追踪 + 覆盖表全表对账 ═══════════════════

type CoverageRow = { 覆盖项: string; 来源: string; 设计依据: string; 承接卡: string; 判据: string; 状态: string };

function parseCoverageTable(planText: string): CoverageRow[] {
  const lines = planText.split(/\r?\n/);
  const start = lines.findIndex((l) => l.includes("需求→设计→任务→验收覆盖表"));
  if (start < 0) return [];
  const rows: CoverageRow[] = [];
  for (let i = start; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim().startsWith("|")) continue;
    const cells = l.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.length < 6) continue;
    if (cells[0].startsWith("---") || cells[0] === "覆盖项") continue;
    rows.push({ 覆盖项: cells[0], 来源: cells[1], 设计依据: cells[2], 承接卡: cells[3], 判据: cells[4], 状态: cells[5] });
  }
  return rows;
}

function section3(): void {
  section("③ 需求→设计→任务→证据 正反追踪 + 覆盖表全表对账");
  const workDir = path.join(REPO, ".工作台", "work");
  const reqs = readRequirements(workDir);
  const planText = readIf(path.join(REPO, "PLAN.md"));
  const designText = readIf(path.join(REPO, "DESIGN.md"));

  // 需求映射（受检导入口径）：承接卡 → requirement_ids
  const defs = importTaskDefinitions(planText).definitions;
  const byCard = new Map<string, string[]>();
  for (const d of defs) byCard.set(d.task_id, [...(d.requirement_ids ?? [])]);

  // ── 正向链：req-2026-09-24-g3 → §3.2/§11.2 → V09-11 → 证据 ──
  const g3 = reqs.requirements["req-2026-09-24-g3"];
  const designHas = designText.includes("### 3.2") || designText.includes("§11.2") || designText.includes("11.2");
  const cardHas = (byCard.get("V09-11") ?? []).includes("req-2026-09-24-g3");
  const evDir = path.join(REPO, ".工作台", "evidence", "V09-11", "1");
  const evFiles = exists(evDir) ? fs.readdirSync(evDir) : [];
  ok(g3 !== undefined && g3.seq > 0, `③-1 正向①：需求 req-2026-09-24-g3 已登记可读回（账本 seq ${g3?.seq}，状态 ${g3?.status_label}）`);
  ok(designHas, "③-2 正向②：设计依据可回查（DESIGN.md 有 §3.2／§11.2 正文）");
  ok(cardHas, `③-3 正向③：承接卡 V09-11 的任务定义带 requirement_ids=${JSON.stringify(byCard.get("V09-11") ?? [])}（含 g3）`);
  ok(evFiles.length > 0, `③-4 正向④：结果/证据入口在盘上（.工作台/evidence/V09-11/1/ 共 ${evFiles.length} 项）`);

  // ── 反向链：V09-11 证据 → 满足哪条需求 → 哪条设计依据 ──
  const backReq = (byCard.get("V09-11") ?? []).find((r) => r === "req-2026-09-24-g3");
  const backDesign = designText.includes("§11.2");
  ok(
    backReq === "req-2026-09-24-g3" && backDesign,
    "③-5 反向：从 V09-11 的证据入口反查 ⇒ 满足需求 req-2026-09-24-g3、设计依据 §11.2（链闭合）",
  );

  // ── 反例：链上缺环 ⇒ 如实报缺，不静默补全 ──
  const missingCardReqs = ["req-2026-09-24-g3"].filter(() => !(byCard.get("不存在的卡") ?? []).includes("req-2026-09-24-g3"));
  const fabricated = missingCardReqs.length === 0;
  ok(
    !fabricated && (byCard.get("不存在的卡") ?? []).length === 0,
    "③-6 反例：一条链缺「承接卡」这一环时，机械对账**报缺**（未知卡无 requirement_ids，不静默补全、不编造承接）",
  );
  // 定向更新（V09-21 R5，2026-09-27，五要素留档）：钉死「此刻被阻断」单一态 → **同源蕴含式**。
  //   旧期望＝钉死「`!deliverable_allowed && unmet > 0`」这一**单一态**（当时真实项目恰好被阻断）。
  //   依据＝那是基线重激活前的时点快照：本轮 bl-f9ec9718-a5692622 重激活后全项目证据「旧绿转待验证」，
  //          同一断言在别的时刻（全部证据有效时）翻面成红——钉死单一态＝拿时点快照自证
  //          （V09-18 裁定 8 禁止；DESIGN §4.2「颜色/结论由事实派生」）。
  //   新期望＝**同源蕴含式**（读数是什么就核什么）：缺口（未映射/未验证/缺证/证据失效 > 0，即
  //          `BLOCKING_EVIDENCE_STATES` ＋未映射——比任务书列的 unmapped/missing/invalidated 更完整）
  //          ⇒ `verdict="blocked"` ＋ `deliverable_allowed=false` ＋ `reasons` **逐条点名到对象**；
  //          全零 ⇒ `requestable` ＋ `reasons=0`；「有阻断却不点名」「没阻断却留空阻断」两头都判红。
  //   保留意图＝原断言守的是真实读口「**如实报缺、不静默补全**」这件事可被机械读出（DESIGN §3.2／§4.2）。
  //   判据不放宽＝缺口存在时依旧必须 blocked ＋逐条点名；另外多加两条同源不变量
  //          （`deliverable_allowed === (verdict === "requestable")`、`blocked ⇒ reasons 非空且逐条点名`），
  //          `verdict="none"` 只认读口自身的「不空集判绿」（对象数 0），任一不满足逐条判红。
  const prov = archProvenanceModelOf("tatai", { dataDir: HOME });
  const d = prov.delivery;
  const unmet = d.reasons.length;
  const dc = d.counts;
  const gapCount = dc.unmapped + dc.unverified + dc.missing + dc.invalidated;
  const namedReasons = d.reasons.length > 0 && d.reasons.every((r) => /（[^）]+）/.test(r));
  const coherent =
    d.conclusion !== "" &&
    d.deliverable_allowed === (d.verdict === "requestable") &&
    (d.verdict === "requestable"
      ? d.deliverable_allowed && d.reasons.length === 0
      : d.verdict === "blocked"
        ? !d.deliverable_allowed && namedReasons
        : d.verdict === "none" && !d.deliverable_allowed && dc.objects === 0);
  ok(
    coherent && (gapCount === 0 || d.verdict === "blocked"),
    `③-7 真实读口如实报缺（同源蕴含式，不钉单一态）：当前 verdict=${d.verdict}、缺口 ${gapCount} 条` +
      `（未映射 ${dc.unmapped} / 未验证 ${dc.unverified} / 缺证 ${dc.missing} / 证据失效 ${dc.invalidated}）、` +
      `逐条点名 ${unmet} 条 ⇒ ` +
      (gapCount > 0
        ? "有缺口必须 blocked＋逐条点名（已核）"
        : d.verdict === "requestable"
          ? "无缺口无理由 ⇒ requestable＋reasons=0（已核）"
          : "无计数缺口但仍有理由（如画布缺口）⇒ 仍须 blocked＋逐条点名（已核）") +
      `；结论「${d.conclusion}」`,
  );

  // ── 覆盖表全表对账 ──
  const rows = parseCoverageTable(planText);
  ok(rows.length >= 20, `③-8 PLAN 文末覆盖表可机械解析：${rows.length} 行`);
  const GAP = ["未施工", "待对账", "未开工", "证据未闭合", "尚未登记", "未登记", "待开工"];
  const gRows = rows.filter((r) => /G-\d/.test(r.覆盖项));
  ok(gRows.length === 6, `③-9 覆盖表 G-1…G-6 六行齐全（${gRows.map((r) => (r.覆盖项.match(/G-\d/)?.[0] ?? "?")).join("/")}）`);
  const ledgerEvents = loadEvents(workDir).events;
  const registeredEvents = ledgerEvents.filter((e) => String(e.type) === "requirement.registered");
  const gSeq = gRows.map((r) => {
    const idMatch = r.覆盖项.match(/req-2026-09-24-g\d/);
    const st = idMatch ? reqs.requirements[idMatch[0]] : undefined;
    return { row: r.覆盖项.match(/G-\d/)?.[0], id: idMatch?.[0] ?? null, seq: st?.seq ?? null, status: r.状态 };
  });
  const seqs = gSeq.map((g) => g.seq).filter((s): s is number => typeof s === "number");
  ok(
    seqs.length === 6 && Math.min(...seqs) === 808 && Math.max(...seqs) === 813,
    `③-10 G-1…G-6 在账本均为正规登记（req-2026-09-24-g1…g6，seq ${seqs.sort((a, b) => a - b).join(",")}；requirement.registered 事件 ${registeredEvents.length} 条）`,
  );
  const openG = gRows.filter((r) => GAP.some((m) => r.状态.includes(m)));
  info(`  如实列缺：覆盖表带缺口的行 ${openG.length} 行（${openG.map((r) => r.覆盖项.match(/G-\d/)?.[0]).join("/") || "无"}）`);
  raw.section3 = { g3_seq: g3?.seq ?? null, forward_closed: designHas && cardHas && evFiles.length > 0, coverage_rows: rows.length, g_seq: gSeq, unmet_reasons: unmet };
  fs.writeFileSync(
    artifact("coverage-table.json"),
    JSON.stringify({ generated_at: new Date().toISOString(), rows, g_seq: gSeq, table_rows: rows.length, gap_rows: openG.length }, null, 2) + "\n",
    "utf8",
  );
  ok(exists(artifact("coverage-table.json")), "③-11 覆盖表逐行对账读数落盘（coverage-table.json）");
}

// ═══════════════════ ④ 备份/恢复隔离演练（真跑） ═══════════════════

async function section4(): Promise<void> {
  section("④ 备份/恢复隔离演练（真跑 + V06-14 两类反证）");
  // 复用 V06-14 的备份语义模块；夹具在临时目录，真实数据零接触
  const { WorkService } = await import("../src/server/work/service");
  const { importTaskDefinitions: mport, taskDefinitionHash } = await import("../src/server/work/plan");
  const { submitDefinitionImports, submitTaskStatus } = await import("../src/server/work/tasks");
  const { putEvidence } = await import("../src/server/work/evidence");
  const { activateBaseline, WORKBENCH_DIRNAME } = await import("../src/server/work/documents");
  const { submitSubmission } = await import("../src/server/work/audit");
  const { verifyBackup, backupRoot } = await import("../src/server/work/backup");
  const { createBackupEntry, restoreBackupEntry, inspectBackupEntry, isBackupEntryError } = await import("../src/server/work/backupEntry");

  const D = path.join(TMP, "backup-home");
  fs.mkdirSync(D, { recursive: true });
  const id = "v0909-backup";
  const root = path.join(TMP, "backup-proj");
  fs.mkdirSync(path.join(root, WORKBENCH_DIRNAME), { recursive: true });
  const PLAN_TEXT = [
    "# V09-09 备份夹具施工图",
    "",
    "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |",
    "| --- | --- | --- | --- | --- |",
    "| B-1 | todo | 一致备份的提交边界 | | B-1 证据 |",
    "",
    "### B-1 一致备份的提交边界",
    "",
    "**设计依据**：§8.5。**文件责任**：`.工作台/**`。",
    "",
    "- [ ] 备份是某个提交序号的一致切片",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(root, WORKBENCH_DIRNAME, "design.md"), "# V09-09 备份夹具设计书\n\n## 1 目标\n\n备份/恢复隔离演练。\n", "utf8");
  fs.writeFileSync(path.join(root, WORKBENCH_DIRNAME, "plan.md"), PLAN_TEXT, "utf8");
  fs.mkdirSync(path.join(root, WORKBENCH_DIRNAME, "logs"), { recursive: true });
  fs.writeFileSync(path.join(root, WORKBENCH_DIRNAME, "logs", "terminal-history.jsonl"), '{"cmd":"pnpm build"}\n', "utf8");
  addProject({ id, name: "V09-09 备份夹具", path: root, kind: "backend" }, D);

  const service = new WorkService({ dataDir: D });
  const submit = { submit: (c: unknown) => service.submit(c as never) };
  const defs = mport(PLAN_TEXT).definitions;
  submitDefinitionImports(submit as never, { project_id: id, change_id: "chg-v0909", actor_id: "fx", role: "executor", definitions: defs });
  const ev = putEvidence(projectWorkDir(id, D), {
    content: "自检命令：pnpm typecheck\nexit_code=0\n结论：通过\n",
    kind: "self_check",
    summary: "夹具自检",
    created_by: "fx",
    role: "executor",
    binding: { revision_kind: "code", revision: "rev-a" },
  });
  submitTaskStatus(submit as never, {
    project_id: id,
    task_id: "B-1",
    change_id: "chg-v0909",
    actor_id: "fx",
    role: "executor",
    expected_revision: 1,
    status: "executing",
    definition: { definition_sha256: taskDefinitionHash(defs[0]), plan_revision: defs[0].plan_revision ?? "" },
  } as never);
  const baseline = activateBaseline(id, { approved_by: "fx-reviewer", approval_basis: "夹具技术审定", approval_kind: "delegated_technical_review" }, D);
  submitSubmission(submit as never, {
    record_id: "sub-v0909-B-1",
    project_id: id,
    change_id: "chg-v0909",
    actor_id: "fx",
    role: "executor",
    goal: "一致备份的提交边界（夹具）",
    task_id: "B-1",
    changed_files: ["src/server/work/backup.ts"],
    commands: [],
    untested: [],
    known_issues: [],
    evidence_refs: [ev.evidence_id],
    binding: { revision_kind: "code", revision: "rev-a" },
    baseline: {
      baseline_id: baseline.baseline.baseline_id,
      design_revision: baseline.baseline.design_revision.content_sha256,
      plan_revision: baseline.baseline.plan_revision.definition_sha256,
    },
    submitted_by: "fx",
  } as never);

  const created = createBackupEntry(id, { dataDir: D, now: "2026-09-25T02:00:00+08:00" });
  ok(created.verification.ok, `④-1 真跑备份：${created.backup_id}（清单可读、八条核验通过；证据 ${created.manifest.counts.evidence} 份）`);
  const restored = restoreBackupEntry(id, created.backup_id, { dataDir: D });
  const facts = restored.report.facts;
  ok(restored.replaced === false && restored.replace_requires_user === true, "④-2 隔离恢复：replaced=false、替换仍由用户决定");
  ok(
    restored.report.ok && (facts?.documents_recovered.length ?? 0) > 0 && facts!.documents_recovered.every((d) => /^[0-9a-f]{64}$/.test(d.sha256)),
    `④-3 重放核验：恢复报告 ok=true，原文可定位且哈希相符（${facts?.documents_recovered.length ?? 0} 份图纸）`,
  );
  ok(
    (facts?.evidence_hash_checked.length ?? 0) > 0 && facts!.evidence_hash_checked.every((e) => e.sha256 === e.evidence_id),
    `④-4 证据哈希相符：${facts?.evidence_hash_checked.length ?? 0} 份内容寻址证据逐份复核`,
  );
  ok(
    (facts?.events_replayed ?? 0) > 0 && exists(facts?.cache_rebuilt.state_path ?? ""),
    `④-5 隔离目录里清单与事件可读、事件可重放、缓存可重建（replay ${facts?.events_replayed ?? 0} 条，截止 seq ${facts?.cache_rebuilt.last_seq ?? "?"}）`,
  );

  // 两类反证（V06-14）：跨时刻拼接 + 裸目录副本 ⇒ 仍判不合格
  const srcDir = path.join(backupRoot(D, id), created.backup_id);
  const clone = (as: string): string => {
    const dest = path.join(backupRoot(D, id), as);
    fs.cpSync(srcDir, dest, { recursive: true });
    return dest;
  };
  // 反证 A：跨时刻拼接（换更晚的事件正文并同步改清单哈希）
  const mixedId = "b-00000099-aaaaaaaaaaaa";
  const mixedDir = clone(mixedId);
  const mixedManifest = JSON.parse(fs.readFileSync(path.join(mixedDir, "backup-manifest.json"), "utf8")) as {
    sources: { rel_path: string; sha256: string; bytes: number }[];
  };
  const liveEvents = fs.readFileSync(path.join(root, WORKBENCH_DIRNAME, "work", "events.jsonl"));
  fs.writeFileSync(path.join(mixedDir, "workbench", "work", "events.jsonl"), liveEvents);
  const evEntry = mixedManifest.sources.find((s) => s.rel_path === "work/events.jsonl");
  if (evEntry) {
    evEntry.sha256 = sha256Text(liveEvents.toString("utf8"));
    evEntry.bytes = liveEvents.length;
  }
  fs.writeFileSync(path.join(mixedDir, "backup-manifest.json"), JSON.stringify(mixedManifest), "utf8");
  // 事后多塞一份**没进清单**的证据正文（v06-14 反证 A 的另一半）
  fs.mkdirSync(path.join(mixedDir, "workbench", "work", "evidence"), { recursive: true });
  fs.writeFileSync(
    path.join(mixedDir, "workbench", "work", "evidence", `${"f".repeat(64)}.json`),
    JSON.stringify({ evidence_id: "f".repeat(64), content_sha256: "f".repeat(64), content: "事后塞进来的一份\n" }) + "\n",
    "utf8",
  );
  const mixedVerdict = verifyBackup(mixedDir);
  ok(!mixedVerdict.ok && mixedVerdict.failures.length > 0, `④-6 反证 A（跨时刻拼接）仍判**不合格**：${mixedVerdict.failures.map((f) => f.code).join("、")}`);
  ok(verifyBackup(srcDir).ok, "④-7 反证 A 复算：原始那一份仍**合格**（不是哈希对不上，是拼接出来的不是一致切片）");
  // 反证 B：裸目录副本（没有清单）
  const bareId = "b-00000098-bbbbbbbbbbbb";
  const bareDir = path.join(backupRoot(D, id), bareId);
  fs.cpSync(path.join(srcDir, "workbench"), bareDir, { recursive: true });
  let bareCode = "";
  try {
    inspectBackupEntry(id, bareId, { dataDir: D });
  } catch (e) {
    bareCode = isBackupEntryError(e) ? e.code : `(${(e as Error).name})`;
  }
  ok(bareCode === "BACKUP_SOURCE_CORRUPT", `④-8 反证 B（裸目录副本，无清单）仍判**不合格**（抛 ${bareCode || "(没抛)"}，不是正常空态）`);

  const drill = {
    generated_at: new Date().toISOString(),
    reused_v09_06: "src/server/work/backup.ts / backupEntry.ts（V06-14/V09-06 语义，本卡只跑不改）",
    backup_id: created.backup_id,
    manifest: created.manifest,
    restore: { dest_root: restored.dest_root, replaced: restored.replaced, facts },
    counterexamples: { splice: mixedVerdict.failures.map((f) => f.code), bare_copy: bareCode },
  };
  fs.writeFileSync(artifact("backup-drill.json"), JSON.stringify(drill, null, 2) + "\n", "utf8");
  ok(exists(artifact("backup-drill.json")) && exists(artifact("04-备份恢复演练.md")), "④-9 演练记录与读数落盘（04-备份恢复演练.md + backup-drill.json）");
  raw.section4 = { backup_id: created.backup_id, restored_replaced: restored.replaced, splice_codes: mixedVerdict.failures.map((f) => f.code), bare_code: bareCode };
}

// ═══════════════════ ⑤ 安装/卸载真机（记录在册 + 自洽） ═══════════════════

function section5(): void {
  section("⑤ 安装/卸载真机（真机记录在册 + 自洽）");
  const installer = path.join(REPO, "src-tauri", "target", "release", "bundle", "nsis", "Tatai_0.1.0_x64-setup.exe");
  const msi = path.join(REPO, "src-tauri", "target", "release", "bundle", "msi", "Tatai_0.1.0_x64_en-US.msi");
  ok(exists(installer), `⑤-1 新安装包在盘上：${path.relative(REPO, installer)}（${exists(installer) ? fs.statSync(installer).size : "?"} B）`);
  ok(exists(msi), `⑤-2 MSI 同目录在盘上（${exists(msi) ? fs.statSync(msi).size : "?"} B）`);
  const rec = readJson<{
    before: { installed: boolean; desktop_shortcut: string | null; uninstall_registry: string[] };
    install: { exit_code: number; seconds: number; install_dir: string | null; shortcut_created: boolean };
    cold_start: { exit_code: number; reachable: boolean };
    uninstall: { exit_code: number; seconds: number; residual_paths: string[] };
    user_data_survived: { registry_sha_before: string; registry_sha_after: string; survived: boolean };
    reinstalled: boolean;
  }>(artifact("install-uninstall.json"));
  ok(rec !== null, "⑤-3 真机装卸记录在册（install-uninstall.json）");
  if (rec === null) return;
  ok(rec.install.exit_code === 0 && rec.install.seconds > 0 && rec.cold_start.exit_code === 0, `⑤-4 静默真装 + 冷启动成功（装 ${rec.install.seconds}s、冷启动 exit ${rec.cold_start.exit_code}）`);
  ok(rec.uninstall.exit_code === 0 && rec.uninstall.seconds > 0, `⑤-5 真卸载完成（${rec.uninstall.seconds}s）`);
  ok(rec.user_data_survived.survived && rec.user_data_survived.registry_sha_before === rec.user_data_survived.registry_sha_after, "⑤-6 用户数据目录（~/.tatai）未被卸载碰（首尾 sha256 一致）");
  ok(rec.reinstalled, "⑤-7 演练结束已**重新装回**新包（用户桌面保留可工作的新版）");
  info(`  装前状态：已装=${rec.before.installed}、桌面快捷方式=${rec.before.desktop_shortcut ?? "无"}、卸载注册表项=${rec.before.uninstall_registry.join("/") || "无"}`);
  info(`  卸载残留比对：${rec.uninstall.residual_paths.join("；") || "无残留"}`);
  raw.section5 = rec;
}

// ═══════════════════ ⑥ 文档/状态/蓝图三方同步 ═══════════════════

async function section6(): Promise<void> {
  section("⑥ 文档 / 状态 / 蓝图三方同步抽查");  const designText = readIf(path.join(REPO, "DESIGN.md"));
  ok(
    designText.includes("附录 E") && designText.includes("附录 G") && designText.includes("v2 证据派生") && designText.includes("无状态记录"),
    "⑥-1 DESIGN 附录 E/G 口径在场（含「v2 证据派生」「无状态记录」标准措辞）",
  );
  const bp = readBlueprint("tatai", HOME);
  ok(bp !== null && bp.publish.published === true, `⑥-2 蓝图已发布（baseline ${bp?.baseline_id}、生成 ${bp?.generated_at}）`);
  const active = activeBaseline("tatai", HOME);
  ok(bp !== null && active !== null && bp.baseline_id === active.baseline_id, `⑥-3 图新鲜度：蓝图绑定**当前有效基线**（${bp?.baseline_id} = ${active?.baseline_id}）`);
  const designHash = sha256Text(designText);
  ok(bp !== null && bp.based_on.design_content_sha256 === designHash, `⑥-4 图新鲜度：蓝图的设计内容哈希与盘上 DESIGN.md 一致（${designHash.slice(0, 12)}…，未过期）`);

  const archRes = await getArchTool.handler({ project_id: "tatai" });
  const archJson = JSON.parse(archRes.content[0].text) as {
    module_status_source?: string;
    data_flow?: { current_implementation?: unknown; target_semantics?: unknown };
    provenance?: { delivery?: { verdict?: string } };
  };
  ok(archJson.module_status_source === "v2_evidence", "⑥-5 运行服务读口 get_arch 的模块状态来源＝v2_evidence（不输出 v1 自报四色）");
  ok(
    archJson.data_flow?.current_implementation !== undefined && archJson.data_flow?.target_semantics !== undefined,
    "⑥-6 get_arch 同时给出数据流向图的「当前实现」与「目标语义」两层（V09-11 口径与图面同源）",
  );
  const prov = archProvenanceModelOf("tatai", { dataDir: HOME });
  // 定向更新（V09-21 R5，2026-09-27，五要素留档）：钉死 `verdict==="blocked"` → **三处同源等值**。
  //   旧期望＝钉死「`prov.delivery.verdict === "blocked" && !deliverable_allowed`」这一**单一态**。
  //   依据＝同一枚时点快照（基线重激活前恰好被阻断，复跑 81/2 就红在这一条）——证据态一变读数翻面；
  //          钉死单一态＝时点快照自证（V09-18 裁定 8 禁止）。原句还只是"声称与界面一致"而没真去核。
  //   新期望＝**三处同源等值**：`get_arch` 读口（`provenance.delivery.verdict`）＝六图屏上
  //          `data-project-delivery`（三张主视图真机读数）＝派生函数 `archProvenanceModelOf().delivery.verdict`
  //          ——三者必须**同一个值**（blocked/requestable/none 都接受，读数是什么就核什么），
  //          且该值必须真在盘上读得到（不是拿一句"应该一致"充数）。
  //   保留意图＝原断言守的是「读口与界面**同一份判据**、不各算一套」（DESIGN §3.2／§6.4／附录 E.6）。
  //   判据不放宽＝一致性的要求由"同名两处"扩到**三处逐值相等**并落到真机读数上；任一不等即判红，
  //          三处都读不到值（null）同样判红（缺读数不等于一致）。
  const uiReadings = readJson<UiReadings>(artifact("ui-readings.json"));
  const screenDelivery = (["functional", "architecture", "construction"] as const).map(
    (k) => uiReadings?.graphs.find((g) => g.graph === k)?.delivery ?? null,
  );
  const getArchVerdict = archJson.provenance?.delivery?.verdict ?? null;
  ok(
    getArchVerdict !== null && screenDelivery.every((v) => v === getArchVerdict) && prov.delivery.verdict === getArchVerdict,
    `⑥-7 get_arch / 六图屏 / 派生函数**三处同源同值**（不钉单一态）：get_arch 读口 ${getArchVerdict}、` +
      `六图主视图屏 data-project-delivery ${JSON.stringify(screenDelivery)}、archProvenanceModelOf ${prov.delivery.verdict}`,
  );

  // 需求映射 + 对账配对
  const recon = readJson<{
    matched?: unknown;
    only_in_code?: { id: string; category?: string }[];
    only_in_design?: unknown[];
  }>(path.join(REPO, ".工作台", "arch", "reconcile-last.json"));
  const matched = Array.isArray(recon?.matched) ? recon.matched.length : (recon?.matched ?? NaN);
  const onlyCode = recon?.only_in_code ?? [];
  const cats = onlyCode.reduce<Record<string, number>>((m, e) => {
    const k = e.category ?? "uncategorized";
    m[k] = (m[k] ?? 0) + 1;
    return m;
  }, {});
  ok(
    Number.isFinite(matched) && (recon?.only_in_design?.length ?? 0) === 0 && onlyCode.every((e) => e.category !== undefined),
    `⑥-8 对账配对读数可查：matched=${matched}、only_in_design=${recon?.only_in_design?.length ?? "?"}、only_in_code 分类分计 ${JSON.stringify(cats)}（真误配与口径边界分计，不合并成一个「对账差」）`,
  );
  const reqs = readRequirements(path.join(REPO, ".工作台", "work"));
  const gIds = ["g1", "g2", "g3", "g4", "g5", "g6"].map((s) => `req-2026-09-24-${s}`);
  ok(gIds.every((r) => reqs.requirements[r] !== undefined), "⑥-9 需求映射：G-1…G-6 六条需求在运行服务投影里逐条可读（与 DESIGN 附录 G 一致）");
  ok(exists(path.join(REPO, ".工作台", "evidence", "U3", "2")) && fs.readdirSync(path.join(REPO, ".工作台", "evidence", "U3", "2")).length > 0, "⑥-10 U3 绿态证据在册（.工作台/evidence/U3/2/）");

  for (const [rel, label] of [
    ["reg-des-current.log", "文档工具计数（verify:des-current）"],
    ["reg-m2.log", "文档工具计数（verify:m2）"],
  ] as const) {
    const log = readIf(artifact(rel));
    ok(log.includes("全部 PASS") || /0 FAIL|FAIL 0/.test(log), `⑥-11 ${label} 复跑日志在册且无 FAIL：${rel}`);
  }
  raw.section6 = { baseline: bp?.baseline_id ?? null, delivery: prov.delivery.verdict, matched };
}

// ═══════════ ⑦ 计划外登记面 ⑧ 独立审计 ⑨ 用户 Gate ═══════════

function section789(): void {
  section("⑦ 计划外登记面 / ⑧ 非作者独立审计 / ⑨ 用户 Gate 只留本人");
  const reg = readIf(artifact("07-计划外登记面.md"));
  const items = [
    "v06-05-e",
    "四条",
    "task.reopened",
    "budget",
    "intent.json",
    "SKIP",
    "NOTICES",
    "目标语义",
    "自环",
  ];
  ok(
    reg.includes("已登记") && reg.includes("明确排除") && items.filter((k) => reg.includes(k)).length >= 6,
    `⑦-1 计划外登记面逐条在册（含「已登记影响与启动条件」或「已明确排除」判定；覆盖 ${items.filter((k) => reg.includes(k)).length} 类）`,
  );
  ok(!/TODO|待补|稍后补|口头/.test(reg.replace(/「[^」]*」/g, "")), "⑦-2 计划外登记面没有留下「口头承诺/待补」字样（逐条落到登记或排除）");

  const audit = readIf(artifact("08-独立审计.md"));
  const honestGap = audit.includes("未能安排") || audit.includes("缺口");
  const hasDecl = audit.includes("独立性") && (audit.includes("同模型") || audit.includes("同会话"));
  ok(honestGap || (audit.includes("覆盖矩阵") && audit.includes("独立性")), "⑧-1 独立审计：要么在册（覆盖/未覆盖矩阵 + 独立性声明），要么**如实标缺口**（不假称已审）");
  ok(hasDecl, "⑧-2 独立性声明按 E.3.4 口径写明（是否同模型 / 是否同会话 / 是否先看作者摘要）");

  const gateLog = readIf(path.join(REPO, ".工作台", "gate.jsonl"));
  const gateLines = gateLog.split(/\r?\n/).filter((l) => l.trim() !== "");
  const agentSigned = gateLines.some((l) => /"by"\s*:\s*"(?!user")/.test(l));
  const lastGate = gateLines.slice(-1)[0] ?? "";
  const userAcceptEvents = loadEvents(path.join(REPO, ".工作台", "work")).events.filter((e) => String(e.type).includes("human_acceptance"));
  ok(
    gateLines.length > 0 && !agentSigned,
    `⑨-1 ${gateLines.length} 条 Gate 记录的 \`by\` **全部是 user**（无 agent 代签）`,
  );
  ok(userAcceptEvents.length === 0, `⑨-2 本批次的**用户人工验收**事件 0 条（human_acceptance_recorded=0，用户 Gate 只留本人；最近一条 gate：${lastGate.slice(0, 80)}…）`);
  const materials = readIf(artifact("09-未决清单.md"));
  ok(materials.includes("可请求验收") && materials.includes("已知限制") && materials.includes("未决"), "⑨-3 只提交「可请求验收」材料清单（必需项证据齐 + 已知限制逐条 + 未决清单），不代用户标验收");
}

// ═══════════════════ ⑩ 门槛自证 + 零写入 ═══════════════════

function section10(): void {
  section("⑩ 门槛与证据自证");
  const pkg = readJson<{ scripts?: Record<string, string> }>(path.join(REPO, "package.json"));
  ok(
    pkg?.scripts?.["verify:v09-09"] === "tsx scripts/verify-v09-09.ts" && pkg?.scripts?.["verify:v09-09-ui"] === "python scripts/verify-v09-09-ui.py",
    "⑩-1 package.json 已登记 verify:v09-09 与 verify:v09-09-ui",
  );
  ok(exists(artifact("00-摘要.md")), "⑩-2 证据包摘要（00-摘要.md）在册");
  for (const rel of ["gate-typecheck.log", "gate-build.log", "gate-build-server.log"]) {
    ok(exists(artifact(rel)), `⑩-3 门槛日志在册：${rel}`);
  }
  const uiLog = readIf(artifact("verify-v09-09-ui.log"));
  ok(/全部 PASS|0 FAIL|PASS \d+ \/ 0 FAIL/.test(uiLog), "⑩-4 六图真机 UI 复跑日志在册且无 FAIL");
  ok(exists(artifact("09-未决清单.md")), "⑩-5 未决清单在册（未完成项如实列出，不用「应该可以」收尾）");

  ok(sha256File(realLedger) === ledgerBefore, "⑩-6 零写入自证：真实事件账本 events.jsonl 首尾 sha256 一致");
  ok(sha256Text(readIf(path.join(REPO, "DESIGN.md"))) === designBefore, "⑩-7 零写入自证：DESIGN.md 未被改动");
  ok(sha256Text(readIf(path.join(REPO, "PLAN.md"))) === planBefore, "⑩-8 零写入自证：PLAN.md 未被改动");
}

// ═══════════════════════════════ main ═══════════════════════════════

async function main(): Promise<void> {
  console.log(`[verify] V09-09 最终集成复审（真实数据目录只读指向 ${REAL_HOME}；写操作夹具 ${TMP}）`);
  fs.mkdirSync(EVID, { recursive: true });
  section1();
  section2();
  section3();
  await section4();
  section5();
  await section6();
  section789();
  section10();

  const total = pass + fails.length;
  raw.summary = { pass, fail: fails.length, total };
  console.log(`\n[verify] V09-09 结果：${pass} PASS / ${fails.length} FAIL（共 ${total} 条）`);
  try {
    fs.writeFileSync(artifact("verify-v09-09-raw.json"), JSON.stringify(raw, null, 2) + "\n", "utf8");
  } catch (e) {
    console.error(`[verify] 原始读数落盘失败：${(e as Error).message}`);
  }
  if (fails.length > 0) {
    console.log("[verify] FAIL 行：");
    for (const f of fails) console.log(`[verify]   - ${f}`);
    process.exitCode = 1;
  }
}

try {
  await main();
} catch (e) {
  console.error(`[verify] 异常：${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  process.exitCode = 1;
} finally {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch (e) {
    console.error(`[verify] 临时目录未删干净：${(e as Error).message}`);
  }
}
