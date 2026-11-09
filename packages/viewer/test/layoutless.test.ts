/**
 * Report payloads without a layout (RFC 0002 D-5: what the phase 3 Rust CLI writes) in the
 * standalone viewer, where the compute module is not bundled: without the add-on the viewer
 * says what is missing; with it (`globalThis.KgdiffCompute`, also when it arrives after the
 * viewer) the diff is laid out in the browser, and the diff engine never runs. Payloads with a
 * layout compute nothing.
 *
 * The loader keeps the add-on once it has found it, so the tests without it come first and the
 * add-on is one object (`compute`) whose spies are cleared before each test.
 */
import {
  type DiffJSON,
  diff,
  diffFromJSON,
  diffToJSON,
  KgdiffError,
  type PackedDiffJSON,
  packDiffJSON,
  unpackDiffJSON,
} from '@kgdiff/core';
import { extendLayout, layoutDiff, layoutToJSON } from '@kgdiff/layout';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeStatus } from '../src/compute-loader.js';
import { ViewerController } from '../src/controller.js';
import {
  COMPUTE_GLOBAL,
  hydrateEmbeddedPayloads,
  PAYLOAD_SCRIPT_TYPE,
  type ReportPayload,
} from '../src/index.js';
import { setRenderBackend } from '../src/renderer-port.js';
import { manualDeps, mockBackend, recordingHost, tick, until, zoo } from './support.js';

vi.mock('../src/compute.js', () => {
  throw new Error('not bundled in the standalone viewer');
});

const compute = {
  diff: vi.fn(diff),
  layoutDiff: vi.fn(layoutDiff),
  extendLayout: vi.fn(extendLayout),
};

/** What the CLI inlines after the viewer bundle (`kgdiff-viewer-compute.js`) sets. */
function addAddon(): void {
  (globalThis as Record<string, unknown>)[COMPUTE_GLOBAL] = compute;
}

/** A report with its layout (packed, as the CLI writes it). */
function report(): ReportPayload {
  const { before, after } = zoo();
  const d = diff(before, after);
  return {
    format: 'kgdiff.report',
    version: 1,
    diff: packDiffJSON(diffToJSON(d)),
    layout: layoutToJSON(layoutDiff(d)),
    meta: { generator: 'test', before: { name: 'zoo v1' }, after: { name: 'zoo v2' } },
    view: { mode: 'replay' },
  };
}

/** The same report without its layout. */
function layoutless(): ReportPayload {
  const { layout: _, ...rest } = report();
  return rest;
}

function controller(): ViewerController {
  return new ViewerController(recordingHost(), manualDeps());
}

beforeEach(() => {
  setRenderBackend(mockBackend());
  for (const spy of Object.values(compute)) spy.mockClear();
});
afterEach(() => {
  setRenderBackend(null);
  document.body.textContent = '';
});
afterAll(() => {
  delete (globalThis as Record<string, unknown>)[COMPUTE_GLOBAL];
});

describe('a payload without a layout, without the compute add-on', () => {
  it('fails with an error that says what is missing', async () => {
    const c = controller();
    const error = await c.loadPayload(layoutless()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(KgdiffError);
    expect(error).toMatchObject({ code: 'invalid-input' });
    expect((error as Error).message).toMatch(/no layout/);
    expect((error as Error).message).toMatch(/kgdiff-viewer-compute\.js/);
    expect(c.status).toBe('error');
    expect(c.error).toBe(error);
    expect(computeStatus()).toBe('unavailable');
  });

  it('shows that error in <kgdiff-viewer> when embedded', async () => {
    const v = document.createElement('kgdiff-viewer');
    const errors: Error[] = [];
    v.addEventListener('kgdiff-error', (e) =>
      errors.push((e as CustomEvent<{ error: Error }>).detail.error),
    );
    const script = document.createElement('script');
    script.type = PAYLOAD_SCRIPT_TYPE;
    script.textContent = JSON.stringify(layoutless());
    document.body.append(v, script);
    await hydrateEmbeddedPayloads();
    expect(v.payload?.layout).toBeUndefined();
    await until(() => errors.length > 0);
    expect(errors[0]?.message).toMatch(/no layout/);
    await tick();
    const card = v.shadowRoot?.querySelector('.state-card.error');
    expect(card?.getAttribute('role')).toBe('alert');
    expect(card?.textContent).toContain('could not be shown');
    expect(card?.querySelector('p')?.textContent).toMatch(/kgdiff-viewer-compute\.js/);
  });

  it('a payload with a layout still opens', async () => {
    const c = controller();
    await c.loadPayload(report());
    expect(c.status).toBe('ready');
  });
});

describe('a payload without a layout, with the compute add-on', () => {
  it('opens once the add-on arrives after the error, without a reload', async () => {
    const c = controller();
    await c.loadPayload(layoutless()).catch(() => {});
    expect(c.status).toBe('error');
    addAddon();
    await c.loadPayload(layoutless());
    expect(c.status).toBe('ready');
  });

  it('is laid out as layoutDiff lays it out, without running the diff engine', async () => {
    addAddon();
    const c = controller();
    const payload = layoutless();
    await c.loadPayload(payload);
    expect(c.status).toBe('ready');
    expect(compute.diff).not.toHaveBeenCalled();
    expect(compute.layoutDiff).toHaveBeenCalledTimes(1);
    const d = diffFromJSON(unpackDiffJSON(payload.diff as PackedDiffJSON));
    expect(layoutToJSON(c.layout!)).toEqual(layoutToJSON(layoutDiff(d)));
    expect(diffToJSON(c.data!.diff)).toEqual(diffToJSON(d));
    expect(c.data?.layoutOptions).toBeUndefined();
    // The rest of the payload applies as with a layout.
    expect(c.mode).toBe('replay');
  });

  it('is shown like the same payload with its layout', async () => {
    addAddon();
    const shown = async (payload: ReportPayload) => {
      const c = controller();
      await c.loadPayload(payload);
      return {
        diff: diffToJSON(c.data!.diff),
        layout: layoutToJSON(c.layout!),
        scene: c.scene!.nodes.map((n) => [n.id, n.x, n.y]),
      };
    };
    expect(await shown(layoutless())).toEqual(await shown(report()));
  });

  it('reads unpacked diffs too', async () => {
    addAddon();
    const c = controller();
    const payload = layoutless();
    await c.loadPayload({ ...payload, diff: unpackDiffJSON(payload.diff as PackedDiffJSON) });
    expect(c.status).toBe('ready');
    expect(compute.layoutDiff).toHaveBeenCalledTimes(1);
  });

  it('a payload with a layout computes nothing, even with the add-on present', async () => {
    addAddon();
    const c = controller();
    await c.loadPayload(report());
    expect(c.status).toBe('ready');
    expect(compute.diff).not.toHaveBeenCalled();
    expect(compute.layoutDiff).not.toHaveBeenCalled();
    expect(compute.extendLayout).not.toHaveBeenCalled();
  });

  it('a payload whose diff does not read fails with that error', async () => {
    addAddon();
    const c = controller();
    const broken = { ...layoutless(), diff: { format: 'kgdiff.diff', version: 1 } as DiffJSON };
    await expect(c.loadPayload(broken)).rejects.toBeInstanceOf(KgdiffError);
    expect(c.status).toBe('error');
    expect(c.error?.message).not.toMatch(/no layout/);
    expect(compute.layoutDiff).not.toHaveBeenCalled();
  });
});
