/**
 * Standalone builds (IIFE, minified), used by the CLI's single-file HTML reports:
 *
 * - `dist/standalone/kgdiff-viewer.js` (default mode): defines `<kgdiff-viewer>` and hydrates
 *   embedded payloads. Bundles core, scene, renderer and the report path of layout, and never any
 *   WebAssembly. Left out: `@kgdiff/compute` (the parsers, for text sources) and the compute
 *   module, which the viewer imports on demand — from an import map, or from the add-on below.
 * - `dist/standalone/kgdiff-viewer-compute.js` (`--mode compute`): optional add-on that
 *   provides the compute module as `globalThis.KgdiffCompute`, with kgdiff's layout-only
 *   WebAssembly module inlined (Vite inlines the `new URL('…/layout.wasm', import.meta.url)` of
 *   `@kgdiff/compute/layout` as a base64 data URL in library mode): reports without a layout and
 *   expanding nodes outside a `changes`-scoped layout, offline. `load()` with graphs also needs
 *   `@kgdiff/compute` (the full engine), which stays external: an import map entry.
 *
 *   pnpm --filter @kgdiff/viewer build
 */
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

const here = fileURLToPath(new URL('.', import.meta.url));
const repo = fileURLToPath(new URL('../../', import.meta.url));

/** Collapse the CSS template literals in `styles.ts` (comments, whitespace). */
function minifyCss(): Plugin {
  return {
    name: 'kgdiff-minify-css',
    enforce: 'pre',
    transform(code, id) {
      if (!id.endsWith('/viewer/src/styles.ts')) return null;
      return code.replace(/\/\* css \*\/ `([\s\S]*?)`/g, (_m, css: string) => {
        const min = css
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/\s+/g, ' ')
          .replace(/\s*([{};,>])\s*/g, '$1')
          .replace(/:\s+/g, ':')
          .replace(/;}/g, '}')
          .trim();
        return `\`${min}\``;
      });
    },
  };
}

/** Keep the lazily imported compute module out of the main bundle. */
function externalCompute(): Plugin {
  return {
    name: 'kgdiff-external-compute',
    enforce: 'pre',
    resolveId(source, importer) {
      if (source === './compute.js' && importer?.endsWith('/viewer/src/compute-loader.ts')) {
        return { id: '@kgdiff/viewer/compute', external: true };
      }
      return null;
    },
  };
}

/**
 * For the add-on (an IIFE): `layout.wasm` is imported as a URL, which library mode inlines as a
 * data URL, and wasm-bindgen's glue fallback `new URL('<module>.wasm', import.meta.url)` (used only
 * when it is given no module, which `@kgdiff/compute` never does) becomes an error, or Vite would
 * inline the module a second time.
 */
function dropGlueDefault(): Plugin {
  return {
    name: 'kgdiff-drop-glue-default',
    enforce: 'pre',
    transform(code, id) {
      if (id.endsWith('/packages/compute/src/layout.ts')) {
        // An IIFE has no `import.meta.url` to resolve against (Rolldown writes `"" + {}.url`):
        // import the module as a URL instead, which library mode inlines as a data URL.
        const out = code.replace(
          "new URL('../wasm/layout.wasm', import.meta.url)",
          'new URL(kgdiffLayoutWasm)',
        );
        if (out === code) this.error('@kgdiff/compute/layout no longer locates layout.wasm so');
        return {
          code: `import kgdiffLayoutWasm from '../wasm/layout.wasm?url';\n${out}`,
          map: null,
        };
      }
      if (!/\/packages\/compute\/wasm\/\w+\.js$/.test(id)) return null;
      const out = code.replace(
        /new URL\('\w+\.wasm', import\.meta\.url\)/g,
        "(() => { throw new Error('@kgdiff/compute passes the module'); })()",
      );
      return out === code ? null : { code: out, map: null };
    },
  };
}

export default defineConfig(({ mode }) => {
  const addon = mode === 'compute';
  return {
    root: here,
    logLevel: 'warn',
    plugins: addon ? [dropGlueDefault()] : [minifyCss(), externalCompute()],
    resolve: {
      // Bundle the workspace packages from source; `@kgdiff/compute` stays external.
      alias: [
        {
          find: /^@kgdiff\/(core|layout|scene|renderer)$/,
          replacement: `${repo}packages/$1/src/index.ts`,
        },
        {
          find: /^@kgdiff\/compute\/layout$/,
          replacement: `${repo}packages/compute/src/layout.ts`,
        },
      ],
    },
    build: {
      outDir: 'dist/standalone',
      emptyOutDir: !addon,
      target: 'es2022',
      minify: true,
      sourcemap: false,
      reportCompressedSize: false,
      lib: {
        entry: addon ? 'src/standalone-compute.ts' : 'src/standalone.ts',
        formats: ['iife'],
        name: addon ? 'KgdiffViewerCompute' : 'KgdiffViewer',
        fileName: () => (addon ? 'kgdiff-viewer-compute.js' : 'kgdiff-viewer.js'),
      },
      rollupOptions: {
        // The parsers and the full engine are imported on demand (an import map entry).
        external: ['@kgdiff/compute'],
      },
    },
  };
});
