// V06-09 验证脚本（PLAN.md V06-09，DESIGN.md §4.2 为主契约，另见 §5.4–§5.8）。
// 用法：pnpm verify:v06-09（或 node --import tsx scripts/verify-v06-09.ts）
//
// 自带隔离环境：临时 TATAI_HOME + 两个夹具项目（`os.tmpdir()` 下），**不碰**任何真实项目的
// `.工作台/`；塔台自身的 DESIGN.md / PLAN.md / PROGRESS.md / AGENTS.md / README.md / 两份设计史
// **只读**（脚本首尾逐文件 sha256 对照，证明零改动；DESIGN.md 附录 B 随整文件哈希一起证明）。
// 收尾清理自建临时目录与起过的子进程（TATAI_KEEP_TMP=1 可保留现场）。
//
// 模型夹具：**不依赖真机网关**——本卡没有语义/模型环节，全部是确定性事实与规则：缺陷与审计记录
// 都用真实事件提交（唯一写入者 = `WorkService`），状态投影是纯函数；只有 ④ 的只读入口真起后端
// （那一条要证的正是路由接线）。
//
// 覆盖点（PLAN V06-09 三条检查项逐条）：
//   ① 分离记录：结果提交/自检/独立审计/修复待复测/人工接受各占一个实体前缀；自审、覆盖矩阵缺视角、
//      人工验收非用户身份都被拒；severity 按用户后果；finding 去重（同指纹自动归并 + 显式判重）、
//      误报、未证实（风险未排除）、关闭（修复自述不关闭）规则明确；证据正文内容寻址且不可变。
//   ② 状态规则：父子（所有必需子项 + 自身集成检查）、连线（集成线要自己的证据，两个端点绿不代表连线绿；
//      依赖线只看前置是否释放；静态引用线不着完成色）、证据版本复核（旧绿转待验证并保留历史）、
//      源变了只重验影响范围、未知影响不默认通过、未映射不空集判绿、依赖释放不看前卡自报 done、
//      风险升级按后果判、不用节点数算虚假完成百分比。
//   ③ 八个预置场景逐个断言状态与原因：预置缺陷 / 重复 finding / 无证据 done / 陈旧代码版本 /
//      空任务父级 / 存在正在做+旧问题 / 多前置集成 / 接受限制仍有缺陷。
//   ④ 兼容与登记：未迁移项目 v1 四色逐字不变（正反向对照）、已迁移项目按事实派生、
//      事件词表登记面对账、两条只读路由真 HTTP 可达。
import crypto from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  AUDIT_ENTITY_PREFIXES,
  AUDIT_EVENT_TYPES,
  buildAuditPackage,
  buildSpotCheckPackage,
  checkAuditChain,
  foldAuditRecords,
  readAuditRecords,
  submitFix,
  submitHumanAcceptance,
  submitIndependentAudit,
  submitRetest,
  submitSelfCheck,
  submitSubmission,
} from "../src/server/work/audit";
import {
  evidenceManifest,
  FINDING_EVENT_TYPES,
  FINDING_STATUSES,
  FINDING_STATUS_LABELS,
  findingFingerprint,
  findingIdOfFingerprint,
  findingLedger,
  foldFindings,
  MUST_BLOCK_SEVERITIES,
  openFinding,
  putEvidence,
  readEvidence,
  readFindings,
  SEVERITY_BASIS,
  submitFindingAcceptedRisk,
  submitFindingFix,
  submitFindingRetest,
  transitionFinding,
  type RevisionKind,
} from "../src/server/work/evidence";
import {
  acceptanceDimensionOf,
  buildCompatProgressProjection,
  checkEffectiveness,
  checksFromAudit,
  collectProjectFacts,
  objectsFromFacts,
  dependencyRelease,
  DISPLAY_STATUS_LABELS,
  DISPLAY_STATUS_PRIORITY,
  escalateRisk,
  impactScope,
  moduleStatusFromProjections,
  NO_COMPLETION_PERCENT,
  projectFromFacts,
  projectStatuses,
  v1ModuleStatusOf,
  writeCompatProgressProjection,
  type CheckInput,
  type StatusObjectInput,
} from "../src/server/work/statusProjection";
import { readTaskStates, TASK_EVENT_TYPES } from "../src/server/work/tasks";
import { WorkService } from "../src/server/work/service";
import { EXECUTION_EVENT_TYPES } from "../src/server/work/executionReceipts";
import { REQUIREMENT_EVENT_TYPES } from "../src/server/work/requirements";
import { CHANGE_EVENT_TYPES } from "../src/server/work/changes";
import { BUDGET_EVENT_TYPES } from "../src/server/work/budget";
import { SYNC_EVENT_TYPES } from "../src/server/work/sync";
import {
  REGISTERED_EVENT_TYPES,
  registeredEventTypes,
  WORK_ERROR_CODES,
} from "../src/server/work/types";
import { addModule, projectWorkDir, setModuleStatus } from "../src/server/workstation";
import { tasksFileOf } from "../src/server/work/migrate";

const REPO = process.cwd();
const PORT = 8819;
const MAIN = "v0609-main";
const LEGACY = "v0609-legacy";
/** 本卡只读的塔台根文档（首尾 sha256 对照；DESIGN.md 附录 B 随整文件哈希一起证明） */
const DOC_FILES = [
  "DESIGN.md",
  "PLAN.md",
  "PROGRESS.md",
  "AGENTS.md",
  "README.md",
  "docs/design-history-v0.4.md",
  "docs/design-history-v0.5.md",
];

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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha256 = (data: string | Buffer): string => crypto.createHash("sha256").update(data).digest("hex");
const sha256File = (f: string): string => sha256(fs.readFileSync(f));
const short = (s: string | null | undefined, n = 12): string => (s == null ? "null" : `${s.slice(0, n)}…`);
const statuses = (set: { objects: { object_id: string; display_status: string | null; mapping: string }[] }): string =>
  set.objects.map((o) => `${o.object_id}=${o.display_status ?? "无完成色"}${o.mapping === "unmapped" ? "(未映射)" : ""}`).join(" ");

const spawned: ChildProcess[] = [];
process.on("exit", () => {
  for (const proc of spawned) {
    try {
      if (proc.exitCode === null) proc.kill("SIGKILL");
    } catch {
      // 已经没了
    }
  }
});

// ── 塔台根文档零改动（首尾哈希） ──
const docBefore = new Map<string, string>();
for (const rel of DOC_FILES) {
  const abs = path.join(REPO, rel);
  docBefore.set(rel, fs.existsSync(abs) ? sha256File(abs) : "<missing>");
}

// ── 隔离环境与夹具 ──
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-v0609-verify-"));
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
for (const d of [dataDir, mainRoot, legacyRoot]) mkdirp(d);

const MAIN_PLAN = [
  "# 夹具施工图（V06-09）",
  "",
  "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |",
  "| --- | --- | --- | --- | --- |",
  "| T-1 | todo | 打地基 |  | 地基验收记录 |",
  "| T-2 | todo | 砌墙 | T-1 | 墙体验收记录 |",
  "| T-3 | todo | 抹灰 | T-2 | 抹灰验收记录 |",
  "| T-4 | todo | 油漆 |  | 油漆验收记录 |",
  "",
  "### T-1 打地基",
  "",
  "**设计依据**：§1。**依赖**：无。",
  "",
  "**契约**：输入土，输出地基。",
  "",
  "**文件责任**：新增 `src/base.ts`。",
  "",
  "- [ ] 地基水平",
  "- [ ] 地基压实",
  "",
  "**交付**：地基验收记录。",
  "",
  "### T-2 砌墙",
  "",
  "**设计依据**：§1。**依赖**：T-1。",
  "",
  "**契约**：输入砖，输出墙。",
  "",
  "**文件责任**：新增 `src/wall.ts`。",
  "",
  "- [ ] 砌到顶",
  "- [ ] 验过垂直度",
  "",
  "**交付**：墙体验收记录。",
  "",
  "### T-3 抹灰",
  "",
  "**设计依据**：§1。**依赖**：T-2。",
  "",
  "**契约**：输入墙，输出抹灰面。",
  "",
  "**文件责任**：新增 `src/plaster.ts`。",
  "",
  "- [ ] 抹平",
  "",
  "**交付**：抹灰验收记录。",
  "",
  "### T-4 油漆",
  "",
  "**设计依据**：§1。**依赖**：无。",
  "",
  "**契约**：输入抹灰面，输出漆面。",
  "",
  "**文件责任**：新增 `src/paint.ts`。",
  "",
  "- [ ] 漆面无色差",
  "",
  "**交付**：油漆验收记录。",
  "",
].join("\n");
const MAIN_DESIGN = "# V0609 夹具设计书\n\n## 1 概述\n本夹具用于验证证据、独立审计与自动状态。\n";
write(path.join(workbench(mainRoot), "design.md"), MAIN_DESIGN);
write(path.join(workbench(mainRoot), "plan.md"), MAIN_PLAN);
write(path.join(mainRoot, "src", "base.ts"), "export const BASE = 'base-v1';\n");
write(path.join(mainRoot, "src", "wall.ts"), "export const WALL = 'wall-v1';\n");
write(path.join(mainRoot, "src", "paint.ts"), "export const PAINT = 'paint-v1';\n");
// v1 台账（模块归属的唯一现实来源）——夹具文件直接落在自己的临时项目目录里，
// 产品代码走注册表读（注册表在下面写）
write(
  path.join(workbench(mainRoot), "tasks.json"),
  JSON.stringify(
    {
      version: 1,
      tasks: ["T-1", "T-2", "T-3", "T-4"].map((id) => ({
        id,
        title: id,
        module_id: id === "T-1" ? "base" : id === "T-4" ? "paint" : "wall",
        status: "todo",
        reporter: "kimi-code",
        updated_at: "2026-09-20T00:00:00+08:00",
      })),
    },
    null,
    2,
  ),
);
// 已有 v1 progress.json（Gate 时间线是既有历史行为，本卡不动它；兼容投影要原样保留 gate）
const MAIN_PROGRESS = path.join(workbench(mainRoot), "progress.json");
const MAIN_PROGRESS_BEFORE = JSON.stringify(
  {
    version: 1,
    gate: {
      current_step: "develop",
      history: [{ step: "develop", result: "pass", at: "2026-09-20T00:00:00+08:00", note: "夹具" }],
    },
    modules: [{ id: "base", name: "base", status: "todo" }],
  },
  null,
  2,
);
write(MAIN_PROGRESS, MAIN_PROGRESS_BEFORE);
write(path.join(legacyRoot, "src", "app.ts"), "export const APP = 'legacy';\n");

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
    { version: 1, projects: [projectRecord(MAIN, "V06-09 主夹具", mainRoot), projectRecord(LEGACY, "V06-09 未迁移夹具", legacyRoot)] },
    null,
    2,
  ),
);
process.env.TATAI_HOME = dataDir;

// ── 唯一写入者 + 缺陷读侧（去重与状态推进都要先读） ──
const service = new WorkService({ dataDir });
const submitter = {
  submit: (command: unknown) => service.submit(command),
  read: () => readFindings(MAIN_WORK),
};
const CHG = "chg-v0609";
const codeRev1 = sha256("code-v1");
const codeRev2 = sha256("code-v2");
const planRev = sha256(MAIN_PLAN);
const designRev = sha256(MAIN_DESIGN);

const putEv = (
  kind: Parameters<typeof putEvidence>[1]["kind"],
  summary: string,
  content: string,
  revision: { kind: RevisionKind; value: string },
  by = "kimi-code",
  role = "executor",
) =>
  putEvidence(MAIN_WORK, {
    content,
    kind,
    summary,
    created_by: by,
    role,
    binding: { revision_kind: revision.kind, revision: revision.value },
    source_ref: summary,
  });

const taskRev = (taskId: string): number | null => readTaskStates(MAIN_WORK).states[taskId]?.revision ?? null;
const taskEvent = (type: string, taskId: string, payload: Record<string, unknown>, actor = "kimi-code") =>
  service.submit({
    schema_version: 2,
    project_id: MAIN,
    change_id: CHG,
    entity_id: `task:${taskId}`,
    expected_revision: taskRev(taskId),
    type,
    actor_id: actor,
    role: "executor",
    idempotency_key: `${taskId}:${type}:${(taskRev(taskId) ?? 0) + 1}:${CHG}`,
    payload,
  });

const portListening = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const sock = net.connect({ port, host: "127.0.0.1" });
    const done = (busy: boolean) => {
      sock.destroy();
      resolve(busy);
    };
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
    sock.setTimeout(1000, () => done(false));
  });
function spawnServer(): ChildProcess {
  const proc = spawn(process.execPath, ["--import", "tsx", path.join("src", "server", "index.ts")], {
    cwd: REPO,
    env: { ...process.env, TATAI_HOME: dataDir, TATAI_PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  spawned.push(proc);
  proc.stdout.on("data", (d: Buffer) => {
    if (process.env.TATAI_VERBOSE === "1") process.stdout.write(`[server] ${d.toString()}`);
  });
  proc.stderr.on("data", (d: Buffer) => process.stderr.write(`[server] ${d.toString()}`));
  return proc;
}
async function waitUp(): Promise<void> {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (r.ok) return;
    } catch {
      // 还没起来
    }
    await sleep(250);
  }
  throw new Error(`后端 ${PORT} 20 秒内未就绪`);
}
const api = async (p: string): Promise<{ status: number; body: any }> => {
  const r = await fetch(`http://127.0.0.1:${PORT}${p}`);
  const text = await r.text();
  let body: any = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: r.status, body };
};

// ══════════════════════════ 夹具事实（全部真实提交） ══════════════════════════

const diffEvidence = putEv("submission", "T-1 交付包 diff（base.ts 新增）", "diff --git a/src/base.ts b/src/base.ts\n+export const BASE = 'base-v1';\n", { kind: "code", value: codeRev1 });
const selfOut = putEv("self_check", "T-1 地基水平自检输出", "$ node -e 'check'\nOK 地基水平\n", { kind: "code", value: codeRev1 });
const auditOut = putEv("independent_audit", "T-1 独立审计依据（读原文，不看作者摘要）", "独立复算：地基水平/压实复核通过\n", { kind: "code", value: codeRev1 }, "claude-code", "auditor");
const paintOut = putEv("self_check", "T-4 漆面色差自检输出", "$ node -e 'check paint'\nOK 漆面无色差\n", { kind: "code", value: codeRev1 });
const paintAudit = putEv("independent_audit", "T-4 独立审计依据", "独立复算：漆面无色差\n", { kind: "code", value: codeRev1 }, "gpt-6", "auditor");
const reproMaterial = putEv("repro", "T-2 砌墙缺陷复现材料", "复现：跑 3 次有 2 次塌\n", { kind: "code", value: codeRev1 }, "claude-code", "auditor");
const retestEvidenceOk = putEv("retest", "F5 复测：复现已消失 + 回归范围", "复测：不再塌；回归 T-1/T-2 场景重跑通过\n", { kind: "code", value: codeRev1 }, "claude-code", "auditor");
const fixEvidence = putEv("fix", "F5 修复前后对照", "修复：加支撑\n", { kind: "code", value: codeRev1 });
const fixEvidence2 = putEv("fix", "F6 修复自述", "修复：调整抹灰配比（自述，尚未复测）\n", { kind: "code", value: codeRev1 });
const acceptEvidence = putEv("acceptance", "用户验收场景（接受已知限制）", "用户：这条限制我接受，下个批次再收\n", { kind: "code", value: codeRev1 }, "主人", "user");

// 任务事实：T-1 一路到结果已提交；T-2 只自报交结果；T-3 正在做；T-4 干净通过路径
taskEvent("task.definition_imported", "T-1", { definition_sha256: sha256("T-1-def"), plan_revision: planRev, definition_revision: 1 });
taskEvent("task.status_changed", "T-1", { status: "ready" });
taskEvent("task.claimed", "T-1", { run_id: "run-1", attempt_id: "a1", owner_id: "kimi-code", claim_token: "tok-1", lease_expires_at: "2026-09-20T02:00:00+08:00" });
taskEvent("task.status_changed", "T-1", { status: "executing" });
taskEvent("task.result_submitted", "T-1", {});
taskEvent("task.definition_imported", "T-2", { definition_sha256: sha256("T-2-def"), plan_revision: planRev, definition_revision: 1 });
taskEvent("task.result_submitted", "T-2", {});
taskEvent("task.definition_imported", "T-3", { definition_sha256: sha256("T-3-def"), plan_revision: planRev, definition_revision: 1 });
taskEvent("task.claimed", "T-3", { run_id: "run-3", attempt_id: "a3", owner_id: "kimi-code", claim_token: "tok-3", lease_expires_at: "2026-09-20T02:00:00+08:00" });
taskEvent("task.status_changed", "T-3", { status: "executing" });
taskEvent("task.definition_imported", "T-4", { definition_sha256: sha256("T-4-def"), plan_revision: planRev, definition_revision: 1 });
taskEvent("task.result_submitted", "T-4", {});

// 缺陷事实
const f1 = openFinding(submitter, {
  project_id: MAIN,
  change_id: CHG,
  actor_id: "claude-code",
  role: "auditor",
  severity: "blocks_core_goal",
  source: "独立审计：砌墙检查",
  expected: "砌到顶且垂直度合格",
  actual: "砌到一半就塌",
  repro: "跑 3 次有 2 次塌",
  evidence_sha256: reproMaterial.sha256,
  affected_revision: codeRev1,
  object_id: "T-3",
});
const f1again = openFinding(submitter, {
  project_id: MAIN,
  change_id: CHG,
  actor_id: "kimi-code",
  role: "executor",
  severity: "blocks_core_goal",
  source: "独立审计：砌墙检查",
  expected: "砌到顶且垂直度合格",
  actual: "砌到一半就塌",
  repro: "跑 3 次有 2 次塌",
  evidence_sha256: reproMaterial.sha256,
  affected_revision: codeRev1,
  object_id: "T-3",
});
const f3 = openFinding(submitter, {
  project_id: MAIN,
  change_id: CHG,
  actor_id: "gpt-6",
  role: "auditor",
  severity: "data_loss",
  source: "终审抽查：墙塌导致返工",
  expected: "墙稳定",
  actual: "返工重砌",
  repro: "同上",
  evidence_sha256: reproMaterial.sha256,
  affected_revision: codeRev1,
  object_id: "T-2",
  duplicate_of: f1.finding_id,
});
const f4 = openFinding(submitter, {
  project_id: MAIN,
  change_id: CHG,
  actor_id: "claude-code",
  role: "auditor",
  severity: "unauthorized_access",
  source: "独立审计：抹灰面读到了别的项目的料",
  expected: "只读本项目材料",
  actual: "疑似串项目",
  affected_revision: codeRev1,
  object_id: "T-3",
});
const f5 = openFinding(submitter, {
  project_id: MAIN,
  change_id: CHG,
  actor_id: "claude-code",
  role: "auditor",
  severity: "user_visible_defect",
  source: "独立审计：地基水平读数不稳",
  expected: "读数稳定",
  actual: "抖动 ±3mm",
  repro: "连测 5 次",
  evidence_sha256: selfOut.sha256,
  affected_revision: codeRev1,
  object_id: "T-1",
});
submitFindingFix(submitter, { project_id: MAIN, change_id: CHG, actor_id: "kimi-code", role: "executor", finding_id: f5.finding_id, fix_revision: codeRev1, evidence_sha256: fixEvidence.sha256 });
submitFindingRetest(submitter, { project_id: MAIN, change_id: CHG, actor_id: "gpt-6", role: "auditor", finding_id: f5.finding_id, retested_by: "gpt-6", retest_evidence: retestEvidenceOk.sha256, result: "pass", regression_scope: ["T-1", "T-2"] });
const f6 = openFinding(submitter, {
  project_id: MAIN,
  change_id: CHG,
  actor_id: "claude-code",
  role: "auditor",
  severity: "user_visible_defect",
  source: "独立审计：抹灰面有波纹",
  expected: "抹平",
  actual: "有波纹",
  repro: "摸一遍",
  evidence_sha256: selfOut.sha256,
  affected_revision: codeRev1,
  object_id: "T-3",
});
submitFindingFix(submitter, { project_id: MAIN, change_id: CHG, actor_id: "kimi-code", role: "executor", finding_id: f6.finding_id, fix_revision: codeRev1, evidence_sha256: fixEvidence2.sha256 });
const f7 = openFinding(submitter, {
  project_id: MAIN,
  change_id: CHG,
  actor_id: "kimi-code",
  role: "executor",
  severity: "degraded_experience",
  source: "自检：以为漆面有色差",
  expected: "无色差",
  actual: "疑似色差",
  affected_revision: codeRev1,
  object_id: "T-4",
});
transitionFinding(submitter, { project_id: MAIN, change_id: CHG, actor_id: "gpt-6", role: "auditor", finding_id: f7.finding_id, to: "false_positive", reviewer: "gpt-6", note: "独立复核：色差是屏幕反光，不是漆面问题" });
const f8 = openFinding(submitter, {
  project_id: MAIN,
  change_id: CHG,
  actor_id: "claude-code",
  role: "auditor",
  severity: "data_loss",
  source: "独立审计：地基塌陷会覆盖旧测量数据",
  expected: "测量数据不被覆盖",
  actual: "极端情况下会覆盖",
  repro: "断电重跑",
  evidence_sha256: reproMaterial.sha256,
  affected_revision: codeRev1,
  object_id: "T-1",
});
submitFindingAcceptedRisk(submitter, {
  project_id: MAIN,
  change_id: CHG,
  actor_id: "主人",
  role: "user",
  finding_id: f8.finding_id,
  accepted_by: "主人",
  basis: "接受已知限制：下个批次再收口",
  scope_revision: codeRev1,
  review_condition: "下批次开工前复查",
});

// 审计链事实（五件事分开记录）
const submission = submitSubmission(submitter, {
  project_id: MAIN,
  change_id: CHG,
  actor_id: "kimi-code",
  role: "executor",
  record_id: "sub-T-1-1",
  goal: "T-1 打地基交付",
  task_id: "T-1",
  baseline: { baseline_id: "bl-fixture", design_revision: designRev, plan_revision: planRev },
  diff_sha256: diffEvidence.sha256,
  diff_recovery: diffEvidence.recovery_path,
  changed_files: ["src/base.ts"],
  affected_interfaces: ["Base"],
  commands: [{ command: "node --import tsx scripts/verify-v06-09.ts", exit_code: 0, output_ref: "evidence:" + diffEvidence.sha256 }],
  untested: [{ item: "真实项目迁移", reason: "按卡面红线不碰真实项目（等 V06-10）" }],
  known_issues: ["F8 已知限制（用户已接受）"],
  requirement_refs: ["§4.2"],
  evidence_refs: [diffEvidence.sha256, selfOut.sha256],
  binding: { revision_kind: "code", revision: codeRev1 },
  submitted_by: "kimi-code",
});
const selfCheck = submitSelfCheck(submitter, {
  project_id: MAIN,
  change_id: CHG,
  actor_id: "kimi-code",
  role: "executor",
  record_id: "self-T-1-1",
  task_id: "T-1",
  checked_by: "kimi-code",
  checks: [
    { check_id: "T-1::check:0", method: "跑地基水平脚本", command: "node -e check", exit_code: 0, output_ref: selfOut.recovery_path, evidence_sha256: selfOut.sha256, verifies: "code" },
    { check_id: "T-1::check:1", method: "跑地基压实脚本", command: "node -e check2", exit_code: 0, output_ref: selfOut.recovery_path, evidence_sha256: selfOut.sha256, verifies: "code" },
    { check_id: "T-1::evidence", method: "交付记录", output_ref: selfOut.recovery_path, evidence_sha256: selfOut.sha256, verifies: "code" },
  ],
  conclusion: "pass",
  binding: { revision_kind: "code", revision: codeRev1 },
});
const independent = submitIndependentAudit(submitter, {
  project_id: MAIN,
  change_id: CHG,
  actor_id: "claude-code",
  role: "auditor",
  record_id: "audit-T-1-1",
  task_id: "T-1",
  auditor: "claude-code",
  author_id: "kimi-code",
  same_session_as_author: false,
  read_author_summary_first: false,
  model_note: "低成本审计（不同会话、先不看作者摘要）",
  checks: [
    { check_id: "T-1::check:0", result: "passed", evidence_sha256: auditOut.sha256 },
    { check_id: "T-1::check:1", result: "passed", evidence_sha256: auditOut.sha256 },
    { check_id: "T-1::evidence", result: "passed", evidence_sha256: auditOut.sha256 },
  ],
  coverage: [
    { area: "behavior_boundaries", status: "checked", basis: "跑水平/压实边界" },
    { area: "data_concurrency", status: "not_applicable", basis: "本卡无并发写" },
    { area: "interface_integration", status: "checked", basis: "Base 接口调用方" },
    { area: "failure_recovery", status: "checked", basis: "断电重跑" },
    { area: "trust_permission", status: "checked", basis: "无越权读" },
  ],
  findings: [f5.finding_id, f8.finding_id],
  conclusion: "pass",
  not_reported_scope: ["src/plaster.ts（尚未实现）"],
  method_limits: ["静态读原文 + 隔离夹具，不含真机长跑"],
  binding: { revision_kind: "code", revision: codeRev1 },
});
submitSelfCheck(submitter, {
  project_id: MAIN,
  change_id: CHG,
  actor_id: "kimi-code",
  role: "executor",
  record_id: "self-T-4-1",
  task_id: "T-4",
  checked_by: "kimi-code",
  checks: [
    { check_id: "T-4::check:0", method: "跑漆面脚本", command: "node -e paint", exit_code: 0, output_ref: paintOut.recovery_path, evidence_sha256: paintOut.sha256, verifies: "code" },
    { check_id: "T-4::evidence", method: "交付记录", output_ref: paintOut.recovery_path, evidence_sha256: paintOut.sha256, verifies: "code" },
  ],
  conclusion: "pass",
  binding: { revision_kind: "code", revision: codeRev1 },
});
submitIndependentAudit(submitter, {
  project_id: MAIN,
  change_id: CHG,
  actor_id: "gpt-6",
  role: "auditor",
  record_id: "audit-T-4-1",
  task_id: "T-4",
  auditor: "gpt-6",
  author_id: "kimi-code",
  checks: [
    { check_id: "T-4::check:0", result: "passed", evidence_sha256: paintAudit.sha256 },
    { check_id: "T-4::evidence", result: "passed", evidence_sha256: paintAudit.sha256 },
  ],
  coverage: [
    { area: "behavior_boundaries", status: "checked", basis: "漆面边界" },
    { area: "data_concurrency", status: "not_applicable", basis: "无并发" },
    { area: "interface_integration", status: "checked", basis: "Paint 接口" },
    { area: "failure_recovery", status: "not_applicable", basis: "无外部动作" },
    { area: "trust_permission", status: "checked", basis: "无越权" },
  ],
  conclusion: "pass",
  binding: { revision_kind: "code", revision: codeRev1 },
});
const fix5 = submitFix(submitter, {
  project_id: MAIN,
  change_id: CHG,
  actor_id: "kimi-code",
  role: "executor",
  record_id: "fix-F5-1",
  finding_id: f5.finding_id,
  fix_revision: codeRev1,
  fixed_by: "kimi-code",
  evidence_ref: fixEvidence.sha256,
  regression: [{ command: "node --import tsx scripts/verify-v06-09.ts", exit_code: 0, output_ref: "log:v0609" }],
});
const retest5 = submitRetest(submitter, {
  project_id: MAIN,
  change_id: CHG,
  actor_id: "claude-code",
  role: "auditor",
  record_id: "retest-F5-1",
  finding_id: f5.finding_id,
  fix_revision: codeRev1,
  retested_by: "claude-code",
  retest_evidence: retestEvidenceOk.sha256,
  result: "pass",
  regression_scope: ["T-1", "T-2"],
});
const acceptance = submitHumanAcceptance(submitter, {
  project_id: MAIN,
  change_id: CHG,
  actor_id: "主人",
  role: "user",
  record_id: "acc-T-1-1",
  decision: "accept_known_limit",
  task_id: "T-1",
  batch_id: "batch-1",
  scenario_refs: ["场景：地基水平与压实"],
  baseline: { baseline_id: "bl-fixture", design_revision: designRev, plan_revision: planRev },
  evidence_refs: [acceptEvidence.sha256],
  accepted_by: "主人",
  note: "接受已知限制（F8）",
});

// ══════════════════════════ 公共取数 ══════════════════════════
const findingsNow = () => readFindings(MAIN_WORK).findings;
const allFindings = () => Object.values(findingsNow());
const auditNow = () => readAuditRecords(MAIN_WORK);
/** 一组合法的必需检查项（用主夹具的真实证据哈希；默认绑当前代码版本） */
const passingCheck = (check_id: string, object_id: string, opts: Partial<CheckInput> = {}): CheckInput => ({
  check_id,
  object_id,
  result: "passed",
  actor_id: "claude-code",
  role: "auditor",
  independence: "independent",
  binding: { revision_kind: "code", revision: codeRev1 },
  evidence_sha256: auditOut.sha256,
  at: "2026-09-20T01:30:00+08:00",
  ...opts,
});
const taskObject = (taskId: string, checks: string[], findings: string[], opts: Partial<StatusObjectInput> = {}): StatusObjectInput => ({
  object_id: taskId,
  object_kind: "task",
  label: taskId,
  required_checks: checks.map((c) => ({ check_id: c, label: c })),
  finding_ids: findings,
  revisions: { code: codeRev1, plan: planRev, design: designRev },
  ...opts,
});
const codesOf = (p: { reasons: { code: string }[] }): string[] => p.reasons.map((r) => r.code);

let serverChild: ChildProcess | null = null;
// ── 手写事件（坏现场负向用；不改主夹具，不污染事件文件） ──
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
const mkEvent = (
  seq: number,
  entity_id: string,
  type: string,
  payload: Record<string, unknown>,
  opts: { revision?: number; role?: string; actor?: string } = {},
): RawEvent => ({
  schema_version: 2,
  event_id: `e${seq}`,
  project_id: MAIN,
  change_id: CHG,
  entity_id,
  entity_revision: opts.revision ?? 1,
  seq,
  type,
  actor_id: opts.actor ?? "kimi-code",
  role: opts.role ?? "executor",
  occurred_at: "2026-09-20T01:00:00+08:00",
  received_at: "2026-09-20T01:00:00+08:00",
  idempotency_key: `k${seq}`,
  payload,
});

/** 一条断言的错误码捕获（不写盘、不改状态） */
const codeOf = (fn: () => unknown): string => {
  try {
    fn();
    return "";
  } catch (e) {
    return (e as { code?: string }).code ?? "NO_CODE";
  }
};

async function main(): Promise<void> {
  info("V06-09 证据、独立审计与自动状态：证据不可变 / 五件事分开记录 / §4.2 六态与规则 / 八个预置场景");
  info(`  node ${process.version} · ${process.platform} · repo ${REPO}`);
  info(`  夹具：home=${dataDir}（临时）· ${MAIN} / ${LEGACY}`);
  info(`  已提交事件：${service.readSnapshot(MAIN).snapshot?.last_seq ?? 0} 条（8 条缺陷 + 6 类审计记录都走唯一写入者）`);

  // ══════════════════════════ ① 分离记录 ══════════════════════════
  info("── ① 分离记录：五件事各占一个实体前缀，作者自报 ≠ 验证 ≠ 独立审计 ≠ 用户接受");
  const entities = service.readSnapshot(MAIN).snapshot?.entities ?? {};
  const separated: [string, string][] = [
    ["结果提交", "submission:sub-T-1-1"],
    ["自检", "check:self-T-1-1"],
    ["独立审计", "audit:audit-T-1-1"],
    ["修复", "fix:fix-F5-1"],
    ["复测", "retest:retest-F5-1"],
    ["人工接受", "acceptance:acc-T-1-1"],
  ];
  for (const [what, entityId] of separated) {
    ok(entities[entityId] !== undefined, `①-1 ${what} 是独立实体（${entityId}）`);
  }
  ok(
    submission.ok && selfCheck.ok && independent.ok && fix5.ok && retest5.ok && acceptance.ok,
    "①-1 六条记录各有回执（分开提交，互不覆盖）",
  );
  const records = auditNow();
  const findingsForChain = allFindings();
  ok(
    Object.keys(records.submissions).length === 1 &&
      Object.keys(records.self_checks).length === 2 &&
      Object.keys(records.independent_audits).length === 2 &&
      Object.keys(records.fixes).length === 1 &&
      Object.keys(records.retests).length === 1 &&
      Object.keys(records.acceptances).length === 1,
    "①-1 读回记录数：提交 1 / 自检 2 / 独立审计 2 / 修复 1 / 复测 1 / 接受 1（各自独立成表）",
  );
  const chain = checkAuditChain({ records, findings: findingsForChain });
  ok(
    Object.values(chain.separated).every((v) => v === true),
    "①-1 审计链自述：五件事都有各自的记录（separated 全 true）",
  );
  ok(chain.self_check_not_reused_as_audit, "①-1 自检者没有被复用成独立审计者（自检不是独立审计）");
  ok(chain.fix_self_report_does_not_close, "①-1 有关闭的缺陷都有独立复测记录（修复自述不关闭缺陷）");
  ok(chain.acceptance_is_user_role, "①-1 人工接受记录确实来自用户身份");
  ok(
    records.self_checks["self-T-1-1"].independence === "author_self" &&
      records.independent_audits["audit-T-1-1"].auditor !== records.self_checks["self-T-1-1"].checked_by,
    `①-1 自检标 author_self（${records.self_checks["self-T-1-1"].checked_by}）≠ 独立审计者（${records.independent_audits["audit-T-1-1"].auditor}）`,
  );
  ok(
    records.independent_audits["audit-T-1-1"].independence.different_actor === true &&
      records.independent_audits["audit-T-1-1"].independence.read_author_summary_first === false,
    "①-1 独立审计声明了「不同 actor、先不看作者结论」（作者摘要只是导航）",
  );
  // 负向：自审 / 覆盖矩阵不全 / 人工验收非用户身份
  const negAudit = codeOf(() =>
    submitIndependentAudit(submitter, {
      project_id: MAIN,
      change_id: CHG,
      actor_id: "kimi-code",
      role: "executor",
      record_id: "audit-self",
      task_id: "T-1",
      auditor: "kimi-code",
      author_id: "kimi-code",
      coverage: [],
      conclusion: "pass",
    }),
  );
  ok(negAudit === "INVALID_COMMAND", `①-1 自审（审计者 = 作者）被拒（实际 ${negAudit || "没有报错"}）`);
  const negCoverage = codeOf(() =>
    submitIndependentAudit(submitter, {
      project_id: MAIN,
      change_id: CHG,
      actor_id: "claude-code",
      role: "auditor",
      record_id: "audit-partial",
      task_id: "T-1",
      auditor: "claude-code",
      author_id: "kimi-code",
      coverage: [{ area: "behavior_boundaries", status: "checked", basis: "只查了行为" }],
      conclusion: "pass",
    }),
  );
  ok(negCoverage === "INVALID_COMMAND", `①-1 覆盖矩阵缺视角被拒（实际 ${negCoverage || "没有报错"}）`);
  const negAccept = codeOf(() =>
    submitHumanAcceptance(submitter, {
      project_id: MAIN,
      change_id: CHG,
      actor_id: "claude-code",
      role: "coordinator",
      record_id: "acc-forged",
      decision: "accept",
      accepted_by: "user",
    }),
  );
  ok(negAccept === "INVALID_COMMAND", `①-1 人工验收用 agent 身份被拒（不得代签用户 Gate，实际 ${negAccept || "没有报错"}）`);
  ok(
    service.readSnapshot(MAIN).snapshot?.entities["audit:audit-self"] === undefined &&
      service.readSnapshot(MAIN).snapshot?.entities["acceptance:acc-forged"] === undefined,
    "①-1 被拒的命令一个字节都没写（非法命令不留痕）",
  );

  // ══════════════════════════ ① 证据不可变 ══════════════════════════
  info("── ① 证据正文：内容寻址 / 不可变 / 读时复核哈希 / 事件只引用哈希（DESIGN §2.6）");
  const blobAgain = putEvidence(MAIN_WORK, {
    content: "diff --git a/src/base.ts b/src/base.ts\n+export const BASE = 'base-v1';\n",
    kind: "other",
    summary: "同一份内容再落一次（摘要不同）",
    created_by: "kimi-code",
    role: "executor",
    binding: { revision_kind: "code", revision: codeRev1 },
  });
  ok(
    blobAgain.duplicate === true && blobAgain.sha256 === diffEvidence.sha256 && blobAgain.summary === diffEvidence.summary,
    "①-3 同内容重复落库不改写、返回首次记录（duplicate=true，摘要仍是首次那份）",
  );
  ok(
    fs.existsSync(path.join(MAIN_WORK, "evidence", `${diffEvidence.sha256}.json`)),
    `①-3 证据正文落在内容地址（.工作台/work/evidence/${short(diffEvidence.sha256)}.json）`,
  );
  const manifest = evidenceManifest(MAIN_WORK);
  ok(
    manifest.length >= 9 && manifest.every((m) => m.intact) && manifest.every((m) => m.recovery_path.startsWith(".工作台/work/evidence/")),
    `①-3 证据清单逐条复核哈希（${manifest.length} 份，全部 intact，恢复位置是项目内相对路径）`,
  );
  const eventsText = read(path.join(MAIN_WORK, "events.jsonl"));
  ok(
    !eventsText.includes("diff --git a/src/base.ts") && !eventsText.includes("独立复算：地基水平"),
    "①-3 事件文件里只有引用（证据正文没有塞进事件）",
  );
  ok(
    eventsText.includes(diffEvidence.sha256),
    "①-3 事件里引用的是证据哈希（证据与事件对得上，可追溯）",
  );
  const missingEvidence = codeOf(() => readEvidence(MAIN_WORK, sha256("这份证据不存在")));
  ok(missingEvidence === "EVIDENCE_INVALID", `①-3 引用不存在的证据 → EVIDENCE_INVALID（实际 ${missingEvidence || "没有报错"}）`);

  // ══════════════════════════ ① 缺陷记录规则 ══════════════════════════
  info("── ① 缺陷记录：最小字段、七态、去重、误报、未证实、关闭、接受风险、严重度按用户后果");
  const fm = findingsNow();
  const f1State = fm[f1.finding_id];
  const f3State = fm[f3.finding_id];
  const f4State = fm[f4.finding_id];
  const f5State = fm[f5.finding_id];
  const f6State = fm[f6.finding_id];
  const f7State = fm[f7.finding_id];
  const f8State = fm[f8.finding_id];
  const ledger = findingLedger(Object.values(fm));
  ok(
    FINDING_STATUSES.length === 7 &&
      JSON.stringify([...FINDING_STATUSES]) ===
        JSON.stringify(["pending_repro", "confirmed", "duplicate", "false_positive", "fixed_pending_retest", "closed", "accepted_risk"]),
    `①-4 缺陷状态集七值齐全：${FINDING_STATUSES.map((s) => FINDING_STATUS_LABELS[s]).join("/")}`,
  );
  ok(
    f1State !== undefined &&
      f1State.severity === "blocks_core_goal" &&
      f1State.status === "confirmed" &&
      f1State.source !== "" &&
      f1State.repro !== null &&
      f1State.expected !== "" &&
      f1State.actual !== "" &&
      f1State.affected_revision === codeRev1 &&
      f1State.finding_id === f1.finding_id,
    "①-4 §5.5 最小字段齐全（finding_id/severity/status/source/repro/expected/actual/affected_revision）",
  );
  ok(
    f1State.fix_revision === null && f1State.retest_evidence === null && f1State.reviewer === null,
    "①-4 未修复的缺陷不凭空带 fix_revision/retest_evidence/reviewer（缺就是缺）",
  );
  ok(
    MUST_BLOCK_SEVERITIES.includes("blocks_core_goal") &&
      MUST_BLOCK_SEVERITIES.includes("data_loss") &&
      MUST_BLOCK_SEVERITIES.includes("unauthorized_access") &&
      !MUST_BLOCK_SEVERITIES.includes("cosmetic") &&
      !(MUST_BLOCK_SEVERITIES as readonly string[]).includes("degraded_experience") &&
      SEVERITY_BASIS.includes("不看模型品牌") &&
      f1State.must_block === true,
    "①-4 severity 按用户后果定义（阻断核心目标/数据丢失/越权 = 必须拦截；文案/外观不是）",
  );
  ok(
    f4State.status === "pending_repro" && f4State.unverified === true && f4State.risk_not_excluded === true,
    "①-4 没有复现条件的风险 → 待复现 + unverified + risk_not_excluded（明确写「风险未排除」）",
  );
  ok(
    f1again.deduped === true &&
      f1again.finding_id === f1.finding_id &&
      f1State.reports === 2 &&
      Object.values(fm).filter((s) => s.dedupe_key === f1State.dedupe_key).length === 1 &&
      f1State.dedupe_key === findingFingerprint({ source: "独立审计：砌墙检查", expected: "砌到顶且垂直度合格", actual: "砌到一半就塌", affected_revision: codeRev1, object_id: "T-3" }),
    `①-4 同指纹重报自动归并（同一个 finding_id=${f1State.finding_id}，reports=${f1State.reports}，缺陷条数没变多）`,
  );
  ok(
    f3State.status === "duplicate" &&
      f3State.duplicate_of === f1.finding_id &&
      ledger.duplicate.includes(f3State) &&
      !ledger.blocking.includes(f3State),
    "①-4 显式判重 → duplicate + 指向本体；重复不算未收口缺陷（即便 severity 是数据丢失）",
  );
  ok(
    f5State.status === "closed" &&
      f5State.retest_evidence === retestEvidenceOk.sha256 &&
      f5State.reviewer === "gpt-6" &&
      f5State.fix_revision !== null,
    "①-4 修复 → 待复测 → 独立复测通过 → 已关闭（带复测证据与复测者）",
  );
  ok(
    f6State.status === "fixed_pending_retest" && !ledger.blocking.includes(f6State),
    "①-4 只有修复自述 → 停在「已修复待复测」（不算通过、不关闭）",
  );
  ok(
    f7State.status === "false_positive" &&
      f7State.reviewer === "gpt-6" &&
      f7State.reviewer !== f7State.opened_by &&
      !ledger.blocking.includes(f7State),
    "①-4 误报要独立复核 + 理由；判误报后不再阻塞",
  );
  ok(
    f8State.status === "accepted_risk" &&
      f8State.acceptance?.accepted_by === "主人" &&
      f8State.acceptance.review_condition !== "" &&
      f8State.acceptance.scope_revision === codeRev1 &&
      !ledger.blocking.includes(f8State),
    "①-4 用户接受风险：记适用版本 + 复查条件 + 理由（不是永久免审），也不再算「必须拦截」",
  );
  ok(
    ledger.confirmed.length === 1 &&
      ledger.unverified.length === 1 &&
      ledger.false_positive.length === 1 &&
      ledger.duplicate.length === 1 &&
      ledger.fixed_pending_retest.length === 1 &&
      ledger.closed.length === 1 &&
      ledger.accepted_risk.length === 1,
    `①-4 台账七态分开列：已确认/未证实/误报/重复/待复测/已关闭/接受风险 = 1/1/1/1/1/1/1`,
  );
  ok(
    ledger.blocking.map((f) => f.finding_id).sort().join(",") === [f1.finding_id, f4.finding_id].sort().join(","),
    `①-4 拦住交付的只有「必须拦截且未收口」的两条（${ledger.blocking.map((f) => f.finding_id).join("、")}）`,
  );
  ok(
    findingIdOfFingerprint(f1State.dedupe_key) === f1.finding_id,
    "①-4 finding_id 由同类指纹派生（跨进程/跨会话算得出同一个 id）",
  );

  // ══════════════════════════ ① 坏现场必须暴露 ══════════════════════════
  info("── ① 坏现场必须暴露（fold 层负向：非法推进 / 悬空判重 / 身份伪造一律抛，不静默跳过）");
  const openPayload = { dedupe_key: sha256("neg"), severity: "user_visible_defect", source: "夹具", expected: "对的", actual: "错的" };
  const negativeCases: [string, RawEvent[]][] = [
    [
      "未证实的缺陷不能直接关闭",
      [
        mkEvent(1, "finding:f-neg1", "finding.opened", openPayload),
        mkEvent(2, "finding:f-neg1", "finding.transition", { to: "confirmed" }, { revision: 2 }),
        mkEvent(3, "finding:f-neg1", "finding.transition", { to: "closed", reviewer: "other" }, { revision: 3 }),
      ],
    ],
    [
      "误报由报告者自己判（要独立复核）",
      [
        mkEvent(1, "finding:f-neg2", "finding.opened", openPayload, { actor: "kimi-code" }),
        mkEvent(2, "finding:f-neg2", "finding.transition", { to: "false_positive", reviewer: "kimi-code", note: "我觉得不是" }, { revision: 2 }),
      ],
    ],
    [
      "复测者就是报告者（自己复测自己的缺陷）",
      [
        mkEvent(1, "finding:f-neg3", "finding.opened", { ...openPayload, repro: "能复现" }, { actor: "kimi-code" }),
        mkEvent(2, "finding:f-neg3", "finding.fix_submitted", { fix_revision: "r2" }, { revision: 2 }),
        mkEvent(3, "finding:f-neg3", "finding.retest_recorded", { retested_by: "kimi-code", retest_evidence: "abc", result: "pass" }, { revision: 3 }),
      ],
    ],
    [
      "接受风险由非用户身份提交",
      [
        mkEvent(1, "finding:f-neg4", "finding.opened", openPayload),
        mkEvent(2, "finding:f-neg4", "finding.accepted_risk", { accepted_by: "owner", basis: "算了", scope_revision: "r1", review_condition: "以后再看" }, { revision: 2, role: "coordinator" }),
      ],
    ],
    ["缺陷首条事件不是 opened", [mkEvent(1, "finding:f-neg5", "finding.transition", { to: "confirmed" })]],
    ["未知缺陷事件类型", [mkEvent(1, "finding:f-neg6", "finding.invented_thing", openPayload)]],
    ["悬空判重（duplicate_of 指向不存在的缺陷）", [mkEvent(1, "finding:f-neg7", "finding.opened", { ...openPayload, duplicate_of: "f-nope" })]],
  ];
  for (const [label, evts] of negativeCases) {
    const code = codeOf(() => foldFindings(evts as never));
    ok(code === "EVENT_INVALID", `①-5 坏现场暴露：${label} → EVENT_INVALID（实际 ${code || "没有报错"}）`);
  }
  const auditPrefixNeg = codeOf(() =>
    foldAuditRecords([mkEvent(1, "check:f-mix", "audit.fix_recorded", { finding_id: "f", fix_revision: "r", fixed_by: "x" })] as never),
  );
  ok(auditPrefixNeg === "EVENT_INVALID", `①-5 审计记录类型与实体前缀不匹配（把修复写进自检实体）→ EVENT_INVALID（实际 ${auditPrefixNeg || "没有报错"}）`);
  const findingGotAuditType = codeOf(() =>
    foldFindings([mkEvent(1, "finding:f-mix2", "audit.self_check_recorded", { checked_by: "kimi-code", checks: [] })] as never),
  );
  ok(findingGotAuditType === "EVENT_INVALID", `①-5 把审计事件写进缺陷实体 → EVENT_INVALID（实际 ${findingGotAuditType || "没有报错"}）`);

  // ══════════════════════════ ① 审计包与抽查包 ══════════════════════════
  info("── ① 审计包（§5.5 必含项）与高能力抽查包（含原文入口，作者摘要只是导航）");
  const auditPackage = buildAuditPackage({
    package_id: "pkg-fixture-1",
    batch_id: "sub-T-1-1",
    change_id: CHG,
    submission: records.submissions["sub-T-1-1"],
    coverage: records.independent_audits["audit-T-1-1"].coverage.map((c) => ({ ...c, source: "audit-T-1-1" })),
    self_checks: Object.values(records.self_checks),
    independent_audits: Object.values(records.independent_audits),
    fixes: Object.values(records.fixes),
    retests: Object.values(records.retests),
    findings: findingsForChain,
    risks: [{ code: "must_block_finding", text: "T-3 上有一条必须拦截缺陷未收口", severity_hint: "blocks_core_goal" }],
    deviations: ["无设计偏离"],
    known_limits: ["F8 由用户接受"],
    accepted_limits: ["F8"],
    evidence: manifest.map((m) => ({ evidence_id: m.evidence_id, recovery_path: m.recovery_path, kind: m.kind, summary: m.summary })),
    usage: { high_capability_calls: 1, input_tokens: 12000, elapsed_ms: 4200, measured_by: "本机计时", unknown_reason: null },
  });
  const packageItems = [
    auditPackage.goal_and_baseline.goal !== "",
    auditPackage.diff_and_raw.diff_sha256 === diffEvidence.sha256,
    auditPackage.risks.items.length > 0,
    auditPackage.coverage_matrix.length === 5,
    auditPackage.verification.commands.length > 0,
    auditPackage.findings.confirmed.length === 1 && auditPackage.findings.unverified.length === 1 && auditPackage.findings.false_positive.length === 1 && auditPackage.findings.duplicate.length === 1,
    auditPackage.fix_retest.some((f) => f.finding_id === f5.finding_id && f.retest_result === "pass" && f.retested_by !== f.fixed_by),
    auditPackage.design_deviations_and_limits.known_limits.length > 0,
    auditPackage.usage.high_capability_calls === 1,
  ];
  ok(
    packageItems.every((v) => v === true) && auditPackage.completeness.complete === true,
    `①-6 审计包九项必含项齐全（缺项 ${JSON.stringify(auditPackage.completeness.missing_items)}，未知项 ${JSON.stringify(auditPackage.completeness.unknown_items)}）`,
  );
  ok(
    auditPackage.author_summary_is_navigation_only === true &&
      auditPackage.raw_entry_points.length >= 3 &&
      auditPackage.raw_entry_points.some((r) => r.sha256 === diffEvidence.sha256) &&
      auditPackage.raw_entry_points.some((r) => r.locator.includes("evidence/")),
    `①-6 审计包带原文入口（${auditPackage.raw_entry_points.length} 处，作者摘要只是导航）`,
  );
  const incomplete = buildAuditPackage({
    package_id: "pkg-incomplete",
    batch_id: "sub-T-1-1",
    submission: records.submissions["sub-T-1-1"],
    coverage: [],
    findings: findingsForChain,
  });
  ok(
    incomplete.completeness.complete === false && incomplete.completeness.missing_items.includes("coverage_matrix"),
    `①-6 缺必含项如实标不完整（缺 ${JSON.stringify(incomplete.completeness.missing_items)}）`,
  );
  const spot = buildSpotCheckPackage({
    spot_check_id: "spot-1",
    seed: "batch-1",
    sources: [
      { locator: "src/base.ts", sha256: sha256(read(path.join(mainRoot, "src", "base.ts"))) },
      { locator: "src/wall.ts", sha256: sha256(read(path.join(mainRoot, "src", "wall.ts"))) },
      { locator: "src/paint.ts", sha256: sha256(read(path.join(mainRoot, "src", "paint.ts"))) },
    ],
    user_paths: [{ locator: "场景：地基水平与压实" }],
    unreported_areas: [{ locator: "src/plaster.ts（尚未实现）" }],
    per_area: 2,
    now: "2026-09-20T02:00:00+08:00",
  });
  const spotAgain = buildSpotCheckPackage({
    spot_check_id: "spot-1",
    seed: "batch-1",
    sources: [
      { locator: "src/paint.ts", sha256: null },
      { locator: "src/wall.ts", sha256: null },
      { locator: "src/base.ts", sha256: null },
    ],
    user_paths: [{ locator: "场景：地基水平与压实" }],
    unreported_areas: [{ locator: "src/plaster.ts（尚未实现）" }],
    per_area: 2,
    now: "2026-09-20T02:00:00+08:00",
  });
  ok(
    spot.selection.length > 0 &&
      spot.selection.some((s) => s.area === "unreported") &&
      spot.raw_entry_points.some((r) => r.sha256 !== null) &&
      spot.author_summary_is_navigation_only === true,
    `①-6 抽查包按种子选点并给原文入口（${spot.selection.map((s) => s.area + ":" + s.locator).join(" / ")}）`,
  );
  ok(
    JSON.stringify(spot.selection) === JSON.stringify(spotAgain.selection),
    "①-6 抽查选点可复现：同种子同范围（不随作者给的顺序变化）",
  );
  ok(
    codeOf(() => {
      const assertComplete = (p: typeof incomplete) => {
        if (!p.completeness.complete) throw Object.assign(new Error("incomplete"), { code: "INVALID_COMMAND" });
      };
      assertComplete(incomplete);
    }) === "INVALID_COMMAND",
    "①-6 审计包不完整时不能交终审（缺项被拦，不靠作者摘要代替证据）",
  );

  // ══════════════════════════ ② 状态规则 ══════════════════════════
  info("── ②-1 §4.2 六态与优先级：未知 → 问题/阻塞 → 进行中 → 待验证 → 全部通过 → 未开始");
  ok(
    JSON.stringify([...DISPLAY_STATUS_PRIORITY]) === JSON.stringify(["unknown", "blocked", "in_progress", "pending_verification", "verified", "planned"]),
    `②-1 优先级顺序与 §4.2 原文一致：${DISPLAY_STATUS_PRIORITY.join(" → ")}`,
  );
  ok(
    Object.values(DISPLAY_STATUS_LABELS).every((v) => v !== undefined) &&
      DISPLAY_STATUS_LABELS.planned.includes("灰") &&
      DISPLAY_STATUS_LABELS.in_progress.includes("蓝") &&
      DISPLAY_STATUS_LABELS.pending_verification.includes("橙") &&
      DISPLAY_STATUS_LABELS.verified.includes("绿") &&
      DISPLAY_STATUS_LABELS.blocked.includes("红") &&
      DISPLAY_STATUS_LABELS.unknown.includes("中性"),
    "②-1 六态色与语义齐全（灰/蓝/橙/绿/红/中性虚线）",
  );
  const find1 = f1.finding_id;
  const sixInput = (graphRevision: { graph: string; current: string } | null) => ({
    objects: [
      taskObject("S-planned", ["S-planned::c0"], []),
      taskObject("S-progress", ["S-progress::c0"], [], {
        executions: [{ task_id: "S-progress", status: "executing", actor_id: "kimi-code", updated_at: "2026-09-20T01:00:00+08:00" }],
      }),
      taskObject("S-pending", ["S-pending::c0"], [], {
        executions: [{ task_id: "S-pending", status: "result_submitted", actor_id: "kimi-code", updated_at: "2026-09-20T01:00:00+08:00" }],
      }),
      taskObject("S-verified", ["S-verified::c0"], [], {
        executions: [{ task_id: "S-verified", status: "result_submitted", actor_id: "kimi-code", updated_at: "2026-09-20T01:00:00+08:00" }],
      }),
      taskObject("S-blocked", ["S-blocked::c0"], [find1], {
        executions: [{ task_id: "S-blocked", status: "result_submitted", actor_id: "kimi-code", updated_at: "2026-09-20T01:00:00+08:00" }],
      }),
    ],
    findings: findingsForChain,
    checks: [
      passingCheck("S-verified::c0", "S-verified"),
      passingCheck("S-blocked::c0", "S-blocked"),
    ],
    graph_revision: graphRevision,
  });
  const six = projectStatuses(sixInput(null));
  const sixStale = projectStatuses(sixInput({ graph: sha256("blueprint-v1").slice(0, 8), current: sha256("blueprint-v2").slice(0, 8) }));
  const st = (id: string) => six.by_id[id].display_status;
  ok(st("S-planned") === "planned", `②-1 灰：已规划未开始（S-planned=${st("S-planned")}）`);
  ok(st("S-progress") === "in_progress", `②-1 蓝：正在实现（S-progress=${st("S-progress")}）`);
  ok(st("S-pending") === "pending_verification", `②-1 橙：已交成果、必需检查不齐（S-pending=${st("S-pending")}）`);
  ok(st("S-verified") === "verified", `②-1 绿：必需验收项都有当前有效通过证据（S-verified=${st("S-verified")}）`);
  ok(st("S-blocked") === "blocked", `②-1 红：有已确认问题影响该对象（S-blocked=${st("S-blocked")}）`);
  ok(
    st("S-verified") === "verified" && six.summary.counts.verified === 1 && six.summary.counts.planned === 1,
    `②-1 六态计数如实：planned=${six.summary.counts.planned} / in_progress=${six.summary.counts.in_progress} / pending=${six.summary.counts.pending_verification} / verified=${six.summary.counts.verified} / blocked=${six.summary.counts.blocked}`,
  );
  const stStale = (id: string) => sixStale.by_id[id].display_status;
  ok(
    stStale("S-verified") === "unknown" && stStale("S-progress") === "unknown" && stStale("S-planned") === "unknown",
    `②-1 图版本落后 → 进「未知」（S-verified=${stStale("S-verified")}、S-progress=${stStale("S-progress")}、S-planned=${stStale("S-planned")}），不伪造执行状态`,
  );
  ok(
    sixStale.by_id["S-blocked"].reasons.some((r) => r.code === "blocking_finding") &&
      sixStale.by_id["S-blocked"].open_findings.length === 1 &&
      sixStale.by_id["S-blocked"].quality === "has_findings",
    "②-1 未知不抹掉已知问题：状态是 unknown，但缺陷仍在 reasons/open_findings/quality 里",
  );
  ok(
    sixStale.by_id["S-blocked"].overlays.includes("stale_overlay") &&
      sixStale.by_id["S-blocked"].display_status === "unknown",
    "②-1 陈旧图叠加版本提示（overlays 带 stale_overlay），不用陈旧图伪造执行状态",
  );

  const noGraph = projectStatuses({
    objects: [
      taskObject("N-progress", ["N-progress::c0"], [f1.finding_id], {
        executions: [{ task_id: "N-progress", status: "executing", actor_id: "kimi-code", updated_at: "2026-09-20T01:00:00+08:00" }],
      }),
    ],
    findings: findingsForChain,
    checks: [],
  });
  ok(
    noGraph.by_id["N-progress"].display_status === "blocked" && noGraph.by_id["N-progress"].execution === "in_progress",
    `②-1 优先级：明确问题/阻塞压过进行中（${noGraph.by_id["N-progress"].display_status}，execution=${noGraph.by_id["N-progress"].execution}）`,
  );
  ok(
    codesOf(noGraph.by_id["N-progress"]).includes("executing") && codesOf(noGraph.by_id["N-progress"]).includes("blocking_finding"),
    "②-1 红与蓝的原因都保留（主状态只选一个，各维度计数不丢）",
  );
  ok(
    NO_COMPLETION_PERCENT.includes("不用节点数") &&
      !("percent" in six.summary) &&
      !("completion" in six.summary) &&
      Object.keys(six.summary.counts).length === 6,
    "②-1 输出只有计数与缺口，没有百分比字段（不用节点数算虚假完成百分比）",
  );

  info("── ②-2 父子状态：所有必需子项 + 自身集成检查");
  const parentInput = (opts: { childMissing?: boolean; integration?: boolean }) =>
    projectStatuses({
      objects: [
        taskObject("C1", ["C1::c0"], [], { parent_id: "P" }),
        taskObject("C2", ["C2::c0"], [], { parent_id: "P" }),
        {
          object_id: "P",
          object_kind: "module",
          label: "模块 P",
          children_ids: ["C1", "C2"],
          integration_checks: opts.integration ? [{ check_id: "P::integration", label: "模块内集成检查" }] : [],
          revisions: { code: codeRev1 },
        },
      ],
      findings: [],
      checks: [
        passingCheck("C1::c0", "C1", { evidence_sha256: opts.childMissing ? null : auditOut.sha256, result: opts.childMissing ? "failed" : "passed" }),
        passingCheck("C2::c0", "C2"),
        ...(opts.integration ? [passingCheck("P::integration", "P")] : []),
      ],
    });
  const pBoth = parentInput({ integration: true });
  const pNoIntegration = parentInput({ integration: false });
  const pChildRed = parentInput({ childMissing: true, integration: true });
  ok(
    pBoth.by_id["P"].display_status === "verified" && pBoth.by_id["P"].required_count === 3,
    `②-2 父级全绿 = 所有必需子项 + 自身集成检查都过（required=${pBoth.by_id["P"].required_count}，状态 ${pBoth.by_id["P"].display_status}）`,
  );
  ok(
    pNoIntegration.by_id["P"].display_status !== "verified" &&
      pNoIntegration.by_id["P"].missing.some((m) => m.check_id.endsWith("::integration")),
    `②-2 子项全绿但父级没有自身集成检查 → 不算集成通过（状态 ${pNoIntegration.by_id["P"].display_status}，缺 ${pNoIntegration.by_id["P"].missing.map((m) => m.check_id).join("、")}）`,
  );
  ok(
    pChildRed.by_id["P"].display_status !== "verified" &&
      pChildRed.by_id["P"].missing.some((m) => m.check_id === "C1::c0") &&
      pChildRed.by_id["P"].passed_count === 2,
    `②-2 任一必需子项未过 → 父级不绿（缺失项点名到子检查 ${pChildRed.by_id["P"].missing.map((m) => m.check_id).join("、")}）`,
  );
  ok(
    pBoth.by_id["P"].scope.verified_scope.length === 3,
    "②-2 绿要能说清验证范围（父级逐项列出子项与集成检查）",
  );
  const cycle = codeOf(() =>
    projectStatuses({
      objects: [
        { object_id: "A", object_kind: "module", label: "A", children_ids: ["B"] },
        { object_id: "B", object_kind: "module", label: "B", children_ids: ["A"] },
      ],
      findings: [],
      checks: [],
    }),
  );
  ok(cycle === "INVALID_COMMAND", `②-2 父级/子项成环 → 拒绝（实际 ${cycle || "没有报错"}）`);

  info("── ②-3 连线：集成线要自己的证据；依赖线只看前置是否满足；静态引用线不着完成色");
  const edgeSet = projectStatuses({
    objects: [
      taskObject("A", ["A::c0"], [], { object_kind: "module", parent_id: null }),
      taskObject("B", ["B::c0"], [], { object_kind: "module", parent_id: null }),
      {
        object_id: "A->B::integration",
        object_kind: "edge",
        label: "A → B 集成线",
        edge: { edge_kind: "integration", from: "A", to: "B" },
        required_checks: [{ check_id: "A->B::integration::c0", label: "跨模块集成证据" }],
        revisions: { code: codeRev1 },
      },
      {
        object_id: "B->C::dep",
        object_kind: "edge",
        label: "B → C 施工依赖线",
        edge: {
          edge_kind: "dependency",
          from: "B",
          to: "C",
          prerequisite_released: false,
          prerequisite_result_submitted: true,
          prerequisite_reasons: ["前置只自报交了结果（done ≠ 验证/审计通过）"],
        },
        required_checks: [{ check_id: "B->C::dep::prerequisite", label: "前置 B 交付满足" }],
        revisions: { code: codeRev1 },
      },
      {
        object_id: "ref::static",
        object_kind: "edge",
        label: "静态引用线",
        edge: { edge_kind: "static_reference", from: "A", to: "B" },
        required_checks: [{ check_id: "ref::static::c0", label: "静态引用" }],
        revisions: { code: codeRev1 },
      },
    ],
    findings: [],
    checks: [passingCheck("A::c0", "A"), passingCheck("B::c0", "B")],
  });
  ok(
    edgeSet.by_id["A"].display_status === "verified" && edgeSet.by_id["B"].display_status === "verified" && edgeSet.by_id["A->B::integration"].display_status !== "verified",
    `②-3 两个端点绿不代表连线绿（A=${edgeSet.by_id["A"].display_status}、B=${edgeSet.by_id["B"].display_status}、集成线=${edgeSet.by_id["A->B::integration"].display_status}）`,
  );
  ok(
    edgeSet.by_id["A->B::integration"].missing.some((m) => m.check_id === "A->B::integration::c0"),
    "②-3 集成线缺自己的关系/集成证据时点名到具体检查（不借端点绿灯）",
  );
  ok(
    edgeSet.by_id["B->C::dep"].display_status === "pending_verification" &&
      codesOf(edgeSet.by_id["B->C::dep"]).includes("missing_evidence") &&
      edgeSet.by_id["B->C::dep"].quality === "unverified",
    `②-3 依赖线未释放 → 待验证（${edgeSet.by_id["B->C::dep"].display_status}），理由带前置判据`,
  );
  ok(
    edgeSet.by_id["ref::static"].display_status === null && edgeSet.by_id["ref::static"].display_status_label === null,
    "②-3 纯静态引用线不着完成色（display_status = null，保持来源样式）",
  );

  info("── ②-4 证据版本复核：源变了旧绿转待验证并保留历史（只重验影响范围）");
  const staleCode = projectStatuses({
    objects: [
      taskObject("R-code", ["R-code::c0"], [], { revisions: { code: codeRev2, plan: planRev } }),
      taskObject("R-plan", ["R-plan::c0"], [], { revisions: { code: codeRev1, plan: planRev } }),
    ],
    findings: [],
    checks: [
      passingCheck("R-code::c0", "R-code"),
      passingCheck("R-plan::c0", "R-plan", { binding: { revision_kind: "plan", revision: planRev } }),
    ],
    changes: [{ change_id: "chg-code-2", revision_kind: "code", from: codeRev1, to: codeRev2, affected: ["R-code"] }],
  });
  const rCode = staleCode.by_id["R-code"];
  const rPlan = staleCode.by_id["R-plan"];
  ok(
    rCode.display_status === "pending_verification" && rCode.quality === "evidence_invalid" && rCode.freshness === "verification_stale",
    `②-4 代码版本变了 → 旧绿转待验证（R-code=${rCode.display_status}，quality=${rCode.quality}）`,
  );
  ok(
    rCode.history.length === 1 &&
      rCode.history[0].check_id === "R-code::c0" &&
      rCode.history[0].bound_revision === codeRev1 &&
      rCode.history[0].superseded_by.includes(codeRev2),
    `②-4 旧结论保留在历史里（${rCode.history[0]?.check_id} 绑 ${short(rCode.history[0]?.bound_revision)} → 被 ${short(rCode.history[0]?.superseded_by)} 取代）`,
  );
  ok(
    rPlan.display_status === "verified" && rPlan.history.length === 0,
    `②-4 源变了只重验影响范围：未受影响的 R-plan 保持绿（${rPlan.display_status}），不被连坐`,
  );
  const scope = impactScope(
    [{ change_id: "chg-code-2", revision_kind: "code", from: codeRev1, to: codeRev2, affected: ["R-code"] }],
    ["R-code", "R-plan", "R-other"],
  );
  ok(
    scope.affected.join(",") === "R-code" && scope.unaffected.join(",") === "R-other,R-plan",
    `②-4 impactScope 只圈受影响对象（affected=${scope.affected.join("、")} / unaffected=${scope.unaffected.join("、")}）`,
  );
  const scopeUnknown = impactScope(
    [{ change_id: "chg-interface", revision_kind: "interface", from: "i1", to: "i2", affected: "unknown" }],
    ["R-code", "R-plan", "R-other"],
  );
  ok(
    scopeUnknown.unknown.length === 3 && scopeUnknown.affected.length === 0 && scopeUnknown.unaffected.length === 0,
    `②-4 影响待查的对象单独成组（unknown=${scopeUnknown.unknown.length} 个）：不当"确认不受影响"，也不当"已判定受影响"`,
  );
  const unknownImpact = projectStatuses({
    objects: [taskObject("U1", ["U1::c0"], [], { revisions: { code: codeRev1 } })],
    findings: [],
    checks: [passingCheck("U1::c0", "U1")],
    changes: [{ change_id: "chg-interface", revision_kind: "interface", from: "i1", to: "i2", affected: "unknown" }],
  });
  ok(
    unknownImpact.by_id["U1"].display_status === "unknown" &&
      unknownImpact.by_id["U1"].freshness === "impact_unknown" &&
      codesOf(unknownImpact.by_id["U1"]).includes("impact_unknown"),
    `②-4 影响不确定时不默认通过（U1=${unknownImpact.by_id["U1"].display_status}，freshness=${unknownImpact.by_id["U1"].freshness}）`,
  );

  info("── ②-5 依赖释放：不看前卡自报 done；风险升级按后果");
  const depSet = projectStatuses({
    objects: [
      taskObject("PR", ["PR::c0"], [], {
        executions: [{ task_id: "PR", status: "result_submitted", actor_id: "kimi-code", updated_at: "2026-09-20T01:00:00+08:00" }],
      }),
      taskObject("PR-verified", ["PRV::c0"], [], {
        executions: [{ task_id: "PR-verified", status: "result_submitted", actor_id: "kimi-code", updated_at: "2026-09-20T01:00:00+08:00" }],
      }),
    ],
    findings: [],
    checks: [passingCheck("PRV::c0", "PR-verified", { actor_id: "kimi-code" })],
  });
  ok(
    depSet.by_id["PR-verified"].quality === "mechanical_passed" &&
      codesOf(depSet.by_id["PR-verified"]).includes("self_check_only"),
    `②-5 作者本人自报的「独立」检查被降级为作者自检（quality=${depSet.by_id["PR-verified"].quality}）：作者自报不是独立审计`,
  );
  const relSelfReported = dependencyRelease({ prerequisite_id: "PR", prerequisite: depSet.by_id["PR"] });
  const relVerified = dependencyRelease({ prerequisite_id: "PR-verified", prerequisite: depSet.by_id["PR-verified"] });
  ok(
    relSelfReported.released === false &&
      relSelfReported.self_reported_only === true &&
      relSelfReported.reasons.some((r) => r.includes("done ≠ 验证/审计通过")),
    `②-5 前置只自报交结果 → 不释放（${relSelfReported.reasons[0]}）`,
  );
  ok(
    relVerified.released === true && relVerified.caveats.some((c) => c.includes("作者自检")),
    `②-5 前置必需验收真过了 → 释放（并如实提示「通过项全来自作者自检」）`,
  );
  const relVersionMismatch = dependencyRelease({
    prerequisite_id: "PR-verified",
    prerequisite: depSet.by_id["PR-verified"],
    required_input_revision: { revision_kind: "plan", revision: planRev },
    prerequisite_input_revision: { revision_kind: "plan", revision: sha256("old-plan") },
  });
  ok(
    relVersionMismatch.released === false && relVersionMismatch.reasons.some((r) => r.includes("输入版本")),
    "②-5 前置输入版本不是依赖方要的那份 → 不释放（依赖不只是「前卡 done」）",
  );
  const riskLow = escalateRisk({ findings: [], change_natures: ["ordinary"] });
  const riskMustBlock = escalateRisk({ findings: [f1State], change_natures: ["ordinary"] });
  const riskMigration = escalateRisk({ findings: [], change_natures: ["data_migration"] });
  const riskGap = escalateRisk({ findings: [], evidence_gaps: ["没查到并发场景"], change_natures: ["ordinary"] });
  ok(
    riskLow.level === "normal" && riskMustBlock.level === "high" && riskMustBlock.must_block === true && riskMustBlock.require_high_capability_review === true,
    `②-5 必须拦截后果 → 风险升级到 high 并要求高能力检查（${riskLow.level} → ${riskMustBlock.level}）`,
  );
  ok(
    riskMigration.level === "high" && riskMigration.reasons.some((r) => r.code.startsWith("critical_change:")),
    "②-5 数据迁移/关键接口/权限边界按 §5.5 升级（不论改了几行）",
  );
  ok(
    riskGap.level === "elevated" && riskGap.require_independent_audit === true && riskGap.require_high_capability_review === false,
    `②-5 有证据缺口 → 至少 elevated 并要求独立审计（${riskGap.level}）`,
  );
  ok(
    escalateRisk({ findings: [], change_natures: ["ordinary"], blast_radius_modules: 1 }).level === "normal" &&
      escalateRisk({ findings: [], change_natures: ["ordinary"], blast_radius_modules: 4 }).level === "elevated",
    "②-5 波及面影响升级（1 个模块 normal，4 个模块 elevated）",
  );
  ok(
    escalateRisk({ findings: [f1State], change_natures: ["ordinary"], reversible: false, unfamiliar: true }).reasons.every((r) => !JSON.stringify(r).match(/行数|lines|模型|model|brand/i)),
    "②-5 风险判据里没有「改动行数/模型品牌」这类输入（后果/波及面/可逆性/陌生程度/证据缺口）",
  );
  ok(
    escalateRisk({ ...({ lines_changed: 9999, model_brand: "随便什么模型" } as object), findings: [], change_natures: ["ordinary"] }).level === riskLow.level,
    "②-5 塞进「改动行数/模型品牌」不改变风险等级（判据不接受这两个输入）",
  );

  info("── ②-6 §4.2 尾部口径：有效运行消失只改观测状态；抽查不是全量证明；状态变更留来源与时间");
  const withRun = projectStatuses({
    objects: [
      taskObject("V-run", ["V-run::c0"], [], {
        executions: [{ task_id: "V-run", status: "executing", actor_id: "kimi-code", updated_at: "2026-09-20T01:00:00+08:00" }],
      }),
    ],
    findings: [],
    checks: [passingCheck("V-run::c0", "V-run")],
  });
  const withoutRun = projectStatuses({
    objects: [taskObject("V-run", ["V-run::c0"], [], { executions: [] })],
    findings: [],
    checks: [passingCheck("V-run::c0", "V-run")],
  });
  ok(
    withRun.by_id["V-run"].execution === "in_progress" &&
      withoutRun.by_id["V-run"].execution === "not_started" &&
      withoutRun.by_id["V-run"].quality === withRun.by_id["V-run"].quality &&
      withoutRun.by_id["V-run"].display_status === "verified",
    `②-6 有效运行消失只改变观测状态（execution ${withRun.by_id["V-run"].execution} → ${withoutRun.by_id["V-run"].execution}），质量不因此变失败（quality ${withoutRun.by_id["V-run"].quality}）`,
  );
  ok(
    spot.statement.includes("不是全量证明") &&
      auditPackage.author_summary_is_navigation_only === true &&
      incomplete.completeness.missing_items.length > 0,
    `②-6 抽查包写明边界（「${spot.statement.slice(0, 24)}…」）：未发现问题只表示在所述范围与方法内未发现`,
  );
  ok(
    f1State.history.length >= 2 &&
      f1State.history.every((h) => h.at !== "" && h.actor !== "" && h.status !== undefined),
    `②-6 缺陷推进历史保留来源与时间（${f1State.history.length} 条，每条含 at/actor/status）`,
  );

  info("── ③ 八个预置场景（逐个断言状态与原因）");
  // 真实事实 → 投影（两趟：先算依赖释放，再让依赖线带上释放结论）
  // V09-29/F4：**产品默认** `revisions.code = null`——不拿账本自报的 code 修订当"当前代码版本"，
  // 于是无源清单的 code 检查一律 unknown，"父级全绿/四色派生"就无从成立。本节验证的是**投影规则本身**，
  // 故用契约明确允许的**显式测试覆盖** `opts.code_revision`（= 夹具自己绑的 codeRev1，检查绑定与之一致）——
  // 这不是恢复旧自报：产品读口（HTTP/entry）仍默认 null、无源清单的 code 检查仍待复核，见 ④-3。
  const facts = collectProjectFacts(MAIN, dataDir, { code_revision: codeRev1 });
  const baseChecks = checksFromAudit(facts.audit);
  const pass1Objects = objectsFromFacts(MAIN, dataDir, facts);
  const pass1 = projectStatuses({ objects: pass1Objects, findings: facts.findings, checks: baseChecks, source_revision: facts.revisions });
  const releases: Record<string, { released: boolean; reasons: string[] }> = {};
  for (const def of facts.definitions) {
    for (const dep of def.dependency_ids) {
      const edgeId = `${dep}->${def.task_id}`;
      const prereq = pass1.by_id[dep];
      if (prereq === undefined) continue;
      releases[edgeId] = dependencyRelease({
        prerequisite_id: dep,
        prerequisite: prereq,
        evidence_requirement: def.dependency_evidence.find((d) => d.dependency_id === dep)?.evidence ?? null,
      });
    }
  }
  const integrationEdge: StatusObjectInput = {
    object_id: "module:paint->module:base::integration",
    object_kind: "edge",
    label: "paint → base 集成线",
    edge: { edge_kind: "integration", from: "module:paint", to: "module:base" },
    required_checks: [{ check_id: "module:paint->module:base::integration::c0", label: "跨模块数据链路证据" }],
    revisions: { code: codeRev1 },
  };
  const realObjects = objectsFromFacts(MAIN, dataDir, facts, {
    dependency_releases: releases,
    module_integration_checks: { paint: [{ check_id: "module:paint::integration", label: "模块内集成检查" }] },
    extra_edges: [integrationEdge],
  });
  const realChecks = [...baseChecks, passingCheck("module:paint::integration", "module:paint")];
  const real = projectStatuses({
    objects: realObjects.map((o) => ({
      ...o,
      acceptance: o.object_kind === "task" ? acceptanceDimensionOf(Object.values(facts.audit.acceptances), { task_id: o.object_id }) : "pending",
    })),
    findings: facts.findings,
    checks: realChecks,
    source_revision: facts.revisions,
  });
  info(`  真实投影（两趟含依赖释放）：${statuses(real)}`);

  // ③-1 预置缺陷
  const s1 = real.by_id["T-3"];
  ok(
    s1.display_status === "blocked" &&
      s1.quality === "has_findings" &&
      codesOf(s1).includes("blocking_finding") &&
      s1.open_findings.some((f) => f.finding_id === f1.finding_id && f.must_block) &&
      codesOf(s1).includes("open_finding"),
    `③-1 预置缺陷：T-3 = ${s1.display_status}（必须拦截的已确认缺陷 + 未证实的必须拦截风险）；原因 ${codesOf(s1).join("、")}`,
  );
  ok(
    s1.open_findings.some((f) => f.finding_id === f4.finding_id && f.unverified === true) &&
      s1.reasons.some((r) => r.text.includes("风险未排除")),
    "③-1 未证实的必须拦截风险同样拦住交付，且原因里写明「未证实/风险未排除」",
  );

  // ③-2 重复 finding
  ok(
    f1again.deduped === true && fm[f1.finding_id].reports === 2 &&
      Object.values(fm).filter((s) => s.finding_id !== f3.finding_id && s.dedupe_key === f1State.dedupe_key).length === 1,
    `③-2 重复 finding（同因重复上报）：归并到同一条（reports=${fm[f1.finding_id].reports}），不新增缺陷`,
  );
  const s2 = real.by_id["T-2"];
  ok(
    fm[f3.finding_id].status === "duplicate" &&
      s2.open_findings.length === 0 &&
      s2.display_status !== "blocked" &&
      s2.display_status === "pending_verification",
    `③-2 判重的缺陷（severity=data_loss）不把 T-2 染红：T-2 = ${s2.display_status}，open_findings=${s2.open_findings.length}`,
  );

  // ③-3 无证据 done
  ok(
    s2.execution === "result_submitted" &&
      s2.display_status === "pending_verification" &&
      s2.passed_count === 0 &&
      s2.missing_count === 3 &&
      s2.quality === "unverified" &&
      codesOf(s2).includes("missing_evidence"),
    `③-3 无证据 done：T-2 执行=${s2.execution}、状态=${s2.display_status}、必需 ${s2.required_count} 项通过 ${s2.passed_count} 项（缺 ${s2.missing_count} 项）；quality=${s2.quality}`,
  );
  ok(
    s2.missing.map((m) => m.check_id).join(",") === "T-2::check:0,T-2::check:1,T-2::evidence",
    `③-3 缺哪项逐个点名：${s2.missing.map((m) => m.check_id).join("、")}`,
  );

  // ③-4 陈旧代码版本
  const staleSet = projectStatuses({
    objects: [
      taskObject("T-1", ["T-1::check:0", "T-1::check:1", "T-1::evidence"], [], { revisions: { code: codeRev2, plan: planRev } }),
      taskObject("T-4", ["T-4::check:0", "T-4::evidence"], [], { revisions: { code: codeRev1, plan: planRev } }),
    ],
    findings: [],
    checks: baseChecks.filter((c) => c.object_id === "T-1" || c.object_id === "T-4"),
    changes: [{ change_id: "chg-code-2", revision_kind: "code", from: codeRev1, to: codeRev2, affected: ["T-1"] }],
  });
  const s4 = staleSet.by_id["T-1"];
  ok(
    s4.display_status === "pending_verification" &&
      s4.quality === "evidence_invalid" &&
      s4.freshness === "verification_stale" &&
      codesOf(s4).includes("evidence_stale"),
    `③-4 陈旧代码版本：T-1 = ${s4.display_status}（quality=${s4.quality}、freshness=${s4.freshness}），原因含 evidence_stale`,
  );
  ok(
    s4.history.length === 3 && s4.history.every((h) => h.bound_revision === codeRev1),
    `③-4 旧绿的历史全部保留（${s4.history.length} 条被取代的通过记录，不是删掉重算）`,
  );
  ok(
    staleSet.by_id["T-4"].display_status === "verified" && staleSet.by_id["T-4"].history.length === 0,
    `③-4 源变了只重验影响范围：不在影响范围内的 T-4 仍是 ${staleSet.by_id["T-4"].display_status}`,
  );
  ok(
    s4.recheck_scope.join(",") === "T-1" && staleSet.by_id["T-4"].recheck_scope.length === 0,
    `③-4 重验范围只圈 T-1（recheck_scope=${s4.recheck_scope.join("、")}；T-4 为空）`,
  );

  // ③-5 空任务父级
  const emptyParent = projectStatuses({
    objects: [
      { object_id: "module:empty", object_kind: "module", label: "没有任务映射的模块", children_ids: [], revisions: { code: codeRev1 } },
      {
        object_id: "module:empty-children",
        object_kind: "module",
        label: "子项没有验收映射的模块",
        children_ids: ["NC1"],
        revisions: { code: codeRev1 },
      },
      taskObject("NC1", [], [], { parent_id: "module:empty-children" }),
    ],
    findings: [],
    checks: [],
  });
  const s5a = emptyParent.by_id["module:empty"];
  const s5b = emptyParent.by_id["module:empty-children"];
  ok(
    s5a.mapping === "unmapped" && s5a.required_count === 0 && s5a.display_status === "planned" && codesOf(s5a).includes("unmapped"),
    `③-5 空任务父级：${s5a.object_id} 显示未映射（mapping=${s5a.mapping}，状态 ${s5a.display_status}，required=${s5a.required_count}）`,
  );
  ok(
    s5b.mapping === "unmapped" && s5b.display_status !== "verified" && s5b.required_count === 0,
    `③-5 子项没有验收映射的父级同样不绿（${s5b.object_id}：mapping=${s5b.mapping}、状态 ${s5b.display_status}）`,
  );
  ok(
    emptyParent.summary.unmapped.length === 3 &&
      emptyParent.objects.every((o) => o.mapping !== "mapped" || o.required_count > 0),
    "③-5 不空集判绿：没有必需项的对象一个都没有被算成通过（unmapped 计数进 summary）",
  );
  ok(
    real.by_id["module:paint"].mapping === "mapped" && real.by_id["module:paint"].required_count > 0,
    `③-5 有映射的对象才进"已映射"（module:paint required=${real.by_id["module:paint"].required_count}）`,
  );

  // ③-6 存在正在做 + 旧问题
  ok(
    s1.execution === "in_progress" &&
      s1.display_status === "blocked" &&
      fm[f6.finding_id].status === "fixed_pending_retest" &&
      s1.open_findings.some((f) => f.finding_id === f6.finding_id) &&
      codesOf(s1).includes("executing"),
    `③-6 正在做 + 旧问题：T-3 执行=${s1.execution}，主状态 ${s1.display_status}（红压蓝），原因同时含 executing 与问题项`,
  );
  ok(
    s1.reasons.some((r) => r.text.includes("已修复待复测")) || s1.reasons.some((r) => r.text.includes("fixed_pending_retest")),
    "③-6 「已修复待复测」的旧问题仍在对象上，不算收口",
  );

  // ③-7 多前置集成
  const s7 = real.by_id["module:paint"];
  const s7b = real.by_id["module:base"];
  const s7edge = real.by_id["module:paint->module:base::integration"];
  const s7dep = real.by_id["T-2->T-3"];
  ok(
    s7.display_status === "verified" && s7.required_count === 3,
    `③-7 模块（父级）全绿 = 所有必需子项 + 自身集成检查（module:paint=${s7.display_status}，required=${s7.required_count}）`,
  );
  ok(
    s7edge.display_status !== "verified" && s7edge.missing.length > 0,
    `③-7 两端绿不自动证明连线绿：集成线 ${s7edge.object_id} = ${s7edge.display_status}（缺 ${s7edge.missing.map((m) => m.check_id).join("、")}）`,
  );
  ok(
    s7b.display_status !== "verified" &&
      s7b.missing.some((m) => m.check_id === "module:base::integration") &&
      s7b.passed_count === 3,
    `③-7 父级没有自身集成检查 → 子项全过也不绿（module:base=${s7b.display_status}，缺 ${s7b.missing.map((m) => m.check_id).join("、")}）`,
  );
  ok(
    real.by_id["module:wall"].display_status === "blocked" &&
      real.by_id["module:wall"].reasons.some((r) => r.code === "blocking_finding" && r.text.includes("继承自必需子项")),
    `③-7 父级不因为缺陷挂在子任务上就看不见：module:wall=${real.by_id["module:wall"].display_status}（原因标注继承自必需子项）`,
  );
  ok(
    s7dep.display_status === "pending_verification" &&
      codesOf(s7dep).includes("missing_evidence") &&
      (s7dep.missing[0]?.why ?? "").includes("done ≠ 验证/审计通过"),
    `③-7 多前置里的依赖线只看前置是否满足（T-2->T-3=${s7dep.display_status}）：${s7dep.missing[0]?.why ?? ""}`,
  );
  ok(
    s7dep.passed_count === 0 && s7dep.required_count === 1,
    "③-7 依赖线未释放时不给通过计数（前置自报 done 不等于依赖满足）",
  );
  const releasedEdge = real.by_id["T-1->T-2"];
  ok(
    releasedEdge.display_status === "verified" &&
      releasedEdge.missing_count === 0 &&
      codesOf(releasedEdge).some((c) => c === "prerequisite_caveat"),
    `③-7 前置真达标才释放（T-1->T-2=${releasedEdge.display_status}），并把前置的已接受限制如实提示`,
  );

  // ③-8 接受限制仍有缺陷
  const limitSet = projectStatuses({
    objects: [
      taskObject("T-1", ["T-1::check:0", "T-1::check:1", "T-1::evidence"], [f8.finding_id, f5.finding_id], {
        revisions: { code: codeRev1, plan: planRev },
        acceptance: "accepted_known_limit",
      }),
      taskObject("T-4", ["T-4::check:0", "T-4::evidence"], [], { revisions: { code: codeRev1, plan: planRev } }),
    ],
    findings: findingsForChain,
    checks: baseChecks.filter((c) => c.object_id === "T-1" || c.object_id === "T-4"),
  });
  const s8 = limitSet.by_id["T-1"];
  ok(
    s8.passed_count === s8.required_count &&
      s8.missing_count === 0 &&
      s8.display_status === "pending_verification" &&
      codesOf(s8).includes("accepted_limit_not_green"),
    `③-8 接受限制仍有缺陷：T-1 必需项全过（${s8.passed_count}/${s8.required_count}）但状态仍是 ${s8.display_status}（不染绿）`,
  );
  ok(
    s8.overlays.includes("accepted_known_limit") &&
      s8.acceptance === "accepted_known_limit" &&
      s8.open_findings.some((f) => f.finding_id === f8.finding_id && f.status === "accepted_risk") &&
      !codesOf(s8).includes("blocking_finding"),
    `③-8 已知限制显示独立标签（overlays=${s8.overlays.join("、")}），缺陷仍列出但不是"明确阻塞"`,
  );
  ok(
    limitSet.by_id["T-4"].display_status === "verified" && limitSet.by_id["T-4"].overlays.length === 0,
    `③-8 对照：同一批里没有已知限制的 T-4 仍是 ${limitSet.by_id["T-4"].display_status}（降级是接受限制造成的，不是普遍失效）`,
  );
  const manualAccept = acceptanceDimensionOf(Object.values(auditNow().acceptances), { task_id: "T-1" });
  ok(
    manualAccept === "accepted_known_limit" &&
      acceptanceDimensionOf([], { task_id: "T-1" }) === "pending" &&
      codeOf(() => acceptanceDimensionOf([{ ...records.acceptances["acc-T-1-1"], role: "executor" as never }])) === "INVALID_COMMAND",
    "③-8 人工验收只认用户身份记录（缺记录 = pending；非 user 记录直接抛，不接受质量状态代写）",
  );

  // ══════════════════════════ ④ 兼容、登记与只读入口 ══════════════════════════
  info("── ④-1 v1 兼容投影红线：未迁移项目四色逐字不变，已迁移项目按事实派生四色");
  addModule(LEGACY, { id: "m1", name: "旧模块", status: "todo" }, dataDir);
  setModuleStatus(LEGACY, "m1", "done", dataDir);
  const legacyProgress = path.join(workbench(legacyRoot), "progress.json");
  const legacyAfterV1 = read(legacyProgress);
  const legacyParsed = JSON.parse(legacyAfterV1) as { modules: { id: string; status: string }[]; projection_of?: string };
  ok(
    legacyParsed.modules[0]?.status === "done" && legacyParsed.projection_of === undefined,
    `④-1 未迁移项目：v1 写口照旧写四色（modules[0].status=${legacyParsed.modules[0]?.status}，无投影标记）`,
  );
  const legacySkip = writeCompatProgressProjection(projectWorkDir(LEGACY, dataDir), legacyProgress, buildCompatProgressProjection({ modules: [], previous: { gate: null }, last_seq: 0 }), { migrated: false });
  ok(
    legacySkip.written === false && read(legacyProgress) === legacyAfterV1,
    `④-1 未迁移项目调用兼容投影 → 一个字节都没写（${legacySkip.reason}）`,
  );
  const compat = buildCompatProgressProjection({
    modules: [
      { module_id: "base", projections: [real.by_id["T-1"]] },
      { module_id: "wall", projections: [real.by_id["T-2"], real.by_id["T-3"]] },
      { module_id: "paint", projections: [real.by_id["T-4"]] },
    ],
    previous: { gate: JSON.parse(MAIN_PROGRESS_BEFORE).gate },
    last_seq: facts.last_seq,
    generated_at: "2026-09-20T02:00:00+08:00",
  });
  const compatWrite = writeCompatProgressProjection(MAIN_WORK, MAIN_PROGRESS, compat, { migrated: true });
  const mainProgressAfter = JSON.parse(read(MAIN_PROGRESS)) as {
    gate: { current_step: string };
    projection_of?: string;
    modules: { id: string; status: string; v2_display_status: string | null; v2_counts: unknown }[];
  };
  ok(
    compatWrite.written === true &&
      mainProgressAfter.projection_of === "work/events.jsonl" &&
      mainProgressAfter.gate.current_step === "develop",
    `④-1 已迁移项目：兼容投影写回且 Gate 段原样保留（current_step=${mainProgressAfter.gate.current_step}）`,
  );
  ok(
    mainProgressAfter.modules.find((m) => m.id === "wall")?.status === "issue" &&
      mainProgressAfter.modules.find((m) => m.id === "paint")?.status === "done" &&
      mainProgressAfter.modules.find((m) => m.id === "base")?.status === "doing",
    `④-1 四色由事实派生：base=${mainProgressAfter.modules.find((m) => m.id === "base")?.status} / wall=${mainProgressAfter.modules.find((m) => m.id === "wall")?.status} / paint=${mainProgressAfter.modules.find((m) => m.id === "paint")?.status}`,
  );
  ok(
    mainProgressAfter.modules.every((m) => m.v2_display_status === null || DISPLAY_STATUS_LABELS[m.v2_display_status as keyof typeof DISPLAY_STATUS_LABELS] !== undefined) &&
      v1ModuleStatusOf("verified") === "done" &&
      v1ModuleStatusOf("pending_verification") === "doing" &&
      v1ModuleStatusOf("blocked") === "issue" &&
      v1ModuleStatusOf("unknown") === "todo" &&
      v1ModuleStatusOf(null) === "todo",
    "④-1 四色是有损派生（橙/未知不记 done），真状态在 v2_display_status 里可读回",
  );
  ok(
    moduleStatusFromProjections([real.by_id["T-3"]]) === "issue" &&
      moduleStatusFromProjections([real.by_id["T-2"]]) === "doing" &&
      moduleStatusFromProjections([]) === "todo",
    "④-1 模块四色按对象投影保守归约（受阻→issue，待验证→doing，空集→todo，不判绿）",
  );

  info("── ④-2 登记面对账（事件词表 + 错误码 + 路由）");
  // 2026-09-20 V06-11 并入 5 类执行事件（11 个类型，实体前缀 execution:）——期望集合按新事实逐个点名，
  // 判据仍是"恰好相等"（不许放宽成包含）。
  const registered = registeredEventTypes().sort();
  const moduleTypes = [
    ...TASK_EVENT_TYPES,
    ...FINDING_EVENT_TYPES,
    ...AUDIT_EVENT_TYPES,
    ...EXECUTION_EVENT_TYPES,
    ...REQUIREMENT_EVENT_TYPES,
    ...CHANGE_EVENT_TYPES,
    ...BUDGET_EVENT_TYPES,
    ...SYNC_EVENT_TYPES,
  ].sort();
  ok(
    registered.length === moduleTypes.length && registered.join(",") === moduleTypes.join(","),
    `④-2 登记面 = 八个模块词表的并集（${registered.length} 条：task ${TASK_EVENT_TYPES.length} / finding ${FINDING_EVENT_TYPES.length} / audit ${AUDIT_EVENT_TYPES.length} / execution ${EXECUTION_EVENT_TYPES.length} / requirement ${REQUIREMENT_EVENT_TYPES.length} / change ${CHANGE_EVENT_TYPES.length} / budget ${BUDGET_EVENT_TYPES.length} / sync ${SYNC_EVENT_TYPES.length}；2026-09-20 V06-11 并入执行、T21 并入需求与变更批次、T23 并入项目预算约束、2026-09-30 V09-23 并入同步证据域）`,
  );
  ok(
    EXECUTION_EVENT_TYPES.every((t) => registeredEventTypes().includes(t)) &&
      new Set(EXECUTION_EVENT_TYPES).size === EXECUTION_EVENT_TYPES.length &&
      EXECUTION_EVENT_TYPES.length === 11,
    `④-2 V06-11 的 11 个执行事件类型逐个点名在登记面里（无重复）：${EXECUTION_EVENT_TYPES.join(" ")}`,
  );
  ok(
    REGISTERED_EVENT_TYPES.every(
      (r) =>
        (r.type.startsWith("task.") && r.entity_prefix === "task:") ||
        (r.type.startsWith("finding.") && r.entity_prefix === "finding:") ||
        (r.type.startsWith("execution.") && r.entity_prefix === "execution:") ||
        (r.type.startsWith("requirement.") && r.entity_prefix === "requirement:") ||
        (r.type.startsWith("change.") && r.entity_prefix === "change:") ||
        (r.type.startsWith("budget.") && r.entity_prefix === "budget:") ||
        (r.type.startsWith("sync.") && r.entity_prefix === "sync:") ||
        (Object.values(AUDIT_ENTITY_PREFIXES) as string[]).includes(r.entity_prefix),
    ),
    "④-2 每条登记都带实体前缀，且与各模块的实体约定一致",
  );
  ok(
    (Object.keys(AUDIT_ENTITY_PREFIXES) as string[]).length === AUDIT_EVENT_TYPES.length &&
      new Set(Object.values(AUDIT_ENTITY_PREFIXES)).size === AUDIT_EVENT_TYPES.length,
    `④-2 审计六类事件各占一个实体前缀（${Object.values(AUDIT_ENTITY_PREFIXES).join(" ")}）`,
  );
  ok(
    WORK_ERROR_CODES.includes("EVIDENCE_INVALID") && service.info().registered_event_types.length === registered.length,
    `④-2 服务自述带已登记词表（${service.info().registered_event_types.length} 条），错误码含 EVIDENCE_INVALID`,
  );
  const contractText = read(path.join(REPO, "docs", "work-v2-contract.md"));
  ok(
    contractText.includes("## 9. 证据与审计事件词表（V06-09 登记") &&
      [...FINDING_EVENT_TYPES, ...AUDIT_EVENT_TYPES, "EVIDENCE_INVALID"].every((t) => contractText.includes(t)),
    "④-2 契约文档追加一节登记新词表与错误码（既有各节未改）",
  );
  const routeText = read(path.join(REPO, "src", "server", "remote-routes.ts"));
  ok(
    routeText.includes('path: "/api/projects/:id/status-projection"') &&
      routeText.includes('"/api/projects/:id/audit"') &&
      routeText.includes('if (req.method === "GET" && workProjectionMatch) {'),
    "④-2 两条只读路由登记进 remote-routes.ts（含 altPaths 与源码锚点，S2 防漂移对账用）",
  );
  ok(
    JSON.parse(read(path.join(REPO, "package.json"))).scripts["verify:v06-09"] === "tsx scripts/verify-v06-09.ts",
    "④-2 package.json 登记 verify:v06-09",
  );

  info("── ④-3 只读入口真起后端（路由接线：从现场事实现算，不写任何文件）");
  if (await portListening(PORT)) throw new Error(`端口 ${PORT} 被占用，无法起隔离后端`);
  const progressBeforeHttp = sha256(read(MAIN_PROGRESS));
  const eventsBeforeHttp = sha256(read(path.join(MAIN_WORK, "events.jsonl")));
  serverChild = spawnServer();
  await waitUp();
  const projRes = await api(`/api/projects/${MAIN}/status-projection`);
  const auditRes = await api(`/api/projects/${MAIN}/audit`);
  const notFoundRes = await api(`/api/projects/v0609-nope/status-projection`);
  // V09-29/F4：HTTP 读口是**产品默认**（`code=null`）——本地也按同一口径现算一份，逐对象比"同判"。
  // 不再断言"T-4 绿"：无源清单的 code 检查在产品默认下=待复核，是 F4 的**预期**行为（不是路由坏了）；
  // 而 ③ 的"投影规则"类断言仍用显式覆盖走绿——两者分开，不靠恢复旧自报。
  const localDefault = projectFromFacts(MAIN, dataDir).projection;
  const httpObjects: any[] = Array.isArray(projRes.body.projection?.objects) ? projRes.body.projection.objects : [];
  ok(
    projRes.status === 200 &&
      projRes.body.ok === true &&
      Array.isArray(projRes.body.projection.objects) &&
      httpObjects.some((o) => o.object_id === "T-3" && o.display_status === "blocked") &&
      httpObjects.some((o) => o.object_id === "T-1" && o.display_status === "pending_verification") &&
      httpObjects.every((o) => {
        const local = localDefault.by_id[o.object_id];
        return local === undefined || local.display_status === o.display_status;
      }),
    `④-3 GET /status-projection 可达且与本地产品默认投影同判（HTTP ${projRes.status}，对象 ${httpObjects.length} 个：逐对象同判；T-3 红 / T-1 接受限制不染绿）`,
  );
  ok(
    httpObjects.some((o) => o.object_id === "T-4" && o.display_status !== "verified") &&
      localDefault.by_id["T-4"]?.display_status !== "verified",
    `④-3 无源清单的 code 检查在 HTTP 侧 = 待复核（F4：不拿账本自报的 code 修订冒充当前验证；T-4=${httpObjects.find((o) => o.object_id === "T-4")?.display_status}）`,
  );
  ok(
    projRes.body.projection.summary.basis.includes("不用节点数") &&
      projRes.body.projection.objects.every((o: any) => !("percent" in o)),
    "④-3 只读接口同样只有计数与缺口（没有百分比）",
  );
  ok(
    auditRes.status === 200 &&
      auditRes.body.ok === true &&
      auditRes.body.audit.findings.ledger.blocking.length === 2 &&
      auditRes.body.audit.chain.separated.human_acceptance === true &&
      auditRes.body.audit.evidence.length >= 9 &&
      auditRes.body.audit.spot_check.raw_entry_points.length > 0,
    `④-3 GET /audit 可达（HTTP ${auditRes.status}：缺陷阻塞 ${auditRes.body.audit?.findings?.ledger?.blocking?.length} 条、证据 ${auditRes.body.audit?.evidence?.length} 份、抽查入口 ${auditRes.body.audit?.spot_check?.raw_entry_points?.length} 处）`,
  );
  ok(
    auditRes.body.audit.audit_package !== null &&
      auditRes.body.audit.audit_package.author_summary_is_navigation_only === true &&
      typeof auditRes.body.audit.audit_package.completeness === "object",
    "④-3 接口给出审计包（含必含项完整性标记与原文入口，作者摘要只是导航）",
  );
  ok(
    notFoundRes.status >= 400 && notFoundRes.body.ok === false,
    `④-3 不存在的项目 → 明确拒绝（HTTP ${notFoundRes.status} ${notFoundRes.body?.error?.code ?? ""}）`,
  );
  ok(
    sha256(read(MAIN_PROGRESS)) === progressBeforeHttp && sha256(read(path.join(MAIN_WORK, "events.jsonl"))) === eventsBeforeHttp,
    "④-3 两条只读入口跑完，progress.json 与事件文件一个字节都没变（只读入口不写事实）",
  );
  await stopChild(serverChild);
  serverChild = null;
}

async function stopChild(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null) return;
  proc.kill("SIGKILL");
  for (let i = 0; i < 40; i++) {
    if (proc.exitCode !== null) break;
    await sleep(100);
  }
}

main()
  .catch((e) => {
    console.error(`[verify] 异常：${e instanceof Error ? e.stack : String(e)}`);
    process.exitCode = 1;
    ok(false, `验证中断：${e instanceof Error ? e.message : String(e)}`);
  })
  .finally(async () => {
    if (serverChild !== null) await stopChild(serverChild);

    info("── 塔台根文档零改动核对（首尾逐文件 sha256；DESIGN.md 附录 B 随整文件哈希一起证明）");
    for (const rel of DOC_FILES) {
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
    console.log(`\n[verify] V06-09 结果：${passCount} PASS / ${failCount} FAIL（exit ${process.exitCode ?? 0}）`);
  });
