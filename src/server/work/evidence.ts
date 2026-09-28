// 证据与缺陷记录（PLAN.md V06-09，DESIGN.md §5.5 / §2.6）。
//
// 边界（三件事，各自说清）：
//   ① **证据正文落不可变内容**：正文按 sha256 内容寻址落 `<workDir>/evidence/<sha256>.json`，
//      写一次就不再改写（同内容重复提交返回原记录并标 `duplicate`）。事件里**只引用** id/哈希/恢复位置，
//      不把正文塞进事件（DESIGN.md §2.6：事实文件只存引用）。
//   ② **严重度按用户后果定义**（§5.5）：阻断核心目标 / 数据丢失 / 越权属"必须拦截"；
//      判据里**没有**改动行数，也**没有**模型品牌——函数签名里干脆不存在这两个输入。
//   ③ **缺陷记录的最小字段与状态集**（§5.5）：`finding_id/severity/status/source/repro/expected/
//      actual/affected_revision/fix_revision/retest_evidence/reviewer`；状态七值见 `FINDING_STATUS_LABELS`。
//
// 去重两条路（都要明确，不靠"看起来像"）：
//   · **同指纹自动归并**：`findingFingerprint` 相同 = 同一实体 id，第二次报告落 `finding.reported_again`，
//     记 `reports+1`，**不产生第二条缺陷**（这是"同类问题重复上报"的确定性判据）。
//   · **显式判定重复**：`duplicate_of` 指向另一条 finding（同因不同描述），落 `finding.transition` 到
//     `duplicate`，链被压到根（重复不单独计入，也不单独阻塞）。
//
// 未证实与关闭（§5.5 后半段）：
//   · 没有复现条件的风险 → `unverified: true` + `risk_not_excluded: true`（明确写"风险未排除"，
//     不伪装成已证实 bug）；未证实的问题**不能**走 `closed`，只能补复现证据、标重复/误报，或由用户接受风险。
//   · 关闭必须有独立复测通过（复测者 ≠ 报告者/修复者，带 `retest_evidence`），或独立复核的误报，
//     或已被判重复。**修复自述不关闭缺陷**（§5.5 修复环）。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { nowIso } from "../time";
import { SCHEMA_VERSION, WorkError, type WorkEvent, type WorkReceipt } from "./types";
import { loadEvents } from "./eventStore";
import type { WorkSubmitter } from "./tasks";

// ── 证据版本绑定（§4.2 / §5.6：设计/接口/代码版本变化触发复核） ──

export type RevisionKind = "design" | "plan" | "interface" | "code";
export const REVISION_KINDS: readonly RevisionKind[] = ["design", "plan", "interface", "code"];

/** 一份证据/检查绑定的源修订（复核判据：绑定的版本 ≠ 当前版本 = 证据要重验） */
export interface EvidenceBinding {
  revision_kind: RevisionKind;
  revision: string;
}

export function bindingText(b: EvidenceBinding): string {
  return `${b.revision_kind}:${b.revision}`;
}

// ── 证据正文（内容寻址、不可变） ──

export const EVIDENCE_DIRNAME = "evidence";
export const MAX_EVIDENCE_BYTES = 8 * 1024 * 1024;

export const EVIDENCE_KINDS = [
  /** 结果提交的交付包/diff */
  "submission",
  /** 自检命令与原始输出 */
  "self_check",
  /** 独立审计的覆盖面与结论依据 */
  "independent_audit",
  /** 修复前后对照 */
  "fix",
  /** 复测证据（复现已消失 + 回归范围） */
  "retest",
  /** 缺陷复现步骤原始材料 */
  "repro",
  /** 人工验收场景输入/期望/实际 */
  "acceptance",
  /** 其他如实标注 */
  "other",
] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export interface EvidenceBlob {
  /** 内容寻址 id（= sha256），事件里引用它 */
  evidence_id: string;
  sha256: string;
  bytes: number;
  /** 项目内相对恢复位置（`.工作台/work/evidence/<sha256>.json`） */
  recovery_path: string;
  kind: EvidenceKind;
  summary: string;
  created_by: string;
  role: string;
  binding: EvidenceBinding;
  source_ref: string | null;
  created_at: string;
  /** true = 同内容此前已落库，本次未产生第二份、未改写任何字节 */
  duplicate: boolean;
}

export const evidenceDir = (workDir: string): string => path.join(workDir, EVIDENCE_DIRNAME);
export const evidenceBlobPath = (workDir: string, sha256: string): string =>
  path.join(evidenceDir(workDir), `${sha256}.json`);
export const evidenceRecoveryRel = (sha256: string): string =>
  [".工作台", "work", EVIDENCE_DIRNAME, `${sha256}.json`].join("/");

export const sha256Hex = (data: string | Buffer): string =>
  crypto.createHash("sha256").update(data).digest("hex");

function evidenceBad(message: string, detail: Record<string, unknown> = {}): never {
  throw new WorkError("EVIDENCE_INVALID", message, detail);
}

export interface EvidenceInput {
  content: string;
  kind: EvidenceKind;
  summary: string;
  created_by: string;
  role: string;
  binding: EvidenceBinding;
  source_ref?: string | null;
  occurred_at?: string;
}

/**
 * 落一份证据正文（内容寻址 + 一次性写入）。
 * 文件已存在 → 读回原记录并标 `duplicate: true`（**不改写**，因为"不可变"就是不改）。
 */
export function putEvidence(workDir: string, input: EvidenceInput): EvidenceBlob {
  if (typeof input.content !== "string") {
    evidenceBad("证据正文必须是字符串（二进制材料请转换为可读文本或 base64 后如实标注）");
  }
  if (!EVIDENCE_KINDS.includes(input.kind)) {
    evidenceBad(`证据 kind 只接受 ${EVIDENCE_KINDS.join("/")}（收到 ${JSON.stringify(input.kind)}）`, {
      field: "kind",
    });
  }
  if (!REVISION_KINDS.includes(input.binding?.revision_kind) || !input.binding?.revision) {
    evidenceBad("证据必须绑定源修订（binding.revision_kind + binding.revision），否则无法复核", {
      field: "binding",
    });
  }
  const bytes = Buffer.byteLength(input.content, "utf8");
  if (bytes > MAX_EVIDENCE_BYTES) {
    evidenceBad(`证据正文超过 ${MAX_EVIDENCE_BYTES} 字节上限（本次 ${bytes}）`, { bytes });
  }
  const sha256 = sha256Hex(input.content);
  const file = evidenceBlobPath(workDir, sha256);
  if (fs.existsSync(file)) {
    const existing = readEvidence(workDir, sha256);
    return { ...existing, duplicate: true };
  }
  const record: EvidenceBlob = {
    evidence_id: sha256,
    sha256,
    bytes,
    recovery_path: evidenceRecoveryRel(sha256),
    kind: input.kind,
    summary: input.summary,
    created_by: input.created_by,
    role: input.role,
    binding: input.binding,
    source_ref: input.source_ref ?? null,
    created_at: input.occurred_at ?? nowIso(),
    duplicate: false,
  };
  fs.mkdirSync(evidenceDir(workDir), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(
    tmp,
    JSON.stringify({ ...record, content_sha256: sha256, content: input.content }, null, 2) + "\n",
    "utf8",
  );
  // rename 之前若已被别处写进同一份内容（内容相同 → 同一路径），直接让位，不覆盖
  if (fs.existsSync(file)) {
    fs.rmSync(tmp, { force: true });
    return { ...readEvidence(workDir, sha256), duplicate: true };
  }
  fs.renameSync(tmp, file);
  return record;
}

/** 读一份证据正文（读时复核哈希：与文件名不符 = 现场被改过，必须暴露） */
export function readEvidence(workDir: string, sha256: string): EvidenceBlob {
  const file = evidenceBlobPath(workDir, sha256);
  if (!fs.existsSync(file)) {
    evidenceBad(`证据不存在：${sha256}（恢复位置 ${evidenceRecoveryRel(sha256)}）——` +
      "引用证据前必须先落正文，不能只写一个哈希", { evidence_id: sha256 });
  }
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch (e) {
    evidenceBad(`证据文件不是合法 JSON：${sha256}（${(e as Error).message}）`, { evidence_id: sha256 });
  }
  const content = raw.content;
  if (typeof content !== "string") evidenceBad(`证据文件缺正文：${sha256}`, { evidence_id: sha256 });
  const actual = sha256Hex(content);
  if (actual !== sha256) {
    evidenceBad(
      `证据内容与内容地址不符（文件 ${sha256.slice(0, 16)}…，实际 ${actual.slice(0, 16)}…）：` +
        "证据是不可变内容，对不上说明现场被改过——不静默放过",
      { evidence_id: sha256, actual_sha256: actual },
    );
  }
  return {
    evidence_id: sha256,
    sha256,
    bytes: Buffer.byteLength(content, "utf8"),
    recovery_path: evidenceRecoveryRel(sha256),
    kind: raw.kind as EvidenceKind,
    summary: typeof raw.summary === "string" ? raw.summary : "",
    created_by: typeof raw.created_by === "string" ? raw.created_by : "",
    role: typeof raw.role === "string" ? raw.role : "",
    binding: raw.binding as EvidenceBinding,
    source_ref: typeof raw.source_ref === "string" ? raw.source_ref : null,
    created_at: typeof raw.created_at === "string" ? raw.created_at : "",
    duplicate: false,
  };
}

export interface EvidenceManifestEntry {
  evidence_id: string;
  bytes: number;
  kind: string;
  summary: string;
  created_by: string;
  binding: EvidenceBinding | null;
  recovery_path: string;
  /** 读时复核：内容哈希与内容地址一致 */
  intact: boolean;
}

/** 列举本项目的证据正文（取证/抽查用）：不合法或对不上哈希的如实标 `intact: false`，不隐藏 */
export function evidenceManifest(workDir: string): EvidenceManifestEntry[] {
  const dir = evidenceDir(workDir);
  if (!fs.existsSync(dir)) return [];
  const out: EvidenceManifestEntry[] = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (!name.endsWith(".json")) continue;
    const sha = name.slice(0, -".json".length);
    try {
      const blob = readEvidence(workDir, sha);
      out.push({
        evidence_id: blob.evidence_id,
        bytes: blob.bytes,
        kind: blob.kind,
        summary: blob.summary,
        created_by: blob.created_by,
        binding: blob.binding ?? null,
        recovery_path: blob.recovery_path,
        intact: true,
      });
    } catch (e) {
      out.push({
        evidence_id: sha,
        bytes: 0,
        kind: "corrupt",
        summary: e instanceof Error ? e.message : String(e),
        created_by: "",
        binding: null,
        recovery_path: evidenceRecoveryRel(sha),
        intact: false,
      });
    }
  }
  return out;
}

// ── 严重度：按用户后果定义（§5.5） ──

export const FINDING_SEVERITIES = [
  /** 阻断核心目标：用户拿不到本批次要的结果 */
  "blocks_core_goal",
  /** 数据丢失：事实被删被覆盖，不可逆 */
  "data_loss",
  /** 越权：看到了或改了不该碰的 */
  "unauthorized_access",
  /** 用户可见的功能错误（不阻断核心目标） */
  "user_visible_defect",
  /** 可用但有降级/体验损失 */
  "degraded_experience",
  /** 文案/外观 */
  "cosmetic",
] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

/** 必须拦截的后果（§5.5：阻断核心目标、数据丢失或越权） */
export const MUST_BLOCK_SEVERITIES: readonly FindingSeverity[] = [
  "blocks_core_goal",
  "data_loss",
  "unauthorized_access",
];

/** 分级依据（写进交付包，防止有人按"改了多少行/哪家模型"升降级） */
export const SEVERITY_BASIS =
  "按用户后果分级：阻断核心目标 / 数据丢失 / 越权 = 必须拦截；不看改动行数，也不看模型品牌（DESIGN.md §5.5）";

export const SEVERITY_LABELS: Readonly<Record<FindingSeverity, string>> = {
  blocks_core_goal: "阻断核心目标",
  data_loss: "数据丢失",
  unauthorized_access: "越权",
  user_visible_defect: "用户可见功能错误",
  degraded_experience: "体验降级",
  cosmetic: "文案/外观",
};

export const isMustBlockSeverity = (sev: FindingSeverity): boolean =>
  MUST_BLOCK_SEVERITIES.includes(sev);

// ── 状态集与状态机（§5.5） ──

export const FINDING_STATUSES = [
  "pending_repro",
  "confirmed",
  "duplicate",
  "false_positive",
  "fixed_pending_retest",
  "closed",
  "accepted_risk",
] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];

export const FINDING_STATUS_LABELS: Readonly<Record<FindingStatus, string>> = {
  pending_repro: "待复现",
  confirmed: "已确认",
  duplicate: "重复",
  false_positive: "误报",
  fixed_pending_retest: "已修复待复测",
  closed: "已关闭",
  accepted_risk: "接受风险",
};

/** 允许的推进（终态不再自动变回；要重开得显式给依据） */
export const FINDING_TRANSITIONS: Readonly<Record<FindingStatus, readonly FindingStatus[]>> = {
  pending_repro: ["confirmed", "duplicate", "false_positive", "accepted_risk"],
  confirmed: ["fixed_pending_retest", "duplicate", "false_positive", "accepted_risk"],
  // 复测不过 → 回到已确认（不回到"待复现"：已经证实过）
  fixed_pending_retest: ["closed", "confirmed"],
  duplicate: [],
  false_positive: [],
  closed: [],
  // 接受风险不是永久免审：复查条件到点后重新确认或收口（DESIGN.md §5.6）
  accepted_risk: ["confirmed", "closed"],
};

/** 是否仍算"未收口的缺陷"（阻塞交付/需要收口） */
export function findingIsOpen(state: Pick<FindingState, "status">): boolean {
  return state.status === "pending_repro" || state.status === "confirmed" ||
    state.status === "fixed_pending_retest" || state.status === "accepted_risk";
}

/**
 * 是否应拦住"这批算通过"（必须拦截的后果 + 未收口）。
 * 重复/误报/已关闭不算；**用户已接受风险的也不算阻塞**——§5.5 允许"其他已知限制经用户接受"
 * 后请求批次 Gate，但它仍然不是"通过"（§4.2：不把已知问题染绿）。
 */
export function findingBlocksDelivery(
  state: Pick<FindingState, "status" | "severity" | "unverified">,
): boolean {
  if (!findingIsOpen(state)) return false;
  if (state.status === "accepted_risk") return false;
  return isMustBlockSeverity(state.severity);
}

// ── 缺陷状态（由事件折叠；纯派生） ──

export const FINDING_EVENT_TYPES = [
  "finding.opened",
  "finding.reported_again",
  "finding.transition",
  "finding.fix_submitted",
  "finding.retest_recorded",
  "finding.accepted_risk",
] as const;
export type FindingEventType = (typeof FINDING_EVENT_TYPES)[number];

export const findingEntityId = (findingId: string): string => `finding:${findingId}`;
export const findingIdOfEntity = (entityId: string): string | null =>
  entityId.startsWith("finding:") ? entityId.slice("finding:".length) : null;

export interface FindingHistoryEntry {
  at: string;
  type: FindingEventType;
  actor: string;
  status: FindingStatus;
  note: string | null;
}

export interface FindingAcceptance {
  accepted_by: string;
  basis: string;
  /** 适用版本（§5.6：记录适用版本，不能变成永久免审） */
  scope_revision: string;
  /** 复查条件/期限 */
  review_condition: string;
  accepted_at: string;
}

export interface FindingState {
  finding_id: string;
  /** 同类指纹（同指纹 = 同一条缺陷，第二次报告归并进来） */
  dedupe_key: string;
  severity: FindingSeverity;
  severity_label: string;
  must_block: boolean;
  status: FindingStatus;
  status_label: string;
  /** 影响对象稳定 ID（未定位时 null，不猜） */
  object_id: string | null;
  source: string;
  repro: string | null;
  expected: string;
  actual: string;
  affected_revision: string | null;
  fix_revision: string | null;
  /** 修复者（复测者不能是修复者本人） */
  fixed_by: string | null;
  retest_evidence: string | null;
  reviewer: string | null;
  /** 未证实：没有复现条件（§5.5：明确写"风险未排除"） */
  unverified: boolean;
  risk_not_excluded: boolean;
  duplicate_of: string | null;
  acceptance: FindingAcceptance | null;
  /** 被报告次数（同指纹重复上报不产生第二条缺陷） */
  reports: number;
  opened_by: string;
  opened_at: string;
  /** 推进历史（旧结论保留，不因转待验证而消失） */
  history: FindingHistoryEntry[];
  revision: number;
  seq: number;
  last_event_id: string;
  updated_at: string;
  last_actor: string;
  change_id: string;
}

/** 缺陷指纹：同指纹 = 同一条缺陷（用于自动去重） */
export function findingFingerprint(input: {
  source: string;
  expected: string;
  actual: string;
  affected_revision?: string | null;
  object_id?: string | null;
}): string {
  const norm = (s: string): string => s.replace(/\s+/g, " ").trim();
  return sha256Hex(
    JSON.stringify([
      norm(input.source),
      norm(input.expected),
      norm(input.actual),
      input.affected_revision ?? null,
      input.object_id ?? null,
    ]),
  );
}

export const findingIdOfFingerprint = (fingerprint: string): string => `f-${fingerprint.slice(0, 16)}`;

function findingBad(message: string, detail: Record<string, unknown> = {}): never {
  throw new WorkError("EVENT_INVALID", `缺陷事件不合法：${message}`, detail);
}

const strOrNull = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const reqStr = (v: unknown, field: string, eventId: string): string => {
  const s = strOrNull(v);
  if (s === null) findingBad(`payload.${field} 必须是非空字符串（事件 ${eventId}）`, { field, event_id: eventId });
  return s;
};

function assertSeverity(v: unknown, eventId: string): FindingSeverity {
  if (typeof v !== "string" || !FINDING_SEVERITIES.includes(v as FindingSeverity)) {
    findingBad(
      `payload.severity 必须是 ${FINDING_SEVERITIES.join("/")} 之一，收到 ${JSON.stringify(v)}（事件 ${eventId}）`,
      { event_id: eventId, severity: v, basis: SEVERITY_BASIS },
    );
  }
  return v as FindingSeverity;
}

function assertTransition(from: FindingStatus, to: FindingStatus, eventId: string): void {
  if (!FINDING_TRANSITIONS[from].includes(to)) {
    findingBad(
      `不允许的状态推进 ${from}（${FINDING_STATUS_LABELS[from]}）→ ${to}（${FINDING_STATUS_LABELS[to]}）` +
        `（事件 ${eventId}）。允许的下一步：${FINDING_TRANSITIONS[from].join("/") || "（终态，要重开请显式给依据）"}`,
      { event_id: eventId, from, to },
    );
  }
}

/**
 * 从事件折叠出缺陷状态（纯函数）。未知类型、坏推进、悬空 duplicate_of 都抛，不静默跳过。
 */
export function foldFindings(events: WorkEvent[]): { findings: Record<string, FindingState>; ignored_entities: string[] } {
  const findings: Record<string, FindingState> = {};
  const ignored = new Set<string>();
  for (const e of events) {
    const findingId = findingIdOfEntity(e.entity_id);
    if (findingId === null) {
      ignored.add(e.entity_id);
      continue;
    }
    if (findingId === "") findingBad(`实体 id 缺 finding_id（事件 ${e.event_id}）`, { event_id: e.event_id });
    if (!(FINDING_EVENT_TYPES as readonly string[]).includes(e.type)) {
      findingBad(`未知缺陷事件类型 ${JSON.stringify(e.type)}（事件 ${e.event_id}）`, {
        event_id: e.event_id,
        type: e.type,
      });
    }
    const type = e.type as FindingEventType;
    const prev = findings[findingId] ?? null;
    const p = e.payload;
    if (type === "finding.opened") {
      if (prev !== null) {
        findingBad(`缺陷 ${findingId} 被重复 opened（事件 ${e.event_id}）——再次上报应走 finding.reported_again`, {
          event_id: e.event_id,
        });
      }
      const severity = assertSeverity(p.severity, e.event_id);
      const repro = strOrNull(p.repro);
      const evidence = strOrNull(p.evidence_sha256);
      const duplicateOfRaw = strOrNull(p.duplicate_of);
      const status: FindingStatus = duplicateOfRaw !== null ? "duplicate" : repro !== null && evidence !== null ? "confirmed" : "pending_repro";
      findings[findingId] = {
        finding_id: findingId,
        dedupe_key: strOrNull(p.dedupe_key) ?? findingFingerprint({
          source: reqStr(p.source, "source", e.event_id),
          expected: reqStr(p.expected, "expected", e.event_id),
          actual: reqStr(p.actual, "actual", e.event_id),
          affected_revision: strOrNull(p.affected_revision),
          object_id: strOrNull(p.object_id),
        }),
        severity,
        severity_label: SEVERITY_LABELS[severity],
        must_block: isMustBlockSeverity(severity),
        status,
        status_label: FINDING_STATUS_LABELS[status],
        object_id: strOrNull(p.object_id),
        source: reqStr(p.source, "source", e.event_id),
        repro,
        expected: reqStr(p.expected, "expected", e.event_id),
        actual: reqStr(p.actual, "actual", e.event_id),
        affected_revision: strOrNull(p.affected_revision),
        fix_revision: null,
        fixed_by: null,
        retest_evidence: null,
        reviewer: null,
        unverified: repro === null,
        risk_not_excluded: repro === null,
        duplicate_of: duplicateOfRaw,
        acceptance: null,
        reports: 1,
        opened_by: e.actor_id,
        opened_at: e.occurred_at,
        history: [
          {
            at: e.received_at,
            type,
            actor: e.actor_id,
            status,
            note: duplicateOfRaw !== null ? `判为重复：${duplicateOfRaw}` : null,
          },
        ],
        revision: e.entity_revision,
        seq: e.seq,
        last_event_id: e.event_id,
        updated_at: e.received_at,
        last_actor: e.actor_id,
        change_id: e.change_id,
      };
      continue;
    }
    if (prev === null) {
      findingBad(`缺陷 ${findingId} 的首条事件是 ${type}（事件 ${e.event_id}）——必须先 finding.opened`, {
        event_id: e.event_id,
      });
    }
    const next: FindingState = {
      ...prev,
      revision: e.entity_revision,
      seq: e.seq,
      last_event_id: e.event_id,
      updated_at: e.received_at,
      last_actor: e.actor_id,
      change_id: e.change_id,
    };
    if (type === "finding.reported_again") {
      next.reports = prev.reports + 1;
      next.history = [
        ...prev.history,
        { at: e.received_at, type, actor: e.actor_id, status: prev.status, note: strOrNull(p.note) ?? strOrNull(p.source) },
      ];
    } else if (type === "finding.transition") {
      const to = p.to;
      if (typeof to !== "string" || !FINDING_STATUSES.includes(to as FindingStatus)) {
        findingBad(`payload.to 必须是 ${FINDING_STATUSES.join("/")} 之一（事件 ${e.event_id}）`, {
          event_id: e.event_id,
          to,
        });
      }
      assertTransition(prev.status, to as FindingStatus, e.event_id);
      next.status = to as FindingStatus;
      next.status_label = FINDING_STATUS_LABELS[next.status];
      next.reviewer = strOrNull(p.reviewer) ?? next.reviewer;
      const duplicateOf = strOrNull(p.duplicate_of);
      if (next.status === "duplicate") {
        if (duplicateOf === null) {
          findingBad(`判为重复必须给 payload.duplicate_of（事件 ${e.event_id}）`, { event_id: e.event_id });
        }
        next.duplicate_of = duplicateOf;
      }
      if (next.status === "false_positive") {
        const reviewer = strOrNull(p.reviewer);
        if (reviewer === null) {
          findingBad(`判为误报必须给 payload.reviewer（谁独立复核的，事件 ${e.event_id}）`, { event_id: e.event_id });
        }
        if (reviewer === prev.opened_by) {
          findingBad(`误报判定必须由报告者以外的人复核（${reviewer} 就是报告者，事件 ${e.event_id}）`, {
            event_id: e.event_id,
          });
        }
        if (strOrNull(p.note) === null) {
          findingBad(`判为误报必须写理由（payload.note，事件 ${e.event_id}）`, { event_id: e.event_id });
        }
        next.reviewer = reviewer;
      }
      if (next.status === "closed") {
        // 关闭必须有独立复测通过的证据，或独立误报判定，或已被判重复；也允许"复测已过"后收口
        const retest = strOrNull(p.retest_evidence);
        const reviewer = strOrNull(p.reviewer);
        const viaRetest =
          retest !== null && reviewer !== null && reviewer !== prev.opened_by && prev.fix_revision !== null;
        const viaFalsePositive = prev.status === "false_positive";
        const viaDuplicate = prev.status === "duplicate";
        if (!viaRetest && !viaFalsePositive && !viaDuplicate) {
          findingBad(
            `关闭 ${findingId} 缺依据：需要"独立复测通过 + 复测证据"（reviewer ≠ 报告者且已有 fix_revision）、` +
              `或此前已判误报/重复（事件 ${e.event_id}）。修复自述不关闭缺陷（DESIGN.md §5.5）`,
            { event_id: e.event_id, status: prev.status },
          );
        }
        if (prev.unverified && !viaFalsePositive && !viaDuplicate) {
          findingBad(
            `未证实的缺陷不能直接关闭（${findingId}，事件 ${e.event_id}）：要么补复现证据，要么由用户接受风险，` +
              "要么保持「风险未排除」——不把风险未排除伪装成已证实 bug（DESIGN.md §5.5）",
            { event_id: e.event_id },
          );
        }
        next.retest_evidence = retest ?? next.retest_evidence;
        next.reviewer = reviewer ?? next.reviewer;
      }
      next.history = [
        ...prev.history,
        { at: e.received_at, type, actor: e.actor_id, status: next.status, note: strOrNull(p.note) },
      ];
    } else if (type === "finding.fix_submitted") {
      assertTransition(prev.status, "fixed_pending_retest", e.event_id);
      next.status = "fixed_pending_retest";
      next.status_label = FINDING_STATUS_LABELS.fixed_pending_retest;
      next.fix_revision = reqStr(p.fix_revision, "fix_revision", e.event_id);
      // 谁修的也记下来：复测者不能是修复者本人（"修复自述不关闭缺陷"落到人身上）
      next.fixed_by = reqStr(p.fixed_by, "fixed_by", e.event_id);
      next.history = [
        ...prev.history,
        { at: e.received_at, type, actor: e.actor_id, status: next.status, note: next.fix_revision },
      ];
    } else if (type === "finding.retest_recorded") {
      if (prev.status !== "fixed_pending_retest") {
        findingBad(`复测只能针对"已修复待复测"的缺陷（${findingId} 当前 ${prev.status}，事件 ${e.event_id}）`, {
          event_id: e.event_id,
        });
      }
      const retestedBy = reqStr(p.retested_by, "retested_by", e.event_id);
      if (retestedBy === prev.opened_by) {
        findingBad(`复测者必须是报告者以外的人（${retestedBy} 就是报告者，事件 ${e.event_id}）`, {
          event_id: e.event_id,
        });
      }
      if (prev.fixed_by !== null && retestedBy === prev.fixed_by) {
        findingBad(
          `复测者不能是修复者本人（${retestedBy} 就是修复者，事件 ${e.event_id}）：修复自述不关闭缺陷，` +
            "复测要由另一个人独立做（DESIGN.md §5.5 修复环）",
          { event_id: e.event_id },
        );
      }
      const result = p.result;
      if (result !== "pass" && result !== "fail") {
        findingBad(`payload.result 只接受 pass/fail（事件 ${e.event_id}）`, { event_id: e.event_id, result });
      }
      next.retest_evidence = reqStr(p.retest_evidence, "retest_evidence", e.event_id);
      next.reviewer = retestedBy;
      if (result === "pass") {
        assertTransition(prev.status, "closed", e.event_id);
        next.status = "closed";
        next.status_label = FINDING_STATUS_LABELS.closed;
      } else {
        assertTransition(prev.status, "confirmed", e.event_id);
        next.status = "confirmed";
        next.status_label = FINDING_STATUS_LABELS.confirmed;
        next.risk_not_excluded = true;
      }
      next.history = [
        ...prev.history,
        { at: e.received_at, type, actor: e.actor_id, status: next.status, note: `${result}:${next.retest_evidence}` },
      ];
    } else if (type === "finding.accepted_risk") {
      assertTransition(prev.status, "accepted_risk", e.event_id);
      const acceptedBy = reqStr(p.accepted_by, "accepted_by", e.event_id);
      if (e.role !== "user") {
        findingBad(
          `接受风险只能由用户给（本条事件 role=${e.role}）：Agent/技术审定不得代签（DESIGN.md §5.8）`,
          { event_id: e.event_id, role: e.role },
        );
      }
      const basis = reqStr(p.basis, "basis", e.event_id);
      const scopeRevision = reqStr(p.scope_revision, "scope_revision", e.event_id);
      const reviewCondition = reqStr(p.review_condition, "review_condition", e.event_id);
      next.status = "accepted_risk";
      next.status_label = FINDING_STATUS_LABELS.accepted_risk;
      next.acceptance = {
        accepted_by: acceptedBy,
        basis,
        scope_revision: scopeRevision,
        review_condition: reviewCondition,
        accepted_at: e.received_at,
      };
      next.reviewer = acceptedBy;
      next.history = [
        ...prev.history,
        { at: e.received_at, type, actor: e.actor_id, status: next.status, note: `${basis}（复查：${reviewCondition}）` },
      ];
    }
    findings[findingId] = next;
  }
  // duplicate_of 压到根（重复的重复 → 指向根），悬空引用直接暴露
  for (const state of Object.values(findings)) {
    if (state.duplicate_of === null) continue;
    let target = findings[state.duplicate_of];
    const seen = new Set<string>([state.finding_id]);
    while (target !== undefined && target.duplicate_of !== null) {
      if (seen.has(target.finding_id)) {
        findingBad(`重复链成环：${[...seen].join(" → ")} → ${target.finding_id}`, {
          finding_id: state.finding_id,
        });
      }
      seen.add(target.finding_id);
      target = findings[target.duplicate_of];
    }
    if (target === undefined || target.finding_id === state.finding_id) {
      findingBad(`重复指向不存在的缺陷：${state.finding_id} → ${state.duplicate_of}`, {
        finding_id: state.finding_id,
      });
    }
    state.duplicate_of = target.finding_id;
  }
  return { findings, ignored_entities: [...ignored].sort() };
}

/** 从磁盘事件文件读并折叠缺陷（读路径；中段损坏会抛，不吞） */
export function readFindings(workDir: string): { findings: Record<string, FindingState>; ignored_entities: string[] } {
  const { events } = loadEvents(workDir);
  return foldFindings(events);
}

// ── 缺陷事件写入（唯一写入者：提交事件，不绕开） ──

export interface FindingEventInput {
  project_id: string;
  change_id: string;
  actor_id: string;
  role: string;
  occurred_at?: string;
}

function submitFindingEvent(
  submitter: WorkSubmitter,
  input: FindingEventInput & {
    finding_id: string;
    type: FindingEventType;
    expected_revision: number | null;
    payload?: Record<string, unknown>;
  },
): WorkReceipt {
  const rev = input.expected_revision === null ? 0 : input.expected_revision;
  return submitter.submit({
    schema_version: SCHEMA_VERSION,
    project_id: input.project_id,
    change_id: input.change_id,
    entity_id: findingEntityId(input.finding_id),
    expected_revision: input.expected_revision,
    type: input.type,
    actor_id: input.actor_id,
    role: input.role,
    idempotency_key: `finding:${input.finding_id}:${input.type}:${rev + 1}:${input.change_id}`,
    ...(input.occurred_at === undefined ? {} : { occurred_at: input.occurred_at }),
    payload: input.payload ?? {},
  });
}

export interface OpenFindingInput extends FindingEventInput {
  severity: FindingSeverity;
  source: string;
  expected: string;
  actual: string;
  /** 复现步骤；不给 = 未证实（明确写"风险未排除"） */
  repro?: string | null;
  /** 复现证据哈希（与 repro 同时给才算已确认） */
  evidence_sha256?: string | null;
  affected_revision?: string | null;
  object_id?: string | null;
  /** 显式判定为重复（同因不同描述） */
  duplicate_of?: string | null;
  note?: string | null;
}

export interface FindingReportReceipt {
  finding_id: string;
  event_id: string;
  seq: number;
  entity_revision: number;
  status: FindingStatus;
  /** true = 同指纹此前已报告，本次只记了一次重报（没有产生第二条缺陷） */
  deduped: boolean;
}

/**
 * 报告一条缺陷。**去重先于新建**：同指纹已有缺陷 → 记 `finding.reported_again`（不产生第二条）。
 * 已确认的判断也在这里落死：`repro` + `evidence_sha256` 齐 → `confirmed`，否则 `pending_repro` 且 `unverified`。
 */
export function openFinding(submitter: WorkSubmitter, input: OpenFindingInput): FindingReportReceipt {
  const current = currentFindings(submitter);
  const fingerprint = findingFingerprint({
    source: input.source,
    expected: input.expected,
    actual: input.actual,
    affected_revision: input.affected_revision ?? null,
    object_id: input.object_id ?? null,
  });
  const existing = current.findings[findingIdOfFingerprint(fingerprint)];
  if (existing !== undefined) {
    const receipt = submitFindingEvent(submitter, {
      ...input,
      finding_id: existing.finding_id,
      type: "finding.reported_again",
      expected_revision: existing.revision,
      payload: {
        source: input.source,
        note: input.note ?? input.source,
        ...(input.repro == null ? {} : { repro: input.repro }),
      },
    });
    return {
      finding_id: existing.finding_id,
      event_id: receipt.event_id,
      seq: receipt.seq,
      entity_revision: receipt.entity_revision,
      status: currentFindings(submitter).findings[existing.finding_id]?.status ?? existing.status,
      deduped: true,
    };
  }
  const findingId = findingIdOfFingerprint(fingerprint);
  const duplicateOf = input.duplicate_of ?? null;
  if (duplicateOf !== null && current.findings[duplicateOf] === undefined) {
    findingBad(`duplicate_of 指向不存在的缺陷：${duplicateOf}（先报本体，再判重复）`, {
      duplicate_of: duplicateOf,
    });
  }
  const receipt = submitFindingEvent(submitter, {
    ...input,
    finding_id: findingId,
    type: "finding.opened",
    expected_revision: null,
    payload: {
      dedupe_key: fingerprint,
      severity: input.severity,
      source: input.source,
      expected: input.expected,
      actual: input.actual,
      repro: input.repro ?? null,
      evidence_sha256: input.evidence_sha256 ?? null,
      affected_revision: input.affected_revision ?? null,
      object_id: input.object_id ?? null,
      duplicate_of: duplicateOf,
      severity_basis: SEVERITY_BASIS,
    },
  });
  const readBack = currentFindings(submitter).findings[findingId];
  return {
    finding_id: findingId,
    event_id: receipt.event_id,
    seq: receipt.seq,
    entity_revision: receipt.entity_revision,
    status: readBack?.status ?? (duplicateOf !== null ? "duplicate" : "pending_repro"),
    deduped: false,
  };
}

/** 折叠一次当前缺陷状态（`openFinding` 用它判去重；读侧由提交者给闭包，本模块不猜项目路径） */
export interface FindingReadSource {
  /** 读出当前缺陷状态 */
  read: () => { findings: Record<string, FindingState> };
}
export type FindingSubmitter = WorkSubmitter & Partial<FindingReadSource>;

function currentFindings(submitter: WorkSubmitter): { findings: Record<string, FindingState> } {
  const reader = (submitter as FindingSubmitter).read;
  if (typeof reader !== "function") {
    throw new WorkError(
      "EVIDENCE_INVALID",
      "提交者没有给出缺陷读侧（submitter.read）：去重与状态推进都要先读当前缺陷，" +
        "不能靠「我以为是新的」或「我以为它还是那个状态」",
      { reason: "missing_finding_reader" },
    );
  }
  return reader();
}

export interface FindingTransitionInput extends FindingEventInput {
  finding_id: string;
  to: FindingStatus;
  reviewer?: string | null;
  duplicate_of?: string | null;
  note?: string | null;
  /** 关闭时给：复测证据哈希 */
  retest_evidence?: string | null;
}

/** 推进缺陷状态（误报/重复/关闭；规则在 fold 里落死，这里只是提交入口） */
export function transitionFinding(
  submitter: WorkSubmitter,
  input: FindingTransitionInput,
): WorkReceipt {
  const current = currentFindings(submitter);
  const state = current.findings[input.finding_id];
  if (state === undefined) {
    findingBad(`缺陷不存在：${input.finding_id}`, { finding_id: input.finding_id });
  }
  return submitFindingEvent(submitter, {
    ...input,
    type: "finding.transition",
    expected_revision: state.revision,
    payload: {
      to: input.to,
      reviewer: input.reviewer ?? null,
      duplicate_of: input.duplicate_of ?? null,
      note: input.note ?? null,
      retest_evidence: input.retest_evidence ?? null,
    },
  });
}

/** 记"已修复待复测"（**修复自述不关闭缺陷**，要另有人复测） */
export function submitFindingFix(
  submitter: WorkSubmitter,
  input: FindingEventInput & {
    finding_id: string;
    fix_revision: string;
    /** 修复者（缺省 = 提交这条命令的 actor） */
    fixed_by?: string;
    evidence_sha256?: string | null;
  },
): WorkReceipt {
  const { fix_revision, evidence_sha256, fixed_by, ...rest } = input;
  const state = currentFinding(submitter, input.finding_id);
  return submitFindingEvent(submitter, {
    ...rest,
    finding_id: input.finding_id,
    type: "finding.fix_submitted",
    expected_revision: state.revision,
    payload: { fix_revision, fixed_by: fixed_by ?? input.actor_id, evidence_sha256: evidence_sha256 ?? null },
  });
}

/** 记复测结果（复测者 ≠ 报告者；pass 才关闭） */
export function submitFindingRetest(
  submitter: WorkSubmitter,
  input: FindingEventInput & {
    finding_id: string;
    retested_by: string;
    retest_evidence: string;
    result: "pass" | "fail";
    rerepro_gone?: boolean;
    regression_scope?: string[];
  },
): WorkReceipt {
  const state = currentFinding(submitter, input.finding_id);
  return submitFindingEvent(submitter, {
    ...input,
    finding_id: input.finding_id,
    type: "finding.retest_recorded",
    expected_revision: state.revision,
    payload: {
      retested_by: input.retested_by,
      retest_evidence: input.retest_evidence,
      result: input.result,
      rerepro_gone: input.rerepro_gone ?? input.result === "pass",
      regression_scope: input.regression_scope ?? [],
    },
  });
}

/** 用户接受风险（§5.6：记录适用版本与复查条件，不是永久免审；Agent 不得代签） */
export function submitFindingAcceptedRisk(
  submitter: WorkSubmitter,
  input: FindingEventInput & {
    finding_id: string;
    accepted_by: string;
    basis: string;
    scope_revision: string;
    review_condition: string;
  },
): WorkReceipt {
  const state = currentFinding(submitter, input.finding_id);
  if (input.role !== "user") {
    findingBad(
      `接受风险只能由用户提交（本条 role=${input.role}，actor=${input.actor_id}）：` +
        "Agent 与技术审定不得代用户操作 Gate（DESIGN.md §5.8）",
      { finding_id: input.finding_id, role: input.role },
    );
  }
  return submitFindingEvent(submitter, {
    ...input,
    finding_id: input.finding_id,
    type: "finding.accepted_risk",
    expected_revision: state.revision,
    payload: {
      accepted_by: input.accepted_by,
      basis: input.basis,
      scope_revision: input.scope_revision,
      review_condition: input.review_condition,
    },
  });
}

function currentFinding(submitter: WorkSubmitter, findingId: string): FindingState {
  const state = currentFindings(submitter).findings[findingId];
  if (state === undefined) findingBad(`缺陷不存在：${findingId}`, { finding_id: findingId });
  return state;
}

// ── 缺陷台账（审计包 ⑤ 用：已确认/未证实/误报/重复分开列） ──

export interface FindingLedger {
  confirmed: FindingState[];
  unverified: FindingState[];
  false_positive: FindingState[];
  duplicate: FindingState[];
  fixed_pending_retest: FindingState[];
  closed: FindingState[];
  accepted_risk: FindingState[];
  /** 仍拦住交付的（必须拦截后果 + 未收口） */
  blocking: FindingState[];
}

export function findingLedger(findings: readonly FindingState[]): FindingLedger {
  const by = (pred: (f: FindingState) => boolean) =>
    findings.filter(pred).sort((a, b) => a.finding_id.localeCompare(b.finding_id));
  return {
    confirmed: by((f) => f.status === "confirmed" && !f.unverified),
    unverified: by((f) => f.unverified && findingIsOpen(f)),
    false_positive: by((f) => f.status === "false_positive"),
    duplicate: by((f) => f.status === "duplicate"),
    fixed_pending_retest: by((f) => f.status === "fixed_pending_retest"),
    closed: by((f) => f.status === "closed"),
    accepted_risk: by((f) => f.status === "accepted_risk"),
    blocking: by((f) => findingBlocksDelivery(f)),
  };
}
