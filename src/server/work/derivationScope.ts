// 一次「现读派生」内的**只读重算消除**（2026-10-07 运行时阻塞修复）。
//
// 事由（独立 CPU profile 实测，证据见 E/runtime-profile-only/REPORT.md 与
// E/runtime-final/COORDINATOR-HYPOTHESES.md）：桌面宿主的只读派生在**一次调用里**把同一批只读输入
// 反复重算——`graphSummaryOf(tatai)` 一次读 922 MB、7552 次 `readFileSync`、7.4 万次元数据调用、
// 14 秒 CPU，其中同一份 466 KB 的不可变修订对象被读+核哈希 944 次、当前 DESIGN/PLAN 被读+解析 18 次、
// 源清单里每个源文件被读+哈希约 30 次，并伴随多次同步 `git check-ignore`。这些重算来自**同一个派生里
// 多个子派生各自重读**（入口/六图/义务层/来源标注各读一遍盘）。
//
// 为什么这是修复而不是缓存（口径必须守住）：
//   · 作用域**只活在「一次同步派生」的生命期内**，`finally` 一到就整体丢弃——**跨请求一律不缓存**，
//     所以下一次读口调用照旧现读现算，源一变下一个请求立刻看见（没有 TTL、没有陈旧窗口）；
//   · 复用的都是**同一瞬间、同一输入**的纯只读计算结果（读文件字节、解析、内容哈希、git 忽略探针），
//     判据一分不改、返回对象与"各读各的"逐字段相同；
//   · 派生函数都是**同步**的（无 `await`），作用域用 try/finally 严格成对进出，不存在异步交错串味；
//     `withDerivationScope` 可嵌套（内层复用外层作用域，不新开、不清空）。
//   · **没有活跃作用域时** `memoizedForDerivation` 直接现算——不引入本模块时的行为逐字不变，
//     这也让写路径与单测路径完全不受影响。
//
// 与 V09-38 的关系：账本（events.jsonl）的"内容核验"口径**不在本模块**，也不受本模块影响——
// 账本仍旧每次现读并核真实字节摘要（`ledgerRead`），本模块只覆盖**不可变/派生只读输入**的重算。

/** 桶名 → 键 → 值。桶名用于隔离不同种类的复用（读文本 / 解析 / 哈希 / git 探针）。 */
const buckets = new Map<string, Map<string, unknown>>();
let depth = 0;

/**
 * 在**一次同步派生**内执行 `fn`：期间 `memoizedForDerivation` 的记忆有效，返回/抛错都整体丢弃。
 * 可嵌套：内层复用外层作用域（同一批记忆），只在最外层进出时清空。
 */
export function withDerivationScope<T>(fn: () => T): T {
  depth += 1;
  if (depth === 1) buckets.clear();
  try {
    return fn();
  } finally {
    depth -= 1;
    if (depth === 0) buckets.clear();
  }
}

/** 当前是否处在一次派生的作用域里（读口/自检用；不改变任何行为） */
export function inDerivationScope(): boolean {
  return depth > 0;
}

/**
 * 同一次派生内、同一 `bucket`+`key` 只算一次。**没有活跃作用域时直接 `compute()`**（行为不变）。
 * 注意：`compute` 必须是对当前盘上内容的**纯只读**计算，且其输入在同一派生内不会再变。
 */
export function memoizedForDerivation<T>(bucket: string, key: string, compute: () => T): T {
  if (depth === 0) return compute();
  let m = buckets.get(bucket);
  if (m === undefined) {
    m = new Map<string, unknown>();
    buckets.set(bucket, m);
  }
  if (m.has(key)) return m.get(key) as T;
  const value = compute();
  m.set(key, value);
  return value;
}

/** 只报数（自检/验证脚本读；不写任何东西、不改状态） */
export function derivationScopeStats(): { active: boolean; buckets: number; entries: number } {
  let entries = 0;
  for (const m of buckets.values()) entries += m.size;
  return { active: depth > 0, buckets: buckets.size, entries };
}

/** 仅供验证脚本对照"复用确实发生/没发生"用（清空当前记忆，不进/不出作用域） */
export function resetDerivationScopeForTest(): void {
  buckets.clear();
}
