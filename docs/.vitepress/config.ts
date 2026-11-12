/**
 * kgdiff documentation site: VitePress over the Markdown in docs/, published at `<base>docs/`
 * next to the landing page and the playground (apps/site).
 *
 *   pnpm dev:docs                       (dev server, http://localhost:5195/docs/)
 *   pnpm build:docs                     (→ docs/.vitepress/dist, copied into apps/site/dist/docs)
 *
 * Environment, shared with apps/site/vite.config.ts:
 *
 *   KGDIFF_SITE_BASE   public base path of the whole site, e.g. `/kgdiff/` on GitHub Pages
 *   KGDIFF_SITE_URL    absolute URL of the deployed site, for canonical and Open Graph tags
 *   KGDIFF_REPO_URL    GitHub repository (source, edit links)
 *
 * On Vercel, the production domain (VERCEL_PROJECT_PRODUCTION_URL) and the GitHub repository
 * (VERCEL_GIT_REPO_OWNER / VERCEL_GIT_REPO_SLUG) stand in for the last two when unset.
 */
import { existsSync, readFileSync } from 'node:fs';
import { cp, rm } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { type DefaultTheme, defineConfig } from 'vitepress';

const withSlash = (s: string): string => (s.endsWith('/') ? s : `${s}/`);
const base = withSlash(process.env.KGDIFF_SITE_BASE ?? '/');
const { VERCEL_PROJECT_PRODUCTION_URL: vercelDomain, VERCEL_GIT_PROVIDER: gitProvider } =
  process.env;
const { VERCEL_GIT_REPO_OWNER: gitOwner, VERCEL_GIT_REPO_SLUG: gitRepo } = process.env;
const vercelRepo =
  gitProvider === 'github' && gitOwner && gitRepo
    ? `https://github.com/${gitOwner}/${gitRepo}`
    : undefined;
const siteUrl = process.env.KGDIFF_SITE_URL
  ? withSlash(process.env.KGDIFF_SITE_URL)
  : vercelDomain
    ? `https://${vercelDomain}/`
    : undefined;
const repoUrl = (
  process.env.KGDIFF_REPO_URL ??
  vercelRepo ??
  'https://github.com/iiwish/kgdiff'
).replace(/\/+$/, '');
const repo = resolve(import.meta.dirname, '../..');
const docs = join(repo, 'docs');
// All packages share one version (a Changesets "fixed" group).
const { version } = JSON.parse(readFileSync(join(repo, 'packages/cli/package.json'), 'utf8')) as {
  version: string;
};

const description =
  'Documentation for kgdiff, git diff for knowledge graphs: install the CLI, review graph ' +
  'changes in CI, embed the viewer and use the diff engine in code.';
const zhDescription =
  'kgdiff 文档：知识图谱的 git diff。安装命令行工具，在 CI 中审阅图谱变更，嵌入查看器，' +
  '在代码中调用 diff 引擎。';

const sidebar: DefaultTheme.SidebarItem[] = [
  {
    text: 'Introduction',
    items: [
      { text: 'What is kgdiff?', link: '/docs/' },
      { text: 'Getting started', link: '/docs/getting-started' },
    ],
  },
  {
    text: 'Guides',
    items: [
      { text: 'Review changes in CI', link: '/docs/guide/ci' },
      { text: 'Use kgdiff with git', link: '/docs/guide/git' },
      { text: 'Ontologies: OBO and OWL', link: '/docs/guide/ontologies' },
      { text: 'Graphs without stable ids', link: '/docs/guide/llm-graphs' },
      { text: 'How kgdiff tells changes apart', link: '/docs/guide/matching' },
      { text: 'Embed the viewer', link: '/docs/guide/viewer' },
      { text: 'Use the engine in code', link: '/docs/guide/library' },
      { text: 'Migrating to 0.11', link: '/docs/guide/migrating-to-0.11' },
      { text: 'Embed in a Rust application', link: '/docs/guide/embedding' },
      { text: 'Browse a graph with G6', link: '/docs/guide/g6' },
      { text: 'Deltas: apply and invert', link: '/docs/guide/deltas' },
    ],
  },
  {
    text: 'Reference',
    items: [
      { text: 'CLI', link: '/docs/cli' },
      { text: 'Formats', link: '/docs/formats' },
      { text: 'Viewer: interaction and API', link: '/docs/interaction' },
      { text: 'Viewer elements: reference', link: '/docs/viewer-elements' },
      { text: 'Delta format', link: '/docs/delta-format' },
    ],
  },
  {
    text: 'Concepts',
    items: [
      { text: 'Architecture', link: '/docs/architecture' },
      { text: 'Algorithms', link: '/docs/algorithms' },
      { text: 'Visual language', link: '/docs/visual-language' },
    ],
  },
  { text: 'FAQ', link: '/docs/faq' },
];

// docs/zh/ holds the Chinese pages. The concept documents are specifications that change with
// the code, so they stay in English only.
const zhSidebar: DefaultTheme.SidebarItem[] = [
  {
    text: '入门',
    items: [
      { text: 'kgdiff 是什么？', link: '/docs/zh/' },
      { text: '快速开始', link: '/docs/zh/getting-started' },
    ],
  },
  {
    text: '指南',
    items: [
      { text: '在 CI 中审阅变更', link: '/docs/zh/guide/ci' },
      { text: '配合 git 使用', link: '/docs/zh/guide/git' },
      { text: '本体：OBO 与 OWL', link: '/docs/zh/guide/ontologies' },
      { text: '没有稳定 id 的图', link: '/docs/zh/guide/llm-graphs' },
      { text: 'kgdiff 如何区分各种变化', link: '/docs/zh/guide/matching' },
      { text: '嵌入查看器', link: '/docs/zh/guide/viewer' },
      { text: '在代码中使用引擎', link: '/docs/zh/guide/library' },
      { text: '迁移到 0.11', link: '/docs/zh/guide/migrating-to-0.11' },
      { text: '在 Rust 应用中嵌入', link: '/docs/zh/guide/embedding' },
      { text: '用 G6 浏览单张图', link: '/docs/zh/guide/g6' },
      { text: '增量：应用与反向', link: '/docs/zh/guide/deltas' },
    ],
  },
  {
    text: '参考',
    items: [
      { text: '命令行', link: '/docs/zh/cli' },
      { text: '格式', link: '/docs/zh/formats' },
      { text: '查看器：交互与 API', link: '/docs/zh/interaction' },
      { text: '查看器元素：参考', link: '/docs/zh/viewer-elements' },
      { text: '增量格式', link: '/docs/zh/delta-format' },
    ],
  },
  {
    text: '原理（英文）',
    items: [
      { text: 'Architecture', link: '/docs/architecture' },
      { text: 'Algorithms', link: '/docs/algorithms' },
      { text: 'Visual language', link: '/docs/visual-language' },
    ],
  },
  { text: '常见问题', link: '/docs/zh/faq' },
];

export default defineConfig({
  base,
  // Every page lives under docs/, so the landing page and the playground are plain root-relative
  // links (`/playground.html`) whatever the base, and the build output drops into apps/site/dist.
  rewrites: (page) => `docs/${page}`,
  srcExclude: ['releasing.md', 'review-checklist.md', 'rfcs/**'],
  assetsDir: 'docs/assets',
  title: 'kgdiff',
  titleTemplate: ':title · kgdiff',
  description,
  lang: 'en-US',
  // Dark first, like the site; the switch stays available.
  appearance: 'dark',
  head: [
    ['link', { rel: 'icon', href: `${base}favicon.svg`, type: 'image/svg+xml' }],
    ['link', { rel: 'apple-touch-icon', href: `${base}apple-touch-icon.png` }],
    ['meta', { property: 'og:site_name', content: 'kgdiff' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
    ...(siteUrl
      ? ([
          ['meta', { property: 'og:image', content: `${siteUrl}og.png` }],
          ['meta', { name: 'twitter:image', content: `${siteUrl}og.png` }],
        ] as const)
      : []),
  ],
  locales: {
    // VitePress matches a locale key anywhere in a page path (an unanchored /zh/), so `zh` covers
    // the route docs/zh/… (see `rewrites`) and the source path zh/… that local search indexes by.
    root: { label: 'English', lang: 'en-US', link: '/docs/' },
    zh: {
      label: '简体中文',
      lang: 'zh-CN',
      link: '/docs/zh/',
      description: zhDescription,
      themeConfig: {
        nav: [
          {
            text: '指南',
            link: '/docs/zh/getting-started',
            activeMatch: '^/docs/zh/(getting-started|guide/)',
          },
          {
            text: '参考',
            link: '/docs/zh/cli',
            activeMatch: '^/docs/zh/(cli|formats|interaction|delta-format)$',
          },
          { text: '在线试用', link: '/playground.html?lang=zh', target: '_self' },
          {
            text: `v${version}`,
            items: [
              { text: '更新日志', link: `${repoUrl}/blob/main/packages/cli/CHANGELOG.md` },
              { text: '参与贡献', link: `${repoUrl}/blob/main/CONTRIBUTING.md` },
            ],
          },
        ],
        sidebar: zhSidebar,
        outline: { level: [2, 3], label: '本页目录' },
        editLink: { pattern: `${repoUrl}/edit/main/docs/:path`, text: '在 GitHub 上编辑此页' },
        docFooter: { prev: '上一页', next: '下一页' },
        footer: {
          message: '基于 MIT 许可证发布。示例数据采用 CC0-1.0。',
          copyright: '© 2026 kgdiff 贡献者',
        },
        returnToTopLabel: '回到顶部',
        sidebarMenuLabel: '菜单',
        darkModeSwitchLabel: '外观',
        lightModeSwitchTitle: '切换到浅色模式',
        darkModeSwitchTitle: '切换到深色模式',
        langMenuLabel: '切换语言',
      },
    },
  },
  transformPageData(page) {
    const zh = page.filePath.startsWith('zh/');
    const english = zh ? page.filePath.slice('zh/'.length) : page.filePath;
    page.frontmatter.head ??= [];
    page.frontmatter.head.push(
      ['meta', { property: 'og:title', content: `${page.title} · kgdiff` }],
      [
        'meta',
        {
          property: 'og:description',
          content: page.description || (zh ? zhDescription : description),
        },
      ],
      ['meta', { property: 'og:locale', content: zh ? 'zh_CN' : 'en_US' }],
    );
    if (siteUrl) {
      const url = (file: string): string =>
        `${siteUrl}docs/${file.replace(/(^|\/)index\.md$/, '$1').replace(/\.md$/, '.html')}`;
      page.frontmatter.head.push(
        ['link', { rel: 'canonical', href: url(page.filePath) }],
        ['meta', { property: 'og:url', content: url(page.filePath) }],
      );
      if (existsSync(join(docs, 'zh', english))) {
        page.frontmatter.head.push(
          ['link', { rel: 'alternate', hreflang: 'en', href: url(english) }],
          ['link', { rel: 'alternate', hreflang: 'zh-CN', href: url(`zh/${english}`) }],
        );
      }
    }
  },
  themeConfig: {
    logo: '/favicon.svg',
    // The logo leads back to the landing page, which is not a VitePress page: load it in full.
    logoLink: { link: base, target: '_self' },
    nav: [
      {
        text: 'Guide',
        link: '/docs/getting-started',
        activeMatch: '^/docs/(getting-started|guide/)',
      },
      {
        text: 'Reference',
        link: '/docs/cli',
        activeMatch: '^/docs/(cli|formats|interaction|delta-format)$',
      },
      { text: 'Playground', link: '/playground.html', target: '_self' },
      {
        text: `v${version}`,
        items: [
          { text: 'Changelog', link: `${repoUrl}/blob/main/packages/cli/CHANGELOG.md` },
          { text: 'Contributing', link: `${repoUrl}/blob/main/CONTRIBUTING.md` },
        ],
      },
    ],
    sidebar,
    outline: { level: [2, 3] },
    search: {
      provider: 'local',
      options: {
        miniSearch: {
          options: {
            // Chinese has no spaces between words: segment it (Intl.Segmenter, in Node and every
            // evergreen browser) instead of splitting on whitespace. VitePress serializes this
            // function to the client, so it must not use anything from outside its body.
            tokenize: (text: string): string[] => {
              const words: string[] = [];
              const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
              for (const { segment, isWordLike } of segmenter.segment(text)) {
                if (isWordLike) words.push(segment);
              }
              return words;
            },
          },
        },
        locales: {
          zh: {
            translations: {
              button: { buttonText: '搜索', buttonAriaLabel: '搜索' },
              modal: {
                displayDetails: '显示详细列表',
                resetButtonTitle: '清除查询',
                backButtonTitle: '关闭搜索',
                noResultsText: '没有找到结果',
                footer: {
                  selectText: '选择',
                  selectKeyAriaLabel: '回车',
                  navigateText: '切换',
                  navigateUpKeyAriaLabel: '上箭头',
                  navigateDownKeyAriaLabel: '下箭头',
                  closeText: '关闭',
                  closeKeyAriaLabel: 'Esc',
                },
              },
            },
          },
        },
      },
    },
    socialLinks: [{ icon: 'github', link: repoUrl }],
    editLink: { pattern: `${repoUrl}/edit/main/docs/:path`, text: 'Edit this page on GitHub' },
    footer: {
      message: 'Released under the MIT License. Example data CC0-1.0.',
      copyright: '© 2026 kgdiff contributors',
    },
  },
  markdown: {
    image: { lazyLoading: true },
    config(md) {
      // Links are written for the Markdown as GitHub shows it. On the site, `../packages/…`
      // (outside docs/) points at the repository and `/playground.html` (outside /docs/) at the
      // site page, loaded in full since it is not a VitePress page.
      md.core.ruler.push('kgdiff-links', (state) => {
        // `path` is the rewritten one (docs/docs/…); `realPath` the source file.
        const file: unknown = state.env.realPath ?? state.env.path;
        for (const block of state.tokens) {
          for (const token of block.children ?? []) {
            const href = token.type === 'link_open' ? token.attrGet('href') : null;
            if (href?.startsWith('/') && !href.startsWith('/docs/')) {
              token.attrSet('href', `${base}${href.slice(1)}`);
              token.attrSet('target', '_self');
            } else if (href?.startsWith('../') && typeof file === 'string') {
              const [path = '', hash] = href.split('#');
              const target = resolve(dirname(file), path);
              if (!relative(docs, target).startsWith('..')) continue;
              const inRepo = relative(repo, target).split(sep).join('/');
              token.attrSet('href', `${repoUrl}/blob/main/${inRepo}${hash ? `#${hash}` : ''}`);
            }
          }
        }
      });
    },
  },
  vite: {
    server: { port: 5195, open: `${base}docs/` },
  },
  async buildEnd({ outDir }) {
    // Next to the landing page and the playground when they have been built. VitePress writes
    // the social icon styles to the root of its output, which is where the pages load them from.
    const site = join(repo, 'apps/site/dist');
    if (!existsSync(site)) return;
    await rm(join(site, 'docs'), { recursive: true, force: true });
    await cp(join(outDir, 'docs'), join(site, 'docs'), { recursive: true });
    const icons = join(outDir, 'vp-icons.css');
    if (existsSync(icons)) await cp(icons, join(site, 'vp-icons.css'));
  },
});
