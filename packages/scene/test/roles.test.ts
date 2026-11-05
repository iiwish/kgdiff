import type { EdgeFacet, KGEdge, KGNode, NodeFacet, UnionEdge, UnionNode } from '@kgdiff/core';
import { describe, expect, it } from 'vitest';
import { hunkFamily } from '../src/index.js';
import {
  attrBadge,
  edgeFamily,
  edgeLabelBefore,
  edgeRole,
  nodeBadge,
  nodeFamily,
  nodeFamilyBefore,
  nodeLabelBefore,
  nodeRole,
  ownFacetFamily,
} from '../src/roles.js';

const kgNode: KGNode = {
  id: 'n',
  label: 'n',
  types: [],
  aliases: [],
  attrs: {},
  deprecated: false,
  replaces: [],
  replacedBy: [],
  implicit: false,
};

/** A union node `n` in the versions its status implies. */
const node = (status: UnionNode['status'], facets: NodeFacet[] = []): UnionNode => {
  const common = { id: 'n', facets, label: 'n', types: [], degree: { before: 0, after: 0 } };
  if (status === 'added') return { ...common, status, afterId: 'n', after: kgNode };
  if (status === 'removed') return { ...common, status, beforeId: 'n', before: kgNode };
  return { ...common, status, beforeId: 'n', afterId: 'n', before: kgNode, after: kgNode };
};

const kgEdge = (label: string): KGEdge => ({
  key: 'k',
  source: 'a',
  target: 'b',
  predicate: 'p',
  label,
  attrs: {},
});

/** A union edge a → b in the versions its status implies; `beforeLabel` labels the before one. */
const edge = (
  status: UnionEdge['status'],
  facets: EdgeFacet[] = [],
  beforeLabel = 'p',
): UnionEdge => {
  const common = {
    id: 'e',
    source: 'a',
    target: 'b',
    predicate: 'p',
    label: 'p',
    facets,
    hierarchical: false,
  };
  if (status === 'added') return { ...common, status, afterKey: 'k', after: kgEdge('p') };
  if (status === 'removed') {
    return { ...common, status, beforeKey: 'k', before: kgEdge(beforeLabel) };
  }
  const versions = { beforeKey: 'k', afterKey: 'k', before: kgEdge(beforeLabel) };
  return { ...common, ...versions, status, after: kgEdge('p') };
};

const F = {
  rename: { kind: 'rename', from: 'a', to: 'b' },
  rekey: { kind: 'rekey', from: 'x', to: 'n', score: 0.9 },
  types: { kind: 'types', added: ['T'], removed: [] },
  aliases: { kind: 'aliases', added: [], removed: ['al'] },
  attrs: { kind: 'attrs', changes: [{ key: 'k', before: 1, after: 2 }] },
  move: { kind: 'move', predicate: 'is_a', from: ['p'], to: ['q'] },
  deprecate: { kind: 'deprecate', deprecated: true },
  undeprecate: { kind: 'deprecate', deprecated: false },
  mergedInto: { kind: 'mergedInto', target: 't', confidence: 1, via: 'hint' },
  mergeTarget: { kind: 'mergeTarget', sources: ['s1', 's2', 's3'] },
  splitFrom: { kind: 'splitFrom', source: 's', confidence: 1, via: 'hint' },
  splitInto: { kind: 'splitInto', targets: ['a', 'b'] },
} satisfies Record<string, NodeFacet>;

describe('node roles and families (primary facet rule)', () => {
  it.each<[string, UnionNode['status'], NodeFacet[], string, string]>([
    ['unchanged', 'unchanged', [], 'unchanged', 'neutral'],
    ['added', 'added', [], 'added', 'added'],
    ['removed', 'removed', [], 'removed', 'removed'],
    ['rename', 'modified', [F.rename], 'modified', 'content'],
    ['attrs', 'modified', [F.attrs], 'modified', 'content'],
    ['types', 'modified', [F.types], 'modified', 'content'],
    ['aliases', 'modified', [F.aliases], 'modified', 'content'],
    ['un-deprecation', 'modified', [F.undeprecate], 'modified', 'content'],
    ['move', 'modified', [F.move], 'modified', 'structure'],
    ['rename + move → move wins', 'modified', [F.rename, F.move, F.attrs], 'modified', 'structure'],
    ['rekey', 'modified', [F.rekey], 'modified', 'identity'],
    [
      'rekey + move → identity wins',
      'modified',
      [F.rekey, F.rename, F.move],
      'modified',
      'identity',
    ],
    ['deprecation', 'modified', [F.deprecate], 'deprecated', 'content'],
    [
      'deprecation + move stays content',
      'modified',
      [F.move, F.deprecate],
      'deprecated',
      'content',
    ],
    ['merge source (removed)', 'removed', [F.mergedInto], 'merge-source', 'identity'],
    [
      'merge source (deprecated survivor)',
      'modified',
      [F.mergedInto, F.deprecate],
      'merge-source',
      'identity',
    ],
    ['merge target', 'modified', [F.rename, F.mergeTarget], 'merge-target', 'identity'],
    ['new merge target', 'added', [F.mergeTarget], 'merge-target', 'identity'],
    ['split source', 'modified', [F.splitInto], 'split-source', 'identity'],
    ['removed split source', 'removed', [F.splitInto], 'split-source', 'identity'],
    ['split target', 'added', [F.splitFrom], 'split-target', 'identity'],
  ])('%s', (_name, status, facets, role, family) => {
    const n = node(status, facets);
    const r = nodeRole(n);
    expect(r).toBe(role);
    expect(nodeFamily(n, r)).toBe(family);
  });

  it('ranks restructuring roles: merge source > merge target > split source > split target', () => {
    expect(nodeRole(node('modified', [F.mergeTarget, F.mergedInto]))).toBe('merge-source');
    expect(nodeRole(node('modified', [F.splitInto, F.mergeTarget]))).toBe('merge-target');
    expect(nodeRole(node('modified', [F.splitFrom, F.splitInto]))).toBe('split-source');
  });

  it('maps changed replacement links (core `replacement` facet) to content', () => {
    // Declared locally until core's NodeFacet union includes it.
    const replacement = {
      kind: 'replacement',
      replaces: { added: ['x'], removed: [] },
      replacedBy: { added: [], removed: [] },
    } as unknown as NodeFacet;
    const n = node('modified', [replacement]);
    expect(nodeRole(n)).toBe('modified');
    expect(nodeFamily(n, 'modified')).toBe('content');
    // Not an identity facet on its own: a merge facet decides that.
    const merged = node('modified', [replacement, F.mergeTarget]);
    expect(nodeFamily(merged, nodeRole(merged))).toBe('identity');
    expect(ownFacetFamily([replacement, F.move])).toBe('structure');
  });

  it('draws merge / split targets in their own facet family before', () => {
    const present = node('modified', [F.mergeTarget, F.move]);
    expect(nodeFamilyBefore(present, 'merge-target', 'identity')).toBe('structure');
    const plain = node('modified', [F.mergeTarget]);
    expect(nodeFamilyBefore(plain, 'merge-target', 'identity')).toBe('neutral');
    // Absent before (new target): keeps its family.
    expect(nodeFamilyBefore(node('added', [F.splitFrom]), 'split-target', 'identity')).toBe(
      'identity',
    );
    expect(nodeFamilyBefore(node('removed', []), 'removed', 'removed')).toBe('removed');
  });

  it('computes the own-facet family ignoring restructuring facets', () => {
    expect(ownFacetFamily([F.mergeTarget])).toBe('neutral');
    expect(ownFacetFamily([F.mergeTarget, F.attrs])).toBe('content');
    expect(ownFacetFamily([F.splitFrom, F.move])).toBe('structure');
  });
});

describe('edge roles and families', () => {
  it.each<[string, UnionEdge['status'], EdgeFacet[], string, string]>([
    ['unchanged', 'unchanged', [], 'unchanged', 'neutral'],
    ['added', 'added', [], 'added', 'added'],
    ['removed', 'removed', [], 'removed', 'removed'],
    ['label change', 'modified', [{ kind: 'label', from: 'a', to: 'b' }], 'modified', 'content'],
    ['attrs change', 'modified', [{ kind: 'attrs', changes: [] }], 'modified', 'content'],
    [
      'predicate change',
      'modified',
      [{ kind: 'predicate', from: 'p', to: 'q' }],
      'modified',
      'structure',
    ],
    [
      'retarget (edit)',
      'modified',
      [{ kind: 'retarget', end: 'target', from: 'x', to: 'y', cause: 'edit' }],
      'retarget',
      'structure',
    ],
    [
      'retarget (move)',
      'modified',
      [{ kind: 'retarget', end: 'target', from: 'x', to: 'y', cause: 'move' }],
      'retarget',
      'structure',
    ],
    [
      'carried (merge)',
      'modified',
      [{ kind: 'retarget', end: 'source', from: 'x', to: 'y', cause: 'merge' }],
      'carried',
      'identity',
    ],
    [
      'carried (split)',
      'modified',
      [{ kind: 'retarget', end: 'source', from: 'x', to: 'y', cause: 'split' }],
      'carried',
      'identity',
    ],
    ['collapsed', 'removed', [{ kind: 'collapsed', into: 'z' }], 'collapsed', 'identity'],
  ])('%s', (_name, status, facets, role, family) => {
    const e = edge(status, facets);
    const r = edgeRole(e);
    expect(r).toBe(role);
    expect(edgeFamily(e, r)).toBe(family);
  });
});

describe('badges and labels', () => {
  it('summarizes attribute changes as +added −removed ~changed (U+2212)', () => {
    expect(
      attrBadge([
        { key: 'a', after: 1 },
        { key: 'b', after: null },
        { key: 'c', before: 'x' },
        { key: 'd', before: 1, after: 2 },
      ]),
    ).toBe('+2 −1 ~1');
    expect(attrBadge([{ key: 'a', before: null, after: 0 }])).toBe('~1');
    expect(attrBadge([{ key: 'c', before: 'x' }])).toBe('−1');
    expect(attrBadge([])).toBeUndefined();
  });

  it('badges merge targets with ⊕ n', () => {
    expect(nodeBadge(node('modified', [F.mergeTarget, F.attrs]), 'merge-target')).toBe('⊕ 3');
    expect(nodeBadge(node('modified', [F.attrs]), 'modified')).toBe('~1');
    expect(nodeBadge(node('modified', [F.rename]), 'modified')).toBeUndefined();
  });

  it('keeps old names of renamed nodes and relabeled edges', () => {
    expect(nodeLabelBefore(node('modified', [F.rename]))).toBe('a');
    expect(nodeLabelBefore(node('modified', [F.attrs]))).toBeUndefined();
    expect(edgeLabelBefore(edge('modified', [{ kind: 'label', from: 'held', to: 'owns' }]))).toBe(
      'held',
    );
    const relabeled = {
      ...edge('modified', [{ kind: 'predicate', from: 'ex:p', to: 'ex:q' }], 'p'),
      label: 'q',
    };
    expect(edgeLabelBefore(relabeled)).toBe('p');
    expect(
      edgeLabelBefore(edge('modified', [{ kind: 'predicate', from: 'ex:p', to: 'ex:q' }])),
    ).toBe('ex:p');
    expect(edgeLabelBefore(edge('modified', []))).toBeUndefined();
  });

  it('maps hunk kinds to default families', () => {
    expect(hunkFamily('add')).toBe('added');
    expect(hunkFamily('remove')).toBe('removed');
    expect(hunkFamily('merge')).toBe('identity');
    expect(hunkFamily('split')).toBe('identity');
    expect(hunkFamily('relations')).toBe('structure');
    expect(hunkFamily('modify')).toBe('content');
  });
});
