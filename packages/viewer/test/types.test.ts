/**
 * Type-level checks (run by `pnpm typecheck`, which compiles the tests): the kgdiff events are
 * in the global event maps, so listeners get a typed `detail` without casts.
 */
import type { DiffStats } from '@kgdiff/core';
import { describe, expectTypeOf, it } from 'vitest';
import type {
  KgdiffEventMap,
  KgdiffViewerEventMap,
  ReviewState,
  ViewerLayout,
  ViewerMode,
} from '../src/index.js';

describe('event types', () => {
  it('type event.detail on any element, the document and the window', () => {
    const div = document.createElement('div');
    div.addEventListener('kgdiff-select', (e) => {
      expectTypeOf(e.detail.hunk).toEqualTypeOf<string | null>();
      expectTypeOf(e.detail.node).toEqualTypeOf<string | null>();
    });
    document.addEventListener('kgdiff-layout', (e) => {
      expectTypeOf(e.detail).toEqualTypeOf<ViewerLayout & { readonly source: 'user' | 'host' }>();
    });
    window.addEventListener('kgdiff-ready', (e) => {
      expectTypeOf(e.detail.stats).toEqualTypeOf<DiffStats>();
    });
    const viewer = document.createElement('kgdiff-viewer');
    viewer.addEventListener('kgdiff-review', (e) => {
      expectTypeOf(e.detail.progress).toEqualTypeOf<ReviewState>();
    });
    document.createElement('kgdiff-root').addEventListener('kgdiff-mode', (e) => {
      expectTypeOf(e.detail.mode).toEqualTypeOf<ViewerMode>();
    });
    // @ts-expect-error: kgdiff-select has no `stats`.
    div.addEventListener('kgdiff-select', (e) => e.detail.stats);
    expectTypeOf<KgdiffViewerEventMap>().toEqualTypeOf<KgdiffEventMap>();
  });
});
