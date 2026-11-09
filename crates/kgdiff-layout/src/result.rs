//! The result model (`LayoutResult` of `@kgdiff/layout`).

use kgdiff_core::js::IndexMap;
use kgdiff_core::model::{Point, UnionId};

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
pub struct LayoutComponent {
    /// Its nodes, in id order.
    pub nodes: Vec<UnionId>,
    /// The bounds of its node and label boxes.
    pub bounds: Rect,
}

/// How a layout was computed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LayoutStats {
    pub strategy: LayoutStrategy,
    /// The ticks of the largest simulation run (0 when none ran).
    pub iterations: usize,
    /// The number of nodes in scope.
    pub nodes: usize,
}

/// A layout: positions and radii of the nodes in scope, their bounds and components.
///
/// Unlike TypeScript's `LayoutResult`, there is no wall-clock time in it (`stats.ms`): no clock
/// is read, so that the crate is the same on every target (callers time it themselves).
#[derive(Clone, Debug, PartialEq)]
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
}
