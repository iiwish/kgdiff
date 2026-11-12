---
'@kgdiff/compute': patch
'@kgdiff/formats': patch
'@kgdiff/viewer': patch
---

No other kgdiff package depends on `@kgdiff/formats` any more, so that it can be marked deprecated on npm without warning everyone who installs `@kgdiff/compute` or `@kgdiff/viewer`. Nothing is removed and no type changes.

- `@kgdiff/compute`: exports the parsers' types (`FormatId`, `ParseOptions`, `ParseResult`, `ParseWarning`, `ParseWarningCode`, `RdfOptions`, `JsonOptions`, `JsonLdOptions`, `JsonDialect`) and `FORMAT_EXTENSIONS`, the declarations `@kgdiff/core` defines since this release, the same as those of `@kgdiff/formats` 0.11.0. It no longer depends on `@kgdiff/formats`.
- `@kgdiff/formats` (deprecated, and not published from 1.0 on: 0.11.x stays on npm and keeps working): re-exports those from `@kgdiff/compute`, and its `parseGraph`, `detectFormat` and `compactIri` call `@kgdiff/compute`'s. Its exports and their types are the ones of 0.11.0.
- `@kgdiff/viewer`: `load()` parses text sources with `parseGraph` of `@kgdiff/compute` (imported on demand, as before), and `ParseOptions` comes from there. It no longer depends on `@kgdiff/formats`. The standalone viewer imports `@kgdiff/compute` for text sources, which an import map that served `@kgdiff/formats` already had to provide.
