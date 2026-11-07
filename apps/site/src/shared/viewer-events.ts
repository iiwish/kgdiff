import type { KgdiffEventMap, KgdiffViewerElement } from '@kgdiff/viewer';

/** Typed `addEventListener` for the viewer's `kgdiff-*` events. */
export function onViewer<K extends keyof KgdiffEventMap>(
  viewer: KgdiffViewerElement,
  type: K,
  listener: (event: KgdiffEventMap[K]) => void,
): void {
  viewer.addEventListener(type, (event) => listener(event as KgdiffEventMap[K]));
}
