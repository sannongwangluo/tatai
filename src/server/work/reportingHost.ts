// 上报域的服务宿主操作（PLAN V09-27；DESIGN.md §2.6 / §5.4 / §6.7；docs/forward-progress-contract.md F3）。
//
// 为什么需要单独一个宿主模块：**不可变证据正文**只能由**唯一写入服务宿主**落盘——
// MCP stdio 是另一个进程，`ctx.work` 只允许转接命令与宿主操作，**不**直接写 events.jsonl，
// 也**不**直接把证据正文落到项目目录里（否则就等于第二个写者，§2.6）。所以 store/read 这两个
// 「证据正文」操作走宿主：路由前缀 `/api/work/reporting/`，由 `service.handleWorkRequest` 在同一
// token 校验之后委派到本模块（与描述符/唯一写者同源，读口写口是同一份 putEvidence/readEvidence 判据）。
//
// 判据不在这里重造：正文形状、内容寻址、不可变写入、读时复核哈希全部复用 `evidence.ts` 的
// `putEvidence` / `readEvidence`（单一来源），本模块只做「HTTP 路由 + 项目路径解析 + 错误回话」。
import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { projectWorkDir } from "../workstation";
import { EVIDENCE_KINDS, evidenceBlobPath, putEvidence, readEvidence, type EvidenceBinding, type EvidenceBlob, type EvidenceInput, type EvidenceKind } from "./evidence";
import { isSha256Hex } from "./sourceEvidence";
import { WorkError, isWorkError, type WorkErrorCode } from "./types";

/** 上报域路由前缀（handleWorkRequest 据此委派；与 /api/work/ 同源同 token） */
export const REPORTING_ROUTE_PREFIX = "/api/work/reporting/";

export function isReportingRoute(pathname: string): boolean {
  return pathname.startsWith(REPORTING_ROUTE_PREFIX);
}

/** 错误码 → HTTP 状态（与 service.ts 的 HTTP_STATUS 同口径；证据不合法是调用方改命令就能修的 400） */
const REPORTING_HTTP_STATUS: Partial<Record<WorkErrorCode, number>> = {
  INVALID_COMMAND: 400,
  EVIDENCE_INVALID: 400,
  SERVICE_UNAVAILABLE: 503,
  PROJECTION_FAILED: 500,
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

function readBody(req: IncomingMessage, limitBytes = 16 * 1024 * 1024): Promise<string> {
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

/** 项目 v2 目录只走注册表（未知项目按 INVALID_COMMAND 拒，不猜路径） */
function workDirOf(projectId: string, dataDir: string): string {
  try {
    return projectWorkDir(projectId, dataDir);
  } catch (e) {
    throw new WorkError("INVALID_COMMAND", `无法解析项目目录（project_id=${projectId}）：${(e as Error).message}`, {
      project_id: projectId,
    });
  }
}

/**
 * 证据正文的存/读请求体（**严格**：缺字段/类型不对一律拒，不静默补默认值——
 * `created_by`/`role`/`summary` 是留痕字段，缺了就等于"不知道谁在什么身份下落了它"）。
 */
function evidenceInputOf(raw: unknown): { project_id: string; input: EvidenceInput } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new WorkError("INVALID_COMMAND", "报告证据正文的请求体必须是 JSON 对象");
  }
  const p = raw as Record<string, unknown>;
  const projectId = typeof p.project_id === "string" ? p.project_id.trim() : "";
  if (projectId === "") throw new WorkError("INVALID_COMMAND", "证据正文缺 project_id", { field: "project_id" });
  if (p.content !== undefined && typeof p.content !== "string") throw new WorkError("EVIDENCE_INVALID", "证据正文 content 必须是字符串", { field: "content" });
  if (typeof p.kind !== "string" || !EVIDENCE_KINDS.includes(p.kind as EvidenceKind)) {
    throw new WorkError("EVIDENCE_INVALID", `证据 kind 只接受 ${EVIDENCE_KINDS.join("/")}（收到 ${JSON.stringify(p.kind)}）`, { field: "kind" });
  }
  if (typeof p.summary !== "string" || p.summary.trim() === "") {
    throw new WorkError("EVIDENCE_INVALID", "证据必须有一句话 summary（空摘要不算说明）", { field: "summary" });
  }
  if (typeof p.created_by !== "string" || p.created_by.trim() === "") {
    throw new WorkError("EVIDENCE_INVALID", "证据必须写 created_by（谁落的正文）", { field: "created_by" });
  }
  if (typeof p.role !== "string" || p.role.trim() === "") {
    throw new WorkError("EVIDENCE_INVALID", "证据必须写 role（以什么身份落的正文）", { field: "role" });
  }
  const binding = p.binding;
  if (typeof binding !== "object" || binding === null || Array.isArray(binding)) {
    throw new WorkError("EVIDENCE_INVALID", "证据必须绑定源修订 binding{revision_kind, revision}", { field: "binding" });
  }
  return {
    project_id: projectId,
    input: {
      content: typeof p.content === "string" ? p.content : "",
      kind: p.kind as EvidenceKind,
      summary: p.summary,
      created_by: p.created_by,
      role: p.role,
      binding: binding as EvidenceBinding,
      source_ref: typeof p.source_ref === "string" ? p.source_ref : null,
      ...(typeof p.occurred_at === "string" ? { occurred_at: p.occurred_at } : {}),
      // 源文件清单（契约 F4）：原样交给 putEvidence 现读核实（越界/软链/超限/编造哈希都在那里拒）
      ...(p.source_manifest === undefined ? {} : { source_manifest: p.source_manifest }),
    },
  };
}

/**
 * 处理一条上报域路由。返回 true 表示已应答（成功或错误），false 表示不是本模块路由。
 * **鉴权由调用方（handleWorkRequest）在委派前完成**——本模块只认已通过 token 校验的请求。
 */
export async function handleReportingRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: { pathname: string; dataDir: string; assertWriteOwnership?: () => void },
): Promise<boolean> {
  if (!isReportingRoute(ctx.pathname)) return false;
  const method = req.method ?? "GET";
  try {
    if (method === "POST" && ctx.pathname === `${REPORTING_ROUTE_PREFIX}evidence`) {
      const text = await readBody(req);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (e) {
        throw new WorkError("INVALID_COMMAND", `请求体不是合法 JSON: ${(e as Error).message}`);
      }
      const { project_id, input } = evidenceInputOf(parsed);
      const workDir = workDirOf(project_id, ctx.dataDir);
      // V09-29 慢 body 竞态：body 已到、正文**真正落盘前**再查一次写者身份。请求进入时宿主有效，
      // 但慢 body 期间描述符可能已易主；只查入口一次会 TOCTOU，写出第二份证据。非当前写者 → 抛
      // SERVICE_UNAVAILABLE（503），putEvidence 一个字节都不写。
      ctx.assertWriteOwnership?.();
      const blob: EvidenceBlob = putEvidence(workDir, input);
      sendJson(res, 200, { ok: true, evidence: blob });
      return true;
    }
    if (method === "GET" && ctx.pathname === `${REPORTING_ROUTE_PREFIX}evidence`) {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const projectId = (url.searchParams.get("project_id") ?? "").trim();
      const sha256 = (url.searchParams.get("sha256") ?? "").trim();
      if (projectId === "" || sha256 === "") {
        throw new WorkError("INVALID_COMMAND", "读取证据正文要求 project_id 与 sha256", { project_id: projectId, sha256 });
      }
      // 内容地址必须是严格 64 位小写十六进制：`evidenceBlobPath` 用它拼文件名，
      // 放行 `../` 之类的串就是路径穿越。这里在动磁盘**之前**拒（非法命令不留痕）。
      if (!isSha256Hex(sha256)) {
        throw new WorkError("INVALID_COMMAND", "读取证据正文要求 sha256 是 64 位小写十六进制（拒绝路径穿越/非法内容地址）", { sha256 });
      }
      const workDir = workDirOf(projectId, ctx.dataDir);
      const blob: EvidenceBlob = readEvidence(workDir, sha256);
      // 读口要能把**正文**交回调用方（reporting 的用途就是读回证据材料）：readEvidence 已按内容地址
      // 复核过哈希。这里再把同一份正文带上——**读不到正文就报错**，绝不返回"成功但空正文"的假证据。
      let content: string;
      try {
        const raw = JSON.parse(fs.readFileSync(evidenceBlobPath(workDir, sha256), "utf8")) as { content?: unknown };
        if (typeof raw.content !== "string") {
          throw new WorkError("EVIDENCE_INVALID", `证据文件缺正文字段：${sha256}`, { evidence_id: sha256 });
        }
        content = raw.content;
      } catch (e) {
        if (isWorkError(e)) throw e;
        throw new WorkError(
          "EVIDENCE_INVALID",
          `证据正文读不出来：${sha256}（${e instanceof Error ? e.message : String(e)}）——不返回空正文冒充成功`,
          { evidence_id: sha256 },
        );
      }
      sendJson(res, 200, { ok: true, evidence: { ...blob, content } });
      return true;
    }
    sendJson(res, 405, {
      code: "INVALID_COMMAND",
      message: `上报域不支持 ${method} ${ctx.pathname}（只有 POST ${REPORTING_ROUTE_PREFIX}evidence 与 GET ${REPORTING_ROUTE_PREFIX}evidence?project_id=&sha256=）`,
      detail: {},
    });
    return true;
  } catch (e) {
    if (isWorkError(e)) {
      sendJson(res, REPORTING_HTTP_STATUS[e.code] ?? 500, e.toJSON());
      return true;
    }
    sendJson(res, 500, {
      code: "PROJECTION_FAILED",
      message: `上报域宿主内部错误: ${e instanceof Error ? e.message : String(e)}`,
      detail: {},
    });
    return true;
  }
}
