/**
 * The compute part of the viewer, loaded on demand (`compute-loader.ts`): kgdiff's engine compiled
 * to WebAssembly (`@kgdiff/compute`). Reports with a layout never load it; the ESM build gets it
 * as a separate chunk, the standalone viewer from the `kgdiff-viewer-compute.js` add-on.
 *
 * - Layouts (`layoutDiff`, and `extendLayout` when a collapsed group of a `changes`-scoped layout
 *   is expanded) run on the layout-only module, which starts compiling as soon as this module is
 *   loaded (`ready`). The add-on carries that module inlined, so a single-file report expands
 *   groups offline.
 * - `diff` (`load()` with graphs) runs on the full engine, loaded and compiled on first use
 *   through `@kgdiff/core`. Parsing text does not come through here: `pipeline.ts` imports
 *   `@kgdiff/compute` for it.
 */
import { extendLayoutSync, init, layoutDiffSync } from '@kgdiff/compute/layout';
import type { DiffResult, UnionId } from '@kgdiff/core';
import type { LayoutOptions, LayoutResult } from '@kgdiff/layout';

export { diff } from '@kgdiff/core';

let state: 'pending' | 'ready' | 'failed' = 'pending';

/**
 * Settles once the layout module is compiled: rejects when it cannot be (a Content Security
 * Policy without `'wasm-unsafe-eval'`, a module that cannot be fetched).
 */
export const ready: Promise<void> = init().then(
  () => {
    state = 'ready';
  },
  (error: unknown) => {
    state = 'failed';
    throw error;
  },
);
// Read through `layoutState`; a failure is reported where the layout is needed.
ready.catch(() => {});

/** Whether the layout module is compiled (`ready`), still compiling, or failed to compile. */
export function layoutState(): 'pending' | 'ready' | 'failed' {
  return state;
}

/** `layoutDiff` of `@kgdiff/layout` on the layout module, once it is compiled. */
export async function layoutDiff(diff: DiffResult, options?: LayoutOptions): Promise<LayoutResult> {
  await ready;
  return layoutDiffSync(diff, options);
}

/**
 * `extendLayout` of `@kgdiff/layout`, synchronously: only once `ready` has resolved
 * (`layoutState()` is `ready`), else it throws.
 */
export function extendLayout(
  diff: DiffResult,
  layout: LayoutResult,
  nodes: readonly UnionId[],
  options?: LayoutOptions,
): LayoutResult {
  return extendLayoutSync(diff, layout, nodes, options);
}
