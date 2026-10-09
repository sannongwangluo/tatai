// 分层上下文与可信覆盖（PLAN.md V06-04，DESIGN.md §2.7–§2.8 / §3.6 / §6.7）。
//
// 本模块回答四件事（都是 §2.8 的硬口径，不是"顺手多做"）：
//   ① **分层取回**：项目简报 → 相关任务/章节 → 按需原文。任务定义取 V06-03 的 `plan.ts`，
//      图纸修订与生效基线取 V06-02 的 `documents.ts`；施工图与生效决定/基线一起进包。
//   ② **可信覆盖账本**：每个来源记路径、内容哈希、**实际取回的行/字节范围**、
//      成功/失败/截断/二进制排除状态。账本只认工具的**真实回执**（`chatTools.ReadReceipt`）——
//      "请求过 ≠ 读到"、"读了一段 ≠ 读完全文件"、"清单 ≠ 理解"三条都在这里落地。
//   ③ **分页与续读游标**：返回 `next_cursor` / `total`；游标**绑定源内容哈希**，源变了再用旧游标
//      取回明确报 `SOURCE_CHANGED`，绝不静默给旧内容。
//   ④ **陈旧与增量失效 / 检查点续接**：源变化把相关包标 `stale_reasons`，能按影响范围增量重建
//      （只重读变了的来源，未变的重用）；决策/接口变化时依赖任务得到**明确失效项**。
//      模型被轮次上限、超时或错误打断时，把"已确认来源 + 续接位置"落成检查点，
//      下一轮由**服务器**注入续接指令（不依赖模型自觉）。检查点落在项目私有目录
//      `<项目根>/.工作台/work/context-resume.json`。
//
// 与既有实现的关系：`chatContext.buildChatContext` 的背景、`chatTurn` 的覆盖对账、
// `ask_flash` 的 full_coverage 回执全部改用本模块的同一份账本（口径只有一份）。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getProject } from "../registry";
import { sanitizeErrorMessage } from "../redact";
import { nowIso } from "../time";
import { projectWorkDir } from "../workstation";
import {
  makeCursor,
  parseCursor,
  cursorMatchesVersion,
  type CoverageRange,
  type CoverageUnit,
  type ReadReceipt,
} from "../chatTools";
import {
  cursorBinding,
  makeProjectCursor,
  parseProjectCursor,
  CONTINUATION_PAGE_MAX_CHARS,
  type CursorDoc,
} from "../../shared/continuationCursor";
import {
  activeBaseline,
  BASELINES_FILE,
  loadDocument,
  resolveDocumentSource,
  WORKBENCH_DIRNAME,
  type DocumentKind,
  type DocumentSection,
  type ProjectBaseline,
} from "./documents";
import { EVENTS_FILE } from "./eventStore";
import { readLedger } from "./ledgerRead";
import { importTaskDefinitions, taskDefinitionHash, type TaskDefinition } from "./plan";
import { PROJECT_NOTES_REL, projectNotesFileInfo } from "./projectIndex";
import { readTaskStates, type TaskState } from "./tasks";
import type { LedgerContentFingerprint, WorkEvent } from "./types";

/** 上下文包格式版本（与 v2 事件格式分开：包是派生物，不进事实源） */
export const CONTEXT_PACKAGE_SCHEMA = 1 as const;

/** 一个包内联文本的默认字符预算（简报 + 任务/章节 + 当前页；超了如实记进 omitted） */
export const CONTEXT_MAX_CHARS = 24_000;
/**
 * 单页按需原文的默认字符预算（与既有"约 2 万字符设计背景"同量级，但这次是**带账本**的）。
 * 值取自**纯 shared** 常量（`shared/continuationCursor.ts`）：MCP 续读实现用同一口径，
 * 且 context 与本模块不再与 continuation 互相 import 成环（复审材料项）。
 */
export const CONTEXT_PAGE_MAX_CHARS = CONTINUATION_PAGE_MAX_CHARS;
/** 包内列出的任务条数上限 */
export const CONTEXT_TASKS_MAX = 20;
/** 包内列出的相关章节条数上限 */
export const CONTEXT_SECTIONS_MAX = 30;
/** 检查点文件（项目私有目录内；不存在 = 没有未接续的中断） */
export const RESUME_FILE = "context-resume.json";

export type ContextErrorCode =
  | "PROJECT_NOT_FOUND"
  | "UNKNOWN_PACKAGE"
  | "INVALID_CURSOR"
  | "SOURCE_CHANGED"
  | "INVALID_INPUT";

/** 结构化错误：调用方按 code 分支（与 work 的 WorkError 同风格，不靠解析 message） */
export class ContextError extends Error {
  readonly code: ContextErrorCode;
  readonly detail: Record<string, unknown>;

  constructor(code: ContextErrorCode, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = "ContextError";
    this.code = code;
    this.detail = detail;
  }

  toJSON(): { code: ContextErrorCode; message: string; detail: Record<string, unknown> } {
    return { code: this.code, message: this.message, detail: this.detail };
  }
}

export function isContextError(e: unknown): e is ContextError {
  return e instanceof ContextError;
}

// ── 来源清单 ──

/** 来源在包里的角色 */
export type ContextSourceKind = "design" | "plan" | "baseline" | "task_state" | "file" | "project_notes";

/** §2.8 的状态口径：成功 / 失败 / 截断 / 二进制排除（+ 一个字节都没取到的未读） */
export type SourceStatus = "ok" | "truncated" | "failed" | "binary_excluded" | "not_read";

/** 来源清单一条（§2.8：路径 / 内容哈希 / 实际取回的行或字节范围 / 状态） */
export interface ContextSourceEntry {
  path: string;
  kind: ContextSourceKind;
  /** 全文内容哈希（读不到为 null） */
  content_sha256: string | null;
  /** 源总长（读不到为 null） */
  size: { lines: number; bytes: number; chars: number } | null;
  /** **实际取回**的范围（进包/进模型请求的那一段）；一个字节都没取到为 null */
  taken: CoverageRange | null;
  /** 实际取回的字节范围（与 taken 对应） */
  taken_bytes: CoverageRange | null;
  /** 已取回字符数 / 源总字符数（未覆盖范围由 omitted 明说） */
  covered: { chars: number; total_chars: number | null; complete: boolean };
  status: SourceStatus;
  note: string | null;
}

/** 未覆盖范围（§2.8：摘要要注明实际覆盖与未覆盖的范围） */
export interface OmittedEntry {
  path: string;
  reason:
    | "over_budget"
    | "binary_excluded"
    | "list_cap"
    | "not_read"
    | "source_missing"
    | "failed"
    | "truncated";
  detail: string;
  size: { lines: number; bytes: number; chars: number } | null;
}

// ── 覆盖账本 ──

export interface LedgerSeed {
  path: string;
  content_sha256: string;
  ranges: CoverageRange[];
  complete: boolean;
}

export type LedgerStatus = "ok" | "partial" | "failed" | "binary_excluded" | "not_read" | "pending";

export interface LedgerEntry {
  path: string;
  status: LedgerStatus;
  reason: string | null;
  content_sha256: string | null;
  size: { lines: number; bytes: number; chars: number } | null;
  /** 真正成功取回的范围（累积） */
  ranges: CoverageRange[];
  covered_chars: number;
  requested: number;
  taken: number;
  complete: boolean;
  /** 从哪个游标接着读（部分覆盖时非空） */
  resume_cursor: string | null;
}

/** 覆盖回执（服务器数出来的，不是模型自述）；ask_flash 的 full_coverage 与聊天对账共用它 */
export interface CoverageSummary {
  /** 清单里参与对账的文件数（不含按扩展名排除的二进制/数据文件） */
  manifest_files: number;
  /** 完整读完的文件数 */
  fully_read: number;
  /** 只读了一部分（截断/游标未完）的文件 */
  partial: number;
  /** 真读了但失败（不存在/不是文件/读错误）的文件 */
  failed: number;
  /** 一次都没读到（含批总量挡下的 not_read 与压根没请求的） */
  never_read: number;
  /** 按扩展名排除在外的二进制/数据文件数（如实计数，不算已读） */
  binary_excluded: number;
  /** 清单本身是否被上限截断（截断即"清单 ≠ 全量"，回执必须说明） */
  list_truncated: boolean;
  covered_chars: number;
  total_chars: number;
  /** 未覆盖明细（含截断范围、失败原因、二进制排除、清单上限） */
  omitted: OmittedEntry[];
  /** 已确认来源（可写进检查点，下一轮不重读） */
  confirmed: LedgerSeed[];
}

/**
 * 覆盖账本：只记**真实取回的字节/行范围**。
 *
 * 红线（§2.8）：不缩小清单、不跳过 tests、不隐藏二进制排除、**不把失败路径计为已读**。
 * 因此 `noteReceipt` 只接受工具回执，`request` 只是意向（单独计数，绝不产生"已覆盖"）。
 */
export class CoverageLedger {
  private readonly entries = new Map<string, LedgerEntry>();
  private manifest: string[] | null = null;
  private manifestTruncated = false;
  private binaryExcluded: { path: string; reason: string }[] = [];

  /** 登记清单（覆盖对账的"全量"基准；null = 还没有清单，不宣称覆盖） */
  setManifest(paths: string[], opts: { truncated?: boolean; binaryExcluded?: string[] } = {}): void {
    this.manifest = [...paths];
    this.manifestTruncated = opts.truncated === true;
    this.binaryExcluded = (opts.binaryExcluded ?? []).map((p) => ({ path: p, reason: "binary_ext" }));
    for (const p of this.manifest) this.ensure(p);
    for (const b of this.binaryExcluded) {
      const e = this.ensure(b.path);
      if (e.taken === 0) {
        e.status = "binary_excluded";
        e.reason = "binary_ext";
      }
    }
  }

  /** 已有清单时登记"按扩展名排除、不参与对账"的二进制/数据文件 */
  noteBinaryExcluded(paths: string[]): void {
    for (const p of paths) {
      this.binaryExcluded.push({ path: p, reason: "binary_ext" });
      const e = this.ensure(p);
      if (e.taken === 0) {
        e.status = "binary_excluded";
        e.reason = "binary_ext";
      }
    }
  }

  private ensure(p: string): LedgerEntry {
    const key = p;
    let e = this.entries.get(key);
    if (e === undefined) {
      e = {
        path: key,
        status: "pending",
        reason: null,
        content_sha256: null,
        size: null,
        ranges: [],
        covered_chars: 0,
        requested: 0,
        taken: 0,
        complete: false,
        resume_cursor: null,
      };
      this.entries.set(key, e);
    }
    return e;
  }

  /** 记一次"请求"（只用于如实展示"点过但没读到"，绝不产生已覆盖） */
  noteRequest(p: string): void {
    this.ensure(p).requested++;
  }

  /** 记一次工具的真实回执——**唯一**能让来源变成"已覆盖"的入口 */
  noteReceipt(r: ReadReceipt): void {
    const e = this.ensure(r.path);
    e.taken++;
    if (r.total !== null) e.size = r.total;
    if (r.content_sha256 !== null) e.content_sha256 = r.content_sha256;
    if (r.range !== null) e.ranges.push(r.range);
    e.covered_chars += r.chars;
    e.resume_cursor = r.next_cursor ?? (r.complete ? null : e.resume_cursor);
    // 覆盖 = **范围并集**：分段续读把 [1, total] 补齐才算读全（单次截断永远不算）
    e.complete = rangesCoverAll(e.ranges, e.size?.lines ?? null);
    if (e.complete) {
      e.status = "ok";
      e.reason = null;
      return;
    }
    switch (r.status) {
      case "truncated":
        e.status = "partial";
        e.reason = r.reason ?? "truncated";
        break;
      case "ok":
        // 只读到非头部的一段（cursor 续读的中间页）：不是全文件读完
        e.status = "partial";
        e.reason = "partial_range";
        break;
      case "binary_excluded":
        if (e.ranges.length === 0) {
          e.status = "binary_excluded";
          e.reason = r.reason ?? "binary";
        }
        break;
      case "not_read":
        if (e.ranges.length === 0 && e.taken === 1) {
          e.status = "not_read";
          e.reason = r.reason ?? "not_read";
        }
        break;
      case "failed":
        // 真去读了但没读到（不存在/不是文件/游标失效/读错误）：**不得计为已读**。
        // 已经有部分内容时不降级成 failed（失败的是那一次续读，不是已有覆盖）。
        if (e.ranges.length === 0) {
          e.status = "failed";
          e.reason = r.reason ?? "failed";
        }
        break;
    }
  }

  /** 种入上一轮已确认的来源（检查点续接：已读不重读，但版本对不上就不算） */
  seedConfirmed(seeds: LedgerSeed[]): void {
    for (const s of seeds) {
      const e = this.ensure(s.path);
      if (e.content_sha256 !== null && e.content_sha256 !== s.content_sha256) continue;
      e.content_sha256 = s.content_sha256;
      e.ranges = [...s.ranges];
      e.complete = s.complete;
      e.status = s.complete ? "ok" : "partial";
      e.reason = null;
    }
  }

  entriesOf(): LedgerEntry[] {
    return [...this.entries.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  /**
   * 已确认来源（可写进检查点）：**真取到过内容**的（有哈希、有范围）。
   * 与 `summary().confirmed` 的差别：这里不限于对账清单——聊天里读到的文件同样算已确认。
   */
  confirmedSeeds(): LedgerSeed[] {
    return this.entriesOf()
      .filter((e) => e.content_sha256 !== null && e.ranges.length > 0)
      .map((e) => ({
        path: e.path,
        content_sha256: e.content_sha256 as string,
        ranges: e.ranges,
        complete: e.complete,
      }));
  }

  /** 清单里还没完整覆盖的路径（没有清单时 null = 不宣称"读全了"） */
  unread(): string[] | null {
    if (this.manifest === null) return null;
    return this.manifest.filter((p) => this.entries.get(p)?.complete !== true);
  }

  hasManifest(): boolean {
    return this.manifest !== null;
  }

  summary(): CoverageSummary {
    const list = this.manifest ?? [];
    let fully = 0;
    let partial = 0;
    let failed = 0;
    let never = 0;
    let coveredChars = 0;
    let totalChars = 0;
    const omitted: OmittedEntry[] = [];
    const confirmed: LedgerSeed[] = [];
    for (const p of list) {
      const e = this.entries.get(p);
      const entry: LedgerEntry = e ?? {
        path: p,
        status: "not_read",
        reason: "never_requested",
        content_sha256: null,
        size: null,
        ranges: [],
        covered_chars: 0,
        requested: 0,
        taken: 0,
        complete: false,
        resume_cursor: null,
      };
      coveredChars += entry.covered_chars;
      totalChars += entry.size?.chars ?? 0;
      if (entry.complete) {
        fully++;
        confirmed.push({
          path: entry.path,
          content_sha256: entry.content_sha256 ?? "",
          ranges: entry.ranges,
          complete: true,
        });
      } else {
        confirmed.push({
          path: entry.path,
          content_sha256: entry.content_sha256 ?? "",
          ranges: entry.ranges,
          complete: false,
        });
        if (entry.status === "partial") {
          partial++;
          omitted.push({
            path: entry.path,
            reason: "truncated",
            detail:
              `只取到 ${entry.covered_chars} 字` +
              (entry.size ? ` / 全文 ${entry.size.chars} 字` : "") +
              (entry.resume_cursor !== null ? `（续读游标 ${entry.resume_cursor}）` : ""),
            size: entry.size,
          });
        } else if (entry.status === "failed") {
          failed++;
          omitted.push({
            path: entry.path,
            reason: "failed",
            detail: `读取失败：${entry.reason ?? "unknown"}`,
            size: entry.size,
          });
        } else if (entry.status === "binary_excluded") {
          omitted.push({
            path: entry.path,
            reason: "binary_excluded",
            detail: "二进制/数据文件（按扩展名排除），未读也不计入已覆盖",
            size: entry.size,
          });
        } else {
          never++;
          omitted.push({
            path: entry.path,
            reason: "not_read",
            detail: entry.reason === null ? "一次都没读到" : `未读：${entry.reason}`,
            size: entry.size,
          });
        }
      }
    }
    const extraBinary = this.binaryExcluded.filter((b) => !list.includes(b.path));
    if (extraBinary.length > 50) {
      omitted.push({
        path: "*",
        reason: "binary_excluded",
        detail: `另有 ${extraBinary.length} 个二进制/数据文件（按扩展名）排除在对账清单外，未读也不计入已覆盖`,
        size: null,
      });
    } else {
      for (const b of extraBinary) {
        omitted.push({
          path: b.path,
          reason: "binary_excluded",
          detail: "二进制/数据文件（按扩展名排除），未计入对账清单",
          size: null,
        });
      }
    }
    if (this.manifestTruncated) {
      omitted.push({
        path: "*",
        reason: "list_cap",
        detail: `清单已达上限截断：对账只覆盖所列部分，清单不等于全量`,
        size: null,
      });
    }
    return {
      manifest_files: list.length,
      fully_read: fully,
      partial,
      failed,
      never_read: never,
      binary_excluded: this.binaryExcluded.length,
      list_truncated: this.manifestTruncated,
      covered_chars: coveredChars,
      total_chars: totalChars,
      omitted,
      confirmed,
    };
  }
}

/**
 * 覆盖范围合并判据：若干段行范围能不能盖住 [1, totalLines]。
 * （§2.8：成功读了一段不等于全文件读完——只有并集补齐才算。）
 */
export function rangesCoverAll(ranges: CoverageRange[], totalLines: number | null): boolean {
  if (totalLines === null) return false;
  const lines = ranges.filter((r) => r.unit === "lines").sort((a, b) => a.start - b.start);
  if (lines.length === 0) return false;
  if (lines[0].start > 1) return false;
  let covered = lines[0].end;
  for (const r of lines.slice(1)) {
    if (r.start > covered + 1) return false;
    covered = Math.max(covered, r.end);
  }
  return covered >= totalLines;
}

/**
 * 覆盖对账回执（人话，给模型与用户看的**同一份**）。
 *
 * 前两行的措辞是既有口径（`verify:m5` 按它断言），只在后面补真实分项：
 * 部分覆盖 / 读取失败 / 二进制排除 / 清单上限——都在同一份账本里数出来。
 */
export function formatCoverageReceipt(summary: CoverageSummary, scopeNote = ""): string {
  const head = "\n\n——覆盖对账（服务器机械核验）——\n";
  const capNote = summary.list_truncated
    ? `（清单已达上限截断，对账只覆盖所列部分——清单不等于全量）`
    : "";
  const binNote =
    summary.binary_excluded > 0
      ? `另有 ${summary.binary_excluded} 个二进制/数据文件（按扩展名）不计入对账。`
      : "";
  const partialNote = summary.partial > 0 ? `${summary.partial} 个只读到部分范围（截断/未完）。` : "";
  const failedNote = summary.failed > 0 ? `${summary.failed} 个读取失败。` : "";
  if (summary.manifest_files === 0) {
    return `${head}${scopeNote}对账清单为空（没有可对账的文本文件）。${binNote}${capNote}`;
  }
  const detail = summary.partial + summary.failed + summary.never_read > 0 ? omissionLines(summary) : "";
  if (summary.fully_read === summary.manifest_files) {
    return `${head}${scopeNote}文件清单 ${summary.manifest_files} 个，全部已读。${binNote}${capNote}`;
  }
  return (
    `${head}${scopeNote}文件清单 ${summary.manifest_files} 个，已读 ${summary.fully_read} 个；` +
    `${partialNote}${failedNote}以下 ${summary.manifest_files - summary.fully_read} 个未读全、不作为本回答依据：\n` +
    `${detail}${binNote}${capNote}`
  );
}

const OMIT_SHOW_MAX = 60;

/** 未覆盖明细的行（点名路径与原因；超量如实说还有多少条没列） */
function omissionLines(summary: CoverageSummary): string {
  const rows = summary.omitted.filter((o) => o.reason !== "binary_excluded" && o.reason !== "list_cap");
  const shown = rows.slice(0, OMIT_SHOW_MAX).map((o) => `- ${o.path}（${o.detail}）`);
  const more = rows.length > OMIT_SHOW_MAX ? [`……另有 ${rows.length - OMIT_SHOW_MAX} 个未列出`] : [];
  return [...shown, ...more].join("\n") + (rows.length > 0 ? "\n" : "");
}

// ── 分页取回 ──

export interface ContextSourceRead {
  project_id: string;
  path: string;
  /** 源内容哈希（游标绑定的版本） */
  version: string;
  unit: CoverageUnit;
  text: string;
  range: CoverageRange;
  byte_range: CoverageRange;
  total: { unit: CoverageUnit; count: number; lines: number; bytes: number; chars: number };
  next_cursor: string | null;
  status: "ok" | "truncated";
  complete: boolean;
  content_sha256: string;
}

/**
 * 按需取回一段原文（§2.8 的分段取回 + 续读游标）。
 *
 * 路径只接受**项目根内相对路径**；`cursor` 绑定内容哈希，源变了抛 `SOURCE_CHANGED`
 * （不是静默返回旧内容，也不是悄悄从头读）。
 */
export function readContextSource(
  projectId: string,
  rel: string,
  opts: { dataDir?: string; cursor?: string; maxChars?: number } = {},
): ContextSourceRead {
  const project = getProject(projectId, opts.dataDir);
  if (!project) {
    throw new ContextError("PROJECT_NOT_FOUND", `项目不存在: ${projectId}`, { project_id: projectId });
  }
  const root = path.resolve(project.path);
  const abs = resolveInRoot(root, rel);
  if (abs === null) {
    throw new ContextError("INVALID_INPUT", `只接受项目根内的相对路径：${JSON.stringify(rel)}`, {
      path: rel,
    });
  }
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    throw new ContextError("INVALID_INPUT", `源不存在或不是文件：${rel}`, { path: rel });
  }
  const content = fs.readFileSync(abs, "utf8");
  const version = sha256(content);
  const lines = content.split(/\r?\n/);
  const maxChars = Math.max(200, opts.maxChars ?? CONTEXT_PAGE_MAX_CHARS);

  let start = 1;
  if (opts.cursor !== undefined && opts.cursor !== "") {
    // U3 上游接线：泛型文件读口**兼容消费**新格式 `tcur1`（完整 sha ＋ 项目/文档绑定），
    // 因为上下文包的设计/施工页现在给的正是它——若只认旧 `tctx1`，包里的指路标就用不了。
    // 旧 `tctx1` 行为**逐字不变**（16 位前缀匹配）。校验：完整哈希不符＝SOURCE_CHANGED、绑定不符＝INVALID_CURSOR。
    const modern = parseProjectCursor(opts.cursor);
    if (modern !== null) {
      if (modern.fullSha !== version) {
        throw new ContextError(
          "SOURCE_CHANGED",
          `源内容已变，游标失效（游标绑定完整哈希 ${modern.fullSha.slice(0, 16)}…，当前 ${version.slice(0, 16)}…）：${rel}`,
          { path: rel, cursor_version: modern.fullSha, current_version: version },
        );
      }
      const expectBind = cursorBinding(projectId, modern.doc, version);
      if (modern.bind !== expectBind) {
        throw new ContextError("INVALID_CURSOR", `游标项目/文档绑定不符（绑定 ${modern.bind}，当前应为 ${expectBind}）：${rel}`, {
          path: rel,
          cursor_bind: modern.bind,
          expected_bind: expectBind,
        });
      }
      start = Math.min(Math.max(1, modern.start), lines.length + 1);
    } else {
      const cur = parseCursor(opts.cursor);
      if (cur === null) {
        throw new ContextError("INVALID_CURSOR", `游标形态不合法：${JSON.stringify(opts.cursor)}`, {
          cursor: opts.cursor,
        });
      }
      if (!cursorMatchesVersion(cur, version)) {
        throw new ContextError(
          "SOURCE_CHANGED",
          `源内容已变，旧游标失效（游标绑定 ${cur.version}，当前 ${version.slice(0, 16)}）：${rel}`,
          { path: rel, cursor_version: cur.version, current_version: version },
        );
      }
      start = Math.min(Math.max(1, cur.start), lines.length + 1);
    }
  }

  const picked: string[] = [];
  let used = 0;
  let i = start - 1;
  while (i < lines.length) {
    const add = lines[i].length + (picked.length > 0 ? 1 : 0);
    if (picked.length > 0 && used + add > maxChars) break;
    picked.push(lines[i]);
    used += add;
    i++;
  }
  const end = picked.length === 0 ? Math.max(1, start - 1) : start + picked.length - 1;
  const takenBytes = Buffer.byteLength(picked.join("\n"), "utf8");
  const prefixBytes = Buffer.byteLength(lines.slice(0, start - 1).join("\n") + (start > 1 ? "\n" : ""), "utf8");
  const nextStart = picked.length === 0 ? start : end + 1;
  const more = nextStart <= lines.length;
  const complete = start === 1 && !more;
  return {
    project_id: projectId,
    path: normRel(rel),
    version,
    unit: "lines",
    text: picked.join("\n"),
    range: { unit: "lines", start, end },
    byte_range: { unit: "bytes", start: prefixBytes, end: prefixBytes + takenBytes },
    total: {
      unit: "lines",
      count: lines.length,
      lines: lines.length,
      bytes: Buffer.byteLength(content, "utf8"),
      chars: content.length,
    },
    next_cursor: more ? makeCursor(version, "lines", nextStart) : null,
    status: complete ? "ok" : "truncated",
    complete,
    content_sha256: version,
  };
}

// ── 上下文包 ──

export interface ContextTaskRef {
  task_id: string;
  goal: string | null;
  dependency_ids: string[];
  acceptance_checks: number;
  plan_revision: string | null;
  section_lines: [number, number] | null;
  source_path: string;
  definition_sha256: string;
}

export interface ContextSectionRef {
  kind: DocumentKind;
  path: string;
  title: string;
  section_path: string;
  line_start: number;
  line_end: number;
  sha256: string;
}

export interface ContextPage {
  path: string;
  version: string;
  text: string;
  range: CoverageRange;
  byte_range: CoverageRange;
  total: ContextSourceRead["total"];
  next_cursor: string | null;
  complete: boolean;
}

export interface ContextBrief {
  text: string;
  design_source: string | null;
  plan_source: string | null;
  task_counts: Record<string, number>;
}

export interface ContextBaselineRef {
  baseline_id: string;
  active_at: string;
  approved_by: string;
  approval_kind: string;
  design_revision: string;
  plan_revision: string;
  design_source: string;
  plan_source: string;
}

/** 分层上下文包（字段按 DESIGN.md §2.8：package_id/generated_at/design_revision/source_manifest/token_or_char_size/omitted/stale_reasons） */
export interface ContextPackage {
  schema_version: 1;
  package_id: string;
  generated_at: string;
  project_id: string;
  /** 设计书定义/内容修订（内容 sha256；缺图纸为 null） */
  design_revision: string | null;
  /** 施工图修订（内容 sha256） */
  plan_revision: string | null;
  /** 施工定义哈希（§2.9：不含派生状态） */
  plan_definition_digest: string | null;
  /** 生效基线（生效决定；未激活为 null） */
  baseline: ContextBaselineRef | null;
  /** ① 项目简报（为什么做、当前例外、版本） */
  brief: ContextBrief;
  /** ② 相关任务（TaskDefinition 摘要）与相关章节 */
  tasks: ContextTaskRef[];
  sections: ContextSectionRef[];
  /** 分段取回的一页（默认取设计书首段；可为 null = 没有可取的图纸） */
  page: ContextPage | null;
  /** 建包时的提问/主题（增量重建要按它判断"派生结果能否沿用"） */
  question: string | null;
  /** 分页：后续页的游标（null = 当前页已到末尾） */
  next_cursor: string | null;
  /** 分页：来源总数与内联字符总量 */
  total: { sources: number; chars: number; full_chars: number };
  source_manifest: ContextSourceEntry[];
  token_or_char_size: number;
  omitted: OmittedEntry[];
  stale_reasons: string[];
  /** 覆盖账本摘要（有清单时才有值） */
  coverage: CoverageSummary | null;
}

export interface BuildContextOptions {
  dataDir?: string;
  /** 提问/主题：用来挑"相关任务与章节"（不传 = 只列简报与索引） */
  question?: string | null;
  maxChars?: number;
  pageMaxChars?: number;
  /** 覆盖账本的候选清单（chatTurn 的 full_coverage 传；来自 collectFiles，口径与清单同源） */
  manifest_paths?: string[];
  manifest_truncated?: boolean;
  binary_excluded_paths?: string[];
  /** 复用已建账本（聊天工具循环里要持续记账） */
  ledger?: CoverageLedger;
  /** 旧包（增量重建用）：只重读变了的来源 */
  previous?: ContextPackage | null;
  /**
   * 共享账本事件（V09-39 上游接线）：调用方（唯一宿主只读入口 / `entry.ts`）已为本次请求现读的**同一份**
   * `WorkEvent[]` 快照。给了就**不再另读盘**（`readTaskStates` 直接折叠这份事件）；缺省仍现读，行为不变。
   * 空数组是**合法快照**（"这个 workDir 现在没有事件"），不得当作"没传"再读一遍。
   */
  events?: readonly WorkEvent[];
  /**
   * 与 `events` 同源的账本**内容身份**（`ledgerRead.readLedger().content`：真实字节 sha256）。
   * 有它就用它当 `task_state` 来源的内容哈希；**绝不拿 `last_seq:N` 冒充内容哈希**（契约 U1/U2）。
   * 只传 `events` 未传它时，该来源内容哈希**留空**（如实：本次未带内容身份），而不是编造。
   */
  eventsContent?: LedgerContentFingerprint;
}

/** 包内存注册表：`refreshContextPackage` / `packageStaleness` 要能按 id 找回上一版 */
interface StoredPackage {
  pkg: ContextPackage;
  project_id: string;
}
const PACKAGES = new Map<string, StoredPackage>();
/** 注册表上限：聊天每发一条消息就建一个包，不设上限就是内存泄漏（超出按最早建的淘汰） */
const PACKAGES_MAX = 50;

export function getContextPackage(packageId: string): ContextPackage | null {
  return PACKAGES.get(packageId)?.pkg ?? null;
}

/** 清空包注册表（验证脚本隔离用；产品路径不需要） */
export function clearContextPackages(): void {
  PACKAGES.clear();
}

function sha256(data: string | Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

const normRel = (p: string): string => p.replace(/\\/g, "/").replace(/^\.\//, "");

/** 项目根内相对路径 → 绝对路径（越界/绝对路径一律 null，与 chatTools.safeResolve 同一条红线） */
function resolveInRoot(root: string, rel: string): string | null {
  if (typeof rel !== "string" || rel === "" || rel.includes("\0")) return null;
  if (path.isAbsolute(rel) || /^[a-zA-Z]:[\\/]/.test(rel)) return null;
  if (rel.split(/[\\/]/).includes("..")) return null;
  const rootNorm = path.resolve(root);
  const target = path.resolve(rootNorm, rel);
  if (target !== rootNorm && !target.startsWith(rootNorm + path.sep)) return null;
  return target;
}

/** 关键词切分（中文按字、拉丁按词）：挑"相关任务/章节"用的朴素口径，不引模型 */
function keywordsOf(question: string | null | undefined): string[] {
  const text = (question ?? "").trim();
  if (text === "") return [];
  const latin = text.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? [];
  const han = text.match(/[\u4e00-\u9fa5]{2,}/g) ?? [];
  const grams: string[] = [];
  for (const h of han) {
    for (let i = 0; i < h.length - 1; i++) grams.push(h.slice(i, i + 2));
  }
  return [...new Set([...latin, ...grams])].slice(0, 40);
}

function scoreText(text: string, keywords: string[]): number {
  if (keywords.length === 0) return 0;
  const lower = text.toLowerCase();
  let score = 0;
  for (const k of keywords) if (lower.includes(k)) score++;
  return score;
}

/** 读一份图纸并登记来源清单（读不到如实记 omitted，不伪装成"空图纸"） */
function loadDocumentEntry(
  projectId: string,
  kind: DocumentKind,
  dataDir: string | undefined,
  manifest: ContextSourceEntry[],
  omitted: OmittedEntry[],
  stale: string[],
  previous: ContextPackage | null,
): { loaded: ReturnType<typeof loadDocument>; reused: boolean } {
  let rel: string | null = null;
  try {
    rel = resolveDocumentSource(projectId, kind, dataDir).rel_path;
  } catch (e) {
    stale.push(`图纸源不可用（${kind}）：${sanitizeErrorMessage((e as Error).message)}`);
    omitted.push({
      path: kind === "design" ? "(design)" : "(plan)",
      reason: "failed",
      detail: sanitizeErrorMessage((e as Error).message),
      size: null,
    });
    return { loaded: null, reused: false };
  }
  let loaded: ReturnType<typeof loadDocument>;
  try {
    loaded = loadDocument(projectId, kind, dataDir);
  } catch (e) {
    stale.push(`图纸读取失败（${kind}）：${sanitizeErrorMessage((e as Error).message)}`);
    omitted.push({
      path: rel,
      reason: "failed",
      detail: sanitizeErrorMessage((e as Error).message),
      size: null,
    });
    return { loaded: null, reused: false };
  }
  if (loaded === null) {
    omitted.push({ path: rel, reason: "source_missing", detail: "图纸源不存在（正常空态，不是读取失败）", size: null });
    return { loaded: null, reused: false };
  }
  const prevEntry = previous?.source_manifest.find((m) => m.path === loaded!.source.rel_path);
  const reused = prevEntry !== undefined && prevEntry.content_sha256 === loaded.revision.content_sha256;
  if (prevEntry !== undefined && !reused) {
    stale.push(
      `源内容变化：${loaded.source.rel_path}（${prevEntry.content_sha256?.slice(0, 8) ?? "?"} → ${loaded.revision.content_sha256.slice(0, 8)}）`,
    );
  }
  manifest.push({
    path: loaded.source.rel_path,
    kind,
    content_sha256: loaded.revision.content_sha256,
    size: {
      lines: loaded.revision.lines,
      bytes: loaded.revision.bytes,
      chars: loaded.text.length,
    },
    taken: null,
    taken_bytes: null,
    covered: { chars: 0, total_chars: loaded.text.length, complete: false },
    // 图纸源是**读到全文**才算成功（要算修订哈希）；但"读到了"不等于"已内联进包"，
    // 内联多少看 taken/covered，未内联的范围一律进 omitted
    status: "ok",
    note:
      (reused ? "沿用上一版包（内容未变）；" : "") +
      "已读全文用于修订哈希与派生；本包实际内联的范围见 taken",
  });
  return { loaded, reused };
}

/** 把"进包了的一段原文"记回来源清单（只有真进包的范围才计入已覆盖） */
function noteTaken(
  manifest: ContextSourceEntry[],
  relPath: string,
  range: CoverageRange,
  byteRange: CoverageRange,
  chars: number,
  totalChars: number,
  complete: boolean,
): void {
  const e = manifest.find((m) => m.path === relPath);
  if (e === undefined) return;
  e.taken = range;
  e.taken_bytes = byteRange;
  e.covered = { chars, total_chars: totalChars, complete };
  e.status = complete ? "ok" : "truncated";
}

/**
 * 建一个分层上下文包（§2.8 的读取顺序：项目简报 → 相关任务/章节 → 按需原文）。
 * 只读：不动项目一个字节（检查点是另一条入口，见 `saveCheckpoint`）。
 */
export function buildContextPackage(projectId: string, opts: BuildContextOptions = {}): ContextPackage {
  const project = getProject(projectId, opts.dataDir);
  if (!project) {
    throw new ContextError("PROJECT_NOT_FOUND", `项目不存在: ${projectId}`, { project_id: projectId });
  }
  const budget = Math.max(500, opts.maxChars ?? CONTEXT_MAX_CHARS);
  const pageMax = Math.max(200, opts.pageMaxChars ?? CONTEXT_PAGE_MAX_CHARS);
  const manifest: ContextSourceEntry[] = [];
  const omitted: OmittedEntry[] = [];
  const stale: string[] = [];
  const previous = opts.previous ?? null;
  const question = opts.question ?? null;
  const workbenchRel = `${WORKBENCH_DIRNAME}/work`;
  // 覆盖账本先接上清单：账本是"边跑边更新"的，包要在建的时候就带上它的当前摘要
  if (opts.ledger !== undefined && opts.manifest_paths !== undefined) {
    opts.ledger.setManifest(opts.manifest_paths, {
      truncated: opts.manifest_truncated === true,
      binaryExcluded: opts.binary_excluded_paths ?? [],
    });
  }

  // ① 图纸：设计书 + 施工图（唯一当前源；修订号进包）
  //    上一版包在时，来源内容没变的会带 "沿用上一版包（内容未变）" 的登记（增量口径）
  const design = loadDocumentEntry(projectId, "design", opts.dataDir, manifest, omitted, stale, previous);
  const plan = loadDocumentEntry(projectId, "plan", opts.dataDir, manifest, omitted, stale, previous);

  // ② 生效决定/基线（documents.ts 的 baselines.jsonl 最后一条有效记录）
  let baseline: ContextBaselineRef | null = null;
  let baselineLog: ProjectBaseline | null = null;
  try {
    baselineLog = activeBaseline(projectId, opts.dataDir);
  } catch (e) {
    stale.push(`基线流水不可读：${sanitizeErrorMessage((e as Error).message)}`);
  }
  if (baselineLog !== null) {
    baseline = {
      baseline_id: baselineLog.baseline_id,
      active_at: baselineLog.active_at,
      approved_by: baselineLog.approved_by,
      approval_kind: baselineLog.approval_kind,
      design_revision: baselineLog.design_revision.content_sha256,
      plan_revision: baselineLog.plan_revision.definition_sha256,
      design_source: baselineLog.design_revision.source_path,
      plan_source: baselineLog.plan_revision.source_path,
    };
    const prevEntry = previous?.source_manifest.find((m) => m.kind === "baseline");
    const changed = prevEntry !== undefined && prevEntry.content_sha256 !== baselineLog.baseline_id;
    if (changed) stale.push(`生效基线变化：${prevEntry!.content_sha256} → ${baselineLog.baseline_id}`);
    manifest.push({
      path: `${WORKBENCH_DIRNAME}/${BASELINES_FILE}`,
      kind: "baseline",
      content_sha256: baselineLog.baseline_id,
      size: null,
      taken: null,
      taken_bytes: null,
      covered: { chars: 0, total_chars: null, complete: true },
      status: "ok",
      note: `生效基线 ${baselineLog.baseline_id}（${baselineLog.approved_by} / ${baselineLog.approval_kind}）`,
    });
  } else {
    omitted.push({
      path: `${WORKBENCH_DIRNAME}/${BASELINES_FILE}`,
      reason: "source_missing",
      detail: "尚未激活成套图纸基线（生效决定为空，不能假设按哪一版干活）",
      size: null,
    });
  }

  // ②b 可选：项目说明索引（docs/project-notes.json，V09-39）——存在就纳入来源清单（真实内容哈希）；
  //     不存在是**正常空态**（不强制首建全仓说明才接续、也不进 omitted）；异 schema/读不出如实标。
  try {
    const notes = projectNotesFileInfo(projectId, opts.dataDir);
    if (notes.exists) {
      manifest.push({
        path: PROJECT_NOTES_REL,
        kind: "project_notes",
        content_sha256: notes.version_sha256,
        size: null,
        taken: null,
        taken_bytes: null,
        covered: { chars: 0, total_chars: null, complete: true },
        status: notes.schema_ok ? "ok" : "failed",
        note: notes.schema_ok
          ? `Agent 编写的项目说明索引（待审说明层，${notes.entry_count} 条）：不是设计/事件/验收事实，不改六图颜色/状态/Gate`
          : `说明索引存在但不是本 schema（${notes.conflict?.code ?? "conflict"}）：不按本 schema 采信、不可覆盖`,
      });
      if (!notes.schema_ok) stale.push(`说明索引不可按本 schema 采信：${notes.conflict?.message ?? ""}`);
    }
  } catch (e) {
    stale.push(`说明索引读取失败：${sanitizeErrorMessage((e as Error).message)}`);
  }

  // 增量重建的沿用判据：图纸修订与提问都没变 → 上次派生的任务/章节直接沿用（不重解析）
  const derivedReusable =
    previous !== null &&
    previous.tasks.length > 0 &&
    previous.design_revision === (design.loaded?.revision.content_sha256 ?? null) &&
    previous.plan_revision === (plan.loaded?.revision.content_sha256 ?? null) &&
    previous.question === question;

  // ③ 任务定义（V06-03 的 plan.ts：稳定 id / 依赖 / 验收 / 修订绑定）
  const tasks: ContextTaskRef[] = [];
  let definitions: TaskDefinition[] = [];
  let planDefinitionDigest: string | null = null;
  if (derivedReusable && previous !== null) {
    tasks.push(...previous.tasks);
    planDefinitionDigest = previous.plan_definition_digest;
  } else if (plan.loaded !== null) {
    const imported = importTaskDefinitions(plan.loaded.text, {
      plan_revision: plan.loaded.revision.content_sha256,
    });
    definitions = imported.definitions;
    planDefinitionDigest = imported.report.definition_digest;
    const keywords = keywordsOf(question);
    const ranked = definitions
      .map((d) => ({ d, score: scoreText([d.task_id, d.goal ?? "", d.forbidden ?? "", d.inputs ?? ""].join("\n"), keywords) }))
      .sort((a, b) =>
        b.score - a.score ||
        (a.d.priority ?? "zz").localeCompare(b.d.priority ?? "zz") ||
        a.d.task_id.localeCompare(b.d.task_id),
      );
    for (const { d } of ranked.slice(0, CONTEXT_TASKS_MAX)) {
      tasks.push({
        task_id: d.task_id,
        goal: d.goal,
        dependency_ids: d.dependency_ids,
        acceptance_checks: d.acceptance?.checks.length ?? 0,
        plan_revision: d.plan_revision,
        section_lines: d.section_lines,
        source_path: plan.loaded.source.rel_path,
        definition_sha256: taskDefinitionHash(d),
      });
    }
    if (definitions.length > CONTEXT_TASKS_MAX) {
      omitted.push({
        path: plan.loaded.source.rel_path,
        reason: "over_budget",
        detail: `施工图共 ${definitions.length} 张卡，本包按相关度只列 ${CONTEXT_TASKS_MAX} 张（其余按需取原文）`,
        size: null,
      });
    }
  }

  // ④ 相关章节（设计书章节索引；有关键词就按相关度挑，没有就列层级靠前的）
  const sections: ContextSectionRef[] = [];
  if (derivedReusable && previous !== null) {
    sections.push(...previous.sections);
  } else {
    const addSections = (kind: DocumentKind, doc: typeof design.loaded): void => {
      if (doc === null) return;
      const keywords = keywordsOf(question);
      const ranked: { s: DocumentSection; score: number }[] = doc.revision.sections.map((s) => ({
        s,
        score: scoreText(`${s.path}\n${doc.text.split(/\r?\n/).slice(s.line_start - 1, s.line_end).join("\n")}`, keywords),
      }));
      ranked.sort((a, b) => b.score - a.score || a.s.line_start - b.s.line_start);
      for (const { s } of ranked.slice(0, CONTEXT_SECTIONS_MAX)) {
        sections.push({
          kind,
          path: doc.source.rel_path,
          title: s.title,
          section_path: s.path,
          line_start: s.line_start,
          line_end: s.line_end,
          sha256: s.sha256,
        });
      }
    };
    addSections("design", design.loaded);
    addSections("plan", plan.loaded);
  }

  // ⑤ 项目简报（为什么做、当前例外、版本、运行状态计数）
  const briefText: string[] = [];
  briefText.push(`项目：${project.name}（${project.id}，${project.kind}）`);
  briefText.push(
    design.loaded === null
      ? "设计书源：无（未登记/不存在）"
      : `设计书源：${design.loaded.source.rel_path}（内容修订 ${design.loaded.revision.content_sha256.slice(0, 12)}，` +
          `${design.loaded.revision.lines} 行 / ${design.loaded.revision.bytes} 字节）`,
  );
  briefText.push(
    plan.loaded === null
      ? "施工图源：无（未登记/不存在）"
      : `施工图源：${plan.loaded.source.rel_path}（修订 ${plan.loaded.revision.content_sha256.slice(0, 12)}，` +
          `${definitions.length} 张卡，定义哈希 ${(planDefinitionDigest ?? "").slice(0, 12)}）`,
  );
  briefText.push(
    baseline === null
      ? "生效基线：尚未激活（没有审定生效的成套图纸版本）"
      : `生效基线：${baseline.baseline_id}（${baseline.active_at}，${baseline.approved_by} / ${baseline.approval_kind}）`,
  );
  const taskCounts: Record<string, number> = {};
  const states: Record<string, TaskState> = {};
  // V09-39 上游接线：优先复用调用方（唯一宿主只读入口 / entry.ts）已现读的**同一份**账本事件，不再另读盘；
  // 未提供时现读一次 `readLedger`（顺带拿到**真实内容身份**）。`eventsContent` 是真实字节 sha256，
  // **绝不拿 `last_seq:N` 冒充内容哈希**（契约 U1/U2；复审材料项）。
  let ledgerEvents: readonly WorkEvent[] | undefined = opts.events;
  let ledgerContent: LedgerContentFingerprint | null = opts.eventsContent ?? null;
  if (ledgerEvents === undefined) {
    try {
      const read = readLedger(projectWorkDir(projectId, opts.dataDir));
      ledgerEvents = read.events;
      ledgerContent = read.content;
    } catch {
      // 现读失败：留给下面的 readTaskStates 走原路径抛错并如实登记（失败语义逐字不变）
      ledgerContent = null;
    }
  }
  try {
    const projection = readTaskStates(
      projectWorkDir(projectId, opts.dataDir),
      ledgerEvents === undefined ? undefined : [...ledgerEvents],
    );
    for (const s of Object.values(projection.states)) {
      states[s.task_id] = s;
      taskCounts[s.status] = (taskCounts[s.status] ?? 0) + 1;
    }
    const doing = Object.values(states).filter((s) => s.status === "executing" || s.status === "claimed");
    briefText.push(
      `运行状态：${Object.keys(states).length} 张卡有已提交事件` +
        (Object.keys(taskCounts).length === 0
          ? "（还没有任何状态事件）"
          : `（${Object.entries(taskCounts)
              .map(([k, v]) => `${k} ${v}`)
              .join(" / ")}）`),
    );
    for (const s of doing) {
      const def = definitions.find((d) => d.task_id.toUpperCase() === s.task_id.toUpperCase());
      briefText.push(
        `在执行：${s.task_id}「${def?.goal ?? "(施工图里没有这张卡)"}」` +
          `（owner=${s.owner_id ?? "-"}，定义绑定 ${s.definition_sha256?.slice(0, 8) ?? "无"}）`,
      );
    }
    manifest.push({
      path: `${workbenchRel}/${EVENTS_FILE}`,
      kind: "task_state",
      // 真实账本内容身份（已验证字节的 sha256）；没有内容身份时如实留空，**不用 last_seq 冒充内容哈希**
      content_sha256: ledgerContent === null ? null : ledgerContent.prefix_sha256,
      size: null,
      taken: null,
      taken_bytes: null,
      covered: { chars: 0, total_chars: null, complete: true },
      status: "ok",
      note:
        `任务运行状态投影（重放到 seq ${projection.last_seq}）` +
        (ledgerContent === null
          ? "；本包未带账本内容身份，内容哈希留空（不以 last_seq 冒充内容哈希）"
          : `；账本内容身份 sha256=${ledgerContent.prefix_sha256.slice(0, 12)}…（已验证 ${ledgerContent.verified_bytes} 字节）`),
    });
  } catch (e) {
    const reason = sanitizeErrorMessage((e as Error).message);
    briefText.push(`运行状态：读取失败（${reason}）——不得据此推断进度`);
    stale.push(`运行状态不可读：${reason}`);
    manifest.push({
      path: `${workbenchRel}/${EVENTS_FILE}`,
      kind: "task_state",
      content_sha256: null,
      size: null,
      taken: null,
      taken_bytes: null,
      covered: { chars: 0, total_chars: null, complete: false },
      status: "failed",
      note: reason,
    });
    omitted.push({ path: `${workbenchRel}/${EVENTS_FILE}`, reason: "failed", detail: reason, size: null });
  }
  const brief: ContextBrief = {
    text: briefText.join("\n"),
    design_source: design.loaded?.source.rel_path ?? null,
    plan_source: plan.loaded?.source.rel_path ?? null,
    task_counts: taskCounts,
  };

  // ⑥ 按需原文的第一页（默认设计书：长设计必须分段取回并留续读游标）
  let page: ContextPage | null = null;
  let next_cursor: string | null = null;
  // 结构化派生（任务/章节）也占上下文：算进包大小，并从按需原文的预算里先扣掉
  const derivedChars = JSON.stringify({ tasks, sections }).length;
  const pageBudget = Math.max(200, Math.min(pageMax, budget - brief.text.length - derivedChars - 200));
  const pageDoc = design.loaded ?? plan.loaded;
  if (pageDoc !== null) {
    const read = readContextSource(projectId, pageDoc.source.rel_path, {
      ...(opts.dataDir === undefined ? {} : { dataDir: opts.dataDir }),
      maxChars: pageBudget,
    });
    // U3 上游接线：设计/施工页给**新格式** `tcur1` 完整版本游标（完整 64 位 sha ＋ 项目/文档绑定），
    // 才能被 read_design/read_plan 直接消费；旧的 `tctx1` 短前缀只定位、会被新 MCP 拒（复审材料项）。
    // 泛型文件读取接口（readContextSource）**保持旧游标**——兼容不改；只有这里的设计/施工页换新格式。
    const pageDocKind: CursorDoc | null =
      design.loaded !== null && pageDoc === design.loaded
        ? "design"
        : plan.loaded !== null && pageDoc === plan.loaded
          ? "plan"
          : null;
    const pageCursor =
      !read.complete && pageDocKind !== null
        ? makeProjectCursor(projectId, pageDocKind, read.content_sha256, "lines", read.range.end + 1)
        : read.next_cursor;
    page = {
      path: read.path,
      version: read.version,
      text: read.text,
      range: read.range,
      byte_range: read.byte_range,
      total: read.total,
      next_cursor: pageCursor,
      complete: read.complete,
    };
    next_cursor = pageCursor;
    noteTaken(
      manifest,
      read.path,
      read.range,
      read.byte_range,
      read.text.length,
      read.total.chars,
      read.complete,
    );
    if (!read.complete) {
      omitted.push({
        path: read.path,
        reason: "over_budget",
        detail:
          `本页只取第 ${read.range.start}–${read.range.end} 行（共 ${read.total.lines} 行）；` +
          `其余范围未取，续读游标 ${pageCursor ?? "-"}`,
        size: { lines: read.total.lines, bytes: read.total.bytes, chars: read.total.chars },
      });
    }
  }

  // 图纸来源里"读到了但没内联进本包"的范围同样要如实登记（覆盖 ≠ 已装进上下文）
  for (const entry of manifest) {
    if (entry.kind !== "design" && entry.kind !== "plan") continue;
    if (entry.covered.complete) continue;
    if (entry.taken === null) {
      omitted.push({
        path: entry.path,
        reason: "over_budget",
        detail: "本包未内联该来源原文（只用于修订哈希与派生）——需要原文请按需取回",
        size: entry.size,
      });
    } else {
      omitted.push({
        path: entry.path,
        reason: "over_budget",
        detail: `本包只内联第 ${entry.taken.start}–${entry.taken.end} 行（共 ${entry.size?.lines ?? "?"} 行）`,
        size: entry.size,
      });
    }
  }

  const inlined = brief.text.length + derivedChars + (page === null ? 0 : page.text.length);
  const summaryCoverage = opts.ledger?.hasManifest() ? opts.ledger.summary() : null;
  const pkg: ContextPackage = {
    schema_version: CONTEXT_PACKAGE_SCHEMA,
    package_id: `ctx-${projectId}-${crypto.randomBytes(6).toString("hex")}`,
    generated_at: nowIso(),
    project_id: projectId,
    design_revision: design.loaded?.revision.content_sha256 ?? null,
    plan_revision: plan.loaded?.revision.content_sha256 ?? null,
    plan_definition_digest: planDefinitionDigest,
    baseline,
    brief,
    tasks,
    sections,
    page,
    question,
    next_cursor,
    total: {
      sources: manifest.length,
      chars: inlined,
      full_chars: manifest.reduce((n, m) => n + (m.size?.chars ?? 0), 0),
    },
    source_manifest: manifest,
    token_or_char_size: inlined,
    omitted: [...omitted, ...(summaryCoverage?.omitted ?? [])],
    stale_reasons: stale,
    coverage: summaryCoverage,
  };

  PACKAGES.set(pkg.package_id, { pkg, project_id: projectId });
  while (PACKAGES.size > PACKAGES_MAX) {
    const oldest = PACKAGES.keys().next().value;
    if (oldest === undefined) break;
    PACKAGES.delete(oldest);
  }
  return pkg;
}

// ── 陈旧与增量重建 ──

export interface Invalidation {
  /** 变了的来源（路径 → 说明） */
  changed_sources: { path: string; detail: string }[];
  /** 重读了哪些来源 */
  rebuilt_sources: string[];
  /** 沿用了哪些来源（内容没变，不重读） */
  reused_sources: string[];
  /** 上层派生（任务定义 / 章节索引）是否整体沿用上一版（增量重建的真凭据） */
  derived_reused: boolean;
  /** 明确失效项：依赖任务（施工定义变化 / 设计修订变化） */
  invalidated_tasks: { task_id: string; reason: string; before: string; after: string }[];
  stale_reasons: string[];
}

/** 源变化检查（只读）：把包的来源清单与磁盘现状比一遍 */
export function packageStaleness(
  pkg: ContextPackage,
  projectId: string,
  dataDir?: string,
): { stale: boolean; stale_reasons: string[]; changed: { path: string; detail: string }[] } {
  const project = getProject(projectId, dataDir);
  if (!project) throw new ContextError("PROJECT_NOT_FOUND", `项目不存在: ${projectId}`, { project_id: projectId });
  const root = path.resolve(project.path);
  const changed: { path: string; detail: string }[] = [];
  for (const entry of pkg.source_manifest) {
    if (entry.kind === "baseline" || entry.kind === "task_state") continue; // 这两类按 id/seq 记，另有判据
    if (entry.content_sha256 === null) continue;
    const abs = resolveInRoot(root, entry.path);
    if (abs === null || !fs.existsSync(abs)) {
      changed.push({ path: entry.path, detail: "来源已消失" });
      continue;
    }
    const now = sha256(fs.readFileSync(abs, "utf8"));
    if (now !== entry.content_sha256) {
      changed.push({
        path: entry.path,
        detail: `${entry.content_sha256.slice(0, 8)} → ${now.slice(0, 8)}`,
      });
    }
  }
  return {
    stale: changed.length > 0,
    stale_reasons: changed.map((c) => `源内容变化：${c.path}（${c.detail}）`),
    changed,
  };
}

/**
 * 增量重建：源变化后**只重读变了的来源**，未变的沿用，并按影响范围给出失效项。
 * 返回新包（旧包仍在注册表里，历史可查）与失效清单。
 */
export function refreshContextPackage(
  packageId: string,
  projectId: string,
  opts: { dataDir?: string; question?: string | null; maxChars?: number } = {},
): { package: ContextPackage; invalidation: Invalidation; previous: ContextPackage } {
  const stored = PACKAGES.get(packageId);
  if (stored === undefined) {
    throw new ContextError("UNKNOWN_PACKAGE", `没有这个上下文包：${packageId}`, { package_id: packageId });
  }
  const previous = stored.pkg;
  const staleness = packageStaleness(previous, projectId, opts.dataDir);
  // 增量重建默认沿用上一版的提问（同一现场的重建，不因为少传参数就换一套"相关任务"口径）
  const question = opts.question === undefined ? previous.question : opts.question;
  const rebuilt = buildContextPackage(projectId, {
    ...(opts.dataDir === undefined ? {} : { dataDir: opts.dataDir }),
    question,
    ...(opts.maxChars === undefined ? {} : { maxChars: opts.maxChars }),
    previous,
  });

  const changedPaths = new Set(staleness.changed.map((c) => c.path));
  const derivedReused =
    previous.tasks.length > 0 &&
    previous.design_revision === rebuilt.design_revision &&
    previous.plan_revision === rebuilt.plan_revision &&
    previous.question === rebuilt.question;
  // 增量口径：只有"内容变了"的来源才算重建（重读并重新派生）；其余来源照旧沿用
  const rebuiltSources = rebuilt.source_manifest
    .filter((m) => changedPaths.has(m.path) || (m.kind === "baseline" && previous.baseline?.baseline_id !== m.content_sha256))
    .map((m) => m.path);
  const reusedSources = rebuilt.source_manifest
    .filter((m) => !rebuiltSources.includes(m.path))
    .map((m) => m.path);

  // 明确失效项：施工定义变化的卡（决策/接口变化 → 依赖任务收到明确失效项，§2.8）
  const before = new Map(previous.tasks.map((t) => [t.task_id, t]));
  const invalidated_tasks: Invalidation["invalidated_tasks"] = [];
  for (const t of rebuilt.tasks) {
    const prev = before.get(t.task_id);
    if (prev === undefined) continue;
    if (prev.definition_sha256 !== t.definition_sha256) {
      invalidated_tasks.push({
        task_id: t.task_id,
        reason: "施工定义变化：该任务待重绑到新定义修订（依赖方按影响范围处置）",
        before: prev.definition_sha256,
        after: t.definition_sha256,
      });
      continue;
    }
    if (prev.plan_revision !== t.plan_revision) {
      invalidated_tasks.push({
        task_id: t.task_id,
        reason: "施工图修订变化（定义内容未变）：状态绑定的修订号已过期",
        before: prev.plan_revision ?? "",
        after: t.plan_revision ?? "",
      });
    }
  }
  const designChanged =
    previous.design_revision !== rebuilt.design_revision && previous.design_revision !== null;
  if (designChanged) {
    for (const t of rebuilt.tasks) {
      if (invalidated_tasks.some((i) => i.task_id === t.task_id)) continue;
      invalidated_tasks.push({
        task_id: t.task_id,
        reason: "设计书修订变化：该任务的设计依据需要复核（未复核前不得当作同一版图纸施工）",
        before: previous.design_revision ?? "",
        after: rebuilt.design_revision ?? "",
      });
    }
  }

  const invalidation: Invalidation = {
    changed_sources: staleness.changed,
    rebuilt_sources: [...new Set(rebuiltSources)],
    reused_sources: [...new Set(reusedSources)],
    derived_reused: derivedReused,
    invalidated_tasks,
    stale_reasons: [...new Set([...staleness.stale_reasons, ...rebuilt.stale_reasons])],
  };
  return { package: rebuilt, invalidation, previous };
}

// ── 检查点 / 续接（模型被打断后由服务器接着数） ──

export type CheckpointReason = "tool_rounds_exhausted" | "interrupted" | "context_budget";

export interface ResumeCheckpoint {
  schema_version: 1;
  checkpoint_id: string;
  project_id: string;
  created_at: string;
  /** 产生它的上下文包（版本可查） */
  package_id: string;
  design_revision: string | null;
  plan_revision: string | null;
  reason: CheckpointReason;
  detail: string;
  /** 已确认来源：真读到过、带哈希与范围（下一轮不重读；版本对不上就作废） */
  confirmed_sources: LedgerSeed[];
  /** 还没读到的清单文件（续接任务） */
  pending_paths: string[];
  /** 续接位置：从哪个文件的哪一行/哪个游标接着读 */
  resume_position: {
    path: string;
    cursor: string | null;
    unit: CoverageUnit;
    start: number;
    detail: string;
  } | null;
}

export const checkpointPath = (projectId: string, dataDir?: string): string =>
  path.join(projectWorkDir(projectId, dataDir), RESUME_FILE);

/** 续读游标（新 `tcur1` 完整版本 或 旧 `tctx1` 短前缀）绑定的下一段起点（1 起）；解析不出为 null */
function cursorStartOf(cursor: string): number | null {
  const legacy = parseCursor(cursor);
  if (legacy !== null) return legacy.start;
  const modern = parseProjectCursor(cursor);
  return modern === null ? null : modern.start;
}

/** 从账本造检查点（只有真读到过的来源才进 confirmed_sources） */
export function buildResumeCheckpoint(
  pkg: ContextPackage,
  ledger: CoverageLedger,
  opts: { reason: CheckpointReason; detail: string },
): ResumeCheckpoint {
  const summary = ledger.hasManifest() ? ledger.summary() : null;
  const confirmed = ledger.confirmedSeeds();
  const unread = ledger.unread() ?? [];
  const partial = ledger
    .entriesOf()
    .find((e) => e.status === "partial" && e.resume_cursor !== null && unread.includes(e.path));
  const resume_position =
    partial !== undefined
      ? {
          path: partial.path,
          cursor: partial.resume_cursor,
          unit: "lines" as CoverageUnit,
          start: cursorStartOf(partial.resume_cursor ?? "") ?? 1,
          detail: `从 ${partial.path} 的游标处接着读（已取 ${partial.covered_chars} 字）`,
        }
      : pkg.next_cursor !== null && pkg.page !== null
        ? {
            path: pkg.page.path,
            cursor: pkg.next_cursor,
            unit: "lines" as CoverageUnit,
            start: cursorStartOf(pkg.next_cursor) ?? 1,
            detail: `继续取 ${pkg.page.path} 的下一段（本包只取到第 ${pkg.page.range.end} 行）`,
          }
        : unread.length > 0
          ? { path: unread[0], cursor: null, unit: "lines" as CoverageUnit, start: 1, detail: `从 ${unread[0]} 头开始读` }
          : null;
  return {
    schema_version: 1,
    checkpoint_id: `ckpt-${crypto.randomBytes(6).toString("hex")}`,
    project_id: pkg.project_id,
    created_at: nowIso(),
    package_id: pkg.package_id,
    design_revision: pkg.design_revision,
    plan_revision: pkg.plan_revision,
    reason: opts.reason,
    detail: opts.detail,
    confirmed_sources: confirmed,
    pending_paths: unread,
    resume_position,
  };
}

/** 落检查点（原子写；项目私有目录，失败不抛——它只是续接辅助，不该把一轮聊天搞挂） */
export function saveCheckpoint(projectId: string, checkpoint: ResumeCheckpoint, dataDir?: string): boolean {
  try {
    const file = checkpointPath(projectId, dataDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(checkpoint, null, 2) + "\n", "utf8");
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/** 读检查点（不存在/坏文件都返回 null：坏文件不当成"没有中断"，只是不续接） */
export function loadCheckpoint(projectId: string, dataDir?: string): ResumeCheckpoint | null {
  try {
    const file = checkpointPath(projectId, dataDir);
    if (!fs.existsSync(file)) return null;
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as ResumeCheckpoint;
    if (raw.schema_version !== 1 || typeof raw.checkpoint_id !== "string") return null;
    return raw;
  } catch {
    return null;
  }
}

/** 清检查点（一轮跑完 = 中断现场已消化） */
export function clearCheckpoint(projectId: string, dataDir?: string): void {
  try {
    const file = checkpointPath(projectId, dataDir);
    if (fs.existsSync(file)) fs.rmSync(file);
  } catch {
    /* 删不掉也不阻断 */
  }
}

export interface ResumeResolution {
  /** 可用的已确认来源（版本仍对得上的） */
  confirmed_sources: LedgerSeed[];
  /** 已变质的已确认来源（旧哈希对不上 → 必须重读，不得沿用） */
  source_changed: { path: string; was: string; now: string }[];
  /** 给模型的续接指令（服务器注入，不依赖模型自觉） */
  text: string;
  resume_position: ResumeCheckpoint["resume_position"];
}

/**
 * 把检查点解析成**下一轮的开场指令**：已确认来源不重读、续接位置明说、
 * 版本对不上的来源明确作废（SOURCE_CHANGED 口径）。
 */
export function resolveCheckpoint(
  checkpoint: ResumeCheckpoint,
  projectId: string,
  dataDir?: string,
): ResumeResolution {
  const project = getProject(projectId, dataDir);
  if (!project) throw new ContextError("PROJECT_NOT_FOUND", `项目不存在: ${projectId}`, { project_id: projectId });
  const root = path.resolve(project.path);
  const confirmed: LedgerSeed[] = [];
  const source_changed: { path: string; was: string; now: string }[] = [];
  for (const s of checkpoint.confirmed_sources) {
    const abs = resolveInRoot(root, s.path);
    if (abs === null || !fs.existsSync(abs)) {
      source_changed.push({ path: s.path, was: s.content_sha256, now: "(已消失)" });
      continue;
    }
    const now = sha256(fs.readFileSync(abs, "utf8"));
    if (now !== s.content_sha256) {
      source_changed.push({ path: s.path, was: s.content_sha256, now });
      continue;
    }
    confirmed.push(s);
  }
  const lines: string[] = [
    "（上一轮被中断，服务器保留的现场如下——请从这里接着干，不要重头再来）",
    `中断原因：${checkpoint.reason}（${checkpoint.detail}）`,
  ];
  if (confirmed.length > 0) {
    lines.push(`已确认来源（内容哈希未变，**不要重读**）：${confirmed.map((c) => c.path).join("、")}`);
  }
  if (source_changed.length > 0) {
    lines.push(
      `已失效来源（SOURCE_CHANGED，必须重读，别沿用旧内容）：` +
        source_changed.map((c) => `${c.path}（${c.was.slice(0, 8)} → ${c.now.slice(0, 8)}）`).join("、"),
    );
  }
  if (checkpoint.pending_paths.length > 0) {
    const shown = checkpoint.pending_paths.slice(0, 40);
    lines.push(
      `还没读到（${checkpoint.pending_paths.length} 个）：${shown.join("、")}` +
        (checkpoint.pending_paths.length > shown.length ? " …" : ""),
    );
  }
  if (checkpoint.resume_position !== null) {
    const cur = checkpoint.resume_position.cursor;
    // 新格式 `tcur1` 完整版本游标由 read_design/read_plan 消费（read_file 只认旧 `tctx1`）——指对工具，别指错路。
    const howto =
      cur === null
        ? ""
        : parseProjectCursor(cur) !== null
          ? `（下次用 read_design/read_plan 直接带 cursor=${cur}）`
          : `（下次 read_file 直接带 cursor=${cur}）`;
    lines.push(`续接位置：${checkpoint.resume_position.detail}${howto}`);
  }
  return { confirmed_sources: confirmed, source_changed, text: lines.join("\n"), resume_position: checkpoint.resume_position };
}
