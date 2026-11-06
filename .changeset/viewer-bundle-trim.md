---
'@kgdiff/core': patch
'@kgdiff/viewer': patch
---

The standalone viewer bundle, which every HTML report inlines, is 0.7 kB smaller (min + gzip):
the viewer keeps its English and Chinese UI strings in one table, and the facet names of
`facetLabel` are no longer bundled with `formatHunk`. Behaviour is unchanged. The bundle's size
ceiling goes from 105 kB to 130 kB, so features no longer need to raise it one by one.
