/**
 * The TypeScript parsers, synchronous, for the TypeScript corpus generator (`conformance/`) until
 * it moves to Rust (RFC 0002, phase 5). Not exported by the package, whose functions run kgdiff's
 * parsers through `@kgdiff/compute`. Deleted with the rest of the package's TypeScript code.
 */
export { compactIri, detectFormat, parseGraph } from './parse.js';
