---
'@kgdiff/viewer': minor
'@kgdiff/compute': minor
'@kgdiff/core': minor
'@kgdiff/scene': minor
'@kgdiff/g6': minor
---

**JavaScript API:** before 1.0, the npm packages keep only the API they document, so that nothing kgdiff uses internally becomes a promise. Each entry point now has an API report (`packages/<name>/api/*.api.md`) that CI compares with the built declarations. Pages that use the viewer's elements through their attributes, properties, methods and events, and code that uses the other packages as documented, need no change. Guide: [Migrating to 0.12](https://github.com/iiwish/kgdiff/blob/main/docs/guide/migrating-to-0.12.md#javascript).

- `@kgdiff/viewer/elements/*`: the element classes' declarations no longer show the members a subclass would override (`build`, `name`, `shadow`, `context`, `upgradedProperties`, and the hooks of `<kgdiff-root>`), nor `KgdiffStage`'s `view`. Subclassing the element classes is not covered by semantic versioning: an element's public interface is what `custom-elements.json` lists. Extend an element by composition (slots, `addLayer`, `registerObstacle`, events).
- `@kgdiff/viewer/elements/stage` no longer exports `STAGE_REGIONS`: use the `StageRegion` values (`'dock'`, `'transport'`, `'legend'`, `'zoom'`, `'minimap'`). It exports `Context`, the type of `stageContext`.
- `@kgdiff/compute/layout` no longer exports `layoutModule`: call `init()` and the entry point's functions.
- `@kgdiff/core/computed` is an internal entry point of `@kgdiff/compute` of the same version, not covered by semantic versioning.
- `@kgdiff/g6` exports `ElementKind`, the type of `KgdiffDatumData.kgdiff`.
- `@kgdiff/scene`: `shape2` of `EdgeVisual` and `GlyphVisual` is documented as experimental, like `shape1`.
