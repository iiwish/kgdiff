/**
 * The TypeScript half of the differential run of RFC 0002 (§8): seeded random graph pairs and
 * what the TypeScript implementation computes for them, one JSON line per pair, which the Rust
 * side (`crates/kgdiff-core/tests/differential.rs`) recomputes and compares byte for byte.
 *
 *   pnpm tsx scripts/differential.ts --pairs 1000 --seed 1 --out target/differential.jsonl
 *   KGDIFF_DIFFERENTIAL=target/differential.jsonl cargo test -p kgdiff-core --release --test differential
 *
 * Pairs come from the property tests' generator (`packages/core/test/support/arbitraries.ts`:
 * special-character ids, CJK, dangling and parallel edges, self-loops, replacement hints and a
 * random edit script), small and larger, each diffed under the four option variants of
 * `properties.test.ts` in turn; `--synthetic <n>` adds `scripts/gen-synthetic.ts` pairs of 40 to
 * 400 nodes. Inputs go through JSON first, so both sides read the same values.
 *
 * Options
 *   --pairs <n>       random pairs (default 200)
 *   --seed <n>        seed of the random pairs and of the synthetic ones (default 1)
 *   --synthetic <n>   gen-synthetic pairs (default 0)
 *   --out <file>      output file (default target/differential.jsonl)
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  applyDelta,
  type DiffOptions,
  type DiffResult,
  diff,
  diffFromJSON,
  diffToJSON,
  formatHunk,
  type GraphInput,
  graphToJSON,
  hashGraph,
  invertDelta,
  type Locale,
  packDiffJSON,
} from '@kgdiff/core';
import fc from 'fast-check';
import { versionPairArb } from '../packages/core/test/support/arbitraries.ts';

const ROOT = resolve(import.meta.dirname, '..');

/** The option variants of `packages/core/test/properties.test.ts`. */
const VARIANTS: readonly DiffOptions[] = [
  {},
  { match: { strategy: 'similarity' } },
  { edgeIdentity: 'id' },
  { match: { strategy: 'id' }, detectMerges: false, detectSplits: false },
];

const LOCALES: readonly Locale[] = ['en', 'zh-CN'];

/** Everything kgdiff-core computes for one pair, as the corpus writes it. */
function outputs(result: DiffResult): Record<string, string> {
  const json = diffToJSON(result);
  const titles = Object.fromEntries(
    LOCALES.map((locale) => [
      locale,
      result.hunks.map((h) => ({ id: h.id, ...formatHunk(h, result, locale) })),
    ]),
  );
  const back = diffFromJSON(JSON.parse(JSON.stringify(json)));
  if (JSON.stringify(diffToJSON(back)) !== JSON.stringify(json)) {
    throw new Error('diffFromJSON(diffToJSON(d)) does not round-trip');
  }
  return {
    'graph.before': JSON.stringify(graphToJSON(result.before)),
    'graph.after': JSON.stringify(graphToJSON(result.after)),
    issues: JSON.stringify({ before: result.before.issues, after: result.after.issues }),
    hashes: JSON.stringify({ before: hashGraph(result.before), after: hashGraph(result.after) }),
    diff: JSON.stringify(json),
    titles: JSON.stringify(titles),
    packed: JSON.stringify(packDiffJSON(json)),
    delta: JSON.stringify(result.delta),
    inverse: JSON.stringify(invertDelta(result.delta)),
    applied: JSON.stringify(graphToJSON(applyDelta(result.before, result.delta))),
  };
}

function line(name: string, before: GraphInput, after: GraphInput, options: DiffOptions): string {
  // The values both sides read: what JSON.parse gives back.
  const b = JSON.parse(JSON.stringify(before)) as GraphInput;
  const a = JSON.parse(JSON.stringify(after)) as GraphInput;
  return `${JSON.stringify({ name, options, before: b, after: a, outputs: outputs(diff(b, a, options)) })}\n`;
}

function main(): void {
  const { values } = parseArgs({
    options: {
      pairs: { type: 'string' },
      seed: { type: 'string' },
      synthetic: { type: 'string' },
      out: { type: 'string' },
    },
  });
  const pairs = Number(values.pairs ?? 200);
  const seed = Number(values.seed ?? 1);
  const synthetic = Number(values.synthetic ?? 0);
  const out = resolve(values.out ?? join(ROOT, 'target', 'differential.jsonl'));
  mkdirSync(dirname(out), { recursive: true });
  const lines: string[] = [];

  const small = fc.sample(versionPairArb(), { seed, numRuns: Math.ceil(pairs / 2) });
  const large = fc.sample(versionPairArb({ maxNodes: 18, maxEdges: 40 }), {
    seed: seed + 1,
    numRuns: Math.floor(pairs / 2),
  });
  [...small, ...large].forEach(([before, after], i) => {
    const options = VARIANTS[i % VARIANTS.length] as DiffOptions;
    lines.push(line(`random-${seed}-${i}`, before, after, options));
  });

  if (synthetic > 0) {
    const dir = mkdtempSync(join(tmpdir(), 'kgdiff-differential-'));
    try {
      for (let i = 0; i < synthetic; i++) {
        const nodes = 40 + ((i * 37) % 361);
        const args = ['tsx', 'scripts/gen-synthetic.ts', '--nodes', String(nodes)];
        args.push('--seed', String(seed + i), '--out', dir);
        if (i % 2 === 1) args.push('--cjk');
        execFileSync('pnpm', args, { cwd: ROOT, stdio: 'ignore' });
        const read = (file: string): GraphInput =>
          JSON.parse(readFileSync(join(dir, file), 'utf8')) as GraphInput;
        const options = VARIANTS[i % 2] as DiffOptions;
        lines.push(
          line(`synthetic-${nodes}-${seed + i}`, read('before.json'), read('after.json'), options),
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  writeFileSync(out, lines.join(''));
  process.stdout.write(`${lines.length} pairs → ${out}\n`);
}

main();
