//! `layout_diff` (`layout.ts`): scope → layout graph → strategy → simulation → packing → result.
//! The first three are combinatorial, and pinned by the corpus's `layout-contract.json`.

use kgdiff_core::Result;
use kgdiff_core::model::{Point, UnionId};

use crate::engine::{Context, place_anchored, place_free};
use crate::graph::{LayoutGraph, build_layout_graph};
use crate::math::round2;
use crate::options::Resolved;
use crate::result::{Assemble, assemble};
use crate::scope::select_scope;
use crate::table::LayoutTable;
use crate::union::build_union_graph;
use crate::{LayoutOptions, LayoutResult, LayoutScope, LayoutStrategy};

/// Known positions, by layout index.
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
        let p = finite(options.pinned.get(node.id.as_str())).or(node.position);
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
    table: &'a LayoutTable,
    options: &'o LayoutOptions,
) -> Result<Plan<'a, 'o>> {
    let options = options.resolve()?;
    let union = build_union_graph(table);
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

/// `layoutDiff`.
pub(crate) fn layout(table: &LayoutTable, options: &LayoutOptions) -> Result<LayoutResult> {
    let Plan {
        options,
        scope,
        hidden,
        graph,
        known,
        strategy,
        anchored,
        ..
    } = plan(table, options)?;
    let (x, y) = if anchored {
        (known.x, known.y)
    } else {
        (vec![0.0; graph.n], vec![0.0; graph.n])
    };
    let mut ctx = Context {
        graph: &graph,
        options: &options,
        x,
        y,
    };
    let iterations = if anchored {
        place_anchored(&mut ctx, &known.fixed)
    } else {
        place_free(&mut ctx)
    };

    let mut positions = Vec::with_capacity(graph.n);
    let mut radii = Vec::with_capacity(graph.n);
    for (i, node) in graph.nodes.iter().enumerate() {
        // Known positions are kept exactly; computed ones are rounded to 0.01.
        let exact = anchored && known.fixed[i];
        let p = if exact {
            Point {
                x: ctx.x[i],
                y: ctx.y[i],
            }
        } else {
            Point {
                x: round2(ctx.x[i]),
                y: round2(ctx.y[i]),
            }
        };
        positions.push((node.id.clone(), p));
        radii.push((node.id.clone(), graph.radius[i]));
    }
    Ok(assemble(Assemble {
        graph: &graph,
        positions,
        radii,
        hidden,
        scope,
        strategy,
        iterations,
    }))
}
