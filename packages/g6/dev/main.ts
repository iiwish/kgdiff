/// <reference types="vite/client" />
/**
 * DEV ONLY: the real pipeline — example dataset → core `parseGraph` → core `diff` → layout
 * `layoutDiff` → scene `buildScene` → `createDiffGraph` — with layer, replay, theme and hunk
 * controls, for side-by-side review against the native renderer harness (port 5199).
 * `?dataset=<id>` picks a dataset (default enterprise-kg); `window.kgdiff` exposes the controller.
 */
import { type DiffOptions, type DiffResult, diff, parseGraph } from '@kgdiff/core';
import { createDiffGraph, type DiffGraphController } from '@kgdiff/g6';
import { type LayoutResult, layoutDiff } from '@kgdiff/layout';
import { buildScene, getTheme, type PaletteName, type Scene, type ThemeName } from '@kgdiff/scene';

const files = import.meta.glob<string>('../../../examples/datasets/*/*', {
  query: '?raw',
  import: 'default',
});
const ROOT = '../../../examples/datasets/';

interface Meta {
  readonly files: { readonly before: string; readonly after: string };
  readonly options?: DiffOptions;
}

function $<T extends HTMLElement>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (el === null) throw new Error(`${selector} is missing`);
  return el;
}

async function read(id: string, name: string): Promise<string> {
  const load = files[`${ROOT}${id}/${name}`];
  if (load === undefined) throw new Error(`examples/datasets/${id}/${name} not found`);
  return load();
}

async function loadDataset(id: string): Promise<{ diff: DiffResult; layout: LayoutResult }> {
  const meta = JSON.parse(await read(id, 'meta.json')) as Meta;
  const [b, a] = await Promise.all([read(id, meta.files.before), read(id, meta.files.after)]);
  const before = (await parseGraph(b, { filename: meta.files.before })).graph;
  const after = (await parseGraph(a, { filename: meta.files.after })).graph;
  const result = diff(before, after, meta.options);
  return { diff: result, layout: layoutDiff(result) };
}

const ids = Object.keys(files)
  .filter((p) => p.endsWith('/meta.json'))
  .map((p) => p.slice(ROOT.length, -'/meta.json'.length))
  .sort();
const params = new URLSearchParams(location.search);
const datasetId = ids.includes(params.get('dataset') ?? '')
  ? (params.get('dataset') as string)
  : 'enterprise-kg';

let themeName: ThemeName = 'dark';
let palette: PaletteName = 'default';
let controller: DiffGraphController | null = null;
let scene: Scene | null = null;
let selected = -1;

const status = $<HTMLDivElement>('#status');
const say = (text: string): void => {
  status.textContent = text;
};

function pressed(selector: string, active: (el: HTMLElement) => boolean): void {
  for (const el of document.querySelectorAll<HTMLElement>(selector)) {
    el.setAttribute('aria-pressed', String(active(el)));
  }
}

function renderHunks(s: Scene): void {
  const list = $<HTMLUListElement>('#hunks');
  list.replaceChildren(
    ...s.hunks.map((h) => {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.hunk = String(h.index);
      button.setAttribute('aria-pressed', 'false');
      const bar = document.createElement('span');
      bar.className = 'bar';
      bar.style.background = s.theme.family[h.family].base;
      const title = document.createElement('span');
      title.textContent = h.title;
      button.append(bar, title);
      button.addEventListener('click', () => {
        void select(selected === h.index ? -1 : h.index);
      });
      li.append(button);
      return li;
    }),
  );
}

async function timed(label: string, task: () => Promise<void>): Promise<void> {
  const t0 = performance.now();
  try {
    await task();
    say(
      `${label}: ${(performance.now() - t0).toFixed(0)} ms · zoom ${controller?.graph.getZoom().toFixed(2)}`,
    );
  } catch (error) {
    say(`${label} failed: ${String(error)}`);
    throw error;
  }
}

async function select(index: number): Promise<void> {
  if (controller === null) return;
  selected = index;
  pressed('#hunks button', (el) => Number(el.dataset.hunk) === index);
  await timed(index < 0 ? 'clear selection' : `select hunk ${index}`, () =>
    (controller as DiffGraphController).selectHunk(index),
  );
}

async function start(): Promise<void> {
  const select = $<HTMLSelectElement>('#dataset');
  select.replaceChildren(
    ...ids.map((id) => {
      const o = document.createElement('option');
      o.value = id;
      o.textContent = id;
      o.selected = id === datasetId;
      return o;
    }),
  );
  select.addEventListener('change', () => {
    location.search = `?dataset=${encodeURIComponent(select.value)}`;
  });

  say(`loading ${datasetId}…`);
  const t0 = performance.now();
  const data = await loadDataset(datasetId);
  scene = buildScene(data.diff, data.layout, { theme: themeName, palette });
  const t1 = performance.now();
  controller = await createDiffGraph($('#stage'), scene);
  const t2 = performance.now();
  renderHunks(scene);
  say(
    `${datasetId}: ${scene.nodes.length} nodes · ${scene.edges.length} edges · ${scene.hunks.length} hunks\n` +
      `pipeline ${(t1 - t0).toFixed(0)} ms · G6 first render ${(t2 - t1).toFixed(0)} ms`,
  );
  Object.assign(window, { kgdiff: { controller, scene } });

  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-layer]')) {
    button.addEventListener('click', () => {
      const layer = button.dataset.layer as 'union' | 'before' | 'after';
      pressed('[data-layer]', (el) => el === button);
      void timed(`layer ${layer}`, () => (controller as DiffGraphController).setLayer(layer));
    });
  }
  $('#play').addEventListener('click', () => {
    const speed = Number($<HTMLSelectElement>('#speed').value);
    pressed('[data-layer]', () => false);
    void timed(`replay ${speed}×`, () => (controller as DiffGraphController).playReplay({ speed }));
  });
  $('#stop').addEventListener('click', () => controller?.stop());
  const applyTheme = (): void => {
    document.documentElement.dataset.theme = themeName;
    pressed('[data-theme]', (el) => el.dataset.theme === themeName);
    pressed('#palette', () => palette === 'colorblind');
    const theme = getTheme(themeName, palette);
    if (scene !== null) renderHunks({ ...scene, theme });
    void timed(`theme ${themeName}/${palette}`, () =>
      (controller as DiffGraphController).setTheme(theme),
    );
  };
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-theme]')) {
    button.addEventListener('click', () => {
      themeName = button.dataset.theme as ThemeName;
      applyTheme();
    });
  }
  $('#palette').addEventListener('click', () => {
    palette = palette === 'default' ? 'colorblind' : 'default';
    applyTheme();
  });
}

start().catch((error: unknown) => {
  say(`failed: ${String(error)}`);
  throw error;
});
