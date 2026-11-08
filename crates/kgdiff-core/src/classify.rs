//! Union node ids (docs/algorithms.md §6) and node classification (§4) (`classify.ts`).

use std::sync::Arc;

use indexmap::{IndexMap, IndexSet};

use crate::canonical::{attr_keys, attr_value_equals, attrs_equal, canonicalize};
use crate::js::{JsStr, Lookup};
use crate::matching::StringSet;
use crate::merge_split::{MergeGroup, Restructuring};
use crate::model::{
    AttrChange, Attrs, ChangeStatus, Degree, Id, KGNode, KGraph, NodeFacet, SetChange, UnionId,
    UnionNode, Via,
};
use crate::options::MatchStrategy;
use crate::pipeline::Ctx;
use crate::util::sorted_set_diff;

/// Union ids of before-version nodes that differ from their own id (`assignUnionIds`): matched
/// nodes take the after id; unmatched nodes keep theirs unless an after node uses it, when
/// `@before` is appended (repeatedly if needed).
pub(crate) fn assign_union_ids(
    before: &KGraph,
    after: &KGraph,
    before_to_after: &IndexMap<Id, Id>,
) -> IndexMap<Id, UnionId> {
    let mut renamed: IndexMap<Id, UnionId> = IndexMap::new();
    let mut colliding: Vec<&Id> = Vec::new();
    let mut taken: Lookup<JsStr, ()> = Lookup::new();
    for id in before.nodes.keys() {
        match before_to_after.get(id) {
            Some(m) => {
                if m != id {
                    renamed.insert(id.clone(), m.clone());
                }
            }
            None if after.nodes.contains_key(id) => colliding.push(id),
            None => {
                taken.insert(id.clone(), ());
            }
        }
    }
    colliding.sort();
    for id in colliding {
        let mut union = format!("{id}@before");
        while after.nodes.contains_key(union.as_str()) || taken.contains_key(union.as_str()) {
            union.push_str("@before");
        }
        let union = JsStr::from(union);
        taken.insert(union.clone(), ());
        renamed.insert(id.clone(), union);
    }
    renamed
}

/// Attribute changes sorted by key, `ignore`d keys skipped, values canonicalized
/// (`attrChanges`).
pub(crate) fn attr_changes(before: &Attrs, after: &Attrs, ignore: &StringSet) -> Vec<AttrChange> {
    if attrs_equal(before, after, Some(ignore)) {
        return Vec::new();
    }
    let mut keys: IndexSet<JsStr> = attr_keys(before).into_iter().collect();
    keys.extend(attr_keys(after));
    let mut keys: Vec<JsStr> = keys.into_iter().collect();
    keys.sort();
    let mut changes = Vec::new();
    for key in keys {
        if ignore.contains_key(&key) {
            continue;
        }
        let (b, a) = (before.get(&key), after.get(&key));
        if attr_value_equals(b, a) {
            continue;
        }
        changes.push(AttrChange {
            key,
            before: b.map(canonicalize),
            after: a.map(canonicalize),
        });
    }
    changes
}

/// Union-id views of merges, splits and moves (`RestructureIndex`).
#[derive(Debug, Default)]
pub(crate) struct RestructureIndex {
    /// Union id of a merge source → union id of its target.
    pub merge_target_of: Lookup<UnionId, UnionId>,
    /// Union id of a split source → union ids of its new targets (sorted).
    pub split_targets_of: Lookup<UnionId, Vec<UnionId>>,
    /// Union id of a new split target → union id of its source.
    pub split_source_of: Lookup<UnionId, UnionId>,
    /// `${unionId}\0${predicate}` of every node with a `move` facet on that predicate.
    pub moved: Lookup<String, ()>,
}

pub(crate) fn moved_key(node: &str, predicate: &str) -> String {
    format!("{node}\u{0}{predicate}")
}

fn restructure_index(r: &Restructuring, ctx: &Ctx<'_>) -> RestructureIndex {
    let mut index = RestructureIndex::default();
    for group in &r.merges {
        for s in &group.sources {
            index
                .merge_target_of
                .insert(ctx.union_of_before(&s.id), group.target.clone());
        }
    }
    for group in &r.splits {
        let source = ctx.union_of_before(&group.source);
        index.split_targets_of.insert(
            source.clone(),
            group.targets.iter().map(|t| t.id.clone()).collect(),
        );
        for t in &group.targets {
            index.split_source_of.insert(t.id.clone(), source.clone());
        }
    }
    index
}

/// Parents per hierarchy predicate (`predicate → union ids`).
type Parents = IndexMap<JsStr, IndexSet<UnionId>>;

/// Parents per child and hierarchy predicate, in one pass (`hierarchyParents`).
fn hierarchy_parents(
    graph: &KGraph,
    hierarchy: &StringSet,
    to_union: &dyn Fn(&Id) -> UnionId,
) -> Lookup<Id, Parents> {
    let mut parents: Lookup<Id, Parents> = Lookup::new();
    if hierarchy.is_empty() {
        return parents;
    }
    for edge in graph.edges.values() {
        if !hierarchy.contains_key(&edge.predicate) {
            continue;
        }
        parents
            .get_or_insert_with(edge.source.clone(), IndexMap::new)
            .entry(edge.predicate.clone())
            .or_default()
            .insert(to_union(&edge.target));
    }
    parents
}

/// `move` facets, one per hierarchy predicate whose parent set changed; parents that merged into
/// (or split out of) a node count as that node (`moveFacets`).
fn move_facets(
    before: Option<&Parents>,
    after: Option<&Parents>,
    index: &RestructureIndex,
) -> Vec<NodeFacet> {
    if before.is_none() && after.is_none() {
        return Vec::new();
    }
    let mut predicates: IndexSet<&JsStr> = IndexSet::new();
    predicates.extend(before.into_iter().flat_map(IndexMap::keys));
    predicates.extend(after.into_iter().flat_map(IndexMap::keys));
    let mut predicates: Vec<&JsStr> = predicates.into_iter().collect();
    predicates.sort();
    let empty = IndexSet::new();
    let mut facets = Vec::new();
    for predicate in predicates {
        let from = before.and_then(|p| p.get(predicate)).unwrap_or(&empty);
        let to = after.and_then(|p| p.get(predicate)).unwrap_or(&empty);
        let merged = |u: &UnionId| {
            index
                .merge_target_of
                .get(u)
                .cloned()
                .unwrap_or_else(|| u.clone())
        };
        let split = |u: &UnionId| {
            index
                .split_source_of
                .get(u)
                .cloned()
                .unwrap_or_else(|| u.clone())
        };
        let canonical_from: Lookup<UnionId, ()> =
            from.iter()
                .map(|u| (merged(u), ()))
                .fold(Lookup::new(), |mut set, (k, v)| {
                    set.insert(k, v);
                    set
                });
        let canonical_to: Lookup<UnionId, ()> =
            to.iter()
                .map(|u| (split(u), ()))
                .fold(Lookup::new(), |mut set, (k, v)| {
                    set.insert(k, v);
                    set
                });
        let mut removed: Vec<UnionId> = from
            .iter()
            .filter(|u| !canonical_to.contains_key(&merged(u)))
            .cloned()
            .collect();
        let mut added: Vec<UnionId> = to
            .iter()
            .filter(|u| !canonical_from.contains_key(&split(u)))
            .cloned()
            .collect();
        if !removed.is_empty() || !added.is_empty() {
            removed.sort();
            added.sort();
            facets.push(NodeFacet::Move {
                predicate: predicate.clone(),
                from: removed,
                to: added,
            });
        }
    }
    facets
}

fn set_facet(b: &[JsStr], a: &[JsStr]) -> Option<SetChange> {
    if b == a {
        return None;
    }
    let (added, removed) = sorted_set_diff(b, a);
    Some(SetChange { added, removed })
}

fn merged_into_facet(source: &Id, group: &MergeGroup) -> NodeFacet {
    let contribution = group.sources.iter().find(|s| s.id == *source);
    NodeFacet::MergedInto {
        target: group.target.clone(),
        confidence: contribution.map_or(1.0, |c| c.confidence),
        via: contribution.map_or(Via::Hint, |c| c.via),
    }
}

fn merge_target_facet(ctx: &Ctx<'_>, group: &MergeGroup) -> NodeFacet {
    let mut sources: Vec<UnionId> = group
        .sources
        .iter()
        .map(|s| ctx.union_of_before(&s.id))
        .collect();
    sources.sort();
    NodeFacet::MergeTarget { sources }
}

struct ParentMaps {
    before: Lookup<Id, Parents>,
    after: Lookup<Id, Parents>,
}

/// Facets of a matched pair in canonical order (`matchedFacets`, docs/algorithms.md §4).
fn matched_facets(
    ctx: &Ctx<'_>,
    b: &KGNode,
    a: &KGNode,
    index: &RestructureIndex,
    parents: &ParentMaps,
) -> Vec<NodeFacet> {
    let r = ctx.restructuring;
    let mut facets = Vec::new();
    // With strategy `similarity` ids are declared meaningless: an id difference is no change.
    if b.id != a.id && ctx.options.r#match.strategy != MatchStrategy::Similarity {
        let score = ctx.inferred.get(&b.id).map_or(1.0, |m| m.score);
        facets.push(NodeFacet::Rekey {
            from: b.id.clone(),
            to: a.id.clone(),
            score,
        });
    }
    if b.label != a.label {
        facets.push(NodeFacet::Rename {
            from: b.label.clone(),
            to: a.label.clone(),
        });
    }
    let merged_into = r.merge_of_source(&b.id);
    if let Some(group) = merged_into {
        facets.push(merged_into_facet(&b.id, group));
    }
    if let Some(group) = r.merge_of_target(&a.id) {
        facets.push(merge_target_facet(ctx, group));
    }
    let split_into = r.split_of_source(&b.id);
    if let Some(group) = split_into {
        facets.push(NodeFacet::SplitInto {
            targets: group.targets.iter().map(|t| t.id.clone()).collect(),
        });
    }
    let moves = move_facets(parents.before.get(&b.id), parents.after.get(&a.id), index);
    // A node that is being obsoleted (deprecated, merged or split away) drops its parents as part
    // of the obsoletion; only gaining a parent still counts as a move.
    let obsoleted =
        (!b.deprecated && a.deprecated) || merged_into.is_some() || split_into.is_some();
    facets.extend(
        moves
            .into_iter()
            .filter(|m| !obsoleted || matches!(m, NodeFacet::Move { to, .. } if !to.is_empty())),
    );
    if b.deprecated != a.deprecated {
        facets.push(NodeFacet::Deprecate {
            deprecated: a.deprecated,
        });
    }
    if b.replaces != a.replaces || b.replaced_by != a.replaced_by {
        let (added, removed) = sorted_set_diff(&b.replaces, &a.replaces);
        let replaces = SetChange { added, removed };
        let (added, removed) = sorted_set_diff(&b.replaced_by, &a.replaced_by);
        facets.push(NodeFacet::Replacement {
            replaces,
            replaced_by: SetChange { added, removed },
        });
    }
    if let Some(change) = set_facet(&b.types, &a.types) {
        facets.push(NodeFacet::Types(change));
    }
    if let Some(change) = set_facet(&b.aliases, &a.aliases) {
        facets.push(NodeFacet::Aliases(change));
    }
    let changes = attr_changes(&b.attrs, &a.attrs, &ctx.ignore_attrs);
    if !changes.is_empty() {
        facets.push(NodeFacet::Attrs { changes });
    }
    facets
}

fn union_node(
    ctx: &Ctx<'_>,
    id: UnionId,
    status: ChangeStatus,
    before: Option<&Arc<KGNode>>,
    after: Option<&Arc<KGNode>>,
    facets: Vec<NodeFacet>,
) -> UnionNode {
    let shown = after
        .or(before)
        .unwrap_or_else(|| unreachable!("a union node has a version"));
    UnionNode {
        id,
        status,
        before_id: before.map(|n| n.id.clone()),
        after_id: after.map(|n| n.id.clone()),
        label: shown.label.clone(),
        types: shown.types.clone(),
        degree: Degree {
            before: ctx.before.degree(before.map(|n| n.id.as_str())),
            after: ctx.after.degree(after.map(|n| n.id.as_str())),
        },
        before: before.cloned(),
        after: after.cloned(),
        facets,
        hunk: None,
    }
}

/// One union node per before or after node, sorted by union id, and the restructure index the
/// edge stage needs (`classifyNodes`). A matched node is `modified` exactly when it has a facet.
pub(crate) fn classify_nodes(ctx: &Ctx<'_>) -> (Vec<UnionNode>, RestructureIndex) {
    let r = ctx.restructuring;
    let mut index = restructure_index(r, ctx);
    let parents = ParentMaps {
        before: hierarchy_parents(ctx.before, &ctx.hierarchy, &|id| ctx.union_of_before(id)),
        after: hierarchy_parents(ctx.after, &ctx.hierarchy, &|id| id.clone()),
    };
    let mut nodes = Vec::with_capacity(ctx.before.nodes.len().max(ctx.after.nodes.len()));
    for a in ctx.after.nodes.values() {
        let Some(before_id) = ctx.after_to_before.get(&a.id) else {
            let mut facets = Vec::new();
            if let Some(group) = r.merge_of_target(&a.id) {
                facets.push(merge_target_facet(ctx, group));
            }
            if let Some(split) = r.split_of_target(&a.id) {
                let t = split.targets.iter().find(|c| c.id == a.id);
                facets.push(NodeFacet::SplitFrom {
                    source: ctx.union_of_before(&split.source),
                    confidence: t.map_or(1.0, |t| t.confidence),
                    via: t.map_or(Via::Hint, |t| t.via),
                });
            }
            nodes.push(union_node(
                ctx,
                a.id.clone(),
                ChangeStatus::Added,
                None,
                Some(a),
                facets,
            ));
            continue;
        };
        let b = &ctx.before.nodes[before_id];
        let facets = matched_facets(ctx, b, a, &index, &parents);
        for f in &facets {
            if let NodeFacet::Move { predicate, .. } = f {
                index.moved.insert(moved_key(&a.id, predicate), ());
            }
        }
        let status = if facets.is_empty() {
            ChangeStatus::Unchanged
        } else {
            ChangeStatus::Modified
        };
        nodes.push(union_node(
            ctx,
            a.id.clone(),
            status,
            Some(b),
            Some(a),
            facets,
        ));
    }
    for b in ctx.before.nodes.values() {
        if ctx.before_to_after.contains_key(&b.id) {
            continue;
        }
        let mut facets = Vec::new();
        if let Some(group) = r.merge_of_source(&b.id) {
            facets.push(merged_into_facet(&b.id, group));
        }
        if let Some(group) = r.split_of_source(&b.id) {
            facets.push(NodeFacet::SplitInto {
                targets: group.targets.iter().map(|t| t.id.clone()).collect(),
            });
        }
        nodes.push(union_node(
            ctx,
            ctx.union_of_before(&b.id),
            ChangeStatus::Removed,
            Some(b),
            None,
            facets,
        ));
    }
    nodes.sort_by(|x, y| x.id.cmp(&y.id));
    (nodes, index)
}
