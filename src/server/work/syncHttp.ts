// 同步状态的 HTTP 只读读口（PLAN V09-23；docs/sync-evidence-contract.md「接口、界面和交付」）。
//
// GET /api/projects/:id/sync-status —— 只读、**不触发扫描写账**；每次重读必要文件与实际目标，
// 历史 passed 不等于当前 passed。返回体形状由 src/shared/syncEvidence.ts 定死，信封按本仓惯例
// `{ok:true, sync:{…}}`（界面 V09-24 按 sync/sync_status/顶层 三序认，这里给 sync）。
//
// 单一职责：解析路径 + 调 readSyncStatus + 拼信封。判据在 sync.ts（与 MCP read_sync_status 同一份）。
import type { IncomingMessage, ServerResponse } from "node:http";
import { getProject } from "../registry";
import { readProjectDiscoveryIssues, readSyncStatus } from "./sync";

const SYNC_STATUS_PATH_RE = /^\/api\/projects\/([^/]+)\/sync-status\/?$/;

/** 命中就返回项目 id（已解码）；不是本路由返回 null */
export function projectIdOfSyncStatusPath(pathname: string): string | null {
  const m = SYNC_STATUS_PATH_RE.exec(pathname);
  if (m === null) return null;
  try {
    return decodeURIComponent(m[1] as string);
  } catch {
    return null;
  }
}

/**
 * 处理同步状态读口；返回 true 表示本路由已应答（含 4xx/5xx），false 表示不是本路由。
 * 只应答 GET；其它方法不吞（返回 false 交给主路由给 405）。
 */
export function handleSyncStatusRoute(req: IncomingMessage, res: ServerResponse, pathname: string, dataDir: string): boolean {
  const projectId = projectIdOfSyncStatusPath(pathname);
  if (projectId === null) return false;
  if (req.method !== "GET") return false;
  const json = (status: number, body: unknown): void => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  };
  if (getProject(projectId, dataDir) === undefined) {
    json(404, { ok: false, error: { code: "PROJECT_NOT_FOUND", message: `项目不存在: ${projectId}` } });
    return true;
  }
  try {
    // V09-23 返工C：与 work 面 `/api/work/sync/status` 返回**同一份** report 与后台发现错误——
    // 桌面宿主（index.ts）直挂本路由，未转发 work 面，MCP 另一进程据此跨进程读到宿主健康（Codex 反例12）。
    json(200, { ok: true, sync: readSyncStatus(projectId, dataDir), discovery_issues: readProjectDiscoveryIssues(projectId, dataDir) });
  } catch (e) {
    json(500, { ok: false, error: { code: "SYNC_STATUS_FAILED", message: e instanceof Error ? e.message : String(e) } });
  }
  return true;
}
