// C016 收口第二包验证脚本（2026-09-21）：派生蓝图权威来源 = 已审定图纸基线 + 合法变更事实。
// 用法：pnpm verify:c016-blueprint-authority（自带临时 TATAI_HOME + 夹具项目，不碰真实注册表与任何真实项目；
// 不调真网关——rebuild 走确定性派生，semantic 缺省 false；TATAI_KEEP_TMP=1 保留现场）
//
// 合同（RED→GREEN 都保存在本文件；RED 实录见脚本顶部注释末尾）：
//   A. 直编入口禁用：applyBlueprintEdit 明确 fail-closed（status:"disabled"），blueprint.json 零字节变化、
//      不写 blueprint-edit-receipt.json；blueprintEdit 的 remove/split/merge/replay 运行期导出已拆除；
//      HTTP 路由面没有 blueprint 编辑接线。
//   B. 派生链不带私账重放：手造 T22 旧私账（blueprint.json 里 inheritance/affected + 被删节点），
//      强制重画后被删节点**复活**（权威源还在声明它）、新图不携带继承账、无 edit_overlay 省略项；
//      旧字段只读可解析（兼容），但不再是权威。
//   C. 事实事件结构折叠：change.blueprint_inheritance_recorded 在登记面（change: 前缀）；
//      直连 WorkService.submit 的结构负例（缺键/多键/空白/重复/基数不符/前后任重叠/处置明细非法/
//      未知 kind/哈希形态坏/已关闭批次/未开批次）全部拒且 events.jsonl 零字节；合法结构直连接收、
//      投影可见、幂等重放回原回执。
//   D. 语义登记命令 registerBlueprintInheritance：跨基线/源图/引用校验全部在 submit 前完成，
//      非法时 events.jsonl 零字节——角色非设计拒、批次不存在/已关闭拒、from≠批次 target_baseline 拒、
//      伪造 from 基线拒、to≠当前生效基线拒、from==to（无源修订）拒、前任不在 from 图拒、
//      to 图未形成预期结果拒（remove：前任仍在 / 不能凭空删节点）、缺引用处置拒、多余处置拒、
//      授权范围不覆盖目标拒；正例 remove/split/merge 各一：落事件流 → 重派生与源一致 →
//      删缓存重画结果稳定（排除时间字段）；事实只在事件投影里，不进 blueprint.json 结构。
//
// RED 实录（2026-09-21 首跑，未实现前，22 PASS / 12 FAIL / 共 34 条）：A-1~A-4 FAIL（旧入口照常写盘
// blueprint.json 并写 blueprint-edit-receipt.json；blueprintEdit 的 remove/split/merge/replay 四个运行期
// 导出都在）、B-2/B-4 FAIL（旧实现重放私账：被私删的模块乙重画后不复活、继承账被携带；删掉缓存再重建
// 结果反而变——同源的图因缓存有无而不一致）、C-1/C-4/C-10/C-22/C-23 FAIL（未知事件类型被折叠拒，
// 合法事实落不了盘、投影无 blueprint_inheritance_records、幂等重放无从谈起）、D-0 FAIL
// （src/arch/blueprintInheritance.ts 不存在）。实现后全绿，计数见文末输出。
import { deepStrictEqual } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  blueprintPath,
  readBlueprint,
  rebuildBlueprint,
  writeJsonAtomic,
  type Blueprint,
} from "../src/arch/blueprint";
import { applyBlueprintEdit } from "../src/arch/blueprintEditService";
import {
  activateBaseline,
  activeBaseline,
  readBaselineLog,
} from "../src/server/work/documents";
import {
  CHANGE_EVENT_TYPES,
  closeChange,
  openChange,
  readChanges,
  targetBaselineOf,
  type ChangeTargetBaseline,
} from "../src/server/work/changes";
import { readTaskStates, submitDefinitionImports } from "../src/server/work/tasks";
import { claimTask } from "../src/server/work/claims";
import { importPlanChecked } from "../src/server/work/references";
import { WorkService } from "../src/server/work/service";
import { eventsPath, loadEvents } from "../src/server/work/eventStore";
import { putEvidence } from "../src/server/work/evidence";
import { NO_CHANGE_ID, REGISTERED_EVENT_TYPES, registeredEventTypes } from "../src/server/work/types";

let passCount = 0;
let failCount = 0;
const ok = (cond: boolean, label: string) => {
  console.log(`[verify-c016] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (cond) passCount++;
  else {
    failCount++;
    process.exitCode = 1;
  }
};
const info = (msg: string) => console.log(`[verify-c016] ${msg}`);
const same = (a: unknown, b: unknown): boolean => {
  try {
    deepStrictEqual(a, b);
    return true;
  } catch {
    return false;
  }
};

// ── 隔离环境与夹具项目 ──
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-c016-authority-"));
const dataDir = path.join(tmpBase, "home");
const ioRoot = path.join(tmpBase, "io"); // A/B 段：直编禁用 + 私账重放拆除
const semRoot = path.join(tmpBase, "sem"); // D 段：语义登记全链路
const foldRoot = path.join(tmpBase, "fold"); // C 段：结构折叠
const IO_ID = "c016-io";
const SEM_ID = "c016-sem";
const FOLD_ID = "c016-fold";
const mkdirp = (d: string) => fs.mkdirSync(d, { recursive: true });
const write = (f: string, text: string) => {
  mkdirp(path.dirname(f));
  fs.writeFileSync(f, text, "utf8");
};
for (const d of [dataDir, ioRoot, semRoot, foldRoot]) mkdirp(d);

const DESIGN_V1 = [
  "# 夹具设计书（C016 权威来源）",
  "",
  "## 1 概述",
  "本夹具验证派生蓝图权威来源收口。",
  "",
  "## 2 能力甲",
  "能力甲为人提供甲。",
  "",
  "## 3 模块划分",
  "- 模块甲：甲的实现",
  "- 模块乙：乙的实现",
  "",
].join("\n");
const DESIGN_V2 = [
  "# 夹具设计书（C016 权威来源）",
  "",
  "## 1 概述",
  "本夹具验证派生蓝图权威来源收口。",
  "",
  "## 2 能力甲",
  "能力甲为人提供甲。",
  "",
  "## 3 模块划分",
  "- 模块甲：甲的实现（模块乙已随源修订移除）",
  "",
].join("\n");
const PLAN_V1 = [
  "# 夹具施工图",
  "",
  "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |",
  "| --- | --- | --- | --- | --- |",
  "| T-1 | todo | 能力甲落成 |  | 甲验收记录 |",
  "| T-2 | todo | 能力乙落成 | T-1 | 乙验收记录 |",
  "",
  "### T-1 能力甲落成",
  "",
  "**设计依据**：§2。",
  "",
  "**契约**：输入甲，输出甲的产物。",
  "",
  "**文件责任**：`src/mod-a/a.ts`。",
  "",
  "- [ ] 甲做出来",
  "",
  "**交付**：甲验收记录。",
  "",
  "### T-2 能力乙落成",
  "",
  "**设计依据**：§2。",
  "",
  "**契约**：输入乙，输出乙的产物。",
  "",
  "**文件责任**：`src/mod-b/b.ts`。",
  "",
  "- [ ] 乙做出来",
  "",
  "**交付**：乙验收记录。",
  "",
].join("\n");
const PLAN_V2 = [
  "# 夹具施工图",
  "",
  "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |",
  "| --- | --- | --- | --- | --- |",
  "| T-1a | todo | 能力甲落成（拆半一） |  | 甲一验收记录 |",
  "| T-1b | todo | 能力甲落成（拆半二） |  | 甲二验收记录 |",
  "| T-2 | todo | 能力乙落成 | T-1a | 乙验收记录 |",
  "",
  "### T-1a 能力甲落成（拆半一）",
  "",
  "**设计依据**：§2。",
  "",
  "**契约**：输入甲一，输出甲一的产物。",
  "",
  "**文件责任**：`src/mod-a/a1.ts`。",
  "",
  "- [ ] 甲一做出来",
  "",
  "**交付**：甲一验收记录。",
  "",
  "### T-1b 能力甲落成（拆半二）",
  "",
  "**设计依据**：§2。",
  "",
  "**契约**：输入甲二，输出甲二的产物。",
  "",
  "**文件责任**：`src/mod-a/a2.ts`。",
  "",
  "- [ ] 甲二做出来",
  "",
  "**交付**：甲二验收记录。",
  "",
  "### T-2 能力乙落成",
  "",
  "**设计依据**：§2。",
  "",
  "**契约**：输入乙，输出乙的产物。",
  "",
  "**文件责任**：`src/mod-b/b.ts`。",
  "",
  "- [ ] 乙做出来",
  "",
  "**交付**：乙验收记录。",
  "",
].join("\n");
const PLAN_V3 = [
  "# 夹具施工图",
  "",
  "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |",
  "| --- | --- | --- | --- | --- |",
  "| T-1a | todo | 能力甲落成（合并回整） |  | 甲验收记录 |",
  "| T-2 | todo | 能力乙落成 | T-1a | 乙验收记录 |",
  "",
  "### T-1a 能力甲落成（合并回整）",
  "",
  "**设计依据**：§2。",
  "",
  "**契约**：输入甲，输出甲的产物。",
  "",
  "**文件责任**：`src/mod-a/a.ts`。",
  "",
  "- [ ] 甲做出来",
  "",
  "**交付**：甲验收记录。",
  "",
  "### T-2 能力乙落成",
  "",
  "**设计依据**：§2。",
  "",
  "**契约**：输入乙，输出乙的产物。",
  "",
  "**文件责任**：`src/mod-b/b.ts`。",
  "",
  "- [ ] 乙做出来",
  "",
  "**交付**：乙验收记录。",
  "",
].join("\n");
write(path.join(ioRoot, ".工作台", "design.md"), DESIGN_V1);
write(path.join(ioRoot, ".工作台", "plan.md"), PLAN_V1);
write(path.join(semRoot, ".工作台", "design.md"), DESIGN_V1);
write(path.join(semRoot, ".工作台", "plan.md"), PLAN_V1);

const record = (id: string, name: string, dir: string) => ({
  id,
  name,
  path: dir,
  kind: "backend",
  registered_at: "2026-09-21T00:00:00+08:00",
  last_opened_at: "2026-09-21T00:00:00+08:00",
});
write(
  path.join(dataDir, "registry.json"),
  JSON.stringify(
    { version: 1, projects: [record(IO_ID, "C016 直编禁用夹具", ioRoot), record(SEM_ID, "C016 语义登记夹具", semRoot), record(FOLD_ID, "C016 折叠夹具", foldRoot)] },
    null,
    2,
  ),
);
process.env.TATAI_HOME = dataDir;

const service = new WorkService({ dataDir });
const workDirOf = (root: string) => path.join(root, ".工作台", "work");
const eventsBytes = (workDir: string): number => {
  const f = eventsPath(workDir);
  return fs.existsSync(f) ? fs.readFileSync(f).length : 0;
};
/** 排除预期时间字段后的语义快照（generated_at / publish.validated_at 每次派生都变，其余必须稳定） */
const semanticSnapshot = (bp: Blueprint): unknown => {
  const clone = structuredClone(bp) as unknown as Record<string, unknown>;
  delete clone.generated_at;
  (clone.publish as Record<string, unknown>).validated_at = null;
  return clone;
};

const DESIGNER = "gpt-6"; // 设计授权角色（ROLE_ALIASES 归一 designer 类）

/** V08-01：声明模块节点 id 改成稳定 ID（`plan:mod:<sectionKey>-<declaredKey>`），
 *  本夹具的"模块乙"id 从派生图动态取（首轮派生后赋值），不再写死旧格式 `plan:mod:<章节序号>-<条目序号>`。 */
let ioModBId = "";

async function main(): Promise<void> {
  // ═══════════════════════ A. 直编入口禁用 ═══════════════════════
  info("── A. 直编派生缓存的入口必须 fail-closed 禁用，零写盘");
  activateBaseline(IO_ID, { approved_by: "user", approval_basis: "C016 夹具（非真实用户 Gate）", approval_kind: "user_confirmed" });
  const ioFirst = await rebuildBlueprint(IO_ID, { trigger: "c016-a", force: true });
  const ioBp = ioFirst.blueprint;
  ok(ioFirst.publish.published && ioBp !== null, "A 前置：IO 夹具首轮派生发布");
  if (ioBp !== null) {
    const ioModB = ioBp.nodes.find((n) => n.name === "模块乙")!;
    ioModBId = ioModB.id; // V08-01：后续各段统一用动态取到的稳定 ID
    const archDir = path.dirname(blueprintPath(IO_ID));
    const dirSnapshot = () => fs.readdirSync(archDir).sort();
    const bytesBefore = fs.readFileSync(blueprintPath(IO_ID));
    const r1 = applyBlueprintEdit(IO_ID, { op: "remove", node_ids: [ioModB.id], change_ref: "change-x" } as never);
    ok(
      (r1 as { status: string }).status === "disabled" &&
        fs.readFileSync(blueprintPath(IO_ID)).equals(bytesBefore) &&
        same(dirSnapshot(), fs.readdirSync(archDir).sort()) &&
        !fs.existsSync(path.join(archDir, "blueprint-edit-receipt.json")),
      "A-1 直编 remove 入口 fail-closed：返回 disabled、blueprint.json 零字节变化、不写编辑回执（旧实现照常写盘 → RED）",
    );
    const r2 = applyBlueprintEdit(IO_ID, { op: "split", node_id: ioModB.id, successors: [{ node_id: "plan:mod:x", name: "x" }], change_ref: "change-x" } as never);
    const r3 = applyBlueprintEdit(IO_ID, { op: "merge", node_ids: [ioModB.id], successor: { node_id: "plan:mod:y", name: "y" }, change_ref: "change-x" } as never);
    ok(
      (r2 as { status: string }).status === "disabled" &&
        (r3 as { status: string }).status === "disabled" &&
        fs.readFileSync(blueprintPath(IO_ID)).equals(bytesBefore),
      "A-2 直编 split/merge 入口同样 fail-closed（不是只禁用 remove）",
    );
    const reasonText = JSON.stringify(r1);
    ok(
      reasonText.includes("§4.1") && reasonText.includes("12.1") && reasonText.includes("blueprint_inheritance"),
      "A-3 disabled 结果指明唯一合法路径（修订权威原文＋登记 change.blueprint_inheritance_recorded 事实＋重派生）",
    );
    // A-4 编辑原语与重放机已拆除（模块删除或只剩类型导出都算拆除；运行期拿不到函数）
    const tornDownSpec = "../src/arch/blueprintEdit"; // 变量 specifier：模块已删除时 TS/运行期都不解析它
    const editMod: Record<string, unknown> | null = await import(tornDownSpec).then(
      (m) => m as unknown as Record<string, unknown>,
      () => null,
    );
    const tornDown =
      editMod === null ||
      ["removeBlueprintNodes", "splitBlueprintNode", "mergeBlueprintNodes", "reapplyEditLedger"].every(
        (k) => typeof editMod[k] !== "function",
      );
    ok(tornDown, "A-4 blueprintEdit 的 remove/split/merge/replay 运行期导出已拆除（旧实现四个都在 → RED）");
    // A-5 HTTP 路由面没有 blueprint 编辑接线（只读源文件登记面，不跑服务器）
    const indexSrc = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "server", "index.ts"), "utf8");
    ok(
      !indexSrc.includes("applyBlueprintEdit") && !indexSrc.includes("blueprintEditService") && !indexSrc.includes("blueprint-edit"),
      "A-5 server 路由面无 blueprint 编辑接线（不新增 HTTP 独立编辑入口）",
    );

    // ═══════════════════════ B. 派生链不带私账重放 ═══════════════════════
    info("── B. 旧 T22 私账不再驱动重建：权威源覆盖派生缓存");
    // 手造一份 T22 形态的 legacy 图：模块乙被"删"，旁挂 inheritance/affected 私账（批3 T22 的真实写法）
    const legacy = structuredClone(ioBp);
    legacy.nodes = legacy.nodes.filter((n) => n.id !== ioModB.id);
    legacy.edges = legacy.edges.filter((e) => e.source !== ioModB.id && e.target !== ioModB.id);
    for (const n of legacy.nodes) n.related_ids = n.related_ids.filter((r) => r !== ioModB.id);
    legacy.inheritance = [
      { kind: "removed", predecessor_ids: [ioModB.id], successor_ids: [], change_ref: "change-私账", recorded_at: "2026-09-20T00:00:00+08:00" },
    ];
    legacy.affected = [{ id: ioModB.id, type: "node", reason: "T22 私删留下的受影响标注" }];
    writeJsonAtomic(blueprintPath(IO_ID), legacy);
    const legacyBack = readBlueprint(IO_ID);
    ok(
      legacyBack !== null &&
        (legacyBack.inheritance ?? []).some((x) => x.change_ref === "change-私账") &&
        !legacyBack.nodes.some((n) => n.id === ioModB.id),
      "B-1 旧 blueprint.json 的 T22 inheritance/affected 字段只读兼容（能解析），但只是历史数据",
    );
    const redraw = await rebuildBlueprint(IO_ID, { trigger: "c016-b", force: true });
    const bp2 = redraw.blueprint;
    ok(
      redraw.publish.published &&
        bp2 !== null &&
        bp2.nodes.some((n) => n.id === ioModB.id) &&
        bp2.inheritance === undefined &&
        bp2.affected === undefined &&
        !bp2.omitted.some((o) => o.kind === "edit_overlay"),
      "B-2 强制重画：被私删节点由权威源**复活**、新图不携带继承/受影响账、无 edit_overlay 省略项（旧实现重放私账保持删除 → RED）",
    );
    const hit = await rebuildBlueprint(IO_ID, { trigger: "c016-b-cache" });
    ok(hit.rebuilt === false && hit.publish.reason === "cache_hit", "B-3 重画后缓存命中照常（完整缓存键一致零重画）");
    if (bp2 !== null) {
      const snapA = semanticSnapshot(bp2);
      fs.rmSync(blueprintPath(IO_ID));
      const reborn = await rebuildBlueprint(IO_ID, { trigger: "c016-b-reborn", force: true });
      ok(
        reborn.publish.published && reborn.blueprint !== null && same(semanticSnapshot(reborn.blueprint), snapA),
        "B-4 删掉派生缓存重建：排除时间字段后语义逐字段一致（同源同事实 → 同图）",
      );
    }
  }

  // ═══════════════════════ C. 事实事件结构折叠（直连唯一写口） ═══════════════════════
  info("── C. change.blueprint_inheritance_recorded 登记面与结构折叠");
  ok(
    CHANGE_EVENT_TYPES.includes("change.blueprint_inheritance_recorded") &&
      REGISTERED_EVENT_TYPES.some((r) => r.type === "change.blueprint_inheritance_recorded" && r.entity_prefix === "change:") &&
      registeredEventTypes().includes("change.blueprint_inheritance_recorded") &&
      service.info().registered_event_types.includes("change.blueprint_inheritance_recorded"),
    "C-1 新事件类型在 CHANGE_EVENT_TYPES 与 REGISTERED_EVENT_TYPES（change: 前缀）并在服务自述里",
  );
  const foldWorkDir = workDirOf(foldRoot);
  mkdirp(foldWorkDir);
  const foldSubmitter = {
    submit: (c: unknown) => service.submit(c),
    read: () => ({ changes: readChanges(foldWorkDir).changes }),
  };
  const H = (ch: string) => ch.repeat(64);
  const validFact = () => ({
    kind: "remove",
    from_baseline: { baseline_id: "bl-a", design_revision: H("a"), plan_revision: H("b") },
    to_baseline: { baseline_id: "bl-b", design_revision: H("c"), plan_revision: H("d") },
    predecessor_ids: [ioModBId],
    successor_ids: [],
    affected_node_ids: [ioModBId],
    reference_dispositions: [],
  });
  const foldBase = {
    schema_version: 2,
    project_id: FOLD_ID,
    change_id: "change-fold",
    actor_id: "c016-fold",
    role: "coordinator",
  };
  let foldSeq = 0;
  /** 直连提交一条候选事件；返回 {accepted, code, message}，拒绝必须零字节 */
  const tryFact = (
    entityId: string,
    type: string,
    payload: Record<string, unknown>,
    expectedRevision: number | null,
  ): { accepted: boolean; code: string | null; message: string } => {
    foldSeq += 1;
    try {
      service.submit({
        ...foldBase,
        entity_id: entityId,
        type,
        payload,
        expected_revision: expectedRevision,
        idempotency_key: `c016-fold-${foldSeq}`,
      });
      return { accepted: true, code: null, message: "" };
    } catch (e) {
      return { accepted: false, code: (e as { code?: string }).code ?? null, message: (e as Error).message };
    }
  };
  const expectReject = (label: string, fn: () => { accepted: boolean; code: string | null; message: string }, msgIncludes?: string) => {
    const before = eventsBytes(foldWorkDir);
    const r = fn();
    ok(
      !r.accepted && (r.code === "INVALID_COMMAND" || r.code === "EVENT_INVALID") && eventsBytes(foldWorkDir) === before &&
        (msgIncludes === undefined || r.message.includes(msgIncludes)),
      `${label}（拒绝且 events.jsonl 零字节${msgIncludes === undefined ? "" : `，理由点名「${msgIncludes}」`}）`,
    );
  };

  // 批次未开 / 已关闭（折叠层拒）
  expectReject("C-2 批次未开（首条不是 change.opened）直连登记 → 拒", () =>
    tryFact("change:change-没开", "change.blueprint_inheritance_recorded", validFact(), null),
  );
  openChange(foldSubmitter, {
    project_id: FOLD_ID,
    change_batch_id: "change-fold",
    change_id: "change-fold",
    actor_id: "c016-fold",
    role: "coordinator",
    goal: "折叠夹具批次",
    authorized_scope: "结构校验",
    target_baseline: { baseline_id: "bl-a", design_revision: H("a"), plan_revision: H("b") },
    affected_subsystems: [ioModBId],
    exit_criteria: "结构用例跑完",
  });
  openChange(foldSubmitter, {
    project_id: FOLD_ID,
    change_batch_id: "change-fold-闭",
    change_id: "change-fold-闭",
    actor_id: "c016-fold",
    role: "coordinator",
    goal: "将被关闭的批次",
    authorized_scope: "结构校验",
    target_baseline: { baseline_id: "bl-a", design_revision: H("a"), plan_revision: H("b") },
    affected_subsystems: ["x"],
    exit_criteria: "关掉",
  });
  closeChange(foldSubmitter, {
    project_id: FOLD_ID,
    change_batch_id: "change-fold-闭",
    change_id: "change-fold-闭",
    actor_id: "c016-fold",
    role: "coordinator",
    reason: "夹具收口",
  });
  expectReject("C-3 已关闭批次不再接受继承事实登记 → 拒", () =>
    tryFact("change:change-fold-闭", "change.blueprint_inheritance_recorded", validFact(), 2),
  );
  // 结构负例（缺键/多键/空白/重复/基数/重叠/处置明细/哈希形态/未知 kind）
  expectReject("C-4 缺 successor_ids 键 → 拒", () => {
    const p = validFact() as Record<string, unknown>;
    delete p.successor_ids;
    return tryFact("change:change-fold", "change.blueprint_inheritance_recorded", p, 1);
  }, "successor_ids");
  expectReject("C-5 多余键 → 拒", () =>
    tryFact("change:change-fold", "change.blueprint_inheritance_recorded", { ...validFact(), note: "多出来的" }, 1),
  );
  expectReject("C-6 predecessor_ids 空数组 → 拒", () =>
    tryFact("change:change-fold", "change.blueprint_inheritance_recorded", { ...validFact(), predecessor_ids: [] }, 1),
  );
  expectReject("C-7 predecessor_ids 含空白 → 拒", () =>
    tryFact("change:change-fold", "change.blueprint_inheritance_recorded", { ...validFact(), predecessor_ids: ["  "] }, 1),
  );
  expectReject("C-8 predecessor_ids 重复 → 拒", () =>
    tryFact("change:change-fold", "change.blueprint_inheritance_recorded", { ...validFact(), predecessor_ids: ["plan:a", "plan:a"] }, 1),
  );
  expectReject("C-9 未知 kind（delete）→ 拒", () =>
    tryFact("change:change-fold", "change.blueprint_inheritance_recorded", { ...validFact(), kind: "delete" }, 1),
  );
  expectReject("C-10 拆分零继任 → 拒（零后继拆分拒）", () =>
    tryFact("change:change-fold", "change.blueprint_inheritance_recorded", { ...validFact(), kind: "split", successor_ids: [] }, 1),
    "successor_ids",
  );
  expectReject("C-11 删除带继任 → 拒（删除继任必须 0）", () =>
    tryFact("change:change-fold", "change.blueprint_inheritance_recorded", { ...validFact(), successor_ids: ["plan:z"] }, 1),
  );
  expectReject("C-12 合并带两个继任 → 拒（合并继任必须恰好 1）", () =>
    tryFact("change:change-fold", "change.blueprint_inheritance_recorded", { ...validFact(), kind: "merge", successor_ids: ["plan:x", "plan:y"] }, 1),
  );
  expectReject("C-13 继任与前任重叠 → 拒", () =>
    tryFact("change:change-fold", "change.blueprint_inheritance_recorded", { ...validFact(), kind: "split", successor_ids: [ioModBId, "plan:z"] }, 1),
  );
  expectReject("C-14 from_baseline 哈希形态坏 → 拒", () =>
    tryFact("change:change-fold", "change.blueprint_inheritance_recorded", { ...validFact(), from_baseline: { baseline_id: null, design_revision: "xyz", plan_revision: H("b") } }, 1),
  );
  const goodDisposition = {
    predecessor_id: ioModBId,
    referenced_by: "evidence:abc",
    action: "disposed",
    to: null,
    note: "证据随节点退役，仅留追溯",
  };
  expectReject("C-15 处置明细含多余键 → 拒", () =>
    tryFact("change:change-fold", "change.blueprint_inheritance_recorded", { ...validFact(), reference_dispositions: [{ ...goodDisposition, extra: 1 }] }, 1),
  );
  expectReject("C-16 处置明细 action 未知 → 拒", () =>
    tryFact("change:change-fold", "change.blueprint_inheritance_recorded", { ...validFact(), reference_dispositions: [{ ...goodDisposition, action: "merged" }] }, 1),
  );
  expectReject("C-17 migrated 的 to 不在继任清单 → 拒", () =>
    tryFact(
      "change:change-fold",
      "change.blueprint_inheritance_recorded",
      { ...validFact(), kind: "split", successor_ids: ["plan:s1"], reference_dispositions: [{ ...goodDisposition, action: "migrated", to: "plan:别的" }] },
      1,
    ),
  );
  expectReject("C-18 disposed 的 to 非 null → 拒", () =>
    tryFact("change:change-fold", "change.blueprint_inheritance_recorded", { ...validFact(), reference_dispositions: [{ ...goodDisposition, to: "plan:x" }] }, 1),
  );
  expectReject("C-19 处置明细重复（同前任同引用）→ 拒", () =>
    tryFact("change:change-fold", "change.blueprint_inheritance_recorded", { ...validFact(), reference_dispositions: [goodDisposition, goodDisposition] }, 1),
  );
  expectReject("C-20 处置明细指向非前任节点 → 拒", () =>
    tryFact("change:change-fold", "change.blueprint_inheritance_recorded", { ...validFact(), reference_dispositions: [{ ...goodDisposition, predecessor_id: "plan:无关" }] }, 1),
  );
  expectReject("C-21 未知 change.* 类型 → 拒（折叠层词表闭合）", () =>
    tryFact("change:change-fold", "change.blueprint_inheritance_v2", validFact(), 1),
  );
  // 结构正例：直连提交合法事实 → 接收、投影可见、幂等
  {
    const before = eventsBytes(foldWorkDir);
    const r = tryFact("change:change-fold", "change.blueprint_inheritance_recorded", validFact(), 1);
    const proj = readChanges(foldWorkDir);
    const facts = proj.changes["change-fold"]?.blueprint_inheritance_records ?? [];
    ok(
      r.accepted && eventsBytes(foldWorkDir) > before && facts.length === 1 &&
        facts[0].kind === "remove" &&
        same(facts[0].predecessor_ids, [ioModBId]) &&
        facts[0].successor_ids.length === 0 &&
        facts[0].recorded_by === "c016-fold" &&
        typeof facts[0].event_id === "string" && facts[0].event_id !== "" &&
        typeof facts[0].recorded_at === "string" && facts[0].recorded_at !== "",
      "C-22 合法结构直连 → 接收落盘，投影 blueprint_inheritance_records 可见全字段与事件元数据（旧实现未知类型拒 → RED）",
    );
    // 幂等：同键同内容重放回原回执
    foldSeq -= 1; // 重用上一条的幂等键与内容
    const dup = tryFact("change:change-fold", "change.blueprint_inheritance_recorded", validFact(), 1);
    const count = loadEvents(foldWorkDir).events.length;
    ok(dup.accepted && loadEvents(foldWorkDir).events.length === count, "C-23 同幂等键同内容重放 → 原回执，不产生第二条事件");
  }

  // ═══════════════════════ D. 语义登记命令全链路 ═══════════════════════
  info("── D. registerBlueprintInheritance：源先改、事实后记、再派生");
  const inh: typeof import("../src/arch/blueprintInheritance") | null = await import("../src/arch/blueprintInheritance").then(
    (m) => m,
    () => null,
  );
  ok(inh !== null && typeof inh.registerBlueprintInheritance === "function", "D-0 语义登记命令模块存在（旧实现没有 → RED）");
  if (inh !== null) {
    const semWorkDir = workDirOf(semRoot);
    mkdirp(semWorkDir);
    const semSubmitter = {
      submit: (c: unknown) => service.submit(c),
      read: () => ({ changes: readChanges(semWorkDir).changes }),
    };
    const tb = (): ChangeTargetBaseline => targetBaselineOf(activeBaseline(SEM_ID)!);
    const register = (input: Record<string, unknown>) =>
      inh.registerBlueprintInheritance(SEM_ID, input as never, { submitter: semSubmitter });
    /** 语义负例：拒 + events.jsonl 零字节 + 理由点名 */
    const expectSemReject = (label: string, input: Record<string, unknown>, msgIncludes: string) => {
      const before = eventsBytes(semWorkDir);
      let err: Error | null = null;
      try {
        register(input);
      } catch (e) {
        err = e as Error;
      }
      ok(
        err !== null && (err as { code?: string }).code === "INVALID_COMMAND" && eventsBytes(semWorkDir) === before && err.message.includes(msgIncludes),
        `${label}（拒且零字节，理由含「${msgIncludes}」）`,
      );
    };

    // ── D 前置：bl1 生效、首轮派生、任务导入+认领 T-1、证据指向模块乙、开五个批次 ──
    activateBaseline(SEM_ID, { approved_by: DESIGNER, approval_basis: "C016 夹具技术审定（非真实用户 Gate）", approval_kind: "delegated_technical_review" });
    const semFirst = await rebuildBlueprint(SEM_ID, { trigger: "c016-d", force: true });
    const semBp = semFirst.blueprint;
    ok(semFirst.publish.published && semBp !== null, "D 前置：SEM 夹具 bl1 首轮派生发布");
    if (semBp === null) return;
    const modB = semBp.nodes.find((n) => n.name === "模块乙")!.id;
    const modA = semBp.nodes.find((n) => n.name === "模块甲")!.id;
    submitDefinitionImports(semSubmitter, {
      project_id: SEM_ID,
      change_id: NO_CHANGE_ID,
      actor_id: "fixture",
      role: "executor",
      definitions: importPlanChecked(PLAN_V1, semWorkDir).definitions,
    });
    await claimTask({ project_id: SEM_ID, task_id: "T-1", role: "executor", owner_id: "fixture", change_id: NO_CHANGE_ID }, semSubmitter, dataDir);
    const ev = putEvidence(semWorkDir, {
      content: "证据正文：模块乙的验收材料（夹具）",
      kind: "acceptance",
      summary: "模块乙验收记录",
      created_by: "fixture",
      role: "auditor",
      binding: { revision_kind: "design", revision: activeBaseline(SEM_ID)!.design_revision.content_sha256 },
      source_ref: modB,
    });
    const tb1 = tb();
    const openBatch = (id: string, goal: string, scope: string[], target: ChangeTargetBaseline = tb1) =>
      openChange(semSubmitter, {
        project_id: SEM_ID,
        change_batch_id: id,
        change_id: id,
        actor_id: "fixture",
        role: "coordinator",
        goal,
        authorized_scope: scope.join("；"),
        target_baseline: target,
        affected_subsystems: scope,
        exit_criteria: `${goal} 完成`,
      });
    openBatch("change-模块收口", `收口 ${modB}（模块乙）`, [modB, "模块乙"]);
    openBatch("change-模块甲移除", `移除 ${modA}（模块甲）`, [modA, "模块甲"]);
    openBatch("change-无关", "与蓝图节点无关的其他事", ["无关子系统"]);
    openBatch("change-已关闭", `收尾 ${modB}`, [modB]);
    closeChange(semSubmitter, { project_id: SEM_ID, change_batch_id: "change-已关闭", change_id: "change-已关闭", actor_id: "fixture", role: "coordinator", reason: "夹具收口" });
    openBatch("change-幽灵", "目标基线伪造的批次", ["x"], { baseline_id: "bl-幽灵", design_revision: H("9"), plan_revision: H("8") });
    const removeModB = () => ({
      change_batch_id: "change-模块收口",
      kind: "remove",
      from_baseline: tb1,
      to_baseline: tb(),
      predecessor_ids: [modB],
      successor_ids: [],
      affected_node_ids: [modB],
      reference_dispositions: [
        { predecessor_id: modB, referenced_by: `evidence:${ev.evidence_id}`, action: "disposed", to: null, note: "证据随模块乙退役，仅留追溯" },
      ],
      actor_id: "gpt-6",
      role: DESIGNER,
    });

    // ── D 段负例（修订前：from==to 之前的各道闸）──
    expectSemReject("D-1 非设计角色（executor）登记 → 拒", { ...removeModB(), role: "executor" }, "设计");
    expectSemReject("D-2 批次不存在 → 拒", { ...removeModB(), change_batch_id: "change-没有" }, "不存在");
    expectSemReject("D-3 批次已关闭 → 拒", { ...removeModB(), change_batch_id: "change-已关闭" }, "关闭");
    expectSemReject("D-4 拆分零继任 → 拒（结构闸）", { ...removeModB(), kind: "split", successor_ids: [] }, "successor_ids");
    expectSemReject(
      "D-5 from ≠ 批次 target_baseline → 拒",
      { ...removeModB(), from_baseline: { baseline_id: null, design_revision: H("e"), plan_revision: H("f") } },
      "target_baseline",
    );
    expectSemReject("D-6 伪造 from 基线（幽灵批次）→ 拒", { ...removeModB(), change_batch_id: "change-幽灵", from_baseline: { baseline_id: "bl-幽灵", design_revision: H("9"), plan_revision: H("8") } }, "基线");
    expectSemReject(
      "D-7 to ≠ 当前生效基线 → 拒",
      { ...removeModB(), to_baseline: { baseline_id: null, design_revision: H("c"), plan_revision: H("d") } },
      "生效基线",
    );
    expectSemReject("D-8 from == to（没有发生源修订）→ 拒", { ...removeModB(), to_baseline: tb1 }, "源修订");

    // ── 源先改：模块乙从设计书模块清单移除 → 激活 bl2 ──
    write(path.join(semRoot, ".工作台", "design.md"), DESIGN_V2);
    activateBaseline(SEM_ID, { approved_by: DESIGNER, approval_basis: "C016 夹具：移除模块乙", approval_kind: "delegated_technical_review" });
    const bl2 = activeBaseline(SEM_ID)!;
    ok(bl2.supersedes !== null && readBaselineLog(SEM_ID).baselines.length === 2, "D 前置：bl2 激活并 supersedes bl1");

    // ── D 段负例（修订后）──
    expectSemReject("D-9 前任不在 from 图 → 拒", { ...removeModB(), predecessor_ids: ["plan:mod:99-99"], affected_node_ids: ["plan:mod:99-99"], reference_dispositions: [] }, "from");
    expectSemReject(
      "D-10 to 图未形成预期结果（模块甲仍在 to 图，remove 不成立）→ 拒：事实不能凭空删节点",
      { ...removeModB(), change_batch_id: "change-模块甲移除", predecessor_ids: [modA], affected_node_ids: [modA], reference_dispositions: [] },
      "to",
    );
    expectSemReject("D-11 有效证据引用缺处置明细 → 拒", { ...removeModB(), reference_dispositions: [] }, "处置");
    expectSemReject(
      "D-12 多余处置明细（报了不存在的引用）→ 拒",
      {
        ...removeModB(),
        reference_dispositions: [
          ...removeModB().reference_dispositions,
          { predecessor_id: modB, referenced_by: "task:T-9", action: "disposed", to: null, note: "多报的" },
        ],
      },
      "多余",
    );
    expectSemReject("D-13 批次授权范围不覆盖目标（change-无关）→ 拒", { ...removeModB(), change_batch_id: "change-无关" }, "范围");

    // ── D 正例一：remove（模块乙）──
    {
      const before = eventsBytes(semWorkDir);
      const receipt = register(removeModB());
      const proj = readChanges(semWorkDir);
      const facts = proj.changes["change-模块收口"]?.blueprint_inheritance_records ?? [];
      ok(
        receipt.ok === true && eventsBytes(semWorkDir) > before && facts.length === 1 &&
          facts[0].kind === "remove" && same(facts[0].predecessor_ids, [modB]) &&
          facts[0].reference_dispositions.length === 1 && facts[0].reference_dispositions[0].action === "disposed",
        "D-14 remove 正例：合法事实落事件流（唯一事实流），投影可见前任/处置明细",
      );
      const r = await rebuildBlueprint(SEM_ID, { trigger: "c016-d-remove", force: true });
      ok(
        r.publish.published && r.blueprint !== null &&
          !r.blueprint.nodes.some((n) => n.id === modB) &&
          r.blueprint.nodes.some((n) => n.id === modA) &&
          r.blueprint.inheritance === undefined && r.blueprint.affected === undefined &&
          r.blueprint.baseline_id === bl2.baseline_id,
        "D-15 remove 后重派生：模块乙因**源修订**消失（不是事实事件删的），图不携带继承账，事实只在事件投影里",
      );
      const snap = semanticSnapshot(r.blueprint!);
      fs.rmSync(blueprintPath(SEM_ID));
      const reborn = await rebuildBlueprint(SEM_ID, { trigger: "c016-d-reborn", force: true });
      ok(
        reborn.blueprint !== null && same(semanticSnapshot(reborn.blueprint), snap),
        "D-16 删派生缓存重建：同源同事实 → 语义逐字段一致（排除时间字段）",
      );
    }

    // ── D 正例二：split（T-1 → T-1a + T-1b）──
    openBatch("change-任务拆分", "把 T-1 拆成 T-1a 与 T-1b", ["T-1", "plan:task:T-1"], tb());
    // F-05（2026-09-21 收口审计）：授权范围只有**前缀碰撞**的批次（文本里只有 T-12，没有逐字 T-1）——
    // 旧子串判定会把 "T-1" 当成 "T-12" 的一部分放行，词边界判定必须拒
    openBatch("change-前缀碰撞", "处理 T-12 的拆分事", ["T-12", "plan:task:T-12"], tb());
    write(path.join(semRoot, ".工作台", "plan.md"), PLAN_V2);
    activateBaseline(SEM_ID, { approved_by: DESIGNER, approval_basis: "C016 夹具：拆分 T-1", approval_kind: "delegated_technical_review" });
    /** from = 上一条基线（当前生效基线的前任）的哈希引用 */
    const prevTb = (): ChangeTargetBaseline => {
      const prev = readBaselineLog(SEM_ID).baselines.at(-2)!;
      return { baseline_id: prev.baseline_id, design_revision: prev.design_revision.content_sha256, plan_revision: prev.plan_revision.content_sha256 };
    };
    const splitInput = () => ({
      change_batch_id: "change-任务拆分",
      kind: "split",
      from_baseline: prevTb(),
      to_baseline: tb(),
      predecessor_ids: ["plan:task:T-1"],
      successor_ids: ["plan:task:T-1a", "plan:task:T-1b"],
      affected_node_ids: ["plan:task:T-1", "plan:task:T-2"],
      reference_dispositions: [
        { predecessor_id: "plan:task:T-1", referenced_by: "task:T-1", action: "migrated", to: "plan:task:T-1a", note: "任务 T-1 的执行由继任 T-1a 承接" },
        { predecessor_id: "plan:task:T-1", referenced_by: "task:T-2", action: "migrated", to: "plan:task:T-1a", note: "T-2 的前置依赖迁到 T-1a" },
      ],
      actor_id: "gpt-6",
      role: DESIGNER,
    });
    expectSemReject("D-17 拆分缺全部处置明细 → 拒（有效任务 T-1/T-2 引用前任）", { ...splitInput(), reference_dispositions: [] }, "处置");
    expectSemReject(
      "D-18 拆分缺一项处置明细（只迁了 T-1，漏 T-2）→ 拒（缺一项整体拒绝）",
      { ...splitInput(), reference_dispositions: splitInput().reference_dispositions.slice(0, 1) },
      "T-2",
    );
    expectSemReject(
      "D-18b 授权范围只有前缀碰撞（批次文本只有 T-12，T-1 被顶包）→ 拒（F-05：词边界，子串不算点名）",
      { ...splitInput(), change_batch_id: "change-前缀碰撞" },
      "范围",
    );
    {
      const before = eventsBytes(semWorkDir);
      const receipt = register(splitInput());
      ok(receipt.ok === true && eventsBytes(semWorkDir) > before, "D-19 split 正例：两个有效任务引用的迁移明细齐全 → 登记落盘");
      const r = await rebuildBlueprint(SEM_ID, { trigger: "c016-d-split", force: true });
      const ids = (r.blueprint?.nodes ?? []).map((n) => n.id);
      ok(
        r.publish.published && !ids.includes("plan:task:T-1") && ids.includes("plan:task:T-1a") && ids.includes("plan:task:T-1b") && ids.includes("plan:task:T-2"),
        "D-20 split 后重派生：前任不在、继任全在（≥1），全部由修订后的施工图派生",
      );
    }

    // ── D 正例三：merge（T-1b 并入 T-1a，存续者保身份）──
    openBatch("change-任务合并", "把 T-1b 并回 T-1a", ["T-1b", "plan:task:T-1b"], tb());
    write(path.join(semRoot, ".工作台", "plan.md"), PLAN_V3);
    activateBaseline(SEM_ID, { approved_by: DESIGNER, approval_basis: "C016 夹具：合并回 T-1a", approval_kind: "delegated_technical_review" });
    const mergeInput = () => ({
      change_batch_id: "change-任务合并",
      kind: "merge",
      from_baseline: prevTb(),
      to_baseline: tb(),
      predecessor_ids: ["plan:task:T-1b"],
      successor_ids: ["plan:task:T-1a"],
      affected_node_ids: ["plan:task:T-1b", "plan:task:T-1a"],
      reference_dispositions: [],
      actor_id: "gpt-6",
      role: DESIGNER,
    });
    expectSemReject("D-21 合并带两个继任 → 拒（结构闸：合并继任必须恰好 1）", { ...mergeInput(), successor_ids: ["plan:task:T-1a", "plan:task:T-1c"] }, "successor_ids");
    {
      const before = eventsBytes(semWorkDir);
      const receipt = register(mergeInput());
      ok(receipt.ok === true && eventsBytes(semWorkDir) > before, "D-22 merge 正例：唯一继任在 to 图、前任不在 → 登记落盘");
      const r = await rebuildBlueprint(SEM_ID, { trigger: "c016-d-merge", force: true });
      const ids = (r.blueprint?.nodes ?? []).map((n) => n.id);
      ok(
        r.publish.published && !ids.includes("plan:task:T-1b") && ids.includes("plan:task:T-1a"),
        "D-23 merge 后重派生：应消失的前任不在、唯一继任在（施工图修订派生）",
      );
    }

    // ── D 收尾：三条事实都在唯一事实流，投影可审查；蓝图结构只由源决定 ──
    {
      const proj = readChanges(semWorkDir);
      const all = Object.values(proj.changes).flatMap((c) => c.blueprint_inheritance_records);
      const tasks = readTaskStates(semWorkDir);
      ok(
        all.length === 3 &&
          all.some((f) => f.kind === "remove") && all.some((f) => f.kind === "split") && all.some((f) => f.kind === "merge") &&
          all.every((f) => f.from_baseline.design_revision !== f.to_baseline.design_revision || f.from_baseline.plan_revision !== f.to_baseline.plan_revision) &&
          tasks.states["T-1"] !== undefined,
        "D-24 三条合法事实（remove/split/merge）都在 change 事件投影里可审查，from≠to 各自绑定真实基线对",
      );
    }

    // ── D-25 授权覆盖判定的词边界口径（F-05 unit 级：夹具造不出 plan:mod 前缀碰撞节点对，直接喂 haystack/needle）──
    {
      const cov = inh.authorizationTextCovers;
      ok(
        typeof cov === "function" &&
          !cov("收口 plan:mod:01-12 与相关子系统", "plan:mod:01-1") &&
          !cov("处理 T-12 的事", "T-1") &&
          !cov("T-12", "T-1") &&
          !cov("plan:task:T-12", "plan:task:T-1") &&
          cov("收口 plan:mod:01-1 与相关子系统", "plan:mod:01-1") &&
          cov("处理 T-1 的事", "T-1") &&
          cov("前缀(plan:task:T-1)后缀", "plan:task:T-1") &&
          cov("T-1", "T-1"),
        "D-25 授权范围覆盖判定词边界化：plan:mod:01-12 / T-12 不再替 plan:mod:01-1 / T-1 顶包，逐字点名照常覆盖（F-05）",
      );
    }
  }
}

main()
  .catch((e) => {
    console.error(`[verify-c016] FAIL 未捕获异常：${(e as Error).stack ?? String(e)}`);
    failCount++;
    process.exitCode = 1;
  })
  .finally(() => {
    if (process.env.TATAI_KEEP_TMP !== "1") fs.rmSync(tmpBase, { recursive: true, force: true });
    info(`PASS ${passCount} / FAIL ${failCount}（总计 ${passCount + failCount} 条）`);
    info(`临时现场：${process.env.TATAI_KEEP_TMP === "1" ? tmpBase : "已清理"}`);
  });
