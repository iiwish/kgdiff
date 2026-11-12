---
'@kgdiff/compute': patch
'@kgdiff/formats': patch
'@kgdiff/viewer': patch
---

The parsers' types and `FORMAT_EXTENSIONS` move to `@kgdiff/compute`, and no other kgdiff package depends on `@kgdiff/formats` any more, so that it can be marked deprecated on npm without warning everyone who installs `@kgdiff/compute` or `@kgdiff/viewer`. Nothing is removed and no type changes.

- `@kgdiff/compute`: exports `FormatId`, `ParseOptions`, `ParseResult`, `ParseWarning`, `ParseWarningCode`, `RdfOptions`, `JsonOptions`, `JsonLdOptions`, `JsonDialect` and `FORMAT_EXTENSIONS`, with the same declarations as `@kgdiff/formats` 0.11.0. It no longer depends on `@kgdiff/formats`.
- `@kgdiff/formats` (still deprecated, removed in 2.0): re-exports those from `@kgdiff/compute` and its `parseGraph`, `detectFormat` and `compactIri` call `@kgdiff/compute`'s. Its exports and their types are the ones of 0.11.0.
- `@kgdiff/viewer`: `load()` parses text sources with `parseGraph` of `@kgdiff/compute` (imported on demand, as before), and `ParseOptions` comes from there. It no longer depends on `@kgdiff/formats`. The standalone viewer imports `@kgdiff/compute` for text sources, which an import map that served `@kgdiff/formats` already had to provide.
