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
 * Usage: npx tsx --test test-configure-skill.ts
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { defaultModels } from "./src/models.js"
import { DEFAULT_PROXY_TOOLS } from "./src/proxy-mcp.js"
import { DEFAULT_PROXY_TOOL_NAMES } from "./src/index.js"

const ROOT = path.dirname(fileURLToPath(import.meta.url))
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

test("no em dashes", () => {
  assert.equal(SKILL.includes("\u2014"), false)
})
