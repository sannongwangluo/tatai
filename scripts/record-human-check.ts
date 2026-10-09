// Run only by the person who performed the check; never invoked by an Agent.
import fs from "node:fs";
import crypto from "node:crypto";
import readline from "node:readline/promises";
import { resolveDataDir } from "../src/server/registry";
import { WorkServiceClient } from "../src/server/work/service";

const file=process.argv[2];
if(!file || !process.stdin.isTTY) throw new Error("请实际测试人在交互终端运行：pnpm exec tsx scripts/record-human-check.ts <观察记录.json>。Agent 不代运行。");
const input=JSON.parse(fs.readFileSync(file,"utf8").replace(/^\uFEFF/,""));
for(const key of ["project_id","task_id","check_id","performed_by","author_id","evidence_sha256"]) {
  if(typeof input[key]!=="string" || !input[key].trim()) throw new Error(`缺 ${key}`);
}
if(input.result!=="passed" && input.result!=="failed") throw new Error("result 必须如实为 passed/failed");
if(!input.binding || !Array.isArray(input.coverage)) throw new Error("缺当前 binding 或五视角 coverage；按实际方法填写，不编造通过");
console.log(JSON.stringify(input,null,2));
const terminal=readline.createInterface({input:process.stdin,output:process.stdout});
const answer=await terminal.question("确认这是你本人完成的观察（不是最终 Gate）？输入 I PERFORMED THIS CHECK 记录，其他输入退出：");
terminal.close();
if(answer!=="I PERFORMED THIS CHECK") process.exit(1);
const id=`human-check-${crypto.randomUUID()}`;
const client=new WorkServiceClient({dataDir:resolveDataDir(),autostart:false});
const receipt=await client.submit({schema_version:2,project_id:input.project_id,change_id:"manual-human-check",entity_id:`audit:${id}`,expected_revision:null,type:"audit.independent_audit_recorded",actor_id:input.performed_by,role:"user",idempotency_key:id,payload:{
  task_id:input.task_id,auditor:input.performed_by,author_id:input.author_id,auditor_role:"user",
  independence:{different_actor:true,same_session_as_author:false,read_author_summary_first:input.read_author_summary_first!==false},
  conclusion:input.result==="passed"?"pass":"fail",checks:[{check_id:input.check_id,result:input.result,evidence_sha256:input.evidence_sha256}],
  coverage:input.coverage,findings:input.findings??[],binding:input.binding,
  not_reported_scope:["最终用户 Gate 未在此记录；按实际观察范围判定"]
}});
console.log(JSON.stringify(receipt,null,2));
