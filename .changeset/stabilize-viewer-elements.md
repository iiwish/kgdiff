---
'@kgdiff/viewer': minor
---

The composable viewer elements are stable. RFC 0001 planned this for 0.7; it happens now, in 0.10.
`<kgdiff-root>`, `<kgdiff-stage>`, `<kgdiff-change-list>`, `<kgdiff-change-detail>`,
`<kgdiff-search>`, `<kgdiff-filters>`, `<kgdiff-view-dock>`, `<kgdiff-transport>`,
`<kgdiff-legend>`, `<kgdiff-zoom>`, `<kgdiff-minimap>`, `<kgdiff-title>` and `<kgdiff-actions>`,
with their attributes, properties, methods, events, slots, custom states, the element types, the
React types and the `keymap` shortcut names, no longer carry `@experimental`: from now on they
follow semantic versioning. Nothing changes in behavior or types.

CSS `::part()` is not offered in 1.0: theme the elements with the `--kgdiff-*` custom properties.
Adding `::part()` names later is purely additive.

`<kgdiff-stage>`'s `addLayer` and the `RendererLayer` / `LayerView` types stay experimental until
1.0, as RFC 0003 says.
