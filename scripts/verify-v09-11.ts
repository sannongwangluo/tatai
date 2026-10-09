// V09-11 验证脚本（tsx 跑）：数据流向图的口径落地与来源可追溯。
// 用法：pnpm verify:v09-11（自带临时 TATAI_HOME 与夹具；真实文档只读并做首尾 sha256 零改动自证）
//
// 覆盖（逐条对着 PLAN V09-11 卡面）：
//   ① 口径在场：「当前实现＝静态依赖层方向渲染」与目标语义（输入源→处理→存储→输出/外部系统）
//      在**工具返回**、**页面**、**README/文档**里同时可见且互相区分；反例：只写一种 ⇒ 断言失败。
//   ② 实体与关系口径：真实模型覆盖四类实体、关系是产生/传递/读写/转换，每条带稳定 ID、方向、
//      逐条出处（设计声明／代码静态分析／可复跑实测）与验证态；**出处逐条独立复算**
//      （另写一份读取器核对 path:line 真含该片段，不信派生层的自报）。反例：只有静态线索的关系
//      标「已验证」、生成无出处的数据边、provenance 与 verification 自相矛盾 ⇒ 逐条判违规。
//   ③ 真实项目端到端数据链：真实塔台项目上一条四类实体齐全的链，逐跳带出处与验证态且逐跳复算；
//      反例：链上缺一环（缺实体类别／某跳未到已验证／某条关系未到已验证）而仍标「已验证」⇒ 判违规。
//   ④ 覆盖对账与交付阻断：从 DESIGN.md 的声明区**机械抽取**被声明的数据输入/存储/输出，
//      逐条断言覆盖表里有对应行（**不抽样**）；缺路径必须显式报缺并阻断交付结论
//      （2026-09-25 定向更新：真实项目 `.工作台/intent.json` 补上真实读点后已无缺路径，
//       本段的真实读数断言改为**双向**——有缺路径则必阻断且逐条点名、无缺路径则不得留下缺路径类阻断话术；
//       「缺路径必阻断」这条判据本身未经改动，由 ⑤ 的合成反例继续证明它仍会拦住违规）。
//      反例：缺路径不写原因／清单与实缺对不上／报了缺却仍放行「项目可交付」⇒ 逐条判违规。
//   ⑤ 验证标准成文：R1–R6 逐条在场，且每条都有一个反例真的被同一判据拦住（不是只写文字）。
//   ⑥ 不冒充：全仓 grep 与「数据流向」相关的文案，禁止句式 0 命中；同一套判据对合成的违规文案必须命中。
//   ⑦ 隔离夹具实测：真经唯一写入服务提交一条命令 → 事件台账落盘 → 投影读回（本卡内的实测证据）。
//
// 隔离口径：真实 `.工作台/work/` 与真实 DESIGN.md／PLAN.md **只读**；一切写操作在 os.tmpdir() 夹具里；
// 收尾清理。不调任何 MCP 写工具、不动真实事件账本、不为纳管项目加运行时埋点。
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { analyzeDataFlow, analyzeDataFlowAt, DATA_FLOW_INDEXES } from "../src/arch/dataflow";
import { getArchTool } from "../src/mcp/tools/getArch";
import { addProject } from "../src/server/registry";
import { WorkService } from "../src/server/work/service";
import { loadEvents } from "../src/server/work/eventStore";
import { readRequirements, registerRequirement } from "../src/server/work/requirements";
import { projectWorkDir } from "../src/server/workstation";
import { DATA_FLOW_VIEW, DataFlowTargetPanel } from "../src/ui/arch/DataFlowView";
import type { CanvasInfo } from "../src/ui/arch/ArchCanvas";
import {
  DATA_FLOW_CURRENT_IMPLEMENTATION_NOTE,
  DATA_FLOW_ENTITY_KINDS,
  DATA_FLOW_EVIDENCE_POLICY,
  DATA_FLOW_RELATION_KINDS,
  DATA_FLOW_TARGET_SEMANTICS_NOTE,
  DATA_FLOW_VERIFICATION_STATES,
  validateDataFlowModel,
  type DataFlowModel,
} from "../src/ui/arch/projectGraph";
import { REPO_ROOT, ensureSelfRegistered, realHome } from "./lib/fixtures";

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
const read = (rel: string): string => fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
const exists = (rel: string): boolean => fs.existsSync(path.join(REPO_ROOT, rel));

const REPO = REPO_ROOT;
const REAL_HOME = realHome();
ensureSelfRegistered(REAL_HOME);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-v0911-"));
const FX_HOME = path.join(TMP, "home");
fs.mkdirSync(FX_HOME, { recursive: true });

/** 与派生层内部同口径的章节区间（验证脚本自己实现一份：不拿被测实现的内部函数当尺子） */
function sectionRangeOf(lines: readonly string[], anchor: string): { from: number; to: number } | null {
  const idx = lines.findIndex((l) => l.includes(anchor));
  if (idx < 0) return null;
  const head = /^(#{1,4})\s/.exec(lines[idx]);
  const level = head === null ? 6 : head[1].length;
  for (let i = idx + 1; i < lines.length; i++) {
    const h = /^(#{1,4})\s/.exec(lines[i]);
    if (h !== null && h[1].length <= level) return { from: idx + 1, to: i };
  }
  return { from: idx + 1, to: lines.length };
}

/** 出处复算（独立于被测派生层）：文件在、行号在范围内、该行真含 find ⇒ 这条出处算数 */
function recheckEvidence(ref: { path: string; locator: string; find: string }): string | null {
  const abs = path.join(REPO, ref.path);
  if (!fs.existsSync(abs)) return `文件不存在：${ref.path}`;
  const m = /:(\d+)$/.exec(ref.locator);
  if (m === null) return `locator 不是 path:line 形态：${ref.locator}`;
  const lines = fs.readFileSync(abs, "utf8").split(/\r?\n/);
  const n = Number(m[1]);
  if (n < 1 || n > lines.length) return `行号越界：${ref.locator}（该文件 ${lines.length} 行）`;
  if (!lines[n - 1].includes(ref.find)) return `第 ${n} 行不含定位片段「${ref.find}」`;
  return null;
}

async function main(): Promise<void> {
  // ── 真实文档零改动自证（本卡只读设计/施工原文） ──
  const docBefore = new Map<string, string>();
  for (const rel of ["DESIGN.md", "PLAN.md", "README.md", "docs/agent-integration.md"]) {
    docBefore.set(rel, exists(rel) ? sha256Text(read(rel)) : "<missing>");
  }

  try {
    // ═════════════ ① 口径在场（工具返回 + 页面 + 文档） ═════════════
    section("① 口径在场：当前实现 vs 目标语义（同时可见且互相区分）");
    ok(
      DATA_FLOW_CURRENT_IMPLEMENTATION_NOTE.includes("当前实现") &&
        DATA_FLOW_CURRENT_IMPLEMENTATION_NOTE.includes("静态 import") &&
        DATA_FLOW_CURRENT_IMPLEMENTATION_NOTE.includes("业务数据流"),
      `①「当前实现」口径句在场且点名静态依赖层与「不是业务数据流」（${DATA_FLOW_CURRENT_IMPLEMENTATION_NOTE.slice(0, 30)}…）`,
    );
    ok(
      ["输入源", "处理节点", "存储", "输出/外部系统", "产生", "传递", "读写", "转换"].every((k) =>
        DATA_FLOW_TARGET_SEMANTICS_NOTE.includes(k),
      ) && DATA_FLOW_TARGET_SEMANTICS_NOTE.includes("稳定 ID"),
      "①「目标语义」口径句在场的四类实体、四类关系与「稳定 ID／方向／出处／验证态」逐项点名",
    );
    ok(
      DATA_FLOW_CURRENT_IMPLEMENTATION_NOTE !== DATA_FLOW_TARGET_SEMANTICS_NOTE &&
        !DATA_FLOW_CURRENT_IMPLEMENTATION_NOTE.includes("输入源"),
      "① 两句**互相区分**（不是同一句话换个说法：当前实现那句里没有目标语义的实体词）",
    );

    // ── 隔离夹具实测（③ 的存储跳在本卡内真跑一次） ──
    section("⑦ 隔离夹具实测：唯一写入服务 → 事件台账 → 投影读回");
    const FX = "v0911-fixture";
    const fxRoot = path.join(TMP, "proj");
    fs.mkdirSync(path.join(fxRoot, ".工作台"), { recursive: true });
    fs.writeFileSync(
      path.join(FX_HOME, "registry.json"),
      JSON.stringify({
        version: 1,
        projects: [
          {
            id: FX,
            name: "V09-11 数据链夹具",
            path: fxRoot,
            kind: "backend",
            registered_at: "2026-09-24T00:00:00+08:00",
            last_opened_at: "2026-09-24T00:00:00+08:00",
          },
        ],
      }),
      "utf8",
    );
    const prevHome = process.env.TATAI_HOME;
    process.env.TATAI_HOME = FX_HOME;
    const service = new WorkService({ dataDir: FX_HOME });
    const workDir = projectWorkDir(FX, FX_HOME);
    const receipt = registerRequirement({ submit: (c: unknown) => service.submit(c) }, {
      project_id: FX,
      requirement_id: "req-v0911-链实测",
      change_id: "change-none",
      actor_id: "v0911-verify",
      role: "coordinator",
      source: { kind: "user", ref: "PLAN V09-11 检查项③" },
      problem: "端到端数据链需要一条真跑过的存储跳",
      users: [],
      success_scenarios: [],
      exclusions: [],
      priority: "P2",
      status: "explicit",
    });
    const written = loadEvents(workDir);
    ok(
      receipt.ok && receipt.seq === 1 && written.events.length === 1 && written.events[0].seq === 1,
      `⑦ 真经唯一写入服务提交一条命令（回执 seq=${receipt.seq}，台账里 ${written.events.length} 条事件）`,
    );
    ok(
      fs.existsSync(path.join(workDir, "events.jsonl")) &&
        fs.readFileSync(path.join(workDir, "events.jsonl"), "utf8").trim().split("\n").length === 1,
      "⑦ `.工作台/work/events.jsonl` 真落盘一行（写点走过的直接证据）",
    );
    const fxProj = readRequirements(workDir);
    ok(
      fxProj.requirements["req-v0911-链实测"] !== undefined,
      "⑦ 投影读回一致：事件重放出的需求对象与提交内容对得上（读点走过的直接证据）",
    );

    // ═════════════ 真实项目模型 ═════════════
    section("②③④ 真实项目（tatai）的数据流向模型");
    const model = analyzeDataFlow("tatai", { dataDir: REAL_HOME });
    info(
      `实体 ${model.nodes.length} · 关系 ${model.edges.length} · 链 ${model.chains.length} · ` +
        `覆盖行 ${model.coverage.declared_total} · 缺路径 ${model.coverage.missing} · 复算剔除 ${model.scan.claims_dropped}`,
    );
    ok(model.coverage.declared_total > 0, "真实项目（tatai）已登记声明的数据输入/存储/输出，模型非空");
    ok(
      model.current_implementation.is_business_data_flow === false &&
        model.current_implementation.modes.length === 3 &&
        model.current_implementation.note === DATA_FLOW_CURRENT_IMPLEMENTATION_NOTE,
      "① 工具/接口侧的返回体里「当前实现＝三张技术图共用静态依赖层方向渲染、不是业务数据流」显式在场",
    );
    ok(
      JSON.stringify(model.target_semantics.entity_kinds) === JSON.stringify(DATA_FLOW_ENTITY_KINDS) &&
        JSON.stringify(model.target_semantics.relation_kinds) === JSON.stringify(DATA_FLOW_RELATION_KINDS) &&
        model.target_semantics.note === DATA_FLOW_TARGET_SEMANTICS_NOTE,
      "① 返回体里目标语义（四类实体／四类关系／口径句）与当前实现**同时在场**",
    );

    // ── ② 实体与关系口径 ──
    const kindsSeen = new Set(model.nodes.map((n) => n.kind));
    ok(
      DATA_FLOW_ENTITY_KINDS.every((k) => kindsSeen.has(k)),
      `② 实体覆盖四类：${DATA_FLOW_ENTITY_KINDS.map((k) => `${k}(${model.nodes.filter((n) => n.kind === k).length})`).join(" / ")}`,
    );
    ok(
      model.edges.every((e) => DATA_FLOW_RELATION_KINDS.includes(e.relation)),
      `② 关系全部落在「产生/传递/读写/转换」四类里（${[...new Set(model.edges.map((e) => e.relation))].join("、")}）`,
    );
    ok(
      model.edges.every((e) => e.id.trim() !== "") &&
        new Set(model.edges.map((e) => e.id)).size === model.edges.length &&
        model.edges.every((e) => e.direction === "forward"),
      `② 每条关系带**稳定 ID**（${model.edges.length} 条不重号）与**方向**字段`,
    );
    ok(
      model.edges.every((e) => e.evidence.length > 0) && model.nodes.every((n) => n.evidence.length > 0),
      "② 每条关系与每个实体都有**逐条出处**（没有无出处的边）",
    );
    const tierSeen = new Set(model.edges.flatMap((e) => e.evidence.map((r) => r.tier)));
    ok(tierSeen.size > 0 && [...tierSeen].every((t) => ["design_declared", "code_static", "code_measured"].includes(t)),
      `② 出处档位都归得进三档（实测出现：${[...tierSeen].join("、")}）`,
    );
    ok(
      model.edges.every((e) => DATA_FLOW_VERIFICATION_STATES.includes(e.verification)),
      "② 验证态都在「已验证／未核实／缺证」里",
    );
    // 出处逐条独立复算（不看派生层的自报）
    const allRefs = [
      ...model.nodes.flatMap((n) => n.evidence),
      ...model.edges.flatMap((e) => e.evidence),
      ...model.coverage.rows.flatMap((r) => r.evidence),
    ];
    const badRefs = allRefs.map(recheckEvidence).filter((x): x is string => x !== null);
    ok(
      badRefs.length === 0,
      `② 出处逐条独立复算通过（${allRefs.length} 条 path:line 全部真含定位片段${badRefs.length === 0 ? "" : `；不合格 ${badRefs.length} 条：${badRefs.slice(0, 3).join(" / ")}`}）`,
    );
    // 静态 import 只作线索：线索字段在场，且一条都没混进出处档位
    const clueEdges = model.edges.filter((e) => e.static_clues.length > 0);
    ok(
      clueEdges.length > 0 &&
        clueEdges.every((e) => !e.static_clues.some((c) => e.evidence.some((r) => r.locator.includes(c.split(" · ")[0])))),
      `② 静态 import／字符串线索只进 static_clues（${clueEdges.length} 条关系有线索），没有被当成出处档位`,
    );
    // V09-61（2026-10-08 判据收紧；finding f-4c71d59ab5552d36）：**脚本存在不再等于实测**。
    // 这两条关系的实测档原口径是「脚本在 + 登记在 package.json + 正文含定位片段」就判已验证——
    // 那是假绿（脚本实际 exit 1 也绿）。收紧后判 `code_measured` 还必须有一条**当前可成立的运行记录**
    // （内容地址复核通过 + 退出码 0 + 源清单载体现读 valid + 范围覆盖；见 src/arch/dataflowEvidence.ts）。
    // 真实塔台当前**没有**这类运行记录，故如实退回未核实；脚本仍作为可复跑线索（code_static 出处）在场。
    // 定向更新的是**读数**（原断言依赖旧口径的偶然绿），判据本身由 ⑤ 的反例（自造已验证的链）继续证明仍会拦住违规。
    for (const id of ["df-edge-service-events", "df-edge-events-projection"]) {
      const e = model.edges.find((x) => x.id === id);
      ok(
        e !== undefined &&
          e.verification !== "verified" &&
          e.evidence.some((r) => r.tier === "code_static") &&
          !e.evidence.some((r) => r.tier === "code_measured"),
        `② ${id} 无有效运行证据 ⇒ 不标「已验证」、仍保留可复跑线索（${e?.verification}；` +
          `线索 ${e?.evidence.find((r) => r.tier === "code_static")?.locator ?? "无"}）`,
      );
    }
    ok(
      model.scan.notes.some((n) => n.includes("实测未采信")) &&
        model.edges.some((e) => e.id === "df-edge-service-events" && e.verification === "unverified"),
      "② 实测未采信的原因逐条可见（scan.notes 点名「实测未采信」，不是静默降级）",
    );
    ok(
      model.edges
        .filter((e) => e.verification === "verified")
        .every((e) => e.evidence.some((r) => r.tier === "code_measured")),
      "② 所有标「已验证」的关系都拿得出可复跑实测出处（没有靠静态线索染绿的边）",
    );

    // ── ③ 端到端数据链 ──
    ok(model.chains.length >= 1, `③ 至少一条端到端数据链（${model.chains.length} 条）`);
    const chain = model.chains[0];
    const kindsInChain = new Set(chain.hops.map((h) => model.nodes.find((n) => n.id === h.node_id)?.kind));
    ok(
      chain.missing_kinds.length === 0 && DATA_FLOW_ENTITY_KINDS.every((k) => kindsInChain.has(k)),
      `③ 链上四类实体齐全（${DATA_FLOW_ENTITY_KINDS.map((k) => `${k}${kindsInChain.has(k) ? "✓" : "✗"}`).join(" ")}）`,
    );
    ok(
      chain.hops.every((h) => h.node_id !== "" && h.role !== "" && h.evidence.length > 0),
      `③ 逐跳带节点稳定 ID、角色与出处（${chain.hops.length} 跳逐跳有出处）`,
    );
    const hopRefs = chain.hops.flatMap((h) => h.evidence);
    const badHop = hopRefs.map(recheckEvidence).filter((x): x is string => x !== null);
    ok(
      badHop.length === 0,
      `③ 链上逐跳出处独立复算通过（${hopRefs.length} 条${badHop.length === 0 ? "" : `；不合格：${badHop.slice(0, 3).join(" / ")}`}）`,
    );
    ok(
      chain.hops.map((h) => h.index).join(",") === chain.hops.map((_, i) => i + 1).join(",") &&
        chain.hops.slice(1).every((h) => h.edge_id !== null),
      "③ 链的跳序完整（1..N）且除首跳外每跳都挂着带它进来的那条关系（缺环看得见）",
    );
    info(`③ 链：${chain.label}`);
    for (const h of chain.hops) info(`     ${h.index}. ${h.node_id}（${h.verification}，出处 ${h.evidence.length} 条）`);

    // ── ④ 覆盖对账（机械全量，不抽样） ──
    const designLines = read("DESIGN.md").split(/\r?\n/);
    const declaredNames = new Set<string>();
    for (const anchor of [
      "### 2.2 每个项目内的",
      "#### 2.3.1 全局注册表",
      "### 2.6 权威数据与派生内容",
      "### 8.4 SQLite 缓存范围",
    ]) {
      const r = sectionRangeOf(designLines, anchor);
      ok(r !== null, `④ DESIGN.md 里能找到声明区「${anchor}」`);
      if (r === null) continue;
      for (let i = r.from - 1; i < r.to && i < designLines.length; i++) {
        const line = designLines[i];
        if (anchor === "### 2.2 每个项目内的" && !line.startsWith("│")) continue;
        for (const m of line.matchAll(/[A-Za-z0-9_<>.-]+\.(?:json|jsonl|md)/g)) declaredNames.add(m[0]);
      }
    }
    // 无扩展名的目录型声明（§2.2 的 chat/ 与 logs/）：点名断言，别让机械抽取漏掉它们
    for (const extra of ["chat/", "logs/", "evidence/"]) declaredNames.add(extra);
    // 设计/施工原文本身不是"项目的**数据**输入/存储/输出"（它只作声明源，另由实体表覆盖）——按名字排掉，
    // 免得把 DESIGN.md/PLAN.md 这类文档混进数据对账表充数
    for (const doc of ["PLAN.md", "DESIGN.md", "AGENTS.md", "README.md"]) declaredNames.delete(doc);
    const missingInTable = [...declaredNames].filter(
      (n) => !model.coverage.rows.some((row) => row.artifact.includes(n)),
    );
    ok(
      declaredNames.size >= 15 && missingInTable.length === 0,
      `④ 设计声明区里抽出的 ${declaredNames.size} 个数据输入/存储/输出**逐条**都有覆盖行（缺 ${missingInTable.length} 个${missingInTable.length === 0 ? "" : `：${missingInTable.join("、")}`}）`,
    );
    ok(
      model.coverage.rows.length === model.coverage.declared_total && model.coverage.declared_total >= 20,
      `④ 覆盖表行数 ${model.coverage.declared_total}（>5，不是"抽几条边代表全量"）且与声明条数一致`,
    );
    ok(
      new Set(model.coverage.rows.map((r) => r.artifact)).size === model.coverage.rows.length,
      "④ 覆盖表每行一个声明对象，没有重复充数",
    );
    const gapRows = model.coverage.rows.filter((r) => !r.path_found);
    ok(
      gapRows.every((r) => (r.gap ?? "").trim() !== ""),
      `④ 没有路径的行**全部**写了缺路径原因（${gapRows.length} 行）`,
    );
    const currentGaps = gapRows.filter((r) => r.declaration_status === "current").map((r) => r.artifact);
    ok(
      JSON.stringify([...currentGaps].sort()) === JSON.stringify([...model.coverage.missing_paths].sort()),
      `④ 缺路径清单与覆盖表实缺逐条一致（${model.coverage.missing_paths.join("、") || "空"}）`,
    );
    // 定向更新（2026-09-25：`.工作台/intent.json` 补上真实读点，数据流覆盖对账的实测读数由
    // 「缺路径 1（intent.json）阻断可交付」变为「缺路径 0」）；判据未放宽——R6 仍是
    // 「missing_paths 非空 ⇒ deliverable_blocked=true，且缺路径逐条点名」，此处断言改成**双向**：
    //   旧期望：`missing_paths.length > 0 && deliverable_blocked && blockers 点到缺的每条`（依赖真实项目存在缺路径）；
    //   依据：补出 intent.ts 读点与 requirements.ts 登记校验后，真实项目已无缺路径（读数见本段 info 行）；
    //   新期望：有缺路径 → 必阻断且逐条点名（原样保留）；无缺路径 → 不得留下缺路径类阻断话术（换向的等价约束）；
    //   保留意图：R6 的判据本身不动（`src/ui/arch/projectGraph.ts` 的 validateDataFlowModel 未被改），
    //   且「报了缺却放行交付」仍由 ⑤ 的合成反例当场拦住（不用真实数据的偶然缺件证明判据有效）。
    const gapBlockers = model.blockers.filter((b) => b.includes("缺路径："));
    ok(
      currentGaps.length > 0
        ? model.deliverable_blocked && currentGaps.every((a) => model.blockers.some((b) => b.includes(a)))
        : gapBlockers.length === 0,
      currentGaps.length > 0
        ? `④ 缺路径**阻断「项目可交付」**并逐条点名：${model.blockers.slice(0, 2).join("；")}`
        : `④ 真实项目当前无缺路径（覆盖 ${model.coverage.covered}/${model.coverage.declared_total}，缺路径 0）：` +
          "交付阻断读数里没有留下缺路径类话术（「缺路径必阻断」由 ⑤ 的合成反例逐条证明仍会拦住违规）",
    );
    info(`④ 覆盖对账（逐行）：有路径 ${model.coverage.covered} · 缺路径 ${model.coverage.missing} · 设计明写未实现 ${model.coverage.not_implemented}`);
    for (const r of model.coverage.rows) {
      info(`     ${r.path_found ? "有路径" : "缺路径"}｜${r.artifact}｜设计出处 ${r.design_locator}｜证据 ${r.evidence.length} 条`);
    }

    // ── ⑤ 验证标准成文 + 反例矩阵 ──
    section("⑤ 验证标准成文（R1–R6）与反例矩阵：每条判据都被反例逼过一次");
    ok(
      DATA_FLOW_EVIDENCE_POLICY.length === 6 &&
        ["R1", "R2", "R3", "R4", "R5", "R6"].every((r) => DATA_FLOW_EVIDENCE_POLICY.some((p) => p.rule === r)) &&
        DATA_FLOW_EVIDENCE_POLICY.every((p) => p.text.length >= 20),
      `⑤ 判据成文 R1–R6 逐条在场（${DATA_FLOW_EVIDENCE_POLICY.map((p) => p.rule).join("/")}）`,
    );
    ok(
      DATA_FLOW_EVIDENCE_POLICY.some((p) => p.text.includes("复算") && p.text.includes("剔除")) &&
        DATA_FLOW_EVIDENCE_POLICY.some((p) => p.text.includes("verified ⇔")) &&
        DATA_FLOW_EVIDENCE_POLICY.some((p) => p.text.includes("阻断")),
      "⑤ 判据里写明「哪些算已核实」「未核实如何标注」「无效来源如何剔除」「缺路径如何阻断」",
    );
    ok(validateDataFlowModel(model).length === 0, `⑤ 正例：真实模型跑同一套判据 0 违规（${JSON.stringify(validateDataFlowModel(model))}）`);

    const clone = (): DataFlowModel => JSON.parse(JSON.stringify(model)) as DataFlowModel;
    const codesOf = (m: DataFlowModel): string[] => validateDataFlowModel(m).map((i) => i.code);
    const caseOk = (label: string, m: DataFlowModel, expect: string[]): void => {
      const codes = codesOf(m);
      ok(
        expect.every((c) => codes.includes(c)),
        `⑤ 反例·${label} ⇒ 判违规 ${expect.join("+")}（实得 ${[...new Set(codes)].join("、") || "无"}）`,
      );
    };
    {
      const c1 = clone();
      c1.edges[0].evidence = [];
      c1.edges[0].verification = "verified";
      caseOk("无出处的数据边还标已验证", c1, ["edge_no_evidence", "edge_static_clue_marked_verified"]);
    }
    {
      const c2 = clone();
      c2.edges[0].evidence = c2.edges[0].evidence.filter((r) => r.tier === "design_declared" || r.tier === "code_static");
      c2.edges[0].static_clues = ["src/x.ts:1 · 静态 import 线索"];
      c2.edges[0].verification = "verified";
      c2.edges[0].provenance = "code_static";
      caseOk("把只有静态线索的关系标成「已验证」", c2, ["edge_static_clue_marked_verified"]);
    }
    {
      const c3 = clone();
      c3.edges[0].evidence = c3.edges[0].evidence.filter((r) => r.tier === "design_declared");
      c3.edges[0].provenance = "code_measured";
      caseOk("来源分层写「可复跑实测」却没有实测出处", c3, ["edge_measured_without_measured_ref"]);
    }
    {
      const c4 = clone();
      c4.edges[0].provenance = "unverified";
      c4.edges[0].verification = "verified";
      caseOk("来源「未核实」却标「已验证」", c4, ["unverified_marked_verified"]);
    }
    {
      const c5 = clone();
      c5.edges[0].to = "df-node-不存在";
      caseOk("悬空端点的数据边", c5, ["edge_dangling_endpoint"]);
    }
    {
      const c6 = clone();
      c6.edges[0].direction = "backward" as unknown as "forward";
      caseOk("方向字段被抹掉", c6, ["edge_missing_direction"]);
    }
    {
      const c7 = clone();
      c7.edges[0].relation = "reads_code" as unknown as DataFlowModel["edges"][number]["relation"];
      caseOk("关系类别不在四类里", c7, ["edge_unknown_relation"]);
    }
    {
      const c8 = clone();
      c8.nodes = c8.nodes.filter((n) => n.kind !== "store");
      caseOk("实体缺一类（没有存储）", c8, ["entity_kind_uncovered"]);
    }
    // V09-61 定向更新：旧反例靠"真实链当时是已验证"才触发判据——收紧后真实链如实退回未核实，
    // 反例必须**自造**「链标已验证」这一前提（更自足，不再依赖真实数据的偶然绿）。
    {
      const c9 = clone();
      c9.chains[0].hops = c9.chains[0].hops.filter((h) => h.node_id !== "df-node-work-events");
      c9.chains[0].hops = c9.chains[0].hops.map((h, i) => ({ ...h, index: i + 1 }));
      c9.chains[0].verification = "verified";
      caseOk("链上缺一环（少了存储跳）却仍标「已验证」", c9, ["chain_missing_kinds", "chain_verified_with_missing_hop"]);
    }
    {
      const c10 = clone();
      const hop = c10.chains[0].hops[2];
      c10.nodes = c10.nodes.map((n) => (n.id === hop.node_id ? { ...n, verification: "unverified" as const } : n));
      c10.chains[0].hops[2].verification = "unverified";
      c10.chains[0].verification = "verified";
      caseOk("链上有一跳没到已验证却整条标「已验证」", c10, ["chain_verified_with_missing_hop"]);
    }
    {
      const c11 = clone();
      const chainEdge = c11.chains[0].hops[3].edge_id!;
      c11.edges = c11.edges.map((e) => (e.id === chainEdge ? { ...e, verification: "unverified" as const } : e));
      c11.chains[0].verification = "verified";
      caseOk("链上有一条关系没到已验证却整条标「已验证」", c11, ["chain_verified_with_missing_hop"]);
    }
    {
      const c12 = clone();
      const row = c12.coverage.rows.find((r) => r.declaration_status === "current")!;
      row.path_found = false;
      row.evidence = [];
      row.gap = null;
      caseOk("缺路径却不写缺路径原因", c12, ["coverage_gap_not_declared"]);
    }
    {
      const c13 = clone();
      // 反例要自己造出"实缺"（2026-09-25：真实项目补上 intent.json 读点后已无缺路径，
      // 不能靠真实数据的偶然缺件当反例）：摘掉一行的证据但清单仍写空 ⇒ 两份读数对不上
      const g13 = c13.coverage.rows.find((r) => r.declaration_status === "current")!;
      g13.path_found = false;
      g13.evidence = [];
      g13.gap = "夹具：本条声明没有路径（合成反例）";
      c13.coverage.missing_paths = [];
      caseOk("缺路径清单与覆盖表实缺对不上", c13, ["coverage_missing_paths_mismatch"]);
    }
    {
      const c14 = clone();
      // 同上：自己造一条缺路径，再放行「项目可交付」⇒ 必须被 missing_paths_not_blocking 拦住
      const g14 = c14.coverage.rows.find((r) => r.declaration_status === "current")!;
      g14.path_found = false;
      g14.evidence = [];
      g14.gap = "夹具：本条声明没有路径（合成反例）";
      c14.coverage.missing_paths = [g14.artifact];
      c14.deliverable_blocked = false;
      caseOk("报了缺路径却仍放行「项目可交付」", c14, ["missing_paths_not_blocking"]);
    }

    // R3 的独立验证：设计原文里复算不到声明 ⇒ 登记作废、逐条报缺、交付阻断
    section("⑤ R3 无效来源剔除：在隔离根上跑同一份判据（声明复算不到 ⇒ 逐条报缺）");
    const emptyRoot = path.join(TMP, "empty-root");
    fs.mkdirSync(emptyRoot, { recursive: true });
    const noDecl = analyzeDataFlowAt(DATA_FLOW_INDEXES.tatai, { project_id: "fixture", root: emptyRoot, scripts: {} });
    ok(
      noDecl.coverage.rows.every((r) => !r.path_found) &&
        noDecl.deliverable_blocked &&
        noDecl.coverage.missing_paths.length === noDecl.coverage.rows.filter((r) => r.declaration_status === "current").length,
      `⑤ 反例：设计原文与代码都不在 ⇒ 逐条报缺并阻断交付（缺 ${noDecl.coverage.missing_paths.length} 条、块因 ${noDecl.blockers.length} 条）`,
    );
    ok(
      noDecl.scan.claims_dropped >= noDecl.coverage.declared_total &&
        noDecl.scan.notes.some((n) => n.includes("文件不存在")),
      `⑤ 剔除的出处逐条留因（${noDecl.scan.claims_dropped} 条，原因可见：${noDecl.scan.notes.find((n) => n.includes("文件不存在"))?.slice(0, 60) ?? "无"}…）`,
    );
    const partialRoot = path.join(TMP, "partial-root");
    fs.mkdirSync(partialRoot, { recursive: true });
    fs.writeFileSync(
      path.join(partialRoot, "DESIGN.md"),
      `# 夹具设计书\n\n### 2.2 每个项目内的 \`.工作台/\` 目录\n\n（没有声明任何数据文件）\n\n### 2.6 权威数据与派生内容（目标设计）\n\n（同样没有声明）\n\n### 8.4 SQLite 缓存范围\n`,
      "utf8",
    );
    const partial = analyzeDataFlowAt(DATA_FLOW_INDEXES.tatai, { project_id: "fixture2", root: partialRoot, scripts: {} });
    ok(
      partial.scan.notes.some((n) => n.includes("定位片段")),
      `⑤ 反例：章节在但声明片段不在 ⇒ 给出「定位片段不在章节区间」的剔除理由（${partial.scan.notes.find((n) => n.includes("定位片段"))?.slice(0, 50) ?? "无"}…）`,
    );

    // ═════════════ ① 工具返回（v1 不越界 / v2 带来源分层） ═════════════
    section("① 工具返回体：v2 带 data_flow（口径同时在场），v1 形状逐字不变");
    process.env.TATAI_HOME = REAL_HOME;
    const archOut = (await getArchTool.handler({ project_id: "tatai" })) as { content: { text: string }[] };
    const archJson = JSON.parse(archOut.content[0]?.text ?? "{}") as Record<string, unknown>;
    const df = archJson.data_flow as DataFlowModel | undefined;
    ok(
      df !== undefined &&
        df.current_implementation.note === DATA_FLOW_CURRENT_IMPLEMENTATION_NOTE &&
        df.target_semantics.note === DATA_FLOW_TARGET_SEMANTICS_NOTE,
      "① `get_arch`（v2）返回体里「当前实现」与「目标语义」两句同时在场（与页面/接口同一份口径常量）",
    );
    ok(
      df !== undefined && df.current_implementation.is_business_data_flow === false && df.nodes.length > 0 && df.edges.length > 0,
      "① `get_arch`（v2）返回体带实体/关系/链（实体 " +
        `${df?.nodes.length ?? 0} · 关系 ${df?.edges.length ?? 0} · 链 ${df?.chains.length ?? 0}）`,
    );
    ok(
      typeof archJson.module_status_source === "string" && archJson.data_flow !== undefined,
      "① v2 返回体仍是「技术详情层 + 状态来源 + 数据流向来源分层」，没有把静态依赖渲染说成数据流",
    );
    // v1（未迁移项目）：一个字段都不加——口径层不得侵入旧形状（PLAN V09-08 的越界红线照旧）
    process.env.TATAI_HOME = FX_HOME;
    const PLAIN = "v0911-plain";
    const plainRoot = path.join(TMP, "plain-proj");
    fs.mkdirSync(path.join(plainRoot, ".工作台", "arch"), { recursive: true });
    fs.mkdirSync(path.join(plainRoot, "src"), { recursive: true });
    fs.writeFileSync(path.join(plainRoot, "src", "index.ts"), "export const x = 1;\n", "utf8");
    fs.writeFileSync(
      path.join(plainRoot, ".工作台", "arch", "modules.json"),
      JSON.stringify({
        version: 1,
        generated_at: "2026-09-24T00:00:00+08:00",
        budget_exhausted: false,
        modules: [{ id: "m1", name: "夹具模块", path: "src", file_count: 1, loc: 10, deps: [] }],
      }),
      "utf8",
    );
    addProject({ id: PLAIN, name: PLAIN, path: plainRoot, kind: "backend" }, FX_HOME);
    const plainOut = (await getArchTool.handler({ project_id: PLAIN })) as { content: { text: string }[] };
    const plainText = plainOut.content[0]?.text ?? "";
    ok(
      !plainText.includes("data_flow") && !/"layer"/.test(plainText) && !/"module_status_source"/.test(plainText),
      "① 未迁移项目（v1）返回体里**一个 v2 时代字段都没有**：口径层不侵入旧形状（越界红线）",
    );

    // ═════════════ ⑥ 不冒充 ═════════════
    section("⑥ 不冒充：全仓「数据流向」相关文案禁止句式 0 命中");
    const FORBIDDEN: { label: string; re: RegExp }[] = [
      { label: "把数据流向图说成＝业务/真实数据流", re: /数据流向图\s*(?:就是|＝|=|表示|展示|反映|画出)\s*(?:(?:真实的|真正的|业务的|业务)\s*)*数据流/ },
      { label: "把静态依赖说成就是数据流", re: /静态\s*(?:import|依赖)[^。；\n]{0,16}(?:就是|即|＝)\s*(?:业务)?\s*数据流/ },
      { label: "把图上的依赖边读成业务数据流", re: /(?:业务|真实)数据流[^。；\n]{0,10}(?:由图|由数据流向图)(?:展示|给出|画出|呈现)/ },
    ];
    const violations: string[] = [];
    const scanTargets: string[] = [];
    const walk = (dir: string, ext: RegExp): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if ([".工作台", "node_modules", "dist", ".git", "__pycache__"].includes(e.name)) continue;
          walk(p, ext);
        } else if (ext.test(e.name)) scanTargets.push(p);
      }
    };
    walk(path.join(REPO, "src"), /\.(ts|tsx)$/);
    walk(path.join(REPO, "scripts"), /\.(ts|py)$/);
    walk(path.join(REPO, "docs"), /\.md$/);
    scanTargets.push(path.join(REPO, "README.md"));
    // 排除判据自身的文件：它必须写着那几条禁止句式（否则判据没法定），这是"尺子"不是"被量的文案"；
    // 被量的对象是产品文案与代码，尺子（本脚本）不算在内——这一条如实写在日志里。
    const judge = path.join(REPO, "scripts", "verify-v09-11.ts");
    const scanned = scanTargets.filter((f) => f !== judge);
    info(`⑥ 扫描 ${scanned.length} 个文件（已排除判据自身 ${path.relative(REPO, judge)}）`);
    let flowLines = 0;
    for (const f of scanned) {
      const text = fs.readFileSync(f, "utf8");
      text.split(/\r?\n/).forEach((line, i) => {
        if (!line.includes("数据流")) return;
        flowLines += 1;
        for (const p of FORBIDDEN) {
          if (p.re.test(line)) violations.push(`${path.relative(REPO, f)}:${i + 1} [${p.label}] ${line.trim().slice(0, 80)}`);
        }
      });
    }
    ok(
      violations.length === 0,
      `⑥ 扫 ${scanned.length} 个文件 / ${flowLines} 行提到「数据流」的文案，禁止句式 0 命中${violations.length === 0 ? "" : `：${violations.slice(0, 3).join(" | ")}`}`,
    );
    // 反例：同一套判据对合成的违规文案必须命中（判据不是摆设）
    const bait = [
      "数据流向图就是真实的业务数据流，能看出钱走到哪。",
      "这里的静态依赖就是数据流，直接照画即可。",
      "业务数据流由数据流向图展示，不用另找证据。",
    ];
    ok(
      bait.every((line) => FORBIDDEN.some((p) => p.re.test(line))),
      "⑥ 反例：三条合成的违规文案逐条被同一判据命中（判据有效，不是空跑）",
    );
    // 正向：口径必须写进这几个文件（不是只写在代码注释里）
    for (const rel of ["README.md", "docs/agent-integration.md", "src/ui/arch/DataFlowView.tsx", "src/mcp/tools/getArch.ts"]) {
      const text = exists(rel) ? read(rel) : "";
      ok(
        text.includes("静态 import 依赖层方向渲染") && text.includes("业务数据流") && text.includes("输入源"),
        `① ${rel} 同时写明「当前实现＝静态 import 依赖层方向渲染」与目标语义（含「不是业务数据流」与「输入源」）`,
      );
    }

    // ═════════════ ① 页面（真组件渲染） ═════════════
    section("① 数据流向图页面：两句话同时可见、互相区分；数据链逐跳可点开");
    const canvasInfo: CanvasInfo = {
      mode: "DATA_FLOW",
      label: "数据流向图",
      nodes: 1,
      edges: 1,
      stats: { all_edges: 1, view_edges: 1, dropped_self_loop: 0, merged_mutual_pairs: 0 } as unknown as CanvasInfo["stats"],
      roles: { source: 0, relay: 0, sink: 0, isolated: 0 },
      colors: { flow_source: 0, flow_relay: 0, uncolored: 0 },
      bidirectional: 0,
      strokeWidths: [1],
      maxWeight: 1,
    };
    const decl = DATA_FLOW_VIEW("tatai");
    const legendHtml = renderToStaticMarkup(React.createElement(React.Fragment, null, decl.header!(canvasInfo)));
    ok(
      legendHtml.includes("data-flow-current-implementation") && legendHtml.includes("data-flow-target-semantics"),
      "① 页面上「当前实现」与「目标语义」两个标记同时在场",
    );
    ok(
      legendHtml.includes("静态 import 依赖层方向渲染") &&
        !legendHtml.includes("本画布画的这些边就是数据流"),
      "① 页面上明说画布画的是静态依赖层方向渲染（且没有相反说法）",
    );
    ok(
      legendHtml.includes("data-flow-not-business-flow") && /不是[^。；\n]{0,8}业务数据流/.test(legendHtml),
      "① 页面上显式否定「画布＝业务数据流」（红线：不得显示为业务数据流）",
    );
    const panelHtml = renderToStaticMarkup(React.createElement(DataFlowTargetPanel, { model, error: null }));
    ok(
      panelHtml.includes(`data-flow-chain="${chain.id}"`) &&
        chain.hops.every((h) => panelHtml.includes(`data-flow-hop="${h.node_id}"`)),
      `① 页面上数据链 ${chain.hops.length} 跳**逐跳**有可点开的锚点（<details data-flow-hop>）`,
    );
    ok(
      DATA_FLOW_ENTITY_KINDS.every((k) => panelHtml.includes(`data-flow-entity-kind="${k}"`)),
      "① 页面上实体带四类 kind 标记（人看得见、机器也读得到）",
    );
    ok(
      model.edges.every((e) => panelHtml.includes(`data-flow-edge="${e.id}"`)) &&
        panelHtml.includes("data-flow-provenance=") &&
        panelHtml.includes("data-flow-verification="),
      `① 页面上每条关系带稳定 ID、来源分层与验证态（${model.edges.length} 条）`,
    );
    ok(
      panelHtml.includes(`data-flow-blocked="${model.deliverable_blocked ? "true" : "false"}"`) &&
        panelHtml.includes("data-flow-coverage-row="),
      "① 页面上覆盖对账与「是否阻断交付」的读数在场",
    );
    ok(
      panelHtml.includes("data-flow-target-layer") && panelHtml.includes("data-flow-target-semantics"),
      "① 目标语义层与画布**分开**呈现（另起区域，不冒充画布上的边）",
    );

    // 恢复环境
    if (prevHome === undefined) delete process.env.TATAI_HOME;
    else process.env.TATAI_HOME = prevHome;
  } finally {
    fs.rmSync(TMP, { recursive: true, force: true });
    for (const [rel, before] of docBefore) {
      const after = exists(rel) ? sha256Text(read(rel)) : "<missing>";
      ok(after === before, `自证：${rel} 未被本脚本改动`);
    }
  }

  console.log(`[verify] V09-11：PASS ${pass} / FAIL ${fails.length}`);
  if (fails.length > 0) {
    console.log("[verify] 存在 FAIL");
    process.exit(1);
  }
  console.log("[verify] 全部 PASS");
}

main().catch((e: unknown) => {
  console.error(`[verify] 脚本自身出错：${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  process.exit(1);
});
