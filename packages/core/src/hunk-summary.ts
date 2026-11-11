/**
 * The summary of a hunk: what `buildHunks` records and what `diffFromJSON` checks.
 */
import { FACET_ORDER } from './model.js';
import type { ChangeStatus, CountTriplet, FacetKind, HunkSummary } from './types.js';

type Counted = { readonly status: ChangeStatus; readonly facets: readonly { kind: FacetKind }[] };

/** The summary of a hunk owning `nodes` and `edges` (also used to check diffs read from JSON). */
export function hunkSummary(nodes: readonly Counted[], edges: readonly Counted[]): HunkSummary {
  const kinds = new Set<FacetKind>();
  const count = (elements: readonly Counted[]): CountTriplet => {
    const c = { added: 0, removed: 0, modified: 0 };
    for (const e of elements) {
      if (e.status !== 'unchanged') c[e.status]++;
      for (const f of e.facets) kinds.add(f.kind);
    }
    return c;
  };
  return {
    nodes: count(nodes),
    edges: count(edges),
    facets: FACET_ORDER.filter((k) => kinds.has(k)),
  };
}
