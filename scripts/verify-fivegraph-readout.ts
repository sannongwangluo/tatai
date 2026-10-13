// 六图读口专项回归（tsx 跑）：pnpm exec tsx scripts/verify-fivegraph-readout.ts
//
// 断言面（逐条保留原意，一行未删）：
//   · 数据流向图（业务层）非空；按稳定 ID 取节点/关系焦点，业务呈现沿用本体未核实状态；
//     主画布计数＝声明层节点/关系/链数（不拿技术层冒充业务数据流）；
//   · 模块方框图有**真实代码模块**（`origin_layer==='code'`）且每个都有非空路径可下钻；
//   · 系统架构图保留**未绘为连线的真实未解析关系**清单，且按关系焦点可直接取回（说明不被吞）。
//
// 读夹具（本脚本自己守的隔离口径，2026-10-09）：
//   以前本脚本直接用默认 `TATAI_HOME` 读名为 `tatai` 的项目——在隔离 TATAI_HOME 里该项目要么没登记、
//   要么登记到**没跑过静态解析**的源码树上，于是模块方框图一个代码模块都没有（`real.length===0`），
//   红的是夹具而不是读口。现在本脚本自建自己的真实项目读夹具，与其它脚本的 `ensureSelfRegistered` 同形：
//     ① 隔离 TATAI_HOME（`os.tmpdir()` 下临时目录，结束整目录删除）；
//     ② **受验源码的隔离镜像**：把本仓库源码树复制进临时夹具（不含 node_modules/.git/dist/.工作台，
//        真实数据目录与生产实例一律只读、零写入）；
//     ③ 必要扫描：对夹具真跑 `parseProject` 落 `modules.json`——技术详情层代码模块的唯一当前来源；
//        没有它，模块方框图/规划端点解析都不是「真实项目」的读数。
//   这样读的确实是**受验源码**（镜像副本）与它派生的**真实代码模块**，且不留任何生产写入。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sixGraphsOf } from '../src/arch/sixGraphs';
import { analyzeDataFlow } from '../src/arch/dataflow';
import { parseProject } from '../src/arch/parse';
import { addProject } from '../src/server/registry';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** 复制源码镜像时排除的顶层目录：依赖/构建产物/版本库/私有工作台/`audit` 都不是「受验源码」 */
const SKIP_TOP = new Set(['node_modules', '.git', 'dist', '.工作台', 'audit']);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tatai-fivegraph-readout-'));
const HOME = path.join(TMP, 'home');
const PROJ = path.join(TMP, 'tatai');
const prevHome = process.env.TATAI_HOME;

try {
  fs.mkdirSync(HOME, { recursive: true });
  fs.cpSync(REPO_ROOT, PROJ, {
    recursive: true,
    filter: (src) => {
      const top = path.relative(REPO_ROOT, src).split(path.sep)[0];
      if (top !== '' && SKIP_TOP.has(top)) return false;
      // 显式跳过符号链接：`audit` 是**非产品输入**（指向仓库外 D:\tatai\audit 的链接），
      // 复制它会把外部巨树拖进夹具；且 Windows 无特权时 cpSync 重建链接会 EPERM。
      // 这里选择**忽略**（不 dereference、不重建成树），只跳过，不动源目录里那个链接本身。
      if (fs.lstatSync(src).isSymbolicLink()) return false;
      return true;
    },
  });
  process.env.TATAI_HOME = HOME;
  addProject({ id: 'tatai', name: '塔台', path: PROJ, kind: 'fullstack', self_managed: true }, HOME);
  parseProject('tatai', HOME);

  const d = analyzeDataFlow('tatai');
  assert(d.nodes.length && d.edges.length, 'Real business declaration must be nonempty');
  const byNode = sixGraphsOf('tatai', { mode: 'full', graph: 'data_flow', node_id: d.nodes[0].id }) as any;
  assert.equal(byNode.node_focus.found, true);
  assert.equal(byNode.node_focus.business_appearances[0].object.id, d.nodes[0].id);
  assert.equal(byNode.node_focus.business_appearances[0].object.verification, d.nodes[0].verification);
  assert.deepEqual(byNode.graphs.data_flow.primary_canvas, { layer: 'business_data_flow', source: 'tech', nodes: d.nodes.length, edges: d.edges.length, chains: d.chains.length });
  const byEdge = sixGraphsOf('tatai', { mode: 'full', graph: 'data_flow', relation_id: d.edges[0].id }) as any;
  assert.equal(byEdge.relation_focus.found, true);
  assert.equal(byEdge.relation_focus.business_appearances[0].id, d.edges[0].id);
  assert.equal(byEdge.relation_focus.business_appearances[0].verification, d.edges[0].verification);
  const module = sixGraphsOf('tatai', { mode: 'full', graph: 'module_map' });
  const real = module.graphs.module_map!.nodes.filter((n) => n.origin_layer === 'code');
  assert(real.length > 0);
  assert(real.every((n) => typeof n.path === 'string' && n.path.length > 0), 'Code module paths available for drill-down');
  const main = sixGraphsOf('tatai', { mode: 'full', graph: 'architecture' });
  assert(Array.isArray(main.graphs.architecture!.unresolved_relations), 'Full unresolved relation list is available');
  const gap = main.graphs.architecture!.unresolved_relations![0];
  assert(gap, 'Real architecture unresolved relation is retained');
  const byGap = sixGraphsOf('tatai', { mode: 'full', graph: 'architecture', relation_id: gap.id }) as any;
  assert.equal(byGap.relation_focus.found, true);
  assert.deepEqual(byGap.relation_focus.unresolved_appearances[0], { graph: 'architecture', ...gap });
  assert.match(byGap.relation_focus.note, /关系存在但未绘为连线/, 'Provenance must not obscure the unresolved relationship explanation');
  console.log('PASS five-graph readout: business stable ID focus, original verification, primary canvas counts, module drill paths, unresolved relation list');
} finally {
  if (prevHome === undefined) delete process.env.TATAI_HOME;
  else process.env.TATAI_HOME = prevHome;
  fs.rmSync(TMP, { recursive: true, force: true });
}
