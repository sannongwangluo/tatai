// 同一份实现读数解释供 HTTP/MCP、交付总览和设计页消费。
// 只解释已有执行登记和验证事实，不改执行状态、完成门禁或用户接受。
import type { ImplementationReadout, VerificationReadout } from "./coverageTypes";

export function verificationIsCurrent(r: VerificationReadout): boolean {
  return r.display_status === "verified" && r.evidence_state === "verified" &&
    r.required_count > 0 && r.passed_count === r.required_count && r.missing.length === 0 &&
    !r.evidence_entry.some((e) => e.effective === "failed" || e.effective === "stale");
}

export function implementationInterpretation(
  implementation: ImplementationReadout,
  verification: VerificationReadout,
): { label: string; note: string } {
  const { state, result_registration: registration } = implementation;
  const submitted = registration?.submitted_task_ids.length ?? 0;
  const total = submitted + (registration?.pending_task_ids.length ?? 0);
  const registrationNote = registration === undefined
    ? (state === "result_submitted" ? "账本显示结果已提交；当前数据未提供逐项执行登记明细。" : "当前数据未提供逐项执行登记明细，不能把缺少执行登记当成未实现。")
    : registration.state === "complete"
      ? `执行结果已完整登记（${submitted}/${total}）。`
      : registration.state === "partial"
        ? `执行结果部分登记（${submitted}/${total}）；还有 ${total - submitted} 项未登记。`
        : total > 0
          ? `执行结果尚未登记（0/${total}）。`
          : "尚无成员任务的执行结果登记。";

  if (state === "blocked" || state === "cancelled" || state === "in_progress") {
    return { label: state === "blocked" ? "受阻" : state === "cancelled" ? "已取消" : "实现中", note: registrationNote };
  }
  const complete = registration?.state === "complete" || (registration === undefined && state === "result_submitted");
  if (verificationIsCurrent(verification)) {
    return {
      label: complete ? "已实现" : "已有验证依据",
      note: `当前范围的必需验证已通过。${registrationNote}${complete ? "独立审查和用户接受另列。" : "验证通过不代替执行结果提交，也不能把缺少登记理解为未实现。"}`,
    };
  }
  if (registration?.state === "partial") return { label: "部分结果已登记", note: registrationNote };
  if (complete) return { label: "已提交实现", note: `${registrationNote}当前验证尚未有效通过，不代表功能已完成。` };
  if (verification.evidence_state === "invalidated" || verification.evidence_entry.some((e) => e.effective === "stale")) {
    return { label: "验证依据待复核", note: `旧验证证据已失效，需要按当前版本复核。${registrationNote}` };
  }
  if (verification.passed_count > 0 || verification.evidence_entry.some((e) => e.effective === "passed")) {
    return { label: "有部分验证依据", note: `已有部分检查通过，尚不足以确认整个功能。${registrationNote}` };
  }
  if (state === "no_run_record") {
    return { label: "暂无执行记录", note: `${registrationNote}缺少执行记录不能证明没有实现；当前也没有完整有效的验证依据。` };
  }
  if (state === "not_started") {
    return { label: implementation.basis === null ? "未开始" : "执行待继续", note: registrationNote };
  }
  return { label: "未知", note: registrationNote };
}
