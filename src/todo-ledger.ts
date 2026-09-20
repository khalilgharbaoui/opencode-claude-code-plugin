import { log } from "./logger.js"

export type TodoStatus = "pending" | "in_progress" | "completed"

export interface TodoEntry {
  id: string
  content: string
  status: TodoStatus
}

interface PendingCreate {
  subject: string
  createdAt: number
}

interface SessionLedger {
  todos: Map<string, TodoEntry>
  pendingCreates: Map<string, PendingCreate>
}

const ledgers = new Map<string, SessionLedger>()

const PENDING_CREATE_TTL_MS = 60_000
/**
 * A ledger is normally released with its Claude session id, but a session
 * that is never deleted (a long-lived `opencode serve` hopping projects, a
 * CLI session whose id the plugin never sees again) leaves one behind. Same
 * insertion-order cap as the compression store; a todo list belonging to a
 * session that old is not going to be written to opencode again.
 */
export const MAX_LEDGER_SESSIONS = 64
const TASK_CREATED_PATTERN = /Task\s*#?\s*(\d+)\s+created/i
const VALID_STATUSES: ReadonlySet<TodoStatus> = new Set(["pending", "in_progress", "completed"])

function getOrCreate(sessionId: string): SessionLedger {
  let ledger = ledgers.get(sessionId)
  if (!ledger) {
    ledger = { todos: new Map(), pendingCreates: new Map() }
    ledgers.set(sessionId, ledger)
    capLedgers()
  }
  return ledger
}

function capLedgers(): void {
  while (ledgers.size > MAX_LEDGER_SESSIONS) {
    const oldest = ledgers.keys().next()
    if (oldest.done) break
    ledgers.delete(oldest.value)
    log.info("todo ledger evicted oldest session", { sessionId: oldest.value })
  }
}

function prunePending(ledger: SessionLedger): void {
  const cutoff = Date.now() - PENDING_CREATE_TTL_MS
  for (const [id, pending] of ledger.pendingCreates) {
    if (pending.createdAt < cutoff) ledger.pendingCreates.delete(id)
  }
}

function materialize(ledger: SessionLedger): TodoEntry[] {
  return Array.from(ledger.todos.values())
}

function resolveSubject(input: { subject?: unknown; description?: unknown } | undefined): string {
  const subject = typeof input?.subject === "string" ? input.subject.trim() : ""
  if (subject) return subject
  const description = typeof input?.description === "string" ? input.description.trim() : ""
  if (description) return description
  return "(no subject)"
}

export function applyTaskCreateToolUse(
  sessionId: string,
  toolUseId: string,
  input: { subject?: unknown; description?: unknown } | undefined,
): void {
  if (!sessionId || !toolUseId) return
  const ledger = getOrCreate(sessionId)
  prunePending(ledger)
  ledger.pendingCreates.set(toolUseId, {
    subject: resolveSubject(input),
    createdAt: Date.now(),
  })
}

export function applyTaskCreateToolResult(
  sessionId: string,
  toolUseId: string,
  resultText: string,
): TodoEntry[] | null {
  if (!sessionId || !toolUseId) return null
  const ledger = ledgers.get(sessionId)
  if (!ledger) return null
  const pending = ledger.pendingCreates.get(toolUseId)
  if (!pending) return null
  ledger.pendingCreates.delete(toolUseId)
  const match = typeof resultText === "string" ? resultText.match(TASK_CREATED_PATTERN) : null
  if (!match) {
    log.debug("TaskCreate result did not match expected format", { sessionId, toolUseId, resultText })
    return null
  }
  const claudeId = match[1]
  if (ledger.todos.has(claudeId)) {
    log.debug("TaskCreate result for already-known claude id; overwriting", { sessionId, claudeId })
  }
  ledger.todos.set(claudeId, { id: claudeId, content: pending.subject, status: "pending" })
  return materialize(ledger)
}

export function applyTaskUpdate(
  sessionId: string,
  input: { taskId?: unknown; subject?: unknown; status?: unknown } | undefined,
): TodoEntry[] | null {
  if (!sessionId) return null
  const taskId = typeof input?.taskId === "string" ? input.taskId : null
  if (!taskId) return null
  const ledger = ledgers.get(sessionId)
  if (!ledger) return null
  const entry = ledger.todos.get(taskId)
  if (!entry) {
    log.debug("TaskUpdate for unknown task id", { sessionId, taskId })
    return null
  }
  if (input?.status === "deleted") {
    ledger.todos.delete(taskId)
    return materialize(ledger)
  }
  if (typeof input?.status === "string" && VALID_STATUSES.has(input.status as TodoStatus)) {
    entry.status = input.status as TodoStatus
  }
  if (typeof input?.subject === "string" && input.subject.trim().length > 0) {
    entry.content = input.subject.trim()
  }
  return materialize(ledger)
}

export function clearLedger(sessionId: string): void {
  if (!sessionId) return
  ledgers.delete(sessionId)
}

export function getLedger(sessionId: string): TodoEntry[] {
  const ledger = ledgers.get(sessionId)
  if (!ledger) return []
  return materialize(ledger)
}

export function _resetAllLedgersForTests(): void {
  ledgers.clear()
}
