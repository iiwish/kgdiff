//! The combinatorial part of a layout as the corpus's `layout-contract.json` records it, before
//! the engine exists to compute whole layouts. Not part of the API: the conformance harness
//! checks it, and `layout_diff` replaces it.

use kgdiff_core::Result;
use kgdiff_core::js::{Object, Value};

use crate::components::connected_components;
use crate::math::round2;
use crate::options::default_iterations;
use crate::pipeline::plan;
use crate::{LayoutInput, LayoutOptions, LayoutStrategy};

/// `layout-contract.json` without `options`: `strategy`, `scope`, `iterations` (union layouts),
/// `nodes`, `radii`, `hidden` and `components`.
///
/// # Errors
///
/// `invalid-input` for invalid options.
pub fn layout_contract<'a>(
    input: impl Into<LayoutInput<'a>>,
    options: &LayoutOptions,
) -> Result<Value> {
    let plan = plan(input.into(), options)?;
    let graph = &plan.graph;
    let components = connected_components(graph, None);

    let mut out = Object::new();
    out.insert("strategy", plan.strategy.as_str());
    out.insert("scope", plan.scope.as_str());
    if plan.strategy == LayoutStrategy::Union {
        // A free layout reports the ticks of its largest simulated component: the first one with
        // more than one node (components come largest first; isolated nodes are not simulated).
        let ticks = components.iter().find(|c| c.len() > 1).map_or(0, |c| {
            plan.options
                .iterations
                .unwrap_or_else(|| default_iterations(c.len()))
        });
        out.insert("iterations", ticks);
    }
    let ids = |list: &[usize]| {
        Value::Array(
            list.iter()
                .map(|&i| Value::from(&graph.nodes[i].id))
                .collect(),
        )
    };
    let all: Vec<usize> = (0..graph.n).collect();
    out.insert("nodes", ids(&all));
    let mut radii = Object::new();
    for (i, node) in graph.nodes.iter().enumerate() {
        radii.insert(node.id.clone(), round2(graph.radius[i]));
    }
    out.insert("radii", radii);
    let mut hidden = Object::new();
    for (id, count) in &plan.hidden {
        hidden.insert(id.clone(), *count);
    }
    out.insert("hidden", hidden);
    out.insert(
        "components",
        Value::Array(components.iter().map(|c| ids(c)).collect()),
    );
    Ok(Value::Object(out))
}
