import { useEffect, useMemo, useState } from 'react';
import { Background, Controls, ReactFlow, useNodesState, type Node } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useTheme } from '../theme';
import { businessFlowElements } from './businessDataFlow';
import { DataFlowModelView, EvidenceList, useDataFlowModel } from './DataFlowView';
import { DATA_FLOW_ENTITY_LABELS, DATA_FLOW_VERIFICATION_LABELS } from './projectGraph';

/** Same resolved business graph as HTTP/MCP; no independent verification judgment. */
export function BusinessDataFlowView({ projectId }: { projectId: string }) {
  const { model, error, loads } = useDataFlowModel(projectId);
  const { theme } = useTheme();
  const [chain, setChain] = useState<string | null>(null);
  const [selected, setSelected] = useState<{ kind: 'node' | 'edge'; id: string } | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  useEffect(() => { setChain(null); setSelected(null); setNodes([]); }, [projectId, setNodes]);
  const graph = useMemo(() => model === null ? null : businessFlowElements(model, chain), [model, chain]);
  useEffect(() => {
    setNodes(previous => (graph?.nodes ?? []).map(n => ({ ...n, position: previous.find(p => p.id === n.id)?.position ?? n.position })));
  }, [graph, setNodes]);
  const detail = selected === null ? null : selected.kind === 'node'
    ? model?.nodes.find(n => n.id === selected.id) : model?.edges.find(e => e.id === selected.id);
  return (
    <section className="flex min-h-0 flex-1 flex-col" data-business-flow data-business-flow-project={projectId}
      data-business-flow-loads={loads} data-business-flow-stale={error === null ? '0' : '1'}>
      <div className="flex flex-wrap items-center gap-3 border-b border-neutral-700 px-3 py-2 text-xs">
        <label>数据路径 <select aria-label="选择数据路径" value={chain ?? ''} onChange={e => { setChain(e.target.value || null); setSelected(null); }}
          className="max-w-[32rem] rounded border border-neutral-600 bg-transparent px-2 py-1">
          <option value="">全部业务路径</option>
          {model?.chains.map(c => <option value={c.id} key={c.id}>{c.label}</option>)}
        </select></label>
        <span data-business-flow-counts>{model === null ? '正在读取…' : `${graph?.nodes.length ?? 0} 个实体 · ${graph?.edges.length ?? 0} 条关系`}</span>
        <span className="text-neutral-500">输入 → 处理 → 存储 → 输出；点实体或连线看依据</span>
      </div>
      {error !== null && <p role="alert" className="px-3 py-2 text-sm text-rose-400">数据路径更新失败：{error}{model === null ? '' : '。保留上次成功数据，当前显示已陈旧。'}</p>}
      {model !== null && model.nodes.length === 0 && <p className="p-4 text-sm text-amber-400">尚无可绘制的业务数据路径。{model.coverage.note}</p>}
      {(graph?.unresolvedEdges.length ?? 0) > 0 && <p role="alert" className="px-3 text-xs text-rose-400">关系端点缺失：{graph!.unresolvedEdges.join('、')}</p>}
      <div className="relative flex min-h-[240px] flex-1">
        <ReactFlow key={projectId} nodes={nodes} edges={(graph?.edges ?? []).map(e => ({ ...e, label: selected?.kind === 'edge' && selected.id === e.id ? e.label : undefined }))} onNodesChange={onNodesChange}
          onNodeClick={(_, n) => setSelected({ kind: 'node', id: n.id })}
          onEdgeClick={(_, e) => setSelected({ kind: 'edge', id: e.id })}
          colorMode={theme} fitView minZoom={0.05} maxZoom={2} nodesConnectable={false} deleteKeyCode={null}
          onPaneClick={() => setSelected(null)}>
          <Background /><Controls showInteractive={false} />
        </ReactFlow>
        {detail !== null && detail !== undefined && <aside className="absolute bottom-3 right-3 top-3 w-80 overflow-auto rounded border border-neutral-600 bg-neutral-900 p-3 text-xs text-neutral-200" data-business-flow-detail={detail.id}>
          <button className="float-right" aria-label="关闭数据路径详情" onClick={() => setSelected(null)}>关闭</button>
          <h3 className="mb-2 font-semibold">{detail.label}</h3>
          <p>{'kind' in detail ? DATA_FLOW_ENTITY_LABELS[detail.kind] : `${detail.from} → ${detail.to}`}</p>
          <p data-business-flow-verification={detail.verification}>{DATA_FLOW_VERIFICATION_LABELS[detail.verification]}</p>
          <p className="my-2">{'role' in detail ? detail.role : detail.note}</p>
          <EvidenceList evidence={detail.evidence} />
        </aside>}
      </div>
      {model !== null && <details className="shrink-0 border-t border-neutral-700 px-3 py-2 text-xs" data-business-flow-materials>
        <summary className="cursor-pointer">来源与覆盖对账 · 缺路径 {model.coverage.missing}</summary>
        <div className="max-h-64 overflow-auto py-2"><DataFlowModelView model={model} /></div>
      </details>}
    </section>
  );
}
