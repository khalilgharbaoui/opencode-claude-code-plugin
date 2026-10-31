/**
 * Every test file imports this before anything else, so no way of running one
 * can reach the operator's live plugin log, state stores, account wrappers or
 * real `claude` (h #g283).
 *
 * The `test` script's env used to be the only guard, so a focused
 * `npx tsx --test test/<file>.test.ts` inherited the maintainer's exported
 * `OPENCODE_CLAUDE_CODE_LOG_FILE=1` and an unset `XDG_STATE_HOME`: fixture
 * lines landed in the live `plugin.log` and fake models, fake CLIs and fixture
 * sessions in the live stores. Doing it here covers `npm test`, a focused
 * `--test` run and a direct `npx tsx test/<file>.ts` alike.
 *
 * Each process gets its own scratch root, not one per suite run: a store is
 * merge-on-write with no lock between processes, so two test files sharing
 * one `XDG_STATE_HOME` could overwrite each other's records mid-test.
 *
 * Static imports evaluate in order, so this must stay the first import and
 * must import nothing from `src/`: the logger reads its env at import time.
 * `test/isolation.test.ts` enforces both. A test that exercises file logging
 * still opts in by setting `OPENCODE_CLAUDE_CODE_LOG_FILE=1` itself.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const root = mkdtempSync(join(tmpdir(), "opencode-test-isolation-"))

process.env.OPENCODE_CLAUDE_CODE_LOG_FILE = "0"
process.env.OPENCODE_CLAUDE_CODE_LOG_DIR = join(root, "log")
process.env.OPENCODE_CLAUDE_CODE_MODEL_PROBE = "0"
process.env.XDG_STATE_HOME = join(root, "state")
process.env.XDG_CACHE_HOME = join(root, "cache")

process.once("exit", () => rmSync(root, { recursive: true, force: true }))
