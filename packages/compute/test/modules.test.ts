import { type DiffJSON, diffFromJSON, KgdiffError } from '@kgdiff/core';
import type { LayoutOptions } from '@kgdiff/layout';
import { describe, expect, it } from 'vitest';
import {
  detectFormat,
  diffSync,
  init,
  layoutDiff,
  layoutDiffSync,
  parseGraph,
  parseGraphSync,
} from '../src/index.js';
import * as layoutOnly from '../src/layout.js';
import { enabled } from './support.js';
import typescript from './typescript-engine.json' with { type: 'json' };

const before = { nodes: [{ id: 'a', label: 'A' }, { id: 'b' }], edges: [] };
const after = {
  nodes: [{ id: 'a', label: 'A2' }, { id: 'b' }, { id: 'c' }],
  edges: [{ source: 'a', target: 'c', predicate: 'p' }],
};

function failure(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('expected a failure');
}

/** The diff of `before` and `after` as the TypeScript engine (deleted in 0.11) computed it. */
const computed = () => diffFromJSON(JSON.parse(typescript.modules.diff) as DiffJSON);

describe.runIf(enabled)('the modules load on demand', () => {
  it('loads only what is asked for', async () => {
    await layoutOnly.init();
    const result = computed();
    expect(layoutOnly.layoutDiffSync(result).positions.size).toBe(3);
    expect(() => diffSync(before, after)).toThrow(/compute module is not initialized/);
    expect(() => parseGraphSync('{}')).toThrow(/formats module is not initialized/);
    // The asynchronous functions load their module themselves.
    expect((await parseGraph('{"nodes":[],"edges":[]}')).format).toBe('json');
    expect(await detectFormat('@prefix ex: <http://e.x/> .')).toBe('turtle');
    expect(() => diffSync(before, after)).toThrow(/compute module is not initialized/);
    expect((await layoutDiff(result)).stats.nodes).toBe(3);
    await init();
    expect(diffSync(before, after).stats).toEqual(result.stats);
  });

  it('fails as the TypeScript packages did', async () => {
    await init();
    const result = computed();
    for (const { options, message } of typescript.modules.layoutErrors) {
      const wasm = failure(() => layoutDiffSync(result, options as LayoutOptions));
      expect(wasm).toBeInstanceOf(KgdiffError);
      expect((wasm as KgdiffError).message).toBe(message);
    }
    const parse = failure(() => parseGraphSync('@prefix ex <x> .', { format: 'turtle' }));
    expect(parse).toBeInstanceOf(KgdiffError);
    // oxttl's wording inside kgdiff's (RFC 0002, §5), as the CLI writes it.
    expect(parse).toMatchObject({ code: 'invalid-input', message: /^Invalid Turtle: .* line 1/ });
  });

  it('calls the JSON-LD document loader', async () => {
    await init();
    const context = { '@context': { '@vocab': 'http://e.x/' } };
    const text = '{"@context":"http://ctx/","@id":"http://e.x/a","p":{"@id":"http://e.x/b"}}';
    const options = { jsonld: { documentLoader: () => context } };
    expect(parseGraphSync(text, options)).toEqual(typescript.modules.documentLoader);
  });
});
