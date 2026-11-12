/**
 * The types of kgdiff's parsers and `FORMAT_EXTENSIONS`, exported by the package's entry. Defined
 * by `@kgdiff/core` since 0.11.1 (its `parseGraph`, `detectFormat` and `compactIri` call this
 * package's); `@kgdiff/formats` (deprecated) re-exports them from here. Imports no WebAssembly
 * glue and no DOM types, so the packages that see `@kgdiff/compute` through
 * `types/compute-stub.d.ts` get these declarations too.
 */
export {
  FORMAT_EXTENSIONS,
  type FormatId,
  type JsonDialect,
  type JsonLdOptions,
  type JsonOptions,
  type ParseOptions,
  type ParseResult,
  type ParseWarning,
  type ParseWarningCode,
  type RdfOptions,
} from '@kgdiff/core';
