/**
 * The two live viewers of the landing page. Both get a payload precomputed at build time
 * (`virtual:kgdiff/payload/<id>`), so the page never ships parsers, the diff engine or the
 * force layout. The element itself comes from the viewer's standalone bundle — the exact file
 * HTML reports inline (report path only: core JSON transport, scene, renderer, UI) — which is
 * smaller than the ESM graph, whose shared chunk also carries the diff engine. The bundle and
 * the payload load in parallel, on demand.
 *
 * - Hero: the featured dataset of the current language; replays once when it first comes into
 *   view (not with reduced motion, not after the user touched it), pauses when scrolled away.
 * - Views demo: one viewer whose mode follows the tab strip (and vice versa).
 */

import { viewerUrl } from 'virtual:kgdiff/standalone';
import type { Locale } from '@kgdiff/core';
import type { KgdiffViewerElement, ReportPayload, ViewerMode, ViewerScope } from '@kgdiff/viewer';
import { type Dataset, datasetById } from '../shared/datasets.js';
import { prefersReducedMotion } from '../shared/dom.js';
import type { SiteTheme } from '../shared/prefs.js';
import { onViewer } from '../shared/viewer-events.js';

type PayloadModule = { readonly default: ReportPayload };

const PAYLOADS: Readonly<Record<string, () => Promise<PayloadModule>>> = {
  'enterprise-kg': () => import('virtual:kgdiff/payload/enterprise-kg'),
  'enterprise-kg-en': () => import('virtual:kgdiff/payload/enterprise-kg-en'),
  'ontology-release': () => import('virtual:kgdiff/payload/ontology-release'),
  'schema-vocab': () => import('virtual:kgdiff/payload/schema-vocab'),
  'data-lineage': () => import('virtual:kgdiff/payload/data-lineage'),
};

let viewerModule: Promise<void> | null = null;

/** Define `<kgdiff-viewer>` (once) by loading the standalone bundle. */
export function loadViewerModule(): Promise<void> {
  viewerModule ??= new Promise<void>((resolve, reject) => {
    if (customElements.get('kgdiff-viewer')) {
      resolve();
      return;
    }
    const script = document.createElement('script');
    script.src = viewerUrl;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      viewerModule = null;
      reject(new Error(`Could not load the viewer (${viewerUrl}).`));
    };
    document.head.append(script);
  });
  return viewerModule;
}

/** A dataset's payload with its title in `locale` (the payload itself is language-neutral). */
async function localizedPayload(dataset: Dataset, locale: Locale): Promise<ReportPayload> {
  const load = PAYLOADS[dataset.id];
  if (!load) throw new Error(`No precomputed payload for "${dataset.id}".`);
  const payload = (await load()).default;
  const title = dataset.title[locale] ?? dataset.title.en;
  return {
    ...payload,
    meta: {
      ...payload.meta,
      title,
      before: { ...payload.meta.before, name: title },
      after: { ...payload.meta.after, name: title },
    },
  };
}

export interface LiveViewer {
  readonly element: KgdiffViewerElement;
  /** Show `dataset` (no-op when it is already shown in this language). */
  show(dataset: Dataset, locale: Locale): Promise<void>;
  setTheme(theme: SiteTheme): void;
  setLocale(locale: Locale): void;
}

/** Wrap a `<kgdiff-viewer>` that sits in a `.window` frame (state drives the skeleton). */
export function liveViewer(
  element: KgdiffViewerElement,
  frame: HTMLElement,
  initial: { readonly theme: SiteTheme; readonly locale: Locale },
): LiveViewer {
  // Attributes before the element is upgraded: the first render is already right.
  element.setAttribute('theme', initial.theme);
  element.setAttribute('locale', initial.locale);
  element.addEventListener('kgdiff-ready', () => {
    frame.dataset.state = 'ready';
  });
  element.addEventListener('kgdiff-error', () => {
    frame.dataset.state = 'error';
  });
  let shown = '';
  return {
    element,
    async show(dataset, locale) {
      const key = `${dataset.id}|${locale}`;
      if (key === shown) return;
      shown = key;
      try {
        const [payload] = await Promise.all([
          localizedPayload(dataset, locale),
          loadViewerModule(),
        ]);
        if (shown !== key) return;
        element.payload = payload;
      } catch (error) {
        // Offline or blocked: say so in the frame instead of a skeleton that never resolves.
        shown = '';
        frame.dataset.state = 'error';
        frame.dataset.error = error instanceof Error ? error.message : String(error);
      }
    },
    setTheme(theme) {
      element.theme = theme;
    },
    setLocale(locale) {
      element.locale = locale;
    },
  };
}

/**
 * Replay the hero once when at least 40% of it is visible. Cancelled by any interaction
 * with the viewer before it starts; paused (not resumed) when the hero leaves the viewport,
 * so an off-screen canvas never keeps animating.
 */
export function autoplayOnce(viewer: KgdiffViewerElement, frame: HTMLElement): void {
  if (prefersReducedMotion()) return;
  let ready = false;
  let visible = false;
  let state: 'waiting' | 'scheduled' | 'playing' | 'done' = 'waiting';
  let timer = 0;
  const cancel = (): void => {
    if (state === 'scheduled') window.clearTimeout(timer);
    state = 'done';
  };
  for (const type of ['pointerdown', 'wheel', 'keydown'] as const) {
    viewer.addEventListener(type, cancel, { capture: true, passive: true });
  }
  onViewer(viewer, 'kgdiff-mode', (e) => {
    if (e.detail.mode !== 'replay') cancel();
  });
  const maybeStart = (): void => {
    if (state !== 'waiting' || !ready || !visible) return;
    state = 'scheduled';
    // Let the reader see the "before" picture for a moment first.
    timer = window.setTimeout(() => {
      if (state !== 'scheduled') return;
      state = 'playing';
      viewer.play();
    }, 900);
  };
  viewer.addEventListener('kgdiff-ready', () => {
    ready = true;
    maybeStart();
  });
  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        visible = entry.isIntersecting && entry.intersectionRatio >= 0.4;
        if (visible) maybeStart();
        else if (state === 'scheduled') {
          window.clearTimeout(timer);
          state = 'waiting';
        } else if (state === 'playing') {
          viewer.pause();
          state = 'done';
          io.disconnect();
        }
      }
    },
    { threshold: [0, 0.4] },
  );
  io.observe(frame);
}

/** Call `fn` once `el` comes within `margin` of the viewport. */
export function whenNear(el: Element, fn: () => void, margin = '600px'): void {
  if (typeof IntersectionObserver !== 'function') {
    fn();
    return;
  }
  const io = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        io.disconnect();
        fn();
      }
    },
    { rootMargin: margin },
  );
  io.observe(el);
}

export const MODES_DATASET = 'data-lineage';

export function modesDataset(): Dataset {
  const d = datasetById(MODES_DATASET);
  if (!d) throw new Error(`Missing dataset ${MODES_DATASET}`);
  return d;
}

/** The views demo's tabs: the three modes over the whole graph, and the changes scope. */
export type ViewTab = ViewerMode | 'changes';

export function isViewTab(value: string | undefined): value is ViewTab {
  return value === 'overlay' || value === 'swipe' || value === 'replay' || value === 'changes';
}

/** The tab showing a view: the changes scope in overlay is “changes”, anything else its mode. */
export function viewTab(mode: ViewerMode, scope: ViewerScope): ViewTab {
  return scope === 'changes' && mode === 'overlay' ? 'changes' : mode;
}
