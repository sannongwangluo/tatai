import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getProject } from "./registry";
import { readTextForAppend, WsError } from "./workstation";

// AGENTS.md 约定段接入（M3；V06-10 改为**标记区收敛**）：把 DESIGN.md §6.2 的约定句 + 接续指引
// 插进被纳管项目的 AGENTS.md——那是客户端实际会载入的位置。
// 模板本体在 templates/agents-md-snippet.md（进仓库，DoD① 文本与 §6.2 引用句一致）。
//
// 幂等红线（V06-10 收紧口径，仍是"只动标记区"）：
//   · 没有标记区 → 末尾追加（原 M3 行为不变，`inserted:true`）；
//   · 已有标记区且内容与模板**逐字节相同** → 一个字节都不写（`inserted:false`，原 M3 幂等口径不变）；
//   · 已有标记区但内容过期 → **只替换 start..end 那一段本体**（`updated:true`）：写入的标记本体是
//     模板 `trimEnd()` 后的字节，结束标记之后原有的字节（CRLF/LF 行尾、紧随的正文）原样保留，
//     既不插入也不吞掉。标记区之外的用户自写规则逐字节不动——这样新入口规则才送得到已经接入过的项目，
//     而不会覆盖用户规则、也不会在首次收敛时给文件尾多加一个 LF。
//   · 只有 start 没有 end（标记被手工破坏）→ 拒绝写并让人先修，**不**偷偷再追加一段。
//
// 路径安全红线：本模块只接受项目 id，项目根一律从注册表取（registry.getProject），
// 不接受调用方直接传路径（与 workstation.ts 同一红线）。

const AGENTS_MD_FILE = "AGENTS.md";
export const SNIPPET_START_MARK = "<!-- tatai-mcp:start -->";
export const SNIPPET_END_MARK = "<!-- tatai-mcp:end -->";

const SNIPPET_FILE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "templates",
  "agents-md-snippet.md",
);

/**
 * 原子写文本：先写临时文件再 rename，防半截文件（与 workstation.writeTextAtomic 同一惯例）。
 * `expectOnDisk`（Q26，2026-09-18 审计）：给了就先复核磁盘现状——`null` = 读的时候文件还不存在，
 * 字符串 = 当时读到的全文；不符就抛 CONFLICT 且一个字都不写。写在之后的"前缀逐字节还在"断言
 * 拦不住外部编辑：newText 就是拿旧 oldText 拼的，覆盖已发生时那条断言**必然通过**。
 */
function writeTextAtomic(file: string, text: string, expectOnDisk?: string | null): void {
  if (expectOnDisk !== undefined) {
    const onDisk = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
    if (onDisk !== expectOnDisk) {
      throw new WsError(
        "CONFLICT",
        `${AGENTS_MD_FILE} 在本次读取之后被别的进程/编辑器改过，塔台不覆盖别人的改动：请重新读取后再接入`,
      );
    }
  }
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, file);
}

/** attach 回执：落盘文件 + 本次是否真写了（false = 标记区已与模板一致，逐字节没动）+ 是否新建骨架 + 是否替换过标记区 */
export interface AttachAgentsMdResult {
  file: string;
  inserted: boolean;
  created: boolean;
  /** true = 标记区已存在但内容过期，本次只替换了标记区（用户自写规则一字未动） */
  updated: boolean;
}

/** 项目无 AGENTS.md 时的最小骨架（骨架之后才轮到约定段追加进来） */
function agentsMdSkeleton(projectName: string): string {
  return [`# ${projectName} AGENTS.md`, "", "> 任何 agent 进入本目录，先读完本文件再动手。", ""].join("\n");
}

/** 模板正文规范化：去掉尾部空白后补一个换行（区域比对与写回都用这一份口径） */
function normalizeSnippet(raw: string): string {
  return raw.replace(/\s+$/, "") + "\n";
}

export type ConvergeAction = "append" | "update" | "none";

export interface ConvergeResult {
  text: string;
  action: ConvergeAction;
}

/**
 * 标记区收敛（纯函数，便于隔离夹具单测）：只碰 `start..end` 之间那一段，
 * 标记区之外的文本逐字节原样保留。模板里没有成对标记时抛错（不写半截约定段）。
 */
export function convergeAgentsMdText(oldText: string, snippet: string): ConvergeResult {
  const region = normalizeSnippet(snippet);
  if (!region.includes(SNIPPET_START_MARK) || !region.includes(SNIPPET_END_MARK)) {
    throw new WsError("INVALID_INPUT", `约定段模板缺 ${SNIPPET_START_MARK} / ${SNIPPET_END_MARK} 标记`);
  }
  const start = oldText.indexOf(SNIPPET_START_MARK);
  if (start < 0) {
    if (oldText.length === 0) return { text: region, action: "append" };
    const joinNl = oldText.endsWith("\n") ? "" : "\n";
    const blankNl = oldText.endsWith("\n\n") ? "" : "\n";
    return { text: oldText + joinNl + blankNl + region, action: "append" };
  }
  const endMarkAt = oldText.indexOf(SNIPPET_END_MARK, start + SNIPPET_START_MARK.length);
  if (endMarkAt < 0) {
    throw new WsError(
      "CONFLICT",
      `${AGENTS_MD_FILE} 里有 ${SNIPPET_START_MARK} 但没有配对的 ${SNIPPET_END_MARK}：` +
        "标记区被手工破坏，塔台不猜边界、也不再加第二段——请先手工补齐或删掉那行标记再接入",
    );
  }
  const end = endMarkAt + SNIPPET_END_MARK.length;
  // 标记本体 = 模板**去掉尾部空白**：结束标记之后原来的字节（行尾 CRLF/LF、紧随其后的正文）属于
  // 标记区之外，更新时一个都不插、一个都不吞。模板的尾换行只在"没有标记区 → 末尾追加"那一支里
  // 用来补文件尾换行；把它塞进替换文本就会在原有后缀前多出一个 LF（V09-05 补修：含 CRLF 尾巴的
  // 文件首次收敛后出现 `<!-- end -->\n\r\n`）。
  const regionBody = region.replace(/\s+$/, "");
  const current = oldText.slice(start, end);
  if (current === regionBody) return { text: oldText, action: "none" };
  return { text: oldText.slice(0, start) + regionBody + oldText.slice(end), action: "update" };
}

/**
 * 往项目 AGENTS.md 接入/更新塔台约定段：
 * - 没有标记区 → 末尾追加（无 AGENTS.md 时先写最小骨架）；
 * - 标记区与模板逐字节一致 → 原样返回（inserted:false），一个字节都不写；
 * - 标记区过期 → 只替换标记区（updated:true），用户自写规则不动；
 * - 写入方式与 appendDiscuss 同惯例：读全文 → 算新文本 → 原子写回（临时文件 + rename）→
 *   写前复核磁盘未被外部改过 → 写后读盘复核「标记区之外逐字节没变」。
 */
export function attachAgentsMd(projectId: string, dataDir?: string): AttachAgentsMdResult {
  const project = getProject(projectId, dataDir);
  if (!project) {
    throw new WsError("PROJECT_NOT_FOUND", `项目不存在: ${projectId}`);
  }
  if (!fs.existsSync(SNIPPET_FILE)) {
    throw new WsError("INVALID_INPUT", `约定段模板缺失: ${SNIPPET_FILE}`);
  }
  const snippet = fs.readFileSync(SNIPPET_FILE, "utf8");
  const file = path.join(project.path, AGENTS_MD_FILE);
  const created = !fs.existsSync(file);
  // Q64：用户手写的 AGENTS.md 可能是 UTF-16（记事本"Unicode" / PS 5.1 `Out-File` 默认）——
  // 按 UTF-8 硬读再整份写回会把文件毁掉且不可逆，故交给统一的编码闸门，不合格就拒绝写
  const oldText = created ? agentsMdSkeleton(project.name) : readTextForAppend(file, AGENTS_MD_FILE);
  const converged = convergeAgentsMdText(oldText, snippet);
  if (converged.action === "none") {
    return { file, inserted: false, created: false, updated: false };
  }
  // Q26：写之前先确认磁盘还是"我们读到的那一份"（外部编辑器改过就报错，不覆盖别人的改动）
  writeTextAtomic(file, converged.text, created ? null : oldText);
  // 防吞行断言（读盘复核，不是信内存）：已有内容逐字节原样还在，**只有标记区那一段可能变**。
  const onDisk = fs.readFileSync(file, "utf8");
  if (onDisk !== converged.text) {
    throw new WsError("INVALID_INPUT", "AGENTS.md 接入红线 violation：写回后磁盘内容与我们算出的新文本不一致");
  }
  if (created && !onDisk.startsWith(oldText)) {
    throw new WsError("INVALID_INPUT", "AGENTS.md 接入红线 violation：新建骨架被吞");
  }
  if (!created) {
    const outsideUnchanged =
      converged.action === "append"
        ? onDisk.startsWith(oldText)
        : outsideRegionUnchanged(oldText, onDisk);
    if (!outsideUnchanged) {
      throw new WsError(
        "INVALID_INPUT",
        "AGENTS.md 接入红线 violation：标记区之外的用户自写规则被改动（疑似吞行）",
      );
    }
  }
  return { file, inserted: true, created, updated: converged.action === "update" };
}

/** 标记区之外的文本是否逐字节没变（收敛口径的强断言；标记区本身允许被替换） */
export function outsideRegionUnchanged(oldText: string, newText: string): boolean {
  const start = oldText.indexOf(SNIPPET_START_MARK);
  const endMarkAt = oldText.indexOf(SNIPPET_END_MARK, start + SNIPPET_START_MARK.length);
  if (start < 0 || endMarkAt < 0) return false;
  const end = endMarkAt + SNIPPET_END_MARK.length;
  const prefix = oldText.slice(0, start);
  const suffix = oldText.slice(end);
  return newText.startsWith(prefix) && newText.endsWith(suffix);
}
