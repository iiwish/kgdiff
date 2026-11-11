// The exports of wasm-bindgen's glue for the `engine` feature of crates/kgdiff-wasm
// (`--target web`), kept by hand so that the package typechecks without a WebAssembly build.
// `pnpm build:wasm` fails when the functions it generates differ from these.

export function diffJSON(before: string, after: string, options: string): string;

export function diffLayoutJSON(
  before: string,
  after: string,
  diff_options: string,
  layout_options: string,
): string;

export function graphIssuesJSON(graph: string, options: string): string;

export function hashGraphJSON(graph: string, options: string): string;

export function layoutGraphJSON(graph: string, options: string, normalize: string): string;

export function matchNodesJSON(before: string, after: string, options: string): string;

export function normalizeJSON(graph: string, options: string): string;

export function textSimilarity(a: string, b: string): number;

export function version(): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

/** Compiles and instantiates the module (fetched from `module_or_path`, or given). */
export default function init(module_or_path?: {
  module_or_path: InitInput | Promise<InitInput>;
}): Promise<{ readonly memory: WebAssembly.Memory }>;
