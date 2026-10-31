/**
 * The model catalog as the installed Claude Code describes it (h #g279): what
 * one probe's answers are read as, how they are laid over the hand-kept
 * catalog, the store they are kept in, and what providers are registered with
 * on both opencode majors. Portable: nothing here spawns a process.
 *
 * The probe answers below are verbatim shapes from Claude Code 2.1.314
 * (`initialize` rows and `get_context_usage` with `detail: "summary"`).
 *
 * Usage: npx tsx --test test/cli-model-catalog.test.ts
 */
import "./isolate.js"
import assert from "node:assert/strict"
import { afterEach, beforeEach, test } from "node:test"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  type CliCatalogEntry,
  MAX_CATALOG_ENTRIES,
  _resetCliModelCatalogForTests,
  activateCliModelCatalog,
  binaryIdentity,
  catalogProbeIds,
  cliModelStorePath,
  describeCatalogDifferences,
  effectiveModels,
  factFromProbe,
  isCliAddedModel,
  nameFromModelId,
  overlayCliCatalog,
  pickerModelIds,
  probeArgs,
  probeEnv,
  readCatalogEntries,
  snapshotCliModelCatalog,
  writeCatalogEntry,
} from "../src/cli-model-catalog.js"
import { defaultModels } from "../src/models.js"
import { configModelsForProvider } from "../src/index.js"
import { planV2Providers } from "../src/v2.js"
import { isRegisteredModelName } from "../src/agent-models.js"

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cli-model-catalog-"))
  _resetCliModelCatalogForTests(join(dir, "state", "cli-models.json"))
})

afterEach(() => {
  _resetCliModelCatalogForTests()
  rmSync(dir, { recursive: true, force: true })
})

// What `initialize` answered for `--model claude-opus-4-6` on 2.1.314: the five
// picker rows, then the row the CLI appended for the `--model` itself.
const PICKER_ROWS = [
  {
    value: "default",
    resolvedModel: "claude-opus-5-5",
    displayName: "Default (recommended)",
    description: "Opus 5.5 · Best for everyday, complex tasks",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    supportsFastMode: true,
  },
  {
    value: "opus",
    resolvedModel: "claude-opus-5-5",
    displayName: "Opus",
    description: "Opus 5.5 · Best for everyday, complex tasks",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    supportsFastMode: true,
  },
  {
    value: "claude-fable-5-1[1m]",
    resolvedModel: "claude-fable-5-1",
    displayName: "Fable",
    description: "Fable 5.1 · Most capable",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    value: "sonnet",
    resolvedModel: "claude-sonnet-5-5",
    displayName: "Sonnet",
    description: "Sonnet 5.5",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    value: "haiku",
    resolvedModel: "claude-haiku-5-5",
    displayName: "Haiku",
    description: "Haiku 5.5",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
  },
]

const init = (...extra: Record<string, unknown>[]) => ({
  claude_code_version: "2.1.314",
  models: [...PICKER_ROWS, ...extra],
})
const usage = (rawMaxTokens: unknown) => ({ maxTokens: rawMaxTokens, rawMaxTokens })

test("a catalog model's own row gives its effort levels and the summary gives its window", () => {
  const fact = factFromProbe(
    "claude-opus-4-6",
    init({
      value: "claude-opus-4-6",
      resolvedModel: "claude-opus-4-6",
      displayName: "Opus 4.6",
      description: "Newer version available · select Opus for Opus 5.5",
      supportsEffort: true,
      supportedEffortLevels: ["low", "medium", "high", "max"],
    }),
    usage(200_000),
  )
  assert.deepEqual(fact, {
    known: true,
    window: 200_000,
    efforts: ["low", "medium", "high", "max"],
    name: "Opus 4.6",
  })
})

test("a model the picker already resolves to is read off that row, never `default`", () => {
  const fact = factFromProbe("claude-opus-5-5", init(), usage(1_000_000))
  assert.deepEqual(fact, {
    known: true,
    window: 1_000_000,
    efforts: ["low", "medium", "high", "xhigh", "max"],
    fast: true,
  })
})

test("a model with no effort support reads as an empty list, not as unknown", () => {
  const fact = factFromProbe(
    "claude-sonnet-4-5",
    init({ value: "claude-sonnet-4-5", resolvedModel: "claude-sonnet-4-5", displayName: "Sonnet 4.5", description: "x" }),
    usage(200_000),
  )
  assert.deepEqual(fact?.efforts, [])
  assert.equal(fact?.known, true)
})

test("an id the CLI does not know is the row whose display name is the raw id", () => {
  const fact = factFromProbe(
    "claude-sonnet-9-9",
    init({
      value: "claude-sonnet-9-9",
      resolvedModel: "claude-sonnet-9-9",
      displayName: "claude-sonnet-9-9",
      description: "Custom model",
      supportsEffort: true,
      supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    }),
    usage(200_000),
  )
  assert.equal(fact?.known, false)
  assert.equal(fact?.name, undefined)
})

test("Mythos says `Custom model (...)` and is still known, because its display name is not the id", () => {
  const fact = factFromProbe(
    "claude-mythos-5",
    init({
      value: "claude-mythos-5",
      resolvedModel: "claude-mythos-5",
      displayName: "Mythos 5",
      description: "Custom model (claude-mythos-5)",
      supportsEffort: true,
      supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    }),
    usage(1_000_000),
  )
  assert.equal(fact?.known, true)
})

test("an unknown effort level, a nonsense window and a missing model list are refused", () => {
  const fact = factFromProbe(
    "claude-opus-4-6",
    init({
      value: "claude-opus-4-6",
      displayName: "Opus 4.6",
      description: "x",
      supportsEffort: true,
      supportedEffortLevels: ["low", "ultra", "max"],
    }),
    usage(12),
  )
  assert.deepEqual(fact?.efforts, ["low", "max"])
  assert.equal(fact?.window, undefined)
  assert.equal(factFromProbe("claude-opus-4-6", { models: "nope" }, usage(200_000)), null)
  assert.equal(factFromProbe("claude-opus-4-6", undefined, usage(200_000)), null)
})

test("the picker's ids lose `[1m]` and anything that is not a first-party name", () => {
  const ids = pickerModelIds(
    init(
      { value: "us.anthropic.claude-opus-5-5-v1", displayName: "x", description: "x" },
      { value: "claude-opus-6[1m]", displayName: "Opus 6", description: "x" },
    ),
  )
  assert.deepEqual(ids.sort(), [
    "claude-fable-5-1",
    "claude-haiku-5-5",
    "claude-opus-5-5",
    "claude-opus-6",
    "claude-sonnet-5-5",
  ])
})

test("a dated snapshot id is never picked up or added, as 2.1.288's `haiku` row resolves to one", () => {
  const ids = pickerModelIds(
    init({ value: "haiku", resolvedModel: "claude-haiku-4-5-20251001", displayName: "Haiku", description: "x" }),
  )
  assert.ok(!ids.includes("claude-haiku-4-5-20251001"))
  const overlaid = overlayCliCatalog(
    defaultModels,
    entry({}, { "claude-haiku-4-5-20251001": { known: true, window: 200_000, efforts: [] } }),
  )
  assert.equal(overlaid["claude-haiku-4-5-20251001"], undefined)
})

test("the probe asks about every catalog id but our own -fast markers", () => {
  const ids = catalogProbeIds()
  assert.ok(ids.includes("claude-opus-5"))
  assert.ok(!ids.some((id) => id.endsWith("-fast")))
  assert.equal(ids.length, Object.keys(defaultModels).length - 3)
})

test("the probe argv is --bare, never a prompt, and its env holds no Anthropic credential", () => {
  const args = probeArgs("claude-opus-4-6")
  assert.ok(args.includes("--bare"))
  assert.ok(args.includes("--strict-mcp-config"))
  assert.ok(args.includes("--no-session-persistence"))
  assert.deepEqual(args.slice(-2), ["--model", "claude-opus-4-6"])
  const env = probeEnv({ ANTHROPIC_API_KEY: "sk-ant-x", ANTHROPIC_AUTH_TOKEN: "t", PATH: "/bin" })
  assert.equal(env.ANTHROPIC_API_KEY, undefined)
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined)
  assert.equal(env.PATH, "/bin")
  assert.equal(env.DISABLE_AUTOUPDATER, "1")
})

function entry(models: CliCatalogEntry["models"], added: CliCatalogEntry["added"] = {}): CliCatalogEntry {
  return { binary: "/opt/claude", size: 1, mtimeMs: 1, cliVersion: "2.1.314", probedAt: 1, models, added }
}

test("the overlay applies a known model's window and efforts, and a -fast entry follows its base", () => {
  const overlaid = overlayCliCatalog(
    defaultModels,
    entry({
      "claude-opus-4-7": { known: true, window: 300_000, efforts: ["low", "high"] },
      "claude-opus-5": { known: true, window: 1_000_000, efforts: ["medium", "max"] },
    }),
  )
  assert.equal(overlaid["claude-opus-4-7"]!.limit.context, 300_000)
  assert.equal(overlaid["claude-opus-4-7"]!.limit.output, 128_000, "output is the catalog's")
  assert.deepEqual(Object.keys(overlaid["claude-opus-4-7"]!.variants ?? {}), ["low", "high"])
  assert.deepEqual(Object.keys(overlaid["claude-opus-5-fast"]!.variants ?? {}), ["medium", "max"])
  assert.equal(overlaid["claude-opus-4-7"]!.cost, defaultModels["claude-opus-4-7"]!.cost, "prices stay")
  assert.equal(overlaid["claude-opus-4-7"]!.name, defaultModels["claude-opus-4-7"]!.name, "and so does (N×)")
  assert.equal(defaultModels["claude-opus-4-7"]!.limit.context, 1_000_000, "the catalog itself is untouched")
})

test("a model the CLI does not know keeps the catalog's numbers", () => {
  const overlaid = overlayCliCatalog(
    defaultModels,
    entry({ "claude-haiku-5-5": { known: false, window: 200_000, efforts: ["low"] } }),
  )
  assert.equal(overlaid["claude-haiku-5-5"], defaultModels["claude-haiku-5-5"])
})

test("efforts are never given to a model the catalog treats as non-reasoning", () => {
  const overlaid = overlayCliCatalog(
    defaultModels,
    entry({ "claude-haiku-4-5": { known: true, window: 200_000, efforts: ["low"] } }),
  )
  assert.equal(overlaid["claude-haiku-4-5"]!.variants, undefined)
})

test("an empty effort list removes the variants, as Sonnet 4.5's does", () => {
  const overlaid = overlayCliCatalog(
    defaultModels,
    entry({ "claude-opus-4-7": { known: true, efforts: [] } }),
  )
  assert.equal(overlaid["claude-opus-4-7"]!.variants, undefined)
  assert.equal(overlaid["claude-opus-4-7"]!.capabilities.reasoning, true, "it still thinks")
})

test("a model the CLI's picker resolves to is added on the pass-through template", () => {
  const overlaid = overlayCliCatalog(
    defaultModels,
    entry(
      {},
      {
        "claude-opus-6": { known: true, window: 1_000_000, efforts: ["low", "high", "max"], fast: true },
        "claude-sonnet-6-1": { known: true, name: "Sonnet 6.1" },
        "not-a-claude-id": { known: true },
      },
    ),
  )
  const opus = overlaid["claude-opus-6"]!
  assert.equal(opus.name, "Claude Opus 6")
  assert.equal(opus.family, "opus")
  assert.deepEqual(opus.cost, { input: 0, output: 0, cache: { read: 0, write: 0 } })
  assert.deepEqual(opus.limit, { context: 1_000_000, output: 64_000 })
  assert.deepEqual(Object.keys(opus.variants ?? {}), ["low", "high", "max"])
  assert.equal(overlaid["claude-sonnet-6-1"]!.name, "Claude Sonnet 6.1")
  assert.equal(overlaid["claude-sonnet-6-1"]!.limit.context, 200_000, "no window: the conservative one")
  assert.equal(overlaid["not-a-claude-id"], undefined)
  assert.ok(!Object.hasOwn(overlaid, "claude-opus-6-fast"), "no fast twin for an added model")
})

test("no entry, or a refused one, is the catalog itself", () => {
  assert.equal(overlayCliCatalog(defaultModels, null), defaultModels)
  const refused = { ...entry({ "claude-opus-4-7": { known: true, window: 300_000 } }), refused: "no-answer" }
  assert.equal(overlayCliCatalog(defaultModels, refused), defaultModels)
})

test("names are built from an id the way the catalog writes them", () => {
  assert.equal(nameFromModelId("claude-opus-6-1"), "Opus 6.1")
  assert.equal(nameFromModelId("claude-sonnet-6"), "Sonnet 6")
  assert.equal(nameFromModelId("claude-opus-4-5-20251101"), "Opus 4.5 20251101")
})

test("the differences name each change, each added model and each id the CLI does not know", () => {
  const differences = describeCatalogDifferences(
    defaultModels,
    entry(
      {
        "claude-opus-4-7": { known: true, window: 300_000 },
        "claude-sonnet-5": { known: true, efforts: ["low", "high"] },
        "claude-haiku-5-5": { known: false },
      },
      { "claude-opus-6": { known: true } },
    ),
  )
  assert.deepEqual(differences.changed, [
    { id: "claude-sonnet-5", field: "efforts", catalog: "low/medium/high/xhigh/max", cli: "low/high" },
    { id: "claude-opus-4-7", field: "context", catalog: "1000000", cli: "300000" },
  ])
  assert.deepEqual(differences.added, ["claude-opus-6"])
  assert.deepEqual(differences.unknown, ["claude-haiku-5-5"])
})

test("the hand-kept catalog already says what 2.1.314 says about the 4.x models", () => {
  // The facts the probe read on 2.1.288, 2.1.293 and 2.1.314 alike.
  const measured = entry({
    "claude-haiku-4-5": { known: true, window: 200_000, efforts: [] },
    "claude-sonnet-4-5": { known: true, window: 200_000, efforts: [] },
    "claude-sonnet-4-6": { known: true, window: 200_000, efforts: ["low", "medium", "high", "max"] },
    "claude-opus-4-5": { known: true, window: 200_000, efforts: ["low", "medium", "high"] },
    "claude-opus-4-6": { known: true, window: 200_000, efforts: ["low", "medium", "high", "max"] },
    "claude-opus-4-7": { known: true, window: 1_000_000, efforts: ["low", "medium", "high", "xhigh", "max"] },
  })
  assert.deepEqual(describeCatalogDifferences(defaultModels, measured).changed, [])
})

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

test("an entry round-trips through the store, 0600 in a 0700 directory", () => {
  const written = entry({ "claude-opus-4-6": { known: true, window: 200_000, efforts: ["low"] } })
  assert.equal(writeCatalogEntry(written), true)
  assert.deepEqual(readCatalogEntries(), [written])
  if (process.platform !== "win32") {
    assert.equal(statSync(cliModelStorePath()).mode & 0o777, 0o600)
    assert.equal(statSync(join(dir, "state")).mode & 0o777, 0o700)
  }
})

test("a second binary is kept beside the first, the same binary replaces itself, and only four are kept", () => {
  writeCatalogEntry({ ...entry({}), binary: "/a", probedAt: 1 })
  writeCatalogEntry({ ...entry({}), binary: "/b", probedAt: 2 })
  writeCatalogEntry({ ...entry({}), binary: "/a", probedAt: 3, size: 9 })
  assert.deepEqual(
    readCatalogEntries().map((kept) => [kept.binary, kept.size]),
    [
      ["/a", 9],
      ["/b", 1],
    ],
  )
  for (let index = 0; index < 6; index++) writeCatalogEntry({ ...entry({}), binary: `/c${index}`, probedAt: 10 + index })
  assert.equal(readCatalogEntries().length, MAX_CATALOG_ENTRIES)
})

test("a malformed file is an empty store, and a malformed entry or fact is dropped", () => {
  mkdirSync(join(dir, "state"), { recursive: true })
  writeFileSync(cliModelStorePath(), "{not json")
  assert.deepEqual(readCatalogEntries(), [])
  writeFileSync(
    cliModelStorePath(),
    JSON.stringify({
      version: 1,
      binaries: [
        { binary: "/x", size: "1", mtimeMs: 1, probedAt: 1, models: {} },
        {
          binary: "/y",
          size: 1,
          mtimeMs: 1,
          probedAt: 1,
          cliVersion: "not a version",
          models: {
            "claude-opus-4-6": { known: true, window: "200000", efforts: ["low", "bogus"] },
            "claude-opus-4-7": { window: 1 },
            "../etc": { known: true },
          },
          added: { "claude-opus-6": { known: true, name: "x\n|y" } },
        },
      ],
    }),
  )
  const [only, ...rest] = readCatalogEntries()
  assert.equal(rest.length, 0)
  assert.equal(only!.binary, "/y")
  assert.equal(only!.cliVersion, undefined)
  assert.deepEqual(only!.models, { "claude-opus-4-6": { known: true, efforts: ["low"] } })
  assert.deepEqual(only!.added, { "claude-opus-6": { known: true } })
})

test("the file holds model facts and a binary path, nothing about the account", () => {
  writeCatalogEntry(entry({ "claude-opus-4-6": { known: true, window: 200_000 } }))
  const text = readFileSync(cliModelStorePath(), "utf8")
  for (const forbidden of ["email", "organization", "account", "token"]) {
    assert.ok(!text.includes(forbidden), forbidden)
  }
})

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/** A file that stands in for the installed `claude`, named so `binaryIdentity` resolves it. */
function fakeBinary(): string {
  const file = join(dir, process.platform === "win32" ? "claude.exe" : "claude")
  writeFileSync(file, "#!/bin/sh\nexit 0\n")
  chmodSync(file, 0o755)
  return file
}

function storeFor(cliPath: string, models: CliCatalogEntry["models"], added: CliCatalogEntry["added"] = {}) {
  const identity = binaryIdentity(cliPath)
  assert.ok(identity, "the fake binary resolves")
  writeCatalogEntry({ ...identity, cliVersion: "2.1.314", probedAt: Date.now(), models, added })
}

test("binaryIdentity follows the path to the real file and says when nothing is there", () => {
  const file = fakeBinary()
  const identity = binaryIdentity(file)
  assert.ok(identity)
  assert.equal(identity.size, statSync(file).size)
  assert.equal(binaryIdentity(join(dir, "missing", "claude")), null)
  assert.equal(binaryIdentity("claude-definitely-not-on-path", process.platform, { PATH: dir }), null)
})

test("V1 registers the overlaid catalog, with the added model and the corrections", () => {
  const cliPath = fakeBinary()
  storeFor(
    cliPath,
    { "claude-opus-4-7": { known: true, window: 300_000, efforts: ["low", "max"] } },
    { "claude-opus-6": { known: true, window: 1_000_000, efforts: ["high"] } },
  )
  activateCliModelCatalog({ cliPath })
  const models = configModelsForProvider({}, "claude-code")
  const opus47 = models["claude-opus-4-7"] as Record<string, any>
  assert.equal(opus47.limit.context, 300_000)
  assert.deepEqual(Object.keys(opus47.variants), ["low", "max"])
  assert.ok(models["claude-opus-6"], "the added model is registered")
  assert.equal((models["claude-opus-6"] as Record<string, any>).cost.input, 0)
  assert.ok(isCliAddedModel("claude-opus-6"))
  assert.ok(isRegisteredModelName("claude-opus-6"), "forceModel and friends accept it")

  const account = configModelsForProvider({}, "claude-code-work", "work")
  assert.ok(account["claude-opus-6@work"], "an account provider carries it with its marker")
})

test("V2 plans the same catalog", () => {
  const cliPath = fakeBinary()
  storeFor(cliPath, { "claude-opus-4-7": { known: true, window: 300_000 } }, { "claude-opus-6": { known: true } })
  activateCliModelCatalog({ cliPath })
  const [plan] = planV2Providers({ cliPath }, [])
  const byId = new Map(plan!.models.map((model) => [model.id, model]))
  assert.equal(byId.get("claude-opus-4-7")!.limit.context, 300_000)
  assert.ok(byId.get("claude-opus-6"))
})

test("an entry for another binary, a changed binary, or the option off registers the hand-kept catalog", () => {
  const cliPath = fakeBinary()
  storeFor(cliPath, { "claude-opus-4-7": { known: true, window: 300_000 } })

  activateCliModelCatalog({ cliPath, cliModelCatalog: false })
  assert.equal(effectiveModels(), defaultModels)
  assert.equal(snapshotCliModelCatalog()?.enabled, false)

  writeFileSync(cliPath, "#!/bin/sh\n# upgraded\nexit 0\n")
  activateCliModelCatalog({ cliPath })
  assert.equal(effectiveModels(), defaultModels, "a changed binary is not the probed one")
  assert.equal(isRegisteredModelName("claude-opus-6"), false)
})

test("the doctor's snapshot names the probed version and what changed", () => {
  const cliPath = fakeBinary()
  storeFor(
    cliPath,
    { "claude-opus-4-7": { known: true, window: 300_000 }, "claude-haiku-5-5": { known: false } },
    { "claude-opus-6": { known: true } },
  )
  activateCliModelCatalog({ cliPath })
  const snapshot = snapshotCliModelCatalog()!
  assert.equal(snapshot.enabled, true)
  assert.equal(snapshot.entry?.cliVersion, "2.1.314")
  assert.deepEqual(snapshot.changed, [{ id: "claude-opus-4-7", field: "context", catalog: "1000000", cli: "300000" }])
  assert.deepEqual(snapshot.added, ["claude-opus-6"])
  assert.deepEqual(snapshot.unknown, ["claude-haiku-5-5"])
})
