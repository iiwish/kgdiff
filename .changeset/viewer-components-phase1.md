---
'@kgdiff/viewer': patch
---

The viewer's CSS custom properties are renamed from `--kg-*` to `--kgdiff-*`. They are not documented API yet; a page that set one of the old names on `<kgdiff-viewer>` sets the new name instead, and the canvas now follows it too, not only the panels. Styles are one shared constructable stylesheet, parsed once for every viewer on the page, instead of `<style>` elements in each. Inside, `<kgdiff-viewer>` is now built from a headless session and regions bound to it (RFC 0001, phase 1); its attributes, properties, methods, events and HTML reports are unchanged.
