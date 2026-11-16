---
'@kgdiff/renderer': patch
'@kgdiff/viewer': patch
---

The graph canvas shows its focus ring. The canvas is the viewer's first tab stop, and the viewer's stylesheet draws a ring on it when the keyboard moves focus there, but the renderer set `outline: none` on the canvas inline, which beat that rule: focus on the canvas was invisible. `@kgdiff/renderer` no longer sets an inline outline. A page that uses the renderer on its own and makes the canvas focusable now gets the browser's default ring unless its styles say otherwise.
