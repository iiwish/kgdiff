/**
 * Entry of the optional standalone add-on (`dist/standalone/kgdiff-viewer-compute.js`): makes
 * the compute module available to the standalone viewer. The add-on carries kgdiff's layout-only
 * WebAssembly module inlined (base64), so that a single-file report lays out and expands groups
 * offline; `diff` imports `@kgdiff/compute` (an import map entry), as parsing text imports
 * `@kgdiff/formats`.
 */
import * as compute from './compute.js';
import { COMPUTE_GLOBAL } from './compute-loader.js';

(globalThis as Record<string, unknown>)[COMPUTE_GLOBAL] = compute;
