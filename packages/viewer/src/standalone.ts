/**
 * Entry of the standalone IIFE bundle (`dist/standalone/kgdiff-viewer.js`): defines
 * `<kgdiff-viewer>` and hydrates embedded report payloads once the document is parsed.
 * The parsers are not bundled; `load()` with text sources imports `@kgdiff/compute` on demand.
 */
import { hydrateEmbeddedPayloads } from './index.js';

export * from './index.js';

function start(): void {
  hydrateEmbeddedPayloads().catch((error: unknown) => console.error('[kgdiff]', error));
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else start();
}
