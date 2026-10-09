import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SIX_GRAPH_KEYS, sixGraphsOf } from "../../src/arch/sixGraphs";

// Real reader on a small, immutable isolated project. No cross-request derivation cache.
export function verifySmallGraphPagination(ok: (value: boolean, label: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-pagination-"));
  const arch = path.join(root, "project", ".工作台", "arch");
  fs.mkdirSync(arch, { recursive: true });
  const write = (file: string, value: unknown) => fs.writeFileSync(file, JSON.stringify(value));
  write(path.join(root, "registry.json"), {version:1,projects:[{id:"small",name:"small",path:path.join(root,"project"),kind:"backend",registered_at:"2026-01-01",last_opened_at:"2026-01-01"}]});
  write(path.join(arch,"modules.json"), {version:1,generated_at:"2026-01-01",budget_exhausted:false,modules:[
    {id:"alpha",name:"alpha",path:"alpha",file_count:2,loc:2,deps:[{to:"beta",weight:1}]},
    {id:"beta",name:"beta",path:"beta",file_count:1,loc:1,deps:[]}
  ]});
  write(path.join(arch,"blueprint.json"), {version:1,baseline_id:"fixture",generator_version:"fixture",generated_at:"2026-01-01",source_manifest:[],
    nodes:[{id:"plan:cap:01",kind:"capability",name:"A",source_refs:[],related_ids:[]},{id:"plan:cap:02",kind:"capability",name:"B",source_refs:[],related_ids:[]}],
    edges:[{id:"edge-a-b",from:"plan:cap:01",to:"plan:cap:02",kind:"dependency",source_refs:[]}],
    coverage:{design_sections:{total:0,mapped:0,unmapped:[]},plan_tasks:{total:0,mapped:0,unmapped:[]},code_modules:{total:2,mapped:2,unmapped:[]},nodes_total:2,nodes_kept:2,edges_total:1,edges_kept:1,note:"fixture"},
    omitted:[],model_receipt:null,publish:{published:true,reason:null,validated_at:"2026-01-01"},based_on:{model_key:"fx",full_key:"fx",design_content_sha256:null,plan_definition_sha256:null,semantic:false}});
  const seq = (g: any): string[] => [...g.nodes.map((n:any)=>`N:${n.id}`),...g.edges.map((n:any)=>`E:${n.id}`),...g.intra_relations.map((n:any)=>`I:${n.id}`)];
  try {
    for (const key of SIX_GRAPH_KEYS) {
      const full = sixGraphsOf("small",{dataDir:root,graph:key});
      const g = full.graphs[key]!;
      const expected = seq(g);
      const limits = new Set([1,g.nodes.length,g.nodes.length+1,g.nodes.length+g.edges.length,g.nodes.length+g.edges.length+1].filter(n=>n>0));
      for(const limit of limits) {
        let page=sixGraphsOf("small",{dataDir:root,graph:key,limit});
        const actual=seq(page.graphs[key]!);
        let cursor=page.completeness.cursors[key]??null;
        const seen=new Set<string>();
        for(let n=0;cursor!==null && n<Math.ceil(expected.length/limit);n++) {
          if(seen.has(cursor)) break;
          seen.add(cursor);
          page=sixGraphsOf("small",{dataDir:root,graph:key,limit,cursor});
          actual.push(...seq(page.graphs[key]!));
          cursor=page.completeness.cursors[key]??null;
        }
        ok(cursor===null && page.completeness.complete && new Set(actual).size===actual.length && JSON.stringify(actual)===JSON.stringify(expected),`⑦ isolated exhaustive ${key} limit=${limit}, ${actual.length}/${expected.length} objects`);
      }
    }
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
}
