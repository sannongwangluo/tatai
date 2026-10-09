// C-015 复核（收口第一包 + 复核返修）：唯一写入服务（WorkService.submit）对需求/变更批次实体
// 执行与读侧重放同一份校验、并对直连的 task.definition_imported 执行引用元数据校验的验证脚本。
// 用法：pnpm verify:c015-service（自带临时 TATAI_HOME + 夹具项目，不碰真实注册表与任何真实项目）
//
// 为什么要有这个脚本（两段的 RED→GREEN 合同都完整保存在本文件，不依赖任何一次性探针）：
//   · 对象命令层（registerRequirement/openChange/…）与 MCP 工具面的闭键/必填校验已交付
//     （verify-requirements 96 条守着），但**直连唯一写口**提交 requirement.*/change.* 事件时，
//     服务此前只校验信封（validateWorkCommand 不查 payload 内容），空载荷/缺必填/多余键的
//     登记事件照样落盘——正是 PLAN C-015 契约对齐登记①点名的被否行为
//     （"空载荷、缺必填字段、含多余键的登记事件拒绝"，§2.5 一致校验面：经 WorkService.submit
//     的**直接命令写入**也在唯一写入服务处执行同一套校验，调用方自查不替代服务侧校验）。
//   · 这类事件一旦落盘，读侧重放（foldRequirements/foldChanges）就抛 EVENT_INVALID——
//     该实体的投影被**永久毒化**（事件不可回改），所以必须在写入服务这一点 fail-closed。
//   · 复核返修段（⑬-⑱，PLAN 第94行 C-015②的另一半）：canonical 包装层（submitDefinitionImports）
//     的引用预检可以被"直连唯一写口"绕过——task.definition_imported 的 payload 此前只带
//     definition_sha256/plan_revision/definition_revision，服务边界拿不到引用事实无从核验。
//     RED 实录（2026-09-21 本文件返修首跑）：⑬⑭⑮⑱ FAIL——直连提交悬空 requirement_ids /
//     悬空 definition_change_id / 形态不合法的元数据**全部被接受落盘**，canonical 事件不携带
//     引用元数据。返修后：新产生的事件携带 requirement_ids/definition_change_id（可判形态：
//     任一键在=新形态必查，两键都不在=旧形态不查），服务在追加前从同一 events 现场折投影，
//     用与包装层同一份 validateDefinitionReferences 判据核验，悬空点名 id 拒、原子、零字节。
//
// 覆盖点（每条都先记事件数、再断言拒绝且零写入；正对照证明不误伤合法写入）：
//   ① 空载荷 requirement.registered 拒；② 缺必填字段拒且点名；③ 多余键（intent_text）拒且点名；
//   ④ 未知 requirement.* 类型拒；⑤ 首条非 registered 拒；⑥ 合法注册接受 + 读回一致（正对照）；
//   ⑦ 合法实体上 updated 带多余键拒、事件数不前进；⑧ 重复注册同实体拒；
//   ⑨ change.opened 空载荷拒；⑩ 合法 open→close 接受，关闭后再改状态拒（折叠层同一判据）；
//   ⑪ task:/budget: 实体提交不受影响（钩子只挂需求/变更实体域，不外溢）；
//   ⑫ 对象命令真实路径（registerRequirement/openChange 经同一服务）照常——单源不是两套；
//   ⑬ 直连 task.definition_imported 带悬空 requirement_ids 拒且点名 id、零写入；
//   ⑭ 直连带悬空 definition_change_id 拒；需求+批次双悬空同一次拒绝两个 id 都点名（原子）；
//   ⑮ 引用元数据形态不合法（非数组/杂元素/非串批次）拒且点名字段；
//   ⑯ 旧形态 payload（无引用键）直连照收——历史事件/旧调用方零改动（兼容形态可判）；
//   ⑰ 正对照：新形态直连引用已登记需求/批次接受，payload 真带引用元数据；
//   ⑱ canonical 路径事件真带 requirement_ids/definition_change_id（包装层不丢事实）、
//      信封 change_id 与定义绑定批次两个事实各自如实；批次带悬空引用整体拒、零写入。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { WorkService } from "../src/server/work/service";
import { loadEvents } from "../src/server/work/eventStore";
import { WorkError } from "../src/server/work/types";
import { readRequirements, registerRequirement } from "../src/server/work/requirements";
import { openChange, readChanges } from "../src/server/work/changes";
import { importTaskDefinitions } from "../src/server/work/plan";
import { submitDefinitionImports } from "../src/server/work/tasks";
import { collectRegisteredReferences } from "../src/server/work/references";

const ok = (cond: boolean, label: string) => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (!cond) process.exitCode = 1;
};

// ── 隔离环境：临时 TATAI_HOME + 夹具项目（不碰真实注册表）──
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-c015-service-"));
const dataDir = path.join(tmpBase, "home");
const projRoot = path.join(tmpBase, "proj");
fs.mkdirSync(path.join(projRoot, ".工作台"), { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });
const PROJECT = "c015-service";
fs.writeFileSync(
  path.join(dataDir, "registry.json"),
  JSON.stringify({
    version: 1,
    projects: [
      {
        id: PROJECT,
        name: "C015 服务校验夹具",
        path: projRoot,
        kind: "backend",
        registered_at: "2026-09-21T00:00:00+08:00",
        last_opened_at: "2026-09-21T00:00:00+08:00",
      },
    ],
  }),
);
process.env.TATAI_HOME = dataDir;

const service = new WorkService({ dataDir });
const workDir = path.join(projRoot, ".工作台", "work");
const eventCount = () => loadEvents(workDir).events.length;

const base = {
  schema_version: 2,
  project_id: PROJECT,
  change_id: "change-none",
  actor_id: "c015-service-verify",
  role: "coordinator",
};

const VALID_REGISTERED = {
  source: { kind: "user", ref: "入口级验证" },
  problem: "直连写口要过同一套校验",
  users: [],
  success_scenarios: [],
  exclusions: [],
  priority: "P2",
  status: "explicit",
};

/** 直连提交一次：返回 {accepted, code, message}——被拒不许写一个字节 */
const trySubmit = (
  entityId: string,
  type: string,
  payload: Record<string, unknown>,
  expectedRevision: number | null,
  key: string,
): { accepted: boolean; code: string | null; message: string } => {
  try {
    service.submit({
      ...base,
      entity_id: entityId,
      type,
      payload,
      expected_revision: expectedRevision,
      idempotency_key: key,
    });
    return { accepted: true, code: null, message: "" };
  } catch (e) {
    if (e instanceof WorkError) return { accepted: false, code: e.code, message: e.message };
    throw e;
  }
};

// ① 空载荷 requirement.registered → 拒、零写入
{
  const before = eventCount();
  const r = trySubmit("requirement:req-空", "requirement.registered", {}, null, "k-①空载荷");
  ok(
    !r.accepted && r.code === "INVALID_COMMAND" && eventCount() === before,
    `① 空载荷 requirement.registered → INVALID_COMMAND、零写入（实际 ${r.accepted ? "被接受落盘" : `code=${r.code}`}）`,
  );
}

// ② 缺必填字段 → 拒且点名缺的字段
{
  const before = eventCount();
  const r = trySubmit("requirement:req-缺", "requirement.registered", { problem: "只有问题" }, null, "k-②缺字段");
  ok(
    !r.accepted &&
      r.code === "INVALID_COMMAND" &&
      r.message.includes("source") &&
      r.message.includes("priority") &&
      eventCount() === before,
    `② 缺必填字段的登记 → INVALID_COMMAND 点名缺字段、零写入（实际 ${r.accepted ? "被接受落盘" : r.message.slice(0, 60)}）`,
  );
}

// ③ 多余键（正文走私 intent_text）→ 拒且点名
{
  const before = eventCount();
  const r = trySubmit(
    "requirement:req-多",
    "requirement.registered",
    { ...VALID_REGISTERED, intent_text: "走私正文" },
    null,
    "k-③多余键",
  );
  ok(
    !r.accepted && r.code === "INVALID_COMMAND" && r.message.includes("intent_text") && eventCount() === before,
    `③ 登记夹带 intent_text → INVALID_COMMAND 点名、零写入（实际 ${r.accepted ? "被接受落盘" : `code=${r.code}`}）`,
  );
}

// ④ 未知 requirement.* 类型 → 拒（这类事件落盘即毒化读侧：fold 对未知类型抛 EVENT_INVALID）
{
  const before = eventCount();
  const r = trySubmit("requirement:req-怪", "requirement.invented", {}, null, "k-④未知类型");
  ok(
    !r.accepted && r.code === "INVALID_COMMAND" && eventCount() === before,
    `④ 未知 requirement.* 类型 → INVALID_COMMAND、零写入（实际 ${r.accepted ? "被接受落盘" : `code=${r.code}`}）`,
  );
}

// ⑤ 首条非 registered（status_changed 开新实体）→ 拒
{
  const before = eventCount();
  const r = trySubmit("requirement:req-跳", "requirement.status_changed", { status: "inferred" }, null, "k-⑤首条跳态");
  ok(
    !r.accepted && r.code === "INVALID_COMMAND" && eventCount() === before,
    `⑤ 首条事件不是 registered → INVALID_COMMAND、零写入（实际 ${r.accepted ? "被接受落盘" : `code=${r.code}`}）`,
  );
}

// ⑥ 正对照：合法注册 → 接受，读回字段一致（fail-closed 不误伤合法写入）
const REQ_OK = "req-合法";
{
  const before = eventCount();
  const r = trySubmit(`requirement:${REQ_OK}`, "requirement.registered", VALID_REGISTERED, null, "k-⑥合法注册");
  const readback = readRequirements(workDir).requirements[REQ_OK];
  ok(
    r.accepted &&
      eventCount() === before + 1 &&
      readback?.problem === VALID_REGISTERED.problem &&
      readback?.status === "explicit",
    `⑥ 正对照：合法 requirement.registered 接受 + 读回一致（seq 前进到 ${eventCount()}）`,
  );
}

// ⑦ 合法实体上 updated 带多余键 → 拒、事件数不前进
{
  const before = eventCount();
  const r = trySubmit(
    `requirement:${REQ_OK}`,
    "requirement.updated",
    { fields: { priority: "P1" }, intent_text: "又走私" },
    1,
    "k-⑦更新多余键",
  );
  ok(
    !r.accepted && r.code === "INVALID_COMMAND" && eventCount() === before,
    `⑦ updated 夹带多余键 → INVALID_COMMAND、事件数不前进（实际 ${r.accepted ? "被接受落盘" : `code=${r.code}`}）`,
  );
}

// ⑧ 重复注册同实体（版本给对，绕过版本闸直撞折叠判据）→ 拒
{
  const before = eventCount();
  const r = trySubmit(`requirement:${REQ_OK}`, "requirement.registered", VALID_REGISTERED, 1, "k-⑧重复注册");
  ok(
    !r.accepted && r.code === "INVALID_COMMAND" && eventCount() === before,
    `⑧ 同实体第二次 registered → INVALID_COMMAND、零写入（实际 ${r.accepted ? "被接受落盘" : `code=${r.code}`}）`,
  );
}

// ⑨ change.opened 空载荷 → 拒、零写入
{
  const before = eventCount();
  const r = trySubmit("change:change-空", "change.opened", {}, null, "k-⑨批次空载荷");
  ok(
    !r.accepted && r.code === "INVALID_COMMAND" && eventCount() === before,
    `⑨ 空载荷 change.opened → INVALID_COMMAND、零写入（实际 ${r.accepted ? "被接受落盘" : `code=${r.code}`}）`,
  );
}

// ⑩ 合法 open→close 接受；关闭后再改状态 → 拒（折叠层"已关闭不能改回"同一判据）
const CHG_OK = "change-合法";
{
  const opened = trySubmit(
    `change:${CHG_OK}`,
    "change.opened",
    {
      goal: "服务校验",
      authorized_scope: "仅入口级",
      target_baseline: { design_revision: "a".repeat(64), plan_revision: "b".repeat(64) },
      affected_subsystems: [],
      exit_criteria: "读回一致",
    },
    null,
    "k-⑩合法开启",
  );
  const closed = trySubmit(`change:${CHG_OK}`, "change.closed", { reason: "验收完成" }, 1, "k-⑩合法关闭");
  const before = eventCount();
  const reopen = trySubmit(`change:${CHG_OK}`, "change.status_changed", { status: "iterating" }, 2, "k-⑩关闭后改回");
  ok(
    opened.accepted &&
      closed.accepted &&
      !reopen.accepted &&
      reopen.code === "INVALID_COMMAND" &&
      eventCount() === before &&
      readChanges(workDir).changes[CHG_OK]?.status === "closed",
    `⑩ 合法 open→close 接受；关闭后再改状态 INVALID_COMMAND、零写入（实际 ${reopen.accepted ? "被接受落盘" : `code=${reopen.code}`}）`,
  );
}

// ⑪ task: 实体提交不受影响（钩子只挂需求/变更实体域，不外溢到别的对象域）
{
  // 夹具先导入正式定义，使用真实任务身份；这是夹具的防御性准备，不是非上报状态写的必要条件。
  //   verifyTaskPhaseCommand 只对带 doing/blocked/ready 的 report_phase 核定义与认领；迁移回放另由 v06-03 守护。
  //   这里先经**唯一写口**导入一张最小定义（旧形态 `task.definition_imported`，与 verify-v06-09 夹具
  //   同形、不带 report_phase）建立合法前置，再提交目标状态事件——不硬写账本、不绕过唯一写口，
  //   也不放宽"钩子不外溢"这条判据（缺前置仍拒的负例由下面的服务边界核实守）。
  const imp = trySubmit(
    "task:T-1",
    "task.definition_imported",
    { definition_sha256: "0".repeat(64), plan_revision: "0".repeat(64), definition_revision: 1 },
    null,
    "k-⑪前置定义导入",
  );
  ok(
    imp.accepted,
    `⑪ 前置：正式导入 T-1 定义（task.definition_imported 经唯一写口；${imp.accepted ? "已接受" : `code=${imp.code}`}）`,
  );
  const before = eventCount();
  const r = trySubmit("task:T-1", "task.status_changed", { status: "ready" }, 1, "k-⑪任务域");
  ok(
    r.accepted && eventCount() === before + 1,
    `⑪ task: 实体的事件提交行为不变（钩子不外溢；seq 前进到 ${eventCount()}）`,
  );
}

// ⑪-负例（补实证，判据不放宽）：**真上报**（payload 带 `report_phase`）而缺前置（未导定义 / 无认领）
//   ⇒ 写边界仍拒且零写入。这条对"当前实现"与"修掉 early-return 顺序后的实现"都成立
//   （带 report_phase 就应当受阶段核实约束），所以它锁的是"非法上报仍被拒"，不是某个实现细节。
{
  const before = eventCount();
  const r = trySubmit(
    "task:T-never-imported",
    "task.status_changed",
    { status: "executing", report_phase: "doing", claim_token: "tok-x" },
    null,
    "k-⑪负例真上报缺前置",
  );
  ok(
    !r.accepted && r.code === "INVALID_COMMAND" && eventCount() === before,
    `⑪ 负例：带 report_phase 的真上报缺前置（未导定义/无认领）→ INVALID_COMMAND、零写入（实际 ${
      r.accepted ? "被接受落盘" : `code=${r.code}`
    }）`,
  );
}

// ⑫ 对象命令真实路径（registerRequirement/openChange 经同一服务）照常——校验是同一份，不是两套
{
  const submitter = { submit: (c: unknown) => service.submit(c) };
  const receipt = registerRequirement(submitter, {
    project_id: PROJECT,
    requirement_id: "req-对象命令",
    change_id: "change-none",
    actor_id: "c015-service-verify",
    role: "coordinator",
    source: { kind: "user", ref: "对象命令路径" },
    problem: "对象命令照常",
    users: [],
    success_scenarios: [],
    exclusions: [],
    priority: "P1",
    status: "explicit",
  });
  const readback = readRequirements(workDir).requirements["req-对象命令"];
  ok(
    receipt.ok === true && readback?.problem === "对象命令照常",
    `⑫ 对象命令真实路径照常（回执 ok + 读回一致；事件总数 ${eventCount()}）`,
  );
}

// ── ⑬-⑱ C015 复核返修：直连唯一写口的 task.definition_imported 引用元数据合同 ──
// PLAN 第94行 C015 ②的另一半：不止"经 task.definition_imported 导入"（canonical 包装层，⑧-2 守着），
// "经 WorkService.submit 直接提交"的含悬空 requirement_ids 任务定义也要整体拒绝并点名 ID
// （DESIGN.md §2.5 一致校验面：所有写口在唯一写入服务处同一校验，调用方自查不替代服务侧校验）。
// 合同形态（明确可判的向后兼容）：payload 携带 requirement_ids / definition_change_id 任一键 = 新形态，
// 服务在追加前从同一 events 现场折出投影核验；两键都不在 = 旧形态（历史事件/旧调用方），一条都不查。

// ⑬ 直连新形态 payload、requirement_ids 悬空 → INVALID_COMMAND 点名 id、零写入
{
  const before = eventCount();
  const r = trySubmit(
    "task:D-悬空需求",
    "task.definition_imported",
    {
      definition_sha256: "d".repeat(64),
      plan_revision: "p".repeat(64),
      definition_revision: 1,
      requirement_ids: ["req-不存在"],
      definition_change_id: null,
    },
    null,
    "k-⑬直连悬空需求",
  );
  ok(
    !r.accepted && r.code === "INVALID_COMMAND" && r.message.includes("req-不存在") && eventCount() === before,
    `⑬ 直连 task.definition_imported 带悬空 requirement_ids → INVALID_COMMAND 点名 id、零写入（实际 ${r.accepted ? "被接受落盘（RED：服务边界此前不核验定义事件引用）" : `code=${r.code}`}）`,
  );
}

// ⑭ 直连新形态 payload、definition_change_id 悬空 → INVALID_COMMAND 点名 id、零写入；
//    需求+批次同时悬空 → 同一次拒绝里两个都点名（原子拒绝，不落部分数据）
{
  const before = eventCount();
  const r1 = trySubmit(
    "task:D-悬空批次",
    "task.definition_imported",
    {
      definition_sha256: "d".repeat(64),
      plan_revision: "p".repeat(64),
      definition_revision: 1,
      requirement_ids: null,
      definition_change_id: "change-不存在",
    },
    null,
    "k-⑭直连悬空批次",
  );
  const r2 = trySubmit(
    "task:D-双悬空",
    "task.definition_imported",
    {
      definition_sha256: "d".repeat(64),
      plan_revision: "p".repeat(64),
      definition_revision: 1,
      requirement_ids: ["req-也没有"],
      definition_change_id: "change-也没有",
    },
    null,
    "k-⑭直连双悬空",
  );
  ok(
    !r1.accepted && r1.code === "INVALID_COMMAND" && r1.message.includes("change-不存在"),
    `⑭ 直连带悬空 definition_change_id → INVALID_COMMAND 点名 id（实际 ${r1.accepted ? "被接受落盘（RED）" : `code=${r1.code}`}）`,
  );
  ok(
    !r2.accepted &&
      r2.code === "INVALID_COMMAND" &&
      r2.message.includes("req-也没有") &&
      r2.message.includes("change-也没有") &&
      eventCount() === before,
    `⑭ 需求+批次同payload双悬空 → 同一次 INVALID_COMMAND 两个 id 都点名、零写入（实际 ${r2.accepted ? "被接受落盘（RED）" : `code=${r2.code}`}）`,
  );
}

// ⑮ 新形态但引用元数据形态不合法 → INVALID_COMMAND 点名字段、零写入（形态必须可判，不猜）
{
  const before = eventCount();
  const badShape1 = trySubmit(
    "task:D-形态1",
    "task.definition_imported",
    {
      definition_sha256: "d".repeat(64),
      plan_revision: "p".repeat(64),
      definition_revision: 1,
      requirement_ids: "req-合法",
      definition_change_id: null,
    },
    null,
    "k-⑮形态串",
  );
  const badShape2 = trySubmit(
    "task:D-形态2",
    "task.definition_imported",
    {
      definition_sha256: "d".repeat(64),
      plan_revision: "p".repeat(64),
      definition_revision: 1,
      requirement_ids: ["req-合法", 123],
      definition_change_id: null,
    },
    null,
    "k-⑮形态杂",
  );
  const badShape3 = trySubmit(
    "task:D-形态3",
    "task.definition_imported",
    {
      definition_sha256: "d".repeat(64),
      plan_revision: "p".repeat(64),
      definition_revision: 1,
      requirement_ids: null,
      definition_change_id: 42,
    },
    null,
    "k-⑮形态数",
  );
  ok(
    !badShape1.accepted &&
      badShape1.code === "INVALID_COMMAND" &&
      badShape1.message.includes("requirement_ids") &&
      !badShape2.accepted &&
      badShape2.code === "INVALID_COMMAND" &&
      badShape2.message.includes("requirement_ids") &&
      !badShape3.accepted &&
      badShape3.code === "INVALID_COMMAND" &&
      badShape3.message.includes("definition_change_id") &&
      eventCount() === before,
    `⑮ 引用元数据形态不合法（非数组/杂元素/非串批次）→ INVALID_COMMAND 点名字段、零写入（实际 ${[badShape1, badShape2, badShape3].map((r) => (r.accepted ? "被接受" : r.code)).join("/")}）`,
  );
}

// ⑯ 旧形态直连（payload 没有两个新键）→ 照收：历史事件重放与旧调用方行为零改动（兼容形态可判）
{
  const before = eventCount();
  const r = trySubmit(
    "task:D-旧形态",
    "task.definition_imported",
    { definition_sha256: "e".repeat(64), plan_revision: "p".repeat(64), definition_revision: 1 },
    null,
    "k-⑯旧形态",
  );
  ok(
    r.accepted && eventCount() === before + 1,
    `⑯ 旧形态 payload（无引用元数据键）直连照收——历史/旧调用零改动（seq 前进到 ${eventCount()}）`,
  );
}

// ⑰ 正对照：新形态直连、引用已登记对象 → 接受、事件前进、读回 payload 真带引用元数据
const CHG_REF = "change-引用";
{
  const opened = trySubmit(
    `change:${CHG_REF}`,
    "change.opened",
    {
      goal: "直连定义引用",
      authorized_scope: "仅入口级验证",
      target_baseline: { design_revision: "a".repeat(64), plan_revision: "b".repeat(64) },
      affected_subsystems: [],
      exit_criteria: "读回一致",
    },
    null,
    "k-⑰开引用批次",
  );
  const before = eventCount();
  const r = trySubmit(
    "task:D-合法引用",
    "task.definition_imported",
    {
      definition_sha256: "f".repeat(64),
      plan_revision: "p".repeat(64),
      definition_revision: 1,
      requirement_ids: [REQ_OK],
      definition_change_id: CHG_REF,
    },
    null,
    "k-⑰合法引用",
  );
  const written = loadEvents(workDir).events.find((e) => e.idempotency_key === "k-⑰合法引用");
  ok(
    opened.accepted &&
      r.accepted &&
      eventCount() === before + 1 &&
      JSON.stringify(written?.payload.requirement_ids) === JSON.stringify([REQ_OK]) &&
      written?.payload.definition_change_id === CHG_REF,
    `⑰ 正对照：新形态直连引用已登记需求/批次 → 接受落盘、payload 真带引用元数据（seq 前进到 ${eventCount()}）`,
  );
}

// ⑱ canonical 路径（submitDefinitionImports 经同一服务）：
//    · 事件 payload 真带 requirement_ids/definition_change_id——不在包装层先验后丢元数据；
//    · 信封 change_id（写入归因）与 payload.definition_change_id（定义自身绑定）两个事实各自如实保留；
//    · 带悬空引用的批次整体拒、零写入（包装层预检与服务边界同一份判据）。
const DIRECT_PLAN = [
  "# C015 直连写口夹具施工图",
  "",
  "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |",
  "| --- | --- | --- | --- | --- |",
  "| D-1 | todo | 直连写口引用校验 |  | 服务侧拒绝记录 |",
  "",
  "### D-1 直连写口引用校验",
  "",
  "**设计依据**：§2.5。**依赖**：无。",
  "",
  "**契约**：输入定义，输出事件。",
  "",
  "**文件责任**：新增 `src/x.ts`。",
  "",
  "- [ ] 悬空引用被拒",
  "",
  "**交付**：验证记录。",
].join("\n");
const DIRECT_PLAN_REV = crypto.createHash("sha256").update(DIRECT_PLAN, "utf8").digest("hex");
{
  const submitter = {
    submit: (c: unknown) => service.submit(c),
    readReferences: () => collectRegisteredReferences(workDir),
  };
  const defs = importTaskDefinitions(DIRECT_PLAN, {
    plan_revision: DIRECT_PLAN_REV,
    requirement_ids: { "D-1": [REQ_OK] },
    change_id: CHG_REF,
  }).definitions;
  const before = eventCount();
  // 信封 change_id（change-none）与定义自身 change_id（change-引用）故意不同：两个事实都要如实留下
  const receipts = submitDefinitionImports(submitter, {
    project_id: PROJECT,
    change_id: "change-none",
    actor_id: "c015-service-verify",
    role: "coordinator",
    definitions: defs,
  });
  const written = loadEvents(workDir).events.filter((e) => e.type === "task.definition_imported" && e.entity_id === "task:D-1");
  const last = written[written.length - 1];
  ok(
    receipts.length === 1 &&
      receipts[0].ok &&
      eventCount() === before + 1 &&
      JSON.stringify(last?.payload.requirement_ids) === JSON.stringify([REQ_OK]) &&
      last?.payload.definition_change_id === CHG_REF &&
      last?.change_id === "change-none",
    `⑱ canonical 路径：事件 payload 真带 requirement_ids/definition_change_id，信封 change_id 与定义绑定批次两个事实各自如实（seq 前进到 ${eventCount()}）`,
  );
  // 带悬空引用的批次：整体拒、零写入（与直连 ⑬ 同一份判据，不是包装层私有一套）
  const ghostDefs = importTaskDefinitions(DIRECT_PLAN, {
    plan_revision: DIRECT_PLAN_REV,
    requirement_ids: { "D-1": ["req-不存在"] },
  }).definitions;
  const beforeGhost = eventCount();
  let ghostErr: { code?: string; message?: string } | null = null;
  try {
    submitDefinitionImports(submitter, {
      project_id: PROJECT,
      change_id: "change-none",
      actor_id: "c015-service-verify",
      role: "coordinator",
      definitions: ghostDefs,
      expected_revisions: { "D-1": 1 },
    });
  } catch (e) {
    ghostErr = e as { code?: string; message?: string };
  }
  ok(
    ghostErr?.code === "INVALID_COMMAND" &&
      String(ghostErr?.message).includes("req-不存在") &&
      eventCount() === beforeGhost,
    `⑱ canonical 批次带悬空引用 → INVALID_COMMAND 点名 id、整体零写入（code=${ghostErr?.code ?? "没有报错"}）`,
  );
}

console.log(process.exitCode ? "\n[verify] 有 FAIL" : "\n[verify] 全部 PASS");
fs.rmSync(tmpBase, { recursive: true, force: true });
