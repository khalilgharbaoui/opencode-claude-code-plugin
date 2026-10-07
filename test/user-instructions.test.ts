/**
 * `interactiveUserInstructions` (h #g212): the parts of opencode's forwarded
 * system prompt the operator wrote, chosen by provenance and passed verbatim.
 */
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { test } from "node:test"
import { agentMarkdownBody } from "../src/agent-models.js"
import { buildAppendedSystemPrompt, userAuthoredInstructions } from "../src/prompts.js"

const OPENCODE_HEADER = "You are OpenCode, the best coding agent on the planet."
const ENV_BLOCK =
  "Here is some useful information about the environment you are running in:\n<env>\n  Working directory: /x\n  Platform: darwin\n</env>"

function files(map: Record<string, string>): (file: string) => string | null {
  return (file) => (Object.hasOwn(map, file) ? map[file]! : null)
}

test("instruction files are taken by provenance and verbatim; opencode's own text is not", () => {
  const rules = "# Rules\n\nUse tabs.\n\n  Indented line kept.\n"
  const forwarded = [
    OPENCODE_HEADER,
    ENV_BLOCK,
    `Instructions from: /home/me/rules.md\n${rules}`,
    "Instructions from: /home/me/CLAUDE.md\nclaude text",
    "Instructions from: https://example.com/rules.md\nfetched text",
    "Instructions from: /home/me/changed.md\nwhat opencode read earlier",
    "Instructions from: relative/rules.md\nrelative text",
  ].join("\n")
  const found = userAuthoredInstructions(forwarded, {
    readFile: files({
      "/home/me/rules.md": rules,
      "/home/me/CLAUDE.md": "claude text",
      "/home/me/changed.md": "the file says something else now",
      "relative/rules.md": "relative text",
    }),
  })
  assert.deepEqual(found, [{ text: `Instructions from: /home/me/rules.md\n${rules}`, content: rules }])
  const all = found.map((block) => block.text).join("\n")
  for (const generated of [OPENCODE_HEADER, "<env>", "fetched text", "claude text", "something else"]) {
    assert.ok(!all.includes(generated), generated)
  }
})

test("a file's trailing newline does not stop the match, and a repeated path counts once", () => {
  const forwarded = "Instructions from: /a.md\nbody\nInstructions from: /a.md\nbody\n"
  const found = userAuthoredInstructions(forwarded, { readFile: files({ "/a.md": "body\n\n\n" }) })
  assert.deepEqual(found, [{ text: "Instructions from: /a.md\nbody", content: "body" }])
})

test("the agent's own prompt counts only when opencode sent it verbatim", () => {
  const agentPrompt = "You review code for security issues only."
  const sent = `${agentPrompt}\n${ENV_BLOCK}`
  assert.deepEqual(userAuthoredInstructions(sent, { agentPrompt, readFile: files({}) }), [
    { text: agentPrompt, content: agentPrompt },
  ])
  // Edited since opencode loaded it, or a built-in agent: nothing.
  assert.deepEqual(userAuthoredInstructions(`${OPENCODE_HEADER}\n${ENV_BLOCK}`, { agentPrompt, readFile: files({}) }), [])
  assert.deepEqual(userAuthoredInstructions(sent, { readFile: files({}) }), [])
})

test("an agent file's body is its prompt; frontmatter is not", () => {
  assert.equal(agentMarkdownBody("---\nmode: subagent\n---\n\nReview only.\n"), "Review only.")
  assert.equal(agentMarkdownBody("Just a prompt.\n"), "Just a prompt.")
  assert.equal(agentMarkdownBody("---\nmode: subagent\n---\n"), undefined)
})

test("the builder appends them after AGENTS.md and skips one it already sends", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ccp-user-instr-")))
  const previous = process.env.XDG_CONFIG_HOME
  process.env.XDG_CONFIG_HOME = path.join(root, "config")
  try {
    const cwd = path.join(root, "work")
    fs.mkdirSync(cwd)
    const agents = "# Project AGENTS\n\nRule one."
    fs.writeFileSync(path.join(cwd, "AGENTS.md"), agents)
    const own = { text: "Instructions from: /team/rules.md\nTeam rule.", content: "Team rule." }
    const dup = { text: `Instructions from: ${cwd}/AGENTS.md\n${agents}`, content: agents }

    const withThem = fs.readFileSync(buildAppendedSystemPrompt(cwd, true, [], { userInstructions: [own, dup] })!, "utf8")
    const without = fs.readFileSync(buildAppendedSystemPrompt(cwd, true, [], {})!, "utf8")
    assert.equal(withThem.split("Rule one.").length - 1, 1, "AGENTS.md once, from the plugin's own read")
    assert.ok(withThem.includes(own.text))
    assert.ok(withThem.indexOf("## Keeping AGENTS.md up to date") < withThem.indexOf(own.text))
    assert.ok(withThem.indexOf(own.text) < withThem.indexOf("## Continuing through multi-step tasks"))
    // Removing the forwarded block leaves exactly what the builder wrote before.
    assert.equal(withThem.replace(`\n\n${own.text}`, ""), without)
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previous
    fs.rmSync(root, { recursive: true, force: true })
  }
})
