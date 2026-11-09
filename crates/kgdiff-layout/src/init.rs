//! Deterministic initial placement (`init.ts`).
//!
//! Fresh components start on a phyllotaxis (sunflower) spiral filled in BFS order from the
//! highest-degree node, so that graph distance ≈ radial distance and the simulation never starts
//! from a hairball. Each BFS layer occupies a contiguous run of spiral slots; within that annulus
//! the nodes are assigned to slots by angle, aligned with the angle of their BFS parent, so that
//! subtrees start in the sector of their parent and parent–child links start short and uncrossed.
//!
//! Nodes added around fixed ones start at the barycenter of their placed neighbours (or next to
//! their merge / split partner), and a lone new leaf sprouts on the open side of its neighbour.

use crate::graph::LayoutGraph;
use crate::math::{cmp_f64, pseudo_angle, pseudo_angle_distance};
use crate::prng::{Mulberry32, node_random, random_direction};

/// The golden angle π(3 − √5) as exact literals: the spiral is built by rotation, without
/// trigonometry.
const COS_GOLDEN: f64 = -0.737_368_878_078_319_7;
const SIN_GOLDEN: f64 = 0.675_490_294_261_523_8;
/// Offsets tried when aligning a BFS layer with its parents (more are sampled with a stride).
const MAX_ALIGN_OFFSETS: usize = 48;

/// The merge / split partners of every node, both directions, ascending.
pub(crate) fn partner_lists(graph: &LayoutGraph<'_>) -> Vec<Vec<usize>> {
    let mut lists = vec![Vec::new(); graph.n];
    for p in &graph.partners {
        lists[p.mover].push(p.anchor);
        lists[p.anchor].push(p.mover);
    }
    for list in &mut lists {
        list.sort();
    }
    lists
}

/// The neighbours of `u`: its links, then its partners.
fn neighbours<'g>(
    graph: &'g LayoutGraph<'_>,
    partners: &'g [Vec<usize>],
    u: usize,
) -> impl Iterator<Item = usize> + 'g {
    graph
        .neighbours(u)
        .iter()
        .chain(partners[u].iter())
        .copied()
}

/// Places one component (ascending indices) on a seeded, BFS-ordered phyllotaxis spiral around
/// the origin. `visited` is shared across components (they are disjoint).
#[allow(clippy::too_many_arguments, reason = "mirrors init.ts")]
pub(crate) fn place_on_spiral(
    graph: &LayoutGraph<'_>,
    partners: &[Vec<usize>],
    members: &[usize],
    spacing: f64,
    random: &mut Mulberry32,
    visited: &mut [bool],
    x: &mut [f64],
    y: &mut [f64],
) {
    let Some(&first) = members.first() else {
        return;
    };
    let mut root = first;
    for &m in members {
        if graph.degree[m] > graph.degree[root] {
            root = m;
        }
    }

    // The whole spiral is rotated by a seeded angle and each slot jittered a little, so that
    // different seeds give different (equally good) layouts.
    let (mut c, mut s) = random_direction(random);
    let jitter = spacing * 0.3;
    let mut slot = 1usize;

    visited[root] = true;
    x[root] = 0.0;
    y[root] = 0.0;
    let mut layer = vec![root];

    struct Slot {
        x: f64,
        y: f64,
        angle: f64,
    }
    while !layer.is_empty() {
        let mut next = Vec::new();
        let mut parent_angle = Vec::new();
        for &u in &layer {
            let mut children = Vec::new();
            for v in neighbours(graph, partners, u) {
                if !visited[v] {
                    visited[v] = true;
                    children.push(v);
                }
            }
            children.sort_by(|&a, &b| graph.degree[b].cmp(&graph.degree[a]).then(a.cmp(&b)));
            let angle = pseudo_angle(x[u], y[u]);
            for v in children {
                next.push(v);
                parent_angle.push(angle);
            }
        }
        if next.is_empty() {
            break;
        }

        let mut slots = Vec::with_capacity(next.len());
        for _ in 0..next.len() {
            let r = spacing * (slot as f64).sqrt();
            slots.push(Slot {
                x: r * c,
                y: r * s,
                angle: pseudo_angle(c, s),
            });
            let cr = c * COS_GOLDEN - s * SIN_GOLDEN;
            s = c * SIN_GOLDEN + s * COS_GOLDEN;
            c = cr;
            slot += 1;
        }
        slots.sort_by(|a, b| cmp_f64(a.angle, b.angle));

        let count = next.len();
        let stride = count.div_ceil(MAX_ALIGN_OFFSETS).max(1);
        let mut best_offset = 0;
        let mut best_cost = f64::INFINITY;
        for o in (0..count).step_by(stride) {
            let mut cost = 0.0;
            for i in 0..count {
                cost += pseudo_angle_distance(parent_angle[i], slots[(i + o) % count].angle);
            }
            if cost < best_cost {
                best_cost = cost;
                best_offset = o;
            }
        }
        for (i, &v) in next.iter().enumerate() {
            let target = &slots[(i + best_offset) % count];
            x[v] = target.x + (random.next_f64() - 0.5) * jitter;
            y[v] = target.y + (random.next_f64() - 0.5) * jitter;
        }

        let mut ordered: Vec<(usize, f64)> = next
            .iter()
            .map(|&v| (v, pseudo_angle(x[v], y[v])))
            .collect();
        ordered.sort_by(|a, b| cmp_f64(a.1, b.1).then(a.0.cmp(&b.0)));
        layer = ordered.into_iter().map(|(v, _)| v).collect();
    }
}

/// Gives every unplaced node of `members` that is connected to a placed one a start position,
/// layer by layer outwards from the placed set. Within a layer, positions depend only on earlier
/// layers and on the node's own id, never on processing order.
#[allow(clippy::too_many_arguments, reason = "mirrors init.ts")]
pub(crate) fn place_around_fixed(
    graph: &LayoutGraph<'_>,
    partners: &[Vec<usize>],
    members: &[usize],
    placed: &mut [bool],
    x: &mut [f64],
    y: &mut [f64],
    link_distance: f64,
    seed: u32,
) {
    let mut layer: Vec<usize> = members
        .iter()
        .copied()
        .filter(|&u| !placed[u] && neighbours(graph, partners, u).any(|v| placed[v]))
        .collect();
    let mut queued = vec![false; graph.n];
    while !layer.is_empty() {
        let starts: Vec<(f64, f64)> = layer
            .iter()
            .map(|&u| start_near(graph, partners, u, placed, x, y, link_distance, seed))
            .collect();
        for (&u, &(sx, sy)) in layer.iter().zip(&starts) {
            x[u] = sx;
            y[u] = sy;
            placed[u] = true;
        }
        let mut next = Vec::new();
        for &u in &layer {
            for v in neighbours(graph, partners, u) {
                if !placed[v] && !queued[v] {
                    queued[v] = true;
                    next.push(v);
                }
            }
        }
        next.sort();
        for &v in &next {
            queued[v] = false;
        }
        layer = next;
    }
}

#[allow(clippy::too_many_arguments, reason = "mirrors init.ts")]
fn start_near(
    graph: &LayoutGraph<'_>,
    partners: &[Vec<usize>],
    u: usize,
    placed: &[bool],
    x: &[f64],
    y: &[f64],
    link_distance: f64,
    seed: u32,
) -> (f64, f64) {
    let mut random = node_random(seed, &graph.nodes[u].id);
    let centroid = |list: &[usize]| {
        let (mut sx, mut sy) = (0.0, 0.0);
        for &v in list {
            sx += x[v];
            sy += y[v];
        }
        let count = list.len() as f64;
        (sx / count, sy / count)
    };

    let placed_partners: Vec<usize> = partners[u].iter().copied().filter(|&v| placed[v]).collect();
    if !placed_partners.is_empty() {
        let (bx, by) = centroid(&placed_partners);
        let (dx, dy) = random_direction(&mut random);
        return (bx + dx * link_distance * 0.5, by + dy * link_distance * 0.5);
    }

    let placed_neighbours: Vec<usize> = graph
        .neighbours(u)
        .iter()
        .copied()
        .filter(|&v| placed[v])
        .collect();
    if placed_neighbours.len() >= 2 {
        let (bx, by) = centroid(&placed_neighbours);
        let (dx, dy) = random_direction(&mut random);
        return (
            bx + dx * link_distance * 0.25,
            by + dy * link_distance * 0.25,
        );
    }

    // A single placed neighbour p: sprout on p's open side (away from p's other placed
    // neighbours), turned by up to ±55° so that siblings fan out.
    let p = placed_neighbours[0];
    let others: Vec<usize> = graph
        .neighbours(p)
        .iter()
        .copied()
        .filter(|&v| v != u && placed[v])
        .collect();
    let (mut ax, mut ay) = (0.0, 0.0);
    if !others.is_empty() {
        let (ox, oy) = centroid(&others);
        ax = x[p] - ox;
        ay = y[p] - oy;
    }
    let len = (ax * ax + ay * ay).sqrt();
    if len < 1e-9 {
        (ax, ay) = random_direction(&mut random);
    } else {
        ax /= len;
        ay /= len;
    }
    let sin = (random.next_f64() * 2.0 - 1.0) * 0.82;
    let cos = (1.0 - sin * sin).sqrt();
    let dx = ax * cos - ay * sin;
    let dy = ax * sin + ay * cos;
    (x[p] + dx * link_distance, y[p] + dy * link_distance)
}
