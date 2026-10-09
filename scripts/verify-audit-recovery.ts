import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { WorkService } from "../src/server/work/service";
import { loadEvents } from "../src/server/work/eventStore";
import { foldAuditRecords } from "../src/server/work/audit";
import { sha256Hex } from "../src/server/work/evidence";
import { checksFromAudit, pickCheckRecords, checkEffectiveness } from "../src/server/work/statusProjection";

// Real sole writer in a disposable registry; production is never a target.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-audit-recovery-"));
const home = path.join(root, "home"), project = path.join(root, "project");
fs.mkdirSync(home); fs.mkdirSync(project);
fs.writeFileSync(path.join(home, "registry.json"), JSON.stringify({version:1,projects:[{id:"recovery",name:"recovery",path:project,kind:"backend",registered_at:new Date().toISOString(),last_opened_at:new Date().toISOString()}]}));
const service = new WorkService({dataDir:home});
const work = path.join(project, ".工作台", "work");
let count=0, failed=0;
const command=(type:string,entity:string,payload:Record<string,unknown>)=>({schema_version:2,project_id:"recovery",change_id:"test",entity_id:entity,expected_revision:null as number|null,type,actor_id:"tester",role:"auditor",idempotency_key:`case-${++count}`,payload});
function check(name:string,fn:()=>void){try{fn();console.log("PASS",name);}catch(e){failed++;console.error("FAIL",name,(e as Error).message);}}
function rejected(c:ReturnType<typeof command>){const before=fs.existsSync(path.join(work,"events.jsonl"))?fs.readFileSync(path.join(work,"events.jsonl")):Buffer.alloc(0);assert.throws(()=>service.submit(c));const after=fs.existsSync(path.join(work,"events.jsonl"))?fs.readFileSync(path.join(work,"events.jsonl")):Buffer.alloc(0);assert.deepEqual(after,before);}
try {
  check("direct invalid severity rejected before append",()=>rejected(command("finding.opened","finding:bad",{severity:"medium",source:"s",expected:"e",actual:"a"})));
  check("direct invalid audit result rejected before append",()=>rejected(command("audit.independent_audit_recorded","audit:bad",{auditor:"other",author_id:"author",conclusion:"pass",checks:[{check_id:"c",result:"out_of_scope"}]})));
  check("direct invalid retest rejected before append",()=>rejected(command("audit.retest_recorded","retest:bad",{finding_id:"f",retested_by:"other",retest_evidence:"e",result:"garbage"})));
  check("unknown coverage status rejected before append",()=>rejected(command("audit.independent_audit_recorded","audit:bad-coverage",{auditor:"other",author_id:"author",conclusion:"pass",checks:[],coverage:["behavior_boundaries","data_concurrency","interface_integration","failure_recovery","trust_permission"].map(area=>({area,status:"garbage",basis:"reviewed"}))})));
  check("self check cannot silently discard per-check result",()=>rejected(command("audit.self_check_recorded","check:unchecked",{checked_by:"author",conclusion:"pass",checks:[{check_id:"c",result:"not_checked",pending:{role:"human_tester",reason:"not done",basis:"design"}}]})));
  check("legal finding still accepted",()=>{service.submit(command("finding.opened","finding:valid",{severity:"user_visible_defect",source:"s",expected:"e",actual:"a"}));assert.equal(loadEvents(work).events.at(-1)?.entity_id,"finding:valid");});
  check("prose mapping preserves failed verdict and original text",()=>{
    const f:any={...command("finding.opened","finding:formal",{severity:"user_visible_defect",source:"s",expected:"e",actual:"a",object_id:"T"}),event_id:"f",seq:1,entity_revision:1,occurred_at:"now"};
    const old:any={...f,type:"audit.independent_audit_recorded",entity_id:"audit:prose",event_id:"a",seq:2,payload:{task_id:"T",auditor:"auditor-old",author_id:"author",conclusion:"fail",checks:[{check_id:"c",result:"failed"}],findings:["observed defect","context only"],binding:{revision_kind:"plan",revision:"v"}}};
    const correction:any={...f,type:"audit.record_corrected",entity_id:"audit-correction:prose",event_id:"c",seq:3,role:"coordinator",payload:{operation:"bind_finding_refs",target_event_id:"a",target_seq:2,target_raw_sha256:sha256Hex(JSON.stringify(old)),target_sha256:sha256Hex(JSON.stringify(old)),task_id:"T",target_binding_sha256:sha256Hex(JSON.stringify(old.payload.binding)),mappings:[{original_text:"observed defect",finding_ids:["formal"],reason:"same repro"},{original_text:"context only",finding_ids:[],reason:"not a defect assertion"}],reviewer:"reviewer",reason:"formalize refs",report_ref:"r",report_sha256:"a".repeat(64),authorization_ref:"a",authorization_sha256:"b".repeat(64),supersedes:null}};
    const records=foldAuditRecords([f,old,correction]);
    assert.deepEqual(records.independent_audits.prose.findings,["formal"]);
    assert.deepEqual(records.independent_audits.prose.original_findings,old.payload.findings);
    assert.equal(records.independent_audits.prose.checks[0].result,"failed");
    for(const mappings of [[{original_text:"observed defect",finding_ids:[],reason:"clear"},{original_text:"context only",finding_ids:[],reason:"clear"}], [{original_text:"wrong",finding_ids:["formal"],reason:"replace"},{original_text:"context only",finding_ids:[],reason:"context"}], [{original_text:"observed defect",finding_ids:["missing"],reason:"bad"},{original_text:"context only",finding_ids:[],reason:"context"}]]) assert.throws(()=>foldAuditRecords([f,old,{...correction,payload:{...correction.payload,mappings}}]));
    assert.throws(()=>foldAuditRecords([{...f,payload:{...f.payload,object_id:"other"}},old,correction]));
  });
  check("legacy unchecked misregistration is corrected without rewriting original",()=>{
    const old:any={...command("audit.independent_audit_recorded","audit:legacy",{}),event_id:"old",seq:1,entity_revision:1,received_at:"now",occurred_at:"now",payload:{task_id:"T",auditor:"old-auditor",author_id:"author",checks:[{check_id:"human",result:"failed"}],conclusion:"fail",findings:["f"],binding:{revision_kind:"plan",revision:"v"}}};
    const original=JSON.stringify(old);
    const correction:any={...old,event_id:"correction",entity_id:"audit-correction:legacy-human",seq:2,type:"audit.record_corrected",actor_id:"coordinator",role:"coordinator",payload:{operation:"reclassify_not_checked",target_event_id:"old",target_seq:1,target_raw_sha256:sha256Hex(original),target_sha256:sha256Hex(original),task_id:"T",target_binding_sha256:sha256Hex(JSON.stringify(old.payload.binding)),check_id:"human",target_check_sha256:sha256Hex(JSON.stringify(old.payload.checks[0])),pending:{role:"human_tester",reason:"未做实验",basis:"DESIGN §5.8"},reviewer:"independent",reason:"原报告未检",report_ref:"report.txt",report_sha256:"a".repeat(64),authorization_ref:"authority.txt",authorization_sha256:"b".repeat(64),supersedes:null}};
    const records=foldAuditRecords([old,correction]);
    assert.equal(records.independent_audits.legacy.checks[0].result,"not_checked");
    assert.equal(JSON.stringify(old),original);
    assert.throws(()=>foldAuditRecords([old,{...correction,payload:{...correction.payload,target_sha256:"0".repeat(64)}}]));
    for(const delta of [{role:"auditor"},{payload:{...correction.payload,reviewer:"old-auditor"}},{payload:{...correction.payload,target_seq:7}},{payload:{...correction.payload,task_id:"other"}},{payload:{...correction.payload,target_check_sha256:"0".repeat(64)}},{payload:{...correction.payload,target_binding_sha256:"0".repeat(64)}},{payload:{...correction.payload,operation:"set_passed"}},{payload:{...correction.payload,passed:true}},{payload:{...correction.payload,supersedes:"absent"}}]) {
      assert.throws(()=>foldAuditRecords([old,{...correction,...delta}]));
    }
    const inputs=checksFromAudit(records);
    const pending=inputs.find(c=>c.check_id==="human")!;
    const revisions={plan:"v"};
    assert.equal(checkEffectiveness(pending,revisions,new Set(["author"])).effective,"not_checked");
    assert.equal(pickCheckRecords(inputs,new Set(["author"]),revisions).get("human")?.result,"not_checked");
    const realFailure={...pending,record_ref:"audit:other",result:"failed" as const,ledger_seq:3,pending:undefined,correction_seq:undefined};
    assert.equal(pickCheckRecords([...inputs,realFailure],new Set(["author"]),revisions).get("human")?.result,"failed");
    const priorPass={...pending,result:"passed" as const,evidence_sha256:"a".repeat(64),ledger_seq:0,pending:undefined,correction_seq:undefined};
    assert.equal(pickCheckRecords([priorPass,...inputs],new Set(["author"]),revisions).get("human")?.result,"not_checked");
    const newPass={...priorPass,ledger_seq:10,method:"manual observation",record_method:"manual observation",at:"2026-10-08T00:00:00Z"};
    assert.equal(checkEffectiveness(newPass,revisions,new Set(["author"])).effective,"passed");
    assert.equal(pickCheckRecords([...inputs,newPass],new Set(["author"]),revisions).get("human")?.result,"not_checked");
    assert.equal(pickCheckRecords([...inputs,{...newPass,role:"user"}],new Set(["author"]),revisions).get("human")?.result,"passed");
    const gatePending={...pending,pending:{...pending.pending!,role:"user" as const}};
    assert.equal(pickCheckRecords([gatePending,{...newPass,role:"user"}],new Set(["author"]),revisions).get("human")?.result,"not_checked");
    const gate:any={task_id:"T",seq:11,decision:"accept",baseline:{plan_revision:"v",design_revision:"d"}};
    assert.equal(pickCheckRecords([gatePending,{...newPass,role:"user",human_gate:gate}],new Set(["author"]),{...revisions,design:"d"}).get("human")?.result,"passed");
    assert.equal(pickCheckRecords([gatePending,{...newPass,role:"user",human_gate:{...gate,baseline:{plan_revision:"old",design_revision:"d"}}}],new Set(["author"]),{...revisions,design:"d"}).get("human")?.result,"not_checked");
    // Exercise the real sole writer with a legacy event in an isolated ledger.
    const legacy={...old,seq:2};
    fs.appendFileSync(path.join(work,"events.jsonl"),JSON.stringify(legacy)+"\n");
    const originalReport={checks:[{check_id:"human",conclusion:"out_of_scope",basis:"experiment not performed"}]};
    fs.writeFileSync(path.join(project,"original.json"),JSON.stringify(originalReport));
    fs.writeFileSync(path.join(project,"authority.txt"),JSON.stringify({schema:"audit-correction-authorization/1",authorized_by:"coordinator",scope:[{target_event_id:"old",operation:"reclassify_not_checked",check_id:"human"}]}));
    const payload={...correction.payload,target_seq:2,target_raw_sha256:sha256Hex(JSON.stringify(legacy)),target_sha256:sha256Hex(JSON.stringify(loadEvents(work).events.at(-1))),report_sha256:"",authorization_sha256:sha256Hex(fs.readFileSync(path.join(project,"authority.txt")))};
    const reviewPayload=(p:any)=>{
      const {report_ref,report_sha256,authorization_ref,authorization_sha256,...reviewed_correction}=p;
      fs.writeFileSync(path.join(project,"report.txt"),JSON.stringify({schema:"audit-correction-review/1",decision:"approved",reviewer:p.reviewer,reviewed_correction,execution_assessment:"not_performed",original_report:{ref:"original.json",sha256:sha256Hex(fs.readFileSync(path.join(project,"original.json"))),pointer:"/checks/0",value_sha256:sha256Hex(JSON.stringify(originalReport.checks[0]))}}));
      p.report_sha256=sha256Hex(fs.readFileSync(path.join(project,"report.txt")));
    };
    reviewPayload(payload);
    const legal={...command("audit.record_corrected","audit-correction:legacy-human",payload),role:"coordinator"};
    rejected({...legal,payload:{...payload,report_sha256:"0".repeat(64)}});
    rejected({...legal,payload:{...payload,report_ref:"../outside.txt"}});
    const before=fs.readFileSync(path.join(work,"events.jsonl"));
    service.submit(legal);
    assert.deepEqual(fs.readFileSync(path.join(work,"events.jsonl")).subarray(0,before.length),before);
    assert.equal(foldAuditRecords(loadEvents(work).events).independent_audits.legacy.checks[0].result,"not_checked");
    rejected({...legal,idempotency_key:"conflict",expected_revision:1});
    const predecessor=loadEvents(work).events.at(-1)!;
    const next={...legal,idempotency_key:"supersede",expected_revision:1,payload:{...payload,supersedes:predecessor.event_id,reason:"clarified rationale"}};
    rejected(next); // The earlier review did not authorize this supersession.
    reviewPayload(next.payload);
    service.submit(next);
    assert.equal(foldAuditRecords(loadEvents(work).events).independent_audits.legacy.correction_refs?.length,2);
  });
} finally { fs.rmSync(root,{recursive:true,force:true}); }
console.log(`audit recovery: ${failed} failures`);process.exitCode=failed?1:0;
