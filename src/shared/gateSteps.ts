// 前后端共用的 Gate 七步常量（DESIGN.md §5.1）：**浏览器安全模块**——零 node 内建、零 server 依赖。
//
// 为什么单开这一份（2026-09-20 构建回归的根因）：
//   GATE_STEPS 既要给服务端数据层用（workstation / live / projects-summary / reverseDraft），
//   也要给前端 UI **值导入**（DesignView 的 Gate 步下拉、GateTimeline 的横向七步）。
//   只要 UI 从 `src/server/workstation` 值导入，vite 就会沿着
//   workstation → work/documents → `node:child_process` 把整条服务端链拉进浏览器包：
//   构建报 `"execFileSync" is not exported by "__vite-browser-external"`，dev 下前端页面直接挂不起来。
//   （类型导入 `import type` 构建时被擦除，所以 UI 对 server 模块只保留类型导入。）
//
// 口径红线：形状与取值**不许改**——GATE_STEPS 是 G1/G2/G3/L3/P2 与多个验证脚本在用的公开常量，
// 改它要走设计修订；本文件只是把它挪到浏览器也能安全 import 的位置，服务端仍从 workstation 取到同一个绑定。
//
// 同一条理由的先例：F2 把共用选择器拆到 `src/arch/shared-graph.ts`（零 node import），UI 与服务端引同一份。

/** 七步生命周期的一步：step id 用英文、显示名中文（DESIGN.md §5.1） */
export interface GateStep {
  id: string;
  name: string;
}

export const GATE_STEPS: readonly GateStep[] = [
  { id: "kickoff", name: "立项" },
  { id: "requirement", name: "需求" },
  { id: "design", name: "设计" },
  { id: "tasks", name: "任务拆解" },
  { id: "develop", name: "开发" },
  { id: "verify", name: "联调验证" },
  { id: "deliver", name: "交付/运维" },
];
