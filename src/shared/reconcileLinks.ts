// V09-08 ①②：对账配对里**哪些可以继承状态色**——浏览器安全的纯口径（零 React / 零 IO / 零 node）。
//
// 为什么单独放在 `src/shared/`：这条判断有三处消费者——服务端的对账与 MCP 读口
// （`src/arch/reconcile.ts` / `src/arch/render.ts`）与浏览器侧的三视图/技术详情
// （`ArchView` / `ProjectGraphView` / 验证脚本的期望值计算）。放 `src/arch/reconcile.ts` 会让
// 浏览器包拉进 `node:fs`（V06-05 踩过同类坑），所以判据本体与实例分开放（同 `shared/gateSteps.ts` 的先例）。
//
// 判据（DESIGN.md 附录 E.7 裁定①；附录 D.3 的"声明模块继承代码模块状态"以此为前置）：
//   · `plan_section_ref`     —— 材料点名了**实现落点** ⇒ 可定位的实现映射 ⇒ **可以**继承；
//   · `plan_section_locator` —— 材料只点到「落点」（没有实现落点标记）⇒ **落点未证实** ⇒ 不继承；
//   · `name_signal`          —— 名字/文本匹配（待核实）⇒ 不继承。
// 修前 `11.1-01 → templates` 的绿就是靠"章节里点到的唯一非根路径"继承来的（报告 02 G-03 真误配）。

/** 配对依据的取值（与服务端 `MatchedPair.via` 逐字一致） */
export type ReconcileMatchVia = "plan_section_ref" | "plan_section_locator" | "name_signal";

/** 可以继承状态色的唯一依据：材料点名的**实现落点** */
export const INHERITABLE_MATCH_VIA: ReconcileMatchVia = "plan_section_ref";

/** 只读界面/读口需要的配对形状（服务端的 `MatchedPair` 是它的超集） */
export interface MatchedPairLike {
  design?: string;
  stable_id?: string;
  module_id: string;
  via?: string;
  plan_section?: string;
  ref_text?: string;
  locator_unverified?: true;
}

/**
 * 从对账配对取「可继承状态色」的声明稳定 ID → 代码模块 id 表（声明模块按附录 D.3 继承状态）。
 * 只认 `via === "plan_section_ref"` 的配对；其余一律不进表（不继承、不判绿）。
 */
export function declaredLinksFromMatched(
  matched: readonly MatchedPairLike[] | null | undefined,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const m of matched ?? []) {
    if (m.via !== INHERITABLE_MATCH_VIA) continue;
    if (m.stable_id === undefined || m.stable_id === "") continue;
    const list = out[m.stable_id] ?? [];
    if (!list.includes(m.module_id)) list.push(m.module_id);
    out[m.stable_id] = list;
  }
  return out;
}
