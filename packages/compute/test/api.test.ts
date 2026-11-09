import { readFileSync } from 'node:fs';
import { diff, diffToJSON, KgdiffError, matchNodes, normalize, textSimilarity } from '@kgdiff/core';
import { describe, expect, it } from 'vitest';
import {
  diffJSON,
  diffSync,
  init,
  matchNodesSync,
  textSimilaritySync,
  version,
} from '../src/index.js';
import { enabled } from './support.js';

const before = {
  nodes: [
    { id: 'ada', label: 'Ada', type: 'Person', attrs: { born: 1815 } },
    { id: 'babbage', label: 'Charles Babbage' },
    { id: 'engine', label: 'Analytical Engine' },
  ],
  edges: [
    { source: 'ada', target: 'babbage', predicate: 'knows' },
    { source: 'babbage', target: 'engine', predicate: 'designed' },
  ],
};
const after = {
  nodes: [
    { id: 'ada', label: 'Ada Lovelace', type: 'Person', attrs: { born: 1815 } },
    { id: 'babbage', label: 'Charles Babbage' },
    { id: 'notes', label: 'Notes on the Analytical Engine' },
  ],
  edges: [
    { source: 'ada', target: 'babbage', predicate: 'knows' },
    { source: 'ada', target: 'notes', predicate: 'wrote' },
  ],
};

describe.runIf(enabled)('@kgdiff/compute', () => {
  it('asks for init() first, and init() is idempotent', async () => {
    expect(() => version()).toThrow(/await init\(\) first/);
    await Promise.all([init(), init()]);
    await init();
    const cargo = readFileSync(new URL('../../../Cargo.toml', import.meta.url), 'utf8');
    expect(version()).toBe(/^version = "([^"]+)"/m.exec(cargo)?.[1]);
  });

  it('diffs as @kgdiff/core does, byte for byte', async () => {
    await init();
    const options = { ignoreAttrs: ['born'] };
    const text = diffJSON(before, after, options);
    expect(text).toBe(JSON.stringify(diffToJSON(diff(before, after, options))));
    expect(diffJSON(JSON.stringify(before), JSON.stringify(after), JSON.stringify(options))).toBe(
      text,
    );
    const result = diffSync(before, after, options);
    expect(result.stats).toEqual(diff(before, after, options).stats);
    expect(result.hunks.map((h) => h.id)).toEqual(
      diff(before, after, options).hunks.map((h) => h.id),
    );
  });

  it('matches nodes and compares text as @kgdiff/core does', async () => {
    await init();
    const options = { strategy: 'similarity' as const };
    expect(matchNodesSync(before, after, options)).toEqual(
      JSON.parse(JSON.stringify(matchNodes(normalize(before), normalize(after), options))),
    );
    for (const [a, b] of [
      ['Analytical Engine', 'analytical engine'],
      ['Notes on the Analytical Engine', 'Analytical Engine'],
      ['Ada', 'Ada Lovelace'],
    ] as const) {
      expect(textSimilaritySync(a, b)).toBe(textSimilarity(a, b));
    }
  });

  it('throws KgdiffErrors with their code and details', async () => {
    await init();
    const failure = (run: () => unknown): unknown => {
      try {
        run();
      } catch (error) {
        return error;
      }
      throw new Error('expected a failure');
    };
    const malformed = failure(() => diffJSON('{', after));
    expect(malformed).toBeInstanceOf(KgdiffError);
    expect(malformed).toMatchObject({ code: 'invalid-input' });
    const options = failure(() => diffJSON(before, after, { edgeIdentity: 'neither' as 'id' }));
    expect(options).toMatchObject({ code: 'invalid-input' });
    expect((options as Error).message).toMatch(/edgeIdentity/);
  });
});
