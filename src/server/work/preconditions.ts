// V09-34 接续前置事实说明（PLAN.md V09-34；DESIGN.md §6.7；docs/unified-optimization-contract.md U3）。
//
// 目标：把**本次请求已经算出来的** `EntryFacts` 与已定 `next_action` 转成人能读的「前置说明」——缺什么、
// 责任角色是谁、下一步合法动作是什么，逐项标来源与补取入口（OPT-05）。
//
// 三条自证红线（本模块的设计约束）：
//   · **只说明**：每条 `blocking: false`，`advisory_only: true`；本模块**不改** `next_action`/`reasons`，
//     也不参与任何门禁判定——它只解释已定的结论。
//   · **不重新核验**：全部输入来自调用方传入的、已经算好的 facts 与已定的 action；本模块**零 IO**、
//     不 import 任何读取器（只 import 类型），不为提示另跑一套 doctor。
//   · **不代签用户 Gate**：只复述既有判据（基线/图纸/卡/执行/角色），不新增任何用户批准。
//
// 与「缺项/责任角色/下一步」的对应：缺项 → 各前置项的 status/detail；责任角色 → role 项；下一步 → next_step 项。

import type { CapabilityDiscovery, CurrentRun, EntryFacts, ProjectEntryAction } from "./entry";

/** 一项前置说明的状态（**说明**，不是门禁） */
export type PreconditionStatus = "satisfied" | "missing" | "attention" | "unknown" | "not_applicable";

export type PreconditionKind =
  | "ledger"
  | "baseline"
  | "source_version"
  | "task_definitions"
  | "sync"
  | "stage_reads"
  | "role"
  | "capability"
  | "execution_site"
  | "next_step";

export interface PreconditionItem {
  /** 稳定 id（同一次请求内唯一、可读） */
  id: string;
  kind: PreconditionKind;
  /** 该前置现在满足没有（**说明**：不满足也只是解释为什么停在当前动作，绝不当新门禁） */
  status: PreconditionStatus;
  detail: string;
  /** 来源（项目内相对路径 + 版本；不要本机绝对路径） */
  source: { path: string | null; revision: string | null };
  /** 补取入口（相对路径 / 工具调用；没有就是 null） */
  fetch: string | null;
  /** 恒为 false：本清单只作说明，绝不新增门禁（V09-34 红线） */
  blocking: false;
}

/** 接续前置事实说明（V09-34）：从已算 `EntryFacts` 派生，只解释、不判。 */
export interface EntryPreconditions {
  /** 本次 `next_action` 的复述（仅复述，不参与判定） */
  for_action: ProjectEntryAction;
  /** 逐项前置说明（顺序稳定） */
  items: PreconditionItem[];
  /** 恒为 true：本清单不新增任何门禁 */
  advisory_only: true;
}

/** 派生输入：全部是**已经算好**的东西（facts、已定 action、已算的 runs），本模块不再读任何现场。 */
export interface PreconditionInput {
  facts: EntryFacts;
  action: ProjectEntryAction;
  role: string;
  roleClass: string;
  capability: CapabilityDiscovery;
  /** 已算的未结束 run（`currentRunsOf` 的结果；只为 execution_site 解释，不重算） */
  runs: CurrentRun[];
  /** 本次动作指向的任务（来自已定 decision 的 reasons；没有就是 null） */
  chosenTaskId: string | null;
}

const WORKBENCH = ".工作台";
const EVENTS_REL = `${WORKBENCH}/work/events.jsonl`;
const BASELINES_REL = `${WORKBENCH}/baselines.jsonl`;

const short = (sha: string | null | undefined): string => (sha === null || sha === undefined || sha === "" ? "（无）" : `${sha.slice(0, 12)}…`);

function item(part: Omit<PreconditionItem, "blocking">): PreconditionItem {
  return { ...part, blocking: false };
}

/**
 * 从已算的现场事实派生接续前置说明。**纯函数**：不改 facts、不做 IO、不新增门禁。
 */
export function preconditionsOf(input: PreconditionInput): EntryPreconditions {
  const { facts, action, role, roleClass, capability, runs, chosenTaskId } = input;
  const items: PreconditionItem[] = [];

  // ① 事件账本可读性（其余一切事实的来源）
  if (facts.unreadable === null) {
    // V09-31 复审：不能无条件声称「同一份现读快照」——只有本次**真的**复用了同一份快照（`eventsShared`）
    // 才这么说；否则如实写"快照读不出/未共享，下游各处按同一 workDir 现读回退"（不虚假声明全链同版）。
    const detail = facts.eventsShared
      ? "事件账本可读：本次请求的任务状态/认领/执行回执/同步判据/投影都出自**同一份现读快照**" +
        "（V09-30/31，同一 workDir、同一截点；不跨请求缓存旧绿）。"
      : "事件账本可读，但本次**没有**复用到同一份现读快照" +
        (facts.eventsSnapshotUnreadable === null ? "（未提供共享快照）。" : `（快照读不出：${facts.eventsSnapshotUnreadable}）。`) +
        "下游各判据按同一 workDir **各自现读**回退，不跨请求缓存旧绿。";
    items.push(
      item({
        id: "ledger.readable",
        kind: "ledger",
        status: "satisfied",
        detail,
        source: { path: EVENTS_REL, revision: null },
        fetch: null,
      }),
    );
  } else {
    items.push(
      item({
        id: "ledger.readable",
        kind: "ledger",
        status: "unknown",
        detail: `事件账本读不出来（${facts.unreadable}）：读失败就按**未知**处理——不是"没有事件"，也不能据此判完成。`,
        source: { path: EVENTS_REL, revision: null },
        fetch: EVENTS_REL,
      }),
    );
  }

  // ② 有效基线（V09-31 复审：用结构化 `baselineValid`/`baselineSourceChanged`，不拿中文消息 substring 匹配——
  //    保全对象篡改/缺失等其它失效理由同样不能标 satisfied；失效理由原样整条带出）
  if (facts.baseline === null) {
    items.push(
      item({
        id: "baseline.active",
        kind: "baseline",
        status: "missing",
        detail:
          "还没有生效的成套图纸基线：需要由**用户本人或获授权的设计/协调角色**审定并激活（DESIGN.md §2.9）；" +
          `塔台的说明到此为止（不代签用户 Gate）。现场理由：${facts.baselineRevalidate.join("；") || "（无）"}`,
        source: { path: BASELINES_REL, revision: null },
        fetch: 'manage_baseline {op:"read", project_id}',
      }),
    );
  } else if (!facts.baselineValid) {
    // 有任何失效理由（源在激活后变过 / 保全对象篡改 / 缺失 / 流水不可读……）都不是 satisfied：
    // 逐条原样带出现场理由，不拿其中某一句去猜是哪一种。
    items.push(
      item({
        id: "baseline.active",
        kind: "baseline",
        status: "attention",
        detail:
          `生效基线 ${facts.baseline.baseline_id} 存在，但当前**不是**有效基线` +
          (facts.baselineSourceChanged ? "（设计/施工图源在激活后变过：影响待查）" : "（现场校验未通过）") +
          `：当前不受该基线批准覆盖（DESIGN.md §5.6）。现场理由：${facts.baselineRevalidate.join("；") || "（无）"}`,
        source: { path: BASELINES_REL, revision: facts.baseline.baseline_id },
        fetch: 'manage_baseline {op:"read", project_id}',
      }),
    );
  } else {
    items.push(
      item({
        id: "baseline.active",
        kind: "baseline",
        status: "satisfied",
        detail: `生效基线 ${facts.baseline.baseline_id}（审定 ${facts.baseline.approved_by} / ${facts.baseline.approval_kind}）。`,
        source: { path: BASELINES_REL, revision: facts.baseline.baseline_id },
        fetch: null,
      }),
    );
  }

  // ③ 设计/施工图源
  {
    const design = facts.design;
    const plan = facts.plan;
    if (design === null || plan === null) {
      const missing = [design === null ? "设计书" : null, plan === null ? "施工图" : null].filter((x): x is string => x !== null);
      items.push(
        item({
          id: "source.versioned_docs",
          kind: "source_version",
          status: "missing",
          detail: `缺 ${missing.join("、")}源：先确认项目登记的设计/施工图路径（DESIGN.md §2.9），别拿摘要当依据。`,
          source: { path: `${WORKBENCH}/design.md｜${WORKBENCH}/plan.md`, revision: null },
          fetch: 'manage_baseline {op:"read", project_id}（只读两份源与生效基线）',
        }),
      );
    } else {
      items.push(
        item({
          id: "source.versioned_docs",
          kind: "source_version",
          status: "satisfied",
          detail:
            `设计书内容 ${short(design.revision.content_sha256)}、施工图内容 ${short(plan.revision.content_sha256)}` +
            `／定义 ${short(plan.revision.definition_sha256)}（基线比设计内容哈希、施工图**定义**哈希，§2.9）。`,
          source: { path: plan.source.rel_path, revision: plan.revision.content_sha256 },
          fetch: null,
        }),
      );
    }
  }

  // ④ 卡定义解析与入账
  {
    const alignNotes: string[] = [];
    if (facts.align.needs_rebind.length > 0) alignNotes.push(`待重绑 ${facts.align.needs_rebind.length} 张`);
    if (facts.align.orphan_states.length > 0) alignNotes.push(`孤儿状态 ${facts.align.orphan_states.length} 张`);
    const suffix = alignNotes.length > 0 ? `；对账异常：${alignNotes.join("、")}（明细见 next_action 的 reasons）` : "";
    if (facts.plan === null) {
      items.push(
        item({
          id: "definitions.parsed",
          kind: "task_definitions",
          status: "unknown",
          detail: `施工图源缺失，无法核对卡定义${suffix}`,
          source: { path: `${WORKBENCH}/plan.md`, revision: null },
          fetch: `${WORKBENCH}/plan.md`,
        }),
      );
    } else if (facts.definitions.length === 0) {
      // V09-31 复审：定义**解析**与**账本入账**是两件事，分别列明——"解析不到定义"不能说成"施工图未入账"。
      const entered = Object.keys(facts.states).length;
      items.push(
        item({
          id: "definitions.parsed",
          kind: "task_definitions",
          status: "missing",
          detail:
            `施工图已读到，但**解析不出任务定义**（正文里没有可识别的卡定义表 / 表结构不符）：这是**定义解析**的结果；` +
            `与"账本是否已入账运行状态"是两件事——账本现值 ${entered} 张卡有状态。${suffix}`,
          source: { path: facts.plan.source.rel_path, revision: facts.plan.revision.definition_sha256 },
          fetch: facts.plan.source.rel_path,
        }),
      );
    } else {
      const entered = Object.keys(facts.states).length;
      items.push(
        item({
          id: "definitions.parsed",
          kind: "task_definitions",
          status: "satisfied",
          detail: `施工图解析出 ${facts.definitions.length} 张卡；账本里 ${entered} 张有运行状态（定义已入账才谈得上状态）${suffix}`,
          source: { path: facts.plan.source.rel_path, revision: facts.plan.revision.definition_sha256 },
          fetch: null,
        }),
      );
    }
  }

  // ⑤ 同步证据（V09-31 复审三分）：
  //   · 读不出来（`syncBlockUnreadable`）＝ **unknown**——**绝不**显示成「未配置」（那是另一种事实）；
  //   · 真未配置（syncBlock 给出 configured=false）＝ not_configured（老项目零影响）；
  //   · 配置过：`satisfied` 只认 overall=passed（`blocked=false` 不等于 passed）；阻断/非通过都如实列出。
  if (facts.syncBlockUnreadable !== null) {
    items.push(
      item({
        id: "sync.gate",
        kind: "sync",
        status: "unknown",
        detail:
          `同步证据现场**读不出来**（${facts.syncBlockUnreadable}）：按未知处理——不是"未配置"，也不等于通过` +
          "（读失败不静默当 not_configured，DESIGN.md §2.10）。",
        source: { path: `${WORKBENCH}/work/sync-inbox/`, revision: null },
        fetch: `${WORKBENCH}/work/events.jsonl（sync.* 事件原文）`,
      }),
    );
  } else if (facts.syncBlock === null || !facts.syncBlock.configured) {
    items.push(
      item({
        id: "sync.gate",
        kind: "sync",
        status: "not_applicable",
        detail: "未配置同步证据契约（not_configured）：本项对老项目零影响。",
        source: { path: `${WORKBENCH}/work/sync-inbox/`, revision: null },
        fetch: null,
      }),
    );
  } else if (facts.syncBlock.blocked) {
    items.push(
      item({
        id: "sync.gate",
        kind: "sync",
        status: "missing",
        detail:
          `有 blocks_entry 的同步批次未当前通过（overall=${facts.syncBlock.overall}）：` +
          facts.syncBlock.batches.map((b) => `${b.batch_id}（${b.title}）verdict=${b.verdict}`).join("；"),
        source: { path: `${WORKBENCH}/work/sync-inbox/`, revision: null },
        fetch: `scan_sync_evidence / read_sync_status {project_id}`,
      }),
    );
  } else if (facts.syncBlock.overall !== "passed") {
    // 已配置、未阻断，但总体并非 passed（例如非阻断批次失败）——如实标 attention，不冒充「当前通过」。
    items.push(
      item({
        id: "sync.gate",
        kind: "sync",
        status: "attention",
        detail:
          `已配置同步证据契约，未构成 blocks_entry 阻断，但 overall=${facts.syncBlock.overall}（并非 passed）：` +
          "所登记范围**未全部当前通过**（非阻断批次失败也要如实说，不冒充通过，DESIGN.md §2.10）。",
        source: { path: `${WORKBENCH}/work/sync-inbox/`, revision: null },
        fetch: `read_sync_status {project_id}`,
      }),
    );
  } else {
    items.push(
      item({
        id: "sync.gate",
        kind: "sync",
        status: "satisfied",
        detail: `已配置同步证据契约，overall=${facts.syncBlock.overall}（所登记范围当前通过，不等于业务实现/用户验收）。`,
        source: { path: `${WORKBENCH}/work/sync-inbox/`, revision: null },
        fetch: null,
      }),
    );
  }

  // ⑥ 项目级阶段必读指针（只解释；缺失=老项目兼容，不新增门禁）
  if (facts.stageReads.status === "invalid") {
    items.push(
      item({
        id: "stage_reads.pointer",
        kind: "stage_reads",
        status: "attention",
        detail: `项目级阶段必读指针不可用：${facts.stageReads.reasons.join("；")}（来源漂移/不合法就不派活，见 next_action）`,
        source: { path: `${WORKBENCH}/work/stage-reads.json`, revision: null },
        fetch: `${WORKBENCH}/work/stage-reads.json`,
      }),
    );
  } else if (facts.stageReads.status === "ok") {
    items.push(
      item({
        id: "stage_reads.pointer",
        kind: "stage_reads",
        status: "satisfied",
        detail: `项目级阶段必读指针合法（${facts.stageReads.entries.length} 项；下一项优先卡 ${facts.stageReads.preferred_task_id ?? "未指定"}）。`,
        source: { path: `${WORKBENCH}/work/stage-reads.json`, revision: null },
        fetch: null,
      }),
    );
  }
  // absent：不列（老项目原样兼容，不新增任何说明噪声）。

  // ⑦ 责任角色 / 本角色
  {
    const def = chosenTaskId === null ? null : facts.definitions.find((d) => d.task_id === chosenTaskId) ?? null;
    const declared = def?.owner_role ?? null;
    items.push(
      item({
        id: "role.responsibility",
        kind: "role",
        status: "satisfied",
        detail:
          `本角色「${role}」（类别 ${roleClass}）` +
          (chosenTaskId === null
            ? "；本次动作没有指向具体卡。"
            : `；${chosenTaskId} 声明的责任角色是「${declared ?? "（未声明，任何执行角色可按职责接）"}」` +
              `——是否相符以本次 next_action 的 reasons 为准（本清单不重复判、不改门禁，§6.7）。`),
        source: chosenTaskId === null || def === null ? { path: null, revision: null } : { path: facts.plan?.source.rel_path ?? null, revision: facts.plan?.revision.definition_sha256 ?? null },
        fetch: null,
      }),
    );
  }

  // ⑧ 客户端能力档（只复述；动作已由 applyClientGate 计入能力，本清单不重复拦）
  {
    items.push(
      item({
        id: "capability.declared",
        kind: "capability",
        status: capability.effective === "read_only" ? "attention" : "satisfied",
        detail:
          `客户端能力档：${capability.effective}（${capability.basis}）。` +
          (capability.effective === "read_only"
            ? "只读档位不会被派发认领/恢复任务，只拿读取与接续指令（§6.2）——本次 next_action 已按此计。"
            : "档位足以承接本次动作；是否真调工具由客户端与项目规则决定（§6.2）。"),
        source: { path: null, revision: null },
        fetch: null,
      }),
    );
  }

  // ⑨ 运行现场（有未结束 run 时才列；只解释已算的 run_site，不重新读执行回执）
  if (runs.length > 0) {
    if (facts.executions_unreadable !== null) {
      items.push(
        item({
          id: "execution.site",
          kind: "execution_site",
          status: "unknown",
          detail: `执行回执读不出来（${facts.executions_unreadable}）：运行现场**未知**——读失败不等于没有回执，也不等于停机（§5.4）。`,
          source: { path: EVENTS_REL, revision: null },
          fetch: EVENTS_REL,
        }),
      );
    } else {
      const chosen = runs.find((r) => r.task_id === chosenTaskId) ?? runs[0];
      const state = chosen.run_site.state;
      const status: PreconditionStatus = state === "confirmed_stopped" ? "satisfied" : "attention";
      items.push(
        item({
          id: `execution.site.${chosen.task_id}`,
          kind: "execution_site",
          status,
          detail:
            `未结束 run：任务 ${chosen.task_id} 租约 ${chosen.lease}，运行现场 state=${state}` +
            `（${chosen.run_site.note}）。续接前先按 resume_preconditions 核实旧现场：${chosen.resume_preconditions.join("；")}`,
          source: { path: `${WORKBENCH}/work/events.jsonl（execution.*）`, revision: null },
          // V09-31 复审：`report_execution` **没有** op=read（它只写回执）——不给虚构的补取工具。
          // 运行现场的真实只读入口是 `project_entry` 的 `current_runs`，或直接读事件原文。
          fetch: "project_entry {project_id, role}（current_runs 运行现场）／ .工作台/work/events.jsonl（execution.* 原文）",
        }),
      );
    }
  }

  // ⑩ 合法下一步（复述已定 action，不参与判定）
  {
    items.push(
      item({
        id: "next_step.legal",
        kind: "next_step",
        status: "satisfied",
        detail: `合法下一步：${action}（这是本次已定的结论，本清单只复述；理由见 next_action.reasons）。`,
        source: { path: null, revision: null },
        fetch: null,
      }),
    );
  }

  return { for_action: action, items, advisory_only: true };
}
