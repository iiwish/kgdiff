//! Placement strategies over a layout graph (`engine.ts`).
//!
//! - [`place_free`]: every component laid out on its own, packed, centered at the origin.
//! - [`place_anchored`]: known nodes never move; unknown nodes connected to them start next to
//!   their placed neighbours and are refined by a simulation in which the known nodes are fixed;
//!   components without any known node are laid out freely and packed beside the anchored
//!   region.

use crate::components::connected_components;
use crate::forces::Bodies;
use crate::forces::collide::{Boxes, remove_overlaps};
use crate::forces::free_spot::settle_overlapping;
use crate::forces::link::SimLink;
use crate::forces::params::{
    CHARGE_RANGE, anchored_charge_range, charge_strength, gravity_for, link_distance, link_strength,
};
use crate::forces::springs::Spring;
use crate::geometry::{BOX_PADDING, Extent, extent_of};
use crate::graph::LayoutGraph;
use crate::init::{partner_lists, place_around_fixed, place_on_spiral};
use crate::math::max;
use crate::options::{Resolved, default_iterations};
use crate::pack::{GridItem, PackInput, Size, pack};
use crate::prng::Mulberry32;
use crate::quadtree::Quadtree;
use crate::simulate::{Spec, simulate};

/// Merge / split partner springs: rest length 0.5·L.
const SPRING_STRENGTH: f64 = 0.08;
const SPRING_LENGTH_RATIO: f64 = 0.5;
/// Spiral spacing relative to the link distance: starts a little denser than the final layout.
const SPIRAL_SPACING_RATIO: f64 = 0.4;
const TARGET_ASPECT: f64 = 1.6;
/// Pushing passes before wedged nodes are moved to free spots instead.
const SETTLE_PASSES: usize = 24;

pub(crate) struct Context<'g, 'a, 'o> {
    pub graph: &'g LayoutGraph<'a>,
    pub options: &'g Resolved<'o>,
    /// Positions by layout index, filled in place.
    pub x: Vec<f64>,
    pub y: Vec<f64>,
}

struct Workspace {
    partners: Vec<Vec<usize>>,
    /// Layout index → simulation index, `usize::MAX` outside the current simulation.
    slot: Vec<usize>,
    random: Mulberry32,
}

const OUTSIDE: usize = usize::MAX;

impl Context<'_, '_, '_> {
    fn workspace(&self) -> Workspace {
        Workspace {
            partners: partner_lists(self.graph),
            slot: vec![OUTSIDE; self.graph.n],
            random: Mulberry32::new(self.options.seed),
        }
    }

    /// Ticks for a simulation over `size` nodes: the option, else the default for the size.
    fn ticks_for(&self, size: usize) -> usize {
        self.options
            .iterations
            .unwrap_or_else(|| default_iterations(size))
    }

    fn translate(&mut self, nodes: &[usize], dx: f64, dy: f64) {
        for &i in nodes {
            self.x[i] += dx;
            self.y[i] += dy;
        }
    }
}

/// Lays everything out freely. Returns the ticks of the largest simulation run (0 when none
/// ran, e.g. only isolated nodes).
pub(crate) fn place_free(ctx: &mut Context<'_, '_, '_>) -> usize {
    let mut ws = ctx.workspace();
    let components = connected_components(ctx.graph, None);
    let block = layout_block(ctx, &mut ws, &components);
    let all: Vec<usize> = components.concat();
    let e = extent_of(ctx.graph, all.iter().copied(), &ctx.x, &ctx.y);
    if !e.is_empty() {
        ctx.translate(&all, -(e.min_x + e.max_x) / 2.0, -(e.min_y + e.max_y) / 2.0);
    }
    block.ticks
}

/// Lays out around the `fixed` nodes, whose positions must already be in `ctx.x` / `ctx.y`.
/// Returns the ticks of the largest simulation run (0 when none ran).
pub(crate) fn place_anchored(ctx: &mut Context<'_, '_, '_>, fixed: &[bool]) -> usize {
    let graph = ctx.graph;
    let mut ws = ctx.workspace();
    let components = connected_components(graph, None);
    let (anchored, free_components): (Vec<Vec<usize>>, Vec<Vec<usize>>) = components
        .into_iter()
        .partition(|c| c.iter().any(|&i| fixed[i]));

    let mut members: Vec<usize> = anchored.concat();
    members.sort();
    let mut placed = fixed.to_vec();
    place_around_fixed(
        graph,
        &ws.partners,
        &members,
        &mut placed,
        &mut ctx.x,
        &mut ctx.y,
        ctx.options.link_distance,
        ctx.options.seed,
    );

    let free: Vec<usize> = members.iter().copied().filter(|&i| !fixed[i]).collect();
    let mut ticks = 0;
    let mut largest = 0;
    if !free.is_empty() {
        // Refine with an energy (and a charge range) matching how much of the picture is new.
        let share = free.len() as f64 / members.len() as f64;
        let window = simulation_window(ctx, &members, &free, fixed);
        ticks = ctx.ticks_for(window.len());
        largest = window.len();
        run_simulation(
            ctx,
            &mut ws,
            &window,
            Some(fixed),
            ticks,
            0.3 + 0.7 * share,
            false,
            0.0,
            anchored_charge_range(share, ctx.options.link_distance),
        );
        settle(ctx, &members, fixed);
    }

    if !free_components.is_empty() {
        let block = layout_block(ctx, &mut ws, &free_components);
        if block.largest > largest {
            ticks = block.ticks;
        }
        let anchored_extent = extent_of(graph, members.iter().copied(), &ctx.x, &ctx.y);
        let nodes: Vec<usize> = free_components.concat();
        let gap = ctx.options.component_gap;
        let right = (anchored_extent.max_x + gap, anchored_extent.min_y);
        let below = (anchored_extent.min_x, anchored_extent.max_y + gap);
        let cost = |(dx, dy): (f64, f64)| {
            let w = max(anchored_extent.max_x, dx + block.width)
                - crate::math::min(anchored_extent.min_x, dx);
            let h = max(anchored_extent.max_y, dy + block.height)
                - crate::math::min(anchored_extent.min_y, dy);
            let side = max(w, h * TARGET_ASPECT);
            side * side
        };
        let at = if cost(below) < cost(right) - 1e-6 {
            below
        } else {
            right
        };
        // Nothing anchored (`extend_layout` of an empty layout): the block stays at the origin,
        // where TypeScript would move it by infinities.
        if !anchored_extent.is_empty() {
            ctx.translate(&nodes, at.0, at.1);
        }
    }
    ticks
}

/// The nodes worth simulating around `free` ones: all of them, their graph neighbours, and the
/// fixed nodes within reach of where any of them starts (a quadtree range query per free node).
/// Far-away fixed nodes cannot interact with the new ones in a refinement run, and skipping
/// them keeps `extend_layout` interactive on large graphs.
fn simulation_window(
    ctx: &Context<'_, '_, '_>,
    members: &[usize],
    free: &[usize],
    fixed: &[bool],
) -> Vec<usize> {
    let graph = ctx.graph;
    let (x, y) = (&ctx.x, &ctx.y);
    if free.len() * 2 >= members.len() {
        return members.to_vec();
    }
    let mut in_window = vec![false; graph.n];
    let mut reach = 4.0 * ctx.options.link_distance;
    for &i in free {
        reach = max(
            reach,
            max(2.0 * graph.box_half_width[i], 2.0 * graph.box_bottom[i]),
        );
        in_window[i] = true;
        for &v in graph.neighbours(i) {
            in_window[v] = true;
        }
    }
    let fixed_members: Vec<usize> = members.iter().copied().filter(|&i| fixed[i]).collect();
    let mut tree = Quadtree::default();
    tree.add_all(&fixed_members, x, y);
    let mut stack = Vec::new();
    for &i in free {
        let (x0, x1) = (x[i] - reach, x[i] + reach);
        let (y0, y1) = (y[i] - reach, y[i] + reach);
        tree.visit(&mut stack, |cell, cx0, cy0, cx1, cy1| {
            if tree.is_leaf(cell) {
                let mut leaf = Some(cell);
                while let Some(current) = leaf {
                    let j = tree.datum(current);
                    if x[j] >= x0 && x[j] <= x1 && y[j] >= y0 && y[j] <= y1 {
                        in_window[j] = true;
                    }
                    leaf = tree.next(current);
                }
            }
            cx0 > x1 || cx1 < x0 || cy0 > y1 || cy1 < y0
        });
    }
    members.iter().copied().filter(|&i| in_window[i]).collect()
}

struct Block {
    width: f64,
    height: f64,
    /// Ticks of the largest component simulated (0 when none was).
    ticks: usize,
    /// The size of that component.
    largest: usize,
}

/// Simulates each multi-node component around the origin, then packs all of them (and the
/// isolated nodes) into one block whose visual extent starts at (0, 0).
fn layout_block(
    ctx: &mut Context<'_, '_, '_>,
    ws: &mut Workspace,
    components: &[Vec<usize>],
) -> Block {
    let graph = ctx.graph;
    let options = ctx.options;
    let mut visited = vec![false; graph.n];
    let mut groups: Vec<&[usize]> = Vec::new();
    let mut isolated = Vec::new();
    let mut extents: Vec<Extent> = Vec::new();
    let mut ticks = 0;
    let mut largest = 0;

    for component in components {
        if component.len() == 1 {
            isolated.push(component[0]);
            continue;
        }
        place_on_spiral(
            graph,
            &ws.partners,
            component,
            options.link_distance * SPIRAL_SPACING_RATIO,
            &mut ws.random,
            &mut visited,
            &mut ctx.x,
            &mut ctx.y,
        );
        let component_ticks = ctx.ticks_for(component.len());
        // Components come largest first.
        if component.len() > largest {
            largest = component.len();
            ticks = component_ticks;
        }
        run_simulation(
            ctx,
            ws,
            component,
            None,
            component_ticks,
            1.0,
            true,
            gravity_for(component.len()),
            CHARGE_RANGE,
        );
        groups.push(component);
        extents.push(extent_of(graph, component.iter().copied(), &ctx.x, &ctx.y));
    }

    isolated.sort();
    let sizes: Vec<Size> = extents
        .iter()
        .map(|e| Size {
            width: e.max_x - e.min_x,
            height: e.max_y - e.min_y,
        })
        .collect();
    let items: Vec<GridItem> = isolated
        .iter()
        .map(|&i| GridItem {
            half_width: graph.box_half_width[i],
            top: graph.box_top[i],
            bottom: graph.box_bottom[i],
        })
        .collect();
    let packed = pack(&PackInput {
        components: &sizes,
        isolated: &items,
        component_gap: options.component_gap,
        grid_gap_x: options.font_size * 1.5,
        grid_gap_y: options.font_size,
        aspect: TARGET_ASPECT,
    });
    for (c, group) in groups.iter().enumerate() {
        let at = packed.components[c];
        let e = extents[c];
        ctx.translate(group, at.x - e.min_x, at.y - e.min_y);
    }
    for (k, &i) in isolated.iter().enumerate() {
        let at = packed.isolated[k];
        ctx.x[i] = at.x;
        ctx.y[i] = at.y;
    }
    Block {
        width: packed.width,
        height: packed.height,
        ticks,
        largest,
    }
}

/// The bodies (simulation index k ↔ `list[k]`), collision boxes, inverse masses and charges
/// of a list of layout indices.
struct Setup {
    bodies: Bodies,
    node_boxes: Boxes,
    /// `None` when the layout is not label-aware (label boxes are the node boxes then).
    label_boxes: Option<Boxes>,
    inv_mass: Vec<f64>,
    charge: Vec<f64>,
}

fn setup(ctx: &Context<'_, '_, '_>, list: &[usize], fixed: Option<&[bool]>) -> Setup {
    let graph = ctx.graph;
    let options = ctx.options;
    let m = list.len();
    let mut bodies = Bodies::default();
    let mut node_boxes = Boxes::zeroed(m);
    let mut label_boxes = options.label_aware.then(|| Boxes::zeroed(m));
    let mut inv_mass = vec![0.0; m];
    let mut charge = vec![0.0; m];
    for (k, &i) in list.iter().enumerate() {
        let r = graph.radius[i];
        let is_fixed = fixed.is_some_and(|f| f[i]);
        bodies.push(ctx.x[i], ctx.y[i], is_fixed);
        node_boxes.half_width[k] = r;
        node_boxes.half_height[k] = r;
        // Hubs are heavy: in a collision the leaf steps aside. Fixed nodes never move.
        inv_mass[k] = if is_fixed {
            0.0
        } else {
            1.0 / (1.0 + graph.degree[i] as f64)
        };
        if let Some(boxes) = &mut label_boxes {
            boxes.half_width[k] = graph.box_half_width[i];
            boxes.half_height[k] = (graph.box_bottom[i] - graph.box_top[i]) / 2.0;
            boxes.offset_y[k] = (graph.box_bottom[i] + graph.box_top[i]) / 2.0;
        }
        charge[k] = charge_strength(graph, i, options.link_distance, options.label_aware);
    }
    Setup {
        bodies,
        node_boxes,
        label_boxes,
        inv_mass,
        charge,
    }
}

fn write_back(ctx: &mut Context<'_, '_, '_>, list: &[usize], bodies: &Bodies) {
    for (k, &i) in list.iter().enumerate() {
        if !bodies.fixed[k] {
            ctx.x[i] = bodies.x[k];
            ctx.y[i] = bodies.y[k];
        }
    }
}

/// Simulates `list` (ascending layout indices) in place; fixed nodes keep their position.
#[allow(clippy::too_many_arguments, reason = "mirrors engine.ts")]
fn run_simulation(
    ctx: &mut Context<'_, '_, '_>,
    ws: &mut Workspace,
    list: &[usize],
    fixed: Option<&[bool]>,
    ticks: usize,
    alpha: f64,
    orient: bool,
    gravity: f64,
    charge_range: f64,
) {
    let graph = ctx.graph;
    let options = ctx.options;
    for (k, &i) in list.iter().enumerate() {
        ws.slot[i] = k;
    }
    let Setup {
        mut bodies,
        node_boxes,
        label_boxes,
        inv_mass,
        charge,
    } = setup(ctx, list, fixed);
    let is_fixed = |i: usize| fixed.is_some_and(|f| f[i]);

    let l = options.link_distance;
    let mut links = Vec::new();
    for (k, &i) in list.iter().enumerate() {
        for &v in graph.neighbours(i) {
            let kv = ws.slot[v];
            if v <= i || kv == OUTSIDE || (is_fixed(i) && is_fixed(v)) {
                continue;
            }
            let min_degree = graph.degree[i].min(graph.degree[v]).max(1) as f64;
            let distance = link_distance(l, min_degree);
            links.push(SimLink {
                source: k,
                target: kv,
                distance,
                strength: link_strength(graph, i, v, distance, options.label_aware),
            });
        }
    }
    let mut springs = Vec::new();
    for p in &graph.partners {
        let (km, ka) = (ws.slot[p.mover], ws.slot[p.anchor]);
        if km != OUTSIDE && ka != OUTSIDE {
            springs.push(Spring {
                mover: km,
                anchor: ka,
            });
        }
    }
    for &i in list {
        ws.slot[i] = OUTSIDE;
    }

    let label_boxes = label_boxes.as_ref().unwrap_or(&node_boxes);
    simulate(Spec {
        bodies: &mut bodies,
        links,
        springs,
        charge,
        node_boxes: &node_boxes,
        label_boxes,
        inv_mass: &inv_mass,
        ticks,
        alpha,
        gravity,
        orient,
        spring_strength: SPRING_STRENGTH,
        spring_length: l * SPRING_LENGTH_RATIO,
        dock_distance: l,
        charge_range,
        padding: BOX_PADDING,
        random: &mut ws.random,
    });
    write_back(ctx, list, &bodies);
}

/// The final overlap removal over the whole anchored region (`list`), fixed nodes being
/// immovable obstacles: pushes first (new nodes may have drifted next to fixed nodes outside
/// the simulation window), then free spots for the nodes that pushing cannot free.
fn settle(ctx: &mut Context<'_, '_, '_>, list: &[usize], fixed: &[bool]) {
    let graph = ctx.graph;
    let mut setup = setup(ctx, list, Some(fixed));
    let boxes = setup
        .label_boxes
        .take()
        .unwrap_or_else(|| setup.node_boxes.clone());
    remove_overlaps(
        &mut setup.bodies,
        &boxes,
        &setup.inv_mass,
        BOX_PADDING,
        SETTLE_PASSES,
        None,
    );
    let mut slot_of = vec![OUTSIDE; graph.n];
    for (k, &i) in list.iter().enumerate() {
        slot_of[i] = k;
    }
    let (x, y) = (&ctx.x, &ctx.y);
    settle_overlapping(
        &mut setup.bodies,
        &boxes,
        &setup.inv_mass,
        BOX_PADDING,
        |bodies, k| {
            let i = list[k];
            let (mut sx, mut sy, mut count) = (0.0, 0.0, 0usize);
            for &v in graph.neighbours(i) {
                let s = slot_of[v];
                if s == OUTSIDE {
                    continue;
                }
                sx += bodies.x[s];
                sy += bodies.y[s];
                count += 1;
            }
            if count > 0 {
                (sx / count as f64, sy / count as f64)
            } else {
                (x[i], y[i])
            }
        },
    );
    write_back(ctx, list, &setup.bodies);
}
