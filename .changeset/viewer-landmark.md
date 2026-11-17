---
'@kgdiff/viewer': patch
---

`<kgdiff-viewer>` inside a page's own `<main>` (or `role="main"`) is a region named after the graph, not a second main landmark. A page has one main landmark and they do not nest, so an embedded viewer made a screen reader's list of landmarks say "main" twice, one inside the other. On a page without a main landmark around it, such as an HTML report, the viewer is the main landmark as before. It looks at its ancestors, through slots and shadow roots, when it is connected.
