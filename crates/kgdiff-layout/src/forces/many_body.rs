//! d3-force's `forceManyBody`: Barnes–Hut with θ = 0.9 (θ² = 0.81), `distanceMin² = 1`,
//! `distanceMax² = range²`, per-node strengths; the accumulation of strength-weighted centres
//! after the children (`visitAfter`), the application in pre-order (`visit`), coincident points
//! in leaf lists and `jiggle` for coincident coordinates.

use super::Bodies;
use crate::prng::{Mulberry32, jiggle};
use crate::quadtree::{NONE, Quadtree};

const THETA2: f64 = 0.81;
const DISTANCE_MIN2: f64 = 1.0;

/// Accumulated strength and its weighted centre, per cell.
#[derive(Clone, Copy, Debug, Default)]
struct Charge {
    value: f64,
    x: f64,
    y: f64,
}

pub(crate) struct ManyBody {
    strengths: Vec<f64>,
    distance_max2: f64,
    indices: Vec<usize>,
    tree: Quadtree,
    /// By cell.
    charges: Vec<Charge>,
    cells: Vec<u32>,
    order: Vec<u32>,
    /// A cell and its x extent: the application needs nothing else of the bounds.
    stack: Vec<(u32, f64, f64)>,
}

impl ManyBody {
    pub(crate) fn new(strengths: Vec<f64>, distance_max: f64) -> ManyBody {
        let n = strengths.len();
        ManyBody {
            strengths,
            distance_max2: distance_max * distance_max,
            indices: (0..n).collect(),
            tree: Quadtree::default(),
            charges: Vec::new(),
            cells: Vec::new(),
            order: Vec::new(),
            stack: Vec::new(),
        }
    }

    /// `force(alpha)`.
    pub(crate) fn apply(&mut self, bodies: &mut Bodies, alpha: f64, random: &mut Mulberry32) {
        self.tree.clear();
        self.tree.add_all(&self.indices, &bodies.x, &bodies.y);
        self.accumulate(bodies);
        let Some(root) = self.tree.root() else {
            return;
        };
        let ManyBody {
            strengths,
            distance_max2,
            tree,
            charges,
            stack,
            ..
        } = self;
        let distance_max2 = *distance_max2;
        for node in 0..bodies.len() {
            let (nx, ny) = (bodies.x[node], bodies.y[node]);
            let (mut vx, mut vy) = (bodies.vx[node], bodies.vy[node]);
            // `tree.visit(apply)`: pre-order, quadrants 0..3.
            stack.clear();
            stack.push((root, tree.x0, tree.x1));
            while let Some((cell, x0, x1)) = stack.pop() {
                let quad = charges[cell as usize];
                if quad.value == 0.0 || quad.value.is_nan() {
                    continue;
                }
                let mut x = quad.x - nx;
                let mut y = quad.y - ny;
                let w = x1 - x0;
                let mut l = x * x + y * y;
                // Far enough: the cell acts as one body (Barnes–Hut).
                if w * w / THETA2 < l {
                    if l < distance_max2 {
                        if x == 0.0 {
                            x = jiggle(random);
                            l += x * x;
                        }
                        if y == 0.0 {
                            y = jiggle(random);
                            l += y * y;
                        }
                        if l < DISTANCE_MIN2 {
                            l = (DISTANCE_MIN2 * l).sqrt();
                        }
                        vx += x * quad.value * alpha / l;
                        vy += y * quad.value * alpha / l;
                    }
                    continue;
                }
                if !tree.is_leaf(cell) {
                    let [c0, c1, c2, c3] = tree.children(cell);
                    let xm = (x0 + x1) / 2.0;
                    for (child, a, b) in [(c3, xm, x1), (c2, x0, xm), (c1, xm, x1), (c0, x0, xm)] {
                        if child != NONE {
                            stack.push((child, a, b));
                        }
                    }
                    continue;
                }
                if l >= distance_max2 {
                    continue;
                }
                // The points of a leaf, directly; limit forces for very close nodes, randomize
                // the direction for coincident ones.
                if tree.datum(cell) != node || tree.next(cell).is_some() {
                    if x == 0.0 {
                        x = jiggle(random);
                        l += x * x;
                    }
                    if y == 0.0 {
                        y = jiggle(random);
                        l += y * y;
                    }
                    if l < DISTANCE_MIN2 {
                        l = (DISTANCE_MIN2 * l).sqrt();
                    }
                }
                let mut leaf = Some(cell);
                while let Some(current) = leaf {
                    let datum = tree.datum(current);
                    if datum != node {
                        let w = strengths[datum] * alpha / l;
                        vx += x * w;
                        vy += y * w;
                    }
                    leaf = tree.next(current);
                }
            }
            bodies.vx[node] = vx;
            bodies.vy[node] = vy;
        }
    }

    /// `visitAfter(accumulate)`: every cell's total strength and strength-weighted centre.
    fn accumulate(&mut self, bodies: &Bodies) {
        self.charges.clear();
        self.charges.resize(self.tree.len(), Charge::default());
        self.tree.post_order(&mut self.cells, &mut self.order);
        for &cell in &self.order {
            let charge = if self.tree.is_leaf(cell) {
                let datum = self.tree.datum(cell);
                let mut strength = 0.0;
                let mut leaf = Some(cell);
                while let Some(current) = leaf {
                    strength += self.strengths[self.tree.datum(current)];
                    leaf = self.tree.next(current);
                }
                Charge {
                    value: strength,
                    x: bodies.x[datum],
                    y: bodies.y[datum],
                }
            } else {
                let (mut strength, mut weight, mut x, mut y) = (0.0, 0.0, 0.0, 0.0);
                for child in self.tree.children(cell) {
                    if child == NONE {
                        continue;
                    }
                    let q = self.charges[child as usize];
                    let c = q.value.abs();
                    if c != 0.0 && !c.is_nan() {
                        strength += q.value;
                        weight += c;
                        x += c * q.x;
                        y += c * q.y;
                    }
                }
                Charge {
                    value: strength,
                    x: x / weight,
                    y: y / weight,
                }
            };
            self.charges[cell as usize] = charge;
        }
    }
}
