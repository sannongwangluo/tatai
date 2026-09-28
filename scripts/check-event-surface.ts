// check-event-surface：事件面全覆盖检查的 CLI 入口（PLAN V07-02；「系统能进的状态必须有出口」）。
//
// 登记表与检查逻辑的**唯一事实源**自 V07-04 起在 `src/server/work/eventSurface.ts`——
// CLI 与 doctor 工具（MCP）都从那里读，本文件只剩"打印 + 退出码"，不再自己留第二张表。
//
// 工具名单：检查器不再反向 import 注册表（会成环，见 eventSurface.ts 顶部注释），
// 所以本入口**显式**把自己的工具名单传下去——CLI 是顶层入口，不依赖"谁先 import 了注册表"
// 这种隐式顺序；下面那行 import 同时负责把名单来源登记进检查器，供 doctor 的缺省路径使用。
//
// 用法：node --import tsx scripts/check-event-surface.ts（verify:v07-02 会调它）
export { checkEventSurface, type SurfaceCheckResult } from "../src/server/work/eventSurface";
import { checkEventSurface } from "../src/server/work/eventSurface";
import { TOOLS } from "../src/mcp/tools/index";

// 直接运行时打印结果；被 verify 引入时不自动跑 main
if (process.argv[1] !== undefined && process.argv[1].endsWith("check-event-surface.ts")) {
  const r = checkEventSurface(TOOLS.map((t) => t.name));
  for (const p of r.problems) console.error(`[event-surface] FAIL ${p}`);
  console.log(
    `[event-surface] 注册事件 ${r.covered} 种全数登记；工具面出口 ${r.toolSurfaces.length} 条：${r.toolSurfaces.join("、")}`,
  );
  process.exit(r.ok ? 0 : 1);
}
