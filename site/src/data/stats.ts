/*
  Build-time project numbers.

  Everything here runs inside `astro build`, never in a visitor's browser. The page is
  static HTML; the only reason the numbers move is that the site is rebuilt daily by
  `.github/workflows/docs.yml`. Each source is fetched independently and falls back to
  the committed snapshot on its own, so one slow API never blanks the whole strip.

  Sources:
    GitHub REST  stars, forks, contributors, tag count, merged PR count
    api.npmjs.org  downloads (last week, last month, and the total since the first publish)
    registry.npmjs.org  the published version
    the workflow  OCC_STAT_TESTS and OCC_STAT_MODELS, parsed from the suite and the source
*/
import snapshot from './stats.snapshot.json';

export interface ProjectStats {
  stars: number;
  forks: number;
  contributors: number;
  releases: number;
  mergedPrs: number;
  downloadsWeek: number;
  downloadsMonth: number;
  downloadsTotal: number;
  downloadsSince: string;
  tests: number;
  testFiles: number;
  models: number;
  npmVersion: string;
  repoCreated: string;
  /** ISO date of this build. */
  builtAt: string;
  /** True when every GitHub and npm field came from the network in this build. */
  live: boolean;
  /** Fields that fell back to the snapshot, for the build log and the strip footnote. */
  fallbacks: string[];
}

const REPO = 'khalilgharbaoui/opencode-claude-code-plugin';
const PACKAGE = '@khalilgharbaoui/opencode-claude-code-plugin';
const TIMEOUT_MS = 8000;

let cached: Promise<ProjectStats> | undefined;

/** One fetch per build, shared by every component that asks. */
export function loadStats(): Promise<ProjectStats> {
  cached ??= collect();
  return cached;
}

async function getJson<T>(url: string, headers: Record<string, string> = {}): Promise<T> {
  const response = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'occ-docs-build', ...headers },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return (await response.json()) as T;
}

function githubHeaders(): Record<string, string> {
  const token = process.env.GITHUB_TOKEN;
  return token ? { authorization: `Bearer ${token}` } : {};
}

async function githubRepo() {
  const data = await getJson<{ stargazers_count: number; forks_count: number; created_at: string }>(
    `https://api.github.com/repos/${REPO}`,
    githubHeaders()
  );
  return { stars: data.stargazers_count, forks: data.forks_count, repoCreated: data.created_at.slice(0, 10) };
}

/** Counts a paginated GitHub list without reading it all into memory: follows `rel="next"`. */
async function githubListCount(path: string): Promise<number> {
  let url: string | undefined = `https://api.github.com/repos/${REPO}/${path}?per_page=100`;
  let count = 0;
  for (let page = 0; url && page < 10; page += 1) {
    const response = await fetch(url, {
      headers: { accept: 'application/json', 'user-agent': 'occ-docs-build', ...githubHeaders() },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`${url} answered ${response.status}`);
    const items = (await response.json()) as unknown[];
    count += items.length;
    const link = response.headers.get('link') ?? '';
    url = /<([^>]+)>;\s*rel="next"/.exec(link)?.[1];
  }
  return count;
}

async function githubMergedPrs(): Promise<number> {
  const data = await getJson<{ total_count: number }>(
    `https://api.github.com/search/issues?q=repo:${REPO}+is:pr+is:merged`,
    githubHeaders()
  );
  return data.total_count;
}

async function npmPoint(period: 'last-week' | 'last-month'): Promise<number> {
  const data = await getJson<{ downloads: number }>(`https://api.npmjs.org/downloads/point/${period}/${PACKAGE}`);
  return data.downloads;
}

/** The npm range endpoint caps a request at 18 months; this package is younger than that. */
async function npmTotal(since: string, until: string): Promise<number> {
  const data = await getJson<{ downloads: { downloads: number }[] }>(
    `https://api.npmjs.org/downloads/range/${since}:${until}/${PACKAGE}`
  );
  return data.downloads.reduce((sum, day) => sum + day.downloads, 0);
}

async function npmVersion(): Promise<string> {
  const data = await getJson<{ version: string }>(`https://registry.npmjs.org/${PACKAGE}/latest`);
  return data.version;
}

function envNumber(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const value = Number.parseInt(raw.replace(/[^0-9]/g, ''), 10);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

async function collect(): Promise<ProjectStats> {
  const builtAt = new Date().toISOString().slice(0, 10);
  const fallbacks: string[] = [];

  async function attempt<T>(label: string, task: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await task();
    } catch (error) {
      fallbacks.push(label);
      console.warn(`[occ-docs] ${label}: using snapshot (${(error as Error).message})`);
      return fallback;
    }
  }

  const [repo, contributors, releases, mergedPrs, downloadsWeek, downloadsMonth, downloadsTotal, version] =
    await Promise.all([
      attempt('github repo', githubRepo, {
        stars: snapshot.stars,
        forks: snapshot.forks,
        repoCreated: snapshot.repoCreated,
      }),
      attempt('github contributors', () => githubListCount('contributors'), snapshot.contributors),
      attempt('github tags', () => githubListCount('tags'), snapshot.releases),
      attempt('github merged prs', githubMergedPrs, snapshot.mergedPrs),
      attempt('npm last week', () => npmPoint('last-week'), snapshot.downloadsWeek),
      attempt('npm last month', () => npmPoint('last-month'), snapshot.downloadsMonth),
      attempt('npm total', () => npmTotal(snapshot.downloadsSince, builtAt), snapshot.downloadsTotal),
      attempt('npm version', npmVersion, snapshot.npmVersion),
    ]);

  const tests = envNumber('OCC_STAT_TESTS') ?? snapshot.tests;
  const models = envNumber('OCC_STAT_MODELS') ?? snapshot.models;
  if (!envNumber('OCC_STAT_TESTS')) fallbacks.push('tests (OCC_STAT_TESTS unset)');
  if (!envNumber('OCC_STAT_MODELS')) fallbacks.push('models (OCC_STAT_MODELS unset)');

  return {
    ...repo,
    contributors,
    releases,
    mergedPrs,
    downloadsWeek,
    downloadsMonth,
    downloadsTotal,
    downloadsSince: snapshot.downloadsSince,
    tests,
    testFiles: snapshot.testFiles,
    models,
    npmVersion: version,
    builtAt,
    live: fallbacks.filter((label) => !label.startsWith('tests') && !label.startsWith('models')).length === 0,
    fallbacks,
  };
}

export function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}
