---
title: 'Releasing'
description: 'Tag push, trusted publishing, and what a failed publish actually means.'
sidebar:
  order: 7
---

```bash
npm version patch   # or minor/major, bumps package.json + creates the tag
git push origin master --follow-tags
```

The GitHub Actions workflow at `.github/workflows/publish.yml` runs `npm publish --access public` on tag push. Since v0.6.2 it authenticates with **npm trusted publishing (OIDC)**, not a token: the job holds `id-token: write`, upgrades npm first because OIDC needs npm 11.5.1 or newer, and passes no `NODE_AUTH_TOKEN`. The trusted publisher is configured on npmjs.com against this repository and the `publish.yml` workflow filename, so a publish that fails on auth means that configuration, not an expired secret. There is no `NPM_TOKEN` in the workflow.

## The docs site rebuilds itself

Nothing on [the site](https://opencode-claude-code-plugin.dev/) is fetched in a visitor's browser. Every figure is read while `astro build` runs, so the page is only as current as its last build, and `.github/workflows/docs.yml` is what makes that often enough to call live. It builds and deploys on four triggers:

| Trigger | When | Why |
|---|---|---|
| `workflow_run` on `Publish` | after a successful publish | A release pushes a tag, not a branch, and bumps `package.json`. Without this the site kept announcing the previous version. The run first polls `registry.npmjs.org` until it serves the version in `package.json`, bounded at ten minutes, because the version document lags the publish itself; a timeout builds anyway and logs a warning. |
| `push` to `master` | `docs/**`, `site/**`, `README.md`, `AGENTS.md`, `src/**`, `test-*.ts`, `package.json`, `skills/**` | Every path that feeds a page or a number. |
| `schedule` | every six hours | Stars, forks, contributors and downloads move without a commit here. |
| `workflow_dispatch` | by hand | For a rebuild that none of the above covers. |

One `pages` concurrency group with `cancel-in-progress`, so a cron tick that overlaps a release rebuild is cancelled rather than queued and two runs can never deploy out of order. A failed or cancelled `Publish` deploys nothing.

Where each number comes from, all of it in `site/src/data/stats.ts`:

| Number | Source |
|---|---|
| stars, forks, repository created | `api.github.com/repos/...` |
| contributors, tagged releases | the paginated GitHub lists, counted by following `rel="next"` |
| merged pull requests | the GitHub search API |
| downloads: last week, last month, total | `api.npmjs.org`, the total summed over the daily range since the first publish |
| published version | `registry.npmjs.org/<package>/latest` |
| tests in the suite | `OCC_STAT_TESTS`, parsed from the runner's own `tests N` summary line in the workflow, never grepped out of source |
| models registered | `OCC_STAT_MODELS`, the entries of `defaultModels` in `src/models.ts` |
| commits, first commit date | `git` in the checkout, which the workflow takes with `fetch-depth: 0` |
| test files and their line count | `test-*.ts` read off the repository |

Each source is attempted on its own and falls back to `site/src/data/stats.snapshot.json`, so one slow API cannot blank the strip. A build that fell back says which fields did, in the build log and in the strip's own footnote. Refresh that snapshot when it drifts far enough that a fallback build would read as wrong.

Two of these figures are republished as shields.io endpoint badges for the README, so no count is hand-typed there: `/badges/tests.json` and `/badges/models.json`.
