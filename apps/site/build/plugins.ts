/**
 * Vite plugins of the site.
 *
 * - `kgdiffData`: virtual modules with build-time data. `virtual:kgdiff/payload/<id>` is the
 *   precomputed `ReportPayload` of an example dataset and `virtual:kgdiff/stats` the numbers of
 *   the dataset cards. Computed in Node by `datasets.ts` (loaded through Vite's module runner,
 *   with the same `@kgdiff/*` → sources aliases as the site), so the landing page needs neither
 *   the parsers nor the diff engine nor the force layout.
 * - `standaloneViewer`: builds the viewer's standalone IIFE bundles from source (the exact
 *   configuration of `packages/viewer/vite.config.ts`, i.e. what the CLI inlines into
 *   `report.html`) and publishes them as site assets. The playground fetches them on demand to
 *   write self-contained HTML reports in the browser. `virtual:kgdiff/standalone` exports their
 *   URLs.
 * - `siteHtml`: fills `%KGDIFF_*%` placeholders in the HTML pages (absolute site URL for
 *   canonical / Open Graph tags, repository URL, version).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  type Alias,
  build,
  type Plugin,
  type ResolvedConfig,
  type Rolldown,
  runnerImport,
} from 'vite';

type DatasetsModule = typeof import('./datasets.js');
type TokensModule = typeof import('./tokens.js');

const PAYLOAD_PREFIX = 'virtual:kgdiff/payload/';
const STATS_ID = 'virtual:kgdiff/stats';
const STANDALONE_ID = 'virtual:kgdiff/standalone';
const RESOLVED = '\0';

export interface SitePaths {
  /** Repository root (trailing slash). */
  readonly repo: string;
  /** `@kgdiff/*` → package sources. */
  readonly alias: readonly Alias[];
}

/** JavaScript that evaluates to `value` and parses fast (JSON.parse of a string literal). */
function jsonModule(value: unknown): string {
  return `export default JSON.parse(${JSON.stringify(JSON.stringify(value))});\n`;
}

/** Run a build-time module of this folder in Node, with the site's `@kgdiff/*` aliases. */
function runBuildModule<T>(paths: SitePaths, file: string): Promise<T> {
  return runnerImport<T>(fileURLToPath(new URL(file, import.meta.url)), {
    configFile: false,
    root: paths.repo,
    logLevel: 'warn',
    resolve: { alias: [...paths.alias] },
  }).then((r) => r.module);
}

export function kgdiffData(paths: SitePaths): Plugin {
  const datasets = `${paths.repo}examples/datasets`;
  let loaded: Promise<DatasetsModule> | null = null;
  const load = (): Promise<DatasetsModule> => {
    loaded ??= runBuildModule<DatasetsModule>(paths, './datasets.ts');
    return loaded;
  };
  return {
    name: 'kgdiff-site-data',
    resolveId(id) {
      if (id === STATS_ID || id.startsWith(PAYLOAD_PREFIX)) return RESOLVED + id;
      return null;
    },
    async load(id) {
      if (!id.startsWith(RESOLVED)) return null;
      const virtual = id.slice(RESOLVED.length);
      if (virtual === STATS_ID) {
        const m = await load();
        return jsonModule(await m.allStats(datasets));
      }
      if (virtual.startsWith(PAYLOAD_PREFIX)) {
        const name = virtual.slice(PAYLOAD_PREFIX.length);
        const m = await load();
        if (!m.datasetIds(datasets).includes(name)) {
          this.error(`Unknown example dataset "${name}" (see examples/datasets/index.json).`);
        }
        return jsonModule(await m.payloadOf(datasets, name));
      }
      return null;
    },
    configureServer(server) {
      // Example data edited while developing: recompute on the next request.
      server.watcher.add(datasets);
      server.watcher.on('change', (file) => {
        if (!file.startsWith(datasets) && !file.includes('/packages/')) return;
        loaded = null;
        for (const mod of server.moduleGraph.idToModuleMap.values()) {
          if (mod.id?.startsWith(RESOLVED + PAYLOAD_PREFIX) || mod.id === RESOLVED + STATS_ID) {
            server.moduleGraph.invalidateModule(mod);
          }
        }
      });
    },
  };
}

interface Bundles {
  readonly viewer: string;
  readonly compute: string;
}

/** Build both standalone bundles with the viewer package's own Vite configuration. */
async function buildStandalone(repo: string): Promise<Bundles> {
  const one = async (mode: 'production' | 'compute'): Promise<string> => {
    const out = await build({
      configFile: `${repo}packages/viewer/vite.config.ts`,
      mode,
      logLevel: 'warn',
      build: { write: false, emptyOutDir: false },
    });
    const outputs = (Array.isArray(out) ? out : [out]) as Rolldown.RolldownOutput[];
    for (const o of outputs) {
      const chunk = o.output.find((c): c is Rolldown.OutputChunk => c.type === 'chunk');
      if (chunk) return chunk.code;
    }
    throw new Error(`The standalone viewer build (${mode}) produced no chunk.`);
  };
  return { viewer: await one('production'), compute: await one('compute') };
}

const hash8 = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 8);

export function standaloneViewer(paths: SitePaths): Plugin {
  let config: ResolvedConfig;
  let urls: { viewer: string; compute: string } | null = null;
  let devBundles: Promise<Bundles> | null = null;
  const DEV_PREFIX = '/@kgdiff-standalone/';
  return {
    name: 'kgdiff-site-standalone',
    configResolved(resolved) {
      config = resolved;
    },
    async buildStart() {
      if (config.command !== 'build') return;
      const bundles = await buildStandalone(paths.repo);
      const viewerFile = `${config.build.assetsDir}/kgdiff-viewer.${hash8(bundles.viewer)}.js`;
      const computeFile = `${config.build.assetsDir}/kgdiff-viewer-compute.${hash8(bundles.compute)}.js`;
      this.emitFile({ type: 'asset', fileName: viewerFile, source: bundles.viewer });
      this.emitFile({ type: 'asset', fileName: computeFile, source: bundles.compute });
      urls = { viewer: config.base + viewerFile, compute: config.base + computeFile };
    },
    resolveId(id) {
      return id === STANDALONE_ID ? RESOLVED + id : null;
    },
    transformIndexHtml(_html, ctx) {
      // The landing page shows live viewers above the fold: fetch the bundle with the HTML.
      if (!ctx.filename.endsWith('index.html')) return undefined;
      const href = urls?.viewer ?? `${DEV_PREFIX}kgdiff-viewer.js`;
      return [{ tag: 'link', attrs: { rel: 'preload', as: 'script', href }, injectTo: 'head' }];
    },
    load(id) {
      if (id !== RESOLVED + STANDALONE_ID) return null;
      const u = urls ?? {
        viewer: `${DEV_PREFIX}kgdiff-viewer.js`,
        compute: `${DEV_PREFIX}kgdiff-viewer-compute.js`,
      };
      return `export const viewerUrl = ${JSON.stringify(u.viewer)};\nexport const computeUrl = ${JSON.stringify(u.compute)};\n`;
    },
    configureServer(server) {
      server.watcher.on('change', (file) => {
        if (file.includes('/packages/')) devBundles = null;
      });
      server.middlewares.use(DEV_PREFIX, (req, res, next) => {
        const name = (req.url ?? '').replace(/^\//, '').split('?')[0];
        if (name !== 'kgdiff-viewer.js' && name !== 'kgdiff-viewer-compute.js') return next();
        devBundles ??= buildStandalone(paths.repo);
        devBundles.then(
          (b) => {
            res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
            res.setHeader('Cache-Control', 'no-store');
            res.end(name === 'kgdiff-viewer.js' ? b.viewer : b.compute);
          },
          (error: unknown) => {
            devBundles = null;
            next(error);
          },
        );
      });
    },
  };
}

/**
 * Inline the design tokens (`tokens.ts`, from `@kgdiff/scene` `getTheme()`) as the first
 * stylesheet of every page, and fill `%KGDIFF_THEME_COLOR%` with the dark canvas color.
 */
export function siteTokens(paths: SitePaths): Plugin {
  let loaded: Promise<TokensModule> | null = null;
  return {
    name: 'kgdiff-site-tokens',
    configureServer(server) {
      server.watcher.on('change', (file) => {
        if (file.includes('/packages/scene/')) loaded = null;
      });
    },
    transformIndexHtml: {
      order: 'pre',
      async handler(html) {
        loaded ??= runBuildModule<TokensModule>(paths, './tokens.ts');
        const m = await loaded;
        return {
          html: html.replace(/%KGDIFF_THEME_COLOR%/g, m.themeColors().dark),
          tags: [
            {
              tag: 'style',
              attrs: { id: 'kgdiff-tokens' },
              children: m.tokensCss(),
              injectTo: 'head-prepend',
            },
          ],
        };
      },
    },
  };
}

export interface SiteInfo {
  /** Absolute URL of the deployed site, with a trailing slash. */
  readonly siteUrl: string;
  readonly repoUrl: string;
  readonly version: string;
}

/** Read the published CLI version (`kgdiff` package). */
export function readVersion(repo: string): string {
  const pkg = JSON.parse(readFileSync(`${repo}packages/cli/package.json`, 'utf8')) as {
    version?: unknown;
  };
  return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
}

export function siteHtml(info: SiteInfo): Plugin {
  const values: Record<string, string> = {
    KGDIFF_SITE_URL: info.siteUrl,
    KGDIFF_REPO_URL: info.repoUrl,
    KGDIFF_VERSION: info.version,
  };
  return {
    name: 'kgdiff-site-html',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        return html.replace(/%(KGDIFF_[A-Z_]+)%/g, (match, key: string) => values[key] ?? match);
      },
    },
  };
}
