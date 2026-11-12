---
'@kgdiff/core': minor
---

**Rust crates only:** the public Rust API makes room for the additions planned after 1.0, so that none of them needs a major release. The npm packages' API, the CLI, the document formats and every output byte are those of 0.11; for JavaScript and the command line, the upgrade is the version number. Guide: [Migrating to 0.12](https://github.com/iiwish/kgdiff/blob/main/docs/guide/migrating-to-0.12.md); what each version promises from now on: [Versioning](https://github.com/iiwish/kgdiff/blob/main/docs/versioning.md).

- Enums that will grow are `#[non_exhaustive]` (error, issue and warning codes, formats, locales, strategies, facets, delta ops): a `match` on them needs a `_` arm. `ChangeStatus`, `HunkKind`, `ReplayPhase`, `SuggestionReason`, `End` and `js::Value` stay exhaustive.
- Options, inputs and results are `#[non_exhaustive]`: build them from `Default::default()` or a constructor and set the fields (`let mut options = DiffOptions::default(); options.edge_identity = …;`). New constructors: `ReportInfo::new`, `ReportSide::new`, `ViewerBundles::new`, `MarkdownOptions::new`, `TextContext::new`.
- The internals kgdiff's crates share are hidden from the documentation and not covered by semantic versioning: `kgdiff_core::js` apart from `Value`, `Object`, `JsStr`, `json`, `IndexMap` and `IndexSet`; `kgdiff_core::{canonical, text, util}`; `kgdiff_report::{locale, model, width}`; every module of `kgdiff` apart from `cli`, `io`, `system` and `testing`.
- CI checks the Rust API against the last release with `cargo-semver-checks`.
