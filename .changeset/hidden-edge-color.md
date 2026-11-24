---
'@kgdiff/scene': patch
---

A hidden edge in a frame has a color `parseColor` reads: the color it was last drawn in, or its union-layer color if it has not been drawn yet. Before, an edge that had never been drawn carried an empty string, so a host that parsed every edge's color had to check `visible` first. Nothing is drawn differently.
