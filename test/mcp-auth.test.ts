/**
 * Unit tests for src/mcp-auth.ts.
 *
 * Runs offline — all token data is fabricated.
 * Uses Node's built-in `node:test` so no extra dependencies are pulled in.
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
  selectBearerToken,
  buildFreshnessKey,
  injectBearerHeaders,
  type McpAuthEntry,
} from "../src/mcp-auth.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mkTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function writeMcpAuth(dir: string, data: unknown): string {
  const file = path.join(dir, "mcp-auth.json")
  fs.writeFileSync(file, JSON.stringify(data), { mode: 0o600 })
  return file
}

// A future timestamp (year 2099) — always valid.
const FAR_FUTURE = new Date("2099-01-01T00:00:00Z").getTime() / 1000

// A past timestamp — always expired.
const IN_THE_PAST = new Date("2000-01-01T00:00:00Z").getTime() / 1000

const FAKE_TOKEN = "tok_abc123"
const SERVER_URL = "https://mcp.example.com/mcp"

// ---------------------------------------------------------------------------
// selectBearerToken
// ---------------------------------------------------------------------------

test("selectBearerToken: returns token for exact URL match (non-expiring)", () => {
  const entries: Record<string, McpAuthEntry> = {
    "my-server": {
      tokens: { accessToken: FAKE_TOKEN },
      serverUrl: SERVER_URL,
    },
  }
  const result = selectBearerToken(entries, SERVER_URL)
  assert.equal(result, FAKE_TOKEN)
})

test("selectBearerToken: returns token when expiresAt is in the future", () => {
  const entries: Record<string, McpAuthEntry> = {
    "my-server": {
      tokens: { accessToken: FAKE_TOKEN, expiresAt: FAR_FUTURE },
      serverUrl: SERVER_URL,
    },
  }
  const result = selectBearerToken(entries, SERVER_URL)
  assert.equal(result, FAKE_TOKEN)
})

test("selectBearerToken: returns null when token is expired (past expiresAt)", () => {
  const entries: Record<string, McpAuthEntry> = {
    "my-server": {
      tokens: { accessToken: FAKE_TOKEN, expiresAt: IN_THE_PAST },
      serverUrl: SERVER_URL,
    },
  }
  const result = selectBearerToken(entries, SERVER_URL)
  assert.equal(result, null)
})

test("selectBearerToken: returns null when token expires within the 30 s skew margin", () => {
  const almostExpired = Date.now() / 1000 + 15 // 15 s from now, inside 30 s margin
  const entries: Record<string, McpAuthEntry> = {
    "my-server": {
      tokens: { accessToken: FAKE_TOKEN, expiresAt: almostExpired },
      serverUrl: SERVER_URL,
    },
  }
  const result = selectBearerToken(entries, SERVER_URL)
  assert.equal(result, null)
})

test("selectBearerToken: returns null when URL does not match", () => {
  const entries: Record<string, McpAuthEntry> = {
    "my-server": {
      tokens: { accessToken: FAKE_TOKEN },
      serverUrl: "https://other.example.com/mcp",
    },
  }
  const result = selectBearerToken(entries, SERVER_URL)
  assert.equal(result, null)
})

test("selectBearerToken: returns null when entry has no serverUrl", () => {
  const entries: Record<string, McpAuthEntry> = {
    "my-server": {
      tokens: { accessToken: FAKE_TOKEN },
    },
  }
  const result = selectBearerToken(entries, SERVER_URL)
  assert.equal(result, null)
})

test("selectBearerToken: returns null when entry has no tokens", () => {
  const entries: Record<string, McpAuthEntry> = {
    "my-server": {
      serverUrl: SERVER_URL,
    },
  }
  const result = selectBearerToken(entries, SERVER_URL)
  assert.equal(result, null)
})

test("selectBearerToken: matches first valid entry when multiple entries share a URL", () => {
  const entries: Record<string, McpAuthEntry> = {
    "expired-server": {
      tokens: { accessToken: "old_tok", expiresAt: IN_THE_PAST },
      serverUrl: SERVER_URL,
    },
    "valid-server": {
      tokens: { accessToken: FAKE_TOKEN, expiresAt: FAR_FUTURE },
      serverUrl: SERVER_URL,
    },
  }
  // Should return the first valid one encountered; expired entry is skipped.
  const result = selectBearerToken(entries, SERVER_URL)
  assert.equal(result, FAKE_TOKEN)
})

// ---------------------------------------------------------------------------
// buildFreshnessKey
// ---------------------------------------------------------------------------

test("buildFreshnessKey: returns truncated SHA-256 of token when no expiresAt", () => {
  const key = buildFreshnessKey(FAKE_TOKEN, undefined)
  assert.match(key, /^[0-9a-f]{12}$/, "should be 12 hex chars")
  // Same token → same key (deterministic).
  assert.equal(key, buildFreshnessKey(FAKE_TOKEN, undefined))
})

test("buildFreshnessKey: returns expiresAt string when provided", () => {
  const key = buildFreshnessKey(FAKE_TOKEN, FAR_FUTURE)
  assert.equal(key, String(FAR_FUTURE))
})

test("buildFreshnessKey: different tokens produce different keys", () => {
  const k1 = buildFreshnessKey("tok_aaa", undefined)
  const k2 = buildFreshnessKey("tok_bbb", undefined)
  assert.notEqual(k1, k2)
})

// ---------------------------------------------------------------------------
// injectBearerHeaders
// ---------------------------------------------------------------------------

test("injectBearerHeaders: adds Authorization header when no existing headers", () => {
  const server: Record<string, unknown> = { type: "http", url: SERVER_URL }
  const result = injectBearerHeaders(server, FAKE_TOKEN)
  assert.deepEqual((result.headers as Record<string, string>)["Authorization"], `Bearer ${FAKE_TOKEN}`)
})

test("injectBearerHeaders: merges with existing headers", () => {
  const server: Record<string, unknown> = {
    type: "http",
    url: SERVER_URL,
    headers: { "X-Custom": "value" },
  }
  const result = injectBearerHeaders(server, FAKE_TOKEN)
  const headers = result.headers as Record<string, string>
  assert.equal(headers["X-Custom"], "value")
  assert.equal(headers["Authorization"], `Bearer ${FAKE_TOKEN}`)
})

test("injectBearerHeaders: does NOT override existing Authorization header", () => {
  const existingAuth = "Bearer already_set"
  const server: Record<string, unknown> = {
    type: "http",
    url: SERVER_URL,
    headers: { Authorization: existingAuth },
  }
  const result = injectBearerHeaders(server, FAKE_TOKEN)
  const headers = result.headers as Record<string, string>
  assert.equal(headers["Authorization"], existingAuth)
})

test("injectBearerHeaders: returns a new object, does not mutate the original", () => {
  const server: Record<string, unknown> = { type: "http", url: SERVER_URL }
  const result = injectBearerHeaders(server, FAKE_TOKEN)
  assert.ok(result !== server, "should return a new object")
  assert.ok(!("headers" in server), "original must not be mutated")
})
