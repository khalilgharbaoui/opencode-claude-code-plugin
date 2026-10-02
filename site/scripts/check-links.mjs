/*
  Checks every internal link in the built site, including fragments.

  Run after `npm run build`:  node scripts/check-links.mjs

  No dependency: the built pages are static HTML, so a regex over `href="..."` and
  `id="..."` is enough, and a link checker that needed an install would be one more
  package the lockfile-less docs workflow has to resolve. External links are listed
  but not fetched, because a build must not fail on somebody else's outage.
*/
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE as CONFIGURED_BASE } from '../site-config.mjs';

const root = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const dist = path.join(root, 'dist');
// Without its trailing slash, so a site served at the root checks against ''.
const BASE = CONFIGURED_BASE.replace(/\/$/, '');

if (!existsSync(dist)) {
  console.error('dist/ is missing: run `npm run build` first.');
  process.exit(2);
}

const pages = [...walk(dist)].filter((file) => file.endsWith('.html'));
const idsByPage = new Map();
const problems = [];
let internal = 0;
let external = 0;

for (const page of pages) {
  const html = readFileSync(page, 'utf8');
  // dist/ is served at BASE, so a page's URL is BASE + its path inside dist.
  const from = BASE + '/' + path.relative(dist, page).split(path.sep).join('/');

  for (const href of hrefs(html)) {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href)) {
      external += 1;
      continue;
    }
    if (href.startsWith('#')) {
      checkFragment(page, from, from, href.slice(1));
      internal += 1;
      continue;
    }

    const [targetPath, fragment] = split(href);
    const absolute = targetPath.startsWith('/')
      ? targetPath
      : path.posix.resolve(path.posix.dirname(from), targetPath);

    if (!absolute.startsWith(`${BASE}/`) && absolute !== BASE) {
      problems.push(`${from}: "${href}" escapes the base path (resolved to ${absolute})`);
      continue;
    }

    const withoutBase = absolute.slice(BASE.length) || '/';
    const file = resolveFile(withoutBase);
    internal += 1;
    if (!file) {
      problems.push(`${from}: "${href}" has no file in dist (resolved to ${absolute})`);
      continue;
    }
    if (fragment) checkFragment(file, from, href, fragment);
  }
}

function checkFragment(file, from, href, fragment) {
  const decoded = decodeURIComponent(fragment);
  if (!file.endsWith('.html')) return;
  let ids = idsByPage.get(file);
  if (!ids) {
    ids = new Set();
    const html = readFileSync(file, 'utf8');
    for (const match of html.matchAll(/\sid="([^"]+)"/g)) ids.add(match[1]);
    for (const match of html.matchAll(/\sname="([^"]+)"/g)) ids.add(match[1]);
    idsByPage.set(file, ids);
  }
  if (!ids.has(decoded) && !ids.has(fragment)) {
    problems.push(`${from}: "${href}" points at a fragment #${decoded} that does not exist`);
  }
}

function resolveFile(urlPath) {
  const candidates = urlPath.endsWith('/')
    ? [path.join(dist, urlPath, 'index.html')]
    : [path.join(dist, urlPath), path.join(dist, urlPath, 'index.html'), path.join(dist, `${urlPath}.html`)];
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
}

function split(href) {
  const index = href.indexOf('#');
  return index === -1 ? [href, ''] : [href.slice(0, index), href.slice(index + 1)];
}

function* hrefs(html) {
  for (const match of html.matchAll(/\shref="([^"]*)"/g)) {
    const value = match[1].trim();
    if (value) yield value;
  }
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

console.log(`${pages.length} pages, ${internal} internal links checked, ${external} external links skipped.`);
if (problems.length === 0) {
  console.log('No broken internal links.');
  process.exit(0);
}
for (const problem of problems) console.error(problem);
console.error(`\n${problems.length} broken internal link(s).`);
process.exit(1);
