// V09-62 交付总览的**纯展示文案层**（无 fs、无 fetch、无判据、无 React）。
//
// 只做两件事，且都只作用于**呈现**：
//
//   ① **精确原文 → 展示别名**：把卡片上的技术长标题换成审定过的短名与一句用途
//      （2026-10-09 Codex 界面复审逐条审定的 18 条，见 `.工作台/delivery-cards-20261009/ROOT-UI-REVIEW.md`）。
//      这是**呈现层精确文本匹配**：表里没有的原文一律**原样完整显示**，不改 ID、正式名称、计数、
//      分组事实、接口或通过状态；右栏详情始终保留**原名称与原场景**。别名不是新功能声明，也不得
//      反向当作设计或实现完成依据。
//
//   ② **同源读数 → 人话标签与色档**：把 `implementation` / `verification` / `agent_review` /
//      `user_acceptance` 四个**分开**的读数翻成人话。这里**不新判 overall**、不改任何判据：结论仍只取
//      服务端 `delivery.state`；绿色（`ok`）只标**单项技术验证**当前有效通过，其它维度一律不用绿。
//
// 分寸（DESIGN §4.2／附录 E.9，REQUEST「状态落字约束」）：
//   · `result_submitted` 单凭提交**不叫已实现**——只有「提交 + 技术验证当前有效通过」才读作「已实现」，
//     否则「已提交实现」；图上无运行投影的 `no_run_record` 是「暂无实现记录」，**不读成**「未开始」；
//   · 证据失效 / 有明确失败检查 ⇒ 显式「需要复验」/「有问题」，不留在难懂的枚举上；
//   · 刷新失败（stale）时一律注明「（上次）」并把绿档降为中性——旧读数不冒充当前通过。

import type { EvidenceState } from "../../shared/coverageTypes";

export type ChipTone = "ok" | "warn" | "info" | "neutral";

export interface ChipDisplay {
  label: string;
  tone: ChipTone;
}

/** 功能展示别名（精确匹配 `display_name` 原文） */
export interface DisplayCopy {
  /** 卡片短名 */
  short: string;
  /** 卡片一句用途 */
  purpose: string;
}

/**
 * 审定别名表：键是**正式功能原文**（精确匹配），值是卡片短名与一句用途。
 * 未知原文（未登记候选、需求待映射、将来新增的功能名）**不在表里** ⇒ 调用方原样显示原文。
 */
const FEATURE_COPY: Readonly<Record<string, DisplayCopy>> = {
  "设计书旁的人话功能清单与设计覆盖对照": { short: "功能清单与设计对照", purpose: "看清项目有哪些功能、设计有没有遗漏。" },
  "四维读数分开、绿色只按本范围验证": { short: "功能进度与验收状态", purpose: "分清设计、实现、验证和人的接受。" },
  "逐项交接包（check 级材料与下一动作）": { short: "逐项工作交接", purpose: "让接手的 Agent 找到材料和下一步。" },
  "提交→复验→下一动作的接续闭环": { short: "提交后继续推进", purpose: "成果提交后，接着复验和处理下一步。" },
  "源变复验（按界，恰一个动作）": { short: "改动后重新验证", purpose: "找出改动影响的功能，重新检查。" },
  "用户补充设计路径": { short: "补充需求与设计", purpose: "让新想法有记录、能追到处理结果。" },
  "人的验收结果可见": { short: "人工验收", purpose: "由你决定接受或退回，保留结果。" },
  "六图生成、按当前状况自动更新与人可读浏览": { short: "项目图与自动更新", purpose: "查看项目结构和关联，跟上当前变化。" },
  "Agent 直接读六图完整当前状态（MCP/HTTP 读口）": { short: "Agent 读取项目图", purpose: "让 Agent 读到完整图内容和当前状态。" },
  "业务数据流真实路径图（输入→处理→存储→输出/外部系统）": { short: "业务数据流向", purpose: "看数据从哪里来、怎样处理、流到哪里。" },
  "需求→设计→施工卡→实现/证据 可追溯": { short: "需求与实现追踪", purpose: "从需求一路查到设计、实现和证据。" },
  "五环审计、独立抽查与缺陷闭环": { short: "审查与问题修复", purpose: "查出问题、修复复测，并保留依据。" },
  "同步证据发现与完整性验收": { short: "同步结果核对", purpose: "核对该同步的内容是否真正到位。" },
  "桌面服务生命周期与安全默认配置": { short: "桌面服务与安全", purpose: "管好随桌面启动的服务和默认配置。" },
  "Agent 接续材料、入口与只读预检提效": { short: "Agent 接手续做", purpose: "换会话、换 Agent 后仍能接着工作。" },
  "人话主界面、日夜主题与图标一致": { short: "界面与外观", purpose: "看懂项目，用合适的深浅主题。" },
  "从已有代码补设计草稿": { short: "生成设计草稿", purpose: "从已有项目的代码和资料补出设计草稿。" },
  "交付总览与人工试用交接": { short: "交付总览", purpose: "核对功能和审查结果，判断能否试用。" },
};

/** 命中审定别名才返回；未知原文返回 `null`（调用方原样显示）。 */
export function displayCopyOf(displayName: string): DisplayCopy | null {
  return Object.prototype.hasOwnProperty.call(FEATURE_COPY, displayName) ? FEATURE_COPY[displayName] : null;
}

// ── 读数 → 人话（只做标签与色档，不改判据） ──

const IMPL_LABEL: Readonly<Record<string, string>> = {
  not_started: "未开始",
  in_progress: "实现中",
  blocked: "受阻",
  cancelled: "已取消",
  no_run_record: "暂无实现记录",
};

/**
 * 实现维度的人话。`result_submitted` 拆两读：
 *   · 技术验证**读数有效通过** ⇒ 「已实现」；
 *   · 只是提交过（未验证/失效/检查失败） ⇒ 「已提交实现」。
 * 其余取值沿用既有枚举语义（`no_run_record` **不**读成 `not_started`）；`stale` 时注明「（上次）」。
 */
export function implementationChip(state: string, readoutVerified: boolean, stale: boolean): ChipDisplay {
  if (state === "result_submitted") {
    return withStaleMark(readoutVerified ? { label: "已实现", tone: "info" } : { label: "已提交实现", tone: "info" }, stale);
  }
  return withStaleMark(
    { label: IMPL_LABEL[state] ?? "未知", tone: state === "in_progress" ? "info" : state === "blocked" ? "warn" : "neutral" },
    stale,
  );
}

/** 技术验证读数里是否存在明确失败 / 失效的检查（`evidence_entry.effective`） */
export function hasFailedEvidence(entries: ReadonlyArray<{ effective: string }>): boolean {
  return entries.some((e) => e.effective === "failed");
}
function hasStaleEvidence(entries: ReadonlyArray<{ effective: string }>): boolean {
  return entries.some((e) => e.effective === "stale");
}

/** 该功能的技术验证**当前**是否有效通过（`verified` + 证据有效 + 无失败/失效检查） */
export function verificationIsCurrent(r: {
  display_status: string;
  evidence_state: EvidenceState;
  evidence_entry: ReadonlyArray<{ effective: string }>;
}): boolean {
  return (
    r.display_status === "verified" &&
    r.evidence_state === "verified" &&
    !hasFailedEvidence(r.evidence_entry) &&
    !hasStaleEvidence(r.evidence_entry)
  );
}

/**
 * 技术验证维度的人话。优先级：明确失败「有问题」→ 证据失效/检查过期「需要复验」→
 * 验证通过「验证通过」→ 其余沿用枚举语义。刷新失败（`stale`）时注明「（上次）」并把绿档降中性。
 */
export function verificationChip(
  r: { display_status: string; evidence_state: EvidenceState; evidence_entry: ReadonlyArray<{ effective: string }> },
  stale: boolean,
): ChipDisplay {
  let chip: ChipDisplay;
  if (hasFailedEvidence(r.evidence_entry)) {
    chip = { label: "有问题", tone: "warn" };
  } else if (r.evidence_state === "invalidated" || hasStaleEvidence(r.evidence_entry)) {
    chip = { label: "需要复验", tone: "warn" };
  } else if (r.display_status === "verified" && r.evidence_state === "verified") {
    chip = { label: "验证通过", tone: "ok" };
  } else if (r.display_status === "verified") {
    chip = { label: "证据待核", tone: "warn" };
  } else if (r.display_status === "pending_verification") {
    chip = { label: "待验证", tone: "warn" };
  } else if (r.display_status === "blocked") {
    chip = { label: "受阻", tone: "warn" };
  } else if (r.display_status === "in_progress") {
    chip = { label: "验证中", tone: "info" };
  } else if (r.display_status === "planned") {
    chip = { label: "未开始", tone: "neutral" };
  } else {
    chip = { label: "未知", tone: "neutral" };
  }
  return withStaleMark(chip, stale);
}

/** Agent（非作者）审查维度的人话；`null` = 后端没给这个刻度（显式未知，不假绿） */
export function reviewChip(state: "passed" | "pending" | "unknown" | null, stale: boolean): ChipDisplay {
  const chip: ChipDisplay =
    state === "passed" ? { label: "已通过", tone: "ok" } : state === "pending" ? { label: "未完成", tone: "warn" } : { label: "未知", tone: "neutral" };
  return withStaleMark(chip, stale);
}

/** 人的接受（Agent 不代签；**不用绿档**——绿只留给本范围技术验证） */
export function acceptanceChip(state: string): ChipDisplay {
  if (state === "accepted") return { label: "你已接受", tone: "info" };
  if (state === "rejected") return { label: "你已退回", tone: "warn" };
  if (state === "accepted_known_limit") return { label: "你已接受（含限制）", tone: "info" };
  if (state === "pending") return { label: "待你决定", tone: "neutral" };
  return { label: "未知", tone: "neutral" };
}

/** 刷新失败（旧读数）：标签注明「（上次）」，绿档降中性——旧读数不冒充当前通过。 */
function withStaleMark(chip: ChipDisplay, stale: boolean): ChipDisplay {
  if (!stale) return chip;
  return { label: `${chip.label}（上次）`, tone: chip.tone === "ok" ? "neutral" : chip.tone };
}
