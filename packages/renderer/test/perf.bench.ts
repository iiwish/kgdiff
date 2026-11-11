/**
 * Timings of per-frame hot paths (`pnpm bench`). The bounds are generous: they catch accidental
 * O(n²) and allocation storms, not micro-regressions. Real draw times are measured in the dev
 * harness; what these paths produce is tested in perf.test.ts and labels.test.ts.
 */
import { expect, test } from 'vitest';
import { createSynthetic } from '../dev/synthetic.js';
import { darkTheme } from '../dev/theme.js';
import { FrameCache, Interner } from '../src/frame-cache.js';
import {
  CollisionGrid,
  createRequest,
  type LabelRequest,
  MODE_NODE,
  placeLabels,
} from '../src/labels.js';
import { pickAt } from '../src/pick.js';
import { Fonts, TextMeasurer } from '../src/text.js';
import { RecordingContext } from './helpers/recording-ctx.js';

const big = createSynthetic(darkTheme, 10_000);

test('FrameCache.sync: style buckets for 10k nodes / 12.7k edges (every setFrame)', async ({
  bench,
}) => {
  const cache = new FrameCache();
  const interner = new Interner();
  let version = 0;
  const result = await bench('sync', () => cache.sync(big.frame, ++version, interner)).run();
  expect(result.latency.p50).toBeLessThan(15);
});

const SHAPES = ['circle', 'square', 'diamond', 'hexagon'] as const;
const mixed = createSynthetic(darkTheme, 10_000);
mixed.frame.nodes.forEach((n, i) => {
  n.shape = SHAPES[i % 4] as (typeof SHAPES)[number];
});

test('FrameCache.sync with all four shapes: 10k nodes / 12.7k edges', async ({ bench }) => {
  const cache = new FrameCache();
  const interner = new Interner();
  let version = 0;
  const result = await bench('sync', () => cache.sync(mixed.frame, ++version, interner)).run();
  expect(result.latency.p50).toBeLessThan(15);
});

test('pickAt with all four shapes: 10k nodes / 12.7k edges', async ({ bench }) => {
  const cache = new FrameCache();
  cache.sync(mixed.frame, 1, new Interner());
  const fonts = new Fonts(darkTheme);
  const measurer = new TextMeasurer(new RecordingContext());
  cache.nodeGrid();
  let i = 0;
  const result = await bench('pick', () => {
    i++;
    pickAt(
      mixed.frame,
      cache,
      { k: 1, ox: 400, oy: 300, dpr: 1 },
      (i * 37) % 800,
      (i * 53) % 600,
      fonts,
      measurer,
    );
  }).run();
  expect(result.latency.p50).toBeLessThan(1);
});

test('pickAt: node grid + edge scan at 10k nodes / 12.7k edges', async ({ bench }) => {
  const cache = new FrameCache();
  cache.sync(big.frame, 1, new Interner());
  const fonts = new Fonts(darkTheme);
  const measurer = new TextMeasurer(new RecordingContext());
  cache.nodeGrid();
  let i = 0;
  const result = await bench('pick', () => {
    i++;
    pickAt(
      big.frame,
      cache,
      { k: 1, ox: 400, oy: 300, dpr: 1 },
      (i * 37) % 800,
      (i * 53) % 600,
      fonts,
      measurer,
    );
  }).run();
  expect(result.latency.p50).toBeLessThan(1);
});

test('placeLabels: 5,000 labels (scales linearly, well under a frame)', async ({ bench }) => {
  const clip = { x0: 0, y0: 0, x1: 1000, y1: 800, strictX: false, strictY: false };
  const items: LabelRequest[] = [];
  for (let i = 0; i < 5000; i++) {
    items.push(
      Object.assign(createRequest(), {
        x: (i * 37) % 1000,
        y: (i * 53) % 800,
        r: 6,
        w: 60,
        h: 16,
        offset: 5,
        priority: (i % 7) / 7,
        mode: MODE_NODE,
        order: i,
      }),
    );
  }
  const grid = new CollisionGrid();
  const result = await bench('place 5k', () => {
    grid.reset(-200, -200, 1400, 1200);
    placeLabels(items, grid, clip);
  }).run();
  expect(result.latency.p50).toBeLessThan(60);
});
