// 审计与修复链（PLAN.md V06-09，DESIGN.md §5.4 / §5.5 / §5.8）。
//
// **五件事分开记录**（§5.5：作者自报、验证通过、独立审计和用户接受分别记录；Agent 不代用户操作 Gate）：
//   ① `audit.submission_submitted`     结果提交（执行者交的交付包：基线/diff/命令/未测项/已知问题）
//   ② `audit.self_check_recorded`      自检（**作者自己**跑的检查，明确标 `author_self`）
//   ③ `audit.independent_audit_recorded` 独立审计（审计者 ≠ 作者；记独立性、覆盖矩阵、未报错范围）
//   ④ `audit.fix_recorded` / `audit.retest_recorded` 修复（待复测）与**复测**（复测者 ≠ 修复者，
//      修复自述不关闭缺陷，见 `evidence.ts`）
//   ⑤ `audit.human_acceptance_recorded` 人工接受（**只接受真实用户身份**；技术审定 ≠ 用户 Gate）
//
// 审计包（§5.5 必含项）在 `buildAuditPackage`：本批次目标与基线、实际 diff 与可取回原文、
// 风险清单与覆盖矩阵、验证命令及原始输出位置、已确认/未证实/误报/重复缺陷、修复及复测关系、
// 设计偏离与已知限制、用量耗时实测值或未知。**作者摘要只是导航**（`author_summary_is_navigation_only`）。
//
// 高能力抽查包（`buildSpotCheckPackage`）：给终审者**原文入口**（路径 + 哈希 + 怎么读），
// 由它自己选源码/用户路径/未报错区域抽查——抽查不是全量证明，结论只在所述范围与方法内成立。
//
// 复用既有审计工作链：本模块**不新建审计中心**，只把已有五环（找错→找丑→修复→终审→回写）
// 的事实按上述事件类型落进唯一写入者，供界面/审计脚本读回。
import { nowIso } from "../time";
import { SCHEMA_VERSION, WorkError, type WorkEvent, type WorkReceipt } from "./types";
import { loadEvents } from "./eventStore";
import type { WorkSubmitter } from "./tasks";
import {
  REVISION_KINDS,
  findingIsOpen,
  findingLedger,
  readEvidence,
  sha256Hex,
  type EvidenceBinding,
  type FindingLedger,
  type FindingState,
  type RevisionKind,
} from "./evidence";
import { parseRuntimeEntries, type RuntimeEntry } from "./runtimeEntries";

// ── 事件词表与实体约定 ──

export const AUDIT_EVENT_TYPES = [
  "audit.submission_submitted",
  "audit.self_check_recorded",
  "audit.independent_audit_recorded",
  "audit.fix_recorded",
  "audit.retest_recorded",
  "audit.human_acceptance_recorded",
] as const;
export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];

/** 实体 id 约定：五件事各有自己的实体前缀，互不覆盖（"分开记录"落到 id 上） */
export const AUDIT_ENTITY_PREFIXES = {
  "audit.submission_submitted": "submission:",
  "audit.self_check_recorded": "check:",
  "audit.independent_audit_recorded": "audit:",
  "audit.fix_recorded": "fix:",
  "audit.retest_recorded": "retest:",
  "audit.human_acceptance_recorded": "acceptance:",
} as const satisfies Record<AuditEventType, string>;

export const auditEntityId = (type: AuditEventType, recordId: string): string =>
  `${AUDIT_ENTITY_PREFIXES[type]}${recordId}`;

function entityKindOf(entityId: string): { prefix: string; record_id: string } | null {
  for (const prefix of Object.values(AUDIT_ENTITY_PREFIXES)) {
    if (entityId.startsWith(prefix)) {
      return { prefix, record_id: entityId.slice(prefix.length) };
    }
  }
  return null;
}

// ── 覆盖矩阵（§5.5 找错环的五个视角；已查/未查/不适用都要有依据） ──

export const COVERAGE_AREAS = [
  "behavior_boundaries",
  "data_concurrency",
  "interface_integration",
  "failure_recovery",
  "trust_permission",
] as const;
export type CoverageArea = (typeof COVERAGE_AREAS)[number];
export const COVERAGE_AREA_LABELS: Readonly<Record<CoverageArea, string>> = {
  behavior_boundaries: "行为/边界",
  data_concurrency: "数据/并发",
  interface_integration: "接口/集成",
  failure_recovery: "异常/恢复",
  trust_permission: "权限/信任",
};

export type CoverageStatus = "checked" | "unchecked" | "not_applicable";
export interface CoverageRow {
  area: CoverageArea;
  status: CoverageStatus;
  /** 依据：查了什么/为什么没查/为什么不适用（空 = 不合格，`assertCoverageComplete` 会拦） */
  basis: string;
}

export function assertCoverageComplete(rows: readonly CoverageRow[]): void {
  const missing = COVERAGE_AREAS.filter((a) => !rows.some((r) => r.area === a));
  if (missing.length > 0) {
    throw new WorkError(
      "INVALID_COMMAND",
      `未报错范围必须如实登记：覆盖矩阵缺 ${missing.join("、")}（五个视角都要给"已查/未查/不适用"及依据）`,
      { missing_areas: missing },
    );
  }
  const noBasis = rows.filter((r) => r.basis.trim() === "").map((r) => r.area);
  if (noBasis.length > 0) {
    throw new WorkError("INVALID_COMMAND", `覆盖矩阵缺依据：${noBasis.join("、")}`, { areas: noBasis });
  }
}

// ── 记录形态（由事件折叠；纯派生） ──

export interface SubmissionRecord {
  record_id: string;
  task_id: string | null;
  round: number;
  goal: string;
  baseline: { baseline_id: string | null; design_revision: string | null; plan_revision: string | null };
  /** 实际 diff 的内容哈希（原文由 diff_ref 指向的可取回位置） */
  diff_sha256: string | null;
  diff_recovery: string | null;
  changed_files: string[];
  affected_interfaces: string[];
  /** 验证命令 + 退出码 + 原始输出位置（未跑的命令不许写成通过） */
  commands: { command: string; exit_code: number; output_ref: string | null }[];
  untested: { item: string; reason: string }[];
  known_issues: string[];
  requirement_refs: string[];
  evidence_refs: string[];
  binding: EvidenceBinding | null;
  /**
   * 补修包 F：本次成果的**可体验运行入口**登记（场景 / 入口 / 验证时间 / 结果或不可用原因）。
   * 缺省 = 这次成果没声明入口（不是错误）；读取侧据此装配"尚不可体验 / 失效入口说明状态"。
   */
  runtime_entries: RuntimeEntry[];
  submitted_by: string;
  role: string;
  at: string;
  /**
   * 服务端提交序号（本项目内单调递增，事件信封给的）。
   * 用途：**同刻比较时的次级序**——`occurred_at` 只到秒，同一秒内多次提交会让"最近一次"失去确定性；
   * 按裁定 B ③（相同时间使用明确、稳定的次级顺序）用提交序号定序，比落回对象插入顺序可控。
   */
  seq: number;
}

export interface SelfCheckRecord {
  record_id: string;
  task_id: string | null;
  round: number;
  checked_by: string;
  role: string;
  /** 固定 `author_self`：自检不是独立审计（§5.5） */
  independence: "author_self";
  checks: {
    check_id: string;
    method: string;
    command: string | null;
    exit_code: number | null;
    output_ref: string | null;
    /** 证据哈希（没有证据的"通过"不算通过） */
    evidence_sha256: string | null;
    /** 该检查覆盖的范围（补修 C 可选字段；空 = 没声明范围，不猜） */
    scope: string[];
    /**
     * 被验对象的真实来源类别（V09-01／附录 E.3.3）：**新写入的通过检查必填**（写侧彩排闸拒收缺失，
     * EVENT_INVALID 零写入）；读侧只在显式声明时才判绑定是否相符——历史记录没有这个字段，
     * 一律不追溯失效、不整批转红。
     */
    verifies: VerificationSubject | null;
  }[];
  conclusion: "pass" | "fail";
  binding: EvidenceBinding | null;
  /**
   * 记录层方法/覆盖说明（V09-01：`payload.coverage`/`payload.method_limits` 拼出；
   * 缺省 null = 记录层没有方法信息）。与独立审计同一档口径，供读侧与 `method` 二选一采信。
   */
  record_method: string | null;
  at: string;
}

export interface AuditCoverageOfCheck {
  check_id: string;
  result: "passed" | "failed";
  evidence_sha256: string | null;
  /** 该检查覆盖的范围（补修 C 可选字段；空 = 没声明范围） */
  scope: string[];
}

export interface IndependentAuditRecord {
  record_id: string;
  task_id: string | null;
  round: number;
  auditor: string;
  auditor_role: string;
  /** 独立性声明：谁审的、是否同一会话、**先不看作者结论** */
  independence: {
    different_actor: boolean;
    same_session_as_author: boolean;
    read_author_summary_first: boolean;
    model_note: string | null;
  };
  /** 它独立复核了哪些必需检查项（与自检同 check_id 时，投影优先取独立审计那条） */
  checks: AuditCoverageOfCheck[];
  coverage: CoverageRow[];
  findings: string[];
  conclusion: "pass" | "fail";
  /** 未报错范围（如实列出：没查的地方不是"没问题"） */
  not_reported_scope: string[];
  method_limits: string[];
  binding: EvidenceBinding | null;
  at: string;
}

export interface FixRecord {
  record_id: string;
  finding_id: string;
  fix_revision: string;
  fixed_by: string;
  role: string;
  evidence_ref: string | null;
  regression: { command: string; exit_code: number; output_ref: string | null }[];
  at: string;
}

export interface RetestRecord {
  record_id: string;
  finding_id: string;
  fix_revision: string | null;
  retested_by: string;
  role: string;
  retest_evidence: string;
  result: "pass" | "fail";
  rerepro_gone: boolean;
  regression_scope: string[];
  at: string;
}

export interface AcceptanceRecord {
  record_id: string;
  task_id: string | null;
  batch_id: string | null;
  decision: "accept" | "reject" | "accept_known_limit";
  scenario_refs: string[];
  baseline: { baseline_id: string | null; design_revision: string | null; plan_revision: string | null };
  evidence_refs: string[];
  accepted_by: string;
  /** 只可能是 user（Agent 代签在写入与折叠两处都被拒） */
  role: "user";
  note: string | null;
  at: string;
}

export interface AuditRecords {
  submissions: Record<string, SubmissionRecord>;
  self_checks: Record<string, SelfCheckRecord>;
  independent_audits: Record<string, IndependentAuditRecord>;
  fixes: Record<string, FixRecord>;
  retests: Record<string, RetestRecord>;
  acceptances: Record<string, AcceptanceRecord>;
  ignored_entities: string[];
}

const emptyRecords = (): AuditRecords => ({
  submissions: {},
  self_checks: {},
  independent_audits: {},
  fixes: {},
  retests: {},
  acceptances: {},
  ignored_entities: [],
});

function auditBad(message: string, detail: Record<string, unknown> = {}): never {
  throw new WorkError("EVENT_INVALID", `审计事件不合法：${message}`, detail);
}

const strOrNull = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const strArr = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
const reqStr = (v: unknown, field: string, eventId: string): string => {
  const s = strOrNull(v);
  if (s === null) auditBad(`payload.${field} 必须是非空字符串（事件 ${eventId}）`, { field, event_id: eventId });
  return s;
};
const bindingOf = (v: unknown): EvidenceBinding | null => {
  if (typeof v !== "object" || v === null) return null;
  const b = v as Record<string, unknown>;
  const kind = b.revision_kind;
  const rev = b.revision;
  if (typeof kind !== "string" || typeof rev !== "string" || rev === "") return null;
  // 修订种类必须是**合法四值之一**（G-02 根因①：旧实现把任意字符串直接当 `RevisionKind` 用）。
  // 读侧遇到非法种类按「没绑定」处理（历史事件不追溯惩罚、不毒化投影）；写侧另有彩排闸点名拒收。
  if (!REVISION_KINDS.includes(kind as RevisionKind)) return null;
  return { revision_kind: kind as RevisionKind, revision: rev };
};
const commandsOf = (v: unknown): { command: string; exit_code: number; output_ref: string | null }[] =>
  Array.isArray(v)
    ? v.flatMap((c) => {
        if (typeof c !== "object" || c === null) return [];
        const o = c as Record<string, unknown>;
        if (typeof o.command !== "string" || typeof o.exit_code !== "number") return [];
        return [{ command: o.command, exit_code: o.exit_code, output_ref: strOrNull(o.output_ref) }];
      })
    : [];

// ── 判绿采信：按「这条检查是怎么做的」分档（DESIGN.md 附录 E.3.2 / E.3.3） ──
//
// 写侧（`service.ts` 在追加前的彩排闸）与读侧（`statusProjection.ts#checkEffectiveness`）共用
// **同一份**判据：两处各写一套就会出现「写侧放行、读侧不采信」（或反过来）的分叉——与
// §2.5 一致校验面同一哲学（判据只此一处，调用方自查不替代服务侧校验）。
//
// 分档（E.3.2 分档表）：
//   · 声明了 `command` 的机械检查 —— 通过必须 `exit_code === 0`；缺失/非零一律不采信；
//   · 不带 `command` 的检查（独立审计、人工审阅）—— 凭 per-check 证据哈希 ＋ 方法说明
//     （per-check `method` **或**记录层 `coverage`/`method_limits`，二选一）采信；
//     **不要求** `exit_code`、**也不要求** per-check `method`（既有 227 条独立审计没有这个字段，
//     方法在记录层）——只有「证据与方法两缺」的通过才不采信；
//   · 绑定种类必须跟随被验对象的真实来源（E.3.3）——读侧**只在记录显式声明 `verifies` 时才判**：
//     历史 85 条自检 / 227 条独立审计一条都不追溯失效、不整批转红；写侧相反——新写入的
//     「通过」检查**必须声明** `verifies`（service.ts 彩排闸），不声明就核对不了绑定是否跟随被验对象。

/** 被验对象的真实来源类别（E.3.3） */
export const VERIFICATION_SUBJECTS = ["document", "code", "artifact"] as const;
export type VerificationSubject = (typeof VERIFICATION_SUBJECTS)[number];

export const isVerificationSubject = (v: unknown): v is VerificationSubject =>
  typeof v === "string" && (VERIFICATION_SUBJECTS as readonly string[]).includes(v);

/** 该类别允许的绑定：文档契约 → 该文档的修订；代码行为/产物 → 源码内容指纹（E.3.3-1） */
export const SUBJECT_BINDING_KINDS: Readonly<Record<VerificationSubject, readonly RevisionKind[]>> = {
  document: ["design", "plan", "interface"],
  code: ["code"],
  artifact: ["code"],
};

/** 被验对象类别的中文说明（进人话理由，不另造术语） */
const SUBJECT_LABEL: Readonly<Record<VerificationSubject, string>> = {
  document: "文档契约（设计/施工图条款、任务定义、接口约定）",
  code: "代码行为",
  artifact: "产物（安装包/构建输出）",
};

export type PassGateCode =
  | "ok"
  | "command_exit_code_missing"
  | "command_exit_code_nonzero"
  | "no_evidence_no_method"
  | "binding_subject_mismatch";

/** 一条「声称通过」的检查能不能采信（写侧拒收与读侧不采信共用这个结论） */
export interface PassGateVerdict {
  pass: boolean;
  code: PassGateCode;
  /** 人话：写侧进 `WorkError.message`，读侧进 `missing[].why` / `reasons[].text` */
  why: string;
}

export interface PassGateInput {
  check_id: string;
  /** 声明的机械检查命令（null/空 = 不带 `command`，走第二档） */
  command: string | null;
  exit_code: number | null;
  evidence_sha256: string | null;
  /** per-check 方法说明 */
  method: string | null;
  /** 记录层方法说明（独立审计的 `coverage`/`method_limits`；自检没有这一层） */
  record_method: string | null;
  /** 被验对象类别声明；null = 未声明（不判绑定是否相符） */
  verifies: VerificationSubject | null;
  /** 记录绑定的修订；null = 没有绑定任何修订 */
  binding: { revision_kind: string; revision: string } | null;
}

const strOrNullOf = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? v : null;

/**
 * 一条声称「通过」的检查的采信判据（E.3.2 第一/二档 ＋ E.3.3 绑定相符）。
 * `conclusion="fail"` 的记录**不走这里**（失败如实记录，与非零退出码并不矛盾）。
 */
export function gateClaimedPass(input: PassGateInput): PassGateVerdict {
  const id = input.check_id;
  if (strOrNullOf(input.command) !== null) {
    if (input.exit_code === null) {
      return {
        pass: false,
        code: "command_exit_code_missing",
        why:
          `检查「${id}」声明了命令却没给退出码：没有退出码的通过不算通过，也不静默当 0` +
          "（附录 E.3.2 第一档：带 `command` 的机械检查必须 `exit_code === 0`）",
      };
    }
    if (input.exit_code !== 0) {
      return {
        pass: false,
        code: "command_exit_code_nonzero",
        why:
          `检查「${id}」声明的命令退出码是 ${input.exit_code}（≠ 0）：退出码非零的通过不采信，按 §4.2 降级为「结果待验证」` +
          "（附录 E.3.2 第一档；历史矛盾记录原样保留、不重算）",
      };
    }
  }
  if (input.verifies !== null) {
    const bound =
      input.binding !== null &&
      REVISION_KINDS.includes(input.binding.revision_kind as RevisionKind) &&
      input.binding.revision !== ""
        ? (input.binding.revision_kind as RevisionKind)
        : null;
    const allowed = SUBJECT_BINDING_KINDS[input.verifies];
    if (bound === null || !allowed.includes(bound)) {
      const kindTxt = bound === null ? "没有绑定任何修订（或绑的修订为空/种类不合法）" : `${bound} 修订`;
      return {
        pass: false,
        code: "binding_subject_mismatch",
        why:
          `检查「${id}」声明验的是${SUBJECT_LABEL[input.verifies]}，却只给了 ${kindTxt}：` +
          `绑定必须跟随被验对象的真实来源（附录 E.3.3）——该档要求 ` +
          `${
            input.verifies === "document"
              ? "绑该文档的修订（design/plan/interface）"
              : "源码内容指纹（revision_kind=code；产物另需产物内容哈希＋同源构建证据）"
          }，拿「文档没变」冒充「代码/产物没变」不采信`,
      };
    }
  }
  if (input.evidence_sha256 === null && input.method === null && input.record_method === null) {
    return {
      pass: false,
      code: "no_evidence_no_method",
      why:
        `检查「${id}」说通过但既没给证据哈希、也没有方法说明：没证据的通过不算通过（结果已提交 ≠ 验证通过）` +
        "（附录 E.3.2 第二档：证据与方法两缺的通过不采信）",
    };
  }
  return { pass: true, code: "ok", why: "" };
}

/**
 * 记录层的方法/覆盖说明（E.3.2 第二档：per-check 没有 `method` 时，方法信息在记录层）。
 * 独立审计的 227 条旧记录只有 `coverage`/`method_limits` 这一层——**不因缺 per-check `method` 失效**。
 */
export function recordMethodOf(source: {
  coverage?: readonly { area?: unknown; status?: unknown; basis?: unknown }[];
  method_limits?: readonly unknown[];
}): string | null {
  const basis = (source.coverage ?? [])
    .filter((c) => typeof c.basis === "string" && c.basis.trim() !== "")
    .map((c) => `${typeof c.area === "string" ? c.area : "?"}(${typeof c.status === "string" ? c.status : "checked"})：${String(c.basis)}`);
  const limits = (source.method_limits ?? []).filter(
    (m): m is string => typeof m === "string" && m.trim() !== "",
  );
  const parts: string[] = [];
  if (basis.length > 0) parts.push(`覆盖：${basis.join("；")}`);
  if (limits.length > 0) parts.push(`方法限制：${limits.join("；")}`);
  return parts.length === 0 ? null : parts.join(" ｜ ");
}

/** 从 audit `checks[]` 原始对象读一条判据输入（写侧彩排闸与读侧共用同一份字段口径） */
export function passGateInputOf(
  check: Record<string, unknown>,
  opts: { record_method?: string | null; binding?: { revision_kind: string; revision: string } | null } = {},
): PassGateInput {
  const kind = check.verifies;
  return {
    check_id: typeof check.check_id === "string" ? check.check_id : "",
    command: strOrNullOf(check.command),
    exit_code: typeof check.exit_code === "number" ? check.exit_code : null,
    evidence_sha256: strOrNullOf(check.evidence_sha256),
    method: strOrNullOf(check.method),
    record_method: strOrNullOf(opts.record_method),
    verifies: isVerificationSubject(kind) ? kind : null,
    binding: opts.binding ?? null,
  };
}

/** 从事件折叠审计记录（纯函数）。未知类型、缺必填、伪造用户身份都在这里炸。 */
export function foldAuditRecords(events: WorkEvent[]): AuditRecords {
  const records = emptyRecords();
  const ignored = new Set<string>();
  for (const e of events) {
    const kind = entityKindOf(e.entity_id);
    if (kind === null) {
      ignored.add(e.entity_id);
      continue;
    }
    if (!(AUDIT_EVENT_TYPES as readonly string[]).includes(e.type)) {
      auditBad(`未知审计事件类型 ${JSON.stringify(e.type)}（事件 ${e.event_id}）`, {
        event_id: e.event_id,
        type: e.type,
      });
    }
    const type = e.type as AuditEventType;
    if (auditEntityId(type, kind.record_id) !== e.entity_id) {
      auditBad(
        `事件类型与实体前缀不匹配：${e.type} 用了 ${e.entity_id}（应为 ${AUDIT_ENTITY_PREFIXES[type]}<id>）。` +
          "五件事各占一个实体前缀，混用就等于把两份记录写成一份",
        { event_id: e.event_id, entity_id: e.entity_id, type: e.type },
      );
    }
    const p = e.payload;
    const id = kind.record_id;
    switch (type) {
      case "audit.submission_submitted": {
        records.submissions[id] = {
          record_id: id,
          task_id: strOrNull(p.task_id),
          round: typeof p.round === "number" ? p.round : 1,
          goal: reqStr(p.goal, "goal", e.event_id),
          baseline: {
            baseline_id: strOrNull((p.baseline as Record<string, unknown>)?.baseline_id),
            design_revision: strOrNull((p.baseline as Record<string, unknown>)?.design_revision),
            plan_revision: strOrNull((p.baseline as Record<string, unknown>)?.plan_revision),
          },
          diff_sha256: strOrNull(p.diff_sha256),
          diff_recovery: strOrNull(p.diff_recovery),
          changed_files: strArr(p.changed_files),
          affected_interfaces: strArr(p.affected_interfaces),
          commands: commandsOf(p.commands),
          untested: Array.isArray(p.untested)
            ? (p.untested as Record<string, unknown>[]).flatMap((u) =>
                typeof u?.item === "string"
                  ? [{ item: u.item, reason: typeof u.reason === "string" ? u.reason : "" }]
                  : [],
              )
            : [],
          known_issues: strArr(p.known_issues),
          requirement_refs: strArr(p.requirement_refs),
          evidence_refs: strArr(p.evidence_refs),
          binding: bindingOf(p.binding),
          // 补修包 F：入口登记在读侧**严格校验**（缺字段/非 http(s)/时间不可解析一律 EVENT_INVALID）
          runtime_entries: parseRuntimeEntries(p.runtime_entries, { event_id: e.event_id, record_id: id }),
          submitted_by: reqStr(p.submitted_by, "submitted_by", e.event_id),
          role: e.role,
          at: e.occurred_at,
          seq: e.seq,
        };
        break;
      }
      case "audit.self_check_recorded": {
        records.self_checks[id] = {
          record_id: id,
          task_id: strOrNull(p.task_id),
          round: typeof p.round === "number" ? p.round : 1,
          checked_by: reqStr(p.checked_by, "checked_by", e.event_id),
          role: e.role,
          independence: "author_self",
          checks: Array.isArray(p.checks)
            ? (p.checks as Record<string, unknown>[]).flatMap((c) =>
                typeof c?.check_id === "string"
                  ? [
                      {
                        check_id: c.check_id,
                        method: typeof c.method === "string" ? c.method : "",
                        command: strOrNull(c.command),
                        exit_code: typeof c.exit_code === "number" ? c.exit_code : null,
                        output_ref: strOrNull(c.output_ref),
                        evidence_sha256: strOrNull(c.evidence_sha256),
                        // 补修 C：可选范围字段；缺省是空数组（不猜"范围就是全部"）
                        scope: strArr(c.scope),
                        // V09-01：可选被验对象类别（E.3.3）；不合法/缺省一律当"未声明"
                        verifies: isVerificationSubject(c.verifies) ? c.verifies : null,
                      },
                    ]
                  : [],
              )
            : [],
          conclusion: p.conclusion === "fail" ? "fail" : "pass",
          binding: bindingOf(p.binding),
          record_method: recordMethodOf({
            coverage: Array.isArray(p.coverage) ? (p.coverage as Record<string, unknown>[]) : [],
            method_limits: Array.isArray(p.method_limits) ? p.method_limits : [],
          }),
          at: e.occurred_at,
        };
        break;
      }
      case "audit.independent_audit_recorded": {
        const ind = (p.independence ?? {}) as Record<string, unknown>;
        records.independent_audits[id] = {
          record_id: id,
          task_id: strOrNull(p.task_id),
          round: typeof p.round === "number" ? p.round : 1,
          auditor: reqStr(p.auditor, "auditor", e.event_id),
          auditor_role: e.role,
          independence: {
            different_actor: ind.different_actor === true,
            same_session_as_author: ind.same_session_as_author === true,
            read_author_summary_first: ind.read_author_summary_first === true,
            model_note: strOrNull(ind.model_note),
          },
          checks: Array.isArray(p.checks)
            ? (p.checks as Record<string, unknown>[])
                .filter((c) => typeof c?.check_id === "string")
                .map((c) => ({
                  check_id: String(c.check_id),
                  result: (c.result === "failed" ? "failed" : "passed") as "passed" | "failed",
                  evidence_sha256: strOrNull(c.evidence_sha256),
                  // 补修 C：可选范围字段；缺省是空数组
                  scope: strArr(c.scope),
                }))
            : [],
          coverage: Array.isArray(p.coverage)
            ? (p.coverage as Record<string, unknown>[])
                .filter((c) => typeof c?.area === "string" && typeof c?.basis === "string")
                .map((c) => ({
                  area: c.area as CoverageArea,
                  status: (c.status === "unchecked" || c.status === "not_applicable"
                    ? c.status
                    : "checked") as CoverageStatus,
                  basis: String(c.basis),
                }))
            : [],
          findings: strArr(p.findings),
          conclusion: p.conclusion === "fail" ? "fail" : "pass",
          not_reported_scope: strArr(p.not_reported_scope),
          method_limits: strArr(p.method_limits),
          binding: bindingOf(p.binding),
          at: e.occurred_at,
        };
        break;
      }
      case "audit.fix_recorded": {
        records.fixes[id] = {
          record_id: id,
          finding_id: reqStr(p.finding_id, "finding_id", e.event_id),
          fix_revision: reqStr(p.fix_revision, "fix_revision", e.event_id),
          fixed_by: reqStr(p.fixed_by, "fixed_by", e.event_id),
          role: e.role,
          evidence_ref: strOrNull(p.evidence_ref),
          regression: commandsOf(p.regression),
          at: e.occurred_at,
        };
        break;
      }
      case "audit.retest_recorded": {
        const result = p.result;
        if (result !== "pass" && result !== "fail") {
          auditBad(`payload.result 只接受 pass/fail（事件 ${e.event_id}）`, { event_id: e.event_id });
        }
        records.retests[id] = {
          record_id: id,
          finding_id: reqStr(p.finding_id, "finding_id", e.event_id),
          fix_revision: strOrNull(p.fix_revision),
          retested_by: reqStr(p.retested_by, "retested_by", e.event_id),
          role: e.role,
          retest_evidence: reqStr(p.retest_evidence, "retest_evidence", e.event_id),
          result,
          rerepro_gone: p.rerepro_gone === true,
          regression_scope: strArr(p.regression_scope),
          at: e.occurred_at,
        };
        break;
      }
      case "audit.human_acceptance_recorded": {
        const decision = p.decision;
        if (decision !== "accept" && decision !== "reject" && decision !== "accept_known_limit") {
          auditBad(`payload.decision 只接受 accept/reject/accept_known_limit（事件 ${e.event_id}）`, {
            event_id: e.event_id,
          });
        }
        if (e.role !== "user") {
          auditBad(
            `人工验收只能是用户（本条 role=${e.role}，actor=${e.actor_id}）：` +
              "Agent 与技术审定不得代签，委派审定以审定记录进入基线而不是伪造 by=user（DESIGN.md §5.8）",
            { event_id: e.event_id, role: e.role },
          );
        }
        records.acceptances[id] = {
          record_id: id,
          task_id: strOrNull(p.task_id),
          batch_id: strOrNull(p.batch_id),
          decision,
          scenario_refs: strArr(p.scenario_refs),
          baseline: {
            baseline_id: strOrNull((p.baseline as Record<string, unknown>)?.baseline_id),
            design_revision: strOrNull((p.baseline as Record<string, unknown>)?.design_revision),
            plan_revision: strOrNull((p.baseline as Record<string, unknown>)?.plan_revision),
          },
          evidence_refs: strArr(p.evidence_refs),
          accepted_by: reqStr(p.accepted_by, "accepted_by", e.event_id),
          role: "user",
          note: strOrNull(p.note),
          at: e.occurred_at,
        };
        break;
      }
      default:
        break;
    }
  }
  records.ignored_entities = [...ignored].sort();
  return records;
}

export function readAuditRecords(workDir: string): AuditRecords {
  const { events } = loadEvents(workDir);
  return foldAuditRecords(events);
}

// ── 写入（唯一写入者：提交事件，不绕开） ──

export interface AuditWriteContext {
  project_id: string;
  change_id: string;
  actor_id: string;
  role: string;
  occurred_at?: string;
}

function submitAuditEvent(
  submitter: WorkSubmitter,
  type: AuditEventType,
  recordId: string,
  ctx: AuditWriteContext,
  payload: Record<string, unknown>,
): WorkReceipt {
  if (recordId.trim() === "") {
    throw new WorkError("INVALID_COMMAND", `${type} 的 record_id 不能为空`, { type });
  }
  return submitter.submit({
    schema_version: SCHEMA_VERSION,
    project_id: ctx.project_id,
    change_id: ctx.change_id,
    entity_id: auditEntityId(type, recordId),
    expected_revision: null,
    type,
    actor_id: ctx.actor_id,
    role: ctx.role,
    idempotency_key: `${type}:${recordId}:${ctx.change_id}`,
    ...(ctx.occurred_at === undefined ? {} : { occurred_at: ctx.occurred_at }),
    payload,
  });
}

export interface SubmissionInput extends AuditWriteContext {
  record_id: string;
  goal: string;
  baseline?: { baseline_id?: string | null; design_revision?: string | null; plan_revision?: string | null };
  task_id?: string | null;
  round?: number;
  diff_sha256?: string | null;
  diff_recovery?: string | null;
  changed_files?: string[];
  affected_interfaces?: string[];
  commands?: { command: string; exit_code: number; output_ref?: string | null }[];
  untested?: { item: string; reason: string }[];
  known_issues?: string[];
  requirement_refs?: string[];
  evidence_refs?: string[];
  binding?: EvidenceBinding | null;
  /** 补修包 F：可体验运行入口登记（只接受 http(s) 入口，校验在 `runtimeEntries.ts`） */
  runtime_entries?: RuntimeEntry[];
  submitted_by: string;
}

/** ① 结果提交（执行者交结果；**不等于审计通过，也不等于验收接受**） */
export function submitSubmission(submitter: WorkSubmitter, input: SubmissionInput): WorkReceipt {
  return submitAuditEvent(submitter, "audit.submission_submitted", input.record_id, input, {
    goal: input.goal,
    task_id: input.task_id ?? null,
    round: input.round ?? 1,
    baseline: input.baseline ?? {},
    diff_sha256: input.diff_sha256 ?? null,
    diff_recovery: input.diff_recovery ?? null,
    changed_files: input.changed_files ?? [],
    affected_interfaces: input.affected_interfaces ?? [],
    commands: input.commands ?? [],
    untested: input.untested ?? [],
    known_issues: input.known_issues ?? [],
    requirement_refs: input.requirement_refs ?? [],
    evidence_refs: input.evidence_refs ?? [],
    binding: input.binding ?? null,
    runtime_entries: input.runtime_entries ?? [],
    submitted_by: input.submitted_by,
  });
}

export interface SelfCheckInput extends AuditWriteContext {
  record_id: string;
  task_id?: string | null;
  round?: number;
  checked_by: string;
  checks: {
    check_id: string;
    method?: string;
    command?: string | null;
    exit_code?: number | null;
    output_ref?: string | null;
    evidence_sha256?: string | null;
    /** 该检查覆盖的范围（补修 C；可选，缺省 = 没声明范围） */
    scope?: string[];
    /**
     * 被验对象的真实来源类别（V09-01／附录 E.3.3）：**新写入的通过检查必填**。
     * 声明了 `code`/`artifact` 却只绑 `plan`/`design`/`interface` ⇒ 写入被拒（EVENT_INVALID，零写入）；
     * 不声明 ⇒ 写入同样被拒（不声明就核对不了绑定是否跟随被验对象）；历史记录与读侧不追溯。
     */
    verifies?: VerificationSubject;
  }[];
  conclusion: "pass" | "fail";
  binding?: EvidenceBinding | null;
  /**
   * 记录层方法说明（V09-01／附录 E.3.2 第二档可选）：不带 `command` 的检查可在
   * per-check `method` 与这里的 `coverage`/`method_limits` **二选一**地给方法说明；
   * 两处都没有、又没有证据哈希的「通过」写入会被拒（EVENT_INVALID、零写入）。
   */
  coverage?: { area: string; status?: string; basis: string }[];
  method_limits?: string[];
}

/** ② 自检（作者自己跑；独立性固定 `author_self`，**不得**被读成独立审计） */
export function submitSelfCheck(submitter: WorkSubmitter, input: SelfCheckInput): WorkReceipt {
  return submitAuditEvent(submitter, "audit.self_check_recorded", input.record_id, input, {
    task_id: input.task_id ?? null,
    round: input.round ?? 1,
    checked_by: input.checked_by,
    checks: input.checks,
    conclusion: input.conclusion,
    binding: input.binding ?? null,
    // 记录层方法/覆盖（可选）：不带 command 的检查可与 per-check `method` 二选一（E.3.2 第二档）
    coverage: input.coverage ?? [],
    method_limits: input.method_limits ?? [],
    independence: "author_self",
  });
}

export interface IndependentAuditInput extends AuditWriteContext {
  record_id: string;
  task_id?: string | null;
  round?: number;
  auditor: string;
  auditor_role?: string;
  /** 被审对象的作者（执行者）。auditor === author → 拒绝：自审不是独立审计 */
  author_id: string;
  same_session_as_author?: boolean;
  read_author_summary_first?: boolean;
  model_note?: string | null;
  /** 它独立复核了哪些必需检查项（同 check_id 时投影优先取这一条） */
  checks?: { check_id: string; result?: "passed" | "failed"; evidence_sha256?: string | null; scope?: string[] }[];
  coverage: CoverageRow[];
  findings?: string[];
  conclusion: "pass" | "fail";
  not_reported_scope?: string[];
  method_limits?: string[];
  binding?: EvidenceBinding | null;
}

/** ③ 独立审计（审计者 ≠ 作者；覆盖矩阵必须五个视角都交代） */
export function submitIndependentAudit(submitter: WorkSubmitter, input: IndependentAuditInput): WorkReceipt {
  if (input.auditor === input.author_id) {
    throw new WorkError(
      "INVALID_COMMAND",
      `独立审计的审计者不能是被审作者本人（${input.auditor}）：作者自报/自检不是独立审计（DESIGN.md §5.5）`,
      { auditor: input.auditor, author_id: input.author_id },
    );
  }
  assertCoverageComplete(input.coverage);
  return submitAuditEvent(submitter, "audit.independent_audit_recorded", input.record_id, input, {
    task_id: input.task_id ?? null,
    round: input.round ?? 1,
    auditor: input.auditor,
    author_id: input.author_id,
    independence: {
      different_actor: true,
      same_session_as_author: input.same_session_as_author === true,
      read_author_summary_first: input.read_author_summary_first === true,
      model_note: input.model_note ?? null,
    },
    checks: input.checks ?? [],
    coverage: input.coverage,
    findings: input.findings ?? [],
    conclusion: input.conclusion,
    not_reported_scope: input.not_reported_scope ?? [],
    method_limits: input.method_limits ?? [],
    binding: input.binding ?? null,
  });
}

export interface FixInput extends AuditWriteContext {
  record_id: string;
  finding_id: string;
  fix_revision: string;
  fixed_by: string;
  evidence_ref?: string | null;
  regression?: { command: string; exit_code: number; output_ref?: string | null }[];
}

/** ④-a 修复（待复测）：**修复自述不关闭缺陷**，要等复测记录 */
export function submitFix(submitter: WorkSubmitter, input: FixInput): WorkReceipt {
  return submitAuditEvent(submitter, "audit.fix_recorded", input.record_id, input, {
    finding_id: input.finding_id,
    fix_revision: input.fix_revision,
    fixed_by: input.fixed_by,
    evidence_ref: input.evidence_ref ?? null,
    regression: input.regression ?? [],
  });
}

export interface RetestInput extends AuditWriteContext {
  record_id: string;
  finding_id: string;
  fix_revision?: string | null;
  retested_by: string;
  retest_evidence: string;
  result: "pass" | "fail";
  rerepro_gone?: boolean;
  regression_scope?: string[];
}

/** ④-b 复测（复测者 ≠ 修复者：修复自述不直接关闭缺陷） */
export function submitRetest(submitter: WorkSubmitter, input: RetestInput): WorkReceipt {
  return submitAuditEvent(submitter, "audit.retest_recorded", input.record_id, input, {
    finding_id: input.finding_id,
    fix_revision: input.fix_revision ?? null,
    retested_by: input.retested_by,
    retest_evidence: input.retest_evidence,
    result: input.result,
    rerepro_gone: input.rerepro_gone ?? input.result === "pass",
    regression_scope: input.regression_scope ?? [],
  });
}

export interface AcceptanceInput extends AuditWriteContext {
  record_id: string;
  decision: "accept" | "reject" | "accept_known_limit";
  task_id?: string | null;
  batch_id?: string | null;
  scenario_refs?: string[];
  baseline?: { baseline_id?: string | null; design_revision?: string | null; plan_revision?: string | null };
  evidence_refs?: string[];
  accepted_by: string;
  note?: string | null;
}

/** ⑤ 人工验收（**只接受真实用户身份**；role 必须是 user，否则整条命令被拒） */
export function submitHumanAcceptance(submitter: WorkSubmitter, input: AcceptanceInput): WorkReceipt {
  if (input.role !== "user") {
    throw new WorkError(
      "INVALID_COMMAND",
      `人工验收只能由用户提交（本条 role=${input.role}，actor=${input.actor_id}）：` +
        "Agent、协调器与技术审定都不得代签用户 Gate（DESIGN.md §5.8）；" +
        "委派的技术审定请走基线审定记录，不要伪造 by=user",
      { role: input.role, actor_id: input.actor_id, decision: input.decision },
    );
  }
  return submitAuditEvent(submitter, "audit.human_acceptance_recorded", input.record_id, input, {
    decision: input.decision,
    task_id: input.task_id ?? null,
    batch_id: input.batch_id ?? null,
    scenario_refs: input.scenario_refs ?? [],
    baseline: input.baseline ?? {},
    evidence_refs: input.evidence_refs ?? [],
    accepted_by: input.accepted_by,
    note: input.note ?? null,
  });
}

// ── 审计包（§5.5 必含项） ──

export const AUDIT_PACKAGE_REQUIRED_ITEMS = [
  "goal_and_baseline",
  "diff_and_raw",
  "risks",
  "coverage_matrix",
  "verification",
  "findings",
  "fix_retest",
  "design_deviations_and_limits",
  "usage",
] as const;
export type AuditPackageItem = (typeof AUDIT_PACKAGE_REQUIRED_ITEMS)[number];

export interface RawEntryPoint {
  /** 原文在哪（项目内相对路径 / 章节定位 / 事件实体） */
  locator: string;
  /** 怎么取回（给终审者的操作，不是"信任作者"） */
  how_to_read: string;
  sha256: string | null;
}

export interface AuditPackage {
  package_id: string;
  batch_id: string;
  generated_at: string;
  /** ① 本批次目标与基线 */
  goal_and_baseline: { goal: string; baseline: SubmissionRecord["baseline"]; change_id: string | null };
  /** ② 实际 diff 与可取回原文（作者摘要不代替证据） */
  diff_and_raw: {
    changed_files: string[];
    diff_sha256: string | null;
    diff_recovery: string | null;
    raw_entries: RawEntryPoint[];
  };
  /** ③ 风险清单 + 覆盖矩阵 */
  risks: { items: { code: string; text: string; severity_hint: string | null }[] };
  coverage_matrix: { area: CoverageArea; status: CoverageStatus; basis: string; source: string }[];
  /** ④ 验证命令及原始输出位置 */
  verification: { commands: SubmissionRecord["commands"]; outputs: RawEntryPoint[] };
  /** ⑤ 已确认/未证实/误报/重复缺陷 */
  findings: {
    confirmed: string[];
    unverified: string[];
    false_positive: string[];
    duplicate: string[];
    fixed_pending_retest: string[];
    accepted_risk: string[];
    blocking: string[];
  };
  /** ⑥ 修复及复测关系 */
  fix_retest: {
    finding_id: string;
    fix_revision: string | null;
    fixed_by: string | null;
    retest_result: "pass" | "fail" | null;
    retested_by: string | null;
    retest_evidence: string | null;
  }[];
  /** ⑦ 设计偏离与已知限制 */
  design_deviations_and_limits: { deviations: string[]; known_limits: string[]; accepted_limits: string[] };
  /** ⑧ 用量/耗时：实测值或明确的未知（不编数字） */
  usage: {
    high_capability_calls: number | null;
    input_tokens: number | null;
    elapsed_ms: number | null;
    measured_by: string;
    unknown_reason: string | null;
  };
  /** 作者摘要只是导航（§5.5） */
  author_summary_is_navigation_only: true;
  /** 原文入口：终审据此自己读原文 */
  raw_entry_points: RawEntryPoint[];
  completeness: { complete: boolean; missing_items: AuditPackageItem[]; unknown_items: AuditPackageItem[] };
}

export interface BuildAuditPackageInput {
  package_id: string;
  batch_id: string;
  change_id?: string | null;
  submission: SubmissionRecord;
  coverage: { area: CoverageArea; status: CoverageStatus; basis: string; source?: string }[];
  self_checks?: SelfCheckRecord[];
  independent_audits?: IndependentAuditRecord[];
  fixes?: FixRecord[];
  retests?: RetestRecord[];
  findings: readonly FindingState[];
  /** 风险清单（可由 projection 的风险评估给，也可人工列） */
  risks?: { code: string; text: string; severity_hint?: string | null }[];
  deviations?: string[];
  known_limits?: string[];
  accepted_limits?: string[];
  evidence?: { evidence_id: string; recovery_path: string; kind: string; summary: string }[];
  usage?: Partial<AuditPackage["usage"]>;
  now?: string;
}

/** 组装审计包（纯函数；缺必含项如实进 `completeness`，不伪造） */
export function buildAuditPackage(input: BuildAuditPackageInput): AuditPackage {
  const ledger: FindingLedger = findingLedger([...input.findings]);
  const byId = new Map(input.findings.map((f) => [f.finding_id, f]));
  const fixRetest = [...(input.fixes ?? [])]
    .sort((a, b) => a.finding_id.localeCompare(b.finding_id))
    .map((fix) => {
      const retest =
        (input.retests ?? []).find((r) => r.finding_id === fix.finding_id && r.fix_revision === fix.fix_revision) ??
        (input.retests ?? []).find((r) => r.finding_id === fix.finding_id) ??
        null;
      const state = byId.get(fix.finding_id);
      return {
        finding_id: fix.finding_id,
        fix_revision: fix.fix_revision,
        fixed_by: fix.fixed_by,
        retest_result: retest?.result ?? null,
        retested_by: retest?.retested_by ?? null,
        retest_evidence: retest?.retest_evidence ?? state?.retest_evidence ?? null,
      };
    });
  const rawEntries: RawEntryPoint[] = [
    ...(input.submission.diff_recovery === null || input.submission.diff_sha256 === null
      ? []
      : [
          {
            locator: input.submission.diff_recovery,
            how_to_read: "按内容哈希取回 diff 原文（内容寻址，不依赖作者摘要）",
            sha256: input.submission.diff_sha256,
          },
        ]),
    ...(input.evidence ?? []).map((ev) => ({
      locator: ev.recovery_path,
      how_to_read: `读证据正文（${ev.kind}：${ev.summary}）`,
      sha256: ev.evidence_id,
    })),
    ...input.submission.commands
      .filter((c) => c.output_ref !== null)
      .map((c) => ({
        locator: c.output_ref as string,
        how_to_read: `原始输出（${c.command} → exit ${c.exit_code}）`,
        sha256: null,
      })),
  ];
  const coverage = input.coverage.map((c) => ({ ...c, source: c.source ?? "self_check_or_audit" }));
  const usage: AuditPackage["usage"] = {
    high_capability_calls: input.usage?.high_capability_calls ?? null,
    input_tokens: input.usage?.input_tokens ?? null,
    elapsed_ms: input.usage?.elapsed_ms ?? null,
    measured_by: input.usage?.measured_by ?? "unknown",
    unknown_reason: input.usage?.unknown_reason ?? null,
  };
  const missing: AuditPackageItem[] = [];
  const unknownItems: AuditPackageItem[] = [];
  if (input.submission.goal.trim() === "") missing.push("goal_and_baseline");
  if (input.submission.changed_files.length === 0) missing.push("diff_and_raw");
  if ((input.risks ?? []).length === 0) missing.push("risks");
  if (coverage.length === 0) missing.push("coverage_matrix");
  if (input.submission.commands.length === 0) missing.push("verification");
  if (input.findings.length === 0) {
    // 没有缺陷是合法结论，但必须由覆盖矩阵支撑（未查范围要另行列出）
    const unchecked = coverage.filter((c) => c.status !== "checked");
    if (unchecked.length > 0 || coverage.length === 0) missing.push("findings");
    else unknownItems.push("findings");
  }
  if (fixRetest.length === 0 && ledger.blocking.length > 0) missing.push("fix_retest");
  if ((input.deviations ?? []).length === 0 && (input.known_limits ?? []).length === 0) {
    unknownItems.push("design_deviations_and_limits");
  }
  if (usage.high_capability_calls === null && usage.elapsed_ms === null && usage.unknown_reason === null) {
    missing.push("usage");
  } else if (usage.high_capability_calls === null || usage.elapsed_ms === null) {
    unknownItems.push("usage");
  }
  return {
    package_id: input.package_id,
    batch_id: input.batch_id,
    generated_at: input.now ?? nowIso(),
    goal_and_baseline: {
      goal: input.submission.goal,
      baseline: input.submission.baseline,
      change_id: input.change_id ?? null,
    },
    diff_and_raw: {
      changed_files: input.submission.changed_files,
      diff_sha256: input.submission.diff_sha256,
      diff_recovery: input.submission.diff_recovery,
      raw_entries: rawEntries,
    },
    risks: { items: (input.risks ?? []).map((r) => ({ code: r.code, text: r.text, severity_hint: r.severity_hint ?? null })) },
    coverage_matrix: coverage,
    verification: {
      commands: input.submission.commands,
      outputs: rawEntries.filter((r) => r.sha256 === null),
    },
    findings: {
      confirmed: ledger.confirmed.map((f) => f.finding_id),
      unverified: ledger.unverified.map((f) => f.finding_id),
      false_positive: ledger.false_positive.map((f) => f.finding_id),
      duplicate: ledger.duplicate.map((f) => f.finding_id),
      fixed_pending_retest: ledger.fixed_pending_retest.map((f) => f.finding_id),
      accepted_risk: ledger.accepted_risk.map((f) => f.finding_id),
      blocking: ledger.blocking.map((f) => f.finding_id),
    },
    fix_retest: fixRetest,
    design_deviations_and_limits: {
      deviations: input.deviations ?? [],
      known_limits: input.known_limits ?? [],
      accepted_limits: input.accepted_limits ?? [],
    },
    usage,
    author_summary_is_navigation_only: true,
    raw_entry_points: rawEntries,
    completeness: { complete: missing.length === 0, missing_items: missing, unknown_items: unknownItems },
  };
}

/** 交终审前的一致性检查：必含项缺了就拦（作者摘要不能代替证据） */
export function assertAuditPackageComplete(pkg: AuditPackage): void {
  if (!pkg.completeness.complete) {
    throw new WorkError(
      "INVALID_COMMAND",
      `审计包不完整：缺 ${pkg.completeness.missing_items.join("、")}（作者摘要只是导航，不代替证据；` +
        "确实拿不到的必须写明未知理由，而不是省略）",
      { missing_items: pkg.completeness.missing_items, package_id: pkg.package_id },
    );
  }
  if (pkg.raw_entry_points.length === 0) {
    throw new WorkError(
      "INVALID_COMMAND",
      "审计包没有任何原文入口（raw_entry_points）：终审必须能自己读原文，不能只看作者摘要",
      { package_id: pkg.package_id },
    );
  }
}

// ── 高能力抽查包（§5.5 终审环） ──

export interface SpotCheckInput {
  spot_check_id: string;
  /** 种子（同一批次重跑得到同一份抽查范围，便于复现） */
  seed: string;
  /** 可抽查的源代码位置（项目内相对路径） */
  sources: { locator: string; sha256?: string | null; note?: string }[];
  /** 用户可见路径（场景/入口） */
  user_paths?: { locator: string; note?: string }[];
  /** 未被报告的空白区域（覆盖矩阵里的 unchecked / 没查过的地方） */
  unreported_areas?: { locator: string; note?: string }[];
  /** 每个区域抽查几处 */
  per_area?: number;
  now?: string;
}

export interface SpotCheckPackage {
  spot_check_id: string;
  seed: string;
  generated_at: string;
  selection: { area: "source" | "user_path" | "unreported"; locator: string; reason: string }[];
  raw_entry_points: RawEntryPoint[];
  author_summary_is_navigation_only: true;
  /** 结论边界声明：抽查不是全量证明 */
  statement: string;
}

/** 确定性选点：按 sha256(seed + locator) 排序取前 N —— 可复现，且不受作者排序影响 */
function pickDeterministic<T extends { locator: string }>(items: readonly T[], seed: string, n: number): T[] {
  const key = (item: T): string => sha256Hex(`${seed}\u0000${item.locator}`);
  return [...items].sort((a, b) => key(a).localeCompare(key(b))).slice(0, n);
}

/**
 * 组织高能力抽查包：给终审者**原文入口**与一份可复现的抽查清单。
 * 选点由种子决定（不由作者指定），并显式声明"未发现问题只表示在所述范围和方法内未发现"。
 */
export function buildSpotCheckPackage(input: SpotCheckInput): SpotCheckPackage {
  const perArea = input.per_area ?? 3;
  const selection: SpotCheckPackage["selection"] = [
    ...pickDeterministic(input.sources, input.seed, perArea).map((s) => ({
      area: "source" as const,
      locator: s.locator,
      reason: "独立选点：源码抽查（不看作者摘要的顺序）",
    })),
    ...pickDeterministic(input.user_paths ?? [], input.seed, perArea).map((s) => ({
      area: "user_path" as const,
      locator: s.locator,
      reason: "独立选点：用户路径抽查",
    })),
    ...pickDeterministic(input.unreported_areas ?? [], input.seed, perArea).map((s) => ({
      area: "unreported" as const,
      locator: s.locator,
      reason: "独立选点：未报错区域抽查（没报错 ≠ 没问题）",
    })),
  ];
  const rawEntryPoints: RawEntryPoint[] = [
    ...input.sources.map((s) => ({
      locator: s.locator,
      how_to_read: s.note ?? "读源码原文",
      sha256: s.sha256 ?? null,
    })),
    ...(input.user_paths ?? []).map((s) => ({
      locator: s.locator,
      how_to_read: s.note ?? "走一遍用户路径（真实操作，不看截图代替）",
      sha256: null,
    })),
    ...(input.unreported_areas ?? []).map((s) => ({
      locator: s.locator,
      how_to_read: s.note ?? "抽查未报错区域",
      sha256: null,
    })),
  ];
  return {
    spot_check_id: input.spot_check_id,
    seed: input.seed,
    generated_at: input.now ?? nowIso(),
    selection,
    raw_entry_points: rawEntryPoints,
    author_summary_is_navigation_only: true,
    statement:
      "高端抽查不是全量证明：未发现问题只表示在所述范围与方法内未发现；抽到系统性遗漏要扩大同类范围重审（DESIGN.md §5.5）",
  };
}

// ── 审计链一致性（"五件事分开记录"落到可判定的检查上） ──

export interface AuditChainChecks {
  /** 五件事各有记录（提交/自检/独立审计/修复+复测/人工接受） */
  separated: Record<"submission" | "self_check" | "independent_audit" | "fix" | "retest" | "human_acceptance", boolean>;
  /** 自检没有被当成独立审计（独立审计记录里不出现自检者） */
  self_check_not_reused_as_audit: boolean;
  /** 修复自述没有直接关闭缺陷（有关闭就必须有复测记录） */
  fix_self_report_does_not_close: boolean;
  /** 人工接受确实来自用户身份 */
  acceptance_is_user_role: boolean;
  problems: string[];
}

export function checkAuditChain(input: {
  records: AuditRecords;
  findings: readonly FindingState[];
}): AuditChainChecks {
  const { records, findings } = input;
  const problems: string[] = [];
  const submissions = Object.values(records.submissions);
  const selfChecks = Object.values(records.self_checks);
  const audits = Object.values(records.independent_audits);
  const fixes = Object.values(records.fixes);
  const retests = Object.values(records.retests);
  const acceptances = Object.values(records.acceptances);
  const separated = {
    submission: submissions.length > 0,
    self_check: selfChecks.length > 0,
    independent_audit: audits.length > 0,
    fix: fixes.length > 0,
    retest: retests.length > 0,
    human_acceptance: acceptances.length > 0,
  };
  const selfCheckers = new Set(selfChecks.map((s) => s.checked_by));
  const reused = audits.filter((a) => selfCheckers.has(a.auditor)).map((a) => a.record_id);
  if (reused.length > 0) {
    problems.push(`自检者被复用为独立审计者（自检不是独立审计）：${reused.join("、")}`);
  }
  const closedWithFix = findings.filter((f) => f.status === "closed" && f.fix_revision !== null);
  const badClose = closedWithFix.filter(
    (f) => !retests.some((r) => r.finding_id === f.finding_id && r.result === "pass"),
  );
  if (badClose.length > 0) {
    problems.push(
      `有关闭的缺陷缺独立复测记录（修复自述不关闭缺陷）：${badClose.map((f) => f.finding_id).join("、")}`,
    );
  }
  const badAcceptance = acceptances.filter((a) => a.role !== "user");
  if (badAcceptance.length > 0) {
    problems.push(`人工验收不是用户身份：${badAcceptance.map((a) => a.record_id).join("、")}`);
  }
  const stillOpenWithFix = fixes.filter((fix) => {
    const state = findings.find((f) => f.finding_id === fix.finding_id);
    return state !== undefined && state.status === "fixed_pending_retest" && findingIsOpen(state);
  });
  if (stillOpenWithFix.length > 0) {
    problems.push(
      `已修复但还没复测（保持"已修复待复测"，不得算通过）：${stillOpenWithFix.map((f) => f.finding_id).join("、")}`,
    );
  }
  return {
    separated,
    self_check_not_reused_as_audit: reused.length === 0,
    fix_self_report_does_not_close: badClose.length === 0,
    acceptance_is_user_role: badAcceptance.length === 0,
    problems,
  };
}

/** 证据取回入口（审计包/抽查包引用原文时用它验一遍"引用得到"） */
export function readEvidenceForAudit(workDir: string, sha256: string) {
  return readEvidence(workDir, sha256);
}
