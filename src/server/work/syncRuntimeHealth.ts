// 同步证据后台发现的**宿主内错误汇**（PLAN V09-23 返工B；DESIGN.md §2.10；docs/sync-evidence-contract.md「自动发现、写入与重新验证」）。
//
// 为什么单开一个零依赖模块（契约第 47 行「后台异常的组合接口」）：
//   · 只保存**当前宿主内**的发现错误（注册表读不出 / 项目超上限 / 收件目录监听挂不上 / 扫描提交失败），
//     **不保存同步通过状态、不作为第二账本**——同步事实仍只认 `.工作台/work/events.jsonl`。
//   · 它**不 import 任何业务模块**（只 node:*），所以读口（`read_sync_status` / `computeSyncBlock`）
//     引它不会把 `sync → 六图 builder` 的依赖链拉回来（防 `sixGraphsOf → entry → sync → 探针 → sixGraphsOf` 递归）。
//   · 桌面与独立 daemon 共用同一份进程内汇；进程退出即消失（不落盘、不需要清理残留文件）。
//
// 语义（契约定版，逐字对齐）：
//   · `reportSyncDiscoveryIssue(dataDir, projectId, issue)`：`projectId=null` 表示**全局**发现错误；
//     `issue=null` 表示**相应成功重试后清除**该项（全局或该项目）。
//   · `readSyncDiscoveryIssues(dataDir, projectId)`：读某项目的发现错误——**含全局**（宿主级故障影响所有项目），
//     但**不含别的项目**的错误（「没有同步配置的旧项目不因其他项目单独故障被阻断」）。
//     `projectId=null` 只读全局。返回只读副本，调用方不得改内部状态。
//   · `clearSyncDiscoveryIssues(dataDir)`：清掉该 dataDir 的全部发现错误（停宿主时收尾用，防残留）。
//
// 错误按 dataDir 规范化（`path.resolve`）分桶——隔离夹具/多数据目录互不串。
import path from "node:path";

export interface SyncDiscoveryIssueMap {
  /** 宿主级（全局）发现错误 */
  global: Set<string>;
  /** 按项目名的发现错误 */
  projects: Map<string, Set<string>>;
}

/** 进程内汇：dataDir（规范绝对路径）→ 错误集合。进程退出即消失，不落盘。 */
const store = new Map<string, SyncDiscoveryIssueMap>();

function bucketOf(dataDir: string): SyncDiscoveryIssueMap {
  const key = path.resolve(dataDir);
  let bucket = store.get(key);
  if (bucket === undefined) {
    bucket = { global: new Set<string>(), projects: new Map<string, Set<string>>() };
    store.set(key, bucket);
  }
  return bucket;
}

/**
 * 报告（或清除）一条后台发现错误。
 *
 * @param dataDir 宿主的数据目录（内部按 `path.resolve` 规范化分桶）
 * @param projectId 项目 id；`null` = 全局（宿主级）错误
 * @param issue 错误文案；`null` = 相应成功重试后清除该项
 */
export function reportSyncDiscoveryIssue(dataDir: string, projectId: string | null, issue: string | null): void {
  const bucket = bucketOf(dataDir);
  if (projectId === null) {
    bucket.global.clear();
    if (issue !== null && issue !== "") bucket.global.add(issue);
    return;
  }
  if (issue === null || issue === "") {
    bucket.projects.delete(projectId);
    return;
  }
  const set = bucket.projects.get(projectId) ?? new Set<string>();
  set.add(issue);
  bucket.projects.set(projectId, set);
}

/**
 * 读发现错误：`projectId=null` 只读全局；给项目 id 时**全局 + 该项目**（不含别的项目）。
 * 返回独立数组副本，调用方可安全持有。
 */
export function readSyncDiscoveryIssues(dataDir: string, projectId: string | null): string[] {
  const bucket = store.get(path.resolve(dataDir));
  if (bucket === undefined) return [];
  if (projectId === null) return [...bucket.global];
  return [...bucket.global, ...(bucket.projects.get(projectId) ?? [])];
}

/** 清掉该 dataDir 的全部发现错误（停宿主收尾用；幂等） */
export function clearSyncDiscoveryIssues(dataDir: string): void {
  store.delete(path.resolve(dataDir));
}
