/*
  One source of truth for the documentation.

  The content pages are the repository's own `docs/**.md`. GitHub renders them on
  their own (that is what a reader who never opens the site sees), and this site
  loads them from exactly those files rather than from a copy, so the two cannot
  drift. Nothing is generated into `docs/` and nothing is copied out of it.

  It is ONE glob loader over both roots on purpose. Astro's glob loader deletes
  every entry it did not touch at the end of its own `load()` (`untouchedEntries`
  in astro/dist/content/loaders/glob.js), so two loaders writing into one
  collection leaves only the second one's pages.

  Two things are deliberately not in the collection:

  - `docs/agents-history.md` is the maintainer's internal evidence log. It carries
    no frontmatter, it is addressed to maintainers and agents rather than to
    users, and giving it a title would mean rewriting it. The site links to it on
    GitHub instead, from `docs/internals/measurement-culture.md`.
  - files whose name starts with `_`, by the usual Astro convention.

  The landing page and the 404 page are the two site-only entries: they are MDX that
  imports the site's components, so they live beside them under
  `site/src/content/docs/`. Starlight takes a collection entry whose id is `404` as
  its 404 page (utils/routing/data.ts, `get404Route`).
*/
import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { docsSchema } from '@astrojs/starlight/schema';

/** Relative to this project's root (site/), which is what `base` is resolved against. */
const REPO_ROOT = '..';
const SITE_PAGES = 'site/src/content/docs';
const LANDING_PAGE = `${SITE_PAGES}/index`;
const NOT_FOUND_PAGE = `${SITE_PAGES}/404`;

export const collections = {
  docs: defineCollection({
    loader: glob({
      base: REPO_ROOT,
      pattern: [
        'docs/**/[^_]*.md',
        '!docs/agents-history.md',
        `${LANDING_PAGE}.mdx`,
        `${NOT_FOUND_PAGE}.mdx`,
      ],
      // Starlight keys its routes on the entry id, so both roots have to collapse
      // onto the slug the sidebar and every link already use: `docs/guides/btw.md`
      // is `guides/btw`, the landing page is `index` (Starlight's route '') and the
      // 404 page is `404`.
      generateId: ({ entry, data }) => {
        if (typeof data.slug === 'string' && data.slug) return data.slug;
        const withoutExtension = entry.replace(/\.mdx?$/, '');
        if (withoutExtension === LANDING_PAGE) return 'index';
        if (withoutExtension === NOT_FOUND_PAGE) return '404';
        return withoutExtension.replace(/^docs\//, '');
      },
    }),
    schema: docsSchema(),
  }),
};
