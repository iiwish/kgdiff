# kgdiff-formats

The graph file parsers of [kgdiff](https://github.com/iiwish/kgdiff) in Rust: real-world files
read into the graphs [`kgdiff-core`](https://crates.io/crates/kgdiff-core) diffs.

`parse_graph` reads kgdiff JSON and the common JSON graph shapes (d3 / NetworkX, Cytoscape.js,
AntV G6, graphology, vis-network), RDF (Turtle, N-Triples, N-Quads, TriG, RDF/XML, JSON-LD) and
OBO, from text, into one set of conventions, so that diffs across formats behave identically.
`detect_format` picks the format from the file name and the content. Besides the graph, the result
carries the prefixes, the display names of relations and the warnings about input that was
repaired or skipped; syntax errors are `invalid-input` errors with the line. Output is
deterministic, and nothing is ever fetched: JSON-LD remote contexts come only from a document
loader you pass. [`docs/formats.md`](https://github.com/iiwish/kgdiff/blob/main/docs/formats.md)
lists the formats and how RDF and OBO are mapped.

```rust
use kgdiff_core::{DiffOptions, diff};
use kgdiff_core::js::Value;
use kgdiff_formats::{ParseOptions, parse_graph};

let before = r#"@prefix ex: <http://example.org/> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
ex:cat rdfs:label "Cat" ."#;
let after = r#"@prefix ex: <http://example.org/> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
ex:cat rdfs:label "Domestic cat" ."#;

let mut options = ParseOptions::default();
options.filename = Some("zoo.ttl".into());
let before = parse_graph(before, &options)?;
let after = parse_graph(after, &options)?;
assert_eq!(before.format.id(), "turtle");

// The parsed graphs are kgdiff JSON: diff them.
let result = diff(
    &Value::Object(before.graph),
    &Value::Object(after.graph),
    &DiffOptions::default(),
)?;
assert_eq!(result.stats.nodes.modified, 1);
# Ok::<(), Box<dyn std::error::Error>>(())
```

The conformance corpus in
[`conformance/`](https://github.com/iiwish/kgdiff/tree/main/conformance) specifies what the crate
computes: every case's `parse.before.json` and `parse.after.json`. In JavaScript, `parseGraph` of
[`@kgdiff/compute`](https://www.npmjs.com/package/@kgdiff/compute) is this crate compiled to
WebAssembly.

Licensed under the MIT license.
