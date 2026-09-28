// A5/N3：模块四色状态（DESIGN.md §4.2）的**唯一色值出处**。
//
// A5 起方框图（`ArchCanvas.tsx`）用 tailwind 类画这四色，N2 起思维导图（`MindMapView.tsx`）用
// 十六进制色值给自己的节点上色——同一个 `doing` 在两处各写一份就会漂。N3 把「颜色 + 中文词」
// 一起收到这里：两个渲染器 import 同一份，定位高亮的颜色也读它（DoD②「高亮同时体现四色状态」
// 与 A5 一致，靠的就是同一份色值而不是"看起来差不多"）。
// 色盲可辨口径不变（§4.2）：颜色 + 中文状态词双通道——`label` 就是那个文字通道。
//
// 零 React / 零 IO：视图与验证脚本读同一份。
export const STATUS_KEYS = ["todo", "doing", "done", "issue"] as const;
export type StatusKey = (typeof STATUS_KEYS)[number];

export interface StatusStyle {
  /** 十六进制色值（思维导图节点色 / 定位高亮环色） */
  hex: string;
  /** 中文状态词（文字通道） */
  label: string;
  /** 方框图节点边框的 tailwind 类 */
  border: string;
  /** 方框图状态徽标的 tailwind 类 */
  text: string;
}

/** 四色状态表：todo 灰 / doing 黄 / done 绿 / issue 红（§4.2 原表） */
export const STATUS_STYLE: Record<string, StatusStyle> = {
  todo: {
    hex: "#a3a3a3",
    label: "未开始",
    border: "border-neutral-600",
    text: "text-neutral-400 border-neutral-600",
  },
  doing: {
    hex: "#fbbf24",
    label: "进行中",
    border: "border-amber-400",
    text: "text-amber-300 border-amber-400",
  },
  done: {
    hex: "#34d399",
    label: "已完成",
    border: "border-emerald-500",
    text: "text-emerald-300 border-emerald-500",
  },
  issue: {
    hex: "#f87171",
    label: "有问题",
    border: "border-red-500",
    text: "text-red-300 border-red-500",
  },
};

/** 取色入口（v1 四色键与 v2 上屏键都认，§4.2）：
 *  · v2 上屏键（六态 + `no_status_record`）→ 六态色表（颜色与短标跟画布/主视图同一份）；
 *  · v1 四色键（progress.json 自报）→ 原四色表；不给键 → todo 灰。
 *
 *  V08-06 收尾（2026-09-24）：技术详情三视图改用 v2 派生状态之后，`MindMapView` 拿到的 `payload.status`
 *  已是 v2 上屏键——再走四色表就会整棵导图落回 todo 灰（实测导图状态线全是 #a3a3a3，与方框图同节点的
 *  绿/灰/红对不上）。取色入口认两套键，色值仍只此一处；`STATUS_STYLE` 与 `DISPLAY_STATUS_PALETTE`
 *  两张表仍各管一段口径，不合并。 */
export const statusStyle = (status?: string): StatusStyle => {
  const v2 = (DISPLAY_STATUS_PALETTE as Record<string, DisplayStatusStyle>)[status ?? ""];
  if (v2 !== undefined) return { hex: v2.hex, label: v2.short, border: v2.border, text: v2.text };
  return STATUS_STYLE[status ?? "todo"] ?? STATUS_STYLE.todo;
};

/** 定位高亮的强调色（"N3 定位到这里"的那圈光晕）：与四色状态色、与 F3 的流向边色都错开，
 *  它不是第五种状态色——四色状态仍由节点自己的边框/节点色表达，这圈只表示"刚被定位"。 */
export const FOCUS_RING_COLOR = "#22d3ee";

// ════════════════ V06-06：六态显示状态（DESIGN.md §4.2 表 + 优先级口径）════════════════
//
// 上面那份是 **v1 四色**（progress.json 自报进度，旧读口，A5/N3 口径不变）；
// 下面这份是 V06-06 三个主视图用的 **v2 六态**——状态由 `src/server/work/statusProjection.ts`
// 从任务/证据/有效性自动派生，**界面不提供任何涂色入口**（§4.2 明令）。
//
// 为什么标签在这里再写一遍而不是 import 服务端那份：`statusProjection.ts` 的值 import 会把
// 服务端 `node:fs` 依赖链拖进前端包（V06-05 已踩过：`pnpm build` 直接红）。所以色值与短标签
// 落在 UI 侧，**完整口径句逐字抄自 `DISPLAY_STATUS_LABELS`**，并由 `scripts/verify-v06-06.ts`
// 断言六键与整句与那份服务端口径逐字一致（漂移即红）——口径只有一份，只是分处两段运行时。

/** 六态键（顺序 = §4.2 优先级序：未知有效性→明确问题/阻塞→进行中→待验证→全部通过→未开始） */
export const DISPLAY_STATUS_KEYS = [
  "unknown",
  "blocked",
  "in_progress",
  "pending_verification",
  "verified",
  "planned",
] as const;
export type DisplayStatusKey = (typeof DISPLAY_STATUS_KEYS)[number];

export interface DisplayStatusStyle {
  /** 短标签（节点徽标上的文字通道；长句口径见 `full`） */
  short: string;
  /** 完整口径句：与 `statusProjection.ts` 的 `DISPLAY_STATUS_LABELS[key]` **逐字相同** */
  full: string;
  /** 图标通道（颜色之外的第二通道，§3.3「颜色同时配文字/图标」；无 emoji 依赖，纯字符） */
  icon: string;
  /** 十六进制色值（节点环/边色/图例） */
  hex: string;
  /** 节点边框 tailwind 类 */
  border: string;
  /** 徽标 tailwind 类（文字 + 边框） */
  text: string;
  /** 中性虚线的状态（未知/陈旧）：边框用虚线画，不用纯色糊过去（§4.2 表最后一行） */
  dashed?: true;
}

/** 六态色表：灰 planned / 蓝 in_progress / 橙 pending_verification / 绿 verified / 红 blocked /
 *  中性虚线 unknown（§4.2 表逐行） */
export const DISPLAY_STATUS_PALETTE: Record<DisplayStatusKey, DisplayStatusStyle> & {
  /** V08-02：派生不出状态时的显式中性样式（**不是**六态之一） */
  no_status_record: DisplayStatusStyle;
} = {
  planned: {
    short: "已规划",
    full: "灰：已规划，未开始",
    icon: "○",
    hex: "#a3a3a3",
    border: "border-neutral-500",
    text: "text-neutral-300 border-neutral-500",
  },
  in_progress: {
    short: "正在实现",
    full: "蓝：正在实现",
    icon: "▶",
    hex: "#60a5fa",
    border: "border-blue-400",
    text: "text-blue-300 border-blue-400",
  },
  pending_verification: {
    short: "做完了·待验证",
    full: "橙：结果待验证",
    icon: "△",
    hex: "#fb923c",
    border: "border-orange-400",
    text: "text-orange-300 border-orange-400",
  },
  verified: {
    short: "已验证通过",
    full: "绿：要求的验证已通过",
    icon: "✓",
    hex: "#34d399",
    border: "border-emerald-500",
    text: "text-emerald-300 border-emerald-500",
  },
  blocked: {
    short: "有阻塞",
    full: "红：有已确认问题或明确阻塞",
    icon: "✕",
    hex: "#f87171",
    border: "border-red-500",
    text: "text-red-300 border-red-500",
  },
  // V08-02 B2/B3/B4：模块（或任何对象）**派生不出状态**时的显式样式——
  // 与六态并列但**不进 `DISPLAY_STATUS_KEYS`**（六态是服务端口径，这里只是"没有记录"的如实标签，
  // 不冒充「已规划/未开始」，也不给完成色）。
  no_status_record: {
    short: "无状态记录",
    full: "灰虚线：无状态记录（没有任务通过实现映射指向它，也没有设计模块清单落点）",
    icon: "–",
    hex: "#737373",
    border: "border-dashed border-neutral-600",
    text: "text-neutral-400 border-neutral-600",
    dashed: true,
  },

  unknown: {
    short: "未知/陈旧",
    full: "中性虚线与文字：未知/陈旧",
    icon: "?",
    hex: "#737373",
    border: "border-dashed border-neutral-500",
    text: "text-neutral-400 border-neutral-600",
    dashed: true,
  },
};

/** 六态取样式：null（= 该对象不着完成色，纯静态引用线/无映射）落到 `planned` 的灰，
 *  但调用方必须自己决定要不要显示"未映射"——本函数不替它判语义（§4.2 不空集判绿）。 */
/** 「派生不出状态」的显式标记（与 `projectGraph.ts` 的 `NO_STATUS_RECORD` 同一字面量） */
export const NO_STATUS_RECORD_KEY = "no_status_record";

export const displayStatusStyle = (status?: string | null): DisplayStatusStyle =>
  (DISPLAY_STATUS_PALETTE as Record<string, DisplayStatusStyle>)[status ?? "planned"] ??
  DISPLAY_STATUS_PALETTE.planned;

/** 六态键集合（验证脚本与渲染层共用的白名单） */
export const isDisplayStatusKey = (v: unknown): v is DisplayStatusKey =>
  typeof v === "string" && (DISPLAY_STATUS_KEYS as readonly string[]).includes(v);
