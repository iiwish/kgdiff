/**
 * Landing page. Static content is in index.html (English); this module adds the Chinese
 * translation, theme, copy buttons, tabs, the live viewers (loaded on demand), the terminal and
 * Markdown renderings of real CLI output, and the dataset cards.
 */

import stats from 'virtual:kgdiff/stats';
import type { Locale } from '@kgdiff/core';
import type { ChangeFamily } from '@kgdiff/scene';
import type { KgdiffViewerElement } from '@kgdiff/viewer';
import { type Dataset, datasetsFor, featuredFor, formatLabel } from '../shared/datasets.js';
import {
  byId,
  h,
  setSelectedTab,
  toast,
  useIcon,
  wireCopyButtons,
  wireTablist,
} from '../shared/dom.js';
import { highlightAll } from '../shared/highlight.js';
import { applyDocumentLocale, format, translateDom } from '../shared/i18n.js';
import {
  applyTheme,
  initialLocale,
  initialTheme,
  localizedHref,
  type SiteTheme,
  storeLocale,
  storeTheme,
  syncLangParam,
} from '../shared/prefs.js';
import { onViewer } from '../shared/viewer-events.js';
import { scopeViewerShortcuts } from '../shared/viewer-focus.js';
import { renderMarkdown } from './markdown.js';
import { TEXT, ZH } from './strings.js';
import { renderAnsi } from './terminal.js';
import {
  autoplayOnce,
  isViewTab,
  type LiveViewer,
  liveViewer,
  loadViewerModule,
  modesDataset,
  viewTab,
  whenNear,
} from './viewers.js';

const FAMILIES: readonly ChangeFamily[] = ['removed', 'identity', 'structure', 'content', 'added'];

const state: { locale: Locale; theme: SiteTheme } = {
  locale: initialLocale(),
  theme: initialTheme(),
};

const text = (): (typeof TEXT)[Locale] => TEXT[state.locale];

// ── Viewers ────────────────────────────────────────────────────────────────

const heroEl = byId<KgdiffViewerElement>('hero-viewer');
const heroFrame = byId('hero-window');
const modesEl = byId<KgdiffViewerElement>('modes-viewer');
const modesFrame = byId('modes-window');

// The hero opens in replay (it is about to play) unless motion is reduced; the sidebar folds
// away on small screens.
const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
heroEl.setAttribute('mode', reduced ? 'overlay' : 'replay');
if (window.innerWidth < 1024) heroEl.setAttribute('sidebar', 'closed');

const hero: LiveViewer = liveViewer(heroEl, heroFrame, state);
const modes: LiveViewer = liveViewer(modesEl, modesFrame, state);
let modesStarted = false;

scopeViewerShortcuts([heroEl, modesEl]);
autoplayOnce(heroEl, heroFrame);

function showHero(): void {
  const dataset = featuredFor(state.locale);
  byId('hero-dataset-title').textContent = dataset.title[state.locale];
  const link = document.querySelector<HTMLAnchorElement>('[data-hero-link]');
  if (link) {
    link.href = localizedHref(`playground.html?dataset=${dataset.id}&mode=replay`, state.locale);
  }
  void hero.show(dataset, state.locale);
}

function showModes(): void {
  const dataset = modesDataset();
  const link = byId<HTMLAnchorElement>('modes-dataset-link');
  link.textContent = dataset.title[state.locale];
  link.href = localizedHref(`playground.html?dataset=${dataset.id}`, state.locale);
  if (modesStarted) void modes.show(dataset, state.locale);
}

// Start loading the viewer module right away (it is above the fold).
void loadViewerModule();
whenNear(modesFrame, () => {
  modesStarted = true;
  showModes();
});

// ── Views tab strip ↔ viewer mode ──────────────────────────────────────────

const modeTabs = document.querySelector<HTMLElement>('.mode-tabs');
const modePanel = byId('modes-panel');

function showModeTab(mode: string): void {
  if (!modeTabs) return;
  const tab = modeTabs.querySelector<HTMLButtonElement>(`[data-mode="${mode}"]`);
  if (!tab) return;
  setSelectedTab(modeTabs, tab);
  modePanel.setAttribute('aria-labelledby', tab.id);
  for (const desc of modePanel.querySelectorAll<HTMLElement>('[data-mode-desc]')) {
    desc.hidden = desc.dataset.modeDesc !== mode;
  }
}

if (modeTabs) {
  wireTablist(modeTabs, (tab) => {
    const mode = tab.dataset.mode;
    if (!isViewTab(mode)) return;
    showModeTab(mode);
    modesEl.setAttribute('mode', mode === 'changes' ? 'overlay' : mode);
    modesEl.setAttribute('scope', mode === 'changes' ? 'changes' : 'all');
    if (mode === 'replay' && !reduced && modesFrame.dataset.state === 'ready') modesEl.play();
  });
}
onViewer(modesEl, 'kgdiff-mode', (e) => showModeTab(viewTab(e.detail.mode, e.detail.scope)));

// ── Integration tabs ───────────────────────────────────────────────────────

const intTabs = document.querySelector<HTMLElement>('.int-tabs');
if (intTabs) {
  wireTablist(intTabs, (tab) => {
    setSelectedTab(intTabs, tab);
    for (const panel of document.querySelectorAll<HTMLElement>('.int-panel')) {
      panel.hidden = panel.id !== tab.getAttribute('aria-controls');
    }
  });
}

// ── CLI: terminal + Markdown (real snapshots, loaded when near) ────────────

const snapshots = import.meta.glob<string>(
  [
    '../../../../crates/kgdiff/tests/snapshots/*.summary.color.ansi',
    '../../../../crates/kgdiff/tests/snapshots/*.markdown.md.snap',
  ],
  { query: '?raw', import: 'default' },
);

function snapshot(name: string): Promise<string> {
  const load = snapshots[`../../../../crates/kgdiff/tests/snapshots/${name}`];
  return load ? load() : Promise.reject(new Error(`Missing CLI snapshot ${name}`));
}

let cliVisible = false;
let cliToken = 0;

async function renderCli(): Promise<void> {
  if (!cliVisible) return;
  const token = ++cliToken;
  const zh = state.locale === 'zh-CN';
  const id = zh ? 'enterprise-kg' : 'ontology-release';
  const [ansi, md] = await Promise.all([
    snapshot(`${id}.summary.color.ansi`),
    snapshot(`${id}.markdown.md.snap`),
  ]);
  if (token !== cliToken) return;
  byId('term-cmd').textContent = zh ? text().termCmdJson : text().termCmdObo;
  byId('term-out').replaceChildren(renderAnsi(ansi.replace(/\n+$/, '')));
  byId('md-body').replaceChildren(renderMarkdown(md));
}

whenNear(byId('cli'), () => {
  cliVisible = true;
  void renderCli();
});

// ── Dataset cards ──────────────────────────────────────────────────────────

function datasetCard(d: Dataset): HTMLLIElement {
  const s = stats.find((x) => x.id === d.id);
  const t = text();
  const locale = state.locale;
  const bar = h('div', { class: 'ds-bar', 'aria-hidden': 'true' });
  const famList = h('span', { class: 'ds-fams' });
  if (s) {
    for (const f of FAMILIES) {
      const n = s.families[f];
      if (n <= 0) continue;
      const seg = h('span', { class: 'ds-seg', 'data-family': f });
      seg.style.flexGrow = String(n);
      bar.append(seg);
    }
  }
  const nodes = s
    ? s.nodes.before === s.nodes.after
      ? format(t.nodesSame, { n: s.nodes.after })
      : format(t.nodes, { a: s.nodes.before, b: s.nodes.after })
    : '';
  const famStats = s
    ? FAMILIES.filter((f) => s.families[f] > 0).map((f) =>
        h(
          'span',
          { class: 'fam', 'data-family': f, title: t.family[f] },
          h('span', { class: 'dot', 'aria-hidden': 'true' }),
          `${s.families[f]}`,
          h('span', { class: 'sr-only' }, ` ${t.family[f]}`),
        ),
      )
    : [];
  famList.append(...famStats);
  const versions = d.versions ? `${d.versions.before ?? ''} → ${d.versions.after ?? ''}` : '';
  const href = localizedHref(`playground.html?dataset=${d.id}`, locale);
  const card = h(
    'a',
    { class: 'ds-card', href },
    h(
      'div',
      { class: 'ds-top' },
      h('span', { class: 'ds-format' }, formatLabel(d.format)),
      d.featured ? h('span', { class: 'ds-featured' }, `★ ${t.featured}`) : null,
      h('span', { class: 'ds-versions' }, versions),
    ),
    h('h3', { class: 'ds-title' }, d.title[locale]),
    h('p', { class: 'ds-desc' }, d.description[locale]),
    h(
      'div',
      { class: 'ds-stats' },
      s ? h('span', {}, format(t.changes, { n: s.hunks })) : null,
      famList,
    ),
    bar,
    h(
      'div',
      { class: 'ds-foot' },
      h('span', {}, nodes),
      h('span', { class: 'ds-open' }, t.open, useIcon('i-arrow', 'i nudge')),
    ),
  );
  return h('li', {}, card);
}

function renderDatasets(): void {
  byId('dataset-list').replaceChildren(...datasetsFor(state.locale).map(datasetCard));
}

// ── Language, theme, chrome ────────────────────────────────────────────────

function updateLocaleLinks(): void {
  for (const a of document.querySelectorAll<HTMLAnchorElement>('a[data-locale-link]')) {
    if (a.hasAttribute('data-hero-link') || a.id === 'modes-dataset-link') continue;
    a.href = localizedHref(a.getAttribute('href') ?? 'playground.html', state.locale);
  }
  // Docs pages translated into Chinese live under docs/zh/; the concept documents are English only.
  for (const a of document.querySelectorAll<HTMLAnchorElement>('a[data-docs-link]')) {
    const page = a.dataset.docsLink ?? '';
    a.setAttribute('href', state.locale === 'en' ? `docs/${page}` : `docs/zh/${page}`);
  }
}

function updateToggles(): void {
  const t = text();
  const lang = document.querySelector<HTMLButtonElement>('[data-action="locale"]');
  if (lang) {
    lang.textContent = t.langLabel;
    lang.setAttribute('aria-label', t.langSwitch);
    lang.lang = state.locale === 'en' ? 'zh-CN' : 'en';
  }
  const theme = document.querySelector<HTMLButtonElement>('[data-action="theme"]');
  theme?.setAttribute('aria-label', state.theme === 'dark' ? t.themeLight : t.themeDark);
}

/** The comparison table's icons are CSS; give each cell its state in words for screen readers. */
function labelCompareCells(): void {
  const words = text().support;
  for (const td of document.querySelectorAll<HTMLTableCellElement>('.compare td[data-v]')) {
    const v = td.dataset.v;
    if (v !== 'yes' && v !== 'partial' && v !== 'no') continue;
    let sr = td.querySelector<HTMLElement>('.v-sr');
    if (!sr) {
      sr = h('span', { class: 'sr-only v-sr' });
      td.prepend(sr);
    }
    sr.textContent = td.childElementCount > 1 ? `${words[v]}: ` : words[v];
  }
}

function applyLocale(): void {
  translateDom(state.locale, state.locale === 'en' ? {} : ZH);
  applyDocumentLocale(state.locale, {
    title: text().docTitle,
    description: text().docDescription,
  });
  updateToggles();
  updateLocaleLinks();
  labelCompareCells();
  renderDatasets();
  showHero();
  showModes();
  hero.setLocale(state.locale);
  modes.setLocale(state.locale);
  void renderCli();
}

function setLocale(locale: Locale): void {
  if (locale === state.locale) return;
  state.locale = locale;
  storeLocale(locale);
  syncLangParam(locale);
  applyLocale();
}

function setTheme(theme: SiteTheme): void {
  state.theme = theme;
  storeTheme(theme);
  applyTheme(theme);
  hero.setTheme(theme);
  modes.setTheme(theme);
  updateToggles();
}

document.addEventListener('click', (event) => {
  const button = (event.target as Element | null)?.closest<HTMLElement>('[data-action]');
  if (!button) return;
  if (button.dataset.action === 'locale') setLocale(state.locale === 'en' ? 'zh-CN' : 'en');
  else if (button.dataset.action === 'theme') setTheme(state.theme === 'dark' ? 'light' : 'dark');
});

wireCopyButtons(document, (ok) =>
  toast(ok ? text().copied : text().copyFailed, ok ? 'ok' : 'error'),
);

// Nav hairline once the page scrolls.
const nav = byId('nav');
const onScroll = (): void => {
  nav.toggleAttribute('data-scrolled', window.scrollY > 8);
};
window.addEventListener('scroll', onScroll, { passive: true });
onScroll();

highlightAll();
applyTheme(state.theme);
applyLocale();
