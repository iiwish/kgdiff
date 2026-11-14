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
  `@experimental` (below). The API reports in `packages/*/api/` list it, entry point by entry
  point. Not covered, as the Rust crates' `#[doc(hidden)]` items are not:
  - `@kgdiff/core/computed` (`readComputedDiff` and its types): an internal entry point that
    only `@kgdiff/compute` of the same version calls;
  - subclassing the viewer's element classes (`@kgdiff/viewer/elements/*`). An element's public
    interface is its attributes, properties, methods, events, slots and CSS, as
    `custom-elements.json` lists them. The base classes the declarations name (`BoundElement`,
    `ViewBoundElement`, `RootElement`) and the members a subclass would override are the
    viewer's own: their declarations leave those members out, and they may change in any
    release;
  - items marked `@internal`, which the declarations leave out where they can.
- **The Rust API**: the public items of `kgdiff-core`, `kgdiff-formats`, `kgdiff-layout`,
  `kgdiff-report` and `kgdiff` that the documentation on docs.rs shows. Items marked
  `#[doc(hidden)]` are not covered: they are the engine's own, shared between kgdiff's crates
  (the JavaScript helpers of `kgdiff_core::js` other than `Value`, `Object`, `JsStr`, `json`,
  `IndexMap` and `IndexSet`; the modules `canonical`, `text` and `util`; `kgdiff_report`'s
  `locale`, `model` and `width`; every module of the `kgdiff` crate except `cli`, `io`, `system`
  and `testing`). Those four are experimental ([below](#experimental-apis)). Methods added to a trait a host implements (`kgdiff::io::CliIo`) come with a
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

An API marked `@experimental` in its documentation may change in a minor release, from 1.0 on
too. These are the renderer's `addLayer`, `LayerView` and `RendererLayer`, the node shapes of
`@kgdiff/scene`, `shape1` and `shape2`, and the report's `shapes`. They are designed for embedding
hosts, and no host has used them yet. The mark stays until one has: then a minor release removes
it, and removing the mark is an addition, not a breaking change.

The embedding interface of the `kgdiff` crate is experimental too: its `cli`, `io`, `system` and
`testing` modules may change in a minor release. `CliIo` still has the shape of its JavaScript
origin (`columns() -> Option<f64>`, `now() -> io::Result<String>`, paths as `&str`), and no
external host uses it. Once the Python bindings have, these modules join the promise.
`kgdiff-core`, `kgdiff-formats`, `kgdiff-layout` and `kgdiff-report` are not affected.

## Platforms

- **Node.js**: the lines `engines` lists (22 and later), each tested in CI.
- **Rust**: the `rust-version` of the crates (the MSRV) is no newer than the stable release of
  six months before, and is raised only in minor releases.
- **Browsers**: those that run WebAssembly and the viewer's custom elements; the viewer bundle
  itself contains no WebAssembly.
- **Python**: the PyPI package `pykgdiff` is the command line only: wheels that hold the native
  `kgdiff` binary (the same as `@kgdiff/cli`'s) and install the `kgdiff` command, at the same
  version as everything else. What it promises is the command line's (above); the wheels need no
  particular Python and run no Python code. There is no Python API yet, so none is covered:
  `import pykgdiff` and `python -m pykgdiff` do not work, and the name is kept for a Python API
  planned after 1.0, which will be an addition. Wheels exist for the targets the native binary is
  built for (macOS x64 and Arm64, Linux x64 and Arm64 with glibc ≥ 2.34 or musl, Windows x64).

## Deprecation

Something deprecated keeps working until the next major release (before 1.0: the next minor),
and its documentation names the replacement. `@kgdiff/formats` was deprecated in
0.11.1 in favour of `@kgdiff/core`, which has the same functions; it is no longer published from
0.12.1 on, and its earlier releases stay on npm.

## Security fixes

Security fixes go into the latest release. From 1.0 on, the latest minor release of the current
major version is supported ([security policy](https://github.com/iiwish/kgdiff/blob/main/.github/SECURITY.md)).
