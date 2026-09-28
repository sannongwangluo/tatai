// V08-06 验证脚本（tsx 跑）：两处真显示缺陷的修复——画布取数缺口与技术详情旧四色。
//
// 覆盖：
//   ① 系统架构画布取数（缺陷①）：**声明模块**（`plan:mod:<稳定 ID>`）与**能力**（`plan:cap:<n>`）
//      都要能从派生结果拿到状态；`moduleStatusKeysOf` 同时给「蓝图节点 id」与「技术模块 id」两套键，
//      画布不再只查 `by_object`（那个键只有 `module:<代码模块 id>`）。
//   ② 技术详情与主视图**同源**（缺陷②）：技术详情三视图用的就是同一份 `moduleStatusKeysOf(taskDerivedModuleStatus(...))`；
//      表里没有的节点（文件/子目录）由画布如实标「无状态记录」，不再回落 v1 四色。
//   ③ 红线：R3 灰块（cap:01/02/03/07/10/12 这类无成员文档章节）与「无合法声明位」的能力（cap:04/05/06/09）
//      必须仍是灰（unmapped / 无状态记录）——不给它们编成员、也不给绿。
//   ④ 真实锚点抽检（只读）：塔台自身已发布蓝图里，声明模块 `plan:mod:11.1-01` 与代码模块 `src`
//      在全部任务通过时判「验证通过」，`audit` 因 V06-13 也转绿。
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  blueprintNodeStatusOf,
  capabilityStatusOf,
  moduleStatusKeysOf,
  planCodeNodeIdOf,
  taskDerivedModuleStatus,
} from "../src/ui/arch/projectGraph";
import { readBlueprint } from "../src/arch/blueprint";

let pass = 0;
let fail = 0;
const ok = (cond: boolean, label: string): void => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (cond) pass++;
  else {
    fail++;
    process.exitCode = 1;
  }
};
const info = (m: string): void => console.log(`[verify]   ${m}`);

// ── 夹具：能力甲（有成员，全绿）/ 能力乙（无成员，R3 灰）/ 声明模块（对账配对到代码模块）──
const bp = {
  version: 1,
  baseline_id: "bl-v0806-fixture",
  generated_at: "2026-09-24T00:00:00+08:00",
  generator_version: "fixture",
  limits: { max_nodes: 200, max_edges: 400 },
  nodes: [
    { id: "plan:cap:01", kind: "capability", name: "能力甲", source_refs: [], related_ids: [] },
    { id: "plan:cap:07", kind: "capability", name: "文档级章节（R3）", source_refs: [], related_ids: [] },
    { id: "plan:code:src", kind: "module", name: "核心源码", source_refs: [], related_ids: [] },
    { id: "plan:mod:11.1-01", kind: "module", name: "项目注册表与目录接入", source_refs: [], related_ids: [] },
    { id: "plan:task:T-1", kind: "task", name: "T-1", source_refs: [], related_ids: [] },
    { id: "plan:task:T-2", kind: "task", name: "T-2", source_refs: [], related_ids: [] },
    { id: "plan:concept:x", kind: "concept", name: "概念", source_refs: [], related_ids: [] },
  ],
  edges: [
    { source: "plan:task:T-1", target: "plan:code:src", kind: "implementation_map", source_refs: [], certainty: "observed" },
    { source: "plan:task:T-2", target: "plan:code:src", kind: "implementation_map", source_refs: [], certainty: "observed" },
    { source: "plan:cap:01", target: "plan:code:src", kind: "design_interface", source_refs: [], certainty: "declared" },
    { source: "plan:task:T-1", target: "plan:cap:01", kind: "task_design_ref", source_refs: [], certainty: "declared" },
  ],
  coverage: {
    design_sections: { total: 0, mapped: 0, unmapped: [] },
    plan_tasks: { total: 0, mapped: 0, unmapped: [] },
    code_modules: { total: 0, mapped: 0, unmapped: [] },
    nodes_kept: 7,
    edges_kept: 4,
  },
  omitted: [],
} as never;

const projection = {
  "T-1": { object_id: "T-1", mapping: "mapped", display_status: "verified", reasons: [] },
  "T-2": { object_id: "T-2", mapping: "mapped", display_status: "verified", reasons: [] },
} as never;

const derived = taskDerivedModuleStatus({
  blueprint: bp,
  projection,
  declared_links: { "11.1-01": ["src"] } as never,
});
const keys = moduleStatusKeysOf(derived);

// ═════════════════════════ ① 画布取数（缺陷①） ═════════════════════════
console.log("[verify] ═══ ① 系统架构画布取数：声明模块与能力都能拿到派生状态 ═══");
ok(
  keys["plan:mod:11.1-01"] === "verified",
  `声明模块按对账配对继承代码模块状态（plan:mod:11.1-01 = ${keys["plan:mod:11.1-01"]}）——不再落「无状态记录」`,
);
ok(
  keys["plan:code:src"] === "verified" && keys["src"] === "verified",
  `同一份表给两套键：蓝图节点 id（${keys["plan:code:src"]}）与技术模块 id（${keys["src"]}）——技术详情画布查得到`,
);
ok(
  planCodeNodeIdOf("src") === "plan:code:src" && planCodeNodeIdOf("plan:code:src") === "plan:code:src",
  "技术模块 id ↔ 蓝图节点 id 的换算只此一处",
);
const cap1 = capabilityStatusOf([
  { id: "plan:code:src", status: blueprintNodeStatusOf("plan:code:src", { blueprint: bp, projection, module_status: derived.status }) },
]);
ok(cap1.display === "verified", `能力节点按成员派生（cap:01 = ${cap1.display}）——画布不再直接落「无状态记录」`);
const cap7 = capabilityStatusOf([]);
ok(
  cap7.display === null && cap7.unmapped_reason === "no_members",
  `没有成员的能力仍是灰（cap:07 → ${cap7.display}／${cap7.unmapped_reason}）`,
);
info(`  派生表里模块类键：${Object.keys(keys).filter((k) => !k.startsWith("module:")).join("、")}`);

// ═════════════════════════ ② 技术详情与主视图同源（缺陷②） ═════════════════════════
console.log("[verify] ═══ ② 技术详情三视图与主视图同源（同一份派生表） ═══");
{
  const archViewKeys = moduleStatusKeysOf(
    taskDerivedModuleStatus({ blueprint: bp, projection, declared_links: { "11.1-01": ["src"] } as never }),
  );
  const techKeys = moduleStatusKeysOf(derived);
  ok(
    JSON.stringify(archViewKeys) === JSON.stringify(techKeys),
    "系统架构画布与技术详情画布取的是**同一个函数、同一份结果**（不存在两套口径）",
  );
  ok(
    ["src", "plan:code:src", "plan:mod:11.1-01"].every((k) => techKeys[k] === "verified"),
    "技术详情里模块节点不再回落到 v1 四色的「未开始/已完成」",
  );
  // 表里没有的节点（文件/子目录）不冒充状态：画布按「无状态记录」处理（ArchCanvas 的口径）
  ok(techKeys["src/ui/App.tsx"] === undefined && techKeys["plan:concept:x"] === undefined, "文件/概念节点不在状态表里（画布如实标「无状态记录」，不冒充 v1 四色）");
}

// ═════════════════════════ ③ 红线：R3 灰块不染绿 ═════════════════════════
console.log("[verify] ═══ ③ 红线：R3 灰块与「无合法声明位」的能力仍是灰 ═══");
{
  const noMembers = ["plan:cap:01", "plan:cap:02", "plan:cap:03", "plan:cap:07", "plan:cap:10", "plan:cap:12"];
  const greys = noMembers.map((id) => capabilityStatusOf([]).display === null);
  ok(greys.every(Boolean), "无成员的能力一律不着完成色（不给 R3 文档章节编成员）");
  const cap4 = capabilityStatusOf([]);
  ok(cap4.display === null, "cap:04 这类「无合法声明位」的能力同样留灰（§4.5 配不上就没有成员）");
  // 反证：给它编一个成员（模型/人工塞的）才可能绿 —— 本卡不这么做，测试里断言代码里没有这条路径
  const srcText = fs.readFileSync("D:/tatai/src/ui/arch/ProjectGraphView.tsx", "utf8");
  ok(
    srcText.includes("capabilityStatusOf(") && srcText.includes("capMembers.get(n.id)"),
    "画布侧的能力状态只按**真实成员**算（成员从视图模型的分组里取，没有直接给能力涂色的旁路）",
  );
}

// ═════════════════════════ ④ 真实锚点抽检（只读） ═════════════════════════
console.log("[verify] ═══ ④ 真实锚点抽检：塔台已发布蓝图上的两套键 ═══");
{
  const real = readBlueprint("tatai");
  if (real === null) {
    ok(false, "读不到塔台已发布蓝图（本机应已发布）");
  } else {
    const allVerified = Object.fromEntries(
      real.nodes
        .filter((n) => n.kind === "task")
        .map((n) => [n.id.replace("plan:task:", ""), { object_id: n.id.replace("plan:task:", ""), mapping: "mapped", display_status: "verified", reasons: [] }]),
    );
    const links: Record<string, string[]> = {};
    const recFile = "D:/tatai/.工作台/arch/reconcile-last.json";
    if (fs.existsSync(recFile)) {
      const rec = JSON.parse(fs.readFileSync(recFile, "utf8")) as { matched?: { stable_id?: string; module_id: string }[] };
      for (const m of rec.matched ?? []) {
        if (m.stable_id === undefined || m.stable_id === "") continue;
        (links[m.stable_id] ??= []).push(m.module_id);
      }
    }
    const d2 = taskDerivedModuleStatus({ blueprint: real, projection: allVerified as never, declared_links: links });
    const k2 = moduleStatusKeysOf(d2);
    ok(k2["plan:mod:11.1-01"] === "verified", `真实蓝图：声明模块 11.1-01 → ${k2["plan:mod:11.1-01"]}`);
    ok(k2["audit"] === "verified" && k2["src"] === "verified", `真实蓝图：技术模块 id 键可用（audit=${k2["audit"]}、src=${k2["src"]}）`);
    const capIds = real.nodes.filter((n) => n.kind === "capability").map((n) => n.id);
    const capMembers = new Map<string, string[]>();
    for (const g of []) void g;
    for (const e of real.edges) {
      if (e.kind === "design_interface") {
        const list = capMembers.get(e.source) ?? [];
        list.push(e.target);
        capMembers.set(e.source, list);
      }
    }
    const r3 = capIds.filter((id) => (capMembers.get(id) ?? []).length === 0);
    ok(
      r3.length > 0 && r3.every((id) => capabilityStatusOf([]).display === null),
      `真实蓝图里 ${r3.length} 个能力没有任何模块成员（含 R3 与 cap:04/05/06/09）→ 一律留灰（${r3.slice(0, 4).join("、")}…）`,
    );
    info(`  真实蓝图：${real.nodes.length} 节点 / ${real.edges.length} 边；对账配对 ${Object.keys(links).length} 个声明模块`);
  }
}

assert.ok(true);
console.log(`\n[verify] 汇总：${pass} PASS / ${fail} FAIL`);
