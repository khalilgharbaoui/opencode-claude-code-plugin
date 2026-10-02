// Starlight 0.42.4 on Astro 7.3.5. The site is its own package under site/; the
// content pages it builds from are the repository's own docs/*.md (see
// src/content.config.ts). Deployed to GitHub Pages on its own domain,
// opencode-claude-code-plugin.dev, so it is served at the root (`base: '/'`).
// The old khalilgharbaoui.github.io/opencode-claude-code-plugin/ addresses
// redirect here, path included.
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import { satteri } from '@astrojs/markdown-satteri';
import { repoLinks } from './src/markdown/repo-links.mjs';
import { focusableTables } from './src/markdown/focusable-tables.mjs';
import { responsiveTables } from './src/markdown/responsive-tables.mjs';
import { BASE, SITE } from './site-config.mjs';

const REPO = 'https://github.com/khalilgharbaoui/opencode-claude-code-plugin';
const BRANCH = 'master';

const repoRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const docsRoot = path.join(repoRoot, 'docs');

/** Every slug `docs/` contributes to the collection, so a link can be told from a file. */
const pageSlugs = new Set(listPages(docsRoot, ''));

function listPages(dir, prefix) {
  const slugs = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('_') || entry.name.startsWith('.')) continue;
    if (entry.isDirectory()) {
      slugs.push(...listPages(path.join(dir, entry.name), `${prefix}${entry.name}/`));
    } else if (entry.name.endsWith('.md') && `${prefix}${entry.name}` !== 'agents-history.md') {
      slugs.push(`${prefix}${entry.name.replace(/\.md$/, '')}`);
    }
  }
  return slugs;
}

export default defineConfig({
  site: SITE,
  base: BASE,
  trailingSlash: 'always',
  markdown: {
    // Astro 7's default processor, plus the one plugin that lets a docs page's
    // relative .md links work on GitHub and here at the same time.
    processor: satteri({
      hastPlugins: [
        repoLinks({
          repoRoot,
          base: BASE,
          blobUrl: `${REPO}/blob/${BRANCH}`,
          isPage: (slug) => pageSlugs.has(slug),
        }),
        focusableTables(),
        responsiveTables(),
      ],
    }),
  },
  integrations: [
    starlight({
      title: 'opencode-claude-code-plugin',
      description:
        "Run Anthropic's Claude models in opencode through the official Claude Code CLI. Your CLI's login, Claude's own tools, opencode's permissions.",
      favicon: '/favicon.svg',
      customCss: ['./src/styles/custom.css'],
      components: {
        Hero: './src/components/Hero.astro',
        // The wordmark as HTML in the site's own mono, not an SVG image (no `logo`
        // above): same type as the page, takes the theme, costs no request.
        SiteTitle: './src/components/SiteTitle.astro',
        // Every docs page opens with its bar-led title and its frontmatter description
        // as a lead paragraph.
        PageTitle: './src/components/PageTitle.astro',
        // Each wraps Starlight's default and adds the maintainer's Buy Me a Coffee link:
        // a compact control beside the GitHub and npm icons (and so in the mobile menu's
        // footer too), and the yellow button under every page's footer.
        SocialIcons: './src/components/SocialIcons.astro',
        Footer: './src/components/Footer.astro',
      },
      social: [
        { icon: 'github', label: 'GitHub', href: REPO },
        { icon: 'npm', label: 'npm', href: 'https://www.npmjs.com/package/@khalilgharbaoui/opencode-claude-code-plugin' },
      ],
      // Entry file paths are relative to this project (site/), and a content page's
      // is `../docs/<page>.md`, so the base is site/ and the browser normalises the
      // `..` away before the request leaves. The landing page resolves to
      // site/src/content/docs/index.mdx directly.
      editLink: { baseUrl: `${REPO}/edit/master/site/` },
      lastUpdated: true,
      credits: false,
      head: [
        // The one web font (Geist Mono, OFL, subset; see src/styles/custom.css), preloaded
        // so it is usually there before first paint. `crossorigin` is required for a font
        // preload to be reused by the @font-face request, even same-origin.
        {
          tag: 'link',
          attrs: {
            rel: 'preload',
            href: `${BASE.endsWith('/') ? BASE : `${BASE}/`}fonts/GeistMono-variable.woff2`,
            as: 'font',
            type: 'font/woff2',
            crossorigin: 'anonymous',
          },
        },
        { tag: 'meta', attrs: { property: 'og:image', content: new URL('social-preview.png', `${SITE}${BASE.endsWith('/') ? BASE : `${BASE}/`}`).href } },
        { tag: 'meta', attrs: { property: 'og:image:width', content: '1280' } },
        { tag: 'meta', attrs: { property: 'og:image:height', content: '640' } },
        { tag: 'meta', attrs: { name: 'twitter:card', content: 'summary_large_image' } },
        { tag: 'meta', attrs: { name: 'twitter:image', content: new URL('social-preview.png', `${SITE}${BASE.endsWith('/') ? BASE : `${BASE}/`}`).href } },
        { tag: 'meta', attrs: { name: 'theme-color', content: '#0E1013', media: '(prefers-color-scheme: dark)' } },
        { tag: 'meta', attrs: { name: 'theme-color', content: '#FCFBF8', media: '(prefers-color-scheme: light)' } },
        // The maintainer's Buy Me a Coffee widget, with the values they chose. It is
        // third-party JavaScript on every page, which the design's "nothing requested from a
        // visitor's browser" rule excluded; relaxed on purpose, at the maintainer's request,
        // and it is the only third-party request the site makes (the button images are
        // served from public/). Starlight renders `head` entries verbatim, so Astro neither
        // bundles nor hoists this. `defer` keeps it off the critical path and still runs it
        // before DOMContentLoaded, which the script needs: it looks up its own
        // <script data-name="BMC-Widget"> tag when it executes and builds the button inside
        // a DOMContentLoaded listener, so `async` could run it after that event has fired
        // and show nothing. `data-message` must stay present even though it is empty: the
        // script compares it to "" and would otherwise display the word "undefined".
        {
          tag: 'script',
          attrs: {
            'data-name': 'BMC-Widget',
            'data-cfasync': 'false',
            src: 'https://cdnjs.buymeacoffee.com/1.0.0/widget.prod.min.js',
            'data-id': 'khalilgharbaoui',
            'data-description': 'Support me on Buy me a coffee!',
            'data-message': '',
            'data-color': '#E8A33A',
            'data-position': 'Right',
            'data-x_margin': '18',
            'data-y_margin': '18',
            defer: true,
          },
        },
      ],
      // Information architecture. Directory groups are autogenerated so a new page
      // only needs frontmatter (`sidebar.order`) to land in the right place.
      sidebar: [
        {
          label: 'Start here',
          items: [
            { label: 'Introduction', slug: 'introduction' },
            { label: 'Getting started', slug: 'getting-started' },
            { label: 'opencode 2', slug: 'opencode-2' },
            { label: 'Models', slug: 'models' },
            { label: 'Billing', slug: 'billing' },
          ],
        },
        // Starlight 0.39+ spelling: the autogenerate config sits inside `items`.
        { label: 'Configuration', items: [{ autogenerate: { directory: 'configuration' } }] },
        { label: 'Guides', items: [{ autogenerate: { directory: 'guides' } }] },
        { label: 'Troubleshooting', items: [{ autogenerate: { directory: 'troubleshooting' } }] },
        { label: 'Internals', items: [{ autogenerate: { directory: 'internals' } }] },
        {
          label: 'About',
          items: [
            { label: 'How this compares', slug: 'comparison' },
            { label: 'Credits', slug: 'credits' },
            { label: 'License', slug: 'license' },
            { label: 'Releases', link: `${REPO}/releases`, attrs: { target: '_blank', rel: 'noopener' } },
          ],
        },
      ],
    }),
  ],
});
