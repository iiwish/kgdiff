import { readFileSync } from 'node:fs';
import { diffFromJSON, KgdiffError } from '@kgdiff/core';
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
import typescript from './typescript-engine.json' with { type: 'json' };

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

  it('diffs as @kgdiff/core’s TypeScript engine did, byte for byte', async () => {
    await init();
    const options = { ignoreAttrs: ['born'] };
    const text = diffJSON(before, after, options);
    // What the TypeScript engine (deleted in 0.11) computed, kept in typescript-engine.json.
    const expected = diffFromJSON(JSON.parse(typescript.api.diff));
    expect(text).toBe(typescript.api.diff);
    expect(diffJSON(JSON.stringify(before), JSON.stringify(after), JSON.stringify(options))).toBe(
      text,
    );
    const result = diffSync(before, after, options);
    expect(result.stats).toEqual(expected.stats);
    expect(result.hunks.map((h) => h.id)).toEqual(expected.hunks.map((h) => h.id));
  });

  it('matches nodes and compares text as @kgdiff/core’s TypeScript engine did', async () => {
    await init();
    const options = { strategy: 'similarity' as const };
    expect(matchNodesSync(before, after, options)).toEqual(typescript.api.matchNodes);
    for (const [a, b, similarity] of typescript.textSimilarity) {
      expect([a, b, textSimilaritySync(a as string, b as string)]).toEqual([a, b, similarity]);
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
