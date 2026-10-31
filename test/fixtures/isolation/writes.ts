/**
 * What a test file writes outside its own scratch tree when nothing isolates
 * it: a log line, a record in three stores and a model-catalog probe.
 * `test/isolation.test.ts` runs it in a child process twice over, behind
 * `test/isolate.ts` (`isolated.ts`) and without it (`unisolated.ts`, the
 * control), and reads what it reports from `ISOLATION_FIXTURE_REPORT`.
 */
import { existsSync, writeFileSync } from "node:fs"
import { test } from "node:test"

import { refreshCliModelCatalog } from "../../../src/cli-model-catalog.js"
import { describeLogFile, log } from "../../../src/logger.js"
import { recordResumePoint, resumeStorePath } from "../../../src/session-resume-store.js"
import { recordSessionSpawn, spawnRecordStorePath } from "../../../src/spawn-record-store.js"
import { recordTurnSample, turnHistoryStorePath } from "../../../src/turn-history.js"

test("a test file writes a log line, three store records and probes the CLI", async () => {
  log.warn("isolation fixture line")
  recordResumePoint(
    '/tmp/isolation::claude-test-isolation::tools::ses_isolation::context=["claude-code",null]',
    "11111111-2222-4333-8444-555555555555",
    [{ role: "user", content: [{ type: "text", text: "hello" }] }] as never,
    "/tmp/isolation/fake-claude.cjs",
  )
  recordTurnSample("main/claude-test-isolation", { ms: 1, at: Date.now() })
  recordSessionSpawn("ses_isolation", { model: "claude-test-isolation" })
  const probe = await refreshCliModelCatalog({ cliPath: "/nonexistent/claude-isolation-fixture" })
  const stores = [resumeStorePath(), turnHistoryStorePath(), spawnRecordStorePath()]
  writeFileSync(
    process.env.ISOLATION_FIXTURE_REPORT!,
    JSON.stringify({
      stateHome: process.env.XDG_STATE_HOME ?? null,
      cacheHome: process.env.XDG_CACHE_HOME ?? null,
      logFile: describeLogFile(),
      probe,
      stores: stores.map((path) => ({ path, written: existsSync(path) })),
    }),
  )
})
