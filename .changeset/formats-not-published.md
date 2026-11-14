---
'@kgdiff/core': patch
---

`@kgdiff/formats` is no longer published from 0.12.1 on, and its package is removed from the repository. It has been deprecated since 0.11.1; its releases stay on npm. Import `parseGraph`, `detectFormat`, `compactIri`, `FORMAT_EXTENSIONS` and the parsers' types from `@kgdiff/core` instead (the same functions and types), or use the `*Sync` functions of `@kgdiff/compute`.
