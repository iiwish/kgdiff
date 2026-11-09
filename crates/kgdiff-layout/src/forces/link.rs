//! d3-force's `forceLink`: per-link distance and strength, the degree-based bias
//! `count[s] / (count[s] + count[t])` (counts within the link list), one iteration per tick, and
//! `jiggle` for links of length zero.

use super::Bodies;
use crate::prng::{Mulberry32, jiggle};

/// A link between two simulation indices.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct SimLink {
    pub source: usize,
    pub target: usize,
    pub distance: f64,
    pub strength: f64,
}

pub(crate) struct LinkForce {
    links: Vec<SimLink>,
    bias: Vec<f64>,
}

impl LinkForce {
    /// `forceLink(links).initialize(nodes)` over `n` bodies.
    pub(crate) fn new(links: Vec<SimLink>, n: usize) -> LinkForce {
        let mut count = vec![0usize; n];
        for link in &links {
            count[link.source] += 1;
            count[link.target] += 1;
        }
        let bias = links
            .iter()
            .map(|l| {
                let (s, t) = (count[l.source] as f64, count[l.target] as f64);
                s / (s + t)
            })
            .collect();
        LinkForce { links, bias }
    }

    /// `force(alpha)`.
    pub(crate) fn apply(&self, bodies: &mut Bodies, alpha: f64, random: &mut Mulberry32) {
        for (link, &b) in self.links.iter().zip(&self.bias) {
            let (s, t) = (link.source, link.target);
            // `x || jiggle()`: a zero (or NaN) difference gets a tiny random one.
            let mut x = bodies.x[t] + bodies.vx[t] - bodies.x[s] - bodies.vx[s];
            if x == 0.0 || x.is_nan() {
                x = jiggle(random);
            }
            let mut y = bodies.y[t] + bodies.vy[t] - bodies.y[s] - bodies.vy[s];
            if y == 0.0 || y.is_nan() {
                y = jiggle(random);
            }
            let mut l = (x * x + y * y).sqrt();
            l = (l - link.distance) / l * alpha * link.strength;
            x *= l;
            y *= l;
            bodies.vx[t] -= x * b;
            bodies.vy[t] -= y * b;
            let b = 1.0 - b;
            bodies.vx[s] += x * b;
            bodies.vy[s] += y * b;
        }
    }
}
