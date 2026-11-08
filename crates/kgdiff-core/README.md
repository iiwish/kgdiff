# kgdiff-core

The diff engine of [kgdiff](https://github.com/iiwish/kgdiff) in Rust: normalizing, matching,
classifying, hunking, deltas, hashing and the JSON transports, written to produce the same bytes
as the TypeScript package [`@kgdiff/core`](https://www.npmjs.com/package/@kgdiff/core).

Work in progress: this is phase 2 of
[RFC 0002](https://github.com/iiwish/kgdiff/blob/main/docs/rfcs/0002-rust-compute-core.md). The
conformance corpus in [`conformance/`](https://github.com/iiwish/kgdiff/tree/main/conformance)
specifies what the crate computes; `cargo test -p kgdiff-core --test conformance` reports which of
its parts pass.

Licensed under the MIT license.
