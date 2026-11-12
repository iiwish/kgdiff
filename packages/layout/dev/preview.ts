/**
 * Writes SVG previews of the test fixtures so a human can eyeball layout quality.
 *
 *   pnpm tsx --tsconfig packages/layout/tsconfig.json packages/layout/dev/preview.ts [outDir] [--boxes]
 *
 * One SVG per fixture (plus anchored / extend variants) and a metrics table on stdout.
 * `--boxes` outlines the reserved label boxes.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DiffResult, Point, UnionId } from '@kgdiff/core';
import type { LayoutResult } from '../src/index.js';
import { LABEL_GAP, labelBox } from '../src/label-box.js';
import { extendLayout, layoutDiff } from '../src/sync.js';
import { makeDiff } from '../test/support/diff-builder.js';
import { FIXTURES, scaleFree } from '../test/support/fixtures.js';
import { quality } from '../test/support/metrics.js';

const args = process.argv.slice(2);
const outDir = args.find((a) => !a.startsWith('--')) ?? join(tmpdir(), 'kgdiff-layout-preview');
const showBoxes = args.includes('--boxes');
mkdirSync(outDir, { recursive: true });

const COLORS: Record<string, string> = {
  unchanged: '#A7B0BF',
  added: '#16A34A',
  removed: '#DC2626',
  modified: '#D97706',
  identity: '#7C3AED',
};

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function svg(diff: DiffResult, layout: LayoutResult, title: string): string {
  const pad = 40;
  const b = layout.bounds;
  const out: string[] = [];
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${b.x - pad} ${b.y - pad - 24} ${b.width + 2 * pad} ${b.height + 2 * pad + 24}" font-family="Inter, PingFang SC, sans-serif">`,
    `<rect x="${b.x - pad}" y="${b.y - pad - 24}" width="${b.width + 2 * pad}" height="${b.height + 2 * pad + 24}" fill="#F7F8FA"/>`,
    `<text x="${b.x - pad + 8}" y="${b.y - pad - 6}" font-size="14" fill="#475569">${esc(title)}</text>`,
  );
  const pos = (id: UnionId): Point | undefined => layout.positions.get(id);
  for (const e of diff.edges) {
    const s = pos(e.source);
    const t = pos(e.target);
    const color = e.status === 'unchanged' ? '#D3D9E2' : COLORS[e.status]!;
    if (s && t) {
      const dash = e.status === 'removed' ? ' stroke-dasharray="4 3"' : '';
      out.push(
        `<line x1="${s.x}" y1="${s.y}" x2="${t.x}" y2="${t.y}" stroke="${color}" stroke-width="1.2"${dash}/>`,
      );
    }
    if (e.sourceBefore !== undefined || e.targetBefore !== undefined) {
      const sb = pos(e.sourceBefore ?? e.source);
      const tb = pos(e.targetBefore ?? e.target);
      if (sb && tb) {
        out.push(
          `<line x1="${sb.x}" y1="${sb.y}" x2="${tb.x}" y2="${tb.y}" stroke="#DC2626" stroke-opacity="0.45" stroke-width="1" stroke-dasharray="4 3"/>`,
        );
      }
    }
  }
  for (const node of diff.nodes) {
    const p = pos(node.id);
    if (!p) continue;
    const r = layout.radii.get(node.id)!;
    const identity = node.facets.some((f) =>
      ['mergedInto', 'mergeTarget', 'splitFrom', 'splitInto'].includes(f.kind),
    );
    const color = identity ? COLORS.identity! : COLORS[node.status]!;
    const ghost = node.status === 'removed';
    out.push(
      `<circle cx="${p.x}" cy="${p.y}" r="${r}" fill="${ghost ? 'none' : color}" stroke="${color}" stroke-width="1.25"${ghost ? ' stroke-dasharray="3 2.5"' : ''}/>`,
    );
    const rename = node.facets.find((f) => f.kind === 'rename');
    const before = rename?.kind === 'rename' ? rename.from : undefined;
    const box = labelBox(node.label, before, 12);
    const top = p.y + r + LABEL_GAP;
    if (showBoxes) {
      out.push(
        `<rect x="${p.x - box.width / 2}" y="${top}" width="${box.width}" height="${box.height}" fill="none" stroke="#3B5BDB" stroke-opacity="0.35" stroke-width="0.6"/>`,
      );
    }
    const weight = node.status === 'unchanged' ? 400 : 600;
    const fill = node.status === 'unchanged' ? '#5F6B7D' : '#0F172A';
    out.push(
      `<text x="${p.x}" y="${top + 11.5}" font-size="12" font-weight="${weight}" fill="${fill}" text-anchor="middle"${ghost ? ' text-decoration="line-through"' : ''}>${esc(node.label)}</text>`,
    );
    if (before !== undefined) {
      out.push(
        `<text x="${p.x}" y="${top + 11.5 + 14}" font-size="11" fill="#7B8597" text-anchor="middle" text-decoration="line-through">${esc(before)}</text>`,
      );
    }
  }
  for (const [id, count] of layout.hidden) {
    const p = pos(id);
    if (p)
      out.push(
        `<text x="${p.x + 10}" y="${p.y - 8}" font-size="10" fill="#7B8597">+${count}</text>`,
      );
  }
  out.push('</svg>');
  return out.join('\n');
}

const rows: string[] = [];
const fmt = (n: number, d = 2): string => (Number.isFinite(n) ? n.toFixed(d) : String(n));

function emit(name: string, diff: DiffResult, layout: LayoutResult): void {
  const q = quality(diff, layout);
  writeFileSync(
    join(outDir, `${name}.svg`),
    svg(diff, layout, `${name} — ${layout.stats.ms.toFixed(0)} ms`),
  );
  const ratios = q.partnerRatios.length ? fmt(Math.max(...q.partnerRatios)) : '-';
  rows.push(
    [
      name.padEnd(18),
      String(q.nodes).padStart(5),
      `${fmt(layout.stats.ms, 0)}ms`.padStart(7),
      fmt(q.minClearance).padStart(7),
      fmt(q.labelOverlapRatio, 4).padStart(7),
      String(q.overlappingPairs).padStart(5),
      fmt(q.meanEdgeLength / 56).padStart(6),
      String(q.componentOverlaps).padStart(4),
      ratios.padStart(6),
      fmt(q.aspect).padStart(6),
    ].join(' '),
  );
}

for (const [name, make] of Object.entries(FIXTURES)) {
  const diff = makeDiff(make());
  emit(name, diff, layoutDiff(diff));
}

// Anchored: the after graph grows by a few nodes; known positions come from the first layout.
{
  const base = scaleFree(200);
  const first = makeDiff(base);
  const firstLayout = layoutDiff(first);
  const grown = {
    nodes: [
      ...base.nodes.map((n) => ({ ...n, beforePosition: firstLayout.positions.get(n.id) })),
      ...['x1', 'x2', 'x3', 'x4', 'x5'].map((id) => ({
        id,
        label: `New ${id}`,
        status: 'added' as const,
      })),
    ],
    edges: [
      ...base.edges,
      { source: 'x1', target: 's0000', status: 'added' as const },
      { source: 'x2', target: 's0000', status: 'added' as const },
      { source: 'x3', target: 's0042', status: 'added' as const },
      { source: 'x4', target: 'x3', status: 'added' as const },
      { source: 'x5', target: 's0150', status: 'added' as const },
    ],
  };
  const diff = makeDiff(grown);
  emit('anchored-before', first, firstLayout);
  emit('anchored-after', diff, layoutDiff(diff));
}

// Scope `changes` + extend.
{
  const diff = makeDiff(FIXTURES.changes());
  const scoped = layoutDiff(diff, { scope: 'changes' });
  emit('changes-scoped', diff, scoped);
  const expand = [...scoped.hidden.keys()].slice(0, 3);
  const extra = diff.edges
    .flatMap((e) => [e.source, e.target])
    .filter(
      (id) =>
        !scoped.positions.has(id) &&
        expand.some((x) => diff.index.edgesOf(x).some((e) => e.source === id || e.target === id)),
    );
  emit('changes-extended', diff, extendLayout(diff, scoped, [...new Set(extra)]));
}

{
  const diff = makeDiff(scaleFree(2000, 1.3));
  emit('large-2000', diff, layoutDiff(diff));
}

console.log(`previews → ${outDir}`);
console.log('fixture            nodes    time  clear  overlap pairs  edge/L comp  merge aspect');
for (const row of rows) console.log(row);
