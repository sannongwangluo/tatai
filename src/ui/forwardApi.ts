// 正向成套图纸入口的前端 API（PLAN.md V09-28；DESIGN.md §2.9/§6.7；docs/forward-progress-contract.md F1；
// V09-36 起本文件的只读读口并入在途请求共享）。
//
// 为什么单开一个文件（而不是塞进 `api.ts`）：本卡的文件责任把基线入口的前端调用收在
// `src/ui/forwardApi.ts`。两者共用同一套口径——相对路径 + 壳内基址前缀（`apiBase()`），并复用
// `api.ts#rawFetch` 作为**唯一裸 fetch 出口**、经 `sharedReadFetch` 做在途合并（V09-36）：
// 相同 URL/参数的 GET 并发只打一次网络，每个调用者各拿独立可消费的 Response。
//
// 端点都是**已存在**的桌面/项目路由（`src/server/index.ts` 的 `/documents`、`/documents/preserve`、
// `/documents/activate`），本卡不为界面新开写口——界面走的就是 MCP/HTTP 同一份 documents 判据。
// 类型照 `api.ts` 的既有口径 **type-only** 复用服务端模块（值 import 会把 node 依赖链拖进浏览器包）。
import { apiBase } from "./tauri-env";
import { rawFetch } from "./api";
import { sharedReadFetch } from "./sharedRead";
import type { ProjectBaseline, BaselineAdvance } from "../server/work/documents";

/** 与 `api.ts#apiFetch` 同款：壳内加基址前缀，非壳内是相对路径；GET 读口共享在途请求（V09-36）。 */
function forwardFetch(input: string, init?: RequestInit): Promise<Response> {
  return sharedReadFetch(`${apiBase()}${input}`, init, rawFetch);
}

/** `GET /api/projects/:id/documents` 里每份图纸的摘要（缺图纸时只有 exists/kind） */
export interface DocumentSummary {
  exists: boolean;
  kind: string;
  source_path?: string;
  origin?: string;
  content_sha256?: string;
  definition_sha256?: string;
  bytes?: number;
  lines?: number;
  recovery?: { kind: string; ref: string; key: string; sha256: string } | null;
}

export interface DocumentsSummary {
  design: DocumentSummary;
  plan: DocumentSummary;
  baseline: {
    active: ProjectBaseline | null;
    count: number;
    corrupt: { line: number; reason: string }[];
    path?: string;
  };
}

/** V09-26：刷新机制透传的中止信号（换项目/卸载时中止在途网络，严格有界）；不传行为不变。 */
export interface ForwardFetchOpts {
  signal?: AbortSignal;
}

/** `GET /api/projects/:id/documents`——只取成套图纸摘要（两源当前版本 + 生效基线）。 */
export async function getDocumentsSummary(id: string, opts?: ForwardFetchOpts): Promise<DocumentsSummary> {
  const res = await forwardFetch(
    `/api/projects/${encodeURIComponent(id)}/documents`,
    opts?.signal !== undefined ? { signal: opts.signal } : undefined,
  );
  const body = (await res.json()) as { ok: true; documents: DocumentsSummary } | { ok: false; error: { code: string; message: string } };
  if (!body.ok) throw new Error(`[${body.error.code}] ${body.error.message}`);
  return body.documents;
}

/** `POST /api/projects/:id/documents/preserve`——把当前一份图纸存成不可变历史（幂等）。 */
export async function postPreserveDocument(
  id: string,
  kind: "design" | "plan",
): Promise<{ revision: { content_sha256: string; definition_sha256: string }; recovery: { kind: string; ref: string } }> {
  const res = await forwardFetch(`/api/projects/${encodeURIComponent(id)}/documents/preserve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind }),
  });
  const body = (await res.json()) as
    | { ok: true; result: { revision: { content_sha256: string; definition_sha256: string }; recovery: { kind: string; ref: string } } }
    | { ok: false; error: { code: string; message: string } };
  if (!body.ok) throw new Error(`[${body.error.code}] ${body.error.message}`);
  return body.result;
}

export interface ActivateBaselineInput {
  approved_by: string;
  approval_basis: string;
  approval_kind: "user_confirmed" | "delegated_technical_review";
  /** 审定者手上那份草稿的版本标识（源在审定中改变 → 服务端 VERSION_CONFLICT） */
  expected?: {
    design_source_path?: string;
    design_content_sha256?: string;
    design_definition_sha256?: string;
    plan_source_path?: string;
    plan_content_sha256?: string;
    plan_definition_sha256?: string;
  };
}

export interface ActivateBaselineResult {
  baseline: ProjectBaseline;
  created: boolean;
  advance: { design: BaselineAdvance; plan: BaselineAdvance } | null;
}

/** `POST /api/projects/:id/documents/activate`——审定配套版本 → 双版本激活（只追加 baselines.jsonl）。 */
export async function postActivateBaseline(id: string, input: ActivateBaselineInput): Promise<ActivateBaselineResult> {
  const res = await forwardFetch(`/api/projects/${encodeURIComponent(id)}/documents/activate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = (await res.json()) as ({ ok: true } & ActivateBaselineResult) | { ok: false; error: { code: string; message: string } };
  if (!body.ok) throw new Error(`[${body.error.code}] ${body.error.message}`);
  return { baseline: body.baseline, created: body.created, advance: body.advance };
}
