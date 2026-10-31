import "./isolate.js"
import assert from "node:assert/strict"
import { test } from "node:test"
import { resolveSessionAffinity } from "../src/claude-code-language-model.js"

function makeProviderOptions(
  providerKey: string,
  sessionID: string,
): Record<string, unknown> {
  return { [providerKey]: { opencodeSessionID: sessionID } }
}

test("resolveSessionAffinity returns header value (exact case)", () => {
  const headers = { "x-session-affinity": "ses_abc123" }
  assert.equal(resolveSessionAffinity(headers, undefined, "claude-code"), "ses_abc123")
})

test("resolveSessionAffinity returns header value (uppercase key)", () => {
  const headers = { "X-Session-Affinity": "ses_ABC" }
  assert.equal(resolveSessionAffinity(headers, undefined, "claude-code"), "ses_ABC")
})

test("resolveSessionAffinity returns header value (mixed-case key)", () => {
  const headers = { "X-SESSION-AFFINITY": "ses_mixed" }
  assert.equal(resolveSessionAffinity(headers, undefined, "claude-code"), "ses_mixed")
})

test("resolveSessionAffinity returns providerOptions value when header is absent (no headers arg)", () => {
  const providerOptions = makeProviderOptions("claude-code", "ses_fromProvider")
  assert.equal(resolveSessionAffinity(undefined, providerOptions, "claude-code"), "ses_fromProvider")
})

test("resolveSessionAffinity returns providerOptions value when headers object is empty", () => {
  const providerOptions = makeProviderOptions("claude-code", "ses_fromProvider2")
  assert.equal(resolveSessionAffinity({}, providerOptions, "claude-code"), "ses_fromProvider2")
})

test("resolveSessionAffinity returns providerOptions value when header key is missing", () => {
  const headers = { "content-type": "application/json" }
  const providerOptions = makeProviderOptions("claude-code", "ses_noAffinityHeader")
  assert.equal(resolveSessionAffinity(headers, providerOptions, "claude-code"), "ses_noAffinityHeader")
})

test("resolveSessionAffinity uses custom providerKey to read providerOptions", () => {
  const providerOptions = { "my-custom-provider": { opencodeSessionID: "ses_custom" } }
  assert.equal(resolveSessionAffinity(undefined, providerOptions, "my-custom-provider"), "ses_custom")
})

test("resolveSessionAffinity falls back to claude-code key when own providerKey not found", () => {
  const providerOptions = { "claude-code": { opencodeSessionID: "ses_canonicalFallback" } }
  assert.equal(resolveSessionAffinity(undefined, providerOptions, "my-custom-provider"), "ses_canonicalFallback")
})

test("resolveSessionAffinity prefers header over providerOptions when both present", () => {
  const headers = { "x-session-affinity": "ses_fromHeader" }
  const providerOptions = makeProviderOptions("claude-code", "ses_fromProvider")
  assert.equal(resolveSessionAffinity(headers, providerOptions, "claude-code"), "ses_fromHeader")
})

test("resolveSessionAffinity prefers header even when providerOptions has a different value", () => {
  const headers = { "X-Session-Affinity": "ses_header_wins" }
  const providerOptions = makeProviderOptions("claude-code", "ses_should_lose")
  assert.equal(resolveSessionAffinity(headers, providerOptions, "claude-code"), "ses_header_wins")
})

test('resolveSessionAffinity returns "default" when both header and providerOptions are absent', () => {
  assert.equal(resolveSessionAffinity(undefined, undefined, "claude-code"), "default")
})

test('resolveSessionAffinity returns "default" when headers is empty and providerOptions is undefined', () => {
  assert.equal(resolveSessionAffinity({}, undefined, "claude-code"), "default")
})

test('resolveSessionAffinity returns "default" when header value is empty string', () => {
  const headers = { "x-session-affinity": "" }
  assert.equal(resolveSessionAffinity(headers, undefined, "claude-code"), "default")
})

test('resolveSessionAffinity returns "default" when providerOptions has empty opencodeSessionID', () => {
  const providerOptions = { "claude-code": { opencodeSessionID: "" } }
  assert.equal(resolveSessionAffinity(undefined, providerOptions, "claude-code"), "default")
})

test('resolveSessionAffinity returns "default" when providerOptions has no opencodeSessionID field', () => {
  const providerOptions = { "claude-code": { opencodeAgent: "default" } }
  assert.equal(resolveSessionAffinity(undefined, providerOptions, "claude-code"), "default")
})

test('resolveSessionAffinity returns "default" when providerOptions bag is missing entirely', () => {
  const providerOptions = { "other-provider": { opencodeSessionID: "ses_wrong" } }
  assert.equal(resolveSessionAffinity(undefined, providerOptions, "claude-code"), "default")
})
