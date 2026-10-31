/**
 * The local stream-part id generator that replaced `@ai-sdk/provider-utils`'
 * `generateId` (the plugin's only use of that package).
 *
 * Usage: npx tsx --test test/ids.test.ts
 */
import "./isolate.js"
import assert from "node:assert/strict"
import { test } from "node:test"

import { generateId } from "../src/ids.js"

test("generateId keeps the shape the AI SDK's generateId had", () => {
  for (let attempt = 0; attempt < 200; attempt++) {
    assert.match(generateId(), /^[0-9A-Za-z]{16}$/)
  }
})

test("generateId does not repeat within a stream's worth of parts", () => {
  const ids = new Set(Array.from({ length: 10_000 }, () => generateId()))
  assert.equal(ids.size, 10_000)
})
