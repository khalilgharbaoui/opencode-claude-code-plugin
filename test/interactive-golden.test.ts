/**
 * Recorded transcripts of real Claude Code releases, replayed through the real
 * interactive transport (h #g207).
 *
 * `scripts/record-interactive-fixtures.ts` ran each scenario live and wrote
 * the transcript (redacted) plus what the live turn returned into
 * `test/fixtures/interactive/<version>/`. Here the same `ClaudeSession` reads
 * those exact records back through a scripted PTY that writes them where the
 * TUI did, performs the operator's action where there was one (Esc, the plan
 * approval), and must return what the live run returned. A parser change that
 * mis-reads a shape some release really writes fails here, offline.
 */
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"
import {
  ClaudeSession,
  interactiveTranscriptPath,
  type ClaudeSessionOptions,
  type PtySpawner,
} from "../src/claude-session-bun.js"

const here = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.join(here, "fixtures", "interactive")

const FAST = {
  bootMinMs: 0,
  bootQuietMs: 10,
  bootMaxMs: 3_000,
  pollMs: 5,
  submitMinMs: 0,
  submitConfirmMs: 100,
  stopSettleMs: 30,
  heartbeatMs: 1_000,
  interruptGraceMs: 500,
  permissionQuietMs: 15,
} satisfies Partial<ClaudeSessionOptions>

interface Scenario {
  prompt: string
  expect: { end: string | null; stopReason: string | null; text: string; outputTokens: number; cacheReadTokens: number }
  dialogScreen?: string
  afterActionFrom?: number
  forkOf?: string
}

/**
 * A PTY that plays a recorded transcript: the records up to the operator's
 * action on Enter, the rest when the action arrives (Esc, or the key the
 * session picked off the recorded dialog).
 */
function replay(records: string[], scenario: Scenario, action: "esc" | "approve" | null) {
  const writes: string[] = []
  let transcript = ""
  let draw: (text: string) => void = () => {}
  let resolveExit: (code: number | null) => void = () => {}
  let pasted = false
  let submitted = false
  let acted = false
  const cut = action ? scenario.afterActionFrom ?? records.length : records.length
  const append = (lines: string[]) => fs.appendFileSync(transcript, lines.map((line) => line + "\n").join(""))
  const spawner: PtySpawner = (argv, opts) => {
    const at = (flag: string) => argv[argv.indexOf(flag) + 1]
    transcript = interactiveTranscriptPath({
      configDir: opts.env.CLAUDE_CONFIG_DIR,
      cwd: opts.cwd,
      sessionId: argv.includes("--fork-session") ? at("--session-id")! : (argv.includes("--resume") ? at("--resume")! : at("--session-id")!),
    })
    fs.mkdirSync(path.dirname(transcript), { recursive: true })
    draw = opts.onData
    return {
      exited: new Promise((resolve) => (resolveExit = resolve)),
      kill: () => resolveExit(null),
      terminal: {
        write: (data: string) => {
          writes.push(data)
          if (data.startsWith("\x1b[200~")) return void (pasted = true)
          if (data === "\r" && pasted && !submitted) {
            submitted = true
            append(records.slice(0, cut))
            if (action === "approve" && scenario.dialogScreen) setTimeout(() => draw(scenario.dialogScreen!), 20)
            return
          }
          const actionArrived = action === "esc" ? data === "\x1b" : action === "approve" && /^\d$/.test(data)
          if (actionArrived && !acted) {
            acted = true
            append(records.slice(cut))
          }
        },
        close: () => {},
      },
    }
  }
  return { spawner, writes }
}

function textOf(raw: string, into: string[]): void {
  try {
    const rec = JSON.parse(raw)
    if (rec?.type === "assistant") for (const block of rec.message?.content ?? []) if (block?.type === "text") into.push(block.text)
  } catch {}
}

const versions = fs.existsSync(FIXTURES) ? fs.readdirSync(FIXTURES).filter((v) => /^\d+\.\d+\.\d+$/.test(v)) : []

test("at least one Claude Code release is recorded", () => {
  assert(versions.length > 0, `no recorded release under ${FIXTURES}`)
})

for (const version of versions) {
  const dir = path.join(FIXTURES, version)
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"))
  for (const [name, scenario] of Object.entries<Scenario>(manifest.scenarios)) {
    test(`Claude Code ${version}: the ${name} transcript reads back as it did live`, async () => {
      const records = fs.readFileSync(path.join(dir, `${name}.jsonl`), "utf8").split("\n").filter((line) => line.trim())
      const action = name === "interrupted" ? "esc" : name === "plan-approval" ? "approve" : null
      const { spawner, writes } = replay(records, scenario, action)
      const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ccp-golden-")))
      const cwd = path.join(root, "work")
      fs.mkdirSync(cwd)
      const session = new ClaudeSession({
        ...FAST,
        cwd,
        configDir: path.join(root, "config"),
        env: {},
        spawnPty: spawner,
        ...(scenario.forkOf ? { forkOf: scenario.forkOf } : {}),
      })
      try {
        await session.start()
        const text: string[] = []
        const turn = session.tailTurn(scenario.prompt, (raw) => textOf(raw, text))
        if (action === "esc") {
          await new Promise((resolve) => setTimeout(resolve, 50))
          await session.interrupt()
        } else if (action === "approve") {
          for (let i = 0; i < 200 && session.pendingPlanApproval === null; i++) await new Promise((r) => setTimeout(r, 5))
          assert.equal(await session.answerPlanApproval({ approved: true }), true, "the recorded dialog is answerable")
          assert(writes.includes("2"), "the recorded dialog's own approve choice was pressed")
        }
        const result = await turn
        assert.equal(result.end, scenario.expect.end)
        assert.equal(result.stopReason, scenario.expect.stopReason)
        assert.equal(text.join(name === "interrupted" ? "" : "\n").trim(), scenario.expect.text)
        assert.equal(result.usage?.output_tokens ?? 0, scenario.expect.outputTokens, "output counted once per API call")
        assert.equal(result.usage?.cache_read_input_tokens ?? 0, scenario.expect.cacheReadTokens)
      } finally {
        session.dispose()
        fs.rmSync(root, { recursive: true, force: true })
      }
    })
  }
}
