# kgdiff-report

The text outputs and HTML reports of [kgdiff](https://github.com/iiwish/kgdiff) in Rust: the
terminal summary, `--stat`, `--name-status` and the Markdown summary of a
[`kgdiff-core`](https://crates.io/crates/kgdiff-core) diff, in English or Simplified Chinese, and
the single-file HTML report. They are the bytes `kgdiff` (and npm's
[`@kgdiff/cli`](https://www.npmjs.com/package/@kgdiff/cli), which runs it) prints. No I/O: an application that
embeds the engine renders the same summary as `kgdiff` without its argument parsing and files.

Part of [RFC 0002](https://github.com/iiwish/kgdiff/blob/main/docs/rfcs/0002-rust-compute-core.md).
The corpus's text runs (`conformance/`) render byte for byte the same: `cargo test -p
kgdiff-report` checks every summary, `--stat`, `--name-status` and Markdown run, the payload of
every `report.json`, and each report's layout against the case's layout contract.

A report carries its layout, computed by [`kgdiff-layout`](https://crates.io/crates/kgdiff-layout)
and written as a layout document of version 2, so it opens without laying anything out. The
viewer's compute add-on is inlined only when the layout covers just the changes (graphs above the
layout's large-graph threshold), so that the reader can expand collapsed groups, or when the
report has no layout (`needs_compute`).

## The report's layout

`report_payload` and `build_report_html` lay the diff out with the default options. An
application that has a layout already (a cached one, one read from a layout document, one computed
with other options) passes it with `report_payload_with` or `build_report_html_with`
([RFC 0003](https://github.com/iiwish/kgdiff/blob/main/docs/rfcs/0003-embedding-hosts.md), part
2), so that it neither computes a second layout nor puts the payload together itself:

```rust
use kgdiff_layout::{LayoutOptions, layout_diff};
use kgdiff_report::{ReportLayout, report_payload_with};

let mut options = LayoutOptions::default();
options.seed = Some(7.0);
let layout = layout_diff(&diff, &options)?;
let payload = report_payload_with(&diff, ReportLayout::Given(&layout), &info)?;
```

| `ReportLayout`   | The payload's `layout`                                                                |
| ---------------- | ------------------------------------------------------------------------------------- |
| `Default`        | `layout_diff` with the default options: what `report_payload` writes, byte for byte   |
| `Given(&layout)` | the caller's layout, as `layout_to_json` writes it                                    |
| `None`           | left out: the viewer lays the diff out when the report opens, with its compute add-on |

A given layout is checked against the diff, and refused with `invalid-input` when it is the
layout of another one: every position must belong to a union node, and a layout of scope `all`
must place every union node. (The viewer skips a node without a position, so such a report would
open with nodes missing and say nothing.) The layout document rounds coordinates to 0.01:
positions read back from a layout document are on that grid and appear in the report unchanged.

The guide
[Embed kgdiff in a Rust application](https://github.com/iiwish/kgdiff/blob/main/docs/guide/embedding.md)
shows where that layout comes from, so that a graph, its next version and their diff share one
map, and what the browser does with the payload. Its code is
[`examples/embedding.rs`](https://github.com/iiwish/kgdiff/blob/main/crates/kgdiff-report/examples/embedding.rs)
(`cargo run -p kgdiff-report --example embedding`), which `tests/mental_map.rs` runs over the
conformance corpus.

The payload is a `kgdiff.report` document of version 1, described by
[`report.v1.json`](https://github.com/iiwish/kgdiff/blob/main/packages/core/schema/report.v1.json)
(published with `@kgdiff/core`); `cargo test -p kgdiff-report` validates every payload the crate
writes against it.

## The viewer bundles

With the feature `embed-viewer`, `embedded_viewer()` returns the viewer's JavaScript bundles,
compiled in from `assets/`. In the repository, `pnpm build:viewer-assets` builds the viewer and
copies them there; the directory is git-ignored and packaged by `cargo package`. Without the
assets the crate still builds (with a warning) and `embedded_viewer()` is `None`; the
application then passes bundles of its own to `build_report_html`, or reports
`MISSING_VIEWER_HINT`.

Licensed under the MIT license.
