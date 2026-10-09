import { MarkerType, Position, type Edge, type Node } from '@xyflow/react';
import type { DataFlowModel } from './projectGraph';

/** Business entities only. Static import edges never enter this projection. */
export function businessFlowElements(model: DataFlowModel, chainId: string | null) {
  const chain = chainId === null ? null : model.chains.find(c => c.id === chainId);
  const allowedNodes = chainId === null ? null : new Set(chain?.hops.map(h => h.node_id) ?? []);
  const allowedEdges = chainId === null ? null : new Set(chain?.hops.flatMap(h => h.edge_id === null ? [] : [h.edge_id]) ?? []);
  const columns = { input_source: 0, process: 1, store: 2, output_external: 3 };
  const rows = [0, 0, 0, 0];
  const nodes: Node[] = model.nodes.filter(n => allowedNodes === null || allowedNodes.has(n.id)).map(n => {
    const col = columns[n.kind];
    return { id: n.id, position: { x: col * 310, y: rows[col]++ * 115 },
      sourcePosition: Position.Right, targetPosition: Position.Left, data: { ...n, label: n.label },
      style: { width: 240, padding: 14, borderRadius: 10, border: '1px solid #64748b', background: '#172033', color: '#e2e8f0' },
    };
  });
  const ids = new Set(nodes.map(n => n.id));
  const candidates = model.edges.filter(e => allowedEdges === null || allowedEdges.has(e.id));
  const unresolvedEdges = candidates.filter(e => !ids.has(e.from) || !ids.has(e.to)).map(e => e.id);
  const edges: Edge[] = candidates.filter(e => ids.has(e.from) && ids.has(e.to)).map(e => ({
    id: e.id, source: e.from, target: e.to, label: e.label, ariaLabel: e.label, data: { ...e },
    markerEnd: { type: MarkerType.ArrowClosed, color: '#94a3b8' },
    style: { stroke: '#94a3b8', strokeDasharray: e.verification === 'verified' ? undefined : '5 4' },
    labelStyle: { fill: '#64748b', fontSize: 11 },
  }));
  return { nodes, edges, unresolvedEdges };
}
