/**
 * The Vue 3 recipe of docs/guide/viewer.md (`GraphDiff.vue`, the same code), compiled with
 * Vue's SFC compiler and mounted: `isCustomElement`, `.prop` bindings for objects, the
 * `@kgdiff-select` listener, the ref for methods.
 */
import type { KgdiffViewerElement } from '@kgdiff/viewer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type App, createApp, h, nextTick } from 'vue';
import { setRenderBackend } from '../../src/renderer-port.js';
import { mockBackend, tick, zoo } from '../support.js';
import { compileVue } from './frameworks.js';

let app: App | null = null;

beforeEach(() => {
  setRenderBackend(mockBackend());
  localStorage.clear();
});

afterEach(() => {
  app?.unmount();
  app = null;
  document.body.textContent = '';
  setRenderBackend(null);
});

describe('the Vue 3 recipe', () => {
  it('binds objects as properties, hears kgdiff-select and loads through the ref', async () => {
    const { default: GraphDiff } = await import(/* @vite-ignore */ compileVue());
    const { before, after } = zoo();
    const onSelect = vi.fn();
    const host = document.createElement('div');
    document.body.append(host);
    app = createApp({ render: () => h(GraphDiff, { before, after, onSelect }) });
    app.mount(host);
    await nextTick();
    const viewer = host.querySelector('kgdiff-viewer') as KgdiffViewerElement;
    await new Promise<void>((resolve) =>
      viewer.addEventListener('kgdiff-ready', () => resolve(), { once: true }),
    );
    await tick();
    expect(viewer.panels).toEqual({ detail: 'collapsed' });
    expect(viewer.keymap).toEqual({ x: null, r: 'review' });
    expect(viewer.getAttribute('theme')).toBe('auto');
    expect(viewer.layout.panels.detail).toBe('collapsed');
    viewer.next();
    expect(onSelect).toHaveBeenCalledOnce();
    expect(onSelect.mock.calls[0]?.[0]).toBeTypeOf('string');
  });
});
