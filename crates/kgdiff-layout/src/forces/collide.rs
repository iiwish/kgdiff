//! Rectangle-against-rectangle collision over node and label boxes (`collide-rect.ts`),
//! accelerated with a quadtree.
//!
//! Every node owns one axis-aligned box (its circle and the label block centered below it).
//! Overlapping pairs are separated along the axis of least penetration, shared in proportion to
//! inverse mass, so that hubs and fixed nodes stay put: wide label boxes slide sideways past each
//! other while stacked nodes separate vertically. Box centers go into a quadtree whose cells
//! record the largest half extents below them, so that a query for box i only descends into
//! cells whose content could reach it; the traversal uses an explicit, reused stack.
//!
//! - [`collide_velocities`]: a force on predicted positions (x + vx) during the simulation;
//! - [`remove_overlaps`]: position-level passes after it, until no pair overlaps.

use super::Bodies;
use crate::math::{max, min};
use crate::quadtree::{NONE, Quadtree};

/// The box of every node, by simulation index.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct Boxes {
    pub half_width: Vec<f64>,
    pub half_height: Vec<f64>,
    /// Box center minus node center (labels sit below, so usually positive).
    pub offset_y: Vec<f64>,
}

impl Boxes {
    pub(crate) fn zeroed(n: usize) -> Boxes {
        Boxes {
            half_width: vec![0.0; n],
            half_height: vec![0.0; n],
            offset_y: vec![0.0; n],
        }
    }
}

/// A quadtree over box centers with the largest half extents below each cell.
#[derive(Default)]
struct BoxIndex {
    tree: Quadtree,
    /// Max half width and height of the boxes below each cell, by cell.
    extents: Vec<(f64, f64)>,
    cells: Vec<u32>,
    order: Vec<u32>,
}

impl BoxIndex {
    /// Builds the tree over (cx, cy) and records max half extents on every cell (post-order).
    /// False when there is nothing to index.
    fn build(&mut self, indices: &[usize], cx: &[f64], cy: &[f64], boxes: &Boxes) -> bool {
        self.tree.clear();
        self.tree.add_all(indices, cx, cy);
        if self.tree.root().is_none() {
            return false;
        }
        self.extents.clear();
        self.extents.resize(self.tree.len(), (0.0, 0.0));
        self.tree.post_order(&mut self.cells, &mut self.order);
        for &cell in &self.order {
            let (mut mw, mut mh) = (0.0, 0.0);
            if self.tree.is_leaf(cell) {
                let mut leaf = Some(cell);
                while let Some(current) = leaf {
                    let d = self.tree.datum(current);
                    mw = max(mw, boxes.half_width[d]);
                    mh = max(mh, boxes.half_height[d]);
                    leaf = self.tree.next(current);
                }
            } else {
                for child in self.tree.children(cell) {
                    if child != NONE {
                        let (cw, ch) = self.extents[child as usize];
                        mw = max(mw, cw);
                        mh = max(mh, ch);
                    }
                }
            }
            self.extents[cell as usize] = (mw, mh);
        }
        true
    }
}

/// Reusable buffers for one set of bodies.
pub(crate) struct Collider {
    indices: Vec<usize>,
    cx: Vec<f64>,
    cy: Vec<f64>,
    index: BoxIndex,
    stack: Vec<(u32, [f64; 4])>,
}

impl Collider {
    pub(crate) fn new(n: usize) -> Collider {
        Collider {
            indices: (0..n).collect(),
            cx: vec![0.0; n],
            cy: vec![0.0; n],
            index: BoxIndex::default(),
            stack: Vec::new(),
        }
    }
}

/// Visits every pair (i, j) whose padded boxes overlap, each pair once, with the overlaps
/// (ox, oy) and the center differences (dx, dy). Box centers are the current `cx`, `cy`; the
/// index may have been built from older centers, in which case `slack` must bound how far any
/// center has moved since (it widens the pruning test, so the search stays exact). With
/// `active`, only pairs with at least one active node are visited.
#[allow(
    clippy::too_many_arguments,
    reason = "the parts of one query, kept apart for borrows"
)]
fn for_each_overlap(
    index: &BoxIndex,
    stack: &mut Vec<(u32, [f64; 4])>,
    cx: &[f64],
    cy: &[f64],
    boxes: &Boxes,
    padding: f64,
    slack: f64,
    active: Option<&[bool]>,
    mut visit: impl FnMut(usize, usize, f64, f64, f64, f64),
) {
    let (hw, hh) = (&boxes.half_width, &boxes.half_height);
    let tree = &index.tree;
    let Some(root) = tree.root() else { return };
    for i in 0..cx.len() {
        if active.is_some_and(|a| !a[i]) {
            continue;
        }
        let (xi, yi) = (cx[i], cy[i]);
        let hwi = hw[i] + padding;
        let hhi = hh[i] + padding;
        stack.clear();
        stack.push((root, [tree.x0, tree.y0, tree.x1, tree.y1]));
        while let Some((cell, [x0, y0, x1, y1])) = stack.pop() {
            if tree.is_leaf(cell) {
                let mut leaf = Some(cell);
                while let Some(current) = leaf {
                    let j = tree.datum(current);
                    leaf = tree.next(current);
                    // Each pair once: from its lower index, or from its only active member.
                    if j == i || (j < i && active.is_none_or(|a| a[j])) {
                        continue;
                    }
                    let dx = cx[j] - xi;
                    let ox = hwi + hw[j] - dx.abs();
                    if ox <= 0.0 {
                        continue;
                    }
                    let dy = cy[j] - yi;
                    let oy = hhi + hh[j] - dy.abs();
                    if oy <= 0.0 {
                        continue;
                    }
                    visit(i, j, ox, oy, dx, dy);
                }
                continue;
            }
            let (mw, mh) = index.extents[cell as usize];
            let rx = hwi + mw + slack;
            let ry = hhi + mh + slack;
            if x0 > xi + rx || x1 < xi - rx || y0 > yi + ry || y1 < yi - ry {
                continue;
            }
            let xm = (x0 + x1) / 2.0;
            let ym = (y0 + y1) / 2.0;
            let [c0, c1, c2, c3] = tree.children(cell);
            if c0 != NONE {
                stack.push((c0, [x0, y0, xm, ym]));
            }
            if c1 != NONE {
                stack.push((c1, [xm, y0, x1, ym]));
            }
            if c2 != NONE {
                stack.push((c2, [x0, ym, xm, y1]));
            }
            if c3 != NONE {
                stack.push((c3, [xm, ym, x1, y1]));
            }
        }
    }
}

/// Collision as a simulation force: overlapping boxes (at predicted positions x + vx) get
/// their velocities pushed apart by `strength` × the penetration along the separating axis.
pub(crate) fn collide_velocities(
    bodies: &mut Bodies,
    boxes: &Boxes,
    inv_mass: &[f64],
    padding: f64,
    strength: f64,
    scratch: &mut Collider,
) {
    let n = bodies.len();
    for k in 0..n {
        scratch.cx[k] = bodies.x[k] + bodies.vx[k];
        scratch.cy[k] = bodies.y[k] + bodies.vy[k] + boxes.offset_y[k];
    }
    let Collider {
        indices,
        cx,
        cy,
        index,
        stack,
    } = scratch;
    if !index.build(indices, cx, cy, boxes) {
        return;
    }
    for_each_overlap(
        index,
        stack,
        cx,
        cy,
        boxes,
        padding,
        0.0,
        None,
        |i, j, ox, oy, dx, dy| {
            let total = inv_mass[i] + inv_mass[j];
            if total == 0.0 {
                return;
            }
            let share_i = inv_mass[i] / total;
            let share_j = inv_mass[j] / total;
            // Push along the axis of least penetration; coincident centers: i goes left / up.
            if ox < oy {
                let push = (if dx < 0.0 { -ox } else { ox }) * strength;
                bodies.vx[i] -= push * share_i;
                bodies.vx[j] += push * share_j;
            } else {
                let push = (if dy < 0.0 { -oy } else { oy }) * strength;
                bodies.vy[i] -= push * share_i;
                bodies.vy[j] += push * share_j;
            }
        },
    );
}

/// What [`remove_overlaps`] left.
pub(crate) struct OverlapResult {
    pub passes: usize,
    /// True for nodes that took part in an overlap in the last pass.
    pub unresolved: Vec<bool>,
}

/// Jacobi passes between two checks for a stalled jam.
const STALL_WINDOW: usize = 8;
/// Passes between two expansions while the jam is heavy.
const HEAVY_WINDOW: usize = 3;
/// The quadtree is rebuilt once some node has drifted this far since the last build.
const REBUILD_DRIFT: f64 = 8.0;

/// Separates overlapping boxes by moving positions, pass after pass, until none overlap or
/// `max_passes` is reached. Each pass is a Jacobi step: every node moves by its largest push in
/// each direction (not the sum, which would overshoot when several neighbours push the same
/// way). Only nodes that moved in the previous pass (or the `initially_active` ones) are
/// queried; the quadtree is rebuilt only when some node has drifted more than a few units since
/// the last build (the query is widened by that drift).
///
/// Local pushes clear scattered overlaps in a few passes but diffuse slowly through a jam (a
/// crowded region that needs more area). When nothing is fixed and the overlap count stalls,
/// the layout is scaled up about its centroid (3–15%, more for heavier jams; every 3 passes by
/// up to 25% while more pairs than half the nodes overlap). With fixed nodes, overlaps may
/// remain (a free node wedged between fixed ones is left to the caller).
pub(crate) fn remove_overlaps(
    bodies: &mut Bodies,
    boxes: &Boxes,
    inv_mass: &[f64],
    padding: f64,
    max_passes: usize,
    initially_active: Option<Vec<bool>>,
) -> OverlapResult {
    let n = bodies.len();
    let mut scratch = Collider::new(n);
    let (mut pos_x, mut neg_x) = (vec![0.0; n], vec![0.0; n]);
    let (mut pos_y, mut neg_y) = (vec![0.0; n], vec![0.0; n]);
    let expandable = inv_mass.iter().all(|&m| m > 0.0);
    let mut active = initially_active.unwrap_or_else(|| vec![true; n]);
    let mut moved = vec![false; n];
    let mut drift = vec![0.0; n];
    let mut slack = 0.0;
    let mut built = false;
    let mut last_check = f64::INFINITY;
    // A hair more than the overlap, so that rounding to 0.01 cannot leave boxes touching.
    let epsilon = 0.02;
    for pass in 0..max_passes {
        for k in 0..n {
            scratch.cx[k] = bodies.x[k];
            scratch.cy[k] = bodies.y[k] + boxes.offset_y[k];
        }
        if !built || slack > REBUILD_DRIFT {
            if !scratch
                .index
                .build(&scratch.indices, &scratch.cx, &scratch.cy, boxes)
            {
                return OverlapResult {
                    passes: pass,
                    unresolved: vec![false; n],
                };
            }
            built = true;
            drift.fill(0.0);
            slack = 0.0;
        }
        pos_x.fill(0.0);
        neg_x.fill(0.0);
        pos_y.fill(0.0);
        neg_y.fill(0.0);
        let mut overlaps = 0usize;
        for_each_overlap(
            &scratch.index,
            &mut scratch.stack,
            &scratch.cx,
            &scratch.cy,
            boxes,
            padding,
            slack,
            Some(&active),
            |i, j, ox, oy, dx, dy| {
                let total = inv_mass[i] + inv_mass[j];
                if total == 0.0 {
                    return;
                }
                overlaps += 1;
                let share_i = inv_mass[i] / total;
                let share_j = inv_mass[j] / total;
                let share = |k: usize| if k == i { share_i } else { share_j };
                if ox < oy {
                    let push = ox + epsilon;
                    // j right of i (or coincident and i < j): i moves left, j moves right.
                    let j_right = dx > 0.0 || (dx == 0.0 && i < j);
                    let (left, right) = if j_right { (i, j) } else { (j, i) };
                    neg_x[left] = min(neg_x[left], -push * share(left));
                    pos_x[right] = max(pos_x[right], push * share(right));
                } else {
                    let push = oy + epsilon;
                    let j_down = dy > 0.0 || (dy == 0.0 && i < j);
                    let (up, down) = if j_down { (i, j) } else { (j, i) };
                    neg_y[up] = min(neg_y[up], -push * share(up));
                    pos_y[down] = max(pos_y[down], push * share(down));
                }
            },
        );
        if overlaps == 0 {
            return OverlapResult {
                passes: pass,
                unresolved: vec![false; n],
            };
        }
        moved.fill(false);
        for k in 0..n {
            // Pushes from opposite sides may cancel: the node is still involved, so it stays
            // active.
            if pos_x[k] != 0.0 || neg_x[k] != 0.0 || pos_y[k] != 0.0 || neg_y[k] != 0.0 {
                let mx = pos_x[k] + neg_x[k];
                let my = pos_y[k] + neg_y[k];
                bodies.x[k] += mx;
                bodies.y[k] += my;
                moved[k] = true;
                let d = drift[k] + max(mx.abs(), my.abs());
                drift[k] = d;
                if d > slack {
                    slack = d;
                }
            }
        }
        std::mem::swap(&mut active, &mut moved);
        let overlaps = overlaps as f64;
        let nodes = n as f64;
        if expandable && overlaps > nodes / 2.0 && (pass + 1) % HEAVY_WINDOW == 0 {
            // A heavy jam (more overlapping pairs than half the nodes): do not wait for a stall.
            expand(bodies, 1.0 + min(0.25, (0.05 * overlaps) / nodes));
            active.fill(true);
            built = false;
            last_check = f64::INFINITY;
        } else if (pass + 1) % STALL_WINDOW == 0 {
            // A jam: local moves stopped making progress.
            if expandable && overlaps > 0.7 * last_check {
                expand(
                    bodies,
                    1.0 + min(0.15, max(0.03, (0.05 * overlaps) / nodes)),
                );
                active.fill(true);
                built = false;
            }
            last_check = overlaps;
        }
    }
    OverlapResult {
        passes: max_passes,
        unresolved: active,
    }
}

/// Scales the positions about their centroid.
fn expand(bodies: &mut Bodies, factor: f64) {
    let n = bodies.len() as f64;
    let (mut mx, mut my) = (0.0, 0.0);
    for k in 0..bodies.len() {
        mx += bodies.x[k];
        my += bodies.y[k];
    }
    mx /= n;
    my /= n;
    for k in 0..bodies.len() {
        bodies.x[k] = mx + (bodies.x[k] - mx) * factor;
        bodies.y[k] = my + (bodies.y[k] - my) * factor;
    }
}
