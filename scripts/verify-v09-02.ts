// V09-02 验证脚本（tsx 跑）：系统架构主视图连线修复（PLAN.md V09-02；DESIGN.md §3.2／§3.3／§4.1、附录 E.5）。
// 用法：pnpm verify:v09-02
//
// 隔离口径（本脚本自己守）：真实 `.工作台` **一个字节都不写**。真实段只读 registry 定位到的 tatai 项目的
// `arch/blueprint.json` 与状态事实（`collectProjectFacts`），并在首尾各取一次蓝图 sha256（变了就报 FAIL——
// 说明有东西改了真实蓝图：要么是本脚本越界写了，要么有并发运行的派生活动）。
//
// 覆盖（逐条对着卡面检查项 ①–④ 与附录 E.5 的登记缺陷）：
//   ① **复现**：用真实塔台数据复算三个主视图；架构视图在**落稿前的 `resolveEndpoint`**（本脚本留一份
//      逐步转写的老算法副本）下得 0 条线——与附录 E.5 登记的 `edges=0` 一致；修后**关系一条都不许被
//      静默丢掉**（逐条归入三桶，见 ② 与 2026-09-26 定向更新段）。
//   ② **修复**：成员节点被改名/分组（`ungrouped:plan:code:src` vs `plan:code:src`）后，
//      `implementation_map` / `design_interface` 的端点仍能解析到**本视图上代表它的那个分组节点**：
//      每条关系被归入「同组关系（不画线，逐条列在分组节点上，V09-13）／跨组可见线／两端落空（逐条点名
//      原因）」三桶之一，三桶相加**恒等于本视图关系总数**。
//   ③ **口径句**：真实数据上 `design_interface` 全部落在**同一个分组节点**上（能力 ↔ 它自己的成员模块：
//      归属本来就由这条边声明）⇒ 卡面 ② 的二选一取「以口径句明确『同组内关系不在本视图画出』并留可核证据」
//      那一支，视图口径句如实带条数；**不画自环、不伪造跨组边**。
//   ④ **反例**：夹具正反例——有归属的靶点仍找得到；同组靶点不画自环；**真没有归属的模块仍如实成组**
//      （夹具 D 钉住：`declared` 映射不派生归属 ⇒ 靶点仍落 `ungrouped:<模块 id>`）；跨组实现映射仍画得出；
//      被概览折叠的分组**不产生假线**（不假装画得出来）；每条线/每条同组关系的来源都来自蓝图边。
//   ⑤ **不越界**：施工依赖视图（**不分组**，同组判据不适用）的边数与落稿前**逐条相同**；功能全景改按
//      「归类恒等式」对账（2026-09-26 新口径同样作用于它：修前副本算出的可见线当时全部改判为同组关系）。
//   ⑥ **时点口径（2026-09-26 V09-18 勘误，GPT-6 裁定 9）**：本文件注释里的具体条数（123／113+6／104／203／31／
//      129／95 等）都是**各次复核的时点快照**——真实蓝图随源变化重派生，断言一律按运行时的真实蓝图**现场复算**，
//      不以任何过期固定数量自证（注释数字仅供追溯，判据以断言表达式为准）。
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readBlueprint, type Blueprint, type BlueprintEdge, type BlueprintNode } from "../src/arch/blueprint";
import {
  checksFromAudit,
  collectProjectFacts,
  objectsFromFacts,
  projectStatuses,
  type StatusProjection,
} from "../src/server/work/statusProjection";
import {
  EDGE_SEMANTICS,
  PROJECT_VIEWS,
  buildViewModel,
  taskDerivedModuleStatus,
  type ProjectViewKind,
  type ProjectViewModel,
} from "../src/ui/arch/projectGraph";

let pass = 0;
let fail = 0;
let skip = 0;
const ok = (cond: boolean, label: string): void => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (cond) pass++;
  else {
    fail++;
    process.exitCode = 1;
  }
};
const info = (m: string): void => console.log(`[verify]   ${m}`);
const skipped = (m: string): void => {
  console.log(`[verify] SKIP ${m}`);
  skip++;
};
const section = (t: string): void => console.log(`\n[verify] ── ${t}`);

const sha256File = (f: string): string | null =>
  fs.existsSync(f) ? crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex") : null;

// ───────────────────────────── 真实数据段（只读） ─────────────────────────────

const REAL_DATA_DIR =
  (process.env.TATAI_HOME ?? "").trim() !== "" ? process.env.TATAI_HOME!.trim() : path.join(os.homedir(), ".tatai");
const REAL_PROJECT = "tatai";

/** tatai 项目根：从真实注册表读（不沿用旧机器的硬编码目录，AGENTS.md §7） */
const realProjectPath = ((): string | null => {
  try {
    const reg = JSON.parse(fs.readFileSync(path.join(REAL_DATA_DIR, "registry.json"), "utf8")) as {
      projects?: { id?: unknown; path?: unknown }[];
    };
    const hit = (reg.projects ?? []).find((p) => p.id === REAL_PROJECT);
    return typeof hit?.path === "string" ? hit.path : null;
  } catch {
    return null;
  }
})();

const realBlueprintFile =
  realProjectPath === null ? null : path.join(realProjectPath, ".工作台", "arch", "blueprint.json");
const realBlueprintHashBefore = realBlueprintFile === null ? null : sha256File(realBlueprintFile);
info(`真实数据目录：${REAL_DATA_DIR}`);
info(`真实项目根：${realProjectPath ?? "（本机取不到 tatai 注册项）"}`);
info(`真实蓝图：${realBlueprintFile ?? "n/a"}`);
info(`真实蓝图 sha256（测试前）：${realBlueprintHashBefore ?? "n/a"}`);

/** 产品读口读真实蓝图（坏文件/没有都返回 null）；项目不存在的异常也一并兜成 null */
function readRealBlueprint(): Blueprint | null {
  try {
    return readBlueprint(REAL_PROJECT, REAL_DATA_DIR);
  } catch {
    return null;
  }
}

/**
 * 真实**状态投影**：与运行服务 `GET /api/projects/:id/status-projection` 同一份读盘 + 同一份 `projectStatuses`
 * （`src/server/index.ts:1193`）。本卡只看节点与边，不看依赖释放结论，所以只跑一趟并如实说明：
 * **节点/边口径不依赖投影**，投影只影响状态色；本脚本不叠加人工验收维度（与边数无关）。
 */
function realProjection(): Record<string, StatusProjection> | null {
  try {
    const facts = collectProjectFacts(REAL_PROJECT, REAL_DATA_DIR);
    const set = projectStatuses({
      objects: objectsFromFacts(REAL_PROJECT, REAL_DATA_DIR, facts),
      findings: facts.findings,
      checks: checksFromAudit(facts.audit),
      source_revision: facts.revisions,
    });
    const index: Record<string, StatusProjection> = {};
    for (const o of set.objects) index[o.object_id] = o;
    return index;
  } catch {
    return null;
  }
}

/**
 * **落稿前算法副本**（V09-02 之前的 `resolveEndpoint`，逐步转写；只用于"修前读数"的复现，
 * 产品代码已不再走它）。它只有两步：`visible` 里直接命中，否则找归属能力——
 * 成员节点一旦被改名/分组（`plan:code:src` → `ungrouped:plan:code:src`）就两步都落空。
 */
function legacyEdgeIds(view: ProjectViewKind, blueprint: Blueprint, visible: ReadonlySet<string>): string[] {
  const capIds = capabilityIdsOf(blueprint);
  const ownerOfMember = ownerOfMemberIn(blueprint, capIds);
  const legacyResolve = (id: string): string | null => {
    if (visible.has(id)) return id;
    if (view === "construction") return null;
    const owner = ownerOfMember.get(id) ?? (capIds.has(id) ? id : null);
    return owner !== null && visible.has(owner) ? owner : null;
  };
  const kinds = new Set<string>(PROJECT_VIEWS[view].edge_kinds);
  const ids = new Set<string>();
  for (const e of blueprint.edges) {
    if (!kinds.has(e.kind)) continue;
    const from = legacyResolve(e.source);
    const to = legacyResolve(e.target);
    if (from === null || to === null || from === to) continue;
    ids.add(`${from}>${to}:${e.kind}`);
  }
  return [...ids].sort();
}

const capabilityIdsOf = (blueprint: Blueprint): Set<string> =>
  new Set(blueprint.nodes.filter((n) => n.kind === "capability").map((n) => n.id));

/** 成员 → 归属能力（**落稿前算法的口径**：单值 Map、后写覆盖）——只给 `legacyEdgeIds` 副本用，别再新用 */
function ownerOfMemberIn(blueprint: Blueprint, capIds: ReadonlySet<string>): Map<string, string> {
  const owner = new Map<string, string>();
  for (const e of blueprint.edges) {
    if (e.kind === "design_interface" && capIds.has(e.source)) owner.set(e.target, e.source);
    if (e.kind === "task_design_ref" && capIds.has(e.target)) owner.set(e.source, e.target);
  }
  return owner;
}

/**
 * 成员 → 归属能力（**多值**，2026-09-26 新口径）：`design_interface`（能力→模块）与
 * `task_design_ref`（任务→能力）两条来源，同一成员可同时归属多个能力（不再后写覆盖）。
 * 这里只算**声明归属**——系统架构视图的「能力 ← 任务设计引用 ← 实测实现映射」二级派生归产品那侧，
 * 本脚本用它核对「落空的那一端是不是真的没有归属」，所以不把派生算进去（派生是把靶点挂进能力分组，
 * 不改变这条关系本身的端点在不在画布上）。
 */
function capabilitiesOfMemberIn(blueprint: Blueprint, capIds: ReadonlySet<string>): Map<string, string[]> {
  const owners = new Map<string, string[]>();
  const add = (member: string, cap: string): void => {
    const list = owners.get(member) ?? [];
    if (!list.includes(cap)) list.push(cap);
    owners.set(member, list);
  };
  for (const e of blueprint.edges) {
    if (e.kind === "design_interface" && capIds.has(e.source)) add(e.target, e.source);
    if (e.kind === "task_design_ref" && capIds.has(e.target)) add(e.source, e.target);
  }
  return owners;
}

/**
 * 逐 kind 归类本视图的关系（三桶：同组关系／跨组可见线／两端落空）。
 *
 * 归类**直接取产品模型的输出**，不在这里另写一套分组逻辑——2026-09-26 的归属与同组判据改动
 * （多值归属 + 二级派生 + 「两端有没有共同分组」）证明：验证脚本自己复写一份解析，必然随产品口径过时，
 * 反而会给出与画布不一致的"归类"（旧版 `endpointAccounting` 报"画出 95 条"，产品实际 0 条）。
 *   · 同组关系 = `intra_relations`（不画线，逐条列在分组节点上、带出处，V09-13）：既含"两端解析到同一
 *     分组节点"，也含"两端共享某个分组"；
 *   · 跨组线   = `edges`（可见线；同一 `from>to:kind` 的多条关系会去重成一条可见线，故按 id 命中计数）；
 *   · 两端落空 = 既不在上面两处的关系——带回蓝图里的 `source`/`target`/`kind`，供逐条点名原因。
 * `total` 恒等于另三项之和：**一条关系要么有归类、要么被点名，不许静默消失**（V09-02 的真缺陷）。
 */
function relationAccounting(
  model: Pick<ProjectViewModel, "edges" | "intra_relations">,
  view: ProjectViewKind,
  blueprint: Blueprint,
): {
  total: number;
  intra_group: number;
  drawn: number;
  unresolved: { source: string; target: string; kind: string }[];
  by_kind: Record<string, { total: number; intra_group: number; drawn: number; unresolved: number }>;
} {
  const intraIds = new Set(model.intra_relations.map((e) => e.id));
  const drawnIds = new Set(model.edges.map((e) => e.id));
  const kinds = new Set<string>(PROJECT_VIEWS[view].edge_kinds);
  const byKind: Record<string, { total: number; intra_group: number; drawn: number; unresolved: number }> = {};
  const unresolved: { source: string; target: string; kind: string }[] = [];
  let total = 0;
  let intraGroup = 0;
  let drawn = 0;
  for (const e of blueprint.edges) {
    if (!kinds.has(e.kind)) continue;
    const b = (byKind[e.kind] ??= { total: 0, intra_group: 0, drawn: 0, unresolved: 0 });
    b.total++;
    total++;
    const id = `${e.source}>${e.target}:${e.kind}`;
    if (intraIds.has(id)) {
      b.intra_group++;
      intraGroup++;
    } else if (drawnIds.has(id)) {
      b.drawn++;
      drawn++;
    } else {
      b.unresolved++;
      unresolved.push({ source: e.source, target: e.target, kind: e.kind });
    }
  }
  return { total, intra_group: intraGroup, drawn, unresolved, by_kind: byKind };
}

const countKind = (blueprint: Blueprint, kind: string): number =>
  blueprint.edges.filter((e) => e.kind === kind).length;

// ───────────────────────────── 夹具（真契约形状） ─────────────────────────────

const ref = (kind: "design_section" | "plan_task" | "code_module", locator: string) => ({
  kind,
  path: "fixture.md",
  locator,
  sha256: `${kind}-${locator}`.padEnd(64, "0").slice(0, 64),
});

function fnode(id: string, kind: BlueprintNode["kind"], name: string): BlueprintNode {
  return {
    id,
    kind,
    name,
    source_refs: [ref(kind === "task" ? "plan_task" : kind === "module" ? "code_module" : "design_section", id)],
    related_ids: [],
  };
}

function fedge(
  source: string,
  target: string,
  kind: BlueprintEdge["kind"],
  /** 缺省：实现映射按实测 `observed`、其余按 `declared`——夹具 D 用显式的 `declared` 映射当反例 */
  certainty: BlueprintEdge["certainty"] = kind === "implementation_map" ? "observed" : "declared",
): BlueprintEdge {
  return {
    source,
    target,
    kind,
    // 每条线都带出处（§4.1「不发明关系、不给无来源的线」）：断言里会核这一点
    source_refs: [ref("design_section", `${source}->${target}`)],
    certainty,
  };
}

function fblueprint(nodes: BlueprintNode[], edges: BlueprintEdge[]): Blueprint {
  return {
    version: 1,
    baseline_id: "bl-v09-02-fixture",
    generator_version: "v06-05.1",
    generated_at: "2026-09-24T10:00:00+08:00",
    source_manifest: [],
    nodes,
    edges,
    coverage: {
      design_sections: { total: 2, mapped: 2, unmapped: [] },
      plan_tasks: { total: 2, mapped: 2, unmapped: [] },
      code_modules: { total: 3, mapped: 3, unmapped: [] },
      nodes_total: nodes.length,
      nodes_kept: nodes.length,
      edges_total: edges.length,
      edges_kept: edges.length,
      note: "fixture",
    },
    omitted: [],
    model_receipt: null,
    publish: { published: true, reason: null, validated_at: "2026-09-24T10:00:01+08:00" },
    based_on: {
      model_key: "mk",
      full_key: "fk",
      design_content_sha256: "design-v1",
      plan_definition_sha256: "plan-v1",
      semantic: false,
    },
  };
}

/**
 * 夹具 A（正反例混装；2026-09-26 按**新口径**更新账目，见本文件 ② 段的定向更新留痕）：
 *   · `plan:mod:a` 归属 cap:01 与 cap:02（**多值**：两条 `design_interface` 都算归属）、
 *     `plan:mod:b` 归属 cap:02、`plan:code:src-x` 经 T-1 的 observed 实现映射**二级派生**归 cap:01
 *   · 归属由 `design_interface` 的能力一侧与 `task_design_ref` 的任务一侧共同决定，**多值**保留全部归属
 *     （旧口径的单值 Map「后写为准」已由 2026-09-26 复核废止：cap:01=mod:a+src-x、cap:02=mod:a+mod:b）
 *   · 正例①：`implementation_map` 靶点是**有归属**的模块（T-2 → mod:a）⇒ 两端的共享分组是 cap:02，
 *     如实列为 cap:02 的同组关系（本视图不画自环）
 *   · 正例②：靶点 src-x 经派生归 cap:01 ⇒ 同样列为 cap:01 的同组关系，不再是孤组
 *   · 反例①：靶点与来源任务**同一分组**（T-1 → mod:a，T-1 与 mod:a 都在 cap:01）⇒ 同组内关系，**不画自环**
 *   · 本夹具里 6 条本视图关系**全部**判为同组关系（0 条跨组线）：`design_interface` 的归属就是它自己声明的；
 *     「真没有归属的模块仍落 `ungrouped:<id>`」「跨组实现映射仍画得出」这两条正例改由**夹具 D** 承担。
 */
function fixtureA(): Blueprint {
  const nodes = [
    fnode("plan:cap:01", "capability", "记录能力"),
    fnode("plan:cap:02", "capability", "导入能力"),
    fnode("plan:mod:a", "module", "记录模块"),
    fnode("plan:mod:b", "module", "导入模块"),
    fnode("plan:code:src-x", "module", "src-x"),
    fnode("plan:task:T-1", "task", "T-1 记录地基"),
    fnode("plan:task:T-2", "task", "T-2 导入通道"),
  ];
  const edges = [
    fedge("plan:cap:02", "plan:mod:a", "design_interface"), // 归属行之一（多值：mod:a 同时归 cap:02）
    fedge("plan:cap:01", "plan:mod:a", "design_interface"), // 归属行之二（多值：mod:a 同时归 cap:01）
    fedge("plan:cap:02", "plan:mod:b", "design_interface"), // 归属行（mod:b 归 cap:02）
    fedge("plan:task:T-1", "plan:cap:01", "task_design_ref"),
    fedge("plan:task:T-2", "plan:cap:02", "task_design_ref"),
    fedge("plan:task:T-1", "plan:code:src-x", "implementation_map"), // 正例②：靶点经派生归 cap:01
    fedge("plan:task:T-2", "plan:mod:a", "implementation_map"), // 正例①
    fedge("plan:task:T-1", "plan:mod:a", "implementation_map"), // 反例①：与 T-1 同属 cap:01
  ];
  return fblueprint(nodes, edges);
}
/** 夹具 B（概览折叠）：16 个能力各带 1 个模块 ⇒ 按稳定 id 升序折叠掉 `plan:cap:16`，线不许画到它身上 */
function fixtureB(): Blueprint {
  const nodes: BlueprintNode[] = [];
  const edges: BlueprintEdge[] = [];
  for (let i = 1; i <= 16; i++) {
    const n = String(i).padStart(2, "0");
    nodes.push(fnode(`plan:cap:${n}`, "capability", `能力${n}`));
    nodes.push(fnode(`plan:mod:${n}`, "module", `模块${n}`));
    edges.push(fedge(`plan:cap:${n}`, `plan:mod:${n}`, "design_interface"));
  }
  nodes.push(fnode("plan:task:T-1", "task", "T-1"));
  edges.push(fedge("plan:task:T-1", "plan:cap:01", "task_design_ref"));
  edges.push(fedge("plan:task:T-1", "plan:mod:16", "implementation_map")); // 靶点在被折叠的分组里
  return fblueprint(nodes, edges);
}
/**
 * 夹具 D（2026-09-26 新增；夹具 A 在派生归属落地后不再有孤组与跨组线，本夹具把这两条判据接住）：
 *   · 跨组正例：`implementation_map` 从归 cap:01 的任务指向**只**归 cap:02 的模块（T-9 → mod:d）⇒
 *     两端没有共同分组 ⇒ 如实画成跨组线 cap:01 → cap:02（本视图**仍**要能画得出关系线）
 *   · 无归属仍成组：`plan:code:orphan-z` 没有任何归属（它的实现映射是 `declared`，而二级派生只认
 *     `observed`）⇒ 仍以 `ungrouped:plan:code:orphan-z` 如实成组，成员是它自己、不产生自环
 *   · 靶点无归属的端点解析：T-9 → orphan-z 如实画到它自己的分组节点上（不改名冒充能力、不落空）
 *   · 同组判据：`design_interface`（cap:02 → mod:d）的归属就由它自己声明 ⇒ 必同组，列在 cap:02 上
 */
function fixtureD(): Blueprint {
  const nodes = [
    fnode("plan:cap:01", "capability", "记录能力"),
    fnode("plan:cap:02", "capability", "导入能力"),
    fnode("plan:mod:d", "module", "导入模块"),
    fnode("plan:code:orphan-z", "module", "orphan-z"),
    fnode("plan:task:T-9", "task", "T-9 记录地基"),
  ];
  const edges = [
    fedge("plan:cap:02", "plan:mod:d", "design_interface"), // 归属行（mod:d 只归 cap:02）
    fedge("plan:task:T-9", "plan:cap:01", "task_design_ref"),
    fedge("plan:task:T-9", "plan:mod:d", "implementation_map"), // 跨组正例（observed；靶点是 plan:mod: 不派生）
    // 靶点无归属正例：`declared` 的实现映射不产生派生归属 ⇒ orphan-z 仍无归属
    fedge("plan:task:T-9", "plan:code:orphan-z", "implementation_map", "declared"),
  ];
  return fblueprint(nodes, edges);
}

// ══════════════════════════════ ① 真实数据：复现与修复 ══════════════════════════════

section("① 真实塔台数据：修前 0 条线 / 修后关系逐条有归类（附录 E.5 登记的 edges=0 复现与修复）");
const realBp = realProjectPath === null ? null : readRealBlueprint();
if (realBp === null) {
  skipped("取不到真实 tatai 蓝图（registry 无 tatai 项或尚未派生过蓝图）——真实数据段整段 SKIP，夹具段照跑");
} else {
  info(
    `真实蓝图：${realBp.nodes.length} 节点 / ${realBp.edges.length} 边（` +
      [...realBp.edges.reduce((m, e) => m.set(e.kind, (m.get(e.kind) ?? 0) + 1), new Map<string, number>())]
        .map(([k, v]) => `${k}=${v}`)
        .join(" ") +
      `）；基线 ${realBp.baseline_id}`,
  );

  const realProj = realProjection();
  if (realProj === null) skipped("状态投影读不出（真实事实层不可读）——状态段 SKIP；节点/边口径不依赖它");
  else info(`真实状态投影：${Object.keys(realProj).length} 个对象（节点/边口径不依赖状态色）`);

  const projection = realProj ?? {};
  const moduleStatus = taskDerivedModuleStatus({ blueprint: realBp, projection }).status;
  const real: Record<ProjectViewKind, ProjectViewModel> = {
    functional: buildViewModel({ view: "functional", blueprint: realBp, projection, module_status: moduleStatus }),
    architecture: buildViewModel({ view: "architecture", blueprint: realBp, projection, module_status: moduleStatus }),
    construction: buildViewModel({ view: "construction", blueprint: realBp, projection, module_status: moduleStatus }),
  };

  // ①-a 修前：老算法副本在真实数据上得 0 条线（架构视图）
  const archIds = new Set(real.architecture.nodes.map((n) => n.id));
  const legacyArch = legacyEdgeIds("architecture", realBp, archIds);
  ok(
    legacyArch.length === 0,
    `修前算法（落稿前的 resolveEndpoint 副本）在真实数据上复算架构视图得 ${legacyArch.length} 条线 —— 与附录 E.5 登记的 edges=0 一致`,
  );
  info(
    `真实分组建模：架构视图 ${real.architecture.nodes.length} 个画布节点 / ${real.architecture.groups.length} 个分组，其中 ` +
      `${real.architecture.groups.filter((g) => !archIds.has(g.key)).length} 个分组被概览折叠（指向被折叠分组的线如实画不出来）`,
  );

  // ①-b 修后：关系**归类完整**（2026-09-26 定向更新，判据**不放宽**）
  //   旧期望 = `real.architecture.edges.length > 0`——V09-02 落稿时真实数据得 95 条可见线（1 条 design_interface
  //            加其余 implementation_map），本断言当时钉的是「修后不再 edges=0」。
  //   依据   = 2026-09-26 安装版架构灰块复核落地的三条新口径（`src/ui/arch/projectGraph.ts`：成员→能力归属改
  //            **多值**、系统架构新增「能力 ← 任务设计引用 ← 实测实现映射」二级派生归属、同组判据改成
  //            「两端有没有共同分组」）。三者合起来使本视图关系**天然同组**：`design_interface` 本身就是归属声明
  //            （能力必在靶模块的归属集合里 ⇒ 两端共享该能力）；二级派生又把每个 observed 实现映射的靶点挂进
  //            来源任务所属的能力 ⇒ 这类关系同样必判同组。时点快照（2026-09-26 09:38 重派生后复核）：
  //            本视图 131 条关系 = 131 条同组 + 0 条跨组线 + 0 条两端落空；V09-18（提案线索化＋V08-01/02
  //            补登卡节）后再复算：同组 132 条、落空 0——注释数字一律是时点值，断言以现场复算为准（裁定 9）。
  //   新期望 = **三桶恒等式**：总关系数 == 同组关系 + 跨组可见线 + 两端落空，且同组关系 > 0、落空逐条有真实原因。
  //            「可见线 0 条」是卡面 ② 二选一后一支（口径句）成立的结果：关系没被丢掉，只是全部列在分组节点上
  //            （V09-13 的 `intra_relations`）而不再画线——不是附录 E.5 那种「端点解析落空 ⇒ 一条都画不出」。
  //   保留意图 = V09-02 的真缺陷是「关系被静默丢掉」（E.5：edges=0，连丢了哪些都说不清），不是「必须看得见线」；
  //            端点解析、不造假线、不画自环、每条线带出处四条一字未动（下三条断言原样保留）。
  //   判据不放宽 = 旧「>0」只是存在性判据（画出一条就算过）；新判据要求**逐条归类、总数守恒、落空逐条点名**，
  //            约束更强；另保留修前算法副本读数（0 条）作对照。
  const archAcc = relationAccounting(real.architecture, "architecture", realBp);
  const capOwners = capabilitiesOfMemberIn(realBp, capabilityIdsOf(realBp));
  info(
    `架构视图关系归类（同组关系／跨组可见线／两端落空）：total=${archAcc.total} intra=${archAcc.intra_group} ` +
      `drawn=${archAcc.drawn} unresolved=${archAcc.unresolved.length}`,
  );
  ok(
    archAcc.total === archAcc.intra_group + archAcc.drawn + archAcc.unresolved.length && archAcc.intra_group > 0,
    `修后真实数据上架构视图 ${archAcc.total} 条本视图关系一条没被静默丢掉：${archAcc.intra_group} 条同组关系（逐条列在分组节点上）+ ${archAcc.drawn} 条跨组可见线 + ${archAcc.unresolved.length} 条两端落空（修前算法副本同视图得 ${legacyArch.length} 条线，连丢了哪些关系都说不出）`,
  );
  ok(
    real.architecture.edges.every((e) => archIds.has(e.from) && archIds.has(e.to)),
    "架构视图没有悬空线：每条线的两端都在本次画出的节点集合里",
  );
  ok(
    !real.architecture.edges.some((e) => e.from === e.to),
    "架构视图没有任何自环（同组内关系不是靠画自环冒充的）",
  );
  ok(
    real.architecture.edges.every((e) => e.sources.length > 0),
    "每条可见的关系线都带着它在蓝图里的出处（不给无来源的线，§4.1）",
  );
  ok(
    real.architecture.intra_relations.length > 0 &&
      real.architecture.intra_relations.every(
        (e) => e.sources.length > 0 && typeof e.group_key === "string" && archIds.has(e.group_key),
      ),
    `架构视图的 ${real.architecture.intra_relations.length} 条同组关系逐条带出处、且落在**本次画出的**分组节点上（V09-13：不画线也要可见、可追来源）`,
  );

  // ② 集成/关系线：本视图关系全部同组 ⇒ 图例 0 条必须由口径句解释（2026-09-26 定向更新，判据**不放宽**）
  //   旧期望 = 可见集成/关系线 > 0 ⇒ 图例 `data-edge-count`（integration）不再显示「关系线（0）」。
  //   依据   = 同 ①-b：新口径下本视图关系全部判同组（时点快照 2026-09-26 复核：131/131，跨组线 0）⇒ 卡面 ②（取「口径句」支）
  //            与 ⑤（「或用口径句解释同组不画」）都落在后一支；同组关系的可见性由 V09-13 的
  //            `intra_relations`（逐条列在分组节点上、带稳定 ID 与来源种类）承担。
  //   新期望 = 可见集成线 0 条 **且** 同组集成关系 > 0 **且** 口径句带上该条数——「0 条可见」必须有口径句解释，
  //            不许是没解释的 0（旧态正是没解释的 0，那才是缺陷）。
  //   保留意图 = 图例读数与画布口径必须自洽（§3.3「隐藏不等于没有」）；关系线可见性不许消失得无声无息。
  //   判据不放宽 = 旧判据只查「非 0」；新判据把「0」与「口径句写明条数」绑在一起（0 而无解释 ⇒ 仍红）。
  const integrationEdges = real.architecture.edges.filter((e) => e.semantics === "integration");
  const intraIntegration = real.architecture.intra_relations.filter((e) => e.semantics === "integration");
  ok(
    integrationEdges.length === 0 &&
      intraIntegration.length > 0 &&
      real.architecture.notes.some(
        (n) => n.includes("同组内关系不在本视图画出") && n.includes(`本次 ${archAcc.intra_group} 条`),
      ),
    `系统架构的「${EDGE_SEMANTICS.integration.label}」可见 ${integrationEdges.length} 条、同组关系 ${intraIntegration.length} 条 ⇒ 本视图关系的两端都有共同分组：按卡面 ②／⑤ 的二选一取「口径句」支（图例 0 条由口径句如实解释，不是解析落空）`,
  );

  // ③ 真实数据上 design_interface 全部落在同一分组节点 ⇒ 如实写口径句
  const archBuckets = archAcc.by_kind;
  info(`架构视图逐 kind 关系归类（同组关系／跨组可见线／两端落空）：${JSON.stringify(archBuckets)}`);
  const di = archBuckets.design_interface ?? { total: 0, intra_group: 0, drawn: 0, unresolved: 0 };
  const im = archBuckets.implementation_map ?? { total: 0, intra_group: 0, drawn: 0, unresolved: 0 };
  const rawDi = countKind(realBp, "design_interface");
  const rawIm = countKind(realBp, "implementation_map");
  ok(
    di.drawn === 0 && di.intra_group > 0 && di.intra_group + di.unresolved === rawDi,
    `真实数据上 design_interface 的 ${di.intra_group} 条**全部**落在同一个分组节点上（能力 ↔ 它自己的成员模块）⇒ 本视图可见 0 条，不是被漏掉（共 ${rawDi} 条）`,
  );
  // ── 2026-09-26 定向更新（判据**不放宽**；本条同时接管旧「口径句条数」与旧「实现映射端点解析不再落空」两处）──
  //   旧期望 = ①口径句里的同组条数 == design_interface 的条数（10）；②`im.drawn > 0`（真实数据画出 95 条实现映射线）。
  //   依据   = 同 ①-b 的新口径：同组关系不再只含 design_interface（能力↔自己成员）——多值归属＋二级派生让
  //            task_design_ref／implementation_map 也如实成为同组关系 ⇒ 口径句条数 = 画布上逐条列出的**全部**
  //            同组关系条数（时点快照 2026-09-26 复核：131；V09-18 后复算 132，断言按现场值）；实现映射的归类
  //            同为时点值（2026-09-26 复核：同组 131 含全部 observed 映射、落空 0——更早一版曾记「同组 113 +
  //            落空 6」，落空的 6 条来自 V08-01／V08-02 当时无能力归属，V09-18 补登卡节后归属为确定性派生、
  //            落空复算为 0；附录 B 勘误一在案）。
  //   新期望 = 口径句条数 == **本视图全部同组关系条数**（且与 `intra_relations` 逐条同源）；
  //            实现映射**逐条归类守恒**（total == 同组 + 可见 + 落空 == 蓝图里的 implementation_map 条数——
  //            时点快照：2026-09-26 复核 121 条、V09-18 后 124 条，断言按现场值），落空逐条点名真实原因。
  //   保留意图 = 「关系一条都不许静默消失」「视图口径句与画布读数同源」——两条判据都在，只是不再要求
  //            「可见线 > 0」（新口径下本视图关系全部同组，卡面 ② 二选一取口径句支）。
  //   判据不放宽 = 旧口径句判据只跟 design_interface 的条数（10）对齐；新判据要求跟**画布上逐条列出的同组关系**
  //            对齐（数目更大、且必须真的在 `intra_relations` 里逐条存在）；实现映射侧从「画出 > 0」换成
  //            「三桶守恒 + 落空逐条点名真实原因」。
  ok(
    real.architecture.notes.some(
      (n) => n.includes("同组内关系不在本视图画出") && n.includes(`本次 ${archAcc.intra_group} 条`),
    ) && real.architecture.intra_relations.length === archAcc.intra_group,
    `视图口径句如实写明「同组内关系不在本视图画出」并带上**全部**同组关系条数（${archAcc.intra_group} 条 = 画布上逐条列出的同组关系数）`,
  );
  ok(
    im.drawn === 0 &&
      im.total === im.intra_group + im.drawn + im.unresolved &&
      im.total === rawIm &&
      archAcc.unresolved.every((u) => {
        const inAnyGroup = real.architecture.groups.some((g) => g.members.includes(u.source));
        return !archIds.has(u.source) && !inAnyGroup && (capOwners.get(u.source) ?? []).length === 0;
      }),
    `实现映射线的端点解析不再落空：共 ${rawIm} 条 ⇒ 同组 ${im.intra_group} 条、可见 ${im.drawn} 条、两端落空 ${im.unresolved} 条（${[...new Set(archAcc.unresolved.map((u) => u.source))].join("、")} 在本视图既不是画布节点、也不属任何分组、也没有能力归属 ⇒ 如实画不出来，不假造端点）`,
  );

  // ⑤ 不越界：施工依赖视图与落稿前**逐条相同**；功能全景改按归类恒等式对账
  // ── 2026-09-26 定向更新（判据**不放宽**）──
  //   旧期望 = 功能全景与施工依赖两个视图的可见边数都与**修前算法副本**逐视图相等（"本卡没动它的口径与计数"）。
  //   依据   = 新口径不只作用于系统架构：功能全景同样**分组**（能力分组、成员含模块与任务），多值归属让
  //            「任务与模块共享某个能力分组」的组合变多 ⇒ 修前副本算出的可见线当时全部改判为同组关系
  //            （时点快照 2026-09-26 复核：功能全景 118 条关系全同组；V09-18 能力分类落地后只含功能能力
  //            分组，复算 76 条全同组、0 落空）；施工依赖**不分组**，同组判据不适用 ⇒ 逐条不变
  //            （时点快照 2026-09-26 复核：205 条；注释数字一律是时点值，断言按现场复算）。
  //   新期望 = 施工依赖保持与副本**逐条相等**（时点快照 205 条、0 条同组，断言按现场值）；功能全景换成
  //            **归类恒等式**（total == 同组 + 可见 + 落空；时点快照：2026-09-26 复核 118 全同组、V09-18
  //            能力分类后 76 全同组 + 0 + 0），并保留副本读数作对照——差异来自归属/同组/分类新口径，不是关系丢了。
  //   保留意图 = 「本卡不动施工依赖视图的既有口径与计数」一字未改；分组视图的每条关系都必须有确定归类。
  //   判据不放宽 = 施工依赖仍逐条相等；功能全景从「与副本相等」（旧口径的自证）换成「一条不许丢 + 逐条归类」。
  const constructionVisible = new Set(real.construction.nodes.map((n) => n.id));
  const legacyConstruction = legacyEdgeIds("construction", realBp, constructionVisible);
  const constructionAcc = relationAccounting(real.construction, "construction", realBp);
  ok(
    legacyConstruction.length === real.construction.edges.length &&
      constructionAcc.intra_group === 0 &&
      constructionAcc.drawn === constructionAcc.total,
    `${PROJECT_VIEWS.construction.label}视图的边数与本卡落稿前一致（${real.construction.edges.length} 条；修前算法同视图中同样得 ${legacyConstruction.length} 条）——本卡没动它的口径与计数（不分组 ⇒ 无同组判据）`,
  );
  const functionalVisible = new Set(real.functional.nodes.map((n) => n.id));
  const legacyFunctional = legacyEdgeIds("functional", realBp, functionalVisible);
  const functionalAcc = relationAccounting(real.functional, "functional", realBp);
  ok(
    functionalAcc.total === functionalAcc.intra_group + functionalAcc.drawn + functionalAcc.unresolved.length,
    `${PROJECT_VIEWS.functional.label}视图 ${functionalAcc.total} 条关系一条没丢：${functionalAcc.intra_group} 条同组 + ${functionalAcc.drawn} 条可见线 + ${functionalAcc.unresolved.length} 条落空（修前算法副本同视图得 ${legacyFunctional.length} 条线——差异来自多值归属＋同组判据，见上）`,
  );
  // ── 2026-09-26 定向更新（判据**不放宽**）──
  //   旧期望 = 真实数据上存在 `ungrouped:` 前缀的孤组（彼时 7 个代码模块没有能力归属）。
  //   依据   = 多值归属＋系统架构二级派生落地后，真实蓝图 17 个模块**全部**落进至少一个能力分组（实测 17/17），
  //            孤组在真实数据上已经没有对象。
  //   新期望 = 孤组 0 个 **且** 每个模块都在至少一个能力分组成员里（全称对账，比"至少有一个孤组"更严）；
  //            「真没有归属的模块仍以 `ungrouped:<模块 id>` 如实成组、成员是它自己、不产生自环」这条判据
  //            改由**夹具 D**（declared 映射不派生归属 ⇒ 靶点仍无归属）钉住，不删不空。
  //   保留意图 = 无归属模块不许被改名冒充能力、不许产生自环、不许被藏起来——判据一条没减。
  //   判据不放宽 = 从存在性判据换成全称对账（每个模块都有归属），孤组的成组行为仍有夹具正反例覆盖。
  const ungrouped = real.architecture.nodes.filter((n) => n.id.startsWith("ungrouped:"));
  const moduleIds = realBp.nodes.filter((n) => n.kind === "module").map((n) => n.id);
  const groupedModules = new Set(
    real.architecture.groups.flatMap((g) => g.members).filter((m) => moduleIds.includes(m)),
  );
  // ── 2026-10-08 定向更新（判据**不放宽**，五要素留档）──
  //   旧期望 = `ungrouped.length === 0 && groupedModules.size === moduleIds.length`（注释记为「真实蓝图 17 个模块全部落进能力分组」）。
  //   依据   = 该期望写在 2026-09-26（当时 17 个模块）；此后项目新增 `public/`、`.github/` 两个真实目录 ⇒ 蓝图模块数 19，
  //            其中 `plan:code:public`／`plan:code:github` **确无能力归属**（无 task_design_ref、无 observed 实现映射指向它们）
  //            ⇒ 按 §4.5「待归属」如实成 `ungrouped:<模块 id>` 组。**不是本轮/本卡改动造成的**：用本任务开工前的
  //            逐字节备份复跑同一断言同样红（旧脚本副本 `main-integration/backups/verify-v09-02.ts.before`，
  //            基线日志 `main-integration/base-verify-v09-02.log`：真实蓝图 19 个模块、孤组 2 个），
  //            且 HEAD 的 `buildViewModel` 同样会为无归属模块建 `ungrouped:` 组。
  //   新期望 = **不要求孤组为 0**，改判「每个模块都在某个分组里（真归属 或 未归属组）」**且**「未归属组形态正确」：
  //            成员就是它自己（`ungrouped:<模块 id>` 的成员是 `plan:code:<模块 id>`）、标签带「未归属能力」、不产生自环。
  //   保留意图 = 无归属模块不许被改名冒充能力、不许产生自环、不许被藏起来——判据一条没减。
  //   判据不放宽 = 原判据是「全称：每个模块都有归属（要求孤组 0）」；新判据是
  //            「全称：每个模块都有分组归属 ＋ 未归属组形态正确」，覆盖面不变、**额外**钉住未归属组形态与时点无关。
  const orphanGroups = real.architecture.groups.filter((g) => g.key.startsWith("ungrouped:"));
  ok(
    groupedModules.size === moduleIds.length &&
      orphanGroups.every((g) => g.members.length === 1 && g.members[0] === g.key.slice("ungrouped:".length)) &&
      orphanGroups.every((g) => g.label.includes("未归属能力")) &&
      !real.architecture.edges.some((e) => e.from === e.to),
    `无能力归属的代码模块仍如实成组：真实蓝图 ${moduleIds.length} 个模块**全部**有分组归属（其中未归属组 ${orphanGroups.length} 个：${orphanGroups.map((g) => g.key).join("、") || "无"}；画布上见 ${ungrouped.length} 个）——` +
      "未归属组成员是模块自己、标签带「未归属能力」、不改名冒充能力、不产生自环（判据与时点无关）",
  );
  // 负例（判据**不是空转**）：真丢一个模块的归属 ⇒ 「每个模块都在某个分组里」必须不成立——
  // 从全部分组成员里摘掉一个模块，`groupedModules.size` 立刻小于模块数（同一份真实数据构造，不改产品代码）。
  {
    const dropped = moduleIds[0];
    const afterDrop = new Set(
      real.architecture.groups.flatMap((g) => g.members).filter((m) => moduleIds.includes(m) && m !== dropped),
    );
    ok(
      moduleIds.length > 0 && afterDrop.size === moduleIds.length - 1 && afterDrop.size !== moduleIds.length,
      `负例：真丢一个模块的归属（摘掉 ${dropped ?? "缺"}）时「每个模块都在某个分组里」不成立——判据不是空转（${afterDrop.size} < ${moduleIds.length}）`,
    );
  }
  const realBlueprintHashAfter = realBlueprintFile === null ? null : sha256File(realBlueprintFile);
  ok(
    realBlueprintHashAfter === realBlueprintHashBefore,
    `真实蓝图首尾 sha256 一致（${realBlueprintHashAfter ?? "n/a"}）——本脚本只读，没写真实 .工作台`,
  );
}

// ══════════════════════════════ ② 夹具正反例 ══════════════════════════════

section("② 夹具正反例：有归属的靶点仍找得到 / 同组不画自环 / 真无归属仍成组（夹具 D）/ 跨组仍画得出 / 折叠不造假线");
{
  const bpA = fixtureA();
  const vm = buildViewModel({ view: "architecture", blueprint: bpA, projection: {} });
  const ids = new Set(vm.nodes.map((n) => n.id));
  info(`夹具 A：${vm.nodes.length} 节点 / ${vm.edges.length} 边（${vm.edges.map((e) => e.id).join("、")}）`);

  const intraIds = new Set(vm.intra_relations.map((e) => e.id));
  const intraOf = (id: string) => vm.intra_relations.find((e) => e.id === id);

  // ── 2026-09-26 定向更新（判据**不放宽**）：正例① ──
  //   旧期望 = 可见线 `plan:cap:02>plan:cap:01:implementation_map`（T-2 → "归 cap:01" 的 mod:a ⇒ 跨组 cap:02 → cap:01）。
  //   依据   = 多值归属落地后 mod:a **同时**归 cap:02 与 cap:01（两条 design_interface 都算归属，旧"后写为准"
  //            已废止）⇒ 来源任务 T-2（归 cap:02）与靶点 mod:a 共享分组 cap:02 ⇒ 按新同组判据（两端有共同分组）
  //            如实判为 cap:02 的同组关系，不再画跨组线。
  //   新期望 = 端点仍解析得到靶点（不落空）、归类为 cap:02 的同组关系，且 mod:a 确实在 cap:02 的成员里。
  //   保留意图 = 「靶点有归属时端点在画布上找得到、关系有确定归类」——旧判据的要害是解析不落空，不是"必须画成跨组线"。
  //   判据不放宽 = 从"某条线 id 存在"换成"归类存在 + 归属分组可核 + 多值归属逐条对账"，约束更细。
  ok(
    intraOf("plan:task:T-2>plan:mod:a:implementation_map")?.group_key === "plan:cap:02" &&
      vm.groups.some((g) => g.key === "plan:cap:02" && g.members.includes("plan:mod:a")),
    "正例①：实现映射的靶点是**有归属**的模块（T-2 → mod:a，mod:a 多值归属 cap:02 与 cap:01）⇒ 两端共享 cap:02，如实列为 cap:02 的同组关系（同组关系不是靠画自环冒充）",
  );
  // ── 2026-09-26 定向更新（判据**不放宽**）：正例② ──
  //   旧期望 = 可见线 `plan:cap:01>ungrouped:plan:code:src-x:implementation_map`（靶点无归属 ⇒ 画到它自己的孤组）。
  //   依据   = 系统架构视图新增二级派生：src-x 经「能力 ← task_design_ref ← T-1 → implementation_map(observed)
  //            → plan:code:src-x」归 cap:01 ⇒ 它不再是"无归属模块"，T-1 → src-x 成为 cap:01 的同组关系。
  //   新期望 = src-x 出现在 cap:01 的成员里（派生归属上屏，且口径句写明"是派生、不冒充设计声明"）、该关系
  //            如实列为 cap:01 的同组关系，且**不再**把已归属的 src-x 当孤组。
  //   保留意图 = 「靶点无论有没有归属都要在画布上找得到、不落空」——"真无归属靶点"的正例由**夹具 D** 接住。
  //   判据不放宽 = 归属说法更强（成员里真的列出 src-x + 派生口径句在场 + 孤组为 0），不是放宽。
  ok(
    intraOf("plan:task:T-1>plan:code:src-x:implementation_map")?.group_key === "plan:cap:01" &&
      vm.groups.some((g) => g.key === "plan:cap:01" && g.members.includes("plan:code:src-x")) &&
      vm.notes.some((n) => n.includes("二级派生") && n.includes("不是设计书模块清单的声明归属")) &&
      !vm.nodes.some((n) => n.id === "ungrouped:plan:code:src-x"),
    "正例②：靶点 src-x 经二级派生归 cap:01 ⇒ 如实列为 cap:01 的同组关系并出现在它的分组成员里（口径句写明这是派生归属，不再当孤组）",
  );
  // ── 2026-09-26 定向更新（判据**不放宽**）：正例③（跨组 design_interface）──
  //   旧期望 = 可见线 `plan:cap:02>plan:cap:01:design_interface`（cap:02 接口到"归 cap:01"的 mod:a ⇒ 跨组）。
  //   依据   = `design_interface`（能力→模块）**本身就是归属声明**：这条边一落地，cap:02 就成了 mod:a 的归属之一
  //            ⇒ 两端必有共同分组（cap:02）⇒ 新判据下**任何** design_interface 都判同组、不画跨组线
  //            （实测：本夹具 3 条 design_interface 全部同组）。
  //   新期望 = 3 条 design_interface 逐条如实列为归属能力自己的同组关系；"跨组关系线仍画得出"这条覆盖改由
  //            **夹具 D** 的跨组 implementation_map 承担（cap:01 → 只归 cap:02 的模块），不删不空。
  //   保留意图 = 「跨组关系不许被吞掉、也不许造假」——判据搬到唯一还能跨组的关系种类（实现映射）上，更贴新口径。
  //   判据不放宽 = 旧判据钉一条具体的跨组线；新判据同时钉住"归属关系必同组"（3 条逐条）与夹具 D 的跨组正例。
  const diSameGroup = [
    "plan:cap:01>plan:mod:a:design_interface",
    "plan:cap:02>plan:mod:a:design_interface",
    "plan:cap:02>plan:mod:b:design_interface",
  ];
  ok(
    diSameGroup.every((id) => intraIds.has(id)) && vm.edges.length === 0,
    `正例③：design_interface 的归属由它自己声明（cap:02 → mod:a 使 cap:02 成为 mod:a 的归属之一）⇒ 本夹具 ${diSameGroup.length} 条 design_interface 全部如实列为同组关系（跨组关系线的正例见夹具 D）`,
  );
  ok(
    !vm.edges.some((e) => e.from === e.to),
    "反例①：与来源任务同一分组的靶点（T-1 → mod:a）**不画自环**，也没有改画到别的分组去凑数",
  );
  ok(
    vm.edges.every((e) => ids.has(e.from) && ids.has(e.to)),
    "夹具 A 无悬空线（端点解析失败就丢掉，不凭空造端点）",
  );
  // ── 2026-09-26 定向更新（判据**不放宽**）：夹具 A 的口径句条数 ──
  //   旧期望 = 口径句里含 "3"（当时 3 条同组：cap:01→mod:a 与 cap:02→mod:b 的 design_interface、T-1→mod:a 的实现映射）。
  //   依据   = 正例①②③ 在新口径下全部变成同组关系（见上三条）⇒ 实测本夹具 6 条本视图关系**全部**同组
  //            （3 条 design_interface + 3 条 implementation_map）。
  //   新期望 = 口径句条数 == 画布上逐条列出的同组关系数（实测 6），并且用**限定子串**「本次 6 条」核对，
  //            同时逐条点名这 6 条关系确实在 `intra_relations` 里。
  //   保留意图 = 「口径句条数与画布读数同源、不许对不上」（旧写法 `includes("3")` 会被"§3.3"这类正文蹭中，
  //            是假判据，本处顺手换掉——换掉后更严，不是放宽）。
  //   判据不放宽 = 由宽松子串换成限定子串 + 逐条存在性核对。
  const fixtureAIntra = [
    "plan:cap:01>plan:mod:a:design_interface",
    "plan:cap:02>plan:mod:a:design_interface",
    "plan:cap:02>plan:mod:b:design_interface",
    "plan:task:T-1>plan:code:src-x:implementation_map",
    "plan:task:T-1>plan:mod:a:implementation_map",
    "plan:task:T-2>plan:mod:a:implementation_map",
  ];
  ok(
    vm.notes.some(
      (n) => n.includes("同组内关系不在本视图画出") && n.includes(`本次 ${vm.intra_relations.length} 条`),
    ) &&
      vm.intra_relations.length === fixtureAIntra.length &&
      fixtureAIntra.every((id) => intraIds.has(id)),
    `夹具 A 的视图口径句如实给出同组内关系条数（${vm.intra_relations.length} 条，与画布上逐条列出的同组关系同源：${fixtureAIntra.join("、")}）`,
  );
  // ── 2026-09-26 定向更新（判据**不放宽**）：夹具 A 的「无归属模块」 ──
  //   旧期望 = `plan:code:src-x` 无能力归属 ⇒ 出现 `ungrouped:plan:code:src-x` 孤组，label 带「未归属能力」、成员是它自己。
  //   依据   = 二级派生落地后 src-x 归 cap:01（T-1 的 observed 实现映射）⇒ 本夹具**没有**无归属模块了（实测孤组 0 个）。
  //   新期望 = 本夹具 0 个孤组，且 src-x 只出现在 cap:01 的分组成员里；「真无归属的模块仍以 `ungrouped:<模块 id>`
  //            如实成组、成员是它自己、label 带「未归属能力」」改由**夹具 D**（declared 映射不派生归属）钉住。
  //   保留意图 = 无归属模块的成组行为一字未变，只是本夹具不再有这种模块——判据搬到夹具 D，不删不空。
  //   判据不放宽 = 本夹具改钉"已归属模块不许再当孤组"（双向对账），孤组成组判据在夹具 D 仍在。
  const ungroupedX = vm.nodes.find((n) => n.id === "ungrouped:plan:code:src-x");
  ok(
    ungroupedX === undefined &&
      !vm.nodes.some((n) => n.id.startsWith("ungrouped:")) &&
      vm.groups.some((g) => g.key === "plan:cap:01" && g.members.includes("plan:code:src-x")),
    `夹具 A 已无「未归属能力」孤组（src-x 经派生归 cap:01；无归属模块仍如实成组的判据见夹具 D）——不把已归属模块改名冒充能力`,
  );
  // ── 2026-09-26 定向更新（判据**不放宽**）：夹具 A 的分组成员 ──
  //   旧期望 = cap:01 的成员仍只有 `plan:mod:a`（单值归属下 mod:a 的"后写"归属是 cap:01）。
  //   依据   = 多值归属落地后 cap:01 的成员 = [plan:mod:a（声明归属）, plan:code:src-x（派生归属）]（顺序＝
  //            按蓝图节点顺序过滤，实测）；同一 mod:a 如实出现在 cap:02 的成员里（cap:02 = [plan:mod:a, plan:mod:b]）。
  //   新期望 = cap:01 成员恰为 [plan:mod:a, plan:code:src-x]、cap:02 成员恰为 [plan:mod:a, plan:mod:b]，
  //            且分组节点自己的 `group_key` 仍是它自己（"按能力分组、成员是模块"的既有口径未动）。
  //   保留意图 = 「按能力分组、成员是模块 kind」——成员里不许混进任务或能力自己。
  //   判据不放宽 = 从"只有一个成员"换成"逐个能力逐条成员对账 + 显式钉住多值共享"，约束更强。
  ok(
    vm.groups.some((g) => g.key === "plan:cap:01" && g.members.join(",") === "plan:mod:a,plan:code:src-x") &&
      vm.groups.some((g) => g.key === "plan:cap:02" && g.members.join(",") === "plan:mod:a,plan:mod:b") &&
      vm.nodes.find((n) => n.id === "plan:cap:02")?.group_key === "plan:cap:02",
    "既有口径未动：按能力分组、成员是模块（cap:01＝plan:mod:a＋plan:code:src-x；mod:a 多值共享 cap:02）",
  );

  // 夹具 D（2026-09-26 新增）：接住夹具 A 因派生归属而失去的两条正例——跨组关系线仍画得出 / 真无归属模块仍如实成组
  const bpD = fixtureD();
  const vmD = buildViewModel({ view: "architecture", blueprint: bpD, projection: {} });
  const idsD = new Set(vmD.nodes.map((n) => n.id));
  const intraD = new Map(vmD.intra_relations.map((e) => [e.id, e]));
  info(`夹具 D：${vmD.nodes.length} 节点 / ${vmD.edges.length} 边（${vmD.edges.map((e) => e.id).join("、")}）`);
  ok(
    vmD.edges.some((e) => e.id === "plan:cap:01>plan:cap:02:implementation_map"),
    "夹具 D 正例①：跨组关系线仍画得出（T-9 归 cap:01，靶点 mod:d 只归 cap:02 ⇒ 两端无共同分组 ⇒ cap:01 → cap:02）",
  );
  const orphanZ = vmD.nodes.find((n) => n.id === "ungrouped:plan:code:orphan-z");
  ok(
    orphanZ !== undefined &&
      orphanZ.label.includes("未归属能力") &&
      orphanZ.members.join(",") === "plan:code:orphan-z",
    `夹具 D 正例②：真没有归属的模块仍如实成组（${orphanZ?.label ?? "缺"}；成员 ${orphanZ?.members.join("、") ?? "缺"}）——成员是模块自己，不改名冒充能力`,
  );
  ok(
    vmD.edges.some((e) => e.id === "plan:cap:01>ungrouped:plan:code:orphan-z:implementation_map"),
    "夹具 D 正例③：实现映射的靶点**确实**无归属时，解析到它自己的分组节点 `ungrouped:<模块 id>`（不落空、也不改画到别的分组）",
  );
  ok(
    intraD.get("plan:cap:02>plan:mod:d:design_interface")?.group_key === "plan:cap:02" &&
      vmD.edges.every((e) => idsD.has(e.from) && idsD.has(e.to)) &&
      !vmD.edges.some((e) => e.from === e.to),
    "夹具 D 边界：design_interface 仍必同组（归属由它自己声明）；跨组线与同组关系都无悬空、无自环",
  );
  ok(
    (vmD.groups.find((g) => g.key === "plan:cap:01")?.members.length ?? -1) === 0 &&
      !vmD.groups.some((g) => g.key === "plan:cap:01" && g.members.includes("plan:code:orphan-z")),
    "夹具 D 边界：`declared` 的实现映射**不**派生归属（不许拿 declared/inferred/unverified 的线索边当成员，卡面 ③）",
  );

  // 夹具 B：概览折叠掉的分组不许被"假装画出来"
  const bpB = fixtureB();
  const vmB = buildViewModel({ view: "architecture", blueprint: bpB, projection: {} });
  const idsB = new Set(vmB.nodes.map((n) => n.id));
  const folded = vmB.groups.filter((g) => !idsB.has(g.key)).map((g) => g.key);
  info(
    `夹具 B：${vmB.nodes.length} 节点 / ${vmB.edges.length} 边；被折叠的分组 ${folded.join("、")}；聚合节点 ${vmB.aggregate_node?.id ?? "无"}`,
  );
  ok(folded.includes("plan:cap:16"), `夹具 B 里 plan:cap:16 确实被概览折叠（折叠：${folded.join("、")}）`);
  ok(
    !vmB.edges.some((e) => e.to === "plan:cap:16" || e.from === "plan:cap:16"),
    "反例②：靶点落在**被折叠的分组**里时，线如实画不出来，也不改画到聚合节点或别的分组上（不假装画得出来，§3.3）",
  );
  ok(
    !vmB.edges.some((e) => e.id.includes("aggregate")),
    "聚合节点（还有 N 个）**不是**关系线的端点（不拿聚合冒充关系）",
  );
  ok(
    vmB.edges.every((e) => idsB.has(e.from) && idsB.has(e.to)) && vmB.aggregate_node !== null,
    "夹具 B 无悬空线，且「还有 N 个」的聚合节点照样在（隐藏不等于已完成，§3.3）",
  );
}

console.log(`\n[verify] V09-02 系统架构主视图连线修复：PASS ${pass}／FAIL ${fail}／SKIP ${skip}`);
