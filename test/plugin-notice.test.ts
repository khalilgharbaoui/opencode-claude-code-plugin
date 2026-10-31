/**
 * The plugin's warnings on opencode 2's screen (h #g253): the notice shape the
 * server half emits over its RPC channel and the sidebar half reads back
 * (`src/plugin-notice.ts`), the logger's notifier that feeds it through the
 * same toast policy opencode 1's TUI sink uses (`src/logger.ts`), and the V2
 * entry registering the channel (`src/v2.ts`). The live run that established
 * the channel is in V2.md: every emit reached the sidebar half, every toast
 * rendered.
 *
 * Usage: npx tsx --test test/plugin-notice.test.ts
 */
import "./isolate.js"
import assert from "node:assert/strict"
import { test } from "node:test"
import {
  _resetLoggerForTests,
  _setToastBurstForTests,
  configureLogger,
  log,
  setToastNotifier,
  setTuiHostForTests,
  setLogSink,
  type LogSinkEntry,
} from "../src/logger.js"
import {
  MAX_SEEN_NOTICES,
  MAX_TOAST_CHARS,
  NOTICE_EVENT,
  NOTICE_EVENT_TYPE,
  NOTICE_RPC_DEFINITION,
  NOTICE_RPC_ID,
  createNoticeToaster,
  pluginNotice,
  readPluginNotice,
  type PluginNotice,
} from "../src/plugin-notice.js"
import { createV2Setup } from "../src/v2.js"

/** stderr is still written on this path; keep the test output clean. */
function quietStderr(): () => void {
  const original = console.error
  console.error = () => undefined
  return () => {
    console.error = original
  }
}

function freshLogger(): () => void {
  _resetLoggerForTests()
  configureLogger({ mode: "silent", level: "info", file: false })
  const restore = quietStderr()
  return () => {
    restore()
    _resetLoggerForTests()
  }
}

test("the definition is plain JSON Schema, and its events travel as rpc.<id>.<event>", () => {
  assert.equal(NOTICE_RPC_DEFINITION.id, NOTICE_RPC_ID)
  assert.deepEqual(NOTICE_RPC_DEFINITION.methods, {})
  const schema = NOTICE_RPC_DEFINITION.events[NOTICE_EVENT].schema
  assert.equal(schema.type, "object")
  assert.deepEqual([...schema.required].sort(), ["id", "level", "message"])
  assert.equal(NOTICE_EVENT_TYPE, `rpc.${NOTICE_RPC_ID}.${NOTICE_EVENT}`)
  assert.doesNotMatch(NOTICE_RPC_ID, /[@/]/, "an id with a scope would not read back as one dotted type")
})

test("a notice carries a message only, flattened and capped like a toast", () => {
  const long = `first line\n\n${"x".repeat(400)}`
  const notice = pluginNotice("abc-1", "warn", long)
  assert.deepEqual(Object.keys(notice).sort(), ["id", "level", "message"])
  assert.equal(notice.message.length, MAX_TOAST_CHARS)
  assert.ok(notice.message.startsWith("first line x"))
  assert.ok(notice.message.endsWith("…"))
})

test("readPluginNotice accepts exactly one well-formed notice of this plugin's type", () => {
  const data = { id: "abc-1", level: "error", message: "it broke" }
  assert.deepEqual(readPluginNotice(NOTICE_EVENT_TYPE, data), data)
  assert.equal(readPluginNotice("rpc.someone-else.notice", data), undefined)
  assert.equal(readPluginNotice(NOTICE_EVENT_TYPE, { ...data, level: "info" }), undefined)
  // `success` answers `/connect` (h #g277); it is the one level that is not a log level.
  assert.deepEqual(readPluginNotice(NOTICE_EVENT_TYPE, { ...data, level: "success" }), { ...data, level: "success" })
  assert.deepEqual(
    [...NOTICE_RPC_DEFINITION.events[NOTICE_EVENT].schema.properties.level.enum].sort(),
    ["error", "success", "warn"],
  )
  assert.equal(readPluginNotice(NOTICE_EVENT_TYPE, { ...data, id: "" }), undefined)
  assert.equal(readPluginNotice(NOTICE_EVENT_TYPE, { ...data, message: "   " }), undefined)
  assert.equal(readPluginNotice(NOTICE_EVENT_TYPE, null), undefined)
  assert.equal(readPluginNotice(NOTICE_EVENT_TYPE, "it broke"), undefined)
})

test("the sidebar toasts each notice once, however many locations emitted it", () => {
  const shown: PluginNotice[] = []
  const toast = createNoticeToaster((notice) => shown.push(notice))
  const data = { id: "abc-1", level: "warn", message: "careful" }
  assert.equal(toast(NOTICE_EVENT_TYPE, data), true)
  assert.equal(toast(NOTICE_EVENT_TYPE, data), false, "the copy another location emitted")
  assert.equal(toast("session.execution.started", { sessionID: "ses_1" }), false)
  assert.equal(toast(NOTICE_EVENT_TYPE, { ...data, id: "abc-2" }), true)
  assert.deepEqual(shown.map((notice) => notice.id), ["abc-1", "abc-2"])
})

test("the sidebar's memory of ids is bounded, and a throwing toast never escapes", () => {
  let shown = 0
  const toast = createNoticeToaster(() => {
    shown += 1
    if (shown === 2) throw new Error("renderer gone")
  })
  for (let n = 0; n <= MAX_SEEN_NOTICES; n += 1) toast(NOTICE_EVENT_TYPE, { id: `id-${n}`, level: "warn", message: "m" })
  assert.equal(shown, MAX_SEEN_NOTICES + 1)
  assert.equal(toast(NOTICE_EVENT_TYPE, { id: "id-0", level: "warn", message: "m" }), true, "the oldest id was forgotten")
})

test("the notifier gets warn and error once per text, never lower levels, and stderr still gets the line", () => {
  const done = freshLogger()
  const lines: string[] = []
  console.error = (line: string) => lines.push(line)
  const notified: LogSinkEntry[] = []
  try {
    setToastNotifier((entry) => notified.push(entry))
    log.info("informational")
    log.notice("ready")
    log.warn("careful", { secret: "never in a toast" })
    log.warn("careful")
    log.error("it broke")
    assert.deepEqual(
      notified.map((entry) => [entry.level, entry.message]),
      [
        ["warn", "careful"],
        ["error", "it broke"],
      ],
    )
    assert.equal(lines.filter((line) => line.includes("WARN: careful")).length, 2, "stderr is unchanged")
  } finally {
    done()
  }
})

test("warnings raised before the notifier exists reach it in order once it registers", () => {
  const done = freshLogger()
  const notified: string[] = []
  try {
    log.warn("before one")
    log.error("before two")
    setToastNotifier((entry) => notified.push(entry.message))
    log.warn("after")
    assert.deepEqual(notified, ["before one", "before two", "after"])
  } finally {
    done()
  }
})

test("the notifier shares the burst guard: a burst of different warnings ends in one summary", async () => {
  const done = freshLogger()
  const notified: string[] = []
  try {
    _setToastBurstForTests(2, 40)
    setToastNotifier((entry) => notified.push(entry.message))
    for (let n = 1; n <= 5; n += 1) log.warn(`server ${n} needs auth`)
    assert.deepEqual(notified, ["server 1 needs auth", "server 2 needs auth"])
    await new Promise((resolve) => setTimeout(resolve, 80))
    assert.equal(notified.length, 3)
    assert.match(notified[2]!, /^3 more claude-code warning\(s\) were not shown; the full text is in the plugin log file$/)
  } finally {
    done()
  }
})

test("inside an opencode 1 TUI the sink toasts and the notifier is never asked", () => {
  const done = freshLogger()
  const notified: string[] = []
  const toasted: string[] = []
  try {
    setTuiHostForTests(true)
    setLogSink({ log: () => undefined, toast: (entry) => toasted.push(entry.message) })
    setToastNotifier((entry) => notified.push(entry.message))
    log.warn("tui warning")
    assert.deepEqual(toasted, ["tui warning"])
    assert.deepEqual(notified, [])
  } finally {
    done()
  }
})

test("a notifier that throws never reaches the code that logged, and null unregisters it", () => {
  const done = freshLogger()
  let calls = 0
  try {
    setToastNotifier(() => {
      calls += 1
      throw new Error("bus gone")
    })
    assert.doesNotThrow(() => log.warn("first"))
    setToastNotifier(null)
    log.warn("second")
    assert.equal(calls, 1)
  } finally {
    done()
  }
})

type Emit = { name: string; data: Record<string, unknown> }

function v2Context(rpc?: unknown) {
  const registration = () => ({ dispose: async () => undefined })
  return {
    app: { version: "2.0.31" },
    location: { directory: process.cwd() },
    options: {},
    provider: { transform: async () => registration() },
    aisdk: { hook: async () => registration() },
    session: { hook: async () => registration() },
    ...(rpc === undefined ? {} : { rpc }),
  } as any
}

const setupWith = () =>
  createV2Setup({
    createProvider: () => ({ languageModel: () => ({}) as any }),
    defaultProxyTools: ["Bash"],
    loadConfig: () => ({}),
  })

test("setup registers the notice channel and every warning after it is emitted on it, once", async () => {
  const done = freshLogger()
  const emitted: Emit[] = []
  const definitions: unknown[] = []
  let disposed = 0
  try {
    const rpc = {
      register: async (definition: unknown, handlers: unknown) => {
        definitions.push(definition)
        assert.deepEqual(handlers, {})
        return {
          dispose: async () => {
            disposed += 1
          },
          events: {
            emit: async (name: string, data: Record<string, unknown>) => {
              emitted.push({ name, data })
            },
          },
        }
      },
    }
    const cleanup = await setupWith()(v2Context(rpc))
    assert.deepEqual(definitions, [NOTICE_RPC_DEFINITION])
    log.warn("this server needs auth")
    log.warn("this server needs auth")
    log.info("nothing to see")
    assert.equal(emitted.length, 1)
    assert.equal(emitted[0]!.name, NOTICE_EVENT)
    const notice = readPluginNotice(NOTICE_EVENT_TYPE, emitted[0]!.data)
    assert.ok(notice, "what is emitted is exactly what the sidebar half reads back")
    assert.equal(notice!.message, "this server needs auth")
    assert.equal(notice!.level, "warn")
    await (cleanup as () => Promise<void>)()
    assert.equal(disposed, 1)
    log.warn("after cleanup")
    assert.equal(emitted.length, 1, "nothing is emitted on a disposed registration")
  } finally {
    done()
  }
})

test("two locations' registrations each carry the notice, under one id", async () => {
  const done = freshLogger()
  const emitted: Emit[] = []
  try {
    const rpc = {
      register: async () => ({
        dispose: async () => undefined,
        events: { emit: async (name: string, data: Record<string, unknown>) => void emitted.push({ name, data }) },
      }),
    }
    const setup = setupWith()
    const first = await setup(v2Context(rpc))
    const second = await setup(v2Context(rpc))
    log.error("one problem")
    assert.equal(emitted.length, 2)
    assert.equal(emitted[0]!.data.id, emitted[1]!.data.id, "the sidebar drops the copy by this id")
    await (first as () => Promise<void>)()
    await (second as () => Promise<void>)()
  } finally {
    done()
  }
})

test("a host without rpc, one that refuses the definition, or a rejecting emit leaves setup unharmed", async () => {
  const done = freshLogger()
  try {
    await assert.doesNotReject(setupWith()(v2Context()))
    await assert.doesNotReject(
      setupWith()(
        v2Context({
          register: async () => {
            throw new Error("rpc.invalid_input")
          },
        }),
      ),
    )
    const cleanup = await setupWith()(
      v2Context({
        register: async () => ({
          dispose: async () => undefined,
          events: {
            emit: async () => {
              throw new Error("bus closed")
            },
          },
        }),
      }),
    )
    assert.doesNotThrow(() => log.warn("emitted into a closed bus"))
    await new Promise((resolve) => setTimeout(resolve, 10))
    await (cleanup as () => Promise<void>)()
  } finally {
    done()
  }
})
