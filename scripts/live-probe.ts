// Live probe against the real Claude Code CLI. Not part of the test suite:
// it spends real tokens and needs a logged-in `claude`. Run with
//   npx tsx scripts/live-probe.ts
// Modes (env MODE):
//   hold  HOLD_MS=390000  proxy holds one bash call for HOLD_MS, then resolves.
//                         Verifies the CLI still receives the result after a
//                         6.5-minute hold using SSE. This checks the measured
//                         stalled HTTP response behavior, not a specific timer.
//   btw                   one normal turn, then a `side_question` control
//                         request. Verifies the /btw protocol shape.
// Other env: CLI (path to claude), MODEL (default claude-haiku-4-5).
// HOLD_MS must be an integer from 1 to 1800000. Global deadline: hold + 4 min
// in hold mode, 4 min in btw mode, plus at most 5 seconds for cleanup.
import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { randomUUID } from "node:crypto"
import { createProxyMcpServer, DEFAULT_PROXY_TOOLS, type ProxyToolCall } from "../src/proxy-mcp.js"

const mode = process.env.MODE ?? "btw"
const holdMs = Number(process.env.HOLD_MS ?? "390000")
if (mode !== "hold" && mode !== "btw") {
  console.error("MODE must be hold or btw")
  process.exit(1)
}
if (!Number.isSafeInteger(holdMs) || holdMs < 1 || holdMs > 1_800_000) {
  console.error("HOLD_MS must be an integer from 1 to 1800000")
  process.exit(1)
}
const cli = process.env.CLI ?? "claude"
const model = process.env.MODEL ?? "claude-haiku-4-5"
const t0 = Date.now()
const stamp = () => `[+${((Date.now() - t0) / 1000).toFixed(1)}s]`
const say = (...a: unknown[]) => console.log(stamp(), ...a)
const marker = `PROBE-RESULT-OK-${randomUUID()}`
const requestId = randomUUID()
const timers = new Set<ReturnType<typeof setTimeout>>()
let done = false
let heldResultReturned = false
let proxyCalled = false
let questionSent = false
let srv: Awaited<ReturnType<typeof createProxyMcpServer>> | undefined
let proc: ReturnType<typeof spawn> | undefined
let rl: ReturnType<typeof createInterface> | undefined
let cliClosed: Promise<void> | undefined
const deadline = setTimeout(() => void finish(false, "global timeout"),
  (mode === "hold" ? holdMs : 0) + 240_000)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

async function finish(success: boolean, reason: string) {
  if (done) return
  done = true
  process.exitCode = success ? 0 : 1
  say(success ? "VERIFIED" : "FAIL", reason)
  clearTimeout(deadline)
  for (const timer of timers) clearTimeout(timer)
  timers.clear()
  if (!srv) process.exit(1)
  const cleanupDeadline = setTimeout(() => {
    proc?.kill("SIGKILL")
    say("FAIL", "cleanup timeout")
    process.exit(1)
  }, 5_000)
  rl?.close()
  proc?.stdin?.destroy()
  proc?.kill("SIGTERM")
  try {
    await Promise.all([srv?.close(), cliClosed])
  } catch {
    process.exitCode = 1
    say("FAIL", "cleanup error")
  } finally {
    clearTimeout(cleanupDeadline)
  }
}

try {
  const bash = DEFAULT_PROXY_TOOLS.find((tool) => tool.name === "bash")!
  srv = await createProxyMcpServer([bash], { bash: holdMs + 120_000 })
  // If setup outlived the deadline, do not spawn a CLI afterwards.
  if (done) {
    await srv.close()
  } else {
    srv.calls.on("call", (call: ProxyToolCall) => {
      if (done) return
      if (mode !== "hold" || proxyCalled || call.toolName !== "bash") {
        void finish(false, "unexpected proxy call")
        return
      }
      proxyCalled = true
      say("PROXY CALL RECEIVED; holding response", holdMs)
      const timer = setTimeout(() => {
        timers.delete(timer)
        if (call.channel?.closed) {
          void finish(false, "proxy HTTP response closed before hold completed")
          return
        }
        heldResultReturned = true
        say("PROXY RESOLVING after hold", holdMs)
        call.resolve({ kind: "text", text: marker })
      }, holdMs)
      timers.add(timer)
    })

    const args = [
      "--print", "--output-format", "stream-json", "--input-format", "stream-json",
      "--include-partial-messages", "--verbose", "--model", model,
      "--mcp-config", srv.configPath(), "--strict-mcp-config",
      "--disallowedTools", "Bash", "--dangerously-skip-permissions",
    ]
    say("spawning CLI", "mode=", mode)
    const child = spawn(cli, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, TERM: "xterm-256color" },
    })
    proc = child
    cliClosed = new Promise<void>((resolve) => child.once("close", () => {
      resolve()
      if (!done) void finish(false, "unexpected CLI close")
    }))
    child.on("error", () => void finish(false, "CLI process error"))
    child.stdin.on("error", () => void finish(false, "CLI stdin error"))
    child.stdout.on("error", () => void finish(false, "CLI stdout error"))
    child.stderr.on("error", () => void finish(false, "CLI stderr error"))
    // Drain diagnostics without exposing auth details, prompts, or thinking.
    child.stderr.resume()
    rl = createInterface({ input: child.stdout })
    rl.on("close", () => {
      if (!done) void finish(false, "unexpected CLI stdout close")
    })
    rl.on("line", (line) => {
      if (done) return
      let msg: unknown
      try {
        msg = JSON.parse(line)
      } catch {
        void finish(false, "invalid CLI JSON")
        return
      }
      if (!isRecord(msg)) {
        void finish(false, "invalid CLI message")
        return
      }
      if (msg.type === "error" || msg.is_error === true ||
          (msg.type === "assistant" && msg.error != null)) {
        void finish(false, "CLI reported an error")
        return
      }
      if (msg.type === "control_response") {
        const response = msg.response
        const answer = isRecord(response) ? response.response : undefined
        const valid = mode === "btw" && questionSent && isRecord(response) &&
          response.request_id === requestId && response.subtype === "success" &&
          isRecord(answer) && answer.response === "pong" && answer.synthetic === false
        void finish(valid, valid ? "native /btw returned matching pong" : "unexpected /btw response")
        return
      }
      if (msg.type === "control_request") {
        void finish(false, "unexpected CLI control request")
        return
      }
      if (msg.type === "result") {
        if (msg.subtype !== "success" || msg.is_error !== false) {
          void finish(false, "unsuccessful CLI result")
          return
        }
        if (mode === "hold") {
          const valid = heldResultReturned && msg.result === marker
          void finish(valid, valid ? "held marker returned" : "held marker missing or mismatched")
        } else if (!questionSent && msg.result === "pong") {
          questionSent = true
          const req = {
            type: "control_request",
            request_id: requestId,
            request: {
              subtype: "side_question",
              question:
                "What single word did I ask you to reply with? Answer with just that word.",
            },
          }
          say("SENDING side_question")
          child.stdin.write(JSON.stringify(req) + "\n")
        } else {
          void finish(false, "unexpected initial pong result or extra result")
        }
      }
    })

    const prompt =
      mode === "hold"
        ? "Use the mcp__opencode_proxy__bash tool to run the command `echo probe`. After it returns, reply with exactly the text the tool returned and nothing else."
        : "Reply with the single word: pong"
    say("SENDING user message")
    child.stdin.write(
      JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "text", text: prompt }] },
      }) + "\n",
    )
  }
} catch {
  await finish(false, "probe setup failed")
}
