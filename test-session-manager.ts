import assert from "node:assert/strict"
import { setTimeout as delay } from "node:timers/promises"
import { EventEmitter } from "node:events"
import { test } from "node:test"
import {
  deleteActiveProcess,
  deleteClaudeSessionId,
  buildCliArgs,
  getActiveProcess,
  scheduleIdleProcessEviction,
  setClaudeSessionId,
  setActiveProcess,
  type ActiveProcess,
} from "./src/session-manager.js"

function fakeProcess(onKill: () => void): ActiveProcess {
  return {
    proc: {
      kill() {
        onKill()
        return true
      },
    } as ActiveProcess["proc"],
    lineEmitter: new EventEmitter(),
  }
}

test("idle process is evicted after the configured timeout", async () => {
  const key = `idle-eviction-${Date.now()}`
  const sessionId = "f8dccdd4-4785-4bd9-8520-7a5993a71f78"
  let kills = 0
  setActiveProcess(key, fakeProcess(() => kills++))
  setClaudeSessionId(key, sessionId)

  scheduleIdleProcessEviction(key, 10)
  await delay(30)

  assert.equal(kills, 1)
  assert.equal(getActiveProcess(key), undefined)
  assert.deepEqual(
    buildCliArgs({ sessionKey: key, skipPermissions: false }).slice(-2),
    ["--resume", sessionId],
  )
  deleteClaudeSessionId(key)
})

test("reusing a process cancels its idle eviction", async () => {
  const key = `idle-reuse-${Date.now()}`
  let kills = 0
  const process = fakeProcess(() => kills++)
  setActiveProcess(key, process)

  scheduleIdleProcessEviction(key, 10)
  assert.equal(getActiveProcess(key), process)
  await delay(30)

  assert.equal(kills, 0)
  assert.equal(getActiveProcess(key), process)
  deleteActiveProcess(key)
})

test("timeouts above Node's maximum delay do not evict immediately", async () => {
  const key = `idle-overflow-${Date.now()}`
  let kills = 0
  const process = fakeProcess(() => kills++)
  setActiveProcess(key, process)

  scheduleIdleProcessEviction(key, 2_147_483_648)
  await delay(10)

  assert.equal(kills, 0)
  assert.equal(getActiveProcess(key), process)
  deleteActiveProcess(key)
})
