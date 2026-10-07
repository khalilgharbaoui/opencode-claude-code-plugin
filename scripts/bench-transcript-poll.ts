/**
 * What one transcript poll of the interactive (PTY) transport costs.
 *
 * The transport follows a turn by polling the TUI's JSONL transcript every
 * `pollMs`. A long conversation's transcript reaches tens of megabytes, so the
 * question this answers is: how many bytes and how much CPU does a single poll
 * spend, and how much of that is re-reading what it already read.
 *
 * It builds a synthetic transcript out of the redacted fixtures in
 * `test/fixtures/interactive/`, starts a `ClaudeSession` against a scripted PTY
 * (no `claude`, no network, no PTY), runs one turn that appends a handful of
 * records while the poll loop runs, and reports the totals.
 *
 *   npx tsx scripts/bench-transcript-poll.ts
 *   npx tsx scripts/bench-transcript-poll.ts --records 20000 --impl ../src/old.js
 *
 * `--impl` points at another module exporting the same `ClaudeSession`, which
 * is how a before/after comparison is run: copy the previous implementation
 * into `src/`, point this at it, and run both.
 */
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.join(here, "..", "test", "fixtures", "interactive")

function flag(name: string, fallback: string): string {
  const index = process.argv.indexOf(name)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1]! : fallback
}

const RECORDS = Number(flag("--records", "20000"))
const POLL_MS = Number(flag("--poll-ms", "20"))
const TURN_MS = Number(flag("--turn-ms", "4000"))
const IMPL = flag("--impl", "../src/claude-session-bun.js")

const impl = (await import(new URL(IMPL, import.meta.url).href)) as typeof import("../src/claude-session-bun.js")
const { ClaudeSession, interactiveTranscriptPath } = impl

/** The fixture records, which is what a real transcript's lines look like. */
function fixtureLines(): string[] {
  const versions = fs.readdirSync(FIXTURES).filter((name) => /^\d+\.\d+\.\d+$/.test(name))
  const lines: string[] = []
  for (const version of versions) {
    const dir = path.join(FIXTURES, version)
    for (const file of fs.readdirSync(dir).filter((name) => name.endsWith(".jsonl"))) {
      for (const line of fs.readFileSync(path.join(dir, file), "utf8").split("\n")) {
        if (line.trim()) lines.push(line)
      }
    }
  }
  if (lines.length === 0) throw new Error(`no fixture records under ${FIXTURES}`)
  return lines
}

function buildTranscript(target: string, records: number): number {
  const source = fixtureLines()
  const out = fs.openSync(target, "w")
  let bytes = 0
  let chunk = ""
  for (let i = 0; i < records; i++) {
    chunk += source[i % source.length]! + "\n"
    if (chunk.length > 1 << 20) {
      bytes += Buffer.byteLength(chunk)
      fs.writeSync(out, chunk)
      chunk = ""
    }
  }
  if (chunk) {
    bytes += Buffer.byteLength(chunk)
    fs.writeSync(out, chunk)
  }
  fs.closeSync(out)
  return bytes
}

const assistant = (id: string, stopReason: string | null, text: string) =>
  JSON.stringify({
    type: "assistant",
    uuid: `bench-${id}`,
    message: {
      id,
      model: "claude-haiku-4-5-20251001",
      role: "assistant",
      stop_reason: stopReason,
      content: [{ type: "text", text }],
      usage: { input_tokens: 3, cache_read_input_tokens: 100, output_tokens: 7 },
    },
  })

const fmt = (n: number) => n.toLocaleString("en-US")
const mb = (n: number) => `${(n / (1 << 20)).toFixed(1)} MB`

async function main(): Promise<void> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ccp-bench-")))
  const cwd = path.join(root, "work")
  const configDir = path.join(root, "config")
  fs.mkdirSync(cwd)
  const sessionId = "00000000-0000-4000-8000-000000000001"
  const transcript = interactiveTranscriptPath({ configDir, cwd, sessionId })
  fs.mkdirSync(path.dirname(transcript), { recursive: true })
  const transcriptBytes = buildTranscript(transcript, RECORDS)

  let resolveExit: (code: number | null) => void = () => {}
  let pasted = false
  const timers: ReturnType<typeof setTimeout>[] = []
  const append = (line: string) => fs.appendFileSync(transcript, line + "\n")

  const session = new ClaudeSession({
    cwd,
    configDir,
    env: {},
    // The session reads the transcript this bench just built, which is what a
    // resumed conversation's first turn does.
    resumeSessionId: sessionId,
    bootMinMs: 0,
    bootQuietMs: 10,
    bootMaxMs: 3_000,
    pollMs: POLL_MS,
    submitMinMs: 0,
    submitConfirmMs: 100,
    stopSettleMs: 30,
    permissionQuietMs: 1_000,
    heartbeatMs: 1_000_000,
    spawnPty: () => {
      return {
        exited: new Promise<number | null>((resolve) => (resolveExit = resolve)),
        kill: () => resolveExit(null),
        terminal: {
          write: (data: string) => {
            if (data.startsWith("\x1b[200~")) return void (pasted = true)
            if (data !== "\r" || !pasted) return
            pasted = false
            append(JSON.stringify({ type: "user", message: { role: "user", content: "bench" } }))
            // A working TUI writes a record now and then while the poll loop
            // runs; the turn ends once the last one carries a terminal stop.
            const every = Math.max(1, Math.floor(TURN_MS / 10))
            for (let i = 1; i <= 10; i++) {
              timers.push(setTimeout(() => append(assistant(`msg_${i}`, null, `step ${i}`)), every * i))
            }
            timers.push(setTimeout(() => append(assistant("msg_final", "end_turn", "done")), TURN_MS))
          },
          close: () => {},
        },
      }
    },
  })

  const startCpu0 = process.cpuUsage()
  const startWall0 = Date.now()
  await session.start()
  const startCpu = process.cpuUsage(startCpu0)
  const startWall = Date.now() - startWall0
  const afterStart = { ...session.transcriptStats }

  const turnCpu0 = process.cpuUsage()
  const turnWall0 = Date.now()
  const result = await session.tailTurn("bench", () => {})
  const turnCpu = process.cpuUsage(turnCpu0)
  const turnWall = Date.now() - turnWall0
  const total = { ...session.transcriptStats }

  for (const timer of timers) clearTimeout(timer)
  session.dispose()
  fs.rmSync(root, { recursive: true, force: true })

  const polls = total.polls - afterStart.polls
  const bytes = total.bytes - afterStart.bytes
  const cpuMs = (turnCpu.user + turnCpu.system) / 1000
  console.log(`impl               ${IMPL}`)
  console.log(`transcript         ${fmt(RECORDS)} records, ${mb(transcriptBytes)}`)
  console.log(`turn end           ${result.end} / ${result.stopReason}`)
  console.log("")
  console.log(`start()            ${mb(afterStart.bytes)} over ${afterStart.polls} poll(s), ${startCpu.user / 1000 + startCpu.system / 1000} ms CPU, ${startWall} ms wall`)
  console.log(`turn polls         ${fmt(polls)} over ${fmt(turnWall)} ms wall`)
  console.log(`turn bytes read    ${mb(bytes)} total, ${fmt(Math.round(bytes / Math.max(1, polls)))} bytes/poll`)
  console.log(`turn read syscalls ${fmt(total.reads - afterStart.reads)}`)
  console.log(`turn CPU           ${cpuMs.toFixed(1)} ms total, ${(cpuMs / Math.max(1, polls)).toFixed(3)} ms/poll`)
}

await main()
