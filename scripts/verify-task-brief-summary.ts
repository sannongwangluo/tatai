// V09-41 第二轮（2026-10-04）验证：task_brief 的 detail=summary / detail=reason。
// 用法：node D:/tatai/node_modules/tsx/dist/cli.mjs scripts/verify-task-brief-summary.ts
//
// **不是生产运行测试**：本脚本不连生产 MCP、不读真实项目 `.工作台/`、不启动服务、不写任何项目目录。
// 它把 `projectEntryTool.handler` **stub 掉**（记录透传入参、逐次返回内存里的 EntryFull），
// 对 task_brief 的 handler 做行为测试；另用仓外旧简报快照 `${TATAI_BRIEF_EVIDENCE_DIR}/real-brief-before.json`
// （它本身就是 `buildTaskBrief` 的一次真实投影）直接量体积。
//
// 覆盖：
//   ① 契约/注册：入参 = project_entry 五个 + detail/reason_index/reasons_revision；client_capabilities 例子写法；
//   ② 默认 summary：一条次调用完整入口、只转发原五参、新入参不转发；
//   ③ 摘要无损项：全部 reason 逐条保留（顺序/索引/code/task_id/blocking）、全部 blocking 索引完整、
//      未知 code 与长理由不消失；当前选中任务的 reason 原样完整保留（允许范围/依赖/完成要求/版本）；
//   ④ 截断明示 + 非当前任务的 pack 不内联（omitted_fields）；
//   ⑤ next_action/current_runs/required_reads/sync/capability/baseline 不裁剪；
//   ⑥ detail=reason：按 reason_index+reasons_revision 逐条取回完整原文；现场改变显式 REVISION_CHANGED（不返回错行）；
//   ⑦ 无效参数组合调用入口前显式拒（isError；入口零调用）；索引越界显式 INDEX_OUT_OF_RANGE；
//   ⑧ 原 project_entry 错误逐字透传；非 JSON 成功返回原样；
//   ⑨ 纯函数：buildTaskBrief/summarizeTaskBrief 不改输入；
//   ⑩ 真实旧简报快照：summary 紧凑 UTF-8 字节 ≤ 原 brief 的 45%，落体积证据 ${TATAI_BRIEF_EVIDENCE_DIR}/brief-summary-size.json。
//   ⑪ P3 集成修正：summary 的 repair_plan 转紧凑导航（nav/计数/refetch，不内联逐项 items/候选）；
//      detail=full 保留完整逐项；同步段其余字段逐字一致；reason 索引与 revision 不变；未配置 sync 仍 null。
//   ⑫ 真实同快照（冻结示例项目镜像，有则验、无则 SKIP）：full 保留全部 item、summary 导航 ≤8KB、只读零写。
//   ⑫ 真实同快照（冻结示例项目镜像，有则验、无则 SKIP）：full 保留全部 item、summary 导航 ≤8KB、只读零写。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { buildTaskBrief, summarizeTaskBrief, reasonsRevisionOf, type EntryFull, type TaskBrief } from "../src/server/work/taskBrief";
import type { EntryReason } from "../src/server/work/entry";
import { findTool, TOOLS } from "../src/mcp/tools/index";
import { projectEntryTool } from "../src/mcp/tools/projectEntry";
import { taskBriefTool } from "../src/mcp/tools/taskBrief";
import { errorResult, textResult, type ToolResult } from "../src/mcp/tools/types";

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

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE_DIR = process.env.TATAI_BRIEF_EVIDENCE_DIR
  ? path.resolve(process.env.TATAI_BRIEF_EVIDENCE_DIR)
  : path.join(REPO, ".工作台", "evidence", "V09-44");
const sha256Re = /^[0-9a-f]{64}$/;

// ── stub 完整入口：记录透传入参，逐次返回内存里的 EntryFull（不读盘、不连宿主） ──

interface CallResult {
  isError: boolean;
  text: string;
  json: any;
}

const entryCalls: Record<string, unknown>[] = [];
let currentEntry: ToolResult = textResult("{}");
const originalHandler = projectEntryTool.handler;
projectEntryTool.handler = (async (args: Record<string, unknown>): Promise<ToolResult> => {
  entryCalls.push(args);
  return currentEntry;
}) as typeof projectEntryTool.handler;

function parseTool(r: ToolResult): CallResult {
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
const callBrief = async (args: Record<string, unknown>): Promise<CallResult> => parseTool(await taskBriefTool.handler(args));

// ── 夹具：内存里的 EntryFull（含长理由/未知 code/当前卡 pack/checkpoint） ──

const LONG = (tag: string, n: number): string => `${tag}：` + "长理由正文。".repeat(Math.ceil(n / 6)).slice(0, n);

function fixtureReasons(): EntryReason[] {
  const reasons: EntryReason[] = [
    { code: "baseline_active", text: "有效基线 b-1（审定 user / user_confirmed，生效 2026-10-01T00:00:00+08:00）", basis_revision: "p-hash" },
    {
      code: "claimable",
      text: LONG("按已定义优先级选出任务 T-1", 400),
      task_id: "T-1",
      handoff_id: "T-1@planhash",
      basis_revision: "def-hash-T-1",
      dependency_ids: ["T-0"],
      allowed_paths: ["src/a.ts", "src/b.ts"],
      completion_requirements: ["验收：地基水平达标", "完成证据要求：照片"],
      task_revision: 7,
      missing_items: [],
    },
    {
      code: "blocked_task",
      text: LONG("任务 T-2 处于阻塞：等勘探报告", 300),
      task_id: "T-2",
      blocking: true,
      completion_requirements: ["验收：x"],
      allowed_paths: ["src/c.ts"],
      dependency_ids: [],
      task_revision: 2,
      missing_items: ["运行状态"],
    },
    { code: "checkpoint_available", text: "上一轮中断的续接位置（服务器保留）：中断原因 interrupted；续接位置：T-1 卡", blocking: false },
    { code: "future_reason_v2", text: LONG("未来未知 code 的理由也不能丢", 260), task_id: "T-9", blocking: true, missing_items: ["a", "b"], ...{ future_constraint: { must_read: "authorization.md" } } },
    { code: "unhandled_task", text: "任务 T-4 没有本角色能接的迹象（角色不符）", task_id: "T-4", blocking: true },
    ...Array.from({ length: 16 }, (_, i): EntryReason => ({
      code: "blocked_task",
      text: LONG(`任务 B-${i + 1} 处于阻塞：等前置条件`, 140),
      task_id: `B-${i + 1}`,
      blocking: true,
      completion_requirements: ["验收：q"],
      allowed_paths: ["src/x.ts"],
      dependency_ids: ["B-0"],
      task_revision: 1,
      missing_items: ["运行状态", "定义重绑"],
    })),
    { code: "no_ready_task", text: LONG("当前没有就绪任务，但项目没完成", 4000), blocking: true },
  ];
  return reasons;
}

function makeEntry(reasons: EntryReason[] = fixtureReasons()): EntryFull {
  return {
    project: {
      project_id: "demo-project-fixture",
      name: "示例项目夹具",
      path: "D:/fixture",
      kind: "backend",
      workstation_dir: "D:/fixture/.工作台",
      role: "executor",
      role_class: "executor",
      documents: { design: null, plan: null },
      capability: {
        declared: { read: true, continue: true, coordinate: false },
        effective: "continuable",
        basis: '调用方声明 client_capabilities="continuable"（按字符串解析）',
        limits: ["可接续档位：可以认领并回报"],
        unrecognized: [],
      },
    },
    baseline: {
      active: {
        baseline_id: "b-1",
        active_at: "2026-10-01T00:00:00+08:00",
        approved_by: "user",
        approval_basis: "夹具审定",
        approval_kind: "user_confirmed",
        design_revision: "d-hash",
        plan_revision: "p-hash",
        design_source: ".工作台/design.md",
        plan_source: ".工作台/plan.md",
      },
      valid: true,
      revalidate: [],
      source_changed_since_baseline: false,
    },
    context_manifest: {
      package_id: "pkg-1",
      generated_at: "2026-10-01T01:00:00+08:00",
      design_revision: null,
      plan_revision: null,
      plan_definition_digest: null,
      token_or_char_size: 10,
      sources: [],
      omitted: [],
      stale_reasons: [],
      coverage: null,
    },
    current_change: { change_id: "chg-1", task_ids: ["T-1"], latest_at: "2026-10-02T00:00:00+08:00", basis: { baseline_id: "b-1", design_revision: "d-hash", plan_revision: "p-hash" } },
    current_runs: [
      {
        task_id: "T-1",
        run_id: "run-1",
        attempt_id: "att-1",
        attempt: 1,
        owner_id: "kimi",
        owner_role: "executor",
        claim_token: "tok-1",
        lease_expires_at: "2026-10-05T00:00:00+08:00",
        workspace: ".工作台/runs/T-1/1",
        lease: "active",
        resume_preconditions: ["确认旧进程停止"],
        run_site: {
          observed: true,
          execution_id: "exec-1",
          state: "confirmed_alive",
          site_state: "active",
          last_signal_at: "2026-10-03T00:00:00+08:00",
          silent_ms: 0,
          heartbeat_stale: false,
          note: "在跑",
          confirmation: null,
          last_checkpoint: null,
        },
      },
    ],
    next_action: "claim_task",
    reasons,
    required_reads: [
      { path: ".工作台/plan.md", kind: "plan", why: "任务 T-1 的卡区原文（定义、依赖、验收、文件责任）", revision: "p-hash", range: { start: 10, end: 40 } },
      { path: ".工作台/design.md", kind: "design", why: "设计书原文", revision: "d-hash" },
    ],
    sync_summary: { configured: true, overall: "pass", blocked: false, blocking_batches: [] },
    graph_summary: {
      availability: "ok",
      update_state: "idle",
      semantic_state: "fresh",
      snapshot_id: "snap-1",
      anomalies: [],
      next_read_entry: { tool: "get_project_graphs", args: { project_id: "demo-project-fixture", graph: "all", mode: "full" }, note: "六图完整状态" },
    },
    versions: { baseline_id: "b-1", design_revision: "d-hash", plan_revision: "p-hash", plan_definition_revision: "pd-hash", graph_snapshot_id: "snap-1" },
    source: { ledger: "events.jsonl", events_snapshot: "shared", events_snapshot_unreadable: null, sources_stable: true, sources_stale_reasons: [], attempts: 1 },
  } as unknown as EntryFull;
}

const brief = (): EntryFull => makeEntry();
function currentEntryTextParsed(): any {
  const text = (currentEntry.content ?? []).filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("\n");
  return JSON.parse(text);
}

const codeIndexPairs = (reasons: any[]): string =>
  reasons.map((r, i) => `${i}|${r.code}|${r.task_id ?? ""}|${r.blocking === true}`).join("\n");

/** 键序无关的深层等价判据（比较的是内容，不是字段书写顺序）。 */
function stableJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`)
    .join(",")}}`;
}

// ── ① 契约/注册 & schema ──

function scenarioContract(): void {
  info("── ① 契约/注册：入参 = project_entry 五个 + detail/reason_index/reasons_revision；client_capabilities 写法");
  ok(findTool("task_brief")?.name === "task_brief" && TOOLS.some((t) => t.name === "task_brief"), "① task_brief 已在注册表（findTool/TOOLS 命中）");
  const schema = taskBriefTool.inputSchema as { properties?: Record<string, unknown>; required?: string[]; additionalProperties?: boolean };
  const props = Object.keys(schema.properties ?? {}).sort();
  ok(
    JSON.stringify(props) ===
      JSON.stringify(["client_capabilities", "detail", "expected_revision", "known_revision", "project_id", "reason_index", "reasons_revision", "resume_hint", "role"]),
    `① 入参恰好是三个详略字段 + V09-53 的 expected_revision（实际 ${props.join("/")}）`,
    props,
  );
  ok(
    JSON.stringify(schema.required) === JSON.stringify(["project_id", "role"]) && schema.additionalProperties === false,
    "① 必填仍只有 project_id/role，additionalProperties=false",
    schema,
  );
  const capDesc = JSON.stringify((schema.properties ?? {}).client_capabilities ?? "");
  ok(
    capDesc.includes("continuable") && capDesc.includes("coordination") && capDesc.includes("can_continue") && capDesc.includes("不要传 JSON 字符串化的数组"),
    "① client_capabilities 说明给字符串 continuable/coordination 与对象 {can_continue:true}，并劝阻 JSON 字符串数组",
    capDesc,
  );
  const detailSchema = (schema.properties ?? {}).detail as { enum?: string[] } | undefined;
  ok(
    JSON.stringify(detailSchema?.enum) === JSON.stringify(["summary", "full", "reason"]),
    "① detail 是 summary/full/reason 三选一枚举",
    detailSchema,
  );
}

// ── ② 默认 summary & 一次调用/透传 ──

async function scenarioSummaryDefault(): Promise<void> {
  info("── ② 默认 summary：只调一次完整入口、只转发原五参、新入参不转发");
  currentEntry = textResult(JSON.stringify(brief()));
  const before = entryCalls.length;
  const r = await callBrief({ project_id: "demo-project-fixture", role: "executor" });
  ok(!r.isError && r.json?.detail === "summary", "② 不传 detail 默认走 summary", r.json?.detail);
  ok(entryCalls.length === before + 1, `② summary 只调用完整入口一次（+${entryCalls.length - before}）`, entryCalls.length - before);
  ok(JSON.stringify(entryCalls[entryCalls.length - 1]) === JSON.stringify({ project_id: "demo-project-fixture", role: "executor" }), "② 新入参未转发 project_entry", entryCalls[entryCalls.length - 1]);

  const r2 = await callBrief({ project_id: "demo-project-fixture", role: "executor", client_capabilities: "continuable", known_revision: "p-hash", resume_hint: "T-1", detail: "summary" });
  const forwarded = entryCalls[entryCalls.length - 1];
  ok(
    JSON.stringify(Object.keys(forwarded).sort()) === JSON.stringify(["client_capabilities", "known_revision", "project_id", "resume_hint", "role"]) &&
      forwarded.client_capabilities === "continuable" &&
      forwarded.known_revision === "p-hash" &&
      forwarded.resume_hint === "T-1" &&
      !("detail" in forwarded),
    "② 透传恰好五个原参（值原样，detail 不转发）",
    forwarded,
  );
  ok(r2.json?.reasons?.length === 23, `② summary 理由条数与完整入口一致（${r2.json?.reasons?.length}）`, r2.json?.reasons?.length);
}

// ── ③④⑤ 摘要无损 / 截断 / 不裁剪 ──

async function scenarioSummaryPreserves(): Promise<void> {
  info("── ③④⑤ 摘要：全部索引/blocking 完整、当前卡无损、截断明示、非 pack 不内联、not-clipped 字段原样");
  currentEntry = textResult(JSON.stringify(brief()));
  const entryParsed = currentEntryTextParsed() as EntryFull;
  const r = await callBrief({ project_id: "demo-project-fixture", role: "executor" });
  const s = r.json;
  ok(!r.isError && s?.detail === "summary", "③ 摘要成功", r.text.slice(0, 200));

  ok(codeIndexPairs(s.reasons) === codeIndexPairs(entryParsed.reasons as any[]), "③ 全部理由逐条保留且顺序/索引/code/task_id/blocking 与完整入口一致（含未知 code）", {
    brief: codeIndexPairs(s.reasons).split("\n").slice(0, 4),
    full: codeIndexPairs(entryParsed.reasons as any[]).split("\n").slice(0, 4),
  });
  ok(
    s.reasons.filter((x: any) => x.blocking === true).length === (entryParsed.reasons as any[]).filter((x: any) => x.blocking === true).length,
    `③ blocking 索引完整（${s.reasons.filter((x: any) => x.blocking === true).length} 条）`,
  );
  ok(s.reasons.some((x: any) => x.code === "future_reason_v2"), "③ 未知 code（future_reason_v2）不消失");
  ok(s.reasons.find((x: any) => x.code === "future_reason_v2")?.omitted_fields?.includes("future_constraint"), "③ 新增未知约束字段也必须披露省略，不能静默丢失");
  ok(s.reasons.some((x: any) => x.code === "checkpoint_available" && (x.text ?? "").includes("续接位置")), "③ checkpoint_available（非阻断说明性理由）在摘要里且 text 可读");

  // 当前选中任务的 reason 原样完整保留
  const ci = 1;
  ok(
    s.current_task?.task_id === "T-1" && s.current_task?.task_revision === 7 && s.current_task?.reason_index === ci,
    "③ current_task 与 reason_index 指向 claimable（T-1 / rev 7）",
    s.current_task,
  );
  const keep = s.reasons[ci];
  const fullKeep = (entryParsed.reasons as any[])[ci];
  ok(
    keep?.preserved === true &&
      keep.text === fullKeep.text &&
      JSON.stringify(keep.allowed_paths) === JSON.stringify(fullKeep.allowed_paths) &&
      JSON.stringify(keep.dependency_ids) === JSON.stringify(fullKeep.dependency_ids) &&
      JSON.stringify(keep.completion_requirements) === JSON.stringify(fullKeep.completion_requirements) &&
      keep.task_revision === fullKeep.task_revision &&
      keep.basis_revision === fullKeep.basis_revision &&
      keep.handoff_id === fullKeep.handoff_id,
    "③ 当前卡 reason 原样完整保留（允许范围/依赖/完成要求/版本/交接 ID 一个不动）",
    keep,
  );
  ok(keep.omitted_fields === undefined, "③ 当前卡 reason 不带 omitted_fields（没有字段被省略）", keep.omitted_fields);

  // 截断明示
  const noReady = s.reasons.find((x: any) => x.code === "no_ready_task");
  const noReadyFull = (entryParsed.reasons as any[]).find((x: any) => x.code === "no_ready_task");
  ok(
    noReady?.text_truncated === true && noReady.text.includes("摘要截断") && noReady.text.length < noReadyFull.text.length && noReady.text_length === noReadyFull.text.length,
    "④ 长理由截断明示（text_truncated + 「摘要截断」标记 + text_length=原长度）",
    { trunc: noReady?.text_truncated, len: noReady?.text_length, fullLen: noReadyFull?.text.length },
  );
  const short = s.reasons.find((x: any) => x.code === "baseline_active");
  ok(short?.text_truncated === false && short.text === (entryParsed.reasons as any[]).find((x: any) => x.code === "baseline_active").text, "④ 未超限的短理由不被截断（text 原样）", short);

  // 非当前任务的 pack 不内联
  const blocked = s.reasons.find((x: any) => x.code === "blocked_task");
  ok(
    Array.isArray(blocked?.omitted_fields) &&
      ["dependency_ids", "allowed_paths", "completion_requirements", "missing_items"].every((f) => blocked.omitted_fields.includes(f)) &&
      blocked.allowed_paths === undefined &&
      blocked.completion_requirements === undefined,
    "④ 非当前任务的 pack 大数组不内联，列在 omitted_fields",
    blocked,
  );
  ok(
    JSON.stringify(s.omitted?.reason_fields) === JSON.stringify(["dependency_ids", "allowed_paths", "completion_requirements", "missing_items"]) &&
      typeof s.summary_note === "string" &&
      s.summary_note.includes("不是完整执行依据"),
    "④ omitted.reason_fields 明示省略字段 + summary_note 明示摘要非完整执行依据",
    { reason_fields: s.omitted?.reason_fields, note: s.summary_note?.slice(0, 80) },
  );
  ok(sha256Re.test(s.reasons_revision) && s.reasons_total === 23, "④ reasons_revision 是 sha256（64 hex）且 reasons_total 为 23", s.reasons_revision);

  // 不裁剪（键序无关的深层等价）：摘要的非 reason 字段 == 完整简报（buildTaskBrief）的字段；
  // 且 current_runs/required_reads/sync 与**完整入口原文**逐字相同（证明投影层本就没剪它们）。
  const projected = buildTaskBrief(entryParsed as EntryFull, { project_id: "demo-project-fixture", role: "executor" });
  ok(
    stableJson(s.next_action) === stableJson(projected.next_action) &&
      stableJson(s.current_runs) === stableJson(projected.current_runs) &&
      stableJson(s.required_reads) === stableJson(projected.required_reads) &&
      stableJson(s.sync) === stableJson(projected.sync) &&
      stableJson(s.project?.capability) === stableJson(projected.project.capability) &&
      stableJson(s.baseline) === stableJson(projected.baseline) &&
      stableJson(s.versions) === stableJson(projected.versions) &&
      stableJson(s.source) === stableJson(projected.source) &&
      stableJson(s.graph) === stableJson(projected.graph),
    "⑤ 摘要的非 reason 字段与完整简报逐字段一致（不裁剪）",
    { next_action: s.next_action, reads: s.required_reads?.length, runs: s.current_runs?.length },
  );
  ok(
    stableJson(s.current_runs) === stableJson(entryParsed.current_runs) &&
      stableJson(s.required_reads) === stableJson(entryParsed.required_reads) &&
      stableJson(s.sync) === stableJson((entryParsed as any).sync_summary),
    "⑤ current_runs/required_reads/sync 与完整入口原文逐字相同（投影层本就没剪它们）",
    { reads: s.required_reads, sync: s.sync },
  );
  ok(
    s.required_reads?.some((x: any) => x.path === ".工作台/plan.md" && x.range?.start === 10 && x.range?.end === 40),
    "⑤ required_reads 的派生 range 未被裁剪",
    s.required_reads,
  );
}

// ── ⑥ detail=reason：逐条取回 / 现场改变拒旧 ──

async function scenarioReasonRetrieval(): Promise<void> {
  info("── ⑥ detail=reason：按 revision 逐条取回完整原文；现场改变显式 REVISION_CHANGED");
  currentEntry = textResult(JSON.stringify(brief()));
  const entryParsed = currentEntryTextParsed() as EntryFull;
  const summary = await callBrief({ project_id: "demo-project-fixture", role: "executor" });
  const rev: string = summary.json.reasons_revision;
  const total: number = summary.json.reasons.length;

  let allOk = true;
  let mismatchDetail: unknown = null;
  for (let i = 0; i < total; i++) {
    const before = entryCalls.length;
    const got = await callBrief({ project_id: "demo-project-fixture", role: "executor", detail: "reason", reason_index: i, reasons_revision: rev });
    const good =
      !got.isError &&
      got.json?.detail === "reason" &&
      got.json?.reason_index === i &&
      got.json?.reasons_revision === rev &&
      JSON.stringify(got.json?.reason) === JSON.stringify((entryParsed.reasons as any[])[i]) &&
      got.json?.next_action === entryParsed.next_action &&
      got.json?.current_task?.task_id === "T-1" &&
      entryCalls.length === before + 1;
    if (!good) {
      allOk = false;
      mismatchDetail = { i, isError: got.isError, json: got.json, text: got.text.slice(0, 300) };
      break;
    }
  }
  ok(allOk, `⑥ 逐条取回全部 ${total} 条完整原文（每条一次入口调用、原文逐字相同、带 next_action/current_task）`, mismatchDetail);

  // 现场改变：同一个 revision 不能再取
  const changed = brief();
  changed.reasons = [...changed.reasons, { code: "new_scene_reason", text: "现场新增的一条理由", blocking: false }];
  currentEntry = textResult(JSON.stringify(changed));
  const stale = await callBrief({ project_id: "demo-project-fixture", role: "executor", detail: "reason", reason_index: 1, reasons_revision: rev });
  ok(
    stale.isError === true && stale.json?.code === "REVISION_CHANGED" && stale.json?.reason === undefined,
    "⑥ 现场已变 → 显式 REVISION_CHANGED，不返回错行（无 reason 字段）",
    stale.json ?? stale.text.slice(0, 200),
  );
  const fresh = await callBrief({ project_id: "demo-project-fixture", role: "executor" });
  const freshRev: string = fresh.json.reasons_revision;
  const refetch = await callBrief({ project_id: "demo-project-fixture", role: "executor", detail: "reason", reason_index: 23, reasons_revision: freshRev });
  ok(
    !refetch.isError && refetch.json?.reason?.code === "new_scene_reason",
    "⑥ 用新 revision + 新索引可取回新增理由",
    refetch.json?.reason,
  );
}

// ── ⑦ 无效参数：调用入口前显式拒；越界显式拒 ──

async function scenarioInvalidArgs(): Promise<void> {
  info("── ⑦ 无效参数组合在调用入口前拒（isError；入口零调用）；索引越界显式 INDEX_OUT_OF_RANGE");
  currentEntry = textResult(JSON.stringify(brief()));
  const bad: Record<string, unknown>[] = [
    { project_id: "demo-project-fixture", role: "executor", detail: "bogus" },
    { project_id: "demo-project-fixture", role: "executor", detail: 123 },
    { project_id: "demo-project-fixture", role: "executor", reason_index: 0 },
    { project_id: "demo-project-fixture", role: "executor", reasons_revision: "x" },
    { project_id: "demo-project-fixture", role: "executor", detail: "summary", reason_index: 0 },
    { project_id: "demo-project-fixture", role: "executor", detail: "full", reasons_revision: "x" },
    { project_id: "demo-project-fixture", role: "executor", detail: "reason" },
    { project_id: "demo-project-fixture", role: "executor", detail: "reason", reason_index: 0 },
    { project_id: "demo-project-fixture", role: "executor", detail: "reason", reasons_revision: "x" },
    { project_id: "demo-project-fixture", role: "executor", detail: "reason", reason_index: 1.5, reasons_revision: "x" },
    { project_id: "demo-project-fixture", role: "executor", detail: "reason", reason_index: -1, reasons_revision: "x" },
    { project_id: "demo-project-fixture", role: "executor", detail: "reason", reason_index: "1", reasons_revision: "x" },
    { project_id: "demo-project-fixture", role: "executor", detail: "reason", reason_index: 0, reasons_revision: "" },
  ];
  let allRejected = true;
  let leak: unknown = null;
  for (const args of bad) {
    const before = entryCalls.length;
    const got = await callBrief(args);
    if (!(got.isError === true && got.json?.code === "INVALID_ARGUMENT" && entryCalls.length === before)) {
      allRejected = false;
      leak = { args, isError: got.isError, code: got.json?.code, calls: entryCalls.length - before };
      break;
    }
  }
  ok(allRejected, `⑦ 全部 ${bad.length} 个非法组合在入口前显式拒（INVALID_ARGUMENT 且零入口调用）`, leak);

  const summary = await callBrief({ project_id: "demo-project-fixture", role: "executor" });
  const before = entryCalls.length;
  const oob = await callBrief({ project_id: "demo-project-fixture", role: "executor", detail: "reason", reason_index: 999, reasons_revision: summary.json.reasons_revision });
  ok(
    oob.isError === true && oob.json?.code === "INDEX_OUT_OF_RANGE" && entryCalls.length === before + 1,
    "⑦ 索引越界显式 INDEX_OUT_OF_RANGE（一次入口调用后拒，不返回错行）",
    { code: oob.json?.code, calls: entryCalls.length - before },
  );
}

// ── ⑧ 错误逐字透传 / 非 JSON 原样 ──

async function scenarioErrorPassthrough(): Promise<void> {
  info("── ⑧ 原 project_entry 错误逐字透传；非 JSON 成功返回原样");
  const errText = "宿主明确报错：SOURCE_CHANGED（重读来源）";
  currentEntry = errorResult(errText);
  const errCases: Record<string, unknown>[] = [
    { project_id: "demo-project-fixture", role: "executor", detail: "summary" },
    { project_id: "demo-project-fixture", role: "executor", detail: "full" },
    { project_id: "demo-project-fixture", role: "executor" },
  ];
  for (const args of errCases) {
    const got = await callBrief(args);
    ok(got.isError === true && got.text === errText, `⑧ 错误逐字透传（detail=${String(args.detail ?? "默认")}）`, { text: got.text.slice(0, 120) });
  }
  currentEntry = textResult("not-json-success");
  const raw = await callBrief({ project_id: "demo-project-fixture", role: "executor" });
  ok(raw.isError === false && raw.text === "not-json-success", "⑧ 解析不了完整入口文本时原样返回（不伪装成简报）", raw.text);
}

// ── ⑨ 纯函数不改输入 ──

function scenarioPurity(): void {
  info("── ⑨ buildTaskBrief/summarizeTaskBrief 纯函数：不改输入");
  const entry = brief();
  const snapshot = JSON.stringify(entry);
  const projected = buildTaskBrief(entry, { project_id: "demo-project-fixture", role: "executor" });
  const briefSnapshot = JSON.stringify(projected);
  const summary = summarizeTaskBrief(projected, { refetchArgs: { project_id: "demo-project-fixture", role: "executor" } });
  ok(projected.reasons === entry.reasons, "⑨ buildTaskBrief 的 reasons 原样引用（未过滤/未重建）");
  ok(JSON.stringify(entry) === snapshot, "⑨ 投影/摘要后输入 EntryFull 逐字段不变");
  ok(JSON.stringify(projected) === briefSnapshot, "⑨ 摘要不改完整简报（TaskBrief）");
  ok(
    summary.reasons.length === projected.reasons.length &&
      summary.omitted.refetch.args?.project_id === "demo-project-fixture" &&
      reasonsRevisionOf(projected.reasons) === summary.reasons_revision,
    "⑨ 摘要条数一致、refetch 指向 project_entry、reasons_revision 由完整 reasons 现算",
    { n: summary.reasons.length, rev: summary.reasons_revision },
  );
}

// ── ⑪ P3 集成修正（2026-10-06）：summary 的 repair_plan 转紧凑导航，full/read_sync_status 保留完整 ──

/** 一份完整只读修复计划夹具（逐项带 expected/actual/reasons/候选，供量 summary 导航的压缩与不内联） */
function makeRepairPlan(): any {
  const item = (id: string, verdict: string, wait = false): any => ({
    item_id: id,
    label: `L-${id}`,
    required: true,
    verdict,
    reasons: ["理由".repeat(60)],
    expected: { a: 1, b: "x" },
    actual: { a: 2, b: "y" },
    source_drift: [],
    reusable_artifacts: [],
    expired_artifacts: [],
    registered_by: { role: "coordinator", actor_id: "codex" },
    recommended_role: null,
    next_read_entry: { tool: "read_sync_status", args: { project_id: "demo-project-fixture" } },
    next_evidence_action: null,
    waiting_for_derivation: wait
      ? { state: "updating", phase: "graph", retryable: true, sole_cause: true, other_failures: [], reason: "图在更新", eta: { basis: "none", total_ms: null, note: "无法估计" } }
      : null,
  });
  return {
    generated_from: "read_sync_status",
    read_only: true,
    note: "只读修复计划（完整）",
    batches: [
      {
        batch_id: "b1",
        title: "批次一",
        active: true,
        blocks_entry: true,
        verdict: "failed",
        contract_sha256: "a".repeat(64),
        contract_generation: { sha256_12: "a".repeat(12), registered_seq: 1, active: true },
        registered_by: { role: "coordinator", actor_id: "codex" },
        source_drift: [{ path: "docs/x.md", registered_sha256: "r".repeat(64), current_sha256: null }],
        reusable_artifacts: [],
        expired_artifacts: [],
        // 40 项：验证导航体积**与逐项数无关**（导航只保留计数），完整计划随逐项线性增长
        items: Array.from({ length: 40 }, (_, i) => item(`i${i}`, i === 0 ? "failed" : i === 1 ? "missing" : "passed", i === 1)),
        candidate_evidence: null,
        candidate_unavailable_reason: null,
      },
    ],
  };
}

async function scenarioRepairNav(): Promise<void> {
  info("── ⑪ summary 的 repair_plan 紧凑导航；detail=full 保留完整逐项 ──");
  const e = brief();
  (e.sync_summary as any).repair_plan = makeRepairPlan();
  currentEntry = textResult(JSON.stringify(e));
  const entryParsed = currentEntryTextParsed() as EntryFull;
  const fullR = await callBrief({ project_id: "demo-project-fixture", role: "executor", detail: "full" });
  const sumR = await callBrief({ project_id: "demo-project-fixture", role: "executor" });
  const fullPlan: any = fullR.json?.sync?.repair_plan;
  const nav: any = sumR.json?.sync?.repair_plan;

  ok(
    fullPlan?.batches?.[0]?.items?.length === 40 && fullPlan.batches[0].items.every((i: any) => "expected" in i && "actual" in i),
    "⑪ detail=full（buildTaskBrief）保留完整 repair_plan：逐项 items 与 expected/actual 都在",
    fullPlan?.batches?.[0]?.items?.length,
  );
  ok(
    nav?.nav === true && nav?.read_only === true && nav?.generated_from === "read_sync_status",
    "⑪ summary 的 repair_plan 是紧凑导航（nav/read_only/generated_from 明示）",
    nav,
  );
  ok(
    nav?.active_batch_count === 1 &&
      nav.item_counts_by_verdict?.passed === 38 &&
      nav.item_counts_by_verdict?.failed === 1 &&
      nav.item_counts_by_verdict?.missing === 1,
    "⑪ 导航给现行批次数与逐 verdict 项数（诚实 counts）",
    { active: nav?.active_batch_count, counts: nav?.item_counts_by_verdict },
  );
  ok(nav?.blocked_batch_count === 1 && nav?.waiting_count === 1, "⑪ 导航给阻断批次与等待派生计数", { blocked: nav?.blocked_batch_count, waiting: nav?.waiting_count });
  ok(
    nav?.batches?.[0]?.source_drift_paths?.[0] === "docs/x.md" &&
      nav.batches.length === 1 &&
      nav.batches.every((b: any) => !("items" in b)) &&
      !("candidate_evidence" in nav) &&
      nav.batches[0].item_count === 40,
    "⑪ 导航每批只给有界摘要（漂移路径/计数，item_count=40 但**不带** items 或候选 JSON）",
    nav?.batches?.[0],
  );
  ok(
    nav?.refetch?.tool === "read_sync_status" &&
      nav.refetch.args?.project_id === "demo-project-fixture" &&
      Array.isArray(nav?.omitted?.fields) &&
      nav.omitted.fields.length > 0,
    "⑪ 导航给结构化 refetch（read_sync_status + 正确 project_id）与明确 omitted",
    { refetch: nav?.refetch, omitted: nav?.omitted },
  );
  // 同步段其余字段（configured/overall/blocked/blocking_batches）逐字一致，只 repair_plan 变形
  const projected = buildTaskBrief(entryParsed, { project_id: "demo-project-fixture", role: "executor" });
  const { repair_plan: _sumPlan, ...sumRest } = (sumR.json?.sync ?? {}) as Record<string, unknown>;
  const { repair_plan: _fullPlan, ...fullRest } = (projected.sync ?? {}) as Record<string, unknown>;
  ok(stableJson(sumRest) === stableJson(fullRest), "⑪ summary 同步段除 repair_plan 外逐字一致（门禁/状态字段未裁剪）", sumRest);
  ok(
    Buffer.byteLength(JSON.stringify(nav)) < 3000 && Buffer.byteLength(JSON.stringify(nav)) < Buffer.byteLength(JSON.stringify(fullPlan)) * 0.2,
    "⑪ 导航体积有界（<3KB）且随逐项数无关、远小于完整计划（40 项也不膨胀）",
    { nav: Buffer.byteLength(JSON.stringify(nav)), full: Buffer.byteLength(JSON.stringify(fullPlan)) },
  );
  ok(
    sumR.json?.reasons_revision === reasonsRevisionOf(entryParsed.reasons) && sumR.json?.reasons.length === entryParsed.reasons.length,
    "⑪ summary 的 reason 索引与 revision 不受 repair_plan 压缩影响",
    { rev: sumR.json?.reasons_revision?.slice(0, 8) },
  );

  // 未配置（sync_summary=null）时 summary 的 sync 仍为 null（旧字段语义保留）
  const e2 = brief();
  (e2 as any).sync_summary = null;
  currentEntry = textResult(JSON.stringify(e2));
  const noSync = await callBrief({ project_id: "demo-project-fixture", role: "executor" });
  ok(noSync.json?.sync === null, "⑪ 未配置项目 summary 的 sync 仍为 null（旧字段语义保留）", noSync.json?.sync);
}

// ── ⑫ 真实同快照（冻结示例项目镜像，有则验、无则 SKIP）：full 保留全部 item；summary 导航 ≤8KB ──

/** P3 决策引用的冻结示例项目同快照（只读；不存在则如实 SKIP，不伪造） */
const REAL_MIRROR = "<维护者核验目录>/tatai-performance-20261003/benchmark/mirror";

async function scenarioRealMirror(): Promise<void> {
  info("── ⑫ 真实同快照（冻结示例项目镜像）：full 保留全部逐项，summary 修复导航 ≤8KB，只读零写 ──");
  const registry = path.join(REAL_MIRROR, "data", "registry.json");
  if (!fs.existsSync(registry)) {
    info(`   跳过：冻结镜像不存在（${registry}）——只如实说明，不伪造通过`);
    return;
  }
  // inspect-brief-size.mts 同款：先载 syncGraph 再载 entry，避免初始化顺序问题。
  await import("../src/server/work/syncGraph");
  const { evaluateProjectEntry } = await import("../src/server/work/entry");
  const { readSyncStatus } = await import("../src/server/work/sync");
  const dataDir = path.join(REAL_MIRROR, "data");
  const eventsPath = path.join(REAL_MIRROR, "project", ".工作台", "work", "events.jsonl");
  const hashOf = (p: string): string | null => (fs.existsSync(p) ? crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex") : null);
  const before = hashOf(eventsPath);

  const entry = evaluateProjectEntry(
    { project_id: "bench-mirror", role: "coordinator", client_capabilities: ["read_only"] },
    { dataDir },
  ) as unknown as EntryFull;
  const full = buildTaskBrief(entry, { project_id: "bench-mirror", role: "coordinator" });
  const summary = summarizeTaskBrief(full, { refetchArgs: { project_id: "bench-mirror", role: "coordinator" } });
  const directPlan: any = (readSyncStatus("bench-mirror", dataDir) as any).repair_plan;
  const nav: any = (summary.sync as any)?.repair_plan;
  const fullPlan: any = (full.sync as any)?.repair_plan;
  const fullItems = (fullPlan?.batches ?? []).flatMap((b: any) => b.items ?? []);
  const navBytes = Buffer.byteLength(JSON.stringify(nav));
  const fullBytes = Buffer.byteLength(JSON.stringify(full));
  const after = hashOf(eventsPath);

  ok(navBytes <= 8192, `⑫ 真实同快照 summary 新增修复导航 ≤8KB（实测 ${navBytes}B；完整计划 ${Buffer.byteLength(JSON.stringify(fullPlan))}B）`, { navBytes });
  ok(
    fullItems.length > 0 && fullItems.every((i: any) => "item_id" in i && "expected" in i && "actual" in i),
    `⑫ detail=full 的 repair_plan 全文读回含全部 item_id/expected/actual（${fullItems.length} 项）`,
  );
  ok(JSON.stringify(fullPlan) === JSON.stringify(directPlan), "⑫ 完整 repair_plan 与 read_sync_status 同一份（不重算，交还全文）");
  ok(
    nav?.nav === true && (nav?.batches ?? []).every((b: any) => !("items" in b)) && (nav?.omitted?.fields ?? []).length > 0,
    "⑫ 导航只给有界每批摘要（不含 items），明确 omitted",
    { nav: navBytes, full: Buffer.byteLength(JSON.stringify(fullPlan)) },
  );
  ok(nav?.refetch?.tool === "read_sync_status" && nav.refetch.args?.project_id === "bench-mirror", "⑫ 导航 refetch 指向 read_sync_status(project_id=bench-mirror)", nav?.refetch);
  ok(summary.reasons_revision === reasonsRevisionOf(full.reasons) && summary.next_action === full.next_action, "⑫ summary/full 的 reason revision 与 next_action 相符", { rev: summary.reasons_revision.slice(0, 8) });
  ok(before !== null && before === after, "⑫ 全部只读零写（镜像 events.jsonl 字节不变）", { before, after });

  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(EVIDENCE_DIR, "brief-summary-size-real.json"),
    JSON.stringify(
      {
        snapshot: REAL_MIRROR,
        bytes: { full_brief: fullBytes, summary: Buffer.byteLength(JSON.stringify(summary)), full_repair_plan: Buffer.byteLength(JSON.stringify(fullPlan)), summary_repair_nav: navBytes },
        full_items: fullItems.length,
        zero_write: before === after,
        note: "同快照只读实测：full/read_sync_status 保留完整修复计划；summary 新增导航 ≤8KB（回归预算，不声称全项目 SLA）。",
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
}

// ── ⑩ 真实旧简报快照：体积 ≤ 45% ──
function scenarioRealSnapshot(): void {
  info("── ⑩ 真实旧简报快照（${TATAI_BRIEF_EVIDENCE_DIR}/real-brief-before.json）：summary ≤ 原 brief 45%");
  const snapPath = path.join(EVIDENCE_DIR, "real-brief-before.json");
  if (!fs.existsSync(snapPath)) {
    info(`   跳过：快照不存在（${snapPath}）——只如实说明，不伪造通过`);
    return;
  }
  const raw = fs.readFileSync(snapPath, "utf8");
  const full = JSON.parse(raw) as unknown as TaskBrief;
  const summary = summarizeTaskBrief(full);
  const summaryText = JSON.stringify(summary);
  const compactOriginal = JSON.stringify(full);

  const rawBytes = Buffer.byteLength(raw);
  const compactBytes = Buffer.byteLength(compactOriginal);
  const summaryBytes = Buffer.byteLength(summaryText);
  const fullReasons = Array.isArray(full.reasons) ? full.reasons : [];

  const size = {
    source: snapPath,
    kind: "projection-level measurement（不是生产运行测试：只对 buildTaskBrief 的旧投影做 summarizeTaskBrief）",
    note:
      "口径：raw=快照文件原样（pretty JSON，UTF-8 字节）；compact=同一对象紧凑序列化；summary=summarizeTaskBrief 的紧凑序列化。" +
      "只比较 task_brief **返回体**体积，不含系统提示/工具定义/历史/推理等开销，**不是模型总 token 节省比例**。" +
      "快照是 24 条理由的真实 blocked 现场（current_task=null），摘要按契约保留全部理由索引并截断非当前理由 text。",
    original: { raw_chars: raw.length, raw_bytes: rawBytes, compact_chars: compactOriginal.length, compact_bytes: compactBytes },
    summary: { chars: summaryText.length, bytes: summaryBytes, reasons_total: summary.reasons_total },
    reduction: {
      summary_over_compact_bytes_ratio: +(summaryBytes / compactBytes).toFixed(4),
      summary_over_raw_bytes_ratio: +(summaryBytes / rawBytes).toFixed(4),
      saved_compact_bytes: compactBytes - summaryBytes,
    },
    checks: {
      under_45pct_of_compact_bytes: summaryBytes <= compactBytes * 0.45,
      under_45pct_of_raw_bytes: summaryBytes <= rawBytes * 0.45,
      reasons_count_preserved: summary.reasons.length === fullReasons.length,
    },
    sample_facts: {
      full_reasons_count: fullReasons.length,
      summary_reasons_count: summary.reasons.length,
      next_action: summary.next_action,
      current_task: summary.current_task,
      blocked_reasons_full: fullReasons.filter((r) => r.blocking === true).length,
      blocked_reasons_summary: summary.reasons.filter((r) => r.blocking === true).length,
    },
  };
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const outPath = path.join(EVIDENCE_DIR, "brief-summary-size.json");
  fs.writeFileSync(outPath, JSON.stringify(size, null, 2) + "\n", "utf8");
  info(`   体积：原 brief compact ${compactBytes} B / raw ${rawBytes} B；summary ${summaryBytes} B（比值 ${size.reduction.summary_over_compact_bytes_ratio}）→ ${outPath}`);

  ok(
    summaryBytes <= compactBytes * 0.45,
    `⑩ summary 紧凑 UTF-8 字节 ≤ 原 brief compact 的 45%（${summaryBytes} ≤ ${Math.floor(compactBytes * 0.45)}）`,
    size.reduction,
  );
  ok(summaryBytes <= rawBytes * 0.45, `⑩ summary ≤ 原 brief 文件原样 45%（${summaryBytes} ≤ ${Math.floor(rawBytes * 0.45)}）`, size.reduction);
  ok(
    summary.reasons.length === fullReasons.length &&
      codeIndexPairs(summary.reasons as any[]) === codeIndexPairs(fullReasons as any[]),
    `⑩ 真实快照 ${fullReasons.length} 条理由全部保留（索引/code/task_id/blocking 无损）`,
    { summary: summary.reasons.length, full: fullReasons.length },
  );
  ok(
    summary.reasons.filter((x: any) => x.blocking === true).length === fullReasons.filter((r) => r.blocking === true).length,
    "⑩ 真实快照全部 blocking 索引完整",
  );
  ok(summary.current_task === null && summary.next_action === "blocked", "⑩ 真实 blocked 现场 current_task=null / next_action=blocked 如实", {
    current_task: summary.current_task,
    next_action: summary.next_action,
  });
  const noReady = summary.reasons.find((x: any) => x.code === "no_ready_task");
  ok(!!noReady && noReady.text_truncated === true && (noReady.text ?? "").includes("摘要截断"), "⑩ 真实快照 4920 字长理由截断明示（不是完整原文）", noReady);
}

// ── 收尾 ──

async function main(): Promise<void> {
  scenarioContract();
  await scenarioSummaryDefault();
  await scenarioSummaryPreserves();
  await scenarioReasonRetrieval();
  await scenarioInvalidArgs();
  await scenarioErrorPassthrough();
  scenarioPurity();
  await scenarioRepairNav();
  scenarioRealSnapshot();
  await scenarioRealMirror();
}

main()
  .catch((e) => {
    console.error(`[verify] 异常：${e instanceof Error ? e.stack : String(e)}`);
    process.exitCode = 1;
    ok(false, `验证中断：${e instanceof Error ? e.message : String(e)}`);
  })
  .finally(() => {
    // 恢复原 handler（进程结束即止；这里只是不留下被篡改的模块状态）
    projectEntryTool.handler = originalHandler;
    console.log(`\n[verify] V09-41 第二轮（summary/reason）结果：${passCount} PASS / ${failCount} FAIL（exit ${process.exitCode ?? 0}）`);
  });
