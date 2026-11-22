import '@xyflow/react/dist/style.css';
import { useQuery } from '@tanstack/react-query';
import {
  WINDOW_LABELS,
  formatDuration,
  formatPercent,
  type DependencyEdge,
  type DependencyGraph,
  type DependencyNode,
} from '@traceflow/shared';
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  getBezierPath,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import { AlertTriangle, Database, MessageSquare, Server } from 'lucide-react';
import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { EmptyState, ErrorState, PageHeader, WindowSelect } from '@/components/common';
import { Skeleton } from '@/components/ui/skeleton';
import { useTimeWindow } from '@/hooks/use-time-window';
import { api, queryKeys } from '@/lib/api';
import { serviceColor } from '@/lib/colors';
import { cn } from '@/lib/utils';

type ServiceNodeData = { node: DependencyNode };
type CallEdgeData = { edge: DependencyEdge };
type ServiceFlowNode = Node<ServiceNodeData, 'service'>;
type CallFlowEdge = Edge<CallEdgeData, 'call'>;

/**
 * Layered left-to-right layout: callers to the left of callees. Layers come
 * from a BFS over observed edges starting at nodes nobody calls; nodes only
 * reachable through a cycle fall back to layer 0. Deterministic, so the map
 * doesn't jump around between refreshes.
 */
export function layoutGraph(graph: DependencyGraph): {
  nodes: ServiceFlowNode[];
  edges: CallFlowEdge[];
} {
  const incoming = new Map<string, number>(graph.nodes.map((n) => [n.id, 0]));
  const out = new Map<string, string[]>();
  for (const e of graph.edges) {
    incoming.set(e.target, (incoming.get(e.target) ?? 0) + 1);
    out.set(e.source, [...(out.get(e.source) ?? []), e.target]);
  }
  const layer = new Map<string, number>();
  const queue = graph.nodes
    .filter((n) => (incoming.get(n.id) ?? 0) === 0)
    .map((n) => n.id)
    .sort();
  queue.forEach((id) => layer.set(id, 0));
  while (queue.length) {
    const id = queue.shift()!;
    for (const next of out.get(id) ?? []) {
      if (!layer.has(next)) {
        layer.set(next, layer.get(id)! + 1);
        queue.push(next);
      }
    }
  }
  for (const n of graph.nodes) if (!layer.has(n.id)) layer.set(n.id, 0);

  const columns = new Map<number, DependencyNode[]>();
  for (const n of graph.nodes) {
    const l = layer.get(n.id)!;
    columns.set(l, [...(columns.get(l) ?? []), n]);
  }
  const nodes: ServiceFlowNode[] = [];
  for (const [l, members] of columns) {
    members.sort((a, b) => a.id.localeCompare(b.id));
    members.forEach((n, i) => {
      nodes.push({
        id: n.id,
        type: 'service',
        position: { x: l * 440, y: (i - (members.length - 1) / 2) * 170 },
        data: { node: n },
      });
    });
  }
  const edges: CallFlowEdge[] = graph.edges.map((e) => ({
    id: `${e.source}->${e.target}`,
    source: e.source,
    target: e.target,
    type: 'call',
    data: { edge: e },
    markerEnd: {
      type: MarkerType.ArrowClosed,
      width: 14,
      height: 14,
      color: e.errorCount > 0 ? '#e5484d' : '#4a4a5a',
    },
  }));
  return { nodes, edges };
}

function ServiceNode({ data }: NodeProps<ServiceFlowNode>) {
  const n = data.node;
  const isService = n.kind === 'service';
  const Icon = n.kind === 'database' ? Database : n.kind === 'messaging' ? MessageSquare : Server;
  const color = isService ? serviceColor(n.id) : '#6f6f80';
  const label = isService ? n.id : n.id.replace(':', ' · ');
  return (
    <div
      className={cn(
        'w-[230px] rounded-lg border bg-panel shadow-lg shadow-black/30 transition-colors hover:border-line-strong',
        n.errorCount > 0 ? 'border-err/50' : 'border-line',
        isService && 'cursor-pointer',
      )}
      data-testid="map-node"
      data-node-id={n.id}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!size-2 !border-0 !bg-line-strong"
      />
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <span
          className="flex size-6 items-center justify-center rounded-md"
          style={{ backgroundColor: `${color}26`, color }}
        >
          <Icon className="size-3.5" aria-hidden />
        </span>
        <div className="min-w-0">
          <div className="truncate text-xs font-semibold text-ink">{label}</div>
          <div className="text-[10px] text-ink-3">
            {isService ? 'service' : `${n.kind} · inferred from client spans`}
          </div>
        </div>
      </div>
      <dl className="grid grid-cols-3 px-3 py-2 text-[10px]">
        <div>
          <dt className="text-ink-3">{isService ? 'Requests' : 'Calls'}</dt>
          <dd className="num text-xs font-medium text-ink">{n.requestCount}</dd>
        </div>
        <div>
          <dt className="text-ink-3">Errors</dt>
          <dd
            className={cn(
              'num flex items-center gap-0.5 text-xs font-medium',
              n.errorCount ? 'text-[#ff8a8d]' : 'text-ink',
            )}
          >
            {n.errorCount > 0 && <AlertTriangle className="size-2.5" aria-hidden />}
            {formatPercent(n.errorRate, 0)}
          </dd>
        </div>
        <div>
          <dt className="text-ink-3">P95</dt>
          <dd className="num text-xs font-medium text-ink">{formatDuration(n.latency.p95)}</dd>
        </div>
      </dl>
      <Handle
        type="source"
        position={Position.Right}
        className="!size-2 !border-0 !bg-line-strong"
      />
    </div>
  );
}

function CallEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  markerEnd,
}: EdgeProps<CallFlowEdge>) {
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });
  const e = data!.edge;
  const failing = e.errorCount > 0;
  // Stroke width scales (gently) with call volume.
  const width = 1.25 + Math.min(2.5, Math.log10(e.callCount + 1));
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        style={{
          stroke: failing ? '#e5484d' : '#4a4a5a',
          strokeWidth: width,
          strokeDasharray: failing ? '6 4' : undefined,
        }}
      />
      <EdgeLabelRenderer>
        <div
          className="nodrag nopan pointer-events-auto absolute rounded border border-line bg-raised px-1.5 py-0.5 text-[10px] text-ink-2 shadow"
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          data-testid="map-edge"
          data-edge={`${e.source}->${e.target}`}
        >
          <span className="num">{e.callCount} calls</span>
          <span className="mx-1 text-ink-3">·</span>
          <span className="num">p95 {formatDuration(e.latency.p95)}</span>
          {failing && (
            <span className="ml-1 inline-flex items-center gap-0.5 text-[#ff8a8d]">
              <AlertTriangle className="size-2.5" aria-hidden />
              {e.errorCount} err
            </span>
          )}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

const nodeTypes = { service: ServiceNode };
const edgeTypes = { call: CallEdge };

export default function ServiceMapPage() {
  const [window, setWindow] = useTimeWindow();
  const navigate = useNavigate();
  const graph = useQuery({
    queryKey: queryKeys.dependencies(window),
    queryFn: ({ signal }) => api.dependencies(window, signal),
  });
  const flow = useMemo(() => (graph.data ? layoutGraph(graph.data) : null), [graph.data]);

  return (
    <div className="flex min-h-[560px] flex-1 flex-col">
      <PageHeader
        title="Service map"
        subtitle={`Edges are observed parent → child calls between services · ${WINDOW_LABELS[window].toLowerCase()}`}
        actions={<WindowSelect value={window} onChange={setWindow} />}
      />
      <div className="relative min-h-0 flex-1">
        {graph.isError && !graph.data ? (
          <ErrorState error={graph.error} onRetry={() => void graph.refetch()} />
        ) : !flow ? (
          <div className="p-6">
            <Skeleton className="h-64" />
          </div>
        ) : flow.nodes.length === 0 ? (
          <EmptyState title="No dependencies observed in this window">
            Dependencies appear once services send spans with parent/child links across services.
          </EmptyState>
        ) : (
          <>
            <ReactFlow
              nodes={flow.nodes}
              edges={flow.edges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              fitView
              fitViewOptions={{ padding: 0.25, maxZoom: 1.1 }}
              minZoom={0.2}
              nodesConnectable={false}
              proOptions={{ hideAttribution: true }}
              onNodeClick={(_, node) =>
                node.data.node.kind === 'service' &&
                navigate(`/services/${encodeURIComponent(node.id)}?window=${window}`)
              }
            >
              <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#26262f" />
              <Controls showInteractive={false} position="bottom-right" />
            </ReactFlow>
            <div className="pointer-events-none absolute top-3 left-4 rounded-md border border-line bg-panel/90 px-3 py-2 text-[11px] text-ink-3 backdrop-blur">
              <div className="flex items-center gap-2">
                <span className="h-0.5 w-5 bg-[#4a4a5a]" /> healthy calls
              </div>
              <div className="mt-1 flex items-center gap-2">
                <span className="h-0 w-5 border-t-2 border-dashed border-err" />
                <AlertTriangle className="size-3 text-err" aria-hidden /> calls with errors
              </div>
              <div className="mt-1 flex items-center gap-2">
                <Database className="size-3" aria-hidden /> database (from{' '}
                <span className="font-mono">db.system</span>)
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
