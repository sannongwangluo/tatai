// Append-only corrections: change interpretation, never original events or a failed check to passed.
import fs from "node:fs";
import path from "node:path";
import { WorkError, SCHEMA_VERSION, type WorkEvent } from "./types";
import { sha256Hex, foldFindings } from "./evidence";
import type { AuditRecords, AuditWriteContext } from "./audit";
import type { WorkSubmitter } from "./tasks";

export interface PendingHuman { role: "human_tester" | "user"; reason: string; basis: string }
export interface AuditCorrection {
  operation: "bind_finding_refs" | "reclassify_not_checked";
  target_event_id: string; target_seq: number; target_sha256: string; task_id: string;
  target_raw_sha256: string;
  target_binding_sha256: string;
  check_id?: string; target_check_sha256?: string; pending?: PendingHuman;
  mappings?: { original_text: string; finding_ids: string[]; reason: string }[];
  finding_scope?: { finding_id:string; object_id:string; event_id:string; event_sha256:string }[];
  reviewer: string; reason: string;
  report_ref: string; report_sha256: string;
  authorization_ref: string; authorization_sha256: string;
  supersedes: string | null;
}
const bad=(s:string):never=>{throw new WorkError("EVENT_INVALID",`审计纠正被拒：${s}`);};
const digest=(v:unknown)=>sha256Hex(JSON.stringify(v));
export function assertPendingHuman(p:unknown): asserts p is PendingHuman {
  const v=p as PendingHuman;
  if (!v || Object.keys(v).some(k=>!["role","reason","basis"].includes(k)) || !["human_tester","user"].includes(v.role) || typeof v.reason!=="string" || !v.reason.trim() || typeof v.basis!=="string" || !v.basis.trim()) bad("待验必须给真实人的责任、原因与设计依据");
}
export function validateCorrection(events:WorkEvent[], e:WorkEvent): AuditCorrection {
  const p=e.payload as unknown as AuditCorrection;
  const allowed=["operation","target_event_id","target_seq","target_sha256","target_raw_sha256","task_id","target_binding_sha256","check_id","target_check_sha256","pending","mappings","finding_scope","reviewer","reason","report_ref","report_sha256","authorization_ref","authorization_sha256","supersedes"];
  if(Object.keys(e.payload).some(k=>!allowed.includes(k))) bad("不允许任意patch字段");
  if(e.role!=="coordinator" || !e.entity_id.startsWith("audit-correction:") || e.entity_id==="audit-correction:") bad("仅协调者可提交具名裁定");
  for(const k of ["target_event_id","task_id","reviewer","reason","report_ref","authorization_ref"] as const) if(typeof p[k]!=="string"||!p[k].trim()) bad(`缺${k}`);
  for(const k of ["target_sha256","target_raw_sha256","target_binding_sha256","report_sha256","authorization_sha256"] as const) if(!/^[a-f0-9]{64}$/.test(p[k])) bad(`非法${k}`);
  const target=events.find(t=>t.event_id===p.target_event_id && t.seq===p.target_seq);
  if(!target || target.type!=="audit.independent_audit_recorded" || target.project_id!==e.project_id || target.seq>=e.seq || digest(target)!==p.target_sha256) bad("原事件身份/内容/先后序不匹配");
  const t=target!.payload;
  if(t.task_id!==p.task_id || digest(t.binding??null)!==p.target_binding_sha256) bad("任务或原绑定不匹配");
  const identity=(v:unknown)=>typeof v==="string"?v.trim().normalize("NFKC").toLowerCase():"";
  if([target!.actor_id,t.auditor,t.author_id].some(v=>identity(v)===identity(p.reviewer))) bad("裁定者不得是原审查者或被审作者");
  if(p.operation!=="bind_finding_refs" && p.operation!=="reclassify_not_checked") bad("不支持此纠正操作");
  const key=(q:AuditCorrection)=>`${q.target_event_id}/${q.operation}/${q.check_id??""}`;
  const previous=events.filter(x=>x.type==="audit.record_corrected" && x.seq<e.seq && key(x.payload as unknown as AuditCorrection)===key(p)).at(-1);
  if((previous?.event_id??null)!==p.supersedes) bad("前代纠正冲突；必须显式引用当前前代");
  if(previous && previous.entity_id!==e.entity_id) bad("纠正返工必须使用同一实体及expected_revision");
  if(p.operation==="reclassify_not_checked") {
    if(p.mappings!==undefined || p.finding_scope!==undefined) bad("待验更正不能改finding引用");
    const c=(t.checks as Record<string,unknown>[]??[]).find(x=>x.check_id===p.check_id);
    if(!c||c.result!=="failed"||digest(c)!==p.target_check_sha256) bad("仅可纠正身份精确匹配的原failed行");
    assertPendingHuman(p.pending);
  } else {
    if(p.check_id!==undefined||p.pending!==undefined||p.target_check_sha256!==undefined) bad("引用更正不能改检查结果");
    const texts=t.findings as string[];
    if(!Array.isArray(texts)||!texts.length||!Array.isArray(p.mappings)||p.mappings.length!==texts.length) bad("必须逐条解释原findings，不能丢失原文");
    const findings=foldFindings(events.filter(x=>x.seq<e.seq)).findings;
    if(p.finding_scope!==undefined && !Array.isArray(p.finding_scope)) bad("finding_scope必须为精确范围确认数组");
    for(const scope of p.finding_scope??[]) {
      const source=events.find(x=>x.event_id===scope.event_id && x.seq<e.seq && x.type==="finding.opened" && x.entity_id===`finding:${scope.finding_id}`);
      if(!source || source.payload.object_id!==scope.object_id || digest(source)!==scope.event_sha256) bad("旧finding范围确认与原事件不符");
    }
    const all:string[]=[];
    p.mappings!.forEach((m,i)=>{
      if(!m || Object.keys(m).some(k=>!["original_text","finding_ids","reason"].includes(k)) || m.original_text!==texts[i]||typeof m.reason!=="string"||!m.reason.trim()||!Array.isArray(m.finding_ids)) bad("原文或映射依据缺失");
      if(findings[texts[i]] && (m.finding_ids.length!==1||m.finding_ids[0]!==texts[i])) bad("不能替换已正式绑定的实质失败");
      for(const id of m.finding_ids) {
        const f=findings[id];
        const explicitScope=p.finding_scope?.some(s=>s.finding_id===id && s.object_id===f?.object_id);
        if(!f || (f.object_id!==p.task_id && f.object_id!==`task:${p.task_id}` && !explicitScope)) bad("finding不存在或跨任务");
        all.push(id);
      }
    });
    if(!all.length) bad("不能清空实质失败引用");
  }
  return p;
}
export function assertCorrectionFiles(e:WorkEvent,projectRoot:string):void {
  const p=e.payload as unknown as AuditCorrection;
  const lines=fs.readFileSync(path.join(projectRoot,".工作台","work","events.jsonl"),"utf8").split(/\r?\n/);
  const raw=lines.find(line=>line.trim() && JSON.parse(line).event_id===p.target_event_id);
  if(raw===undefined || sha256Hex(raw)!==p.target_raw_sha256) bad("原始事件行字节哈希不匹配");
  const readBound=(ref:string,hash:string):Buffer=>{
    if(typeof ref!=="string" || path.isAbsolute(ref)) bad("裁定证据必须为项目内相对路径");
    const file=path.resolve(projectRoot,ref), relative=path.relative(projectRoot,file);
    if(relative.startsWith("..")||path.isAbsolute(relative)||!fs.existsSync(file)) bad("证据越界或不可取回");
    const real=fs.realpathSync(file), rel=path.relative(fs.realpathSync(projectRoot),real);
    const bytes=fs.readFileSync(file);
    if(rel.startsWith("..")||path.isAbsolute(rel)||sha256Hex(bytes)!==hash) bad("证据内容不匹配或链接越界");
    return bytes;
  };
  const report=JSON.parse(readBound(p.report_ref,p.report_sha256).toString("utf8"));
  const authority=JSON.parse(readBound(p.authorization_ref,p.authorization_sha256).toString("utf8"));
  const {report_ref,report_sha256,authorization_ref,authorization_sha256,...reviewed}=p;
  const canonical=(v:any):string=>JSON.stringify(v,(_k,x)=>x && typeof x==="object" && !Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
  if(report.schema!=="audit-correction-review/1" || report.decision!=="approved" || report.reviewer!==p.reviewer || canonical(report.reviewed_correction)!==canonical(reviewed)) bad("独立裁定包未逐字段批准本次纠正");
  if(authority.schema!=="audit-correction-authorization/1" || typeof authority.authorized_by!=="string" || !authority.authorized_by.trim() || !Array.isArray(authority.scope) || !authority.scope.some((s:any)=>s.target_event_id===p.target_event_id && s.operation===p.operation && (s.check_id??null)===(p.check_id??null))) bad("授权包未覆盖本目标与操作");
  const source=report.original_report;
  if(!source || typeof source.pointer!=="string" || !source.pointer.startsWith("/")) bad("缺原审报告精确定位");
  const document=JSON.parse(readBound(source.ref,source.sha256).toString("utf8").replace(/^\uFEFF/,""));
  let value:any=document;
  for(const part of source.pointer.slice(1).split("/")) value=value?.[part.replace(/~1/g,"/").replace(/~0/g,"~")];
  if(value===undefined || digest(value)!==source.value_sha256) bad("原审报告定位或内容哈希不符");
  if(p.operation==="reclassify_not_checked" && (value?.check_id!==p.check_id || report.execution_assessment!=="not_performed")) bad("未验纠正必须针对原报告同一检查明确裁定未执行；实质语义由具名独审负责");
}
export function applyAuditCorrections(records:AuditRecords,events:WorkEvent[]):void {
  // Rebuild from immutable original; successive corrections only replace the same bounded interpretation.
  for(const e of events) {
    if(e.type!=="audit.record_corrected") continue;
    const p=validateCorrection(events,e);
    const original=events.find(x=>x.event_id===p.target_event_id)!;
    const record=records.independent_audits[original.entity_id.slice("audit:".length)];
    if(!record || record.seq!==original.seq) bad("目标记录被其他记录覆盖，不能猜测纠正目标");
    record.original_checks ??= structuredClone(record.checks);
    record.original_findings ??= [...record.findings];
    record.correction_refs ??= [];
    record.correction_refs.push(e.event_id);
    if(p.operation==="bind_finding_refs") record.findings=[...new Set(p.mappings!.flatMap(m=>m.finding_ids))];
    else {
      const check=record.checks.find(c=>c.check_id===p.check_id)!;
      check.result="not_checked";check.pending=p.pending;
      check.correction_seq=e.seq;
      check.correction_refs=[...(check.correction_refs??[]),e.event_id];
    }
  }
}
export function submitAuditCorrection(submitter:WorkSubmitter,input:AuditWriteContext & {correction_id:string;expected_revision:number|null;correction:AuditCorrection}) {
  return submitter.submit({schema_version:SCHEMA_VERSION,project_id:input.project_id,change_id:input.change_id,entity_id:`audit-correction:${input.correction_id}`,expected_revision:input.expected_revision,type:"audit.record_corrected",actor_id:input.actor_id,role:input.role,idempotency_key:`audit.record_corrected:${input.correction_id}:${input.expected_revision??0}`,payload:input.correction as unknown as Record<string,unknown>});
}
