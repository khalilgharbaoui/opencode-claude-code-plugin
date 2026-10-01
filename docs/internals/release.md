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
