---
'@kgdiff/core': minor
'@kgdiff/cli': minor
---

Deltas now carry the changes of ignored attributes. Breaking before 1.0.

With `ignoreAttrs` (`--ignore-attr`), those changes used to be left out of the delta while its
target hash covered every attribute, so applying the delta could not reach the target and
`kgdiff apply` warned that the result differed. Now `applyDelta(A, diff(A, B).delta)` hashes to
`hashGraph(B)`, and the inverse restores `A`, whatever is ignored.

"Ignored" now means what the diff matches on and shows, and nothing else: ignored attributes
take no part in similarity, and their changes produce no facet, status, count or summary line.

If you read deltas made with `--ignore-attr`: they have more ops than before, at the head of the
delta and in no hunk, and a diff that reports no change can have a non-empty delta, as already
happened for id-only renames under `similarity`. Hunk contents are unchanged, but their `ops`
indices shift by the number of these ops. Deltas made by earlier versions still apply, with the
same warning as before. The delta and diff document versions do not change.
