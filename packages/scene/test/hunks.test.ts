import { describe, expect, it, vi } from 'vitest';
import { buildScene, hunkOfNode, type Scene } from '../src/index.js';
import { kitchenSink, makeDiff, makeLayout, POSITIONS } from './fixtures.js';

vi.mock('@kgdiff/core', async (orig) => ({
  ...(await orig<object>()),
  formatHunk: (await import('./mock-core.js')).fakeFormatHunk,
}));

/**
 * The lookup a host wrote before `hunkOfNode` existed (Semlia's change view): the node by id,
 * else by `id@before`, then the hunk that lists a node with that id.
 */
function hostLookup(scene: Pick<Scene, 'nodes' | 'hunks'>, id: string): number {
  const node =
    scene.nodes.find((n) => n.id === id) ?? scene.nodes.find((n) => n.id === `${id}@before`);
  if (node && node.hunk >= 0) return node.hunk;
  return scene.hunks.findIndex((h) => h.nodes.some((i) => scene.nodes[i]?.id === id));
}

/**
 * Two removed nodes whose ids the later version reuses: `x` for a new node, `u` for an unchanged
 * one; and `r`, removed with its id free.
 */
function collisions(): Scene {
  const d = makeDiff({
    nodes: [
      { id: 'x', status: 'added', hunk: 'add:x' },
      { id: 'x@before', beforeId: 'x', status: 'removed', hunk: 'remove:x@before' },
      { id: 'u', status: 'unchanged' },
      { id: 'u@before', beforeId: 'u', status: 'removed', hunk: 'remove:u@before' },
      { id: 'r', status: 'removed', hunk: 'remove:r' },
      { id: 'k', status: 'unchanged' },
    ],
    edges: [],
    hunks: [
      { kind: 'add', phase: 'add', anchor: 'x', nodes: ['x'] },
      { kind: 'remove', phase: 'remove', anchor: 'x@before', nodes: ['x@before'] },
      { kind: 'remove', phase: 'remove', anchor: 'u@before', nodes: ['u@before'] },
      { kind: 'remove', phase: 'remove', anchor: 'r', nodes: ['r'] },
    ],
  });
  const positions: Record<string, [number, number]> = {};
  d.nodes.forEach((n, i) => {
    positions[n.id] = [i * 60, 0];
  });
  return buildScene(d, makeLayout(d, positions));
}

describe('hunkOfNode', () => {
  it('names the hunk of a node by its union id, and -1 for unchanged or unknown nodes', () => {
    const s = collisions();
    const hunk = (id: string): number => s.hunkIndex.get(id) ?? -2;
    expect(hunkOfNode(s, 'x')).toBe(hunk('add:x'));
    expect(hunkOfNode(s, 'x@before')).toBe(hunk('remove:x@before'));
    expect(hunkOfNode(s, 'r')).toBe(hunk('remove:r'));
    expect(hunkOfNode(s, 'k')).toBe(-1);
    expect(hunkOfNode(s, 'nope')).toBe(-1);
  });

  it('takes the later version first: an id the later version reuses names its node', () => {
    const s = collisions();
    // `u` is unchanged in the later version; the removed `u` is only reached as `u@before`.
    expect(hunkOfNode(s, 'u')).toBe(-1);
    expect(hunkOfNode(s, 'u@before')).toBe(s.hunkIndex.get('remove:u@before'));
  });

  it('falls back to id@before when no node has the id itself', () => {
    const s = collisions();
    const without: Pick<Scene, 'nodes' | 'nodeIndex'> = {
      nodes: s.nodes,
      nodeIndex: new Map([...s.nodeIndex].filter(([id]) => id !== 'x')),
    };
    expect(hunkOfNode(without, 'x')).toBe(s.hunkIndex.get('remove:x@before'));
  });

  it('gives the answer of the lookup hosts wrote by hand', () => {
    const diff = kitchenSink();
    for (const s of [collisions(), buildScene(diff, makeLayout(diff, POSITIONS))]) {
      const ids = new Set<string>(['nope', '']);
      for (const n of s.nodes) {
        ids.add(n.id);
        ids.add(n.id.replace(/@before$/, ''));
      }
      for (const n of diff.nodes) ids.add(n.beforeId ?? n.id);
      for (const id of ids) expect(hunkOfNode(s, id), id).toBe(hostLookup(s, id));
    }
  });
});
