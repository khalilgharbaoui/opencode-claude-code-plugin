/**
 * A retired fast-mode id (h #g298): `claude-opus-4-8-fast`, whose fast mode
 * Anthropic removed on 2026-11-30 (Claude Code 2.1.316's CHANGELOG: a fast
 * request on Opus 4.8 then "return[s] an error and do[es] not fall back").
 *
 * It is no longer registered, and every place the plugin resolves a model
 * itself still takes it and runs Opus 4.8 at standard speed with one WARN:
 * `parseModelId`, `qualifyModelName` (so `forceModel`, `defaultSubagentModel`
 * and `fallbackModels`). The argv a real `doStream` hands `claude` is in
 * `test/retired-fast-model-stream.test.ts`, which is POSIX-only.
 *
 * Usage: npx tsx --test test/retired-fast-model.test.ts
 */
import "./isolate.js"
import assert from "node:assert/strict"
import { test } from "node:test"

import {
  isRegisteredModelName,
  qualifyModelName,
  resolveAgentModel,
} from "../src/agent-models.js"
import { _resetFastModeWarnings, reportRetiredFastModel } from "../src/fast-mode.js"
import { configureLogger, _resetLoggerForTests } from "../src/logger.js"
import { resolveFallbackChain } from "../src/model-fallback.js"
import {
  defaultModels,
  parseModelId,
  RETIRED_FAST_MODELS,
  retiredFastModel,
} from "../src/models.js"

const RETIRED = "claude-opus-4-8-fast"

/** Everything the logger writes while `fn` runs, debug included. */
async function captureLogs(fn: () => unknown): Promise<string[]> {
  const lines: string[] = []
  const original = console.error
  console.error = (line: unknown) => {
    lines.push(String(line))
  }
  try {
    _resetLoggerForTests()
    configureLogger({ mode: "debug", level: "debug" })
    await fn()
  } finally {
    console.error = original
    _resetLoggerForTests()
  }
  return lines
}

const warnings = (lines: string[]) =>
  lines.filter((line) => /WARN/.test(line) && /fast-mode model id is retired/.test(line))

test("the retired fast id is no longer registered, and the live fast ids still are", () => {
  assert.equal(Object.hasOwn(defaultModels, RETIRED), false)
  assert.deepEqual(RETIRED_FAST_MODELS[RETIRED], {
    removedOn: "2026-11-30",
    instead: "claude-opus-5-5-fast",
  })
  for (const live of [
    "claude-opus-5-fast",
    "claude-opus-5-5-fast",
    "claude-fable-5-2-fast",
    "claude-mythos-5-2-fast",
  ]) {
    assert.ok(Object.hasOwn(defaultModels, live), live)
    assert.equal(retiredFastModel(live), null, live)
  }
  // The base model is untouched: only its fast mode went away.
  assert.ok(Object.hasOwn(defaultModels, "claude-opus-4-8"))
})

test("parseModelId strips a retired fast id's marker and asks for no fast mode", () => {
  assert.deepEqual(parseModelId(RETIRED), { model: "claude-opus-4-8", fast: false })
  assert.deepEqual(parseModelId(`${RETIRED}@work`), { model: "claude-opus-4-8@work", fast: false })
  // A live fast id is unchanged.
  assert.deepEqual(parseModelId("claude-opus-5-5-fast@work"), {
    model: "claude-opus-5-5@work",
    fast: true,
  })
})

test("retiredFastModel reads through the account marker", () => {
  assert.deepEqual(retiredFastModel(`${RETIRED}@work`), {
    model: RETIRED,
    removedOn: "2026-11-30",
    instead: "claude-opus-5-5-fast",
  })
  assert.equal(retiredFastModel("claude-opus-4-8"), null)
  assert.equal(retiredFastModel("claude-something-fast"), null)
})

test("reportRetiredFastModel warns once per id per process and names the replacement", async () => {
  _resetFastModeWarnings()
  const lines = await captureLogs(() => {
    assert.equal(reportRetiredFastModel(RETIRED), true)
    assert.equal(reportRetiredFastModel(`${RETIRED}@work`), true)
    assert.equal(reportRetiredFastModel("claude-opus-5-5-fast"), false)
    assert.equal(reportRetiredFastModel("claude-opus-4-8"), false)
  })
  const warned = warnings(lines)
  assert.equal(warned.length, 1)
  assert.match(warned[0]!, /claude-opus-5-5-fast/)
  assert.match(warned[0]!, /2026-11-30/)
})

test("config naming the retired id still resolves it, where opencode's own completion does not", () => {
  // `forceModel`, `defaultSubagentModel` and `fallbackModels` all go through
  // `qualifyModelName`, which keeps the caller's account marker.
  assert.equal(qualifyModelName(RETIRED, "claude-opus-5@work"), `${RETIRED}@work`)
  assert.equal(
    resolveAgentModel("designer", "claude-opus-5", {
      records: { designer: { mode: "subagent", forceModel: RETIRED } },
    }),
    RETIRED,
  )
  assert.equal(
    resolveAgentModel("helper", "claude-opus-5", {
      records: { helper: { mode: "subagent" } },
      defaultSubagentModel: RETIRED,
    }),
    RETIRED,
  )
  assert.deepEqual(
    resolveFallbackChain("builder", "claude-opus-5", {
      records: { builder: { mode: "primary", fallbackModels: [RETIRED] } },
    }),
    [RETIRED],
  )
  // A per-call subagent model is completed only from registered ids (h #g255),
  // because opencode no longer has this one to resolve.
  assert.equal(isRegisteredModelName(RETIRED), false)
  // An id that never existed is still refused.
  assert.equal(qualifyModelName("claude-opus-4-7-fast", "claude-opus-5"), null)
})
