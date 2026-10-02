// Where the docs site is served. This is the one place to change when the domain
// moves: astro.config.mjs and scripts/check-links.mjs both import it. (The README,
// package.json `homepage`, the README's tests badge and the bundled skill name the
// address too, as plain text, because they are read outside this site.)
export const SITE = 'https://opencode-claude-code-plugin.dev';

/** The path the site is served under: `/` at the root of its own domain. */
export const BASE = '/';
