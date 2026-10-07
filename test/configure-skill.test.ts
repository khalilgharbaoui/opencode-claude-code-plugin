/**
 * Drift guard for `skills/claude-code-plugin/SKILL.md`, the bundled skill a
 * model uses to configure this plugin.
 *
 * The skill is only useful while it is complete, so this file cross-checks it
 * against the code: every provider option in `types.ts`, every logging key,
 * every registered model id, every proxy tool def, and every plugin env var
 * the source reads must be named in the skill; and every option the skill
 * documents must still exist. Adding an option without documenting it fails
 * here with the missing name.
 *
 * Usage: npx tsx --test test/configure-skill.test.ts
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { defaultModels } from "../src/models.js"
import {
  DEFAULT_PROXY_TOOLS,
  MAX_PROXY_TIMEOUT_MS,
  PROXY_DEFAULT_TIMEOUT_MS,
  PROXY_NO_DEADLINE_MS,
  PROXY_PER_TOOL_DEFAULT_TIMEOUT_MS,
} from "../src/proxy-mcp.js"
import {
  DEFAULT_IDLE_PROCESS_TIMEOUT_MS,
  MAX_ACTIVE_PROCESSES,
} from "../src/session-manager.js"
import { DEFAULT_COMPACTION_MODEL } from "../src/call-options.js"
import { DEFAULT_PROXY_TOOL_NAMES } from "../src/index.js"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const SKILL_DIR = path.join(ROOT, "skills", "claude-code-plugin")
const SKILL = fs.readFileSync(path.join(SKILL_DIR, "SKILL.md"), "utf8")

/** Property names declared directly on an exported interface in `src/types.ts`. */
function interfaceKeys(name: string): string[] {
  const src = fs.readFileSync(path.join(ROOT, "src", "types.ts"), "utf8")
  const start = src.indexOf(`export interface ${name} {`)
  assert.ok(start >= 0, `interface ${name} not found in src/types.ts`)
  const end = src.indexOf("\n}", start)
  const body = src.slice(start, end)
  return [...body.matchAll(/^ {2}([A-Za-z][A-Za-z0-9]*)\??:/gm)].map((m) => m[1]!)
}

/** Backticked first-column keys before the next heading, including subheadings. */
function tableKeys(heading: string): string[] {
  const start = SKILL.indexOf(`\n${heading}\n`)
  assert.ok(start >= 0, `heading not found in SKILL.md: ${heading}`)
  const rest = SKILL.slice(start + heading.length + 2)
  const next = rest.search(/\n#{1,6} /)
  const section = next >= 0 ? rest.slice(0, next) : rest
  return [...section.matchAll(/^\| `([^`]+)`/gm)].map((m) => m[1]!)
}

const mentions = (name: string) => SKILL.includes(`\`${name}\``)

test("frontmatter names the skill after its directory and keeps the description within limits", () => {
  const fm = SKILL.match(/^---\n([\s\S]*?)\n---\n/)
  assert.ok(fm, "SKILL.md must start with YAML frontmatter")
  const name = fm![1]!.match(/^name:\s*(.+)$/m)?.[1]?.trim()
  const description = fm![1]!.match(/^description:\s*(.+)$/m)?.[1]?.trim()
  assert.equal(name, path.basename(SKILL_DIR))
  assert.ok(description && description.length > 80, "description must say when to use it")
  assert.ok(description!.length <= 1024, "Claude Code caps skill descriptions at 1024 chars")
  assert.match(description!, /opencode-claude-code-plugin/)
})

test("every provider option in types.ts is documented, and nothing documented is stale", () => {
  const settings = interfaceKeys("ClaudeCodeProviderSettings")
  assert.ok(settings.length > 25, `parsed only ${settings.length} settings keys`)
  const documented = tableKeys("## Options reference").filter((k) => !k.includes("."))
  const missing = settings.filter((k) => !documented.includes(k))
  assert.deepEqual(missing, [], `options missing from the skill's reference table: ${missing.join(", ")}`)
  const stale = documented.filter((k) => !settings.includes(k))
  assert.deepEqual(stale, [], `options documented but gone from types.ts: ${stale.join(", ")}`)
})

test("every logging key is documented", () => {
  const keys = interfaceKeys("LoggingConfig")
  assert.deepEqual(keys.sort(), ["dir", "file", "level", "mode"])
  const documented = tableKeys("### `logging` object")
  assert.deepEqual(documented.sort(), keys.sort())
})

test("every registered model id is named", () => {
  const ids = Object.values(defaultModels).map((m) => m.id)
  assert.ok(ids.length >= 15)
  const missing = ids.filter((id) => !mentions(id))
  assert.deepEqual(missing, [], `model ids missing from the skill: ${missing.join(", ")}`)
})

test("every proxy tool, default or opt-in, is named", () => {
  for (const name of DEFAULT_PROXY_TOOL_NAMES) {
    assert.ok(SKILL.includes(`"${name}"`), `default proxyTools value missing: ${name}`)
  }
  const defs = DEFAULT_PROXY_TOOLS.map((t) => t.name)
  const missing = defs.filter((n) => !SKILL.includes(`_${n}`) && !mentions(n))
  assert.deepEqual(missing, [], `proxy tool defs missing from the skill: ${missing.join(", ")}`)
})

test("every plugin env var the source reads is documented", () => {
  const vars = new Set<string>()
  for (const file of fs.readdirSync(path.join(ROOT, "src"))) {
    if (!file.endsWith(".ts")) continue
    const src = fs.readFileSync(path.join(ROOT, "src", file), "utf8")
    for (const m of src.matchAll(/process\.env\.((?:CLAUDE_CODE_|OPENCODE_CLAUDE_CODE_|ANTHROPIC_)[A-Z_]+)/g)) {
      vars.add(m[1]!)
    }
  }
  assert.ok(vars.size >= 10, `found only ${vars.size} env vars`)
  const missing = [...vars].filter((v) => !mentions(v) && !SKILL.includes(`\`${v}=`))
  assert.deepEqual(missing, [], `env vars missing from the skill: ${missing.join(", ")}`)
})

test("agent-file keys the plugin honours are documented", () => {
  for (const key of ["forceModel", "reasoningEffort", "defaultSubagentModel", "permission.task", "permission.todowrite"]) {
    assert.ok(SKILL.includes(key), `missing: ${key}`)
  }
})

test("the skill states the two facts every configuration change depends on", () => {
  assert.match(SKILL, /provider\.claude-code\.options/)
  assert.match(SKILL, /read once, at opencode startup/i)
  assert.ok(SKILL.includes("~/.cache/opencode/packages/@khalilgharbaoui/opencode-claude-code-plugin@latest/"))
  assert.ok(SKILL.includes("get approval before removing"))
})

/**
 * The `Default` column of one row of the options reference, by option name.
 * `\|` inside a cell (the `hostApi` row's union type) is unescaped first so a
 * naive split cannot mistake it for a column boundary.
 */
function optionDefault(option: string): string {
  const row = SKILL.split("\n").find((line) => line.startsWith(`| \`${option}\` |`))
  assert.ok(row, `option row not found in SKILL.md: ${option}`)
  const cells = row!.replace(/\\\|/g, "\u0000").split("|").map((c) => c.trim())
  // cells[0] is the empty string before the leading pipe.
  return cells[3]!.replace(/\u0000/g, "|")
}

/** A source literal like `16` or `2_147_483_647`, as a plain number. */
function sourceNumber(file: string, pattern: RegExp): number {
  const src = fs.readFileSync(path.join(ROOT, "src", file), "utf8")
  const match = pattern.exec(src)
  assert.ok(match, `pattern not found in src/${file}: ${pattern}`)
  return Number(match![1]!.replace(/_/g, ""))
}

test("the options table's stated defaults are the code's defaults", () => {
  assert.equal(
    optionDefault("proxyTools"),
    `\`${JSON.stringify(DEFAULT_PROXY_TOOL_NAMES).replace(/","/g, '", "')}\``,
    "the proxyTools default cell must list DEFAULT_PROXY_TOOL_NAMES",
  )
  assert.equal(optionDefault("compactionModel"), `\`"${DEFAULT_COMPACTION_MODEL}"\``)
  // Unset and 0 both resolve to "no idle timer", so the column must say unset
  // rather than naming a duration the code does not apply.
  assert.equal(DEFAULT_IDLE_PROCESS_TIMEOUT_MS, 0)
  assert.equal(optionDefault("idleProcessTimeoutMs"), "unset")
  assert.doesNotMatch(
    SKILL,
    /idle (timer|eviction)[^.]{0,40}\bdefault\b[^.]{0,20}\b(thirty|30)\b/i,
    "the skill must not claim a default idle eviction timer; there is none",
  )
  const skipDefault = /settings\.skipPermissions \?\? (true|false)/.exec(
    fs.readFileSync(path.join(ROOT, "src", "index.ts"), "utf8"),
  )
  assert.ok(skipDefault, "could not read the skipPermissions default from src/index.ts")
  assert.equal(optionDefault("skipPermissions"), `\`${skipDefault![1]}\``)
  assert.equal(optionDefault("cliPath"), '`"claude"`')
})

test("every process-count figure matches MAX_ACTIVE_PROCESSES", () => {
  const figures = [
    ...SKILL.matchAll(/(\d+)[- ](?:live )?processes?\b/g),
    ...SKILL.matchAll(/\ball (\d+) are busy\b/g),
  ].map((m) => Number(m[1]))
  assert.ok(figures.length > 0, "the skill should state the LRU cap at least once")
  const wrong = figures.filter((n) => n !== MAX_ACTIVE_PROCESSES)
  assert.deepEqual(wrong, [], `process-count figures disagreeing with MAX_ACTIVE_PROCESSES (${MAX_ACTIVE_PROCESSES}): ${wrong.join(", ")}`)
})

test("the proxy deadline defaults the skill quotes are the resolver's", () => {
  assert.ok(
    SKILL.includes(`${PROXY_DEFAULT_TIMEOUT_MS / 60_000} min`),
    `the flat proxy deadline (${PROXY_DEFAULT_TIMEOUT_MS} ms) is not stated in minutes`,
  )
  for (const [tool, ms] of Object.entries(PROXY_PER_TOOL_DEFAULT_TIMEOUT_MS)) {
    assert.ok(mentions(tool), `per-tool proxy deadline not documented: ${tool}`)
    if (ms === PROXY_NO_DEADLINE_MS) continue
    assert.ok(
      SKILL.includes(`\`${tool}\` ${ms / 60_000} min`),
      `per-tool deadline for ${tool} should be stated as "${ms / 60_000} min"`,
    )
  }
  assert.ok(String(SKILL).includes(String(MAX_PROXY_TIMEOUT_MS)), "the clamp ceiling is not stated")
})

test("the watchdog defaults the skill quotes are the ones turn-state falls back to", () => {
  const fallback = sourceNumber("turn-state.ts", /CLAUDE_CODE_RESULT_FALLBACK_MS[\s\S]{0,200}?: ([\d_]+)\n/)
  const watchdog = sourceNumber("turn-state.ts", /CLAUDE_CODE_START_WATCHDOG_MS[\s\S]{0,200}?: ([\d_]+)\n/)
  assert.ok(SKILL.includes(`default ${fallback} for`), `result fallback default ${fallback} not stated`)
  assert.ok(SKILL.includes(`default ${watchdog} for`), `start watchdog default ${watchdog} not stated`)
})

test("every price multiplier named is one the registry actually uses", () => {
  // A multiplier is not always a whole number: Haiku 5.5 is a tenth of the
  // Haiku 4.5 anchor, so its display name ends in a 0.1 multiplier. Matching
  // whole digits only read that as the "1" inside it on the skill side and as
  // NaN on the registry side, so both patterns take an optional fraction.
  const MULTIPLIER = String.raw`\d+(?:\.\d+)?`
  const used = new Set(
    Object.values(defaultModels).map((m) =>
      Number(new RegExp(`\\((${MULTIPLIER})\\u00d7\\)$`).exec(m.name)?.[1]),
    ),
  )
  const named = new Set(
    [...SKILL.matchAll(new RegExp(`(${MULTIPLIER})\\u00d7`, "g"))].map((m) => Number(m[1])),
  )
  assert.deepEqual(
    [...named].filter((n) => !used.has(n)).sort((a, b) => a - b),
    [],
    "the skill names a price multiplier no registered model has",
  )
  assert.deepEqual(
    [...used].filter((n) => !named.has(n)).sort((a, b) => a - b),
    [],
    "a registered model's price multiplier is missing from the skill",
  )
})

test("every model CLI floor the code knows is named", () => {
  const src = fs.readFileSync(path.join(ROOT, "src", "cli-events.ts"), "utf8")
  const block = /const MODEL_CLI_FLOORS[\s\S]*?\n}/.exec(src)
  assert.ok(block, "MODEL_CLI_FLOORS not found in src/cli-events.ts")
  const floors = [...block![0].matchAll(/"([^"]+)":\s*"([^"]+)"/g)]
  assert.ok(floors.length > 0)
  for (const [, model, version] of floors) {
    assert.ok(mentions(model!), `model with a CLI floor missing from the skill: ${model}`)
    assert.ok(SKILL.includes(version!), `CLI floor ${version} for ${model} missing from the skill`)
  }
})

test("no em dashes", () => {
  assert.equal(SKILL.includes("\u2014"), false)
})
