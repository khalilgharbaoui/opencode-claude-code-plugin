---
title: 'Testing'
description: 'How the suite is built, how to run it, and the three ways a green run can lie to you.'
sidebar:
  order: 5
---

```bash
npm run typecheck   # tsc --noEmit
npm test            # tsx --test, the unit suite
npm run build       # tsup -> dist/
```

Run all three before a release, in that order.

## What the suite is

The tests are plain `node:test` files at the repository root, one per subject, driven through
`tsx`. A large part of the suite is not unit-shaped: a dozen files spawn a **fake `claude`**
and drive a real `doStream` turn through it, so the stream parser, the proxy broker, both
watchdogs, abort, respawn, account failover and the model fallback chain are exercised end to
end rather than mocked at the edge. `src/turn-state.ts`, `src/turn-controller.ts` and
`src/stream-parser.ts` have no test file of their own on purpose: they *are* the turn, so
those fake-CLI files are the oracle, and a test written against their shape would only assert
that the shape exists.

The full map from a subject to the file that covers it is the "Tests to touch when editing"
section of [`AGENTS.md`](../../AGENTS.md). Consult it before changing anything; it is kept
current in the same change as the code.

## Three ways a run can mislead you

- **Tests live in `test/`, one `<name>.test.ts` per area, and `npm test` runs the glob
  `test/*.test.ts`.** A new file runs without being registered anywhere. Fixtures are in
  `test/fixtures/`. `test/integration.ts` and `test/e2e-claude-session-bun.ts` are manual runs
  against a real `claude` and are deliberately outside the glob.
- **The interactive transport has recorded transcripts per Claude Code release** under
  `test/fixtures/interactive/<version>/`, which `test/interactive-golden.test.ts` replays through
  the real session against what the live turn returned. Record a new release with
  `bun scripts/record-interactive-fixtures.ts` (a few cheap Haiku turns on a logged-in `claude`);
  it redacts paths, thinking text and hook details on the way.
- **Never pipe `npm test` into `grep` inside an `&&` chain.** The pipeline exits with grep's
  status, not the runner's, so a red suite reads as green and the chain continues. Redirect and
  check instead: `npm test > /tmp/run.log 2>&1; echo "EXIT=$?"`, then grep the file.
- **The `test` script forces `OPENCODE_CLAUDE_CODE_LOG_FILE=0`.** Without it a run appends
  fixture lines and fake `plugin ready` blocks to the live `plugin.log`, which the next person
  to read that log will take for a broken install.
- **It also gives every run a fresh `XDG_STATE_HOME` (`mktemp -d`).** Fake-CLI turns finish
  successfully, and each one would otherwise record a resume point in the operator's real
  `claude-sessions.json` (see `resumeAfterRestart`). Run a single file the same way:
  `XDG_STATE_HOME=$(mktemp -d) npx tsx --test test/<name>.test.ts`.

Two further traps are about load rather than correctness. A spec must never race the CLI
version probe's 5-second deadline, because on a loaded machine it loses and the feature under
test is refused as "CLI too old"; resolve the probe up front instead. And the fake-CLI recovery
tests in `test/proxy-task.test.ts` derive every wait from the start watchdog, so under load they
fail identically on master and on a released tag: run the same file at the last known-green tag
before suspecting your change.
