//! Seeded graph fixtures and layout quality metrics: a port of `packages/layout/test/support`
//! (`fixtures.ts`, `metrics.ts`). The TypeScript tests build `DiffResult`s by hand; these build
//! the two versions as kgdiff JSON and diff them with kgdiff-core, so that the layout sees what
//! it sees in use.

#![allow(
    dead_code,
    reason = "each test binary uses a part of the support module"
)]
#![allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "fixture indices from random doubles in [0, 1)"
)]

use kgdiff_core::js::math::{max, min};
use kgdiff_core::js::{IndexMap, JsStr, Object, Value};
use kgdiff_core::model::{NodeFacet, Point};
use kgdiff_core::{DiffOptions, DiffResult, MatchStrategy};
use kgdiff_layout::{LayoutResult, estimate_label_width};

/// mulberry32, as the TypeScript fixtures draw their randomness.
pub struct Rng(u32);

impl Rng {
    pub fn new(seed: u32) -> Rng {
        Rng(seed)
    }

    pub fn next(&mut self) -> f64 {
        self.0 = self.0.wrapping_add(0x6d2b_79f5);
        let mut t = self.0;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        f64::from(t ^ (t >> 14)) / 4_294_967_296.0
    }

    /// `Math.floor(random() * n)`.
    pub fn below(&mut self, n: usize) -> usize {
        (self.next() * n as f64).floor() as usize
    }
}

const WORDS: [&str; 30] = [
    "cell",
    "membrane",
    "protein",
    "binding",
    "transport",
    "regulation",
    "process",
    "activity",
    "complex",
    "signal",
    "pathway",
    "receptor",
    "kinase",
    "metabolic",
    "response",
    "development",
    "organ",
    "tissue",
    "neuron",
    "synapse",
    "immune",
    "lipid",
    "ion",
    "channel",
    "vesicle",
    "nuclear",
    "mitochondrial",
    "DNA",
    "RNA",
    "repair",
];

const CJK: [&str; 21] = [
    "公司",
    "投资",
    "股东",
    "子公司",
    "控股",
    "集团",
    "科技",
    "有限",
    "银行",
    "基金",
    "管理",
    "北京",
    "上海",
    "深圳",
    "研究院",
    "数据",
    "智能",
    "网络",
    "云计算",
    "医药",
    "能源",
];

pub fn english_label(random: &mut Rng) -> String {
    let words = 1 + random.below(3);
    let parts: Vec<&str> = (0..words)
        .map(|_| WORDS[random.below(WORDS.len())])
        .collect();
    let text = parts.join(" ");
    let mut chars = text.chars();
    match chars.next() {
        Some(first) => first.to_ascii_uppercase().to_string() + chars.as_str(),
        None => text,
    }
}

pub fn cjk_label(random: &mut Rng) -> String {
    let words = 2 + random.below(2);
    (0..words).map(|_| CJK[random.below(CJK.len())]).collect()
}

/// Which versions an element is in.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum Status {
    #[default]
    Both,
    Added,
    Removed,
}

#[derive(Clone, Debug, Default)]
pub struct NodeSpec {
    pub id: String,
    pub label: String,
    pub status: Status,
    /// The before version's label, when it differs (a rename).
    pub label_before: Option<String>,
    /// `replaces` of the after version: merge and split hints.
    pub replaces: Vec<String>,
    pub before_position: Option<Point>,
    pub after_position: Option<Point>,
}

impl NodeSpec {
    pub fn new(id: &str, label: &str) -> NodeSpec {
        NodeSpec {
            id: id.to_owned(),
            label: label.to_owned(),
            ..NodeSpec::default()
        }
    }

    pub fn added(id: &str) -> NodeSpec {
        NodeSpec {
            status: Status::Added,
            ..NodeSpec::new(id, id)
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct EdgeSpec {
    pub source: String,
    pub target: String,
    pub predicate: String,
    pub status: Status,
    /// The before version's endpoints, when they differ (a retarget).
    pub source_before: Option<String>,
    pub target_before: Option<String>,
}

impl EdgeSpec {
    pub fn new(source: &str, target: &str) -> EdgeSpec {
        EdgeSpec {
            source: source.to_owned(),
            target: target.to_owned(),
            predicate: "related".to_owned(),
            ..EdgeSpec::default()
        }
    }

    pub fn added(source: &str, target: &str) -> EdgeSpec {
        EdgeSpec {
            status: Status::Added,
            ..EdgeSpec::new(source, target)
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct GraphSpec {
    pub nodes: Vec<NodeSpec>,
    pub edges: Vec<EdgeSpec>,
}

fn point(p: Point) -> Value {
    let mut out = Object::new();
    out.insert("x", p.x);
    out.insert("y", p.y);
    Value::Object(out)
}

impl GraphSpec {
    /// The before and the after version, as kgdiff JSON.
    pub fn versions(&self) -> (Value, Value) {
        let mut versions = [Vec::new(), Vec::new()];
        let mut edges = [Vec::new(), Vec::new()];
        for node in &self.nodes {
            for (side, present) in [
                (0, node.status != Status::Added),
                (1, node.status != Status::Removed),
            ] {
                if !present {
                    continue;
                }
                let mut out = Object::new();
                out.insert("id", node.id.as_str());
                let label = match (side, &node.label_before) {
                    (0, Some(before)) => before.as_str(),
                    _ => node.label.as_str(),
                };
                out.insert("label", label);
                if side == 1 && !node.replaces.is_empty() {
                    out.insert(
                        "replaces",
                        Value::Array(
                            node.replaces
                                .iter()
                                .map(|r| Value::from(r.as_str()))
                                .collect(),
                        ),
                    );
                }
                let position = if side == 0 {
                    node.before_position
                } else {
                    node.after_position
                };
                if let Some(p) = position {
                    out.insert("position", point(p));
                }
                versions[side].push(Value::Object(out));
            }
        }
        for edge in &self.edges {
            let ends = [
                (
                    edge.status != Status::Added,
                    edge.source_before.as_ref().unwrap_or(&edge.source),
                    edge.target_before.as_ref().unwrap_or(&edge.target),
                ),
                (edge.status != Status::Removed, &edge.source, &edge.target),
            ];
            for (side, (present, source, target)) in ends.into_iter().enumerate() {
                if !present {
                    continue;
                }
                let mut out = Object::new();
                out.insert("source", source.as_str());
                out.insert("target", target.as_str());
                out.insert("predicate", edge.predicate.as_str());
                edges[side].push(Value::Object(out));
            }
        }
        let [nodes_before, nodes_after] = versions;
        let [edges_before, edges_after] = edges;
        let graph = |nodes: Vec<Value>, edges: Vec<Value>| {
            let mut out = Object::new();
            out.insert("nodes", Value::Array(nodes));
            out.insert("edges", Value::Array(edges));
            Value::Object(out)
        };
        (
            graph(nodes_before, edges_before),
            graph(nodes_after, edges_after),
        )
    }

    /// The diff of the two versions, matched by id (`--match id`): a spec says which node is
    /// which, and merges and splits come from its `replaces` hints.
    pub fn diff(&self) -> DiffResult {
        let (before, after) = self.versions();
        let mut options = DiffOptions::default();
        options.r#match.strategy = MatchStrategy::Id;
        kgdiff_core::diff(&before, &after, &options).expect("a valid fixture")
    }

    /// The same graph with every node's before position taken from `layout`.
    pub fn with_before_positions(&self, layout: &LayoutResult) -> GraphSpec {
        let mut out = self.clone();
        for node in &mut out.nodes {
            if let Some(p) = layout.positions.get(node.id.as_str()) {
                node.before_position = Some(*p);
            }
        }
        out
    }
}

fn id(prefix: &str, i: usize) -> String {
    format!("{prefix}{i:04}")
}

/// A random recursive tree: node i attaches to a uniformly random earlier node.
pub fn tree(n: usize, seed: u32, label: fn(&mut Rng) -> String) -> GraphSpec {
    let mut random = Rng::new(seed);
    let mut spec = GraphSpec::default();
    for i in 0..n {
        spec.nodes
            .push(NodeSpec::new(&id("t", i), &label(&mut random)));
        if i > 0 {
            let parent = random.below(i);
            spec.edges.push(EdgeSpec {
                predicate: "is_a".to_owned(),
                ..EdgeSpec::new(&id("t", i), &id("t", parent))
            });
        }
    }
    spec
}

/// Barabási–Albert preferential attachment with `m` edges per new node on average (a fractional
/// part adds one more edge with that probability: m = 1.3 gives a sparse, KG-like graph).
pub fn scale_free(n: usize, m: f64, seed: u32) -> GraphSpec {
    let mut random = Rng::new(seed);
    let mut spec = GraphSpec::default();
    let mut ends: Vec<usize> = Vec::new();
    for i in 0..n {
        spec.nodes
            .push(NodeSpec::new(&id("s", i), &english_label(&mut random)));
        if i == 0 {
            continue;
        }
        let whole = m.floor();
        let extra = usize::from(random.next() < m - whole);
        let want = (whole as usize + extra).min(i);
        // A JavaScript Set: insertion order.
        let mut targets: Vec<usize> = Vec::new();
        while targets.len() < want {
            let t = if ends.is_empty() {
                0
            } else {
                ends[random.below(ends.len())]
            };
            if !targets.contains(&t) {
                targets.push(t);
            }
        }
        for t in targets {
            spec.edges.push(EdgeSpec::new(&id("s", i), &id("s", t)));
            ends.push(i);
            ends.push(t);
        }
    }
    spec
}

pub fn star(leaves: usize) -> GraphSpec {
    let mut random = Rng::new(5);
    let mut spec = GraphSpec::default();
    spec.nodes.push(NodeSpec::new("hub", "Central hub"));
    for i in 0..leaves {
        spec.nodes
            .push(NodeSpec::new(&id("l", i), &english_label(&mut random)));
        spec.edges.push(EdgeSpec::new(&id("l", i), "hub"));
    }
    spec
}

/// Many small components (trees and rings) plus isolated nodes.
pub fn components(count: usize, isolated: usize, seed: u32) -> GraphSpec {
    let mut random = Rng::new(seed);
    let mut spec = GraphSpec::default();
    let mut next = 0;
    for _ in 0..count {
        let size = 2 + (random.next() * random.next() * 24.0).floor() as usize;
        let first = next;
        for i in 0..size {
            let me = next;
            next += 1;
            spec.nodes
                .push(NodeSpec::new(&id("c", me), &english_label(&mut random)));
            if i > 0 {
                let to = first + random.below(i);
                spec.edges.push(EdgeSpec::new(&id("c", me), &id("c", to)));
            }
        }
        if size > 4 && random.next() < 0.4 {
            spec.edges
                .push(EdgeSpec::new(&id("c", first + size - 1), &id("c", first)));
        }
    }
    for i in 0..isolated {
        spec.nodes
            .push(NodeSpec::new(&id("i", i), &english_label(&mut random)));
    }
    spec
}

/// A tree with extra cross links and CJK labels.
pub fn cjk(n: usize, seed: u32) -> GraphSpec {
    let mut spec = tree(n, seed, cjk_label);
    let mut random = Rng::new(seed + 1);
    let mut k = 0.0;
    while k < n as f64 / 6.0 {
        let a = random.below(n);
        let b = random.below(n);
        if a != b {
            spec.edges.push(EdgeSpec {
                predicate: "投资".to_owned(),
                ..EdgeSpec::new(&id("t", a), &id("t", b))
            });
        }
        k += 1.0;
    }
    spec
}

/// A realistic review: a 120-node hierarchy with additions, removals, renames, two merges, a
/// split and retargeted relations (all hinted by `replaces`, so that kgdiff-core finds them).
pub fn changes(seed: u32) -> GraphSpec {
    let mut spec = tree(120, seed, english_label);
    let mut random = Rng::new(seed + 1);
    let node = |spec: &mut GraphSpec, id: &str| -> usize {
        spec.nodes.iter().position(|n| n.id == id).expect("a node")
    };
    let edge_from =
        |spec: &GraphSpec, source: &str| spec.edges.iter().position(|e| e.source == source);

    // Additions: leaves hanging off existing nodes.
    for k in 0..8 {
        let node_id = format!("new{k}");
        spec.nodes.push(NodeSpec {
            status: Status::Added,
            ..NodeSpec::new(&node_id, &english_label(&mut random))
        });
        let target = id("t", random.below(120));
        spec.edges.push(EdgeSpec {
            status: Status::Added,
            predicate: "is_a".to_owned(),
            ..EdgeSpec::new(&node_id, &target)
        });
    }
    // Removals: leaves.
    for victim in [110, 111, 112, 113, 114] {
        let i = node(&mut spec, &id("t", victim));
        spec.nodes[i].status = Status::Removed;
        if let Some(e) = edge_from(&spec, &id("t", victim)) {
            spec.edges[e].status = Status::Removed;
        }
    }
    // Renames.
    for r in [3, 30, 60] {
        let i = node(&mut spec, &id("t", r));
        let before = spec.nodes[i].label.clone();
        spec.nodes[i].label = format!("{before} (revised)");
        spec.nodes[i].label_before = Some(before);
    }
    // Merges: t100 → t20, t101 → t21 (the sources are removed, their edges carried to the target).
    for (source, target) in [(100, 20), (101, 21)] {
        let (s, t) = (id("t", source), id("t", target));
        let i = node(&mut spec, &s);
        spec.nodes[i].status = Status::Removed;
        let j = node(&mut spec, &t);
        spec.nodes[j].replaces.push(s.clone());
        carry(&mut spec, &s, &t);
    }
    // Split: t40 → split0 + split1, both replacing it; split0 carries t40's edges.
    let t40 = node(&mut spec, &id("t", 40));
    spec.nodes[t40].status = Status::Removed;
    let label = format!("{} part", spec.nodes[t40].label);
    carry(&mut spec, &id("t", 40), "split0");
    for target in ["split0", "split1"] {
        spec.nodes.push(NodeSpec {
            status: Status::Added,
            replaces: vec![id("t", 40)],
            ..NodeSpec::new(target, &label)
        });
        spec.edges.push(EdgeSpec {
            status: Status::Added,
            predicate: "is_a".to_owned(),
            ..EdgeSpec::new(target, &id("t", 5))
        });
    }
    // Retargets (moves): t70 and t80 get a new parent.
    for (child, parent) in [(70, 2), (80, 9)] {
        if let Some(e) = edge_from(&spec, &id("t", child)) {
            let moved = &mut spec.edges[e];
            moved.target_before = Some(moved.target.clone());
            moved.target = id("t", parent);
        }
    }
    spec
}

/// Moves the endpoints `from` of every edge of the after version to `to` (a node that goes away
/// hands its edges over, so that none dangles); edges in both versions keep `from` as their
/// before endpoint.
fn carry(spec: &mut GraphSpec, from: &str, to: &str) {
    for edge in &mut spec.edges {
        let both = match edge.status {
            Status::Removed => continue,
            Status::Both => true,
            Status::Added => false,
        };
        if edge.source == from {
            if both {
                edge.source_before = Some(edge.source.clone());
            }
            edge.source = to.to_owned();
        }
        if edge.target == from {
            if both {
                edge.target_before = Some(edge.target.clone());
            }
            edge.target = to.to_owned();
        }
    }
}

/// The same graph, nodes and edges in another (seeded) order.
pub fn shuffled(spec: &GraphSpec, seed: u32) -> GraphSpec {
    let mut random = Rng::new(seed);
    let mut out = spec.clone();
    for i in (1..out.nodes.len()).rev() {
        let j = random.below(i + 1);
        out.nodes.swap(i, j);
    }
    for i in (1..out.edges.len()).rev() {
        let j = random.below(i + 1);
        out.edges.swap(i, j);
    }
    out
}

// ─── Metrics (metrics.ts) ───────────────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug)]
struct Box2 {
    x0: f64,
    y0: f64,
    x1: f64,
    y1: f64,
}

fn intersection(a: &Box2, b: &Box2) -> f64 {
    let w = min(a.x1, b.x1) - max(a.x0, b.x0);
    let h = min(a.y1, b.y1) - max(a.y0, b.y0);
    if w > 0.0 && h > 0.0 { w * h } else { 0.0 }
}

/// Every pair of boxes with positive intersection, by sort-and-sweep on x.
fn overlapping_pairs(boxes: &[Box2], mut visit: impl FnMut(usize, usize, f64)) {
    let mut order: Vec<usize> = (0..boxes.len()).collect();
    order.sort_by(|&a, &b| boxes[a].x0.total_cmp(&boxes[b].x0));
    for p in 0..order.len() {
        let a = &boxes[order[p]];
        for &q in &order[p + 1..] {
            let b = &boxes[q];
            if b.x0 >= a.x1 {
                break;
            }
            let o = intersection(a, b);
            if o > 0.0 {
                visit(order[p], q, o);
            }
        }
    }
}

/// The distance between two points.
pub fn distance(a: Point, b: Point) -> f64 {
    ((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y)).sqrt()
}

/// The label box the layout reserves (`labelBox` of `text-metrics.ts`): width and height.
pub fn label_box(label: &str, before: Option<&str>, font_size: f64) -> (f64, f64) {
    let cap = 32.0 * font_size;
    let mut width = min(estimate_label_width(label, font_size), cap);
    let mut height = 1.25 * font_size;
    if let Some(before) = before.filter(|b| *b != label) {
        width = max(
            width,
            min(estimate_label_width(before, font_size * 11.0 / 12.0), cap),
        );
        height += 14.0 / 12.0 * font_size;
    }
    (width, height)
}

pub const LABEL_GAP: f64 = 5.0;

pub fn label_before(diff: &DiffResult, id: &str) -> Option<String> {
    diff.node(id)?.facets.iter().find_map(|f| match f {
        NodeFacet::Rename { from, .. } => Some(from.to_string()),
        _ => None,
    })
}

#[derive(Clone, Debug)]
pub struct Quality {
    pub nodes: usize,
    pub has_nan: bool,
    /// Min over node pairs of distance − (r1 + r2); ≥ 0 means no circles touch.
    pub min_clearance: f64,
    /// Σ pairwise intersection area of node / label boxes ÷ Σ box area.
    pub label_overlap_ratio: f64,
    /// The box pairs (of different nodes) that intersect, by id.
    pub overlaps: Vec<(String, String)>,
    pub mean_edge_length: f64,
    pub median_edge_length: f64,
    /// Pairs of component bounds that intersect.
    pub component_overlaps: usize,
    /// For every merge source / split target: distance to its partner ÷ median edge length.
    pub partner_ratios: Vec<f64>,
    pub aspect: f64,
}

/// The quality of a layout (`quality()` of `metrics.ts`): node squares and label blocks as drawn.
pub fn quality(diff: &DiffResult, layout: &LayoutResult, font_size: f64) -> Quality {
    let ids: Vec<&JsStr> = layout.positions.keys().collect();
    let has_nan = layout
        .positions
        .values()
        .any(|p| !p.x.is_finite() || !p.y.is_finite());

    let mut boxes = Vec::new();
    let mut owner = Vec::new();
    for (k, id) in ids.iter().enumerate() {
        let p = layout.positions[id.as_str()];
        let r = layout.radii[id.as_str()];
        boxes.push(Box2 {
            x0: p.x - r,
            y0: p.y - r,
            x1: p.x + r,
            y1: p.y + r,
        });
        owner.push(k);
        let label = diff.node(id).map_or(id.as_str(), |n| n.label.as_str());
        let before = label_before(diff, id);
        let (width, height) = label_box(label, before.as_deref(), font_size);
        let top = p.y + r + LABEL_GAP;
        boxes.push(Box2 {
            x0: p.x - width / 2.0,
            y0: top,
            x1: p.x + width / 2.0,
            y1: top + height,
        });
        owner.push(k);
    }
    let mut overlap_area = 0.0;
    let mut overlaps = Vec::new();
    overlapping_pairs(&boxes, |a, b, o| {
        if owner[a] == owner[b] {
            return;
        }
        overlap_area += o;
        overlaps.push((ids[owner[a]].to_string(), ids[owner[b]].to_string()));
    });
    let total_area: f64 = boxes.iter().map(|b| (b.x1 - b.x0) * (b.y1 - b.y0)).sum();

    let mut min_clearance = f64::INFINITY;
    let mut circles: Vec<(Point, f64)> = ids
        .iter()
        .map(|id| (layout.positions[id.as_str()], layout.radii[id.as_str()]))
        .collect();
    circles.sort_by(|a, b| a.0.x.total_cmp(&b.0.x));
    for i in 0..circles.len() {
        let (a, ra) = circles[i];
        for &(b, rb) in &circles[i + 1..] {
            if b.x - a.x - ra - 14.0 > min_clearance {
                break;
            }
            let d = distance(a, b) - ra - rb;
            if d < min_clearance {
                min_clearance = d;
            }
        }
    }

    let mut lengths = Vec::new();
    let mut seen: IndexMap<(String, String), ()> = IndexMap::default();
    let mut add_edge = |s: &str, t: &str| {
        if s == t {
            return;
        }
        let key = if s < t {
            (s.to_owned(), t.to_owned())
        } else {
            (t.to_owned(), s.to_owned())
        };
        if seen.insert(key, ()).is_some() {
            return;
        }
        let (Some(ps), Some(pt)) = (layout.positions.get(s), layout.positions.get(t)) else {
            return;
        };
        lengths.push(distance(*ps, *pt));
    };
    for e in &diff.edges {
        add_edge(&e.source, &e.target);
        add_edge(
            e.source_before.as_ref().unwrap_or(&e.source),
            e.target_before.as_ref().unwrap_or(&e.target),
        );
    }
    lengths.sort_by(f64::total_cmp);
    let mean = if lengths.is_empty() {
        0.0
    } else {
        lengths.iter().sum::<f64>() / lengths.len() as f64
    };
    let median = lengths.get(lengths.len() / 2).copied().unwrap_or(0.0);

    let comps: Vec<Box2> = layout
        .components
        .iter()
        .map(|c| Box2 {
            x0: c.bounds.x,
            y0: c.bounds.y,
            x1: c.bounds.x + c.bounds.width,
            y1: c.bounds.y + c.bounds.height,
        })
        .collect();
    let mut component_overlaps = 0;
    overlapping_pairs(&comps, |_, _, _| component_overlaps += 1);

    let mut partner_ratios = Vec::new();
    for node in &diff.nodes {
        for facet in &node.facets {
            let partner = match facet {
                NodeFacet::MergedInto { target, .. } => target,
                NodeFacet::SplitFrom { source, .. } => source,
                _ => continue,
            };
            if let (Some(a), Some(b)) = (
                layout.positions.get(node.id.as_str()),
                layout.positions.get(partner.as_str()),
            ) && median > 0.0
            {
                partner_ratios.push(distance(*a, *b) / median);
            }
        }
    }

    Quality {
        nodes: ids.len(),
        has_nan,
        min_clearance: if ids.len() > 1 { min_clearance } else { 0.0 },
        label_overlap_ratio: if total_area > 0.0 {
            overlap_area / total_area
        } else {
            0.0
        },
        overlaps,
        mean_edge_length: mean,
        median_edge_length: median,
        component_overlaps,
        partner_ratios,
        aspect: if layout.bounds.height > 0.0 {
            layout.bounds.width / layout.bounds.height
        } else {
            0.0
        },
    }
}

/// No NaN, no touching circles, essentially no overlapping boxes, no overlapping components.
pub fn expect_readable(q: &Quality) {
    assert!(!q.has_nan, "a position is not finite");
    assert!(q.min_clearance >= 0.0, "circles touch: {}", q.min_clearance);
    assert!(
        q.label_overlap_ratio < 0.001,
        "label overlap {}",
        q.label_overlap_ratio
    );
    assert_eq!(q.component_overlaps, 0, "components overlap");
}

/// The layout as text, every double in its shortest round-trip form: equal text, equal layouts.
pub fn json(layout: &LayoutResult) -> String {
    format!("{layout:?}")
}

/// Positions as kgdiff JSON `{ x, y }` points (the shape of `pinned` in options).
pub fn points(pairs: &[(&str, f64, f64)]) -> IndexMap<JsStr, Point> {
    pairs
        .iter()
        .map(|&(id, x, y)| (JsStr::from(id), Point { x, y }))
        .collect()
}
