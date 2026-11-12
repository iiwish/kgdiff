---
'@kgdiff/core': minor
'@kgdiff/formats': minor
'@kgdiff/layout': minor
---

**Breaking.** The TypeScript compute code that kgdiff's Rust engine (`@kgdiff/compute`) replaced is removed (RFC 0002, phase 5): about 13,000 lines of source. The asynchronous functions that compute are unchanged, and the read path (`normalize`, `hashGraph`, `diffFromJSON`, `applyDelta`, `formatHunk`, `layoutFromJSON`, …) stays in TypeScript, synchronous.

- `@kgdiff/core`: `log2`, deprecated in the previous change, is removed (use `Math.log2`). The TypeScript matching, classification, hunks, delta emission and similarity are removed; `diff`, `matchNodes` and `textSimilarity` run on `@kgdiff/compute`.
- `@kgdiff/formats`: the TypeScript parsers are removed, and with them the dependency on `n3`. `parseGraph`, `detectFormat`, `compactIri`, `FORMAT_EXTENSIONS` and the types stay; the package remains deprecated in favour of `@kgdiff/compute`.
- `@kgdiff/layout`: the TypeScript layout engine is removed, and with it the dependencies on `d3-force` and `d3-quadtree`.
