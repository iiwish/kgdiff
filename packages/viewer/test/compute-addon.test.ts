/**
 * The standalone viewer without the compute add-on: reports work, `load()` explains what is
 * missing, out-of-layout groups are not expandable (and say why), and an add-on that arrives
 * later (`globalThis.KgdiffCompute`) is used without a reload.
 */
import { type DiffJSON, diff, diffToJSON, KgdiffError, packDiffJSON } from '@kgdiff/core';
import { layoutDiff, layoutFromJSON, layoutToJSON } from '@kgdiff/layout';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { computeStatus } from '../src/compute-loader.js';
import { ViewerController } from '../src/controller.js';
import { COMPUTE_GLOBAL, type ReportPayload } from '../src/index.js';
import { setRenderBackend } from '../src/renderer-port.js';
import { hub, manualDeps, mockBackend, recordingHost, zoo } from './support.js';

vi.mock('../src/compute.js', () => {
  throw new Error('not bundled in the standalone viewer');
});

async function report(): Promise<ReportPayload> {
  const { before, after } = hub(10);
  const d = await diff(before, after);
  const l = await layoutDiff(d, { largeGraphThreshold: 4, contextHops: 0 });
  return {
    format: 'kgdiff.report',
    version: 1,
    diff: diffToJSON(d),
    layout: layoutToJSON(l),
    meta: { generator: 'test', before: { name: 'a' }, after: { name: 'b' } },
  };
}

// The compute module itself (mocked away for the viewer), loaded once: the tests that reset the
// module registry hand it to fresh viewer modules as an add-on.
const computeModule =
  await vi.importActual<typeof import('../src/compute.js')>('../src/compute.js');
await computeModule.ready;

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[COMPUTE_GLOBAL];
  setRenderBackend(null);
});

describe('compute add-on', () => {
  it('reads packed report payloads (what the CLI writes) like unpacked ones', async () => {
    setRenderBackend(mockBackend());
    const plain = await report();
    const packed = { ...plain, diff: packDiffJSON(plain.diff as DiffJSON) };
    expect(packed.diff.format).toBe('kgdiff.diff.packed');
    const shown = async (payload: ReportPayload) => {
      const c = new ViewerController(recordingHost(), manualDeps());
      await c.loadPayload(payload);
      expect(c.status).toBe('ready');
      return { diff: diffToJSON(c.data!.diff), scene: c.scene!.nodes.map((n) => n.id) };
    };
    expect(await shown(packed)).toEqual(await shown(plain));
  });

  it('reads report payloads whose layout is version 2 (the Rust layout) without it', async () => {
    setRenderBackend(mockBackend());
    const v1 = await report();
    const { version: _, ...members } = layoutToJSON(layoutFromJSON(v1.layout!));
    const v2 = { ...v1, layout: { ...members, version: 2, generator: 'kgdiff-layout/1' } as const };
    const c = new ViewerController(recordingHost(), manualDeps());
    await c.loadPayload(v2);
    expect(c.status).toBe('ready');
    expect(c.layout?.generator).toBe('kgdiff-layout/1');
    // The layout the viewer holds is still the Rust layout: written back as version 2.
    expect(layoutToJSON(c.layout!)).toEqual(v2.layout);
  });

  it('reports work without it; load() rejects with an actionable KgdiffError', async () => {
    setRenderBackend(mockBackend());
    const c = new ViewerController(recordingHost(), manualDeps());
    await c.loadPayload(await report());
    expect(c.status).toBe('ready');
    const error = await c.load(zoo()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(KgdiffError);
    expect((error as Error).message).toMatch(/kgdiff-viewer-compute\.js/);
  });

  it('disables out-of-layout expansion until the add-on appears, then expands without reload', async () => {
    setRenderBackend(mockBackend());
    const c = new ViewerController(recordingHost(), manualDeps());
    c.attach(document.createElement('div'), null);
    await c.loadPayload(await report());
    await new Promise((r) => setTimeout(r, 0));
    expect(computeStatus()).toBe('unavailable');
    expect(c.focus?.collapsed.map((g) => g.id)).toEqual(['near:X']);
    expect(c.canExpand(0)).toBe(false);
    c.expandGroup(0);
    expect(c.layout?.positions.size).toBe(1);

    // The CLI inlines kgdiff-viewer-compute.js after the viewer bundle: it sets this global.
    // It is the compute module (here not mocked), its layout module compiled once it is set.
    const addon = await vi.importActual<typeof import('../src/compute.js')>('../src/compute.js');
    await addon.ready;
    (globalThis as Record<string, unknown>)[COMPUTE_GLOBAL] = addon;
    expect(computeStatus()).toBe('ready');
    expect(c.canExpand(0)).toBe(true);
    c.expandGroup(0);
    await new Promise((r) => setTimeout(r, 0));
    expect(c.layout?.positions.size).toBe(2);
    c.destroy();
  });
  it('expands a group asked for while the layout module compiles once it is ready', async () => {
    const actual = computeModule;
    // Fresh modules: the loader keeps the add-on it found first.
    vi.resetModules();
    const fresh = {
      ...(await import('../src/controller.js')),
      ...(await import('../src/compute-loader.js')),
      ...(await import('../src/renderer-port.js')),
    };
    fresh.setRenderBackend(mockBackend());
    const c = new fresh.ViewerController(recordingHost(), manualDeps());
    c.attach(document.createElement('div'), null);
    // An add-on whose layout module is still compiling (RFC 0002 §10: expanding waits for it).
    let state: 'pending' | 'ready' | 'failed' = 'pending';
    let compiled!: () => void;
    const ready = new Promise<void>((resolve) => {
      compiled = () => {
        state = 'ready';
        resolve();
      };
    });
    (globalThis as Record<string, unknown>)[COMPUTE_GLOBAL] = {
      ...actual,
      ready,
      layoutState: () => state,
    };
    await c.loadPayload(await report());
    expect(fresh.computeStatus()).toBe('unknown');
    expect(c.canExpand(0)).toBe(true);
    c.expandGroup(0);
    await new Promise((r) => setTimeout(r, 0));
    expect(c.layout?.positions.size).toBe(1);
    compiled();
    await new Promise((r) => setTimeout(r, 0));
    expect(fresh.computeStatus()).toBe('ready');
    expect(c.layout?.positions.size).toBe(2);
    c.destroy();
  });

  it('keeps a group collapsed when the layout module cannot compile (a strict CSP)', async () => {
    const actual = computeModule;
    await actual.ready;
    // Fresh modules: the loader keeps the add-on it found first.
    vi.resetModules();
    const fresh = {
      ...(await import('../src/controller.js')),
      ...(await import('../src/compute-loader.js')),
      ...(await import('../src/renderer-port.js')),
    };
    fresh.setRenderBackend(mockBackend());
    const c = new fresh.ViewerController(recordingHost(), manualDeps());
    c.attach(document.createElement('div'), null);
    const ready = Promise.reject(new Error('WebAssembly.compile(): refused by the CSP'));
    ready.catch(() => {});
    (globalThis as Record<string, unknown>)[COMPUTE_GLOBAL] = {
      ...actual,
      ready,
      layoutState: () => 'failed',
    };
    await c.loadPayload(await report());
    expect(fresh.computeStatus()).toBe('unavailable');
    expect(c.canExpand(0)).toBe(false);
    c.expandGroup(0);
    await new Promise((r) => setTimeout(r, 0));
    expect(c.layout?.positions.size).toBe(1);
    c.destroy();
  });
});
