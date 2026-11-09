//! Force parameters (`forces/params.ts`) and their label-aware adjustments.
//!
//! Spec values:
//! - link distance `L·(1 + 0.15·log₂(1 + min(deg_s, deg_t)))`, strength `1 / min(deg_s, deg_t)`;
//! - many-body strength `−(220 + 40·√degree)` (θ 0.9, cut-off 900), scaled by
//!   `(linkDistance / 56)²` so that the picture scales with the `link_distance` option.
//!
//! Label-aware adjustments, which reduce to the spec values for ordinary labels and
//! neighbourhoods:
//! - charge × `clamp(boxArea / 1.5·L², 1, 3)`: a node whose label block needs more room than the
//!   ~L² the spec charge buys pushes proportionally harder, so that the layout makes room for long
//!   labels globally instead of jamming them locally;
//! - link strength × `min(1, 2·distance / crowding)`, where `crowding` is the radius of a disc
//!   holding the label blocks of a node's neighbours: the links of a hub with hundreds of
//!   labelled leaves relax, so that the leaves spread into a disc instead of being squeezed into
//!   a ring of radius L that cannot hold them.

use crate::graph::LayoutGraph;
use crate::math::{log2, max, min};
use crate::options::LINK_DISTANCE;

const LABEL_CHARGE_MAX: f64 = 3.0;
const LABEL_AREA_REF: f64 = 1.5;
const CROWDING_RATIO: f64 = 2.0;
/// Gravity of a component with ≤ 16 nodes; larger components get less (see [`gravity_for`]).
const GRAVITY: f64 = 0.3;
/// 400 nodes, in units of 16.
const GRAVITY_KNEE: f64 = 25.0;

pub(crate) fn link_distance(link_distance_option: f64, min_degree: f64) -> f64 {
    link_distance_option * (1.0 + 0.15 * log2(1.0 + min_degree))
}

pub(crate) fn link_strength(
    graph: &LayoutGraph<'_>,
    a: usize,
    b: usize,
    distance: f64,
    label_aware: bool,
) -> f64 {
    let min_degree = graph.degree[a].min(graph.degree[b]).max(1) as f64;
    let strength = 1.0 / min_degree;
    if !label_aware {
        return strength;
    }
    let crowding = max(graph.crowding[a], graph.crowding[b]);
    let limit = CROWDING_RATIO * distance;
    if crowding > limit {
        (strength * limit) / crowding
    } else {
        strength
    }
}

pub(crate) fn charge_strength(
    graph: &LayoutGraph<'_>,
    i: usize,
    link_distance_option: f64,
    label_aware: bool,
) -> f64 {
    // The spec constants are tuned for the default link distance; scaling by (L / 56)² keeps the
    // equilibrium shape, so that a larger `link_distance` gives a proportionally larger picture.
    let scale = link_distance_option / LINK_DISTANCE;
    let base = -(220.0 + 40.0 * (graph.degree[i] as f64).sqrt()) * scale * scale;
    if !label_aware {
        return base;
    }
    let ratio = graph.box_area[i] / (LABEL_AREA_REF * link_distance_option * link_distance_option);
    base * min(LABEL_CHARGE_MAX, max(1.0, ratio))
}

/// A pull towards the component center (not in the spec): keeps components round and compact.
/// A linear pull compresses the core of a large component (its pressure grows with the
/// radius), so it decays with size: `0.3 / √(n/16)` up to 400 nodes, then as `(n/400)^−0.75`.
/// Powers are built from square roots only.
pub(crate) fn gravity_for(size: usize) -> f64 {
    let s = max(1.0, size as f64 / 16.0);
    if s <= GRAVITY_KNEE {
        return GRAVITY / s.sqrt();
    }
    let r = s / GRAVITY_KNEE;
    GRAVITY / GRAVITY_KNEE.sqrt() / (r.sqrt() * r.sqrt().sqrt())
}

/// The many-body cut-off of the spec.
pub(crate) const CHARGE_RANGE: f64 = 900.0;

/// The many-body cut-off when refining around fixed nodes: when most of the picture is fixed,
/// new nodes should settle into local gaps next to their neighbours instead of being blown out
/// of the graph by the summed repulsion of everything already placed.
pub(crate) fn anchored_charge_range(free_share: f64, link_distance_option: f64) -> f64 {
    if free_share >= 0.5 {
        CHARGE_RANGE
    } else {
        min(CHARGE_RANGE, 4.0 * link_distance_option)
    }
}
