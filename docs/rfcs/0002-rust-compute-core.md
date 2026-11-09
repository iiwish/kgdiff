# RFC 0002: A Rust compute core

- **Status:** Draft, proposed. Phase 1 (the conformance corpus,
  [`conformance/`](../../conformance/README.md)) is implemented
  ([PR #41](https://github.com/iiwish/kgdiff/pull/41), merged as a0c52d5). Items 1 and 2 of
  [Before phase 2](#before-phase-2-a-typescript-0x-release) are merged
  ([#43](https://github.com/iiwish/kgdiff/pull/43), d01c4e0;
  [#44](https://github.com/iiwish/kgdiff/pull/44), 7586808). Phase 2's `kgdiff-core` crate is
  merged ([#51](https://github.com/iiwish/kgdiff/pull/51), aafb0e9 to 3e096f2): every corpus case
  and core vector passes, and the nightly differential run is in place. Its performance work is in
  [#56](https://github.com/iiwish/kgdiff/pull/56). The preview `@kgdiff/compute` is still to come.
  Nothing is released yet ([Phase 2 results](#phase-2-results)).
- **Date:** 2026-11-06; revised 2026-11-07 after review ([Review](#review)); phase 2 results
  2026-11-09.
- **Affects:** `@kgdiff/core`, `@kgdiff/formats`, `@kgdiff/layout` and `@kgdiff/cli`
  (reimplemented in Rust), the viewer's compute add-on, the HTML report, CI and release tooling,
  docs. `@kgdiff/scene`, `@kgdiff/renderer`, `@kgdiff/viewer` and `@kgdiff/g6` stay in TypeScript.

## Summary

Move the compute half of kgdiff — parsing, normalizing, matching, classifying, hunking, deltas,
hashing and the layout, about 22,800 lines of TypeScript — to a Rust workspace in this
repository, and keep the interactive half (scene, renderer, viewer, G6 adapter) in TypeScript.
Rust ships as one static `kgdiff` binary, as crates (`kgdiff-core`, `kgdiff-formats`,
`kgdiff-layout`, `kgdiff-report`), as a WebAssembly package for browsers and Node
(`@kgdiff/compute`) and as a Python package.

The two halves meet only at the JSON documents kgdiff already defines and versions — `kgdiff.graph`,
`kgdiff.diff`, `kgdiff.diff.packed`, `kgdiff.delta` and the layout. The Rust implementation must
write those documents **byte for byte** as the TypeScript implementation does today, and must print
the same terminal, `--stat`, `--name-status` and Markdown text, warnings, error messages and exit
codes. A language-neutral conformance corpus generated from the current implementation pins that
behaviour; it is phase 1 and ships with this RFC. Layouts are the one exception: Rust computes them
its own way, and the layout document goes to version 2.

Five phases, each releasable on its own: the corpus; `kgdiff-core`; `kgdiff-formats` with the
Rust CLI; `kgdiff-layout`; and `@kgdiff/compute` replacing the TypeScript compute code in the
browser, which is kgdiff 1.0.

## Motivation

- **The CLI and the engine are Node programs.** Running `kgdiff` in CI, a pre-commit hook or a
  data pipeline means installing Node and an npm dependency tree first — `npx @kgdiff/cli` on a
  cold cache spends seconds resolving and downloading before kgdiff starts. A static binary
  removes both. (Warm, the Node CLI is quick: about 50 ms for `--version` and 0.1 s for the
  enterprise-kg summary on an M-class laptop.)
- **Applications that embed kgdiff want it as a library, in Rust.** A Rust application that
  versions its own graphs (an ontology editor, a data catalog, an agent's memory) and wants its
  terminal summary and the browser's change graph to come from the same data has to go through the
  Node CLI today: export kgdiff JSON, write deltas itself and run `kgdiff apply` to check them.
  With `kgdiff-core` as a crate it calls `diff` directly and renders the summary with
  `kgdiff-report`. Python users (notebooks, ontology pipelines, GraphRAG evaluation) are in the same
  position.
- **Speed and memory.** The budgets in [architecture.md](../architecture.md#budgets) are met, but
  near their limits for large graphs (`normalize` of 100k nodes / 300k edges retains ~111 MB of a
  135 MB budget). Rust's data layout is several times denser and its startup is instant. That is
  a gain of the CLI, the crates and Python; in the browser the transport back to TypeScript costs
  about what the port saves ([§7](#7-size-and-performance-budgets)).
- **Determinism everywhere, not only in V8.** The TypeScript core is byte-reproducible across
  operating systems because Node is V8 everywhere, but in the playground it runs on whatever engine
  the browser has, and `Math.log2` (used by matching) is not correctly rounded and differs between
  engines and C libraries ([J-31](#46-math-and-floating-point)). A TypeScript release before
  phase 2 removes that one difference ([D-1](#open-decisions)); one Rust implementation, compiled
  natively and to WebAssembly, then keeps the same bytes on every platform and in every browser
  without depending on what each engine's math library does.
- **The maintainer prefers Rust for back ends and tools,** and the interactive half — where
  TypeScript is the right tool — does not need to change.

## Goals

1. One Rust implementation of everything that computes results: `parseGraph`, `normalize`,
   `diff`, `applyDelta`, `invertDelta`, `hashGraph`, the JSON transports, hunk titles, the CLI's
   text outputs and the layout.
2. **Byte compatibility** for every document and text output kgdiff writes today, except layout
   positions: `diffToJSON`, `packDiffJSON`, deltas, `graphToJSON`, the terminal summary,
   `--stat`, `--name-status`, `--markdown`, `kgdiff apply`, warnings, kgdiff's own error messages
   and exit codes; and equal values for what is not written as a document of its own (`hashGraph`,
   `ParseResult`, normalization issues, hunk titles, the report payload's metadata). Proven by the
   conformance corpus, not by review.
3. The same results natively (x86-64, AArch64 on Linux, macOS, Windows) and in WebAssembly.
4. Distribution as a single binary (GitHub releases, Homebrew, `cargo install`, npm), as crates,
   as an npm WebAssembly package and as a Python wheel, all with one version number.
5. Every phase is releasable; the project can stop after any phase and be better off.
6. The viewer's standalone bundle stays within its 130 kB budget; reports keep opening without
   running the diff engine.

## Non-goals

- **Porting scene, renderer, viewer or the G6 adapter.** The scene's per-frame resolver is the
  rendering hot path (`resolve` < 4 ms per frame for 5k nodes / 10k edges with zero steady-state
  allocations, [architecture.md](../architecture.md#budgets)); it runs on the main thread next to
  the Canvas calls it feeds, every frame. A call into WebAssembly per frame would add copying of
  frame visuals across the boundary and buy nothing that V8's JIT does not already deliver. The
  DOM, the custom elements and the G6 integration are TypeScript's home ground.
- **Changing any algorithm or output** while porting. Improvements come after the port, with the
  corpus updated in the same change.
- **Byte-identical layouts between TypeScript and Rust** (see [Layout](#layout-decision)).
- **Byte-identical HTML reports between the TypeScript and the Rust CLI.** A report embeds the
  viewer bundle and a layout, and its gzip stream is encoder-specific; each CLI keeps writing
  byte-identical reports for identical input (`--reproducible`).
- **Reproducing third-party parser error messages.** n3's syntax-error wording is not a contract;
  errors keep their codes, exit codes and kgdiff's own messages.
- **Multi-threading in results** in this RFC. Parallelism may come later, behind deterministic
  reductions.

## Design

### 1. Target architecture

#### Repository layout

The Cargo workspace lives at the repository root, next to the pnpm workspace — the layout of
Biome, Oxc, Rolldown and SWC, which every Rust tool (rust-analyzer, `dist`, `maturin`) expects:

```
Cargo.toml              [workspace] members = ["crates/*"]; one [workspace.package] version
Cargo.lock              committed (binaries and bindings are applications)
rust-toolchain.toml     pinned stable toolchain; components rustfmt, clippy; target wasm32
clippy.toml             disallowed types and methods where Rust's defaults differ from JS (§3)
deny.toml               cargo-deny: licenses, advisories, duplicate crates
crates/
  kgdiff-core/          the diff engine and the JS-compatibility layer (crate::js)
  kgdiff-formats/       RDF (all syntaxes), OBO, JSON graph shapes → GraphInput
  kgdiff-layout/        the union layout, with the subset of d3-force it needs
  kgdiff-report/        terminal summary, --stat, --name-status, Markdown, HTML report assembly
  kgdiff/               the `kgdiff` binary; also a library (`kgdiff::cli::run`) for embedding
  kgdiff-wasm/          wasm-bindgen bindings → npm @kgdiff/compute     (not on crates.io)
  kgdiff-python/        PyO3 + maturin bindings → PyPI pykgdiff (D-6)   (not on crates.io)
packages/compute/       npm @kgdiff/compute: JS glue, .wasm files, TypeScript types
packages/cli/           npm @kgdiff/cli: launcher + per-platform binary packages (npm/cli-*)
conformance/            the language-neutral corpus (phase 1)
```

Cargo's `target/` is git-ignored; pnpm ignores the Rust crates and Cargo ignores `node_modules`.

#### Crates

| Crate            | Contents                                                                                                                           | Depends on                                |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `kgdiff-core`    | `normalize`, `diff`, `match_nodes`, `apply_delta`, `invert_delta`, `hash_graph`, JSON transports, `format_hunk`, `text_similarity` | indexmap, ryu-js, ICU4X; serde (optional) |
| `kgdiff-formats` | `parse_graph`, `detect_format`, `compact_iri`                                                                                      | core, oxttl, oxrdfxml, oxiri              |
| `kgdiff-layout`  | `layout_diff`, `extend_layout`, `node_radius`, `estimate_label_width`, layout JSON                                                 | core                                      |
| `kgdiff-report`  | the text outputs of the CLI and the HTML report (payload, escaping, inlining), no I/O                                              | core, layout                              |
| `kgdiff`         | argument parsing, inputs (gzip, UTF-16, size limits), atomic outputs, overwrite checks, colors, `apply`                            | all of the above                          |

`kgdiff-report` is a crate of its own so that an application embedding the engine renders the same
summary and Markdown as `kgdiff` without pulling in argument parsing and file I/O.
The `kgdiff` crate also exposes `cli::run(argv, io) -> ExitCode`, which the Python package uses to
ship the CLI (`python -m pykgdiff`, `uvx --from pykgdiff kgdiff`; the name `kgdiff` is taken on
PyPI, [D-6](#open-decisions)).

#### What stays in TypeScript

After phase 5 the TypeScript side keeps the **read path**: everything the viewer needs to show a
precomputed report synchronously, without WebAssembly:

| Kept in TypeScript (synchronous)                                                                     | Why                                                                                                                                                               |
| ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| core types (`DiffResult`, `UnionNode`, …), `KgdiffError`, `resolveOptions`                           | the data model scene, renderer, viewer and g6 are written against                                                                                                 |
| `diffFromJSON` with its consistency checks and index, `unpackDiffJSON`, `packDiffJSON`, `diffToJSON` | the viewer reads report payloads with them and verifies what it reads; the site packs diffs it computed                                                           |
| `normalize`, `isKGraph`, `graphToJSON`, `hashGraph`, `predicateLabel`                                | `diffFromJSON` rebuilds both graphs, checks each is what `normalize` keeps (re-normalizing a non-canonical document) and compares content hashes with the delta's |
| `applyDelta`, `invertDelta`                                                                          | small, dependency-free, and synchronous callers (delta validation in a host app) gain nothing from WebAssembly                                                    |
| `formatHunk`, `facetLabel`                                                                           | the scene titles hunks in the viewer's locale                                                                                                                     |
| `layoutFromJSON`, `layoutToJSON`, `nodeRadius`, `estimateLabelWidth`                                 | the scene sizes nodes and label boxes exactly as the layout reserved them                                                                                         |
| scene, renderer, viewer, g6                                                                          | non-goals above                                                                                                                                                   |

These kept functions exist in both languages and must agree exactly; the corpus covers each
of them (normalized graphs, hashes, diffs, packed diffs, deltas and their inverses, `kgdiff
apply`, hunk titles, predicate labels, label widths, radii). Everything else — the parsers,
matching (with `textSimilarity` and the blocking keys), merges and splits, classification, edge
pairing, hunks, ordering, delta emission, statistics and the layout engine — is deleted from
TypeScript in phase 5. With the TypeScript CLI, which phase 4 retires, that is about three
quarters of the 22,800 lines (roughly 17,000: formats 6,600, CLI 4,400, core 3,200, layout 3,000).

**The read path is implemented twice for good, not for a transition.** The other quarter, about
5,800 lines, stays in TypeScript after 1.0, and it holds the parts where JavaScript semantics are
hardest to match: `normalize` (NFC, canonical JSON, duplicate merging), the canonical forms and
cyrb53 behind `hashGraph`, the delta checks, `diffFromJSON`'s consistency checks and the label
widths. The corpus stays the bridge for as long as both exist: from phase 5 Rust generates it and
every `pnpm test` checks TypeScript's read path against it ([corpus ownership](#corpus-ownership)),
and a change to a kept function lands in both languages in one pull request. Two choices keep the
bridge narrow: the read path takes snapshot text as normalized and checks it by hash, so it no
longer depends on the browser's Unicode version (a TypeScript change
[before phase 2](#before-phase-2-a-typescript-0x-release)); and nothing joins the read path that
the viewer does not need synchronously.

```
TypeScript (after phase 5)                         Rust
@kgdiff/core   model · read path · i18n  ◀─JSON──  kgdiff-core
@kgdiff/layout model · JSON · radii/widths ◀─JSON─ kgdiff-layout
@kgdiff/scene ◀── renderer ◀── viewer              kgdiff-formats · kgdiff-report · kgdiff (CLI)
                               └── compute add-on ─▶ @kgdiff/compute (WASM: core + formats + layout)
```

### 2. Contract boundary

The boundary between the languages is the set of JSON documents kgdiff already writes, versions
and describes with JSON Schemas in [`packages/core/schema/`](../../packages/core/schema/). The
WebAssembly API passes them as strings, so the boundary carries no new data model: a diff computed
in WebAssembly reaches TypeScript as `diff.v1` JSON text, is read with `JSON.parse` (fast in every
engine) and becomes a `DiffResult` through the existing `diffFromJSON`.

| Document                               | Schema                | Written by today              | Rust from | Version in this RFC                                            |
| -------------------------------------- | --------------------- | ----------------------------- | --------- | -------------------------------------------------------------- |
| graph (`kgdiff.graph`)                 | `graph.v1.json`       | `graphToJSON`, `kgdiff apply` | phase 2   | **unchanged (1)**, byte-identical                              |
| diff (`kgdiff.diff`)                   | `diff.v1.json`        | `diffToJSON`, `--json`        | phase 2   | **unchanged (1)**, byte-identical                              |
| packed diff (`kgdiff.diff.packed`)     | `diff-packed.v1.json` | `packDiffJSON`, HTML reports  | phase 2   | **unchanged (1)**, byte-identical                              |
| delta (`kgdiff.delta`)                 | `delta.v1.json`       | `diff().delta`, `--delta`     | phase 2   | **unchanged (1)**, byte-identical                              |
| parse result (`GraphInput` + warnings) | TypeScript types      | `parseGraph`                  | phase 3   | not a versioned document; pinned by the corpus as JSON         |
| layout (`kgdiff.layout`)               | none yet              | `layoutToJSON`                | phase 4   | **1 → 2**; `layout.v2.json` added; readers accept 1 and 2      |
| report payload (`kgdiff.report`)       | none yet              | CLI (`ReportPayload`)         | phase 3   | **stays 1**; `layout` becomes optional; `report.v1.json` added |

Why only the layout changes version: graph, diff, packed diff and delta keep their exact bytes, so
nothing about them changes for any reader. A layout written by the Rust engine has the same shape as
today's but different positions for the same input (next section), and stored layouts are used as
anchors (an application that keeps one mental map across versions pins the positions it knows).
Version 2 tells a reader that positions come from the new engine and adds one field, `generator`
(`"kgdiff-layout/1"`, bumped whenever an algorithm change moves positions for the same input), so
that caches can tell layout generations apart from then on. Positions taken from a version 1 layout
stay valid pins: anchored layouts keep known positions bit-exact. `layoutFromJSON` learns to read
version 2 in a 0.x release before phase 4, so that every viewer released after it reads both.

`ReportPayload.layout` becoming optional lets an application feed the viewer a diff it computed
itself (with `kgdiff-core`, or as `diff.v1` JSON it wrote): without a layout, the viewer
lays the diff out in the browser with the compute add-on. It is also what lets the phase 3 CLI
write HTML reports before the Rust layout exists (at a cost phase 3 states). It is additive
(version 1 payloads with a layout read as before) and can ship before phase 2.

JSON Schemas for the layout and the report payload are added when they are first written by Rust,
and the existing rule applies to all of them: tests validate everything kgdiff writes, in both
languages, against its schema.

### 3. Determinism

The existing principle — same input and options, byte-identical output — extends to "on every
platform and in WebAssembly". The Rust code follows these rules, each enforced by a type, a lint
or a test rather than by convention alone ([Enforcement](#enforcement) says which, and what is left
to review):

1. **No unordered iteration reaches a result.** Ordered maps and sets are `IndexMap` / `IndexSet`
   (insertion order, like JavaScript's `Map` and `Set`) or sorted vectors. Hash maps are allowed
   for lookups only, behind a project type without an iteration API; `clippy.toml` disallows
   `std::collections::HashMap` / `HashSet` in the engine crates.
2. **Stable sorts with explicit comparators.** JavaScript's `Array.prototype.sort` is stable; so is
   `slice::sort_by`. `sort_unstable*` is disallowed. Strings order as in JavaScript, by UTF-16
   code units ([J-11](#42-strings-ordering-and-indexing)): every text the engine compares is a
   `js::JsStr`, whose `Ord` is that order, so a plain `sort()` or `<` is right by construction.
3. **Floating point:** results use only `+ − × ÷ √`, comparisons and conversions, which IEEE 754
   rounds exactly on every target. Rust never contracts `a * b + c` into a fused multiply-add on
   its own; `mul_add` is disallowed, and release builds never use `-C target-cpu=native`. **No
   result depends on a transcendental function:** `std`'s `f64::log2` and its kin call the
   platform C library natively and another implementation in WebAssembly, so `clippy.toml`
   disallows `f64::{sin, cos, tan, exp, exp2, ln, log, log2, log10, powf, powi, cbrt, hypot,
   atan2, mul_add}` without exception. The one such function TypeScript uses today, `Math.log2`
   in matching, gives way before phase 2 to the layout's `log₂` built from exact operations,
   which both languages then compute ([D-1](#open-decisions), [J-31](#46-math-and-floating-point)).
4. **Seeded PRNG only.** The layout's mulberry32 streams and its FNV-1a per-node seeding are ported
   bit-exactly (`u32` wrapping arithmetic over UTF-16 code units); seeds are converted with
   JavaScript's `ToUint32`, not `as u32`, which saturates ([J-35](#46-math-and-floating-point)).
5. **No clock, environment or thread scheduling in results.** The HTML report's `generatedAt` stays
   the one clock read, omitted with `--reproducible`.
6. **Target independence is tested.** CI computes the corpus outputs — layouts included — on
   x86-64 and AArch64 (Linux, macOS, Windows) and in WebAssembly under Node, and compares their
   hashes. Within Rust, layouts too must be identical on every target.

#### Enforcement

A lint can forbid a method, not an operator or a trait implementation, so the rules are enforced
by whichever of a type, a lint and a test reaches them; "engine crates" are every crate but the
bindings. What no tool sees is listed as left to review, and the corpus backs all of it.

| What                                    | Enforced by                                                                                                                                                                                                                                                                                                                           | Left to review                                                                                                           |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| unordered iteration (rule 1)            | `disallowed-types`: `std::collections::{HashMap, HashSet}`; lookups use a `js::Lookup` without an iteration API                                                                                                                                                                                                                       | —                                                                                                                        |
| UTF-16 string order (J-11)              | a type: ids, predicates, attribute keys, labels and union and hunk ids are `js::JsStr` (a newtype over `Arc<str>` whose `Ord` is `js::cmp_utf16`) from the parser on, so `sort()`, `BTreeMap` and `<` order them as JavaScript does; a property test that sorting `JsStr`s equals sorting their UTF-16 encodings; `string-order.json` | a `str` or `String` compared directly: `Ord for str` cannot be disallowed, so engine code keeps compared text as `JsStr` |
| stable sorts (rule 2)                   | `disallowed-methods`: `sort_unstable`, `sort_unstable_by`, `sort_unstable_by_key` and `select_nth_unstable*` on slices                                                                                                                                                                                                                | —                                                                                                                        |
| whitespace and case (J-17, J-18)        | `disallowed-methods`: `str::{trim, trim_start, trim_end, split_whitespace, to_lowercase, to_uppercase}`, `char::{is_whitespace, to_lowercase, to_uppercase}`, in favour of `js::trim`, `js::is_whitespace` and `js::to_lowercase` (`icu_casemap`); `text-similarity.json`, `unicode-text`                                             | the ASCII variants (`trim_ascii`, `to_ascii_lowercase`), allowed where the text is ASCII by construction                 |
| rounding, minimum, maximum (J-34, J-36) | `disallowed-methods`: `f64::{round, min, max, clamp}`, in favour of `js::math::{round, min, max}`; `js-math.json`                                                                                                                                                                                                                     | —                                                                                                                        |
| number to integer (J-35)                | `clippy::cast_possible_truncation`, `cast_sign_loss` and `cast_possible_wrap` denied in the engine crates, in favour of `js::to_uint32` / `to_int32`; `js-math.json`                                                                                                                                                                  | —                                                                                                                        |
| transcendental functions, FMA (rule 3)  | `disallowed-methods`, as listed in rule 3, without exceptions                                                                                                                                                                                                                                                                         | —                                                                                                                        |
| number to text (J-01, J-03, J-06)       | every document is written by `js::json` ([§4.1](#41-numbers-and-json)); `number-to-string.json`, `hashes.json`                                                                                                                                                                                                                        | `Display` or `format!` of an `f64` that reaches a result: no lint sees the type of a formatting argument                 |
| regular expressions (J-41 … J-48)       | `disallowed-methods`: `regex::Regex::new` outside each crate's `re` module, where every pattern is written against [§4.5](#45-regular-expressions) and tested with the inputs J-41 … J-48 name                                                                                                                                        | the patterns themselves                                                                                                  |
| anything the inventory missed           | the corpus and the nightly differential run on random graphs ([§8](#8-ci-and-release))                                                                                                                                                                                                                                                | —                                                                                                                        |

#### Layout decision

**Decision.** The Rust layout does not have to reproduce the TypeScript layout byte for byte.
When the Rust layout ships (phase 4) the CLI switches to it at once; the browser switches in
phase 5. The layout document goes to version 2. Everything in a layout that does not depend on
floating-point simulation — the scope (which nodes are laid out), `hidden` counts, radii,
strategy, the iteration counts of union layouts and component membership and order — **is**
pinned by the corpus (`layout-contract.json`) and must match exactly. (An anchored layout's tick
count is not in the contract: it simulates a window found by a range query on positions, so it
follows the geometry.) Positions and bounds are checked by properties and quality metrics
instead.

**Reasons.**

1. A layout has no semantics. The contracts users and tools build on — diffs, deltas, hashes,
   summaries — keep their bytes; positions only have to be good, stable and deterministic.
2. A bit-exact port is possible in principle — the TypeScript layout deliberately uses only
   exactly rounded operations (a hand-written `log₂`, rotations from eigenvectors, `Math.sqrt`),
   so that it is identical across JavaScript engines — but costly to achieve and to keep. The
   simulation is chaotic: one summation done in another order (the Barnes–Hut accumulation over
   d3-quadtree's linked JavaScript objects versus an arena quadtree), one tie broken differently,
   and every position differs after a few ticks. Finding such a divergence needs per-tick traces of
   both engines. Requiring it would freeze d3-force's data structures and visiting order into the
   Rust design and make the TypeScript layout a specification forever.
3. Nobody compares layouts across implementations; a report compares two versions on one layout.
   What matters is that one implementation gives the same layout everywhere, which rule 6 tests.
4. Switching at once avoids a long mixed period. Between phases 4 and 5 the CLI's reports carry
   Rust layouts while the playground still lays out in TypeScript, so the same pair of files can
   look different in a report and in the playground; reports themselves are unaffected, because
   expanding a collapsed group (`extendLayout`) keeps every placed node exactly where it is.

### 4. JavaScript-specific behaviour

Byte compatibility depends on reproducing what JavaScript does implicitly. The inventory below was
taken from the four compute packages (and the viewer's read path) and checked against Rust's
defaults on this machine (rustc 1.95, serde_json 1.0.149, macOS) — see
[Appendix A](#appendix-a-measurements). Each item says where it occurs, what Rust does by default,
how the port reproduces JavaScript, and what in the corpus pins it. All of this lives in one module,
`kgdiff_core::js`, which the other crates use; nothing else in the Rust code formats numbers,
compares strings or orders object keys on its own.

#### 4.1 Numbers and JSON

| ID   | Where                                                                                                                                                             | JavaScript                                                                                                                                                                                                                                                                                                                                                               | Rust default                                                                                                                                                 | Port                                                                                                                                                                                                                  | Corpus                                                                                                               |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| J-01 | every `JSON.stringify` (diff, delta, graph, packed, layout, CLI `--json`)                                                                                         | Number → shortest round-trip digits, `1` not `1.0`, plain notation for 1e-7 < \|x\| < 1e21 (`100000000000000000000`, `0.000001`), else `1e+21`, `1e-7`; `-0` → `0`                                                                                                                                                                                                       | serde_json (ryu): `1.0`, `1e+20`, `1e-6`, `-0.0`, and `1.2345678901234567e+20` for `123456789012345680000`                                                   | `ryu-js` (ECMAScript `Number::toString`, used by the Boa engine) for every number `js::json` writes                                                                                                                   | `primitives/number-to-string.json`, J-02 cases                                                                       |
| J-02 | kgdiff JSON input (`JSON.parse` in `formats/json.ts`, then `toAttrValue`, `formats/shared.ts:55`), diff / delta / layout readers                                  | `JSON.parse` is correctly rounded and every number is a double: `9007199254740993` → `9007199254740992`, `1e400` → `Infinity`. The JSON reader then drops non-finite numbers without a warning: an attribute or `meta` member disappears, an array item becomes `null` (`normalize`'s `"Infinity"` strings arise only when an API caller passes a JavaScript `Infinity`) | without `float_roundtrip` serde_json rounds some decimals wrongly (`123456789012345680000` read as `…67e20`); integers stay exact `u64`; `1e400` is an error | `js::json` (below) converts every number lexeme with `f64::from_str` (correctly rounded, overflow → ±∞, as `JSON.parse`), then `toAttrValue`'s rules                                                                  | `json-numbers-and-keys` (`beyond`, `with_beyond`, `meta.overflow`), `json-roundtrip.json`, `number-from-string.json` |
| J-03 | `String(value)` in `hashGraph` (`canonical.ts:203`), `String(seed)` (`layout/prng.ts:39`)                                                                         | Number::toString                                                                                                                                                                                                                                                                                                                                                         | `format!("{}")` never uses exponents (`1e21` → `1000000000000000000000`)                                                                                     | `ryu-js` (J-01)                                                                                                                                                                                                       | `hashes.json` of every case                                                                                          |
| J-04 | `JSON.stringify(v, null, 2)` (`--pretty`)                                                                                                                         | two-space indent, `[]` / `{}` for empty containers                                                                                                                                                                                                                                                                                                                       | `PrettyFormatter` gives the same layout                                                                                                                      | `js::json`'s two-space writer, with its numbers and key order                                                                                                                                                         | `json-numbers-and-keys` (`--pretty` run)                                                                             |
| J-05 | string escaping in `JSON.stringify`                                                                                                                               | `\"` `\\` `\b \f \n \r \t`, other C0 as lowercase `\u00xx`; U+2028/2029 and DEL raw; lone surrogates as `\udxxx`                                                                                                                                                                                                                                                         | serde_json escapes identically; Rust strings cannot hold lone surrogates                                                                                     | `js::json` escapes as `JSON.stringify` does; lone surrogates per J-14                                                                                                                                                 | `unicode-text`                                                                                                       |
| J-06 | `toExponential()` in JSON-LD (`jsonld.ts:1374`); `toFixed(0)` (`jsonld.ts:1291`); `toFixed(1)` in byte sizes of messages (`cli/inputs.ts:77`, `cli/output.ts:48`) | `toExponential()`: shortest digits, `1.1e+0`. `toFixed(n)`: the digits of the exact binary value with a tie rounded away from zero (`(0.25).toFixed(1)` is `0.3`, `(1.25).toFixed(1)` `1.3`, `(1.005).toFixed(2)` `1.00`), `-0` → `0`, `String(x)` from 1e21 on                                                                                                          | `{:e}`: shortest digits but `1.1e0`; `{:.1}`: exact digits, but exact ties round to even (`0.2`, `1.2`) and `-0` stays `-0`                                  | `toExponential` from `ryu-js` digits with ECMAScript's exponent format; `toFixed` per ECMAScript `Number.prototype.toFixed` on the exact decimal expansion (rounding the shortest digits would give `1.01` for 1.005) | `number-to-string.json` (`exponential`, `fixed`), `jsonld`, `cli-errors` (`input-size-limit`)                        |
| J-07 | `Number(text)` in typed RDF literals (`formats/shared.ts:395`), `--threshold`, `--limit`, `COLUMNS`, `COLORFGBG`                                                  | trims JavaScript whitespace; `""` → 0; accepts `0x1F`, `0o17`, `0b11`, `Infinity`, `1_0` → NaN                                                                                                                                                                                                                                                                           | `str::parse::<f64>` rejects hex and whitespace, accepts `inf`, `NaN`, `infinity`                                                                             | `js::number_from_str` implementing `StringToNumber` exactly; the lexical-form regexes in front of it are kept                                                                                                         | `rdf-turtle-ntriples` (typed literals); CLI tests port                                                               |
| J-08 | `Number.isSafeInteger` for xsd integers (`shared.ts:396`)                                                                                                         | integers beyond 2⁵³ − 1 stay strings                                                                                                                                                                                                                                                                                                                                     | —                                                                                                                                                            | same check on the parsed double                                                                                                                                                                                       | `rdf-turtle-ntriples`                                                                                                |

**The JSON reader and writer are kgdiff's own** (`kgdiff_core::js::json`, [D-12](#open-decisions)),
not serde_json. serde_json could read numbers JavaScript's way only with its `arbitrary_precision`
feature and keep key order only with `preserve_order`, and Cargo unifies features across a build:
an application that embeds `kgdiff-core` would get both in its own serde_json, where
`arbitrary_precision` changes what `Number` and `Value` hold and breaks untagged and internally
tagged enums and `flatten` over numbers, and `preserve_order` changes the order of every `Map`.
kgdiff also needs what neither feature gives: lone surrogates rejected or carried (J-14), keys
written array indices first (J-21), duplicate keys resolved as `JSON.parse` does (J-23), error
positions in UTF-16 units with kgdiff's own messages (J-54) and the nesting limits of the readers
(1,000 levels; 200 in JSON-LD). `js::json` is a reader into `js::Value` (doubles, `js::Object`,
strings, positions) and a compact and two-space writer (`ryu-js` numbers, `JSON.stringify`'s
escapes): a few hundred lines, pinned by `json-roundtrip.json`, `number-from-string.json` and the
corpus, and fuzzed against serde_json as an oracle on the inputs both accept. `serde` stays an
optional dependency: with the feature `serde`, the public model types derive `Serialize` and
`Deserialize` for embedders, but no document kgdiff reads or writes goes through serde.

#### 4.2 Strings, ordering and indexing

| ID   | Where                                                                                                                                                                                                              | JavaScript                                                                                                                                                                                                                                                                                                                         | Rust default                                                                    | Port                                                                                                                                                                                                                                                                                                                                                                                                | Corpus                                                                                                                        |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| J-11 | `.sort()` without comparator (35 sites in core; a TypedArray's `.sort()` is numeric, `layout/union.ts:58`), `compareStrings`, `a < b` on strings (union ids, hunk order, delta order, `sortedUnique`, layout keys) | UTF-16 code unit order: U+1F600 (😀, surrogates D83D…) sorts **before** U+E000 and U+FF5E                                                                                                                                                                                                                                          | `str` `Ord` is code point order: U+E000 < U+FF5E < U+1F600                      | `js::cmp_utf16(a, b)`: find the first differing characters; when one is supplementary (≥ U+10000) and the other lies in U+E000–U+FFFF, the supplementary one sorts first, otherwise code point order decides (UTF-8 byte order agrees with it). It is the `Ord` of `js::JsStr`, the type of all compared text, so every sort and every `<` on strings goes through it ([Enforcement](#enforcement)) | `string-order.json`, `unicode-text`                                                                                           |
| J-12 | `.length`, `.slice`, `charCodeAt`, `lastIndexOf` (UTF-16 units) vs `Array.from` / `for…of` (code points) vs `Intl.Segmenter` (graphemes)                                                                           | each call site counts in its own unit. `nameKeys` (`text.ts:296`) tests `token.length >= 2` and takes `token.slice(0, 4)`, which can cut a surrogate pair. Error messages quote one UTF-16 unit (`formats/json.ts:82`: `found "\ud83d"`) or clip at 57 units (`formats/obo.ts:207`); Node writes the half pair to stderr as U+FFFD | byte indices                                                                    | per call site, the same unit: `js::utf16_len`, UTF-16 slicing for `nameKeys` (keys stored as UTF-16 code-unit vectors, so a key ending in half a pair compares as in JavaScript), `chars()` for code points; in messages, a lone unit escaped as `JSON.stringify` does, and U+FFFD where a clip cuts a pair                                                                                         | `cli-errors` (`invalid-json-astral`, `obo-clipped-line`); `nameKeys`: the nightly differential run and unit tests in the port |
| J-13 | `cyrb53` (`canonical.ts:154`), formats' blank-node hash (`shared.ts:288`), layout FNV-1a (`prng.ts:22`)                                                                                                            | hash UTF-16 code units                                                                                                                                                                                                                                                                                                             | iterating `bytes()` or `chars()` hashes something else                          | iterate `encode_utf16()`                                                                                                                                                                                                                                                                                                                                                                            | `hashes.json`, blank nodes in RDF cases                                                                                       |
| J-14 | `JSON.parse` of `"\ud800"`                                                                                                                                                                                         | accepted; a lone surrogate travels through ids and labels and is written back escaped                                                                                                                                                                                                                                              | serde_json rejects it                                                           | **open decision** ([D-2](#open-decisions)): reject with `invalid-input` (recommended) or carry WTF-8; `js::json` can do either. Text files cannot contain lone surrogates (strict UTF-8 / UTF-16 decoding), only JSON escapes can                                                                                                                                                                   | left out of the corpus until D-2 is decided                                                                                   |
| J-15 | `localeCompare`, `Intl.Collator`                                                                                                                                                                                   | not used in compute code                                                                                                                                                                                                                                                                                                           | —                                                                               | nothing to port; keep it that way (a lint in the TS read path)                                                                                                                                                                                                                                                                                                                                      | —                                                                                                                             |
| J-16 | `Intl.Segmenter` (`cli/width.ts:85`), `Intl.NumberFormat` (`scene/focus.ts:55`, stays TS)                                                                                                                          | grapheme clusters from the runtime's ICU                                                                                                                                                                                                                                                                                           | —                                                                               | `icu_segmenter` (UAX #29, same data version as the other ICU4X crates); the CLI's East Asian width table is already hard-coded (Unicode 16) and is ported verbatim                                                                                                                                                                                                                                  | `unicode-text` (narrow-width summary)                                                                                         |
| J-17 | `.trim()` (36 sites), `trimStart` / `trimEnd` (9), `\s` in regexes (also `layout/text-metrics.ts:60`, on the kept `estimateLabelWidth` path)                                                                       | WhiteSpace + LineTerminator: includes U+FEFF, excludes U+0085                                                                                                                                                                                                                                                                      | `str::trim` uses Unicode White_Space: includes U+0085, excludes U+FEFF          | `js::trim` and a `js::is_whitespace` class used by every port of `\s`                                                                                                                                                                                                                                                                                                                               | `unicode-text`                                                                                                                |
| J-18 | `toLowerCase` (core `text.ts`, formats detection, CLI)                                                                                                                                                             | full Unicode case mapping incl. Final_Sigma (`ΟΔΟΣ` → `οδος`), `İ` → `i̇`; Unicode version of the runtime                                                                                                                                                                                                                           | `str::to_lowercase` does the same, with the Unicode version of the Rust release | `icu_casemap` so that case mapping, normalization and properties share one Unicode version; ASCII fast paths as in TypeScript                                                                                                                                                                                                                                                                       | `text-similarity.json`                                                                                                        |
| J-19 | `decodeURIComponent` (`text.ts:333`)                                                                                                                                                                               | decodes every `%XX` as UTF-8; any malformed sequence throws, and the caller keeps the text                                                                                                                                                                                                                                         | `percent-encoding` leaves malformed escapes in place                            | decode strictly, return the input on any error                                                                                                                                                                                                                                                                                                                                                      | `predicate-label.json`                                                                                                        |

#### 4.3 Object key order

| ID   | Where                                                                                                                                                                                                                                                                                                                                                                                                                    | JavaScript                                                                                                                                                                                                                       | Rust default                                             | Port                                                                                                                                                                                                            | Corpus                                                       |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| J-21 | every object written: attrs (`canonicalAttrs` inserts keys sorted), `meta` (passed through from input), layout `positions` / `radii` / `hidden` (`Object.fromEntries` of sorted ids), formats' `AttrBag`                                                                                                                                                                                                                 | an object lists **array-index keys first, in ascending numeric order** (`"0"`, `"2"`, `"10"`, …, up to `"4294967294"`), then all other keys in insertion order. Sorted keys `["10","2","a"]` are written `{"2":…,"10":…,"a":…}`  | `IndexMap` keeps insertion order: `{"10":…,"2":…,"a":…}` | `js::Object`, an `IndexMap` whose writer emits canonical array-index keys (no leading zeros, < 2³² − 1) first, numerically, then the rest in insertion order. Every JSON object kgdiff writes is a `js::Object` | `json-numbers-and-keys`                                      |
| J-22 | three canonical JSON forms: core's `canonicalJSON` (`canonical.ts`: compares values, picks the duplicate declaration "largest by canonical JSON"), formats' `canonicalJson` (`shared.ts:78`: de-duplicates and orders multi-valued attributes in `AttrBag`, breaks ties in `sortEdges`) and JSON-LD's (`jsonld.ts:1359`, `@json` literals); and `sortNodes` breaks id ties with `JSON.stringify(node)` (`shared.ts:246`) | core's form goes through an object, so array-index keys come first (J-21); both formats forms build the text with keys in code-unit order; `JSON.stringify(node)` follows J-21 and the field order in which formats builds nodes | —                                                        | four functions, ported separately and tested one by one; the node tie-break serializes fields in the TypeScript field order                                                                                     | `json-numbers-and-keys`, `jsonld`, `dangling-and-duplicates` |
| J-23 | `JSON.parse` with a duplicate key                                                                                                                                                                                                                                                                                                                                                                                        | last value wins, at the position of the first                                                                                                                                                                                    | `IndexMap::insert` does the same                         | the same in `js::json`; J-21 then orders the keys                                                                                                                                                               | `json-numbers-and-keys`                                      |
| J-24 | the key `__proto__`                                                                                                                                                                                                                                                                                                                                                                                                      | `JSON.parse` and kgdiff's `setAttr` make it an ordinary own key                                                                                                                                                                  | an ordinary key                                          | nothing special anywhere                                                                                                                                                                                        | `json-numbers-and-keys`                                      |

#### 4.4 Unicode data

| ID   | Where                                                                                                                                                                                                                                                  | JavaScript                                                                                                                                     | Port                                                                                                                                                                                                       | Corpus                                 |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| J-25 | NFC of labels, aliases and types (`text.ts:32`), NFKC in `textSimilarity` (`text.ts:47`)                                                                                                                                                               | `String.prototype.normalize`, with the runtime's ICU (Node 24.15: ICU 78.3, Unicode 17.0; Node 22: older)                                      | `icu_normalizer` (compiled data)                                                                                                                                                                           | `unicode-text`, `text-similarity.json` |
| J-26 | `\p{P}`, `\p{L}`, `\p{Lu}` (`layout/text-metrics.ts:62`), `\p{N}` (`cli/markdown.ts:65`), `\p{Cc}`, `\p{Cf}`, `\p{Nd}`, `\p{Script=Han/Hiragana/Katakana/Hangul}`, `\p{Mn}`, `\p{Me}`, `\p{Emoji}`, `\p{Emoji_Presentation}`, `\p{Regional_Indicator}` | the runtime's Unicode version                                                                                                                  | `icu_properties` lookups in hand-written scanners (no regex engine on these paths)                                                                                                                         | `text-similarity.json`, `unicode-text` |
| J-27 | **the Unicode version itself**                                                                                                                                                                                                                         | TypeScript follows Node's ICU, so today's results for characters assigned in recent Unicode versions already differ between Node 22, 24 and 26 | Rust pins one Unicode version for all ICU4X crates and records it in `kgdiff --version`. The corpus only uses characters whose properties are stable since Unicode 13, so it holds on every supported Node | `conformance/README.md`                |

#### 4.5 Regular expressions

The compute packages contain about 114 regular-expression literals (core 12, formats 51 plus
four built with `new RegExp`, layout 4, CLI 43; counted with the TypeScript parser). The port does
not translate them mechanically: hot paths (`text.ts`, `detect.ts`, `xml.ts`, the JSON error
locator) become hand-written scanners, and the rest become `regex` patterns reviewed one by one
against this list.

| ID   | JavaScript semantics                                                                                                                                                                                       | Rust `regex` default                                  | Port                                                                                                  |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| J-41 | `\d`, `\w`, `\b` are ASCII, also with the `u` flag                                                                                                                                                         | Unicode                                               | `[0-9]`, `[0-9A-Za-z_]`, or `(?-u:\b)`                                                                |
| J-42 | `\s` is J-17's set                                                                                                                                                                                         | Unicode White_Space                                   | an explicit class                                                                                     |
| J-43 | `.` excludes `\n`, `\r`, U+2028, U+2029                                                                                                                                                                    | excludes `\n` only                                    | `[^\n\r\u{2028}\u{2029}]`                                                                             |
| J-44 | `i` without `u`: case-insensitivity by `toUpperCase` of single characters (the Kelvin sign U+212A does not match `k`)                                                                                      | Unicode simple case folding (it matches)              | ASCII-only patterns use `(?i-u)`; the few others are rewritten without `i`                            |
| J-45 | lookahead / lookbehind: `\B(?=(\d{3})+(?!\d))` (thousands separators, `core/i18n.ts:94`, `cli/locale.ts:42`), `^0+(?=.)`, `(?=\d)` and `(?<!…)` in Markdown escaping and `width.ts:120`, `split(/(?<= )/)` | unsupported                                           | plain code (they are all small); no `fancy-regex`                                                     |
| J-46 | sticky `y` lexers (`detect.ts:365`, `formats/json.ts:96–97`, `xml.ts:71`, `xml.ts:73` with `'uy'`) and stateful `lastIndex` on `g` regexes                                                                 | no `lastIndex`                                        | anchored searches at an offset (`regex-automata` `Input::anchored`), or scanners                      |
| J-47 | `replace` patterns `$1`, `$&`, `$<name>`; `split` with capture groups includes the captures                                                                                                                | `$1a` is the group named `1a`; `split` drops captures | `${1}` always; splitting written out                                                                  |
| J-48 | `\p{…}` follows the runtime's Unicode version (J-27)                                                                                                                                                       | the `regex` crate's own tables                        | property classes go through `icu_properties` (J-26) rather than `regex`'s tables, to keep one version |

#### 4.6 Math and floating point

| ID   | Where                                                                                                                                              | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Port                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| J-31 | `Math.log2` in **core** matching: neighbour weights `1 / log₂(2 + degree)` (`match.ts:143`), IDF weights `1 / log₂(1 + postings)` (`match.ts:271`) | not correctly rounded. Rust's `f64::log2` (Apple libm here) differs from V8 on **439 of the integers 1…2,000,000** (the first is 1375). Scores are rounded to 1e-6, so a flip is rare, but IDF weights also order candidates, and a different candidate list changes matches. V8's `Math.log2` is its port of FreeBSD's `e_log2.c` (fdlibm), the same on every OS                                                                                                                                                                                                                                                 | **D-1:** before phase 2, TypeScript's matching switches to the layout's `log2` (`layout/src/math.ts`: exact operations only, accurate to ~1e-15), which moves to `@kgdiff/core` so both packages share it; `js::math::log2` ports it with the same operation order, and `log2.json` then pins that function instead of V8's `Math.log2`. Never `f64::log2`. Today the vector pins V8's values (explicit values for the hard inputs and a SHA-256 over all integers up to 2²²); a vendored port of V8's `ieee754::log2` would reproduce them, the fallback if D-1 is not taken |
| J-32 | layout                                                                                                                                             | **only `Math.sqrt`, `Math.imul`, `+ − × ÷`, `Math.round`, `Math.floor` / `Math.ceil`, `Math.min/max/abs`** — no `sin`, `log` or `pow` — and the `\|\| 0` idiom (`geometry.ts:52–53`), which maps NaN and `-0` to `0`. The layout writes its own `log₂` from exact operations, its own integer powers and cooling factor (`layout/src/math.ts`), and rotates by eigenvectors. d3-force's `forceSimulation` uses `Math.pow`, `cos` and `sin`, but kgdiff does not use `forceSimulation` (its tick loop is its own); `forceLink` and `forceManyBody` take kgdiff's seeded random through `initialize(nodes, random)` | `f64::sqrt` is correctly rounded on every target; the exact-operation helpers are ported as they are                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| J-33 | `Math.random`                                                                                                                                      | **one call in the repository, in `packages/renderer/dev/main.ts:393`** — the renderer's development page, which picks a random changed node to focus. It is not published and computes no result. No compute package calls it (`CONTRIBUTING.md` forbids it, the layout's PRNG module says so)                                                                                                                                                                                                                                                                                                                    | nothing to port                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| J-34 | `Math.round` (`round6` in core, `round2` in layout, percentages in i18n / CLI, tick counts)                                                        | rounds half up (towards +∞), keeps `-0` (`Math.round(-0.2)` is `-0`), exact for 0.49999999999999994                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `js::math::round`: `floor(x)`, plus one when `x − floor(x) ≥ 0.5`, sign of zero preserved. `f64::round` rounds half away from zero (`-2.5` → `-3`, JavaScript `-2`)                                                                                                                                                                                                                                                                                                                                                                                                           |
| J-35 | `>>> 0`, `\| 0`, `& 0xffff` on doubles (seeds, hash framing)                                                                                       | `ToUint32` / `ToInt32`: truncate, then wrap modulo 2³² (`seed: -1` → 4294967295, `1e20` → 1661992960)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `js::to_uint32` / `to_int32`; `as u32` saturates                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| J-36 | `Math.min` / `Math.max`                                                                                                                            | NaN propagates; `Math.min(0, -0)` is `-0`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `js::math::{min, max}` wherever NaN or signed zero can reach them; `f64::min` ignores NaN                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| J-37 | `Math.imul`                                                                                                                                        | wrapping 32-bit multiply                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `i32::wrapping_mul`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

#### 4.7 Collections, text decoding, errors and time

| ID   | Where                                                   | JavaScript                                                                          | Port                                                                                                                  |
| ---- | ------------------------------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| J-51 | `Map` / `Set` everywhere                                | insertion-ordered iteration; outputs are built by iterating them                    | `IndexMap` / `IndexSet` (§3 rule 1)                                                                                   |
| J-52 | `Array.prototype.sort`                                  | stable since ES2019                                                                 | `sort_by` (§3 rule 2)                                                                                                 |
| J-53 | `TextDecoder(…, { fatal: true })` (`cli/inputs.ts:130`) | strict; **strips a leading BOM** (UTF-8 and UTF-16)                                 | `std::str::from_utf8` / `String::from_utf16` plus explicit BOM stripping; formats strip U+FEFF once more (`stripBom`) |
| J-54 | JSON error positions (`formats/shared.ts:342`)          | line and column in UTF-16 code units; the fallback reason is V8's own error message | count UTF-16 units; the V8 wording in the fallback is not a contract (non-goals)                                      |
| J-55 | `Date#toISOString` (`generatedAt`)                      | `YYYY-MM-DDTHH:mm:ss.sssZ`, milliseconds, UTC                                       | formatted by hand from `SystemTime`; absent with `--reproducible`                                                     |
| J-56 | gzip (`zlib.gunzipSync`, `maxOutputLength`)             | decompression capped at the input limit; reports are gzip-compressed above 512 kB   | `flate2` with a capped reader; compressed bytes differ between encoders, which only affects HTML reports (non-goals)  |

### 5. Module map

#### `@kgdiff/core` (8,261 lines) → `kgdiff-core`

| TypeScript                                                    | Rust                                | Notes                                                                                                                                                 |
| ------------------------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `types.ts` (778)                                              | `model`                             | public types (`serde` derives behind the optional feature); `GraphInput` is read from `js::Value` with `normalize`'s leniency, not serde's strictness |
| `options.ts` (122)                                            | `options`                           | defaults and validation, same messages                                                                                                                |
| `errors.ts` (13)                                              | `error`                             | `KgdiffError { code, message, details }`, the same stable codes; `thiserror`                                                                          |
| `normalize.ts` (728)                                          | `normalize`                         | attribute value sanitizing, duplicate merging by canonical JSON (J-22), parallel-edge keys                                                            |
| `canonical.ts` (251)                                          | `canonical`, `js::object`           | canonical equality and JSON, structural keys, streaming cyrb53 over UTF-16 (J-13)                                                                     |
| `util.ts` (93)                                                | `util`, `js::cmp`                   | UTF-16 order (J-11), `round6` (J-34)                                                                                                                  |
| `text.ts` (377)                                               | `text`                              | NFKC / case / properties via ICU4X, hand-written tokenizer (J-25…J-27, J-45), blocking and name keys (J-12)                                           |
| `match.ts` (603)                                              | `matching`                          | blocking, scoring, assignment, deferral, propagation; `log2` per J-31                                                                                 |
| `merge-split.ts` (527)                                        | `merge_split`                       |                                                                                                                                                       |
| `classify.ts` (278)                                           | `classify`                          |                                                                                                                                                       |
| `edges.ts` (373)                                              | `edges`                             |                                                                                                                                                       |
| `hunks.ts` (300), `order.ts` (359)                            | `hunks`, `order`                    |                                                                                                                                                       |
| `delta.ts` (844)                                              | `delta`                             | emit, check, apply (strict / lenient with `on_skip`), invert                                                                                          |
| `stats.ts` (64)                                               | `stats`                             |                                                                                                                                                       |
| `graph-json.ts` (134)                                         | `graph_json`                        | `graph_to_json`, `hash_graph`                                                                                                                         |
| `json.ts` (479), `consistency.ts` (300), `diff-index.ts` (59) | `transport`, `consistency`, `index` | `diff_to_json` / `diff_from_json` with every consistency check                                                                                        |
| `packed.ts` (205)                                             | `packed`                            |                                                                                                                                                       |
| `i18n.ts` (791)                                               | `i18n`                              | `format_hunk`, `facet_label`, English and Simplified Chinese; the strings stay in sync through the corpus's `titles.json`                             |
| `model.ts` (106), `diff.ts` (272), `index.ts` (205)           | `records`, `pipeline`, `lib.rs`     |                                                                                                                                                       |

External crates: `indexmap`, `foldhash`, `ryu-js`, `icu_normalizer`, `icu_casemap`
(with `icu_locale_core` for its root locale), `icu_properties`, `thiserror`; `serde` behind the
optional feature `serde` (§4.1). `foldhash` is the hasher of every map (zlib licence): its
seeding is fixed per process and none of its results reach an output. Ordered maps keep
insertion order, and `js::Lookup`, the only unordered one, has no iteration API (§3, rule 1). Its
speed matters for the native targets of §7. No `serde_json` and no `libm`:
kgdiff's JSON is its own ([§4.1](#41-numbers-and-json)) and no result uses a transcendental
function (§3). Development: `proptest` (the fast-check properties, ported), `divan` (benchmarks),
`serde_json` and `cargo-fuzz` (the oracle and the fuzzer of `js::json`).

#### `@kgdiff/formats` (6,606 lines) → `kgdiff-formats`

| TypeScript                                 | Rust              | Library                            | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------ | ----------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| n3 2.13 (Turtle, N-Triples, N-Quads, TriG) | `turtle`          | **`oxttl`** (`rdf-12` feature)     | Verify in the phase 3 spike: relative IRIs without a base must stay relative as written (n3 keeps them; Oxigraph's parsers validate IRIs, so this may need its lenient mode or a fallback); RDF 1.2 annotations (`{\| \|}`); literal lexical forms kept as written                                                                                                                                                                    |
| `rdfxml.ts` (633) + `xml.ts` (550)         | `rdfxml`          | **`oxrdfxml`** (on `quick-xml`)    | kgdiff-specific behaviour around it: entity expansion from the internal DTD with a cap, no external entities, exclusive-canonical XML for `rdf:parseType="Literal"`, the OWL/XML and GraphML conversion hints. If `oxrdfxml` cannot reproduce the corpus, port kgdiff's reader (1,200 lines) on `quick-xml` instead                                                                                                                   |
| `jsonld.ts` (1,376)                        | `jsonld`          | **`oxjsonld`**, or a port          | kgdiff's reader is a full JSON-LD 1.1 expansion with kgdiff's choices (relative IRIs kept, `@direction` dropped, synchronous `documentLoader`, depth limit 200, `jsonld-unmapped-terms` warning). Use `oxjsonld` only if it reproduces the corpus; otherwise port `jsonld.ts`, which has no dependencies                                                                                                                              |
| `rdf.ts` (1,181)                           | `rdf`             | `oxrdf` terms                      | the quad → `GraphInput` mapping (labels by language, blank-node skolemization, OWL restrictions, annotation folding): kgdiff's own semantics, ported line by line                                                                                                                                                                                                                                                                     |
| `obo.ts` (557)                             | `obo`             | **own parser**                     | `fastobo` (no release since October 2025) was evaluated: it implements the OBO 1.4 grammar strictly, while kgdiff reads real-world files leniently with warnings (`obo-unknown-stanza`, `obo-missing-value`, `obo-unquoted-def`, …), merges duplicate stanzas and maps `alt_id` to `replaces`. A strict parser would reject files that kgdiff 0.x reads. Port the 557 lines; use `fastobo` only as a test oracle on well-formed files |
| `json.ts` (889)                            | `json`            | `kgdiff_core::js::json` (§4.1)     | the six dialects, `fields` overrides, ignored-field warnings, depth limit 1000                                                                                                                                                                                                                                                                                                                                                        |
| `detect.ts` (435)                          | `detect`          | —                                  | scanners instead of sticky regexes (J-46)                                                                                                                                                                                                                                                                                                                                                                                             |
| `iri.ts` (86), `prefixes.ts` (195)         | `iri`, `prefixes` | `oxiri` where resolution is needed | well-known prefixes, OBO PURL rule, longest-namespace compaction                                                                                                                                                                                                                                                                                                                                                                      |
| `shared.ts` (408)                          | `shared`          | —                                  | `AttrBag`, typed literals (J-07, J-08), blank-node hashing (J-13), BOM, line / column (J-54)                                                                                                                                                                                                                                                                                                                                          |

#### `@kgdiff/layout` (3,476 lines + d3-force + d3-quadtree) → `kgdiff-layout`

| TypeScript                                                                   | Rust                                              | Notes                                                                                                                                                   |
| ---------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`, `layout.ts`, `options.ts`, `result.ts`, `json.ts`                | `lib.rs`, `pipeline`, `options`, `result`, `json` | layout JSON version 2 (§2)                                                                                                                              |
| `scope.ts`, `union.ts`, `graph.ts`, `components.ts`                          | `scope`, `union`, `graph`, `components`           | combinatorial: pinned by `layout-contract.json`                                                                                                         |
| `init.ts`, `engine.ts`, `simulate.ts`, `extend.ts`, `pack.ts`, `geometry.ts` | same names                                        |                                                                                                                                                         |
| `forces/params.ts`, `springs.ts`, `collide-rect.ts`, `free-spot.ts`          | `forces::*`                                       | the rectangle collision keeps its explicit-stack quadtree traversal                                                                                     |
| `math.ts`, `prng.ts`, `text-metrics.ts`                                      | `math`, `prng`, `text_metrics`                    | exact helpers (J-32), mulberry32 / FNV over UTF-16 (J-13, J-35); `estimate_label_width` must equal TypeScript's (the scene uses it): `label-width.json` |

**d3-force port scope.** kgdiff uses three pieces of d3, about 400 lines of Rust:

- `forceLink` with per-link distance and strength, the degree-based bias
  `count[s] / (count[s] + count[t])`, one iteration per tick, and `jiggle` on zero-length links;
- `forceManyBody`: Barnes–Hut with θ² = 0.81 (θ = 0.9), `distanceMin² = 1`, `distanceMax² =
  chargeRange²`, per-node strengths, the `visitAfter` accumulation of strength-weighted centres and
  the `visit` application, coincident points in leaf lists, `jiggle` for coincident points;
- `d3-quadtree`: `addAll` (extent, `cover`, insertion), `visit`, `visitAfter`, `extent`, used by the
  many-body force, the anchored window query (`engine.ts`) and the rectangle collision.

Not ported: `forceSimulation` (with its `Math.pow` default decay and its `cos` / `sin` phyllotaxis
initialization), `forceCenter`, `forceCollide`, `forceX/Y`, `forceRadial`, d3-timer, d3-dispatch.
Since byte equality with d3 is not required, the quadtree is an arena with structure-of-arrays
storage; the order of floating-point operations only has to be fixed within Rust.

#### `@kgdiff/cli` (4,440 lines) → `kgdiff` and `kgdiff-report`

| TypeScript                                                                                     | Rust                                                       | Library                                                                                   | Notes                                                                                                                                               |
| ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bin.ts`, `main.ts`, `version.ts`                                                              | `kgdiff::{main, cli::run}`                                 | —                                                                                         | exit codes 0 / 1 / 2, `DEBUG=kgdiff` backtraces                                                                                                     |
| `args.ts` (632), `help.ts` (296)                                                               | `kgdiff::args`, `help`                                     | `lexopt`                                                                                  | not `clap`: optional option values (`--json [file]`, `--json=-x.json`), `--no-*` pairs, kgdiff's own messages and help layout must stay as they are |
| `diff-command.ts`, `apply-command.ts`                                                          | `kgdiff::commands`                                         | —                                                                                         |                                                                                                                                                     |
| `inputs.ts` (269)                                                                              | `kgdiff::inputs`                                           | `flate2`                                                                                  | gzip with an output cap, UTF-16 by BOM, strict UTF-8, `KGDIFF_MAX_INPUT` (J-53, J-56)                                                               |
| `io.ts`, `node-io.ts`, `output.ts`, `overwrite.ts`                                             | `kgdiff::io`, `output`, `overwrite`                        | `tempfile` (atomic replace), `same-file` ((device, inode) / Windows file index), `opener` | the `CliIO` seam stays a trait, so tests run in memory as today                                                                                     |
| `style.ts` (164), `errors.ts` (157)                                                            | `kgdiff::style`, `errors`                                  | `std::io::IsTerminal`, `terminal_size`                                                    | `NO_COLOR`, `FORCE_COLOR`, `COLORTERM`, `TERM`, `COLORFGBG`                                                                                         |
| `summary.ts` (563), `model.ts` (294), `markdown.ts` (235), `locale.ts` (299), `width.ts` (222) | `kgdiff-report::{summary, model, markdown, locale, width}` | `icu_segmenter`, `icu_properties`                                                         | the text outputs; pinned by the corpus's CLI runs                                                                                                   |
| `html.ts` (146), `report.ts` (103)                                                             | `kgdiff-report::html`                                      | `flate2`, `base64`                                                                        | the viewer bundles are embedded at build time (`include_str!` of `crates/kgdiff-report/assets/*`, copied from the viewer build; §8, build order)    |

### 6. API changes and versions

#### WebAssembly and the asynchronous `diff`

`@kgdiff/compute` must be initialized before use: the `.wasm` file is fetched (browsers),
read (Node) or decoded from an inlined copy (HTML reports), and compiled. Compilation is
asynchronous by necessity — browsers refuse to compile large modules synchronously on the main
thread — so the JavaScript API becomes:

```ts
import { diff } from '@kgdiff/core'; // 1.0
const result = await diff(before, after, options); // was synchronous in 0.x

import { init, diffSync } from '@kgdiff/compute'; // for hot loops and workers
await init(); // once; idempotent
const r = diffSync(before, after, options);
```

`matchNodes`, `textSimilarity`, `parseGraph`, `detectFormat`, `layoutDiff` and `extendLayout`
follow the same pattern; the read path (§1) stays synchronous. Changing the signature of
`diff` breaks every caller, so this is **kgdiff 1.0**, released with phase 5. `@kgdiff/core` has
about 1,000 downloads a month and the repository 46 stars: the cost of a clean break is small now
and only grows, and pre-1.0 is the time to make it. Phases 2 and 3 change no TypeScript API;
phase 4 removes the JavaScript exports of `@kgdiff/cli` when its npm package becomes the native
launcher (a breaking minor, allowed before 1.0 by [releasing.md](../releasing.md)).

#### npm package names

| Package                     | Through phase 4                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 1.0 (phase 5)                                                                                                                                                                                                                                                                                        |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@kgdiff/core`              | TypeScript, unchanged                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | model, read path and i18n, synchronous as today (`normalize`, `hashGraph`, `diffFromJSON`, `applyDelta`, …) + asynchronous `diff`, `matchNodes` and `textSimilarity` delegating to `@kgdiff/compute` (loaded with a dynamic `import()`, so bundles that only read reports never include WebAssembly) |
| `@kgdiff/formats`           | TypeScript, unchanged                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | asynchronous `parseGraph` / `detectFormat` over `@kgdiff/compute`; deprecated in favour of `@kgdiff/compute`, removed in 2.0                                                                                                                                                                         |
| `@kgdiff/layout`            | TypeScript; reads layout version 2 before phase 4                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | model, JSON, `nodeRadius`, `estimateLabelWidth` (synchronous) + asynchronous `layoutDiff` / `extendLayout` over `@kgdiff/compute`                                                                                                                                                                    |
| `@kgdiff/compute`           | new in phase 5 (preview releases from phase 2)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | the WebAssembly engine: `init`, synchronous functions after `init`, JSON-in / JSON-out low-level API, TypeScript types                                                                                                                                                                               |
| `@kgdiff/cli`               | **phase 3:** unchanged TypeScript (the Rust binary ships on the native channels of §8). **Phase 4:** a launcher that runs the native binary from an optional per-platform package (`@kgdiff/cli-darwin-arm64`, `-linux-x64-gnu`, `-linux-x64-musl`, `-linux-arm64-gnu`, `-win32-x64`, `-win32-arm64`, …; the esbuild / Biome pattern), so `npx @kgdiff/cli` and the GitHub Action keep working. The CLI's JavaScript exports (`renderSummary`, `renderMarkdown`, `buildReportHtml`, …) are removed then; `kgdiff-report` replaces them for Rust, `@kgdiff/compute` for JavaScript if asked for | unchanged                                                                                                                                                                                                                                                                                            |
| scene, renderer, viewer, g6 | unchanged; the viewer accepts layout-less payloads (§2)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | the compute add-on is built on `@kgdiff/compute`                                                                                                                                                                                                                                                     |

Names to reserve before phase 2 ([D-6](#open-decisions)): the crates `kgdiff`, `kgdiff-core`,
`kgdiff-formats`, `kgdiff-layout` and `kgdiff-report` (free on crates.io when this RFC was
written), `@kgdiff/compute` and the npm platform packages (free, in the existing scope), and a
Python distribution name: **`kgdiff` is taken on PyPI** by an unrelated project (KGDiff 0.1.2),
so the recommendation is `pykgdiff` (free). The Homebrew tap `iiwish/homebrew-tap` exists.

#### Rust and Python APIs

The crates mirror the TypeScript contracts with Rust names (`diff`, `normalize`, `hash_graph`,
`DiffResult`, …) and add JSON-text entry points (`diff_json(before, after, options) -> String`)
that the bindings use. They follow semver from their first release, with the shared version
number. The Python package (distribution and import name `pykgdiff`, D-6) exposes
`pykgdiff.parse`, `pykgdiff.diff` (returning an object with `to_json()`, `delta`,
`summary(locale=…, width=…)` and `markdown()`), `pykgdiff.apply` and `pykgdiff.hash_graph`, as
abi3 wheels for CPython ≥ 3.10, plus the CLI as `python -m pykgdiff` and a `kgdiff` console
script.

#### Migration guide (written with phase 5)

`docs/guide/migrating-to-1.0.md`, in English and Chinese, covering:

1. `await` in front of `diff`, `matchNodes`, `textSimilarity`, `parseGraph`, `detectFormat`,
   `layoutDiff` and `extendLayout`; or `await init()` once and the `*Sync` functions of
   `@kgdiff/compute`. Everything else (`normalize`, `hashGraph`, `applyDelta`, `invertDelta`,
   the JSON transports, `formatHunk`) stays synchronous. A table of every changed signature, and a
   search-and-replace recipe.
2. Workers: initialize in the worker; pass `diff.v1` JSON text between threads rather than
   `DiffResult` objects.
3. Bundlers: how the `.wasm` file is located (`new URL('…', import.meta.url)` works in Vite,
   webpack 5, Rollup, esbuild with a loader, Node ≥ 22); serving `application/wasm`.
4. Content Security Policy: WebAssembly needs `'wasm-unsafe-eval'` in `script-src`.
5. Layouts: positions differ from 0.x for the same input; the layout document is version 2;
   stored 0.x positions remain valid pins.
6. `@kgdiff/formats` deprecation, `@kgdiff/cli` no longer a JavaScript library (since the 0.x
   release of phase 4), what replaces each function.
7. What does not change: every JSON document, hash, summary and delta is byte-identical; error
   codes are the same; the viewer's API is unchanged.
8. Support: 0.x receives security fixes for six months after 1.0.

### 7. Size and performance budgets

The budgets in [architecture.md](../architecture.md#budgets) stay; phase acceptance adds Rust
targets. TypeScript numbers are measured on an M-class laptop as the architecture document
specifies; the Rust numbers are targets, to be confirmed by benchmarks (`divan`) in each phase.

| What                                                | Budget today (TS)                | Rust target (native)    | WebAssembly target (Node / Chrome)                        |
| --------------------------------------------------- | -------------------------------- | ----------------------- | --------------------------------------------------------- |
| `diff`, exact ids, 10k nodes / 30k edges            | < 150 ms                         | < 40 ms                 | < 80 ms, < 150 ms including the transport to `DiffResult` |
| `diff`, exact ids, 100k nodes / 300k edges          | < 2 s                            | < 500 ms                | < 1 s, < 2 s including the transport                      |
| `normalize` memory, 100k nodes / 300k edges         | < 135 MB retained heap (~111 MB) | < 50 MB resident growth | < 80 MB linear memory                                     |
| similarity matching, 5k unmatched on each side      | < 1.5 s                          | < 400 ms                | < 800 ms                                                  |
| `layoutDiff`, 2k nodes                              | < 800 ms (~0.6–0.7 s)            | < 250 ms                | < 450 ms                                                  |
| parsing 50k triples (Turtle)                        | "well under a second"            | < 100 ms                | < 250 ms                                                  |
| CLI start-up (`kgdiff --version`, warm)             | ~50 ms (Node 24, measured)       | < 5 ms                  | —                                                         |
| CLI, enterprise-kg summary end to end (warm)        | ~100 ms (measured)               | < 20 ms                 | —                                                         |
| `kgdiff` binary (stripped, viewer bundles included) | —                                | < 12 MB                 | —                                                         |

**What WebAssembly buys in the browser is not speed.** For a large diff the transport to a
`DiffResult` — `diff.v1` JSON text, `JSON.parse`, `diffFromJSON` with its consistency checks —
costs about as much as the diff itself, so the WebAssembly targets including it are simply
today's TypeScript budgets, and phase 5 has to hold them, not beat them. The browser gains one
implementation and the same bytes as the CLI in every engine; native speed is the gain of the CLI,
the crates and the Python package.

Sizes in the browser, measured on `main` as of 2026-11-07 (`pnpm build`, gzip level 9; "kB" here is
KiB, 1,024 bytes, as `packages/viewer/test/standalone.test.ts` computes it):

| Artifact                                                             | Today                                                    | Budget after phase 5                                               |
| -------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------ |
| viewer standalone bundle (`kgdiff-viewer.js`)                        | 374.2 kB min, 116.3 kB gzip                              | **unchanged budget: < 130 kB gzip**; no WebAssembly in it, ever    |
| compute add-on, diff + layout (`kgdiff-viewer-compute.js`)           | 97.4 kB min, 33.9 kB gzip (TypeScript)                   | split in two, below                                                |
| ↳ layout-only WebAssembly (`layout.wasm` + glue), inlined in reports | —                                                        | < 45 kB gzip                                                       |
| ↳ full engine (`compute.wasm`: core + layout, no parsers)            | —                                                        | < 250 kB gzip; loaded on demand (playground, `load()` with graphs) |
| ↳ parsers (`formats.wasm`)                                           | not bundled today (`@kgdiff/formats` imported on demand) | < 200 kB gzip; loaded only for text input                          |
| HTML report overhead without data or compute add-on                  | < 135 kB gzip (budget)                                   | unchanged                                                          |

**Why the split.** A report laid out around its changes inlines the compute add-on only so that
collapsed groups can be expanded, which needs `extendLayout` and nothing else. Inlining the whole
engine — ICU normalization data alone is tens of kilobytes — would make such reports grow by
several hundred kilobytes, base64-encoded. `kgdiff-layout` needs no Unicode tables beyond the
label-width classes and no JSON parser if its WebAssembly interface takes typed arrays (indices,
degrees, label widths, pins), so it compiles to a module about as small as today's TypeScript
add-on. Size is tracked in CI from phase 2 on (`wasm-opt -Oz`, `twiggy` reports on regressions).

### 8. CI and release

#### Two toolchains in CI

- The existing `check` job (Node 22 / 24 / 26 on Linux, Node 24 on Windows and macOS) stays and
  runs the corpus check as part of `pnpm test` from phase 1 on; after `pnpm build` it replays
  the corpus's CLI runs with the built CLI as a real process (`pnpm conformance:replay`).
- A `rust` job (Linux, macOS, Windows; stable and the MSRV): `cargo fmt --check`,
  `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace` (unit,
  property and corpus tests), `cargo deny check`, `cargo doc --no-deps -D warnings`.
- A `wasm` job: build `wasm32-unknown-unknown` with `wasm-bindgen` and `wasm-opt`, check sizes,
  run the corpus in Node 22 and 24 against the WebAssembly build, and run the viewer tests with the
  WebAssembly compute add-on.
- A `targets` job (from phase 4): hash the outputs of every corpus case, layouts included, on
  x86-64 Linux, AArch64 macOS, x86-64 Windows and WebAssembly; all hashes must be equal.
- Until phase 5 retires the TypeScript compute code, a nightly `differential` workflow generates
  random graph pairs (seeded, with the generator in `scripts/gen-synthetic.ts` and a proptest
  strategy) and compares the TypeScript and Rust outputs byte for byte; a mismatch becomes a
  corpus case with its fix.
- `CI passed` (the one required check) depends on every job. Actions stay pinned by commit SHA:
  `dtolnay/rust-toolchain`, `Swatinem/rust-cache`, `PyO3/maturin-action`.
- Contributors who only touch the viewer need no Rust toolchain until phase 5; from then on the
  workspace can use a prebuilt `@kgdiff/compute` from npm, or build it (`pnpm build:compute`).
- **Build order.** The Rust CLI embeds the viewer bundles. `pnpm build:viewer-assets` (to be added
  with phase 3) copies `packages/viewer/dist/standalone/*.js` into `crates/kgdiff-report/assets/`
  (git-ignored, included by `cargo package`), so the `rust` job and the release build run the viewer
  build first. A `cargo build` without the assets still builds and passes every test except the HTML
  ones; `kgdiff -o` then fails with an error that names the missing step (feature `embed-viewer`, on
  in release builds).

#### One version, four registries

The single version number stays: kgdiff `X.Y.Z` names one consistent set of npm packages,
crates, the Python package and the binaries. Changesets stays the source of truth;
`pnpm version-packages` also runs `scripts/sync-versions.ts`, which writes the version into the
workspace `Cargo.toml`, `crates/kgdiff-python/pyproject.toml` and the npm platform packages, and a
test fails if any of them differs (as `CITATION.cff` is checked today).

`release.yml` builds everything before publishing anything:

1. **Build** (matrix): `dist` builds the binaries (x86-64 / AArch64 Linux gnu and musl, macOS,
   Windows) with SHA-256 checksums and GitHub build-provenance attestations; `maturin` builds the
   wheels; the WebAssembly packages and the npm platform packages are assembled; every registry
   gets a dry run (`cargo publish --dry-run`, `npm publish --dry-run`, `twine check`).
2. **Publish**, with trusted publishing (OIDC) everywhere: crates.io (`kgdiff-core`, then
   formats, layout, report, `kgdiff`), npm (platform packages before `@kgdiff/cli`, then the
   rest through `changeset publish`, with provenance), PyPI, and the GitHub release with the
   binaries. Then `dist` updates the formula in `iiwish/homebrew-tap`
   (`brew install iiwish/tap/kgdiff`); homebrew-core once the project meets its notability rules.
3. A registry that fails after others succeeded cannot reuse the version; the remedy is a patch
   release, and the order above puts the registries most likely to reject a package first.

With phase 4 the GitHub Action switches from `npx @kgdiff/cli` to downloading the release binary
for the runner (checksum-verified), which removes the npm install from every run. Its `version`
input takes a version, a range or a tag today (handed to npx); the action resolves it against the
npm dist-tags and versions of `@kgdiff/cli`, which keep naming the same releases.

### 9. Phased plan

Every phase ends in a release (or, for phase 1, a merged change) that leaves kgdiff better off
on its own.

#### Corpus ownership

The corpus is generated from the reference implementation, and the reference moves to Rust one
part at a time, never before the Rust part reproduces the corpus as it stands. Behaviour changes
land in the owner first and in the other implementation in the same pull request (or as a failing
case with an issue).

| Phases | Owner and generator                                                                                                                                                                                                 | TypeScript check in `pnpm test`                                                                                                                                                                                                                                                                                                                                              |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1–3    | TypeScript: `pnpm conformance:update` generates everything                                                                                                                                                          | regenerates everything in memory, byte for byte (today's check)                                                                                                                                                                                                                                                                                                              |
| 4      | split: the TypeScript CLI is deleted, so `cargo xtask conformance` (Rust) writes what the CLI produced — the CLI runs, `report.json` — and the layout contract; the TypeScript generator writes the library outputs | regenerates the library outputs; reads the CLI runs, `report.json` and the layout contract as given                                                                                                                                                                                                                                                                          |
| 5      | Rust: `cargo xtask conformance` generates everything; `pnpm conformance:update` is removed                                                                                                                          | checks what TypeScript keeps against the files: `normalize` and `graphToJSON` from `parse.*.json` → `graph.*`; `hashGraph` → `hashes`; `diffFromJSON` then `diffToJSON` → `diff.json`; `packDiffJSON` / `unpackDiffJSON`; `applyDelta` → `apply.json`; `invertDelta`; `formatHunk` → `titles`; `predicateLabel`, `estimateLabelWidth`, `nodeRadius` and `facetLabel` vectors |

Before phase 4 deletes the CLI sources, the TypeScript generator drops every `@kgdiff/cli`
import: `readInput` / `parseInput` (input decoding, which README step 1 specifies) move into the
generator; `main`, `cliVersion` and the `CliIO` type go with the CLI runs and `report.json`
(which the generator reads from a report `main` writes) to the Rust generator.

#### Phase 1 — Conformance corpus (this change)

Deliverables: [`conformance/`](../../conformance/README.md) — inputs, options and the expected
outputs of the current TypeScript implementation for every case, primitive vectors for the
JavaScript built-ins in §4, a README that specifies the format for any implementation, the
generator (`pnpm conformance:update`), a check that runs in `pnpm test`, and a replay of the
recorded CLI runs with the built CLI as a real process (`pnpm conformance:replay`, in CI after
the build).

As delivered: 29 cases (the six example datasets and 23 written for the corpus) with 255 recorded
CLI runs, 12 of them error paths (exit code 2); 10 primitive vector files (1,070 doubles formatted
four ways, 52 strings converted to numbers, 1,088 `log2` values plus a digest over 2²² inputs, 299
strings in sort order, 61 similarity pairs, …); 635 files, 6.2 MB, of which the 600-node synthetic
case is 2.4 MB. Every recorded graph, diff, packed diff and delta validates against its JSON
Schema. Regenerating takes about a second; the check a few seconds (60 tests); the replay of the
255 runs about six seconds on an M-class laptop.

Acceptance:

- The cases cover the example datasets; id matching with replacement declarations (`replaces`,
  `replacedBy`); similarity matching; merges, splits, moves and rekeys; self-loops; labels outside
  the Basic Multilingual Plane; large and small numbers in attribute values; integer-like keys;
  every input format and JSON dialect; gzip, UTF-16LE / BE and stdin input; both locales; kgdiff's
  own error paths.
- `pnpm test` regenerates every expected file in memory and finds it byte-identical on every CI
  platform (Node 22, 24, 26; Linux, Windows, macOS).
- Every recorded CLI run, replayed with the built `kgdiff` as a real process, gives the recorded
  stdout, stderr and exit code on every CI platform.
- The generator changes no existing output and no package; it only writes under `conformance/`.

#### Before phase 2: a TypeScript 0.x release

The port starts from a reference that no longer has the behaviours the review found it should not
copy. One TypeScript 0.x release, each change with its corpus update in the same pull request:

1. **Exact `log₂` in matching** ([D-1](#open-decisions)): `log2` moves from `@kgdiff/layout`'s
   `math.ts` to `@kgdiff/core`, matching's weights use it, and `log2.json` pins it. The corpus
   update shows the matches it moves, if any.
2. **A read path independent of the browser's Unicode version** ([§11](#11-known-issues-outside-this-rfc)):
   `diffFromJSON` takes snapshot labels, aliases and types as normalized and checks them by
   content hash instead of normalizing them again with the runtime's ICU.
3. **Lone surrogates rejected** with `invalid-input` ([D-2](#open-decisions)) and **non-finite
   numbers in kgdiff JSON warned about and kept** as `"Infinity"` / `"-Infinity"`
   ([D-11](#open-decisions)), with corpus cases for both.
4. **Additive reader changes:** the viewer's layout-less payloads ([D-5](#open-decisions)) and
   `layoutFromJSON` reading layout version 2 ([§2](#2-contract-boundary)), so that every viewer
   released from then on reads what phases 3 and 4 write.
5. The `ignoreAttrs` / `kgdiff apply` decision of §11, if it is made by then.

Phase 2 may start once items 1 and 2 are merged on `main` (they are: d01c4e0 and 7586808); they
are released together with phase 2, as kgdiff 0.7.0. The others may come in a later 0.x release:
item 4 at the latest with phase 2, items 3 and 5 before phase 3.

#### Phase 2 — `kgdiff-core`

Deliverables: the crate with the JS-compatibility layer (`kgdiff_core::js`, its JSON reader and
writer included); a `kgdiff-core` release on crates.io; a preview `@kgdiff/compute` (core only,
`0.x-preview`) for early adopters; the viewer's layout-less payloads and `layoutFromJSON` reading
version 2, if not shipped [before phase 2](#before-phase-2-a-typescript-0x-release).

Acceptance:

- For every corpus case, from `parse.*.json`'s graph: the bytes files `graph.*.json`,
  `diff.json`, `diff.packed.json`, `delta.json`, `delta.inverse.json` and `apply.json` identical,
  and the value files `issues.json`, `hashes.json` and `titles.json` equal (README, comparison
  modes); every primitive vector except `label-width.json` (a layout vector) passes.
- `diff_from_json(diff_to_json(d))` round-trips; the property tests of `packages/core/test` are
  ported to `proptest` and pass (delta round trips, `diff(A, A)` empty, shuffle invariance).
- The nightly differential run finds no mismatch in 10,000 random pairs.
- Benchmarks meet the native targets of §7.
- The crate's documentation shows, as tested examples, diffing two graphs, checking a delta with
  `apply_delta` and reading a `diff.v1` document.

##### Phase 2 results

Status as of 2026-11-09: `kgdiff-core` is merged
([#51](https://github.com/iiwish/kgdiff/pull/51)) and its performance work is in review
([#56](https://github.com/iiwish/kgdiff/pull/56)).

- **Corpus:** every case and every primitive vector except `label-width.json` passes, 299
  checks in all (`cargo test -p kgdiff-core --test conformance`). `diff_from_json(diff_to_json(d))`
  round-trips. The properties of `packages/core/test` (delta round trips, `diff(A, A)` empty,
  shuffle invariance) are ported to `proptest` and pass. The three documentation examples are
  doc tests.
- **Differential:** two runs, each of 10,000 random pairs plus gen-synthetic pairs of 40 to 400
  nodes, found no mismatch:
  - seed 7: 10,050 pairs, 110,550 outputs;
  - seed 42: 10,040 pairs, 110,440 outputs.

  `.github/workflows/differential.yml` repeats the check every night.
- **Benchmarks** (`cargo bench -p kgdiff-core`, divan). The machine was a macOS M-class laptop
  shared with other builds, so the load average is given with each number:

  | What                              | Native target           | Measured                                                                                         |
  | --------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------ |
  | `diff` 10k / 30k                  | < 40 ms                 | median 29.9 ms (load 11.4)                                                                       |
  | `diff` 100k / 300k                | < 500 ms                | median 471 ms, fastest 450 ms (load 11.4) with #56; about 717 ms (load 7.7) without it           |
  | similarity, 5k unmatched per side | < 400 ms                | median 105 ms (load 11.4)                                                                        |
  | `normalize` memory, 100k / 300k   | < 50 MB resident growth | **not met**: 150 MiB resident growth, 95.6 MB of heap retained (was 362 MiB / 151 MB before #56) |

  The memory target assumed a smaller graph than the TypeScript model the crate mirrors: one
  `Arc<KGEdge>` per edge, `Arc<str>` text and keyed maps. On a 64-bit target that model needs
  about 90 MB for this graph even at its smallest. Reaching 50 MB would take a more compact
  representation (interned ids, edges stored as columns), which is a decision for a later phase.
  With WebAssembly's 32-bit pointers the same model takes roughly half as much, within that
  row's < 80 MB of linear memory (an estimate until `@kgdiff/compute` measures it).
- **Decided along the way:** D-13 (`diff_from_json` stays typed). `foldhash` was added to §5's
  crates. `thiserror` and the `serde` feature were not needed yet.
- **Moved to later:**
  - the crates.io release, the registry names and kgdiff 0.7.0 (the maintainer's);
  - the preview `@kgdiff/compute`, which follows in its own pull request;
  - the native memory target, above;
  - the viewer's layout-less payloads and `layoutFromJSON` version 2, a TypeScript change in
    progress ([before phase 2](#before-phase-2-a-typescript-0x-release), item 4);
  - lone surrogates (D-2), which the corpus leaves out and which phase 3 settles.

#### Phase 3 — `kgdiff-formats`, `kgdiff-report` and the Rust CLI

Deliverables: the parsers, the text outputs and the `kgdiff` binary on the native channels of §8
(GitHub releases, the Homebrew tap, `cargo install kgdiff`; optionally the Python package). npm's
`@kgdiff/cli` and the GitHub Action stay on the TypeScript CLI until phase 4, so the path most
reports are made on today (CI) does not change before Rust can lay graphs out.

HTML reports of the phase 3 binary carry no layout: every report inlines the TypeScript compute
add-on (a plain `<script>`, never compressed: about 97 KiB more per report, where today only
reports with a changes-only layout carry it) and the viewer lays the diff out when the report
opens. This is a deliberate, temporary regression from "opens instantly"
([D-10](#open-decisions)), bounded by the acceptance below; `--no-compute` cannot be honoured
without a layout, so the phase 3 binary rejects it with a usage error that says so.

Acceptance:

- Every corpus case: `parse.*.json` equal as values, `report.json` equal; every CLI run's stdout,
  stderr and exit code identical (error paths included).
- The CLI test suites of `packages/cli/test` (arguments, hardening, overwrite checks, gzip
  bombs, colors, widths, golden snapshots) are ported and pass.
- Reports of the six datasets open and show a laid-out graph within 1 s on an M-class laptop;
  their size grows by at most the add-on.
- A spike decides `oxrdfxml` / `oxjsonld` versus porting kgdiff's readers (§5), by the corpus.
- Start-up and end-to-end targets of §7 met; binary size within budget.

#### Phase 4 — `kgdiff-layout`

Deliverables: the layout crate, layout JSON version 2 and its schema, the Rust CLI writing
complete reports (diff and layout) — from here on Rust produces a whole report by itself. npm's
`@kgdiff/cli` becomes the launcher of the native binary and the GitHub Action downloads it (§6,
§8); the TypeScript CLI is deleted, and the CLI runs, `report.json` and the layout contract of the
corpus move to the Rust generator (corpus ownership above).

Acceptance:

- `layout-contract.json` equal for every corpus case: strategy, scope, the iteration counts of
  union layouts, radii, `hidden`, component membership and order; `label-width.json` passes.
- Properties, for every corpus case and for synthetic graphs up to 10k nodes: every node in scope
  has a finite position rounded to 0.01; no two label boxes overlap (the TypeScript layout's
  invariant tests, ported); anchored mode keeps known positions bit-exact; `extend_layout` moves
  no placed node; shuffled input gives identical bytes.
- Quality against the TypeScript baseline on the datasets and synthetic graphs: mean edge length
  over `linkDistance`, normalized stress, edge crossings, aspect ratio and the distance between
  merge / split partners each within 10% of TypeScript's (or better); a side-by-side screenshot
  review of the six datasets.
- The `targets` job: identical layout bytes on every platform and in WebAssembly.
- Layout targets of §7 met; reports open instantly again and `--no-compute` works as documented.
- The action workflow (`.github/workflows/action.yml`) passes with the binary.

#### Phase 5 — `@kgdiff/compute` replaces TypeScript compute in the browser (kgdiff 1.0)

Deliverables: `@kgdiff/compute` (core, formats, layout; three WebAssembly modules per §7), the
asynchronous facades in `@kgdiff/core`, `@kgdiff/formats` and `@kgdiff/layout`, the compute
add-on and the playground on WebAssembly, the removal of the TypeScript compute modules, the Rust
generator as the corpus's only one, the migration guide, 1.0.0 on every registry.

Acceptance:

- Every corpus case passes against the WebAssembly build in Node, and the TypeScript read path
  passes its part of the corpus (corpus ownership above).
- The viewer bundle stays < 130 kB gzip with no WebAssembly inside; the add-on budgets of §7 hold.
- In-browser diff of 10k nodes / 30k edges, with the module already initialized and including the
  transport to `DiffResult`, within the TypeScript budget (< 150 ms); initialization itself
  (compiling the module from the HTTP cache) < 100 ms.
- The viewer, scene, renderer and G6 test suites pass unchanged; reports open without
  initializing WebAssembly unless a group is expanded.
- Deleted: `match`, `merge-split`, `classify`, `edges`, `order`, hunk partitioning, delta
  emission, the similarity and blocking parts of `text`, every parser, the layout engine and the
  d3 dependencies. Kept, and still checked by the corpus: the read path of §1, including what its
  consistency checks recompute (`computeStats`, `hunkSummary`, `checkDelta`).

### 10. Risks

| Risk                                                                                                               | Likelihood                                                                            | Impact                                                                           | Mitigation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| JavaScript semantics the inventory missed                                                                          | medium                                                                                | high                                                                             | the corpus, the nightly differential run on random graphs until phase 5, every mismatch becomes a corpus case; the `js` module is the only place such rules live                                                                                                                                                                                                                                                                                                                                                                     |
| Unicode version skew (the runtime's ICU in TypeScript, ICU4X in Rust)                                              | high, for new characters                                                              | high where it bites: a report that does not open                                 | one pinned Unicode version in Rust, named in `kgdiff --version` and release notes; corpus restricted to stable characters. The read path must not depend on the browser's ICU: `diffFromJSON` re-applies NFC to snapshot labels (`nodeOf`) and then compares content hashes, so a label whose NFC form differs between the producer's and the browser's Unicode versions makes a report fail to open. Treat snapshot text as already normalized (§11); a TypeScript change [before phase 2](#before-phase-2-a-typescript-0x-release) |
| Oxigraph parsers disagree with n3 / kgdiff's readers (relative IRIs, entities, XML literals, JSON-LD corner cases) | medium                                                                                | medium                                                                           | spike in phase 3 against the corpus; port kgdiff's own readers where needed (they have no dependencies)                                                                                                                                                                                                                                                                                                                                                                                                                              |
| WebAssembly too large for the add-on budgets                                                                       | medium                                                                                | medium                                                                           | layout-only module for reports; parsers in their own module; size checks in CI from phase 2; if needed, the host's `String.prototype.normalize` behind a feature, at the price of J-27                                                                                                                                                                                                                                                                                                                                               |
| In the browser, the JS ↔ WebAssembly transport takes back the Rust speed-up for large diffs                        | high: §7's WebAssembly targets including the transport are today's TypeScript budgets | low: speed is not what the browser gains ([§7](#7-size-and-performance-budgets)) | the budgets hold the line rather than promise a gain; JSON text plus `diffFromJSON` (already optimized for canonical snapshots); a trusted path that skips the consistency checks for output of the same build; if a budget is missed, a binary transport (typed arrays of indices into the two graphs) behind the same API                                                                                                                                                                                                          |
| The read path is implemented twice for good ([§1](#what-stays-in-typescript))                                      | certain                                                                               | medium                                                                           | the corpus checks TypeScript's read path in every `pnpm test` after phase 5 ([corpus ownership](#corpus-ownership)); a change to a kept function lands in both languages in one pull request; the read path stays limited to §1's list and stops depending on the browser's ICU before phase 2                                                                                                                                                                                                                                       |
| Asynchronous initialization breaks the viewer's synchronous `computeNow()` path                                    | medium                                                                                | low                                                                              | the add-on starts compiling as soon as it loads; expanding a group waits for `ready`; tests in phase 5                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Pages with a strict CSP cannot run WebAssembly                                                                     | low                                                                                   | medium                                                                           | documented (`'wasm-unsafe-eval'`); reports do not need it until a group is expanded                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Layout quality regresses                                                                                           | medium                                                                                | medium                                                                           | metrics against the TypeScript baseline and a screenshot review (phase 4 acceptance)                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| The TypeScript engine changes while Rust catches up                                                                | high                                                                                  | medium                                                                           | corpus ownership (§9): a change lands in the owning implementation and the corpus, and in the other one in the same pull request or as a failing case with an issue                                                                                                                                                                                                                                                                                                                                                                  |
| Release across four registries fails half-way                                                                      | low                                                                                   | medium                                                                           | build and dry-run everything first; publish order; patch release as the remedy                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Registry names taken                                                                                               | certain for PyPI `kgdiff` (an unrelated project); the crates are free                 | low                                                                              | `pykgdiff` on PyPI; reserve every name before phase 2 (D-6)                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Phase 3 reports lay out in the browser                                                                             | certain (by design)                                                                   | medium                                                                           | npm and the Action stay on the TypeScript CLI until phase 4; open time and size bounded by phase 3's acceptance; D-10                                                                                                                                                                                                                                                                                                                                                                                                                |
| One maintainer, two toolchains                                                                                     | high                                                                                  | medium                                                                           | phases are independent releases; the corpus makes the port verifiable piece by piece; contributors to the UI need no Rust                                                                                                                                                                                                                                                                                                                                                                                                            |
| More dependencies to trust                                                                                         | medium                                                                                | low                                                                              | `cargo deny` (licenses, advisories, duplicates), committed `Cargo.lock`, minimal features, Dependabot for Cargo                                                                                                                                                                                                                                                                                                                                                                                                                      |

### 11. Known issues outside this RFC

- **`ignoreAttrs` and `kgdiff apply`.** Found while building the corpus: with `--ignore-attr`,
  the delta leaves the changes of ignored attributes out, but `hashGraph` covers every attribute
  and the delta's `target.hash` is the after graph's. Applying the delta to the before graph
  therefore cannot reach the target hash, and `kgdiff apply` warns "The result … differs from the
  delta's target" (`options-ignore-watch` records it). The documented round-trip invariant
  (`hashGraph(applyDelta(A, diff(A, B).delta)) === hashGraph(B)`) silently assumes no ignored
  attributes. Either the delta should carry ignored attributes' changes, or `target.hash` should
  exclude them; a decision for the TypeScript implementation first, then the corpus. The Rust
  port reproduces today's behaviour until then.
- **Numbers beyond the double range vanish.** kgdiff JSON may write `1e400`; `JSON.parse` makes
  it `Infinity`, and the JSON reader drops non-finite numbers without a warning (an attribute or
  `meta` member disappears, an array item becomes `null`; `formats/src/shared.ts:55`). A diff then
  reports nothing for a value that did change, or a change that did not happen. A
  `json-non-finite` warning, or keeping the value as `"Infinity"` as `normalize` does for API
  input, would be better ([D-11](#open-decisions)); the corpus records today's behaviour.
- **The read path depends on the browser's Unicode version.** `diffFromJSON` re-normalizes
  snapshot labels to NFC with the runtime's ICU and checks content hashes against the delta, so a
  report made with Node 24 (Unicode 17) can fail to open in a browser with an older ICU when a
  label holds characters whose canonical composition changed in between. Rare (a handful of
  characters per Unicode release), already possible today, and more likely once Rust pins its own
  Unicode version; see the risk in §10. Fixed in the TypeScript release
  [before phase 2](#before-phase-2-a-typescript-0x-release), which phase 2 waits for.
- **Fit view on high-density displays.** Opening a CLI-generated HTML report in Playwright's
  Chromium with `deviceScaleFactor: 2` frames only one corner of the graph, both on the initial
  view and after "Fit view (F)"; with `deviceScaleFactor: 1` it is correct. Not yet confirmed on a
  real Retina display. The cause is likely a CSS-pixel / device-pixel mix-up in the viewer's
  framing or the renderer's camera; it is unrelated to this RFC and gets an issue of its own.

## Open decisions

| ID   | Decision                                                                                                    | Recommendation                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D-1  | Make `Math.log2` in TypeScript matching exact (like the layout's) before phase 2?                           | **Yes** (revised after review; first recommended no, since a Rust port of FreeBSD's `e_log2.c` equals V8 on every integer up to 2²², Appendix A). The playground runs TypeScript matching in every browser engine until phase 5, so the difference exists now; the change moves a match only where a score sits within ~1e-15 of a rounding boundary or a tie, which the corpus update shows; and the port then copies a short loop of exact operations instead of V8's fdlibm bit for bit |
| D-2  | Lone surrogates from JSON escapes (J-14)                                                                    | Reject with `invalid-input` in Rust and, in a 0.x release before phase 3, in TypeScript too, so that behaviour stays identical; the corpus leaves them out until then                                                                                                                                                                                                                                                                                                                      |
| D-3  | Layout version 2 with `generator`, or keep version 1                                                        | Version 2 (§2); the alternative is silent change of what a stored layout means                                                                                                                                                                                                                                                                                                                                                                                                             |
| D-4  | `kgdiff-report` as its own crate, or a feature of `kgdiff`                                                  | Its own crate (an embedding application depends on it without the CLI's dependencies)                                                                                                                                                                                                                                                                                                                                                                                                      |
| D-5  | Ship the viewer's layout-less payloads before phase 2 or with phase 3                                       | Before phase 2: small and additive; applications that compute diffs themselves can use the viewer at once                                                                                                                                                                                                                                                                                                                                                                                  |
| D-6  | Registry names                                                                                              | Crates `kgdiff`, `kgdiff-core`, `-formats`, `-layout`, `-report` (free); PyPI **`pykgdiff`** (`kgdiff` is taken), import name `pykgdiff`, console script `kgdiff`; the existing tap; reserve now                                                                                                                                                                                                                                                                                           |
| D-7  | Python package in phase 3 or later                                                                          | After the CLI (phase 3), when both parsers and reports exist                                                                                                                                                                                                                                                                                                                                                                                                                               |
| D-8  | MSRV and edition                                                                                            | Edition 2024; MSRV no newer than the stable release of six months before, raised only in minor releases                                                                                                                                                                                                                                                                                                                                                                                    |
| D-9  | `oxrdfxml` / `oxjsonld` or ports of kgdiff's readers                                                        | Decide by the phase 3 spike against the corpus                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| D-10 | Phase 3 reports without a precomputed layout, or swap phases 3 and 4                                        | Keep the order and accept the bounded regression on the native channels only (phase 3); swapping would delay the CLI, the larger win, behind the riskiest port                                                                                                                                                                                                                                                                                                                             |
| D-11 | Non-finite numbers in kgdiff JSON (§11)                                                                     | Warn (`json-non-finite`) and keep them as `"Infinity"` / `"-Infinity"` like `normalize`, in a TypeScript 0.x release with a corpus update, before phase 3                                                                                                                                                                                                                                                                                                                                  |
| D-12 | JSON in Rust: serde_json with `arbitrary_precision` and `preserve_order`, or kgdiff's own reader and writer | Its own, `kgdiff_core::js::json` ([§4.1](#41-numbers-and-json)): Cargo would turn serde_json's two features on in every application that embeds the crates, and kgdiff needs its own number, key-order, duplicate-key, surrogate and error-position rules either way                                                                                                                                                                                                                       |
| D-13 | What `diff_from_json` keeps of a `diff.v1` document                                                         | Decided: typed, only what `diff_to_json` writes. `diff.v1.json` forbids extra members in 32 of its 34 objects; the other two, `stats.facets` and `stats.hunks`, hold counts that the reader checks against the recomputed statistics. A consistent document therefore loses nothing, and the Rust `DiffResult` needs no bag of unknown members.                                                                                                                                            |

## Review

Revised on 2026-11-07, after a review of the design. The conformance corpus was reviewed with it
and fixed in [#41](https://github.com/iiwish/kgdiff/pull/41): `report.json` is read from a report
the CLI writes, and CI replays the recorded runs with the real process.

1. **kgdiff's own JSON reader and writer,** not serde_json with `arbitrary_precision` and
   `preserve_order`, whose features would reach every application that embeds the crates
   ([§4.1](#41-numbers-and-json), D-12).
2. **Each determinism rule says what enforces it** — a type, a lint or a test — instead of "lints
   and CI" for all of them: compared text is a `js::JsStr` ordered by UTF-16 code units, and the
   methods whose defaults differ from JavaScript are disallowed ([Enforcement](#enforcement)).
3. **D-1 reversed:** matching's `log₂` becomes exact in TypeScript before phase 2, so the
   playground is deterministic across engines now and the port needs no bit-exact copy of V8's
   ([J-31](#46-math-and-floating-point)).
4. **The read path is implemented twice for good,** said as such and with a risk of its own; its
   dependency on the browser's Unicode version is removed before phase 2
   ([What stays in TypeScript](#what-stays-in-typescript),
   [Before phase 2](#before-phase-2-a-typescript-0x-release)).
5. **The browser gains determinism, not speed,** from WebAssembly, and the transport risk is rated
   by §7's own budgets ([§7](#7-size-and-performance-budgets), [§10](#10-risks)).

## Alternatives considered

- **Keep TypeScript, ship the CLI as a single executable** (Node SEA, Bun or Deno compile). Removes
  the npm install but not the 50–100 MB runtime or the memory profile, and gives Rust and Python
  users nothing.
- **Port everything, including the scene and the renderer, and draw with WebGPU / Canvas from
  WebAssembly.** The per-frame path is already within budget in JavaScript; moving it adds
  boundary crossings every frame and rewrites the most UI-coupled code for no user-visible gain.
- **Rust core with N-API bindings for Node instead of WebAssembly.** Faster in Node, but needs
  per-platform binaries for every Node consumer and does nothing for browsers; WebAssembly covers
  both. The CLI is native anyway.
- **Byte-identical layout port.** Rejected in [Layout decision](#layout-decision).
- **Embed a JavaScript engine (QuickJS, Boa) in the Rust binary and run today's code.** Keeps
  JavaScript semantics trivially, but defeats the speed, size and embedding goals.

## Appendix A: measurements

Taken on 2026-11-06 with Node 24.15.0 (V8 13.6, ICU 78.3, Unicode 17.0) and rustc 1.95.0 on macOS
(AArch64), `serde_json` 1.0.149 with `preserve_order`.

Numbers through `JSON.parse` + `JSON.stringify` versus `serde_json::from_str` + `to_string`:

| Input                   | JavaScript              | serde_json                                                                             |
| ----------------------- | ----------------------- | -------------------------------------------------------------------------------------- |
| `1.0`                   | `1`                     | `1.0`                                                                                  |
| `1e20`                  | `100000000000000000000` | `1e+20`                                                                                |
| `123456789012345680000` | `123456789012345680000` | `1.2345678901234567e+20` (another double: the default parser is not correctly rounded) |
| `1e-6`                  | `0.000001`              | `1e-6`                                                                                 |
| `-0`                    | `0`                     | `-0.0`                                                                                 |
| `9007199254740993`      | `9007199254740992`      | `9007199254740993`                                                                     |
| `1e400`                 | `null` (`Infinity`)     | error: number out of range                                                             |
| `"\ud800"`              | `"\ud800"`              | error                                                                                  |

Other probes:

- `{"b":1,"10":2,"2":3,"a":4,"b":5}` → JavaScript `{"2":3,"10":2,"b":5,"a":4}`, serde_json
  `{"b":5,"10":2,"2":3,"a":4}`.
- Sorting `["\uFF5E", "\u{1F600}", "\uE000", "a"]` (～, 😀, a private-use character, a):
  JavaScript gives a, U+1F600, U+E000, U+FF5E; Rust a, U+E000, U+FF5E, U+1F600.
- Whitespace: U+FEFF is whitespace for JavaScript's `\s` and `trim`, not for `char::is_whitespace`;
  U+0085 the other way round.
- `log2` of the integers 1 to 2,000,000: Rust `f64::log2` (Apple libm) and V8 `Math.log2` differ in
  439 results, by one unit in the last place (first: 1375, 2750, 3393, 5500, 5755); 796 up to 2²².
  A plain Rust port of FreeBSD's `e_log2.c` (no fused multiply-add) equals V8 on all of them.
- `toFixed`: `(0.25).toFixed(1)` is `0.3` and `(1.25).toFixed(1)` `1.3` in JavaScript;
  `format!("{:.1}", …)` gives `0.2` and `1.2` (ties to even), and `-0` for `-0.0`.

## References

- [architecture.md](../architecture.md), [algorithms.md](../algorithms.md),
  [formats.md](../formats.md), [delta-format.md](../delta-format.md), [cli.md](../cli.md)
- [RFC 0001: Composable viewer components](./0001-viewer-components.md)
- [conformance/README.md](../../conformance/README.md): the corpus format
- ECMAScript: `Number::toString`, `StringToNumber`, `OrdinaryOwnPropertyKeys` (the order of
  object keys), `String.prototype.trim` (WhiteSpace and LineTerminator), `JSON.parse` and
  `JSON.stringify`
