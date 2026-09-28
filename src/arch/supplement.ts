// 2026-09-19 试用增强三期：架构图「聊天补全层」（主人拍板：聊天读过代码/文档后，
// 要能给模块方框图/数据流向图/思维导图补全节点与连边）。
//
// 与既有口径的关系（这是本层能立住的关键，不是绕过而是分层）：
// - 静态解析层（A1/A4：modules.json）的唯一写口仍是 POST /arch/parse，幂等覆盖不变——
//   聊天**碰不到**这一层；
// - 聊天补全写入**独立文件** `.工作台/arch/supplement.json`，只在渲染合成时
//   （render.ts#buildSharedGraph）**合并进**三视图共用的那份 SharedGraph——§3.2
//   「三视图共享同一份节点集合」的红线不破：合并点唯一，三视图看到的仍是同一份合并集，
//   任何模式照旧只能从这份集合取子集（graph-mode.ts 的 NODE_SET_RULE 语义不变）；
// - 补全节点 id 一律带 `chat:` 前缀（写入时自动补），与解析层 id 永不冲突；渲染层据
//   `origin:"chat"` 标记加徽标，人一眼能分清"解析出来的"与"聊天补的"；
// - 重新解析冲不掉补全（两个文件两层）；清空走聊天 replace，但**被引用的概念**（还有效补全边、
//   聊天动作回执或变更记录指向它）不许被 replace 连带删——写前核对，有引用则拒绝整次写入并指明
//   须走变更记录路径（DESIGN §3.2 / 判词 R1-ZS-003）。
//
// 上限（防一次补全把图打爆）：节点 100 / 边 200（写入时拒绝超限并如实回执）。
// 原子落盘：tmp + rename（半截写入最多留下一个 tmp 残文件，主文件永不错损）。
import fs from "node:fs";
import path from "node:path";
import { toIso } from "../server/time";
import { WsError, projectWorkDir, workstationDir } from "../server/workstation";
import { readModules } from "./parse";
import { MODULE_KINDS, type ModuleKind } from "./config";
import type { GraphEdge, GraphNode, SharedGraph } from "./shared-graph";

/** 补全节点 id 前缀：写入时自动补齐，保证与静态解析层的模块 id 永不冲突 */
export const CHAT_PREFIX = "chat:";
/** 补全层容量上限（写入时拒绝超限，不静默截断——回执里说清楚） */
export const MAX_SUP_NODES = 100;
export const MAX_SUP_EDGES = 200;

// 被引用核对的持久引用源文件名（与 chatActions.ts 的 CHAT_ACTIONS_FILE / CHAT_CHANGES_FILE 同名同目录）。
// 这里只按文件名 + projectWorkDir 拼路径，不 import chatActions（那条链经 blueprintAuto → render 会绕回
// supplement，徒增循环依赖）；路径与 chatActionWorkDir 同一口径。
const CHAT_ACTIONS_FILE = "chat-actions.jsonl";
const CHAT_CHANGES_FILE = "chat-changes.jsonl";

/** 补全层落盘的节点（规范化后：可选字段全部落成字符串，缺省有兜底） */
export interface SupNode {
  id: string;
  name: string;
  blurb: string;
  kind: ModuleKind;
  /** 对应真实目录时给相对路径（思维导图按它挂层级）；纯概念节点留空，挂在顶层 */
  path: string;
}

/** 补全层落盘的边（from/to 已规范化为合法 id；weight 固定 1——补全边没有 import 权重可言） */
export interface SupEdge {
  from: string;
  to: string;
  weight: number;
  note: string;
}

/** supplement.json 全文（version 固定 1；updated_at 每次写入刷新） */
export interface SupplementFile {
  version: 1;
  updated_at: string;
  nodes: SupNode[];
  edges: SupEdge[];
}

/** 聊天写入的入参形态（write_arch 工具透传；id 不带前缀也行，写入时自动补） */
export interface SupWriteInput {
  nodes?: { id?: string; name?: string; blurb?: string; kind?: string; path?: string }[];
  edges?: { from?: string; to?: string; note?: string }[];
  /** append=在现有补全上追加（默认）；replace=整体重写（要移除的旧概念若被引用则整次拒绝，见 collectReferences） */
  mode?: "append" | "replace";
}

/** 一次写入的回执（喂回模型，也让界面/验证能对账）。
 *  计数字段是老口径原样保留（已有验证脚本依赖）；2026-09-19 升级补两个逐条明细——
 *  模型拿一行计数不知道哪条丢、为什么丢，明细一行一条人话说清楚。 */
export interface SupWriteReceipt {
  mode: "append" | "replace";
  added_nodes: number;
  added_edges: number;
  skipped_duplicate_nodes: number;
  dropped_invalid_edges: number;
  dropped_invalid_nodes: number;
  capped: boolean;
  total_nodes: number;
  total_edges: number;
  parsed: boolean;
  /** 跳过的重复节点逐条明细（id/name/path 三口径哪个撞上写哪个，并写明已有节点的 id） */
  skipped_duplicates_detail: string[];
  /** 丢弃的边逐条明细（端点不存在时附 known 集里的相近节点建议，最多 3 个） */
  dropped_edges_detail: string[];
}

function supplementPath(projectId: string, dataDir?: string): string {
  return path.join(workstationDir(projectId, dataDir), "arch", "supplement.json");
}

/** 读补全层；没有文件返回 null（正常空态，不是错误） */
export function readSupplement(projectId: string, dataDir?: string): SupplementFile | null {
  const file = supplementPath(projectId, dataDir);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as SupplementFile;
  } catch (e) {
    throw new WsError(
      "ARCH_SUPPLEMENT_CORRUPT",
      `补全层文件不是合法 JSON：${(e as Error).message}（要修复可让聊天 replace 重写，或直接删该文件）`,
    );
  }
}

function atomicWrite(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, file);
}

function normKind(raw: unknown): ModuleKind {
  return MODULE_KINDS.includes(raw as ModuleKind) ? (raw as ModuleKind) : "mixed";
}

/** 模型给的 id 规范化：trim、空格换连字符、自动补 chat: 前缀；规范化后为空 = 无效 */
function normId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw.trim().replace(/\s+/g, "-");
  if (cleaned === "") return null;
  return cleaned.startsWith(CHAT_PREFIX) ? cleaned : CHAT_PREFIX + cleaned;
}

/** 模型给的端点 id 规范化（边端）：原样 trim；是否有效由 known 集校验（见 applySupplementInput） */
function normEndpoint(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw.trim();
  return cleaned === "" ? null : cleaned;
}

/** 编辑距离（Levenshtein，两行 DP）——边端点写错时的相近节点建议用 */
function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 3; // 长度差就超 2，不用算了
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[n];
}

/**
 * 端点不存在时在 known 集里找相近节点建议（最多 3 个，帮助模型自己改对）：
 *  (a) 去掉 chat: 前缀后相等（忽略大小写）；(b) 小写互相包含；(c) 编辑距离 ≤ 2。
 * 比较统一在「去前缀 + 小写」的形态上做——模型常把 chat:bus 写成 bus/Bus/bus2 一类。
 */
function suggestIds(endpoint: string, known: ReadonlySet<string>): string[] {
  const norm = (s: string) =>
    (s.startsWith(CHAT_PREFIX) ? s.slice(CHAT_PREFIX.length) : s).toLowerCase();
  const target = norm(endpoint);
  if (target === "") return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (id: string) => {
    if (out.length >= 3 || seen.has(id)) return;
    seen.add(id);
    out.push(id);
  };
  for (const id of known) if (norm(id) === target) push(id); // (a) 去前缀后相等
  for (const id of known) {
    const k = norm(id);
    if (k !== target && (k.includes(target) || target.includes(k))) push(id); // (b) 小写包含
  }
  for (const id of known) {
    const k = norm(id);
    if (k !== target && !(k.includes(target) || target.includes(k)) && editDistance(k, target) <= 2) {
      push(id); // (c) 编辑距离 ≤ 2
    }
  }
  return out;
}

/** 边被丢弃的一行人话原因（端点不存在时带相近节点建议） */
function edgeDropReason(
  from: string | null,
  to: string | null,
  known: ReadonlySet<string>,
): string {
  if (from === null || to === null) {
    return `边 ${from ?? "?"}→${to ?? "?"} 丢弃：端点缺失（from/to 得是非空节点 id）`;
  }
  if (from === to) return `边 ${from}→${to} 丢弃：自环（自己依赖自己不画）`;
  const bad = known.has(from) ? to : from;
  const near = suggestIds(bad, known);
  return `边 ${from}→${to} 丢弃：端点 ${bad} 不存在${near.length > 0 ? `。相近节点：${near.join("、")}` : ""}`;
}

/**
 * 读一份 JSONL 引用源（每行一个 JSON 对象）。文件不存在 = 正常空态（返回 []）；
 * 存在但读不动 / 有非法 JSON 行 = **抛错（fail-closed）**，绝不当作"无引用"放行——
 * 判断依据读不回来时宁拒不放（DESIGN §3.2 / 判词 R1-ZS-003 第 4 条）。
 */
function readRefJsonl(file: string, what: string): Record<string, unknown>[] {
  if (!fs.existsSync(file)) return [];
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    throw new WsError(
      "ARCH_SUPPLEMENT_REF_UNREADABLE",
      `${what}读取失败：${(e as Error).message}（补全层的被引用核对做不了，按 fail-closed 拒绝本次写入）`,
    );
  }
  const out: Record<string, unknown>[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const t = line.trim();
    if (t === "") return;
    let obj: unknown;
    try {
      obj = JSON.parse(t);
    } catch (e) {
      throw new WsError(
        "ARCH_SUPPLEMENT_REF_UNREADABLE",
        `${what}第 ${i + 1} 行不是合法 JSON：${(e as Error).message}（补全层的被引用核对做不了，按 fail-closed 拒绝本次写入）`,
      );
    }
    if (typeof obj !== "object" || obj === null) {
      throw new WsError(
        "ARCH_SUPPLEMENT_REF_UNREADABLE",
        `${what}第 ${i + 1} 行不是 JSON 对象（补全层的被引用核对做不了，按 fail-closed 拒绝本次写入）`,
      );
    }
    out.push(obj as Record<string, unknown>);
  });
  return out;
}

/** 一条被引用记录：被引用的补全概念 id + 引用来源（拒绝回执逐条列出） */
interface SupReference {
  id: string;
  sources: string[];
}

/**
 * 核对「变更前旧 ID − 新 ID」差集里的每个 id 是否被引用（DESIGN §3.2：被引用的概念只能经变更记录移除）。
 * 引用源按代码里**实际存在**的核（不虚构）：
 *   ① 补全层变更前的有效边（edges[].from/to 指向该 id）——即"有效关系"；
 *   ② `.工作台/work/chat-actions.jsonl` 的动作记录 affected_ids（写动作的真实写入回执，§3.6）；
 *   ③ `.工作台/work/chat-changes.jsonl` 的变更/问题记录 target（kind=concept 指向该 id）。
 * 注：蓝图/规划层 related_ids 经核实只引用 `plan:` 前缀 id（blueprint.ts 明说不碰 supplement.json），
 *     不构成补全概念的引用源，故不列入；不臆造不存在的引用源。
 * fail-closed：②③ 读不动或非法 JSON → 抛错，不按"无引用"放行。
 */
function collectReferences(
  projectId: string,
  removedIds: ReadonlySet<string>,
  priorEdges: readonly SupEdge[],
  dataDir?: string,
): SupReference[] {
  const found = new Map<string, string[]>();
  // 概念 id 可能带/不带 chat: 前缀（动作 affected_ids 带前缀，变更记录 target 的 id 形态不定）——
  // 两种形态都试一次，命中移除集即算被引用
  const addId = (rawId: string, source: string): void => {
    const cands = [rawId, rawId.startsWith(CHAT_PREFIX) ? rawId.slice(CHAT_PREFIX.length) : CHAT_PREFIX + rawId];
    for (const id of cands) {
      if (!removedIds.has(id)) continue;
      const arr = found.get(id) ?? [];
      if (!arr.includes(source)) arr.push(source);
      found.set(id, arr);
    }
  };
  // ① 变更前的补全层有效边（不许先把旧边清空再判"无引用"）
  for (const e of priorEdges) {
    addId(e.from, `补全层边 ${e.from}→${e.to}`);
    addId(e.to, `补全层边 ${e.from}→${e.to}`);
  }
  const workDir = projectWorkDir(projectId, dataDir);
  // ② 聊天动作记录的 affected_ids（动作级 + 逐条工具回执级）
  for (const a of readRefJsonl(path.join(workDir, CHAT_ACTIONS_FILE), "聊天动作记录 chat-actions.jsonl")) {
    const actionId = typeof a.action_id === "string" && a.action_id !== "" ? a.action_id : "?";
    const ids: unknown[] = Array.isArray(a.affected_ids) ? a.affected_ids : [];
    if (Array.isArray(a.tool_receipts)) {
      for (const r of a.tool_receipts) {
        const rr = r as Record<string, unknown> | null;
        if (rr !== null && typeof rr === "object" && Array.isArray(rr.affected_ids)) ids.push(...rr.affected_ids);
      }
    }
    for (const v of ids) if (typeof v === "string") addId(v, `聊天动作 ${actionId}`);
  }
  // ③ 变更/问题记录里指向概念的 target
  for (const c of readRefJsonl(path.join(workDir, CHAT_CHANGES_FILE), "变更/问题记录 chat-changes.jsonl")) {
    const t = c.target as Record<string, unknown> | null | undefined;
    if (t !== null && t !== undefined && typeof t === "object" && t.kind === "concept" && typeof t.id === "string" && t.id !== "") {
      const changeId = typeof c.change_id === "string" && c.change_id !== "" ? c.change_id : "?";
      addId(t.id, `变更/问题记录 ${changeId}`);
    }
  }
  return [...found.entries()].map(([id, sources]) => ({ id, sources })).sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * 应用一次聊天补全写入（write_arch 工具的执行体）。
 * 任何输入问题都以回执数字如实带回（无效节点丢弃计数、无效边丢弃计数、超限拒绝），
 * 只在落盘失败时抛（调用方 chatTools 会转成可读错误回执，不抛断聊天）。
 * 例外：replace 要移除的补全概念仍被引用时，**抛 ARCH_SUPPLEMENT_REFERENCED 拒绝整次写入**
 * （原文件不动；正式删除须走变更记录路径）——这是红线拒绝，不是"输入问题"，不折进回执计数。
 */
export function applySupplementInput(
  projectId: string,
  input: SupWriteInput,
  dataDir?: string,
): SupWriteReceipt {
  const mode = input.mode === "replace" ? "replace" : "append";
  // 变更前现场：replace 的引用核对必须基于它（不许先清空旧边再判"无引用"）；append 也复用它，免去二次读盘
  const prior = readSupplement(projectId, dataDir);
  const base: SupplementFile =
    mode === "replace" || prior === null ? { version: 1, updated_at: "", nodes: [], edges: [] } : prior;

  // 合法 id 全集 = 解析层模块 id + 现有补全 id + 本次新增 id（边的端点校验用）
  const known = new Set<string>();
  let parsed = false;
  try {
    const m = readModules(projectId, dataDir);
    if (m.exists && m.arch) {
      parsed = true;
      for (const mod of m.arch.modules) known.add(mod.id);
    }
  } catch {
    // 解析层读不了（未解析/损坏）：补全仍可写，边只能连补全节点之间
  }
  for (const n of base.nodes) known.add(n.id);

  const receipt: SupWriteReceipt = {
    mode,
    added_nodes: 0,
    added_edges: 0,
    skipped_duplicate_nodes: 0,
    dropped_invalid_nodes: 0,
    dropped_invalid_edges: 0,
    capped: false,
    total_nodes: 0,
    total_edges: 0,
    parsed,
    skipped_duplicates_detail: [],
    dropped_edges_detail: [],
  };

  // 查重三口径的「已有」索引：id 精确（byId，补全层内）/ name 相同（byName）/ path 相同（byPath，
  // 非空才算）。append 时对现有补全生效；本次批次内新收的节点也实时入索引（同批次撞车同样拦）。
  const byId = new Map(base.nodes.map((n) => [n.id, n]));
  const byName = new Map<string, SupNode>();
  const byPath = new Map<string, SupNode>();
  for (const n of base.nodes) {
    if (!byName.has(n.name)) byName.set(n.name, n);
    if (n.path !== "" && !byPath.has(n.path)) byPath.set(n.path, n);
  }
  for (const raw of input.nodes ?? []) {
    const id = normId(raw?.id ?? raw?.name);
    const name = typeof raw?.name === "string" ? raw.name.trim() : "";
    if (id === null || name === "") {
      receipt.dropped_invalid_nodes++;
      continue;
    }
    const path = typeof raw.path === "string" ? raw.path.trim().slice(0, 300) : "";
    // 查重升级：id 精确命中（含解析层 id）之外，name 相同、path（非空）相同也判重复——
    // 模型换个 id 再建同一个东西是常见跑偏，计数照旧、明细写明对上了哪个已有节点
    const idHitSup = byId.get(id);
    const idHitParse = idHitSup === undefined && known.has(id); // 解析层模块 id（补全不许顶掉它）
    const nameHit = byName.get(name);
    const pathHit = path !== "" ? byPath.get(path) : undefined;
    if (idHitSup !== undefined || idHitParse || nameHit !== undefined || pathHit !== undefined) {
      receipt.skipped_duplicate_nodes++;
      const reasons: string[] = [];
      if (idHitSup !== undefined || idHitParse) reasons.push("id 相同");
      if (nameHit !== undefined) reasons.push("name 相同");
      if (pathHit !== undefined) reasons.push("path 相同");
      const exist = pathHit ?? nameHit ?? idHitSup;
      receipt.skipped_duplicates_detail.push(
        idHitParse && exist === undefined
          ? `想建 ${id}(${name}) 与解析层模块 ${id} 重复：id 相同（解析层模块不可覆盖，换个 id 再补）`
          : `想建 ${id}(${name}) 与已有 ${exist!.id}(${exist!.name}) 重复：${reasons.join("｜")}（要更新请用已有 id 重写）`,
      );
      continue;
    }
    if (byId.size >= MAX_SUP_NODES) {
      receipt.capped = true;
      continue;
    }
    const node: SupNode = {
      id,
      name: name.slice(0, 60),
      blurb: typeof raw.blurb === "string" ? raw.blurb.trim().slice(0, 300) : "",
      kind: normKind(raw.kind),
      path,
    };
    byId.set(id, node);
    known.add(id);
    if (!byName.has(node.name)) byName.set(node.name, node);
    if (node.path !== "" && !byPath.has(node.path)) byPath.set(node.path, node);
    receipt.added_nodes++;
  }

  const edgeKey = new Set(base.edges.map((e) => `${e.from} ${e.to}`));
  // ── replace 的「旧 ID − 新 ID」差集：写前核对引用（DESIGN §3.2 / 判词 R1-ZS-003）──
  //  不只会拦 replace 空集：任何 replace 移除的旧概念都核。有引用 → 拒绝整次写入（抛错、原文件不动），
  //  返回被引用 ID 与来源；无引用 → 照常清删；append 不受影响。
  if (mode === "replace") {
    const keptIds = new Set(byId.keys()); // replace 下 byId 只装本次新收的节点，即写后保留集
    const removedIds = new Set((prior?.nodes ?? []).map((n) => n.id).filter((id) => !keptIds.has(id)));
    if (removedIds.size > 0) {
      const refs = collectReferences(projectId, removedIds, prior?.edges ?? [], dataDir);
      if (refs.length > 0) {
        const detail = refs.map((r) => `${r.id}（引用来源：${r.sources.join("；")}）`).join("、");
        throw new WsError(
          "ARCH_SUPPLEMENT_REFERENCED",
          `被引用的补全概念不能经 replace 移除：${detail}。DESIGN §3.2「被引用的概念只能通过变更记录移除，` +
            "不用 replace 空集连带删除有效关系」。正式删除须走可追溯且获授权的变更记录路径——" +
            "当前代码未实现该路径，故本次写入被整次拒绝、文件未改动。",
        );
      }
    }
  }

  const edges = [...base.edges];
  for (const raw of input.edges ?? []) {
    let from = normEndpoint(raw?.from);
    let to = normEndpoint(raw?.to);
    // 模型可能不带前缀引用补全节点名：裸名对不上时试补 chat: 前缀再对一次（解析层 id 优先原样）
    if (from !== null && !known.has(from) && known.has(CHAT_PREFIX + from)) from = CHAT_PREFIX + from;
    if (to !== null && !known.has(to) && known.has(CHAT_PREFIX + to)) to = CHAT_PREFIX + to;
    if (from === null || to === null || from === to || !known.has(from) || !known.has(to)) {
      receipt.dropped_invalid_edges++;
      receipt.dropped_edges_detail.push(edgeDropReason(from, to, known));
      continue;
    }
    const key = `${from} ${to}`;
    if (edgeKey.has(key)) {
      receipt.dropped_invalid_edges++;
      receipt.dropped_edges_detail.push(`边 ${from}→${to} 丢弃：这条边已存在（重复补边不算新写入）`);
      continue;
    }
    if (edges.length >= MAX_SUP_EDGES) {
      receipt.capped = true;
      continue;
    }
    edgeKey.add(key);
    edges.push({
      from,
      to,
      weight: 1,
      note: typeof raw.note === "string" ? raw.note.trim().slice(0, 200) : "",
    });
    receipt.added_edges++;
  }

  const file: SupplementFile = {
    version: 1,
    updated_at: toIso(new Date()),
    nodes: [...byId.values()],
    edges,
  };
  atomicWrite(supplementPath(projectId, dataDir), JSON.stringify(file, null, 2));
  receipt.total_nodes = file.nodes.length;
  receipt.total_edges = file.edges.length;
  return receipt;
}

/**
 * 渲染合成时合并补全层（render.ts#buildSharedGraph 调用，三视图共用的唯一合并点）。
 * 补全节点带 `origin:"chat"` 标记；补全边只保留端点在合并后节点集里的（防补全层残留
 * 悬空边——解析层节点被重解析改名后，旧边如实丢弃，不画自悬线）。不改入参，返回新对象。
 */
export function mergeSupplement(graph: SharedGraph, sup: SupplementFile): SharedGraph {
  const baseIds = new Set(graph.nodes.map((n) => n.id));
  const nodes: GraphNode[] = [...graph.nodes];
  for (const n of sup.nodes) {
    if (baseIds.has(n.id)) continue; // 与解析层撞 id（不该发生，前缀保证）：解析层优先
    nodes.push({
      id: n.id,
      name: n.name,
      path: n.path,
      blurb: n.blurb,
      kind: n.kind,
      file_count: 0,
      origin: "chat",
    });
  }
  const mergedIds = new Set(nodes.map((n) => n.id));
  const edges: GraphEdge[] = [...graph.edges];
  for (const e of sup.edges) {
    if (!mergedIds.has(e.from) || !mergedIds.has(e.to)) continue;
    edges.push({ from: e.from, to: e.to, weight: e.weight > 0 ? e.weight : 1 });
  }
  return { ...graph, nodes, edges };
}
