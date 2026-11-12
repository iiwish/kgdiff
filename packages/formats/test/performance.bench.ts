import { expect, test } from 'vitest';
import type { FormatId } from '../src/index.js';
import { parseGraph } from '../src/sync.js';
import { json, nTriples, obo, owlTurtle, TRIPLES } from './large-inputs.js';

/**
 * Parsing timings (`pnpm bench`). Budget (docs: "50k triples < 1 s"), asserted with headroom on
 * the cold run, the first call as the CLI makes it; the warm runs show the JIT-compiled speed.
 */
const BUDGET_MS = 1000;
const HEADROOM = 2.5;
const COLD = { iterations: 1, time: 0, warmup: false };
const WARM = { iterations: 5, time: 0, warmupIterations: 1, warmupTime: 0 };

const CASES: readonly [string, FormatId, () => string][] = [
  [`${TRIPLES / 1000}k OWL Turtle triples`, 'turtle', () => owlTurtle(TRIPLES).text],
  [`${TRIPLES / 1000}k N-Triples`, 'ntriples', () => nTriples(TRIPLES)],
  ['10k-term OBO file', 'obo', () => obo(10_000)],
  [`${TRIPLES / 1000}k JSON edges`, 'json', () => json(TRIPLES)],
];

test.for(CASES)('parseGraph, %s', async ([, format, generate], { bench }) => {
  const text = generate();
  const parse = () => parseGraph(text, { format });
  const cold = await bench('cold', parse).run(COLD);
  await bench('warm', parse).run(WARM);
  expect(cold.latency.p50).toBeLessThan(BUDGET_MS * HEADROOM);
});
