/**
 * Diff semantics → visual roles and meaning families (docs/visual-language.md §Meaning families).
 */
import type { AttrChange, HunkKind, NodeFacet, UnionEdge, UnionNode } from '@kgdiff/core';
import type { ChangeFamily, EdgeRole, Family, NodeRole } from './types.js';

/** The family a hunk kind is colored with by default. */
export function hunkFamily(kind: HunkKind): ChangeFamily {
  switch (kind) {
    case 'add':
      return 'added';
    case 'remove':
      return 'removed';
    case 'merge':
    case 'split':
      return 'identity';
    case 'relations':
      return 'structure';
    case 'modify':
      return 'content';
    default:
      return assertNever(kind);
  }
}

export function assertNever(value: never): never {
  throw new Error(`Unexpected value ${String(value)}`);
}

const has = (facets: readonly NodeFacet[], kind: NodeFacet['kind']): boolean =>
  facets.some((f) => f.kind === kind);

/**
 * Restructuring roles win (a merge source is drawn as one even when it also changed content);
 * among them merge before split, the side that disappears before the side that stays.
 * Otherwise the status decides; a node that became deprecated has its own role.
 */
export function nodeRole(node: UnionNode): NodeRole {
  const f = node.facets;
  if (has(f, 'mergedInto')) return 'merge-source';
  if (has(f, 'mergeTarget')) return 'merge-target';
  if (has(f, 'splitInto')) return 'split-source';
  if (has(f, 'splitFrom')) return 'split-target';
  const status = node.status;
  switch (status) {
    case 'added':
      return 'added';
    case 'removed':
      return 'removed';
    case 'unchanged':
      return 'unchanged';
    case 'modified':
      return f.some((x) => x.kind === 'deprecate' && x.deprecated) ? 'deprecated' : 'modified';
    default:
      return assertNever(status);
  }
}

/**
 * Family of a node's own (non-restructuring) facets by the primary-facet rule:
 * `rekey` → identity, `move` → structure, anything else → content; none → neutral.
 * "Anything else" deliberately includes facet kinds added later (e.g. `replacement`, changed
 * replacement links): they are content changes unless a merge / split facet makes the node an
 * identity participant, which `nodeRole` handles.
 */
export function ownFacetFamily(facets: readonly NodeFacet[]): Family {
  let family: Family = 'neutral';
  for (const f of facets) {
    switch (f.kind) {
      case 'rekey':
        return 'identity';
      case 'move':
        family = 'structure';
        break;
      case 'mergedInto':
      case 'mergeTarget':
      case 'splitFrom':
      case 'splitInto':
        break;
      default:
        if (family === 'neutral') family = 'content';
    }
  }
  return family;
}

/**
 * Node family from its primary facet. Merge / split participants are identity on both sides
 * (sources are identity ghosts, targets identity rings); deprecated nodes are content.
 */
export function nodeFamily(node: UnionNode, role: NodeRole): Family {
  switch (role) {
    case 'merge-source':
    case 'merge-target':
    case 'split-source':
    case 'split-target':
      return 'identity';
    case 'added':
      return 'added';
    case 'removed':
      return 'removed';
    case 'unchanged':
      return 'neutral';
    case 'deprecated':
      return 'content';
    case 'modified': {
      const own = ownFacetFamily(node.facets);
      return own === 'neutral' ? 'content' : own;
    }
    default:
      return assertNever(role);
  }
}

/**
 * Family a node is drawn in in the `before` layer. Merge / split targets that existed before
 * show their own facets (neutral when they have none); every other node keeps `family`
 * (including nodes absent before, which the before layer hides).
 */
export function nodeFamilyBefore(node: UnionNode, role: NodeRole, family: Family): Family {
  if ((role === 'merge-target' || role === 'split-target') && node.status !== 'added')
    return ownFacetFamily(node.facets);
  return family;
}

export function edgeRole(edge: UnionEdge): EdgeRole {
  for (const f of edge.facets) {
    if (f.kind === 'collapsed') return 'collapsed';
    if (f.kind === 'retarget')
      return f.cause === 'merge' || f.cause === 'split' ? 'carried' : 'retarget';
  }
  return edge.status;
}

export function edgeFamily(edge: UnionEdge, role: EdgeRole): Family {
  switch (role) {
    case 'added':
      return 'added';
    case 'removed':
      return 'removed';
    case 'unchanged':
      return 'neutral';
    case 'collapsed':
    case 'carried':
      return 'identity';
    case 'retarget':
      return 'structure';
    case 'modified':
      return edge.facets.some((f) => f.kind === 'predicate') ? 'structure' : 'content';
    default:
      return assertNever(role);
  }
}

/** `+2 −1 ~1` (U+2212 minus): attributes added / removed / changed; undefined when none. */
export function attrBadge(changes: readonly AttrChange[]): string | undefined {
  let added = 0;
  let removed = 0;
  let changed = 0;
  for (const c of changes) {
    if (c.before === undefined) added++;
    else if (c.after === undefined) removed++;
    else changed++;
  }
  const parts: string[] = [];
  if (added > 0) parts.push(`+${added}`);
  if (removed > 0) parts.push(`−${removed}`);
  if (changed > 0) parts.push(`~${changed}`);
  return parts.length > 0 ? parts.join(' ') : undefined;
}

/** `⊕ n`: number of nodes merged into a merge target. */
export const mergeBadge = (n: number): string => `⊕ ${n}`;

/** Badge text for a node: `⊕ n` for merge targets, else the attribute summary. */
export function nodeBadge(node: UnionNode, role: NodeRole): string | undefined {
  if (role === 'merge-target') {
    const facet = node.facets.find((f) => f.kind === 'mergeTarget');
    if (facet !== undefined && facet.kind === 'mergeTarget' && facet.sources.length > 0) {
      return mergeBadge(facet.sources.length);
    }
  }
  const attrs = node.facets.find((f) => f.kind === 'attrs');
  return attrs !== undefined && attrs.kind === 'attrs' ? attrBadge(attrs.changes) : undefined;
}

/** Old name of a renamed node. */
export function nodeLabelBefore(node: UnionNode): string | undefined {
  const f = node.facets.find((x) => x.kind === 'rename');
  return f !== undefined && f.kind === 'rename' ? f.from : undefined;
}

/** Old display label of an edge whose label or predicate changed. */
export function edgeLabelBefore(edge: UnionEdge): string | undefined {
  for (const f of edge.facets) {
    if (f.kind === 'label') return f.from;
    if (f.kind === 'predicate') {
      const before = edge.before?.label;
      return before !== undefined && before !== edge.label ? before : f.from;
    }
  }
  return undefined;
}
