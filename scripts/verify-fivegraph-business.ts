import assert from 'node:assert/strict';
import { businessFlowElements } from '../src/ui/arch/businessDataFlow';
import type { DataFlowModel } from '../src/ui/arch/projectGraph';
const model = {nodes: [
  {id:'input',kind:'input_source',label:'输入',verification:'unverified',provenance:'code_static'},
  {id:'process',kind:'process',label:'处理',verification:'verified',provenance:'code_measured'},
  {id:'store',kind:'store',label:'存储',verification:'missing',provenance:'unverified'},
  {id:'output',kind:'output_external',label:'输出',verification:'unverified',provenance:'design_declared'},
], edges:[
  {id:'read',from:'input',to:'process',label:'读取',verification:'unverified'},
  {id:'write',from:'process',to:'store',label:'写入',verification:'missing'},
  {id:'return',from:'store',to:'output',label:'返回',verification:'unverified'},
  {id:'broken',from:'absent',to:'store',label:'缺端点',verification:'missing'},
], chains:[{id:'one',hops:[{node_id:'input',edge_id:null},{node_id:'process',edge_id:'read'}]}]} as unknown as DataFlowModel;
const before=JSON.stringify(model);
const all=businessFlowElements(model,null);
assert.deepEqual(all.nodes.map(n=>n.id).sort(),model.nodes.map(n=>n.id).sort());
assert.deepEqual(all.edges.map(e=>e.id).sort(),['read','return','write']);
assert.deepEqual(all.unresolvedEdges,['broken']);
assert.equal(all.nodes.find(n=>n.id==='store')!.data.verification,'missing');
assert.equal(all.edges.find(e=>e.id==='read')!.data!.verification,'unverified');
assert(all.nodes.every(n=>Number.isFinite(n.position.x)&&Number.isFinite(n.position.y)));
const one=businessFlowElements(model,'one');
assert.deepEqual(one.nodes.map(n=>n.id).sort(),['input','process']);
assert.deepEqual(one.edges.map(e=>e.id),['read']);
assert.equal(businessFlowElements(model,'missing-chain').nodes.length,0);
assert.equal(JSON.stringify(model),before);
console.log('PASS business graph: full coverage, chain selection, unchanged evidence state, dangling relation disclosed, finite layout');
