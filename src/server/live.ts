// 实况聚合层（V1，DESIGN.md §3.10 流程实况视图）：只读合成 tasks.json / progress.json /
// gate.jsonl / changes.jsonl / 全局 agents.json，一眼回答三件事——谁在干、干到哪、刚干了什么。
//
// ████████████████████████████ 红线 ████████████████████████████
// 本模块【全程只读】：五个数据源一个都不写（progress/gate/tasks/changes 是项目的，
// agents.json 是全局的），不落任何文件、不建目录、不触发初始化（progress 缺文件时
// readProgress 会自动初始化——那是写！本层改用 readTasks 同款"缺文件即空态"口径，
// progress 文件不存在按初始态合成，绝不为读而建）。
// ███████████████████████████████████████████████████████████████
//
// 实时口径（V1 卡注释）：文件变更走 SSE events 通道（H2 已就绪，watcher.onProjectChange 推送）；
// Gate/任务变化【不走广播】，由前端对 /live 做 5s 轻轮询对账补充——Gate/任务写入都在
// 本服务内但频率极低（人点 Gate、agent 自报），为它们再开一条推送通道不值当，轮询足够。

import fs from "node:fs";
import path from "node:path";
import { getProject } from "./registry";
import { listAgents } from "./agents";
import { GATE_STEPS, WsError, readGateLines, readTaskLedger, validateProgress, type Progress } from "./workstation";
import { readChanges } from "./watcher";
// V09-12：图更新状态摘要（只读——看板页要在不手动刷新时看见"图正在更新/更新完成"）
import { readGraphUpdate } from "./work/graphUpdate";

/** 卡死变色报警默认阈值（§3.10：可配，默认 10 分钟；前端可改，本值只是缺省） */
export const DEFAULT_STALL_THRESHOLD_MS = 10 * 60 * 1000;

/** 动作流一条（三源统一口径：ts 倒序，kind 区分来源） */
export interface LiveEvent {
  ts: string;
  kind: "change" | "gate" | "task";
  text: string;
}

/** GET /api/projects/:id/live 的合成快照 */
export interface LiveSnapshot {
  /** 当前阶段大字文案（Gate 当前步 + 任务态推导） */
  stage: string;
  /** 谁在干活：最近 doing 任务的 reporter；无 doing 任务 = "user"（球在用户这边） */
  actor: { kind: "agent" | "user"; name: string; last_active_at: string | null };
  /** 任务四态计数（**兼容口径**：V08-01 起由 v2 事件投影派生，`done` 的最弱含义＝执行者已提交结果） */
  task_counts: { todo: number; doing: number; done: number; blocked: number };
  /**
   * 这份任务状态是从哪读出来的：
   * `v2_events` = §2.6 单一事实源；`v1_file` = 迁移期兼容台账（整份）；
   * `v2_events+v1_fallback` = v2 事件为主 + 若干行只有 v1 台账有（如实回退，不吞掉，见 `task_v1_fallback_ids`）
   */
  task_source: "v2_events" | "v1_file" | "v2_events+v1_fallback";
  /** 由 v1 台账回退补上的任务 id（空＝没有回退行） */
  task_v1_fallback_ids: string[];
  /** 事件账本末序号（v1 回退为 null） */
  task_last_seq: number | null;
  /** v2 七态计数（§5.4 原文口径；未迁移项目为空对象） */
  task_counts_v2: Record<string, number>;
  /** 已交结果、**尚未人工验收**的卡（v2 状态 result_submitted；界面必须显示成"结果已提交"而不是"已完成"） */
  result_submitted_ids: string[];
  /** 当前 doing 任务（多个取最近更新的）；无为 null */
  current_task: { id: string; title: string; reporter: string; updated_at: string; v2_status: string | null; v2_status_label: string | null } | null;
  /** Gate 当前步（id + 中文名 + 三态结果） */
  gate: { current_step: string; step_name: string; result: "pass" | "reject" | "pending" };
  /** 动作流：changes/gate/tasks 三源合并按 ts 倒序，前 50 条 */
  events: LiveEvent[];
  /** 卡死变色报警阈值缺省值（毫秒；前端以此初值，可改） */
  stall_threshold_ms: number;
  /** 最近事件时间（无事件为 null；前端以此为变色计时基准） */
  last_event_at: string | null;
  /**
   * V09-12：图更新状态的**轻量摘要**（`.工作台/arch/graph-update.json` 只读回读；没跑过为 null）。
   * 为什么放在 live 而不是让前端另开一条轮询：图页本来就在 5s 轮询本接口，源变化发现链
   * "开始更新/更新完成"这一跳必须**无需手动刷新**就被页面看见（§3.3 末段 / E.8-1）。
   * 只带状态与指纹，不带 ETA 文案——详版仍走 `GET arch/blueprint` 的 `update`。
   */
  graph_update: { state: string; phase: string | null; change_token: string | null; updated_at: string } | null;
}

const STEP_NAME = new Map(GATE_STEPS.map((s) => [s.id, s.name]));

/**
 * 只读口径读 progress：文件不存在按初始态合成（不为读而建文件——readProgress 会初始化落盘，本层不能用）。
 * P2 起导出：跨项目汇总（`src/server/summary.ts`）复用同一条「缺文件按初始态合成」口径，
 * 不另写第二套合成（P1 `projects-summary.ts#PROGRESS_ABSENT_RULE` 登记的就是本函数）。
 */
export function readProgressReadonly(projectId: string): Progress {
  const project = getProject(projectId);
  if (!project) throw new WsError("PROJECT_NOT_FOUND", `项目不存在: ${projectId}`);
  const file = path.join(project.path, ".工作台", "progress.json");
  if (!fs.existsSync(file)) {
    return {
      version: 1,
      gate: {
        current_step: GATE_STEPS[0].id,
        history: GATE_STEPS.map((s) => ({ step: s.id, result: "pending", at: null, note: null })),
      },
      modules: [],
    };
  }
  return validateProgress(JSON.parse(fs.readFileSync(file, "utf8")));
}

/** 当前阶段文案：Gate 步 + 任务态推导（§3.10"流水线走到哪一步"） */
function deriveStage(progress: Progress, doingCount: number): string {
  const stepName = STEP_NAME.get(progress.gate.current_step) ?? progress.gate.current_step;
  const last = progress.gate.current_step === GATE_STEPS[GATE_STEPS.length - 1].id;
  const current = progress.gate.history.find((h) => h.step === progress.gate.current_step);
  if (last && current?.result === "pass") return "已交付（七步走完）";
  if (doingCount > 0) return `${stepName} · 开发进行中`;
  return `${stepName} · 待推进`;
}

/**
 * V09-12：图更新状态摘要（**只读**，与 `src/server/work/graphUpdate.ts` 同一份落盘件）。
 * 读不到（没跑过/文件坏）一律 null——读侧不把 null 当"正在更新"（宁可少提示一句）。
 */
function graphUpdateSummaryOf(projectId: string): LiveSnapshot["graph_update"] {
  const rec = readGraphUpdate(projectId);
  if (rec === null) return null;
  return {
    state: rec.state,
    phase: rec.phase ?? null,
    change_token: rec.change_token ?? null,
    updated_at: rec.updated_at,
  };
}

/**
 * 合成实况快照（只读，五源合成）：
 * - 当前 agent：最近更新的 doing 任务的 reporter；agents.json 里有登记就带上 last_active_at；
 *   无 doing 任务 → "user"（球在用户这边，§3.10）。
 * - 动作流：changes（文件变更）/ gate（过关打回）/ tasks（自报，ts 取 updated_at）三源合并，
 *   ts 一律 Date.parse 成毫秒排序（本地 ISO 带偏移直接字符串比会跨时区比错——H2 踩过的坑）。
 */
export function getLive(projectId: string): LiveSnapshot {
  const project = getProject(projectId);
  if (!project) throw new WsError("PROJECT_NOT_FOUND", `项目不存在: ${projectId}`);

  const progress = readProgressReadonly(projectId);
  // V08-01 状态区 v2 派生：任务状态以 **v2 事件投影**为唯一事实源（§2.6），未迁移项目退回 v1 台账
  const ledger = readTaskLedger(projectId);
  const tasks = ledger.rows;
  const gateLines = readGateLines(projectId);
  const changes = readChanges(projectId, 50);

  const counts = { todo: 0, doing: 0, done: 0, blocked: 0 };
  for (const t of tasks) counts[t.status]++;

  const countsV2: Record<string, number> = {};
  for (const t of tasks) {
    if (t.v2_status === null) continue;
    countsV2[t.v2_status_label ?? t.v2_status] = (countsV2[t.v2_status_label ?? t.v2_status] ?? 0) + 1;
  }
  const resultSubmitted = tasks.filter((t) => t.v2_status === "result_submitted").map((t) => t.id);

  // "在干活"取 v2 的认领/执行中（v1 的 doing 只是兼容四态，精度不够）
  const doing = tasks
    .filter((t) => t.v2_status === "claimed" || t.v2_status === "executing" || (t.v2_status === null && t.status === "doing"))
    .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
  const current = doing[0] ?? null;

  let actor: LiveSnapshot["actor"];
  if (current) {
    const registered = listAgents().find((a) => a.name === current.reporter);
    actor = {
      kind: "agent",
      name: current.reporter,
      last_active_at: registered ? registered.last_active_at : null,
    };
  } else {
    actor = { kind: "user", name: "用户", last_active_at: null };
  }

  const events: LiveEvent[] = [
    ...changes.map((c) => ({
      ts: c.ts,
      kind: "change" as const,
      text: `文件${c.action === "add" ? "新增" : c.action === "remove" ? "删除" : "变更"} ${c.path}`,
    })),
    ...gateLines.map((g) => ({
      ts: g.ts,
      kind: "gate" as const,
      text: `Gate「${STEP_NAME.get(g.step) ?? g.step}」${g.result === "pass" ? "过关" : "打回"}${g.note ? `：${g.note}` : ""}`,
    })),
    ...tasks.map((t) => ({
      ts: t.updated_at,
      kind: "task" as const,
      text: `任务 ${t.id}「${t.title}」→ ${t.status}（${t.reporter}）`,
    })),
  ]
    .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))
    .slice(0, 50);

  const stepEntry = progress.gate.history.find((h) => h.step === progress.gate.current_step);

  return {
    stage: deriveStage(progress, counts.doing),
    actor,
    task_counts: counts,
    task_source: ledger.source,
    task_v1_fallback_ids: ledger.v1_fallback_ids,
    task_last_seq: ledger.last_seq,
    task_counts_v2: countsV2,
    result_submitted_ids: resultSubmitted,
    current_task: current
      ? {
          id: current.id,
          title: current.title,
          reporter: current.reporter,
          updated_at: current.updated_at,
          v2_status: current.v2_status,
          v2_status_label: current.v2_status_label,
        }
      : null,
    gate: {
      current_step: progress.gate.current_step,
      step_name: STEP_NAME.get(progress.gate.current_step) ?? progress.gate.current_step,
      result: stepEntry?.result ?? "pending",
    },
    events,
    stall_threshold_ms: DEFAULT_STALL_THRESHOLD_MS,
    last_event_at: events.length > 0 ? events[0].ts : null,
    // V09-12：图更新状态摘要（只读；读不到/没记录 = null，不推断"正在更新"）
    graph_update: graphUpdateSummaryOf(projectId),
  };
}
