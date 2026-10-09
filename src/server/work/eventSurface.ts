// 事件面登记表与全覆盖检查（PLAN V07-02/V07-04；「系统能进的状态必须有出口」）。
// 事件注册表（types.ts REGISTERED_EVENT_TYPES）每一种类型必须有：MCP 工具触发路径
// （mcp:<工具名>，且工具必须真实存在于 TOOLS 注册表）或白名单「仅系统内部」并写明来源。
// 本模块是唯一事实源：scripts/check-event-surface.ts（CLI）与 doctor 工具（MCP）都从这读。
//
// 为什么两处要共用一份：CLI 与 doctor 若各写一张表，检查就会各说各话——登记面加上一处出口，
// 另一个入口仍报旧结论，接手 agent 拿到的是"两份都像真的"健康报告。故判据只在这里。
//
// 为什么工具名单是**注入**的而不是 `import { TOOLS }`（2026-09-22 批外缺陷修复）：
// `mcp/tools/index.ts → doctor.ts → 本模块 → index.ts` 原本成环，单独 `import doctor.ts` 会
// 在 index.ts 求值到 `TOOLS = [... doctorTool ...]` 时撞上 TDZ（`Cannot access 'doctorTool' before
// initialization`）。本模块在分层上是下层，**不反向 import 上层注册表**；名单由持有者
// （`mcp/tools/index.ts`）在自身求值时登记，显式传参优先（破坏性试验就靠它抽走某个工具）。
// 未登记时**如实报红**（不是静默全绿）：拿不到工具名单就核不了 mcp: 出口是否真实存在。
import { REGISTERED_EVENT_TYPES } from "./types";

/** 工具名单来源（返回 MCP 工具注册表里的工具名；由持有注册表的模块登记） */
export type ToolNameSource = () => readonly string[];

let toolNameSource: ToolNameSource | null = null;

/** 登记工具名单来源（由 `mcp/tools/index.ts` 在自身求值末尾调用；重复登记以后一次为准） */
export function registerToolNameSource(source: ToolNameSource): void {
  toolNameSource = source;
}

/** 当前是否已有工具名单来源（给"单独 import 本模块"的调用方一个可判定的信号） */
export function toolNameSourceRegistered(): boolean {
  return toolNameSource !== null;
}

/**
 * 事件面登记表。surface 取值：
 *   mcp:<工具名>      —— 有 MCP 工具触发路径（工具必须在 TOOLS 里真实存在，导入注册表断言）
 *   internal:<模块>   —— 仅系统内部：服务端流程在特定时机自发，不暴露外部触发口
 */
export const EVENT_SURFACE: Readonly<Record<string, string>> = {
  // ── 任务域 ──
  "task.definition_imported": "mcp:import_plan_definitions",
  "task.status_changed": "mcp:report_task_status", // V09-27：Agent 可经 report_task_status(v2) 报 doing/解阻；迁移回放/释放仍内部自写
  "task.claimed": "mcp:claim_task",
  "task.result_submitted": "mcp:submit_task_result",
  "task.blocked": "mcp:report_task_status", // V09-27：阻塞上报的可达入口（report_task_status(status=blocked)）
  "task.cancelled": "internal:执行端/协调器经命令面取消（§5.4）",
  "task.rebound": "mcp:rebind_task",
  // V09-10（附录 F）：协调器受控重开同卡新 attempt——经 claim_task 的 op=reopen（不新增工具）
  "task.reopened": "mcp:claim_task",
  // ── 缺陷域（V06-09：审计流服务端自发；V09-27 起经 record_work_evidence(finding) 可达） ──
  "finding.opened": "mcp:record_work_evidence",
  "finding.reported_again": "mcp:record_work_evidence",
  "finding.transition": "mcp:record_work_evidence",
  "finding.fix_submitted": "mcp:record_work_evidence",
  "finding.retest_recorded": "mcp:record_work_evidence",
  "finding.accepted_risk": "internal:evidence(接受风险，role 必须 user——Agent 工具不暴露)", // 只有用户能触发
  // ── 审计/验收域（人工验收只有人能触发；其余 V09-27 起经 record_work_evidence 可达） ──
  "audit.submission_submitted": "mcp:record_work_evidence",
  "audit.self_check_recorded": "mcp:record_work_evidence",
  "audit.independent_audit_recorded": "mcp:record_work_evidence",
  "audit.fix_recorded": "mcp:record_work_evidence",
  "audit.record_corrected": "mcp:record_work_evidence",
  "audit.retest_recorded": "mcp:record_work_evidence",
  "audit.human_acceptance_recorded": "internal:audit(人工验收——用户在 Gate 页面触发，Agent 不代点)", // 只有用户能触发
  // ── 执行回执域（V06-11 外部执行器回执链；V09-27 起经 report_execution 可达） ──
  "execution.start_requested": "mcp:report_execution",
  "execution.started": "mcp:report_execution",
  "execution.heartbeat": "mcp:report_execution",
  "execution.checkpoint": "mcp:report_execution",
  "execution.stop_requested": "mcp:report_execution",
  "execution.stopped": "mcp:report_execution",
  "execution.failed": "mcp:report_execution",
  "execution.effect_declared": "mcp:report_execution",
  "execution.effect_confirmed": "mcp:report_execution",
  "execution.effect_unverified": "mcp:report_execution",
  "execution.delivered": "mcp:report_execution",
  // ── 需求/变更域（C-015 对象命令） ──
  "requirement.registered": "mcp:manage_requirement",
  "requirement.updated": "mcp:manage_requirement",
  "requirement.status_changed": "mcp:manage_requirement",
  "change.opened": "mcp:manage_change",
  "change.status_changed": "mcp:manage_change",
  "change.closed": "mcp:manage_change",
  "change.adopted_chat_change": "mcp:manage_change",
  "change.blueprint_inheritance_recorded": "internal:blueprintInheritance(图纸继承事实，经命令面落账)",
  // ── 预算闸 ──
  "budget.blocked": "internal:WorkService(认领配额闸自发拒绝事件，§5.7)",
  // ── 同步证据域（V09-23；DESIGN §2.10）──
  "sync.contract_registered": "mcp:register_sync_contract",
  "sync.evidence_checked": "mcp:scan_sync_evidence",
};

export interface SurfaceCheckResult {
  ok: boolean;
  problems: string[];
  covered: number;
  toolSurfaces: string[];
}

/** 核心检查（工具名单可显式传——verify 用它做破坏性试验：抽走一个工具必须红；
 *  不传则用已登记的工具名单来源，未登记时如实报红而不是静默全绿） */
export function checkEventSurface(toolNames?: readonly string[]): SurfaceCheckResult {
  const problems: string[] = [];
  const registered = new Set(REGISTERED_EVENT_TYPES.map((r) => r.type));
  const names = toolNames ?? (toolNameSource === null ? null : toolNameSource());
  if (names === null) {
    return {
      ok: false,
      problems: [
        "工具名单来源未登记（`mcp/tools/index.ts` 没有被求值）：核不了 mcp: 出口是否真实存在——" +
          "拿不到注册表就不报「健康」，该入口必须先 import 工具注册表（或用 checkEventSurface(toolNames) 显式传名单）",
      ],
      covered: registered.size,
      toolSurfaces: [],
    };
  }
  const toolSet = new Set(names);

  for (const type of registered) {
    const surface = EVENT_SURFACE[type];
    if (surface === undefined) {
      problems.push(`事件类型 ${type} 在事件面登记表（src/server/work/eventSurface.ts）里没有登记——系统能进的状态必须有出口或声明来源`);
      continue;
    }
    if (surface.startsWith("mcp:")) {
      const tool = surface.slice("mcp:".length);
      if (!toolSet.has(tool)) {
        problems.push(`事件类型 ${type} 声明的触发工具 ${tool} 不在 MCP 工具注册表里（TOOLS）——出口名存实亡`);
      }
    }
  }
  for (const type of Object.keys(EVENT_SURFACE)) {
    if (!registered.has(type)) {
      problems.push(`登记表里的 ${type} 不在事件注册表（REGISTERED_EVENT_TYPES）里——拼错或幽灵类型`);
    }
  }
  return {
    ok: problems.length === 0,
    problems,
    covered: registered.size,
    toolSurfaces: Object.entries(EVENT_SURFACE)
      .filter(([, s]) => s.startsWith("mcp:"))
      .map(([t, s]) => `${t} → ${s}`),
  };
}
