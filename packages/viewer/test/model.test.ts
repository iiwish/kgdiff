import { diff } from '@kgdiff/core';
import { layoutDiff } from '@kgdiff/layout';
import { buildScene } from '@kgdiff/scene';
import { describe, expect, it } from 'vitest';
import { buildList, familyCounts, PHASE_ORDER, stepHunk } from '../src/list-model.js';
import { ReviewStore, reviewKey } from '../src/review-store.js';
import { fold, SearchIndex, scoreText } from '../src/search.js';
import { MemoryStorage, zoo } from './support.js';

const { before, after } = zoo();
const d = diff(before, after);
const scene = buildScene(d, layoutDiff(d));

describe('change list model', () => {
  it('groups hunks by phase with headers and counts', () => {
    const list = buildList(scene, new Set());
    const headers = list.items.filter((i) => i.kind === 'header');
    expect(headers.map((h) => h.phase)).toEqual(
      PHASE_ORDER.filter((p) => scene.hunks.some((h) => h.phase === p)),
    );
    expect(list.order).toHaveLength(scene.hunks.length);
    for (const h of list.order) {
      const item = list.items[list.itemOf.get(h) as number];
      expect(item).toEqual({ kind: 'row', hunk: h });
    }
    const total = headers.reduce((a, h) => a + (h.kind === 'header' ? h.count : 0), 0);
    expect(total).toBe(scene.hunks.length);
  });

  it('filters by family and counts hunks per family', () => {
    const counts = familyCounts(scene);
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(scene.hunks.length);
    const added = buildList(scene, new Set(['added']));
    expect(added.order).toHaveLength(counts.added);
    expect(buildList(scene, new Set(['identity'])).items).toEqual([]);
  });

  it('steps with clamping and recovers from filtered-out selections', () => {
    const list = buildList(scene, new Set());
    const { order } = list;
    expect(stepHunk(list, -1, 1)).toBe(order[0]);
    expect(stepHunk(list, -1, -1)).toBe(order[order.length - 1]);
    expect(stepHunk(list, order[0] as number, -1)).toBe(order[0]);
    expect(stepHunk(list, order[1] as number, 1)).toBe(order[2]);
    const empty = buildList(scene, new Set(['identity']));
    expect(stepHunk(empty, 0, 1)).toBe(-1);
  });
});

describe('search', () => {
  const index = new SearchIndex(d);

  it('ranks exact > prefix > word start > substring > subsequence', () => {
    expect(scoreText('cat', 'cat')).toBeGreaterThan(scoreText('cat', 'catalog'));
    expect(scoreText('cat', 'catalog')).toBeGreaterThan(scoreText('cat', 'wild cat'));
    expect(scoreText('cat', 'wild cat')).toBeGreaterThan(scoreText('cat', 'bobcat'));
    expect(scoreText('cat', 'bobcat')).toBeGreaterThan(scoreText('cat', 'c-a-t'));
    expect(scoreText('cat', 'dog')).toBe(0);
  });

  it('matches labels, old labels and ids, case- and width-insensitively', () => {
    expect(index.search('KITTY')[0]?.node.id).toBe('C');
    expect(index.search('cat')[0]?.node.id).toBe('C');
    expect(index.search('e')[0]?.node.id).toBe('E');
    expect(index.search('ｇｅｃｋｏ')[0]?.node.id).toBe('G');
    expect(index.search('   ')).toEqual([]);
    expect(index.search('zzz')).toEqual([]);
    expect(fold('Ａ')).toBe('a');
  });

  it('limits results', () => {
    expect(index.search('a', 2)).toHaveLength(2);
  });
});

describe('review store', () => {
  it('reads and writes, keeping ids this diff does not know', () => {
    const storage = new MemoryStorage();
    const key = reviewKey('c1:aa', 'c1:bb');
    storage.setItem(key, JSON.stringify({ v: 1, reviewed: ['x', 'gone', 'y', 3] }));
    const store = new ReviewStore(storage, key, ['x', 'y', 'z']);
    expect(store.state()).toEqual({ reviewed: ['x', 'y'], total: 3 });
    expect(store.setReviewed('z', true)).toBe(true);
    expect(store.setReviewed('z', true)).toBe(false);
    expect(store.setReviewed('nope', true)).toBe(false);
    expect(JSON.parse(storage.getItem(key) ?? '{}').reviewed).toEqual(['x', 'y', 'z', 'gone']);
    store.setReviewed('x', false);
    expect(store.state().reviewed).toEqual(['y', 'z']);
    store.setReviewed('y', false);
    store.setReviewed('z', false);
    expect(JSON.parse(storage.getItem(key) ?? '{}').reviewed).toEqual(['gone']);
  });

  it('reloads after another tab wrote the same key', () => {
    const storage = new MemoryStorage();
    const key = reviewKey('a', 'b');
    const store = new ReviewStore(storage, key, ['x', 'y']);
    storage.setItem(key, JSON.stringify({ v: 1, reviewed: ['y'] }));
    expect(store.reload('other-key')).toBe(false);
    expect(store.reload(key)).toBe(true);
    expect(store.state().reviewed).toEqual(['y']);
    expect(store.reload(null)).toBe(false);
  });

  it('upgrades the unversioned format on the next write', () => {
    const storage = new MemoryStorage();
    storage.setItem('k', '["a","gone"]');
    const store = new ReviewStore(storage, 'k', ['a', 'b']);
    expect(store.state().reviewed).toEqual(['a']);
    store.setReviewed('b', true);
    expect(JSON.parse(storage.getItem('k') ?? '')).toEqual({ v: 1, reviewed: ['a', 'b', 'gone'] });
    storage.setItem('k', JSON.stringify({ reviewed: ['a'] }));
    const bare = new ReviewStore(storage, 'k', ['a', 'b']);
    bare.setReviewed('b', true);
    expect(JSON.parse(storage.getItem('k') ?? '').v).toBe(1);
  });

  it('round-trips the versioned format', () => {
    const storage = new MemoryStorage();
    new ReviewStore(storage, 'k', ['a', 'b']).setReviewed('b', true);
    expect(JSON.parse(storage.getItem('k') ?? '')).toEqual({ v: 1, reviewed: ['b'] });
    expect(new ReviewStore(storage, 'k', ['a', 'b']).state().reviewed).toEqual(['b']);
  });

  it('never overwrites a value from a newer version', () => {
    const storage = new MemoryStorage();
    const raw = JSON.stringify({ v: 2, reviewed: ['a'], extra: { seen: 1 } });
    storage.setItem('k', raw);
    const store = new ReviewStore(storage, 'k', ['a', 'b']);
    expect(store.state().reviewed).toEqual(['a']);
    expect(store.setReviewed('b', true)).toBe(true);
    expect(store.has('b')).toBe(true);
    store.setReviewed('a', false);
    expect(storage.getItem('k')).toBe(raw);
  });

  it('accepts a plain array, ignores garbage and works without storage', () => {
    const storage = new MemoryStorage();
    storage.setItem('k', '["a"]');
    expect(new ReviewStore(storage, 'k', ['a']).state().reviewed).toEqual(['a']);
    storage.setItem('k', '{not json');
    expect(new ReviewStore(storage, 'k', ['a']).state().reviewed).toEqual([]);
    const mem = new ReviewStore(null, null, ['a']);
    expect(mem.setReviewed('a', true)).toBe(true);
    expect(mem.has('a')).toBe(true);
  });
});
