// MCP 侧「同源只读适配」（PLAN V09-23 返工C；DESIGN.md §2.10；docs/sync-evidence-contract.md「跨进程读取」）。
//
// 为什么需要：MCP stdio 是**另一个进程**，`syncRuntimeHealth.ts` 的发现错误汇是**宿主进程内存**——
// MCP 自己读那份汇永远是空的，不能据此冒充"后台无故障"（Codex 反例12）。本模块从**唯一宿主**的
// 只读读口取**同一份** report / 后台发现错误，再喂给同源判据（`readSyncStatus` / `computeSyncBlock`）。
//
// 硬口径：
//   · 纯只读——只用已有服务描述符，**绝不** ensure/拉起写者、**不**写任何事件（`readSyncStatusRemote`）；
//   · 宿主不可达或读口不完整：**配置过同步契约**的项目按 fail-closed 处理（合成一条"无法核对宿主后台健康"
//     的发现错误，既不静默当通过，也不把旧结论顶替）；**没有同步配置的旧项目**保持 not_configured（零影响）；
//   · HTTP 读口与 MCP 比较时 `checked_at` 允许差异，其余判据同源（同一份 `readSyncStatus` 语义）。
import { readSyncStatus } from "../../server/work/sync";
import "../../server/work/syncGraph"; // 组合根：确保 graph_full 探针已注册（本模块可能被独立引）
import type { WorkServiceClient } from "../../server/work/service";
import type { SyncStatusReport } from "../../shared/syncEvidence";

export interface HostSyncView {
  /** 应返回给调用方的同步状态报告（宿主可达＝宿主的同一份；不可达＝本进程按 fail-closed 算的） */
  report: SyncStatusReport;
  /** 供 entry 的 `sync_summary` 复算用的**同一份**后台发现错误（宿主可达＝宿主值；不可达且已配置＝合成项） */
  discovery_issues: string[];
  /** 是否从唯一宿主只读读口取到了同一份 report */
  host_reachable: boolean;
  /** 不可达原因（可达时为 null） */
  unreachable_reason: string | null;
}

/**
 * 取同步状态：优先从唯一宿主只读读口取**同一份** report 与后台发现错误；取不到时按「宿主不可达」处理——
 * 已配置项目 fail-closed（合成发现错误，overall 非 passed、阻断现行 blocks_entry 契约），未配置项目保持兼容。
 */
export async function hostSyncView(projectId: string, dataDir: string, work?: WorkServiceClient): Promise<HostSyncView> {
  if (work !== undefined) {
    const remote = await work.readSyncStatusRemote(projectId);
    if (remote !== null) {
      return { report: remote.report, discovery_issues: remote.discovery_issues, host_reachable: true, unreachable_reason: null };
    }
  }
  const reason = work === undefined ? "MCP 未拿到转接客户端（ctx.work）" : "唯一宿主不可达或只读读口不完整";
  const issue = `无法核对唯一宿主后台发现健康（${reason}）：按 fail-closed 处理——不把「宿主不可达」当成「后台无故障」（DESIGN.md §2.10）`;
  // **一次同源构造**：`unreachableIssues` 只在项目已配置同步契约时并入（顶替本进程不可信的错误汇），
  // 未配置的旧项目完全忽略它、保持 not_configured。这样不必「先探 configured 再重算一遍」——那会
  // 把整仓六图重复构建两轮（2026-10-02 诊断的 17 秒本地回退就是这么来的）。
  const report = readSyncStatus(projectId, dataDir, { unreachableIssues: [issue] });
  if (!report.configured) {
    // 旧项目（无同步配置）：宿主可达与否都不影响——保持 not_configured（旧项目完全兼容）。
    return { report, discovery_issues: [], host_reachable: false, unreachable_reason: reason };
  }
  return { report, discovery_issues: [issue], host_reachable: false, unreachable_reason: reason };
}
