// The plan tier shown beside an account in opencode's provider list.
//
// Two things are being guarded here. One is the derivation: the labels must be
// the CLI's own (`organizationType` plus `organizationRateLimitTier`, h #g221),
// and an organization type this plugin has never seen must produce no label
// rather than leak an internal enum into the picker. The other is the privacy
// boundary: `oauthAccount` sits next to the account's email, its uuids and its
// organization name, and a provider display name is rendered on screen and
// written into logs and diagnostic bundles, so none of those may ever reach it.

import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { test } from "node:test"

import { accountDisplayName } from "../src/accounts.js"
import {
  _resetAccountTierCache,
  accountTierConfigDir,
  readAccountTier,
  tierLabel,
} from "../src/account-tier.js"

/** Everything an `oauthAccount` block carries that must never be displayed. */
const SECRETS = {
  accountUuid: "11111111-2222-3333-4444-555555555555",
  emailAddress: "someone@example.com",
  organizationUuid: "66666666-7777-8888-9999-000000000000",
  organizationName: "Some Private Organization BV",
  displayName: "Some Person",
  fullName: "Some Full Person",
}

function writeConfig(dir: string, oauthAccount: unknown): void {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, ".claude.json"),
    JSON.stringify({ numStartups: 3, oauthAccount }),
    "utf8",
  )
}

async function withHome(fn: (home: string) => Promise<void> | void): Promise<void> {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "acct-tier-"))
  const home = path.join(root, "ho me")
  fs.mkdirSync(home, { recursive: true })
  const saved = {
    home: process.env.HOME,
    profile: process.env.USERPROFILE,
    configDir: process.env.CLAUDE_CONFIG_DIR,
  }
  try {
    process.env.HOME = home
    process.env.USERPROFILE = home
    delete process.env.CLAUDE_CONFIG_DIR
    _resetAccountTierCache()
    await fn(home)
  } finally {
    restore("HOME", saved.home)
    restore("USERPROFILE", saved.profile)
    restore("CLAUDE_CONFIG_DIR", saved.configDir)
    _resetAccountTierCache()
    fs.rmSync(root, { recursive: true, force: true })
  }
}

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

// ---------------------------------------------------------------------------
// The label, derived the way the CLI derives it
// ---------------------------------------------------------------------------

test("the label follows the CLI's own organization type and rate-limit tier", () => {
  assert.equal(
    tierLabel({
      organizationType: "claude_max",
      organizationRateLimitTier: "default_claude_max_5x",
    }),
    "Max 5x",
  )
  assert.equal(
    tierLabel({
      organizationType: "claude_max",
      organizationRateLimitTier: "default_claude_max_20x",
    }),
    "Max 20x",
  )
  // A Max account whose rate-limit tier is something else is still Max; only
  // the multiple is unknown.
  assert.equal(tierLabel({ organizationType: "claude_max" }), "Max")
  assert.equal(
    tierLabel({ organizationType: "claude_max", organizationRateLimitTier: "later_tier" }),
    "Max",
  )
  assert.equal(tierLabel({ organizationType: "claude_pro" }), "Pro")
  assert.equal(tierLabel({ organizationType: "claude_team" }), "Team")
  assert.equal(tierLabel({ organizationType: "claude_enterprise" }), "Enterprise")
  // The 5x/20x split belongs to Max; a Pro account is never "Pro 5x".
  assert.equal(
    tierLabel({
      organizationType: "claude_pro",
      organizationRateLimitTier: "default_claude_max_5x",
    }),
    "Pro",
  )
})

test("an unrecognised or absent organization type produces no label", () => {
  assert.equal(tierLabel({}), undefined)
  assert.equal(tierLabel({ organizationType: "claude_something_new" }), undefined)
  assert.equal(tierLabel({ organizationType: 7 }), undefined)
  assert.equal(tierLabel({ organizationType: null }), undefined)
  // `billingType` is not a plan tier and must not be mistaken for one.
  assert.equal(tierLabel({ billingType: "stripe_subscription" }), undefined)
})

// ---------------------------------------------------------------------------
// Reading it off disk
// ---------------------------------------------------------------------------

test("a configured account is read from its own config dir", async () => {
  await withHome(async (home) => {
    writeConfig(path.join(home, ".claude-work"), {
      ...SECRETS,
      organizationType: "claude_max",
      organizationRateLimitTier: "default_claude_max_20x",
    })
    assert.equal(readAccountTier("Work"), "Max 20x")
    assert.equal(accountDisplayName("work", readAccountTier("work")), "Claude Code (Work, Max 20x)")
  })
})

test("the default account reads ~/.claude, honouring CLAUDE_CONFIG_DIR", async () => {
  await withHome(async (home) => {
    writeConfig(path.join(home, ".claude"), { organizationType: "claude_pro" })
    assert.equal(accountTierConfigDir("default"), path.join(home, ".claude"))
    assert.equal(readAccountTier("default"), "Pro")

    _resetAccountTierCache()
    const elsewhere = path.join(home, "else where")
    writeConfig(elsewhere, { organizationType: "claude_team" })
    process.env.CLAUDE_CONFIG_DIR = elsewhere
    assert.equal(readAccountTier("default"), "Team")
  })
})

test("the default account falls back to the legacy ~/.claude.json", async () => {
  await withHome(async (home) => {
    // An install that predates the config dir has only the home-level file.
    fs.writeFileSync(
      path.join(home, ".claude.json"),
      JSON.stringify({ oauthAccount: { organizationType: "claude_max" } }),
      "utf8",
    )
    assert.equal(readAccountTier("default"), "Max")

    // A configured account never takes that fallback: the home file describes
    // the default login, not this plugin's `~/.claude-<name>` directory.
    _resetAccountTierCache()
    fs.mkdirSync(path.join(home, ".claude-work"), { recursive: true })
    assert.equal(readAccountTier("work"), undefined)
  })
})

test("a missing, unreadable or malformed config is simply no label", async () => {
  await withHome(async (home) => {
    // Nothing on disk at all.
    assert.equal(readAccountTier("work"), undefined)

    _resetAccountTierCache()
    const dir = path.join(home, ".claude-work")
    fs.mkdirSync(dir, { recursive: true })
    // Caught mid-write.
    fs.writeFileSync(path.join(dir, ".claude.json"), '{"oauthAccount":{"organ', "utf8")
    assert.equal(readAccountTier("work"), undefined)

    _resetAccountTierCache()
    fs.writeFileSync(path.join(dir, ".claude.json"), "[]", "utf8")
    assert.equal(readAccountTier("work"), undefined)

    _resetAccountTierCache()
    fs.writeFileSync(path.join(dir, ".claude.json"), '{"oauthAccount":"nope"}', "utf8")
    assert.equal(readAccountTier("work"), undefined)

    // No label means the display name is exactly what it always was.
    assert.equal(accountDisplayName("work", readAccountTier("work")), "Claude Code (Work)")
  })
})

test("nothing but the tier leaves the config file", async () => {
  await withHome(async (home) => {
    writeConfig(path.join(home, ".claude-work"), {
      ...SECRETS,
      organizationType: "claude_max",
      organizationRateLimitTier: "default_claude_max_5x",
      billingType: "stripe_subscription",
      // A field shaped like a credential, in the block this module opens.
      accessToken: "sk-ant-oat01-not-a-real-token",
    })

    const name = accountDisplayName("work", readAccountTier("work"))
    assert.equal(name, "Claude Code (Work, Max 5x)")
    for (const secret of [...Object.values(SECRETS), "sk-ant-oat01-not-a-real-token"]) {
      assert.equal(name.includes(secret), false, `display name leaked ${secret}`)
    }
  })
})

test("one parse per config dir per process", async () => {
  await withHome(async (home) => {
    const dir = path.join(home, ".claude-work")
    writeConfig(dir, { organizationType: "claude_pro" })
    assert.equal(readAccountTier("work"), "Pro")

    // Rewritten on disk, but the answer is held: provider expansion runs this
    // repeatedly and a plan tier does not change inside one opencode process.
    writeConfig(dir, { organizationType: "claude_max" })
    assert.equal(readAccountTier("work"), "Pro")

    _resetAccountTierCache()
    assert.equal(readAccountTier("work"), "Max")
  })
})
