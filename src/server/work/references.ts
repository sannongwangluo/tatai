// 任务定义 → 需求 / 变更批次的**真引用**校验（T21 的 I-1/I-2，DESIGN.md §2.5 / §2.6 / §2.7 / §2.9；
// 批3 C-015 起把校验接上真实入口，不再只长在没人调用的包装上）。
//
// 落点说明（卡面要求"planValidate.ts 同族风格 + 既有校验链的自然位置，不另开后门"）：
//   · 结构校验仍在 `plan.ts` 的 `validateTaskDefinitions` / `assertTaskDefinitionsValid`——本文件
//     不重复造，也不改它的口径（加一条新校验不能顺手改旧校验的结论）；
//   · 这里只补**一条跨对象校验**：定义里的 `requirement_ids` / `change_id` 必须能在**投影**里解析到。
//     投影就是 `requirements.ts` / `changes.ts` 从同一条 `work/events.jsonl` 折出来的对象——
//     引用查的是"已提交事实"，不是调用方手里的清单，所以没有"先写后补"的窗口。
//   · 校验挂的**真实入口**（C-015 接线）：`importPlanChecked`（受检导入，tasks.ts `alignPlanWithWork`
//     与 `GET /api/projects/:id/plan`、MCP `import_plan_definitions` 都走它）＋
//     `assertImportSubmissionReferences`（`submitDefinitionImports` 提交前调用——带引用的定义
//     必须给出投影读侧，查不了已提交事实就 fail-closed 拒，不凭调用方自报清单放行）＋
//     `readDefinitionReferencePayload`（C-015 复核返修：`WorkService.submit` 服务边界对直连的
//     `task.definition_imported` 用同一对键名/同一形态判定取出引用元数据，再用同一份
//     `validateDefinitionReferences` 核验——包装层预检、服务边界、读侧入口三处判据单源）。
//   · 表述复用同一套 `PlanIssue` / `describePlanIssues`（`planValidate.ts` 补了
//     `dangling_requirement` / `dangling_change` 两个 problem 取值），错误码与施工定义校验一致，
//     仍是 `INVALID_COMMAND`，且**在动磁盘之前**抛出（一个字节都不写）。
//   · **旧数据路径零改动**：`requirement_ids` 为 `null`/空数组、`change_id` 为 `null` 的定义，
//     一条都不查——迁移前的现场照旧通过（这也是 T21 验收的第 6 条）。直连写口的兼容形态同理：
//     payload 两个引用键都不在 = 旧形态（历史事件/旧调用方），服务边界一条都不查；
//     任一键在 = 新形态，形态与引用都必查（`readDefinitionReferencePayload`，可判不猜）。
import { importTaskDefinitions, parseRequirementMap, type ImportTaskOptions, type TaskDefinition, type TaskImportResult } from "./plan";
import { describePlanIssues, type PlanIssue } from "./planValidate";
import { WorkError } from "./types";
import { readRequirements, requirementIdsOf } from "./requirements";
import { changeIdsOf, readChanges } from "./changes";

/** 已登记的可引用对象 id 集（从投影里取，不在调用方手里拼） */
export interface RegisteredReferences {
  requirement_ids: readonly string[];
  change_ids: readonly string[];
}

/** 读一个项目的 work 目录，收集可引用的需求 / 变更批次 id（各读一次事件流，纯派生） */
export function collectRegisteredReferences(workDir: string): RegisteredReferences {
  return {
    requirement_ids: requirementIdsOf(readRequirements(workDir)),
    change_ids: changeIdsOf(readChanges(workDir)),
  };
}

// ── 引用元数据的事件形态（C-015 复核返修：写口与服务边界共用同一对键名与同一份形态判定） ──

/** `task.definition_imported` 新形态 payload 携带引用元数据的两个键名（写口/服务/验证脚本不各写各的） */
export const DEFINITION_REQUIREMENT_IDS_KEY = "requirement_ids";
export const DEFINITION_CHANGE_ID_KEY = "definition_change_id";

/** `readDefinitionReferencePayload` 的返回（`null` = 旧形态：历史事件/旧调用方，一条都不查） */
export interface DefinitionReferencePayload {
  requirement_ids: string[] | null;
  change_id: string | null;
}

const preview = (v: unknown): string => {
  const s = JSON.stringify(v) ?? String(v);
  return s.length > 80 ? `${s.slice(0, 80)}…` : s;
};

/**
 * `task.definition_imported` payload 的引用元数据形态判定（明确可判的向后兼容形态，不猜）：
 *   · 两个键都不在 → 返回 `null`：旧形态，调用方按旧路径放行（行为与接线前逐字节一致）；
 *   · 任一键在 → 新形态：`requirement_ids` 必须是 null 或非空字符串数组；`definition_change_id`
 *     必须是 null 或非空字符串（空串按 null 归一，与 `validateDefinitionReferences` 的跳过口径一致）；
 *     形态不合法抛 `INVALID_COMMAND` 并点名字段——新路径必须可判，不能"看着像引用却解析不了"还放行。
 */
export function readDefinitionReferencePayload(
  payload: Record<string, unknown>,
): DefinitionReferencePayload | null {
  const hasReq = Object.prototype.hasOwnProperty.call(payload, DEFINITION_REQUIREMENT_IDS_KEY);
  const hasChg = Object.prototype.hasOwnProperty.call(payload, DEFINITION_CHANGE_ID_KEY);
  if (!hasReq && !hasChg) return null;

  const rawReq = payload[DEFINITION_REQUIREMENT_IDS_KEY];
  let requirementIds: string[] | null = null;
  if (rawReq !== undefined && rawReq !== null) {
    if (!Array.isArray(rawReq) || rawReq.some((v) => typeof v !== "string" || v === "")) {
      throw new WorkError(
        "INVALID_COMMAND",
        `${DEFINITION_REQUIREMENT_IDS_KEY} 必须是 null 或非空字符串数组（任务定义引用元数据形态必须可判），收到 ${preview(rawReq)}`,
        { field: DEFINITION_REQUIREMENT_IDS_KEY, value: rawReq },
      );
    }
    requirementIds = [...rawReq];
  }

  const rawChg = payload[DEFINITION_CHANGE_ID_KEY];
  let changeId: string | null = null;
  if (rawChg !== undefined && rawChg !== null && rawChg !== "") {
    if (typeof rawChg !== "string") {
      throw new WorkError(
        "INVALID_COMMAND",
        `${DEFINITION_CHANGE_ID_KEY} 必须是 null 或非空字符串（任务定义引用元数据形态必须可判），收到 ${preview(rawChg)}`,
        { field: DEFINITION_CHANGE_ID_KEY, value: rawChg },
      );
    }
    changeId = rawChg;
  }
  return { requirement_ids: requirementIds, change_id: changeId };
}

/**
 * 引用校验的最小输入形态（判据单源的关键）：`TaskDefinition` 与"事件 payload 取出的引用元数据"
 * 都满足它——包装层预检（整批定义）与服务边界（单条事件 payload）喂的是同一份
 * `validateDefinitionReferences`，不存在两套判据。
 */
export interface DefinitionReferenceInput {
  /** 点名用（谁引用它） */
  task_id: string;
  requirement_ids: readonly string[] | null;
  change_id: string | null;
}

/**
 * 跨对象引用校验：`requirement_ids` / `change_id` 解析不到就点名缺的 id。
 * 返回全部问题（不早退——一次报清），与 `validateTaskDefinitions` 同一套 PlanIssue 形态。
 * 输入取最小形态 `DefinitionReferenceInput`：整批 `TaskDefinition`（包装层/受检导入）与
 * 事件 payload 取出的引用元数据（服务边界）走同一份判据。
 */
export function validateDefinitionReferences(
  definitions: readonly DefinitionReferenceInput[],
  known: RegisteredReferences,
): PlanIssue[] {
  const issues: PlanIssue[] = [];
  const requirementIds = new Set(known.requirement_ids);
  const changeIds = new Set(known.change_ids);

  const missingRequirements = new Map<string, string[]>(); // 缺的需求 id → 谁引用它
  for (const def of definitions) {
    for (const requirementId of def.requirement_ids ?? []) {
      if (requirementIds.has(requirementId)) continue;
      const who = missingRequirements.get(requirementId) ?? [];
      who.push(def.task_id);
      missingRequirements.set(requirementId, who);
    }
  }
  if (missingRequirements.size > 0) {
    issues.push({
      problem: "dangling_requirement",
      ids: [...missingRequirements.keys()].sort(),
      detail: [...missingRequirements.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([id, who]) => `${id}（被 ${[...new Set(who)].sort().join("、")} 引用，已登记需求里不存在）`)
        .join("；"),
    });
  }

  const missingChanges = new Map<string, string[]>();
  for (const def of definitions) {
    const changeId = def.change_id;
    if (changeId === null || changeId === "") continue;
    if (changeIds.has(changeId)) continue;
    const who = missingChanges.get(changeId) ?? [];
    who.push(def.task_id);
    missingChanges.set(changeId, who);
  }
  if (missingChanges.size > 0) {
    issues.push({
      problem: "dangling_change",
      ids: [...missingChanges.keys()].sort(),
      detail: [...missingChanges.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([id, who]) => `${id}（被 ${[...new Set(who)].sort().join("、")} 绑定，已开变更批次里不存在）`)
        .join("；"),
    });
  }
  return issues;
}

/** 校验不通过即抛 `INVALID_COMMAND`（点名缺的 id）；通过则静默返回 */
export function assertDefinitionReferencesValid(
  definitions: readonly DefinitionReferenceInput[],
  known: RegisteredReferences,
  source: string,
): void {
  const issues = validateDefinitionReferences(definitions, known);
  if (issues.length === 0) return;
  throw new WorkError(
    "INVALID_COMMAND",
    `任务定义引用校验不通过（${source}）：${describePlanIssues(issues)}`,
    { source, issues },
  );
}

/** 单条定义的引用校验（任务创建/引用处用：写入前只查这一条） */
export function assertSingleDefinitionReferences(
  definition: DefinitionReferenceInput,
  known: RegisteredReferences,
  source: string,
): void {
  assertDefinitionReferencesValid([definition], known, source);
}

/**
 * 导入施工图 + 立刻做引用校验（**既有校验链的自然入口**）。
 *
 * 顺序是硬的：先解析 → 再查引用（查的是已提交投影）→ 全过才把定义交回调用方。
 * 任何一条悬空都在这里抛 `INVALID_COMMAND`，调用方拿不到"半套定义"，也就没有先写后补的可能。
 *
 * V09-03（附录 E.2-5）补一环：若文档带**需求映射表**（表头同时含「需求」「承接卡」列），
 * 先核映射行自身（承接的卡必须存在；「当前有效」行的需求 id 与承接卡都不得为空——空登记/悬空
 * 承接逐条点名 id 与行号），再导任务定义（映射进 `requirement_ids`），最后走既有的跨对象投影校验。
 * 「历史／待核」行不产生承接映射（E.2-4），其中的卡号不核存在性——它们本就不进任务定义。
 */
export function importPlanChecked(
  markdown: string,
  workDir: string,
  options: ImportTaskOptions = {},
): TaskImportResult {
  const imported = importTaskDefinitions(markdown, options);
  const mapRows = parseRequirementMap(markdown);
  if (mapRows.length > 0) {
    const knownCards = new Set(imported.report.known_ids);
    const issues: PlanIssue[] = [];
    const danglingCards = new Set<string>();
    const incomplete: string[] = [];
    for (const row of mapRows) {
      if (row.requirement_id === "" || (row.classification === "当前有效" && row.card_ids.length === 0)) {
        incomplete.push(`行 ${row.line}（需求「${row.requirement_id || "空"}」）`);
      }
      if (row.classification !== "当前有效") continue; // 「历史／待核」行不承接，卡号不核存在性
      for (const cardId of row.card_ids) {
        if (!knownCards.has(cardId)) danglingCards.add(`${cardId}（行 ${row.line}，需求 ${row.requirement_id || "空"}）`);
      }
    }
    if (danglingCards.size > 0) {
      issues.push({
        problem: "dangling_map_card",
        ids: [...danglingCards].sort(),
        detail: [...danglingCards].sort().join("；"),
      });
    }
    if (incomplete.length > 0) {
      issues.push({ problem: "incomplete_requirement_map", ids: [], detail: incomplete.join("；") });
    }
    if (issues.length > 0) {
      throw new WorkError(
        "INVALID_COMMAND",
        `施工图需求映射表校验不通过：${describePlanIssues(issues)}——映射必须指向表内真实卡号、` +
          "「当前有效」行的需求 id 与承接卡都不得为空（附录 E.2；不承接的行请标「历史／待核」）",
        { issues },
      );
    }
  }
  assertDefinitionReferencesValid(imported.definitions, collectRegisteredReferences(workDir), "施工图导入");
  return imported;
}

// ── 提交侧接线（定义导入的真实写口：references 校验必须在链上，不是可绕开的包装） ──

/**
 * 定义导入提交者的读侧能力：可引用对象集**从投影现读**，不从调用方手里的清单拼。
 * 与 `requirements.ts` 的 `RequirementReadSource` 同款约定——模块不猜项目路径，
 * 读侧闭包由调用方挂到提交者上（验证脚本 / MCP 工具 / 进程内服务各自接自己的投影）。
 */
export interface DefinitionReferenceReadSource {
  readReferences: () => RegisteredReferences;
}
export type DefinitionImportSubmitter = WorkSubmitterLike & Partial<DefinitionReferenceReadSource>;

/** 提交者最小形态（与 tasks.ts 的 `WorkSubmitter` 结构一致；这里只声明不导入，避免 tasks ↔ references 循环） */
interface WorkSubmitterLike {
  submit(command: unknown): unknown;
}

/** 这批定义有没有真的带引用（全 null = 旧数据路径，一条都不查——迁移前的现场照旧通过） */
export function definitionsCarryReferences(definitions: readonly TaskDefinition[]): boolean {
  return definitions.some(
    (d) => (d.requirement_ids ?? []).length > 0 || (d.change_id !== null && d.change_id !== ""),
  );
}

/**
 * 定义导入**提交前**的引用校验（C-015 接线：挂在真实写口上，一个事件都不许先写）。
 *
 * 口径：
 *   · 定义全不带引用（旧数据路径）→ 不查，行为与接线前逐字节一致；
 *   · 带了引用但提交者没给投影读侧 → **拒**（fail-closed：查不了已提交事实就当不可提交，
 *     不能退化成"调用方说是好的"；reason=missing_reference_reader，点名补什么）；
 *   · 带了引用且读侧在场 → 按投影校验，悬空点名拒（与 `importPlanChecked` 同一套
 *     PlanIssue/INVALID_COMMAND，读侧与写侧共用一份判据，不是两套口径）。
 */
export function assertImportSubmissionReferences(
  submitter: WorkSubmitterLike,
  definitions: readonly TaskDefinition[],
  source: string,
): void {
  if (!definitionsCarryReferences(definitions)) return;
  const reader = (submitter as DefinitionImportSubmitter).readReferences;
  if (typeof reader !== "function") {
    throw new WorkError(
      "INVALID_COMMAND",
      `任务定义带需求/变更引用，但提交者没有给出可引用对象读侧（readReferences）：` +
        "引用必须能对上**已提交的投影**才算数，不能凭调用方自报清单放行（DESIGN.md §2.6）。" +
        "请给提交者挂上 readReferences（从投影现读），或先把引用从定义里去掉",
      { reason: "missing_reference_reader", source },
    );
  }
  assertDefinitionReferencesValid([...definitions], reader.call(submitter), source);
}
