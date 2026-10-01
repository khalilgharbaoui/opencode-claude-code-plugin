/*
  Keeps one set of links working in two places.

  The content pages under docs/ are read by GitHub, where a relative path to
  another file is the only thing that works, and by this site, where the same
  page is a route under `base`. So every page is written with ordinary relative
  links (`./configuration/options.md`, `../AGENTS.md`) and this plugin rewrites
  them while the site builds:

  - a link that resolves to a page in the collection becomes its route,
    `<base>/configuration/options/`, with any hash preserved;
  - anything else in the repository, `docs/agents-history.md` (deliberately not a
    page, see src/content.config.ts) and `AGENTS.md` among them, becomes a GitHub
    blob URL on the default branch.

  This is a Sätteri hast plugin because Sätteri is Astro 7's default Markdown
  processor; `markdown.rehypePlugins` would mean switching the whole pipeline to
  unified and adding a second Markdown engine to the build.
*/
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i;
const MARKDOWN = /\.md$/i;

/**
 * @param {object} options
 * @param {string} options.repoRoot absolute path of the repository root
 * @param {string} options.base the site's base path, e.g. "/opencode-claude-code-plugin"
 * @param {string} options.blobUrl e.g. "https://github.com/owner/name/blob/master"
 * @param {(slug: string) => boolean} options.isPage whether a docs-relative slug is a built page
 */
export function repoLinks({ repoRoot, base, blobUrl, isPage }) {
  const docsRoot = path.join(repoRoot, 'docs');
  const prefix = base.replace(/\/$/, '');

  return {
    name: 'occ-repo-links',
    element: {
      filter: ['a'],
      visit(node, ctx) {
        const href = node.properties?.href;
        if (typeof href !== 'string' || !href || EXTERNAL.test(href)) return;

        if (href.startsWith('/') || !ctx.fileURL) return;

        const [target, hash] = splitHash(href);
        const resolved = path.resolve(path.dirname(fileURLToPath(ctx.fileURL)), target);
        const fromDocs = path.relative(docsRoot, resolved);
        const inDocs = !fromDocs.startsWith('..') && !path.isAbsolute(fromDocs);

        if (MARKDOWN.test(target) && inDocs) {
          const slug = fromDocs.split(path.sep).join('/').replace(MARKDOWN, '');
          if (isPage(slug)) {
            ctx.setProperty(node, 'href', `${prefix}/${slug}/${hash}`);
            return;
          }
        }

        // Anything else that is a real file in the repository: AGENTS.md, LICENSE,
        // docs/agents-history.md. Leave a link that resolves to nothing alone, so the
        // link checker reports it instead of this plugin hiding it behind a 404.
        const fromRepo = path.relative(repoRoot, resolved);
        if (fromRepo.startsWith('..') || path.isAbsolute(fromRepo) || !existsSync(resolved)) return;
        ctx.setProperty(node, 'href', `${blobUrl}/${fromRepo.split(path.sep).join('/')}${hash}`);
      },
    },
  };
}

function splitHash(href) {
  const index = href.indexOf('#');
  return index === -1 ? [href, ''] : [href.slice(0, index), href.slice(index)];
}
