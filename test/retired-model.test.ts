/**
 * A retired model (h #g302): `claude-sonnet-4-5`, which Anthropic retires on
 * the Claude API on 2026-11-30 (the model-deprecations page, replacement
 * `claude-sonnet-5-5`). After that a request to it fails, and Claude Code
 * does not remap it (its legacy remap covers Opus 4.0 and 4.1 only).
 *
 * It is no longer registered, and every place the plugin resolves a model
 * itself still takes it and runs `claude-sonnet-5-5` with one WARN naming the
 * replacement and both prices: `parseModelId`, `qualifyModelName` (so
 * `forceModel`, `defaultSubagentModel` and `fallbackModels`), and the model
 * catalog never adds it back. The argv a real `doStream` hands `claude` is in
 * `test/retired-model-stream.test.ts`, which is POSIX-only.
 *
 * Usage: npx tsx --test test/retired-model.test.ts
 */
import "./isolate.js"
import assert from "node:assert/strict"
import { test } from "node:test"

import {
  _resetRetiredModelReports,
  isRegisteredModelName,
  qualifyModelName,
  reportRetiredModel,
  resolveAgentModel,
} from "../src/agent-models.js"
import { overlayCliCatalog, pickerModelIds } from "../src/cli-model-catalog.js"
import { configureLogger, _resetLoggerForTests } from "../src/logger.js"
import { resolveFallbackChain } from "../src/model-fallback.js"
import {
  defaultModels,
  parseModelId,
  RETIRED_MODELS,
  retiredModel,
  servedModelId,
} from "../src/models.js"

const RETIRED = "claude-sonnet-4-5"
const INSTEAD = "claude-sonnet-5-5"

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
  lines.filter((line) => /WARN/.test(line) && /is retired on the Claude API/.test(line))

test("the retired model is no longer registered, and its replacement is", () => {
  assert.equal(Object.hasOwn(defaultModels, RETIRED), false)
  assert.deepEqual(RETIRED_MODELS[RETIRED], {
    retiredOn: "2026-11-30",
    instead: INSTEAD,
    price: { input: 3, output: 15 },
  })
  assert.equal(RETIRED_MODELS["claude-sonnet-4-5-20250929"]?.instead, INSTEAD)
  assert.ok(Object.hasOwn(defaultModels, INSTEAD))
  // The rest of the Sonnet line is untouched.
  for (const live of ["claude-sonnet-4-6", "claude-sonnet-5", INSTEAD]) {
    assert.equal(retiredModel(live), null, live)
  }
})

test("parseModelId and servedModelId hand the CLI the replacement, the account marker kept", () => {
  assert.deepEqual(parseModelId(RETIRED), { model: INSTEAD, fast: false })
  assert.deepEqual(parseModelId(`${RETIRED}@work`), { model: `${INSTEAD}@work`, fast: false })
  assert.deepEqual(parseModelId("claude-sonnet-4-5-20250929"), { model: INSTEAD, fast: false })
  assert.equal(servedModelId(RETIRED), INSTEAD)
  assert.equal(servedModelId(`${RETIRED}@work`), `${INSTEAD}@work`)
  // Anything else is unchanged.
  assert.equal(servedModelId("claude-sonnet-4-6@work"), "claude-sonnet-4-6@work")
  assert.equal(servedModelId("claude-opus-5-5-fast"), "claude-opus-5-5-fast")
  assert.deepEqual(parseModelId("claude-sonnet-4-6"), { model: "claude-sonnet-4-6", fast: false })
})

test("retiredModel reads through the account marker and prices the replacement from the catalog", () => {
  assert.deepEqual(retiredModel(`${RETIRED}@work`), {
    model: RETIRED,
    retiredOn: "2026-11-30",
    instead: INSTEAD,
    price: { input: 3, output: 15 },
    insteadPrice: { input: defaultModels[INSTEAD]!.cost.input, output: defaultModels[INSTEAD]!.cost.output },
  })
  assert.deepEqual(retiredModel(RETIRED)?.insteadPrice, { input: 2, output: 10 })
})

test("reportRetiredModel warns once per id per process, naming the replacement and both prices", async () => {
  _resetRetiredModelReports()
  const lines = await captureLogs(() => {
    assert.equal(reportRetiredModel(RETIRED), true)
    assert.equal(reportRetiredModel(`${RETIRED}@work`), true)
    assert.equal(reportRetiredModel(INSTEAD), false)
    assert.equal(reportRetiredModel("claude-opus-4-8-fast"), false)
  })
  const warned = warnings(lines)
  assert.equal(warned.length, 1)
  assert.match(warned[0]!, /claude-sonnet-4-5 is retired on the Claude API on 2026-11-30/)
  assert.match(warned[0]!, /runs as claude-sonnet-5-5 \(\$2\/\$10, against \$3\/\$15 per million/)
  assert.match(warned[0]!, /"insteadInputUsd":2/)
  assert.match(warned[0]!, /"outputUsd":15/)
})

test("config naming the retired id still resolves it, where opencode's own completion does not", () => {
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
  assert.equal(qualifyModelName("claude-sonnet-4-4", "claude-opus-5"), null)
})

test("the model catalog never adds the retired id back, even if a picker lists it", () => {
  const init = {
    models: [
      { value: "sonnet", resolvedModel: RETIRED },
      { value: "claude-sonnet-9-9", resolvedModel: "claude-sonnet-9-9" },
    ],
  }
  assert.deepEqual(pickerModelIds(init), ["claude-sonnet-9-9"])
  const overlaid = overlayCliCatalog(defaultModels, {
    models: {},
    added: {
      [RETIRED]: { known: true, window: 200_000, efforts: [] },
      "claude-sonnet-9-9": { known: true, window: 1_000_000, efforts: [] },
    },
  } as never)
  assert.equal(Object.hasOwn(overlaid, RETIRED), false)
  assert.ok(Object.hasOwn(overlaid, "claude-sonnet-9-9"))
})
