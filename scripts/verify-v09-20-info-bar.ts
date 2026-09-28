// V09-20 回归修复验证（2026-09-27，用户指令）：**六图信息区**（交付读数＋待审线索）的
// 「健康态 0 行 / 有问题恰好 1 行合并问题栏 / 详情浮层不吃画布 / 六图共用一份渲染件」。
// 用法：pnpm verify:v09-20-info-bar
//
// 为什么单独一个脚本：V09-20 原脚本只测**单个 `DeliveryReadoutPanel` 的 summary**，测不出
// 「整个信息区 0 或 1 行」——当时的 `ProjectGraphView` 在画布上方**连续两块**
// （`DeliveryReadoutPanel` ＋ `ModelLeadsPanel`），于是健康态也占一行、有线索时占两行。
// 本脚本按**信息区整体**判：
//   · 行数用「可见摘要条数」（每条常驻栏恰好一个 `<summary>`）度量——与实现无关（换组件仍成立），
//     浮层里的内容不算新行；
//   · 再叠加新锚点 `data-graph-info-*` 的口径判据（健康态 rows=0、有问题 rows=1 且唯一一条合并栏）。
//
// 判据来源：DESIGN §3.11（六图默认态与按需详情）／§4.2（读数上屏口径）／附录 E.19 ＋
// 附录 E.20（本次回归修复的落实索引）；不改证据判据、不删数据、不给完成色、不代签用户 Gate。
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
  USER_PENDING_LABEL,
  type DeliveryReadout,
  type ModelLeadInfo,
  type ModelNodeLeadInfo,
} from "../src/ui/arch/provenance";
import { GraphAttentionBar, attentionCountsOf } from "../src/ui/arch/ProvenancePanel";
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

// ───────────────────── 夹具 ─────────────────────

const baseCounts = {
  objects: 12,
  unmapped: 0,
  verified: 12,
  verified_source_mapping: 0,
  verified_functional: 12,
  user_pending: 3,
  unverified: 0,
  missing: 0,
  invalidated: 0,
  capability_functional: 7,
  capability_governance: 5,
  capability_unclassified: 0,
};

/** 健康态：交付无阻断、能力分类未定 0（只有 3 项人工待验——它本身不是图结构/证据异常） */
function healthyReadout(): DeliveryReadout {
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
    counts: { ...baseCounts },
    note: "全部对象的来源、映射与必需证据都在场且有效 ⇒ 最多给「可请求验收」（P9）。",
  };
}

/** 阻断态：未映射 2 / 未验证 1 / 缺证 2 / 证据失效 1（逐条点名） */
function blockedReadout(): DeliveryReadout {
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
    counts: { ...baseCounts, unmapped: 2, unverified: 1, missing: 2, invalidated: 1, verified: 4 },
    note: "本读数不给完成百分比（P9）。",
  };
}

/** 能力分类未定（R-1：声明表损坏）——没有交付阻断，也没有待审线索，仍属可行动异常 */
function unclassifiedReadout(): DeliveryReadout {
  return { ...healthyReadout(), counts: { ...baseCounts, capability_unclassified: 2, capability_functional: 5 } };
}

const relLead = (i: number): ModelLeadInfo => ({
  source: `plan:cap:0${i}`,
  target: `plan:code:m${i}`,
  kind: "design_interface",
  model_certainty: "inferred",
  disposition: "lead_pending_review",
  source_refs: [],
});

const nodeLead = (i: number): ModelNodeLeadInfo => ({
  id: `plan:concept:c${i}`,
  kind: "concept",
  name: `模型自报概念 ${i}`,
  target: "new_node",
  disposition: "lead_pending_review",
  proposed_source_refs: [],
  proposed_related_ids: [],
});

const PENDING_LEADS = [relLead(1), relLead(2), relLead(3)];
const PENDING_NODE_LEADS = [nodeLead(1)];

// ───────────────────── 生产渲染（本次修复对象） ─────────────────────

interface InfoAreaProps {
  delivery: DeliveryReadout;
  leads?: readonly ModelLeadInfo[];
  nodeLeads?: readonly ModelNodeLeadInfo[];
  anchor: string;
}

/**
 * 六图信息区的**生产渲染**——本次回归修复改的就是这一处。六个调用点（三主视图 / 模块方框图 /
 * 数据流向图 / 思维导图）都渲染这同一个 `GraphAttentionBar`。
 *
 * 定向更新留档（五要素）：旧期望＝当时的 `ProjectGraphView` **连续**渲染 `DeliveryReadoutPanel`
 * ＋`ModelLeadsPanel` 两块（本脚本 RED 阶段渲染的就是这条组合，17 PASS / 15 FAIL，退出码 1）；
 * 依据＝用户 2026-09-27 指令（健康态整条隐藏、有问题最多一行）＋ DESIGN §3.11／§4.2；
 * 新期望＝同一条共享信息栏（`GraphAttentionBar`）；保留意图＝本脚本的 6 段判据一字未改
 * （行数用「可见摘要条数」度量，与实现无关）；判据不放宽＝健康态仍必须 0 行、有问题仍必须恰好 1 行。
 */
function renderInfoArea(p: InfoAreaProps): string {
  return renderToStaticMarkup(
    React.createElement(GraphAttentionBar, {
      delivery: p.delivery,
      leads: p.leads ?? [],
      nodeLeads: p.nodeLeads ?? [],
      anchor: p.anchor,
    }),
  );
}

/** 常驻行数 = 可见摘要条数（每条常驻栏恰好一个 `<summary>`；浮层内容不算新行）。 */
const rowsOf = (html: string): number => (html.match(/<summary/g) ?? []).length;

/** React 静态渲染会把属性值里的 `&<>"'` 转义（关系 id 形如 `a>b:kind`）：断言时按同一口径比 */
const attrValue = (v: string): string =>
  v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

function main(): void {
  section("① 健康态：信息区**不占任何常驻行**（0 行）且机器读数保留");
  {
    const html = renderInfoArea({ delivery: healthyReadout(), anchor: "project-functional" });
    info(`健康态信息区摘要条数 ${rowsOf(html)}（期望 0）`);
    ok(rowsOf(html) === 0, "① 健康态（无阻断／分类未定 0／无待审线索）信息区 0 行——「可请求验收／尚未验收／人工待验」不再常驻占行");
    ok(html.includes('data-delivery-readout="project-functional"'), "① 健康态数据锚点仍在（data-delivery-readout）");
    ok(html.includes(`data-delivery-conclusion="${DELIVERY_REQUESTABLE_CONCLUSION}"`), "① 健康态完整机器读数保留：结论仍可读（data-delivery-conclusion）");
    ok(html.includes("data-delivery-counts=") && html.includes("data-delivery-user-pending="), "① 健康态完整机器读数保留：counts 与 user_pending 逐项可读（不删数据）");
    ok(!html.includes("<details"), "① 健康态不渲染折叠件（不是把长条折起来——整条不出现）");
  }

  section("② 只有待审线索：恰好**一条合并问题栏**（1 行）");
  {
    const html = renderInfoArea({
      delivery: healthyReadout(),
      leads: PENDING_LEADS,
      nodeLeads: PENDING_NODE_LEADS,
      anchor: "project-construction",
    });
    info(`只待审线索时摘要条数 ${rowsOf(html)}（期望 1）`);
    ok(rowsOf(html) === 1, "② 仅待审线索 ⇒ 图面恰好 1 行（不是「读数盘 + 线索盘」两排）");
    ok(html.includes("data-graph-info-summary"), "② 这一行是合并问题栏（data-graph-info-summary）");
    ok((html.match(/data-graph-info-summary/g) ?? []).length === 1, "② 合并问题栏**唯一一条**（不重复上屏）");
    ok(/待审线索\s*4\s*条/.test(html), "② 白话摘要给出待审线索数量（关系 3 + 节点 1 = 4 条）");
    ok(html.includes("尚未验收"), "② 合并栏仍带「尚未验收」限定（防「可请求验收」被读成已验收）");
    ok(html.includes("查看详情") || html.includes("查看原因"), "② 合并栏提供查看入口");
  }

  section("③ 阻断＋线索仍**一条**栏；能力分类未定同样触发");
  {
    const html = renderInfoArea({
      delivery: blockedReadout(),
      leads: PENDING_LEADS,
      nodeLeads: PENDING_NODE_LEADS,
      anchor: "project-architecture",
    });
    info(`阻断＋线索摘要条数 ${rowsOf(html)}（期望 1）`);
    ok(rowsOf(html) === 1, "③ 阻断＋待审线索同时存在 ⇒ 仍只有 1 行（合并问题栏，不是两排）");
    ok(html.includes("data-delivery-brief-blocked"), "③ 合并栏给出阻断条数");
    ok((html.match(/data-graph-info-summary/g) ?? []).length === 1, "③ 合并栏唯一一条");
    ok(!html.includes(DELIVERY_REQUESTABLE_CONCLUSION), "③ 阻断态不出现「可请求验收」（不给误导结论）");

    const unclassified = renderInfoArea({ delivery: unclassifiedReadout(), anchor: "project-functional" });
    ok(rowsOf(unclassified) === 1 && unclassified.includes("分类未定 2 个"), "③ 能力分类未定（无阻断、无线索）也触发一条合并栏并给数量");
  }

  section("④ 详情完整 + 浮层不吃画布");
  {
    const html = renderInfoArea({
      delivery: blockedReadout(),
      leads: PENDING_LEADS,
      nodeLeads: PENDING_NODE_LEADS,
      anchor: "tech-MODULE_BOX",
    });
    // 完整交付读数：计数 / 五档图例 / 逐条阻断 / 逐条待验 / 口径句
    ok(html.includes("data-delivery-counts-full"), "④ 浮层里有完整计数（data-delivery-counts-full）");
    ok(
      html.includes("data-delivery-state-legend") && EVIDENCE_STATE_ORDER.every((s) => html.includes(`data-delivery-state-chip="${s}"`)),
      "④ 浮层里五档图例逐档在场（+ 未映射共 6 枚 chip）",
    );
    ok(
      blockedReadout().reasons.every((_, i) => html.includes(`data-delivery-reason="${i}"`)),
      "④ 浮层里逐条阻断原因一条不少（data-delivery-reason）",
    );
    ok(
      blockedReadout().user_pending.every((_, i) => html.includes(`data-delivery-pending="${i}"`)) &&
        html.includes(USER_PENDING_LABEL),
      "④ 浮层里逐条人工待验一条不少（并标「用户待验」，不代签）",
    );
    ok(html.includes("data-delivery-note"), "④ 口径句仍在浮层里（data-delivery-note）");
    // 逐条待审线索也要进**同一份详情**
    ok(
      PENDING_LEADS.every((l) => html.includes(`data-model-lead="${attrValue(`${l.source}>${l.target}:${l.kind}`)}"`)) &&
        PENDING_NODE_LEADS.every((l) => html.includes(`data-model-node-lead="${l.id}"`)),
      "④ 逐条待审线索（关系＋节点）在同一份详情里逐条可查",
    );
    // 浮层形态（源码级判据）
    const src = read("src/ui/arch/ProvenancePanel.tsx");
    ok(/data-graph-info-detail-body/.test(src) && /absolute[^"]*top-full/.test(src), "④ 详情体绝对定位（浮层：不参与纵向排版 ⇒ 展开不吃画布）");
    ok(/max-h-\[60vh\]/.test(src) && /overflow-y-auto/.test(src), "④ 详情体自带高度上限 + 独立滚动");
    ok(/detailsRef/.test(src) && /\.open = false/.test(src) && /data-graph-info-detail-close/.test(src), "④ 详情可关闭（关闭钮真的收起 <details>）");
  }

  section("⑤ 六图共用同一份渲染件/判据");
  {
    const users = ["src/ui/arch/ProjectGraphView.tsx", "src/ui/arch/ArchCanvas.tsx", "src/ui/arch/MindMapView.tsx"];
    const sources = users.map((rel) => read(rel));
    ok(
      sources.every((s) => s.includes('from "./ProvenancePanel"') && /<GraphAttentionBar/.test(s)),
      "⑤ 三个画布组件（主三图 / 技术方框图+数据流向图 / 思维导图）都渲染同一份共享信息栏 GraphAttentionBar",
    );
    ok(
      sources.every((s) => !s.includes("ModelLeadsPanel") && !s.includes("DeliveryReadoutPanel")),
      "⑤ 六个调用点不再各写一套（没有第二块独立的读数盘/线索盘）",
    );
    const arch = read("src/ui/arch/ArchCanvas.tsx");
    ok(arch.includes("MODULE_BOX") && arch.includes("DATA_FLOW"), "⑤ 技术详情两张图（模块方框图 / 数据流向图）走同一个 ArchCanvas 调用点");
    ok(read("src/ui/arch/MindMapView.tsx").includes("data-mindmap-view"), "⑤ 思维导图是第六张图（data-mindmap-view）");
    const panel = read("src/ui/arch/ProvenancePanel.tsx");
    ok(/export function GraphAttentionBar/.test(panel), "⑤ 共享渲染件 GraphAttentionBar 由 ProvenancePanel 导出");
    ok(/export function attentionCountsOf/.test(panel), "⑤ 判据 attentionCountsOf 只此一份（不各写一套）");
  }

  section("⑥ 判据只此一份（attentionCountsOf）＋脚本登记");
  {
    const healthy = attentionCountsOf(healthyReadout(), [], []);
    ok(
      healthy.any === false && healthy.blocking.total === 0 && healthy.unclassified === 0 && healthy.pending_leads.total === 0,
      "⑥ 健康态判据：无阻断／无分类未定／无线索 ⇒ any=false（三档全 0）",
    );
    const leadOnly = attentionCountsOf(healthyReadout(), PENDING_LEADS, PENDING_NODE_LEADS);
    ok(leadOnly.any === true && leadOnly.pending_leads.total === 4 && leadOnly.blocking.total === 0, "⑥ 仅线索：any=true，线索 3+1=4（阻断仍 0）");
    const blocked = attentionCountsOf(blockedReadout(), [], []);
    ok(blocked.any === true && blocked.blocking.total === 6, "⑥ 阻断：any=true，四档合计 2+1+2+1=6");
    const unclassified = attentionCountsOf(unclassifiedReadout(), [], []);
    ok(unclassified.any === true && unclassified.unclassified === 2, "⑥ 分类未定：any=true，未定 2");
    const confirmedOnly = attentionCountsOf(healthyReadout(), [{ ...relLead(9), disposition: "confirmed_by_derivation" }], []);
    ok(confirmedOnly.any === false && confirmedOnly.pending_leads.total === 0, "⑥ 只留「与确定性派生独立命中」的冗余线索不触发出栏（它不是待审异常）");

    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    ok(
      pkg.scripts["verify:v09-20-info-bar"] === "tsx scripts/verify-v09-20-info-bar.ts",
      "⑥ package.json 已登记 verify:v09-20-info-bar",
    );
  }

  console.log(`\n[verify] V09-20 信息区 ${pass} PASS / ${fails.length} FAIL`);
  if (fails.length > 0) {
    for (const f of fails) console.log(`[verify]   FAIL ${f}`);
    process.exitCode = 1;
  }
}

main();
