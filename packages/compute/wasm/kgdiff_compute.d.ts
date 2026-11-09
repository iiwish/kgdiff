// The exports of wasm-bindgen's glue for crates/kgdiff-wasm (`--target web`), kept by hand so
// that the package typechecks without a WebAssembly build. `pnpm build:wasm` fails when the
// functions it generates differ from these.

export function applyDeltaJSON(graph: string, delta: string, options: string): string;

export function deltaOfDiffJSON(document: string): string;

export function diffJSON(before: string, after: string, options: string): string;

export function facetLabel(kind: string, locale: string): string | undefined;

export function graphIssuesJSON(graph: string, options: string): string;

export function hashGraphJSON(graph: string, options: string): string;

export function hunkTitlesJSON(document: string, locale: string): string;

export function invertDeltaJSON(delta: string): string;

export function matchNodesJSON(before: string, after: string, options: string): string;

export function normalizeJSON(graph: string, options: string): string;

export function packDiffJSON(document: string): string;

export function predicateLabel(predicate: string): string;

export function readDiffJSON(document: string): string;

export function reformatJSON(text: string, pretty: boolean): string;

export function textSimilarity(a: string, b: string): number;

export function unpackDiffJSON(packed: string): string;

export function version(): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

/** Compiles and instantiates the module (fetched from `module_or_path`, or given). */
export default function init(module_or_path?: {
  module_or_path: InitInput | Promise<InitInput>;
}): Promise<unknown>;
