# Migrating to 0.12

kgdiff 0.12 changes only the Rust API: it makes room for the additions planned after 1.0, so that
none of them needs a major release ([Versioning](../versioning.md)). The npm packages, the CLI,
the document formats and every output byte are those of 0.11; for JavaScript and the command
line, the upgrade is the version number. 0.12 is the last release with breaking changes; 1.0 is
0.12 after a stable period
([RFC 0002](https://github.com/iiwish/kgdiff/blob/main/docs/rfcs/0002-rust-compute-core.md#kgdiff-10)).

## Options, inputs and results are `#[non_exhaustive]`

A struct expression of these types no longer compiles outside their crate, with or without
`..Default::default()`. Start from `Default::default()` or a constructor and set the fields:

```rust
// 0.11
let options = DiffOptions {
    edge_identity: graph.edge_identity(),
    ..DiffOptions::default()
};

// 0.12
let mut options = DiffOptions::default();
options.edge_identity = graph.edge_identity();
```

```rust
// 0.11
input.nodes.push(NodeInput {
    label: Some(label.into()),
    ..NodeInput::new(id)
});

// 0.12
let mut node = NodeInput::new(id);
node.label = Some(label.into());
input.nodes.push(node);
```

| Crate            | Built with `Default::default()`                                                 | Built with a constructor                                                                                                                                                                                                     |
| ---------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kgdiff-core`    | `DiffOptions`, `MatchOptions`, `NormalizeOptions`, `ApplyOptions`, `GraphInput` | `NodeInput::new(id)`, `EdgeInput::new(source, predicate, target)`, `KgdiffError::new(code, message)`                                                                                                                         |
| `kgdiff-formats` | `ParseOptions`, `RdfOptions`, `JsonFields`                                      | —                                                                                                                                                                                                                            |
| `kgdiff-layout`  | `LayoutOptions`                                                                 | —                                                                                                                                                                                                                            |
| `kgdiff-report`  | —                                                                               | `ReportInfo::new(title, generator, before, after)`, `ReportSide::new(name, format)`, `ViewerBundles::new(main, compute)` (a `const fn`), `MarkdownOptions::new(locale, title, generator)`, `TextContext::new(paint, locale)` |

The constructors leave the other fields at their defaults: `ReportInfo::new` gives a
reproducible report with the viewer's own defaults (every `Option` `None`, the default locale),
`TextContext::new` 80 columns, every hunk and the default watched keys, `MarkdownOptions::new`
the default watched keys. The fields stay public, so everything else is set as before.

The results kgdiff returns are `#[non_exhaustive]` too (`DiffResult`, `Hunk`, `UnionNode`,
`UnionEdge`, `NodeMatch`, `MatchSuggestion`, `DiffStats`, `Delta`, `ParseResult`,
`LayoutResult` and the others): read their fields as before; a pattern that destructures one
needs `..`.

## Enums that grow are `#[non_exhaustive]`

A `match` on one of these needs a `_` arm: `ErrorCode`, `GraphIssueCode`, `Locale`,
`MatchStrategy`, `MatchMethod`, `EdgeIdentity`, `DanglingEdges`, `Via`, `Cause`, `FacetKind`,
`NodeFacet`, `EdgeFacet`, `DeltaOp`, `NodeField` (`kgdiff-core`); `FormatId`, `JsonDialect`,
`ParseWarningCode`, `CompactWith`, `LoadedDocument` (`kgdiff-formats`); `LayoutStrategy`,
`LayoutScope` (`kgdiff-layout`); `ReportLayout`, `Tone` (`kgdiff-report`).

The variants of `NodeFacet` and `EdgeFacet` with named fields are `#[non_exhaustive]` as well,
so that a facet can gain a field: their patterns need `..`:

```rust
// 0.11
if let NodeFacet::Attrs { changes } = facet { /* … */ }
// 0.12
if let NodeFacet::Attrs { changes, .. } = facet { /* … */ }
```

`ChangeStatus`, `HunkKind`, `ReplayPhase`, `SuggestionReason`, `End` and `js::Value` stay
exhaustive: a host is expected to handle each of their variants.

## Internals hidden from the documentation

These are still public, because kgdiff's crates share them, but hidden from the documentation and
not covered by semantic versioning: in `kgdiff-core` the modules `canonical`, `text` and `util`,
and in `kgdiff_core::js` everything except `Value`, `Object`, `JsStr`, `json`, `IndexMap`,
`IndexSet` and `BuildHasher`; in `kgdiff-report` the modules `locale`, `model` and `width` (the
functions the crate root re-exports from them stay covered); in `kgdiff` every module except
`cli`, `io`, `system` and `testing`. Code that uses them keeps compiling with 0.12, but may break
in any later release.
