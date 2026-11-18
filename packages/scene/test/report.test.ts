/// <reference types="node" />
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  type DiffResult,
  diffFromJSON,
  KgdiffError,
  type PackedDiffJSON,
  unpackDiffJSON,
} from '@kgdiff/core';
import { layoutFromJSON, layoutToJSON } from '@kgdiff/layout';
import { describe, expect, it } from 'vitest';
import {
  buildScene,
  type ReportPayload,
  reportFromJSON,
  type Scene,
  sceneFromReport,
} from '../src/index.js';
import { makeLayout } from './fixtures.js';

// `import.meta.dirname`, not `new URL(…, import.meta.url)`: Vite rewrites the latter as an asset.
const CASES = resolve(import.meta.dirname, '../../../conformance/cases');

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;

/**
 * Every conformance case's report payload, as conformance/README.md puts it together:
 * `report.json` (the payload without its diff and layout) with `diff.packed.json` as its diff.
 */
const cases = readdirSync(CASES, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort()
  .flatMap((name) => {
    const dir = `${CASES}/${name}/expected`;
    try {
      const report = readJson<Omit<ReportPayload, 'diff'>>(`${dir}/report.json`);
      const packed = readJson<PackedDiffJSON>(`${dir}/diff.packed.json`);
      return [{ name, payload: { ...report, diff: packed } as ReportPayload, packed }];
    } catch {
      return [];
    }
  });

/** A layout for `diff` with every node on a line. */
function lineLayout(diff: DiffResult) {
  const positions: Record<string, [number, number]> = {};
  diff.nodes.forEach((n, i) => {
    positions[n.id] = [i * 80, (i % 3) * 40];
  });
  return makeLayout(diff, positions);
}

function sample(): ReportPayload {
  const first = cases.find((c) => c.name === 'dataset-enterprise-kg-en');
  if (first === undefined) throw new Error('no conformance case');
  return first.payload;
}

function withLayout(payload: ReportPayload): ReportPayload {
  const diff = diffFromJSON(unpackDiffJSON(payload.diff as PackedDiffJSON));
  return { ...payload, layout: layoutToJSON(lineLayout(diff)) };
}

function rejects(value: unknown, code: string): void {
  try {
    reportFromJSON(value);
  } catch (error) {
    expect(error).toBeInstanceOf(KgdiffError);
    expect((error as KgdiffError).code).toBe(code);
    return;
  }
  throw new Error('accepted');
}

describe('reportFromJSON', () => {
  it('reads the report payload of every conformance case', () => {
    expect(cases.length).toBeGreaterThan(20);
    for (const { name, payload, packed } of cases) {
      const report = reportFromJSON(payload);
      const expected = diffFromJSON(unpackDiffJSON(packed));
      expect(report.diff.hunks, name).toEqual(expected.hunks);
      expect(report.diff.nodes, name).toEqual(expected.nodes);
      expect(report.diff.edges, name).toEqual(expected.edges);
      expect(report.layout, name).toBeUndefined();
      expect(report.meta, name).toEqual(payload.meta);
      expect(report.view, name).toEqual(payload.view);
    }
  });

  it('reads an unpacked diff and a layout', () => {
    const payload = withLayout(sample());
    const diff = diffFromJSON(unpackDiffJSON(payload.diff as PackedDiffJSON));
    const report = reportFromJSON({
      ...payload,
      diff: unpackDiffJSON(payload.diff as PackedDiffJSON),
    });
    expect(report.diff.hunks).toEqual(diff.hunks);
    expect(report.layout).toEqual(layoutFromJSON(payload.layout!));
  });

  it('keeps view members it does not know', () => {
    const payload = { ...sample(), view: { locale: 'zh-CN', later: { x: 1 } } };
    expect(reportFromJSON(payload).view).toEqual(payload.view);
  });

  it('rejects another format, a newer version and a payload without its parts', () => {
    const payload = sample();
    rejects(null, 'invalid-input');
    rejects([], 'invalid-input');
    rejects({ ...payload, format: 'kgdiff.diff' }, 'invalid-input');
    rejects({ ...payload, format: undefined }, 'invalid-input');
    rejects({ ...payload, version: 2 }, 'unsupported-version');
    rejects({ ...payload, version: '1' }, 'unsupported-version');
    rejects({ ...payload, diff: undefined }, 'invalid-input');
    rejects({ ...payload, meta: undefined }, 'invalid-input');
    rejects({ ...payload, layout: 'none' }, 'invalid-input');
    rejects({ ...payload, view: 'replay' }, 'invalid-input');
  });

  it('lets the readers of the diff and the layout reject theirs', () => {
    const payload = withLayout(sample());
    rejects({ ...payload, diff: { ...payload.diff, version: 9 } }, 'unsupported-version');
    rejects({ ...payload, layout: { ...payload.layout, version: 9 } }, 'unsupported-version');
    rejects({ ...payload, layout: { ...payload.layout, positions: 1 } }, 'invalid-input');
  });
});

describe('sceneFromReport', () => {
  const ids = (s: Scene): string[] => s.nodes.map((n) => `${n.id} ${n.x} ${n.y} ${n.hunk}`);

  it('builds the scene buildScene builds from the payload', () => {
    const payload = withLayout(sample());
    const report = reportFromJSON(payload);
    const scene = sceneFromReport(payload, { theme: 'light', locale: 'zh-CN' });
    const expected = buildScene(report.diff, report.layout!, { theme: 'light', locale: 'zh-CN' });
    expect(ids(scene)).toEqual(ids(expected));
    expect(scene.hunks).toEqual(expected.hunks);
    expect(scene.theme).toEqual(expected.theme);
    expect(scene.locale).toBe('zh-CN');
  });

  it("takes the payload's shapes unless the options give some", () => {
    const payload = withLayout(sample());
    const type = reportFromJSON(payload)
      .diff.nodes.flatMap((n) => [...(n.after?.types ?? n.before?.types ?? [])])
      .find((t) => t !== undefined);
    const shapes = { [type ?? 'Thing']: 'diamond' as const };
    const own = sceneFromReport({ ...payload, view: { ...payload.view, shapes } });
    expect(own.shapes).toEqual(
      buildScene(reportFromJSON(payload).diff, reportFromJSON(payload).layout!, { shapes }).shapes,
    );
    const given = sceneFromReport(
      { ...payload, view: { ...payload.view, shapes } },
      { shapes: { [type ?? 'Thing']: 'square' } },
    );
    expect(given.shapes).toEqual(
      buildScene(reportFromJSON(payload).diff, reportFromJSON(payload).layout!, {
        shapes: { [type ?? 'Thing']: 'square' },
      }).shapes,
    );
  });

  it("takes the payload's locale and palette unless the options give them", () => {
    const payload = withLayout(sample());
    const report = reportFromJSON(payload);
    const written = {
      ...payload,
      view: { ...payload.view, locale: 'zh-CN', palette: 'colorblind' },
    };
    const own = sceneFromReport(written);
    const expected = buildScene(report.diff, report.layout!, {
      locale: 'zh-CN',
      palette: 'colorblind',
    });
    expect(own.locale).toBe('zh-CN');
    expect(own.theme).toEqual(expected.theme);
    expect(own.hunks).toEqual(expected.hunks);
    // The host's options win, one by one.
    const given = sceneFromReport(written, { locale: 'en' });
    expect(given.locale).toBe('en');
    expect(given.theme).toEqual(expected.theme);
    // The theme is the host's: `view.theme` is not read.
    const themed = sceneFromReport({ ...written, view: { ...written.view, theme: 'light' } });
    expect(themed.theme).toEqual(expected.theme);
    // A locale or a palette of a later version is passed over, not an error.
    const later = sceneFromReport({
      ...payload,
      view: { ...payload.view, locale: 'tlh', palette: 'neon' },
    });
    expect(later.locale).toBe(sceneFromReport(payload).locale);
    expect(later.theme).toEqual(sceneFromReport(payload).theme);
  });

  it('reports what is wrong inside the diff and the layout with their readers\u2019 codes', () => {
    const payload = withLayout(sample());
    const code = (json: unknown): string => {
      try {
        reportFromJSON(json);
      } catch (error) {
        return (error as { code?: string }).code ?? String(error);
      }
      return 'no error';
    };
    expect(code({ ...payload, format: 'kgdiff.diff' })).toBe('invalid-input');
    expect(code({ ...payload, diff: {} })).toBe('unsupported-version');
    expect(code({ ...payload, diff: { format: 'nope' } })).toBe('unsupported-version');
    expect(code({ ...payload, layout: { format: 'nope' } })).toBe('invalid-input');
  });

  it('rejects a payload without a layout', () => {
    expect(() => sceneFromReport(sample())).toThrow(KgdiffError);
  });
});
