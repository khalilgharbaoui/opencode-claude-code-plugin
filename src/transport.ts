import { detectHeadlessSupport } from "./cli-version.js"
import type { ClaudeCodeConfig, ClaudeCodeTransport } from "./types.js"

export function requestedTransport(
  config: Pick<ClaudeCodeConfig, "transport" | "interactive">,
  env = process.env.CLAUDE_CODE_INTERACTIVE_TRANSPORT,
): ClaudeCodeTransport {
  if (config.transport !== undefined) {
    if (!["auto", "headless", "interactive"].includes(config.transport)) {
      throw new Error(`Unknown Claude transport: ${config.transport}`)
    }
    return config.transport
  }
  const enabled = config.interactive ??
    (env !== undefined && !["", "0", "false", "no", "off"].includes(env.trim().toLowerCase()))
  return enabled ? "interactive" : "headless"
}

export function hasInteractiveTransport(): boolean {
  const runtime = globalThis as typeof globalThis & { Bun?: { Terminal?: unknown } }
  return typeof runtime.Bun?.Terminal === "function"
}

export async function selectTransport(
  requested: ClaudeCodeTransport,
  cliPath: string,
  available = hasInteractiveTransport(),
): Promise<"headless" | "interactive"> {
  if (requested === "headless") return "headless"
  if (requested === "interactive") {
    if (!available) throw new Error("Interactive Claude transport requires Bun.Terminal. Run opencode under a Bun runtime with PTY support.")
    return "interactive"
  }
  if (await detectHeadlessSupport(cliPath) !== "unsupported") return "headless"
  if (!available) throw new Error("Claude no longer supports the headless flags, and Bun.Terminal is unavailable. Run opencode under a Bun runtime with PTY support.")
  return "interactive"
}
