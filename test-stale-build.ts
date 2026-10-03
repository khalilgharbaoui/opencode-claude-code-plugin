/**
 * Telling the operator that the opencode process they are talking to is
 * running an older plugin build than the one on disk (src/stale-build.ts,
 * h #g192).
 *
 * Two halves. The watch itself is pure apart from the filesystem, so it is
 * driven here with an injected disk and clock: every verdict, every read
 * failure that must stay silent, the throttle, the once-per-session claim and
 * its cap. The wiring is not: `src/turn-state.ts`, `src/turn-controller.ts`
 * and the turn in `claude-code-language-model.ts` have no test file of their
 * own on purpose (h #g165), so the note is asserted through a real `doStream`
 * against a fake `claude` instead, which is the only way to see that it lands
 * ahead of Claude's first text, once per session, and counts as output
 * nowhere.
 *
 * Usage: npx tsx --test test-stale-build.ts
 */
import assert from "node:assert/strict"
import { after, test } from "node:test"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { SILENT_TURN_MARKER } from "./src/cli-events.js"
import { createClaudeCode } from "./src/index.js"
import { filterSideQuestionHistory } from "./src/message-builder.js"
import { setOpencodeClient } from "./src/runtime-status.js"
import {
  deleteActiveProcess,
  killAllActiveProcesses,
  sessionKey,
} from "./src/session-manager.js"
import {
  STALE_BUILD_MARKER,
  STALE_BUILD_SESSION_CAP,
  STALE_BUILD_THROTTLE_MS,
  _setStaleBuildWatch,
  compareBuilds,
  createStaleBuildWatch,
  describeBuildStatus,
  formatLocalMinute,
  formatStaleBuildNote,
  staleBuildWatch,
  type LoadedBuild,
  type OnDiskBuild,
  type StaleBuildWatch,
} from "./src/stale-build.js"

/** Taken after every import above was evaluated, so after the plugin loaded. */
const importedBy = Date.now()

after(() => {
  _setStaleBuildWatch(undefined)
  killAllActiveProcesses()
})

const LOADED_AT = new Date(2026, 8, 22, 20, 56).getTime()

const loaded: LoadedBuild = {
  version: "0.29.1",
  entryPath: "/pkg/dist/index.js",
  mtimeMs: 1_000,
  size: 500,
  loadedAt: LOADED_AT,
}

/** A watch over a disk and a clock a test owns outright. */
function watchOver(disk: { current: OnDiskBuild | undefined | (() => never) }) {
  const warnings: Record<string, unknown>[] = []
  const clock = { now: 0 }
  const watch = createStaleBuildWatch({
    loaded,
    readOnDisk: () => {
      const value = disk.current
      return typeof value === "function" ? value() : value
    },
    now: () => clock.now,
    warn: (data) => warnings.push(data),
  })
  return { watch, warnings, clock }
}

// ---------------------------------------------------------------------------
// the verdicts
// ---------------------------------------------------------------------------

test("a different version on disk is the version verdict", () => {
  const stale = compareBuilds(loaded, { version: "0.36.5", mtimeMs: 1_000, size: 500 })
  assert.deepEqual(stale, {
    kind: "version",
    loadedVersion: "0.29.1",
    onDiskVersion: "0.36.5",
    loadedAt: LOADED_AT,
  })
})

test("the same version with a newer entry file is the rebuilt verdict", () => {
  // The maintainer runs from a `file://` path, so `npm run build` replaces
  // dist/index.js without ever touching the version.
  const byMtime = compareBuilds(loaded, { version: "0.29.1", mtimeMs: 9_000, size: 500 })
  assert.equal(byMtime?.kind, "rebuilt")
  assert.equal(byMtime?.rebuiltAt, 9_000)

  // A rebuild that lands on the same mtime still changes the size.
  const bySize = compareBuilds(loaded, { version: "0.29.1", mtimeMs: 1_000, size: 501 })
  assert.equal(bySize?.kind, "rebuilt")
})

test("an identical build on disk is not stale", () => {
  assert.equal(compareBuilds(loaded, { version: "0.29.1", mtimeMs: 1_000, size: 500 }), null)
})

test("anything the check could not read is nothing, never a note", () => {
  // The package cache deleted but not yet repopulated, a build caught
  // mid-`clean`, a read-only mount: none of these says the running build is
  // stale, and a note here would fire in the busiest possible moment.
  assert.equal(compareBuilds(loaded, undefined), null)

  // A load that could not stat its own entry keeps `version` working and
  // gives up on `rebuilt` only, because it has no baseline to compare.
  const noBaseline: LoadedBuild = { ...loaded, mtimeMs: undefined, size: undefined }
  assert.equal(compareBuilds(noBaseline, { version: "0.29.1", mtimeMs: 9_000, size: 999 }), null)
  assert.equal(
    compareBuilds(noBaseline, { version: "0.36.5", mtimeMs: 9_000, size: 999 })?.kind,
    "version",
  )
})

test("a read that throws is swallowed by the watch, not by the caller", () => {
  const disk = {
    current: (() => {
      throw new Error("ENOENT: dist/index.js vanished mid-build")
    }) as unknown as OnDiskBuild,
  }
  const { watch, warnings } = watchOver(disk as never)
  assert.equal(watch.check(), null)
  assert.equal(watch.describe().verdict, "unreadable")
  assert.equal(warnings.length, 0, "an unreadable disk is not something to warn about")
})

// ---------------------------------------------------------------------------
// the throttle and the warning
// ---------------------------------------------------------------------------

test("the disk is read at most once per throttle window", () => {
  let reads = 0
  const clock = { now: 0 }
  const watch = createStaleBuildWatch({
    loaded,
    readOnDisk: () => {
      reads++
      return { version: "0.36.5", mtimeMs: 1_000, size: 500 }
    },
    now: () => clock.now,
    warn: () => {},
  })

  assert.equal(watch.check()?.kind, "version")
  assert.equal(reads, 1)
  clock.now = STALE_BUILD_THROTTLE_MS - 1
  assert.equal(watch.check()?.kind, "version", "the cached verdict is still returned")
  assert.equal(reads, 1, "an ordinary turn inside the window does no I/O")
  clock.now = STALE_BUILD_THROTTLE_MS
  watch.check()
  assert.equal(reads, 2)

  // The doctor is not throttled, and reading it does not move the window.
  watch.describe()
  assert.equal(reads, 3)
  assert.equal(watch.check()?.kind, "version")
  assert.equal(reads, 3)
})

test("one WARN per on-disk identity, naming both versions and the kind", () => {
  const disk: { current: OnDiskBuild | undefined } = {
    current: { version: "0.36.5", mtimeMs: 1_000, size: 500 },
  }
  const { watch, warnings, clock } = watchOver(disk)

  watch.check()
  assert.deepEqual(warnings, [
    {
      kind: "version",
      loadedVersion: "0.29.1",
      onDiskVersion: "0.36.5",
      path: "/pkg/dist/index.js",
    },
  ])

  // The same staleness on the next window is not news.
  clock.now += STALE_BUILD_THROTTLE_MS
  watch.check()
  assert.equal(warnings.length, 1)

  // A second install is.
  disk.current = { version: "0.36.6", mtimeMs: 2_000, size: 600 }
  clock.now += STALE_BUILD_THROTTLE_MS
  watch.check()
  assert.equal(warnings.length, 2)
  assert.equal(warnings[1]!.onDiskVersion, "0.36.6")

  // The doctor observes; it never warns.
  disk.current = { version: "0.36.7", mtimeMs: 3_000, size: 700 }
  watch.describe()
  assert.equal(warnings.length, 2)
})

// ---------------------------------------------------------------------------
// who gets told
// ---------------------------------------------------------------------------

test("a session is told once, and the set of told sessions is bounded", () => {
  const { watch } = watchOver({ current: undefined })
  assert.equal(watch.claimSession("ses_a"), true)
  assert.equal(watch.claimSession("ses_a"), false)
  assert.equal(watch.claimSession("ses_b"), true)

  for (let index = 0; index < STALE_BUILD_SESSION_CAP + 10; index++) {
    watch.claimSession(`ses_fill_${index}`)
  }
  assert.equal(watch.claimedSessions().length, STALE_BUILD_SESSION_CAP)
  // The oldest entries are what go, so the newest conversations stay quiet.
  assert.equal(watch.claimedSessions().includes("ses_a"), false)
  assert.ok(watch.claimedSessions().includes(`ses_fill_${STALE_BUILD_SESSION_CAP + 9}`))
})

// ---------------------------------------------------------------------------
// what it says
// ---------------------------------------------------------------------------

test("the note leads with the marker and names both builds in local time", () => {
  const note = formatStaleBuildNote({
    kind: "version",
    loadedVersion: "0.29.1",
    onDiskVersion: "0.36.5",
    loadedAt: LOADED_AT,
  })
  assert.ok(note.startsWith(STALE_BUILD_MARKER))
  assert.ok(note.includes("plugin 0.36.5 is on disk"))
  assert.ok(note.includes("still runs 0.29.1, loaded 2026-09-22 20:56"))
  assert.ok(note.includes("quit every opencode window and relaunch"))

  const rebuiltAt = new Date(2026, 9, 3, 14, 21).getTime()
  const rebuilt = formatStaleBuildNote({
    kind: "rebuilt",
    loadedVersion: "0.36.5",
    onDiskVersion: "0.36.5",
    loadedAt: LOADED_AT,
    rebuiltAt,
  })
  assert.ok(rebuilt.startsWith(STALE_BUILD_MARKER))
  assert.ok(rebuilt.includes("rebuilt on disk at 2026-10-03 14:21"))
})

test("minute precision, in local time, because that is what a clock on the wall says", () => {
  assert.equal(formatLocalMinute(new Date(2026, 0, 2, 3, 4, 59).getTime()), "2026-01-02 03:04")
})

test("the doctor's verdict distinguishes current from unreadable", () => {
  const { watch } = watchOver({ current: { version: "0.29.1", mtimeMs: 1_000, size: 500 } })
  assert.ok(describeBuildStatus(watch.describe()).endsWith("current"))

  const blind = watchOver({ current: undefined })
  const text = describeBuildStatus(blind.watch.describe())
  assert.ok(text.includes("could not be read"))
  assert.equal(text.includes("current"), false)
})

test("a marker-led note is stripped from a transcript rebuilt for the CLI", () => {
  const note = formatStaleBuildNote({
    kind: "version",
    loadedVersion: "0.29.1",
    onDiskVersion: "0.36.5",
    loadedAt: LOADED_AT,
  })
  const kept = filterSideQuestionHistory([
    { role: "user", content: [{ type: "text", text: "hello" }] },
    {
      role: "assistant",
      content: [
        { type: "text", text: note },
        { type: "text", text: "Claude's real answer." },
      ],
    },
  ] as any)
  const assistant = kept.find((message: any) => message.role === "assistant") as any
  assert.deepEqual(
    assistant.content.map((part: any) => part.text),
    ["Claude's real answer."],
  )
})

// ---------------------------------------------------------------------------
// through a real doStream
// ---------------------------------------------------------------------------

/** A fake `claude` that replays a fixed line sequence on the first stdin write. */
function createFakeCli(lines: unknown[]) {
  const cwd = mkdtempSync(join(tmpdir(), "opencode-stale-build-"))
  const cliPath = join(cwd, "fake-claude.cjs")
  const source = `#!/usr/bin/env node
const readline = require("node:readline")

if (process.argv.includes("--version")) {
  process.stdout.write("2.1.263\\n")
  process.exit(0)
}

const LINES = ${JSON.stringify(lines)}
const rl = readline.createInterface({ input: process.stdin })
let answered = false
rl.on("line", () => {
  if (answered) return
  answered = true
  for (const line of LINES) process.stdout.write(JSON.stringify(line) + "\\n")
})
`
  writeFileSync(cliPath, source)
  chmodSync(cliPath, 0o755)
  return { cliPath, cwd }
}

const init = {
  type: "system",
  subtype: "init",
  session_id: "fake-session",
  tools: ["Read"],
}

const text = (body: string) => ({
  type: "stream_event",
  session_id: "fake-session",
  event: {
    type: "content_block_delta",
    index: 1,
    delta: { type: "text_delta", text: body },
  },
})

const endTurn = {
  type: "stream_event",
  session_id: "fake-session",
  event: { type: "message_delta", delta: { stop_reason: "end_turn" } },
}

const successResult = {
  type: "result",
  subtype: "success",
  session_id: "fake-session",
  is_error: false,
  result: "",
  total_cost_usd: 0.001,
  duration_ms: 900,
  num_turns: 1,
  usage: { input_tokens: 10, output_tokens: 4 },
}

/** The process watch, over a disk this test owns. `null` means never stale. */
function installWatch(onDisk: OnDiskBuild | undefined): StaleBuildWatch {
  const watch = createStaleBuildWatch({
    loaded,
    readOnDisk: () => onDisk,
    now: () => Date.now(),
    warn: () => {},
  })
  _setStaleBuildWatch(watch)
  return watch
}

const MODEL_ID = "claude-test-stale-build"

function keyFor(cwd: string, affinity: string): string {
  return sessionKey(cwd, `${MODEL_ID}::tools::${affinity}::context=["claude-code",null]`)
}

async function turn(
  fake: { cliPath: string; cwd: string },
  affinity: string,
  settings: Record<string, unknown> = {},
  callOptions: Record<string, unknown> = {},
): Promise<any[]> {
  const model = createClaudeCode({
    cliPath: fake.cliPath,
    cwd: fake.cwd,
    bridgeOpencodeMcp: false,
    proxyOpencodeMcpTools: false,
    proxyTools: [],
    ...settings,
  }).languageModel(MODEL_ID)

  const response = await model.doStream({
    prompt: [{ role: "user", content: [{ type: "text", text: "go" }] }],
    headers: { "x-session-affinity": affinity },
    tools: [
      {
        type: "function",
        name: "read",
        description: "Read a file",
        inputSchema: { type: "object", properties: {} },
      },
    ],
    ...callOptions,
  } as any)

  const parts: any[] = []
  for await (const part of response.stream) parts.push(part)
  return parts
}

function bodyOf(parts: any[]): string {
  return parts
    .filter((part) => part.type === "text-delta")
    .map((part) => part.delta)
    .join("")
}

test("a current build says nothing at all", async () => {
  installWatch({ version: loaded.version, mtimeMs: loaded.mtimeMs!, size: loaded.size! })
  const fake = createFakeCli([init, text("hello"), endTurn, successResult])
  try {
    const parts = await turn(fake, "ses_current")
    assert.equal(bodyOf(parts).includes(STALE_BUILD_MARKER), false)
  } finally {
    deleteActiveProcess(keyFor(fake.cwd, "ses_current"))
    rmSync(fake.cwd, { recursive: true, force: true })
  }
})

test("a stale build writes one note, before Claude's first text, once per session", async () => {
  installWatch({ version: "0.36.5", mtimeMs: loaded.mtimeMs!, size: loaded.size! })
  const fake = createFakeCli([init, text("hello"), endTurn, successResult])
  try {
    const first = await turn(fake, "ses_stale")
    const body = bodyOf(first)
    assert.ok(body.includes(STALE_BUILD_MARKER), body)
    assert.ok(body.includes("plugin 0.36.5 is on disk"), body)

    // Its own text part, which is what makes the transcript strip exact, and
    // ahead of everything Claude said, which is what makes it readable.
    const noteAt = first.findIndex(
      (part) => part.type === "text-delta" && part.delta.includes(STALE_BUILD_MARKER),
    )
    const claudeAt = first.findIndex(
      (part) => part.type === "text-delta" && part.delta.includes("hello"),
    )
    assert.ok(noteAt >= 0 && claudeAt > noteAt, "the note must precede Claude's own text")
    assert.equal(first[noteAt - 1].type, "text-start")
    assert.equal(first[noteAt + 1].type, "text-end")

    // It is not Claude's output anywhere: a turn that said nothing but the
    // note is still a silent turn, and the finish is an ordinary stop.
    assert.equal(bodyOf(first).includes(SILENT_TURN_MARKER), false)
    const finish = first.find((part) => part.type === "finish")
    assert.equal(finish.finishReason.unified, "stop")
    assert.equal(finish.usage.outputTokens.total, 4, "the note adds nothing to the bill")

    // The second turn of the same conversation has nothing new to say.
    const second = await turn(fake, "ses_stale")
    assert.equal(bodyOf(second).includes(STALE_BUILD_MARKER), false)
    assert.ok(bodyOf(second).includes("hello"))
  } finally {
    deleteActiveProcess(keyFor(fake.cwd, "ses_stale"))
    rmSync(fake.cwd, { recursive: true, force: true })
  }
})

test("a note-only turn is still reported as a silent turn", async () => {
  // The note is written by the plugin, so it must not satisfy the "Claude said
  // something" test any more than it satisfies the bill.
  installWatch({ version: "0.36.5", mtimeMs: loaded.mtimeMs!, size: loaded.size! })
  const fake = createFakeCli([init, endTurn, successResult])
  try {
    const parts = await turn(fake, "ses_quiet")
    const body = bodyOf(parts)
    assert.ok(body.includes(STALE_BUILD_MARKER), body)
    assert.ok(body.includes(SILENT_TURN_MARKER), body)
  } finally {
    deleteActiveProcess(keyFor(fake.cwd, "ses_quiet"))
    rmSync(fake.cwd, { recursive: true, force: true })
  }
})

test("a turn with no real opencode session is never told", async () => {
  // `default` is the fallback affinity for a call that carried no session at
  // all, so there is no conversation to own the note and no way to stop
  // repeating it.
  installWatch({ version: "0.36.5", mtimeMs: loaded.mtimeMs!, size: loaded.size! })
  const fake = createFakeCli([init, text("hello"), endTurn, successResult])
  try {
    const model = createClaudeCode({
      cliPath: fake.cliPath,
      cwd: fake.cwd,
      bridgeOpencodeMcp: false,
      proxyOpencodeMcpTools: false,
      proxyTools: [],
    }).languageModel(MODEL_ID)
    const response = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      tools: [
        {
          type: "function",
          name: "read",
          description: "Read a file",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    } as any)
    const parts: any[] = []
    for await (const part of response.stream) parts.push(part)
    assert.equal(bodyOf(parts).includes(STALE_BUILD_MARKER), false)
  } finally {
    deleteActiveProcess(keyFor(fake.cwd, "default"))
    rmSync(fake.cwd, { recursive: true, force: true })
  }
})

test("a subagent is never told, because its reply can become the parent's result", async () => {
  installWatch({ version: "0.36.5", mtimeMs: loaded.mtimeMs!, size: loaded.size! })
  const fake = createFakeCli([init, text("hello"), endTurn, successResult])
  setOpencodeClient({
    session: {
      get: async () => ({ data: { id: "ses_child", parentID: "ses_parent" } }),
    },
  } as any)
  try {
    const parts = await turn(fake, "ses_child")
    assert.equal(bodyOf(parts).includes(STALE_BUILD_MARKER), false)
    assert.ok(bodyOf(parts).includes("hello"))
  } finally {
    // `setOpencodeClient` ignores null, so "no client" is a client with no
    // routes; leaving the child's lookup installed would make every later
    // session in this file look like a subagent.
    setOpencodeClient({} as any)
    deleteActiveProcess(keyFor(fake.cwd, "ses_child"))
    rmSync(fake.cwd, { recursive: true, force: true })
  }
})

test("a compaction turn never carries the note into the summary", async () => {
  installWatch({ version: "0.36.5", mtimeMs: loaded.mtimeMs!, size: loaded.size! })
  const fake = createFakeCli([init, text("a summary"), endTurn, successResult])
  try {
    const parts = await turn(
      fake,
      "ses_compaction",
      {},
      {
        providerOptions: { "claude-code": { opencodeAgent: "compaction" } },
      },
    )
    assert.equal(bodyOf(parts).includes(STALE_BUILD_MARKER), false)
    assert.ok(bodyOf(parts).includes("a summary"))
  } finally {
    killAllActiveProcesses()
    rmSync(fake.cwd, { recursive: true, force: true })
  }
})

test("a title request is answered by the stub, so it never reaches the note", async () => {
  installWatch({ version: "0.36.5", mtimeMs: loaded.mtimeMs!, size: loaded.size! })
  const fake = createFakeCli([init, text("hello"), endTurn, successResult])
  try {
    const model = createClaudeCode({
      cliPath: fake.cliPath,
      cwd: fake.cwd,
      bridgeOpencodeMcp: false,
      proxyOpencodeMcpTools: false,
      proxyTools: [],
    }).languageModel(MODEL_ID)
    // No tools is what selects the title stub on a 1.x host.
    const response = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "summarise this thread" }] }],
      headers: { "x-session-affinity": "ses_title" },
    } as any)
    const parts: any[] = []
    for await (const part of response.stream) parts.push(part)
    assert.equal(bodyOf(parts).includes(STALE_BUILD_MARKER), false)
  } finally {
    rmSync(fake.cwd, { recursive: true, force: true })
  }
})

test("doGenerate aggregates its text into a return value, so it is never told", async () => {
  installWatch({ version: "0.36.5", mtimeMs: loaded.mtimeMs!, size: loaded.size! })
  const fake = createFakeCli([init, text("hello"), endTurn, successResult])
  try {
    const model = createClaudeCode({
      cliPath: fake.cliPath,
      cwd: fake.cwd,
      bridgeOpencodeMcp: false,
      proxyOpencodeMcpTools: false,
      proxyTools: [],
    }).languageModel(MODEL_ID)
    const result: any = await model.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      headers: { "x-session-affinity": "ses_generate" },
      tools: [
        {
          type: "function",
          name: "read",
          description: "Read a file",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    } as any)
    const body = (result.content ?? [])
      .filter((part: any) => part.type === "text")
      .map((part: any) => part.text)
      .join("")
    assert.equal(body.includes(STALE_BUILD_MARKER), false)
    assert.ok(body.includes("hello"))
  } finally {
    deleteActiveProcess(keyFor(fake.cwd, "ses_generate"))
    rmSync(fake.cwd, { recursive: true, force: true })
  }
})

test("a turn aborted before the prologue got that far never even reads the disk", async () => {
  // An already-aborted signal returns at the MCP/version checkpoint, which is
  // above the stale check, so the check is not reached and nothing is spent.
  let reads = 0
  const watch = createStaleBuildWatch({
    loaded,
    readOnDisk: () => {
      reads++
      return { version: "0.36.5", mtimeMs: loaded.mtimeMs!, size: loaded.size! }
    },
    now: () => Date.now(),
    warn: () => {},
  })
  _setStaleBuildWatch(watch)
  const fake = createFakeCli([init, text("hello"), endTurn, successResult])
  try {
    const stopped = await turn(fake, "ses_aborted", {}, { abortSignal: AbortSignal.abort() })
    assert.equal(bodyOf(stopped).includes(STALE_BUILD_MARKER), false)
    assert.equal(reads, 0)
    assert.equal(watch.claimedSessions().length, 0)
  } finally {
    deleteActiveProcess(keyFor(fake.cwd, "ses_aborted"))
    rmSync(fake.cwd, { recursive: true, force: true })
  }
})

test("a turn stopped after the check but before the first write keeps its note", async () => {
  // The window the design is about: the verdict is decided in the prologue,
  // the session is claimed where the note is written, and the prologue's last
  // abort checkpoint sits between the two. Stopping there must cost the
  // conversation nothing, or the operator loses the note for good (h #g182).
  // `readOnDisk` is the deterministic hook: the turn calls it synchronously
  // inside that very block, with the checkpoint still ahead of it.
  const controller = new AbortController()
  const watch = createStaleBuildWatch({
    loaded,
    readOnDisk: () => {
      controller.abort()
      return { version: "0.36.5", mtimeMs: loaded.mtimeMs!, size: loaded.size! }
    },
    now: () => Date.now(),
    warn: () => {},
  })
  _setStaleBuildWatch(watch)
  const fake = createFakeCli([init, text("hello"), endTurn, successResult])
  try {
    const stopped = await turn(
      fake,
      "ses_window",
      {},
      { abortSignal: controller.signal },
    )
    assert.equal(bodyOf(stopped).includes(STALE_BUILD_MARKER), false)
    assert.equal(
      watch.claimedSessions().includes("ses_window"),
      false,
      "a turn that never wrote the note must not have spent it",
    )

    // The next message in that same conversation is still told, which is the
    // whole point of claiming late.
    installWatch({ version: "0.36.5", mtimeMs: loaded.mtimeMs!, size: loaded.size! })
    const served = await turn(fake, "ses_window")
    assert.ok(bodyOf(served).includes(STALE_BUILD_MARKER))
  } finally {
    deleteActiveProcess(keyFor(fake.cwd, "ses_window"))
    rmSync(fake.cwd, { recursive: true, force: true })
  }
})

test("the process watch records the build at import, not at first use, and can be replaced", () => {
  _setStaleBuildWatch(undefined)
  const real = staleBuildWatch()
  assert.equal(staleBuildWatch(), real, "one watch per process")
  // Imports are evaluated before this file's body, and every test above has
  // run since, so a baseline taken on first use would be later than this.
  assert.ok(
    real.loaded.loadedAt <= importedBy,
    `baseline taken at ${real.loaded.loadedAt}, after the import at ${importedBy}`,
  )
  // It describes this very checkout, so the only safe claim is that it answers
  // without throwing and names a version.
  assert.ok(real.describe().loaded.version.length > 0)
  _setStaleBuildWatch(undefined)
})
