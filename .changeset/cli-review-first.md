---
'@kgdiff/cli': minor
---

Changes to definitions are flagged ⚑ for review first. A reworded definition can change what existing data means while the diff looks small, and it used to be folded into `~1 attribute` among the other edits. Now a line under the diffstat bar counts the hunks that change one (`⚑ Review first: definition changed in 9 hunks`, also in `--stat`), each of their rows says so before its summary (`content · ⚑ definition · ~2 attributes`), and the Markdown summary, so the GitHub Action's pull request comment too, lists them in a ⚑ _Review first_ block before the phase groups. By default kgdiff watches `def` (OBO), `definition` (kgdiff JSON), `IAO:0000115` and `skos:definition`; the new `--watch-attr <key>` (repeatable) replaces that list, e.g. `--watch-attr rdfs:comment` for schema.org-style vocabularies. `TextContext` and `MarkdownOptions` take the same list as `watch`, and `DEFAULT_WATCH_ATTRS` and `watchedChanges` are exported.
