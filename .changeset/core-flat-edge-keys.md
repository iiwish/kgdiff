---
'@kgdiff/core': patch
---

Normalized graphs take about 30% less memory: a graph of 100k nodes and 300k edges now keeps about 111 MB of heap instead of 157 MB. Structural edge keys were built by concatenation, which V8 stores as a rope of many small strings that stays allocated behind every key; they are now built as flat strings, which are also quicker to hash. Keys, diffs, deltas and their JSON are unchanged, byte for byte.
