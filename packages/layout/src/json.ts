/**
 * Deterministic JSON transport for layouts (no timing information).
 */
import { KgdiffError, type Point, type Rect, type UnionId } from '@kgdiff/core';
import type {
  LayoutComponent,
  LayoutJSON,
  LayoutJSONV1,
  LayoutResult,
  LayoutScope,
  LayoutStrategy,
} from './index.js';
import { round2 } from './round.js';

const byKey = <T>([a]: readonly [string, T], [b]: readonly [string, T]): number =>
  a < b ? -1 : a > b ? 1 : 0;

function sortedEntries<T>(entries: Iterable<readonly [UnionId, T]>): (readonly [UnionId, T])[] {
  return [...entries].sort(byKey);
}

const rect = (r: Rect): Rect => ({
  x: round2(r.x),
  y: round2(r.y),
  width: round2(r.width),
  height: round2(r.height),
});

/**
 * Version 2 with the layout's `generator` when it has one (read from version 2), else version 1,
 * as kgdiff-layout's `layout_to_json` writes them: what a layout document says about its
 * positions survives a round trip (RFC 0002, D-3).
 */
export function toJSON(layout: LayoutResult): LayoutJSON {
  const members = {
    strategy: layout.stats.strategy,
    scope: layout.scope,
    iterations: layout.stats.iterations,
    positions: Object.fromEntries(
      sortedEntries(layout.positions).map(([id, p]) => [id, [round2(p.x), round2(p.y)] as const]),
    ),
    radii: Object.fromEntries(sortedEntries(layout.radii).map(([id, r]) => [id, round2(r)])),
    hidden: Object.fromEntries(sortedEntries(layout.hidden)),
    bounds: rect(layout.bounds),
    components: layout.components.map((c) => ({ nodes: [...c.nodes], bounds: rect(c.bounds) })),
  };
  if (layout.generator !== undefined) {
    return { format: 'kgdiff.layout', version: 2, generator: layout.generator, ...members };
  }
  return { format: 'kgdiff.layout', version: 1, ...members } satisfies LayoutJSONV1;
}

function fail(message: string, details?: Readonly<Record<string, unknown>>): never {
  throw new KgdiffError('invalid-input', `layoutFromJSON: ${message}`, details);
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function readRect(value: unknown, where: string): Rect {
  if (!isObject(value) || ![value.x, value.y, value.width, value.height].every(finite)) {
    fail(`${where} must be a rectangle`, { where });
  }
  return Object.freeze({
    x: value.x as number,
    y: value.y as number,
    width: value.width as number,
    height: value.height as number,
  });
}

function readNumbers(value: unknown, where: string): Map<UnionId, number> {
  if (!isObject(value)) fail(`${where} must be an object`, { where });
  const out = new Map<UnionId, number>();
  for (const [id, n] of sortedEntries(Object.entries(value))) {
    if (!finite(n)) fail(`${where}["${id}"] must be a finite number`, { where, id });
    out.set(id, n);
  }
  return out;
}

export function fromJSON(json: LayoutJSON): LayoutResult {
  const raw: unknown = json;
  if (!isObject(raw) || raw.format !== 'kgdiff.layout') fail('not a kgdiff.layout document');
  if (raw.version !== 1 && raw.version !== 2) {
    throw new KgdiffError(
      'unsupported-version',
      `Unsupported kgdiff.layout version ${String(raw.version)}`,
      {
        version: raw.version,
      },
    );
  }
  // Version 2 is version 1 plus `generator`; a `generator` in a version 1 document means nothing.
  let generator: string | undefined;
  if (raw.version === 2) {
    if (typeof raw.generator !== 'string' || raw.generator === '') {
      fail('generator must be a non-empty string in version 2');
    }
    generator = raw.generator;
  }
  const strategy = raw.strategy;
  if (strategy !== 'union' && strategy !== 'anchored') fail('strategy must be union or anchored');
  const scope = raw.scope;
  if (scope !== 'all' && scope !== 'changes') fail('scope must be all or changes');
  const iterations = raw.iterations;
  if (!finite(iterations) || iterations < 0) fail('iterations must be a number ≥ 0');

  if (!isObject(raw.positions)) fail('positions must be an object');
  const positions = new Map<UnionId, Point>();
  for (const [id, p] of sortedEntries(Object.entries(raw.positions))) {
    if (!Array.isArray(p) || p.length !== 2 || !finite(p[0]) || !finite(p[1])) {
      fail(`positions["${id}"] must be [x, y]`, { id });
    }
    positions.set(id, Object.freeze({ x: p[0] as number, y: p[1] as number }));
  }
  const radii = readNumbers(raw.radii, 'radii');
  const hidden = readNumbers(raw.hidden, 'hidden');

  if (!Array.isArray(raw.components)) fail('components must be an array');
  const components: LayoutComponent[] = raw.components.map((c: unknown, k: number) => {
    if (!isObject(c) || !Array.isArray(c.nodes) || !c.nodes.every((id) => typeof id === 'string')) {
      fail(`components[${k}] must have a nodes array`, { index: k });
    }
    return Object.freeze({
      nodes: Object.freeze([...(c.nodes as string[])]),
      bounds: readRect(c.bounds, `components[${k}].bounds`),
    });
  });

  return Object.freeze({
    positions,
    radii,
    bounds: readRect(raw.bounds, 'bounds'),
    scope: scope as LayoutScope,
    hidden,
    components: Object.freeze(components),
    stats: Object.freeze({
      strategy: strategy as LayoutStrategy,
      iterations,
      nodes: positions.size,
      ms: 0,
    }),
    ...(generator !== undefined ? { generator } : {}),
  });
}
