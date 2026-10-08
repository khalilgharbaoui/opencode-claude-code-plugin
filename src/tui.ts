/**
 * The TUI half of the package: a `Subagents` section at the bottom of
 * opencode's session sidebar listing the current session's subagents, running
 * first, each with a spinner (or ✓ / ✗), its agent type, its task description,
 * a `bg` marker for background ones, and a muted line saying what it really
 * runs as (`sonnet-5.5 · high · alpha`). Clicking a row opens that subagent's
 * session; opencode's own `up` key goes back to the parent.
 *
 * Always on: there is no option. One module serves both majors (h #g234):
 *
 *   - opencode 1.x loads TUI plugins from `tui.json`'s `plugin` list, never
 *     from `opencode.json`'s, resolves a package to `exports["./tui"]`, and
 *     wants a default export `{ id, tui }` with no `server`.
 *   - opencode 2.x resolves the SAME `plugins` entry it already has
 *     (`<repo>/dist`) to `<dir>/tui`, and wants `{ id, setup }`. 1.x ignores a
 *     `setup` key and 2.x a `tui` key, so the default export carries both.
 *
 * Everything that decides WHAT to show lives in `src/subagent-sidebar.ts`
 * (pure, tested). Each major gets a thin adapter that gathers that module's
 * inputs from its own TUI state and supplies its own theme colours; the
 * section itself is drawn by one renderer. Nothing in here may throw into the
 * host or log: on the TUI's own thread stderr is the screen (h #g193), so every
 * failure degrades to drawing less.
 */
import { RGBA } from "@opentui/core"
import { createElement, createTextNode, effect, insert, insertNode, setProp } from "@opentui/solid"
import { createMemo, createSignal, onCleanup } from "solid-js"
import {
  SIDEBAR_ROW_WIDTH,
  SPINNER_FRAMES,
  collapsedSummary,
  completionsIn,
  deriveSubagentRows,
  layoutRow,
  partChildID,
  type ChildRunState,
  type ChildSessionInput,
  type CompletionInput,
  type Segment,
  type SidebarInput,
  type SubagentRow,
  type TaskPartInput,
} from "./subagent-sidebar.js"
import { createSpawnRecordReader, type SpawnRecord } from "./spawn-record-store.js"

export const SUBAGENTS_TUI_PLUGIN_ID = "opencode-claude-code-plugin.subagents"

/** After opencode 1.x's own sidebar sections (files is 500). */
const SECTION_ORDER = 900
const SPINNER_INTERVAL_MS = 100
/** How often the spawn records and the finished rows' fade are rechecked. */
const REFRESH_INTERVAL_MS = 1500

/** The tool names a subagent dispatch has: `task` on 1.x, `subagent` on 2.x. */
const TASK_TOOLS = new Set(["task", "subagent"])

type Color = RGBA

/** The colours the section paints with, whatever theme shape the host has. */
export interface SidebarColors {
  text: Color
  muted: Color
  spinner: Color
  done: Color
  error: Color
  /** The effort on a row's second line: the theme's warning colour. */
  effort: Color
  effortFaded: Color
  hover: Color
}

/** What one major has to supply; the renderer below does everything else. */
interface SidebarHost {
  colors(): SidebarColors
  /** The inputs for one parent session, minus the clock and the records. */
  gather(parentID: string): Pick<SidebarInput, "children" | "parts" | "completions" | "status" | "stoppedAt">
  navigate(sessionID: string): void
}

function attempt<T>(fn: () => T, fallback: T): T {
  try {
    return fn()
  } catch {
    return fallback
  }
}

/**
 * `a` moved `weight` of the way to `b`, so a finished glyph reads as muted.
 * Works in whatever scale the host's RGBA uses, because it only ever hands
 * the class back values it read from the same class.
 */
function mix(a: Color, b: Color, weight: number): Color {
  return attempt(
    () =>
      RGBA.fromValues(
        a.r + (b.r - a.r) * weight,
        a.g + (b.g - a.g) * weight,
        a.b + (b.b - a.b) * weight,
        a.a,
      ),
    a,
  )
}

function roleColor(colors: SidebarColors, role: Segment["role"]): Color {
  switch (role) {
    case "spinner":
      return colors.spinner
    case "done":
      return colors.done
    case "error":
      return colors.error
    case "effort":
      return colors.effort
    case "effort-faded":
      return colors.effortFaded
    case "agent":
    case "description":
      return colors.text
    default:
      return colors.muted
  }
}

/**
 * The section, its clocks and the spawn-record reader, for one host. Returns
 * the slot renderer and a disposer.
 */
function createSidebar(host: SidebarHost) {
  const [frame, setFrame] = createSignal(0)
  const [now, setNow] = createSignal(Date.now())
  const records = createSpawnRecordReader()
  let recordMap: Map<string, SpawnRecord> = attempt(() => records.read(), new Map())
  const [recordVersion, setRecordVersion] = createSignal(0)

  // One spinner clock and one refresh clock for every mounted section, each
  // running only while something needs it: nothing ticks while no subagent is
  // listed, and the spinner stops the moment the last one finishes.
  const sectionsRunning = new Set<symbol>()
  const sectionsShowing = new Set<symbol>()
  let spinner: ReturnType<typeof setInterval> | undefined
  let refresh: ReturnType<typeof setInterval> | undefined
  const syncClocks = () => {
    if (sectionsRunning.size > 0 && !spinner) {
      spinner = setInterval(() => setFrame((value) => (value + 1) % SPINNER_FRAMES.length), SPINNER_INTERVAL_MS)
    } else if (sectionsRunning.size === 0 && spinner) {
      clearInterval(spinner)
      spinner = undefined
    }
    if (sectionsShowing.size > 0 && !refresh) {
      refresh = setInterval(() => {
        const next = attempt(() => records.read(), recordMap)
        if (next !== recordMap) {
          recordMap = next
          setRecordVersion((value) => value + 1)
        }
        setNow(Date.now())
      }, REFRESH_INTERVAL_MS)
    } else if (sectionsShowing.size === 0 && refresh) {
      clearInterval(refresh)
      refresh = undefined
    }
  }

  const deriveRows = (parentID: string): SubagentRow[] => {
    recordVersion()
    return deriveSubagentRows({
      ...host.gather(parentID),
      record: (id) => recordMap.get(id),
      now: now(),
    })
  }

  const buildRow = (row: SubagentRow): OpentuiNode => {
    const box = createElement("box")
    const layout = layoutRow(row, SIDEBAR_ROW_WIDTH)
    const first = createElement("text")
    setProp(first, "wrapMode", "none")
    layout.first.forEach((segment, index) => {
      const span = createElement("span")
      if (index === 0 && row.state === "running") {
        insert(span, () => SPINNER_FRAMES[frame() % SPINNER_FRAMES.length])
      } else {
        insertNode(span, createTextNode(segment.text))
      }
      effect(() => setProp(span, "style", { fg: roleColor(host.colors(), segment.role) }))
      insertNode(first, span)
    })
    insertNode(box, first)
    if (layout.second.length > 0) {
      // One line of spans, like the first, so the effort can take its own colour.
      const second = createElement("text")
      setProp(second, "wrapMode", "none")
      for (const segment of layout.second) {
        const span = createElement("span")
        insertNode(span, createTextNode(segment.text))
        effect(() => setProp(span, "style", { fg: roleColor(host.colors(), segment.role) }))
        insertNode(second, span)
      }
      insertNode(box, second)
    }
    if (row.sessionID) {
      const sessionID = row.sessionID
      setProp(box, "onMouseDown", () => attempt(() => host.navigate(sessionID), undefined))
      setProp(box, "onMouseOver", () =>
        attempt(() => setProp(box, "backgroundColor", host.colors().hover), undefined),
      )
      setProp(box, "onMouseOut", () =>
        attempt(() => setProp(box, "backgroundColor", "transparent"), undefined),
      )
    }
    return box
  }

  const buildSection = (
    list: SubagentRow[],
    expanded: () => boolean,
    setExpanded: (next: (value: boolean) => boolean) => boolean,
  ): OpentuiNode => {
    const section = createElement("box")
    // Heading, styled like opencode 1.x's own MCP and Todo sections: a bold
    // title, and with more than two rows a caret that folds the list away
    // behind a one-line summary.
    const header = createElement("box")
    setProp(header, "flexDirection", "row")
    setProp(header, "gap", 1)
    setProp(header, "onMouseDown", () => list.length > 2 && setExpanded((value) => !value))
    if (list.length > 2) {
      const caret = createElement("text")
      insert(caret, () => (expanded() ? "▼" : "▶"))
      effect(() => setProp(caret, "fg", host.colors().text))
      insertNode(header, caret)
    }
    const title = createElement("text")
    const bold = createElement("b")
    insertNode(bold, createTextNode("Subagents"))
    insertNode(title, bold)
    const summary = createElement("span")
    insert(summary, () => (expanded() ? "" : ` (${collapsedSummary(list)})`))
    effect(() => setProp(summary, "style", { fg: host.colors().muted }))
    insertNode(title, summary)
    effect(() => setProp(title, "fg", host.colors().text))
    insertNode(header, title)
    insertNode(section, header)

    const body = createElement("box")
    insert(body, () => (expanded() || list.length <= 2 ? list.map(buildRow) : null))
    insertNode(section, body)
    return section
  }

  const render = (sessionID: () => string | undefined): OpentuiNode => {
    const root = createElement("box")
    const key = Symbol("subagents-section")
    const [expanded, setExpanded] = createSignal(true)
    const rows = createMemo(() => {
      const parentID = sessionID()
      if (!parentID) return [] as SubagentRow[]
      return attempt(() => deriveRows(parentID), [] as SubagentRow[])
    })
    effect(() => {
      const list = rows()
      if (list.some((row) => row.state === "running")) sectionsRunning.add(key)
      else sectionsRunning.delete(key)
      if (list.length > 0) sectionsShowing.add(key)
      else sectionsShowing.delete(key)
      syncClocks()
    })
    onCleanup(() => {
      sectionsRunning.delete(key)
      sectionsShowing.delete(key)
      syncClocks()
    })
    insert(root, () => {
      const list = rows()
      if (list.length === 0) return null
      return attempt(() => buildSection(list, expanded, setExpanded), null)
    })
    return root
  }

  const dispose = () => {
    sectionsRunning.clear()
    sectionsShowing.clear()
    syncClocks()
  }
  return { render, dispose }
}

// ---------------------------------------------------------------------------
// opencode 1.x
// ---------------------------------------------------------------------------

// The structural slice of opencode 1.x's `TuiPluginApi` this module reads.
// Hand-written, like `src/opencode-types.ts`, so nothing is imported from
// `@opencode-ai/plugin`.
interface V1SessionInfo {
  id: string
  parentID?: string
  title?: string
  agent?: string
  time?: { created?: number; updated?: number }
}
interface V1Part {
  type: string
  tool?: string
  synthetic?: boolean
  text?: string
  state?: {
    status?: string
    input?: Record<string, unknown>
    metadata?: Record<string, unknown>
    title?: string
    time?: { start?: number; end?: number }
  }
}
interface V1Api {
  state: {
    session: {
      get(sessionID: string): V1SessionInfo | undefined
      messages(sessionID: string): ReadonlyArray<{ id: string; role: string; time?: { created?: number } }> | undefined
      status(sessionID: string): { type?: string } | undefined
    }
    part(messageID: string): ReadonlyArray<V1Part> | undefined
  }
  theme: {
    current: {
      text: Color
      textMuted: Color
      accent: Color
      success: Color
      warning: Color
      error: Color
      backgroundElement: Color
    }
  }
  route: { navigate(name: string, params?: Record<string, unknown>): void }
  event: { on(type: string, handler: (event: { properties?: any }) => void): () => void }
  client?: { session?: { children?: (input: { sessionID: string }) => Promise<{ data?: V1SessionInfo[] }> } }
  slots: { register(plugin: { order?: number; slots: Record<string, (ctx: unknown, props: any) => OpentuiNode> }): string }
  lifecycle?: { onDispose(fn: () => void): () => void }
}

export function registerV1(api: V1Api): void {
  // Child sessions seen per parent. 1.x has no session list in its TUI state,
  // so they come from its events, from a one-off `children` fetch the first
  // time a parent is shown (a TUI started after the dispatch still lists
  // them), and from finished parts' metadata.
  const childrenByParent = new Map<string, Map<string, ChildSessionInput>>()
  const fetched = new Set<string>()
  const stoppedAt = new Map<string, number>()
  const lastStatus = new Map<string, string>()
  const [version, setVersion] = createSignal(0)
  const bump = () => setVersion((value) => value + 1)

  const remember = (info: V1SessionInfo | undefined) => {
    if (!info?.id || !info.parentID) return false
    let children = childrenByParent.get(info.parentID)
    if (!children) {
      children = new Map()
      childrenByParent.set(info.parentID, children)
    }
    children.set(info.id, {
      id: info.id,
      title: info.title,
      agent: info.agent,
      created: info.time?.created,
      updated: info.time?.updated,
    })
    return true
  }

  const unsubscribe: Array<() => void> = []
  const listen = (type: string, handler: (properties: any) => void) => {
    const off = attempt(
      () => api.event.on(type, (event) => attempt(() => handler(event?.properties ?? {}), undefined)),
      undefined,
    )
    if (off) unsubscribe.push(off)
  }
  listen("session.created", (properties) => remember(properties.info) && bump())
  listen("session.updated", (properties) => remember(properties.info) && bump())
  listen("session.deleted", (properties) => {
    const info = properties.info as V1SessionInfo | undefined
    if (info?.parentID && childrenByParent.get(info.parentID)?.delete(info.id)) bump()
  })
  listen("session.status", (properties) => {
    const id = properties.sessionID as string | undefined
    const type = properties.status?.type as string | undefined
    if (!id || !type) return
    const previous = lastStatus.get(id)
    lastStatus.set(id, type)
    if (type === "idle" && previous && previous !== "idle") stoppedAt.set(id, Date.now())
    if (type !== "idle") stoppedAt.delete(id)
  })

  const fetchChildren = (parentID: string) => {
    if (fetched.has(parentID)) return
    fetched.add(parentID)
    const session = api.client?.session
    if (!session?.children) return
    void Promise.resolve()
      .then(() => session.children!.call(session, { sessionID: parentID }))
      .then((response) => {
        let changed = false
        for (const info of response?.data ?? []) changed = remember(info) || changed
        if (changed) bump()
      })
      .catch(() => undefined)
  }

  const host: SidebarHost = {
    colors() {
      const theme = api.theme.current
      return {
        text: theme.text,
        muted: theme.textMuted,
        spinner: theme.accent,
        done: mix(theme.success, theme.textMuted, 0.45),
        error: mix(theme.error, theme.textMuted, 0.35),
        effort: theme.warning ?? theme.textMuted,
        effortFaded: mix(theme.warning ?? theme.textMuted, theme.textMuted, 0.45),
        hover: theme.backgroundElement,
      }
    },
    gather(parentID) {
      version()
      fetchChildren(parentID)
      const parts: TaskPartInput[] = []
      const completions: CompletionInput[] = []
      for (const message of api.state.session.messages(parentID) ?? []) {
        const messageParts = api.state.part(message.id) ?? []
        if (message.role === "assistant") {
          for (const part of messageParts) {
            if (part.type !== "tool" || !TASK_TOOLS.has(part.tool ?? "")) continue
            const state = part.state ?? {}
            parts.push({
              status: state.status,
              input: state.input,
              metadata: state.metadata,
              title: state.title,
              start: state.time?.start,
              end: state.time?.end,
            })
          }
        } else if (message.role === "user") {
          // A background child's end is a synthetic user part in the parent.
          for (const part of messageParts) {
            if (part.type !== "text" || part.synthetic !== true || !part.text) continue
            completions.push(...completionsIn(part.text, message.time?.created))
          }
        }
      }
      const known = new Map(childrenByParent.get(parentID) ?? [])
      for (const part of parts) {
        const id = partChildID(part)
        if (!id || known.has(id)) continue
        const info = attempt(() => api.state.session.get(id), undefined)
        known.set(id, {
          id,
          title: info?.title,
          agent: info?.agent,
          created: info?.time?.created ?? part.start,
          updated: info?.time?.updated,
        })
      }
      return {
        children: [...known.values()],
        parts,
        completions,
        status: (id: string): ChildRunState => {
          const type = attempt(() => api.state.session.status(id)?.type, undefined)
          if (type === "busy" || type === "retry") return "busy"
          if (type === "idle") return "idle"
          return "unknown"
        },
        stoppedAt: (id: string) => stoppedAt.get(id),
      }
    },
    navigate(sessionID) {
      api.route.navigate("session", { sessionID })
    },
  }

  const sidebar = createSidebar(host)
  api.slots.register({
    order: SECTION_ORDER,
    slots: {
      sidebar_content(_ctx: unknown, props: { session_id: string }) {
        return sidebar.render(() => props.session_id)
      },
    },
  })
  api.lifecycle?.onDispose(() => {
    for (const off of unsubscribe) attempt(off, undefined)
    sidebar.dispose()
  })
}

// ---------------------------------------------------------------------------
// opencode 2.x
// ---------------------------------------------------------------------------

// The structural slice of opencode 2.x's TUI `Context` this module reads,
// measured on 2.0.22 (h #g234). Its sessions carry `parentID`, its status is
// `"running" | "idle"`, an assistant message holds its tool calls inline as
// `content[]` items named `subagent` (with `metadata.sessionID` set while the
// call still runs, unlike 1.x), and a background child's end is a message of
// type `synthetic` whose text is `<subagent sessionID="..." state="...">`.
interface V2Session {
  id: string
  parentID?: string
  title?: string
  agent?: string
  time?: { created?: number; updated?: number }
}
interface V2Message {
  type?: string
  text?: string
  time?: { created?: number }
  content?: Array<{
    type?: string
    name?: string
    time?: { created?: number; completed?: number }
    state?: { status?: string; input?: Record<string, unknown>; metadata?: Record<string, unknown> }
  }>
}
type V2Shade = Record<string, Color>
interface V2Context {
  data: {
    session: {
      list(): V2Session[] | undefined
      status(sessionID: string): string
      message: { list(sessionID: string): V2Message[] | undefined }
    }
  }
  theme: {
    text: { base: Color; muted: Color; feedback: { success: V2Shade; warning?: V2Shade; error: V2Shade } }
    background: { raised: { base: Color } }
    hue: { accent: V2Shade }
  }
  themeMode?: "dark" | "light"
  ui: {
    router: { navigate(destination: { type: "session"; sessionID: string }): void }
    slot(claim: { append: string; render: (input: { sessionID: string }) => OpentuiNode }): () => void
  }
}

export function setupV2(context: V2Context): () => void {
  const host: SidebarHost = {
    colors() {
      const theme = context.theme
      const muted = theme.text.muted
      // The accent hue at the shade that reads on this mode's background.
      const accent = theme.hue.accent[context.themeMode === "light" ? "500" : "200"] ?? theme.text.base
      return {
        text: theme.text.base,
        muted,
        spinner: accent,
        done: mix(theme.text.feedback.success.muted ?? theme.text.feedback.success.base, muted, 0.45),
        error: mix(theme.text.feedback.error.muted ?? theme.text.feedback.error.base, muted, 0.35),
        effort: theme.text.feedback.warning?.base ?? muted,
        effortFaded: mix(theme.text.feedback.warning?.base ?? muted, muted, 0.45),
        hover: theme.background.raised.base,
      }
    },
    gather(parentID) {
      const children: ChildSessionInput[] = (context.data.session.list() ?? [])
        .filter((session) => session.parentID === parentID)
        .map((session) => ({
          id: session.id,
          title: session.title,
          agent: session.agent,
          created: session.time?.created,
          updated: session.time?.updated,
        }))
      const parts: TaskPartInput[] = []
      const completions: CompletionInput[] = []
      for (const message of context.data.session.message.list(parentID) ?? []) {
        if (message.type === "assistant") {
          for (const item of message.content ?? []) {
            if (item.type !== "tool" || !TASK_TOOLS.has(item.name ?? "")) continue
            parts.push({
              status: item.state?.status,
              input: item.state?.input,
              metadata: item.state?.metadata,
              start: item.time?.created,
              end: item.time?.completed,
            })
          }
        } else if (message.type === "synthetic" && message.text) {
          completions.push(...completionsIn(message.text, message.time?.created))
        }
      }
      return {
        children,
        parts,
        completions,
        status: (id: string): ChildRunState => {
          const status = attempt(() => context.data.session.status(id), undefined)
          if (status === "running") return "busy"
          if (status === "idle") return "idle"
          return "unknown"
        },
        stoppedAt: () => undefined,
      }
    },
    navigate(sessionID) {
      context.ui.router.navigate({ type: "session", sessionID })
    },
  }

  const sidebar = createSidebar(host)
  const release = attempt(
    () =>
      context.ui.slot({
        append: "sidebar.content",
        render: (input) => sidebar.render(() => input.sessionID),
      }),
    undefined,
  )
  return () => {
    if (release) attempt(release, undefined)
    sidebar.dispose()
  }
}

const tui = async (api: V1Api): Promise<void> => {
  attempt(() => registerV1(api), undefined)
}

const setup = (context: V2Context): (() => void) | void =>
  attempt(() => setupV2(context), undefined)

export default { id: SUBAGENTS_TUI_PLUGIN_ID, tui, setup }
