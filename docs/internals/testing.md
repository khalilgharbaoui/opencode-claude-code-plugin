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

- **`npm test` enumerates its files explicitly.** A new `test-*.ts` that is not added to the
  `test` script in `package.json` silently never runs.
- **Never pipe `npm test` into `grep` inside an `&&` chain.** The pipeline exits with grep's
  status, not the runner's, so a red suite reads as green and the chain continues. Redirect and
  check instead: `npm test > /tmp/run.log 2>&1; echo "EXIT=$?"`, then grep the file.
- **The `test` script forces `OPENCODE_CLAUDE_CODE_LOG_FILE=0`.** Without it a run appends
  fixture lines and fake `plugin ready` blocks to the live `plugin.log`, which the next person
  to read that log will take for a broken install.

Two further traps are about load rather than correctness. A spec must never race the CLI
version probe's 5-second deadline, because on a loaded machine it loses and the feature under
test is refused as "CLI too old"; resolve the probe up front instead. And the fake-CLI recovery
tests in `test-proxy-task.ts` derive every wait from the start watchdog, so under load they
fail identically on master and on a released tag: run the same file at the last known-green tag
before suspecting your change.
