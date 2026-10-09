// V09-11：**数据流向图的目标语义**在真实项目上的派生层（只读；零运行时侵入采集）。
//
// 设计依据：DESIGN.md §3.2（实体／关系口径、来源三档与验证态、「当前实现 ≠ 目标」）、§11.2、
// §12.1-6／-18、附录 C.3、附录 G-3；施工定义见 PLAN V09-11。
//
// 本文件回答三件事：
//   ① **设计源声明**：项目设计原文里声明的数据输入／存储／输出逐条登记（带章节出处），
//      读时**复算**——声明片段必须仍在被引的章节里，复算不过就如实剔除（无效来源剔除，R3）；
//   ② **代码线索＋实测证据**：每条关系给真实 `file:line` 的读写/调用点。抵达「可复跑实测」档要**两段**都成立：
//      (a) 脚本真存在、真登记在 package.json、脚本正文真提到该路径——这只是**可复跑线索**；
//      (b) 存在一条**正式** self_check/independent_audit 记录引用本条目、且当前可成立（运行记录载体内容地址
//          复核通过 + 退出码 0 + 源清单载体现读 valid + 无未解除的独立失败压过它 + 依赖范围完整覆盖；
//          协议见 `./dataflowEvidence.ts`）。**孤立落库的正文不算数**——没有正式记录引用，适配器根本读不到它。
//      只满足 (a) ⇒ 保留为 `code_static` 线索（可复跑），**不得**标「可复跑实测／已验证」（V09-61；finding f-4c71d59ab5552d36）；
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
import { emptyMeasuredRunIndex, readMeasuredRunIndex, type MeasuredRunIndex } from "./dataflowEvidence";

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
  /**
   * 生成侧复算定位注解（可选）：**项目侧声明文件**在生成时即算好的 `path:line` 留痕。
   * `resolveClaim` **不读**它（复算仍以 `path/section/find` 为准），仅为留痕与人工核对。
   */
  __checked_locator?: string;
}

/** 文件缓存：同一份文件被多条声明引用时不重复读（口径同 render.ts 的读口，只读不写） */
type FileCache = Map<string, { lines: string[]; sha256: string } | null>;

const sha256Hex = (text: string): string => crypto.createHash("sha256").update(text, "utf8").digest("hex");

/** 递归规范化 JSON：对象键排序、数组保序（用于**纯声明**定义哈希，跨书写顺序稳定）。 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(",")}}`;
}

/**
 * 数据流声明的**纯声明定义哈希**（V09-61 复审返工）：只覆盖当前解析出的声明内容（含 measured 条目的
 * 证明范围/关系语义），**不含运行证据指纹**——所以把它绑进运行记录不会形成 identity 循环。改了声明定义
 * 而源码与脚本没变时，旧运行记录绑定的哈希与新声明不符 ⇒ 不得继续冒充"证的是新定义"。
 */
export function dataFlowDefinitionSha256(index: ProjectIndex): string {
  return sha256Hex(canonicalJson(index));
}

/** 项目根的真实路径缓存（软链/junction 逃逸核对用；根只解析一次） */
const realRootCache = new Map<string, string>();
function realRootOf(root: string): string {
  const hit = realRootCache.get(root);
  if (hit !== undefined) return hit;
  let real: string;
  try {
    real = fs.realpathSync(root);
  } catch {
    real = path.resolve(root);
  }
  realRootCache.set(root, real);
  return real;
}

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
        // 词法在根内还不够：软链/junction 可把文件指到根外——按**真实路径**再核实一次仍须落在项目根内
        const realAbs = fs.realpathSync(abs);
        const realRoot = realRootOf(root);
        if (realAbs === realRoot || realAbs.startsWith(realRoot + path.sep)) {
          const text = fs.readFileSync(abs, "utf8");
          value = { lines: text.split(/\r?\n/), sha256: sha256Hex(text) };
        }
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

/**
 * 可复跑实测：一条「哪个登记过的脚本真的走过这条路」的登记。
 *
 * **2026-10-08 判据收紧（V09-61；finding f-4c71d59ab5552d36）**：脚本必须存在＋登记在 package.json＋
 * 正文提到 `find` 片段——这三条**只是「可复跑线索」**，不再等于「实测」。判 `code_measured` 还**必须**
 * 有**正式 self_check/independent_audit 记录引用**的一条当前可成立的运行记录（见 `./dataflowEvidence.ts`）：
 * 内容地址复核通过、退出码 0、引用的源清单载体现读 valid、无未解除的独立失败压过它（同 object_id+check_id 内选）、
 * 运行记录绑定的**纯声明定义哈希**与当前解析声明一致、且本条依赖的源码全在覆盖范围内。任何一条不成立 ⇒ 只保留为
 * `code_static` 线索（可复跑），**不得**标「可复跑实测／已验证」。
 * 脚本存在 ≠ 跑过；跑过 ≠ 通过；通过 ≠ 覆盖的源没变；**声明定义变了** ≠ 旧记录仍证新定义；孤立自报的正文 ≠ 正式引用采信。
 */
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
  /**
   * 本条实测**显式声明**的真实依赖（项目根内相对路径）。**不再**是唯一来源：判「范围覆盖」时优先按
   * 「被证明节点/边的代码 claims」自动推出**完整有限集合**（见 `requiredSourcesOf`），本字段用于补声明
   * claims 覆盖不到的依赖。只声明脚本本体不算够——没有可推出的实现文件又没显式声明 ⇒ 待复核（不得默认通过）。
   */
  sources?: string[];
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
const S25 = "### 2.5 协作对象与稳定标识";
const S26 = "### 2.6 权威数据与派生内容";
const S84 = "### 8.4 SQLite 缓存范围";
const S210 = "### 2.10 同步证据自动发现与完整性验收";

/**
 * 声明 → 实体表节点的对应（**显式写出来**，不用字符串互相猜）。
 * 不对应链上任何实体的声明（如布局记忆、折叠记忆）就没有这一行——"没有对应"是如实，不是遗漏。
 * 这里只放塔台自身（内建声明）的对应；**只在派生内建声明时**按此回退（`isBuiltinIndex`）。
 * **项目侧声明文件**的对应必须写在各自的 artifact.node_id 上（见 `loadDataFlowIndex`），
 * 外部项目即使出现同名 artifact id 也不回退到本表——否则会拿塔台的节点 id 串到别的项目。
 */
const ARTIFACT_NODE_ID: Readonly<Record<string, string>> = {
  "df-art-design": "df-node-design-source",
  "df-art-modules": "df-node-arch-modules",
  "df-art-work-events": "df-node-work-events",
  "df-art-work-state": "df-node-work-state",
  // 本轮补齐：这些声明本来就登记在表里，此前没有对应链上实体（不是遗漏，是"没有对应"；
  // 现在补了实体就显式写出对应，不用字符串互相猜）
  "df-art-plan": "df-node-plan-source",
  "df-art-sync-inbox": "df-node-sync-inbox",
  "df-art-evidence": "df-node-evidence-store",
  "df-art-design-revisions": "df-node-revisions-store",
  "df-art-plan-revisions": "df-node-revisions-store",
  "df-art-baselines": "df-node-baselines-store",
  // 第二阶段补齐（2026-10-08）：辅助/旧兼容数据也不是"文件名常量"，各有真实实体与读写关系。
  // 覆盖判据已改为「设计来源有效 + 可定位实体 + 该实体参与一条端点闭合、有有效出处的真实关系」，
  // 所以这些声明必须有明确 node_id——不再靠"有出处就算有路径"的旧口径。
  "df-art-discuss": "df-node-discuss",
  "df-art-registry": "df-node-registry",
  "df-art-progress": "df-node-progress-compat",
  "df-art-gate": "df-node-gate-compat",
  "df-art-tasks": "df-node-tasks-compat",
  "df-art-chat": "df-node-chat-log",
  "df-art-changes": "df-node-changes-log",
  "df-art-layout": "df-node-layout-store",
  "df-art-names": "df-node-names-store",
  "df-art-fold": "df-node-fold-store",
  "df-art-reconcile": "df-node-reconcile-store",
  "df-art-supplement": "df-node-supplement-store",
  "df-art-logs": "df-node-logs-store",
  "df-art-decisions": "df-node-decisions-store",
  "df-art-intent": "df-node-intent-store",
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
// 本轮（六图补齐）新增声明的定位片段：都必须逐字出现在被引章节里，否则复算失败、该行如实报缺
const D_PLAN = "| 施工定义原文 | PLAN.md（塔台）或已登记的项目施工图路径";
const D_SYNC = "执行前登记应同步清单与原始范围来源；Agent 完成后交付固定格式证据包；塔台自动发现";
const D_BASELINE = "基线确认必须保存可取回的确切原文";
const D_OBLIGATION = "**唯一**的「义务/状态派生」层";
const D_NO_SECOND_LEDGER = "**不建第二张完成表**";
const D_REQ_CLOSED = "**需求投影仍是闭键**";

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
        cc("src/server/work/eventStore.ts", "export const EVENTS_FILE = LEDGER_FILE_NAME;", "读写点：事件台账文件名（唯一事实源；常量由 LEDGER_FILE_NAME 提供）"),
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
    {
      id: "df-art-plan",
      artifact: ".工作台/plan.md（塔台自身＝根 PLAN.md）",
      kind: "input_source",
      declaration_status: "current",
      design: dc("DESIGN.md", S26, D_PLAN, "§2.6 权威数据表：施工定义原文由设计原文派生（卡/依赖/验收都可追）"),
      code: [
        cc("src/server/work/documents.ts", 'export const TATAI_PLAN_REL = "PLAN.md";', "读点：塔台自身施工图固定在仓库根 PLAN.md"),
        cc("src/server/work/documents.ts", "export const DEFAULT_PLAN_REL = `${WORKBENCH_DIRNAME}/plan.md`;", "读点：其他项目缺省 `.工作台/plan.md`"),
      ],
      role: "输入源：施工定义原文（卡、依赖与验收的声明来源）",
    },
    {
      id: "df-art-sync-inbox",
      artifact: ".工作台/work/sync-inbox/",
      kind: "store",
      declaration_status: "current",
      design: dc("DESIGN.md", S210, D_SYNC, "§2.10：Agent 交付固定格式证据包，塔台自动发现（详细格式见同步证据契约）"),
      code: [
        cc("src/shared/syncEvidence.ts", 'export const SYNC_INBOX_REL = ".工作台/work/sync-inbox";', "读写点：同步证据收件目录常量（唯一约定位置）"),
        cc("src/shared/syncEvidence.ts", 'export const SYNC_EVIDENCE_FILE_SUFFIX = ".evidence.json";', "读点：只发现该后缀的证据包，不扫整仓 Markdown"),
      ],
      role: "存储：同步证据包收件目录（外部 Agent 投放，塔台只读发现）",
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
        cc("src/ui/components/ArchView.tsx", "const derived = taskDerivedModuleStatus({ blueprint, projection, declared_links: links, scope_projection: projection });", "输出点：技术详情三图与主视图同源的模块状态派生"),
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
    // ── 本轮补齐：其余已实现核心链路（证据存证／施工定义导入／需求登记／基线激活／同步证据核验／功能清单） ──
    {
      id: "df-node-plan-source",
      kind: "input_source",
      label: "施工定义原文（PLAN.md／.工作台/plan.md）",
      role: "输入源：卡、依赖与验收的声明来源；由设计原文派生（§2.6）",
      claims: [
        dc("DESIGN.md", S26, D_PLAN, "§2.6 权威数据表：施工定义原文由设计原文派生"),
        cc("src/server/work/documents.ts", 'export const TATAI_PLAN_REL = "PLAN.md";', "读点：塔台自身施工图＝仓库根 PLAN.md"),
      ],
      static_clues: [],
    },
    {
      id: "df-node-evidence-record",
      kind: "process",
      label: "证据/缺陷登记（record_work_evidence / putEvidence）",
      role: "处理：证据正文按内容寻址落盘、缺陷去重与状态机（只在唯一写服务宿主内执行）",
      claims: [
        dc("DESIGN.md", S26, D_EVIDENCE, "§2.6：证据正文不可变，事件只引用 ID/哈希"),
        cc("src/server/work/evidence.ts", "export function putEvidence(workDir: string, input: EvidenceInput): EvidenceBlob {", "处理点：证据正文登记（内容寻址，同内容重复提交返回原记录）"),
        cc("src/mcp/tools/recordWorkEvidence.ts", 'name: "record_work_evidence",', "输入端：Agent 经 MCP 工具面提交存证命令（不代签用户 Gate）"),
      ],
      static_clues: [],
    },
    {
      id: "df-node-evidence-store",
      kind: "store",
      label: ".工作台/evidence/<sha256>.json",
      role: "存储：不可变证据正文（内容寻址；事件只引用哈希与恢复位置）",
      claims: [
        dc("DESIGN.md", S26, D_EVIDENCE, "§2.6：证据正文落不可变历史对象"),
        cc("src/server/work/evidence.ts", 'export const EVIDENCE_DIRNAME = "evidence";', "落点：证据正文目录常量"),
        cc("src/server/work/evidence.ts", "export const evidenceBlobPath = (workDir: string, sha256: string): string => {", "落点：按 sha256 拼内容地址（读时复核哈希）"),
      ],
      static_clues: [],
    },
    {
      id: "df-node-definition-import",
      kind: "process",
      label: "施工定义导入为不可变任务定义（importPlanChecked / submitDefinitionImports）",
      role: "处理：解析施工图卡面、复算引用、逐条落成 `task.definition_imported`（不改执行状态）",
      claims: [
        dc("DESIGN.md", S26, D_PLAN, "§2.6：施工定义导入为不可变任务定义修订；任务状态来自事件"),
        cc("src/server/work/references.ts", "export function importPlanChecked(", "处理点：解析施工图并复算承接引用"),
        cc("src/server/work/tasks.ts", "export function submitDefinitionImports(", "处理点：逐条提交定义导入事件"),
      ],
      static_clues: [],
    },
    {
      id: "df-node-requirement",
      kind: "process",
      label: "需求登记（manage_requirement / registerRequirement）",
      role: "处理：只登记 §2.5 最小字段与来源引用，闭键拒收正文拷贝；来源悬空即拒",
      claims: [
        dc("DESIGN.md", S25, "为跨会话引用分配稳定 ID", "§2.5：协作对象分配稳定 ID（改名/搬目录不换身份）"),
        cc("src/server/work/requirements.ts", "export function registerRequirement(submitter: WorkSubmitter, input: RegisterRequirementInput): WorkReceipt {", "处理点：需求登记（payload 闭键，多一个键都拒）"),
        cc("src/mcp/tools/workObjects.ts", 'name: "manage_requirement",', "输入端：Agent 经 MCP 工具面登记需求对象"),
      ],
      static_clues: [],
    },
    {
      id: "df-node-baseline",
      kind: "process",
      label: "基线激活与不可变修订（manage_baseline / activateBaseline）",
      role: "处理：校验既有基线记录与新引用，落不可变修订对象并追加基线记录（只追加）",
      claims: [
        dc("DESIGN.md", S26, D_BASELINE, "§2.6：基线必须保存可取回的确切原文"),
        cc("src/server/work/documents.ts", "export function activateBaseline(", "处理点：双版本激活（design_revision + plan_revision）"),
        cc("src/mcp/tools/manageBaseline.ts", 'name: "manage_baseline",', "输入端：Agent 经 MCP 工具面请求 preserve/activate"),
      ],
      static_clues: [],
    },
    {
      id: "df-node-revisions-store",
      kind: "store",
      label: ".工作台/design-revisions/ 与 plan-revisions/",
      role: "存储：设计/施工修订的不可变历史对象（按内容/定义哈希命名，不接受编辑）",
      claims: [
        dc("DESIGN.md", S26, D_DESIGN_REV, "§2.6：未提交的图纸落不可变历史对象并校验哈希"),
        cc("src/server/work/documents.ts", 'export const DESIGN_REVISIONS_DIR = "design-revisions";', "落点：设计修订历史对象目录常量"),
        cc("src/server/work/documents.ts", 'export const PLAN_REVISIONS_DIR = "plan-revisions";', "落点：施工定义修订历史对象目录常量"),
      ],
      static_clues: [],
    },
    {
      id: "df-node-baselines-store",
      kind: "store",
      label: ".工作台/baselines.jsonl",
      role: "存储：基线记录（只追加，引用原文哈希与恢复位置）",
      claims: [
        dc("DESIGN.md", S26, D_THREE, "§2.6：基线记录只引用原文哈希与恢复位置"),
        cc("src/server/work/documents.ts", 'export const BASELINES_FILE = "baselines.jsonl";', "写点：基线记录只追加落盘文件名常量"),
      ],
      static_clues: [],
    },
    {
      id: "df-node-sync-package",
      kind: "input_source",
      label: "外部交付的同步证据包（<batch_id>.evidence.json）",
      role: "输入源：Agent 按登记契约交付的固定格式证据包（塔台只读发现，不执行其中任何代码）",
      claims: [
        dc("DESIGN.md", S210, D_SYNC, "§2.10：Agent 完成后交付固定格式证据包，塔台自动发现"),
        cc("src/shared/syncEvidence.ts", 'export const SYNC_EVIDENCE_FILE_SUFFIX = ".evidence.json";', "输入约定：证据包文件名后缀（只发现该格式）"),
      ],
      static_clues: [],
    },
    {
      id: "df-node-sync-inbox",
      kind: "store",
      label: ".工作台/work/sync-inbox/",
      role: "存储：同步证据包收件目录（项目私有，塔台只读扫描）",
      claims: [
        dc("DESIGN.md", S210, D_SYNC, "§2.10：同步证据的约定位置与发现生命周期"),
        cc("src/shared/syncEvidence.ts", 'export const SYNC_INBOX_REL = ".工作台/work/sync-inbox";', "落点：收件目录常量（唯一约定位置）"),
      ],
      static_clues: [],
    },
    {
      id: "df-node-sync-scan",
      kind: "process",
      label: "同步证据核验（scan_sync_evidence / scanSyncProject）",
      role: "处理：只接受匹配契约的证据包，逐项比对当前实际目标；缺证/失效即阻断接续",
      claims: [
        dc("DESIGN.md", S210, D_SYNC, "§2.10：逐项比对当前实际目标，不因一份总结就宣称同步完整"),
        cc("src/server/work/sync.ts", "export async function scanSyncProject(req: { projectId: string; dataDir: string; submitter: SyncSubmitter;", "处理点：同步扫描（只读计划 + 唯一写口提交）"),
        cc("src/mcp/tools/syncEvidence.ts", 'name: "scan_sync_evidence",', "输入端：显式扫描入口（与后台发现同一逻辑与单飞队列）"),
      ],
      static_clues: [],
    },
    {
      id: "df-node-obligations",
      kind: "process",
      label: "唯一义务/状态派生（deriveObligations）",
      role: "处理：同一 revision 的事实快照折成唯一「义务/状态」层，供各只读投影共用",
      claims: [
        dc("DESIGN.md", S26, D_OBLIGATION, "§2.6：唯一派生链路（不建第二张完成表）"),
        cc("src/server/work/obligations.ts", "export function deriveObligations(input: {", "处理点：唯一义务/状态派生入口"),
      ],
      static_clues: [],
    },
    {
      id: "df-node-feature-ledger",
      kind: "output_external",
      label: "功能清单只读读口（feature_ledger / readFeatureLedger）",
      role: "输出：把唯一派生结论作为只读清单交给界面与 Agent（不写状态、不代签）",
      claims: [
        dc("DESIGN.md", S26, D_NO_SECOND_LEDGER, "§2.6：派生结果纯只读、可删除重建；不新增完成表"),
        cc("src/server/work/featureLedger.ts", "export function readFeatureLedger(", "输出点：功能清单读模型（只读，与 HTTP 路由同底层）"),
        cc("src/mcp/tools/featureLedger.ts", 'name: "feature_ledger",', "输出点：MCP 只读工具（同判据、同错误语义）"),
      ],
      static_clues: [],
    },
    // ══ 第二阶段补齐（2026-10-08）：设计声明的**辅助与旧兼容数据**也是实际数据流的一环 ══
    // 这些文件此前只有"文件名常量"出处、node_id=null，旧覆盖判据却把它们算作已覆盖——那是假覆盖。
    // 现在每条都补出真实实体与其真实的读写关系（按 src 里真实的读/写函数点），旧 v1 数据显式标注。
    {
      id: "df-node-workbench-ui",
      kind: "output_external",
      label: "塔台工作台界面（前端：画布/思维导图/聊天/终端/对账面板 ＋ 本地 HTTP 读口）",
      role: "输出/外部系统：把 v1 兼容读数与运行现场交给用户界面；用户操作（拖动/折叠/发消息/下终端命令）也从这里回到服务端",
      claims: [
        cc("src/ui/api.ts", "export async function getArchLayout(id: string): Promise<ArchLayoutFile> {", "读口：前端经本地 HTTP 读口取画布/导图/对账数据（同一份 apiFetch）"),
        cc("src/ui/api.ts", "export async function getArchReconcile(", "读口：对账面板取最近一次对账结果（v1/v2 读数只作展示）"),
      ],
      static_clues: [],
    },
    {
      id: "df-node-reconcile-proc",
      kind: "process",
      label: "规划↔实现对账（reconcileProject / readLastReconcile）",
      role: "处理：把设计/施工声明与代码落点比对，产出差异并落对账上下文（差异是信号不是错误）",
      claims: [cc("src/arch/reconcile.ts", "export function reconcileProject(", "处理点：跑一次对账并落 reconcile-last.json（消费 reconcile-request 钩子）")],
      static_clues: [],
    },
    {
      id: "df-node-file-watcher",
      kind: "process",
      label: "项目文件监听（watchProject）",
      role: "处理：监听项目文件变更，合批产出变更流水（自监听死循环已排除）",
      claims: [cc("src/server/watcher.ts", "export function watchProject(", "处理点：监听项目并合批追加 changes.jsonl")],
      static_clues: [],
    },
    {
      id: "df-node-discuss",
      kind: "input_source",
      label: ".工作台/design.discuss.md（待议记录）",
      role: "输入源：Agent 只追加的待议意见；设计修订的讨论来源",
      claims: [
        dc("DESIGN.md", S22, D_DISCUSS, "§2.2：待议记录只追加（执行 agent 只能追加到这里）"),
        cc("src/server/workstation.ts", "export function readDiscuss(projectId: string, dataDir?: string): DiscussDoc {", "读点：待议正文从这份文件读回"),
      ],
      static_clues: [],
    },
    {
      id: "df-node-registry",
      kind: "store",
      label: "全局注册表 <工作根目录>/.tatai/registry.json",
      role: "存储：项目清单的唯一出处（按 id 解析项目根，供各处定位项目文件）",
      claims: [
        dc("DESIGN.md", S231, D_REGISTRY, "§2.3.1：全局注册表是项目清单的唯一出处"),
        cc("src/server/registry.ts", 'const REGISTRY_FILE = "registry.json";', "读写点：注册表文件名常量（读写都经 registry.ts）"),
      ],
      static_clues: [],
    },
    {
      id: "df-node-progress-compat",
      kind: "store",
      label: ".工作台/progress.json（v1 兼容投影）",
      role: "存储：进度与模块四色读数——**旧 v1 兼容数据**；v2 下由事件重放投影写回，只作兼容读数、不冒充 v2 事实",
      claims: [
        dc("DESIGN.md", S22, D_PROGRESS, "§2.2：进度与模块状态（v1 基础格式）"),
        cc("src/server/workstation.ts", 'const PROGRESS_FILE = "progress.json";', "读写点：progress.json 文件名常量"),
      ],
      static_clues: [],
    },
    {
      id: "df-node-gate-compat",
      kind: "store",
      label: ".工作台/gate.jsonl（v1 Gate 流水）",
      role: "存储：Gate 过关/打回流水——**旧 v1 数据**，只作时间线读回，不冒充 v2 事件事实",
      claims: [
        dc("DESIGN.md", S22, D_GATE, "§2.2：Gate 过关/打回流水（带时间戳）"),
        cc("src/server/workstation.ts", 'const GATE_JSONL_FILE = "gate.jsonl";', "读写点：gate.jsonl 文件名常量"),
      ],
      static_clues: [],
    },
    {
      id: "df-node-tasks-compat",
      kind: "store",
      label: ".工作台/tasks.json（v1 兼容投影）",
      role: "存储：任务台账的兼容投影——**旧 v1 数据**；现行任务状态以事件账本为准，这里只作 v1 兼容读数",
      claims: [
        dc("DESIGN.md", S22, D_TASKS, "§2.2：任务级状态（v1 基础格式，agent 经 MCP 自报）"),
        cc("src/server/workstation.ts", "export function readTasks(projectId: string, dataDir?: string): TasksFile {", "读点：tasks.json 兼容读数入口"),
      ],
      static_clues: [],
    },
    {
      id: "df-node-chat-log",
      kind: "input_source",
      label: ".工作台/chat/<session>.jsonl（会话聊天记录）",
      role: "输入源：与内置模型的讨论记录，按会话逐行落盘（同步 append）；可作意图/补全来源引用",
      claims: [
        dc("DESIGN.md", S236, D_CHAT, "§2.3.6：聊天按会话落盘，一行一条消息"),
        cc("src/server/chat.ts", 'const CHAT_DIR = "chat";', "读写点：聊天会话目录常量（同步 append，实时落盘红线）"),
      ],
      static_clues: [],
    },
    {
      id: "df-node-changes-log",
      kind: "store",
      label: ".工作台/changes.jsonl（变更流水）",
      role: "存储：文件监听顺带产出的变更流水（合批追加，一行一条）",
      claims: [
        dc("DESIGN.md", S22, D_CHANGES, "§2.2：变更流水（文件监听顺带产出，简版）"),
        cc("src/server/watcher.ts", 'const CHANGES_JSONL_FILE = "changes.jsonl";', "写点：变更流水文件名常量（监听器合批追加）"),
      ],
      static_clues: [],
    },
    {
      id: "df-node-layout-store",
      kind: "store",
      label: ".工作台/arch/layout.json（布局位置记忆）",
      role: "存储：画布节点坐标记忆，按视图分键；刷新/重开据此复原位置",
      claims: [
        dc("DESIGN.md", S22, D_LAYOUT, "§2.2：布局位置记忆（刷新不跳动）"),
        cc("src/arch/layoutStore.ts", 'path.join(root, ".工作台", "arch", "layout.json")', "读写点：布局记忆落盘位置"),
      ],
      static_clues: [],
    },
    {
      id: "df-node-names-store",
      kind: "store",
      label: ".工作台/arch/names.json（模块人话名缓存）",
      role: "存储：模块人话名缓存（起名结果，重命名刷新用）；合成技术图时读回",
      claims: [
        dc("DESIGN.md", S22, D_NAMES, "§2.2：模块人话名缓存"),
        cc("src/arch/name.ts", "export function readNames(root: string): ArchNamesFile {", "读写点：起名缓存读回入口"),
      ],
      static_clues: [],
    },
    {
      id: "df-node-fold-store",
      kind: "store",
      label: ".工作台/arch/mindmap-fold.json（思维导图折叠记忆）",
      role: "存储：思维导图展开/收起状态记忆（按项目 + 节点记展开态）",
      claims: [
        dc("DESIGN.md", S22, D_FOLD, "§2.2：思维导图折叠记忆"),
        cc("src/arch/foldStore.ts", 'path.join(root, ".工作台", "arch", "mindmap-fold.json")', "读写点：折叠记忆落盘位置"),
      ],
      static_clues: [],
    },
    {
      id: "df-node-reconcile-store",
      kind: "store",
      label: ".工作台/arch/reconcile-last.json / reconcile-request.json（对账上下文）",
      role: "存储：规划↔实现对账的上次结果（供 UI 标黄）与待处理请求钩子",
      claims: [
        dc("DESIGN.md", S22, D_RECONCILE, "§2.2：对账上下文（上次结果 / 待处理请求）"),
        cc("src/arch/reconcile.ts", 'const RECONCILE_LAST_FILE = "reconcile-last.json";', "读写点：对账结果落盘文件名常量"),
      ],
      static_clues: [],
    },
    {
      id: "df-node-supplement-store",
      kind: "input_source",
      label: ".工作台/arch/supplement.json（聊天补全层）",
      role: "输入源：聊天补全层（概念模块），合成三视图时并入；不自动升格为审定架构",
      claims: [
        dc("DESIGN.md", S22, D_SUPPLEMENT, "§2.2：聊天补全层（节点 id 一律 chat: 前缀）"),
        cc("src/arch/supplement.ts", "export function readSupplement(projectId: string, dataDir?: string): SupplementFile | null {", "读点：共用数据层合成时把补全层读进来"),
      ],
      static_clues: [],
    },
    {
      id: "df-node-logs-store",
      kind: "store",
      label: ".工作台/logs/（运行日志）",
      role: "存储：项目内运行日志（终端命令历史，只追加）",
      claims: [
        dc("DESIGN.md", S22, D_LOGS, "§2.2：运行日志位"),
        cc("src/server/terminalHistory.ts", 'export const HISTORY_DIR_NAME = "logs";', "读写点：`.工作台/logs/` 下的终端历史目录常量（只追加）"),
      ],
      static_clues: [],
    },
    {
      id: "df-node-decisions-store",
      kind: "store",
      label: ".工作台/decisions.jsonl（处置记录）",
      role: "存储：决策/处置记录（只追加），随接续入口交付给外部 Agent",
      claims: [
        dc("DESIGN.md", S26, D_THREE, "§2.6：意图/决策/基线三件套各自的记录文件"),
        cc("src/server/work/decisions.ts", 'export const DECISIONS_FILE = "decisions.jsonl";', "写点：处置记录只追加落盘文件名常量"),
      ],
      static_clues: [],
    },
    {
      id: "df-node-intent-store",
      kind: "input_source",
      label: ".工作台/intent.json（意图原文）",
      role: "输入源：人直接编写的意图原文；产品侧读点＝引用解析与登记校验（不设产品写口）",
      claims: [
        dc("DESIGN.md", S26, D_THREE, "§2.6：意图正文的唯一写入源＝intent.json / 聊天记录 / 设计原文"),
        cc("src/server/work/intent.ts", "export function readIntentFile(workbenchDir: string): IntentFile | null {", "读点：意图原文按 {version,items} 解析读回（文件不在如实返回 null）"),
      ],
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
        cc("src/server/work/eventStore.ts", "export function replayEvents(events: readonly WorkEvent[]): {", "读点：按 seq 连续性重放事件（有洞就抛，不降级；入参为只读数组）"),
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
        cc("src/ui/components/ArchView.tsx", "const derived = taskDerivedModuleStatus({ blueprint, projection, declared_links: links, scope_projection: projection });", "转换点：投影 → 图上模块状态（主视图与技术详情同源）"),
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
    // 证据存证链
    {
      id: "df-edge-tools-evidence-service",
      from: "df-node-mcp-tools",
      to: "df-node-write-service",
      relation: "transfer",
      label: "工具面把存证命令交给唯一写入服务",
      claims: [
        cc("src/mcp/tools/recordWorkEvidence.ts", "const blob = await work.saveEvidence(projectId, {", "传递点：工具面经 ctx.work 转接客户端交命令（绝不本地写项目目录）"),
        cc("src/server/work/service.ts", "async saveEvidence(projectId: string, input: EvidenceInput): Promise<EvidenceBlob> {", "传递点：转接客户端 POST /api/work/reporting/evidence 给唯一写服务宿主"),
      ],
      static_clues: [],
      note: "stdio 进程不自己写项目目录：证据正文只能由唯一写服务宿主落盘（§2.6）",
    },
    {
      id: "df-edge-service-evidence-record",
      from: "df-node-write-service",
      to: "df-node-evidence-record",
      relation: "transfer",
      label: "宿主内登记证据正文",
      claims: [cc("src/server/work/reportingHost.ts", "const blob: EvidenceBlob = putEvidence(workDir, input);", "处理点：宿主在写者身份复核后调用 putEvidence")],
      static_clues: [],
      note: "宿主先复核写者身份（慢 body 竞态也不放行），非当前写者一个字节都不写",
    },
    {
      id: "df-edge-evidence-record-store",
      from: "df-node-evidence-record",
      to: "df-node-evidence-store",
      relation: "read_write",
      label: "写：证据正文按内容寻址落盘",
      claims: [
        cc("src/server/work/evidence.ts", "export function putEvidence(workDir: string, input: EvidenceInput): EvidenceBlob {", "写点：内容寻址登记（同内容返回原记录，不覆盖）"),
        cc("src/server/work/evidence.ts", "fs.renameSync(tmp, file);", "写点：临时文件 + rename 原子改名落盘"),
      ],
      static_clues: [],
      note: "写一次不再改写；读时复核哈希（与文件名不符即暴露）",
    },
    {
      id: "df-edge-evidence-store-readout",
      from: "df-node-evidence-store",
      to: "df-node-mcp-readout",
      relation: "produce",
      label: "读：按内容地址读回证据正文",
      claims: [
        cc("src/mcp/tools/recordWorkEvidence.ts", "return jsonOk({ ok: true, evidence: await work.readEvidenceRemote(projectId, sha256) });", "读点：工具面 read 分支经宿主只读读口取回"),
        cc("src/server/work/reportingHost.ts", "const blob: EvidenceBlob = readEvidence(workDir, sha256);", "读点：宿主读口把正文交回调用方"),
      ],
      static_clues: [],
      note: "读不到正文就报错，绝不返回「成功但空正文」的假证据",
    },
    // 施工定义导入链
    {
      id: "df-edge-plan-import",
      from: "df-node-plan-source",
      to: "df-node-definition-import",
      relation: "transform",
      label: "转换：施工图卡面解析成不可变任务定义",
      claims: [
        cc("src/server/work/references.ts", "export function importPlanChecked(", "转换点：解析施工图并复算承接引用"),
        cc("src/server/work/references.ts", "const imported = importTaskDefinitions(markdown, options);", "转换点：按卡面抽出任务定义（不含派生状态）"),
      ],
      static_clues: [],
      note: "定义哈希只覆盖目标/范围/依赖/接口/验收，不含派生状态与执行日志",
    },
    {
      id: "df-edge-import-service",
      from: "df-node-definition-import",
      to: "df-node-write-service",
      relation: "transfer",
      label: "提交：定义导入事件经唯一写入服务",
      claims: [cc("src/server/work/tasks.ts", "submitTaskEvent(submitter, {", "提交点：逐条提交 task.definition_imported（不改变执行状态）")],
      static_clues: [],
      note: "导入不产生执行事实；任务状态来自后续事件（§2.6）",
    },
    // 需求 → 唯一义务派生 → 功能清单链
    {
      id: "df-edge-design-requirement",
      from: "df-node-design-source",
      to: "df-node-requirement",
      relation: "transform",
      label: "转换：设计/意图来源登记成需求对象",
      claims: [
        dc("DESIGN.md", S26, D_REQ_CLOSED, "§2.6：需求投影仍是闭键，只收既有最小字段集"),
        cc("src/server/work/requirements.ts", "export function registerRequirement(submitter: WorkSubmitter, input: RegisterRequirementInput): WorkReceipt {", "转换点：登记最小字段与来源引用（不搬正文）"),
      ],
      static_clues: [],
      note: "来源引用指回原处（intent/chat/design/...），不复制意图正文（§2.6 单源分工）",
    },
    {
      id: "df-edge-requirement-service",
      from: "df-node-requirement",
      to: "df-node-write-service",
      relation: "transfer",
      label: "提交：需求事件经唯一写入服务",
      claims: [cc("src/server/work/requirements.ts", "assertIntentSourceResolvable(submitter, fields.source, `注册 ${input.requirement_id}`);", "提交点：登记前核 intent 来源引用有效性，悬空即拒且零写入")],
      static_clues: [],
      note: "与 task/finding/audit/execution 同一条事件流、同一个唯一写入者（§2.6）",
    },
    {
      id: "df-edge-events-obligations",
      from: "df-node-work-events",
      to: "df-node-obligations",
      relation: "read_write",
      label: "读：事件账本 + 已批准定义 → 唯一义务/状态派生",
      claims: [
        cc("src/server/work/obligations.ts", 'if (e.type !== "task.definition_imported") continue;', "读点：按不可变定义导入事件重建在册定义"),
        cc("src/server/work/obligations.ts", "export function deriveObligations(input: {", "读点：一次读取与校验来源后形成唯一义务/状态层"),
      ],
      static_clues: [],
      note: "投影之间互不读对方输出（避免循环与漂移，§2.6）",
    },
    {
      id: "df-edge-obligations-ledger",
      from: "df-node-obligations",
      to: "df-node-feature-ledger",
      relation: "produce",
      label: "产生：只读功能清单投影",
      claims: [cc("src/server/work/featureLedger.ts", "export function readFeatureLedger(", "产出点：把已算结论投影为功能清单（只读）")],
      static_clues: [],
      note: "只读：不写事件、不存证、不认领、不触发扫描（§6.12）",
    },
    // 基线激活
    {
      id: "df-edge-design-baseline",
      from: "df-node-design-source",
      to: "df-node-baseline",
      relation: "read_write",
      label: "读：设计原文参与基线激活校验",
      claims: [cc("src/server/work/documents.ts", "const docs = loadDocuments(projectId, dataDir);", "读点：激活前读回两份图纸当前原文")],
      static_clues: [],
      note: "任一份图纸缺失都不能激活——设计书与施工图是一套，不能只审一半",
    },
    {
      id: "df-edge-baseline-revisions",
      from: "df-node-baseline",
      to: "df-node-revisions-store",
      relation: "read_write",
      label: "写：落不可变修订对象",
      claims: [
        cc("src/server/work/documents.ts", "export function preserveRevision(", "写点：未提交或不在 Git 的图纸落不可变副本并校验哈希"),
        cc("src/server/work/documents.ts", 'export const DESIGN_REVISIONS_DIR = "design-revisions";', "落点：设计修订历史对象目录"),
      ],
      static_clues: [],
      note: "历史对象不接受编辑；副本与哈希对不上即拒绝当作该修订",
    },
    {
      id: "df-edge-baseline-baselines",
      from: "df-node-baseline",
      to: "df-node-baselines-store",
      relation: "read_write",
      label: "写：追加基线记录",
      claims: [
        cc("src/server/work/documents.ts", "export function activateBaseline(", "写点：双版本激活并追加基线记录"),
        cc("src/server/work/documents.ts", 'export const BASELINES_FILE = "baselines.jsonl";', "落点：基线记录只追加文件名常量"),
      ],
      static_clues: [],
      note: "approved_by=user 只允许 approval_kind=user_confirmed——不伪造用户 Gate",
    },
    // 同步证据核验链
    {
      id: "df-edge-package-inbox",
      from: "df-node-sync-package",
      to: "df-node-sync-inbox",
      relation: "transfer",
      label: "投放：证据包落进收件目录",
      claims: [
        cc("src/shared/syncEvidence.ts", 'export const SYNC_INBOX_REL = ".工作台/work/sync-inbox";', "落点：证据包的约定投放位置"),
        cc("src/shared/syncEvidence.ts", 'export const SYNC_EVIDENCE_FILE_SUFFIX = ".evidence.json";', "约定：只发现该后缀的包（不扫整仓 Markdown 推测完成）"),
      ],
      static_clues: [],
      note: "收件目录是项目私有资料，塔台只读发现、不执行其中任何代码",
    },
    {
      id: "df-edge-inbox-scan",
      from: "df-node-sync-inbox",
      to: "df-node-sync-scan",
      relation: "read_write",
      label: "读：发现并核验收件目录里的证据包",
      claims: [cc("src/server/work/sync.ts", "export async function scanSyncProject(req: { projectId: string; dataDir: string; submitter: SyncSubmitter;", "读点：有界增量扫描收件目录，只接受匹配契约的包")],
      static_clues: [],
      note: "只读状态与实际认领边界都复核来源与目标；旧通过不能遮住后续变化",
    },
    {
      id: "df-edge-scan-service",
      from: "df-node-sync-scan",
      to: "df-node-write-service",
      relation: "transfer",
      label: "提交：核验结论经唯一写入服务落账",
      claims: [
        cc("src/server/work/sync.ts", "export async function commitSyncScan(", "提交点：主宿主侧提交阶段（唯一写口，写不跨线程）"),
        cc("src/server/work/sync.ts", "const receipt = await Promise.resolve(submit.call(req.submitter, cmd));", "提交点：逐条命令交给唯一写入者"),
      ],
      static_clues: [],
      note: "后台发现与显式扫描共用同一逻辑与单飞队列；写仍走唯一写口",
    },
    // ══ 第二阶段补齐（2026-10-08）：辅助/旧兼容数据的真实有向关系（逐条给 src 读/写点） ══
    {
      id: "df-edge-tools-discuss",
      from: "df-node-mcp-tools",
      to: "df-node-discuss",
      relation: "read_write",
      label: "写：append_discuss 把待议条目追加落盘（只追加）",
      claims: [cc("src/mcp/tools/appendDiscuss.ts", "const receipt = appendDiscuss(projectId, content);", "写点：工具面把待议条目交给 workstation 追加（只追加，不覆盖历史）")],
      static_clues: [],
      note: "待议记录是设计修订的讨论来源；工具面只追加、不改写既有条目",
    },
    {
      id: "df-edge-discuss-readout",
      from: "df-node-discuss",
      to: "df-node-mcp-readout",
      relation: "read_write",
      label: "读：read_design 把待议记录随设计原文读回",
      claims: [cc("src/mcp/tools/readDesign.ts", "const discuss = readDiscuss(projectId);", "读点：设计读口把待议记录一并交付（待议是设计修订的输入）")],
      static_clues: [],
      note: "待议记录随 read_design 交付给外部 Agent；它不改设计正文本身",
    },
    {
      id: "df-edge-tools-registry",
      from: "df-node-mcp-tools",
      to: "df-node-registry",
      relation: "read_write",
      label: "读写：list_projects 读注册表；登记经 addProject/writeRegistry",
      claims: [
        cc("src/mcp/tools/listProjects.ts", "const projects = listProjects().map((p) => ({", "读点：项目清单从注册表读回"),
        cc("src/server/registry.ts", "export function writeRegistry(", "写点：注册表写入的唯一实现（原子写）"),
      ],
      static_clues: [],
      note: "注册表是项目清单的唯一出处：各处按 id 解析项目根都从这里来",
    },
    {
      id: "df-edge-tools-progress",
      from: "df-node-mcp-tools",
      to: "df-node-progress-compat",
      relation: "read_write",
      label: "读写：update_progress 改模块状态、read_progress 读回（v1 兼容读数）",
      claims: [
        cc("src/mcp/tools/updateProgress.ts", "const progress = setModuleStatus(projectId, moduleId, status as ModuleStatus);", "写点：update_progress 改写 progress.json（v1 兼容写口）"),
        cc("src/mcp/tools/readProgress.ts", "const progress = readProgress(projectId);", "读点：read_progress 读回 progress.json（v1 兼容读数）"),
      ],
      static_clues: [],
      note: "progress.json 是**旧 v1 兼容数据**：这里只作 v1 读数，不把四色自报当 v2 事实（§4.2／附录 E.6）",
    },
    {
      id: "df-edge-progress-graphs",
      from: "df-node-progress-compat",
      to: "df-node-six-graphs",
      relation: "read_write",
      label: "读：渲染合成时读 progress 模块状态兜底",
      claims: [cc("src/arch/render.ts", "for (const m of readProgress(projectId, opts.dataDir).modules) {", "读点：共用图数据合成读 progress 模块状态（不可读即省略，不阻塞渲染）")],
      static_clues: [],
      note: "这是 v1 兼容读数进图面的落点；现行模块状态仍由 v2 证据派生，不由这里定",
    },
    {
      id: "df-edge-ui-gate",
      from: "df-node-workbench-ui",
      to: "df-node-gate-compat",
      relation: "read_write",
      label: "写：Gate 过关/打回经 recordGateTransition 追加流水",
      claims: [cc("src/server/index.ts", "const progress = recordGateTransition(projectId, {", "写点：Gate 转移经统一入口追加 gate.jsonl 一行（by 固定 user）")],
      static_clues: [],
      note: "Gate 流水是**旧 v1 数据**；用户 Gate 只由用户本人操作，Agent 不代签",
    },
    {
      id: "df-edge-gate-ui",
      from: "df-node-gate-compat",
      to: "df-node-workbench-ui",
      relation: "read_write",
      label: "读：readGateLines 把流水交给 Gate 时间线",
      claims: [cc("src/server/index.ts", "const lines = readGateLines(decodePathSegment(sub[1]));", "读点：Gate 时间线读回流水（只读，最新在上）")],
      static_clues: [],
      note: "流水只读展示；打回必带 note（写口强制），读口不改历史",
    },
    {
      id: "df-edge-tools-tasks",
      from: "df-node-mcp-tools",
      to: "df-node-tasks-compat",
      relation: "read_write",
      label: "读：list_tasks 读任务台账（v1 兼容投影）",
      claims: [cc("src/mcp/tools/listTasks.ts", 'const tasks = listTasks(projectId).filter((t) => moduleId === "" || t.module_id === moduleId);', "读点：任务台账读回（可按模块过滤）")],
      static_clues: [],
      note: "tasks.json 是**旧 v1 兼容投影**：v2 项目里它由事件重放写回，这里只作兼容读数，不冒充 v2 事实",
    },
    {
      id: "df-edge-ui-chat",
      from: "df-node-workbench-ui",
      to: "df-node-chat-log",
      relation: "read_write",
      label: "写：聊天发送经 appendMessage 逐行落盘（同步 append）",
      claims: [cc("src/server/index.ts", "appendMessage(projectId, sid, userLine);", "写点：用户消息同步逐行追加到会话 jsonl")],
      static_clues: [],
      note: "聊天落盘是实时红线：先落盘再回显，刷新/换会话可续",
    },
    {
      id: "df-edge-chat-ui",
      from: "df-node-chat-log",
      to: "df-node-workbench-ui",
      relation: "read_write",
      label: "读：readSession 读回会话全文供续聊/界面展示",
      claims: [cc("src/server/index.ts", "const history = readSession(projectId, sid);", "读点：会话全文读回（跳过坏行、其余照常读出）")],
      static_clues: [],
      note: "会话读回只作上下文与展示；不据此写任何状态",
    },
    {
      id: "df-edge-chat-supplement",
      from: "df-node-chat-log",
      to: "df-node-supplement-store",
      relation: "transform",
      label: "转换：聊天补全把聊天结论折成补全层（applySupplementInput）",
      claims: [cc("src/server/chatTools.ts", "const receipt = applySupplementInput(projectId, {", "转换点：聊天工具把补全节点/边写进 supplement.json（只增不删解析层）")],
      static_clues: [],
      note: "补全层是概念层：待审，不自动升格审定架构（§3.2／§4.1）",
    },
    {
      id: "df-edge-watcher-changes",
      from: "df-node-file-watcher",
      to: "df-node-changes-log",
      relation: "read_write",
      label: "写：文件监听合批追加变更流水",
      claims: [cc("src/server/watcher.ts", 'await fsp.appendFile(file, text, "utf8");', "写点：合批异步追加 changes.jsonl（写成功后才广播）")],
      static_clues: [],
      note: "自监听死循环已排除（.工作台 在忽略表内）；队列背压有上限",
    },
    {
      id: "df-edge-changes-ui",
      from: "df-node-changes-log",
      to: "df-node-workbench-ui",
      relation: "read_write",
      label: "读：readChanges 倒序读回变更流水",
      claims: [cc("src/server/watcher.ts", "export function readChanges(", "读点：时间倒序读回变更流水（坏行跳过并计数）")],
      static_clues: [],
      note: "流水只读回显；与 SSE 广播同一份口径",
    },
    {
      id: "df-edge-ui-layout-write",
      from: "df-node-workbench-ui",
      to: "df-node-layout-store",
      relation: "read_write",
      label: "写：画布拖动 debounce 经 PUT /arch/layout 合并写回坐标",
      claims: [
        cc("src/ui/api.ts", "export async function putArchLayout(", "写点：前端 PUT 把本次上报的节点坐标交给服务端"),
        cc("src/server/index.ts", "const saved = savePositions(projectId, positions as Record<string, NodePosition>, mode as GraphMode);", "写点：服务端按视图合并写回 layout.json（其它视图原样保留）"),
      ],
      static_clues: [],
      note: "布局记忆按视图分键：两视图各存各的，互不覆盖",
    },
    {
      id: "df-edge-layout-ui-read",
      from: "df-node-layout-store",
      to: "df-node-workbench-ui",
      relation: "read_write",
      label: "读：GET /arch/layout 复原画布坐标（旧结构迁移不丢坐标）",
      claims: [cc("src/ui/api.ts", "export async function getArchLayout(id: string): Promise<ArchLayoutFile> {", "读点：前端取回全量两视图坐标，刷新/重开据此复原")],
      static_clues: [],
      note: "读接口不产生写盘副作用（远程只读来源走 migrate:false，不偷偷迁移写回）",
    },
    {
      id: "df-edge-ui-names-write",
      from: "df-node-workbench-ui",
      to: "df-node-names-store",
      relation: "read_write",
      label: "写：POST /arch/name 触发起名并落 names.json（幂等走缓存）",
      claims: [
        cc("src/ui/api.ts", "const res = await apiFetch(`/api/projects/${encodeURIComponent(id)}/arch/name`, {", "触发点：界面按签名请求起名（签名未变零请求）"),
        cc("src/arch/name.ts", "export async function nameModules(", "写点：起名结果落 names.json（人话名缓存）"),
      ],
      static_clues: [],
      note: "人话名一律待审：改名只影响展示，不改架构与状态",
    },
    {
      id: "df-edge-names-graphs",
      from: "df-node-names-store",
      to: "df-node-six-graphs",
      relation: "read_write",
      label: "读：共用图数据合成时读人话名",
      claims: [cc("src/arch/render.ts", "const names = readNames(project.path);", "读点：三视图共用合成读 names.json（缺失不视为错误，name 兜底 id）")],
      static_clues: [],
      note: "names 缺失按 id 兜底：读路径只降级展示，不阻塞渲染",
    },
    {
      id: "df-edge-ui-fold-write",
      from: "df-node-workbench-ui",
      to: "df-node-fold-store",
      relation: "read_write",
      label: "写：思维导图折叠态经 PUT /arch/mindmap-fold 覆盖写回",
      claims: [
        cc("src/ui/api.ts", "export async function putArchMindMapFold(", "写点：前端 PUT 覆盖写本项目那份展开态"),
        cc("src/server/index.ts", "const saved = saveFold(projectId, expanded ?? []);", "写点：服务端只动本项目键、其它项目原样保留（原子落盘）"),
      ],
      static_clues: [],
      note: "折叠态按项目 id 再嵌一层：文件与注册表 id 对不上就返回空（不猜、不串台）",
    },
    {
      id: "df-edge-fold-ui-read",
      from: "df-node-fold-store",
      to: "df-node-workbench-ui",
      relation: "read_write",
      label: "读：GET /arch/mindmap-fold 读回展开态",
      claims: [cc("src/ui/api.ts", "export async function getArchMindMapFold(id: string): Promise<MindMapExpandEntry[]> {", "读点：导图进入时读回已展开清单，只补拉已展开的枝")],
      static_clues: [],
      note: "缺文件/缺本项目键 → 空数组 = 默认全折叠（§3.3 规则 5）",
    },
    {
      id: "df-edge-reconcile-store",
      from: "df-node-reconcile-proc",
      to: "df-node-reconcile-store",
      relation: "read_write",
      label: "写：跑一次对账并原子落 reconcile-last.json（消费 reconcile-request 钩子）",
      claims: [cc("src/arch/reconcile.ts", "writeJsonAtomic(reconcileLastPath(projectId, opts.dataDir), result);", "写点：对账结果原子写回对账上下文（同一次消费待处理请求）")],
      static_clues: [],
      note: "条目 id（ref_key）定身份、内容哈希回指当时的待议文本；差异是信号不是错误",
    },
    {
      id: "df-edge-reconcile-graphs",
      from: "df-node-reconcile-store",
      to: "df-node-six-graphs",
      relation: "read_write",
      label: "读：读最近对账结果派生声明配对（图面标黄）",
      claims: [cc("src/arch/render.ts", "const links = declaredLinksOf(readLastReconcile(projectId, opts.dataDir).result ?? null);", "读点：技术详情层从最近对账结果取声明配对（只有点名「实现落点」的配对才有资格）")],
      static_clues: [],
      note: "只有材料点名「实现落点」的配对才继承状态色；对账结果缺位则状态表空（不回落 v1 四色）",
    },
    {
      id: "df-edge-reconcile-ui",
      from: "df-node-reconcile-store",
      to: "df-node-workbench-ui",
      relation: "read_write",
      label: "读：GET /arch/reconcile 取最近对账结果",
      claims: [cc("src/ui/api.ts", "export async function getArchReconcile(", "读点：对账面板取最近结果（exists:false = 未跑过，200 空态）")],
      static_clues: [],
      note: "对账结果只读回显；跑对账另有 POST 立即触发（消费 B3 钩子）",
    },
    {
      id: "df-edge-supplement-graphs",
      from: "df-node-supplement-store",
      to: "df-node-six-graphs",
      relation: "read_write",
      label: "读：三视图共用合成点合并补全层（capMergedGraph 收口）",
      claims: [cc("src/arch/render.ts", "const sup = readSupplement(projectId, opts.dataDir);", "读点：共用数据层合成后合并补全层（补全层损坏不拖垮读路径）")],
      static_clues: [],
      note: "补全层与解析层**合并后**统一再施一遍防爆炸（capMergedGraph），不另算一套口径",
    },
    {
      id: "df-edge-ui-logs-write",
      from: "df-node-workbench-ui",
      to: "df-node-logs-store",
      relation: "read_write",
      label: "写：终端会话经 recorder 追加命令历史到 logs/",
      claims: [
        cc("src/server/pty.ts", "history: new TerminalHistoryRecorder(sid, projectId, project.path),", "写点：每个终端会话挂一个 recorder，落 <项目根>/.工作台/logs/terminal-history.jsonl"),
        cc("src/server/terminalHistory.ts", "export function appendTerminalHistoryLine(projectId: string, line: TerminalHistoryLine): void {", "写点：命令历史只追加落 logs/（超限归档）"),
      ],
      static_clues: [],
      note: "命令历史只追加；日志目录是项目私有资料，外泄面已排除",
    },
    {
      id: "df-edge-logs-ui-read",
      from: "df-node-logs-store",
      to: "df-node-workbench-ui",
      relation: "read_write",
      label: "读：终端历史检索读回 logs/",
      claims: [cc("src/server/index.ts", "const result = queryTerminalHistory(projectId, params.get(\"q\") ?? undefined, limit);", "读点：终端视图按关键字检索命令历史")],
      static_clues: [],
      note: "检索只读；清除历史是独立写口（同样只走登记路径）",
    },
    {
      id: "df-edge-ui-decisions",
      from: "df-node-workbench-ui",
      to: "df-node-decisions-store",
      relation: "read_write",
      label: "写：处置记录经 appendDecision 追加（只追加、不 write/truncate）",
      claims: [cc("src/server/index.ts", "const record = appendDecision(projectWorkbenchDir(id, DATA_DIR), {", "写点：处置记录只追加入口（没有任何 write/truncate 分支）")],
      static_clues: [],
      note: "处置记录只追加：驳回的方案也保留理由（§2.5）",
    },
    {
      id: "df-edge-decisions-readout",
      from: "df-node-decisions-store",
      to: "df-node-mcp-readout",
      relation: "read_write",
      label: "读：接续入口把处置记录随 project_entry 交付",
      claims: [cc("src/server/work/entry.ts", "decisions = readDecisions(workDir).records;", "读点：接续入口合成时读回处置记录（与 read_design 同一份判据）")],
      static_clues: [],
      note: "只读交付给外部 Agent；Agent 不能代用户改变处置结论",
    },
    {
      id: "df-edge-intent-requirement",
      from: "df-node-intent-store",
      to: "df-node-requirement",
      relation: "read_write",
      label: "读：需求登记前解析 intent.json 来源引用（悬空即拒）",
      claims: [
        cc("src/server/work/intent.ts", "export function readIntentFile(workbenchDir: string): IntentFile | null {", "读点：意图原文按 {version,items} 解析（文件不在如实返回 null）"),
        cc("src/server/work/intent.ts", "export function resolveIntentRef(workbenchDir: string, ref: string): IntentRefLookup {", "校验点：`intent.json#<id>` / 裸 `<id>` 在原文里实解析，悬空不放过"),
      ],
      static_clues: [],
      note: "intent.json 由人直接编写（产品侧只读不写）；来源引用必须指得着",
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
    {
      id: "df-chain-tatai-evidence-record",
      label: "Agent 经 MCP 记证据 → 工具面 → 唯一写入服务 → 证据正文（内容寻址）→ MCP 读回",
      hops: [
        "df-node-mcp-client",
        "df-node-mcp-tools",
        "df-node-write-service",
        "df-node-evidence-record",
        "df-node-evidence-store",
        "df-node-mcp-readout",
      ],
      edges: [
        null,
        "df-edge-client-tools",
        "df-edge-tools-evidence-service",
        "df-edge-service-evidence-record",
        "df-edge-evidence-record-store",
        "df-edge-evidence-store-readout",
      ],
      note: "证据存证链：正文按内容寻址落不可变对象，事件只引用哈希；stdio 进程不自己写项目目录（§2.6／§5.5）。",
    },
    {
      id: "df-chain-tatai-plan-import",
      label: "施工定义原文 → 定义导入 → 唯一写入服务 → 事件台账 → 状态投影 → 接续读口",
      hops: [
        "df-node-plan-source",
        "df-node-definition-import",
        "df-node-write-service",
        "df-node-work-events",
        "df-node-projection",
        "df-node-mcp-readout",
      ],
      edges: [null, "df-edge-plan-import", "df-edge-import-service", "df-edge-service-events", "df-edge-events-projection", "df-edge-projection-readout"],
      note: "施工定义导入链：导入只落不可变任务定义、不产生执行事实；任务状态来自后续事件（§2.6）。",
    },
    {
      id: "df-chain-tatai-requirement-ledger",
      label: "设计源 → 需求登记 → 唯一写入服务 → 事件台账 → 唯一义务派生 → 功能清单读口",
      hops: [
        "df-node-design-source",
        "df-node-requirement",
        "df-node-write-service",
        "df-node-work-events",
        "df-node-obligations",
        "df-node-feature-ledger",
      ],
      edges: [
        null,
        "df-edge-design-requirement",
        "df-edge-requirement-service",
        "df-edge-service-events",
        "df-edge-events-obligations",
        "df-edge-obligations-ledger",
      ],
      note: "需求→功能清单链：需求与任务共用同一条事件账本；功能清单是唯一义务派生的只读投影，不建第二张完成表（§2.6／§6.12）。",
    },
    {
      id: "df-chain-tatai-sync-evidence",
      label: "外部证据包 → 同步收件目录 → 同步核验 → 唯一写入服务 → 事件台账 → 状态投影 → 接续读口",
      hops: [
        "df-node-sync-package",
        "df-node-sync-inbox",
        "df-node-sync-scan",
        "df-node-write-service",
        "df-node-work-events",
        "df-node-projection",
        "df-node-mcp-readout",
      ],
      edges: [
        null,
        "df-edge-package-inbox",
        "df-edge-inbox-scan",
        "df-edge-scan-service",
        "df-edge-service-events",
        "df-edge-events-projection",
        "df-edge-projection-readout",
      ],
      note: "同步证据核验链：只接受匹配契约的证据包，逐项比对当前实际目标；通过只表示所登记范围在该版本对账通过，不等于业务实现/独立审计/用户 Gate（§2.10）。",
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
      // 本条证的是「受检入口 importPlanChecked → submitDefinitionImports 真写口」这一段：
      // 直接依赖就是这两处实现的文件（不对应单个已登记节点/关系，故显式声明，不靠空 node/edge 混过去）。
      sources: ["src/server/work/references.ts", "src/server/work/tasks.ts"],
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
      find: "const r = parseProject(isoId, isoHome);",
      proves: "真的在隔离夹具上跑一次 tree-sitter 解析（代码线索 → 模块骨架这一跳真被走过，不重写真实项目）",
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
      // 本条证的是数据链模型本体（analyzeDataFlow + 逐条出处/覆盖对账）与其实测采信判据：
      // 直接依赖是这两处实现的文件（不对应单个已登记节点/关系，故显式声明）。
      sources: ["src/arch/dataflow.ts", "src/arch/dataflowEvidence.ts"],
      artifact_ids: [],
      node_ids: [],
      edge_ids: [],
    },
    // 其余已实现核心链路的可复跑实测登记。注意：登记本身只是**可复跑线索**（脚本在 + 登记在 package.json +
    // 正文含定位片段）；要判「可复跑实测」还须有**正式记录引用**的当前可成立运行记录（见 dataflowEvidence.ts）。
    {
      id: "df-measured-v06-08-f-evidence",
      script: "scripts/verify-v06-08-f.ts",
      npm_script: "verify:v06-08-f",
      find: "putEvidence(projectWorkDir(A, dataDir), {",
      proves: "隔离夹具里真的调用 putEvidence 把证据正文按内容寻址落盘（证据正文这一跳真被走过）",
      artifact_ids: ["df-art-evidence"],
      node_ids: ["df-node-evidence-record", "df-node-evidence-store"],
      edge_ids: ["df-edge-evidence-record-store"],
    },
    {
      id: "df-measured-v06-09-evidence-read",
      script: "scripts/verify-v06-09.ts",
      npm_script: "verify:v06-09",
      find: 'const missingEvidence = codeOf(() => readEvidence(MAIN_WORK, sha256("这份证据不存在")));',
      proves: "隔离夹具里真的按内容地址读回证据正文并复核哈希（读不到即报错，不返回空成功）",
      artifact_ids: [],
      node_ids: ["df-node-evidence-store"],
      edge_ids: ["df-edge-evidence-store-readout"],
    },
    {
      id: "df-measured-host-work-package-tool",
      script: "scripts/verify-host-work-package.ts",
      npm_script: "verify:host-work-package",
      find: "const r = await tool.handler(args, { clientName: executor, ...ctx } as never);",
      proves: "隔离夹具里真的经 MCP 工具 handler 入口调用（含 record_work_evidence 存证），经 ctx.work 转接宿主",
      artifact_ids: [],
      node_ids: ["df-node-mcp-tools", "df-node-write-service"],
      edge_ids: ["df-edge-tools-evidence-service", "df-edge-service-evidence-record"],
    },
    {
      id: "df-measured-definition-align-import",
      script: "scripts/verify-definition-align.ts",
      npm_script: "verify:definition-align",
      find: "const defs = importPlanChecked(planNoTable(",
      proves: "隔离夹具里真的从施工图解析出任务定义并经真唯一写服务导入（施工定义导入这一跳真被走过）",
      artifact_ids: ["df-art-plan"],
      node_ids: ["df-node-plan-source", "df-node-definition-import"],
      edge_ids: ["df-edge-plan-import", "df-edge-import-service"],
    },
    {
      id: "df-measured-requirements-register",
      script: "scripts/verify-requirements.ts",
      npm_script: "verify:requirements",
      find: "const reqRec = registerRequirement(submitter, {",
      proves: "隔离夹具里真的经唯一写服务登记需求对象并读回（需求登记这一跳真被走过）",
      artifact_ids: [],
      node_ids: ["df-node-requirement"],
      edge_ids: ["df-edge-design-requirement", "df-edge-requirement-service"],
    },
    {
      id: "df-measured-forward-baseline-preserve",
      script: "scripts/verify-forward-baseline.ts",
      npm_script: "verify:forward-baseline",
      find: 'const pres = await callTool({ project_id: PID, op: "preserve", role: "designer", kind: "design" }, ctxWith());',
      proves: "隔离夹具里真的经 MCP 工具面 preserve 一份不可变修订并确认落盘（基线修订这一跳真被走过）",
      artifact_ids: ["df-art-design-revisions"],
      node_ids: ["df-node-baseline", "df-node-revisions-store"],
      edge_ids: ["df-edge-baseline-revisions"],
    },
    {
      id: "df-measured-c016-baseline-activate",
      script: "scripts/verify-c016-blueprint-authority.ts",
      npm_script: "verify:c016-blueprint-authority",
      find: 'activateBaseline(IO_ID, { approved_by: "user"',
      proves: "隔离夹具里真的激活基线并追加基线记录（基线激活这一跳真被走过）",
      artifact_ids: ["df-art-baselines"],
      node_ids: ["df-node-baseline", "df-node-baselines-store"],
      edge_ids: ["df-edge-design-baseline", "df-edge-baseline-baselines"],
    },
    {
      id: "df-measured-sync-evidence-scan",
      script: "scripts/verify-sync-evidence.ts",
      npm_script: "verify:sync-evidence",
      find: "const scanOf = () => syncMod.scanSyncProject({ projectId: PID, dataDir, submitter });",
      proves: "隔离夹具里真的把证据包投进收件目录并扫描核验、经唯一写服务落账（同步核验这一跳真被走过）",
      artifact_ids: ["df-art-sync-inbox"],
      node_ids: ["df-node-sync-package", "df-node-sync-inbox", "df-node-sync-scan"],
      edge_ids: ["df-edge-package-inbox", "df-edge-inbox-scan", "df-edge-scan-service"],
    },
  ],
};

/**
 * 登记表（键＝注册表里的项目 id）。这里只放**塔台自身的内建声明**（`tatai`）。
 * 其他项目的「数据输入／存储／输出」声明**不写进塔台源码**：按项目根读取项目侧声明文件
 * （见 `DATA_FLOW_DECLARATION_PATH` 与 `loadDataFlowIndex`），这样塔台不编译、不硬编码任何具体项目。
 */
export const DATA_FLOW_INDEXES: Readonly<Record<string, ProjectIndex>> = { tatai: TATAI_INDEX };

/** 内建的「已登记声明」项目 id（不含由项目侧声明文件动态登记的项目；未登记 = 做不了覆盖对账，交付结论同样不得给出） */
export const dataFlowRegisteredProjects = (): readonly string[] => Object.keys(DATA_FLOW_INDEXES);

/**
 * 项目侧数据流声明的**约定位置**（项目根内相对路径）。与 `.工作台/arch/` 里其他机器视图（`modules.json`
 * 等）同层：声明是项目的私有资料，放项目自己的私有目录，塔台只读、不写、不执行其中任何代码（只 `JSON.parse`）。
 */
export const DATA_FLOW_DECLARATION_PATH = ".工作台/arch/dataflow-index.json";

/** 声明的读取上限（体积 / 各数组条数）：超限即显式报错，不静默截断、不抽样代表全量。 */
const DATA_FLOW_DECLARATION_MAX_BYTES = 8 * 1024 * 1024;
const DATA_FLOW_DECLARATION_MAX_ITEMS = 5000;

const DATA_FLOW_TIERS: readonly DataFlowProvenanceTier[] = ["design_declared", "code_static", "code_measured"];

/** **自有属性**查询（不用 `obj[key]` 继承口）：`constructor`/`__proto__`/`toString` 等项目名不得被当内建键。 */
const hasOwn = (map: object, key: string): boolean => Object.prototype.hasOwnProperty.call(map, key);

/** 该声明索引是否为**塔台内建**（`DATA_FLOW_INDEXES` 里的值，按对象同一性认）：
 *  只有内建声明才允许回退内建的 artifact→node 对应表；项目侧声明的同名 id 不许串到塔台内建映射。 */
const isBuiltinIndex = (index: ProjectIndex): boolean => Object.values(DATA_FLOW_INDEXES).some((builtin) => builtin === index);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * 物理越界判定（软链/junction）：词法在根内还不够——真实路径也必须落在项目根内。
 * 文件不存在/不是文件 ⇒ false（缺文件是复算层的「报缺」，不是结构错误，交给 resolveClaim）。
 */
function escapesRoot(root: string, rel: string): boolean {
  const abs = path.resolve(root, rel);
  if (path.relative(root, abs).startsWith("..")) return true;
  try {
    if (!fs.statSync(abs).isFile()) return false;
    const realAbs = fs.realpathSync(abs);
    const realRoot = realRootOf(root);
    return !(realAbs === realRoot || realAbs.startsWith(realRoot + path.sep));
  } catch {
    return false;
  }
}

/** 声明里被引用的全部路径（含 design_path / code / claims / static_clues / measured.script） */
function referencedPaths(index: ProjectIndex): string[] {
  const out: string[] = [index.design_path];
  for (const a of index.artifacts) {
    out.push(a.design.path, ...a.code.map((c) => c.path));
  }
  for (const n of index.nodes) {
    out.push(...n.claims.map((c) => c.path), ...n.static_clues.map((c) => c.path));
  }
  for (const e of index.edges) {
    out.push(...e.claims.map((c) => c.path), ...e.static_clues.map((c) => c.path));
  }
  for (const m of index.measured) {
    out.push(m.script);
  }
  return out;
}

/** 危险路径判定：只接受**项目根内相对路径**（拒绝绝对路径／盘符／UNC／`..` 上跳／NUL；越界不静默） */
function unsafeRelPath(p: unknown): boolean {
  if (typeof p !== "string" || p.trim() === "") return true;
  const s = p.replace(/\\/g, "/");
  if (s.startsWith("/") || s.startsWith("//")) return true;
  if (/^[a-zA-Z]:/.test(s)) return true;
  if (s.includes("\0")) return true;
  return s.split("/").some((seg) => seg === "..");
}

/** 校验一条出处声明（tier / path / section? / find / note / __checked_locator?），不合格即报错返回 null */
function validateClaim(raw: unknown, where: string, errors: string[]): EvidenceClaim | null {
  if (!isPlainObject(raw)) {
    errors.push(`${where} 不是对象`);
    return null;
  }
  for (const k of ["tier", "path", "find", "note"] as const) {
    if (typeof raw[k] !== "string" || (raw[k] as string).trim() === "") {
      errors.push(`${where}.${k} 必须是非空字符串`);
      return null;
    }
  }
  if (!DATA_FLOW_TIERS.includes(raw.tier as DataFlowProvenanceTier)) {
    errors.push(`${where}.tier 不在三档（design_declared/code_static/code_measured）内：${String(raw.tier)}`);
    return null;
  }
  // 可复跑实测档**不许在声明里自报**：它必须走 `measured` 登记（script+npm_script+find，由 resolveMeasured
  // 真核过脚本存在、登记在 package.json、正文含定位片段）。否则项目侧声明可凭空把自己标成「已验证」。
  if (raw.tier === "code_measured") {
    errors.push(`${where}.tier=code_measured 不允许由声明自报：可复跑实测档须走 measured 登记（script+npm_script+find）`);
    return null;
  }
  if (unsafeRelPath(raw.path)) {
    errors.push(`${where}.path 不是项目根内合法相对路径（拒绝绝对路径/盘符/UNC/.. 上跳/NUL）：${String(raw.path)}`);
    return null;
  }
  if (raw.section !== undefined && typeof raw.section !== "string") {
    errors.push(`${where}.section 给了就必须是字符串`);
    return null;
  }
  if (raw.__checked_locator !== undefined && typeof raw.__checked_locator !== "string") {
    errors.push(`${where}.__checked_locator 给了就必须是字符串`);
    return null;
  }
  return {
    tier: raw.tier as DataFlowProvenanceTier,
    path: raw.path as string,
    ...(raw.section !== undefined ? { section: raw.section as string } : {}),
    find: raw.find as string,
    note: raw.note as string,
    ...(raw.__checked_locator !== undefined ? { __checked_locator: raw.__checked_locator as string } : {}),
  };
}

function validateClaims(raw: unknown, where: string, errors: string[]): EvidenceClaim[] | null {
  if (!Array.isArray(raw)) {
    errors.push(`${where} 必须是数组`);
    return null;
  }
  const out: EvidenceClaim[] = [];
  for (let i = 0; i < raw.length; i++) {
    const c = validateClaim(raw[i], `${where}[${i}]`, errors);
    if (c === null) return null;
    out.push(c);
  }
  return out;
}

/**
 * 把项目侧声明文件（未知 JSON）校验成 `ProjectIndex`：结构不符即逐条报错返回 null——
 * 不静默丢弃坏项、不把坏声明当空声明、不伪造任何声明。
 */
function validateProjectIndex(raw: unknown, errors: string[]): ProjectIndex | null {
  if (!isPlainObject(raw)) {
    errors.push("顶层必须是对象");
    return null;
  }
  if (raw.version !== undefined && raw.version !== 1) {
    errors.push(`version 只支持 1，实际 ${String(raw.version)}`);
    return null;
  }
  if (typeof raw.design_path !== "string" || raw.design_path.trim() === "" || unsafeRelPath(raw.design_path)) {
    errors.push("design_path 必须是项目根内相对路径");
    return null;
  }
  const arrays = ["artifacts", "nodes", "edges", "chains", "measured"] as const;
  for (const key of arrays) {
    if (!Array.isArray(raw[key])) {
      errors.push(`${key} 必须是数组`);
      return null;
    }
    if ((raw[key] as unknown[]).length > DATA_FLOW_DECLARATION_MAX_ITEMS) {
      errors.push(`${key} 条数超过上限 ${DATA_FLOW_DECLARATION_MAX_ITEMS}`);
      return null;
    }
  }

  const artifacts: DeclaredArtifact[] = [];
  for (let i = 0; i < (raw.artifacts as unknown[]).length; i++) {
    const a = (raw.artifacts as unknown[])[i];
    const where = `artifacts[${i}]`;
    if (!isPlainObject(a)) {
      errors.push(`${where} 不是对象`);
      return null;
    }
    if (typeof a.id !== "string" || a.id.trim() === "" || typeof a.artifact !== "string" || typeof a.role !== "string") {
      errors.push(`${where} 的 id/artifact/role 必须是非空字符串`);
      return null;
    }
    if (!(DATA_FLOW_ENTITY_KINDS as readonly string[]).includes(a.kind as string)) {
      errors.push(`${where}.kind 不在四类实体（input_source/process/store/output_external）内：${String(a.kind)}`);
      return null;
    }
    if (a.declaration_status !== "current" && a.declaration_status !== "declared_not_implemented") {
      errors.push(`${where}.declaration_status 非法：${String(a.declaration_status)}`);
      return null;
    }
    const design = validateClaim(a.design, `${where}.design`, errors);
    if (design === null) return null;
    const code = validateClaims(a.code, `${where}.code`, errors);
    if (code === null) return null;
    if (a.node_id !== undefined && a.node_id !== null && typeof a.node_id !== "string") {
      errors.push(`${where}.node_id 给了就只能是字符串或 null`);
      return null;
    }
    artifacts.push({
      id: a.id,
      artifact: a.artifact,
      kind: a.kind as DataFlowEntityKind,
      declaration_status: a.declaration_status,
      design,
      code,
      role: a.role,
      ...(a.node_id !== undefined ? { node_id: a.node_id as string | null } : {}),
    });
  }

  const nodes: NodeSpec[] = [];
  for (let i = 0; i < (raw.nodes as unknown[]).length; i++) {
    const n = (raw.nodes as unknown[])[i];
    const where = `nodes[${i}]`;
    if (!isPlainObject(n) || typeof n.id !== "string" || typeof n.label !== "string" || typeof n.role !== "string") {
      errors.push(`${where} 形状不符（需 id/label/role 字符串）`);
      return null;
    }
    if (!(DATA_FLOW_ENTITY_KINDS as readonly string[]).includes(n.kind as string)) {
      errors.push(`${where}.kind 不在四类实体内`);
      return null;
    }
    const claims = validateClaims(n.claims, `${where}.claims`, errors);
    if (claims === null) return null;
    const clues = validateClues(n.static_clues, `${where}.static_clues`, errors);
    if (clues === null) return null;
    nodes.push({ id: n.id, kind: n.kind as DataFlowEntityKind, label: n.label, role: n.role, claims, static_clues: clues });
  }

  const edges: EdgeSpec[] = [];
  for (let i = 0; i < (raw.edges as unknown[]).length; i++) {
    const e = (raw.edges as unknown[])[i];
    const where = `edges[${i}]`;
    if (
      !isPlainObject(e) ||
      typeof e.id !== "string" ||
      typeof e.from !== "string" ||
      typeof e.to !== "string" ||
      typeof e.label !== "string" ||
      typeof e.note !== "string"
    ) {
      errors.push(`${where} 形状不符（需 id/from/to/label/note 字符串）`);
      return null;
    }
    if (!(DATA_FLOW_RELATION_KINDS as readonly string[]).includes(e.relation as string)) {
      errors.push(`${where}.relation 不在四类关系（produce/transfer/read_write/transform）内`);
      return null;
    }
    const claims = validateClaims(e.claims, `${where}.claims`, errors);
    if (claims === null) return null;
    const clues = validateClues(e.static_clues, `${where}.static_clues`, errors);
    if (clues === null) return null;
    edges.push({
      id: e.id,
      from: e.from,
      to: e.to,
      relation: e.relation as DataFlowRelationKind,
      label: e.label,
      claims,
      static_clues: clues,
      note: e.note,
    });
  }

  const chains: ChainSpec[] = [];
  for (let i = 0; i < (raw.chains as unknown[]).length; i++) {
    const c = (raw.chains as unknown[])[i];
    const where = `chains[${i}]`;
    if (!isPlainObject(c) || typeof c.id !== "string" || typeof c.label !== "string" || typeof c.note !== "string") {
      errors.push(`${where} 形状不符（需 id/label/note 字符串）`);
      return null;
    }
    if (!Array.isArray(c.hops) || !c.hops.every((h) => typeof h === "string" || h === null) || !Array.isArray(c.edges)) {
      errors.push(`${where} 的 hops/edges 形状不符`);
      return null;
    }
    if (!c.edges.every((x) => typeof x === "string" || x === null)) {
      errors.push(`${where}.edges 只能含字符串或 null`);
      return null;
    }
    chains.push({ id: c.id, label: c.label, hops: c.hops as string[], edges: c.edges as (string | null)[], note: c.note });
  }

  const measured: MeasuredSpec[] = [];
  for (let i = 0; i < (raw.measured as unknown[]).length; i++) {
    const m = (raw.measured as unknown[])[i];
    const where = `measured[${i}]`;
    if (
      !isPlainObject(m) ||
      typeof m.id !== "string" ||
      typeof m.script !== "string" ||
      typeof m.npm_script !== "string" ||
      typeof m.find !== "string" ||
      typeof m.proves !== "string"
    ) {
      errors.push(`${where} 形状不符（需 id/script/npm_script/find/proves 字符串）`);
      return null;
    }
    if (unsafeRelPath(m.script)) {
      errors.push(`${where}.script 不是项目根内合法相对路径`);
      return null;
    }
    const ids = (v: unknown, key: string): string[] | null => {
      if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
        errors.push(`${where}.${key} 必须是字符串数组`);
        return null;
      }
      return v as string[];
    };
    const artifact_ids = ids(m.artifact_ids, "artifact_ids");
    const node_ids = ids(m.node_ids, "node_ids");
    const edge_ids = ids(m.edge_ids, "edge_ids");
    if (artifact_ids === null || node_ids === null || edge_ids === null) return null;
    // 可选的「依赖源码集合」：给了就逐条必须是项目根内合法相对路径（越界不静默）
    let sources: string[] | undefined;
    if (m.sources !== undefined && m.sources !== null) {
      const s = ids(m.sources, "sources");
      if (s === null) return null;
      for (const p of s) {
        if (unsafeRelPath(p)) {
          errors.push(`${where}.sources 里不是项目根内合法相对路径：${String(p)}`);
          return null;
        }
      }
      sources = s;
    }
    measured.push({
      id: m.id,
      script: m.script,
      npm_script: m.npm_script,
      find: m.find,
      proves: m.proves,
      ...(sources === undefined ? {} : { sources }),
      artifact_ids,
      node_ids,
      edge_ids,
    });
  }

  return { design_path: raw.design_path, artifacts, nodes, edges, chains, measured };
}

function validateClues(
  raw: unknown,
  where: string,
  errors: string[],
): { path: string; find: string; note: string }[] | null {
  if (!Array.isArray(raw)) {
    errors.push(`${where} 必须是数组`);
    return null;
  }
  const out: { path: string; find: string; note: string }[] = [];
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (!isPlainObject(c) || typeof c.path !== "string" || typeof c.find !== "string" || typeof c.note !== "string") {
      errors.push(`${where}[${i}] 形状不符（需 path/find/note 字符串）`);
      return null;
    }
    if (unsafeRelPath(c.path)) {
      errors.push(`${where}[${i}].path 不是项目根内合法相对路径`);
      return null;
    }
    out.push({ path: c.path, find: c.find, note: c.note });
  }
  return out;
}

export interface DataFlowDeclarationLoad {
  index: ProjectIndex | null;
  /** 本次实际读取的内容指纹；坏声明也保留，用于拒绝旧快照。 */
  content_sha256?: string;
  /** 缺失/坏声明/越界路径的具体原因（index 为 null 时必有）；null 表示加载成功 */
  error: string | null;
  /** 成功时的来源留痕（相对路径 + sha256 + version） */
  source: { path: string; sha256: string; version: number } | null;
}

/**
 * 只读加载**项目侧数据流声明**（`<项目根>/DATA_FLOW_DECLARATION_PATH`）。安全口径：
 *   · 不执行项目提供的任何 JS/TS——只按 JSON 解析（`JSON.parse`）；
 *   · 体积与条数设上限，超限报错不截断；
 *   · 结构逐项校验（枚举/形状/类型），任何一项不合格即整体判失败并给出原因；
 *   · 每条路径都必须是项目根内相对路径，越界（绝对路径/盘符/UNC/`..`/NUL）显式报错。
 * 缺失或不合格一律返回 `index: null` + `error`：调用方据此报「显式缺口」，**不伪造可交付**。
 */
export function loadDataFlowIndex(projectRoot: string): DataFlowDeclarationLoad {
  const root = path.resolve(projectRoot);
  const abs = path.resolve(root, DATA_FLOW_DECLARATION_PATH);
  if (path.relative(root, abs).startsWith("..")) {
    return { index: null, error: `声明文件路径越出项目根：${abs}`, source: null };
  }
  if (escapesRoot(root, DATA_FLOW_DECLARATION_PATH)) {
    return { index: null, error: "声明文件本身越出项目根（软链/junction 逃逸）", source: null };
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    return { index: null, error: `未找到项目侧数据流声明文件 ${DATA_FLOW_DECLARATION_PATH}（缺失即显式缺口）`, source: null };
  }
  if (!stat.isFile()) {
    return { index: null, error: `${DATA_FLOW_DECLARATION_PATH} 不是文件（缺失即显式缺口）`, source: null };
  }
  if (stat.size > DATA_FLOW_DECLARATION_MAX_BYTES) {
    return { index: null, error: `${DATA_FLOW_DECLARATION_PATH} 体积 ${stat.size} 超过上限 ${DATA_FLOW_DECLARATION_MAX_BYTES} 字节`, source: null };
  }
  let text: string;
  try {
    text = fs.readFileSync(abs, "utf8");
  } catch (e) {
    return { index: null, error: `${DATA_FLOW_DECLARATION_PATH} 读不到：${e instanceof Error ? e.message : String(e)}`, source: null };
  }
  const sha256 = sha256Hex(text);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { index: null, content_sha256: sha256, error: `${DATA_FLOW_DECLARATION_PATH} 不是合法 JSON：${e instanceof Error ? e.message : String(e)}`, source: null };
  }
  const errors: string[] = [];
  const index = validateProjectIndex(raw, errors);
  if (index === null) {
    return { index: null, content_sha256: sha256, error: `${DATA_FLOW_DECLARATION_PATH} 结构不合格：${errors.slice(0, 5).join("；")}`, source: null };
  }
  const escaping = referencedPaths(index).find((p) => escapesRoot(root, p));
  if (escaping !== undefined) {
    return {
      index: null,
      error: `${DATA_FLOW_DECLARATION_PATH} 引用的路径越出项目根（软链/junction 逃逸）：${escaping}`,
      content_sha256: sha256,
      source: null,
    };
  }
  const version = isPlainObject(raw) && typeof raw.version === "number" ? raw.version : 1;
  return { index, content_sha256: sha256, error: null, source: { path: DATA_FLOW_DECLARATION_PATH, sha256, version } };
}

/** 可复跑入口表（项目根 `package.json` 的 scripts）：拿不到就等于"不可复跑"，实测档一律作废 */
function readPackageScripts(projectRoot: string): Readonly<Record<string, string>> {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8")) as {
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

/** 实测未采信时的降级：脚本仍是**可复跑线索**（`code_static` 档），但**不得**算「可复跑实测」 */
function measuredClueRef(spec: MeasuredSpec, file: { sha256: string }, line: number, why: string): DataFlowEvidenceRef {
  return {
    tier: "code_static",
    path: spec.script,
    locator: `${spec.script}:${line}`,
    find: spec.find,
    sha256: file.sha256,
    note:
      `${spec.proves}——脚本存在且登记为可复跑入口（pnpm ${spec.npm_script}），` +
      `但**未采信为实测**：${why}。脚本"能复跑"是线索，不是"跑过且通过"的证据`,
    rerun: null,
  };
}

/**
 * 复算一条实测登记（V09-61 判据收紧，2026-10-08 复审返工）。
 *
 * 依次判，**任一层不成立就退到更低一档**，绝不"看起来像实测就充实测"：
 *   ① **可复跑线索**：脚本在 + 登记在 package.json 该入口上 + 正文含 `find` 片段（不成立 ⇒ 整条剔除，连线索都不给）；
 *   ② **正式引用**：`./dataflowEvidence.ts` 从既有正式 `self_check`/`independent_audit` 记录的引用起读，**先对所有
 *      相关正式检查做唯一判据挑选/否决（失败与 unknown 不因载体格式被删除），再核最终成功 winner 的载体**，给出
 *      本条目的判决（内容地址复核通过 + 退出码 0 + 源清单现读 valid + 无未解除的独立失败压过它 + 运行记录绑定的
 *      纯声明定义哈希与当前声明一致 + `spec_id` 显式命中）；
 *   ③ **范围覆盖**：本条依赖的源码（`requiredSourcesOf`：被证明节点/边的代码 claims ∪ 显式声明 ∪ package 绑定）
 *      全部落在该运行记录引用的源清单覆盖范围内；**约束不完整**（缺声明依赖）⇒ 待复核，不默认通过。
 * ②③ 任一不成立 ⇒ 返回 `code_static` 线索（`verification` 由此判为 `unverified`，不是 `verified`）。
 */
function resolveMeasured(
  root: string,
  index: ProjectIndex,
  spec: MeasuredSpec,
  cache: FileCache,
  scripts: Record<string, string>,
  dropped: DroppedClaim[],
  measuredRuns: MeasuredRunIndex,
  downgrades: { spec_id: string; why: string }[],
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
  const verdict = measuredRuns.verdicts.get(spec.id);
  if (verdict === undefined) {
    const why = "正式记录里没有指向本条目（spec_id）的运行记录：脚本没被正式引用真跑过就只是线索";
    downgrades.push({ spec_id: spec.id, why });
    return measuredClueRef(spec, file, line, why);
  }
  if (!verdict.verdict_ok) {
    const why = `正式运行记录 ${verdict.evidence_id.slice(0, 12)}…（依据 ${verdict.record_ref || "?"}）不成立（${verdict.reasons.join("；")}）`;
    downgrades.push({ spec_id: spec.id, why });
    return measuredClueRef(spec, file, line, why);
  }
  if (verdict.script !== spec.script) {
    const why = `运行记录的脚本（${verdict.script}）与条目声明的脚本（${spec.script}）不一致：不拿别人的记录给本条背书`;
    downgrades.push({ spec_id: spec.id, why });
    return measuredClueRef(spec, file, line, why);
  }
  const required = requiredSourcesOf(index, spec);
  if (required.incomplete.length > 0) {
    const why =
      `本条依赖范围**不完整、待复核**（不能默认足够）：${required.incomplete.join("、")}——` +
      "请在声明里补出它真正依赖的实现文件（或被证明节点/边补代码出处）";
    downgrades.push({ spec_id: spec.id, why });
    return measuredClueRef(spec, file, line, why);
  }
  const covered = new Set((verdict.manifest?.files ?? []).map((f) => f.path));
  const uncovered = required.paths.filter((p) => !covered.has(p));
  if (uncovered.length > 0) {
    const why =
      `运行记录的源清单**范围不覆盖**本条依赖的源码：${uncovered.join("、")}` +
      `（本条依赖集合 ${required.paths.length} 条：脚本+涉及实现文件+package 绑定；不覆盖不算实测）`;
    downgrades.push({ spec_id: spec.id, why });
    return measuredClueRef(spec, file, line, why);
  }
  const manifest = verdict.manifest!;
  return {
    tier: "code_measured",
    path: spec.script,
    locator: `${spec.script}:${line}`,
    find: spec.find,
    sha256: file.sha256,
    note:
      `${spec.proves}（正式运行事实 ${verdict.evidence_id.slice(0, 12)}…，依据 ${verdict.record_ref || "?"}，` +
      `源清单指纹 ${manifest.fingerprint.slice(0, 12)}…，覆盖 ${manifest.files.length} 个源文件且现读一致，退出码 0；` +
      `复跑：pnpm ${spec.npm_script}）`,
    rerun: `pnpm ${spec.npm_script}`,
  };
}

/**
 * 一条 measured 条目**依赖的完整有限源码集合**（判「范围覆盖」的输入；V09-61 复审返工）。
 *
 * 不再"缺省只有脚本本体"（那会让实际被测业务源码变化仍判绿）。集合来源：
 *   · 脚本本体 + `package.json`（可复跑入口绑定）；
 *   · 显式声明的真实依赖（`spec.sources`）；
 *   · **被证明节点/边的代码 claims**（`code_static` 出处的 `path`）——即这条实测真正走到的实现文件。
 * 任一被证明节点/边**没有**代码出处、或不在实体表里、或整条条目没有任何可推出的实现文件也没有显式声明
 * ⇒ 记为 `incomplete`（**待复核**，不得默认通过）——"缺声明依赖"是如实缺口，不是"默认足够"。
 */
function requiredSourcesOf(index: ProjectIndex, spec: MeasuredSpec): { paths: string[]; incomplete: string[] } {
  const paths = new Set<string>([spec.script, "package.json"]);
  const incomplete: string[] = [];
  const declared = spec.sources ?? [];
  for (const p of declared) paths.add(p);
  const collect = (entityId: string, kind: "节点" | "关系"): void => {
    const entity =
      kind === "节点" ? index.nodes.find((n) => n.id === entityId) : index.edges.find((e) => e.id === entityId);
    if (entity === undefined) {
      incomplete.push(`${kind} ${entityId} 不在实体表里：无法确定它依赖的实现文件`);
      return;
    }
    const codePaths = entity.claims
      .filter((c) => c.tier === "code_static" && typeof c.path === "string" && c.path.trim() !== "")
      .map((c) => c.path);
    if (codePaths.length === 0) {
      incomplete.push(`${kind} ${entityId} 没有代码出处：无法确定它依赖的实现文件`);
      return;
    }
    for (const p of codePaths) paths.add(p);
  };
  for (const n of spec.node_ids) collect(n, "节点");
  for (const e of spec.edge_ids) collect(e, "关系");
  // 只绑脚本（外加 package.json）＝"只绑脚本"，不够：要么有可推出的实现文件，要么显式声明依赖
  const implFiles = [...paths].filter((p) => p !== spec.script && p !== "package.json");
  if (implFiles.length === 0) {
    incomplete.push("本条没有可推出的实现文件、也没有显式声明的依赖源码（只绑脚本不算够）");
  }
  return { paths: [...paths].sort(), incomplete };
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
 * 本次**实际读取到**的数据流声明：内建（`DATA_FLOW_INDEXES` 里的值）或项目侧文件，及其**内容驱动**的
 * 稳定指纹 `identity`。六图的快照身份与目标图派生**共用这一份**：既不会「声明变了快照不变、旧游标误通过」，
 * 也让缺失/坏声明的变化同样反映进快照（不用 mtime —— 只认内容）。
 */
export interface ResolvedDataFlowDeclaration {
  project_id: string;
  root: string;
  /** 是否为塔台内建声明（内建才允许回退内建的 artifact→node 表） */
  builtin: boolean;
  /** 加载成功时的声明；null＝显式缺口（缺失/坏/越界/未注册） */
  index: ProjectIndex | null;
  source: { path: string; sha256: string; version: number } | null;
  error: string | null;
  /**
   * **纯声明定义哈希**（`dataFlowDefinitionSha256(index)`；缺口时为空串）：只覆盖声明内容，**不含运行证据
   * 指纹**，故运行记录把它绑进自己的 `declaration_sha256` 不会形成 identity 循环。声明定义一变，旧运行记录
   * 与当前定义不符 ⇒ 不得继续冒充"证的是新定义"。
   */
  definition_sha256: string;
  /**
   * 本项目当前证据库里的运行证据索引（只读；`./dataflowEvidence.ts`）。它与声明一样是**实际图输入**：
   * 它变化（新增/删除运行证据、覆盖源变化使其失效）⇒ `identity` 变化 ⇒ 六图快照身份变化、旧游标被拒。
   */
  measured: MeasuredRunIndex;
  /**
   * 快照身份用指纹：内建=`builtin:<内容 sha>`；项目侧=`decl:<文件 sha>`；缺口=`missing:<原因 sha>`；
   * 末尾统一并上运行证据指纹 `|m:<measured.fingerprint>`（证据变化同样使快照输入失效）。
   */
  identity: string;
}

/**
 * 解析「本项目该用哪份数据流声明」并给出内容指纹（只读；同一份结果供目标图派生与快照身份复用）。
 *
 * 来源判定先用**自有属性**查内建登记表：`constructor`/`__proto__`/`toString` 这类项目名若真的注册成项目，
 * 必须走它自己的项目侧声明，不能被 JS 原型链上的继承属性顶成「内建」。缺失/坏声明/越界路径给显式缺口，
 * **不把坏声明当空声明**、不静默丢弃坏项。
 */
export function resolveDataFlowDeclaration(
  projectId: string,
  opts: { dataDir?: string } = {},
): ResolvedDataFlowDeclaration {
  const project = getProject(projectId, opts.dataDir);
  if (!project) {
    return {
      project_id: projectId,
      root: "",
      builtin: false,
      index: null,
      source: null,
      error: `项目 ${projectId} 不在注册表里：路径不猜，数据流不派生`,
      definition_sha256: "",
      measured: emptyMeasuredRunIndex(),
      identity: `unregistered:${sha256Hex(projectId)}|m:${emptyMeasuredRunIndex().fingerprint}`,
    };
  }
  const root = path.resolve(project.path);
  // 运行证据也是**实际图输入**：与声明同一次解析里读一次，既供目标图派生、也并入快照身份（同一份，不重读）。
  // 代价边界：只有**声明里真的有 measured 条目**的项目才去读正式记录（没有实测条目的项目零成本、行为不变）；
  // 适配器**不遍历证据目录**，只从正式记录 `checks[].evidence_sha256` 指向的内容地址精读（见 dataflowEvidence.ts）。
  // 传「条目 id → 脚本」表：按**身份对应**过滤候选，脚本对不上的记录不当候选（避免遮挡对应的那份）；
  // 另传**纯声明定义哈希**：运行记录必须绑定当前声明定义，声明改了范围/语义而源码没变也不得再判实测。
  const measuredFor = (index: ProjectIndex, definitionSha: string): MeasuredRunIndex =>
    index.measured.length > 0
      ? readMeasuredRunIndex(root, new Map(index.measured.map((m) => [m.id, m.script])), { declarationDefinitionSha: definitionSha })
      : emptyMeasuredRunIndex();

  if (hasOwn(DATA_FLOW_INDEXES, projectId)) {
    const index = DATA_FLOW_INDEXES[projectId]!;
    const definitionSha = dataFlowDefinitionSha256(index);
    const measured = measuredFor(index, definitionSha);
    // 内建声明内容来自源码：按内容 sha 做指纹，源码内声明的任何变化都会换 identity（不用 mtime）。
    return {
      project_id: projectId,
      root,
      builtin: true,
      index,
      source: null,
      error: null,
      definition_sha256: definitionSha,
      measured,
      identity: `builtin:${sha256Hex(JSON.stringify(index)).slice(0, 32)}|m:${measured.fingerprint}`,
    };
  }

  const loaded = loadDataFlowIndex(root);
  if (loaded.index === null) {
    const measured = emptyMeasuredRunIndex();
    return {
      project_id: projectId,
      root,
      builtin: false,
      index: null,
      source: null,
      error:
        "本项目没有可用的「数据输入／存储／输出」声明——" +
        `${loaded.error}。声明位置：项目根 ${DATA_FLOW_DECLARATION_PATH}（塔台自身为内建声明）——` +
        "没有声明就没有可逐条对账的对象，因此**不得**据此得出「项目可交付」结论；" +
        "要得到结论，先按审定设计源逐条登记声明的数据输入/存储/输出",
      definition_sha256: "",
      measured,
      identity: `missing:${sha256Hex(`${loaded.content_sha256 ?? "unread"}|${loaded.error ?? ""}`)}|m:${measured.fingerprint}`,
    };
  }
  const definitionSha = dataFlowDefinitionSha256(loaded.index);
  const measured = measuredFor(loaded.index, definitionSha);
  return {
    project_id: projectId,
    root,
    builtin: false,
    index: loaded.index,
    source: loaded.source,
    error: null,
    definition_sha256: definitionSha,
    measured,
    identity: `decl:${loaded.source?.sha256 ?? "none"}|m:${measured.fingerprint}`,
  };
}

/**
 * 由**已读取的声明**派生数据流向模型（不再重读声明文件：与快照指纹读的是同一份）。
 * 口径与判据同 `analyzeDataFlowAt`；来源留痕与显式缺口原因照旧。
 */
export function dataFlowModelFromDeclaration(resolved: ResolvedDataFlowDeclaration): DataFlowModel {
  if (resolved.index === null) {
    return emptyModel(resolved.project_id, resolved.error ?? "数据流声明不可用（显式缺口）");
  }
  const model = analyzeDataFlowAt(resolved.index, {
    project_id: resolved.project_id,
    root: resolved.root,
    scripts: readPackageScripts(resolved.root),
    measured_runs: resolved.measured,
  });
  if (resolved.source !== null) {
    model.scan.notes.push(
      `声明来源：${resolved.source.path}（version ${resolved.source.version}，sha256 ${resolved.source.sha256.slice(0, 12)}…）` +
        "——项目根内相对路径，只读加载、不执行项目提供的任何代码。",
    );
  }
  return model;
}

/**
 * 真实项目的数据流向模型（只读派生）。
 *
 * 声明来源：塔台自身走**内建声明**（`DATA_FLOW_INDEXES`，**自有属性**匹配）；其他项目按**注册表里的项目根**
 * 只读加载项目侧声明文件（`DATA_FLOW_DECLARATION_PATH`）。缺失/坏声明/越界路径一律给**显式缺口**（空模型 +
 * 原因写入 `scan.notes`）并**阻断交付结论**——没有声明就没有可对账的对象，这时说「项目可交付」没有依据；
 * 也**不把坏声明当空声明**、不静默丢弃坏项。
 */
export function analyzeDataFlow(projectId: string, opts: { dataDir?: string } = {}): DataFlowModel {
  return dataFlowModelFromDeclaration(resolveDataFlowDeclaration(projectId, opts));
}

/**
 * 在给定根目录上按登记表派生（`dataFlowModelFromDeclaration` 的实现体；验证脚本用它在隔离夹具上跑同一份
 * 判据，例如"设计原文里复算不到声明 ⇒ 逐条报缺"的反例）。内建声明的 artifact→node 回退只在本函数认出
 * 该 index 是内建（`isBuiltinIndex`）时生效。
 */
export function analyzeDataFlowAt(
  index: ProjectIndex,
  input: {
    project_id: string;
    root: string;
    scripts?: Readonly<Record<string, string>>;
    /**
     * 运行证据索引（只读；见 `./dataflowEvidence.ts`）。缺省 = 空索引 ⇒ 没有任何实测证据，
     * 全部 measured 条目**只作可复跑线索**（`code_static`／`unverified`），**不得**标「可复跑实测」。
     */
    measured_runs?: MeasuredRunIndex;
  },
): DataFlowModel {
  const projectId = input.project_id;
  const root = input.root;
  const cache: FileCache = new Map();
  const dropped: DroppedClaim[] = [];
  const scripts: Readonly<Record<string, string>> = input.scripts ?? {};
  const measuredRuns: MeasuredRunIndex = input.measured_runs ?? emptyMeasuredRunIndex();
  const measuredDowngrades: { spec_id: string; why: string }[] = [];
  // 只有**内建声明**才回退内建的 artifact→node 对应表：项目侧声明的同名 id 不得串到塔台内建的节点 id。
  const artifactNodeFallback: Readonly<Record<string, string>> | null = isBuiltinIndex(index) ? ARTIFACT_NODE_ID : null;

  // 实测出处（先算：节点/覆盖行都要引用它）
  const measuredRefs = new Map<string, DataFlowEvidenceRef>();
  const measuredByNode = new Map<string, DataFlowEvidenceRef[]>();
  const measuredByArtifact = new Map<string, DataFlowEvidenceRef[]>();
  const measuredByEdge = new Map<string, DataFlowEvidenceRef[]>();
  for (const spec of index.measured) {
    const ref = resolveMeasured(root, index, spec, cache, scripts, dropped, measuredRuns, measuredDowngrades);
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
  //
  // 覆盖判据（2026-10-08 收紧，§11.2／§3.2）：**有出处 ≠ 有路径**。仅"文件里出现过这个文件名常量"就是
  // 旧的假覆盖（声明 node_id=null、图里根本没有这个实体，却因一条 code_static 出处算 covered、报 missing 0）。
  // 现在 path_found ⇔ 四条同时成立：
  //   ① 设计来源有效（design 声明在设计原文里仍复算得到）；
  //   ② 能定位到实体表里的**现有实体**（显式 node_id，或内建声明的 artifact→node 回退；不得按 id 猜节点）；
  //   ③ 该实体参与至少一条**真实关系**：端点闭合（两端都在实体表里）、方向显式、关系属四类、
  //      且该关系本身有有效出处（读/写/传递/转换至少一条）；
  //   ④ 这条声明本体也有有效出处（设计/代码静态/实测任一档，保留原证据判据）。
  // 「路径存在」（路径画得出来）与「实测已验证」是两层：未实测只到 unverified，**不等于没有路径**。
  // 声明为「尚未实现/未引入」的行**永不**算覆盖（附了 codeclaim 也不算），单列、不计入缺路径。
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const validEdgeAt = (nodeId: string): DataFlowEdge | undefined =>
    edges.find(
      (e) =>
        (e.from === nodeId || e.to === nodeId) &&
        e.id.trim() !== "" &&
        e.direction === "forward" &&
        (DATA_FLOW_RELATION_KINDS as readonly string[]).includes(e.relation) &&
        nodeById.has(e.from) &&
        nodeById.has(e.to) &&
        e.evidence.length > 0,
    );
  const rows: DataFlowCoverageRow[] = index.artifacts.map((a) => {
    const designRef = resolveClaim(root, a.design, cache, dropped);
    const evidence = dedupeRefs([...resolveList(a.code), ...(measuredByArtifact.get(a.id) ?? [])]);
    const nodeId = a.node_id ?? (artifactNodeFallback !== null && hasOwn(artifactNodeFallback, a.id) ? artifactNodeFallback[a.id] : null);
    const node = nodeId === null ? undefined : nodeById.get(nodeId);
    const leadEdge = nodeId === null ? undefined : validEdgeAt(nodeId);
    const notImplemented = a.declaration_status === "declared_not_implemented";
    const pathFound = !notImplemented && designRef !== null && node !== undefined && leadEdge !== undefined && evidence.length > 0;
    let gap: string | null = null;
    if (notImplemented) {
      gap = `设计声明为「尚未实现／未引入」：${a.role}。列出来但**不计入缺路径**、也不算已覆盖（设计自己写明的未实现，不冒充已交付）`;
    } else if (!pathFound) {
      const why: string[] = [];
      if (designRef === null) why.push("设计原文里复算不到这条声明（设计来源失效）");
      if (nodeId === null) why.push("没有对应到实体表里的实体（未登记 node_id，且不在内建 artifact→node 回退表）");
      else if (node === undefined) why.push(`声明的 node_id「${nodeId}」在实体表里不存在（悬空指向，不算覆盖）`);
      else if (leadEdge === undefined) why.push(`实体「${nodeId}」没有以它为端点、端点闭合且有有效出处的真实关系（孤立节点，不算路径）`);
      if (evidence.length === 0) why.push("这条声明本体没有任何有效出处（读写/落点线索为空）");
      gap = `缺路径：${why.join("；")}——**阻断「项目可交付」结论**（§11.2）`;
    }
    return {
      artifact: a.artifact,
      kind: a.kind,
      node_id: nodeId,
      declaration_status: a.declaration_status,
      design_locator: designRef === null ? "（设计原文里复算不到这条声明：登记失效）" : designRef.locator,
      evidence,
      path_found: pathFound,
      gap,
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
      "「有路径」的判据是**结构性的**：设计来源有效 + 定位到实体表里的现有实体 + 该实体参与一条端点闭合、" +
      "有有效出处的真实关系 + 声明本体有出处——仅文件名常量、node_id 缺失、悬空指向、孤立节点都不算覆盖。" +
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
        ...measuredRuns.notes.map((n) => `实测证据：${n}`),
        ...measuredDowngrades.map((d) => `实测未采信（降为可复跑线索）：${d.spec_id} —— ${d.why}`),
        "静态 import／字符串线索只进 static_clues，不计入出处档位，也不得生成「已验证」的数据边（R4）。",
        "本派生只读：不写盘、不调模型、不给纳管项目加运行时埋点（§11.2）。",
      ],
    },
  };
}
