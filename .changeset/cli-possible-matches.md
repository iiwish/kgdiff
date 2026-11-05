---
'@kgdiff/cli': minor
---

The terminal summary and the Markdown summary (so the GitHub Action's pull request comment too) list the possible matches: pairings kgdiff considered but did not apply, between a node listed as removed and one listed as added. Until now only the viewer's detail panel showed them, so "removed “Saudi Aramco”, added “Aramco”" gave no hint that the two may be one entity. Each line names both nodes (with their ids when the names are equal), the score, why it was not applied (below `--threshold`, or too close to another candidate) and the label and neighbourhood evidence, and a closing line says how to pair one: a synonym, a replacement link or a lower threshold. At most 10 in the terminal (all with `--limit 0`) and 20 in Markdown; `--json` keeps every suggestion.
