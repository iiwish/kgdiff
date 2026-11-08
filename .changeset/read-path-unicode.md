---
'@kgdiff/core': minor
'@kgdiff/viewer': patch
---

Reports open the same way whatever Unicode version the browser has. `diffFromJSON` takes the labels, aliases and types of a document's snapshots as written instead of composing them to NFC again with the runtime's ICU, and the content hashes in the delta check that text: a report made with Node 24 (Unicode 17) no longer fails to open in a browser with older tables when a label holds a character whose composition changed in between, and a snapshot whose text was edited or is not in NFC is still rejected. To restore a label it left out without Unicode tables either, kgdiff JSON (diffs, graphs and deltas) now leaves an edge label out only when it equals `predicateLabel(predicate)` before its NFC step; a predicate whose readable part is written decomposed keeps its label in the document. A diff written by an earlier version for such a predicate, with that label left out, no longer opens: write it again. `normalize` composes API input to NFC as before.
