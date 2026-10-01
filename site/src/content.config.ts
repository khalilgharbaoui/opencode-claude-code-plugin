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

  The landing page is the one site-only entry: it is MDX that imports the landing
  components, so it lives beside them under `site/src/content/docs/`.
*/
import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { docsSchema } from '@astrojs/starlight/schema';

/** Relative to this project's root (site/), which is what `base` is resolved against. */
const REPO_ROOT = '..';
const LANDING_PAGE = 'site/src/content/docs/index';

export const collections = {
  docs: defineCollection({
    loader: glob({
      base: REPO_ROOT,
      pattern: [
        'docs/**/[^_]*.md',
        '!docs/agents-history.md',
        `${LANDING_PAGE}.mdx`,
      ],
      // Starlight keys its routes on the entry id, so both roots have to collapse
      // onto the slug the sidebar and every link already use: `docs/guides/btw.md`
      // is `guides/btw`, and the landing page is `index` (Starlight's route '').
      generateId: ({ entry, data }) => {
        if (typeof data.slug === 'string' && data.slug) return data.slug;
        const withoutExtension = entry.replace(/\.mdx?$/, '');
        if (withoutExtension === LANDING_PAGE) return 'index';
        return withoutExtension.replace(/^docs\//, '');
      },
    }),
    schema: docsSchema(),
  }),
};
