/**
 * Playground: a full-viewport `<kgdiff-viewer>` with a compact toolbar. Pick an example
 * dataset (with its meta.json options) or bring two files (picker or drag and drop, any
 * supported format, gzip ok); tune the diff options; share the dataset view as a URL
 * (`?dataset=…&mode=…&hunk=…` + non-default options); download a self-contained HTML report.
 * Everything runs locally: files are parsed, diffed and laid out in the browser.
 */

import { computeUrl, viewerUrl } from 'virtual:kgdiff/standalone';
import {
  type DiffOptions,
  diffToJSON,
  type GraphInput,
  KgdiffError,
  type Locale,
  packDiffJSON,
} from '@kgdiff/core';
import { layoutToJSON } from '@kgdiff/layout';
import type { KgdiffViewerElement, ReportPayload, ViewerMode, ViewerScope } from '@kgdiff/viewer';
import {
  DATASETS,
  type Dataset,
  datasetById,
  datasetsFor,
  featuredFor,
  inLanguage,
} from '../shared/datasets.js';
import { byId, copyText, h, toast } from '../shared/dom.js';
import { applyDocumentLocale, format, translateDom } from '../shared/i18n.js';
import {
  applyTheme,
  initialLocale,
  initialTheme,
  langParam,
  localizedHref,
  type SiteTheme,
  storeLocale,
  storeTheme,
} from '../shared/prefs.js';
import { onViewer } from '../shared/viewer-events.js';
import { downloadText, renderReportHtml, slug } from './report.js';
import { TEXT, ZH } from './strings.js';

// ── State ──────────────────────────────────────────────────────────────────

type SideName = 'before' | 'after';
type Strategy = 'id' | 'auto' | 'similarity';

interface Side {
  /** Shown in the toolbar (the file's own name). */
  readonly name: string;
  /** Used for format detection (`.gz` stripped). */
  readonly parseName: string;
  readonly text: string;
  readonly origin: 'dataset' | 'file';
}

interface Options {
  readonly strategy: Strategy;
  readonly threshold: number;
  /** null = the engine's default hierarchy predicates. */
  readonly hierarchy: readonly string[] | null;
  readonly ignore: readonly string[];
  readonly merges: boolean;
  readonly splits: boolean;
}

const ENGINE_DEFAULTS: Options = {
  strategy: 'auto',
  threshold: 0.82,
  hierarchy: null,
  ignore: [],
  merges: true,
  splits: true,
};

const state: {
  locale: Locale;
  theme: SiteTheme;
  dataset: string | null;
  swapped: boolean;
  before: Side | null;
  after: Side | null;
  defaults: Options;
  options: Options;
  hunk: string | null;
} = {
  locale: initialLocale(),
  theme: initialTheme(),
  dataset: null,
  swapped: false,
  before: null,
  after: null,
  defaults: ENGINE_DEFAULTS,
  options: ENGINE_DEFAULTS,
  hunk: null,
};

const t = (): (typeof TEXT)[Locale] => TEXT[state.locale];

function fromDiffOptions(o: DiffOptions | undefined): Options {
  return {
    strategy: o?.match?.strategy ?? ENGINE_DEFAULTS.strategy,
    threshold: o?.match?.threshold ?? ENGINE_DEFAULTS.threshold,
    hierarchy: o?.hierarchyPredicates ? [...o.hierarchyPredicates] : null,
    ignore: o?.ignoreAttrs ? [...o.ignoreAttrs] : [],
    merges: o?.detectMerges ?? true,
    splits: o?.detectSplits ?? true,
  };
}

function toDiffOptions(o: Options): DiffOptions {
  return {
    match: { strategy: o.strategy, threshold: o.threshold },
    ...(o.hierarchy ? { hierarchyPredicates: o.hierarchy } : {}),
    ...(o.ignore.length > 0 ? { ignoreAttrs: o.ignore } : {}),
    detectMerges: o.merges,
    detectSplits: o.splits,
  };
}

const list = (s: string | null): string[] =>
  (s ?? '')
    .split(/[,\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);

const sameList = (a: readonly string[] | null, b: readonly string[] | null): boolean =>
  (a ?? []).join('\n') === (b ?? []).join('\n') && (a === null) === (b === null);

function isStrategy(v: string | null): v is Strategy {
  return v === 'id' || v === 'auto' || v === 'similarity';
}

/** `changes` (the viewer's legacy mode) stays valid in old links: overlay + the changes scope. */
function isMode(v: string | null): v is ViewerMode | 'changes' {
  return v === 'overlay' || v === 'swipe' || v === 'replay' || v === 'changes';
}

function isScope(v: string | null): v is ViewerScope {
  return v === 'all' || v === 'changes';
}

/** Options from the URL on top of `base`. */
function optionsFromUrl(params: URLSearchParams, base: Options): Options {
  const strategy = params.get('match');
  const threshold = Number(params.get('threshold'));
  return {
    strategy: isStrategy(strategy) ? strategy : base.strategy,
    threshold:
      params.has('threshold') && threshold >= 0 && threshold <= 1 ? threshold : base.threshold,
    hierarchy: params.has('hierarchy') ? list(params.get('hierarchy')) : base.hierarchy,
    ignore: params.has('ignore') ? list(params.get('ignore')) : base.ignore,
    merges: params.has('merges') ? params.get('merges') !== '0' : base.merges,
    splits: params.has('splits') ? params.get('splits') !== '0' : base.splits,
  };
}

// ── Elements ───────────────────────────────────────────────────────────────

// The playground is the site's one viewer that remembers the visitor's layout, theme and
// language, under a key of its own (`persist-key="kgdiff:playground"`, so a site hosted on a
// shared origin keeps it apart); the landing page's demos remember nothing.
const viewer = byId<KgdiffViewerElement>('viewer');
const datasetSelect = byId<HTMLSelectElement>('dataset');
const statusEl = byId('status');
const downloadBtn = byId<HTMLButtonElement>('download-btn');
const errorEl = byId('error');
const dropEl = byId('drop');
const optionsBtn = byId<HTMLButtonElement>('options-btn');
const optionsEl = byId('options');
const form = byId<HTMLFormElement>('options-form');
const fileInputs: Record<SideName, HTMLInputElement> = {
  before: byId<HTMLInputElement>('file-before'),
  after: byId<HTMLInputElement>('file-after'),
};

// ── Viewer setup (attributes before the element is defined: first render is right) ──

const params = new URLSearchParams(location.search);
const initialMode = params.get('mode');
const initialScope = params.get('scope');
viewer.setAttribute('theme', state.theme);
viewer.setAttribute('locale', state.locale);
if (isMode(initialMode)) viewer.setAttribute('mode', initialMode);
if (isScope(initialScope)) viewer.setAttribute('scope', initialScope);
if (window.innerWidth < 900) viewer.setAttribute('sidebar', 'closed');
state.hunk = params.get('hunk');

const viewerReady = import('@kgdiff/viewer');

onViewer(viewer, 'kgdiff-ready', () => {
  downloadBtn.disabled = current === null;
  const pending = pendingHunk;
  pendingHunk = null;
  if (pending) viewer.selectHunk(pending);
});
onViewer(viewer, 'kgdiff-error', (e) => {
  downloadBtn.disabled = true;
  toast(format(t().viewerError, { message: e.detail.error.message }), 'error', 5000);
});
onViewer(viewer, 'kgdiff-mode', () => syncUrl());
onViewer(viewer, 'kgdiff-select', (e) => {
  state.hunk = e.detail.hunk;
  syncUrl();
});

// ── Datasets ───────────────────────────────────────────────────────────────

const datasetFiles = import.meta.glob<string>(
  ['../../../../examples/datasets/*/before.*', '../../../../examples/datasets/*/after.*'],
  { query: '?raw', import: 'default' },
);

async function datasetText(d: Dataset, side: SideName): Promise<string> {
  const path = `../../../../examples/datasets/${d.id}/${d.files[side]}`;
  const load = datasetFiles[path];
  if (!load) throw new Error(`Missing example file ${d.id}/${d.files[side]}`);
  return load();
}

const LOCAL = '__local';

function renderDatasetSelect(): void {
  const locale = state.locale;
  const examples = h('optgroup', { label: t().examples });
  const listed = new Set(datasetsFor(locale));
  for (const d of DATASETS) {
    if (!listed.has(d) && d.id !== state.dataset) continue;
    examples.append(h('option', { value: d.id }, d.title[locale] ?? d.title.en));
  }
  const children: HTMLElement[] = [examples];
  if (state.dataset === null) {
    children.unshift(h('option', { value: LOCAL }, t().localFiles));
  }
  datasetSelect.replaceChildren(...children);
  datasetSelect.value = state.dataset ?? LOCAL;
}

/**
 * Loads an example. `url`: options, swap and change from the address; `translation`: the same
 * graphs in another language, so options, swap and the selected change carry over.
 */
async function selectDataset(id: string, from?: 'url' | 'translation'): Promise<void> {
  const fromUrl = from === 'url';
  const keep = from === 'translation';
  const d = datasetById(id) ?? featuredFor(state.locale);
  const [before, after] = await Promise.all([datasetText(d, 'before'), datasetText(d, 'after')]);
  state.dataset = d.id;
  if (!keep) state.swapped = fromUrl && params.get('swap') === '1';
  const b: Side = {
    name: d.files.before,
    parseName: d.files.before,
    text: before,
    origin: 'dataset',
  };
  const a: Side = { name: d.files.after, parseName: d.files.after, text: after, origin: 'dataset' };
  state.before = state.swapped ? a : b;
  state.after = state.swapped ? b : a;
  state.defaults = fromDiffOptions(d.options);
  if (!keep) state.options = fromUrl ? optionsFromUrl(params, state.defaults) : state.defaults;
  if (keep) pendingHunk = state.hunk;
  else if (!fromUrl) state.hunk = null;
  renderDatasetSelect();
  renderSlots();
  syncUrl();
  await run();
}

datasetSelect.addEventListener('change', () => {
  if (datasetSelect.value !== LOCAL) void selectDataset(datasetSelect.value);
});

// ── Files ──────────────────────────────────────────────────────────────────

async function gunzip(bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(
      new DecompressionStream('gzip') as unknown as TransformStream<Uint8Array, Uint8Array>,
    );
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

class ReadError extends Error {}

async function readFile(file: File): Promise<Side> {
  let bytes = new Uint8Array(await file.arrayBuffer());
  let parseName = file.name;
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    bytes = await gunzip(bytes);
    parseName = parseName.replace(/\.gz$/i, '');
  }
  try {
    return { name: file.name, parseName, text: decodeText(bytes), origin: 'file' };
  } catch {
    throw new ReadError('The file is not valid UTF-8 (or UTF-16) text.');
  }
}

/** Put local files in: one side, or both (sorted by name, so v12 comes before v13). */
async function useFiles(files: readonly File[], side?: SideName): Promise<void> {
  if (files.length === 0) return;
  const sorted = [...files].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true }),
  );
  try {
    if (sorted.length >= 2 && side === undefined) {
      const [b, a] = await Promise.all([readFile(sorted[0] as File), readFile(sorted[1] as File)]);
      state.before = b;
      state.after = a;
      state.defaults = ENGINE_DEFAULTS;
      state.options = ENGINE_DEFAULTS;
    } else {
      const target: SideName = side ?? 'after';
      const file = side === undefined ? sorted[0] : files[0];
      if (!file) return;
      state[target] = await readFile(file);
      if (state.before?.origin !== 'dataset' && state.after?.origin !== 'dataset') {
        state.defaults = ENGINE_DEFAULTS;
      }
    }
  } catch (error) {
    const failed = error instanceof Error ? error : new Error(String(error));
    showError(side ?? 'before', files[0]?.name ?? '', failed);
    return;
  }
  state.dataset = null;
  state.swapped = false;
  state.hunk = null;
  renderDatasetSelect();
  renderSlots();
  syncUrl();
  await run();
}

for (const side of ['before', 'after'] as const) {
  byId(`slot-${side}`).addEventListener('click', () => fileInputs[side].click());
  fileInputs[side].addEventListener('change', () => {
    const files = [...(fileInputs[side].files ?? [])];
    fileInputs[side].value = '';
    void useFiles(files, side);
  });
}

byId('swap').addEventListener('click', () => {
  const { before, after } = state;
  state.before = after;
  state.after = before;
  if (state.dataset) state.swapped = !state.swapped;
  state.hunk = null;
  renderSlots();
  syncUrl();
  void run();
});

function renderSlots(): void {
  for (const side of ['before', 'after'] as const) {
    const s = state[side];
    byId(`name-${side}`).textContent = s?.name ?? '—';
    const slot = byId(`slot-${side}`);
    const sideLabel = side === 'before' ? t().sideBefore : t().sideAfter;
    slot.title = `${s?.name ?? ''}\n${format(t().chooseFile, { side: sideLabel })}`.trim();
    slot.setAttribute(
      'aria-label',
      `${sideLabel}: ${s?.name ?? '—'}. ${format(t().chooseFile, { side: sideLabel })}`,
    );
  }
}

// Drag and drop anywhere on the page.
let dragDepth = 0;
const hasFiles = (e: DragEvent): boolean => [...(e.dataTransfer?.types ?? [])].includes('Files');

window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  dropEl.hidden = false;
});
window.addEventListener('dragover', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  const zone = (e.target as Element | null)?.closest<HTMLElement>('.drop-zone');
  for (const z of dropEl.querySelectorAll<HTMLElement>('.drop-zone')) {
    z.toggleAttribute('data-over', z === zone);
  }
});
window.addEventListener('dragleave', (e) => {
  if (!hasFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dropEl.hidden = true;
});
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  dropEl.hidden = true;
  const files = [...(e.dataTransfer?.files ?? [])];
  const zone = (e.target as Element | null)?.closest<HTMLElement>('.drop-zone');
  const side = zone?.dataset.side;
  const target = side === 'before' || side === 'after' ? side : undefined;
  void useFiles(files, files.length >= 2 ? undefined : (target ?? 'after'));
});

// ── Parse → diff ───────────────────────────────────────────────────────────

type Formats = typeof import('@kgdiff/formats');
let formatsModule: Promise<Formats> | null = null;
const loadFormats = (): Promise<Formats> => {
  formatsModule ??= import('@kgdiff/formats');
  return formatsModule;
};

interface Current {
  readonly before: GraphInput;
  readonly after: GraphInput;
  readonly beforeFormat: string;
  readonly afterFormat: string;
  readonly options: DiffOptions;
  readonly names: { readonly before: string; readonly after: string };
  readonly title: string;
}

let current: Current | null = null;
let runToken = 0;
let pendingHunk: string | null = state.hunk;
let errorSide: SideName = 'before';

/** Let the status text paint before a blocking parse; never stalls in background tabs. */
const nextFrame = (): Promise<void> =>
  new Promise((resolve) => {
    let done = false;
    const finish = (): void => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    requestAnimationFrame(() => setTimeout(finish, 0));
    setTimeout(finish, 50);
  });

function setStatus(text: string): void {
  statusEl.textContent = text;
}

function showError(side: SideName, name: string, error: Error): void {
  errorSide = side;
  byId(`slot-${side}`).setAttribute('data-error', '');
  byId('error-title').textContent = format(t().readFailed, { name });
  byId('error-msg').textContent = error.message;
  const details = error instanceof KgdiffError ? error.details : undefined;
  const line = typeof details?.line === 'number' ? details.line : null;
  const column = typeof details?.column === 'number' ? details.column : null;
  byId('error-where').textContent =
    line === null
      ? ''
      : column === null
        ? format(t().line, { line })
        : format(t().lineCol, { line, column });
  errorEl.hidden = false;
  downloadBtn.disabled = true;
  byId<HTMLButtonElement>('error-retry').focus({ preventScroll: true });
}

function hideError(): void {
  errorEl.hidden = true;
  for (const side of ['before', 'after'] as const) {
    byId(`slot-${side}`).removeAttribute('data-error');
  }
}

byId('error-retry').addEventListener('click', () => fileInputs[errorSide].click());
byId('error-reset').addEventListener('click', () => {
  hideError();
  void selectDataset(featuredFor(state.locale).id);
});

async function run(): Promise<void> {
  const token = ++runToken;
  const { before, after } = state;
  if (!before || !after) return;
  hideError();
  downloadBtn.disabled = true;
  current = null;
  const f = await loadFormats();
  const graphs: Partial<Record<SideName, { graph: GraphInput; format: string }>> = {};
  for (const side of ['before', 'after'] as const) {
    const s = side === 'before' ? before : after;
    setStatus(format(t().parsing, { name: s.name }));
    await nextFrame();
    if (token !== runToken) return;
    try {
      const parsed = f.parseGraph(s.text, { filename: s.parseName });
      graphs[side] = { graph: parsed.graph, format: parsed.format };
      if (parsed.warnings.length > 0) {
        console.info(
          format(t().warnings, {
            n: parsed.warnings.length,
            name: s.name,
            list: parsed.warnings.map((w) => w.message).join(' · '),
          }),
        );
      }
    } catch (error) {
      if (token !== runToken) return;
      setStatus('');
      showError(side, s.name, error instanceof Error ? error : new Error(String(error)));
      return;
    }
  }
  const b = graphs.before;
  const a = graphs.after;
  if (!b || !a) return;
  const d = datasetById(state.dataset);
  const title = d ? (d.title[state.locale] ?? d.title.en) : `${before.name} → ${after.name}`;
  const names = d ? { before: title, after: title } : { before: before.name, after: after.name };
  const options = toDiffOptions(state.options);
  current = {
    before: b.graph,
    after: a.graph,
    beforeFormat: b.format,
    afterFormat: a.format,
    options,
    names,
    title,
  };
  setStatus(t().diffing);
  await viewerReady;
  try {
    await viewer.load({ before: b.graph, after: a.graph, diff: options, names, title });
  } catch {
    // The viewer shows its own error state and fires `kgdiff-error`.
    if (token === runToken) current = null;
  } finally {
    if (token === runToken) setStatus('');
  }
}

// ── URL ────────────────────────────────────────────────────────────────────

function syncUrl(): void {
  const p = new URLSearchParams();
  if (state.dataset) {
    p.set('dataset', state.dataset);
    if (state.swapped) p.set('swap', '1');
  }
  // Before the element is defined, `mode` is not an accessor yet: fall back to the attribute.
  const defined = customElements.get('kgdiff-viewer') !== undefined;
  const mode = defined ? viewer.mode : viewer.getAttribute('mode');
  const scope = defined ? viewer.scope : viewer.getAttribute('scope');
  if (isMode(mode)) p.set('mode', mode);
  if (isScope(scope)) p.set('scope', scope);
  if (state.hunk) p.set('hunk', state.hunk);
  const o = state.options;
  const base = state.defaults;
  if (o.strategy !== base.strategy) p.set('match', o.strategy);
  if (o.threshold !== base.threshold) p.set('threshold', String(o.threshold));
  if (!sameList(o.hierarchy, base.hierarchy)) p.set('hierarchy', (o.hierarchy ?? []).join(','));
  if (!sameList(o.ignore, base.ignore)) p.set('ignore', o.ignore.join(','));
  if (o.merges !== base.merges) p.set('merges', o.merges ? '1' : '0');
  if (o.splits !== base.splits) p.set('splits', o.splits ? '1' : '0');
  const lang = langParam(state.locale);
  if (lang) p.set('lang', lang);
  const next = `${location.pathname}?${p.toString()}`;
  if (next !== location.pathname + location.search) history.replaceState(null, '', next);
}

byId('share-btn').addEventListener('click', () => {
  syncUrl();
  const local = state.dataset === null;
  void copyText(location.href).then((ok) =>
    toast(
      ok ? (local ? t().linkCopiedLocal : t().linkCopied) : t().copyFailed,
      ok ? 'ok' : 'error',
      local ? 4200 : 2400,
    ),
  );
});

// ── Report download ────────────────────────────────────────────────────────

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

downloadBtn.addEventListener('click', async () => {
  const c = current;
  if (!c || downloadBtn.hasAttribute('data-busy')) return;
  downloadBtn.setAttribute('data-busy', '');
  setStatus(t().reportBuilding);
  try {
    // Same inputs + options → the same diff and layout the viewer shows (deterministic).
    const compute = await import('@kgdiff/viewer/compute');
    const result = compute.diff(c.before, c.after, c.options);
    const layout = compute.layoutDiff(result);
    const payload: ReportPayload = {
      format: 'kgdiff.report',
      version: 1,
      diff: packDiffJSON(diffToJSON(result)),
      layout: layoutToJSON(layout),
      meta: {
        title: c.title,
        generator: `kgdiff site ${__KGDIFF_VERSION__}`,
        generatedAt: new Date().toISOString(),
        before: { name: c.names.before, format: c.beforeFormat },
        after: { name: c.names.after, format: c.afterFormat },
      },
      view: { mode: viewer.mode, scope: viewer.scope, theme: state.theme, locale: state.locale },
    };
    const [bundle, computeBundle] = await Promise.all([
      fetchText(viewerUrl),
      layout.scope === 'changes' ? fetchText(computeUrl) : Promise.resolve(undefined),
    ]);
    const html = await renderReportHtml({
      payload,
      bundle,
      ...(computeBundle !== undefined ? { compute: computeBundle } : {}),
      description: `${t().reportDescription}: ${c.title}`,
    });
    const name = `kgdiff-${slug(state.dataset ?? `${c.names.before}-vs-${c.names.after}`)}.html`;
    downloadText(html, name);
    toast(format(t().reportSaved, { name }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    toast(format(t().reportFailed, { message }), 'error', 6000);
  } finally {
    downloadBtn.removeAttribute('data-busy');
    setStatus('');
  }
});

// ── Options popover ────────────────────────────────────────────────────────

const field = <T extends HTMLElement>(name: string): T => {
  const el = form.elements.namedItem(name);
  if (!el) throw new Error(`Missing form field ${name}`);
  return el as unknown as T;
};

function fillForm(o: Options): void {
  for (const radio of form.querySelectorAll<HTMLInputElement>('input[name="strategy"]')) {
    radio.checked = radio.value === o.strategy;
  }
  const threshold = byId<HTMLInputElement>('threshold');
  threshold.value = String(o.threshold);
  threshold.disabled = o.strategy === 'id';
  byId('threshold-out').textContent = o.threshold.toFixed(2);
  byId<HTMLInputElement>('hierarchy').value = (o.hierarchy ?? []).join(', ');
  byId<HTMLInputElement>('ignore').value = o.ignore.join(', ');
  byId<HTMLInputElement>('merges').checked = o.merges;
  byId<HTMLInputElement>('splits').checked = o.splits;
  byId('strategy-help').textContent = t().strategy[o.strategy];
  for (const radio of form.querySelectorAll<HTMLInputElement>('input[name="locale"]')) {
    radio.checked = radio.value === state.locale;
  }
  for (const radio of form.querySelectorAll<HTMLInputElement>('input[name="theme"]')) {
    radio.checked = radio.value === state.theme;
  }
}

function readForm(): Options {
  const checked = form.querySelector<HTMLInputElement>('input[name="strategy"]:checked')?.value;
  const hierarchy = list(byId<HTMLInputElement>('hierarchy').value);
  return {
    strategy: isStrategy(checked ?? null) ? (checked as Strategy) : state.options.strategy,
    threshold: Number(byId<HTMLInputElement>('threshold').value),
    hierarchy: hierarchy.length > 0 ? hierarchy : null,
    ignore: list(byId<HTMLInputElement>('ignore').value),
    merges: byId<HTMLInputElement>('merges').checked,
    splits: byId<HTMLInputElement>('splits').checked,
  };
}

function setOptionsOpen(open: boolean, restoreFocus = true): void {
  if (open === !optionsEl.hidden) return;
  optionsEl.hidden = !open;
  optionsBtn.setAttribute('aria-expanded', String(open));
  if (open) {
    fillForm(state.options);
    const bar = document.querySelector('.pg-bar')?.getBoundingClientRect();
    if (bar) optionsEl.style.top = `${Math.round(bar.bottom + 8)}px`;
    form.querySelector<HTMLInputElement>('input[name="strategy"]:checked')?.focus();
  } else if (restoreFocus) {
    optionsBtn.focus();
  }
}

optionsBtn.addEventListener('click', () => setOptionsOpen(optionsEl.hasAttribute('hidden')));
byId('options-close').addEventListener('click', () => setOptionsOpen(false));
document.addEventListener('pointerdown', (e) => {
  if (optionsEl.hidden) return;
  const path = e.composedPath();
  if (!path.includes(optionsEl) && !path.includes(optionsBtn)) setOptionsOpen(false, false);
});
optionsEl.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    setOptionsOpen(false);
  }
});
form.addEventListener('change', (e) => {
  const target = e.target as HTMLInputElement;
  if (target.name === 'strategy' && isStrategy(target.value)) {
    byId('strategy-help').textContent = t().strategy[target.value];
    byId<HTMLInputElement>('threshold').disabled = target.value === 'id';
  } else if (target.name === 'locale' && (target.value === 'en' || target.value === 'zh-CN')) {
    setLocale(target.value);
  } else if (target.name === 'theme' && (target.value === 'dark' || target.value === 'light')) {
    setTheme(target.value);
  }
});
field<HTMLInputElement>('threshold').addEventListener('input', () => {
  byId('threshold-out').textContent = Number(byId<HTMLInputElement>('threshold').value).toFixed(2);
});
byId('options-reset').addEventListener('click', () => fillForm(state.defaults));
form.addEventListener('submit', (e) => {
  e.preventDefault();
  state.options = readForm();
  state.hunk = null;
  setOptionsOpen(false);
  syncUrl();
  void run();
});

// ── Language and theme ─────────────────────────────────────────────────────

function updateToggles(): void {
  const lang = document.querySelector<HTMLButtonElement>('[data-action="locale"]');
  if (lang) {
    lang.textContent = t().langLabel;
    lang.setAttribute('aria-label', t().langSwitch);
    lang.lang = state.locale === 'en' ? 'zh-CN' : 'en';
  }
  document
    .querySelector('[data-action="theme"]')
    ?.setAttribute('aria-label', state.theme === 'dark' ? t().themeLight : t().themeDark);
}

function applyLocale(): void {
  translateDom(state.locale, state.locale === 'en' ? {} : ZH);
  applyDocumentLocale(state.locale, { title: t().docTitle, description: t().docDescription });
  for (const a of document.querySelectorAll<HTMLAnchorElement>('a[data-locale-link]')) {
    a.href = localizedHref(a.getAttribute('href') ?? './', state.locale);
  }
  renderDatasetSelect();
  renderSlots();
  updateToggles();
  if (!optionsEl.hidden) fillForm(readForm());
}

function setLocale(locale: Locale): void {
  if (locale === state.locale) return;
  state.locale = locale;
  storeLocale(locale);
  viewer.locale = locale;
  applyLocale();
  // An example with a translation switches to it, so its data reads in the new language.
  const d = datasetById(state.dataset);
  const translated = d ? inLanguage(d, locale) : undefined;
  if (translated && translated !== d) {
    void selectDataset(translated.id, 'translation');
    return;
  }
  syncUrl();
  // Dataset titles are localized: reload so the header shows the right one.
  if (state.dataset) void run();
}

function setTheme(theme: SiteTheme): void {
  state.theme = theme;
  storeTheme(theme);
  applyTheme(theme);
  viewer.theme = theme;
  updateToggles();
}

document.addEventListener('click', (event) => {
  const button = (event.target as Element | null)?.closest<HTMLElement>('[data-action]');
  if (!button) return;
  if (button.dataset.action === 'locale') setLocale(state.locale === 'en' ? 'zh-CN' : 'en');
  else if (button.dataset.action === 'theme') setTheme(state.theme === 'dark' ? 'light' : 'dark');
});

// The viewer's own appearance menu changes its attributes: follow it with the page chrome.
new MutationObserver(() => {
  const theme = viewer.getAttribute('theme');
  if ((theme === 'dark' || theme === 'light') && theme !== state.theme) setTheme(theme);
  const locale = viewer.getAttribute('locale');
  if ((locale === 'en' || locale === 'zh-CN') && locale !== state.locale) setLocale(locale);
}).observe(viewer, { attributes: true, attributeFilter: ['theme', 'locale'] });

// ── Start ──────────────────────────────────────────────────────────────────

applyTheme(state.theme);
applyLocale();
void selectDataset(params.get('dataset') ?? featuredFor(state.locale).id, 'url');
