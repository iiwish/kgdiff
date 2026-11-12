//! The JSON-text API of `@kgdiff/compute` (RFC 0002, §6, "Rust and Python APIs"). Every function
//! takes kgdiff JSON as text and returns text written the way `JSON.stringify` writes it, so the
//! bindings pass strings only and give the same bytes as the CLI. A failure carries kgdiff's error
//! code and details.

use kgdiff_core::i18n::{Locale, facet_label, format_hunk};
use kgdiff_core::js::{JsStr, Object, Value, json};
use kgdiff_core::model::FacetKind;
use kgdiff_core::options::{DanglingEdges, resolve_edge_identity, resolve_match_options};
use kgdiff_core::{
    ApplyOptions, Delta, ErrorCode, KGraph, NormalizeOptions, apply_delta, diff, diff_from_json,
    diff_to_json, graph_to_json, hash_graph, invert_delta, match_nodes, pack_diff_json,
    resolve_options, unpack_diff_json,
};
use kgdiff_layout::{
    LayoutOptions, extend_layout, layout_after, layout_diff, layout_diff_on, layout_from_json,
    layout_graph, layout_to_json,
};

use crate::failure::{Failure, Result};

/// `text` read as JSON, `what` naming it in the message of an `invalid-input` failure.
fn parse(text: &str, what: &str) -> Result<Value> {
    json::parse(text).map_err(|e| Failure::invalid_input(format!("{what} is not JSON: {e}")))
}

/// `normalize` of a graph given as JSON text, read as it is parsed (`normalize_json`), so that the
/// text, a tree of values and the graph are not all in memory at once. Text that is not JSON fails
/// as [`parse`] does, `what` naming it.
fn normalize_text(text: &str, what: &str, options: NormalizeOptions) -> Result<KGraph> {
    kgdiff_core::normalize_json(text, options).map_err(|error| {
        match error.message.strip_prefix("The graph is not JSON: ") {
            Some(rest) if error.code == ErrorCode::InvalidInput => {
                Failure::invalid_input(format!("{what} is not JSON: {rest}"))
            }
            _ => Failure::from(error),
        }
    })
}

/// Options given as JSON text: empty text and `null` are none.
fn options(text: &str, what: &str) -> Result<Option<Value>> {
    if text.is_empty() {
        return Ok(None);
    }
    Ok(Some(parse(text, what)?).filter(|v| !v.is_null()))
}

/// `NormalizeOptions` from `{ edgeIdentity?, danglingEdges? }`.
fn normalize_options(text: &str) -> Result<NormalizeOptions> {
    let Some(value) = options(text, "the normalize options")? else {
        return Ok(NormalizeOptions::default());
    };
    let object = value
        .as_object()
        .ok_or_else(|| Failure::invalid_input("normalize options must be an object".to_owned()))?;
    let given = |key: &str| object.get(key).filter(|v| !v.is_null());
    let edge_identity = resolve_edge_identity(given("edgeIdentity"), Default::default())?;
    let dangling_edges = match given("danglingEdges").map(|v| v.as_str()) {
        None => DanglingEdges::default(),
        Some(Some("create")) => DanglingEdges::Create,
        Some(Some("drop")) => DanglingEdges::Drop,
        Some(Some("error")) => DanglingEdges::Error,
        Some(_) => {
            return Err(Failure::invalid_input(
                "danglingEdges must be 'create', 'drop' or 'error'".to_owned(),
            ));
        }
    };
    Ok(NormalizeOptions {
        edge_identity,
        dangling_edges,
    })
}

/// `diffToJSON(diff(before, after, options))`: the `kgdiff.diff` document of two graphs.
pub fn diff_json(before: &str, after: &str, options_text: &str) -> Result<String> {
    let result = diff_text(before, after, options_text)?;
    Ok(json::to_string(&diff_to_json(&result)))
}

/// `matchNodes(normalize(before, beforeNormalize), normalize(after, afterNormalize), options)`:
/// `{ matches, suggestions }`. Each graph has its own normalize options (empty text: the
/// defaults), so that a normalized graph passed as JSON keeps its edge identity: with `id`, edges
/// that share a triple stay apart, and the degrees and neighbourhoods matching reads count them.
pub fn match_nodes_json(
    before: &str,
    after: &str,
    options_text: &str,
    before_normalize: &str,
    after_normalize: &str,
) -> Result<String> {
    let options = resolve_match_options(options(options_text, "the match options")?.as_ref())?;
    let graph = |text: &str, what: &str, given: &str| -> Result<_> {
        normalize_text(text, what, normalize_options(given)?)
    };
    let (matches, suggestions) = match_nodes(
        &graph(before, "the before graph", before_normalize)?,
        &graph(after, "the after graph", after_normalize)?,
        &options,
    );
    let mut out = Object::new();
    out.insert(
        "matches",
        Value::Array(matches.iter().map(|m| m.to_value()).collect()),
    );
    out.insert(
        "suggestions",
        Value::Array(suggestions.iter().map(|s| s.to_value()).collect()),
    );
    Ok(json::to_string(&Value::Object(out)))
}

/// `textSimilarity(a, b)`.
pub fn text_similarity(a: &str, b: &str) -> f64 {
    kgdiff_core::text::text_similarity(a, b)
}

/// `graphToJSON(normalize(graph, options))`: the `kgdiff.graph` document.
pub fn normalize_json(graph: &str, options_text: &str) -> Result<String> {
    let graph = normalize_text(graph, "the graph", normalize_options(options_text)?)?;
    Ok(json::to_string(&graph_to_json(&graph)))
}

/// `normalize(graph, options).issues`.
pub fn graph_issues_json(graph: &str, options_text: &str) -> Result<String> {
    let graph = normalize_text(graph, "the graph", normalize_options(options_text)?)?;
    Ok(json::to_string(&issues_value(&graph)))
}

/// `hashGraph(normalize(graph, options))`.
pub fn hash_graph_json(graph: &str, options_text: &str) -> Result<String> {
    let graph = normalize_text(graph, "the graph", normalize_options(options_text)?)?;
    Ok(hash_graph(&graph).to_owned())
}

/// The `kgdiff.diff` document read with `diffFromJSON`, every consistency check included, and
/// written again: the same text for a document `diff_json` wrote.
pub fn read_diff_json(document: &str) -> Result<String> {
    let result = diff_from_json(&parse(document, "the diff")?)?;
    Ok(json::to_string(&diff_to_json(&result)))
}

/// `packDiffJSON(document)`: the packed form HTML reports embed.
pub fn pack_diff(document: &str) -> Result<String> {
    Ok(json::to_string(&pack_diff_json(&parse(
        document, "the diff",
    )?)))
}

/// `unpackDiffJSON(packed)`.
pub fn unpack_diff(packed: &str) -> Result<String> {
    Ok(json::to_string(&unpack_diff_json(&parse(
        packed,
        "the packed diff",
    )?)?))
}

/// The `kgdiff.delta` document of a `kgdiff.diff` document.
pub fn delta_of_diff(document: &str) -> Result<String> {
    let document = parse(document, "the diff")?;
    let delta = document
        .get("delta")
        .ok_or_else(|| Failure::invalid_input("A kgdiff diff needs a delta".to_owned()))?;
    Ok(json::to_string(&Delta::from_value(delta)?.to_value()))
}

/// `invertDelta(delta)`.
pub fn invert_delta_json(delta: &str) -> Result<String> {
    let delta = Delta::from_value(&parse(delta, "the delta")?)?;
    Ok(json::to_string(&invert_delta(&delta).to_value()))
}

/// `applyDelta(normalize(graph), delta, options)`, the graph normalized with the delta's edge
/// identity: `{ graph, skipped }`, the graph as a `kgdiff.graph` document and the ops skipped
/// (lenient mode only) as `{ index, op, reason }`.
pub fn apply_delta_json(graph: &str, delta: &str, options_text: &str) -> Result<String> {
    let delta = Delta::from_value(&parse(delta, "the delta")?)?;
    let strict = match options(options_text, "the apply options")? {
        None => true,
        Some(value) => match value.get("strict") {
            None | Some(Value::Null) => true,
            Some(Value::Bool(strict)) => *strict,
            Some(_) => {
                return Err(Failure::invalid_input(
                    "strict must be a boolean".to_owned(),
                ));
            }
        },
    };
    let base = normalize_text(
        graph,
        "the graph",
        NormalizeOptions {
            edge_identity: delta.edge_identity,
            ..NormalizeOptions::default()
        },
    )?;
    let (applied, skipped) = apply_delta(&base, &delta, ApplyOptions { strict })?;
    let mut out = Object::new();
    out.insert("graph", graph_to_json(&applied));
    let skipped = skipped
        .iter()
        .map(|s| {
            let mut entry = Object::new();
            entry.insert("index", s.index);
            entry.insert("op", s.op.to_value());
            entry.insert("reason", s.reason.as_str());
            Value::Object(entry)
        })
        .collect();
    out.insert("skipped", Value::Array(skipped));
    Ok(json::to_string(&Value::Object(out)))
}

/// `formatHunk` of every hunk of a `kgdiff.diff` document: `[{ id, title, subtitle }]` in hunk
/// order, in `locale` (`en` or `zh-CN`).
pub fn hunk_titles_json(document: &str, locale: &str) -> Result<String> {
    let result = diff_from_json(&parse(document, "the diff")?)?;
    let locale = Locale::from_name(locale);
    let mut titles = Vec::with_capacity(result.hunks.len());
    for hunk in &result.hunks {
        let (title, subtitle) = format_hunk(hunk, &result, locale)?;
        let mut entry = Object::new();
        entry.insert("id", &hunk.id);
        entry.insert("title", title);
        entry.insert("subtitle", subtitle);
        titles.push(Value::Object(entry));
    }
    Ok(json::to_string(&Value::Array(titles)))
}

/// `predicateLabel(predicate)`.
pub fn predicate_label(predicate: &str) -> String {
    kgdiff_core::text::predicate_label(predicate)
        .as_str()
        .to_owned()
}

/// `facetLabel(kind, locale)`, or `None` for an unknown kind.
pub fn facet_label_of(kind: &str, locale: &str) -> Option<String> {
    FacetKind::from_name(kind).map(|k| facet_label(k, Locale::from_name(locale)).to_owned())
}

/// `JSON.stringify(JSON.parse(text))`, or with `pretty`, `JSON.stringify(…, null, 2)`.
pub fn reformat_json(text: &str, pretty: bool) -> Result<String> {
    let value = parse(text, "the text")?;
    Ok(if pretty {
        json::to_string_pretty(&value)
    } else {
        json::to_string(&value)
    })
}

/// `LayoutOptions` of `@kgdiff/layout` from JSON text (`pinned` an object of `{ x, y }` points).
fn layout_options(text: &str) -> Result<LayoutOptions> {
    match options(text, "the layout options")? {
        None => Ok(LayoutOptions::default()),
        Some(value) => Ok(LayoutOptions::from_value(&value)?),
    }
}

fn layout_text(layout: &kgdiff_layout::LayoutResult) -> String {
    json::to_string(&layout_to_json(layout))
}

/// `diff` and `layoutDiff` in one call, without reading the diff back: `{ diff, layout }`, the
/// `kgdiff.diff` and `kgdiff.layout` documents.
pub fn diff_layout_json(
    before: &str,
    after: &str,
    diff_options: &str,
    layout_options_text: &str,
) -> Result<String> {
    let result = diff_text(before, after, diff_options)?;
    let layout = layout_diff(&result, &layout_options(layout_options_text)?)?;
    let mut out = Object::new();
    out.insert("diff", diff_to_json(&result));
    out.insert("layout", layout_to_json(&layout));
    Ok(json::to_string(&Value::Object(out)))
}

/// The diff of two graphs as `@kgdiff/compute` reads it back into a `DiffResult`:
/// `{ diff, issues: { before, after } }`, with `layout` (the `kgdiff.layout` document, laid out
/// with `layout_options_text`) when `with_layout`. A `kgdiff.diff` document does not carry the
/// issues found normalizing the graphs, which a `DiffResult`'s graphs do.
pub fn computed_diff_json(
    before: &str,
    after: &str,
    diff_options: &str,
    layout_options_text: &str,
    with_layout: bool,
) -> Result<String> {
    let result = diff_text(before, after, diff_options)?;
    let mut out = Object::new();
    out.insert("diff", diff_to_json(&result));
    let mut issues = Object::new();
    issues.insert("before", issues_value(&result.before));
    issues.insert("after", issues_value(&result.after));
    out.insert("issues", Value::Object(issues));
    if with_layout {
        let layout = layout_diff(&result, &layout_options(layout_options_text)?)?;
        out.insert("layout", layout_to_json(&layout));
    }
    Ok(json::to_string(&Value::Object(out)))
}

fn diff_text(before: &str, after: &str, diff_options: &str) -> Result<kgdiff_core::DiffResult> {
    let options = resolve_options(options(diff_options, "the diff options")?.as_ref())?;
    Ok(diff(
        &parse(before, "the before graph")?,
        &parse(after, "the after graph")?,
        &options,
    )?)
}

fn issues_value(graph: &KGraph) -> Value {
    Value::Array(
        graph
            .issues()
            .iter()
            .map(|issue| issue.to_value())
            .collect(),
    )
}

/// `layoutToJSON(layoutDiff(diffFromJSON(document), options))`.
pub fn layout_diff_json(document: &str, options_text: &str) -> Result<String> {
    let result = diff_from_json(&parse(document, "the diff")?)?;
    Ok(layout_text(&layout_diff(
        &result,
        &layout_options(options_text)?,
    )?))
}

/// `extendLayout`, `nodes` a JSON array of union ids.
pub fn extend_layout_json(
    document: &str,
    layout: &str,
    nodes: &str,
    options_text: &str,
) -> Result<String> {
    let result = diff_from_json(&parse(document, "the diff")?)?;
    let layout = layout_from_json(&parse(layout, "the layout")?)?;
    let nodes = parse(nodes, "the nodes")?;
    let nodes: Vec<JsStr> = nodes
        .as_array()
        .ok_or_else(|| Failure::invalid_input("nodes must be an array of ids".to_owned()))?
        .iter()
        .map(|id| {
            id.as_str()
                .map(JsStr::from)
                .ok_or_else(|| Failure::invalid_input("nodes must be an array of ids".to_owned()))
        })
        .collect::<Result<_>>()?;
    Ok(layout_text(&extend_layout(
        &result,
        &layout,
        &nodes,
        &layout_options(options_text)?,
    )?))
}

/// `layout_graph(normalize(graph, normalize_options), options)`.
pub fn layout_graph_json(graph: &str, options_text: &str, normalize_given: &str) -> Result<String> {
    let graph = normalize_text(graph, "the graph", normalize_options(normalize_given)?)?;
    Ok(layout_text(&layout_graph(
        &graph,
        &layout_options(options_text)?,
    )?))
}

/// `layout_diff_on(diff, previous, options)`.
pub fn layout_diff_on_json(document: &str, previous: &str, options_text: &str) -> Result<String> {
    let result = diff_from_json(&parse(document, "the diff")?)?;
    let previous = layout_from_json(&parse(previous, "the previous layout")?)?;
    Ok(layout_text(&layout_diff_on(
        &result,
        &previous,
        &layout_options(options_text)?,
    )?))
}

/// `layout_after(diff, layout, options)`.
pub fn layout_after_json(document: &str, layout: &str, options_text: &str) -> Result<String> {
    let result = diff_from_json(&parse(document, "the diff")?)?;
    let layout = layout_from_json(&parse(layout, "the layout")?)?;
    Ok(layout_text(&layout_after(
        &result,
        &layout,
        &layout_options(options_text)?,
    )?))
}

#[cfg(test)]
mod tests {
    use super::*;

    const BEFORE: &str = r#"{"nodes":[{"id":"a","label":"Ada"},{"id":"b"}],
        "edges":[{"source":"a","target":"b","predicate":"knows"}]}"#;
    const AFTER: &str = r#"{"nodes":[{"id":"a","label":"Ada Lovelace"},{"id":"b"}],
        "edges":[{"source":"a","target":"b","predicate":"knows"}]}"#;

    #[test]
    fn diffs_reads_and_titles() {
        let document = diff_json(BEFORE, AFTER, "").unwrap();
        assert!(document.starts_with(r#"{"format":"kgdiff.diff","version":1"#));
        assert_eq!(read_diff_json(&document).unwrap(), document);
        assert_eq!(
            unpack_diff(&pack_diff(&document).unwrap()).unwrap(),
            document
        );
        let titles = hunk_titles_json(&document, "en").unwrap();
        assert!(
            titles.contains("Renamed “Ada” → “Ada Lovelace”"),
            "{titles}"
        );
    }

    #[test]
    fn computed_diffs_carry_the_issues() {
        let before = r#"{"nodes":[{"id":"a"},{"id":"a"}],"edges":[{"source":"a","target":"z"}]}"#;
        let computed =
            json::parse(&computed_diff_json(before, AFTER, "", "", false).unwrap()).unwrap();
        let document = diff_json(before, AFTER, "").unwrap();
        assert_eq!(json::to_string(computed.get("diff").unwrap()), document);
        let issues = computed.get("issues").unwrap();
        assert_eq!(
            json::to_string(issues.get("before").unwrap()),
            graph_issues_json(before, "").unwrap()
        );
        assert_eq!(json::to_string(issues.get("after").unwrap()), "[]");
        assert!(computed.get("layout").is_none());
        let both = json::parse(&diff_layout_json(before, AFTER, "", "{}").unwrap()).unwrap();
        let computed =
            json::parse(&computed_diff_json(before, AFTER, "", "{}", true).unwrap()).unwrap();
        assert_eq!(computed.get("layout"), both.get("layout"));
    }

    #[test]
    fn matches_each_graph_with_its_normalize_options() {
        // Two edges sharing a triple and content, apart only by id: one edge with `structure`.
        let graph = |label: &str, many: &str| {
            format!(
                r#"{{"nodes":[{{"id":"{label}","label":"Alpha {label}"}},{{"id":"h"}},{{"id":"k"}}],
                "edges":[{{"id":"1","source":"{label}","target":"h","predicate":"p"}},
                {{"id":"2","source":"{label}","target":"k","predicate":"q"}},
                {{"id":"3","source":"{label}","target":"{}","predicate":"{many}"}}]}}"#,
                if many == "p" { "h" } else { "k" }
            )
        };
        let (before, after) = (graph("Beta", "p"), graph("Betas", "q"));
        let id = r#"{"edgeIdentity":"id"}"#;
        let by_id = match_nodes_json(&before, &after, "", id, id).unwrap();
        assert_ne!(
            by_id,
            match_nodes_json(&before, &after, "", "", "").unwrap()
        );
        assert_eq!(
            by_id,
            match_nodes_json(&before, &after, "null", id, id).unwrap()
        );
        let failure = match_nodes_json(&before, &after, "", "[]", "").unwrap_err();
        assert_eq!(failure.code, "invalid-input");
    }

    #[test]
    fn applies_and_inverts_the_delta() {
        let document = diff_json(BEFORE, AFTER, "null").unwrap();
        let delta = delta_of_diff(&document).unwrap();
        let applied = apply_delta_json(BEFORE, &delta, "").unwrap();
        let graph = json::parse(&applied).unwrap();
        let expected = normalize_json(AFTER, "").unwrap();
        assert_eq!(json::to_string(graph.get("graph").unwrap()), expected);
        let inverse = invert_delta_json(&delta).unwrap();
        assert!(inverse.contains(r#""format":"kgdiff.delta""#));
    }

    #[test]
    fn fails_with_kgdiff_codes() {
        let failure = diff_json("{", AFTER, "").unwrap_err();
        assert_eq!(failure.code, "invalid-input");
        assert!(failure.message.starts_with("the before graph is not JSON"));
        let failure = diff_json(BEFORE, AFTER, r#"{"edgeIdentity":"x"}"#).unwrap_err();
        assert_eq!(failure.code, "invalid-input");
        let failure = normalize_json(
            r#"{"nodes":[],"edges":[{"source":"a","target":"b"}]}"#,
            r#"{"danglingEdges":"error"}"#,
        )
        .unwrap_err();
        assert_eq!(failure.code, "dangling-edge");
        assert!(failure.to_json().contains(r#""details":{"#));
    }

    #[test]
    fn matches_and_labels() {
        let matched = match_nodes_json(BEFORE, AFTER, "", "", "").unwrap();
        assert!(matched.starts_with(r#"{"matches":["#));
        assert_eq!(text_similarity("Cat", "cat"), 1.0);
        assert_eq!(predicate_label("rdfs:subClassOf"), "subClassOf");
        assert_eq!(facet_label_of("rename", "en").as_deref(), Some("Renamed"));
        assert_eq!(
            reformat_json(r#"{"b":1,"2":0}"#, false).unwrap(),
            r#"{"2":0,"b":1}"#
        );
    }
}
