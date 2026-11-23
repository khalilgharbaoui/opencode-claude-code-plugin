import type { ClaudeStreamMessage } from "./types.js"

const READINGS_LIMIT = 256

type Reading = { readonly claudeSessionId: string; readonly prompt: number }

const readings = new Map<string, Reading>()

export function recordContextReading(
  sessionKey: string,
  claudeSessionId: string | undefined,
  usage: ClaudeStreamMessage["usage"],
): void {
  const prompt =
    (usage?.input_tokens ?? 0) +
    (usage?.cache_read_input_tokens ?? 0) +
    (usage?.cache_creation_input_tokens ?? 0)
  if (!claudeSessionId || prompt <= 0) return
  readings.delete(sessionKey)
  readings.set(sessionKey, { claudeSessionId, prompt })
  if (readings.size > READINGS_LIMIT) readings.delete(readings.keys().next().value!)
}

export function frozenContextUsage(
  sessionKey: string,
  claudeSessionId: string | undefined,
): ClaudeStreamMessage["usage"] {
  const reading = readings.get(sessionKey)
  if (!reading || !claudeSessionId || reading.claudeSessionId !== claudeSessionId) return undefined
  return {
    input_tokens: 0,
    cache_read_input_tokens: reading.prompt,
    cache_creation_input_tokens: 0,
    output_tokens: 0,
  }
}

export function forgetContextReadings(affinity: string): void {
  const marker = `::${affinity}::context=`
  for (const key of [...readings.keys()]) {
    if (key.includes(marker)) readings.delete(key)
  }
}
