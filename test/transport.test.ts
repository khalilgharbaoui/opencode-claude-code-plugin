import assert from "node:assert/strict"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import {
  _clearCache,
  _resetUnmeasuredInteractiveWarnings,
  _setProbeTimeoutMs,
  detectHeadlessSupport,
  INTERACTIVE_MEASURED_CLI,
  isUnmeasuredInteractiveCli,
  reportUnmeasuredInteractiveCli,
} from "../src/cli-version.js"
import { configureLogger, _resetLoggerForTests } from "../src/logger.js"
import { requestedTransport, selectTransport } from "../src/transport.js"
import { fetchPlanUsage } from "../src/plan-usage.js"
import { createClaudeCode } from "../src/index.js"

const HELP = "Usage: claude [options]\nOptions:\n  -p, --print\n  --input-format <format> (text, stream-json)\n  --output-format <format> (text, json, stream-json)\n"

function fixture(source: string) {
  const directory = mkdtempSync(join(tmpdir(), "ccp-transport-"))
  const cliPath = join(directory, "claude")
  writeFileSync(cliPath, `#!/bin/sh\n${source}\n`)
  chmodSync(cliPath, 0o755)
  return { cliPath, cleanup: () => rmSync(directory, { recursive: true, force: true }) }
}

test("transport precedence preserves legacy switches and validates explicit modes", () => {
  assert.equal(requestedTransport({}, undefined), "headless")
  assert.equal(requestedTransport({}, "1"), "interactive")
  assert.equal(requestedTransport({ interactive: false }, "1"), "headless")
  assert.equal(requestedTransport({ interactive: true }, "0"), "interactive")
  assert.equal(requestedTransport({ transport: "headless", interactive: true }, "1"), "headless")
  assert.equal(requestedTransport({ transport: "auto", interactive: false }, "0"), "auto")
  assert.throws(() => requestedTransport({ transport: "typo" as never }), /Unknown Claude transport/)
})

test("auto selects interactive only for proven missing headless capabilities", async () => {
  // Classification, not the deadline: the deadline has its own test below.
  // At the default 5 s a loaded machine killed the `--help` probe of a
  // one-line shell script and it answered `unknown` (h #g181, measured
  // 2026-10-07 at load 22), so this test must never race it.
  _clearCache()
  _setProbeTimeoutMs(60_000)
  try {
    for (const [source, expected] of [
      [`printf '%s' '${HELP}'`, "supported"],
      ["printf 'Usage: claude [options]\\nOptions:\\n  --model <model>\\n'", "unsupported"],
      ["printf \"error: unknown option '--print'\\n\" >&2; exit 1", "unsupported"],
      ["printf 'Authentication failed\\n' >&2; exit 1", "unknown"],
      ["printf 'unrecognizable output'", "unknown"],
      ["exit 3", "unknown"],
    ] as const) {
      const cli = fixture(source)
      try {
        const probe = detectHeadlessSupport(cli.cliPath)
        assert.equal(await probe, expected)
        assert.equal(detectHeadlessSupport(cli.cliPath), probe, "definitive answers and ordinary failures are cached")
        assert.equal(await selectTransport("auto", cli.cliPath, true), expected === "unsupported" ? "interactive" : "headless")
        if (expected === "unsupported") {
          await assert.rejects(selectTransport("auto", cli.cliPath, false), /Bun.Terminal is unavailable/)
        }
      } finally {
        cli.cleanup()
      }
    }
    assert.equal(await selectTransport("auto", "/missing/claude", true), "headless")
    assert.equal(await selectTransport("headless", "/missing/claude", false), "headless")
    await assert.rejects(selectTransport("interactive", "/missing/claude", false), /requires Bun.Terminal/)
  } finally {
    // Also restores the default deadline.
    _clearCache()
  }
})

test("a deadline is unknown, retried twice, then conservatively cached", async () => {
  const cli = fixture("exec sleep 10")
  _clearCache()
  _setProbeTimeoutMs(100)
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const probe = detectHeadlessSupport(cli.cliPath)
      assert.equal(await probe, "unknown")
      const next = detectHeadlessSupport(cli.cliPath)
      if (attempt < 2) assert.notEqual(next, probe)
      else assert.equal(next, probe)
    }
    assert.equal(await selectTransport("auto", cli.cliPath, true), "headless")
  } finally {
    _clearCache()
    cli.cleanup()
  }
})

test("doctor usage never starts /cost when print was removed", async () => {
  const cli = fixture("printf \"error: unknown option '--print'\\n\" >&2; exit 1")
  let calls = 0
  try {
    const result = await fetchPlanUsage(cli.cliPath, {
      headlessSupportImpl: detectHeadlessSupport,
      runImpl: async () => { calls++; throw new Error("must not run") },
    })
    assert.equal(result.status, "failed")
    assert.match(result.status === "failed" ? result.error : "", /usage is unavailable/)
    assert.equal(calls, 0)
  } finally {
    cli.cleanup()
  }
})

test("doctor stays accessible without Bun even when interactive inference is refused", async () => {
  const cli = fixture("if [ \"$1\" = '--version' ]; then printf '2.1.288'; else printf \"error: unknown option '--print'\\n\" >&2; exit 1; fi")
  const bun = Object.getOwnPropertyDescriptor(globalThis, "Bun")
  Reflect.deleteProperty(globalThis, "Bun")
  try {
    for (const settings of [
      { transport: "interactive" as const },
      { transport: "interactive" as const, permissionMode: "plan" as const },
      { transport: "interactive" as const, permissionPreset: "read-only" as const },
      { transport: "auto" as const },
    ]) {
      const model = createClaudeCode({ ...settings, cliPath: cli.cliPath, bridgeOpencodeMcp: false })
        .languageModel("claude-haiku-4-5")
      const response = await model.doStream({
        prompt: [{ role: "user", content: [{ type: "text", text: "/claude-code-doctor" }] }],
        tools: [{ type: "function", name: "read", inputSchema: { type: "object", properties: {} } }],
      })
      const parts = []
      for await (const part of response.stream) parts.push(part)
      assert.equal(parts.some(part => part.type === "error"), false)
      assert.ok(parts.some(part => part.type === "finish" && part.providerMetadata?.["claude-code"]?.path === "doctor"))
      assert.ok(parts.some(part => part.type === "text-delta" && part.delta.includes("Plan usage")))
    }
  } finally {
    if (bun) Object.defineProperty(globalThis, "Bun", bun)
    else Reflect.deleteProperty(globalThis, "Bun")
    cli.cleanup()
  }
})

const version = (raw: string) => {
  const [major, minor, patch] = raw.split(".").map(Number)
  return { major, minor, patch, raw }
}

test("a CLI newer than the interactive transport was measured on is reported once, never refused", () => {
  assert.equal(INTERACTIVE_MEASURED_CLI, "2.1.293")
  assert.equal(isUnmeasuredInteractiveCli(null), false, "an unknown version is not a claim either way")
  assert.equal(isUnmeasuredInteractiveCli(version("2.1.288")), false)
  assert.equal(isUnmeasuredInteractiveCli(version("2.1.293")), false)
  assert.equal(isUnmeasuredInteractiveCli(version("2.1.294")), true)
  assert.equal(isUnmeasuredInteractiveCli(version("2.2.0")), true)
  assert.equal(isUnmeasuredInteractiveCli(version("3.0.0")), true)

  const lines: string[] = []
  const original = console.error
  console.error = (line: unknown) => lines.push(String(line))
  try {
    _resetLoggerForTests()
    configureLogger({ mode: "debug", level: "debug" })
    _resetUnmeasuredInteractiveWarnings()
    reportUnmeasuredInteractiveCli(version("2.1.293"))
    reportUnmeasuredInteractiveCli(null)
    reportUnmeasuredInteractiveCli(version("2.1.300"))
    reportUnmeasuredInteractiveCli(version("2.1.300"))
    reportUnmeasuredInteractiveCli(version("2.1.301"))
  } finally {
    console.error = original
    _resetLoggerForTests()
    _resetUnmeasuredInteractiveWarnings()
  }
  const warns = lines.filter((line) => line.includes("has not been measured"))
  assert.equal(warns.length, 2, "one per new version")
  assert.match(warns[0]!, /WARN/)
  assert.match(warns[0]!, /2\.1\.300/)
  assert.match(warns[1]!, /2\.1\.301/)
})
