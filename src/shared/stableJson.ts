// 确定性 JSON（canonical JSON）：对象键递归排序，数组保持原序。
//
// 为什么单独放这里：构建身份（docs/agent-optimization-20261006.md §4.3）要用它算 `release_id`，
// 而构建层**不得**导入 `src/server/work/**`（那会把整个写服务依赖环拖进构建脚本与前端配置，
// Codex 对 P0 的纠正明确点名）。所以把它提取成一个**纯原语**：零 node import、零 React，
// 浏览器与服务端、构建脚本都能引。
//
// 与 `src/server/work/syncContract.ts#stableStringify` 的关系（**已统一**）：本文件是唯一实现，
// `syncContract.ts` 改为 `import` + `export { stableStringify }` 再导出同名函数（2026-10-06 集成修正）。
// 两处输出必须逐字节相同——`scripts/verify-build-identity.ts` 有对账用例（同一判据，不许分叉）。
export function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (typeof v === "object" && v !== null) {
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}
