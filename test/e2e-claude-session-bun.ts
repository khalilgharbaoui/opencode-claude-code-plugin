/**
 * E2E for src/claude-session-bun.ts against REAL claude over Bun's native
 * ConPTY. Plain runnable script (not part of the offline suite; spawns claude,
 * needs a logged-in subscription). Run:
 *
 *   bun test/e2e-claude-session-bun.ts
 *
 * Milestone proof: multiple messages in one live chat session, context retained
 * across turns (subscription interactive path), with prompt-cache reuse.
 */
import "./isolate.js"
import { ClaudeSession, askOnce } from "../src/claude-session-bun.js"

const TERMINAL = new Set(["end_turn", "stop_sequence", "max_tokens"])
let failures = 0
function check(cond: boolean, msg: string) {
  if (cond) console.log("  PASS:", msg)
  else {
    failures++
    console.log("  FAIL:", msg)
  }
}

async function main() {
  console.log("=== e2e claude-session-bun (Bun native ConPTY) ===")
  console.log(
    "bun:",
    Bun.version,
    "| Bun.Terminal:",
    typeof (Bun as any).Terminal,
  )

  console.log("\n[A] one-shot 2+2")
  const r = await askOnce("What is 2+2? Reply with only the number.", {
    settingSources: "",
  })
  console.log("  reply:", JSON.stringify(r.text), "stop:", r.stopReason)
  check(TERMINAL.has(r.stopReason ?? ""), "one-shot terminal stop")
  check(/4/.test(r.text), "one-shot says 4")

  console.log("\n[B] multi-turn: 3 messages, one live process")
  const s = new ClaudeSession({ settingSources: "" })
  await s.start()
  try {
    const t1 = await s.ask(
      "Remember two facts for this conversation: my favorite number is 42 and my favorite color is teal. Reply with exactly: OK",
    )
    console.log("  turn1:", JSON.stringify(t1.text), "stop:", t1.stopReason)
    check(TERMINAL.has(t1.stopReason ?? ""), "turn1 terminal stop")

    const t2 = await s.ask(
      "What is my favorite number? Reply with only the number.",
    )
    console.log(
      "  turn2:",
      JSON.stringify(t2.text),
      "stop:",
      t2.stopReason,
      "cacheRead:",
      t2.cacheReadTokens,
      "eph1h:",
      t2.ephemeral1hTokens,
    )
    check(TERMINAL.has(t2.stopReason ?? ""), "turn2 terminal stop")
    check(/42/.test(t2.text), "turn2 recalls 42 (context retained across turns)")

    const t3 = await s.ask(
      "What is my favorite color? Reply with only the word.",
    )
    console.log(
      "  turn3:",
      JSON.stringify(t3.text),
      "stop:",
      t3.stopReason,
      "cacheRead:",
      t3.cacheReadTokens,
    )
    check(TERMINAL.has(t3.stopReason ?? ""), "turn3 terminal stop")
    check(/teal/i.test(t3.text), "turn3 recalls teal (context retained across turns)")

    check(
      t2.cacheReadTokens > 0 || t3.cacheReadTokens > 0,
      "prompt-cache reuse on later turns (1h tier)",
    )
  } finally {
    s.dispose()
  }

  console.log(
    `\n=== ${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"} ===`,
  )
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error("FATAL:", e?.stack ?? e)
  process.exit(2)
})
