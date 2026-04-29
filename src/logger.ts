const DEBUG = process.env.DEBUG?.includes("opencode-claude-code") ?? false

function fmt(level: string, msg: string, data?: Record<string, unknown>): string {
  const ts = new Date().toISOString()
  const base = `[${ts}] [opencode-claude-code] ${level}: ${msg}`
  if (data && Object.keys(data).length > 0) {
    return `${base} ${JSON.stringify(data)}`
  }
  return base
}

export const log = {
  info(msg: string, data?: Record<string, unknown>) {
    if (DEBUG) console.error(fmt("INFO", msg, data))
  },
  notice(msg: string, data?: Record<string, unknown>) {
    console.error(fmt("NOTICE", msg, data))
  },
  warn(msg: string, data?: Record<string, unknown>) {
    if (DEBUG) console.error(fmt("WARN", msg, data))
  },
  error(msg: string, data?: Record<string, unknown>) {
    console.error(fmt("ERROR", msg, data))
  },
  debug(msg: string, data?: Record<string, unknown>) {
    if (DEBUG) console.error(fmt("DEBUG", msg, data))
  },
}
