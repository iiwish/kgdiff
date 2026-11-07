/**
 * The React 19 recipe of docs/guide/viewer.md (`GraphDiff.tsx`, the same code) rendered with
 * react-dom: props set as properties (objects included), the typed `onkgdiff-select`, methods
 * through the ref, and a re-render declaring the same panels keeping the reader's change.
 */
import type { KgdiffViewerElement } from '@kgdiff/viewer';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setRenderBackend } from '../../src/renderer-port.js';
import { mockBackend, tick, zoo } from '../support.js';
import { GraphDiff } from './GraphDiff.js';

declare global {
  // React's flag for tests that drive it through act().
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let root: Root;
let host: HTMLElement;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  setRenderBackend(mockBackend());
  localStorage.clear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.textContent = '';
  setRenderBackend(null);
});

const { before, after } = zoo();

async function ready(): Promise<KgdiffViewerElement> {
  const viewer = host.querySelector('kgdiff-viewer') as KgdiffViewerElement;
  await act(async () => {
    await new Promise<void>((resolve) =>
      viewer.addEventListener('kgdiff-ready', () => resolve(), { once: true }),
    );
  });
  await tick();
  return viewer;
}

describe('the React 19 recipe', () => {
  it('sets the props as properties, objects included, and the rest as attributes', async () => {
    act(() => root.render(<GraphDiff before={before} after={after} onSelect={() => {}} />));
    const viewer = await ready();
    expect(viewer.panels).toEqual({ detail: 'collapsed' });
    expect(viewer.keymap).toEqual({ x: null, r: 'review' });
    expect(viewer.getAttribute('theme')).toBe('auto');
    expect(viewer.layout.panels.detail).toBe('collapsed');
  });

  it('hears kgdiff-select through onkgdiff-select, typed, and calls methods through the ref', async () => {
    const onSelect = vi.fn();
    act(() => root.render(<GraphDiff before={before} after={after} onSelect={onSelect} />));
    const viewer = await ready();
    act(() => viewer.next());
    expect(onSelect).toHaveBeenCalledOnce();
    expect(onSelect.mock.calls[0]?.[0]).toBeTypeOf('string');
  });

  it('keeps what the reader changed when a re-render declares the same panels', async () => {
    const element = (onSelect: () => void) => (
      <GraphDiff before={before} after={after} onSelect={onSelect} />
    );
    act(() => root.render(element(() => {})));
    const viewer = await ready();
    // The reader opens the details from their bar.
    const bar = (viewer.shadowRoot as ShadowRoot).querySelector('.detail-bar') as HTMLButtonElement;
    act(() => bar.click());
    expect(viewer.layout.panels.detail).toBe('open');
    // A re-render: a new panels object, the same declaration.
    act(() => root.render(element(() => {})));
    expect(viewer.layout.panels.detail).toBe('open');
  });

  it('types the elements in JSX', () => {
    const typed = (
      <>
        <kgdiff-root id="r" mode="replay" loop onkgdiff-replay-end={(e) => e.detail.loop} />
        <kgdiff-stage version="before" htmlFor="r" />
        <kgdiff-minimap stage="s" />
        {/* @ts-expect-error: not a mode */}
        <kgdiff-viewer mode="sideways" />
        {/* @ts-expect-error: kgdiff-select's detail has no loop */}
        <kgdiff-root onkgdiff-select={(e) => e.detail.loop} />
        {/* @ts-expect-error: a read-only property */}
        <kgdiff-zoom stageElement={null} />
      </>
    );
    expect(typed).toBeTruthy();
  });
});
