//! The result model (`LayoutResult` of `@kgdiff/layout`).

use kgdiff_core::js::{IndexMap, JsStr};
use kgdiff_core::model::{Point, UnionId};

use crate::components::connected_components;
use crate::geometry::{Extent, extent_of, to_rect};
use crate::graph::LayoutGraph;
use crate::{LayoutScope, LayoutStrategy};

/// An axis-aligned rectangle in world units (y down), as `Rect` of `@kgdiff/core`.
#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Rect {
    pub const ZERO: Rect = Rect {
        x: 0.0,
        y: 0.0,
        width: 0.0,
        height: 0.0,
    };
}

/// A connected component of the layout (over links and merge / split partners).
#[derive(Clone, Debug, PartialEq)]
#[non_exhaustive]
pub struct LayoutComponent {
    /// Its nodes, in id order.
    pub nodes: Vec<UnionId>,
    /// The bounds of its node and label boxes.
    pub bounds: Rect,
}

/// How a layout was computed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub struct LayoutStats {
    pub strategy: LayoutStrategy,
    /// The ticks of the largest simulation run (0 when none ran).
    pub iterations: usize,
    /// The number of nodes in scope.
    pub nodes: usize,
}

impl LayoutStats {
    /// Stats of a layout computed elsewhere (the WebAssembly bindings' partial layouts).
    #[doc(hidden)]
    pub fn new(strategy: LayoutStrategy, iterations: usize, nodes: usize) -> LayoutStats {
        LayoutStats {
            strategy,
            iterations,
            nodes,
        }
    }
}

/// A layout: positions and radii of the nodes in scope, their bounds and components.
///
/// Unlike TypeScript's `LayoutResult`, there is no wall-clock time in it (`stats.ms`): no clock
/// is read, so that the crate is the same on every target (callers time it themselves).
#[derive(Clone, Debug, PartialEq)]
#[non_exhaustive]
pub struct LayoutResult {
    /// The position of every node in scope (world units, y down), in id order.
    pub positions: IndexMap<UnionId, Point>,
    /// The radius of every node in scope ([`node_radius`](crate::node_radius) of its max degree
    /// across versions), in id order.
    pub radii: IndexMap<UnionId, f64>,
    /// The bounds of all nodes in scope, label boxes included.
    pub bounds: Rect,
    pub scope: LayoutScope,
    /// For scope `Changes`: per visible node with any, the number of neighbours left out of the
    /// layout, in id order. Empty for scope `All`.
    pub hidden: IndexMap<UnionId, usize>,
    /// Connected components after packing, largest first.
    pub components: Vec<LayoutComponent>,
    pub stats: LayoutStats,
    /// The engine generation the positions come from: [`GENERATOR`](crate::GENERATOR) for
    /// layouts this crate computes or extends, the document's `generator` for a version 2
    /// document read back, `None` for a version 1 document (TypeScript's engine).
    pub generator: Option<JsStr>,
}

/// What [`assemble`] builds a result from.
pub(crate) struct Assemble<'g, 'a> {
    pub graph: &'g LayoutGraph<'a>,
    /// The final positions of every graph node (and possibly of nodes outside the graph).
    pub positions: Vec<(UnionId, Point)>,
    pub radii: Vec<(UnionId, f64)>,
    pub hidden: Vec<(UnionId, usize)>,
    pub scope: LayoutScope,
    pub strategy: LayoutStrategy,
    pub iterations: usize,
}

/// Entries sorted by id (UTF-16 code units), as an ordered map.
fn by_id<T>(mut entries: Vec<(UnionId, T)>) -> IndexMap<UnionId, T> {
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    entries.into_iter().collect()
}

/// The bounds, the components and their bounds, everything in id order.
pub(crate) fn assemble(input: Assemble<'_, '_>) -> LayoutResult {
    let graph = input.graph;
    let positions = by_id(input.positions);
    let mut x = vec![0.0; graph.n];
    let mut y = vec![0.0; graph.n];
    let mut bounds = Extent::EMPTY;
    for (i, node) in graph.nodes.iter().enumerate() {
        let Some(p) = positions.get(node.id.as_str()) else {
            continue;
        };
        x[i] = p.x;
        y[i] = p.y;
        bounds.include_node(graph, i, p.x, p.y);
    }
    let components = connected_components(graph, None)
        .into_iter()
        .map(|members| LayoutComponent {
            nodes: members.iter().map(|&i| graph.nodes[i].id.clone()).collect(),
            bounds: to_rect(&extent_of(graph, members.iter().copied(), &x, &y)),
        })
        .collect();
    let nodes = positions.len();
    LayoutResult {
        positions,
        radii: by_id(input.radii),
        bounds: to_rect(&bounds),
        scope: input.scope,
        hidden: by_id(input.hidden),
        components,
        stats: LayoutStats {
            strategy: input.strategy,
            iterations: input.iterations,
            nodes,
        },
        generator: Some(JsStr::from(crate::GENERATOR)),
    }
}
