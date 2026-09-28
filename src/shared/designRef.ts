// 设计依据 token → 设计书章节的**纯解析**（浏览器安全：纯函数、零 node import、零 React）。
//
// 为什么单独放在 `src/shared/`：这条判据有两个消费者——蓝图派生侧
// （`src/arch/blueprint.ts` 的「设计依据 → 能力边」，原实现就在这里）与状态投影侧
// （`src/server/work/statusProjection.ts` 的分段失效复核要按本对象的设计引用章节比节哈希）。
// 后者再 import `src/arch/blueprint.ts` 会形成循环（blueprint.ts 已经 import 了 statusProjection.ts），
// 复制一份又违反「一事一源」——所以把判据本体提到跨层共享位（同 `shared/gateSteps.ts`、
// `shared/reconcileLinks.ts`、`shared/planCardHash.ts` 的先例）。**口径一个字节都没变**。
//
// 判据（返回 sections 下标；-1 = 定位不到，调用方报缺，不硬凑）：
//   ① **附录形态**（2026-09-25 终审返工补）：「附录 D」「附录 E.5」「附录 E.3.5」「附录 C.5-1」「附录 G-2」——
//      按附录字母＋可选子号定位 `## 附录 X` 或附录内的 `### X.N`／`#### X.N.M` 标题；连字符条目
//      （C.5-1、E.8-2）落回所属子节。此前只认数字节号，附录引用全部误报 unresolved_design_ref。
//   ② **数字节号形态**：`§2.8` / `§3.2–§3.3、§4.2` 这类写法里取出节号，匹配标题以该编号开头的章节。

export interface DesignSectionLike {
  path: string;
  title: string;
  level: number;
}

export function resolveDesignRef(refToken: string, sections: readonly DesignSectionLike[]): number {
  const appendix = refToken.match(/附录\s*([A-Za-z])\s*((?:[.\-]\d+)*)/);
  if (appendix !== null) {
    const letter = appendix[1].toUpperCase();
    const parts = (appendix[2] ?? "").replace(/^[.\-]/, "").split(/[.\-]/).filter((s) => s !== "");
    // 候选前缀从最具体到最粗：`X.3.5` → `X.3` → `X`（最后落附录大标题 `附录 X`）
    const titleStarts = (title: string, prefix: string): boolean => {
      if (!title.startsWith(prefix)) return false;
      const next = title.charAt(prefix.length);
      return next === "" || !/[0-9.]/.test(next);
    };
    for (let n = parts.length; n >= 1; n--) {
      const prefix = `${letter}.${parts.slice(0, n).join(".")}`;
      const idx = sections.findIndex((s) => s.level >= 2 && titleStarts(s.title, prefix));
      if (idx !== -1) return idx;
    }
    const headIdx = sections.findIndex((s) => s.level >= 2 && titleStarts(s.title, `附录 ${letter}`));
    if (headIdx !== -1) return headIdx;
  }
  const nums = refToken.match(/\d+(?:\.\d+)*/g) ?? [];
  for (const n of nums) {
    const re = new RegExp(`^${n.replace(/\./g, "\\.")}(?![0-9.])`);
    const idx = sections.findIndex((s) => s.level >= 2 && re.test(s.title));
    if (idx !== -1) return idx;
  }
  return -1;
}
