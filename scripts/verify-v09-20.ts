// V09-20 验证脚本（tsx 跑）：六图信息区「简短默认态＋按需详情」、详情不吃画布、下钻控件可达性。
// 用法：pnpm verify:v09-20
//
// 覆盖（逐条对着 PLAN V09-20 卡面「检查项」）：
//   ① 默认态＝一行：`DeliveryReadoutPanel` 的 **summary 本身**只给结论徽标 + 阻断/待验条数 + 查看入口，
//      不含五档图例、能力分类长解释、逐条名单、常显的「不代签」说明。反例：默认态仍平铺长条 ⇒ 判红。
//   ② 收起≠删数据：五档 chip、`data-delivery-reason` 逐条、`data-delivery-pending` 逐条、
//      完整计数、能力分类、来源口径句在**展开区**逐条在场；`data-delivery-*` 读数一个不少。
//   ③ 异常默认可见（正反两边）：有阻断 ⇒ 默认行给条数与各档构成、**不给**「可请求验收」；
//      无阻断 ⇒ 默认行**必带「尚未验收」限定**（防把「可请求验收」读成用户已接受）。
//   ④ 详情是**浮层**（不参与纵向排版）＋可关闭：源码级判据（`absolute … top-full` + 关闭钮）。
//   ⑤ 下钻控件可达性：展开钮**反缩放**到屏幕命中区（源码级判据）＋展开补视口**只框新子树、
//      minZoom=可读下限、maxZoom=当前**（不再整图重 fit）。
//   ⑥ 文档／卡面同源：DESIGN §3.11／§4.2／§4.6 与本轮附录 E.19、PLAN V09-20 卡与需求绑定在场。
//   ⑦ 判据只此一份：三个 UI 文件共用同一份渲染件；本脚本已在 package.json 登记。
//
// 隔离口径：只读真实 DESIGN.md／PLAN.md／源码；不写任何数据、不调 MCP 写工具。
import fs from "node:fs";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  DELIVERY_BLOCKED_CONCLUSION,
  DELIVERY_REQUESTABLE_CONCLUSION,
  EVIDENCE_STATE_ORDER,
  type DeliveryReadout,
  type ModelLeadInfo,
} from "../src/ui/arch/provenance";
import { GraphAttentionBar } from "../src/ui/arch/ProvenancePanel";
import { REPO_ROOT } from "./lib/fixtures";

let pass = 0;
const fails: string[] = [];
const ok = (cond: boolean, label: string): void => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (cond) pass += 1;
  else fails.push(label);
};
const info = (msg: string): void => console.log(`[verify]   ${msg}`);
const section = (t: string): void => console.log(`\n[verify] ── ${t} ──`);

const read = (rel: string): string => fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");

/** 夹具读数：阻断（缺证 + 证据失效 + 未映射 + 未验证各若干）／无阻断（只有人工待验） */
function readoutOf(kind: "blocked" | "requestable"): DeliveryReadout {
  const counts = {
    objects: 12,
    unmapped: 2,
    verified: 4,
    verified_source_mapping: 3,
    verified_functional: 1,
    user_pending: 3,
    unverified: 1,
    missing: 2,
    invalidated: 1,
    capability_functional: 7,
    capability_governance: 5,
    capability_unclassified: 0,
  };
  if (kind === "blocked") {
    return {
      verdict: "blocked",
      conclusion: DELIVERY_BLOCKED_CONCLUSION,
      deliverable_allowed: false,
      user_accepted: false,
      reasons: [
        "未映射：plan:concept:推断（没有需求/设计/代码来源）",
        "缺证：plan:task:T-9（必需检查缺 1 项）",
        "证据失效：plan:task:T-7（设计章节改名后来源对不上）",
      ],
      user_pending: ["用户待验：U1（人工验收待用户本人记录）"],
      counts,
      note: "本读数不给完成百分比（P9）。",
    };
  }
  return {
    verdict: "requestable",
    conclusion: DELIVERY_REQUESTABLE_CONCLUSION,
    deliverable_allowed: true,
    user_accepted: false,
    reasons: [],
    user_pending: [
      "用户待验：U1（人工验收待用户本人记录）",
      "用户待验：U2（人工验收待用户本人记录）",
      "用户待验：U3（人工验收待用户本人记录）",
    ],
    counts: { ...counts, unmapped: 0, unverified: 0, missing: 0, invalidated: 0, verified: 12 },
    note: "全部对象的来源、映射与必需证据都在场且有效 ⇒ 最多给「可请求验收」（P9）。",
  };
}

/** 取 <summary> 那段 HTML（默认态的真正内容；浮层里的东西不算默认态） */
function summaryHtml(html: string): string {
  const m = html.match(/<summary[\s\S]*?<\/summary>/);
  return m === null ? "" : m[0];
}

/** 常驻行数 = 可见摘要条数（每条常驻栏恰好一个 `<summary>`；浮层内容不算新行）。 */
const barRowsOf = (html: string): number => (html.match(/<summary/g) ?? []).length;

/** 一条待审线索（模型提案·未审定）：它是**可行动异常**，信息栏据此出现——真实 tatai 当前就是这个形态 */
const PENDING_LEAD: ModelLeadInfo = {
  source: "plan:cap:07",
  target: "plan:code:src",
  kind: "design_interface",
  model_certainty: "inferred",
  disposition: "lead_pending_review",
  source_refs: [],
};

function main(): void {
  section("① 默认态＝一行（含反例）；健康态整条不出现");
  {
    // V09-20 回归修复（2026-09-27，五要素留档）：
    //   旧期望＝`DeliveryReadoutPanel` 渲染 requestable 夹具时就出**一行常驻摘要**（无阻断也占一行）｜
    //   依据＝V09-20 当时只把"长条"压成一行，没有"健康态整条隐藏"｜
    //   新期望＝六图共用 `GraphAttentionBar`：健康态（无阻断／分类未定 0／无待审线索）**0 行**；
    //         有可行动异常时恰好**一条合并栏**（交付读数＋待审线索），摘要仍是一行｜
    //   保留意图＝默认态只给结论徽标＋异常/待办条数＋查看入口（不平铺图例与长解释、不常显「不代签」）｜
    //   判据不放宽：出栏时摘要仍必须短且异常可见（下面每条断言一字未改，只把"无阻断态"夹具补上
    //         一条真实形态的待审线索，使那条栏确实出现）。
    const blockedHtml = renderToStaticMarkup(
      React.createElement(GraphAttentionBar, { delivery: readoutOf("blocked"), anchor: "t-blocked" }),
    );
    const requestableHtml = renderToStaticMarkup(
      React.createElement(GraphAttentionBar, { delivery: readoutOf("requestable"), leads: [PENDING_LEAD], anchor: "t-requestable" }),
    );
    const healthyHtml = renderToStaticMarkup(
      React.createElement(GraphAttentionBar, { delivery: readoutOf("requestable"), anchor: "t-healthy" }),
    );
    const sBlocked = summaryHtml(blockedHtml);
    const sOk = summaryHtml(requestableHtml);
    info(`阻断态默认摘要 HTML 长度 ${sBlocked.length}；无阻断态 ${sOk.length}；健康态 ${summaryHtml(healthyHtml).length}`);
    ok(
      summaryHtml(healthyHtml) === "" && !healthyHtml.includes("<summary") && healthyHtml.includes('data-graph-info-rows="0"'),
      "① 健康态**整条信息栏不出现**（0 行）：可请求验收／尚未验收／人工待验不再常驻占行——机器读数仍在",
    );
    ok(healthyHtml.includes("data-delivery-counts=") && healthyHtml.includes("data-delivery-conclusion="), "① 健康态完整机器读数保留（data-delivery-counts/conclusion 照读）");
    ok(blockedHtml.includes('data-graph-info-rows="1"') && requestableHtml.includes('data-graph-info-rows="1"'), "① 有可行动异常时恰好一条栏（rows=1）");
    ok(
      barRowsOf(blockedHtml) === 1 && barRowsOf(requestableHtml) === 1,
      "① 合并栏**唯一一条**：交付读数与待审线索不再各占一排（不重复上屏）",
    );
    // 默认态**不含**五档图例 / 能力分类长解释 / 逐条名单 / 常显「不代签」说明
    for (const [label, s] of [["阻断态", sBlocked], ["无阻断态", sOk]] as const) {
      ok(!s.includes("data-delivery-state-chip"), `① ${label}默认摘要里**没有**五档图例 chip（不是把长条留在 summary）`);
      ok(!s.includes("data-delivery-capability-classes"), `① ${label}默认摘要里**没有**能力分类长解释`);
      ok(!s.includes("data-delivery-reason="), `① ${label}默认摘要里**没有**逐条阻断名单`);
      ok(!s.includes("data-delivery-pending="), `① ${label}默认摘要里**没有**逐条待验名单`);
      ok(!s.includes("Agent 不代签") && !s.includes("不代签"), `① ${label}默认摘要里**没有**常显的「不代签」说明句`);
      ok(!/data-delivery-not-accepted-brief/.test(s), `① ${label}已删除常显的 data-delivery-not-accepted-brief 行（下面那行常显说明没了）`);
    }
    // 结论徽标 + 条数 + 查看入口（异常在默认态可见）
    ok(sBlocked.includes(`data-delivery-conclusion-badge="${DELIVERY_BLOCKED_CONCLUSION}"`), "① 阻断态默认摘要带结论徽标（不可判定项目可交付）");
    ok(sBlocked.includes("阻断") && sBlocked.includes("data-delivery-brief-blocked"), "① 阻断态默认摘要给「阻断 N 项」");
    ok(sBlocked.includes("未验证") && sBlocked.includes("证据失效"), "① 阻断态默认摘要给出各档构成（简短原因，不是只给一个总数）");
    ok(sBlocked.includes("查看原因"), "① 阻断态默认摘要给「查看原因」入口");
    ok(!sBlocked.includes(DELIVERY_REQUESTABLE_CONCLUSION), "① 阻断态默认摘要**不出现**「可请求验收」（不给误导结论）");
    ok(sOk.includes(`data-delivery-conclusion-badge="${DELIVERY_REQUESTABLE_CONCLUSION}"`), "① 无阻断态默认摘要带结论徽标（可请求验收）");
    ok(sOk.includes("尚未验收") && sOk.includes("data-delivery-brief-not-accepted"), "① 无阻断态默认摘要**必带「尚未验收」限定**（防被读成已验收）");
    ok(sOk.includes("3 项待你确认") && sOk.includes("data-delivery-brief-pending"), "① 无阻断态默认摘要给「N 项待你确认」（人工待验条数）");
    ok(sOk.includes("查看详情"), "① 无阻断态默认摘要给「查看详情」入口");
  }

  section("② 收起≠删数据（展开区逐条完整）");
  {
    const blockedHtml = renderToStaticMarkup(
      React.createElement(GraphAttentionBar, { delivery: readoutOf("blocked"), anchor: "t-blocked" }),
    );
    // 同一处补待审线索夹具（理由见 ① 段的五要素留档）：无阻断态的那条栏只在有可行动异常时出现。
    const requestableHtml = renderToStaticMarkup(
      React.createElement(GraphAttentionBar, { delivery: readoutOf("requestable"), leads: [PENDING_LEAD], anchor: "t-requestable" }),
    );
    const d = readoutOf("blocked");
    ok(
      blockedHtml.includes(`data-delivery-reasons="${d.reasons.length}"`) &&
        d.reasons.every((_, i) => blockedHtml.includes(`data-delivery-reason="${i}"`)),
      `② 逐条阻断原因 ${d.reasons.length} 条一条不少（data-delivery-reason 0…${d.reasons.length - 1}）`,
    );
    ok(
      blockedHtml.includes(`data-delivery-user-pending="${d.user_pending.length}"`) &&
        d.user_pending.every((_, i) => blockedHtml.includes(`data-delivery-pending="${i}"`)),
      `② 逐条人工待验 ${d.user_pending.length} 条一条不少`,
    );
    ok(
      blockedHtml.includes("data-delivery-state-legend") &&
        blockedHtml.includes('data-delivery-state-chip="unmapped"') &&
        EVIDENCE_STATE_ORDER.every((s) => blockedHtml.includes(`data-delivery-state-chip="${s}"`)),
      "② 五档 chip（＋未映射）在展开区里逐档在场（口径本身没被删）",
    );
    ok(
      blockedHtml.includes("data-delivery-counts-full") &&
        blockedHtml.includes(`data-delivery-counts="${Object.entries(d.counts).map(([k, v]) => `${k}=${v}`).join(",")}"`),
      "② 完整计数在展开区（且 data-delivery-counts 属性与修前同口径：逐键逐值）",
    );
    ok(
      blockedHtml.includes("data-delivery-capability-classes") &&
        blockedHtml.includes("data-delivery-capability-counts="),
      "② 能力分类计数仍在（功能 7 / 治理 5 的解释不删）",
    );
    ok(
      requestableHtml.includes("data-delivery-not-accepted") &&
        requestableHtml.includes("仍不等于用户接受"),
      "② 规范句「可请求验收仍不等于用户接受…Agent 不代签」进入展开区（仍在页面上）",
    );
    ok(blockedHtml.includes("data-delivery-note"), "② 口径 note 仍在展开区");
    ok(!/\d+\s*%/.test(blockedHtml), "② 读数不给百分比（P9）");
    ok(
      blockedHtml.includes("data-delivery-detail-body") && blockedHtml.includes("data-delivery-detail-close"),
      "② 展开区是**可关闭的详情体**（data-delivery-detail-body / data-delivery-detail-close）",
    );
  }

  section("③ 详情不吃画布（源码级判据）");
  {
    const src = read("src/ui/arch/ProvenancePanel.tsx");
    ok(/data-delivery-detail-body/.test(src) && /absolute[^"]*top-full/.test(src), "③ 详情体**绝对定位**（浮层：不参与纵向排版 ⇒ 展开多少都不压画布）");
    ok(/max-h-\[60vh\]/.test(src) && /overflow-y-auto/.test(src), "③ 详情体自带高度上限 + 独立滚动（长名单在内部滚）");
    ok(/detailsRef/.test(src) && /\.open = false/.test(src), "③ 关闭钮真的收起 <details>（不是只隐藏视觉）");
    for (const [rel, sel] of [
      ["src/ui/arch/ProjectGraphView.tsx", "data-project-canvas-host"],
      ["src/ui/components/ArchView.tsx", "data-arch-canvas-host"],
    ] as const) {
      const s = read(rel);
      const idx = s.indexOf(sel);
      const near = idx < 0 ? "" : s.slice(Math.max(0, idx - 220), idx);
      ok(idx >= 0 && /min-h-\[\d+px\]/.test(near), `③ ${rel} 的画布宿主带最小高度（${sel} 同行前 220 字内有 min-h-[Npx]）`);
    }
    const canvasSrc = read("src/ui/arch/ArchCanvas.tsx");
    ok(
      canvasSrc.includes("data-reconcile-detail") && /max-h-48[^"]*overflow-y-auto/.test(canvasSrc),
      "③ 技术详情的对账长说明（口径差异段 + 两侧逐条名单）进「对账明细」按需展开、限高内部滚动",
    );
    ok(
      canvasSrc.includes('data-reconcile-only-in-code-cats') && canvasSrc.includes('data-diff-list="only_in_code"'),
      "③ 对账的汇总行与分类分计仍常显、逐条名单仍在 DOM（收起≠删数据）",
    );
  }

  section("④ 下钻控件可达性（源码级判据）");
  {
    const src = read("src/ui/arch/ArchCanvas.tsx");
    ok(/useStore\(\(s\) => s\.transform\[2\]\)/.test(src), "④ 展开钮读画布缩放（useStore transform[2]）");
    ok(/MAX_TOGGLE_COUNTER_SCALE/.test(src) && /transform: `scale\(\$\{toggleScale\}\)`/.test(src), "④ 展开钮按 1/zoom **反缩放**：屏幕命中区不随缩放缩到亚像素");
    ok(/h-5 w-5/.test(src), "④ 展开钮基准尺寸 20px（屏幕命中区 ≥20px）");
    ok(/REVEAL_MIN_ZOOM/.test(src), "④ 展开补视口带**可读下限**常量（不把节点缩到点不着）");
    // 定向更新（V09-21 R4，2026-09-27，五要素留档）：
    //   旧期望＝补视口 `minZoom: REVEAL_MIN_ZOOM`（0.5）钉死｜依据＝V09-20 当时只验小子树；非作者终审
    //   F-B 实测：40 个文件的大子树在 0.5 下数学上收不进视口（钳住 ⇒ 新节点展开钮甩到视口外 y=-312）｜
    //   新期望＝`minZoom: REVEAL_HARD_MIN_ZOOM`（0.1）＋ maxZoom 仍钳当前——小子树行为不变（放得下就只平移），
    //   大子树允许缩到「真框进整棵新子树」为止；展开钮有反缩放兜底（zoom≥0.1 屏幕恒 ≥20px），
    //   「看得全」不再牺牲「点得着」｜保留意图＝不整图重 fit、不抢用户缩放、控件命中区不缩到亚像素
    //   （另两条断言：不整图 fitView、反缩放、基准 20px 一律保留）｜判据不放宽：下限不能低于反缩放
    //   保证的 0.1（低于它钮 <20px），且 maxZoom=当前 的「不放大、不抢视口」口径原样保留。
    ok(
      /minZoom: REVEAL_HARD_MIN_ZOOM/.test(src) && /maxZoom: Math\.max\(REVEAL_MIN_ZOOM, current\)/.test(src),
      "④ 补视口只框**本次新长出来的子树**：minZoom=硬下限（0.1，大子树能真收进来）、maxZoom=当前（放得下就只平移）",
    );
    const start = src.indexOf("V09-20 改口径");
    const end = src.indexOf("}, [flowInstance, flow?.nodes]);", start);
    const revealBlock = start >= 0 && end > start ? src.slice(start, end) : "";
    ok(revealBlock.length > 0, "④ 找得到展开补视口那段实现（切片非空）");
    ok(!/void flowInstance\.fitView\(FIT_VIEW_OPTIONS\)/.test(revealBlock), "④ 展开补视口**不再**整图 `fitView(FIT_VIEW_OPTIONS)`（旧实现会把 76 节点缩到 0.133；注释里提到旧写法不算）");
  }

  section("⑤ 文档与卡面同源");
  {
    const design = read("DESIGN.md");
    ok(/六图页面的默认态与按需详情（2026-09-26 用户澄清）/.test(design), "⑤ DESIGN §3.11 落有人用图面口径（默认一行＋按需详情）");
    ok(/默认态也不是"把长条折起来"/.test(design), "⑤ DESIGN 明写「折叠件的摘要本身也要短」（不是再套一层折叠）");
    ok(/读数的上屏口径（2026-09-26 用户澄清）/.test(design), "⑤ DESIGN §4.2 落有读数上屏口径（收起只改篇幅不改判据）");
    ok(/下钻控件可达性与展开后的视口（2026-09-26 用户澄清）/.test(design), "⑤ DESIGN §4.6 落有下钻控件命中区与补视口口径");
    ok(/#### E\.19 六图信息区默认态、画布空间与下钻可达性落实索引/.test(design), "⑤ DESIGN 附录 E.19 登记本轮落实索引");
    const plan = read("PLAN.md");
    ok(/\| V09-20 \|/.test(plan), "⑤ PLAN 第一张当前任务表有 V09-20 行");
    ok(/### V09-20 六图界面修复合并轮/.test(plan), "⑤ PLAN 文末有 V09-20 卡定义");
    ok(/req-2026-09-26-r4/.test(plan) && /change-20260926-v0920-ui/.test(plan), "⑤ 卡面点到需求 `req-2026-09-26-r4` 与批次 `change-20260926-v0920-ui`");
  }

  section("⑥ 判据只此一份 + 脚本登记");
  {
    const users = ["src/ui/arch/ProjectGraphView.tsx", "src/ui/arch/ArchCanvas.tsx", "src/ui/arch/MindMapView.tsx"].map(
      (rel) => read(rel),
    );
    // 定向更新（V09-20 回归修复，2026-09-27，五要素留档）：
    //   旧期望＝三个 UI 文件共用同一份 `DeliveryReadoutPanel`｜依据＝V09-20 只把它压成一行｜
    //   新期望＝共用同一份 `GraphAttentionBar`（交付读数＋待审线索合成一条；健康态 0 行）｜
    //   保留意图＝默认态只此一份、不各写一套｜判据不放宽：三个文件都必须 import 且渲染它。
    ok(
      users.every((s) => s.includes('from "./ProvenancePanel"')) && users.every((s) => /<GraphAttentionBar/.test(s)),
      "⑥ 三个 UI 文件共用同一份 `GraphAttentionBar`（六图信息区只此一份，不各写一套）",
    );
    ok(
      users.every((s) => !s.includes("ModelLeadsPanel") && !s.includes("DeliveryReadoutPanel")),
      "⑥ 没有第二块独立的读数盘/线索盘（信息区合并成一条，不再重复上屏）",
    );
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    ok(pkg.scripts["verify:v09-20"] === "tsx scripts/verify-v09-20.ts", "⑥ package.json 已登记 verify:v09-20");
    ok(
      pkg.scripts["verify:v09-20-ui"] === "python scripts/verify-v09-20-ui.py",
      "⑥ package.json 已登记 verify:v09-20-ui（逐页真浏览器）",
    );
  }

  console.log(`\n[verify] V09-20 ${pass} PASS / ${fails.length} FAIL`);
  if (fails.length > 0) {
    for (const f of fails) console.log(`[verify]   FAIL ${f}`);
    process.exitCode = 1;
  }
}

main();
