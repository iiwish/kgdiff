//! The forces of the simulation: d3-force's link and many-body forces (ported, RFC 0002 §5
//! "d3-force port scope"), and kgdiff's own: the rectangle collision, the merge / split springs,
//! gravity and the free-spot placements.

pub(crate) mod collide;
pub(crate) mod free_spot;
pub(crate) mod link;
pub(crate) mod many_body;
pub(crate) mod params;
pub(crate) mod springs;

/// The bodies of one simulation, by simulation index: positions, velocities and the fixed
/// positions of fixed nodes (d3's `fx` / `fy`, which kgdiff always sets together).
#[derive(Clone, Debug, Default)]
pub(crate) struct Bodies {
    pub x: Vec<f64>,
    pub y: Vec<f64>,
    pub vx: Vec<f64>,
    pub vy: Vec<f64>,
    pub fixed: Vec<bool>,
    pub fx: Vec<f64>,
    pub fy: Vec<f64>,
}

impl Bodies {
    pub(crate) fn len(&self) -> usize {
        self.x.len()
    }

    pub(crate) fn push(&mut self, x: f64, y: f64, fixed: bool) {
        self.x.push(x);
        self.y.push(y);
        self.vx.push(0.0);
        self.vy.push(0.0);
        self.fixed.push(fixed);
        self.fx.push(x);
        self.fy.push(y);
    }
}
