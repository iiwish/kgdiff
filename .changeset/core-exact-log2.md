---
'@kgdiff/core': minor
---

Matching gives the same result in every JavaScript engine. Its neighbour and key weights (`1 / log₂(2 + degree)`, `1 / log₂(1 + postings)`) now use a `log₂` built from exactly rounded operations only, the one the layout already used, instead of `Math.log2`, which engines may approximate differently: V8 ports FreeBSD's `e_log2.c`, while an engine that calls the platform's C library gets that library's rounding (Apple's differs from V8 on 439 of the integers up to 2,000,000). A diff computed in a browser, as the playground does, now equals the CLI's whatever the engine. The new `log₂` differs from V8's by one unit in the last place on about 2% of integers; no match, suggestion or score changes in the conformance corpus, the example datasets or 144 synthetic diffs, but a score that sits exactly on a rounding boundary or a tie can move. The function is exported as `log2`, and `@kgdiff/layout` uses it from core.
