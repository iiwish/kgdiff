// The exports of wasm-bindgen's glue for the `layout` feature of crates/kgdiff-wasm
// (`--target web`), kept by hand so that the package typechecks without a WebAssembly build.
// `pnpm build:wasm` fails when the functions it generates differ from these.

export function estimateLabelWidth(text: string, font_size: number): number;

export function layoutRun(
  op: number,
  text: string,
  lengths: Uint32Array,
  ints: Uint32Array,
  floats: Float64Array,
): Float64Array;

export function nodeRadius(degree: number): number;

export function version(): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

/** Compiles and instantiates the module (fetched from `module_or_path`, or given). */
export default function init(module_or_path?: {
  module_or_path: InitInput | Promise<InitInput>;
}): Promise<{ readonly memory: WebAssembly.Memory }>;
