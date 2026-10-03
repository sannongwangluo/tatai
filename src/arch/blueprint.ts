// V06-05：图纸派生的规划关联数据（PLAN.md V06-05，DESIGN.md §4.1 为主契约，另见 §2.9 / §4.4–§4.7）。
//
// 本文件回答三件事：
//   ① **Blueprint 数据与派生管线**（§4.1）：输入 = 同一基线的设计/施工原文 + 稳定 ID 索引，
//      输出 = `baseline_id / generator_version / source_manifest / nodes / edges / coverage / omitted`；
//      节点含稳定 id / kind / name / source_refs / related_ids，关系含 source / target / kind /
//      source_refs / certainty。派生缓存落 `.工作台/arch/blueprint.json`——
//      DESIGN §4.1 明写它是**派生缓存**，"不是另一份可独立编辑的设计"：本文件从不改 DESIGN/PLAN。
//   ② **模型语义整理**（§4.1）：内置 DeepSeek 只做"整理能力/模块/关系及出处"，产出过
//      `sanitizeModelProposal` 摘掉完成色/进度一类字段，再过 `blueprintValidate` 的程序校验；
//      **模型不能自行审定自己的新架构**（发布与否由程序裁定）。模型回执与整理结果**保存在缓存里**，
//      下次可基于已保存的整理结果重建视图，不必每次重画都调模型（§4.1 / §4.4）。
//   ③ **触发与发布**（§4.4）：有效基线激活 → 重建；代码结构变化 → 只更新实现观察（零模型）；
//      任务/验证变化 → 只重算状态（**零模型**，缓存键里根本没有任务状态）；失败保留上次有效图并
//      带出原因；过时响应不得覆盖新结果（内存 epoch + 发布前重算缓存键双重把关）。
//
// 红线（本文件自己守的）：
//   · 命名/布局不影响身份：节点 id 由**位置序与源声明的稳定键**算出（章节序号 / 卡号 / 模块 id），
//     改名字不改身份（改章节顺序会换身份，如实写在 id 注释里）。
//   · 完成色/进度**不由本文件写**，也不接受模型给（§4.2）。
//   · 静态解析层（modules.json）与聊天补全层（supplement.json）的写口一个字节都不碰；
//     规划层**分别存储**（ARCH_SUBDIR 下的 blueprint.json），只在视图合成时合并（§3.2 / §4.1）。
//   · 蓝图里只放**项目根内相对路径**，绝不放本机绝对路径（远程读接口与 verify-s3 的敏感面扫描）。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { getProject, resolveDataDir } from "../server/registry";
import { projectWorkDir, WsError, workstationDir } from "../server/workstation";
import { activeBaseline, buildSectionIndex, designDefinitionText, loadDocuments } from "../server/work/documents";
import { importTaskDefinitions, type TaskDefinition } from "../server/work/plan";
import { taskDefinitionHash } from "../shared/planCardHash";
import { resolveDesignRef } from "../shared/designRef";
import { definitionHashOf, parsePlanTable } from "../server/work/planValidate";
import { nowIso } from "../server/time";
import { chatStructuredJson, type FlashMessage } from "../server/flash";
import { readNames } from "./name";
import { readModules } from "./parse";
import { extractDesignModules, extractTataiDesignModules, moduleSectionPathOf, reconcilePlanWithCodeInputs, type PlanCodeReconcile } from "./reconcile";
import { buildSharedGraph } from "./render";
import {
  buildSharedGraphFrom,
  mergePlanningLayer,
  type PlanLayerEdge,
  type PlanLayerInput,
  type PlanLayerNode,
  type SharedGraph,
  type SharedLimits,
} from "./shared-graph";
import {
  codeLinkageOf,
  sourceRefLocateOf,
  STATUS_FORBIDDEN_KEYS,
  validateBlueprint,
  type BlueprintContext,
  type BlueprintFinding,
  type BlueprintLimits,
  type BlueprintValidation,
} from "./blueprintValidate";
// V09-13：来源与证据标注的**判据**在 `ui/arch/provenance.ts`（唯一实现）；本文件只把
// 「蓝图 + 需求登记 + 任务定义 + 证据记录」摊成它的输入，不另写一套分类/证据状态判断。
import {
  buildProvenanceModel,
  capabilityMembersOf,
  evidenceStateOf,
  type EvidenceFacts,
  type MemberAggregate,
  type ProvenanceModel,
  type ProvenanceObjectInput,
  type RequirementRef,
} from "../ui/arch/provenance";
import { projectWithReleases } from "../server/work/entry";
import { eventsOfSnapshot, provenanceFactsOf, type EventsSnapshot, type StatusProjection } from "../server/work/statusProjection";
import { readRequirements } from "../server/work/requirements";
import { canvasMembershipGapsOf, capabilityClassOf, taskDerivedModuleStatus } from "../ui/arch/projectGraph";
import { declaredLinksOf, readLastReconcile } from "./reconcile";
// C016 收口第二包（2026-09-21）：派生重建链**不再**从旧 blueprint.json 携带/重放任何私有编辑账
// （批3 T22 的 carryEditLedger/reapplyEditLedger 已拆除，blueprintEdit.ts 已删除）。
// DESIGN §4.1：权威来源 = 已审定图纸基线 + 合法变更事实（change.blueprint_inheritance_recorded 事件），
// blueprint.json 只是可删可重建的派生物；删除/拆并走"修订权威原文 → 登记事实 → 重派生"。

// ───────────────────────────────── 常量与落点 ─────────────────────────────────

export const BLUEPRINT_VERSION = 1 as const;
/** 生成器版本（进缓存键：派生口径变了就必须让旧缓存失效，§4.4「缓存键包含基线、源版本与生成器版本」）
 *  2026-09-26（V09-18／附录 E.17）**有意不升版**：提案线索化改变的是提案的**入账方式**（既有缓存里的
 *  提案边照旧读入、改记为 model_leads 待审线索——读得出才不靠对象消失消账）；升版会把语义缓存整份判
 *  空，16 条已发布提案边将无痕消失，违反 §4.2「经批准移除必须留痕」。设计/施工源变化仍会经
 *  model_key/full_key（含内容哈希）触发重派生；能力分类对无声明表的旧图按「未声明」回退，无需失效。 */
export const BLUEPRINT_GENERATOR_VERSION = "v06-05.1";
/** 规划图落点：`<项目根>/.工作台/arch/blueprint.json`（DESIGN §4.1 明确指定） */
export const ARCH_SUBDIR = "arch";
export const BLUEPRINT_FILE = "blueprint.json";
/** 本轮派生尝试的回执（成功与失败都写）：失败时旧图还在，原因只能从这份回执读（§4.4） */
export const BLUEPRINT_RECEIPT_FILE = "blueprint-receipt.json";
/** 规划图硬上限（§4.3 第 1 招：JSON 层面就截断，超出部分不渲染，改为如实登记的省略量）。
 *  与旧图（render 侧）的数值**各自独立**：旧图口径是"一屏看得下的大模块"（15），
 *  规划图是"图纸里的能力/模块/任务清单"，量大得多，因此数值不同、代码不同源，互不影响。 */
export const BLUEPRINT_LIMITS: BlueprintLimits = { max_nodes: 400, max_edges: 1000 };
/** 规划节点 id 前缀（与静态解析层的模块 id、聊天补全层的 `chat:` 前缀都不冲突） */
export const PLAN_PREFIX = "plan:";
/** 模型原始回执在缓存里保留的预览长度（回执要可查，但不把整块模型输出塞进缓存文件） */
export const MODEL_RAW_EXCERPT_MAX = 2000;

// ───────────────────────────────── 数据契约 ─────────────────────────────────

export type BlueprintSourceKind = "design_section" | "plan_task" | "code_module";

/** 一条来源引用：**可定位**是它的全部意义（§4.1「来源可定位」是发布前提） */
export interface BlueprintSourceRef {
  kind: BlueprintSourceKind;
  /** 项目根内相对路径（POSIX 分隔符；绝不放本机绝对路径） */
  path: string;
  /** 定位串：design_section = 章节标题路径；plan_task = 卡号；code_module = 静态模块 id */
  locator: string;
  /** 引用时的版本哈希（design_section = 该节正文 sha256；plan_task = 该卡**单卡定义哈希**
   *  （`shared/planCardHash.ts` 的 `taskDefinitionHash`，只覆盖本卡目标/范围/依赖/接口/验收）；
   *  code_module = null，目录级解析没有稳定的单文件哈希）；对不上即"失效来源"。
   *  2026-09-27 由"整份施工定义 sha256"细化为单卡口径：改一张卡不再让全图 plan_task 引用一起失效；
   *  旧图里的整份哈希引用按「legacy 整份引用」复核（见 `blueprintValidate.sourceRefLocateOf`）。 */
  sha256: string | null;
}

export type BlueprintNodeKind = "capability" | "module" | "task" | "concept";

export interface BlueprintNode {
  /** 稳定 id（见各生成点注释：位置序 / 卡号 / 模块 id，改名不换身份） */
  id: string;
  kind: BlueprintNodeKind;
  name: string;
  source_refs: BlueprintSourceRef[];
  /** 与本节点有关系的其他节点 id（由关系集合对称导出，模型额外给的也要能落到真实节点上） */
  related_ids: string[];
}

export type BlueprintEdgeKind =
  /** 施工图任务 → 前置任务（declared：施工图表格「依赖」列） */
  | "task_dependency"
  /** 任务 → 设计章节所属能力（declared：施工卡「设计依据」段） */
  | "task_design_ref"
  /** 能力 → 模块（declared：设计书模块清单所在章节的归属关系） */
  | "design_interface"
  /** 规划对象 → 实测代码模块（observed：施工图「文件责任」声明的范围 ∩ 静态解析到的模块） */
  | "implementation_map"
  /** 模型整理推断出来的关系（**无出处必须标 unverified**，§4.1） */
  | "model_inference";

export type BlueprintCertainty = "declared" | "observed" | "inferred" | "unverified";

export interface BlueprintEdge {
  source: string;
  target: string;
  kind: BlueprintEdgeKind;
  source_refs: BlueprintSourceRef[];
  certainty: BlueprintCertainty;
}

/** 一侧的覆盖账目：`mapped + unmapped.length === total` 是硬口径（不许拿空集冒充全覆盖） */
export interface BlueprintCoverageSide {
  total: number;
  mapped: number;
  unmapped: { key: string; detail: string }[];
}

export interface BlueprintCoverage {
  design_sections: BlueprintCoverageSide;
  plan_tasks: BlueprintCoverageSide;
  code_modules: BlueprintCoverageSide;
  /** 截断前的节点/关系总数（与 kept 之差就是被省略的量，必须进 omitted） */
  nodes_total: number;
  nodes_kept: number;
  edges_total: number;
  edges_kept: number;
  note: string;
}

export interface BlueprintOmission {
  /** node_cap / edge_cap / unmapped / model_field_rejected / model_edge_dropped / unlocatable_source /
   *  unresolved_design_ref / dangling_dependency / related_id_dropped */
  kind: string;
  detail: string;
  count: number;
}

/**
 * 模型提案**待审线索**（2026-09-26 GPT-6 裁定 1–2，DESIGN §4.1／附录 E.17）：
 * 语义整理层的提案**不是正式关系**——模型自报的 certainty（declared/observed）不构成 DESIGN 或
 * PLAN 的声明；不能仅因定位符指向某张卡，就认定这张卡声明了该关系。正式的 task_design_ref／
 * implementation_map 只由确定性管线从权威原文与实际路径复算产生。线索保留可追溯
 * （自报标记／出处／处置），但**不参加**能力成员、二级派生、绿色状态与交付读数；
 * 界面与 MCP 不得把它展示成已审定关系。
 */
export interface BlueprintModelLead {
  source: string;
  target: string;
  kind: BlueprintEdgeKind;
  /** 模型自报的确定性标记（线索的原始信息，**不是**正式边的 certainty，不据此分档） */
  model_certainty: BlueprintCertainty;
  source_refs: BlueprintSourceRef[];
  /** confirmed_by_derivation = 与确定性派生**独立命中**（正式关系由派生管线产生，本提案冗余留痕）；
   *  lead_pending_review = 未通过复算，留作待审线索（不进成员/派生/绿态/交付读数） */
  disposition: "confirmed_by_derivation" | "lead_pending_review";
}

/** 声明表的一处问题（逐项登记；R-1/B 类返工：损坏的声明表**不许静默**把章节判成 functional） */
export interface CapabilityClassIssue {
  /** missing_chapter=表缺章/未覆盖设计书章节；duplicate_chapter=同章重复且分类矛盾；
   *  malformed_row=表行的分类列写法损坏（认不出）；marker_misplaced=标记字样出现但其后没有表；
   *  chapter_mismatch=表里的章节在设计书章节里不存在；multiple_tables=多处声明表（取哪张不明） */
  kind:
    | "missing_chapter"
    | "duplicate_chapter"
    | "malformed_row"
    | "marker_misplaced"
    | "chapter_mismatch"
    | "multiple_tables";
  /** 受影响章节号（与具体章节无关时为 null） */
  chapter: number | null;
  detail: string;
  /** 阻断发布（分类不完整或自相矛盾 ⇒ 按「旧有效图/更新失败」处理）；标记误命中只登记不阻断 */
  blocking: boolean;
}

/** 声明表状态：declared=表完好；undeclared=设计书里没有声明表（§3.2 兼容口径）；broken=有表但损坏 */
export type CapabilityClassTableState = "declared" | "undeclared" | "broken";

/** 模型提案的**节点侧待审线索**（R-2/B 类返工 2026-09-26 非作者复审，DESIGN §4.1／附录 E.17）：
 *  提案**节点**与提案给既有节点补的 **source_refs** 与「提案边」同款处理——语义整理层输出的是待审线索，
 *  模型自报的出处**未经权威原文复算**，不构成 DESIGN/PLAN 声明，因此：
 *  · 不进 `bp.nodes`（模型自报的新节点不是正式对象，不参与交付读数）；
 *  · **不改变既有节点的 source_refs**（否则一条编造出处经 `refStatusOf` → 证据状态 P5 可把正式对象打成
 *    `invalidated`、阻断交付读数——方向是变红/DoS，同样越界）；
 *  · 原始提案与处置**原样保留在账**（`proposed_*` 字段与 `disposition`）。
 *  `disposition`：`confirmed_by_derivation` = 该 id 的正式节点**已独立带着同名出处**（提案冗余留痕）；
 *  `lead_pending_review` = 未经权威复算（含所有模型自报的新节点）。 */
export interface BlueprintNodeLead {
  id: string;
  kind: BlueprintNodeKind;
  name: string;
  /** 提案给的出处（**原始**，不并入正式节点账） */
  proposed_source_refs: BlueprintSourceRef[];
  /** 提案给的相关引用（**原始**，不并入正式节点账） */
  proposed_related_ids: string[];
  /** existing_node = 给既有节点补出处/补关系；new_node = 模型自报的新节点（一律待审） */
  target: "existing_node" | "new_node";
  disposition: "confirmed_by_derivation" | "lead_pending_review";
}

/**
 * 能力分类（2026-09-26 GPT-6 裁定 7，DESIGN §3.2「能力分类声明」表）：
 * 唯一来源是**设计书里的声明表**（机器可读），代码不硬编码任何项目的章节号；
 * declared=false ⇒ 全部 level-2 章节按功能能力处理，并在口径句注明「能力分类未声明」。
 *
 * R-1/B 类返工（2026-09-26 非作者复审）：表**存在但损坏**时不再静默回退 functional——
 * `table_state="broken"` ＋ `issues` 逐项点名受影响章节，`declared=false`（分类不可信），
 * 校验层据此**阻断发布**（保留上次有效图并显示原因，§3.3／§4.4）；界面文案按 broken 分支写，
 * 不得写成「未声明」。
 */
export interface BlueprintCapabilityClasses {
  declared: boolean;
  /** `plan:cap:*` → 分类（functional=功能能力；governance=设计/治理章节）；
   *  broken 时只含**解析成功**的那些章节，其余章节不在此表（界面按「分类未定」处理，不默认 functional） */
  by_capability: Record<string, "functional" | "governance">;
  note: string;
  /** 声明表状态（旧数据没有此字段 ⇒ 按 declared 推断，兼容旧蓝图） */
  table_state?: CapabilityClassTableState;
  /** 逐项登记的表问题（缺章／重复／坏行／标记误命中／章节对不上／多表） */
  issues?: CapabilityClassIssue[];
}

export interface BlueprintSourceManifestEntry {
  /** design / plan / modules / names */
  role: string;
  /** 项目根内相对路径 */
  path: string;
  sha256: string | null;
  status: "ok" | "missing";
  detail: string | null;
}

/** 语义整理按**来源分段**的账目（补修包 E）：哪一段是本轮整理的、哪一段复用缓存、基于哪版来源。
 *  回执要能回答"这张图这一版的语义整理是哪次跑的、基于哪版基线/来源、模型可不可用、覆盖了什么缺了什么"。 */
export interface BlueprintSemanticScopeNote {
  /** design = 设计段（设计书正文/章节索引与声明模块）；plan = 施工段（施工图任务定义） */
  scope: string;
  /** 该段本轮的缓存键（null = 该段来源缺失，如项目没有设计书） */
  key: string | null;
  /** reused = 复用既有整理结果；tidied = 本轮真整理；inherited = 本轮没整理、沿用上次结果（含模型不可用）；
   *  missing = 该段来源不存在；failed = 本轮该段没得到可用结果；pending = 本轮不整理（显式关闭或已达重试上限） */
  state: "reused" | "tidied" | "inherited" | "missing" | "failed" | "pending";
  source_sha256: string | null;
  last_ran_at: string | null;
  /** 该段贡献的整理条目数（节点 + 关系） */
  entries: number;
}

/** 模型整理回执（§4.1「模型解释及其原始回执保留」+ §4.4「过时结果丢弃并留回执」） */
export interface BlueprintModelReceipt {
  called: boolean;
  ok: boolean;
  model: string | null;
  raw_sha256: string | null;
  raw_excerpt: string | null;
  error: string | null;
  /** 被摘掉的模型字段（§4.2：禁止模型输入完成色/进度） */
  rejected_fields: string[];
  /** 被丢弃的模型条目（端点不存在 / 引用不存在 / 超限） */
  dropped: { what: string; why: string }[];
  /** 规范化后的整理结果（保存在缓存里 → 下次可基于它重建视图，不必再调模型） */
  proposal: BlueprintProposal | null;
  /** 按来源分段的整理账目（自动链写；显式 semantic:true 路径为 null） */
  scopes?: BlueprintSemanticScopeNote[] | null;
}

/**
 * 旧 T22 私账的记录类型（**只读兼容**，C016 收口第二包）：仅为能解析历史 blueprint.json 保留。
 * 新发布的图**不携带**这两个字段；它们不再是新图权威、也不驱动节点/边变化——重建时由权威源覆盖，
 * 被旧私账"删"掉的源节点会随重派生复活。合法的删除/拆并事实在 `change.blueprint_inheritance_recorded`
 * 事件里（changes.ts#BlueprintInheritanceFact），不在派生缓存里。
 */
export interface BlueprintInheritanceRecord {
  kind: "removed" | "split" | "merged";
  predecessor_ids: string[];
  successor_ids: string[];
  change_ref: string;
  recorded_at: string;
}
/** 旧 T22 私账的受影响标注类型（只读兼容，口径同上） */
export interface BlueprintAffectedMark {
  id: string;
  type: "node" | "edge";
  reason: string;
}

export interface Blueprint {
  version: typeof BLUEPRINT_VERSION;
  baseline_id: string | null;
  generator_version: string;
  generated_at: string;
  source_manifest: BlueprintSourceManifestEntry[];
  nodes: BlueprintNode[];
  edges: BlueprintEdge[];
  coverage: BlueprintCoverage;
  omitted: BlueprintOmission[];
  model_receipt: BlueprintModelReceipt | null;
  /** 模型提案**待审线索**（2026-09-26 起：提案边不再合入正式关系，一律入线索账；旧图缺省 = 空） */
  model_leads?: BlueprintModelLead[];
  /** 模型提案的**节点侧待审线索**（R-2/B 类返工 2026-09-26：提案节点与给既有节点补的 source_refs
   *  同样只留在待审线索层，不进正式节点、不改正式节点出处；旧图缺省 = 空） */
  model_node_leads?: BlueprintNodeLead[];
  /** 能力分类（§3.2「能力分类声明」表派生；旧图缺省 = null ⇒ 全部按功能能力、注明未声明） */
  capability_classes?: BlueprintCapabilityClasses | null;
  publish: { published: boolean; reason: string | null; validated_at: string | null };
  /** 本份缓存基于的输入（缓存键拆成两段，见 BlueprintBasedOn 注释） */
  based_on: BlueprintBasedOn;
  /** 旧 T22 私账字段（**只读兼容**，仅为解析历史 blueprint.json 保留）：C016 起新发布的图不带它；
   *  重建不按它改节点/边。继承事实的权威记录在 change.blueprint_inheritance_recorded 事件流里。 */
  inheritance?: BlueprintInheritanceRecord[];
  /** 旧 T22 私账字段（只读兼容，口径同 inheritance） */
  affected?: BlueprintAffectedMark[];
}

export interface BlueprintBasedOn {
  /** **模型段**缓存键：基线 + 设计内容哈希 + 施工定义哈希 + 生成器版本 + 是否跑语义整理。
   *  任务状态、进度、勾选位**都不在里面**（§4.4：任务/验证变化只重算状态，不调 DeepSeek 全量重画）。 */
  model_key: string;
  /** **完整段**缓存键 = 模型段 + 代码指纹：代码结构变化只更新实现观察（零模型），
   *  所以它变了要重算派生层，但**不必**重调模型。 */
  full_key: string;
  design_content_sha256: string | null;
  plan_definition_sha256: string | null;
  semantic: boolean;
  /** **语义整理的来源分段账目**（补修包 E）：本图这份整理结果是按哪几段来源、哪一版算出来的。
   *  自动链用它判断"已发布的图是否已经反映了当前的语义缓存"（对得上就不重画、零模型）。
   *  非自动链发布的图不带这个字段（= 没有语义分段账目，自动链会重画一次带上它）。 */
  semantic_scopes?: { scope: string; key: string | null }[] | null;
}

/** 结构校验上下文 + 派生输入都用它：一次读盘，两处共用（避免"校验读到 A、派生读到 B"） */
export interface BlueprintSources {
  baseline_id: string | null;
  design: {
    path: string;
    content_sha256: string;
    definition_sha256: string;
    text: string;
    sections: { path: string; sha256: string; level: number; title: string }[];
  } | null;
  plan: {
    path: string;
    content_sha256: string;
    definition_sha256: string;
    text: string;
    tasks: TaskDefinition[];
  } | null;
  declared_modules: { name: string; confidence: "high" | "low"; section_path: string | null; stable_id: string; identity_basis: "declared_number" | "material_position"; declared_key: string }[];
  code: { available: boolean; budget_exhausted: boolean | null; modules: { id: string; path: string; file_count: number }[] };
  /**
   * 仓库根级**文件**名清单（只列文件、不列目录；`null` = 未知——纯文本派生/历史重建没有仓库现场）。
   * 用途只有一个：implementation_map 的「根级真实文件落根模块」判据（2026-09-25 终审返工）——
   * 单段声明 token 只有在这个清单里才算根级真实文件；为 `null` 时一律无法证实、不产生根模块映射。
   */
  repo_root_files: string[] | null;
  names: Record<string, { name: string } | undefined>;
  manifest: BlueprintSourceManifestEntry[];
}

// ───────────────────────────────── 小工具 ─────────────────────────────────

const sha256 = (data: string | Buffer): string => crypto.createHash("sha256").update(data).digest("hex");

/**
 * 稳定 id 的 slug 段：ASCII 直接小写连字；含非 ASCII（中文章节名/模块名）时补原键的哈希前缀，
 * 保证不同键不塌成同一个 id（照 `parse.ts#slugify` 的同一坑与同一修法，但**不复用**它——
 * 本文件要服务端独用，不把 tree-sitter 那条链拖进来）。
 */
export function stableSlug(key: string): string {
  const base = key
    .replace(/[^0-9A-Za-z_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
  if (!/[^\x00-\x7F]/.test(key)) return base === "" ? "x" : base;
  return `${base === "" ? "x" : base}-${sha256(key).slice(0, 8)}`;
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

// ───────────────────────────────── 来源读取 ─────────────────────────────────

/**
 * 一次读齐派生与校验所需的一切（**只读**，不落任何盘）。
 * 口径与既有模块保持一致：图纸走 `work/documents.ts` 的唯一当前源与章节索引；代码侧只读
 * **已落盘**的 modules.json（不在这里触发解析——解析是 POST /arch/parse 的事）；进度/状态一律不读
 * （§4.2：规划图不写完成色，也不靠状态推导身份）。
 */
export function readBlueprintSources(projectId: string, dataDir?: string): BlueprintSources {
  const project = getProject(projectId, dataDir);
  if (!project) throw new WsError("PROJECT_NOT_FOUND", `项目不存在: ${projectId}`);
  const isTatai = project.self_managed === true || project.id === "tatai";
  const baseline = activeBaseline(projectId, dataDir);
  const docs = loadDocuments(projectId, dataDir);
  const manifest: BlueprintSourceManifestEntry[] = [];

  let design: BlueprintSources["design"] = null;
  if (docs.design !== null) {
    design = {
      path: docs.design.source.rel_path,
      content_sha256: docs.design.revision.content_sha256,
      definition_sha256: docs.design.revision.definition_sha256,
      text: docs.design.text,
      // 章节索引建在**全量正文**上（2026-09-25 终审返工更正）：定义哈希仍只取待议区前的正文
      // （§3.5，待议追加不作废基线），但**引用定位**要能找到附录 C–G 的章节——此前索引也建在
      // 定义正文上，导致「附录 D／E.15／C.5-1」这类真实存在的引用全部误报 unresolved_design_ref。
      // 能力节点仍只取 level-2 非附录章节（`deriveBlueprint` 里的 `!s.title.startsWith("附录")` 过滤），
      // 附录进索引不改变能力序号与节点身份。
      sections: buildSectionIndex(docs.design.text).map((s) => ({
        path: s.path,
        sha256: s.sha256,
        level: s.level,
        title: s.title,
      })),
    };
    manifest.push({
      role: "design",
      path: design.path,
      sha256: design.content_sha256,
      status: "ok",
      detail: `${design.sections.length} 个章节`,
    });
  } else {
    manifest.push({ role: "design", path: isTatai ? "DESIGN.md" : ".工作台/design.md", sha256: null, status: "missing", detail: "设计书源缺失：没有可派生的能力来源" });
  }

  let plan: BlueprintSources["plan"] = null;
  if (docs.plan !== null) {
    const imported = importTaskDefinitions(docs.plan.text, {
      plan_revision: docs.plan.revision.content_sha256,
      design_revision: docs.design?.revision.definition_sha256 ?? null,
    });
    plan = {
      path: docs.plan.source.rel_path,
      content_sha256: docs.plan.revision.content_sha256,
      definition_sha256: docs.plan.revision.definition_sha256,
      text: docs.plan.text,
      tasks: imported.definitions,
    };
    manifest.push({
      role: "plan",
      path: plan.path,
      sha256: plan.definition_sha256,
      status: "ok",
      detail: `${plan.tasks.length} 个任务定义`,
    });
  } else {
    manifest.push({ role: "plan", path: isTatai ? "PLAN.md" : ".工作台/plan.md", sha256: null, status: "missing", detail: "施工图源缺失：没有可派生的任务来源" });
  }

  // 设计书声明的模块清单（塔台自身 = §11.1 表格，其他项目 = 「模块划分」节）：**复用 A5 的提取器**，
  // 不另写一套口径——§4.5「既有自举模块解析依赖 §11.1 的十个名字，在迁移卡通过前保留该表」。
  const declaredRaw =
    design === null ? [] : isTatai ? extractTataiDesignModules(design.text) : extractDesignModules(design.text);
  const moduleSection = design === null ? null : moduleSectionPathOf(design.text, isTatai);
  const declared_modules = declaredRaw.map((m) => ({ ...m, section_path: moduleSection }));

  const { exists, arch } = readModules(projectId, dataDir);
  const codeModules = exists && arch ? arch.modules.map((m) => ({ id: m.id, path: m.path, file_count: m.file_count })) : [];
  manifest.push({
    role: "modules",
    path: `${ARCH_SUBDIR}/modules.json`,
    sha256: exists ? sha256(JSON.stringify(codeModules)) : null,
    status: exists ? "ok" : "missing",
    detail: exists
      ? `${codeModules.length} 个模块${codeModules.length === 0 ? "（静态解析跑过，但项目里没有可解析的源码文件）" : ""}`
      : "静态解析层尚未落盘（还没跑过 arch/parse）：规划图仍可派生，实现映射留空",
  });

  const names = readNames(project.path);
  manifest.push({
    role: "names",
    path: `${ARCH_SUBDIR}/names.json`,
    sha256: null,
    status: Object.keys(names.entries).length === 0 ? "missing" : "ok",
    detail: Object.keys(names.entries).length === 0 ? "还没有人话名缓存（不影响派生，只在展示时兜底 id）" : `${Object.keys(names.entries).length} 条`,
  });

  // 仓库根级文件清单（implementation_map「根级真实文件」判据的唯一事实来源；只读，读不到就如实 null）
  let repoRootFiles: string[] | null = null;
  try {
    repoRootFiles = fs
      .readdirSync(project.path, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name)
      .sort();
  } catch {
    repoRootFiles = null;
  }
  manifest.push({
    role: "repo_root_files",
    path: ".",
    sha256: repoRootFiles === null ? null : sha256(JSON.stringify(repoRootFiles)),
    status: repoRootFiles === null ? "missing" : "ok",
    detail:
      repoRootFiles === null
        ? "仓库根目录读不到——根级文件声明一律无法证实，不产生根模块映射"
        : `${repoRootFiles.length} 个根级文件（implementation_map 根级真实文件判据）`,
  });

  return {
    baseline_id: baseline?.baseline_id ?? null,
    design,
    plan,
    declared_modules,
    code: { available: codeModules.length > 0, budget_exhausted: arch?.budget_exhausted ?? null, modules: codeModules },
    repo_root_files: repoRootFiles,
    names: names.entries as Record<string, { name: string } | undefined>,
    manifest,
  };
}

// ───────────────────────────────── 纯派生 ─────────────────────────────────

export interface DeriveOptions {
  generated_at?: string;
  limits?: BlueprintLimits;
  /** 缓存键（由管线算好传进来；纯派生自己不碰时间与环境） */
  based_on: BlueprintBasedOn;
  /** 已保存的模型整理结果（命中模型段缓存时复用，不必再调模型；§4.1） */
  proposal?: BlueprintProposal | null;
  model_receipt?: BlueprintModelReceipt | null;
}

// 设计引用的章节解析（2026-09-27 下沉到 `src/shared/designRef.ts`，浏览器安全的纯函数）：
// 状态投影侧的分段失效复核也要按本对象的设计引用章节比节哈希，而它再 import 本文件会形成
// 循环（本文件已经 import 了 statusProjection.ts）；复制一份又违反一事一源。故判据本体提到
// 跨层共享位，本文件改为从那里引入（该函数此前是私有函数，没有外部调用方，无需再导出）。
// 口径一个字节都没变。

/** 命中的章节是不是**附录内**章节（往上找最近的 level-2 标题，是 `## 附录 …` 即附录） */
function isAppendixSection(sections: { title: string; level: number }[], idx: number): boolean {
  for (let i = idx; i >= 0; i--) {
    if (sections[i].level === 2) return sections[i].title.startsWith("附录");
  }
  return false;
}

/**
 * 一个章节是不是**附录范围**内（标题或标题路径含 `附录 …` 段）。
 * 用途：覆盖账目的设计侧基数（附录章节按设计不产生规划对象，不计入「应覆盖」基数；
 * 派生侧 `assembleBlueprint` 与校验侧 `blueprintValidate` 必须用同一个判据，否则覆盖对账必红）。
 */
export function isAppendixScopedSection(s: { title?: string; path?: string }): boolean {
  if (s.title !== undefined && s.title.startsWith("附录")) return true;
  return (s.path ?? "").split(" / ").some((seg) => seg.startsWith("附录"));
}

/**
 * 「设计依据」token 的**真实类别**（2026-09-25 终审返工）：非设计章节引用按类别登记，
 * 不按设计章节解析（此前需求 ID／审计报告／AGENTS·存档稿本等外部引用混进 design_refs 后
 * 被一律误报 unresolved_design_ref）。判据是机械形态规则，认不出的仍归 design_section——
 * 定位不到时报缺并阻断（保守，不为消除红数放宽）。
 */
export type DesignRefTokenClass =
  | "design_section"
  | "non_design_ref_requirement"
  | "non_design_ref_report"
  | "non_design_ref_external_doc";

export function classifyDesignRefToken(token: string): DesignRefTokenClass {
  if (/req-[0-9A-Za-z][0-9A-Za-z-]*\d/.test(token) || /需求\s*[＝=]/.test(token)) return "non_design_ref_requirement";
  if (/报告\s*\d/.test(token)) return "non_design_ref_report";
  if (/AGENTS(?:\.md)?/.test(token) || token.includes(".工作台/")) return "non_design_ref_external_doc";
  return "design_section";
}

/** 非设计章节引用的类别名（omitted 登记与读数用同一份文案） */
const NON_DESIGN_REF_LABELS: Record<Exclude<DesignRefTokenClass, "design_section">, string> = {
  non_design_ref_requirement: "需求 ID 引用（requirement 对象，非设计章节）",
  non_design_ref_report: "审计报告引用（外部报告，非设计章节）",
  non_design_ref_external_doc: "外部文档引用（AGENTS/存档稿本等，非设计章节）",
};

/** 一个代码模块路径是否落在施工图声明的「文件责任」范围内（声明范围是文件/目录，模块是目录） */
function scopeCovers(allowedPath: string, modulePath: string): boolean {
  const a = allowedPath.replace(/^\.\//, "").replace(/\\/g, "/");
  const m = modulePath.replace(/^\.\//, "").replace(/\\/g, "/");
  if (m === "." || m === "") return true; // 根目录散文件模块覆盖一切
  return a === m || a.startsWith(`${m}/`);
}

// ── V08-03（DESIGN.md 附录 D）：卡面「声明的真实路径」∩ 代码模块 ──

/** 路径 token 的**形状**判据：只认仓库内相对路径，认不出的不当路径（不硬凑，§4.1） */
const REPO_PATH_RE = /^[\p{L}\p{N}_@.\-/]+$/u;

export function normalizeRepoPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

export function looksLikeRepoPath(token: string): boolean {
  const raw = token.trim();
  const t = normalizeRepoPath(raw);
  if (t === "" || t === "." || !REPO_PATH_RE.test(t)) return false;
  if (t.startsWith("/") || t.includes(":") || t.includes("..")) return false; // 绝对路径/盘符/URL/上跳
  if (t.includes("/")) return true; // 带目录的路径
  // 单段：要有扩展名，或以 `/` 结尾（目录写法，如 `audit/`——归一化会把尾斜杠去掉，故看原文）
  return /\.[A-Za-z0-9]{1,10}$/.test(t) || raw.endsWith("/");
}

/** 从一段文本里取反引号中的**路径 token**（`config/x.toml [storage]` → 取空格前那段路径） */
export function backtickedPathTokens(text: string | null | undefined): string[] {
  const out: string[] = [];
  if (text === null || text === undefined) return out;
  for (const m of text.matchAll(/`([^`\n]+)`/g)) {
    // V08-04：先按原文试一次（带花括号的路径在这里展开），再退回按空白/标点切分的老口径
    for (const expanded of expandBracePaths(m[1].trim())) {
      const t = normalizeRepoPath(expanded);
      if (looksLikeRepoPath(expanded) && !out.includes(t)) out.push(t);
    }
    for (const raw of m[1].split(/[\s,，、;；|]+/)) {
      const t = normalizeRepoPath(raw.replace(/[()（）[\]【】「」]/g, ""));
      if (looksLikeRepoPath(t) && !out.includes(t)) out.push(t);
    }
  }
  return out;
}

/**
 * **只读**花括号展开（V08-04，收 R2 机制损耗）：`components/{A,B}.tsx` → `components/A.tsx`、`components/B.tsx`。
 *
 * 口径（严守"不改语义、不猜模块"）：
 *   · 只把材料**自己写的**备选项摊开，不补前缀、不猜目录（展开结果仍要过 `looksLikeRepoPath`）；
 *   · 多个花括号组按笛卡尔积展开，但有上限（默认 32 条），超限即截断——不让一条声明炸出上百条路径；
 *   · 花括号不闭合、组内为空 → **原样返回**（上层会因 `{}` 判"认不出"，属如实结果，不硬凑）。
 */
export function expandBracePaths(token: string, limit = 32): string[] {
  const t = token.trim();
  const open = t.indexOf("{");
  if (open === -1) return [t];
  const close = t.indexOf("}", open + 1);
  if (close === -1) return [t];
  const head = t.slice(0, open);
  const body = t.slice(open + 1, close);
  const tail = t.slice(close + 1);
  const alts = body.split(",").map((s) => s.trim()).filter((s) => s !== "");
  if (alts.length === 0 || head.includes("|")) return [t];
  const out: string[] = [];
  for (const a of alts) {
    for (const rest of expandBracePaths(`${head}${a}${tail}`, limit)) {
      if (!out.includes(rest)) out.push(rest);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/**
 * 声明路径参与「代码模块映射」的资格分类（2026-09-25 终审返工；派生侧与复算侧共用同一零件）。
 * 证据目录/私有数据（`.工作台/`）、VCS 内部（`.git/`）、依赖与构建产物（`node_modules/`、`dist/`、`target/`）
 * **不是代码路径**，不得冒充代码模块映射——此前它们一律落「根模块兜底」产生假边。
 * 判据只认**前缀**（`src-tauri/target/…` 这类落在真实模块内的路径不受影响）。
 */
export type DeclaredPathMappingClass = "module_candidate" | "non_code_private" | "non_code_vcs" | "non_code_generated";

export function classifyDeclaredPathForMapping(token: string): DeclaredPathMappingClass {
  const t = normalizeRepoPath(token);
  if (t === ".工作台" || t.startsWith(".工作台/")) return "non_code_private";
  if (t === ".git" || t.startsWith(".git/")) return "non_code_vcs";
  if (t === "node_modules" || t.startsWith("node_modules/") || t === "dist" || t.startsWith("dist/") || t === "target" || t.startsWith("target/")) {
    return "non_code_generated";
  }
  return "module_candidate";
}

/** 不参与映射的原因名（信息性 omitted 登记与读数用同一份文案） */
const DECLARED_PATH_NOT_MAPPED_LABELS: Record<string, string> = {
  non_code_private: "私有/证据路径（.工作台/），非代码",
  non_code_vcs: "VCS 内部路径（.git/），非代码",
  non_code_generated: "依赖/构建产物路径（node_modules/、dist/、target/），非代码",
  no_module_hit: "未命中任何代码模块（非模块目录或路径片段）",
  bare_name_not_at_root: "裸文件名/单段名在仓库根不存在，不冒充模块映射",
  root_file_unconfirmed: "仓库根级文件清单未知，无法证实根级存在",
};

/**
 * 卡面声明的**真实路径**（附录 D 的映射来源①）：文件责任段（`allowed_paths`）
 * ＋ 完成证据列 ＋ 交付段里反引号中的路径 token。去重保序；认不出的丢掉。
 */
export function declaredRealPathsOf(task: {  allowed_paths?: readonly string[];
  evidence_requirement?: string | null;
  deliverables?: readonly string[] | null;
}): string[] {
  const out: string[] = [];
  const push = (t: string): void => {
    if (!out.includes(t)) out.push(t);
  };
  for (const p of task.allowed_paths ?? []) {
    // V08-04：`文件责任` 里的花括号写法先展开再判形态（`src/server/work/{plan,tasks}.ts` → 两条）
    for (const expanded of expandBracePaths(p)) if (looksLikeRepoPath(expanded)) push(normalizeRepoPath(expanded));
  }
  for (const t of backtickedPathTokens(task.evidence_requirement ?? null)) push(t);
  for (const d of task.deliverables ?? []) for (const t of backtickedPathTokens(d)) push(t);
  return out;
}

/** 两条仓库内路径是否**相交**（任一侧包含另一侧，目录边界对齐；不含根，根由调用方单独处理） */
export function pathIntersectsPath(a: string, b: string): boolean {
  const x = normalizeRepoPath(a);
  const y = normalizeRepoPath(b);
  if (x === "" || y === "" || x === "." || y === ".") return false;
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}

/**
 * 确定性派生（**零模型**）：只吃设计章节、施工任务与静态模块，产出规划图骨架。
 *
 * 节点来源与稳定 id（改名不换身份，改章节顺序会换身份——如实写在 id 里）：
 *   · capability = 设计书 level-2 章节（不含「附录」）→ id `plan:cap:<章节序号>`，name = 章节标题；
 *   · module     = 设计书声明的模块清单条目 → id `plan:mod:<章节序号>-<条目序号>`，name = 声明名；
 *   · task       = 施工图任务定义 → id `plan:task:<卡号>`（卡号是源声明的稳定键）；
 *   · code       = 静态解析层模块 → id `plan:code:<模块 id>`（模块 id 本就是稳定键）。
 * 关系来源：施工图依赖列（task_dependency）、施工卡设计依据（task_design_ref）、
 * 设计模块清单归属章节（design_interface）、施工图文件责任 ∩ 静态模块（implementation_map）。
 * 全部带可定位出处；**没有任何完成色/进度**（§4.2）。
 */
export function deriveBlueprint(src: BlueprintSources, opts: DeriveOptions): Blueprint {
  const limits = opts.limits ?? BLUEPRINT_LIMITS;
  const generatedAt = opts.generated_at ?? nowIso();
  const omitted: BlueprintOmission[] = [];
  const nodes: BlueprintNode[] = [];
  const edges: BlueprintEdge[] = [];
  const design = src.design;
  const plan = src.plan;

  const designRef = (section: { path: string; sha256: string }): BlueprintSourceRef => ({
    kind: "design_section",
    path: design?.path ?? "",
    locator: section.path,
    sha256: section.sha256,
  });
  // 2026-09-27：plan_task 引用烙**该卡当前的单卡定义哈希**（不再烙整份 `definition_sha256`）——
  // 改一张卡只让引用它的 plan_task 来源失效，别的卡不陪葬。单卡哈希与写侧/投影侧同一份实现
  // （`shared/planCardHash.ts`），并已排除 plan_revision/勾选位等派生位，只改状态列不判失效。
  const planRef = (task: TaskDefinition): BlueprintSourceRef => ({
    kind: "plan_task",
    path: plan?.path ?? "",
    locator: task.task_id,
    sha256: taskDefinitionHash(task),
  });

  // ── 派生边去重（V09-08 ④；附录 E.6 第 4 条）──
  // 同一权威事实重复派生必须**稳定且不虚高**（§3.3/§4.1）：键 = `source|target|kind|certainty`。
  // 语义要点：**同一卡引用不同章节**通常解析到**不同能力**（target 不同）⇒ 仍是两条边；
  // 只有当两处依据落在同一个 (source,target,kind,certainty) 上才合并，合并时 `source_refs`
  // 取并集（保序）——出处一条不丢，行数不再虚高。顺序＝首次出现顺序（不做二次排序）。
  const edgeKeyOf = (e: BlueprintEdge): string => `${e.source}|${e.target}|${e.kind}|${e.certainty}`;
  const pushEdge = (edge: BlueprintEdge): void => {
    const key = edgeKeyOf(edge);
    const found = edges.find((e) => edgeKeyOf(e) === key);
    if (found === undefined) {
      edges.push(edge);
      return;
    }
    for (const r of edge.source_refs) {
      if (
        !found.source_refs.some(
          (x) => x.kind === r.kind && x.path === r.path && x.locator === r.locator && x.sha256 === r.sha256,
        )
      ) {
        found.source_refs.push(r);
      }
    }
  };

  // ── 能力节点（设计书 level-2 章节）与「章节 → 能力」归属表 ──
  const capOrdinalOfSection = new Map<number, number>();
  let capOrdinal = 0;
  const capabilitySections: { index: number; ordinal: number; section: { path: string; sha256: string; title: string } }[] = [];
  if (design !== null) {
    design.sections.forEach((s, i) => {
      if (s.level === 2 && !s.title.startsWith("附录")) {
        capOrdinal += 1;
        capOrdinalOfSection.set(i, capOrdinal);
        capabilitySections.push({ index: i, ordinal: capOrdinal, section: s });
      } else if (capOrdinal > 0) {
        capOrdinalOfSection.set(i, capOrdinal); // 子节继承最近的 level-2 能力
      }
    });
    for (const c of capabilitySections) {
      nodes.push({
        id: `${PLAN_PREFIX}cap:${pad2(c.ordinal)}`,
        kind: "capability",
        name: c.section.title,
        source_refs: [designRef(c.section)],
        related_ids: [],
      });
    }
  }

  // ── 模块节点（设计书声明的模块清单）+ 能力→模块关系 ──
  const moduleNodeId = new Map<string, string>(); // 声明模块**稳定 ID** → 节点 id（V08-01：不再按名字/位置）
  src.declared_modules.forEach((m) => {
    // V08-01：节点 id = 声明模块的**稳定 ID**（`plan:mod:<sectionKey>-<declaredKey>`）——
    // 稳定键来自材料自己声明的编号（§11.1 的 `#` 列）或材料定位，改名不换身份、章节重排也不换身份
    // （旧形态 `plan:mod:<章节序号>-<条目序号>` 两者都会换，属 §4.1 已登记的已知限制，本次迁移收口）。
    const id = `${PLAN_PREFIX}mod:${m.stable_id}`;
    moduleNodeId.set(m.stable_id, id);
    const refs: BlueprintSourceRef[] = [];
    const section = design?.sections.find((s) => s.path === m.section_path) ?? null;
    if (section !== null && section !== undefined && design !== null) refs.push(designRef(section));
    nodes.push({ id, kind: "module", name: m.name, source_refs: refs, related_ids: [] });
    // 归属能力：模块清单所在章节所属的 level-2 能力（找不到就不连，不猜）
    if (design !== null && section !== null && section !== undefined) {
      const secIdx = design.sections.findIndex((s) => s.path === section.path);
      const ord = capOrdinalOfSection.get(secIdx);
      if (ord !== undefined && section !== undefined) {
        pushEdge({
          source: `${PLAN_PREFIX}cap:${pad2(ord)}`,
          target: id,
          kind: "design_interface",
          source_refs: [designRef(section)],
          certainty: "declared",
        });
      }    }
  });

  // ── 任务节点 + 任务依赖 + 设计依据 ──
  const taskIds = new Set((plan?.tasks ?? []).map((t) => t.task_id));
  for (const task of plan?.tasks ?? []) {
    nodes.push({
      id: `${PLAN_PREFIX}task:${task.task_id}`,
      kind: "task",
      name: task.goal === null || task.goal === "" ? task.task_id : `${task.task_id} ${task.goal}`,
      source_refs: [planRef(task)],
      related_ids: [],
    });
  }
  for (const task of plan?.tasks ?? []) {
    for (const dep of task.dependency_ids) {
      if (!taskIds.has(dep)) {
        omitted.push({ kind: "dangling_dependency", detail: `${task.task_id} 依赖 ${dep}，但依赖卡不在本次任务定义里`, count: 1 });
        continue;
      }
      pushEdge({
        source: `${PLAN_PREFIX}task:${dep}`,
        target: `${PLAN_PREFIX}task:${task.task_id}`,
        kind: "task_dependency",
        source_refs: [planRef(task)],
        certainty: "declared",
      });
    }
    // 设计依据 → 能力（§4.1「关联任务」；解析不到的节号如实登记，不硬凑）
    // 2026-09-25 终审返工：先按 token 的**真实类别**分流——非设计章节引用（需求 ID／审计报告／
    // 外部文档）登记为信息性 omitted（不阻断）；附录形态引用定位到附录章节（附录不是能力章节，
    // 不产生能力边，登记为信息性 omitted）；**真正定位不到的设计依据**仍 unresolved_design_ref
    // 报缺并阻断（反例保留：消失/不存在的依据不许靠解析漏认消掉）。
    const nonDesignRefs: { token: string; cls: Exclude<DesignRefTokenClass, "design_section"> }[] = [];
    const appendixRefs: string[] = [];
    for (const ref of task.design_refs) {
      if (design === null) break;
      const cls = classifyDesignRefToken(ref);
      if (cls !== "design_section") {
        nonDesignRefs.push({ token: ref, cls });
        continue;
      }
      const idx = resolveDesignRef(ref, design.sections);
      if (idx === -1) {
        omitted.push({ kind: "unresolved_design_ref", detail: `${task.task_id} 的设计依据「${ref}」在设计书章节索引里定位不到`, count: 1 });
        continue;
      }
      if (isAppendixSection(design.sections, idx)) {
        appendixRefs.push(ref);
        continue;
      }
      const ord = capOrdinalOfSection.get(idx);
      if (ord === undefined) continue;
      pushEdge({
        source: `${PLAN_PREFIX}task:${task.task_id}`,
        target: `${PLAN_PREFIX}cap:${pad2(ord)}`,
        kind: "task_design_ref",
        source_refs: [designRef(design.sections[idx])],
        certainty: "declared",
      });
    }
    if (appendixRefs.length > 0) {
      omitted.push({
        kind: "appendix_design_ref",
        detail:
          `${task.task_id} 的 ${appendixRefs.length} 条设计依据定位到**附录章节**（${appendixRefs.slice(0, 3).join("、")}）——` +
          "附录引用已正确定位、不产生能力边（附录不是能力章节）；信息性登记，不报缺",
        count: appendixRefs.length,
      });
    }
    for (const cls of Object.keys(NON_DESIGN_REF_LABELS) as (keyof typeof NON_DESIGN_REF_LABELS)[]) {
      const tokens = nonDesignRefs.filter((r) => r.cls === cls).map((r) => r.token);
      if (tokens.length === 0) continue;
      omitted.push({
        kind: cls,
        detail:
          `${task.task_id} 的 ${tokens.length} 条设计依据是${NON_DESIGN_REF_LABELS[cls]}（${tokens.slice(0, 2).join("、")}）——` +
          "按真实类别登记、不按设计章节解析；信息性登记，不报缺",
        count: tokens.length,
      });
    }
  }

  // ── 代码模块节点 + 实现映射（施工图「文件责任」∩ 静态模块）──
  for (const m of src.code.modules) {
    nodes.push({
      id: `${PLAN_PREFIX}code:${m.id}`,
      kind: "module",
      name: src.names[m.id]?.name ?? m.id,
      source_refs: [{ kind: "code_module", path: `${ARCH_SUBDIR}/modules.json`, locator: m.id, sha256: null }],
      related_ids: [],
    });
  }
  if (src.code.modules.length > 0) {
    // V08-03（附录 D）：实现映射 = 卡面**声明的真实路径**（文件责任 ∪ 完成证据/交付里的路径）
    // ∩ 代码模块目录（路径相交，任一侧包含另一侧）。判据细化（2026-09-25 终审返工，用户指令）：
    //   · 根模块（path 为 `.` / 空）只在**该卡没有任何更具体的模块命中**时才算命中——
    //     否则"根目录覆盖一切"会让每张卡都映射到根，模块状态被糊成一句；
    //   · **非代码路径不产生映射**：`.工作台/`（私有/证据）、`.git/`（VCS 内部）、
    //     `node_modules/`、`dist/`、`target/`（依赖/构建产物）一律排除，登记为信息性 omitted；
    //   · 落根模块的唯一合法情形＝**仓库根真实存在的单段文件**（根模块是根目录散文件的真实归属，
    //     不是"其余都归根"的兜底）；多段路径没命中具体模块、或裸文件名在根下不存在，
    //     都**不产生映射**（登记信息性 omitted，不冒充、不报缺阻断）；
    //   · 同一条边只记一次（原实现按「声明路径 × 模块」逐个 push，同一对会重复多行）。
    const rootModuleIds = new Set(
      src.code.modules.filter((m) => normalizeRepoPath(m.path) === "" || normalizeRepoPath(m.path) === ".").map((m) => m.id),
    );
    const rootFiles = src.repo_root_files === null ? null : new Set(src.repo_root_files);
    const seenEdge = new Set(edges.map((e) => `${e.source}|${e.target}|${e.kind}`));
    for (const task of plan?.tasks ?? []) {
      const declared = declaredRealPathsOf(task);
      if (declared.length === 0) continue;
      const hit = new Set<string>();
      const notMapped = new Map<string, string[]>(); // reason → tokens
      const markNotMapped = (reason: string, token: string): void => {
        const list = notMapped.get(reason) ?? [];
        if (!list.includes(token)) list.push(token);
        notMapped.set(reason, list);
      };
      for (const p of declared) {
        const cls = classifyDeclaredPathForMapping(p);
        if (cls !== "module_candidate") {
          markNotMapped(cls, p);
          continue;
        }
        let specific = false;
        for (const m of src.code.modules) {
          if (rootModuleIds.has(m.id) || !pathIntersectsPath(p, m.path)) continue;
          hit.add(m.id);
          specific = true;
        }
        if (specific) continue;
        // 这条声明路径没有落到任何更具体的模块：只有「仓库根真实存在的单段文件」才落根模块；
        // 多段路径与根下不存在的裸名不产生映射（根兜底假边由此消除，不是删边、是不再造边）
        if (!p.includes("/")) {
          if (rootFiles === null) markNotMapped("root_file_unconfirmed", p);
          else if (rootFiles.has(p)) for (const rootId of rootModuleIds) hit.add(rootId);
          else markNotMapped("bare_name_not_at_root", p);
        } else {
          markNotMapped("no_module_hit", p);
        }
      }
      for (const [reason, tokens] of notMapped) {
        omitted.push({
          kind: "declared_path_not_mapped",
          detail:
            `${task.task_id} 的 ${tokens.length} 条声明路径不参与代码模块映射（${DECLARED_PATH_NOT_MAPPED_LABELS[reason] ?? reason}）：` +
            `${tokens.slice(0, 3).join("、")}——信息性登记，不产生映射边、不报缺`,
          count: tokens.length,
        });
      }
      for (const moduleId of [...hit].sort()) {
        const source = `${PLAN_PREFIX}task:${task.task_id}`;
        const target = `${PLAN_PREFIX}code:${moduleId}`;
        const key = `${source}|${target}|implementation_map`;
        if (seenEdge.has(key)) continue;
        seenEdge.add(key);
        edges.push({
          source,
          target,
          kind: "implementation_map",
          source_refs: [planRef(task)],
          certainty: "observed",
        });
      }
    }
  }

  let blueprint = assembleBlueprint(src, generatedAt, limits, opts, nodes, edges, omitted);
  const rawProposal = opts.proposal ?? null;
  if (rawProposal !== null) {
    // V08-05：模型给的来源引用**先在真实锚点上做确定性归一/逐条剔除**，再进合并与 §4.1 校验。
    // 口径：只认「精确命中」或「唯一包含命中」；歧义/认不出的一律不进图（不猜、不补字）；
    //       §4.1 的强度不变——进图的每条来源仍然必须可定位（校验器一个字没放宽）。
    const norm = normalizeProposalRefs(rawProposal, src);
    // 这三条账目推给**返回的蓝图对象**：`assembleBlueprint` 内部会拷贝传入的数组，
    // 往上面那个 `omitted` 推会丢；`mergeProposal` 又是从 `base.omitted` 起算的。
    if (norm.normalized > 0) {
      blueprint.omitted.push({
        kind: "ref_normalized",
        detail: `模型来源引用按真实锚点归一 ${norm.normalized} 条（排版归一：分隔符/引号/空白；不改字、不补字）`,
        count: norm.normalized,
      });
    }
    if (norm.dropped.length > 0) {
      blueprint.omitted.push({
        kind: "ref_dropped",
        detail:
          `模型来源引用被逐条剔除 ${norm.dropped.length} 条（歧义/认不出的不进图；坏条目不影响同一轮其余条目）：` +
          norm.dropped.slice(0, 3).map((d) => `${d.what} ${d.why}`).join("；"),
        count: norm.dropped.length,
      });
    }
    if (norm.dropped_nodes > 0 || norm.dropped_edges > 0) {
      blueprint.omitted.push({
        kind: "model_item_dropped",
        detail:
          `模型新增条目因来源全不可定位被**逐节点/逐关系剔除**：节点 ${norm.dropped_nodes} 个、关系 ${norm.dropped_edges} 条` +
          "（“来源不可定位”只剔除该条，不再整份 scope 弃用）",
        count: norm.dropped_nodes + norm.dropped_edges,
      });
    }
    blueprint = mergeProposal(blueprint, norm.proposal, limits);
  }
  return blueprint;
}

// ── 从历史/指定文本派生（C016 最小导出） ──

/**
 * 从给定的设计/施工**文本**构造派生输入（C016 收口第二包的最小导出）。
 *
 * 用途只有一个：核对"源修订后的预期结果"——`blueprintInheritance.ts` 登记继承事实前，
 * 用它从 from 基线的**不可变修订**（recoverRevision 取回，哈希校验过）重建 from 图、
 * 从当前权威源重建 to 图。**不复制第二份设计/施工正文作为事实源**：文本是临时校验材料，
 * 不落盘、不进缓存键体系之外的任何权威位置。
 * 口径与 `readBlueprintSources` 逐项对齐（章节索引建在定义正文上、模块清单提取器复用同一套、
 * 任务定义走 importTaskDefinitions）；代码模块与名称缓存只能取**当前**值（历史没有实现观察快照，
 * 如实声明这一限制：前任/继任核对针对设计/施工派生节点才严格）。
 */
export function blueprintSourcesFromTexts(input: {
  baseline_id: string | null;
  is_tatai: boolean;
  design: { path: string; text: string } | null;
  plan: { path: string; text: string } | null;
  code: BlueprintSources["code"];
  names: BlueprintSources["names"];
  /** 仓库根级文件名清单（不给 = null = 未知：单段声明 token 一律不产生根模块映射） */
  repo_root_files?: string[] | null;
}): BlueprintSources {
  const manifest: BlueprintSourceManifestEntry[] = [];
  let design: BlueprintSources["design"] = null;
  if (input.design !== null) {
    const definitionText = designDefinitionText(input.design.text);
    design = {
      path: input.design.path,
      content_sha256: sha256(input.design.text),
      definition_sha256: sha256(definitionText),
      text: input.design.text,
      // 章节索引建在全量正文上（引用定位要能找到附录章节；口径与 readBlueprintSources 一致，
      // 2026-09-25 终审返工更正）；定义哈希仍只取待议区前正文
      sections: buildSectionIndex(input.design.text).map((s) => ({
        path: s.path,
        sha256: s.sha256,
        level: s.level,
        title: s.title,
      })),
    };
    manifest.push({ role: "design", path: design.path, sha256: design.content_sha256, status: "ok", detail: `${design.sections.length} 个章节` });
  }
  let plan: BlueprintSources["plan"] = null;
  if (input.plan !== null) {
    const imported = importTaskDefinitions(input.plan.text, {
      plan_revision: sha256(input.plan.text),
      design_revision: design?.definition_sha256 ?? null,
    });
    plan = {
      path: input.plan.path,
      content_sha256: sha256(input.plan.text),
      definition_sha256: definitionHashOf(parsePlanTable(input.plan.text)?.rows ?? []),
      text: input.plan.text,
      tasks: imported.definitions,
    };
    manifest.push({ role: "plan", path: plan.path, sha256: plan.definition_sha256, status: "ok", detail: `${plan.tasks.length} 个任务定义` });
  }
  const declaredRaw =
    design === null ? [] : input.is_tatai ? extractTataiDesignModules(design.text) : extractDesignModules(design.text);
  const moduleSection = design === null ? null : moduleSectionPathOf(design.text, input.is_tatai);
  const declared_modules = declaredRaw.map((m) => ({ ...m, section_path: moduleSection }));
  return {
    baseline_id: input.baseline_id,
    design,
    plan,
    declared_modules,
    code: input.code,
    repo_root_files: input.repo_root_files ?? null,
    names: input.names,
    manifest,
  };
}

/** 从给定文本确定性派生一份规划图（零模型；缓存键按内容现算）。用途见 blueprintSourcesFromTexts。 */
export function deriveBlueprintFromTexts(input: Parameters<typeof blueprintSourcesFromTexts>[0]): Blueprint {
  const src = blueprintSourcesFromTexts(input);
  return deriveBlueprint(src, { based_on: cacheKeysOf(src, false) });
}

/** 把节点/边集合收口成一份 Blueprint：对称 related_ids → 上限截断 → 覆盖账目 → 省略登记 */
function assembleBlueprint(
  src: BlueprintSources,
  generatedAt: string,
  limits: BlueprintLimits,
  opts: DeriveOptions,
  nodes: BlueprintNode[],
  edges: BlueprintEdge[],
  omittedIn: BlueprintOmission[],
): Blueprint {
  const omitted = [...omittedIn];

  // related_ids 由关系集合**对称导出**（构造上就不会悬空），再并上模型额外给的可解析引用
  const related = new Map<string, Set<string>>();
  const add = (a: string, b: string): void => {
    if (a === b) return;
    (related.get(a) ?? related.set(a, new Set()).get(a)!).add(b);
  };
  for (const e of edges) {
    add(e.source, e.target);
    add(e.target, e.source);
  }
  for (const n of nodes) for (const r of n.related_ids) add(n.id, r);

  // 上限（§4.3 第 1 招）：按 kind 的稳定优先级截断，被截掉的如实登记（不静默丢）
  const order: Record<BlueprintNodeKind, number> = { capability: 0, module: 1, task: 2, concept: 3 };
  const sortedNodes = [...nodes].sort((a, b) => order[a.kind] - order[b.kind] || a.id.localeCompare(b.id));
  const nodesTotal = sortedNodes.length;
  let keptNodes = sortedNodes;
  if (nodesTotal > limits.max_nodes) {
    const dropped = sortedNodes.length - limits.max_nodes;
    keptNodes = sortedNodes.slice(0, limits.max_nodes);
    omitted.push({ kind: "node_cap", detail: `超出规划图节点上限 ${limits.max_nodes}：${dropped} 个节点未收录（按 kind 优先级截断，视图侧应显示"还有 N 个"）`, count: dropped });
  }
  const keptIds = new Set(keptNodes.map((n) => n.id));
  const keptEdgesIn = edges.filter((e) => keptIds.has(e.source) && keptIds.has(e.target));
  const droppedEdgesByNode = edges.length - keptEdgesIn.length;
  if (droppedEdgesByNode > 0) {
    omitted.push({ kind: "node_cap", detail: `因端点被节点上限截断而丢弃的关系 ${droppedEdgesByNode} 条`, count: droppedEdgesByNode });
  }
  const edgesTotal = edges.length;
  let keptEdges = keptEdgesIn;
  if (keptEdgesIn.length > limits.max_edges) {
    const dropped = keptEdgesIn.length - limits.max_edges;
    keptEdges = keptEdgesIn.slice(0, limits.max_edges);
    omitted.push({ kind: "edge_cap", detail: `超出规划图关系上限 ${limits.max_edges}：${dropped} 条关系未收录`, count: dropped });
  }

  const finalNodes = keptNodes.map((n) => ({
    ...n,
    related_ids: [...(related.get(n.id) ?? new Set<string>())].filter((r) => keptIds.has(r)).sort(),
  }));

  // 覆盖账目：每一侧都必须 mapped + unmapped === total（不许拿空集冒充全覆盖）
  const refLocators = (kind: BlueprintSourceKind): Set<string> => {
    const out = new Set<string>();
    for (const n of finalNodes) for (const r of n.source_refs) if (r.kind === kind) out.add(r.locator);
    for (const e of keptEdges) for (const r of e.source_refs) if (r.kind === kind) out.add(r.locator);
    return out;
  };
  const designLocators = refLocators("design_section");
  const planLocators = refLocators("plan_task");
  // 代码侧不看"有没有代码节点"，而看**有没有建立关联**（§4.1/§4.5 同一口径，见 codeLinkageOf）：
  // 否则每个模块天生就"已映射"，"待归属"永远为空
  const codeLinked = codeLinkageOf({ nodes: finalNodes, edges: keptEdges }).linked_module_ids;
  // 覆盖账目的设计侧基数＝**非附录章节**（2026-09-25 终审返工）：章节索引是全量正文（附录引用要可定位），
  // 但附录章节按设计不产生任何规划对象（能力只取 level-2 非附录章节），把它们计入「未映射」是纯噪音——
  // 基数仍满足 mapped + unmapped === total（校验侧用同一个 `isAppendixScopedSection` 判据，两侧同基数自洽）。
  const designSections = (src.design?.sections ?? []).filter((s) => !isAppendixScopedSection(s));
  const designUnmapped = designSections
    .filter((s) => !designLocators.has(s.path))
    .map((s) => ({ key: s.path, detail: "未映射到任何规划对象（子节未逐条引用时属正常，如实列出）" }));
  const planTasks = src.plan?.tasks ?? [];
  const planUnmapped = planTasks
    .filter((t) => !planLocators.has(t.task_id))
    .map((t) => ({ key: t.task_id, detail: "任务定义没有进规划图" }));
  const codeUnmapped = src.code.modules
    .filter((m) => !codeLinked.has(m.id))
    .map((m) => ({ key: m.id, detail: "代码模块没有任何规划关联（待归属：由设计/执行角色核实，§4.5）" }));

  const coverage: BlueprintCoverage = {
    design_sections: { total: designSections.length, mapped: designSections.length - designUnmapped.length, unmapped: designUnmapped },
    plan_tasks: { total: planTasks.length, mapped: planTasks.length - planUnmapped.length, unmapped: planUnmapped },
    code_modules: { total: src.code.modules.length, mapped: src.code.modules.length - codeUnmapped.length, unmapped: codeUnmapped },
    nodes_total: nodesTotal,
    nodes_kept: finalNodes.length,
    edges_total: edgesTotal,
    edges_kept: keptEdges.length,
    note: "覆盖账目按真实输入条数算：某一侧 mapped < total 时 unmapped 逐条列出，缺失就说缺失（DESIGN.md §4.1）。",
  };
  const unmappedCount = designUnmapped.length + planUnmapped.length + codeUnmapped.length;
  if (unmappedCount > 0) {
    omitted.push({
      kind: "unmapped",
      detail:
        `未映射：设计章节 ${designUnmapped.length} / 施工任务 ${planUnmapped.length} / 代码模块 ${codeUnmapped.length}；` +
        (src.code.available ? "" : "（本项目还没跑过静态解析，代码侧本就没有输入）"),
      count: unmappedCount,
    });
  }

  return {
    version: BLUEPRINT_VERSION,
    baseline_id: src.baseline_id,
    generator_version: BLUEPRINT_GENERATOR_VERSION,
    generated_at: generatedAt,
    source_manifest: src.manifest,
    nodes: finalNodes,
    edges: keptEdges,
    coverage,
    omitted,
    model_receipt: opts.model_receipt ?? null,
    model_leads: [],
    capability_classes: capabilityClassesOf(src, keptNodes),
    publish: { published: false, reason: null, validated_at: null },
    based_on: opts.based_on,
  };
}

/** 「能力分类声明」表的标记行（DESIGN §3.2，2026-09-26 GPT-6 裁定 7）：分类的**唯一来源**是设计书里的
 *  这张声明表；代码只按表读，不硬编码任何项目的章节号。 */
const CAPABILITY_CLASS_TABLE_MARKER = "能力分类声明（机器可读）";

/** 表的一行：能读出章节号就算「一行」；分类列认得出来才算解析成功 */
interface CapabilityClassRow {
  chapter: number;
  cls: "functional" | "governance" | null;
  raw: string;
}

/** 从 `from` 起找一张表格；表前只容忍空行，遇到别的正文即认为此处没有表（返回 null） */
function parseClassTableAt(lines: readonly string[], from: number): CapabilityClassRow[] | null {
  let started = false;
  const rows: CapabilityClassRow[] = [];
  for (let i = from; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trimStart().startsWith("|")) {
      if (started) break; // 表格结束
      if (line.trim() !== "") return null; // 标记与表之间出现正文 ⇒ 此处没有表
      continue;
    }
    started = true;
    const head = line.match(/^\|\s*§(\d+)/);
    if (head === null) continue; // 表头行 / 分隔行：不含 §N，跳过
    const m = line.match(/^\|\s*§(\d+)[^|]*\|\s*(功能能力|设计\/治理)\s*\|/);
    rows.push({
      chapter: Number(head[1]),
      cls: m === null ? null : m[2] === "功能能力" ? "functional" : "governance",
      raw: line.trim(),
    });
  }
  return rows.length > 0 ? rows : null;
}

/** 设计书里出现的 level-2 数字章节号（`## 1. 标题` 形态；没有这种标题时返回 null＝无从对账） */
function designChapterNumbersOf(designText: string): number[] | null {
  const nums = new Set<number>();
  for (const line of designText.split(/\r?\n/)) {
    const m = line.match(/^##\s+(\d+)\s*[.、．]/);
    if (m !== null) nums.add(Number(m[1]));
  }
  return nums.size > 0 ? [...nums].sort((a, b) => a - b) : null;
}

/**
 * 从设计书原文解析「能力分类声明」表（§3.2，机器可读契约）：
 * 逐行读 `| §N <标题> | 功能能力|设计/治理 | 依据 |`。
 *
 * R-1/B 类返工（2026-09-26 非作者复审，四类反例 probes/probe1）——旧实现三处静默：
 *   ① 标记取**首个**含字样行：字样出现在待议/引用正文而其后无表时，真表在后面也不读（静默判「未声明」）；
 *   ② 表里缺一行 ⇒ 该章无条目 ⇒ 调用侧 `?? "functional"` 静默判成功能能力（治理章节混进功能全景）；
 *   ③ 同章两行分类矛盾 / 分类列写法损坏 ⇒ `Map.set` 覆盖或整行跳过，都没有告警。
 * 现在：**取第一处真能读出行的表**（跳过只有字样没有表的命中并逐条登记），并把缺章、重复、坏行、
 * 章节对不上、多表**逐项登记**（`issues`），`state` 三分（declared／undeclared／broken）——
 * 调用侧据此不再静默回退 functional（DESIGN §3.2）。
 *
 * `declared` 的兼容口径不变：表完好才为 true；没有表 ⇒ false（调用方按「全部功能能力＋注明未声明」）。
 */
export function capabilityClassTableOf(designText: string | null): {
  declared: boolean;
  byChapter: Map<number, "functional" | "governance">;
  state: CapabilityClassTableState;
  issues: CapabilityClassIssue[];
  /** 设计书里对账用的 level-2 数字章节号（`## N.` 形态；没有则为 null＝不做交叉对账） */
  designChapters: number[] | null;
} {
  const byChapter = new Map<number, "functional" | "governance">();
  const issues: CapabilityClassIssue[] = [];
  const undeclared = { declared: false, byChapter, state: "undeclared" as const, issues, designChapters: null };
  if (designText === null) return undeclared;
  const lines = designText.split(/\r?\n/);

  // ① 标记行：逐个候选往后找**真能读出行的表**（不再盲取首个命中）
  const markerIdxs: number[] = [];
  for (let i = 0; i < lines.length; i++) if (lines[i].includes(CAPABILITY_CLASS_TABLE_MARKER)) markerIdxs.push(i);
  if (markerIdxs.length === 0) return undeclared;

  const tables: { at: number; rows: CapabilityClassRow[] }[] = [];
  const skippedMarkers: number[] = [];
  for (const idx of markerIdxs) {
    const rows = parseClassTableAt(lines, idx + 1);
    if (rows === null) skippedMarkers.push(idx);
    else tables.push({ at: idx, rows });
  }
  for (const idx of skippedMarkers) {
    issues.push({
      kind: "marker_misplaced",
      chapter: null,
      detail: `第 ${idx + 1} 行出现「${CAPABILITY_CLASS_TABLE_MARKER}」字样，但其后没有可读的声明表（待议/引用正文）——已跳过，继续向后找真表`,
      blocking: false,
    });
  }
  if (tables.length === 0) {
    // 有字样、无表 ⇒ 没有声明表：保留 §3.2 兼容口径（全部按功能能力＋注明「未声明」），但登记不静默
    return { declared: false, byChapter, state: "undeclared", issues, designChapters: designChapterNumbersOf(designText) };
  }
  if (tables.length > 1) {
    issues.push({
      kind: "multiple_tables",
      chapter: null,
      detail: `检测到 ${tables.length} 处可读的能力分类声明表（行 ${tables.map((t) => t.at + 1).join("、")}）——取第一处，其余登记；取哪张不明时分类不可信`,
      blocking: true,
    });
  }
  const chosen = tables[0].rows;

  // ② 逐行归账：坏行（认不出分类列）与重复章都登记
  const seen = new Map<number, "functional" | "governance">();
  for (const row of chosen) {
    if (row.cls === null) {
      issues.push({
        kind: "malformed_row",
        chapter: row.chapter,
        detail: `§${row.chapter} 的分类列写法认不出（只认「功能能力」与「设计/治理」）：${row.raw}——该行不产生分类`,
        blocking: true,
      });
      continue;
    }
    const prev = seen.get(row.chapter);
    if (prev !== undefined) {
      const conflict = prev !== row.cls;
      issues.push({
        kind: "duplicate_chapter",
        chapter: row.chapter,
        detail: conflict
          ? `§${row.chapter} 出现两行且分类矛盾（${prev === "functional" ? "功能能力" : "设计/治理"} → ${row.cls === "functional" ? "功能能力" : "设计/治理"}）——取首次出现的分类并报缺，不静默取后值`
          : `§${row.chapter} 重复出现（分类一致）——取首次出现的分类`,
        blocking: conflict,
      });
      continue;
    }
    seen.set(row.chapter, row.cls);
    byChapter.set(row.chapter, row.cls);
  }

  // ③ 缺章对账：设计书有 `## N.` 标题就按它；没有就按表自身的连续区段推
  const designChapters = designChapterNumbersOf(designText);
  const present = [...byChapter.keys()].sort((a, b) => a - b);
  const malformedChapters = new Set(issues.filter((i) => i.kind === "malformed_row").map((i) => i.chapter));
  const expected =
    designChapters !== null
      ? designChapters
      : present.length === 0
        ? []
        : Array.from({ length: present[present.length - 1] - present[0] + 1 }, (_, k) => present[0] + k);
  for (const ch of expected) {
    if (byChapter.has(ch) || malformedChapters.has(ch)) continue;
    issues.push({
      kind: "missing_chapter",
      chapter: ch,
      detail:
        `§${ch} 在声明表里没有可用的分类行` +
        (designChapters !== null ? "（设计书有此章）" : "（表自身区段不连续）") +
        "——不得静默按功能能力处理（§3.2）",
      blocking: true,
    });
  }
  if (designChapters !== null) {
    for (const ch of present) {
      if (!designChapters.includes(ch)) {
        issues.push({
          kind: "chapter_mismatch",
          chapter: ch,
          detail: `声明表里的 §${ch} 在设计书 level-2 章节里不存在——表与设计书对不上`,
          blocking: true,
        });
      }
    }
  }

  const broken = issues.some((i) => i.blocking) || byChapter.size === 0;
  return {
    declared: !broken,
    byChapter,
    state: broken ? "broken" : "declared",
    issues,
    designChapters,
  };
}

/**
 * 把声明表落到能力节点上（`plan:cap:*` → 分类）：
 * 章节号优先按能力节点**名称的前导序号**对齐（`1. 项目概述` ↔ §1），对不上才按能力序号（第 N 个 level-2 章节）。
 * 未声明（无表）⇒ 全部 functional 且 declared=false，口径句注明「能力分类未声明」（§3.2）。
 * 表损坏（broken）⇒ **不默认 functional**：只落**解析成功**的那些章节，`declared=false` ＋
 * `table_state="broken"` ＋ `issues` 逐项点名；校验层据此阻断发布（保留上次有效图），
 * 界面按「分类未定」呈现并显示原因（R-1/B 类返工，§3.2／§3.3／§4.4）。
 */
function capabilityClassesOf(src: BlueprintSources, nodes: BlueprintNode[]): BlueprintCapabilityClasses {
  const table = capabilityClassTableOf(src.design?.text ?? null);
  const by: Record<string, "functional" | "governance"> = {};
  const caps = nodes.filter((n) => n.kind === "capability" && n.id.startsWith(`${PLAN_PREFIX}cap:`));
  const broken = table.state === "broken";
  let ordinal = 0;
  let unclassified = 0;
  for (const cap of caps) {
    ordinal += 1;
    const lead = cap.name.match(/^(\d+)\s*[.、．]/)?.[1];
    const chapter = lead !== undefined ? Number(lead) : ordinal;
    const cls = table.byChapter.get(chapter);
    if (cls === undefined) {
      // 表完好却没这条 ⇒ 不可能（缺章已登记为 blocking）；表损坏 ⇒ 该章分类**未定**，不写 functional
      if (broken) unclassified += 1;
      else by[cap.id] = "functional";
      continue;
    }
    by[cap.id] = cls;
  }
  const governance = Object.values(by).filter((c) => c === "governance").length;
  const issueText = table.issues.map((i) => `§${i.chapter ?? "—"} ${i.kind}：${i.detail}`).join("；");
  return {
    declared: table.declared,
    by_capability: by,
    table_state: table.state,
    issues: table.issues,
    note: broken
      ? `能力分类声明表**损坏**（${table.issues.filter((i) => i.blocking).length} 项阻断）：${issueText}——` +
        `不在本表的能力章节分类**未定**（${unclassified} 个，不按功能能力处理）；本图不得据此判绿、不得据此给「可请求验收」结论，` +
        "按「旧有效图/更新失败」规则保留上次有效图并显示原因（§3.2／§3.3／§4.4）"
      : table.declared
        ? `能力分类来自设计书「能力分类声明」表（§3.2，2026-09-26 GPT-6 裁定 7）：功能能力 ${caps.length - unclassified - governance} 个、设计/治理章节 ${governance} 个——` +
          "功能全景只含功能能力分组；治理章节不作能力节点、不以「已验证能力」显示、不计入产品能力计数，其稳定 ID 与出处保持可追溯"
        : "设计书里没有「能力分类声明」表：全部 level-2 章节按功能能力处理，并注明「能力分类未声明」（§3.2；代码不硬编码任何项目的章节号）",
  };
}

// ───────────────────────────────── 模型整理结果 ─────────────────────────────────

/** 模型整理结果的**输入形态**（字段全部可选：模型给多少算多少，缺的按缺处理） */
export interface BlueprintProposalInputNode {
  id?: string;
  name?: string;
  kind?: string;
  source_refs?: { kind?: string; path?: string; locator?: string; sha256?: string | null }[];
  related_ids?: string[];
}

export interface BlueprintProposalInputEdge {
  source?: string;
  target?: string;
  kind?: string;
  source_refs?: { kind?: string; path?: string; locator?: string; sha256?: string | null }[];
  certainty?: string;
}

export interface BlueprintProposalInput {
  nodes?: BlueprintProposalInputNode[];
  edges?: BlueprintProposalInputEdge[];
}

/** 规范化后的整理结果（缓存里保存的就是它；下次重建视图直接拿它再合并一次，§4.1） */
export interface BlueprintProposal {
  nodes: BlueprintNode[];
  edges: BlueprintEdge[];
}

const NODE_KINDS: readonly BlueprintNodeKind[] = ["capability", "module", "task", "concept"];
const EDGE_KINDS: readonly BlueprintEdgeKind[] = [
  "task_dependency",
  "task_design_ref",
  "design_interface",
  "implementation_map",
  "model_inference",
];
const REF_KINDS: readonly BlueprintSourceKind[] = ["design_section", "plan_task", "code_module"];

export interface SanitizeResult {
  proposal: BlueprintProposal;
  rejected_fields: string[];
  dropped: { what: string; why: string }[];
}

/**
 * 摘掉模型给的完成色/进度字段（§4.2「模型也不能写颜色当作进度」）。
 * 递归摘：任何层级的 `status/color/progress/done/...` 键一律删掉并如实登记键路径，
 * 不是"忽略不看"——回执里要能看出模型试图写进度（这也是校验层 `status_field_leak` 的前一道闸）。
 */
export function stripStatusKeys(value: unknown, where: string, rejected: string[]): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v, i) => stripStatusKeys(v, `${where}[${i}]`, rejected));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (STATUS_FORBIDDEN_KEYS.includes(k)) {
      rejected.push(`${where}.${k}`);
      continue;
    }
    out[k] = stripStatusKeys(v, `${where}.${k}`, rejected);
  }
  return out;
}

/**
 * 规范化模型整理结果（§4.1 的"程序侧把关"第一道）：
 *   · 摘掉完成色/进度字段；
 *   · 节点 id：已带 `plan:` 前缀的按原样（模型要引用既有节点就得引用真 id），否则按名字生成 `plan:concept:*`；
 *   · kind 不在白名单 → 丢弃并登记；
 *   · 出处只认三种可定位形态（且必须带 path+locator），认不出的引用**丢掉该条**；
 *   · **关系没有可定位出处 → certainty 强制 unverified**（§4.1：新增的无出处关系标待核实）。
 * 这一步不做端点校验（那要等合并后才知道全集），端点检查在 `mergeProposal` 与结构校验里。
 */
export function sanitizeModelProposal(raw: unknown): SanitizeResult {
  const rejected: string[] = [];
  const dropped: { what: string; why: string }[] = [];
  const stripped = stripStatusKeys(raw, "$", rejected);
  const obj = (stripped ?? {}) as BlueprintProposalInput;
  const nodes: BlueprintNode[] = [];
  const edges: BlueprintEdge[] = [];

  const readRefs = (
    rawRefs: BlueprintProposalInputNode["source_refs"],
    owner: string,
  ): BlueprintSourceRef[] => {
    const out: BlueprintSourceRef[] = [];
    for (const r of rawRefs ?? []) {
      const kind = r?.kind;
      const refPath = typeof r?.path === "string" ? r.path.trim() : "";
      const locator = typeof r?.locator === "string" ? r.locator.trim() : "";
      if (!REF_KINDS.includes(kind as BlueprintSourceKind) || refPath === "" || locator === "") {
        dropped.push({ what: `${owner} 的出处`, why: `出处形态不合法（kind/path/locator 缺或不在白名单）：${JSON.stringify(r)}` });
        continue;
      }
      out.push({
        kind: kind as BlueprintSourceKind,
        path: refPath,
        locator,
        sha256: typeof r?.sha256 === "string" && r.sha256 !== "" ? r.sha256 : null,
      });
    }
    return out;
  };

  for (const [i, n] of (obj.nodes ?? []).entries()) {
    const kind = NODE_KINDS.includes(n?.kind as BlueprintNodeKind) ? (n.kind as BlueprintNodeKind) : null;
    if (kind === null) {
      dropped.push({ what: `节点#${i}`, why: `kind 不在白名单（capability/module/task/concept）：${JSON.stringify(n?.kind)}` });
      continue;
    }
    const rawId = typeof n?.id === "string" ? n.id.trim() : "";
    const name = typeof n?.name === "string" ? n.name.trim() : "";
    const id = rawId.startsWith(PLAN_PREFIX) ? rawId : `${PLAN_PREFIX}concept:${stableSlug(name || rawId || `node-${i}`)}`;
    nodes.push({
      id,
      kind,
      name: name === "" ? id : name,
      source_refs: readRefs(n?.source_refs, `节点#${i}(${id})`),
      related_ids: Array.isArray(n?.related_ids) ? n.related_ids.filter((r): r is string => typeof r === "string") : [],
    });
  }

  for (const [i, e] of (obj.edges ?? []).entries()) {
    const source = typeof e?.source === "string" ? e.source.trim() : "";
    const target = typeof e?.target === "string" ? e.target.trim() : "";
    if (source === "" || target === "") {
      dropped.push({ what: `关系#${i}`, why: "缺 source/target" });
      continue;
    }
    const kind = EDGE_KINDS.includes(e?.kind as BlueprintEdgeKind) ? (e.kind as BlueprintEdgeKind) : "model_inference";
    const refs = readRefs(e?.source_refs, `关系#${i}(${source}→${target})`);
    const asked = e?.certainty;
    const certainty: BlueprintCertainty =
      refs.length === 0
        ? "unverified" // 无出处：不管模型自报什么，一律待核实
        : asked === "declared" || asked === "observed" || asked === "inferred"
          ? asked
          : "inferred";
    edges.push({ source, target, kind, source_refs: refs, certainty });
  }

  return { proposal: { nodes, edges }, rejected_fields: [...new Set(rejected)], dropped };
}

/**
 * 把模型整理结果并进确定性派生结果（第二道把关）：
 *   · 节点 id 已存在 → 合并出处/related_ids（模型补充既有节点的出处是合法的）；
 *   · 端点解析不到（模型引用了不存在的节点）→ **丢弃该关系**并登记，不造悬空边。
 */
// ── V08-05：模型来源引用的确定性归一与逐条剔除 ──

/**
 * 定位串的**排版归一**（比较两边用同一口径）：只处理标点与空白，不改字、不补字、不做同义替换。
 *   · 引号（含全角/书名号）/反引号 → 去掉；
 *   · 层级分隔符（`›` `>` `→` `·` `▶` `|`）→ 统一成 ` / `；连续 `/` 与两侧空白同样归一；
 *   · 连续空白 → 一个空格；首尾去空。
 */
export function canonicalLocator(raw: string): string {
  return raw
    .replace(/[`'"“”‘’《》〈〉]/g, "")
    .replace(/\s*[›〉>→▶·|]\s*/g, " / ")
    .replace(/\s*\/\s*/g, " / ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 把一条来源定位串解析到**真实锚点**：精确命中 → 唯一包含命中 → 否则 `null`（认不出）。
 * **歧义一律返回 null**（多个候选谁都不选）：宁可这条不进图，也不猜一个。
 */
export function resolveRefLocator(locator: string, anchors: readonly string[]): string | null {
  const c = canonicalLocator(locator);
  if (c === "") return null;
  const exact = anchors.filter((a) => canonicalLocator(a) === c);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null; // 归一后仍撞车：锚点自己就歧义
  const hit = anchors.filter((a) => {
    const ac = canonicalLocator(a);
    return ac.includes(c) || c.includes(ac);
  });
  return hit.length === 1 ? hit[0] : null;
}

export interface RefNormalizeDrop {
  what: string;
  why: string;
}

export interface RefNormalizeResult {
  proposal: BlueprintProposal;
  /** 被剔除的引用（逐条，含原因） */
  dropped: RefNormalizeDrop[];
  /** 按真实锚点改写过的条数（排版归一 + 唯一包含命中） */
  normalized: number;
  /** 因来源全不可定位而被剔除的**模型新增**节点/关系数（逐条剔除，不整份弃用） */
  dropped_nodes: number;
  dropped_edges: number;
}

/**
 * 模型提案的**确定性归一**（V08-05）：把每条 `source_refs` 解析到真实锚点。
 *   · `path` 与当前源不一致 → 剔除该条（引用了别的文件）；
 *   · 定位串精确/唯一包含命中 → **改写为真实锚点的原文**；
 *   · 歧义或认不出 → 剔除该条；
 *   · **模型新增**的节点/关系：若它**给过**出处但一条都没留下 → 连它一起剔除（“来源不可定位”只剔除该条）；
 *     完全没给出处的条目照旧保留（由校验器标「待核实」，§4.1 的既有口径）。
 */
export function normalizeProposalRefs(proposal: BlueprintProposal, src: BlueprintSources): RefNormalizeResult {
  const dropped: RefNormalizeDrop[] = [];
  let normalized = 0;
  const anchorsOf = (kind: BlueprintSourceKind): string[] =>
    kind === "design_section"
      ? (src.design?.sections ?? []).map((s) => s.path)
      : kind === "plan_task"
        ? (src.plan?.tasks ?? []).map((t) => t.task_id)
        : src.code.modules.map((m) => m.id);
  const sourcePathOf = (kind: BlueprintSourceKind): string | null =>
    kind === "design_section" ? (src.design?.path ?? null) : kind === "plan_task" ? (src.plan?.path ?? null) : null;

  const fixRefs = (refs: BlueprintSourceRef[], owner: string): BlueprintSourceRef[] => {
    const out: BlueprintSourceRef[] = [];
    for (const r of refs) {
      const want = sourcePathOf(r.kind);
      if (want !== null && r.path !== want) {
        dropped.push({ what: `${owner} 的出处`, why: `path=${r.path} 不是本项目${r.kind === "design_section" ? "设计书" : "施工图"}源（应为 ${want}）` });
        continue;
      }
      const hit = resolveRefLocator(r.locator, anchorsOf(r.kind));
      if (hit === null) {
        dropped.push({
          what: `${owner} 的出处`,
          why: `${r.kind} 定位串认不出或有歧义（原文 ${JSON.stringify(r.locator)}）——不进图（§4.1 来源可定位是发布前提）`,
        });
        continue;
      }
      if (hit !== r.locator) {
        normalized += 1;
        out.push({ ...r, locator: hit });
      } else {
        out.push(r);
      }
    }
    return out;
  };

  const nodes: BlueprintNode[] = [];
  let dropped_nodes = 0;
  for (const n of proposal.nodes) {
    const refs = fixRefs(n.source_refs, `节点 ${n.id}`);
    if (n.source_refs.length > 0 && refs.length === 0) {
      dropped_nodes += 1;
      continue;
    }
    nodes.push({ ...n, source_refs: refs });
  }
  const edges: BlueprintEdge[] = [];
  let dropped_edges = 0;
  for (const e of proposal.edges) {
    const refs = fixRefs(e.source_refs, `关系 ${e.source}→${e.target}`);
    if (e.source_refs.length > 0 && refs.length === 0) {
      dropped_edges += 1;
      continue;
    }
    edges.push({ ...e, source_refs: refs });
  }
  if (dropped_nodes > 0 || dropped_edges > 0) {
    const keptIds = new Set(nodes.map((n) => n.id));
    for (const [i, e] of [...edges.entries()].reverse()) {
      if (proposal.nodes.some((n) => n.id === e.source || n.id === e.target) && (!keptIds.has(e.source) || !keptIds.has(e.target))) {
        // 关系端点指向被剔除的模型节点 → 一并剔除（否则合并时会按"端点不存在"丢掉，账目噪音）
        edges.splice(i, 1);
        dropped_edges += 1;
      }
    }
  }
  return { proposal: { nodes, edges }, dropped, normalized, dropped_nodes, dropped_edges };
}

/**
 * 合并模型提案（2026-09-26 GPT-6 裁定 1–2 ＋ R-2/B 类返工，DESIGN §4.1／附录 E.17 **提案线索化**）：
 * 提案**节点与边都只进待审线索层**——模型自报的 certainty、自报的新节点与自报的出处**未经权威原文复算**，
 * 不构成 DESIGN/PLAN 声明：正式节点集、正式节点出处与正式关系只由确定性管线从权威原文与实际路径复算产生。
 *   · 提案边 → `model_leads`：与确定性派生**独立命中**的标 `confirmed_by_derivation`（正式关系由派生管线
 *     产生，提案冗余留痕）；未命中的标 `lead_pending_review`；
 *   · 提案节点 → `model_node_leads`（R-2）：自报的新节点**不进 `bp.nodes`**、给既有节点补的 `source_refs`
 *     **不并入正式节点账**（否则一条编造出处可经证据状态 P5 把正式对象打成 `invalidated`、阻断交付读数）。
 * 线索跨基线继承不升格：缓存复用/继承来的提案同样只是线索；处置随每次派生按当前正式图重算。
 */
export function mergeProposal(base: Blueprint, proposal: BlueprintProposal, limits: BlueprintLimits = BLUEPRINT_LIMITS): Blueprint {
  const byId = new Map(base.nodes.map((n) => [n.id, n]));
  const nodes = base.nodes.map((n) => ({ ...n, related_ids: [...n.related_ids] }));
  /** 正式节点集**只有** base 的那些（R-2：提案节点不进正式集） */
  const index = byId;
  const dropped: { what: string; why: string }[] = [];
  /** 提案**节点侧**的处置账目（与 `dropped` 分开，免得混淆成"关系被丢弃"） */
  const nodeDropped: { what: string; why: string }[] = [];
  // ── R-2/B 类返工（2026-09-26 非作者复审）：提案**节点**同样只留在待审线索层 ──
  // 旧实现两条通道都能让未经权威复算的提案牵动正式图与交付读数：
  //   ① 给既有节点补 `source_refs` 直入节点账 → `refStatusOf`／证据状态 P5 可把正式对象打成
  //      `invalidated`（一条编造出处就能让正式对象变红、交付读数永久 blocked）；
  //   ② 自报 `plan:task:*` 新节点直入 `bp.nodes` → 进交付对象清单 ⇒ 投影查不到 ⇒ `missing` ⇒ 同样阻断。
  // 现在两条通道都只写线索账（`model_node_leads`）：正式节点集与正式节点出处**都不变**。
  const nodeLeads: BlueprintNodeLead[] = (base.model_node_leads ?? []).map((l) => ({
    ...l,
    proposed_source_refs: [...l.proposed_source_refs],
    proposed_related_ids: [...l.proposed_related_ids],
  }));
  const nodeLeadIds = new Set(nodeLeads.map((l) => l.id));
  const newNodeLeads: string[] = [];
  for (const n of proposal.nodes) {
    const existing = byId.get(n.id);
    const target: BlueprintNodeLead["target"] = existing === undefined ? "new_node" : "existing_node";
    const refs = (n.source_refs ?? []).map((r) => ({ ...r }));
    const related = [...(n.related_ids ?? [])];
    if (!nodeLeadIds.has(n.id)) {
      nodeLeadIds.add(n.id);
      newNodeLeads.push(n.id);
      nodeLeads.push({
        id: n.id,
        kind: existing?.kind ?? n.kind,
        name: n.name,
        proposed_source_refs: refs,
        proposed_related_ids: related,
        target,
        disposition: "lead_pending_review",
      });
    }
    nodeDropped.push({
      what: target === "existing_node" ? `节点 ${n.id} 的提案出处` : `节点 ${n.id}`,
      why:
        target === "existing_node"
          ? "未经权威原文复算——只登记为待审线索，**不并入正式节点出处**（R-2／§4.1）"
          : "模型自报的新节点未经权威复算——只登记为待审线索，**不进正式节点集**（R-2／§4.1）",
    });
  }
  // 处置随正式节点集重算：留痕冗余（正式节点本来就有同名出处）才算 confirmed，其余一律待审
  for (const l of nodeLeads) {
    const formal = byId.get(l.id);
    const redundant =
      l.target === "existing_node" &&
      formal !== undefined &&
      l.proposed_source_refs.length > 0 &&
      l.proposed_source_refs.every((r) => formal.source_refs.some((x) => x.kind === r.kind && x.locator === r.locator && x.path === r.path));
    l.disposition = redundant ? "confirmed_by_derivation" : "lead_pending_review";
  }
  // 正式关系集合**不变**（＝确定性派生产物）；提案边只进线索账。
  const edges = [...base.edges];
  const formalKeys = new Set(base.edges.map((e) => `${e.source}|${e.target}|${e.kind}`));
  const leads: BlueprintModelLead[] = (base.model_leads ?? []).map((l) => ({ ...l, source_refs: [...l.source_refs] }));
  const leadKeys = new Set(leads.map((l) => `${l.source}|${l.target}|${l.kind}`));
  let newLeads = 0;
  /** 端点不是正式节点的提案关系数（照旧入线索账，只单独记账说清这些线索的端点不在正式节点集里） */
  let leadsToUnknownEndpoint = 0;
  for (const e of proposal.edges) {
    if (e.source === e.target) {
      dropped.push({ what: `关系 ${e.source}→${e.target}`, why: "自环" });
      continue;
    }
    // R-2：提案关系**一律入线索账**（含端点是模型自报新节点的那些）——线索不是正式边，端点在不在
    // 正式节点集里都不影响"这条提案被如实记下来"；能不能当正式关系仍由确定性派生另算（formalKeys）。
    if (!index.has(e.source) || !index.has(e.target)) leadsToUnknownEndpoint += 1;
    const key = `${e.source}|${e.target}|${e.kind}`;
    if (leadKeys.has(key)) continue; // 同一条线索只记一次（缓存继承/重复提案不产生第二行）
    leadKeys.add(key);
    newLeads += 1;
    leads.push({
      source: e.source,
      target: e.target,
      kind: e.kind,
      model_certainty: e.certainty,
      source_refs: e.source_refs,
      disposition: formalKeys.has(key) ? "confirmed_by_derivation" : "lead_pending_review",
    });
  }
  // 处置随派生刷新：正式边全集一变（新增/消失），既有线索的处置如实重算——
  // 「先前确认的线索若派生侧不再产生该正式边」⇒ 回到待审；反向命中则转确认（不留陈旧处置）。
  for (const l of leads) {
    l.disposition = formalKeys.has(`${l.source}|${l.target}|${l.kind}`) ? "confirmed_by_derivation" : "lead_pending_review";
  }
  // 摘掉模型给的、解析不到真实节点的 related_ids（构造上不加悬空引用；如实登记条数）
  let droppedRelated = 0;
  for (const n of nodes) {
    const before = n.related_ids.length;
    n.related_ids = [...new Set(n.related_ids)].filter((r) => index.has(r) && r !== n.id);
    droppedRelated += before - n.related_ids.length;
  }

  const omitted = [...base.omitted];
  if (leadsToUnknownEndpoint > 0) {
    omitted.push({
      kind: "model_lead_unknown_endpoint",
      detail: `${leadsToUnknownEndpoint} 条模型关系线索的端点不在正式节点集里（多为模型自报的新节点）：线索照实记录，但不可能成为正式关系（R-2／§4.1）`,
      count: leadsToUnknownEndpoint,
    });
  }
  if (dropped.length > 0) {
    omitted.push({ kind: "model_edge_dropped", detail: `模型关系被丢弃 ${dropped.length} 条（自环）`, count: dropped.length });
  }
  if (droppedRelated > 0) {
    omitted.push({ kind: "related_id_dropped", detail: `模型给的相关引用被丢弃 ${droppedRelated} 条（指向不存在的节点）`, count: droppedRelated });
  }
  if (newNodeLeads.length > 0) {
    omitted.push({
      kind: "model_node_lead_recorded",
      detail:
        `模型提案的 ${newNodeLeads.length} 个节点（${newNodeLeads.slice(0, 6).join("、")}${newNodeLeads.length > 6 ? "…" : ""}）记为**节点侧待审线索**：` +
        "模型自报的新节点不进正式节点集、给既有节点补的出处不并入正式节点账——未经权威原文复算，不参与交付读数（R-2／§4.1／附录 E.17）",
      count: newNodeLeads.length,
    });
  }
  if (newLeads > 0) {
    const confirmed = leads.filter((l) => l.disposition === "confirmed_by_derivation").length;
    omitted.push({
      kind: "model_lead_recorded",
      detail:
        `模型提案 ${newLeads} 条记为**待审线索**（累计 ${leads.length} 条，其中与确定性派生独立命中 ${confirmed} 条）：` +
        "提案自报 certainty 不构成 DESIGN/PLAN 声明，不进正式关系、能力成员、二级派生、绿态与交付读数（§4.1／附录 E.17）",
      count: newLeads,
    });
  }

  const receipt = base.model_receipt;
  const next = assembleBlueprintFromExisting(base, nodes, edges, omitted, limits);
  return {
    ...next,
    model_leads: leads,
    model_node_leads: nodeLeads,
    model_receipt: receipt === null ? null : { ...receipt, proposal, dropped: [...receipt.dropped, ...dropped, ...nodeDropped] },
  };
}

/** 重新收口（合并模型结果后再算一次 related_ids / 上限 / 覆盖账目），输入侧只换 nodes/edges/omitted */
function assembleBlueprintFromExisting(
  base: Blueprint,
  nodes: BlueprintNode[],
  edges: BlueprintEdge[],
  omitted: BlueprintOmission[],
  limits: BlueprintLimits,
): Blueprint {
  const related = new Map<string, Set<string>>();
  const add = (a: string, b: string): void => {
    if (a === b) return;
    if (!related.has(a)) related.set(a, new Set());
    related.get(a)!.add(b);
  };
  for (const e of edges) {
    add(e.source, e.target);
    add(e.target, e.source);
  }
  for (const n of nodes) for (const r of n.related_ids) add(n.id, r);

  const order: Record<BlueprintNodeKind, number> = { capability: 0, module: 1, task: 2, concept: 3 };
  const sorted = [...nodes].sort((a, b) => order[a.kind] - order[b.kind] || a.id.localeCompare(b.id));
  const nodesTotal = sorted.length;
  let kept = sorted;
  const omissions = [...omitted];
  if (nodesTotal > limits.max_nodes) {
    const droppedCount = sorted.length - limits.max_nodes;
    kept = sorted.slice(0, limits.max_nodes);
    omissions.push({ kind: "node_cap", detail: `超出规划图节点上限 ${limits.max_nodes}：${droppedCount} 个节点未收录（含模型新增）`, count: droppedCount });
  }
  const keptIds = new Set(kept.map((n) => n.id));
  const edgesIn = edges.filter((e) => keptIds.has(e.source) && keptIds.has(e.target));
  const edgesTotal = edges.length;
  let keptEdges = edgesIn;
  if (edgesIn.length > limits.max_edges) {
    const droppedCount = edgesIn.length - limits.max_edges;
    keptEdges = edgesIn.slice(0, limits.max_edges);
    omissions.push({ kind: "edge_cap", detail: `超出规划图关系上限 ${limits.max_edges}：${droppedCount} 条关系未收录`, count: droppedCount });
  }
  const finalNodes = kept.map((n) => ({
    ...n,
    related_ids: [...(related.get(n.id) ?? new Set<string>())].filter((r) => keptIds.has(r)).sort(),
  }));

  const locators = (kind: BlueprintSourceKind): Set<string> => {
    const out = new Set<string>();
    for (const n of finalNodes) for (const r of n.source_refs) if (r.kind === kind) out.add(r.locator);
    for (const e of keptEdges) for (const r of e.source_refs) if (r.kind === kind) out.add(r.locator);
    return out;
  };
  const designLocators = locators("design_section");
  const planLocators = locators("plan_task");
  const codeLinked = codeLinkageOf({ nodes: finalNodes, edges: keptEdges }).linked_module_ids;
  const prev = base.coverage;
  const designUnmapped = prev.design_sections.unmapped.filter((u) => !designLocators.has(u.key));
  const planUnmapped = prev.plan_tasks.unmapped.filter((u) => !planLocators.has(u.key));
  const codeUnmapped = prev.code_modules.unmapped.filter((u) => !codeLinked.has(u.key));

  return {
    ...base,
    nodes: finalNodes,
    edges: keptEdges,
    omitted: omissions,
    coverage: {
      ...prev,
      design_sections: { total: prev.design_sections.total, mapped: prev.design_sections.total - designUnmapped.length, unmapped: designUnmapped },
      plan_tasks: { total: prev.plan_tasks.total, mapped: prev.plan_tasks.total - planUnmapped.length, unmapped: planUnmapped },
      code_modules: { total: prev.code_modules.total, mapped: prev.code_modules.total - codeUnmapped.length, unmapped: codeUnmapped },
      nodes_total: nodesTotal,
      nodes_kept: finalNodes.length,
      edges_total: edgesTotal,
      edges_kept: keptEdges.length,
    },
  };
}

// ───────────────────────────────── 模型提示词 ─────────────────────────────────

/**
 * 整理范围（补修包 E）：本轮**需要整理**的来源段。`focus` 里没有的段只给稳定 ID 索引，
 * 不给条目清单——"只处理受影响范围"落在输入上（未受影响段不重整理，其既有结果由缓存继承）。
 */
export interface BlueprintMessageScope {
  /** design = 设计段；plan = 施工段 */
  focus: string[];
}

/**
 * 整理用的提示词（§4.1「输入为同一基线的设计/施工原文与稳定 ID 索引」）。
 * 三条硬口径写进系统提示，且**程序侧还会再摘一遍**（提示词不是护栏，`stripStatusKeys` 才是）：
 *   ① 只整理，不发明需求、不改架构、不删代码；
 *   ② 不输出进度色/任务完成状态；
 *   ③ 每条关系都要给出处（设计章节标题路径 / 卡号 / 模块 id），给不出就留空（程序会标待核实）。
 * `scope` 只在自动链的分段整理里传（补修包 E）；不传 = 全量整理，锚点与既有路径逐字相同。
 */
export function buildBlueprintMessages(src: BlueprintSources, base: Blueprint, scope?: BlueprintMessageScope): FlashMessage[] {
  const system = [
    "你是软件项目的「图纸整理员」。输入是同一个基线的设计书章节索引、施工图任务定义、静态解析出的模块清单，",
    "以及程序已经派生好的规划图骨架。你的任务只有一件：补全**能力 / 模块 / 关系**及其**出处**。",
    "严格只输出一行 JSON，不要任何解说文字，格式：",
    '{"nodes":[{"id":"可省略","name":"人话名","kind":"capability|module|task|concept","source_refs":[{"kind":"design_section|plan_task|code_module","path":"项目根内相对路径","locator":"章节标题路径/卡号/模块 id","sha256":"可省略"}],"related_ids":["已存在的节点 id"]}],',
    '"edges":[{"source":"节点 id","target":"节点 id","kind":"task_dependency|task_design_ref|design_interface|implementation_map|model_inference","source_refs":[...],"certainty":"declared|observed|inferred"}]}',
    "硬红线：① 不发明需求、不修改架构决定、不删除任何代码或模块；② **不输出完成色/进度/任务状态字段**（status/color/progress/done 一律不许出现）；",
    "③ 每条关系都要可定位的出处；给不出出处的就留空 source_refs，程序会把它标成「待核实」；④ 引用已存在的节点时用它的原 id，不要另造同名节点。",
  ].join("");
  if (scope !== undefined) {
    const focus = scope.focus;
    const scoped: Record<string, unknown> = { 本轮需整理范围: focus };
    if (focus.includes("design")) {
      scoped.设计章节 = src.design?.sections.map((s) => ({ path: src.design?.path, locator: s.path })) ?? [];
      scoped.设计声明模块 = src.declared_modules.map((m) => ({ name: m.name, section: m.section_path }));
    } else {
      scoped.未整理范围索引_设计 = { 章节路径: src.design?.sections.map((s) => s.path) ?? [] };
    }
    if (focus.includes("plan")) {
      scoped.施工任务 = src.plan?.tasks.map((t) => ({ path: src.plan?.path, locator: t.task_id, goal: t.goal })) ?? [];
    } else {
      scoped.未整理范围索引_施工 = { 卡号: src.plan?.tasks.map((t) => t.task_id) ?? [] };
    }
    scoped.代码模块 = src.code.modules.map((m) => ({ locator: m.id, path: m.path }));
    scoped.已有节点 = base.nodes.map((n) => ({ id: n.id, kind: n.kind, name: n.name }));
    scoped.已有关系 = base.edges.map((e) => ({ source: e.source, target: e.target, kind: e.kind }));
    scoped.本条要求 = "只整理「本轮需整理范围」里的段；未整理范围只作为引用锚点（可引用其节点 id），不要替它重写条目。";
    return [
      { role: "system", content: system },
      { role: "user", content: JSON.stringify(scoped) },
    ];
  }
  const anchors = {
    设计章节: src.design?.sections.map((s) => ({ path: src.design?.path, locator: s.path })) ?? [],
    施工任务: src.plan?.tasks.map((t) => ({ path: src.plan?.path, locator: t.task_id, goal: t.goal })) ?? [],
    代码模块: src.code.modules.map((m) => ({ locator: m.id, path: m.path })),
    已有节点: base.nodes.map((n) => ({ id: n.id, kind: n.kind, name: n.name })),
    已有关系: base.edges.map((e) => ({ source: e.source, target: e.target, kind: e.kind })),
  };
  return [
    { role: "system", content: system },
    { role: "user", content: JSON.stringify(anchors) },
  ];
}

/** 模型整理调用入口（可注入，验证脚本用它做确定性夹具，不依赖真网关） */
export type BlueprintChatFn = (messages: FlashMessage[]) => Promise<{ text: string; json: unknown | null; error: string | null }>;

/** 缺省模型入口：走 flash.ts 的**新增**结构化口（既有 chatStreamEvents 的语义一个字节没动） */
export const defaultBlueprintChat: BlueprintChatFn = async (messages) => chatStructuredJson(messages);

// ───────────────────────────────── IO 与发布 ─────────────────────────────────

export const blueprintDir = (projectId: string, dataDir?: string): string =>
  path.join(workstationDir(projectId, dataDir), ARCH_SUBDIR);
export const blueprintPath = (projectId: string, dataDir?: string): string =>
  path.join(blueprintDir(projectId, dataDir), BLUEPRINT_FILE);
export const blueprintReceiptPath = (projectId: string, dataDir?: string): string =>
  path.join(blueprintDir(projectId, dataDir), BLUEPRINT_RECEIPT_FILE);

/** 原子写 JSON（临时文件 + rename，与 reconcile/workstation 同一惯例：主文件永不错损）。
 *  补修包 E 的分段缓存/状态也走这里（同一落盘协议，不另写一套）。 */
export function writeJsonAtomic(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);
}

/** 读已发布的规划图；没有/损坏都返回 null（读路径不为坏文件炸，坏就如实当"没有图"） */
export function readBlueprint(projectId: string, dataDir?: string): Blueprint | null {
  const file = blueprintPath(projectId, dataDir);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Blueprint;
  } catch {
    return null;
  }
}

/** 读最近一次派生尝试的回执（成功与失败都留；没有返回 null） */
export function readBlueprintReceipt(projectId: string, dataDir?: string): BlueprintReceipt | null {
  const file = blueprintReceiptPath(projectId, dataDir);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as BlueprintReceipt;
  } catch {
    return null;
  }
}

/** 校验上下文（与派生用同一份读盘结果，避免"校验读到 A、派生读到 B"） */
export function blueprintContextOf(src: BlueprintSources): BlueprintContext {
  return {
    active_baseline_id: src.baseline_id,
    design: src.design === null ? null : { path: src.design.path, content_sha256: src.design.content_sha256, sections: src.design.sections.map((s) => ({ path: s.path, sha256: s.sha256 })) },
    plan:
      src.plan === null
        ? null
        : {
            path: src.plan.path,
            definition_sha256: src.plan.definition_sha256,
            task_ids: src.plan.tasks.map((t) => t.task_id),
            // 单卡定义哈希（2026-09-27）：plan_task 来源按本卡哈希判 stale，改别的卡不再连带失效。
            // 与写侧 planRef 用同一份 `shared/planCardHash.ts` 实现。
            task_hashes: Object.fromEntries(src.plan.tasks.map((t) => [t.task_id, taskDefinitionHash(t)])),
          },
    code: { modules: src.code.modules.map((m) => ({ id: m.id, path: m.path })) },
    limits: BLUEPRINT_LIMITS,
  };
}

function cacheKeysOf(src: BlueprintSources, semantic: boolean): BlueprintBasedOn {
  const model_key = [
    src.baseline_id ?? "no-baseline",
    src.design?.content_sha256 ?? "no-design",
    src.plan?.definition_sha256 ?? "no-plan",
    BLUEPRINT_GENERATOR_VERSION,
    semantic ? "sem" : "det",
  ].join("|");
  const codeFingerprint = sha256(JSON.stringify([src.code.modules.map((m) => [m.id, m.path, m.file_count]), src.repo_root_files]));
  return {
    model_key,
    full_key: `${model_key}|${codeFingerprint}`,
    design_content_sha256: src.design?.content_sha256 ?? null,
    plan_definition_sha256: src.plan?.definition_sha256 ?? null,
    semantic,
  };
}

/** 缓存键的**只读**出口（补修包 E 的自动链要拿"当前输入的确定性缓存键"与已发布的图比对；
 *  口径与派生内部完全同一份实现，避免自动链另写一套键算法导致对不上）。 */
export function blueprintCacheKeysOf(src: BlueprintSources, semantic: boolean): BlueprintBasedOn {
  return cacheKeysOf(src, semantic);
}

/** 一次派生尝试的回执（落 `.工作台/arch/blueprint-receipt.json`；失败时旧图还在，原因从这份读） */
export interface BlueprintReceipt {
  version: 1;
  trigger: string;
  attempted_at: string;
  cache_key: string;
  baseline_id: string | null;
  published: boolean;
  reason: string | null;
  stale_discarded: boolean;
  model_calls: number;
  model: { called: boolean; ok: boolean; error: string | null; rejected_fields: string[]; dropped: { what: string; why: string }[] } | null;
  validation: { ok: boolean; publishable: boolean; blocking: BlueprintFinding[]; review: BlueprintFinding[] } | null;
  kept_previous: boolean;
}

export interface BlueprintRebuildOptions {
  dataDir?: string;
  /** 触发来源：manual / baseline_activated / parse_changed / http …（进回执，便于回溯） */
  trigger?: string;
  /** 是否让模型做语义整理（§4.4：任务/验证变化只重算状态，缺省零模型） */
  semantic?: boolean;
  /** 注入的模型入口（缺省 = flash.ts 的新增结构化口） */
  chat?: BlueprintChatFn;
  /** 强制重建（忽略缓存；用于"手动重试只重做失败派生阶段"） */
  force?: boolean;
  /** **已算好的整理结果**（补修包 E 的自动链把分段整理的合并结果传进来）：给了就直接用，
   *  **本轮不再调模型**。`null` = 本轮没有可用的整理结果（照确定性派生发布）。 */
  proposal?: BlueprintProposal | null;
  /** 本轮语义整理**真正打出去的模型调用次数**（进回执的 model_calls；自动链如实传、复用缓存时传 0） */
  model_calls?: number;
  /** 本轮语义整理的分段账目（进 `based_on.semantic_scopes` 与模型回执，供"回执可查"） */
  semantic_note?: { scopes: BlueprintSemanticScopeNote[]; note: string } | null;
  /** 模型整理结果落地回调（显式 semantic:true 路径用它刷新自动链的分段缓存 → 自动链不必重复调用）。
   *  只在**本函数自己调了模型**时触发；失败也照触发（失败账目同样要落地）。 */
  on_semantic?: (info: {
    proposal: BlueprintProposal | null;
    ok: boolean;
    error: string | null;
    rejected_fields: string[];
    dropped: { what: string; why: string }[];
    raw_sha256: string | null;
    raw_excerpt: string | null;
  }) => void;
}

export interface BlueprintRebuildResult {
  /** 最终有效的规划图（发布成功 = 本次结果；失败/过时 = 上次那份；从来没有 = null） */
  blueprint: Blueprint | null;
  /** 本次是否真跑了一遍派生（false = 完整缓存命中，一个字节都没重算） */
  rebuilt: boolean;
  model_calls: number;
  cache_key: string;
  publish: { published: boolean; reason: string | null };
  /** 过时响应被丢弃（不覆盖新结果） */
  stale_discarded: boolean;
  validation: BlueprintValidation | null;
  findings: BlueprintFinding[];
  /** 失败/过时时保留了上次发布的那份（§4.4「失败保留上次有效图并显示原因」） */
  kept_previous: boolean;
  receipt: BlueprintReceipt;
}

/** 每项目的派生 epoch（同项目的新一次派生会作废尚未落地的旧响应，§4.4「过时结果丢弃」） */
const inFlight = new Map<string, number>();

/**
 * 有效基线触发 + 程序校验 + 发布（§4.4 的主入口）。整个流程分四步，每一步的失败语义都不同：
 *
 *   ① **缓存判定**：完整缓存键（模型段 + 代码指纹）一致且未 force → 直接复用已发布的那份
 *      （`rebuilt:false, model_calls:0`）。任务状态/进度/勾选位不在键里，所以**纯任务状态变化零模型重画**。
 *   ② **模型段复用**：模型段键一致但代码指纹变了 → 重算确定性派生层、**复用缓存里的整理结果**，
 *      不重调模型（§4.1：可基于已保存的整理结果重建视图）。
 *   ③ **语义整理（可选）**：跑模型；模型失败 / 输出不是 JSON → 不发布、保留旧图、把原因写进回执。
 *   ④ **程序校验与发布**：结构校验通过且没有未处理的基线冲突才落盘；发布前再核一次缓存键与 epoch，
 *      **对不上就丢弃本次结果**（过时响应不覆盖新结果）。
 *
 * 本函数**从不抛**模型/校验类错误（触发它的是"有效基线激活"这类正常流程，不能被派生拖垮）；
 * 读盘层面的硬错误（项目不存在、图纸文件坏）照旧抛。
 */
export async function rebuildBlueprint(
  projectId: string,
  opts: BlueprintRebuildOptions = {},
): Promise<BlueprintRebuildResult> {
  const semantic = opts.semantic === true;
  const trigger = opts.trigger ?? "manual";
  /** 调用方已经算好了整理结果（自动链的分段整理）：本轮不调模型，直接进校验/发布 */
  const provided = opts.proposal !== undefined;
  const src = readBlueprintSources(projectId, opts.dataDir);
  const based_on: BlueprintBasedOn = {
    ...cacheKeysOf(src, semantic),
    // 只有自动链/显式路径带了分段账目才写这个字段：既有路径的产物形状一个字节不变
    ...(opts.semantic_note === undefined || opts.semantic_note === null
      ? {}
      : { semantic_scopes: opts.semantic_note.scopes.map((s) => ({ scope: s.scope, key: s.key })) }),
  };
  const previous = readBlueprint(projectId, opts.dataDir);

  const baseReceipt: BlueprintReceipt = {
    version: 1,
    trigger,
    attempted_at: nowIso(),
    cache_key: based_on.full_key,
    baseline_id: src.baseline_id,
    published: false,
    reason: null,
    stale_discarded: false,
    model_calls: 0,
    model: null,
    validation: null,
    kept_previous: false,
  };

  // ① 完整缓存命中：一个字节都不重算（§4.4 增量刷新）
  if (!opts.force && previous !== null && previous.based_on?.full_key === based_on.full_key && previous.publish.published) {
    const receipt: BlueprintReceipt = { ...baseReceipt, published: true, reason: "cache_hit", kept_previous: true };
    writeJsonAtomic(blueprintReceiptPath(projectId, opts.dataDir), receipt);
    return {
      blueprint: previous,
      rebuilt: false,
      model_calls: 0,
      cache_key: based_on.full_key,
      publish: { published: true, reason: "cache_hit" },
      stale_discarded: false,
      validation: null,
      findings: [],
      kept_previous: true,
      receipt,
    };
  }

  // ② 模型段命中 → 复用缓存里的整理结果，不重调模型
  const reuseProposal =
    !opts.force && !provided && previous !== null && previous.based_on?.model_key === based_on.model_key
      ? previous.model_receipt?.proposal ?? null
      : null;
  const epoch = (inFlight.get(projectId) ?? 0) + 1;
  inFlight.set(projectId, epoch);

  let modelCalls = provided ? (opts.model_calls ?? 0) : 0;
  let modelReceipt: BlueprintModelReceipt | null = provided
    ? // 自动链给的结果：本轮可能一次没调（复用缓存），如实按调用次数标 called
      opts.proposal === null || opts.proposal === undefined
      ? null
      : {
          called: modelCalls > 0,
          ok: true,
          model: null,
          raw_sha256: null,
          raw_excerpt: null,
          error: null,
          rejected_fields: [],
          dropped: [],
          proposal: opts.proposal,
          scopes: opts.semantic_note?.scopes ?? null,
        }
    : previous !== null && reuseProposal !== null
      ? previous.model_receipt
      : null;
  let proposal: BlueprintProposal | null = provided ? (opts.proposal ?? null) : reuseProposal;
  let modelError: string | null = null;

  // ③ 语义整理（可选）。模型失败 = 保留旧图 + 留下原因，绝不半途覆盖
  if (semantic && !provided && proposal === null) {
    const base = deriveBlueprint(src, { based_on, proposal: null, model_receipt: null });
    const chat = opts.chat ?? defaultBlueprintChat;
    modelCalls = 1;
    try {
      const out = await chat(buildBlueprintMessages(src, base));
      if (out.error !== null || out.json === null) {
        modelError = out.error ?? "模型输出里没有 JSON";
        modelReceipt = {
          called: true,
          ok: false,
          model: null,
          raw_sha256: sha256(out.text),
          raw_excerpt: out.text.slice(0, MODEL_RAW_EXCERPT_MAX),
          error: modelError,
          rejected_fields: [],
          dropped: [],
          proposal: null,
        };
      } else {
        const s = sanitizeModelProposal(out.json);
        modelReceipt = {
          called: true,
          ok: true,
          model: null,
          raw_sha256: sha256(out.text),
          raw_excerpt: out.text.slice(0, MODEL_RAW_EXCERPT_MAX),
          error: null,
          rejected_fields: s.rejected_fields,
          dropped: s.dropped,
          proposal: s.proposal,
        };
        proposal = s.proposal;
      }
    } catch (e) {
      modelError = (e as Error).message;
      modelReceipt = {
        called: true,
        ok: false,
        model: null,
        raw_sha256: null,
        raw_excerpt: null,
        error: modelError,
        rejected_fields: [],
        dropped: [],
        proposal: null,
      };
    }
    // 结果落地回调（显式路径刷新自动链的分段缓存 → 自动链下次不必重复调用，§4.4「重复事件合并」）
    try {
      opts.on_semantic?.({
        proposal: modelReceipt?.proposal ?? null,
        ok: modelReceipt?.ok === true,
        error: modelError,
        rejected_fields: modelReceipt?.rejected_fields ?? [],
        dropped: modelReceipt?.dropped ?? [],
        raw_sha256: modelReceipt?.raw_sha256 ?? null,
        raw_excerpt: modelReceipt?.raw_excerpt ?? null,
      });
    } catch {
      // 回调是"顺带落地"，坏回调不能把派生流程拖垮（回执已经写清本轮结果）
    }
    if (modelError !== null) {
      const reason = `模型整理失败：${modelError}`;
      const receipt: BlueprintReceipt = {
        ...baseReceipt,
        reason,
        model_calls: modelCalls,
        model: { called: true, ok: false, error: modelError, rejected_fields: [], dropped: [] },
        kept_previous: previous !== null,
      };
      writeJsonAtomic(blueprintReceiptPath(projectId, opts.dataDir), receipt);
      return {
        blueprint: previous,
        rebuilt: false,
        model_calls: modelCalls,
        cache_key: based_on.full_key,
        publish: { published: false, reason },
        stale_discarded: false,
        validation: null,
        findings: [],
        kept_previous: previous !== null,
        receipt,
      };
    }
  }

  // ④ 派生 + 校验 + 发布
  // C016：派生结果**就是**要校验/发布的图——不再从旧 blueprint.json 携带/重放任何私有编辑账
  // （旧账若存在，由权威源覆盖：被私删的源节点随重派生复活；合法删除/拆并只能在源修订后发生）。
  const derived = deriveBlueprint(src, { based_on, proposal, model_receipt: modelReceipt });
  const validation = validateBlueprint(derived, blueprintContextOf(src));
  const findings = [...validation.blocking, ...validation.review];

  if (!validation.publishable) {
    const first = validation.blocking[0];
    const reason = first === undefined ? "结构校验未通过" : `${first.code}：${first.detail}`;
    // kept_previous 与模型失败/过时丢弃两分支同口径（F-07，2026-09-21 收口审计）：
    // 本分支同样没动 blueprint.json、同样返回 previous——旧图还在就如实说还在
    const receipt: BlueprintReceipt = {
      ...baseReceipt,
      reason,
      model_calls: modelCalls,
      model: modelReceipt === null ? null : { called: modelReceipt.called, ok: modelReceipt.ok, error: modelReceipt.error, rejected_fields: modelReceipt.rejected_fields, dropped: modelReceipt.dropped },
      validation: { ok: validation.ok, publishable: validation.publishable, blocking: validation.blocking, review: validation.review },
      kept_previous: previous !== null,
    };
    writeJsonAtomic(blueprintReceiptPath(projectId, opts.dataDir), receipt);
    return {
      blueprint: previous,
      rebuilt: true,
      model_calls: modelCalls,
      cache_key: based_on.full_key,
      publish: { published: false, reason },
      stale_discarded: false,
      validation,
      findings,
      kept_previous: previous !== null,
      receipt,
    };
  }

  // 过时把关：期间有更新的派生开跑，或输入已变 → 本次结果作废（不覆盖新图）
  const stale = inFlight.get(projectId) !== epoch;
  const nowKey = cacheKeysOf(readBlueprintSources(projectId, opts.dataDir), semantic).full_key;
  if (stale || nowKey !== based_on.full_key) {
    const reason = stale
      ? "过时响应：期间有更新的派生已开跑，本次结果丢弃（不覆盖较新结果）"
      : `过时响应：源在派生期间已变（${based_on.full_key.slice(0, 12)}… → ${nowKey.slice(0, 12)}…），本次结果丢弃`;
    const receipt: BlueprintReceipt = {
      ...baseReceipt,
      reason,
      stale_discarded: true,
      model_calls: modelCalls,
      validation: { ok: validation.ok, publishable: validation.publishable, blocking: validation.blocking, review: validation.review },
      kept_previous: true,
    };
    writeJsonAtomic(blueprintReceiptPath(projectId, opts.dataDir), receipt);
    return {
      blueprint: previous,
      rebuilt: false,
      model_calls: modelCalls,
      cache_key: based_on.full_key,
      publish: { published: false, reason },
      stale_discarded: true,
      validation,
      findings,
      kept_previous: true,
      receipt,
    };
  }

  const published: Blueprint = {
    ...derived,
    publish: { published: true, reason: null, validated_at: nowIso() },
  };
  writeJsonAtomic(blueprintPath(projectId, opts.dataDir), published);
  const receipt: BlueprintReceipt = {
    ...baseReceipt,
    published: true,
    reason: null,
    model_calls: modelCalls,
    model: modelReceipt === null ? null : { called: modelReceipt.called, ok: modelReceipt.ok, error: modelReceipt.error, rejected_fields: modelReceipt.rejected_fields, dropped: modelReceipt.dropped },
    validation: { ok: validation.ok, publishable: validation.publishable, blocking: validation.blocking, review: validation.review },
    kept_previous: false,
  };
  writeJsonAtomic(blueprintReceiptPath(projectId, opts.dataDir), receipt);
  return {
    blueprint: published,
    rebuilt: true,
    model_calls: modelCalls,
    cache_key: based_on.full_key,
    publish: { published: true, reason: null },
    stale_discarded: false,
    validation,
    findings,
    kept_previous: false,
    receipt,
  };
}

/**
 * 触发式重建（**同步返回、异步执行**，供"有效基线激活"这类正常流程调用，§4.4）。
 * 为什么不让触发方 await：激活基线是主流程，派生是它的派生动作——**派生失败绝不能把激活拖回退**
 * （激活已经只追加地写进 baselines.jsonl 了）。失败只留回执（`.工作台/arch/blueprint-receipt.json`），
 * 调用方要等结果就用 `rebuildBlueprint`。
 */
export function triggerBlueprintRebuild(projectId: string, opts: BlueprintRebuildOptions = {}): void {
  void rebuildBlueprint(projectId, opts).catch(() => {
    // 回执已在 rebuildBlueprint 内部尽量落盘；这里连读盘硬错误都吞掉（触发方是主流程，不能被拖垮）
  });
}

/** 草稿规划图：`publish.published` 恒为 false，并带 `draft:true` 让调用方一眼分清"草稿 vs 已发布" */
export type BlueprintDraft = Blueprint & { draft: true };

export interface BlueprintDraftResult {
  blueprint: BlueprintDraft;
  validation: BlueprintValidation;
  /** 不可发布的首个 blocking 原因（没有 blocking 时为 null——草稿仍是草稿，不因校验通过就升格） */
  reason: string | null;
}

/**
 * 草稿规划图（只读、零写盘、零模型；DESIGN.md §3.2「未审定方案可预览，但明确标"草稿图"」）。
 *
 * 为什么要有它：项目还没有**已发布**的规划图（无生效基线 / 从未派生过）时，读口此前只回
 * `blueprint:{exists:false}`，主界面就是一片空白——图数据其实派得出来，用户却看不到，
 * "未审定方案可预览"成了死条文（2026-09-22 实测：真实项目派生 37 节点 / 14 边，界面空图）。
 *
 * 与 `rebuildBlueprint` 的边界（**不改发布门禁**）：
 *   · **不写任何文件**：不落 `blueprint.json`，连 `blueprint-receipt.json` 都不碰——
 *     只读入口不产生写盘副作用（与 Q18 对 layout GET 的口径一致）；
 *   · 产出恒为 `publish.published:false` + `draft:true`，结构校验的 blocking（如 `baseline_missing`）
 *     原样进 `reason`/`validation`，**不当作可施工的有效图**，也不冒充"已发布"；
 *   · **不调模型**（确定性派生）：草稿不值得烧模型调用，也不该让 GET 出网；
 *   · 节点为空时返回 `null`（空草稿没有意义，调用方按"无草稿"如实表达）。
 *
 * 发布门禁本身一个字没动：能不能落成正式图仍然只由 `rebuildBlueprint`（POST 路径）按
 * 基线 + 结构校验判定。
 */
export function draftBlueprintOf(
  projectId: string,
  opts: { dataDir?: string } = {},
): BlueprintDraftResult | null {
  const src = readBlueprintSources(projectId, opts.dataDir);
  const derived = deriveBlueprint(src, { based_on: cacheKeysOf(src, false), proposal: null, model_receipt: null });
  if (derived.nodes.length === 0) return null;
  const validation = validateBlueprint(derived, blueprintContextOf(src));
  const blocking = validation.blocking[0] ?? null;
  return {
    blueprint: {
      ...derived,
      publish: { published: false, reason: blocking?.detail ?? null, validated_at: null },
      draft: true,
    },
    validation,
    reason: blocking === null ? null : `${blocking.code}：${blocking.detail}`,
  };
}

// ───────────────────────────────── 视图合成 ─────────────────────────────────
/**
 * 规划 ↔ 实现对账的项目级读口（DESIGN §4.5）：读**已发布**的规划图 + 静态模块清单，
 * 产出"待建（规划有代码没有）"/"待归属（代码有规划没有）"/稳定映射三段。
 * 这是 A5 之外的第二类对账（A5 按人话名模糊匹配给旧图标黄；这条按**显式来源引用**精确对账），
 * 但两者的产物都只是**信号**，都不阻断任何流程，也都不写 reconcile-last.json。
 * 还没有发布过规划图时返回 null（调用方按"无规划图"如实表达，不拿空集冒充）。
 */
export function planVsCode(projectId: string, opts: { dataDir?: string } = {}): PlanCodeReconcile | null {
  const bp = readBlueprint(projectId, opts.dataDir);
  if (bp === null) return null;
  const project = getProject(projectId, opts.dataDir);
  if (!project) throw new WsError("PROJECT_NOT_FOUND", `项目不存在: ${projectId}`);
  const { exists, arch } = readModules(projectId, opts.dataDir);
  const names = readNames(project.path);
  return reconcilePlanWithCodeInputs(
    bp,
    exists && arch ? arch.modules.map((m) => ({ id: m.id, path: m.path })) : [],
    names.entries as Record<string, { name: string } | undefined>,
  );
}

/** 规划层 → 共用数据层的结构化入参（§4.7：三视图按稳定 ID 关联，不各自造一套节点） */
export function planningLayerInput(bp: Blueprint): PlanLayerInput {
  const codeOf = new Map<string, string[]>();
  for (const n of bp.nodes) {
    const ids = n.source_refs.filter((r) => r.kind === "code_module").map((r) => r.locator);
    codeOf.set(n.id, ids);
  }
  // 实现映射关系也带 code_module 出处：把两端靠它接起来（规划对象 ↔ 实测模块）
  const nodes: PlanLayerNode[] = bp.nodes.map((n) => ({
    id: n.id,
    name: n.name,
    kind: n.kind,
    code_module_ids: codeOf.get(n.id) ?? [],
  }));
  const edges: PlanLayerEdge[] = bp.edges.map((e) => ({ source: e.source, target: e.target, kind: e.kind, certainty: e.certainty }));
  return { baseline_id: bp.baseline_id, nodes, edges };
}

/**
 * 把规划层并进**旧图**的共用数据层（唯一合并点，§3.2 / §4.1）。
 * 旧图（静态解析 + 聊天补全）的原写口与读口一个字节都不变：本函数只做"读两份 + 合并一份"，
 * 未跑过静态解析（空仓）时旧侧为空 → 合成结果就是纯规划图（空仓仍有规划图，§3.2）。
 */
export function viewGraphWithPlan(
  projectId: string,
  opts: { dataDir?: string; limits?: SharedLimits } = {},
): { graph: SharedGraph; blueprint: Blueprint | null; baseline_id: string | null } {
  const bp = readBlueprint(projectId, opts.dataDir);
  const base = buildSharedGraph(projectId, { dataDir: opts.dataDir, limits: opts.limits });
  // 未跑过静态解析（空仓）时上游给 {exists:false}：这里用共用层自己做一份**空图**顶住——
  // 上限/口径仍从共用层取（不另写一套数值），节点边为空而已，不影响规划层并入。
  const graph = base.exists && base.graph !== undefined ? base.graph : buildSharedGraphFrom([], {}, new Map(), {}, null);
  if (bp === null) return { graph, blueprint: null, baseline_id: null };
  return { graph: mergePlanningLayer(graph, planningLayerInput(bp)), blueprint: bp, baseline_id: bp.baseline_id };
}

// ═════════════ V09-13：图节点与关系的来源、证据标注与交付阻断（派生层） ═════════════
//
// 设计依据：DESIGN.md §3.2（来源与证据、同组关系可见性）、§4.2（颜色与交付阻断）、§4.5、
// 附录 D、附录 E.9、附录 G-2／G-4；施工定义见 PLAN V09-13。
//
// **判据不在这里**：来源种类只有三档、证据状态只有五档、交付读数只有两种结论——这些是 §3.2／§4.2
// 的图面口径，唯一实现在 `src/ui/arch/provenance.ts`（卡面点名「分类与证据状态不得在两个 UI 文件
// 各写一套」）。本函数只做**取事实**：蓝图节点/关系（含出处引用与复算结果）＋需求登记（来源一档）
// ＋任务定义（`requirement_ids` 承接映射）＋状态投影（证据记录），摊成判据的输入。
//
// 只读：不写盘、不调模型、不给纳管项目加运行时埋点（§4.1）。代价如实记：缺省情形本函数读事件账本两次
// （`readRequirements` 取需求登记 + `projectWithReleases` 取投影），两处各自只有一个真实现，不合并；
// 调用方若已读好一份**同一 workDir** 的事件快照（`opts.events`，见 V09-30 六图构建内共享），
// 这两处都复用那一份、不再各自读盘（不同 workDir／截点不串，见 `eventsOfSnapshot`）。

/** 蓝图节点 id → 任务卡号（`plan:task:<卡号>`；不是任务节点返回 null） */
const taskIdOfPlanNode = (id: string): string | null =>
  id.startsWith("plan:task:") ? id.slice("plan:task:".length) : null;

/** 施工依赖线在状态投影里的对象 id（`<前置卡号>-><依赖方卡号>`，与 V06-09 的连线口径逐字一致） */
const dependencyObjectIdOf = (e: { source: string; target: string; kind: string }): string | null => {
  if (e.kind !== "task_dependency") return null;
  const from = taskIdOfPlanNode(e.source);
  const to = taskIdOfPlanNode(e.target);
  return from === null || to === null ? null : `${from}->${to}`;
};

/** 蓝图节点 id → 状态投影对象 id（与 `ui/arch/projectGraph.ts#objectIdOf` 同一口径；
 *  对不上就是**没有投影对象** ⇒ 证据事实如实记 `has_projection: false`，不硬凑一个 id 出来） */
const objectIdOfPlanNode = (id: string): string | null => {
  if (id.startsWith("plan:code:")) return `module:${id.slice("plan:code:".length)}`;
  if (id.startsWith("plan:mod:")) return null;
  if (id.startsWith("plan:")) return taskIdOfPlanNode(id);
  return id;
};

/** 一个蓝图对象的来源引用复算账目（`sourceRefLocateOf` 是来源可定位性的唯一判据） */
function refStatusOf(
  refs: readonly BlueprintSourceRef[],
  ctx: BlueprintContext,
): { total: number; valid: number; stale: string[]; unlocatable: string[] } {
  let valid = 0;
  const stale: string[] = [];
  const unlocatable: string[] = [];
  for (const ref of refs) {
    const r = sourceRefLocateOf(ref, ctx);
    if (!r.located) {
      unlocatable.push(`${ref.kind}/${ref.locator}`);
      continue;
    }
    if (r.stale) {
      stale.push(`${ref.kind}/${ref.locator}`);
      continue;
    }
    valid += 1;
  }
  return { total: refs.length, valid, stale, unlocatable };
}

/**
 * 图节点/关系的**来源与证据标注模型**（V09-13 的服务端派生出入口；MCP `get_arch` 与
 * HTTP `GET arch/blueprint` 读的是同一份，界面不再各算一套）。
 *
 * 输出逐对象带：`source_kinds`（需求／设计／代码）＋映射（需求 id／设计章节／代码模块）＋
 * 证据状态（verified／unverified／missing／invalidated／user_pending），以及交付阻断读数
 * （存在未映射／未验证／缺证／证据失效 ⇒ 「不可判定项目可交付」并逐条点名；全齐才给「可请求验收」，
 * **仍不等于用户接受**）。没有可用的规划图时不给逐对象标注，读数如实给「没有可判定的交付对象」
 * ——**不空集判绿**、也不据此得出可交付结论。
 */
export function archProvenanceModelOf(
  projectId: string,
  opts: { dataDir?: string; events?: EventsSnapshot } = {},
): ProvenanceModel {
  const dataDir = opts.dataDir ?? resolveDataDir();
  const workDir = projectWorkDir(projectId, dataDir);
  const bp = readBlueprint(projectId, opts.dataDir);
  // 需求登记（§2.5 最小集；承接需求必须能解析到登记条目，悬空即点名）
  const requirementProjection = readRequirements(workDir, eventsOfSnapshot(opts.events, workDir));
  const requirements: RequirementRef[] = Object.values(requirementProjection.requirements)
    .map((r) => ({
      requirement_id: r.requirement_id,
      status: r.status,
      status_label: r.status_label,
      source_kind: r.source.kind,
      source_ref: r.source.ref,
    }))
    .sort((a, b) => a.requirement_id.localeCompare(b.requirement_id));
  const stamp = { generated_at: nowIso(), project_id: projectId, requirements };
  if (bp === null) {
    return buildProvenanceModel({
      ...stamp,
      blueprint_available: false,
      baseline_id: null,
      generator_version: null,
      objects: [],
    });
  }

  // 来源复算（唯一判据 `sourceRefLocateOf`）与状态投影（唯一派生 `projectWithReleases`）
  const ctx = blueprintContextOf(readBlueprintSources(projectId, opts.dataDir));
  const projection = projectWithReleases({
    projectId,
    dataDir,
    definitions: [],
    ...(opts.events === undefined ? {} : { events: opts.events }),
  });
  const projById: Record<string, StatusProjection> = {};
  for (const o of projection.objects) projById[o.object_id] = o;

  // 任务定义里的需求承接（`requirement_ids`，V09-03／V09-16 交付；需求映射表是施工图内的来源）
  const docs = loadDocuments(projectId, dataDir);
  const definitions = docs.plan === null ? [] : importTaskDefinitions(docs.plan.text).definitions;
  const requirementIdsByTask = new Map<string, string[]>();
  for (const def of definitions) {
    if (def.requirement_ids !== null && def.requirement_ids !== undefined && def.requirement_ids.length > 0) {
      requirementIdsByTask.set(def.task_id, [...def.requirement_ids]);
    }
  }

  // ── V09-17（§4.2 第三段／附录 E.15，GPT-6 裁定 2）：`implementation_map` 的映射复算 ──
  // 用**当前** PLAN 定义（上面已加载）× 当前模块清单（`ctx.code.modules`）× 仓库实际文件重算，
  // 不读旧蓝图缓存的过期结论。项目根取自注册表登记（`getProject`），不硬编码。
  // 口径与派生侧（`deriveBlueprint`）同一套零件：`declaredRealPathsOf` 取卡面声明路径、
  // `pathIntersectsPath` 判相交、`classifyDeclaredPathForMapping` 排除非代码路径；
  // 根模块目标只在「声明的根级文件真实存在于仓库根」时算映射成立，否则仍是兜底命中不算
  // （2026-09-25 终审返工判据细化，用户指令）。
  const projectRoot = getProject(projectId, dataDir)?.path ?? null;
  const defByTaskId = new Map(definitions.map((d) => [d.task_id, d]));
  const implementationMapMappingOf = (
    taskId: string,
    moduleId: string,
  ): { verdict: "hit" | "path_missing" | "root_fallback_only"; detail: string } => {
    const mod = ctx.code.modules.find((m) => m.id === moduleId);
    if (mod === undefined) {
      return {
        verdict: "path_missing",
        detail: `目标模块 ${moduleId} 已不在当前模块清单里（模块消失）——映射无法复算成立`,
      };
    }
    const modPath = normalizeRepoPath(mod.path);
    const def = taskId === "" ? undefined : defByTaskId.get(taskId);
    if (def === undefined) {
      return {
        verdict: "path_missing",
        detail: `当前施工图里已没有任务 ${taskId === "" ? "?" : taskId} 的定义（施工图定义已变）——声明路径无从复算`,
      };
    }
    if (modPath === "" || modPath === ".") {
      // 根模块目标的判据细化（2026-09-25 终审返工，用户指令）：根模块是**根目录散文件的真实归属模块**——
      // 卡面声明的单段文件名在仓库根真实存在（是文件）⇒ 映射成立（hit）；其余落根的情形
      // （多段路径没命中具体模块、裸文件名根下不存在、非代码路径）在派生侧已不产生这条边；
      // 一条根边连一个根级真实文件声明都复算不出来 ⇒ 仍是兜底产物，不算映射成立。
      const rootReal = declaredRealPathsOf(def).filter((p) => {
        if (classifyDeclaredPathForMapping(p) !== "module_candidate") return false;
        if (p.includes("/")) return false;
        if (projectRoot === null) return false;
        try {
          return fs.statSync(path.join(projectRoot, p)).isFile();
        } catch {
          return false;
        }
      });
      if (rootReal.length > 0) {
        return {
          verdict: "hit",
          detail:
            `声明的根级文件 ${rootReal.slice(0, 3).join("、")} 真实存在于仓库根——根模块（path 为 ./空）` +
            "正是根目录散文件的归属模块，声明路径真实存在且落在该模块 ⇒ 映射成立（2026-09-25 判据细化：与「没命中任何具体模块的兜底」区分）",
        };
      }
      return {
        verdict: "root_fallback_only",
        detail:
          `目标 ${moduleId} 是根模块（path 为 ./空）：这条映射边只靠根模块兜底产生` +
          "（声明路径没命中任何具体模块，也没有仓库根真实存在的根级文件声明）",
      };
    }
    const declared = declaredRealPathsOf(def);
    const intersecting = declared.filter((p) => pathIntersectsPath(p, modPath));
    const existing =
      projectRoot === null ? [] : intersecting.filter((p) => fs.existsSync(path.join(projectRoot, p)));
    if (existing.length > 0) {
      return {
        verdict: "hit",
        detail:
          `声明路径 ${existing.slice(0, 3).join("、")} 真实存在且落在模块 ${moduleId}（${modPath}）内` +
          "（pathIntersectsPath 命中非根模块）",
      };
    }
    if (intersecting.length > 0) {
      return {
        verdict: "path_missing",
        detail: `声明路径 ${intersecting.slice(0, 3).join("、")} 与该模块相交，但在仓库中不存在（规划路径）`,
      };
    }
    return {
      verdict: "path_missing",
      detail: `当前施工图的声明路径与模块 ${moduleId}（${modPath}）不再相交（定义可能已变）`,
    };
  };
  const STATIC_EDGE_KINDS = new Set(["task_design_ref", "implementation_map", "design_interface"]);
  // 人工步骤从**验收维度**取（`acceptance === "pending"` ⇒ 用户验收待办，§5.8／附录 E.9）。
  // 运行入口（`result_runtime_sources`）里的"用户亲自走一遍"当前实测为空（真实账本 7 条结果提交
  // 全部 `runtime_entries: []`），故不在本卡接线——不为一个当时恒空的分支多读一遍事件账本。
  const userActionsOfTask = (acceptance: string | null): string[] =>
    acceptance === "pending" ? ["人工验收待用户本人记录（质量状态不能代写验收，§5.8／附录 E.9）"] : [];

  const nodeName = new Map(bp.nodes.map((n) => [n.id, n.name]));
  const factsByNode = new Map<string, EvidenceFacts>();
  const objects: ProvenanceObjectInput[] = [];
  /** 一个节点的证据事实（task/其余 kind 走投影；module/capability 走成员账目，见下两趟） */
  const nodeInput = (n: BlueprintNode, facts: EvidenceFacts): ProvenanceObjectInput => {
    const taskId = taskIdOfPlanNode(n.id);
    return {
      object_id: n.id,
      object_kind: "node",
      label: n.name,
      kind: n.kind,
      // §3.2 能力分类（2026-09-26 GPT-6 裁定 7）：能力对象带分类——治理章节的状态文案必须带限定（provenance.annotateObject）。
      // R-1 返工：表损坏时分类未定 ⇒ `unknown`（**不默认 functional**）；判据唯一实现在 `projectGraph.capabilityClassOf`
      capability_class: n.kind === "capability" ? capabilityClassOf(bp, n.id) : null,
      source_refs: n.source_refs.map((r) => ({ kind: r.kind, path: r.path, locator: r.locator, sha256: r.sha256 })),
      requirement_ids: taskId === null ? [] : (requirementIdsByTask.get(taskId) ?? []),
      task_id: taskId,
      evidence: facts,
    };
  };
  const evidenceFactsOfNode = (n: BlueprintNode): EvidenceFacts => {
    const objectId = objectIdOfPlanNode(n.id);
    const proj = objectId === null ? null : projById[objectId] ?? null;
    const taskId = taskIdOfPlanNode(n.id);
    return provenanceFactsOf(proj, {
      object_id: n.id,
      label: n.name,
      sources: refStatusOf(n.source_refs, ctx),
      ...(taskId === null ? {} : { user_actions: userActionsOfTask(proj?.acceptance ?? null) }),
    });
  };
  const aggregateOfMembers = (memberIds: readonly string[], basis: string): MemberAggregate => {
    let verified = 0;
    let withoutStatus = 0;
    let pending = 0;
    for (const id of memberIds) {
      const f = factsByNode.get(id);
      if (f === undefined) {
        withoutStatus += 1;
        continue;
      }
      const v = evidenceStateOf(f);
      if (v.state === "missing") {
        withoutStatus += 1;
        continue;
      }
      if (v.verification_passed) verified += 1;
      if (v.state === "user_pending") pending += 1;
    }
    return { members_total: memberIds.length, members_verified: verified, members_without_status: withoutStatus, members_user_pending: pending, basis };
  };

  // 第 1 趟：任务与其余非父级节点（父级 = module / capability，走成员账目；顺序即依赖序）
  for (const n of bp.nodes) {
    if (n.kind === "module" || n.kind === "capability") continue;
    const facts = evidenceFactsOfNode(n);
    factsByNode.set(n.id, facts);
    objects.push(nodeInput(n, facts));
  }
  // 第 2 趟：模块（成员 = 附录 D 的实现映射/审定材料索引给的任务卡，与图面同一份派生）
  const moduleDerived = taskDerivedModuleStatus({
    blueprint: bp,
    projection: projById,
    declared_links: declaredLinksOf(readLastReconcile(projectId, opts.dataDir).result ?? null),
  });
  for (const n of bp.nodes) {
    if (n.kind !== "module") continue;
    const memberTasks = moduleDerived.tasks_by_module[n.id] ?? [];
    const members = memberTasks.map((t) => `plan:task:${t}`);
    const facts: EvidenceFacts = {
      ...provenanceFactsOf(null, { object_id: n.id, label: n.name, sources: refStatusOf(n.source_refs, ctx), delivery_relevant: false }),
      member_aggregate: aggregateOfMembers(
        members,
        moduleDerived.status[n.id]?.basis ??
          "模块层按实现映射从任务卡汇总（附录 D）；没有任何卡映射到它 ⇒ 无状态记录",
      ),
    };
    factsByNode.set(n.id, facts);
    objects.push(nodeInput(n, facts));
  }
  // 第 3 趟：能力（成员 = 设计接口 + 任务的设计依据引用；§3.2 分组口径见 `capabilityMembersOf`）
  const capabilityIds = new Set(bp.nodes.filter((n) => n.kind === "capability").map((n) => n.id));
  const capMembers = capabilityMembersOf(bp.edges, capabilityIds);
  // P11 画布真实缺口对账（2026-09-26 安装版复核）：用真实 buildViewModel 复算两个分组视图——
  // 「证据链说有成员 ⇔ 画布分组真画得出」必须对齐，断裂的逐条挂到对应能力的标注上（阻断交付结论）
  const canvasGapsByCap = new Map<string, string[]>();
  for (const g of canvasMembershipGapsOf({ blueprint: bp, projection: projById, module_status: moduleDerived.status })) {
    const viewLabel = g.view === "functional" ? "功能全景" : g.view === "architecture" ? "系统架构" : g.view;
    const list = canvasGapsByCap.get(g.capability_id) ?? [];
    list.push(`[${viewLabel}] ${g.detail}`);
    canvasGapsByCap.set(g.capability_id, list);
  }
  for (const n of bp.nodes) {
    if (n.kind !== "capability") continue;
    const facts: EvidenceFacts = {
      ...provenanceFactsOf(null, { object_id: n.id, label: n.name, sources: refStatusOf(n.source_refs, ctx), delivery_relevant: false }),
      member_aggregate: aggregateOfMembers(
        capMembers[n.id] ?? [],
        "能力不另设验证对象，由成员派生（DESIGN.md 附录 D）：成员非空且全部「要求的验证已通过」才算过",
      ),
      canvas_gaps: canvasGapsByCap.get(n.id) ?? [],
    };
    factsByNode.set(n.id, facts);
    objects.push(nodeInput(n, facts));
  }
  for (const e of bp.edges) {
    const depObjectId = dependencyObjectIdOf(e);
    const proj = depObjectId === null ? null : projById[depObjectId] ?? null;
    const edgeId = `${e.source}>${e.target}:${e.kind}`;
    const label = `${nodeName.get(e.source) ?? e.source} → ${nodeName.get(e.target) ?? e.target}（${e.kind}）`;
    // V09-17：三类静态边带上「自身来源/映射复算」读数（判据在 provenance.ts#evidenceStateOf 的 P10 分支，
    // 与两端点状态无关）；其余边（task_dependency／model_inference）维持原口径，不装配这个字段。
    const isStaticEdge = STATIC_EDGE_KINDS.has(e.kind);
    objects.push({
      object_id: edgeId,
      object_kind: "edge",
      label,
      kind: e.kind,
      source_refs: e.source_refs.map((r) => ({ kind: r.kind, path: r.path, locator: r.locator, sha256: r.sha256 })),
      requirement_ids: [],
      task_id: null,
      evidence: {
        ...provenanceFactsOf(proj, {
          object_id: edgeId,
          label,
          sources: refStatusOf(e.source_refs, ctx),
          delivery_relevant: false,
        }),
        static_relation: !isStaticEdge
          ? null
          : {
              kind: e.kind as "task_design_ref" | "implementation_map" | "design_interface",
              ...(e.kind === "implementation_map"
                ? {
                    mapping: implementationMapMappingOf(
                      taskIdOfPlanNode(e.source) ?? "",
                      e.target.startsWith(`${PLAN_PREFIX}code:`) ? e.target.slice(`${PLAN_PREFIX}code:`.length) : "",
                    ),
                  }
                : {}),
            },
      },
    });
  }

  // ── V09-17 ② 消失报缺（§4.2 第三段／附录 E.15 裁定 2）：蓝图 omitted 里「声明还在但目标消失」的
  // 条目（设计依据定位不到 / 依赖卡不在定义里）必须进溯源模型生成 missing 标注、计入交付阻断并
  // 逐条点名——**不得靠对象消失让读数变绿**。「经批准移除」的豁免路径＝声明本身经 DESIGN/PLAN
  // 修订流程删除：声明没了，派生层就不再产生这条关系、也不再进 omitted——豁免不需要另造机制。
  const REPORTED_OMISSION_KINDS = new Set(["unresolved_design_ref", "dangling_dependency"]);
  bp.omitted.forEach((o, i) => {
    if (!REPORTED_OMISSION_KINDS.has(o.kind)) return;
    const oid = `omitted:${o.kind}:${i}`;
    const label = `消失报缺（${o.kind}）：${o.detail}`;
    objects.push({
      object_id: oid,
      object_kind: "edge",
      label,
      kind: o.kind,
      source_refs: [],
      requirement_ids: [],
      task_id: null,
      evidence: provenanceFactsOf(null, { object_id: oid, label, delivery_relevant: false }),
    });
  });

  return buildProvenanceModel({
    ...stamp,
    blueprint_available: true,
    baseline_id: bp.baseline_id,
    generator_version: bp.generator_version,
    objects,
    // 模型提案待审线索（§4.1／附录 E.17）：只列出供追溯，不进对象、不计入任何验证读数与交付判定
    model_leads: (bp.model_leads ?? []).map((l) => ({
      source: l.source,
      target: l.target,
      kind: l.kind,
      model_certainty: l.model_certainty,
      disposition: l.disposition,
      source_refs: l.source_refs.map((r) => ({ kind: r.kind, path: r.path, locator: r.locator, sha256: r.sha256 })),
    })),
    // R-2：节点侧待审线索（提案节点／给既有节点补的出处）——同样只列出供追溯，不进正式对象与读数
    model_node_leads: (bp.model_node_leads ?? []).map((l) => ({
      id: l.id,
      kind: l.kind,
      name: l.name,
      target: l.target,
      disposition: l.disposition,
      proposed_source_refs: l.proposed_source_refs.map((r) => ({ kind: r.kind, path: r.path, locator: r.locator, sha256: r.sha256 })),
      proposed_related_ids: [...l.proposed_related_ids],
    })),
    capability_classes: bp.capability_classes ?? null,
  });
}
