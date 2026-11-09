//! The force simulation (`simulate.ts`). The tick loop is kgdiff's own (d3's `forceSimulation`,
//! with its `Math.pow` decay and trigonometric start, is not ported): a fixed number of ticks,
//! and forces that change between phases:
//!
//! 1. structure (the first ~35% of ticks): links, charge and node-only collision; the graph
//!    unfolds without label boxes jamming it;
//! 2. orientation (union layouts): the component is rotated onto its principal axis (wide
//!    layouts suit screens and horizontal labels) and mirrored to a canonical handedness; if its
//!    label boxes could not fit in its extent, it is scaled up once (`make_room`);
//! 3. labels: label boxes grow from 50% to 100% over ~25% of the ticks, then hold. Collision is
//!    not scaled by alpha: it keeps working while the other forces cool down;
//! 4. a position-level pass removes any overlap left, and merge / split partners that ended up
//!    far apart are docked next to each other.

use crate::forces::Bodies;
use crate::forces::collide::{Boxes, Collider, collide_velocities, remove_overlaps};
use crate::forces::free_spot::dock_partners;
use crate::forces::link::{LinkForce, SimLink};
use crate::forces::many_body::ManyBody;
use crate::forces::springs::{Spring, apply_gravity, apply_springs};
use crate::math::{cooling_factor, max, min, round};
use crate::options::to_count;
use crate::prng::Mulberry32;

pub(crate) struct Spec<'a> {
    /// Initial positions; fixed bodies keep theirs.
    pub bodies: &'a mut Bodies,
    pub links: Vec<SimLink>,
    pub springs: Vec<Spring>,
    /// Many-body strength per body (negative = repulsion).
    pub charge: Vec<f64>,
    /// Node-only boxes (structure phase).
    pub node_boxes: &'a Boxes,
    /// Node and label boxes (label phase and the final overlap removal).
    pub label_boxes: &'a Boxes,
    /// 0 = immovable (fixed node).
    pub inv_mass: &'a [f64],
    pub ticks: usize,
    /// The starting alpha (1 for a fresh layout, lower to refine around fixed nodes).
    pub alpha: f64,
    /// Pull towards the origin; 0 disables it (anchored layouts).
    pub gravity: f64,
    /// Rotate and mirror into the canonical orientation after the structure phase.
    pub orient: bool,
    pub spring_strength: f64,
    pub spring_length: f64,
    /// Partners farther apart than this are docked next to each other at the end (0 = never).
    pub dock_distance: f64,
    /// The many-body cut-off.
    pub charge_range: f64,
    /// The gap kept between boxes.
    pub padding: f64,
    pub random: &'a mut Mulberry32,
}

const ALPHA_MIN: f64 = 0.001;
/// d3's default: velocities keep 60% per tick.
const VELOCITY_RETAIN: f64 = 0.6;
const STRUCTURE_SHARE: f64 = 0.35;
const RAMP_SHARE: f64 = 0.25;
/// Label boxes start the label phase at this fraction of their size.
const RAMP_FROM: f64 = 0.5;
const COLLIDE_STRENGTH: f64 = 0.7;
/// Label boxes may cover at most this share of the nodes' bounding box after the structure
/// phase.
const ROOM_DENSITY: f64 = 0.4;
const MAX_OVERLAP_PASSES: usize = 150;

/// Runs the simulation in place. Returns the number of overlap-removal passes used.
pub(crate) fn simulate(spec: Spec<'_>) -> usize {
    let Spec {
        bodies,
        links,
        springs,
        charge,
        node_boxes,
        label_boxes,
        inv_mass,
        ticks,
        alpha: start,
        gravity,
        orient: orient_layout,
        spring_strength,
        spring_length,
        dock_distance,
        charge_range,
        padding,
        random,
    } = spec;
    let n = bodies.len();
    if n == 0 {
        return 0;
    }

    if ticks > 0 {
        let link = LinkForce::new(links, n);
        let mut many_body = ManyBody::new(charge, charge_range);
        let ticks_f = ticks as f64;
        let decay = cooling_factor(ALPHA_MIN / start, ticks as u64);
        let structure_end = to_count(round(ticks_f * STRUCTURE_SHARE));
        let ramp_ticks = max(1.0, round(ticks_f * RAMP_SHARE));
        let mut ramp = Boxes::zeroed(n);
        let mut scratch = Collider::new(n);
        let mut alpha = start;

        for tick in 0..ticks {
            alpha *= decay;
            link.apply(bodies, alpha, random);
            many_body.apply(bodies, alpha, random);
            if !springs.is_empty() {
                apply_springs(bodies, &springs, alpha, spring_strength, spring_length);
            }
            if gravity > 0.0 {
                apply_gravity(bodies, alpha, gravity);
            }

            let boxes = if tick >= structure_end {
                let t = min(1.0, (tick - structure_end + 1) as f64 / ramp_ticks);
                if t >= 1.0 {
                    label_boxes
                } else {
                    blend_boxes(
                        node_boxes,
                        label_boxes,
                        RAMP_FROM + (1.0 - RAMP_FROM) * t,
                        &mut ramp,
                    );
                    &ramp
                }
            } else {
                node_boxes
            };
            collide_velocities(
                bodies,
                boxes,
                inv_mass,
                padding,
                COLLIDE_STRENGTH,
                &mut scratch,
            );

            for k in 0..n {
                if bodies.fixed[k] {
                    bodies.x[k] = bodies.fx[k];
                    bodies.vx[k] = 0.0;
                    bodies.y[k] = bodies.fy[k];
                    bodies.vy[k] = 0.0;
                } else {
                    bodies.vx[k] *= VELOCITY_RETAIN;
                    bodies.x[k] += bodies.vx[k];
                    bodies.vy[k] *= VELOCITY_RETAIN;
                    bodies.y[k] += bodies.vy[k];
                }
            }

            if tick + 1 == structure_end {
                if orient_layout {
                    orient(bodies);
                }
                make_room(bodies, label_boxes, inv_mass, padding, ROOM_DENSITY);
            }
        }
    }

    let cleared = remove_overlaps(
        bodies,
        label_boxes,
        inv_mass,
        padding,
        MAX_OVERLAP_PASSES,
        None,
    );
    let mut passes = cleared.passes;
    if !springs.is_empty() && dock_distance > 0.0 {
        let pinned = dock_partners(
            bodies,
            &springs,
            label_boxes,
            inv_mass,
            padding,
            dock_distance,
        );
        if !pinned.is_empty() {
            // Make room around docked pairs: they hold still, their new neighbours step aside.
            // Only the docked nodes (and whatever was left over) need to be looked at.
            let mut held = inv_mass.to_vec();
            let mut active = cleared.unresolved;
            for &k in &pinned {
                held[k] = 0.0;
                active[k] = true;
            }
            let room = remove_overlaps(
                bodies,
                label_boxes,
                &held,
                padding,
                MAX_OVERLAP_PASSES,
                Some(active),
            );
            // What the pinned pass could not clear (a pinned pair in a tight spot) is cleared
            // with everyone movable again.
            let mut rest = room.unresolved;
            for &k in &pinned {
                rest[k] = true;
            }
            passes += room.passes;
            passes += remove_overlaps(
                bodies,
                label_boxes,
                inv_mass,
                padding,
                MAX_OVERLAP_PASSES,
                Some(rest),
            )
            .passes;
        }
    }
    passes
}

/// Boxes with the label part scaled by `s` (the node part kept), written into `out`.
fn blend_boxes(node: &Boxes, full: &Boxes, s: f64, out: &mut Boxes) {
    for i in 0..node.half_width.len() {
        let top = node.offset_y[i] - node.half_height[i];
        let bottom = node.offset_y[i] + node.half_height[i];
        let full_bottom = full.offset_y[i] + full.half_height[i];
        let b = bottom + (full_bottom - bottom) * s;
        out.half_width[i] = node.half_width[i] + (full.half_width[i] - node.half_width[i]) * s;
        out.half_height[i] = (b - top) / 2.0;
        out.offset_y[i] = (b + top) / 2.0;
    }
}

/// Rotates the (free) layout so that its principal axis is horizontal, then mirrors it so that
/// the heavier tail points right and down. Exact operations only: the eigenvector of the 2×2
/// covariance matrix gives the cosine and sine directly.
fn orient(bodies: &mut Bodies) {
    let n = bodies.len();
    let count = n as f64;
    let (mut cx, mut cy) = (0.0, 0.0);
    for k in 0..n {
        cx += bodies.x[k];
        cy += bodies.y[k];
    }
    cx /= count;
    cy /= count;
    let (mut sxx, mut syy, mut sxy) = (0.0, 0.0, 0.0);
    for k in 0..n {
        let dx = bodies.x[k] - cx;
        let dy = bodies.y[k] - cy;
        sxx += dx * dx;
        syy += dy * dy;
        sxy += dx * dy;
    }
    let half = (sxx - syy) / 2.0;
    let lambda = (sxx + syy) / 2.0 + (half * half + sxy * sxy).sqrt();
    let mut ux = sxy;
    let mut uy = lambda - sxx;
    if ux.abs() + uy.abs() < 1e-12 * (sxx + syy + 1.0) {
        ux = lambda - syy;
        uy = sxy;
    }
    let len = (ux * ux + uy * uy).sqrt();
    let c = if len > 0.0 { ux / len } else { 1.0 };
    let s = if len > 0.0 { uy / len } else { 0.0 };

    let (mut m3x, mut m3y) = (0.0, 0.0);
    for k in 0..n {
        let dx = bodies.x[k] - cx;
        let dy = bodies.y[k] - cy;
        let rx = c * dx + s * dy;
        let ry = -s * dx + c * dy;
        bodies.x[k] = rx;
        bodies.y[k] = ry;
        let vx = c * bodies.vx[k] + s * bodies.vy[k];
        bodies.vy[k] = -s * bodies.vx[k] + c * bodies.vy[k];
        bodies.vx[k] = vx;
        m3x += rx * rx * rx;
        m3y += ry * ry * ry;
    }
    let fx = if m3x < 0.0 { -1.0 } else { 1.0 };
    let fy = if m3y < 0.0 { -1.0 } else { 1.0 };
    if fx == 1.0 && fy == 1.0 {
        return;
    }
    for k in 0..n {
        bodies.x[k] *= fx;
        bodies.vx[k] *= fx;
        bodies.y[k] *= fy;
        bodies.vy[k] *= fy;
    }
}

/// Scales the (free) layout up about its centroid when its label boxes could not possibly fit:
/// when their total area exceeds `density` × the area of the nodes' bounding box. A dense graph
/// pulls itself together tighter than its labels allow, and pushing boxes apart one pair at a
/// time through such a jam takes many passes; a uniform scale keeps the picture and makes the
/// room in one step. Fixed nodes rule it out.
fn make_room(bodies: &mut Bodies, boxes: &Boxes, inv_mass: &[f64], padding: f64, density: f64) {
    let n = bodies.len();
    if n < 3 || inv_mass.contains(&0.0) {
        return;
    }
    let (mut min_x, mut min_y) = (f64::INFINITY, f64::INFINITY);
    let (mut max_x, mut max_y) = (f64::NEG_INFINITY, f64::NEG_INFINITY);
    let (mut area, mut cx, mut cy) = (0.0, 0.0, 0.0);
    for k in 0..n {
        let (x, y) = (bodies.x[k], bodies.y[k]);
        min_x = min(min_x, x);
        max_x = max(max_x, x);
        min_y = min(min_y, y);
        max_y = max(max_y, y);
        cx += x;
        cy += y;
        area += (2.0 * boxes.half_width[k] + padding) * (2.0 * boxes.half_height[k] + padding);
    }
    let span = max(1.0, max_x - min_x) * max(1.0, max_y - min_y);
    let ratio = area / (density * span);
    if ratio <= 1.0 {
        return;
    }
    let scale = ratio.sqrt();
    let count = n as f64;
    cx /= count;
    cy /= count;
    for k in 0..n {
        bodies.x[k] = cx + (bodies.x[k] - cx) * scale;
        bodies.y[k] = cy + (bodies.y[k] - cy) * scale;
    }
}
