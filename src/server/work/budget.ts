// 项目可配置预算约束（PLAN.md T23 / C-017；DESIGN.md §5.7、TPL-10 §六③）。
//
// 口径（一张卡一个可验收结果，别扩成计费平台）：
//   · **单位固定＝任务认领次数**：§5.7 要"具体预算是项目可配置约束，在达到阈值前交检查点和剩余工作"，
//     认领次数是本机可确定性计数、又**不引入 token 计量/账单/单价**的唯一口径
//     （§5.7「无法采集标未知」——不做计费，也就不需要采集那些采不到的值）。
//   · 纯读纯算：`readProjectBudget` 只读 `.工作台/work/budget.json`；`checkProjectBudget` / `countTaskClaims`
//     / `verifyRenewClaimEvent` 都是纯函数。写侧两处共用本模块口径：`claims.claimTask` 的劝告性预查
//     （拒绝时落 `budget.blocked` 留证），以及唯一写入服务文件锁里的权威门禁
//     （C-017 补修 + C017 回炉伪造续约封口，见 `service.ts` submit ②′ 与本文件末「写入边界共口径」）。
//   · **续约不凭自报**（C017 回炉）：一条自称 renew 的 `task.claimed` 是否免门禁/免计数，
//     由 `verifyRenewClaimEvent` 凭**已提交事件现场**核实（当前有效认领 + 持有者 token/身份 +
//     任务状态 + 新租约），绝不凭 payload 的 claim_action 声称——上一轮就是凭自报跳过，
//     伪造 renew 把 max_task_claims 整体架空（反例：临时核验/c017-renew回炉-20260921/out/probe-before.txt）。
//   · **fail-closed**：坏 JSON / 字段类型不对一律抛 `INVALID_COMMAND` 并点名文件，**不静默当不限**。
//     坏配置就放行认领，等于把"约束"悄悄降级成"没约束"，那是 §5.7 明确不许的省略。
import fs from "node:fs";
import path from "node:path";
import { WorkError, type WorkEvent } from "./types";

/** 预算配置文件名（项目 work 目录下：`.工作台/work/budget.json`） */
export const BUDGET_FILE = "budget.json";

/** 本模块登记的 v2 事件词表（登记面见 `types.ts` 的 `REGISTERED_EVENT_TYPES`） */
export const BUDGET_EVENT_TYPES = ["budget.blocked"] as const;
export type BudgetEventType = (typeof BUDGET_EVENT_TYPES)[number];

/** 实体 id 约定：项目级单实体 `budget:<project_id>`（预算约束是**项目可配置约束**，不是某张卡的属性） */
export const BUDGET_ENTITY_PREFIX = "budget:";
export const budgetEntityId = (projectId: string): string => `${BUDGET_ENTITY_PREFIX}${projectId}`;

/** 接近阈值的缺省判定比例（0.8：用量到上限的八成就算"接近"，提前把剩余工作报出来） */
export const DEFAULT_NEAR_THRESHOLD_RATIO = 0.8;

export interface ProjectBudget {
  /** 任务认领次数上限；null＝不限（§5.7：具体预算是项目可配置约束） */
  max_task_claims: number | null;
  /** 接近阈值判定比例（0<r<=1，默认 0.8） */
  near_threshold_ratio: number;
}

function budgetBad(message: string, detail: Record<string, unknown> = {}): never {
  throw new WorkError("INVALID_COMMAND", message, { file: BUDGET_FILE, ...detail });
}

/**
 * 读 `<workDir>/budget.json`。
 * 无文件→`{max_task_claims:null, near_threshold_ratio:0.8}`（没配就是不限）；
 * 坏 JSON / 字段类型不对（max_task_claims 非正整数或 null、ratio 不在 (0,1]）→ 抛 `INVALID_COMMAND`，
 * 点名 budget.json 与原因（fail-closed，不静默当不限）。
 */
export function readProjectBudget(workDir: string): ProjectBudget {
  const file = path.join(workDir, BUDGET_FILE);
  if (!fs.existsSync(file)) {
    return { max_task_claims: null, near_threshold_ratio: DEFAULT_NEAR_THRESHOLD_RATIO };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return budgetBad(`${BUDGET_FILE} 不是合法 JSON：${e instanceof Error ? e.message : String(e)}`, {
      reason: "invalid_json",
    });
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return budgetBad(`${BUDGET_FILE} 必须是 JSON 对象`, { reason: "not_object" });
  }
  const obj = raw as Record<string, unknown>;

  // max_task_claims：必须显式给正整数或 null。缺字段＝配置不完整，不当不限（fail-closed）。
  const max = obj.max_task_claims;
  if (max === undefined) {
    return budgetBad(`${BUDGET_FILE} 缺 max_task_claims（须显式给正整数或 null；缺字段不当不限——fail-closed）`, {
      reason: "missing_max_task_claims",
    });
  }
  if (max !== null && !(typeof max === "number" && Number.isInteger(max) && max > 0)) {
    return budgetBad(`${BUDGET_FILE} 的 max_task_claims 必须是正整数或 null，收到 ${JSON.stringify(max)}`, {
      reason: "invalid_max_task_claims",
      value: max,
    });
  }

  // near_threshold_ratio：给了就必须落在 (0,1]；没给按缺省 0.8（接口注释的"默认 0.8"）。
  const ratio = obj.near_threshold_ratio;
  if (ratio !== undefined && !(typeof ratio === "number" && Number.isFinite(ratio) && ratio > 0 && ratio <= 1)) {
    return budgetBad(`${BUDGET_FILE} 的 near_threshold_ratio 必须在 (0,1]，收到 ${JSON.stringify(ratio)}`, {
      reason: "invalid_near_threshold_ratio",
      value: ratio,
    });
  }

  return {
    max_task_claims: max,
    near_threshold_ratio: ratio === undefined ? DEFAULT_NEAR_THRESHOLD_RATIO : ratio,
  };
}

export interface BudgetCheck {
  status: "ok" | "near" | "exhausted";
  /** near/exhausted 为 true（受限要可见） */
  limited: boolean;
  usage: number;
  max: number | null;
  /** 不限为 null；否则 max-usage（不为负） */
  remaining: number | null;
  /** 必须报剩余工作（如"剩余可认领 1 次"），exhausted 也要如实报 0——不许只说没预算 */
  note: string;
}

/**
 * 纯函数：不限→ok/limited:false；usage>=max→exhausted；usage/max>=ratio→near；否则 ok。
 * note 一律把"还剩几次可认领"说清楚（§5.7 要求在达到阈值前交剩余工作）。
 */
export function checkProjectBudget(budget: ProjectBudget, usage: number): BudgetCheck {
  const max = budget.max_task_claims;
  if (max === null) {
    return {
      status: "ok",
      limited: false,
      usage,
      max: null,
      remaining: null,
      note: `项目未设预算上限（${BUDGET_FILE} 的 max_task_claims 为 null）：不限任务认领次数，当前已认领 ${usage} 次`,
    };
  }
  // remaining 不为负：用量越过上限时如实报 0，不报负数
  const remaining = Math.max(0, max - usage);
  if (usage >= max) {
    return {
      status: "exhausted",
      limited: true,
      usage,
      max,
      remaining: 0,
      note:
        `已达到项目预算约束上限（已认领 ${usage} 次 / 上限 ${max} 次）：剩余可认领 0 次。` +
        "达到约束不是省略验证的理由（DESIGN.md §5.7）",
    };
  }
  if (usage / max >= budget.near_threshold_ratio) {
    return {
      status: "near",
      limited: true,
      usage,
      max,
      remaining,
      note: `接近项目预算约束（已认领 ${usage} 次 / 上限 ${max} 次）：剩余可认领 ${remaining} 次`,
    };
  }
  return {
    status: "ok",
    limited: false,
    usage,
    max,
    remaining,
    note: `项目预算充足（已认领 ${usage} 次 / 上限 ${max} 次）：剩余可认领 ${remaining} 次`,
  };
}

/**
 * 纯函数：数事件流里的**认领动作**条数。
 *
 * 口径稳定：首次认领计 1；释放（带 `claim_released: true` 的 `task.status_changed`）不计；
 * **真实续约**（持有者续自己那一次认领，DESIGN.md §5.8：心跳续约不是再领一张）不计。
 *
 * 与旧实现的差别只在**伪造输入**：`claim_action` 自报 renew、但按事件流核实不成立的，
 * 按认领计（fail-safe，不把计数缺口当"没发生"）。核实项是 `claims.renewClaim` 产品契约
 * 必然满足的子集——该实体当时存在未被 release 打断的认领、payload.claim_token 与之一致、
 * 任务状态处于认领/执行中——所以修复前后**合法历史**（经 renewClaim/写入边界落盘）的计数
 * 结果逐条一致；写入边界（`service.ts` submit ②′）已拒绝伪造 renew 落盘，
 * 本函数对修复后产生的事件流结果不变，对修复前/外部手段混入的伪造 renew 也不再漏计。
 */
export function countTaskClaims(events: readonly WorkEvent[]): number {
  let count = 0;
  // 每张卡的当前认领 token 与状态（沿提交序维护；状态迁移与 tasks.foldTaskStates 同口径）
  const liveByTask = new Map<string, { claim_token: string | null; status: string }>();
  for (const e of events) {
    const taskId = e.entity_id.startsWith("task:") ? e.entity_id.slice("task:".length) : null;
    if (e.type !== "task.claimed") {
      if (taskId !== null && taskId !== "") {
        const st = liveByTask.get(taskId);
        if (st !== undefined) {
          if (e.type === "task.status_changed") {
            if (e.payload.claim_released === true) st.claim_token = null;
            const s = e.payload.status;
            if (typeof s === "string" && s !== "") st.status = s;
          } else if (e.type === "task.result_submitted" || e.type === "task.blocked" || e.type === "task.cancelled") {
            st.status = e.type.slice("task.".length);
          }
        }
      }
      continue;
    }
    const p = e.payload;
    let genuineRenew = false;
    if (p.claim_action === "renew" && taskId !== null && taskId !== "") {
      const st = liveByTask.get(taskId);
      genuineRenew =
        st !== undefined &&
        st.claim_token !== null &&
        p.claim_token === st.claim_token &&
        (st.status === "claimed" || st.status === "executing");
    }
    if (!genuineRenew) count += 1;
    if (taskId !== null && taskId !== "") {
      const t = p.claim_token;
      liveByTask.set(taskId, {
        claim_token: typeof t === "string" && t !== "" ? t : null,
        status: "claimed",
      });
    }
  }
  return count;
}

// ── 写入边界共口径（C-017 批3终审补修）──
//
// 预算门禁的**唯一权威执行点**在唯一写入服务的文件锁里（`service.ts` submit ②′）：
// 任何 `task.claimed`（renew 除外）命令——不论来自 `claims.claimTask` 还是直连通用写口——
// 都在「读事件 → 判预算 → 追加」的同一临界区里原子完成检查与保留。
// `claims.claimTask` 里的预算预查仍在，但只是**劝告性**的（给出好读的拒绝消息与 near 提示）；
// 并发越限与通用写口绕过由写入边界兜底。本节是两侧共用的判定与留证推导，别让两边各写一份。

/** 一条命令是不是"消耗项目预算的认领动作"。`renewVerified` 只能来自**事件现场核实**
 * （`verifyRenewClaimEvent` 的 ok），绝不来自 payload 自报的 `claim_action`——
 * 上一轮凭自报跳过，伪造 renew 把整个预算门禁架空（C017 回炉）。 */
export function isBudgetGatedClaimEvent(type: string, renewVerified: boolean): boolean {
  return type === "task.claimed" && !renewVerified;
}

/** 写入边界伪造续约拒绝的错误标记（`WorkError.detail.reason`）：自称 renew 但事件现场核实不成立 */
export const FORGED_RENEW_DETAIL_REASON = "renew_not_verified";

/** 一个异常是不是写入边界落下的伪造续约拒绝（带本标记的 INVALID_COMMAND） */
export function isForgedRenewError(e: unknown): e is WorkError {
  return (
    e instanceof WorkError &&
    e.code === "INVALID_COMMAND" &&
    (e.detail as Record<string, unknown>).reason === FORGED_RENEW_DETAIL_REASON
  );
}

/** 续约资格核实结论（failures 逐条如实列出，不合并成一句） */
export interface RenewVerification {
  ok: boolean;
  failures: string[];
  /** 事件现场里的当前认领（无有效认领为 null；仅供错误消息与审计引用） */
  live: { claim_token: string | null; owner_id: string | null } | null;
}

const renewStrOrNull = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/**
 * 一条自称 renew 的 `task.claimed` 是否真的是"持有者续自己那一次认领"——凭**已提交事件现场**
 * 核实（纯函数，events 用提交序），不凭 payload 声称。核实项与 `claims.renewClaim` 的产品契约
 * 一一对应（DESIGN.md §6.5：只有持有者能续自己那一次认领）：
 *   · **task_id**：实体必须是 `task:<非空 id>`——别的实体上没有"那一次认领"；
 *   · **已有有效认领**：事件流里存在未被 release 打断的认领（claim/renew）；从未被认领、
 *     已释放、已交付、已取消的任务没有"当前认领"可续；
 *   · **身份**：`payload.claim_token` 必须等于当前认领的 token（不可猜测的持有凭证）；
 *     `payload.owner_id` 与提交者 `actorId` 必须等于当前认领的持有者（替别人续不是"续自己那次"）；
 *   · **事件状态**：任务当前必须处于认领/执行中（与 renewClaim 的状态门禁同口径）；
 *   · **租约**：续约必须携带可解析的新租约到期时间（续约就是延长租约）；
 *     旧租约已到期**不**构成拒绝——持有者续约正是租约到期后的恢复路径（renewClaim 同口径）。
 */
export function verifyRenewClaimEvent(
  events: readonly WorkEvent[],
  entityId: string,
  payload: Record<string, unknown> | undefined,
  actorId: string,
): RenewVerification {
  const taskId = entityId.startsWith("task:") ? entityId.slice("task:".length) : null;
  if (taskId === null || taskId === "") {
    return {
      ok: false,
      failures: [`续约的实体必须是 task:<task_id>，收到 ${JSON.stringify(entityId)}：别的实体上没有"那一次认领"可续`],
      live: null,
    };
  }
  // 沿提交序走一遍这张卡的认领与状态（与 tasks.foldTaskStates 同口径）：
  // task.claimed（claim/renew）建立或刷新当前认领；带 claim_released 的 status_changed 终结它。
  let live: { claim_token: string | null; owner_id: string | null } | null = null;
  let status = "preparing";
  for (const e of events) {
    if (e.entity_id !== entityId) continue;
    const p = e.payload;
    if (e.type === "task.claimed") {
      live = { claim_token: renewStrOrNull(p.claim_token), owner_id: renewStrOrNull(p.owner_id) };
      status = "claimed";
    } else if (e.type === "task.status_changed") {
      if (p.claim_released === true) live = null;
      status = renewStrOrNull(p.status) ?? status;
    } else if (e.type === "task.result_submitted") {
      status = "result_submitted";
    } else if (e.type === "task.blocked") {
      status = "blocked";
    } else if (e.type === "task.cancelled") {
      status = "cancelled";
    }
  }
  if (live === null) {
    return {
      ok: false,
      failures: [
        `任务 ${taskId} 当前没有有效认领（从未被认领，或认领已释放）：没有"自己那一次认领"可续；要领取请提交首次认领`,
      ],
      live: null,
    };
  }
  const failures: string[] = [];
  const p = payload ?? {};
  if (live.claim_token === null) {
    failures.push(`任务 ${taskId} 的当前认领记录缺 claim_token（历史事件异常）：无法核实持有关系，按拒绝处理`);
  } else if (p.claim_token !== live.claim_token) {
    failures.push(
      `payload.claim_token 与任务 ${taskId} 当前认领的 token 不一致：只有持有者能续自己那一次认领（DESIGN.md §6.5）`,
    );
  }
  if (live.owner_id !== null) {
    if (p.owner_id !== live.owner_id) {
      failures.push(
        `payload.owner_id（${JSON.stringify(p.owner_id ?? null)}）与当前认领的持有者（${live.owner_id}）不一致：续约必须来自持有者本人`,
      );
    }
    if (actorId !== live.owner_id) {
      failures.push(`提交者 actor_id（${actorId}）与当前认领的持有者（${live.owner_id}）不一致：不能替别人续约`);
    }
  }
  if (status !== "claimed" && status !== "executing") {
    failures.push(`任务 ${taskId} 当前状态是「${status}」，不是认领/执行中：没有可续的进行中认领`);
  }
  const lease = renewStrOrNull(p.lease_expires_at);
  if (lease === null || Number.isNaN(Date.parse(lease))) {
    failures.push(`续约必须携带可解析的新租约到期时间 lease_expires_at（续约就是延长租约），收到 ${JSON.stringify(p.lease_expires_at ?? null)}`);
  }
  return { ok: failures.length === 0, failures, live };
}

/**
 * `budget.blocked` 留证事件的幂等键（写入边界代写与 claimTask 预查路径**同一推导**）：
 * 带上"哪张卡/哪个用量/谁的意图"——同一次意图重发命中去重（不刷屏），
 * 不同任务或不同用量各自留一条（口径同 §6.7 的认领幂等键思路）。
 */
export function budgetBlockedIdempotencyKey(
  entityId: string,
  taskId: string,
  usage: number,
  max: number | null,
  ownerId: string,
): string {
  return `${entityId}:budget.blocked:${taskId}:${usage}:${max ?? "null"}:${ownerId}`;
}

/** `budget.blocked` 留证事件的 payload（两侧同一形状，读侧与重放只认这一份） */
export function budgetBlockedPayload(usage: number, max: number | null, taskId: string): Record<string, unknown> {
  return {
    usage,
    max,
    task_id: taskId,
    reason: "达到项目预算约束上限（§5.7：达到约束不是省略验证的理由）",
  };
}

/**
 * 写入边界预算拒绝的错误标记（`WorkError.detail.reason`）。
 * 错误码全集里没有 BUDGET_EXHAUSTED（types.ts 不归本卡所有），写入边界用 `INVALID_COMMAND` + 本标记；
 * `claims.claimTask` 凭标记把它翻译回面向调用方的 `BUDGET_EXHAUSTED` 失败，不靠解析 message。
 */
export const BUDGET_EXHAUSTED_DETAIL_REASON = "budget_exhausted";

/** 一个异常是不是写入边界落下的预算拒绝（带本标记的 INVALID_COMMAND） */
export function isBudgetExhaustedError(e: unknown): e is WorkError {
  return (
    e instanceof WorkError &&
    e.code === "INVALID_COMMAND" &&
    (e.detail as Record<string, unknown>).reason === BUDGET_EXHAUSTED_DETAIL_REASON
  );
}
