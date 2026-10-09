// 六图补齐批次（数据流向图）· 专项验证（tsx 跑）：数据流向图的**实体/路径/出处覆盖**补齐的自检。
// 用法：pnpm exec tsx scripts/verify-fivegraph-dataflow.ts（未登记进 package.json——那属共享文件，
// 见本批次报告「后续 Codex 集成项」；本脚本本身可在隔离夹具里独立复跑）。
//
// 本批次（2026-10-08）在 `src/arch/dataflow.ts` 的内建声明 `TATAI_INDEX` 里，把数据流向图**目标层**
// 从「结果提交一条链」扩到**已实现的核心链路**：证据存证、施工定义导入、需求登记→唯一义务派生→功能清单、
// 基线激活、同步证据核验。本脚本回答三件事（都要真跑，不是只有字符串自证）：
//   ① **声明层完整性**：新增的实体/关系/链**逐条在场**，四类实体齐全，每条关系有稳定 ID、方向与逐条出处；
//      全模型每条 `path:line` **独立复算**（本脚本自己读文件核对，不信派生层自报），且**本次复算零剔除**
//      （定位片段过期就红——这条正是为了拦住"改了源码没改声明"）。
//   ② **不冒充**：真实项目一条端到端链仍在；标「已验证」的关系都必须拿得出可复跑实测出处；
//      链标「已验证」必须四类实体齐全且逐跳节点与关系都到已验证（缺环不得染绿）。
//   ③ **真跑新增路径**：在隔离夹具（os.tmpdir + 独立 TATAI_HOME）里**真的**走一遍新增链路的关键跳——
//      证据正文内容寻址落盘与读回复核；需求登记＋施工定义导入经真唯一写服务落账并读回；基线激活落
//      baselines.jsonl 与不可变修订对象；同步证据包投进收件目录后扫描核验落账。真实 `.工作台/` 只读。
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { analyzeDataFlow, analyzeDataFlowAt, type ProjectIndex } from "../src/arch/dataflow";
import type { DataFlowEntityKind } from "../src/ui/arch/projectGraph";
import { addProject } from "../src/server/registry";
import { WorkService } from "../src/server/work/service";
import { loadEvents } from "../src/server/work/eventStore";
import { putEvidence, readEvidence, evidenceBlobPath } from "../src/server/work/evidence";
import { registerRequirement, readRequirements } from "../src/server/work/requirements";
import { importPlanChecked } from "../src/server/work/references";
import { submitDefinitionImports, readTaskStates } from "../src/server/work/tasks";
import { activateBaseline, BASELINES_FILE } from "../src/server/work/documents";
import { buildRegisterContractCommand, scanSyncProject, readSyncStatus } from "../src/server/work/sync";
import { projectWorkDir } from "../src/server/workstation";
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
const sha256 = (t: string | Buffer): string => crypto.createHash("sha256").update(t).digest("hex");

const REPO = REPO_ROOT;
const REAL_HOME = realHome();
ensureSelfRegistered(REAL_HOME);

/** 本批次新增的实体／关系／链（逐条点名断言，缺一条就红） */
const NEW_NODES = [
  "df-node-plan-source",
  "df-node-evidence-record",
  "df-node-evidence-store",
  "df-node-definition-import",
  "df-node-requirement",
  "df-node-baseline",
  "df-node-revisions-store",
  "df-node-baselines-store",
  "df-node-sync-package",
  "df-node-sync-inbox",
  "df-node-sync-scan",
  "df-node-obligations",
  "df-node-feature-ledger",
] as const;
const NEW_EDGES = [
  "df-edge-tools-evidence-service",
  "df-edge-service-evidence-record",
  "df-edge-evidence-record-store",
  "df-edge-evidence-store-readout",
  "df-edge-plan-import",
  "df-edge-import-service",
  "df-edge-design-requirement",
  "df-edge-requirement-service",
  "df-edge-events-obligations",
  "df-edge-obligations-ledger",
  "df-edge-design-baseline",
  "df-edge-baseline-revisions",
  "df-edge-baseline-baselines",
  "df-edge-package-inbox",
  "df-edge-inbox-scan",
  "df-edge-scan-service",
] as const;
const NEW_CHAINS = [
  "df-chain-tatai-evidence-record",
  "df-chain-tatai-plan-import",
  "df-chain-tatai-requirement-ledger",
  "df-chain-tatai-sync-evidence",
] as const;

/** 出处复算（独立于被测派生层）：文件在、行号在范围内、该行真含 find ⇒ 这条出处算数 */
function recheck(ref: { path: string; locator: string; find: string }): string | null {
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

const mkdirp = (d: string): void => {
  fs.mkdirSync(d, { recursive: true });
};
const write = (f: string, t: string): void => {
  mkdirp(path.dirname(f));
  fs.writeFileSync(f, t, "utf8");
};

/** 施工图夹具：一张卡表 + 卡定义（与既有验证脚本同形，不引项目真实数据） */
function planText(title: string, cards: { id: string; goal: string }[]): string {
  const L = [`# ${title}`, "", "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |", "| --- | --- | --- | --- | --- |"];
  for (const c of cards) L.push(`| ${c.id} | todo | ${c.goal} |  | ${c.id} 的完成证据 |`);
  L.push("");
  for (const c of cards)
    L.push(`### ${c.id} ${c.goal}`, "", `**设计依据**：§1。**依赖**：无。**文件责任**：\`src/${c.id.toLowerCase()}.ts\`。**责任角色**：executor。`, "", `- [ ] ${c.goal} 达标`, "");
  return L.join("\n");
}

async function main(): Promise<void> {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-fivegraph-df-"));
  const FX_HOME = path.join(TMP, "home");
  mkdirp(FX_HOME);
  const prevHome = process.env.TATAI_HOME;

  try {
    // ═════════════ ① 声明层完整性（真实项目 tatai） ═════════════
    section("① 声明层完整性：新增实体/关系/链逐条在场 + 每条出处独立复算");
    const model = analyzeDataFlow("tatai", { dataDir: REAL_HOME });
    info(`实体 ${model.nodes.length} · 关系 ${model.edges.length} · 链 ${model.chains.length} · 覆盖行 ${model.coverage.declared_total} · 剔除 ${model.scan.claims_dropped}`);
    const idsOf = (x: readonly { id: string }[]): Set<string> => new Set(x.map((o) => o.id));
    const nodeIds = idsOf(model.nodes);
    const edgeIds = idsOf(model.edges);
    const chainIds = idsOf(model.chains);
    const missingNodes = NEW_NODES.filter((id) => !nodeIds.has(id));
    const missingEdges = NEW_EDGES.filter((id) => !edgeIds.has(id));
    const missingChains = NEW_CHAINS.filter((id) => !chainIds.has(id));
    ok(missingNodes.length === 0, `① 新增实体 ${NEW_NODES.length} 个逐条在场${missingNodes.length ? `（缺：${missingNodes.join("、")}）` : ""}`);
    ok(missingEdges.length === 0, `① 新增关系 ${NEW_EDGES.length} 条逐条在场${missingEdges.length ? `（缺：${missingEdges.join("、")}）` : ""}`);
    ok(missingChains.length === 0, `① 新增链 ${NEW_CHAINS.length} 条逐条在场${missingChains.length ? `（缺：${missingChains.join("、")}）` : ""}`);
    ok(
      ["input_source", "process", "store", "output_external"].every((k) => model.nodes.some((n) => n.kind === k)),
      "① 四类实体齐全（输入源/处理/存储/输出·外部系统）",
    );
    const newEdges = model.edges.filter((e) => (NEW_EDGES as readonly string[]).includes(e.id));
    ok(
      newEdges.every((e) => e.id.trim() !== "" && e.direction === "forward" && e.evidence.length > 0),
      `① 新增关系逐条带稳定 ID、方向与出处（${newEdges.length} 条无空出处）`,
    );
    ok(
      newEdges.every((e) => ["produce", "transfer", "read_write", "transform"].includes(e.relation)),
      "① 新增关系都落在「产生/传递/读写/转换」四类里",
    );

    // 全模型出处逐条独立复算 + 零剔除（拦住"改了源码没改声明"的过期定位）
    const allRefs = [
      ...model.nodes.flatMap((n) => n.evidence),
      ...model.edges.flatMap((e) => e.evidence),
      ...model.coverage.rows.flatMap((r) => r.evidence),
    ];
    const bad = allRefs.map(recheck).filter((x): x is string => x !== null);
    ok(bad.length === 0, `① 全模型出处逐条独立复算通过（${allRefs.length} 条${bad.length ? `；不合格 ${bad.length}：${bad.slice(0, 3).join(" / ")}` : ""}）`);
    ok(
      model.scan.claims_dropped === 0,
      `① 本次复算**零剔除**（剔除 ${model.scan.claims_dropped} 条：${model.scan.notes.filter((n) => n.startsWith("剔除出处")).slice(0, 3).join(" / ") || "无"}）`,
    );

    // 覆盖对账：新增的两条声明有覆盖行，且无缺路径
    for (const need of ["PLAN.md", "sync-inbox"]) {
      const row = model.coverage.rows.find((r) => r.artifact.includes(need));
      ok(row !== undefined && row.path_found && row.gap === null, `① 覆盖表新增行「${need}」有路径与证据（证据 ${row?.evidence.length ?? 0} 条）`);
    }
    ok(model.coverage.missing === 0 && !model.deliverable_blocked && model.blockers.length === 0, "① 无缺路径、交付结论未被缺路径阻断（缺路径判据仍由 verify:v09-11 的合成反例证明有效）");

    // ═════════════ ①-b 覆盖判据泛化：每个 current 声明逐项有节点 + 有有效关系 ═════════════
    section("①-b 覆盖判据泛化：current 声明逐项有实体、实体参与端点闭合的真实关系");
    const nodeIdsAll = new Set(model.nodes.map((n) => n.id));
    const currentRows = model.coverage.rows.filter((r) => r.declaration_status === "current");
    const nullNode = currentRows.filter((r) => r.node_id === null);
    const ghostNode = currentRows.filter((r) => r.node_id !== null && !nodeIdsAll.has(r.node_id));
    ok(
      nullNode.length === 0 && ghostNode.length === 0,
      `①-b 每个 current 声明都有明确 node_id 且指向实体表里的现有实体（缺 ${nullNode.length}、悬空 ${ghostNode.length}）`,
    );
    // 逐项：node 存在 + 以它为端点的关系端点闭合、有有效出处 + 本声明有出处 ⇒ path_found
    const leadsEdge = (nodeId: string): boolean =>
      model.edges.some(
        (e) =>
          (e.from === nodeId || e.to === nodeId) &&
          e.evidence.length > 0 &&
          nodeIdsAll.has(e.from) &&
          nodeIdsAll.has(e.to),
      );
    const badCurrent = currentRows.filter(
      (r) => r.node_id === null || !nodeIdsAll.has(r.node_id) || !leadsEdge(r.node_id) || r.evidence.length === 0,
    );
    ok(badCurrent.length === 0, `①-b current 声明逐项：实体存在 + 参与有效关系 + 本体有出处（不合格 ${badCurrent.length}）`);
    ok(
      currentRows.every((r) => r.path_found),
      `①-b 每个 current 声明都判 path_found（${currentRows.length} 行；旧口径"有出处即有路径"已被结构性判据替换）`,
    );
    const sqlite = model.coverage.rows.find((r) => r.declaration_status === "declared_not_implemented");
    ok(
      sqlite !== undefined && sqlite.path_found === false && sqlite.node_id === null && model.coverage.not_implemented === 1,
      "①-b 设计明写未引入（SQLite）**不算覆盖**且单列，不冒充可交付",
    );
    // 新增辅助实体确实各自挂上了真实关系（不是补个孤立节点凑数）
    for (const nid of [
      "df-node-discuss",
      "df-node-registry",
      "df-node-progress-compat",
      "df-node-gate-compat",
      "df-node-tasks-compat",
      "df-node-chat-log",
      "df-node-changes-log",
      "df-node-layout-store",
      "df-node-names-store",
      "df-node-fold-store",
      "df-node-reconcile-store",
      "df-node-supplement-store",
      "df-node-logs-store",
      "df-node-decisions-store",
      "df-node-intent-store",
    ]) {
      ok(nodeIdsAll.has(nid) && leadsEdge(nid), `①-b 辅助实体 ${nid} 在场且挂有端点闭合、有出处的真实关系`);
    }

    // ═════════════ ② 不冒充：链的完整性 ═════════════
    section("② 链完整性与「不冒充」判据");
    const newChains = model.chains.filter((c) => (NEW_CHAINS as readonly string[]).includes(c.id));
    const kindsOf = (c: (typeof model.chains)[number]): DataFlowEntityKind[] => {
      const ks = c.hops
        .map((h) => model.nodes.find((n) => n.id === h.node_id)?.kind)
        .filter((k): k is DataFlowEntityKind => k !== undefined);
      return [...new Set(ks)];
    };
    ok(
      newChains.every((c) => kindsOf(c).length === 4 && c.missing_kinds.length === 0),
      `② 新增链逐条四类实体齐全（${newChains.map((c) => `${c.id}=${kindsOf(c).length}`).join(" ")}）`,
    );
    ok(
      newChains.every((c) => c.hops.every((h) => h.node_id !== "" && h.edge_id !== undefined) && c.hops.slice(1).every((h) => h.edge_id !== null)),
      "② 新增链逐跳带节点与带它进来的那条关系（缺环看得见）",
    );
    ok(
      newChains.every((c) => c.hops.every((h) => h.evidence.length > 0)),
      "② 新增链逐跳都有出处",
    );
    // 链标「已验证」⇒ 逐跳节点与关系都到已验证（validator 同口径；这里再独立断言一次）。
    // V09-61 定向更新（finding f-4c71d59ab5552d36）：旧读数「新增链 ≥3 条已验证」依赖「脚本存在即实测」的假绿；
    // 判据收紧后必须真有当前可成立的运行记录才判已验证，真实塔台当前无运行记录 ⇒ 如实 0 条已验证。
    // 所以这里断言的是**判据**（凡标已验证的链必逐跳已验证）＋**如实读数**（无证据不得染色），不再断言偶然条数。
    const verifiedChains = newChains.filter((c) => c.verification === "verified");
    ok(
      verifiedChains.every((c) => c.hops.every((h) => h.verification === "verified") && c.missing_kinds.length === 0),
      `② 新增链里 ${verifiedChains.length} 条标「已验证」且逐跳都到已验证、四类齐全（无证据的一律如实未核实，不染色）`,
    );
    ok(
      verifiedChains.length === 0 || model.scan.notes.some((n) => n.includes("实测未采信")),
      `② 真实塔台当前 ${verifiedChains.length} 条已验证（无运行证据 ⇒ 0，脚本仅作可复跑线索；原因见 scan.notes）`,
    );
    for (const c of newChains) info(`     ② ${c.id} → ${c.verification}`);
    ok(
      model.edges.filter((e) => e.verification === "verified").every((e) => e.evidence.some((r) => r.tier === "code_measured")),
      "② 所有标「已验证」的关系都拿得出可复跑实测出处（没有靠静态线索染绿的边）",
    );

    // ═════════════ ④ 覆盖判据定向反例（合成声明；判据＝本轮改的共享机制，不硬编码塔台） ═════════════
    section("④ 覆盖判据泛化：定向反例必须被结构性判据逐条拦住");
    const ccx = (p: string, find: string) => ({ tier: "code_static" as const, path: p, find, note: "fx" });
    const dcx = (find: string) => ({ tier: "design_declared" as const, path: "design.md", find, note: "fx" });
    const aFile = 'const A_FILE = "a.json";';
    const A_TS = `src/a.ts`;
    const fixture = (files: Record<string, string>, idx: Record<string, unknown>) => {
      const dir = fs.mkdtempSync(path.join(TMP, "cx-"));
      for (const [rel, text] of Object.entries(files)) write(path.join(dir, ...rel.split("/")), text);
      const index = {
        design_path: "design.md",
        artifacts: [],
        nodes: [],
        edges: [],
        chains: [],
        measured: [],
        ...idx,
      } as unknown as ProjectIndex;
      return analyzeDataFlowAt(index, { project_id: "cx", root: dir, scripts: {} });
    };
    const nodeFx = (id: string, kind: string, p: string, find: string) => ({
      id,
      kind,
      label: id,
      role: "fx",
      claims: [ccx(p, find)],
      static_clues: [],
    });
    const edgeFx = (id: string, from: string, to: string, p: string, find: string) => ({
      id,
      from,
      to,
      relation: "read_write" as const,
      label: id,
      claims: [ccx(p, find)],
      static_clues: [],
      note: "fx",
    });
    const artFx = (extra: Record<string, unknown>) => ({
      id: "art-fx",
      artifact: "FX",
      kind: "input_source",
      declaration_status: "current",
      design: dcx("A input"),
      code: [ccx(A_TS, aFile)],
      role: "fx",
      ...extra,
    });
    const DESIGN = "A input\n";

    // 反例 A：仅文件名常量——有出处、但没有对应实体、没有关系
    const A = fixture({ "design.md": DESIGN, [A_TS]: `${aFile}\n` }, {
      artifacts: [artFx({})],
      nodes: [nodeFx("other", "process", A_TS, aFile)],
    });
    const rowA = A.coverage.rows[0]!;
    ok(
      !rowA.path_found && rowA.node_id === null && (rowA.gap ?? "").includes("没有对应到实体表里的实体") &&
        A.coverage.missing_paths.includes(rowA.artifact),
      "④-A 仅文件名常量（无 node_id／无关系）：不算覆盖，列为缺路径并点名原因",
    );

    // 反例 B：声明 node_id 指向不存在的实体（悬空）
    const B = fixture({ "design.md": DESIGN, [A_TS]: `${aFile}\n` }, {
      artifacts: [artFx({ node_id: "ghost-node" })],
      nodes: [nodeFx("real", "process", A_TS, aFile)],
    });
    const rowB = B.coverage.rows[0]!;
    ok(
      !rowB.path_found && (rowB.gap ?? "").includes("不存在（悬空指向") && B.coverage.missing_paths.length === 1,
      "④-B node_id 悬空指向不存在的实体：不算覆盖，列缺路径并点名「悬空」",
    );

    // 反例 C：实体在，但没有任何关系（孤立节点）
    const C = fixture({ "design.md": DESIGN, [A_TS]: `${aFile}\n` }, {
      artifacts: [artFx({ node_id: "solo" })],
      nodes: [nodeFx("solo", "process", A_TS, aFile)],
    });
    const rowC = C.coverage.rows[0]!;
    ok(
      !rowC.path_found && (rowC.gap ?? "").includes("孤立节点"),
      "④-C 实体存在但无任何真实关系（孤立节点）：不算覆盖，列缺路径并点名「孤立节点」",
    );

    // 反例 D：端点断裂（唯一关系指向不存在的实体）⇒ 该关系端点不闭合 ⇒ 节点仍算孤立
    const D = fixture({ "design.md": DESIGN, [A_TS]: `${aFile}\n` }, {
      artifacts: [artFx({ node_id: "solo" })],
      nodes: [nodeFx("solo", "process", A_TS, aFile)],
      edges: [edgeFx("e-broken", "solo", "ghost", A_TS, aFile)],
    });
    const rowD = D.coverage.rows[0]!;
    ok(
      !rowD.path_found && (rowD.gap ?? "").includes("孤立节点"),
      "④-D 端点断裂的关系不算真实关系（端点不闭合）：节点仍判孤立、不算覆盖",
    );

    // 反例 E：设计片段不存在（设计来源失效）
    const E = fixture({ "design.md": "别的正文\n", [A_TS]: `${aFile}\n` }, {
      artifacts: [artFx({ node_id: "solo", design: dcx("这条声明在设计里不存在") })],
      nodes: [nodeFx("solo", "process", A_TS, aFile), nodeFx("sink", "store", A_TS, aFile)],
      edges: [edgeFx("e1", "solo", "sink", A_TS, aFile)],
    });
    const rowE = E.coverage.rows[0]!;
    ok(
      !rowE.path_found && (rowE.gap ?? "").includes("设计来源失效"),
      "④-E 设计原文里复算不到声明（设计来源失效）：不算覆盖，列缺路径并点名原因",
    );

    // 反例 F：设计明写未实现（即便附了 codeclaim）⇒ 不计覆盖、也不计入缺路径
    const F = fixture({ "design.md": "F input\n", [A_TS]: `${aFile}\n` }, {
      artifacts: [{
        ...artFx({ node_id: "solo" }),
        declaration_status: "declared_not_implemented",
        design: dcx("F input"),
      }],
      nodes: [nodeFx("solo", "process", A_TS, aFile), nodeFx("sink", "store", A_TS, aFile)],
      edges: [edgeFx("e1", "solo", "sink", A_TS, aFile)],
    });
    const rowF = F.coverage.rows[0]!;
    ok(
      !rowF.path_found && (rowF.gap ?? "").includes("尚未实现") && F.coverage.not_implemented === 1 &&
        F.coverage.missing_paths.length === 0,
      "④-F 未实现带 codeclaim：仍不算覆盖，单列「未实现」且不计入缺路径",
    );

    // 反例 G：真实的静态 IO 关系（端点闭合 + 有出处）⇒ path_found=true，但只到 unverified（不是已验证）
    const G = fixture({ "design.md": DESIGN, [A_TS]: `${aFile}\nexport function readG(): void {}\nexport function writeG(): void {}\n` }, {
      artifacts: [artFx({ node_id: "reader" })],
      nodes: [
        nodeFx("reader", "process", A_TS, "export function readG(): void {}"),
        nodeFx("sink", "store", A_TS, "export function writeG(): void {}"),
      ],
      edges: [edgeFx("e-g", "reader", "sink", A_TS, "export function writeG(): void {}")],
    });
    const rowG = G.coverage.rows[0]!;
    const nodeG = G.nodes.find((n) => n.id === "reader")!;
    const edgeG = G.edges.find((e) => e.id === "e-g")!;
    ok(
      rowG.path_found === true && nodeG.verification === "unverified" && edgeG.verification === "unverified",
      "④-G 真实 valid 静态 IO 关系：判 path_found，但只到「未核实」（路径存在 ≠ 实测已验证）",
    );

    // 反例 H：实体与关系都在，但这条声明本体没有任何出处 ⇒ 仍不算覆盖（保留原证据判据）
    const H = fixture({ "design.md": DESIGN, [A_TS]: `${aFile}\n` }, {
      artifacts: [artFx({ node_id: "solo", code: [] })],
      nodes: [nodeFx("solo", "process", A_TS, aFile), nodeFx("sink", "store", A_TS, aFile)],
      edges: [edgeFx("e1", "solo", "sink", A_TS, aFile)],
    });
    const rowH = H.coverage.rows[0]!;
    ok(
      !rowH.path_found && (rowH.gap ?? "").includes("本体没有任何有效出处"),
      "④-H 实体与关系都在、但声明本体无出处：仍不算覆盖（结构化判据不替代原证据判据）",
    );

    // ═════════════ ③ 真跑新增链路（隔离夹具） ═════════════
    section("③ 隔离夹具：真跑新增链路的关键跳");
    process.env.TATAI_HOME = FX_HOME;
    const PID = "df-fx";
    const root = path.join(TMP, "proj");
    mkdirp(path.join(root, ".工作台"));
    const PLAN = planText("数据流补齐夹具施工图", [
      { id: "T-1", goal: "夹具卡一" },
      { id: "T-2", goal: "夹具卡二" },
    ]);
    write(path.join(root, ".工作台", "design.md"), "# 夹具设计书\n\n## 1 目标\n\n夹具设计正文。\n");
    write(path.join(root, ".工作台", "plan.md"), PLAN);
    addProject({ id: PID, name: "数据流补齐夹具", path: root, kind: "backend" }, FX_HOME);
    const service = new WorkService({ dataDir: FX_HOME });
    const submitter = { submit: (c: unknown) => service.submit(c) };
    const workDir = projectWorkDir(PID, FX_HOME);

    // ③-1 证据正文：内容寻址落盘 → 同内容去重 → 读回复核哈希 → 篡改暴露
    const input = {
      content: "夹具证据正文：数据流向图补齐自检。",
      kind: "other" as never,
      summary: "夹具证据",
      created_by: "verify-fivegraph",
      role: "executor",
      binding: { revision_kind: "code" as never, revision: "fixture-rev-1" },
      source_ref: null,
    };
    const blob = putEvidence(workDir, input as never);
    const blobAgain = putEvidence(workDir, input as never);
    const readBack = readEvidence(workDir, blob.sha256);
    ok(
      blob.sha256 === sha256(input.content) && fs.existsSync(evidenceBlobPath(workDir, blob.sha256)),
      `③-1 证据正文按内容寻址落盘（sha256=${blob.sha256.slice(0, 12)}…，文件真在）`,
    );
    ok(blobAgain.duplicate === true && blobAgain.sha256 === blob.sha256, "③-1 同内容重复提交返回原记录（不产生第二份）");
    ok(readBack.sha256 === blob.sha256, "③-1 读回时复核哈希一致（读点走过）");
    // 篡改暴露：直接改盘上文件内容，读回应报错（不是返回假证据）
    const file = evidenceBlobPath(workDir, blob.sha256);
    const original = fs.readFileSync(file, "utf8");
    fs.writeFileSync(file, original.replace("夹具证据正文", "被篡改的正文"), "utf8");
    let tamperCaught = false;
    try {
      readEvidence(workDir, blob.sha256);
    } catch {
      tamperCaught = true;
    }
    fs.writeFileSync(file, original, "utf8");
    ok(tamperCaught, "③-1 盘上正文被改后读回即报错（读时复核哈希，不返回假证据）");

    // ③-2 需求登记 + 施工定义导入：经真唯一写服务落账并读回
    const reqRec = registerRequirement(submitter as never, {
      project_id: PID,
      requirement_id: "req-df-fx-1",
      change_id: "chg-df-fx",
      actor_id: "verify-fivegraph",
      role: "coordinator",
      source: { kind: "design", ref: "DESIGN.md §2.6" },
      problem: "数据流向图需要覆盖已实现的核心链路",
      users: ["Agent"],
      success_scenarios: ["补出可复跑的实体/路径/出处"],
      exclusions: [],
      priority: "P2",
      status: "explicit",
    });
    const defs = importPlanChecked(PLAN, workDir).definitions;
    const defReceipts = submitDefinitionImports(submitter as never, {
      project_id: PID,
      change_id: "chg-df-fx",
      actor_id: "verify-fivegraph",
      role: "coordinator",
      definitions: defs,
    });
    const events = loadEvents(workDir).events;
    const types = events.map((e) => e.type);
    ok(
      reqRec.ok === true && types.includes("requirement.registered") && readRequirements(workDir).requirements["req-df-fx-1"] !== undefined,
      "③-2 需求登记经唯一写服务落账并读回（requirement.registered 在场）",
    );
    ok(
      defReceipts.length === defs.length && defs.length > 0 && types.filter((t) => t === "task.definition_imported").length === defs.length,
      `③-2 施工定义导入落成不可变任务定义（${defs.length} 条 task.definition_imported，不改执行状态）`,
    );
    ok(
      Object.keys(readTaskStates(workDir).states).length === defs.length,
      "③-2 定义导入后任务在册可读（执行状态仍为空，未凭空产生执行事实）",
    );

    // ③-3 基线激活：落 baselines.jsonl + 不可变修订对象
    const baseline = activateBaseline(PID, { approved_by: "user", approval_basis: "夹具审定（非真实用户 Gate）", approval_kind: "user_confirmed" }, FX_HOME);
    const baselinesFile = path.join(root, ".工作台", BASELINES_FILE);
    ok(
      baseline !== null && baseline !== undefined && fs.existsSync(baselinesFile) && fs.readFileSync(baselinesFile, "utf8").trim().split("\n").length >= 1,
      `③-3 基线激活追加基线记录（${BASELINES_FILE} 有 ${fs.existsSync(baselinesFile) ? fs.readFileSync(baselinesFile, "utf8").trim().split("\n").length : 0} 行）`,
    );
    const revDir = path.join(root, ".工作台", "design-revisions");
    ok(fs.existsSync(revDir) && fs.readdirSync(revDir).length >= 1, "③-3 设计修订不可变对象真落盘（design-revisions/ 非空）");

    // ③-4 同步证据：登记契约 → 投证据包 → 扫描核验落账
    const REPORT_REL = "reports/result.md";
    write(path.join(root, REPORT_REL), "夹具同步证据报告：真实 artifact 正文。\n");
    const contract = {
      schema_version: 1,
      batch_id: "b-df-fx",
      project_id: PID,
      title: "数据流补齐夹具批次",
      sources: [{ path: "AGENTS.md", sha256: sha256("夹具规则") }],
      items: [
        { id: "report", label: "报告存在", required: true, check: { type: "file_hash", path: REPORT_REL, sha256: sha256(fs.readFileSync(path.join(root, REPORT_REL))) } },
      ],
      blocks_entry: false,
    };
    write(path.join(root, "AGENTS.md"), "夹具规则");
    const cmd = buildRegisterContractCommand({ projectId: PID, changeId: "chg-df-fx", actorId: "verify-fivegraph", role: "designer", contract, expectedRevision: null });
    await service.submit(cmd);
    const status = readSyncStatus(PID, FX_HOME);
    const batch = (status.batches as { batch_id: string; contract_sha256?: string }[]).find((b) => b.batch_id === "b-df-fx");
    const inbox = path.join(workDir, "sync-inbox");
    mkdirp(inbox);
    const pkg = {
      schema_version: 1,
      batch_id: "b-df-fx",
      project_id: PID,
      contract_sha256: batch?.contract_sha256 ?? "",
      completed: true,
      items: [{ id: "report", result: "passed", artifacts: [{ path: REPORT_REL, sha256: sha256(fs.readFileSync(path.join(root, REPORT_REL))) }] }],
    };
    const tmpPkg = path.join(inbox, ".b-df-fx.evidence.json.tmp");
    fs.writeFileSync(tmpPkg, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
    fs.renameSync(tmpPkg, path.join(inbox, "b-df-fx.evidence.json"));
    const scan = await scanSyncProject({ projectId: PID, dataDir: FX_HOME, submitter: submitter as never });
    const syncEvents = loadEvents(workDir).events.filter((e) => e.type.startsWith("sync.")).map((e) => e.type);
    ok(
      batch !== undefined && typeof batch.contract_sha256 === "string" && batch.contract_sha256 !== "",
      "③-4 同步契约经唯一写服务登记成功（读回批次带 contract_sha256）",
    );
    ok(
      scan !== undefined && syncEvents.includes("sync.contract_registered") && syncEvents.includes("sync.evidence_checked"),
      `③-4 证据包投进收件目录后扫描核验落账（sync 事件：${[...new Set(syncEvents)].join("、")}）`,
    );
    info(`     ③-4 本次扫描结论：${JSON.stringify((scan as { report?: { overall?: string } }).report?.overall ?? "（未取到）")}`);
  } finally {
    if (prevHome === undefined) delete process.env.TATAI_HOME;
    else process.env.TATAI_HOME = prevHome;
    fs.rmSync(TMP, { recursive: true, force: true });
  }

  console.log(`\n[verify] 数据流向图补齐：PASS ${pass} / FAIL ${fails.length}`);
  for (const f of fails) console.log(`[verify]   FAIL：${f}`);
  if (fails.length > 0) process.exit(1);
  console.log("[verify] 全部 PASS");
}

main().catch((e: unknown) => {
  console.error(`[verify] 脚本自身出错：${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  process.exit(1);
});
