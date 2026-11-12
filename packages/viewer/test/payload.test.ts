import { diff, diffToJSON } from '@kgdiff/core';
import { layoutDiff, layoutToJSON } from '@kgdiff/layout';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KgdiffViewer } from '../src/element.js';
import { hydrateEmbeddedPayloads, PAYLOAD_SCRIPT_TYPE, type ReportPayload } from '../src/index.js';
import { assertPayload, decodePayloadText } from '../src/payload.js';
import { setRenderBackend } from '../src/renderer-port.js';
import { mockBackend, until, zoo } from './support.js';

async function payload(): Promise<ReportPayload> {
  const { before, after } = zoo();
  const d = await diff(before, after);
  return {
    format: 'kgdiff.report',
    version: 1,
    diff: diffToJSON(d),
    layout: layoutToJSON(await layoutDiff(d)),
    meta: { generator: 'test', before: { name: 'zoo v1' }, after: { name: 'zoo v2' } },
    view: { mode: 'replay', locale: 'zh-CN' },
  };
}

/** The zoo with every node of the after version a `Bird`. */
async function typed(): Promise<ReportPayload> {
  const { before, after } = zoo();
  const birds = { ...after, nodes: after.nodes.map((n) => ({ ...n, types: ['Bird'] })) };
  const d = await diff(before, birds);
  return {
    format: 'kgdiff.report',
    version: 1,
    diff: diffToJSON(d),
    layout: layoutToJSON(await layoutDiff(d)),
    meta: { generator: 'test', before: { name: 'v1' }, after: { name: 'v2' } },
  };
}

async function gzipBase64(text: string): Promise<string> {
  const input = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode(text));
      c.close();
    },
  });
  const reader = input
    .pipeThrough(
      new CompressionStream('gzip') as unknown as TransformStream<Uint8Array, Uint8Array>,
    )
    .getReader();
  const parts: number[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(...value);
  }
  let binary = '';
  for (const b of parts) binary += String.fromCharCode(b);
  return btoa(binary);
}

function script(text: string, attrs: Record<string, string> = {}): HTMLScriptElement {
  const s = document.createElement('script');
  s.type = PAYLOAD_SCRIPT_TYPE;
  for (const [k, v] of Object.entries(attrs)) s.setAttribute(k, v);
  s.textContent = text;
  return s;
}

beforeEach(() => setRenderBackend(mockBackend()));
afterEach(() => {
  document.body.textContent = '';
  setRenderBackend(null);
});

describe('payload decoding', () => {
  it('decodes plain JSON and gzip-base64', async () => {
    const p = await payload();
    const json = JSON.stringify(p);
    expect(await decodePayloadText(json, null)).toEqual(p);
    expect(await decodePayloadText(await gzipBase64(json), 'gzip-base64')).toEqual(p);
  });

  it('rejects bad encodings, JSON and envelopes with KgdiffErrors', async () => {
    await expect(decodePayloadText('{}', 'brotli')).rejects.toMatchObject({
      code: 'invalid-input',
    });
    await expect(decodePayloadText('{nope', null)).rejects.toMatchObject({ code: 'invalid-input' });
    await expect(decodePayloadText('!!!', 'gzip-base64')).rejects.toMatchObject({
      code: 'invalid-input',
    });
    expect(() => assertPayload({ format: 'kgdiff.diff' })).toThrow(/kgdiff.report/);
    expect(() => assertPayload({ format: 'kgdiff.report', version: 2 })).toThrow(/version/);
    expect(() => assertPayload({ format: 'kgdiff.report', version: 1 })).toThrow(/diff/);
  });

  it('opens a report with members of `view` it does not know, which later versions add', async () => {
    const p = await payload();
    const newer = {
      ...p,
      view: { ...p.view, plain: true, categories: { A: 1 }, futureMember: {} },
    };
    expect(assertPayload(newer)).toBe(newer);
    expect(await decodePayloadText(JSON.stringify(newer), null)).toEqual(newer);
  });

  it('takes the layout as optional, and an object when present', async () => {
    const { layout: _, ...rest } = await payload();
    expect(assertPayload(rest)).toBe(rest);
    expect(await decodePayloadText(JSON.stringify(rest), null)).toEqual(rest);
    for (const layout of [null, 'none', 1, false]) {
      expect(() => assertPayload({ ...rest, layout })).toThrow(/layout/);
      expect(() => assertPayload({ ...rest, layout })).toThrow(
        expect.objectContaining({ code: 'invalid-input' }),
      );
    }
    expect(() => assertPayload({ ...payload(), diff: undefined })).toThrow(/diff/);
  });
});

describe('hydrateEmbeddedPayloads', () => {
  it('assigns a gzip-base64 payload to the targeted viewer, which then honours `view`', async () => {
    const p = await payload();
    const a = document.createElement('kgdiff-viewer');
    const b = document.createElement('kgdiff-viewer');
    b.id = 'second';
    document.body.append(
      a,
      b,
      script(await gzipBase64(JSON.stringify(p)), {
        'data-for': 'second',
        'data-encoding': 'gzip-base64',
      }),
    );
    let ready = false;
    b.addEventListener('kgdiff-ready', () => {
      ready = true;
    });
    await hydrateEmbeddedPayloads();
    expect(a.payload).toBeNull();
    expect(b.payload).toEqual(p);
    await until(() => ready);
    expect(b.mode).toBe('replay');
    expect(b.locale).toBe('zh-CN');
    expect(b.reviewState().total).toBe(p.diff.hunks.length);
  });

  it('lays out a payload without a layout, importing the compute module (ESM build)', async () => {
    const p = await payload();
    const { layout, ...rest } = p;
    const v = document.createElement('kgdiff-viewer');
    let ready = false;
    v.addEventListener('kgdiff-ready', () => {
      ready = true;
    });
    document.body.append(v, script(JSON.stringify(rest)));
    await hydrateEmbeddedPayloads();
    await until(() => ready);
    expect(v.payload).toEqual(rest);
    expect(v.mode).toBe('replay');
    expect(v.locale).toBe('zh-CN');
    expect(v.reviewState().total).toBe(p.diff.hunks.length);
    // The layout the CLI would have embedded: same input, same default options.
    const positions = (v as unknown as KgdiffViewer).controller.layout!.positions;
    expect(Object.fromEntries([...positions].map(([id, q]) => [id, [q.x, q.y]]))).toEqual(
      layout?.positions,
    );
  });

  it('draws a report without `view.shapes` as circles and passes `shapes` to the scene', async () => {
    const shown = async (view: ReportPayload['view']): Promise<KgdiffViewer> => {
      const viewer = document.createElement('kgdiff-viewer') as KgdiffViewer;
      document.body.append(viewer);
      viewer.payload = { ...(await typed()), view };
      await until(() => viewer.controller.status === 'ready');
      return viewer;
    };
    const plain = await shown({ plainMember: true } as ReportPayload['view']);
    expect(plain.controller.scene?.nodes.every((n) => n.shape === undefined)).toBe(true);
    expect(plain.controller.scene?.shapes).toBeUndefined();

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const viewer = await shown({
      shapes: { Bird: 'diamond', Odd: 'blob', Unused: 'square' },
    } as unknown as ReportPayload['view']);
    expect(warn.mock.calls.flat().join(' ')).toMatch(/shapes\.Odd/);
    warn.mockRestore();
    const scene = viewer.controller.scene;
    expect(scene?.shapes).toEqual([{ type: 'Bird', shape: 'diamond' }]);
    expect(scene?.nodes.some((n) => n.shape === 'diamond')).toBe(true);
    const legend = viewer.shadowRoot?.querySelector('.legend-row[data-shape="diamond"]');
    expect(legend?.textContent).toBe('Bird');
    expect(legend?.querySelector('polygon')).not.toBeNull();
    expect(viewer.shadowRoot?.querySelector('.mini-item[data-shape="diamond"]')?.textContent).toBe(
      'Bird',
    );
  });

  it('defaults to the first viewer and works before the element is connected', async () => {
    const holder = document.createElement('div');
    const v = document.createElement('kgdiff-viewer');
    holder.append(v, script(JSON.stringify(await payload())));
    await hydrateEmbeddedPayloads(holder);
    expect(v.payload?.format).toBe('kgdiff.report');
  });

  it('reports undecodable payloads on the target viewer', async () => {
    const v = document.createElement('kgdiff-viewer');
    const errors: Error[] = [];
    v.addEventListener('kgdiff-error', (e) =>
      errors.push((e as CustomEvent<{ error: Error }>).detail.error),
    );
    document.body.append(v, script('{"format":"kgdiff.report","version":7}'));
    await hydrateEmbeddedPayloads();
    expect(errors[0]).toMatchObject({ code: 'unsupported-version' });
  });
});
