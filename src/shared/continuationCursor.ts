// 续读游标（**纯编解码，零 IO**）：完整来源版本 + 项目/文档绑定
// —— 2026-10-03 统一优化 U3（DESIGN.md §6.8；docs/unified-optimization-contract.md U3；PLAN V09-33）。
//
// 为什么另立一份、而不改既有 `chatTools.ts` 的游标：
//   既有 `tctx1:<内容哈希前 16 位>:lines:<N>`（chatTools.ts:82/95/99）有两个不足——
//   ① 只带 16 位前缀：**前缀相同不代表完整内容相同**（同前缀不同完整哈希会被误当同一版）；
//   ② 不绑定项目与文档：同一串游标拿到别的项目/别的图纸上也可能"对上"。
//   契约 U3 要求续读入口验证**完整来源哈希**、并拒绝跨项目/跨文档；旧短哈希游标只能定位，
//   不能当完整版本证明，故新增本格式并要求旧游标**明确失效、重新取**（旧函数与旧消费者行为不动）。
//
// 形态（单行、可读、无分隔符歧义——项目 id 不进 token，用绑定哈希代替，避免 `:` 冲突）：
//   tcur1:<doc>:<bind16>:<fullsha64>:<unit>:<start>
//     · doc       = `design` | `plan`
//     · bind16    = sha256(`${project_id}\u0000${doc}\u0000${fullsha}`) 的前 16 位十六进制（项目/文档绑定）
//     · fullsha64 = 源内容逐字节 sha256（完整 64 位十六进制）
//     · unit      = `lines`（`bytes` 预留；当前消费端只支持 lines，遇到 bytes 明确拒绝而非近似）
//     · start     = 下一次续读的起始行（1 起）
//
// 进程内包不是事实源：本游标只由「调用当刻现读的原文内容哈希」派生，**不引用**服务端内存里的
// 上下文包注册表（context.ts 的 PACKAGES）——因此重启后旧游标只会**明确报源变/失效**，
// 绝不会被当成有效的空包成功返回（V09-33「不空包成功」）。
//
// 纯模块：不读盘、不写盘、不 import 任何服务端模块（谁都能安全 import）。
import crypto from "node:crypto";

export type CursorDoc = "design" | "plan";
export type CursorUnit = "lines" | "bytes";

/** 新格式前缀 */
export const PROJECT_CURSOR_PREFIX = "tcur1";
/** 旧（聊天链）短前缀游标前缀：只定位、不能当完整版本证明 */
export const LEGACY_CURSOR_PREFIX = "tctx1";

/**
 * 单页续读的字符预算（**纯共享常量**，零 IO）。
 *
 * 为什么放这里：上下文包（`server/work/context.ts` 的 `CONTEXT_PAGE_MAX_CHARS`）与 MCP 续读实现
 * （`server/work/continuation.ts` 的 `CONTINUATION_PAGE_MAX_CHARS`）要用**同一口径**；而 context 现在
 * 又要用共享游标造 `tcur1` 页游标——若 continuation 继续从 context import 常量、context 又 import 共享游标，
 * 就会形成 context ⇄ continuation 的环。把它提到**谁都不依赖的纯 shared**，两侧各自 import 同一个值，
 * 环从结构上不存在（复审材料项：continuation 从 context import 常量宜提纯 shared）。
 */
export const CONTINUATION_PAGE_MAX_CHARS = 20_000;

const DOCS: readonly CursorDoc[] = ["design", "plan"];
const UNITS: readonly CursorUnit[] = ["lines", "bytes"];
const BIND_RE = /^[0-9a-f]{16}$/;
const SHA_RE = /^[0-9a-f]{64}$/;

/** 项目/文档绑定：sha256(`<project_id>\0<doc>\0<fullsha>`)[:16]（十六进制） */
export function cursorBinding(projectId: string, doc: CursorDoc, fullSha: string): string {
  return crypto.createHash("sha256").update(`${projectId}\u0000${doc}\u0000${fullSha}`, "utf8").digest("hex").slice(0, 16);
}

/** 造一个完整版本续读游标。`fullSha` 必须是源内容逐字节 sha256（64 位）；`start` 1 起。 */
export function makeProjectCursor(
  projectId: string,
  doc: CursorDoc,
  fullSha: string,
  unit: CursorUnit,
  start: number,
): string {
  return `${PROJECT_CURSOR_PREFIX}:${doc}:${cursorBinding(projectId, doc, fullSha)}:${fullSha}:${unit}:${start}`;
}

export interface ProjectCursor {
  doc: CursorDoc;
  /** 项目/文档绑定（16 位十六进制） */
  bind: string;
  /** 完整源内容哈希（64 位十六进制） */
  fullSha: string;
  unit: CursorUnit;
  /** 下一次续读的起始行（1 起） */
  start: number;
  raw: string;
}

/** 解析新格式游标；形态不合法返回 null（旧 `tctx1` 也返回 null——由 `isLegacyCursor` 单列解释） */
export function parseProjectCursor(raw: string): ProjectCursor | null {
  if (typeof raw !== "string") return null;
  const parts = raw.trim().split(":");
  if (parts.length !== 6) return null;
  const [prefix, doc, bind, fullSha, unit, startRaw] = parts;
  if (prefix !== PROJECT_CURSOR_PREFIX) return null;
  if (!DOCS.includes(doc as CursorDoc)) return null;
  if (!BIND_RE.test(bind) || !SHA_RE.test(fullSha)) return null;
  if (!UNITS.includes(unit as CursorUnit)) return null;
  if (!/^\d+$/.test(startRaw)) return null;
  const start = Number(startRaw);
  if (!Number.isSafeInteger(start) || start < 1) return null;
  return { doc: doc as CursorDoc, bind, fullSha, unit: unit as CursorUnit, start, raw: raw.trim() };
}

/** 是不是旧短前缀（tctx1）游标：只定位、不能当完整版本证明，调用方应明确失效并重取 */
export function isLegacyCursor(raw: unknown): boolean {
  return typeof raw === "string" && new RegExp(`^${LEGACY_CURSOR_PREFIX}:`).test(raw.trim());
}

export type CursorCheckCode = "CROSS_DOC" | "SOURCE_CHANGED" | "CROSS_PROJECT";

export type CursorCheck =
  | { ok: true; cursor: ProjectCursor }
  | { ok: false; code: CursorCheckCode; message: string; detail: Record<string, unknown> };

/**
 * 校验新格式游标是否绑在当前 `(projectId, doc, fullSha)` 上。
 * 判定顺序（每步都给出可解释的失败，不做近似）：
 *   ① 文档不同 → CROSS_DOC；② 完整内容哈希不同 → SOURCE_CHANGED；③ 绑定不符 → CROSS_PROJECT。
 */
export function verifyProjectCursor(
  cursor: ProjectCursor,
  expect: { projectId: string; doc: CursorDoc; fullSha: string },
): CursorCheck {
  if (cursor.doc !== expect.doc) {
    return {
      ok: false,
      code: "CROSS_DOC",
      message: `游标绑的是 ${cursor.doc}，当前读的是 ${expect.doc}：跨文档不接续，请按当前文档重新定位`,
      detail: { cursor_doc: cursor.doc, expected_doc: expect.doc },
    };
  }
  if (cursor.fullSha !== expect.fullSha) {
    return {
      ok: false,
      code: "SOURCE_CHANGED",
      message:
        `游标已失效：它绑定完整内容哈希 ${cursor.fullSha.slice(0, 16)}…，当前源是 ${expect.fullSha.slice(0, 16)}…。` +
        "源变过 ⇒ 旧游标指向的位置不再对应旧内容（即便 16 位前缀相同也不能当同一版）。" +
        "请按**当前**原文重建：task_id/range/section/index，或重新取 project_entry 的上下文",
      detail: {
        cursor_version: cursor.fullSha,
        current_version: expect.fullSha,
        same_prefix: cursor.fullSha.slice(0, 16) === expect.fullSha.slice(0, 16),
      },
    };
  }
  const expected = cursorBinding(expect.projectId, expect.doc, expect.fullSha);
  if (cursor.bind !== expected) {
    return {
      ok: false,
      code: "CROSS_PROJECT",
      message: `游标绑的是另一个项目（绑定 ${cursor.bind}，当前项目应为 ${expected}）：跨项目不接续`,
      detail: { cursor_bind: cursor.bind, expected_bind: expected, project_id: expect.projectId },
    };
  }
  return { ok: true, cursor };
}
