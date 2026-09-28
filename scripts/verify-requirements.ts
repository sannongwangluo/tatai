// 需求对象库（I-1）＋变更批次对象库（I-2）验证脚本（审计轮 R20260920-1 修复批 3 / T21；
// DESIGN.md §2.5 / §2.6，判词 TPL-10-Codex 更新判词 §六② 纠正版）。
// 用法：node --import tsx scripts/verify-requirements.ts（package.json 登记 verify:requirements）
//
// 自带隔离环境：临时 TATAI_HOME + 临时夹具项目（`os.tmpdir()` 下），**不碰**任何真实项目的
// `.工作台/`；塔台根文档只读（首尾逐文件 sha256 对照，证明零改动）；收尾清理自建临时目录
// （TATAI_KEEP_TMP=1 保留现场）。
//
// 覆盖点（T21 验收六条 + §2.6 单源分工，逐条真跑，断言不写成同义反复）：
//   ① 正常创建：需求 / 变更批次各提交首条事件，回执带 event_id / seq / entity_revision；
//   ② 读回：投影重建后字段与写入一致（含 status、来源引用、目标基线引用）；
//   ③ 悬空引用拒绝：任务 `requirement_ids` 指不存在的需求、`change_id` 指不存在的批次、
//      采纳不存在的聊天记录——三者都拒，且错误里点名缺的那个 id；
//   ④ 基线绑定：批次 `target_baseline` 指既有基线的两份修订内容哈希，读回逐字一致；
//   ⑤ 重放一致：删掉投影、重放事件流，需求 / 变更投影逐字节一致；
//   ⑥ 旧数据兼容：没有这些字段的旧任务事件与旧式导入照常投影 / 导入；新字段确实进定义哈希
//      （证明它不是被忽略的摆设，也不是"旧数据路径被改了口径"）；
//   ⑦ §2.6 单源分工：需求对象里没有意图正文的拷贝（只有来源引用），正文键在**读侧与写侧**
//      都被点名拒收；聊天记录被"显式采纳"后仍只在原文件里、原文件一个字节没被回写。
//   ⑧ C-015 接线（批3终审）：status_changed 读侧闭键补齐；submitDefinitionImports（真实写口）
//      提交前按投影查引用（悬空拒、零写入、无读侧 fail-closed、旧路径零改动）；对象命令与受检导入
//      接上真实生产入口——MCP 工具 manage_requirement / manage_change / import_plan_definitions
//      入口级真链路（工具 handler → 对象命令校验 → 转接真 WorkService → 事件落盘 → 读回），
//      GET /plan 生产读入口走 importPlanChecked。
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkService } from "../src/server/work/service";
import { loadEvents, rebuildSnapshot } from "../src/server/work/eventStore";
import { REGISTERED_EVENT_TYPES, WorkError, registeredEventTypes } from "../src/server/work/types";
import {
  CHANGE_EVENT_TYPES,
  CHANGE_PAYLOAD_KEYS,
  CHANGE_STATUSES,
  CHANGE_STATUS_LABELS,
  adoptChatChange,
  changeIdsOf,
  chatChangeRecordHash,
  closeChange,
  foldChanges,
  openChange,
  readChanges,
  readChatChangeRecords,
  setChangeStatus,
  targetBaselineOf,
} from "../src/server/work/changes";
import {
  REQUIREMENT_EVENT_TYPES,
  REQUIREMENT_PAYLOAD_KEYS,
  REQUIREMENT_SOURCE_KINDS,
  REQUIREMENT_STATUSES,
  REQUIREMENT_STATUS_LABELS,
  foldRequirements,
  readRequirements,
  registerRequirement,
  requirementIdsOf,
  setRequirementStatus,
  updateRequirement,
} from "../src/server/work/requirements";
import { CHAT_CHANGES_FILE } from "../src/server/work/chatActions";
import { activeBaseline, activateBaseline } from "../src/server/work/documents";
import { importTaskDefinitions, taskDefinitionHash, validateTaskDefinitions, type TaskDefinition } from "../src/server/work/plan";
import { collectRegisteredReferences, importPlanChecked } from "../src/server/work/references";
import { alignPlanWithWork, readTaskStates, submitDefinitionImports } from "../src/server/work/tasks";
import { TOOLS } from "../src/mcp/tools";
import { importPlanDefinitionsTool, manageChangeTool, manageRequirementTool } from "../src/mcp/tools/workObjects";
import type { WorkServiceClient } from "../src/server/work/service";
import type { PlanIssue } from "../src/server/work/planValidate";

const REPO = process.cwd();
const MAIN = "t21-main";
const LEGACY = "t21-legacy";
const CHG = "change-none";
const CHG_BATCH = "change-扫描可取消";
const REQ_ID = "req-扫描可取消";
/** 本脚本只读的塔台根文档（首尾 sha256 对照，证明零改动） */
const REPO_FILES = ["DESIGN.md", "PLAN.md", "PROGRESS.md", "AGENTS.md", "README.md"];

let passCount = 0;
let failCount = 0;
const ok = (cond: boolean, label: string) => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (cond) passCount++;
  else {
    failCount++;
    process.exitCode = 1;
  }
};
const info = (msg: string) => console.log(`[verify] ${msg}`);
const sha256 = (data: string | Buffer): string => crypto.createHash("sha256").update(data).digest("hex");
const sha256File = (f: string): string => sha256(fs.readFileSync(f));
const short = (s: string | null | undefined, n = 12): string => (s == null ? "null" : `${s.slice(0, n)}…`);
const sorted = (xs: readonly string[]): string => [...xs].sort().join(",");

/** 断言里的错误捕获：只认 WorkError（别的抛出说明现场不是我们以为的那样，不能算通过） */
function workErrorOf(fn: () => unknown): WorkError | null {
  try {
    fn();
    return null;
  } catch (e) {
    if (e instanceof WorkError) return e;
    console.log(`[verify]   （非 WorkError 抛出：${(e as Error).message}）`);
    return null;
  }
}
const reasonOf = (e: WorkError | null): unknown => e?.detail?.reason;
const issuesOf = (e: WorkError | null): PlanIssue[] => (e?.detail?.issues as PlanIssue[] | undefined) ?? [];

// ── 塔台根文档零改动（首尾哈希） ──
const docBefore = new Map<string, string>();
for (const rel of REPO_FILES) {
  const abs = path.join(REPO, rel);
  docBefore.set(rel, fs.existsSync(abs) ? sha256File(abs) : "<missing>");
}

// ── 隔离环境与夹具 ──
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-t21-verify-"));
const dataDir = path.join(tmpBase, "home");
const mainRoot = path.join(tmpBase, "main");
const legacyRoot = path.join(tmpBase, "legacy");
const mkdirp = (d: string) => fs.mkdirSync(d, { recursive: true });
const write = (f: string, text: string) => {
  mkdirp(path.dirname(f));
  fs.writeFileSync(f, text, "utf8");
};
const read = (f: string) => fs.readFileSync(f, "utf8");
const workbench = (root: string) => path.join(root, ".工作台");
const MAIN_WORK = path.join(workbench(mainRoot), "work");
const LEGACY_WORK = path.join(workbench(legacyRoot), "work");
for (const d of [dataDir, mainRoot, legacyRoot]) mkdirp(d);

const MAIN_PLAN = [
  "# 夹具施工图（T21）",
  "",
  "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |",
  "| --- | --- | --- | --- | --- |",
  "| T-1 | todo | 扫描可取消 |  | 取消按钮生效记录 |",
  "| T-2 | todo | 取消后清理临时文件 | T-1 | 临时文件清单为空 |",
  "",
  "### T-1 扫描可取消",
  "",
  "**设计依据**：§2.5。**依赖**：无。",
  "",
  "**契约**：输入扫描任务，输出可取消句柄。",
  "",
  "**文件责任**：新增 `src/scan.ts`。",
  "",
  "- [ ] 扫描中点取消立即停",
  "- [ ] 取消后状态可读回",
  "",
  "**交付**：取消链路验收记录。",
  "",
  "### T-2 取消后清理临时文件",
  "",
  "**设计依据**：§2.5。**依赖**：T-1。",
  "",
  "**契约**：输入取消信号，输出清理结果。",
  "",
  "**文件责任**：新增 `src/cleanup.ts`。",
  "",
  "- [ ] 临时文件清零",
  "",
  "**交付**：清理验收记录。",
  "",
].join("\n");
const MAIN_DESIGN = "# T21 夹具设计书\n\n## 1 概述\n本夹具用于验证需求对象与变更批次对象。\n";
write(path.join(workbench(mainRoot), "design.md"), MAIN_DESIGN);
write(path.join(workbench(mainRoot), "plan.md"), MAIN_PLAN);

const projectRecord = (id: string, name: string, dir: string) => ({
  id,
  name,
  path: dir,
  kind: "backend",
  registered_at: "2026-09-20T00:00:00+08:00",
  last_opened_at: "2026-09-20T00:00:00+08:00",
});
write(
  path.join(dataDir, "registry.json"),
  JSON.stringify(
    {
      version: 1,
      projects: [
        projectRecord(MAIN, "T21 主夹具", mainRoot),
        projectRecord(LEGACY, "T21 旧数据夹具", legacyRoot),
      ],
    },
    null,
    2,
  ),
);
process.env.TATAI_HOME = dataDir;

// ── 既有基线（③/④/⑤ 用的"真基线"：走 documents 的激活链，不手抄哈希） ──
const activated = activateBaseline(
  MAIN,
  { approved_by: "user", approval_basis: "夹具：设计书与施工图配套审定", approval_kind: "user_confirmed" },
  dataDir,
);
const baseline = activeBaseline(MAIN, dataDir);

// ── 唯一写入者 + 读侧闭包（改状态/采纳要先读当前事实，模块不猜项目路径） ──
const service = new WorkService({ dataDir });
const makeSubmitter = (workDir: string, workbenchDir: string) => ({
  submit: (command: unknown) => service.submit(command),
  // 项目 `.工作台/`（`intent.json` 所在层）：登记里 `source.kind="intent"` 的引用要做实解析（§2.5 引用有效性）
  workbenchDir,
  read: () => {
    const r = readRequirements(workDir);
    const c = readChanges(workDir);
    return { requirements: r.requirements, changes: c.changes };
  },
  readChatChanges: () => readChatChangeRecords(workDir),
  // 定义导入提交侧的投影读侧（C-015 接线：submitDefinitionImports 查引用用，从同一份事件投影现读）
  readReferences: () => collectRegisteredReferences(workDir),
});
const submitter = makeSubmitter(MAIN_WORK, workbench(mainRoot));
const legacySubmitter = makeSubmitter(LEGACY_WORK, workbench(legacyRoot));

/** 夹具聊天变更记录（原样由本脚本写进 chat-changes.jsonl；本脚本扮演的正是 chatActions 那个写入者） */
const CHAT_TEXT = "用户说：扫描到一半想停，只能等它跑完，很不爽";
const CHAT_CHANGE = {
  change_id: "chg-20260920-1",
  project_id: MAIN,
  at: "2026-09-20T10:00:00+08:00",
  session_id: "20260920-100000-ab12cd34",
  action_id: "act-0001",
  kind: "change",
  target: { kind: "task", id: "T-1" },
  text: CHAT_TEXT,
  sources: ["chat:20260920-100000-ab12cd34"],
  scope: "local",
  status: "open",
};
const chatChangesFile = path.join(MAIN_WORK, CHAT_CHANGES_FILE);
mkdirp(MAIN_WORK);
write(chatChangesFile, `${JSON.stringify(CHAT_CHANGE)}\n`);

/** 夹具意图正文（`.工作台/intent.json`：意图正文的唯一写入源那份文件，本脚本只当它是原文） */
const INTENT_BODY = "用户原话：扫描跑起来以后我要能随时掐掉它，不要让我等到天荒地老";
const intentFile = path.join(workbench(mainRoot), "intent.json");
write(intentFile, JSON.stringify({ version: 1, items: [{ id: "r-1", text: INTENT_BODY }] }, null, 2));

/** 手写事件（读侧坏现场负向用；不写盘、不污染事件文件） */
interface RawEvent {
  schema_version: 2;
  event_id: string;
  project_id: string;
  change_id: string;
  entity_id: string;
  entity_revision: number;
  seq: number;
  type: string;
  actor_id: string;
  role: string;
  occurred_at: string;
  received_at: string;
  idempotency_key: string;
  payload: Record<string, unknown>;
}
const mkEvent = (seq: number, entity_id: string, type: string, payload: Record<string, unknown>): RawEvent => ({
  schema_version: 2,
  event_id: `e${seq}`,
  project_id: MAIN,
  change_id: CHG,
  entity_id,
  entity_revision: 1,
  seq,
  type,
  actor_id: "kimi-code",
  role: "coordinator",
  occurred_at: "2026-09-20T01:00:00+08:00",
  received_at: "2026-09-20T01:00:00+08:00",
  idempotency_key: `k${seq}`,
  payload,
});

async function main(): Promise<void> {
  info("T21 需求对象库（I-1）＋变更批次对象库（I-2）：§2.5 最小字段 / §2.6 单源分工 / 悬空引用拒");
  info(`  node ${process.version} · ${process.platform} · repo ${REPO}`);
  info(`  夹具：home=${dataDir}（临时）· ${MAIN} / ${LEGACY}`);

  // ══════════════════════════ ① 词表与登记面 ══════════════════════════
  info("── ① 词表登记：需求 3 类 / 变更批次 5 类（C016 起含 change.blueprint_inheritance_recorded），都挂在各自实体前缀上");
  const registered = registeredEventTypes();
  ok(
    REQUIREMENT_EVENT_TYPES.length === 3 &&
      CHANGE_EVENT_TYPES.length === 5 && // C016（2026-09-21）新增 change.blueprint_inheritance_recorded：4 → 5
      [...REQUIREMENT_EVENT_TYPES, ...CHANGE_EVENT_TYPES].every((t) => registered.includes(t)),
    `①-1 八个新事件类型都在登记面里（需求 ${REQUIREMENT_EVENT_TYPES.join(" ")}；批次 ${CHANGE_EVENT_TYPES.join(" ")}）`,
  );
  ok(
    REGISTERED_EVENT_TYPES.filter((r) => r.type.startsWith("requirement.")).every((r) => r.entity_prefix === "requirement:") &&
      REGISTERED_EVENT_TYPES.filter((r) => r.type.startsWith("change.")).every((r) => r.entity_prefix === "change:"),
    "①-1 登记条目的实体前缀与模块约定一致（requirement: / change:）",
  );
  ok(
    REQUIREMENT_STATUSES.length === 3 &&
      REQUIREMENT_STATUS_LABELS.explicit === "明确" &&
      REQUIREMENT_STATUS_LABELS.inferred === "推断" &&
      REQUIREMENT_STATUS_LABELS.unconfirmed === "待确认" &&
      CHANGE_STATUSES.length === 3 &&
      CHANGE_STATUS_LABELS.open === "进行中" &&
      CHANGE_STATUS_LABELS.iterating === "迭代中" &&
      CHANGE_STATUS_LABELS.closed === "已关闭",
    "①-1 §2.5 明确/推断/待确认 三态与 进行中/迭代中/已关闭 三态齐全（推断不当事实、关闭不是删除）",
  );

  // ══════════════════════════ ② 基线绑定（真基线，不手抄哈希） ══════════════════════════
  info("── ② 目标基线引用：从既有基线取两份修订的内容哈希（§2.6：只引用哈希，不复制基线内容）");
  ok(
    activated.created === true && baseline !== null,
    `②-1 夹具基线激活成功（baseline_id=${baseline?.baseline_id ?? "null"}，created=${activated.created}）`,
  );
  ok(
    baseline !== null &&
      /^[0-9a-f]{64}$/.test(baseline.design_revision.content_sha256) &&
      /^[0-9a-f]{64}$/.test(baseline.plan_revision.content_sha256),
    `②-1 基线两份修订各带 64 位内容哈希（design ${short(baseline?.design_revision.content_sha256)} / plan ${short(baseline?.plan_revision.content_sha256)}）`,
  );
  const targetBaseline = targetBaselineOf(baseline!);
  ok(
    targetBaseline.design_revision === baseline!.design_revision.content_sha256 &&
      targetBaseline.plan_revision === baseline!.plan_revision.content_sha256 &&
      targetBaseline.baseline_id === baseline!.baseline_id,
    "②-1 targetBaselineOf 从基线现取哈希（不是脚本里手抄一份，避免与基线漂移）",
  );

  // ══════════════════════════ ①-② 正常创建 + 读回 ══════════════════════════
  info("── ①/② 正常创建需求与变更批次：回执带 event_id/seq/entity_revision，读回字段与写入一致");
  const reqRec = registerRequirement(submitter, {
    project_id: MAIN,
    requirement_id: REQ_ID,
    change_id: CHG,
    actor_id: "kimi-code",
    role: "coordinator",
    source: { kind: "intent", ref: "intent.json#r-1" },
    problem: "扫描中途无法取消",
    users: ["现场操作员"],
    success_scenarios: ["扫描中点取消立即停"],
    exclusions: ["不做断点续扫"],
    priority: "P1",
    status: "explicit",
  });
  ok(
    reqRec.ok === true && reqRec.event_id !== "" && reqRec.seq > 0 && reqRec.entity_revision === 1 && reqRec.duplicate === false,
    `①-2 需求注册回执齐全（event_id=${short(reqRec.event_id)}、seq=${reqRec.seq}、entity_revision=${reqRec.entity_revision}）`,
  );
  const changeRec = openChange(submitter, {
    project_id: MAIN,
    change_batch_id: CHG_BATCH,
    change_id: CHG,
    actor_id: "gpt-6",
    role: "coordinator",
    goal: "扫描可取消",
    authorized_scope: "仅扫描流程，不动其它入口",
    target_baseline: targetBaseline,
    affected_subsystems: ["扫描"],
    exit_criteria: "取消后 1 秒内停，临时文件清零",
  });
  ok(
    changeRec.ok === true && changeRec.event_id !== "" && changeRec.seq > reqRec.seq && changeRec.entity_revision === 1,
    `①-2 变更批次开启回执齐全（seq=${changeRec.seq} > 需求 ${reqRec.seq}、entity_revision=${changeRec.entity_revision}）`,
  );

  const reqs = readRequirements(MAIN_WORK);
  const reqState = reqs.requirements[REQ_ID];
  if (reqState === undefined) throw new Error(`夹具异常：需求 ${REQ_ID} 没有读回来`);
  ok(
    reqState !== undefined &&
      reqState.source.kind === "intent" &&
      reqState.source.ref === "intent.json#r-1" &&
      reqState.problem === "扫描中途无法取消" &&
      reqState.users.join(",") === "现场操作员" &&
      reqState.success_scenarios.join(",") === "扫描中点取消立即停" &&
      reqState.exclusions.join(",") === "不做断点续扫" &&
      reqState.priority === "P1" &&
      reqState.status === "explicit" &&
      reqState.status_label === "明确",
    `②-2 读回需求：§2.5 最小字段逐项一致（status=${reqState?.status}、source=${reqState?.source.kind}:${reqState?.source.ref}）`,
  );
  ok(
    reqState.revision === reqRec.entity_revision &&
      reqState.seq === reqRec.seq &&
      reqState.last_event_id === reqRec.event_id &&
      reqState.change_id === CHG,
    `②-2 读回需求元数据与回执对得上（revision=${reqState?.revision}、seq=${reqState?.seq}、change_id=${reqState?.change_id}）`,
  );
  ok(
    REQUIREMENT_PAYLOAD_KEYS.every((k) => Object.prototype.hasOwnProperty.call(reqState, k)),
    `②-2 §2.5 七个字段一个不少：${REQUIREMENT_PAYLOAD_KEYS.join(" / ")}`,
  );

  const changeState = readChanges(MAIN_WORK).changes[CHG_BATCH];
  if (changeState === undefined) throw new Error(`夹具异常：批次 ${CHG_BATCH} 没有读回来`);
  ok(
    changeState !== undefined &&
      changeState.goal === "扫描可取消" &&
      changeState.authorized_scope === "仅扫描流程，不动其它入口" &&
      changeState.affected_subsystems.join(",") === "扫描" &&
      changeState.exit_criteria === "取消后 1 秒内停，临时文件清零" &&
      changeState.status === "open" &&
      changeState.iteration === 1,
    `②-2 读回变更批次：§2.5 五字段逐项一致（status=${changeState?.status}、iteration=${changeState?.iteration}）`,
  );
  ok(
    CHANGE_PAYLOAD_KEYS.every((k) => Object.prototype.hasOwnProperty.call(changeState, k)),
    `②-2 §2.5 五个字段一个不少：${CHANGE_PAYLOAD_KEYS.join(" / ")}`,
  );

  // ④ 基线绑定读回
  ok(
    changeState.target_baseline.design_revision === baseline!.design_revision.content_sha256 &&
      changeState.target_baseline.plan_revision === baseline!.plan_revision.content_sha256 &&
      changeState.target_baseline.baseline_id === baseline!.baseline_id,
    `④-1 读回的目标基线 = 既有基线的两份修订哈希（design ${short(changeState.target_baseline.design_revision)} / plan ${short(changeState.target_baseline.plan_revision)}）`,
  );
  const badBaseline = workErrorOf(() =>
    openChange(submitter, {
      project_id: MAIN,
      change_batch_id: "change-坏基线",
      change_id: CHG,
      actor_id: "gpt-6",
      role: "coordinator",
      goal: "坏基线",
      authorized_scope: "夹具",
      target_baseline: { baseline_id: null, design_revision: "不是哈希", plan_revision: targetBaseline.plan_revision },
      affected_subsystems: ["扫描"],
      exit_criteria: "夹具",
    }),
  );
  ok(
    badBaseline?.code === "INVALID_COMMAND" && String(badBaseline?.detail?.field).includes("design_revision"),
    `④-1 目标基线不是基线里的内容哈希 → 拒（code=${badBaseline?.code ?? "没有报错"}，field=${String(badBaseline?.detail?.field)}）`,
  );
  const extraBaseline = workErrorOf(() =>
    openChange(submitter, {
      project_id: MAIN,
      change_batch_id: "change-多键基线",
      change_id: CHG,
      actor_id: "gpt-6",
      role: "coordinator",
      goal: "多键基线",
      authorized_scope: "夹具",
      target_baseline: { ...targetBaseline, design_text: "把设计原文也塞进来" } as never,
      affected_subsystems: ["扫描"],
      exit_criteria: "夹具",
    }),
  );
  ok(
    extraBaseline?.code === "INVALID_COMMAND" && String(extraBaseline?.message).includes("design_text"),
    `④-1 目标基线里塞基线正文（design_text）→ 点名拒（§2.6：基线只引用不复制；实际 ${extraBaseline?.code ?? "没有报错"}）`,
  );

  // ② 改字段 / 改状态后的读回
  updateRequirement(submitter, {
    project_id: MAIN,
    requirement_id: REQ_ID,
    change_id: CHG,
    actor_id: "kimi-code",
    role: "coordinator",
    fields: { priority: "P0", exclusions: ["不做断点续扫", "不改扫描算法"] },
  });
  setRequirementStatus(submitter, {
    project_id: MAIN,
    requirement_id: REQ_ID,
    change_id: CHG,
    actor_id: "gpt-6",
    role: "coordinator",
    status: "inferred",
    reason: "用户没直说，是审读时推出来的",
  });
  const reqAfter = readRequirements(MAIN_WORK).requirements[REQ_ID];
  ok(
    reqAfter.priority === "P0" &&
      reqAfter.exclusions.length === 2 &&
      reqAfter.status === "inferred" &&
      reqAfter.status_label === "推断" &&
      reqAfter.requirement_id === REQ_ID,
    `②-3 改字段 + 改状态后读回一致（priority=${reqAfter.priority}、status=${reqAfter.status}、稳定 id 不变=${reqAfter.requirement_id === REQ_ID}）`,
  );
  ok(
    reqAfter.revision === 3 && reqAfter.history.length === 3,
    `②-3 版本随事件推进（revision=${reqAfter.revision}）、历史保留每一步（${reqAfter.history.length} 条：${reqAfter.history.map((h) => h.type).join(" → ")}）`,
  );

  // 批次：进迭代 + 关闭，关掉之后不能再改回
  setChangeStatus(submitter, {
    project_id: MAIN,
    change_batch_id: CHG_BATCH,
    change_id: CHG,
    actor_id: "gpt-6",
    role: "coordinator",
    status: "iterating",
    iteration: 2,
    reason: "第 2 轮：补临时文件清理",
  });
  closeChange(submitter, {
    project_id: MAIN,
    change_batch_id: CHG_BATCH,
    change_id: CHG,
    actor_id: "主人",
    role: "user",
    reason: "取消链路验收通过",
  });
  const changeAfter = readChanges(MAIN_WORK).changes[CHG_BATCH];
  ok(
    changeAfter.status === "closed" &&
      changeAfter.status_label === "已关闭" &&
      changeAfter.iteration === 2 &&
      changeAfter.history.length === 3,
    `②-3 批次每轮迭代有独立状态（iteration=${changeAfter.iteration}）、状态推进留历史（${changeAfter.history.length} 条，现态 ${changeAfter.status}）`,
  );
  const reopenErr = workErrorOf(() =>
    setChangeStatus(submitter, {
      project_id: MAIN,
      change_batch_id: CHG_BATCH,
      change_id: CHG,
      actor_id: "gpt-6",
      role: "coordinator",
      status: "iterating",
    }),
  );
  ok(
    reopenErr?.code === "INVALID_COMMAND" &&
      readChanges(MAIN_WORK).changes[CHG_BATCH].status === "closed" &&
      readChanges(MAIN_WORK).changes[CHG_BATCH].revision === 3,
    `②-3 已关闭的批次不能再改回非关闭态，且被拒的命令一个字节都没写（要接着干请开新批次/新迭代；实际 ${reopenErr?.code ?? "没有报错"}）`,
  );

  // ══════════════════════════ ③ 悬空引用拒绝 ══════════════════════════
  info("── ③ 悬空引用：需求 / 变更批次 / 聊天记录三种悬空都拒，且点名缺的那个 id");

  // 正向对照：引用已登记的对象 → 导入通过，且定义上真带上了引用
  const okImport = importPlanChecked(MAIN_PLAN, MAIN_WORK, {
    plan_revision: sha256(MAIN_PLAN),
    change_id: CHG_BATCH,
    requirement_ids: { "T-1": [REQ_ID] },
  });
  ok(
    (okImport.definitions.find((d) => d.task_id === "T-1")?.requirement_ids ?? null)?.join(",") === REQ_ID &&
      okImport.definitions.find((d) => d.task_id === "T-2")?.requirement_ids === null &&
      okImport.definitions.every((d) => d.change_id === CHG_BATCH),
    "③-1 对照：引用已登记的需求/批次 → 导入通过（T-1 挂需求、T-2 没挂仍是 null、批次上下文带上）",
  );
  ok(
    okImport.definitions
      .find((d) => d.task_id === "T-1")!
      .requirement_ids!.every((id) => requirementIdsOf(readRequirements(MAIN_WORK)).includes(id)),
    "③-1 定义上的 requirement_ids 能在投影里解析到（任务侧真引用，不是写了就算）",
  );

  const danglingReq = workErrorOf(() =>
    importPlanChecked(MAIN_PLAN, MAIN_WORK, {
      plan_revision: sha256(MAIN_PLAN),
      requirement_ids: { "T-1": [REQ_ID], "T-2": ["req-不存在"] },
    }),
  );
  const reqIssues = issuesOf(danglingReq);
  ok(
    danglingReq?.code === "INVALID_COMMAND" &&
      reqIssues.some((i) => i.problem === "dangling_requirement" && i.ids.includes("req-不存在")),
    `③-2 任务引用不存在的需求 → INVALID_COMMAND 且点名 id（code=${danglingReq?.code ?? "没有报错"}；${reqIssues.map((i) => `${i.problem}:${i.ids.join("/")}`).join(" ")}）`,
  );
  ok(
    String(danglingReq?.message).includes("req-不存在") &&
      String(danglingReq?.message).includes("T-2") &&
      !String(danglingReq?.message).includes("T-1"),
    "③-2 报错点名缺的 id 与引用它的人（req-不存在 ← T-2；已登记的 req-扫描可取消 不被牵连）",
  );

  const danglingChange = workErrorOf(() =>
    importPlanChecked(MAIN_PLAN, MAIN_WORK, { plan_revision: sha256(MAIN_PLAN), change_id: "change-不存在" }),
  );
  const changeIssues = issuesOf(danglingChange);
  ok(
    danglingChange?.code === "INVALID_COMMAND" &&
      changeIssues.some((i) => i.problem === "dangling_change" && i.ids.includes("change-不存在")) &&
      String(danglingChange?.message).includes("change-不存在"),
    `③-3 任务的 change_id 指不存在的批次 → 拒并点名（code=${danglingChange?.code ?? "没有报错"}；${changeIssues.map((i) => `${i.problem}:${i.ids.join("/")}`).join(" ")}）`,
  );
  ok(
    validateTaskDefinitions(okImport.definitions).every((i) => i.problem !== "dangling_dependency") &&
      validateTaskDefinitions(okImport.definitions).length === 0,
    "③-3 引用校验没有把既有结构校验带偏（同一份定义的结构问题仍是空集）",
  );

  // 采纳聊天变更记录（chat-changes.jsonl 只读引用；不回写、不升格）
  const chatLog = readChatChangeRecords(MAIN_WORK);
  const chatRec = chatLog.records.find((r) => r.chat_record_id === CHAT_CHANGE.change_id);
  const fileBefore = sha256(read(chatChangesFile));
  const adoptDangling = workErrorOf(() =>
    adoptChatChange(submitter, {
      project_id: MAIN,
      change_batch_id: CHG_BATCH,
      change_id: CHG,
      actor_id: "gpt-6",
      role: "coordinator",
      chat_record_id: "chg-不存在",
      chat_record_sha256: sha256("x"),
    }),
  );
  ok(
    adoptDangling?.code === "INVALID_COMMAND" &&
      reasonOf(adoptDangling) === "dangling_chat_change" &&
      String(adoptDangling?.message).includes("chg-不存在"),
    `③-4 采纳不存在的聊天记录 → 拒并点名（reason=${String(reasonOf(adoptDangling))}；实际 ${adoptDangling?.code ?? "没有报错"}）`,
  );
  const adoptMismatch = workErrorOf(() =>
    adoptChatChange(submitter, {
      project_id: MAIN,
      change_batch_id: CHG_BATCH,
      change_id: CHG,
      actor_id: "gpt-6",
      role: "coordinator",
      chat_record_id: CHAT_CHANGE.change_id,
      chat_record_sha256: sha256("另一份内容"),
    }),
  );
  ok(
    reasonOf(adoptMismatch) === "chat_change_hash_mismatch" &&
      adoptMismatch?.detail?.expected_sha256 === chatRec?.sha256,
    `③-4 聊天记录内容对不上 → 拒并给出两边的哈希（reason=${String(reasonOf(adoptMismatch))}）`,
  );
  const adoptRec = adoptChatChange(submitter, {
    project_id: MAIN,
    change_batch_id: CHG_BATCH,
    change_id: CHG,
    actor_id: "gpt-6",
    role: "coordinator",
    chat_record_id: CHAT_CHANGE.change_id,
    chat_record_sha256: chatRec!.sha256,
    note: "这条讨论转成本批次",
  });
  const adopted = readChanges(MAIN_WORK).changes[CHG_BATCH].adopted_chat_changes;
  ok(
    adoptRec.ok === true &&
      adopted.length === 1 &&
      adopted[0].chat_record_id === CHAT_CHANGE.change_id &&
      adopted[0].chat_record_sha256 === chatRec!.sha256 &&
      adopted[0].note === "这条讨论转成本批次",
    `③-4 显式采纳成功：批次上只多一条引用（${adopted[0]?.chat_record_id}，sha ${short(adopted[0]?.chat_record_sha256)}）`,
  );
  ok(
    sha256(read(chatChangesFile)) === fileBefore,
    "③-4 采纳没有回写 chat-changes.jsonl（那份文件仍只由 chatActions 写，采纳只往事件流追加引用）",
  );
  ok(
    readChatChangeRecords(MAIN_WORK).records.length === 1 &&
      chatChangeRecordHash(CHAT_CHANGE as unknown as Record<string, unknown>) === chatRec?.sha256,
    "③-4 聊天记录本身没被升格成批次对象（文件里仍是那一条；批次侧只按 id + 哈希引用）",
  );
  const adoptDup = workErrorOf(() =>
    adoptChatChange(submitter, {
      project_id: MAIN,
      change_batch_id: CHG_BATCH,
      change_id: CHG,
      actor_id: "gpt-6",
      role: "coordinator",
      chat_record_id: CHAT_CHANGE.change_id,
      chat_record_sha256: chatRec!.sha256,
    }),
  );
  ok(
    adoptDup?.code === "INVALID_COMMAND" &&
      reasonOf(adoptDup) === "duplicate_chat_change" &&
      readChanges(MAIN_WORK).changes[CHG_BATCH].adopted_chat_changes.length === 1,
    `③-4 同一条聊天记录重复采纳不产生第二次效果，且被拒的命令一个字节都没写（实际 ${adoptDup?.code ?? "没有报错"}）`,
  );
  // 坏现场：聊天记录文件有坏行 / 同一个 id 出现两次——都不在坏记录上建关联（改完立刻还原夹具文件）
  const chatFileText = read(chatChangesFile);
  write(chatChangesFile, `${chatFileText}{这一行不是 JSON\n`);
  const adoptCorrupt = workErrorOf(() =>
    adoptChatChange(submitter, {
      project_id: MAIN,
      change_batch_id: CHG_BATCH,
      change_id: CHG,
      actor_id: "gpt-6",
      role: "coordinator",
      chat_record_id: CHAT_CHANGE.change_id,
      chat_record_sha256: chatRec!.sha256,
      note: "坏行现场",
    }),
  );
  ok(
    adoptCorrupt?.code === "INVALID_COMMAND" && reasonOf(adoptCorrupt) === "chat_change_log_corrupt",
    `③-4 chat-changes.jsonl 有坏行时拒绝采纳（先处理坏行，不在坏记录上建关联；实际 ${adoptCorrupt?.code ?? "没有报错"}）`,
  );
  write(
    chatChangesFile,
    `${chatFileText}${JSON.stringify({ ...CHAT_CHANGE, change_id: "chg-重复", text: "同 id 的第一条" })}\n` +
      `${JSON.stringify({ ...CHAT_CHANGE, change_id: "chg-重复", text: "同 id 的第二条" })}\n`,
  );
  const adoptAmbiguous = workErrorOf(() =>
    adoptChatChange(submitter, {
      project_id: MAIN,
      change_batch_id: CHG_BATCH,
      change_id: CHG,
      actor_id: "gpt-6",
      role: "coordinator",
      chat_record_id: "chg-重复",
      chat_record_sha256: chatChangeRecordHash({ ...CHAT_CHANGE, change_id: "chg-重复", text: "同 id 的第一条" }),
      note: "重复 id 现场",
    }),
  );
  ok(
    adoptAmbiguous?.code === "INVALID_COMMAND" && reasonOf(adoptAmbiguous) === "ambiguous_chat_change",
    `③-4 同一个聊天记录 id 出现两条时拒绝采纳（说不清是哪一条就不建关联；实际 ${adoptAmbiguous?.code ?? "没有报错"}）`,
  );
  write(chatChangesFile, chatFileText);
  ok(
    sha256(read(chatChangesFile)) === fileBefore && readChatChangeRecords(MAIN_WORK).records.length === 1,
    "③-4 坏现场夹具已还原（chat-changes.jsonl 回到本脚本最初写下的那一行）",
  );

  // ══════════════════════════ ⑤ 重放一致 ══════════════════════════
  info("── ⑤ 重放一致：删掉投影、重放事件流，需求/变更投影逐字节一致");
  const before = {
    requirements: readRequirements(MAIN_WORK),
    changes: readChanges(MAIN_WORK),
  };
  const stateFile = path.join(MAIN_WORK, "state.json");
  ok(fs.existsSync(stateFile), `⑤-1 投影文件在场（${path.basename(stateFile)}），下面把它删掉再重建`);
  fs.rmSync(stateFile, { force: true });
  rebuildSnapshot(MAIN_WORK, MAIN);
  const after = {
    requirements: readRequirements(MAIN_WORK),
    changes: readChanges(MAIN_WORK),
  };
  ok(
    JSON.stringify(before.requirements) === JSON.stringify(after.requirements),
    `⑤-1 需求投影重建后逐字节一致（${Object.keys(after.requirements.requirements).length} 条需求）`,
  );
  ok(
    JSON.stringify(before.changes) === JSON.stringify(after.changes),
    `⑤-1 变更批次投影重建后逐字节一致（${Object.keys(after.changes.changes).length} 个批次）`,
  );
  const pureFold = {
    requirements: foldRequirements(loadEvents(MAIN_WORK).events),
    changes: foldChanges(loadEvents(MAIN_WORK).events),
  };
  ok(
    JSON.stringify(pureFold.requirements) === JSON.stringify(after.requirements) &&
      JSON.stringify(pureFold.changes) === JSON.stringify(after.changes),
    "⑤-1 从事件流纯折叠与读盘结果一致（投影是纯派生，删了可以整份重放）",
  );
  ok(
    readTaskStates(MAIN_WORK).ignored_entities.includes(`requirement:${REQ_ID}`) &&
      readTaskStates(MAIN_WORK).ignored_entities.includes(`change:${CHG_BATCH}`),
    "⑤-1 新对象没有串进任务投影（任务投影如实把它们列为 ignored_entities，不是一个实体两套事实）",
  );

  // ══════════════════════════ ⑦ §2.6 单源分工 ══════════════════════════
  info("── ⑦ §2.6 单源分工：需求对象只有来源引用，没有意图正文的拷贝（读写两侧都 fail-closed）");
  const bodyKeys = ["intent_text", "text", "body", "raw_text", "original_text", "intent"];
  ok(
    Object.keys(reqState).every((k) => !bodyKeys.includes(k)) &&
      Object.keys(reqState.source).sort().join(",") === "kind,ref",
    `⑦-1 需求对象的键里没有放正文的位置（source 只有 kind/ref：${Object.keys(reqState.source).join("/")}）`,
  );
  const eventsText = read(path.join(MAIN_WORK, "events.jsonl"));
  ok(
    fs.existsSync(intentFile) && eventsText.includes("intent.json#r-1") && !eventsText.includes(INTENT_BODY),
    "⑦-1 意图正文文件在场，但事件流里只有 `intent.json#r-1` 这个位置引用、没有正文一个字（正文的唯一写入源仍是那份文件）",
  );
  const foldBodyKey = workErrorOf(() =>
    foldRequirements([
      mkEvent(1, "requirement:req-夹带", "requirement.registered", {
        source: { kind: "intent", ref: "intent.json#r-2" },
        problem: "夹带正文",
        users: [],
        success_scenarios: [],
        exclusions: [],
        priority: "P2",
        status: "explicit",
        intent_text: INTENT_BODY,
      }) as never,
    ]),
  );
  ok(
    foldBodyKey?.code === "EVENT_INVALID" &&
      String(foldBodyKey?.message).includes("intent_text") &&
      String(foldBodyKey?.message).includes("§2.6"),
    `⑦-2 事件里夹带 intent_text → 读侧点名拒（code=${foldBodyKey?.code ?? "没有报错"}）`,
  );
  const foldSourceExtra = workErrorOf(() =>
    foldRequirements([
      mkEvent(1, "requirement:req-夹带2", "requirement.registered", {
        source: { kind: "intent", ref: "intent.json#r-2", text: INTENT_BODY },
        problem: "来源里夹带正文",
        users: [],
        success_scenarios: [],
        exclusions: [],
        priority: "P2",
        status: "explicit",
      }) as never,
    ]),
  );
  ok(
    foldSourceExtra?.code === "EVENT_INVALID" && String(foldSourceExtra?.message).includes("text"),
    `⑦-2 来源引用里夹带 text → 读侧点名拒（code=${foldSourceExtra?.code ?? "没有报错"}）`,
  );
  const writeBodyKey = workErrorOf(() =>
    updateRequirement(submitter, {
      project_id: MAIN,
      requirement_id: REQ_ID,
      change_id: CHG,
      actor_id: "kimi-code",
      role: "coordinator",
      fields: { problem: "扫描中途无法取消", intent_text: INTENT_BODY },
    }),
  );
  ok(
    writeBodyKey?.code === "INVALID_COMMAND" && String(writeBodyKey?.message).includes("intent_text"),
    `⑦-3 写侧更新时夹带正文键 → 拒（一处也不许有；code=${writeBodyKey?.code ?? "没有报错"}）`,
  );
  const unknownReqType = workErrorOf(() =>
    foldRequirements([mkEvent(1, "requirement:req-怪", "requirement.invented", {}) as never]),
  );
  ok(
    unknownReqType?.code === "EVENT_INVALID",
    `⑦-3 未知的 requirement.* 事件类型点名报错（不静默跳过；实际 ${unknownReqType?.code ?? "没有报错"}）`,
  );
  const chatBodyLeak = workErrorOf(() =>
    foldChanges([
      mkEvent(1, "change:change-夹带", "change.opened", {
        goal: "夹带聊天正文",
        authorized_scope: "夹具",
        target_baseline: targetBaseline,
        affected_subsystems: [],
        exit_criteria: "夹具",
        chat_text: CHAT_TEXT,
      }) as never,
    ]),
  );
  ok(
    chatBodyLeak?.code === "EVENT_INVALID" && String(chatBodyLeak?.message).includes("chat_text"),
    `⑦-3 批次里夹带聊天正文 → 读侧点名拒（code=${chatBodyLeak?.code ?? "没有报错"}）`,
  );
  ok(
    !JSON.stringify(readChanges(MAIN_WORK).changes[CHG_BATCH]).includes(CHAT_TEXT),
    "⑦-3 采纳聊天记录后，批次投影里只有 id + 哈希 + 备注，没有聊天正文（引用不是拷贝）",
  );
  ok(
    REQUIREMENT_SOURCE_KINDS.includes("intent") &&
      REQUIREMENT_SOURCE_KINDS.includes("chat") &&
      REQUIREMENT_PAYLOAD_KEYS.includes("source") &&
      reqState.source.ref === "intent.json#r-1" &&
      !JSON.stringify(reqState.source).includes(INTENT_BODY),
    `⑦-3 来源种类是显式词表（${REQUIREMENT_SOURCE_KINDS.join("/")}），source 是 kind + ref 的位置引用、不是正文（${reqState.source.kind}:${reqState.source.ref}）`,
  );

  // ── ⑦-4 入参级闭键：7 个公共写命令各在**入参**里塞一个多余键（正文走私面），必须写侧拒 ──
  info("── ⑦-4 入参级闭键：7 个公共写命令各塞一个多余键，都要 INVALID_COMMAND 且点到 §2.6 单源分工");
  // 判据：code=INVALID_COMMAND 且消息引用 §2.6（被挑键静默丢弃过；现在必须挡在入参层，不能是读侧/payload 层的巧合）
  const extraKeyErr = (fn: () => unknown): WorkError | null => workErrorOf(fn);
  const extraKeyRejected = (e: WorkError | null): boolean =>
    e?.code === "INVALID_COMMAND" && String(e?.message).includes("§2.6");
  const envelope = { project_id: MAIN, change_id: CHG, actor_id: "kimi-code", role: "coordinator" };

  const kRegister = extraKeyErr(() =>
    registerRequirement(submitter, {
      ...envelope,
      requirement_id: "req-入参多余键",
      source: { kind: "intent", ref: "intent.json#r-1" },
      problem: "入参多余键",
      users: [],
      success_scenarios: [],
      exclusions: [],
      priority: "P2",
      status: "explicit",
      intent_text: INTENT_BODY,
    } as never),
  );
  ok(
    extraKeyRejected(kRegister),
    `⑦-4 registerRequirement 入参多 intent_text → 拒并点 §2.6（不能静默丢弃还回成功回执；实际 ${kRegister?.code ?? "没有报错"}）`,
  );

  const kUpdate = extraKeyErr(() =>
    updateRequirement(submitter, {
      ...envelope,
      requirement_id: REQ_ID,
      fields: { priority: "P0" },
      intent_text: INTENT_BODY,
    } as never),
  );
  ok(
    extraKeyRejected(kUpdate),
    `⑦-4 updateRequirement 入参多 intent_text → 拒并点 §2.6（实际 ${kUpdate?.code ?? "没有报错"}）`,
  );

  const kSetStatus = extraKeyErr(() =>
    setRequirementStatus(submitter, {
      ...envelope,
      requirement_id: REQ_ID,
      status: "explicit",
      intent_text: INTENT_BODY,
    } as never),
  );
  ok(
    extraKeyRejected(kSetStatus),
    `⑦-4 setRequirementStatus 入参多 intent_text → 拒并点 §2.6（实际 ${kSetStatus?.code ?? "没有报错"}）`,
  );

  const kOpen = extraKeyErr(() =>
    openChange(submitter, {
      project_id: MAIN,
      change_batch_id: "change-入参多余键",
      change_id: CHG,
      actor_id: "gpt-6",
      role: "coordinator",
      goal: "入参多余键",
      authorized_scope: "夹具",
      target_baseline: targetBaseline,
      affected_subsystems: [],
      exit_criteria: "夹具",
      design_text: MAIN_DESIGN,
    } as never),
  );
  ok(
    extraKeyRejected(kOpen),
    `⑦-4 openChange 入参多 design_text（设计正文走私）→ 拒并点 §2.6（实际 ${kOpen?.code ?? "没有报错"}）`,
  );

  const kChangeStatus = extraKeyErr(() =>
    setChangeStatus(submitter, {
      ...envelope,
      change_batch_id: CHG_BATCH,
      status: "iterating",
      goal: "入参多余键",
    } as never),
  );
  ok(
    extraKeyRejected(kChangeStatus),
    `⑦-4 setChangeStatus 入参多 goal → 拒并点 §2.6（实际 ${kChangeStatus?.code ?? "没有报错"}）`,
  );

  const kClose = extraKeyErr(() =>
    closeChange(submitter, {
      ...envelope,
      change_batch_id: CHG_BATCH,
      reason: "入参多余键",
      intent_text: INTENT_BODY,
    } as never),
  );
  ok(
    extraKeyRejected(kClose),
    `⑦-4 closeChange 入参多 intent_text → 拒并点 §2.6（实际 ${kClose?.code ?? "没有报错"}）`,
  );

  const kAdopt = extraKeyErr(() =>
    adoptChatChange(submitter, {
      ...envelope,
      change_batch_id: CHG_BATCH,
      chat_record_id: CHAT_CHANGE.change_id,
      chat_record_sha256: chatRec!.sha256,
      note: "入参多余键",
      intent_text: INTENT_BODY,
    } as never),
  );
  ok(
    extraKeyRejected(kAdopt),
    `⑦-4 adoptChatChange 入参多 intent_text → 拒并点 §2.6（实际 ${kAdopt?.code ?? "没有报错"}）`,
  );

  // ══════════════════════════ ⑥ 旧数据兼容 ══════════════════════════
  info("── ⑥ 旧数据兼容：没有这些字段的旧任务事件/旧式导入照常，且新字段真的进定义哈希");
  const legacySubmit = (entityId: string, type: string, payload: Record<string, unknown>, seq0: number) =>
    service.submit({
      schema_version: 2,
      project_id: LEGACY,
      change_id: CHG,
      entity_id: entityId,
      expected_revision: seq0 === 0 ? null : seq0,
      type,
      actor_id: "kimi-code",
      role: "executor",
      idempotency_key: `${entityId}:${type}:${seq0 + 1}:${CHG}`,
      payload,
    });
  legacySubmit("task:T-1", "task.definition_imported", {
    definition_sha256: sha256("T-1-旧定义"),
    plan_revision: sha256(MAIN_PLAN),
    definition_revision: 1,
  }, 0);
  legacySubmit("task:T-1", "task.status_changed", { status: "ready" }, 1);
  const legacyStates = readTaskStates(LEGACY_WORK);
  ok(
    legacyStates.states["T-1"]?.status === "ready" &&
      legacyStates.states["T-1"]?.definition_sha256 === sha256("T-1-旧定义"),
    `⑥-1 没有需求/批次字段的旧任务事件照常投影（status=${legacyStates.states["T-1"]?.status}）`,
  );
  ok(
    Object.keys(readRequirements(LEGACY_WORK).requirements).length === 0 &&
      Object.keys(readChanges(LEGACY_WORK).changes).length === 0,
    "⑥-1 旧项目的 work 目录里没有这些事件 → 投影是空集，不抛错、不凭空造对象",
  );
  const legacyRefs = collectRegisteredReferences(LEGACY_WORK);
  ok(
    legacyRefs.requirement_ids.length === 0 && legacyRefs.change_ids.length === 0,
    "⑥-1 旧项目的可引用对象集为空（引用校验对旧现场无事可做，不是拒）",
  );
  const legacyImport = importPlanChecked(MAIN_PLAN, LEGACY_WORK, { plan_revision: sha256(MAIN_PLAN) });
  ok(
    legacyImport.definitions.length === 2 &&
      legacyImport.definitions.every((d) => d.requirement_ids === null && d.change_id === null),
    "⑥-2 旧式导入（不给关联）行为零改动：每张卡的 requirement_ids/change_id 仍是 null",
  );
  ok(
    validateTaskDefinitions(legacyImport.definitions).length === 0,
    "⑥-2 旧式导入的结构校验结论不变（新增的跨对象校验对 null 路径一条都不查）",
  );
  const withReq = importPlanChecked(MAIN_PLAN, MAIN_WORK, {
    plan_revision: sha256(MAIN_PLAN),
    change_id: CHG_BATCH,
    requirement_ids: { "T-1": [REQ_ID] },
  }).definitions;
  const legacyDef = legacyImport.definitions.find((d) => d.task_id === "T-1")!;
  const withReqDef = withReq.find((d) => d.task_id === "T-1")!;
  ok(
    taskDefinitionHash(legacyDef) !== taskDefinitionHash(withReqDef) &&
      legacyDef.stable_key === withReqDef.stable_key &&
      legacyDef.task_id === withReqDef.task_id,
    `⑥-2 requirement_ids 真进定义哈希（同一张卡挂上需求后哈希变了：${short(taskDefinitionHash(legacyDef))} → ${short(taskDefinitionHash(withReqDef))}），不是被忽略的摆设`,
  );
  const sameAgain = importPlanChecked(MAIN_PLAN, MAIN_WORK, {
    plan_revision: sha256(MAIN_PLAN),
    change_id: CHG_BATCH,
    requirement_ids: { "T-1": [REQ_ID] },
  }).definitions;
  ok(
    taskDefinitionHash(sameAgain.find((d) => d.task_id === "T-1")!) === taskDefinitionHash(withReqDef),
    "⑥-2 同一份定义在任何一次导入里算出同一个哈希（挂同样的引用不会漂）",
  );
  const idStability = importPlanChecked(MAIN_PLAN, MAIN_WORK, {
    plan_revision: sha256(MAIN_PLAN),
    requirement_ids: { "T-1": [REQ_ID] },
  }).definitions.find((d) => d.task_id === "T-1")!;
  ok(
    idStability.task_id === "T-1" &&
      (idStability.requirement_ids ?? []).every((id) => id.startsWith("req-")) &&
      requirementIdsOf(readRequirements(MAIN_WORK)).includes(REQ_ID) &&
      changeIdsOf(readChanges(MAIN_WORK)).includes(CHG_BATCH),
    `⑥-2 任务侧引用的是需求稳定 id（req- 前缀），可引用对象集按 id 升序报出（需求 ${requirementIdsOf(readRequirements(MAIN_WORK)).join("/")}；批次 ${changeIdsOf(readChanges(MAIN_WORK)).join("/")}）`,
  );

  // 旧数据不经新校验的旁证：把旧定义原样喂给纯函数校验，不因新增 problem 取值而改判
  const legacyOnly = validateTaskDefinitions(legacyImport.definitions as TaskDefinition[]);
  ok(
    legacyOnly.length === 0 &&
      !legacyOnly.some((i) => i.problem === "dangling_requirement" || i.problem === "dangling_change"),
    "⑥-2 新增的两个 problem 取值不会从纯结构校验里冒出来（悬空引用只在引用校验里报）",
  );

  // ══════════════════════════ ⑧ C-015 接线：校验在真实入口上、对象命令有生产调用面 ══════════
  // 批3终审 C-015 修复（探针 contracts/c015-write-path-bypass.probe.ts / adversarial/probe3-import-references.ts）：
  //   · C015-4：requirement.status_changed 读侧补闭键（此前多余键静默容忍，正文能混进事件流）；
  //   · C015-5：submitDefinitionImports（定义导入真实写口）提交前查引用，悬空拒、零写入；
  //   · C015-6：七个对象命令与受检导入接上真实生产入口（MCP 工具面 manage_requirement /
  //     manage_change / import_plan_definitions + 服务读侧 GET /plan 走 importPlanChecked）；
  //   · 旧数据路径零改动：定义全不带引用时新校验一条都不查，既有调用方行为逐字节一致。
  info("── ⑧ C-015 接线：status_changed 读侧闭键 / 提交写口引用校验 / 对象命令真实入口");

  // ⑧-1 status_changed 读侧闭键：多余键（intent_text）在读侧一样点名拒（此前静默容忍）
  // （手工事件要过结构性重放：同实体的第二条 entity_revision=2）
  const statusSmuggle = workErrorOf(() =>
    foldRequirements([
      mkEvent(1, `requirement:${REQ_ID}`, "requirement.registered", {
        source: { kind: "intent", ref: "intent.json#r-1" },
        problem: "夹具",
        users: [],
        success_scenarios: [],
        exclusions: [],
        priority: "P2",
        status: "explicit",
      }) as never,
      { ...mkEvent(2, `requirement:${REQ_ID}`, "requirement.status_changed", {
        status: "inferred",
        intent_text: INTENT_BODY,
      }), entity_revision: 2 } as never,
    ]),
  );
  ok(
    statusSmuggle?.code === "EVENT_INVALID" &&
      String(statusSmuggle?.message).includes("intent_text") &&
      String(statusSmuggle?.message).includes("§2.6"),
    `⑧-1 status_changed 夹带 intent_text → 读侧点名拒（写读同一闭键口径；code=${statusSmuggle?.code ?? "没有报错"}）`,
  );
  const statusClean = workErrorOf(() =>
    foldRequirements([
      mkEvent(1, `requirement:${REQ_ID}`, "requirement.registered", {
        source: { kind: "intent", ref: "intent.json#r-1" },
        problem: "夹具",
        users: [],
        success_scenarios: [],
        exclusions: [],
        priority: "P2",
        status: "explicit",
      }) as never,
      { ...mkEvent(2, `requirement:${REQ_ID}`, "requirement.status_changed", { status: "inferred", reason: "审读推出" }), entity_revision: 2 } as never,
    ]),
  );
  ok(
    statusClean === null,
    "⑧-1 正对照：写侧真实会写的键（status/reason）照常折叠（闭键只挡多余键，不误伤合法事件）",
  );

  // ⑧-2 submitDefinitionImports：引用校验挂在真实写口上（悬空拒、零写入；无读侧 fail-closed；旧路径零改动）
  const defsWithGhostReq = importTaskDefinitions(MAIN_PLAN, {
    plan_revision: sha256(MAIN_PLAN),
    requirement_ids: { "T-2": ["req-不存在"] },
  }).definitions;
  const defsWithGhostChange = importTaskDefinitions(MAIN_PLAN, {
    plan_revision: sha256(MAIN_PLAN),
    change_id: "change-不存在",
  }).definitions;
  const defsWithValidRefs = importTaskDefinitions(MAIN_PLAN, {
    plan_revision: sha256(MAIN_PLAN),
    requirement_ids: { "T-1": [REQ_ID] },
  }).definitions;

  const seqBeforeSubmitChecks = loadEvents(LEGACY_WORK).events.length;
  // a) 带引用但提交者没给投影读侧 → fail-closed 拒（不能凭调用方自报清单放行）
  const noReader = workErrorOf(() =>
    submitDefinitionImports({ submit: (c: unknown) => service.submit(c) }, {
      project_id: LEGACY,
      change_id: CHG,
      actor_id: "kimi-code",
      role: "coordinator",
      definitions: defsWithGhostReq,
    }),
  );
  ok(
    noReader?.code === "INVALID_COMMAND" && reasonOf(noReader) === "missing_reference_reader",
    `⑧-2 带引用的定义 + 提交者无投影读侧 → INVALID_COMMAND（fail-closed；reason=${String(reasonOf(noReader))}）`,
  );
  // b) 有读侧 + 悬空需求 → 点名 id 拒
  const submitGhostReq = workErrorOf(() =>
    submitDefinitionImports(legacySubmitter, {
      project_id: LEGACY,
      change_id: CHG,
      actor_id: "kimi-code",
      role: "coordinator",
      definitions: defsWithGhostReq,
    }),
  );
  const submitGhostIssues = issuesOf(submitGhostReq);
  ok(
    submitGhostReq?.code === "INVALID_COMMAND" &&
      submitGhostIssues.some((i) => i.problem === "dangling_requirement" && i.ids.includes("req-不存在")),
    `⑧-2 写口提交带悬空需求的定义 → INVALID_COMMAND 点名 id（与 importPlanChecked 同一套判据；code=${submitGhostReq?.code ?? "没有报错"}）`,
  );
  // c) 有读侧 + 悬空批次 → 拒
  const submitGhostChange = workErrorOf(() =>
    submitDefinitionImports(legacySubmitter, {
      project_id: LEGACY,
      change_id: CHG,
      actor_id: "kimi-code",
      role: "coordinator",
      definitions: defsWithGhostChange,
    }),
  );
  ok(
    submitGhostChange?.code === "INVALID_COMMAND" &&
      issuesOf(submitGhostChange).some((i) => i.problem === "dangling_change" && i.ids.includes("change-不存在")),
    `⑧-2 写口提交带悬空批次的定义 → INVALID_COMMAND 点名 id（code=${submitGhostChange?.code ?? "没有报错"}）`,
  );
  // d) 三次被拒都**一个事件都没写**（校验在动磁盘之前抛）
  ok(
    loadEvents(LEGACY_WORK).events.length === seqBeforeSubmitChecks,
    `⑧-2 被拒的三次提交零写入（LEGACY 事件数仍是 ${seqBeforeSubmitChecks}，seq 没有前进）`,
  );
  // e) 旧数据路径：定义全不带引用 + 裸提交者（无读侧）→ 照收（既有调用方——verify-budget 等——行为零改动）。
  //    LEGACY 的 task:T-1 已在 ⑥ 有两条事件（当前版本 2），重导必须给当前版本；T-2 还没有事件（期望新建）
  const legacyDefsNullRefs = importTaskDefinitions(MAIN_PLAN, { plan_revision: sha256(MAIN_PLAN) }).definitions;
  const legacyWriteReceipts = submitDefinitionImports(
    { submit: (c: unknown) => service.submit(c) },
    {
      project_id: LEGACY,
      change_id: CHG,
      actor_id: "kimi-code",
      role: "coordinator",
      definitions: legacyDefsNullRefs,
      expected_revisions: { "T-1": 2, "T-2": null },
    },
  );
  ok(
    legacyWriteReceipts.length === 2 && legacyWriteReceipts.every((r) => r.ok),
    `⑧-2 旧路径兼容：全 null 引用 + 无读侧的裸提交者照收（${legacyWriteReceipts.length} 张卡落事件，新校验一条都没查）`,
  );
  // f) 正对照：有效引用 + 读侧在场 → 写口照收（读侧查的是已登记投影，MAIN 里 REQ_ID 已注册）
  const mainSeqBeforeValid = loadEvents(MAIN_WORK).events.length;
  const validWriteReceipts = submitDefinitionImports(submitter, {
    project_id: MAIN,
    change_id: CHG,
    actor_id: "kimi-code",
    role: "coordinator",
    definitions: defsWithValidRefs,
  });
  ok(
    validWriteReceipts.length === 2 &&
      validWriteReceipts.every((r) => r.ok) &&
      loadEvents(MAIN_WORK).events.length === mainSeqBeforeValid + 2 &&
      readTaskStates(MAIN_WORK).states["T-1"]?.definition_sha256 === taskDefinitionHash(defsWithValidRefs.find((d) => d.task_id === "T-1")!),
    `⑧-2 正对照：引用已登记需求 → 写口提交成功、T-1 状态真绑在这份带引用的定义上（${validWriteReceipts.length} 条回执）`,
  );

  // ⑧-3 alignPlanWithWork（正式读侧路径）走受检导入：旧图纸照常；投影毒化（需求实体坏事件）时不再静默照常
  const aligned = alignPlanWithWork(MAIN_PLAN, MAIN_WORK, sha256(MAIN_PLAN));
  ok(
    aligned.definitions.length === 2 && aligned.definitions.every((d) => d.requirement_ids === null),
    "⑧-3 alignPlanWithWork 对不带引用的旧图纸行为不变（定义照常返回，引用列全 null）",
  );

  // ⑧-4 生产读入口 GET /plan 与 index.ts 全文件不再出现裸导入（源级防漂移锚点，与 remote-routes 的 anchors 同款思路）
  const indexSrc = read(path.join(REPO, "src", "server", "index.ts"));
  ok(
    indexSrc.includes('importPlanChecked(loaded.text, projectWorkDir(id, DATA_DIR)') && !indexSrc.includes("importTaskDefinitions"),
    "⑧-4 GET /api/projects/:id/plan 走 importPlanChecked，index.ts 不再直接裸导入（生产读入口与提交路径同一份引用判据）",
  );

  // ⑧-5 MCP 工具面真实入口（C015-6：对象命令/受检导入经 MCP 可创建、可读回）
  const toolNames = TOOLS.map((t) => t.name);
  ok(
    toolNames.includes("manage_requirement") && toolNames.includes("manage_change") && toolNames.includes("import_plan_definitions"),
    `⑧-5 MCP 注册表挂上三个 C-015 入口（manage_requirement/manage_change/import_plan_definitions；全表 ${toolNames.length} 个工具）`,
  );
  ok(
    manageRequirementTool.inputSchema.additionalProperties === false &&
      manageChangeTool.inputSchema.additionalProperties === false &&
      importPlanDefinitionsTool.inputSchema.additionalProperties === false,
    "⑧-5 三个工具的 inputSchema 都 additionalProperties:false（客户端侧先挡一层多余键）",
  );

  // 入口级真链路：MCP 工具 handler → 对象命令校验 → 转接（进程内真 WorkService 顶替回环 HTTP 一跳）→ 事件落盘 → 读回
  const relay = { submit: (c: unknown) => Promise.resolve(service.submit(c)) } as unknown as WorkServiceClient;
  const mcpCtx = { work: relay, clientName: "t21-mcp-verify" };
  const toolTextOf = (r: { content: { type: string; text?: string }[]; isError?: boolean }) =>
    r.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
  const toolJson = (r: { content: { type: string; text?: string }[]; isError?: boolean }): Record<string, unknown> =>
    JSON.parse(toolTextOf(r)) as Record<string, unknown>;

  // a) manage_requirement register → 真实回执 + 读回一致
  const REQ_TOOL = "req-工具入口";
  const rRegister = await manageRequirementTool.handler(
    {
      op: "register",
      project_id: MAIN,
      role: "coordinator",
      requirement_id: REQ_TOOL,
      source: { kind: "user", ref: "入口级验证" },
      problem: "工具入口注册",
      users: ["入口级"],
      success_scenarios: ["注册后读回"],
      exclusions: [],
      priority: "P2",
      status: "explicit",
    },
    mcpCtx,
  );
  const pRegister = toolJson(rRegister);
  const registerReceipt = (pRegister.receipts as { event_id: string; seq: number }[] | undefined)?.[0];
  ok(
    rRegister.isError !== true &&
      pRegister.ok === true &&
      typeof registerReceipt?.event_id === "string" &&
      !registerReceipt.event_id.includes("planned") &&
      registerReceipt.seq > 0 &&
      (pRegister.requirement as { requirement_id?: string } | null)?.requirement_id === REQ_TOOL,
    `⑧-5 manage_requirement(register) 真链路：真实回执（event_id=${short(registerReceipt?.event_id)}，seq=${registerReceipt?.seq}）+ 读回状态一致（占位回执不外泄）`,
  );
  const rRead = await manageRequirementTool.handler({ op: "read", project_id: MAIN, requirement_id: REQ_TOOL }, mcpCtx);
  const pRead = toolJson(rRead);
  ok(
    rRead.isError !== true &&
      (pRead.requirement as { problem?: string } | null)?.problem === "工具入口注册",
    "⑧-5 manage_requirement(read) 读回刚注册的需求（创建/读回路径真实可用）",
  );

  // b) 工具入参闭键：塞 intent_text 在工具边界就拒（不进对象命令、零写入）
  const seqBeforeToolReject = loadEvents(MAIN_WORK).events.length;
  const rSmuggle = await manageRequirementTool.handler(
    {
      op: "register",
      project_id: MAIN,
      role: "coordinator",
      requirement_id: "req-工具走私",
      source: { kind: "user", ref: "x" },
      problem: "走私",
      users: [],
      success_scenarios: [],
      exclusions: [],
      priority: "P2",
      status: "explicit",
      intent_text: INTENT_BODY,
    },
    mcpCtx,
  );
  ok(
    rSmuggle.isError === true &&
      toolTextOf(rSmuggle).includes("INVALID_COMMAND") &&
      toolTextOf(rSmuggle).includes("intent_text") &&
      loadEvents(MAIN_WORK).events.length === seqBeforeToolReject,
    "⑧-5 工具入参夹带 intent_text → 工具边界点名拒、一个事件都没写（fail-closed 不止在库层）",
  );

  // c) 字段级非法（缺 problem）→ 对象命令层拒（工具不另造判据，原样透传权威校验的结论）
  const rBadFields = await manageRequirementTool.handler(
    {
      op: "register",
      project_id: MAIN,
      role: "coordinator",
      requirement_id: "req-工具缺字段",
      source: { kind: "user", ref: "x" },
      users: [],
      success_scenarios: [],
      exclusions: [],
      priority: "P2",
      status: "explicit",
    },
    mcpCtx,
  );
  ok(
    rBadFields.isError === true &&
      toolTextOf(rBadFields).includes("INVALID_COMMAND") &&
      toolTextOf(rBadFields).includes("problem") &&
      loadEvents(MAIN_WORK).events.length === seqBeforeToolReject,
    "⑧-5 缺 §2.5 字段（problem）→ 对象命令层点名拒（工具只是透传，不重造第二套校验）",
  );

  // d) manage_change open + adopt 真链路（新批次采纳夹具聊天记录）
  const CHG_TOOL = "change-工具入口";
  const rOpen = await manageChangeTool.handler(
    {
      op: "open",
      project_id: MAIN,
      role: "coordinator",
      change_batch_id: CHG_TOOL,
      goal: "工具入口批次",
      authorized_scope: "仅入口级验证",
      target_baseline: targetBaseline,
      affected_subsystems: ["扫描"],
      exit_criteria: "读回一致",
    },
    mcpCtx,
  );
  const pOpen = toolJson(rOpen);
  ok(
    rOpen.isError !== true &&
      pOpen.ok === true &&
      (pOpen.change as { change_id?: string; target_baseline?: { plan_revision?: string } } | null)?.change_id === CHG_TOOL &&
      (pOpen.change as { target_baseline?: { plan_revision?: string } } | null)?.target_baseline?.plan_revision === targetBaseline.plan_revision,
    "⑧-5 manage_change(open) 真链路：批次落事件、读回的目标基线与既有基线哈希逐字一致",
  );
  const rAdopt = await manageChangeTool.handler(
    {
      op: "adopt_chat_change",
      project_id: MAIN,
      role: "coordinator",
      change_batch_id: CHG_TOOL,
      chat_record_id: CHAT_CHANGE.change_id,
      chat_record_sha256: chatRec!.sha256,
      note: "工具入口采纳",
    },
    mcpCtx,
  );
  const pAdopt = toolJson(rAdopt);
  ok(
    rAdopt.isError !== true &&
      ((pAdopt.change as { adopted_chat_changes?: { chat_record_id: string }[] } | null)?.adopted_chat_changes ?? []).some(
        (a) => a.chat_record_id === CHAT_CHANGE.change_id,
      ) &&
      sha256(read(chatChangesFile)) === fileBefore,
    "⑧-5 manage_change(adopt_chat_change) 真链路：采纳引用落事件、chat-changes.jsonl 一个字节没被回写",
  );
  // 悬空采纳经工具一样拒（对象命令判据原样到达 MCP 调用方）
  const rAdoptGhost = await manageChangeTool.handler(
    {
      op: "adopt_chat_change",
      project_id: MAIN,
      role: "coordinator",
      change_batch_id: CHG_TOOL,
      chat_record_id: "chg-不存在",
      chat_record_sha256: sha256("x"),
    },
    mcpCtx,
  );
  ok(
    rAdoptGhost.isError === true && toolTextOf(rAdoptGhost).includes("chg-不存在"),
    "⑧-5 悬空聊天记录经 MCP 工具采纳 → 拒并点名（dangling 判据不在工具里重造，原样来自对象命令层）",
  );

  // e) import_plan_definitions 真链路：挂已登记需求 → 提交成功、读回状态绑定
  //    （MAIN 的 task:T-1/T-2 已在 ⑧-2-f 导入到版本 1，这次显式给当前版本重导）
  const rImport = await importPlanDefinitionsTool.handler(
    {
      project_id: MAIN,
      role: "coordinator",
      change_id: CHG,
      requirement_ids: { "T-2": [REQ_TOOL] },
      expected_revisions: { "T-1": 1, "T-2": 1 },
    },
    mcpCtx,
  );
  const pImport = toolJson(rImport);
  const importRows = (pImport.imported as { task_id: string; receipt: { seq: number } | null }[] | undefined) ?? [];
  ok(
    rImport.isError !== true &&
      pImport.ok === true &&
      importRows.length === 2 &&
      importRows.every((r) => (r.receipt?.seq ?? 0) > 0) &&
      (pImport.states as Record<string, { definition_sha256: string | null }> | undefined)?.["T-2"]?.definition_sha256 !== null,
    `⑧-5 import_plan_definitions 挂已登记需求（T-2←${REQ_TOOL}）→ 真实提交 ${importRows.length} 张卡并读回定义绑定`,
  );
  // 悬空需求经工具导入 → 拒、零写入
  const seqBeforeToolImport = loadEvents(MAIN_WORK).events.length;
  const rImportGhost = await importPlanDefinitionsTool.handler(
    { project_id: MAIN, role: "coordinator", change_id: CHG, requirement_ids: { "T-2": ["req-不存在"] } },
    mcpCtx,
  );
  ok(
    rImportGhost.isError === true &&
      toolTextOf(rImportGhost).includes("INVALID_COMMAND") &&
      toolTextOf(rImportGhost).includes("req-不存在") &&
      loadEvents(MAIN_WORK).events.length === seqBeforeToolImport,
    "⑧-5 import_plan_definitions 挂悬空需求 → INVALID_COMMAND 点名 id、零写入（受检导入是真实入口，不是摆设包装）",
  );
  // 悬空批次绑定经工具导入 → 拒
  const rImportGhostChange = await importPlanDefinitionsTool.handler(
    { project_id: MAIN, role: "coordinator", change_id: CHG, bind_change_id: "change-不存在" },
    mcpCtx,
  );
  ok(
    rImportGhostChange.isError === true &&
      toolTextOf(rImportGhostChange).includes("change-不存在") &&
      loadEvents(MAIN_WORK).events.length === seqBeforeToolImport,
    "⑧-5 import_plan_definitions 绑悬空批次（bind_change_id）→ 拒并点名、零写入",
  );
  // 旧路径：不带任何引用 → 照收（定义 revision 前进——上一步工具导入已把 T-1/T-2 推到版本 2）
  const rImportLegacy = await importPlanDefinitionsTool.handler(
    {
      project_id: MAIN,
      role: "coordinator",
      change_id: CHG,
      expected_revisions: { "T-1": 2, "T-2": 2 },
    },
    mcpCtx,
  );
  ok(
    rImportLegacy.isError !== true && toolJson(rImportLegacy).ok === true,
    "⑧-5 import_plan_definitions 不带引用（旧数据路径）→ 照收（新校验一条都不查，旧项目兼容）",
  );

  // f) 写入服务不在场：写操作 SERVICE_UNAVAILABLE、零写入；读操作照常（读只依赖盘上投影）
  const rOffline = await manageRequirementTool.handler(
    {
      op: "set_status",
      project_id: MAIN,
      role: "coordinator",
      requirement_id: REQ_TOOL,
      status: "inferred",
    },
    { clientName: "t21-mcp-offline" },
  );
  ok(
    rOffline.isError === true &&
      toolTextOf(rOffline).includes("SERVICE_UNAVAILABLE") &&
      loadEvents(MAIN_WORK).events.length === seqBeforeToolImport + 2,
    "⑧-5 没有转接客户端（写入服务不在场）→ 写操作 SERVICE_UNAVAILABLE、零写入（MCP 不自己写事件，§2.6）",
  );
  const rOfflineRead = await manageRequirementTool.handler(
    { op: "read", project_id: MAIN, requirement_id: REQ_TOOL },
    { clientName: "t21-mcp-offline" },
  );
  ok(
    rOfflineRead.isError !== true &&
      (toolJson(rOfflineRead).requirement as { requirement_id?: string } | null)?.requirement_id === REQ_TOOL,
    "⑧-5 写入服务不在场时 read 照常（读只读盘上投影，不依赖写入面）",
  );

  // g) 未登记项目经工具 → 拒（路径只走注册表，不猜目录）
  const rUnknownProject = await manageRequirementTool.handler({ op: "read", project_id: "t21-不存在" }, mcpCtx);
  ok(
    rUnknownProject.isError === true && toolTextOf(rUnknownProject).includes("INVALID_COMMAND"),
    "⑧-5 未登记项目 → INVALID_COMMAND（项目路径只走注册表）",
  );
}

main()
  .catch((e) => {
    console.error(`[verify] 异常：${e instanceof Error ? e.stack : String(e)}`);
    process.exitCode = 1;
    ok(false, `验证中断：${e instanceof Error ? e.message : String(e)}`);
  })
  .finally(() => {
    info("── 塔台根文档零改动核对（首尾逐文件 sha256）");
    for (const rel of REPO_FILES) {
      const abs = path.join(REPO, rel);
      const after = fs.existsSync(abs) ? sha256File(abs) : "<missing>";
      ok(after === docBefore.get(rel), `文档未被改动：${rel} sha256=${after.slice(0, 16)}…`);
    }

    if (process.env.TATAI_KEEP_TMP === "1") {
      info(`保留现场：${tmpBase}`);
    } else {
      fs.rmSync(tmpBase, { recursive: true, force: true });
      info(`夹具已清理：${path.basename(tmpBase)}`);
    }
    console.log(`\n[verify] T21 结果：${passCount} PASS / ${failCount} FAIL（exit ${process.exitCode ?? 0}）`);
  });
