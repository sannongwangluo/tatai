// A3 验证脚本（用 tsx 跑）：dagre 顶层布局 + 边权重→粗细映射 + 前端 bundle 含 @xyflow/react。
// 用法：pnpm verify:a3
// 覆盖点（对应 A3 卡 DoD ①③④）：
//   ① dagre 布局：给定 nodes/edges 产出有限坐标；按边方向分层（LR：上游 x 小于下游 x）；
//      同层节点矩形无重叠（抽查全部两两组合）；
//   ③ 边权重 → strokeWidth 1–6 梯度：最小权重→1、最大权重→6、单调不减；
//   ④ 依赖真进 bundle：现场跑一次 vite build（产物落临时目录，不碰仓库 dist/）后，产物里能找到 react-flow 的类名；
//   ② 默认折叠（§3.3 规则 5）：expanded 全 false 时 toFlow 口径下仅顶层节点可见——
//      该过滤逻辑在 ArchView.tsx 内，用真实渲染 JSON 走 playwright 截图断言（见 .工作台/verify/a3-*.png）。
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { layoutWithDagre, weightToStrokeWidth, NODE_WIDTH, NODE_HEIGHT } from "../src/ui/arch/layout";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const ok = (cond: boolean, label: string) => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (!cond) process.exitCode = 1;
};

// ── ① dagre 布局：坐标有限、按边方向分层、同层无重叠 ──
// 样例贴近塔台真实渲染 JSON：7 节点 5 边（ui→server、mcp→server、arch→server、scripts→arch、root→arch）
const nodes = ["src/ui", "src/server", "src/mcp", "src/arch", "scripts", "templates", "."].map(
  (id) => ({ id }),
);
const edges = [
  { from: "src/ui", to: "src/server" },
  { from: "src/mcp", to: "src/server" },
  { from: "src/arch", to: "src/server" },
  { from: "scripts", to: "src/arch" },
  { from: ".", to: "src/arch" },
];
const laid = layoutWithDagre(nodes, edges);
const pos = new Map(laid.map((p) => [p.id, p]));
ok(laid.length === nodes.length, `布局产出全部节点坐标（${laid.length}/${nodes.length}）`);
ok(
  laid.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)),
  "全部坐标为有限数值",
);
// LR 分层：每条边 上游.x + 节点宽 ≤ 下游.x（中间隔 ranksep）
ok(
  edges.every((e) => pos.get(e.from)!.x + NODE_WIDTH <= pos.get(e.to)!.x),
  "按边方向分层（LR：上游整框在下游左侧，无回叠）",
);
// 两两矩形重叠抽查（AABB，间距由 dagre nodesep 保证）
let overlap = 0;
for (let i = 0; i < laid.length; i++) {
  for (let j = i + 1; j < laid.length; j++) {
    const a = laid[i];
    const b = laid[j];
    const hit =
      a.x < b.x + NODE_WIDTH && b.x < a.x + NODE_WIDTH &&
      a.y < b.y + NODE_HEIGHT && b.y < a.y + NODE_HEIGHT;
    if (hit) {
      overlap++;
      console.log(`  [overlap] ${a.id} × ${b.id}`);
    }
  }
}
ok(overlap === 0, `节点两两无重叠（${laid.length} 节点全部组合抽查）`);
// 孤立节点（无入无出，如 templates）也有合法位置
ok(pos.has("templates"), "孤立节点照常排布（templates）");

// ── ③ 边权重 → strokeWidth 1–6 梯度 ──
ok(weightToStrokeWidth(1, 10) === 1, "最小权重 → 1");
ok(weightToStrokeWidth(10, 10) === 6, "最大权重 → 6");
ok(weightToStrokeWidth(5, 10) > 1 && weightToStrokeWidth(5, 10) < 6, "中间权重落在 1–6 之间");
ok(
  weightToStrokeWidth(1, 1) === 1 && weightToStrokeWidth(3, 1) === 1,
  "全图只有一档权重（max=1）退化为统一细线，不除零",
);
let monotonic = true;
for (let w = 1; w < 20; w++) {
  if (weightToStrokeWidth(w, 20) > weightToStrokeWidth(w + 1, 20)) monotonic = false;
}
ok(monotonic, "权重递增 → 粗细单调不减（1..20 全扫）");

// ── ④ bundle 含 @xyflow/react：真跑一次前端构建，产物里找 react-flow 类名 ──
// Q9：产物落到临时目录（--outDir），不重建/覆写仓库 dist/——验证脚本不该动别人手上那份产物
//（并发开着的 dev server、别人自己 build 的 dist）。断言强度不变：仍是当前源码现场构建出的产物。
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-a3-out-"));
console.log(`[verify] 跑 pnpm exec vite build --outDir ${outDir} …`);
execSync(`pnpm exec vite build --outDir "${outDir}" --emptyOutDir`, {
  cwd: REPO_ROOT,
  stdio: "inherit",
});
const assetsDir = path.join(outDir, "assets");
const assets = fs.readdirSync(assetsDir).map((f) => fs.readFileSync(path.join(assetsDir, f), "utf8"));
ok(
  assets.some((t) => t.includes("react-flow__node")),
  "构建产物 bundle 含 react-flow 类名（@xyflow/react 真打进前端产物）",
);
fs.rmSync(outDir, { recursive: true, force: true });

console.log(process.exitCode ? "[verify] 存在 FAIL" : "[verify] 全部 PASS");
