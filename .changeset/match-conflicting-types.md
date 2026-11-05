---
'@kgdiff/core': patch
'@kgdiff/cli': patch
---

Similarity matching no longer pairs two same-named nodes on their label alone when their types conflict. With `--match similarity` nothing is matched in the first round, so the neighbour evidence was missing for every pair and an equal label outweighed disjoint types: “Mercury” the planet (orbiting the Sun) and “Mercury” the element (with symbol Hg) were reported as one node whose type changed. Such a pair (both nodes typed, no type and no attribute in common, neighbours not matched yet) now waits for the next round, when propagation brings in the neighbours; the two Mercurys share none, so they are reported as removed and added with a possible match below the threshold, as `--match auto` already did. A type change that the neighbours confirm is still matched, and nodes without edges are matched as before.
