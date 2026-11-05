/**
 * The standalone viewer without the compute add-on: reports work, `load()` explains what is
 * missing, out-of-layout groups are not expandable (and say why), and an add-on that arrives
 * later (`globalThis.KgdiffCompute`) is used without a reload.
 */
import { type DiffJSON, diff, diffToJSON, KgdiffError, packDiffJSON } from '@kgdiff/core';
import { extendLayout, layoutDiff, layoutToJSON } from '@kgdiff/layout';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { computeStatus } from '../src/compute-loader.js';
import { ViewerController } from '../src/controller.js';
import { COMPUTE_GLOBAL, type ReportPayload } from '../src/index.js';
import { setRenderBackend } from '../src/renderer-port.js';
import { hub, manualDeps, mockBackend, recordingHost, zoo } from './support.js';

vi.mock('../src/compute.js', () => {
  throw new Error('not bundled in the standalone viewer');
});

function report(): ReportPayload {
  const { before, after } = hub(10);
  const d = diff(before, after);
  const l = layoutDiff(d, { largeGraphThreshold: 4, contextHops: 0 });
  return {
    format: 'kgdiff.report',
    version: 1,
    diff: diffToJSON(d),
    layout: layoutToJSON(l),
    meta: { generator: 'test', before: { name: 'a' }, after: { name: 'b' } },
  };
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[COMPUTE_GLOBAL];
  setRenderBackend(null);
});

describe('compute add-on', () => {
  it('reads packed report payloads (what the CLI writes) like unpacked ones', async () => {
    setRenderBackend(mockBackend());
    const plain = report();
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

  it('reports work without it; load() rejects with an actionable KgdiffError', async () => {
    setRenderBackend(mockBackend());
    const c = new ViewerController(recordingHost(), manualDeps());
    await c.loadPayload(report());
    expect(c.status).toBe('ready');
    const error = await c.load(zoo()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(KgdiffError);
    expect((error as Error).message).toMatch(/kgdiff-viewer-compute\.js/);
  });

  it('disables out-of-layout expansion until the add-on appears, then expands without reload', async () => {
    setRenderBackend(mockBackend());
    const c = new ViewerController(recordingHost(), manualDeps());
    c.attach(document.createElement('div'), null);
    await c.loadPayload(report());
    await new Promise((r) => setTimeout(r, 0));
    expect(computeStatus()).toBe('unavailable');
    expect(c.focus?.collapsed.map((g) => g.id)).toEqual(['near:X']);
    expect(c.canExpand(0)).toBe(false);
    c.expandGroup(0);
    expect(c.layout?.positions.size).toBe(1);

    // The CLI inlines kgdiff-viewer-compute.js after the viewer bundle: it sets this global.
    (globalThis as Record<string, unknown>)[COMPUTE_GLOBAL] = { diff, layoutDiff, extendLayout };
    expect(computeStatus()).toBe('ready');
    expect(c.canExpand(0)).toBe(true);
    c.expandGroup(0);
    await new Promise((r) => setTimeout(r, 0));
    expect(c.layout?.positions.size).toBe(2);
    c.destroy();
  });
});
