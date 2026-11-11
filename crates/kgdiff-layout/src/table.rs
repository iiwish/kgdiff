//! What the layout reads of a union graph, as plain tables: the input of the layout-only
//! WebAssembly module (`crates/kgdiff-wasm`, RFC 0002, §7, "Why the split"), which has neither a
//! JSON reader nor a [`DiffResult`](kgdiff_core::DiffResult). [`layout_diff`](crate::layout_diff)
//! and the other functions of this crate turn their [`LayoutInput`] into a table first, so the
//! two paths share all the code that places nodes.
//!
//! For the bindings: not part of this crate's semver promise.

use kgdiff_core::Result;
use kgdiff_core::js::{IndexMap, JsStr, Lookup};
use kgdiff_core::model::{ChangeStatus, Id, NodeFacet, Point, UnionId, UnionNode};

use crate::{LayoutInput, LayoutOptions, LayoutResult, carry, extend, pipeline};

/// A node as the layout sees it.
#[derive(Clone, Debug, PartialEq)]
pub struct TableNode {
    pub id: UnionId,
    /// Its status is not `unchanged`.
    pub changed: bool,
    pub before_id: Option<Id>,
    pub after_id: Option<Id>,
    /// The label drawn, and the struck one of a renamed node.
    pub label: JsStr,
    pub label_before: Option<JsStr>,
    /// The larger of its degrees in the two versions.
    pub degree: usize,
    /// The finite `position` of its before version, else of its after version.
    pub position: Option<Point>,
}

/// An edge as the layout sees it: indices into [`LayoutTable::nodes`], `None` for an end that is
/// not a node of the table.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TableEdge {
    pub source: Option<usize>,
    pub target: Option<usize>,
    /// The ends in the before version: the same as `source` and `target` unless retargeted.
    pub source_before: Option<usize>,
    pub target_before: Option<usize>,
    /// Its status is not `unchanged`.
    pub changed: bool,
}

/// A union graph as tables: nodes in id order and edges in the order of their ids (UTF-16 code
/// units), as the layout needs them for its result not to depend on the input's order.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct LayoutTable {
    pub nodes: Vec<TableNode>,
    pub edges: Vec<TableEdge>,
    /// Merge / split pairs, each `(mover, anchor)`: the node that should travel little during
    /// replay and its partner, as indices into `nodes`.
    pub partners: Vec<(usize, usize)>,
}

/// `items` in id order: as given when already sorted (union nodes and edges of a diff are), else
/// sorted by id.
fn sorted_by_id<T>(items: &[T], id: impl Fn(&T) -> &JsStr) -> Vec<&T> {
    let mut out: Vec<&T> = items.iter().collect();
    if out.windows(2).any(|w| id(w[0]) > id(w[1])) {
        out.sort_by(|a, b| id(a).cmp(id(b)));
    }
    out
}

fn finite(p: Option<&Point>) -> Option<Point> {
    p.filter(|p| p.x.is_finite() && p.y.is_finite()).copied()
}

fn table_node(node: &UnionNode) -> TableNode {
    let label_before = node.facets.iter().find_map(|facet| match facet {
        NodeFacet::Rename { from, .. } => Some(from.clone()),
        _ => None,
    });
    TableNode {
        id: node.id.clone(),
        changed: node.status != ChangeStatus::Unchanged,
        before_id: node.before_id.clone(),
        after_id: node.after_id.clone(),
        label: node.label.clone(),
        label_before,
        degree: node.degree.before.max(node.degree.after),
        position: finite(node.before.as_ref().and_then(|n| n.position()).as_ref())
            .or_else(|| finite(node.after.as_ref().and_then(|n| n.position()).as_ref())),
    }
}

impl From<LayoutInput<'_>> for LayoutTable {
    fn from(input: LayoutInput<'_>) -> LayoutTable {
        let nodes = sorted_by_id(input.nodes, |n| &n.id);
        let mut index_of = Lookup::with_capacity(nodes.len());
        for (i, node) in nodes.iter().enumerate() {
            index_of.insert(node.id.clone(), i);
        }
        let lookup = |id: &JsStr| index_of.get(id.as_str()).copied();

        let edges = sorted_by_id(input.edges, |e| &e.id)
            .into_iter()
            .map(|edge| {
                let source = lookup(&edge.source);
                let target = lookup(&edge.target);
                TableEdge {
                    source,
                    target,
                    source_before: edge.source_before.as_ref().map_or(source, lookup),
                    target_before: edge.target_before.as_ref().map_or(target, lookup),
                    changed: edge.status != ChangeStatus::Unchanged,
                }
            })
            .collect();

        let mut partners = Vec::new();
        for (i, node) in nodes.iter().enumerate() {
            for facet in &node.facets {
                match facet {
                    NodeFacet::MergedInto { target, .. } => {
                        partners.extend(lookup(target).map(|anchor| (i, anchor)));
                    }
                    NodeFacet::SplitFrom { source, .. } => {
                        partners.extend(lookup(source).map(|anchor| (i, anchor)));
                    }
                    NodeFacet::MergeTarget { sources } => {
                        partners.extend(sources.iter().filter_map(&lookup).map(|m| (m, i)));
                    }
                    NodeFacet::SplitInto { targets } => {
                        partners.extend(targets.iter().filter_map(&lookup).map(|m| (m, i)));
                    }
                    _ => {}
                }
            }
        }

        LayoutTable {
            nodes: nodes.into_iter().map(table_node).collect(),
            edges,
            partners,
        }
    }
}

/// [`layout_diff`](crate::layout_diff) of a table.
///
/// # Errors
///
/// As `layout_diff`.
pub fn layout_table(table: &LayoutTable, options: &LayoutOptions) -> Result<LayoutResult> {
    pipeline::layout(table, options)
}

/// [`layout_graph`](crate::layout_graph) of a graph given as the table of its diff with itself.
///
/// # Errors
///
/// As `layout_graph`.
pub fn layout_graph_table(table: &LayoutTable, options: &LayoutOptions) -> Result<LayoutResult> {
    pipeline::layout(table, &options.for_graph()?)
}

/// [`layout_diff_on`](crate::layout_diff_on) of a table.
///
/// # Errors
///
/// As `layout_diff_on`.
pub fn layout_table_on(
    table: &LayoutTable,
    previous: &LayoutResult,
    options: &LayoutOptions,
) -> Result<LayoutResult> {
    carry::diff_on(table, previous, options)
}

/// [`layout_after`](crate::layout_after) of a diff given as a table, `after` being the table of
/// the after version's diff with itself.
///
/// # Errors
///
/// As `layout_after`.
pub fn layout_after_table(
    diff: &LayoutTable,
    after: &LayoutTable,
    layout: &LayoutResult,
    options: &LayoutOptions,
) -> Result<LayoutResult> {
    options.keeps_positions("the positions of the diff's layout are kept")?;
    let mut options = options.for_graph()?;
    options.pinned = carry::after_pins(diff, layout)?;
    pipeline::layout(after, &options)
}

/// [`extend_layout`](crate::extend_layout) of a table.
///
/// # Errors
///
/// As `extend_layout`.
pub fn extend_table(
    table: &LayoutTable,
    layout: &LayoutResult,
    nodes: &[UnionId],
    options: &LayoutOptions,
) -> Result<LayoutResult> {
    extend::extend(table, layout, nodes, options)
}

/// The positions, radii and hidden counts [`extend_table`] and the others read of a layout, with
/// the rest empty: what the bindings rebuild of a layout that lives on the other side.
pub fn partial_layout(
    positions: IndexMap<UnionId, Point>,
    radii: IndexMap<UnionId, f64>,
    hidden: IndexMap<UnionId, usize>,
    scope: crate::LayoutScope,
    stats: crate::LayoutStats,
) -> LayoutResult {
    LayoutResult {
        positions,
        radii,
        bounds: crate::Rect::ZERO,
        scope,
        hidden,
        components: Vec::new(),
        stats,
        generator: None,
    }
}
