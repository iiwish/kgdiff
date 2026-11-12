import { describe, expect, it } from 'vitest';
import { parseGraph } from '../src/sync.js';
import { owlTurtle, TRIPLES } from './large-inputs.js';

/**
 * Parsing at the size of the budget (docs: "50k triples < 1 s"). The timings of every format are
 * in performance.bench.ts (`pnpm bench`).
 */
describe('performance-sized inputs', () => {
  it(`parses ${TRIPLES / 1000}k OWL Turtle triples into one node per class`, () => {
    const { text } = owlTurtle(TRIPLES);
    expect(parseGraph(text, { format: 'turtle' }).graph.nodes.length).toBe(Math.ceil(TRIPLES / 11));
  });
});
