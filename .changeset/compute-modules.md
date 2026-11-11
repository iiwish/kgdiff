---
"@kgdiff/compute": minor
---

`@kgdiff/compute` is published: kgdiff's Rust engine as three WebAssembly modules, each loaded only when asked for (RFC 0002, §7). `compute` diffs, matches and normalizes graphs, `formats` reads graph files, and `layout` lays diffs out on typed arrays, small enough to be inlined in an HTML report; `@kgdiff/compute/layout` loads that one alone. `init()` loads them (`init({ modules: ['layout'] })` only some), then `diffSync`, `matchNodesSync`, `textSimilaritySync`, `parseGraphSync`, `detectFormatSync`, `layoutDiffSync`, `extendLayoutSync`, `layoutGraphSync`, `layoutDiffOnSync` and `layoutAfterSync` give the objects of `@kgdiff/core`, `@kgdiff/formats` and `@kgdiff/layout`; `diff`, `parseGraph`, `layoutDiff` and the others load their module themselves. `json` is the same on JSON text, byte for byte what the kgdiff CLI writes. The other packages do not use it yet.
