---
'@kgdiff/core': patch
'@kgdiff/viewer': patch
---

The standalone viewer bundle, which every HTML report inlines, no longer carries the facet names
of `facetLabel`: they are kept apart from the hunk phrasebooks that `formatHunk` reads, which
saves 0.2 kB (min + gzip). Behaviour is unchanged. The bundle's size ceiling goes from 105 kB to
130 kB, so a feature no longer has to raise it.
