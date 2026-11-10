/**
 * Dev harness for @kgdiff/renderer.
 *
 * - Dataset mode (default): an example from examples/datasets through the real pipeline
 *   (formats → core diff → layout → scene resolver), with layer buttons, replay scrubbing /
 *   playback with camera follow, hover and click-to-select-hunk. The end-to-end visual check.
 * - Synthetic mode: a generated frame exercising every primitive at 2k / 10k nodes, with
 *   animation, stress and benchmarks (`?source=synthetic`, `?n=5000`).
 * - "Host layers" (`?layers=1`): example layers under and over the graph (`dev/layers.ts`).
 */
import type { Locale } from '@kgdiff/core';
import { createMinimap, createRenderer, type PickResult } from '@kgdiff/renderer';
import {
  createViewState,
  type FrameVisuals,
  type Layer,
  type Theme,
  type ThemeName,
  type ViewState,
} from '@kgdiff/scene';
import type { Surface, SurfaceFactory } from '../src/ctx.js';
import { FrameCache } from '../src/frame-cache.js';
import { Painter, Resources } from '../src/paint.js';
import { type Dataset, datasetIds, loadDataset, type SceneBundle, sceneFor } from './dataset.js';
import { exampleLayers } from './layers.js';
import { createSynthetic, type Synthetic } from './synthetic.js';
import { darkTheme, lightTheme } from './theme.js';

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} is missing`);
  return el as T;
}

const params = new URLSearchParams(location.search);
const baseCount = Math.max(10, Number(params.get('n')) || 2000);
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

let themeName: ThemeName = 'dark';
let swipe = false;
let split = 0.5;
let lastPick: PickResult | null = null;

// Synthetic mode.
let count = baseCount;
let syn: Synthetic | null = null;
let animating = false;

// Dataset mode.
let mode: 'synthetic' | 'dataset' = 'synthetic';
let data: Dataset | null = null;
let bundle: SceneBundle | null = null;
let view: ViewState = createViewState({ reducedMotion });
let locale: Locale = 'zh-CN';
let playing = false;
let followed = -1;
const outs: { main?: FrameVisuals; before?: FrameVisuals; after?: FrameVisuals } = {};

const renderer = createRenderer($('stage'), {
  theme: darkTheme,
  safeArea: { top: 0, right: 0, bottom: 0, left: 340 },
});
const minimap = createMinimap($('minimap'), renderer);

function fixtureTheme(): Theme {
  return themeName === 'dark' ? darkTheme : lightTheme;
}

function ensureSyn(): Synthetic {
  if (!syn || syn.frame.nodes.length !== count) syn = createSynthetic(fixtureTheme(), count);
  return syn;
}

/** The frame shown (after side when swiping), for readouts. */
function currentFrame(): FrameVisuals | null {
  if (mode === 'synthetic') return syn?.frame ?? null;
  return swipe ? (outs.after ?? null) : (outs.main ?? null);
}

function pushFrame(): void {
  if (mode === 'synthetic') {
    const s = ensureSyn();
    renderer.setFrame(swipe ? { split, before: s.before, after: s.frame } : s.frame);
    return;
  }
  if (!bundle) return;
  const { resolver } = bundle;
  if (swipe) {
    outs.before = resolver.resolve(createViewState({ ...view, layer: 'before' }), outs.before);
    outs.after = resolver.resolve(createViewState({ ...view, layer: 'after' }), outs.after);
    renderer.setFrame({ split, before: outs.before, after: outs.after });
    minimap.update(outs.after);
  } else {
    outs.main = resolver.resolve(view, outs.main);
    renderer.setFrame(outs.main);
    minimap.update(outs.main);
  }
}

function setView(partial: Partial<ViewState>): void {
  view = createViewState({ ...view, ...partial });
  pushFrame();
}

// ── Sources ──────────────────────────────────────────────────────────────────

const source = $<HTMLSelectElement>('source');
for (const id of datasetIds()) {
  const option = document.createElement('option');
  option.value = id;
  option.textContent = `Dataset: ${id}`;
  source.append(option);
}

function rebuildScene(): void {
  if (!data) return;
  bundle = sceneFor(data, themeName, locale);
  delete outs.main;
  delete outs.before;
  delete outs.after;
  renderer.setTheme(bundle.scene.theme);
  syncReplayControls();
  pushFrame();
}

async function selectSource(value: string): Promise<void> {
  stopPlaying();
  document.body.dataset.mode = value === 'synthetic' ? 'synthetic' : 'dataset';
  const info = $('bench');
  if (value === 'synthetic') {
    mode = 'synthetic';
    renderer.setTheme(fixtureTheme());
    syn = null;
    pushFrame();
    minimap.update(ensureSyn().frame);
    info.textContent = '';
    await renderer.camera.fit(undefined, { animate: false });
    return;
  }
  info.textContent = `loading ${value}…`;
  try {
    data = await loadDataset(value);
  } catch (error) {
    info.textContent = `failed to load ${value}: ${String(error)}`;
    console.error(error);
    return;
  }
  mode = 'dataset';
  view = createViewState({ reducedMotion });
  followed = -1;
  rebuildScene();
  const scene = bundle?.scene;
  if (!scene) return;
  await renderer.camera.fit(scene.bounds, { animate: false });
  const t = data.timings;
  const v = data.meta.versions;
  const s = scene.stats;
  info.textContent = [
    `${data.meta.title[locale === 'zh-CN' ? 'zh-CN' : 'en']}${v ? `  ${v.before} → ${v.after}` : ''}`,
    `${scene.nodes.length} nodes · ${scene.edges.length} edges · ${scene.hunks.length} hunks`,
    `nodes +${s.nodes.added} −${s.nodes.removed} ~${s.nodes.modified} · edges +${s.edges.added} −${s.edges.removed} ~${s.edges.modified}`,
    `parse ${t.parse.toFixed(1)} · diff ${t.diff.toFixed(1)} · layout ${t.layout.toFixed(1)} · scene ${bundle?.ms.toFixed(1)} ms`,
  ].join('\n');
}

source.addEventListener('change', () => void selectSource(source.value));

// ── Layers, replay, locale ──────────────────────────────────────────────────

function pressed(selector: string, active: (el: HTMLElement) => boolean): void {
  for (const el of document.querySelectorAll<HTMLElement>(selector)) {
    el.setAttribute('aria-pressed', String(active(el)));
  }
}

const replay = $<HTMLInputElement>('replay');
const time = $('time');

function syncReplayControls(): void {
  const duration = bundle?.scene.timeline.duration ?? 0;
  replay.max = String(Math.max(1, Math.round(duration)));
  replay.value = String(Math.round(view.t));
  time.textContent = `${(view.t / 1000).toFixed(1)} / ${(duration / 1000).toFixed(1)} s`;
  pressed('[data-layer]', (el) => el.dataset.layer === view.layer);
  $('play').textContent = playing ? '❚❚' : '▶';
}

for (const el of document.querySelectorAll<HTMLElement>('[data-layer]')) {
  el.addEventListener('click', () => {
    const layer = el.dataset.layer as Layer;
    setView({ layer });
    syncReplayControls();
  });
}

replay.addEventListener('input', () => {
  const t = Number(replay.value); // read before stopPlaying re-syncs the slider
  stopPlaying();
  setView({ layer: 'replay', t });
  follow();
  syncReplayControls();
});

/** Fly to the current replay hunk when less than 70% of it is in view (as the viewer does). */
function follow(): void {
  const scene = bundle?.scene;
  if (!scene || view.layer !== 'replay') return;
  const w = scene.timeline.windows.findIndex((win) => view.t >= win.start && view.t < win.end);
  if (w < 0 || w === followed) return;
  followed = w;
  const hunk = scene.hunks[scene.timeline.windows[w]?.hunk ?? -1];
  if (!hunk) return;
  const b = hunk.bounds;
  const vp = renderer.camera.viewport();
  const ix = Math.max(0, Math.min(b.x + b.width, vp.x + vp.width) - Math.max(b.x, vp.x));
  const iy = Math.max(0, Math.min(b.y + b.height, vp.y + vp.height) - Math.max(b.y, vp.y));
  const area = Math.max(b.width * b.height, 1e-9);
  if ((ix * iy) / area < 0.7) void renderer.camera.flyTo(b);
}

let lastTick = 0;
function playLoop(now: number): void {
  if (!playing || !bundle) return;
  const dt = lastTick ? Math.min(64, now - lastTick) : 16;
  lastTick = now;
  const duration = bundle.scene.timeline.duration;
  const t = Math.min(duration, view.t + dt);
  setView({ layer: 'replay', t });
  follow();
  syncReplayControls();
  if (t >= duration) stopPlaying();
  else requestAnimationFrame(playLoop);
}

function stopPlaying(): void {
  playing = false;
  lastTick = 0;
  if (mode === 'dataset') syncReplayControls();
}

$('play').addEventListener('click', () => {
  if (!bundle) return;
  if (playing) {
    stopPlaying();
    return;
  }
  playing = true;
  if (view.layer !== 'replay' || view.t >= bundle.scene.timeline.duration) {
    followed = -1;
    setView({ layer: 'replay', t: 0 });
  }
  syncReplayControls();
  requestAnimationFrame(playLoop);
});

for (const el of document.querySelectorAll<HTMLElement>('[data-locale]')) {
  el.addEventListener('click', () => {
    locale = el.dataset.locale === 'en' ? 'en' : 'zh-CN';
    pressed('[data-locale]', (b) => b.dataset.locale === locale);
    rebuildScene();
  });
}

// ── Hover / click → view state (dataset mode) ─────────────────────────────────

renderer.on('hover', (p) => {
  lastPick = p;
  if (mode !== 'dataset') return;
  setView({
    hoveredNode: p?.type === 'node' ? p.index : -1,
    hoveredEdge: p?.type === 'edge' ? p.index : -1,
  });
});

function selectHunk(hunk: number, node = -1): void {
  setView({ selectedHunk: hunk, selectedNode: node });
  const b = bundle?.scene.hunks[hunk]?.bounds;
  if (b) void renderer.camera.flyTo(b);
}

renderer.on('click', ({ pick, world }) => {
  lastPick = pick;
  console.info('click', pick, world);
  const scene = bundle?.scene;
  if (mode !== 'dataset' || !scene) return;
  if (pick?.type === 'node') selectHunk(scene.nodes[pick.index]?.hunk ?? -1, pick.index);
  else if (pick?.type === 'edge') selectHunk(scene.edges[pick.index]?.hunk ?? -1);
  else if (!pick) setView({ selectedHunk: -1, selectedNode: -1 });
});

// ── Readout ──────────────────────────────────────────────────────────────────

const frameTimes: number[] = [];
const drawTimes: number[] = [];
renderer.on('frame', ({ ms }) => {
  frameTimes.push(performance.now());
  drawTimes.push(ms);
  if (frameTimes.length > 240) frameTimes.shift();
  if (drawTimes.length > 120) drawTimes.shift();
});

function avg(xs: readonly number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

function percentile(xs: readonly number[], p: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0;
}

function describePick(p: PickResult | null): string {
  if (!p) return '—';
  const frame = currentFrame();
  if (p.type === 'node') return `node ${p.index} “${frame?.nodes[p.index]?.label?.text ?? ''}”`;
  if (p.type === 'collapsed') return `pill “${frame?.collapsed[p.index]?.label ?? ''}”`;
  return `edge ${p.index}`;
}

const readout = $('readout');
setInterval(() => {
  const now = performance.now();
  const recent = frameTimes.filter((t) => now - t < 1000).length;
  const idle = frameTimes.length === 0 || now - (frameTimes.at(-1) ?? 0) > 500;
  const frame = currentFrame();
  const fmt = (n: number) => n.toLocaleString('en-US');
  const hunk =
    mode === 'dataset' && view.selectedHunk >= 0
      ? bundle?.scene.hunks[view.selectedHunk]?.title
      : '';
  readout.innerHTML = [
    `<b>${idle ? 'idle · 0 fps' : `${recent} fps`}</b>  draw avg ${avg(drawTimes).toFixed(2)} ms · p95 ${percentile(drawTimes, 0.95).toFixed(2)} ms`,
    `${fmt(frame?.nodes.length ?? 0)} nodes · ${fmt(frame?.edges.length ?? 0)} edges · zoom ${renderer.camera.get().k.toFixed(3)}`,
    `pick ${describePick(lastPick)}`,
    hunk ? `hunk ${hunk}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}, 250);

// ── Controls shared by both modes ───────────────────────────────────────────

function setTheme(next: ThemeName): void {
  themeName = next;
  document.documentElement.dataset.theme = next;
  pressed('#dark, #light', (el) => el.id === next);
  if (mode === 'dataset') {
    rebuildScene();
  } else {
    renderer.setTheme(fixtureTheme());
    syn = null;
    pushFrame();
    minimap.update(ensureSyn().frame);
  }
}
$('dark').addEventListener('click', () => setTheme('dark'));
$('light').addEventListener('click', () => setTheme('light'));

$<HTMLInputElement>('swipe').addEventListener('change', (e) => {
  swipe = (e.target as HTMLInputElement).checked;
  pushFrame();
});
$<HTMLInputElement>('split').addEventListener('input', (e) => {
  split = Number((e.target as HTMLInputElement).value) / 100;
  if (swipe) pushFrame();
});

// Host layers: what `Renderer.addLayer` draws under and over the graph.
const layerOffs: (() => void)[] = [];
function setLayers(on: boolean): void {
  for (const off of layerOffs.splice(0)) off();
  if (!on) return;
  const frameOf = (side: 'before' | 'after' | undefined): FrameVisuals | null => {
    if (side !== 'before') return currentFrame();
    return mode === 'synthetic' ? (syn?.before ?? null) : (outs.before ?? null);
  };
  const theme = (): Theme => (mode === 'dataset' && bundle ? bundle.scene.theme : fixtureTheme());
  for (const layer of exampleLayers(frameOf, theme)) layerOffs.push(renderer.addLayer(layer));
}
const layersBox = $<HTMLInputElement>('layers');
layersBox.addEventListener('change', () => setLayers(layersBox.checked));
if (params.get('layers') === '1') {
  layersBox.checked = true;
  setLayers(true);
}

function animateLoop(t: number): void {
  if (!animating || mode !== 'synthetic') return;
  ensureSyn().animate(t);
  pushFrame();
  requestAnimationFrame(animateLoop);
}
$<HTMLInputElement>('animate').addEventListener('change', (e) => {
  animating = (e.target as HTMLInputElement).checked;
  if (animating) requestAnimationFrame(animateLoop);
});

$<HTMLInputElement>('stress').addEventListener('change', (e) => {
  count = (e.target as HTMLInputElement).checked ? 10_000 : baseCount;
  pushFrame();
  minimap.update(ensureSyn().frame);
  void renderer.camera.fit(undefined, { animate: false });
});

$('fit').addEventListener('click', () => void renderer.camera.fit());
$('fly').addEventListener('click', () => {
  const scene = bundle?.scene;
  if (mode === 'dataset' && scene && scene.hunks.length > 0) {
    const next = (view.selectedHunk + 1) % scene.hunks.length;
    selectHunk(next, -1);
    return;
  }
  const changed = ensureSyn().frame.nodes.filter((n) => n.visible && n.z > 0);
  const n = changed[Math.floor(Math.random() * changed.length)];
  if (n) void renderer.camera.flyTo({ x: n.x - 120, y: n.y - 80, width: 240, height: 160 });
});

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  if (e.key === 'f') void renderer.camera.fit();
  if (e.key === '+' || e.key === '=') renderer.camera.zoomBy(1.4);
  if (e.key === '-') renderer.camera.zoomBy(1 / 1.4);
  if (e.key === 'Escape') setView({ selectedHunk: -1, selectedNode: -1 });
});

// ── Benchmarks (synthetic mode) ─────────────────────────────────────────────

const nextFrame = (): Promise<number> => new Promise((resolve) => requestAnimationFrame(resolve));

async function useSynthetic(nodes: number): Promise<Synthetic> {
  if (mode !== 'synthetic') {
    source.value = 'synthetic';
    await selectSource('synthetic');
  }
  if (nodes !== count) {
    count = nodes;
    pushFrame();
    minimap.update(ensureSyn().frame);
  }
  return ensureSyn();
}

/** rAF-driven orbits: real frame pacing (needs a visible, unthrottled tab). */
async function orbit(label: string, k: number, frames = 180): Promise<string> {
  const vp0 = renderer.camera.viewport();
  const cx = vp0.x + vp0.width / 2;
  const cy = vp0.y + vp0.height / 2;
  renderer.camera.set({ x: cx, y: cy, k });
  await nextFrame();
  await nextFrame();
  const draws: number[] = [];
  const intervals: number[] = [];
  const off = renderer.on('frame', ({ ms }) => draws.push(ms));
  let last = performance.now();
  for (let i = 0; i < frames; i++) {
    await nextFrame();
    const now = performance.now();
    intervals.push(now - last);
    last = now;
    const a = (i / frames) * Math.PI * 2;
    const r = 260 / k;
    renderer.camera.set({
      x: cx + Math.cos(a) * r,
      y: cy + Math.sin(a) * r,
      k: k * (1 + 0.3 * Math.sin(2 * a)),
    });
  }
  off();
  const fps = 1000 / avg(intervals);
  return `${label.padEnd(9)} k=${k.toFixed(2).padStart(5)}  draw avg ${avg(draws).toFixed(2)} · p95 ${percentile(draws, 0.95).toFixed(2)} ms  ${fps.toFixed(0)} fps`;
}

$('run').addEventListener('click', async () => {
  const out = $('bench');
  out.textContent = 'running…';
  const s = await useSynthetic(count);
  await renderer.camera.fit(undefined, { animate: false });
  const fitK = renderer.camera.get().k;
  const lines = [
    `${s.frame.nodes.length} nodes / ${s.frame.edges.length} edges, ${innerWidth}×${innerHeight} @${devicePixelRatio}x`,
  ];
  lines.push(await orbit('overview', fitK));
  lines.push(await orbit('mid', 0.5));
  lines.push(await orbit('close', 1.5));
  out.textContent = lines.join('\n');
  console.info(lines.join('\n'));
  await renderer.camera.fit();
});

/** Main-thread paint time on the real (GPU-backed) canvas: synchronous paints, no readback. */
async function benchPaint(nodes = count, frames = 120): Promise<string> {
  const s = await useSynthetic(nodes);
  await renderer.camera.fit(undefined, { animate: false });
  const fitK = renderer.camera.get().k;
  const { x: cx, y: cy } = renderer.camera.get();
  const lines = [
    `paint bench (main thread, GPU canvas): ${s.frame.nodes.length} nodes / ${s.frame.edges.length} edges`,
  ];
  for (const [label, k] of [
    ['overview', fitK],
    ['mid', 0.5],
    ['close', 1.5],
  ] as const) {
    const ms: number[] = [];
    const off = renderer.on('frame', (e) => ms.push(e.ms));
    for (let i = 0; i < frames + 10; i++) {
      const a = (i / frames) * Math.PI * 2;
      const r = 260 / k;
      renderer.camera.set({
        x: cx + Math.cos(a) * r,
        y: cy + Math.sin(a) * r,
        k: k * (1 + 0.3 * Math.sin(2 * a)),
      });
      renderer.resize();
      if (i % 20 === 0) await new Promise((res) => setTimeout(res, 0));
    }
    off();
    const m = ms.slice(10);
    lines.push(
      `${label.padEnd(9)} k=${k.toFixed(3)}  avg ${avg(m).toFixed(2)} · p95 ${percentile(m, 0.95).toFixed(2)} · max ${Math.max(...m).toFixed(2)} ms`,
    );
  }
  return lines.join('\n');
}

// Raster benchmark: paints through the internal painter into a CPU-backed canvas and reads one
// pixel back per frame, so the time includes full rasterization — an upper bound for the GPU
// canvas, immune to background-tab rAF throttling. Console: `await benchRaster(10000)`.

const cpuSurfaces: SurfaceFactory = (w, h) => {
  const canvas = new OffscreenCanvas(Math.max(1, Math.ceil(w)), Math.max(1, Math.ceil(h)));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  return ctx ? ({ canvas, ctx } satisfies Surface) : null;
};

async function benchRaster(nodes = count, frames = 60, grid = true): Promise<string> {
  const theme = fixtureTheme();
  const data = createSynthetic(theme, nodes);
  const width = innerWidth;
  const height = innerHeight;
  const dpr = Math.min(3, devicePixelRatio);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
  if (!ctx) return 'no 2d context';
  const res = new Resources(cpuSurfaces, theme, ctx);
  const painter = new Painter(res);
  const caches = { main: new FrameCache(), before: new FrameCache(), after: new FrameCache() };
  caches.main.sync(data.frame, 1, res.interner);
  const bounds = caches.main.contentBounds() ?? { x: 0, y: 0, width: 1, height: 1 };
  const fitK = Math.min((width - 96) / bounds.width, (height - 96) / bounds.height);
  const cx = bounds.x + bounds.width / 2;
  const cy = bounds.y + bounds.height / 2;
  const lines = [
    `raster bench: ${data.frame.nodes.length} nodes / ${data.frame.edges.length} edges, ${width}×${height} @${dpr}x, CPU canvas, grid ${grid}`,
  ];
  const empty: number[] = [];
  for (let i = 0; i < 20; i++) {
    const t0 = performance.now();
    painter.paint(
      { ctx, width, height, dpr },
      { x: 0, y: 0, k: 0.5 },
      null,
      caches,
      1,
      theme,
      grid,
    );
    ctx.getImageData(0, 0, 1, 1);
    empty.push(performance.now() - t0);
  }
  lines.push(`background + grid only (k=0.5)  avg ${avg(empty).toFixed(2)} ms`);
  for (const [label, k] of [
    ['overview', fitK],
    ['mid', 0.5],
    ['close', 1.5],
  ] as const) {
    const times: number[] = [];
    let labels = 0;
    for (let i = 0; i < frames + 5; i++) {
      const a = (i / frames) * Math.PI * 2;
      const r = 260 / k;
      const cam = {
        x: cx + Math.cos(a) * r,
        y: cy + Math.sin(a) * r,
        k: k * (1 + 0.3 * Math.sin(2 * a)),
      };
      const t0 = performance.now();
      const s = painter.paint({ ctx, width, height, dpr }, cam, data.frame, caches, 1, theme, grid);
      ctx.getImageData(0, 0, 1, 1);
      if (i >= 5) {
        times.push(performance.now() - t0);
        labels += s.labels;
      }
      if (i % 10 === 0) await new Promise((r) => setTimeout(r, 0));
    }
    lines.push(
      `${label.padEnd(9)} k=${k.toFixed(3)}  avg ${avg(times).toFixed(2)} · p95 ${percentile(times, 0.95).toFixed(2)} ms  ${Math.round(labels / frames)} labels`,
    );
  }
  return lines.join('\n');
}

Object.assign(window, { renderer, minimap, benchPaint, benchRaster });
// Live getters (Object.assign would copy current values).
Object.defineProperty(window, 'syn', { get: () => syn, configurable: true });
Object.defineProperty(window, 'scene', { get: () => bundle?.scene ?? null, configurable: true });
Object.defineProperty(window, 'view', { get: () => view, configurable: true });

const initial =
  params.get('source') ?? (datasetIds().includes('enterprise-kg') ? 'enterprise-kg' : 'synthetic');
source.value = initial;
void selectSource(source.value);
