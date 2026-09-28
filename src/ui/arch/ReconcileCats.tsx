// V09-08 ③：对账差异「分类分计」那一行的**唯一渲染实现**（技术详情三图共用 + Gate 过关现场共用）。
//
// 为什么抽成一个组件：附录 E.7 裁定④ 要求「技术详情三图与 Gate 面板按分类分计、口径一致」。
// 三个消费点各写一段 JSX 就是"三套口径"的温床（词表、顺序、计数方式任何一处漂了，
// 用户看到的就是两套说法）。这里只做渲染：条目与判据都是外部给的
// （服务端 `only_in_code` 的分类 ＋ `reconcileClass.ts` 的同一份词表）。
//
// 参数说明：
//   · `entries` —— `only_in_code` 原始事实（每条自带 `category`）；
//   · `anchor`  —— 这一行的 `data-*` 锚点属性名（三处各不相同，验证脚本据此分别读数）；
//   · `hint`    —— 是否附「只有真差异才叫对账差」的口径句（Gate 现场短一行，默认附）。
import {
  ONLY_IN_CODE_CATEGORY_BADGE,
  ONLY_IN_CODE_CATEGORY_HINT,
  ONLY_IN_CODE_CATEGORY_LABEL,
  ONLY_IN_CODE_CATEGORY_ORDER,
  groupOnlyInCode,
  type OnlyInCodeLike,
} from "./reconcileClass";

export function ReconcileCats({
  entries,
  anchor,
  hint = true,
}: {
  entries: readonly OnlyInCodeLike[];
  /** 这一行的 data 锚点（如 `data-reconcile-only-in-code-cats`） */
  anchor: string;
  hint?: boolean;
}): React.ReactElement | null {
  const grouped = groupOnlyInCode(entries);
  const shown = ONLY_IN_CODE_CATEGORY_ORDER.filter((c) => grouped[c].length > 0);
  if (shown.length === 0) return null;
  return (
    <p {...{ [anchor]: "1" }}>
      代码侧差异分类：
      {shown.map((c) => (
        <span key={c} className="ml-2" data-diff-category={c}>
          <span
            className={`rounded px-1.5 py-0.5 ${ONLY_IN_CODE_CATEGORY_BADGE[c]}`}
            title={ONLY_IN_CODE_CATEGORY_HINT[c]}
          >
            {ONLY_IN_CODE_CATEGORY_LABEL[c]}
          </span>{" "}
          <span className="text-neutral-300">{grouped[c].length}</span> 项
        </span>
      ))}
      {hint && (
        <span className="ml-2 text-neutral-600">
          （只有「{ONLY_IN_CODE_CATEGORY_LABEL.actionable_mismatch}」才是对账差；其余是口径边界，不当代码模块判绿）
        </span>
      )}
    </p>
  );
}
