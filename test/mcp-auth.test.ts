/**
 * Unit tests for src/mcp-auth.ts, the one module that reads a credential out
 * of opencode's own store.
 *
 * Every token here is fabricated and nothing in this file touches a real
 * opencode state directory.
 *
 * Usage:
 *   npx tsx --test test/mcp-auth.test.ts
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"

import {
  buildFreshnessKey,
  injectBearerHeaders,
  opencodeStateDir,
  readMcpAuthStore,
  selectBearerToken,
  type McpAuthStore,
} from "../src/mcp-auth.js"

const URL_A = "https://a.example.test/mcp"
const URL_B = "https://b.example.test/mcp"
/** 2099, in unix seconds, as `Date.now()` sees it. */
const LIVE = new Date("2099-01-01T00:00:00Z").getTime() / 1000
const DEAD = new Date("2000-01-01T00:00:00Z").getTime() / 1000

function store(entries: McpAuthStore): McpAuthStore {
  return entries
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mcp-auth-test-"))
}

test("a live token is returned only for its own server name and URL", () => {
  const entries = store({
    alpha: { tokens: { accessToken: "tok-alpha", expiresAt: LIVE }, serverUrl: URL_A },
  })
  assert.deepEqual(selectBearerToken(entries, "alpha", URL_A), {
    token: "tok-alpha",
    expiresAt: LIVE,
  })
  // The same URL under another name is NOT the same credential. opencode keys
  // the store by server name, so the name is the identity; two servers on one
  // host are the case where a URL-only match does real damage.
  assert.deepEqual(selectBearerToken(entries, "beta", URL_A), {
    token: null,
    refusal: "no-entry",
  })
  // The right name pointed somewhere else is a stale entry, not a credential.
  assert.deepEqual(selectBearerToken(entries, "alpha", URL_B), {
    token: null,
    refusal: "url-mismatch",
  })
})

test("every reason a token is unusable is named, and none of them throws", () => {
  assert.deepEqual(selectBearerToken(store({}), "alpha", URL_A), {
    token: null,
    refusal: "no-entry",
  })
  assert.deepEqual(
    selectBearerToken(store({ alpha: { serverUrl: URL_A } }), "alpha", URL_A),
    { token: null, refusal: "no-token" },
  )
  // The shape of an OAuth handshake opencode started and never finished:
  // serverUrl and clientInfo, no tokens. One of the three entries in the real
  // store on the measurement machine (1.18.35, 2026-10-08) looks like this.
  assert.deepEqual(
    selectBearerToken(
      store({ alpha: { serverUrl: URL_A, clientInfo: { clientId: "abc" } } }),
      "alpha",
      URL_A,
    ),
    { token: null, refusal: "no-token" },
  )
  assert.deepEqual(
    selectBearerToken(store({ alpha: { tokens: { accessToken: "x" } } }), "alpha", URL_A),
    { token: null, refusal: "url-mismatch" },
  )
  assert.deepEqual(
    selectBearerToken(
      store({ alpha: { tokens: { accessToken: "tok", expiresAt: DEAD }, serverUrl: URL_A } }),
      "alpha",
      URL_A,
    ),
    { token: null, refusal: "expired" },
  )
  // An inherited property is not an entry: `hasOwnProperty`, not `in`.
  assert.deepEqual(selectBearerToken(store({}), "toString", URL_A), {
    token: null,
    refusal: "no-entry",
  })
})

test("a token inside the expiry skew is already expired", () => {
  const now = Date.now()
  const entries = (seconds: number): McpAuthStore =>
    store({
      alpha: { tokens: { accessToken: "tok", expiresAt: now / 1000 + seconds }, serverUrl: URL_A },
    })
  // 30 s of skew: a spawn that wins the race by a moment would hand the CLI a
  // credential that dies inside the first tool call.
  assert.equal(selectBearerToken(entries(29), "alpha", URL_A, now).token, null)
  assert.equal(selectBearerToken(entries(31), "alpha", URL_A, now).token, "tok")
  // No expiry recorded means opencode recorded none, not "expired".
  assert.equal(
    selectBearerToken(
      store({ alpha: { tokens: { accessToken: "tok" }, serverUrl: URL_A } }),
      "alpha",
      URL_A,
    ).token,
    "tok",
  )
})

test("the freshness key is the expiry and never anything derived from the token", () => {
  assert.equal(buildFreshnessKey(LIVE), String(LIVE))
  assert.notEqual(buildFreshnessKey(LIVE), buildFreshnessKey(LIVE + 1))
  // A token with no recorded expiry contributes a constant. The fork used a
  // truncated SHA-256 of the token here; that is one-way but it is still a
  // confirmation oracle for a secret, and this value lands in the bridge
  // hash, which is logged and compared by the hot-reload diff.
  assert.equal(buildFreshnessKey(undefined), "no-expiry")
})

test("an Authorization header already present wins, in any casing, without mutation", () => {
  const base = { type: "http", url: URL_A }
  const injected = injectBearerHeaders(base, "tok")
  assert.deepEqual(injected, {
    type: "http",
    url: URL_A,
    headers: { Authorization: "Bearer tok" },
  })
  assert.equal((base as Record<string, unknown>).headers, undefined, "must not mutate")

  const merged = injectBearerHeaders({ ...base, headers: { "X-Trace": "1" } }, "tok")
  assert.deepEqual((merged.headers as Record<string, string>), {
    "X-Trace": "1",
    Authorization: "Bearer tok",
  })

  for (const name of ["Authorization", "authorization", "AUTHORIZATION"]) {
    const kept = injectBearerHeaders({ ...base, headers: { [name]: "Bearer mine" } }, "tok")
    assert.deepEqual(kept.headers, { [name]: "Bearer mine" }, `${name} must be left alone`)
  }

  // A `headers` value that is not an object is ignored rather than spread.
  const odd = injectBearerHeaders({ ...base, headers: ["nope"] as unknown }, "tok")
  assert.deepEqual(odd.headers, { Authorization: "Bearer tok" })
})

test("the store is read from XDG_DATA_HOME, and every bad path answers empty", () => {
  const root = tmpDir()
  const previous = process.env.XDG_DATA_HOME
  process.env.XDG_DATA_HOME = root
  try {
    assert.equal(opencodeStateDir(), path.join(root, "opencode"))
  } finally {
    if (previous === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = previous
  }

  const stateDir = path.join(root, "opencode")
  fs.mkdirSync(stateDir, { recursive: true })
  // Absent.
  assert.deepEqual(readMcpAuthStore(stateDir), {})
  // Unparseable.
  const file = path.join(stateDir, "mcp-auth.json")
  fs.writeFileSync(file, "{ not json", { mode: 0o600 })
  assert.deepEqual(readMcpAuthStore(stateDir), {})
  // An array is an object to `typeof` and is not a store.
  fs.writeFileSync(file, JSON.stringify(["nope"]), { mode: 0o600 })
  assert.deepEqual(readMcpAuthStore(stateDir), {})
  // A directory where the file should be.
  fs.unlinkSync(file)
  fs.mkdirSync(file)
  assert.deepEqual(readMcpAuthStore(stateDir), {})
  fs.rmSync(file, { recursive: true })
  // A symlink is refused even when its target parses: the plugin is about to
  // copy a credential out of a file it does not own, so a planted link must
  // not get to choose which credential that is.
  const planted = path.join(root, "planted.json")
  fs.writeFileSync(planted, JSON.stringify({ alpha: { tokens: { accessToken: "tok" } } }))
  fs.symlinkSync(planted, file)
  assert.deepEqual(readMcpAuthStore(stateDir), {})
  fs.unlinkSync(file)
  // And the real shape reads back.
  fs.writeFileSync(
    file,
    JSON.stringify({ alpha: { tokens: { accessToken: "tok", expiresAt: LIVE }, serverUrl: URL_A } }),
    { mode: 0o600 },
  )
  assert.equal(selectBearerToken(readMcpAuthStore(stateDir), "alpha", URL_A).token, "tok")
  fs.rmSync(root, { recursive: true, force: true })
})
