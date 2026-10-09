// V06-10 验证脚本（PLAN.md V06-10；DESIGN.md §6.7 为主契约，另见 §2.7、§5.4、§5.8、§6.2）。
// 用法：pnpm verify:v06-10（或 node --import tsx scripts/verify-v06-10.ts）
//
// 自带隔离环境：临时 `TATAI_HOME` + `os.tmpdir()` 下的夹具项目，**不碰**任何真实项目的 `.工作台/`；
// 塔台根文档（DESIGN.md / PLAN.md / PROGRESS.md / AGENTS.md / README.md / 两份设计史）只读，
// 首尾逐文件 sha256 对照证明零改动，`DESIGN.md` 附录 B 段另给单独哈希。收尾清理临时目录与子进程
// （`TATAI_KEEP_TMP=1` 保留现场）。`scripts/attach-agents-md.ts` **只对夹具项目真跑**（红线：不对仓库自身跑）。
//
// 覆盖点（PLAN V06-10 三条检查项逐条落到断言名）：
//   ① 入口契约与判定：§6.7 的输入/只读返回八个字段/七个枚举**恰好**对齐；恢复优先于新领；
//      依赖质量（未释放不派）、版本（旧版不派）、角色（错误角色不派）、范围（重叠不派）、
//      稳定优先级（已定义优先级 → 依赖顺序 → 稳定 ID）与空队列（无就绪 ≠ complete）；
//      只读入口不认领、不写事件、不调模型；能力发现准确区分 只读/可接续/可协调执行。
//   ② 认领与回报：两个客户端抢同一张卡只有一个成功；已被有效认领明确拒绝；
//      租约到期只表示"所有权需核实"（`LEASE_NOTE` 逐字在场，且不许出现"进程已停止"的结论）；
//      重派要核实依据；续约/释放 token 校验；提交重查 版本/认领/租约/依赖/证据；
//      回报后接着读下一动作；入口规则写到客户端能载入的位置且重复接入不覆盖用户自写规则。
//   ③ 七个场景逐个断言：抢同一张卡 / 错误角色 / 旧版 / 历史 Gate 不挡 / 用户暂停挡相关工作 /
//      无就绪但有阻塞不报 complete / 新会话没有旧聊天仍能定位下一项。
import crypto from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { addProject } from "../src/server/registry";
import { projectWorkDir } from "../src/server/workstation";
import {
  evaluateProjectEntry,
  capabilityOf,
  roleClassOf,
  priorityRank,
  PROJECT_ENTRY_ACTIONS,
  PROJECT_ENTRY_INPUT_FIELDS,
  PROJECT_ENTRY_RESULT_FIELDS,
  CLIENT_CAPABILITY_CLASSES,
  type ProjectEntry,
} from "../src/server/work/entry";
import {
  claimRecordsOf,
  leaseStateOf,
  liveClaimRecord,
  readClaimEvents,
  LEASE_NOTE,
  RESUME_PRECONDITIONS,
} from "../src/server/work/claims";
import { activateBaseline, activeBaseline } from "../src/server/work/documents";
import { putEvidence } from "../src/server/work/evidence";
import { buildSourceManifest } from "../src/server/work/sourceEvidence";
import { importTaskDefinitions, type TaskDefinition } from "../src/server/work/plan";
import { WorkService } from "../src/server/work/service";
import { readTaskStates, submitDefinitionImports, submitTaskStatus } from "../src/server/work/tasks";
import { submitHumanAcceptance, submitSelfCheck, submitSubmission } from "../src/server/work/audit";

// ── 断言与日志 ──

let passCount = 0;
let failCount = 0;
const ok = (cond: boolean, label: string, detail?: unknown) => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (cond) passCount++;
  else {
    failCount++;
    process.exitCode = 1;
    if (detail !== undefined) console.log(`[verify]   现场：${JSON.stringify(detail).slice(0, 2000)}`);
  }
};
const info = (msg: string) => console.log(`[verify] ${msg}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha256 = (data: string | Buffer): string => crypto.createHash("sha256").update(data).digest("hex");
const sha256File = (f: string): string => sha256(fs.readFileSync(f));
const short = (s: string | null | undefined, n = 12): string => (s == null || s === "" ? "null" : `${s.slice(0, n)}…`);

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8821;
/** 本卡只读的塔台根文档（首尾 sha256 对照） */
const DOC_FILES = [
  "DESIGN.md",
  "PLAN.md",
  "PROGRESS.md",
  "AGENTS.md",
  "README.md",
  "docs/design-history-v0.4.md",
  "docs/design-history-v0.5.md",
];
const APPENDIX_B_HEADING = "## 附录 B：待议记录";
const appendixBOf = (text: string): string => {
  const idx = text.indexOf(APPENDIX_B_HEADING);
  return idx < 0 ? "<附录 B 段未找到>" : text.slice(idx);
};

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

const docBefore = new Map<string, string>();
const appendixBefore = new Map<string, string>();
for (const rel of DOC_FILES) {
  const abs = path.join(REPO, rel);
  if (!fs.existsSync(abs)) {
    docBefore.set(rel, "<missing>");
    appendixBefore.set(rel, "<missing>");
    continue;
  }
  const text = fs.readFileSync(abs, "utf8");
  docBefore.set(rel, sha256(text));
  if (rel.endsWith("DESIGN.md")) appendixBefore.set(rel, sha256(appendixBOf(text)));
}

// ── 隔离环境 ──

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-v0610-verify-"));
const dataDir = path.join(tmpBase, "home");
fs.mkdirSync(dataDir, { recursive: true });
process.env.TATAI_HOME = dataDir;
const service = new WorkService({ dataDir });
const CHG = "chg-v0610";
const codeRev = sha256("v0610-code-rev");
const executor = "kimi-code";

const mkdirp = (d: string) => fs.mkdirSync(d, { recursive: true });
const write = (f: string, text: string) => {
  mkdirp(path.dirname(f));
  fs.writeFileSync(f, text, "utf8");
};
const read = (f: string) => fs.readFileSync(f, "utf8");

interface Card {
  id: string;
  goal: string;
  dep?: string;
  evidence?: string;
  priority?: string;
  role?: string;
  paths?: string[];
  checks?: string[];
}

/** 造一份合法施工图（表 + 卡正文；字段标签走 TASK_FIELD_ALIASES 的口径） */
function planText(title: string, cards: Card[]): string {
  const lines = [
    `# ${title}`,
    "",
    "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const c of cards) {
    lines.push(`| ${c.id} | todo | ${c.goal} | ${c.dep ?? ""} | ${c.evidence ?? `${c.id} 的完成证据`} |`);
  }
  lines.push("");
  for (const c of cards) {
    lines.push(`### ${c.id} ${c.goal}`);
    lines.push("");
    lines.push(
      `**设计依据**：§1。**依赖**：${c.dep ?? "无"}。**文件责任**：${(c.paths ?? [`src/${c.id.toLowerCase()}.ts`])
        .map((p) => `\`${p}\``)
        .join("、")}。` +
        (c.role === undefined ? "" : `**责任角色**：${c.role}。`) +
        (c.priority === undefined ? "" : `**优先级**：${c.priority}。`),
    );
    lines.push("");
    for (const check of c.checks ?? [`${c.goal} 达标`]) lines.push(`- [ ] ${check}`);
    lines.push("");
  }
  return lines.join("\n");
}

interface Fixture {
  id: string;
  root: string;
  workDir: string;
  plan: string;
  defs: TaskDefinition[];
  cards: Card[];
  /** 自检证据哈希（后续提交结果时当证据引用用） */
  greenEvidence: Record<string, string>;
}

const fixtures: Fixture[] = [];

/** 建一个夹具项目（注册表 + 图纸 [+ 生效基线 + 定义导入]） */
function makeFixture(
  id: string,
  cards: Card[],
  opts: { designOnly?: boolean; baseline?: boolean } = {},
): Fixture {
  const root = path.join(tmpBase, id);
  mkdirp(path.join(root, ".工作台"));
  const design = `# ${id} 设计书\n\n## 1 目标\n\n夹具项目的设计正文（V06-10 验证用）。\n`;
  write(path.join(root, ".工作台", "design.md"), design);
  const plan = planText(`${id} 施工图`, cards);
  write(path.join(root, ".工作台", "plan.md"), plan);
  addProject({ id, name: `V06-10 夹具 ${id}`, path: root, kind: "backend" }, dataDir);
  const fx: Fixture = { id, root, workDir: projectWorkDir(id, dataDir), plan, defs: [], cards, greenEvidence: {} };
  fixtures.push(fx);
  if (opts.designOnly === true) return fx;
  const imported = importTaskDefinitions(plan, { plan_revision: sha256(plan) });
  fx.defs = imported.definitions;
  if (opts.baseline !== false) {
    activateBaseline(id, { approved_by: "user", approval_basis: "V06-10 夹具审定", approval_kind: "user_confirmed" }, dataDir);
  }
  if (cards.length > 0) {
    submitDefinitionImports(service, {
      project_id: id,
      change_id: CHG,
      actor_id: executor,
      role: "executor",
      definitions: imported.definitions,
    });
  }
  return fx;
}

const revOf = (fx: Fixture, taskId: string): number | null =>
  readTaskStates(fx.workDir).states[taskId]?.revision ?? null;

/**
 * 夹具：改任务执行状态。
 *
 * `result_submitted` 在这个夹具里是**历史/迁移状态**（造"这张卡已经交过结果"的现场），不是一次新交付：
 * 按**既有状态边界** `task.status_changed` + `payload.status` 写（与 `migrate.ts` 把 v1 `done` 折成
 * `result_submitted` 逐字同一形态，不带交付包、不宣称判据通过）。**`task.result_submitted` 是一条
 * 交付提交事件**，只由带合法认领 token + 可追溯证据的提交写入（P2/V09-47 锁内共享判据）——夹具不冒充
 * 交付提交，也不要求产品为回归放宽校验（本项**不测试新交付**）。
 */
let fixtureStatusSeq = 0;
function setStatus(fx: Fixture, taskId: string, status: Parameters<typeof submitTaskStatus>[1]["status"], reason?: string) {
  const expectedRevision = revOf(fx, taskId);
  const common = {
    project_id: fx.id,
    change_id: CHG,
    actor_id: executor,
    role: "executor" as const,
    expected_revision: expectedRevision,
  };
  if (status === "result_submitted") {
    fixtureStatusSeq += 1;
    return service.submit({
      schema_version: 2,
      ...common,
      entity_id: `task:${taskId}`,
      type: "task.status_changed",
      idempotency_key: `fixture-hist-status:${taskId}:result_submitted:${expectedRevision}:${fixtureStatusSeq}`,
      payload: { status, ...(reason === undefined ? {} : { reason }) },
    });
  }
  return submitTaskStatus(service, {
    ...common,
    task_id: taskId,
    status,
    ...(reason === undefined ? {} : { reason }),
  });
}

const defOf = (fx: Fixture, taskId: string): TaskDefinition => {
  const def = fx.defs.find((d) => d.task_id === taskId);
  if (def === undefined) throw new Error(`夹具缺陷：${fx.id} 里没有 ${taskId} 的定义`);
  return def;
};

/** 让一张卡走到"验证通过"（真提交结果 + 自检证据，绑定**可核对的源清单**） */
function verifyGreen(fx: Fixture, taskId: string): void {
  const def = defOf(fx, taskId);
  // V09-29/F4：可用于"已验证"的检查必须绑定**当前可核对来源**。给这张卡登记一份**真实、有界**的源清单
  // （覆盖夹具项目内一个真实源文件），检查绑到**清单指纹**、证据指向**清单证据地址**——产品默认
  // （`revisions.code = null`）下"已验证"由现读复核支撑，而不是拿账本自报的 code 修订冒充当前验证。
  const srcRel = `src/green-${taskId.toLowerCase()}.ts`;
  write(path.join(fx.root, srcRel), `export const ${taskId.replace(/[^A-Za-z0-9]/g, "_")}_OK = true;\n`);
  const manifestFp = buildSourceManifest(fx.root, [srcRel]).fingerprint;
  const blob = putEvidence(fx.workDir, {
    content: "",
    kind: "source_manifest",
    summary: `${taskId} 源清单（覆盖 ${srcRel}）`,
    created_by: executor,
    role: "executor",
    binding: { revision_kind: "code", revision: manifestFp },
    source_manifest: [srcRel],
  });
  submitSubmission(service, {
    project_id: fx.id,
    change_id: CHG,
    actor_id: executor,
    role: "executor",
    record_id: `sub-${taskId}`,
    task_id: taskId,
    goal: def.goal ?? taskId,
    binding: { revision_kind: "code", revision: codeRev },
    evidence_refs: [blob.sha256],
    changed_files: def.allowed_paths,
    submitted_by: executor,
  });
  const checks = (def.acceptance?.checks ?? []).map((c, i) => ({
    check_id: `${taskId}::check:${i}`,
    method: c.text,
    evidence_sha256: blob.sha256,
    verifies: "code" as const,
  }));
  if (def.evidence_requirement !== null && def.evidence_requirement !== "") {
    checks.push({ check_id: `${taskId}::evidence`, method: def.evidence_requirement, evidence_sha256: blob.sha256, verifies: "code" as const });
  }
  submitSelfCheck(service, {
    project_id: fx.id,
    change_id: CHG,
    actor_id: executor,
    role: "executor",
    record_id: `sc-${taskId}`,
    task_id: taskId,
    checked_by: executor,
    checks,
    conclusion: "pass",
    binding: { revision_kind: "code", revision: manifestFp },
  });
  setStatus(fx, taskId, "result_submitted");
  fx.greenEvidence[taskId] = blob.sha256;
}

// ── 入口调用与断言辅助 ──

const entryOf = (
  projectId: string,
  role: string,
  extra: { client_capabilities?: unknown; known_revision?: string | null; resume_hint?: string | null } = {},
): ProjectEntry =>
  evaluateProjectEntry(
    {
      project_id: projectId,
      role,
      ...(extra.client_capabilities === undefined ? {} : { client_capabilities: extra.client_capabilities }),
      ...(extra.known_revision === undefined ? {} : { known_revision: extra.known_revision }),
      ...(extra.resume_hint === undefined ? {} : { resume_hint: extra.resume_hint }),
    },
    { dataDir },
  );

const CONTINUABLE = { can_read: true, can_continue: true };
const reasonCodes = (entry: ProjectEntry): string[] => entry.reasons.map((r) => r.code);
const textOf = (entry: ProjectEntry): string => entry.reasons.map((r) => `${r.code}: ${r.text}`).join("\n");
const packOfEntry = (entry: ProjectEntry) => {
  const codes = ["claimable", "resume_available", "review_pending", "role_mismatch"];
  const hit = entry.reasons.find((r) => codes.includes(r.code) && r.task_id !== undefined && r.task_id !== null);
  return hit ?? null;
};
const eventsHash = (fx: Fixture): string => {
  const f = path.join(fx.workDir, "events.jsonl");
  return fs.existsSync(f) ? sha256File(f) : "<none>";
};

// ══════════════════════ 夹具（全部在进程内用真写入服务造） ══════════════════════

let mainFx: Fixture;
let orderFx: Fixture;
let roleFx: Fixture;
let pauseFx: Fixture;
let pauseOnlyFx: Fixture;
let blockFx: Fixture;
let doneFx: Fixture;
let nobaseFx: Fixture;
let blankFx: Fixture;
let raceFx: Fixture;

/** ③ 契约形状 + 能力发现 + 只读红线（§6.7 / §6.2） */
function scenarioContract(): void {
  info("── ① 契约形状（§6.7 输入/只读返回/七个枚举）与能力发现（§6.2）");
  const expectedActions = [
    "resume_task",
    "claim_task",
    "review_result",
    "await_role",
    "await_decision",
    "blocked",
    "complete",
  ];
  ok(
    JSON.stringify(PROJECT_ENTRY_ACTIONS) === JSON.stringify(expectedActions) &&
      PROJECT_ENTRY_ACTIONS.length === 7,
    `① next_action 枚举恰好是 §6.7 的七个：${PROJECT_ENTRY_ACTIONS.join(" / ")}`,
  );
  ok(
    JSON.stringify(PROJECT_ENTRY_INPUT_FIELDS) ===
      JSON.stringify(["project_id", "role", "client_capabilities", "known_revision", "resume_hint"]),
    `① 入口输入恰好是 §6.7 的五个字段：${PROJECT_ENTRY_INPUT_FIELDS.join(" / ")}`,
  );
  ok(
    JSON.stringify(PROJECT_ENTRY_RESULT_FIELDS) ===
      JSON.stringify([
        "project",
        "baseline",
        "context_manifest",
        "current_change",
        "current_runs",
        "next_action",
        "reasons",
        "required_reads",
        "sync_summary",
      ]),
    `① 只读返回恰好是 §6.7 八字段 + V09-23 同步摘要 sync_summary（响应层拼；未配置项目为 null）：${PROJECT_ENTRY_RESULT_FIELDS.join(" / ")}`,
  );

  // 能力发现：未声明 → 只读（保守）；三档准确区分
  const undeclared = capabilityOf(undefined);
  const cont = capabilityOf("continuable");
  const coord = capabilityOf({ can_read: true, can_coordinate: true });
  const arr = capabilityOf(["read_only", "continuable"]);
  const bogus = capabilityOf({ can_dance: true });
  ok(
    undeclared.effective === "read_only" && undeclared.declared.continue === false && undeclared.basis.includes("§6.2"),
    "①-2 能力发现：未声明 client_capabilities → 按「仅可读取」处理（保守缺省，§6.2）",
    undeclared,
  );
  ok(
    cont.effective === "continuable" && coord.effective === "coordination" && arr.effective === "continuable",
    "①-2 能力发现：continuable / coordination / 数组合并 三档区分正确",
    { cont: cont.effective, coord: coord.effective, arr: arr.effective },
  );
  ok(
    bogus.effective === "read_only" && bogus.unrecognized.length > 0,
    "①-2 能力发现：无法识别的声明按只读处理并把原文如实带回（不静默丢）",
    bogus,
  );
  ok(
    CLIENT_CAPABILITY_CLASSES.length === 3 && capabilityOf("read_only").limits.some((l) => l.includes("不假称全自动")),
    "①-2 能力发现：只有三档（只读/可接续/可协调执行），并如实写明「不假称全自动」",
  );
  ok(
    roleClassOf("executor") === "executor" &&
      roleClassOf("审计者") === "auditor" &&
      roleClassOf("路人甲") === "unknown" &&
      priorityRank("P0") === 0 &&
      priorityRank("高") < priorityRank("中") &&
      priorityRank(null) === Number.MAX_SAFE_INTEGER,
    "①-2 角色归类与优先级权重口径稳定（未知角色不归任何职责类；未声明优先级排最后）",
  );
}

/** ③ 主夹具：稳定优先级 / 历史 Gate 不挡 / 只读不认领 / 旧版不派 / 新会话定位 */
function scenarioMain(): void {
  info("── ③ 主夹具：稳定优先级、历史 Gate、只读红线、旧版不派、新会话定位");
  mainFx = makeFixture(
    "v0610-main",
    [
      { id: "T-1", goal: "打地基", priority: "中", checks: ["地基水平达标"] },
      { id: "T-2", goal: "砌墙", dep: "T-1", priority: "最高" },
      { id: "T-3", goal: "抹灰", dep: "T-2", priority: "低" },
      { id: "T-8", goal: "铺路", priority: "高", paths: ["src/road.ts"] },
      { id: "T-9", goal: "种树", priority: "高", paths: ["src/tree.ts"] },
    ],
    { baseline: true },
  );
  // 历史七步 Gate 停在 develop（未全绿）：入口**不许**拿它当门禁（§5.8）
  write(
    path.join(mainFx.root, ".工作台", "progress.json"),
    JSON.stringify(
      {
        version: 1,
        current_step: "develop",
        gate: { history: [{ step: "develop", result: "running", at: "2026-09-20T00:00:00+08:00" }] },
        modules: [],
      },
      null,
      2,
    ),
  );
  // 项目根内相对路径的证据材料（提交重查要用：不存在的路径也必须被拒）
  write(path.join(mainFx.root, "notes", "proof.txt"), "真跑过的验证输出（V06-10 夹具）\n");

  const eventsBefore = eventsHash(mainFx);
  const first = entryOf(mainFx.id, "executor", { client_capabilities: CONTINUABLE });

  // 契约形状（真实返回）
  ok(
    JSON.stringify(Object.keys(first)) === JSON.stringify([...PROJECT_ENTRY_RESULT_FIELDS]),
    `① 真实返回的键顺序与 §6.7 八字段 + V09-23 sync_summary 一致（${Object.keys(first).join(",")}）`,
    Object.keys(first),
  );
  const packed = packOfEntry(first);
  ok(
    first.next_action === "claim_task" &&
      packed?.task_id === "T-8" &&
      reasonCodes(first).includes("candidate_order"),
    `① 稳定优先级：就绪队列 {T-1(中)/T-8(高)/T-9(高)} → 选 T-8（已定义优先级 → 依赖顺序 → 稳定 ID）`,
    { action: first.next_action, task: packed?.task_id, reasons: reasonCodes(first) },
  );
  ok(
    packed?.task_revision === revOf(mainFx, "T-8") &&
      typeof packed?.handoff_id === "string" &&
      Array.isArray(packed?.dependency_ids) &&
      Array.isArray(packed?.allowed_paths) &&
      Array.isArray(packed?.completion_requirements) &&
      (packed?.completion_requirements?.length ?? 0) > 0,
    "① 选定动作带齐 §6.7 要求的附件：任务/交接 ID、依据版本、依赖、允许范围、完成要求、当前实体版本",
    packed,
  );
  const readPaths = first.required_reads.map((r) => `${r.kind}:${r.path}`);
  ok(
    readPaths.some((p) => p.startsWith("plan:")) &&
      readPaths.some((p) => p.startsWith("design:")) &&
      readPaths.some((p) => p.startsWith("baseline:")) &&
      readPaths.some((p) => p.includes("events.jsonl")) &&
      first.required_reads.some((r) => r.range !== null && r.range !== undefined),
    `① 必读原文入口齐（plan/design/baseline/events + 卡区行范围）：${readPaths.join(" | ")}`,
    readPaths,
  );
  ok(
    reasonCodes(first).includes("baseline_active") &&
      !JSON.stringify(first).toLowerCase().includes('"gate"') &&
      !JSON.stringify(first).toLowerCase().includes("current_step"),
    "① 历史 Gate 不挡已授权日常工作：入口不读七步 Gate、返回里也没有 Gate 字段（§5.8）",
    JSON.stringify(first).slice(0, 400),
  );
  ok(
    JSON.stringify(Object.keys(first.project.capability)) !== "[]" && first.project.capability.effective === "continuable",
    "①-2 入口回报调用方能力档位（continuable）",
    first.project.capability,
  );

  // 只读红线：读多少次都不写事实、不认领
  const eventsAfterReads = eventsHash(mainFx);
  const claimsAfterReads = claimRecordsOf(readClaimEvents(mainFx.workDir))["T-8"] ?? [];
  ok(
    eventsAfterReads === eventsBefore && claimsAfterReads.length === 0,
    "① 只读入口不认领、不写事件：多次 project_entry 之后 events.jsonl 逐字节没变、没有 task.claimed",
    { eventsAfterReads, claimsAfterReads: claimsAfterReads.length },
  );
  // 新会话定位：没有旧聊天、没有旧会话文件，也能定位下一项
  const chatDir = path.join(mainFx.root, ".工作台", "chat");
  const second = entryOf(mainFx.id, "executor", { client_capabilities: CONTINUABLE });
  ok(
    !fs.existsSync(chatDir) &&
      second.next_action === first.next_action &&
      packOfEntry(second)?.task_id === "T-8",
    "③-7 新会话没有旧聊天仍能定位下一项：定位只靠结构化事实（无 .工作台/chat 也给出同一个 T-8）",
    { chatDirExists: fs.existsSync(chatDir), action: second.next_action, task: packOfEntry(second)?.task_id },
  );

  // 旧版不派（known_revision 落后）与版本复核（当前版本可派）
  const fresh = entryOf(mainFx.id, "executor", {
    client_capabilities: CONTINUABLE,
    known_revision: sha256(mainFx.plan),
  });
  const stale = entryOf(mainFx.id, "executor", { client_capabilities: CONTINUABLE, known_revision: "deadbeef" });
  ok(
    fresh.next_action === "claim_task" &&
      stale.next_action === "await_role" &&
      reasonCodes(stale).includes("known_revision_stale"),
    "③-3 旧版不派：known_revision 是当前修订 → claim_task；落后 → await_role + known_revision_stale",
    { fresh: fresh.next_action, stale: stale.next_action, codes: reasonCodes(stale) },
  );
  ok(
    textOf(stale).includes("旧版不派") && textOf(stale).includes("重读有效基线"),
    "③-3 旧版不派的理由如实点名「怎么改」（先重读有效基线/图纸）",
    stale.reasons,
  );

  // 只读客户端：给出接续指令但不派认领
  const readOnly = entryOf(mainFx.id, "executor", { client_capabilities: "read_only" });
  ok(
    readOnly.next_action === "await_role" &&
      reasonCodes(readOnly).includes("client_read_only") &&
      packOfEntry(readOnly)?.task_id === "T-8",
    "①-2 只读客户端：仍然给出「下一项是 T-8」的接续指令，但不把认领派给它（§6.2）",
    { action: readOnly.next_action, codes: reasonCodes(readOnly) },
  );

  // resume_hint 只是提示：指到不合规的卡要如实记下并按默认规则选
  const hinted = entryOf(mainFx.id, "executor", { client_capabilities: CONTINUABLE, resume_hint: "T-2" });
  ok(
    reasonCodes(hinted).includes("resume_hint_unusable") &&
      hinted.next_action === "claim_task" &&
      packOfEntry(hinted)?.task_id === "T-8",
    "① resume_hint 指向依赖未释放的卡 → 如实记 unusable，不越权，仍按默认顺序选 T-8",
    { codes: reasonCodes(hinted), task: packOfEntry(hinted)?.task_id },
  );
  ok(
    eventsHash(mainFx) === eventsBefore,
    "① 上面全部只读调用结束时 events.jsonl 与开始时逐字节相同",
  );
}

/** ① 依赖顺序（同优先级下先做浅的） */
function scenarioOrder(): void {
  info("── ① 依赖顺序：同优先级下按依赖层级选（层级 0 先于层级 1）");
  orderFx = makeFixture("v0610-order", [
    { id: "T-1", goal: "打地基", checks: ["地基水平达标"] },
    { id: "T-2", goal: "砌墙", dep: "T-1", priority: "高" },
    { id: "T-9", goal: "种树", priority: "高", paths: ["src/tree.ts"] },
  ]);
  verifyGreen(orderFx, "T-1");
  const green = entryOf(orderFx.id, "executor", { client_capabilities: CONTINUABLE });
  ok(
    reasonCodes(green).some((c) => c === "claimable") || green.next_action === "claim_task",
    "① 前置已验证通过 → 依赖方 T-2 进入就绪队列（依赖释放不看「前卡自报 done」）",
    { action: green.next_action, codes: reasonCodes(green) },
  );
  ok(
    green.next_action === "claim_task" && packOfEntry(green)?.task_id === "T-9" &&
      textOf(green).includes("依赖顺序"),
    "① 稳定排序：T-2(层级 1) 与 T-9(层级 0) 同优先级 → 选层级更浅的 T-9",
    { task: packOfEntry(green)?.task_id, action: green.next_action },
  );
}

/** ③-2 错误角色不派（施工图声明了责任角色就对不上） */
function scenarioRole(): void {
  info("── ③-2 错误角色不派（施工图声明的责任角色 ≠ 本角色）");
  roleFx = makeFixture("v0610-role", [
    { id: "T-1", goal: "独立复核地基", role: "审计者", checks: ["复核结论有证据"] },
  ]);
  const asExecutor = entryOf(roleFx.id, "executor", { client_capabilities: CONTINUABLE });
  const asAuditor = entryOf(roleFx.id, "auditor", { client_capabilities: CONTINUABLE });
  ok(
    asExecutor.next_action === "await_role" &&
      reasonCodes(asExecutor).includes("role_mismatch") &&
      textOf(asExecutor).includes("审计者") &&
      packOfEntry(asExecutor)?.task_id === "T-1",
    "③-2 错误角色不派：executor 拿不到「责任角色：审计者」的卡，返回 await_role + 完整交接",
    { action: asExecutor.next_action, codes: reasonCodes(asExecutor) },
  );
  ok(
    asAuditor.next_action === "claim_task" && packOfEntry(asAuditor)?.task_id === "T-1",
    "③-2 反向对照：同一张卡在 auditor 手里就是可领取的（不是「谁都拿不到」）",
    { action: asAuditor.next_action, codes: reasonCodes(asAuditor), auditorText: textOf(asAuditor) },
  );
  const roleEvents = path.join(roleFx.workDir, "events.jsonl");
  ok(
    !fs.existsSync(roleEvents) || !read(roleEvents).includes("task.claimed"),
    "③-2 角色判定全程只读（没有产生任何 task.claimed）",
  );
}

/** ③-5 用户暂停挡相关工作（无关任务不全局冻结） */
function scenarioPause(): void {
  info("── ③-5 用户暂停/退回：挡受影响任务，不全局冻结无关任务");
  pauseFx = makeFixture("v0610-pause", [
    { id: "T-1", goal: "打地基", checks: ["地基水平达标"] },
    { id: "T-2", goal: "砌墙", dep: "T-1", priority: "高" },
    { id: "T-9", goal: "种树", priority: "中", paths: ["src/tree.ts"] },
  ]);
  verifyGreen(pauseFx, "T-1");
  submitHumanAcceptance(service, {
    project_id: pauseFx.id,
    change_id: CHG,
    actor_id: "主人",
    role: "user",
    record_id: "acc-reject-T2",
    task_id: "T-2",
    decision: "reject",
    accepted_by: "主人",
    note: "砌墙的做法要改，先别继续",
  });
  const entry = entryOf(pauseFx.id, "executor", { client_capabilities: CONTINUABLE });
  const claimCandidate = entry.reasons.find((r) => r.code === "claimable" || r.code === "resume_available");
  ok(
    entry.next_action === "claim_task" && claimCandidate?.task_id !== "T-2",
    "③-5 用户退回 T-2 → T-2 不再作为可领取候选（本角色拿到的是别的卡）",
    { action: entry.next_action, candidate: claimCandidate?.task_id },
  );
  ok(
    reasonCodes(entry).includes("user_rejected") &&
      textOf(entry).includes("T-2") &&
      textOf(entry).includes("暂停受影响任务"),
    "③-5 理由如实点名被暂停的任务与影响范围（§5.8 记录影响范围 + 暂停交付/任务资格）",
    entry.reasons.filter((r) => r.code === "user_rejected"),
  );
  ok(
    entry.next_action === "claim_task" && packOfEntry(entry)?.task_id === "T-9",
    "③-5 反向对照：无关任务不被全局冻结（T-9 照常可领）",
    { task: packOfEntry(entry)?.task_id },
  );

  // 只有受影响任务可做时 → 不报 complete
  pauseOnlyFx = makeFixture("v0610-pause-only", [
    { id: "T-1", goal: "打地基", checks: ["地基水平达标"] },
    { id: "T-2", goal: "砌墙", dep: "T-1", priority: "高" },
  ]);
  verifyGreen(pauseOnlyFx, "T-1");
  submitHumanAcceptance(service, {
    project_id: pauseOnlyFx.id,
    change_id: CHG,
    actor_id: "主人",
    role: "user",
    record_id: "acc-reject-T2",
    task_id: "T-2",
    decision: "reject",
    accepted_by: "主人",
    note: "砌墙返工",
  });
  const only = entryOf(pauseOnlyFx.id, "executor", { client_capabilities: CONTINUABLE });
  ok(
    only.next_action === "blocked" &&
      reasonCodes(only).includes("user_rejected") &&
      !reasonCodes(only).includes("claimable"),
    "③-5 剩下唯一可做的卡被用户退回 → blocked（不派、也不报 complete）",
    { action: only.next_action, codes: reasonCodes(only) },
  );
}

/** ③-6 无就绪任务但有阻塞 → 不报 complete */
function scenarioBlock(): void {
  info("── ③-6 无就绪任务但有阻塞：不报 complete，逐条说清阻塞");
  blockFx = makeFixture("v0610-block", [
    { id: "T-1", goal: "打地基", priority: "高", checks: ["地基水平达标"] },
    { id: "T-2", goal: "砌墙", dep: "T-1", priority: "高" },
  ]);
  setStatus(blockFx, "T-1", "blocked", "等勘探报告，暂时打不了");
  const entry = entryOf(blockFx.id, "executor", { client_capabilities: CONTINUABLE });
  ok(
    entry.next_action === "blocked" &&
      reasonCodes(entry).includes("blocked_task") &&
      textOf(entry).includes("等勘探报告"),
    "③-6 唯一先行卡阻塞 → blocked + 如实带出阻塞原因（不报 complete）",
    { action: entry.next_action, codes: reasonCodes(entry) },
  );
  ok(
    entry.next_action !== "complete" && reasonCodes(entry).includes("no_ready_task"),
    "③-6 空就绪队列判断：没有就绪任务 ≠ 项目完成（§6.7）",
    { action: entry.next_action, codes: reasonCodes(entry) },
  );
  const blockedClaim = entryOf(blockFx.id, "executor", { client_capabilities: CONTINUABLE, resume_hint: "T-1" });
  ok(
    blockedClaim.next_action === "blocked" &&
      !reasonCodes(blockedClaim).includes("claimable"),
    "③-6 阻塞的卡不会被 resume_hint 顶成可领取（提示不越权）",
    { action: blockedClaim.next_action, codes: reasonCodes(blockedClaim) },
  );
}

/** ③ complete 与人工验收边界（fail-closed） */
function scenarioDone(): void {
  info("── ③ complete 的 fail-closed 判定与人工验收边界（§5.8）");
  doneFx = makeFixture("v0610-done", [{ id: "T-1", goal: "打地基", checks: ["地基水平达标"] }]);
  verifyGreen(doneFx, "T-1");
  const userBefore = entryOf(doneFx.id, "user", { client_capabilities: "read_only" });
  const executorBefore = entryOf(doneFx.id, "executor", { client_capabilities: CONTINUABLE });
  ok(
    userBefore.next_action === "review_result" && reasonCodes(userBefore).includes("review_pending"),
    "③ 用户角色：全部必需工作已验证通过、等批次验收 → review_result（人工验收只能用户推进）",
    { action: userBefore.next_action, codes: reasonCodes(userBefore) },
  );
  ok(
    (executorBefore.next_action as string) !== "complete" && executorBefore.next_action === "blocked",
    "③ 执行者角色：同一现场没有可领的活 → blocked（缺用户验收就绝不 complete，§6.7/§5.8）",
    { action: executorBefore.next_action, codes: reasonCodes(executorBefore) },
  );
  let nonUserRejected = false;
  try {
    submitHumanAcceptance(service, {
      project_id: doneFx.id,
      change_id: CHG,
      actor_id: executor,
      role: "executor",
      record_id: "acc-forged",
      decision: "accept",
      accepted_by: "kimi-code",
    });
  } catch {
    nonUserRejected = true;
  }
  submitHumanAcceptance(service, {
    project_id: doneFx.id,
    change_id: CHG,
    actor_id: "主人",
    role: "user",
    record_id: "acc-batch",
    decision: "accept",
    task_id: null,
    accepted_by: "主人",
    note: "批次验收通过",
  });
  const userAfter = entryOf(doneFx.id, "user", { client_capabilities: "read_only" });
  ok(
    nonUserRejected,
    "③ Agent 代签人工验收被拒（role 必须 user，§5.8）",
  );
  ok(
    userAfter.next_action === "complete" && reasonCodes(userAfter).includes("complete_all_verified"),
    "③ 全部必需工作验证通过 + 用户批次验收 → complete（只有这时才 complete）",
    { action: userAfter.next_action, codes: reasonCodes(userAfter) },
  );
}

/** ① 有效基线核对：没有生效基线就不派活（先审定） */
function scenarioNoBaseline(): void {
  info("── ① 有效基线：没有生效基线 → await_decision（先审定，不拿不确定的输入开工）");
  nobaseFx = makeFixture("v0610-nobase", [{ id: "T-1", goal: "打地基", checks: ["地基水平达标"] }], {
    baseline: false,
  });
  ok(activeBaseline(nobaseFx.id, dataDir) === null, "① 夹具前置：该项目确实没有生效基线");
  const entry = entryOf(nobaseFx.id, "executor", { client_capabilities: CONTINUABLE });
  ok(
    entry.next_action === "await_decision" &&
      reasonCodes(entry).includes("baseline_missing") &&
      !reasonCodes(entry).includes("claimable"),
    "① 无有效基线 → await_decision + baseline_missing，即使有就绪卡也不派（§6.7「先核对有效基线」）",
    { action: entry.next_action, codes: reasonCodes(entry) },
  );
  blankFx = makeFixture("v0610-blank", [], { designOnly: true });
  const blank = entryOf(blankFx.id, "executor", { client_capabilities: CONTINUABLE });
  ok(
    blank.next_action === "await_decision" && blank.current_change === null && blank.current_runs.length === 0,
    "① 空队列冒烟：一张图纸都没有的项目不炸，如实返回 await_decision（不 complete、不空集判绿）",
    { action: blank.next_action, change: blank.current_change },
  );
}

/** ② 认领夹具：抢卡 / 租约 / 续约释放 / 提交重查（MCP 真调） */
function scenarioRaceFixture(): void {
  info("── ② 认领夹具（抢同一张卡 / 租约语义 / 提交重查）");
  raceFx = makeFixture("v0610-race", [
    { id: "T-A", goal: "抢卡目标", priority: "高", paths: ["src/a.ts"], checks: ["A 达标"] },
    { id: "T-B", goal: "租约目标", priority: "高", paths: ["src/b.ts"], checks: ["B 达标"] },
    { id: "T-C", goal: "提交重查目标", priority: "中", paths: ["src/c.ts"], checks: ["C 达标"] },
  ]);
  // 提交重查要用的证据（内容寻址 + 一份项目根内相对路径证据）
  const blob = putEvidence(raceFx.workDir, {
    content: `${raceFx.id}/T-C 交付证据：真跑过（V06-10 夹具）\n`,
    kind: "submission",
    summary: "T-C 交付证据",
    created_by: executor,
    role: "executor",
    binding: { revision_kind: "code", revision: codeRev },
  });
  raceFx.greenEvidence["T-C"] = blob.sha256;
  const loose = path.join(raceFx.root, "notes", "proof.txt");
  write(loose, "外部材料：可读的相对路径证据\n");
}

// ══════════════════════ MCP 端到端（真起后端 + 真起 MCP 客户端子进程） ══════════════════════

let serverChild: ChildProcess | null = null;

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

interface McpCallResult {
  isError: boolean;
  text: string;
  json: any;
}

interface McpClient {
  name: string;
  client: Client;
  transport: StdioClientTransport;
  call: (name: string, args: Record<string, unknown>) => Promise<McpCallResult>;
  close: () => Promise<void>;
}

const mcpClients: McpClient[] = [];

async function startMcp(name: string): Promise<McpClient> {
  const tsxCli = path.join(REPO, "node_modules", "tsx", "dist", "cli.mjs");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [tsxCli, path.join(REPO, "src", "mcp", "index.ts")],
    cwd: REPO,
    env: { ...process.env, TATAI_HOME: dataDir } as Record<string, string>,
    stderr: "inherit",
  });
  const client = new Client({ name, version: "0.0.1" });
  await client.connect(transport);
  const call = async (tool: string, args: Record<string, unknown>): Promise<McpCallResult> => {
    const r = await client.callTool({ name: tool, arguments: args });
    const text = Array.isArray(r.content)
      ? r.content
          .filter((c): c is { type: "text"; text: string } => (c as { type: string }).type === "text")
          .map((c) => c.text)
          .join("\n")
      : "";
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { isError: r.isError === true, text, json };
  };
  const wrapper: McpClient = {
    name,
    client,
    transport,
    call,
    close: async () => {
      try {
        await client.close();
      } catch {
        // 关不上不影响断言
      }
    },
  };
  mcpClients.push(wrapper);
  return wrapper;
}

const EVIDENCE_REL = "notes/proof.txt";

/** ② MCP 闭环：入口 → 认领 → 续约 → 提交重查 → 回报后读下一动作 → 释放 */
async function scenarioMcpLoop(): Promise<void> {
  info("── ② MCP 闭环（真子进程）：entry → claim → renew → submit(重查) → 下一动作 → release");
  const a = await startMcp("v0610-client-a");
  const listed = await a.client.listTools();
  const names = listed.tools.map((t) => t.name);
  ok(
    ["project_entry", "claim_task", "submit_task_result"].every((n) => names.includes(n)) &&
      names.includes("select_project"),
    `②-2 能力发现：listTools 暴露接续三件套 project_entry/claim_task/submit_task_result（共 ${names.length} 个工具）`,
    names,
  );

  const entry = await a.call("project_entry", { project_id: mainFx.id, role: "executor", client_capabilities: CONTINUABLE });
  ok(
    !entry.isError &&
      entry.json?.next_action === "claim_task" &&
      entry.json?.project?.capability?.effective === "continuable",
    `②-2 project_entry 经 MCP 返回合约形状（next_action=${entry.json?.next_action}）`,
    entry.json,
  );
  const revision = entry.json.reasons.find((r: any) => r.task_id === "T-8")?.task_revision;
  ok(typeof revision === "number", `②-2 入口给出 T-8 的当前实体版本（expected_revision=${revision}）`, entry.json.reasons);

  // 续约/释放/提交都要 token：先认领
  const claimed = await a.call("claim_task", {
    project_id: mainFx.id,
    task_id: "T-8",
    role: "executor",
    change_id: CHG,
    expected_revision: revision,
    workspace: ".工作台/runs/T-8/att-1",
  });
  const token = claimed.json?.claim?.claim_token as string | undefined;
  ok(
    !claimed.isError &&
      claimed.json?.ok === true &&
      typeof token === "string" &&
      claimed.json?.claim?.lease_expires_at !== undefined &&
      claimed.json?.claim?.attempt === 1,
    `②-1 原子领取成功：拿到 claim_token / lease_expires_at / workspace（attempt=1）`,
    claimed.json,
  );
  ok(
    revOf(mainFx, "T-8") === Number(revision) + 1,
    `②-1 领取是一次原子写：实体版本 ${revision} → ${revOf(mainFx, "T-8")}`,
  );

  // 已被有效认领 → 明确拒绝（不覆盖别人的有效认领）
  const steal = await a.call("claim_task", {
    project_id: mainFx.id,
    task_id: "T-8",
    role: "executor",
    owner_id: "another-agent",
    change_id: CHG,
    expected_revision: revOf(mainFx, "T-8"),
  });
  ok(
    steal.isError && steal.json?.code === "CLAIM_HELD" && steal.json?.read_again !== undefined,
    `②-2 已被有效认领 → 明确拒绝（code=${steal.json?.code}）+ 给重新读状态的入口`,
    steal.json,
  );

  // 续约：token 不符要拒绝；对了就续上
  const badRenew = await a.call("claim_task", {
    op: "renew",
    project_id: mainFx.id,
    task_id: "T-8",
    role: "executor",
    change_id: CHG,
    claim_token: "clm-not-mine",
    expected_revision: revOf(mainFx, "T-8"),
  });
  const renew = await a.call("claim_task", {
    op: "renew",
    project_id: mainFx.id,
    task_id: "T-8",
    role: "executor",
    change_id: CHG,
    claim_token: token,
    expected_revision: revOf(mainFx, "T-8"),
    lease_ms: 30 * 60 * 1000,
  });
  ok(
    badRenew.isError && badRenew.json?.code === "CLAIM_NOT_YOURS" && !renew.isError && renew.json?.ok === true,
    "②-2 续约只看持有者：token 不符 → CLAIM_NOT_YOURS；持有者本人 → 续约成功",
    { bad: badRenew.json, good: renew.json },
  );

  // 提交重查：token 不符 / 没证据 / 依赖未释放(另一张卡) / 正常提交
  const wrongToken = await a.call("submit_task_result", {
    project_id: mainFx.id,
    task_id: "T-8",
    role: "executor",
    change_id: CHG,
    claim_token: "clm-someone-else",
    expected_revision: revOf(mainFx, "T-8"),
    evidence_refs: [EVIDENCE_REL],
  });
  const noEvidence = await a.call("submit_task_result", {
    project_id: mainFx.id,
    task_id: "T-8",
    role: "executor",
    change_id: CHG,
    claim_token: token,
    expected_revision: revOf(mainFx, "T-8"),
    evidence_refs: [],
  });
  const badEvidence = await a.call("submit_task_result", {
    project_id: mainFx.id,
    task_id: "T-8",
    role: "executor",
    change_id: CHG,
    claim_token: token,
    expected_revision: revOf(mainFx, "T-8"),
    evidence_refs: ["notes/not-there.txt"],
  });
  ok(
    wrongToken.isError && wrongToken.json?.code === "CLAIM_NOT_YOURS",
    `②-2 提交重查①认领：token 不是当前那个 → 明确拒绝（${wrongToken.json?.code}）`,
    wrongToken.json,
  );
  ok(
    noEvidence.isError && noEvidence.json?.code === "EVIDENCE_MISSING" &&
      (noEvidence.json?.failures ?? []).some((f: string) => f.includes("没有任何证据引用")),
    `②-2 提交重查②证据：没有证据引用 → 明确拒绝（${noEvidence.json?.code}）`,
    noEvidence.json,
  );
  ok(
    badEvidence.isError && badEvidence.json?.code === "EVIDENCE_MISSING",
    `②-2 提交重查②证据：引用不存在的文件 → 明确拒绝（${badEvidence.json?.code}）`,
    badEvidence.json,
  );
  const submitted = await a.call("submit_task_result", {
    project_id: mainFx.id,
    task_id: "T-8",
    role: "executor",
    change_id: CHG,
    claim_token: token,
    expected_revision: revOf(mainFx, "T-8"),
    deliverables: ["铺路完成（src/road.ts）"],
    evidence_refs: [EVIDENCE_REL],
    verification: [{ command: "node --import tsx scripts/verify-v06-10.ts", exit_code: 0 }],
    untested: ["雨天路面表现未测"],
    known_issues: [],
    result_revision: codeRev,
  });
  ok(
    !submitted.isError &&
      submitted.json?.ok === true &&
      submitted.json?.rechecks?.revision !== undefined &&
      submitted.json?.rechecks?.claim !== undefined &&
      submitted.json?.rechecks?.evidence !== undefined,
    `②-2 提交重查全过 → 结果已提交（五查结论逐条回执）`,
    submitted.json,
  );
  ok(
    submitted.json?.next_action !== null &&
      typeof submitted.json?.next_action === "string" &&
      submitted.json?.next_action !== "resume_task",
    `②-2 回报后接着读下一动作：${submitted.json?.next_action}（不再回到 T-8 的恢复态）`,
    { next_action: submitted.json?.next_action, reasons: (submitted.json?.next_reasons ?? []).slice(0, 3) },
  );
  const afterSubmit = entryOf(mainFx.id, "executor", { client_capabilities: CONTINUABLE });
  ok(
    (afterSubmit.current_runs ?? []).every((r) => r.task_id !== "T-8") &&
      !reasonCodes(afterSubmit).includes("resume_available"),
    "②-2 提交后现场没有 T-8 的未结束 run（认领随交付结束）",
    { runs: afterSubmit.current_runs.map((r) => r.task_id), codes: reasonCodes(afterSubmit) },
  );

  // 释放：把 T-9 领上再释放，回到就绪
  const rev9 = entryOf(mainFx.id, "executor", { client_capabilities: CONTINUABLE }).reasons.find(
    (r) => r.task_id === "T-9",
  )?.task_revision;
  const claim9 = await a.call("claim_task", {
    project_id: mainFx.id,
    task_id: "T-9",
    role: "executor",
    change_id: CHG,
    expected_revision: rev9,
  });
  const release9 = await a.call("claim_task", {
    op: "release",
    project_id: mainFx.id,
    task_id: "T-9",
    role: "executor",
    change_id: CHG,
    claim_token: claim9.json?.claim?.claim_token,
    expected_revision: revOf(mainFx, "T-9"),
    reason: "先把卡交回队列（验证释放口径）",
  });
  const afterRelease = entryOf(mainFx.id, "executor", { client_capabilities: CONTINUABLE });
  ok(
    !claim9.isError &&
      !release9.isError &&
      release9.json?.ok === true &&
      (afterRelease.current_runs ?? []).every((r) => r.task_id !== "T-9"),
    "②-2 释放认领：持有者交回后 T-9 不再有未结束 run（回到可领取）",
    { claim9: claim9.json?.ok, release9: release9.json, runs: afterRelease.current_runs.map((r) => r.task_id) },
  );

  // 领取侧的依赖门禁：直连 claim 也不能越过依赖（口径与提交时一致）
  const depClaim = await a.call("claim_task", {
    project_id: mainFx.id,
    task_id: "T-2",
    role: "executor",
    change_id: CHG,
    expected_revision: revOf(mainFx, "T-2"),
  });
  ok(
    depClaim.isError &&
      depClaim.json?.code === "DEPENDENCY_UNMET" &&
      (depClaim.json?.failures ?? []).some((f: string) => f.includes("T-1")),
    `②-2 领取侧依赖门禁：T-2 的前置未释放 → 明确拒绝（${depClaim.json?.code}，逐条点名前置）`,
    depClaim.json,
  );

  // 不传 expected_revision 时按现读版本原子写（不误传 null 变成"期望实体不存在"）
  const noRev = await a.call("claim_task", {
    project_id: mainFx.id,
    task_id: "T-1",
    role: "executor",
    change_id: CHG,
  });
  const noRevRelease = await a.call("claim_task", {
    op: "release",
    project_id: mainFx.id,
    task_id: "T-1",
    role: "executor",
    change_id: CHG,
    claim_token: noRev.json?.claim?.claim_token,
    expected_revision: revOf(mainFx, "T-1"),
  });
  ok(
    !noRev.isError && noRev.json?.ok === true && noRevRelease.json?.ok === true,
    "②-1 省略 expected_revision 时按现读版本原子写（不是 null=期望实体不存在；不误报版本冲突）",
    { claim: noRev.json, release: noRevRelease.json },
  );

  // 只读入口经 MCP 也不会写事实
  const beforeRead = eventsHash(mainFx);
  await a.call("project_entry", { project_id: mainFx.id, role: "executor", client_capabilities: CONTINUABLE });
  ok(eventsHash(mainFx) === beforeRead, "① 经 MCP 的 project_entry 同样一个字节都不写（只读红线）");
}

/** ③-1 两个客户端抢同一张卡只有一个成功（真两个 MCP 客户端子进程） */
async function scenarioRace(): Promise<void> {
  info("── ③-1 两个客户端抢同一张卡：只有一个成功");
  const c1 = await startMcp("v0610-race-1");
  const c2 = await startMcp("v0610-race-2");
  const rev = revOf(raceFx, "T-A");
  ok(typeof rev === "number" && rev !== null, `③-1 前置：T-A 当前实体版本 ${rev}`);

  const args = (owner: string) => ({
    project_id: raceFx.id,
    task_id: "T-A",
    role: "executor",
    owner_id: owner,
    change_id: CHG,
    expected_revision: rev,
  });
  const [r1, r2] = await Promise.all([
    c1.call("claim_task", args("client-1")),
    c2.call("claim_task", args("client-2")),
  ]);
  const winners = [r1, r2].filter((r) => !r.isError && r.json?.ok === true);
  const losers = [r1, r2].filter((r) => r.isError);
  // V07-02（2026-09-22）判据修正：输家的合法败码两种——VERSION_CONFLICT（真并发，双方都读到
  // 同一旧版本）或 CLAIM_HELD（次序完全串行化，先者已提交活租约）。两者都证明"不静默覆盖"，
  // 断言本意是后者不是某个具体码；此前只认前者，偶发时序抖动会假红（本晚实测 3 过 1 红后复跑 3 连绿）。
  ok(
    winners.length === 1 &&
      losers.length === 1 &&
      (losers[0].json?.code === "VERSION_CONFLICT" || losers[0].json?.code === "CLAIM_HELD"),
    `③-1 两个客户端带同一 expected_revision=${rev} 抢 T-A：仅一个成功，另一个 VERSION_CONFLICT/CLAIM_HELD（不静默覆盖）`,
    { r1: { err: r1.isError, code: r1.json?.code }, r2: { err: r2.isError, code: r2.json?.code } },
  );
  const holder = liveClaimRecord(claimRecordsOf(readClaimEvents(raceFx.workDir))["T-A"]);
  ok(
    holder !== null &&
      [winners[0].json?.claim?.owner_id].includes(holder.owner_id ?? "") &&
      claimRecordsOf(readClaimEvents(raceFx.workDir))["T-A"].filter((r) => r.action === "claim").length === 1,
    `③-1 事件流里只有一条 task.claimed（持有者 ${holder?.owner_id}），没有第二条认领链`,
    claimRecordsOf(readClaimEvents(raceFx.workDir))["T-A"],
  );
  const loserEntry = entryOf(raceFx.id, "executor", { client_capabilities: CONTINUABLE });
  const taRun = loserEntry.current_runs.find((r) => r.task_id === "T-A");
  ok(
    taRun !== undefined && taRun.lease === "active" && taRun.resume_preconditions.length === RESUME_PRECONDITIONS.length,
    "③-1 入口如实报出未结束 run（租约 active）+ 接续前置条件（隔离目录/确认旧进程）",
    taRun,
  );

  // 租约语义：到期只表示"当前所有权需核实"
  const claimB = await c1.call("claim_task", {
    project_id: raceFx.id,
    task_id: "T-B",
    role: "executor",
    owner_id: "client-1",
    change_id: CHG,
    expected_revision: revOf(raceFx, "T-B"),
    lease_ms: 300,
  });
  ok(!claimB.isError, "②-2 前置：T-B 被 client-1 认领（短租约 300ms）", claimB.json);
  await sleep(600);
  const takeoverNoBasis = await c2.call("claim_task", {
    project_id: raceFx.id,
    task_id: "T-B",
    role: "executor",
    owner_id: "client-2",
    change_id: CHG,
    expected_revision: revOf(raceFx, "T-B"),
  });
  ok(
    takeoverNoBasis.isError &&
      takeoverNoBasis.json?.code === "LEASE_NEEDS_VERIFICATION" &&
      takeoverNoBasis.text.includes(LEASE_NOTE),
    "②-2 租约到期 ≠ 旧进程已停止：没给核实依据 → LEASE_NEEDS_VERIFICATION，且回执逐字带 LEASE_NOTE",
    takeoverNoBasis.json,
  );
  ok(
    takeoverNoBasis.text.includes("不证明旧进程已停止") &&
      !takeoverNoBasis.text.includes("可以安全重派") &&
      !takeoverNoBasis.text.includes("旧进程已停止（已确认）"),
    "②-2 回执不把「租约到期」说成「旧进程已停止」（红线：租约只说所有权需核实）",
    takeoverNoBasis.text.slice(0, 600),
  );
  const expiredEntry = entryOf(raceFx.id, "executor", { client_capabilities: CONTINUABLE });
  const tbRun = expiredEntry.current_runs.find((r) => r.task_id === "T-B");
  ok(
    tbRun !== undefined && tbRun.lease === "expired",
    `②-2 入口把到期租约标成 expired（当前所有权需核实，不当"已完成/已停止"）`,
    tbRun,
  );
  const takeoverOk = await c2.call("claim_task", {
    project_id: raceFx.id,
    task_id: "T-B",
    role: "executor",
    owner_id: "client-2",
    change_id: CHG,
    expected_revision: revOf(raceFx, "T-B"),
    takeover_basis: "隔离了新工作目录 .工作台/runs/T-B/att-2，并核实旧进程已退出、旧认领失效（夹具现场）",
    workspace: ".工作台/runs/T-B/att-2",
  });
  ok(
    !takeoverOk.isError &&
      takeoverOk.json?.ok === true &&
      takeoverOk.json?.claim?.attempt === 2 &&
      takeoverOk.json?.previous?.owner_id === "client-1" &&
      takeoverOk.json?.claim?.takeover_basis?.includes("隔离了新工作目录"),
    `②-2 给核实依据后重派成功：attempt=2、previous 如实带出旧持有者、核实依据进事件`,
    takeoverOk.json,
  );
}

/** ② 入口规则写到客户端能载入的位置 + 重复接入不覆盖用户自写规则（真跑 CLI，只对夹具项目） */
async function scenarioAttach(): Promise<void> {
  info("── ② 入口规则接入（真跑 scripts/attach-agents-md.ts，只对夹具项目）");
  const userRule = "# 我的项目规矩\n\n> 用户手写的规则：任何 agent 不许改动这几行。\n";
  const staleRegion =
    "<!-- tatai-mcp:start -->\n旧的约定段（过期内容，应被收敛替换）\n<!-- tatai-mcp:end -->\n";
  const attachA = makeFixture("v0610-attach-a", [], { designOnly: true });
  write(path.join(attachA.root, "AGENTS.md"), userRule + "\n" + staleRegion);
  const attachB = makeFixture("v0610-attach-b", [], { designOnly: true });

  const tsxCli = path.join(REPO, "node_modules", "tsx", "dist", "cli.mjs");
  const runCli = (projectId: string): Promise<{ code: number | null; out: string }> =>
    new Promise((resolve) => {
      const proc = spawn(process.execPath, [tsxCli, path.join("scripts", "attach-agents-md.ts"), projectId], {
        cwd: REPO,
        env: { ...process.env, TATAI_HOME: dataDir },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      proc.stdout.on("data", (d: Buffer) => (out += d.toString()));
      proc.stderr.on("data", (d: Buffer) => (out += d.toString()));
      proc.once("exit", (code) => resolve({ code, out }));
    });

  const template = read(path.join(REPO, "templates", "agents-md-snippet.md")).replace(/\s+$/, "");
  const first = await runCli(attachA.id);
  const afterFirst = read(path.join(attachA.root, "AGENTS.md"));
  ok(
    first.code === 0 && first.out.includes("已收敛标记区"),
    `②-3 首次接入过期标记段 → 只收敛标记区（CLI exit=${first.code}）`,
    first,
  );
  ok(
    afterFirst.startsWith(userRule) &&
      afterFirst.includes(staleRegion.split("\n")[1]) === false &&
      afterFirst.includes(template) &&
      afterFirst.split("<!-- tatai-mcp:start -->").length - 1 === 1,
    "②-3 标记区收敛：用户自写规则逐字节保留、旧内容被替换、只有一段标记区",
    afterFirst.slice(0, 300),
  );
  // V09-05 定向补修（2026-09-24）的回归位：更新分支**只替换标记区本体**——结束标记之后原来那一个换行
  // 必须原样（缺陷现象：模板尾换行被拼在原有后缀之前 ⇒ `<!-- tatai-mcp:end -->\n\n`，文件尾多一个空行）。
  ok(
    afterFirst.endsWith("<!-- tatai-mcp:end -->\n") && afterFirst.includes("<!-- tatai-mcp:end -->\n\n") === false,
    "②-3 收敛后结束标记之后只有**原有**那一个换行（首次 update 不多插 LF；CLI 真跑路径同判）",
    JSON.stringify(afterFirst.slice(-32)),
  );
  ok(
    afterFirst.includes("project_entry") &&
      afterFirst.includes("claim_task") &&
      afterFirst.includes("submit_task_result") &&
      afterFirst.includes("本目录接了塔台（Tatai）工作台 MCP，干活时汇报状态。") &&
      afterFirst.includes("lease") === false &&
      afterFirst.includes("租约到期只表示") ,
    "②-3 入口规则写到客户端实际载入的 AGENTS.md：含 §6.2 引用句 + 接续入口/认领/回报 + 能力如实声明",
    afterFirst.slice(afterFirst.indexOf("<!-- tatai-mcp:start -->")).slice(0, 400),
  );

  const second = await runCli(attachA.id);
  const afterSecond = read(path.join(attachA.root, "AGENTS.md"));
  ok(
    second.code === 0 && second.out.includes("逐字节未改") && afterSecond === afterFirst,
    "②-3 重复接入幂等：标记区已与模板一致 → 一个字节都不写（用户规则仍原样）",
    second,
  );

  // 用户事后手写新规则 → 再接入也不能动它
  write(path.join(attachA.root, "AGENTS.md"), afterSecond + "\n## 用户后来加的规则\n\n- 这条也不能被覆盖。\n");
  const third = await runCli(attachA.id);
  const afterThird = read(path.join(attachA.root, "AGENTS.md"));
  ok(
    third.code === 0 &&
      afterThird.includes("## 用户后来加的规则") &&
      afterThird.includes("- 这条也不能被覆盖。") &&
      afterThird.split("<!-- tatai-mcp:start -->").length - 1 === 1,
    "②-3 用户自写规则（含标记区之后的）在任何一次接入里都不被覆盖（幂等 + 收敛）",
    third,
  );

  const created = await runCli(attachB.id);
  const createdText = read(path.join(attachB.root, "AGENTS.md"));
  ok(
    created.code === 0 &&
      createdText.includes("# V06-10 夹具 v0610-attach-b AGENTS.md") &&
      createdText.includes(template),
    "②-3 没有 AGENTS.md 的项目：先建最小骨架再接入口规则",
    created,
  );
  ok(
    !fs.existsSync(path.join(REPO, "AGENTS.md.bak")) &&
      sha256File(path.join(REPO, "AGENTS.md")) === docBefore.get("AGENTS.md"),
    "②-3 红线：接入只对夹具项目真跑，塔台仓库自己的 AGENTS.md 逐字节没变",
  );
}

// ══════════════════════ 收尾 ══════════════════════

async function stopChild(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null) return;
  proc.kill("SIGKILL");
  for (let i = 0; i < 40; i += 1) {
    if (proc.exitCode !== null) break;
    await sleep(100);
  }
}

async function main(): Promise<void> {
  scenarioContract();
  scenarioMain();
  scenarioOrder();
  scenarioRole();
  scenarioPause();
  scenarioBlock();
  scenarioDone();
  scenarioNoBaseline();
  scenarioRaceFixture();

  if (await portListening(PORT)) throw new Error(`端口 ${PORT} 被占用，无法起隔离后端`);
  serverChild = spawnServer();
  await waitUp();
  info(`── 后端就绪 http://127.0.0.1:${PORT}（v2 唯一写入服务在线，MCP 走它的转派）`);

  await scenarioMcpLoop();
  await scenarioRace();
  await scenarioAttach();
}

main()
  .catch((e) => {
    console.error(`[verify] 异常：${e instanceof Error ? e.stack : String(e)}`);
    process.exitCode = 1;
    ok(false, `验证中断：${e instanceof Error ? e.message : String(e)}`);
  })
  .finally(async () => {
    for (const c of mcpClients) await c.close();
    if (serverChild !== null) await stopChild(serverChild);

    info("── 塔台根文档零改动核对（首尾逐文件 sha256；DESIGN.md 附录 B 段单独哈希）");
    for (const rel of DOC_FILES) {
      const abs = path.join(REPO, rel);
      const after = fs.existsSync(abs) ? sha256File(abs) : "<missing>";
      ok(after === docBefore.get(rel), `文档未被改动：${rel} sha256=${after.slice(0, 16)}…`);
    }
    const designAbs = path.join(REPO, "DESIGN.md");
    const appendixAfter = fs.existsSync(designAbs) ? sha256(appendixBOf(read(designAbs))) : "<missing>";
    ok(
      appendixAfter === appendixBefore.get("DESIGN.md"),
      `DESIGN.md 附录 B 段未被改动（sha256=${appendixAfter.slice(0, 16)}…）`,
    );

    if (process.env.TATAI_KEEP_TMP === "1") {
      info(`保留现场：${tmpBase}`);
    } else {
      fs.rmSync(tmpBase, { recursive: true, force: true });
      info(`夹具已清理：${path.basename(tmpBase)}`);
    }
    console.log(`\n[verify] V06-10 结果：${passCount} PASS / ${failCount} FAIL（exit ${process.exitCode ?? 0}）`);
  });
