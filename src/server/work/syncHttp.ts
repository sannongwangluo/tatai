// 同步状态的 HTTP 只读读口（PLAN V09-23；docs/sync-evidence-contract.md「接口、界面和交付」）。
//
// GET /api/projects/:id/sync-status —— 只读、**不触发扫描写账**；每次重读必要文件与实际目标，
// 历史 passed 不等于当前 passed。返回体形状由 src/shared/syncEvidence.ts 定死，信封按本仓惯例
// `{ok:true, sync:{…}}`（界面 V09-24 按 sync/sync_status/顶层 三序认，这里给 sync）。
//
// 单一职责：解析路径 + 调 readSyncStatus + 拼信封。判据在 sync.ts（与 MCP read_sync_status 同一份）。
import type { IncomingMessage, ServerResponse } from "node:http";
import { getProject } from "../registry";
import { readProjectDiscoveryIssues } from "./sync";
// V09-37：CPU 重的只读同步判据挪进有界 worker（主线程只等消息——健康口不被占住）。
import { runReadJob, describeReadJobError } from "./readWorkerPool";
import { runWithHostHealth, HealthUnstable } from "./syncRuntimeHealth";

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
  // V09-37：重派生在有界 worker 里跑；本路由立即返回 true，响应在 worker 回消息后写。
  // 与 work 面 `/api/work/sync/status` 返回**同一份** report 与后台发现错误（MCP 跨进程读到宿主健康）。
  // 复审 A：worker 线程有独立模块内存，宿主汇不共享——主线程读出真实错误随参数带入，回包后再读一次做
  // **有界**健康对账；作业期间健康持续变化 → 503 HEALTH_UNSTABLE，绝不把新错误拼到旧 passed 报告上。
  void runWithHostHealth(
    () => readProjectDiscoveryIssues(projectId, dataDir),
    (issues) => runReadJob("sync_status", { projectId, dataDir, discoveryIssues: issues }),
  )
    .then((reconciled) => {
      if (res.headersSent) return;
      json(200, { ok: true, sync: reconciled.value, discovery_issues: reconciled.issues });
    })
    .catch((e: unknown) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      // 结构化作业错误（code/detail）原样带出，不压成通用 SYNC_STATUS_FAILED；LEDGER_UNSTABLE/SOURCE_CHANGED
      // 等瞬时态 → 503。健康持续抖动 = HEALTH_UNSTABLE(503)。
      const d = e instanceof HealthUnstable
        ? { code: "HEALTH_UNSTABLE", message: e.message, detail: { issues: e.issues }, httpStatus: 503 }
        : describeReadJobError(e);
      json(d.httpStatus, { ok: false, error: { code: d.code, message: d.message, detail: d.detail } });
    });
  return true;
}
