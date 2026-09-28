// 用量统计读面（PLAN.md 2026-09-21 契约对齐登记 C017 / V06-10；DESIGN.md §5.7、§6.5 末段）。
//
// 口径（验收分两组互不冒充：本模块是**组② 用量统计**，不碰组① 配额节流行为本身）：
//   · **认领额度＝运营节流**：usage 复用 `budget.ts` 的 `countTaskClaims` **同一口径**（只数认领动作，
//     真实续约/释放不多算），max/remaining/near 由 `readProjectBudget` + `checkProjectBudget` 现算。
//     它只代表"认领了多少次、还能认领几次"，**不是任何实耗**——应答与界面都不得把配额数字
//     表述为费用或成本（契约对齐登记原文）。
//   · **执行耗时**：只有事件流里可核对配对的才给毫秒数——`task.claimed` 与 `execution.delivered`
//     按 `task_id + claim_token` 配对，毫秒 = 两端 `received_at`（写入服务收到事件时落的服务端
//     时间戳）之差。配不到交付回执的如实标「进行中/无来源」，不计毫秒；时间戳解析不出或差值
//     为负同样如实标注，不伪造数字。
//   · **Token / 金额**：只在有可核对来源时才统计（§5.7「无法采集标未知」）。当前执行端回执
//     （execution.* 事件）不携带可核对的 Token 计数，塔台也不回读模型侧账单或私人会话；
//     按 §1.4/§5.7 不设阈值、不设计价算法、不虚构链路——两块都如实「未计量」。
//
// 纯读纯算：不写任何文件、不改事件、不认领、不读 query/前端声明。
import { checkProjectBudget, countTaskClaims, readProjectBudget } from "./budget";
import { loadEvents } from "./eventStore";
import { nowIso } from "../time";

/** 认领额度块的计数来源说明（应答里逐字出现，验证脚本按常量对账） */
export const CLAIM_QUOTA_SOURCE = "work 事件流确定性计数（events.jsonl）";

/** 耗时块的来源说明：写明配对规则与「事件时间戳」这一计量依据 */
export const DURATION_SOURCE =
  "work 事件流确定性配对（events.jsonl）：task.claimed 与 execution.delivered 按 task_id + claim_token 配对，" +
  "毫秒 = 两端 received_at（写入服务收到事件时落的服务端时间戳）之差；只有两端都在事件流里才算得出";

/** 认领额度块的意义声明（运营节流，不是实耗） */
export const CLAIM_QUOTA_MEANING =
  "任务认领额度＝运营节流：只数认领动作本身，不代表任何实耗；达到上限拒绝新认领并留 budget.blocked 证据，" +
  "接近上限如实报剩余（DESIGN.md §5.7 / PLAN.md 2026-09-21 契约对齐登记 C017）";

/** Token 块：缺可核对来源，如实「未计量」（reason 非空、写清为什么） */
export const TOKEN_UNMEASURED: UsageUnmeasured = {
  value: null,
  label: "未计量",
  reason:
    "执行端回执（execution.* 事件）里没有可核对的 Token 计数来源，塔台也不回读模型侧账单或私人会话" +
    "（DESIGN.md §5.7：无法采集的标未知）",
};

/** 金额块：缺可核对来源 + 不建计费链，如实「未计量」 */
export const COST_UNMEASURED: UsageUnmeasured = {
  value: null,
  label: "未计量",
  reason:
    "没有可核对来源：执行端不回传、塔台也不回读模型侧账单；按 §1.4 与 §5.7 不设阈值、不设计价算法、不虚构链路",
};

export interface UsageUnmeasured {
  value: null;
  label: "未计量";
  reason: string;
}

export interface UsageClaimQuota {
  usage: number;
  max: number | null;
  /** 不限为 null；否则 max-usage（不为负） */
  remaining: number | null;
  unit: "认领次数";
  source: typeof CLAIM_QUOTA_SOURCE;
  status: "ok" | "near" | "exhausted";
  /** 仅「接近上限」这一形态为 true；exhausted 是另一形态，两形态互不冒充 */
  near_threshold: boolean;
  limited: boolean;
  /** 剩余工作人话（来自 checkProjectBudget：不限/充足/接近/到顶都如实报剩余） */
  note: string;
  /** 口径声明：运营节流，不代表任何实耗 */
  meaning: typeof CLAIM_QUOTA_MEANING;
}

export interface UsageDurationItem {
  task_id: string;
  owner_id: string | null;
  run_id: string | null;
  attempt_id: string | null;
  attempt: number | null;
  /** 认领凭证只给前 8 位预览（可核对是哪一次认领，又不把完整凭证外发）；完整核对走 claimed_seq */
  claim_token_preview: string;
  claimed_seq: number;
  claimed_at: string;
  delivered_seq: number | null;
  delivered_at: string | null;
  status: "delivered" | "in_progress" | "no_source";
  status_label: string;
  /** 只有 delivered 且两端时间戳都能解析、差值非负才给数字；其余一律 null（不伪造） */
  duration_ms: number | null;
  /** duration_ms 给不出数字时的如实原因；给得出为 null */
  note: string | null;
}

export interface UsageDurations {
  unit: "毫秒";
  source: typeof DURATION_SOURCE;
  summary: {
    /** 认领动作数（与 claim_quota.usage **同口径两遍遍历**：本模块逐行镜像 countTaskClaims 判定） */
    claim_actions: number;
    delivered: number;
    in_progress: number;
    no_source: number;
    /** 事件流里存在、但配不到任何认领动作的 execution.delivered 条数（如实报出，不悄悄丢） */
    unpaired_delivered_events: number;
  };
  items: UsageDurationItem[];
}

export interface ProjectUsage {
  project_id: string;
  generated_at: string;
  last_seq: number;
  claim_quota: UsageClaimQuota;
  durations: UsageDurations;
  token: UsageUnmeasured;
  cost: UsageUnmeasured;
}

const strOrNull = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** 一次认领动作的内部记录（token 完整值只活在模块内，应答只给预览） */
interface ClaimAction {
  taskId: string;
  token: string | null;
  ownerId: string | null;
  runId: string | null;
  attemptId: string | null;
  attempt: number | null;
  seq: number;
  at: string;
}

interface DeliveredEvent {
  taskId: string;
  token: string | null;
  seq: number;
  at: string;
}

/**
 * 从事件流装配项目用量（纯函数式读取：loadEvents 是唯一 IO）。
 *
 * 认领动作的判定**逐行镜像 `budget.ts#countTaskClaims`**（同一份 liveByTask 维护与 genuineRenew
 * 核实，含"非 task: 实体上的 task.claimed 也计认领动作、但不维护 live"这一支）：首次认领建一条
 * item，真实续约只刷新当前认领、不新建 item，伪造续约按认领计（fail-safe）。两边是**同口径
 * 两遍遍历**（本循环收集 item 原料，countTaskClaims 只累加条数；budget.ts 不归本卡改，故谓词
 * 逐行对齐而非抽共用）：若再漂移，「应答 usage == 独立 countTaskClaims」与「usage ==
 * claim_actions（含非 task: 实体认领）」两组对账断言会红。
 */
export function buildProjectUsage(projectId: string, workDir: string): ProjectUsage {
  const { events } = loadEvents(workDir);
  const budget = readProjectBudget(workDir);
  const check = checkProjectBudget(budget, countTaskClaims(events));

  // ── 遍历（与 countTaskClaims **同口径两遍遍历**：控制流逐行镜像 budget.ts，
  //    维护每张卡的当前认领 token 与状态，收集认领动作与交付回执两列事实）──
  const liveByTask = new Map<string, { claim_token: string | null; status: string }>();
  const claims: ClaimAction[] = [];
  const delivered: DeliveredEvent[] = [];
  for (const e of events) {
    const taskId = e.entity_id.startsWith("task:") ? e.entity_id.slice("task:".length) : null;
    if (e.type === "execution.delivered") {
      const p = e.payload;
      const deliveredTaskId = strOrNull(p.task_id);
      if (deliveredTaskId !== null) {
        delivered.push({ taskId: deliveredTaskId, token: strOrNull(p.claim_token), seq: e.seq, at: e.received_at });
      }
      continue;
    }
    if (e.type !== "task.claimed") {
      // 状态迁移（与 countTaskClaims 同一支）：只有 task: 实体有 live 可维护
      if (taskId !== null && taskId !== "") {
        const st = liveByTask.get(taskId);
        if (st !== undefined) {
          if (e.type === "task.status_changed") {
            if (e.payload.claim_released === true) st.claim_token = null;
            const s = strOrNull(e.payload.status);
            if (s !== null) st.status = s;
          } else if (e.type === "task.result_submitted" || e.type === "task.blocked" || e.type === "task.cancelled") {
            st.status = e.type.slice("task.".length);
          }
        }
      }
      continue;
    }
    // task.claimed（与 countTaskClaims 逐行同口径）：真实续约（同 token、状态仍认领/执行中）
    // 不多算；伪造续约按认领计（fail-safe）；**非 task: 实体上的认领也计动作**（通用写口可
    // 直写这种病态事件，countTaskClaims 照数，这里也照记——不维护 live，只留可核对条目）。
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
    if (!genuineRenew) {
      claims.push({
        // 非 task: 实体没有卡号可剥：item 记原始实体 id（可追溯，不虚构卡号）
        taskId: taskId !== null && taskId !== "" ? taskId : e.entity_id,
        token: strOrNull(p.claim_token),
        ownerId: strOrNull(p.owner_id),
        runId: strOrNull(p.run_id),
        attemptId: strOrNull(p.attempt_id),
        attempt: numOrNull(p.attempt),
        seq: e.seq,
        at: e.received_at,
      });
    }
    if (taskId !== null && taskId !== "") {
      liveByTask.set(taskId, {
        claim_token: strOrNull(p.claim_token),
        status: "claimed",
      });
    }
  }

  // ── 配对：每条认领动作找事件流里**第一条**同 task_id + claim_token 的交付回执 ──
  const usedDelivered = new Set<number>();
  const items: UsageDurationItem[] = claims.map((c) => {
    const hit = delivered.find((d) => !usedDelivered.has(d.seq) && d.taskId === c.taskId && d.token === c.token);
    const base = {
      task_id: c.taskId,
      owner_id: c.ownerId,
      run_id: c.runId,
      attempt_id: c.attemptId,
      attempt: c.attempt,
      claim_token_preview: c.token === null ? "（无 token）" : `${c.token.slice(0, 8)}…`,
      claimed_seq: c.seq,
      claimed_at: c.at,
    };
    if (hit === undefined) {
      const live = liveByTask.get(c.taskId);
      const inProgress =
        live !== undefined &&
        live.claim_token !== null &&
        live.claim_token === c.token &&
        (live.status === "claimed" || live.status === "executing");
      return {
        ...base,
        delivered_seq: null,
        delivered_at: null,
        status: inProgress ? ("in_progress" as const) : ("no_source" as const),
        status_label: inProgress
          ? "进行中（认领仍有效，事件流里还没有交付回执，不计毫秒）"
          : "无来源（认领已结束，但事件流里没有可配对的交付回执，不计毫秒）",
        duration_ms: null,
        note: null,
      };
    }
    usedDelivered.add(hit.seq);
    const startMs = Date.parse(c.at);
    const endMs = Date.parse(hit.at);
    if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
      return {
        ...base,
        delivered_seq: hit.seq,
        delivered_at: hit.at,
        status: "delivered" as const,
        status_label: "已交付",
        duration_ms: null,
        note: "两端 received_at 有解析不出的时间戳，不计毫秒（不伪造数字）",
      };
    }
    if (endMs < startMs) {
      return {
        ...base,
        delivered_seq: hit.seq,
        delivered_at: hit.at,
        status: "delivered" as const,
        status_label: "已交付",
        duration_ms: null,
        note: "交付回执的 received_at 早于认领事件（事件流时序异常），不计毫秒（不伪造数字）",
      };
    }
    return {
      ...base,
      delivered_seq: hit.seq,
      delivered_at: hit.at,
      status: "delivered" as const,
      status_label: "已交付（毫秒 = 交付回执与认领事件各自的 received_at 之差）",
      duration_ms: endMs - startMs,
      note: null,
    };
  });

  return {
    project_id: projectId,
    generated_at: nowIso(),
    last_seq: events.length === 0 ? 0 : events[events.length - 1].seq,
    claim_quota: {
      usage: check.usage,
      max: check.max,
      remaining: check.remaining,
      unit: "认领次数",
      source: CLAIM_QUOTA_SOURCE,
      status: check.status,
      near_threshold: check.status === "near",
      limited: check.limited,
      note: check.note,
      meaning: CLAIM_QUOTA_MEANING,
    },
    durations: {
      unit: "毫秒",
      source: DURATION_SOURCE,
      summary: {
        claim_actions: claims.length,
        delivered: items.filter((i) => i.status === "delivered").length,
        in_progress: items.filter((i) => i.status === "in_progress").length,
        no_source: items.filter((i) => i.status === "no_source").length,
        unpaired_delivered_events: delivered.length - usedDelivered.size,
      },
      items,
    },
    token: TOKEN_UNMEASURED,
    cost: COST_UNMEASURED,
  };
}
