// 两份图纸的版本与审定（PLAN.md V06-02，DESIGN.md §2.6 / §2.9 / §3.5）。
//
// 本模块回答四件事：
//   ① **唯一当前源**：每份角色文档（设计书 / 施工图）在任一时刻只有一个当前源。
//      塔台自身固定为 repo 根 `DESIGN.md` + `PLAN.md`；其他项目缺省 `.工作台/design.md` + `.工作台/plan.md`，
//      也允许注册表里登记的**项目根内相对路径**（`design_path` / `plan_path`）。
//      越出项目根（`../`、绝对路径、软链/联接点逃逸）一律拒绝——路径只从注册表取，不接受调用方传路径。
//   ② 读原文、算哈希、建章节索引（内容哈希 = 原文逐字节；定义哈希 = 设计正文 `designDefinitionText()`，
//      施工图取 `planValidate.definitionHashOf()`——§2.9：定义哈希不含派生状态与执行日志）。
//   ③ 两个修订之间的**章节差异**（按标题路径比对，不按行号猜）。
//   ④ **不可变历史 + 双版本激活**：`design-revisions/<内容 sha256>.md`；
//      `plan-revisions/<定义 sha256>.md` 是 §2.6 的主名，施工图**同一定义哈希下的另一份正文**
//      另存为 `plan-revisions/<内容 sha256>.md`——施工定义哈希只覆盖定义的投影、正文可独立变化
//      （例如只增补卡定义之外的体例说明、改状态列、勾选卡面检查项），主名被上一份正文占用时
//      新正文既不覆盖旧对象、也不被误判成"篡改"（对象名与判据见 `revisionObjectCandidates`）；
//      基线记录只追加地写 `.工作台/baselines.jsonl`，激活前逐条校验既有记录与新引用的修订。
//
// **记录性改动 ≠ 篡改（缺陷 f-37f129d510c94de3 的口径）**：施工图的**记录性**改动（勾选卡面
// `- [ ]` → `- [x]`、改状态列、文末备注……）只前进**内容**哈希、不动**定义**哈希，这时重激活
// 基线**不得**报"历史对象已被改动"——这不是篡改，是"同一定义哈希下的另一份正文"：新正文按内容
// 哈希另存一个不可变对象，旧对象一个字节都不动，基线因为内容哈希变了而**新追加一条**
// （见 `activateBaseline`／`targetObjectOf`）。反过来，真·篡改（同名副本的字节既不是它记录的
// 旧正文、也不是当前正文：重算定义哈希对不上名字、或该对象被某条基线引用而字节与记录不符）
// 仍然拒绝，但错误文案必须把这层区分说清（见 `tamperedObject`／`readRevisionObject`），
// 不能把"内容前进"误报成"被改动"。
//
// 审定口径（DESIGN.md §2.9，硬红线）：
//   审定来源可以是用户确认，也可以是用户已委派的 GPT-6 设计职责；后者**如实标为技术审定**
//   （`approved_by` = 设计角色、`approval_kind = delegated_technical_review`），
//   **不伪造用户 Gate**——本模块从不往 `gate.jsonl` 写一个字节，`approved_by=user` 只允许
//   `approval_kind=user_confirmed`，反之亦然。
//
// 恢复口径（DESIGN.md §2.6）：
//   基线必须能取回**确切原文**。已在 Git 里可长期取回的对象（blob 取回字节与原文逐字节相同）
//   直接引用 `git:<oid>`；未提交或不在 Git 的写不可变副本并校验哈希。历史对象不接受编辑：
//   副本内容与哈希对不上时**拒绝当作该修订**（报 `revision_object_tampered`），不静默采用。
//   注意 Git 快速通道的判据是**逐字节相同**，不是"这个文件在库里"：`core.autocrlf` 把工作区留成
//   CRLF、把库内 blob 存成 LF 时，两者不是同一份原文，快速通道**必须**让路去落不可变副本
//   （详见 `gitBlobRef`）——那种机器上不可变副本才是真正生效的保全程，不是"兜底"。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { getProject } from "../registry";
import { nowIso } from "../time";
import { withFileLock } from "../fileLock";
import { appendJsonlLine } from "../lineStream";
import { WorkError } from "./types";
import { memoizedForDerivation } from "./derivationScope";
import { assertPlanTasksValid, definitionHashOf, parsePlanTable, validatePlanTasks, type PlanTask } from "./planValidate";

/** `.工作台/` 目录名（`workstation.ts` 从这里取，保证全仓只此一处定义） */
export const WORKBENCH_DIRNAME = ".工作台";

export const DESIGN_REVISIONS_DIR = "design-revisions";
export const PLAN_REVISIONS_DIR = "plan-revisions";
export const BASELINES_FILE = "baselines.jsonl";

/** 其他项目的缺省源（DESIGN.md §2.9：登记时选择根目录内的现有文档，缺省这两份） */
export const DEFAULT_DESIGN_REL = `${WORKBENCH_DIRNAME}/design.md`;
export const DEFAULT_PLAN_REL = `${WORKBENCH_DIRNAME}/plan.md`;
/** 塔台自身固定源（AGENTS.md §7：设计事实源是 repo 根 DESIGN.md，施工源是根 PLAN.md） */
export const TATAI_DESIGN_REL = "DESIGN.md";
export const TATAI_PLAN_REL = "PLAN.md";

/** 塔台待议区标题（与其他项目无关；只用于切"设计定义"与"待议历史"） */
const APPENDIX_B_HEADING = "## 附录 B：待议记录";

export type DocumentKind = "design" | "plan";

export const DOCUMENT_KINDS: readonly DocumentKind[] = ["design", "plan"];

/** 源从哪来：塔台自身固定源 / 注册表登记的相对路径 / 缺省口径 */
export type DocumentOrigin = "tatai_root" | "registered" | "default";

export interface DocumentSource {
  kind: DocumentKind;
  origin: DocumentOrigin;
  /** 项目根内相对路径（POSIX 分隔符）——对外只用它，绝不外发本机绝对路径 */
  rel_path: string;
  /** 本机绝对路径（排错用；HTTP 层不外发） */
  abs_path: string;
  project_root: string;
}

/** 章节索引一条（标题路径 + 行范围 + 该节正文逐字节哈希） */
export interface DocumentSection {
  level: number;
  title: string;
  /** 祖先标题 / 本节标题（`A / B`），差异比对按它认同一节 */
  path: string;
  line_start: number;
  line_end: number;
  sha256: string;
}

/** 不可变恢复位置：git blob 引用或本仓不可变副本 */
export interface DocumentRecovery {
  kind: "git_blob" | "immutable_copy";
  /** 恢复位置：`git:<oid>` 或项目根内相对路径 */
  ref: string;
  /**
   * 文件名/对象键用的哈希：设计＝内容哈希；施工＝定义哈希（§2.6 的主名），
   * 同一定义哈希下的**另一份正文**则为该正文的内容哈希（见 `revisionObjectCandidates`）。
   */
  key: string;
  /** 该恢复位置取回的字节的 sha256（独立校验位，串了/被改了就对不上） */
  sha256: string;
}

export interface DocumentRevision {
  kind: DocumentKind;
  /** 项目根内相对路径（当时的唯一当前源） */
  source_path: string;
  origin: DocumentOrigin;
  /** 原文逐字节 sha256 */
  content_sha256: string;
  /** 定义哈希（设计 = 正文，不含待议区；施工 = 卡号/交付目标/依赖/完成证据，不含状态等派生内容） */
  definition_sha256: string;
  bytes: number;
  lines: number;
  sections: DocumentSection[];
  /** 已经保存过不可变历史/可长期取回的 Git 对象时非空；否则 null（= 还没保住） */
  recovery: DocumentRecovery | null;
}

/** 基线里引用的紧凑修订形态（不含章节索引：基线只引用哈希与恢复位置，DESIGN.md §2.6） */
export interface DocumentRevisionRef {
  kind: DocumentKind;
  source_path: string;
  content_sha256: string;
  definition_sha256: string;
  recovery: DocumentRecovery;
}

export type BaselineApprovalKind = "user_confirmed" | "delegated_technical_review";

/** 成套图纸的生效基线（DESIGN.md §2.9 六字段 + 两个如实标注用的补充字段） */
export interface ProjectBaseline {
  baseline_id: string;
  design_revision: DocumentRevisionRef;
  plan_revision: DocumentRevisionRef;
  /** 审定者：用户确认时为 `user`；技术审定时为设计角色标识（如 `gpt-6`），不写 `user` */
  approved_by: string;
  /** 审定依据（自由文本；必填——无审定依据不能激活） */
  approval_basis: string;
  /** 审定种类（机器可判：用户确认 vs 用户已委派的技术审定；防"技术审定记成用户 Gate"） */
  approval_kind: BaselineApprovalKind;
  active_at: string;
  /** 被本基线取代的上一条 baseline_id（首条为 null）；旧记录留在文件里不删不改 */
  supersedes: string | null;
}

/** 读一份图纸的结果：源、修订、原文、解析出的任务行（plan 专用） */
export interface LoadedDocument {
  source: DocumentSource;
  revision: DocumentRevision;
  text: string;
  /** plan：解析出的任务行（**未**做结构校验；校验由 `assertPlanTasksValid` 显式调用） */
  tasks: PlanTask[];
  /** plan：原文里有没有合格表（没有 = 连任务行都取不到） */
  table_found: boolean;
}

// ── 路径：唯一当前源 ──

const POSIX_REL_RE = /^[A-Za-z]:[\\/]|^\\\\|^\//;

function badSource(
  kind: DocumentKind,
  value: string,
  reason: string,
  extra: Record<string, unknown> = {},
): never {
  const why: Record<string, string> = {
    absolute_path: "登记的是绝对路径",
    parent_traversal: "路径里有 `..` 段",
    outside_project_root: "解析后不在项目根内",
    symlink_escape: "经软链/联接点解析后落在项目根外",
    empty: "登记的是空串",
  };
  throw new WorkError(
    "INVALID_COMMAND",
    `图纸源路径不合法（kind=${kind}）：${JSON.stringify(value)} —— ${why[reason] ?? reason}。` +
      "图纸源只接受**项目根内相对路径**，路径穿越、绝对路径与软链逃逸一律拒绝（DESIGN.md §2.9）",
    { kind, value, reason, ...extra },
  );
}

/** realpath；读不到返回 null（不猜、不自己拼） */
function realpathOrNull(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/** 从 p 起往上找第一个真实存在的祖先（文件可能还没建；路径上的软链仍要判） */
function nearestExisting(p: string): string {
  let cur = path.resolve(p);
  for (let i = 0; i < 64; i++) {
    if (fs.existsSync(cur)) return cur;
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return cur;
}

/** 项目根内相对路径被判不合法的原因（措辞表见 `badSource`） */
export type ProjectRelativeReason =
  | "empty"
  | "absolute_path"
  | "parent_traversal"
  | "outside_project_root"
  | "symlink_escape";

export type ProjectRelativeResolution =
  | { ok: true; abs: string; rel_path: string }
  | { ok: false; reason: ProjectRelativeReason };

/**
 * 项目根内相对路径的安全解析（DESIGN.md §2.9 口径的**唯一实现**）：
 * 拒绝空串、绝对路径、`..` 段、解析后越出项目根、经软链/联接点逃逸。
 * 不抛错——由调用方按自己的口径报（图纸源抛 `badSource`，项目级运行配置如实记一条拒绝理由）；
 * 同一份判据只此一处实现，调用方各自再写一遍必然漂移。
 */
export function resolveProjectRelative(root: string, raw: string): ProjectRelativeResolution {
  const value = raw.trim();
  if (value === "") return { ok: false, reason: "empty" };
  if (POSIX_REL_RE.test(value) || path.isAbsolute(value)) return { ok: false, reason: "absolute_path" };
  const unix = value.replace(/\\/g, "/");
  if (unix.split("/").some((seg) => seg === "..")) return { ok: false, reason: "parent_traversal" };
  const abs = path.resolve(root, unix);
  const back = path.relative(root, abs);
  if (back === "" || back.startsWith("..") || path.isAbsolute(back)) {
    return { ok: false, reason: "outside_project_root" };
  }
  // 软链/联接点逃逸：解析"最深的已存在祖先"的真实路径，必须仍在项目根真实路径内
  const realRoot = realpathOrNull(root) ?? root;
  const realAncestor = realpathOrNull(nearestExisting(abs));
  if (realAncestor !== null && relBackOutside(path.relative(realRoot, realAncestor))) {
    return { ok: false, reason: "symlink_escape" };
  }
  return { ok: true, abs, rel_path: back.split(path.sep).join("/") };
}

/**
 * 登记的相对路径校验（拒绝 `../`、绝对路径、越出项目根、软链/联接点逃逸）。
 * 校验通过返回解析后的绝对路径。
 */
function resolveRegisteredPath(
  root: string,
  kind: DocumentKind,
  raw: string,
  extra: Record<string, unknown> = {},
): string {
  const resolution = resolveProjectRelative(root, raw);
  if (!resolution.ok) badSource(kind, raw, resolution.reason, extra);
  return resolution.abs;
}

function relBackOutside(rel: string): boolean {
  return rel !== "" && (rel.startsWith("..") || path.isAbsolute(rel));
}

/**
 * 解析一份图纸的**唯一当前源**（DESIGN.md §2.9）。
 * 塔台自身固定 repo 根 DESIGN.md / PLAN.md（登记字段对塔台不生效——"固定"就是不接受覆盖）；
 * 其他项目按注册表登记的项目根内相对路径，缺省 `.工作台/design.md` / `.工作台/plan.md`。
 */
export function resolveDocumentSource(
  projectId: string,
  kind: DocumentKind,
  dataDir?: string,
): DocumentSource {
  const project = getProject(projectId, dataDir);
  if (!project) {
    throw new WorkError("INVALID_COMMAND", `项目不存在: ${projectId}`, { project_id: projectId });
  }
  const root = path.resolve(project.path);
  const isTatai = project.self_managed === true || project.id === "tatai";
  if (isTatai) {
    const rel = kind === "design" ? TATAI_DESIGN_REL : TATAI_PLAN_REL;
    return {
      kind,
      origin: "tatai_root",
      rel_path: rel,
      abs_path: path.join(root, rel),
      project_root: root,
    };
  }
  const registered = (kind === "design" ? project.design_path : project.plan_path)?.trim() ?? "";
  if (registered !== "") {
    const abs = resolveRegisteredPath(root, kind, registered, { project_id: projectId });
    return {
      kind,
      origin: "registered",
      rel_path: path.relative(root, abs).split(path.sep).join("/"),
      abs_path: abs,
      project_root: root,
    };
  }
  const rel = kind === "design" ? DEFAULT_DESIGN_REL : DEFAULT_PLAN_REL;
  const abs = path.resolve(root, rel);
  return { kind, origin: "default", rel_path: rel, abs_path: abs, project_root: root };
}

/** `.工作台/` 目录（路径只从注册表取；`workstationDir` 同一口径） */
export function projectWorkbenchDir(projectId: string, dataDir?: string): string {
  return path.join(resolveDocumentSource(projectId, "design", dataDir).project_root, WORKBENCH_DIRNAME);
}

// ── 读原文 / 哈希 / 章节索引 ──

export const sha256Hex = (data: string | Buffer): string =>
  crypto.createHash("sha256").update(data).digest("hex");

/**
 * 施工定义哈希取哪一段：
 *   · design：塔台待议区（`## 附录 B：待议记录`）之前的正文。待议记录只追加、且是待议历史
 *     （§3.5），补一条待议不该让成套图纸的基线作废；其他项目没有该区，定义哈希 = 内容哈希。
 *   · plan：卡号 / 交付目标 / 依赖 / 完成证据（见 planValidate.definitionHashOf），
 *     不含"状态"列一类派生内容（§2.9：定义哈希不含派生状态、更新时间和执行日志）。
 */
export function designDefinitionText(text: string): string {
  const at = text.indexOf(APPENDIX_B_HEADING);
  return at === -1 ? text : text.slice(0, at);
}

/** 章节索引：按标题行切段（前导的"第一个标题之前"正文算一节 level 0） */
export function buildSectionIndex(text: string): DocumentSection[] {
  const lines = text.split(/\r?\n/);
  type Open = { level: number; title: string; start: number; line: number };
  const opens: Open[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(#{1,6})\s+(.*\S)\s*$/.exec(lines[i]);
    if (m) opens.push({ level: m[1].length, title: m[2].trim(), start: i, line: i + 1 });
  }
  const out: DocumentSection[] = [];
  const stack: Open[] = [];
  for (let i = 0; i < opens.length; i++) {
    const open = opens[i];
    const end = i + 1 < opens.length ? opens[i + 1].line - 1 : lines.length;
    while (stack.length > 0 && stack[stack.length - 1].level >= open.level) stack.pop();
    const path_ = [...stack.map((o) => o.title), open.title].join(" / ");
    const body = lines.slice(open.start, end).join("\n");
    out.push({
      level: open.level,
      title: open.title,
      path: path_,
      line_start: open.line,
      line_end: end,
      sha256: sha256Hex(body),
    });
    stack.push(open);
  }
  // 第一个标题之前的正文（前言）也算一节：它同样属于设计/施工定义
  const headEnd = opens.length > 0 ? opens[0].line - 1 : lines.length;
  if (headEnd > 0 && lines.slice(0, headEnd).join("").trim() !== "") {
    const body = lines.slice(0, headEnd).join("\n");
    out.unshift({
      level: 0,
      title: "(前言)",
      path: "(前言)",
      line_start: 1,
      line_end: headEnd,
      sha256: sha256Hex(body),
    });
  }
  return out;
}

// ── 分段读（V07-04：read_design 的 section/range；切出来的片段拼回去必须与全文逐字节一致） ──

/**
 * 行起始偏移表：按 `\n` 切（行尾的 `\r` 留在行内），第 i 行（0 基）的起点字符偏移。
 *
 * 为什么不复用 `buildSectionIndex` 里那份按行数组 join 的正文：那种切法会把 CRLF 归一成 LF
 * （章节哈希要的是"同一节内容同一指纹"，归一是有意的）。分段读要的是**逐字节**原文，
 * 所以按字符偏移切片——切出来的片段首尾相接，拼回去就是原文件那一串字节。
 */
function lineStartsOf(text: string): { starts: number[]; lineCount: number } {
  const lines = text.split("\n");
  const starts: number[] = new Array(lines.length);
  let acc = 0;
  for (let i = 0; i < lines.length; i++) {
    starts[i] = acc;
    acc += lines[i].length + 1; // +1 = 吃掉紧随其后的 '\n'
  }
  return { starts, lineCount: lines.length };
}

export interface DocumentSlice {
  /** 切片的行范围（1 基，闭区间；末行含它自己的换行符，便于首尾相接） */
  line_start: number;
  line_end: number;
  /** 原文切片（逐字节）；按行序把各段拼起来 == 全文 */
  content: string;
  /** 切片内容的 sha256（调用方按它核对"拼接后与全文一致"） */
  sha256: string;
  /** 命中的章节（按行范围切时为 null） */
  section: DocumentSection | null;
}

/** 按行范围切片（1 基闭区间）。越界/倒序一律抛——分段读不接受"猜个大概" */
export function sliceDocumentLines(text: string, fromLine: number, toLine: number): DocumentSlice {
  const { starts, lineCount } = lineStartsOf(text);
  const bad = (why: string): never => {
    throw new WorkError("INVALID_COMMAND", `分段读的行范围不合法：${why}（文档共 ${lineCount} 行）`, {
      from_line: fromLine,
      to_line: toLine,
      lines: lineCount,
    });
  };
  if (!Number.isInteger(fromLine) || !Number.isInteger(toLine)) bad("行号必须是整数");
  if (fromLine < 1) bad(`起始行 ${fromLine} 小于 1`);
  if (toLine > lineCount) bad(`结束行 ${toLine} 超过文档末行`);
  if (fromLine > toLine) bad("起始行大于结束行");
  const content = text.slice(starts[fromLine - 1], toLine >= lineCount ? text.length : starts[toLine]);
  return { line_start: fromLine, line_end: toLine, content, sha256: sha256Hex(content), section: null };
}

/**
 * 按章节标题或章节路径切片（与 `buildSectionIndex` 同一份切段口径）。
 * 命中不了抛错并把候选章节点名带出——接手 agent 不必先猜标题再试。
 */
export function sliceDocumentSection(text: string, selector: string): DocumentSlice {
  const wanted = selector.trim();
  const sections = buildSectionIndex(text);
  const hit = sections.filter((s) => s.title === wanted || s.path === wanted);
  if (hit.length === 0) {
    throw new WorkError("INVALID_COMMAND", `设计/施工图里没有章节 ${JSON.stringify(selector)}（按标题或路径精确匹配）`, {
      selector,
      sections: sections.map((s) => s.path),
    });
  }
  if (hit.length > 1) {
    throw new WorkError(
      "INVALID_COMMAND",
      `章节标题 ${JSON.stringify(selector)} 在文档里出现 ${hit.length} 次（同级同名标题），无法确定读哪一节——请改用 range 行范围`,
      { selector, matches: hit.map((s) => ({ path: s.path, line_start: s.line_start, line_end: s.line_end })) },
    );
  }
  const section = hit[0];
  const sliced = sliceDocumentLines(text, section.line_start, section.line_end);
  return { ...sliced, section };
}

// ── 不可变历史与 Git 引用 ──

const REVISIONS_DIR_OF: Record<DocumentKind, string> = {
  design: DESIGN_REVISIONS_DIR,
  plan: PLAN_REVISIONS_DIR,
};

/** 不可变副本的项目根内相对路径（设计按内容哈希、施工按定义哈希，DESIGN.md §2.6） */
export function revisionObjectRel(kind: DocumentKind, keyHash: string): string {
  return `${WORKBENCH_DIRNAME}/${REVISIONS_DIR_OF[kind]}/${keyHash}.md`;
}

/**
 * 按**哈希**取不可变历史快照的原文；读不到/读不动一律返回 null。
 *
 * 两个来源，按序取（**同一份判据**，不猜）：
 *   ① 盘上不可变副本 `*-revisions/<hash>.md`（`immutable_copy`）；
 *   ② 基线流水里该哈希对应的 `git:<oid>` 恢复位置（`git_blob`，DESIGN.md §2.6「已在 Git 里可长期
 *      取回就直接引用」——`preserveRevision` 命中 Git 快速通道时**不落副本**，盘上因此没有文件。
 *      只按文件名读就会漏：真机现场塔台本项目现行基线的两条 plan 修订即如此）。blob 取回字节的
 *      sha256 必须等于该哈希，对不上/对象不在 = null（宁严不松）。
 *
 * 与 `textOfRevision` 的差别（2026-09-27，投影层分段失效复核要它）：`textOfRevision` 是
 * 差异对比路径的私有函数，找不到就抛（差异对比不拿近似比较）；本函数是**读侧复核**的
 * 最小读取——找不到快照不是错误，调用方据此**回退整份比对**（宁严不松），所以返回 null 不抛。
 * **只读**：读不可变副本 / 直读 Git 对象（不经 shell、不写盘、**不扫描 Git 历史**），不碰当前源。
 */
export function readRevisionSnapshotText(
  projectId: string,
  kind: DocumentKind,
  hash: string,
  dataDir?: string,
): string | null {
  const abs = revisionSnapshotAbs(projectId, kind, hash, dataDir);
  if (abs !== null) {
    const text = readSnapshotTextCached(abs);
    if (text !== null) return text;
  }
  return readGitSnapshotText(projectId, kind, hash, dataDir);
}

/**
 * 基线流水里按**内容哈希**记下的 `git:<oid>` 恢复位置（只查**本项目**自己的流水，有界）。
 *
 * 判据＝恢复记录写的 `sha256`（＝ 该字节流的逐字节 sha256）等于要取的哈希，且 `kind` 相符、
 * `recovery.kind === "git_blob"`。只在**盘上副本读不到**时才被调用（绝大多数修订有副本），
 * 所以这里的"扫一遍基线流水"是廉价路径；仍按 `projectId` 隔离——同哈希必同内容，但
 * "哪条流水记了它、记在哪"是本项目的事实，绝不拿别的项目的恢复位置顶替。
 */
function gitRecoveryBySha256(
  projectId: string,
  kind: DocumentKind,
  sha256: string,
  dataDir?: string,
): DocumentRecovery | null {
  if (sha256 === "") return null;
  return memoizedForDerivation(
    "documents:git-recovery",
    `${projectId}\u0000${dataDir ?? ""}\u0000${kind}\u0000${sha256}`,
    () => {
      let log: BaselineLog;
      try {
        log = readBaselineLog(projectId, dataDir);
      } catch {
        return null;
      }
      for (let i = log.baselines.length - 1; i >= 0; i--) {
        const b = log.baselines[i];
        for (const ref of [b.design_revision, b.plan_revision]) {
          if (ref.kind !== kind) continue;
          if (ref.recovery.kind !== "git_blob") continue;
          if (ref.content_sha256 !== sha256 || ref.recovery.sha256 !== sha256) continue;
          return ref.recovery;
        }
      }
      return null;
    },
  );
}

/** `git:<oid>` 里的 oid；形状不对 = 不认（绝**不把哈希名直接当路径**用） */
function gitOidOf(ref: DocumentRecovery): string | null {
  const oid = ref.ref.startsWith("git:") ? ref.ref.slice("git:".length) : "";
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid) ? oid : null;
}

/**
 * 按内容哈希从基线流水找回 `git:<oid>` 并直读原文（`git cat-file`，**不经 shell**）。
 * 取回字节的 sha256 必须等于记录哈希，否则 = null；对象不在/读不动 = null（fail-closed，不猜）。
 */
function readGitSnapshotText(
  projectId: string,
  kind: DocumentKind,
  sha256: string,
  dataDir?: string,
): string | null {
  const rec = gitRecoveryBySha256(projectId, kind, sha256, dataDir);
  if (rec === null) return null;
  const oid = gitOidOf(rec);
  if (oid === null) return null;
  const root = resolveDocumentSource(projectId, kind, dataDir).project_root;
  return memoizedForDerivation("documents:git-blob-text", `${root}\u0000${oid}\u0000${rec.sha256}`, () => {
    let out: Buffer;
    try {
      out = Buffer.from(
        execFileSync("git", ["-C", root, "cat-file", "blob", oid], {
          maxBuffer: 64 * 1024 * 1024,
          timeout: 5000,
          stdio: ["ignore", "pipe", "ignore"],
        }),
      );
    } catch {
      return null;
    }
    return sha256Hex(out) === rec.sha256 ? out.toString("utf8") : null;
  });
}

/** 快照对象正文的只读读法（**按绝对路径**在「一次派生」内复用；见 `derivationScope`）。 */
function readSnapshotTextCached(abs: string): string | null {
  return memoizedForDerivation("documents:snapshot-text", abs, () => {
    try {
      if (!fs.existsSync(abs)) return null;
      return fs.readFileSync(abs, "utf8");
    } catch {
      return null;
    }
  });
}

/**
 * 快照对象正文 + 其**解码后文本的内容哈希**（同一遍读算出，一起在「一次派生」内复用）。
 *
 * 供 `planContentSnapshotIndex` 这类"逐候选读原文并核内容哈希"的解析器用：候选名常常是同一批
 * （同一定义哈希下的多份正文），此前每个候选、每次调用都要重读 466 KB 并重算 sha256——现场一次
 * 派生里同一份对象被读+核哈希 944 次。这里把"读到的正文"和"它的哈希"绑定成一次计算，派生内复用。
 *
 * **哈希输入是 UTF-8 解码后的文本**（`sha256Hex(text)`）——这正是旧 `planContentSnapshotIndex.read`
 * 的判据（它先 `readRevisionSnapshotText` 拿到文本、再 `sha256Hex(text)`），逐字保留。需要**原始字节**
 * 摘要的调用方（不可变副本内容核对）用下面的 `readSnapshotRawShaCached`，不要用这个。
 */
function readSnapshotTextAndShaCached(abs: string): { text: string; sha256: string } | null {
  return memoizedForDerivation("documents:snapshot-text-sha", abs, () => {
    const text = readSnapshotTextCached(abs);
    return text === null ? null : { text, sha256: sha256Hex(text) };
  });
}

/**
 * 快照对象**盘上原始字节**的 sha256（按绝对路径在「一次派生」内复用）。
 *
 * 与 `readSnapshotTextAndShaCached` 的唯一区别是**哈希的输入**：这里哈希未解码的 `Buffer`。旧
 * `existingRecovery` 就是 `sha256Hex(fs.readFileSync(abs))`，判据必须逐字保留——先解成 UTF-8 再哈希，
 * 会让"非法字节被替换字符吞掉"的篡改蒙混过关（真实反例见
 * `E/runtime-final/ROOT-RAW-BYTE-ACTUAL.json`：同一段文本的合法字节与非法字节解码相同、文本哈希相同）。
 * 因此不改 `readFileSync` 的 try 语义：读失败照旧抛出（判据与旧实现一致），缺文件由调用方先 `existsSync`。
 */
function readSnapshotRawShaCached(abs: string): string {
  return memoizedForDerivation("documents:snapshot-raw-sha", abs, () =>
    sha256Hex(fs.readFileSync(abs)),
  );
}

/**
 * 该修订的不可变快照**取不取得到**（只读；**不读正文**——给带解析缓存的读侧复核做"还在不在"的
 * 廉价前置判断：缓存过的快照也要每次确认来源仍在，否则删掉快照不会回退整份比对）。
 *
 * 两个来源都要认：盘上副本存在，或基线流水的 Git 对象可读且内容哈希吻合。
 * Git 原始对象文件仍可能损坏；读取与哈希核验在每次派生内复用，不仅检查对象路径是否存在。
 */
export function revisionSnapshotExists(
  projectId: string,
  kind: DocumentKind,
  hash: string,
  dataDir?: string,
): boolean {
  const abs = revisionSnapshotAbs(projectId, kind, hash, dataDir);
  if (abs !== null) {
    try {
      if (fs.existsSync(abs)) return true;
    } catch {
      // 盘上路径不可判：落到 Git 来源继续判（不因此放行）
    }
  }
  const rec = gitRecoveryBySha256(projectId, kind, hash, dataDir);
  if (rec === null) return false;
  // 仅 cat-file -e 不能发现对象文件在原路径被篡改；暖缓存复用前也核实际内容哈希。
  return readGitSnapshotText(projectId, kind, hash, dataDir) !== null;
}

/** 快照绝对路径（空哈希 → null）；只拼路径，不碰盘 */
function revisionSnapshotAbs(
  projectId: string,
  kind: DocumentKind,
  hash: string,
  dataDir?: string,
): string | null {
  if (hash === "") return null;
  const root = resolveDocumentSource(projectId, kind, dataDir).project_root;
  return path.join(root, revisionObjectRel(kind, hash));
}

/** 该修订在不可变历史里的**主**键哈希（设计＝内容哈希；施工＝定义哈希，DESIGN.md §2.6） */
function keyHashOf(kind: DocumentKind, revision: Pick<DocumentRevision, "content_sha256" | "definition_sha256">): string {
  return kind === "design" ? revision.content_sha256 : revision.definition_sha256;
}

/**
 * 这份修订的不可变对象**候选名**（按优先级），每项带它自己的对象键哈希。
 *
 *   ① 主名 `<keyHash>.md`：设计＝内容哈希、施工＝定义哈希（§2.6 的落点）。
 *   ② 施工图专用 `<content_sha256>.md`：**同一定义哈希下的另一份正文**。
 *      施工定义哈希只覆盖卡号/交付目标/依赖/完成证据（§2.9），正文可以在这之外独立变化
 *      ——**记录性改动**（勾选卡面检查项、改状态列、文末备注）走的就是这条：内容哈希变了、
 *      定义哈希没变（缺陷 f-37f129d510c94de3 的现场）。施工图的对象名若是定义哈希，
 *      两份正文就会抢同一个文件名：新正文既不能覆盖旧对象（历史对象不接受编辑），
 *      也不该被当成"旧对象被改过"。内容哈希是逐字节同一性，拿它当第二份正文的对象名，
 *      两份正文各有各的不可变对象，互不影响。
 *   设计书没有这一档：它的对象名本来就是内容哈希，同名不同内容只能是篡改。
 */
function revisionObjectCandidates(
  kind: DocumentKind,
  revision: Pick<DocumentRevision, "content_sha256" | "definition_sha256">,
): { rel: string; key: string }[] {
  const key = keyHashOf(kind, revision);
  const primary = { rel: revisionObjectRel(kind, key), key };
  if (kind === "design" || revision.content_sha256 === key) return [primary];
  return [primary, { rel: revisionObjectRel(kind, revision.content_sha256), key: revision.content_sha256 }];
}

/**
 * 施工图「**内容哈希** → 不可变快照对象」的读侧解析器（有限集合、有据可核）。
 *
 * 为什么需要它（V09-45…V09-50 真机现场）：施工图不可变对象的**主名是定义哈希**（DESIGN.md §2.6），
 * 同一定义哈希下的**另一份正文**才按内容哈希另存（§2.9；见 `revisionObjectCandidates`）。而一条
 * 检查记录绑的是**内容哈希**——只有「这份正文恰好是该定义哈希下的首份」时，
 * `readRevisionSnapshotText(plan, 内容哈希)` 才直读得到；旧修订（盘上只有定义名文件）直读得 null。
 * 读侧若据此回退整份比对，本可用**分段复核**救回的「本卡没变」就被误判 stale（假 stale）。
 *
 * 本解析器只做一件有界的事：把内容哈希经**已核基线流水**映回该修订的对象候选名（定义哈希主名优先，
 * 内容哈希兜底），**逐候选读原文并核内容哈希**——核不上不算命中（不拿主名顶替、不当篡改过的对象是它）。
 * 候选只来自基线流水与内容哈希本身，**不扫描无限历史**；读不到/核不上就 `read()` 返回 null（不猜）。
 *
 * 盘上**一个候选文件都没有**时还有第三种落点（同一条根因，2026-10-08 补）：该修订可能经
 * 「Git 里已能逐字节取回」直接引用为 `git:<oid>`（DESIGN.md §2.6），`preserveRevision` 那时**不落副本**，
 * 于是只按对象文件读必得 null、回退整份比对，把本卡没变误判 stale。此时按**内容哈希**从本项目基线流水
 * 找回该 blob 直读并核哈希（`readGitSnapshotText`）——仍是有界、只读、不扫描 Git 历史。
 */
export interface PlanContentSnapshotIndex {
  /** 内容哈希 → 对象候选键（定义哈希主名优先，含内容哈希兜底；只拼名字、有界） */
  object_keys(contentSha: string): string[];
  /**
   * 逐候选读并**核内容哈希**；命中的快照原文 + 实际对象名／Git 引用，读不到/核不上 = null。
   * Git 来源命中时 `source_ref` 是 `git:<oid>`、`object_key` 是内容哈希（复核侧据此复查来源仍在）。
   */
  read(contentSha: string): { text: string; source_ref: string; object_key: string } | null;
}

export function planContentSnapshotIndex(projectId: string, dataDir?: string): PlanContentSnapshotIndex {
  const byContent = new Map<string, ProjectBaseline>();
  try {
    for (const b of readBaselineLog(projectId, dataDir).baselines) {
      byContent.set(b.plan_revision.content_sha256, b);
    }
  } catch {
    // 基线流水读不了：退化为「按内容哈希直读」，读不到就是 null（不猜）
  }
  const object_keys = (contentSha: string): string[] => {
    const out: string[] = [];
    const b = byContent.get(contentSha);
    if (b !== undefined) {
      for (const h of [b.plan_revision.definition_sha256, b.plan_revision.content_sha256]) {
        if (typeof h === "string" && h !== "" && !out.includes(h)) out.push(h);
      }
    }
    if (contentSha !== "" && !out.includes(contentSha)) out.push(contentSha);
    return out;
  };
  const read = (contentSha: string): { text: string; source_ref: string; object_key: string } | null => {
    if (contentSha === "") return null;
    for (const h of object_keys(contentSha)) {
      // 逐候选读原文并核内容哈希：读+哈希在**一次派生**内按绝对路径复用（候选名在多个绑定间重复，
      // 现场实测同一份 466 KB 对象被读+核哈希 944 次）。核不上不算命中——判据一分不改。
      const abs = revisionSnapshotAbs(projectId, "plan", h, dataDir);
      const got = abs === null ? null : readSnapshotTextAndShaCached(abs);
      if (got !== null && got.sha256 === contentSha) {
        return { text: got.text, source_ref: `${PLAN_REVISIONS_DIR}/${h}.md`, object_key: h };
      }
    }
    // 盘上没有任何候选文件：这份内容可能是经「Git 里已能逐字节取回」直接引用的（`git:<oid>`，§2.6），
    // 那时 `preserveRevision` **不落副本**——只按文件名读必得 null、回退整份比对，把本可分段救回的
    // 「本卡没变」误判 stale。经**本项目已核基线流水**按内容哈希找回该 blob 直读并核哈希（有界、只读、
    // 不扫描 Git 历史）；读不回/对不上 = null（不猜、不拿别的对象顶替）。
    const rec = gitRecoveryBySha256(projectId, "plan", contentSha, dataDir);
    if (rec !== null) {
      const text = readGitSnapshotText(projectId, "plan", contentSha, dataDir);
      if (text !== null) {
        // object_key 给**内容哈希**：复核侧按它做"快照还在不在"的复查（`revisionSnapshotExists` 同样认 Git 来源）
        return { text, source_ref: rec.ref, object_key: contentSha };
      }
    }
    return null;
  };
  return { object_keys, read };
}

function gitAvailable(root: string): boolean {
  return fs.existsSync(path.join(root, ".git"));
}

/**
 * 内容是否已是 Git 里**可长期取回**的对象。只有取回字节与原文逐字节相同才认——
 * 否则宁可落不可变副本（不能拿一个取回后不一致的引用来冒充原文）。
 *
 * **为什么这条快速通道在本机恒定失效，以及为什么不"修"它**（缺陷 f-37f129d510c94de3 的旁证）：
 *   · `git hash-object --stdin`（不带 `--path`／`--filters`）**原样哈希喂进去的字节**，不套
 *     clean 过滤器，也不写对象库（没给 `-w`，这里也**故意**不给：不往用户仓库里塞游离对象）。
 *     所以它算出的 oid 对应的是**工作区字节**（本机 `core.autocrlf=true` ⇒ CRLF）。
 *   · 库里的 blob 是 `git add` 时按 autocrlf 归一过的 **LF** 字节（`git -C D:/tatai ls-files -s
 *     PLAN.md` 的库内 blob 与 `git hash-object --stdin < PLAN.md` 的哈希恒不相等）。于是
 *     `cat-file blob <工作区字节的 oid>` 要么"对象不存在"（catch → null），要么取回的字节与原文
 *     不同（下面那行 `equals` 判否 → null）。
 *   · **这不是可以"按 git 的规范化口径比较"绕过的**：§2.6 要求基线能取回**确切原文**，
 *     而 LF 化后的 blob 不是工作区那份 CRLF 原文，`recoverRevision` 也会按 `ref.sha256`
 *     （= 原文内容哈希）逐字节复核。拿归一化口径判"相等"，等于让一条基线指向一份**内容哈希
 *     对不上**的原文——把"取不回确切原文"伪装成"保住了"。所以这里**只认逐字节相同**：
 *     能用就用（无归一化的仓库／字节恰好原样入库时确实命中），不能用就老实落不可变副本。
 */
function gitBlobRef(root: string, bytes: Buffer): string | null {
  if (!gitAvailable(root)) return null;
  try {
    const oid = execFileSync("git", ["-C", root, "hash-object", "--stdin"], {
      input: bytes,
      maxBuffer: 64 * 1024 * 1024,
    })
      .toString("utf8")
      .trim();
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid)) return null;
    const back = execFileSync("git", ["-C", root, "cat-file", "blob", oid], {
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return Buffer.from(back).equals(bytes) ? oid : null;
  } catch {
    return null;
  }
}

/** 读不可变副本；内容哈希对不上时抛（历史不可改：被改过就不再是那份修订） */
function readRevisionObject(absPath: string, ref: DocumentRecovery): Buffer {
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(absPath);
  } catch (e) {
    throw new WorkError(
      "INVALID_COMMAND",
      `不可变历史对象读不出来（${ref.ref}）：${(e as Error).message}——基线引用的原文取不回，不能当有效修订用`,
      { ref: ref.ref, reason: "revision_object_missing" },
    );
  }
  const got = sha256Hex(bytes);
  if (got !== ref.sha256) {
    throw new WorkError(
      "INVALID_COMMAND",
      `不可变历史对象已被改动（${ref.ref}）：基线记的原文 sha256 是 ${ref.sha256.slice(0, 12)}…，盘上现在是 ${got.slice(0, 12)}…` +
        "——这是**真·篡改**：取回位置与内容哈希都是基线当时写下的，记录不会自己变；" +
        "「内容前进、定义未变」的记录性改动不会改到已记下的对象，它另存一个内容寻址的新对象（历史对象不接受编辑，DESIGN.md §2.6）",
      {
        ref: ref.ref,
        reason: "revision_object_tampered",
        tamper_kind: "true_tamper",
        expected_sha256: ref.sha256,
        actual_sha256: got,
      },
    );
  }
  return bytes;
}

/**
 * 已存在的不可变副本：按候选名找一个**内容哈希对得上**的。
 * 都对不上时返回 null（= 这份正文还没保住）；读取路径不改盘，要不要报错由 `preserveRevision` 判。
 */
function existingRecovery(
  source: DocumentSource,
  revision: Pick<DocumentRevision, "content_sha256" | "definition_sha256">,
): DocumentRecovery | null {
  for (const candidate of revisionObjectCandidates(source.kind, revision)) {
    const abs = path.join(source.project_root, candidate.rel);
    if (!fs.existsSync(abs)) continue;
    // 读+核内容哈希按绝对路径在「一次派生」内复用；**哈希的是盘上原始字节**（判据与旧实现
    // `sha256Hex(fs.readFileSync(abs))` 逐字相同），对不上盘（含 UTF-8 非法字节的同形篡改）不算命中。
    const sha = readSnapshotRawShaCached(abs);
    if (sha !== revision.content_sha256) continue;
    return { kind: "immutable_copy", ref: candidate.rel, key: candidate.key, sha256: sha };
  }
  return null;
}

/**
 * 真·篡改的统一拒绝（历史对象不接受编辑，DESIGN.md §2.6）。
 *
 * 只有走到这里才是"被改过"：**记录性改动（内容前进、定义未变）根本不会进这个分支**——
 * 那一路由 `targetObjectOf` 判成"同一定义哈希下的另一份正文"，新正文另存内容寻址对象、旧对象不动。
 * 所以文案必须把这层区分写出来：operator 看到"历史对象已被改动"时要知道这不是"勾了个检查项"的后果，
 * 而是盘上的字节既不是它记录的旧正文、也不是当前正文。
 *
 * `headline` 说的是**这一路真正的判据**（哪两个哈希、哪个对象名对不上），不吃一个统一的
 * "期望 X、实际 Y" 模板——定义哈希对不上名字那种情形下，"期望"本来就不是某个内容哈希，
 * 套模板反而会再误导一次（缺陷 f-37f129d510c94de3 骂的就是误导性指控）。
 */
function tamperedObject(rel: string, headline: string, why: string, extra: Record<string, unknown> = {}): never {
  throw new WorkError(
    "INVALID_COMMAND",
    `不可变历史对象已被改动（${rel}）：${headline}——${why}。这是**真·篡改**，不是「内容前进」：` +
      "记录性改动（勾选卡面检查项、改状态列、文末备注一类只动内容哈希、不动定义哈希的改动）会被判成" +
      "同一定义哈希下的**另一份正文**，新正文另存到内容哈希名下的不可变对象、旧对象一个字节都不动，" +
      "不会报这个错。历史对象不接受编辑，塔台不把改过的内容当原修订（DESIGN.md §2.6）",
    { ref: rel, reason: "revision_object_tampered", tamper_kind: "true_tamper", ...extra },
  );
}

/** 基线流水里引用这个不可变对象的记录所写的 sha256（没被引用返回 null） */
function referencedObjectSha256(ctx: { projectId: string; dataDir?: string }, rel: string): string | null {
  for (const b of readBaselineLog(ctx.projectId, ctx.dataDir).baselines) {
    for (const ref of [b.design_revision, b.plan_revision]) {
      if (ref.recovery.kind === "immutable_copy" && ref.recovery.ref === rel) return ref.recovery.sha256;
    }
  }
  return null;
}

/**
 * 这份修订该落哪个对象名：已经保住了就给出它的恢复位置（幂等），否则给出要新建的那个。
 *
 * 主名下有对象、但内容对不上时（②在下面已先排除"内容一致"的常态）：
 *   · 那个对象**连定义哈希都对不上它的名字** ⇒ 它被改过（改到了定义区），拒绝；
 *   · 定义哈希仍对得上 ⇒ 它是"同一定义哈希下的**另一份正文**"，不是这份修订被改过：
 *     新正文另存到内容哈希名下，旧对象一个字节都不动。
 *     但若这份旧正文已被某条基线引用，它的字节就是那条基线的原文，被改过一样拒绝。
 */
function targetObjectOf(
  loaded: LoadedDocument,
  ctx: { projectId: string; dataDir?: string },
): { rel: string; key: string; existing: DocumentRecovery | null } {
  const { source, revision } = loaded;
  const candidates = revisionObjectCandidates(source.kind, revision);
  const primary = candidates[0];
  const primaryAbs = path.join(source.project_root, primary.rel);
  if (!fs.existsSync(primaryAbs)) return { ...primary, existing: null };

  const stored = fs.readFileSync(primaryAbs);
  const storedSha = sha256Hex(stored);
  if (storedSha === revision.content_sha256) {
    // 同一个对象：原样返回（幂等，一个字节都不动）
    return { ...primary, existing: { kind: "immutable_copy", ref: primary.rel, key: primary.key, sha256: storedSha } };
  }
  if (source.kind === "design") {
    // 设计书的对象名就是内容哈希：同名不同内容只可能是被改过（设计侧没有"另一份正文"这一档）
    tamperedObject(
      primary.rel,
      `设计书的不可变副本按**内容哈希**命名，同名却是别的内容（盘上这份内容哈希 ${storedSha.slice(0, 12)}… ` +
        `≠ 对象名 ${primary.key.slice(0, 12)}…）`,
      "盘上的字节既不是这份修订，也不是别的合法修订",
      { expected_sha256: revision.content_sha256, actual_sha256: storedSha },
    );
  }

  const storedDefinition = definitionHashOf(parsePlanTable(stored.toString("utf8"))?.rows ?? []);
  if (storedDefinition !== primary.key) {
    tamperedObject(
      primary.rel,
      `主名的对象键是**定义哈希** ${primary.key.slice(0, 12)}…，而盘上这份字节重算出来的定义哈希是 ` +
        `${storedDefinition.slice(0, 12)}…（对不上名字）`,
      "它既不是它记录的那份正文，也不是当前正文" + `（当前正文的内容哈希是 ${revision.content_sha256.slice(0, 12)}…）`,
      {
        expected_sha256: revision.content_sha256,
        actual_sha256: storedSha,
        stored_definition_sha256: storedDefinition,
        object_key_sha256: primary.key,
      },
    );
  }
  const referenced = referencedObjectSha256(ctx, primary.rel);
  if (referenced !== null && referenced !== storedSha) {
    tamperedObject(
      primary.rel,
      "这个对象**已被基线流水引用**，引用记录写的是 sha256 " +
        `${referenced.slice(0, 12)}…，而盘上现在的内容哈希是 ${storedSha.slice(0, 12)}…`,
      "被引用的历史对象字节必须等于基线当时记下的原文；它只改了定义区之外的字节" +
        "（重算定义哈希仍与名字相符），所以按「被引用的历史对象」拒，而不是当成同定义下的另一份正文",
      {
        expected_sha256: referenced,
        actual_sha256: storedSha,
        referenced_by_baseline: true,
        stored_definition_sha256: storedDefinition,
      },
    );
  }

  const variant = candidates[1];
  if (variant === undefined) {
    // 施工图的内容哈希与定义哈希相同（sha256 碰撞级）时没有第二档对象名；如实拒，不去构造不存在的候选名
    tamperedObject(
      primary.rel,
      `施工图没有可用的内容寻址候选名（内容哈希 ${revision.content_sha256.slice(0, 12)}… 与定义哈希 ` +
        `${primary.key.slice(0, 12)}… 相同）`,
      "无法把新正文另存到第二个对象名下",
      { actual_sha256: storedSha, object_key_sha256: primary.key },
    );
  }
  const variantAbs = path.join(source.project_root, variant.rel);
  if (!fs.existsSync(variantAbs)) return { ...variant, existing: null };
  // 内容哈希名下的对象必须就是这一份正文（同名不同内容只能是篡改）
  const variantSha = sha256Hex(fs.readFileSync(variantAbs));
  if (variantSha !== revision.content_sha256) {
    tamperedObject(
      variant.rel,
      `内容哈希名下的对象，盘上内容哈希是 ${variantSha.slice(0, 12)}…，与它自己的对象名 ` +
        `${revision.content_sha256.slice(0, 12)}… 不符`,
      "内容寻址对象只可能是**这一份**正文（同名不同内容没有第二种解释）",
      { expected_sha256: revision.content_sha256, actual_sha256: variantSha },
    );
  }
  return { ...variant, existing: { kind: "immutable_copy", ref: variant.rel, key: variant.key, sha256: variantSha } };
}

/** 不可变副本落盘（临时文件 + rename + 读回复核）；只新建、不覆盖已有对象 */
function writeImmutableObject(source: DocumentSource, rel: string, bytes: Buffer, contentSha: string): void {
  const abs = path.join(source.project_root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, bytes);
  try {
    fs.renameSync(tmp, abs);
  } catch (e) {
    // 跨进程并发保存同一修订：另一个进程可能刚 rename 成功（Windows 上偶发 EPERM/EEXIST）。
    // 只要目标已存在且内容对得上，就是"已经保住了"，照常往下走；否则把真实错误抛出来。
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // 清理失败不影响判断
    }
    if (!(fs.existsSync(abs) && sha256Hex(fs.readFileSync(abs)) === contentSha)) throw e;
  }
  // 落盘后读回复核：历史对象的内容哈希必须等于原文哈希（不靠"写成功了"就当保住了）
  const back = readRevisionObject(abs, {
    kind: "immutable_copy",
    ref: rel,
    key: rel,
    sha256: contentSha,
  });
  if (!back.equals(bytes)) {
    throw new WorkError("INVALID_COMMAND", `不可变副本落盘后与原文不一致（${rel}）`, {
      ref: rel,
      reason: "revision_object_mismatch",
    });
  }
}

/**
 * 保存不可变历史（DESIGN.md §2.6）：已可长期取回的 Git 对象直接引用，否则落不可变副本。
 * 幂等且**不回写**：对象已在且内容一致 → 原样返回（一个字节都不动）；内容对不上 → 报错。
 * 施工图"同定义哈希、不同正文"时另存到内容哈希名下（对象名与判据见 `revisionObjectCandidates`／
 * `targetObjectOf`），旧对象不动。`ctx` 用于核对主名下的旧正文有没有被基线引用。
 *
 * 注意"内容对不上"分两种，**只有一种报错**（缺陷 f-37f129d510c94de3）：
 *   · 同一定义哈希下的另一份正文（记录性改动造成的"内容前进、定义未变"）⇒ 另存，不报错；
 *   · 同名副本的字节既不等于它记录的旧正文、也不等于当前正文（重算定义哈希对不上名字，
 *     或该对象被基线引用而字节与记录不符）⇒ 真·篡改，拒（文案见 `tamperedObject`）。
 */
export function preserveRevision(
  loaded: LoadedDocument,
  ctx: { projectId: string; dataDir?: string },
): DocumentRecovery {
  const { source, revision, text } = loaded;
  const keyHash = keyHashOf(source.kind, revision);
  const bytes = Buffer.from(text, "utf8");

  // 已在 Git 里可长期取回 → 直接引用（不落副本，不重复占空间）
  const oid = gitBlobRef(source.project_root, bytes);
  if (oid !== null) {
    return { kind: "git_blob", ref: `git:${oid}`, key: keyHash, sha256: revision.content_sha256 };
  }

  const target = targetObjectOf(loaded, ctx);
  if (target.existing !== null) return target.existing;
  writeImmutableObject(source, target.rel, bytes, revision.content_sha256);
  return { kind: "immutable_copy", ref: target.rel, key: target.key, sha256: revision.content_sha256 };
}

/** 按基线引用的恢复位置取回原文（校验哈希；取不回/被改动一律报错，不静默降级） */
export function recoverRevision(
  projectRoot: string,
  ref: DocumentRecovery,
): { bytes: Buffer; text: string } {
  if (ref.kind === "immutable_copy") {
    const bytes = readRevisionObject(path.join(projectRoot, ref.ref), ref);
    return { bytes, text: bytes.toString("utf8") };
  }
  const oid = ref.ref.replace(/^git:/, "");
  let out: Buffer;
  try {
    out = Buffer.from(
      execFileSync("git", ["-C", projectRoot, "cat-file", "blob", oid], {
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      }),
    );
  } catch (e) {
    throw new WorkError(
      "INVALID_COMMAND",
      `Git 对象取不回来（${ref.ref}）：${(e as Error).message}——基线引用的 blob 已不可用`,
      { ref: ref.ref, reason: "git_object_missing" },
    );
  }
  const got = sha256Hex(out);
  if (got !== ref.sha256) {
    throw new WorkError(
      "INVALID_COMMAND",
      `Git 对象内容与基线记录不一致（${ref.ref}）：期望 ${ref.sha256.slice(0, 12)}…，实际 ${got.slice(0, 12)}…`,
      { ref: ref.ref, reason: "revision_object_tampered" },
    );
  }
  return { bytes: out, text: out.toString("utf8") };
}

// ── 读一份图纸 ──

function revisionOf(source: DocumentSource, text: string): DocumentRevision {
  const bytes = Buffer.byteLength(text, "utf8");
  const definition_sha256 =
    source.kind === "design"
      ? sha256Hex(designDefinitionText(text))
      : definitionHashOf(parsePlanTable(text)?.rows ?? []);
  const content_sha256 = sha256Hex(text);
  return {
    kind: source.kind,
    source_path: source.rel_path,
    origin: source.origin,
    content_sha256,
    definition_sha256,
    bytes,
    lines: text === "" ? 0 : text.replace(/\r?\n$/, "").split(/\r?\n/).length,
    sections: buildSectionIndex(text),
    recovery: existingRecovery(source, { content_sha256, definition_sha256 }),
  };
}

/**
 * 读一份图纸（源解析 + 原文 + 修订 + 任务行）。
 * 源文件不存在返回 null（缺图纸是**正常空态**，不是错误）；调用方按需决定要不要据此拒绝激活。
 */
export function loadDocument(
  projectId: string,
  kind: DocumentKind,
  dataDir?: string,
): LoadedDocument | null {
  const source = resolveDocumentSource(projectId, kind, dataDir);
  if (!fs.existsSync(source.abs_path)) return null;
  if (!fs.statSync(source.abs_path).isFile()) {
    throw new WorkError("INVALID_COMMAND", `图纸源不是文件（kind=${kind}）：${source.rel_path}`, {
      kind,
      source_path: source.rel_path,
      reason: "not_a_file",
    });
  }
  // 一次派生里同一份图纸源只读+解析一次（现场实测 DESIGN/PLAN 在一次六图派生里被读+解析 18 次）：
  // 文本、施工行解析、修订（定义哈希/章节索引/恢复位置核查）各按身份在 `derivationScope` 内复用。
  // 作用域只在**一次同步派生**里有效，下一个请求照旧现读现算（源一变立刻可见）。
  const abs = source.abs_path;
  const text = memoizedForDerivation("documents:source-text", abs, () => fs.readFileSync(abs, "utf8"));
  const table = kind === "plan" ? memoizedForDerivation("documents:plan-table", abs, () => parsePlanTable(text)) : null;
  const revision = memoizedForDerivation("documents:revision", `${kind}\u0000${abs}`, () =>
    revisionOf(source, text),
  );
  return {
    source,
    // 记忆化的是**只读计算**（读文本/解析/核恢复位置）；返回给调用方的 revision 与 tasks 一律给
    // **深独立副本**——调用方改它们不会串到同派生的别处，也不会回写到记忆里（与不引入复用时的可见行为一致）。
    revision: structuredClone(revision),
    text,
    tasks: table === null ? [] : structuredClone(table.rows),
    table_found: table !== null,
  };
}

/** 两份图纸一起读；缺失的返回 null（成套读取的唯一入口） */
export function loadDocuments(
  projectId: string,
  dataDir?: string,
): { design: LoadedDocument | null; plan: LoadedDocument | null } {
  return {
    design: loadDocument(projectId, "design", dataDir),
    plan: loadDocument(projectId, "plan", dataDir),
  };
}

// ── 章节差异 ──

export interface SectionDelta {
  path: string;
  change: "added" | "removed" | "changed";
  before_sha256: string | null;
  after_sha256: string | null;
  before_lines: [number, number] | null;
  after_lines: [number, number] | null;
}

export interface DocumentDiff {
  kind: DocumentKind;
  before_content_sha256: string;
  after_content_sha256: string;
  before_definition_sha256: string;
  after_definition_sha256: string;
  /** 内容逐字节相同（true = 没有差异，调用方不必看 changed） */
  identical: boolean;
  /** 只看变动项 */
  changed: SectionDelta[];
  counts: { added: number; removed: number; changed: number; unchanged: number };
}

/** 两个修订之间的章节差异（按标题路径比对；章节增删改一眼可读） */
export function diffSections(
  kind: DocumentKind,
  before: { text: string; content_sha256: string; definition_sha256: string },
  after: { text: string; content_sha256: string; definition_sha256: string },
): DocumentDiff {
  const b = buildSectionIndex(before.text);
  const a = buildSectionIndex(after.text);
  const bMap = new Map(b.map((s) => [s.path, s]));
  const aMap = new Map(a.map((s) => [s.path, s]));
  const changed: SectionDelta[] = [];
  let unchanged = 0;
  let added = 0;
  let removed = 0;
  let nChanged = 0;
  for (const s of a) {
    const prev = bMap.get(s.path);
    if (!prev) {
      added++;
      changed.push({
        path: s.path,
        change: "added",
        before_sha256: null,
        after_sha256: s.sha256,
        before_lines: null,
        after_lines: [s.line_start, s.line_end],
      });
      continue;
    }
    if (prev.sha256 === s.sha256) {
      unchanged++;
      continue;
    }
    nChanged++;
    changed.push({
      path: s.path,
      change: "changed",
      before_sha256: prev.sha256,
      after_sha256: s.sha256,
      before_lines: [prev.line_start, prev.line_end],
      after_lines: [s.line_start, s.line_end],
    });
  }
  for (const s of b) {
    if (aMap.has(s.path)) continue;
    removed++;
    changed.push({
      path: s.path,
      change: "removed",
      before_sha256: s.sha256,
      after_sha256: null,
      before_lines: [s.line_start, s.line_end],
      after_lines: null,
    });
  }
  return {
    kind,
    before_content_sha256: before.content_sha256,
    after_content_sha256: after.content_sha256,
    before_definition_sha256: before.definition_sha256,
    after_definition_sha256: after.definition_sha256,
    identical: before.content_sha256 === after.content_sha256,
    changed,
    counts: { added, removed, changed: nChanged, unchanged },
  };
}

/**
 * 按哈希取一份历史修订的原文：先看当前源是否就是那一份，再看不可变历史/Git 副本。
 * 取不回就报错（不拿当前内容冒充历史修订）。
 */
function textOfRevision(
  loaded: LoadedDocument | null,
  kind: DocumentKind,
  sha: string,
  projectRoot: string,
): { text: string; content_sha256: string; definition_sha256: string } {
  if (loaded && (loaded.revision.content_sha256 === sha || loaded.revision.definition_sha256 === sha)) {
    return {
      text: loaded.text,
      content_sha256: loaded.revision.content_sha256,
      definition_sha256: loaded.revision.definition_sha256,
    };
  }
  // 不可变副本（设计按内容哈希、施工按定义哈希命名；两种键都试一次）
  const abs = path.join(projectRoot, revisionObjectRel(kind, sha));
  if (fs.existsSync(abs)) {
    const text = fs.readFileSync(abs).toString("utf8");
    const content = sha256Hex(text);
    const definition =
      kind === "design"
        ? sha256Hex(designDefinitionText(text))
        : definitionHashOf(parsePlanTable(text)?.rows ?? []);
    if (content === sha || definition === sha) {
      return { text, content_sha256: content, definition_sha256: definition };
    }
  }
  throw new WorkError(
    "INVALID_COMMAND",
    `取不回指定修订（kind=${kind}, sha256=${sha.slice(0, 12)}…）：既不是当前源，也不在不可变历史里——` +
      "缺图纸原文时不做近似比较",
    { kind, sha256: sha, reason: "revision_not_recoverable" },
  );
}

/** 章节差异（按两个哈希；当前源命中就直接比，否则从不可变历史取回） */
export function diffRevisionsByHash(
  projectId: string,
  kind: DocumentKind,
  fromSha: string,
  toSha: string,
  dataDir?: string,
): DocumentDiff {
  const loaded = loadDocument(projectId, kind, dataDir);
  const source = resolveDocumentSource(projectId, kind, dataDir);
  if (loaded === null && !fs.existsSync(source.abs_path)) {
    throw new WorkError("INVALID_COMMAND", `图纸缺失（kind=${kind}）：${source.rel_path}`, {
      kind,
      source_path: source.rel_path,
      reason: "missing_source",
    });
  }
  const before = textOfRevision(loaded, kind, fromSha, source.project_root);
  const after = textOfRevision(loaded, kind, toSha, source.project_root);
  return diffSections(kind, before, after);
}

// ── 双版本激活 ──

const APPROVAL_KINDS: readonly BaselineApprovalKind[] = [
  "user_confirmed",
  "delegated_technical_review",
];

function badActivation(message: string, detail: Record<string, unknown> = {}): never {
  throw new WorkError("INVALID_COMMAND", message, detail);
}

/** 审定记录校验（DESIGN.md §2.9：无审定依据不能激活；技术审定不得伪造成用户 Gate） */
function assertApproval(input: {
  approved_by?: unknown;
  approval_basis?: unknown;
  approval_kind?: unknown;
}): { approved_by: string; approval_basis: string; approval_kind: BaselineApprovalKind } {
  const approved_by = typeof input.approved_by === "string" ? input.approved_by.trim() : "";
  const approval_basis = typeof input.approval_basis === "string" ? input.approval_basis.trim() : "";
  const kind = input.approval_kind;
  if (approved_by === "") badActivation("缺审定者（approved_by）：谁审定的要如实写，不能空着", { field: "approved_by" });
  if (approval_basis === "") {
    badActivation("无审定依据（approval_basis 为空）：没有审定依据的基线不可激活（DESIGN.md §2.9）", {
      field: "approval_basis",
    });
  }
  if (typeof kind !== "string" || !APPROVAL_KINDS.includes(kind as BaselineApprovalKind)) {
    badActivation(
      `审定种类（approval_kind）只接受 ${APPROVAL_KINDS.join(" / ")}：用户确认与技术审定必须如实分开`,
      { field: "approval_kind", value: input.approval_kind },
    );
  }
  const k = kind as BaselineApprovalKind;
  if (k === "user_confirmed" && approved_by !== "user") {
    badActivation(
      `用户确认（user_confirmed）的审定者必须是 "user"，收到 ${JSON.stringify(approved_by)}——` +
        "不让别的角色替用户作确认",
      { field: "approved_by", approval_kind: k },
    );
  }
  if (k === "delegated_technical_review" && approved_by === "user") {
    badActivation(
      '技术审定不得伪造成用户 Gate：user 委派的技术审定必须如实标为 approved_by=<设计角色> + ' +
        'approval_kind="delegated_technical_review"（DESIGN.md §2.9；本流程不写 gate.jsonl）',
      { field: "approved_by", approval_kind: k },
    );
  }
  return { approved_by, approval_basis, approval_kind: k };
}

/** 修订引用（基线里不存章节索引，只引用哈希与恢复位置） */
export function revisionRef(revision: DocumentRevision, recovery: DocumentRecovery): DocumentRevisionRef {
  return {
    kind: revision.kind,
    source_path: revision.source_path,
    content_sha256: revision.content_sha256,
    definition_sha256: revision.definition_sha256,
    recovery,
  };
}

export interface ActivateBaselineInput {
  approved_by: string;
  approval_basis: string;
  approval_kind: BaselineApprovalKind;
  /**
   * 审定者手上那份**草稿**的版本标识（源在审定中改变即版本冲突，DESIGN.md §2.9）。
   * 省略 = 不做草稿比对（但仍要求两份图纸在场且施工图结构合法）。
   */
  expected?: {
    design_source_path?: string;
    design_content_sha256?: string;
    design_definition_sha256?: string;
    plan_source_path?: string;
    plan_content_sha256?: string;
    plan_definition_sha256?: string;
  };
}

/**
 * 相对被取代基线，某一侧图纸"进到了哪一步"（`activateBaseline` 的如实标注，不写进基线记录）。
 *
 * 记录本身已经同时写着 `content_sha256` 与 `definition_sha256`（§2.9 的六字段 + 恢复位置），
 * 所以这个标注是**派生读数**、不是第二个事实源：由 `supersedes` 指的前一条基线现算。
 *   · `initial`：第一次建立基线（没有可比的旧记录）；
 *   · `unchanged`：内容与定义都跟被取代的基线逐字节一样（另一侧变了而已）——这一侧没有推进；
 *   · `content_only`：**内容前进、定义未变**——记录性改动（勾选检查项、改状态列、文末备注）走这条；
 *   · `definition_changed`：定义也变了（改了卡号/交付目标/依赖/完成证据，或设计书正文区）。
 */
export type BaselineAdvance = "initial" | "unchanged" | "content_only" | "definition_changed";

export interface ActivateBaselineResult {
  baseline: ProjectBaseline;
  /** true = 本次新建；false = 同一对修订的基线已生效（幂等，不重复追加） */
  created: boolean;
  /**
   * 如实标注：本次**新建**的基线相对被取代基线各侧的推进情形（幂等命中既有基线时为 null）。
   * 施工图一侧为 `content_only` 就是缺陷 f-37f129d510c94de3 说的那种「记录性改动后重激活」——
   * 不报错、不覆盖旧对象、新正文另存内容寻址对象，所以这里如实说是"内容前进"，不是"被改动"。
   */
  advance: { design: BaselineAdvance; plan: BaselineAdvance } | null;
}

/**
 * 基线 id：设计＝内容哈希、施工＝**内容**哈希各取 8 位。
 *
 * 施工图侧取内容哈希（不再取定义哈希）：定义哈希只是正文的投影，两份正文可以同定义哈希不同内容
 * （`revisionObjectCandidates`）——按定义哈希编号会让两条不同的基线撞同一个 id，`supersedes` 链
 * 也跟着含糊。引用与恢复位置仍走各自的 `revision.recovery`，字段一个不少。
 */
function baselineIdOf(design: DocumentRevisionRef, plan: DocumentRevisionRef): string {
  return `bl-${design.content_sha256.slice(0, 8)}-${plan.content_sha256.slice(0, 8)}`;
}

function validateBaselineRecord(raw: unknown, line: number): ProjectBaseline {
  const bad = (why: string): never => {
    throw new WorkError("INVALID_COMMAND", `baselines.jsonl 第 ${line} 行结构不合法：${why}`, {
      line,
      reason: "baseline_log_corrupt",
    });
  };
  if (typeof raw !== "object" || raw === null) return bad("不是 JSON 对象");
  const r = raw as Record<string, unknown>;
  const str = (field: string): string => {
    const v = r[field];
    if (typeof v !== "string" || v.trim() === "") return bad(`缺字段或类型不对: ${field}`);
    return v;
  };
  const refOf = (field: string): DocumentRevisionRef => {
    const v = r[field];
    if (typeof v !== "object" || v === null) return bad(`${field} 不是对象`);
    const ref = v as Record<string, unknown>;
    const rec = ref.recovery;
    if (typeof rec !== "object" || rec === null) return bad(`${field}.recovery 不是对象`);
    const recovery = rec as Record<string, unknown>;
    if (recovery.kind !== "git_blob" && recovery.kind !== "immutable_copy") {
      return bad(`${field}.recovery.kind 非法`);
    }
    for (const k of ["ref", "key", "sha256"]) {
      if (typeof recovery[k] !== "string" || recovery[k] === "") return bad(`${field}.recovery.${k} 非法`);
    }
    for (const k of ["source_path", "content_sha256", "definition_sha256"]) {
      if (typeof ref[k] !== "string" || ref[k] === "") return bad(`${field}.${k} 非法`);
    }
    if (ref.kind !== "design" && ref.kind !== "plan") return bad(`${field}.kind 非法`);
    return {
      kind: ref.kind,
      source_path: ref.source_path as string,
      content_sha256: ref.content_sha256 as string,
      definition_sha256: ref.definition_sha256 as string,
      recovery: {
        kind: recovery.kind,
        ref: recovery.ref as string,
        key: recovery.key as string,
        sha256: recovery.sha256 as string,
      },
    };
  };
  const kind = r.approval_kind;
  if (typeof kind !== "string" || !APPROVAL_KINDS.includes(kind as BaselineApprovalKind)) {
    return bad(`approval_kind 非法: ${JSON.stringify(kind)}`);
  }
  const supersedes = r.supersedes;
  if (!(supersedes === null || typeof supersedes === "string")) {
    return bad("supersedes 必须是字符串或 null");
  }
  return {
    baseline_id: str("baseline_id"),
    design_revision: refOf("design_revision"),
    plan_revision: refOf("plan_revision"),
    approved_by: str("approved_by"),
    approval_basis: str("approval_basis"),
    approval_kind: kind as BaselineApprovalKind,
    active_at: str("active_at"),
    supersedes: (supersedes as string | null) ?? null,
  };
}

export interface BaselineLog {
  baselines: ProjectBaseline[];
  /** 坏行（只读路径如实报出，不跳过、不当没看见） */
  corrupt: { line: number; reason: string }[];
}

export const baselinesPath = (projectId: string, dataDir?: string): string =>
  path.join(projectWorkbenchDir(projectId, dataDir), BASELINES_FILE);

/** 读基线流水（只读）：逐行严格校验，坏行如实报出 */
export function readBaselineLog(projectId: string, dataDir?: string): BaselineLog {
  const file = baselinesPath(projectId, dataDir);
  if (!fs.existsSync(file)) return { baselines: [], corrupt: [] };
  const baselines: ProjectBaseline[] = [];
  const corrupt: { line: number; reason: string }[] = [];
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i].trim();
    if (text === "") continue;
    try {
      baselines.push(validateBaselineRecord(JSON.parse(text), i + 1));
    } catch (e) {
      corrupt.push({ line: i + 1, reason: (e as Error).message });
    }
  }
  return { baselines, corrupt };
}

/** 当前生效基线 = 流水最后一条有效记录（只追加，最后一条即现行） */
export function activeBaseline(projectId: string, dataDir?: string): ProjectBaseline | null {
  const log = readBaselineLog(projectId, dataDir);
  return log.baselines.length === 0 ? null : log.baselines[log.baselines.length - 1];
}

/**
 * 激活成套图纸基线（DESIGN.md §2.9 的"审定配套版本→激活基线"）。
 *
 * 顺序（每一步不过就**一个字节都不写**，旧基线继续有效）：
 *   ① 审定记录合法（有审定者、有依据、用户/技术审定如实分开）；
 *   ② 两份图纸都在场（缺任一份拒绝激活）；
 *   ③ 施工图结构合法（重复 id / 悬空依赖 / 环 / 缺验收 → 点名 id 拒绝）；
 *   ④ 与审定者手上的草稿一致（源在审定中改变 → VERSION_CONFLICT，保留草稿与差异）；
 *   ⑤ 两份修订各存不可变历史并复核哈希（"同定义哈希、不同正文"另存内容寻址对象，不覆盖旧对象）；
 *   ⑥ 激活前逐条校验既有基线流水（坏行不追加，不往坏链上续）；
 *   ⑦ 追加一行基线（只追加；同对修订重复激活返回原记录，不重复追加）；
 *      返回值另附 `advance`：本次相对被取代基线是「内容前进、定义未变」还是「定义也变了」（如实标注）。
 */
export function activateBaseline(
  projectId: string,
  input: ActivateBaselineInput,
  dataDir?: string,
): ActivateBaselineResult {
  const approval = assertApproval(input);
  const docs = loadDocuments(projectId, dataDir);
  const missing = DOCUMENT_KINDS.filter((k) => docs[k] === null);
  if (missing.length > 0) {
    badActivation(
      `任一份图纸缺失都不能激活（缺：${missing.join("、")}）——设计书与施工图是一套，不能只审一半`,
      { missing, project_id: projectId },
    );
  }
  const design = docs.design!;
  const plan = docs.plan!;

  // ③ 施工图最小结构校验（不通过即点名 id 拒绝）
  assertPlanTasksValid(plan.tasks, plan.source.rel_path, plan.table_found);

  // ④ 草稿比对：源在审定中改变 = 版本冲突
  const exp = input.expected ?? {};
  const changed: string[] = [];
  const conflicts: Record<string, unknown> = {};
  const cmp = (name: string, expected: string | undefined, current: string, kind: DocumentKind): void => {
    if (expected === undefined || expected === "") return;
    if (expected === current) return;
    changed.push(`${kind}_${name}`);
    conflicts[`${kind}_${name}`] = { expected, current };
  };
  cmp("source_path", exp.design_source_path, design.source.rel_path, "design");
  cmp("content_sha256", exp.design_content_sha256, design.revision.content_sha256, "design");
  cmp("definition_sha256", exp.design_definition_sha256, design.revision.definition_sha256, "design");
  cmp("source_path", exp.plan_source_path, plan.source.rel_path, "plan");
  cmp("content_sha256", exp.plan_content_sha256, plan.revision.content_sha256, "plan");
  cmp("definition_sha256", exp.plan_definition_sha256, plan.revision.definition_sha256, "plan");
  if (changed.length > 0) {
    throw new WorkError(
      "VERSION_CONFLICT",
      `源在审定中改变了（${changed.join("、")}）：本次草稿比较作废，重新读取现行原文后再审定（DESIGN.md §2.9）`,
      { changed, conflicts, design_source: design.source.rel_path, plan_source: plan.source.rel_path },
    );
  }

  // ⑤ 不可变历史（先保住原文，再写基线——顺序反过来会出现"基线指向取不回的原文"）
  const designRecovery = preserveRevision(design, { projectId, dataDir });
  const planRecovery = preserveRevision(plan, { projectId, dataDir });

  // ⑥ + ⑦ 只追加，全程持锁（并发激活不互相覆盖）
  const file = baselinesPath(projectId, dataDir);
  return withFileLock(file, () => {
    const log = readBaselineLog(projectId, dataDir);
    if (log.corrupt.length > 0) {
      badActivation(
        `基线流水有坏行（第 ${log.corrupt.map((c) => c.line).join("、")} 行）：先在坏链上续写会掩盖现场，拒绝激活`,
        { corrupt: log.corrupt, reason: "baseline_log_corrupt" },
      );
    }
    const designRef = revisionRef(design.revision, designRecovery);
    const planRef = revisionRef(plan.revision, planRecovery);
    const baseline_id = baselineIdOf(designRef, planRef);
    // 幂等判据 = 两份修订的**内容哈希**（施工图侧不只比定义哈希）：同定义哈希但正文变过
    // （`revisionObjectCandidates`）是另一份修订，得留下一条能取回新原文的新基线。
    const same = log.baselines.find(
      (b) =>
        b.design_revision.content_sha256 === designRef.content_sha256 &&
        b.plan_revision.content_sha256 === planRef.content_sha256,
    );
    if (same) return { baseline: same, created: false, advance: null };

    const prev = log.baselines.length === 0 ? null : log.baselines[log.baselines.length - 1];
    const record: ProjectBaseline = {
      baseline_id,
      design_revision: designRef,
      plan_revision: planRef,
      approved_by: approval.approved_by,
      approval_basis: approval.approval_basis,
      approval_kind: approval.approval_kind,
      active_at: nowIso(),
      supersedes: prev === null ? null : prev.baseline_id,
    };
    const line = JSON.stringify(record);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    appendJsonlLine(file, line);
    // 写回复核：最后一行必须是我们刚写的那条（否则报错，不假装激活成功）
    const now = readBaselineLog(projectId, dataDir);
    const last = now.baselines[now.baselines.length - 1];
    if (now.corrupt.length > 0 || !last || JSON.stringify(last) !== line) {
      badActivation("基线写入后复核不一致：不把这次激活当作成功", {
        reason: "baseline_write_unverified",
        baseline_id,
      });
    }
    // 如实标注（不写进记录，见 `BaselineAdvance`）：相对被取代的基线，各侧是"内容前进、定义未变"
    // 还是"定义也变了"。记录性改动走前者——那时**不报错**才是对的，报"被改动"就是误导。
    const advanceOf = (before: DocumentRevisionRef | null, after: DocumentRevisionRef): BaselineAdvance => {
      if (before === null) return "initial";
      if (before.content_sha256 === after.content_sha256) return "unchanged";
      if (before.definition_sha256 !== after.definition_sha256) return "definition_changed";
      return "content_only";
    };
    return {
      baseline: last,
      created: true,
      advance: {
        design: advanceOf(prev === null ? null : prev.design_revision, designRef),
        plan: advanceOf(prev === null ? null : prev.plan_revision, planRef),
      },
    };
  });
}

/**
 * 保存一份图纸的不可变历史（读接口之外的最小入口）。
 * 图纸缺失 → 拒绝（缺图纸不保存、也不给基线用）。
 */
export function preserveDocumentRevision(
  projectId: string,
  kind: DocumentKind,
  dataDir?: string,
): { source: DocumentSource; revision: DocumentRevision; recovery: DocumentRecovery } {
  const loaded = loadDocument(projectId, kind, dataDir);
  if (loaded === null) {
    throw new WorkError("INVALID_COMMAND", `图纸缺失（kind=${kind}）：无法保存不可变历史`, {
      kind,
      project_id: projectId,
      reason: "missing_source",
    });
  }
  const recovery = preserveRevision(loaded, { projectId, dataDir });
  return {
    source: loaded.source,
    revision: { ...loaded.revision, recovery },
    recovery,
  };
}

/** 结构校验结果（读接口用：既报问题，也报解析到的任务行数） */
export function planStructure(loaded: LoadedDocument): {
  table_found: boolean;
  task_count: number;
  issues: ReturnType<typeof validatePlanTasks>;
} {
  return {
    table_found: loaded.table_found,
    task_count: loaded.tasks.length,
    issues: validatePlanTasks(loaded.tasks, loaded.table_found),
  };
}
