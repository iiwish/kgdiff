/**
 * Timings against the budgets in docs/architecture.md §Budgets (`pnpm bench`): buildScene,
 * 10k nodes < 50 ms; resolve per frame, 5k nodes / 10k edges < 4 ms. The assertions are
 * generous bounds that catch complexity regressions on any machine.
 */
import { expect, test, vi } from 'vitest';
import { buildScene, createViewState, createVisualResolver, type ViewState } from '../src/index.js';
import { type TourHunk, tourOrder } from '../src/timeline.js';
import { synthetic } from './fixtures.js';

vi.mock('@kgdiff/core', async (orig) => ({
  ...(await orig<object>()),
  formatHunk: (await import('./mock-core.js')).fakeFormatHunk,
}));

test('buildScene, 5k nodes / 10k edges', async ({ bench }) => {
  const { diff, layout } = synthetic(5000, 10_000);
  const result = await bench('5k / 10k', () => buildScene(diff, layout)).run();
  expect(result.latency.p50).toBeLessThan(100);
});

test('buildScene, 10k nodes / 30k edges (budget 50 ms)', async ({ bench }) => {
  const { diff, layout } = synthetic(10_000, 30_000, 11);
  const result = await bench('10k / 30k', () => buildScene(diff, layout)).run();
  expect(result.latency.p50).toBeLessThan(150);
});

test('resolve per frame with all four shapes, 5k nodes / 10k edges (budget 4 ms)', async ({
  bench,
}) => {
  const { diff, layout } = synthetic(5000, 10_000);
  const typed = {
    ...diff,
    nodes: diff.nodes.map((n, i) => ({ ...n, types: [`T${i % 4}`] })),
  } as typeof diff;
  const shapes = { T0: 'circle', T1: 'square', T2: 'diamond', T3: 'hexagon' } as const;
  const scene = buildScene(typed, layout, { shapes });
  const resolver = createVisualResolver(scene);
  const out = resolver.resolve(createViewState());
  const views = Array.from({ length: 120 }, (_, k) =>
    createViewState({ layer: 'replay', t: (k / 120) * scene.timeline.duration }),
  );
  let k = 0;
  const result = await bench('replay, mixed shapes', () => {
    resolver.resolve(views[k++ % 120] as ViewState, out);
  }).run();
  expect(result.latency.p50).toBeLessThan(16);
});

test('resolve per frame, 5k nodes / 10k edges (budget 4 ms)', async ({ bench }) => {
  const { diff, layout } = synthetic(5000, 10_000);
  const scene = buildScene(diff, layout);
  const resolver = createVisualResolver(scene);
  const out = resolver.resolve(createViewState());
  const cases: [string, (k: number) => Partial<ViewState>][] = [
    ['union', () => ({ layer: 'union' })],
    [
      'union + selection + filter',
      () => ({ layer: 'union', selectedHunk: 3, families: new Set(['added'] as const) }),
    ],
    ['after', () => ({ layer: 'after' })],
    ['replay (sweeping t)', (k) => ({ layer: 'replay', t: (k / 120) * scene.timeline.duration })],
    [
      'replay, reduced motion',
      (k) => ({ layer: 'replay', t: (k / 120) * scene.timeline.duration, reducedMotion: true }),
    ],
  ];
  for (const [name, view] of cases) {
    const views = Array.from({ length: 120 }, (_, k) => createViewState(view(k)));
    let k = 0;
    // `out` is passed back in, as hosts do at 60 fps: steady-state frames allocate nothing.
    const result = await bench(name, () =>
      resolver.resolve(views[k++ % 120] as ViewState, out),
    ).run();
    expect(result.latency.p50, name).toBeLessThan(25);
  }
});

test('tourOrder, thousands of hunks', async ({ bench }) => {
  const { diff, layout } = synthetic(20_000, 20_000, 3);
  const items: TourHunk[] = diff.hunks.map((h) => {
    const p = layout.positions.get(h.anchor) ?? { x: 0, y: 0 };
    return {
      phase: h.phase,
      size: h.nodes.length + h.edges.length,
      order: h.order,
      x: p.x,
      y: p.y,
      requires: [],
    };
  });
  const result = await bench(`${items.length} hunks`, () => tourOrder(items)).run({
    iterations: 5,
    time: 0,
    warmupIterations: 1,
    warmupTime: 0,
  });
  expect(result.latency.p50).toBeLessThan(500);
});
