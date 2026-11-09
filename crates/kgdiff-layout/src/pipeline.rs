//! `layout_diff` (`layout.ts`): scope → layout graph → strategy → simulation → packing → result.
//! The first three are combinatorial, and pinned by the corpus's `layout-contract.json`.

use kgdiff_core::Result;
use kgdiff_core::model::{Point, UnionId};

use crate::graph::{LayoutGraph, build_layout_graph};
use crate::options::Resolved;
use crate::scope::select_scope;
use crate::union::build_union_graph;
use crate::{LayoutInput, LayoutOptions, LayoutScope, LayoutStrategy};

/// Known positions, by layout index.
#[allow(
    dead_code,
    reason = "the engine (the next pull request) places around them"
)]
pub(crate) struct Known {
    pub fixed: Vec<bool>,
    pub x: Vec<f64>,
    pub y: Vec<f64>,
    pub count: usize,
}

fn finite(p: Option<&Point>) -> Option<Point> {
    p.filter(|p| p.x.is_finite() && p.y.is_finite()).copied()
}

/// Known positions, by priority: explicit pins, then the before version's `position` (the mental
/// map the reviewer already has), then the after version's.
fn known_positions(graph: &LayoutGraph<'_>, options: &Resolved<'_>) -> Known {
    let mut known = Known {
        fixed: vec![false; graph.n],
        x: vec![0.0; graph.n],
        y: vec![0.0; graph.n],
        count: 0,
    };
    for (i, node) in graph.nodes.iter().enumerate() {
        let p = finite(options.pinned.get(node.id.as_str()))
            .or_else(|| finite(node.before.as_ref().and_then(|n| n.position.as_ref())))
            .or_else(|| finite(node.after.as_ref().and_then(|n| n.position.as_ref())));
        if let Some(p) = p {
            known.fixed[i] = true;
            known.x[i] = p.x;
            known.y[i] = p.y;
            known.count += 1;
        }
    }
    known
}

/// Everything about a layout that does not depend on floating-point simulation.
#[allow(
    dead_code,
    reason = "the engine (the next pull request) reads the rest"
)]
pub(crate) struct Plan<'a, 'o> {
    pub options: Resolved<'o>,
    pub scope: LayoutScope,
    /// Visible node → hidden neighbours, in id order (scope `Changes` only).
    pub hidden: Vec<(UnionId, usize)>,
    pub graph: LayoutGraph<'a>,
    pub known: Known,
    pub strategy: LayoutStrategy,
    /// Anchored, and some position is known: the known nodes stay where they are.
    pub anchored: bool,
}

pub(crate) fn plan<'a, 'o>(
    input: LayoutInput<'a>,
    options: &'o LayoutOptions,
) -> Result<Plan<'a, 'o>> {
    let options = options.resolve()?;
    let union = build_union_graph(input.nodes, input.edges);
    let scope = options.scope.unwrap_or(
        if union.nodes.len() as f64 > options.large_graph_threshold {
            LayoutScope::Changes
        } else {
            LayoutScope::All
        },
    );
    let selection = select_scope(&union, scope, options.context_hops, options.hub_degree);
    let graph = build_layout_graph(&union, &selection.visible, options.font_size);
    let known = known_positions(&graph, &options);
    let strategy = options.strategy.unwrap_or(if known.count > 0 {
        LayoutStrategy::Anchored
    } else {
        LayoutStrategy::Union
    });
    let anchored = strategy == LayoutStrategy::Anchored && known.count > 0;
    Ok(Plan {
        options,
        scope,
        hidden: selection.hidden,
        graph,
        known,
        strategy,
        anchored,
    })
}
