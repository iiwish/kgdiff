// The exports of wasm-bindgen's glue for the `parsers` feature of crates/kgdiff-wasm
// (`--target web`), kept by hand so that the package typechecks without a WebAssembly build.
// `pnpm build:wasm` fails when the functions it generates differ from these.

export function compactIri(iri: string, prefixes: string): string;

export function detectFormat(text: string, filename?: string | null): string;

/** `loader` is `jsonld.documentLoader`, returning the context as JSON text. */
export function parseGraphJSON(
  text: string,
  options: string,
  loader?: ((url: string) => string | undefined) | null,
): string;

export function version(): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

/** Compiles and instantiates the module (fetched from `module_or_path`, or given). */
export default function init(module_or_path?: {
  module_or_path: InitInput | Promise<InitInput>;
}): Promise<{ readonly memory: WebAssembly.Memory }>;
