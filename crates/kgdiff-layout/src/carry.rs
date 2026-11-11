//! A layout carried through a diff: the diff on the previous version's map
//! ([`layout_diff_on`](crate::layout_diff_on)) and the after version on the map of its diff
//! ([`layout_after`](crate::layout_after)).
//!
//! A position belongs to a node, not to an id. The diff says which node of the after version
//! continues which node of the before version (`before_id` and `after_id` of a union node), so
//! positions go from one version to the next through it: by id, a node that continues under
//! another id would be placed again, and a node that took over an id would be pinned where the
//! id's former owner was.

use kgdiff_core::js::{IndexMap, Object};
use kgdiff_core::model::{Point, UnionId};
use kgdiff_core::{KgdiffError, Result};

use crate::table::LayoutTable;
use crate::{LayoutOptions, LayoutResult, pipeline};

/// `layout_diff_on`: every union node that continues or was a node `previous` places is pinned
/// there, unless the caller pinned it.
pub(crate) fn diff_on(
    table: &LayoutTable,
    previous: &LayoutResult,
    options: &LayoutOptions,
) -> Result<LayoutResult> {
    options.keeps_positions("the positions of the previous version's layout are kept")?;
    let mut options =
        options.with_every_node("a layout on the previous version's map places every node")?;
    for node in &table.nodes {
        let Some(before) = &node.before_id else {
            continue;
        };
        if options.pinned.contains_key(node.id.as_str()) {
            continue;
        }
        if let Some(position) = previous.positions.get(before.as_str()) {
            // Keyed by the union id, which is not always an id of the before version.
            options.pinned.insert(node.id.clone(), *position);
        }
    }
    pipeline::layout(table, &options)
}

/// The pins of `layout_after`: every node of the after version, by its id in that version, where
/// `layout` has its union node.
///
/// # Errors
///
/// `invalid-input` when `layout` has no position for one of them.
pub(crate) fn after_pins(
    diff: &LayoutTable,
    layout: &LayoutResult,
) -> Result<IndexMap<UnionId, Point>> {
    let mut pinned: IndexMap<UnionId, Point> = IndexMap::default();
    for node in &diff.nodes {
        let Some(after) = &node.after_id else {
            continue;
        };
        let Some(position) = layout.positions.get(node.id.as_str()) else {
            let mut details = Object::new();
            details.insert("node", node.id.clone());
            return Err(KgdiffError::invalid_input(format!(
                "layout_after: the layout has no position for node \"{}\" of the diff, which is \
                 \"{after}\" in the after version",
                node.id
            ))
            .with_details(details));
        };
        pinned.insert(after.clone(), *position);
    }
    Ok(pinned)
}
