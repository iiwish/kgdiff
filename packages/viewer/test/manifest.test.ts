// @vitest-environment node
/**
 * The Custom Elements Manifest (RFC 0001 §8) and the files generated from it stay in step with
 * the sources: regenerate with `pnpm --filter @kgdiff/viewer manifest` when this fails.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildManifest, elementsOf, ORDER, stale } from '../scripts/manifest.js';

const manifest = buildManifest();
const elements = elementsOf(manifest);
const byTag = (tag: string) => {
  const e = elements.find((x) => x.tagName === tag);
  if (!e) throw new Error(`no ${tag}`);
  return e;
};

describe('the Custom Elements Manifest', () => {
  it('matches the committed files (run `pnpm --filter @kgdiff/viewer manifest`)', () => {
    expect(stale()).toEqual([]);
  });

  it('describes every element the package defines, and is shipped', () => {
    // Every tag the sources define: `define('kgdiff-…')` and the viewer's default tag.
    const src = new URL('../src/', import.meta.url);
    const files = [
      'index.ts',
      ...readdirSync(new URL('elements/', src)).map((f) => `elements/${f}`),
    ];
    const tags = files.flatMap((f) =>
      [
        ...readFileSync(new URL(f, src), 'utf8').matchAll(
          /define\w*\((?:tagName = )?'(kgdiff-[a-z-]+)'/g,
        ),
      ].map((m) => m[1]),
    );
    expect(tags.sort()).toEqual([...ORDER].sort());
    expect(elements.map((e) => e.tagName)).toEqual([...ORDER]);
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(pkg.customElements).toBe('custom-elements.json');
    expect(pkg.files).toContain('custom-elements.json');
  });

  it('names and describes every attribute, member, event, slot and state', () => {
    for (const e of elements) {
      expect(e.description, e.tagName).not.toBe('');
      for (const part of [...e.attributes, ...e.members, ...e.events, ...e.slots, ...e.cssStates]) {
        expect(part.description, `${e.tagName} ${part.name}`).toBeTruthy();
      }
    }
  });

  it('links attributes and properties both ways', () => {
    const viewer = byTag('kgdiff-viewer');
    const attr = (name: string) => viewer.attributes.find((a) => a.name === name);
    expect(attr('loop-delay')?.fieldName).toBe('loopDelay');
    expect(viewer.members.find((m) => m.name === 'loopDelay')?.attribute).toBe('loop-delay');
    // Attributes without a property, documented with `@attr`.
    expect(attr('sidebar')?.fieldName).toBeUndefined();
    expect(attr('sync-hash')?.type?.text).toBe('boolean');
    expect(byTag('kgdiff-legend').attributes.map((a) => a.fieldName)).toEqual([
      'htmlFor',
      'variant',
      'open',
    ]);
    expect(byTag('kgdiff-zoom').attributes.map((a) => [a.name, a.fieldName])).toEqual([
      ['stage', 'stage'],
    ]);
  });

  it('carries the experimental status, the events, slots, tokens and states', () => {
    expect(byTag('kgdiff-viewer').experimental).toBeUndefined();
    for (const e of elements.filter((x) => x.tagName !== 'kgdiff-viewer')) {
      expect(e.experimental, e.tagName).toBeTruthy();
    }
    const keymap = byTag('kgdiff-viewer').members.find((m) => m.name === 'keymap');
    expect(keymap?.experimental).toBeTruthy();
    // `kgdiff-layout` is the default layout's.
    expect(byTag('kgdiff-viewer').events.map((e) => e.name)).toContain('kgdiff-layout');
    expect(byTag('kgdiff-root').events.map((e) => e.name)).not.toContain('kgdiff-layout');
    expect(byTag('kgdiff-root').events.find((e) => e.name === 'kgdiff-select')?.type.text).toBe(
      'CustomEvent<{ readonly hunk: string | null; readonly node: string | null }>',
    );
    expect(byTag('kgdiff-stage').slots.map((s) => s.name)).toEqual([
      'top-start',
      'top-end',
      'bottom-start',
      'bottom-center',
      'bottom-end',
    ]);
    const tokens = byTag('kgdiff-viewer').cssProperties.map((p) => p.name);
    expect(tokens).toContain('--kgdiff-accent');
    expect(tokens).toContain('--kgdiff-removed-soft');
    expect(byTag('kgdiff-minimap').cssStates.map((s) => s.name)).toEqual(['overview']);
    // Internals stay out: the public surface is the interface's.
    const members = byTag('kgdiff-viewer').members.map((m) => m.name);
    expect(members).not.toContain('controller');
    expect(members).not.toContain('showError');
  });
});
