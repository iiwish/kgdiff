/**
 * The Svelte 5 recipe of docs/guide/viewer.md (`GraphDiff.svelte`, the same code), compiled with
 * Svelte's compiler and mounted: props set as properties (objects included), the
 * `onkgdiff-select` attribute listening, `bind:this` for methods.
 */
import type { KgdiffViewerElement } from '@kgdiff/viewer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setRenderBackend } from '../../src/renderer-port.js';
import { mockBackend, tick, zoo } from '../support.js';
import { compileSvelte } from './frameworks.js';

beforeEach(() => {
  setRenderBackend(mockBackend());
  localStorage.clear();
});

afterEach(() => {
  document.body.textContent = '';
  setRenderBackend(null);
});

describe('the Svelte 5 recipe', () => {
  it('sets objects as properties, hears kgdiff-select and loads through bind:this', async () => {
    const { default: GraphDiff } = await import(/* @vite-ignore */ compileSvelte());
    const { mount, unmount, flushSync } = await import('svelte');
    const { before, after } = zoo();
    const onselect = vi.fn();
    const target = document.createElement('div');
    document.body.append(target);
    const component = mount(GraphDiff, { target, props: { before, after, onselect } });
    flushSync();
    const viewer = target.querySelector('kgdiff-viewer') as KgdiffViewerElement;
    await new Promise<void>((resolve) =>
      viewer.addEventListener('kgdiff-ready', () => resolve(), { once: true }),
    );
    await tick();
    expect(viewer.panels).toEqual({ detail: 'collapsed' });
    expect(viewer.keymap).toEqual({ x: null, r: 'review' });
    expect(viewer.getAttribute('theme')).toBe('auto');
    viewer.next();
    expect(onselect).toHaveBeenCalledOnce();
    expect(onselect.mock.calls[0]?.[0]).toBeTypeOf('string');
    unmount(component);
  });
});
