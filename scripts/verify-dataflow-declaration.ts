// 数据流「声明与源码解耦」机制回归（tsx 跑）：pnpm verify:dataflow-declaration
//
// 覆盖（重点机制随源码交付；原为一轮临时合成核验 scripts/verify-synthetic.mjs，此处消除盘符绝对路径与
// 私有数据后移植入库，并补本轮两处修复的用例）：
//   A. 项目侧声明加载与隔离：任意注册项目按项目根只读加载 `.工作台/arch/dataflow-index.json`；
//      跨项目隔离（同名标识不串项目）；内建登记表只含 tatai，合成项目由声明动态登记。
//   B. 缺口如实（不伪造可交付）：缺失 / 非法 JSON / 结构不合格（artifacts 非数组）/ 路径越界（../）/
//      声明自报 code_measured / 软链(junction)逃逸 / 未注册项目——逐条显式报缺并阻断交付。
//   C. 自有属性匹配（本轮修复）：项目 id 为 constructor/__proto__/toString/hasOwnProperty 时不得被
//      JS 原型链继承属性顶成「内建」，必须走它自己的项目侧声明。
//   D. artifact→node 回退只对内建（本轮修复）：项目侧声明的同名 artifact id（如 df-art-design）不得
//      回退到塔台内建的节点 id；项目侧声明的显式 node_id 仍照常生效。
//   E. 快照绑定声明内容（本轮修复）：同内容重复读取 snapshot_id 稳定；声明内容变化 ⇒ snapshot_id 变、
//      旧游标被拒；缺失/坏声明与有效声明之间的 identity 变化同样反映（不使用 mtime）。
//
// 隔离口径（AGENTS.md §5）：夹具一律放系统 tmp 下的 `tatai-dfdecl-` 前缀目录，收尾自清且**先确认目标
// 在临时根内**；注册表一律写到夹具自己的 dataDir，绝不碰真实注册表与真实项目。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  analyzeDataFlow,
  analyzeDataFlowAt,
  DATA_FLOW_INDEXES,
  DATA_FLOW_DECLARATION_PATH,
  dataFlowRegisteredProjects,
  loadDataFlowIndex,
  resolveDataFlowDeclaration,
} from "../src/arch/dataflow";
import { sixGraphsOf } from "../src/arch/sixGraphs";
import { addProject } from "../src/server/registry";
import { readProgress } from "../src/server/workstation";

let pass = 0;
const fails: string[] = [];
const skips: string[] = [];
const ok = (cond: boolean, label: string): void => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (cond) pass += 1;
  else fails.push(label);
};
const skip = (label: string): void => {
  console.log(`[verify] SKIP ${label}`);
  skips.push(label);
};

// ─────────────────────────────── 隔离临时目录（收尾自清，先确认在临时根内） ───────────────────────────────
const TMP_ROOT = path.resolve(os.tmpdir());
const CLEANUP: string[] = [];
const mkTmp = (tag: string): string => {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, `tatai-dfdecl-${tag}-`));
  CLEANUP.push(dir);
  return dir;
};
const cleanup = (): void => {
  for (const dir of CLEANUP) {
    const abs = path.resolve(dir);
    if (abs === TMP_ROOT || !abs.startsWith(TMP_ROOT + path.sep)) {
      console.error(`[verify] 拒绝清理临时根外的目标：${abs}`);
      continue;
    }
    fs.rmSync(abs, { recursive: true, force: true });
  }
};

/** 一份最小合法声明：一个 input_source 实体 + 对应节点，设计片段指向 design.md 里的 designFind。 */
const declaration = (designFind: string, nodeId: string, extra: Record<string, unknown> = {}) => ({
  version: 1,
  design_path: "design.md",
  artifacts: [
    {
      id: "art-" + nodeId,
      artifact: designFind,
      kind: "input_source",
      declaration_status: "declared_not_implemented",
      design: { tier: "design_declared", path: "design.md", find: designFind, note: "fixture" },
      code: [],
      role: "fixture input",
    },
  ],
  nodes: [
    {
      id: nodeId,
      kind: "input_source",
      label: designFind,
      role: "input",
      claims: [{ tier: "design_declared", path: "design.md", find: designFind, note: "fixture" }],
      static_clues: [],
    },
  ],
  edges: [],
  chains: [],
  measured: [],
  ...extra,
});

/** 在给定 dataDir 里登记一个隔离项目；files 的相对路径按 `/` 拆分落盘。 */
const mkProject = (home: string, id: string, files: Record<string, unknown>): string => {
  const dir = mkTmp("proj");
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, ...rel.split("/"));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, typeof content === "string" ? content : JSON.stringify(content), "utf8");
  }
  addProject({ id, name: id, path: dir, kind: "backend" }, home);
  return dir;
};

const declAbs = (dir: string): string => path.join(dir, ...DATA_FLOW_DECLARATION_PATH.split("/"));

try {
  // ═════════════════════ A. 项目侧声明加载与跨项目隔离 ═════════════════════
  console.log("\n[verify] ── A. 项目侧声明加载与跨项目隔离 ──");
  const HOME = mkTmp("home");
  mkProject(HOME, "syn-alpha", {
    "design.md": "# Alpha\n\nAlpha input\n",
    [DATA_FLOW_DECLARATION_PATH]: declaration("Alpha input", "alpha-node"),
    "package.json": JSON.stringify({ scripts: { "verify:alpha": "tsx scripts/alpha.ts" } }),
  });
  mkProject(HOME, "syn-beta", {
    "design.md": "# Beta\n\nBeta input\n",
    [DATA_FLOW_DECLARATION_PATH]: declaration("Beta input", "beta-node"),
  });
  const a = analyzeDataFlow("syn-alpha", { dataDir: HOME });
  const b = analyzeDataFlow("syn-beta", { dataDir: HOME });
  ok(
    a.nodes.length === 1 && a.nodes[0].id === "alpha-node" && a.nodes[0].evidence.length === 1,
    "alpha 从项目侧声明加载出自身节点且复算命中（设计声明档）",
  );
  ok(b.nodes.length === 1 && b.nodes[0].id === "beta-node", "beta 从项目侧声明加载出自身节点");
  ok(
    !JSON.stringify(a).includes("beta") && !JSON.stringify(b).includes("alpha"),
    "跨项目隔离：alpha 模型不含 beta 的标识、beta 模型不含 alpha 的标识",
  );
  ok(
    a.coverage.declared_total === 1 && a.coverage.not_implemented === 1 && a.coverage.missing === 0,
    "alpha 覆盖对账：声明未实现单列、不计缺路径",
  );
  ok(a.scan.notes.some((n) => n.includes("dataflow-index.json")), "alpha 来源留痕（声明来源文件在场）");
  ok(
    dataFlowRegisteredProjects().includes("tatai") && !dataFlowRegisteredProjects().includes("syn-alpha"),
    "内建登记表只含 tatai，合成项目由项目侧声明动态登记",
  );

  // ═════════════════════ B. 缺口如实（缺失 / 坏 / 越界 / 自报实测） ═════════════════════
  console.log("\n[verify] ── B. 缺口如实（显式报缺，不伪造可交付） ──");
  mkProject(HOME, "syn-missing", {});
  mkProject(HOME, "syn-bad", { [DATA_FLOW_DECLARATION_PATH]: "{ not json" });
  mkProject(HOME, "syn-null-array", {
    [DATA_FLOW_DECLARATION_PATH]: JSON.stringify({
      version: 1,
      design_path: "design.md",
      artifacts: null,
      nodes: [],
      edges: [],
      chains: [],
      measured: [],
    }),
  });
  mkProject(HOME, "syn-escape", {
    "design.md": "# Escape\n\nEscape\n",
    [DATA_FLOW_DECLARATION_PATH]: JSON.stringify({
      ...declaration("Escape", "esc-node"),
      artifacts: [
        {
          ...declaration("Escape", "esc-node").artifacts[0],
          design: { tier: "design_declared", path: "../secret.md", find: "Escape", note: "x" },
        },
      ],
    }),
  });
  mkProject(HOME, "syn-selfmeasured", {
    "design.md": "# Self\n\nSelf\n",
    [DATA_FLOW_DECLARATION_PATH]: JSON.stringify({
      ...declaration("Self", "self-node"),
      nodes: [
        {
          id: "self-node",
          kind: "process",
          label: "Self",
          role: "x",
          claims: [{ tier: "code_measured", path: "design.md", find: "Self", note: "x" }],
          static_clues: [],
        },
      ],
    }),
  });

  const missing = analyzeDataFlow("syn-missing", { dataDir: HOME });
  ok(
    missing.nodes.length === 0 && missing.deliverable_blocked && missing.scan.notes[0].includes("未找到"),
    "缺失声明：显式报缺并阻断交付（空模型，不伪造）",
  );
  const bad = analyzeDataFlow("syn-bad", { dataDir: HOME });
  ok(bad.nodes.length === 0 && bad.deliverable_blocked && bad.scan.notes[0].includes("不是合法 JSON"), "坏声明（非法 JSON）：显式报缺并阻断交付");
  const nullArr = analyzeDataFlow("syn-null-array", { dataDir: HOME });
  ok(nullArr.nodes.length === 0 && nullArr.scan.notes[0].includes("结构不合格"), "坏声明（artifacts 非数组）：结构不合格显式报错");
  const escape = analyzeDataFlow("syn-escape", { dataDir: HOME });
  ok(
    escape.nodes.length === 0 && escape.scan.notes[0].includes("结构不合格") && escape.scan.notes[0].includes("相对路径"),
    "越界路径（../）：显式报错为结构不合格",
  );
  const selfMeasured = analyzeDataFlow("syn-selfmeasured", { dataDir: HOME });
  ok(selfMeasured.nodes.length === 0 && selfMeasured.scan.notes[0].includes("code_measured"), "声明自报 code_measured：被拒（可复跑实测档不许由声明自报）");
  const unreg = analyzeDataFlow("not-registered", { dataDir: HOME });
  ok(unreg.nodes.length === 0 && unreg.scan.notes[0].includes("不在注册表"), "未注册项目：路径不猜，显式空态");

  const esc = loadDataFlowIndex(resolveProjDir(HOME, "syn-escape"));
  ok(esc.index === null && (esc.error ?? "").includes("相对路径"), "loadDataFlowIndex：越界路径返回 error（index 为 null）");
  const missLoad = loadDataFlowIndex(resolveProjDir(HOME, "syn-missing"));
  ok(missLoad.index === null && (missLoad.error ?? "").includes("未找到"), "loadDataFlowIndex：缺失返回 error");
  const good = loadDataFlowIndex(resolveProjDir(HOME, "syn-alpha"));
  ok(
    good.index !== null && good.source?.path === DATA_FLOW_DECLARATION_PATH && /^[0-9a-f]{64}$/.test(good.source.sha256),
    "loadDataFlowIndex：成功返回 index + 来源 sha256",
  );

  // 软链/junction 逃逸：词法在根内、物理在根外仍须拒绝（不支持创建 junction 的文件系统上记为 SKIP）
  const jHome = mkTmp("home-junction");
  const jDir = mkProject(jHome, "syn-junction", {
    [DATA_FLOW_DECLARATION_PATH]: JSON.stringify({ version: 1, design_path: "linked/DESIGN.md", artifacts: [], nodes: [], edges: [], chains: [], measured: [] }),
  });
  const outside = mkTmp("outside");
  fs.writeFileSync(path.join(outside, "DESIGN.md"), "anchor\n", "utf8");
  let junctionMade = false;
  try {
    fs.symlinkSync(outside, path.join(jDir, "linked"), "junction");
    junctionMade = true;
  } catch (e) {
    skip(`软链/junction 逃逸用例（本机不支持创建 junction：${(e as Error).message}）`);
  }
  if (junctionMade) {
    const junction = analyzeDataFlow("syn-junction", { dataDir: jHome });
    ok(
      junction.nodes.length === 0 && junction.deliverable_blocked && junction.scan.notes[0].includes("软链/junction 逃逸"),
      "软链/junction 逃逸：显式报越界并阻断交付（不读根外文件）",
    );
    const jload = loadDataFlowIndex(jDir);
    ok(jload.index === null && (jload.error ?? "").includes("逃逸"), "loadDataFlowIndex：junction 逃逸返回 error（index 为 null）");
  }
  const declarationRoot = mkTmp("declaration-junction");
  const declarationOutside = mkTmp("declaration-outside");
  fs.mkdirSync(path.join(declarationRoot, ".工作台"));
  fs.writeFileSync(path.join(declarationOutside, "dataflow-index.json"), JSON.stringify(declaration("Outside", "outside-node")));
  fs.symlinkSync(declarationOutside, path.join(declarationRoot, ".工作台", "arch"), "junction");
  const escapedDeclaration = loadDataFlowIndex(declarationRoot);
  ok(escapedDeclaration.index === null && (escapedDeclaration.error ?? "").includes("声明文件本身越出"), "声明文件自身位于根外 junction：读取前拒绝");

  // ═════════════════════ C. 自有属性匹配（项目名不得顶成内建） ═════════════════════
  console.log("\n[verify] ── C. 自有属性匹配（constructor/__proto__ 等不被当内建） ──");
  const protoIds = ["constructor", "__proto__", "toString", "hasOwnProperty"];
  for (const id of protoIds) {
    mkProject(HOME, id, {
      "design.md": `# ${id}\n\n${id} input\n`,
      [DATA_FLOW_DECLARATION_PATH]: declaration(`${id} input`, `${id.replace(/[^a-z]/gi, "")}-node`),
    });
  }
  for (const id of protoIds) {
    const model = analyzeDataFlow(id, { dataDir: HOME });
    const resolved = resolveDataFlowDeclaration(id, { dataDir: HOME });
    ok(
      model.nodes.length === 1 && model.nodes[0].id === `${id.replace(/[^a-z]/gi, "")}-node`,
      `项目 id「${id}」走自己的项目侧声明（不被原型链继承属性顶成内建）`,
    );
    ok(resolved.identity.startsWith("decl:"), `项目 id「${id}」的身份是项目侧声明（decl:），不是内建（builtin:）`);
  }
  ok(
    dataFlowRegisteredProjects().length === 1 && dataFlowRegisteredProjects()[0] === "tatai",
    `内建登记表仍是自有属性口径（${JSON.stringify(dataFlowRegisteredProjects())}）`,
  );

  // ═════════════════════ D. artifact→node 回退只对内建 ═════════════════════
  console.log("\n[verify] ── D. artifact→node 回退只对内建（同名 id 不串项目） ──");
  mkProject(HOME, "syn-collide", {
    "design.md": "# Collide\n\nCollide input\n\nExplicit input\n",
    [DATA_FLOW_DECLARATION_PATH]: JSON.stringify({
      version: 1,
      design_path: "design.md",
      artifacts: [
        {
          // 与塔台内建声明同名（df-art-design）：项目侧没有 node_id ⇒ 必须保持 null，不得串到塔台的 df-node-design-source
          id: "df-art-design",
          artifact: "Collision artifact",
          kind: "input_source",
          declaration_status: "declared_not_implemented",
          design: { tier: "design_declared", path: "design.md", find: "Collide input", note: "x" },
          code: [],
          role: "collision",
        },
        {
          id: "df-art-shared",
          artifact: "Explicit artifact",
          kind: "input_source",
          declaration_status: "declared_not_implemented",
          design: { tier: "design_declared", path: "design.md", find: "Explicit input", note: "x" },
          code: [],
          role: "explicit",
          node_id: "own-node",
        },
      ],
      nodes: [],
      edges: [],
      chains: [],
      measured: [],
    }),
  });
  const collide = analyzeDataFlow("syn-collide", { dataDir: HOME });
  const collideRow = collide.coverage.rows.find((r) => r.artifact === "Collision artifact");
  const explicitRow = collide.coverage.rows.find((r) => r.artifact === "Explicit artifact");
  ok(collideRow?.node_id === null, "项目侧同名 artifact id（df-art-design）不回退塔台内建映射（node_id 为 null）");
  ok(explicitRow?.node_id === "own-node", "项目侧声明的显式 node_id 照常生效");

  const emptyRoot = mkTmp("builtin-empty-root");
  const builtinModel = analyzeDataFlowAt(DATA_FLOW_INDEXES.tatai, { project_id: "tatai", root: emptyRoot, scripts: {} });
  ok(
    builtinModel.coverage.rows.some((r) => r.node_id === "df-node-design-source"),
    "内建声明仍按内建表回退（df-art-design → df-node-design-source）",
  );

  // ═════════════════════ E. 快照绑定声明内容（改声明快照变、旧游标拒、同内容稳定） ═════════════════════
  console.log("\n[verify] ── E. 快照绑定数据流声明内容 ──");
  const sHome = mkTmp("home-snapshot");
  const sId = "df-snapshot";
  const bpFixture = {
    version: 1,
    baseline_id: "bl-fixture",
    generator_version: "verify-dataflow-declaration",
    generated_at: "2026-01-01T00:00:00+08:00",
    source_manifest: [],
    nodes: [{ id: "plan:cap:01", kind: "capability", name: "夹具能力", source_refs: [], related_ids: [] }],
    edges: [],
    coverage: {
      design_sections: { total: 0, mapped: 0, unmapped: [] },
      plan_tasks: { total: 0, mapped: 0, unmapped: [] },
      code_modules: { total: 2, mapped: 2, unmapped: [] },
      nodes_total: 1,
      nodes_kept: 1,
      edges_total: 0,
      edges_kept: 0,
      note: "验证夹具",
    },
    omitted: [],
    model_receipt: null,
    publish: { published: true, reason: null, validated_at: "2026-01-01T00:00:00+08:00" },
    based_on: { model_key: "fx", full_key: "fx", design_content_sha256: null, plan_definition_sha256: null, semantic: false },
  };
  const sDir = mkProject(sHome, sId, {
    "design.md": "# Flow\n\nFlow input\n",
    ".工作台/arch/modules.json": {
      version: 1,
      generated_at: "2026-01-01T00:00:00+08:00",
      budget_exhausted: false,
      modules: [
        { id: "m1", name: "", path: "m1", file_count: 2, loc: 0, deps: [{ to: "m2", weight: 1 }] },
        { id: "m2", name: "", path: "m2", file_count: 1, loc: 0, deps: [] },
      ],
    },
    ".工作台/arch/blueprint.json": bpFixture,
    [DATA_FLOW_DECLARATION_PATH]: declaration("Flow input", "flow-node"),
  });
  readProgress(sId, sHome); // 幂等初始化 progress.json（内容确定 ⇒ 快照稳定）

  const oPage = { dataDir: sHome, mode: "full" as const, limit: 1, graph: "module_map" as const };
  const s1 = sixGraphsOf(sId, oPage);
  const s2 = sixGraphsOf(sId, oPage);
  ok(s1.snapshot_id === s2.snapshot_id, `同内容重复读取 snapshot 稳定（${s1.snapshot_id}）`);
  ok(s1.graph_state.availability === "published", `夹具快照稳定（availability=${s1.graph_state.availability}）`);

  const dfGraph = sixGraphsOf(sId, { dataDir: sHome, mode: "full", limit: 100, graph: "data_flow" });
  const flowTech = dfGraph.graphs.data_flow?.tech as { nodes?: { id: string }[] } | undefined;
  ok(flowTech?.nodes?.some((n) => n.id === "flow-node") === true, "data_flow 目标层含项目侧声明节点（声明真被本图用到）");

  const cursor = s1.completeness.cursors.module_map ?? `${s1.snapshot_id}:full:module_map:1`;
  const declPath = declAbs(sDir);
  const raw = JSON.parse(fs.readFileSync(declPath, "utf8")) as { nodes: { label: string }[] };
  raw.nodes[0].label = "Flow input changed";
  fs.writeFileSync(declPath, JSON.stringify(raw), "utf8");
  const s3 = sixGraphsOf(sId, oPage);
  ok(s3.snapshot_id !== s1.snapshot_id, `声明内容变化 → snapshot 变化（${s1.snapshot_id} → ${s3.snapshot_id}）`);
  let oldRejected: string | null = null;
  try {
    sixGraphsOf(sId, { ...oPage, cursor });
  } catch (e) {
    oldRejected = (e as Error).message;
  }
  ok(oldRejected !== null, `拿旧 snapshot 游标续取被拒（声明真变必拒；实际 ${oldRejected === null ? "未拒绝" : oldRejected.slice(0, 50)}）`);

  // 缺失/坏声明与有效声明之间：identity 变化（不用 mtime），且有效声明同内容稳定
  const idHome = mkTmp("home-identity");
  const idDir = mkProject(idHome, "df-identity", {});
  const i0 = resolveDataFlowDeclaration("df-identity", { dataDir: idHome });
  fs.mkdirSync(path.join(idDir, ".工作台", "arch"), { recursive: true });
  fs.writeFileSync(declAbs(idDir), "{ not json", "utf8");
  const i1 = resolveDataFlowDeclaration("df-identity", { dataDir: idHome });
  fs.writeFileSync(declAbs(idDir), JSON.stringify({ version: 1, design_path: "design.md", artifacts: "invalid-one" }), "utf8");
  const invalidFirst = resolveDataFlowDeclaration("df-identity", { dataDir: idHome });
  fs.writeFileSync(declAbs(idDir), JSON.stringify({ version: 1, design_path: "design.md", artifacts: "invalid-two" }), "utf8");
  const invalidSecond = resolveDataFlowDeclaration("df-identity", { dataDir: idHome });
  ok(invalidFirst.error === invalidSecond.error && invalidFirst.identity !== invalidSecond.identity, "坏声明错误相同但内容变化：identity 仍按实际内容更新");
  fs.writeFileSync(declAbs(idDir), JSON.stringify(declaration("Id input", "id-node")), "utf8");
  const i2 = resolveDataFlowDeclaration("df-identity", { dataDir: idHome });
  const i2b = resolveDataFlowDeclaration("df-identity", { dataDir: idHome });
  ok(i0.identity.startsWith("missing:") && i1.identity !== i0.identity, "缺失 → 坏声明：identity 变化（缺口变化也反映）");
  ok(i2.identity.startsWith("decl:") && i2.identity !== i1.identity, "坏声明 → 有效声明：identity 变化");
  ok(i2b.identity === i2.identity, "有效声明同内容重复读取：identity 稳定");

  // 删除声明后快照再变（六图层面复核一次）
  fs.rmSync(declPath, { force: true });
  const s4 = sixGraphsOf(sId, oPage);
  ok(s4.snapshot_id !== s1.snapshot_id && s4.snapshot_id !== s3.snapshot_id, `删掉声明 → snapshot 再变（${s3.snapshot_id} → ${s4.snapshot_id}）`);
} finally {
  cleanup();
}

console.log(`\nDATAFLOW-DECLARATION: PASS ${pass} / FAIL ${fails.length} / SKIP ${skips.length}`);
if (fails.length > 0) {
  for (const f of fails) console.log(`  FAIL ${f}`);
  process.exitCode = 1;
} else if (skips.length > 0) {
  process.exitCode = 3;
}

/** 从 dataDir 的注册表里取项目路径（夹具查询用；找不到即抛）。 */
function resolveProjDir(home: string, id: string): string {
  const project = (JSON.parse(fs.readFileSync(path.join(home, "registry.json"), "utf8")) as { projects: { id: string; path: string }[] }).projects.find(
    (p) => p.id === id,
  );
  if (project === undefined) throw new Error(`夹具项目不存在: ${id}`);
  return project.path;
}
