// 持久项目说明索引的唯一宿主面与转接客户端（PLAN.md V09-39；DESIGN.md §6.8；契约 U5/U5.1）。
//
// 本模块仿 `baselineHost.ts` 的两段式：
//   ① **服务侧** `handleProjectIndexRequest`：在唯一写入服务宿主（桌面后端 `index.ts` 或独立 daemon 同一
//      `createWorkHost`）里应答 `/api/work/project-index/{upsert,remove}`。它调用的就是 `projectIndex.ts`
//      里那套 upsert/remove——**同一份判据、同一写者**，不复制第二份实现。
//   ② **客户端** `callProjectIndexHost`：MCP stdio 是另一个进程，写必须经 `ctx.work.ensureWorkService()`
//      拿到的描述符转给唯一宿主。读（read/impact/coverage）**不走本模块**——那是本地纯读取，不拉 writer。
//
// ██ 红线 ██
//   · 读零副作用：本模块不提供读路由；MCP 的 read/impact/coverage 直接本地读，不 ensure 宿主。
//   · 写只经唯一宿主；本模块**不自己写** docs/project-notes.json，也不在 stdio 进程另建写者。
//   · 慢 body 竞态（V09-29 口径）：body 到达后、**实际落盘前**再查一次写者身份（描述符 pid + 令牌），
//     由宿主注入的 `assertWriteOwnership` 调 `WorkService.assertWriteOwner`。
//   · 体积上限：请求体超过 `PROJECT_INDEX_LIMITS.max_file_bytes + 256 KiB` 直接 413 拒绝，不进解析。
import type { IncomingMessage, ServerResponse } from "node:http";
import { PROJECT_INDEX_LIMITS, removeProjectNotes, upsertProjectNotes } from "./projectIndex";
import { isWorkError, WorkError, WORK_ERROR_CODES, type WorkErrorCode } from "./types";
import { WORK_TOKEN_HEADER, type WorkServiceClient } from "./service";

/** project-index 面路由前缀（与 `/api/work/` 同族；本模块只管自己这一段） */
export const PROJECT_INDEX_ROUTE_PREFIX = "/api/work/project-index/";

const MAX_BODY_BYTES = PROJECT_INDEX_LIMITS.max_file_bytes + 256 * 1024;

/** 错误码 → HTTP 状态（与 `service.ts` 的 HTTP_STATUS、`baselineHost.ts` 同值） */
const WORK_HTTP_STATUS: Record<WorkErrorCode, number> = {
  INVALID_COMMAND: 400,
  VERSION_CONFLICT: 409,
  IDEMPOTENCY_CONFLICT: 409,
  SERVICE_UNAVAILABLE: 503,
  PROJECTION_FAILED: 500,
  TAIL_QUARANTINED: 500,
  MIDDLE_CORRUPT: 500,
  // 读取期间账本一直在变：可重试的瞬时态
  LEDGER_UNSTABLE: 503,
  EVENT_INVALID: 500,
  EVIDENCE_INVALID: 400,
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  // 连接可能已被对端断开/销毁（例如 body 远超上限被 req.destroy）：写前查一次，写失败不抛出、
  // 不挂住宿主（否则 catch 分支里的 sendJson 自己再抛会打断应答线程）。
  if (res.writableEnded || res.destroyed) return;
  const text = JSON.stringify(body, null, 2);
  try {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(text);
  } catch {
    try {
      res.destroy();
    } catch {
      /* 已经没了 */
    }
  }
}

/**
 * 读请求体（带上限；超限抛 WorkError，由调用方映射 413）。
 *
 * 超限时**不立刻 destroy**（那会让客户端拿到 ECONNRESET 而收不到 413）：停止累积（丢弃已收块）、
 * 继续把剩余字节 drain 掉，到 `end` 再统一拒绝——这样调用方能正常写出 413，客户端读到确定的拒绝码。
 * **仍然累加已收字节**（有界）：超过「上限 + 16 MiB」才断连，避免无界 drain。
 *
 * 结算保证：`end` / `error` / `aborted` / 提前 `close` 都会**只结算一次** Promise——
 * 客户端中途断开或连接被销毁时不会留下永不 settle 的 Promise（不挂宿主）。
 */
function readBody(req: IncomingMessage, limitBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    let settled = false;
    const chunks: Buffer[] = [];
    const cleanup = (): void => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("aborted", onAborted);
      req.off("close", onClose);
    };
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };
    const onData = (c: Buffer): void => {
      size += c.length; // 始终累加（有界：下面超上限+16MiB 即断连）
      if (tooLarge) {
        if (size > limitBytes + 16 * 1024 * 1024) {
          try {
            req.destroy();
          } catch {
            /* 已经没了 */
          }
          settle(() => reject(new WorkError("INVALID_COMMAND", `请求体远超 ${limitBytes} 字节上限（已收 ${size} 字节），断连`, { limit_bytes: limitBytes, received_bytes: size })));
        }
        return;
      }
      if (size > limitBytes) {
        tooLarge = true;
        chunks.length = 0; // 丢弃已收块，不再累积内存
        return;
      }
      chunks.push(c);
    };
    const onEnd = (): void => {
      if (tooLarge) settle(() => reject(new WorkError("INVALID_COMMAND", `请求体超过 ${limitBytes} 字节上限`, { limit_bytes: limitBytes, received_bytes: size })));
      else settle(() => resolve(Buffer.concat(chunks).toString("utf8")));
    };
    const onError = (e: Error): void => settle(() => reject(e));
    const onAborted = (): void =>
      settle(() => reject(new WorkError("SERVICE_UNAVAILABLE", "客户端在请求体传完前断开（aborted）：未落盘", { received_bytes: size })));
    const onClose = (): void => {
      // close 在正常 end 之后也会触发；只有还没结算（即没走到 end）才是中途断开
      if (!settled) settle(() => reject(new WorkError("SERVICE_UNAVAILABLE", "请求体未传完连接即关闭：未落盘", { received_bytes: size })));
    };
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
    req.on("aborted", onAborted);
    req.on("close", onClose);
  });
}

async function readJsonBody(req: IncomingMessage, limitBytes: number): Promise<Record<string, unknown>> {
  const text = await readBody(req, limitBytes);
  if (text.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new WorkError("INVALID_COMMAND", `请求体不是合法 JSON: ${(e as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new WorkError("INVALID_COMMAND", "请求体必须是 JSON 对象");
  }
  return parsed as Record<string, unknown>;
}

function requireProjectId(body: Record<string, unknown>): string {
  const id = typeof body.project_id === "string" ? body.project_id.trim() : "";
  if (id === "") throw new WorkError("INVALID_COMMAND", "缺 project_id", { field: "project_id" });
  return id;
}

export interface ProjectIndexHostCtx {
  /** 字段名与 `handleWorkRequest`/`handleBaselineRequest` 的 ctx 保持一致，便于 workHost 同处委派 */
  dataDir: string;
  token: string;
  pathname: string;
  /** V09-29 慢 body 竞态：body 到达后、实际落盘前再查一次写者身份（描述符 pid + 令牌）。由 workHost 注入 */
  assertWriteOwnership?: () => void;
}

/**
 * 处理一条 project-index 路由；**返回 false 表示不是本模块的路由**（workHost 继续走原 `handleWorkRequest`），
 * true 表示已经应答（成功或错误）。鉴权与 `handleWorkRequest` 同款：必须带描述符里的 token。
 */
export async function handleProjectIndexRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ProjectIndexHostCtx,
): Promise<boolean> {
  if (!ctx.pathname.startsWith(PROJECT_INDEX_ROUTE_PREFIX)) return false;
  const method = req.method ?? "GET";
  if (req.headers[WORK_TOKEN_HEADER] !== ctx.token) {
    sendJson(res, 401, {
      code: "SERVICE_UNAVAILABLE",
      message: `缺少或错误的 ${WORK_TOKEN_HEADER}：说明索引写面只答带描述符凭据的本机调用`,
      detail: {},
    });
    return true;
  }
  try {
    if (method === "POST" && ctx.pathname === `${PROJECT_INDEX_ROUTE_PREFIX}upsert`) {
      const body = await readJsonBody(req, MAX_BODY_BYTES);
      const projectId = requireProjectId(body);
      if (!Array.isArray(body.entries)) {
        throw new WorkError("INVALID_COMMAND", "upsert 缺 entries 数组（显式增量 upsert）", { field: "entries" });
      }
      // 慢 body 竞态：body 已到、实际落盘前再查一次写者身份
      ctx.assertWriteOwnership?.();
      const result = upsertProjectNotes(
        projectId,
        {
          expected_file_sha256: (body.expected_file_sha256 ?? null) as string | null,
          entries: body.entries as unknown[],
          ...(typeof body.declared_by === "string" ? { declared_by: body.declared_by } : {}),
        },
        ctx.dataDir,
      );
      sendJson(res, 200, { ...result });
      return true;
    }
    if (method === "POST" && ctx.pathname === `${PROJECT_INDEX_ROUTE_PREFIX}remove`) {
      const body = await readJsonBody(req, MAX_BODY_BYTES);
      const projectId = requireProjectId(body);
      if (!Array.isArray(body.ids)) {
        throw new WorkError("INVALID_COMMAND", "remove 缺 ids 数组（删除说明是显式动作）", { field: "ids" });
      }
      ctx.assertWriteOwnership?.();
      const result = removeProjectNotes(
        projectId,
        { expected_file_sha256: (body.expected_file_sha256 ?? null) as string | null, ids: body.ids as string[] },
        ctx.dataDir,
      );
      sendJson(res, 200, { ...result });
      return true;
    }
    sendJson(res, 405, {
      code: "INVALID_COMMAND",
      message: `project-index 面不支持 ${method} ${ctx.pathname}`,
      detail: {},
    });
    return true;
  } catch (e) {
    if (isWorkError(e)) {
      const status = e.code === "INVALID_COMMAND" && /字节上限/.test(e.message) ? 413 : WORK_HTTP_STATUS[e.code] ?? 500;
      sendJson(res, status, e.toJSON());
      return true;
    }
    sendJson(res, 500, {
      code: "PROJECTION_FAILED",
      message: `说明索引宿主内部错误: ${e instanceof Error ? e.message : String(e)}`,
      detail: {},
    });
    return true;
  }
}

// ── 客户端：经唯一宿主写 ──

export type ProjectIndexWriteOp = "upsert" | "remove";

function workCodeOf(value: unknown): WorkErrorCode | null {
  return typeof value === "string" && (WORK_ERROR_CODES as readonly string[]).includes(value) ? (value as WorkErrorCode) : null;
}

/**
 * 把一次说明索引写请求转给**唯一宿主**并取回执。
 * 只走新 work 路由 `/api/work/project-index/<op>`（daemon 全路径都进 workHost；桌面宿主需按报告接线）。
 * 宿主不可达 → `SERVICE_UNAVAILABLE`（**绝不**在本进程本地代写）。
 */
export async function callProjectIndexHost(
  work: WorkServiceClient,
  projectId: string,
  op: ProjectIndexWriteOp,
  payload: Record<string, unknown>,
  timeoutMs = 8000,
): Promise<Record<string, unknown>> {
  const desc = await work.ensureWorkService();
  if (desc === null) {
    throw new WorkError("SERVICE_UNAVAILABLE", "project_index 的写需要唯一写入服务：未启动且按需拉起未果（MCP 不本地代写）", { op });
  }
  const url = `http://${desc.host}:${desc.port}${PROJECT_INDEX_ROUTE_PREFIX}${op}`;
  const body = JSON.stringify({ project_id: projectId, ...payload });
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", [WORK_TOKEN_HEADER]: desc.token },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new WorkError("SERVICE_UNAVAILABLE", `project_index ${op} 入口不可达（${url}）：${e instanceof Error ? e.message : String(e)}`, { op });
  }
  const parsed = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    const err = (parsed?.error ?? null) as { code?: unknown; message?: unknown; detail?: unknown } | null;
    const code = workCodeOf(err?.code) ?? workCodeOf(parsed?.code) ?? "SERVICE_UNAVAILABLE";
    const message =
      (typeof err?.message === "string" ? err.message : undefined) ??
      (typeof parsed?.message === "string" ? parsed.message : undefined) ??
      `project_index ${op} 返回 HTTP ${res.status}`;
    const detail = (err?.detail ?? parsed?.detail ?? {}) as Record<string, unknown>;
    throw new WorkError(code, message, { ...detail, op, http_status: res.status });
  }
  if (parsed === null || parsed.ok !== true) {
    throw new WorkError("SERVICE_UNAVAILABLE", `project_index ${op} 返回体不合法（缺 ok:true）`, { op });
  }
  return parsed;
}
