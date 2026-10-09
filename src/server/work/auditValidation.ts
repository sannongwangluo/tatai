// New-write validation at the sole writer. Historical records are not reclassified.
import { WorkError, type WorkEvent } from "./types";
import { AUDIT_ENTITY_PREFIXES, COVERAGE_AREAS, assertCoverageComplete, type CoverageRow } from "./audit";
import { foldFindings } from "./evidence";
import { assertPendingHuman } from "./auditCorrection";

const bad = (message: string): never => { throw new WorkError("EVENT_INVALID", `审计写入被拒（零写入）：${message}`); };
export function assertNewAuditEvent(events: WorkEvent[], event: WorkEvent): void {
  const p = event.payload;
  if (!event.type.startsWith("audit.")) return;
  if (event.type === "audit.record_corrected") return; // Dedicated bounded protocol validates this type.
  const prefix = AUDIT_ENTITY_PREFIXES[event.type as keyof typeof AUDIT_ENTITY_PREFIXES];
  if (!prefix || !event.entity_id.startsWith(prefix) || event.entity_id === prefix) bad("事件类型与实体前缀不匹配");
  if (p.coverage !== undefined) {
    if (!Array.isArray(p.coverage)) bad("coverage必须为数组");
    const seen = new Set<string>();
    for (const row of p.coverage as Record<string, unknown>[]) {
      if (!row || typeof row.area!=="string" || !(COVERAGE_AREAS as readonly string[]).includes(row.area) || seen.has(row.area) || typeof row.basis!=="string" || !row.basis.trim()) bad("coverage视角非法、重复或缺依据");
      seen.add(row.area as string);
      // Existing API permits omitted status (=checked); an explicit unknown value never inherits it.
      if(row.status!==undefined && (typeof row.status!=="string" || !["checked","unchecked","not_applicable"].includes(row.status))) bad("coverage.status非法，不默认checked");
    }
  }
  if (event.type === "audit.self_check_recorded" || event.type === "audit.independent_audit_recorded") {
    if (p.conclusion !== "pass" && p.conclusion !== "fail") bad("conclusion 必须为 pass/fail");
    if (!Array.isArray(p.checks)) bad("checks 必须为数组；未验项应省略并列在 not_reported_scope");
    const seen = new Set<string>();
    for (const c of p.checks as Record<string, unknown>[]) {
      if (!c || typeof c.check_id !== "string" || !c.check_id.trim() || seen.has(c.check_id)) bad("检查身份缺失或重复");
      seen.add(c.check_id as string);
      if (event.type === "audit.self_check_recorded" && (c.result !== undefined || c.pending !== undefined)) bad("自检使用记录级conclusion，不接受会被忽略的逐项result/pending");
      if (event.type === "audit.independent_audit_recorded" && c.result !== "passed" && c.result !== "failed" && c.result !== "not_checked") bad("未知检查结果不得默认 passed");
      if (p.conclusion === "pass" && c.result === "failed") bad("pass 与 failed 检查矛盾");
      if (c.result === "not_checked") assertPendingHuman(c.pending);
    }
  }
  if (event.type !== "audit.independent_audit_recorded") return;
  if (typeof p.auditor !== "string" || !p.auditor.trim() || typeof p.author_id !== "string" || !p.author_id.trim() || p.auditor === p.author_id) bad("独审必须给不同的作者与审查者");
  if (!Array.isArray(p.coverage)) bad("缺覆盖矩阵");
  assertCoverageComplete(p.coverage as CoverageRow[]);
  const checks = p.checks as Record<string, unknown>[];
  const refs = p.findings ?? [];
  if (!Array.isArray(refs) || refs.some((r) => typeof r !== "string" || !r.trim())) bad("findings 必须是正式引用数组");
  if (p.conclusion === "fail" || checks.some((c) => c.result === "failed")) {
    const findings = foldFindings(events).findings;
    if ((refs as string[]).length === 0) bad("失败审计必须关联在册 finding；未验不是失败");
    for (const id of refs as string[]) {
      const f = findings[id];
      if (!f || (p.task_id && f.object_id !== p.task_id && f.object_id !== `task:${p.task_id}`)) bad(`finding 不存在或任务范围不符：${id}`);
    }
  }
}
