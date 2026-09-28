// V09-08 ③：对账差异的**显示口径**（零 React / 零 IO，ArchCanvas 与 GateTimeline 共用这一份）。
//
// 为什么单独一层：附录 E.7 裁定④ 要的是「技术详情三图与 Gate 面板按分类分计、口径一致」，
// 而**分类判据本体**在 `src/arch/reconcile.ts`（服务端算一次，随对账结果落盘/随响应带回），
// 界面只做**一件事**：按同一套词表把 `only_in_code` 逐条归类并分计——不许在两个 UI 文件里
// 各写一套判断（那正是被点名的误导来源）。
//
// 为什么要有 `unclassified`：旧的对账结果（V09-08 之前生成的 `reconcile-last.json`）没有分类字段。
// 那种情况下界面**不猜**，如实显示「未分类（旧对账结果，请重跑对账）」，且**不计入「对账差」**——
// 不许把未知当已知，也不许把口径边界悄悄算成真差异。

/** 分类键（与服务端 `OnlyInCodeCategory` 逐字对应；`unclassified` 只表示"这份结果没有分类字段"） */
export type OnlyInCodeDisplayCategory = "actionable_mismatch" | "outside_scope" | "structural" | "unclassified";

export const ONLY_IN_CODE_CATEGORY_ORDER: readonly OnlyInCodeDisplayCategory[] = [
  "actionable_mismatch",
  "outside_scope",
  "structural",
  "unclassified",
];

/** 分类的显示词（**分别命名**：不把口径边界都叫「对账差」） */
export const ONLY_IN_CODE_CATEGORY_LABEL: Record<OnlyInCodeDisplayCategory, string> = {
  actionable_mismatch: "真差异（待归属）",
  outside_scope: "范围外",
  structural: "结构性目录",
  unclassified: "未分类（旧对账结果）",
};

/** 分类一句话（面板上直接显示；点明它凭什么不算错） */
export const ONLY_IN_CODE_CATEGORY_HINT: Record<OnlyInCodeDisplayCategory, string> = {
  actionable_mismatch: "对账范围内没有声明、且是有源码文件的代码模块——交设计/执行角色核实（这条才叫对账差）",
  outside_scope: "设计材料在本次比对的章节之外点到过它（如声明在别的章节）——对账只比模块清单章节",
  structural: "仓库根 / 无源码文件的目录 / .gitignore 忽略的产物目录——非待归属，不当代码模块判绿",
  unclassified: "这份对账结果是分类口径上线前生成的，请重跑对账（重跑前不猜分类）",
};

/** 分类对应的小徽标样式（图面节点；真差异才是黄——口径边界不用黄，免得"都是问题"） */
export const ONLY_IN_CODE_CATEGORY_BADGE: Record<OnlyInCodeDisplayCategory, string> = {
  actionable_mismatch: "bg-yellow-900/70 text-yellow-300",
  outside_scope: "bg-neutral-800 text-neutral-400",
  structural: "bg-neutral-800 text-neutral-500",
  unclassified: "bg-neutral-800 text-neutral-500",
};

/** 只读界面需要的字段（服务端的 `OnlyInCodeEntry` 是它的超集） */
export interface OnlyInCodeLike {
  id: string;
  name: string;
  path?: string;
  category?: string;
}

/** 一条差异的显示分类（未知/缺失 ⇒ `unclassified`，不猜） */
export function categoryOfOnlyInCode(entry: OnlyInCodeLike): OnlyInCodeDisplayCategory {
  const c = entry.category;
  return c === "actionable_mismatch" || c === "outside_scope" || c === "structural" ? c : "unclassified";
}

/** 按分类分计（保留原始事实：每个分类里是**逐条**的名字） */
export function groupOnlyInCode(
  entries: readonly OnlyInCodeLike[],
): Record<OnlyInCodeDisplayCategory, OnlyInCodeLike[]> {
  const out = {
    actionable_mismatch: [],
    outside_scope: [],
    structural: [],
    unclassified: [],
  } as Record<OnlyInCodeDisplayCategory, OnlyInCodeLike[]>;
  for (const e of entries) out[categoryOfOnlyInCode(e)].push(e);
  return out;
}

/** 配对依据的显示计数（V08-02 C3 的置信度口径；V09-08 增加「落点未证实」一档） */
export function countMatchedByVia(
  matched: readonly { via?: string }[],
): { implementation: number; locator_unverified: number; name_signal: number } {
  return {
    implementation: matched.filter((m) => m.via === "plan_section_ref").length,
    locator_unverified: matched.filter((m) => m.via === "plan_section_locator").length,
    name_signal: matched.filter((m) => m.via === "name_signal").length,
  };
}
