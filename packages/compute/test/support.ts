import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Whether the WebAssembly build (`pnpm --filter @kgdiff/compute build:wasm`) is there. */
export const built = existsSync(
  fileURLToPath(new URL('../wasm/kgdiff_compute_bg.wasm', import.meta.url)),
);

/**
 * Whether these tests run: with the build, or when KGDIFF_COMPUTE is set (the `compute` job of
 * CI), where a missing build fails them. Elsewhere, as in the `check` job, which builds no Rust,
 * they are skipped.
 */
export const enabled = built || process.env.KGDIFF_COMPUTE !== undefined;
