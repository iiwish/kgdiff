//! The exports of `layout.wasm`: the layout on typed arrays (RFC 0002, §7, "Why the split"). It
//! has no JSON reader and no Unicode normalization, so that it can be inlined in HTML reports.
//!
//! One function, [`layout_run`], takes four streams that `packages/compute/src/layout-tables.ts`
//! writes, each read in order: `text` and `lengths` (strings, one after the other, with their
//! lengths in UTF-16 code units), `ints` and `floats`. A layout comes back as one array of
//! numbers, its ids as indices.

use kgdiff_core::js::{IndexMap, JsStr, Lookup, Object, Value};
use kgdiff_core::model::{Point, UnionId};
use kgdiff_layout::table::{
    LayoutTable, TableEdge, TableNode, extend_table, layout_after_table, layout_graph_table,
    layout_table, layout_table_on, partial_layout,
};
use kgdiff_layout::{LayoutOptions, LayoutResult, LayoutScope, LayoutStats, LayoutStrategy};
use wasm_bindgen::prelude::*;

use crate::failure::{Result, thrown};

/// An absent index in `ints`.
const NONE: u32 = u32::MAX;

const LABEL_BEFORE: u32 = 1;
const BEFORE_ID: u32 = 2;
const AFTER_ID: u32 = 4;
const POSITION: u32 = 8;
const CHANGED: u32 = 16;

/// The option names, by their index in the stream.
const OPTIONS: [&str; 11] = [
    "strategy",
    "scope",
    "contextHops",
    "hubDegree",
    "largeGraphThreshold",
    "seed",
    "iterations",
    "linkDistance",
    "labelAware",
    "fontSize",
    "componentGap",
];

struct Streams<'a> {
    text: &'a str,
    lengths: std::slice::Iter<'a, u32>,
    ints: std::slice::Iter<'a, u32>,
    floats: std::slice::Iter<'a, f64>,
}

impl Streams<'_> {
    /// The next string. The streams are this crate's own, written by the package's glue: a short
    /// stream is a bug there, read as zeros.
    fn string(&mut self) -> JsStr {
        let mut units = self.lengths.next().copied().unwrap_or(0) as usize;
        let mut end = 0;
        for c in self.text.chars() {
            if units == 0 {
                break;
            }
            units = units.saturating_sub(c.len_utf16());
            end += c.len_utf8();
        }
        let (head, tail) = self.text.split_at(end);
        self.text = tail;
        JsStr::from(head)
    }

    fn int(&mut self) -> u32 {
        self.ints.next().copied().unwrap_or(0)
    }

    fn count(&mut self) -> usize {
        self.int() as usize
    }

    fn float(&mut self) -> f64 {
        self.floats.next().copied().unwrap_or(0.0)
    }

    fn point(&mut self) -> Point {
        let x = self.float();
        let y = self.float();
        Point { x, y }
    }

    fn index(&mut self) -> Option<usize> {
        match self.int() {
            NONE => None,
            i => Some(i as usize),
        }
    }

    fn table(&mut self) -> LayoutTable {
        let nodes = (0..self.count()).map(|_| self.node()).collect();
        let edges = (0..self.count())
            .map(|_| {
                let changed = self.int() != 0;
                TableEdge {
                    source: self.index(),
                    target: self.index(),
                    source_before: self.index(),
                    target_before: self.index(),
                    changed,
                }
            })
            .collect();
        let partners = (0..self.count())
            .map(|_| (self.count(), self.count()))
            .collect();
        LayoutTable {
            nodes,
            edges,
            partners,
        }
    }

    fn node(&mut self) -> TableNode {
        let flags = self.int();
        let degree = self.count();
        let id = self.string();
        let label = self.string();
        TableNode {
            id,
            label,
            degree,
            changed: flags & CHANGED != 0,
            label_before: (flags & LABEL_BEFORE != 0).then(|| self.string()),
            before_id: (flags & BEFORE_ID != 0).then(|| self.string()),
            after_id: (flags & AFTER_ID != 0).then(|| self.string()),
            position: (flags & POSITION != 0).then(|| self.point()),
        }
    }

    /// One option value: a number, a string, `null`, or a boolean.
    fn value(&mut self) -> Value {
        match self.int() {
            0 => Value::Number(self.float()),
            1 => Value::from(self.string()),
            2 => Value::Null,
            3 => Value::Bool(true),
            _ => Value::Bool(false),
        }
    }

    /// The options, built as the JSON object `LayoutOptions::from_value` reads, so that its
    /// checks and messages hold here too.
    fn options(&mut self) -> Result<LayoutOptions> {
        let mut object = Object::new();
        for _ in 0..self.count() {
            let name = OPTIONS[self.count()];
            let value = self.value();
            object.insert(name, value);
        }
        if self.int() != 0 {
            let mut pinned = Object::new();
            for _ in 0..self.count() {
                let id = self.string();
                let Point { x, y } = self.point();
                let mut point = Object::new();
                point.insert("x", Value::Number(x));
                point.insert("y", Value::Number(y));
                pinned.insert(id, point);
            }
            object.insert("pinned", pinned);
        }
        Ok(LayoutOptions::from_value(&Value::Object(object))?)
    }

    /// A layout as far as the functions taking one read it, and the ids of its positions.
    fn layout(&mut self) -> (LayoutResult, Vec<JsStr>) {
        let mut ids = Vec::new();
        let mut positions = IndexMap::default();
        for _ in 0..self.count() {
            let id = self.string();
            let point = self.point();
            ids.push(id.clone());
            positions.insert(id, point);
        }
        let mut radii = IndexMap::default();
        for _ in 0..self.count() {
            let id = self.string();
            radii.insert(id, self.float());
        }
        let mut hidden = IndexMap::default();
        for _ in 0..self.count() {
            let id = self.string();
            let count = self.count();
            hidden.insert(id, count);
        }
        let scope = if self.int() == 0 {
            LayoutScope::All
        } else {
            LayoutScope::Changes
        };
        let stats = LayoutStats {
            strategy: if self.int() == 0 {
                LayoutStrategy::Union
            } else {
                LayoutStrategy::Anchored
            },
            iterations: self.count(),
            nodes: positions.len(),
        };
        (partial_layout(positions, radii, hidden, scope, stats), ids)
    }
}

fn number(n: usize) -> f64 {
    // Counts and indices fit a double exactly: wasm32's usize is 32 bits.
    n as f64
}

/// The layout as numbers, each id as its index in `table.nodes`, or past them, in `extra`.
fn encode(layout: &LayoutResult, table: &LayoutTable, extra: &[JsStr]) -> Vec<f64> {
    let mut index_of: Lookup<JsStr, usize> = Lookup::with_capacity(table.nodes.len() + extra.len());
    for (i, id) in extra.iter().enumerate() {
        index_of.insert(id.clone(), table.nodes.len() + i);
    }
    for (i, node) in table.nodes.iter().enumerate() {
        index_of.insert(node.id.clone(), i);
    }
    let index = |id: &UnionId| number(index_of.get(id.as_str()).copied().unwrap_or(usize::MAX));
    let rect = |out: &mut Vec<f64>, r: &kgdiff_layout::Rect| {
        out.extend([r.x, r.y, r.width, r.height]);
    };
    let mut out = vec![
        number(usize::from(
            layout.stats.strategy == LayoutStrategy::Anchored,
        )),
        number(usize::from(layout.scope == LayoutScope::Changes)),
        number(layout.stats.iterations),
        number(layout.stats.nodes),
    ];
    rect(&mut out, &layout.bounds);
    out.push(number(layout.positions.len()));
    for (id, p) in &layout.positions {
        out.extend([index(id), p.x, p.y]);
    }
    out.push(number(layout.radii.len()));
    for (id, r) in &layout.radii {
        out.extend([index(id), *r]);
    }
    out.push(number(layout.hidden.len()));
    for (id, count) in &layout.hidden {
        out.extend([index(id), number(*count)]);
    }
    out.push(number(layout.components.len()));
    for component in &layout.components {
        rect(&mut out, &component.bounds);
        out.push(number(component.nodes.len()));
        out.extend(component.nodes.iter().map(&index));
    }
    out
}

fn run(mut s: Streams<'_>, op: u32) -> Result<Vec<f64>> {
    match op {
        // layoutDiff
        0 => {
            let table = s.table();
            let options = s.options()?;
            Ok(encode(&layout_table(&table, &options)?, &table, &[]))
        }
        // extendLayout. Nothing placed comes back empty: the caller keeps its layout.
        1 => {
            let table = s.table();
            let (layout, ids) = s.layout();
            let nodes: Vec<UnionId> = (0..s.count()).map(|_| s.string()).collect();
            let options = s.options()?;
            let result = extend_table(&table, &layout, &nodes, &options)?;
            if result.positions.len() == layout.positions.len() {
                return Ok(Vec::new());
            }
            Ok(encode(&result, &table, &ids))
        }
        // layoutGraph
        2 => {
            let table = s.table();
            let options = s.options()?;
            Ok(encode(&layout_graph_table(&table, &options)?, &table, &[]))
        }
        // layoutDiffOn
        3 => {
            let table = s.table();
            let (previous, _) = s.layout();
            let options = s.options()?;
            Ok(encode(
                &layout_table_on(&table, &previous, &options)?,
                &table,
                &[],
            ))
        }
        // layoutAfter
        _ => {
            let diff = s.table();
            let after = s.table();
            let (layout, _) = s.layout();
            let options = s.options()?;
            Ok(encode(
                &layout_after_table(&diff, &after, &layout, &options)?,
                &after,
                &[],
            ))
        }
    }
}

/// `op` on the streams: `layoutDiff` 0, `extendLayout` 1, `layoutGraph` 2, `layoutDiffOn` 3,
/// `layoutAfter` 4.
#[wasm_bindgen(js_name = layoutRun)]
pub fn layout_run(
    op: u32,
    text: &str,
    lengths: &[u32],
    ints: &[u32],
    floats: &[f64],
) -> std::result::Result<Vec<f64>, JsValue> {
    thrown(run(
        Streams {
            text,
            lengths: lengths.iter(),
            ints: ints.iter(),
            floats: floats.iter(),
        },
        op,
    ))
}

/// `estimateLabelWidth` of `@kgdiff/layout`.
#[wasm_bindgen(js_name = estimateLabelWidth)]
pub fn estimate_label_width(text: &str, font_size: f64) -> f64 {
    kgdiff_layout::estimate_label_width(text, font_size)
}

/// `nodeRadius` of `@kgdiff/layout`.
#[wasm_bindgen(js_name = nodeRadius)]
pub fn node_radius(degree: f64) -> f64 {
    kgdiff_layout::node_radius(degree)
}
