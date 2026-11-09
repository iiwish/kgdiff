//! Small forces beside d3's (`forces/springs.ts`).

use super::Bodies;

/// A merge / split pair within one simulation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Spring {
    /// The simulation index of the node that is pulled (merge source / split target).
    pub mover: usize,
    /// Its partner (merge target / split source).
    pub anchor: usize,
}

/// Weak one-sided springs (strength 0.08) that keep merge sources near their target and split
/// targets near their source, so that replay travel stays short. They only pull (collision keeps
/// the pair apart), and the anchor feels a small share of the reaction, so that its ghosts do not
/// drag it around.
pub(crate) fn apply_springs(
    bodies: &mut Bodies,
    springs: &[Spring],
    alpha: f64,
    strength: f64,
    rest_length: f64,
) {
    let anchor_share = 0.2;
    for &Spring {
        mover: m,
        anchor: a,
    } in springs
    {
        let dx = bodies.x[a] + bodies.vx[a] - bodies.x[m] - bodies.vx[m];
        let dy = bodies.y[a] + bodies.vy[a] - bodies.y[m] - bodies.vy[m];
        let l = (dx * dx + dy * dy).sqrt();
        if l <= rest_length {
            continue;
        }
        let k = ((l - rest_length) / l) * alpha * strength;
        bodies.vx[m] += dx * k * (1.0 - anchor_share);
        bodies.vy[m] += dy * k * (1.0 - anchor_share);
        bodies.vx[a] -= dx * k * anchor_share;
        bodies.vy[a] -= dy * k * anchor_share;
    }
}

/// A linear pull towards the origin (d3's `forceX` / `forceY` at 0).
pub(crate) fn apply_gravity(bodies: &mut Bodies, alpha: f64, strength: f64) {
    let k = strength * alpha;
    for i in 0..bodies.len() {
        bodies.vx[i] -= bodies.x[i] * k;
        bodies.vy[i] -= bodies.y[i] * k;
    }
}
