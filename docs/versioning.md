# Versioning

kgdiff follows [semantic versioning](https://semver.org). This page says what the version number
promises: which changes a release of each kind may contain, and what is not covered.

## One version for everything

Every `@kgdiff/*` npm package and every `kgdiff*` crate on crates.io carries the same version, and
the crates require each other at exactly that version: kgdiff X.Y.Z names one consistent set.
So a breaking change in any part, even one only Rust code sees, is a breaking release of all of
them.

| Release                       | Before 1.0 (0.x)                                      | From 1.0 on              |
| ----------------------------- | ----------------------------------------------------- | ------------------------ |
| Patch (0.12.**1**, 1.0.**1**) | fixes, no change to the public API or to output bytes | the same                 |
| Minor (0.**13**, 1.**1**)     | may break the public API                              | additions only           |
| Major (**2**.0)               | —                                                     | may break the public API |

## What is covered

- **The JavaScript API**: everything `@kgdiff/*` exports, with its types, except what is marked
  `@experimental` (below).
- **The Rust API**: the public items of `kgdiff-core`, `kgdiff-formats`, `kgdiff-layout`,
  `kgdiff-report` and `kgdiff` that the documentation on docs.rs shows. Items marked
  `#[doc(hidden)]` are not covered: they are the engine's own, shared between kgdiff's crates
  (the JavaScript helpers of `kgdiff_core::js` other than `Value`, `Object`, `JsStr`, `json`,
  `IndexMap` and `IndexSet`; the modules `canonical`, `text` and `util`; `kgdiff_report`'s
  `locale`, `model` and `width`; every module of the `kgdiff` crate except `cli`, `io`, `system`
  and `testing`). Methods added to a trait a host implements (`kgdiff::io::CliIo`) come with a
  default implementation. One dependency's types are part of the API: `IndexMap` and
  `IndexSet` are `indexmap` 2's, so a new major version of `indexmap` would be a major release
  of kgdiff.
- **The command line**: commands, options, exit codes, and the files and machine-readable
  outputs it writes (`--json`, `--delta`, `--markdown`, HTML reports). The wording of messages
  and of the terminal summary may change in a minor release.
- **Documents**: the diff JSON, deltas, layout documents and report payloads carry a format
  version. A document of a given version keeps its meaning; a reader rejects a version newer
  than it knows ([Delta format](./delta-format.md)).
- **Output bytes**: the same input and options give the same bytes on every platform and in
  every package. A patch release never changes them. A minor release may, for example when the
  layout algorithm improves; a layout written by a different algorithm then names a different
  `generator` (`kgdiff-layout/1`), so that a cached layout can tell the two apart.

## What can be added without a major release

Adding is not breaking, so these come in minor releases. The Rust types are declared so that
they are additions there too:

- new error, issue and warning codes; new formats, locales, change kinds and match strategies:
  the enums that list them are `#[non_exhaustive]`, so a `match` on them has a `_` arm;
- new fields of options, inputs and results: these structs are `#[non_exhaustive]`, so a host
  builds them from `Default::default()` or a constructor and sets the fields it needs:

  ```rust
  let mut options = DiffOptions::default();
  options.edge_identity = EdgeIdentity::Id;
  ```

In TypeScript the same lists are string unions (`KgdiffErrorCode`, `FormatId`, `ParseWarningCode`
and the others): a new member comes in a minor release, so a `switch` over one needs a `default`
branch. Optional members of option objects and new members of results are additions as well.

Some enums are closed taxonomies of the model, and code is expected to handle every variant:
`ChangeStatus`, `HunkKind`, `ReplayPhase`, `SuggestionReason`, `End` and `js::Value`. A new
variant of one of them is a breaking change.

## Experimental APIs

An API marked `@experimental` in its documentation may change in a minor release. Before 1.0 the
renderer's layers (`addLayer`), the node shapes of `@kgdiff/scene` and the report's `shapes`
carry the mark; 1.0 removes it, and they are covered from then on.

## Platforms

- **Node.js**: the lines `engines` lists (22 and later), each tested in CI.
- **Rust**: the `rust-version` of the crates (the MSRV) is no newer than the stable release of
  six months before, and is raised only in minor releases.
- **Browsers**: those that run WebAssembly and the viewer's custom elements; the viewer bundle
  itself contains no WebAssembly.

## Deprecation

Something deprecated keeps working until the next major release (before 1.0: the next minor),
and its documentation names the replacement. `@kgdiff/formats` is deprecated in favour of
`@kgdiff/core`; its 0.x releases stay on npm, and no 1.0 is published for it.

## Security fixes

Security fixes go into the latest release. From 1.0 on, the latest minor release of the current
major version is supported ([security policy](https://github.com/iiwish/kgdiff/blob/main/.github/SECURITY.md)).
