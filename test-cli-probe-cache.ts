import assert from "node:assert/strict"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { _clearCache, detectCliSupportsFlag, detectCliVersion } from "./src/cli-version.js"

// These specs spawn real children, because the behaviour under test is what
// the two probes do when their own five-second deadline kills one. Nothing
// here asserts that a particular spawn beat that deadline: a killed probe is
// simply asked again, and "was this answer cached" is read off promise
// identity, which no amount of machine load can change.

/** Ask until the fixture answered for itself rather than being killed. */
async function untilAnswered<T>(probe: () => Promise<T>, answered: (value: T) => boolean): Promise<T> {
  for (let attempt = 1; attempt <= 6; attempt++) {
    const value = await probe()
    if (answered(value)) return value
  }
  throw new Error("the fixture never answered inside the probe deadline")
}

/**
 * A `/bin/sh` CLI that answers `--version` and `--help` and stalls past the
 * deadline while its `slow` marker exists. Shell rather than node so the
 * fixture's own startup is never the slow part.
 */
function fakeCli() {
  const dir = mkdtempSync(join(tmpdir(), "cli-probe-cache-"))
  const cliPath = join(dir, "fake-claude")
  const slow = join(dir, "slow")
  writeFileSync(slow, "")
  writeFileSync(
    cliPath,
    `#!/bin/sh\n[ -f ${JSON.stringify(slow)} ] && sleep 10\n` +
      `case "$1" in --help) echo "--plugin-dir <path>" ;; *) echo "2.1.280" ;; esac\n`,
  )
  chmodSync(cliPath, 0o755)
  return { dir, cliPath, beFast: () => rmSync(slow, { force: true }) }
}

test("a probe our own deadline killed is forgotten, so the next caller re-probes", {
  timeout: 120_000,
}, async () => {
  _clearCache()
  const cli = fakeCli()
  try {
    // Both probes stall past the deadline, concurrently, so the file pays for
    // that deadline once rather than twice.
    assert.deepEqual(
      await Promise.all([
        detectCliVersion(cli.cliPath),
        detectCliSupportsFlag(cli.cliPath, "--plugin-dir"),
      ]),
      [null, false],
      "a killed probe still answers conservatively",
    )

    // Nothing about the binary changed, only how long it took, so neither
    // answer may outlive the moment that produced it. Before this, one busy
    // turn withheld every version-gated flag and the skill bridge from the
    // rest of the opencode process.
    cli.beFast()
    const version = await untilAnswered(
      () => detectCliVersion(cli.cliPath),
      (detected) => detected !== null,
    )
    assert.equal(version?.raw, "2.1.280")
    assert.equal(
      await untilAnswered(() => detectCliSupportsFlag(cli.cliPath, "--plugin-dir"), (ok) => ok),
      true,
    )

    // The answers that do describe the binary are kept: the same promise comes
    // back, which is what "one spawn per cliPath" means from the caller's side.
    const cachedVersion = detectCliVersion(cli.cliPath)
    assert.equal(await cachedVersion, version)
    assert.equal(detectCliVersion(cli.cliPath), cachedVersion)
    const cachedFlag = detectCliSupportsFlag(cli.cliPath, "--plugin-dir")
    assert.equal(detectCliSupportsFlag(cli.cliPath, "--plugin-dir"), cachedFlag)
  } finally {
    _clearCache()
    rmSync(cli.dir, { recursive: true, force: true })
  }
})

test("a failure that describes the binary is cached, so it costs one probe", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cli-probe-cache-refuses-"))
  const refuses = join(dir, "fake-claude")
  writeFileSync(refuses, "#!/bin/sh\nexit 3\n")
  chmodSync(refuses, 0o755)
  try {
    _clearCache()
    // A binary that is not there never will be, and node answers ENOENT
    // without spawning anything, so this case cannot race the deadline however
    // loaded the machine is.
    const missing = "/nonexistent/claude-probe-cache"
    const version = detectCliVersion(missing)
    assert.equal(await version, null)
    assert.equal(detectCliVersion(missing), version, "a missing binary will be missing next turn too")
    const flag = detectCliSupportsFlag(missing, "--plugin-dir")
    assert.equal(await flag, false)
    assert.equal(detectCliSupportsFlag(missing, "--plugin-dir"), flag)

    // A binary that runs and refuses is just as permanent an answer. Asked
    // again when it is not, because under heavy load even this spawn can be
    // killed by the deadline, which is the case the test above owns.
    const kept = await untilAnswered(async () => {
      _clearCache()
      const probe = detectCliVersion(refuses)
      await probe
      return detectCliVersion(refuses) === probe
    }, (cached) => cached)
    assert.equal(kept, true, "a binary that exits non-zero will exit non-zero again")
  } finally {
    _clearCache()
    rmSync(dir, { recursive: true, force: true })
  }
})
