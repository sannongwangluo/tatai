// V06-06 验证脚本（PLAN.md V06-06，DESIGN.md §3.2–§3.3 / §4.2–§4.7 为主契约）。
// 用法：pnpm verify:v06-06（或 node --import tsx scripts/verify-v06-06.ts）
//
// 本脚本管**逻辑与契约**（浏览器场景由 `scripts/verify-v06-06-ui.py` 负责，两者都跑才算完）：
//   ① **三视图分工**：PROJECT_VIEWS 三行（节点/关系来源、问答）、关系语义分类、跨视图定位的稳定 ID 口径；
//   ② **状态解释**：六态色表与服务端 `DISPLAY_STATUS_LABELS`/`DISPLAY_STATUS_PRIORITY` **逐字对账**
//      （前端不能 import 服务端那份——它拖 `node:fs` 进前端包；所以口径靠断言钉住）；
//      详情的 §3.2 五段顺序与内容来源（状态/原因/计数/缺口/来源时间全部来自 V06-09 的投影）；
//   ③ **数量口径**：概览 5–15、不足 5 不补假节点、超量聚合并显示隐藏数量；
//   ④ **四种说明分开**：加载失败 / 无规划 / 无匹配 / 空图 + 图正在更新 / 图已过期；
//   ⑤ **布局增量更新不跳动**：`mergeIncrementalLayout` 已有坐标逐字节保留；
//   ⑥ **零改动证明**：受保护文档与既有验证脚本的**首尾 sha256 对照**（本卡一个字节都没改它们）。
//
// 不写任何文件、不起服务、不碰真实项目的 `.工作台/`：纯函数 + 源码级护栏 + 首尾哈希。
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { Blueprint, BlueprintEdge, BlueprintNode } from "../src/arch/blueprint";
import {
  DISPLAY_STATUS_LABELS,
  DISPLAY_STATUS_PRIORITY,
  projectStatuses,
  type StatusProjection,
} from "../src/server/work/statusProjection";
import {
  DISPLAY_STATUS_KEYS,
  DISPLAY_STATUS_PALETTE,
  STATUS_STYLE,
  displayStatusStyle,
  statusStyle,
} from "../src/ui/arch/statusColor";
import {
  mergeIncrementalLayout,
  weightToStrokeWidth,
  layoutWithDagre,
} from "../src/ui/arch/layout";
import { matchedNote, previousBookmark, pushBookmark, unmatchedNote, type LocateRequest } from "../src/ui/arch/locate";
import {
  BLUEPRINT_EDGE_SEMANTICS,
  DETAIL_SECTION_TITLES,
  EDGE_SEMANTICS,
  EDGE_SEMANTICS_ORDER,
  OVERVIEW_MAX,
  OVERVIEW_MIN,
  PROJECT_VIEWS,
  PROJECT_VIEW_KEYS,
  aggregateStatusOf,
  applyViewFilter,
  buildViewModel,
  capOverview,
  detailSectionsOf,
  directStatusOf,
  emptyStateOf,
  freshnessOf,
  objectIdOf,
  scopeReportOf,
  technicalIdOf,
  type ProjectViewKind,
} from "../src/ui/arch/projectGraph";

const REPO = process.cwd();
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
const section = (t: string) => console.log(`\n[verify] ── ${t}`);

const sha = (rel: string): string =>
  crypto.createHash("sha256").update(fs.readFileSync(path.join(REPO, rel))).digest("hex");

/** 受保护清单：本卡承诺一个字节都不改的文档与既有验证脚本（首尾哈希对照，证据落 05-doc-hashes.txt） */
const PROTECTED_DOCS = [
  "DESIGN.md",
  "PLAN.md",
  "PROGRESS.md",
  "AGENTS.md",
  "README.md",
  "docs/design-history-v0.4.md",
  "docs/design-history-v0.5.md",
  "docs/work-v2-contract.md",
];
const VICTIM_SCRIPTS = [
  "scripts/verify-a1.ts",
  "scripts/verify-a2.ts",
  "scripts/verify-a3.ts",
  "scripts/verify-a4.ts",
  "scripts/verify-a5.ts",
  "scripts/verify-f2.ts",
  "scripts/verify-f3.ts",
  "scripts/verify-f4.ts",
  "scripts/verify-n1.ts",
  "scripts/verify-n2.ts",
  "scripts/verify-n3.ts",
  "scripts/verify-d1.ts",
  "scripts/verify-l3.ts",
  "scripts/verify-s2.ts",
  "scripts/check-graph-consistency.ts",
  "scripts/verify-v06-01.ts",
  "scripts/verify-v06-02.ts",
  "scripts/verify-v06-03.ts",
  "scripts/verify-v06-04.ts",
  "scripts/verify-v06-05.ts",
  "scripts/verify-v06-09.ts",
];

/** DESIGN.md 附录 B 区间（标题行起、到文件尾）——本卡连它一个字节都不许动 */
function appendixBRegion(): string {
  const text = fs.readFileSync(path.join(REPO, "DESIGN.md"), "utf8");
  const idx = text.indexOf("## 附录 B：待议记录");
  return idx === -1 ? "" : text.slice(idx);
}

const hashTable = (files: string[]): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const f of files) {
    try {
      out[f] = sha(f);
    } catch {
      out[f] = "(缺失)";
    }
  }
  return out;
};

const readFile = (rel: string): string => fs.readFileSync(path.join(REPO, rel), "utf8");

/** 剥掉注释（行注释与块注释），只留**代码本体**——源码文本断言只该钉代码，不该被说明注释里的名词trigger。 */
const stripComments = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/)
    .map((l) => l.replace(/\/\/.*$/, ""))
    .join("\n");

// ══════════════════════════════ 夹具：蓝图 + 投影（都是真契约的形状） ══════════════════════════════

const ref = (kind: "design_section" | "plan_task" | "code_module", locator: string, p: string) => ({
  kind,
  path: p,
  locator,
  sha256: `${kind}-${locator}`.padEnd(64, "0").slice(0, 64),
});

function node(id: string, kind: BlueprintNode["kind"], name: string, locator = id): BlueprintNode {
  return {
    id,
    kind,
    name,
    source_refs: [ref(kind === "task" ? "plan_task" : kind === "module" ? "code_module" : "design_section", locator, "fixture.md")],
    related_ids: [],
  };
}
const edge = (source: string, target: string, kind: BlueprintEdge["kind"], certainty: BlueprintEdge["certainty"] = "declared"): BlueprintEdge => ({
  source,
  target,
  kind,
  source_refs: [ref("design_section", `${source}->${target}`, "fixture.md")],
  certainty,
});

/** 夹具蓝图：4 个能力 + 2 个声明模块 + 4 个任务（T-3 有两个前置）+ 2 个实测代码模块 */
function fixtureBlueprint(over?: Partial<Blueprint>): Blueprint {
  const nodes: BlueprintNode[] = [
    node("plan:cap:01", "capability", "记录能力", "1. 记录能力"),
    node("plan:cap:02", "capability", "导入能力", "2. 导入能力"),
    node("plan:cap:03", "capability", "导出能力", "3. 导出能力"),
    node("plan:cap:04", "capability", "校验能力", "4. 校验能力"),
    node("plan:mod:02-01", "module", "记录模块"),
    node("plan:mod:02-02", "module", "存储模块"),
    node("plan:task:T-1", "task", "T-1 记录地基", "T-1"),
    node("plan:task:T-2", "task", "T-2 导入通道", "T-2"),
    node("plan:task:T-3", "task", "T-3 导出通道", "T-3"),
    node("plan:task:T-4", "task", "T-4 校验规则", "T-4"),
    node("plan:code:src-base", "module", "src-base"),
    node("plan:code:src-import", "module", "src-import"),
  ];
  const edges: BlueprintEdge[] = [
    edge("plan:cap:01", "plan:mod:02-01", "design_interface"),
    edge("plan:cap:01", "plan:mod:02-02", "design_interface"),
    edge("plan:cap:02", "plan:mod:02-02", "design_interface"),
    // 施工依赖：T-2←T-1；T-3←T-1、T-3←T-2（**多前置**，不许压成母子树）
    edge("plan:task:T-1", "plan:task:T-2", "task_dependency"),
    edge("plan:task:T-1", "plan:task:T-3", "task_dependency"),
    edge("plan:task:T-2", "plan:task:T-3", "task_dependency"),
    // 任务 → 能力（出处引用）
    edge("plan:task:T-1", "plan:cap:01", "task_design_ref"),
    edge("plan:task:T-2", "plan:cap:02", "task_design_ref"),
    edge("plan:task:T-3", "plan:cap:03", "task_design_ref"),
    edge("plan:task:T-4", "plan:cap:04", "task_design_ref"),
    // 实现映射（集成/关系线）
    edge("plan:task:T-1", "plan:code:src-base", "implementation_map", "observed"),
    edge("plan:task:T-2", "plan:code:src-import", "implementation_map", "observed"),
    edge("plan:cap:04", "plan:mod:02-01", "model_inference", "unverified"),
  ];
  return {
    version: 1,
    baseline_id: "bl-fixture",
    generator_version: "v06-05.1",
    generated_at: "2026-09-20T10:00:00+08:00",
    source_manifest: [],
    nodes,
    edges,
    coverage: {
      design_sections: { total: 4, mapped: 4, unmapped: [] },
      plan_tasks: { total: 4, mapped: 4, unmapped: [] },
      code_modules: { total: 2, mapped: 2, unmapped: [] },
      nodes_total: nodes.length,
      nodes_kept: nodes.length,
      edges_total: edges.length,
      edges_kept: edges.length,
      note: "fixture",
    },
    omitted: [],
    model_receipt: null,
    publish: { published: true, reason: null, validated_at: "2026-09-20T10:00:01+08:00" },
    based_on: {
      model_key: "mk",
      full_key: "fk",
      design_content_sha256: "design-v1",
      plan_definition_sha256: "plan-v1",
      semantic: false,
    },
    ...over,
  };
}

/**
 * 夹具投影：**用真的 `projectStatuses`** 算（不是手写一堆假 StatusProjection）——
 * 这样"状态只有一处来源"这条在本脚本里也是真的。
 * 场景：T-1 结果已交但缺证据（橙）；T-2 正在做（蓝）；T-3 阻塞（红）；T-4 独立审计全过（绿）；
 *       src-base 模块的父级没有自身集成检查 → 不判绿。
 */
function fixtureProjection(): Record<string, StatusProjection> {
  const withStatus = (
    objects: Parameters<typeof projectStatuses>[0]["objects"],
    checks: Parameters<typeof projectStatuses>[0]["checks"],
  ): Record<string, StatusProjection> => {
    const set = projectStatuses({ objects, findings: [], checks });
    return set.by_id;
  };
  return withStatus(
    [
      {
        object_id: "T-1",
        object_kind: "task",
        label: "T-1 记录地基",
        executions: [{ task_id: "T-1", status: "result_submitted", actor_id: "kimi", updated_at: "2026-09-20T09:00:00+08:00" }],
        required_checks: [
          { check_id: "T-1::check:0", label: "地基水平合格" },
          { check_id: "T-1::evidence", label: "交付包 diff" },
        ],
        revisions: { plan: "plan-v1" },
      },
      {
        object_id: "T-2",
        object_kind: "task",
        label: "T-2 导入通道",
        executions: [{ task_id: "T-2", status: "executing", actor_id: "kimi", updated_at: "2026-09-20T09:30:00+08:00" }],
        required_checks: [{ check_id: "T-2::check:0", label: "1000 行无丢行" }],
        revisions: { plan: "plan-v1" },
      },
      {
        object_id: "T-3",
        object_kind: "task",
        label: "T-3 导出通道",
        executions: [{ task_id: "T-3", status: "blocked", actor_id: "kimi", updated_at: "2026-09-20T09:40:00+08:00" }],
        required_checks: [{ check_id: "T-3::check:0", label: "导出文件可读回" }],
        revisions: { plan: "plan-v1" },
      },
      {
        object_id: "T-4",
        object_kind: "task",
        label: "T-4 校验规则",
        executions: [{ task_id: "T-4", status: "result_submitted", actor_id: "kimi", updated_at: "2026-09-20T09:50:00+08:00" }],
        required_checks: [{ check_id: "T-4::evidence", label: "坏数据点名" }],
        revisions: { plan: "plan-v1" },
      },
      {
        object_id: "module:src-base",
        object_kind: "module",
        label: "src-base",
        children_ids: ["T-1"],
        integration_checks: [],
        revisions: { plan: "plan-v1" },
      },
    ],
    [
      {
        check_id: "T-1::check:0",
        object_id: "T-1",
        result: "passed",
        actor_id: "kimi",
        role: "executor",
        independence: "author_self",
        binding: { revision_kind: "plan", revision: "plan-v1" },
        evidence_sha256: "a".repeat(64),
        at: "2026-09-20T09:10:00+08:00",
      },
      {
        check_id: "T-4::evidence",
        object_id: "T-4",
        result: "passed",
        actor_id: "claude",
        role: "auditor",
        independence: "independent",
        binding: { revision_kind: "plan", revision: "plan-v1" },
        evidence_sha256: "b".repeat(64),
        at: "2026-09-20T09:55:00+08:00",
      },
      // 依赖线对象：`<前置>-><依赖方>`（V06-09 的命名口径）
      ...[],
    ],
  );
}

/** 依赖线对象（投影里的 edge 对象；由调用方按前置状态给结论） */
const dependencyObject = (prereq: string, dep: string, released: boolean, resultSubmitted: boolean) => ({
  object_id: `${prereq}->${dep}`,
  object_kind: "edge" as const,
  label: `${prereq} → ${dep}`,
  edge: {
    edge_kind: "dependency" as const,
    from: prereq,
    to: dep,
    prerequisite_released: released,
    prerequisite_result_submitted: resultSubmitted,
    prerequisite_reasons: [released ? "前置已交并达标" : "前置未释放：先跑 dependencyRelease"],
  },
  required_checks: [{ check_id: `${prereq}->${dep}::prerequisite`, label: `前置 ${prereq} 交付满足` }],
  revisions: { plan: "plan-v1" },
});

const fixtureProjectionWithEdges = (): Record<string, StatusProjection> => {
  const base = fixtureProjection();
  const set = projectStatuses({
    objects: [dependencyObject("T-1", "T-2", false, true), dependencyObject("T-2", "T-3", false, false)],
    findings: [],
    checks: [],
  });
  return { ...base, ...set.by_id };
};

// ══════════════════════════════ 首尾哈希（零改动证明） ══════════════════════════════

section("⓪ 开工基线：受保护文档与既有验证脚本的首尾 sha256（本卡承诺零改动）");
const startDocs = hashTable([...PROTECTED_DOCS, ...VICTIM_SCRIPTS]);
const startAppendix = crypto.createHash("sha256").update(appendixBRegion()).digest("hex");
ok(Object.values(startDocs).every((h) => h !== "(缺失)"), `受保护清单全部在场（${Object.keys(startDocs).length} 个文件）`);
ok(startAppendix !== "", `DESIGN.md 附录 B 区间可定位（sha256 ${startAppendix.slice(0, 12)}…）`);

// ══════════════════════════════ ① 三视图分工与关系语义 ══════════════════════════════

section("① 三视图分工（§3.2 表格三行）");
ok(PROJECT_VIEW_KEYS.length === 3 && PROJECT_VIEW_KEYS.every((k) => PROJECT_VIEWS[k].key === k), "三个主视图声明齐全且键自洽");
ok(
  PROJECT_VIEW_KEYS.every((k) => PROJECT_VIEWS[k].projection_kind === k),
  `projection_kind 与视图键同名（${PROJECT_VIEW_KEYS.map((k) => PROJECT_VIEWS[k].projection_kind).join(" / ")}）`,
);
ok(
  PROJECT_VIEWS.functional.label === "功能全景" &&
    PROJECT_VIEWS.architecture.label === "系统架构" &&
    PROJECT_VIEWS.construction.label === "施工依赖",
  "三个视图的中文名与 §3.2 表格一致（功能全景 / 系统架构 / 施工依赖）",
);
ok(
  PROJECT_VIEWS.functional.node_kinds.join(",") === "capability" &&
    PROJECT_VIEWS.architecture.node_kinds.includes("module") &&
    PROJECT_VIEWS.construction.node_kinds.join(",") === "task",
  "三视图的节点来源不同（能力 / 模块+能力 / 任务）——§3.2「不要求节点集合完全相同」",
);
ok(
  PROJECT_VIEWS.construction.edge_kinds.includes("task_dependency") &&
    PROJECT_VIEWS.architecture.edge_kinds.includes("implementation_map"),
  "施工依赖取 task_dependency、系统架构取 implementation_map（各自的关系来源）",
);

section("① 关系语义（§3.2 末段 + §4.2：依赖线与集成线分开）");
ok(
  BLUEPRINT_EDGE_SEMANTICS.task_dependency === "dependency" &&
    BLUEPRINT_EDGE_SEMANTICS.design_interface === "integration" &&
    BLUEPRINT_EDGE_SEMANTICS.implementation_map === "integration" &&
    BLUEPRINT_EDGE_SEMANTICS.model_inference === "inferred",
  "蓝图关系 kind → 线语义映射齐备（task_dependency/design_interface/implementation_map/model_inference）",
);
ok(
  EDGE_SEMANTICS.dependency.completion_colored === true &&
    ["integration", "reference", "inferred", "static_reference"].every((s) => EDGE_SEMANTICS[s as "integration"].completion_colored === false),
  "**只有依赖线会着完成色**；集成/出处/推断/静态引用线一律不着完成色（§4.2）",
);
ok(
  EDGE_SEMANTICS.integration.dash !== null &&
    EDGE_SEMANTICS.integration.color !== EDGE_SEMANTICS.dependency.color &&
    EDGE_SEMANTICS.dependency.color === DISPLAY_STATUS_PALETTE.unknown.hex &&
    EDGE_SEMANTICS.integration.means.includes("两个端点绿不代表连线绿"),
  "集成线与依赖线**色值与虚实都不同**（依赖线未判释放时也用六态的中性灰），且口径句明说「两个端点绿不代表连线绿」",
);
ok(
  EDGE_SEMANTICS.static_reference.means.includes("不着完成色") &&
    EDGE_SEMANTICS.dependency.means.includes("不代表数据链路已联通"),
  "静态引用线与施工依赖线的口径句都写清了自己的语义（§4.2 两条）",
);
ok(
  EDGE_SEMANTICS.dependency.dash !== null && EDGE_SEMANTICS.integration.dash !== null,
  "两类线都带虚线样式：依赖线在**未判前置是否释放**时画中性虚线（未知不假装已满足，§4.2），集成线恒虚线",
);
ok(
  EDGE_SEMANTICS_ORDER.length === Object.keys(EDGE_SEMANTICS).length,
  `线语义图例覆盖全部 ${EDGE_SEMANTICS_ORDER.length} 种语义`,
);
ok(
  EDGE_SEMANTICS_ORDER.every((s) => EDGE_SEMANTICS_STYLE_PROBE(s)),
  "每种语义都有颜色、名称与口径句（图例可直接渲染）",
);
function EDGE_SEMANTICS_STYLE_PROBE(s: (typeof EDGE_SEMANTICS_ORDER)[number]): boolean {
  const spec = EDGE_SEMANTICS[s];
  return /^#[0-9a-f]{6}$/i.test(spec.color) && spec.label !== "" && spec.means !== "";
}

// ══════════════════════════════ ② 状态口径对账（前端六态 vs 服务端六态） ══════════════════════════════

section("② 六态色表与服务端口径逐字对账（前端不 import 服务端那份，靠断言钉住）");
ok(
  [...DISPLAY_STATUS_KEYS].sort().join(",") === [...DISPLAY_STATUS_PRIORITY].sort().join(","),
  `六态键集合与服务端一致（${DISPLAY_STATUS_KEYS.join(" / ")}）`,
);
ok(
  DISPLAY_STATUS_KEYS.every((k) => DISPLAY_STATUS_PALETTE[k].full === DISPLAY_STATUS_LABELS[k]),
  "六态的完整口径句与 DISPLAY_STATUS_LABELS **逐字相同**（含「灰：已规划，未开始」这类前缀）",
);
ok(
  DISPLAY_STATUS_KEYS.join(",") === DISPLAY_STATUS_PRIORITY.join(","),
  "六态表的键序 = 服务端优先级序（§4.2 未知→阻塞→进行中→待验证→通过→未开始）",
);
ok(
  DISPLAY_STATUS_KEYS.every((k) => DISPLAY_STATUS_PALETTE[k].icon !== "" && DISPLAY_STATUS_PALETTE[k].short !== ""),
  "六态每档都有短标签与图标（颜色之外的第二通道，§3.3「颜色同时配文字/图标」）",
);
ok(
  DISPLAY_STATUS_PALETTE.planned.hex !== DISPLAY_STATUS_PALETTE.verified.hex &&
    DISPLAY_STATUS_PALETTE.blocked.hex !== DISPLAY_STATUS_PALETTE.in_progress.hex,
  "六态色值互不相同（不靠「看起来差不多」）",
);
ok(DISPLAY_STATUS_PALETTE.unknown.dashed === true, "未知/陈旧用虚线（§4.2 表最后一行：中性虚线与文字）");
ok(
  STATUS_STYLE.todo.label === "未开始" && STATUS_STYLE.done.label === "已完成" && statusStyle("doing").hex === "#fbbf24",
  "A5 的四色表逐字未动（技术详情的旧口径回归不受影响）",
);
ok(displayStatusStyle(null).short === "已规划" && displayStatusStyle("verified").icon === "✓", "六态取样式函数可用（null 兜底到灰）");
ok(
  directStatusOf(null).display === null && directStatusOf(null).kind === "unmapped",
  "没有投影对象的节点 → **不着完成色**（不空集判绿，§4.2）",
);

// ══════════════════════════════ ③ 视图选择（节点/关系/数量） ══════════════════════════════

section("③ 视图选择：节点来源、跨视图定位的稳定 ID、多前置依赖不成树");
const bp = fixtureBlueprint();
const projection = fixtureProjectionWithEdges();
const mergedNodes = [
  { id: "src-base", plan_refs: ["plan:code:src-base"] },
  { id: "src-import", plan_refs: ["plan:code:src-import"] },
];
const vmFunctional = buildViewModel({ view: "functional", blueprint: bp, projection, mergedNodes });
const vmArchitecture = buildViewModel({ view: "architecture", blueprint: bp, projection, mergedNodes });
const vmConstruction = buildViewModel({ view: "construction", blueprint: bp, projection, mergedNodes });

ok(
  vmFunctional.nodes.every((n) => n.id.startsWith("plan:cap:")),
  `功能全景只放能力节点（${vmFunctional.nodes.length} 个：${vmFunctional.nodes.map((n) => n.id).join("、")}）`,
);
ok(
  vmConstruction.nodes.filter((n) => n.endpoint !== true).every((n) => n.id.startsWith("plan:task:")) &&
    vmConstruction.nodes.filter((n) => n.endpoint === true).every((n) => n.id.startsWith("plan:code:")),
  `施工依赖的主体是任务节点（${vmConstruction.nodes.filter((n) => !n.endpoint).length} 个），集成端点是实测模块（${vmConstruction.nodes.filter((n) => n.endpoint).length} 个）`,
);
ok(
  vmArchitecture.nodes.some((n) => n.id === "plan:cap:01") &&
    vmArchitecture.groups.some((g) => g.members.some((m) => m.startsWith("plan:mod:"))),
  `系统架构按能力分组、成员是模块（${vmArchitecture.groups.map((g) => `${g.label}(${g.members.length})`).join("、")}）`,
);
// ── V09-02 定向新增：系统架构视图的**边数**正/反断言（PLAN.md V09-02；附录 E.5 登记的 edges=0）──
// 保留意图（上一条「按能力分组、成员是模块」不动）＋本次新增的意图＝「分组节点是画布上的节点，
// 成员被改名/分组后端点解析不能落空」。判据不放宽：仍是逐条点名到具体边 id，且自环/悬空线零容忍。
//
// ── V09-02b 定向更新（判据**不放宽**）：2026-09-26 安装版架构灰块复核落地口径 ──
//   旧期望 = ①本夹具架构视图 `edges.length > 0`（当时画得出 cap:01→cap:02 的 design_interface 与
//            两条 `cap:* > ungrouped:plan:code:*` 的实现映射线）；②实现映射的靶点无归属时落
//            `ungrouped:<模块 id>`；③口径句条数含 "2"、加一条反例后含 "3"。
//   依据   = 2026-09-26 落地的新口径（`src/ui/arch/projectGraph.ts`：成员→能力归属改**多值**；系统架构新增
//            「能力 ← 任务设计引用 ← 实测实现映射(observed) → plan:code:*」二级派生归属；同组判据改成
//            「两端有没有共同分组」）：
//              · `design_interface` 本身就是归属声明 ⇒ 任何 design_interface 的两端必有共同分组，
//                **不可能**再画成跨组线；
//              · src-base／src-import 经 T-1／T-2 的 observed 实现映射派生归 cap:01／cap:02 ⇒ 不再是孤组，
//                它们那两条实现映射同样判同组。实测本夹具 5 条本视图关系**全部**同组（可见线 0 条）。
//   新期望 = ①关系逐条有归类（5 条全部有归类：同组 5 + 可见 0 + 落空 0），口径句条数用**限定子串**
//            「本次 5 条」核对（旧写法 `includes("2")`／`includes("3")` 会被正文里的"§3.2"「§3.3」蹭中，
//            是假判据，随手换掉＝更严）；②「跨组关系线仍画得出」与「真无归属模块仍如实成组」两条覆盖搬到
//            本段新增的**局部夹具变体**（cap:01→cap:02 的跨组实现映射、真无归属的 `plan:code:src-loose`
//            仍落 `ungrouped:<id>`、declared 映射不派生归属），不删不空。
//   保留意图 = 「分组节点是画布节点、成员被改名/分组后端点解析不落空」「同组不画自环、不造假线、线数不虚增」
//            「无归属模块仍如实成组」——旧判据的要害是解析不落空与口径自洽，不是"必须画成跨组线"。
//   判据不放宽 = 从"存在某条线"换成"每条关系都有归类、无一条落空"（+ 限定子串口径句），并保留跨组线、
//            孤组成组、悬空线/自环零容忍三组正反例（见下）。
{
  const archIds = new Set(vmArchitecture.nodes.map((n) => n.id));
  const archIntraIds = new Set(vmArchitecture.intra_relations.map((e) => e.id));
  const archDrawnIds = new Set(vmArchitecture.edges.map((e) => e.id));
  const archKinds = new Set<string>(PROJECT_VIEWS.architecture.edge_kinds);
  const archRaw = bp.edges.filter((e) => archKinds.has(e.kind));
  const archClassified = archRaw.filter(
    (e) =>
      archIntraIds.has(`${e.source}>${e.target}:${e.kind}`) || archDrawnIds.has(`${e.source}>${e.target}:${e.kind}`),
  );
  ok(
    archRaw.length > 0 && archClassified.length === archRaw.length,
    `V09-02 正断言：系统架构不再静默丢关系（夹具 ${archRaw.length} 条本视图关系全部有归类：${vmArchitecture.intra_relations.length} 条同组关系 + ${vmArchitecture.edges.length} 条可见线，无一条落空）——旧口径下「端点解析落空」正是 edges=0 的根因`,
  );
  ok(
    vmArchitecture.intra_relations.some(
      (e) => e.id === "plan:cap:01>plan:mod:02-01:design_interface" && e.group_key === "plan:cap:01",
    ) &&
      vmArchitecture.intra_relations.some(
        (e) => e.id === "plan:cap:02>plan:mod:02-02:design_interface" && e.group_key === "plan:cap:02",
      ),
    "V09-02 正断言：两条 design_interface 逐条如实列为**归属能力自己的**同组关系（新口径把归属声明本身判为同组 ⇒ 它不可能再变成跨组线；跨组关系线的正例见下面的局部夹具变体）",
  );
  // 局部夹具变体（2026-09-26 新增）：跨组关系线仍画得出 + 真无归属模块仍如实成组（declared 映射不派生归属）
  const crossGroupBp = fixtureBlueprint({
    nodes: [
      ...bp.nodes,
      node("plan:mod:02-03", "module", "跨组模块"),
      node("plan:code:src-loose", "module", "src-loose"),
    ],
    edges: [
      ...bp.edges,
      // mod:02-03 只归 cap:02；T-1 归 cap:01 ⇒ 两端无共同分组 ⇒ 如实画跨组线
      edge("plan:cap:02", "plan:mod:02-03", "design_interface"),
      edge("plan:task:T-1", "plan:mod:02-03", "implementation_map", "observed"),
      // 靶点确实无归属：declared 的实现映射**不**产生派生归属 ⇒ src-loose 仍落 ungrouped:<模块 id>
      edge("plan:task:T-2", "plan:code:src-loose", "implementation_map", "declared"),
    ],
  });
  const vmCross = buildViewModel({ view: "architecture", blueprint: crossGroupBp, projection, mergedNodes });
  const crossIds = new Set(vmCross.nodes.map((n) => n.id));
  const looseGroup = vmCross.nodes.find((n) => n.id === "ungrouped:plan:code:src-loose");
  ok(
    vmCross.edges.some((e) => e.id === "plan:cap:01>plan:cap:02:implementation_map"),
    `V09-02 正断言：跨组关系线仍画得出（T-1 归 cap:01、靶点 mod:02-03 只归 cap:02 ⇒ 两端无共同分组 ⇒ cap:01 → cap:02；变体实得 ${vmCross.edges.map((e) => e.id).join("、")}）`,
  );
  ok(
    vmCross.edges.some((e) => e.id === "plan:cap:02>ungrouped:plan:code:src-loose:implementation_map") &&
      looseGroup !== undefined &&
      looseGroup.label.includes("未归属能力") &&
      looseGroup.members.join(",") === "plan:code:src-loose",
    `V09-02 正断言：实现映射的靶点**确实**没有能力归属时（declared 映射不派生归属），仍解析到它自己的分组节点 \`ungrouped:<模块 id>\`（${looseGroup?.label ?? "缺"}；成员 ${looseGroup?.members.join("、") ?? "缺"}——成员是模块自己，不改名冒充能力）`,
  );
  ok(
    vmCross.edges.every((e) => crossIds.has(e.from) && crossIds.has(e.to)) &&
      !vmCross.edges.some((e) => e.from === e.to),
    "V09-02 反断言：出现跨组线的那个变体里同样没有悬空线、没有自环（同组内关系不靠自环冒充）",
  );
  ok(
    vmArchitecture.edges.every((e) => archIds.has(e.from) && archIds.has(e.to)) &&
      !vmArchitecture.edges.some((e) => e.from === e.to),
    "V09-02 反断言：架构视图既没有悬空线，也没有自环（同组内关系不靠自环冒充）",
  );
  ok(
    vmArchitecture.notes.some(
      (n) => n.includes("同组内关系不在本视图画出") && n.includes(`本次 ${vmArchitecture.intra_relations.length} 条`),
    ),
    `V09-02 反断言：同组内关系如实写进口径句并给出条数（${vmArchitecture.intra_relations.length} 条＝画布上逐条列出的同组关系数：cap:01/cap:02 的 3 条 design_interface 与 T-1/T-2 的 2 条实现映射）`,
  );
  // 反断言夹具：实现映射的靶点换成**来源任务自己那组**的模块 ⇒ 端点解析到同一分组节点 ⇒ 不画自环
  const sameGroupBp = fixtureBlueprint({
    edges: [...bp.edges, edge("plan:task:T-1", "plan:mod:02-01", "implementation_map", "observed")],
  });
  const vmSameGroup = buildViewModel({ view: "architecture", blueprint: sameGroupBp, projection, mergedNodes });
  const sameIds = new Set(vmSameGroup.nodes.map((n) => n.id));
  ok(
    !vmSameGroup.edges.some((e) => e.from === e.to) &&
      vmSameGroup.edges.every((e) => sameIds.has(e.from) && sameIds.has(e.to)) &&
      vmSameGroup.edges.length === vmArchitecture.edges.length &&
      vmSameGroup.intra_relations.length === vmArchitecture.intra_relations.length + 1 &&
      vmSameGroup.notes.some((n) => n.includes("同组内关系不在本视图画出") && n.includes(`本次 ${vmSameGroup.intra_relations.length} 条`)),
    `V09-02 反断言：靶点与来源任务同一分组（T-1 与 mod:02-01 都归 cap:01）⇒ 不画自环、不造悬空线、线数不虚增（仍 ${vmSameGroup.edges.length} 条），同组条数如实 ${vmArchitecture.intra_relations.length}→${vmSameGroup.intra_relations.length}`,
  );
}
const multiPrereq = vmConstruction.edges.filter((e) => e.semantics === "dependency" && e.to === "plan:task:T-3");
ok(
  multiPrereq.length === 2,
  `施工依赖**允许多个前置**：T-3 有 ${multiPrereq.length} 条入边（${multiPrereq.map((e) => e.from).join("、")}）——不转成母子树（§3.3）`,
);
ok(
  vmConstruction.edges.every((e) => e.kind !== "model_inference"),
  "施工依赖视图不含模型推断线（只取本视图声明的关系 kind）",
);
const dependencyEdge = vmConstruction.edges.find((e) => e.semantics === "dependency" && e.to === "plan:task:T-2");
ok(
  dependencyEdge !== undefined && dependencyEdge.status === "pending_verification",
  `依赖线的状态来自投影对象 \`T-1->T-2\`（${dependencyEdge?.status}；前置已交未释放 → 橙）`,
);
const integrationEdge = vmConstruction.edges.find((e) => e.semantics === "integration");
ok(
  integrationEdge !== undefined && integrationEdge.status === null && integrationEdge.status_projection === null,
  `集成线的状态恒为 null（不拿端点色冒充连线色：${integrationEdge?.note.slice(0, 18)}…）`,
);
ok(
  vmConstruction.edges
    .filter((e) => e.semantics === "integration")
    .every((e) => e.note.includes("端点")),
  "集成线的口径句写清「两个端点绿不代表连线绿」",
);
for (const [name, vm] of [
  ["功能全景", vmFunctional],
  ["系统架构", vmArchitecture],
  ["施工依赖", vmConstruction],
] as const) {
  const ids = new Set(vm.nodes.map((n) => n.id));
  ok(
    vm.edges.every((e) => ids.has(e.from) && ids.has(e.to)),
    `${name}：没有悬空线（${vm.edges.length} 条线的两端都在本次节点集合里）`,
  );
}
ok(
  technicalIdOf("plan:code:src-base", mergedNodes) === "src-base" &&
    technicalIdOf("plan:task:T-1", mergedNodes) === null &&
    technicalIdOf("plan:cap:01", mergedNodes) === null,
  "跨视图定位的稳定 ID 口径：实测模块能对上 module_id，任务/能力在技术详情里如实「无对应」",
);
ok(objectIdOf("plan:task:T-1", "task") === "T-1" && objectIdOf("plan:code:src-base", "module") === "module:src-base", "蓝图节点 id → 状态投影对象 id 的映射口径固定");

section("③ 跨视图定位与返回位置（稳定 ID，不靠显示名）");
const locateReq: LocateRequest = { id: "src-base", label: "记录地基", to: "DATA_FLOW", from: "MODULE_BOX", nonce: 1 };
ok(
  matchedNote(locateReq).includes("src-base") && matchedNote(locateReq).includes("module_id 对齐"),
  `命中提示带稳定 ID（${matchedNote(locateReq)}）`,
);
ok(
  unmatchedNote(locateReq, "共用层没有它").includes("该节点在数据流向图无对应") &&
    unmatchedNote(locateReq, "共用层没有它").includes("src-base"),
  "未命中明说「在哪个视图无对应」并带上对齐用的 id",
);
const bmA = { view: "functional" as const, node_id: "plan:cap:01", filter_kind: "all", query: "" };
const bmB = { view: "construction" as const, node_id: "plan:task:T-1", filter_kind: "problem", query: "" };
const stack = pushBookmark(pushBookmark([], bmA), bmB);
ok(
  stack.length === 2 && stack[0].view === "construction" && stack[1].view === "functional",
  "位置栈最新在前（施工依赖 → 功能全景）",
);
ok(pushBookmark(stack, bmA).length === 2, "压栈去重：再记同一条位置不涨栈");
ok(
  previousBookmark(stack, bmB)?.view === "functional" && previousBookmark(stack, bmB)?.node_id === "plan:cap:01",
  "「返回上次位置」跳过与当前位置相同的那条，回到更早的「功能全景 · plan:cap:01」",
);
ok(
  previousBookmark(stack, { view: "construction", node_id: null, filter_kind: "all", query: "" })?.view === "construction",
  "当前位置与栈顶不同时按栈顶算（如实回最近一条）",
);
ok(previousBookmark([bmA], bmA) === null, "只有当前位置时如实返回 null（不假装跳了一下）");

// ══════════════════════════════ ④ 数量口径（§3.3 第一段） ══════════════════════════════

section("④ 概览数量：5–15、不足 5 不补假节点、超量聚合显示隐藏数量");
ok(OVERVIEW_MIN === 5 && OVERVIEW_MAX === 15, "概览区间常量 = 5–15（§3.3）");
const three = capOverview([{ id: "a" }, { id: "b" }, { id: "c" }], { unit: "分组" });
ok(
  three.shown.length === 3 && three.aggregate === null && three.padded === false && three.note.includes("不补假节点"),
  `不足 5 个：显示 ${three.shown.length} 个、**不补假节点**（padded=false）、说明写明「${three.note.slice(0, 24)}…」`,
);
const seven = capOverview(new Array(7).fill(0).map((_, i) => ({ id: `g${i}` })), { unit: "分组" });
ok(seven.shown.length === 7 && seven.aggregate === null && seven.note.includes("落在概览区间"), "5–15 之间：不聚合、原样显示");
const eighteen = capOverview(new Array(18).fill(0).map((_, i) => ({ id: `g${i}` })), { unit: "分组" });
ok(
  eighteen.shown.length === 15 && eighteen.hidden_count === 3 && eighteen.aggregate?.count === 3,
  `超量：显示前 ${eighteen.shown.length} 个、聚合 ${eighteen.hidden_count} 个`,
);
ok(
  eighteen.aggregate?.label.includes("3") === true,
  `聚合节点**把隐藏数量显示出来**（「${eighteen.aggregate?.label}」）`,
);
const bp18 = fixtureBlueprint({
  nodes: [
    ...new Array(18).fill(0).map((_, i) => node(`plan:cap:${String(i + 1).padStart(2, "0")}`, "capability", `能力 ${i + 1}`)),
    node("plan:task:T-1", "task", "T-1 任务", "T-1"),
  ],
  edges: [],
});
const vm18 = buildViewModel({ view: "functional", blueprint: bp18, projection, mergedNodes });
ok(
  vm18.nodes.filter((n) => n.aggregate !== true).length === 15 && vm18.aggregate_node !== null,
  `视图级超量：18 个能力 → 画布 ${vm18.nodes.filter((n) => n.aggregate !== true).length} 个分组 + 1 个聚合节点`,
);
ok(
  vm18.aggregate_node?.hidden_members === 0 && (vm18.aggregate_node?.label.includes("3") ?? false),
  `聚合节点明确说出隐藏了 3 个分组（「${vm18.aggregate_node?.label}」）`,
);
const bp4 = fixtureBlueprint();
const vm4 = buildViewModel({ view: "functional", blueprint: bp4, projection, mergedNodes });
ok(
  vm4.nodes.length === 4 && vm4.aggregate_node === null && vm4.overview.note.includes("不补假节点"),
  `夹具的 4 个能力：画布 4 个节点、无聚合节点、说明写明不补假节点（§3.3）`,
);

// ══════════════════════════════ ⑤ 筛选 / 搜索 / 当前范围 ══════════════════════════════

section("⑤ 筛选与当前范围（§3.3：过滤后显示范围，不许呈现「全项目已完成」）");
const allProblem = vmConstruction.nodes.filter((n) => n.endpoint !== true);
const filteredProblem = applyViewFilter(vmConstruction.nodes, { kind: "problem", query: "" }, vmConstruction.edges);
const problemMain = filteredProblem.nodes.filter((n) => n.endpoint !== true);
const problemEndpoints = filteredProblem.nodes.filter((n) => n.endpoint === true);
ok(
  problemMain.length === 2 &&
    problemMain.every((n) => n.id === "plan:task:T-1" || n.id === "plan:task:T-3"),
  `只看问题：主体留下 ${problemMain.map((n) => n.id).join("、")}（T-1 橙、T-3 红；T-2 蓝正在做不算问题）`,
);
ok(
  problemEndpoints.every((n) => vmConstruction.edges.some((e) => (e.from === n.id && problemMain.some((m) => m.id === e.to)) || (e.to === n.id && problemMain.some((m) => m.id === e.from)))),
  `被留下列的关系端点一起留着（${problemEndpoints.map((n) => n.id).join("、") || "无"}）：不留悬空线`,
);
const scoped = scopeReportOf(vmConstruction.nodes, { kind: "problem", query: "" }, filteredProblem.nodes);
ok(
  scoped.total === 4 && scoped.shown === 2 && scoped.hidden === 2 && scoped.hidden_unfinished === 1,
  `范围口径：显示 ${scoped.shown} / 共 ${scoped.total}，隐藏 ${scoped.hidden} 个（其中 ${scoped.hidden_unfinished} 个不是绿、1 个是绿的 T-4）`,
);
ok(
  scoped.note.includes("其中 1 个") && scoped.note.includes("不是**「验证已通过」"),
  `范围说明点出隐藏里的未完成数量（不是「隐藏的都完成了」）：${scoped.note.slice(scoped.note.indexOf("隐藏了"))}`,
);
ok(
  scoped.note.includes("隐藏不等于已完成") && scoped.note.includes("不是全项目都通过了"),
  `范围说明**明说隐藏不等于完成**（「${scoped.note.slice(scoped.note.indexOf("隐藏了"))}」）`,
);
const filteredQuery = applyViewFilter(vmConstruction.nodes, { kind: "all", query: "T-3" }, vmConstruction.edges);
ok(
  filteredQuery.nodes.some((n) => n.id === "plan:task:T-3") && !filteredQuery.nodes.some((n) => n.id === "plan:task:T-2"),
  `搜索按稳定 ID 匹配（T-3 命中，T-2 不命中）`,
);
const noMatch = emptyStateOf({
  loading: false,
  error: null,
  blueprint_exists: true,
  node_total: vmConstruction.nodes.length,
  node_shown: applyViewFilter(vmConstruction.nodes, { kind: "all", query: "zzz" }, vmConstruction.edges).nodes.length,
});
ok(noMatch.state === "no_match" && noMatch.title.includes("无匹配"), `搜不到时是**无匹配**（「${noMatch.title}」），不是"没有规划"`);
ok(allProblem.length === 4, `施工依赖的主体任务共 ${allProblem.length} 个（T-1..T-4）`);

// ══════════════════════════════ ⑥ 四种说明分开 + 图新鲜度 ══════════════════════════════

section("⑥ 四种说明分开（§3.3 末段）");
const stLoading = emptyStateOf({ loading: true, error: null, blueprint_exists: false, node_total: 0, node_shown: 0 });
const stFailed = emptyStateOf({ loading: false, error: "GET arch/blueprint -> 500", blueprint_exists: false, node_total: 0, node_shown: 0 });
const stNoPlan = emptyStateOf({ loading: false, error: null, blueprint_exists: false, node_total: 0, node_shown: 0 });
const stNoMatch = emptyStateOf({ loading: false, error: null, blueprint_exists: true, node_total: 4, node_shown: 0 });
const stReady = emptyStateOf({ loading: false, error: null, blueprint_exists: true, node_total: 4, node_shown: 4 });
ok(
  new Set([stLoading.state, stFailed.state, stNoPlan.state, stNoMatch.state, stReady.state]).size === 5,
  `五种状态互不相同：${[stLoading, stFailed, stNoPlan, stNoMatch, stReady].map((s) => s.state).join(" / ")}`,
);
ok(
  stFailed.state === "load_failed" && stFailed.title.includes("不是") && stFailed.retryable === true,
  `加载失败有独立文案与重试出口（「${stFailed.title}」）`,
);
ok(
  stNoPlan.state === "no_plan" && stNoPlan.title.includes("没有已发布的规划图") && stNoPlan.retryable === false,
  `无规划有独立文案且不提示重试（「${stNoPlan.title}」）`,
);
ok(stNoMatch.title.includes("不是没有规划"), "无匹配与无规划**分开**（无匹配的文案显式排除「没有规划」）");
ok(stFailed.title !== stNoPlan.title && stNoPlan.title !== stNoMatch.title, "三份说明的文案互不相同（用户分得清）");

section("⑥ 图正在更新 / 图已过期（§3.3 末段 / §4.4）");
// 可比基准：设计书 = 蓝图 based_on 的内容哈希；施工图 = **定义哈希**（V09-07 / 附录 E.8-7 口径统一：
// revisions.plan_definition vs bp.based_on.plan_definition_sha256；只改状态列/勾选位不判过期）
const BASELINE = { baseline_id: "bl-fixture", design_revision: "design-v1", plan_revision: "plan-v1", plan_definition: "plan-v1" };
const fresh = freshnessOf({ blueprint: bp, receipt: null, revisions: { design: "design-v1", plan: "plan-v1" }, baseline: BASELINE });
ok(fresh.state === "fresh" && fresh.banners.length === 0 && fresh.keep_last_valid === false, "源没变、无派生回执 → 无提示");
const stale = freshnessOf({ blueprint: bp, receipt: null, revisions: { design: "design-v2", plan: "plan-v1" }, baseline: BASELINE });
ok(
  stale.state === "stale" && stale.banners[0].includes("图已过期") && stale.keep_last_valid === true,
  `设计书更新后 → **图已过期**且继续显示上次有效图（「${stale.banners[0].slice(0, 20)}…」）`,
);
// V09-07（E.8-7）：只改 PLAN 状态列/勾选位 = 内容哈希变、定义哈希不变 ⇒ **不**判过期
//（旧口径比内容哈希会误判；此处钉住新口径的反面）
const contentOnly = freshnessOf({ blueprint: bp, receipt: null, revisions: { design: "design-v1", plan: "plan-v2", plan_definition: "plan-v1" }, baseline: BASELINE });
ok(
  contentOnly.state === "fresh" && contentOnly.banners.length === 0,
  "只改 PLAN 非定义区（状态列/勾选位）→ 不判过期（E.8-7：施工图侧比定义哈希）",
);
const stalePlan = freshnessOf({ blueprint: bp, receipt: null, revisions: { design: "design-v1", plan: "plan-v2", plan_definition: "plan-v2" }, baseline: BASELINE });
ok(
  stalePlan.state === "stale" && stalePlan.banners[0].includes("施工图"),
  `施工图定义区改了（plan_definition 与本图派生绑定的不一致）判过期：${stalePlan.banners[0].slice(0, 24)}…`,
);
ok(
  freshnessOf({ blueprint: bp, receipt: null, revisions: { design: "design-v1", plan: "plan-v1" }, baseline: null }).state === "fresh",
  "拿不到生效基线/定义哈希时不硬判施工图过期（不猜）",
);
const updating = freshnessOf({
  blueprint: bp,
  receipt: { attempted_at: "2026-09-20T11:00:00+08:00", cache_key: "fk2", published: false, kept_previous: true },
  revisions: { design: "design-v1", plan: "plan-v1" },
  baseline: BASELINE,
});
ok(
  updating.state === "updating" && updating.banners[0].includes("图正在更新") && updating.keep_last_valid === true,
  `最近一次派生尝试没成功 → **图正在更新**（「${updating.banners[0].slice(0, 24)}…」）`,
);
const both = freshnessOf({
  blueprint: bp,
  receipt: { attempted_at: "2026-09-20T11:00:00+08:00", cache_key: "fk2", published: false, kept_previous: true },
  revisions: { design: "design-v2", plan: "plan-v1" },
  baseline: BASELINE,
});
ok(both.banners.length === 2 && both.state === "stale", "两种提示可以同时成立（源变了 + 有未就位的派生尝试），互不吞掉");
ok(
  both.banners.every((b) => b.includes("继续显示上次有效图") || b.includes("不自动跳回全局")),
  "两条提示都写明「继续显示上次有效图 / 不自动跳回全局」（§3.3 / §4.4）",
);

// ══════════════════════════════ ⑦ 详情五段（§3.2） ══════════════════════════════

section("⑦ 详情五段：作用 → 当前情况与原因 → 设计/施工出处 → 验证结果 → 技术资料");
ok(
  DETAIL_SECTION_TITLES.map((s) => s.title).join("→") === "它的作用→当前情况与原因→设计/施工出处→验证结果→技术资料",
  "五段的段名与顺序逐字对齐 §3.2",
);
const t1Node = vmConstruction.nodes.find((n) => n.id === "plan:task:T-1")!;
const sections = detailSectionsOf({
  node: t1Node,
  blueprint: bp,
  view_notes: vmConstruction.notes,
  received_at: "2026-09-20T12:00:00+08:00",
  merged_nodes: mergedNodes,
});
ok(
  sections.length === 5 && sections.map((s) => s.key).join(",") === "role,situation,origin,verification,tech",
  `详情恰好五段且顺序固定（${sections.map((s) => s.title).join(" → ")}）`,
);
const situation = sections[1].lines.join("\n");
ok(
  situation.includes("结果待验证") && situation.includes("橙：结果待验证"),
  "第②段给出状态（短标签 + 完整口径句；原始六态键由浏览器段在 data 属性上断言）",
);
ok(
  situation.includes("原因 [") && situation.includes("必需/通过/缺口：2 / 1 / 1"),
  "第②段带**原因**与 required/passed/missing 计数（都来自投影）",
);
ok(
  situation.includes("来源时间：图生成") && situation.includes("本次读取"),
  `第②段带**来源时间**（图生成 / 校验 / 本次读取：${situation.split("\n").find((l) => l.startsWith("来源时间"))?.slice(0, 40)}…）`,
);
ok(
  situation.includes("来源修订：plan-v1"),
  "第②段带投影绑定的**来源修订**（复核基准）",
);
ok(
  sections[2].lines.some((l) => l.includes("施工卡") && l.includes("T-1")) && sections[2].lines.some((l) => l.includes("基线")),
  "第③段给出设计/施工出处（卡号 + 引用时哈希 + 基线/派生器）",
);
const verification = sections[3].lines.join("\n");
ok(
  verification.includes("验证范围（通过项）") && verification.includes("缺口：") && verification.includes("人工验收"),
  "第④段分开列通过范围 / 缺口 / 人工验收（不拿「结果已交」当「验证通过」）",
);
ok(
  verification.includes("缺口：T-1::evidence") && verification.includes("没有任何检查记录"),
  `第④段的缺口点名到 check_id 并给出原因（${verification.split("\n").find((l) => l.startsWith("缺口："))?.slice(0, 46)}…）`,
);
ok(
  sections[4].lines.some((l) => l.includes("技术详情对应 id")) || sections[4].lines.some((l) => l.includes("没有对应节点")),
  "第⑤段给出技术资料（技术详情对应 id / 实测模块出处）",
);
const unmappedNode =
  [...vmArchitecture.nodes, ...vmFunctional.nodes].find(
    (n) => n.status.display === null && n.status.unmapped_reason !== undefined,
  ) ?? vmFunctional.nodes[0];
const unmappedSections = detailSectionsOf({ node: unmappedNode, blueprint: bp, view_notes: vmFunctional.notes });
// V08-02 C1 定向更新（判据**收紧**，未放宽）：「未映射」原来是一刀切文案，
// 现在按真实原因分开说（本视图暂无状态来源／对象未映射／没有关联成员／成员都没有状态结论／无状态记录）。
// 期望从"必须出现「未映射」四个字"改为"display 必须为 null + reason 必须是显式枚举 + 文案名字对得上"。
{
  const unmappedText = unmappedSections[1].lines.join(String.fromCharCode(10));
  const textNamesCause =
    unmappedText.includes("未映射") ||
    unmappedText.includes("暂无状态来源") ||
    unmappedText.includes("没有关联成员") ||
    unmappedText.includes("成员都没有状态结论") ||
    unmappedText.includes("无状态记录");
  ok(
    unmappedNode.status.display === null && unmappedNode.status.unmapped_reason !== undefined && textNamesCause,
    `没有投影结论的节点在详情里如实说清原因、且不着完成色（不空集判绿，§4.2）：${unmappedNode.id}（reason=${unmappedNode.status.unmapped_reason}）`,
  );
}
ok(
  unmappedSections[3].lines.join("\n").includes("没有这个对象的状态投影"),
  "没有投影时第④段明说「没有验证结论可展示」，不拿空集当通过",
);

section("⑦ 汇总口径：能力节点永不汇总成绿（fail-closed）");
const allGreen = [
  { ...projection["T-4"], object_id: "x1", display_status: "verified" as const, mapping: "mapped" as const },
  { ...projection["T-4"], object_id: "x2", display_status: "verified" as const, mapping: "mapped" as const },
];
const agg = aggregateStatusOf(allGreen);
ok(
  agg.display === "pending_verification" && agg.basis.includes("不给绿"),
  `成员全绿时汇总**封顶在橙**并说明理由（${agg.display}）——父级没有自身集成证据就不判绿（§4.2）`,
);
const aggEmpty = aggregateStatusOf([]);
ok(aggEmpty.kind === "unmapped" && aggEmpty.display === null, "没有任何成员 → 未映射、不着完成色（不空集判绿）");
const aggMixed = aggregateStatusOf([
  { ...projection["T-2"], object_id: "y1", display_status: "in_progress" as const },
  { ...projection["T-3"], object_id: "y2", display_status: "blocked" as const },
]);
ok(aggMixed.display === "blocked", "混合状态取优先级最高（阻塞 > 进行中，§4.2 优先级序）");

// ══════════════════════════════ ⑧ 布局增量（§3.3 不跳动） ══════════════════════════════

section("⑧ 布局增量更新不跳动（§3.3 / §4.4）");
const beforeNodes = ["plan:task:T-1", "plan:task:T-2"].map((id) => ({ id }));
const beforeEdges = [{ from: "plan:task:T-1", to: "plan:task:T-2" }];
const first = mergeIncrementalLayout({ prev: {}, nodes: beforeNodes, edges: beforeEdges });
ok(first.placed.length === 2 && Object.keys(first.positions).length === 2, "首帧：两个节点都算「新落位」");
const afterNodes = ["plan:task:T-1", "plan:task:T-2", "plan:task:T-3"].map((id) => ({ id }));
const afterEdges = [
  { from: "plan:task:T-1", to: "plan:task:T-2" },
  { from: "plan:task:T-2", to: "plan:task:T-3" },
];
const second = mergeIncrementalLayout({ prev: first.positions, nodes: afterNodes, edges: afterEdges });
ok(
  second.kept.join(",") === "plan:task:T-1,plan:task:T-2" &&
    second.positions["plan:task:T-1"].x === first.positions["plan:task:T-1"].x &&
    second.positions["plan:task:T-1"].y === first.positions["plan:task:T-1"].y &&
    second.positions["plan:task:T-2"].x === first.positions["plan:task:T-2"].x,
  "源更新后**已有节点坐标逐字节保留**（kept=[T-1,T-2]，一点没跳）",
);
ok(
  second.placed.join(",") === "plan:task:T-3" && Number.isFinite(second.positions["plan:task:T-3"].x),
  "新节点**局部安放**（只算它一个的坐标）",
);
ok(
  second.positions["plan:task:T-3"].x > second.positions["plan:task:T-2"].x,
  "新节点落在它的邻居右侧（父→子方向上接着排，不压回全图重排）",
);
const cache = new Map<string, string>();
for (let i = 0; i < 5; i++) {
  const again = mergeIncrementalLayout({ prev: first.positions, nodes: afterNodes, edges: beforeEdges });
  cache.set(`run${i}`, JSON.stringify(again.positions));
}
ok(new Set(cache.values()).size === 1, "同一输入必得同一份坐标（重渲染稳定，不抖）");
const thirdMerge = mergeIncrementalLayout({ prev: second.positions, nodes: [afterNodes[0]], edges: [] });
ok(
  thirdMerge.dropped.join(",") === "plan:task:T-2,plan:task:T-3" && Object.keys(thirdMerge.positions).length === 1,
  "消失的节点不留坐标（免得它回来时「跳回旧位」）",
);
const gridNodes = new Array(9).fill(0).map((_, i) => ({ id: `g${i}` }));
const grid = mergeIncrementalLayout({ prev: {}, nodes: gridNodes, edges: [] });
const gridXs = new Set(Object.values(grid.positions).map((p) => p.x));
const gridYs = new Set(Object.values(grid.positions).map((p) => p.y));
ok(
  gridXs.size === 3 && gridYs.size === 3,
  `零关系时排成网格（9 个节点 → ${gridXs.size} 列 × ${gridYs.size} 行）——dagre 的零边并排会叠成一根竖列，读不了`,
);
const positionsSet = new Set(Object.values(second.positions).map((p) => `${p.x},${p.y}`));
ok(positionsSet.size === Object.keys(second.positions).length, "新节点不与已有节点叠在同一个坐标上");
ok(weightToStrokeWidth(3, 3) === 6 && weightToStrokeWidth(1, 3) === 1, "A3 的权重→粗细口径未动（共用画布回归不受影响）");

// ══════════════════════════════ ⑨ 源码级护栏（接线与红线） ══════════════════════════════

section("⑨ 源码级护栏");
const projectViewSrc = readFile("src/ui/arch/ProjectGraphView.tsx");
const archCanvasSrc = readFile("src/ui/arch/ArchCanvas.tsx");
const archViewSrc = readFile("src/ui/components/ArchView.tsx");
const apiSrc = readFile("src/ui/api.ts");
const remoteRoutesSrc = readFile("src/server/remote-routes.ts");
ok(
  /getArchBlueprint/.test(projectViewSrc) && /getStatusProjection/.test(projectViewSrc),
  "主视图只吃两条已交付的只读口（arch/blueprint + status-projection）",
);
ok(
  !/method:\s*["'](POST|PUT|DELETE)["']/.test(projectViewSrc) &&
    !/putArch|postArch|postGate|postDesign|postDiscuss|clearTerminal/.test(projectViewSrc),
  "主视图**没有任何写口**（不提供涂色/改状态入口，§4.2）",
);
ok(
  /data-project-status/.test(projectViewSrc) && /displayStatusStyle/.test(projectViewSrc),
  "主视图的节点色只经 `displayStatusStyle`（六态唯一出处），不手写色值",
);
ok(
  !/#(34d399|f87171|fb923c|60a5fa)/.test(projectViewSrc),
  "主视图里**没有任何完成色**的硬编码色值（颜色只在 statusColor.ts 一处取）",
);
ok(
  /statusOverride/.test(archCanvasSrc) && /graphOverride/.test(archCanvasSrc) && /onNodeClick/.test(archCanvasSrc),
  "共用画布接上了规划层与投影（三个**可选**入口：graphOverride / statusOverride / onNodeClick）",
);
// V09-13 定向更新（判据**未放宽**：同一条判据从"全文连注释一起扫"收回到"只扫代码本体"）。
//   旧期望 = 第三条 `!/技术详情/.test(archCanvasSrc)`——要求 ArchCanvas 源码里一个词都不出现「技术详情」，
//            以此证明「详情页的页签/引导态托管在 ArchView，共用画布不背书详情页语义」。
//   依据   = V09-13 给详情页追加第 6 段「来源与证据」时，ArchCanvas 新增了 `showDeliveryReadout` 的
//            **JSDoc 说明注释**（`src/ui/arch/ArchCanvas.tsx:466-471`：「缺省 true（技术详情三图的既有行为
//            逐字不变）」）——命中的是**注释散文，不是代码**；同批浏览器侧已定向更新
//            （`scripts/verify-v06-06-ui.py:563-567` 的 ② 段允许第 6 段 provenance）。
//   新期望 = 剥去注释后再查（`stripComments`）：**代码本体**里仍不得出现「技术详情」；另两条锚点
//            （ArchCanvas 的 `getArchRender` 自拉旧路径、ArchView 的 `mode === "MIND_MAP" ? "MODULE_BOX" : mode`
//            托管口径）**逐字不动**。
//   保留意图 = 「详情页页签/引导态托管在 ArchView，共用画布只当画布」——注释里提到某个名词不等于代码实现了它；
//              判据不放宽，只是不再把说明注释里的名词当作行为证据。
ok(
  /getArchRender/.test(archCanvasSrc) &&
    !/技术详情/.test(stripComments(archCanvasSrc)) &&
    /mode === "MIND_MAP" \? "MODULE_BOX" : mode/.test(archViewSrc),
  "技术详情的旧解析路径逐字保留（ArchCanvas 的 getArchRender 与画布托管口径仍在 ArchView）",
);
ok(
  /MODULE_BOX/.test(archViewSrc) && /DATA_FLOW/.test(archViewSrc) && /MIND_MAP/.test(archViewSrc),
  "技术详情里三种旧渲染仍在页签容器里（一个字都没删）",
);
ok(
  /MindMapView/.test(archViewSrc) && /ArchCanvas/.test(archViewSrc),
  "旧画布与思维导图组件仍被引用（没被主视图顶掉）",
);
ok(
  /data-graph-mode=\{m\}/.test(archViewSrc),
  "旧的三视图切换按钮仍在（data-graph-mode，既有脚本的锚点）",
);
ok(
  /arch-blueprint-read/.test(remoteRoutesSrc) && /work-status-projection/.test(remoteRoutesSrc),
  "两条读口都在路由清单里登记（本卡没新增路由，也没漏登记）",
);
ok(
  /export async function getArchBlueprint|export async function getArchBlueprint/.test(apiSrc) &&
    /export async function getStatusProjection/.test(apiSrc),
  "api.ts 的取数函数与后端读口一一对应",
);
const pkg = JSON.parse(readFile("package.json")) as { scripts: Record<string, string> };
ok(
  pkg.scripts["verify:v06-06"] === "tsx scripts/verify-v06-06.ts" &&
    pkg.scripts["verify:v06-06-ui"] === "python scripts/verify-v06-06-ui.py",
  "package.json 登记了两个验证脚本（verify:v06-06 / verify:v06-06-ui）",
);
ok(fs.existsSync(path.join(REPO, "scripts/verify-v06-06-ui.py")), "浏览器场景脚本在场（Python + Playwright）");
const uiPy = readFile("scripts/verify-v06-06-ui.py");
ok(
  /playwright\.sync_api/.test(uiPy) && /TATAI_HOME/.test(uiPy) && /tempfile|tmpdir/.test(uiPy),
  "浏览器脚本自带隔离环境（playwright + 临时 TATAI_HOME 夹具）",
);
ok(
  !/Github 资料|大黄蜂|货架参谋/.test(uiPy + projectViewSrc + archViewSrc),
  "新代码/脚本不碰三个真实项目的路径",
);

// ══════════════════════════════ ⑩ 收尾：首尾哈希对照 ══════════════════════════════

section("⑩ 收尾：受保护文档与既有脚本首尾 sha256 对照（零改动）");
const endDocs = hashTable([...PROTECTED_DOCS, ...VICTIM_SCRIPTS]);
const endAppendix = crypto.createHash("sha256").update(appendixBRegion()).digest("hex");
const changed = Object.keys(endDocs).filter((f) => endDocs[f] !== startDocs[f]);
ok(changed.length === 0, `受保护清单 ${Object.keys(endDocs).length} 个文件首尾哈希全等（改动的：${changed.join("、") || "无"}）`);
ok(endAppendix === startAppendix, `DESIGN.md 附录 B 首尾哈希相等（${endAppendix.slice(0, 16)}…）——一个字节都没动`);
console.log("[verify] 受保护清单首尾哈希（贴证据）：");
for (const f of [...PROTECTED_DOCS, ...VICTIM_SCRIPTS]) console.log(`[verify]   ${endDocs[f]}  ${f}`);
console.log(`[verify]   ${endAppendix}  DESIGN.md#附录B`);

const gitStatus = (() => {
  try {
    return execFileSync("git", ["status", "--porcelain"], { cwd: REPO, encoding: "utf8" });
  } catch {
    return "(git 不可用)";
  }
})();
const modifiedLines = gitStatus.split("\n").filter((l) => /^ M /.test(l)).join("\n");
console.log("[verify] 收尾 git status --porcelain（工作区里别人未提交的改动原样保留，本脚本不改 Git 状态）：");
for (const line of gitStatus.split("\n").filter((l) => l.trim() !== "")) console.log(`[verify]   ${line}`);
const v0606Modified = /verify-v06-06\.ts/.test(modifiedLines);
// V09-02b 定向更新（判据**不放宽**，2026-09-26 安装版架构灰块复核落地口径）：下面这条机关要求
// 「被后续卡定向更新时在文件里留下点名留痕」，原实现把留痕串硬编码成 V08-02 C1 一条；
//   旧期望 = 文件里含 "V08-02 C1 定向更新（判据" 这一条留痕串（判据等价于"本文件确实被后续卡点名改过"）。
//   依据   = 本批（V09-02b）按新口径改了 ③ 段的 V09-02 正/反断言，在文件里留下的留痕串是
//            "V09-02b 定向更新（判据"——同为「点名留痕」，只是卡号不同；把判据钉在某一张卡的卡号上
//            会让下一个定向更新的批次无故变红。
//   新期望 = 文件里含 {V08-02 C1, V09-02b} 中**至少一条**同名式留痕串（仍是"文件里必须真的存在后续卡
//            的定向更新留痕"的实质判据，不是恒真式）；两条都在场时也算满足，因为判据要求的是"有留痕"。
//   保留意图 = 本脚本被后续卡改动时，必须在文件里点名留痕（不许悄悄改完不留痕）。
//   判据不放宽 = 仍是"必须存在留痕串"的实质判据，只把可接受集合从 {V08-02 C1} 扩成两条具名留痕
//            （留痕串必须真在文件里；删掉留痕 ⇒ 仍红）。
const v0606Marker = ["V08-02 C1 定向更新（判据", "V09-02b 定向更新（判据"].some((marker) =>
  fs.readFileSync(path.join(REPO, "scripts/verify-v06-06.ts"), "utf8").includes(marker),
);
// V09-07 定向更新（判据对齐本断言自己的文案，未放宽）：文案本就允许「被后续卡定向更新时留点名留痕」，
// 但原代码只给 .ts 留了痕位、.py 没有——V09-01 的写侧新闸（verifies 必填）需要适配 v06-06-ui.py 的
// 夹具写入，按文案原意给 .py 补同一个留痕出口。
const v0606UiModified = /verify-v06-06-ui\.py/.test(modifiedLines);
const v0606UiMarker = fs
  .readFileSync(path.join(REPO, "scripts/verify-v06-06-ui.py"), "utf8")
  .includes("V09-01 定向适配（判据");
ok(
  (!v0606UiModified || v0606UiMarker) && (!v0606Modified || v0606Marker),
  "本卡的两个脚本要么仍是未跟踪新文件，要么（被后续卡定向更新时）在文件里留下点名留痕（本卡交付时两者都是未跟踪新文件）",
);

console.log(`\n[verify] ── 计数：${passCount} PASS / ${failCount} FAIL`);
console.log(failCount === 0 ? "[verify] 全部 PASS" : "[verify] 存在 FAIL");
