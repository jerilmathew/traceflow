/**
 * Trace tree reconstruction and timing analysis.
 *
 * A trace arrives as a flat bag of spans linked only by `parentSpanId`. These
 * helpers rebuild the tree defensively, because real telemetry is messy:
 *
 * - Parents can be missing (still in flight, dropped by a sampler, or from an
 *   uninstrumented hop). Such spans become *orphan roots* and are flagged.
 * - Malformed input can contain cycles (A → B → A) or self-parenting spans.
 *   Cycle members are detected and promoted to roots instead of recursing
 *   forever or silently disappearing.
 * - Children can outlive their parent (fire-and-forget async work).
 *
 * Everything is iterative (no recursion) so a pathological 10k-deep trace
 * cannot overflow the call stack in the browser.
 */

export interface TimedSpan {
  spanId: string;
  parentSpanId: string | null;
  /** Start, in ms relative to any fixed origin (typically the trace start). */
  offsetMs: number;
  durationMs: number;
}

export interface TraceTreeNode<T extends TimedSpan> {
  span: T;
  children: TraceTreeNode<T>[];
  depth: number;
  /** The span references a parent that is not present in the trace. */
  orphan: boolean;
  /** The span was part of a parent cycle and had its parent link cut. */
  cycleBroken: boolean;
}

export interface TraceTree<T extends TimedSpan> {
  roots: TraceTreeNode<T>[];
  byId: Map<string, TraceTreeNode<T>>;
  orphanCount: number;
  maxDepth: number;
}

const compareStart = <T extends TimedSpan>(a: TraceTreeNode<T>, b: TraceTreeNode<T>): number =>
  a.span.offsetMs - b.span.offsetMs ||
  b.span.durationMs - a.span.durationMs ||
  (a.span.spanId < b.span.spanId ? -1 : a.span.spanId > b.span.spanId ? 1 : 0);

export function buildTraceTree<T extends TimedSpan>(spans: readonly T[]): TraceTree<T> {
  const byId = new Map<string, TraceTreeNode<T>>();
  for (const span of spans) {
    // Duplicate span ids within one trace: keep the first occurrence.
    if (!byId.has(span.spanId)) {
      byId.set(span.spanId, { span, children: [], depth: 0, orphan: false, cycleBroken: false });
    }
  }

  const roots: TraceTreeNode<T>[] = [];
  for (const node of byId.values()) {
    const parentId = node.span.parentSpanId;
    if (!parentId) {
      roots.push(node);
      continue;
    }
    const parent = parentId === node.span.spanId ? undefined : byId.get(parentId);
    if (parent) {
      parent.children.push(node);
    } else {
      node.orphan = parentId !== node.span.spanId;
      node.cycleBroken = parentId === node.span.spanId;
      roots.push(node);
    }
  }

  // Any node not reachable from a root sits on a cycle. Promote one member of
  // each cycle to a root (cutting its parent link) until everything is reachable.
  const visited = new Set<TraceTreeNode<T>>();
  const markReachable = (start: TraceTreeNode<T>): void => {
    const stack = [start];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (visited.has(current)) continue;
      visited.add(current);
      for (const child of current.children) stack.push(child);
    }
  };
  roots.forEach(markReachable);
  if (visited.size < byId.size) {
    for (const node of byId.values()) {
      if (visited.has(node)) continue;
      const parent = node.span.parentSpanId ? byId.get(node.span.parentSpanId) : undefined;
      if (parent) parent.children = parent.children.filter((c) => c !== node);
      node.cycleBroken = true;
      roots.push(node);
      markReachable(node);
    }
  }

  // Sort children by start time and assign depths (iterative DFS).
  roots.sort(compareStart);
  let maxDepth = 0;
  const stack: TraceTreeNode<T>[] = [...roots];
  while (stack.length > 0) {
    const node = stack.pop()!;
    maxDepth = Math.max(maxDepth, node.depth);
    node.children.sort(compareStart);
    for (const child of node.children) {
      child.depth = node.depth + 1;
      stack.push(child);
    }
  }

  const orphanCount = roots.filter((r) => r.orphan).length;
  return { roots, byId, orphanCount, maxDepth };
}

export interface FlatRow<T extends TimedSpan> {
  node: TraceTreeNode<T>;
  depth: number;
  hasChildren: boolean;
  collapsed: boolean;
}

/**
 * Pre-order flattening for rendering the waterfall. Children of nodes whose
 * span id is in `collapsed` are skipped.
 */
export function flattenTree<T extends TimedSpan>(
  roots: readonly TraceTreeNode<T>[],
  collapsed: ReadonlySet<string> = new Set(),
): FlatRow<T>[] {
  const rows: FlatRow<T>[] = [];
  const stack: TraceTreeNode<T>[] = [...roots].reverse();
  while (stack.length > 0) {
    const node = stack.pop()!;
    const isCollapsed = collapsed.has(node.span.spanId);
    rows.push({
      node,
      depth: node.depth,
      hasChildren: node.children.length > 0,
      collapsed: isCollapsed,
    });
    if (!isCollapsed) {
      for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]!);
    }
  }
  return rows;
}

/** Merge [start, end) intervals and return their total covered length. */
export function unionLength(intervals: ReadonlyArray<readonly [number, number]>): number {
  const sorted = intervals.filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0]);
  let total = 0;
  let curStart = Number.NEGATIVE_INFINITY;
  let curEnd = Number.NEGATIVE_INFINITY;
  for (const [s, e] of sorted) {
    if (s > curEnd) {
      if (curEnd > curStart) total += curEnd - curStart;
      curStart = s;
      curEnd = e;
    } else if (e > curEnd) {
      curEnd = e;
    }
  }
  if (curEnd > curStart) total += curEnd - curStart;
  return total;
}

/**
 * Self time: the part of a span's duration not covered by any of its direct
 * children. Child intervals are clipped to the parent's interval, and
 * overlapping (concurrent) children are only counted once.
 */
export function selfTimeMs<T extends TimedSpan>(node: TraceTreeNode<T>): number {
  const start = node.span.offsetMs;
  const end = start + node.span.durationMs;
  const covered = unionLength(
    node.children.map((c) => {
      const cs = Math.max(start, c.span.offsetMs);
      const ce = Math.min(end, c.span.offsetMs + c.span.durationMs);
      return [cs, ce] as const;
    }),
  );
  return Math.max(0, node.span.durationMs - covered);
}

/**
 * Critical path: the chain of work that determined the end-to-end latency.
 *
 * Walking backwards from the end of a span, repeatedly pick the child that
 * finished last before the current cursor; that child is on the critical path
 * (descend into it), then move the cursor to that child's start. Gaps between
 * chosen children are the parent's own critical time. This is the same idea
 * Jaeger uses. Returns ms of critical-path time attributed to each span id.
 */
export function criticalPath<T extends TimedSpan>(roots: readonly TraceTreeNode<T>[]): Map<string, number> {
  const contribution = new Map<string, number>();
  const add = (id: string, ms: number) => {
    if (ms > 0) contribution.set(id, (contribution.get(id) ?? 0) + ms);
  };

  // Work items: compute the critical path of `node` within [node.start, bound].
  const stack: Array<{ node: TraceTreeNode<T>; bound: number }> = [];
  // Only the longest-ending root determines trace latency; still analyse all
  // roots so orphaned subtrees get a sensible answer too.
  for (const root of roots) {
    stack.push({ node: root, bound: root.span.offsetMs + root.span.durationMs });
  }

  while (stack.length > 0) {
    const { node, bound } = stack.pop()!;
    const start = node.span.offsetMs;
    let cursor = Math.min(bound, start + node.span.durationMs);
    // Children sorted by end time descending.
    const children = [...node.children].sort(
      (a, b) => b.span.offsetMs + b.span.durationMs - (a.span.offsetMs + a.span.durationMs),
    );
    for (const child of children) {
      if (cursor <= start) break;
      const childStart = Math.max(child.span.offsetMs, start);
      const childEnd = Math.min(child.span.offsetMs + child.span.durationMs, cursor);
      // Skip children that started after the cursor (already covered by a
      // later-finishing sibling) or that have no width inside the window.
      if (childStart >= cursor || childEnd <= childStart) continue;
      add(node.span.spanId, cursor - childEnd);
      stack.push({ node: child, bound: childEnd });
      cursor = childStart;
    }
    add(node.span.spanId, cursor - start);
  }
  return contribution;
}

/**
 * Sum self time per key (usually service name). Answers "where did this
 * request spend its time?" without double counting nested spans.
 */
export function selfTimeBreakdown<T extends TimedSpan>(
  tree: TraceTree<T>,
  keyOf: (span: T) => string,
): Array<{ key: string; selfMs: number }> {
  const totals = new Map<string, number>();
  for (const node of tree.byId.values()) {
    const key = keyOf(node.span);
    totals.set(key, (totals.get(key) ?? 0) + selfTimeMs(node));
  }
  return [...totals.entries()]
    .map(([key, selfMs]) => ({ key, selfMs }))
    .sort((a, b) => b.selfMs - a.selfMs);
}
