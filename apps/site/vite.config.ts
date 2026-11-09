/**
 * kgdiff website: landing page (`index.html`) and playground (`playground.html`).
 *
 *   pnpm vite --config apps/site/vite.config.ts --port 5196      (dev)
 *   pnpm vite build --config apps/site/vite.config.ts            (→ apps/site/dist)
 *
 * Like the viewer's dev harness, `@kgdiff/*` resolves to package sources, so nothing needs to be
 * built (or installed) first. Environment:
 *
 *   KGDIFF_SITE_BASE   public base path, e.g. `/kgdiff/` on GitHub Pages (default `/`)
 *   KGDIFF_SITE_URL    absolute URL of the deployed site, for canonical / Open Graph tags
 *   KGDIFF_REPO_URL    GitHub repository (links to docs and source)
 *
 * On Vercel, the production domain (VERCEL_PROJECT_PRODUCTION_URL) and the GitHub repository
 * (VERCEL_GIT_REPO_OWNER / VERCEL_GIT_REPO_SLUG) stand in for the last two when unset.
 */
import { fileURLToPath } from 'node:url';
import { type Alias, defineConfig } from 'vite';
import {
  kgdiffData,
  readVersion,
  siteHtml,
  siteTokens,
  standaloneViewer,
} from './build/plugins.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const repo = fileURLToPath(new URL('../../', import.meta.url));

const alias: Alias[] = [
  { find: /^@kgdiff\/viewer\/compute$/, replacement: `${repo}packages/viewer/src/compute.ts` },
  { find: /^@kgdiff\/([\w-]+)$/, replacement: `${repo}packages/$1/src/index.ts` },
];

const withSlash = (s: string): string => (s.endsWith('/') ? s : `${s}/`);
const base = withSlash(process.env.KGDIFF_SITE_BASE ?? '/');
const { VERCEL_PROJECT_PRODUCTION_URL: vercelDomain, VERCEL_GIT_PROVIDER: gitProvider } =
  process.env;
const { VERCEL_GIT_REPO_OWNER: gitOwner, VERCEL_GIT_REPO_SLUG: gitRepo } = process.env;
const vercelRepo =
  gitProvider === 'github' && gitOwner && gitRepo
    ? `https://github.com/${gitOwner}/${gitRepo}`
    : undefined;
const repoUrl = (
  process.env.KGDIFF_REPO_URL ??
  vercelRepo ??
  'https://github.com/iiwish/kgdiff'
).replace(/\/+$/, '');
const siteUrl = withSlash(
  process.env.KGDIFF_SITE_URL ??
    (vercelDomain ? `https://${vercelDomain}/` : `https://iiwish.github.io${base}`),
);
const version = readVersion(repo);

export default defineConfig({
  root: here,
  base,
  publicDir: 'public',
  appType: 'mpa',
  resolve: { alias },
  define: {
    __KGDIFF_VERSION__: JSON.stringify(version),
    __KGDIFF_REPO_URL__: JSON.stringify(repoUrl),
  },
  plugins: [
    siteTokens({ repo, alias }),
    kgdiffData({ repo, alias }),
    standaloneViewer({ repo, alias }),
    siteHtml({ siteUrl, repoUrl, version }),
  ],
  server: { port: 5196, strictPort: false, fs: { allow: [repo] } },
  preview: { port: 5197 },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    // Report sizes the way they are served (gzip).
    reportCompressedSize: true,
    chunkSizeWarningLimit: 400,
    rolldownOptions: {
      input: {
        index: `${here}index.html`,
        playground: `${here}playground.html`,
      },
      output: {
        // Readable chunk names (the defaults name most of them after a `src` folder).
        chunkFileNames(chunk) {
          const ids = chunk.moduleIds;
          const has = (part: string): boolean => ids.some((id) => id.includes(part));
          const payload = /virtual:kgdiff\/payload\/([\w-]+)/.exec(chunk.facadeModuleId ?? '');
          if (payload) return `assets/payload-${payload[1]}-[hash].js`;
          const data = ids
            .map((id) => /examples\/datasets\/([\w-]+)\/(before|after)\./.exec(id))
            .find((m) => m !== null);
          if (data) return `assets/data-${data[1]}-${data[2]}-[hash].js`;
          if (has('/crates/kgdiff/tests/snapshots/')) return 'assets/cli-output-[hash].js';
          if (has('/packages/formats/')) return 'assets/formats-[hash].js';
          if (has('/packages/viewer/src/element.ts')) return 'assets/viewer-[hash].js';
          if (has('/packages/core/') || has('/packages/layout/')) return 'assets/engine-[hash].js';
          if (chunk.name === 'preload-helper') return 'assets/shared-[hash].js';
          return 'assets/[name]-[hash].js';
        },
        assetFileNames(asset) {
          const name = asset.names[0] ?? '';
          if (name.startsWith('preload-helper')) return 'assets/site-[hash][extname]';
          return 'assets/[name]-[hash][extname]';
        },
      },
    },
  },
});
