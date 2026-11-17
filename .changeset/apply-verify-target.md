---
'@kgdiff/cli': patch
---

`kgdiff apply --verify-target` makes a result that is not the delta's target an error. Without it, `apply` warns when the patched graph's hash differs from the delta's `target.hash`, writes the graph anyway and exits 0, as before. With it, nothing is written, the message gives both hashes and the exit code is 2, as for a graph that is not the delta's base. Together with `--no-strict` the same check applies whether or not operations were skipped, and a delta that names no target is refused, since there is nothing to compare the result with.
