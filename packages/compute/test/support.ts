import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const file = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/** Whether the WebAssembly build (`pnpm --filter @kgdiff/compute build:wasm`) is there. */
export const built = ['compute', 'layout', 'formats'].every((name) =>
  existsSync(file(`../wasm/${name}.wasm`)),
);

/**
 * Whether these tests run: with the build, or when KGDIFF_COMPUTE is set (the `compute` job of
 * CI), where a missing build fails them. Elsewhere, as in the `check` job, which builds no Rust,
 * they are skipped.
 */
export const enabled = built || process.env.KGDIFF_COMPUTE !== undefined;

/** The exports of the corpus build (`test/wasm/corpus.js`): `compute` and the read path. */
export interface CorpusBuild {
  readDiffJSON(document: string): string;
  packDiffJSON(document: string): string;
  unpackDiffJSON(packed: string): string;
  deltaOfDiffJSON(document: string): string;
  invertDeltaJSON(delta: string): string;
  applyDeltaJSON(graph: string, delta: string, options: string): string;
  hunkTitlesJSON(document: string, locale: string): string;
  predicateLabel(predicate: string): string;
  facetLabel(kind: string, locale: string): string | undefined;
  reformatJSON(text: string, pretty: boolean): string;
  layoutDiffJSON(document: string, options: string): string;
  extendLayoutJSON(document: string, layout: string, nodes: string, options: string): string;
  layoutDiffOnJSON(document: string, previous: string, options: string): string;
  layoutAfterJSON(document: string, layout: string, options: string): string;
}

/** Loads the corpus build. */
export async function corpusBuild(): Promise<CorpusBuild> {
  const path = file('wasm/corpus.js');
  const glue = (await import(/* @vite-ignore */ path)) as CorpusBuild & {
    initSync(input: { module: BufferSource }): unknown;
  };
  const { readFileSync } = await import('node:fs');
  glue.initSync({ module: readFileSync(file('wasm/corpus.wasm')) });
  return glue;
}

/** The SHA-256 of the native layouts of the corpus, by name (`<case>`, `<case>/changes`, …). */
export async function nativeLayouts(): Promise<Map<string, string>> {
  const { readFileSync } = await import('node:fs');
  const lines = readFileSync(file('wasm/native-layouts.txt'), 'utf8').trim().split('\n');
  return new Map(lines.map((line) => line.split(' ') as [string, string]));
}
