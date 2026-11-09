//! The graph actually laid out (`graph.ts`): the union nodes in scope, re-indexed 0..n−1 in id
//! order, their radii and label blocks, and the links and partner springs among them.

use kgdiff_core::js::{JsStr, Lookup};
use kgdiff_core::model::{NodeFacet, UnionNode};

use crate::geometry::BOX_PADDING;
use crate::math::max;
use crate::text_metrics::{LABEL_GAP, label_box};
use crate::union::{Partner, UnionGraph, build_adjacency};

pub(crate) struct LayoutGraph<'a> {
    pub n: usize,
    pub nodes: Vec<&'a UnionNode>,
    pub index_of: Lookup<JsStr, usize>,
    /// `node_radius(max(degree.before, degree.after))`.
    pub radius: Vec<f64>,
    /// The visual box of node and label relative to the node center: half width, top (negative)
    /// and bottom offsets. Bounds use it, and collision when the layout is label-aware.
    pub box_half_width: Vec<f64>,
    pub box_top: Vec<f64>,
    pub box_bottom: Vec<f64>,
    /// Area of the padded visual box.
    pub box_area: Vec<f64>,
    /// Radius of a disc holding the padded boxes of all neighbours (label-aware link relaxation).
    pub crowding: Vec<f64>,
    /// Distinct neighbours within the layout (drives link and charge strengths).
    pub degree: Vec<usize>,
    /// Distinct undirected links (a, b), a < b.
    pub pairs: Vec<(usize, usize)>,
    pub offsets: Vec<usize>,
    pub adjacency: Vec<usize>,
    pub partners: Vec<Partner>,
}

impl LayoutGraph<'_> {
    pub(crate) fn neighbours(&self, i: usize) -> &[usize] {
        &self.adjacency[self.offsets[i]..self.offsets[i + 1]]
    }
}

/// The label a renamed node had before (its struck second line).
pub(crate) fn label_before(node: &UnionNode) -> Option<&str> {
    node.facets.iter().find_map(|facet| match facet {
        NodeFacet::Rename { from, .. } => Some(from.as_str()),
        _ => None,
    })
}

/// The subgraph of `union` induced by `visible`.
pub(crate) fn build_layout_graph<'a>(
    union: &UnionGraph<'a>,
    visible: &[bool],
    font_size: f64,
) -> LayoutGraph<'a> {
    let mut local = vec![usize::MAX; union.nodes.len()];
    let mut nodes = Vec::new();
    for (u, node) in union.nodes.iter().enumerate() {
        if visible[u] {
            local[u] = nodes.len();
            nodes.push(*node);
        }
    }
    let n = nodes.len();
    let mut index_of = Lookup::with_capacity(n);
    let mut radius = vec![0.0; n];
    let mut box_half_width = vec![0.0; n];
    let mut box_top = vec![0.0; n];
    let mut box_bottom = vec![0.0; n];
    for (i, node) in nodes.iter().enumerate() {
        index_of.insert(node.id.clone(), i);
        let r = crate::node_radius(node.degree.before.max(node.degree.after) as f64);
        let label = label_box(&node.label, label_before(node), font_size);
        radius[i] = r;
        box_half_width[i] = max(r, label.width / 2.0);
        box_top[i] = -r;
        box_bottom[i] = r + LABEL_GAP + label.height;
    }

    let pairs: Vec<(usize, usize)> = union
        .pairs
        .iter()
        .filter_map(|&(a, b)| {
            let (a, b) = (local[a], local[b]);
            (a != usize::MAX && b != usize::MAX).then(|| (a.min(b), a.max(b)))
        })
        .collect();
    let (offsets, adjacency) = build_adjacency(n, &pairs);
    let degree: Vec<usize> = (0..n).map(|i| offsets[i + 1] - offsets[i]).collect();
    let box_area: Vec<f64> = (0..n)
        .map(|i| {
            (2.0 * box_half_width[i] + BOX_PADDING) * (box_bottom[i] - box_top[i] + BOX_PADDING)
        })
        .collect();
    let crowding = (0..n)
        .map(|i| {
            let mut area = 0.0;
            for &v in &adjacency[offsets[i]..offsets[i + 1]] {
                area += box_area[v];
            }
            (area / std::f64::consts::PI).sqrt()
        })
        .collect();

    let partners = union
        .partners
        .iter()
        .filter_map(|p| {
            let (mover, anchor) = (local[p.mover], local[p.anchor]);
            (mover != usize::MAX && anchor != usize::MAX).then_some(Partner { mover, anchor })
        })
        .collect();

    LayoutGraph {
        n,
        nodes,
        index_of,
        radius,
        box_half_width,
        box_top,
        box_bottom,
        box_area,
        crowding,
        degree,
        pairs,
        offsets,
        adjacency,
        partners,
    }
}
