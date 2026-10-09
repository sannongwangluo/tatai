// V09-41 验证脚本（PLAN V09-41；docs/efficiency-20261004.md「Agent 协作提效」第 1 条）。
// 用法：pnpm exec tsx scripts/verify-task-brief.ts
//
// 自带隔离环境：临时 `TATAI_HOME` + `os.tmpdir()` 下的夹具项目，**不碰**任何真实项目的 `.工作台/`。
//
// 行为测试（先红后绿）——task_brief 只读、复用 project_entry **一次**同版判据，做紧凑白名单投影：
//   ① 契约与注册：工具已登记；入参 = project_entry 的五个 + V09-41 第二轮新增三个详略入参
//      （detail/reason_index/reasons_revision；仍**不强制 task_id**、**不额外 preconditions**）；
//      旧全量断言显式 `detail=full`（取原版本完整简报，新入参不转发 project_entry）；
//   ② 无损：**全部 reasons 原样逐条**（blocking 与说明性理由一视同仁，不过滤/不截断/不补齐）、
//      current_runs / required_reads / sync / next_action / 角色能力 / 生效基线与 valid 与完整入口一致；
//   ③ 当前卡最小：只给 task_id/task_revision，其余（完成要求/允许范围）在同份 reasons 里；
//   ④ 角色：责任角色不符 → await_role + role_mismatch 原样保留；
//   ⑤ 阻断：blocked 现场的全部 blocking 理由**一条都不能少**（含 20 条阻塞的负例，不按数量截断）；
//   ⑤c checkpoint：非阻断、不指向任务的说明性理由（checkpoint_available）不再被当"说明"丢掉；
//   ⑥ 错误：isError 原样透传（与 project_entry 逐字节同）；
//   ⑦ 省略披露：project.documents / context_manifest 不内联，omitted.fields 只列字段名 + 补取入口；
//      不声称 versions/source 被省略（它们原样保留）；2026-10-04 复审 P2-1：图更新原因取真实
//      `update_reason`，`omitted.fields` 如实列全被省略的 graph_summary 域；blocked 现场不选中任务（P2-4）；
//   ⑧ 显著缩小：raw 与**紧凑序列化**两种口径都显著更小（不把空格当全部收益）；
//   ⑨ 未声明能力仍 read_only；resume_hint 可用且不越权；
//   ⑩ 只读：events.jsonl 逐字节不变、没有 task.claimed；buildTaskBrief 不改输入；
//   ⑪ versions/source 透传（宿主路径字段；本地回退为 null，投影层逐字保留）；
//   ⑫ 真实示例项目快照对照（仓外 ../evidence/entry-before.json）并落体积证据 ../evidence/brief-size.json。
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { addProject } from "../src/server/registry";
import { projectWorkDir } from "../src/server/workstation";
import { activateBaseline } from "../src/server/work/documents";
import { importTaskDefinitions, type TaskDefinition } from "../src/server/work/plan";
import { WorkService } from "../src/server/work/service";
import { readTaskStates, submitDefinitionImports, submitTaskStatus } from "../src/server/work/tasks";
import { claimRecordsOf, readClaimEvents } from "../src/server/work/claims";
import { saveCheckpoint, type ResumeCheckpoint } from "../src/server/work/context";
import { buildTaskBrief, type EntryFull } from "../src/server/work/taskBrief";
import { markdownSectionDigest } from "../src/shared/materialSection";
import { findTool, TOOLS } from "../src/mcp/tools/index";
import { projectEntryTool } from "../src/mcp/tools/projectEntry";
import { taskBriefTool } from "../src/mcp/tools/taskBrief";
import type { ToolResult } from "../src/mcp/tools/types";

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
const sha256 = (data: string | Buffer): string => crypto.createHash("sha256").update(data).digest("hex");

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE_DIR = path.resolve(REPO, "..", "evidence");
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-taskbrief-verify-"));
const dataDir = path.join(tmpBase, "home");
fs.mkdirSync(dataDir, { recursive: true });
process.env.TATAI_HOME = dataDir;
const service = new WorkService({ dataDir });
const CHG = "chg-taskbrief";
const executor = "kimi-code";
const CONTINUABLE = { can_read: true, can_continue: true };

const mkdirp = (d: string) => fs.mkdirSync(d, { recursive: true });
const write = (f: string, text: string) => {
  mkdirp(path.dirname(f));
  fs.writeFileSync(f, text, "utf8");
};

interface Card {
  id: string;
  goal: string;
  dep?: string;
  priority?: string;
  role?: string;
  paths?: string[];
  checks?: string[];
}

function planText(title: string, cards: Card[]): string {
  const lines = [
    `# ${title}`,
    "",
    "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const c of cards) {
    lines.push(`| ${c.id} | todo | ${c.goal} | ${c.dep ?? ""} | ${c.id} 的完成证据 |`);
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
  defs: TaskDefinition[];
}

const fixtures: Fixture[] = [];

function makeFixture(id: string, cards: Card[]): Fixture {
  const root = path.join(tmpBase, id);
  mkdirp(path.join(root, ".工作台"));
  write(path.join(root, ".工作台", "design.md"), `# ${id} 设计书\n\n## 1 目标\n\n夹具项目的设计正文。\n`);
  const plan = planText(`${id} 施工图`, cards);
  write(path.join(root, ".工作台", "plan.md"), plan);
  addProject({ id, name: `V09-41 夹具 ${id}`, path: root, kind: "backend" }, dataDir);
  const imported = importTaskDefinitions(plan, { plan_revision: sha256(plan) });
  const fx: Fixture = { id, root, workDir: projectWorkDir(id, dataDir), defs: imported.definitions };
  fixtures.push(fx);
  activateBaseline(id, { approved_by: "user", approval_basis: "V09-41 夹具审定", approval_kind: "user_confirmed" }, dataDir);
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

function setStatus(fx: Fixture, taskId: string, status: Parameters<typeof submitTaskStatus>[1]["status"], reason?: string) {
  return submitTaskStatus(service, {
    project_id: fx.id,
    task_id: taskId,
    change_id: CHG,
    actor_id: executor,
    role: "executor",
    expected_revision: revOf(fx, taskId),
    status,
    ...(reason === undefined ? {} : { reason }),
  });
}

// ── 工具调用辅助（直接调 handler，进程内；只读工具不需要 ctx.work） ──

interface CallResult {
  isError: boolean;
  text: string;
  json: any;
}

async function callTool(tool: { handler: (args: Record<string, unknown>, ctx?: any) => Promise<ToolResult> | ToolResult }, args: Record<string, unknown>): Promise<CallResult> {
  const r = await tool.handler(args);
  const text = (r.content ?? [])
    .filter((c): c is { type: "text"; text: string } => (c as { type: string }).type === "text")
    .map((c) => c.text)
    .join("\n");
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { isError: r.isError === true, text, json };
}

// 旧全量断言：显式 detail=full 取原版本完整简报（detail 不转发 project_entry，omitted.refetch.args 仍是原 args）。
const briefOf = (args: Record<string, unknown>) => callTool(taskBriefTool, { detail: "full", ...args });
const fullOf = (args: Record<string, unknown>) => callTool(projectEntryTool, args);

const eventsHash = (fx: Fixture): string => {
  const f = path.join(fx.workDir, "events.jsonl");
  return fs.existsSync(f) ? sha256(fs.readFileSync(f)) : "<none>";
};
const blockingPairs = (entry: any): string[] =>
  (Array.isArray(entry?.reasons) ? entry.reasons : [])
    .filter((r: any) => r.blocking === true)
    .map((r: any) => `${r.code}|${r.text}`);

// ── ① 契约与注册 ──

function scenarioContract(): void {
  info("── ① 契约与注册（入参 = project_entry 五个 + detail/reason_index/reasons_revision；不强制 task；不额外 preconditions）");
  const tool = findTool("task_brief");
  ok(tool !== undefined && tool.name === "task_brief", "① task_brief 已登记进工具注册表（findTool 命中）");
  ok(TOOLS.some((t) => t.name === "task_brief"), "① TOOLS 里可见 task_brief");
  const schema = tool?.inputSchema as { properties?: Record<string, unknown>; required?: string[]; additionalProperties?: boolean } | undefined;
  const props = Object.keys(schema?.properties ?? {}).sort();
  ok(
    JSON.stringify(props) ===
      JSON.stringify(["client_capabilities", "detail", "expected_revision", "known_revision", "project_id", "reason_index", "reasons_revision", "resume_hint", "role"]),
    `① 入参 = project_entry 的五个 + 三个详略入参 + V09-53 的 expected_revision（工作包包版本；不强制 task_id、不额外 preconditions）：${props.join("/")}`,
    props,
  );
  ok(
    JSON.stringify(schema?.required) === JSON.stringify(["project_id", "role"]) && schema?.additionalProperties === false,
    "① 必填只有 project_id/role，且 additionalProperties=false",
    schema,
  );
}

// ── ②③⑦⑧⑪⑩⑨ 主夹具：理由全量无损 / 当前卡最小 / 省略披露 / 显著缩小 ──

async function scenarioMain(): Promise<void> {
  info("── ②③⑦⑧ 主夹具：理由全量原样无损 + 当前卡最小 + 省略披露 + 显著缩小");
  const fx = makeFixture("tb-main", [
    { id: "T-1", goal: "打地基", priority: "高", paths: ["src/foundation.ts"], checks: ["地基水平达标", "回填分层合格"] },
    { id: "T-9", goal: "种树", priority: "低", paths: ["src/tree.ts"] },
  ]);
  const args = { project_id: fx.id, role: "executor", client_capabilities: CONTINUABLE };
  const full = await fullOf(args);
  const brief = await briefOf(args);
  ok(!full.isError && !brief.isError, `② 完整入口与简报都成功（full=${full.isError} brief=${brief.isError}）`, { full: full.json, brief: brief.json });

  // next_action 一致
  ok(brief.json?.next_action === full.json?.next_action, `② next_action 一致：${brief.json?.next_action}`);
  ok(brief.json?.next_action === "claim_task", "② 主夹具现场可领取（claim_task）", brief.json?.next_action);

  // 全部理由**原样逐条**（不再过滤/不补齐 null/空数组）——blocking 与说明性理由一视同仁
  ok(
    JSON.stringify(brief.json?.reasons) === JSON.stringify(full.json?.reasons),
    `② 全部理由原样逐条无损（${(full.json?.reasons ?? []).length} 条：blocking 与说明性理由都不丢）`,
    { full: full.json?.reasons, brief: brief.json?.reasons },
  );
  ok(
    JSON.stringify(blockingPairs(brief.json)) === JSON.stringify(blockingPairs(full.json)),
    `② 全部 blocking 理由逐条无损（${blockingPairs(full.json).length} 条）`,
    { full: blockingPairs(full.json), brief: blockingPairs(brief.json) },
  );
  ok(
    (brief.json?.reasons ?? []).some((r: any) => r.code === "baseline_active"),
    "② 说明性理由（如 baseline_active）也原样保留，不被当'说明'丢掉",
    (brief.json?.reasons ?? []).map((r: any) => r.code),
  );

  // 角色 / 能力 / 基线
  ok(
    brief.json?.project?.role === "executor" &&
      brief.json?.project?.role_class === "executor" &&
      brief.json?.project?.capability?.effective === "continuable",
    "② 角色与能力档位保留（executor / continuable）",
    brief.json?.project,
  );
  ok(
    brief.json?.baseline?.valid === full.json?.baseline?.valid &&
      brief.json?.baseline?.active?.baseline_id === full.json?.baseline?.active?.baseline_id,
    "② 生效基线与 valid 与完整入口一致",
    { brief: brief.json?.baseline, full: full.json?.baseline },
  );

  // 当前卡最小：task_id / task_revision；细节（完成要求/范围）在同份 reasons 里
  const fullChosen = (full.json?.reasons ?? []).find((r: any) => r.code === "claimable" && r.task_id !== null);
  ok(
    brief.json?.current_task?.task_id === "T-1" &&
      brief.json?.current_task?.task_id === fullChosen?.task_id &&
      brief.json?.current_task?.task_revision === fullChosen?.task_revision &&
      typeof brief.json?.current_task?.task_revision === "number",
    `③ 当前任务最小（task_id=${brief.json?.current_task?.task_id} / revision=${brief.json?.current_task?.task_revision}）与完整入口选中的卡一致`,
    { brief: brief.json?.current_task, full: fullChosen },
  );
  ok(
    JSON.stringify(Object.keys(brief.json?.current_task ?? {}).sort()) === JSON.stringify(["task_id", "task_revision"]),
    "③ 当前卡只给 task_id/task_revision（完成要求/范围在同份 reasons 里，不再另存一份）",
    Object.keys(brief.json?.current_task ?? {}),
  );
  const chosenInBrief = (brief.json?.reasons ?? []).find((r: any) => r.code === "claimable" && r.task_id === "T-1");
  ok(
    JSON.stringify(chosenInBrief?.completion_requirements) === JSON.stringify(fullChosen?.completion_requirements) &&
      (chosenInBrief?.completion_requirements?.length ?? 0) > 0 &&
      (chosenInBrief?.allowed_paths ?? []).includes("src/foundation.ts"),
    "③ 完成要求/允许范围在当前卡的 reason 里逐条保留",
    chosenInBrief,
  );

  // required_reads / current_runs / sync 无损
  ok(
    JSON.stringify(brief.json?.required_reads) === JSON.stringify(full.json?.required_reads) &&
      (brief.json?.required_reads?.length ?? 0) > 0,
    "② required_reads（路径/版本/范围/why）原样与完整入口一致",
    brief.json?.required_reads,
  );
  ok(
    JSON.stringify(brief.json?.current_runs) === JSON.stringify(full.json?.current_runs),
    "② current_runs（执行所有权必要信息）原样与完整入口一致",
    { brief: brief.json?.current_runs, full: full.json?.current_runs },
  );
  ok(JSON.stringify(brief.json?.sync) === JSON.stringify(full.json?.sync_summary), "② sync 阻断摘要与完整入口一致", brief.json?.sync);

  // 图：同一快照标识 + get_project_graphs 入口；只给简状态，不带六图计数/交付判词
  const fullSnap = full.json?.graph_summary?.snapshot_id;
  ok(
    brief.json?.graph?.next_read_entry?.tool === "get_project_graphs" &&
      (fullSnap === undefined || brief.json?.graph?.snapshot_id === fullSnap),
    "② 图给同一快照标识 + get_project_graphs 入口",
    { graph: brief.json?.graph, fullSnap },
  );
  const graphKeys = Object.keys(brief.json?.graph ?? {});
  ok(
    ["availability", "update_state", "semantic_state", "snapshot_id"].every((k) => graphKeys.includes(k)) &&
      graphKeys.includes("anomalies") &&
      graphKeys.includes("next_read_entry") &&
      !graphKeys.includes("graphs") &&
      !graphKeys.includes("delivery") &&
      !graphKeys.includes("capability_table_state"),
    "② 图只给 availability/update_state/semantic_state/snapshot_id/异常/next_read_entry（不带六图计数与交付判词）",
    graphKeys,
  );

  // ⑦ 省略披露：不内联 project.documents / context_manifest，并给补取入口
  ok(
    !("context_manifest" in (brief.json ?? {})) &&
      !("documents" in (brief.json?.project ?? {})),
    "⑦ 冗长字段不内联（没有顶层 context_manifest / project.documents）",
    Object.keys(brief.json ?? {}),
  );
  ok(
    (brief.json?.omitted?.fields ?? []).includes("context_manifest") &&
      (brief.json?.omitted?.fields ?? []).some((f: string) => f.includes("documents")),
    "⑦ omitted.fields 只用字段名披露省略了哪些（简短数组）",
    brief.json?.omitted?.fields,
  );
  ok(
    brief.json?.omitted?.refetch?.tool === "project_entry" &&
      JSON.stringify(brief.json?.omitted?.refetch?.args) === JSON.stringify(args),
    "⑦ 补取入口指向 project_entry 且参数原样（同版判据）",
    brief.json?.omitted?.refetch,
  );
  ok(
    brief.json?.omitted?.reasons_omitted_codes === undefined &&
      !("note" in (brief.json?.omitted ?? {})),
    "⑦ omitted 不再列被裁理由/长解释（理由全量保留）",
    Object.keys(brief.json?.omitted ?? {}),
  );
  ok(
    !(brief.json?.omitted?.fields ?? []).some((f: string) => /versions|source/i.test(f)) &&
      "versions" in (brief.json ?? {}) &&
      "source" in (brief.json ?? {}),
    "⑦ 不声称 versions/source 被省略（它们原样保留在顶层）",
    { fields: brief.json?.omitted?.fields, versions: brief.json?.versions, source: brief.json?.source },
  );

  // ⑧ 显著缩小：raw 与紧凑序列化两种口径（不能把空格当全部收益）
  const fullRawLen = full.text.length;
  const briefRawLen = brief.text.length;
  const fullCompactLen = JSON.stringify(full.json).length;
  info(
    `   —— 完整入口 raw ${fullRawLen} 字符 / compact ${fullCompactLen} 字符；简报 ${briefRawLen} 字符` +
      `（raw 比值 ${(briefRawLen / fullRawLen).toFixed(3)}，compact 比值 ${(briefRawLen / fullCompactLen).toFixed(3)}）`,
  );
  ok(briefRawLen < fullRawLen, `⑧ 简报字符数少于完整入口原样（${briefRawLen} < ${fullRawLen}）`, { fullRawLen, briefRawLen });
  ok(
    briefRawLen < fullCompactLen * 0.8,
    `⑧ 去掉缩进/换行后仍显著更小（${briefRawLen} < ${Math.round(fullCompactLen * 0.8)}，不把空格当全部收益）`,
    { fullCompactLen, briefRawLen },
  );

  // ⑪ versions/source：本地回退路径为 null，投影层保留字段位（宿主路径逐字透传见 scenarioPassthrough）
  ok(
    "versions" in (brief.json ?? {}) && "source" in (brief.json ?? {}),
    "⑪ 简报保留 versions/source 字段位（本地回退为 null；宿主路径逐字透传）",
    { versions: brief.json?.versions, source: brief.json?.source },
  );

  // ⑩ 只读红线
  const before = eventsHash(fx);
  await briefOf(args);
  await briefOf({ ...args, resume_hint: "T-1" });
  const claims = claimRecordsOf(readClaimEvents(fx.workDir))["T-1"] ?? [];
  ok(eventsHash(fx) === before && claims.length === 0, "⑩ 简报只读：events.jsonl 逐字节不变、没有 task.claimed", { claims: claims.length });

  // ⑨ resume_hint 支持且不越权
  const hinted = await briefOf({ ...args, resume_hint: "T-9" });
  ok(hinted.json?.current_task?.task_id === "T-9", "⑨ 支持 resume_hint（指到 T-9 就选 T-9）", hinted.json?.current_task);
  const badHint = await briefOf({ ...args, resume_hint: "T-999" });
  ok(
    badHint.json?.current_task?.task_id === "T-1" &&
      (badHint.json?.reasons ?? []).some((r: any) => r.code === "resume_hint_unusable"),
    "⑨ 无效 resume_hint 不越权：回落默认顺序（T-1），unusable 理由原样在 reasons 里",
    { task: badHint.json?.current_task?.task_id, codes: (badHint.json?.reasons ?? []).map((r: any) => r.code) },
  );

  // 未声明能力仍 read_only（不额外默认）
  const undeclared = await briefOf({ project_id: fx.id, role: "executor" });
  ok(
    undeclared.json?.project?.capability?.effective === "read_only" &&
      undeclared.json?.next_action === "await_role",
    "⑨ 未声明 client_capabilities 仍按「仅可读取」处理（read_only + await_role），不假称可认领",
    { capability: undeclared.json?.project?.capability, action: undeclared.json?.next_action },
  );

  // 不额外 preconditions 默认：传入也不转发（简报里没有 preconditions 字段）
  const withPre = await briefOf({ ...args, preconditions: true });
  ok(
    !("preconditions" in (withPre.json ?? {})) &&
      withPre.json?.omitted?.refetch?.args?.preconditions === undefined &&
      !JSON.stringify(withPre.json).includes('"preconditions"'),
    "① 不额外 preconditions：即使传入也不转发、不出现 preconditions 字段",
    { keys: Object.keys(withPre.json ?? {}), refetch: withPre.json?.omitted?.refetch?.args },
  );
}

// ── ④ 角色：责任角色不符 → await_role 原样 ──

async function scenarioRole(): Promise<void> {
  info("── ④ 角色：责任角色不符 → await_role + role_mismatch 无损");
  const fx = makeFixture("tb-role", [{ id: "T-1", goal: "独立复核", role: "审计者", checks: ["复核结论有证据"] }]);
  const args = { project_id: fx.id, role: "executor", client_capabilities: CONTINUABLE };
  const full = await fullOf(args);
  const brief = await briefOf(args);
  ok(
    brief.json?.next_action === "await_role" &&
      brief.json?.next_action === full.json?.next_action &&
      (brief.json?.reasons ?? []).some((r: any) => r.code === "role_mismatch" && r.blocking === true),
    "④ 角色不符：简报同样 await_role，且 role_mismatch（blocking）原样保留",
    { action: brief.json?.next_action, codes: (brief.json?.reasons ?? []).map((r: any) => r.code) },
  );
  ok(
    JSON.stringify(brief.json?.reasons) === JSON.stringify(full.json?.reasons),
    "④ 角色现场的全部理由与完整入口逐条一致",
    { brief: brief.json?.reasons, full: full.json?.reasons },
  );
}

// ── ⑤ 阻断：blocked 现场全部 blocking 理由一条不少 ──

async function scenarioBlocked(): Promise<void> {
  info("── ⑤ 阻断：blocked 现场全部 blocking 理由一条不少");
  const fx = makeFixture("tb-blocked", [
    { id: "T-1", goal: "打地基", priority: "高", checks: ["地基水平达标"] },
    { id: "T-2", goal: "砌墙", dep: "T-1", priority: "高" },
  ]);
  setStatus(fx, "T-1", "blocked", "等勘探报告，暂时打不了");
  const args = { project_id: fx.id, role: "executor", client_capabilities: CONTINUABLE };
  const full = await fullOf(args);
  const brief = await briefOf(args);
  const fullBlocking = blockingPairs(full.json);
  ok(
    brief.json?.next_action === "blocked" && brief.json?.next_action === full.json?.next_action,
    "⑤ 阻断现场：简报 next_action=blocked（与完整入口一致）",
    brief.json?.next_action,
  );
  ok(fullBlocking.length >= 2, `⑤ 前置：完整入口确有 ≥2 条 blocking 理由（实为 ${fullBlocking.length}）`, fullBlocking);
  ok(
    JSON.stringify(blockingPairs(brief.json)) === JSON.stringify(fullBlocking),
    `⑤ 全部 blocking 理由逐条保留（${fullBlocking.length} 条，不按数量截断）`,
    { brief: blockingPairs(brief.json), full: fullBlocking },
  );
  ok(
    (brief.json?.reasons ?? []).some((r: any) => r.code === "blocked_task" && (r.text ?? "").includes("等勘探报告")) &&
      (brief.json?.reasons ?? []).some((r: any) => r.code === "no_ready_task"),
    "⑤ blocked_task / no_ready_task 等阻断理由的完整文本都在（why 不丢）",
    (brief.json?.reasons ?? []).map((r: any) => r.code),
  );
  // 2026-10-04（独立集成复审 P2-4）：blocked 现场**不**把阻塞任务当"选中任务"（current_task=null），
  // 阻塞任务的 task_id/说明仍在原样保留的 reasons 里——只澄清注释/行为表述，不新增选卡逻辑。
  ok(
    brief.json?.current_task === null &&
      (brief.json?.reasons ?? []).some((r: any) => r.code === "blocked_task" && typeof r.task_id === "string" && r.task_id !== ""),
    "⑤ blocked 现场 current_task=null（阻塞任务不当选中任务），其信息仍在 reasons 里（不丢）",
    {
      current_task: brief.json?.current_task,
      blocked: (brief.json?.reasons ?? []).filter((r: any) => r.code === "blocked_task").map((r: any) => r.task_id),
    },
  );
}

// ── ⑤b 负例：20 个阻塞任务，blocking 理由一条不丢 ──

async function scenarioBlocked20(): Promise<void> {
  info("── ⑤b 负例：20 个阻塞任务，blocking 理由一条不丢（不按数量截断/过滤）");
  const cards: Card[] = Array.from({ length: 20 }, (_, i) => ({ id: `B-${i + 1}`, goal: `阻塞项 ${i + 1}` }));
  const fx = makeFixture("tb-blocked20", cards);
  for (const c of cards) setStatus(fx, c.id, "blocked", `${c.id} 等前置条件`);
  const args = { project_id: fx.id, role: "executor", client_capabilities: CONTINUABLE };
  const full = await fullOf(args);
  const brief = await briefOf(args);
  const fullBlocking = blockingPairs(full.json);
  const blockedTaskCount = fullBlocking.filter((p) => p.startsWith("blocked_task|")).length;
  ok(blockedTaskCount >= 20, `⑤b 前置：完整入口确有 ≥20 条 blocked_task 阻断（实为 ${blockedTaskCount}）`, blockedTaskCount);
  ok(
    brief.json?.next_action === "blocked" && brief.json?.next_action === full.json?.next_action,
    "⑤b 阻断现场：简报 next_action=blocked",
    brief.json?.next_action,
  );
  ok(
    JSON.stringify(brief.json?.reasons) === JSON.stringify(full.json?.reasons) &&
      blockingPairs(brief.json).length === fullBlocking.length &&
      blockingPairs(brief.json).length >= 20,
    `⑤b 20 条阻塞理由一条不丢（brief blocking=${blockingPairs(brief.json).length} / full=${fullBlocking.length}）`,
    { briefCount: blockingPairs(brief.json).length, fullCount: fullBlocking.length },
  );
}

// ── ⑤c checkpoint：说明性理由不再被当"说明"丢掉 ──

async function scenarioCheckpoint(): Promise<void> {
  info("── ⑤c checkpoint：非阻断、不指向任务的说明性理由（checkpoint_available）不再被丢");
  const fx = makeFixture("tb-checkpoint", [{ id: "T-1", goal: "打地基", paths: ["src/a.ts"], checks: ["达标"] }]);
  const ckpt: ResumeCheckpoint = {
    schema_version: 1,
    checkpoint_id: "ckpt-verify-taskbrief",
    project_id: fx.id,
    created_at: new Date().toISOString(),
    package_id: "pkg-verify",
    design_revision: null,
    plan_revision: null,
    reason: "interrupted",
    detail: "验证用检查点",
    confirmed_sources: [],
    pending_paths: [],
    resume_position: null,
  };
  ok(saveCheckpoint(fx.id, ckpt, dataDir), "⑤c 前置：检查点落盘成功");
  const args = { project_id: fx.id, role: "executor", client_capabilities: CONTINUABLE };
  const full = await fullOf(args);
  const brief = await briefOf(args);
  ok(
    (full.json?.reasons ?? []).some((r: any) => r.code === "checkpoint_available"),
    "⑤c 前置：完整入口带 checkpoint_available 理由",
    (full.json?.reasons ?? []).map((r: any) => r.code),
  );
  ok(
    (brief.json?.reasons ?? []).some((r: any) => r.code === "checkpoint_available" && (r.text ?? "").includes("续接位置")) &&
      JSON.stringify(brief.json?.reasons) === JSON.stringify(full.json?.reasons),
    "⑤c checkpoint_available（非阻断、不指向任务）原样保留，不因'说明性'被丢",
    (brief.json?.reasons ?? []).filter((r: any) => r.code === "checkpoint_available"),
  );
}

// ── ⑤d 纯函数：buildTaskBrief 不改输入 ──

async function scenarioNoMutation(): Promise<void> {
  info("── ⑤d buildTaskBrief 不改输入（纯函数）");
  const fx = makeFixture("tb-nomut", [{ id: "T-1", goal: "打地基", paths: ["src/a.ts"], checks: ["达标"] }]);
  const full = await fullOf({ project_id: fx.id, role: "executor", client_capabilities: CONTINUABLE });
  const input = full.json as EntryFull;
  const snapshot = JSON.stringify(input);
  const brief = buildTaskBrief(input, { project_id: fx.id, role: "executor" });
  ok(JSON.stringify(input) === snapshot, "⑤d 调用后输入对象逐字段不变（没有就地改写）", { unchanged: JSON.stringify(input) === snapshot });
  ok(brief.reasons === input.reasons, "⑤d reasons 原样引用（未过滤/未重建）");
}

// ── ⑥ 错误：isError 原样透传 ──

async function scenarioError(): Promise<void> {
  info("── ⑥ 错误：isError 原样透传（与 project_entry 逐字节同）");
  for (const args of [
    { project_id: "does-not-exist", role: "executor" },
    {},
    { project_id: "any", role: "" },
  ]) {
    const full = await fullOf(args);
    const brief = await briefOf(args);
    ok(
      full.isError === true && brief.isError === true && brief.text === full.text,
      `⑥ 错误无损透传（args=${JSON.stringify(args)}）：isError=${brief.isError}，文本逐字节相同`,
      { full: full.text.slice(0, 300), brief: brief.text.slice(0, 300) },
    );
  }
}

// ── ⑪ versions/source 透传（宿主路径字段；投影层逐字保留） ──

async function scenarioPassthrough(): Promise<void> {
  info("── ⑪ 投影层逐字保留宿主路径的 versions/source（本地回退为 null）");
  const fx = makeFixture("tb-passthrough", [{ id: "T-1", goal: "打地基", paths: ["src/a.ts"], checks: ["达标"] }]);
  const full = await fullOf({ project_id: fx.id, role: "executor", client_capabilities: CONTINUABLE });
  const synthetic = {
    ...full.json,
    versions: { baseline_id: "b-1", design_revision: "d-1", plan_revision: "p-1", plan_definition_revision: "pd-1", graph_snapshot_id: "g-1", ledger: { content_sha256: "abc", verified_bytes: 10, file_bytes: 10, events: 1 } },
    source: { ledger: "events.jsonl", events_snapshot: "shared", events_snapshot_unreadable: null, sources_stable: true, sources_stale_reasons: [], attempts: 1 },
  } as unknown as EntryFull;
  const brief = buildTaskBrief(synthetic, { project_id: fx.id, role: "executor" });
  ok(
    (brief.versions as any)?.baseline_id === "b-1" &&
      (brief.source as any)?.events_snapshot === "shared",
    "⑪ buildTaskBrief 逐字透传 versions/source（宿主路径字段不丢）",
    { versions: brief.versions, source: brief.source },
  );
  const noHost = buildTaskBrief(full.json as EntryFull, { project_id: fx.id, role: "executor" });
  ok(noHost.versions === null && noHost.source === null, "⑪ 本地回退（无宿主字段）时 versions/source 如实为 null，不伪造", {
    versions: noHost.versions,
    source: noHost.source,
  });
}

// ── ⑫ 真实示例项目快照对照 + 体积证据 ──

function scenarioRealSnapshot(): void {
  info("── ⑫ 真实示例项目快照对照（仓外 ../evidence/entry-before.json）并落体积证据");
  const snapPath = path.join(EVIDENCE_DIR, "entry-before.json");
  if (!fs.existsSync(snapPath)) {
    info(`   跳过：仓外快照不存在（${snapPath}）——不改判定，只如实说明`);
    return;
  }
  const raw = fs.readFileSync(snapPath, "utf8");
  const parsed = JSON.parse(raw) as EntryFull;
  const reasonsFull = Array.isArray((parsed as any).reasons) ? (parsed as any).reasons.length : 0;
  const graphRows = Array.isArray((parsed as any).graph_summary?.graphs) ? (parsed as any).graph_summary.graphs.length : 0;

  const brief = buildTaskBrief(parsed, { project_id: "示例项目", role: "executor" });
  const briefText = JSON.stringify(brief);
  const compactFull = JSON.stringify(parsed);
  const briefBytes = Buffer.byteLength(briefText);
  const compactFullBytes = Buffer.byteLength(compactFull);

  const size = {
    source: "../evidence/entry-before.json",
    note:
      "仅比较 project_entry / task_brief 的**返回体**（字符与 UTF-8 字节）：raw=入口原样（pretty），" +
      "compact=同一对象的紧凑 JSON 序列化。**这不是模型总 token 节省比例**——不含系统提示、工具定义、" +
      "历史上下文、推理过程与客户端包装等开销，仅是本工具返回体的体积对照。",
    full: {
      raw_chars: raw.length,
      raw_bytes: Buffer.byteLength(raw),
      compact_chars: compactFull.length,
      compact_bytes: compactFullBytes,
    },
    brief: { chars: briefText.length, bytes: briefBytes },
    reduction: {
      raw_chars_ratio: +(briefText.length / raw.length).toFixed(4),
      compact_chars_ratio: +(briefText.length / compactFull.length).toFixed(4),
      compact_bytes_ratio: +(briefBytes / compactFullBytes).toFixed(4),
      saved_compact_chars: compactFull.length - briefText.length,
      saved_compact_bytes: compactFullBytes - briefBytes,
    },
    full_reasons_count: reasonsFull,
    brief_reasons_count: brief.reasons.length,
    full_graph_summary_graph_rows: graphRows,
    brief_graph_has_graphs: "graphs" in (brief.graph as any),
  };
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const outPath = path.join(EVIDENCE_DIR, "brief-size.json");
  fs.writeFileSync(outPath, JSON.stringify(size, null, 2) + "\n", "utf8");
  info(`   已写体积证据：${outPath}`);

  ok(
    briefText.length < compactFull.length && brief.reasons.length === reasonsFull,
    `⑫ 真实快照：简报紧凑体 < 完整入口紧凑体 且 理由条数无损（${briefText.length} < ${compactFull.length}；reasons ${brief.reasons.length}/${reasonsFull}）`,
    size.reduction,
  );
  ok(graphRows >= 6 && !size.brief_graph_has_graphs, `⑫ 真实快照：完整入口六图明细 ${graphRows} 行不再进简报（只给入口）`, size);
}

// ── ⑦b 图摘要投影：reason 取真实 update_reason；omitted 如实列全被省略域（2026-10-04 复审 P2-1） ──

async function scenarioGraphProjection(): Promise<void> {
  info("── ⑦b 图摘要投影：reason 取真实 update_reason；omitted.fields 如实列全被省略域");
  const fx = makeFixture("tb-graph", [{ id: "T-1", goal: "打地基", paths: ["src/a.ts"], checks: ["达标"] }]);
  const full = await fullOf({ project_id: fx.id, role: "executor", client_capabilities: CONTINUABLE });
  const synthetic = {
    ...full.json,
    graph_summary: {
      ...(full.json?.graph_summary ?? {}),
      // 真实 graphSummaryOf 只产出 update_reason（从不产出顶层 reason）
      update_reason: "图更新中：正在采集模块",
      update_phase: "collecting",
      update_eta_text: "约 2 分钟",
      banners: ["图更新中"],
      delivery: { verdict: "pending", conclusion: "待验证", user_pending: 1, blocking_reasons: 0 },
      capability_table_state: "declared",
      baseline_id: "b-1",
      read_at: "2026-10-04T00:00:00+08:00",
      generated_at: "2026-10-04T00:00:00+08:00",
      reason: undefined,
    },
  } as unknown as EntryFull;
  const brief = buildTaskBrief(synthetic, { project_id: fx.id, role: "executor" });
  ok(
    brief.graph.reason === "图更新中：正在采集模块",
    "⑦b 图更新原因取自真实 update_reason（不再读从不产出的顶层 reason）",
    brief.graph,
  );
  const fields = brief.omitted.fields;
  ok(
    [
      "graph_summary.graphs",
      "graph_summary.delivery",
      "graph_summary.capability_table_state",
      "graph_summary.update_phase",
      "graph_summary.update_eta_text",
      "graph_summary.banners",
      "graph_summary.baseline_id",
      "graph_summary.read_at",
      "graph_summary.generated_at",
    ].every((f) => fields.includes(f)),
    "⑦b omitted.fields 如实列全被省略的 graph_summary 域（交付/能力表/相位/ETA/横幅/基线/时间戳）",
    fields,
  );
  ok(
    !fields.some((f: string) => /update_reason|update_state|semantic_state|snapshot_id|availability|anomalies|next_read_entry/.test(f)),
    "⑦b omitted.fields 不虚报已保留的内容（update_reason/状态/快照/异常/入口都不在省略列）",
    fields,
  );
}

// ── ⑦c 阶段必读 range 透传（2026-10-04 复审 P1-3：entry required_reads 派生携带 range） ──

async function scenarioStageRange(): Promise<void> {
  info("── ⑦c 阶段必读 range 透传：project_entry / task_brief 的 required_reads 带派生 range");
  const fx = makeFixture("tb-stage", [{ id: "T-1", goal: "打地基", paths: ["src/a.ts"], checks: ["达标"] }]);
  const md = ["# 材料", "", "## 甲", "", "甲正文", "", "## 乙", "", "乙正文", "", "## 丙", "", "丙正文", ""].join("\n");
  write(path.join(fx.root, "material.md"), md);
  const digA = markdownSectionDigest(Buffer.from(md, "utf8"), "材料 / 甲");
  const digB = markdownSectionDigest(Buffer.from(md, "utf8"), "材料 / 乙");
  if (!digA.ok || !digB.ok) throw new Error("夹具章节不可用");
  write(
    path.join(fx.root, ".工作台", "work", "stage-reads.json"),
    `${JSON.stringify(
      {
        schema_version: 2,
        generated_from: [{ path: "material.md", section: "材料 / 甲", sha256: digA.sha256 }],
        entries: [{ path: "material.md", kind: "design", why: "本阶段必读乙", section: "材料 / 乙", revision: digB.sha256 }],
        preferred_task_id: null,
      },
      null,
      2,
    )}\n`,
  );
  const args = { project_id: fx.id, role: "executor", client_capabilities: CONTINUABLE };
  const full = await fullOf(args);
  const rr = (full.json?.required_reads ?? []).find((r: any) => r.path === "material.md");
  ok(
    rr !== undefined &&
      rr.section === "材料 / 乙" &&
      rr.range?.start === digB.section.line_start &&
      rr.range?.end === digB.section.line_end,
    `⑦c project_entry 的 required_reads 透传派生 range（乙 → 行 ${digB.section.line_start}–${digB.section.line_end}），而不止给 section`,
    rr,
  );
  const brief = await briefOf(args);
  const rrB = (brief.json?.required_reads ?? []).find((r: any) => r.path === "material.md");
  ok(
    JSON.stringify(rrB) === JSON.stringify(rr) && rrB?.range !== undefined,
    "⑦c task_brief 原样透传同一条 required_reads（含 range）",
    rrB,
  );
}

// ── 收尾 ──

async function main(): Promise<void> {
  scenarioContract();
  await scenarioMain();
  await scenarioRole();
  await scenarioBlocked();
  await scenarioBlocked20();
  await scenarioCheckpoint();
  await scenarioNoMutation();
  await scenarioError();
  await scenarioPassthrough();
  await scenarioGraphProjection();
  await scenarioStageRange();
  scenarioRealSnapshot();
}

main()
  .catch((e) => {
    console.error(`[verify] 异常：${e instanceof Error ? e.stack : String(e)}`);
    process.exitCode = 1;
    ok(false, `验证中断：${e instanceof Error ? e.message : String(e)}`);
  })
  .finally(() => {
    if (process.env.TATAI_KEEP_TMP === "1") info(`保留现场：${tmpBase}`);
    else {
      fs.rmSync(tmpBase, { recursive: true, force: true });
      info(`夹具已清理：${path.basename(tmpBase)}`);
    }
    console.log(`\n[verify] V09-41 结果：${passCount} PASS / ${failCount} FAIL（exit ${process.exitCode ?? 0}）`);
  });
