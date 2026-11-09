# kgdiff-report

The text outputs and HTML reports of [kgdiff](https://github.com/iiwish/kgdiff) in Rust: the
terminal summary, `--stat`, `--name-status` and the Markdown summary of a
[`kgdiff-core`](https://crates.io/crates/kgdiff-core) diff, in English or Simplified Chinese, and
the single-file HTML report. They are the bytes the TypeScript CLI
[`@kgdiff/cli`](https://www.npmjs.com/package/@kgdiff/cli) prints. No I/O: an application that
embeds the engine renders the same summary as `kgdiff` without its argument parsing and files.

Part of [RFC 0002](https://github.com/iiwish/kgdiff/blob/main/docs/rfcs/0002-rust-compute-core.md).
The corpus's text runs (`conformance/`) render byte for byte the same: `cargo test -p
kgdiff-report` checks every summary, `--stat`, `--name-status` and Markdown run, the payload of
every `report.json`, and each report's layout against the case's layout contract.

A report carries its layout, computed by [`kgdiff-layout`](https://crates.io/crates/kgdiff-layout)
and written as a layout document of version 2, so it opens without laying anything out. The
viewer's compute add-on is inlined only when the layout covers just the changes (graphs above the
layout's large-graph threshold), so that the reader can expand collapsed groups
(`needs_compute`).

## The viewer bundles

With the feature `embed-viewer`, `embedded_viewer()` returns the viewer's JavaScript bundles,
compiled in from `assets/`. In the repository, `pnpm build:viewer-assets` builds the viewer and
copies them there; the directory is git-ignored and packaged by `cargo package`. Without the
assets the crate still builds (with a warning) and `embedded_viewer()` is `None`; the
application then passes bundles of its own to `build_report_html`, or reports
`MISSING_VIEWER_HINT`.

Licensed under the MIT license.
