//! The diff pipeline (`diff.ts`, docs/algorithms.md): normalize → match → merges / splits →
//! classify nodes → pair edges → hunks → delta → order → stats.

use crate::js::IndexMap;

use crate::classify::{assign_union_ids, classify_nodes};
use crate::delta::{Delta, build_delta};
use crate::edges::classify_edges;
use crate::error::{KgdiffError, Result};
use crate::hunks::build_hunks;
use crate::index::DiffIndex;
use crate::js::{JsStr, Lookup, Value};
use crate::matching::{StringSet, align_nodes, sort_suggestions};
use crate::merge_split::{Restructuring, detect_restructuring};
use crate::model::{
    DiffStats, Hunk, Id, KGraph, MatchSuggestion, NodeMatch, UnionEdge, UnionId, UnionNode,
};
use crate::normalize::{Shared, TextForm, normalize_shared};
use crate::options::{DiffOptions, NormalizeOptions};
use crate::order::order_hunks;
use crate::stats::{compute_stats, edge_kinds};
use crate::text::ProfileCache;

/// What the stages of the pipeline share (`PipelineContext`).
pub(crate) struct Ctx<'a> {
    pub before: &'a KGraph,
    pub after: &'a KGraph,
    pub options: &'a DiffOptions,
    pub hierarchy: StringSet,
    pub ignore_attrs: StringSet,
    pub before_to_after: &'a IndexMap<Id, Id>,
    pub after_to_before: &'a IndexMap<Id, Id>,
    /// Matches not implied by equal ids, by before id.
    pub inferred: &'a IndexMap<Id, NodeMatch>,
    pub restructuring: &'a Restructuring,
    /// Before ids whose union id differs from the id (rekeys and `@before` collisions).
    pub renamed: IndexMap<Id, UnionId>,
}

impl Ctx<'_> {
    /// Union id of a before-version node id.
    pub fn union_of_before(&self, id: &Id) -> UnionId {
        self.renamed.get(id).cloned().unwrap_or_else(|| id.clone())
    }
}

/// The result of `diff`: both normalized graphs, the union of their nodes and edges with their
/// changes, the hunks, the matches, the delta and the statistics (`DiffResult`).
#[derive(Clone, Debug)]
#[non_exhaustive]
pub struct DiffResult {
    pub before: KGraph,
    pub after: KGraph,
    pub options: DiffOptions,
    /// Sorted by id.
    pub nodes: Vec<UnionNode>,
    /// Sorted by id.
    pub edges: Vec<UnionEdge>,
    /// Sorted by `order`.
    pub hunks: Vec<Hunk>,
    /// The matches not implied by equal ids (methods `hint` and `similarity`), sorted by `after`.
    pub matches: Vec<NodeMatch>,
    pub suggestions: Vec<MatchSuggestion>,
    pub delta: Delta,
    pub stats: DiffStats,
    /// Lookups by id, built on first use (not serialized).
    pub(crate) index: DiffIndex,
}

impl DiffResult {
    /// The union node with this union id.
    pub fn node(&self, id: &str) -> Option<&UnionNode> {
        self.index.node(&self.nodes, id).map(|i| &self.nodes[i])
    }
    /// The union node of this before-version id.
    pub fn node_by_before(&self, id: &str) -> Option<&UnionNode> {
        self.index
            .node_by_before(&self.nodes, id)
            .map(|i| &self.nodes[i])
    }
    /// The union node of this after-version id.
    pub fn node_by_after(&self, id: &str) -> Option<&UnionNode> {
        self.index
            .node_by_after(&self.nodes, id)
            .map(|i| &self.nodes[i])
    }
    /// The union edge with this union id.
    pub fn edge(&self, id: &str) -> Option<&UnionEdge> {
        self.index.edge(&self.edges, id).map(|i| &self.edges[i])
    }
    /// The hunk with this id.
    pub fn hunk(&self, id: &str) -> Option<&Hunk> {
        self.index.hunk(&self.hunks, id).map(|i| &self.hunks[i])
    }
    /// Incident union edges (both directions), sorted by id.
    pub fn edges_of(&self, id: &str) -> impl Iterator<Item = &UnionEdge> {
        self.index
            .edges_of(&self.edges, id)
            .iter()
            .map(|&i| &self.edges[i])
    }
}

fn set_of(list: &[JsStr]) -> StringSet {
    let mut set = Lookup::new();
    for item in list {
        set.insert(item.clone(), ());
    }
    set
}

/// Suggestions from matching and from merge / split heuristics, one per pair (best score).
fn merge_suggestions(lists: [Vec<MatchSuggestion>; 2]) -> Vec<MatchSuggestion> {
    let mut best: IndexMap<String, MatchSuggestion> = IndexMap::default();
    for s in lists.into_iter().flatten() {
        let key = format!("{}\u{0}{}", s.before, s.after);
        match best.get_mut(&key) {
            Some(seen) if s.score > seen.score => *seen = s,
            Some(_) => {}
            None => {
                best.insert(key, s);
            }
        }
    }
    let mut out: Vec<MatchSuggestion> = best.into_values().collect();
    sort_suggestions(&mut out);
    out
}

/// Runs the pipeline on two normalized graphs with the same edge identity (`diffGraphs`).
///
/// # Errors
///
/// `invalid-input` when a graph's edge identity is not the options' (re-normalize it first).
pub fn diff_graphs(before: KGraph, after: KGraph, options: DiffOptions) -> Result<DiffResult> {
    if before.edge_identity() != options.edge_identity
        || after.edge_identity() != options.edge_identity
    {
        return Err(KgdiffError::invalid_input(format!(
            "Both graphs must be normalized with the edge identity of the options ({})",
            options.edge_identity.as_str()
        )));
    }
    let ignore_attrs = set_of(&options.ignore_attrs);
    let mut profiles = ProfileCache::new();
    let alignment = align_nodes(
        &before,
        &after,
        &options.r#match,
        &ignore_attrs,
        &mut profiles,
    );
    let restructuring = detect_restructuring(
        &before,
        &after,
        &alignment,
        options.detect_merges,
        options.detect_splits,
        &mut profiles,
        &ignore_attrs,
    );
    let renamed = assign_union_ids(&before, &after, &alignment.before_to_after);
    let ctx = Ctx {
        before: &before,
        after: &after,
        options: &options,
        hierarchy: set_of(&options.hierarchy_predicates),
        ignore_attrs,
        before_to_after: &alignment.before_to_after,
        after_to_before: &alignment.after_to_before,
        inferred: &alignment.inferred,
        restructuring: &restructuring,
        renamed,
    };
    let (mut nodes, index) = classify_nodes(&ctx);
    let mut edges = classify_edges(&ctx, &index);
    let drafts = build_hunks(&ctx, &mut nodes, &mut edges);
    let (delta, op_hunks) = build_delta(&ctx, &nodes, &edges);
    let ordered = order_hunks(
        drafts,
        &delta.ops,
        &op_hunks,
        options.edge_identity,
        &mut nodes,
        &mut edges,
    );
    let mut matches: Vec<NodeMatch> = alignment.inferred.values().cloned().collect();
    matches.sort_by(|x, y| x.after.cmp(&y.after));
    let stats = compute_stats(&before, &after, &nodes, &edge_kinds(&edges), &ordered.hunks);
    let suggestions = merge_suggestions([alignment.suggestions, restructuring.suggestions]);
    Ok(DiffResult {
        before,
        after,
        options,
        nodes,
        edges,
        hunks: ordered.hunks,
        matches,
        suggestions,
        delta,
        stats,
        index: DiffIndex::default(),
    })
}

/// Computes the semantic diff between two graph versions given as JSON (`diff`): each is
/// normalized with the options' edge identity, then compared.
///
/// # Errors
///
/// What `normalize` rejects.
pub fn diff(before: &Value, after: &Value, options: &DiffOptions) -> Result<DiffResult> {
    let normalize_options = NormalizeOptions {
        edge_identity: options.edge_identity,
        ..NormalizeOptions::default()
    };
    // The after graph shares the before graph's ids and predicates, which makes comparing them
    // cheaper; the graphs are the same as `normalize` gives.
    let mut shared = Shared::default();
    let before = normalize_shared(before, normalize_options, TextForm::Input, &mut shared)?;
    let mut shared = shared.with_nodes(&before.nodes);
    let after = normalize_shared(after, normalize_options, TextForm::Input, &mut shared)?;
    diff_graphs(before, after, options.clone())
}
