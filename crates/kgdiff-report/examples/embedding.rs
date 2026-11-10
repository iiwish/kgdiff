//! What an application that embeds kgdiff's crates does with two versions of a graph, in the
//! order it does it: lay out the first version and store the layout; lay out the next version on
//! the same map; diff the two and lay the diff out on that map as well; write the summaries and
//! the report with that layout. Going from a version to the diff then moves no node.
//!
//! ```sh
//! cargo run -p kgdiff-report --example embedding
//! ```
//!
//! The guide `docs/guide/embedding.md` quotes the functions of this file, and
//! `tests/mental_map.rs` runs them over the conformance corpus and checks that every excerpt of
//! the guide is still in here.

use std::error::Error;

use kgdiff_core::js::{IndexMap, Value, json};
use kgdiff_core::model::{Point, UnionId};
use kgdiff_core::{
    DiffOptions, DiffResult, KGraph, Locale, NormalizeOptions, Result, diff_graphs, normalize,
};
use kgdiff_layout::{
    LayoutOptions, LayoutResult, LayoutScope, layout_diff, layout_from_json, layout_graph,
    layout_to_json,
};
use kgdiff_report::{
    MarkdownOptions, Painter, ReportInfo, ReportLayout, ReportSide, TextContext, ViewerBundles,
    build_report_html_with, embedded_viewer, needs_compute, render_markdown, render_summary,
    report_payload_with,
};

/// One version of the application's graph, exported as kgdiff JSON (`{ "nodes": […], "edges":
/// […] }`), as the normalized graph every other function takes.
pub fn read_graph(export: &str) -> std::result::Result<KGraph, Box<dyn Error>> {
    let value = json::parse(export)?;
    Ok(normalize(&value, NormalizeOptions::default())?)
}

/// The layout of a version that has no map yet, and the layout document to store with it.
pub fn first_map(graph: &KGraph) -> Result<(LayoutResult, String)> {
    let layout = layout_graph(graph, &LayoutOptions::default())?;
    let document = json::to_string(&layout_to_json(&layout));
    Ok((layout, document))
}

/// A stored layout document, read back. Its positions are on the document's 0.01 grid, which
/// is where a layout keeps them: they come back the same through any number of versions.
pub fn stored_map(document: &str) -> std::result::Result<LayoutResult, Box<dyn Error>> {
    Ok(layout_from_json(&json::parse(document)?)?)
}

/// The diff of two versions.
pub fn changes(before: &KGraph, after: &KGraph) -> Result<DiffResult> {
    diff_graphs(before.clone(), after.clone(), DiffOptions::default())
}

/// The next version on the previous version's map: a node that continues a node of the previous
/// version stays exactly where that node was, and only the new nodes are placed.
///
/// The positions are carried through the diff, not by id: a node the diff matched under another
/// id (a `replaces` hint, a similarity match) is the same node on the map.
pub fn next_map(diff: &DiffResult, previous: &LayoutResult) -> Result<LayoutResult> {
    let mut pinned: IndexMap<UnionId, Point> = IndexMap::default();
    for node in &diff.nodes {
        if let (Some(before), Some(after)) = (&node.before_id, &node.after_id)
            && let Some(position) = previous.positions.get(before.as_str())
        {
            pinned.insert(after.clone(), *position);
        }
    }
    let options = LayoutOptions {
        pinned,
        ..LayoutOptions::default()
    };
    layout_graph(&diff.after, &options)
}

/// The layout of the diff on the maps of its two versions: a node of the after version is where
/// the after version has it, and a removed node stays where the before version had it. Every
/// node has a known position, so nothing is computed and nothing moves.
pub fn diff_map(
    diff: &DiffResult,
    before: &LayoutResult,
    after: &LayoutResult,
) -> Result<LayoutResult> {
    let mut pinned: IndexMap<UnionId, Point> = IndexMap::default();
    for node in &diff.nodes {
        let in_after = node.after_id.as_ref();
        let in_before = node.before_id.as_ref();
        let position = in_after
            .and_then(|id| after.positions.get(id.as_str()))
            .or_else(|| in_before.and_then(|id| before.positions.get(id.as_str())));
        if let Some(position) = position {
            // Keyed by the union id, which is not always an id of either version.
            pinned.insert(node.id.clone(), *position);
        }
    }
    let options = LayoutOptions {
        pinned,
        // Above 3,000 nodes the default scope is the changes only.
        scope: Some(LayoutScope::All),
        ..LayoutOptions::default()
    };
    layout_diff(diff, &options)
}

/// The other order, for versions that remove nodes: the diff first, on the previous version's
/// map. The layout of the after version alone cannot see the removed nodes, and may put a new
/// node where one of them was; here the new nodes are placed clear of them too.
pub fn diff_map_first(diff: &DiffResult, previous: &LayoutResult) -> Result<LayoutResult> {
    let mut pinned: IndexMap<UnionId, Point> = IndexMap::default();
    for node in &diff.nodes {
        let in_before = node.before_id.as_ref();
        if let Some(position) = in_before.and_then(|id| previous.positions.get(id.as_str())) {
            pinned.insert(node.id.clone(), *position);
        }
    }
    let options = LayoutOptions {
        pinned,
        scope: Some(LayoutScope::All),
        ..LayoutOptions::default()
    };
    layout_diff(diff, &options)
}

/// The after version on the map of its diff: the union id of a node of the after version is
/// its id, so the diff's positions are its pins (those of removed nodes are not read).
pub fn next_map_of(diff: &DiffResult, both: &LayoutResult) -> Result<LayoutResult> {
    let options = LayoutOptions {
        pinned: both.positions.clone(),
        ..LayoutOptions::default()
    };
    layout_graph(&diff.after, &options)
}

/// The summary `kgdiff` prints to a terminal, and the Markdown summary for a comment or a page.
pub fn summaries(diff: &DiffResult, title: &str) -> Result<(String, String)> {
    let context = TextContext {
        paint: Painter::plain(),
        locale: Locale::En,
        width: 80,
        limit: 50,
        watch: None,
    };
    let text = render_summary(diff, title, &context)?;
    let options = MarkdownOptions {
        locale: Locale::En,
        title,
        generator: "my-app 1.0",
        watch: None,
    };
    let markdown = render_markdown(diff, &options)?;
    Ok((text, markdown))
}

/// What a report says about itself.
pub fn report_info(title: &str, before: &str, after: &str) -> ReportInfo {
    let side = |name: &str| ReportSide {
        name: name.to_owned(),
        format: None,
    };
    ReportInfo {
        title: title.to_owned(),
        generator: "my-app 1.0".to_owned(),
        generated_at: None,
        before: side(before),
        after: side(after),
        mode: None,
        scope: None,
        theme: None,
        locale: Locale::En,
        panels: None,
    }
}

/// The report payload with the application's layout: the `kgdiff.report` document a page hands
/// to `<kgdiff-viewer>`, or reads itself.
pub fn report(diff: &DiffResult, layout: &LayoutResult, info: &ReportInfo) -> Result<Value> {
    report_payload_with(diff, ReportLayout::Given(layout), info)
}

/// One version alone, for a page that draws it with the scene and the renderer: the diff of the
/// graph with itself, which has no changes, and the graph's layout, as a report payload. The
/// union ids of that diff are the graph's ids, so the layout of the graph is its layout.
pub fn graph_payload(graph: &KGraph, layout: &LayoutResult, info: &ReportInfo) -> Result<Value> {
    let options = DiffOptions {
        edge_identity: graph.edge_identity,
        ..DiffOptions::default()
    };
    let unchanged = diff_graphs(graph.clone(), graph.clone(), options)?;
    report_payload_with(&unchanged, ReportLayout::Given(layout), info)
}

/// The same report as one HTML file that works offline. `viewer` is `embedded_viewer()` (feature
/// `embed-viewer`), or the standalone bundles of `@kgdiff/viewer` the application ships.
pub fn report_page(
    diff: &DiffResult,
    layout: &LayoutResult,
    info: &ReportInfo,
    viewer: ViewerBundles<'_>,
) -> Result<String> {
    build_report_html_with(diff, ReportLayout::Given(layout), info, viewer)
}

const V1: &str = r#"{
  "meta": { "name": "sales", "version": "1" },
  "nodes": [
    { "id": "customer", "label": "Customer", "types": ["concept"] },
    { "id": "order", "label": "Order", "types": ["concept"] },
    { "id": "revenue", "label": "Revenue", "types": ["metric"] },
    { "id": "churn", "label": "Churn rate", "types": ["metric"] }
  ],
  "edges": [
    { "source": "order", "target": "customer", "predicate": "placed_by" },
    { "source": "revenue", "target": "order", "predicate": "measured_on" },
    { "source": "churn", "target": "customer", "predicate": "measured_on" }
  ]
}"#;

/// Version 2: `revenue` continues under a new id, `churn` is gone and `refund` is new.
const V2: &str = r#"{
  "meta": { "name": "sales", "version": "2" },
  "nodes": [
    { "id": "customer", "label": "Customer", "types": ["concept"] },
    { "id": "order", "label": "Order", "types": ["concept"] },
    { "id": "net-revenue", "label": "Net revenue", "types": ["metric"], "replaces": ["revenue"] },
    { "id": "refund", "label": "Refund", "types": ["concept"] }
  ],
  "edges": [
    { "source": "order", "target": "customer", "predicate": "placed_by" },
    { "source": "net-revenue", "target": "order", "predicate": "measured_on" },
    { "source": "refund", "target": "order", "predicate": "refunds" }
  ]
}"#;

pub fn main() -> std::result::Result<(), Box<dyn Error>> {
    // Version 1 is new: lay it out, and store the layout document with it.
    let v1 = read_graph(V1)?;
    let (map1, stored) = first_map(&v1)?;
    assert_eq!(map1.positions.len(), 4);

    // Version 2 arrives: diff it, and lay it out on the stored map.
    let v2 = read_graph(V2)?;
    let previous = stored_map(&stored)?;
    assert_eq!(previous.positions, map1.positions);
    let diff = changes(&v1, &v2)?;
    let map2 = next_map(&diff, &previous)?;
    for id in ["customer", "order"] {
        assert_eq!(map2.positions[id], previous.positions[id]);
    }
    // The metric kept its place under its new id, and the new concept was placed.
    assert_eq!(map2.positions["net-revenue"], previous.positions["revenue"]);
    assert!(map2.positions.contains_key("refund"));

    // The diff, on the same map: the removed metric is where version 1 had it.
    let both = diff_map(&diff, &previous, &map2)?;
    assert_eq!(both.positions.len(), 5);
    assert_eq!(both.positions["churn"], previous.positions["churn"]);
    assert_eq!(both.positions["net-revenue"], map2.positions["net-revenue"]);
    assert_eq!(both.positions["refund"], map2.positions["refund"]);

    // The other order gives a map with the same promise: the diff first, then version 2.
    let both_first = diff_map_first(&diff, &previous)?;
    let map2_of = next_map_of(&diff, &both_first)?;
    assert_eq!(both_first.positions["churn"], previous.positions["churn"]);
    assert_eq!(
        map2_of.positions["net-revenue"],
        previous.positions["revenue"]
    );
    assert_eq!(map2_of.positions["refund"], both_first.positions["refund"]);

    let (text, markdown) = summaries(&diff, "sales 1 → 2")?;
    assert!(markdown.starts_with("## kgdiff · sales 1 → 2"));
    print!("{text}");

    // The report carries that layout, so the page that shows it computes nothing.
    let info = report_info("sales 1 → 2", "sales 1", "sales 2");
    let payload = report(&diff, &both, &info)?;
    assert_eq!(payload.get("layout"), Some(&layout_to_json(&both)));
    assert!(!needs_compute(&payload));
    println!(
        "\nreport payload: {} bytes of JSON",
        json::to_string(&payload).len()
    );
    // Version 2 on its own, for the page that shows the graph: the same positions again.
    let plain = graph_payload(&v2, &map2, &report_info("sales 2", "sales 2", "sales 2"))?;
    assert_eq!(plain.get("layout"), Some(&layout_to_json(&map2)));
    match embedded_viewer() {
        Some(viewer) => {
            let page = report_page(&diff, &both, &info, viewer)?;
            println!("report page: {} bytes of HTML", page.len());
        }
        None => println!("report page: build with --features embed-viewer for the HTML file"),
    }
    Ok(())
}
