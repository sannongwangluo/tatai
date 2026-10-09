// 唯一「义务 / 状态」派生层（B2/V09-52；DESIGN.md §2.6 目标契约）。
//
// 为什么必须只有这一处：功能清单（coverageModel）、工作包（B3/V09-53）与六图聚合（B5）
// **不得各算一份业务状态**（§2.6「不建第二张完成表」）。它们都从 `deriveObligations` 的同一份
// 结论投影；投影之间**互不读对方输出**（避免循环与漂移）。
//
// 本模块**不新造绿公式**：绿/橙/红/灰/未知的判据唯一实现在
// `statusProjection.ts#projectStatuses`（§4.2 优先级序）。这里只做四件事：
//   ① 一次读齐来源（调用方传入同一 revision 的 `ProjectFacts`），装配投影对象——
//      **包括功能（capability）范围的 canonical `StatusObjectInput`**：逐条用 PLAN 映射表声明的
//      `required_check_ids` / `integration_check_ids`，**不按整卡 worst 替代**，局部检查不被同一张卡的
//      其他检查拖累（§4.2「父级全部通过要求所有必需子项及自身集成检查通过」）；
//   ② 复用既有 `checkEffectiveness` / `checksFromFacts` / `requiredChecksFromDefinitions`
//      给出**逐项**义务与有效口径；
//   ③ 落地 check 的**稳定键 + 定义指纹**与位置型旧身份的**显式映射**（§2.5.1），
//      并把解析结果**真正接进投影的检查记录**（不是留给下游自己接）；
//   ④ 四维读数里属于本层的部分（`evidence_state` 分档、用户接受的范围口径）也只在这里算一次。
//
// 只读、纯派生、零写入、可删除重建（§2.6）。

import {
  acceptanceDimensionOf,
  checksFromFacts,
  dependencyRelease,
  objectsFromFacts,
  projectStatuses,
  requiredChecksFromDefinitions,
  type AcceptanceDimension,
  type CheckInput,
  type ProjectFacts,
  type ProjectIntegrationRequirements,
  type RequirementInput,
  type SourceRevisions,
  type StatusObjectInput,
  type StatusProjection,
  type StatusProjectionSet,
} from "./statusProjection";
import { sha256Hex, importTaskDefinitions, type TaskDefinition } from "./plan";
import { planContentSnapshotIndex } from "./documents";
import type { WorkEvent } from "./types";
import type { EvidenceState } from "../../ui/arch/provenance";
import {
  scopeMemberKindOf,
  scopeRevisionOf,
  type ScopeCheckDefinitionRef,
  type ScopeMemberEntry,
  type ScopeMemberVia,
} from "../../arch/featureScope";

// ────────────────────────── check 稳定身份（§2.5.1） ──────────────────────────

/**
 * 一条验收检查的**稳定身份**。
 *
 * 现行解析器按**位置**识别检查项（`<task>::check:<i>`）。B2 起：检查项若以稳定键
 * `chk-<…>` 开头（允许 Markdown 加粗包装 `**chk-…**`），就用它作 `check_id`；
 * 否则仍用位置 id（**向后兼容既有项目**——它们的检查项没有前缀，行为一字不变）。
 *
 * `legacy_position_id` 始终保留位置型旧身份，供**显式映射**用；**绝不**按位置把旧通过
 * 套到稳定键上（无映射 ⇒ 身份未知 ⇒ 不继承，§2.5.1 anti_pattern）。
 */
export interface StableCheckDefinition {
  check_id: string;
  label: string;
  /** 该检查所属的对象（任务 id；与 `objectsFromFacts` 拼 `check_id` 的口径同源） */
  object_id: string;
  /** 缺省 = 必需（DefaultDeny，§4.2） */
  required: boolean;
  /** 该检查是否要求**非作者**复核（由检查文本里的显式标记判，见 `independenceRequiredOf`） */
  independence_required: boolean;
  /** true = 稳定键；false = 位置型（向后兼容的旧形态） */
  stable: boolean;
  /** 位置型旧身份 `<task>::check:<i>`（稳定键检查也有，供映射表比对） */
  legacy_position_id: string;
  /** 定义内的原始序号（0 起） */
  position: number;
  /** 定义指纹：规范化文本 + 必需/独审 + 对象 id 的 sha256（定义变了它必变） */
  definition_fingerprint: string;
}

/** 稳定键 token：`chk-` 开头，允许字母数字与 `-._`；只在检查文本**起始**（可带 `**` 加粗）处认 */
const STABLE_CHECK_RE = /^\s*(?:\*\*|__)?\s*(chk-[A-Za-z0-9][A-Za-z0-9._-]*)/;

export function stableCheckIdOf(text: string): string | null {
  const m = STABLE_CHECK_RE.exec(text);
  return m === null ? null : m[1];
}

/**
 * 独审义务的判据（§2.7 `independence_required`／§5.8「作者不为自己签独审」）。
 *
 * **为什么不能只扫关键词**：检查文本经常在**描述业务概念**时提到"独立审计"——例如
 * 「实现结果提交、自检、独立审计、修复待复测和人工接受的分离记录」（PLAN 实存），
 * 或「历史独立审计记录数仍为 227」（PLAN 实存），或「V06-02 的正式独立复测留给非作者审计人，本卡不代做」。
 * 这些都是**被实现/被引用的概念**，不是"本项必须由非作者来做"的要求。按整串关键词扫，会给存量检查
 * 凭空加上独审义务，把已验任务批量打回（§5.8 反而被破坏）。
 *
 * 判据因此收成两类，**只认"对本项验证者的要求"**：
 *   ① **显式机器标记**（新增承载，权威且可解析）：`[独立复核]`／`[非作者复核]`／`[非作者审计]`／
 *      `[独立审计]`，或 `independence:required`／`independence_required:true`；
 *   ② **兼容既有明确语句**：句子**明确把要求落在本项的验证者**上——须有"由非（本卡）作者/他执行者…复核"
 *      的施动结构，或以"非作者（独立）复核/审计/复测"**开句**，或"作者自检不得代替"。
 *      仅出现"独立审计/独立复测"这类**概念词**不算（见上面的反例）。
 */
export const INDEPENDENCE_REQUIRED_MARKERS: readonly string[] = [
  "[独立复核]",
  "[非作者复核]",
  "[非作者审计]",
  "[独立审计]",
  "[独立复测]",
];

const INDEPENDENCE_MARKER_RE =
  /(?:\[(?:独立|非作者)(?:复核|审计|复测)\]|independence(?:_required)?\s*[:=]\s*(?:true|required|1))/i;

/**
 * 兼容既有明确语句（**不新增义务、也不全量放宽**）：
 *   · `由**非本卡作者**的另一执行者做独立审计…`（施动结构 + 验证角色）⇒ 认；
 *   · `非作者复核完成；…`（以"非作者复核"开句）⇒ 认；
 *   · `本卡作者自检**不得**代替它`（禁止作者自证）⇒ 认；
 *   · `…、自检、独立审计、…`（并列名词，无施动结构）⇒ **不认**（业务概念）；
 *   · `V06-02 的正式独立复测留给非作者审计人，本卡不代做` ⇒ **不认**（把工作指派给别处）。
 */
const INDEPENDENCE_LEGACY_RES: readonly RegExp[] = [
  // 施动结构：由（非本卡作者／非作者／另一位执行者／其他执行者…）做复核/审计/复测
  /由\s*\*{0,2}\s*(?:非本卡作者|非作者|其他执行者|另一名?执行者|另一执行者)[^。；\n]{0,40}(?:复核|审计|复测)/,
  // 开句即要求：非作者（独立）复核/审计/复测（句首或紧跟在分隔标点/空白后；"留给非作者审计人"这类
  // 把工作指派到别处的**不算**——"非作者"前是"给"之类非分隔字）
  /(?:^|[。；！？\n\s：:，,、])\s*(?:本项|本卡)?\s*(?:须由)?\s*非作者\s*(?:独立)?\s*(?:复核|审计|复测)/,
  // 禁止作者自证：作者自检不得代替/替代/冒充（非作者复核）
  /作者自检[^。；\n]{0,12}(?:不|不得|不能)[^。；\n]{0,12}(?:代替|替代|冒充)/,
];

export function independenceRequiredOf(text: string): boolean {
  if (INDEPENDENCE_MARKER_RE.test(text)) return true;
  return INDEPENDENCE_LEGACY_RES.some((re) => re.test(text));
}

/**
 * 检查的**语义身份**（对象 + 规范化文本 + 必需性 + 独审义务）：**不含** `check_id`。
 *
 * 用途只有一个：把「同一条检查在定义里换了身份写法」认成同一语义——例如旧定义是位置型
 * `V-9::check:0`、新定义给它补了稳定键前缀 `**chk-v-9-01 …**`。两者 `check_id` 不同、
 * 文本字面也不同（多了 `**` 与 token），但**检查内容与要求逐字相同**（`canonicalCheckText` 去掉
 * 强调记号与稳定键 token），语义身份必须相等——否则"补稳定键"会被误判成语义变更。
 *
 * 反过来，**正文改了就是改了**（`…（语义已改）` ⇒ 语义身份变），据此判"旧记录不得继承"。
 */
export function checkSemanticFingerprint(input: {
  object_id: string;
  text: string;
  required: boolean;
  independence_required: boolean;
}): string {
  return sha256Hex(
    [
      `object:${input.object_id}`,
      `required:${input.required ? "1" : "0"}`,
      `independence:${input.independence_required ? "1" : "0"}`,
      `canon:${canonicalCheckText(input.text)}`,
    ].join("\n"),
  );
}

/** 一条检查定义的**语义身份**（供 `StableCheckDefinition` 直接取用） */
export function semanticFingerprintOfDefinition(d: StableCheckDefinition): string {
  return checkSemanticFingerprint({
    object_id: d.object_id,
    text: d.label,
    required: d.required,
    independence_required: d.independence_required,
  });
}

/** 规范化检查文本（比对指纹用）：行尾空白去掉、内部连续空白折叠为单空格、trim */
export function normalizeCheckText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * **身份化**检查文本：去掉 Markdown 强调记号与起始的稳定键 token。
 *
 * 用途只有一个：把「历史定义里的位置型检查文本」与「当前定义里同一检查（已加 `chk-` 前缀）」
 * 认成**同一条检查**——这是显式映射的比对口径，不是身份本身（身份仍是稳定键/位置 id）。
 */
export function canonicalCheckText(text: string): string {
  return normalizeCheckText(
    text
      .replace(/\*\*/g, "")
      .replace(/__/g, "")
      .replace(/\*/g, "")
      .replace(/\s*(?:chk-[A-Za-z0-9][A-Za-z0-9._-]*)\s*/, " ")
      .trim(),
  );
}

/**
 * 定义指纹：同一 `check_id` 在同一对象下，定义一变指纹必变。
 * 覆盖对象 id、check_id、规范化文本、必需性、独审义务——**不含**位置与勾选位
 * （重排/勾选不改变语义 ⇒ 指纹不变，身份可安全保持）。
 */
export function checkDefinitionFingerprint(input: {
  object_id: string;
  check_id: string;
  text: string;
  required: boolean;
  independence_required: boolean;
}): string {
  const canon = [
    `object:${input.object_id}`,
    `check:${input.check_id}`,
    `required:${input.required ? "1" : "0"}`,
    `independence:${input.independence_required ? "1" : "0"}`,
    `text:${normalizeCheckText(input.text)}`,
  ].join("\n");
  return sha256Hex(canon);
}

/**
 * 一个任务定义 → 它的全部验收检查定义（**单一出处**：`objectsFromFacts` 拼 `check_id` 的口径与
 * 本函数逐字相同，见 `requiredChecksFromDefinitions`）。
 * 每条定义都给一条记录（列表可能为空）；调用方据此区分"没有这个任务定义"与"定义了但没有检查项"。
 */
export function stableCheckDefinitionsOf(def: TaskDefinition): StableCheckDefinition[] {
  const out: StableCheckDefinition[] = [];
  if (def.acceptance != null) {
    def.acceptance.checks.forEach((c, i) => {
      const legacy = `${def.task_id}::check:${i}`;
      const stable = stableCheckIdOf(c.text);
      const check_id = stable ?? legacy;
      const required = true;
      const independence_required = independenceRequiredOf(c.text);
      out.push({
        check_id,
        label: c.text,
        object_id: def.task_id,
        required,
        independence_required,
        stable: stable !== null,
        legacy_position_id: legacy,
        position: i,
        definition_fingerprint: checkDefinitionFingerprint({
          object_id: def.task_id,
          check_id,
          text: c.text,
          required,
          independence_required,
        }),
      });
    });
  }
  if (def.evidence_requirement != null && def.evidence_requirement !== "") {
    const legacy = `${def.task_id}::evidence`;
    const required = true;
    const independence_required = independenceRequiredOf(def.evidence_requirement);
    out.push({
      check_id: legacy,
      label: def.evidence_requirement,
      object_id: def.task_id,
      required,
      independence_required,
      stable: false,
      legacy_position_id: legacy,
      position: def.acceptance?.checks.length ?? 0,
      definition_fingerprint: checkDefinitionFingerprint({
        object_id: def.task_id,
        check_id: legacy,
        text: def.evidence_requirement,
        required,
        independence_required,
      }),
    });
  }
  return out;
}

/** 定义集合 → `task_id → 检查定义[]` */
export function stableCheckDefinitionsByTask(
  defs: readonly TaskDefinition[],
): Record<string, StableCheckDefinition[]> {
  const out: Record<string, StableCheckDefinition[]> = {};
  for (const def of defs) out[def.task_id] = stableCheckDefinitionsOf(def);
  return out;
}

// ────────────────────────── 旧身份 → 稳定键的**显式映射**（§2.5.1） ──────────────────────────

/**
 * 一条**显式映射**（位置型旧身份 → 稳定键）。
 *
 * 规则（§2.5.1 `check_identity.rule`、PLAN V09-52 卡面「旧身份映射（冻结口径）」）：
 *   · 只有**显式**给出的映射才成立；**绝不**按"第 N 条对应第 N 条"隐式套用；
 *   · 映射必须绑到**当前定义的指纹**：指纹对不上（重排/改语义）⇒ 本条不采信（不继承旧通过）；
 *   · 映射表随定义进不可变修订与基线——所以这里的 `source_ref` 是**可读正式来源**的定位符
 *     （不可变施工图快照 + 该快照里的任务定义），不是调用方随手给的字符串。
 */
export interface CheckIdentityMappingEntry {
  task_id: string;
  legacy_position_id: string;
  stable_check_id: string;
  /** 当前定义的指纹（映射必须绑到它；对不上 = 不采信） */
  definition_fingerprint: string;
  /** 这条映射的可读来源定位符（如 `plan-revisions/<definition_sha256>.md#<task_id>`） */
  source_ref: string;
}

export type CheckIdentityMapping = readonly CheckIdentityMappingEntry[];

/** 一条映射被拒的原因（**不静默丢弃**：调用方与复核者要看得到为什么没继承） */
export interface CheckIdentityMappingRejection {
  entry: CheckIdentityMappingEntry;
  reason: string;
}

/** 一份历史任务定义（可读正式来源的一条读数） */
export interface HistoricalTaskDefinition {
  task_id: string;
  /** 可读来源定位符 */
  source_ref: string;
  definition: TaskDefinition;
}

/**
 * 从**不可变施工图快照的历史任务定义**推导身份映射（纯函数；**调用方显式给出历史时**可用）。
 *
 * 判据（严格，不做近似标题式匹配）：当前定义里带稳定键 `K` 的检查，其**身份化文本**
 * （`canonicalCheckText`，去强调记号与稳定键 token）与历史快照里**同任务**某条**位置型**
 * 检查逐字相同 ⇒ 该历史位置身份 `<task>::check:<i>` 显式映射到 `K`。
 *
 * 于是：
 *   · 旧位置**定义未变**（只是补了稳定键前缀）⇒ 继续可用；
 *   · 换了语义（文本变了）或换成了另一条检查（重排后该位置是别的内容）⇒ **没有映射**，不继承。
 *
 * 注意：`deriveObligations` 的正式通路**不**用本函数扫历史找文本，而是复用
 * `checkDefinitionBindingsOf` 的**逐条记录定义绑定**结论（`mappingFromDefinitionBindings`）——
 * 读取集合有限且确定，不按位置隐式套用（§2.5.1）。
 */
export function mappingFromDefinitionHistory(
  current: Record<string, StableCheckDefinition[]>,
  history: readonly HistoricalTaskDefinition[],
): { mapping: CheckIdentityMapping; rejected: CheckIdentityMappingRejection[] } {
  const out: CheckIdentityMappingEntry[] = [];
  const rejected: CheckIdentityMappingRejection[] = [];
  for (const [task_id, defs] of Object.entries(current)) {
    for (const d of defs) {
      if (!d.stable) continue;
      const want = canonicalCheckText(d.label);
      let hit: { legacy_position_id: string; source_ref: string } | null = null;
      for (const h of history) {
        if (h.task_id !== task_id) continue;
        const oldDefs = stableCheckDefinitionsOf(h.definition);
        for (const o of oldDefs) {
          if (o.stable) continue;
          if (canonicalCheckText(o.label) !== want) continue;
          hit = { legacy_position_id: o.legacy_position_id, source_ref: `${h.source_ref}#${task_id}` };
          break;
        }
        if (hit !== null) break;
      }
      if (hit === null) continue;
      out.push({
        task_id,
        legacy_position_id: hit.legacy_position_id,
        stable_check_id: d.check_id,
        definition_fingerprint: d.definition_fingerprint,
        source_ref: hit.source_ref,
      });
    }
  }
  return { mapping: out, rejected };
}

/**
 * 施工图快照读法（账本只带**本卡**绑定的内容哈希，而快照按**整份施工图**的定义哈希命名）。
 * 口径唯一实现是 `documents.planContentSnapshotIndex`（内容哈希 → 对象候选名 + 核内容哈希），
 * 与读侧分段复核（`statusProjection.bindingSnapshotsOf`）**同一份**来源解析——避免两处各写一套。
 */
function planSnapshotReader(
  projectId: string,
  dataDir: string,
): (planContentSha: string) => { text: string; source_ref: string } | null {
  const index = planContentSnapshotIndex(projectId, dataDir);
  return (planContentSha: string) => {
    const hit = index.read(planContentSha);
    return hit === null ? null : { text: hit.text, source_ref: hit.source_ref };
  };
}

// ─────────────────── 记录时点的**不可变任务定义**与逐条定义绑定核对（§2.5.1） ───────────────────

/**
 * 账本里一条**不可变任务定义**的读数：`task.definition_imported` 事件给出「这张卡的定义在哪一个
 * 账本序号被换成了哪一版」。
 *
 * 为什么必须是它、而不是"任何历史版本里曾有过同名文本"：一条检查记录要能被采信，必须证明它当时
 * 是按**这一版定义**验的。只有把记录落回它自己的 seq，再取**那个时点在效**的定义，才能逐项比对
 * 语义/必需/独审是否与当前一致（WATCH 11:19/11:29 的核心要求）。
 */
export interface ImmutableDefinitionRef {
  task_id: string;
  /** 定义生效的账本序号（`task.definition_imported` 的 `seq`；服务端产出，payload 伪造不了） */
  seq: number;
  /** 记录里声明的定义修订号（同一任务的递增序号） */
  definition_revision: number;
  /** 该定义所属的施工图修订（内容 sha256） */
  plan_revision: string;
  /** 该任务定义的 sha256（事件自报，仅供定位，不用于判据） */
  definition_sha256: string;
}

/** 账本事件 → 逐任务的**不可变定义**时间线（按 `seq` 升序；同一 seq 只留一条） */
export function immutableDefinitionHistoryOf(
  events: readonly WorkEvent[],
): Map<string, ImmutableDefinitionRef[]> {
  const out = new Map<string, ImmutableDefinitionRef[]>();
  for (const e of [...events].sort((a, b) => a.seq - b.seq)) {
    if (e.type !== "task.definition_imported") continue;
    const task_id = e.entity_id.startsWith("task:") ? e.entity_id.slice("task:".length) : e.entity_id;
    const rev = typeof e.payload.definition_revision === "number" ? e.payload.definition_revision : null;
    const sha = typeof e.payload.definition_sha256 === "string" ? e.payload.definition_sha256 : null;
    const planRev = typeof e.payload.plan_revision === "string" ? e.payload.plan_revision : "";
    if (rev === null || sha === null || sha === "") continue;
    const list = out.get(task_id) ?? [];
    const last = list[list.length - 1];
    if (last !== undefined && last.definition_sha256 === sha) continue;
    list.push({ task_id, seq: e.seq, definition_revision: rev, plan_revision: planRev, definition_sha256: sha });
    out.set(task_id, list);
  }
  return out;
}

/** 该任务在 `seq` 时点**在效**的定义（`seq <= 给定值` 的最近一条）；没有 = null（不猜） */
export function definitionInForceAt(
  history: ReadonlyMap<string, ImmutableDefinitionRef[]>,
  task_id: string,
  seq: number,
): ImmutableDefinitionRef | null {
  const list = history.get(task_id);
  if (list === undefined) return null;
  let best: ImmutableDefinitionRef | null = null;
  for (const d of list) {
    if (d.seq <= seq) best = d;
    else break;
  }
  return best;
}

/** 记录级定义绑定的核对结论 */
export type DefinitionBindingVerdict = "match" | "changed" | "unknown";

export interface DefinitionBindingReadout {
  object_id: string;
  check_id: string;
  record_ref: string | null;
  /** 该记录在账本里的实际序号（拿不到 = null ⇒ 一律 `unknown`，保留旧判词） */
  record_seq: number | null;
  /** 记录时点在效的不可变定义（拿不到 = null）；`plan_revision` = 该快照的施工图内容哈希（可读来源名） */
  in_force: {
    definition_revision: number;
    definition_sha256: string;
    plan_revision: string;
    source_ref: string;
  } | null;
  /** 当时定义里这条检查的语义身份 / 当前定义里的语义身份（拿不到 = null） */
  recorded_semantic: string | null;
  current_semantic: string | null;
  verdict: DefinitionBindingVerdict;
  reason: string | null;
}

/** 记录身份键：**object_id + check_id + record_ref** 三者齐备才算同一条记录（与 `pickCheckRecords` 同口径） */
export const definitionBindingKey = (object_id: string, check_id: string, record_ref: string): string =>
  `${object_id}\u0000${check_id}\u0000${record_ref}`;

/**
 * 逐条检查记录核对**它当时的定义**与当前定义是否同一语义。
 *
 * 判据（**fail-closed，但"取不到唯一来源"不当作失效**，WATCH 11:19/11:29）：
 *   · 记录 seq 取不到（记录不在本次快照的事件里 / 手工构造） ⇒ `unknown`，**保留**旧记录与旧判词；
 *   · 该任务在记录时点没有可取回的不可变定义（快照读不到） ⇒ `unknown`，保留；
 *   · 两条定义都取到：语义身份（对象＋规范化文本＋必需＋独审）**相等** ⇒ `match`；
 *     **不等** ⇒ `changed`（同 `stableID` 语义变 / 旧位置重排后语义变），该记录**必须失效**——
 *     不得用当前定义给旧记录现填指纹（§2.5.1 anti_pattern）。
 *
 * 只按 `object_id` 分卡比对：**别的卡的定义改动不连坐**（同定义的老记录继续有效）。
 */
export function checkDefinitionBindingsOf(args: {
  project_id: string;
  data_dir: string;
  events: readonly WorkEvent[];
  task_checks: Record<string, StableCheckDefinition[]>;
  /** 待核对的检查记录（`object_id` / `check_id` / `record_ref`；与投影用的是同一批） */
  records: readonly { object_id: string; check_id: string; record_ref?: string | undefined }[];
}): Map<string, DefinitionBindingReadout> {
  const { project_id, data_dir, events, task_checks, records } = args;
  const history = immutableDefinitionHistoryOf(events);
  const seqByEntity = new Map<string, number>();
  for (const e of events) {
    // 同一实体 id 可能有多条（幂等重放）；取最早那条作为"记录发生的时点"（保守）
    if (!seqByEntity.has(e.entity_id)) seqByEntity.set(e.entity_id, e.seq);
  }
  const readPlan = planSnapshotReader(project_id, data_dir);
  const defCache = new Map<string, TaskDefinition | null>();
  const defOfSnapshot = (info: ImmutableDefinitionRef, task_id: string): TaskDefinition | null => {
    const key = `${info.plan_revision}|${info.definition_sha256}|${task_id}`;
    if (defCache.has(key)) return defCache.get(key) ?? null;
    let found: TaskDefinition | null = null;
    const snap = readPlan(info.plan_revision);
    if (snap !== null) {
      try {
        found = importTaskDefinitions(snap.text).definitions.find((d) => d.task_id === task_id) ?? null;
      } catch {
        found = null;
      }
    }
    defCache.set(key, found);
    return found;
  };
  const findCheck = (
    defs: readonly StableCheckDefinition[],
    recorded: string,
  ): StableCheckDefinition | null =>
    defs.find((d) => d.check_id === recorded) ?? defs.find((d) => d.legacy_position_id === recorded) ?? null;

  const out = new Map<string, DefinitionBindingReadout>();
  for (const rec of records) {
    if (rec.record_ref === undefined || rec.record_ref === "") continue;
    const key = definitionBindingKey(rec.object_id, rec.check_id, rec.record_ref);
    if (out.has(key)) continue;
    const base: DefinitionBindingReadout = {
      object_id: rec.object_id,
      check_id: rec.check_id,
      record_ref: rec.record_ref,
      record_seq: null,
      in_force: null,
      recorded_semantic: null,
      current_semantic: null,
      verdict: "unknown",
      reason: null,
    };
    const task_id = rec.object_id.startsWith("task:")
      ? rec.object_id.slice("task:".length)
      : rec.object_id;
    const currentDefs = task_checks[task_id];
    if (currentDefs === undefined || currentDefs.length === 0) {
      out.set(key, { ...base, reason: `当前定义里没有任务 ${task_id}：无法证明这条记录的当时定义（保留旧判词）` });
      continue;
    }
    const current = findCheck(currentDefs, rec.check_id);
    if (current === null) {
      out.set(key, {
        ...base,
        reason: `当前定义里没有检查身份「${rec.check_id}」：无法比对当时定义（保留旧判词）`,
      });
      continue;
    }
    const seq = seqByEntity.get(rec.record_ref) ?? null;
    if (seq === null) {
      out.set(key, {
        ...base,
        current_semantic: semanticFingerprintOfDefinition(current),
        reason: `记录「${rec.record_ref}」不在本次快照的事件里：拿不到记录时点，按 unknown（保留旧判词）`,
      });
      continue;
    }
    const inForce = definitionInForceAt(history, task_id, seq);
    if (inForce === null) {
      out.set(key, {
        ...base,
        record_seq: seq,
        current_semantic: semanticFingerprintOfDefinition(current),
        reason:
          `任务 ${task_id} 在记录时点（seq ${seq}）没有可取回的不可变定义（没有定义导入事件或快照读不到）：` +
          "拿不到唯一来源，按 unknown（保留旧判词）",
      });
      continue;
    }
    const histDef = defOfSnapshot(inForce, task_id);
    if (histDef === null) {
      out.set(key, {
        ...base,
        record_seq: seq,
        current_semantic: semanticFingerprintOfDefinition(current),
        reason:
          `记录时点的不可变施工图快照（plan ${shortRev(inForce.plan_revision)}）读不到或解析不了：` +
          "拿不到当时定义，按 unknown（保留旧判词）",
      });
      continue;
    }
    const histDefs = stableCheckDefinitionsOf(histDef);
    const hist = findCheck(histDefs, rec.check_id);
    if (hist === null) {
      out.set(key, {
        ...base,
        record_seq: seq,
        in_force: {
          definition_revision: inForce.definition_revision,
          definition_sha256: inForce.definition_sha256,
          plan_revision: inForce.plan_revision,
          source_ref: `task.definition_imported@seq:${inForce.seq}`,
        },
        current_semantic: semanticFingerprintOfDefinition(current),
        reason: `记录时点的定义里没有检查身份「${rec.check_id}」：无法证明这条记录按本条要求验过（保留旧判词）`,
      });
      continue;
    }
    const recordedSemantic = semanticFingerprintOfDefinition(hist);
    const currentSemantic = semanticFingerprintOfDefinition(current);
    const inForceRef = {
      definition_revision: inForce.definition_revision,
      definition_sha256: inForce.definition_sha256,
      plan_revision: inForce.plan_revision,
      source_ref: `task.definition_imported@seq:${inForce.seq}`,
    };
    if (recordedSemantic === currentSemantic) {
      out.set(key, {
        ...base,
        record_seq: seq,
        in_force: inForceRef,
        recorded_semantic: recordedSemantic,
        current_semantic: currentSemantic,
        verdict: "match",
        reason: null,
      });
      continue;
    }
    const diffs: string[] = [];
    if (canonicalCheckText(hist.label) !== canonicalCheckText(current.label)) diffs.push("检查正文已改");
    if (hist.required !== current.required) diffs.push("必需性已改");
    if (hist.independence_required !== current.independence_required) diffs.push("独审义务已改");
    if (diffs.length === 0) diffs.push("定义（位置/写法）已重排");
    out.set(key, {
      ...base,
      record_seq: seq,
      in_force: inForceRef,
      recorded_semantic: recordedSemantic,
      current_semantic: currentSemantic,
      verdict: "changed",
      reason:
        `检查身份「${rec.check_id}」在当前定义里的语义与记录时点（seq ${seq}，定义修订 ${inForce.definition_revision}）` +
        `不一致（${diffs.join("；")}）：同 stableID 语义变不得继承旧通过，也不得用当前定义给旧记录现填指纹` +
        "（DESIGN.md §2.5.1）",
    });
  }
  return out;
}

/**
 * 从**逐条检查记录的定义绑定**推导显式映射（位置型旧身份 → 稳定键；§2.5.1）。
 *
 * 为什么是它、而不是「扫历史找同名文本」：读取集合必须**有限且确定**——就是「需要映射的真实记录」
 * 及其「记录时点在效的那一版不可变定义」。`checkDefinitionBindingsOf` 已把每条记录落回它的账本 seq、
 * 取到当时在效的定义并与当前定义逐项比过语义（同一份快照、同一批解析），本函数**复用那份结论**，
 * 不再另扫任意历史（FIN-C：全项目 budget 会被最老任务耗尽的旧实现已移除）。
 *
 * 判据（严格，不按位置隐式套用）：
 *   · 该记录的定义绑定结论必须是 `match`（记录时点定义与当前定义**同语义**，逐项核过）；
 *   · 记录的 `check_id` 不是当前定义里的任何稳定键（否则**直接命中**，无需映射），
 *     但等于当前某条**稳定键**检查的 `legacy_position_id`（同一位置、同一语义 ⇒ 映射成立）；
 *   · 来源取该记录时点的不可变施工图快照定位符（`plan-revisions/<内容哈希>.md#<任务>`）；
 *     拿不到内容哈希就不产出（不拿裸字符串冒充来源，交由 `validateCheckIdentityMapping` 再核）。
 * 记录时点定义与当前不一致（`changed`：重排错位／同 ID 改义务）或快照取不回（`unknown`）
 * **都不产生映射**——旧证据不继承（fail-closed）。
 */
export function mappingFromDefinitionBindings(
  task_checks: Record<string, StableCheckDefinition[]>,
  bindings: readonly DefinitionBindingReadout[],
): CheckIdentityMapping {
  const out: CheckIdentityMappingEntry[] = [];
  const seen = new Set<string>();
  for (const b of bindings) {
    if (b.verdict !== "match") continue;
    const task_id = b.object_id.startsWith("task:") ? b.object_id.slice("task:".length) : b.object_id;
    const defs = task_checks[task_id];
    if (defs === undefined) continue;
    if (defs.some((d) => d.check_id === b.check_id)) continue; // 直接命中，无需映射
    const target = defs.find((d) => d.legacy_position_id === b.check_id && d.stable);
    if (target === undefined) continue;
    const planRevision = b.in_force?.plan_revision ?? "";
    if (planRevision === "") continue; // 拿不到可取回的来源 ⇒ 不采信
    const key = `${task_id}\u0000${b.check_id}\u0000${target.check_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      task_id,
      legacy_position_id: b.check_id,
      stable_check_id: target.check_id,
      definition_fingerprint: target.definition_fingerprint,
      source_ref: `plan-revisions/${planRevision}.md#${task_id}`,
    });
  }
  return out;
}

/** 校验一份映射是否**可采信**：逐条要求
 *   ① 任务在当前定义里有这条**位置型**身份；
 *   ② 该位置的当前 `check_id` 正是映射声明的稳定键；
 *   ③ 声明的定义指纹 == 当前定义的指纹（重排/改语义 ⇒ 指纹变 ⇒ 本条作废）。
 * 任一条不满足即**拒**（fail-closed），并如实回报原因——**不盲信任何调用方给的 map**。
 */
export function validateCheckIdentityMapping(
  mapping: CheckIdentityMapping,
  current: Record<string, StableCheckDefinition[]>,
  opts: { source_readable?: (source_ref: string) => boolean } = {},
): { accepted: CheckIdentityMapping; rejected: CheckIdentityMappingRejection[] } {
  const accepted: CheckIdentityMappingEntry[] = [];
  const rejected: CheckIdentityMappingRejection[] = [];
  for (const entry of mapping) {
    // ⓪ `source_ref` 必须是**可取回的正式来源**（不能随便填一个字符串就放行）：
    //    调用方给了可读回调时，取不回来即拒；没给回调（纯函数测试/旧调用方）行为不变。
    if (opts.source_readable !== undefined && !opts.source_readable(entry.source_ref)) {
      rejected.push({
        entry,
        reason:
          `映射声明的来源「${entry.source_ref}」**取不回来**（不是可读的不可变施工图快照）：` +
          "没有可核对的来源就不采信（§2.5.1；不拿字符串冒充真实性）",
      });
      continue;
    }
    const defs = current[entry.task_id];
    if (defs === undefined) {
      rejected.push({ entry, reason: `当前定义里没有任务 ${entry.task_id}` });
      continue;
    }
    const byLegacy = defs.find((d) => d.legacy_position_id === entry.legacy_position_id);
    if (byLegacy === undefined) {
      rejected.push({ entry, reason: `任务 ${entry.task_id} 当前定义里没有位置身份 ${entry.legacy_position_id}` });
      continue;
    }
    if (!byLegacy.stable || byLegacy.check_id !== entry.stable_check_id) {
      rejected.push({
        entry,
        reason:
          `位置身份 ${entry.legacy_position_id} 在当前定义里对应的是「${byLegacy.check_id}」，` +
          `不是映射声明的「${entry.stable_check_id}」（不按位置套用）`,
      });
      continue;
    }
    if (byLegacy.definition_fingerprint !== entry.definition_fingerprint) {
      rejected.push({
        entry,
        reason:
          `映射声明的定义指纹与当前定义对不上（当前 ${byLegacy.definition_fingerprint.slice(0, 12)}… / ` +
          `声明 ${entry.definition_fingerprint.slice(0, 12)}…）：定义重排/改语义后不得继承旧通过`,
      });
      continue;
    }
    accepted.push(entry);
  }
  return { accepted, rejected };
}

/** 映射表 → 查询用的裸表（`legacy_position_id → stable_check_id`） */
export function mappingTableOf(mapping: CheckIdentityMapping): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of mapping) out[e.legacy_position_id] = e.stable_check_id;
  return out;
}

export interface CheckIdentityVerdict {
  /** 采信身份：命中的稳定键 / 位置 id；不成立 = null */
  check_id: string | null;
  /** 是否走显式映射（旧位置身份 → 稳定键）；否则为 false */
  via_legacy_mapping: boolean;
  /** 不采信时的人话原因（点名缺映射） */
  reason: string | null;
}

/**
 * 一条**记录里出现的** check_id，在当前定义下归到哪个必需检查。
 *   ① 直接命中某条定义的 `check_id` ⇒ 采信；
 *   ② 命中某条定义的 `legacy_position_id`（旧位置身份）：
 *        · 该定义的 check_id 就是位置型（向后兼容）⇒ 采信（身份仍是位置型，如实标注）；
 *        · 该定义的 check_id 是稳定键 ⇒ **必须**有显式映射 `legacy_position_id → check_id` 才采信，
 *          否则不继承旧通过（identity unknown）。
 */
export function resolveCheckIdentity(
  recorded_check_id: string,
  defs: readonly StableCheckDefinition[],
  mapping: Readonly<Record<string, string>> = {},
): CheckIdentityVerdict {
  const direct = defs.find((d) => d.check_id === recorded_check_id);
  if (direct !== undefined) return { check_id: direct.check_id, via_legacy_mapping: false, reason: null };
  const byLegacy = defs.find((d) => d.legacy_position_id === recorded_check_id);
  if (byLegacy === undefined) {
    return {
      check_id: null,
      via_legacy_mapping: false,
      reason: `记录里的检查身份「${recorded_check_id}」在当前定义里找不到对应项（身份未知，不继承旧结论）`,
    };
  }
  if (!byLegacy.stable) return { check_id: byLegacy.check_id, via_legacy_mapping: false, reason: null };
  const mapped = mapping[recorded_check_id];
  if (mapped !== undefined && mapped === byLegacy.check_id) {
    return { check_id: byLegacy.check_id, via_legacy_mapping: true, reason: null };
  }
  return {
    check_id: null,
    via_legacy_mapping: false,
    reason:
      `记录里的位置型检查身份「${recorded_check_id}」没有到稳定键「${byLegacy.check_id}」的显式映射：` +
      "定义重排/改语义后**不得**按位置套用旧通过（DESIGN.md §2.5.1），该旧证据不继承",
  };
}

// ────────────────────────── 身份解析进事实通路（§2.5.1／§4.2） ──────────────────────────

export interface CheckIdentityReadout {
  recorded_check_id: string;
  object_id: string;
  /** 解析后的当前身份（null = 身份未知，该记录**不进投影**） */
  resolved_check_id: string | null;
  via: "direct" | "legacy_position" | "legacy_mapping" | "unknown" | "untyped";
  reason: string | null;
  /** 记录级**定义绑定**核对（记录时点的不可变定义 vs 当前定义）；没核对 = null */
  definition_binding?: DefinitionBindingReadout | null;
}

export interface CheckIdentityResolution {
  /** 进投影的检查记录（已按稳定身份归一；身份未知的**已剔除**，不给任何要求背书） */
  checks: CheckInput[];
  /** 逐条读数（含被剔除的；供读口如实展示） */
  readout: CheckIdentityReadout[];
  /** 身份未知而被剔除的记录（点名） */
  unknown: CheckIdentityReadout[];
}

/**
 * 把稳定身份/定义指纹**真正接进事实通路**：投影用的检查记录在这里按当前定义归一。
 *
 *   · 直接命中 / 位置型（无稳定键的老项目）⇒ 原样进投影；
 *   · 命中历史位置身份且有**显式映射** ⇒ 改写 `check_id` 为稳定键，使稳定键要求能吃到这条旧证据；
 *   · 身份未知（有稳定键但无映射）⇒ **剔除**（不进投影），并如实点名——缺项因此出现在 `missing` 里，
 *     而不是被静默当成通过。
 *
 * 记录的对象不在任务定义表里（模块/功能级检查）⇒ 原样保留（`untyped`），不由本函数判。
 */
export function applyCheckIdentities(
  checks: readonly CheckInput[],
  defsByTask: Record<string, StableCheckDefinition[]>,
  mapping: CheckIdentityMapping,
  opts: { definition_bindings?: ReadonlyMap<string, DefinitionBindingReadout> } = {},
): CheckIdentityResolution {
  const table = mappingTableOf(mapping);
  const bindings = opts.definition_bindings;
  const out: CheckInput[] = [];
  const readout: CheckIdentityReadout[] = [];
  for (const c of checks) {
    const defs = defsByTask[c.object_id];
    if (defs === undefined || defs.length === 0) {
      out.push(c);
      readout.push({
        recorded_check_id: c.check_id,
        object_id: c.object_id,
        resolved_check_id: c.check_id,
        via: "untyped",
        reason: null,
      });
      continue;
    }
    // 记录级定义绑定：记录时点的不可变定义与当前定义**语义不一致** ⇒ 该记录失效（不进投影）。
    // 这是"同 stableID 语义变、code binding 不变"的唯一拦截点：投影层看不见定义语义，
    // 只能在这里按"当时的定义"判（§2.5.1；WATCH 11:19/11:29）。
    const binding =
      bindings !== undefined && c.record_ref !== undefined
        ? bindings.get(definitionBindingKey(c.object_id, c.check_id, c.record_ref))
        : undefined;
    if (binding !== undefined && binding.verdict === "changed") {
      readout.push({
        recorded_check_id: c.check_id,
        object_id: c.object_id,
        resolved_check_id: null,
        via: "unknown",
        reason: binding.reason,
        definition_binding: binding,
      });
      continue;
    }
    const verdict = resolveCheckIdentity(c.check_id, defs, table);
    if (verdict.check_id === null) {
      readout.push({
        recorded_check_id: c.check_id,
        object_id: c.object_id,
        resolved_check_id: null,
        via: "unknown",
        reason: verdict.reason,
        ...(binding === undefined ? {} : { definition_binding: binding }),
      });
      continue;
    }
    const direct = verdict.check_id === c.check_id;
    if (!direct) out.push({ ...c, check_id: verdict.check_id });
    else out.push(c);
    readout.push({
      recorded_check_id: c.check_id,
      object_id: c.object_id,
      resolved_check_id: verdict.check_id,
      via: verdict.via_legacy_mapping ? "legacy_mapping" : direct ? "direct" : "legacy_position",
      reason: null,
      ...(binding === undefined ? {} : { definition_binding: binding }),
    });
  }
  return { checks: out, readout, unknown: readout.filter((r) => r.via === "unknown") };
}

// ────────────────────────── 功能范围（capability）义务（§4.2） ──────────────────────────

/**
 * 一个功能范围的义务输入：**逐条**给出该功能自己的必需检查与集成检查（来自 PLAN 映射表，
 * 由调用方从**同一份**施工图定义读来）。**不给整卡检查集合**——避免把同一张卡里属于别的范围的
 * 检查拖进本范围，也避免漏掉功能集成检查。
 */
export interface FeatureObligationInput {
  feature_id: string;
  /** PLAN 映射表的「承接卡」列 */
  task_ids: string[];
  /** PLAN 映射表的「必需检查」列（稳定 ID 形态） */
  required_check_ids: string[];
  /** PLAN 映射表的「集成检查」列（稳定 ID 形态） */
  integration_check_ids: string[];
  /** 声明区的「本期范围」列：明确 scope_id 或 null（null ⇒ 不给通过结论） */
  scope_id: string | null;
  /** 该功能在 PLAN 功能映射表里有没有对应行（没有 ⇒ 未归属，不给通过结论） */
  mapped: boolean;
}

/** 功能范围的用户接受读数（**按范围真实采信**：单卡 accepted ≠ 多卡功能 accepted） */
export interface FeatureAcceptanceReadout {
  state: AcceptanceDimension;
  /** 支撑判词的 Gate 记录（**与判词对应**，不是"第一条"） */
  gate_refs: string[];
  /** 有 Gate 的成员任务 */
  accepted_tasks: string[];
  /** 未覆盖成员的人话说明（非 pending 时也可能有） */
  unmet: string | null;
}

/** 功能范围的一条集成检查逐项有效状态（**只从同一份投影摘录**，不另判） */
export interface FeatureIntegrationEvidence {
  check_id: string;
  label: string;
  required: boolean;
  /** 逐项有效口径（与 `statusProjection` 的证据分档同源；`missing` = 没有任何有效记录） */
  state: "passed" | "failed" | "missing" | "stale" | "unknown" | "not_checked";
  /** 投影里给的人话原因（拿不到时 null） */
  why: string | null;
}

export interface FeatureObligationReadout {
  feature_id: string;
  object: StatusObjectInput;
  /** 该功能范围的**主状态投影**（同一份 `projectStatuses` 判据的产物，不是"各卡最差"） */
  projection: StatusProjection;
  acceptance: FeatureAcceptanceReadout;
  /** 输入侧缺口（范围未定 / 未映射 / 集成检查缺失 / 检查不在定义里），逐条点名 */
  input_gaps: string[];
  /**
   * 本功能的**集成检查逐项有效状态**（六图/工作包按同一份结论消费；DESIGN §4.2「父级全部通过
   * 要求所有必需子项**及自身集成检查**通过」）。**子项全绿不等于集成通过**：这里 `state` 全为
   * `passed` 才是集成通过；缺一条就是缺口（`missing`/`unknown`），不按空集判绿。
   */
  integration_evidence: FeatureIntegrationEvidence[];
}

/** 装配阶段的读数（还没有投影；投影由 `projectStatuses` 一次算完后回填） */
type FeatureScopeReadout = Omit<FeatureObligationReadout, "projection" | "integration_evidence">;

export interface ObligationSet {
  /** 主状态投影（唯一绿公式的产物；含任务/模块/依赖线与**功能范围**对象） */
  projection: StatusProjectionSet;
  /** 进投影的检查记录（已按稳定身份归一） */
  checks: CheckInput[];
  /** 装配进投影的对象（原样带出；任务/模块/依赖线） */
  objects: StatusObjectInput[];
  /** 每个任务对象的稳定检查定义（含指纹/必需/独审） */
  task_checks: Record<string, StableCheckDefinition[]>;
  /** 事实源修订（与投影同一份） */
  source_revision: SourceRevisions;
  /** 功能范围读数（key = feature_id） */
  features: Record<string, FeatureObligationReadout>;
  /** check 身份解析读数（含被剔除的未知身份记录）＋ 逐条记录的**定义绑定**核对 */
  check_identity: CheckIdentityResolution & {
    mapping_rejected: CheckIdentityMappingRejection[];
    definition_bindings: DefinitionBindingReadout[];
  };
  /** 额外并入本次投影的对象（如范围/能力对象）；与其余对象**同一份** `projectStatuses` 判据 */
  extra_objects: StatusObjectInput[];
}

/**
 * 唯一「义务 / 状态」派生入口。
 * **不另写绿公式**：主状态与缺口一律来自 `projectStatuses`。
 */
export function deriveObligations(input: {
  project_id: string;
  data_dir: string;
  /** 一次读齐的事实（调用方用 `collectProjectFacts` 取一份，不重复读盘） */
  facts: ProjectFacts;
  /** 该 revision 的检查记录（缺省 `checksFromFacts(facts)`） */
  checks?: CheckInput[];
  /** 显式映射（须由可读正式来源推导并经 `validateCheckIdentityMapping`；缺省 = 本层自行从定义历史推导） */
  check_identity_mapping?: CheckIdentityMapping;
  /**
   * 该 revision 的**原始事件**（与 `facts` 同一快照）。给了它，身份映射就由**本层**从
   * 「不可变施工图快照里的历史定义」推导（可读正式来源 + 当前定义指纹绑定）；
   * 不给 ⇒ 只做直接命中/位置型兼容，**不做**位置型→稳定键的映射（fail-closed：旧位置证据不继承），
   * 并在 `check_identity.mapping_rejected` 里如实说明原因。
   */
  events?: readonly WorkEvent[];
  /**
   * **不可采信**的裸映射（旧签名遗留）：没有定义指纹、也没有可读来源，按 fail-closed **忽略**，
   * 并把忽略原因如实回报（`check_identity.mapping_rejected`）。保留字段是为了兼容既有调用方，
   * 不表示它会生效（§2.5.1：不盲信调用方给的 map）。
   */
  legacy_check_mapping?: Readonly<Record<string, string>>;
  /** 变更批次身份（scope）；不给 = null（不猜） */
  scope_id?: string | null;
  /** 功能范围义务（缺省无：只派生任务/模块/依赖线，行为与接线前一致） */
  features?: readonly FeatureObligationInput[];
  /** 施工图功能映射是否被有效基线批准（false/缺省 ⇒ 映射声明的检查集合不据此判绿） */
  plan_mapping_approved?: boolean;
  /** 生效基线批准的施工图修订（解释用；拿不到 = null） */
  plan_mapping_revision?: string | null;
  /** 施工图的「集成检查要求」（唯一权威承载；in_force 由事实决定） */
  integration_requirements?: ProjectIntegrationRequirements | null;
  /**
   * **额外并入本次投影的对象**（canonical `StatusObjectInput` 形态，如 B5 的范围/能力对象）。
   * 为什么要有这个入口：范围对象的判绿必须与任务/模块**同一次** `projectStatuses`、同一份检查记录，
   * 各读口（六图、`GET /status-projection`）不得各自再拼一次（拼漏 feature 对象转接的检查 ⇒ 假绿，
   * B5 复审实测）。并入本层即得唯一结论，读口只做只读适配。
   */
  extra_objects?: readonly StatusObjectInput[];
}): ObligationSet {
  const { facts } = input;
  const rawChecks = input.checks ?? checksFromFacts(facts);
  const task_checks = stableCheckDefinitionsByTask(facts.definitions);

  // 记录级**定义绑定**核对：把每条记录落回它的账本 seq，取当时在效的不可变定义逐项比对语义。
  // 只有拿到了原始事件才做（拿不到一律 unknown ⇒ 保留旧判词）。**先算**：身份映射要复用它的结论。
  const definitionBindings =
    input.events === undefined
      ? null
      : checkDefinitionBindingsOf({
          project_id: input.project_id,
          data_dir: input.data_dir,
          events: input.events,
          task_checks,
          records: rawChecks,
        });

  // ① 身份映射：只采信**可读正式来源推导 + 定义指纹绑定**的映射；裸映射一律忽略并回报。
  const provenanceRejections: CheckIdentityMappingRejection[] = [];
  let supplied: CheckIdentityMapping = input.check_identity_mapping ?? [];
  if (definitionBindings !== null) {
    // 有限集合、确定来源：只从**每条记录自己时点在效的不可变定义**推导位置型→稳定键映射
    // （复用上面的逐条定义绑定结论；不扫任意历史找同名文本，不按位置隐式继承）。
    const derived = mappingFromDefinitionBindings(task_checks, [...definitionBindings.values()]);
    if (derived.length > 0) supplied = [...supplied, ...derived];
  }
  if (
    supplied.length === 0 &&
    input.events === undefined &&
    Object.values(task_checks).some((defs) => defs.some((d) => d.stable))
  ) {
    // 只有**确实没传 `events`**时才可能落到这条：传了 events 时映射由逐条定义绑定推导，
    // 推导不出是"记录与定义对不上"，不在这里误报成"未传 events"（WATCH 12:16）。
    provenanceRejections.push({
      entry: {
        task_id: "",
        legacy_position_id: "",
        stable_check_id: "",
        definition_fingerprint: "",
        source_ref: "（无）",
      },
      reason:
        "调用方没有传 `events`（本次快照的原始事件）：拿不到可核的记录时点定义，位置型旧身份**不映射**" +
        "到稳定键，这类旧证据不继承（fail-closed，不按位置猜）",
    });
  }
  const validated = validateCheckIdentityMapping(supplied, task_checks, {
    // 显式映射的来源必须**真的可取回**：`plan-revisions/<hash>.md[#task]` → 核快照可读。
    // 用**同一份** `planSnapshotReader`：既认「定义哈希」主名，也认同定义哈希下按「内容哈希」
    // 另存的正文（§2.6）；其他形态（含调用方自造的路径）一律不可读 ⇒ 拒（不因"填了个字符串"就放行）。
    // 同一来源只核一次（有界来源，避免重复读同一份快照）。
    source_readable: (() => {
      const cache = new Map<string, boolean>();
      const readPlan = planSnapshotReader(input.project_id, input.data_dir);
      return (ref: string) => {
        const hit = cache.get(ref);
        if (hit !== undefined) return hit;
        const m = /^plan-revisions\/([0-9a-f]{64})\.md(?:#.*)?$/.exec(ref.trim());
        const ok = m !== null && readPlan(m[1]) !== null;
        cache.set(ref, ok);
        return ok;
      };
    })(),
  });
  const legacyRejected: CheckIdentityMappingRejection[] = Object.entries(input.legacy_check_mapping ?? {}).map(
    ([legacy, stable]) => ({
      entry: {
        task_id: legacy.includes("::") ? legacy.slice(0, legacy.indexOf("::")) : "",
        legacy_position_id: legacy,
        stable_check_id: stable,
        definition_fingerprint: "",
        source_ref: "（调用方直传）",
      },
      reason:
        `拒绝调用方直传的裸映射「${legacy} → ${stable}」：没有定义指纹、没有可读正式来源，` +
        "无法证明它绑到的是**不可变定义**（§2.5.1）；请从不可变施工图快照推导映射",
    }),
  );
  const identity = applyCheckIdentities(
    rawChecks,
    task_checks,
    validated.accepted,
    definitionBindings === null ? {} : { definition_bindings: definitionBindings },
  );
  const check_identity = {
    ...identity,
    mapping_rejected: [...provenanceRejections, ...validated.rejected, ...legacyRejected],
    definition_bindings: definitionBindings === null ? [] : [...definitionBindings.values()],
  };
  const checks = identity.checks;

  // 人工验收按对象取（任务按 task_id；模块/连线只看批次级或 pending）——不接受"质量状态代写验收"
  const withAcceptance = (objs: StatusObjectInput[]): StatusObjectInput[] =>
    objs.map((o) => ({
      ...o,
      acceptance:
        o.object_kind === "task"
          ? acceptanceDimensionOf(Object.values(facts.audit.acceptances), { task_id: o.object_id })
          : ("pending" as const),
    }));

  // 两趟：先算每条依赖线的"前置是否释放"，再让依赖线带上释放结论（依赖释放不看前卡自报 done）
  const pass1 = projectStatuses({
    objects: withAcceptance(objectsFromFacts(input.project_id, input.data_dir, facts)),
    findings: facts.findings,
    checks,
    source_revision: facts.revisions,
    binding_segments: facts.binding_segments,
  });
  const releases: Record<string, { released: boolean; reasons: string[] }> = {};
  for (const def of facts.definitions) {
    for (const dep of def.dependency_ids) {
      const prereq = pass1.by_id[dep];
      if (prereq === undefined) continue;
      releases[`${dep}->${def.task_id}`] = dependencyRelease({
        prerequisite_id: dep,
        prerequisite: prereq,
        evidence_requirement: def.dependency_evidence.find((d) => d.dependency_id === dep)?.evidence ?? null,
      });
    }
  }
  const objects = withAcceptance(
    objectsFromFacts(input.project_id, input.data_dir, facts, { dependency_releases: releases }),
  );

  // ② 功能范围对象：**逐条**用显式 required_check_ids / integration_check_ids 装配。
  const integrationReq = input.integration_requirements ?? facts.integration_requirements;
  const { featureObjects, featureChecks, features } = buildFeatureScopes({
    features: input.features ?? [],
    task_checks,
    checks,
    facts,
    integrationReq,
    plan_mapping_approved: input.plan_mapping_approved ?? false,
    plan_mapping_revision: input.plan_mapping_revision ?? null,
  });

  const projection = projectStatuses({
    objects: [...objects, ...featureObjects, ...(input.extra_objects ?? [])],
    findings: facts.findings,
    checks: [...checks, ...featureChecks],
    source_revision: facts.revisions,
    binding_segments: facts.binding_segments,
  });

  const featuresOut: Record<string, FeatureObligationReadout> = {};
  // 独审义务不能在聚合里被抹掉：检查文本要求**非作者复核**的项，若当前采信的只是作者自检证据，
  // 必须在缺口里点名（§2.7 independence_required／§5.8：作者不为自己签独审）。
  const independenceRequired = new Set<string>();
  for (const defs of Object.values(task_checks)) {
    for (const d of defs) if (d.independence_required) independenceRequired.add(d.check_id);
  }
  for (const f of featureObjects) {
    const read = features[f.object_id];
    const proj = projection.by_id[f.object_id];
    const gaps = [...read.input_gaps];
    for (const e of proj.evidence_basis) {
      if (e.effective === "passed" && independenceRequired.has(e.check_id) && e.independence === "author_self") {
        gaps.push(
          `「${e.check_id}」要求非作者复核，但当前采信的是**作者自检**证据（独审未过，不当作已独立复核）`,
        );
      }
    }
    // 集成检查逐项有效状态（六图/工作包按同一份投影消费；不另判一套）
    const integrationEvidence: FeatureIntegrationEvidence[] = (read.object.integration_checks ?? []).map((req) => {
      const basis = proj.evidence_basis.find((e) => e.check_id === req.check_id);
      const miss = proj.missing.find((m) => m.check_id === req.check_id);
      const state: FeatureIntegrationEvidence["state"] =
        basis !== undefined ? basis.effective : miss !== undefined ? "missing" : "unknown";
      return {
        check_id: req.check_id,
        label: req.label,
        required: req.required !== false,
        state,
        why: basis !== undefined ? null : (miss?.why ?? null),
      };
    });
    featuresOut[f.object_id] = { ...read, projection: proj, input_gaps: gaps, integration_evidence: integrationEvidence };
  }

  return {
    projection,
    checks,
    objects,
    task_checks,
    source_revision: facts.revisions,
    features: featuresOut,
    check_identity,
    extra_objects: [...(input.extra_objects ?? [])],
  };
}

/** 功能范围装配（唯一义务层的内部步骤；**不新造绿公式**——判绿仍由 projectStatuses 做） */
function buildFeatureScopes(args: {
  features: readonly FeatureObligationInput[];
  task_checks: Record<string, StableCheckDefinition[]>;
  checks: readonly CheckInput[];
  facts: ProjectFacts;
  integrationReq: ProjectIntegrationRequirements;
  plan_mapping_approved: boolean;
  plan_mapping_revision: string | null;
}): {
  featureObjects: StatusObjectInput[];
  featureChecks: CheckInput[];
  features: Record<string, FeatureScopeReadout>;
} {
  const { features, task_checks, checks, facts, integrationReq } = args;
  // check_id → 人话标签（来自当前定义；查不到就如实点名"定义里没有这条检查"）
  const labelOf = new Map<string, string>();
  for (const defs of Object.values(task_checks)) {
    for (const d of defs) labelOf.set(d.check_id, normalizeCheckText(d.label));
  }
  const featureObjects: StatusObjectInput[] = [];
  const featureChecks: CheckInput[] = [];
  const readouts: Record<string, FeatureScopeReadout> = {};

  for (const f of features) {
    const gaps: string[] = [];
    const required: RequirementInput[] = [];
    const integrationReqs: RequirementInput[] = [];
    const declaredIntegration =
      integrationReq.declared && integrationReq.in_force ? integrationReq.by_object[f.feature_id] ?? [] : [];
    const declaredIds = new Set(declaredIntegration.map((c) => c.check_id));

    for (const id of f.required_check_ids) {
      const label = labelOf.get(id);
      if (label === undefined) {
        gaps.push(`必需检查 ${id} 不在任何任务定义里（查不到就是缺口，不按空集合通过）`);
      }
      required.push({ check_id: id, label: label ?? `${id}（当前任务定义里没有这条检查）`, required: true });
    }
    if (f.required_check_ids.length === 0) {
      gaps.push("PLAN 映射表没有给出「必需检查」：输入缺口不得按空集合通过");
    }

    // 集成检查：权威承载是施工图的「集成检查要求」小节（须被有效基线批准生效）。
    for (const c of declaredIntegration) {
      integrationReqs.push({ check_id: c.check_id, label: normalizeCheckText(c.label), required: c.required });
    }
    for (const id of f.integration_check_ids) {
      if (declaredIds.has(id)) continue;
      gaps.push(
        `集成检查 ${id} 只在 PLAN 映射表里列了，施工图「集成检查要求」小节里没有它` +
          `（${integrationReq.in_force ? "未声明" : integrationReq.not_in_force_reason ?? "未生效"}）：不据此判绿`,
      );
      integrationReqs.push({
        check_id: id,
        label: `${id}（施工图未声明该集成检查 / 未获有效基线批准）`,
        required: true,
      });
    }
    if (integrationReqs.length === 0) {
      // 父级/能力：没有集成证据就不算集成通过（§4.2）——用一条不可能命中的要求把缺口摆出来
      gaps.push(
        integrationReq.declared
          ? `本功能没有可用的集成检查要求（${integrationReq.not_in_force_reason ?? "声明未生效"}）：子项全绿不等于集成通过`
          : "本功能没有集成检查要求：子项全绿不等于集成通过（§4.2）",
      );
      integrationReqs.push({
        check_id: `${f.feature_id}::integration`,
        label: "自身集成检查（本功能未声明/未生效集成检查要求）",
        required: true,
      });
    }

    if (f.scope_id === null) {
      gaps.push("「本期范围」为 null：范围未定，不给该功能通过结论（DESIGN.md §2.5.1）");
      required.push({
        check_id: `${f.feature_id}::scope`,
        label: "本期范围未定（scope_id=null）：不给通过结论",
        required: true,
      });
    }
    if (!f.mapped) {
      gaps.push("PLAN 功能映射表里没有本功能行：未归属，不给通过结论");
      required.push({
        check_id: `${f.feature_id}::mapping`,
        label: "PLAN 功能映射表缺本功能行（未归属）",
        required: true,
      });
    } else if (!args.plan_mapping_approved) {
      gaps.push(
        `PLAN 功能映射未被有效基线批准（批准的施工图修订 ${shortRev(args.plan_mapping_revision)}）：` +
          "未获批准的定义不据此判绿",
      );
      required.push({
        check_id: `${f.feature_id}::mapping`,
        label: "PLAN 功能映射未获有效基线批准",
        required: true,
      });
    }

    // 执行事实：本功能成员任务的执行并集（无成员 ⇒ 无运行记录，不写"未实现"）
    const executions: StatusObjectInput["executions"] = [];
    for (const tid of f.task_ids) {
      const s = facts.task_states[tid];
      if (s === undefined) continue;
      executions.push({
        task_id: s.task_id,
        status: s.status,
        actor_id: s.owner_id ?? s.last_actor,
        updated_at: s.updated_at,
      });
    }
    const findingIds = facts.findings
      .filter((x) => x.object_id !== null && f.task_ids.includes(x.object_id))
      .map((x) => x.finding_id);

    const object: StatusObjectInput = {
      object_id: f.feature_id,
      object_kind: "capability",
      label: f.feature_id,
      executions,
      required_checks: required,
      integration_checks: integrationReqs,
      // 集成检查要求的来源如实标注：来自施工图的版本化定义（随有效基线生效），不是调用方临时声明
      integration_checks_source: declaredIntegration.length > 0 ? "plan" : "none",
      integration_checks_revision: declaredIntegration.length > 0 ? integrationReq.plan_revision : null,
      integration_checks_blocked_reason: integrationReq.not_in_force_reason,
      finding_ids: findingIds,
      revisions: facts.revisions,
      // 范围未定 / 未映射：明确"未映射"，不空集判绿
      unmapped: f.scope_id === null || !f.mapped ? true : undefined,
    };

    // 本功能自己的检查记录：**只**取本功能声明的检查（局部检查不被同一张卡的其他检查拖累），
    // 归属改写到功能对象（同一条记录 → 同一份 projectStatuses 判据，不另算绿公式）。
    const wanted = new Set<string>([...f.required_check_ids, ...integrationReqs.map((c) => c.check_id)]);
    for (const c of checks) {
      if (!wanted.has(c.check_id)) continue;
      featureChecks.push({ ...c, object_id: f.feature_id });
    }

    featureObjects.push(object);
    readouts[f.feature_id] = {
      feature_id: f.feature_id,
      object,
      acceptance: featureAcceptanceOf(f, facts),
      input_gaps: gaps,
    };
  }
  return { featureObjects, featureChecks, features: readouts };
}

/** 修订的短写法（进人话；拿不到如实写"未知"） */
function shortRev(rev: string | null | undefined): string {
  return typeof rev === "string" && rev !== "" ? `${rev.slice(0, 12)}…` : "（未知）";
}

/**
 * 功能范围的**用户接受**读数（§5.8／附录 E.9）：
 *   · 只有**覆盖本范围**的 Gate 才算数——全部成员任务都有接受 Gate，或有一条**批次级**
 *     （`batch_id === scope_id`）Gate；单卡 accepted **不**代表多卡功能 accepted；
 *   · 任一覆盖 Gate 判 reject ⇒ rejected；全部为 known_limit ⇒ accepted_known_limit；
 *   · `gate_ref` 只带**真正支撑该判词**的记录（不是"随便第一条"）；
 *   · 没有覆盖本范围的 Gate ⇒ pending（不借别的卡的 Gate）。
 */
export function featureAcceptanceOf(
  f: Pick<FeatureObligationInput, "feature_id" | "task_ids" | "scope_id">,
  facts: ProjectFacts,
): FeatureAcceptanceReadout {
  const gates = Object.values(facts.audit.acceptances);
  const batch = f.scope_id === null ? [] : gates.filter((g) => g.batch_id === f.scope_id);
  const perTask = f.task_ids.map((tid) => {
    const own = gates.filter((g) => g.task_id === tid);
    const latest = latestOf(own);
    return { task_id: tid, record: latest };
  });
  const acceptedTasks = perTask.filter((t) => t.record !== null && t.record.decision !== "reject").map((t) => t.task_id);

  const deciding = [...batch, ...perTask.map((t) => t.record).filter((r): r is NonNullable<typeof r> => r !== null)];
  const ordered = deciding.slice().sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const rejects = ordered.filter((g) => g.decision === "reject");
  if (rejects.length > 0) {
    return {
      state: "rejected",
      gate_refs: rejects.map((g) => g.record_id),
      accepted_tasks: acceptedTasks,
      unmet: `有用户退回记录：${rejects.map((g) => g.record_id).join("、")}（§5.8：退回暂停受影响范围的交付资格）`,
    };
  }

  const coversAll =
    f.task_ids.length > 0 && perTask.every((t) => t.record !== null && t.record.decision !== "reject");
  if (batch.length > 0 || coversAll) {
    const backers = (batch.length > 0 ? batch : perTask.map((t) => t.record!)).slice();
    const uniq = [...new Set(backers.map((g) => g.record_id))].sort();
    const allKnownLimit = backers.every((g) => g.decision === "accept_known_limit");
    const unmet =
      f.task_ids.length > 0 && !coversAll
        ? `批次级 Gate 覆盖本范围，但成员并未全部有接受记录（已接受 ${acceptedTasks.length}/${f.task_ids.length}）`
        : null;
    return {
      state: allKnownLimit ? "accepted_known_limit" : "accepted",
      gate_refs: uniq,
      accepted_tasks: acceptedTasks,
      unmet,
    };
  }

  const missing = f.task_ids.filter((t) => !acceptedTasks.includes(t));
  return {
    state: "pending",
    gate_refs: [],
    accepted_tasks: acceptedTasks,
    unmet:
      f.task_ids.length === 0
        ? "本功能没有可接受的任务成员：没有范围证据，不借别的卡的用户 Gate"
        : `本范围还有成员没有用户接受 Gate（${missing.join("、")}）：单卡 accepted 不代表多卡功能 accepted`,
  };
}

/** 取时间上最新的一条（时间解析不出来的一律排在有效值之前；并列取后者，稳定可复现） */
function latestOf<T extends { at: string }>(rows: readonly T[]): T | null {
  let best: T | null = null;
  for (const r of rows) {
    if (best === null) {
      best = r;
      continue;
    }
    const a = Date.parse(r.at);
    const b = Date.parse(best.at);
    if (Number.isNaN(a)) continue;
    if (Number.isNaN(b) || a >= b) best = r;
  }
  return best;
}

/** 便捷：任务对象 → 它的必需检查清单（定义里没有就返回空数组） */
export function requiredChecksOf(set: ObligationSet, task_id: string): StableCheckDefinition[] {
  return set.task_checks[task_id] ?? [];
}

// ─────────────── 范围（scope）版本：**唯一算法**，六图 / feature-ledger / 工作包共用 ───────────────

/**
 * 一个范围的**成员账目 + 检查定义版本**（`scope_revision` 的唯一算法出处）。
 *
 * 为什么必须只有一处：`scope_revision` 被六图、`feature_ledger`、工作包与 UI 同时消费；两处各写一套
 * 算法就会出现"同一 scope 同版本串不同值"，跨接口对不上账（B5 复审实测：B2 用
 * `sha256({plan_definition, design})`、B5 用成员+检查定义指纹）。本函数把**同一件事**算一次：
 *   · `members` = 该范围的成员（声明归属；卡号归一为 `plan:task:<id>`）；
 *   · `checks` = 该范围的必需/集成检查**及其实际定义指纹**（取不到定义时用 `missing:<id>` 如实标注，
 *     不用裸 checkID 冒充、也不用 null——否则"同 ID 改语义"不会改变版本串）；
 *   · `scope_revision` = 纯函数 `scopeRevisionOf`（`src/arch/featureScope.ts`，重排不变、语义变即变）。
 *
 * **不 alias 两种范围 ID**：`plan:cap:*`（蓝图能力）与 `cap-loop-*`（声明区功能）各自调用本函数，
 * 成员来源不同（蓝图正式关系 vs PLAN 映射承接卡），但**算法与版本口径完全一致**。
 */
export interface ScopeVersionInput {
  scope_id: string;
  /** 成员卡号（可带或不带 `plan:task:` 前缀） */
  member_task_ids: readonly string[];
  required_check_ids: readonly string[];
  integration_check_ids: readonly string[];
  /** 定义版本来源：逐任务的定义表（本层 `task_checks`，唯一出处） */
  task_checks: Record<string, StableCheckDefinition[]>;
}

export interface ScopeVersionReadout {
  scope_id: string;
  scope_revision: string;
  members: ScopeMemberEntry[];
  checks: ScopeCheckDefinitionRef[];
}

export function scopeVersionOf(input: ScopeVersionInput): ScopeVersionReadout {
  const memberIds = [...new Set(input.member_task_ids.map((t) => (t.startsWith("plan:task:") ? t : `plan:task:${t}`)))]
    .sort();
  const members: ScopeMemberEntry[] = memberIds.map((id) => ({
    id,
    kind: scopeMemberKindOf(id),
    via: ["task_design_ref"] as ScopeMemberVia[],
  }));
  const fingerprintOf = (check_id: string): string => {
    for (const defs of Object.values(input.task_checks)) {
      const hit = defs.find((d) => d.check_id === check_id);
      if (hit !== undefined) return hit.definition_fingerprint;
    }
    // 定义里没有这条检查：如实标注（不是 null、也不是裸 checkID）
    return `missing:${check_id}`;
  };
  const seen = new Set<string>();
  const checks: ScopeCheckDefinitionRef[] = [];
  const push = (check_id: string, role: ScopeCheckDefinitionRef["role"]): void => {
    const key = `${role ?? "other"}:${check_id}`;
    if (seen.has(key)) return;
    seen.add(key);
    checks.push({ check_id, definition_fingerprint: fingerprintOf(check_id), role });
  };
  for (const id of input.required_check_ids) push(id, "required");
  for (const id of input.integration_check_ids) push(id, "integration");
  checks.sort((a, b) => a.check_id.localeCompare(b.check_id));
  return {
    scope_id: input.scope_id,
    scope_revision: scopeRevisionOf({ scope_id: input.scope_id, members, checks }),
    members,
    checks,
  };
}

/** 定义里该任务是否"有定义但没有检查项"（用于缺口点名，不按空集合判绿） */
export function definitionHasNoChecks(def: TaskDefinition): boolean {
  return requiredChecksFromDefinitions([def])[def.task_id]?.length === 0;
}

/**
 * 五档证据状态：**只从那一份 canonical 投影**推（不读别处、不另算一套）。
 * 判据与 `src/ui/arch/provenance.ts#evidenceStateOf` 同序（BLOCKING = invalidated/missing/unverified），
 * 但输入只有投影字段——保证「一个事实、一次派生」（§2.6／§4.2）。
 */
export function evidenceStateOfProjection(p: StatusProjection): EvidenceState {
  const stale = p.evidence_basis.some((e) => e.effective === "stale" || e.effective === "unknown");
  if (p.history.length > 0 || p.freshness !== "fresh" || p.quality === "evidence_invalid" || stale) {
    return "invalidated";
  }
  if (p.required_count === 0) return "missing";
  if (p.display_status === "verified") return "verified";
  if (p.evidence_basis.length === 0) return "missing";
  return "unverified";
}
