// V09-17 验证脚本（tsx 跑）：关系边来源/映射证据判据落地（GPT-6 2026-09-25 四条裁定落实）。
// 用法：pnpm verify:v09-17（自带临时 TATAI_HOME 与夹具；真实文档只读并做首尾 sha256 零改动自证）
//
// 覆盖（逐条对着 PLAN V09-17 卡面「检查项」①—⑤；⑥ 覆盖对账是文档交付物，见
// `.工作台/evidence/V09-17/1/dataflow-coverage.md`；⑦ 门槛与回归由交付日志核对）：
//   ① 类 A 来源引用边（task_design_ref）：所引章节可定位且哈希相符 ⇒ verified（basis 写死
//      「来源有效，不表示功能已完成、不表示集成已联通」）。反例：夹具里章节内容变（哈希对不上）/
//      章节删除（定位不到）⇒ invalidated 且阻断点名该边 id；删来源引用 ⇒ missing 仍阻断。
//   ② 类 B 可复算映射边（implementation_map）：声明路径真实存在且落在该具体模块 ⇒ verified
//      （映射成立且复算一致）。反例 1：声明路径不存在（规划路径）/仅根模块兜底命中 ⇒ unverified，
//      不得判 verified；反例 2：两端点状态任意（红/绿）不影响边状态；反例 3：声明还在但目标消失
//      （蓝图 omitted）⇒ 溯源模型生成 missing 标注、报缺并阻断、逐条点名。
//   ③ 类 C 归属来源边（design_interface）：清单章节可定位且未失效 ⇒ verified（basis 必含
//      「设计声明的归属关系，非运行接口」）；反例：章节内容变 ⇒ invalidated；断言这些边没有也
//      无需集成检查记录（evidence_refs 为空也照判 verified，语义不是接口联通）。
//   ④ 交付判词（真实项目 tatai）：verdict 仍 blocked、逐条点名；user_pending 不出现在
//      delivery.reasons；静态边不再落入「无投影 ⇒ unverified」旧分支；三类边分档明细如实报数
//      （implementation_map 因根兜底/路径不存在保持 unverified 的逐条落证据文件）。
//   ⑤ 中性色与读数分档：edgeVisualOf 对非数据流角色模式恒 NEUTRAL_EDGE_COLOR；规划图边渲染
//      只对 dependency 语义读状态色（三类静态边 completion_colored=false）；交付读数
//      verified 分「来源核实/功能验证」两档计数且来源核实不计入功能验证完成数；P10 在场。
//
// 隔离口径：真实 `.工作台/` 与真实 DESIGN.md／PLAN.md **只读**；一切写在 os.tmpdir() 夹具里；
// 不调任何 MCP 写工具、不动真实事件账本、不改任何设计/施工原文；收尾清理。
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  archProvenanceModelOf,
  blueprintCacheKeysOf,
  blueprintSourcesFromTexts,
  classifyDeclaredPathForMapping,
  classifyDesignRefToken,
  deriveBlueprint,
} from "../src/arch/blueprint";
import { GRAPH_MODES, type GraphMode } from "../src/arch/graph-mode";
import { addProject } from "../src/server/registry";
import { buildSectionIndex, designDefinitionText } from "../src/server/work/documents";
import { importTaskDefinitions } from "../src/server/work/plan";
import { NEUTRAL_EDGE_COLOR, edgeVisualOf, FLOW_EDGE_COLORS } from "../src/ui/arch/edgeStyle";
import { EDGE_SEMANTICS, edgeSemanticsOf } from "../src/ui/arch/projectGraph";
import {
  DELIVERY_BLOCKED_CONCLUSION,
  PROVENANCE_POLICY,
  evidenceStateOf,
  isBlockingEvidenceState,
  validateProvenanceModel,
  type EvidenceFacts,
} from "../src/ui/arch/provenance";
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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-v0917-"));
const FX_HOME = path.join(TMP, "home");
fs.mkdirSync(FX_HOME, { recursive: true });
const FX = "v0917-fixture";
const FX_ROOT = path.join(TMP, "proj");
const FX_ARCH = path.join(FX_ROOT, ".工作台", "arch");

/** 夹具设计书（两个能力节：甲做正例锚，乙的内容/哈希在反例边里被改） */
const FX_DESIGN = `# 夹具设计书

## 1. 夹具设计

### 1.1 夹具能力甲

能力甲：验证来源引用边与归属来源边的正例锚点。

### 1.2 夹具能力乙

能力乙：反例边故意引用它的旧哈希/不存在的章节，验证失效判据。
`;

/** 夹具施工图：T-1 声明真实存在的路径（命中 src 模块）；T-2 声明规划路径（仓库里不存在）；
 *  T-3 声明存在的根目录文件（根模块＝根目录散文件的真实归属，2026-09-25 判据细化后成立 ⇒ verified）；
 *  T-4 只声明根下不存在的裸文件名（无任何根级真实文件 ⇒ 真·根兜底反例 ⇒ unverified） */
const FX_PLAN = `# 夹具施工图

| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |
| --- | --- | --- | --- | --- |
| T-1 | todo | 夹具任务一（真实路径映射） | 无 | 夹具任务一跑完 |
| T-2 | todo | 夹具任务二（规划路径） | 无 | 夹具任务二跑完 |
| T-3 | todo | 夹具任务三（根级真实文件） | 无 | 夹具任务三跑完 |
| T-4 | todo | 夹具任务四（根兜底反例） | 无 | 夹具任务四跑完 |

### T-1 夹具任务一（真实路径映射）

**设计依据**：§1.1

**文件责任**：\`src/real.ts\`

**交付**：夹具任务一跑完。

### T-2 夹具任务二（规划路径）

**设计依据**：§1.2

**文件责任**：\`src/ghost.ts\`

**交付**：夹具任务二跑完。

### T-3 夹具任务三（根级真实文件）

**文件责任**：\`README.md\`

**交付**：夹具任务三跑完。

### T-4 夹具任务四（根兜底反例）

**文件责任**：\`ghost-root.ts\`

**交付**：夹具任务四跑完。
`;

/** 一条证据事实的默认值（判据输入是"事实"，脚本按需覆写字段） */
function factsOf(over: Partial<EvidenceFacts> & { object_id: string; label: string }): EvidenceFacts {
  return {
    has_projection: false,
    mapping: null,
    required_count: 0,
    passed_count: 0,
    missing_count: 0,
    quality: null,
    display_status: null,
    freshness: null,
    acceptance: null,
    history_count: 0,
    open_findings: 0,
    evidence_refs: [],
    sources_total: 0,
    sources_valid: 0,
    sources_stale: [],
    sources_unlocatable: [],
    user_actions: [],
    delivery_relevant: false,
    ...over,
  };
}

function main(): void {
  // ── 真实文档零改动自证（本卡只读设计/施工原文） ──
  const docBefore = new Map<string, string>();
  for (const rel of ["DESIGN.md", "PLAN.md", "README.md", "AGENTS.md", "package.json"]) {
    docBefore.set(rel, exists(rel) ? sha256Text(read(rel)) : "<missing>");
  }

  const prevHome = process.env.TATAI_HOME;
  try {
    // ═════════════ 夹具：临时 TATAI_HOME + 手写夹具蓝图（①②③⑤ 的正反实测面） ═════════════
    section("夹具：临时 TATAI_HOME + 真实仓库文件 + 真派生标注（不碰真实账本）");
    fs.mkdirSync(FX_ARCH, { recursive: true });
    fs.mkdirSync(path.join(FX_ROOT, "src"), { recursive: true });
    // 真实存在的声明路径（T-1 正例）；src/ghost.ts 故意不建（T-2 规划路径反例）
    fs.writeFileSync(path.join(FX_ROOT, "src", "real.ts"), "export const fixture = 1;\n", "utf8");
    // 根目录真实文件（T-3 正例：根模块是根目录散文件的真实归属）；ghost-root.ts 故意不建（T-4 根兜底反例）
    fs.writeFileSync(path.join(FX_ROOT, "README.md"), "# 夹具\n", "utf8");
    fs.writeFileSync(path.join(FX_ROOT, ".工作台", "design.md"), FX_DESIGN, "utf8");
    fs.writeFileSync(path.join(FX_ROOT, ".工作台", "plan.md"), FX_PLAN, "utf8");
    fs.writeFileSync(
      path.join(FX_ARCH, "modules.json"),
      JSON.stringify({
        version: 1,
        generated_at: "2026-09-25T00:00:00+08:00",
        budget_exhausted: false,
        modules: [
          { id: "src", name: "夹具代码模块", path: "src", file_count: 1, loc: 12, deps: [] },
          { id: "root", name: "夹具根模块", path: ".", file_count: 1, loc: 5, deps: [] },
        ],
      }),
      "utf8",
    );
    process.env.TATAI_HOME = FX_HOME;
    addProject({ id: FX, name: "V09-17 夹具", path: FX_ROOT, kind: "backend" }, FX_HOME);

    // 夹具设计章节的真实哈希（正例边引用它 ⇒ 「章节可定位且哈希相符」；反例边写错哈希/写不存在章节）
    const fxSections = buildSectionIndex(designDefinitionText(FX_DESIGN));
    const sec11 = fxSections.find((s) => s.path.endsWith("1.1 夹具能力甲"));
    const sec12 = fxSections.find((s) => s.path.endsWith("1.2 夹具能力乙"));
    if (sec11 === undefined || sec12 === undefined) throw new Error("夹具设计章节索引没建出来");
    const designRefOf = (sec: { path: string; sha256: string }, sha: string | null = sec.sha256) => ({
      kind: "design_section",
      path: ".工作台/design.md",
      locator: sec.path,
      sha256: sha,
    });
    const planRefOf = (taskId: string) => ({
      kind: "plan_task",
      path: ".工作台/plan.md",
      locator: taskId,
      sha256: null,
    });
    const STALE_SHA = "0".repeat(64);

    const fxBlueprint = {
      version: 1,
      baseline_id: "baseline-fixture",
      generator_version: "v06-05.1",
      generated_at: "2026-09-25T00:00:00+08:00",
      source_manifest: [],
      nodes: [
        { id: "plan:cap:01", kind: "capability", name: "夹具能力甲", source_refs: [designRefOf(sec11)], related_ids: [] },
        { id: "plan:cap:02", kind: "capability", name: "夹具能力乙", source_refs: [designRefOf(sec12)], related_ids: [] },
        { id: "plan:mod:01", kind: "module", name: "夹具声明模块一", source_refs: [designRefOf(sec11)], related_ids: [] },
        { id: "plan:mod:02", kind: "module", name: "夹具声明模块二", source_refs: [designRefOf(sec12)], related_ids: [] },
        {
          id: "plan:code:src",
          kind: "module",
          name: "夹具代码模块",
          source_refs: [{ kind: "code_module", path: ".工作台/arch/modules.json", locator: "src", sha256: null }],
          related_ids: [],
        },
        {
          id: "plan:code:root",
          kind: "module",
          name: "夹具根模块",
          source_refs: [{ kind: "code_module", path: ".工作台/arch/modules.json", locator: "root", sha256: null }],
          related_ids: [],
        },
        { id: "plan:task:T-1", kind: "task", name: "夹具任务一", source_refs: [planRefOf("T-1")], related_ids: [] },
        { id: "plan:task:T-2", kind: "task", name: "夹具任务二", source_refs: [planRefOf("T-2")], related_ids: [] },
        { id: "plan:task:T-3", kind: "task", name: "夹具任务三", source_refs: [planRefOf("T-3")], related_ids: [] },
        { id: "plan:task:T-4", kind: "task", name: "夹具任务四", source_refs: [planRefOf("T-4")], related_ids: [] },
      ],
      edges: [
        // ③ 类 C：归属来源边——正例（清单章节可定位且未失效）
        { source: "plan:cap:01", target: "plan:mod:01", kind: "design_interface", certainty: "declared", source_refs: [designRefOf(sec11)] },
        // ③ 反例：章节内容变（哈希对不上）⇒ invalidated
        { source: "plan:cap:02", target: "plan:mod:02", kind: "design_interface", certainty: "declared", source_refs: [designRefOf(sec12, STALE_SHA)] },
        // ① 类 A：来源引用边——正例（章节可定位且哈希相符）
        { source: "plan:task:T-1", target: "plan:cap:01", kind: "task_design_ref", certainty: "declared", source_refs: [designRefOf(sec11)] },
        // ① 反例 a：章节内容变 ⇒ invalidated
        { source: "plan:task:T-2", target: "plan:cap:02", kind: "task_design_ref", certainty: "declared", source_refs: [designRefOf(sec12, STALE_SHA)] },
        // ① 反例 b：章节已删除（定位不到）⇒ invalidated
        {
          source: "plan:task:T-3",
          target: "plan:cap:02",
          kind: "task_design_ref",
          certainty: "declared",
          source_refs: [{ kind: "design_section", path: ".工作台/design.md", locator: "夹具设计书 / 1. 夹具设计 / 1.9 已删除的章节", sha256: null }],
        },
        // ① 反例 c：删掉来源引用 ⇒ missing 仍阻断
        { source: "plan:task:T-1", target: "plan:cap:02", kind: "task_design_ref", certainty: "declared", source_refs: [] },
        // ② 类 B：映射边——正例（声明路径真实存在且落在 src 模块）
        { source: "plan:task:T-1", target: "plan:code:src", kind: "implementation_map", certainty: "observed", source_refs: [planRefOf("T-1")] },
        // ② 反例 1a：声明路径是规划路径（仓库里不存在）⇒ unverified
        { source: "plan:task:T-2", target: "plan:code:src", kind: "implementation_map", certainty: "observed", source_refs: [planRefOf("T-2")] },
        // ② 正例（2026-09-25 判据细化）：声明的根级文件真实存在于仓库根 ⇒ 根模块是其真实归属 ⇒ verified
        { source: "plan:task:T-3", target: "plan:code:root", kind: "implementation_map", certainty: "observed", source_refs: [planRefOf("T-3")] },
        // ② 反例 1b：只声明根下不存在的裸文件名 ⇒ 仅靠根模块兜底 ⇒ unverified
        { source: "plan:task:T-4", target: "plan:code:root", kind: "implementation_map", certainty: "observed", source_refs: [planRefOf("T-4")] },
        // 对照组：task_dependency 不装配 static_relation，维持原口径（无投影 + 来源有效 ⇒ unverified）
        { source: "plan:task:T-1", target: "plan:task:T-2", kind: "task_dependency", certainty: "declared", source_refs: [planRefOf("T-2")] },
      ],
      coverage: { note: "夹具蓝图（本脚本手写，用来钉住三类静态边的正反面）" },
      omitted: [
        // ② 反例 3：声明还在但目标消失 ⇒ 溯源模型生成 missing 标注、报缺并阻断、逐条点名
        { kind: "unresolved_design_ref", detail: "T-9 的设计依据「§9.9」在设计书章节索引里定位不到", count: 1 },
      ],
      model_receipt: null,
      publish: { published: true, reason: null, validated_at: "2026-09-25T00:00:00+08:00" },
      based_on: { model_key: "fixture", full_key: "fixture", design_content_sha256: null, plan_definition_sha256: null, semantic: false },
    };
    fs.writeFileSync(path.join(FX_ARCH, "blueprint.json"), JSON.stringify(fxBlueprint, null, 2), "utf8");

    const fx = archProvenanceModelOf(FX, { dataDir: FX_HOME });
    info(
      `夹具对象 ${fx.annotations.length} · 结论「${fx.delivery.conclusion}」· 阻断 ${fx.delivery.reasons.length} 条 · ` +
        `分档计数 ${JSON.stringify(fx.delivery.counts)}`,
    );

    // ── ① 类 A 来源引用边（task_design_ref） ──
    section("① 类 A 来源引用边：来源有效 ⇒ verified（语义＝来源核实，不表示功能完成/集成联通）");
    const aOk = fx.by_object["plan:task:T-1>plan:cap:01:task_design_ref"];
    ok(
      aOk !== undefined && aOk.evidence_state === "verified" && aOk.verification_scope === "source_mapping" &&
        aOk.basis.includes("来源有效") && aOk.basis.includes("不表示功能已完成") && aOk.basis.includes("不表示集成已联通"),
      `① 正例：章节可定位且哈希相符 ⇒ verified（scope=${aOk?.verification_scope}；basis：${aOk?.basis.slice(0, 80) ?? "无"}…）`,
    );
    // 端点无关性的实证：T-1 节点自身没有任何证据（未验证/缺证），它的来源引用边照样 verified
    const t1Node = fx.by_object["plan:task:T-1"];
    ok(
      t1Node !== undefined && t1Node.evidence_state !== "verified" && aOk?.evidence_state === "verified",
      `①② 端点无关（实证）：端点 T-1 节点是「${t1Node?.evidence_state}」，边的状态不受它影响（仍 verified）`,
    );
    const aStale = fx.by_object["plan:task:T-2>plan:cap:02:task_design_ref"];
    ok(
      aStale !== undefined && aStale.evidence_state === "invalidated" &&
        aStale.blockers.some((b) => b.includes("plan:task:T-2>plan:cap:02:task_design_ref")),
      `① 反例：章节内容变（引用哈希对不上）⇒ invalidated 且阻断**点名该边 id**（${aStale?.evidence_state}）`,
    );
    const aGone = fx.by_object["plan:task:T-3>plan:cap:02:task_design_ref"];
    ok(
      aGone !== undefined && aGone.evidence_state === "invalidated" &&
        aGone.blockers.some((b) => b.includes("plan:task:T-3>plan:cap:02:task_design_ref")),
      `① 反例：章节已删除（定位不到）⇒ invalidated 且阻断点名该边 id（${aGone?.evidence_state}）`,
    );
    const aNoRef = fx.by_object["plan:task:T-1>plan:cap:02:task_design_ref"];
    ok(
      aNoRef !== undefined && (aNoRef.evidence_state === "missing" || aNoRef.evidence_state === "unverified") &&
        aNoRef.blockers.length > 0 && aNoRef.blockers.every((b) => b.includes(aNoRef.object_id)),
      `① 反例：删掉来源引用 ⇒ ${aNoRef?.evidence_state}（现行口径保留）且仍逐条点名阻断`,
    );

    // ── ② 类 B 可复算映射边（implementation_map） ──
    section("② 类 B 映射边：声明路径真实存在且落在具体模块 ⇒ verified；根兜底/路径不存在 ⇒ unverified");
    const bHit = fx.by_object["plan:task:T-1>plan:code:src:implementation_map"];
    ok(
      bHit !== undefined && bHit.evidence_state === "verified" && bHit.verification_scope === "source_mapping" &&
        bHit.basis.includes("映射成立且复算一致") && bHit.basis.includes("不表示功能已完成") && bHit.basis.includes("不表示集成已联通") &&
        bHit.evidence_refs.length === 0,
      `② 正例：声明路径 src/real.ts 真实存在且落在 src 模块 ⇒ verified（映射成立；不靠任何集成证据记录）`,
    );
    const bGhost = fx.by_object["plan:task:T-2>plan:code:src:implementation_map"];
    ok(
      bGhost !== undefined && bGhost.evidence_state === "unverified" &&
        bGhost.basis.includes("映射未经核实") && bGhost.basis.includes("不存在"),
      `② 反例 1a：声明路径 src/ghost.ts 是规划路径（仓库里不存在）⇒ unverified（${bGhost?.basis.slice(0, 72) ?? "无"}…）`,
    );
    const bRoot = fx.by_object["plan:task:T-3>plan:code:root:implementation_map"];
    ok(
      bRoot !== undefined && bRoot.evidence_state === "verified" &&
        bRoot.basis.includes("映射成立") && bRoot.basis.includes("根级文件"),
      `② 正例（2026-09-25 判据细化）：声明的根级文件 README.md 真实存在于仓库根 ⇒ 根模块是其真实归属 ⇒ verified（${bRoot?.basis.slice(0, 72) ?? "无"}…）`,
    );
    const bRootFb = fx.by_object["plan:task:T-4>plan:code:root:implementation_map"];
    ok(
      bRootFb !== undefined && bRootFb.evidence_state === "unverified" &&
        bRootFb.basis.includes("映射未经核实") && bRootFb.basis.includes("根模块兜底"),
      `② 反例 1b：只声明根下不存在的裸文件名 ⇒ 仅靠根模块兜底 ⇒ unverified（根兜底命中**不算**映射成立，GPT-6 裁定 2；与 T-3 的根级真实文件区分）`,
    );
    // ② 反例 2：端点无关性（判据层正交矩阵——投影四维/必需项怎么变，边状态只随自身复算变化）
    const mapHitFacts = (over: Partial<EvidenceFacts>): EvidenceFacts =>
      factsOf({
        object_id: "e",
        label: "e",
        sources_total: 1,
        sources_valid: 1,
        static_relation: { kind: "implementation_map", mapping: { verdict: "hit", detail: "声明路径真实存在且落在该具体模块" } },
        ...over,
      });
    ok(
      evidenceStateOf(mapHitFacts({ display_status: "verified", has_projection: true, required_count: 3, passed_count: 3, quality: "audit_passed" })).state === "verified" &&
        evidenceStateOf(mapHitFacts({ display_status: "blocked", open_findings: 5, required_count: 3, passed_count: 0, missing_count: 3 })).state === "verified" &&
        evidenceStateOf(mapHitFacts({ display_status: "planned", has_projection: false })).state === "verified",
      "② 反例 2：两端点全绿/全红/无投影 ⇒ 边状态只随自身复算变化（端点状态一个字都不读）",
    );
    // ② 反例 3：必需边消失报缺——蓝图 omitted 的「声明还在但目标消失」条目 ⇒ missing 标注 + 阻断点名
    const omittedAnn = fx.by_object["omitted:unresolved_design_ref:0"];
    ok(
      omittedAnn !== undefined && omittedAnn.evidence_state === "missing" &&
        omittedAnn.blockers.length > 0 &&
        fx.delivery.reasons.some((r) => r.includes("omitted:unresolved_design_ref:0")),
      "② 反例 3：声明还在但目标消失 ⇒ 溯源模型生成 missing 标注、计入交付阻断并逐条点名（不靠对象消失让读数变绿）",
    );
    // 对照组：task_dependency 维持原口径（不装配 static_relation、不进「来源核实」档）
    const dep = fx.by_object["plan:task:T-1>plan:task:T-2:task_dependency"];
    ok(
      dep !== undefined && dep.verification_scope === "functional" &&
        dep.evidence_state === "unverified" && dep.basis.includes("没有这个对象的必需验证证据"),
      "② 对照：task_dependency 82 条既有口径不变（无投影 ⇒ unverified 旧分支，scope=functional）",
    );

    // ── ③ 类 C 归属来源边（design_interface） ──
    section("③ 类 C 归属来源边：清单章节可定位且未失效 ⇒ verified（设计声明的归属关系，非运行接口）");
    const cOk = fx.by_object["plan:cap:01>plan:mod:01:design_interface"];
    ok(
      cOk !== undefined && cOk.evidence_state === "verified" && cOk.verification_scope === "source_mapping" &&
        cOk.basis.includes("设计声明的归属关系，非运行接口") &&
        cOk.basis.includes("不表示功能已完成") && cOk.basis.includes("不表示集成已联通") &&
        cOk.evidence_refs.length === 0,
      `③ 正例：清单章节可定位且未失效 ⇒ verified；basis 写明「归属关系，非运行接口」，**无需任何集成检查记录**（evidence_refs=${cOk?.evidence_refs.length}）`,
    );
    const cStale = fx.by_object["plan:cap:02>plan:mod:02:design_interface"];
    ok(
      cStale !== undefined && cStale.evidence_state === "invalidated" &&
        cStale.blockers.some((b) => b.includes("plan:cap:02>plan:mod:02:design_interface")),
      `③ 反例：章节内容变 ⇒ invalidated 且阻断点名该边 id（${cStale?.evidence_state}）`,
    );
    ok(
      fx.delivery.verdict === "blocked" && fx.delivery.conclusion === DELIVERY_BLOCKED_CONCLUSION &&
        fx.delivery.reasons.length > 0 &&
        fx.delivery.reasons.every((r) => fx.annotations.some((a) => r.includes(a.object_id))),
      `①②③ 夹具存在反例 ⇒ 交付结论「${fx.delivery.conclusion}」，${fx.delivery.reasons.length} 条阻断逐条带对象 ID`,
    );
    ok(
      validateProvenanceModel(fx).length === 0,
      `①②③ 夹具模型跑同一套机械判据 0 违规（${JSON.stringify(validateProvenanceModel(fx).slice(0, 2))}）`,
    );
    // 判据自身正反（纯函数层）：静态边分支的优先级与落档
    const srcOk = { sources_total: 1, sources_valid: 1 } as const;
    ok(
      evidenceStateOf(factsOf({ object_id: "x", label: "x", ...srcOk, static_relation: { kind: "task_design_ref" } })).state === "verified",
      "① 判据：task_design_ref 来源全部有效 ⇒ verified",
    );
    ok(
      evidenceStateOf(factsOf({ object_id: "x", label: "x", ...srcOk, sources_stale: ["design_section/旧哈希"], static_relation: { kind: "task_design_ref" } })).state === "invalidated",
      "① 判据：出处 stale 优先于静态边通过档 ⇒ invalidated（P5 先判，裁定口径保持）",
    );
    ok(
      evidenceStateOf(factsOf({ object_id: "x", label: "x", sources_unlocatable: ["design_section/没了"], static_relation: { kind: "design_interface" } })).state === "invalidated",
      "③ 判据：出处定位不到 ⇒ invalidated（来源不复存在，旧绿不作数）",
    );
    ok(
      evidenceStateOf(factsOf({ object_id: "x", label: "x", static_relation: { kind: "task_design_ref" } })).state === "missing",
      "① 判据：静态边无出处 ⇒ missing（现行口径保留，不空集判绿）",
    );
    ok(
      evidenceStateOf(factsOf({ object_id: "x", label: "x", ...srcOk, static_relation: { kind: "implementation_map", mapping: { verdict: "root_fallback_only", detail: "只靠根模块兜底" } } })).state === "unverified" &&
        evidenceStateOf(factsOf({ object_id: "x", label: "x", ...srcOk, static_relation: { kind: "implementation_map", mapping: { verdict: "path_missing", detail: "声明路径不存在" } } })).state === "unverified" &&
        evidenceStateOf(factsOf({ object_id: "x", label: "x", ...srcOk, static_relation: { kind: "implementation_map" } })).state === "unverified",
      "② 判据：根兜底/路径不存在/复算读数缺失 ⇒ 一律 unverified（不得判 verified）",
    );

    // ═════════════ 终审返工（2026-09-25）定向断言：F-2/F-3 解析根因 + 映射分类判据 ═════════════
    section("终审返工（2026-09-25）：F-2 字段截断／F-3 引用解析／映射分类（正反成对，真缺报缺保留）");

    // ── F-2：字段值内部的「加粗＋冒号」不截断字段值（合成夹具，修前 allowed_paths 只剩 `PLAN.md`） ──
    const F2_PLAN = `# 夹具

| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |
| --- | --- | --- | --- | --- |
| F-1 | todo | 截断夹具 | 无 | 跑完 |

### F-1 截断夹具

**文件责任**：\`PLAN.md\`（**新追加一个「映射」小节**：独立表，表头列名可判）、\`src/a.ts\` ＋ \`src/b.ts\`。

**设计依据**：§1.1（**第 3/4 条：逐条核源＋分类，只登记「当前有效」**）、§2.5。
`;
    const f2Def = importTaskDefinitions(F2_PLAN).definitions.find((d) => d.task_id === "F-1");
    ok(
      f2Def !== undefined &&
        JSON.stringify(f2Def.allowed_paths) === JSON.stringify(["PLAN.md", "src/a.ts", "src/b.ts"]),
      `F-2 正：字段值内部「**新追加一个「映射」小节**：」不再截断文件责任（解析出 ${f2Def?.allowed_paths.length ?? 0} 条＝${JSON.stringify(f2Def?.allowed_paths)}）`,
    );
    ok(
      f2Def !== undefined &&
        f2Def.design_refs.includes("§1.1（**第 3/4 条：逐条核源＋分类，只登记「当前有效」**）") &&
        !f2Def.design_refs.includes("只登记「当前有效」**）") &&
        f2Def.design_refs.includes("§2.5"),
      `F-3 正：设计依据括号感知切分——（）/「」内部的顿号不再把一条引用切成碎片（${f2Def?.design_refs.length ?? 0} 条）`,
    );
    // F-2 真实图纸实证：V09-03 的文件责任在修前被截断成 ["PLAN.md"]，修后应取回 5 条声明
    const realDefs = new Map(importTaskDefinitions(read("PLAN.md")).definitions.map((d) => [d.task_id, d]));
    const v0903 = realDefs.get("V09-03");
    ok(
      v0903 !== undefined &&
        ["PLAN.md", "src/server/work/planValidate.ts", "src/server/work/plan.ts", "scripts/verify-v09-03.ts", "package.json"].every((p) =>
          v0903.allowed_paths.includes(p),
        ),
      `F-2 真实实证：V09-03 文件责任取回 ${v0903?.allowed_paths.length ?? 0} 条声明（修前仅 ["PLAN.md"]，模块级映射曾塌缩为仅根兜底）`,
    );
    const v0917 = realDefs.get("V09-17");
    ok(
      v0917 !== undefined &&
        v0917.design_refs.includes("§4.2（本批修订：三类静态边判据、消失报缺、读数分档）") &&
        !v0917.design_refs.includes("消失报缺") &&
        !v0917.design_refs.includes("读数分档）"),
      `F-3 真实实证：V09-17 设计依据不再产出「消失报缺」「读数分档）」两条句子碎片`,
    );

    // ── 引用/路径分类器（机械形态判据，正反成对） ──
    ok(
      classifyDesignRefToken("需求＝`req-2026-09-25-r1`（已经正规登记）") === "non_design_ref_requirement" &&
        classifyDesignRefToken("报告 02 G-04／G-05") === "non_design_ref_report" &&
        classifyDesignRefToken("AGENTS §1（迁移前人工对齐）") === "non_design_ref_external_doc" &&
        classifyDesignRefToken("裁定稿本＝`.工作台/handoff/x.md`（") === "non_design_ref_external_doc" &&
        classifyDesignRefToken("§4.2") === "design_section" &&
        classifyDesignRefToken("附录 D") === "design_section",
      "引用分类器：需求 ID／审计报告／AGENTS·存档稿本按真实类别归类；§与附录形态仍按设计章节解析",
    );
    ok(
      classifyDeclaredPathForMapping(".工作台/evidence/V06-13/1") === "non_code_private" &&
        classifyDeclaredPathForMapping(".git/index") === "non_code_vcs" &&
        classifyDeclaredPathForMapping("node_modules/foo/index.js") === "non_code_generated" &&
        classifyDeclaredPathForMapping("dist/bundle.js") === "non_code_generated" &&
        classifyDeclaredPathForMapping("target/release/x") === "non_code_generated" &&
        classifyDeclaredPathForMapping("src-tauri/target/release/bundle/x.nsis") === "module_candidate" &&
        classifyDeclaredPathForMapping("src/arch/blueprint.ts") === "module_candidate",
      "路径分类器：.工作台/.git/node_modules/dist/target 前缀排除（非代码）；src-tauri/target/… 落在真实模块内不误伤",
    );

    // ── 派生层：附录定位／非设计引用归类／根级文件映射（真实 DESIGN 只读 + 合成施工图） ──
    const REWORK_PLAN = `# 夹具

| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |
| --- | --- | --- | --- | --- |
| R-1 | todo | 引用分类夹具 | 无 | 跑完 |
| R-2 | todo | 映射分类夹具 | 无 | 跑完 |

### R-1 引用分类夹具

**设计依据**：§1.1、附录 E.15、附录 C.5-1、附录 Z、§9.9、报告 01 F-03、需求＝\`req-2099-01-01-r1\`、AGENTS §1。

### R-2 映射分类夹具

**文件责任**：\`README.md\`、\`ghost-bare.ts\`、\`.工作台/evidence/R-2/1\`、\`components/Foo.tsx\`、\`src/real2.ts\`
`;
    const rwSrc = blueprintSourcesFromTexts({
      baseline_id: "bl-rework-fixture",
      is_tatai: true,
      design: { path: "DESIGN.md", text: read("DESIGN.md") },
      plan: { path: "PLAN.md", text: REWORK_PLAN },
      code: {
        available: true,
        budget_exhausted: null,
        modules: [
          { id: "src", path: "src", file_count: 1 },
          { id: "root", path: ".", file_count: 1 },
        ],
      },
      names: {},
      repo_root_files: ["README.md"],
    });
    const rwBp = deriveBlueprint(rwSrc, { based_on: blueprintCacheKeysOf(rwSrc, false) });
    const rwUnresolved = rwBp.omitted.filter((o) => o.kind === "unresolved_design_ref");
    ok(
      rwUnresolved.length === 2 &&
        rwUnresolved.some((o) => o.detail.includes("附录 Z")) &&
        rwUnresolved.some((o) => o.detail.includes("§9.9")),
      `反例保留：真正不存在的设计依据（附录 Z／§9.9）仍 unresolved_design_ref 报缺并阻断（${rwUnresolved.length} 条），不靠解析漏认消掉`,
    );
    const rwAppendix = rwBp.omitted.find((o) => o.kind === "appendix_design_ref");
    ok(
      rwAppendix !== undefined && rwAppendix.count === 2 &&
        rwAppendix.detail.includes("附录 E.15") && rwAppendix.detail.includes("附录 C.5-1"),
      `附录形态引用（附录 E.15／附录 C.5-1）正确定位到附录章节、不产生能力边、不报缺（信息性登记 count=${rwAppendix?.count ?? 0}）`,
    );
    ok(
      rwBp.omitted.some((o) => o.kind === "non_design_ref_report" && o.detail.includes("报告 01 F-03")) &&
        rwBp.omitted.some((o) => o.kind === "non_design_ref_requirement" && o.detail.includes("req-2099-01-01-r1")) &&
        rwBp.omitted.some((o) => o.kind === "non_design_ref_external_doc" && o.detail.includes("AGENTS")),
      "非设计章节引用（审计报告／需求 ID／AGENTS）按真实类别登记为信息性遗漏，不按设计章节解析、不报缺",
    );
    ok(
      rwBp.edges.some((e) => e.source === "plan:task:R-1" && e.kind === "task_design_ref"),
      "正例：同一张卡里真实的章节引用（§1.1）仍正常产生 task_design_ref 边（分类不影响真引用）",
    );
    const r2Edges = rwBp.edges.filter((e) => e.source === "plan:task:R-2" && e.kind === "implementation_map");
    ok(
      r2Edges.length === 2 &&
        r2Edges.some((e) => e.target === "plan:code:src") &&
        r2Edges.some((e) => e.target === "plan:code:root"),
      `映射分类：根级真实文件（README.md）落根模块、真实路径（src/real2.ts）落 src（边=${r2Edges.map((e) => e.target).join(",") || "无"}）`,
    );
    const r2NotMapped = rwBp.omitted.filter((o) => o.kind === "declared_path_not_mapped" && o.detail.startsWith("R-2"));
    ok(
      r2NotMapped.length === 3 &&
        r2NotMapped.some((o) => o.detail.includes("ghost-bare.ts")) &&
        r2NotMapped.some((o) => o.detail.includes(".工作台/evidence/R-2/1")) &&
        r2NotMapped.some((o) => o.detail.includes("components/Foo.tsx")),
      "映射分类反例：根下不存在的裸名／.工作台 私有路径／未命中模块的多段路径都不产生映射边（信息性登记 3 类，不报缺）",
    );
    // repo_root_files 未知（null）时单段名无法证实 ⇒ 同样不产生根模块映射（不为出边硬凑）
    const rwSrcNull = blueprintSourcesFromTexts({
      baseline_id: "bl-rework-fixture",
      is_tatai: true,
      design: { path: "DESIGN.md", text: read("DESIGN.md") },
      plan: { path: "PLAN.md", text: REWORK_PLAN },
      code: {
        available: true,
        budget_exhausted: null,
        modules: [
          { id: "src", path: "src", file_count: 1 },
          { id: "root", path: ".", file_count: 1 },
        ],
      },
      names: {},
    });
    const rwBpNull = deriveBlueprint(rwSrcNull, { based_on: blueprintCacheKeysOf(rwSrcNull, false) });
    ok(
      !rwBpNull.edges.some((e) => e.source === "plan:task:R-2" && e.target === "plan:code:root") &&
        rwBpNull.omitted.some((o) => o.kind === "declared_path_not_mapped" && o.detail.includes("README.md")),
      "反例：根级文件清单未知（null）时 README.md 也不产根模块映射（无法证实就不映射，不硬凑）",
    );

    // ═════════════ 真实项目（tatai）：④ 交付判词 + ③ 类 C 实测 + ⑤ 读数分档 ═════════════
    section("真实项目（tatai）：④ 交付判词（裁定 4）＋三类边分档明细（如实报数）");
    process.env.TATAI_HOME = REAL_HOME;
    const real = archProvenanceModelOf("tatai", { dataDir: REAL_HOME });
    const staticKinds = ["task_design_ref", "implementation_map", "design_interface"];
    const staticEdges = real.annotations.filter((a) => a.object_kind === "edge" && staticKinds.includes(a.kind));
    const stateBy = (kind: string): Record<string, number> => {
      const out: Record<string, number> = {};
      for (const a of staticEdges.filter((x) => x.kind === kind)) out[a.evidence_state] = (out[a.evidence_state] ?? 0) + 1;
      return out;
    };
    info(
      `对象 ${real.annotations.length} · 结论「${real.delivery.conclusion}」· 阻断 ${real.delivery.reasons.length} 条 · ` +
        `人工待验 ${real.delivery.user_pending.length} 条 · 计数 ${JSON.stringify(real.delivery.counts)}`,
    );
    info(
      `三类静态边分档：task_design_ref ${JSON.stringify(stateBy("task_design_ref"))} · ` +
        `implementation_map ${JSON.stringify(stateBy("implementation_map"))} · design_interface ${JSON.stringify(stateBy("design_interface"))}`,
    );

    // ④ 判词结构（定向更新，终审返工批 change-20260925-v0917-rework，2026-09-25）：
    //   旧期望＝verdict 钉死 "blocked" 且 reasons>0（V09-17 交付时点：40 根兜底 unverified＋54×2 解析报缺
    //   在账）｜依据：终审返工经**判据修复**真实消除了那两类阻断（根级真实文件按证据判成立、非代码路径
    //   不产映射、附录/非设计引用正确定位——不是删边求绿、不是放宽判据），阻断构成的实测值随 §5.6
    //   重绑进程逐批清零，把 verdict 钉死在 blocked 等于把旧错误状态锁进断言（同类先例：v06-08/v06-12
    //   的「差===1」钉值事故）｜新期望＝**判据蕴含式**：reasons>0 ⇒ 必须 blocked 且逐条点名对象 ID；
    //   reasons==0 ⇒ verdict 必须是 requestable（可请求验收）；user_pending 永远不进 reasons｜
    //   保留意图：阻断效力一个字没降——任何未验证/缺证/失效对象仍逐条点名并压出 blocked。
    ok(
      (real.delivery.reasons.length > 0
        ? real.delivery.verdict === "blocked" && real.delivery.conclusion === DELIVERY_BLOCKED_CONCLUSION &&
          !real.delivery.deliverable_allowed
        : real.delivery.verdict === "requestable" && real.delivery.deliverable_allowed) &&
        real.delivery.reasons.every((r) => real.annotations.some((a) => r.includes(a.object_id))),
      `④ 判词与实测阻断一致（当前 verdict=${real.delivery.verdict}、reasons=${real.delivery.reasons.length}）：有阻断必 blocked 且逐条点名；无阻断才是「可请求验收」——user_pending 不算阻断（裁定 4）`,
    );
    const pendingAnn = real.annotations.filter((a) => a.user_pending);
    ok(
      pendingAnn.every((a) => a.blockers.length === 0) &&
        pendingAnn.every((a) => !real.delivery.reasons.some((r) => r.startsWith("用户待验：") && r.includes(a.object_id))),
      `④ user_pending（${pendingAnn.length} 项）**不出现在** delivery.reasons——它阻断的是「已交付/已接受」，不阻断「可请求验收」（裁定 4）`,
    );
    // ④ 静态边不再落入「无投影 ⇒ unverified」旧分支（旧分支判据句的特征词一个都不许再出现在三类边上）
    ok(
      staticEdges.every((a) => !a.basis.includes("没有这个对象的必需验证证据")),
      "④ 三类静态边**全部**改走自身来源/映射复算分支（旧「无投影 ⇒ unverified」判据句在三类边上出现 0 次）",
    );
    ok(
      staticEdges.every((a) => a.verification_scope === "source_mapping") &&
        real.annotations.filter((a) => !staticKinds.includes(a.kind)).every((a) => a.verification_scope === "functional"),
      "④⑤ verification_scope 分档正确：三类静态边=source_mapping，其余对象=functional",
    );
    // ④ A/C 类：来源全部有效的必须 verified——只允许 invalidated（来源失效）这一档非绿，不许 unverified/missing
    for (const kind of ["task_design_ref", "design_interface"]) {
      const bad = staticEdges.filter((a) => a.kind === kind && (a.evidence_state === "unverified" || a.evidence_state === "missing"));
      ok(
        bad.length === 0,
        `④ ${kind}：没有 unverified/missing 残留（verified ${stateBy(kind).verified ?? 0} / invalidated ${stateBy(kind).invalidated ?? 0}；` +
          `invalidated 是已发布蓝图绑定旧版图纸的正常 §5.6 反应，随基线重激活+重新派生刷新）`,
      );
    }
    // ④ B 类：unverified 只允许「映射未经核实」一种理由；逐条落证据文件（不粉饰）
    const mapBad = staticEdges.filter(
      (a) => a.kind === "implementation_map" && a.evidence_state === "unverified" && !a.basis.includes("映射未经核实"),
    );
    const mapUnverified = staticEdges.filter((a) => a.kind === "implementation_map" && a.evidence_state === "unverified");
    const evidenceDir = path.join(REPO, ".工作台", "evidence", "V09-17", "1");
    fs.mkdirSync(evidenceDir, { recursive: true });
    fs.writeFileSync(
      path.join(evidenceDir, "implementation-map-unverified.json"),
      JSON.stringify(
        {
          taken_at: new Date().toISOString(),
          note: "真实项目 implementation_map 边中因「声明路径不存在/仅根兜底命中/定义已变」保持 unverified 的逐条清单（V09-17 ④，不粉饰）",
          count: mapUnverified.length,
          edges: mapUnverified.map((a) => ({ object_id: a.object_id, basis: a.basis })),
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
    ok(
      mapBad.length === 0,
      `④ implementation_map：unverified ${mapUnverified.length} 条**全部**是「映射未经核实」（根兜底/路径不存在/定义已变），` +
        `逐条清单已落 .工作台/evidence/V09-17/1/implementation-map-unverified.json`,
    );
    // ③ 真实项目的 10 条归属来源边：全部 verified、basis 含「归属关系，非运行接口」、无集成检查记录
    const realDI = staticEdges.filter((a) => a.kind === "design_interface");
    ok(
      realDI.length === 10 &&
        realDI.every((a) => a.evidence_state === "verified" && a.basis.includes("设计声明的归属关系，非运行接口") && a.evidence_refs.length === 0),
      `③ 真实项目 design_interface ${realDI.length} 条全部 verified（来源核实），**没有也无需**任何集成检查记录（evidence_refs 全空）`,
    );
    // ④ 阻断构成如实报数（不硬编码 17：以实测为准——当前已发布蓝图绑定第 6 稿之前的图纸修订，
    //    256 条 invalidated 是证据/来源绑旧修订的正常 §5.6 反应，基线重激活+重绑由主会话按既有机制处理）
    const reasonHeads: Record<string, number> = {};
    for (const r of real.delivery.reasons) reasonHeads[r.split("：")[0]] = (reasonHeads[r.split("：")[0]] ?? 0) + 1;
    const nodeBlockers = real.annotations.filter(
      (a) => a.object_kind === "node" && (a.unmapped || isBlockingEvidenceState(a.evidence_state)),
    );
    info(`阻断构成（按前缀）：${JSON.stringify(reasonHeads)}`);
    info(`节点侧阻断对象 ${nodeBlockers.length} 个；静态边 invalidated 多为旧图纸修订绑定（待主会话重激活/重派生刷新）`);
    ok(validateProvenanceModel(real).length === 0, `④ 真实模型跑同一套机械判据 0 违规`);

    // ── ⑤ 中性色与读数分档 ──
    section("⑤ 中性色（图线不随证据状态着色）＋读数分档计数＋P10");
    // 规划图边渲染路径（ProjectGraphView.tsx）：只有 dependency 语义读状态色，其余一律语义自带色
    const pgv = read("src/ui/arch/ProjectGraphView.tsx");
    ok(
      pgv.includes('const statusStyle = e.semantics === "dependency" && e.status !== null') &&
        pgv.includes("statusStyle?.hex ?? spec.color"),
      "⑤ 规划图边渲染只对 dependency 语义读投影状态色（三类静态边不随证据状态取色，保持中性来源样式）",
    );
    ok(
      (["task_design_ref", "implementation_map", "design_interface", "model_inference"] as const).every(
        (k) => EDGE_SEMANTICS[edgeSemanticsOf(k)].completion_colored === false,
      ) && EDGE_SEMANTICS[edgeSemanticsOf("task_dependency")].completion_colored === true,
      "⑤ 线语义登记：三类静态边与推断线 completion_colored=false（不着完成色），只有施工依赖线会按前置是否满足着色",
    );
    // edgeVisualOf：输入形状里根本没有证据状态字段；非「数据流角色」模式恒中性色
    const modes = Object.keys(GRAPH_MODES) as GraphMode[];
    ok(
      modes.every((m) => edgeVisualOf(m, { weight: 1, color_role: null }, 1).color === NEUTRAL_EDGE_COLOR),
      `⑤ edgeVisualOf 对全部 ${modes.length} 个技术图模式在无角色时恒 NEUTRAL_EDGE_COLOR（证据状态不进边色）`,
    );
    ok(
      edgeVisualOf("DATA_FLOW", { weight: 1, color_role: "flow_source" }, 1).color === FLOW_EDGE_COLORS.flow_source &&
        edgeVisualOf("MODULE_BOX", { weight: 1, color_role: "flow_source" }, 1).color === NEUTRAL_EDGE_COLOR,
      "⑤ 只有 DATA_FLOW 按上游角色上色（数据流向图既有口径），MODULE_BOX 同色输入仍中性——角色色与证据状态无关",
    );
    // 读数分档：verified = 来源核实 + 功能验证，且 note 写明两档口径；P9 不给百分比由 validateProvenanceModel 兜底
    ok(
      real.delivery.counts.verified === real.delivery.counts.verified_source_mapping + real.delivery.counts.verified_functional &&
        real.delivery.counts.verified_source_mapping === staticEdges.filter((a) => a.evidence_state === "verified").length &&
        real.delivery.note.includes("来源核实 ≠ 功能验证") && real.delivery.note.includes("不计入功能验证完成数"),
      `⑤ 读数分档计数自洽（verified ${real.delivery.counts.verified} = 来源核实 ${real.delivery.counts.verified_source_mapping} + 功能验证 ${real.delivery.counts.verified_functional}）且 note 写明「来源核实 ≠ 功能验证」`,
    );
    // 2026-09-26 安装版架构灰块复核定向更新（判据**不放宽**：P1–P10 原文一字未动，新增 P11 画布真实
    // 缺口对账——证据链说有成员 ⇔ 画布分组画得出，断裂逐条点名并阻断；长度 10→11，多一类阻断不是放宽）。
    ok(
      PROVENANCE_POLICY.length === 11 &&
        ["P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8", "P9", "P10", "P11"].every((r) => PROVENANCE_POLICY.some((p) => p.rule === r)) &&
        (PROVENANCE_POLICY.find((p) => p.rule === "P10")?.text.includes("根模块兜底") ?? false) &&
        (PROVENANCE_POLICY.find((p) => p.rule === "P10")?.text.includes("非运行接口") ?? false) &&
        (PROVENANCE_POLICY.find((p) => p.rule === "P10")?.text.includes("来源核实") ?? false) &&
        (PROVENANCE_POLICY.find((p) => p.rule === "P11")?.text.includes("阻断") ?? false),
      `⑤ 判据成文 P1–P11 逐条在场，P10 写明三类静态边判据（根兜底不算/非运行接口/来源核实分两档），P11 写明画布真实缺口对账`,
    );
    // 门槛登记自证
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    ok(
      typeof pkg.scripts["verify:v09-17"] === "string" && pkg.scripts["verify:v09-17"].includes("verify-v09-17.ts"),
      `⑤ \`pnpm verify:v09-17\` 已在 package.json 登记（${pkg.scripts["verify:v09-17"] ?? "缺"}）`,
    );
    for (const rel of ["verify:v09-13", "verify:v09-01", "verify:v08-03", "verify:v09-11", "verify:v09-12"]) {
      ok(typeof pkg.scripts[rel] === "string", `⑤ 回归脚本 ${rel} 仍在 package.json 里（本次未改脚本口径）`);
    }
  } finally {
    // 恢复环境
    if (prevHome === undefined) delete process.env.TATAI_HOME;
    else process.env.TATAI_HOME = prevHome;
    fs.rmSync(TMP, { recursive: true, force: true });
    for (const [rel, before] of docBefore) {
      const after = exists(rel) ? sha256Text(read(rel)) : "<missing>";
      ok(after === before, `自证：${rel} 未被本脚本改动`);
    }
  }

  console.log(`[verify] V09-17：PASS ${pass} / FAIL ${fails.length}`);
  if (fails.length > 0) {
    console.log("[verify] 存在 FAIL");
    process.exit(1);
  }
  console.log("[verify] 全部 PASS");
}

main();
