// 正向基线的唯一宿主面与转接客户端（PLAN.md V09-28；DESIGN.md §2.9/§6.7；docs/forward-progress-contract.md F1）。
//
// 本模块回答两件事，都在**隔离副本**内施工，不另造事实源：
//   ① **服务侧** `handleBaselineRequest`：在唯一写入服务宿主（桌面后端 `index.ts` 或独立 daemon 同一
//      `createWorkHost`）里应答 `/api/work/baseline/{preserve,activate}`。它调用的就是 documents 里那套
//      preserve/activate——**同一份判据、同一份写者**（§2.9、§5.8），不复制第二份实现。
//   ② **客户端** `callBaselineHost`：MCP stdio 是另一个进程，写必须经 `ctx.work.ensureWorkService()`
//      拿到的描述符转给唯一宿主。桌面宿主只做**精确路径**转发 work 面（index.ts 逐条列名，不整段透传），
//      所以新加的 `/api/work/baseline/*` 在桌面宿主上会落 404；这时退回**直挂**的
//      `/api/projects/:id/documents/{preserve,activate}`（桌面 index.ts 里那条已经存在的路由）。
//      这与 `src/mcp/tools/syncHost.ts#readSyncStatusRemote` 完全同一先试后退口径——不复用就会在
//      桌面宿主与 daemon 之间二选一失效。
//
// ██ 红线 ██
//   · 读（`readBaselineView`）**零副作用**：不 ensure 宿主、不起模型、不写盘（纯 `loadDocuments` +
//     `readBaselineLog`）。
//   · 写只经唯一宿主；本模块**不自己写 baselines.jsonl / 不可变副本**，也不在 stdio 进程另建写者。
//   · MCP 面的激活**固定** `delegated_technical_review`，不接受 `user_confirmation`（§2.9：不代签用户
//     Gate）；两者的判据都在 documents 的 `assertApproval`，这里只加"CLI 面只走技术审定"这一层。
//   · 激活只影响配套基线，不写 `gate.jsonl`、不自动领取任务。
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  activateBaseline,
  loadDocuments,
  preserveDocumentRevision,
  readBaselineLog,
  type ActivateBaselineInput,
  type BaselineApprovalKind,
  type DocumentKind,
  type DocumentRevision,
  type DocumentRecovery,
  type DocumentSource,
  type ProjectBaseline,
} from "./documents";
import { isWorkError, WorkError, WORK_ERROR_CODES, type WorkErrorCode } from "./types";
import { WORK_TOKEN_HEADER, type WorkServiceClient } from "./service";
// 确定性派生（基线激活触发的规划关联重建）与桌面既有 `/documents/activate` 路由同一份：
// daemon 侧也必须触发，否则"经 daemon 激活的基线"只有基线、没有该有的图更新。
// 该模块本就在 daemon 的依赖图里（service → syncGraph → arch/sixGraphs → blueprintAuto），不新增打包负担。
import { triggerBlueprintAuto } from "../../arch/blueprintAuto";

/** work 面基线路由前缀（与 `service.ts` 的 `/api/work/` 同族；本模块只管自己这一段） */
export const BASELINE_ROUTE_PREFIX = "/api/work/baseline/";

/** 错误码 → HTTP 状态（与 `service.ts` 的 `HTTP_STATUS`、`index.ts` 的 `workErrorStatus` 同值） */
const WORK_HTTP_STATUS: Record<WorkErrorCode, number> = {
  INVALID_COMMAND: 400,
  VERSION_CONFLICT: 409,
  IDEMPOTENCY_CONFLICT: 409,
  SERVICE_UNAVAILABLE: 503,
  PROJECTION_FAILED: 500,
  TAIL_QUARANTINED: 500,
  MIDDLE_CORRUPT: 500,
  EVENT_INVALID: 500,
  EVIDENCE_INVALID: 400,
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(text);
}

function readBody(req: IncomingMessage, limitBytes = 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new WorkError("INVALID_COMMAND", `请求体超过 ${limitBytes} 字节上限`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const text = await readBody(req);
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

// ── 服务侧：唯一宿主路由 ──

export interface BaselineHostCtx {
  /** 字段名与 `handleWorkRequest` 的 ctx 保持一致，便于 workHost 同处委派 */
  dataDir: string;
  token: string;
  pathname: string;
  /**
   * V09-29 慢 body 竞态：body 到达后、**实际落盘前**再查一次写者身份（描述符 pid + 令牌）。
   * 由 workHost 注入；未注入（旧调用方）不查。
   */
  assertWriteOwnership?: () => void;
}

/**
 * 处理一条基线路由；**返回 false 表示不是本模块的路由**（workHost 继续走原 `handleWorkRequest`），
 * true 表示已经应答（成功或错误）。鉴权与 `handleWorkRequest` 同款：必须带描述符里的 token。
 */
export async function handleBaselineRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: BaselineHostCtx,
): Promise<boolean> {
  if (!ctx.pathname.startsWith(BASELINE_ROUTE_PREFIX)) return false;
  const method = req.method ?? "GET";
  if (req.headers[WORK_TOKEN_HEADER] !== ctx.token) {
    sendJson(res, 401, {
      code: "SERVICE_UNAVAILABLE",
      message: `缺少或错误的 ${WORK_TOKEN_HEADER}：基线写面只答带描述符凭据的本机调用`,
      detail: {},
    });
    return true;
  }
  try {
    if (method === "POST" && ctx.pathname === `${BASELINE_ROUTE_PREFIX}preserve`) {
      const body = await readJsonBody(req);
      const projectId = requireProjectId(body);
      const kind = body.kind;
      if (kind !== "design" && kind !== "plan") {
        throw new WorkError("INVALID_COMMAND", `kind 只接受 design/plan（收到 ${JSON.stringify(kind)}）`, { field: "kind" });
      }
      // V09-29 慢 body 竞态：body 已到、**实际保存不可变历史前**再查一次写者身份。请求进入时宿主有效，
      // 慢 body 期间描述符可能已易主；只查入口一次会 TOCTOU，由失败宿主写出第二份基线。
      ctx.assertWriteOwnership?.();
      const result = preserveDocumentRevision(projectId, kind, ctx.dataDir);
      sendJson(res, 200, { ok: true, result });
      return true;
    }
    if (method === "POST" && ctx.pathname === `${BASELINE_ROUTE_PREFIX}activate`) {
      const body = await readJsonBody(req);
      const projectId = requireProjectId(body);
      const kind = body.approval_kind;
      if (kind !== "delegated_technical_review") {
        throw new WorkError(
          "INVALID_COMMAND",
          `manage_baseline 的 MCP 激活只接受 approval_kind="delegated_technical_review"（收到 ${JSON.stringify(kind)}）。` +
            "用户确认不由 Agent 代签：需要 user_confirmed 时由人经界面/HTTP 直挂路由完成（DESIGN.md §2.9）",
          { field: "approval_kind" },
        );
      }
      // V09-29：服务端**强校验** expected——工具侧的校验不是唯一防线，直连 work 面的调用同样必须带
      // 两份源的当前 content_sha256（各自 64 位十六进制）。`activateBaseline` 里 expected 缺省即跳过比对
      // （直挂 `/documents/activate` 的历史语义），本路由不能沿用那个宽松默认，否则绕过工具即可"盲激活"。
      const expected = body.expected;
      if (typeof expected !== "object" || expected === null || Array.isArray(expected)) {
        throw new WorkError(
          "INVALID_COMMAND",
          "baseline 激活必须带 expected（两份源的当前内容哈希）：先读现行原文取回 current_pair 再回填（DESIGN.md §2.9）",
          { field: "expected" },
        );
      }
      const e = expected as Record<string, unknown>;
      const designSha = typeof e.design_content_sha256 === "string" ? e.design_content_sha256.trim() : "";
      const planSha = typeof e.plan_content_sha256 === "string" ? e.plan_content_sha256.trim() : "";
      const SHA256_HEX = /^[0-9a-f]{64}$/i;
      if (!SHA256_HEX.test(designSha) || !SHA256_HEX.test(planSha)) {
        throw new WorkError(
          "INVALID_COMMAND",
          "expected 必须同时给两份源的 design_content_sha256 与 plan_content_sha256（各 64 位十六进制）：" +
            "半套图纸或非法哈希不能激活（DESIGN.md §2.9）",
          { field: "expected", got: { design_ok: SHA256_HEX.test(designSha), plan_ok: SHA256_HEX.test(planSha) } },
        );
      }
      // V09-29 慢 body 竞态：body 已到、**实际写 baselines.jsonl 前**再查一次写者身份（同上）。
      ctx.assertWriteOwnership?.();
      const result = activateBaseline(
        projectId,
        {
          approved_by: body.approved_by as string,
          approval_basis: body.approval_basis as string,
          approval_kind: kind as BaselineApprovalKind,
          expected: expected as ActivateBaselineInput["expected"],
        },
        ctx.dataDir,
      );
      // 重复技术审定行为：同两份源内容哈希（内容寻址）→ `activateBaseline` 判定为同一基线，返回
      // `created=false` 且**不新增** baselines.jsonl 一行；绝不复用同哈希却改写审定者/依据——那会污染
      // 不可变历史。调用方据 `created` 区分首激活与幂等重放（DESIGN.md §2.9）。
      // 与桌面既有 `/documents/activate` 同款：异步触发确定性派生（不 await；失败只留回执与状态、保留旧图）
      triggerBlueprintAuto(projectId, { trigger: "baseline_activated" });
      sendJson(res, 200, { ok: true, ...result });
      return true;
    }
    sendJson(res, 405, {
      code: "INVALID_COMMAND",
      message: `baseline 面不支持 ${method} ${ctx.pathname}`,
      detail: {},
    });
    return true;
  } catch (e) {
    if (isWorkError(e)) {
      sendJson(res, WORK_HTTP_STATUS[e.code] ?? 500, e.toJSON());
      return true;
    }
    sendJson(res, 500, {
      code: "PROJECTION_FAILED",
      message: `基线宿主内部错误: ${e instanceof Error ? e.message : String(e)}`,
      detail: {},
    });
    return true;
  }
}

// ── 只读视图（零副作用；MCP read 与界面共用同一形状） ──

export interface BaselineSourceView {
  kind: DocumentKind;
  exists: boolean;
  source_path: string | null;
  origin: string | null;
  content_sha256: string | null;
  definition_sha256: string | null;
  bytes: number | null;
  lines: number | null;
  /** 当前原文是否已保住（Git 可取回 blob 或不可变副本） */
  preserved: boolean;
  recovery_ref: string | null;
}

export interface BaselineView {
  project_id: string;
  design: BaselineSourceView;
  plan: BaselineSourceView;
  baseline: {
    active: ProjectBaseline | null;
    count: number;
    corrupt: { line: number; reason: string }[];
  };
  /** 当前两份源的**内容哈希**（激活的 expected 就填这两个；界面与 Agent 不必自己算） */
  current_pair: { design_content_sha256: string | null; plan_content_sha256: string | null };
  /** 生效基线是否正好指向当前两份源（false = 有未激活的源改动） */
  active_matches_current: boolean;
}

function sourceView(kind: DocumentKind, loaded: { source: DocumentSource; revision: DocumentRevision } | null): BaselineSourceView {
  if (loaded === null) {
    return {
      kind,
      exists: false,
      source_path: null,
      origin: null,
      content_sha256: null,
      definition_sha256: null,
      bytes: null,
      lines: null,
      preserved: false,
      recovery_ref: null,
    };
  }
  const recovery: DocumentRecovery | null = loaded.revision.recovery;
  return {
    kind,
    exists: true,
    source_path: loaded.source.rel_path,
    origin: loaded.source.origin,
    content_sha256: loaded.revision.content_sha256,
    definition_sha256: loaded.revision.definition_sha256,
    bytes: loaded.revision.bytes,
    lines: loaded.revision.lines,
    preserved: recovery !== null,
    recovery_ref: recovery?.ref ?? null,
  };
}

/** 只读：两份源当前修订 + 生效基线。**不写盘、不 ensure 宿主、不调模型**。 */
export function readBaselineView(projectId: string, dataDir?: string): BaselineView {
  const docs = loadDocuments(projectId, dataDir);
  const log = readBaselineLog(projectId, dataDir);
  const active = log.baselines.length === 0 ? null : log.baselines[log.baselines.length - 1];
  const design = sourceView("design", docs.design);
  const plan = sourceView("plan", docs.plan);
  const matches =
    active !== null &&
    design.content_sha256 !== null &&
    plan.content_sha256 !== null &&
    active.design_revision.content_sha256 === design.content_sha256 &&
    active.plan_revision.content_sha256 === plan.content_sha256;
  return {
    project_id: projectId,
    design,
    plan,
    baseline: { active, count: log.baselines.length, corrupt: log.corrupt },
    current_pair: { design_content_sha256: design.content_sha256, plan_content_sha256: plan.content_sha256 },
    active_matches_current: matches,
  };
}

// ── 客户端：经唯一宿主写 ──

export type BaselineWriteOp = "preserve" | "activate";

function workCodeOf(value: unknown): WorkErrorCode | null {
  return typeof value === "string" && (WORK_ERROR_CODES as readonly string[]).includes(value)
    ? (value as WorkErrorCode)
    : null;
}

/**
 * 把一次基线写请求转给**唯一宿主**并取回执。
 *
 * 先试新 work 路由 `/api/work/baseline/<op>`（daemon 全路径都进 workHost，直接命中）；
 * 桌面宿主的 work 面只做精确路径转发、会回 404——这时退回**直挂**的
 * `/api/projects/:id/documents/<op>`（与 `syncHost` 同一先试后退口径）。
 * 两条都不可达 → `SERVICE_UNAVAILABLE`（**绝不**在本进程本地代写）。
 */
export async function callBaselineHost(
  work: WorkServiceClient,
  projectId: string,
  op: BaselineWriteOp,
  payload: Record<string, unknown>,
  timeoutMs = 8000,
): Promise<Record<string, unknown>> {
  const desc = await work.ensureWorkService();
  if (desc === null) {
    throw new WorkError(
      "SERVICE_UNAVAILABLE",
      "manage_baseline 的写需要唯一写入服务：未启动且按需拉起未果（MCP 不本地代写）",
      { op },
    );
  }
  const base = `http://${desc.host}:${desc.port}`;
  const body = JSON.stringify({ project_id: projectId, ...payload });
  const post = async (url: string, withToken: boolean): Promise<Response | null> => {
    try {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (withToken) headers[WORK_TOKEN_HEADER] = desc.token;
      return await fetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      return null;
    }
  };

  let res = await post(`${base}${BASELINE_ROUTE_PREFIX}${op}`, true);
  if (res !== null && res.status === 404) {
    // 桌面宿主未转发这条 work 面（逐条列名，不整段透传）→ 退回直挂的项目路由
    res = await post(`${base}/api/projects/${encodeURIComponent(projectId)}/documents/${op}`, false);
  }
  if (res === null) {
    throw new WorkError("SERVICE_UNAVAILABLE", `基线${op}入口不可达（${base}）`, { host: desc.host, port: desc.port, op });
  }
  const parsed = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    const err = (parsed?.error ?? null) as { code?: unknown; message?: unknown; detail?: unknown } | null;
    const code = workCodeOf(err?.code) ?? workCodeOf(parsed?.code) ?? "SERVICE_UNAVAILABLE";
    const message =
      (typeof err?.message === "string" ? err.message : undefined) ??
      (typeof parsed?.message === "string" ? parsed.message : undefined) ??
      `基线${op}返回 HTTP ${res.status}`;
    const detail = (err?.detail ?? parsed?.detail ?? {}) as Record<string, unknown>;
    throw new WorkError(code, message, { ...detail, op, http_status: res.status });
  }
  if (parsed === null || parsed.ok !== true) {
    throw new WorkError("SERVICE_UNAVAILABLE", `基线${op}返回体不合法（缺 ok:true）`, { op });
  }
  return parsed;
}
