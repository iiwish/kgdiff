/**
 * Standalone builds (IIFE, minified), used by the CLI's single-file HTML reports:
 *
 * - `dist/standalone/kgdiff-viewer.js` (default mode): defines `<kgdiff-viewer>` and hydrates
 *   embedded payloads. Bundles core, scene, renderer and the report path of layout. Left out:
 *   `@kgdiff/formats` (parsers) and the compute module (diff engine + force layout), which the
 *   viewer imports on demand — from an import map, or from the add-on below.
 * - `dist/standalone/kgdiff-viewer-compute.js` (`--mode compute`): optional add-on that
 *   provides the compute module as `globalThis.KgdiffCompute`, enabling `load()` with parsed
 *   graphs and expanding nodes outside a `changes`-scoped layout.
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

export default defineConfig(({ mode }) => {
  const addon = mode === 'compute';
  return {
    root: here,
    logLevel: 'warn',
    plugins: addon ? [] : [minifyCss(), externalCompute()],
    resolve: {
      // Bundle the workspace packages from source; formats stays external.
      alias: [
        {
          find: /^@kgdiff\/(core|layout|scene|renderer)$/,
          replacement: `${repo}packages/$1/src/index.ts`,
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
        external: ['@kgdiff/formats'],
      },
    },
  };
});
