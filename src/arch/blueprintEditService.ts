// C016 收口第二包（2026-09-21）：直接编辑派生蓝图（删除/拆并后写 blueprint.json）的入口
// **已禁用并拆除写盘能力**（批3 T22 的实现形态不符合统一口径，PLAN.md V06-05 下 2026-09-21 C016 登记）。
//
// 依据：
//   · DESIGN §4.1——蓝图的权威来源是已审定图纸基线与合法变更事实，本期不提供直接编辑派生蓝图的
//     独立入口；`blueprint.json` 及其旁挂继承账本只是派生数据，不单独保存权威变更。
//   · DESIGN §12.1 第 16 项——派生蓝图直接编辑的独立入口本期不立项；删除/拆并统一走
//     「修订权威原文 ＋ 登记合法变更事实 ＋ 重派生」。
//
// 本模块现在的全部行为：applyBlueprintEdit 对任何入参返回 status:"disabled" 的结果对象，
// **一个字节都不写**（不写 blueprint.json，也不写 blueprint-edit-receipt.json——回执文件是
// 被否方案的一部分）。旧的 remove/split/merge 纯编辑函数与继承账重放机（blueprintEdit.ts）
// 已删除，重建链不再重放任何私有编辑账（blueprint.ts#rebuildBlueprint）；历史形态见 Git 历史。
//
// 唯一合法路径（§4.1）：
//   ① 获授权设计角色先修订设计/施工权威原文并激活新基线；
//   ② 经 src/arch/blueprintInheritance.ts#registerBlueprintInheritance 登记
//      change.blueprint_inheritance_recorded 事实（绑定 from/to 基线、前任/继任、
//      影响范围与全部有效任务/证据引用的处置明细）；
//   ③ rebuildBlueprint 从修订后的权威源重新派生（事实不驱动节点/边，只留可追溯记录）。

/** 禁用原因的稳定文案（验证脚本与排障都按它识别；改动时同步核对 verify:c016-blueprint-authority） */
export const BLUEPRINT_EDIT_DISABLED_REASON =
  "直接编辑派生蓝图（删除/拆并写 blueprint.json）的入口已禁用：派生蓝图不是可独立编辑的设计，" +
  "权威来源是已审定图纸基线＋合法变更事实（DESIGN §4.1）；面向人的独立编辑入口本期不立项（§12.1 第 16 项）。" +
  "唯一合法路径：获授权设计角色修订设计/施工权威原文并激活新基线 → 登记 change.blueprint_inheritance_recorded " +
  "事实（arch/blueprintInheritance.ts#registerBlueprintInheritance）→ rebuildBlueprint 重派生。";

/** 禁用结果（不抛错、不写盘：调用方拿到明确的 fail-closed 信号，派生缓存一个字节都不动） */
export interface BlueprintEditDisabledResult {
  status: "disabled";
  reason: string;
  /** 唯一合法路径的一句话指引（§4.1） */
  legal_path: string;
}

/**
 * 旧「规划图删除/拆并正式服务与持久化入口」的禁用形态。
 * 任何 op（remove/split/merge）、任何入参都返回同一个 disabled 结果；不写 blueprint.json、
 * 不写 blueprint-edit-receipt.json、不触发派生。参数仅用于兼容既有调用形态，内容不再被解释。
 */
export function applyBlueprintEdit(
  _projectId: string,
  _input: unknown,
  _opts: { dataDir?: string } = {},
): BlueprintEditDisabledResult {
  return {
    status: "disabled",
    reason: BLUEPRINT_EDIT_DISABLED_REASON,
    legal_path:
      "修订权威原文并激活新基线 → registerBlueprintInheritance 登记 change.blueprint_inheritance_recorded 事实 → rebuildBlueprint 重派生",
  };
}
