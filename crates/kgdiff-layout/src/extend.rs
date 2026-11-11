//! `extend_layout` (`extend.ts`): adds nodes to a layout without moving anything already placed.

use kgdiff_core::js::Object;
use kgdiff_core::model::{Point, UnionId};
use kgdiff_core::{KgdiffError, Result};

use crate::engine::{Context, place_anchored};
use crate::graph::build_layout_graph;
use crate::math::round2;
use crate::result::{Assemble, assemble};
use crate::scope::count_hidden;
use crate::table::LayoutTable;
use crate::union::build_union_graph;
use crate::{LayoutOptions, LayoutResult, LayoutScope};

pub(crate) fn extend(
    table: &LayoutTable,
    layout: &LayoutResult,
    nodes: &[UnionId],
    options: &LayoutOptions,
) -> Result<LayoutResult> {
    let options = options.resolve()?;
    let union = build_union_graph(table);

    let mut added: Vec<UnionId> = Vec::new();
    let mut is_added = vec![false; union.nodes.len()];
    for id in nodes {
        let Some(&u) = union.index_of.get(id.as_str()) else {
            let mut details = Object::new();
            details.insert("node", id.clone());
            return Err(KgdiffError::invalid_input(format!(
                "extendLayout: node \"{id}\" is not in the diff"
            ))
            .with_details(details));
        };
        if !layout.positions.contains_key(id.as_str()) && !is_added[u] {
            is_added[u] = true;
            added.push(id.clone());
        }
    }
    if added.is_empty() {
        return Ok(layout.clone());
    }

    let mut visible = is_added;
    for id in layout.positions.keys() {
        if let Some(&u) = union.index_of.get(id.as_str()) {
            visible[u] = true;
        }
    }
    let graph = build_layout_graph(&union, &visible, options.font_size);

    let mut fixed = vec![false; graph.n];
    let mut x = vec![0.0; graph.n];
    let mut y = vec![0.0; graph.n];
    for (i, node) in graph.nodes.iter().enumerate() {
        if let Some(p) = layout.positions.get(node.id.as_str()) {
            fixed[i] = true;
            x[i] = p.x;
            y[i] = p.y;
        }
    }
    let mut ctx = Context {
        graph: &graph,
        options: &options,
        x,
        y,
    };
    place_anchored(&mut ctx, &fixed);

    let mut positions: Vec<(UnionId, Point)> = layout
        .positions
        .iter()
        .map(|(id, p)| (id.clone(), *p))
        .collect();
    let mut radii: Vec<(UnionId, f64)> = layout
        .radii
        .iter()
        .map(|(id, r)| (id.clone(), *r))
        .collect();
    for id in &added {
        let i = graph
            .index_of
            .get(id.as_str())
            .copied()
            .expect("an added node is in the graph");
        positions.push((
            id.clone(),
            Point {
                x: round2(ctx.x[i]),
                y: round2(ctx.y[i]),
            },
        ));
        radii.push((id.clone(), graph.radius[i]));
    }
    let hidden = if layout.scope == LayoutScope::Changes {
        count_hidden(&union, &visible)
    } else {
        layout
            .hidden
            .iter()
            .map(|(id, count)| (id.clone(), *count))
            .collect()
    };
    Ok(assemble(Assemble {
        graph: &graph,
        positions,
        radii,
        hidden,
        scope: layout.scope,
        strategy: layout.stats.strategy,
        iterations: layout.stats.iterations,
    }))
}
