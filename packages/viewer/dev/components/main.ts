/// <reference types="vite/client" />
/**
 * Dev harness page for the composed elements (RFC 0001 §3): a layout with every region placed
 * by the page and a host card in the stage's `top-end` slot (A), a replay-only root (B) and its
 * change list and search elsewhere on the page through `for` (C). `window.kgdiff.underCard()`
 * counts the nodes drawn under the card, which fits and flights keep clear.
 */
import type { GraphInput } from '@kgdiff/core';
import '@kgdiff/viewer';
import type { ViewerController } from '../../src/controller.js';

const files = import.meta.glob<string>('../../../../examples/datasets/enterprise-kg/*.json', {
  query: '?raw',
  import: 'default',
});

async function graph(side: 'before' | 'after'): Promise<GraphInput> {
  const load = files[`../../../../examples/datasets/enterprise-kg/${side}.json`];
  if (!load) throw new Error(`missing ${side}.json`);
  return JSON.parse(await load()) as GraphInput;
}

type Root = HTMLElement & {
  controller: ViewerController;
  load(options: object): Promise<void>;
};

const roots = [...document.querySelectorAll<Root>('kgdiff-root')];
const [before, after] = await Promise.all([graph('before'), graph('after')]);
const options = { match: { strategy: 'auto' }, hierarchyPredicates: ['is_a'] };
await Promise.all(
  roots.map((root) =>
    root.load({ before, after, diff: options, names: { before: 'v12', after: 'v13' } }),
  ),
);

/** Nodes of root A drawn under the host card (canvas positions inside its rect). */
function underCard(): { under: number; total: number } {
  const root = document.getElementById('a') as Root;
  const c = root.controller;
  const camera = c.camera;
  const layout = c.layout;
  const stage = root.querySelector('kgdiff-stage');
  const canvas = stage?.shadowRoot?.querySelector('canvas');
  const card = document.getElementById('card');
  if (!camera || !layout || !canvas || !card) return { under: 0, total: 0 };
  const box = canvas.getBoundingClientRect();
  const r = card.getBoundingClientRect();
  let under = 0;
  let total = 0;
  for (const p of layout.positions.values()) {
    const s = camera.worldToScreen(p);
    const x = box.left + s.x;
    const y = box.top + s.y;
    total++;
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) under++;
  }
  return { under, total };
}

document.getElementById('large')?.addEventListener('click', () => {
  document.getElementById('card')?.classList.toggle('large');
});

Object.assign(window, { kgdiff: { roots, underCard } });
