// V09-11：**数据流向图的目标语义**在真实项目上的派生层（只读；零运行时侵入采集）。
//
// 设计依据：DESIGN.md §3.2（实体／关系口径、来源三档与验证态、「当前实现 ≠ 目标」）、§11.2、
// §12.1-6／-18、附录 C.3、附录 G-3；施工定义见 PLAN V09-11。
//
// 本文件回答三件事：
//   ① **设计源声明**：项目设计原文里声明的数据输入／存储／输出逐条登记（带章节出处），
//      读时**复算**——声明片段必须仍在被引的章节里，复算不过就如实剔除（无效来源剔除，R3）；
//   ② **代码线索＋实测证据**：每条关系给真实 `file:line` 的读写/调用点；能指向**既有可复跑
//      验证脚本**的才够「可复跑实测」档（脚本必须真存在、真登记在 package.json、脚本正文真提到该路径）；
//   ③ **覆盖对账**：对该项目**所声明的**每个数据输入／存储／输出逐条对账——要么给路径与证据，
//      要么显式报「缺路径」并**阻断「项目可交付」**结论（缺路径不静默、不抽样代表全量）。
//
// **红线**（§3.2／§11.2）：静态 import 与「文件里出现这个数据文件名」这类字符串线索只进
// `static_clues`，**永不计入出处档位**，也不得据此生成「已验证」的数据边；本文件不写盘、不调模型、
// 不给纳管项目加任何埋点；口径与判据（R1–R6）的唯一出处是 `src/ui/arch/projectGraph.ts`。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getProject } from "../server/registry";
import { nowIso } from "../server/time";
import {
  DATA_FLOW_CURRENT_IMPLEMENTATION_NOTE,
  DATA_FLOW_ENTITY_KINDS,
  DATA_FLOW_RELATION_KINDS,
  DATA_FLOW_TARGET_SEMANTICS_NOTE,
  dataFlowBlockersOf,
  provenanceOf,
  verificationOf,
  type DataFlowChain,
  type DataFlowCoverage,
  type DataFlowCoverageRow,
  type DataFlowEdge,
  type DataFlowEntityKind,
  type DataFlowEvidenceRef,
  type DataFlowModel,
  type DataFlowNode,
  type DataFlowProvenanceTier,
  type DataFlowRelationKind,
  type DataFlowVerification,
} from "../ui/arch/projectGraph";

// ═══════════════════════ ① 出处声明与复算（R3：无效来源如何剔除） ═══════════════════════

/** 一条**待复算**的出处声明（不是结论）；复算失败一律剔除，不保留已经不作数的出处 */
interface EvidenceClaim {
  tier: DataFlowProvenanceTier;
  /** 项目根内相对路径（设计文档 / 代码文件） */
  path: string;
  /** 设计原文的章节锚（给了就只在**该章节区间内**找 `find`；不给＝全文找） */
  section?: string;
  /** 复算用的定位片段：必须原样出现在命中处 */
  find: string;
  /** 这一档出处证明的是哪一段（逐条上屏，不许一句"代码里有"糊过去） */
  note: string;
}

/** 文件缓存：同一份文件被多条声明引用时不重复读（口径同 render.ts 的读口，只读不写） */
type FileCache = Map<string, { lines: string[]; sha256: string } | null>;

const sha256Hex = (text: string): string => crypto.createHash("sha256").update(text, "utf8").digest("hex");

/** 读一份项目内文件（缺失／超限／二进制一律返回 null：如实说读不到，不编） */
function readCached(root: string, rel: string, cache: FileCache): { lines: string[]; sha256: string } | null {
  if (cache.has(rel)) return cache.get(rel) ?? null;
  let value: { lines: string[]; sha256: string } | null = null;
  try {
    const abs = path.resolve(root, rel);
    if (path.relative(root, abs).startsWith("..")) {
      value = null; // 项目根外的一律不读（不越界取数）
    } else {
      const stat = fs.statSync(abs);
      if (stat.isFile() && stat.size <= 4 * 1024 * 1024) {
        const text = fs.readFileSync(abs, "utf8");
        value = { lines: text.split(/\r?\n/), sha256: sha256Hex(text) };
      }
    }
  } catch {
    value = null;
  }
  cache.set(rel, value);
  return value;
}

/** 章节区间（1 基闭区间）：命中锚的那一行到下一个同级或更高级标题之前 */
function sectionRange(lines: readonly string[], anchor: string): { from: number; to: number } | null {
  const idx = lines.findIndex((l) => l.includes(anchor));
  if (idx < 0) return null;
  const head = /^(#{1,4})\s/.exec(lines[idx]);
  const level = head === null ? 6 : head[1].length;
  let end = lines.length;
  for (let i = idx + 1; i < lines.length; i++) {
    const h = /^(#{1,4})\s/.exec(lines[i]);
    if (h !== null && h[1].length <= level) {
      end = i;
      break;
    }
  }
  return { from: idx + 1, to: end };
}

export interface DroppedClaim {
  path: string;
  find: string;
  why: string;
}

/**
 * 复算一条出处声明（R3）：文件在、章节区间在、`find` 片段在区间内原样出现 ⇒ 给出 `path:line`；
 * 任一不成立 ⇒ 返回 null 并把原因记进 `dropped`（谁被剔了、为什么，全都要看得见）。
 */
function resolveClaim(
  root: string,
  claim: EvidenceClaim,
  cache: FileCache,
  dropped: DroppedClaim[],
): DataFlowEvidenceRef | null {
  const file = readCached(root, claim.path, cache);
  if (file === null) {
    dropped.push({ path: claim.path, find: claim.find, why: "文件不存在／读不到／超出体积上限（出处作废）" });
    return null;
  }
  const from = claim.section === undefined ? 1 : (sectionRange(file.lines, claim.section)?.from ?? -1);
  const to = claim.section === undefined ? file.lines.length : (sectionRange(file.lines, claim.section)?.to ?? -1);
  if (from < 0 || to < 0) {
    dropped.push({ path: claim.path, find: claim.find, why: `章节锚「${claim.section ?? ""}」在设计原文里找不到（声明位置失效）` });
    return null;
  }
  let hit = -1;
  for (let i = from - 1; i < to && i < file.lines.length; i++) {
    if (file.lines[i].includes(claim.find)) {
      hit = i + 1;
      break;
    }
  }
  if (hit < 0) {
    dropped.push({
      path: claim.path,
      find: claim.find,
      why: claim.section === undefined ? "定位片段在本文件里找不到（出处作废）" : `定位片段不在章节「${claim.section}」区间内（出处作废）`,
    });
    return null;
  }
  return {
    tier: claim.tier,
    path: claim.path,
    locator: `${claim.path}:${hit}`,
    find: claim.find,
    sha256: file.sha256,
    note: claim.note,
    rerun: null,
  };
}

// ═══════════════════════ ② 项目声明索引（设计源 → 数据输入／存储／输出） ═══════════════════════

/**
 * 声明的数据输入／存储／输出一行。
 * `find` 是**设计原文里的定位片段**——复算不过就说明设计原文已经不再这么声明，这条登记作废。
 */
interface DeclaredArtifact {
  id: string;
  /** 设计原文里的写法（逐字抄，便于人对着设计书核） */
  artifact: string;
  kind: DataFlowEntityKind;
  /** `declared_not_implemented`＝设计自己写明"尚未实现／未引入"（不算缺路径，但必须列出来） */
  declaration_status: "current" | "declared_not_implemented";
  design: EvidenceClaim;
  code: EvidenceClaim[];
  /** 它在链里是什么（一句话；没有路径时用来解释缺的是什么） */
  role: string;
  /** 对应到实体表里的哪个节点（缺省／null = 这条声明不对应链上的实体，不用字符串猜） */
  node_id?: string | null;
}

interface NodeSpec {
  id: string;
  kind: DataFlowEntityKind;
  label: string;
  role: string;
  claims: EvidenceClaim[];
  /** **只作线索**：静态 import／字符串线索（永不计入出处档位） */
  static_clues: { path: string; find: string; note: string }[];
}

interface EdgeSpec {
  id: string;
  from: string;
  to: string;
  relation: DataFlowRelationKind;
  label: string;
  claims: EvidenceClaim[];
  static_clues: { path: string; find: string; note: string }[];
  note: string;
}

interface ChainSpec {
  id: string;
  label: string;
  /** 逐跳节点 id（顺序即数据顺序） */
  hops: string[];
  /** 进入每一跳的那条关系 id（首跳 null） */
  edges: (string | null)[];
  note: string;
}

/** 可复跑实测：一条「哪个登记过的脚本真的走过这条路」的登记（脚本必须存在＋登记在 package.json＋正文提到该路径） */
interface MeasuredSpec {
  id: string;
  /** 指向既有可复跑验证脚本（项目根内相对路径） */
  script: string;
  /** package.json 里的入口名（拿不到就等于不可复跑，这条实测不算数） */
  npm_script: string;
  /** 脚本正文里必须原样出现的片段（复算 → 行号；找不到 ⇒ 这条实测作废） */
  find: string;
  /** 它证的是哪一段路径真的走过 */
  proves: string;
  artifact_ids: string[];
  node_ids: string[];
  edge_ids: string[];
}

export interface ProjectIndex {
  /** 设计原文（项目根内相对路径） */
  design_path: string;
  artifacts: readonly DeclaredArtifact[];
  nodes: readonly NodeSpec[];
  edges: readonly EdgeSpec[];
  chains: readonly ChainSpec[];
  measured: readonly MeasuredSpec[];
}

const dc = (path_: string, section: string, find: string, note: string): EvidenceClaim => ({
  tier: "design_declared",
  path: path_,
  section,
  find,
  note,
});
const cc = (path_: string, find: string, note: string): EvidenceClaim => ({ tier: "code_static", path: path_, find, note });

/** 设计原文里的章节锚（塔台自身 DESIGN.md；逐条声明都挂在下面这些章节上） */
const S22 = "### 2.2 每个项目内的";
const S231 = "#### 2.3.1 全局注册表";
const S232 = "#### 2.3.2 进度";
const S233 = "#### 2.3.3 Gate 流水";
const S234 = "#### 2.3.4 任务";
const S235 = "#### 2.3.5 变更流水";
const S236 = "#### 2.3.6 聊天";
const S26 = "### 2.6 权威数据与派生内容";
const S84 = "### 8.4 SQLite 缓存范围";

/**
 * 声明 → 实体表节点的对应（**显式写出来**，不用字符串互相猜）。
 * 不对应链上任何实体的声明（如布局记忆、折叠记忆）就没有这一行——"没有对应"是如实，不是遗漏。
 */
const ARTIFACT_NODE_ID: Readonly<Record<string, string>> = {
  "df-art-design": "df-node-design-source",
  "df-art-modules": "df-node-arch-modules",
  "df-art-work-events": "df-node-work-events",
  "df-art-work-state": "df-node-work-state",
};

/** 声明片段片段（怕写错就在一处集中：它们必须逐字出现在被引章节里，否则复算失败、该行如实报缺） */
const D_DESIGN = "design.md               # 设计书（唯一事实源）";
const D_DISCUSS = "design.discuss.md       # 待议记录（执行 agent 只能追加到这里）";
const D_PROGRESS = "progress.json           # 进度：Gate 与模块状态；任务列表在 tasks.json";
const D_GATE = "gate.jsonl              # Gate 过关/打回流水（带时间戳）";
const D_TASKS = "tasks.json              # 任务级状态（agent 经 MCP 自报）";
const D_CHAT = "chat/";
const D_CHANGES = "changes.jsonl           # 变更流水（文件监听顺带产出，简版）";
const D_MODULES = "modules.json        # 顶层模块骨架（tree-sitter + Flash 起名后的产物）";
const D_LAYOUT = "layout.json         # 布局位置记忆（刷新不跳动）";
const D_NAMES = "names.json          # 模块人话名缓存（Flash 起名结果，重命名刷新用）";
const D_FOLD = "mindmap-fold.json   # 思维导图折叠记忆（展开/收起状态）";
const D_RECONCILE = "reconcile-last.json / reconcile-request.json  # 对账上下文（上次结果 / 待处理请求）";
const D_SUPPLEMENT = "supplement.json     # 聊天补全层（§3.2；节点 id 一律 chat: 前缀）";
const D_LOGS = "logs/                   # 运行日志";
const D_REGISTRY = "全局注册表 `<工作根目录>/.tatai/registry.json`";
const D_FACTS = "| 任务、执行请求、认领、检查点、交付、审计状态 | `.工作台/work/events.jsonl` 的已提交事件 |";
const D_STATE = "`work/state.json` 为带 `last_seq` 的可重建快照";
const D_EVIDENCE = "| 证据正文 | `.工作台/evidence/<evidence_id>/` 中不可变内容与清单 |";
const D_THREE = "| 意图/决策/基线确认 | `.工作台/intent.json`、`decisions.jsonl`、`baselines.jsonl` 各管一种记录 |";
const D_DESIGN_REV = "写入 `.工作台/design-revisions/<sha256>.md` 不可变历史对象并校验哈希";
const D_SQLITE = "以下为备选缓存设计，目前未引入 SQLite；确有检索/索引瓶颈再启用。";

/** 塔台自身的声明索引（设计源＝根 `DESIGN.md`；其他项目没有登记就不做对账——如实报「未登记」） */
const TATAI_INDEX: ProjectIndex = {
  design_path: "DESIGN.md",
  artifacts: [
    {
      id: "df-art-design",
      artifact: ".工作台/design.md（塔台自身＝根 DESIGN.md）",
      kind: "input_source",
      declaration_status: "current",
      design: dc("DESIGN.md", S22, D_DESIGN, "§2.2 目录约定：设计书是唯一事实源"),
      code: [cc("src/server/work/documents.ts", 'design: loadDocument(projectId, "design", dataDir)', "读点：文档读口从这里把设计原文读进来")],
      role: "设计源：能力/模块/任务与数据输入输出的声明都从这里来",
    },
    {
      id: "df-art-discuss",
      artifact: ".工作台/design.discuss.md",
      kind: "input_source",
      declaration_status: "current",
      design: dc("DESIGN.md", S22, D_DISCUSS, "§2.2 目录约定：待议记录只追加"),
      code: [cc("src/server/workstation.ts", "export function readDiscuss(projectId: string, dataDir?: string): DiscussDoc {", "读点：待议正文从这份文件读")],
      role: "输入源：待议意见（Agent 只能追加）",
    },
    {
      id: "df-art-registry",
      artifact: "<工作根目录>/.tatai/registry.json",
      kind: "store",
      declaration_status: "current",
      design: dc("DESIGN.md", S231, D_REGISTRY, "§2.3.1 全局注册表：项目清单的唯一出处"),
      code: [cc("src/server/registry.ts", 'const REGISTRY_FILE = "registry.json";', "读写点：注册表的文件名常量（读写都经 registry.ts）")],
      role: "存储：全局项目注册表（工作台全局层）",
    },
    {
      id: "df-art-progress",
      artifact: ".工作台/progress.json",
      kind: "store",
      declaration_status: "current",
      design: dc("DESIGN.md", S22, D_PROGRESS, "§2.2 目录约定：进度与模块状态"),
      code: [cc("src/server/workstation.ts", 'const PROGRESS_FILE = "progress.json";', "读写点：progress.json 的文件名常量")],
      role: "存储：进度（兼容投影；模块四色读数来源）",
    },
    {
      id: "df-art-gate",
      artifact: ".工作台/gate.jsonl",
      kind: "store",
      declaration_status: "current",
      design: dc("DESIGN.md", S22, D_GATE, "§2.2 目录约定：Gate 流水"),
      code: [cc("src/server/workstation.ts", 'const GATE_JSONL_FILE = "gate.jsonl";', "读写点：gate.jsonl 的文件名常量")],
      role: "存储：Gate 过关/打回流水",
    },
    {
      id: "df-art-tasks",
      artifact: ".工作台/tasks.json",
      kind: "store",
      declaration_status: "current",
      design: dc("DESIGN.md", S22, D_TASKS, "§2.2 目录约定：任务级状态"),
      code: [cc("src/server/work/tasks.ts", "兼容投影写回 `.工作台/tasks.json`", "写点：v2 任务事件投影回写成 tasks.json（兼容投影）")],
      role: "存储：任务台账（v2 下是兼容投影）",
    },
    {
      id: "df-art-chat",
      artifact: ".工作台/chat/<session>.jsonl",
      kind: "input_source",
      declaration_status: "current",
      design: dc("DESIGN.md", S236, "chat/<session>.jsonl", "§2.3.6：聊天按会话落盘，一行一条消息"),
      code: [cc("src/server/chat.ts", "<项目根>/.工作台/chat/<sessionId>.jsonl", "读写点：聊天落盘路径（同步 append，实时落盘红线）")],
      role: "输入源：与内置深度的讨论记录（可作意图来源引用）",
    },
    {
      id: "df-art-changes",
      artifact: ".工作台/changes.jsonl",
      kind: "store",
      declaration_status: "current",
      design: dc("DESIGN.md", S235, "changes.jsonl", "§2.3.5：变更流水（文件监听顺带产出，一行一条）"),
      code: [cc("src/server/watcher.ts", 'const CHANGES_JSONL_FILE = "changes.jsonl";', "写点：变更流水文件名常量（监听器合批追加）")],
      role: "存储：文件变更流水（简版）",
    },
    {
      id: "df-art-modules",
      artifact: ".工作台/arch/modules.json",
      kind: "store",
      declaration_status: "current",
      design: dc("DESIGN.md", S22, D_MODULES, "§2.2 目录约定：模块骨架"),
      code: [cc("src/arch/parse.ts", 'path.join(root, ".工作台", "arch", "modules.json")', "读写点：解析层唯一写口落盘位置")],
      role: "存储：顶层模块骨架（静态解析产物）",
    },
    {
      id: "df-art-layout",
      artifact: ".工作台/arch/layout.json",
      kind: "store",
      declaration_status: "current",
      design: dc("DESIGN.md", S22, D_LAYOUT, "§2.2 目录约定：布局位置记忆"),
      code: [cc("src/arch/layoutStore.ts", 'path.join(root, ".工作台", "arch", "layout.json")', "读写点：布局记忆落盘位置")],
      role: "存储：布局位置记忆",
    },
    {
      id: "df-art-names",
      artifact: ".工作台/arch/names.json",
      kind: "store",
      declaration_status: "current",
      design: dc("DESIGN.md", S22, D_NAMES, "§2.2 目录约定：模块人话名缓存"),
      code: [cc("src/arch/name.ts", 'path.join(root, ".工作台", "arch", "names.json")', "读写点：起名缓存落盘位置")],
      role: "存储：模块人话名缓存",
    },
    {
      id: "df-art-fold",
      artifact: ".工作台/arch/mindmap-fold.json",
      kind: "store",
      declaration_status: "current",
      design: dc("DESIGN.md", S22, D_FOLD, "§2.2 目录约定：思维导图折叠记忆"),
      code: [cc("src/arch/foldStore.ts", 'path.join(root, ".工作台", "arch", "mindmap-fold.json")', "读写点：折叠记忆落盘位置")],
      role: "存储：思维导图折叠记忆",
    },
    {
      id: "df-art-reconcile",
      artifact: ".工作台/arch/reconcile-last.json / reconcile-request.json",
      kind: "store",
      declaration_status: "current",
      design: dc("DESIGN.md", S22, D_RECONCILE, "§2.2 目录约定：对账上下文（上次结果 / 待处理请求）"),
      code: [
        cc("src/arch/reconcile.ts", 'const RECONCILE_LAST_FILE = "reconcile-last.json";', "读写点：对账结果落盘文件名常量"),
        cc("src/arch/reconcile.ts", 'const RECONCILE_REQUEST_FILE = "reconcile-request.json";', "读写点：对账请求钩子（存在即读后清除）"),
      ],
      role: "存储：规划↔实现对账的上次结果与待处理请求",
    },
    {
      id: "df-art-supplement",
      artifact: ".工作台/arch/supplement.json",
      kind: "input_source",
      declaration_status: "current",
      design: dc("DESIGN.md", S22, D_SUPPLEMENT, "§2.2 目录约定：聊天补全层"),
      code: [cc("src/arch/render.ts", "readSupplement", "读点：共用数据层合成时把补全层读进来")],
      role: "输入源：聊天补全层（概念模块），不自动升格为审定架构",
    },
    {
      id: "df-art-logs",
      artifact: ".工作台/logs/",
      kind: "store",
      declaration_status: "current",
      design: dc("DESIGN.md", S22, D_LOGS, "§2.2 目录约定：运行日志"),
      code: [cc("src/server/terminalHistory.ts", 'export const HISTORY_DIR_NAME = "logs";', "读写点：`.工作台/logs/` 下的终端历史（只追加）")],
      role: "存储：项目内运行日志（终端历史）",
    },
    {
      id: "df-art-work-events",
      artifact: ".工作台/work/events.jsonl",
      kind: "store",
      declaration_status: "current",
      design: dc("DESIGN.md", S26, D_FACTS, "§2.6 权威数据表：任务/执行/认领/交付/审计状态的唯一事实源"),
      code: [
        cc("src/server/work/eventStore.ts", 'export const EVENTS_FILE = "events.jsonl";', "读写点：事件台账文件名（唯一事实源）"),
        cc("src/server/work/eventStore.ts", "export function appendEventDurable(workDir: string, event: WorkEvent): void {", "写点：追加事件并 fsync 后才回执（落盘顺序）"),
      ],
      role: "存储：v2 事件台账（唯一事实源）",
    },
    {
      id: "df-art-work-state",
      artifact: ".工作台/work/state.json",
      kind: "store",
      declaration_status: "current",
      design: dc("DESIGN.md", S26, D_STATE, "§2.6：state.json 是可重建快照，不是事实源"),
      code: [cc("src/server/work/eventStore.ts", "export function writeSnapshot(workDir: string, snapshot: WorkSnapshot): void {", "写点：原子写快照（临时文件 + rename）")],
      role: "存储：事件重放出的可重建快照",
    },
    {
      id: "df-art-evidence",
      artifact: ".工作台/evidence/<evidence_id>/",
      kind: "store",
      declaration_status: "current",
      design: dc("DESIGN.md", S26, D_EVIDENCE, "§2.6：证据正文不可变，事件只引用 ID/哈希"),
      code: [cc("src/server/work/evidence.ts", 'export const EVIDENCE_DIRNAME = "evidence";', "写点：证据正文按内容寻址落盘目录")],
      role: "存储：不可变证据正文",
    },
    {
      id: "df-art-design-revisions",
      artifact: ".工作台/design-revisions/<sha256>.md",
      kind: "store",
      declaration_status: "current",
      design: dc("DESIGN.md", S26, D_DESIGN_REV, "§2.6：基线必须引用可取回的原文，未提交的落不可变历史对象"),
      code: [cc("src/server/work/documents.ts", 'export const DESIGN_REVISIONS_DIR = "design-revisions";', "写点：设计修订历史对象目录常量")],
      role: "存储：设计修订的不可变历史对象",
    },
    {
      id: "df-art-plan-revisions",
      artifact: ".工作台/plan-revisions/<definition_sha256>.md",
      kind: "store",
      declaration_status: "current",
      design: dc("DESIGN.md", S26, "保存到 `.工作台/plan-revisions/<definition_sha256>.md` 或可长期保留的 Git blob", "§2.6：施工定义同样落不可变历史对象"),
      code: [cc("src/server/work/documents.ts", 'export const PLAN_REVISIONS_DIR = "plan-revisions";', "写点：施工定义修订历史对象目录常量")],
      role: "存储：施工定义修订的不可变历史对象",
    },
    {
      id: "df-art-decisions",
      artifact: ".工作台/decisions.jsonl",
      kind: "store",
      declaration_status: "current",
      design: dc("DESIGN.md", S26, D_THREE, "§2.6：意图/决策/基线三件套各自的记录文件"),
      code: [cc("src/server/work/decisions.ts", 'export const DECISIONS_FILE = "decisions.jsonl";', "写点：处置记录只追加落盘文件名常量")],
      role: "存储：处置记录（只追加）",
    },
    {
      id: "df-art-baselines",
      artifact: ".工作台/baselines.jsonl",
      kind: "store",
      declaration_status: "current",
      design: dc("DESIGN.md", S26, D_THREE, "§2.6：基线确认记录（只引用原文哈希与恢复位置）"),
      code: [cc("src/server/work/documents.ts", 'export const BASELINES_FILE = "baselines.jsonl";', "写点：基线记录只追加入口")],
      role: "存储：基线记录（只追加）",
    },
    {
      id: "df-art-intent",
      artifact: ".工作台/intent.json",
      kind: "input_source",
      declaration_status: "current",
      design: dc("DESIGN.md", S26, D_THREE, "§2.6 明写意图正文的唯一写入源＝intent.json/聊天记录/设计原文"),
      // 如实：这份文件**由人直接编写**（同族于根 DESIGN.md），所以产品侧**不设写口**——§2.5 明写
      // 「intent.json 是人的意图记录，可作为 requirement 的来源被引用，不另建一份可独立编辑的需求库」，
      // 产品侧的必需能力是**读/解析/引用校验**。下列读点即该能力的真实落点（引用校验的实解析）；
      // 本行不再是缺路径，但**不许**因为"对账好看"就不给证据或把它删掉。
      code: [
        cc("src/server/work/intent.ts", "export function readIntentFile(workbenchDir: string): IntentFile | null {", "读点：意图原文按 {version,items} 解析读回（文件不在如实返回 null，不造假条目）"),
        cc("src/server/work/intent.ts", "export function resolveIntentRef(workbenchDir: string, ref: string): IntentRefLookup {", "读点+校验点：`intent.json#<id>` / 裸 `<id>` 在原文里实解析，悬空与坏文件不放过"),
        cc("src/server/work/requirements.ts", "export function assertIntentSourceValid(", "判据本体（单一出处）：对象命令侧与唯一写入服务边界共用这一个函数，不复制第二套"),
        cc("src/server/work/requirements.ts", "assertIntentSourceResolvable(submitter, fields.source, `注册 ${input.requirement_id}`);", "校验点：需求登记前核 `source.kind=\"intent\"` 的引用有效性，悬空点名拒、零写入"),
        cc("src/server/work/requirements.ts", "assertIntentSourceResolvable(submitter, patch.source, `更新 ${input.requirement_id}`);", "校验点：需求更新改来源引用时同样实解析（改 ref 也要核）"),
        cc("src/server/work/service.ts", "assertRequirementIntentSourceResolvable(cmd, this.dataDir);", "校验点：唯一写入服务边界——直连 `WorkService.submit` 的 requirement.registered/updated 也核同一份判据，绕过对象命令不能旁路（§2.5 一致校验面）"),
      ],
      role: "人直接编写的意图原文；产品侧读点=引用解析与登记校验（对象命令与唯一写入服务边界同一份判据）",
    },
    {
      id: "df-art-sqlite",
      artifact: "SQLite 缓存（projects / modules / changes_agg / search_fts）",
      kind: "store",
      declaration_status: "declared_not_implemented",
      design: dc("DESIGN.md", S84, D_SQLITE, "§8.4：设计自己写明「目前未引入 SQLite」——列出来但不计入缺路径"),
      code: [],
      role: "存储：备选缓存（设计声明为未引入）",
    },
  ],
  nodes: [
    {
      id: "df-node-mcp-client",
      kind: "input_source",
      label: "Agent 经 MCP 提交的结构化命令",
      role: "输入源：外部 Agent 客户端按 §6.7 发起的认领/回报/读取请求",
      claims: [
        dc("DESIGN.md", S26, "校验、追加事件和生成成功回执由同一个本地写入服务串行负责", "§2.6：写入经唯一写入服务仲裁，MCP 做转接"),
        cc("src/mcp/tools/projectEntry.ts", 'name: "submit_task_result"', "输入入口：结果回报工具的声明（MCP 工具面接收入参）"),
      ],
      static_clues: [],
    },
    {
      id: "df-node-design-source",
      kind: "input_source",
      label: "设计源（DESIGN.md／PLAN.md；项目＝.工作台/design.md 与 plan.md）",
      role: "输入源：能力/模块/任务与声明的数据输入输出都来自这里",
      claims: [
        dc("DESIGN.md", S26, "| 设计原文 | DESIGN.md（塔台）或已登记的项目设计路径，是唯一当前编辑源 |", "§2.6：设计原文是唯一当前编辑源"),
        cc("src/arch/blueprint.ts", "export function readBlueprintSources(projectId: string, dataDir?: string): BlueprintSources {", "读点：派生规划图时把设计/施工原文与代码模块一起读进来"),
      ],
      static_clues: [],
    },
    {
      id: "df-node-code-source",
      kind: "input_source",
      label: "代码线索源（tree-sitter 静态解析的项目源码）",
      role: "输入源：模块/依赖/文件落点线索；**静态 import 属其中最弱一档**",
      claims: [cc("src/arch/parse.ts", "产出 .工作台/arch/modules.json 供 A2 Flash 起名（name 字段留空）与 A3 React Flow 渲染。", "代码线索来源：树解析产出模块骨架与聚合依赖边")],
      static_clues: [],
    },
    {
      id: "df-node-mcp-tools",
      kind: "process",
      label: "MCP 工具面（src/mcp/tools）",
      role: "处理：入参闭键/必填守卫 + 对象命令规划（不自己写文件）",
      claims: [
        cc("src/mcp/tools/projectEntry.ts", "const outcome = await submitTaskResult(", "处理点：工具面把请求交给领域层（自己不做写入）"),
        cc("src/mcp/tools/workObjects.ts", "function assertToolArgs(args: Record<string, unknown>, allowed: readonly string[], what: string): void {", "处理点：入参闭键守卫（多余键一律拒）"),
      ],
      static_clues: [],
    },
    {
      id: "df-node-claims",
      kind: "process",
      label: "任务交付检查（src/server/work/claims.ts#submitTaskResult）",
      role: "处理：重查任务版本/认领 token/租约/依赖释放/证据引用，任一项不过即拒且零写入",
      claims: [cc("src/server/work/claims.ts", "export async function submitTaskResult(", "处理点：交付前的五项重查（拒则零字节）")],
      static_clues: [],
    },
    {
      id: "df-node-write-service",
      kind: "process",
      label: "唯一写入服务（WorkService.submit / 转接客户端）",
      role: "处理：服务边界再校验一次，追加事件并持久化后才回执（单写者）",
      claims: [
        cc("src/server/work/service.ts", "appendEventDurable(workDir, event);", "写点：唯一写入者在同一处追加事件（MCP 只转接）"),
        cc("src/server/work/service.ts", "export class WorkServiceClient {", "传递点：MCP 侧的转接客户端（POST /api/work/command；服务离线一律 SERVICE_UNAVAILABLE，绝不本地代写）"),
      ],
      static_clues: [],
    },
    {
      id: "df-node-work-events",
      kind: "store",
      label: ".工作台/work/events.jsonl",
      role: "存储：v2 事件台账（唯一事实源；appends + fsync）",
      claims: [
        dc("DESIGN.md", S26, "落盘顺序为校验→追加完整事件并持久化→返回提交序号→更新投影", "§2.6：落盘顺序（写事实在前、读投影在后）"),
        cc("src/server/work/eventStore.ts", "export function appendEventDurable(workDir: string, event: WorkEvent): void {", "写点：追加事件并 fsync（半截尾先隔离再截断）"),
      ],
      static_clues: [],
    },
    {
      id: "df-node-work-state",
      kind: "store",
      label: ".工作台/work/state.json",
      role: "存储：事件重放出的可重建快照（删掉可重建，不是事实源）",
      claims: [cc("src/server/work/eventStore.ts", "export function writeSnapshot(workDir: string, snapshot: WorkSnapshot): void {", "写点：快照原子写（临时文件 + rename）")],
      static_clues: [],
    },
    {
      id: "df-node-arch-modules",
      kind: "store",
      label: ".工作台/arch/modules.json",
      role: "存储：静态解析出的模块骨架与聚合依赖边（六图的代码侧输入）",
      claims: [cc("src/arch/parse.ts", 'path.join(root, ".工作台", "arch", "modules.json")', "写点：解析层唯一写口")],
      static_clues: [],
    },
    {
      id: "df-node-projection",
      kind: "process",
      label: "状态投影（事件 → 逐对象状态）",
      role: "处理：把事件重放折成逐对象状态（执行/质量/验收/新鲜度），图与读口都从这里取",
      claims: [
        cc("src/server/work/statusProjection.ts", "export function projectStatuses(input: StatusProjectionInput): StatusProjectionSet {", "处理点：事件折成状态投影"),
        cc("src/server/work/entry.ts", "export function projectWithReleases(facts: {", "处理点：接续入口用的投影合成（与 get_arch 同一份）"),
      ],
      static_clues: [],
    },
    {
      id: "df-node-six-graphs",
      kind: "output_external",
      label: "六图输出（三个主视图 + 技术详情三图）",
      role: "输出：状态投影 + 规划图渲染出的六张图（含数据流向图的当前实现）",
      claims: [
        cc("src/arch/blueprint.ts", "export function deriveBlueprint(src: BlueprintSources, opts: DeriveOptions): Blueprint {", "输出点：规划图派生（三个主视图的规划层数据）"),
        cc("src/ui/components/ArchView.tsx", "const derived = taskDerivedModuleStatus({ blueprint, projection, declared_links: links });", "输出点：技术详情三图与主视图同源的模块状态派生"),
      ],
      static_clues: [],
    },
    {
      id: "df-node-mcp-readout",
      kind: "output_external",
      label: "MCP 读口返回（project_entry / list_tasks / get_arch 等）",
      role: "输出/外部系统：把状态事实与来源分层交给外部 Agent 客户端",
      claims: [cc("src/mcp/tools/getArch.ts", "export const getArchTool: McpTool = {", "输出点：技术详情层读口（状态来源与数据流向口径随返回体给出）")],
      static_clues: [],
    },
  ],
  edges: [
    {
      id: "df-edge-client-tools",
      from: "df-node-mcp-client",
      to: "df-node-mcp-tools",
      relation: "transfer",
      label: "MCP 请求进入工具面",
      claims: [cc("src/mcp/tools/projectEntry.ts", 'name: "submit_task_result"', "入口点：工具声明与 handler 在同一处接收结构化入参")],
      static_clues: [{ path: "src/mcp/index.ts", find: "createTataiMcpServer", note: "工具面注册入口（静态调用线索，只作线索）" }],
      note: "外部客户端的结构化命令进入工具面；工具面本身不写文件",
    },
    {
      id: "df-edge-tools-claims",
      from: "df-node-mcp-tools",
      to: "df-node-claims",
      relation: "transfer",
      label: "工具面交领域层做交付检查",
      claims: [cc("src/mcp/tools/projectEntry.ts", "const outcome = await submitTaskResult(", "调用点：工具面把请求交给 claims 层（重查后再写）")],
      static_clues: [],
      note: "校验在领域层做一遍，工具面只规划与透传",
    },
    {
      id: "df-edge-claims-service",
      from: "df-node-claims",
      to: "df-node-write-service",
      relation: "transfer",
      label: "经转接客户端提交给唯一写入服务",
      claims: [
        cc("src/server/work/claims.ts", "const receipt = await deps.submitter.submit(", "调用点：五项重查全过才提交命令（不过就是零字节）"),
        cc("src/server/work/service.ts", 'return await fetch(`http://${desc.host}:${desc.port}/api/work/command`, {', "传递点：转接客户端把命令 POST 给唯一写入服务"),
      ],
      static_clues: [],
      note: "唯一写入服务是命令的唯一落点；服务不在就报 SERVICE_UNAVAILABLE，不退化成自己写文件",
    },
    {
      id: "df-edge-service-events",
      from: "df-node-write-service",
      to: "df-node-work-events",
      relation: "read_write",
      label: "写：追加事件到事件台账",
      claims: [
        cc("src/server/work/service.ts", "appendEventDurable(workDir, event);", "写点：服务边界内追加事件（fsync 后才回执）"),
        cc("src/server/work/eventStore.ts", "export function appendEventDurable(workDir: string, event: WorkEvent): void {", "写点：事件追加的唯一实现（含半截尾隔离）"),
      ],
      static_clues: [],
      note: "追加已持久化才返回提交序号；这一步之后才算事实成立",
    },
    {
      id: "df-edge-service-state",
      from: "df-node-write-service",
      to: "df-node-work-state",
      relation: "read_write",
      label: "写：重放事件后落快照",
      claims: [cc("src/server/work/eventStore.ts", "export function writeSnapshot(workDir: string, snapshot: WorkSnapshot): void {", "写点：快照原子写（投影失败只标记，不回滚事实）")],
      static_clues: [],
      note: "快照是派生数据：删掉可重建，不作为事实源",
    },
    {
      id: "df-edge-events-projection",
      from: "df-node-work-events",
      to: "df-node-projection",
      relation: "read_write",
      label: "读：事件重放成逐对象状态",
      claims: [
        cc("src/server/work/eventStore.ts", "export function replayEvents(events: WorkEvent[]): {", "读点：按 seq 连续性重放事件（有洞就抛，不降级）"),
        cc("src/server/work/statusProjection.ts", "export function collectProjectFacts(", "读点：从台账与导入定义收集投影所需事实"),
      ],
      static_clues: [],
      note: "投影只读事实源；投影失败可重放修复",
    },
    {
      id: "df-edge-design-graphs",
      from: "df-node-design-source",
      to: "df-node-six-graphs",
      relation: "transform",
      label: "转换：设计/施工原文派生成规划图与六图",
      claims: [cc("src/arch/blueprint.ts", "export function deriveBlueprint(src: BlueprintSources, opts: DeriveOptions): Blueprint {", "转换点：设计/施工原文 → 规划图（确定性派生）")],
      static_clues: [],
      note: "派生带来源引用（design_section/plan_task/code_module），不是模型自由发挥",
    },
    {
      id: "df-edge-code-modules",
      from: "df-node-code-source",
      to: "df-node-arch-modules",
      relation: "produce",
      label: "产生：静态解析产出模块骨架",
      claims: [cc("src/arch/parse.ts", "产出 .工作台/arch/modules.json 供 A2 Flash 起名（name 字段留空）与 A3 React Flow 渲染。", "产生点：树解析产出模块骨架与聚合依赖边（唯一写口）")],
      static_clues: [{ path: "src/arch/parse.ts", find: "tree-sitter", note: "静态 import 正是这里解析的对象；它对数据流只作线索，不生成已验证的数据边（R4）" }],
      note: "这条边本身就是「静态 import 属最弱一档」的落点：它只产出依赖线索，不产出已验证的数据边",
    },
    {
      id: "df-edge-modules-graphs",
      from: "df-node-arch-modules",
      to: "df-node-six-graphs",
      relation: "transform",
      label: "转换：模块骨架 → 技术详情三图共用数据",
      claims: [cc("src/arch/render.ts", "export function buildSharedGraph(", "转换点：modules+names+progress → 三张技术详情图共用的渲染数据")],
      static_clues: [],
      note: "三张技术详情图共用这一份数据（当前实现）；数据流向图的目标语义另见 target_semantics",
    },
    {
      id: "df-edge-projection-graphs",
      from: "df-node-projection",
      to: "df-node-six-graphs",
      relation: "transform",
      label: "转换：状态投影 → 图上状态（六图着色与结论）",
      claims: [
        cc("src/arch/render.ts", "export function techModuleStatusOf(", "转换点：技术详情层的模块状态取 v2 证据派生（与图面同一份口径）"),
        cc("src/ui/components/ArchView.tsx", "const derived = taskDerivedModuleStatus({ blueprint, projection, declared_links: links });", "转换点：投影 → 图上模块状态（主视图与技术详情同源）"),
      ],
      static_clues: [],
      note: "图不产生任务完成事实；颜色与结论都从投影派生（§4.2）",
    },
    {
      id: "df-edge-projection-readout",
      from: "df-node-projection",
      to: "df-node-mcp-readout",
      relation: "produce",
      label: "产生：读口返回状态与来源分层",
      claims: [cc("src/mcp/tools/getArch.ts", "const tech = isMigratedProject(projectId) ? techModuleStatusOf(projectId) : null;", "产生点：读口按现行口径合成返回体（含状态来源分层）")],
      static_clues: [],
      note: "外部客户端拿到的是技术详情层数据 + 状态来源说明，不是 v1 自报四色",
    },
  ],
  chains: [
    {
      id: "df-chain-tatai-submit-result",
      label: "用户经 MCP 提交任务结果 → 工具面 → 交付检查 → 唯一写入服务 → 事件台账 → 状态投影 → 六图",
      hops: [
        "df-node-mcp-client",
        "df-node-mcp-tools",
        "df-node-claims",
        "df-node-write-service",
        "df-node-work-events",
        "df-node-projection",
        "df-node-six-graphs",
      ],
      edges: [null, "df-edge-client-tools", "df-edge-tools-claims", "df-edge-claims-service", "df-edge-service-events", "df-edge-events-projection", "df-edge-projection-graphs"],
      note: "端到端完整数据链：输入源 → 处理 → 存储 → 输出/外部系统四类实体齐全；逐跳的出处与验证态可点开（页面「数据链」区、get_arch 返回体的 data_flow.chains）",
    },
  ],
  measured: [
    {
      id: "df-measured-v09-10-service",
      script: "scripts/verify-v09-10.ts",
      npm_script: "verify:v09-10",
      find: "const service = new WorkService({ dataDir });",
      proves: "隔离夹具里真的起唯一写入服务并让交付检查把命令交到它手上（写入服务这一跳真被走过）",
      artifact_ids: ["df-art-work-state"],
      node_ids: ["df-node-write-service", "df-node-work-state"],
      edge_ids: ["df-edge-claims-service", "df-edge-service-events", "df-edge-service-state"],
    },
    {
      id: "df-measured-v09-10-submit",
      script: "scripts/verify-v09-10.ts",
      npm_script: "verify:v09-10",
      find: "const submit = await submitTaskResult(",
      proves: "隔离夹具里真的走交付回报路径（重查版本/认领/租约/依赖/证据后提交）",
      artifact_ids: ["df-art-work-events"],
      node_ids: ["df-node-claims", "df-node-work-events"],
      edge_ids: ["df-edge-tools-claims"],
    },
    {
      id: "df-measured-v09-10-tool",
      script: "scripts/verify-v09-10.ts",
      npm_script: "verify:v09-10",
      find: "const res = await claimTaskTool.handler(",
      proves: "隔离夹具里真的经 MCP 工具 handler 入口调用（工具面这一跳真被走过）",
      artifact_ids: [],
      node_ids: ["df-node-mcp-client", "df-node-mcp-tools"],
      edge_ids: ["df-edge-client-tools"],
    },
    {
      id: "df-measured-v09-10-setup",
      script: "scripts/verify-v09-10.ts",
      npm_script: "verify:v09-10",
      find: "const imported = importPlanChecked(PLAN, workDir,",
      proves: "隔离夹具里真的把施工定义经受检入口导入并落成任务事实（通道真被走过）",
      artifact_ids: [],
      node_ids: [],
      edge_ids: [],
    },
    {
      id: "df-measured-v09-10-snapshot",
      script: "scripts/verify-v09-10.ts",
      npm_script: "verify:v09-10",
      find: 'const stateFile = path.join(workDir, "state.json");',
      proves: "隔离夹具里真的删掉 state.json 再从事件重放重建，快照逐字节一致（快照这一跳真被走过）",
      artifact_ids: ["df-art-work-state"],
      node_ids: ["df-node-work-state"],
      edge_ids: [],
    },
    {
      id: "df-measured-v09-10-readout",
      script: "scripts/verify-v09-10.ts",
      npm_script: "verify:v09-10",
      find: "const entry = evaluateProjectEntry(",
      proves: "隔离夹具里真的按新事实重读接续入口（事件 → 投影 → 读口这几跳真被走过）",
      artifact_ids: [],
      node_ids: ["df-node-mcp-readout", "df-node-projection"],
      edge_ids: ["df-edge-events-projection", "df-edge-projection-readout"],
    },
    {
      id: "df-measured-c015-service",
      script: "scripts/verify-c015-service.ts",
      npm_script: "verify:c015-service",
      find: "service.submit({",
      proves: "真经唯一写入服务提交命令并读回（写入服务 → 事件台账这一跳真被走过）",
      artifact_ids: ["df-art-work-events"],
      node_ids: ["df-node-write-service", "df-node-work-events"],
      edge_ids: ["df-edge-service-events"],
    },
    {
      id: "df-measured-v06-09-projection",
      script: "scripts/verify-v06-09.ts",
      npm_script: "verify:v06-09",
      find: "const six = projectStatuses(sixInput(null));",
      proves: "真把事实折成状态投影并断言六态（状态投影这一跳真被走过）",
      artifact_ids: [],
      node_ids: ["df-node-projection"],
      edge_ids: [],
    },
    {
      id: "df-measured-v06-05-derive",
      script: "scripts/verify-v06-05.ts",
      npm_script: "verify:v06-05",
      find: "const firstRun = deriveBlueprint(srcA,",
      proves: "真从设计/施工原文派生出规划图并断言确定性（设计源 → 规划图这一跳真被走过）",
      artifact_ids: ["df-art-design"],
      node_ids: ["df-node-design-source", "df-node-six-graphs"],
      edge_ids: ["df-edge-design-graphs"],
    },
    {
      id: "df-measured-a1-parse",
      script: "scripts/verify-a1.ts",
      npm_script: "verify:a1",
      find: "const r = parseProject(id, REAL_DATA_DIR);",
      proves: "真的跑一次 tree-sitter 解析（代码线索 → 模块骨架这一跳真被走过）",
      artifact_ids: ["df-art-modules"],
      node_ids: ["df-node-code-source", "df-node-arch-modules"],
      edge_ids: ["df-edge-code-modules"],
    },
    {
      id: "df-measured-a2-render",
      script: "scripts/verify-a2.ts",
      npm_script: "verify:a2",
      find: "const graph = buildRenderGraph(big, bigNames);",
      proves: "真的把模块骨架合成技术详情三图共用数据（模块骨架 → 三图这一跳真被走过）",
      artifact_ids: [],
      node_ids: ["df-node-arch-modules", "df-node-six-graphs"],
      edge_ids: ["df-edge-modules-graphs"],
    },
    {
      id: "df-measured-v08-06-graphs",
      script: "scripts/verify-v08-06.ts",
      npm_script: "verify:v08-06",
      find: "const derived = taskDerivedModuleStatus({",
      proves: "真按投影派生图上模块状态并断言主视图与技术详情同源（投影 → 六图这一跳真被走过）",
      artifact_ids: [],
      node_ids: ["df-node-six-graphs"],
      edge_ids: ["df-edge-projection-graphs"],
    },
    {
      id: "df-measured-v09-08-readout",
      script: "scripts/verify-v09-08.ts",
      npm_script: "verify:v09-08",
      find: "const v1Res = await getArchTool.handler({ project_id: plainId });",
      proves: "真调用技术详情读口并逐字段核对返回体（读口这一跳真被走过）",
      artifact_ids: [],
      node_ids: ["df-node-mcp-readout"],
      edge_ids: [],
    },
    {
      id: "df-measured-v09-11-chain",
      script: "scripts/verify-v09-11.ts",
      npm_script: "verify:v09-11",
      find: "const written = loadEvents(workDir);",
      proves: "本卡脚本在隔离夹具里经唯一写入服务真提交一条命令，再读回事件台账与投影（存储这一跳在本卡内实测）",
      artifact_ids: ["df-art-work-events"],
      node_ids: ["df-node-write-service", "df-node-work-events", "df-node-projection"],
      edge_ids: ["df-edge-service-events", "df-edge-events-projection"],
    },
    {
      id: "df-measured-v09-11-model",
      script: "scripts/verify-v09-11.ts",
      npm_script: "verify:v09-11",
      find: "analyzeDataFlow(",
      proves: "本卡对真实项目派生数据链并复算每条出处与覆盖对账（数据链本体的可复跑判据）",
      artifact_ids: [],
      node_ids: [],
      edge_ids: [],
    },
  ],
};

/** 登记表（键＝注册表里的项目 id）。未登记的项目做不了覆盖对账——交付结论同样不得给出 */
export const DATA_FLOW_INDEXES: Readonly<Record<string, ProjectIndex>> = { tatai: TATAI_INDEX };

/** 哪些项目登记了「数据输入／存储／输出」声明（未登记 = 做不了覆盖对账，交付结论同样不得给出） */
export const dataFlowRegisteredProjects = (): readonly string[] => Object.keys(DATA_FLOW_INDEXES);

/** 可复跑入口表（`package.json` 的 scripts）：拿不到就等于"不可复跑"，实测档一律作废 */
function readPackageScripts(): Readonly<Record<string, string>> {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    return pkg.scripts ?? {};
  } catch {
    return {};
  }
}

// ═══════════════════════ ③ 派生（只读；不写盘、不调模型、不加埋点） ═══════════════════════

function emptyModel(projectId: string, note: string): DataFlowModel {
  return {
    project_id: projectId,
    generated_at: nowIso(),
    current_implementation: {
      is_business_data_flow: false,
      modes: ["MODULE_BOX", "DATA_FLOW", "MIND_MAP"],
      shared_source: "arch_modules_json_aggregated_edges",
      note: DATA_FLOW_CURRENT_IMPLEMENTATION_NOTE,
    },
    target_semantics: {
      entity_kinds: DATA_FLOW_ENTITY_KINDS,
      relation_kinds: DATA_FLOW_RELATION_KINDS,
      note: DATA_FLOW_TARGET_SEMANTICS_NOTE,
    },
    nodes: [],
    edges: [],
    chains: [],
    coverage: {
      declared_total: 0,
      covered: 0,
      missing: 0,
      not_implemented: 0,
      rows: [],
      missing_paths: [],
      note,
    },
    deliverable_blocked: true,
    blockers: [note],
    scan: { claims_resolved: 0, claims_dropped: 0, notes: [note] },
  };
}

/** 复算实测登记：脚本在、脚本登记在 package.json 的该入口上、脚本正文提到该路径 ⇒ 给 `path:line` */
function resolveMeasured(
  root: string,
  spec: MeasuredSpec,
  cache: FileCache,
  scripts: Record<string, string>,
  dropped: DroppedClaim[],
  pkgPath: string,
): DataFlowEvidenceRef | null {
  const command = scripts[spec.npm_script];
  if (command === undefined || !command.includes(spec.script)) {
    dropped.push({
      path: spec.script,
      find: spec.find,
      why: `package.json 里没有可复跑入口「${spec.npm_script}」（或它指向的不是这个脚本）——不可复跑就不算实测`,
    });
    return null;
  }
  const file = readCached(root, spec.script, cache);
  if (file === null) {
    dropped.push({ path: spec.script, find: spec.find, why: "脚本文件不存在／读不到：实测出处作废" });
    return null;
  }
  const line = file.lines.findIndex((l) => l.includes(spec.find)) + 1;
  if (line <= 0) {
    dropped.push({ path: spec.script, find: spec.find, why: "脚本正文里找不到这个片段：实测出处作废（不许拿没真走的脚本充实测）" });
    return null;
  }
  return {
    tier: "code_measured",
    path: spec.script,
    locator: `${spec.script}:${line}`,
    find: spec.find,
    sha256: file.sha256,
    note: `${spec.proves}（复跑：pnpm ${spec.npm_script}）`,
    rerun: `pnpm ${spec.npm_script}`,
  };
}

/** 出处去重（同一档、同一 path:line 只留一条）：节点与关系的出处会在链的某一跳上重叠，不去重会重复上屏 */
function dedupeRefs(refs: readonly DataFlowEvidenceRef[]): DataFlowEvidenceRef[] {
  const seen = new Set<string>();
  const out: DataFlowEvidenceRef[] = [];
  for (const r of refs) {
    const key = `${r.tier}|${r.locator}|${r.find}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

function resolveClues(
  root: string,
  clues: readonly { path: string; find: string; note: string }[],
  cache: FileCache,
  dropped: DroppedClaim[],
): string[] {
  const out: string[] = [];
  for (const clue of clues) {
    const file = readCached(root, clue.path, cache);
    if (file === null) {
      dropped.push({ path: clue.path, find: clue.find, why: "线索文件读不到（线索作废）" });
      continue;
    }
    const line = file.lines.findIndex((l) => l.includes(clue.find)) + 1;
    if (line <= 0) {
      dropped.push({ path: clue.path, find: clue.find, why: "线索片段找不到（线索作废）" });
      continue;
    }
    out.push(`${clue.path}:${line} · ${clue.note}`);
  }
  return out;
}

/**
 * 真实项目的数据流向模型（只读派生）。
 *
 * 未登记声明的项目：不给实体/关系/链（不硬凑），覆盖对账报「未登记」并**阻断交付结论**——
 * 没有声明就没有可对账的对象，这时说「项目可交付」是没有依据的。
 */
export function analyzeDataFlow(projectId: string, opts: { dataDir?: string } = {}): DataFlowModel {
  const index = DATA_FLOW_INDEXES[projectId];
  if (index === undefined) {
    return emptyModel(
      projectId,
      "本项目没有登记「数据输入／存储／输出」声明（登记见 src/arch/dataflow.ts；塔台自身已登记）——" +
        "没有声明就没有可逐条对账的对象，因此**不得**据此得出「项目可交付」结论；" +
        "要得到结论，先按审定设计源逐条登记声明的数据输入/存储/输出",
    );
  }
  const project = getProject(projectId, opts.dataDir);
  if (!project) {
    return emptyModel(projectId, `项目 ${projectId} 不在注册表里：路径不猜，数据流不派生`);
  }
  return analyzeDataFlowAt(index, {
    project_id: projectId,
    root: path.resolve(project.path),
    scripts: readPackageScripts(),
  });
}

/**
 * 在给定根目录上按登记表派生（`analyzeDataFlow` 的实现体；验证脚本用它在隔离夹具上跑同一份判据，
 * 例如"设计原文里复算不到声明 ⇒ 逐条报缺"的反例）。
 */
export function analyzeDataFlowAt(
  index: ProjectIndex,
  input: { project_id: string; root: string; scripts?: Readonly<Record<string, string>> },
): DataFlowModel {
  const projectId = input.project_id;
  const root = input.root;
  const cache: FileCache = new Map();
  const dropped: DroppedClaim[] = [];
  const scripts: Readonly<Record<string, string>> = input.scripts ?? {};
  const pkgPath = "package.json";

  // 实测出处（先算：节点/覆盖行都要引用它）
  const measuredRefs = new Map<string, DataFlowEvidenceRef>();
  const measuredByNode = new Map<string, DataFlowEvidenceRef[]>();
  const measuredByArtifact = new Map<string, DataFlowEvidenceRef[]>();
  const measuredByEdge = new Map<string, DataFlowEvidenceRef[]>();
  for (const spec of index.measured) {
    const ref = resolveMeasured(root, spec, cache, scripts, dropped, pkgPath);
    if (ref === null) continue;
    measuredRefs.set(spec.id, ref);
    for (const n of spec.node_ids) measuredByNode.set(n, [...(measuredByNode.get(n) ?? []), ref]);
    for (const a of spec.artifact_ids) measuredByArtifact.set(a, [...(measuredByArtifact.get(a) ?? []), ref]);
    for (const e of spec.edge_ids) measuredByEdge.set(e, [...(measuredByEdge.get(e) ?? []), ref]);
  }

  const resolveList = (claims: readonly EvidenceClaim[]): DataFlowEvidenceRef[] => {
    const out: DataFlowEvidenceRef[] = [];
    for (const c of claims) {
      const r = resolveClaim(root, c, cache, dropped);
      if (r !== null) out.push(r);
    }
    return out;
  };

  const nodes: DataFlowNode[] = index.nodes.map((spec) => {
    const evidence = dedupeRefs([...resolveList(spec.claims), ...(measuredByNode.get(spec.id) ?? [])]);
    return {
      id: spec.id,
      kind: spec.kind,
      label: spec.label,
      role: spec.role,
      evidence,
      provenance: provenanceOf(evidence),
      verification: verificationOf(evidence),
    };
  });

  const edges: DataFlowEdge[] = index.edges.map((spec) => {
    const evidence = dedupeRefs([...resolveList(spec.claims), ...(measuredByEdge.get(spec.id) ?? [])]);
    return {
      id: spec.id,
      from: spec.from,
      to: spec.to,
      relation: spec.relation,
      direction: "forward",
      label: spec.label,
      evidence,
      provenance: provenanceOf(evidence),
      verification: verificationOf(evidence),
      static_clues: resolveClues(root, spec.static_clues, cache, dropped),
      note: spec.note,
    };
  });

  const nodeVerification = new Map(nodes.map((n) => [n.id, n.verification]));
  const edgeVerification = new Map(edges.map((e) => [e.id, e.verification]));
  const chains: DataFlowChain[] = index.chains.map((spec) => {
    const kinds = new Set(
      spec.hops
        .map((id) => index.nodes.find((n) => n.id === id)?.kind)
        .filter((k): k is DataFlowEntityKind => k !== undefined),
    );
    const missing_kinds = DATA_FLOW_ENTITY_KINDS.filter((k) => !kinds.has(k));
    const hops = spec.hops.map((nodeId, i) => {
      const edgeId = spec.edges[i] ?? null;
      const node = nodes.find((n) => n.id === nodeId);
      const edge = edgeId === null ? null : edges.find((e) => e.id === edgeId) ?? null;
      return {
        index: i + 1,
        node_id: nodeId,
        edge_id: edgeId,
        role: node?.role ?? "",
        verification: node?.verification ?? "missing",
        evidence: dedupeRefs([...(node?.evidence ?? []), ...(edge?.evidence ?? [])]),
      };
    });
    const allVerified = spec.hops.every((id) => nodeVerification.get(id) === "verified");
    // 环 = 「节点 + 带它进来的那条关系」：关系没到已验证，这一跳同样不算走通（R5）
    const chainEdges = spec.edges.filter((id): id is string => id !== null);
    const edgesVerified = chainEdges.every((id) => edgeVerification.get(id) === "verified");
    const anyMissing =
      spec.hops.some((id) => nodeVerification.get(id) === "missing") ||
      chainEdges.some((id) => edgeVerification.get(id) === "missing");
    const verification: DataFlowVerification =
      missing_kinds.length === 0 && allVerified && edgesVerified ? "verified" : anyMissing ? "missing" : "unverified";
    const badNodes = spec.hops.filter((id) => nodeVerification.get(id) !== "verified");
    const badEdges = chainEdges.filter((id) => edgeVerification.get(id) !== "verified");
    return {
      id: spec.id,
      label: spec.label,
      hops,
      missing_kinds,
      verification,
      note:
        spec.note +
        (verification === "verified"
          ? "——四类实体齐全、逐跳节点与关系都到「已验证」。"
          : `——**不标「已验证」**：${missing_kinds.length > 0 ? `链上缺 ${missing_kinds.join("、")}；` : ""}` +
            `${badNodes.length > 0 ? `${badNodes.length} 跳的节点没到已验证（${badNodes.slice(0, 3).join("、")}）；` : ""}` +
            `${badEdges.length > 0 ? `${badEdges.length} 条关系没到已验证（${badEdges.slice(0, 3).join("、")}）；` : ""}` +
            "链上缺一环而仍标已验证即不合格（R5）"),
    };
  });

  // 覆盖对账：项目**所声明的**每个数据输入/存储/输出逐条一行（不抽样、不按边代表全量）
  const rows: DataFlowCoverageRow[] = index.artifacts.map((a) => {
    const designRef = resolveClaim(root, a.design, cache, dropped);
    const evidence = dedupeRefs([...resolveList(a.code), ...(measuredByArtifact.get(a.id) ?? [])]);
    const pathFound = evidence.length > 0;
    return {
      artifact: a.artifact,
      kind: a.kind,
      node_id: ARTIFACT_NODE_ID[a.id] ?? null,
      declaration_status: a.declaration_status,
      design_locator: designRef === null ? "（设计原文里复算不到这条声明：登记失效）" : designRef.locator,
      evidence,
      path_found: pathFound,
      gap:
        pathFound || a.declaration_status === "declared_not_implemented"
          ? pathFound
            ? null
            : `设计声明为「尚未实现／未引入」：${a.role}。列出来但**不计入缺路径**、也不算已覆盖（设计自己写明的未实现，不冒充已交付）`
          : `缺路径：声明的${a.role}在本项目代码里找不到读写/落点线索（出处为空）——**阻断「项目可交付」结论**（§11.2）`,
    };
  });
  const missingPaths = rows.filter((r) => !r.path_found && r.declaration_status === "current").map((r) => r.artifact);
  const coverage: DataFlowCoverage = {
    declared_total: rows.length,
    covered: rows.filter((r) => r.path_found).length,
    missing: missingPaths.length,
    not_implemented: rows.filter((r) => r.declaration_status === "declared_not_implemented").length,
    rows,
    missing_paths: missingPaths,
    note:
      `对账口径：设计源（${index.design_path}）里声明的**每一个**数据输入／存储／输出各一行（共 ${rows.length} 行，` +
      "不抽样、不用几条边代表全量）；每行要么给路径与证据，要么显式报「缺路径」。" +
      "设计自己写明「尚未实现／未引入」的行单列，既不算已覆盖也不计入缺路径。",
  };

  const blockers = dataFlowBlockersOf({ missing_paths: missingPaths, edges, chains });
  return {
    project_id: projectId,
    generated_at: nowIso(),
    current_implementation: {
      is_business_data_flow: false,
      modes: ["MODULE_BOX", "DATA_FLOW", "MIND_MAP"],
      shared_source: "arch_modules_json_aggregated_edges",
      note: DATA_FLOW_CURRENT_IMPLEMENTATION_NOTE,
    },
    target_semantics: {
      entity_kinds: DATA_FLOW_ENTITY_KINDS,
      relation_kinds: DATA_FLOW_RELATION_KINDS,
      note: DATA_FLOW_TARGET_SEMANTICS_NOTE,
    },
    nodes,
    edges,
    chains,
    coverage,
    deliverable_blocked: blockers.length > 0,
    blockers,
    scan: {
      claims_resolved: cache.size === 0 ? 0 : nodes.reduce((s, n) => s + n.evidence.length, 0) + edges.reduce((s, e) => s + e.evidence.length, 0) + measuredRefs.size,
      claims_dropped: dropped.length,
      notes: [
        `复算口径：每条出处都按「文件在 + 章节在 + 定位片段原样出现」复算，复算不过一律剔除（R3）；本次剔除 ${dropped.length} 条。`,
        ...dropped.map((d) => `剔除出处：${d.path}「${d.find}」—— ${d.why}`),
        "静态 import／字符串线索只进 static_clues，不计入出处档位，也不得生成「已验证」的数据边（R4）。",
        "本派生只读：不写盘、不调模型、不给纳管项目加运行时埋点（§11.2）。",
      ],
    },
  };
}
