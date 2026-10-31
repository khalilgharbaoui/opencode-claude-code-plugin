/**
 * The model catalog as the installed Claude Code CLI itself describes it:
 * which models it knows, the context window it runs each one in, and the
 * effort levels it accepts. Read by a free probe, kept in a file, and laid
 * over the hand-kept catalog in `src/models.ts` when providers are registered
 * (h #g279).
 *
 * ## The probe, and why it costs nothing
 *
 * One short-lived `claude --print --input-format stream-json --bare
 * --model <id>` per model id, sent two control requests and never a user
 * message: `initialize` (its `models` rows carry the effort levels and fast
 * mode, and a row for `--model` itself when it is not one of the picker's
 * aliases) and `get_context_usage` with `detail: "summary"` (its
 * `rawMaxTokens` is the window the CLI runs that model in). Measured on
 * 2.1.288, 2.1.293 and 2.1.314: both answer under `--bare`, which reads no
 * OAuth and no keychain and runs no hooks, in about 250 ms on 2.1.314, and the
 * probe also strips `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN`, so the
 * process holds no credential any request could be billed to. The CLI's own
 * schema says `summary` "answers from the last response's usage and local
 * estimates without the per-category token-count calls". Measured against a
 * local server set as `ANTHROPIC_BASE_URL` that logs every request: three
 * probe spawns made none, and a control `claude -p hi --bare` made seven.
 *
 * What it deliberately does NOT do is the opencode built-in's
 * `setModel` + `getContextUsage` loop in one process: `set_model` validates a
 * model by SENDING it a message (`{max_tokens: 1, messages: [{content:
 * "Hi"}]}`, read out of 2.1.314 and seen as "Unable to validate model" under
 * `--bare`), so that loop is one real API request per model. One spawn per
 * model costs a process and no request.
 *
 * The turn processes still send no `initialize` at all, so (h #g220)'s
 * `hook_callback` and `mcp_message` stay unreachable there; the probe's own
 * `initialize` registers no hooks, no SDK MCP servers and no prompt.
 *
 * ## When it runs, and where the answer goes
 *
 * Provider registration happens before any spawn, and opencode 2's provider
 * transform is synchronous, so registration never waits for the probe. It
 * reads `cli-models.json` under `$XDG_STATE_HOME` (merge-on-write, atomic
 * rename, `0600`, an unreadable file is an empty store, like the other
 * stores) for the entry whose binary identity matches the configured
 * `cliPath`, and the probe runs in the background only when there is no such
 * entry or its version is not the installed one. On opencode 2 a fresh answer
 * reloads the providers in the same process; on opencode 1 it applies from the
 * next start. A probe killed by its deadline writes nothing, so the next start
 * asks again (h #g181's rule: a busy machine is not an answer); one the CLI
 * refused is remembered for `REFUSAL_RETRY_MS`, because that describes the
 * binary.
 *
 * ## What the answer changes
 *
 * Only what the CLI reports about a model it knows: the context window, and
 * the effort variants (the CLI clamps a level a model lacks to `high`, so a
 * variant it does not accept is a picker choice that changes nothing). A
 * model the CLI does not know (its row's display name is the raw id, and its
 * window is the 200k fallback) is left exactly as the catalog has it, because
 * that is `reportUnrecognizedModel`'s case, fixed by `claude update`. Prices
 * are not in the CLI, so costs and `(N×)` labels stay the catalog's. A model
 * the CLI's own picker resolves to that the catalog lacks is ADDED, on the
 * pass-through template (`passthroughModel`, zero cost meaning unknown).
 */
import { spawn } from "node:child_process"
import {
  accessSync,
  constants as fsConstants,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { delimiter, join, resolve } from "node:path"
import { createInterface } from "node:readline"
import { cliHygieneEnv, detectCliVersion } from "./cli-version.js"
import { log } from "./logger.js"
import {
  defaultModels,
  EFFORT_LEVELS,
  type EffortLevel,
  effortVariants,
  parseModelId,
  passthroughModel,
} from "./models.js"
import type { OpenCodeModel } from "./opencode-types.js"
import { planClaudeSpawn, resolveWindowsCommand } from "./windows-spawn.js"

/** What the CLI said about one model id. */
export interface CliModelFact {
  /** False when the CLI does not know the id (it answers with fallback limits). */
  known: boolean
  /** `rawMaxTokens` from `get_context_usage`: the window the CLI runs it in. */
  window?: number
  /** The effort levels it accepts; empty for none. Absent when not reported. */
  efforts?: EffortLevel[]
  fast?: boolean
  /** The CLI's display name, kept only for an added model's picker label. */
  name?: string
}

/** One probed binary. */
export interface CliCatalogEntry {
  binary: string
  size: number
  mtimeMs: number
  /**
   * The binary's version: `claude_code_version` from `initialize`, else
   * `claude --version` (2.1.288 and 2.1.293 send no version in `initialize`).
   */
  cliVersion?: string
  probedAt: number
  /** Set when the CLI refused the probe; the entry then carries no facts. */
  refused?: string
  /** Every catalog model id, as the CLI describes it. */
  models: Record<string, CliModelFact>
  /** Models the CLI's own picker resolves to that the catalog lacks. */
  added: Record<string, CliModelFact>
}

export interface BinaryIdentity {
  binary: string
  size: number
  mtimeMs: number
}

/** Probed binaries remembered at once; a machine rarely has more than two. */
export const MAX_CATALOG_ENTRIES = 4

/** How long one probe spawn may take before it is killed and nothing is written. */
export const CLI_MODEL_PROBE_DEADLINE_MS = 20_000

/** Probe spawns at once. Each is about a quarter of a second on 2.1.314. */
const PROBE_CONCURRENCY = 4

/** The env seam the test script sets to `0`, and an operator's off switch for the environment. */
export const CLI_MODEL_PROBE_ENV = "OPENCODE_CLAUDE_CODE_MODEL_PROBE"

/** An id the CLI's picker can resolve to that may be added: first-party naming only. */
const ADDABLE_ID = /^claude-[a-z]+(?:-[a-z0-9]+)+$/

/**
 * A dated snapshot id. 2.1.288's picker resolves `haiku` to
 * `claude-haiku-4-5-20251001`, which is the catalog's `claude-haiku-4-5`
 * under another name, not a model of its own, so it is never added.
 */
const DATED_ID = /-\d{8}$/

function addableId(id: string): boolean {
  return ADDABLE_ID.test(id) && !DATED_ID.test(id)
}

/**
 * How long a probe the CLI refused is remembered for that binary before it is
 * asked again. A deadline kill is never remembered (h #g181); a refusal (a
 * CLI too old for `--bare` or for these control requests) describes the
 * binary, so it costs one spawn a day rather than one per opencode start.
 */
export const REFUSAL_RETRY_MS = 24 * 60 * 60 * 1000

const WINDOW_MIN = 10_000
const WINDOW_MAX = 100_000_000

let pathOverride: string | null = null

export function cliModelStorePath(): string {
  if (pathOverride) return pathOverride
  const stateRoot = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state")
  return join(stateRoot, "opencode-claude-code-plugin", "cli-models.json")
}

// ---------------------------------------------------------------------------
// Reading one probe's answers
// ---------------------------------------------------------------------------

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function validWindow(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= WINDOW_MIN && value <= WINDOW_MAX
    ? value
    : undefined
}

function validEfforts(value: unknown): EffortLevel[] | undefined {
  if (!Array.isArray(value)) return undefined
  return EFFORT_LEVELS.filter((level) => value.includes(level))
}

/**
 * The `initialize` row that describes `id`: its own row when the CLI appended
 * one for `--model`, else the picker row that resolves to it (not `default`,
 * whose label is "Default (recommended)").
 */
function rowFor(id: string, rows: unknown[]): Record<string, unknown> | undefined {
  const objects = rows.filter(isObject)
  return (
    objects.find((row) => row.value === id) ??
    objects.find((row) => row.value !== "default" && row.resolvedModel === id) ??
    objects.find((row) => row.resolvedModel === id)
  )
}

/**
 * What one probe said about `id`, or null when `initialize` carried no model
 * list at all. Pure, for the tests.
 *
 * Known-ness is read off the display name. Measured on 2.1.314: an id the CLI
 * has no catalog entry for (`claude-sonnet-9-9`) gets a row whose
 * `displayName` IS the id, with the 200k fallback window; Mythos, which the
 * CLI does know, is described "Custom model (claude-mythos-5)" only because no
 * picker family matches it, and its display name is "Mythos 5". So the
 * description is not a signal and the display name is.
 */
export function factFromProbe(
  id: string,
  init: unknown,
  usage: unknown,
): CliModelFact | null {
  if (!isObject(init) || !Array.isArray(init.models)) return null
  const row = rowFor(id, init.models)
  if (!row || typeof row.displayName !== "string") return { known: false }
  const known = row.displayName !== id
  const fact: CliModelFact = { known }
  const window = isObject(usage) ? validWindow(usage.rawMaxTokens) : undefined
  if (window !== undefined) fact.window = window
  if (row.supportsEffort === true) {
    const efforts = validEfforts(row.supportedEffortLevels)
    if (efforts) fact.efforts = efforts
  } else {
    fact.efforts = []
  }
  if (row.supportsFastMode === true) fact.fast = true
  if (known && row.value === id && /^[A-Za-z0-9 .()-]{1,40}$/.test(row.displayName)) {
    fact.name = row.displayName
  }
  return fact
}

/** The model ids the CLI's own picker resolves to, `[1m]` removed, first-party names only. */
export function pickerModelIds(init: unknown): string[] {
  if (!isObject(init) || !Array.isArray(init.models)) return []
  const ids = new Set<string>()
  for (const row of init.models) {
    if (!isObject(row)) continue
    const raw = typeof row.resolvedModel === "string" ? row.resolvedModel : row.value
    if (typeof raw !== "string") continue
    const id = raw.replace(/\[1m\]$/i, "")
    if (addableId(id)) ids.add(id)
  }
  return [...ids]
}

/** The catalog ids worth asking about: every entry but our own `-fast` markers. */
export function catalogProbeIds(catalog: Record<string, OpenCodeModel> = defaultModels): string[] {
  return Object.keys(catalog).filter((id) => !parseModelId(id).fast)
}

// ---------------------------------------------------------------------------
// The overlay
// ---------------------------------------------------------------------------

/** `claude-opus-6-1` to `Opus 6.1`: what an added model is called without a CLI label. */
export function nameFromModelId(id: string): string {
  const out: string[] = []
  let version: string[] = []
  for (const part of id.replace(/^claude-/, "").split("-")) {
    if (/^\d{1,2}$/.test(part)) {
      version.push(part)
      continue
    }
    if (version.length > 0) out.push(version.join("."))
    version = []
    out.push(/^\d+$/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1))
  }
  if (version.length > 0) out.push(version.join("."))
  return out.join(" ")
}

function addedModel(id: string, fact: CliModelFact): OpenCodeModel {
  const template = passthroughModel(id)
  const label = fact.name ?? nameFromModelId(id)
  const reasoning = fact.efforts === undefined || fact.efforts.length > 0
  return {
    ...template,
    name: `Claude ${label}`,
    family: id.split("-")[1] ?? "",
    capabilities: { ...template.capabilities, reasoning },
    limit: { ...template.limit, context: fact.window ?? template.limit.context },
    variants: fact.efforts ? effortVariants(fact.efforts) : template.variants,
  }
}

/**
 * The catalog with what the CLI reported laid over it. Pure, and returns the
 * catalog itself when there is nothing to lay.
 *
 * A `-fast` entry takes its base model's facts, because it is the same model
 * on the wire. A model the CLI does not know is left alone, and an effort list
 * is only applied to a model the catalog already treats as reasoning.
 */
export function overlayCliCatalog(
  catalog: Record<string, OpenCodeModel>,
  entry: CliCatalogEntry | null | undefined,
): Record<string, OpenCodeModel> {
  if (!entry || entry.refused) return catalog
  const out: Record<string, OpenCodeModel> = {}
  for (const [id, model] of Object.entries(catalog)) {
    const parsed = parseModelId(id)
    const fact = entry.models[parsed.model]
    if (!fact?.known) {
      out[id] = model
      continue
    }
    const next: OpenCodeModel = { ...model }
    if (fact.window !== undefined) next.limit = { ...model.limit, context: fact.window }
    if (fact.efforts !== undefined && model.capabilities.reasoning) {
      next.variants = effortVariants(fact.efforts)
    }
    out[id] = next
  }
  for (const [id, fact] of Object.entries(entry.added)) {
    if (Object.hasOwn(out, id) || !fact.known || !addableId(id)) continue
    out[id] = addedModel(id, fact)
  }
  return out
}

/** What the overlay changed, for the startup log line and the doctor. */
export interface CatalogDifference {
  id: string
  field: "context" | "efforts"
  catalog: string
  cli: string
}

export function describeCatalogDifferences(
  catalog: Record<string, OpenCodeModel>,
  entry: CliCatalogEntry,
): { changed: CatalogDifference[]; added: string[]; unknown: string[] } {
  const changed: CatalogDifference[] = []
  const unknown: string[] = []
  const levels = (model: OpenCodeModel) => Object.keys(model.variants ?? {}).join("/") || "none"
  const overlaid = overlayCliCatalog(catalog, entry)
  for (const id of catalogProbeIds(catalog)) {
    const fact = entry.models[id]
    if (fact && !fact.known) unknown.push(id)
    const before = catalog[id]
    const after = overlaid[id]
    if (!before || !after) continue
    if (before.limit.context !== after.limit.context) {
      changed.push({ id, field: "context", catalog: String(before.limit.context), cli: String(after.limit.context) })
    }
    if (levels(before) !== levels(after)) {
      changed.push({ id, field: "efforts", catalog: levels(before), cli: levels(after) })
    }
  }
  const added = Object.keys(overlaid).filter((id) => !Object.hasOwn(catalog, id))
  return { changed, added, unknown }
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

function readFact(value: unknown): CliModelFact | null {
  if (!isObject(value) || typeof value.known !== "boolean") return null
  const fact: CliModelFact = { known: value.known }
  const window = validWindow(value.window)
  if (window !== undefined) fact.window = window
  const efforts = validEfforts(value.efforts)
  if (efforts) fact.efforts = efforts
  if (value.fast === true) fact.fast = true
  if (typeof value.name === "string" && /^[A-Za-z0-9 .()-]{1,40}$/.test(value.name)) fact.name = value.name
  return fact
}

function readFacts(value: unknown): Record<string, CliModelFact> {
  const out: Record<string, CliModelFact> = {}
  if (!isObject(value)) return out
  for (const [id, raw] of Object.entries(value)) {
    if (!ADDABLE_ID.test(id)) continue
    const fact = readFact(raw)
    if (fact) out[id] = fact
  }
  return out
}

function readEntry(value: unknown): CliCatalogEntry | null {
  if (!isObject(value)) return null
  const { binary, size, mtimeMs, probedAt, cliVersion, refused } = value
  if (typeof binary !== "string" || !binary) return null
  if (typeof size !== "number" || typeof mtimeMs !== "number" || typeof probedAt !== "number") return null
  return {
    binary,
    size,
    mtimeMs,
    ...(typeof cliVersion === "string" && /^\d+\.\d+\.\d+$/.test(cliVersion) ? { cliVersion } : {}),
    probedAt,
    ...(typeof refused === "string" && /^[a-z-]{1,40}$/.test(refused) ? { refused } : {}),
    models: readFacts(value.models),
    added: readFacts(value.added),
  }
}

/** Every remembered entry, newest first. Never throws: an unreadable file is empty. */
export function readCatalogEntries(file: string = cliModelStorePath()): CliCatalogEntry[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"))
    if (!isObject(parsed) || !Array.isArray(parsed.binaries)) return []
    return parsed.binaries
      .map(readEntry)
      .filter((entry): entry is CliCatalogEntry => entry !== null)
      .sort((a, b) => b.probedAt - a.probedAt)
  } catch {
    return []
  }
}

/**
 * Record a probed binary, replacing whatever was kept for the same path.
 * Merge-on-write, atomic rename, `0600` in the `0700` directory. Returns
 * whether the disk was written.
 */
export function writeCatalogEntry(entry: CliCatalogEntry, file: string = cliModelStorePath()): boolean {
  const kept = readCatalogEntries(file).filter((other) => other.binary !== entry.binary)
  const binaries = [entry, ...kept].slice(0, MAX_CATALOG_ENTRIES)
  try {
    mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 })
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify({ version: 1, binaries }), { mode: 0o600 })
    renameSync(tmp, file)
    return true
  } catch {
    return false
  }
}

function sameBinary(entry: CliCatalogEntry, identity: BinaryIdentity): boolean {
  return entry.binary === identity.binary && entry.size === identity.size && entry.mtimeMs === identity.mtimeMs
}

// ---------------------------------------------------------------------------
// Which binary `cliPath` is
// ---------------------------------------------------------------------------

function isExecutableFile(candidate: string): boolean {
  try {
    if (!statSync(candidate).isFile()) return false
    accessSync(candidate, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * The real file `cliPath` runs and its size and mtime, or null. Synchronous
 * and spawn-free, because opencode 2's provider transform is synchronous.
 *
 * The native installer links `claude` to `versions/<version>` and an npm
 * install links it to the package's `cli.js`, so following the link names a
 * file that changes with every upgrade. A Windows `.cmd` shim does not, which
 * is why the background refresh also compares the version.
 */
export function binaryIdentity(
  cliPath: string,
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
): BinaryIdentity | null {
  try {
    let found: string | null = null
    if (platform === "win32") {
      found = resolveWindowsCommand(cliPath, { env })
    } else if (cliPath.includes("/")) {
      found = isExecutableFile(cliPath) ? resolve(cliPath) : null
    } else {
      for (const directory of (env.PATH ?? "").split(delimiter)) {
        if (!directory) continue
        const candidate = join(directory, cliPath)
        if (isExecutableFile(candidate)) {
          found = candidate
          break
        }
      }
    }
    if (!found) return null
    const real = realpathSync.native(found)
    const stats = statSync(real)
    return { binary: real, size: stats.size, mtimeMs: stats.mtimeMs }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// The probe
// ---------------------------------------------------------------------------

type ProbeAnswer =
  | { ok: true; init: Record<string, unknown>; usage: unknown }
  | { ok: false; reason: string; deadline: boolean }

/** The argv of one probe. Exported for the tests, which assert it. */
export function probeArgs(id: string): string[] {
  return [
    "--print",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--no-session-persistence",
    "--bare",
    "--strict-mcp-config",
    "--model",
    id,
  ]
}

/**
 * The probe's environment: the user's, with the hygiene vars filled and every
 * Anthropic credential the CLI reads under `--bare` removed, so nothing the
 * probe does can be billed even by mistake. Third-party provider settings
 * (`CLAUDE_CODE_USE_BEDROCK` and the like) stay, because they change which
 * ids and windows the CLI reports.
 */
export function probeEnv(inherited: Record<string, string | undefined> = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...inherited, ...cliHygieneEnv(inherited) }
  delete env.ANTHROPIC_API_KEY
  delete env.ANTHROPIC_AUTH_TOKEN
  return env
}

function probeOne(cliPath: string, id: string, deadlineMs: number): Promise<ProbeAnswer> {
  return new Promise((done) => {
    let settled = false
    let deadline = false
    let init: Record<string, unknown> | null = null
    let usage: unknown
    const finish = (answer: ProbeAnswer) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      done(answer)
    }
    const plan = planClaudeSpawn(cliPath, probeArgs(id))
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(plan.file, plan.args, {
        stdio: ["pipe", "pipe", "ignore"],
        env: probeEnv(),
        windowsVerbatimArguments: plan.windowsVerbatimArguments,
      })
    } catch (error) {
      finish({ ok: false, reason: "spawn-failed", deadline: false })
      return
    }
    const timer = setTimeout(() => {
      deadline = true
      child.kill("SIGKILL")
    }, deadlineMs)
    timer.unref?.()
    const send = (requestId: string, request: Record<string, unknown>) => {
      try {
        child.stdin?.write(`${JSON.stringify({ type: "control_request", request_id: requestId, request })}\n`)
      } catch {
        // The exit handler reports it.
      }
    }
    child.stdin?.on("error", () => undefined)
    child.on("error", () => finish({ ok: false, reason: "spawn-failed", deadline: false }))
    const lines = createInterface({ input: child.stdout! })
    lines.on("line", (line) => {
      let message: unknown
      try {
        message = JSON.parse(line)
      } catch {
        return
      }
      if (!isObject(message) || message.type !== "control_response" || !isObject(message.response)) return
      const response = message.response
      if (response.subtype !== "success") {
        finish({ ok: false, reason: "request-refused", deadline: false })
        child.kill("SIGKILL")
        return
      }
      if (response.request_id === "init" && isObject(response.response)) {
        init = response.response
        send("usage", { subtype: "get_context_usage", detail: "summary" })
      } else if (response.request_id === "usage") {
        usage = response.response
        child.stdin?.end()
      }
    })
    child.on("close", () => {
      if (init && usage !== undefined) finish({ ok: true, init, usage })
      else finish({ ok: false, reason: deadline ? "deadline" : "no-answer", deadline })
    })
    send("init", { subtype: "initialize" })
  })
}

async function mapLimited<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await work(items[index]!)
    }
  })
  await Promise.all(lanes)
  return results
}

export type ProbeOutcome =
  | { ok: true; entry: CliCatalogEntry; spawns: number; ms: number }
  | { ok: false; reason: string; spawns: number; ms: number }

/**
 * Probe every catalog id, then every id the CLI's picker resolves to that the
 * catalog lacks. All or nothing: one failed or deadline-killed spawn writes no
 * entry, because a partial snapshot would read a missing model as unknown.
 */
export async function probeCliCatalog(
  cliPath: string,
  identity: BinaryIdentity,
  options: { ids?: string[]; deadlineMs?: number; now?: () => number; cliVersion?: string } = {},
): Promise<ProbeOutcome> {
  const started = Date.now()
  const deadlineMs = options.deadlineMs ?? CLI_MODEL_PROBE_DEADLINE_MS
  const ids = options.ids ?? catalogProbeIds()
  let spawns = 0
  const ask = async (id: string) => {
    spawns++
    return { id, answer: await probeOne(cliPath, id, deadlineMs) }
  }
  // One first, so a CLI that cannot probe at all (too old for `--bare`, or
  // missing) costs one spawn rather than a lane's worth.
  const first = await ask(ids[0]!)
  const fail = (reason: string): ProbeOutcome => ({ ok: false, reason, spawns, ms: Date.now() - started })
  if (!first.answer.ok) return fail(first.answer.reason)
  const rest = await mapLimited(ids.slice(1), PROBE_CONCURRENCY, ask)
  const answers = [first, ...rest]
  const models: Record<string, CliModelFact> = {}
  const picker = new Set<string>()
  let cliVersion = options.cliVersion
  for (const { id, answer } of answers) {
    if (!answer.ok) return fail(answer.reason)
    const fact = factFromProbe(id, answer.init, answer.usage)
    if (!fact) return fail("no-model-list")
    models[id] = fact
    for (const pickerId of pickerModelIds(answer.init)) picker.add(pickerId)
    if (typeof answer.init.claude_code_version === "string") cliVersion = answer.init.claude_code_version
  }
  const extra = [...picker].filter((id) => !Object.hasOwn(models, id) && !Object.hasOwn(defaultModels, id))
  const added: Record<string, CliModelFact> = {}
  for (const { id, answer } of await mapLimited(extra, PROBE_CONCURRENCY, ask)) {
    if (!answer.ok) return fail(answer.reason)
    const fact = factFromProbe(id, answer.init, answer.usage)
    if (!fact) return fail("no-model-list")
    if (fact.known) added[id] = fact
  }
  const entry: CliCatalogEntry = {
    ...identity,
    ...(cliVersion && /^\d+\.\d+\.\d+$/.test(cliVersion) ? { cliVersion } : {}),
    probedAt: (options.now ?? Date.now)(),
    models,
    added,
  }
  return { ok: true, entry, spawns, ms: Date.now() - started }
}

// ---------------------------------------------------------------------------
// Registration and the background refresh
// ---------------------------------------------------------------------------

interface ActiveCatalog {
  cliPath: string
  enabled: boolean
  entry: CliCatalogEntry | null
  models: Record<string, OpenCodeModel>
}

let active: ActiveCatalog | null = null
const refreshes = new Map<string, Promise<RefreshResult>>()
let lastRefresh: RefreshResult | undefined
const loggedActivations = new Set<string>()

/** Whether the `cliModelCatalog` provider option is on. Default true. */
export function cliModelCatalogEnabled(settings: Record<string, unknown> | undefined): boolean {
  return settings?.cliModelCatalog !== false
}

function probeEnabledByEnv(): boolean {
  const value = process.env[CLI_MODEL_PROBE_ENV]
  return value === undefined || (value !== "0" && value.toLowerCase() !== "false")
}

/**
 * Choose the catalog providers are registered with, from the stored entry
 * whose binary is the one `cliPath` runs. Synchronous and never throws; with
 * the option off, or no entry yet, it is the hand-kept catalog.
 */
export function activateCliModelCatalog(settings: Record<string, unknown> | undefined): void {
  const cliPath = typeof settings?.cliPath === "string" && settings.cliPath ? settings.cliPath : "claude"
  const enabled = cliModelCatalogEnabled(settings)
  let entry: CliCatalogEntry | null = null
  if (enabled) {
    const identity = binaryIdentity(cliPath)
    entry = identity ? (readCatalogEntries().find((candidate) => sameBinary(candidate, identity)) ?? null) : null
  }
  const models = overlayCliCatalog(defaultModels, entry)
  active = { cliPath, enabled, entry, models }
  if (!entry || entry.refused) return
  const key = `${entry.binary}\x00${entry.probedAt}`
  if (loggedActivations.has(key)) return
  loggedActivations.add(key)
  const differences = describeCatalogDifferences(defaultModels, entry)
  log.info("registering the model catalog as the claude cli describes it", {
    cliVersion: entry.cliVersion,
    changed: differences.changed.map((change) => `${change.id} ${change.field} ${change.catalog}->${change.cli}`),
    added: differences.added,
    unknownToCli: differences.unknown,
  })
}

/** The catalog to register: the hand-kept one with the CLI's answer laid over it. */
export function effectiveModels(): Record<string, OpenCodeModel> {
  return active?.models ?? defaultModels
}

/** True for a model the CLI added that the hand-kept catalog does not have. */
export function isCliAddedModel(id: string): boolean {
  const models = active?.models
  return !!models && Object.hasOwn(models, id) && !Object.hasOwn(defaultModels, id)
}

export type RefreshResult =
  | { status: "current"; cliVersion?: string; refused?: string }
  | { status: "learned"; cliVersion?: string; spawns: number; ms: number; changed: boolean }
  | { status: "failed"; reason: string; spawns: number; ms: number }
  | { status: "skipped"; reason: string }

/**
 * Make sure the store holds an answer for the installed CLI, probing in the
 * background when it does not. Once per `cliPath` per process, never throws,
 * and never awaited by registration. `onLearned` runs after a new entry is
 * written that differs from what was registered, which is where opencode 2
 * reloads its providers.
 */
export function refreshCliModelCatalog(
  settings: Record<string, unknown> | undefined,
  hooks: { onLearned?: () => void | Promise<void>; deadlineMs?: number } = {},
): Promise<RefreshResult> {
  const cliPath = typeof settings?.cliPath === "string" && settings.cliPath ? settings.cliPath : "claude"
  const cached = refreshes.get(cliPath)
  if (cached) return cached
  const run = (async (): Promise<RefreshResult> => {
    if (!cliModelCatalogEnabled(settings)) return { status: "skipped", reason: "option-off" }
    if (!probeEnabledByEnv()) return { status: "skipped", reason: "env-off" }
    const identity = binaryIdentity(cliPath)
    if (!identity) return { status: "skipped", reason: "cli-not-found" }
    const stored = readCatalogEntries().find((entry) => sameBinary(entry, identity))
    const detected = await detectCliVersion(cliPath).catch(() => null)
    const installed = detected ? `${detected.major}.${detected.minor}.${detected.patch}` : undefined
    if (stored && (!installed || !stored.cliVersion || stored.cliVersion === installed)) {
      if (!stored.refused) return { status: "current", cliVersion: stored.cliVersion }
      if (Date.now() - stored.probedAt < REFUSAL_RETRY_MS) {
        return { status: "current", cliVersion: stored.cliVersion, refused: stored.refused }
      }
    }
    const outcome = await probeCliCatalog(cliPath, identity, {
      cliVersion: installed,
      deadlineMs: hooks.deadlineMs,
    })
    if (!outcome.ok) {
      if (outcome.reason !== "deadline") {
        writeCatalogEntry({
          ...identity,
          ...(installed ? { cliVersion: installed } : {}),
          probedAt: Date.now(),
          models: {},
          added: {},
          refused: outcome.reason,
        })
      }
      log.info("could not read the model catalog from the claude cli; keeping the built-in one", {
        reason: outcome.reason,
        spawns: outcome.spawns,
        ms: outcome.ms,
      })
      return { status: "failed", reason: outcome.reason, spawns: outcome.spawns, ms: outcome.ms }
    }
    writeCatalogEntry(outcome.entry)
    const before = active?.entry
    const changed =
      JSON.stringify(overlayCliCatalog(defaultModels, outcome.entry)) !==
      JSON.stringify(overlayCliCatalog(defaultModels, before))
    const differences = describeCatalogDifferences(defaultModels, outcome.entry)
    log.info("read the model catalog from the claude cli", {
      cliVersion: outcome.entry.cliVersion,
      spawns: outcome.spawns,
      ms: outcome.ms,
      changed: differences.changed.map((change) => `${change.id} ${change.field} ${change.catalog}->${change.cli}`),
      added: differences.added,
      unknownToCli: differences.unknown,
    })
    if (changed && hooks.onLearned) {
      try {
        await hooks.onLearned()
      } catch (error) {
        log.debug("reloading providers after the model probe failed", {
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    return {
      status: "learned",
      cliVersion: outcome.entry.cliVersion,
      spawns: outcome.spawns,
      ms: outcome.ms,
      changed,
    }
  })().catch(
    (error): RefreshResult => ({
      status: "failed",
      reason: error instanceof Error ? error.message.slice(0, 80) : "unexpected",
      spawns: 0,
      ms: 0,
    }),
  )
  refreshes.set(cliPath, run)
  void run.then((result) => {
    lastRefresh = result
  })
  return run
}

/** What the doctor prints. Read-only. */
export interface CliModelCatalogSnapshot {
  enabled: boolean
  cliPath: string
  entry?: { cliVersion?: string; probedAt: number; refused?: string }
  changed: CatalogDifference[]
  added: string[]
  unknown: string[]
  refresh?: RefreshResult
}

export function snapshotCliModelCatalog(): CliModelCatalogSnapshot | undefined {
  if (!active) return undefined
  const differences = active.entry
    ? describeCatalogDifferences(defaultModels, active.entry)
    : { changed: [], added: [], unknown: [] }
  return {
    enabled: active.enabled,
    cliPath: active.cliPath,
    ...(active.entry
      ? {
          entry: {
            cliVersion: active.entry.cliVersion,
            probedAt: active.entry.probedAt,
            ...(active.entry.refused ? { refused: active.entry.refused } : {}),
          },
        }
      : {}),
    ...differences,
    ...(lastRefresh ? { refresh: lastRefresh } : {}),
  }
}

export function _resetCliModelCatalogForTests(path: string | null = null): void {
  pathOverride = path
  active = null
  refreshes.clear()
  lastRefresh = undefined
  loggedActivations.clear()
}
