import { spawn } from "node:child_process"
import { cliSupportsAuthStatus, detectCliVersion, type CliVersion } from "./cli-version.js"
import { claudeSpawnEnv } from "./session-manager.js"
import { planClaudeSpawn } from "./windows-spawn.js"

/**
 * Whether the Claude CLI is installed and logged in, read from
 * `claude auth status` (opencode 2's `/connect` entry, h #g277).
 *
 * The command prints JSON by default and exits 0 when logged in, 1 when not
 * (measured on 2.1.288, 2.1.293 and 2.1.314, about 0.13 s). Its output also
 * carries the account's email, organization id and organization name; only
 * the five fields below are ever read, and nothing here reads or stores a
 * token, because `auth status` never prints one.
 */
export interface ClaudeAuthStatus {
  loggedIn: boolean
  /** `claude.ai`, `api_key`, `api_key_helper`, `oauth_token`, `third_party` or `none` on 2.1.314. */
  authMethod?: string
  /** `firstParty`, `bedrock`, `vertex`, `foundry`, `gateway`, ... */
  apiProvider?: string
  /** `ANTHROPIC_API_KEY`, `apiKeyHelper`, `/login managed key`. */
  apiKeySource?: string
  /** `max`, `pro`, `team`, `enterprise`. */
  subscriptionType?: string
}

export type ClaudeLoginState =
  | { status: "logged-in"; auth: ClaudeAuthStatus }
  | { status: "logged-out"; auth: ClaudeAuthStatus }
  /** The CLI was not found where the provider would spawn it. */
  | { status: "missing" }
  /** Anything else: a CLI too old for the check, a timeout, output that is not the shape above. */
  | { status: "failed"; reason: string }

/** A field value worth showing: short, and nothing but name characters. */
const SAFE_VALUE = /^[A-Za-z0-9_./ -]{1,40}$/

function safeString(value: unknown): string | undefined {
  return typeof value === "string" && SAFE_VALUE.test(value) ? value : undefined
}

/** The five fields, or undefined when the output is not `auth status`'s JSON. */
export function parseClaudeAuthStatus(stdout: string): ClaudeAuthStatus | undefined {
  const start = stdout.indexOf("{")
  const end = stdout.lastIndexOf("}")
  if (start < 0 || end <= start) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout.slice(start, end + 1))
  } catch {
    return undefined
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined
  const record = parsed as Record<string, unknown>
  if (typeof record.loggedIn !== "boolean") return undefined
  const status: ClaudeAuthStatus = { loggedIn: record.loggedIn }
  const authMethod = safeString(record.authMethod)
  const apiProvider = safeString(record.apiProvider)
  const apiKeySource = safeString(record.apiKeySource)
  const subscriptionType = safeString(record.subscriptionType)
  if (authMethod) status.authMethod = authMethod
  if (apiProvider) status.apiProvider = apiProvider
  if (apiKeySource) status.apiKeySource = apiKeySource
  if (subscriptionType) status.subscriptionType = subscriptionType
  return status
}

const THIRD_PARTY_NAMES: Record<string, string> = {
  bedrock: "Amazon Bedrock",
  vertex: "Google Vertex AI",
  foundry: "Microsoft Foundry",
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

/** How the CLI authenticates, in words: "a Claude subscription (Max)", "Amazon Bedrock". */
export function describeLoginMethod(auth: ClaudeAuthStatus): string {
  const provider = auth.apiProvider
  if (provider && provider !== "firstParty") {
    if (provider === "gateway") return "a Claude gateway"
    return THIRD_PARTY_NAMES[provider] ?? `the ${provider} provider`
  }
  switch (auth.authMethod) {
    case "claude.ai":
      return auth.subscriptionType
        ? `a Claude subscription (${capitalize(auth.subscriptionType)})`
        : "a Claude subscription"
    case "api_key":
      return auth.apiKeySource ? `an API key (${auth.apiKeySource})` : "an API key"
    case "api_key_helper":
      return "an API key helper (apiKeyHelper)"
    case "oauth_token":
      return "an OAuth token"
    default:
      return auth.authMethod ? `"${auth.authMethod}"` : "an unknown method"
  }
}

/** opencode 2's `Connection.Status`: a connection that needs the user's attention. */
export interface LoginProblem {
  status: "needs_auth"
  message: string
  url?: string
}

export const CLAUDE_CODE_SETUP_URL = "https://code.claude.com/docs/en/setup"

/**
 * What the connection should say, or undefined when nothing is wrong. A failed
 * check is undefined too: it says nothing about the login, so it must neither
 * raise nor clear a sign-in prompt (the caller leaves the connection alone).
 */
export function loginProblem(state: ClaudeLoginState, loginCommand: string): LoginProblem | undefined {
  if (state.status === "missing") {
    return {
      status: "needs_auth",
      message: `Claude Code is not installed. Install it, then run \`${loginCommand}\` in a terminal.`,
      url: CLAUDE_CODE_SETUP_URL,
    }
  }
  if (state.status === "logged-out") {
    return { status: "needs_auth", message: `Claude Code is not logged in. ${fixInstruction(state.auth, loginCommand)}` }
  }
  return undefined
}

function fixInstruction(auth: ClaudeAuthStatus, loginCommand: string): string {
  // The CLI's own words for a gateway session: it signs in from inside `claude`.
  if (auth.apiProvider === "gateway") return "Start `claude` and sign in with /login."
  return `Run \`${loginCommand}\` in a terminal.`
}

/** The one-line answer the operator sees after connecting. */
export function loginSummary(
  state: ClaudeLoginState,
  name: string,
  loginCommand: string,
): { level: "success" | "warn"; message: string } {
  switch (state.status) {
    case "logged-in":
      return { level: "success", message: `${name}: logged in with ${describeLoginMethod(state.auth)}.` }
    case "logged-out":
      return {
        level: "warn",
        message: `${name}: not logged in. ${fixInstruction(state.auth, loginCommand)} Then connect again.`,
      }
    case "missing":
      return {
        level: "warn",
        message: `${name}: the Claude CLI is not installed. Install it from ${CLAUDE_CODE_SETUP_URL}, then run \`${loginCommand}\`.`,
      }
    case "failed":
      return {
        level: "warn",
        message: `${name}: could not check the login (${state.reason}). Run \`claude auth status\` in a terminal to see it.`,
      }
  }
}

export interface AuthStatusRun {
  code: number | null
  stdout: string
  /** Set when the process could not be started at all. */
  spawnError?: NodeJS.ErrnoException
  timedOut?: boolean
}

export interface CheckClaudeLoginOptions {
  /** The binary or account wrapper a turn would spawn. */
  cliPath: string
  /** `CLAUDE_CONFIG_DIR`, only where the plugin applies an account itself (Windows, h #g221). */
  configDir?: string
  /** The provider option, so the check sees the key a turn would see. */
  ignoreAnthropicApiKey?: boolean
  timeoutMs?: number
  /** Seams for tests; production probes the version and spawns the CLI. */
  versionImpl?: (cliPath: string) => Promise<CliVersion | null>
  runImpl?: (
    cliPath: string,
    args: string[],
    env: Record<string, string | undefined>,
    timeoutMs: number,
  ) => Promise<AuthStatusRun>
}

export const AUTH_STATUS_TIMEOUT_MS = 10_000

function runAuthStatus(
  cliPath: string,
  args: string[],
  env: Record<string, string | undefined>,
  timeoutMs: number,
): Promise<AuthStatusRun> {
  return new Promise((resolve) => {
    const plan = planClaudeSpawn(cliPath, args)
    let stdout = ""
    let settled = false
    const finish = (run: AuthStatusRun) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(run)
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(plan.file, plan.args, {
        env,
        // Nothing to read: a closed stdin can never hold the command open.
        stdio: ["ignore", "pipe", "ignore"],
        windowsVerbatimArguments: plan.windowsVerbatimArguments,
      })
    } catch (err) {
      resolve({ code: null, stdout: "", spawnError: err as NodeJS.ErrnoException })
      return
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      finish({ code: null, stdout, timedOut: true })
    }, timeoutMs)
    timer.unref?.()
    child.stdout?.setEncoding("utf8")
    child.stdout?.on("data", (chunk: string) => {
      if (stdout.length < 64 * 1024) stdout += chunk
    })
    child.on("error", (err) => finish({ code: null, stdout, spawnError: err as NodeJS.ErrnoException }))
    child.on("close", (code) => finish({ code, stdout }))
  })
}

/**
 * Run `claude auth status` the way a turn would run `claude`: the same binary
 * or account wrapper and the same environment. Never throws.
 */
export async function checkClaudeLogin(options: CheckClaudeLoginOptions): Promise<ClaudeLoginState> {
  const timeoutMs = options.timeoutMs ?? AUTH_STATUS_TIMEOUT_MS
  const env = claudeSpawnEnv({
    ignoreAnthropicApiKey: options.ignoreAnthropicApiKey,
    configDir: options.configDir,
  })
  try {
    const run = options.runImpl ?? runAuthStatus
    const version = await (options.versionImpl ?? detectCliVersion)(options.cliPath)
    if (!version) {
      // Asking the version spawns the same binary, so an unanswered probe on a
      // binary that is not there is the missing case; anything else is unknown.
      const probe = await run(options.cliPath, ["--version"], env, timeoutMs)
      if (probe.spawnError?.code === "ENOENT") return { status: "missing" }
      return { status: "failed", reason: "the Claude CLI did not report a version" }
    }
    if (!cliSupportsAuthStatus(version)) {
      const shown = `${version.major}.${version.minor}.${version.patch}`
      return { status: "failed", reason: `Claude Code ${shown} is older than 2.1.288, which the check needs` }
    }
    const result = await run(options.cliPath, ["auth", "status"], env, timeoutMs)
    if (result.spawnError) {
      if (result.spawnError.code === "ENOENT") return { status: "missing" }
      return { status: "failed", reason: result.spawnError.code ?? "the CLI could not be started" }
    }
    if (result.timedOut) return { status: "failed", reason: `no answer within ${Math.round(timeoutMs / 1000)} s` }
    const auth = parseClaudeAuthStatus(result.stdout)
    if (!auth) return { status: "failed", reason: `unexpected output, exit code ${result.code ?? "none"}` }
    return auth.loggedIn ? { status: "logged-in", auth } : { status: "logged-out", auth }
  } catch (err) {
    return { status: "failed", reason: err instanceof Error ? err.message : String(err) }
  }
}
