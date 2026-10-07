/**
 * Record golden transcripts of the interactive transport against a real
 * Claude Code, for `test/interactive-golden.test.ts` (h #g207).
 *
 * Run under Bun with a logged-in `claude` (it spends a few cheap Haiku turns):
 *
 *   bun scripts/record-interactive-fixtures.ts
 *
 * Writes `test/fixtures/interactive/<cli version>/<scenario>.jsonl` plus a
 * `manifest.json` holding what each live turn returned. The replay test then
 * drives the real `ClaudeSession` over the recorded records and must return
 * the same thing, so a parser change that breaks a real shape fails offline.
 * Record a new directory for every Claude Code release the transport is
 * measured on, next to `INTERACTIVE_MEASURED_CLI`.
 *
 * Redaction keeps only the record kinds the transport reads, drops thinking
 * text, signatures, hook details and environment fields, and replaces the
 * working directory, the home directory and session ids with placeholders.
 */
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { ClaudeSession, encodeCwd, stripTerminal } from "../src/claude-session-bun.js"

const MODEL = "claude-haiku-4-5"
const version = execFileSync("claude", ["--version"], { encoding: "utf8" }).trim().split(/\s+/)[0]!
const outDir = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "test", "fixtures", "interactive", version)
fs.mkdirSync(outDir, { recursive: true })

interface Scenario {
  prompt: string
  /** What the live turn returned; the replay must return the same. */
  expect: { end: string | null; stopReason: string | null; text: string; outputTokens: number; cacheReadTokens: number }
  /** The plan approval dialog as drawn, for the replay to draw. */
  dialogScreen?: string
  /** Records written after the operator acted (Esc, an approval). */
  afterActionFrom?: number
  /** The session this one forks, by placeholder. */
  forkOf?: string
}
const manifest: { cliVersion: string; model: string; recordedAt: string; scenarios: Record<string, Scenario> } = {
  cliVersion: version,
  model: MODEL,
  recordedAt: new Date().toISOString().slice(0, 10),
  scenarios: {},
}

const KEEP_TYPES = new Set(["user", "assistant", "system", "queue-operation", "attachment"])
const KEEP_FIELDS = ["type", "subtype", "uuid", "parentUuid", "isMeta", "isSidechain", "message", "operation", "attachment", "content", "toolUseResult"]

function redact(raw: string, cwd: string, ids: Map<string, string>): string | null {
  const rec = JSON.parse(raw)
  if (!KEEP_TYPES.has(rec.type)) return null
  if (rec.type === "attachment" && rec.attachment?.type !== "queued_command") return null
  if (rec.type === "system" && !["turn_duration", "stop_hook_summary"].includes(rec.subtype)) return null
  const out: Record<string, unknown> = {}
  for (const key of KEEP_FIELDS) if (key in rec) out[key] = rec[key]
  if (rec.type === "system") {
    // Hook commands and timings say nothing the transport reads.
    for (const key of Object.keys(out)) if (!["type", "subtype", "uuid", "parentUuid"].includes(key)) delete out[key]
  }
  const message = out.message as any
  if (Array.isArray(message?.content)) {
    for (const block of message.content) {
      if (block?.type === "thinking") {
        block.thinking = block.thinking ? "[redacted thinking]" : ""
        if ("signature" in block) block.signature = "[redacted]"
      }
    }
  }
  if (out.attachment) {
    const attachment = { ...(out.attachment as any) }
    delete attachment.source_uuid
    delete attachment.delivery_id
    out.attachment = attachment
  }
  let text = JSON.stringify(out)
  for (const [real, placeholder] of ids) text = text.split(real).join(placeholder)
  // The encoded form names Claude's per-project directory (a memory file the
  // model wrote lands there) and carries the machine's temp-dir id.
  text = text.split(encodeCwd(cwd)).join("-work")
  text = text.split(fs.realpathSync(cwd)).join("/work").split(cwd).join("/work").split(os.homedir()).join("~")
  return text
}

function transcriptLines(session: ClaudeSession): string[] {
  try {
    return fs.readFileSync(session.jsonlPath, "utf8").split("\n").filter((line) => line.trim())
  } catch {
    return []
  }
}

function save(name: string, lines: string[], cwd: string, ids: Map<string, string>, from = 0): number {
  const kept: string[] = []
  let afterIndex = -1
  lines.forEach((line, index) => {
    const redacted = redact(line, cwd, ids)
    if (redacted === null) return
    if (index >= from && afterIndex < 0 && from > 0) afterIndex = kept.length
    kept.push(redacted)
  })
  fs.writeFileSync(path.join(outDir, `${name}.jsonl`), kept.join("\n") + "\n")
  return afterIndex
}

/** Records from this turn's own prompt record on (the file's start is boot noise). */
function fromOwnPrompt(lines: string[], prompt: string): string[] {
  const at = lines.findIndex((line) => {
    const rec = JSON.parse(line)
    return rec.type === "user" && typeof rec.message?.content === "string" && rec.message.content.trim() === prompt.trim()
  })
  return at >= 0 ? lines.slice(at) : lines
}

/** From `ask` (a TurnResult) or `tailTurn` (end, usage, callCount). */
function expectOf(result: any) {
  const usage = result.usage ?? null
  return {
    end: result.end ?? (result.stopReason ? "stop" : "ended"),
    stopReason: result.stopReason ?? null,
    text: (result.text ?? "").trim(),
    outputTokens: usage?.output_tokens ?? result.outputTokens ?? 0,
    cacheReadTokens: usage?.cache_read_input_tokens ?? result.cacheReadTokens ?? 0,
  }
}

/** `tailTurn` hands over raw lines: collect the reply's text from them. */
function collectText(raw: string, into: string[]): void {
  try {
    const rec = JSON.parse(raw)
    if (rec?.type === "assistant") for (const b of rec.message?.content ?? []) if (b?.type === "text") into.push(b.text)
  } catch {}
}

function fresh(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ccp-golden-")))
}
const BASH = ["--settings", JSON.stringify({ permissions: { allow: ["Bash"] } })]

// 1. A plain answer.
{
  const cwd = fresh()
  const s = new ClaudeSession({ cwd, model: MODEL })
  await s.start()
  const prompt = "Reply with exactly the word ALPHA and nothing else."
  const r = await s.ask(prompt)
  const ids = new Map([[s.sessionId, "fixture-session"]])
  save("answer", fromOwnPrompt(transcriptLines(s), prompt), cwd, ids)
  manifest.scenarios.answer = { prompt, expect: expectOf(r) }
  s.dispose()
}

// 2. A tool the TUI runs itself, then the reply.
{
  const cwd = fresh()
  const s = new ClaudeSession({ cwd, model: MODEL, extraArgs: BASH })
  await s.start()
  const prompt = "Use the Bash tool to run exactly: echo golden-ok   Then reply with the output only."
  const r = await s.ask(prompt)
  save("native-tool", fromOwnPrompt(transcriptLines(s), prompt), cwd, new Map([[s.sessionId, "fixture-session"]]))
  manifest.scenarios["native-tool"] = { prompt, expect: expectOf(r) }
  s.dispose()
}

// 3. Esc on a running turn.
{
  const cwd = fresh()
  const s = new ClaudeSession({ cwd, model: MODEL })
  await s.start()
  const prompt = "Write a 500-word story about a lighthouse keeper. No tools."
  const collected: string[] = []
  const turn = s.tailTurn(prompt, (raw) => collectText(raw, collected))
  await new Promise((r) => setTimeout(r, 3_000))
  const before = transcriptLines(s).length
  await s.interrupt()
  const r = await turn
  await new Promise((r) => setTimeout(r, 1_500))
  const lines = transcriptLines(s)
  const own = fromOwnPrompt(lines, prompt)
  const offset = lines.length - own.length
  const after = save("interrupted", own, cwd, new Map([[s.sessionId, "fixture-session"]]), before - offset)
  manifest.scenarios.interrupted = {
    prompt,
    expect: { ...expectOf(r), text: collected.join("").trim() },
    afterActionFrom: after,
  }
  s.dispose()
}

// 4. Plan mode: ExitPlanMode, the dialog, approval.
{
  const cwd = fresh()
  const events: any[] = []
  const s: any = new ClaudeSession({
    cwd,
    model: MODEL,
    extraArgs: ["--permission-mode", "plan", "--settings", JSON.stringify({ permissions: { allow: ["Write", "Edit", "Read"] } })],
    onScreen: (event) => events.push(event),
  })
  await s.start()
  const prompt = "Create a file named plan.txt containing the word hi. You are in plan mode: write a one-line plan and call ExitPlanMode with it."
  const collected: string[] = []
  const turn = s.tailTurn(prompt, (raw: string) => collectText(raw, collected))
  for (let i = 0; i < 240 && !events.some((e) => e.action === "parked"); i++) await new Promise((r) => setTimeout(r, 250))
  const dialogScreen = stripTerminal(s.rawTail(6000))
  const at = dialogScreen.lastIndexOf("Would you like to proceed?")
  const before = transcriptLines(s).length
  await s.answerPlanApproval({ approved: true })
  const r = await turn
  const lines = transcriptLines(s)
  const own = fromOwnPrompt(lines, prompt)
  const offset = lines.length - own.length
  const ids = new Map([[s.sessionId, "fixture-session"]])
  const after = save("plan-approval", own, cwd, ids, before - offset)
  manifest.scenarios["plan-approval"] = {
    prompt,
    expect: { ...expectOf(r), text: collected.join("\n").trim() },
    dialogScreen: dialogScreen.slice(Math.max(0, at - 80), at + 220).split(os.homedir()).join("~"),
    afterActionFrom: after,
  }
  s.dispose()
}

// 5. A message queued into the running turn.
{
  const cwd = fresh()
  const s = new ClaudeSession({ cwd, model: MODEL, extraArgs: BASH })
  await s.start()
  const prompt = "Use the Bash tool to run exactly: sleep 8 && echo first-done   Then report the output."
  const collected: string[] = []
  const turn = s.tailTurn(prompt, (raw) => collectText(raw, collected))
  for (let i = 0; i < 120 && !transcriptLines(s).some((l) => l.includes('"name":"Bash"')); i++) await new Promise((r) => setTimeout(r, 250))
  await new Promise((r) => setTimeout(r, 1_000))
  const queued = await s.queueInput("Also, in the same reply, say the word PELICAN.")
  const r = await turn
  save("queued-input", fromOwnPrompt(transcriptLines(s), prompt), cwd, new Map([[s.sessionId, "fixture-session"]]))
  manifest.scenarios["queued-input"] = { prompt, expect: { ...expectOf(r), text: collected.join("\n").trim() } }
  if (!queued) throw new Error("the TUI did not take the queued message")
  s.dispose()
}

// 6. A fork answering a side question: the copied history comes first.
{
  const cwd = fresh()
  const main = new ClaudeSession({ cwd, model: MODEL })
  await main.start()
  await main.ask("Remember the codeword ORCHID. Reply only OK.")
  const fork = new ClaudeSession({ cwd, model: MODEL, forkOf: main.sessionId })
  await fork.start()
  const prompt = "Side question: what was the codeword? Answer with one word, no tools."
  const r = await fork.ask(prompt)
  const ids = new Map([[fork.sessionId, "fixture-fork"], [main.sessionId, "fixture-session"]])
  save("fork", transcriptLines(fork), cwd, ids)
  manifest.scenarios.fork = { prompt, expect: expectOf(r), forkOf: "fixture-session" }
  fork.dispose()
  main.dispose()
}

fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n")
console.log(`recorded ${Object.keys(manifest.scenarios).length} scenarios for Claude Code ${version} in ${outDir}`)
process.exit(0)
