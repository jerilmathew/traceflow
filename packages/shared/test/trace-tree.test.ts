import { describe, expect, it } from 'vitest';
import {
  buildTraceTree,
  criticalPath,
  flattenTree,
  selfTimeBreakdown,
  selfTimeMs,
  unionLength,
  type TimedSpan,
} from '../src/trace-tree';

interface S extends TimedSpan {
  service: string;
}

const span = (
  spanId: string,
  parentSpanId: string | null,
  offsetMs: number,
  durationMs: number,
  service = 'svc',
): S => ({ spanId, parentSpanId, offsetMs, durationMs, service });

/**
 * POST /checkout                  0 ──────────────── 480
 * ├── GET /users/:id              10 ── 90
 * ├── POST /reservations          100 ─────── 310
 * │   └── SELECT inventory        120 ───── 260
 * └── payment.authorize           320 ──── 410
 */
const checkout = [
  span('root', null, 0, 480, 'gateway'),
  span('users', 'root', 10, 80, 'users'),
  span('inv', 'root', 100, 210, 'inventory'),
  span('db', 'inv', 120, 140, 'inventory'),
  span('pay', 'root', 320, 90, 'gateway'),
];

describe('buildTraceTree', () => {
  it('reconstructs parent-child structure regardless of input order', () => {
    const shuffled = [checkout[3]!, checkout[0]!, checkout[4]!, checkout[2]!, checkout[1]!];
    const tree = buildTraceTree(shuffled);
    expect(tree.roots.map((r) => r.span.spanId)).toEqual(['root']);
    const root = tree.roots[0]!;
    // children are ordered by start time
    expect(root.children.map((c) => c.span.spanId)).toEqual(['users', 'inv', 'pay']);
    expect(tree.byId.get('db')!.depth).toBe(2);
    expect(tree.maxDepth).toBe(2);
    expect(tree.orphanCount).toBe(0);
  });

  it('flags spans whose parent has not arrived as orphan roots', () => {
    const tree = buildTraceTree([
      span('child', 'missing-parent', 50, 10),
      span('root', null, 0, 100),
    ]);
    expect(tree.roots.map((r) => r.span.spanId)).toEqual(['root', 'child']);
    expect(tree.byId.get('child')!.orphan).toBe(true);
    expect(tree.orphanCount).toBe(1);
  });

  it('breaks parent cycles instead of dropping or looping forever', () => {
    const tree = buildTraceTree([
      span('a', 'b', 0, 10),
      span('b', 'a', 1, 5),
      span('self', 'self', 2, 1),
    ]);
    const allIds = flattenTree(tree.roots).map((r) => r.node.span.spanId);
    expect(allIds.sort()).toEqual(['a', 'b', 'self']);
    expect(tree.byId.get('self')!.cycleBroken).toBe(true);
    expect([...tree.byId.values()].some((n) => n.span.spanId !== 'self' && n.cycleBroken)).toBe(
      true,
    );
  });

  it('keeps the first copy of duplicated span ids', () => {
    const tree = buildTraceTree([span('a', null, 0, 10), span('a', null, 0, 999)]);
    expect(tree.byId.size).toBe(1);
    expect(tree.byId.get('a')!.span.durationMs).toBe(10);
  });

  it('handles very deep traces without recursion', () => {
    const deep: S[] = [span('s0', null, 0, 100_000)];
    for (let i = 1; i < 20_000; i++) deep.push(span(`s${i}`, `s${i - 1}`, i, 100_000 - i * 2));
    const tree = buildTraceTree(deep);
    expect(tree.maxDepth).toBe(19_999);
    expect(flattenTree(tree.roots)).toHaveLength(20_000);
  });
});

describe('flattenTree', () => {
  it('emits pre-order rows and hides collapsed subtrees', () => {
    const tree = buildTraceTree(checkout);
    expect(flattenTree(tree.roots).map((r) => r.node.span.spanId)).toEqual([
      'root',
      'users',
      'inv',
      'db',
      'pay',
    ]);
    const collapsed = flattenTree(tree.roots, new Set(['inv']));
    expect(collapsed.map((r) => r.node.span.spanId)).toEqual(['root', 'users', 'inv', 'pay']);
    expect(collapsed.find((r) => r.node.span.spanId === 'inv')!.collapsed).toBe(true);
  });
});

describe('timing analysis', () => {
  it('computes interval unions', () => {
    expect(unionLength([])).toBe(0);
    expect(
      unionLength([
        [0, 10],
        [5, 15],
        [20, 30],
      ]),
    ).toBe(25);
    expect(
      unionLength([
        [0, 10],
        [2, 3],
      ]),
    ).toBe(10);
  });

  it('computes self time excluding (overlapping) children', () => {
    const tree = buildTraceTree(checkout);
    // 480 - (80 + 210 + 90)
    expect(selfTimeMs(tree.byId.get('root')!)).toBe(100);
    expect(selfTimeMs(tree.byId.get('inv')!)).toBe(70);
    expect(selfTimeMs(tree.byId.get('db')!)).toBe(140);

    const parallel = buildTraceTree([
      span('p', null, 0, 100),
      span('c1', 'p', 10, 50),
      span('c2', 'p', 30, 50), // overlaps c1 → covered = [10, 80)
      span('late', 'p', 90, 100), // outlives parent → clipped to [90, 100)
    ]);
    expect(selfTimeMs(parallel.byId.get('p')!)).toBe(100 - 70 - 10);
  });

  it('attributes self time per service', () => {
    const tree = buildTraceTree(checkout);
    const breakdown = selfTimeBreakdown(tree, (s) => s.service);
    expect(breakdown).toEqual([
      { key: 'inventory', selfMs: 210 },
      { key: 'gateway', selfMs: 190 },
      { key: 'users', selfMs: 80 },
    ]);
    // Self times partition the root duration exactly when children nest cleanly.
    expect(breakdown.reduce((sum, b) => sum + b.selfMs, 0)).toBe(480);
  });

  it('finds the critical path through sequential children', () => {
    const tree = buildTraceTree(checkout);
    const cp = criticalPath(tree.roots);
    expect(cp.get('db')).toBe(140);
    expect(cp.get('inv')).toBe(70);
    expect(cp.get('users')).toBe(80);
    expect(cp.get('pay')).toBe(90);
    const total = [...cp.values()].reduce((a, b) => a + b, 0);
    expect(total).toBe(480);
  });

  it('only follows the slower branch of concurrent children', () => {
    const tree = buildTraceTree([
      span('p', null, 0, 100),
      span('fast', 'p', 10, 20),
      span('slow', 'p', 10, 80),
    ]);
    const cp = criticalPath(tree.roots);
    expect(cp.get('slow')).toBe(80);
    expect(cp.has('fast')).toBe(false);
    expect(cp.get('p')).toBe(20);
  });
});
