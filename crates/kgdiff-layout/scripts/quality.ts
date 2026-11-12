/**
 * Layout quality of the Rust engine against the TypeScript baseline (RFC 0002, phase 4,
 * "Quality"): for the six example datasets, the corpus's synthetic case and synthetic graphs up
 * to 10k nodes (scripts/gen-synthetic.ts), both layouts of the same diff and five metrics of
 * each. Every metric must be within 10% of TypeScript's, or better.
 *
 *   cargo build --release -p kgdiff-layout --example layout
 *   pnpm tsx crates/kgdiff-layout/scripts/quality.ts [--out report.md] [--review dir] [--quick]
 *
 * `--quick` leaves out the synthetic graphs (a minute of the run).
 *
 * Metrics (computed the same way for both layouts, from their layout documents):
 *   - edge: mean length of the laid-out links (node pairs linked in either version) ÷ 56, the
 *     default `linkDistance`; within ±10%;
 *   - stress: normalized stress over graph distances — Σ (α·‖xᵢ − xⱼ‖ / dᵢⱼ − 1)² / pairs with
 *     dᵢⱼ the hop distance × 56 and α the scale that minimizes it, over all pairs of a component
 *     (pairs from 200 seeded sources above 1,500 nodes); lower is better;
 *   - crossings: pairs of links that cross (no shared endpoint); lower is better;
 *   - aspect: bounds width ÷ height; within ±10%;
 *   - partners: mean distance between merge sources / split targets and their partner ÷ 56;
 *     lower is better.
 *
 * `--review <dir>` writes both layouts of the six datasets side by side, one SVG per dataset and an
 * HTML page with all of them (`review.html`).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { DiffResult, GraphInput } from '../../../packages/core/src/index.js';
import { diff } from '../../../packages/core/src/sync.js';
import {
  type LayoutJSON,
  type LayoutOptions,
  layoutToJSON,
} from '../../../packages/layout/src/index.js';
import { layoutDiff } from '../../../packages/layout/src/sync.js';

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '../../..');
const RUST = join(ROOT, 'target/release/examples/layout');
const L = 56;
const TOLERANCE = 0.1;

interface Workload {
  readonly name: string;
  readonly before: GraphInput;
  readonly after: GraphInput;
  readonly options: Record<string, unknown>;
  readonly layoutOptions: LayoutOptions;
  readonly review?: boolean;
}

function readJSON(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function corpusCase(id: string, review: boolean): Workload {
  const dir = join(ROOT, 'conformance/cases', id);
  const spec = readJSON(join(dir, 'case.json')) as {
    options?: Record<string, unknown>;
    layoutOptions?: LayoutOptions;
  };
  const graph = (side: string) =>
    (readJSON(join(dir, `expected/parse.${side}.json`)) as { graph: GraphInput }).graph;
  return {
    name: id,
    before: graph('before'),
    after: graph('after'),
    options: spec.options ?? {},
    layoutOptions: spec.layoutOptions ?? {},
    review,
  };
}

function synthetic(nodes: number, layoutOptions: LayoutOptions = {}): Workload {
  const dir = mkdtempSync(join(tmpdir(), 'kgdiff-quality-'));
  try {
    execFileSync(
      process.execPath,
      [
        '--import',
        'tsx/esm',
        join(ROOT, 'scripts/gen-synthetic.ts'),
        '--nodes',
        String(nodes),
        '--seed',
        '7',
        '--out',
        dir,
      ],
      { stdio: 'ignore', cwd: ROOT },
    );
    const read = (name: string) => readJSON(join(dir, name)) as GraphInput;
    const scope = layoutOptions.scope === undefined ? '' : ` (scope ${layoutOptions.scope})`;
    return {
      name: `synth-${nodes / 1000}k${scope}`,
      before: read('before.json'),
      after: read('after.json'),
      options: {},
      layoutOptions,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The Rust layout of the same two graphs, through `examples/layout.rs --job`. */
function rustLayout(w: Workload, dir: string): { json: LayoutJSON; ms: number } {
  const job = join(dir, 'job.json');
  writeFileSync(
    job,
    JSON.stringify({
      before: w.before,
      after: w.after,
      options: w.options,
      layoutOptions: w.layoutOptions,
    }),
  );
  const started = performance.now();
  const out = execFileSync(RUST, ['--job', job], { encoding: 'utf8', maxBuffer: 1 << 30 });
  return { json: JSON.parse(out) as LayoutJSON, ms: performance.now() - started };
}

// ─── Metrics ────────────────────────────────────────────────────────────────

type Pos = Readonly<Record<string, readonly [number, number]>>;

/** Laid-out links: node pairs linked in either version (as the layout links them). */
function links(result: DiffResult, positions: Pos): [string, string][] {
  const seen = new Set<string>();
  const out: [string, string][] = [];
  const add = (a: string, b: string): void => {
    if (a === b || positions[a] === undefined || positions[b] === undefined) return;
    const key = a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(a < b ? [a, b] : [b, a]);
  };
  for (const e of result.edges) {
    add(e.source, e.target);
    add(e.sourceBefore ?? e.source, e.targetBefore ?? e.target);
  }
  return out;
}

const dist = (p: readonly [number, number], q: readonly [number, number]): number =>
  Math.sqrt((p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2);

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function stress(ids: readonly string[], adj: Map<string, string[]>, positions: Pos): number {
  const sources =
    ids.length <= 1500
      ? ids
      : (() => {
          const random = mulberry32(1);
          const picked = new Set<string>();
          while (picked.size < 200) picked.add(ids[Math.floor(random() * ids.length)]!);
          return [...picked].sort();
        })();
  // Σ (α r/d − 1)² is minimal at α = Σ(r/d) / Σ(r/d)².
  let sum = 0;
  let sum2 = 0;
  const ratios: number[] = [];
  for (const s of sources) {
    const depth = new Map<string, number>([[s, 0]]);
    let frontier = [s];
    while (frontier.length > 0) {
      const next: string[] = [];
      for (const u of frontier) {
        for (const v of adj.get(u) ?? []) {
          if (depth.has(v)) continue;
          depth.set(v, depth.get(u)! + 1);
          next.push(v);
        }
      }
      frontier = next;
    }
    for (const [t, hops] of depth) {
      if (t === s) continue;
      const ratio = dist(positions[s]!, positions[t]!) / (hops * L);
      ratios.push(ratio);
      sum += ratio;
      sum2 += ratio * ratio;
    }
  }
  if (ratios.length === 0 || sum2 === 0) return 0;
  const alpha = sum / sum2;
  let total = 0;
  for (const r of ratios) total += (alpha * r - 1) ** 2;
  return total / ratios.length;
}

function crossings(segments: [string, string][], positions: Pos): number {
  if (segments.length < 2) return 0;
  const lengths = segments
    .map(([a, b]) => dist(positions[a]!, positions[b]!))
    .sort((x, y) => x - y);
  const cell = Math.max(1, lengths[Math.floor(lengths.length / 2)]! * 2);
  const grid = new Map<string, number[]>();
  const range = segments.map(([a, b]) => {
    const p = positions[a]!;
    const q = positions[b]!;
    return [
      Math.floor(Math.min(p[0], q[0]) / cell),
      Math.floor(Math.min(p[1], q[1]) / cell),
      Math.floor(Math.max(p[0], q[0]) / cell),
      Math.floor(Math.max(p[1], q[1]) / cell),
    ] as const;
  });
  range.forEach(([x0, y0, x1, y1], k) => {
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const key = `${x},${y}`;
        const list = grid.get(key);
        if (list === undefined) grid.set(key, [k]);
        else list.push(k);
      }
    }
  });
  const orient = (p: readonly number[], q: readonly number[], r: readonly number[]): number =>
    Math.sign((q[0]! - p[0]!) * (r[1]! - p[1]!) - (q[1]! - p[1]!) * (r[0]! - p[0]!));
  let count = 0;
  for (const [key, list] of grid) {
    const [cx, cy] = key.split(',').map(Number) as [number, number];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const s = list[i]!;
        const t = list[j]!;
        // Each pair once: in the first cell both bounding boxes cover.
        const [sx, sy] = range[s]!;
        const [tx, ty] = range[t]!;
        if (Math.max(sx, tx) !== cx || Math.max(sy, ty) !== cy) continue;
        const [a, b] = segments[s]!;
        const [c, d] = segments[t]!;
        if (a === c || a === d || b === c || b === d) continue;
        const [pa, pb, pc, pd] = [positions[a]!, positions[b]!, positions[c]!, positions[d]!];
        if (
          orient(pa, pb, pc) * orient(pa, pb, pd) < 0 &&
          orient(pc, pd, pa) * orient(pc, pd, pb) < 0
        ) {
          count++;
        }
      }
    }
  }
  return count;
}

interface Metrics {
  readonly nodes: number;
  readonly edge: number;
  readonly stress: number;
  readonly crossings: number;
  readonly aspect: number;
  readonly partners: number | undefined;
}

function metrics(result: DiffResult, json: LayoutJSON): Metrics {
  const positions = json.positions;
  const ids = Object.keys(positions).sort();
  const segments = links(result, positions);
  const adj = new Map<string, string[]>();
  for (const [a, b] of segments) {
    if (!adj.has(a)) adj.set(a, []);
    if (!adj.has(b)) adj.set(b, []);
    adj.get(a)!.push(b);
    adj.get(b)!.push(a);
  }
  const edge =
    segments.length === 0
      ? 0
      : segments.reduce((s, [a, b]) => s + dist(positions[a]!, positions[b]!), 0) /
        segments.length /
        L;
  const partners: number[] = [];
  for (const node of result.nodes) {
    for (const f of node.facets) {
      const other =
        f.kind === 'mergedInto' ? f.target : f.kind === 'splitFrom' ? f.source : undefined;
      if (other === undefined || !positions[node.id] || !positions[other]) continue;
      partners.push(dist(positions[node.id]!, positions[other]!) / L);
    }
  }
  return {
    nodes: ids.length,
    edge,
    stress: stress(ids, adj, positions),
    crossings: crossings(segments, positions),
    aspect: json.bounds.height > 0 ? json.bounds.width / json.bounds.height : 0,
    partners: partners.length ? partners.reduce((a, b) => a + b, 0) / partners.length : undefined,
  };
}

/** Rust's value against TypeScript's: within ±10% (two-sided) or at most 10% worse (lower is better). */
function verdict(rust: number, ts: number, twoSided: boolean): boolean {
  const slack = TOLERANCE * Math.abs(ts) + 1e-9;
  return twoSided ? Math.abs(rust - ts) <= slack : rust <= ts + slack;
}

// ─── Review page ────────────────────────────────────────────────────────────

const STATUS_COLOR: Record<string, string> = {
  added: '#2f9e44',
  removed: '#e03131',
  modified: '#f08c00',
  unchanged: '#868e96',
};

const escapeXml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** One layout as SVG elements, translated so that its bounds start at (dx, dy). */
function drawing(result: DiffResult, json: LayoutJSON, dx: number, dy: number): string {
  const b = json.bounds;
  const edges: string[] = [];
  for (const [a, c] of links(result, json.positions)) {
    const p = json.positions[a]!;
    const q = json.positions[c]!;
    edges.push(`<line x1="${p[0]}" y1="${p[1]}" x2="${q[0]}" y2="${q[1]}"/>`);
  }
  const nodes: string[] = [];
  for (const [id, [x, y]] of Object.entries(json.positions)) {
    const node = result.index.node(id);
    const r = json.radii[id] ?? 4;
    const color = STATUS_COLOR[node?.status ?? 'unchanged'];
    nodes.push(
      `<circle cx="${x}" cy="${y}" r="${r}" fill="${color}"/>` +
        `<text x="${x}" y="${y + r + 5 + 10}">${escapeXml(node?.label ?? id)}</text>`,
    );
  }
  return (
    `<g transform="translate(${dx - b.x} ${dy - b.y})">` +
    `<g stroke="#adb5bd" stroke-width="1">${edges.join('')}</g>` +
    `<g font-family="system-ui, sans-serif" font-size="10" text-anchor="middle" fill="#343a40">${nodes.join('')}</g></g>`
  );
}

/** Both layouts side by side in one SVG, captioned. */
function pairSvg(result: DiffResult, ts: LayoutJSON, rust: LayoutJSON, name: string): string {
  const pad = 24;
  const head = 40;
  const w = ts.bounds.width + rust.bounds.width + 3 * pad;
  const h = Math.max(ts.bounds.height, rust.bounds.height) + head + 2 * pad;
  const caption = (x: number, text: string) =>
    `<text x="${x}" y="${pad + 8}" font-family="system-ui, sans-serif" font-size="16" font-weight="600" fill="#212529">${escapeXml(text)}</text>`;
  const rx = ts.bounds.width + 2 * pad;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">` +
    `<rect width="${w}" height="${h}" fill="#fff"/>` +
    caption(pad, `${name}: TypeScript (@kgdiff/layout)`) +
    caption(rx, `Rust (${(rust as { generator?: string }).generator ?? 'kgdiff-layout'})`) +
    `<line x1="${rx - pad / 2}" y1="${pad}" x2="${rx - pad / 2}" y2="${h - pad}" stroke="#dee2e6"/>` +
    drawing(result, ts, pad, head + pad) +
    drawing(result, rust, rx, head + pad) +
    '</svg>'
  );
}

function reviewPage(sections: string[]): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Layout review</title>
<style>
body { font: 14px system-ui, sans-serif; margin: 16px; background: #fff; color: #212529; }
section { margin-bottom: 32px; } h2 { font-size: 16px; }
svg { width: 100%; height: auto; border: 1px solid #dee2e6; border-radius: 6px; }
</style></head><body>
<h1>kgdiff layout review: TypeScript (left) and Rust (right)</h1>
<p>Both layouts of the same diff, from <code>layoutToJSON</code> (TypeScript) and
<code>layout_to_json</code> (kgdiff-layout). Nodes are coloured by status.</p>
${sections.join('\n')}
</body></html>`;
}

// ─── Main ───────────────────────────────────────────────────────────────────

const { values } = parseArgs({
  options: { out: { type: 'string' }, review: { type: 'string' }, quick: { type: 'boolean' } },
});
if (values.review) mkdirSync(values.review, { recursive: true });

const workloads: Workload[] = [
  ...[
    'dataset-enterprise-kg',
    'dataset-enterprise-kg-en',
    'dataset-ontology-release',
    'dataset-llm-extraction',
    'dataset-data-lineage',
    'dataset-schema-vocab',
  ].map((id) => corpusCase(id, true)),
  corpusCase('synthetic-600', false),
  ...(values.quick
    ? []
    : [
        synthetic(1000),
        synthetic(2000),
        synthetic(5000),
        synthetic(10_000),
        synthetic(5000, { scope: 'all' }),
        synthetic(10_000, { scope: 'all' }),
      ]),
];

const scratch = mkdtempSync(join(tmpdir(), 'kgdiff-quality-'));
const rows: string[] = [];
const sections: string[] = [];
let failures = 0;
let identical = 0;
const fmt = (v: number | undefined, digits = 3): string =>
  v === undefined ? '–' : Number.isInteger(v) ? String(v) : v.toFixed(digits);
try {
  for (const w of workloads) {
    const result = diff(w.before, w.after, w.options);
    const started = performance.now();
    const ts = layoutToJSON(layoutDiff(result, w.layoutOptions));
    const tsMs = performance.now() - started;
    const rust = rustLayout(w, scratch);
    const same = JSON.stringify(ts.positions) === JSON.stringify(rust.json.positions);
    if (same) identical++;
    const a = metrics(result, ts);
    const b = metrics(result, rust.json);
    const checks: [string, number | undefined, number | undefined, boolean][] = [
      ['edge', a.edge, b.edge, true],
      ['stress', a.stress, b.stress, false],
      ['crossings', a.crossings, b.crossings, false],
      ['aspect', a.aspect, b.aspect, true],
      ['partners', a.partners, b.partners, false],
    ];
    const cells = checks.map(([, t, r, twoSided]) => {
      if (t === undefined || r === undefined) return '–';
      const ok = verdict(r, t, twoSided);
      if (!ok) failures++;
      return `${fmt(t)} / ${fmt(r)}${ok ? '' : ' ✗'}`;
    });
    rows.push(
      `| ${w.name} | ${a.nodes} | ${cells.join(' | ')} | ${same ? 'yes' : 'no'} | ${tsMs.toFixed(0)} / ${rust.ms.toFixed(0)} |`,
    );
    console.info(rows[rows.length - 1]);
    if (w.review && values.review) {
      const picture = pairSvg(result, ts, rust.json, w.name);
      writeFileSync(join(values.review, `${w.name}.svg`), picture);
      sections.push(`<section><h2>${w.name} (${a.nodes} nodes)</h2>${picture}</section>`);
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

const report = [
  '| workload | nodes | edge ÷ L (TS / Rust) | stress | crossings | aspect | partners ÷ L | same positions | ms (TS / Rust process) |',
  '| --- | --: | --: | --: | --: | --: | --: | :-: | --: |',
  ...rows,
  '',
  `${identical} of ${workloads.length} workloads have bit-identical positions; ${failures} metric(s) outside the 10% tolerance.`,
].join('\n');
console.info(`\n${report}`);
if (values.out) writeFileSync(values.out, `${report}\n`);
if (values.review) writeFileSync(join(values.review, 'review.html'), reviewPage(sections));
process.exitCode = failures === 0 ? 0 : 1;
