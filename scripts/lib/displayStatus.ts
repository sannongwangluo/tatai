// V08-06 收尾（2026-09-24）：技术详情三视图的状态口径从 **v1 四色**（progress.json 自报进度）
// 换成 **v2 派生上屏状态**（DESIGN.md §4.2 / 附录 D）。
//
// a5 / f4 / n3 三个 UI 脚本要断言"界面上屏的状态与实况相符"，期望值不能各写一套、更不能再按
// progress.json 自报状态算（那正是本次要换掉的口径）。这里按 `src/ui/components/ArchView.tsx`
// 的 useEffect **逐行同口径**算一遍：三个只读接口（`arch/blueprint` + `status-projection` +
// `arch/reconcile`）→ `taskDerivedModuleStatus` → `moduleStatusKeysOf`；上屏键（六态键 /
// `no_status_record` / `unmapped`）再按 `ArchCanvas.tsx` 的渲染口径折算成徽标文字与状态色
// ——画布拿到的只是一串键（`statusOverride[id]`），短标取六态色表的 `short`，被定位时
// `data-arch-focus-color` 取六态色表的 `hex`。
//
// 注意（实测过、别想当然）：技术模块 id（`audit`/`src`…）的状态只由 `plan:code:<id>` 节点的
// **任务成员聚合**决定（`taskDerivedModuleStatus` ① 段），`declared_links` 只参与 `plan:mod:*`
// 的继承——所以对账结果的时序（A5 的 UI 段自己会先 POST 一次对账）不影响本函数的返回值。
import type { Blueprint } from "../../src/arch/blueprint";
import type { StatusProjection } from "../../src/server/work/statusProjection";
import { moduleStatusKeysOf, taskDerivedModuleStatus } from "../../src/ui/arch/projectGraph";
import { DISPLAY_STATUS_PALETTE, NO_STATUS_RECORD_KEY } from "../../src/ui/arch/statusColor";
import { declaredLinksFromMatched } from "../../src/shared/reconcileLinks";

/** 一个技术模块 id 在界面上会呈现成什么（= `ArchCanvas` 该节点 DOM 属性的期望值） */
export interface TechDisplayExpectation {
  /** 上屏键：`data-display-status` 的值（六态键 / `no_status_record` / `unmapped`） */
  key: string;
  /** 徽标文字：`data-status-label` 的值（"已验证通过" / "无状态记录" …） */
  label: string;
  /** 状态色：被定位时 `data-arch-focus-color` 的值（六态色表的 hex） */
  hex: string;
}

/** 徽标文字（`ArchCanvas` 的三分支：无状态记录 / 未映射 / 六态短标） */
function badgeLabelOf(key: string): string {
  if (key === NO_STATUS_RECORD_KEY) return "无状态记录";
  if (key === "unmapped") return "未映射";
  return DISPLAY_STATUS_PALETTE[key as keyof typeof DISPLAY_STATUS_PALETTE]?.short ?? "已规划";
}

/** 状态色（`ArchCanvas` 的 `statusHex`：六态键走六态表；`unmapped` = displayStatus 为 null → planned 灰） */
function statusHexOf(key: string): string {
  if (key === "unmapped") return DISPLAY_STATUS_PALETTE.planned.hex;
  return DISPLAY_STATUS_PALETTE[key as keyof typeof DISPLAY_STATUS_PALETTE]?.hex ?? DISPLAY_STATUS_PALETTE.planned.hex;
}

/**
 * 按界面同一份派生算「技术模块 id → 上屏状态」。`baseUrl` 指正在跑的后端（8787 或动态端口）。
 * 三个接口任一失败就抛——期望值算不出来时必须让脚本红，不能悄悄降级成"随便什么状态都算过"。
 */
export async function fetchTechDisplayExpectations(input: {
  baseUrl: string;
  projectId: string;
  techIds: readonly string[];
}): Promise<Record<string, TechDisplayExpectation>> {
  const url = (suffix: string): string =>
    `${input.baseUrl}/api/projects/${encodeURIComponent(input.projectId)}${suffix}`;
  const get = async (suffix: string): Promise<Record<string, unknown>> => {
    const res = await fetch(url(suffix));
    if (!res.ok) throw new Error(`GET ${suffix} → HTTP ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  };
  const [bpRaw, projRaw, recRaw] = await Promise.all([
    get("/arch/blueprint"),
    get("/status-projection"),
    get("/arch/reconcile"),
  ]);
  const bp = bpRaw.blueprint as { exists?: boolean; blueprint?: Blueprint } | undefined;
  const blueprint = bp?.exists === true ? (bp.blueprint ?? null) : null;
  if (blueprint === null) throw new Error("项目没有已发布规划图：技术详情画布拿不到 v2 派生状态");
  const projection: Record<string, StatusProjection> = {};
  const projObjects = (projRaw.projection as { objects?: StatusProjection[] } | undefined)?.objects ?? [];
  for (const o of projObjects) projection[o.object_id] = o;
  const rec = recRaw.reconcile as
    | { exists?: boolean; result?: { matched?: { stable_id?: string; module_id: string; via?: string }[] } }
    | undefined;
  // V09-08 ①②：只有材料点名了实现落点的配对才继承状态色（未证实/名字信号不继承）
  const links = declaredLinksFromMatched(rec?.exists === true ? (rec.result?.matched ?? []) : []);
  const keys = moduleStatusKeysOf(taskDerivedModuleStatus({ blueprint, projection, declared_links: links }));
  const out: Record<string, TechDisplayExpectation> = {};
  for (const id of input.techIds) {
    // 表里没有这个节点时画布如实标「无状态记录」（`ArchCanvas` 的 `?? NO_STATUS_RECORD_KEY`）
    const key = keys[id] ?? NO_STATUS_RECORD_KEY;
    out[id] = { key, label: badgeLabelOf(key), hex: statusHexOf(key) };
  }
  return out;
}
