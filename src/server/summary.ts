// P2 跨项目汇总的**只读合成层**（PLAN P2 卡；`DESIGN.md` §11.2 二期「多项目并行增强」）。
//
// 本模块只干三件事：读注册表 → 逐项目读四个数据源 → 交给 P1 的汇总函数。
// **汇总口径一行都不在这里实现**——行的字段、排序键、分桶、缺文件合成口径全部来自
// `src/server/projects-summary.ts`（P1 定版）。这里再写一份就是 PLAN P2 跑偏点说的
// 「和 P1 规则悄悄分叉」，所以本文件的全部口径相关 import 都指向 P1 与实况层。
//
// ████████████████████████ 只读红线（P2 卡约束） ████████████████████████
// 本模块【不写任何被纳管项目的文件】：不建目录、不初始化 progress.json、不动注册表
// （不写 last_opened_at）。为此四个数据源一律走各自的"只读口径"读函数：
//   · progress.json → live.ts#readProgressReadonly（缺文件按初始态合成，绝不落盘）
//   · tasks.json    → workstation#readTasks（缺文件即空表）
//   · gate.jsonl    → workstation#readGateLines（缺文件即空数组）
//   · changes.jsonl → watcher#readChanges（缺文件即空数组）
// ██████████████████████████████████████████████████████████████████████

import { listProjects, type ProjectRecord } from "./registry";
import { readProgressReadonly } from "./live";
import { readGateLines, readTaskLedger } from "./workstation";
import { readChanges } from "./watcher";
import { sanitizeErrorMessage } from "./redact";
import {
  SUMMARY_SCOPES,
  groupRowsByGateStep,
  summarizeProjects,
  type GateStepGroup,
  type ProjectSummaryInput,
  type ProjectSummaryRow,
  type SummaryScope,
} from "./projects-summary";

/** 默认口径 = 按项目一行（P1 `SUMMARY_SCOPES.PROJECT_ROW`：日常巡检的第一视图） */
export const DEFAULT_SUMMARY_SCOPE: SummaryScope = "PROJECT_ROW";

/** 某个项目四个数据源读失败（文件损坏等）时的登记项：顶层字段，**不是行字段**（不撑宽 ROW_FIELDS） */
export interface SummaryReadError {
  project_id: string;
  message: string;
}

/** `GET /api/summary/projects` 的响应体（两种口径一次给全，前端切换零请求） */
export interface ProjectsSummaryPayload {
  /** 默认口径键（前端初次进来用哪个） */
  default_scope: SummaryScope;
  /** 口径清单（P1 SUMMARY_SCOPES 原文：显示名/适用场景由 P1 定，前端不另抄文案） */
  scopes: typeof SUMMARY_SCOPES;
  /** 按项目一行（P1 summarizeProjects 的输出，已按 SORT_RULE 排好） */
  rows: ProjectSummaryRow[];
  /**
   * 按 Gate 步分桶——**同一批行的分组渲染**（P1 groupRowsByGateStep，组内保持 rows 的顺序）。
   * 两种口径共用上面那份 rows，不新读数据源、不产生第二种「当前步」（P1 GATE_MERGE_RULE）。
   */
  groups: GateStepGroup[];
  /** 读失败的项目（有内容就上屏警告条；不静默丢项目，也不为它造一个违规的行） */
  errors: SummaryReadError[];
}

/** 一个项目的四个只读数据源 → P1 的汇总输入（缺文件全走各自既定的空态口径） */
function readSummaryInput(project: ProjectRecord): ProjectSummaryInput {
  const gateLines = readGateLines(project.id);
  const changes = readChanges(project.id, 1); // 倒序，最新在第一行；与 live.ts 取动作流 top-1 的同一窗口口径
  return {
    project,
    progress: readProgressReadonly(project.id),
    // V08-01：任务状态与 /live 同源（v2 事件投影优先，未迁移项目退回 v1 台账）
    tasks: readTaskLedger(project.id).rows,
    latest_gate_ts: gateLines.length > 0 ? gateLines[gateLines.length - 1].ts : null,
    latest_change_ts: changes.length > 0 ? changes[0].ts : null,
  };
}

/**
 * 汇总全部已登记项目（跨项目视图的唯一数据口）。
 * 逐项目 try/catch：某个项目的文件损坏只把它记进 `errors`，不让一屏全黑；
 * 读成功的项目照常出行——行数因此恒等于「读得到的项目」，不静默少算。
 */
export function summarizeAllProjects(): ProjectsSummaryPayload {
  const inputs: ProjectSummaryInput[] = [];
  const errors: SummaryReadError[] = [];
  for (const project of listProjects()) {
    try {
      inputs.push(readSummaryInput(project));
    } catch (e) {
      // Q68（2026-09-18 审计）：这条 message 会经 `GET /api/summary/projects` 出网，而 fs 级异常的原文
      // 常带本机绝对路径（`readProgressReadonly`/`readChanges` 的 EPERM/EACCES/EISDIR 等）；**键级**裁剪
      // （`withoutLocalPaths` 的 REMOTE_PATH_KEYS）不含 `errors[].message`，裁不到它——这里补**消息级**脱敏
      // （与同仓 500 分支、flash.ts、watcher.ts 同一口径：`redact.ts` 是唯一出处）。
      errors.push({ project_id: project.id, message: sanitizeErrorMessage((e as Error).message) });
    }
  }
  const rows = summarizeProjects(inputs); // ← P1 唯一实现（排序也在里面）
  return {
    default_scope: DEFAULT_SUMMARY_SCOPE,
    scopes: SUMMARY_SCOPES,
    rows,
    // ← P1 唯一实现（分组键取行里已有的 gate.current_step）。
    // includeEmptySteps:true：分桶视图的用途就是「阶段盘点」（P1 GATE_STEP_GROUP 的 when），
    // 七步全列出来才看得出「哪几步没人、哪一步堆了几个」；组内保持 rows 的顺序。
    groups: groupRowsByGateStep(rows, true),
    errors,
  };
}
