import { KgdiffError } from '@kgdiff/core';
import { describe, expect, it } from 'vitest';
import { diff as diffTS } from '../../core/src/sync.js';
import { parseGraph as parseTS } from '../../formats/src/sync.js';
import { layoutDiff as layoutTS } from '../../layout/src/sync.js';
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

describe.runIf(enabled)('the modules load on demand', () => {
  it('loads only what is asked for', async () => {
    await layoutOnly.init();
    const result = diffTS(before, after);
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

  it('fails as the TypeScript packages do', async () => {
    await init();
    const result = diffTS(before, after);
    for (const options of [{ fontSize: -1 }, { iterations: 1.5 }, { scope: 'some' as 'all' }]) {
      const wasm = failure(() => layoutDiffSync(result, options));
      const ts = failure(() => layoutTS(result, options));
      expect(wasm).toBeInstanceOf(KgdiffError);
      expect((wasm as KgdiffError).message).toBe((ts as KgdiffError).message);
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
    expect(parseGraphSync(text, options)).toEqual(
      JSON.parse(JSON.stringify(parseTS(text, options))),
    );
  });
});
