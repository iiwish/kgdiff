---
'@kgdiff/core': patch
---

**Rust crates only:** the public API of `kgdiff-core`, `kgdiff-formats`, `kgdiff-layout`, `kgdiff-report` and `kgdiff` is documented on docs.rs: every public type, field, variant and function has a description, functions that return `Result` say what they fail with, and the crate pages and READMEs describe what each crate provides, with an example that runs as a test. `#![warn(missing_docs)]` keeps it that way. No type, signature or behavior changes.
