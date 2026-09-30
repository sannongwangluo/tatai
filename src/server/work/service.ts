// 唯一写入服务与它的转接客户端（PLAN.md V06-01，DESIGN.md §2.6 / §6.5）。
//
// 两条硬口径（DESIGN.md §2.6）：
//   1. **单写入**：v2 事实只有一条写入路径——本项目 `.工作台/work/` 的事件文件，
//      校验/幂等/版本冲突/追加/投影全在 `WorkService.submit` 里串行做完。
//      stdio MCP 不再自己追加事件，只做转接（`WorkServiceClient`）。
//   2. **离线降级**：服务不可达时，写入报 `SERVICE_UNAVAILABLE`（不落任何字节、不自己写文件），
//      读取退化为磁盘上的**最后一份快照**并标 `stale`（不让调用方把旧数据当最新事实）。
//
// 传输：服务在桌面服务进程内跑，走**回环 HTTP**；MCP 进程从数据目录里的服务描述符
// （`<dataDir>/work-service.json`，0600）发现 host/port/token。描述符不在 = 服务没起。
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import type { IncomingMessage, ServerResponse } from "node:http";
import crypto from "node:crypto";
import { nowIso } from "../time";
import { withFileLock } from "../fileLock";
import { appendJsonlLine } from "../lineStream";
import { getProject } from "../registry";
import { projectWorkDir, workstationDir } from "../workstation";
import { parseRuntimeEntries } from "./runtimeEntries";
import {
  BUDGET_EXHAUSTED_DETAIL_REASON,
  BUDGET_FILE,
  FORGED_RENEW_DETAIL_REASON,
  budgetBlockedIdempotencyKey,
  budgetBlockedPayload,
  budgetEntityId,
  checkProjectBudget,
  countTaskClaims,
  isBudgetGatedClaimEvent,
  readProjectBudget,
  verifyRenewClaimEvent,
} from "./budget";
import { foldChanges, changeIdsOf } from "./changes";
import { assertIntentSourceValid, foldRequirements, requirementIdsOf } from "./requirements";
import { REVISION_KINDS, type RevisionKind } from "./evidence";
import {
  gateClaimedPass,
  isVerificationSubject,
  passGateInputOf,
  recordMethodOf,
} from "./audit";
import {
  assertDefinitionReferencesValid,
  readDefinitionReferencePayload,
  type DefinitionReferencePayload,
  type RegisteredReferences,
} from "./references";
import {
  NO_CHANGE_ID,
  SCHEMA_VERSION,
  WorkError,
  commandFingerprint,
  isWorkError,
  registeredEventTypes,
  validateWorkCommand,
  type WorkCommand,
  type WorkErrorCode,
  type WorkEvent,
  type WorkReceipt,
  type WorkSnapshotRead,
} from "./types";
import {
  appendEventDurable,
  buildSnapshot,
  eventsPath,
  loadEvents,
  readProjectionError,
  readSnapshotFromDisk,
  rebuildSnapshot,
  recoverTail,
  writeProjectionError,
  writeSnapshot,
} from "./eventStore";
// V07-02 彩排闸：读侧同一份解析器（loadDocument→importTaskDefinitions→taskDefinitionHash）
import { loadDocument } from "./documents";
import { importTaskDefinitions, taskDefinitionHash } from "./plan";
import { BLOCKED_NOT_CLAIMABLE_DETAIL_REASON, TASK_STATUS_LABELS, taskStatusOfEvents } from "./tasks";
// V09-10（附录 F）：task.reopened 的写边界核实与 reopenTask 同一份判据（防直连写口旁路，C017 同类防线）
import { verifyReopenCommand } from "./claims";
// V09-23（DESIGN §2.10 / docs/sync-evidence-contract.md）：同步域命令的写边界核实（锁内按当前实际目标重算）
// 与接续阻断判据。六个探针模块的注册由组合根负责（见 syncGraph.ts），service 是其中之一。
import {
  assertClaimSyncGate,
  assertSyncContractWriteCommand,
  assertSyncEvidenceWriteCommand,
  prepareClaimSyncGate,
  prepareSyncEvidenceCheck,
  readProjectDiscoveryIssues,
  readSyncStatus,
  type SyncClaimGatePrep,
  type SyncEvidencePreparation,
} from "./sync";
import "./syncGraph";
import { runSyncScanForRequest } from "./syncDiscovery";
import type { SyncStatusReport } from "../../shared/syncEvidence";

// ── 项目 → work 目录（路径只走注册表；未知项目按 INVALID_COMMAND 拒，不猜路径）──

function resolveWorkDir(projectId: string, dataDir: string): string {
  try {
    return projectWorkDir(projectId, dataDir);
  } catch (e) {
    throw new WorkError("INVALID_COMMAND", `无法解析项目目录（project_id=${projectId}）：${(e as Error).message}`, {
      project_id: projectId,
    });
  }
}

/** 项目 `.工作台/` 目录（`intent.json` 在这一层）：与 resolveWorkDir 同一条注册表路径规则、同一套拒绝话术 */
function resolveWorkbenchDir(projectId: string, dataDir: string): string {
  try {
    return workstationDir(projectId, dataDir);
  } catch (e) {
    throw new WorkError(
      "INVALID_COMMAND",
      `无法解析项目 .工作台/ 目录（project_id=${projectId}）：${(e as Error).message}`,
      { project_id: projectId },
    );
  }
}

// ── 需求/变更批次事件的写侧校验（§2.5 一致校验面，C-015 收口第一包）──

/**
 * 需求/变更批次实体的事件在**追加前**过与读侧完全同一份折叠判据（§2.5 一致校验面：
 * 经 WorkService.submit 的直接命令写入，也在唯一写入服务处执行同一套校验；调用方自查不替代服务侧校验）。
 *
 * 为什么必须在服务这一点 fail-closed（C-015 复核实证）：这类事件若带着空载荷/缺必填/
 * 多余键/未知类型/越序形态落盘，读侧重放（foldRequirements/foldChanges）会对同一实体抛
 * EVENT_INVALID——事件不可回改，该实体的投影被**永久毒化**。所以在动磁盘之前用同一份
 * 折叠逻辑试折（该实体历史 + 候选事件），折叠不过就 INVALID_COMMAND 拒掉，一个字节都不写。
 *
 * 只挂 requirement:/change: 实体域（与折叠自己的实体路由口径一致），不外溢到别的对象域。
 * 判据单一来源：foldRequirements/foldChanges 就是读侧重放与对象命令共用字段读取器的那两份
 * 纯函数，这里不新造第二套校验。
 */
function assertEntityEventFoldable(events: WorkEvent[], cmd: WorkCommand, current: number): void {
  const fold = cmd.entity_id.startsWith("requirement:")
    ? foldRequirements
    : cmd.entity_id.startsWith("change:")
      ? foldChanges
      : null;
  if (fold === null) return;
  // fold* 内部先跑结构性重放（seq 必须 1..N 连续）：喂实体子集前把 seq 归一成 1..N；
  // entity_revision 本来就是该实体内的 1..N（本服务强制），候选事件是 current+1。
  const history = events.filter((e) => e.entity_id === cmd.entity_id);
  const normalized = history.map((e, i) => ({ ...e, seq: i + 1 }));
  const candidate: WorkEvent = {
    schema_version: cmd.schema_version,
    event_id: "<preflight-未写入>",
    project_id: cmd.project_id,
    change_id: cmd.change_id,
    entity_id: cmd.entity_id,
    entity_revision: current + 1,
    seq: normalized.length + 1,
    type: cmd.type,
    actor_id: cmd.actor_id,
    role: cmd.role,
    occurred_at: cmd.occurred_at ?? "",
    received_at: "",
    idempotency_key: cmd.idempotency_key,
    payload: cmd.payload ?? {},
  };
  try {
    fold([...normalized, candidate]);
  } catch (e) {
    if (e instanceof WorkError) {
      throw new WorkError(
        "INVALID_COMMAND",
        `拒绝提交 ${cmd.type}（${cmd.entity_id}），本次命令没有写入任何字节：${e.message}。` +
          "需求/变更批次事件的校验只在唯一写入服务执行（DESIGN.md §2.5 一致校验面），" +
          "与读侧重放同一份判据——校验不过的事件落盘会把该实体投影毒化（读侧 EVENT_INVALID 且事件不可回改），所以一个事件都不许先写",
        { entity_id: cmd.entity_id, type: cmd.type, reason: "entity_event_invalid", cause: e.detail },
      );
    }
    throw e;
  }
}

// ── task.definition_imported 的定义哈希彩排闸（V07-02：自伤写入零容忍）──

/**
 * 导入事件的定义哈希必须与**读侧现解析口径**一致：服务端从项目施工图现解析同任务定义
 * （回放候选事件携带的 definition_change_id 绑定后）重算哈希，与 payload 声明的哈希比对；
 * 对不上＝导入方与读侧的哈希口径分叉（2026-09-21 实测缺陷①的类别）——这种事件落盘后
 * 读侧会把它永久判 needs_rebound（修复前无工具可解），所以在写入边界当场拒。
 * 图纸缺失/任务不在表内（隔离夹具的合成任务）无法核验，跳过——只约束可核验的写入。
 */
function assertDefinitionImportHashConsistent(cmd: WorkCommand, dataDir: string): void {
  if (cmd.type !== "task.definition_imported") return;
  const payload = cmd.payload ?? {};
  const declared = typeof payload.definition_sha256 === "string" ? payload.definition_sha256 : "";
  if (declared === "") return;
  // 只约束**新形态**（payload 携带 requirement_ids/definition_change_id 任一键，C-015 起 canonical
  // 导入的口径）：受检导入与服务端同一份解析器，哈希分叉＝缺陷，当场拒。旧形态（无这两键的
  // 历史事件/隔离夹具手工哈希，如 verify-v06-09 的 sha256("T-1-def")）一条不查——与引用校验
  // 的旧形态豁免同一哲学（§2.5：校验只约束新写入，历史与夹具原样重放）
  let refs: ReturnType<typeof readDefinitionReferencePayload>;
  try {
    refs = readDefinitionReferencePayload(payload);
  } catch {
    refs = null;
  }
  if (refs === null) return;
  let plan: ReturnType<typeof loadDocument> = null;
  try {
    plan = loadDocument(cmd.project_id, "plan", dataDir);
  } catch {
    plan = null;
  }
  if (plan === null) return;
  // 只约束**自称当前版**的导入（payload.plan_revision 与盘上一致）：声明旧修订的导入
  // （夹具/回放旧图纸）与盘上新版本来就有合理分叉，如实放行——受检导入永远解析当前盘上
  // 图纸，宣称当前版却对不上哈希才是缺陷（2026-09-21 类）
  const claimedRev = typeof payload.plan_revision === "string" ? payload.plan_revision : "";
  if (claimedRev !== plan.revision.content_sha256) return;
  const defs = importTaskDefinitions(plan.text, { plan_revision: plan.revision.content_sha256 }).definitions;
  const taskId = (cmd.entity_id.startsWith("task:") ? cmd.entity_id.slice("task:".length) : cmd.entity_id).trim();
  const def = defs.find((d) => d.task_id.trim().toUpperCase() === taskId.toUpperCase());
  if (def === undefined) return;
  const expected = taskDefinitionHash({
    ...def,
    change_id: refs.change_id,
    // requirement_ids 同属定义内容（definitionCanonical 收它）——导入方带了需求引用而
    // 读侧重解析不带时，哈希必然分叉；回放必须补全两样，不能只补批次绑定
    requirement_ids: refs.requirement_ids,
  });
  if (expected !== declared) {
    throw new WorkError(
      "INVALID_COMMAND",
      `拒绝提交 task.definition_imported（${cmd.entity_id}），本次没有写入任何字节：payload 声明的定义哈希与读侧现解析口径对不上` +
        `（声明 ${declared.slice(0, 12)}… / 读侧 ${expected.slice(0, 12)}…）——导入方与读侧哈希分叉，落盘即待重绑死局（2026-09-21 缺陷类）。` +
        "请走 import_plan_definitions 受检导入（它与服务端同一份解析器），不要手工拼定义哈希",
      { entity_id: cmd.entity_id, declared, expected },
    );
  }
}

// ── audit.self_check_recorded 的判绿采信彩排闸（V09-01／附录 E.3.2、E.3.3）──

/**
 * 自检记录声称「通过」时，追加前过与读侧（`statusProjection.ts#checkEffectiveness`）
 * **同一份**采信判据（判据单源在 `audit.ts#gateClaimedPass`——写侧放行、读侧不采信这种分叉
 * 正是 G-02/F-01 类"证据自相矛盾却判绿"的温床）：
 *   · 带 `command` 的机械检查：任一 `exit_code ≠ 0`，或该 check 缺 `exit_code`（或非数值）⇒ 拒；
 *   · 不带 `command` 的检查（独立审计/人工审阅档）：per-check `evidence_sha256` 与
 *     方法说明（per-check `method` **或**记录层 `coverage`/`method_limits`，二选一）**两缺**的
 *     「通过」⇒ 拒；**不要求** `exit_code`，也**不要求** per-check `method`
 *     （既有 227 条独立审计没有这个字段、方法在记录层——一条都不追溯失效，E.3.2 第二档）；
 *   · 声明了被验对象类别（`checks[].verifies`）时：绑定种类必须与之一致（E.3.3）；
 *   · **新写入的通过检查必须声明 `verifies`**（V09-01 收口，任务书 2026-09-24）：
 *     不声明 = 绑定无法核对是否跟随被验对象，代码/产物检查就能拿 plan/design 修订冒充源码证据。
 *     只拦新写入；历史记录（无此字段）原样在册、读侧不追溯（E.3.2-3／E.3.3-3）。
 * `conclusion="fail"` 一律放行——**失败 + 非零退出码如实记录**，两者并不矛盾。
 *
 * 为什么必须在唯一写口拒：事件不可回改，读侧对矛盾记录永久不采信；与既有运行入口字段的
 * 写前拒同族（§2.6：追加前任一失败，被拒命令一个字节都不写）。**历史记录不在此列**——
 * 本闸只作用于新写入，已入库的矛盾记录原样在册（E.3.2-3）。
 */
function assertSelfCheckEvidenceConsistent(cmd: WorkCommand): void {
  if (cmd.type !== "audit.self_check_recorded") return;
  const payload = cmd.payload ?? {};
  // fail 如实记录（哪怕退出码非零）；本闸只拦「声称通过」的记录
  if (payload.conclusion !== "pass") return;
  const bindingRaw = payload.binding;
  const bindingObj =
    typeof bindingRaw === "object" && bindingRaw !== null
      ? (bindingRaw as Record<string, unknown>)
      : null;
  const bindingKind = typeof bindingObj?.revision_kind === "string" ? bindingObj.revision_kind : null;
  const bindingRevision = typeof bindingObj?.revision === "string" ? bindingObj.revision : null;
  if (bindingKind !== null && !REVISION_KINDS.includes(bindingKind as RevisionKind)) {
    throw new WorkError(
      "EVENT_INVALID",
      `拒绝提交 ${cmd.type}（${cmd.entity_id}），本次没有写入任何字节：payload.binding.revision_kind=` +
        `${JSON.stringify(bindingKind)} 不是合法修订种类（只有 ${REVISION_KINDS.join("/")}）。` +
        "绑定的修订种类必须是被验对象的真实来源之一（DESIGN.md 附录 E.3.3），不能拿任意字符串充当绑定",
      { entity_id: cmd.entity_id, type: cmd.type, reason: "binding_kind_invalid", binding_kind: bindingKind },
    );
  }
  const binding =
    bindingKind !== null && bindingRevision !== null
      ? { revision_kind: bindingKind, revision: bindingRevision }
      : null;
  // 记录层方法/覆盖（E.3.2 第二档的"二选一"另半边；自检通常没有这一层）
  const recordMethod = recordMethodOf({
    coverage: Array.isArray(payload.coverage) ? (payload.coverage as Record<string, unknown>[]) : [],
    method_limits: Array.isArray(payload.method_limits) ? payload.method_limits : [],
  });
  const checks = Array.isArray(payload.checks) ? payload.checks : [];
  for (const raw of checks) {
    if (typeof raw !== "object" || raw === null) continue;
    const verdict = gateClaimedPass(
      passGateInputOf(raw as Record<string, unknown>, { record_method: recordMethod, binding }),
    );
    if (!verdict.pass) {
      throw new WorkError(
        "EVENT_INVALID",
        `拒绝提交 ${cmd.type}（${cmd.entity_id}），本次没有写入任何字节：${verdict.why}。` +
          "采信判据见 DESIGN.md 附录 E.3.2／E.3.3，写侧与读侧同一份；" +
          "已入库的历史矛盾记录原样在册、不改写（E.3.2-3）——要纠正请补一条新记录，别改历史",
        {
          entity_id: cmd.entity_id,
          type: cmd.type,
          reason: verdict.code,
          check_id: typeof raw.check_id === "string" ? raw.check_id : null,
        },
      );
    }
    // V09-01 收口：通过检查必须声明被验对象类别（写在分档判据之后——旧的退出码/证据判据理由优先报，
    // 互不相掩；声明了才轮到 gateClaimedPass 里的绑定相符判据，两处接力不断档）
    const declared = (raw as Record<string, unknown>).verifies;
    if (!isVerificationSubject(declared)) {
      throw new WorkError(
        "EVENT_INVALID",
        `拒绝提交 ${cmd.type}（${cmd.entity_id}），本次没有写入任何字节：` +
          `检查「${typeof raw.check_id === "string" ? raw.check_id : "?"}」声称通过却没有声明实际验证对象——` +
          "新提交的通过检查必须给 `checks[].verifies`（document／code／artifact）三选一：" +
          "验文档契约的绑该文档修订（design/plan/interface）仍合法；验代码行为或产物的必须给源码内容指纹" +
          "（revision_kind=code；产物另需产物内容哈希＋同源构建证据），不许拿 plan/design 修订冒充源码证据" +
          "（DESIGN.md 附录 E.3.3）。历史未声明记录原样在册、读侧不追溯（E.3.3-3）",
        {
          entity_id: cmd.entity_id,
          type: cmd.type,
          reason: "verifies_undeclared",
          check_id: typeof raw.check_id === "string" ? raw.check_id : null,
        },
      );
    }
  }
}

// ── task.definition_imported 的服务边界引用校验（§2.5 一致校验面，C-015 复核返修）──

/**
 * 直连唯一写口提交的 `task.definition_imported`，若携带引用元数据（新形态：payload 有
 * `requirement_ids` / `definition_change_id` 任一键），追加前从**同一 events 现场**折出
 * 需求/变更投影核验——与 canonical 导入（submitDefinitionImports 包装层预检）、受检读入口
 * （importPlanChecked）同一份判据（references.ts 的 validateDefinitionReferences/PlanIssue），
 * 不另造第二套。悬空点名 id 拒、原子、零字节（PLAN C-015②的另一半：经 WorkService.submit
 * 直接提交的含悬空 requirement_ids 任务定义整体拒绝并点名 ID）。
 *
 * 兼容形态（明确可判，不猜）：两个引用键都不在 = 旧形态（历史事件/旧调用方），一条都不查——
 * 校验只约束新写入，历史事件原样重放不回改（§2.5 旧数据与回放）；任一键在但形态不合法
 * （非数组/杂元素/非串批次）同样 INVALID_COMMAND 点名字段拒，新路径不许"看着像引用却
 * 解析不了"还放行。键名与形态判定都由 references.ts 单源给出，写口与服务不各写各的。
 */
function assertDefinitionImportReferences(events: WorkEvent[], cmd: WorkCommand): void {
  if (cmd.type !== "task.definition_imported") return;
  let refs: DefinitionReferencePayload | null;
  try {
    refs = readDefinitionReferencePayload(cmd.payload ?? {});
  } catch (e) {
    if (e instanceof WorkError) {
      throw new WorkError(
        "INVALID_COMMAND",
        `拒绝提交 ${cmd.type}（${cmd.entity_id}），本次命令没有写入任何字节：${e.message}`,
        {
          entity_id: cmd.entity_id,
          type: cmd.type,
          reason: "definition_reference_payload_invalid",
          cause: e.detail,
        },
      );
    }
    throw e;
  }
  if (refs === null) return; // 旧形态：一条都不查，行为与接线前一致
  // 从锁内同一 events 现场折投影（不在调用方手里拼清单；fold* 对全量事件跑，seq 本就 1..N 连续）
  const known: RegisteredReferences = {
    requirement_ids: requirementIdsOf(foldRequirements(events)),
    change_ids: changeIdsOf(foldChanges(events)),
  };
  const taskId = cmd.entity_id.startsWith("task:") ? cmd.entity_id.slice("task:".length) : cmd.entity_id;
  try {
    assertDefinitionReferencesValid(
      [{ task_id: taskId, requirement_ids: refs.requirement_ids, change_id: refs.change_id }],
      known,
      `WorkService.submit 直连 ${cmd.type}`,
    );
  } catch (e) {
    if (e instanceof WorkError) {
      throw new WorkError(
        "INVALID_COMMAND",
        `拒绝提交 ${cmd.type}（${cmd.entity_id}），本次命令没有写入任何字节：${e.message}。` +
          "任务定义的需求/变更引用必须能对上已提交的投影（DESIGN.md §2.5 引用有效性/一致校验面）——" +
          "直连唯一写口与 canonical 导入同一份判据，调用方自查不替代服务侧校验",
        {
          entity_id: cmd.entity_id,
          type: cmd.type,
          reason: "dangling_definition_reference",
          cause: e.detail,
        },
      );
    }
    throw e;
  }
}

/**
 * 需求事件的服务边界意图来源校验（§2.5「一致校验面」/「引用有效性、原子拒绝」；同族第三半）。
 *
 * 为什么必须在这一点 fail-closed：对象命令侧（`registerRequirement` / `updateRequirement`）已经核过 intent
 * 引用，但**直连通用写口**（`WorkService.submit`）可以不经过对象命令直接提交一条 `requirement.registered`
 * ——没有这道边界校验，`source{kind:"intent", ref:"intent.json#<不存在的 id>"}` 照样落盘；事件不可回改
 * （§2.5 旧数据与回放），"引用有效性"就只是 MCP 面上的一句承诺（与 `task.reopened` 的直连旁路防线同类）。
 *
 * 判据单一来源：与对象命令侧共用 `requirements.ts` 的 `assertIntentSourceValid`（内部用 `intent.ts` 的
 * `resolveIntentRef` 对那份原文实解析），本函数只做三件事：取 `payload.source`、按**注册表**解析该项目的
 * `.工作台/`、把拒绝包成直连写口的话术——不复制校验逻辑（写法与 `assertDefinitionImportReferences` 一致）。
 *
 * 边界与"不顺手扩项"：只挂 `requirement.registered` / `requirement.updated` 且只核 `kind="intent"`
 * （其他 kind 的原文源各有归属；不带 `source` 键的事件——`requirement.status_changed`、只改别的字段的
 * updated——没有来源引用可核，一条都不查）。payload 形状不合法在更早的 `assertEntityEventFoldable`
 * 就被同一份折叠判据拒掉，所以这里只在形态可判时核引用。
 */
function assertRequirementIntentSourceResolvable(cmd: WorkCommand, dataDir: string): void {
  if (cmd.type !== "requirement.registered" && cmd.type !== "requirement.updated") return;
  const rawSource = (cmd.payload ?? {}).source;
  if (typeof rawSource !== "object" || rawSource === null || Array.isArray(rawSource)) return;
  const source = rawSource as { kind?: unknown; ref?: unknown };
  if (source.kind !== "intent" || typeof source.ref !== "string") return;
  const workbenchDir = resolveWorkbenchDir(cmd.project_id, dataDir);
  try {
    assertIntentSourceValid(
      { kind: "intent", ref: source.ref },
      workbenchDir,
      `WorkService.submit 直连 ${cmd.type}（${cmd.entity_id}）`,
    );
  } catch (e) {
    if (e instanceof WorkError) {
      throw new WorkError(
        "INVALID_COMMAND",
        `拒绝提交 ${cmd.type}（${cmd.entity_id}），本次命令没有写入任何字节：${e.message}。` +
          "需求来源引用的意图原文必须真的在场、条目真的在（DESIGN.md §2.5 引用有效性/一致校验面）——" +
          "直连唯一写口与对象命令（manage_requirement）同一份判据，绕过对象命令不能旁路",
        {
          entity_id: cmd.entity_id,
          type: cmd.type,
          reason: e.detail?.reason ?? "intent_source_rejected",
          ref: source.ref,
          cause: e.detail,
        },
      );
    }
    throw e;
  }
}

// ── 唯一写入服务 ──

export interface WorkServiceOptions {
  dataDir: string;
  /**
   * 故障注入点（仅验证脚本使用，产品路径不传）。PLAN V06-01 要求覆盖"已提交但快照失败"，
   * 这条现场只能靠注入制造——`snapshot: "throw"` 让投影步骤抛错，事件本身照常已落盘。
   */
  faults?: { snapshot?: "throw" };
}

export class WorkService {
  private readonly dataDir: string;
  private readonly faults: WorkServiceOptions["faults"];

  constructor(opts: WorkServiceOptions) {
    this.dataDir = opts.dataDir;
    this.faults = opts.faults;
  }

  /**
   * 提交一份写入命令（唯一入口）。成功返回回执，失败抛 `WorkError`。
   *
   * 顺序（DESIGN.md §2.6）：校验 → 幂等 → 版本 → 认领类门禁（自称 renew 先凭事件现场核实资格，
   * 伪造拒零字节；**阻塞卡不许新领**；首次认领过预算门禁）→ 需求/变更实体折叠校验（§2.5 一致校验面，C-015）→
   * task.definition_imported 引用校验（C-015 复核返修，新形态才查）→ 追加并持久化 → 回执 → 投影。
   * 追加前各步任一失败，**被拒命令本身一个字节都不写**；投影失败不回滚已提交的事件，只如实标记。
   * 唯一例外：预算门禁拒绝认领时，在同一临界区额外提交一条 `budget.blocked` 留证事件
   * （独立的项目级实体、幂等键去重、投影照常跟上）——拒绝永不静默（见 ②′ 注释，C-017 补修）。
   */
  submit(rawCommand: unknown): WorkReceipt {
    const cmd = validateWorkCommand(rawCommand);
    // 补修第二轮裁定（3）：运行入口的非法值要在**两条写入路径统一拒绝**。
    // 成果登记（`audit.submission_submitted`）与 Agent 结果回报（`task.result_submitted`）都经本服务的
    // `submit()`，这里是**唯一写出口** ⇒ 校验挂在这一点就同时覆盖两条路径；读侧保留同一套校验
    // （历史坏记录要仍然**可追溯**，见 `docs/work-v2-contract.md` §19.8）。
    {
      const rawEntries = (cmd.payload as Record<string, unknown>).runtime_entries;
      if (rawEntries === null) {
        // **写侧**比读侧严：读侧对历史里的 `null` 暂时按"没声明"容忍（不能一收紧就让历史项目整体 500），
        // 但新写入不许再产生 `null`——要么给数组，要么不写这个字段。
        throw new WorkError("EVENT_INVALID", "runtime_entries 不能是 null：要么给数组，要么不写这个字段", {
          field: "runtime_entries",
          entity_id: cmd.entity_id,
          type: cmd.type,
        });
      }
      if (rawEntries !== undefined) {
        parseRuntimeEntries(rawEntries, { event_id: "<未写入>", record_id: cmd.entity_id });
      }
    }
    const workDir = resolveWorkDir(cmd.project_id, this.dataDir);

    // V09-23／DESIGN §2.10 锁边界：`sync.evidence_checked` 由唯一服务在**锁外**按当前实际目标做**独立全量评估**
    // （含六图 canonical builder），与命令声称的 overall/逐项 verdict/目标指纹逐项比对——不符在进锁前就拒（零字节），
    // 不信任调用方摘要。锁内只做**有界**真实目标指纹复核（不跑 sixGraphsOf 全量；见 assertSyncEvidenceWriteCommand）。
    const syncEvidencePrep: SyncEvidencePreparation | null =
      cmd.type === "sync.evidence_checked" ? prepareSyncEvidenceCheck({ cmd, dataDir: this.dataDir, workDir }) : null;

    // V09-23 返工C（Codex 反例14 后半）：非续约 `task.claimed` 的同步门禁同样**锁外独立评估 + 锁内有界快照校验**——
    // 锁内不再跑 computeSyncBlock 全量六图；锁内只用有界图源探针/文件字节重算指纹比对（见 assertClaimSyncGate）。
    const claimSyncPrep: SyncClaimGatePrep | null =
      cmd.type === "task.claimed" && cmd.payload?.claim_action !== "renew" ? prepareClaimSyncGate({ cmd, dataDir: this.dataDir, workDir }) : null;

    return withFileLock(eventsPath(workDir), () => {
      const { events, tail } = loadEvents(workDir);
      // 半截尾（上次写到一半被杀）先隔离记录再继续——绝不粘行
      if (tail) recoverTail(workDir);

      // ① 幂等：同键同内容 → 原样返回上一次回执（不产生第二次效果）；同键异内容 → 明确拒绝
      const existing = events.find((e) => e.idempotency_key === cmd.idempotency_key);
      if (existing) {
        if (!sameIntent(cmd, existing)) {
          throw new WorkError(
            "IDEMPOTENCY_CONFLICT",
            `幂等键已用于另一份内容不同的命令：${cmd.idempotency_key}（原事件 ${existing.event_id}，序号 ${existing.seq}）。` +
              "幂等键一旦用过就不能换内容重发——请换一个新键表达新改动",
            {
              idempotency_key: cmd.idempotency_key,
              existing_event_id: existing.event_id,
              existing_seq: existing.seq,
              existing_fingerprint: fingerprintOfEvent(existing).slice(0, 16),
            },
          );
        }
        const snap = readSnapshotFromDisk(workDir);
        const perr = readProjectionError(workDir);
        return {
          ok: true,
          event_id: existing.event_id,
          seq: existing.seq,
          entity_revision: existing.entity_revision,
          received_at: existing.received_at,
          duplicate: true,
          projection:
            perr && (!snap || perr.last_seq >= snap.last_seq)
              ? { state: "failed", error: perr.error }
              : { state: "applied" },
        };
      }

      // ② 版本：调用方声明"我以为是什么版本"，与事实不符就拒绝，不覆盖别人的推进
      const current = events.reduce(
        (rev, e) => (e.entity_id === cmd.entity_id ? e.entity_revision : rev),
        0,
      );
      const expected = cmd.expected_revision ?? 0;
      if (current !== expected) {
        const latest = [...events].reverse().find((e) => e.entity_id === cmd.entity_id);
        throw new WorkError(
          "VERSION_CONFLICT",
          `实体 ${cmd.entity_id} 的当前版本是 ${current}，命令声明期望 ${expected}（期望 null 或 0 表示"尚不存在"）。` +
            "说明有人先你一步改了它——请重新读取后再提交，塔台不替你合并",
          {
            entity_id: cmd.entity_id,
            expected_revision: cmd.expected_revision,
            current_revision: current,
            current_event_id: latest?.event_id ?? null,
            current_seq: latest?.seq ?? null,
            // 差异入口：从 current_seq 往后读事件文件即可看到"你错过的改动"
            diff_from_seq: expected + 1,
            read_events: eventsPath(workDir),
          },
        );
      }

      // ②′ 认领类命令门禁（T23/C-017 批3终审补修 + C017 回炉伪造续约封口）：认领动作消费的是
      // **项目级**配额，「检查—保留」必须在这条锁（唯一写入临界区）里原子完成——`claims.claimTask`
      // 的预算预查只是劝告性的：两个并发认领可以都读到 usage=0 再先后到这里
      // （批3终审探针 probe1/C017-2），直连通用写口手写 task.claimed 也走这里（C017-1）。
      // 自称 renew 的命令**先核实再放行**（C017 回炉）：上一轮只凭 payload.claim_action 自报跳过
      // 门禁与计数，持 token 的调用者给从未认领的任务手写 renew 即可无限认领（反例探针
      // probe-before.txt 3/3 ACCEPTED）。现在由 verifyRenewClaimEvent 凭锁内事件现场核实
      // （当前有效认领 + 持有者 token/身份 + 任务状态 + 新租约）；核实不成立一律拒绝且零字节
      // （不报预算错、不落 budget.blocked——那不是预算拒绝，是身份/契约不符）。
      // 核实成立的真实续约不受预算门禁（与 countTaskClaims 同口径不多算），release 是别的事件类型。
      // 预算拒绝口径：被拒命令本身零字节；同时在同一临界区落一条 budget.blocked 留证
      // （幂等键去重，同一次意图重发不刷屏），并把投影跟上——拒绝永不静默，
      // 但也绝不替被拒的认领落事件。坏 budget.json 在这里同样 fail-closed（readProjectBudget 抛）。
      if (cmd.type === "task.claimed") {
        let renewVerified = false;
        if (cmd.payload?.claim_action === "renew") {
          const verification = verifyRenewClaimEvent(events, cmd.entity_id, cmd.payload, cmd.actor_id);
          if (!verification.ok) {
            throw new WorkError(
              "INVALID_COMMAND",
              `续约核实不通过，拒绝提交 ${cmd.type}（${cmd.entity_id}），本次命令没有写入任何字节：` +
                verification.failures.join("；") +
                "。续约资格只认已提交事件现场（当前有效认领 + 持有者 token/身份 + 任务状态 + 新租约），" +
                "不凭 payload 自报 claim_action（DESIGN.md §6.5）；要领取新任务请走首次认领",
              {
                reason: FORGED_RENEW_DETAIL_REASON,
                entity_id: cmd.entity_id,
                failures: verification.failures,
              },
            );
          }
          renewVerified = true;
        }
        // ②′.2 阻塞卡不许**新领**（2026-09-30 有界修正；与 `claims.claimTask` 同一判据）：
        // 直连通用写口手写 `task.claimed` 也走这条唯一写入临界区，所以门禁挂在这一点，
        // "只从就绪队列领"这条规则就不能被绕过。合法的续约（renewVerified）不受此限——
        // 续约是持有者对**已有认领**的延长，不是新领；取消/已交付的原规则不变。
        // 被拒命令**零字节**；不落 budget.blocked 留证（这不是预算拒绝，是状态不符）。
        if (!renewVerified) {
          const snapshot = taskStatusOfEvents(events, cmd.entity_id);
          if (snapshot !== null && snapshot.status === "blocked") {
            const blockedReason = snapshot.blocked_reason ?? "（事件里未记录 blocked_reason）";
            throw new WorkError(
              "INVALID_COMMAND",
              `任务 ${cmd.entity_id} 当前是「${TASK_STATUS_LABELS.blocked}」：阻塞卡不许新领，` +
                `拒绝提交 ${cmd.type}（${cmd.entity_id}），本次命令没有写入任何字节。` +
                `阻塞原因（事件账本 blocked_reason）：${blockedReason}。` +
                "解阻按**原启动条件**经协调器处理——先满足该前置，再由协调器写一条 " +
                'task.status_changed(status="ready") 解除阻塞；随便一句授权的话不构成解阻凭据' +
                "（凭据是事件账本里的状态与依据，DESIGN.md §5.4/§6.7）",
              {
                reason: BLOCKED_NOT_CLAIMABLE_DETAIL_REASON,
                entity_id: cmd.entity_id,
                status: snapshot.status,
                blocked_reason: snapshot.blocked_reason,
              },
            );
          }
          // ②′.3 同步批次阻断（V09-23／DESIGN §2.10；返工C 锁边界）：active 且 blocks_entry 的批次未当前通过时，
          // 锁内**按当前实际事实重算有界指纹**与锁外独立预评估逐字节比对并拒绝新领——直连通用写口手写 task.claimed
          // 因此不能绕开接续门禁，且锁内**不跑 sixGraphsOf 全量**（判据与 entry/claimTask 同一份 computeSyncBlock 语义）。
          assertClaimSyncGate({ events, cmd, dataDir: this.dataDir, workDir, prep: claimSyncPrep! });
        }
        if (isBudgetGatedClaimEvent(cmd.type, renewVerified)) {
          const budgetCheck = checkProjectBudget(readProjectBudget(workDir), countTaskClaims(events));
          if (budgetCheck.status === "exhausted") {
            const taskId = cmd.entity_id.startsWith("task:") ? cmd.entity_id.slice("task:".length) : cmd.entity_id;
            const entityId = budgetEntityId(cmd.project_id);
            const key = budgetBlockedIdempotencyKey(entityId, taskId, budgetCheck.usage, budgetCheck.max, cmd.actor_id);
            let blockedSeq: number | null = null;
            if (!events.some((e) => e.idempotency_key === key)) {
              const blockedAt = nowIso();
              const budgetRev = events.reduce(
                (rev, e) => (e.entity_id === entityId && e.entity_revision > rev ? e.entity_revision : rev),
                0,
              );
              const blockedEvent: WorkEvent = {
                schema_version: SCHEMA_VERSION,
                event_id: crypto.randomUUID(),
                project_id: cmd.project_id,
                change_id: NO_CHANGE_ID,
                entity_id: entityId,
                entity_revision: budgetRev + 1,
                seq: (events[events.length - 1]?.seq ?? 0) + 1,
                type: "budget.blocked",
                actor_id: cmd.actor_id,
                role: cmd.role,
                occurred_at: cmd.occurred_at ?? blockedAt,
                received_at: blockedAt,
                idempotency_key: key,
                payload: budgetBlockedPayload(budgetCheck.usage, budgetCheck.max, taskId),
              };
              appendEventDurable(workDir, blockedEvent);
              // 留证事件是已提交事实：投影照常跟上（失败只标记，不影响拒绝成立）
              this.project(workDir, cmd.project_id, [...events, blockedEvent]);
              blockedSeq = blockedEvent.seq;
            }
            throw new WorkError(
              "INVALID_COMMAND",
              `项目预算约束已达上限（已认领 ${budgetCheck.usage} 次 / 上限 ${budgetCheck.max} 次）：` +
                `拒绝提交 ${cmd.type}（${cmd.entity_id}），本次认领没有写入任何字节` +
                (blockedSeq === null ? "；同内容留证已在事件流里" : `；已在写入临界区内落 budget.blocked 留证（seq ${blockedSeq}）`) +
                `。可调整 ${path.join(workDir, BUDGET_FILE)}（提高 max_task_claims，或设为 null 表示不限），` +
                "或收口本轮变更后重新开工（DESIGN.md §5.7）",
              {
                reason: BUDGET_EXHAUSTED_DETAIL_REASON,
                usage: budgetCheck.usage,
                max: budgetCheck.max,
                remaining: 0,
                entity_id: cmd.entity_id,
                blocked_event_seq: blockedSeq,
              },
            );
          }
        }
      }

      // ②″ 需求/变更批次实体的写侧校验（§2.5 一致校验面，C-015 收口）：直连写口提交的
      // requirement.*/change.* 事件，追加前过与读侧重放同一份折叠判据——校验不过拒且零字节，
      // 不让"落盘即毒化该实体投影"的事件进入事件流（判据单一来源，见 assertEntityEventFoldable）。
      assertEntityEventFoldable(events, cmd, current);

      // ②ⅲ 需求事件的意图来源校验（§2.5 一致校验面/引用有效性）：直连通用写口提交的
      // requirement.registered/updated 若 `source.kind="intent"`，追加前按**注册表**定位该项目
      // `.工作台/intent.json` 并实解析（悬空/坏文件/核不了点名拒、原子、零字节）——与对象命令侧
      // 共用同一份判据（requirements.ts `assertIntentSourceValid`），绕过 manage_requirement 不能旁路。
      assertRequirementIntentSourceResolvable(cmd, this.dataDir);

      // ②‴ task.definition_imported 的服务边界引用校验（§2.5 一致校验面，C-015 复核返修）：
      // 新形态定义事件携带的 requirement_ids/definition_change_id 必须能对上已提交投影——
      // 悬空点名拒、原子、零字节；旧形态一条都不查（与 canonical 导入同一份判据，见上函数）。
      assertDefinitionImportReferences(events, cmd);

      // ②ⅵ 定义哈希彩排闸（V07-02 自伤写入零容忍）：导入事件声明的定义哈希必须与读侧
      // 现解析口径一致——对不上＝导入方与读侧哈希分叉（2026-09-21 缺陷①的类别），
      // 落盘即 needs_rebound 死局，写入边界当场拒。图纸缺失/任务不在表（隔离夹具）跳过。
      assertDefinitionImportHashConsistent(cmd, this.dataDir);

      // ②ⅶ 自检记录的判绿采信彩排闸（V09-01／附录 E.3.2、E.3.3）：声称通过而带 `command` 的
      // 检查退出码非零/缺失，或证据与方法两缺，或声明了被验对象类别却绑错种类 ⇒ EVENT_INVALID、
      // 零字节（读侧同一份判据不采信它）。`conclusion="fail"` 与非零退出码可如实记录。
      assertSelfCheckEvidenceConsistent(cmd);

      // ②ⅷ task.reopened 的写边界核实（V09-10／附录 F）：协调器角色、payload 闭键、已提交状态、
      // attempt 递增、previous_result 真实指回上一提交、reopen_basis 可取回、旧 run 租约与目录冲突——
      // 与 `claims.reopenTask` 用**同一份** `verifyReopenCommand` 判据；直连通用写口手写 task.reopened
      // 不能旁路（C017「直连旁路」同类的防线）。核实不通过一律拒绝且零字节。
      if (cmd.type === "task.reopened") {
        const proj = getProject(cmd.project_id, this.dataDir);
        const verification = verifyReopenCommand(events, { entity_id: cmd.entity_id, role: cmd.role, payload: cmd.payload ?? {} }, {
          projectRoot: proj === undefined ? null : path.resolve(proj.path),
          workDir,
        });
        if (!verification.ok) {
          throw new WorkError(
            "INVALID_COMMAND",
            `重开核实不通过，拒绝提交 ${cmd.type}（${cmd.entity_id}），本次命令没有写入任何字节：` +
              verification.failures.join("；") +
              "（受控重开是协调器专用动作，判据见 DESIGN.md 附录 F；请经 claim_task 的 op=reopen 走受控入口）",
            { reason: "reopen_verification_failed", entity_id: cmd.entity_id, failures: verification.failures },
          );
        }
      }

      // ②ⅸ 同步域命令的写边界核实（V09-23／DESIGN §2.10）：`sync.contract_registered` 锁内全字段闭键 +
      // 来源实核 + 同批次改内容拒 + supersedes 不成环 + 职责边界；`sync.evidence_checked` 锁内重核身份与真实字节，
      // 并用**有界**图源/文件/业务投影重算指纹与锁外预评估比对（**不跑 sixGraphsOf 全量**）。伪造 passed、
      // "计算后目标又变"、超预算一律拒绝且零字节（直连通用写口不能绕过；见 sync.ts）。
      if (cmd.type === "sync.contract_registered") {
        assertSyncContractWriteCommand({ events, cmd, dataDir: this.dataDir, workDir });
      } else if (cmd.type === "sync.evidence_checked") {
        assertSyncEvidenceWriteCommand({ events, cmd, dataDir: this.dataDir, workDir, prep: syncEvidencePrep! });
      }

      // ③ 追加并持久化（fsync 后才回执）
      const receivedAt = nowIso();
      const event: WorkEvent = {
        schema_version: SCHEMA_VERSION,
        event_id: crypto.randomUUID(),
        project_id: cmd.project_id,
        change_id: cmd.change_id,
        entity_id: cmd.entity_id,
        entity_revision: current + 1,
        seq: (events[events.length - 1]?.seq ?? 0) + 1,
        type: cmd.type,
        actor_id: cmd.actor_id,
        role: cmd.role,
        occurred_at: cmd.occurred_at ?? receivedAt,
        received_at: receivedAt,
        idempotency_key: cmd.idempotency_key,
        payload: cmd.payload ?? {},
      };
      appendEventDurable(workDir, event);

      // ④ 投影（派生数据；失败不回滚事件，只标记 + 留修复入口）
      const projection = this.project(workDir, cmd.project_id, [...events, event]);

      return {
        ok: true,
        event_id: event.event_id,
        seq: event.seq,
        entity_revision: event.entity_revision,
        received_at: event.received_at,
        duplicate: false,
        projection,
      };
    });
  }

  /** 投影步骤：把事件重放成快照落盘；失败记 `projection-error.json`（可重建） */
  private project(
    workDir: string,
    projectId: string,
    events: WorkEvent[],
  ): WorkReceipt["projection"] {
    try {
      if (this.faults?.snapshot === "throw") {
        throw new Error("故障注入：投影写入失败（事件已提交）");
      }
      writeSnapshot(workDir, buildSnapshot(projectId, events, null));
      writeProjectionError(workDir, null);
      return { state: "applied" };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      try {
        writeProjectionError(workDir, { error: msg, last_seq: events[events.length - 1]?.seq ?? 0 });
      } catch {
        // 连失败标记都写不进去（同一处磁盘问题）：回执里仍然如实标 failed，不谎报 applied
      }
      return { state: "failed", error: msg };
    }
  }

  /**
   * 读快照。**不**在这里判"服务是否在线"——那由客户端的离线降级负责；
   * 本方法只如实报"这份快照是否落后于已提交事件"。
   */
  readSnapshot(projectId: unknown): WorkSnapshotRead {
    if (typeof projectId !== "string" || projectId.trim() === "") {
      throw new WorkError("INVALID_COMMAND", "project_id 必须是非空字符串", { field: "project_id" });
    }
    const id = projectId.trim();
    const workDir = resolveWorkDir(id, this.dataDir);
    const snap = readSnapshotFromDisk(workDir);
    const perr = readProjectionError(workDir);

    if (!snap) {
      const { events } = loadEvents(workDir); // 中间损坏在这里就会抛，不吞
      if (events.length === 0) {
        // 项目还没有任何已提交事件：这是"还没有事实"，不是"完成"
        return { snapshot: null, stale: true, stale_reason: "no_events" };
      }
      // 有事件但没有快照：现场可重建，但不能假装已经是最新
      return {
        snapshot: buildSnapshot(id, events, "快照缺失，下面的内容由事件现场重放得出"),
        stale: true,
        stale_reason: "snapshot_missing",
      };
    }
    if (perr && perr.last_seq >= snap.last_seq) {
      return {
        snapshot: { ...snap, projection_error: perr.error },
        stale: true,
        stale_reason: "projection_failed",
      };
    }
    return { snapshot: snap, stale: false, stale_reason: null };
  }

  /** 重放修复：以事件为事实源重建快照（投影失败的唯一修复入口） */
  repair(projectId: string): WorkSnapshotRead {
    const workDir = resolveWorkDir(projectId, this.dataDir);
    withFileLock(eventsPath(workDir), () => rebuildSnapshot(workDir, projectId));
    return this.readSnapshot(projectId);
  }

  /** 服务自述（health 用）：不含项目数据 */
  info(): {
    service: "work";
    schema_version: number;
    pid: number;
    data_dir: string;
    /** V06-09：已登记的业务事件词表（登记面在 types.ts#REGISTERED_EVENT_TYPES） */
    registered_event_types: string[];
  } {
    return {
      service: "work",
      schema_version: SCHEMA_VERSION,
      pid: process.pid,
      data_dir: this.dataDir,
      registered_event_types: registeredEventTypes(),
    };
  }
}

/** 幂等的内容口径：同键必须"调用方意图"完全相同才返回原回执（服务端产出的 seq/时间戳不参与） */
function sameIntent(c: WorkCommand, e: WorkEvent): boolean {
  return (
    c.project_id === e.project_id &&
    c.change_id === e.change_id &&
    c.entity_id === e.entity_id &&
    c.type === e.type &&
    c.actor_id === e.actor_id &&
    c.role === e.role &&
    (c.expected_revision ?? 0) === e.entity_revision - 1 &&
    (c.occurred_at === undefined || c.occurred_at === e.occurred_at) &&
    JSON.stringify(c.payload ?? {}) === JSON.stringify(e.payload)
  );
}

/** 事件侧的内容指纹（与命令侧 `commandFingerprint` 同字段序，便于排障时对照） */
function fingerprintOfEvent(e: WorkEvent): string {
  return JSON.stringify([
    e.schema_version,
    e.project_id,
    e.change_id,
    e.entity_id,
    e.entity_revision - 1,
    e.type,
    e.actor_id,
    e.role,
    e.occurred_at,
    e.payload,
  ]);
}

/** 供排障使用：命令侧指纹（导出以免被 DCE，同时给后续卡做对账） */
export function fingerprintOfCommand(c: WorkCommand): string {
  return commandFingerprint(c);
}

// ── 服务描述符（MCP 进程据此发现唯一的写入服务）──

export const SERVICE_DESCRIPTOR_FILE = "work-service.json";
export const WORK_TOKEN_HEADER = "x-tatai-work-token";

export interface WorkServiceDescriptor {
  schema_version: number;
  pid: number;
  host: string;
  port: number;
  token: string;
  started_at: string;
  url: string;
}

export function serviceDescriptorPath(dataDir: string): string {
  return path.join(dataDir, SERVICE_DESCRIPTOR_FILE);
}

export function writeServiceDescriptor(dataDir: string, desc: WorkServiceDescriptor): void {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = serviceDescriptorPath(dataDir);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(desc, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function readServiceDescriptor(dataDir: string): WorkServiceDescriptor | null {
  const file = serviceDescriptorPath(dataDir);
  if (!fs.existsSync(file)) return null;
  try {
    const d = JSON.parse(fs.readFileSync(file, "utf8")) as WorkServiceDescriptor;
    if (typeof d?.port !== "number" || typeof d?.token !== "string" || typeof d?.host !== "string") {
      return null;
    }
    return d;
  } catch {
    return null;
  }
}

export function removeServiceDescriptor(dataDir: string): void {
  fs.rmSync(serviceDescriptorPath(dataDir), { force: true });
}

// ── 回环 HTTP 面（桌面服务进程内挂载；MCP 是它的客户端）──

const WORK_ROUTE_PREFIX = "/api/work/";

export function isWorkRoute(pathname: string): boolean {
  return pathname.startsWith(WORK_ROUTE_PREFIX);
}

/** 错误码 → HTTP 状态（前四个是 PLAN 契约要求的四种，其余为本卡现场语义） */
const HTTP_STATUS: Record<WorkErrorCode, number> = {
  INVALID_COMMAND: 400,
  VERSION_CONFLICT: 409,
  IDEMPOTENCY_CONFLICT: 409,
  SERVICE_UNAVAILABLE: 503,
  PROJECTION_FAILED: 500,
  TAIL_QUARANTINED: 500,
  MIDDLE_CORRUPT: 500,
  EVENT_INVALID: 500,
  // V06-09：证据引用不合法（不存在/哈希对不上/试图改写不可变证据）——调用方改了命令就能修
  EVIDENCE_INVALID: 400,
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(text);
}

function readBody(req: IncomingMessage, limitBytes = 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new WorkError("INVALID_COMMAND", `请求体超过 ${limitBytes} 字节上限`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * 处理一条 work 路由；**返回 false 表示不是本模块的路由**（调用方继续走自己的路由表），
 * true 表示已经应答（成功或错误）。挂载方式见 `src/server/index.ts`。
 *
 * 鉴权：必须带描述符里的 token（写入面不放行匿名调用，即使绑定在回环地址）。
 */
export async function handleWorkRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: { service: WorkService; token: string; pathname: string },
): Promise<boolean> {
  if (!isWorkRoute(ctx.pathname)) return false;
  const method = req.method ?? "GET";
  const token = req.headers[WORK_TOKEN_HEADER];
  if (token !== ctx.token) {
    sendJson(res, 401, {
      code: "SERVICE_UNAVAILABLE",
      message: `缺少或错误的 ${WORK_TOKEN_HEADER}：写入服务只答带描述符凭据的本机调用`,
      detail: {},
    });
    return true;
  }

  try {
    if (method === "GET" && ctx.pathname === "/api/work/health") {
      sendJson(res, 200, { ok: true, ...ctx.service.info() });
      return true;
    }
    if (method === "GET" && ctx.pathname === "/api/work/snapshot") {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const projectId = url.searchParams.get("project_id") ?? "";
      sendJson(res, 200, ctx.service.readSnapshot(projectId));
      return true;
    }
    // V09-23 返工C（Codex 反例12）：**只读**同步状态/健康读口——MCP stdio 是另一个进程，不能拿本进程空内存
    // 的 syncRuntimeHealth 冒充"后台无故障"；这里由**唯一宿主**（桌面/daemon 同一 handleWorkRequest）给出
    // **同一份** report 与后台发现错误，MCP 只读转发、**不**触发扫描/写账、**不**按需拉起写者。
    if (method === "GET" && ctx.pathname === "/api/work/sync/status") {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const projectId = (url.searchParams.get("project_id") ?? "").trim();
      if (projectId === "") {
        sendJson(res, 400, { code: "INVALID_COMMAND", message: "sync/status 缺 project_id", detail: {} });
        return true;
      }
      const dataDir = ctx.service.info().data_dir;
      sendJson(res, 200, { ok: true, sync: readSyncStatus(projectId, dataDir), discovery_issues: readProjectDiscoveryIssues(projectId, dataDir) });
      return true;
    }
    if (method === "POST" && ctx.pathname === "/api/work/command") {
      const text = await readBody(req);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (e) {
        sendJson(res, 400, {
          code: "INVALID_COMMAND",
          message: `请求体不是合法 JSON: ${(e as Error).message}`,
          detail: {},
        });
        return true;
      }
      const receipt = ctx.service.submit(parsed);
      sendJson(res, 200, receipt);
      return true;
    }
    if (method === "POST" && ctx.pathname === "/api/work/repair") {
      const text = await readBody(req);
      const parsed = JSON.parse(text || "{}") as { project_id?: string };
      sendJson(res, 200, ctx.service.repair(parsed.project_id ?? ""));
      return true;
    }
    // V09-23（DESIGN §2.10）：显式同步扫描——与后台自动发现**共用同一逻辑与单飞队列**（syncDiscovery），
    // 真正唯一写口仍是本服务（submit）；返回值与只读 read_sync_status 同一份契约（src/shared/syncEvidence.ts）。
    if (method === "POST" && ctx.pathname === "/api/work/sync/scan") {
      const text = await readBody(req);
      const parsed = JSON.parse(text || "{}") as { project_id?: string; role?: string; actor_id?: string };
      const projectId = typeof parsed.project_id === "string" ? parsed.project_id.trim() : "";
      if (projectId === "") {
        sendJson(res, 400, { code: "INVALID_COMMAND", message: "sync/scan 缺 project_id", detail: {} });
        return true;
      }
      const role = typeof parsed.role === "string" && parsed.role.trim() !== "" ? parsed.role.trim() : "coordinator";
      const actorId = typeof parsed.actor_id === "string" && parsed.actor_id.trim() !== "" ? parsed.actor_id.trim() : "sync-scan";
      const outcome = await runSyncScanForRequest({
        projectId,
        dataDir: ctx.service.info().data_dir,
        submitter: ctx.service,
        role,
        actorId,
      });
      sendJson(res, 200, outcome);
      return true;
    }
    sendJson(res, 405, {
      code: "INVALID_COMMAND",
      message: `work 面不支持 ${method} ${ctx.pathname}`,
      detail: {},
    });
    return true;
  } catch (e) {
    if (isWorkError(e)) {
      sendJson(res, HTTP_STATUS[e.code] ?? 500, e.toJSON());
      return true;
    }
    sendJson(res, 500, {
      code: "PROJECTION_FAILED",
      message: `写入服务内部错误: ${e instanceof Error ? e.message : String(e)}`,
      detail: {},
    });
    return true;
  }
}

// ── 按需拉起独立写入服务（V07-01；宿主本体在 daemon.ts）──

/**
 * 解析独立写入服务入口：优先 env 覆盖（TATAI_WRITE_SERVICE_ENTRY）；
 * 产物态在包内根目录找 write-service.js（本文件被 vite 打进 assets/ 分块，要向上找两级）；
 * 开发态找仓库源码 daemon.ts（由 tsx 起）。
 */
function resolveWriteServiceEntry(): string | null {
  const override = process.env.TATAI_WRITE_SERVICE_ENTRY;
  if (typeof override === "string" && override !== "") return override;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const bundled = [here, path.join(here, ".."), path.join(here, "..", "..")]
    .map((dir) => path.join(dir, "write-service.js"))
    .find((f) => fs.existsSync(f));
  if (bundled !== undefined) return bundled;
  const dev = [path.join(here, "daemon.ts"), path.join(here, "..", "work", "daemon.ts")]
    .map((f) => path.normalize(f))
    .find((f) => fs.existsSync(f));
  return dev ?? null;
}

/** tsx 加载器定位：从本模块解析（开发态才需要；解析失败退回裸名，交给 node 的 cwd 解析） */
function resolveTsxLoader(): string {
  try {
    return pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
  } catch {
    return "tsx";
  }
}

/** detached 拉起独立写入服务（无窗口、不随父进程退出）；dataDir 必传——daemon 靠它落对数据目录 */
export function spawnWriteService(dataDir: string): boolean {
  const entry = resolveWriteServiceEntry();
  if (entry === null) return false;
  const args = entry.endsWith(".ts") ? ["--import", resolveTsxLoader(), entry] : [entry];
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    // TATAI_HOME 显式指向调用方的数据目录：不继承就可能落到默认 home，把服务发布到别人的账本上
    env: { ...process.env, TATAI_HOME: dataDir },
  });
  child.unref();
  return true;
}

// ── 转接客户端（stdio MCP 用它把写入转给唯一写入服务）──

export interface WorkClientOptions {
  dataDir: string;
  /** 单次调用超时（ms）；超时按服务不可用处理，不无限等待 */
  timeoutMs?: number;
  /** 自愈拉起独立写入服务（V07-01 默认开；TATAI_NO_AUTOSTART=1 或此处 false 关闸——验证"不本地代写"不变量用） */
  autostart?: boolean;
}

export interface WorkAvailability {
  available: boolean;
  reason: string | null;
  descriptor: WorkServiceDescriptor | null;
}

/**
 * 描述符里的 pid 是否已死（ESRCH）——识别"服务实例死亡没撤描述符"的陈旧指针
 * （硬杀/崩溃无钩子；2026-09-21 实测缺陷③）。进程还在（含权限不足 EPERM）一律算活，
 * 宁可误判为活也不误杀 pid 复用后的新进程。
 */
function descriptorPidDead(desc: WorkServiceDescriptor): boolean {
  if (typeof desc.pid !== "number" || !Number.isInteger(desc.pid) || desc.pid <= 0) return false;
  try {
    process.kill(desc.pid, 0);
    return false;
  } catch (e: unknown) {
    return (e as NodeJS.ErrnoException)?.code === "ESRCH";
  }
}

/**
 * 描述符指向的进程是否还活着（doctor 报"描述符新鲜度"用）。
 * 判据与自愈清理完全同一份（`descriptorPidDead` 取反）——不另写一套 pid 存活逻辑，
 * 免得"自愈认为该死、体检认为还活"这种两份口径打架的现场。
 */
export function descriptorPidAlive(desc: WorkServiceDescriptor): boolean {
  return !descriptorPidDead(desc);
}

/** 陈旧描述符的用户提示（探活/提交失败时附在报错里指路） */
function staleDescriptorHint(desc: WorkServiceDescriptor): string {
  return descriptorPidDead(desc)
    ? `（描述符疑似陈旧：pid ${desc.pid} 已退出——重启塔台桌面应用或等客户端自愈拉起独立写入服务）`
    : "";
}

export class WorkServiceClient {
  private readonly dataDir: string;
  private readonly timeoutMs: number;
  private readonly autostart: boolean;

  constructor(opts: WorkClientOptions) {
    this.dataDir = opts.dataDir;
    this.timeoutMs = opts.timeoutMs ?? 5_000;
    this.autostart = opts.autostart ?? process.env.TATAI_NO_AUTOSTART !== "1";
  }

  /** 服务是否可用（探活；不做任何写入） */
  async probe(): Promise<WorkAvailability> {
    const desc = readServiceDescriptor(this.dataDir);
    if (!desc) {
      return { available: false, reason: "写入服务未启动（数据目录里没有服务描述符）", descriptor: null };
    }
    try {
      const res = await fetch(`http://${desc.host}:${desc.port}/api/work/health`, {
        headers: { [WORK_TOKEN_HEADER]: desc.token },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) {
        return { available: false, reason: `写入服务探活失败：HTTP ${res.status}`, descriptor: desc };
      }
      return { available: true, reason: null, descriptor: desc };
    } catch (e) {
      return {
        available: false,
        reason: `写入服务不可达：${e instanceof Error ? e.message : String(e)}${staleDescriptorHint(desc)}`,
        descriptor: desc,
      };
    }
  }

  /**
   * V09-23 返工C（Codex 反例12）：**只读**取唯一宿主的同步状态/健康——**只用已有描述符，绝不 ensure/拉起写者**
   * （read 是纯只读，不得自动 spawn 任何 writer/写 events）。独立 daemon 只服务 `/api/work/*`；桌面宿主把
   * `/api/projects/:id/sync-status` 直挂 8787（未转发 work 面），故先试 work 读口再退回该只读项目读口。
   * 描述符不存在/不可达/读口不完整 → `null`（调用方按「无法核对宿主后台健康」fail-closed，绝不静默当通过）。
   */
  async readSyncStatusRemote(projectId: string): Promise<{ report: SyncStatusReport; discovery_issues: string[] } | null> {
    const desc = readServiceDescriptor(this.dataDir);
    if (!desc) return null;
    const tryGet = async (p: string, withToken: boolean): Promise<{ report: SyncStatusReport; discovery_issues: string[] } | null> => {
      try {
        const headers: Record<string, string> = {};
        if (withToken) headers[WORK_TOKEN_HEADER] = desc.token;
        const res = await fetch(`http://${desc.host}:${desc.port}${p}`, { headers, signal: AbortSignal.timeout(this.timeoutMs) });
        if (!res.ok) return null;
        const body = (await res.json().catch(() => null)) as { ok?: boolean; sync?: SyncStatusReport; discovery_issues?: unknown } | null;
        if (body?.ok !== true || body.sync === undefined || body.sync === null) return null;
        return { report: body.sync, discovery_issues: Array.isArray(body.discovery_issues) ? (body.discovery_issues as string[]).filter((s) => typeof s === "string") : [] };
      } catch {
        return null;
      }
    };
    return (
      (await tryGet(`/api/work/sync/status?project_id=${encodeURIComponent(projectId)}`, true)) ??
      (await tryGet(`/api/projects/${encodeURIComponent(projectId)}/sync-status`, false))
    );
  }

  /**
   * 唯一写入服务自愈（V07-01）：探活 → 清陈旧描述符（pid 已死）→ 按需拉起独立写入服务
   * （detached daemon）→ 等健康。`TATAI_NO_AUTOSTART=1` 关自愈闸（排查用）。绝不本地代写。
   */
  async ensureWorkService(): Promise<WorkServiceDescriptor | null> {
    const alive = await this.probe();
    if (alive.available && alive.descriptor !== null) return alive.descriptor;
    const stale = readServiceDescriptor(this.dataDir);
    if (stale !== null && descriptorPidDead(stale)) removeServiceDescriptor(this.dataDir);
    if (!this.autostart) return null;
    if (!spawnWriteService(this.dataDir)) return null;
    for (let i = 0; i < 25; i++) {
      // ≤5s 等健康：daemon 起来要先探活（可能撞上活服务退位）再绑定发布
      await new Promise((resolve) => setTimeout(resolve, 200));
      const probed = await this.probe();
      if (probed.available && probed.descriptor !== null) return probed.descriptor;
    }
    return null;
  }

  /** 单次 POST 命令；fetch 失败返回 null（HTTP 错误状态照样返回 Response，由调用方判状态） */
  private async postCommand(desc: WorkServiceDescriptor, command: unknown): Promise<Response | null> {
    try {
      return await fetch(`http://${desc.host}:${desc.port}/api/work/command`, {
        method: "POST",
        headers: { "content-type": "application/json", [WORK_TOKEN_HEADER]: desc.token },
        body: JSON.stringify(command),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      return null;
    }
  }

  /**
   * 提交写入。**服务不可用时一律抛 `SERVICE_UNAVAILABLE`，绝不退化成"自己写文件"**——
   * 那正是 §2.6 要禁止的第二个写者。V07-01 起：不可达先自愈一次（清死指针/拉起 daemon）
   * 再重试原命令；自愈失败才如实报不可用。
   */
  async submit(command: unknown): Promise<WorkReceipt> {
    let desc = readServiceDescriptor(this.dataDir);
    if (!desc) {
      desc = await this.ensureWorkService();
      if (desc === null) {
        throw new WorkError(
          "SERVICE_UNAVAILABLE",
          "写入服务未启动：v2 事实只有一个写入者，MCP 不自己追加事件。已尝试按需拉起独立写入服务未果——请启动塔台桌面应用，或检查 node 可用性（TATAI_NO_AUTOSTART=1 会关掉自愈）",
          { data_dir: this.dataDir },
        );
      }
    }
    let res = await this.postCommand(desc, command);
    if (res === null) {
      const recovered = await this.ensureWorkService();
      if (recovered !== null) res = await this.postCommand(recovered, command);
      if (res === null) {
        throw new WorkError(
          "SERVICE_UNAVAILABLE",
          `写入服务不可达（${desc.host}:${desc.port}）：fetch failed。自愈（清死描述符/按需拉起）后仍不可达。本次没有写入任何字节${staleDescriptorHint(desc)}`,
          { host: desc.host, port: desc.port },
        );
      }
    }
    const body = (await res.json().catch(() => null)) as
      | { code?: WorkErrorCode; message?: string; detail?: Record<string, unknown> }
      | null;
    if (!res.ok) {
      const code = (body?.code ?? "SERVICE_UNAVAILABLE") as WorkErrorCode;
      throw new WorkError(code, body?.message ?? `写入服务返回 HTTP ${res.status}`, body?.detail ?? {});
    }
    return body as unknown as WorkReceipt;
  }

  /**
   * V09-23：请求**唯一写服务宿主**扫描某项目的同步证据（与后台自动发现共用同一逻辑/单飞队列）。
   * 服务不可达时按自愈重试一次；仍不可达抛 `SERVICE_UNAVAILABLE`（不退化为本地自己写）。
   */
  async scanSyncEvidence(projectId: string, opts: { role?: string; actorId?: string } = {}): Promise<unknown> {
    const body = JSON.stringify({ project_id: projectId, ...(opts.role === undefined ? {} : { role: opts.role }), ...(opts.actorId === undefined ? {} : { actor_id: opts.actorId }) });
    const doPost = async (desc: WorkServiceDescriptor): Promise<Response | null> => {
      try {
        return await fetch(`http://${desc.host}:${desc.port}/api/work/sync/scan`, {
          method: "POST",
          headers: { "content-type": "application/json", [WORK_TOKEN_HEADER]: desc.token },
          body,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch {
        return null;
      }
    };
    let desc = readServiceDescriptor(this.dataDir);
    if (!desc) {
      desc = await this.ensureWorkService();
      if (desc === null) throw new WorkError("SERVICE_UNAVAILABLE", "sync 扫描需要唯一写入服务：未启动且按需拉起未果", { data_dir: this.dataDir });
    }
    let res = await doPost(desc);
    if (res === null) {
      const recovered = await this.ensureWorkService();
      if (recovered !== null) res = await doPost(recovered);
      if (res === null) throw new WorkError("SERVICE_UNAVAILABLE", `sync 扫描入口不可达（${desc.host}:${desc.port}）`, { host: desc.host, port: desc.port });
    }
    const bodyText = (await res.json().catch(() => null)) as { code?: WorkErrorCode; message?: string; detail?: Record<string, unknown> } | null;
    if (!res.ok) throw new WorkError((bodyText?.code ?? "SERVICE_UNAVAILABLE") as WorkErrorCode, bodyText?.message ?? `sync 扫描返回 HTTP ${res.status}`, bodyText?.detail ?? {});
    return bodyText;
  }

  /**
   * 读快照。服务不可达时退化为磁盘上**最后一份快照**并标 `stale`——
   * 旧的可以看，但不能冒充当前事实（DESIGN.md §2.6 / §11.8）。
   */
  async snapshot(projectId: string): Promise<WorkSnapshotRead> {
    const desc = readServiceDescriptor(this.dataDir);
    if (desc) {
      try {
        const res = await fetch(
          `http://${desc.host}:${desc.port}/api/work/snapshot?project_id=${encodeURIComponent(projectId)}`,
          { headers: { [WORK_TOKEN_HEADER]: desc.token }, signal: AbortSignal.timeout(this.timeoutMs) },
        );
        if (res.ok) return (await res.json()) as WorkSnapshotRead;
      } catch {
        // 走下面的离线降级
      }
    }
    return this.snapshotOffline(projectId, desc ? "service_unavailable" : "service_not_running");
  }

  /** 离线：读最后快照（服务没起也读得到，因为快照就在项目目录里） */
  snapshotOffline(projectId: string, reason: string): WorkSnapshotRead {
    let workDir: string;
    try {
      workDir = projectWorkDir(projectId, this.dataDir);
    } catch {
      return { snapshot: null, stale: true, stale_reason: "project_not_found" };
    }
    const snap = readSnapshotFromDisk(workDir);
    if (!snap) return { snapshot: null, stale: true, stale_reason: reason };
    return {
      snapshot: { ...snap, projection_error: readProjectionError(workDir)?.error ?? snap.projection_error },
      stale: true,
      stale_reason: reason,
    };
  }
}

/** 落一行"服务启动/停止"到全局日志（排障用；不写进任何项目目录） */
export function logServiceLifecycle(dataDir: string, event: "start" | "stop", detail: Record<string, unknown> = {}): void {
  try {
    const dir = path.join(dataDir, "logs");
    fs.mkdirSync(dir, { recursive: true });
    appendJsonlLine(
      path.join(dir, "work-service.jsonl"),
      JSON.stringify({ ts: nowIso(), event, pid: process.pid, ...detail }),
    );
  } catch {
    // 日志写不进去不影响服务本身
  }
}
