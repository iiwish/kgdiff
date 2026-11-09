//! Final placements that look for free spots instead of pushing (`forces/free-spot.ts`).
//!
//! - [`dock_partners`]: the weak partner springs bring merge sources towards their target, but
//!   many-body repulsion and label boxes keep the pair about an edge length apart. For replay
//!   (sources travel into the target, split targets emerge from their source) and for reading
//!   the overlay (the ghost sits right next to what it became), a mover farther than
//!   `max_distance` from its anchor moves to the best free spot around the anchor.
//! - [`settle_overlapping`]: around fixed nodes a free node can end up wedged where pushing
//!   cannot free it; it moves to the free spot nearest to its neighbours instead.
//!
//! Both test candidate spots (16 directions × a few rings) against the boxes near the searched
//! area, collected once per node; they only run for the few nodes that need them.

use std::f64::consts::{FRAC_1_SQRT_2, SQRT_2};

use super::Bodies;
use super::collide::Boxes;
use super::springs::Spring;
use crate::math::{max, min};

const C1: f64 = 0.923_879_532_511_286_7;
const S1: f64 = 0.382_683_432_365_089_8;
const D: f64 = FRAC_1_SQRT_2;
/// Unit vectors every 22.5°, starting straight down (below the anchor's label), exact literals.
const DIRECTIONS: [(f64, f64); 16] = [
    (0.0, 1.0),
    (S1, C1),
    (D, D),
    (C1, S1),
    (1.0, 0.0),
    (C1, -S1),
    (D, -D),
    (S1, -C1),
    (0.0, -1.0),
    (-S1, -C1),
    (-D, -D),
    (-C1, -S1),
    (-1.0, 0.0),
    (-C1, S1),
    (-D, D),
    (-S1, C1),
];
const DOCK_RINGS: [f64; 5] = [1.0, 1.35, 1.7, 2.1, 2.6];
/// The extra score (× `max_distance`) charged to a spot that other nodes must vacate.
const OCCUPIED_PENALTY: f64 = 0.4;
/// Square lattice rings searched around a wedged node (ring k at k × step from home).
const SETTLE_RINGS: usize = 32;

fn distance(ax: f64, ay: f64, bx: f64, by: f64) -> f64 {
    ((ax - bx) * (ax - bx) + (ay - by) * (ay - by)).sqrt()
}

/// The nodes whose boxes could touch node `m`'s box anywhere within `radius` of (cx, cy): the
/// candidate search then tests only these (O(n) once per searched node, not per candidate).
#[allow(clippy::too_many_arguments, reason = "mirrors free-spot.ts")]
fn nearby(
    bodies: &Bodies,
    boxes: &Boxes,
    padding: f64,
    m: usize,
    cx: f64,
    cy: f64,
    radius: f64,
    out: &mut Vec<usize>,
) {
    let (hw, hh, oy) = (&boxes.half_width, &boxes.half_height, &boxes.offset_y);
    out.clear();
    for j in 0..bodies.len() {
        if j == m {
            continue;
        }
        if (bodies.x[j] - cx).abs() > radius + hw[m] + hw[j] + padding {
            continue;
        }
        let dy = bodies.y[j] + oy[j] - (cy + oy[m]);
        if dy.abs() > radius + hh[m] + hh[j] + padding {
            continue;
        }
        out.push(j);
    }
}

/// True when node `m`'s padded box centered at (x, y) overlaps none of `others`' boxes, or
/// (with `blocking`) none for which `blocking(j)` holds.
#[allow(clippy::too_many_arguments, reason = "mirrors free-spot.ts")]
fn is_free(
    bodies: &Bodies,
    others: &[usize],
    boxes: &Boxes,
    padding: f64,
    m: usize,
    x: f64,
    y: f64,
    blocking: Option<&dyn Fn(usize) -> bool>,
) -> bool {
    let (hw, hh, oy) = (&boxes.half_width, &boxes.half_height, &boxes.offset_y);
    let cy = y + oy[m];
    for &j in others {
        if j == m || blocking.is_some_and(|b| !b(j)) {
            continue;
        }
        if (bodies.x[j] - x).abs() >= hw[m] + hw[j] + padding {
            continue;
        }
        if (bodies.y[j] + oy[j] - cy).abs() >= hh[m] + hh[j] + padding {
            continue;
        }
        return false;
    }
    true
}

#[derive(Clone, Copy)]
struct Spot {
    x: f64,
    y: f64,
    score: f64,
}

/// Docks merge sources / split targets (`mover`) farther than `max_distance` from their
/// partner. Candidate spots touch the anchor's box in 16 directions, on 5 rings; the winner
/// minimizes the distance to the anchor plus 0.3 × the distance travelled (so that the mover stays
/// on the side its edges come from). A spot occupied only by movable nodes competes with a
/// penalty of 0.4 × `max_distance`; when it wins, the caller pushes those nodes aside. Only spots
/// closer to the anchor than the mover's current position count.
///
/// Returns the simulation indices of docked movers and their anchors (to pin while making room),
/// ascending.
pub(crate) fn dock_partners(
    bodies: &mut Bodies,
    springs: &[Spring],
    boxes: &Boxes,
    inv_mass: &[f64],
    padding: f64,
    max_distance: f64,
) -> Vec<usize> {
    let (hw, hh, oy) = (&boxes.half_width, &boxes.half_height, &boxes.offset_y);
    let top = |i: usize| oy[i] - hh[i];
    let bottom = |i: usize| oy[i] + hh[i];
    let gap = padding + 0.05;
    let mut pinned = vec![false; bodies.len()];
    let mut others = Vec::new();
    let last_ring = DOCK_RINGS[DOCK_RINGS.len() - 1];

    for &Spring { mover, anchor } in springs {
        if inv_mass[mover] == 0.0 || pinned[mover] {
            continue;
        }
        let (mx, my) = (bodies.x[mover], bodies.y[mover]);
        let (ax, ay) = (bodies.x[anchor], bodies.y[anchor]);
        let current = distance(mx, my, ax, ay);
        if current <= max_distance {
            continue;
        }

        let reach_x = (hw[anchor] + hw[mover] + gap) * last_ring;
        let reach_y =
            (max(bottom(anchor) - top(mover), bottom(mover) - top(anchor)) + gap) * last_ring;
        nearby(
            bodies,
            boxes,
            padding,
            mover,
            ax,
            ay,
            max(reach_x, reach_y),
            &mut others,
        );
        let immovable = |j: usize| inv_mass[j] == 0.0 || pinned[j];
        let mut free: Option<Spot> = None;
        let mut occupied: Option<Spot> = None;
        for ring in DOCK_RINGS {
            for (ux, uy) in DIRECTIONS {
                let tx = if ux == 0.0 {
                    f64::INFINITY
                } else {
                    (hw[anchor] + hw[mover] + gap) / ux.abs()
                };
                let ty = if uy == 0.0 {
                    f64::INFINITY
                } else if uy > 0.0 {
                    (bottom(anchor) + gap - top(mover)) / uy
                } else {
                    (bottom(mover) + gap - top(anchor)) / -uy
                };
                let t = min(tx, ty) * ring;
                let x = ax + ux * t;
                let y = ay + uy * t;
                let to_anchor = distance(x, y, ax, ay);
                if to_anchor >= current {
                    continue;
                }
                let score = to_anchor + 0.3 * distance(x, y, mx, my);
                if is_free(bodies, &others, boxes, padding, mover, x, y, None) {
                    if free.is_none_or(|f| score < f.score - 1e-9) {
                        free = Some(Spot { x, y, score });
                    }
                } else if occupied.is_none_or(|o| score < o.score - 1e-9)
                    && is_free(
                        bodies,
                        &others,
                        boxes,
                        padding,
                        mover,
                        x,
                        y,
                        Some(&immovable),
                    )
                {
                    occupied = Some(Spot { x, y, score });
                }
            }
        }
        // An occupied spot must be clearly better to be worth pushing the neighbours aside.
        let penalty = OCCUPIED_PENALTY * max_distance;
        let best = match (occupied, free) {
            (Some(o), Some(f)) if o.score + penalty < f.score => Some(o),
            (Some(o), None) => Some(o),
            (_, f) => f,
        };
        if let Some(best) = best {
            bodies.x[mover] = best.x;
            bodies.y[mover] = best.y;
            bodies.vx[mover] = 0.0;
            bodies.vy[mover] = 0.0;
            pinned[mover] = true;
            pinned[anchor] = true;
        }
    }
    (0..bodies.len()).filter(|&k| pinned[k]).collect()
}

/// Moves every movable node whose box still overlaps another to the free spot nearest to
/// `home(k)` (its neighbours' barycenter). Candidates lie on square rings of a lattice around
/// home (spacing ≈ the node's box height, so that gaps between neighbours are found at any
/// radius); the first ring with a free spot wins, and on it the spot closest to home. Nodes are
/// processed in index order.
pub(crate) fn settle_overlapping(
    bodies: &mut Bodies,
    boxes: &Boxes,
    inv_mass: &[f64],
    padding: f64,
    home: impl Fn(&Bodies, usize) -> (f64, f64),
) {
    let hh = &boxes.half_height;
    let mut others = Vec::new();
    for k in 0..bodies.len() {
        if inv_mass[k] == 0.0 {
            continue;
        }
        let (x, y) = (bodies.x[k], bodies.y[k]);
        nearby(bodies, boxes, padding, k, x, y, 0.0, &mut others);
        if is_free(bodies, &others, boxes, padding, k, x, y, None) {
            continue;
        }
        let (hx, hy) = home(bodies, k);
        let step = max(12.0, hh[k] + padding);
        // The nearby nodes for the next 8 rings at a time, so that the search stays local.
        for ring in 1..=SETTLE_RINGS {
            if (ring - 1) % 8 == 0 {
                let radius = step * (ring + 7) as f64 * SQRT_2;
                nearby(bodies, boxes, padding, k, hx, hy, radius, &mut others);
            }
            let mut best: Option<(f64, f64, f64)> = None;
            let mut consider = |x: f64, y: f64| {
                let d = distance(x, y, hx, hy);
                if best.is_some_and(|(_, _, bd)| d >= bd - 1e-9) {
                    return;
                }
                if is_free(bodies, &others, boxes, padding, k, x, y, None) {
                    best = Some((x, y, d));
                }
            };
            let r = ring as f64 * step;
            let ring_i = i64::try_from(ring).expect("a small ring number");
            for i in -ring_i..=ring_i {
                let i = i as f64;
                consider(hx + i * step, hy - r);
                consider(hx + i * step, hy + r);
            }
            for j in (1 - ring_i)..ring_i {
                let j = j as f64;
                consider(hx - r, hy + j * step);
                consider(hx + r, hy + j * step);
            }
            if let Some((bx, by, _)) = best {
                bodies.x[k] = bx;
                bodies.y[k] = by;
                break;
            }
        }
    }
}
