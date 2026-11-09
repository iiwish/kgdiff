//! Extents and rectangles of node and label boxes (`geometry.ts`).

use crate::Rect;
use crate::graph::LayoutGraph;
use crate::math::{max, min, round};

/// The gap kept between node / label boxes (world units).
pub(crate) const BOX_PADDING: f64 = 4.0;

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Extent {
    pub min_x: f64,
    pub min_y: f64,
    pub max_x: f64,
    pub max_y: f64,
}

impl Extent {
    pub(crate) const EMPTY: Extent = Extent {
        min_x: f64::INFINITY,
        min_y: f64::INFINITY,
        max_x: f64::NEG_INFINITY,
        max_y: f64::NEG_INFINITY,
    };

    /// Grows the extent by node `i`'s visual box (circle and label block) centered at (x, y).
    pub(crate) fn include_node(&mut self, graph: &LayoutGraph<'_>, i: usize, x: f64, y: f64) {
        let hw = graph.box_half_width[i];
        self.min_x = min(self.min_x, x - hw);
        self.max_x = max(self.max_x, x + hw);
        self.min_y = min(self.min_y, y + graph.box_top[i]);
        self.max_y = max(self.max_y, y + graph.box_bottom[i]);
    }

    pub(crate) fn is_empty(&self) -> bool {
        #[allow(
            clippy::neg_cmp_op_on_partial_ord,
            reason = "NaN counts as empty, as in TypeScript"
        )]
        let empty = !(self.max_x >= self.min_x);
        empty
    }
}

pub(crate) fn extent_of(
    graph: &LayoutGraph<'_>,
    members: impl IntoIterator<Item = usize>,
    x: &[f64],
    y: &[f64],
) -> Extent {
    let mut extent = Extent::EMPTY;
    for i in members {
        extent.include_node(graph, i, x[i], y[i]);
    }
    extent
}

/// `value || 0`: NaN and `-0` become `0`.
fn or_zero(value: f64) -> f64 {
    if value == 0.0 || value.is_nan() {
        0.0
    } else {
        value
    }
}

fn floor2(v: f64) -> f64 {
    or_zero((v * 100.0).floor() / 100.0)
}

fn ceil2(v: f64) -> f64 {
    or_zero((v * 100.0).ceil() / 100.0)
}

/// The smallest 0.01-aligned rectangle containing `extent` (a zero rectangle when it is empty).
pub(crate) fn to_rect(extent: &Extent) -> Rect {
    if extent.is_empty() {
        return Rect::ZERO;
    }
    let x = floor2(extent.min_x);
    let y = floor2(extent.min_y);
    Rect {
        x,
        y,
        width: round((ceil2(extent.max_x) - x) * 100.0) / 100.0,
        height: round((ceil2(extent.max_y) - y) * 100.0) / 100.0,
    }
}
