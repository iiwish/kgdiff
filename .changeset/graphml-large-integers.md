---
'@kgdiff/cli': patch
'@kgdiff/core': patch
'@kgdiff/compute': patch
---

A GraphML or GEXF value of an integer type that is too large for a double to hold exactly, such as `9007199254740993`, is no longer reported as a value of the wrong type (`graphml-invalid-value`, `gexf-invalid-value`). It is still kept as text, so that no digit is lost, and the graph read is the same as before; only the false warning is gone. A value that is not a whole number at all, such as `about 175` for a `long`, still warns.
